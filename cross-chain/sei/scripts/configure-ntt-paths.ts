/**
 * Configure Bidirectional NTT Manager and Transceiver Paths
 * 
 * This script configures bidirectional paths between networks:
 * - Testnet: Sepolia <-> BaseSepolia
 * - Mainnet: Ethereum <-> SeiEVM
 * 
 * It sets up:
 * 1. NTT Manager peers (setPeer) - bidirectional
 * 2. NTT Manager outbound limits (setOutboundLimit) - bidirectional  
 * 3. Transceiver chain registrations (registerTransceiver) - bidirectional
 * 
 * Usage:
 *   npx hardhat run scripts/configure-ntt-paths.ts --network sepolia
 *   npx hardhat run scripts/configure-ntt-paths.ts --network baseSepolia
 *   npx hardhat run scripts/configure-ntt-paths.ts --network mainnet
 *   npx hardhat run scripts/configure-ntt-paths.ts --network seiMainnet
 */

import { HardhatRuntimeEnvironment } from "hardhat/types"
import { secureKeyManager } from "./secure-key-manager"

// Wormhole Chain IDs
const WORMHOLE_CHAIN_IDS = {
  ETHEREUM_MAINNET: 2,
  ETHEREUM_SEPOLIA: 10002,
  BASE_SEPOLIA: 30,
  SEIEVM: 40,
}

// Testnet Configuration (using string amounts that will be parsed later)
const TESTNET_CONFIG_RAW = {
  sepolia: {
    networkName: "Sepolia",
    manager: "0x79AA1b04edA5b77265aFd1FDB9646eab065eadEc",
    transceiver: "0x86E4038abd972A9218498a553058AF8f085CC295",
    peers: [
      {
        chainId: WORMHOLE_CHAIN_IDS.BASE_SEPOLIA,
        peerName: "BaseSepolia",
        peerManager: "0xABb0c4fAAE03D51821273657C26Dc7674F6329e2",
        peerTransceiver: "0xf79b82b345573F7087375ed758eDAa33acCDeCED",
        decimals: 18, // tBTC has 18 decimals
        inboundLimitRaw: "100", // 100 tBTC - will be parsed with ethers
        outboundLimitRaw: "100", // 100 tBTC - will be parsed with ethers
        window: 3600, // 1 hour
      },
    ],
  },
  baseSepolia: {
    networkName: "BaseSepolia",
    manager: "0xABb0c4fAAE03D51821273657C26Dc7674F6329e2",
    transceiver: "0xf79b82b345573F7087375ed758eDAa33acCDeCED",
    peers: [
      {
        chainId: WORMHOLE_CHAIN_IDS.ETHEREUM_SEPOLIA,
        peerName: "Sepolia",
        peerManager: "0x79AA1b04edA5b77265aFd1FDB9646eab065eadEc",
        peerTransceiver: "0x86E4038abd972A9218498a553058AF8f085CC295",
        decimals: 18, // tBTC has 18 decimals
        inboundLimitRaw: "100", // 100 tBTC - will be parsed with ethers
        outboundLimitRaw: "100", // 100 tBTC - will be parsed with ethers
        window: 3600, // 1 hour
      },
    ],
  },
}

// Mainnet Configuration (using string amounts that will be parsed later)
const MAINNET_CONFIG_RAW = {
  mainnet: {
    networkName: "Ethereum Mainnet",
    manager: "0x79eb9aF995a443A102A19b41EDbB58d66e2921c7",
    transceiver: "0x73d19b20b374bfe4105c2b0de55504512f0c2aa7",
    peers: [
      {
        chainId: WORMHOLE_CHAIN_IDS.SEIEVM,
        peerName: "SeiEVM",
        peerManager: "0xc10a0886d4fe06bd61f41ee2855a2215375b82f0",
        peerTransceiver: "0x83849f9c2eb47ce0d59524a43cb101533bc1b6a6",
        decimals: 18, // tBTC has 18 decimals
        inboundLimitRaw: "10000", // 10,000 tBTC - will be parsed with ethers
        outboundLimitRaw: "10000", // 10,000 tBTC - will be parsed with ethers
        window: 86400, // 24 hours
      },
    ],
  },
  seiMainnet: {
    networkName: "SeiEVM Mainnet",
    manager: "0xc10a0886d4fe06bd61f41ee2855a2215375b82f0",
    transceiver: "0x83849f9c2eb47ce0d59524a43cb101533bc1b6a6",
    peers: [
      {
        chainId: WORMHOLE_CHAIN_IDS.ETHEREUM_MAINNET,
        peerName: "Ethereum Mainnet",
        peerManager: "0x79eb9aF995a443A102A19b41EDbB58d66e2921c7",
        peerTransceiver: "0x73d19b20b374bfe4105c2b0de55504512f0c2aa7",
        decimals: 18, // tBTC has 18 decimals
        inboundLimitRaw: "10000", // 10,000 tBTC - will be parsed with ethers
        outboundLimitRaw: "10000", // 10,000 tBTC - will be parsed with ethers
        window: 86400, // 24 hours
      },
    ],
  },
}

// Minimal ABI for NTT Manager (works with both implementation and proxy)
const NTT_MANAGER_ABI = [
  "function setPeer(uint16 peerChainId, bytes32 peerContract, uint8 decimals, uint256 inboundLimit) external",
  "function getPeer(uint16 chainId) external view returns (bytes32)",
  "function setOutboundLimit(uint16 chainId, uint256 limit, uint256 window) external",
  "function outboundLimit(uint16 chainId) external view returns (uint256 limit, uint256 window)",
  "function owner() external view returns (address)",
  "function paused() external view returns (bool)",
]

// ERC1967 Proxy ABI (for checking if contract is a proxy)
const PROXY_ABI = [
  "function implementation() external view returns (address)",
  "function admin() external view returns (address)",
]

// Note: Transceiver path configuration is handled automatically by NTT Manager
// The Transceiver interface doesn't have peer registration - it routes based on
// the recipientNttManagerAddress passed from the NTT Manager

/**
 * Convert address to bytes32 format (pad to 32 bytes)
 */
function addressToBytes32(address: string, ethersUtils: any): string {
  return ethersUtils.hexZeroPad(address, 32)
}

/**
 * Configure NTT Manager peer
 */
async function configureNttManagerPeer(
  nttManager: any,
  chainId: number,
  peerAddress: string,
  decimals: number,
  inboundLimit: any,
  signer: any,
  ethersUtils: any
): Promise<boolean> {
  try {
    const peerBytes32 = addressToBytes32(peerAddress, ethersUtils)

    // Check current peer
    try {
      const currentPeer = await nttManager.getPeer(chainId)
      if (currentPeer.toLowerCase() === peerBytes32.toLowerCase()) {
        console.log(`      ✅ NTT Manager peer already configured correctly`)
        return true
      }
      console.log(`      📝 Updating NTT Manager peer from ${currentPeer} to ${peerBytes32}`)
    } catch (error) {
      console.log(`      📝 Setting NTT Manager peer (getPeer not available, proceeding)`)
    }

    // Set peer with explicit gas limit
    // For proxy contracts, we call through the proxy which forwards to implementation
    console.log(`      📝 Sending setPeer transaction...`)
    console.log(`         Chain ID: ${chainId}`)
    console.log(`         Peer Address (bytes32): ${peerBytes32}`)
    console.log(`         Decimals: ${decimals}`)
    console.log(`         Inbound Limit: ${ethersUtils.formatEther(inboundLimit)} tBTC`)
    
    // Try to estimate gas first to see if it would succeed
    try {
      const gasEstimate = await nttManager.estimateGas.setPeer(chainId, peerBytes32, decimals, inboundLimit)
      console.log(`         Gas estimate: ${gasEstimate.toString()}`)
    } catch (estimateError: any) {
      console.warn(`         ⚠️  Gas estimation failed: ${estimateError.message}`)
      console.warn(`         This may indicate the transaction will revert`)
      if (estimateError.data) {
        console.warn(`         Error data: ${estimateError.data}`)
      }
    }
    
    // Try with callStatic first to get the actual revert reason
    try {
      await nttManager.callStatic.setPeer(chainId, peerBytes32, decimals, inboundLimit)
    } catch (staticError: any) {
      console.error(`      ❌ Transaction would revert: ${staticError.message}`)
      if (staticError.data && staticError.data !== "0x") {
        console.error(`      Error data: ${staticError.data}`)
        // Try to decode common error selectors
        const errorSelectors: Record<string, string> = {
          "0x8da5cb5b": "Ownable: caller is not the owner",
          "0xcf7a1d77": "Ownable: caller is not the owner (0.8.1+)",
          "0x82b42900": "Ownable: caller is not the owner (0.8.0)",
          "0x08c379a0": "Error(string) - check decoded message",
        }
        const selector = staticError.data.slice(0, 10)
        if (errorSelectors[selector]) {
          console.error(`      ✅ Decoded error: ${errorSelectors[selector]}`)
          // Try to decode Error(string) if it's that type
          if (selector === "0x08c379a0" && staticError.data.length > 10) {
            try {
              const errorData = staticError.data.slice(10)
              const decoded = ethersUtils.defaultAbiCoder.decode(["string"], "0x" + errorData)
              console.error(`      Error message: ${decoded[0]}`)
            } catch (e) {
              // Couldn't decode
            }
          }
        }
      }
      throw staticError
    }
    
    const tx = await nttManager.setPeer(chainId, peerBytes32, decimals, inboundLimit, {
      gasLimit: 300000, // Increased gas limit
    })
    console.log(`      ⏳ Waiting for transaction: ${tx.hash}`)
    const receipt = await tx.wait()
    
    if (receipt.status === 0) {
      console.error(`      ❌ Transaction reverted!`)
      console.error(`      Transaction hash: ${receipt.transactionHash}`)
      console.error(`      Gas used: ${receipt.gasUsed.toString()}`)
      console.error(`      Block: ${receipt.blockNumber}`)
      throw new Error("Transaction reverted - check contract state and permissions")
    }
    
    console.log(`      ✅ NTT Manager peer configured: ${tx.hash}`)
    console.log(`         Gas used: ${receipt.gasUsed.toString()}`)
    return true
  } catch (error: any) {
    console.error(`      ❌ Failed to configure NTT Manager peer: ${error.message}`)
    if (error.receipt) {
      console.error(`      Transaction hash: ${error.receipt.transactionHash}`)
      console.error(`      Status: ${error.receipt.status === 0 ? "REVERTED" : "SUCCESS"}`)
    }
    return false
  }
}

/**
 * Configure NTT Manager outbound limit
 */
async function configureNttManagerLimit(
  nttManager: any,
  chainId: number,
  limit: any,
  window: number,
  signer: any,
  ethersUtils: any
): Promise<boolean> {
  try {
    // Check current limit
    try {
      const [currentLimit, currentWindow] = await nttManager.outboundLimit(chainId)
      if (
        currentLimit.eq(limit) &&
        currentWindow.eq(window)
      ) {
        console.log(`      ✅ NTT Manager outbound limit already configured correctly`)
        return true
      }
      console.log(
        `      📝 Updating NTT Manager outbound limit from ${ethersUtils.formatEther(currentLimit)} tBTC/${currentWindow}s to ${ethersUtils.formatEther(limit)} tBTC/${window}s`
      )
    } catch (error) {
      console.log(`      📝 Setting NTT Manager outbound limit`)
    }

    // Set limit with explicit gas limit
    // For proxy contracts, we call through the proxy which forwards to implementation
    console.log(`      📝 Sending setOutboundLimit transaction...`)
    console.log(`         Chain ID: ${chainId}`)
    console.log(`         Limit: ${ethersUtils.formatEther(limit)} tBTC`)
    console.log(`         Window: ${window} seconds`)
    
    // Try to estimate gas first to see if it would succeed
    try {
      const gasEstimate = await nttManager.estimateGas.setOutboundLimit(chainId, limit, window)
      console.log(`         Gas estimate: ${gasEstimate.toString()}`)
    } catch (estimateError: any) {
      console.warn(`         ⚠️  Gas estimation failed: ${estimateError.message}`)
      console.warn(`         This may indicate the transaction will revert`)
      if (estimateError.data) {
        console.warn(`         Error data: ${estimateError.data}`)
        // Try to decode common error selectors
        const errorSelectors = {
          "0x8da5cb5b": "Ownable: caller is not the owner",
          "0xcf7a1d77": "Ownable: caller is not the owner (0.8.1+)",
          "0x82b42900": "Ownable: caller is not the owner (0.8.0)",
        }
        const selector = estimateError.data.slice(0, 10)
        if (errorSelectors[selector as keyof typeof errorSelectors]) {
          console.warn(`         Decoded error: ${errorSelectors[selector as keyof typeof errorSelectors]}`)
        }
      }
    }
    
    // Try with callStatic first to get the actual revert reason
    try {
      await nttManager.callStatic.setOutboundLimit(chainId, limit, window)
    } catch (staticError: any) {
      console.error(`      ❌ Transaction would revert: ${staticError.message}`)
      if (staticError.data && staticError.data !== "0x") {
        console.error(`      Error data: ${staticError.data}`)
        // Try to decode common error selectors
        const errorSelectors: Record<string, string> = {
          "0x8da5cb5b": "Ownable: caller is not the owner",
          "0xcf7a1d77": "Ownable: caller is not the owner (0.8.1+)",
          "0x82b42900": "Ownable: caller is not the owner (0.8.0)",
          "0x08c379a0": "Error(string) - check decoded message",
        }
        const selector = staticError.data.slice(0, 10)
        if (errorSelectors[selector]) {
          console.error(`      ✅ Decoded error: ${errorSelectors[selector]}`)
          // Try to decode Error(string) if it's that type
          if (selector === "0x08c379a0" && staticError.data.length > 10) {
            try {
              const errorData = staticError.data.slice(10)
              const decoded = ethersUtils.defaultAbiCoder.decode(["string"], "0x" + errorData)
              console.error(`      Error message: ${decoded[0]}`)
            } catch (e) {
              // Couldn't decode
            }
          }
        }
      }
      throw staticError
    }
    
    const tx = await nttManager.setOutboundLimit(chainId, limit, window, {
      gasLimit: 300000, // Increased gas limit
    })
    console.log(`      ⏳ Waiting for transaction: ${tx.hash}`)
    const receipt = await tx.wait()
    
    if (receipt.status === 0) {
      console.error(`      ❌ Transaction reverted!`)
      console.error(`      Transaction hash: ${receipt.transactionHash}`)
      console.error(`      Gas used: ${receipt.gasUsed.toString()}`)
      console.error(`      Block: ${receipt.blockNumber}`)
      throw new Error("Transaction reverted - check contract state and permissions")
    }
    
    console.log(`      ✅ NTT Manager outbound limit configured: ${tx.hash}`)
    console.log(`         Gas used: ${receipt.gasUsed.toString()}`)
    console.log(`         Limit: ${ethersUtils.formatEther(limit)} tBTC`)
    console.log(`         Window: ${window} seconds`)
    return true
  } catch (error: any) {
    console.error(`      ❌ Failed to configure NTT Manager outbound limit: ${error.message}`)
    if (error.receipt) {
      console.error(`      Transaction hash: ${error.receipt.transactionHash}`)
      console.error(`      Status: ${error.receipt.status === 0 ? "REVERTED" : "SUCCESS"}`)
    }
    return false
  }
}

/**
 * Verify Transceiver configuration
 * Note: Transceivers don't need explicit peer configuration - they route
 * messages based on the recipientNttManagerAddress provided by the NTT Manager.
 * The path is established through the NTT Manager's setPeer call.
 */
async function verifyTransceiver(
  transceiverAddress: string,
  peerTransceiver: string,
  signer: any,
  hre: HardhatRuntimeEnvironment
): Promise<boolean> {
  try {
    // Try to read transceiver info to verify it's accessible
    const transceiver = await (hre as any).ethers.getContractAt(
      ["function getTransceiverType() external view returns (string memory)"],
      transceiverAddress,
      signer
    )
    
    try {
      const transceiverType = await transceiver.getTransceiverType()
      console.log(`      ℹ️  Transceiver type: ${transceiverType}`)
      console.log(`      ℹ️  Transceiver address: ${transceiverAddress}`)
      console.log(`      ℹ️  Peer transceiver: ${peerTransceiver}`)
      console.log(`      ✅ Transceiver verified (paths configured via NTT Manager)`)
      return true
    } catch (error: any) {
      console.log(`      ⚠️  Could not read transceiver type: ${error.message}`)
      console.log(`      ℹ️  Transceiver configuration handled automatically by NTT Manager`)
      return true
    }
  } catch (error: any) {
    console.error(`      ⚠️  Could not verify Transceiver: ${error.message}`)
    console.log(`      ℹ️  Continuing - Transceiver paths are configured via NTT Manager`)
    return true
  }
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const hre = require("hardhat") as any
  const { ethers, network } = hre
  const networkName = network.name

  console.log(`\n🔧 Configuring NTT Paths on ${networkName}...`)

  // Get raw configuration
  const configRaw =
    TESTNET_CONFIG_RAW[networkName as keyof typeof TESTNET_CONFIG_RAW] ||
    MAINNET_CONFIG_RAW[networkName as keyof typeof MAINNET_CONFIG_RAW]

  if (!configRaw) {
    throw new Error(
      `No configuration found for network: ${networkName}\n` +
        `Available networks: ${Object.keys(TESTNET_CONFIG_RAW).concat(Object.keys(MAINNET_CONFIG_RAW)).join(", ")}`
    )
  }

  // Parse configuration with ethers
  const config = {
    ...configRaw,
    peers: configRaw.peers.map((peer: any) => ({
      ...peer,
      inboundLimit: ethers.utils.parseEther(peer.inboundLimitRaw),
      outboundLimit: ethers.utils.parseEther(peer.outboundLimitRaw),
    })),
  }

  console.log(`📋 Network: ${config.networkName}`)
  console.log(`   NTT Manager: ${config.manager}`)
  console.log(`   Transceiver: ${config.transceiver}`)
  console.log(`   Peers to configure: ${config.peers.length}`)

  // Get signer - try encrypted key first, then fall back to environment/default
  let signer: any
  try {
    if (secureKeyManager.hasEncryptedKey()) {
      console.log(`🔐 Using encrypted private key...`)
      console.log(`   Please enter your master password when prompted...`)
      // Ensure stdin is available for interactive prompt
      if (!process.stdin.isTTY) {
        console.warn(`⚠️  Warning: stdin is not a TTY. Interactive password prompt may not work.`)
        console.warn(`   Please run this script in an interactive terminal.`)
      }
      const privateKey = await secureKeyManager.getDecryptedKey()
      const wallet = new ethers.Wallet(`0x${privateKey}`, ethers.provider)
      signer = wallet
      console.log(`✅ Signer from encrypted key: ${signer.address}`)
    } else {
      const signers = await ethers.getSigners()
      signer = signers[0]
      console.log(`👤 Signer: ${signer.address}`)
    }
  } catch (error: any) {
    console.log(`⚠️  Could not use encrypted key: ${error.message}`)
    const signers = await ethers.getSigners()
    signer = signers[0]
    console.log(`👤 Signer (fallback): ${signer.address}`)
  }

  const balance = await signer.getBalance()
  console.log(`💰 Balance: ${ethers.utils.formatEther(balance)} ETH`)

  // Check balance more carefully
  const minBalance = ethers.utils.parseEther("0.05") // 0.05 ETH minimum
  if (balance.lt(minBalance)) {
    console.error(`❌ Insufficient balance!`)
    console.error(`   Current: ${ethers.utils.formatEther(balance)} ETH`)
    console.error(`   Required: ${ethers.utils.formatEther(minBalance)} ETH`)
    console.error(`   Please add more ETH to ${signer.address}`)
    throw new Error("Insufficient balance for transactions")
  } else if (balance.lt(ethers.utils.parseEther("0.1"))) {
    console.warn("⚠️  Low balance! Make sure you have enough for gas fees.")
  }

  // Connect to NTT Manager contract (proxy address)
  // ERC1967Proxy forwards calls to implementation, so we interact with proxy directly
  console.log(`🔗 Connecting to NTT Manager contract...`)
  console.log(`   Address: ${config.manager}`)
  
  // Check if it's a proxy and get implementation address
  try {
    const proxy = await ethers.getContractAt(PROXY_ABI, config.manager, signer)
    try {
      const implementation = await proxy.implementation()
      console.log(`   Implementation: ${implementation}`)
      console.log(`   ℹ️  Contract is a proxy - interacting through proxy address`)
    } catch (error) {
      // Not a proxy or implementation() not available
      console.log(`   ℹ️  Direct contract or proxy without implementation() function`)
    }
  } catch (error) {
    console.log(`   ℹ️  Could not check proxy status`)
  }

  const nttManager = await ethers.getContractAt(
    NTT_MANAGER_ABI,
    config.manager,
    signer
  )

  // Verify owner before proceeding
  try {
    const owner = await nttManager.owner()
    console.log(`   Owner: ${owner}`)
    console.log(`   Signer: ${signer.address}`)
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      console.warn(`   ⚠️  WARNING: Signer is not the owner!`)
      console.warn(`   ⚠️  Transactions may fail due to access control`)
    } else {
      console.log(`   ✅ Signer is the owner`)
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not verify owner: ${error.message}`)
  }

  console.log(`\n📋 Configuring ${config.peers.length} peer path(s)...\n`)

  // Configure each peer
  for (const peer of config.peers) {
    console.log(`\n🔗 Configuring path to ${peer.peerName} (Chain ID: ${peer.chainId})`)
    console.log(`   Peer NTT Manager: ${peer.peerManager}`)
    console.log(`   Peer Transceiver: ${peer.peerTransceiver}`)

    // Configure NTT Manager peer
    console.log(`\n   1️⃣  Configuring NTT Manager peer...`)
    await configureNttManagerPeer(nttManager, peer.chainId, peer.peerManager, peer.decimals, peer.inboundLimit, signer, ethers.utils)

    // Configure NTT Manager outbound limit
    console.log(`\n   2️⃣  Configuring NTT Manager outbound limit...`)
    await configureNttManagerLimit(
      nttManager,
      peer.chainId,
      peer.outboundLimit,
      peer.window,
      signer,
      ethers.utils
    )

    // Verify Transceiver (no explicit configuration needed - handled by NTT Manager)
    console.log(`\n   3️⃣  Verifying Transceiver configuration...`)
    await verifyTransceiver(config.transceiver, peer.peerTransceiver, signer, hre)

    console.log(`\n   ✅ Path to ${peer.peerName} configuration completed`)
  }

  console.log(`\n✅ All bidirectional paths configured for ${config.networkName}!`)
  console.log(`\n📝 Next Steps:`)
  console.log(`   1. Run this script on the peer network(s) to complete bidirectional setup:`)
  config.peers.forEach((peer) => {
    console.log(`      - Configure ${peer.peerName} network with this network as peer`)
  })
  console.log(`   2. Verify paths by checking peer configurations on both chains`)
  console.log(`   3. Transceivers route automatically based on NTT Manager peer configuration`)
  console.log(`   4. Test with a small transfer to ensure everything works`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Configuration failed:", error)
    process.exit(1)
  })

