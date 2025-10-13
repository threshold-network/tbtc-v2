import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { secureKeyManager } from "../../cross-chain/sei/scripts/secure-key-manager"

// Set the RPC URL for mainnet if not already set
if (!process.env.CHAIN_API_URL) {
  process.env.CHAIN_API_URL = "https://ethereum.publicnode.com"
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { ethers, helpers, deployments } = hre
  
  // Get deployer from encrypted key
  console.log("🔐 Loading deployer from encrypted key...")
  const privateKey = await secureKeyManager.getDecryptedKey()
  const wallet = new ethers.Wallet(privateKey, hre.ethers.provider)
  const deployer = wallet.address

  // Network configurations
  const networkConfigs = {
    sepolia: {
      networkName: "Ethereum Sepolia",
      explorer: "https://sepolia.etherscan.io",
      tbtcBridge: "0x5e4861a80B55f035D899f66772b54192c156E5c7", // Sepolia Bridge
      tbtcVault: "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD", // Sepolia Vault
      nttManagerWithExecutor: "0xd2d9c936165a85f27a5a7e07afb974d022b89463", // NTT Manager With Executor
      underlyingNttManager: "0x79eb9aF995a443A102A19b41EDbB58d66e2921c7", // Underlying NTT Manager
    },
    mainnet: {
      networkName: "Ethereum Mainnet",
      explorer: "https://etherscan.io",
      tbtcBridge: "0x5e4861a80B55F035D899F66772b54192C156e5c7", // Mainnet Bridge
      tbtcVault: "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD", // Mainnet Vault
      nttManagerWithExecutor: "0xD2D9c936165a85F27a5a7e07aFb974D022B89463", // NTT Manager With Executor
      underlyingNttManager: "0x79eb9aF995a443A102A19b41EDbB58d66e2921c7", // Underlying NTT Manager
    },
  }

  const networkName = hre.network.name as keyof typeof networkConfigs
  const networkConfig = networkConfigs[networkName]

  if (!networkConfig) {
    throw new Error(`Unsupported network: ${networkName}`)
  }

  console.log(`🎯 Deploying L1BTCDepositorNttWithExecutor on ${networkConfig.networkName}...`)
  console.log(`   Deployer: ${deployer}`)
  console.log(`   tBTC Bridge: ${networkConfig.tbtcBridge}`)
  console.log(`   tBTC Vault: ${networkConfig.tbtcVault}`)
  console.log(`   NTT Manager With Executor: ${networkConfig.nttManagerWithExecutor}`)
  console.log(`   Underlying NTT Manager: ${networkConfig.underlyingNttManager}`)

  // Deploy with upgrades proxy using the same pattern as other scripts
  const [proxy, proxyDeployment] = await helpers.upgrades.deployProxy(
    "L1BTCDepositorNttWithExecutor",
    {
      contractName: "L1BTCDepositorNttWithExecutor",
      initializerArgs: [
        networkConfig.tbtcBridge,
        networkConfig.tbtcVault,
        networkConfig.nttManagerWithExecutor,
        networkConfig.underlyingNttManager,
      ],
      factoryOpts: {
        signer: wallet,
        gasLimit: 8000000, // Increased gas limit for complex contract deployment
      },
      proxyOpts: {
        kind: "transparent",
      },
    }
  )

  console.log("✅ L1BTCDepositorNttWithExecutor deployed successfully!")
  console.log(`   Proxy Address: ${proxy.address}`)
  console.log(`   Explorer: ${networkConfig.explorer}/address/${proxy.address}`)

  // Get implementation address
  const implementationAddress = await helpers.upgrades.erc1967.getImplementationAddress(proxy.address)
  console.log(`   Implementation: ${implementationAddress}`)

  // Get admin address
  const adminAddress = await helpers.upgrades.erc1967.getAdminAddress(proxy.address)
  console.log(`   Admin: ${adminAddress}`)

  console.log("\n📋 Deployment Summary:")
  console.log(`   Network: ${networkConfig.networkName}`)
  console.log(`   Proxy: ${proxy.address}`)
  console.log(`   Implementation: ${implementationAddress}`)
  console.log(`   Admin: ${adminAddress}`)
  console.log(`   Owner: ${deployer}`)
  console.log(`   tBTC Bridge: ${networkConfig.tbtcBridge}`)
  console.log(`   tBTC Vault: ${networkConfig.tbtcVault}`)
  console.log(`   NTT Manager With Executor: ${networkConfig.nttManagerWithExecutor}`)
  console.log(`   Underlying NTT Manager: ${networkConfig.underlyingNttManager}`)
}

func.tags = ["L1BTCDepositorNttWithExecutor"]
func.dependencies = []

export default func
