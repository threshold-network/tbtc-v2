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
  await deployments.execute(
    "ReservationVault",
    { from: deployer, log: true, waitConfirmations: 1 },
    "transferOwnership",
    governance
  )

  // NOTE: To activate reservations, governance must additionally:
  // 1. Mark the vault as trusted: `Bridge.setVaultStatus(vault, true)`,
  // 2. Wire it as the reservation vault and set the parameters:
  //    `Bridge.updateReservationParameters(vault, ...)`,
  // 3. Optionally appoint a renewal guardian
  //    (`ReservationVault.setRenewalGuardian`),
  // 4. Unpause renewals (`ReservationVault.unpauseRenewals`) — the vault
  //    deploys with renewals paused.
  // None of these actions are performed by this script.

  if (hre.network.tags.etherscan) {
    await helpers.etherscan.verify(reservationVault)
  }
}

export default func

func.tags = ["ReservationVault"]
func.dependencies = ["Bank", "TBTCVault", "Bridge"]
