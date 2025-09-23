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
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network sepolia
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network seiTestnet
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
  peerAddress?: string // NTT Manager address on destination chain
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

const NETWORK_CONFIGURATIONS: Record<string, NetworkConfiguration> = {
  // Base Sepolia - Testing configuration
  baseSepolia: {
    networkName: "Base Sepolia",
    supportedChains: [
      {
        chainId: 32, // Sei
        name: "Sei",
        enabled: true,
        peerAddress: "0x0000000000000000000000000000000000000000", // TODO: Sei NTT Manager address
        rateLimitAmount: ethers.utils.parseEther("100").toString(), // 100 tBTC
        rateLimitDuration: 3600, // 1 hour
      },
      {
        chainId: 10002, // Ethereum Sepolia
        name: "Ethereum Sepolia",
        enabled: true,
        peerAddress: "0x06413c42e913327Bc9a08B7C1E362BAE7C0b9598", // Sepolia NTT Manager
        rateLimitAmount: ethers.utils.parseEther("1000").toString(), // 1000 tBTC
        rateLimitDuration: 3600, // 1 hour
      },
    ],
    defaultRateLimit: {
      amount: ethers.utils.parseEther("500").toString(), // 500 tBTC default
      duration: 3600, // 1 hour
    },
  },

  // Ethereum Sepolia - Hub configuration
  sepolia: {
    networkName: "Ethereum Sepolia",
    supportedChains: [
      {
        chainId: 10004, // Base Sepolia
        name: "Base Sepolia",
        enabled: true,
        peerAddress: "0x8b9E328bE1b1Bc7501B413d04EBF7479B110775c", // Base Sepolia NTT Manager
        rateLimitAmount: ethers.utils.parseEther("1000").toString(), // 1000 tBTC
        rateLimitDuration: 3600, // 1 hour
      },
      {
        chainId: 32, // Sei
        name: "Sei",
        enabled: true,
        peerAddress: "0x0000000000000000000000000000000000000000", // TODO: Sei NTT Manager address
        rateLimitAmount: ethers.utils.parseEther("500").toString(), // 500 tBTC
        rateLimitDuration: 3600, // 1 hour
      },
    ],
    defaultRateLimit: {
      amount: ethers.utils.parseEther("2000").toString(), // 2000 tBTC default
      duration: 3600, // 1 hour
    },
  },

  // Sei Testnet - Spoke configuration
  seiTestnet: {
    networkName: "Sei Testnet",
    supportedChains: [
      {
        chainId: 10002, // Ethereum Sepolia (Hub)
        name: "Ethereum Sepolia",
        enabled: true,
        peerAddress: "0x06413c42e913327Bc9a08B7C1E362BAE7C0b9598", // Sepolia NTT Manager
        rateLimitAmount: ethers.utils.parseEther("1000").toString(), // 1000 tBTC
        rateLimitDuration: 3600, // 1 hour
      },
    ],
    defaultRateLimit: {
      amount: ethers.utils.parseEther("500").toString(), // 500 tBTC default
      duration: 3600, // 1 hour
    },
  },

  // Sei Mainnet - Spoke configuration
  seiMainnet: {
    networkName: "Sei Mainnet",
    supportedChains: [
      {
        chainId: 2, // Ethereum Mainnet (Hub)
        name: "Ethereum Mainnet",
        enabled: true,
        peerAddress: "0x0000000000000000000000000000000000000000", // TODO: Ethereum Mainnet NTT Manager
        rateLimitAmount: ethers.utils.parseEther("10000").toString(), // 10,000 tBTC
        rateLimitDuration: 86400, // 24 hours
      },
    ],
    defaultRateLimit: {
      amount: ethers.utils.parseEther("5000").toString(), // 5000 tBTC default
      duration: 86400, // 24 hours
    },
  },

  // Ethereum Mainnet - Hub configuration
  mainnet: {
    networkName: "Ethereum Mainnet",
    supportedChains: [
      {
        chainId: 32, // Sei Mainnet
        name: "Sei Mainnet",
        enabled: true,
        peerAddress: "0x0000000000000000000000000000000000000000", // TODO: Sei Mainnet NTT Manager
        rateLimitAmount: ethers.utils.parseEther("50000").toString(), // 50,000 tBTC
        rateLimitDuration: 86400, // 24 hours
      },
      {
        chainId: 8453, // Base Mainnet
        name: "Base Mainnet",
        enabled: true,
        peerAddress: "0x0000000000000000000000000000000000000000", // TODO: Base Mainnet NTT Manager
        rateLimitAmount: ethers.utils.parseEther("100000").toString(), // 100,000 tBTC
        rateLimitDuration: 86400, // 24 hours
      },
    ],
    defaultRateLimit: {
      amount: ethers.utils.parseEther("25000").toString(), // 25,000 tBTC default
      duration: 86400, // 24 hours
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
  // eslint-disable-next-line no-restricted-syntax
  for (const chain of config.supportedChains) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const isSupported = await l1BtcDepositorNtt.supportedChains(chain.chainId)
      console.log(
        `   - ${chain.name} (${chain.chainId}): ${
          isSupported ? "✅ Enabled" : "❌ Disabled"
        }`
      )
    } catch (error) {
      console.log(`   - ${chain.name} (${chain.chainId}): ❓ Unknown`)
    }
  }

  // Get list of all supported chains
  try {
    const supportedChainsList = await l1BtcDepositorNtt.getSupportedChains()
    console.log(
      `\n   All Supported Chain IDs: [${supportedChainsList.join(", ")}]`
    )
  } catch (error) {
    console.log(
      `\n   ⚠️  Could not retrieve supported chains list: ${error.message}`
    )
  }

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
      if (
        chain.peerAddress &&
        chain.peerAddress !== "0x0000000000000000000000000000000000000000"
      ) {
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
