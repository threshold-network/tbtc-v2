import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function transferVendingMachineV2Ownership(hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, helpers } = hre
  const { deployer, v1Redeemer } = await getNamedAccounts()

  await helpers.ownable.transferOwnership(
    "VendingMachineV2",
    v1Redeemer,
    deployer,
  )
}

export default func

func.tags = ["TransferVendingMachineV2Ownership"]
func.dependencies = ["VendingMachineV2"]
func.runAtTheEnd = true
