import fs from "fs"
import path from "path"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"
import { utils, constants } from "ethers"

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
export const KNOWN_COUNCIL_SAFE = "0x9F6e831c8f8939dc0c830c6e492e7cef4f9c2f5f"

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
// Mirrored from WalletProposalValidatorConstants.REQUEST_TIMEOUT_SAFETY_MARGIN.
const REQUEST_TIMEOUT_SAFETY_MARGIN = 7_200 // 2 hours

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
      args: [params.perWalletCap, params.singleAmountCap, params.maxActive],
      label: "beginReservationCapsUpdate (stages the reservation caps update)",
      details: {
        "Max reservations amount per wallet": params.perWalletCap.toString(),
        "Max single amount": params.singleAmountCap.toString(),
        "Max active reservations": params.maxActive.toString(),
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
        "Max reservations per wallet": params.maxReservationsPerWallet.toString(),
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
          "(non-reserved) deposits.",
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
  const adminSlotData = await ethers.provider.getStorageAt(
    Bridge.address,
    EIP_1967_ADMIN_SLOT
  )
  const proxyAdminAddress = utils.getAddress(`0x${adminSlotData.slice(26)}`)
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
  console.log(`  ProxyAdmin (${proxyAdminAddress}) owner matches KNOWN_TIMELOCK`)

  const bridgeGovernanceOwnerContract = await ethers.getContractAt(
    ["function owner() view returns (address)"],
    BridgeGovernance.address
  )
  const bridgeGovernanceOwner: string =
    await bridgeGovernanceOwnerContract.owner()
  if (bridgeGovernanceOwner.toLowerCase() !== KNOWN_COUNCIL_SAFE.toLowerCase()) {
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
  if (currentReservationRouter !== constants.AddressZero) {
    throw new Error(
      `Bridge.getReservationRouter() is already set to ` +
        `${currentReservationRouter}; setReservationRouter is write-once ` +
        "and a second call reverts on-chain. Refusing to generate " +
        "duplicate-set calldata."
    )
  }
  const routerOnChainCode = await ethers.provider.getCode(
    ReservationRouter.address
  )
  if (routerOnChainCode !== ReservationRouter.deployedBytecode) {
    throw new Error(
      `On-chain bytecode at ReservationRouter address ` +
        `${ReservationRouter.address} does not match the compiled ` +
        "artifact's deployed bytecode; refusing to embed a mismatched " +
        "address in mainnet governance calldata."
    )
  }
  console.log(
    `  Reservation router not yet set on Bridge (OK), and on-chain bytecode ` +
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

  // Hard-fail the launch-posture invariants that are already decided,
  // rather than warning and letting the operator copy bad calldata into
  // a Safe transaction builder.
  if (MAX_RESERVATIONS_PER_WALLET !== 1) {
    throw new Error(
      "RESERVATION_MAX_PER_WALLET must be 1 (decided M1 launch value), got " +
        `${MAX_RESERVATIONS_PER_WALLET}`
    )
  }
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
        'updateReservationParameters\'s "Reservation transaction max fee ' +
        'must be greater than zero" require)'
    )
  }
  if (RES_MIN_AMOUNT <= RES_TX_MAX_FEE) {
    throw new Error(
      `RESERVATION_MIN_AMOUNT_SATS (${RES_MIN_AMOUNT}) must be greater than ` +
        `RESERVATION_TX_MAX_FEE_SATS (${RES_TX_MAX_FEE}) (mirrors ` +
        'updateReservationParameters\'s "Reservation minimum amount must ' +
        'be greater than the reservation TX max fee" require)'
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
        'updateReservationParameters\'s "Renewal window must be shorter ' +
        'than the term" require)'
    )
  }
  if (RES_ACTION_TIMEOUT <= REQUEST_TIMEOUT_SAFETY_MARGIN) {
    throw new Error(
      `RESERVATION_ACTION_TIMEOUT_SECONDS (${RES_ACTION_TIMEOUT}) must ` +
        "exceed the wallet validator's REQUEST_TIMEOUT_SAFETY_MARGIN " +
        `(${REQUEST_TIMEOUT_SAFETY_MARGIN}s / 2h) (mirrors ` +
        'updateReservationParameters\'s "Reservation action timeout must ' +
        'exceed the safety margin" require)'
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
        `via "Wallet reservations cap exceeded". Register more Live ` +
        "wallets first, or lower RESERVATION_MAX_ACTIVE to at most the " +
        "current slot capacity."
    )
  }
  console.log(
    `\nOccupancy sizing relation OK: maxActiveReservations (${MAX_ACTIVE}) <= ` +
      `liveWalletsCount * maxReservationsPerWallet (${slotCapacityByWallets})`
  )

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

  // --- Generate governance calldata ---
  console.log(
    "\n--- Generating governance calldata (router, then caps+params begin, then caps+params finalize, then activation) ---"
  )

  // Single ABI source: the compiled BridgeGovernance artifact, not a
  // hand-maintained ABI-fragment copy that can silently drift from the
  // real contract.
  const bridgeGovernanceArtifact = await artifacts.readArtifact(
    "BridgeGovernance"
  )
  const bridgeGovInterface = new utils.Interface(bridgeGovernanceArtifact.abi)

  const actionDefinitions = buildReservationActionDefinitions({
    reservationRouter: ReservationRouter.address,
    reservationVault: ReservationVault.address,
    perWalletCap: PER_WALLET_CAP,
    singleAmountCap: SINGLE_AMOUNT_CAP,
    maxActive: MAX_ACTIVE,
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
