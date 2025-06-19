import { ethers } from "hardhat"
import hre from "hardhat"

async function estimateDeploymentGas() {
  console.log("=== StarkNet Bitcoin Depositor Deployment Gas Estimation ===\n")
  
  const network = hre.network.name
  console.log(`Network: ${network}`)
  
  // Get current gas price
  const gasPrice = await hre.ethers.provider.getGasPrice()
  console.log(`Current gas price: ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei`)
  
  // Get the deployer
  const { deployer } = await hre.getNamedAccounts()
  const signer = await ethers.getSigner(deployer)
  console.log(`Deployer: ${deployer}`)
  
  // Check deployer balance
  const balance = await signer.getBalance()
  console.log(`Deployer balance: ${ethers.utils.formatEther(balance)} ETH\n`)
  
  // Get contract factories
  const StarkNetBitcoinDepositor = await ethers.getContractFactory("StarkNetBitcoinDepositor")
  const TransparentUpgradeableProxy = await ethers.getContractFactory("TransparentUpgradeableProxy")
  const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin")
  
  // Estimate gas for each deployment step
  console.log("=== Gas Estimates ===")
  
  // 1. ProxyAdmin deployment
  const proxyAdminDeployTx = ProxyAdmin.getDeployTransaction()
  const proxyAdminGas = await signer.estimateGas(proxyAdminDeployTx)
  console.log(`1. ProxyAdmin deployment: ${proxyAdminGas.toString()} gas`)
  
  // 2. Implementation deployment
  const implDeployTx = StarkNetBitcoinDepositor.getDeployTransaction()
  const implGas = await signer.estimateGas(implDeployTx)
  console.log(`2. StarkNetBitcoinDepositor implementation: ${implGas.toString()} gas`)
  
  // 3. Proxy deployment (estimate)
  // For proxy, we need to estimate with dummy addresses since we don't have the actual ones yet
  const dummyImpl = "0x0000000000000000000000000000000000000001"
  const dummyAdmin = "0x0000000000000000000000000000000000000002"
  const initData = StarkNetBitcoinDepositor.interface.encodeFunctionData("initialize", [
    "0x5e4861a80B55f035D899f66772117F00FA0E8e7B", // Bridge
    "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD", // Vault
    "0x2111A49ebb717959059693a3698872a0aE9866b9"  // StarkGate
  ])
  
  const proxyDeployTx = TransparentUpgradeableProxy.getDeployTransaction(
    dummyImpl,
    dummyAdmin,
    initData
  )
  const proxyGas = await signer.estimateGas(proxyDeployTx)
  console.log(`3. TransparentUpgradeableProxy deployment: ${proxyGas.toString()} gas`)
  
  // Total gas estimation
  const totalGas = proxyAdminGas.add(implGas).add(proxyGas)
  console.log(`\nTotal estimated gas: ${totalGas.toString()}`)
  
  // Cost calculations at different gas prices
  console.log("\n=== Deployment Cost Estimates ===")
  const gasPrices = [20, 30, 50, 100] // gwei
  
  for (const gwei of gasPrices) {
    const priceInWei = ethers.utils.parseUnits(gwei.toString(), "gwei")
    const totalCost = totalGas.mul(priceInWei)
    console.log(`At ${gwei} gwei: ${ethers.utils.formatEther(totalCost)} ETH`)
  }
  
  // Current gas price cost
  const currentCost = totalGas.mul(gasPrice)
  console.log(`\nAt current gas price (${ethers.utils.formatUnits(gasPrice, "gwei")} gwei): ${ethers.utils.formatEther(currentCost)} ETH`)
  
  // Check if deployer has enough balance
  console.log("\n=== Balance Check ===")
  if (balance.gte(currentCost.mul(2))) { // 2x for safety margin
    console.log("✅ Deployer has sufficient balance (with 2x safety margin)")
  } else {
    console.log("❌ Deployer may not have sufficient balance")
    const needed = currentCost.mul(2).sub(balance)
    console.log(`   Need additional: ${ethers.utils.formatEther(needed)} ETH`)
  }
  
  // Add contract verification gas costs (approximate)
  console.log("\n=== Additional Costs ===")
  console.log("Contract verification: ~0.001-0.005 ETH (Etherscan API calls)")
  console.log("Safety margin recommended: 2x estimated cost")
}

// Run the estimation
estimateDeploymentGas()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })