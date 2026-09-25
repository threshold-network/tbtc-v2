import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import type { Contract, Event, EventFilter } from "ethers"

const DAY = 24 * 60 * 60

/**
 * One entry of the Bridge's reservation term table, as
 * `BridgeGovernance.beginReservationTermUpdate` takes it.
 */
export interface ReservationTermEntry {
  termId: number
  termSeconds: number
  custodyBps: number
  enabled: boolean
}

/**
 * The ruled reservation term entries, in the order they are added. The
 * 365-day entry goes first: the Bridge's setter requires, on every addition,
 * the largest entry plus `DEPOSIT_REFUND_SAFETY_MARGIN` (24 h) to cover
 * `depositRevealAheadPeriod`, which a 30- or 91-day entry added alone does
 * not at the live 150-day period.
 */
export const RESERVATION_TERM_ENTRIES: readonly ReservationTermEntry[] = [
  { termId: 1, termSeconds: 365 * DAY, custodyBps: 20, enabled: true },
  { termId: 2, termSeconds: 30 * DAY, custodyBps: 2, enabled: true },
  { termId: 3, termSeconds: 91 * DAY, custodyBps: 5, enabled: true },
]

// eth_getLogs block ranges are capped by most RPC providers, so the scan for
// a staged term entry is chunked and its lookback bounded, on the same
// pattern and bounds as `14_set_deposit_parameters.ts`.
const EVENT_QUERY_CHUNK_BLOCKS = 2000
const FALLBACK_LOOKBACK_BLOCKS = 200_000

async function queryEventsInChunks(
  contract: Contract,
  filter: EventFilter,
  fromBlock: number,
  toBlock: number
): Promise<Event[]> {
  const events: Event[] = []
  for (
    let chunkStart = fromBlock;
    chunkStart <= toBlock;
    chunkStart += EVENT_QUERY_CHUNK_BLOCKS
  ) {
    // eslint-disable-next-line no-await-in-loop
    const chunkEvents = await contract.queryFilter(
      filter,
      chunkStart,
      Math.min(chunkStart + EVENT_QUERY_CHUNK_BLOCKS - 1, toBlock)
    )
    events.push(...chunkEvents)
  }
  return events
}

function isLaterEvent(a: Event, b: Event | undefined): boolean {
  return (
    !b ||
    a.blockNumber > b.blockNumber ||
    (a.blockNumber === b.blockNumber && (a.logIndex ?? 0) > (b.logIndex ?? 0))
  )
}

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
 *   4. `beginReservationTermUpdate(...)` then
 *      `finalizeReservationTermUpdate()` for each missing entry of
 *      `RESERVATION_TERM_ENTRIES`, in order. BridgeGovernance stages one
 *      entry at a time, so each entry takes its own begin/finalize cycle.
 *      Until an entry exists, no acceptance request can name a term.
 *
 * The `reservationVault` is set as the first argument of
 * `beginReservationParametersUpdate` — there is no separate
 * `setReservationVault` setter.
 *
 * Test-network shortcut: on local development networks (hardhat,
 * localhost, development, system_tests) where the timelock is bypassed,
 * this script may begin and finalize in the same deploy run. On live
 * non-mainnet networks (e.g. sepolia) this script runs the `begin*`
 * steps only; the `finalize*` steps must be executed separately after
 * the governance delay elapses (60s on sepolia, 48h on mainnet). The term
 * table (step 4) is the exception: each run there reads the table and the
 * staged entry, finalizes a staged entry that is past its delay, and begins
 * the next missing one, so the script is re-run until all entries exist.
 * Mainnet is skipped entirely via `func.skip` until the timelock is
 * reviewed for production use.
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
    const governanceDelay = await read(
      "BridgeGovernance",
      "governanceDelays",
      0
    )
    await helpers.time.increaseTime(governanceDelay.toNumber() + 1)
  }

  // ----- Step 1: begin/finalize updateReservationCaps --------------------
  // Settle the setter-ordering hazard. Reservation.sol defaults
  // `reservationMaxTotalAmount` to 0, so the relational check in the
  // finalizer passes trivially.
  deployments.log("[1/4] beginReservationCapsUpdate")
  await execute(
    "BridgeGovernance",
    { from: governance, log: true, waitConfirmations: 1 },
    "beginReservationCapsUpdate",
    // NOTE: these local/test values (maxReservationsAmountPerWallet=1e6,
    // maxActiveReservations=100) are an intentional divergence from the
    // M1-decided mainnet launch values that
    // 98_generate_reservation_mainnet_calldata.ts hard-enforces
    // (maxReservationsPerWallet must be exactly 1; maxActiveReservations
    // must not exceed the live-wallet floor). Larger local/test values give
    // more throughput for exercising the reservation flow in tests and are
    // deliberately NOT meant to mirror the mainnet configuration.
    // values per agent-docs/inventory/reservation-parameters.md
    ethers.BigNumber.from("1000000"), // maxReservationsAmountPerWallet
    ethers.BigNumber.from("100000"), // reservationMaxSingleAmount
    ethers.BigNumber.from("100") // maxActiveReservations
  )
  if (isLocalNetwork) {
    await passGovernanceDelay()
    await execute(
      "BridgeGovernance",
      { from: governance, log: true, waitConfirmations: 1 },
      "finalizeReservationCapsUpdate"
    )
  } else {
    const delay = await read("BridgeGovernance", "governanceDelays", 0)
    deployments.log(
      `[PENDING FINALIZE] Network: ${network.name} | Function: finalizeReservationCapsUpdate | ` +
        `Args: () | Governance delay: ${delay.toString()}s | ` +
        "Run separately after delay elapses"
    )
  }

  // ----- Step 2: begin/finalize updateReservationParameters --------------
  // `reservationVault` (the first arg) is set here — no separate
  // `setReservationVault` setter exists. Total must fit under the
  // `maxActiveReservations * reservationMaxSingleAmount` product set in
  // step 1 (100 * 100000 = 10_000_000).
  deployments.log("[2/4] beginReservationParametersUpdate")
  await execute(
    "BridgeGovernance",
    { from: governance, log: true, waitConfirmations: 1 },
    "beginReservationParametersUpdate",
    ReservationVault.address, // reservationVault
    ethers.BigNumber.from("10000"), // reservationMinAmount
    ethers.BigNumber.from("1000"), // reservationTxMaxFee
    ethers.BigNumber.from("7776000"), // reservationTermSeconds (90 days, above the 30-day MIN_RESERVATION_TERM)
    ethers.BigNumber.from("86400"), // reservationDissolutionDelay (1 day)
    ethers.BigNumber.from("10000000"), // reservationMaxTotalAmount
    // NOTE: 5, not the mainnet-required 1 (see the divergence note above
    // Step 1) -- deliberately larger for local/test throughput.
    ethers.BigNumber.from("5"), // maxReservationsPerWallet
    ethers.BigNumber.from("86400"), // reservationActionTimeout
    ethers.BigNumber.from("86400") // reservationRenewalWindowSeconds
  )
  if (isLocalNetwork) {
    await passGovernanceDelay()
    await execute(
      "BridgeGovernance",
      { from: governance, log: true, waitConfirmations: 1 },
      "finalizeReservationParametersUpdate"
    )
  } else {
    const delay = await read("BridgeGovernance", "governanceDelays", 0)
    deployments.log(
      `[PENDING FINALIZE] Network: ${network.name} | Function: finalizeReservationParametersUpdate | ` +
        `Args: () | Governance delay: ${delay.toString()}s | ` +
        "Run separately after delay elapses (do not run before " +
        "finalizeReservationCapsUpdate has been executed and confirmed " +
        "on-chain -- finalizing parameters before caps reverts on-chain)"
    )
  }

  // ----- Step 3: setVaultStatus true (activate the vault) ----------------
  // Final activation step. Until this runs, deposits cannot be revealed
  // with the vault. This MUST NOT run before Step 2's finalize has
  // actually executed on-chain (reservationVault wired into the Bridge) —
  // otherwise the vault is marked trusted while `reservationVault` is
  // still the zero address, letting deposits routed to the vault be
  // revealed as ordinary (non-reserved) deposits. Step 2's finalize only
  // runs synchronously here on local networks; on live non-mainnet
  // networks it is deferred, so this step must be deferred too.
  if (isLocalNetwork) {
    deployments.log("[3/4] Activating vault via setVaultStatus")
    await execute(
      "BridgeGovernance",
      { from: governance, log: true, waitConfirmations: 1 },
      "setVaultStatus",
      ReservationVault.address,
      true
    )
  } else {
    deployments.log(
      `[PENDING ACTIVATION] Network: ${network.name} | Function: setVaultStatus | ` +
        `Args: (${ReservationVault.address}, true) | ` +
        "Run separately after finalizeReservationParametersUpdate has been executed " +
        "and confirmed on-chain (do not activate while reservationVault is still zero)"
    )
  }

  // ----- Step 4: seed the reservation term table -------------------------
  // Router functions are reached through `Bridge.fallback()`, so the router
  // ABI is bound to the Bridge address.
  deployments.log("[4/4] Seeding the reservation term table")
  const Bridge = await get("Bridge")
  const reservationRouter = await ethers.getContractAt(
    "ReservationRouter",
    Bridge.address
  )

  // An entry is never rewritten, so an id already holding other values
  // cannot be corrected by this script and must stop it.
  const missingEntries: ReservationTermEntry[] = []
  // eslint-disable-next-line no-restricted-syntax
  for (const entry of RESERVATION_TERM_ENTRIES) {
    // eslint-disable-next-line no-await-in-loop
    const stored = await reservationRouter.reservationTerm(entry.termId)
    if (stored.termSeconds === 0) {
      missingEntries.push(entry)
    } else if (
      stored.termSeconds !== entry.termSeconds ||
      stored.custodyBps !== entry.custodyBps ||
      stored.enabled !== entry.enabled
    ) {
      throw new Error(
        `Reservation term ${entry.termId} holds (${stored.termSeconds}, ` +
          `${stored.custodyBps}, ${stored.enabled}), expected ` +
          `(${entry.termSeconds}, ${entry.custodyBps}, ${entry.enabled})`
      )
    }
  }

  const beginReservationTermUpdate = (entry: ReservationTermEntry) =>
    execute(
      "BridgeGovernance",
      { from: governance, log: true, waitConfirmations: 1 },
      "beginReservationTermUpdate",
      entry.termId,
      entry.termSeconds,
      entry.custodyBps,
      entry.enabled
    )
  const finalizeReservationTermUpdate = () =>
    execute(
      "BridgeGovernance",
      { from: governance, log: true, waitConfirmations: 1 },
      "finalizeReservationTermUpdate"
    )

  if (isLocalNetwork) {
    // eslint-disable-next-line no-restricted-syntax
    for (const entry of missingEntries) {
      // eslint-disable-next-line no-await-in-loop
      await beginReservationTermUpdate(entry)
      // eslint-disable-next-line no-await-in-loop
      await passGovernanceDelay()
      // eslint-disable-next-line no-await-in-loop
      await finalizeReservationTermUpdate()
    }
    return
  }

  if (missingEntries.length === 0) {
    deployments.log("Reservation term table already holds every entry")
    return
  }

  // BridgeGovernance keeps the staged entry `internal`, so it is found from
  // events: the last `ReservationTermUpdateStarted` is staged unless a
  // `ReservationTermUpdateFinalized` follows it (finalize clears the slot).
  // Externally-deployed artifacts lack a receipt; the fallback lookback is
  // the bound in that case.
  const bridgeGovernanceContract = await ethers.getContractAt(
    "BridgeGovernance",
    BridgeGovernance.address
  )
  const latestBlockNumber = await ethers.provider.getBlockNumber()
  const fromBlock = Math.max(
    BridgeGovernance.receipt?.blockNumber ?? 0,
    latestBlockNumber - FALLBACK_LOOKBACK_BLOCKS,
    0
  )
  const startedEvents = await queryEventsInChunks(
    bridgeGovernanceContract,
    bridgeGovernanceContract.filters.ReservationTermUpdateStarted(),
    fromBlock,
    latestBlockNumber
  )
  const finalizedEvents = await queryEventsInChunks(
    bridgeGovernanceContract,
    bridgeGovernanceContract.filters.ReservationTermUpdateFinalized(),
    fromBlock,
    latestBlockNumber
  )
  const lastStarted = startedEvents[startedEvents.length - 1]
  const lastFinalized = finalizedEvents[finalizedEvents.length - 1]
  const delay = await read("BridgeGovernance", "governanceDelays", 0)

  let nextEntries = missingEntries
  if (lastStarted && isLaterEvent(lastStarted, lastFinalized)) {
    const [
      stagedId,
      stagedSeconds,
      stagedCustodyBps,
      stagedEnabled,
      startedAt,
    ] = lastStarted.args ?? []
    const [expected] = missingEntries
    // Only the next entry in order may be finalized: a shorter entry
    // finalized first can break the reveal-ahead relation, and a staged
    // entry this script did not stage is left for the owner to resolve.
    if (
      stagedId !== expected.termId ||
      stagedSeconds !== expected.termSeconds ||
      stagedCustodyBps !== expected.custodyBps ||
      stagedEnabled !== expected.enabled
    ) {
      throw new Error(
        `Staged reservation term entry (${stagedId}, ${stagedSeconds}, ` +
          `${stagedCustodyBps}, ${stagedEnabled}) is not the next missing ` +
          `entry (${expected.termId}, ${expected.termSeconds}, ` +
          `${expected.custodyBps}, ${expected.enabled}); resolve it before ` +
          "re-running"
      )
    }

    const readyAt = startedAt.add(delay)
    const { timestamp: now } = await ethers.provider.getBlock("latest")
    if (readyAt.gt(now)) {
      deployments.log(
        `[PENDING FINALIZE] Network: ${network.name} | Function: finalizeReservationTermUpdate | ` +
          `Staged term ${expected.termId} | ` +
          `Ready at: ${readyAt.toString()} | Re-run this script after that time`
      )
      return
    }

    await finalizeReservationTermUpdate()
    nextEntries = missingEntries.slice(1)
  }

  if (nextEntries.length === 0) {
    deployments.log("Reservation term table now holds every entry")
    return
  }

  const [next] = nextEntries
  await beginReservationTermUpdate(next)
  deployments.log(
    `[PENDING FINALIZE] Network: ${network.name} | Function: finalizeReservationTermUpdate | ` +
      `Staged term ${next.termId} | Governance delay: ${delay.toString()}s | ` +
      `Re-run this script after the delay; ${nextEntries.length - 1} ` +
      "more entries follow"
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
