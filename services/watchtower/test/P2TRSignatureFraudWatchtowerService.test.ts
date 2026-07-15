import assert from "assert/strict"
import { readFileSync } from "fs"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import test from "node:test"

import {
  BitcoinClient,
  BitcoinRawTx,
  createP2TRWatchtowerChallengeRecord,
  extractP2TRSignatureFraudWitnessObservations,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING,
  P2TRSignatureFraudChallengeSubmitter,
  P2TRSignatureFraudChallengeSubmissionPolicy,
  P2TRSignatureFraudPayloadBounds,
  P2TRSignatureFraudWitnessObservation,
  P2TRSignatureFraudWatchtowerBridgeLifecycleEvent,
  P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource,
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
  async listConfirmedTransactions(): Promise<
    P2TRWatchtowerConfirmedTransaction[]
  > {
    return []
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
      return operation()
    },
    transactionCount() {
      return transactionCount
    },
  }

  return coordinator
}

class FakeSubmitter implements P2TRSignatureFraudChallengeSubmitter {
  readonly p2trSignatureFraudWatchtowerIdempotentSubmissions = true
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
    sourceFailures: [],
    summary: {
      total: 0,
      byStatus: {
        observed: 0,
        submitting: 0,
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
  },
})

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
          async getBlockNumber() {
            return 150
          },
          async getCanonicalBlockHash() {
            return lifecycleBlockHash
          },
          async verifyLifecycleLog() {
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

test("rejects mutated persisted observations before replay submission", async () => {
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
    const rejectedRecord = {
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
        submitChallenges: true,
        ...draftSingleProcessRehearsalSubmission,
        submissionPolicy: {
          allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION],
        },
        maxSubmissionAttempts: 3,
        submissionAttemptLimitAlert: draftSubmissionAttemptLimitAlert,
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

    await assert.rejects(
      service.processCycle(),
      /Watchtower observation fields do not match reconstructed witness data/
    )
    assert.equal(submitter.submissionCount, 0)

    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.status, "rejected")
    assert.equal(storedRecord.submissionAttempts, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("replays stored rejected challenges during a service cycle after restart", async () => {
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
    const rejectedRecord = {
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
        submitChallenges: true,
        ...draftSingleProcessRehearsalSubmission,
        maxSubmissionAttempts: 3,
        submissionAttemptLimitAlert: draftSubmissionAttemptLimitAlert,
        submissionPolicy: draftRedemptionSubmissionPolicy,
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

    assert.equal(submitter.submissionCount, 1)
    assert.equal(report.metrics.replayedRecords, 1)
    assert.equal(report.metrics.replayedSubmissions, 1)
    assert.equal(report.metrics.replayedSubmissionAttempts, 1)
    assert.equal(report.metrics.totalRecords, 1)

    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.status, "submitted")
    assert.equal(storedRecord.challengeTxHash, "ab".repeat(32))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("keeps rejected challenges replayable when lifecycle verification fails", async () => {
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
        submitChallenges: true,
        ...draftSingleProcessRehearsalSubmission,
        maxSubmissionAttempts: 5,
        submissionAttemptLimitAlert: draftSubmissionAttemptLimitAlert,
        submissionPolicy: draftRedemptionSubmissionPolicy,
        payloadBounds: draftPayloadBounds,
        bridgeChallengeDomain: draftBridgeChallengeDomain,
        spendTypeClassifier: () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
      {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: {
          p2trSignatureFraudWatchtowerIdempotentSubmissions: true,
          async submitSignatureFraudChallenge() {
            submissionCount++
            throw new Error("temporary submitter outage")
          },
        },
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
    assert.equal(submissionCount, 2)
    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.status, "rejected")
    assert.equal(storedRecord.submissionAttempts, 3)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("wires file-backed runtime config into service and loop options", async () => {
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
    const rejectedRecord = {
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
          submitChallenges: true,
          ...draftSingleProcessRehearsalSubmission,
          maxSubmissionAttempts: 3,
          submissionAttemptLimitAlert: draftSubmissionAttemptLimitAlert,
          submissionPolicy: draftRedemptionSubmissionPolicy,
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

    assert.equal(submitter.submissionCount, 1)
    assert.equal(report.metrics.replayedRecords, 1)
    assert.equal(report.metrics.replayedSubmissions, 1)
    assert.equal(report.metrics.replayedSubmissionAttempts, 1)
    assert.equal(report.metrics.totalRecords, 1)

    const [storedRecord] = JSON.parse(await readFile(statePath, "utf8"))
    assert.equal(storedRecord.status, "submitted")
    assert.equal(storedRecord.challengeTxHash, "ab".repeat(32))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("builds an environment-backed submission runtime with an injected classifier", () => {
  const config = loadP2TRSignatureFraudWatchtowerRuntimeConfig(
    submissionRuntimeEnv()
  )

  assert.deepEqual(config.service.submissionPolicy, {
    allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION],
  })
  assert.equal(config.service.spendTypeClassifier, undefined)

  const runtime = createFileBackedP2TRSignatureFraudWatchtowerRuntime(
    config,
    {
      bitcoinClient: {} as BitcoinClient,
      challengeSubmitter: new FakeSubmitter(),
      transactionSource: emptyTransactionSource,
      bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
    },
    { spendTypeClassifier: () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION }
  )

  assert.ok(runtime.service instanceof P2TRSignatureFraudWatchtowerService)
})

test("rejects an environment-backed submission runtime without an injected classifier", () => {
  const config = loadP2TRSignatureFraudWatchtowerRuntimeConfig(
    submissionRuntimeEnv()
  )

  assert.throws(
    () =>
      createFileBackedP2TRSignatureFraudWatchtowerRuntime(config, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
      }),
    /requires an injected spend-type classifier/
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
    const rejectedRecord = {
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
    assert.equal(report.metrics.replayedSubmissions, 1)
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

test("passes configured spend-type classifier into live submissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p2tr-watchtower-"))
  const statePath = join(directory, "records.json")

  try {
    const vector = loadFirstSignatureFraudVector()
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
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
        submitChallenges: true,
        ...draftSingleProcessRehearsalSubmission,
        submissionPolicy: {
          allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION],
        },
        maxSubmissionAttempts: 3,
        submissionAttemptLimitAlert: draftSubmissionAttemptLimitAlert,
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
            return [{ rawTransaction, bitcoinTxHash: `0x${"44".repeat(32)}` }]
          },
          async listConfirmedTransactions() {
            return []
          },
        },
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence,
      }
    )

    const report = await service.processCycle()

    assert.equal(classifierCalls, 2)
    assert.equal(submitter.submissionCount, 1)
    assert.equal(report.metrics.mempoolObservations, 1)
    assert.equal(report.metrics.mempoolSubmissions, 1)
    assert.equal(report.metrics.mempoolSubmissionAttempts, 1)

    const [storedRecord] = await persistence.loadChallengeRecords()
    assert.equal(storedRecord.status, "submitted")
    assert.equal(
      storedRecord.observation?.spendType,
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )
    assert.equal(
      storedRecord.observation?.bridgeChallengeKey,
      "5b9c84557643f90b47ab9bcc49ff7dba8cfe283f1c37524a1e1db4316b34252f"
    )
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
                bitcoinTxHash: `0x${"44".repeat(32)}`,
                walletInputKeyBindings: [
                  {
                    txid: signedPrevout.txidHex,
                    vout: signedPrevout.vout,
                    outputKey: depositOutputKey,
                    walletID: vector.walletIDHex,
                  },
                ],
              },
            ]
          },
          async listConfirmedTransactions() {
            return []
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

test("requires a challenge submitter only when submissions are enabled", () => {
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
    /requires a challenge submitter when submissions are enabled/
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

test("requires an approved spend-type policy when submissions are enabled", () => {
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
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      ),
    /requires at least one approved spend type when submissions are enabled/
  )
})

test("keeps unresolved spend types fail-closed for submissions", () => {
  ;[
    P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
    P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING,
    P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT,
  ].forEach((spendType) => {
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
      new RegExp(`spend type ${spendType} is fail-closed`)
    )
  })
})

test("requires explicit payload bounds when submissions are enabled", () => {
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
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
          persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
            "/tmp/p2tr-watchtower-state.json"
          ),
        }
      ),
    /requires explicit payload bounds when submissions are enabled/
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
    /input payload bound must be a positive integer/
  )
})

test("requires a Bridge challenge domain when submissions are enabled", () => {
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
    /requires a Bridge challenge domain when submissions are enabled/
  )
})

test("requires a spend-type classifier when submissions are enabled", () => {
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
    /requires a spend-type classifier when submissions are enabled/
  )
})

test("requires a submission-attempt alert when submissions are enabled", () => {
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
    /requires a submission-attempt ceiling and alert when submissions are enabled/
  )
})

test("requires a transactional indexing store or rehearsal override when submissions are enabled", () => {
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
    /requires a transactional production indexing store or explicit single-process rehearsal override/
  )

  assert.doesNotThrow(
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
          transactionSource: emptyTransactionSource,
          bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
          persistence: transactionalChallengeRecordPersistence(),
          transactionCoordinator: transactionalCoordinator(),
          alertSink: noopAlertSink,
        }
      )
  )
})

test("requires transactional-production dependencies for the production indexing profile", () => {
  const productionSubmissionConfig = {
    registeredWalletIDs: [`0x${"11".repeat(32)}`],
    submitChallenges: true,
    indexingStoreProfile: "transactional-production" as const,
    submissionPolicy: draftRedemptionSubmissionPolicy,
    payloadBounds: draftPayloadBounds,
    bridgeChallengeDomain: draftBridgeChallengeDomain,
    spendTypeClassifier: () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
    maxSubmissionAttempts: 3,
    submissionAttemptLimitAlert: draftSubmissionAttemptLimitAlert,
  }

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence: {
          async loadChallengeRecords() {
            return []
          },
          async saveChallengeRecords() {},
        },
      }),
    /transactional-production indexing profile requires challenge-record persistence marked as transactional-production; got unmarked/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
          "/tmp/p2tr-watchtower-state.json"
        ),
      }),
    /transactional-production indexing profile requires challenge-record persistence marked as transactional-production; got single-process-rehearsal/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: singleProcessBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
      }),
    /transactional-production indexing profile requires Bridge lifecycle event source marked as transactional-production; got single-process-rehearsal/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: emptyBridgeLifecycleSource,
        persistence: transactionalChallengeRecordPersistence(),
      }),
    /transactional-production indexing profile requires Bridge lifecycle event source marked as transactional-production; got unmarked/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: {
          ...transactionalChallengeRecordPersistence(),
          p2trSignatureFraudWatchtowerTransactionalStoreID: undefined,
        },
      }),
    /transactional-production indexing profile requires challenge-record persistence to declare a transactional store ID/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource:
          transactionalBridgeLifecycleSource("cursor-store"),
        persistence: transactionalChallengeRecordPersistence(
          "challenge-record-store"
        ),
        transactionCoordinator: transactionalCoordinator(
          "challenge-record-store"
        ),
      }),
    /transactional-production indexing profile requires challenge-record persistence, Bridge lifecycle event source, and transaction coordinator to share the same transactional store ID/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
      }),
    /transactional-production indexing profile requires a transaction coordinator/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: {
          ...transactionalCoordinator(),
          p2trSignatureFraudWatchtowerAtomicTransactions: false,
        } as unknown as P2TRSignatureFraudWatchtowerTransactionCoordinator,
      }),
    /transactional-production indexing profile requires a transaction coordinator that declares atomic rollback-on-error semantics/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: {
          ...transactionalCoordinator(),
          p2trSignatureFraudWatchtowerTransactionalStoreID: "coordinator-store",
        },
      }),
    /transactional-production indexing profile requires challenge-record persistence, Bridge lifecycle event source, and transaction coordinator to share the same transactional store ID/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: new FakeSubmitter(),
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: {
          ...transactionalCoordinator(),
          assertP2TRSignatureFraudWatchtowerSharedStore() {
            throw new Error(
              "coordinator does not own both transactional handles"
            )
          },
        },
      }),
    /coordinator does not own both transactional handles/
  )

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(productionSubmissionConfig, {
        bitcoinClient: {} as BitcoinClient,
        challengeSubmitter: {
          async submitSignatureFraudChallenge(): Promise<string> {
            return `0x${"cd".repeat(32)}`
          },
        },
        transactionSource: emptyTransactionSource,
        bridgeLifecycleEventSource: transactionalBridgeLifecycleSource(),
        persistence: transactionalChallengeRecordPersistence(),
        transactionCoordinator: transactionalCoordinator(),
      }),
    /transactional-production indexing profile requires an idempotent challenge submitter/
  )
})

test("requires an alert sink for the transactional-production indexing profile", () => {
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
          transactionSource: emptyTransactionSource,
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
      transactionSource: emptyTransactionSource,
      bridgeLifecycleEventSource,
      persistence: transactionalChallengeRecordPersistence(),
      transactionCoordinator,
      alertSink: noopAlertSink,
    }
  )

  await service.processCycle()

  assert.equal(transactionCount, 1)
  assert.equal(committedBridgeLifecycleScanInTransaction, true)
})

test("does not commit the Bridge lifecycle cursor when a transaction source fails", async () => {
  let committedBridgeLifecycleScan = false
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
        return await operation()
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
  const failingTransactionSource: P2TRSignatureFraudWatchtowerTransactionSource =
    {
      async listMempoolTransactions() {
        throw new Error("mempool source unavailable")
      },
      async listConfirmedTransactions() {
        return []
      },
    }
  const service = new P2TRSignatureFraudWatchtowerService(
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
        try {
          return await operation()
        } catch {
          return emptyCycleReport().result as T
        }
      },
    }
  const service = new P2TRSignatureFraudWatchtowerService(
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
      transactionSource: emptyTransactionSource,
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

test("does not retain rolled-back production transaction records across cycles", async () => {
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
  const rejectedRecord = {
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
  const submitter = new FakeSubmitter()
  let failCursorCommit = true
  const bridgeLifecycleEventSource = {
    ...transactionalBridgeLifecycleSource(),
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
        try {
          const result = await operation()
          persistence.commitTransaction()
          return result
        } catch (error) {
          persistence.rollbackTransaction()
          throw error
        }
      },
    }
  const service = new P2TRSignatureFraudWatchtowerService(
    {
      registeredWalletIDs: [vector.walletIDHex],
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
      challengeSubmitter: submitter,
      transactionSource: emptyTransactionSource,
      bridgeLifecycleEventSource,
      persistence,
      transactionCoordinator,
      alertSink: noopAlertSink,
    }
  )

  await assert.rejects(service.processCycle(), /cursor store unavailable/)
  assert.equal(submitter.submissionCount, 1)
  assert.equal((await persistence.loadChallengeRecords())[0].status, "rejected")

  failCursorCommit = false
  await service.processCycle()

  assert.equal(submitter.submissionCount, 1)
  const [storedRecord] = await persistence.loadChallengeRecords()
  assert.equal(storedRecord.status, "submitted")
  assert.equal(storedRecord.challengeTxHash, "ab".repeat(32))
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
    const bridgeLifecycleEventSource = {
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
    const bridgeLifecycleEventSource = {
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
    const bridgeLifecycleEventSource = {
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
        logger,
        alertSink: {
          emitAlert(alert) {
            alerts.push(alert)
          },
        },
      }
    )

    await assert.rejects(service.processCycle(), /cursor store unavailable/)

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
    }
  const service = new P2TRSignatureFraudWatchtowerService(
    {
      registeredWalletIDs: [`0x${"33".repeat(32)}`],
      bridgeIdentifier: "sepolia-bridge",
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
      transactionSource: emptyTransactionSource,
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
    bridgeChallengeKey: `0x${"44".repeat(32)}`,
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
            return []
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
            return []
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
        bridgeLifecycleEventSource: {
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
        },
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
      onCycleReport: (report) => reports.push(report),
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
      onCycleError: (error) => failures.push((error as Error).message),
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
  return JSON.parse(
    readFileSync(
      join(
        // Resolve relative to this test file (services/watchtower/test), not
        // process.cwd(): the suite runs with cwd=services/watchtower, where
        // "../../../docs" would escape the repo. From the test directory the
        // three "../" segments reach the repo-root docs/ directory.
        dirname(fileURLToPath(import.meta.url)),
        "../../../docs/test-vectors/p2tr-signature-fraud-v0.json"
      ),
      "utf8"
    )
  ).cases[0] as SignatureFraudVector
}
