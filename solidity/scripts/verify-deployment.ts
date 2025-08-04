import { ethers } from "hardhat"
import { LockReleaseTokenPoolUpgradeable } from "../../cross-chain/bob/typechain/contracts/LockReleaseTokenPoolUpgradeable"

async function main() {
  const contractAddress = "0xe3dE7061A112Fb05A1a84a709e03988ae8703e15"

  // Get the contract instance
  const contract = (await ethers.getContractAt(
    "LockReleaseTokenPoolUpgradeable",
    contractAddress
  )) as LockReleaseTokenPoolUpgradeable

  try {
    // Check router address
    const router = await contract.getRouter()

    // Check if it accepts liquidity
    const acceptsLiquidity = await contract.canAcceptLiquidity()

    // Check token address
    const token = await contract.getToken()

    // Check rebalancer
    const rebalancer = await contract.getRebalancer()

    // Check supported interfaces
    const poolV1 = await contract.supportsInterface("0x0a861961") // IPoolV1
    const liquidityContainer = await contract.supportsInterface("0x1ba8a5b7") // ILiquidityContainer
    const erc165 = await contract.supportsInterface("0x01ffc9a7") // IERC165

    // Return verification results
    return {
      contractAddress,
      router,
      acceptsLiquidity,
      token,
      rebalancer,
      interfaces: {
        poolV1,
        liquidityContainer,
        erc165,
      },
    }
  } catch (error) {
    throw new Error(`Verification failed: ${error}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    process.exit(1)
  })
