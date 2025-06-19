import { ethers } from "hardhat"
import hre from "hardhat"

async function dryRunDeployment() {
  console.log("=== DRY RUN: StarkNet Bitcoin Depositor Deployment ===\n")
  
  const network = hre.network.name
  console.log(`Network: ${network}`)
  console.log(`Chain ID: ${(await hre.ethers.provider.getNetwork()).chainId}`)
  
  // Get configuration
  const { deployer } = await hre.getNamedAccounts()
  console.log(`\nDeployer address: ${deployer}`)
  
  // Get contract addresses
  let tbtcBridge: any
  let tbtcVault: any
  
  try {
    tbtcBridge = await hre.deployments.get("Bridge")
    tbtcVault = await hre.deployments.get("TBTCVault")
    console.log("\n✅ Using deployed tBTC contracts:")
  } catch (error) {
    console.log("\n⚠️  Using hardcoded tBTC contracts:")
    tbtcBridge = { address: "0x5e4861a80B55f035D899f66772117F00FA0E8e7B" }
    tbtcVault = { address: "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD" }
  }
  
  console.log(`   Bridge: ${tbtcBridge.address}`)
  console.log(`   Vault: ${tbtcVault.address}`)
  
  // Network-specific StarkGate bridge
  let starkGateBridge: string
  if (network === "sepolia") {
    starkGateBridge = "0xF6217de888fD6E6b2CbFBB2370973BE4c36a152D"
  } else if (network === "mainnet") {
    starkGateBridge = "0x2111A49ebb717959059693a3698872a0aE9866b9"
  } else {
    starkGateBridge = "0x1234567890123456789012345678901234567890"
  }
  console.log(`   StarkGate Bridge: ${starkGateBridge}`)
  
  // Check deployer
  const signer = await ethers.getSigner(deployer)
  const balance = await signer.getBalance()
  const nonce = await signer.getTransactionCount()
  
  console.log(`\nDeployer Status:`)
  console.log(`   Balance: ${ethers.utils.formatEther(balance)} ETH`)
  console.log(`   Nonce: ${nonce}`)
  
  // Validate private key matches expected address (mainnet only)
  if (network === "mainnet") {
    const signerAddress = await signer.getAddress()
    if (signerAddress.toLowerCase() !== deployer.toLowerCase()) {
      console.log(`\n❌ Private key mismatch!`)
      console.log(`   Expected: ${deployer}`)
      console.log(`   Got: ${signerAddress}`)
      process.exit(1)
    }
    console.log(`   ✅ Private key validation passed`)
  }
  
  // Predict deployment addresses
  console.log(`\n📍 Predicted Deployment Addresses:`)
  
  // ProxyAdmin will be deployed at nonce
  const proxyAdminAddress = ethers.utils.getContractAddress({
    from: deployer,
    nonce: nonce
  })
  console.log(`   ProxyAdmin: ${proxyAdminAddress}`)
  
  // Implementation will be deployed at nonce + 1
  const implementationAddress = ethers.utils.getContractAddress({
    from: deployer,
    nonce: nonce + 1
  })
  console.log(`   Implementation: ${implementationAddress}`)
  
  // Proxy will be deployed at nonce + 2
  const proxyAddress = ethers.utils.getContractAddress({
    from: deployer,
    nonce: nonce + 2
  })
  console.log(`   Proxy: ${proxyAddress}`)
  
  // Check gas price
  const gasPrice = await hre.ethers.provider.getGasPrice()
  const baseFee = await hre.ethers.provider.getBlock("latest").then(b => b.baseFeePerGas)
  
  console.log(`\n⛽ Gas Price Information:`)
  console.log(`   Current gas price: ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei`)
  if (baseFee) {
    console.log(`   Base fee: ${ethers.utils.formatUnits(baseFee, "gwei")} gwei`)
    const priorityFee = gasPrice.sub(baseFee)
    console.log(`   Priority fee: ${ethers.utils.formatUnits(priorityFee, "gwei")} gwei`)
  }
  
  // Summary
  console.log(`\n=== Deployment Summary ===`)
  console.log(`Network: ${network}`)
  console.log(`Deployer: ${deployer}`)
  console.log(`Deployer Balance: ${ethers.utils.formatEther(balance)} ETH`)
  console.log(`\nContracts to deploy:`)
  console.log(`1. ProxyAdmin`)
  console.log(`2. StarkNetBitcoinDepositor (Implementation)`)
  console.log(`3. TransparentUpgradeableProxy`)
  console.log(`\nInitialization parameters:`)
  console.log(`   tbtcBridge: ${tbtcBridge.address}`)
  console.log(`   tbtcVault: ${tbtcVault.address}`)
  console.log(`   starkGateBridge: ${starkGateBridge}`)
  
  console.log(`\n✅ Dry run complete. No transactions were sent.`)
  console.log(`To deploy for real, run: yarn deploy:${network}`)
}

// Run the dry run
dryRunDeployment()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })