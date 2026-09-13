import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function transferVendingMachineV3Ownership(hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  await helpers.ownable.transferOwnership(
    "VendingMachineV3",
    governance,
    deployer,
  )
}

export default func

func.tags = ["TransferVendingMachineV3Ownership"]
func.dependencies = ["VendingMachineV3"]
func.runAtTheEnd = true
