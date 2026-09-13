import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function transferTbtcVaultOwnership(hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  await helpers.ownable.transferOwnership("TBTCVault", governance, deployer)
}

export default func

func.tags = ["TransferTBTCVaultOwnership"]
func.dependencies = ["TBTCVault"]
func.runAtTheEnd = true
