/* eslint-disable no-console */
import { ethers } from "hardhat"
import { HardhatRuntimeEnvironment } from "hardhat/types"

/**
 * L1BTCDepositorNtt Configuration Script
 *
 * Configures L1BTCDepositorNtt contract for different networks
 * Sets supported chains, NTT Manager settings, and other parameters
 *
 * Usage:
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network baseSepolia
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network arbitrumSepolia
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network optimismSepolia
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network sepolia
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network base
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network arbitrumOne
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network optimism
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network mainnet
 *
 * Environment Variables:
 *   L1_BTC_DEPOSITOR_NTT_ADDRESS - Address of deployed L1BTCDepositorNtt contract
 *   NTT_MANAGER_ADDRESS - Address of NTT Manager contract (optional, will be read from contract)
 */

interface ChainConfig {
  chainId: number
  name: string
  enabled: boolean
  peerAddress?: string // Wormhole-formatted NTT Manager address on destination chain
  rateLimitAmount?: string // Amount in tBTC (18 decimals)
  rateLimitDuration?: number // Duration in seconds
}

interface NetworkConfiguration {
  networkName: string
  contractAddress?: string
  nttManagerAddress?: string
  supportedChains: ChainConfig[]
  defaultRateLimit: {
    amount: string // Default rate limit amount
    duration: number // Default duration (1 hour = 3600)
  }
}

const ZERO_PEER_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000000"

const RATE_LIMIT_DURATION = {
  hour: 3600,
  day: 86400,
}

const WORMHOLE_CHAIN_IDS = {
  ethereum: {
    mainnet: 2,
    sepolia: 10002,
  },
  solana: {
    mainnet: 1,
    devnet: 1,
  },
  sui: {
    mainnet: 21,
    testnet: 21,
  },
  arbitrum: {
    mainnet: 23,
    sepolia: 10003,
  },
  optimism: {
    mainnet: 24,
    sepolia: 10005,
  },
  base: {
    mainnet: 30,
    sepolia: 10004,
  },
} as const

function tbtcAmount(amount: string): string {
  return ethers.utils.parseEther(amount).toString()
}

function evmPeerAddress(address: string): string {
  return ethers.utils.hexZeroPad(address, 32)
}

function isConfiguredPeerAddress(peerAddress?: string): boolean {
  return (
    !!peerAddress &&
    peerAddress.toLowerCase() !== ZERO_PEER_ADDRESS.toLowerCase()
  )
}

function destinationChain(
  chainId: number,
  name: string,
  rateLimitAmount: string,
  rateLimitDuration: number,
  peerAddress = ZERO_PEER_ADDRESS
): ChainConfig {
  return {
    chainId,
    name,
    enabled: isConfiguredPeerAddress(peerAddress),
    peerAddress,
    rateLimitAmount: tbtcAmount(rateLimitAmount),
    rateLimitDuration,
  }
}

function hubChain(
  chainId: number,
  name: string,
  rateLimitAmount: string,
  rateLimitDuration: number,
  peerAddress = ZERO_PEER_ADDRESS
): ChainConfig {
  return destinationChain(
    chainId,
    name,
    rateLimitAmount,
    rateLimitDuration,
    peerAddress
  )
}

const NETWORK_CONFIGURATIONS: Record<string, NetworkConfiguration> = {
  // Base Sepolia - Spoke configuration
  baseSepolia: {
    networkName: "Base Sepolia",
    supportedChains: [
      hubChain(
        WORMHOLE_CHAIN_IDS.ethereum.sepolia,
        "Ethereum Sepolia",
        "500",
        RATE_LIMIT_DURATION.hour,
        evmPeerAddress("0x06413c42e913327Bc9a08B7C1E362BAE7C0b9598")
      ),
    ],
    defaultRateLimit: {
      amount: tbtcAmount("500"), // 500 tBTC default
      duration: RATE_LIMIT_DURATION.hour,
    },
  },

  // Arbitrum Sepolia - Spoke configuration
  arbitrumSepolia: {
    networkName: "Arbitrum Sepolia",
    supportedChains: [
      hubChain(
        WORMHOLE_CHAIN_IDS.ethereum.sepolia,
        "Ethereum Sepolia",
        "500",
        RATE_LIMIT_DURATION.hour
      ),
    ],
    defaultRateLimit: {
      amount: tbtcAmount("500"), // 500 tBTC default
      duration: RATE_LIMIT_DURATION.hour,
    },
  },

  // Optimism Sepolia - Spoke configuration
  optimismSepolia: {
    networkName: "Optimism Sepolia",
    supportedChains: [
      hubChain(
        WORMHOLE_CHAIN_IDS.ethereum.sepolia,
        "Ethereum Sepolia",
        "500",
        RATE_LIMIT_DURATION.hour
      ),
    ],
    defaultRateLimit: {
      amount: tbtcAmount("500"), // 500 tBTC default
      duration: RATE_LIMIT_DURATION.hour,
    },
  },

  // Ethereum Sepolia - Hub configuration
  sepolia: {
    networkName: "Ethereum Sepolia",
    supportedChains: [
      destinationChain(
        WORMHOLE_CHAIN_IDS.arbitrum.sepolia,
        "Arbitrum Sepolia",
        "1000",
        RATE_LIMIT_DURATION.hour
      ),
      destinationChain(
        WORMHOLE_CHAIN_IDS.base.sepolia,
        "Base Sepolia",
        "1000",
        RATE_LIMIT_DURATION.hour,
        evmPeerAddress("0x8b9E328bE1b1Bc7501B413d04EBF7479B110775c")
      ),
      destinationChain(
        WORMHOLE_CHAIN_IDS.optimism.sepolia,
        "Optimism Sepolia",
        "1000",
        RATE_LIMIT_DURATION.hour
      ),
      destinationChain(
        WORMHOLE_CHAIN_IDS.sui.testnet,
        "Sui Testnet",
        "1000",
        RATE_LIMIT_DURATION.hour
      ),
      destinationChain(
        WORMHOLE_CHAIN_IDS.solana.devnet,
        "Solana Devnet",
        "1000",
        RATE_LIMIT_DURATION.hour
      ),
    ],
    defaultRateLimit: {
      amount: tbtcAmount("2000"), // 2000 tBTC default
      duration: RATE_LIMIT_DURATION.hour,
    },
  },

  // Base Mainnet - Spoke configuration
  base: {
    networkName: "Base Mainnet",
    supportedChains: [
      hubChain(
        WORMHOLE_CHAIN_IDS.ethereum.mainnet,
        "Ethereum Mainnet",
        "5000",
        RATE_LIMIT_DURATION.day
      ),
    ],
    defaultRateLimit: {
      amount: tbtcAmount("5000"), // 5000 tBTC default
      duration: RATE_LIMIT_DURATION.day,
    },
  },

  // Arbitrum One - Spoke configuration
  arbitrumOne: {
    networkName: "Arbitrum One",
    supportedChains: [
      hubChain(
        WORMHOLE_CHAIN_IDS.ethereum.mainnet,
        "Ethereum Mainnet",
        "5000",
        RATE_LIMIT_DURATION.day
      ),
    ],
    defaultRateLimit: {
      amount: tbtcAmount("5000"), // 5000 tBTC default
      duration: RATE_LIMIT_DURATION.day,
    },
  },

  // Optimism Mainnet - Spoke configuration
  optimism: {
    networkName: "Optimism Mainnet",
    supportedChains: [
      hubChain(
        WORMHOLE_CHAIN_IDS.ethereum.mainnet,
        "Ethereum Mainnet",
        "5000",
        RATE_LIMIT_DURATION.day
      ),
    ],
    defaultRateLimit: {
      amount: tbtcAmount("5000"), // 5000 tBTC default
      duration: RATE_LIMIT_DURATION.day,
    },
  },

  // Ethereum Mainnet - Hub configuration
  mainnet: {
    networkName: "Ethereum Mainnet",
    supportedChains: [
      destinationChain(
        WORMHOLE_CHAIN_IDS.arbitrum.mainnet,
        "Arbitrum One",
        "100000",
        RATE_LIMIT_DURATION.day
      ),
      destinationChain(
        WORMHOLE_CHAIN_IDS.base.mainnet,
        "Base Mainnet",
        "100000",
        RATE_LIMIT_DURATION.day
      ),
      destinationChain(
        WORMHOLE_CHAIN_IDS.optimism.mainnet,
        "Optimism Mainnet",
        "100000",
        RATE_LIMIT_DURATION.day
      ),
      destinationChain(
        WORMHOLE_CHAIN_IDS.sui.mainnet,
        "Sui Mainnet",
        "100000",
        RATE_LIMIT_DURATION.day
      ),
      destinationChain(
        WORMHOLE_CHAIN_IDS.solana.mainnet,
        "Solana Mainnet",
        "100000",
        RATE_LIMIT_DURATION.day
      ),
    ],
    defaultRateLimit: {
      amount: tbtcAmount("25000"), // 25,000 tBTC default
      duration: RATE_LIMIT_DURATION.day,
    },
  },
}

async function main() {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const hre = require("hardhat") as HardhatRuntimeEnvironment
  const { network } = hre
  const networkName = network.name

  console.log(`\n🔧 Configuring L1BTCDepositorNtt on ${networkName}...`)

  // Get configuration for this network
  const config = NETWORK_CONFIGURATIONS[networkName]
  if (!config) {
    throw new Error(`No configuration found for network: ${networkName}`)
  }

  // Get contract address
  const contractAddress =
    process.env.L1_BTC_DEPOSITOR_NTT_ADDRESS || config.contractAddress

  if (!contractAddress) {
    throw new Error(
      "Contract address not provided. Set L1_BTC_DEPOSITOR_NTT_ADDRESS environment variable " +
        "or run deployment script first."
    )
  }

  console.log(`📄 Contract Address: ${contractAddress}`)

  // Get contract instance
  const [deployer] = await ethers.getSigners()
  const l1BtcDepositorNtt = await ethers.getContractAt(
    "L1BTCDepositorNtt",
    contractAddress,
    deployer
  )

  console.log(`👤 Deployer: ${deployer.address}`)
  console.log(
    `💰 Balance: ${ethers.utils.formatEther(await deployer.getBalance())} ETH`
  )

  // Configure supported chains
  console.log(`\n🌐 Configuring supported chains for ${config.networkName}...`)

  // Process chains sequentially to avoid nonce conflicts
  // eslint-disable-next-line no-restricted-syntax
  for (const chain of config.supportedChains) {
    try {
      console.log(
        `\n   🔗 Configuring chain: ${chain.name} (ID: ${chain.chainId})`
      )

      // Check if chain is already supported
      // eslint-disable-next-line no-await-in-loop
      const isCurrentlySupported = await l1BtcDepositorNtt.supportedChains(
        chain.chainId
      )

      if (isCurrentlySupported !== chain.enabled) {
        console.log(`   📝 Setting supported status: ${chain.enabled}`)
        // eslint-disable-next-line no-await-in-loop
        const tx = await l1BtcDepositorNtt.setSupportedChain(
          chain.chainId,
          chain.enabled
        )
        // eslint-disable-next-line no-await-in-loop
        await tx.wait()
        console.log(`   ✅ Transaction: ${tx.hash}`)
      } else {
        console.log("   ℹ️  Chain already configured correctly")
      }
    } catch (error) {
      console.error(
        `   ❌ Failed to configure ${chain.name}: ${(error as Error).message}`
      )
    }
  }

  // Get NTT Manager address
  let nttManagerAddress
  try {
    nttManagerAddress = await l1BtcDepositorNtt.nttManager()
    console.log(`\n🎯 NTT Manager: ${nttManagerAddress}`)
  } catch (error) {
    console.log(
      `\n⚠️  Could not read NTT Manager address: ${(error as Error).message}`
    )
  }

  // Display current configuration
  console.log("\n📊 Current Configuration Summary:")
  console.log(`   Network: ${config.networkName}`)
  console.log(`   Contract: ${contractAddress}`)
  console.log(`   NTT Manager: ${nttManagerAddress || "Not available"}`)

  console.log("\n   Supported Chains:")
  const enabledChainIds: number[] = []

  // eslint-disable-next-line no-restricted-syntax
  for (const chain of config.supportedChains) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const isSupported = await l1BtcDepositorNtt.supportedChains(chain.chainId)
      if (isSupported) {
        enabledChainIds.push(chain.chainId)
      }
      console.log(
        `   - ${chain.name} (${chain.chainId}): ${
          isSupported ? "✅ Enabled" : "❌ Disabled"
        }`
      )
    } catch (error) {
      console.log(`   - ${chain.name} (${chain.chainId}): ❓ Unknown`)
    }
  }

  // This used to call a `getSupportedChains()` that the contract does not have
  // -- `supportedChains` is a `mapping(uint16 => bool)`, which cannot be
  // enumerated on-chain -- so the call always threw and the catch below it
  // always printed a warning. The summary is built from the loop above
  // instead, which means it covers the configured chains rather than every
  // chain ever enabled.
  console.log(
    `\n   Enabled among configured chains: [${enabledChainIds.join(", ")}]`
  )

  // Instructions for NTT Manager configuration
  if (
    nttManagerAddress &&
    nttManagerAddress !== "0x0000000000000000000000000000000000000000"
  ) {
    console.log("\n📋 Next Steps for NTT Manager Configuration:")
    console.log(
      `\n   1. Configure peers on NTT Manager (${nttManagerAddress}):`
    )

    config.supportedChains.forEach((chain) => {
      if (chain.peerAddress && chain.peerAddress !== ZERO_PEER_ADDRESS) {
        console.log(
          `      await nttManager.setPeer(${chain.chainId}, "${chain.peerAddress}");`
        )
      } else {
        console.log(
          `      // TODO: Set peer for ${chain.name} (${chain.chainId}) when NTT Manager is deployed`
        )
      }
    })

    console.log("\n   2. Configure rate limits:")
    config.supportedChains.forEach((chain) => {
      if (chain.rateLimitAmount && chain.rateLimitDuration) {
        console.log(
          `      await nttManager.setOutboundLimit(${chain.chainId}, "${chain.rateLimitAmount}", ${chain.rateLimitDuration});`
        )
      }
    })
  }

  console.log(`\n✅ Configuration completed for ${config.networkName}!`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Configuration failed:", error)
    process.exit(1)
  })
