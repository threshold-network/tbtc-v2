import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function authorizeLightRelayMaintainer(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  await execute(
    "LightRelay",
    { from: deployer, log: true, waitConfirmations: 1 },
    "setAuthorizationStatus",
    true
  )
}

export default func

func.tags = ["AuthorizeLightRelayMaintainer"]
func.dependencies = ["RetargetLightRelay"]

// Only execute for mainnet.
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name !== "mainnet"
