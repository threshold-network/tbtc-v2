import assert from "assert/strict"
import { readFileSync } from "fs"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import test from "node:test"

import {
  applyP2TRWatchtowerChallengeEvent,
  BitcoinClient,
  BitcoinRawTx,
  computeP2TRSignatureFraudBridgeChallengeIdentity,
  createP2TRWatchtowerChallengeRecord,
  extractP2TRSignatureFraudWitnessObservations,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING,
  P2TRSignatureFraudChallengeSubmitter,
  P2TRSignatureFraudChallengeBroadcastReconciler,
  P2TRSignatureFraudChallengeSubmissionPolicy,
  P2TRSignatureFraudPayloadBounds,
  P2TRSignatureFraudWitnessObservation,
  P2TRSignatureFraudWatchtowerBridgeLifecycleEvent,
  P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource,
  P2TRSignatureFraudSpendType,
  P2TRWatchtowerChallengeRecord,
  P2TRSignatureFraudWatchtowerTransactionSource,
  P2TRWatchtowerConfirmedTransaction,
  P2TRWatchtowerChallengeRecordJSON,
  P2TRWatchtowerMempoolTransaction,
  serializeP2TRWatchtowerChallengeRecord,
} from "@keep-network/tbtc-v2.ts"
import { Transaction } from "bitcoinjs-lib"

import {
  FileBackedP2TRBridgeLifecycleScanCursorStore,
  FileBackedP2TRWatchtowerChallengeRecordPersistence,
  P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV,
  P2TRSignatureFraudWatchtowerService,
  P2TRSignatureFraudWatchtowerCycleReport,
  createFileBackedP2TRBridgeLifecycleEventSource,
  createFileBackedP2TRSignatureFraudWatchtowerRuntime,
  loadP2TRSignatureFraudWatchtowerRuntimeConfig,
  runP2TRSignatureFraudWatchtowerLoop,
} from "../src/index.js"
import type {
  P2TREthersBridgeLifecycleContract,
  P2TRSignatureFraudWatchtowerServiceAlert,
  P2TRSignatureFraudWatchtowerServiceAlertSink,
  P2TRSignatureFraudWatchtowerServiceLogger,
  P2TRSignatureFraudWatchtowerTransactionCoordinator,
} from "../src/index.js"

type SignatureFraudVector = {
  id?: string
  walletIDHex: string
  unsignedTransactionHex: string
  signedInputIndex: number
  prevouts: {
    txidHex: string
    vout: number
    valueSats: number | string
    scriptPubKeyHex: string
  }[]
  witnessSignatureHex: string
}

const emptyTransactionSource: P2TRSignatureFraudWatchtowerTransactionSource = {
  async listMempoolTransactions(): Promise<P2TRWatchtowerMempoolTransaction[]> {
    return []
  },
  async listConfirmedTransactions() {
    return { transactions: [], complete: true }
  },
}

const emptyBridgeLifecycleSource: P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource =
  {
    async listBridgeLifecycleEvents(): Promise<
      P2TRSignatureFraudWatchtowerBridgeLifecycleEvent[]
    > {
      return []
    },
  }

const draftRedemptionSubmissionPolicy: P2TRSignatureFraudChallengeSubmissionPolicy =
  {
    allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION],
  }

const draftPayloadBounds: P2TRSignatureFraudPayloadBounds = {
  maxRawTransactionBytes: 10000,
  maxInputs: 2,
  maxOutputs: 2,
  maxScriptPubKeyBytes: 34,
}

const draftBridgeChallengeDomain = {
  chainID: 11155111,
  bridgeAddress: "0x1111111111111111111111111111111111111111",
}

const draftSubmissionAttemptLimitAlert = {
  code: "submission-attempt-limit",
  message: "manual intervention required",
}

const draftSingleProcessRehearsalSubmission = {
  indexingStoreProfile: "single-process-rehearsal" as const,
  allowSingleProcessRehearsalSubmission: true,
}

// A complete submission-mode environment for the environment-backed runtime
// builder. The classifier is intentionally absent because env vars cannot
// supply the code predicate; the builder must receive it through options.
const submissionRuntimeEnv = () => ({
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.stateFilePath]:
    "/tmp/p2tr-watchtower-state.json",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs]: `0x${"11".repeat(32)}`,
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges]: "true",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.allowFileBackedSubmission]: "true",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAllowedSpendTypes]:
    P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath]:
    "/tmp/p2tr-bridge-lifecycle-cursor.json",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth]: "12",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange]: "5000",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleRequireCursorBlockHash]:
    "true",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeChainID]: "11155111",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeBridgeAddress]:
    "0x1111111111111111111111111111111111111111",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxRawTransactionBytes]: "10000",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxInputs]: "2",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxOutputs]: "2",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxScriptPubKeyBytes]: "34",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxSubmissionAttempts]: "3",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertCode]:
    "submission-attempt-limit",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertMessage]:
    "manual intervention required",
})

const transactionalChallengeRecordPersistence = (
  transactionalStoreID = "production-indexing-store"
) => ({
  p2trSignatureFraudWatchtowerStoreProfile: "transactional-production" as const,
  p2trSignatureFraudWatchtowerTransactionalStoreID: transactionalStoreID,
  async loadChallengeRecords() {
    return []
  },
  async saveChallengeRecords() {},
})

const singleProcessBridgeLifecycleSource = () => ({
  ...emptyBridgeLifecycleSource,
  p2trSignatureFraudWatchtowerStoreProfile: "single-process-rehearsal" as const,
})

const transactionalBridgeLifecycleSource = (
  transactionalStoreID = "production-indexing-store"
) => ({
  ...emptyBridgeLifecycleSource,
  p2trSignatureFraudWatchtowerStoreProfile: "transactional-production" as const,
  p2trSignatureFraudWatchtowerTransactionalStoreID: transactionalStoreID,
})

const noopAlertSink: P2TRSignatureFraudWatchtowerServiceAlertSink = {
  emitAlert() {},
}

const transactionalCoordinator = (
  transactionalStoreID = "production-indexing-store"
) => {
  let transactionCount = 0
  let activeTransactions = 0

  const coordinator: P2TRSignatureFraudWatchtowerTransactionCoordinator & {
    transactionCount(): number
  } = {
    p2trSignatureFraudWatchtowerStoreProfile:
      "transactional-production" as const,
    p2trSignatureFraudWatchtowerTransactionalStoreID: transactionalStoreID,
    p2trSignatureFraudWatchtowerAtomicTransactions: true,
    assertP2TRSignatureFraudWatchtowerSharedStore() {},
    async runInP2TRSignatureFraudWatchtowerTransaction<T>(
      operation: () => Promise<T>
    ): Promise<T> {
      transactionCount++
      activeTransactions++
      try {
        return await operation()
      } finally {
        activeTransactions--
      }
    },
    isP2TRSignatureFraudWatchtowerTransactionActive() {
      return activeTransactions > 0
    },
    transactionCount() {
      return transactionCount
    },
  }

  return coordinator
}

class FakeSubmitter
  implements
    P2TRSignatureFraudChallengeSubmitter,
    P2TRSignatureFraudChallengeBroadcastReconciler
{
  readonly p2trSignatureFraudWatchtowerIdempotentSubmissions = true
  readonly submissionTrustDomainID = "submitter.test"
  readonly reconciliationTrustDomainID = "reconciler.test"
  readonly finalityConfirmationBlocks = 64
  submissionCount = 0
  private readonly submittedChallenges = new Map<string, string>()

  async submitSignatureFraudChallenge(
    observation: P2TRSignatureFraudWitnessObservation
  ): Promise<string> {
    const existingSubmission = this.submittedChallenges.get(
      observation.observationID.toString()
    )
    if (existingSubmission !== undefined) {
      return existingSubmission
    }

    this.submissionCount++
    const challengeTxHash = `0x${"ab".repeat(32)}`
    this.submittedChallenges.set(
      observation.observationID.toString(),
      challengeTxHash
    )
    return challengeTxHash
  }

  async reconcileSignatureFraudChallengeBroadcast() {
    return {
      status: "absent-after-finality" as const,
      reason: "challenge is absent after the test finality boundary",
    }
  }
}

const acceptedChallengeBroadcastReconciler: P2TRSignatureFraudChallengeBroadcastReconciler =
  {
    reconciliationTrustDomainID: "reconciler.test",
    finalityConfirmationBlocks: 64,
    async reconcileSignatureFraudChallengeBroadcast() {
      return { status: "accepted" }
    },
  }

class TransactionalRollbackChallengeRecordPersistence {
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID =
    "production-indexing-store"

  private pendingRecords?: P2TRWatchtowerChallengeRecordJSON[]

  constructor(private durableRecords: P2TRWatchtowerChallengeRecordJSON[]) {}

  async loadChallengeRecords(): Promise<P2TRWatchtowerChallengeRecordJSON[]> {
    return cloneSerializedChallengeRecords(
      this.pendingRecords ?? this.durableRecords
    )
  }

  async saveChallengeRecords(
    records: P2TRWatchtowerChallengeRecordJSON[]
  ): Promise<void> {
    this.pendingRecords = cloneSerializedChallengeRecords(records)
  }

  commitTransaction(): void {
    if (this.pendingRecords !== undefined) {
      this.durableRecords = cloneSerializedChallengeRecords(this.pendingRecords)
    }
    this.pendingRecords = undefined
  }

  rollbackTransaction(): void {
    this.pendingRecords = undefined
  }
}

const cloneSerializedChallengeRecords = (
  records: P2TRWatchtowerChallengeRecordJSON[]
): P2TRWatchtowerChallengeRecordJSON[] =>
  JSON.parse(JSON.stringify(records)) as P2TRWatchtowerChallengeRecordJSON[]

const emptyCycleReport = (): P2TRSignatureFraudWatchtowerCycleReport => ({
  startedAt: new Date(0).toISOString(),
  completedAt: new Date(0).toISOString(),
  result: {
    replayed: [],
    mempool: { submissions: [], failures: [] },
    confirmed: { submissions: [], failures: [] },
    bridgeLifecycle: { records: [], failures: [], ignored: [] },
    confirmedSourceComplete: true,
    sourceFailures: [],
    summary: {
      total: 0,
      byStatus: {
        observed: 0,
        submitting: 0,
        "broadcast-pending": 0,
        submitted: 0,
        rejected: 0,
        "defeat-eligible": 0,
        defeated: 0,
        "timeout-eligible": 0,
        slashed: 0,
        rewarded: 0,
      },
      byBitcoinStatus: {
        mempool: 0,
        confirmed: 0,
        evicted: 0,
        reorged: 0,
      },
      byOperatorAlertStatus: {
        open: 0,
        acknowledged: 0,
        cleared: 0,
      },
      unresolvedOperatorAlerts: 0,
    },
    unresolvedOperatorAlerts: [],
  },
  metrics: {
    replayedRecords: 0,
    replayedSubmissions: 0,
    replayedSubmissionAttempts: 0,
    mempoolObservations: 0,
    mempoolSubmissions: 0,
    mempoolSubmissionAttempts: 0,
    mempoolFailures: 0,
    confirmedObservations: 0,
    confirmedSubmissions: 0,
    confirmedSubmissionAttempts: 0,
    confirmedFailures: 0,
    bridgeLifecycleRecords: 0,
    bridgeLifecycleFailures: 0,
    bridgeLifecycleIgnored: 0,
    sourceFailures: 0,
    totalRecords: 0,
    unresolvedOperatorAlerts: 0,
    alertSinkFailures: 0,
  },
})

/**
 * The service discovers each of these structurally rather than requiring it on
 * the dependency interface, so a double that offers one has to widen its own
 * type -- otherwise the excess-property check rejects the literal.
 */
type CommittingBridgeLifecycleEventSource =
  P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource & {
    commitBridgeLifecycleScan(): Promise<void>
  }

type IdempotentChallengeSubmitter = P2TRSignatureFraudChallengeSubmitter & {
  p2trSignatureFraudWatchtowerIdempotentSubmissions: true
}

/**
 * Attaches a capability probe the dependency interface deliberately omits. The
 * spread keeps the base type, so only the probe is added -- and the result is
 * no longer a fresh literal, which is what the excess-property check trips on.
 */
const withCapabilityProbe = <Base, Probe extends object>(
  base: Base,
  probe: Probe
): Base & Probe => ({ ...base, ...probe })

const committingBridgeLifecycleSource = (
  source: CommittingBridgeLifecycleEventSource
): CommittingBridgeLifecycleEventSource => source

test("persists watchtower records to an operator state file atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    const record = createP2TRWatchtowerChallengeRecord(`0x${"11".repeat(32)}`)

    await persistence.saveChallengeRecords([
      serializeP2TRWatchtowerChallengeRecord(record),
    ])

    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.observationID, record.observationID.toString())
    assert.equal(storedRecord.status, "observed")
    assert.equal(storedRecord.submissionAttempts, 0)
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("fails closed before overwriting challenge records changed after load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    assert.deepEqual(await persistence.loadChallengeRecords(), [])

    const externalRecord = createP2TRWatchtowerChallengeRecord(
      `0x${"22".repeat(32)}`
    )
    await writeFile(
      statePath,
      `${JSON.stringify(
        [serializeP2TRWatchtowerChallengeRecord(externalRecord)],
        null,
        2
      )}\n`,
      "utf8"
    )

    await assert.rejects(
      persistence.saveChallengeRecords([]),
      /state file changed since the last load/
    )
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("validates operator state records before replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    await writeFile(
      statePath,
      JSON.stringify([
        {
          observationID: `0x${"11".repeat(32)}`,
          status: "unsupported",
          submissionAttempts: 0,
        },
      ]),
      "utf8"
    )

    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )

    await assert.rejects(
      persistence.loadChallengeRecords(),
      /state record 0 is invalid: Watchtower challenge status is unsupported/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("persists Bridge lifecycle scan cursor to an operator state file atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const cursorPath = join(directory, "bridge-lifecycle-cursor.json")

  try {
    const cursorStore = new FileBackedP2TRBridgeLifecycleScanCursorStore(
      cursorPath
    )

    assert.equal(await cursorStore.loadBridgeLifecycleScanCursor(), undefined)

    await cursorStore.saveBridgeLifecycleScanCursor({ lastScannedBlock: 123 })

    assert.deepEqual(await cursorStore.loadBridgeLifecycleScanCursor(), {
      lastScannedBlock: 123,
    })
    assert.deepEqual(JSON.parse(await readFile(cursorPath, "utf8")), {
      lastScannedBlock: 123,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("persists Bridge lifecycle scan cursor block hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const cursorPath = join(directory, "bridge-lifecycle-cursor.json")

  try {
    const cursorStore = new FileBackedP2TRBridgeLifecycleScanCursorStore(
      cursorPath
    )

    await cursorStore.saveBridgeLifecycleScanCursor({
      lastScannedBlock: 123,
      lastScannedBlockHash: `0x${"ab".repeat(32)}`,
    })

    assert.deepEqual(await cursorStore.loadBridgeLifecycleScanCursor(), {
      lastScannedBlock: 123,
      lastScannedBlockHash: `0x${"ab".repeat(32)}`,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("fails closed before overwriting Bridge lifecycle cursor changed after load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const cursorPath = join(directory, "bridge-lifecycle-cursor.json")

  try {
    await writeFile(
      cursorPath,
      `${JSON.stringify({ lastScannedBlock: 10 }, null, 2)}\n`,
      "utf8"
    )
    const cursorStore = new FileBackedP2TRBridgeLifecycleScanCursorStore(
      cursorPath
    )

    assert.deepEqual(await cursorStore.loadBridgeLifecycleScanCursor(), {
      lastScannedBlock: 10,
    })

    await writeFile(
      cursorPath,
      `${JSON.stringify({ lastScannedBlock: 20 }, null, 2)}\n`,
      "utf8"
    )

    await assert.rejects(
      cursorStore.saveBridgeLifecycleScanCursor({ lastScannedBlock: 30 }),
      /cursor file changed since the last load/
    )
    assert.deepEqual(JSON.parse(await readFile(cursorPath, "utf8")), {
      lastScannedBlock: 20,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("validates Bridge lifecycle scan cursor before use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const cursorPath = join(directory, "bridge-lifecycle-cursor.json")

  try {
    await writeFile(
      cursorPath,
      JSON.stringify({ lastScannedBlock: -1 }),
      "utf8"
    )

    const cursorStore = new FileBackedP2TRBridgeLifecycleScanCursorStore(
      cursorPath
    )

    await assert.rejects(
      cursorStore.loadBridgeLifecycleScanCursor(),
      /lastScannedBlock must be a non-negative integer/
    )
    await assert.rejects(
      cursorStore.saveBridgeLifecycleScanCursor({ lastScannedBlock: -1 }),
      /lastScannedBlock must be a non-negative integer/
    )
    await assert.rejects(
      cursorStore.saveBridgeLifecycleScanCursor({
        lastScannedBlock: 1,
        lastScannedBlockHash: "0x1234",
      }),
      /lastScannedBlockHash must be a 32-byte hex string/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("wires file-backed Bridge lifecycle source config into an Ethers source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const cursorPath = join(directory, "bridge-lifecycle-cursor.json")
  const defeatedFilter = { event: "defeated" }
  const timedOutFilter = { event: "timed-out" }
  const movingFundsCompletedFilter = { event: "moving-funds-completed" }
  const redemptionsCompletedFilter = { event: "redemptions-completed" }
  const queries: {
    filter: unknown
    fromBlock?: number | string
    toBlock?: number | string
  }[] = []

  try {
    const bridgeAddress = `0x${"44".repeat(20)}`
    const lifecycleBlockHash = `0x${"77".repeat(32)}`
    const bridge: P2TREthersBridgeLifecycleContract = {
      address: bridgeAddress,
      provider: {
        async getBlockNumber() {
          return 150
        },
        async getBlock() {
          return { hash: lifecycleBlockHash }
        },
      },
      filters: {
        P2TRSignatureFraudChallengeDefeated: () => defeatedFilter,
        P2TRSignatureFraudChallengeDefeatTimedOut: () => timedOutFilter,
        MovingFundsCompleted: () => movingFundsCompletedFilter,
        RedemptionsCompleted: () => redemptionsCompletedFilter,
      },
      async queryFilter(filter, fromBlock, toBlock) {
        queries.push({ filter, fromBlock, toBlock })

        if (filter !== timedOutFilter) {
          return []
        }

        return [
          {
            args: {
              walletID: `0x${"11".repeat(32)}`,
              bridgeChallengeIdentity: `0x${"22".repeat(32)}`,
              challengeKey: 9n,
              sighash: `0x${"33".repeat(32)}`,
            },
            transactionHash: `0x${"66".repeat(32)}`,
            address: bridgeAddress,
            blockHash: lifecycleBlockHash,
            blockNumber: 138,
            data: `0x${"0".repeat(63)}9${"33".repeat(32)}`,
            logIndex: 0,
            removed: false,
            topics: [
              "0x798f765e06fb1f2a5b39a4ffddc27396be8ba8e51b59b1d08d82c95922e5b331",
              `0x${"11".repeat(32)}`,
              `0x${"aa".repeat(20)}${"0".repeat(24)}`,
              `0x${"22".repeat(32)}`,
            ],
          },
        ]
      },
    }

    const source = createFileBackedP2TRBridgeLifecycleEventSource(
      bridge,
      bridge,
      {
        scanCursorFilePath: cursorPath,
        confirmationDepth: 12,
        maxBlockRange: 200,
        cursorOverlapBlocks: 6,
      },
      {
        sourceTrustDomainID: "indexer.test",
        canonicalLogVerifier: {
          trustDomainID: "canonical.test",
          providerIdentity: {},
          async getBlockNumber() {
            return 150
          },
          async getCanonicalBlockHash() {
            return lifecycleBlockHash
          },
          async verifyLifecycleLog() {
            return true
          },
          async verifyLifecycleLogRange() {
            return true
          },
        },
      }
    )

    assert.equal(
      source.p2trSignatureFraudWatchtowerStoreProfile,
      "single-process-rehearsal"
    )
    assert.deepEqual(await source.listBridgeLifecycleEvents(), [
      {
        type: "slashed",
        bridgeChallengeKey: `0x${"0".repeat(63)}9`,
        slashingTxHash: `0x${"66".repeat(32)}`,
        walletID: `0x${"11".repeat(32)}`,
        bridgeChallengeIdentity: `0x${"22".repeat(32)}`,
        sighash: `0x${"33".repeat(32)}`,
      },
      {
        type: "rewarded",
        bridgeChallengeKey: `0x${"0".repeat(63)}9`,
        rewardTxHash: `0x${"66".repeat(32)}`,
        walletID: `0x${"11".repeat(32)}`,
        bridgeChallengeIdentity: `0x${"22".repeat(32)}`,
        sighash: `0x${"33".repeat(32)}`,
      },
    ])
    assert.deepEqual(queries, [
      { filter: defeatedFilter, fromBlock: 0, toBlock: 138 },
      { filter: timedOutFilter, fromBlock: 0, toBlock: 138 },
      { filter: movingFundsCompletedFilter, fromBlock: 0, toBlock: 138 },
      { filter: redemptionsCompletedFilter, fromBlock: 0, toBlock: 138 },
    ])

    await source.commitBridgeLifecycleScan()

    assert.deepEqual(JSON.parse(await readFile(cursorPath, "utf8")), {
      lastScannedBlock: 138,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps mutated persisted observations inert while automatic submission is disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const vector = loadFirstSignatureFraudVector()
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      withInputWitness(
        vector.unsignedTransactionHex,
        vector.signedInputIndex,
        vector.witnessSignatureHex
      ),
      vector.prevouts.map((prevout) => ({
        txid: prevout.txidHex,
        vout: prevout.vout,
        valueSats: prevout.valueSats,
        scriptPubKey: prevout.scriptPubKeyHex,
      })),
      [vector.walletIDHex]
    )
    const rejectedRecord: P2TRWatchtowerChallengeRecord = {
      ...createP2TRWatchtowerChallengeRecord(observation.observationID),
      observation: {
        ...observation,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
      status: "rejected" as const,
      submissionAttempts: 1,
      lastError: "temporary submitter outage",
    }
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    await persistence.saveChallengeRecords([
      serializeP2TRWatchtowerChallengeRecord(rejectedRecord),
    ])

    const submitter = new FakeSubmitter()
    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [vector.walletIDHex],
        payloadBounds: draftPayloadBounds,
        bridgeChallengeDomain: draftBridgeChallengeDomain,
        spendTypeClassifier: () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
      {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: submitter,
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence,
      }
    )

    const report = await service.processCycle()

    assert.equal(submitter.submissionCount, 0)
    assert.equal(report.metrics.replayedRecords, 1)
    assert.equal(report.metrics.replayedSubmissions, 0)
    assert.equal(report.metrics.replayedSubmissionAttempts, 0)

    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.status, "rejected")
    assert.equal(storedRecord.submissionAttempts, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps stored rejected challenges inert during observation-only restart cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const vector = loadFirstSignatureFraudVector()
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      withInputWitness(
        vector.unsignedTransactionHex,
        vector.signedInputIndex,
        vector.witnessSignatureHex
      ),
      vector.prevouts.map((prevout) => ({
        txid: prevout.txidHex,
        vout: prevout.vout,
        valueSats: prevout.valueSats,
        scriptPubKey: prevout.scriptPubKeyHex,
      })),
      [vector.walletIDHex],
      undefined,
      () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      draftPayloadBounds,
      draftBridgeChallengeDomain
    )
    const rejectedRecord: P2TRWatchtowerChallengeRecord = {
      ...createP2TRWatchtowerChallengeRecord(observation.observationID),
      observation: {
        ...observation,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
      status: "rejected" as const,
      submissionAttempts: 1,
      lastError: "temporary submitter outage",
    }
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    await persistence.saveChallengeRecords([
      serializeP2TRWatchtowerChallengeRecord(rejectedRecord),
    ])

    const submitter = new FakeSubmitter()
    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [vector.walletIDHex],
        payloadBounds: draftPayloadBounds,
        bridgeChallengeDomain: draftBridgeChallengeDomain,
        spendTypeClassifier: () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
      {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: submitter,
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence,
      }
    )

    const report = await service.processCycle()

    assert.equal(submitter.submissionCount, 0)
    assert.equal(report.metrics.replayedRecords, 1)
    assert.equal(report.metrics.replayedSubmissions, 0)
    assert.equal(report.metrics.replayedSubmissionAttempts, 0)
    assert.equal(report.metrics.totalRecords, 1)

    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.status, "rejected")
    assert.equal(storedRecord.submissionAttempts, 1)
    assert.equal(storedRecord.challengeTxHash, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps rejected challenges inert when lifecycle verification fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const vector = loadFirstSignatureFraudVector()
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      withInputWitness(
        vector.unsignedTransactionHex,
        vector.signedInputIndex,
        vector.witnessSignatureHex
      ),
      vector.prevouts.map((prevout) => ({
        txid: prevout.txidHex,
        vout: prevout.vout,
        valueSats: prevout.valueSats,
        scriptPubKey: prevout.scriptPubKeyHex,
      })),
      [vector.walletIDHex],
      undefined,
      () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      draftPayloadBounds,
      draftBridgeChallengeDomain
    )
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    await persistence.saveChallengeRecords([
      serializeP2TRWatchtowerChallengeRecord({
        ...createP2TRWatchtowerChallengeRecord(observation.observationID),
        observation: {
          ...observation,
          spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
        },
        status: "rejected",
        submissionAttempts: 1,
        lastError: "temporary submitter outage",
      }),
    ])

    let submissionCount = 0
    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [vector.walletIDHex],
        payloadBounds: draftPayloadBounds,
        bridgeChallengeDomain: draftBridgeChallengeDomain,
        spendTypeClassifier: () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
      {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: withCapabilityProbe(
          {
            async submitSignatureFraudChallenge() {
              submissionCount++
              throw new Error("temporary submitter outage")
            },
          },
          { p2trSignatureFraudWatchtowerIdempotentSubmissions: true as const }
        ),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: {
          async listBridgeLifecycleEvents() {
            throw new Error(
              "P2TR signature fraud router log is not independently canonical"
            )
          },
        },
        persistence,
      }
    )

    const firstReport = await service.processCycle()
    const secondReport = await service.processCycle()

    assert.equal(firstReport.metrics.replayedRecords, 1)
    assert.equal(secondReport.metrics.replayedRecords, 1)
    assert.equal(firstReport.metrics.sourceFailures, 1)
    assert.equal(secondReport.metrics.sourceFailures, 1)
    assert.equal(submissionCount, 0)
    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.status, "rejected")
    assert.equal(storedRecord.submissionAttempts, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("wires observation-only file-backed runtime config into service and loop options", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const vector = loadFirstSignatureFraudVector()
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      withInputWitness(
        vector.unsignedTransactionHex,
        vector.signedInputIndex,
        vector.witnessSignatureHex
      ),
      vector.prevouts.map((prevout) => ({
        txid: prevout.txidHex,
        vout: prevout.vout,
        valueSats: prevout.valueSats,
        scriptPubKey: prevout.scriptPubKeyHex,
      })),
      [vector.walletIDHex],
      undefined,
      () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      draftPayloadBounds,
      draftBridgeChallengeDomain
    )
    const rejectedRecord: P2TRWatchtowerChallengeRecord = {
      ...createP2TRWatchtowerChallengeRecord(observation.observationID),
      observation: {
        ...observation,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
      status: "rejected" as const,
      submissionAttempts: 1,
      lastError: "temporary submitter outage",
    }
    await writeFile(
      statePath,
      JSON.stringify(
        [serializeP2TRWatchtowerChallengeRecord(rejectedRecord)],
        null,
        2
      ),
      "utf8"
    )

    const submitter = new FakeSubmitter()
    const runtime = createFileBackedP2TRSignatureFraudWatchtowerRuntime(
      {
        stateFilePath: statePath,
        bridgeLifecycle: {},
        transactionSource: {},
        service: {
          registeredWalletIDs: [vector.walletIDHex],
          payloadBounds: draftPayloadBounds,
          bridgeChallengeDomain: draftBridgeChallengeDomain,
          spendTypeClassifier: () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
        },
        loop: {
          pollIntervalMs: 45000,
          continueOnError: true,
        },
      },
      {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: submitter,
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
      }
    )

    assert.deepEqual(runtime.loopOptions, {
      pollIntervalMs: 45000,
      continueOnError: true,
    })

    const report = await runtime.service.processCycle()

    assert.equal(submitter.submissionCount, 0)
    assert.equal(report.metrics.replayedRecords, 1)
    assert.equal(report.metrics.replayedSubmissions, 0)
    assert.equal(report.metrics.replayedSubmissionAttempts, 0)
    assert.equal(report.metrics.totalRecords, 1)

    const [storedRecord] = JSON.parse(await readFile(statePath, "utf8"))
    assert.equal(storedRecord.status, "rejected")
    assert.equal(storedRecord.submissionAttempts, 1)
    assert.equal(storedRecord.challengeTxHash, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects environment-backed automatic submission before runtime construction", () => {
  assert.throws(
    () => loadP2TRSignatureFraudWatchtowerRuntimeConfig(submissionRuntimeEnv()),
    /bounded\/no-go/
  )
})

test("defaults service cycles to observation-only submission policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const vector = loadFirstSignatureFraudVector()
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      withInputWitness(
        vector.unsignedTransactionHex,
        vector.signedInputIndex,
        vector.witnessSignatureHex
      ),
      vector.prevouts.map((prevout) => ({
        txid: prevout.txidHex,
        vout: prevout.vout,
        valueSats: prevout.valueSats,
        scriptPubKey: prevout.scriptPubKeyHex,
      })),
      [vector.walletIDHex]
    )
    const rejectedRecord: P2TRWatchtowerChallengeRecord = {
      ...createP2TRWatchtowerChallengeRecord(observation.observationID),
      observation,
      status: "rejected" as const,
      submissionAttempts: 1,
      lastError: "temporary submitter outage",
    }
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    await persistence.saveChallengeRecords([
      serializeP2TRWatchtowerChallengeRecord(rejectedRecord),
    ])

    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [vector.walletIDHex],
      },
      {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence,
      }
    )

    const report = await service.processCycle()

    assert.equal(report.metrics.replayedRecords, 1)
    assert.equal(report.metrics.replayedSubmissions, 0)
    assert.equal(report.metrics.replayedSubmissionAttempts, 0)
    assert.equal(report.result.replayed[0].submissionRecord.status, "rejected")
    assert.equal(
      report.result.replayed[0].submissionRecord.submissionAttempts,
      1
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("passes configured spend-type classifier into observation-only indexing without broadcasting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const vector = loadFirstSignatureFraudVector()
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const bitcoinClient = {
      async getRawTransaction(txid: string) {
        const prevout = vector.prevouts.find(
          (candidate) => candidate.txidHex === txid.toString()
        )

        if (prevout === undefined) {
          throw new Error(`unexpected prevout lookup: ${txid.toString()}`)
        }

        return rawPreviousTransactionForPrevout(prevout)
      },
    } as unknown as BitcoinClient
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    const submitter = new FakeSubmitter()
    let classifierCalls = 0
    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [vector.walletIDHex],
        bridgeChallengeDomain: draftBridgeChallengeDomain,
        payloadBounds: {
          maxRawTransactionBytes: 10000,
          maxInputs: 1,
          maxOutputs: 1,
          maxScriptPubKeyBytes: 34,
        },
        spendTypeClassifier: ({ candidate, unsignedTransaction }) => {
          classifierCalls++
          assert.equal(candidate.inputIndex, vector.signedInputIndex)
          assert.equal(
            unsignedTransaction.transactionHex,
            vector.unsignedTransactionHex
          )

          return P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
        },
      },
      {
        bitcoinClient,
        challengeSubmitter: submitter,
        transactionSource: {
          async listMempoolTransactions() {
            return [
              {
                rawTransaction,
                bitcoinTxHash,
                inputPrevouts: vector.prevouts.map((prevout) => ({
                  txid: prevout.txidHex,
                  vout: prevout.vout,
                  valueSats: prevout.valueSats,
                  scriptPubKey: prevout.scriptPubKeyHex,
                })),
              },
            ]
          },
          async listConfirmedTransactions() {
            return { transactions: [], complete: true }
          },
        },
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence,
      }
    )

    const report = await service.processCycle()

    assert.equal(classifierCalls, 1)
    assert.equal(submitter.submissionCount, 0)
    assert.equal(report.metrics.mempoolObservations, 1)
    assert.equal(report.metrics.mempoolSubmissions, 0)
    assert.equal(report.metrics.mempoolSubmissionAttempts, 0)

    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.status, "observed")
    assert.ok(storedRecord.observation)
    assert.equal(
      storedRecord.observation.spendType,
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )
    const expectedBridgeChallengeKey =
      computeP2TRSignatureFraudBridgeChallengeIdentity({
        ...draftBridgeChallengeDomain,
        walletID: storedRecord.observation.walletID,
        signingKey: vector.walletIDHex,
        sighash: storedRecord.observation.sighash,
      }).toString()
    assert.equal(
      storedRecord.observation.bridgeChallengeKey,
      expectedBridgeChallengeKey
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("reconciles honest-spend proofs for classified flexible-sighash replacements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const vector = loadFlexibleSignatureFraudVector()
    const originalRawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const replacementTransaction = Transaction.fromHex(
      vector.unsignedTransactionHex
    )
    replacementTransaction.outs[0].value--
    const replacementRawTransaction = withInputWitness(
      replacementTransaction.toHex(),
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const effectivePrevouts = vector.prevouts.map((prevout, inputIndex) =>
      inputIndex === vector.signedInputIndex
        ? prevout
        : { ...prevout, scriptPubKeyHex: "51" }
    )
    const bitcoinClient = {
      async getRawTransaction(txid: string) {
        const prevout = effectivePrevouts.find(
          (candidate) => candidate.txidHex === txid.toString()
        )

        if (prevout === undefined) {
          throw new Error(`unexpected prevout lookup: ${txid.toString()}`)
        }

        return rawPreviousTransactionForPrevout(prevout)
      },
    } as unknown as BitcoinClient
    const originalBitcoinTxHash = Transaction.fromHex(
      originalRawTransaction.transactionHex
    ).getId()
    const replacementBitcoinTxHash = Transaction.fromHex(
      replacementRawTransaction.transactionHex
    ).getId()
    let mempoolTransactions: P2TRWatchtowerMempoolTransaction[] = [
      {
        rawTransaction: originalRawTransaction,
        bitcoinTxHash: originalBitcoinTxHash,
        inputPrevouts: effectivePrevouts.map((prevout) => ({
          txid: prevout.txidHex,
          vout: prevout.vout,
          valueSats: prevout.valueSats,
          scriptPubKey: prevout.scriptPubKeyHex,
        })),
      },
    ]
    let confirmedTransactions: P2TRWatchtowerConfirmedTransaction[] = []
    let lifecycleEvents: P2TRSignatureFraudWatchtowerBridgeLifecycleEvent[] = []
    let committedBridgeLifecycleScan = false
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    const submitter = new FakeSubmitter()
    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [vector.walletIDHex],
        bridgeChallengeDomain: draftBridgeChallengeDomain,
        payloadBounds: {
          maxRawTransactionBytes: 10000,
          maxInputs: 3,
          maxOutputs: 3,
          maxScriptPubKeyBytes: 34,
        },
        spendTypeClassifier: ({ unsignedTransaction }) =>
          unsignedTransaction.transactionHex === vector.unsignedTransactionHex
            ? P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
            : P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
      },
      {
        bitcoinClient,
        challengeSubmitter: submitter,
        transactionSource: {
          async listMempoolTransactions() {
            return mempoolTransactions
          },
          async listConfirmedTransactions() {
            return { transactions: confirmedTransactions, complete: true }
          },
        },
        bridgeLifecycleEventSource: committingBridgeLifecycleSource({
          async listBridgeLifecycleEvents() {
            return lifecycleEvents
          },
          async commitBridgeLifecycleScan() {
            committedBridgeLifecycleScan = true
          },
        }),
        persistence,
      }
    )

    await service.processCycle()
    assert.equal(submitter.submissionCount, 0)

    mempoolTransactions = []
    confirmedTransactions = [
      {
        rawTransaction: replacementRawTransaction,
        bitcoinTxHash: replacementBitcoinTxHash,
        bitcoinBlockHash: `0x${"33".repeat(32)}`,
        bitcoinBlockHeight: 144,
        inputPrevouts: effectivePrevouts.map((prevout) => ({
          txid: prevout.txidHex,
          vout: prevout.vout,
          valueSats: prevout.valueSats,
          scriptPubKey: prevout.scriptPubKeyHex,
        })),
      },
    ]
    lifecycleEvents = [
      {
        type: "honest-spend-proven",
        bitcoinTxHash: replacementBitcoinTxHash,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
      },
    ]
    committedBridgeLifecycleScan = false

    const report = await service.processCycle()
    const storedRecords = await persistence.loadChallengeRecords()
    const [storedRecord] = storedRecords

    assert.equal(report.result.confirmed.failures.length, 0)
    assert.equal(
      report.result.confirmed.submissions[0].observation.spendType,
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
    )
    assert.equal(report.result.bridgeLifecycle.records.length, 1)
    assert.equal(report.result.bridgeLifecycle.failures.length, 0)
    assert.equal(report.result.bridgeLifecycle.ignored.length, 0)
    assert.equal(storedRecords.length, 1)
    assert.equal(storedRecord.status, "defeat-eligible")
    assert.equal(committedBridgeLifecycleScan, true)
    assert.equal(submitter.submissionCount, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("reconciles honest-spend proofs after metadata-only confirmations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const vector = loadFirstSignatureFraudVector()
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      vector.prevouts.map((prevout) => ({
        txid: prevout.txidHex,
        vout: prevout.vout,
        valueSats: prevout.valueSats,
        scriptPubKey: prevout.scriptPubKeyHex,
      })),
      [vector.walletIDHex],
      undefined,
      () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      draftPayloadBounds,
      draftBridgeChallengeDomain
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const mempoolRecord = applyP2TRWatchtowerChallengeEvent(
      createP2TRWatchtowerChallengeRecord(observation.observationID),
      {
        type: "mempool-observed",
        observationID: observation.observationID,
        observation,
        bitcoinTxHash,
      }
    )
    const confirmedRecord = applyP2TRWatchtowerChallengeEvent(mempoolRecord, {
      type: "bitcoin-confirmed",
      observationID: observation.observationID,
      bitcoinTxHash,
      bitcoinBlockHash: "33".repeat(32),
      bitcoinBlockHeight: 144,
    })
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    await persistence.saveChallengeRecords([
      serializeP2TRWatchtowerChallengeRecord(confirmedRecord),
    ])

    let committedBridgeLifecycleScan = false
    const service = new P2TRSignatureFraudWatchtowerService(
      { registeredWalletIDs: [vector.walletIDHex] },
      {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: committingBridgeLifecycleSource({
          async listBridgeLifecycleEvents() {
            return [
              {
                type: "honest-spend-proven" as const,
                bitcoinTxHash,
                spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
              },
            ]
          },
          async commitBridgeLifecycleScan() {
            committedBridgeLifecycleScan = true
          },
        }),
        persistence,
      }
    )

    const report = await service.processCycle()
    const [storedRecord] = await persistence.loadChallengeRecords()

    assert.equal(report.result.bridgeLifecycle.records.length, 1)
    assert.equal(report.result.bridgeLifecycle.failures.length, 0)
    assert.equal(storedRecord.status, "defeat-eligible")
    assert.equal(committedBridgeLifecycleScan, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("threads revealed-deposit key bindings from transaction sources into observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const vector = loadFirstSignatureFraudVector()
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const depositOutputKey = "42".repeat(32)
    const signedPrevout = vector.prevouts[vector.signedInputIndex]
    const bitcoinClient = {
      async getRawTransaction(txid: string) {
        const prevout = vector.prevouts.find(
          (candidate) => candidate.txidHex === txid.toString()
        )

        if (prevout === undefined) {
          throw new Error(`unexpected prevout lookup: ${txid.toString()}`)
        }

        return rawPreviousTransactionForPrevout({
          ...prevout,
          scriptPubKeyHex:
            prevout === signedPrevout
              ? `5120${depositOutputKey}`
              : prevout.scriptPubKeyHex,
        })
      },
    } as unknown as BitcoinClient
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    const service = new P2TRSignatureFraudWatchtowerService(
      { registeredWalletIDs: [vector.walletIDHex] },
      {
        bitcoinClient,
        transactionSource: {
          async listMempoolTransactions() {
            return [
              {
                rawTransaction,
                bitcoinTxHash,
                walletInputKeyBindings: [
                  {
                    txid: signedPrevout.txidHex,
                    vout: signedPrevout.vout,
                    outputKey: depositOutputKey,
                    walletID: vector.walletIDHex,
                  },
                ],
                inputPrevouts: vector.prevouts.map((prevout) => ({
                  txid: prevout.txidHex,
                  vout: prevout.vout,
                  valueSats: prevout.valueSats,
                  scriptPubKey:
                    prevout === signedPrevout
                      ? `5120${depositOutputKey}`
                      : prevout.scriptPubKeyHex,
                })),
              },
            ]
          },
          async listConfirmedTransactions() {
            return { transactions: [], complete: true }
          },
        },
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence,
      }
    )

    const report = await service.processCycle()

    assert.equal(report.metrics.mempoolObservations, 1)
    const [record] = await persistence.loadChallengeRecords()
    assert.equal(record.observation?.walletID, vector.walletIDHex)
    assert.equal(record.observation?.scriptPubKey, `5120${depositOutputKey}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("hard-disables automatic submission before requiring a submitter", () => {
  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
          submitChallenges: true,
        },
        {
          bitcoinClient: {} as BitcoinClient,
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      ),
    /bounded\/no-go/
  )

  assert.doesNotThrow(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
        },
        {
          bitcoinClient: {} as BitcoinClient,
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      )
  )
})

test("hard-disables automatic submission before checking spend policy", () => {
  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
          submitChallenges: true,
          submissionPolicy: { allowedSpendTypes: [] },
        },
        {
          bitcoinClient: {} as BitcoinClient,
          challengeSubmitter: new FakeSubmitter(),
          challengeBroadcastReconciler: acceptedChallengeBroadcastReconciler,
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      ),
    /bounded\/no-go/
  )
})

test("hard-disables automatic submission for every unresolved spend type", () => {
  ;(
    [
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING,
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT,
    ] as P2TRSignatureFraudSpendType[]
  ).forEach((spendType) => {
    assert.throws(
      () =>
        new P2TRSignatureFraudWatchtowerService(
          {
            registeredWalletIDs: [`0x${"11".repeat(32)}`],
            submitChallenges: true,
            submissionPolicy: { allowedSpendTypes: [spendType] },
            payloadBounds: draftPayloadBounds,
          },
          {
            bitcoinClient: {} as BitcoinClient,
            challengeSubmitter: new FakeSubmitter(),
            transactionSource: emptyTransactionSource,
            bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
            persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
              "/tmp/p2tr-watchtower-state.json"
            ),
          }
        ),
      /bounded\/no-go/
    )
  })
})

test("hard-disables automatic submission before checking payload bounds", () => {
  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
          submitChallenges: true,
          submissionPolicy: draftRedemptionSubmissionPolicy,
        },
        {
          bitcoinClient: {} as BitcoinClient,
          challengeSubmitter: new FakeSubmitter(),
          challengeBroadcastReconciler: acceptedChallengeBroadcastReconciler,
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      ),
    /bounded\/no-go/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
          submitChallenges: true,
          submissionPolicy: draftRedemptionSubmissionPolicy,
          payloadBounds: {
            ...draftPayloadBounds,
            maxInputs: 0,
          },
        },
        {
          bitcoinClient: {} as BitcoinClient,
          challengeSubmitter: new FakeSubmitter(),
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      ),
    /bounded\/no-go/
  )
})

test("hard-disables automatic submission before checking Bridge domain", () => {
  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
          submitChallenges: true,
          submissionPolicy: draftRedemptionSubmissionPolicy,
          payloadBounds: draftPayloadBounds,
        },
        {
          bitcoinClient: {} as BitcoinClient,
          challengeSubmitter: new FakeSubmitter(),
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      ),
    /bounded\/no-go/
  )
})

test("hard-disables automatic submission before checking classifier", () => {
  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
          submitChallenges: true,
          submissionPolicy: draftRedemptionSubmissionPolicy,
          payloadBounds: draftPayloadBounds,
          bridgeChallengeDomain: draftBridgeChallengeDomain,
        },
        {
          bitcoinClient: {} as BitcoinClient,
          challengeSubmitter: new FakeSubmitter(),
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      ),
    /bounded\/no-go/
  )
})

test("hard-disables automatic submission before checking attempt alerts", () => {
  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
          submitChallenges: true,
          submissionPolicy: draftRedemptionSubmissionPolicy,
          payloadBounds: draftPayloadBounds,
          bridgeChallengeDomain: draftBridgeChallengeDomain,
          spendTypeClassifier: () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
        },
        {
          bitcoinClient: {} as BitcoinClient,
          challengeSubmitter: new FakeSubmitter(),
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      ),
    /bounded\/no-go/
  )
})

test("hard-disables automatic submission for every indexing profile", () => {
  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
          submitChallenges: true,
          submissionPolicy: draftRedemptionSubmissionPolicy,
          payloadBounds: draftPayloadBounds,
          bridgeChallengeDomain: draftBridgeChallengeDomain,
          spendTypeClassifier: () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
          maxSubmissionAttempts: 3,
          submissionAttemptLimitAlert: draftSubmissionAttemptLimitAlert,
        },
        {
          bitcoinClient: {} as BitcoinClient,
          challengeSubmitter: new FakeSubmitter(),
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      ),
    /bounded\/no-go/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
          submitChallenges: true,
          indexingStoreProfile: "transactional-production",
          submissionPolicy: draftRedemptionSubmissionPolicy,
          payloadBounds: draftPayloadBounds,
          bridgeChallengeDomain: draftBridgeChallengeDomain,
          spendTypeClassifier: () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
          maxSubmissionAttempts: 3,
          submissionAttemptLimitAlert: draftSubmissionAttemptLimitAlert,
        },
        {
          bitcoinClient: {} as BitcoinClient,
          challengeSubmitter: new FakeSubmitter(),
          challengeBroadcastReconciler: acceptedChallengeBroadcastReconciler,
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
          persistence: transactionalChallengeRecordPersistence(),
          transactionCoordinator: transactionalCoordinator(),
          alertSink: noopAlertSink,
        }
      ),
    /bounded\/no-go/
  )
})

const transactionalConfirmedTransactionSource = (
  transactionalStoreID = "production-indexing-store"
) => ({
  p2trSignatureFraudWatchtowerStoreProfile: "transactional-production" as const,
  p2trSignatureFraudWatchtowerTransactionalStoreID: transactionalStoreID,
  async listMempoolTransactions(): Promise<P2TRWatchtowerMempoolTransaction[]> {
    return []
  },
  async listConfirmedTransactions() {
    return { transactions: [], complete: true }
  },
  async commitConfirmedTransactionScan() {},
})

test("requires transactional-production dependencies for the production indexing profile", () => {
  const productionObservationConfig = {
    registeredWalletIDs: [`0x${"11".repeat(32)}`],
    submitChallenges: false,
    indexingStoreProfile: "transactional-production" as const,
  }

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: transactionalConfirmedTransactionSource(),
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: {
          async loadChallengeRecords() {
            return []
          },
          async saveChallengeRecords() {},
        },
        transactionCoordinator: transactionalCoordinator(),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires challenge-record persistence marked as transactional-production; got unmarked/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: transactionalConfirmedTransactionSource(),
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
          "/tmp/p2tr-watchtower-state.json"
        ),
        transactionCoordinator: transactionalCoordinator(),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires challenge-record persistence marked as transactional-production; got single-process-rehearsal/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: transactionalCoordinator(),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires confirmed transaction source marked as transactional-production; got unmarked/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: withCapabilityProbe(emptyTransactionSource, {
          p2trSignatureFraudWatchtowerStoreProfile:
            "single-process-rehearsal" as const,
        }),
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: transactionalCoordinator(),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires confirmed transaction source marked as transactional-production; got single-process-rehearsal/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: transactionalConfirmedTransactionSource(),
        bridgeLifecycleEventSource: singleProcessBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: transactionalCoordinator(),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires Bridge lifecycle event source marked as transactional-production; got single-process-rehearsal/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: transactionalConfirmedTransactionSource(),
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: transactionalCoordinator(),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires Bridge lifecycle event source marked as transactional-production; got unmarked/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: transactionalConfirmedTransactionSource(),
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: withCapabilityProbe(
          transactionalChallengeRecordPersistence(),
          { p2trSignatureFraudWatchtowerTransactionalStoreID: undefined }
        ),
        transactionCoordinator: transactionalCoordinator(),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires challenge-record persistence to declare a transactional store ID/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: withCapabilityProbe(
          transactionalConfirmedTransactionSource(),
          { p2trSignatureFraudWatchtowerTransactionalStoreID: undefined }
        ),
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: transactionalCoordinator(),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires confirmed transaction source to declare a transactional store ID/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: transactionalConfirmedTransactionSource(
          "challenge-record-store"
        ),
        bridgeLifecycleEventSource:
          transactionalBridgeLifecycleSource("cursor-store"),
        persistence: transactionalChallengeRecordPersistence(
          "challenge-record-store"
        ),
        transactionCoordinator: transactionalCoordinator(
          "challenge-record-store"
        ),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires challenge-record persistence, confirmed transaction source, Bridge lifecycle event source, and transaction coordinator to share the same transactional store ID/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource:
          transactionalConfirmedTransactionSource("confirmed-store"),
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: transactionalCoordinator(),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires challenge-record persistence, confirmed transaction source, Bridge lifecycle event source, and transaction coordinator to share the same transactional store ID/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: transactionalConfirmedTransactionSource(),
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires a transaction coordinator/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: transactionalConfirmedTransactionSource(),
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: {
          ...transactionalCoordinator(),
          p2trSignatureFraudWatchtowerAtomicTransactions: false,
        } as unknown as P2TRSignatureFraudWatchtowerTransactionCoordinator,
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires a transaction coordinator that declares atomic rollback-on-error semantics/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: transactionalConfirmedTransactionSource(),
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: {
          ...transactionalCoordinator(),
          p2trSignatureFraudWatchtowerTransactionalStoreID: "coordinator-store",
        },
        alertSink: noopAlertSink,
      }),
    /transactional-production indexing profile requires challenge-record persistence, confirmed transaction source, Bridge lifecycle event source, and transaction coordinator to share the same transactional store ID/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: transactionalConfirmedTransactionSource(),
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: {
          ...transactionalCoordinator(),
          assertP2TRSignatureFraudWatchtowerSharedStore() {
            throw new Error(
              "coordinator does not own all transactional handles"
            )
          },
        },
        alertSink: noopAlertSink,
      }),
    /coordinator does not own all transactional handles/
  )

  const persistence = transactionalChallengeRecordPersistence()
  const transactionSource = transactionalConfirmedTransactionSource()
  const bridgeLifecycleEventSource = transactionalBridgeLifecycleSource()
  let sharedStoreAssertionCount = 0
  const transactionCoordinator = {
    ...transactionalCoordinator(),
    assertP2TRSignatureFraudWatchtowerSharedStore(dependencies: {
      persistence: unknown
      transactionSource: unknown
      bridgeLifecycleEventSource: unknown
    }) {
      sharedStoreAssertionCount++
      assert.equal(dependencies.persistence, persistence)
      assert.equal(dependencies.transactionSource, transactionSource)
      assert.equal(
        dependencies.bridgeLifecycleEventSource,
        bridgeLifecycleEventSource
      )
    },
  }

  assert.doesNotThrow(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionObservationConfig, {
        bitcoinClient: {} as BitcoinClient,
        transactionSource,
        bridgeLifecycleEventSource,
        persistence,
        transactionCoordinator,
        alertSink: noopAlertSink,
      })
  )
  assert.equal(sharedStoreAssertionCount, 1)
})

test("requires an alert sink for the transactional-production indexing profile", () => {
  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        {
          registeredWalletIDs: [`0x${"11".repeat(32)}`],
          submitChallenges: false,
          indexingStoreProfile: "transactional-production",
        },
        {
          bitcoinClient: {} as BitcoinClient,
          transactionSource: transactionalConfirmedTransactionSource(),
          bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
          persistence: transactionalChallengeRecordPersistence(),
          transactionCoordinator: transactionalCoordinator(),
        }
      ),
    /transactional-production indexing profile requires an alert sink/
  )
})

test("wraps production indexing cycles and cursor commits in the transaction coordinator", async () => {
  let activeTransactions = 0
  let committedConfirmedScanInTransaction = false
  let committedBridgeLifecycleScanInTransaction = false
  let transactionCount = 0
  const transactionCoordinator: P2TRSignatureFraudWatchtowerTransactionCoordinator =
    {
      p2trSignatureFraudWatchtowerStoreProfile:
        "transactional-production" as const,
      p2trSignatureFraudWatchtowerTransactionalStoreID:
        "production-indexing-store",
      p2trSignatureFraudWatchtowerAtomicTransactions: true,
      assertP2TRSignatureFraudWatchtowerSharedStore() {},
      async runInP2TRSignatureFraudWatchtowerTransaction<T>(
        operation: () => Promise<T>
      ): Promise<T> {
        transactionCount++
        activeTransactions++
        try {
          return await operation()
        } finally {
          activeTransactions--
        }
      },
      isP2TRSignatureFraudWatchtowerTransactionActive() {
        return activeTransactions > 0
      },
    }
  const transactionSource = {
    ...transactionalConfirmedTransactionSource(),
    async commitConfirmedTransactionScan() {
      committedConfirmedScanInTransaction = activeTransactions === 1
    },
  }
  const bridgeLifecycleEventSource = {
    ...transactionalBridgeLifecycleSource(),
    async commitBridgeLifecycleScan() {
      committedBridgeLifecycleScanInTransaction = activeTransactions === 1
    },
  }
  const service = new P2TRSignatureFraudWatchtowerService(
    {
      registeredWalletIDs: [`0x${"11".repeat(32)}`],
      submitChallenges: false,
      indexingStoreProfile: "transactional-production",
    },
    {
      bitcoinClient: {} as BitcoinClient,
      transactionSource,
      bridgeLifecycleEventSource,
      persistence: transactionalChallengeRecordPersistence(),
      transactionCoordinator,
      alertSink: noopAlertSink,
    }
  )

  await service.processCycle()

  assert.equal(transactionCount, 1)
  assert.equal(committedConfirmedScanInTransaction, true)
  assert.equal(committedBridgeLifecycleScanInTransaction, true)
})

test("aborts a staged confirmed scan when an item fails before cursor commit", async () => {
  let committed = 0
  let aborted = 0
  const transactionSource = {
    async listMempoolTransactions() {
      return []
    },
    async listConfirmedTransactions() {
      return {
        transactions: [
          {
            rawTransaction: { transactionHex: "00" },
            bitcoinTxHash: "11".repeat(32),
            bitcoinBlockHash: "22".repeat(32),
            bitcoinBlockHeight: 1,
            inputPrevouts: [],
          },
        ],
        complete: true,
      }
    },
    async commitConfirmedTransactionScan() {
      committed++
    },
    abortConfirmedTransactionScan() {
      aborted++
    },
  }
  const service = new P2TRSignatureFraudWatchtowerService(
    { registeredWalletIDs: [`0x${"11".repeat(32)}`] },
    {
      bitcoinClient: {} as BitcoinClient,
      transactionSource,
      bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
      persistence: {
        async loadChallengeRecords() {
          return []
        },
        async saveChallengeRecords() {},
      },
    }
  )

  const report = await service.processCycle()

  assert.equal(report.result.confirmed.failures.length, 1)
  assert.equal(committed, 0)
  assert.equal(aborted, 1)
})

test("does not commit the Bridge lifecycle cursor when a transaction source fails", async () => {
  let committedBridgeLifecycleScan = false
  let activeTransactions = 0
  const transactionCoordinator: P2TRSignatureFraudWatchtowerTransactionCoordinator =
    {
      p2trSignatureFraudWatchtowerStoreProfile:
        "transactional-production" as const,
      p2trSignatureFraudWatchtowerTransactionalStoreID:
        "production-indexing-store",
      p2trSignatureFraudWatchtowerAtomicTransactions: true,
      assertP2TRSignatureFraudWatchtowerSharedStore() {},
      async runInP2TRSignatureFraudWatchtowerTransaction<T>(
        operation: () => Promise<T>
      ): Promise<T> {
        activeTransactions++
        try {
          return await operation()
        } finally {
          activeTransactions--
        }
      },
      isP2TRSignatureFraudWatchtowerTransactionActive() {
        return activeTransactions > 0
      },
    }
  const bridgeLifecycleEventSource = {
    ...transactionalBridgeLifecycleSource(),
    async commitBridgeLifecycleScan() {
      committedBridgeLifecycleScan = true
    },
  }
  // A transaction source whose mempool listing fails records a mempool
  // sourceFailure for the cycle. Honest-spend proof events processed in the same
  // cycle then cannot be reliably matched against observed transactions, so the
  // Bridge lifecycle cursor must NOT advance past them.
  const failingTransactionSource = {
    ...transactionalConfirmedTransactionSource(),
    async listMempoolTransactions() {
      throw new Error("mempool source unavailable")
    },
  }
  const service = new P2TRSignatureFraudWatchtowerService(
    {
      registeredWalletIDs: [`0x${"11".repeat(32)}`],
      submitChallenges: false,
      indexingStoreProfile: "transactional-production",
    },
    {
      bitcoinClient: {} as BitcoinClient,
      transactionSource: failingTransactionSource,
      bridgeLifecycleEventSource,
      persistence: transactionalChallengeRecordPersistence(),
      transactionCoordinator,
      alertSink: noopAlertSink,
    }
  )

  // Whether the cycle records the source failure or surfaces it, the cursor must
  // never be committed for a cycle with an incomplete transaction view.
  await service.processCycle().catch(() => undefined)

  assert.equal(committedBridgeLifecycleScan, false)
})

test("rejects transaction coordinators that suppress indexing operation failures", async () => {
  let activeTransactions = 0
  const bridgeLifecycleEventSource = {
    ...transactionalBridgeLifecycleSource(),
    async commitBridgeLifecycleScan() {
      throw new Error("cursor store unavailable")
    },
  }
  const transactionCoordinator: P2TRSignatureFraudWatchtowerTransactionCoordinator =
    {
      p2trSignatureFraudWatchtowerStoreProfile:
        "transactional-production" as const,
      p2trSignatureFraudWatchtowerTransactionalStoreID:
        "production-indexing-store",
      p2trSignatureFraudWatchtowerAtomicTransactions: true,
      assertP2TRSignatureFraudWatchtowerSharedStore() {},
      async runInP2TRSignatureFraudWatchtowerTransaction<T>(
        operation: () => Promise<T>
      ): Promise<T> {
        activeTransactions++
        try {
          return await operation()
        } catch {
          return emptyCycleReport().result as T
        } finally {
          activeTransactions--
        }
      },
      isP2TRSignatureFraudWatchtowerTransactionActive() {
        return activeTransactions > 0
      },
    }
  const service = new P2TRSignatureFraudWatchtowerService(
    {
      registeredWalletIDs: [`0x${"11".repeat(32)}`],
      submitChallenges: false,
      indexingStoreProfile: "transactional-production",
    },
    {
      bitcoinClient: {} as BitcoinClient,
      transactionSource: transactionalConfirmedTransactionSource(),
      bridgeLifecycleEventSource,
      persistence: transactionalChallengeRecordPersistence(),
      transactionCoordinator,
      alertSink: noopAlertSink,
    }
  )

  await assert.rejects(
    service.processCycle(),
    /transaction coordinator suppressed an indexing operation failure/
  )
})

test("does not retain rolled-back production lifecycle records across cycles", async () => {
  const vector = loadFirstSignatureFraudVector()
  const [observation] = extractP2TRSignatureFraudWitnessObservations(
    withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    ),
    vector.prevouts.map((prevout) => ({
      txid: prevout.txidHex,
      vout: prevout.vout,
      valueSats: prevout.valueSats,
      scriptPubKey: prevout.scriptPubKeyHex,
    })),
    [vector.walletIDHex],
    undefined,
    () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
    draftPayloadBounds,
    draftBridgeChallengeDomain
  )
  const rejectedRecord: P2TRWatchtowerChallengeRecord = {
    ...createP2TRWatchtowerChallengeRecord(observation.observationID),
    observation: {
      ...observation,
      spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
    },
    status: "rejected" as const,
    submissionAttempts: 1,
    lastError: "temporary submitter outage",
  }
  const persistence = new TransactionalRollbackChallengeRecordPersistence([
    serializeP2TRWatchtowerChallengeRecord(rejectedRecord),
  ])
  let failCursorCommit = true
  let activeTransactions = 0
  const bridgeLifecycleEventSource = {
    ...transactionalBridgeLifecycleSource(),
    async listBridgeLifecycleEvents() {
      return [
        {
          type: "timeout-eligible" as const,
          observationID: observation.observationID,
        },
      ]
    },
    async commitBridgeLifecycleScan() {
      if (failCursorCommit) {
        throw new Error("cursor store unavailable")
      }
    },
  }
  const transactionCoordinator: P2TRSignatureFraudWatchtowerTransactionCoordinator =
    {
      p2trSignatureFraudWatchtowerStoreProfile:
        "transactional-production" as const,
      p2trSignatureFraudWatchtowerTransactionalStoreID:
        "production-indexing-store",
      p2trSignatureFraudWatchtowerAtomicTransactions: true,
      assertP2TRSignatureFraudWatchtowerSharedStore() {},
      async runInP2TRSignatureFraudWatchtowerTransaction<T>(
        operation: () => Promise<T>
      ): Promise<T> {
        activeTransactions++
        try {
          const result = await operation()
          persistence.commitTransaction()
          return result
        } catch (error) {
          persistence.rollbackTransaction()
          throw error
        } finally {
          activeTransactions--
        }
      },
      isP2TRSignatureFraudWatchtowerTransactionActive() {
        return activeTransactions > 0
      },
    }
  const service = new P2TRSignatureFraudWatchtowerService(
    {
      registeredWalletIDs: [vector.walletIDHex],
      submitChallenges: false,
      indexingStoreProfile: "transactional-production",
    },
    {
      bitcoinClient: {} as BitcoinClient,
      transactionSource: transactionalConfirmedTransactionSource(),
      bridgeLifecycleEventSource,
      persistence,
      transactionCoordinator,
      alertSink: noopAlertSink,
    }
  )

  await assert.rejects(service.processCycle(), /cursor store unavailable/)
  assert.equal((await persistence.loadChallengeRecords())[0].status, "rejected")

  failCursorCommit = false
  await service.processCycle()

  const [storedRecord] = await persistence.loadChallengeRecords()
  assert.equal(storedRecord.status, "timeout-eligible")
})

test("applies Bridge lifecycle events and reports cycle metrics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const observationID = `0x${"22".repeat(32)}`
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    await persistence.saveChallengeRecords([
      serializeP2TRWatchtowerChallengeRecord(
        createP2TRWatchtowerChallengeRecord(observationID)
      ),
    ])
    let committedBridgeLifecycleScan = false
    const bridgeLifecycleEventSource: CommittingBridgeLifecycleEventSource = {
      async listBridgeLifecycleEvents() {
        return [
          {
            type: "timeout-eligible" as const,
            observationID,
          },
        ]
      },
      async commitBridgeLifecycleScan() {
        committedBridgeLifecycleScan = true
      },
    }

    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [`0x${"33".repeat(32)}`],
      },
      {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource,
        persistence,
      }
    )

    const report = await service.processCycle()

    assert.equal(report.metrics.bridgeLifecycleRecords, 1)
    assert.equal(report.metrics.sourceFailures, 0)
    assert.equal(report.metrics.totalRecords, 1)
    assert.equal(committedBridgeLifecycleScan, true)

    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.status, "timeout-eligible")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("commits Bridge lifecycle scans that only contain unrelated proof events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    let committedBridgeLifecycleScan = false
    const bridgeLifecycleEventSource: CommittingBridgeLifecycleEventSource = {
      async listBridgeLifecycleEvents() {
        return [
          {
            type: "honest-spend-proven" as const,
            bitcoinTxHash: `0x${"55".repeat(32)}`,
            spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
          },
        ]
      },
      async commitBridgeLifecycleScan() {
        committedBridgeLifecycleScan = true
      },
    }

    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [`0x${"33".repeat(32)}`],
      },
      {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource,
        persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
          statePath
        ),
      }
    )

    const report = await service.processCycle()

    assert.equal(report.result.bridgeLifecycle.records.length, 0)
    assert.equal(report.result.bridgeLifecycle.failures.length, 0)
    assert.equal(report.result.bridgeLifecycle.ignored.length, 1)
    assert.equal(report.metrics.bridgeLifecycleRecords, 0)
    assert.equal(report.metrics.bridgeLifecycleFailures, 0)
    assert.equal(report.metrics.bridgeLifecycleIgnored, 1)
    assert.equal(committedBridgeLifecycleScan, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("surfaces Bridge lifecycle scan cursor commit failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    let confirmedScanCommits = 0
    let confirmedScanAborts = 0
    const observationID = `0x${"22".repeat(32)}`
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    await persistence.saveChallengeRecords([
      serializeP2TRWatchtowerChallengeRecord(
        createP2TRWatchtowerChallengeRecord(observationID)
      ),
    ])
    const logs: {
      level: "info" | "warn" | "error"
      message: string
      fields?: Record<string, unknown>
    }[] = []
    const alerts: P2TRSignatureFraudWatchtowerServiceAlert[] = []
    const logger: P2TRSignatureFraudWatchtowerServiceLogger = {
      info(message, fields) {
        logs.push({ level: "info", message, fields })
      },
      warn(message, fields) {
        logs.push({ level: "warn", message, fields })
      },
      error(message, fields) {
        logs.push({ level: "error", message, fields })
      },
    }
    const bridgeLifecycleEventSource: CommittingBridgeLifecycleEventSource = {
      async listBridgeLifecycleEvents() {
        return [
          {
            type: "timeout-eligible" as const,
            observationID,
          },
        ]
      },
      async commitBridgeLifecycleScan() {
        throw new Error("cursor store unavailable")
      },
    }
    const transactionSource = {
      ...emptyTransactionSource,
      async commitConfirmedTransactionScan() {
        confirmedScanCommits++
      },
      abortConfirmedTransactionScan() {
        confirmedScanAborts++
      },
    }

    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [`0x${"33".repeat(32)}`],
      },
      {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource,
        bridgeLifecycleEventSource,
        persistence,
        logger,
        alertSink: {
          emitAlert(alert) {
            alerts.push(alert)
          },
        },
      }
    )

    await assert.rejects(service.processCycle(), /cursor store unavailable/)

    assert.equal(confirmedScanCommits, 1)
    assert.equal(confirmedScanAborts, 1)

    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.status, "timeout-eligible")

    const cursorFailureLog = logs.find(
      (log) =>
        log.level === "error" &&
        log.message === "P2TR watchtower Bridge lifecycle cursor commit failed"
    )
    assert.equal(cursorFailureLog?.fields?.error, "cursor store unavailable")
    assert.equal(cursorFailureLog?.fields?.storeId, "unmarked")
    assert.equal(cursorFailureLog?.fields?.bridgeIdentifier, "unconfigured")
    assert.equal(typeof cursorFailureLog?.fields?.cycleStartedAt, "string")
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].code, "bridge-lifecycle-cursor-commit-failed")
    assert.equal(alerts[0].severity, "error")
    assert.equal(alerts[0].fields.error, "cursor store unavailable")
    assert.equal(alerts[0].fields.storeId, "unmarked")
    assert.equal(alerts[0].fields.bridgeIdentifier, "unconfigured")
    assert.equal(typeof alerts[0].fields.cycleStartedAt, "string")
    assert.equal(
      logs.some(
        (log) =>
          log.level === "info" &&
          log.message === "P2TR watchtower cycle completed"
      ),
      false
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("emits cursor commit alerts after production transactions unwind", async () => {
  const observationID = `0x${"22".repeat(32)}`
  const persistence = new TransactionalRollbackChallengeRecordPersistence([
    serializeP2TRWatchtowerChallengeRecord(
      createP2TRWatchtowerChallengeRecord(observationID)
    ),
  ])
  let activeTransactions = 0
  let alertEmittedAfterTransaction = false
  const bridgeLifecycleEventSource = {
    ...transactionalBridgeLifecycleSource(),
    async listBridgeLifecycleEvents() {
      return [
        {
          type: "timeout-eligible" as const,
          observationID,
        },
      ]
    },
    async commitBridgeLifecycleScan() {
      throw new Error("cursor store unavailable")
    },
  }
  const transactionCoordinator: P2TRSignatureFraudWatchtowerTransactionCoordinator =
    {
      p2trSignatureFraudWatchtowerStoreProfile:
        "transactional-production" as const,
      p2trSignatureFraudWatchtowerTransactionalStoreID:
        "production-indexing-store",
      p2trSignatureFraudWatchtowerAtomicTransactions: true,
      assertP2TRSignatureFraudWatchtowerSharedStore() {},
      async runInP2TRSignatureFraudWatchtowerTransaction<T>(
        operation: () => Promise<T>
      ): Promise<T> {
        activeTransactions++
        try {
          const result = await operation()
          persistence.commitTransaction()
          return result
        } catch (error) {
          persistence.rollbackTransaction()
          throw error
        } finally {
          activeTransactions--
        }
      },
      isP2TRSignatureFraudWatchtowerTransactionActive() {
        return activeTransactions > 0
      },
    }
  const service = new P2TRSignatureFraudWatchtowerService(
    {
      registeredWalletIDs: [`0x${"33".repeat(32)}`],
      bridgeIdentifier: "sepolia-bridge",
      submitChallenges: false,
      indexingStoreProfile: "transactional-production",
    },
    {
      bitcoinClient: {} as BitcoinClient,
      transactionSource: transactionalConfirmedTransactionSource(),
      bridgeLifecycleEventSource,
      persistence,
      transactionCoordinator,
      alertSink: {
        emitAlert(alert) {
          if (alert.code === "bridge-lifecycle-cursor-commit-failed") {
            alertEmittedAfterTransaction = activeTransactions === 0
          }
        },
      },
    }
  )

  await assert.rejects(service.processCycle(), /cursor store unavailable/)

  assert.equal(alertEmittedAfterTransaction, true)
})

test("logs source and item failure details for operator triage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")
  const bridgeLifecycleEvent = {
    type: "slashed" as const,
    bridgeChallengeKey: "0x1234",
    slashingTxHash: `0x${"55".repeat(32)}`,
  }
  const logs: {
    level: "info" | "warn" | "error"
    message: string
    fields?: Record<string, unknown>
  }[] = []
  const alerts: P2TRSignatureFraudWatchtowerServiceAlert[] = []
  const logger: P2TRSignatureFraudWatchtowerServiceLogger = {
    info(message, fields) {
      logs.push({ level: "info", message, fields })
    },
    warn(message, fields) {
      logs.push({ level: "warn", message, fields })
    },
    error(message, fields) {
      logs.push({ level: "error", message, fields })
    },
  }

  try {
    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [`0x${"33".repeat(32)}`],
      },
      {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: {
          async listMempoolTransactions() {
            throw new Error("mempool source unavailable")
          },
          async listConfirmedTransactions() {
            return { transactions: [], complete: true }
          },
        },
        bridgeLifecycleEventSource: {
          async listBridgeLifecycleEvents() {
            return [bridgeLifecycleEvent]
          },
        },
        persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
          statePath
        ),
        logger,
        alertSink: {
          emitAlert(alert) {
            alerts.push(alert)
          },
        },
      }
    )

    const report = await service.processCycle()

    assert.equal(report.metrics.sourceFailures, 1)
    assert.equal(report.metrics.bridgeLifecycleFailures, 1)

    const sourceFailureLog = logs.find(
      (log) =>
        log.level === "error" &&
        log.message === "P2TR watchtower source failures"
    )
    assert.deepEqual(sourceFailureLog?.fields?.sourceFailures, [
      { source: "mempool", error: "mempool source unavailable" },
    ])

    const itemFailureLog = logs.find(
      (log) =>
        log.level === "warn" && log.message === "P2TR watchtower item failures"
    )
    assert.equal(itemFailureLog?.fields?.itemFailures, 1)
    assert.deepEqual(itemFailureLog?.fields?.mempoolFailures, {
      count: 0,
      truncated: false,
      sample: [],
    })
    assert.deepEqual(itemFailureLog?.fields?.confirmedFailures, {
      count: 0,
      truncated: false,
      sample: [],
    })

    const bridgeLifecycleFailures = itemFailureLog?.fields
      ?.bridgeLifecycleFailures as Record<string, unknown> | undefined
    assert.equal(bridgeLifecycleFailures?.count, 1)
    assert.equal(bridgeLifecycleFailures?.truncated, false)
    const bridgeLifecycleFailureSample = bridgeLifecycleFailures?.sample as
      | Record<string, unknown>[]
      | undefined
    assert.deepEqual(
      bridgeLifecycleFailureSample?.[0].event,
      bridgeLifecycleEvent
    )
    assert.equal(
      bridgeLifecycleFailureSample?.[0].bridgeChallengeKey,
      bridgeLifecycleEvent.bridgeChallengeKey
    )
    assert.equal(typeof bridgeLifecycleFailureSample?.[0].error, "string")
    assert.equal(alerts.length, 2)
    assert.equal(alerts[0].code, "watchtower-source-failures")
    assert.equal(alerts[0].severity, "error")
    assert.deepEqual(alerts[0].fields?.sourceFailures, [
      { source: "mempool", error: "mempool source unavailable" },
    ])
    assert.equal(alerts[1].code, "watchtower-item-failures")
    assert.equal(alerts[1].severity, "warning")
    assert.equal(alerts[1].fields?.itemFailures, 1)
    assert.equal(alerts[1].fields.bridgeLifecycleFailures.count, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("alerts on unresolved operator alerts without blocking cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")
  const alerts: P2TRSignatureFraudWatchtowerServiceAlert[] = []

  try {
    const persistence = new FileBackedP2TRWatchtowerChallengeRecordPersistence(
      statePath
    )
    await persistence.saveChallengeRecords([
      {
        ...serializeP2TRWatchtowerChallengeRecord(
          createP2TRWatchtowerChallengeRecord(`0x${"66".repeat(32)}`)
        ),
        operatorAlertStatus: "open",
        operatorAlertCode: "submission-retry-limit",
        operatorAlertMessage: "manual intervention required",
      },
    ])
    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [`0x${"33".repeat(32)}`],
      },
      {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence,
        alertSink: {
          emitAlert(alert) {
            alerts.push(alert)
          },
        },
      }
    )

    const report = await service.processCycle()
    const duplicateReport = await service.processCycle()

    assert.equal(report.metrics.unresolvedOperatorAlerts, 1)
    assert.equal(duplicateReport.metrics.unresolvedOperatorAlerts, 1)
    assert.deepEqual(alerts, [
      {
        code: "watchtower-operator-alerts-open",
        severity: "warning",
        message: "P2TR watchtower operator alerts open",
        fields: {
          unresolvedOperatorAlerts: 1,
        },
      },
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps alert sink failures from failing completed cycles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")
  const logs: {
    level: "info" | "warn" | "error"
    message: string
    fields?: Record<string, unknown>
  }[] = []

  try {
    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [`0x${"33".repeat(32)}`],
      },
      {
        bitcoinClient: {} as BitcoinClient,
        transactionSource: {
          async listMempoolTransactions() {
            throw new Error("mempool source unavailable")
          },
          async listConfirmedTransactions() {
            return { transactions: [], complete: true }
          },
        },
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
          statePath
        ),
        logger: {
          info(message, fields) {
            logs.push({ level: "info", message, fields })
          },
          warn(message, fields) {
            logs.push({ level: "warn", message, fields })
          },
          error(message, fields) {
            logs.push({ level: "error", message, fields })
          },
        },
        alertSink: {
          emitAlert() {
            throw new Error("alert backend unavailable")
          },
        },
      }
    )

    const report = await service.processCycle()

    assert.equal(report.metrics.sourceFailures, 1)
    assert.equal(report.metrics.alertSinkFailures, 1)
    assert.deepEqual(
      logs.find(
        (log) =>
          log.level === "error" &&
          log.message === "P2TR watchtower alert sink failed"
      )?.fields,
      {
        alertCode: "watchtower-source-failures",
        error: "alert backend unavailable",
      }
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("does not commit Bridge lifecycle scan cursor after event failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    let committedBridgeLifecycleScan = false
    const service = new P2TRSignatureFraudWatchtowerService(
      {
        registeredWalletIDs: [`0x${"33".repeat(32)}`],
      },
      {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: committingBridgeLifecycleSource({
          async listBridgeLifecycleEvents() {
            return [
              {
                type: "timeout-eligible" as const,
                observationID: `0x${"44".repeat(32)}`,
              },
            ]
          },
          async commitBridgeLifecycleScan() {
            committedBridgeLifecycleScan = true
          },
        }),
        persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
          statePath
        ),
      }
    )

    const report = await service.processCycle()

    assert.equal(report.metrics.bridgeLifecycleFailures, 1)
    assert.equal(committedBridgeLifecycleScan, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("runs watchtower loop cycles sequentially with report callbacks", async () => {
  let cycleCount = 0
  let concurrentCycles = 0
  let maxConcurrentCycles = 0
  const reports: P2TRSignatureFraudWatchtowerCycleReport[] = []

  const result = await runP2TRSignatureFraudWatchtowerLoop(
    {
      async processCycle() {
        cycleCount++
        concurrentCycles++
        maxConcurrentCycles = Math.max(maxConcurrentCycles, concurrentCycles)
        concurrentCycles--
        return emptyCycleReport()
      },
    },
    {
      pollIntervalMs: 1,
      maxCycles: 3,
      delay: async () => {},
      onCycleReport: (report) => {
        reports.push(report)
      },
    }
  )

  assert.equal(cycleCount, 3)
  assert.equal(maxConcurrentCycles, 1)
  assert.equal(reports.length, 3)
  assert.deepEqual(result, {
    cyclesAttempted: 3,
    cyclesSucceeded: 3,
    cyclesFailed: 0,
    stoppedBySignal: false,
  })
})

test("stops watchtower loop after abort without starting another cycle", async () => {
  const abortController = new AbortController()
  let cycleCount = 0

  const result = await runP2TRSignatureFraudWatchtowerLoop(
    {
      async processCycle() {
        cycleCount++
        abortController.abort()
        return emptyCycleReport()
      },
    },
    {
      pollIntervalMs: 1,
      signal: abortController.signal,
    }
  )

  assert.equal(cycleCount, 1)
  assert.deepEqual(result, {
    cyclesAttempted: 1,
    cyclesSucceeded: 1,
    cyclesFailed: 0,
    stoppedBySignal: true,
  })
})

test("makes watchtower loop cycle failure policy explicit", async () => {
  const failures: string[] = []
  let cycleCount = 0

  const result = await runP2TRSignatureFraudWatchtowerLoop(
    {
      async processCycle() {
        cycleCount++

        if (cycleCount === 1) {
          throw new Error("source supervisor unavailable")
        }

        return emptyCycleReport()
      },
    },
    {
      pollIntervalMs: 1,
      maxCycles: 2,
      continueOnError: true,
      delay: async () => {},
      onCycleError: (error) => {
        failures.push((error as Error).message)
      },
    }
  )

  assert.deepEqual(failures, ["source supervisor unavailable"])
  assert.deepEqual(result, {
    cyclesAttempted: 2,
    cyclesSucceeded: 1,
    cyclesFailed: 1,
    stoppedBySignal: false,
  })

  await assert.rejects(
    runP2TRSignatureFraudWatchtowerLoop(
      {
        async processCycle() {
          throw new Error("fatal cycle failure")
        },
      },
      {
        pollIntervalMs: 1,
        maxCycles: 2,
      }
    ),
    /fatal cycle failure/
  )
})

function withInputWitness(
  unsignedTransactionHex: string,
  inputIndex: number,
  witnessSignatureHex: string
): BitcoinRawTx {
  const transaction = Transaction.fromHex(unsignedTransactionHex)
  transaction.ins[inputIndex].witness = [
    Buffer.from(witnessSignatureHex, "hex"),
  ]

  return { transactionHex: transaction.toHex() }
}

function rawPreviousTransactionForPrevout(
  prevout: SignatureFraudVector["prevouts"][number]
): BitcoinRawTx {
  const transaction = new Transaction()
  transaction.addInput(Buffer.alloc(32), 0xffffffff)

  for (let i = 0; i <= prevout.vout; i++) {
    transaction.addOutput(
      Buffer.from(i === prevout.vout ? prevout.scriptPubKeyHex : "51", "hex"),
      i === prevout.vout ? Number(prevout.valueSats) : 1
    )
  }

  return { transactionHex: transaction.toHex() }
}

function loadFirstSignatureFraudVector(): SignatureFraudVector {
  return loadSignatureFraudVectors("p2tr-signature-fraud-v0.json")[0]
}

function loadFlexibleSignatureFraudVector(): SignatureFraudVector {
  const vector = loadSignatureFraudVectors(
    "p2tr-signature-fraud-full-sighash-v0.json"
  ).find(
    (candidate) => candidate.id === "bip341-keypath-anyonecanpay-none-multi"
  )

  if (vector === undefined) {
    throw new Error("Missing ANYONECANPAY|NONE P2TR signature-fraud vector")
  }

  return vector
}

function loadSignatureFraudVectors(fileName: string): SignatureFraudVector[] {
  return JSON.parse(
    readFileSync(
      join(
        // Resolve relative to this test file (services/watchtower/test), not
        // process.cwd(): the suite runs with cwd=services/watchtower, where
        // "../../../docs" would escape the repo. From the test directory the
        // three "../" segments reach the repo-root docs/ directory.
        dirname(fileURLToPath(import.meta.url)),
        "../../../docs/test-vectors",
        fileName
      ),
      "utf8"
    )
  ).cases as SignatureFraudVector[]
}
