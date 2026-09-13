import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  const LightRelayMaintainerProxy = await deployments.get(
    "LightRelayMaintainerProxy",
  )

  await execute(
    "LightRelay",
    { from: deployer, log: true, waitConfirmations: 1 },
    "authorize",
    LightRelayMaintainerProxy.address,
  )
}

export default func

func.tags = ["AuthorizeLightRelayMaintainerProxyInLightRelay"]
func.dependencies = ["LightRelay", "LightRelayMaintainerProxy"]

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name === "sepolia" || hre.network.name === "system_tests"
