import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function runDeployment(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  await helpers.ownable.transferOwnership("Bank", governance, deployer)
}

export default func

func.tags = ["TransferBankOwnership"]
func.dependencies = ["Bank", "BankUpdateBridge"]
func.runAtTheEnd = true
