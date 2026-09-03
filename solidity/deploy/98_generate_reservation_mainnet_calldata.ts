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
  "function beginReservationCapsUpdate(uint64 _newMaxReservationsAmountPerWallet, uint64 _newReservationMaxSingleAmount, uint32 _newMaxActiveReservations)",
  "function beginReservationParametersUpdate(address _newReservationVault, uint64 _newReservationMinAmount, uint64 _newReservationTxMaxFee, uint32 _newReservationTermSeconds, uint32 _newReservationDissolutionDelay, uint64 _newReservationMaxTotalAmount, uint32 _newMaxReservationsPerWallet, uint32 _newReservationActionTimeout, uint32 _newReservationRenewalWindowSeconds)",
]

// Shared interface instance used by both helper functions and the main
// deployment function for calldata encoding.
const bridgeGovInterface = new utils.Interface(BRIDGE_GOVERNANCE_ABI)

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
  console.log("Ordering: caps BEFORE parameters (Decision 1)")
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

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre
  const { get } = deployments
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

  console.log(`  BridgeGovernance: ${BridgeGovernance.address}`)
  console.log(`  ReservationVault: ${ReservationVault.address}`)

  // Configuration values for initial bootstrap
  // These are example values; operators should adjust per governance decision.
  // The script logs calldata so it can be copied into a Safe transaction builder.
  const PER_WALLET_CAP = 100_000_000_000n // 100 BTC in satoshis (example)
  const SINGLE_AMOUNT_CAP = 10_000_000_000n // 10 BTC in satoshis (example)
  const MAX_ACTIVE = 1000 // example

  const RES_MIN_AMOUNT = 1_000_000n // 0.01 BTC in satoshis (example)
  const RES_TX_MAX_FEE = 500_000n // example
  const RES_TERM_SECONDS = 2_592_000 // 30 days
  const RES_DISSOLUTION_DELAY = 86_400 // 1 day
  const RES_MAX_TOTAL_AMOUNT = 1_000_000_000_000n // 1000 BTC in satoshis (example)
  const MAX_RESERVATIONS_PER_WALLET = 10
  const RES_ACTION_TIMEOUT = 86_400 // 1 day
  const RES_RENEWAL_WINDOW = 604_800 // 7 days

  // Verify Decision 1 invariant holds with these example values
  // reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount
  const slotCapacity = BigInt(MAX_ACTIVE) * SINGLE_AMOUNT_CAP
  if (RES_MAX_TOTAL_AMOUNT > slotCapacity) {
    console.log("\nWARNING: Example values violate Decision 1 invariant!")
    console.log(
      `  reservationMaxTotalAmount (${RES_MAX_TOTAL_AMOUNT}) > ` +
        `maxActiveReservations * reservationMaxSingleAmount (${slotCapacity})`
    )
    console.log(
      "Adjust example values or this calldata will revert on finalize."
    )
  } else {
    console.log(
      `\nDecision 1 invariant OK: ${RES_MAX_TOTAL_AMOUNT} <= ${slotCapacity}`
    )
  }

  // --- Generate governance calldata ---
  console.log(
    "\n--- Generating governance calldata (caps BEFORE parameters) ---"
  )

  const actions: CalldataAction[] = []

  // Action 1: beginReservationCapsUpdate (MUST be first per Decision 1)
  const capsCalldata = encodeBeginReservationCapsUpdate(
    Number(PER_WALLET_CAP),
    Number(SINGLE_AMOUNT_CAP),
    MAX_ACTIVE
  )
  actions.push({
    label:
      "Governance Action: beginReservationCapsUpdate (Decision 1: caps FIRST)",
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

  // Action 2: beginReservationParametersUpdate (MUST be second per Decision 1)
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
      "Governance Action: beginReservationParametersUpdate (Decision 1: parameters SECOND)",
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
      Timelock: KNOWN_TIMELOCK,
      CouncilSafe: KNOWN_COUNCIL_SAFE,
    },
    governanceActions: [
      {
        to: BridgeGovernance.address,
        data: capsCalldata,
        value: 0,
        description:
          "beginReservationCapsUpdate on BridgeGovernance (MUST finalize first per Decision 1)",
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
