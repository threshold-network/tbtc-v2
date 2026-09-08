import fs from "fs"
import path from "path"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction, DeployOptions } from "hardhat-deploy/types"
import { utils, constants } from "ethers"

// Known mainnet Timelock Controller address. Owner of the ProxyAdmin,
// used for scheduling and executing governance operations with a 24h delay.
export const KNOWN_TIMELOCK = "0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D"

// Known mainnet Council Safe (6/9 multisig). Proposer and executor
// on the Timelock, and owner of BridgeGovernance.
export const KNOWN_COUNCIL_SAFE = "0x9F6e831c8f8939dc0c830c6e492e7cef4f9c2f5f"

// ABI fragments for calldata encoding. These are the minimal function
// signatures needed to generate governance calldata without importing
// full contract artifacts.
const BRIDGE_GOVERNANCE_ABI = [
  "function setReservationRouter(address _reservationRouter)",
  "function beginReservationCapsUpdate(uint64 _newMaxReservationsAmountPerWallet, uint64 _newReservationMaxSingleAmount, uint32 _newMaxActiveReservations)",
  "function beginReservationParametersUpdate(address _newReservationVault, uint64 _newReservationMinAmount, uint64 _newReservationTxMaxFee, uint32 _newReservationTermSeconds, uint32 _newReservationDissolutionDelay, uint64 _newReservationMaxTotalAmount, uint32 _newMaxReservationsPerWallet, uint32 _newReservationActionTimeout, uint32 _newReservationRenewalWindowSeconds)",
]

// Shared interface instance used by both helper functions and the main
// deployment function for calldata encoding.
const bridgeGovInterface = new utils.Interface(BRIDGE_GOVERNANCE_ABI)

/**
 * Encodes BridgeGovernance.setReservationRouter() calldata.
 * This is a one-off action with no governance delay and MUST be the first
 * governance action executed: the Bridge's `fallback()` reverts with
 * "Reservation router not set" while `reservationRouter == address(0)`, so
 * no other reservation action can reach the router until this runs.
 *
 * @param reservationRouter - Address of the ReservationRouter contract
 * @returns ABI-encoded calldata for the setReservationRouter function
 */
export function encodeSetReservationRouter(reservationRouter: string): string {
  return bridgeGovInterface.encodeFunctionData("setReservationRouter", [
    reservationRouter,
  ])
}

/**
 * Encodes BridgeGovernance.beginReservationCapsUpdate() calldata.
 * This begins the governance-delayed update (governanceDelays(0) = 172800s /
 * 48h) and must be followed by a finalize call after the delay expires.
 * Per Decision 1, this MUST be called before beginReservationParametersUpdate
 * during initial bootstrap to avoid the slot-capacity check reverting.
 *
 * @param perWalletCap - Max reservations amount per wallet
 * @param singleAmountCap - Reservation max single amount
 * @param maxActive - Max active reservations (occupancy cap)
 * @returns ABI-encoded calldata for the begin update function
 */
export function encodeBeginReservationCapsUpdate(
  perWalletCap: number,
  singleAmountCap: number,
  maxActive: number
): string {
  return bridgeGovInterface.encodeFunctionData("beginReservationCapsUpdate", [
    perWalletCap,
    singleAmountCap,
    maxActive,
  ])
}

/**
 * Encodes BridgeGovernance.beginReservationParametersUpdate() calldata.
 * This begins the governance-delayed update (governanceDelays(0) = 172800s /
 * 48h) and must be followed by a finalize call after the delay expires.
 * Per Decision 1, this MUST be called AFTER beginReservationCapsUpdate
 * during initial bootstrap.
 *
 * @param reservationVault - Address of the ReservationVault contract
 * @param minAmount - Reservation min amount
 * @param txMaxFee - Reservation tx max fee
 * @param termSeconds - Reservation term in seconds
 * @param dissolutionDelay - Reservation dissolution delay in seconds
 * @param maxTotalAmount - Reservation max total amount
 * @param maxReservationsPerWallet - Max reservations per wallet
 * @param actionTimeout - Reservation action timeout in seconds
 * @param renewalWindowSeconds - Reservation renewal window in seconds
 * @returns ABI-encoded calldata for the begin update function
 */
export function encodeBeginReservationParametersUpdate(
  reservationVault: string,
  minAmount: number,
  txMaxFee: number,
  termSeconds: number,
  dissolutionDelay: number,
  maxTotalAmount: number,
  maxReservationsPerWallet: number,
  actionTimeout: number,
  renewalWindowSeconds: number
): string {
  return bridgeGovInterface.encodeFunctionData(
    "beginReservationParametersUpdate",
    [
      reservationVault,
      minAmount,
      txMaxFee,
      termSeconds,
      dissolutionDelay,
      maxTotalAmount,
      maxReservationsPerWallet,
      actionTimeout,
      renewalWindowSeconds,
    ]
  )
}

/** Structure for a governance calldata action entry. */
interface CalldataAction {
  label: string
  target: string
  targetName: string
  calldata: string
  details: Record<string, string>
}

/** Logs a governance calldata action with consistent formatting. */
function logCalldataAction(action: CalldataAction): void {
  console.log(`\n  ${action.label}`)
  console.log(`    Target: ${action.targetName} (${action.target})`)
  console.log(`    Calldata: ${action.calldata}`)
  console.log(`    Selector: ${action.calldata.slice(0, 10)}`)
  Object.entries(action.details).forEach(([key, value]) => {
    console.log(`    ${key}: ${value}`)
  })
}

/** Prints all calldata actions with a summary header/footer. */
function logCalldataSummary(actions: CalldataAction[]): void {
  console.log(`\n${"=".repeat(80)}`)
  console.log("RESERVATION BOOTSTRAP GOVERNANCE CALDATA (mainnet)")
  console.log("=".repeat(80))
  console.log(
    "Ordering: router FIRST, then caps BEFORE parameters (Decision 1)"
  )
  console.log("Governance delay: 172800s (48h) per governanceDelays(0)")

  actions.forEach((action, index) => {
    console.log(`\n  [${index + 1}] ${action.label}`)
    console.log(`      Target: ${action.targetName} (${action.target})`)
    console.log(`      Selector: ${action.calldata.slice(0, 10)}`)
    Object.entries(action.details).forEach(([key, value]) => {
      console.log(`      ${key}: ${value}`)
    })
  })
  console.log(`\n${"=".repeat(80)}`)
  console.log(
    "Submit via Council Safe -> Timelock.schedule() -> [wait 48h] -> Timelock.execute()"
  )
  console.log(
    "Or direct Council Safe call if timelock bypassed (test networks only)"
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
  const { deployments, getNamedAccounts } = hre
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
  const BridgeGovernance = await get("BridgeGovernance")
  const ReservationVault = await get("ReservationVault")
  const ReservationRouter = await get("ReservationRouter")

  console.log(`  BridgeGovernance: ${BridgeGovernance.address}`)
  console.log(`  ReservationVault: ${ReservationVault.address}`)
  console.log(`  ReservationRouter: ${ReservationRouter.address}`)

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
  const MIN_RESERVATION_TERM = 7_776_000 // 90 days, enforced on-chain
  if (RES_TERM_SECONDS < MIN_RESERVATION_TERM) {
    throw new Error(
      `RESERVATION_TERM_SECONDS (${RES_TERM_SECONDS}) is below the on-chain ` +
        `MIN_RESERVATION_TERM (${MIN_RESERVATION_TERM}s / 90 days) and would ` +
        "revert on finalizeReservationParametersUpdate"
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

  // Verify the new Item-3 sizing relation (roadmap.md section 6 item 2,
  // RESOLVED 2026-09-07) will not immediately brick acceptance: since
  // RESERVATION_MAX_PER_WALLET is hard-required to be 1 above, this
  // reduces to MAX_ACTIVE <= current on-chain liveWalletsCount. Reads the
  // live value from the already-deployed Bridge rather than trusting an
  // operator-supplied number, since this is exactly the value that
  // silently drifts as wallets retire.
  const currentLiveWalletsCount: number = await read(
    "Bridge",
    "liveWalletsCount"
  )
  const slotCapacityByWallets =
    currentLiveWalletsCount * MAX_RESERVATIONS_PER_WALLET
  if (MAX_ACTIVE > slotCapacityByWallets) {
    throw new Error(
      `RESERVATION_MAX_ACTIVE (${MAX_ACTIVE}) exceeds current live-wallet slot ` +
        `capacity (liveWalletsCount=${currentLiveWalletsCount} * ` +
        `maxReservationsPerWallet=${MAX_RESERVATIONS_PER_WALLET} = ` +
        `${slotCapacityByWallets}); this would make every deposit acceptance ` +
        "revert with 'Occupancy cap exceeds live wallet slot capacity' " +
        "immediately after activation. Register more Live wallets first, or " +
        "lower RESERVATION_MAX_ACTIVE to at most the current slot capacity."
    )
  }
  console.log(
    `\nOccupancy sizing relation OK: maxActiveReservations (${MAX_ACTIVE}) <= ` +
      `liveWalletsCount * maxReservationsPerWallet (${slotCapacityByWallets})`
  )

  // --- Generate governance calldata ---
  console.log(
    "\n--- Generating governance calldata (router FIRST, then caps BEFORE parameters) ---"
  )

  const actions: CalldataAction[] = []

  // Action 1: setReservationRouter (MUST be first; the Bridge's fallback()
  // reverts with "Reservation router not set" until this runs, so no other
  // reservation action can reach the router before it)
  const routerCalldata = encodeSetReservationRouter(ReservationRouter.address)
  actions.push({
    label:
      "Governance Action: setReservationRouter (MUST be first - unblocks the Bridge fallback)",
    target: BridgeGovernance.address,
    targetName: "BridgeGovernance",
    calldata: routerCalldata,
    details: {
      "Reservation router": ReservationRouter.address,
      "Governance delay": "None (one-off action)",
      Note: "Must be called BEFORE any other reservation governance action",
    },
  })

  // Action 2: beginReservationCapsUpdate (MUST be second per Decision 1)
  const capsCalldata = encodeBeginReservationCapsUpdate(
    Number(PER_WALLET_CAP),
    Number(SINGLE_AMOUNT_CAP),
    MAX_ACTIVE
  )
  actions.push({
    label:
      "Governance Action: beginReservationCapsUpdate (Decision 1: caps BEFORE parameters)",
    target: BridgeGovernance.address,
    targetName: "BridgeGovernance",
    calldata: capsCalldata,
    details: {
      "Max reservations per wallet": PER_WALLET_CAP.toString(),
      "Max single amount": SINGLE_AMOUNT_CAP.toString(),
      "Max active reservations": MAX_ACTIVE.toString(),
      "Governance delay": "172800s (48h)",
      Note: "Must finalize BEFORE beginReservationParametersUpdate per Decision 1",
    },
  })

  // Action 3: beginReservationParametersUpdate (MUST be third per Decision 1)
  const paramsCalldata = encodeBeginReservationParametersUpdate(
    ReservationVault.address,
    Number(RES_MIN_AMOUNT),
    Number(RES_TX_MAX_FEE),
    RES_TERM_SECONDS,
    RES_DISSOLUTION_DELAY,
    Number(RES_MAX_TOTAL_AMOUNT),
    MAX_RESERVATIONS_PER_WALLET,
    RES_ACTION_TIMEOUT,
    RES_RENEWAL_WINDOW
  )
  actions.push({
    label:
      "Governance Action: beginReservationParametersUpdate (Decision 1: parameters THIRD)",
    target: BridgeGovernance.address,
    targetName: "BridgeGovernance",
    calldata: paramsCalldata,
    details: {
      "Reservation vault": ReservationVault.address,
      "Min amount": RES_MIN_AMOUNT.toString(),
      "Tx max fee": RES_TX_MAX_FEE.toString(),
      "Term (seconds)": RES_TERM_SECONDS.toString(),
      "Dissolution delay": RES_DISSOLUTION_DELAY.toString(),
      "Max total amount": RES_MAX_TOTAL_AMOUNT.toString(),
      "Max reservations per wallet": MAX_RESERVATIONS_PER_WALLET.toString(),
      "Action timeout": RES_ACTION_TIMEOUT.toString(),
      "Renewal window": RES_RENEWAL_WINDOW.toString(),
      "Governance delay": "172800s (48h)",
      Note: "Must be called AFTER beginReservationCapsUpdate finalizes per Decision 1",
    },
  })

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
      BridgeGovernance: BridgeGovernance.address,
      ReservationVault: ReservationVault.address,
      ReservationRouter: ReservationRouter.address,
      Timelock: KNOWN_TIMELOCK,
      CouncilSafe: KNOWN_COUNCIL_SAFE,
    },
    governanceActions: [
      {
        to: BridgeGovernance.address,
        data: routerCalldata,
        value: 0,
        description:
          "setReservationRouter on BridgeGovernance (MUST run first - unblocks the Bridge fallback)",
      },
      {
        to: BridgeGovernance.address,
        data: capsCalldata,
        value: 0,
        description:
          "beginReservationCapsUpdate on BridgeGovernance (MUST finalize before beginReservationParametersUpdate per Decision 1)",
      },
      {
        to: BridgeGovernance.address,
        data: paramsCalldata,
        value: 0,
        description:
          "beginReservationParametersUpdate on BridgeGovernance (MUST run after caps finalize per Decision 1)",
      },
    ],
    exampleConfig: {
      perWalletCap: PER_WALLET_CAP.toString(),
      singleAmountCap: SINGLE_AMOUNT_CAP.toString(),
      maxActive: MAX_ACTIVE,
      minAmount: RES_MIN_AMOUNT.toString(),
      txMaxFee: RES_TX_MAX_FEE.toString(),
      termSeconds: RES_TERM_SECONDS,
      dissolutionDelay: RES_DISSOLUTION_DELAY,
      maxTotalAmount: RES_MAX_TOTAL_AMOUNT.toString(),
      maxReservationsPerWallet: MAX_RESERVATIONS_PER_WALLET,
      actionTimeout: RES_ACTION_TIMEOUT,
      renewalWindowSeconds: RES_RENEWAL_WINDOW,
    },
    decision1Invariant: {
      description:
        "reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount",
      slotCapacity: slotCapacity.toString(),
      maxTotalAmount: RES_MAX_TOTAL_AMOUNT.toString(),
      satisfied: RES_MAX_TOTAL_AMOUNT <= slotCapacity,
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
