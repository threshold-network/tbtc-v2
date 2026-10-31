/* eslint-disable no-console -- this script's output is the calldata and the review report for the Safe transactions */
import fs from "fs"
import path from "path"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { getAddress, Interface, ZeroAddress } from "ethers"
import {
  artifactLinkSites,
  bridgeRuntimeWithLibraries,
  LinkSite,
} from "./99_deploy_rebate_staking_reservation_implementation"

// Known mainnet Timelock Controller address. Owner of the ProxyAdmin,
// used for scheduling and executing proxy upgrades with a 24h delay. This
// is unrelated to the reservation bootstrap actions below -- all of them
// target BridgeGovernance, not the ProxyAdmin -- but is validated on-chain
// against the ProxyAdmin's actual owner() so a rotated address is caught
// before it ends up stale in operator-facing documentation.
export const KNOWN_TIMELOCK = "0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D"

// Known mainnet Council Safe (6/9 multisig). Proposer and executor on the
// Timelock, and owner of BridgeGovernance -- the actual submitter of every
// action generated below. Validated on-chain against BridgeGovernance's
// actual owner() before any calldata is generated.
export const KNOWN_COUNCIL_SAFE = "0x9F6e831c8F8939DC0C830C6e492e7cEf4f9C2F5f"

// EIP-1967 transparent proxy admin storage slot. Defined by the standard
// at https://eips.ethereum.org/EIPS/eip-1967#admin-address and used to
// discover the ProxyAdmin address from the Bridge proxy so its owner()
// can be checked against KNOWN_TIMELOCK.
const EIP_1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

// On-chain protocol bounds mirrored from Reservation.sol so a bad env
// value fails fast in this script rather than reverting on-chain at
// finalize -- up to 48h after the begin calldata this script generates is
// submitted and staged.
const MIN_RESERVATION_TERM = 7_776_000 // 90 days
const MAX_RESERVATION_TERM = 63_072_000 // 730 days
// Mirrored from WalletProposalValidatorConstants.REQUEST_TIMEOUT_SAFETY_MARGIN
// and DEPOSIT_MIN_AGE.
const REQUEST_TIMEOUT_SAFETY_MARGIN = 7_200 // 2 hours
const DEPOSIT_MIN_AGE = 7_200 // 2 hours
// Mirrored from WalletProposalValidatorConstants.DEPOSIT_REFUND_SAFETY_MARGIN;
// Deposit.sol caps a reserved deposit's refund locktime at the reveal time
// plus the reservation term plus this margin.
const DEPOSIT_REFUND_SAFETY_MARGIN = 86_400 // 24 hours
// Clock drift between the mined head and the reveal block in Deposit.sol's
// refund-deadline checks.
const REVEAL_DRIFT_SECONDS = 7_200 // 2 hours
// Margin subtracted from the reveal window so the guard only passes terms
// with a strictly positive window.
const REVEAL_FEASIBILITY_MARGIN_SECONDS = 3_600 // 1 hour

// Deploy-script guard, mirroring the on-chain bound. The Bridge now caps
// `reservationDissolutionDelay` at
// `Reservation.MAX_RESERVATION_DISSOLUTION_DELAY` (730 days) in both
// `Reservation.updateReservationParameters` and
// `BridgeGovernance.beginReservationParametersUpdate`, so an over-long delay
// would revert on-chain at finalize -- up to 48h after the begin calldata
// this script generates is submitted and staged. This script refuses it
// first, so the operator learns before signing.
//
// The zero-delay rule below stays a deploy-script policy: the chain imposes
// no minimum on the delay, because a zero delay is a valid governance
// choice (the position becomes strand-eligible as soon as its term
// expires). The script still refuses it, because a zero delay makes every
// position releasable the moment its term expires.
const SCRIPT_POLICY_MAX_DISSOLUTION_DELAY = 63_072_000 // 730 days

/**
 * The number of simultaneously open positions the fleet can actually hold,
 * as the on-chain hand-off reserve gate sees it.
 *
 * `Reservation.reserveAcceptanceCapacity` reverts an acceptance with
 * "Hand-off reserve exceeded" unless the active position count -- after the
 * acceptance being reserved -- is at most
 *
 *     max(0, liveWalletsCount - handoffReserveWallets) * maxReservationsPerWallet
 *
 * because that many Live wallets must stay free to retire together while
 * every open position still fits on the remaining ones. This is therefore
 * the real fleet-fit ceiling, strictly below the naive
 * `liveWalletsCount * maxReservationsPerWallet`, and a `maxActiveReservations`
 * above it is unreachable: the acceptance reverts instead of the position
 * being opened.
 */
export function handoffAwareSlotCapacity(params: {
  liveWalletsCount: number
  handoffReserveWallets: number
  maxReservationsPerWallet: number
}): number {
  const remainingWallets =
    params.liveWalletsCount > params.handoffReserveWallets
      ? params.liveWalletsCount - params.handoffReserveWallets
      : 0
  return remainingWallets * params.maxReservationsPerWallet
}

/**
 * Throws when the chosen dissolution delay is outside this script's own
 * policy band. The maximum mirrors the on-chain
 * `Reservation.MAX_RESERVATION_DISSOLUTION_DELAY` bound, so this guard
 * catches an operator typo before the calldata is signed instead of
 * letting it revert on-chain at finalize.
 *
 * A delay of zero makes a position releasable the instant its term
 * expires; a delay beyond the maximum pins positions for longer than any
 * term the Bridge would accept.
 */
export function assertDissolutionDelayWithinScriptPolicy(
  dissolutionDelay: number
): void {
  if (dissolutionDelay <= 0) {
    throw new Error(
      `RESERVATION_DISSOLUTION_DELAY_SECONDS (${dissolutionDelay}) must be ` +
        "greater than zero (deploy-script policy: a zero delay makes every " +
        "position releasable the moment its term expires; the Bridge " +
        "itself imposes no minimum on this value)"
    )
  }
  if (dissolutionDelay > SCRIPT_POLICY_MAX_DISSOLUTION_DELAY) {
    throw new Error(
      `RESERVATION_DISSOLUTION_DELAY_SECONDS (${dissolutionDelay}) exceeds ` +
        `this script's maximum dissolution delay ` +
        `(${SCRIPT_POLICY_MAX_DISSOLUTION_DELAY}s / 730 days) (deploy-script ` +
        "guard mirroring the on-chain MAX_RESERVATION_DISSOLUTION_DELAY " +
        "bound; the Bridge rejects this value too)"
    )
  }
}

/**
 * Throws when the chosen global position cap exceeds the number of
 * positions the fleet can actually hold once the on-chain hand-off reserve
 * gate is taken into account.
 */
export function assertHandoffAwareFleetFit(params: {
  maxActive: number
  liveWalletsCount: number
  handoffReserveWallets: number
  maxReservationsPerWallet: number
}): void {
  const capacity = handoffAwareSlotCapacity(params)
  if (params.maxActive > capacity) {
    throw new Error(
      `RESERVATION_MAX_ACTIVE (${params.maxActive}) exceeds the hand-off ` +
        "reserve-aware slot capacity " +
        `(max(0, liveWalletsCount=${params.liveWalletsCount} - ` +
        `handoffReserveWallets=${params.handoffReserveWallets}) * ` +
        `maxReservationsPerWallet=${params.maxReservationsPerWallet} = ` +
        `${capacity}); the on-chain hand-off reserve gate in ` +
        "`Reservation.reserveAcceptanceCapacity` reverts such an acceptance " +
        "with 'Hand-off reserve exceeded', so this cap could never be " +
        "reached. Lower RESERVATION_MAX_ACTIVE, lower " +
        "RESERVATION_HANDOFF_RESERVE_WALLETS, or register more Live wallets."
    )
  }
}

/**
 * Throws when the reservation parameters, combined with the Bridge's live
 * deposit parameters, would leave no reserved deposit possible. Nothing
 * on-chain checks this, because the two rules live in different parameter
 * sets:
 *  - Deposit.revealDeposit requires
 *      now + depositRevealAheadPeriod <= refundDeadline
 *        <= now + reservationTermSeconds + DEPOSIT_REFUND_SAFETY_MARGIN,
 *    which is an empty window when the reveal-ahead period is longer than
 *    the term plus the margin;
 *  - every reveal carries at least depositDustThreshold, so a non-zero
 *    amount cap below it rejects every reservation.
 * Either case would activate a vault that can never hold a reservation.
 */
export function assertReservedDepositsFeasible(params: {
  depositDustThreshold: bigint
  depositRevealAheadPeriod: number
  termSeconds: number
  singleAmountCap: bigint
  perWalletCap: bigint
  maxTotalAmount: bigint
}): void {
  const { depositDustThreshold, depositRevealAheadPeriod, termSeconds } = params
  if (
    depositRevealAheadPeriod > 0 &&
    depositRevealAheadPeriod > termSeconds + DEPOSIT_REFUND_SAFETY_MARGIN
  ) {
    throw new Error(
      `The Bridge's depositRevealAheadPeriod (${depositRevealAheadPeriod}s) ` +
        `exceeds RESERVATION_TERM_SECONDS (${termSeconds}s) plus the ` +
        `${DEPOSIT_REFUND_SAFETY_MARGIN}s refund safety margin, so no ` +
        "reserved deposit could ever be revealed. Raise " +
        "RESERVATION_TERM_SECONDS to at least " +
        `${depositRevealAheadPeriod - DEPOSIT_REFUND_SAFETY_MARGIN}s.`
    )
  }
  const amountCaps: Array<[string, bigint]> = [
    ["RESERVATION_SINGLE_AMOUNT_CAP_SATS", params.singleAmountCap],
    ["RESERVATION_PER_WALLET_CAP_SATS", params.perWalletCap],
    ["RESERVATION_MAX_TOTAL_AMOUNT_SATS", params.maxTotalAmount],
  ]
  amountCaps.forEach(([name, cap]) => {
    if (cap > BigInt(0) && cap < depositDustThreshold) {
      throw new Error(
        `${name} (${cap}) is below the Bridge's depositDustThreshold ` +
          `(${depositDustThreshold}): every reveal carries at least the ` +
          "dust threshold, so no reservation could fit under this cap."
      )
    }
  })
  console.log(
    `\nReserved-deposit feasibility OK: depositRevealAheadPeriod ` +
      `(${depositRevealAheadPeriod}s) fits the term plus margin, and every ` +
      `non-zero amount cap is at least depositDustThreshold (${depositDustThreshold})`
  )
}

/** A single governance action: an ABI method name plus its call args. */
interface ActionDefinition {
  method: string
  args: Array<string | number | bigint | boolean>
  label: string
  details: Record<string, string>
}

/** An `ActionDefinition` resolved to concrete calldata for a target contract. */
interface CalldataAction extends ActionDefinition {
  target: string
  targetName: string
  calldata: string
}

/**
 * Builds the full ordered list of reservation bootstrap governance actions,
 * from the one-off router wiring through to the final vault activation.
 * This is the single source of truth for the action set -- console output
 * and the JSON action-array output are both derived from it, rather than
 * each maintaining their own copy.
 *
 * Ordering is significant and encodes two independent constraints:
 *   1. setReservationRouter MUST run before any other reservation action --
 *      the Bridge's fallback() reverts with "Reservation router not set"
 *      while reservationRouter == address(0).
 *   2. finalizeReservationCapsUpdate MUST execute before
 *      finalizeReservationParametersUpdate (Decision 1's relational check
 *      in `Reservation.updateReservationParameters` reads the caps that
 *      `updateReservationCaps` owns). The three begin* calls carry no such
 *      ordering constraint among themselves -- only the finalize* calls do
 *      -- so they may be submitted as a single batch.
 * finalizeReservationCapsUpdate/finalizeReservationParametersUpdate/
 * setVaultStatus are each irreversible, point-of-no-return transactions:
 * once setVaultStatus(vault, true) executes, deposits can be revealed
 * against the vault.
 */
export function buildReservationActionDefinitions(params: {
  reservationRouter: string
  reservationVault: string
  perWalletCap: bigint
  singleAmountCap: bigint
  maxActive: number
  maxThirdPartyReanchorHolds: number
  handoffReserveWallets: number
  minAmount: bigint
  txMaxFee: bigint
  termSeconds: number
  dissolutionDelay: number
  maxTotalAmount: bigint
  maxReservationsPerWallet: number
  actionTimeout: number
  renewalWindowSeconds: number
}): ActionDefinition[] {
  return [
    {
      method: "setReservationRouter",
      args: [params.reservationRouter],
      label:
        "setReservationRouter (MUST be first - unblocks the Bridge fallback)",
      details: {
        "Reservation router": params.reservationRouter,
        "Governance delay": "None (one-off action)",
        Note: "Must be called BEFORE any other reservation governance action",
      },
    },
    {
      method: "beginReservationCapsUpdate",
      args: [
        params.perWalletCap,
        params.singleAmountCap,
        params.maxActive,
        params.maxThirdPartyReanchorHolds,
        params.handoffReserveWallets,
      ],
      label: "beginReservationCapsUpdate (stages the reservation caps update)",
      details: {
        "Max reservations amount per wallet": params.perWalletCap.toString(),
        "Max single amount": params.singleAmountCap.toString(),
        "Max active reservations": params.maxActive.toString(),
        "Max third-party re-anchor holds per target wallet":
          params.maxThirdPartyReanchorHolds.toString(),
        "Hand-off reserve wallets": params.handoffReserveWallets.toString(),
        "Governance delay": "172800s (48h)",
        Note:
          "Finalize order matters: finalizeReservationCapsUpdate must execute " +
          "before finalizeReservationParametersUpdate. Begin-call order does " +
          "not matter -- all three begin* calls may be batched together.",
      },
    },
    {
      method: "beginReservationParametersUpdate",
      args: [
        params.reservationVault,
        params.minAmount,
        params.txMaxFee,
        params.termSeconds,
        params.dissolutionDelay,
        params.maxTotalAmount,
        params.maxReservationsPerWallet,
        params.actionTimeout,
        params.renewalWindowSeconds,
      ],
      label:
        "beginReservationParametersUpdate (stages the reservation parameters update)",
      details: {
        "Reservation vault": params.reservationVault,
        "Min amount": params.minAmount.toString(),
        "Tx max fee": params.txMaxFee.toString(),
        "Term (seconds)": params.termSeconds.toString(),
        "Dissolution delay": params.dissolutionDelay.toString(),
        "Max total amount": params.maxTotalAmount.toString(),
        "Max reservations per wallet":
          params.maxReservationsPerWallet.toString(),
        "Action timeout": params.actionTimeout.toString(),
        "Renewal window": params.renewalWindowSeconds.toString(),
        "Governance delay": "172800s (48h)",
        Note:
          "Finalize order matters: must finalize AFTER " +
          "finalizeReservationCapsUpdate. Begin-call order does not matter.",
      },
    },
    {
      method: "finalizeReservationCapsUpdate",
      args: [],
      label:
        "finalizeReservationCapsUpdate (POINT OF NO RETURN - applies the staged caps update)",
      details: {
        Note:
          "MUST execute BEFORE finalizeReservationParametersUpdate -- " +
          "finalizing parameters before caps reverts on-chain (Decision 1's " +
          "relational check in Reservation.updateReservationParameters).",
      },
    },
    {
      method: "finalizeReservationParametersUpdate",
      args: [],
      label:
        "finalizeReservationParametersUpdate (POINT OF NO RETURN - wires the reservation vault into the Bridge)",
      details: {
        Note: "MUST execute AFTER finalizeReservationCapsUpdate.",
      },
    },
    {
      method: "setVaultStatus",
      args: [params.reservationVault, true],
      label:
        "setVaultStatus (POINT OF NO RETURN - marks the vault as trusted; deposits can now be revealed with it)",
      details: {
        Vault: params.reservationVault,
        Trusted: "true",
        Note:
          "MUST NOT execute before finalizeReservationParametersUpdate has " +
          "been confirmed on-chain -- otherwise the vault is marked trusted " +
          "while reservationVault is still the zero address, letting " +
          "deposits routed to the vault be revealed as ordinary " +
          "(non-reserved) deposits. Activation-ordering gate: also execute " +
          "at or after this network's keep-core activation block; see " +
          "solidity/docs/RESERVATION_CAPS_DEPLOYMENT.md, " +
          "'Client Activation Ordering Gate'.",
      },
    },
  ]
}

/** Logs a single resolved governance calldata action with consistent formatting. */
function logCalldataAction(action: CalldataAction): void {
  console.log(`\n  ${action.label}`)
  console.log(`    Target: ${action.targetName} (${action.target})`)
  console.log(`    Calldata: ${action.calldata}`)
  console.log(`    Selector: ${action.calldata.slice(0, 10)}`)
  Object.entries(action.details).forEach(([key, value]) => {
    console.log(`    ${key}: ${value}`)
  })
}

/** Prints all resolved calldata actions with a summary header/footer. */
function logCalldataSummary(actions: CalldataAction[]): void {
  console.log(`\n${"=".repeat(80)}`)
  console.log("RESERVATION BOOTSTRAP GOVERNANCE CALDATA (mainnet)")
  console.log("=".repeat(80))
  console.log(
    "Ordering: router FIRST; finalizeReservationCapsUpdate BEFORE " +
      "finalizeReservationParametersUpdate BEFORE setVaultStatus"
  )

  actions.forEach((action, index) => {
    console.log(`\n  [${index + 1}] ${action.label}`)
    console.log(`      Target: ${action.targetName} (${action.target})`)
    console.log(`      Selector: ${action.calldata.slice(0, 10)}`)
    Object.entries(action.details).forEach(([key, value]) => {
      console.log(`      ${key}: ${value}`)
    })
  })
  console.log(`\n${"=".repeat(80)}`)
  // All six actions above target BridgeGovernance, owned by the Council
  // Safe -- NOT the Timelock, which owns only the ProxyAdmin and is
  // unrelated to reservation governance. Routing through the Timelock
  // would make msg.sender the Timelock and revert on BridgeGovernance's
  // onlyOwner check.
  console.log(
    "Submit DIRECTLY via Council Safe -> BridgeGovernance.<method>() -- " +
      "every action above targets BridgeGovernance, owned by the Council " +
      "Safe. The Timelock is NOT part of this flow: it owns only the " +
      "ProxyAdmin and has an unrelated 24h delay."
  )
  console.log(
    "BridgeGovernance's own staging delay for begin*/finalize* pairs is " +
      "172800s (48h), read from governanceDelays(0); setReservationRouter " +
      "and setVaultStatus carry no staging delay (one-off actions)."
  )
  // Fee-reserve notice: none of the six actions above configures the
  // vault's fee reserve target; governance must run a separate
  // ReservationVault.updateFeeReserveTarget(target) step (or explicitly
  // accept a zero reserve) before activation; see
  // solidity/docs/RESERVATION_CAPS_DEPLOYMENT.md, "Fee-Reserve Target
  // Governance Step".
  console.log(
    "Fee-reserve notice: no action in this set configures the vault's " +
      "fee reserve target; governance must run " +
      "ReservationVault.updateFeeReserveTarget(target) as a separate " +
      "action before activation, or explicitly accept a zero reserve; " +
      "see solidity/docs/RESERVATION_CAPS_DEPLOYMENT.md, " +
      "'Fee-Reserve Target Governance Step'."
  )
  // Trust-revocation notice: after setVaultStatus(vault, false), every
  // acceptance settled while the vault is untrusted (on time or late)
  // settles by direct credit to the depositor with no initiation fee;
  // see solidity/docs/RESERVATION_CAPS_DEPLOYMENT.md, "Fee Fallback When
  // Vault Trust Is Revoked".
  console.log(
    "Trust-revocation notice: after setVaultStatus(vault, false), every " +
      "acceptance settled while the vault is untrusted (on time or late) " +
      "settles by direct credit to the depositor with no initiation fee; " +
      "see solidity/docs/RESERVATION_CAPS_DEPLOYMENT.md, " +
      "'Fee Fallback When Vault Trust Is Revoked'."
  )
  console.log("=".repeat(80))
}

/**
 * Reads a required environment variable as a BigInt. Throws if absent or
 * empty — this script generates real mainnet governance calldata, so no
 * numeric value may silently default to an example number.
 */
function requireEnvBigInt(name: string): bigint {
  const raw = process.env[name]
  if (raw === undefined || raw === "") {
    throw new Error(
      `Missing required env var ${name} - no default values are permitted for mainnet governance calldata`
    )
  }
  return BigInt(raw)
}

/** Reads a required environment variable as a Number (see `requireEnvBigInt`). */
function requireEnvNumber(name: string): number {
  return Number(requireEnvBigInt(name))
}

/**
 * The runtime a hardhat-deploy record describes, with its libraries linked in.
 *
 * A record stores the *unlinked* deployed bytecode: at every link site solc
 * left a `__$<34 hex chars>$__` placeholder, and the addresses the deployment
 * linked sit in the record's `libraries` map. Comparing that string against
 * `eth_getCode` compares placeholders with addresses, so it can only ever be
 * unequal, however correct the deployment is. The addresses have to be
 * substituted before anything is compared.
 *
 * The link sites come from the compiled artifact, because a record does not
 * carry them, so the artifact must be the build the record was written from.
 * A record from another build has different bytes and its placeholders are not
 * at the artifact's offsets; substituting there would compare against a
 * runtime nobody deployed, so the mismatch is reported instead.
 */
export function linkedRecordRuntime(params: {
  /** The record's name, for the error messages. */
  name: string
  /** The record's `deployedBytecode`, placeholders included, if it has one. */
  recordBytecode: string | undefined
  /** The compiled artifact's `deployedBytecode`, placeholders included. */
  artifactBytecode: string
  /** The artifact's `deployedLinkReferences`, as link sites. */
  linkSites: LinkSite[]
  /** The record's `libraries` map: library name to the address it linked. */
  libraries: Record<string, string>
}): string {
  const { name, recordBytecode, artifactBytecode, linkSites, libraries } =
    params
  if (
    typeof recordBytecode !== "string" ||
    typeof artifactBytecode !== "string"
  ) {
    throw new Error(
      `The ${name} runtime cannot be reconstructed: the record or the artifact carries no deployed bytecode.`
    )
  }
  if (recordBytecode.toLowerCase() !== artifactBytecode.toLowerCase()) {
    throw new Error(
      `The ${name} deployment record was written from a different build than ` +
        "the compiled artifact: their deployed bytecodes differ, so the " +
        "artifact's link sites do not describe the record's code. Recompile at " +
        "the recorded commit, or re-deploy, before generating calldata."
    )
  }
  const unlinked = linkSites
    .filter((site) => libraries[site.library] === undefined)
    .map((site) => site.library)
  if (unlinked.length > 0) {
    throw new Error(
      `The ${name} deployment record carries no linked address for ` +
        `${unlinked.join(", ")}, so its runtime cannot be reconstructed.`
    )
  }
  return bridgeRuntimeWithLibraries(recordBytecode, linkSites, libraries)
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, artifacts, ethers } = hre
  const { get, read } = deployments
  const { deployer } = await getNamedAccounts()

  console.log("=".repeat(80))
  console.log("Reservation Bootstrap Mainnet Calldata Generation")
  console.log("=".repeat(80))
  console.log(`Network: ${hre.network.name}`)
  console.log(`Deployer: ${deployer}`)

  // Only run on mainnet (or non-local networks with real governance)
  const isLocalNetwork = [
    "hardhat",
    "localhost",
    "development",
    "system_tests",
  ].includes(hre.network.name)
  if (isLocalNetwork) {
    console.log(
      "\nSkipping on local network - use 97_set_reservation_parameters.ts for test networks"
    )
    return
  }

  // Resolve existing contracts
  console.log("\n--- Resolving existing contracts ---")
  const Bridge = await get("Bridge")
  const BridgeGovernance = await get("BridgeGovernance")
  const ReservationVault = await get("ReservationVault")
  const ReservationRouter = await get("ReservationRouter")

  console.log(`  Bridge: ${Bridge.address}`)
  console.log(`  BridgeGovernance: ${BridgeGovernance.address}`)
  console.log(`  ReservationVault: ${ReservationVault.address}`)
  console.log(`  ReservationRouter: ${ReservationRouter.address}`)

  // --- Verify the hardcoded governance role addresses still hold their
  // documented roles on-chain, since neither is validated anywhere else in
  // this script or its siblings. Fails loudly on a mismatch rather than
  // silently carrying stale addresses into operator-facing documentation.
  console.log("\n--- Verifying governance role addresses on-chain ---")
  const adminSlotData = await ethers.provider.getStorage(
    Bridge.address,
    EIP_1967_ADMIN_SLOT
  )
  const proxyAdminAddress = getAddress(`0x${adminSlotData.slice(26)}`)
  const proxyAdmin = await ethers.getContractAt(
    ["function owner() view returns (address)"],
    proxyAdminAddress
  )
  const proxyAdminOwner: string = await proxyAdmin.owner()
  if (proxyAdminOwner.toLowerCase() !== KNOWN_TIMELOCK.toLowerCase()) {
    throw new Error(
      `ProxyAdmin (${proxyAdminAddress}) owner is ${proxyAdminOwner}, not ` +
        `the hardcoded KNOWN_TIMELOCK (${KNOWN_TIMELOCK}). The Timelock role ` +
        "may have rotated -- update KNOWN_TIMELOCK in this script before " +
        "proceeding."
    )
  }
  console.log(
    `  ProxyAdmin (${proxyAdminAddress}) owner matches KNOWN_TIMELOCK`
  )

  const bridgeGovernanceOwnerContract = await ethers.getContractAt(
    ["function owner() view returns (address)"],
    BridgeGovernance.address
  )
  const bridgeGovernanceOwner: string =
    await bridgeGovernanceOwnerContract.owner()
  if (
    bridgeGovernanceOwner.toLowerCase() !== KNOWN_COUNCIL_SAFE.toLowerCase()
  ) {
    throw new Error(
      `BridgeGovernance (${BridgeGovernance.address}) owner is ` +
        `${bridgeGovernanceOwner}, not the hardcoded KNOWN_COUNCIL_SAFE ` +
        `(${KNOWN_COUNCIL_SAFE}). Every action generated below is ` +
        "onlyOwner-gated -- update KNOWN_COUNCIL_SAFE in this script and " +
        "re-verify the correct submitter before using this calldata."
    )
  }
  console.log(
    `  BridgeGovernance (${BridgeGovernance.address}) owner matches KNOWN_COUNCIL_SAFE`
  )

  // --- Verify the reservation router on-chain before embedding its address
  // in calldata: setReservationRouter is write-once and reverts on a
  // second call, and the address itself must actually be live contract
  // code matching what was compiled, not a stale or wrong cache entry.
  console.log("\n--- Verifying reservation router on-chain state ---")
  const currentReservationRouter: string = await read(
    "Bridge",
    "getReservationRouter"
  )
  if (currentReservationRouter !== ZeroAddress) {
    throw new Error(
      "Bridge.getReservationRouter() is already set to " +
        `${currentReservationRouter}; setReservationRouter is write-once ` +
        "and a second call reverts on-chain. Refusing to generate " +
        "duplicate-set calldata."
    )
  }
  // The router is library-linked (`06a_deploy_reservation_router.ts` deploys
  // it with `Reservation` and `ReservationProofs`), so the record's
  // `deployedBytecode` carries link placeholders, not addresses. Link it with
  // the addresses the record says the deployment used, and compare that with
  // the code at the address.
  const routerArtifact = await artifacts.readArtifact("ReservationRouter")
  const expectedRouterRuntime = linkedRecordRuntime({
    name: "ReservationRouter",
    recordBytecode: ReservationRouter.deployedBytecode,
    artifactBytecode: routerArtifact.deployedBytecode,
    linkSites: artifactLinkSites(routerArtifact.deployedLinkReferences),
    libraries: ReservationRouter.libraries ?? {},
  })
  const routerOnChainCode = await ethers.provider.getCode(
    ReservationRouter.address
  )
  if (routerOnChainCode.toLowerCase() !== expectedRouterRuntime.toLowerCase()) {
    throw new Error(
      "On-chain bytecode at ReservationRouter address " +
        `${ReservationRouter.address} does not match the compiled ` +
        "artifact's deployed bytecode linked with the record's libraries " +
        `(${Object.entries(ReservationRouter.libraries ?? {})
          .map(([library, address]) => `${library}=${address}`)
          .join(", ")}); refusing to embed a mismatched address in mainnet ` +
        "governance calldata."
    )
  }
  console.log(
    "  Reservation router not yet set on Bridge (OK), and on-chain bytecode " +
      `at ${ReservationRouter.address} matches the compiled artifact`
  )

  // Configuration values for initial bootstrap. All satoshi-denominated
  // values below use 8 decimals (divide by 1e8 for BTC). This script
  // generates real mainnet governance calldata, so every value is a
  // required environment variable with NO numeric default — a missing
  // or malformed value must hard-fail rather than fall back to an
  // example number that could silently ship the wrong governance action.
  const PER_WALLET_CAP = requireEnvBigInt("RESERVATION_PER_WALLET_CAP_SATS")
  const SINGLE_AMOUNT_CAP = requireEnvBigInt(
    "RESERVATION_SINGLE_AMOUNT_CAP_SATS"
  )
  const MAX_ACTIVE = requireEnvNumber("RESERVATION_MAX_ACTIVE")
  const MAX_THIRD_PARTY_REANCHOR_HOLDS = requireEnvNumber(
    "RESERVATION_MAX_THIRD_PARTY_REANCHOR_HOLDS"
  )
  const RES_MIN_AMOUNT = requireEnvBigInt("RESERVATION_MIN_AMOUNT_SATS")
  const RES_TX_MAX_FEE = requireEnvBigInt("RESERVATION_TX_MAX_FEE_SATS")
  const RES_TERM_SECONDS = requireEnvNumber("RESERVATION_TERM_SECONDS")
  const RES_DISSOLUTION_DELAY = requireEnvNumber(
    "RESERVATION_DISSOLUTION_DELAY_SECONDS"
  )
  const RES_MAX_TOTAL_AMOUNT = requireEnvBigInt(
    "RESERVATION_MAX_TOTAL_AMOUNT_SATS"
  )
  const MAX_RESERVATIONS_PER_WALLET = requireEnvNumber(
    "RESERVATION_MAX_PER_WALLET"
  )
  const RES_ACTION_TIMEOUT = requireEnvNumber(
    "RESERVATION_ACTION_TIMEOUT_SECONDS"
  )
  const RES_RENEWAL_WINDOW = requireEnvNumber(
    "RESERVATION_RENEWAL_WINDOW_SECONDS"
  )
  const HANDOFF_RESERVE_WALLETS = requireEnvNumber(
    "RESERVATION_HANDOFF_RESERVE_WALLETS"
  )

  // Hard-fail the launch-posture invariants that are already decided,
  // rather than warning and letting the operator copy bad calldata into
  // a Safe transaction builder.
  if (MAX_RESERVATIONS_PER_WALLET !== 1) {
    throw new Error(
      "RESERVATION_MAX_PER_WALLET must be 1 (decided M1 launch value), got " +
        `${MAX_RESERVATIONS_PER_WALLET}`
    )
  }
  if (HANDOFF_RESERVE_WALLETS <= 0) {
    throw new Error(
      `RESERVATION_HANDOFF_RESERVE_WALLETS (${HANDOFF_RESERVE_WALLETS}) must ` +
        "be greater than zero (mirrors updateReservationCaps's 'Hand-off " +
        "reserve must be greater than zero' require)"
    )
  }
  // Deploy-script guard -- mirrors the on-chain MAX_RESERVATION_DISSOLUTION_DELAY
  // bound and catches an operator typo before the calldata is signed.
  assertDissolutionDelayWithinScriptPolicy(RES_DISSOLUTION_DELAY)
  if (RES_TERM_SECONDS < MIN_RESERVATION_TERM) {
    throw new Error(
      `RESERVATION_TERM_SECONDS (${RES_TERM_SECONDS}) is below the on-chain ` +
        `MIN_RESERVATION_TERM (${MIN_RESERVATION_TERM}s / 90 days) and would ` +
        "revert on finalizeReservationParametersUpdate"
    )
  }

  // Mirror EVERY remaining on-chain require in
  // Reservation.sol's updateReservationParameters so a bad value fails
  // fast here rather than reverting on-chain at finalize, up to 48h after
  // this calldata is generated and staged.
  if (RES_TX_MAX_FEE <= BigInt(0)) {
    throw new Error(
      "RESERVATION_TX_MAX_FEE_SATS must be greater than zero (mirrors " +
        "updateReservationParameters's 'Reservation transaction max fee " +
        "must be greater than zero' require)"
    )
  }
  if (RES_MIN_AMOUNT <= RES_TX_MAX_FEE) {
    throw new Error(
      `RESERVATION_MIN_AMOUNT_SATS (${RES_MIN_AMOUNT}) must be greater than ` +
        `RESERVATION_TX_MAX_FEE_SATS (${RES_TX_MAX_FEE}) (mirrors ` +
        "updateReservationParameters's 'Reservation minimum amount must " +
        "be greater than the reservation TX max fee' require)"
    )
  }
  if (RES_TERM_SECONDS > MAX_RESERVATION_TERM) {
    throw new Error(
      `RESERVATION_TERM_SECONDS (${RES_TERM_SECONDS}) exceeds the on-chain ` +
        `MAX_RESERVATION_TERM (${MAX_RESERVATION_TERM}s / 730 days) and ` +
        "would revert on finalizeReservationParametersUpdate"
    )
  }
  if (RES_RENEWAL_WINDOW <= 0 || RES_RENEWAL_WINDOW >= RES_TERM_SECONDS) {
    throw new Error(
      `RESERVATION_RENEWAL_WINDOW_SECONDS (${RES_RENEWAL_WINDOW}) must be ` +
        "greater than zero and strictly shorter than " +
        `RESERVATION_TERM_SECONDS (${RES_TERM_SECONDS}) (mirrors ` +
        "updateReservationParameters's 'Renewal window must be shorter " +
        "than the term' require)"
    )
  }
  if (
    RES_ACTION_TIMEOUT <=
    REQUEST_TIMEOUT_SAFETY_MARGIN + DEPOSIT_MIN_AGE + 1
  ) {
    throw new Error(
      `RESERVATION_ACTION_TIMEOUT_SECONDS (${RES_ACTION_TIMEOUT}) must ` +
        "exceed REQUEST_TIMEOUT_SAFETY_MARGIN + DEPOSIT_MIN_AGE + 1 " +
        `(${REQUEST_TIMEOUT_SAFETY_MARGIN + DEPOSIT_MIN_AGE + 1}s) (mirrors ` +
        "updateReservationParameters's 'Reservation action timeout leaves " +
        "no signing window' require)"
    )
  }

  // Verify Decision 1 invariant holds:
  // reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount
  const slotCapacity = BigInt(MAX_ACTIVE) * SINGLE_AMOUNT_CAP
  if (RES_MAX_TOTAL_AMOUNT > slotCapacity) {
    throw new Error(
      `Decision 1 invariant violated: reservationMaxTotalAmount (${RES_MAX_TOTAL_AMOUNT}) > ` +
        `maxActiveReservations * reservationMaxSingleAmount (${slotCapacity}); ` +
        "this calldata would revert on finalize"
    )
  }
  console.log(
    `\nDecision 1 invariant OK: ${RES_MAX_TOTAL_AMOUNT} <= ${slotCapacity}`
  )

  // Verify the Item-3 sizing relation (roadmap.md section 6 item 2,
  // RESOLVED 2026-09-07): since RESERVATION_MAX_PER_WALLET is hard-required
  // to be 1 above, this reduces to MAX_ACTIVE <= current on-chain
  // liveWalletsCount. Reads the live value from the already-deployed
  // Bridge rather than trusting an operator-supplied number, since this is
  // exactly the value that silently drifts as wallets retire. With
  // maxReservationsPerWallet == 1, at most one reservation can ever be
  // active per live wallet, so a MAX_ACTIVE above this ceiling is
  // unreachable dead configuration rather than a per-acceptance revert:
  // reservations instead saturate per-wallet, each wallet's acceptance
  // reverting with "Wallet reservations cap exceeded" (the real on-chain
  // string, in `Reservation.reserveAcceptanceCapacity`) once its own single
  // slot is filled, well before the global cap could ever bind.
  const currentLiveWalletsCount: number = await read(
    "Bridge",
    "liveWalletsCount"
  )
  const slotCapacityByWallets =
    currentLiveWalletsCount * MAX_RESERVATIONS_PER_WALLET
  if (MAX_ACTIVE > slotCapacityByWallets) {
    throw new Error(
      `RESERVATION_MAX_ACTIVE (${MAX_ACTIVE}) exceeds current live-wallet ` +
        `slot capacity (liveWalletsCount=${currentLiveWalletsCount} * ` +
        `maxReservationsPerWallet=${MAX_RESERVATIONS_PER_WALLET} = ` +
        `${slotCapacityByWallets}); with maxReservationsPerWallet=1 this ` +
        "global cap can never be reached and becomes dead configuration " +
        "above the wallet count, while individual wallets saturate first " +
        "via 'Wallet reservations cap exceeded'. Register more Live " +
        "wallets first, or lower RESERVATION_MAX_ACTIVE to at most the " +
        "current slot capacity."
    )
  }
  console.log(
    `\nOccupancy sizing relation OK: maxActiveReservations (${MAX_ACTIVE}) <= ` +
      `liveWalletsCount * maxReservationsPerWallet (${slotCapacityByWallets})`
  )

  // --- Hand-off reserve-aware fleet-fit check. The relation above is the
  // naive one; the on-chain hand-off reserve gate
  // (`Reservation.reserveAcceptanceCapacity`) is stricter: an acceptance
  // reverts with "Hand-off reserve exceeded" unless the active position
  // count after it is at most
  //   max(0, liveWalletsCount - handoffReserveWallets) * maxReservationsPerWallet,
  // because that many Live wallets must stay free to retire together while
  // every open position still fits on the remaining ones. A
  // `maxActiveReservations` above that ceiling is unreachable, so the check
  // is a hard failure here rather than a runtime revert on the first
  // acceptance.
  assertHandoffAwareFleetFit({
    maxActive: MAX_ACTIVE,
    liveWalletsCount: currentLiveWalletsCount,
    handoffReserveWallets: HANDOFF_RESERVE_WALLETS,
    maxReservationsPerWallet: MAX_RESERVATIONS_PER_WALLET,
  })
  const handoffAwareCapacity = handoffAwareSlotCapacity({
    liveWalletsCount: currentLiveWalletsCount,
    handoffReserveWallets: HANDOFF_RESERVE_WALLETS,
    maxReservationsPerWallet: MAX_RESERVATIONS_PER_WALLET,
  })
  console.log(
    `\nHand-off reserve-aware fleet fit OK: maxActiveReservations ` +
      `(${MAX_ACTIVE}) <= max(0, liveWalletsCount=${currentLiveWalletsCount} - ` +
      `handoffReserveWallets=${HANDOFF_RESERVE_WALLETS}) * ` +
      `maxReservationsPerWallet=${MAX_RESERVATIONS_PER_WALLET} = ` +
      `${handoffAwareCapacity}`
  )

  // --- Verify a reserved deposit can actually be revealed under the chosen
  // term. Deposit._revealDeposit bounds the refund locktime two ways when
  // depositRevealAheadPeriod is set: it must be at least the reveal time plus
  // depositRevealAheadPeriod, and for a reserved deposit also at most the
  // reveal time plus the term plus the 24h deposit refund safety margin
  // (otherwise it reverts with "Refund locktime too far in the future for a
  // reservation"). requestReservationAcceptance additionally needs the
  // refund deadline at least the reveal time plus actionTimeout plus that
  // same 24h margin. The feasibility rule takes the lower bound as
  // max(reveal-ahead + 2h drift, actionTimeout + 24h + 2h drift) and
  // requires it to fit inside term + 24h - 1h, so we mirror the same
  // numbers here and fail fast instead of reverting on every reveal.
  const depositParams = await read("Bridge", "depositParameters")
  const revealAheadPeriod = Number(depositParams.depositRevealAheadPeriod)
  let minFeasibleTerm = 0
  if (revealAheadPeriod > 0) {
    const lowest = Math.max(
      revealAheadPeriod + REVEAL_DRIFT_SECONDS,
      RES_ACTION_TIMEOUT + DEPOSIT_REFUND_SAFETY_MARGIN + REVEAL_DRIFT_SECONDS
    )
    minFeasibleTerm =
      lowest - DEPOSIT_REFUND_SAFETY_MARGIN + REVEAL_FEASIBILITY_MARGIN_SECONDS
    if (RES_TERM_SECONDS < minFeasibleTerm) {
      throw new Error(
        `RESERVATION_TERM_SECONDS (${RES_TERM_SECONDS}) is below the ` +
          `minimum feasible term (${minFeasibleTerm}s) for the on-chain ` +
          `depositRevealAheadPeriod (${revealAheadPeriod}s): Deposit.sol ` +
          "needs a reserved deposit's refund locktime in " +
          `[reveal + ${lowest}s, reveal + term + ${DEPOSIT_REFUND_SAFETY_MARGIN}s]` +
          ". With the term bound and the 1h feasibility margin the window " +
          "is empty or too thin for this term. Raise " +
          `RESERVATION_TERM_SECONDS to at least ${minFeasibleTerm}s, or ` +
          "lower depositRevealAheadPeriod via 14_set_deposit_parameters.ts " +
          "governance."
      )
    }
  }
  console.log(
    `${
      `\nReserved-reveal window OK: term (${RES_TERM_SECONDS}s) vs ` +
      `depositRevealAheadPeriod (${revealAheadPeriod}s)`
    }${revealAheadPeriod > 0 ? `, min feasible term ${minFeasibleTerm}s` : ""}`
  )

  // The reveal-window guard above is stricter than the term check inside
  // `assertReservedDepositsFeasible`, so it runs first and names the minimum
  // term; this call then covers the amount caps against the dust threshold.
  assertReservedDepositsFeasible({
    depositDustThreshold: BigInt(depositParams[0]),
    depositRevealAheadPeriod: Number(depositParams[3]),
    termSeconds: RES_TERM_SECONDS,
    singleAmountCap: SINGLE_AMOUNT_CAP,
    perWalletCap: PER_WALLET_CAP,
    maxTotalAmount: RES_MAX_TOTAL_AMOUNT,
  })

  // --- Re-verify live-wallet slot capacity immediately before generating
  // the finalize/setVaultStatus calldata. Up to 48h can pass between the
  // begin calls above being submitted and their finalize counterparts
  // actually being executed, during which a wallet retiring can silently
  // invalidate the check already performed above. A fresh read here means
  // re-running this script closer to the actual finalize submission time
  // (after the real governance delay has elapsed) will catch drift that a
  // single upfront check would miss.
  const liveWalletsCountBeforeFinalize: number = await read(
    "Bridge",
    "liveWalletsCount"
  )
  const slotCapacityByWalletsBeforeFinalize =
    liveWalletsCountBeforeFinalize * MAX_RESERVATIONS_PER_WALLET
  if (MAX_ACTIVE > slotCapacityByWalletsBeforeFinalize) {
    throw new Error(
      "Live-wallet slot capacity invariant no longer holds immediately " +
        `before finalize: RESERVATION_MAX_ACTIVE (${MAX_ACTIVE}) exceeds ` +
        "current live-wallet slot capacity " +
        `(liveWalletsCount=${liveWalletsCountBeforeFinalize} * ` +
        `maxReservationsPerWallet=${MAX_RESERVATIONS_PER_WALLET} = ` +
        `${slotCapacityByWalletsBeforeFinalize}). A wallet likely retired ` +
        "since the begin-call check above ran. Do not submit the " +
        "finalize/setVaultStatus calldata generated below; re-run this " +
        "script after registering more Live wallets or lowering " +
        "RESERVATION_MAX_ACTIVE."
    )
  }
  console.log(
    "\nRe-verified live-wallet slot capacity immediately before finalize: " +
      `OK (${MAX_ACTIVE} <= ${slotCapacityByWalletsBeforeFinalize})`
  )

  // --- Re-verify the hand-off reserve-aware fleet fit immediately before
  // generating the finalize/setVaultStatus calldata, for the same reason:
  // a wallet retiring between the begin calls and the finalize execution
  // shrinks the capacity the on-chain hand-off reserve gate allows.
  assertHandoffAwareFleetFit({
    maxActive: MAX_ACTIVE,
    liveWalletsCount: liveWalletsCountBeforeFinalize,
    handoffReserveWallets: HANDOFF_RESERVE_WALLETS,
    maxReservationsPerWallet: MAX_RESERVATIONS_PER_WALLET,
  })
  const handoffAwareCapacityBeforeFinalize = handoffAwareSlotCapacity({
    liveWalletsCount: liveWalletsCountBeforeFinalize,
    handoffReserveWallets: HANDOFF_RESERVE_WALLETS,
    maxReservationsPerWallet: MAX_RESERVATIONS_PER_WALLET,
  })
  console.log(
    "\nRe-verified hand-off reserve-aware fleet fit immediately before " +
      "finalize: OK (" +
      `${MAX_ACTIVE} <= ${handoffAwareCapacityBeforeFinalize})`
  )

  // --- Generate governance calldata ---
  console.log(
    "\n--- Generating governance calldata (router, then caps+params begin, then caps+params finalize, then activation) ---"
  )

  // Single ABI source: the compiled BridgeGovernance artifact, not a
  // hand-maintained ABI-fragment copy that can silently drift from the
  // real contract.
  const bridgeGovernanceArtifact =
    await artifacts.readArtifact("BridgeGovernance")
  const bridgeGovInterface = new Interface(bridgeGovernanceArtifact.abi)

  const actionDefinitions = buildReservationActionDefinitions({
    reservationRouter: ReservationRouter.address,
    reservationVault: ReservationVault.address,
    perWalletCap: PER_WALLET_CAP,
    singleAmountCap: SINGLE_AMOUNT_CAP,
    maxActive: MAX_ACTIVE,
    maxThirdPartyReanchorHolds: MAX_THIRD_PARTY_REANCHOR_HOLDS,
    handoffReserveWallets: HANDOFF_RESERVE_WALLETS,
    minAmount: RES_MIN_AMOUNT,
    txMaxFee: RES_TX_MAX_FEE,
    termSeconds: RES_TERM_SECONDS,
    dissolutionDelay: RES_DISSOLUTION_DELAY,
    maxTotalAmount: RES_MAX_TOTAL_AMOUNT,
    maxReservationsPerWallet: MAX_RESERVATIONS_PER_WALLET,
    actionTimeout: RES_ACTION_TIMEOUT,
    renewalWindowSeconds: RES_RENEWAL_WINDOW,
  })

  const actions: CalldataAction[] = actionDefinitions.map((definition) => ({
    ...definition,
    target: BridgeGovernance.address,
    targetName: "BridgeGovernance",
    calldata: bridgeGovInterface.encodeFunctionData(
      definition.method,
      definition.args
    ),
  }))

  // Log all actions
  actions.forEach(logCalldataAction)
  logCalldataSummary(actions)

  // --- Save deployment summary JSON ---
  const chainId = await hre.getChainId()

  const deploymentSummary = {
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    deployer,
    chainId,
    existingContracts: {
      Bridge: Bridge.address,
      BridgeGovernance: BridgeGovernance.address,
      ReservationVault: ReservationVault.address,
      ReservationRouter: ReservationRouter.address,
      ProxyAdmin: proxyAdminAddress,
      Timelock: KNOWN_TIMELOCK,
      CouncilSafe: KNOWN_COUNCIL_SAFE,
    },
    governanceActions: actions.map((action) => ({
      to: action.target,
      data: action.calldata,
      value: 0,
      description: action.label,
    })),
    decision1Invariant: {
      description:
        "reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount",
      slotCapacity: slotCapacity.toString(),
      maxTotalAmount: RES_MAX_TOTAL_AMOUNT.toString(),
      satisfied: RES_MAX_TOTAL_AMOUNT <= slotCapacity,
    },
    liveWalletSlotCapacity: {
      description:
        "maxActiveReservations <= liveWalletsCount * maxReservationsPerWallet, checked twice since up to 48h passes between begin and finalize",
      atBeginGeneration: {
        liveWalletsCount: currentLiveWalletsCount,
        slotCapacity: slotCapacityByWallets,
        satisfied: MAX_ACTIVE <= slotCapacityByWallets,
      },
      atFinalizeGeneration: {
        liveWalletsCount: liveWalletsCountBeforeFinalize,
        slotCapacity: slotCapacityByWalletsBeforeFinalize,
        satisfied: MAX_ACTIVE <= slotCapacityByWalletsBeforeFinalize,
      },
    },
    handoffAwareFleetFit: {
      description:
        "maxActiveReservations <= max(0, liveWalletsCount - handoffReserveWallets) * maxReservationsPerWallet, the ceiling the on-chain hand-off reserve gate enforces, checked twice since up to 48h passes between begin and finalize",
      handoffReserveWallets: HANDOFF_RESERVE_WALLETS,
      atBeginGeneration: {
        liveWalletsCount: currentLiveWalletsCount,
        slotCapacity: handoffAwareCapacity,
        satisfied: MAX_ACTIVE <= handoffAwareCapacity,
      },
      atFinalizeGeneration: {
        liveWalletsCount: liveWalletsCountBeforeFinalize,
        slotCapacity: handoffAwareCapacityBeforeFinalize,
        satisfied: MAX_ACTIVE <= handoffAwareCapacityBeforeFinalize,
      },
    },
    dissolutionDelayPolicy: {
      description:
        "deploy-script policy (not an on-chain rule): the dissolution delay must be greater than zero and at most 730 days",
      dissolutionDelaySeconds: RES_DISSOLUTION_DELAY,
      maxDissolutionDelaySeconds: SCRIPT_POLICY_MAX_DISSOLUTION_DELAY,
      satisfied:
        RES_DISSOLUTION_DELAY > 0 &&
        RES_DISSOLUTION_DELAY <= SCRIPT_POLICY_MAX_DISSOLUTION_DELAY,
    },
  }

  const summaryDir = path.join(__dirname, "..", "deployments", hre.network.name)
  fs.mkdirSync(summaryDir, { recursive: true })
  const summaryPath = path.join(
    summaryDir,
    `reservation-bootstrap-calldata-${Date.now()}.json`
  )

  try {
    fs.writeFileSync(summaryPath, JSON.stringify(deploymentSummary, null, 2))
    console.log(`\nDeployment summary saved to: ${summaryPath}`)
  } catch (error) {
    console.log(
      `WARNING: Failed to write deployment summary to ${summaryPath}: ` +
        `${(error as Error).message}`
    )
  }
}

export default func

func.tags = ["GenerateReservationMainnetCalldata"]
// Set DEPLOY_RESERVATION_BOOTSTRAP_CALDATA=true when running.
// yarn deploy --tags GenerateReservationMainnetCalldata --network mainnet
func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  // Only run on mainnet (or explicitly enabled networks)
  // Skip on local networks and testnets unless explicitly forced
  const isMainnet = hre.network.name === "mainnet"
  const force = process.env.DEPLOY_RESERVATION_BOOTSTRAP_CALDATA === "true"
  return !isMainnet && !force
}
