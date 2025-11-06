/**
 * Ultra simple Sepolia deployment script for L1BTCDepositorNttWithExecutor
 * Bypasses all hardhat-deploy and OpenZeppelin issues
 * Uses secure encrypted key management
 */

import { ethers } from "hardhat"
import { secureKeyManager } from "./secure-key-manager"

async function main() {
  console.log("🎯 Deploying L1BTCDepositorNttWithExecutor on Sepolia...")

  // Sepolia contract addresses from testnet deployment info
  const tbtcBridge = "0x9b1a7fE5a16A15F2f9475C5B231750598b113403"
  const tbtcVault = "0xB5679dE944A79732A75CE556191DF11F489448d5"
  const nttManagerWithExecutor = "0x86E4038abd972A9218498a553058AF8f085CC295" // NTT Manager With Executor
  const underlyingNttManager = "0x79AA1b04edA5b77265aFd1FDB9646eab065eadEc" // NTT Manager

  console.log(`   tBTC Bridge: ${tbtcBridge}`)
  console.log(`   tBTC Vault: ${tbtcVault}`)
  console.log(`   NTT Manager With Executor: ${nttManagerWithExecutor}`)
  console.log(`   Underlying NTT Manager: ${underlyingNttManager}`)

  // Get deployer using secure key manager
  console.log("🔐 Loading deployer from encrypted key...")

  let deployer
  try {
    const privateKey = await secureKeyManager.getDecryptedKey()
    deployer = new ethers.Wallet(privateKey, ethers.provider)
  } catch (error: any) {
    if (error.message.includes("No encrypted key found")) {
      console.log(
        "❌ No encrypted key found. Please set up your private key first:"
      )
      console.log("   npx hardhat run scripts/secure-key-manager.ts --encrypt")
      process.exit(1)
    }
    throw error
  }

  console.log(`✅ Using deployer: ${deployer.address}`)

  // Check deployer balance
  const balance = await ethers.provider.getBalance(deployer.address)
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
    deployer
  )

  console.log("🔨 Deploying implementation...")

  // Deploy implementation first
  const implementation = await L1BTCDepositorNttWithExecutor.deploy({
    gasLimit: 8000000, // 8M gas limit
  })

  console.log("⏳ Waiting for implementation deployment...")
  await implementation.deployed()
  console.log(`✅ Implementation deployed at: ${implementation.address}`)

  console.log("🔨 Deploying proxy...")

  // Deploy TransparentUpgradeableProxy
  const ProxyFactory = await ethers.getContractFactory(
    "TransparentUpgradeableProxy",
    deployer
  )

  // Encode the initialize function call
  const initData = implementation.interface.encodeFunctionData("initialize", [
    tbtcBridge,
    tbtcVault,
    nttManagerWithExecutor,
    underlyingNttManager,
  ])

  // Deploy proxy with deployer as admin
  const proxy = await ProxyFactory.deploy(
    implementation.address,
    deployer.address, // admin
    initData,
    {
      gasLimit: 8000000, // 8M gas limit
    }
  )

  console.log("⏳ Waiting for proxy deployment...")
  await proxy.deployed()

  console.log("✅ L1BTCDepositorNttWithExecutor deployed successfully!")
  console.log(`   Proxy address: ${proxy.address}`)
  console.log(`   Implementation: ${implementation.address}`)
  console.log(`   Admin: ${deployer.address}`)

  console.log("\n🎉 Deployment completed successfully!")
  console.log("📋 Summary:")
  console.log("   Network: Sepolia")
  console.log("   Explorer: https://sepolia.etherscan.io")
  console.log(`   Proxy: ${proxy.address}`)
  console.log(`   Implementation: ${implementation.address}`)
  console.log(`   Admin: ${deployer.address}`)
  console.log(`   Owner: ${deployer.address}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error)
    process.exit(1)
  })
