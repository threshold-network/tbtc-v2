/**
 * L1BTCDepositorNttWithExecutor Deployment Functions
 * Supports deployment to Sepolia and Mainnet with encrypted key management
 */

import { ethers } from "hardhat"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import { secureKeyManager } from "./secure-key-manager"

// 🎲 DEPLOYMENT SALT - Fixed salt for consistent CREATE2 deployments
const DEPLOYMENT_SALT = "v1.0.0-l1btc-depositor-ntt-executor"

export interface L1BTCDepositorNetworkConfig {
  networkName: string
  explorer: string
  rpcUrl: string
  tbtcBridge: string
  tbtcVault: string
  nttManagerWithExecutor: string
  underlyingNttManager: string
  // Sei-specific chain configuration
  seiChainId: number // Wormhole chain ID for Sei
  baseSepolia?: {
    chainId: number // Wormhole chain ID for Base Sepolia (for testing)
  }
}

export interface L1BTCDepositorDeploymentResult {
  proxy: string
  implementation: string
  admin: string
  owner: string
  network: string
  transactionHash: string
  tbtcBridge: string
  tbtcVault: string
  nttManagerWithExecutor: string
  underlyingNttManager: string
}

/**
 * Deploy L1BTCDepositorNttWithExecutor with TransparentUpgradeableProxy
 */
export async function deployL1BTCDepositorNttWithExecutor(
  hre: HardhatRuntimeEnvironment,
  networkConfig: L1BTCDepositorNetworkConfig
): Promise<L1BTCDepositorDeploymentResult> {
  const { ethers, upgrades } = hre

  console.log(
    `🚀 Deploying L1BTCDepositorNttWithExecutor on ${networkConfig.networkName}...`
  )
  console.log(`   tBTC Bridge: ${networkConfig.tbtcBridge}`)
  console.log(`   tBTC Vault: ${networkConfig.tbtcVault}`)
  console.log(
    `   NTT Manager With Executor: ${networkConfig.nttManagerWithExecutor}`
  )
  console.log(
    `   Underlying NTT Manager: ${networkConfig.underlyingNttManager}`
  )

  // Get deployer from secure key manager
  console.log("🔐 Loading deployer from encrypted key...")
  const privateKey = await secureKeyManager.getDecryptedKey()
  const wallet = new ethers.Wallet(privateKey, hre.ethers.provider)
  const deployer = wallet.address
  console.log(`✅ Using deployer: ${deployer}`)

  // Check deployer balance
  const balance = await hre.ethers.provider.getBalance(deployer)
  const balanceEth = ethers.utils.formatEther(balance)
  console.log(`💰 Deployer balance: ${balanceEth} ETH`)

  if (balance.lt(ethers.utils.parseEther("0.1"))) {
    console.warn(
      "⚠️  Low balance detected. Make sure you have enough ETH for deployment."
    )
  }

  // Get the contract factory
  console.log("📦 Getting L1BTCDepositorNttWithExecutor contract factory...")
  const L1BTCDepositorNttWithExecutor = await ethers.getContractFactory(
    "L1BTCDepositorNttWithExecutor",
    wallet
  )

  console.log("🔨 Deploying with upgrades proxy...")

  // Deploy with upgrades proxy
  const proxy = await upgrades.deployProxy(
    L1BTCDepositorNttWithExecutor,
    [
      networkConfig.tbtcBridge,
      networkConfig.tbtcVault,
      networkConfig.nttManagerWithExecutor,
      networkConfig.underlyingNttManager,
    ],
    {
      initializer: "initialize",
      kind: "transparent",
      salt: ethers.utils.formatBytes32String(DEPLOYMENT_SALT),
    }
  )

  console.log("⏳ Waiting for deployment transaction...")
  const deploymentTx = await proxy.deployTransaction.wait()

  console.log(`✅ L1BTCDepositorNttWithExecutor deployed successfully!`)
  console.log(`   Proxy address: ${proxy.address}`)
  console.log(`   Transaction hash: ${deploymentTx.transactionHash}`)
  console.log(`   Block number: ${deploymentTx.blockNumber}`)
  console.log(`   Gas used: ${deploymentTx.gasUsed.toString()}`)

  // Get implementation and admin addresses
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(
    proxy.address
  )
  const adminAddress = await upgrades.erc1967.getAdminAddress(proxy.address)

  console.log(`   Implementation: ${implementationAddress}`)
  console.log(`   Proxy Admin: ${adminAddress}`)

  // Configure the contract
  console.log("⚙️  Configuring L1BTCDepositorNttWithExecutor...")

  // Set supported chain (Sei)
  console.log(`   Setting supported chain: ${networkConfig.seiChainId} (Sei)`)
  const setSupportedChainTx = await proxy.setSupportedChain(
    networkConfig.seiChainId,
    true
  )
  await setSupportedChainTx.wait()

  // Set default supported chain
  console.log(`   Setting default supported chain: ${networkConfig.seiChainId}`)
  const setDefaultChainTx = await proxy.setDefaultSupportedChain(
    networkConfig.seiChainId
  )
  await setDefaultChainTx.wait()

  // If Base Sepolia is configured (for testing), add it as well
  if (networkConfig.baseSepolia) {
    console.log(
      `   Setting supported chain: ${networkConfig.baseSepolia.chainId} (Base Sepolia)`
    )
    const setBaseSupportedChainTx = await proxy.setSupportedChain(
      networkConfig.baseSepolia.chainId,
      true
    )
    await setBaseSupportedChainTx.wait()
  }

  // Set default parameters (reasonable defaults)
  console.log("   Setting default parameters...")
  const setDefaultParamsTx = await proxy.setDefaultParameters(
    500000, // 500k gas limit for destination execution
    0, // 0% executor fee
    ethers.constants.AddressZero // No fee recipient
  )
  await setDefaultParamsTx.wait()

  console.log("✅ Configuration complete!")

  // Verification info
  console.log("\n🔍 Contract Verification Info:")
  console.log(`   Network: ${networkConfig.networkName}`)
  console.log(`   Explorer: ${networkConfig.explorer}`)
  console.log(`   Proxy: ${proxy.address}`)
  console.log(`   Implementation: ${implementationAddress}`)
  console.log(
    `   Constructor Args: [${networkConfig.tbtcBridge}, ${networkConfig.tbtcVault}, ${networkConfig.nttManagerWithExecutor}, ${networkConfig.underlyingNttManager}]`
  )

  return {
    proxy: proxy.address,
    implementation: implementationAddress,
    admin: adminAddress,
    owner: deployer,
    network: networkConfig.networkName,
    transactionHash: deploymentTx.transactionHash,
    tbtcBridge: networkConfig.tbtcBridge,
    tbtcVault: networkConfig.tbtcVault,
    nttManagerWithExecutor: networkConfig.nttManagerWithExecutor,
    underlyingNttManager: networkConfig.underlyingNttManager,
  }
}

// Network configurations
export const NETWORK_CONFIGS: Record<string, L1BTCDepositorNetworkConfig> = {
  sepolia: {
    networkName: "Sepolia",
    explorer: "https://sepolia.etherscan.io",
    rpcUrl: "https://sepolia.infura.io/v3/",
    // Sepolia contract addresses (these need to be updated with actual deployed addresses)
    tbtcBridge: "0x9b1a7fE5a16A15F2f9475C5B231750598b113403", // Sepolia Bridge
    tbtcVault: "0x6c9FC64A53c1b71FB3f9Af64d1ae3A4931A5f4E9", // Sepolia Vault
    nttManagerWithExecutor: "0x0000000000000000000000000000000000000000", // TODO: Update with actual address
    underlyingNttManager: "0x0000000000000000000000000000000000000000", // TODO: Update with actual address
    seiChainId: 32, // Wormhole chain ID for Sei
    baseSepolia: {
      chainId: 30, // Wormhole chain ID for Base Sepolia
    },
  },
  mainnet: {
    networkName: "Ethereum Mainnet",
    explorer: "https://etherscan.io",
    rpcUrl: "https://mainnet.infura.io/v3/",
    // Mainnet contract addresses
    tbtcBridge: "0x5e4861a80B55f035D899f66772b54192c156E5c7", // Mainnet Bridge
    tbtcVault: "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD", // Mainnet Vault
    nttManagerWithExecutor: "0x0000000000000000000000000000000000000000", // TODO: Update with actual address
    underlyingNttManager: "0x0000000000000000000000000000000000000000", // TODO: Update with actual address
    seiChainId: 32, // Wormhole chain ID for Sei
  },
}

/**
 * CLI interface for direct deployment
 */
async function main() {
  const network = process.argv[2]

  if (!network || !NETWORK_CONFIGS[network]) {
    console.log("Usage: npm run deploy:l1btc-depositor-ntt-executor [network]")
    console.log("Available networks:", Object.keys(NETWORK_CONFIGS).join(", "))
    process.exit(1)
  }

  // Mock HRE for direct usage
  const hre = {
    ethers,
    upgrades: require("@openzeppelin/hardhat-upgrades"),
    network: { name: network },
  } as any

  const result = await deployL1BTCDepositorNttWithExecutor(
    hre,
    NETWORK_CONFIGS[network]
  )

  console.log("\n🎉 Deployment completed successfully!")
  console.log("📋 Summary:", result)
}

// Run CLI if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error("❌ Deployment failed:", error)
    process.exit(1)
  })
}
