import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { secureKeyManager } from "../../cross-chain/sei/scripts/secure-key-manager"
import { ethers, upgrades } from "hardhat"

/**
 * L1BTCDepositorNtt Deployment Script
 *
 * Deploys L1BTCDepositorNtt contract for Hub-and-Spoke Bitcoin deposits
 * Supports multiple networks with proper configuration for each
 *
 * Usage:
 *   npx hardhat deploy --network baseSepolia --tags L1BTCDepositorNtt
 *   npx hardhat deploy --network sepolia --tags L1BTCDepositorNtt
 *   npx hardhat deploy --network seiTestnet --tags L1BTCDepositorNtt
 *   npx hardhat deploy --network seiMainnet --tags L1BTCDepositorNtt
 *   npx hardhat deploy --network mainnet --tags L1BTCDepositorNtt
 */

interface NetworkConfig {
  // Threshold Protocol Addresses
  bridge: string
  tbtcVault: string
  tbtcToken: string

  // NTT Manager Addresses
  nttManager: string

  // Wormhole Chain IDs for destination chains
  supportedChains: { chainId: number; name: string }[]

  // Network specific settings
  gasPrice?: string
  verifyContract: boolean
}

const NETWORK_CONFIGS: Record<string, NetworkConfig> = {
  // Hardhat local network for testing
  hardhat: {
    bridge: "0x0000000000000000000000000000000000000000", // Will be set to deployer address
    tbtcVault: "0x0000000000000000000000000000000000000000", // Will be set to deployer address
    tbtcToken: "0x0000000000000000000000000000000000000000", // Will be set to deployer address
    nttManager: "0x0000000000000000000000000000000000000000", // Will be set to deployer address
    supportedChains: [
      { chainId: 32, name: "Sei" }, // Sei Wormhole Chain ID
      { chainId: 10002, name: "Sepolia" }, // Ethereum Sepolia
    ],
    gasPrice: "1000000000", // 1 gwei
    verifyContract: false, // No verification needed for local testing
  },

  // Base Sepolia Testnet
  baseSepolia: {
    bridge: "0x0000000000000000000000000000000000000000", // TODO: Add Base Sepolia Bridge address
    tbtcVault: "0x0000000000000000000000000000000000000000", // TODO: Add Base Sepolia TBTCVault address
    tbtcToken: "0xdDFeABcCf2063CD66f53a1218e23c681Ba6e7962", // Base Sepolia tBTC from NTT test config
    nttManager: "0x8b9E328bE1b1Bc7501B413d04EBF7479B110775c", // Base Sepolia NTT Manager from test config
    supportedChains: [
      { chainId: 32, name: "Sei" }, // Sei Wormhole Chain ID
      { chainId: 10002, name: "Sepolia" }, // Ethereum Sepolia
    ],
    gasPrice: "1000000000", // 1 gwei
    verifyContract: true,
  },

  // Ethereum Sepolia Testnet
  sepolia: {
    bridge: "0x0000000000000000000000000000000000000000", // Will be set to deployer address
    tbtcVault: "0x0000000000000000000000000000000000000000", // Will be set to deployer address
    tbtcToken: "0xd48430eb40F6F89113999cc70A9C415f724F5e59", // Sepolia tBTC from deployment-testnet.json
    nttManager: "0x79AA1b04edA5b77265aFd1FDB9646eab065eadEc", // Sepolia NTT Manager from deployment-testnet.json
    supportedChains: [
      { chainId: 10004, name: "Base Sepolia" }, // Base Sepolia Wormhole Chain ID
      { chainId: 32, name: "Sei" }, // Sei Wormhole Chain ID
    ],
    gasPrice: "20000000000", // 20 gwei
    verifyContract: true,
  },

  // Sei Testnet (Arctic)
  seiTestnet: {
    bridge: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Testnet Bridge address if applicable
    tbtcVault: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Testnet TBTCVault address if applicable
    tbtcToken: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Testnet tBTC token address
    nttManager: "0x0000000000000000000000000000000000000000", // TODO: Deploy NTT Manager on Sei Testnet
    supportedChains: [
      { chainId: 10002, name: "Sepolia" }, // Ethereum Sepolia as Hub
      { chainId: 10004, name: "Base Sepolia" }, // Base Sepolia
    ],
    gasPrice: "20000000000", // 20 gwei equivalent
    verifyContract: true,
  },

  // Sei Mainnet (Pacific)
  seiMainnet: {
    bridge: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Mainnet Bridge address if applicable
    tbtcVault: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Mainnet TBTCVault address if applicable
    tbtcToken: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Mainnet tBTC token address
    nttManager: "0x0000000000000000000000000000000000000000", // TODO: Deploy NTT Manager on Sei Mainnet
    supportedChains: [
      { chainId: 2, name: "Ethereum" }, // Ethereum Mainnet as Hub
      { chainId: 8453, name: "Base" }, // Base Mainnet
    ],
    gasPrice: "20000000000", // 20 gwei equivalent
    verifyContract: true,
  },

  // Ethereum Mainnet
  mainnet: {
    bridge: "0x5e4861a80B55f035D899f66772b54e65D5E4221f", // Ethereum Mainnet Bridge address
    tbtcVault: "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD", // Ethereum Mainnet TBTCVault address
    tbtcToken: "0x18084fbA666a33d37592fA2633fD49a74DD93a88", // Ethereum Mainnet tBTC token address
    nttManager: "0x0000000000000000000000000000000000000000", // TODO: Deploy NTT Manager on Ethereum Mainnet
    supportedChains: [
      { chainId: 32, name: "Sei" }, // Sei Mainnet
      { chainId: 8453, name: "Base" }, // Base Mainnet
      { chainId: 10, name: "Optimism" }, // Optimism Mainnet
      { chainId: 4, name: "Polygon" }, // Polygon Mainnet
    ],
    gasPrice: "30000000000", // 30 gwei
    verifyContract: true,
  },
}

// Manual versioning for deployment traceability
// v1: Initial deployment with mock contracts and NTT Manager integration
// v2: Use owner from deployment-testnet.json; add EIP-1559 fee overrides
// v3: Fixed proxy deployment pattern following Sei script
const DEPLOYMENT_VERSION = "v2"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  func.id = `L1BTCDepositorNtt_${DEPLOYMENT_VERSION}`
  const { deployments, getNamedAccounts, network } = hre
  const { deploy, log, get } = deployments
  const { governance } = await getNamedAccounts()

  const networkName = network.name
  const config = NETWORK_CONFIGS[networkName]

  if (!config) {
    throw new Error(`No configuration found for network: ${networkName}`)
  }

  log(`Deploying L1BTCDepositorNtt on ${networkName}...`)

  // Load expected owner (deployer) from deployment-testnet.json for Sepolia
  let expectedOwner: string | undefined
  try {
    // Resolve relative to repository root regardless of CWD
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path")
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs")
    const jsonPath = path.join(
      __dirname,
      "../../cross-chain/sei/deployment-testnet.json"
    )
    const raw = fs.readFileSync(jsonPath, "utf8")
    const parsed = JSON.parse(raw)
    expectedOwner = parsed?.chains?.Sepolia?.owner
  } catch (e) {
    // Non-fatal; continue
  }

  // Get deployer from secure key manager
  let deployer: string
  let connectedWallet: any
  try {
    log("🔐 Loading deployer from encrypted key...")
    const privateKey = await secureKeyManager.getDecryptedKey()
    const wallet = new ethers.Wallet(privateKey)
    deployer = wallet.address

    // Connect to provider
    const provider = new ethers.providers.JsonRpcProvider(
      process.env.CHAIN_API_URL
    )
    connectedWallet = wallet.connect(provider)

    log(`✅ Using deployer: ${deployer}`)

    if (
      expectedOwner &&
      deployer.toLowerCase() !== expectedOwner.toLowerCase()
    ) {
      throw new Error(
        `Encrypted key address ${deployer} does not match expected owner ${expectedOwner}`
      )
    }

    // Check balance
    const balance = await connectedWallet.getBalance()
    log(`💰 Deployer balance: ${ethers.utils.formatEther(balance)} ETH`)

    if (balance.eq(0)) {
      throw new Error("Deployer has no ETH for gas fees")
    }
  } catch (error) {
    log("⚠️  Failed to load encrypted key, falling back to named accounts...")
    const namedAccounts = await getNamedAccounts()
    deployer = namedAccounts.deployer
    if (!deployer) {
      throw new Error(
        "No deployer account available. Please set up encrypted key or ACCOUNTS_PRIVATE_KEYS environment variable."
      )
    }

    // For named accounts, we'll use the provider directly
    connectedWallet = null
  }

  // Prepare EIP-1559 fee overrides
  let feeData
  if (connectedWallet) {
    feeData = await connectedWallet.getFeeData()
  } else {
    // For hardhat network, use default values
    feeData = {
      maxPriorityFeePerGas: ethers.utils.parseUnits("2", "gwei"),
      maxFeePerGas: ethers.utils.parseUnits("60", "gwei"),
    }
  }

  const defaultTip =
    feeData.maxPriorityFeePerGas ?? ethers.utils.parseUnits("2", "gwei")
  const defaultMax =
    feeData.maxFeePerGas ?? ethers.utils.parseUnits("60", "gwei")
  const maxPriorityFeePerGas = process.env.MAX_PRIORITY_FEE_PER_GAS
    ? ethers.BigNumber.from(process.env.MAX_PRIORITY_FEE_PER_GAS)
    : defaultTip.mul(2)
  const maxFeePerGas = process.env.MAX_FEE_PER_GAS
    ? ethers.BigNumber.from(process.env.MAX_FEE_PER_GAS)
    : defaultMax.mul(2)

  const txOverrides = { maxPriorityFeePerGas, maxFeePerGas }
  log(
    `⛽ Using fees - maxPriorityFeePerGas: ${ethers.utils.formatUnits(
      maxPriorityFeePerGas,
      "gwei"
    )} gwei, maxFeePerGas: ${ethers.utils.formatUnits(
      maxFeePerGas,
      "gwei"
    )} gwei`
  )

  // Deploy mock contracts for testing
  log("🔧 Deploying mock contracts for testing...")

  // Deploy MockTBTCVault
  const MockTBTCVault = await ethers.getContractFactory(
    "contracts/test/MockTBTCVault.sol:MockTBTCVault",
    connectedWallet || undefined
  )
  const mockVault = await MockTBTCVault.deploy({ ...txOverrides })
  await mockVault.deployed()
  log(`   MockTBTCVault deployed at: ${mockVault.address}`)

  // Set the tBTC token address in the mock vault
  await (await mockVault.setTbtcToken(config.tbtcToken, txOverrides)).wait()
  log(`   Set tBTC token in mock vault: ${config.tbtcToken}`)

  // Deploy MockBridge
  const MockBridge = await ethers.getContractFactory(
    "contracts/test/TestBTCDepositor.sol:MockBridge",
    connectedWallet || undefined
  )
  const mockBridge = await MockBridge.deploy({ ...txOverrides })
  await mockBridge.deployed()
  log(`   MockBridge deployed at: ${mockBridge.address}`)

  // Use deployer address as NTT Manager for hardhat network testing
  let nttManagerAddress = config.nttManager
  if (config.nttManager === "0x0000000000000000000000000000000000000000") {
    nttManagerAddress = deployer
    log(`   Using deployer address as NTT Manager: ${nttManagerAddress}`)
  }

  const bridgeAddress = mockBridge.address
  const vaultAddress = mockVault.address

  log(
    `🔧 Using mock contracts - Bridge: ${bridgeAddress}, Vault: ${vaultAddress}`
  )

  // Validate configuration
  const hasZeroAddresses = [config.tbtcToken, nttManagerAddress].some(
    (addr) => addr === "0x0000000000000000000000000000000000000000"
  )

  if (hasZeroAddresses) {
    log("⚠️  WARNING: Some addresses are placeholder values (0x0000...)")
    log(
      "   Please update the configuration with actual deployed contract addresses"
    )
  }

  // Deploy using OpenZeppelin upgrades plugin (following Sei script pattern)
  log("📦 Deploying L1BTCDepositorNtt with TransparentUpgradeableProxy...")

  const L1BTCDepositorNtt = await ethers.getContractFactory(
    "L1BTCDepositorNtt",
    connectedWallet || undefined
  )
  const proxy = await upgrades.deployProxy(
    L1BTCDepositorNtt,
    [bridgeAddress, vaultAddress, nttManagerAddress],
    {
      kind: "transparent",
      initializer: "initialize",
    }
  )

  await proxy.deployed()

  // Get implementation address
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(
    proxy.address
  )
  const adminAddress = await upgrades.erc1967.getAdminAddress(proxy.address)

  const l1BtcDepositorNtt = {
    address: proxy.address,
    newlyDeployed: true,
    implementation: implementationAddress,
    admin: adminAddress,
  }

  log(`✅ L1BTCDepositorNtt deployed successfully!`)
  log(`   Proxy Address: ${l1BtcDepositorNtt.address}`)
  log(`   Implementation: ${l1BtcDepositorNtt.implementation}`)
  log(`   Proxy Admin: ${l1BtcDepositorNtt.admin}`)
  log(`   Owner: ${deployer}`)

  // Try to verify contract setup
  log("\n🔍 Verifying contract setup...")
  try {
    const owner = await proxy.owner()
    const nttManager = await proxy.nttManager()

    log(`   Contract Owner: ${owner}`)
    log(`   NTT Manager: ${nttManager}`)

    if (owner.toLowerCase() === deployer.toLowerCase()) {
      log("   ✅ Ownership correctly set to deployer")
    } else {
      log("   ⚠️  Warning: Owner is not the deployer")
    }
  } catch (error: any) {
    log("   ⚠️  Contract verification failed:", error.message)
  }

  // Configure supported chains
  if (l1BtcDepositorNtt.newlyDeployed && config.supportedChains.length > 0) {
    log("🔧 Configuring supported destination chains...")

    for (const chain of config.supportedChains) {
      try {
        const tx = await proxy.setSupportedChain(
          chain.chainId,
          true,
          txOverrides
        )
        await tx.wait()
        log(`   ✅ Added supported chain: ${chain.name} (ID: ${chain.chainId})`)
      } catch (error: any) {
        log(`   ❌ Failed to add chain ${chain.name}: ${error.message}`)
      }
    }
  }

  // Contract verification
  if (config.verifyContract && network.live) {
    log("🔍 Verifying contract...")
    try {
      await hre.run("verify:verify", {
        address: l1BtcDepositorNtt.address,
        constructorArguments: [],
      })
      log("✅ Contract verified successfully")
    } catch (error) {
      log(`❌ Contract verification failed: ${error.message}`)
    }
  }

  // Output deployment summary
  log("\n📋 Deployment Summary:")
  log(`   Network: ${networkName}`)
  log(`   Contract: ${l1BtcDepositorNtt.address}`)
  log(`   Bridge: ${bridgeAddress} (mock - deployer address)`)
  log(`   TBTCVault: ${vaultAddress} (mock - deployer address)`)
  log(`   tBTC Token: ${config.tbtcToken}`)
  log(`   NTT Manager: ${nttManagerAddress}`)
  log(
    `   Supported Chains: ${config.supportedChains
      .map((c) => `${c.name}(${c.chainId})`)
      .join(", ")}`
  )

  // Post-deployment instructions
  log("\n🚀 Next Steps:")
  log(
    "1. Update any placeholder addresses (0x0000...) with actual contract addresses"
  )
  log("2. Configure NTT Manager peers for cross-chain transfers")
  log("3. Set appropriate rate limits on the NTT Manager")
  log("4. Test deposits and cross-chain transfers on testnet")
  log("5. Transfer ownership to governance/multisig if needed")

  return true
}

func.tags = ["L1BTCDepositorNtt"]
func.dependencies = [] // Add dependencies if needed

export default func
