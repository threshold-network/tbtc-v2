import assert from "node:assert/strict"
import test from "node:test"

import {
  Hex,
  P2TRSignatureFraudChallengeTransactionPreparer,
  P2TRSignatureFraudPreparedChallengeTransaction,
  P2TRSignatureFraudSubmissionIntent,
  P2TRWatchtowerChallengeRecord,
  computeP2TRSignatureFraudSubmissionIntentID,
} from "@keep-network/tbtc-v2.ts"

import {
  P2TRSignatureFraudChallengeOutboxDispatcher,
  P2TRSignatureFraudChallengeOutboxReconciler,
  P2TRSignatureFraudChallengeOutboxRecord,
  P2TRSignatureFraudChallengeOutboxResolution,
  P2TRSignatureFraudChallengeOutboxScheduler,
  P2TRSignatureFraudChallengeOutboxStatus,
  P2TRSignatureFraudChallengeOutboxStore,
  P2TRSignatureFraudLegacySubmissionQuarantine,
  P2TRSignatureFraudOutboxEvidenceCheckpoint,
  P2TRSignatureFraudRawTransactionBroadcaster,
  quarantineLegacyP2TRSignatureFraudSubmissions,
} from "../src/P2TRSignatureFraudChallengeOutbox.js"

const RAW_TRANSACTION =
  "0xf8680702830f42409422222222222222222222222222222222222222228204d28212348401546d71a0729899f82397fce792b92e19338f8ae9687f82fa5460a227d21f904ab1684f13a02a784aace7625ce273add6273bf035fd503be4c29a390bdf85df1160cd2c35ab"
const TRANSACTION_HASH =
  "0x195d980c04cae718b20cd0518230fcc40284ea686a2f801d68f340fe57474036"
const TRANSACTION_SENDER = "0x17c5185167401eD00cF5F5b2fc97D9BBfDb7D025"
const ROUTER_ADDRESS = "0x2222222222222222222222222222222222222222"
const BRIDGE_ADDRESS = "0x1111111111111111111111111111111111111111"
const CHALLENGE_KEY = `0x${"aa".repeat(32)}`
const WALLET_ID = `0x${"bb".repeat(32)}`
const CHALLENGE_IDENTITY = `0x${"cc".repeat(32)}`
const SIGHASH = `0x${"dd".repeat(32)}`

const normalizeKey = (value: Hex | string): string =>
  value instanceof Hex
    ? value.toPrefixedString().toLowerCase()
    : value.toLowerCase()

class InMemoryOutboxStore implements P2TRSignatureFraudChallengeOutboxStore {
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID = "outbox.test"
  readonly records = new Map<string, P2TRSignatureFraudChallengeOutboxRecord>()
  readonly quarantines: P2TRSignatureFraudLegacySubmissionQuarantine[] = []

  async insertIfAbsent(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const key = normalizeKey(record.intent.intentID)
    const existing = this.records.get(key)
    if (existing !== undefined) {
      return existing
    }
    this.records.set(key, record)
    return record
  }

  async get(
    intentID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    return this.records.get(normalizeKey(intentID))
  }

  async compareAndSwap(
    intentID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    const key = normalizeKey(intentID)
    const current = this.records.get(key)
    if (
      current === undefined ||
      current.version !== expectedVersion ||
      next.version !== expectedVersion + 1 ||
      normalizeKey(next.intent.intentID) !== key
    ) {
      return false
    }
    this.records.set(key, next)
    return true
  }

  async list(
    statuses?: P2TRSignatureFraudChallengeOutboxStatus[]
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord[]> {
    const records = [...this.records.values()]
    return statuses === undefined
      ? records
      : records.filter((record) => statuses.includes(record.status))
  }

  async saveLegacyQuarantine(
    quarantine: P2TRSignatureFraudLegacySubmissionQuarantine
  ): Promise<void> {
    this.quarantines.push(quarantine)
  }
}

class FixedPreparer implements P2TRSignatureFraudChallengeTransactionPreparer {
  calls = 0

  async prepareSignatureFraudChallengeTransaction(
    intent: P2TRSignatureFraudSubmissionIntent
  ): Promise<P2TRSignatureFraudPreparedChallengeTransaction> {
    this.calls++
    await Promise.resolve()
    return {
      intentID: intent.intentID,
      rawTransaction: RAW_TRANSACTION,
      transactionHash: Hex.from(TRANSACTION_HASH),
      sender: TRANSACTION_SENDER,
      nonce: 7,
    }
  }
}

class RecordingBroadcaster
  implements P2TRSignatureFraudRawTransactionBroadcaster
{
  readonly submissionTrustDomainID = "submission.test"
  readonly providerIdentity = {}
  readonly rawTransactions: string[] = []
  throwAfterSend = false
  inspectDurableBoundary?: () => Promise<void>

  async broadcastRawTransaction(rawTransaction: string): Promise<string> {
    await this.inspectDurableBoundary?.()
    this.rawTransactions.push(rawTransaction)
    if (this.throwAfterSend) {
      throw new Error("provider timed out after accepting bytes")
    }
    return TRANSACTION_HASH
  }
}

class FixedReconciler implements P2TRSignatureFraudChallengeOutboxReconciler {
  readonly reconciliationTrustDomainID = "reconciliation.test"
  readonly providerIdentity = {}
  readonly finalityConfirmationBlocks = 12
  resolution: P2TRSignatureFraudChallengeOutboxResolution = {
    status: "pending",
    reason: "transaction is not final",
  }

  async reconcileSignatureFraudChallengeOutbox(): Promise<P2TRSignatureFraudChallengeOutboxResolution> {
    return this.resolution
  }
}

const createIntent = (): P2TRSignatureFraudSubmissionIntent => {
  const withoutID: Omit<P2TRSignatureFraudSubmissionIntent, "intentID"> = {
    observationID: Hex.from(CHALLENGE_KEY),
    bridgeChallengeKey: Hex.from(CHALLENGE_KEY),
    walletID: Hex.from(WALLET_ID),
    bridgeChallengeIdentity: Hex.from(CHALLENGE_IDENTITY),
    sighash: Hex.from(SIGHASH),
    chainID: 11155111,
    bridgeAddress: BRIDGE_ADDRESS,
    routerAddress: ROUTER_ADDRESS,
    calldata: "0x1234",
    value: "1234",
  }
  return {
    ...withoutID,
    intentID: computeP2TRSignatureFraudSubmissionIntentID(withoutID),
  }
}

const createChallengeRecord = (): P2TRWatchtowerChallengeRecord =>
  ({
    observationID: Hex.from(CHALLENGE_KEY),
    observation: {
      observationID: Hex.from(CHALLENGE_KEY),
      bridgeChallengeKey: Hex.from(CHALLENGE_KEY),
    },
    status: "observed",
    submissionAttempts: 0,
    bitcoinStatus: "confirmed",
    bitcoinTxHash: Hex.from(`0x${"01".repeat(32)}`),
    bitcoinBlockHash: Hex.from(`0x${"02".repeat(32)}`),
    bitcoinBlockHeight: 100,
  } as P2TRWatchtowerChallengeRecord)

const evidenceCheckpoint = (): P2TRSignatureFraudOutboxEvidenceCheckpoint => ({
  confirmedSourceComplete: true,
  bitcoinTxHash: `0x${"01".repeat(32)}`,
  bitcoinBlockHash: `0x${"02".repeat(32)}`,
  bitcoinBlockHeight: 100,
  bitcoinCursorBlockHash: `0x${"03".repeat(32)}`,
  bitcoinCursorBlockHeight: 120,
  ethereumLifecycleBlockHash: `0x${"04".repeat(32)}`,
  ethereumLifecycleBlockNumber: 500,
  submittedEventScanFromBlock: 50,
})

const enqueue = async (
  store: InMemoryOutboxStore
): Promise<P2TRSignatureFraudChallengeOutboxRecord> =>
  new P2TRSignatureFraudChallengeOutboxScheduler(
    store
  ).enqueueConfirmedChallenge(
    createChallengeRecord(),
    createIntent(),
    evidenceCheckpoint(),
    1_000
  )

const dispatcher = (
  store: InMemoryOutboxStore,
  preparer = new FixedPreparer(),
  broadcaster = new RecordingBroadcaster(),
  reconciler = new FixedReconciler()
) =>
  new P2TRSignatureFraudChallengeOutboxDispatcher(
    store,
    preparer,
    broadcaster,
    reconciler,
    {
      minimumRebroadcastIntervalMs: 0,
      now: () => 2_000,
    }
  )

const acceptedOwnResolution =
  (): P2TRSignatureFraudChallengeOutboxResolution => ({
    status: "accepted-own",
    finalizedHead: {
      blockNumber: 120,
      blockHash: `0x${"12".repeat(32)}`,
    },
    receipt: {
      transactionHash: TRANSACTION_HASH,
      status: 1,
      blockNumber: 100,
      blockHash: `0x${"10".repeat(32)}`,
    },
    transaction: {
      transactionHash: TRANSACTION_HASH,
      sender: TRANSACTION_SENDER,
      routerAddress: ROUTER_ADDRESS,
      calldata: "0x1234",
      value: "1234",
      nonce: 7,
      chainID: 11155111,
      blockNumber: 100,
      blockHash: `0x${"10".repeat(32)}`,
      canonicalP2TRSubmissionCall: true,
    },
    routerChallenge: {
      exists: true,
      challengeKey: CHALLENGE_KEY,
      challenger: TRANSACTION_SENDER,
      depositAmount: "1234",
      reportedAt: 999,
      resolved: false,
      readAtBlock: 120,
    },
    submittedEvent: {
      routerAddress: ROUTER_ADDRESS,
      transactionHash: TRANSACTION_HASH,
      blockNumber: 100,
      blockHash: `0x${"10".repeat(32)}`,
      blockTimestamp: 999,
      logIndex: 4,
      walletID: WALLET_ID,
      walletPubKeyHash: `0x${"ee".repeat(20)}`,
      bridgeChallengeIdentity: CHALLENGE_IDENTITY,
      challengeKey: CHALLENGE_KEY,
      sighash: SIGHASH,
    },
  })

const acceptedExternalResolution =
  (): P2TRSignatureFraudChallengeOutboxResolution => {
    const own = acceptedOwnResolution()
    assert.equal(own.status, "accepted-own")
    const externalHash = `0x${"77".repeat(32)}`
    const externalSender = "0x3333333333333333333333333333333333333333"
    return {
      ...own,
      status: "satisfied-external",
      receipt: { ...own.receipt, transactionHash: externalHash },
      transaction: {
        ...own.transaction,
        transactionHash: externalHash,
        sender: externalSender,
        calldata: "0xdeadbeef",
        value: "1500",
        nonce: 3,
      },
      routerChallenge: {
        ...own.routerChallenge,
        challenger: externalSender,
        depositAmount: "1500",
      },
      submittedEvent: {
        ...own.submittedEvent,
        transactionHash: externalHash,
      },
    }
  }

test("enqueues only complete confirmed evidence and keeps enqueue idempotent", async () => {
  const store = new InMemoryOutboxStore()
  const scheduler = new P2TRSignatureFraudChallengeOutboxScheduler(store)
  const first = await scheduler.enqueueConfirmedChallenge(
    createChallengeRecord(),
    createIntent(),
    evidenceCheckpoint(),
    1_000
  )
  const second = await scheduler.enqueueConfirmedChallenge(
    createChallengeRecord(),
    createIntent(),
    evidenceCheckpoint(),
    1_001
  )

  assert.equal(first.status, "queued")
  assert.equal(
    second.intent.intentID.toString(),
    first.intent.intentID.toString()
  )
  assert.equal(store.records.size, 1)

  await assert.rejects(
    scheduler.enqueueConfirmedChallenge(
      { ...createChallengeRecord(), bitcoinStatus: "mempool" },
      createIntent(),
      evidenceCheckpoint()
    ),
    /confirmed canonical Bitcoin evidence/
  )
  await assert.rejects(
    scheduler.enqueueConfirmedChallenge(
      { ...createChallengeRecord(), submissionAttempts: 1 },
      createIntent(),
      evidenceCheckpoint()
    ),
    /legacy submission state must be quarantined/
  )
  await assert.rejects(
    scheduler.enqueueConfirmedChallenge(
      createChallengeRecord(),
      createIntent(),
      { ...evidenceCheckpoint(), confirmedSourceComplete: false } as never
    ),
    /complete confirmed source/
  )
})

test("requires independent broadcaster and reconciler providers and trust domains", () => {
  const store = new InMemoryOutboxStore()
  const preparer = new FixedPreparer()
  const broadcaster = new RecordingBroadcaster()
  const reconciler = new FixedReconciler()
  Object.defineProperty(reconciler, "providerIdentity", {
    value: broadcaster.providerIdentity,
  })

  assert.throws(
    () => dispatcher(store, preparer, broadcaster, reconciler),
    /distinct provider instances and trust domains/
  )

  const separateReconciler = new FixedReconciler()
  Object.defineProperty(separateReconciler, "reconciliationTrustDomainID", {
    value: " SUBMISSION.TEST ",
  })
  assert.throws(
    () => dispatcher(store, preparer, broadcaster, separateReconciler),
    /distinct provider instances and trust domains/
  )
})

test("uses a CAS lease so concurrent preparation signs only once", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const outbox = dispatcher(store, preparer)

  const results = await Promise.all([
    outbox.prepare(record.intent.intentID, "worker-a"),
    outbox.prepare(record.intent.intentID, "worker-b"),
  ])
  const stored = await store.get(record.intent.intentID.toPrefixedString())

  assert.equal(preparer.calls, 1)
  assert.equal(stored?.status, "prepared")
  assert.equal(stored?.generation, 0)
  assert.equal(stored?.preparedTransaction?.rawTransaction, RAW_TRANSACTION)
  assert.ok(results.every((result) => result.status !== "quarantined"))
})

test("persists the attempt before send and recovers with identical signed bytes", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const broadcaster = new RecordingBroadcaster()
  broadcaster.throwAfterSend = true
  broadcaster.inspectDurableBoundary = async () => {
    const durable = await store.get(record.intent.intentID.toPrefixedString())
    assert.equal(durable?.status, "broadcast-pending")
    assert.equal(
      durable?.broadcastAttempts,
      broadcaster.rawTransactions.length + 1
    )
    assert.equal(durable?.preparedTransaction?.rawTransaction, RAW_TRANSACTION)
  }
  const firstProcess = dispatcher(store, preparer, broadcaster)

  await firstProcess.prepare(record.intent.intentID, "worker-a")
  const ambiguous = await firstProcess.broadcast(record.intent.intentID)
  assert.equal(ambiguous.status, "broadcast-pending")
  assert.equal(ambiguous.broadcastAttempts, 1)
  assert.equal(ambiguous.lastBroadcastProviderAccepted, undefined)

  const restartedProcess = dispatcher(store, preparer, broadcaster)
  const retried = await restartedProcess.broadcast(record.intent.intentID)
  assert.equal(retried.status, "broadcast-pending")
  assert.equal(retried.broadcastAttempts, 2)
  assert.equal(preparer.calls, 1)
  assert.deepEqual(broadcaster.rawTransactions, [
    RAW_TRANSACTION,
    RAW_TRANSACTION,
  ])
  assert.equal(retried.generation, 0)
})

test("allows only one concurrent broadcast CAS winner", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const broadcaster = new RecordingBroadcaster()
  const outbox = dispatcher(store, new FixedPreparer(), broadcaster)
  await outbox.prepare(record.intent.intentID, "worker-a")

  await Promise.all([
    outbox.broadcast(record.intent.intentID),
    outbox.broadcast(record.intent.intentID),
  ])

  assert.deepEqual(broadcaster.rawTransactions, [RAW_TRANSACTION])
  assert.equal(
    (await store.get(record.intent.intentID.toPrefixedString()))
      ?.broadcastAttempts,
    1
  )
})

test("keeps unknown reconciliation non-terminal and never creates new bytes", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const broadcaster = new RecordingBroadcaster()
  const reconciler = new FixedReconciler()
  reconciler.resolution = {
    status: "unknown",
    reason: "independent provider unavailable",
  }
  const outbox = dispatcher(store, preparer, broadcaster, reconciler)
  await outbox.prepare(record.intent.intentID, "worker-a")
  await outbox.broadcast(record.intent.intentID)
  const reconciled = await outbox.reconcile(record.intent.intentID)

  assert.equal(reconciled.status, "broadcast-pending")
  assert.equal(reconciled.lastResolutionStatus, "unknown")
  assert.equal(reconciled.preparedTransaction?.rawTransaction, RAW_TRANSACTION)
  assert.equal(reconciled.generation, 0)
  assert.equal(preparer.calls, 1)
})

test("accepts only structured canonical evidence with matching challenger identity", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const reconciler = new FixedReconciler()
  reconciler.resolution = acceptedOwnResolution()
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    reconciler
  )
  await outbox.prepare(record.intent.intentID, "worker-a")
  await outbox.broadcast(record.intent.intentID)
  assert.equal(
    (await outbox.reconcile(record.intent.intentID)).status,
    "accepted-own"
  )

  const externalStore = new InMemoryOutboxStore()
  const externalRecord = await enqueue(externalStore)
  const externalReconciler = new FixedReconciler()
  externalReconciler.resolution = acceptedExternalResolution()
  const externalOutbox = dispatcher(
    externalStore,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    externalReconciler
  )
  await externalOutbox.prepare(externalRecord.intent.intentID, "worker-a")
  assert.equal(
    (await externalOutbox.reconcile(externalRecord.intent.intentID)).status,
    "satisfied-external"
  )

  const invalidStore = new InMemoryOutboxStore()
  const invalidRecord = await enqueue(invalidStore)
  const invalidReconciler = new FixedReconciler()
  const accepted = acceptedOwnResolution()
  assert.equal(accepted.status, "accepted-own")
  invalidReconciler.resolution = {
    ...accepted,
    routerChallenge: {
      ...accepted.routerChallenge,
      challenger: "0x3333333333333333333333333333333333333333",
    },
  }
  const invalidOutbox = dispatcher(
    invalidStore,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    invalidReconciler
  )
  await invalidOutbox.prepare(invalidRecord.intent.intentID, "worker-a")
  await invalidOutbox.broadcast(invalidRecord.intent.intentID)
  const unresolved = await invalidOutbox.reconcile(
    invalidRecord.intent.intentID
  )
  assert.equal(unresolved.status, "broadcast-pending")
  assert.equal(unresolved.lastResolutionStatus, "unknown")
  assert.match(
    unresolved.lastError ?? "",
    /does not match Router challenge state/
  )
})

test("quarantines ambiguous legacy submissions and forbids post-send cancellation", async () => {
  const store = new InMemoryOutboxStore()
  const legacyRecord = {
    ...createChallengeRecord(),
    status: "submitting" as const,
    submissionAttempts: 1,
    challengeTxHash: Hex.from(`0x${"09".repeat(32)}`),
  }
  const quarantines = await quarantineLegacyP2TRSignatureFraudSubmissions(
    {
      async listChallengeRecords() {
        return [legacyRecord]
      },
    },
    store,
    3_000
  )
  assert.equal(quarantines.length, 1)
  assert.equal(store.quarantines.length, 1)
  assert.match(store.quarantines[0].reason, /must never be retried/)

  const record = await enqueue(store)
  const outbox = dispatcher(store)
  await outbox.prepare(record.intent.intentID, "worker-a")
  await outbox.broadcast(record.intent.intentID)
  await assert.rejects(
    outbox.cancelBeforeBroadcast(record.intent.intentID, "operator request"),
    /cannot be cancelled after a broadcast attempt/
  )
})
