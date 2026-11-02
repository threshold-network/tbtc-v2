import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  await helpers.ownable.transferOwnership(
    "ReservationVault",
    governance,
    deployer
  )
}

export default func

func.tags = ["ReservationVaultOwnership"]
func.dependencies = ["ReservationVault"]
func.runAtTheEnd = true
