import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { governance } = await getNamedAccounts()

  const LightRelayMaintainerProxy = await deployments.get(
    "LightRelayMaintainerProxy",
  )

  await execute(
    "ReimbursementPool",
    { from: governance, log: true, waitConfirmations: 1 },
    "authorize",
    LightRelayMaintainerProxy.address,
  )
}

export default func

func.tags = ["AuthorizeLightRelayMaintainerProxyInReimbursementPool"]
func.dependencies = ["ReimbursementPool", "LightRelayMaintainerProxy"]

// On mainnet, the ReimbursementPool ownership is passed to the Threshold
// Council / DAO and that address is not controlled by the dev team.
// Hence, this step can be executed only for non-mainnet networks such as
// Hardhat (unit tests) and Sepolia (testnet).
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name === "mainnet"
