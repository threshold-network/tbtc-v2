import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function authorizeMaintainerProxyInReimbursementPool(hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { governance } = await getNamedAccounts()

  const MaintainerProxy = await deployments.get("MaintainerProxy")

  await execute(
    "ReimbursementPool",
    { from: governance, log: true, waitConfirmations: 1 },
    "authorize",
    MaintainerProxy.address,
  )
}

export default func

func.tags = ["AuthorizeMaintainerProxyInReimbursementPool"]
func.dependencies = ["ReimbursementPool", "MaintainerProxy"]

// On mainnet, the ReimbursementPool ownership is passed to the Threshold
// Council / DAO and that address is not controlled by the dev team.
// Hence, this step can be executed only for non-mainnet networks such as
// Hardhat (unit tests) and Sepolia (testnet).
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name === "mainnet"
