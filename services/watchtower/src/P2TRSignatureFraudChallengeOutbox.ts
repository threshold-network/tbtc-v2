import { createHash } from "node:crypto"

import {
  Hex,
  P2TRSignatureFraudChallengeTransactionPreparer,
  P2TRSignatureFraudPreparedChallengeTransaction,
  P2TRSignatureFraudSubmissionIntentOptions,
  P2TRSignatureFraudSubmissionIntent,
  P2TRSignatureFraudWitnessObservationConsistencyContext,
  P2TRSignatureFraudWitnessObservation,
  P2TRWalletInputKeyBinding,
  P2TRWatchtowerChallengeRecord,
  P2TRWatchtowerChallengeRecordSource,
  buildP2TRSignatureFraudSubmissionIntent,
  computeP2TRSignatureFraudSubmissionIntentID,
  extractP2TRWalletIDFromScriptPubKey,
  validateP2TRSignatureFraudPreparedChallengeTransaction,
  validateP2TRSignatureFraudWitnessObservationConsistency,
} from "@keep-network/tbtc-v2.ts"

import type { P2TRSignatureFraudWatchtowerStoreProfileProvider } from "./types.js"

export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE = 1_000
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_LEASE_OWNER_LENGTH = 128
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH = 128
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_ERROR_LENGTH = 1_024
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_CURSOR_LENGTH = 512
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH = 128

export type P2TRSignatureFraudChallengeOutboxStatus =
  | "queued"
  | "preparing"
  | "prepared"
  | "broadcast-pending"
  | "external-satisfied-awaiting-own-transaction"
  | "accepted-own"
  | "satisfied-external"
  | "terminal-reverted"
  | "terminal-nonce-consumed"
  | "cancelled-before-broadcast"
  | "cancelled-honest-spend"
  | "cancelled-reorg"
  | "quarantined"

export type P2TRSignatureFraudOutboxEvidenceCheckpoint = {
  confirmedSourceComplete: true
  bitcoinTxHash: string
  bitcoinWitnessTxHash: string
  bitcoinInputIndex: number
  bitcoinBlockHash: string
  bitcoinBlockHeight: number
  bitcoinCursorBlockHash: string
  bitcoinCursorBlockHeight: number
  ethereumLifecycleBlockHash: string
  ethereumLifecycleBlockNumber: number
  activationManifest: P2TRSignatureFraudActivationManifestBinding
  /** Router deployment/activation block; it must predate every Submitted event. */
  submittedEventScanFromBlock: number
}

export type P2TRSignatureFraudActivationManifestBinding = {
  manifestHash: string
  routerCodeHash: string
  routerProtocolID: string
  completeAuthorizationRegistryAddress: string
  completeAuthorizationRegistryCodeHash: string
  completeAuthorizationRegistryProtocolID: string
  completeReservationModel: string
}

export type P2TRSignatureFraudCanonicalEthereumEligibilityEvidence = {
  readAtBlockNumber: number
  readAtBlockHash: string
  chainID: number
  routerAddress: string
  routerCodeHash: string
  routerProtocolID: string
  routerBridgeAddress: string
  routerChallengeKey: string
  routerChallengeAbsent: true
  completeAuthorizationRegistryAddress: string
  completeAuthorizationRegistryCodeHash: string
  completeAuthorizationRegistryProtocolID: string
  completeReservationModel: string
  completeChallengeIdentity: string
  completeWalletID: string
  completeAuthorizationAbsent: true
  completeReservationAbsent: true
  walletChallengeable: true
  canonicalProofBacklogComplete: true
  activationManifestHash: string
  /** SHA-256 of every normalized field above, computed by the adapter. */
  readSetHash: string
}

export const computeP2TRSignatureFraudEthereumEligibilityReadSetHash = (
  evidence: Omit<
    P2TRSignatureFraudCanonicalEthereumEligibilityEvidence,
    "readSetHash"
  >
): string =>
  `0x${createHash("sha256")
    .update(JSON.stringify(normalizeEthereumEligibilityReadSet(evidence)))
    .digest("hex")}`

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
  /** Derived by decoding the raw canonical transaction, never asserted by a caller. */
  decodedSubmissionCall: P2TRSignatureFraudDecodedSubmissionCall
}

export type P2TRSignatureFraudDecodedSubmissionCall = {
  variant: "router-process" | "router-direct"
  selector: string
  action: "submit"
  walletID: string
  bridgeChallengeIdentity: string
  challengeKey: string
  sighash: string
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
  /** Head sampled by the independent reconciler. */
  observedHead: P2TRSignatureFraudCanonicalBlock
  /** Canonical application-finality boundary used for every state read. */
  finalizedThrough: P2TRSignatureFraudCanonicalBlock
}

export type P2TRSignatureFraudOwnTransactionDisposition =
  | {
      status: "reverted"
      receipt: P2TRSignatureFraudCanonicalReceipt & { status: 0 }
    }
  | {
      status: "nonce-consumed"
      sender: string
      transactionNonce: number
      finalizedAccountNonce: number
      accountNonceReadAtBlock: number
      transactionAbsent: true
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
      status:
        | "accepted-own"
        | "satisfied-external"
        | "external-satisfied-awaiting-own-transaction"
      receipt: P2TRSignatureFraudCanonicalReceipt & { status: 1 }
      transaction: P2TRSignatureFraudCanonicalTransaction
      routerChallenge: Extract<
        P2TRSignatureFraudCanonicalRouterChallenge,
        { exists: true }
      >
      submittedEvent: P2TRSignatureFraudCanonicalSubmittedEvent
      /** Required to terminalize external satisfaction after any own send. */
      ownTransactionDisposition?: P2TRSignatureFraudOwnTransactionDisposition
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
  /** Holds the exclusive nonterminal nonce lane for this sender. */
  preparationSender?: string
  preparationLease?: P2TRSignatureFraudChallengeOutboxPreparationLease
  signerInvocationStartedAtUnixMs?: number
  preparedTransaction?: P2TRSignatureFraudPreparedChallengeTransaction
  lastBroadcastAtUnixMs?: number
  lastBroadcastProviderAccepted?: boolean
  lastReconciliationAtUnixMs?: number
  lastPreBroadcastRecheckAtUnixMs?: number
  lastPreBroadcastRecheckStatus?: P2TRSignatureFraudPreBroadcastRecheckResult["status"]
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

export type P2TRSignatureFraudChallengeOutboxPageRequest = {
  statuses: P2TRSignatureFraudChallengeOutboxStatus[]
  limit: number
  cursor?: string
}

export type P2TRSignatureFraudChallengeOutboxPage = {
  records: P2TRSignatureFraudChallengeOutboxRecord[]
  nextCursor?: string
}

export type P2TRSignatureFraudChallengeOutboxEligibilitySnapshot = {
  challengeRecord: P2TRWatchtowerChallengeRecord
  /** Reconstructed from the currently canonical candidate row in this transaction. */
  canonicalObservation: P2TRSignatureFraudWitnessObservation
  canonicalCandidate: P2TRSignatureFraudCanonicalObservationPointer
  canonicalCandidateDelivered: true
  canonicalCandidateCurrentAtCursor: true
  evidenceCheckpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint
  canonicalEthereumEligibility: P2TRSignatureFraudCanonicalEthereumEligibilityEvidence
  legacySubmissionQuarantined: boolean
  canonicalRegisteredWalletID: Hex | Buffer | string
  canonicalWalletInputAuthorization:
    | {
        kind: "registered-wallet-output"
        walletID: Hex | Buffer | string
        outputKey: Hex | Buffer | string
      }
    | {
        kind: "deposit-binding"
        binding: P2TRWalletInputKeyBinding
      }
}

export type P2TRSignatureFraudCanonicalObservationPointer = {
  txid: string
  wtxid: string
  blockHash: string
  blockHeight: number
  inputIndex: number
}

export type P2TRSignatureFraudChallengeOutboxSchedulerOptions = {
  submissionIntent: P2TRSignatureFraudSubmissionIntentOptions
  activationManifest: P2TRSignatureFraudActivationManifestBinding
  observationValidation: Omit<
    P2TRSignatureFraudWitnessObservationConsistencyContext,
    "registeredWalletIDs" | "walletInputKeyBindings"
  >
}

/**
 * Atomic compare-and-swap storage boundary for the production outbox.
 *
 * Implementations must enforce uniqueness for both `intentID` and
 * `(chainID, routerAddress, bridgeChallengeKey)`, plus one active
 * `preparationSender` lane per chain. `insertIfAbsent` and
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
  listPage(
    request: P2TRSignatureFraudChallengeOutboxPageRequest
  ): Promise<P2TRSignatureFraudChallengeOutboxPage>
  saveLegacyQuarantine(
    quarantine: P2TRSignatureFraudLegacySubmissionQuarantine
  ): Promise<void>
  /**
   * Locks and loads the authoritative observation, canonical cursor/proof
   * checkpoints, and legacy quarantine row. The callback and any outbox insert
   * it performs must commit atomically or roll back together.
   */
  runInEligibilityTransaction<T>(
    observationID: string,
    operation: (
      snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
    ) => Promise<T>
  ): Promise<T>
}

export interface P2TRSignatureFraudRawTransactionBroadcaster {
  readonly submissionTrustDomainID: string
  readonly providerIdentity: object
  broadcastRawTransaction(
    rawTransaction: string
  ): Promise<Hex | Buffer | string>
}

export type P2TRSignatureFraudChallengeOutboxReconciliationContext = {
  outboxStatus: P2TRSignatureFraudChallengeOutboxStatus
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
  /** Exact ABI-derived selectors this reconciler is allowed to decode. */
  readonly canonicalSubmissionSelectors: readonly {
    variant: P2TRSignatureFraudDecodedSubmissionCall["variant"]
    selector: string
  }[]
  reconcileSignatureFraudChallengeOutbox(
    context: P2TRSignatureFraudChallengeOutboxReconciliationContext
  ): Promise<P2TRSignatureFraudChallengeOutboxResolution>
}

export type P2TRSignatureFraudPreBroadcastRecheckContext = {
  stage: "before-sign" | "before-broadcast"
  intent: P2TRSignatureFraudSubmissionIntent
  evidenceCheckpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint
  preparedTransaction?: P2TRSignatureFraudPreparedChallengeTransaction
  broadcastAttempts: number
}

export type P2TRSignatureFraudPreBroadcastRecheckResult =
  | {
      status: "eligible"
      canonicalCandidate: P2TRSignatureFraudCanonicalObservationPointer
      canonicalEthereumEligibility: P2TRSignatureFraudCanonicalEthereumEligibilityEvidence
    }
  | {
      status: "cancelled-honest-spend" | "cancelled-reorg"
      reason: string
    }
  | {
      status: "unknown"
      reason: string
    }

export interface P2TRSignatureFraudPreBroadcastRechecker {
  readonly recheckTrustDomainID: string
  readonly providerIdentity: object
  recheckSignatureFraudChallengeBeforeBroadcast(
    context: P2TRSignatureFraudPreBroadcastRecheckContext
  ): Promise<P2TRSignatureFraudPreBroadcastRecheckResult>
}

export type P2TRSignatureFraudChallengeOutboxDispatcherOptions = {
  preparationLeaseMs?: number
  minimumRebroadcastIntervalMs?: number
  recoveryPageSize?: number
  onRecoveryBacklog?: (
    report: P2TRSignatureFraudChallengeOutboxRecoveryReport
  ) => Promise<void> | void
  now?: () => number
}

export type P2TRSignatureFraudChallengeOutboxRecoveryReport = {
  scanned: number
  recovered: number
  nextCursor?: string
  backlogRemaining: boolean
}

export class P2TRSignatureFraudChallengeOutboxScheduler {
  constructor(
    private readonly store: P2TRSignatureFraudChallengeOutboxStore,
    private readonly options: P2TRSignatureFraudChallengeOutboxSchedulerOptions
  ) {
    validateSchedulerOptions(options)
  }

  /**
   * Loads and validates authoritative evidence under the store's eligibility
   * transaction. Callers provide only the durable observation key; they cannot
   * supply an intent, cursor, Router binding, or confirmation assertion.
   */
  async enqueueConfirmedChallenge(
    observationID: Hex | Buffer | string,
    nowUnixMs = Date.now()
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const key = normalizeBytes32(observationID, "Challenge observation ID")
    return this.store.runInEligibilityTransaction(key, async (snapshot) => {
      // Cached record JSON is an evidence alias only. The candidate journal
      // supplies the current canonical witness bytes and authenticated
      // prevouts used to derive calldata.
      const canonicalObservation = snapshot.canonicalObservation
      validateAuthoritativeObservationBinding(snapshot)
      validateP2TRSignatureFraudWitnessObservationConsistency(
        canonicalObservation,
        canonicalObservationConsistencyContext(snapshot, this.options)
      )
      const intent = buildP2TRSignatureFraudSubmissionIntent(
        canonicalObservation,
        this.options.submissionIntent
      )
      validateEligibilitySnapshot(
        key,
        snapshot,
        intent,
        this.options.activationManifest
      )
      validateOutboxEnqueue(
        snapshot.challengeRecord,
        canonicalObservation,
        intent,
        snapshot.evidenceCheckpoint,
        nowUnixMs
      )

      const record: P2TRSignatureFraudChallengeOutboxRecord = {
        intent,
        evidenceCheckpoint: snapshot.evidenceCheckpoint,
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
    })
  }
}

export class P2TRSignatureFraudChallengeOutboxDispatcher {
  private readonly preparationLeaseMs: number
  private readonly minimumRebroadcastIntervalMs: number
  private readonly recoveryPageSize: number
  private readonly onRecoveryBacklog?: (
    report: P2TRSignatureFraudChallengeOutboxRecoveryReport
  ) => Promise<void> | void
  private readonly now: () => number

  constructor(
    private readonly store: P2TRSignatureFraudChallengeOutboxStore,
    private readonly preparer: P2TRSignatureFraudChallengeTransactionPreparer,
    private readonly broadcaster: P2TRSignatureFraudRawTransactionBroadcaster,
    private readonly preBroadcastRechecker: P2TRSignatureFraudPreBroadcastRechecker,
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
    this.recoveryPageSize = requireBoundedPositiveSafeInteger(
      options.recoveryPageSize ?? 100,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE,
      "Challenge outbox recovery page size"
    )
    this.onRecoveryBacklog = options.onRecoveryBacklog
    this.now = options.now ?? Date.now
    validateIndependentTransport(broadcaster, preBroadcastRechecker, reconciler)
  }

  async prepare(
    intentID: Hex | Buffer | string,
    leaseOwner: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const normalizedLeaseOwner = requireBoundedText(
      leaseOwner,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_LEASE_OWNER_LENGTH,
      "Challenge outbox preparation lease owner"
    )

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
    const preparationSender = normalizeAddress(
      this.preparer.transactionSender,
      "Challenge transaction preparer sender"
    )
    const leaseExpiresAtUnixMs = requireSafeIntegerSum(
      nowUnixMs,
      this.preparationLeaseMs,
      "Challenge outbox preparation lease expiration"
    )
    const claimed = nextRecord(current, {
      status: "preparing",
      preparationAttempts: current.preparationAttempts + 1,
      preparationSender,
      preparationLease: {
        owner: normalizedLeaseOwner,
        expiresAtUnixMs: leaseExpiresAtUnixMs,
      },
      updatedAtUnixMs: nowUnixMs,
      lastError: undefined,
    })
    if (!(await this.store.compareAndSwap(key, current.version, claimed))) {
      return this.requireRecord(key)
    }

    const preSignRecheck = await this.recheckIrreversibleAction(
      claimed,
      "before-sign"
    )
    if (preSignRecheck.status !== "eligible") {
      const recheckTime = requireUnixMilliseconds(
        this.now(),
        "Challenge outbox pre-sign recheck time"
      )
      const notSigned = nextRecord(claimed, {
        status:
          preSignRecheck.status === "unknown"
            ? "queued"
            : preSignRecheck.status,
        preparationLease: undefined,
        preparationSender: undefined,
        lastPreBroadcastRecheckAtUnixMs: recheckTime,
        lastPreBroadcastRecheckStatus: preSignRecheck.status,
        updatedAtUnixMs: recheckTime,
        lastError: requireReason(
          preSignRecheck.reason,
          "Challenge outbox pre-sign recheck reason"
        ),
      })
      await this.store.compareAndSwap(key, claimed.version, notSigned)
      return this.requireRecord(key)
    }

    const signerBoundaryTime = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox signer invocation time"
    )
    const signerBoundary = nextRecord(claimed, {
      signerInvocationStartedAtUnixMs: signerBoundaryTime,
      lastPreBroadcastRecheckAtUnixMs: signerBoundaryTime,
      lastPreBroadcastRecheckStatus: "eligible",
      updatedAtUnixMs: signerBoundaryTime,
      lastError: undefined,
    })
    if (
      !(await this.store.compareAndSwap(key, claimed.version, signerBoundary))
    ) {
      return this.requireRecord(key)
    }

    let prepared: P2TRSignatureFraudPreparedChallengeTransaction
    try {
      // Invoking a signer is the irreversible nonce boundary. Even if the
      // call later throws, signed bytes may have escaped a remote signer.
      prepared = validateP2TRSignatureFraudPreparedChallengeTransaction(
        signerBoundary.intent,
        await this.preparer.prepareSignatureFraudChallengeTransaction(
          signerBoundary.intent
        )
      )
      if (
        normalizeAddress(
          prepared.sender,
          "Prepared challenge transaction sender"
        ) !== preparationSender
      ) {
        throw new Error(
          "Prepared challenge transaction sender does not own the reserved nonce lane"
        )
      }
    } catch (error) {
      const failed = nextRecord(signerBoundary, {
        status: "quarantined",
        preparationLease: undefined,
        // Retain the sender lane until an operator proves the nonce consumed.
        preparationSender: signerBoundary.preparationSender,
        updatedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Challenge outbox preparation failure time"
        ),
        lastError: errorMessage(error),
      })
      await this.store.compareAndSwap(key, signerBoundary.version, failed)
      return this.requireRecord(key)
    }

    const persisted = nextRecord(signerBoundary, {
      status: "prepared",
      preparedTransaction: prepared,
      preparationLease: undefined,
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox prepared time"
      ),
      lastError: undefined,
    })
    if (
      !(await this.store.compareAndSwap(key, signerBoundary.version, persisted))
    ) {
      // The signer boundary remains durable and retains the sender lane even
      // if the prepared bytes could not be committed.
      return this.requireRecord(key)
    }
    return persisted
  }

  async recoverExpiredPreparationLeases(
    cursor?: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecoveryReport> {
    const normalizedCursor = optionalBoundedText(
      cursor,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_CURSOR_LENGTH,
      "Challenge outbox recovery cursor"
    )
    const page = await this.store.listPage({
      statuses: ["preparing"],
      limit: this.recoveryPageSize,
      cursor: normalizedCursor,
    })
    validateOutboxPage(page, this.recoveryPageSize)
    let recovered = 0
    for (const record of page.records) {
      const result = await this.recoverExpiredPreparation(record)
      if (result.status === "quarantined" || result.status === "queued") {
        recovered++
      }
    }
    const report: P2TRSignatureFraudChallengeOutboxRecoveryReport = {
      scanned: page.records.length,
      recovered,
      nextCursor: page.nextCursor,
      backlogRemaining: page.nextCursor !== undefined,
    }
    if (report.backlogRemaining) {
      await this.onRecoveryBacklog?.(report)
    }
    return report
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

    const rechecked = await this.recheckIrreversibleAction(
      current,
      "before-broadcast"
    )
    if (rechecked.status !== "eligible") {
      return this.applyPreBroadcastRecheckFailure(current, rechecked)
    }

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
      lastPreBroadcastRecheckAtUnixMs: nowUnixMs,
      lastPreBroadcastRecheckStatus: "eligible",
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
      current.status !== "broadcast-pending" &&
      current.status !== "external-satisfied-awaiting-own-transaction"
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
          outboxStatus: current.status,
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
        this.reconciler.finalityConfirmationBlocks,
        this.reconciler.canonicalSubmissionSelectors
      )
    } catch (error) {
      resolution = {
        status: "unknown",
        reason: errorMessage(
          `Challenge outbox reconciliation failed: ${errorMessage(error)}`
        ),
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
          preparationSender: undefined,
          lastError: undefined,
        })
        break
      case "external-satisfied-awaiting-own-transaction":
        next = nextRecord(current, {
          ...base,
          status: resolution.status,
          lastError:
            "External challenge is final; retaining the nonce lane until the prepared transaction is canonically resolved",
        })
        break
      case "pending":
      case "unknown":
        // Unknown is deliberately non-replayable: it never clears the prepared
        // transaction or permits a new transaction generation.
        next = nextRecord(current, {
          ...base,
          lastError: requireReason(
            resolution.reason,
            "Challenge reconciliation reason"
          ),
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
    if (current.status !== "queued") {
      throw new Error(
        "Challenge outbox transaction can be cancelled only before signer invocation"
      )
    }

    const cancelled = nextRecord(current, {
      status: "cancelled-before-broadcast",
      preparationLease: undefined,
      preparationSender: undefined,
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
    const signerWasInvoked =
      current.signerInvocationStartedAtUnixMs !== undefined
    const recovered = nextRecord(current, {
      // Once the signer boundary is durable, never sign a replacement or
      // release this lane on lease expiry.
      status: signerWasInvoked ? "quarantined" : "queued",
      preparationLease: undefined,
      preparationSender: signerWasInvoked
        ? current.preparationSender
        : undefined,
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox lease recovery time"
      ),
      lastError: signerWasInvoked
        ? "Challenge outbox preparation lease expired after the signer boundary; nonce lane retained"
        : "Challenge outbox preparation lease expired before signer invocation",
    })
    await this.store.compareAndSwap(
      intentKey(current.intent),
      current.version,
      recovered
    )
    return this.requireRecord(intentKey(current.intent))
  }

  private async recheckIrreversibleAction(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    stage: P2TRSignatureFraudPreBroadcastRecheckContext["stage"]
  ): Promise<P2TRSignatureFraudPreBroadcastRecheckResult> {
    try {
      const result =
        await this.preBroadcastRechecker.recheckSignatureFraudChallengeBeforeBroadcast(
          {
            stage,
            intent: current.intent,
            evidenceCheckpoint: current.evidenceCheckpoint,
            preparedTransaction:
              stage === "before-broadcast"
                ? current.preparedTransaction
                : undefined,
            broadcastAttempts: current.broadcastAttempts,
          }
        )
      validatePreBroadcastRecheckResult(current, result)
      return result
    } catch (error) {
      return {
        status: "unknown",
        reason: errorMessage(
          `Challenge outbox pre-broadcast recheck failed: ${errorMessage(
            error
          )}`
        ),
      }
    }
  }

  private async applyPreBroadcastRecheckFailure(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    result: Exclude<
      P2TRSignatureFraudPreBroadcastRecheckResult,
      { status: "eligible" }
    >
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox pre-broadcast recheck time"
    )
    const terminalCancellation =
      current.preparedTransaction === undefined &&
      current.status === "queued" &&
      result.status !== "unknown"
    const next = nextRecord(current, {
      status: terminalCancellation ? result.status : current.status,
      preparationSender: terminalCancellation
        ? undefined
        : current.preparationSender,
      lastPreBroadcastRecheckAtUnixMs: nowUnixMs,
      lastPreBroadcastRecheckStatus: result.status,
      updatedAtUnixMs: nowUnixMs,
      lastError: requireReason(
        result.reason,
        "Challenge outbox pre-broadcast recheck reason"
      ),
    })
    await this.store.compareAndSwap(
      intentKey(current.intent),
      current.version,
      next
    )
    return this.requireRecord(intentKey(current.intent))
  }

  private async quarantine(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    reason: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const postSendBoundary = current.broadcastAttempts > 0
    const quarantined = nextRecord(current, {
      status: postSendBoundary ? "broadcast-pending" : "quarantined",
      preparationLease: undefined,
      preparationSender: postSendBoundary
        ? current.preparationSender
        : undefined,
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

const canonicalObservationConsistencyContext = (
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  options: P2TRSignatureFraudChallengeOutboxSchedulerOptions
): P2TRSignatureFraudWitnessObservationConsistencyContext =>
  ({
    ...options.observationValidation,
    registeredWalletIDs: [snapshot.canonicalRegisteredWalletID],
    walletInputKeyBindings:
      snapshot.canonicalWalletInputAuthorization.kind === "deposit-binding"
        ? [snapshot.canonicalWalletInputAuthorization.binding]
        : [],
  } as P2TRSignatureFraudWitnessObservationConsistencyContext)

const validateSchedulerOptions = (
  options: P2TRSignatureFraudChallengeOutboxSchedulerOptions
): void => {
  if (options === undefined || typeof options !== "object") {
    throw new Error("Challenge outbox scheduler options are required")
  }
  const domain = options.observationValidation?.bridgeChallengeDomain
  if (domain === undefined) {
    throw new Error(
      "Challenge outbox scheduler requires a canonical Bridge challenge domain"
    )
  }
  if (
    normalizePositiveSafeIntegerLike(
      domain.chainID,
      "Observation Bridge challenge chain ID"
    ) !==
    normalizePositiveSafeIntegerLike(
      options.submissionIntent.chainID,
      "Submission intent chain ID"
    )
  ) {
    throw new Error(
      "Challenge outbox Bridge challenge domain and submission chain differ"
    )
  }
  if (
    normalizeAddress(domain.bridgeAddress, "Observation Bridge address") !==
    normalizeAddress(
      options.submissionIntent.bridgeAddress,
      "Submission intent Bridge address"
    )
  ) {
    throw new Error(
      "Challenge outbox Bridge challenge domain and submission Bridge differ"
    )
  }
  normalizeAddress(
    options.submissionIntent.routerAddress,
    "Submission intent Router address"
  )
  validateActivationManifestBinding(options.activationManifest)
}

const validateAuthoritativeObservationBinding = (
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
): void => {
  const observation = snapshot.canonicalObservation
  const walletID = normalizeBytes32(
    observation.walletID,
    "Canonical observation wallet ID"
  )
  if (
    normalizeBytes32(
      snapshot.canonicalRegisteredWalletID,
      "Canonical registered wallet ID"
    ) !== walletID
  ) {
    throw new Error(
      "Canonical observation wallet is not authorized by the registry index"
    )
  }
  const observedPrevout = observation.inputPrevouts[observation.inputIndex]
  const observedOutputKey = extractP2TRWalletIDFromScriptPubKey(
    observation.scriptPubKey
  )
  if (observedPrevout === undefined || observedOutputKey === undefined) {
    throw new Error(
      "Canonical observation input lacks an authenticated Taproot prevout"
    )
  }
  const outputKey = normalizeBytes32(
    observedOutputKey,
    "Canonical observation output key"
  )
  const authorization = snapshot.canonicalWalletInputAuthorization
  if (authorization.kind === "registered-wallet-output") {
    if (
      outputKey !== walletID ||
      normalizeBytes32(
        authorization.walletID,
        "Canonical wallet-output authorization wallet ID"
      ) !== walletID ||
      normalizeBytes32(
        authorization.outputKey,
        "Canonical wallet-output authorization output key"
      ) !== outputKey
    ) {
      throw new Error(
        "Canonical wallet output does not match the registered FROST wallet"
      )
    }
    return
  }
  const binding = authorization.binding
  if (
    normalizeBytes32(binding.txid, "Canonical deposit binding txid") !==
      normalizeBytes32(observedPrevout.txid, "Observed input prevout txid") ||
    requireUint32(binding.vout, "Canonical deposit binding vout") !==
      requireUint32(observedPrevout.vout, "Observed input prevout vout") ||
    normalizeBytes32(
      binding.outputKey,
      "Canonical deposit binding output key"
    ) !== outputKey ||
    normalizeBytes32(
      binding.walletID,
      "Canonical deposit binding wallet ID"
    ) !== walletID
  ) {
    throw new Error(
      "Canonical observation is not authorized by the exact deposit binding"
    )
  }
}

const validateEligibilitySnapshot = (
  requestedObservationID: string,
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  intent: P2TRSignatureFraudSubmissionIntent,
  activationManifest: P2TRSignatureFraudActivationManifestBinding
): void => {
  const observation = snapshot.canonicalObservation
  if (
    snapshot.canonicalCandidateDelivered !== true ||
    snapshot.canonicalCandidateCurrentAtCursor !== true
  ) {
    throw new Error(
      "Challenge outbox requires the current acknowledged canonical Bitcoin candidate"
    )
  }
  if (snapshot.legacySubmissionQuarantined) {
    throw new Error(
      "Challenge outbox eligibility is blocked by legacy submission quarantine"
    )
  }
  if (
    normalizeBytes32(
      snapshot.challengeRecord.observationID,
      "Stored observation alias"
    ) !== requestedObservationID ||
    normalizeBytes32(observation.observationID, "Canonical observation ID") !==
      requestedObservationID ||
    normalizeBytes32(intent.observationID, "Submission observation ID") !==
      requestedObservationID
  ) {
    throw new Error(
      "Challenge outbox observation alias is not the current canonical candidate"
    )
  }
  if (
    observation.bridgeChallengeKey === undefined ||
    normalizeBytes32(
      observation.bridgeChallengeKey,
      "Canonical observation Bridge challenge key"
    ) !==
      normalizeBytes32(
        intent.bridgeChallengeKey,
        "Submission intent Bridge challenge key"
      )
  ) {
    throw new Error(
      "Challenge outbox canonical observation and Router call identity differ"
    )
  }
  validateCanonicalEthereumEligibility(
    snapshot.canonicalEthereumEligibility,
    intent,
    activationManifest,
    {
      blockNumber: snapshot.evidenceCheckpoint.ethereumLifecycleBlockNumber,
      blockHash: snapshot.evidenceCheckpoint.ethereumLifecycleBlockHash,
      exactBlock: true,
    }
  )
  if (
    !sameActivationManifestBinding(
      activationManifest,
      snapshot.evidenceCheckpoint.activationManifest
    )
  ) {
    throw new Error(
      "Challenge outbox checkpoint does not match the activation manifest"
    )
  }
  validateCanonicalCandidatePointer(
    snapshot.canonicalCandidate,
    "Canonical challenge candidate"
  )
  if (
    normalizeBytes32(snapshot.canonicalCandidate.txid, "Candidate txid") !==
      normalizeBytes32(
        snapshot.evidenceCheckpoint.bitcoinTxHash,
        "Evidence Bitcoin txid"
      ) ||
    normalizeBytes32(snapshot.canonicalCandidate.wtxid, "Candidate wtxid") !==
      normalizeBytes32(
        snapshot.evidenceCheckpoint.bitcoinWitnessTxHash,
        "Evidence Bitcoin wtxid"
      ) ||
    normalizeBytes32(
      snapshot.canonicalCandidate.blockHash,
      "Candidate block hash"
    ) !==
      normalizeBytes32(
        snapshot.evidenceCheckpoint.bitcoinBlockHash,
        "Evidence Bitcoin block hash"
      ) ||
    snapshot.canonicalCandidate.blockHeight !==
      snapshot.evidenceCheckpoint.bitcoinBlockHeight ||
    snapshot.canonicalCandidate.inputIndex !== observation.inputIndex ||
    snapshot.canonicalCandidate.inputIndex !==
      snapshot.evidenceCheckpoint.bitcoinInputIndex
  ) {
    throw new Error(
      "Challenge outbox evidence does not identify the exact canonical witness candidate"
    )
  }
}

const validateOutboxEnqueue = (
  challengeRecord: P2TRWatchtowerChallengeRecord,
  canonicalObservation: P2TRSignatureFraudWitnessObservation,
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
    normalizeBytes32(challengeRecord.observationID, "Observation ID") !==
      normalizeBytes32(
        canonicalObservation.observationID,
        "Submission intent observation ID"
      ) ||
    normalizeBytes32(
      canonicalObservation.bridgeChallengeKey!,
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
    (
      challengeRecord as P2TRWatchtowerChallengeRecord & {
        bitcoinWtxid?: Hex | Buffer | string
      }
    ).bitcoinWtxid === undefined ||
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
      (
        challengeRecord as P2TRWatchtowerChallengeRecord & {
          bitcoinWtxid: Hex | Buffer | string
        }
      ).bitcoinWtxid,
      "Confirmed Bitcoin witness transaction hash"
    ) !==
      normalizeBytes32(
        evidence.bitcoinWitnessTxHash,
        "Checkpoint Bitcoin witness tx hash"
      ) ||
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
  normalizeBytes32(
    evidence.bitcoinWitnessTxHash,
    "Checkpoint Bitcoin witness tx hash"
  )
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
  requireUint32(evidence.bitcoinInputIndex, "Checkpoint Bitcoin input index")
  requireNonNegativeSafeInteger(
    evidence.bitcoinCursorBlockHeight,
    "Checkpoint Bitcoin cursor block height"
  )
  requireNonNegativeSafeInteger(
    evidence.ethereumLifecycleBlockNumber,
    "Checkpoint Ethereum lifecycle block number"
  )
  validateActivationManifestBinding(evidence.activationManifest)
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
    actual.intent.value !== expected.intent.value ||
    !sameEvidenceCheckpoint(
      actual.evidenceCheckpoint,
      expected.evidenceCheckpoint
    )
  ) {
    throw new Error(
      "Challenge outbox uniqueness conflict maps one intent or challenge key to different calls"
    )
  }
}

const validateIndependentTransport = (
  broadcaster: P2TRSignatureFraudRawTransactionBroadcaster,
  rechecker: P2TRSignatureFraudPreBroadcastRechecker,
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
  const recheckTrustDomainID = normalizeTrustDomainID(
    rechecker.recheckTrustDomainID,
    "Challenge pre-broadcast recheck trust-domain ID"
  )
  if (
    typeof broadcaster.providerIdentity !== "object" ||
    broadcaster.providerIdentity === null ||
    typeof rechecker.providerIdentity !== "object" ||
    rechecker.providerIdentity === null ||
    typeof reconciler.providerIdentity !== "object" ||
    reconciler.providerIdentity === null
  ) {
    throw new Error(
      "Challenge broadcaster and reconciler require provider identities"
    )
  }
  if (
    broadcaster.providerIdentity === reconciler.providerIdentity ||
    broadcaster.providerIdentity === rechecker.providerIdentity ||
    submissionTrustDomainID === reconciliationTrustDomainID ||
    submissionTrustDomainID === recheckTrustDomainID
  ) {
    throw new Error(
      "Challenge broadcasting, pre-send recheck, and reconciliation require independent provider instances and trust domains"
    )
  }
  requirePositiveSafeInteger(
    reconciler.finalityConfirmationBlocks,
    "Challenge reconciliation finality confirmation depth"
  )
  validateCanonicalSubmissionSelectors(reconciler.canonicalSubmissionSelectors)
}

const normalizeActivationManifestBinding = (
  manifest: P2TRSignatureFraudActivationManifestBinding
) => ({
  manifestHash: normalizeBytes32(
    manifest.manifestHash,
    "Activation manifest hash"
  ),
  routerCodeHash: normalizeBytes32(
    manifest.routerCodeHash,
    "Activation Router code hash"
  ),
  routerProtocolID: requireBoundedText(
    manifest.routerProtocolID,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH,
    "Activation Router protocol ID"
  ),
  completeAuthorizationRegistryAddress: normalizeAddress(
    manifest.completeAuthorizationRegistryAddress,
    "Activation COMPLETE authorization registry address"
  ),
  completeAuthorizationRegistryCodeHash: normalizeBytes32(
    manifest.completeAuthorizationRegistryCodeHash,
    "Activation COMPLETE authorization registry code hash"
  ),
  completeAuthorizationRegistryProtocolID: requireBoundedText(
    manifest.completeAuthorizationRegistryProtocolID,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH,
    "Activation COMPLETE authorization registry protocol ID"
  ),
  completeReservationModel: requireBoundedText(
    manifest.completeReservationModel,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH,
    "Activation COMPLETE reservation model"
  ),
})

const validateActivationManifestBinding = (
  manifest: P2TRSignatureFraudActivationManifestBinding
): void => {
  if (manifest === undefined || typeof manifest !== "object") {
    throw new Error("Challenge outbox activation manifest is required")
  }
  normalizeActivationManifestBinding(manifest)
}

const sameActivationManifestBinding = (
  left: P2TRSignatureFraudActivationManifestBinding,
  right: P2TRSignatureFraudActivationManifestBinding
): boolean =>
  JSON.stringify(normalizeActivationManifestBinding(left)) ===
  JSON.stringify(normalizeActivationManifestBinding(right))

const normalizeEthereumEligibilityReadSet = (
  evidence: Omit<
    P2TRSignatureFraudCanonicalEthereumEligibilityEvidence,
    "readSetHash"
  >
) => ({
  readAtBlockNumber: requireNonNegativeSafeInteger(
    evidence.readAtBlockNumber,
    "Ethereum eligibility block number"
  ),
  readAtBlockHash: normalizeBytes32(
    evidence.readAtBlockHash,
    "Ethereum eligibility block hash"
  ),
  chainID: requirePositiveSafeInteger(
    evidence.chainID,
    "Ethereum eligibility chain ID"
  ),
  routerAddress: normalizeAddress(
    evidence.routerAddress,
    "Ethereum eligibility Router address"
  ),
  routerCodeHash: normalizeBytes32(
    evidence.routerCodeHash,
    "Ethereum eligibility Router code hash"
  ),
  routerProtocolID: requireBoundedText(
    evidence.routerProtocolID,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH,
    "Ethereum eligibility Router protocol ID"
  ),
  routerBridgeAddress: normalizeAddress(
    evidence.routerBridgeAddress,
    "Ethereum eligibility Router Bridge address"
  ),
  routerChallengeKey: normalizeBytes32(
    evidence.routerChallengeKey,
    "Ethereum eligibility Router challenge key"
  ),
  routerChallengeAbsent: evidence.routerChallengeAbsent,
  completeAuthorizationRegistryAddress: normalizeAddress(
    evidence.completeAuthorizationRegistryAddress,
    "Ethereum eligibility COMPLETE authorization registry address"
  ),
  completeAuthorizationRegistryCodeHash: normalizeBytes32(
    evidence.completeAuthorizationRegistryCodeHash,
    "Ethereum eligibility COMPLETE authorization registry code hash"
  ),
  completeAuthorizationRegistryProtocolID: requireBoundedText(
    evidence.completeAuthorizationRegistryProtocolID,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH,
    "Ethereum eligibility COMPLETE authorization registry protocol ID"
  ),
  completeReservationModel: requireBoundedText(
    evidence.completeReservationModel,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH,
    "Ethereum eligibility COMPLETE reservation model"
  ),
  completeChallengeIdentity: normalizeBytes32(
    evidence.completeChallengeIdentity,
    "Ethereum eligibility COMPLETE challenge identity"
  ),
  completeWalletID: normalizeBytes32(
    evidence.completeWalletID,
    "Ethereum eligibility COMPLETE wallet ID"
  ),
  completeAuthorizationAbsent: evidence.completeAuthorizationAbsent,
  completeReservationAbsent: evidence.completeReservationAbsent,
  walletChallengeable: evidence.walletChallengeable,
  canonicalProofBacklogComplete: evidence.canonicalProofBacklogComplete,
  activationManifestHash: normalizeBytes32(
    evidence.activationManifestHash,
    "Ethereum eligibility activation manifest hash"
  ),
})

const validateCanonicalEthereumEligibility = (
  evidence: P2TRSignatureFraudCanonicalEthereumEligibilityEvidence,
  intent: P2TRSignatureFraudSubmissionIntent,
  activationManifest: P2TRSignatureFraudActivationManifestBinding,
  checkpoint: {
    blockNumber: number
    blockHash: string
    exactBlock: boolean
  }
): void => {
  if (evidence === undefined || typeof evidence !== "object") {
    throw new Error("Canonical Ethereum eligibility evidence is required")
  }
  const normalized = normalizeEthereumEligibilityReadSet(evidence)
  const manifest = normalizeActivationManifestBinding(activationManifest)
  if (
    evidence.routerChallengeAbsent !== true ||
    evidence.completeAuthorizationAbsent !== true ||
    evidence.completeReservationAbsent !== true ||
    evidence.walletChallengeable !== true ||
    evidence.canonicalProofBacklogComplete !== true
  ) {
    throw new Error(
      "Canonical Ethereum eligibility must prove challenge, authorization, and reservation absence for a challengeable wallet"
    )
  }
  if (
    normalized.chainID !== intent.chainID ||
    normalized.routerAddress !==
      normalizeAddress(intent.routerAddress, "Submission Router address") ||
    normalized.routerBridgeAddress !==
      normalizeAddress(intent.bridgeAddress, "Submission Bridge address") ||
    normalized.routerChallengeKey !==
      normalizeBytes32(intent.bridgeChallengeKey, "Submission challenge key") ||
    normalized.completeChallengeIdentity !==
      normalizeBytes32(
        intent.bridgeChallengeIdentity,
        "Submission Bridge challenge identity"
      ) ||
    normalized.completeWalletID !==
      normalizeBytes32(intent.walletID, "Submission wallet ID") ||
    normalized.routerCodeHash !== manifest.routerCodeHash ||
    normalized.routerProtocolID !== manifest.routerProtocolID ||
    normalized.completeAuthorizationRegistryAddress !==
      manifest.completeAuthorizationRegistryAddress ||
    normalized.completeAuthorizationRegistryCodeHash !==
      manifest.completeAuthorizationRegistryCodeHash ||
    normalized.completeAuthorizationRegistryProtocolID !==
      manifest.completeAuthorizationRegistryProtocolID ||
    normalized.completeReservationModel !== manifest.completeReservationModel ||
    normalized.activationManifestHash !== manifest.manifestHash
  ) {
    throw new Error(
      "Canonical Ethereum eligibility does not match the activation manifest and exact challenge identity"
    )
  }
  const expectedReadSetHash =
    computeP2TRSignatureFraudEthereumEligibilityReadSetHash(evidence)
  if (
    normalizeBytes32(
      evidence.readSetHash,
      "Ethereum eligibility read-set hash"
    ) !==
    normalizeBytes32(expectedReadSetHash, "Computed eligibility read-set hash")
  ) {
    throw new Error(
      "Canonical Ethereum eligibility lacks authenticated concrete adapter evidence"
    )
  }
  requireNonNegativeSafeInteger(
    checkpoint.blockNumber,
    "Eligibility checkpoint block"
  )
  const checkpointHash = normalizeBytes32(
    checkpoint.blockHash,
    "Eligibility checkpoint block hash"
  )
  if (
    (checkpoint.exactBlock &&
      (normalized.readAtBlockNumber !== checkpoint.blockNumber ||
        normalized.readAtBlockHash !== checkpointHash)) ||
    (!checkpoint.exactBlock &&
      (normalized.readAtBlockNumber < checkpoint.blockNumber ||
        (normalized.readAtBlockNumber === checkpoint.blockNumber &&
          normalized.readAtBlockHash !== checkpointHash)))
  ) {
    throw new Error(
      "Canonical Ethereum eligibility is behind or conflicts with the pinned lifecycle block"
    )
  }
}

const validatePreBroadcastRecheckResult = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  result: P2TRSignatureFraudPreBroadcastRecheckResult
): void => {
  if (result === undefined || typeof result !== "object") {
    throw new Error("Challenge pre-broadcast rechecker returned invalid data")
  }
  if (result.status !== "eligible") {
    if (
      result.status !== "unknown" &&
      result.status !== "cancelled-honest-spend" &&
      result.status !== "cancelled-reorg"
    ) {
      throw new Error(
        "Challenge pre-broadcast rechecker returned invalid status"
      )
    }
    requireReason(result.reason, "Challenge pre-broadcast recheck reason")
    return
  }
  validateCanonicalCandidatePointer(
    result.canonicalCandidate,
    "Pre-broadcast canonical candidate"
  )
  const evidence = record.evidenceCheckpoint
  if (
    normalizeBytes32(result.canonicalCandidate.txid, "Rechecked txid") !==
      normalizeBytes32(evidence.bitcoinTxHash, "Evidence txid") ||
    normalizeBytes32(result.canonicalCandidate.wtxid, "Rechecked wtxid") !==
      normalizeBytes32(evidence.bitcoinWitnessTxHash, "Evidence wtxid") ||
    normalizeBytes32(
      result.canonicalCandidate.blockHash,
      "Rechecked Bitcoin block hash"
    ) !== normalizeBytes32(evidence.bitcoinBlockHash, "Evidence block hash") ||
    result.canonicalCandidate.blockHeight !== evidence.bitcoinBlockHeight ||
    result.canonicalCandidate.inputIndex !== evidence.bitcoinInputIndex
  ) {
    throw new Error(
      "Challenge pre-broadcast recheck does not match the persisted witness candidate"
    )
  }
  validateCanonicalEthereumEligibility(
    result.canonicalEthereumEligibility,
    record.intent,
    evidence.activationManifest,
    {
      blockNumber: evidence.ethereumLifecycleBlockNumber,
      blockHash: evidence.ethereumLifecycleBlockHash,
      exactBlock: false,
    }
  )
}

const validateStructuredResolution = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  resolution: P2TRSignatureFraudChallengeOutboxResolution,
  finalityConfirmationBlocks: number,
  canonicalSubmissionSelectors: P2TRSignatureFraudChallengeOutboxReconciler["canonicalSubmissionSelectors"]
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
  validateCanonicalBlock(
    resolution.observedHead,
    "Observed reconciliation head"
  )
  validateCanonicalBlock(
    resolution.finalizedThrough,
    "Finalized reconciliation boundary"
  )
  if (
    resolution.observedHead.blockNumber -
      resolution.finalizedThrough.blockNumber <
    finalityConfirmationBlocks
  ) {
    throw new Error(
      "Canonical reconciliation boundary has not reached the required finality depth"
    )
  }
  if (
    resolution.observedHead.blockNumber ===
      resolution.finalizedThrough.blockNumber &&
    normalizeBytes32(
      resolution.observedHead.blockHash,
      "Observed reconciliation head hash"
    ) !==
      normalizeBytes32(
        resolution.finalizedThrough.blockHash,
        "Finalized reconciliation boundary hash"
      )
  ) {
    throw new Error("Canonical reconciliation heads disagree at one height")
  }

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
    resolution.finalizedThrough.blockNumber
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
        resolution.finalizedThrough.blockNumber ||
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
  if (
    resolution.receipt.blockNumber > resolution.finalizedThrough.blockNumber
  ) {
    throw new Error(
      "Canonical transaction receipt is newer than the finalized boundary"
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
    resolution.status === "accepted-own",
    canonicalSubmissionSelectors
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
  if (
    resolution.transaction.blockNumber >
      resolution.finalizedThrough.blockNumber ||
    resolution.submittedEvent.blockNumber >
      resolution.finalizedThrough.blockNumber
  ) {
    throw new Error(
      "Canonical accepted transaction is newer than the finalized boundary"
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
    ((resolution.status === "satisfied-external" ||
      resolution.status === "external-satisfied-awaiting-own-transaction") &&
      isOwn)
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
  validateExternalOwnTransactionDisposition(record, resolution, isOwn)
}

const validateCanonicalAcceptedTransaction = (
  intent: P2TRSignatureFraudSubmissionIntent,
  transaction: P2TRSignatureFraudCanonicalTransaction,
  requireExactIntent: boolean,
  canonicalSubmissionSelectors: P2TRSignatureFraudChallengeOutboxReconciler["canonicalSubmissionSelectors"]
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
  validateDecodedSubmissionCall(
    intent,
    transaction.decodedSubmissionCall,
    canonicalSubmissionSelectors
  )
  if (
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

const validateDecodedSubmissionCall = (
  intent: P2TRSignatureFraudSubmissionIntent,
  call: P2TRSignatureFraudDecodedSubmissionCall,
  canonicalSubmissionSelectors: P2TRSignatureFraudChallengeOutboxReconciler["canonicalSubmissionSelectors"]
): void => {
  if (
    call === undefined ||
    (call.variant !== "router-process" && call.variant !== "router-direct") ||
    call.action !== "submit"
  ) {
    throw new Error(
      "Canonical transaction was not decoded as an allowed P2TR submission call"
    )
  }
  normalizeFixedBytes(call.selector, 4, "Canonical submission selector")
  if (
    !canonicalSubmissionSelectors.some(
      (allowed) =>
        allowed.variant === call.variant &&
        normalizeFixedBytes(
          allowed.selector,
          4,
          "Allowed canonical submission selector"
        ) ===
          normalizeFixedBytes(call.selector, 4, "Canonical submission selector")
    )
  ) {
    throw new Error("Canonical submission selector is not ABI-allowlisted")
  }
  if (
    normalizeBytes32(call.walletID, "Decoded submission wallet ID") !==
      normalizeBytes32(intent.walletID, "Submission intent wallet ID") ||
    normalizeBytes32(
      call.bridgeChallengeIdentity,
      "Decoded Bridge challenge identity"
    ) !==
      normalizeBytes32(
        intent.bridgeChallengeIdentity,
        "Submission intent Bridge challenge identity"
      ) ||
    normalizeBytes32(call.challengeKey, "Decoded challenge key") !==
      normalizeBytes32(intent.bridgeChallengeKey, "Submission challenge key") ||
    normalizeBytes32(call.sighash, "Decoded submission sighash") !==
      normalizeBytes32(intent.sighash, "Submission intent sighash")
  ) {
    throw new Error(
      "Canonical decoded submission call does not match the durable challenge identity"
    )
  }
}

const validateCanonicalSubmissionSelectors = (
  selectors: P2TRSignatureFraudChallengeOutboxReconciler["canonicalSubmissionSelectors"]
): void => {
  if (
    !Array.isArray(selectors) ||
    selectors.length === 0 ||
    selectors.length > 16
  ) {
    throw new Error(
      "Challenge reconciler requires between one and sixteen canonical submission selectors"
    )
  }
  const normalized = new Set<string>()
  for (const selector of selectors) {
    if (
      selector === undefined ||
      (selector.variant !== "router-process" &&
        selector.variant !== "router-direct")
    ) {
      throw new Error("Challenge reconciler has an invalid submission selector")
    }
    const key = `${selector.variant}:${normalizeFixedBytes(
      selector.selector,
      4,
      "Canonical submission selector"
    )}`
    if (normalized.has(key)) {
      throw new Error(
        "Challenge reconciler has a duplicate submission selector"
      )
    }
    normalized.add(key)
  }
}

const validateExternalOwnTransactionDisposition = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  resolution: Extract<
    P2TRSignatureFraudChallengeOutboxResolution,
    {
      status:
        | "accepted-own"
        | "satisfied-external"
        | "external-satisfied-awaiting-own-transaction"
    }
  >,
  isOwn: boolean
): void => {
  const disposition = resolution.ownTransactionDisposition
  if (isOwn) {
    if (disposition !== undefined) {
      throw new Error(
        "Canonical own acceptance cannot include an external-satisfaction disposition"
      )
    }
    return
  }
  if (resolution.status === "external-satisfied-awaiting-own-transaction") {
    if (disposition !== undefined) {
      throw new Error(
        "External-awaiting resolution requires an unresolved prepared nonce"
      )
    }
    return
  }
  if (resolution.status !== "satisfied-external") {
    return
  }
  if (disposition === undefined) {
    throw new Error(
      "External satisfaction cannot release the nonce lane before the own transaction is resolved"
    )
  }
  const prepared = record.preparedTransaction!
  if (disposition.status === "reverted") {
    validateCanonicalReceipt(disposition.receipt)
    if (
      disposition.receipt.status !== 0 ||
      disposition.receipt.blockNumber >
        resolution.finalizedThrough.blockNumber ||
      normalizeBytes32(
        disposition.receipt.transactionHash,
        "Own reverted transaction hash"
      ) !==
        normalizeBytes32(prepared.transactionHash, "Prepared transaction hash")
    ) {
      throw new Error(
        "External satisfaction does not prove the own transaction reverted"
      )
    }
    return
  }
  if (
    disposition.transactionAbsent !== true ||
    normalizeAddress(disposition.sender, "Own nonce disposition sender") !==
      normalizeAddress(prepared.sender, "Prepared transaction sender") ||
    disposition.transactionNonce !== prepared.nonce ||
    disposition.accountNonceReadAtBlock !==
      resolution.finalizedThrough.blockNumber ||
    !Number.isSafeInteger(disposition.finalizedAccountNonce) ||
    disposition.finalizedAccountNonce <= prepared.nonce
  ) {
    throw new Error(
      "External satisfaction does not prove the own transaction nonce consumed"
    )
  }
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

const validateCanonicalCandidatePointer = (
  candidate: P2TRSignatureFraudCanonicalObservationPointer,
  label: string
): void => {
  if (candidate === undefined || typeof candidate !== "object") {
    throw new Error(`${label} must be an object`)
  }
  normalizeBytes32(candidate.txid, `${label} txid`)
  normalizeBytes32(candidate.wtxid, `${label} wtxid`)
  normalizeBytes32(candidate.blockHash, `${label} block hash`)
  requireNonNegativeSafeInteger(candidate.blockHeight, `${label} block height`)
  requireUint32(candidate.inputIndex, `${label} input index`)
}

const sameEvidenceCheckpoint = (
  left: P2TRSignatureFraudOutboxEvidenceCheckpoint,
  right: P2TRSignatureFraudOutboxEvidenceCheckpoint
): boolean =>
  left.confirmedSourceComplete === right.confirmedSourceComplete &&
  normalizeBytes32(left.bitcoinTxHash, "Stored evidence txid") ===
    normalizeBytes32(right.bitcoinTxHash, "Expected evidence txid") &&
  normalizeBytes32(left.bitcoinWitnessTxHash, "Stored evidence wtxid") ===
    normalizeBytes32(right.bitcoinWitnessTxHash, "Expected evidence wtxid") &&
  left.bitcoinInputIndex === right.bitcoinInputIndex &&
  normalizeBytes32(left.bitcoinBlockHash, "Stored evidence Bitcoin block") ===
    normalizeBytes32(
      right.bitcoinBlockHash,
      "Expected evidence Bitcoin block"
    ) &&
  left.bitcoinBlockHeight === right.bitcoinBlockHeight &&
  normalizeBytes32(
    left.bitcoinCursorBlockHash,
    "Stored evidence Bitcoin cursor"
  ) ===
    normalizeBytes32(
      right.bitcoinCursorBlockHash,
      "Expected evidence Bitcoin cursor"
    ) &&
  left.bitcoinCursorBlockHeight === right.bitcoinCursorBlockHeight &&
  normalizeBytes32(
    left.ethereumLifecycleBlockHash,
    "Stored evidence Ethereum cursor"
  ) ===
    normalizeBytes32(
      right.ethereumLifecycleBlockHash,
      "Expected evidence Ethereum cursor"
    ) &&
  left.ethereumLifecycleBlockNumber === right.ethereumLifecycleBlockNumber &&
  sameActivationManifestBinding(
    left.activationManifest,
    right.activationManifest
  ) &&
  left.submittedEventScanFromBlock === right.submittedEventScanFromBlock

const validateOutboxPage = (
  page: P2TRSignatureFraudChallengeOutboxPage,
  requestedLimit: number
): void => {
  requireBoundedPositiveSafeInteger(
    requestedLimit,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE,
    "Challenge outbox page limit"
  )
  if (
    page === undefined ||
    typeof page !== "object" ||
    !Array.isArray(page.records) ||
    page.records.length > requestedLimit
  ) {
    throw new Error("Challenge outbox store returned an invalid bounded page")
  }
  const intentIDs = new Set<string>()
  for (const record of page.records) {
    const key = intentKey(record.intent)
    if (intentIDs.has(key)) {
      throw new Error("Challenge outbox page contains a duplicate intent")
    }
    intentIDs.add(key)
  }
  optionalBoundedText(
    page.nextCursor,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_CURSOR_LENGTH,
    "Challenge outbox next-page cursor"
  )
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
  return requireBoundedText(
    value,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
    label
  ).toLowerCase()
}

const requireReason = (value: string, label: string): string => {
  return requireBoundedText(
    value,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_ERROR_LENGTH,
    label
  )
}

const requireBoundedText = (
  value: string,
  maximumLength: number,
  label: string
): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`)
  }
  const normalized = value.trim()
  if (normalized.length > maximumLength) {
    throw new Error(`${label} exceeds ${maximumLength} characters`)
  }
  return normalized
}

const optionalBoundedText = (
  value: string | undefined,
  maximumLength: number,
  label: string
): string | undefined =>
  value === undefined
    ? undefined
    : requireBoundedText(value, maximumLength, label)

const requireUnixMilliseconds = (value: number, label: string): number =>
  requireNonNegativeSafeInteger(value, label)

const requirePositiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

const requireBoundedPositiveSafeInteger = (
  value: number,
  maximum: number,
  label: string
): number => {
  const normalized = requirePositiveSafeInteger(value, label)
  if (normalized > maximum) {
    throw new Error(`${label} must not exceed ${maximum}`)
  }
  return normalized
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

const requireUint32 = (value: number, label: string): number => {
  const normalized = requireNonNegativeSafeInteger(value, label)
  if (normalized > 0xffffffff) {
    throw new Error(`${label} must be an unsigned 32-bit integer`)
  }
  return normalized
}

const requireSafeIntegerSum = (
  left: number,
  right: number,
  label: string
): number => {
  requireNonNegativeSafeInteger(left, `${label} left operand`)
  requireNonNegativeSafeInteger(right, `${label} right operand`)
  const sum = left + right
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`${label} overflows the safe integer range`)
  }
  return sum
}

const normalizePositiveSafeIntegerLike = (
  value: unknown,
  label: string
): number => {
  let serialized: string
  try {
    serialized =
      typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : (value as { toString(): string }).toString()
  } catch {
    throw new Error(`${label} must be a positive safe integer`)
  }
  if (!/^[1-9][0-9]*$/.test(serialized)) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  const parsed = BigInt(serialized)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return Number(parsed)
}

const errorMessage = (error: unknown): string => {
  let message: string
  try {
    message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : String(error)
  } catch {
    message = "Unknown provider error"
  }
  const normalized = message.trim() || "Unknown provider error"
  return normalized.slice(0, P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_ERROR_LENGTH)
}

const isPreparedTransactionValidationFailure = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("Prepared challenge transaction") ||
    error.message.includes("submission intent"))
