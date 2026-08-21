import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deployer } = await getNamedAccounts()

  const Bank = await deployments.get("Bank")
  const TBTCVault = await deployments.get("TBTCVault")
  const Bridge = await deployments.get("Bridge")

  const reservationVault = await deployments.deploy("ReservationVault", {
    from: deployer,
    args: [Bank.address, TBTCVault.address, Bridge.address],
    log: true,
    waitConfirmations: 1,
  })

  // NOTE: To activate reservations, the following must happen (none of it
  // performed by this script):
  // 0. The reservation router must be wired into the Bridge. A fresh Bridge
  //    deployment wires it directly (see `06_deploy_bridge.ts`, while the
  //    deployer still holds governance). An already-deployed,
  //    governance-transferred Bridge has no such reachable path -- it must
  //    be wired atomically with the implementation upgrade that ships the
  //    router, via `ProxyAdmin.upgradeAndCall` calling
  //    `Bridge.initializeV6_SetReservationRouter(routerAddress)`.
  // 1. While the vault remains untrusted, stage and finalize the reservation
  //    vault and parameters through `BridgeGovernance`,
  // 2. As the final activation step, mark the vault as trusted through
  //    `BridgeGovernance.setVaultStatus(vault, true)`.

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(reservationVault)
  }
}

export default func

func.tags = ["ReservationVault"]
func.dependencies = ["Bank", "TBTCVault", "Bridge"]
