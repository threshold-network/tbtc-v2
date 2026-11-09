import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function transferMaintainerProxyOwnership(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  await helpers.ownable.transferOwnership(
    "MaintainerProxy",
    governance,
    deployer
  )
}

export default func

func.tags = ["TransferMaintainerProxyOwnership"]
func.dependencies = ["MaintainerProxy"]
func.runAtTheEnd = true
