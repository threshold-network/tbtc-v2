import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  await helpers.ownable.transferOwnership(
    "BridgeGovernance",
    governance,
    deployer
  )
}

export default func

func.tags = ["BridgeGovernanceOwnership"]
func.dependencies = ["BridgeGovernance"]
func.runAtTheEnd = true
