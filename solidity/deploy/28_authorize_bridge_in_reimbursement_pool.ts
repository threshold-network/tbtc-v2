import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function authorizeBridgeInReimbursementPool(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { governance } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")

  await execute(
    "ReimbursementPool",
    { from: governance, log: true, waitConfirmations: 1 },
    "authorize",
    Bridge.address
  )
}

export default func

func.tags = ["AuthorizeBridgeInReimbursementPool"]
func.dependencies = ["ReimbursementPool", "Bridge"]

// On mainnet, the ReimbursementPool ownership is passed to the Threshold
// Council / DAO and that address is not controlled by the dev team.
// Hence, this step can be executed only for non-mainnet networks such as
// Hardhat (unit tests) and Sepolia (testnet).
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name === "mainnet"
