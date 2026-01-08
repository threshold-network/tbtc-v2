import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async function transferVendingMachineRoles(
  hre: HardhatRuntimeEnvironment
) {
  const { getNamedAccounts, helpers, deployments } = hre
  const { execute, log } = deployments
  const { deployer, keepTechnicalWalletTeam, keepCommunityMultiSig } =
    await getNamedAccounts()

  log(
    `transferring vendingMachineUpgradeInitiator role to ${keepTechnicalWalletTeam}`
  )

  await execute(
    "VendingMachine",
    { from: deployer, log: true, waitConfirmations: 1 },
    "transferVendingMachineUpgradeInitiatorRole",
    keepTechnicalWalletTeam
  )

  log(
    `transferring unmintFeeUpdateInitiator role to ${keepTechnicalWalletTeam}`
  )

  await execute(
    "VendingMachine",
    { from: deployer, log: true, waitConfirmations: 1 },
    "transferUnmintFeeUpdateInitiatorRole",
    keepTechnicalWalletTeam
  )

  await helpers.ownable.transferOwnership(
    "VendingMachine",
    keepCommunityMultiSig,
    deployer
  )
}

export default func

func.tags = ["TransferVendingMachineRoles"]
func.dependencies = ["TBTC", "VendingMachine"]
func.runAtTheEnd = true
