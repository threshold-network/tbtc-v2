import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, helpers } = hre
  const { deployer, governance } = await getNamedAccounts()

  const Bank = await deployments.get("Bank")
  const TBTCVault = await deployments.get("TBTCVault")
  const Bridge = await deployments.get("Bridge")

  const reservationVault = await deployments.deploy("ReservationVault", {
    from: deployer,
    args: [Bank.address, TBTCVault.address, Bridge.address],
    log: true,
    waitConfirmations: 1,
  })

  // The vault administers the reservation fee schedule and the renewal
  // pause/block policy; that authority must not remain with the deployer.
  // The vault deploys with renewals paused, so the activation ceremony is
  // entirely in governance hands from here.
  await helpers.ownable.transferOwnership(
    "ReservationVault",
    governance,
    deployer
  )

  // NOTE: To activate reservations, governance must additionally:
  // 1. Stage and finalize the vault and reservation parameters through
  //    `BridgeGovernance.beginReservationParametersUpdate(...)` and
  //    `BridgeGovernance.finalizeReservationParametersUpdate()`,
  // 2. Optionally appoint a renewal guardian
  //    (`ReservationVault.setRenewalGuardian`),
  // 3. If renewals should start enabled, unpause them
  //    (`ReservationVault.unpauseRenewals`) — the vault deploys paused,
  // 4. As the final activation step, mark the fully configured vault as
  //    trusted: `BridgeGovernance.setVaultStatus(vault, true)`.
  // `unpauseRenewals` gates `extendCustody` only; it is not a global pause for
  // reserved deposit reveals. Vault trust is the safe activation boundary.
  // None of these actions are performed by this script.

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(reservationVault)
  }
}

export default func

func.tags = ["ReservationVault"]
func.dependencies = ["Bank", "TBTCVault"]
