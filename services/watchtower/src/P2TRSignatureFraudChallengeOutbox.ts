import {
  Hex,
  P2TRSignatureFraudChallengeTransactionPreparer,
  P2TRSignatureFraudPreparedChallengeTransaction,
  P2TRSignatureFraudSubmissionIntent,
  P2TRWatchtowerChallengeRecord,
  P2TRWatchtowerChallengeRecordSource,
  computeP2TRSignatureFraudSubmissionIntentID,
  validateP2TRSignatureFraudPreparedChallengeTransaction,
} from "@keep-network/tbtc-v2.ts"

import type { P2TRSignatureFraudWatchtowerStoreProfileProvider } from "./types.js"

export type P2TRSignatureFraudChallengeOutboxStatus =
  | "queued"
  | "preparing"
  | "prepared"
  | "broadcast-pending"
  | "accepted-own"
  | "satisfied-external"
  | "terminal-reverted"
  | "terminal-nonce-consumed"
  | "cancelled-before-broadcast"
  | "quarantined"

export type P2TRSignatureFraudOutboxEvidenceCheckpoint = {
  confirmedSourceComplete: true
  bitcoinTxHash: string
  bitcoinBlockHash: string
  bitcoinBlockHeight: number
  bitcoinCursorBlockHash: string
  bitcoinCursorBlockHeight: number
  ethereumLifecycleBlockHash: string
  ethereumLifecycleBlockNumber: number
  /** Router deployment/activation block; it must predate every Submitted event. */
  submittedEventScanFromBlock: number
}

export type P2TRSignatureFraudChallengeOutboxPreparationLease = {
  owner: string
  expiresAtUnixMs: number
}

export type P2TRSignatureFraudCanonicalBlock = {
  blockNumber: number
  blockHash: string
}

export type P2TRSignatureFraudCanonicalReceipt = {
  transactionHash: string
  status: 0 | 1
  blockNumber: number
  blockHash: string
}

export type P2TRSignatureFraudCanonicalTransaction = {
  transactionHash: string
  sender: string
  routerAddress: string
  calldata: string
  value: string
  nonce: number
  chainID: number
  blockNumber: number
  blockHash: string
  /** Independently decoded as one of the Router's canonical submit calls. */
  canonicalP2TRSubmissionCall: true
}

export type P2TRSignatureFraudCanonicalRouterChallenge =
  | {
      exists: false
      challengeKey: string
      readAtBlock: number
    }
  | {
      exists: true
      challengeKey: string
      challenger: string
      depositAmount: string
      reportedAt: number
      resolved: boolean
      readAtBlock: number
    }

export type P2TRSignatureFraudCanonicalSubmittedEvent = {
  routerAddress: string
  transactionHash: string
  blockNumber: number
  blockHash: string
  blockTimestamp: number
  logIndex: number
  walletID: string
  walletPubKeyHash: string
  bridgeChallengeIdentity: string
  challengeKey: string
  sighash: string
}

type P2TRSignatureFraudFinalizedResolutionEvidence = {
  finalizedHead: P2TRSignatureFraudCanonicalBlock
}

export type P2TRSignatureFraudChallengeOutboxResolution =
  | {
      status: "pending"
      reason: string
    }
  | {
      status: "unknown"
      reason: string
    }
  | ({
      status: "accepted-own" | "satisfied-external"
      receipt: P2TRSignatureFraudCanonicalReceipt & { status: 1 }
      transaction: P2TRSignatureFraudCanonicalTransaction
      routerChallenge: Extract<
        P2TRSignatureFraudCanonicalRouterChallenge,
        { exists: true }
      >
      submittedEvent: P2TRSignatureFraudCanonicalSubmittedEvent
    } & P2TRSignatureFraudFinalizedResolutionEvidence)
  | ({
      status: "terminal-reverted"
      receipt: P2TRSignatureFraudCanonicalReceipt & { status: 0 }
      routerChallenge: Extract<
        P2TRSignatureFraudCanonicalRouterChallenge,
        { exists: false }
      >
    } & P2TRSignatureFraudFinalizedResolutionEvidence)
  | ({
      status: "terminal-nonce-consumed"
      sender: string
      transactionNonce: number
      finalizedAccountNonce: number
      accountNonceReadAtBlock: number
      transactionAbsent: true
      routerChallenge: Extract<
        P2TRSignatureFraudCanonicalRouterChallenge,
        { exists: false }
      >
    } & P2TRSignatureFraudFinalizedResolutionEvidence)

export type P2TRSignatureFraudChallengeOutboxRecord = {
  intent: P2TRSignatureFraudSubmissionIntent
  evidenceCheckpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint
  status: P2TRSignatureFraudChallengeOutboxStatus
  version: number
  generation: number
  createdAtUnixMs: number
  updatedAtUnixMs: number
  preparationAttempts: number
  broadcastAttempts: number
  reconciliationAttempts: number
  preparationLease?: P2TRSignatureFraudChallengeOutboxPreparationLease
  preparedTransaction?: P2TRSignatureFraudPreparedChallengeTransaction
  lastBroadcastAtUnixMs?: number
  lastBroadcastProviderAccepted?: boolean
  lastReconciliationAtUnixMs?: number
  lastResolutionStatus?: P2TRSignatureFraudChallengeOutboxResolution["status"]
  lastError?: string
}

export type P2TRSignatureFraudLegacySubmissionQuarantine = {
  observationID: string
  bridgeChallengeKey?: string
  legacyStatus: P2TRWatchtowerChallengeRecord["status"]
  submissionAttempts: number
  challengeTxHash?: string
  reason: string
  quarantinedAtUnixMs: number
}

/**
 * Atomic compare-and-swap storage boundary for the production outbox.
 *
 * Implementations must enforce uniqueness for both `intentID` and
 * `(chainID, routerAddress, bridgeChallengeKey)`, plus active prepared
 * `(chainID, sender, nonce)` tuples. `insertIfAbsent` and
 * `compareAndSwap` must participate in the same ambient transaction as the
 * challenge-record and source-cursor stores when invoked by the scheduler.
 */
export interface P2TRSignatureFraudChallengeOutboxStore
  extends P2TRSignatureFraudWatchtowerStoreProfileProvider {
  insertIfAbsent(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord>
  get(
    intentID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined>
  compareAndSwap(
    intentID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean>
  list(
    statuses?: P2TRSignatureFraudChallengeOutboxStatus[]
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord[]>
  saveLegacyQuarantine(
    quarantine: P2TRSignatureFraudLegacySubmissionQuarantine
  ): Promise<void>
}

export interface P2TRSignatureFraudRawTransactionBroadcaster {
  readonly submissionTrustDomainID: string
  readonly providerIdentity: object
  broadcastRawTransaction(
    rawTransaction: string
  ): Promise<Hex | Buffer | string>
}

export type P2TRSignatureFraudChallengeOutboxReconciliationContext = {
  intent: P2TRSignatureFraudSubmissionIntent
  evidenceCheckpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint
  preparedTransaction: P2TRSignatureFraudPreparedChallengeTransaction
  broadcastAttempts: number
  reconciliationAttempts: number
  lastBroadcastAtUnixMs?: number
}

export interface P2TRSignatureFraudChallengeOutboxReconciler {
  readonly reconciliationTrustDomainID: string
  readonly providerIdentity: object
  readonly finalityConfirmationBlocks: number
  reconcileSignatureFraudChallengeOutbox(
    context: P2TRSignatureFraudChallengeOutboxReconciliationContext
  ): Promise<P2TRSignatureFraudChallengeOutboxResolution>
}

export type P2TRSignatureFraudChallengeOutboxDispatcherOptions = {
  preparationLeaseMs?: number
  minimumRebroadcastIntervalMs?: number
  now?: () => number
}

export class P2TRSignatureFraudChallengeOutboxScheduler {
  constructor(private readonly store: P2TRSignatureFraudChallengeOutboxStore) {}

  /**
   * Enqueues confirmed evidence. The caller must invoke this inside the same
   * production transaction that stores the observation and advances both
   * canonical source cursors.
   */
  async enqueueConfirmedChallenge(
    challengeRecord: P2TRWatchtowerChallengeRecord,
    intent: P2TRSignatureFraudSubmissionIntent,
    evidenceCheckpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint,
    nowUnixMs = Date.now()
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    validateOutboxEnqueue(
      challengeRecord,
      intent,
      evidenceCheckpoint,
      nowUnixMs
    )

    const record: P2TRSignatureFraudChallengeOutboxRecord = {
      intent,
      evidenceCheckpoint,
      status: "queued",
      version: 0,
      generation: 0,
      createdAtUnixMs: nowUnixMs,
      updatedAtUnixMs: nowUnixMs,
      preparationAttempts: 0,
      broadcastAttempts: 0,
      reconciliationAttempts: 0,
    }
    const stored = await this.store.insertIfAbsent(record)
    validateExistingOutboxIdentity(stored, record)
    return stored
  }
}

export class P2TRSignatureFraudChallengeOutboxDispatcher {
  private readonly preparationLeaseMs: number
  private readonly minimumRebroadcastIntervalMs: number
  private readonly now: () => number

  constructor(
    private readonly store: P2TRSignatureFraudChallengeOutboxStore,
    private readonly preparer: P2TRSignatureFraudChallengeTransactionPreparer,
    private readonly broadcaster: P2TRSignatureFraudRawTransactionBroadcaster,
    private readonly reconciler: P2TRSignatureFraudChallengeOutboxReconciler,
    options: P2TRSignatureFraudChallengeOutboxDispatcherOptions = {}
  ) {
    this.preparationLeaseMs = requirePositiveSafeInteger(
      options.preparationLeaseMs ?? 30_000,
      "Challenge outbox preparation lease"
    )
    this.minimumRebroadcastIntervalMs = requireNonNegativeSafeInteger(
      options.minimumRebroadcastIntervalMs ?? 30_000,
      "Challenge outbox rebroadcast interval"
    )
    this.now = options.now ?? Date.now
    validateIndependentTransport(broadcaster, reconciler)
  }

  async prepare(
    intentID: Hex | Buffer | string,
    leaseOwner: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    if (typeof leaseOwner !== "string" || leaseOwner.trim().length === 0) {
      throw new Error("Challenge outbox preparation lease owner is required")
    }

    const key = normalizeBytes32(intentID, "Challenge outbox intent ID")
    const current = await this.requireRecord(key)
    if (current.status === "preparing") {
      if (
        current.preparationLease !== undefined &&
        current.preparationLease.expiresAtUnixMs > this.now()
      ) {
        return current
      }
      const recovered = await this.recoverExpiredPreparation(current)
      if (recovered.status !== "queued") {
        return recovered
      }
      return this.prepare(intentID, leaseOwner)
    }
    if (current.status !== "queued") {
      return current
    }

    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox preparation time"
    )
    const claimed = nextRecord(current, {
      status: "preparing",
      preparationAttempts: current.preparationAttempts + 1,
      preparationLease: {
        owner: leaseOwner.trim(),
        expiresAtUnixMs: nowUnixMs + this.preparationLeaseMs,
      },
      updatedAtUnixMs: nowUnixMs,
      lastError: undefined,
    })
    if (!(await this.store.compareAndSwap(key, current.version, claimed))) {
      return this.requireRecord(key)
    }

    let prepared: P2TRSignatureFraudPreparedChallengeTransaction
    try {
      prepared = validateP2TRSignatureFraudPreparedChallengeTransaction(
        claimed.intent,
        await this.preparer.prepareSignatureFraudChallengeTransaction(
          claimed.intent
        )
      )
    } catch (error) {
      const failed = nextRecord(claimed, {
        status: isPreparedTransactionValidationFailure(error)
          ? "quarantined"
          : "queued",
        preparationLease: undefined,
        updatedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Challenge outbox preparation failure time"
        ),
        lastError: errorMessage(error),
      })
      await this.store.compareAndSwap(key, claimed.version, failed)
      return this.requireRecord(key)
    }

    const persisted = nextRecord(claimed, {
      status: "prepared",
      preparedTransaction: prepared,
      preparationLease: undefined,
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox prepared time"
      ),
      lastError: undefined,
    })
    if (!(await this.store.compareAndSwap(key, claimed.version, persisted))) {
      // The signed bytes were never broadcast. Losing this lease is safe: the
      // winning durable record remains authoritative.
      return this.requireRecord(key)
    }
    return persisted
  }

  async recoverExpiredPreparationLeases(): Promise<number> {
    const records = await this.store.list(["preparing"])
    let recovered = 0
    for (const record of records) {
      const result = await this.recoverExpiredPreparation(record)
      if (result.status === "queued") {
        recovered++
      }
    }
    return recovered
  }

  async broadcast(
    intentID: Hex | Buffer | string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const key = normalizeBytes32(intentID, "Challenge outbox intent ID")
    const current = await this.requireRecord(key)
    if (
      current.status !== "prepared" &&
      current.status !== "broadcast-pending"
    ) {
      return current
    }
    if (current.preparedTransaction === undefined) {
      return this.quarantine(
        current,
        "Challenge outbox broadcast record has no prepared transaction"
      )
    }
    const preparedTransaction = current.preparedTransaction

    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox broadcast time"
    )
    if (
      current.status === "broadcast-pending" &&
      current.lastBroadcastAtUnixMs !== undefined &&
      nowUnixMs - current.lastBroadcastAtUnixMs <
        this.minimumRebroadcastIntervalMs
    ) {
      return current
    }

    // Persist the irreversible-attempt boundary before the external call. A
    // crash from this point onward can only cause the exact same raw bytes to
    // be sent again.
    const attempted = nextRecord(current, {
      status: "broadcast-pending",
      broadcastAttempts: current.broadcastAttempts + 1,
      lastBroadcastAtUnixMs: nowUnixMs,
      lastBroadcastProviderAccepted: undefined,
      updatedAtUnixMs: nowUnixMs,
      lastError: undefined,
    })
    if (!(await this.store.compareAndSwap(key, current.version, attempted))) {
      return this.requireRecord(key)
    }

    try {
      const returnedHash = normalizeBytes32(
        await this.broadcaster.broadcastRawTransaction(
          preparedTransaction.rawTransaction
        ),
        "Broadcast challenge transaction hash"
      )
      const expectedHash = normalizeBytes32(
        preparedTransaction.transactionHash,
        "Prepared challenge transaction hash"
      )
      if (returnedHash !== expectedHash) {
        return this.quarantine(
          attempted,
          "Challenge broadcaster returned a hash that does not match the persisted raw transaction"
        )
      }

      const acknowledged = nextRecord(attempted, {
        lastBroadcastProviderAccepted: true,
        updatedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Challenge outbox broadcast acknowledgement time"
        ),
        lastError: undefined,
      })
      await this.store.compareAndSwap(key, attempted.version, acknowledged)
    } catch (error) {
      const ambiguous = nextRecord(attempted, {
        // The call may have reached the provider or network before failing.
        // Preserve the tri-state as unknown instead of recording rejection.
        lastBroadcastProviderAccepted: undefined,
        updatedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Challenge outbox ambiguous broadcast time"
        ),
        lastError: errorMessage(error),
      })
      await this.store.compareAndSwap(key, attempted.version, ambiguous)
    }

    return this.requireRecord(key)
  }

  async reconcile(
    intentID: Hex | Buffer | string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const key = normalizeBytes32(intentID, "Challenge outbox intent ID")
    const current = await this.requireRecord(key)
    if (
      current.status !== "prepared" &&
      current.status !== "broadcast-pending"
    ) {
      return current
    }
    if (current.preparedTransaction === undefined) {
      return this.quarantine(
        current,
        "Challenge outbox reconciliation record has no prepared transaction"
      )
    }

    let resolution: P2TRSignatureFraudChallengeOutboxResolution
    try {
      resolution = await this.reconciler.reconcileSignatureFraudChallengeOutbox(
        {
          intent: current.intent,
          evidenceCheckpoint: current.evidenceCheckpoint,
          preparedTransaction: current.preparedTransaction,
          broadcastAttempts: current.broadcastAttempts,
          reconciliationAttempts: current.reconciliationAttempts,
          lastBroadcastAtUnixMs: current.lastBroadcastAtUnixMs,
        }
      )
      validateStructuredResolution(
        current,
        resolution,
        this.reconciler.finalityConfirmationBlocks
      )
    } catch (error) {
      resolution = {
        status: "unknown",
        reason: `Challenge outbox reconciliation failed: ${errorMessage(
          error
        )}`,
      }
    }

    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox reconciliation time"
    )
    const base = {
      reconciliationAttempts: current.reconciliationAttempts + 1,
      lastReconciliationAtUnixMs: nowUnixMs,
      lastResolutionStatus: resolution.status,
      updatedAtUnixMs: nowUnixMs,
    }

    let next: P2TRSignatureFraudChallengeOutboxRecord
    switch (resolution.status) {
      case "accepted-own":
      case "satisfied-external":
      case "terminal-reverted":
      case "terminal-nonce-consumed":
        next = nextRecord(current, {
          ...base,
          status: resolution.status,
          lastError: undefined,
        })
        break
      case "pending":
      case "unknown":
        // Unknown is deliberately non-replayable: it never clears the prepared
        // transaction or permits a new transaction generation.
        next = nextRecord(current, {
          ...base,
          lastError: resolution.reason,
        })
        break
    }

    await this.store.compareAndSwap(key, current.version, next)
    return this.requireRecord(key)
  }

  async cancelBeforeBroadcast(
    intentID: Hex | Buffer | string,
    reason: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const key = normalizeBytes32(intentID, "Challenge outbox intent ID")
    const current = await this.requireRecord(key)
    if (
      current.broadcastAttempts !== 0 ||
      current.status === "broadcast-pending"
    ) {
      throw new Error(
        "Challenge outbox transaction cannot be cancelled after a broadcast attempt"
      )
    }
    if (
      current.status !== "queued" &&
      current.status !== "preparing" &&
      current.status !== "prepared"
    ) {
      return current
    }

    const cancelled = nextRecord(current, {
      status: "cancelled-before-broadcast",
      preparationLease: undefined,
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox cancellation time"
      ),
      lastError: requireReason(reason, "Challenge outbox cancellation reason"),
    })
    await this.store.compareAndSwap(key, current.version, cancelled)
    return this.requireRecord(key)
  }

  private async recoverExpiredPreparation(
    current: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    if (
      current.status !== "preparing" ||
      current.preparationLease === undefined ||
      current.preparationLease.expiresAtUnixMs > this.now()
    ) {
      return current
    }
    const recovered = nextRecord(current, {
      status: "queued",
      preparationLease: undefined,
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox lease recovery time"
      ),
      lastError: "Challenge outbox preparation lease expired",
    })
    await this.store.compareAndSwap(
      intentKey(current.intent),
      current.version,
      recovered
    )
    return this.requireRecord(intentKey(current.intent))
  }

  private async quarantine(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    reason: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const quarantined = nextRecord(current, {
      status: "quarantined",
      preparationLease: undefined,
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox quarantine time"
      ),
      lastError: requireReason(reason, "Challenge outbox quarantine reason"),
    })
    await this.store.compareAndSwap(
      intentKey(current.intent),
      current.version,
      quarantined
    )
    return this.requireRecord(intentKey(current.intent))
  }

  private async requireRecord(
    intentID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const record = await this.store.get(intentID)
    if (record === undefined) {
      throw new Error("Challenge outbox record does not exist")
    }
    return record
  }
}

export const quarantineLegacyP2TRSignatureFraudSubmissions = async (
  recordSource: P2TRWatchtowerChallengeRecordSource,
  store: P2TRSignatureFraudChallengeOutboxStore,
  nowUnixMs = Date.now()
): Promise<P2TRSignatureFraudLegacySubmissionQuarantine[]> => {
  requireUnixMilliseconds(nowUnixMs, "Legacy submission quarantine time")
  const quarantines = (await recordSource.listChallengeRecords())
    .filter(isAmbiguousLegacySubmissionRecord)
    .map((record) => ({
      observationID: normalizeBytes32(
        record.observationID,
        "Legacy observation ID"
      ),
      bridgeChallengeKey:
        record.observation?.bridgeChallengeKey === undefined
          ? undefined
          : normalizeBytes32(
              record.observation.bridgeChallengeKey,
              "Legacy Bridge challenge key"
            ),
      legacyStatus: record.status,
      submissionAttempts: record.submissionAttempts,
      challengeTxHash:
        record.challengeTxHash === undefined
          ? undefined
          : normalizeBytes32(
              record.challengeTxHash,
              "Legacy challenge transaction hash"
            ),
      reason:
        "Legacy challenge submission has no authenticated prepared-transaction outbox record and must never be retried automatically",
      quarantinedAtUnixMs: nowUnixMs,
    }))

  for (const quarantine of quarantines) {
    await store.saveLegacyQuarantine(quarantine)
  }
  return quarantines
}

const isAmbiguousLegacySubmissionRecord = (
  record: P2TRWatchtowerChallengeRecord
): boolean =>
  record.submissionAttempts > 0 ||
  record.status === "submitting" ||
  record.status === "broadcast-pending" ||
  record.status === "rejected"

const validateOutboxEnqueue = (
  challengeRecord: P2TRWatchtowerChallengeRecord,
  intent: P2TRSignatureFraudSubmissionIntent,
  evidence: P2TRSignatureFraudOutboxEvidenceCheckpoint,
  nowUnixMs: number
): void => {
  requireUnixMilliseconds(nowUnixMs, "Challenge outbox enqueue time")
  const computedIntentID = computeP2TRSignatureFraudSubmissionIntentID({
    observationID: intent.observationID,
    bridgeChallengeKey: intent.bridgeChallengeKey,
    walletID: intent.walletID,
    bridgeChallengeIdentity: intent.bridgeChallengeIdentity,
    sighash: intent.sighash,
    chainID: intent.chainID,
    bridgeAddress: intent.bridgeAddress,
    routerAddress: intent.routerAddress,
    calldata: intent.calldata,
    value: intent.value,
  })
  if (
    normalizeBytes32(intent.intentID, "Submission intent ID") !==
    normalizeBytes32(computedIntentID, "Computed submission intent ID")
  ) {
    throw new Error("Challenge outbox intent ID does not authenticate its call")
  }
  if (
    challengeRecord.status !== "observed" ||
    challengeRecord.submissionAttempts !== 0
  ) {
    throw new Error(
      "Challenge outbox accepts only never-submitted observed records; legacy submission state must be quarantined"
    )
  }
  if (
    challengeRecord.observation === undefined ||
    challengeRecord.observation.bridgeChallengeKey === undefined ||
    normalizeBytes32(challengeRecord.observationID, "Observation ID") !==
      normalizeBytes32(
        intent.observationID,
        "Submission intent observation ID"
      ) ||
    normalizeBytes32(
      challengeRecord.observation.bridgeChallengeKey,
      "Observation Bridge challenge key"
    ) !==
      normalizeBytes32(
        intent.bridgeChallengeKey,
        "Submission intent Bridge challenge key"
      )
  ) {
    throw new Error(
      "Challenge outbox intent does not match the durable observation"
    )
  }
  if (
    challengeRecord.bitcoinStatus !== "confirmed" ||
    challengeRecord.bitcoinTxHash === undefined ||
    challengeRecord.bitcoinBlockHash === undefined ||
    challengeRecord.bitcoinBlockHeight === undefined
  ) {
    throw new Error(
      "Challenge outbox requires confirmed canonical Bitcoin evidence"
    )
  }

  validateEvidenceCheckpoint(evidence)
  if (
    normalizeBytes32(
      challengeRecord.bitcoinTxHash,
      "Confirmed Bitcoin transaction hash"
    ) !==
      normalizeBytes32(evidence.bitcoinTxHash, "Checkpoint Bitcoin tx hash") ||
    normalizeBytes32(
      challengeRecord.bitcoinBlockHash,
      "Confirmed Bitcoin block hash"
    ) !==
      normalizeBytes32(
        evidence.bitcoinBlockHash,
        "Checkpoint Bitcoin block hash"
      ) ||
    challengeRecord.bitcoinBlockHeight !== evidence.bitcoinBlockHeight ||
    evidence.bitcoinCursorBlockHeight < evidence.bitcoinBlockHeight
  ) {
    throw new Error(
      "Challenge outbox evidence checkpoint does not cover the confirmed observation"
    )
  }
}

const validateEvidenceCheckpoint = (
  evidence: P2TRSignatureFraudOutboxEvidenceCheckpoint
): void => {
  if (evidence.confirmedSourceComplete !== true) {
    throw new Error("Challenge outbox requires a complete confirmed source")
  }
  normalizeBytes32(evidence.bitcoinTxHash, "Checkpoint Bitcoin tx hash")
  normalizeBytes32(evidence.bitcoinBlockHash, "Checkpoint Bitcoin block hash")
  normalizeBytes32(
    evidence.bitcoinCursorBlockHash,
    "Checkpoint Bitcoin cursor block hash"
  )
  normalizeBytes32(
    evidence.ethereumLifecycleBlockHash,
    "Checkpoint Ethereum lifecycle block hash"
  )
  requireNonNegativeSafeInteger(
    evidence.bitcoinBlockHeight,
    "Checkpoint Bitcoin block height"
  )
  requireNonNegativeSafeInteger(
    evidence.bitcoinCursorBlockHeight,
    "Checkpoint Bitcoin cursor block height"
  )
  requireNonNegativeSafeInteger(
    evidence.ethereumLifecycleBlockNumber,
    "Checkpoint Ethereum lifecycle block number"
  )
  requireNonNegativeSafeInteger(
    evidence.submittedEventScanFromBlock,
    "Checkpoint submitted-event scan floor"
  )
  if (
    evidence.submittedEventScanFromBlock > evidence.ethereumLifecycleBlockNumber
  ) {
    throw new Error(
      "Checkpoint submitted-event scan floor must not be ahead of the lifecycle cursor"
    )
  }
}

const validateExistingOutboxIdentity = (
  actual: P2TRSignatureFraudChallengeOutboxRecord,
  expected: P2TRSignatureFraudChallengeOutboxRecord
): void => {
  if (
    intentKey(actual.intent) !== intentKey(expected.intent) ||
    normalizeBytes32(
      actual.intent.bridgeChallengeKey,
      "Stored Bridge challenge key"
    ) !==
      normalizeBytes32(
        expected.intent.bridgeChallengeKey,
        "Expected Bridge challenge key"
      ) ||
    actual.intent.chainID !== expected.intent.chainID ||
    normalizeAddress(actual.intent.routerAddress, "Stored Router address") !==
      normalizeAddress(
        expected.intent.routerAddress,
        "Expected Router address"
      ) ||
    actual.intent.calldata.toLowerCase() !==
      expected.intent.calldata.toLowerCase() ||
    actual.intent.value !== expected.intent.value
  ) {
    throw new Error(
      "Challenge outbox uniqueness conflict maps one intent or challenge key to different calls"
    )
  }
}

const validateIndependentTransport = (
  broadcaster: P2TRSignatureFraudRawTransactionBroadcaster,
  reconciler: P2TRSignatureFraudChallengeOutboxReconciler
): void => {
  const submissionTrustDomainID = normalizeTrustDomainID(
    broadcaster.submissionTrustDomainID,
    "Challenge broadcaster trust-domain ID"
  )
  const reconciliationTrustDomainID = normalizeTrustDomainID(
    reconciler.reconciliationTrustDomainID,
    "Challenge reconciler trust-domain ID"
  )
  if (
    typeof broadcaster.providerIdentity !== "object" ||
    broadcaster.providerIdentity === null ||
    typeof reconciler.providerIdentity !== "object" ||
    reconciler.providerIdentity === null
  ) {
    throw new Error(
      "Challenge broadcaster and reconciler require provider identities"
    )
  }
  if (
    broadcaster.providerIdentity === reconciler.providerIdentity ||
    submissionTrustDomainID === reconciliationTrustDomainID
  ) {
    throw new Error(
      "Challenge broadcasting and reconciliation require distinct provider instances and trust domains"
    )
  }
  requirePositiveSafeInteger(
    reconciler.finalityConfirmationBlocks,
    "Challenge reconciliation finality confirmation depth"
  )
}

const validateStructuredResolution = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  resolution: P2TRSignatureFraudChallengeOutboxResolution,
  finalityConfirmationBlocks: number
): void => {
  if (resolution === undefined || typeof resolution !== "object") {
    throw new Error("Challenge reconciler returned an invalid result")
  }
  if (resolution.status === "pending" || resolution.status === "unknown") {
    requireReason(resolution.reason, "Challenge reconciliation reason")
    return
  }
  const prepared = record.preparedTransaction
  if (prepared === undefined) {
    throw new Error("Canonical resolution requires a prepared transaction")
  }
  validateCanonicalBlock(resolution.finalizedHead, "Finalized head")

  const expectedChallengeKey = normalizeBytes32(
    record.intent.bridgeChallengeKey,
    "Submission intent Bridge challenge key"
  )
  if (
    normalizeBytes32(
      resolution.routerChallenge.challengeKey,
      "Canonical Router challenge key"
    ) !== expectedChallengeKey
  ) {
    throw new Error(
      "Canonical Router challenge key does not match the outbox intent"
    )
  }
  if (
    resolution.routerChallenge.readAtBlock !==
    resolution.finalizedHead.blockNumber
  ) {
    throw new Error(
      "Canonical Router challenge state must be read at the finalized head"
    )
  }

  if (resolution.status === "terminal-nonce-consumed") {
    if (
      resolution.routerChallenge.exists !== false ||
      resolution.transactionAbsent !== true ||
      normalizeAddress(resolution.sender, "Canonical transaction sender") !==
        normalizeAddress(prepared.sender, "Prepared transaction sender") ||
      resolution.transactionNonce !== prepared.nonce ||
      resolution.accountNonceReadAtBlock !==
        resolution.finalizedHead.blockNumber ||
      !Number.isSafeInteger(resolution.finalizedAccountNonce) ||
      resolution.finalizedAccountNonce <= prepared.nonce
    ) {
      throw new Error(
        "Canonical nonce-consumed resolution does not prove the prepared transaction impossible"
      )
    }
    return
  }

  validateCanonicalReceipt(resolution.receipt)
  const requiredFinalizedBlock =
    resolution.receipt.blockNumber + finalityConfirmationBlocks - 1
  if (resolution.finalizedHead.blockNumber < requiredFinalizedBlock) {
    throw new Error(
      "Canonical transaction receipt has not reached the required finality depth"
    )
  }

  if (resolution.status === "terminal-reverted") {
    if (
      resolution.receipt.status !== 0 ||
      resolution.routerChallenge.exists !== false ||
      normalizeBytes32(
        resolution.receipt.transactionHash,
        "Canonical reverted transaction hash"
      ) !==
        normalizeBytes32(prepared.transactionHash, "Prepared transaction hash")
    ) {
      throw new Error(
        "Canonical reverted resolution does not terminate the prepared transaction"
      )
    }
    return
  }

  if (
    resolution.receipt.status !== 1 ||
    resolution.routerChallenge.exists !== true ||
    !Number.isSafeInteger(resolution.routerChallenge.reportedAt) ||
    resolution.routerChallenge.reportedAt <= 0
  ) {
    throw new Error(
      "Canonical accepted resolution requires an existing Router challenge and successful receipt"
    )
  }
  validateSubmittedEvent(record.intent, resolution.submittedEvent)
  if (
    resolution.submittedEvent.blockNumber <
    record.evidenceCheckpoint.submittedEventScanFromBlock
  ) {
    throw new Error(
      "Canonical submitted event predates the configured complete scan floor"
    )
  }
  validateCanonicalAcceptedTransaction(
    record.intent,
    resolution.transaction,
    resolution.status === "accepted-own"
  )
  if (
    normalizeBytes32(
      resolution.receipt.transactionHash,
      "Canonical accepted transaction hash"
    ) !==
      normalizeBytes32(
        resolution.submittedEvent.transactionHash,
        "Submitted event transaction hash"
      ) ||
    resolution.receipt.blockNumber !== resolution.submittedEvent.blockNumber ||
    normalizeBytes32(
      resolution.receipt.blockHash,
      "Canonical accepted receipt block hash"
    ) !==
      normalizeBytes32(
        resolution.submittedEvent.blockHash,
        "Submitted event block hash"
      ) ||
    normalizeBytes32(
      resolution.receipt.transactionHash,
      "Canonical accepted transaction hash"
    ) !==
      normalizeBytes32(
        resolution.transaction.transactionHash,
        "Canonical accepted transaction hash"
      ) ||
    resolution.receipt.blockNumber !== resolution.transaction.blockNumber ||
    normalizeBytes32(
      resolution.receipt.blockHash,
      "Canonical accepted receipt block hash"
    ) !==
      normalizeBytes32(
        resolution.transaction.blockHash,
        "Canonical accepted transaction block hash"
      )
  ) {
    throw new Error(
      "Canonical accepted receipt does not contain the exact submitted event"
    )
  }
  const isOwn =
    normalizeBytes32(
      resolution.receipt.transactionHash,
      "Canonical accepted transaction hash"
    ) ===
    normalizeBytes32(prepared.transactionHash, "Prepared transaction hash")
  if (
    normalizeAddress(
      resolution.routerChallenge.challenger,
      "Canonical Router challenger"
    ) !==
      normalizeAddress(
        resolution.transaction.sender,
        "Canonical accepted transaction sender"
      ) ||
    normalizeUnsignedDecimal(
      resolution.routerChallenge.depositAmount,
      "Canonical Router challenge deposit"
    ) !==
      normalizeUnsignedDecimal(
        resolution.transaction.value,
        "Canonical accepted transaction value"
      ) ||
    resolution.routerChallenge.reportedAt !==
      resolution.submittedEvent.blockTimestamp
  ) {
    throw new Error(
      "Canonical accepted transaction does not match Router challenge state"
    )
  }
  if (
    (resolution.status === "accepted-own" && !isOwn) ||
    (resolution.status === "satisfied-external" && isOwn)
  ) {
    throw new Error(
      "Canonical accepted resolution misclassifies transaction ownership"
    )
  }
  if (
    isOwn &&
    (normalizeAddress(
      resolution.transaction.sender,
      "Canonical accepted transaction sender"
    ) !== normalizeAddress(prepared.sender, "Prepared transaction sender") ||
      resolution.transaction.nonce !== prepared.nonce)
  ) {
    throw new Error(
      "Canonical own transaction sender or nonce does not match the prepared transaction"
    )
  }
}

const validateCanonicalAcceptedTransaction = (
  intent: P2TRSignatureFraudSubmissionIntent,
  transaction: P2TRSignatureFraudCanonicalTransaction,
  requireExactIntent: boolean
): void => {
  validateCanonicalBlock(transaction, "Canonical accepted transaction block")
  normalizeBytes32(
    transaction.transactionHash,
    "Canonical accepted transaction hash"
  )
  requireNonNegativeSafeInteger(
    transaction.nonce,
    "Canonical accepted transaction nonce"
  )
  if (
    transaction.canonicalP2TRSubmissionCall !== true ||
    transaction.chainID !== intent.chainID ||
    normalizeAddress(
      transaction.routerAddress,
      "Canonical accepted transaction Router address"
    ) !==
      normalizeAddress(intent.routerAddress, "Submission intent Router address")
  ) {
    throw new Error(
      "Canonical accepted transaction does not match the durable call intent"
    )
  }
  const transactionValue = normalizeUnsignedDecimal(
    transaction.value,
    "Canonical accepted transaction value"
  )
  const intentValue = normalizeUnsignedDecimal(
    intent.value,
    "Submission intent value"
  )
  const exactIntentMismatch =
    normalizeHexData(
      transaction.calldata,
      "Canonical accepted transaction calldata"
    ) !== normalizeHexData(intent.calldata, "Submission intent calldata") ||
    transactionValue !== intentValue
  const externalDepositTooSmall = BigInt(transactionValue) < BigInt(intentValue)
  if (
    (requireExactIntent && exactIntentMismatch) ||
    (!requireExactIntent && externalDepositTooSmall)
  ) {
    throw new Error(
      requireExactIntent
        ? "Canonical own transaction does not match the durable call intent"
        : "Canonical external transaction does not cover the required challenge deposit"
    )
  }
  normalizeAddress(transaction.sender, "Canonical accepted transaction sender")
}

const validateSubmittedEvent = (
  intent: P2TRSignatureFraudSubmissionIntent,
  event: P2TRSignatureFraudCanonicalSubmittedEvent
): void => {
  validateCanonicalBlock(event, "Submitted event block")
  requirePositiveSafeInteger(
    event.blockTimestamp,
    "Submitted event block timestamp"
  )
  requireNonNegativeSafeInteger(event.logIndex, "Submitted event log index")
  if (
    normalizeAddress(event.routerAddress, "Submitted event Router address") !==
      normalizeAddress(
        intent.routerAddress,
        "Submission intent Router address"
      ) ||
    normalizeBytes32(event.walletID, "Submitted event wallet ID") !==
      normalizeBytes32(intent.walletID, "Submission intent wallet ID") ||
    normalizeBytes32(
      event.bridgeChallengeIdentity,
      "Submitted event Bridge challenge identity"
    ) !==
      normalizeBytes32(
        intent.bridgeChallengeIdentity,
        "Submission intent Bridge challenge identity"
      ) ||
    normalizeBytes32(event.challengeKey, "Submitted event challenge key") !==
      normalizeBytes32(
        intent.bridgeChallengeKey,
        "Submission intent Bridge challenge key"
      ) ||
    normalizeBytes32(event.sighash, "Submitted event sighash") !==
      normalizeBytes32(intent.sighash, "Submission intent sighash")
  ) {
    throw new Error(
      "Canonical submitted event does not match the outbox intent"
    )
  }
  normalizeBytes20(event.walletPubKeyHash, "Submitted event wallet pubkey hash")
  normalizeBytes32(event.transactionHash, "Submitted event transaction hash")
}

const validateCanonicalReceipt = (
  receipt: P2TRSignatureFraudCanonicalReceipt
): void => {
  if (receipt.status !== 0 && receipt.status !== 1) {
    throw new Error("Canonical receipt status must be zero or one")
  }
  normalizeBytes32(
    receipt.transactionHash,
    "Canonical receipt transaction hash"
  )
  validateCanonicalBlock(receipt, "Canonical receipt block")
}

const validateCanonicalBlock = (
  block: { blockNumber: number; blockHash: string },
  label: string
): void => {
  requireNonNegativeSafeInteger(block.blockNumber, `${label} number`)
  normalizeBytes32(block.blockHash, `${label} hash`)
}

const nextRecord = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  updates: Partial<P2TRSignatureFraudChallengeOutboxRecord>
): P2TRSignatureFraudChallengeOutboxRecord => ({
  ...record,
  ...updates,
  version: record.version + 1,
})

const intentKey = (intent: P2TRSignatureFraudSubmissionIntent): string =>
  normalizeBytes32(intent.intentID, "Challenge outbox intent ID")

const normalizeBytes32 = (
  value: Hex | Buffer | string,
  label: string
): string => normalizeFixedBytes(value, 32, label)

const normalizeBytes20 = (
  value: Hex | Buffer | string,
  label: string
): string => normalizeFixedBytes(value, 20, label)

const normalizeFixedBytes = (
  value: Hex | Buffer | string,
  length: number,
  label: string
): string => {
  let bytes: Buffer
  try {
    if (value instanceof Hex) {
      bytes = value.toBuffer()
    } else if (Buffer.isBuffer(value)) {
      bytes = Buffer.from(value)
    } else if (typeof value === "string") {
      const unprefixed = value.replace(/^0x/i, "")
      if (!/^[0-9a-fA-F]*$/.test(unprefixed) || unprefixed.length % 2 !== 0) {
        throw new Error("invalid hex")
      }
      bytes = Buffer.from(unprefixed, "hex")
    } else {
      throw new Error("invalid bytes")
    }
  } catch {
    throw new Error(`${label} must be ${length} bytes`)
  }
  if (bytes.length !== length) {
    throw new Error(`${label} must be ${length} bytes`)
  }
  return `0x${bytes.toString("hex")}`
}

const normalizeAddress = (value: string, label: string): string => {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(value) ||
    /^0x0{40}$/i.test(value)
  ) {
    throw new Error(`${label} must be a non-zero Ethereum address`)
  }
  return value.toLowerCase()
}

const normalizeHexData = (value: string, label: string): string => {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} must be even-length hexadecimal data`)
  }
  return value.toLowerCase()
}

const normalizeUnsignedDecimal = (value: string, label: string): string => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal integer`)
  }
  return value
}

const normalizeTrustDomainID = (value: string, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`)
  }
  return value.trim().toLowerCase()
}

const requireReason = (value: string, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`)
  }
  return value
}

const requireUnixMilliseconds = (value: number, label: string): number =>
  requireNonNegativeSafeInteger(value, label)

const requirePositiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

const requireNonNegativeSafeInteger = (
  value: number,
  label: string
): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0
    ? error.message
    : String(error)

const isPreparedTransactionValidationFailure = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("Prepared challenge transaction") ||
    error.message.includes("submission intent"))
