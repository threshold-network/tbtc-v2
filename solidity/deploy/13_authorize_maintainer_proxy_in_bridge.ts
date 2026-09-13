import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  const MaintainerProxy = await deployments.get("MaintainerProxy")

  await execute(
    "Bridge",
    { from: deployer, log: true, waitConfirmations: 1 },
    "setSpvMaintainerStatus",
    MaintainerProxy.address,
    true
  )
}

export default func

func.tags = ["AuthorizeMaintainerProxyInBridge"]
func.dependencies = ["Bridge", "MaintainerProxy"]
