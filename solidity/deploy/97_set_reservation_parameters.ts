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
  const { deployments, ethers, getNamedAccounts, helpers, network } = hre
  const { execute, get, read } = deployments
  const { governance } = await getNamedAccounts()

  const ReservationVault = await get("ReservationVault")
  const BridgeGovernance = await get("BridgeGovernance")

  // `BridgeGovernance` is deployed with a 48-hour delay on every network
  // except Sepolia, so a begin/finalize pair cannot complete in one run
  // without moving the chain clock. Local development chains can, so this
  // script keeps its documented "begin and finalize in the same deploy run"
  // behaviour there. On live networks the finalizers are the operator's job
  // after the delay elapses, and `func.skip` below already excludes mainnet.
  const localNetworks = ["hardhat", "localhost", "development", "system_tests"]
  const isLocalNetwork = localNetworks.includes(network.name)

  const passGovernanceDelay = async () => {
    if (!isLocalNetwork) {
      return
    }
    const governanceDelay = await read("BridgeGovernance", "governanceDelays", 0)
    await helpers.time.increaseTime(governanceDelay.toNumber() + 1)
  }

  // ----- Step 1: begin/finalize updateReservationCaps --------------------
  // Settle the setter-ordering hazard. Reservation.sol defaults
  // `reservationMaxTotalAmount` to 0, so the relational check in the
  // finalizer passes trivially.
  deployments.log("[1/3] begin/finalize updateReservationCaps")
  await execute(
    "BridgeGovernance",
    { from: governance, log: true, waitConfirmations: 1 },
    "beginReservationCapsUpdate",
    // values per agent-docs/inventory/reservation-parameters.md
    ethers.BigNumber.from("1000000"), // maxReservationsAmountPerWallet
    ethers.BigNumber.from("100000"), // reservationMaxSingleAmount
    ethers.BigNumber.from("100") // maxActiveReservations
  )
  await passGovernanceDelay()
  await execute(
    "BridgeGovernance",
    { from: governance, log: true, waitConfirmations: 1 },
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
    { from: governance, log: true, waitConfirmations: 1 },
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
  await passGovernanceDelay()
  await execute(
    "BridgeGovernance",
    { from: governance, log: true, waitConfirmations: 1 },
    "finalizeReservationParametersUpdate"
  )

  // ----- Step 3: setVaultStatus true (activate the vault) ----------------
  // Final activation step. Until this runs, deposits cannot be revealed
  // with the vault.
  deployments.log("[3/3] Activating vault via setVaultStatus")
  await execute(
    "BridgeGovernance",
    { from: governance, log: true, waitConfirmations: 1 },
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
  // Every reservation setter below is a router selector reached through
  // `Bridge.fallback()`; without a router set the fallback reverts.
  "ReservationRouter",
  // `BridgeGovernance`'s governance-gated setters call into Bridge, which
  // checks `onlyGovernance` (Bridge.governance == msg.sender). Bridge's
  // own governance is only handed to BridgeGovernance by
  // `21_transfer_bridge_governance.ts`, which is `runAtTheEnd = true` and
  // therefore always runs after every non-`runAtTheEnd` script regardless
  // of numeric filename order (hardhat-deploy buckets `runAtTheEnd`
  // scripts into a separate batch that always runs last). Without this
  // script also being `runAtTheEnd` (below) and depending on that tag,
  // every governance-gated call here reverts with "Caller is not the
  // governance" on every network, not just tests — found 2026-08-26.
  "TransferBridgeGovernance",
  // `BridgeGovernance` itself is `Ownable`; ownership transfers from
  // `deployer` to `governance` in `22_transfer_bridge_governance_ownership.ts`
  // (also `runAtTheEnd`, and by filename order it registers before this
  // script within the end batch). Every `execute` call below signs as
  // `governance`, matching the post-transfer owner — found 2026-08-26.
  "BridgeGovernanceOwnership",
]

// Must run after `TransferBridgeGovernance` (see the dependency comment
// above); `runAtTheEnd` scripts respect their own dependency graph within
// the end batch, so this still executes after Bridge's governance is
// handed to BridgeGovernance and before nothing else depends on it.
func.runAtTheEnd = true

// Skip on mainnet until the timelock is reviewed for production use.
// This script is a deploy-time helper for test/development networks.
// Production activation runs through the governance timelock as separate
// runbook steps.
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> =>
  hre.network.name === "mainnet"
