import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"

/**
 * 97_set_reservation_parameters.ts
 *
 * Wires the freshly deployed `ReservationVault` into the Bridge and marks it
 * as trusted. Pairs with 95 (`95_deploy_reservation_vault.ts`) and 96
 * (`96_transfer_reservation_vault_ownership.ts`).
 *
 * Per `step-05-f-g-build-brief.md` §PR-G, the activation sequence is:
 *
 *   1. `beginReservationCapsUpdate(perWalletCap, singleAmount, maxActive)`
 *      then `finalizeReservationCapsUpdate()` — MUST run first. This
 *      passes trivially because `reservationMaxTotalAmount` defaults to 0,
 *      so the relational check is `0 <= anything`. This is the
 *      setter-ordering hazard the bootstrap-ordering test in PR #B
 *      already exhibits.
 *
 *   2. `beginReservationParametersUpdate(...)` then
 *      `finalizeReservationParametersUpdate()` — wires the vault address
 *      into the Bridge (the reservationVault arg) and sets the rest of
 *      the reservation parameters. Total must fit under
 *      `maxActiveReservations * reservationMaxSingleAmount` set in step 1.
 *
 *   3. `setVaultStatus(vault, true)` via `BridgeGovernance` — marks the
 *      vault as trusted. Until this runs, deposits cannot be revealed
 *      with the vault.
 *
 * The `reservationVault` is set as the first argument of
 * `beginReservationParametersUpdate` — there is no separate
 * `setReservationVault` setter.
 *
 * Test-network shortcut: on test/hardhat/local networks where the
 * timelock is bypassed, this script may begin and finalize in the same
 * deploy run. On mainnet, this script begins only; a separate runbook
 * step finalizes after the timelock.
 *
 * The vault deploys with `redemptionsPaused == true` by design; this
 * script does NOT unpause. Unpause is a separate governance action
 * after the operator is ready to activate reservations live.
 */
const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, getNamedAccounts } = hre
  const { execute, get } = deployments
  const { deployer } = await getNamedAccounts()

  const ReservationVault = await get("ReservationVault")
  const BridgeGovernance = await get("BridgeGovernance")

  // ----- Step 1: begin/finalize updateReservationCaps --------------------
  // Settle the setter-ordering hazard. Reservation.sol defaults
  // `reservationMaxTotalAmount` to 0, so the relational check in the
  // finalizer passes trivially.
  deployments.log("[1/3] begin/finalize updateReservationCaps")
  await execute(
    "BridgeGovernance",
    { from: deployer, log: true, waitConfirmations: 1 },
    "beginReservationCapsUpdate",
    // values per agent-docs/inventory/reservation-parameters.md
    ethers.BigNumber.from("1000000"), // maxReservationsAmountPerWallet
    ethers.BigNumber.from("100000"), // reservationMaxSingleAmount
    ethers.BigNumber.from("100") // maxActiveReservations
  )
  await execute(
    "BridgeGovernance",
    { from: deployer, log: true, waitConfirmations: 1 },
    "finalizeReservationCapsUpdate"
  )

  // ----- Step 2: begin/finalize updateReservationParameters --------------
  // `reservationVault` (the first arg) is set here — no separate
  // `setReservationVault` setter exists. Total must fit under the
  // `maxActiveReservations * reservationMaxSingleAmount` product set in
  // step 1 (100 * 100000 = 10_000_000).
  deployments.log("[2/3] begin/finalize updateReservationParameters")
  await execute(
    "BridgeGovernance",
    { from: deployer, log: true, waitConfirmations: 1 },
    "beginReservationParametersUpdate",
    ReservationVault.address, // reservationVault
    ethers.BigNumber.from("10000"), // reservationMinAmount
    ethers.BigNumber.from("1000"), // reservationTxMaxFee
    ethers.BigNumber.from("7776000"), // reservationTermSeconds (90 days = MIN_RESERVATION_TERM)
    ethers.BigNumber.from("86400"), // reservationDissolutionDelay (1 day)
    ethers.BigNumber.from("10000000"), // reservationMaxTotalAmount
    ethers.BigNumber.from("5"), // maxReservationsPerWallet
    ethers.BigNumber.from("86400"), // reservationActionTimeout
    ethers.BigNumber.from("86400") // reservationRenewalWindowSeconds
  )
  await execute(
    "BridgeGovernance",
    { from: deployer, log: true, waitConfirmations: 1 },
    "finalizeReservationParametersUpdate"
  )

  // ----- Step 3: setVaultStatus true (activate the vault) ----------------
  // Final activation step. Until this runs, deposits cannot be revealed
  // with the vault.
  deployments.log("[3/3] Activating vault via setVaultStatus")
  await execute(
    "BridgeGovernance",
    { from: deployer, log: true, waitConfirmations: 1 },
    "setVaultStatus",
    ReservationVault.address,
    true
  )
}

export default func

func.tags = ["ReservationParameters", "ReservationVaultActivation"]
func.dependencies = [
  "ReservationVault",
  "ReservationVaultOwnership",
  "Bridge",
]

// Skip on mainnet until the timelock is reviewed for production use.
// This script is a deploy-time helper for test/development networks.
// Production activation runs through the governance timelock as separate
// runbook steps.
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name === "mainnet"
