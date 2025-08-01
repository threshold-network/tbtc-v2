import { ethers } from "hardhat"
import { LockReleaseTokenPoolUpgradeable } from "../typechain/LockReleaseTokenPoolUpgradeable"

async function main() {
  const contractAddress = "0xe3dE7061A112Fb05A1a84a709e03988ae8703e15"

  console.log(`🔍 Verifying deployment at: ${contractAddress}`)

  // Get the contract instance
  const contract = (await ethers.getContractAt(
    "LockReleaseTokenPoolUpgradeable",
    contractAddress
  )) as LockReleaseTokenPoolUpgradeable

  try {
    // Check router address
    const router = await contract.getRouter()
    console.log(`🌐 Router: ${router}`)

    // Check if it accepts liquidity
    const acceptsLiquidity = await contract.canAcceptLiquidity()
    console.log(`💧 Accepts Liquidity: ${acceptsLiquidity}`)

    // Check token address
    const token = await contract.getToken()
    console.log(`🪙 Token: ${token}`)

    // Check rebalancer
    const rebalancer = await contract.getRebalancer()
    console.log(`🔧 Rebalancer: ${rebalancer}`)

    // Check supported interfaces
    const poolV1 = await contract.supportsInterface("0x0a861961") // IPoolV1
    const liquidityContainer = await contract.supportsInterface("0x1ba8a5b7") // ILiquidityContainer
    const erc165 = await contract.supportsInterface("0x01ffc9a7") // IERC165

    console.log("🔌 Interface Support:")
    console.log(`  - IPoolV1: ${poolV1}`)
    console.log(`  - ILiquidityContainer: ${liquidityContainer}`)
    console.log(`  - IERC165: ${erc165}`)

    console.log("\n✅ Verification completed successfully!")
  } catch (error) {
    console.error("❌ Verification failed:", error)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
