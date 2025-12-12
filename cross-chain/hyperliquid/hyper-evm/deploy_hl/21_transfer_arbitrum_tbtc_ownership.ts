import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()
  console.log("getNamedAccounts: ", getNamedAccounts)

  await helpers.ownable.transferOwnership("HyperEVMTBTC", governance, deployer)
}

export default func

func.tags = ["TransferHyperEVMTBTCOwnership"]
func.dependencies = ["HyperEVMTBTC"]
func.runAtTheEnd = true
