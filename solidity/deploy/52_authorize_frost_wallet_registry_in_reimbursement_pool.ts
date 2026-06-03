import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre
  const { execute } = deployments
  const { governance } = await getNamedAccounts()

  const FrostWalletRegistry = await deployments.get("FrostWalletRegistry")
  const reimbursementPool = await ethers.getContractAt(
    "ReimbursementPool",
    (
      await deployments.get("ReimbursementPool")
    ).address
  )

  if (await reimbursementPool.isAuthorized(FrostWalletRegistry.address)) {
    console.log(
      `FrostWalletRegistry ${FrostWalletRegistry.address} is already authorized in ReimbursementPool`
    )
    return
  }

  await execute(
    "ReimbursementPool",
    { from: governance, log: true, waitConfirmations: 1 },
    "authorize",
    FrostWalletRegistry.address
  )
}

export default func

func.tags = ["AuthorizeFrostWalletRegistryInReimbursementPool"]
func.dependencies = ["ReimbursementPool", "FrostWalletRegistry"]

// On mainnet, the ReimbursementPool ownership is passed to the Threshold
// Council / DAO and that address is not controlled by the dev team.
// Hence, this step can be executed only for non-mainnet networks such as
// Hardhat (unit tests) and Sepolia (testnet).
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name === "mainnet"
