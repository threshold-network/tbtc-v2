import { ethers } from "hardhat"

async function simpleGasEstimate() {
  console.log("=== StarkNet Bitcoin Depositor Deployment Cost Estimation ===\n")
  
  // Based on typical deployment gas usage:
  // ProxyAdmin: ~487,031 gas (from partial run)
  // Implementation: ~2,379,878 gas (from partial run)
  // TransparentUpgradeableProxy: ~800,000 gas (estimated based on similar deployments)
  
  const gasEstimates = {
    proxyAdmin: 487031,
    implementation: 2379878,
    proxy: 800000, // Conservative estimate
  }
  
  const totalGas = gasEstimates.proxyAdmin + gasEstimates.implementation + gasEstimates.proxy
  
  console.log("Gas Estimates:")
  console.log(`1. ProxyAdmin: ${gasEstimates.proxyAdmin.toLocaleString()} gas`)
  console.log(`2. StarkNetBitcoinDepositor Implementation: ${gasEstimates.implementation.toLocaleString()} gas`)
  console.log(`3. TransparentUpgradeableProxy: ${gasEstimates.proxy.toLocaleString()} gas (estimated)`)
  console.log(`\nTotal Gas: ${totalGas.toLocaleString()} gas`)
  
  console.log("\n=== Deployment Cost at Different Gas Prices ===")
  
  const gasPrices = [5, 10, 20, 30, 50, 100] // gwei
  
  for (const gwei of gasPrices) {
    const costInEth = (totalGas * gwei) / 1e9
    console.log(`At ${gwei} gwei: ${costInEth.toFixed(4)} ETH`)
  }
  
  // Current gas price from dry run was ~1.78 gwei
  const currentGasPrice = 1.78
  const currentCostInEth = (totalGas * currentGasPrice) / 1e9
  console.log(`\nAt current gas price (${currentGasPrice} gwei): ${currentCostInEth.toFixed(4)} ETH`)
  
  console.log("\n=== Recommendations ===")
  console.log("1. Fund the deployer with at least 0.1 ETH for safe deployment")
  console.log("2. Current gas prices are very low (~1.78 gwei), good time to deploy")
  console.log("3. Monitor gas prices at https://etherscan.io/gastracker")
  console.log("4. Consider using EIP-1559 transactions for more predictable costs")
  
  console.log("\n=== Additional Costs ===")
  console.log("- Contract verification: Minimal (API calls only)")
  console.log("- Future transactions: Owner transfers, upgrades, etc.")
  console.log("- Recommended total: 0.15-0.2 ETH for comfortable margin")
}

simpleGasEstimate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })