import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, deployments } = hre
  const { execute } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.get("Bridge")

  await execute(
    "Bank",
    { from: deployer, log: true, waitConfirmations: 1 },
    "updateBridge",
    Bridge.address
  )
}

export default func

func.tags = ["BankUpdateBridge"]
func.dependencies = ["Bank", "Bridge"]
