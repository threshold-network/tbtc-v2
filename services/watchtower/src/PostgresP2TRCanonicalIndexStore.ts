import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { Block, Transaction } from "bitcoinjs-lib"
import {
  calculateP2TRKeyPathSighash,
  classifyP2TRWitness,
  P2TRWitnessError,
} from "./P2TRCompleteV2BIP341.js"
import { calculateP2TRCanonicalOccurrenceID } from "./P2TRCanonicalOccurrenceIdentity.js"
import {
  computeP2TRCompleteAuthorizationDomainDigest,
  P2TR_COMPLETE_V2_PROTOCOL_ID,
} from "./P2TRCompleteCandidateIdentity.js"
import { P2TR_EVIDENCE_CHUNK_MAX_BYTES } from "./P2TRCanonicalBitcoinIndex.js"
import type {
  P2TRBitcoinChainPoint,
  P2TRBitcoinOutpoint,
  P2TRCanonicalBitcoinCursor,
  P2TRCanonicalBitcoinIndexStore,
  P2TRCanonicalBitcoinOrphanedCandidate,
  P2TRCanonicalBitcoinOutput,
  P2TRCanonicalBitcoinScan,
  P2TRCanonicalGenerationIdentity,
  P2TRCandidateObservationPage,
  P2TRCandidateObservationPageAcknowledgement,
  P2TRCandidateObservationPageRequest,
  P2TRCandidateObservationIdentity,
  P2TRCandidateProvenanceIdentity,
  P2TRCanonicalEvidenceStore,
  P2TRCompleteAuthorizationDomain,
  P2TRCompleteV2CandidateObservation,
  P2TRCrossSourceWatermark,
  P2TRReadinessExportStreamCursor,
  P2TRReadinessExportStreamFrame,
  P2TRFrostWalletBinding,
  P2TRLockedCandidateProvenance,
  P2TRReadinessSnapshot,
  P2TRReadinessExportHandle,
  P2TRReadinessExportAcknowledgement,
  P2TRReadinessExportRequest,
  P2TRInvalidatedCandidateProvenance,
  P2TRLegacyCandidateMaterializationStore,
  P2TRTaprootDepositBinding,
  P2TRTrackedOutpoint,
  P2TRUnmatchedProofEnvelope,
} from "./P2TRCanonicalBitcoinIndex.js"

export type P2TRPostgresQueryResult<Row> = {
  rows: Row[]
  rowCount: number | null
  /** PostgreSQL command tag. `pg` returns `ROLLBACK` when COMMIT aborts. */
  command?: string
}

/** Structurally compatible with a `pg` PoolClient. */
export interface P2TRPostgresClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>>
  /** Passing an error/true destroys the client instead of returning it to the pool. */
  release(error?: Error | boolean): void
}

/** Structurally compatible with a `pg` Pool. */
export interface P2TRPostgresPool {
  connect(): Promise<P2TRPostgresClient>
}

/** Query-only capability bound to this store's active serializable transaction. */
export interface P2TRPostgresTransactionSession {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>>
}

const p2trPostgresTransactionSessions = new WeakSet<object>()

/**
 * Rejects structurally compatible, but autocommit, sessions. Only the
 * transaction coordinator can mint this capability.
 */
export function assertP2TRPostgresTransactionSession(
  session: P2TRPostgresTransactionSession
): void {
  if (
    typeof session !== "object" ||
    session === null ||
    !p2trPostgresTransactionSessions.has(session)
  ) {
    throw new Error(
      "PostgreSQL adapter requires a coordinator-owned transaction session"
    )
  }
}

export type P2TRReadinessExportAcknowledgementVerification = {
  consumerID: string
  signingKeyID: string
  payloadDigest: string
  signature: string
}

export type PostgresP2TRCanonicalIndexStoreOptions = {
  storeID: string
  maxJournalBlocks: number
  maxJournalTransactions: number
  maxJournalInputs: number
  maxJournalOutputs: number
  maxWalletBindings: number
  maxPendingDepositReveals: number
  maxUnmatchedProofs: number
  maxProofMutationBatchSize: number
  maxProofPageSize: number
  maxProofPayloadBytes: number
  maxReadinessExports?: number
  /** Immutable COMPLETE_V2 authorization domain persisted on first use. */
  authorizationDomain: {
    chainID: string
    bridgeAddress: string
  }
  /** Immutable operator/source identities bound into every audit export. */
  sourceIdentity: {
    clusterID: string
    operatorID: string
    bitcoinIdentityDigest: string
    ethereumIdentityDigest: string
  }
  readinessExportSigner: {
    keyID: string
    signPayloadDigest(payloadDigest: string): Promise<string>
  }
  /**
   * Authenticates the consumer/key binding and signature before an ACK may
   * release generation retention. Returning anything but `true` rejects it.
   */
  readinessExportAcknowledgementVerifier: {
    verify(
      acknowledgement: P2TRReadinessExportAcknowledgementVerification
    ): Promise<boolean>
  }
  /** Upper bound for caller-selected export expiry; defaults to 24 hours. */
  maxReadinessExportLifetimeMs?: number
  statementTimeoutMs?: number
}

type CursorRow = {
  store_id: string
  configuration_fingerprint: string
  network: string
  trust_domain_id: string
  checkpoint_height: string | number
  checkpoint_hash: string
  current_height: string | number
  current_hash: string
  current_chain_commitment: string
  current_evidence_chain_commitment: string
  journal_block_count: string | number
  journal_transaction_count: string | number
  journal_input_count: string | number
  journal_output_count: string | number
  journal_unresolved_input_count: string | number
}

type JournalCounts = {
  blocks: number
  transactions: number
  inputs: number
  outputs: number
  unresolvedInputs: number
}

type TransactionContext = {
  client: P2TRPostgresClient
  readinessFence: "shared" | "exclusive"
  readinessSnapshotLocked: boolean
  mutationStarted: boolean
}

export type P2TRRetryablePostgresSQLState =
  | "40001"
  | "40P01"
  | "55P03"
  | "57014"

export type P2TRPostgresTransactionConfirmedAbortReason =
  | "retryable-sqlstate"
  | "definitive-commit-sqlstate"
  | "pre-transaction-retryable-sqlstate"
  | "pre-commit-transport-abort"
  | "rollback-command"

/**
 * Process-local signal that PostgreSQL definitively could not commit the
 * transaction, either because it aborted or because a bounded pre-transaction
 * fence could not be acquired.
 *
 * The generic coordinator never retries its callback. A higher-level owner
 * may catch this error, discard attempt-local state and external evidence,
 * and start a fresh whole transaction.
 */
export class P2TRPostgresTransactionConfirmedAbortError extends Error {
  readonly transactionOutcome = "confirmed-abort" as const

  constructor(
    readonly reason: P2TRPostgresTransactionConfirmedAbortReason,
    readonly sqlState: string | undefined,
    readonly postgresError: unknown,
    readonly operationError: unknown
  ) {
    super(
      reason === "pre-commit-transport-abort"
        ? "PostgreSQL transport failed before COMMIT; the transaction was aborted"
        : reason === "definitive-commit-sqlstate" && sqlState !== undefined
        ? `PostgreSQL rejected COMMIT with definitive SQLSTATE ${sqlState}`
        : sqlState === undefined
        ? "PostgreSQL confirmed that the transaction was rolled back"
        : reason === "pre-transaction-retryable-sqlstate"
        ? `PostgreSQL rejected pre-transaction work with ${sqlState}`
        : `PostgreSQL confirmed transaction abort ${sqlState}`,
      { cause: operationError }
    )
    this.name = "P2TRPostgresTransactionConfirmedAbortError"
  }
}

export const isP2TRPostgresTransactionConfirmedAbortError = (
  value: unknown
): value is P2TRPostgresTransactionConfirmedAbortError =>
  value instanceof P2TRPostgresTransactionConfirmedAbortError

/**
 * Process-local signal that PostgreSQL may have committed even though the
 * client did not receive a COMMIT response. Callers must not retry the work or
 * write a rollback-only disposition for this outcome.
 */
export class P2TRPostgresTransactionUnknownOutcomeError extends Error {
  readonly transactionOutcome = "unknown" as const

  constructor(readonly postgresError: Error) {
    super(
      `PostgreSQL COMMIT failed; transaction outcome is unknown: ${postgresError.message}`,
      { cause: postgresError }
    )
    this.name = "P2TRPostgresTransactionUnknownOutcomeError"
  }
}

export const isP2TRPostgresTransactionUnknownOutcomeError = (
  value: unknown
): value is P2TRPostgresTransactionUnknownOutcomeError =>
  value instanceof P2TRPostgresTransactionUnknownOutcomeError

type P2TRPostgresTransactionAttempt = {
  confirmedAbort?: {
    sqlState: string
    error: unknown
  }
  preCommitTransportAbort?: unknown
}

const REQUIRED_SCHEMA_VERSION = 4
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_READINESS_EXPORTS = 10_000
const DEFAULT_MAX_READINESS_EXPORT_LIFETIME_MS = 24 * 60 * 60 * 1000
const ABSOLUTE_MAX_READINESS_EXPORT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const BITCOIN_INPUT_INSERT_BATCH_SIZE = 128
const CANDIDATE_PREVOUT_SCRIPT_CHUNK_BYTES = 65_536

/**
 * PostgreSQL 16 canonical evidence store. Pass a configured `pg.Pool`; the
 * structural boundary keeps tests deterministic without substituting database
 * semantics in production.
 */
export class PostgresP2TRCanonicalIndexStore
  implements
    P2TRCanonicalEvidenceStore,
    P2TRCanonicalBitcoinIndexStore,
    P2TRLegacyCandidateMaterializationStore
{
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerAtomicTransactions = true as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string

  private readonly maxJournalBlocks: number
  private readonly maxJournalTransactions: number
  private readonly maxJournalInputs: number
  private readonly maxJournalOutputs: number
  private readonly maxWalletBindings: number
  private readonly maxPendingDepositReveals: number
  private readonly maxUnmatchedProofs: number
  private readonly maxProofMutationBatchSize: number
  private readonly maxProofPageSize: number
  private readonly maxProofPayloadBytes: number
  private readonly maxReadinessExports: number
  private readonly maxReadinessExportLifetimeMs: number
  private readonly authorizationDomain: {
    chainID: bigint
    bridgeAddress: Buffer
    digest: string
  }
  private readonly sourceIdentity: {
    clusterID: string
    operatorID: string
    bitcoinIdentityDigest: string
    ethereumIdentityDigest: string
    digest: string
  }
  private readonly readinessExportSigner: {
    keyID: string
    signPayloadDigest(payloadDigest: string): Promise<string>
  }
  private readonly readinessExportAcknowledgementVerifier: {
    verify(
      acknowledgement: P2TRReadinessExportAcknowledgementVerification
    ): Promise<boolean>
  }
  private readonly statementTimeoutMs: number
  private readonly transaction = new AsyncLocalStorage<TransactionContext>()
  private readonly transactionalParticipants = new WeakSet<object>()
  /**
   * Confirmed aborts this coordinator itself raised. The error class is
   * process-local, so membership is what proves the aborted transaction was
   * one of ours and is therefore ours to restart.
   */
  private readonly ownConfirmedAborts =
    new WeakSet<P2TRPostgresTransactionConfirmedAbortError>()
  private readonly ownUnknownOutcomes =
    new WeakSet<P2TRPostgresTransactionUnknownOutcomeError>()

  constructor(
    private readonly pool: P2TRPostgresPool,
    options: PostgresP2TRCanonicalIndexStoreOptions
  ) {
    this.p2trSignatureFraudWatchtowerTransactionalStoreID = boundedString(
      options.storeID,
      255,
      "PostgreSQL watchtower store ID"
    )
    this.maxJournalBlocks = positiveInteger(
      options.maxJournalBlocks,
      "PostgreSQL Bitcoin block journal capacity"
    )
    this.maxJournalTransactions = positiveInteger(
      options.maxJournalTransactions,
      "PostgreSQL Bitcoin transaction journal capacity"
    )
    this.maxJournalInputs = positiveInteger(
      options.maxJournalInputs,
      "PostgreSQL Bitcoin input journal capacity"
    )
    this.maxJournalOutputs = positiveInteger(
      options.maxJournalOutputs,
      "PostgreSQL Bitcoin output journal capacity"
    )
    this.maxWalletBindings = positiveInteger(
      options.maxWalletBindings,
      "PostgreSQL FROST wallet binding capacity"
    )
    this.maxPendingDepositReveals = positiveInteger(
      options.maxPendingDepositReveals,
      "PostgreSQL pending deposit reveal capacity"
    )
    this.maxUnmatchedProofs = positiveInteger(
      options.maxUnmatchedProofs,
      "PostgreSQL unmatched proof capacity"
    )
    this.maxProofMutationBatchSize = positiveInteger(
      options.maxProofMutationBatchSize,
      "PostgreSQL proof mutation batch bound"
    )
    this.maxProofPageSize = positiveInteger(
      options.maxProofPageSize,
      "PostgreSQL proof page bound"
    )
    this.maxProofPayloadBytes = positiveInteger(
      options.maxProofPayloadBytes,
      "PostgreSQL proof payload byte bound"
    )
    this.maxReadinessExports = positiveInteger(
      options.maxReadinessExports ?? DEFAULT_MAX_READINESS_EXPORTS,
      "PostgreSQL readiness export count capacity"
    )
    this.maxReadinessExportLifetimeMs = positiveInteger(
      options.maxReadinessExportLifetimeMs ??
        DEFAULT_MAX_READINESS_EXPORT_LIFETIME_MS,
      "PostgreSQL readiness export lifetime"
    )
    if (
      this.maxReadinessExportLifetimeMs >
      ABSOLUTE_MAX_READINESS_EXPORT_LIFETIME_MS
    ) {
      throw new Error("PostgreSQL readiness export lifetime exceeds 30 days")
    }
    this.authorizationDomain = normalizeP2TRAuthorizationDomain(
      options.authorizationDomain
    )
    const normalizedSourceIdentity = {
      clusterID: boundedString(
        options.sourceIdentity.clusterID,
        255,
        "PostgreSQL source cluster ID"
      ),
      operatorID: boundedString(
        options.sourceIdentity.operatorID,
        255,
        "PostgreSQL source operator ID"
      ),
      bitcoinIdentityDigest: normalizeBytes32(
        options.sourceIdentity.bitcoinIdentityDigest,
        "PostgreSQL source Bitcoin identity digest"
      ),
      ethereumIdentityDigest: normalizeBytes32(
        options.sourceIdentity.ethereumIdentityDigest,
        "PostgreSQL source Ethereum identity digest"
      ),
    }
    this.sourceIdentity = {
      ...normalizedSourceIdentity,
      digest: watchtowerSourceIdentityDigest({
        storeID: this.p2trSignatureFraudWatchtowerTransactionalStoreID,
        ...normalizedSourceIdentity,
      }),
    }
    this.readinessExportSigner = {
      keyID: boundedString(
        options.readinessExportSigner.keyID,
        255,
        "readiness export signing key ID"
      ),
      signPayloadDigest: options.readinessExportSigner.signPayloadDigest,
    }
    if (typeof this.readinessExportSigner.signPayloadDigest !== "function") {
      throw new Error("PostgreSQL readiness export signer is invalid")
    }
    this.readinessExportAcknowledgementVerifier =
      options.readinessExportAcknowledgementVerifier
    if (
      typeof this.readinessExportAcknowledgementVerifier?.verify !== "function"
    ) {
      throw new Error(
        "PostgreSQL readiness export acknowledgement verifier is invalid"
      )
    }
    this.statementTimeoutMs = positiveInteger(
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      "PostgreSQL statement timeout"
    )
    this.transactionalParticipants.add(this)
  }

  registerP2TRSignatureFraudWatchtowerTransactionalParticipant(
    participant: object
  ): void {
    if (typeof participant !== "object" || participant === null) {
      throw new Error("PostgreSQL transactional participant must be an object")
    }
    this.transactionalParticipants.add(participant)
  }

  createP2TRSignatureFraudWatchtowerTransactionalAdapter<T extends object>(
    factory: (session: P2TRPostgresTransactionSession) => T
  ): T {
    // The transaction client is already wrapped by
    // `observeRetryablePostgresAborts`, so a retryable SQLSTATE raised through
    // an adapter session is recorded at the query boundary even when the
    // adapter catches, wraps or swallows the error. Do not re-wrap it here:
    // the caller must keep seeing the original `pg` error and its `code`.
    const session: P2TRPostgresTransactionSession = {
      query: (text, values) =>
        this.requireTransactionClient().query(text, values),
    }
    p2trPostgresTransactionSessions.add(session)
    const adapter = factory(session)
    if (typeof adapter !== "object" || adapter === null) {
      throw new Error(
        "PostgreSQL transactional adapter factory must return an object"
      )
    }
    this.registerP2TRSignatureFraudWatchtowerTransactionalParticipant(adapter)
    return adapter
  }

  assertP2TRSignatureFraudWatchtowerTransactionalParticipants(
    participants: readonly object[]
  ): void {
    for (const participant of participants) {
      if (
        typeof participant !== "object" ||
        participant === null ||
        !this.transactionalParticipants.has(participant)
      ) {
        throw new Error(
          "P2TR watchtower dependency is not owned by this PostgreSQL transaction coordinator"
        )
      }
    }
  }

  /**
   * Report the retryable SQLSTATE of a transaction PostgreSQL is *confirmed*
   * to have aborted, so an owner may discard attempt-local state and start a
   * fresh whole transaction.
   *
   * Only a confirmed abort qualifies: a rolled-back-and-released session, or a
   * COMMIT that itself answered with 40001/40P01, or a bounded pre-snapshot
   * fence that failed before BEGIN. An unknown COMMIT outcome
   * never surfaces here — that session is destroyed and its transaction may
   * have committed, so it must never be retried. A COMMIT answering with the
   * `ROLLBACK` command tag is a confirmed abort with no SQLSTATE; it is
   * reported as non-retryable so the failure stays fail-closed and visible.
   */
  readP2TRSignatureFraudWatchtowerRetryableTransactionSQLState(
    error: unknown
  ): P2TRRetryablePostgresSQLState | undefined {
    if (!isP2TRPostgresTransactionConfirmedAbortError(error)) return undefined
    if (!this.ownConfirmedAborts.has(error)) return undefined
    return retryablePostgresSQLStateCode(error.sqlState)
  }

  isP2TRSignatureFraudWatchtowerTransactionOutcomeUnknown(
    error: unknown
  ): boolean {
    return (
      isP2TRPostgresTransactionUnknownOutcomeError(error) &&
      this.ownUnknownOutcomes.has(error)
    )
  }

  isP2TRSignatureFraudWatchtowerTransactionConfirmedPreCommitTransportAbort(
    error: unknown
  ): boolean {
    return (
      isP2TRPostgresTransactionConfirmedAbortError(error) &&
      this.ownConfirmedAborts.has(error) &&
      error.reason === "pre-commit-transport-abort"
    )
  }

  isP2TRSignatureFraudWatchtowerTransactionActive(): boolean {
    return this.transaction.getStore() !== undefined
  }

  assertP2TRSignatureFraudWatchtowerSharedStore(dependencies: {
    persistence: unknown
    transactionSource: unknown
    bridgeLifecycleEventSource: unknown
  }): void {
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (
        typeof dependency !== "object" ||
        dependency === null ||
        !this.transactionalParticipants.has(dependency)
      ) {
        throw new Error(
          `P2TR watchtower ${name} is not owned by this PostgreSQL transaction coordinator`
        )
      }
    }
  }

  async runInP2TRSignatureFraudWatchtowerTransaction<T>(
    operation: () => Promise<T>,
    options: {
      readinessFence?: "shared" | "exclusive"
    } = {}
  ): Promise<T> {
    const readinessFence = options.readinessFence ?? "shared"
    const active = this.transaction.getStore()
    if (active !== undefined) {
      if (
        readinessFence === "exclusive" &&
        active.readinessFence !== "exclusive"
      ) {
        throw new Error(
          "Exclusive readiness fence must be acquired before the transaction begins"
        )
      }
      return operation()
    }

    const rawClient = await this.pool.connect()
    let readinessFenceLocked = false
    let readinessFenceAcquisitionAttempted = false
    let transactionPhase: "begin" | "active" | "commit" | "finished" = "begin"
    let releaseError: Error | boolean | undefined
    let operationFailed = false
    let operationError: unknown
    let unlockError: Error | undefined
    let result!: T
    try {
      // PostgreSQL fixes a SERIALIZABLE snapshot at the first statement that
      // needs one. A transaction-scoped advisory lock is therefore too late:
      // it can wait behind a writer while retaining a snapshot from before
      // that writer committed. Acquire the session fence before BEGIN so a
      // readiness transaction cannot establish its snapshot until every
      // earlier writer has committed, and later writers remain blocked until
      // readiness has committed. This lock is taken before the transaction's
      // LOCAL statement timeout exists, so install a bounded session lock
      // timeout and restore the pool client's prior setting before BEGIN.
      try {
        const lockTimeout = await rawClient.query<{ lock_timeout: string }>(
          "SELECT current_setting('lock_timeout') AS lock_timeout"
        )
        if (lockTimeout.rows.length !== 1) {
          throw new Error("PostgreSQL lock timeout setting is unavailable")
        }
        const priorLockTimeout = boundedString(
          lockTimeout.rows[0].lock_timeout,
          64,
          "PostgreSQL lock timeout setting"
        )
        await rawClient.query("SELECT set_config('lock_timeout', $1, false)", [
          `${this.statementTimeoutMs}ms`,
        ])
        try {
          readinessFenceAcquisitionAttempted = true
          await rawClient.query(
            readinessFence === "exclusive"
              ? "SELECT pg_advisory_lock(hashtextextended('p2tr-readiness-pre-snapshot-fence', 0))"
              : "SELECT pg_advisory_lock_shared(hashtextextended('p2tr-readiness-pre-snapshot-fence', 0))"
          )
          readinessFenceLocked = true
        } finally {
          await rawClient.query(
            "SELECT set_config('lock_timeout', $1, false)",
            [priorLockTimeout]
          )
        }
      } catch (error) {
        const clientError = postgresClientError(
          error,
          "PostgreSQL readiness fence acquisition failed"
        )
        // Errors before the advisory-lock statement and lock_timeout's 55P03
        // prove no session fence was acquired. An interrupt such as 57014 can
        // arrive after PostgreSQL grants the session lock but before the query
        // response reaches this client, so every other acquisition failure
        // leaves session state uncertain and must destroy the pooled client.
        const responseSQLState = postgresSQLState(error)
        const fenceWasDefinitelyNotGranted =
          !readinessFenceAcquisitionAttempted || responseSQLState === "55P03"
        if (readinessFenceLocked || !fenceWasDefinitelyNotGranted) {
          releaseError = clientError
        }
        const sqlState = retryablePostgresSQLState(error)
        if (sqlState !== undefined) {
          const attempt: P2TRPostgresTransactionAttempt = {
            confirmedAbort: { sqlState, error },
          }
          throw this.ownConfirmedAbort(
            confirmedPostgresAbortError(
              attempt,
              "pre-transaction-retryable-sqlstate",
              clientError
            )
          )
        }
        throw clientError
      }

      const attempt: P2TRPostgresTransactionAttempt = {}
      const client = observeRetryablePostgresAborts(rawClient, attempt)
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
        transactionPhase = "active"
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          `${this.statementTimeoutMs}ms`,
        ])
        await this.assertDatabaseReady(client)
        const context: TransactionContext = {
          client,
          readinessFence,
          readinessSnapshotLocked: false,
          mutationStarted: false,
        }
        result = await this.transaction.run(context, async () => {
          const operationResult = await operation()
          // A callback may catch or wrap a database error. Do not allow an
          // aborted PostgreSQL transaction to appear successful or hide its
          // original retryable SQLSTATE behind a later 25P02 error.
          throwRecordedPostgresAbort(attempt)
          if (context.mutationStarted) {
            await this.commitCanonicalGenerationIfReady(client)
          }
          throwRecordedPostgresAbort(attempt)
          return operationResult
        })
        transactionPhase = "commit"
        const commit = await client.query("COMMIT")
        transactionPhase = "finished"
        if (normalizePostgresCommandTag(commit.command) === "ROLLBACK") {
          throw this.ownConfirmedAbort(
            confirmedPostgresAbortError(attempt, "rollback-command", undefined)
          )
        }
      } catch (error) {
        if (transactionPhase === "active") {
          try {
            await client.query("ROLLBACK")
            transactionPhase = "finished"
          } catch (rollbackError) {
            // The session may still be inside an aborted or even ambiguous
            // transaction. Preserve the original operation error, but ensure pg
            // destroys this client instead of returning it to the pool.
            releaseError = postgresClientError(
              rollbackError,
              "PostgreSQL ROLLBACK failed"
            )
            if (attempt.preCommitTransportAbort !== undefined) {
              throw this.ownConfirmedAbort(
                confirmedPostgresAbortError(
                  attempt,
                  "pre-commit-transport-abort",
                  error
                )
              )
            }
            throw error
          }
          if (attempt.confirmedAbort !== undefined) {
            throw this.ownConfirmedAbort(
              confirmedPostgresAbortError(attempt, "retryable-sqlstate", error)
            )
          }
          if (attempt.preCommitTransportAbort !== undefined) {
            throw this.ownConfirmedAbort(
              confirmedPostgresAbortError(
                attempt,
                "pre-commit-transport-abort",
                error
              )
            )
          }
        } else if (transactionPhase === "begin") {
          // A failed BEGIN response cannot prove whether the server entered the
          // transaction before the connection failed.
          releaseError = postgresClientError(error, "PostgreSQL BEGIN failed")
        } else if (transactionPhase === "commit") {
          // A PostgreSQL SQLSTATE proves the server aborted. Without that
          // response, the server may have committed before the response was
          // lost, so destroy the session and surface the unknown outcome.
          if (attempt.confirmedAbort !== undefined) {
            transactionPhase = "finished"
            throw this.ownConfirmedAbort(
              confirmedPostgresAbortError(
                attempt,
                confirmedPostgresCommitAbortReason(attempt),
                error
              )
            )
          }
          const commitError = postgresClientError(
            error,
            "PostgreSQL COMMIT failed"
          )
          releaseError = commitError
          throw this.ownUnknownOutcome(
            new P2TRPostgresTransactionUnknownOutcomeError(commitError)
          )
        }
        throw error
      }
    } catch (error) {
      operationFailed = true
      operationError = error
    } finally {
      if (readinessFenceLocked && releaseError === undefined) {
        try {
          const unlocked = await rawClient.query<{ unlocked: boolean }>(
            readinessFence === "exclusive"
              ? "SELECT pg_advisory_unlock(hashtextextended('p2tr-readiness-pre-snapshot-fence', 0)) AS unlocked"
              : "SELECT pg_advisory_unlock_shared(hashtextextended('p2tr-readiness-pre-snapshot-fence', 0)) AS unlocked"
          )
          if (
            unlocked.rows.length !== 1 ||
            unlocked.rows[0].unlocked !== true
          ) {
            throw new Error(
              "PostgreSQL readiness fence release was not confirmed"
            )
          }
        } catch (error) {
          unlockError = postgresClientError(
            error,
            "PostgreSQL readiness fence release failed"
          )
          releaseError = unlockError
        }
      }
      rawClient.release(releaseError)
    }
    if (operationFailed) throw operationError
    // COMMIT is the transaction outcome boundary. A later session-level fence
    // release failure destroys the client, but must not report already-
    // committed work as failed and discard its returned durable identity.
    if (unlockError !== undefined && transactionPhase !== "finished") {
      throw unlockError
    }
    return result
  }

  async loadBitcoinCursor(): Promise<P2TRCanonicalBitcoinCursor | undefined> {
    return this.withClient(async (client) => {
      const result = await client.query<CursorRow>(
        `SELECT store_id,
                encode(configuration_fingerprint, 'hex') AS configuration_fingerprint,
                network,
                trust_domain_id,
                checkpoint_height,
                encode(checkpoint_hash, 'hex') AS checkpoint_hash,
                current_height,
                encode(current_hash, 'hex') AS current_hash,
                encode(current_chain_commitment, 'hex') AS current_chain_commitment,
                encode(current_evidence_chain_commitment, 'hex') AS current_evidence_chain_commitment,
                journal_block_count,
                journal_transaction_count,
                journal_input_count,
                journal_output_count,
                journal_unresolved_input_count
           FROM p2tr_bitcoin_cursor
          WHERE singleton = true`
      )
      if (result.rows.length === 0) return undefined
      if (result.rows.length !== 1) {
        throw new Error("PostgreSQL Bitcoin cursor singleton is inconsistent")
      }
      const row = result.rows[0]
      if (
        row.store_id !== this.p2trSignatureFraudWatchtowerTransactionalStoreID
      ) {
        throw new Error("PostgreSQL Bitcoin cursor belongs to another store ID")
      }
      return {
        configurationFingerprint: normalizeBytes32(
          row.configuration_fingerprint,
          "stored Bitcoin configuration fingerprint"
        ),
        network: boundedString(row.network, 32, "stored Bitcoin network"),
        trustDomainID: boundedString(
          row.trust_domain_id,
          255,
          "stored Bitcoin trust domain ID"
        ),
        checkpoint: {
          height: databaseInteger(row.checkpoint_height, "checkpoint height"),
          hash: normalizeBytes32(row.checkpoint_hash, "checkpoint hash"),
        },
        current: {
          height: databaseInteger(row.current_height, "cursor height"),
          hash: normalizeBytes32(row.current_hash, "cursor hash"),
        },
      }
    })
  }

  async loadStoredBlockHash(height: number): Promise<string | undefined> {
    nonNegativeInteger(height, "Bitcoin block height")
    return this.withClient(async (client) => {
      const result = await client.query<{ hash: string }>(
        `SELECT encode(hash, 'hex') AS hash
           FROM p2tr_bitcoin_blocks
          WHERE height = $1`,
        [height]
      )
      if (result.rows.length > 1) {
        throw new Error("PostgreSQL Bitcoin block journal is inconsistent")
      }
      return result.rows[0]?.hash
    })
  }

  async loadTrackedOutpoints(
    outpoints: P2TRBitcoinOutpoint[]
  ): Promise<P2TRTrackedOutpoint[]> {
    if (outpoints.length === 0) return []
    const requested = outpoints.map((outpoint) => ({
      txid: normalizeBytes32(outpoint.txid, "requested outpoint txid"),
      vout: uint32(outpoint.vout, "requested outpoint index"),
    }))
    return this.withClient(async (client) => {
      const result = await client.query<TrackedOutpointRow>(
        `WITH requested AS (
           SELECT decode(item.txid, 'hex') AS txid, item.vout
             FROM jsonb_to_recordset($1::jsonb) AS item(txid text, vout bigint)
         )
         SELECT DISTINCT encode(tracked.txid, 'hex') AS txid,
                tracked.vout,
                tracked.kind,
                encode(tracked.wallet_id, 'hex') AS wallet_id,
                encode(tracked.output_key, 'hex') AS output_key,
                tracked.value_sats,
                encode(tracked.script_pubkey, 'hex') AS script_pubkey,
                tracked.created_height,
                encode(tracked.created_hash, 'hex') AS created_hash
           FROM p2tr_tracked_outpoints tracked
           JOIN requested
             ON requested.txid = tracked.txid
            AND requested.vout = tracked.vout`,
        [JSON.stringify(requested)]
      )
      return result.rows.map(trackedOutpointFromRow)
    })
  }

  async loadLatestCanonicalOutputs(
    outpoints: P2TRBitcoinOutpoint[]
  ): Promise<P2TRCanonicalBitcoinOutput[]> {
    if (outpoints.length === 0) return []
    if (outpoints.length > this.maxJournalInputs) {
      throw new Error(
        "Canonical prevout lookup exceeds the input journal bound"
      )
    }
    const requested = new Map<string, { txid: string; vout: number }>()
    for (const outpoint of outpoints) {
      const normalized = {
        txid: normalizeBytes32(outpoint.txid, "requested prevout txid"),
        vout: uint32(outpoint.vout, "requested prevout index"),
      }
      requested.set(`${normalized.txid}:${normalized.vout}`, normalized)
    }
    return this.withClient(async (client) => {
      const result = await client.query<JournalOutputRow>(
        `WITH requested AS (
           SELECT decode(item.txid, 'hex') AS txid, item.vout
             FROM jsonb_to_recordset($1::jsonb) AS item(txid text, vout bigint)
         )
         SELECT ${JOURNAL_OUTPUT_COLUMNS}
           FROM requested
           JOIN LATERAL (
             SELECT candidate.*
               FROM p2tr_bitcoin_outputs candidate
               JOIN p2tr_bitcoin_transactions transaction
                 ON transaction.block_hash = candidate.block_hash
                AND transaction.txid = candidate.txid
                AND transaction.wtxid = candidate.wtxid
              WHERE candidate.txid = requested.txid
                AND candidate.vout = requested.vout
              ORDER BY transaction.block_height DESC,
                       transaction.transaction_index DESC
              LIMIT 1
           ) output ON true
          ORDER BY output.txid, output.vout`,
        [JSON.stringify([...requested.values()])]
      )
      return result.rows.map((row) => ({
        txid: normalizeBytes32(row.txid, "journal prevout txid"),
        vout: uint32(row.vout, "journal prevout index"),
        valueSats: databaseInteger(row.value_sats, "journal prevout value"),
        scriptPubKey: normalizeScriptHex(
          row.script_pubkey,
          "journal prevout scriptPubKey"
        ),
      }))
    })
  }

  async loadRegisteredWalletIDs(): Promise<string[]> {
    return this.withClient(async (client) => {
      const result = await client.query<{ wallet_id: string }>(
        `SELECT encode(wallet_id, 'hex') AS wallet_id
           FROM p2tr_frost_wallet_bindings
          ORDER BY wallet_id
          LIMIT $1`,
        [this.maxWalletBindings + 1]
      )
      if (result.rows.length > this.maxWalletBindings) {
        throw new Error(
          "Registered wallet registry exceeds its configured capacity"
        )
      }
      return result.rows.map((row) =>
        normalizeBytes32(row.wallet_id, "registered wallet ID")
      )
    })
  }

  async loadCandidatesAbove(
    height: number
  ): Promise<P2TRCanonicalBitcoinOrphanedCandidate[]> {
    nonNegativeInteger(height, "Bitcoin common-ancestor height")
    return this.withClient(async (client) => {
      const result = await client.query<{
        txid: string
        wtxid: string
        block_height: string | number
        block_hash: string
      }>(
        `SELECT encode(txid, 'hex') AS txid,
                encode(wtxid, 'hex') AS wtxid,
                block_height,
                encode(block_hash, 'hex') AS block_hash
           FROM p2tr_bitcoin_candidates
          WHERE block_height > $1
          ORDER BY block_height, txid, wtxid
          LIMIT $2`,
        [height, this.maxJournalTransactions + 1]
      )
      if (result.rows.length > this.maxJournalTransactions) {
        throw new Error(
          "Orphaned candidate set exceeds its journal-derived bound"
        )
      }
      return result.rows.map((row) => ({
        txid: normalizeBytes32(row.txid, "orphaned candidate txid"),
        wtxid: normalizeBytes32(row.wtxid, "orphaned candidate wtxid"),
        block: {
          height: databaseInteger(row.block_height, "candidate block height"),
          hash: normalizeBytes32(row.block_hash, "candidate block hash"),
        },
      }))
    })
  }

  async loadPendingCandidates(
    limit: number,
    atOrBelowHeight: number
  ): Promise<{
    candidates: P2TRCanonicalBitcoinScan["candidates"]
    complete: boolean
  }> {
    positiveInteger(limit, "pending candidate page size")
    nonNegativeInteger(atOrBelowHeight, "pending candidate maximum height")
    return this.withClient(async (client) => {
      await this.assertLegacyCandidateMaterializationAllowed(client)
      const result = await client.query<CandidateRow>(
        `SELECT encode(candidate.txid, 'hex') AS txid,
                encode(candidate.wtxid, 'hex') AS wtxid,
                candidate.block_height,
                encode(candidate.block_hash, 'hex') AS block_hash,
                encode(journal_tx.raw_transaction, 'hex') AS raw_transaction,
                encode(journal_tx.raw_transaction_object_digest, 'hex')
                  AS raw_transaction_object_digest,
                candidate.provenance_generation,
                encode(candidate.provenance_fingerprint, 'hex')
                  AS provenance_fingerprint
           FROM p2tr_bitcoin_candidates candidate
           JOIN p2tr_bitcoin_transactions journal_tx
             ON journal_tx.block_hash = candidate.block_hash
            AND journal_tx.txid = candidate.txid
            AND journal_tx.wtxid = candidate.wtxid
          WHERE candidate.block_height <= $1
            AND EXISTS (
              SELECT 1
                FROM p2tr_bitcoin_candidate_observations observation
               WHERE observation.block_hash = candidate.block_hash
                 AND observation.txid = candidate.txid
                 AND observation.wtxid = candidate.wtxid
                 AND observation.provenance_generation =
                     candidate.provenance_generation
                 AND observation.disposition = 'keypath_pending'
            )
          ORDER BY candidate.block_height, candidate.txid, candidate.wtxid
          LIMIT $2`,
        [atOrBelowHeight, limit + 1]
      )
      const candidates: P2TRCanonicalBitcoinScan["candidates"] = []
      for (const row of result.rows.slice(0, limit)) {
        candidates.push(await this.materializeCandidate(client, row))
      }
      return {
        candidates,
        complete: result.rows.length <= limit,
      }
    })
  }

  async loadPendingCandidateObservations(
    request: P2TRCandidateObservationPageRequest
  ): Promise<P2TRCandidateObservationPage> {
    const limit = positiveInteger(
      request.limit,
      "pending candidate observation page size"
    )
    const atOrBelowHeight = nonNegativeInteger(
      request.atOrBelowHeight,
      "pending candidate observation maximum height"
    )
    if (limit > this.maxJournalInputs) {
      throw new Error(
        `Pending candidate observation page exceeds the configured ${this.maxJournalInputs}-input bound`
      )
    }
    return this.withClient(async (client) => {
      const latest = await client.query<CanonicalGenerationIdentityRow>(
        `SELECT generation_id,
                encode(manifest_digest, 'hex') AS manifest_digest,
                encode(domain_digest, 'hex') AS domain_digest
           FROM p2tr_canonical_generations
          WHERE state = 'committed'
          ORDER BY generation_id DESC
          LIMIT 1`
      )
      if (latest.rows.length === 0) {
        if (request.generation !== undefined || request.after !== undefined) {
          throw new Error(
            "Candidate observation cursor references an unavailable generation"
          )
        }
        return { state: "indexing", observations: [], complete: false }
      }
      if (latest.rows.length !== 1) {
        throw new Error("Canonical generation state is inconsistent")
      }
      const generation = canonicalGenerationIdentityFromRow(latest.rows[0])
      if (
        request.generation !== undefined &&
        !sameCanonicalGeneration(request.generation, generation)
      ) {
        throw new Error("Candidate observation cursor generation is stale")
      }
      if (request.after !== undefined && request.generation === undefined) {
        throw new Error(
          "Candidate observation cursor requires its pinned generation"
        )
      }
      const after =
        request.after === undefined
          ? undefined
          : decodeCandidateObservationPageCursor(request.after, {
              generation,
              atOrBelowHeight,
            })
      const result = await client.query<CandidateObservationRow>(
        `SELECT encode(observation.protocol_id, 'hex') AS protocol_id,
                encode(observation.domain_digest, 'hex') AS domain_digest,
                encode(observation.txid, 'hex') AS txid,
                encode(observation.wtxid, 'hex') AS wtxid,
                candidate.block_height,
                encode(observation.block_hash, 'hex') AS block_hash,
                observation.input_index,
                encode(observation.wallet_id, 'hex') AS wallet_id,
                encode(observation.signing_key, 'hex') AS signing_key,
                encode(observation.binding_tx_hash, 'hex') AS binding_tx_hash,
                observation.binding_output_index, observation.sighash_type,
                encode(observation.sighash, 'hex') AS sighash,
                encode(observation.nonce_x, 'hex') AS nonce_x,
                encode(observation.signature_scalar, 'hex') AS signature_scalar,
                encode(observation.challenge_identity, 'hex')
                  AS challenge_identity,
                encode(observation.occurrence_id, 'hex') AS occurrence_id,
                encode(observation.raw_transaction_digest, 'hex')
                  AS raw_transaction_digest,
                observation.raw_transaction_bytes,
                encode(observation.witness_digest, 'hex') AS witness_digest,
                encode(observation.annex_digest, 'hex') AS annex_digest,
                encode(observation.prevout_vector_root, 'hex')
                  AS prevout_vector_root,
                observation.prevout_count, observation.prevout_bytes,
                encode(observation.sha_prevouts, 'hex') AS sha_prevouts,
                encode(observation.sha_amounts, 'hex') AS sha_amounts,
                encode(observation.sha_script_pubkeys, 'hex')
                  AS sha_script_pubkeys,
                encode(observation.sha_sequences, 'hex') AS sha_sequences,
                encode(observation.sha_outputs, 'hex') AS sha_outputs,
                encode(observation.candidate_block_header_hash, 'hex')
                  AS candidate_block_header_hash,
                encode(observation.funding_block_header_hash, 'hex')
                  AS funding_block_header_hash,
                observation.provenance_generation,
                encode(observation.provenance_fingerprint, 'hex')
                  AS provenance_fingerprint,
                encode(provenance.funding_block_hash, 'hex')
                  AS funding_block_hash,
                encode(provenance.funding_txid, 'hex') AS funding_txid,
                provenance.funding_vout,
                encode(provenance.wallet_id, 'hex') AS provenance_wallet_id,
                encode(provenance.output_key, 'hex') AS output_key,
                provenance.binding_kind, provenance.source_event_id,
                provenance.ethereum_block_number,
                encode(provenance.ethereum_block_hash, 'hex')
                  AS ethereum_block_hash
           FROM p2tr_bitcoin_candidate_observations observation
           JOIN p2tr_bitcoin_candidates candidate
             ON candidate.block_hash = observation.block_hash
            AND candidate.txid = observation.txid
            AND candidate.wtxid = observation.wtxid
            AND candidate.provenance_generation =
                observation.provenance_generation
            AND candidate.provenance_fingerprint =
                observation.provenance_fingerprint
           JOIN p2tr_bitcoin_candidate_ethereum_provenance provenance
             ON provenance.block_hash = observation.block_hash
            AND provenance.txid = observation.txid
            AND provenance.wtxid = observation.wtxid
            AND provenance.input_index = observation.input_index
            AND provenance.provenance_generation =
                observation.provenance_generation
          WHERE observation.disposition = 'keypath_pending'
            AND candidate.block_height <= $1
            AND ($2::bigint IS NULL OR ROW(
                  candidate.block_height, observation.block_hash,
                  observation.txid, observation.wtxid,
                  observation.input_index
                ) > ROW(
                  $2::bigint, decode($3, 'hex'), decode($4, 'hex'),
                  decode($5, 'hex'), $6::integer
                ))
          ORDER BY candidate.block_height, observation.block_hash,
                   observation.txid, observation.wtxid,
                   observation.input_index
          LIMIT $7`,
        [
          atOrBelowHeight,
          after?.blockHeight ?? null,
          after?.blockHash ?? null,
          after?.txid ?? null,
          after?.wtxid ?? null,
          after?.inputIndex ?? null,
          limit + 1,
        ]
      )
      const observations = result.rows
        .slice(0, limit)
        .map(candidateObservationFromRow)
      const complete = result.rows.length <= limit
      const last = observations.at(-1)
      return {
        state: "ready",
        generation,
        observations,
        ...(complete || last === undefined
          ? {}
          : {
              nextAfter: encodeCandidateObservationPageCursor({
                generation,
                atOrBelowHeight,
                blockHeight: last.blockHeight,
                blockHash: last.blockHash,
                txid: last.txid,
                wtxid: last.wtxid,
                inputIndex: last.inputIndex,
              }),
            }),
        complete,
      }
    })
  }

  private async acknowledgeCandidateObservationPage(
    client: P2TRPostgresClient,
    atOrBelowHeight: number,
    acknowledgement: P2TRCandidateObservationPageAcknowledgement
  ): Promise<void> {
    if (
      acknowledgement.schema !==
      "tbtc-p2tr-candidate-observation-page-acknowledgement/v1"
    ) {
      throw new Error("Candidate observation acknowledgement schema is invalid")
    }
    const requestedCount = acknowledgement.observations.length
    if (requestedCount > this.maxJournalInputs) {
      throw new Error("Candidate observation acknowledgement exceeds its bound")
    }
    if (!acknowledgement.complete && requestedCount === 0) {
      throw new Error("Incomplete candidate observation page cannot be empty")
    }
    const expected = await this.loadPendingCandidateObservations({
      limit: Math.max(1, requestedCount),
      atOrBelowHeight,
      generation: acknowledgement.generation,
      ...(acknowledgement.after === undefined
        ? {}
        : { after: acknowledgement.after }),
    })
    if (
      expected.state !== "ready" ||
      !sameCanonicalGeneration(expected.generation, acknowledgement.generation)
    ) {
      throw new Error(
        "Candidate observation acknowledgement is not generation-pinned"
      )
    }
    const expectedIdentities = expected.observations
      .slice(0, requestedCount)
      .map(candidateObservationIdentityFromObservation)
    if (
      expectedIdentities.length !== requestedCount ||
      expected.complete !== acknowledgement.complete ||
      expected.nextAfter !== acknowledgement.nextAfter ||
      expectedIdentities.some(
        (identity, index) =>
          candidateObservationIdentityKey(identity) !==
          candidateObservationIdentityKey(acknowledgement.observations[index])
      )
    ) {
      throw new Error("Candidate observation acknowledgement page is not exact")
    }
    if (requestedCount === 0) return

    const acknowledgementJSON = JSON.stringify(
      acknowledgement.observations.map(candidateObservationIdentityJSON)
    )
    const result = await client.query<CandidateObservationIdentityRow>(
      `WITH acknowledged AS (
         SELECT decode(item.occurrence_id, 'hex') AS occurrence_id,
                decode(item.block_hash, 'hex') AS block_hash,
                decode(item.txid, 'hex') AS txid,
                decode(item.wtxid, 'hex') AS wtxid,
                item.input_index,
                decode(item.challenge_identity, 'hex') AS challenge_identity,
                item.provenance_generation,
                decode(item.provenance_fingerprint, 'hex')
                  AS provenance_fingerprint
           FROM jsonb_to_recordset($1::jsonb)
                AS item(occurrence_id text, block_hash text, txid text, wtxid text,
                        input_index integer, challenge_identity text,
                        provenance_generation bigint,
                        provenance_fingerprint text)
       )
       UPDATE p2tr_bitcoin_candidate_observations observation
          SET disposition = 'keypath_delivered',
              disposition_evidence_object_digest = NULL,
              delivered_at = clock_timestamp()
         FROM acknowledged
        WHERE observation.block_hash = acknowledged.block_hash
          AND observation.occurrence_id = acknowledged.occurrence_id
          AND observation.txid = acknowledged.txid
          AND observation.wtxid = acknowledged.wtxid
          AND observation.input_index = acknowledged.input_index
          AND observation.challenge_identity = acknowledged.challenge_identity
          AND observation.provenance_generation =
              acknowledged.provenance_generation
          AND observation.provenance_fingerprint =
              acknowledged.provenance_fingerprint
          AND observation.disposition = 'keypath_pending'
      RETURNING encode(observation.occurrence_id, 'hex') AS occurrence_id,
                encode(observation.block_hash, 'hex') AS block_hash,
                encode(observation.txid, 'hex') AS txid,
                encode(observation.wtxid, 'hex') AS wtxid,
                observation.input_index,
                encode(observation.challenge_identity, 'hex')
                  AS challenge_identity,
                observation.provenance_generation,
                encode(observation.provenance_fingerprint, 'hex')
                  AS provenance_fingerprint`,
      [acknowledgementJSON]
    )
    if (result.rows.length === requestedCount) return

    const updated = new Set(
      result.rows.map((row) =>
        candidateObservationIdentityKey(
          candidateObservationIdentityFromRow(row)
        )
      )
    )
    const stale = acknowledgement.observations.filter(
      (identity) => !updated.has(candidateObservationIdentityKey(identity))
    )
    const accepted = await client.query<{ accepted: boolean }>(
      `WITH stale AS (
         SELECT decode(item.occurrence_id, 'hex') AS occurrence_id,
                decode(item.block_hash, 'hex') AS block_hash,
                decode(item.txid, 'hex') AS txid,
                decode(item.wtxid, 'hex') AS wtxid,
                item.input_index,
                decode(item.challenge_identity, 'hex') AS challenge_identity,
                item.provenance_generation,
                decode(item.provenance_fingerprint, 'hex')
                  AS provenance_fingerprint
           FROM jsonb_to_recordset($1::jsonb)
                AS item(occurrence_id text, block_hash text, txid text, wtxid text,
                        input_index integer, challenge_identity text,
                        provenance_generation bigint,
                        provenance_fingerprint text)
       )
       SELECT EXISTS (
         SELECT 1
           FROM p2tr_invalidated_candidate_provenance invalidated
          WHERE invalidated.block_hash = stale.block_hash
            AND invalidated.txid = stale.txid
            AND invalidated.wtxid = stale.wtxid
            AND invalidated.provenance_generation = stale.provenance_generation
            AND invalidated.provenance_fingerprint =
                stale.provenance_fingerprint
       ) AS accepted
         FROM stale`,
      [JSON.stringify(stale.map(candidateObservationIdentityJSON))]
    )
    if (
      accepted.rows.length !== stale.length ||
      accepted.rows.some(({ accepted }) => accepted !== true)
    ) {
      throw new Error(
        "PostgreSQL candidate observation acknowledgement is absent or stale"
      )
    }
  }

  async lockP2TRCandidateProvenance(identity: {
    txid: string
    wtxid: string
    blockHash: string
  }): Promise<P2TRLockedCandidateProvenance | undefined> {
    const client = this.requireTransactionClient()
    if (this.transaction.getStore()?.readinessSnapshotLocked !== true) {
      throw new Error(
        "Candidate provenance claim requires a locked readiness snapshot"
      )
    }
    await this.assertLegacyCandidateMaterializationAllowed(client)
    const normalized = normalizeCandidateIdentity(identity)
    await this.lockCandidateProvenanceForMutation(client, normalized)
    const current = await client.query<CandidateRow>(
      `SELECT encode(candidate.txid, 'hex') AS txid,
              encode(candidate.wtxid, 'hex') AS wtxid,
              candidate.block_height,
              encode(candidate.block_hash, 'hex') AS block_hash,
              encode(journal_tx.raw_transaction, 'hex') AS raw_transaction,
              encode(journal_tx.raw_transaction_object_digest, 'hex')
                AS raw_transaction_object_digest,
              candidate.provenance_generation,
              encode(candidate.provenance_fingerprint, 'hex')
                AS provenance_fingerprint
         FROM p2tr_bitcoin_candidates candidate
         JOIN p2tr_bitcoin_transactions journal_tx
           ON journal_tx.block_hash = candidate.block_hash
          AND journal_tx.txid = candidate.txid
          AND journal_tx.wtxid = candidate.wtxid
        WHERE candidate.block_hash = $1
          AND candidate.txid = $2
          AND candidate.wtxid = $3
        FOR UPDATE OF candidate`,
      [
        hexBuffer(normalized.blockHash, "candidate block hash"),
        hexBuffer(normalized.txid, "candidate transaction ID"),
        hexBuffer(normalized.wtxid, "candidate witness transaction ID"),
      ]
    )
    if (current.rows.length === 0) return undefined
    if (current.rows.length !== 1) {
      throw new Error("Candidate provenance state is inconsistent")
    }
    const candidate = await this.materializeCandidate(client, current.rows[0])
    const inputProvenance = await this.loadCandidateInputProvenance(
      client,
      normalized,
      candidate.provenanceGeneration as number
    )
    return {
      ...normalized,
      blockHeight: candidate.block.height,
      rawTransactionHex: candidate.rawTransactionHex,
      inputPrevouts: candidate.inputPrevouts,
      walletInputKeyBindings: candidate.walletInputKeyBindings,
      provenanceFingerprint: candidate.provenanceFingerprint as string,
      provenanceGeneration: candidate.provenanceGeneration as number,
      inputProvenance,
    }
  }

  async lockP2TRReadinessSnapshot(): Promise<
    P2TRReadinessSnapshot | undefined
  > {
    const client = this.requireTransactionClient()
    const context = this.transaction.getStore() as TransactionContext
    if (context.mutationStarted && !context.readinessSnapshotLocked) {
      throw new Error(
        "Readiness snapshot must be locked before transaction mutations"
      )
    }
    if (!context.readinessSnapshotLocked) {
      await this.lockReadinessProjectionExclusive(client)
      context.readinessSnapshotLocked = true
    }
    const result = await client.query<ReadinessSnapshotRow>(
      `SELECT cursor.store_id,
              encode(cursor.configuration_fingerprint, 'hex')
                AS configuration_fingerprint,
              cursor.network,
              cursor.trust_domain_id,
              cursor.checkpoint_height,
              encode(cursor.checkpoint_hash, 'hex') AS checkpoint_hash,
              cursor.current_height,
              encode(cursor.current_hash, 'hex') AS current_hash,
              encode(cursor.current_chain_commitment, 'hex')
                AS current_chain_commitment,
              encode(cursor.current_evidence_chain_commitment, 'hex')
                AS current_evidence_chain_commitment,
              cursor.journal_block_count,
              cursor.journal_transaction_count,
              cursor.journal_input_count,
              cursor.journal_output_count,
              cursor.journal_unresolved_input_count,
              encode(complete_domain.protocol_id, 'hex')
                AS authorization_protocol_id,
              complete_domain.domain_chain_id::text
                AS authorization_domain_chain_id,
              encode(complete_domain.bridge_address, 'hex')
                AS authorization_bridge_address,
              encode(complete_domain.domain_digest, 'hex')
                AS authorization_domain_digest,
              state.generation,
              allocator.next_generation,
              allocator.next_invalidation_id,
              allocator.next_export_fence,
              GREATEST(
                COALESCE((
                  SELECT MAX(candidate.provenance_generation)
                    FROM p2tr_bitcoin_candidates candidate
                ), 0),
                COALESCE((
                  SELECT MAX(invalidated.provenance_generation)
                    FROM p2tr_invalidated_candidate_provenance invalidated
                ), 0)
              ) AS max_provenance_generation,
              COALESCE((
                SELECT MAX(invalidated.invalidation_id)
                  FROM p2tr_invalidated_candidate_provenance invalidated
              ), 0) AS max_invalidation_id,
              COALESCE((
                SELECT MAX(readiness_export.export_fence)
                  FROM p2tr_readiness_exports readiness_export
              ), 0) AS max_export_fence,
              encode(state.bitcoin_evidence_root, 'hex')
                AS bitcoin_evidence_root,
              encode(p2tr_muhash_finalize(
                state.semantic_numerator, state.semantic_denominator
              ), 'hex') AS semantic_commitment,
              state.semantic_row_count,
              encode(p2tr_muhash_finalize(
                state.projection_numerator, state.projection_denominator
              ), 'hex') AS projection_commitment,
              state.projection_row_count,
              state.wallet_binding_count,
              state.deposit_reveal_count,
              state.pending_deposit_reveal_count,
              state.tracked_outpoint_count,
              state.candidate_count,
              state.pending_candidate_count,
              state.candidate_provenance_count,
              state.invalidation_count,
              state.unmatched_proof_count,
              state.pending_unmatched_proof_count,
              state.watermark_count,
              watermark.bitcoin_height AS watermark_bitcoin_height,
              CASE WHEN watermark.bitcoin_hash IS NULL THEN NULL
                   ELSE encode(watermark.bitcoin_hash, 'hex') END
                AS watermark_bitcoin_hash,
              watermark.ethereum_block_number
                AS watermark_ethereum_block_number,
              CASE WHEN watermark.ethereum_block_hash IS NULL THEN NULL
                   ELSE encode(watermark.ethereum_block_hash, 'hex') END
                AS watermark_ethereum_block_hash,
              encode(p2tr_muhash_finalize(
                state.pending_deposit_numerator,
                state.pending_deposit_denominator
              ), 'hex') AS pending_deposit_commitment,
              encode(p2tr_muhash_finalize(
                state.pending_candidate_numerator,
                state.pending_candidate_denominator
              ), 'hex') AS pending_candidate_commitment,
              encode(p2tr_muhash_finalize(
                state.pending_proof_numerator,
                state.pending_proof_denominator
              ), 'hex') AS pending_proof_commitment
         FROM p2tr_readiness_projection_state state
         JOIN p2tr_bitcoin_cursor cursor ON cursor.singleton = true
         JOIN p2tr_candidate_provenance_generation allocator
           ON allocator.singleton = true
         JOIN p2tr_complete_authorization_domain complete_domain
           ON complete_domain.singleton = true
         LEFT JOIN p2tr_cross_source_watermark watermark
           ON watermark.singleton = true
        WHERE state.singleton = true
        FOR SHARE OF state, cursor, allocator, complete_domain`
    )
    if (result.rows.length === 0) return undefined
    if (result.rows.length !== 1) {
      throw new Error(
        "PostgreSQL readiness projection singleton is inconsistent"
      )
    }
    return readinessSnapshotFromRow(result.rows[0])
  }

  async exportP2TRReadinessSnapshot(
    request: P2TRReadinessExportRequest
  ): Promise<P2TRReadinessExportHandle> {
    const normalized = normalizeReadinessExportRequest(request)
    const requestDigest = readinessRoot(normalized)
    return this.runInP2TRSignatureFraudWatchtowerTransaction(() =>
      this.createReadinessExport(normalized, requestDigest)
    )
  }

  async loadP2TRReadinessExportByNonce(
    requestNonce: string
  ): Promise<P2TRReadinessExportHandle | undefined> {
    const nonce = normalizeBytes32(requestNonce, "readiness export nonce")
    return this.withClient((client) =>
      this.loadReadinessExportHandle(client, nonce)
    )
  }

  async *streamP2TRReadinessExportChunks(
    requestNonce: string,
    after?: P2TRReadinessExportStreamCursor
  ): AsyncIterable<P2TRReadinessExportStreamFrame> {
    const nonce = normalizeBytes32(requestNonce, "readiness export nonce")
    const start = normalizeReadinessExportStreamCursor(after)
    const active = this.transaction.getStore()
    const client = active?.client ?? (await this.pool.connect())
    try {
      if (active === undefined) await this.assertDatabaseReady(client)
      const exportRow = await client.query<{
        export_fence: string | number
        request_digest: string
        generation_manifest_digest: string
      }>(
        `SELECT export_fence,
                encode(request_digest, 'hex') AS request_digest,
                encode(generation_manifest_digest, 'hex')
                  AS generation_manifest_digest
           FROM p2tr_readiness_exports
          WHERE request_nonce = $1 AND state = 'sealed'`,
        [hexBuffer(nonce, "readiness export nonce")]
      )
      if (exportRow.rows.length !== 1) {
        throw new Error("Sealed readiness export is unavailable")
      }
      const exportFence = positiveInteger(
        databaseInteger(
          exportRow.rows[0].export_fence,
          "readiness export fence"
        ),
        "readiness export fence"
      )
      const exportID = readinessExportID(
        exportFence,
        exportRow.rows[0].request_digest,
        exportRow.rows[0].generation_manifest_digest
      )
      if (start !== undefined) {
        const exists = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM p2tr_readiness_export_objects exported
               JOIN p2tr_evidence_object_chunks chunk
                 ON chunk.object_digest = exported.object_digest
              WHERE exported.export_fence = $1
                AND exported.stream_ordinal = $2
                AND chunk.chunk_index = $3
           ) AS exists`,
          [exportFence, start.streamOrdinal, start.chunkIndex]
        )
        if (exists.rows.length !== 1 || exists.rows[0].exists !== true) {
          throw new Error("Readiness export stream cursor is invalid")
        }
      }
      let cursor = start
      for (;;) {
        const page = await client.query<ReadinessExportStreamRow>(
          `SELECT exported.stream_ordinal,
                  encode(exported.stream_leaf_digest, 'hex')
                    AS stream_leaf_digest,
                  encode(exported.object_digest, 'hex') AS object_digest,
                  exported.object_kind, exported.byte_length,
                  encode(exported.content_digest, 'hex') AS content_digest,
                  exported.chunk_count,
                  encode(exported.chunk_manifest_root, 'hex')
                    AS chunk_manifest_root,
                  chunk.chunk_index, chunk.byte_offset,
                  encode(chunk.chunk_digest, 'hex') AS chunk_digest,
                  encode(chunk.leaf_digest, 'hex') AS chunk_leaf_digest,
                  bytes.chunk_bytes
             FROM p2tr_readiness_export_objects exported
             JOIN p2tr_evidence_object_chunks chunk
               ON chunk.object_digest = exported.object_digest
             JOIN p2tr_evidence_chunks bytes USING (chunk_digest)
            WHERE exported.export_fence = $1
              AND ($2::bigint IS NULL OR
                   ROW(exported.stream_ordinal, chunk.chunk_index) >
                   ROW($2::bigint, $3::integer))
            ORDER BY exported.stream_ordinal, chunk.chunk_index
            LIMIT 64`,
          [
            exportFence,
            cursor?.streamOrdinal ?? null,
            cursor?.chunkIndex ?? null,
          ]
        )
        if (page.rows.length === 0) break
        for (const row of page.rows) {
          const frame = readinessExportStreamFrameFromRow(
            exportID,
            exportFence,
            row
          )
          cursor = {
            streamOrdinal: frame.streamOrdinal,
            chunkIndex: frame.chunk.index,
          }
          yield frame
        }
      }
    } finally {
      if (active === undefined) client.release()
    }
  }

  async acknowledgeP2TRReadinessExport(
    acknowledgement: P2TRReadinessExportAcknowledgement
  ): Promise<void> {
    const normalized = normalizeReadinessExportAcknowledgement(acknowledgement)
    if (
      calculateP2TRReadinessExportConsumerSignaturePayloadDigest(normalized) !==
      normalized.consumerSignaturePayloadDigest
    ) {
      throw new Error("Readiness export consumer signature payload is invalid")
    }
    const authenticated =
      await this.readinessExportAcknowledgementVerifier.verify({
        consumerID: normalized.consumerID,
        signingKeyID: normalized.consumerSigningKeyID,
        payloadDigest: normalized.consumerSignaturePayloadDigest,
        signature: normalized.consumerSignature,
      })
    if (authenticated !== true) {
      throw new Error("Readiness export consumer signature is unauthorized")
    }
    await this.withClient(async (client) => {
      const exact = await client.query<{ exact: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM p2tr_readiness_exports
            WHERE request_nonce = $1 AND export_fence = $2
              AND request_digest = $3 AND snapshot_root = $4
              AND result_digest = $5 AND audit_manifest_root = $6
              AND audit_stream_digest = $7 AND audit_object_count = $8
              AND audit_total_bytes = $9 AND state = 'sealed'
         ) AS exact`,
        [
          hexBuffer(normalized.requestNonce, "readiness export nonce"),
          normalized.exportFence,
          hexBuffer(normalized.requestDigest, "readiness request digest"),
          hexBuffer(normalized.snapshotRoot, "readiness snapshot root"),
          hexBuffer(normalized.resultDigest, "readiness result digest"),
          hexBuffer(normalized.auditManifestRoot, "readiness manifest root"),
          hexBuffer(normalized.finalStreamDigest, "readiness stream digest"),
          normalized.streamedObjectCount,
          normalized.streamedBytes,
        ]
      )
      if (exact.rows.length !== 1 || exact.rows[0].exact !== true) {
        throw new Error("Readiness export acknowledgement handle is stale")
      }
      await client.query(
        `SELECT p2tr_acknowledge_readiness_export(
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
                )`,
        [
          normalized.exportFence,
          normalized.consumerID,
          normalized.consumerSigningKeyID,
          hexBuffer(normalized.requestDigest, "readiness request digest"),
          hexBuffer(normalized.snapshotRoot, "readiness snapshot root"),
          hexBuffer(normalized.resultDigest, "readiness result digest"),
          hexBuffer(normalized.auditManifestRoot, "readiness manifest root"),
          hexBuffer(normalized.finalStreamDigest, "readiness stream digest"),
          normalized.streamedObjectCount,
          normalized.streamedBytes,
          hexBuffer(
            normalized.consumerSignaturePayloadDigest,
            "consumer signature payload digest"
          ),
          Buffer.from(normalized.consumerSignature, "hex"),
        ]
      )
    })
  }

  private async loadReadinessExportHandle(
    client: P2TRPostgresClient,
    requestNonce: string
  ): Promise<P2TRReadinessExportHandle | undefined> {
    const result = await client.query<ReadinessExportRow>(
      `SELECT encode(request_nonce, 'hex') AS request_nonce,
              encode(request_digest, 'hex') AS request_digest,
              export_fence,
              encode(snapshot_root, 'hex') AS snapshot_root,
              encode(snapshot_semantic_root, 'hex') AS snapshot_semantic_root,
              snapshot_generation, pinned_generation,
              encode(generation_manifest_digest, 'hex')
                AS generation_manifest_digest,
              encode(domain_digest, 'hex') AS domain_digest,
              source_store_id, source_cluster_id, source_operator_id,
              source_trust_domain_id,
              encode(source_bitcoin_identity_digest, 'hex')
                AS source_bitcoin_identity_digest,
              encode(source_ethereum_identity_digest, 'hex')
                AS source_ethereum_identity_digest,
              encode(source_identity_digest, 'hex') AS source_identity_digest,
              encode(source_configuration_fingerprint, 'hex')
                AS source_configuration_fingerprint,
              source_signing_key_id,
              encode(source_signature, 'hex') AS source_signature,
              encode(source_signature_payload_digest, 'hex')
                AS source_signature_payload_digest,
              canonical_request, result_payload,
              encode(result_digest, 'hex') AS result_digest,
              encode(audit_manifest_root, 'hex') AS audit_manifest_root,
              encode(audit_stream_digest, 'hex') AS audit_stream_digest,
              audit_object_count, audit_total_bytes
         FROM p2tr_readiness_exports
        WHERE request_nonce = $1 AND state = 'sealed'`,
      [hexBuffer(requestNonce, "readiness export nonce")]
    )
    if (result.rows.length === 0) return undefined
    if (result.rows.length !== 1) {
      throw new Error("Readiness export nonce ledger is inconsistent")
    }
    return readinessExportHandleFromRow(result.rows[0])
  }

  private async createReadinessExport(
    request: P2TRReadinessExportRequest,
    requestDigest: string
  ): Promise<P2TRReadinessExportHandle> {
    const client = this.requireTransactionClient()
    await this.lockReadinessProjectionExclusive(client)
    const existing = await this.loadReadinessExportHandle(
      client,
      request.requestNonce
    )
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) {
        throw new Error("Readiness export nonce is bound to another request")
      }
      return existing
    }
    const expiry = await client.query<{ valid: boolean }>(
      `SELECT $1::timestamptz > clock_timestamp() AND
              $1::timestamptz <= clock_timestamp() +
                ($2::bigint * interval '1 millisecond') AS valid`,
      [request.expiresAt, this.maxReadinessExportLifetimeMs]
    )
    if (expiry.rows.length !== 1 || expiry.rows[0].valid !== true) {
      throw new Error(
        "Readiness export expiry is outside the configured window"
      )
    }
    const active = await client.query<{ count: string | number }>(
      `SELECT count(*) AS count
         FROM p2tr_readiness_exports export
        WHERE export.state = 'sealed'
          AND export.expires_at > clock_timestamp()
          AND NOT EXISTS (
            SELECT 1
              FROM p2tr_readiness_export_acknowledgements acknowledgement
             WHERE acknowledgement.export_fence = export.export_fence
          )`
    )
    if (
      active.rows.length !== 1 ||
      databaseInteger(active.rows[0].count, "active readiness export count") >=
        this.maxReadinessExports
    ) {
      throw new Error("PostgreSQL active readiness export capacity is reached")
    }
    const snapshot = await this.lockP2TRReadinessSnapshot()
    if (snapshot === undefined) {
      throw new Error("Readiness export requires an initialized Bitcoin index")
    }
    const generationResult = await client.query<CanonicalGenerationExportRow>(
      `SELECT generation_id,
              encode(manifest_digest, 'hex') AS manifest_digest,
              encode(domain_digest, 'hex') AS domain_digest,
              bitcoin_height,
              encode(bitcoin_hash, 'hex') AS bitcoin_hash,
              encode(bitcoin_chain_root, 'hex') AS bitcoin_chain_root,
              encode(projection_root, 'hex') AS projection_root,
              encode(semantic_root, 'hex') AS semantic_root
         FROM p2tr_canonical_generations
        WHERE state = 'committed'
        ORDER BY generation_id DESC
        LIMIT 1
        FOR SHARE`
    )
    if (generationResult.rows.length !== 1) {
      throw new Error(
        "Readiness export requires a committed canonical generation"
      )
    }
    const generation = generationResult.rows[0]
    assertGenerationMatchesSnapshot(generation, snapshot)
    const candidate =
      request.candidate === undefined
        ? undefined
        : await this.loadReadinessExportCandidate(client, request.candidate)
    const resultPayload = {
      schema: "tbtc-p2tr-readiness-export-result/v1",
      snapshot,
      ...(candidate === undefined ? {} : { candidate }),
    }
    const resultDigest = readinessRoot(resultPayload)
    const fenceResult = await client.query<{
      export_fence: string | number
    }>(
      `UPDATE p2tr_candidate_provenance_generation
          SET next_export_fence = next_export_fence + 1
        WHERE singleton = true
      RETURNING next_export_fence - 1 AS export_fence`
    )
    if (fenceResult.rows.length !== 1) {
      throw new Error("Readiness export fence allocation failed")
    }
    const exportFence = positiveInteger(
      databaseInteger(
        fenceResult.rows[0].export_fence,
        "readiness export fence"
      ),
      "readiness export fence"
    )
    const generationID = positiveInteger(
      databaseInteger(generation.generation_id, "pinned generation ID"),
      "pinned generation ID"
    )
    await client.query(
      `INSERT INTO p2tr_readiness_exports
         (request_nonce, request_digest, export_fence, snapshot_root,
          snapshot_semantic_root, snapshot_generation, pinned_generation,
          generation_manifest_digest, domain_digest, source_store_id,
          source_cluster_id, source_operator_id, source_trust_domain_id,
          source_bitcoin_identity_digest, source_ethereum_identity_digest,
          source_identity_digest, source_signing_key_id,
          source_configuration_fingerprint,
          candidate_provenance_generation,
          candidate_provenance_fingerprint, candidate_input_index,
          candidate_challenge_identity, candidate_occurrence_id,
          canonical_request, result_payload,
          result_digest, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
               $24::jsonb, $25::jsonb, $26, $27::timestamptz)`,
      [
        hexBuffer(request.requestNonce, "readiness export nonce"),
        hexBuffer(requestDigest, "readiness export request digest"),
        exportFence,
        hexBuffer(snapshot.root, "readiness snapshot root"),
        hexBuffer(snapshot.semanticRoot, "readiness semantic root"),
        snapshot.generation,
        generationID,
        hexBuffer(generation.manifest_digest, "generation manifest digest"),
        hexBuffer(generation.domain_digest, "generation domain digest"),
        this.p2trSignatureFraudWatchtowerTransactionalStoreID,
        this.sourceIdentity.clusterID,
        this.sourceIdentity.operatorID,
        snapshot.trustDomainID,
        hexBuffer(
          this.sourceIdentity.bitcoinIdentityDigest,
          "source Bitcoin identity digest"
        ),
        hexBuffer(
          this.sourceIdentity.ethereumIdentityDigest,
          "source Ethereum identity digest"
        ),
        hexBuffer(this.sourceIdentity.digest, "source identity digest"),
        this.readinessExportSigner.keyID,
        hexBuffer(
          snapshot.configurationFingerprint,
          "source configuration fingerprint"
        ),
        candidate?.provenanceGeneration ?? null,
        candidate === undefined
          ? null
          : hexBuffer(
              candidate.provenanceFingerprint,
              "candidate provenance fingerprint"
            ),
        candidate?.inputIndex ?? null,
        candidate === undefined
          ? null
          : hexBuffer(
              candidate.observation.challengeIdentity,
              "candidate challenge identity"
            ),
        candidate === undefined
          ? null
          : hexBuffer(
              candidate.observation.occurrenceID,
              "candidate occurrence ID"
            ),
        JSON.stringify(request),
        JSON.stringify(resultPayload),
        hexBuffer(resultDigest, "readiness export result digest"),
        request.expiresAt,
      ]
    )
    return this.sealReadinessExport(
      client,
      exportFence,
      generationID,
      request.requestNonce,
      {
        requestDigest,
        generation: {
          generationID,
          manifestDigest: normalizeBytes32(
            generation.manifest_digest,
            "generation manifest digest"
          ),
          domainDigest: normalizeBytes32(
            generation.domain_digest,
            "generation domain digest"
          ),
        },
        snapshotRoot: snapshot.root,
        snapshotSemanticRoot: snapshot.semanticRoot,
        snapshotGeneration: snapshot.generation,
        resultDigest,
        expiresAt: request.expiresAt,
      }
    )
  }

  private async sealReadinessExport(
    client: P2TRPostgresClient,
    exportFence: number,
    generationID: number,
    requestNonce: string,
    signed: Pick<
      ReadinessExportSourceSignaturePayloadFields,
      | "requestDigest"
      | "generation"
      | "snapshotRoot"
      | "snapshotSemanticRoot"
      | "snapshotGeneration"
      | "resultDigest"
      | "expiresAt"
    >
  ): Promise<P2TRReadinessExportHandle> {
    await client.query(
      `WITH required AS (
         SELECT DISTINCT membership.object_digest
           FROM p2tr_canonical_memberships membership
          WHERE membership.valid_from_generation <= $2
            AND (
              membership.valid_to_generation IS NULL OR
              membership.valid_to_generation > $2
            )
         UNION
         SELECT bitcoin_header_object_digest
           FROM p2tr_canonical_generations
          WHERE generation_id = $2
       ), ordered AS (
         SELECT object.*,
                row_number() OVER (
                  ORDER BY object.object_kind, object.object_digest
                ) - 1 AS stream_ordinal
           FROM required
           JOIN p2tr_evidence_objects object USING (object_digest)
       )
       INSERT INTO p2tr_readiness_export_objects
         (export_fence, stream_ordinal, object_digest, object_kind,
          byte_length, content_digest, chunk_count, chunk_manifest_root,
          stream_leaf_digest)
       SELECT $1, stream_ordinal, object_digest, object_kind, byte_length,
              content_digest, chunk_count, chunk_manifest_root,
              p2tr_readiness_export_object_leaf_digest(
                $1, stream_ordinal, object_digest, object_kind, byte_length,
                content_digest, chunk_manifest_root
              )
         FROM ordered
        ORDER BY stream_ordinal`,
      [exportFence, generationID]
    )
    const audit = await client.query<ReadinessExportAuditRow>(
      `SELECT encode(p2tr_readiness_export_manifest_root($1), 'hex')
                AS audit_manifest_root,
              encode(p2tr_readiness_export_stream_digest($1), 'hex')
                AS audit_stream_digest,
              count(*) AS audit_object_count,
              coalesce(sum(byte_length), 0) AS audit_total_bytes
         FROM p2tr_readiness_export_objects
        WHERE export_fence = $1`,
      [exportFence]
    )
    if (audit.rows.length !== 1) {
      throw new Error("Readiness export audit inventory failed")
    }
    const inventory = normalizeReadinessExportAuditRow(audit.rows[0])
    const payload = await client.query<{ digest: string }>(
      `SELECT encode(
                p2tr_readiness_export_source_signature_payload_digest(
                  export_fence, request_digest, pinned_generation,
                  generation_manifest_digest, domain_digest,
                  source_identity_digest, source_signing_key_id,
                  snapshot_root, snapshot_semantic_root,
                  snapshot_generation, result_digest, $2, $3, $4, $5,
                  audit_page_max_bytes, expires_at
                ), 'hex'
              ) AS digest
         FROM p2tr_readiness_exports
        WHERE export_fence = $1
        FOR UPDATE`,
      [
        exportFence,
        hexBuffer(inventory.manifestRoot, "audit manifest root"),
        hexBuffer(inventory.streamDigest, "audit stream digest"),
        inventory.objectCount,
        inventory.totalBytes,
      ]
    )
    if (payload.rows.length !== 1) {
      throw new Error("Readiness export signature payload failed")
    }
    const payloadDigest = normalizeBytes32(
      payload.rows[0].digest,
      "readiness source signature payload digest"
    )
    const independentlyCalculatedPayloadDigest =
      calculateReadinessExportSourceSignaturePayloadDigest({
        exportFence,
        ...signed,
        sourceIdentityDigest: this.sourceIdentity.digest,
        sourceSigningKeyID: this.readinessExportSigner.keyID,
        auditManifestRoot: inventory.manifestRoot,
        finalStreamDigest: inventory.streamDigest,
        objectCount: inventory.objectCount,
        totalBytes: inventory.totalBytes,
        maxChunkBytes: P2TR_EVIDENCE_CHUNK_MAX_BYTES,
      })
    if (payloadDigest !== independentlyCalculatedPayloadDigest) {
      throw new Error(
        "Readiness source signature payload disagrees with PostgreSQL"
      )
    }
    const signature = normalizeOpaqueSignature(
      await this.readinessExportSigner.signPayloadDigest(payloadDigest),
      "readiness export source signature"
    )
    const sealed = await client.query<{ export_fence: string | number }>(
      `UPDATE p2tr_readiness_exports
          SET source_signature = $2,
              source_signature_payload_digest = $3,
              audit_manifest_root = $4,
              audit_stream_digest = $5,
              audit_object_count = $6,
              audit_total_bytes = $7,
              state = 'sealed', sealed_at = clock_timestamp()
        WHERE export_fence = $1 AND state = 'building'
      RETURNING export_fence`,
      [
        exportFence,
        Buffer.from(signature, "hex"),
        hexBuffer(payloadDigest, "source signature payload digest"),
        hexBuffer(inventory.manifestRoot, "audit manifest root"),
        hexBuffer(inventory.streamDigest, "audit stream digest"),
        inventory.objectCount,
        inventory.totalBytes,
      ]
    )
    if (sealed.rows.length !== 1)
      throw new Error("Readiness export seal failed")
    const handle = await this.loadReadinessExportHandle(client, requestNonce)
    if (handle === undefined)
      throw new Error("Sealed readiness export is absent")
    return handle
  }

  private async loadReadinessExportCandidate(
    client: P2TRPostgresClient,
    request: NonNullable<P2TRReadinessExportRequest["candidate"]>
  ): Promise<NonNullable<P2TRReadinessExportHandle["candidate"]>> {
    const result = await client.query<{
      disposition: unknown
      provenance: unknown
      candidate: unknown
    }>(
      `SELECT p2tr_canonical_readiness_row(
                'p2tr_bitcoin_candidate_observations',
                to_jsonb(observation), false
              ) AS disposition,
              p2tr_canonical_readiness_row(
                'p2tr_bitcoin_candidate_ethereum_provenance',
                to_jsonb(provenance), false
              ) AS provenance,
              p2tr_canonical_readiness_row(
                'p2tr_bitcoin_candidates', to_jsonb(candidate), false
              ) AS candidate
         FROM p2tr_bitcoin_candidate_observations observation
         JOIN p2tr_bitcoin_candidate_ethereum_provenance provenance
           ON provenance.block_hash = observation.block_hash
          AND provenance.txid = observation.txid
          AND provenance.wtxid = observation.wtxid
          AND provenance.input_index = observation.input_index
          AND provenance.provenance_generation =
              observation.provenance_generation
         JOIN p2tr_bitcoin_candidates candidate
           ON candidate.block_hash = observation.block_hash
          AND candidate.txid = observation.txid
          AND candidate.wtxid = observation.wtxid
          AND candidate.provenance_generation =
              observation.provenance_generation
          AND candidate.provenance_fingerprint =
              observation.provenance_fingerprint
        WHERE observation.block_hash = $1
          AND observation.txid = $2 AND observation.wtxid = $3
          AND observation.input_index = $4
          AND observation.provenance_fingerprint = $5
          AND candidate.block_height = $6
          AND observation.occurrence_id = $7
          AND observation.disposition = 'keypath_pending'
        FOR SHARE OF observation, provenance, candidate`,
      [
        hexBuffer(request.blockHash, "readiness candidate block hash"),
        hexBuffer(request.txid, "readiness candidate transaction ID"),
        hexBuffer(request.wtxid, "readiness candidate witness transaction ID"),
        request.inputIndex,
        hexBuffer(
          request.expectedProvenanceFingerprint,
          "readiness candidate provenance fingerprint"
        ),
        request.blockHeight,
        hexBuffer(request.observationID, "readiness candidate occurrence ID"),
      ]
    )
    if (result.rows.length !== 1) {
      throw new Error(
        "Readiness export candidate is absent or provenance-stale"
      )
    }
    const row = result.rows[0]
    const observation = candidateObservationFromDispositionEvidence(
      JSON.stringify(row.disposition),
      JSON.stringify(row.provenance),
      JSON.stringify(row.candidate),
      this.authorizationDomain.digest
    )
    if (
      request.observationID !== observation.occurrenceID ||
      request.challengeKey !== observation.challengeIdentity
    ) {
      throw new Error(
        "Readiness export candidate occurrence/challenge identity is inconsistent"
      )
    }
    return {
      ...request,
      provenanceGeneration: observation.provenanceGeneration,
      provenanceFingerprint: observation.provenanceFingerprint,
      observation,
    }
  }

  private async lockReadinessProjectionExclusive(
    client: P2TRPostgresClient
  ): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('p2tr-readiness-snapshot', 0))"
    )
  }

  private async lockReadinessProjectionWriter(
    client: P2TRPostgresClient
  ): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('p2tr-readiness-snapshot', 0))"
    )
  }

  private async commitCanonicalGenerationIfReady(
    client: P2TRPostgresClient
  ): Promise<void> {
    const state = await client.query<{
      bitcoin_height: string | number
      bitcoin_hash: string
      bitcoin_header_object_digest: string
      bitcoin_chain_root: string
      ethereum_block_number: string | number | null
      ethereum_block_hash: string | null
      projection_root: string
      semantic_root: string
    }>(
      `SELECT cursor.current_height AS bitcoin_height,
              encode(cursor.current_hash, 'hex') AS bitcoin_hash,
              encode(block.header_object_digest, 'hex')
                AS bitcoin_header_object_digest,
              encode(cursor.current_chain_commitment, 'hex')
                AS bitcoin_chain_root,
              watermark.ethereum_block_number,
              CASE WHEN watermark.ethereum_block_hash IS NULL THEN NULL
                   ELSE encode(watermark.ethereum_block_hash, 'hex') END
                AS ethereum_block_hash,
              encode(p2tr_muhash_finalize(
                projection.projection_numerator,
                projection.projection_denominator
              ), 'hex') AS projection_root,
              encode(p2tr_muhash_finalize(
                projection.semantic_numerator,
                projection.semantic_denominator
              ), 'hex') AS semantic_root
         FROM p2tr_bitcoin_cursor cursor
         JOIN p2tr_bitcoin_blocks block
           ON block.height = cursor.current_height
          AND block.hash = cursor.current_hash
         JOIN p2tr_readiness_projection_state projection
           ON projection.singleton = true
         LEFT JOIN p2tr_cross_source_watermark watermark
           ON watermark.singleton = true
        WHERE cursor.singleton = true
        FOR SHARE OF cursor, block, projection`
    )
    // Ethereum-derived state may be staged before the authenticated Bitcoin
    // checkpoint. Its trigger journal remains in the open epoch and is fully
    // consumed by generation 1 after the first checkpoint scan commits.
    if (state.rows.length === 0) return
    if (state.rows.length !== 1) {
      throw new Error("Canonical generation source state is inconsistent")
    }
    const row = state.rows[0]
    const created = await client.query<{ generation_id: string | number }>(
      `SELECT p2tr_begin_canonical_generation(
                $1, $2, $3, $4, $5, $6, $7, $8, $9
              ) AS generation_id`,
      [
        hexBuffer(this.authorizationDomain.digest, "generation domain digest"),
        databaseInteger(row.bitcoin_height, "generation Bitcoin height"),
        hexBuffer(row.bitcoin_hash, "generation Bitcoin hash"),
        hexBuffer(
          row.bitcoin_header_object_digest,
          "generation Bitcoin header object digest"
        ),
        row.ethereum_block_number === null
          ? 0
          : databaseInteger(
              row.ethereum_block_number,
              "generation Ethereum block number"
            ),
        row.ethereum_block_hash === null
          ? Buffer.alloc(32)
          : hexBuffer(
              row.ethereum_block_hash,
              "generation Ethereum block hash"
            ),
        hexBuffer(row.bitcoin_chain_root, "generation Bitcoin chain root"),
        hexBuffer(row.projection_root, "generation projection root"),
        hexBuffer(row.semantic_root, "generation semantic root"),
      ]
    )
    if (created.rows.length !== 1) {
      throw new Error("Canonical generation allocation failed")
    }
    const generationID = positiveInteger(
      databaseInteger(
        created.rows[0].generation_id,
        "allocated canonical generation ID"
      ),
      "allocated canonical generation ID"
    )
    const sealed = await client.query<{ manifest_digest: string }>(
      `SELECT encode(p2tr_seal_canonical_generation($1), 'hex')
                AS manifest_digest`,
      [generationID]
    )
    if (
      sealed.rows.length !== 1 ||
      normalizeBytes32(
        sealed.rows[0].manifest_digest,
        "sealed canonical generation manifest digest"
      ).length !== 64
    ) {
      throw new Error("Canonical generation seal failed")
    }
  }

  private async loadCandidateInputProvenance(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity,
    generation: number
  ): Promise<CandidateEthereumProvenance[]> {
    const result = await client.query<CandidateEthereumProvenanceRow>(
      `SELECT input_index,
              encode(funding_block_hash, 'hex') AS funding_block_hash,
              encode(funding_txid, 'hex') AS funding_txid,
              funding_vout,
              encode(wallet_id, 'hex') AS wallet_id,
              encode(output_key, 'hex') AS output_key,
              binding_kind,
              source_event_id,
              ethereum_block_number,
              encode(ethereum_block_hash, 'hex') AS ethereum_block_hash
         FROM p2tr_bitcoin_candidate_ethereum_provenance
        WHERE block_hash = $1 AND txid = $2 AND wtxid = $3
          AND provenance_generation = $4
        ORDER BY input_index, funding_block_hash, funding_txid, funding_vout,
                 binding_kind, source_event_id`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
        generation,
      ]
    )
    return result.rows.map(candidateEthereumProvenanceFromRow)
  }

  private async materializeCandidate(
    client: P2TRPostgresClient,
    row: CandidateRow
  ): Promise<P2TRCanonicalBitcoinScan["candidates"][number]> {
    const identity = normalizeCandidateIdentity({
      blockHash: row.block_hash,
      txid: row.txid,
      wtxid: row.wtxid,
    })
    const generation = positiveInteger(
      databaseInteger(
        row.provenance_generation,
        "candidate provenance generation"
      ),
      "candidate provenance generation"
    )
    const prevouts = await client.query<CandidatePrevoutRow>(
      `SELECT input.input_index,
              encode(input.prev_txid, 'hex') AS prev_txid,
              input.prev_vout,
              output.value_sats AS prev_value_sats,
              encode(output.script_pubkey, 'hex') AS prev_script_pubkey
         FROM p2tr_bitcoin_inputs input
         JOIN p2tr_bitcoin_outputs output
           ON output.block_hash = input.prev_block_hash
          AND output.txid = input.prev_txid
          AND output.vout = input.prev_vout
        WHERE input.block_hash = $1
          AND input.spending_txid = $2
          AND input.spending_wtxid = $3
        ORDER BY input.input_index`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
      ]
    )
    const inputPrevouts = prevouts.rows.map((prevout, expectedIndex) => {
      if (
        databaseInteger(prevout.input_index, "candidate input index") !==
        expectedIndex
      ) {
        throw new Error("Candidate prevout vector is not contiguous")
      }
      return candidatePrevoutFromRow(prevout)
    })
    const bindings = await client.query<CandidateWalletBindingRow>(
      `SELECT DISTINCT encode(funding_txid, 'hex') AS txid,
              funding_vout AS vout,
              encode(output_key, 'hex') AS output_key,
              encode(wallet_id, 'hex') AS wallet_id
         FROM p2tr_bitcoin_candidate_ethereum_provenance
        WHERE block_hash = $1
          AND txid = $2
          AND wtxid = $3
          AND provenance_generation = $4
          AND binding_kind = 'deposit'
        ORDER BY txid, vout, wallet_id, output_key`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
        generation,
      ]
    )
    return candidateFromRow(
      row,
      inputPrevouts,
      bindings.rows.map(candidateWalletBindingFromRow)
    )
  }

  private async computeCandidateTransactionCommitments(
    client: P2TRPostgresClient,
    row: CandidateRow
  ): Promise<{
    transaction: Transaction
    commitments: CandidateTransactionCommitments
  }> {
    const identity = normalizeCandidateIdentity({
      blockHash: row.block_hash,
      txid: row.txid,
      wtxid: row.wtxid,
    })
    const rawTransaction = Buffer.from(
      normalizeHex(row.raw_transaction, "candidate raw transaction"),
      "hex"
    )
    let transaction: Transaction
    try {
      transaction = Transaction.fromBuffer(rawTransaction)
    } catch {
      throw new Error("Candidate raw transaction is malformed")
    }
    if (
      transaction.toBuffer().compare(rawTransaction) !== 0 ||
      transaction.getId() !== identity.txid ||
      serializedBitcoinTransactionHash(rawTransaction) !== identity.wtxid
    ) {
      throw new Error("Candidate raw transaction identity is inconsistent")
    }
    const countResult = await client.query<{
      input_count: string | number
      unresolved_count: string | number
    }>(
      `SELECT count(*) AS input_count,
              count(*) FILTER (WHERE prev_block_hash IS NULL)
                AS unresolved_count
         FROM p2tr_bitcoin_inputs
        WHERE block_hash = $1
          AND spending_txid = $2
          AND spending_wtxid = $3`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
      ]
    )
    if (countResult.rows.length !== 1) {
      throw new Error("Candidate input count is absent")
    }
    const prevoutCount = positiveInteger(
      databaseInteger(countResult.rows[0].input_count, "candidate input count"),
      "candidate input count"
    )
    if (
      prevoutCount !== transaction.ins.length ||
      databaseInteger(
        countResult.rows[0].unresolved_count,
        "candidate unresolved input count"
      ) !== 0
    ) {
      throw new Error("Candidate does not have a complete prevout vector")
    }

    const shaPrevouts = createHash("sha256")
    const shaAmounts = createHash("sha256")
    const shaScriptPubKeys = createHash("sha256")
    const shaSequences = createHash("sha256")
    const prevoutVector = createHash("sha256")
    prevoutVector.update(Buffer.from("tbtc-p2tr-prevout-vector/v1\0", "utf8"))
    prevoutVector.update(uint32BE(prevoutCount, "candidate prevout count"))
    let prevoutBytes = 0
    const updatePrevoutFrame = (bytes: Buffer): void => {
      prevoutVector.update(bytes)
      prevoutBytes += bytes.length
    }

    let lastInputIndex = -1
    while (lastInputIndex + 1 < prevoutCount) {
      const page = await client.query<CandidatePrevoutLengthRow>(
        `SELECT input.input_index,
                encode(input.prev_txid, 'hex') AS prev_txid,
                input.prev_vout,
                output.value_sats AS prev_value_sats,
                encode(input.prev_block_hash, 'hex') AS prev_block_hash,
                octet_length(output.script_pubkey) AS script_bytes
           FROM p2tr_bitcoin_inputs input
           JOIN p2tr_bitcoin_outputs output
             ON output.block_hash = input.prev_block_hash
            AND output.txid = input.prev_txid
            AND output.vout = input.prev_vout
          WHERE input.block_hash = $1
            AND input.spending_txid = $2
            AND input.spending_wtxid = $3
            AND input.input_index > $4
          ORDER BY input.input_index
          LIMIT 1024`,
        [
          hexBuffer(identity.blockHash, "candidate block hash"),
          hexBuffer(identity.txid, "candidate transaction ID"),
          hexBuffer(identity.wtxid, "candidate witness transaction ID"),
          lastInputIndex,
        ]
      )
      if (page.rows.length === 0) {
        throw new Error("Candidate prevout vector ended early")
      }
      for (const prevout of page.rows) {
        const inputIndex = databaseInteger(
          prevout.input_index,
          "candidate prevout input index"
        )
        if (inputIndex !== lastInputIndex + 1) {
          throw new Error("Candidate prevout vector is not contiguous")
        }
        lastInputIndex = inputIndex
        const input = transaction.ins[inputIndex]
        if (input === undefined) {
          throw new Error("Candidate prevout exceeds raw transaction inputs")
        }
        const displayTxid = Buffer.from(input.hash).reverse().toString("hex")
        const storedTxid = normalizeBytes32(
          prevout.prev_txid,
          "candidate prevout transaction ID"
        )
        const vout = uint32(prevout.prev_vout, "candidate prevout index")
        if (displayTxid !== storedTxid || input.index !== vout) {
          throw new Error("Candidate raw input outpoint is inconsistent")
        }
        const valueSats = nonNegativeInteger(
          databaseInteger(prevout.prev_value_sats, "candidate prevout value"),
          "candidate prevout value"
        )
        const scriptBytes = nonNegativeInteger(
          databaseInteger(
            prevout.script_bytes,
            "candidate prevout script byte length"
          ),
          "candidate prevout script byte length"
        )
        const serializedOutpoint = Buffer.concat([
          Buffer.from(input.hash),
          uint32LE(vout, "candidate prevout index"),
        ])
        const serializedAmount = uint64LE(valueSats, "candidate prevout value")
        const scriptLength = compactSize(scriptBytes)
        const serializedSequence = uint32LE(
          input.sequence,
          "candidate input sequence"
        )
        shaPrevouts.update(serializedOutpoint)
        shaAmounts.update(serializedAmount)
        shaScriptPubKeys.update(scriptLength)
        shaSequences.update(serializedSequence)
        updatePrevoutFrame(uint32BE(inputIndex, "candidate input index"))
        updatePrevoutFrame(serializedOutpoint)
        updatePrevoutFrame(serializedAmount)
        updatePrevoutFrame(scriptLength)
        let scriptOffset = 0
        while (scriptOffset < scriptBytes) {
          const length = Math.min(
            CANDIDATE_PREVOUT_SCRIPT_CHUNK_BYTES,
            scriptBytes - scriptOffset
          )
          const chunk = await client.query<{ script_chunk: Buffer }>(
            `SELECT substring(output.script_pubkey FROM $5 FOR $6)
                      AS script_chunk
               FROM p2tr_bitcoin_inputs input
               JOIN p2tr_bitcoin_outputs output
                 ON output.block_hash = input.prev_block_hash
                AND output.txid = input.prev_txid
                AND output.vout = input.prev_vout
              WHERE input.block_hash = $1
                AND input.spending_txid = $2
                AND input.spending_wtxid = $3
                AND input.input_index = $4`,
            [
              hexBuffer(identity.blockHash, "candidate block hash"),
              hexBuffer(identity.txid, "candidate transaction ID"),
              hexBuffer(identity.wtxid, "candidate witness transaction ID"),
              inputIndex,
              scriptOffset + 1,
              length,
            ]
          )
          if (
            chunk.rows.length !== 1 ||
            chunk.rows[0].script_chunk.length !== length
          ) {
            throw new Error("Candidate prevout script chunk is incomplete")
          }
          const bytes = Buffer.from(chunk.rows[0].script_chunk)
          shaScriptPubKeys.update(bytes)
          updatePrevoutFrame(bytes)
          scriptOffset += bytes.length
        }
        updatePrevoutFrame(
          hexBuffer(prevout.prev_block_hash, "candidate funding block hash")
        )
      }
    }

    const shaOutputs = createHash("sha256")
    for (const output of transaction.outs) {
      shaOutputs.update(serializeBitcoinOutput(output.value, output.script))
    }
    return {
      transaction,
      commitments: {
        rawTransactionDigest: createHash("sha256")
          .update(rawTransaction)
          .digest("hex"),
        rawTransactionBytes: rawTransaction.length,
        prevoutVectorRoot: prevoutVector.digest("hex"),
        prevoutCount,
        prevoutBytes,
        shaPrevouts: shaPrevouts.digest("hex"),
        shaAmounts: shaAmounts.digest("hex"),
        shaScriptPubKeys: shaScriptPubKeys.digest("hex"),
        shaSequences: shaSequences.digest("hex"),
        shaOutputs: shaOutputs.digest("hex"),
      },
    }
  }

  private async loadCandidateCurrentPrevout(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity,
    inputIndex: number
  ): Promise<CandidateCurrentPrevout> {
    const result = await client.query<{
      input_index: string | number
      prev_txid: string
      prev_vout: string | number
      prev_value_sats: string | number
      script_pubkey: Buffer
      prev_block_hash: string
      funding_header_object_digest: string
    }>(
      `SELECT input.input_index,
              encode(input.prev_txid, 'hex') AS prev_txid,
              input.prev_vout,
              output.value_sats AS prev_value_sats,
              output.script_pubkey,
              encode(input.prev_block_hash, 'hex') AS prev_block_hash,
              encode(funding_block.header_object_digest, 'hex')
                AS funding_header_object_digest
         FROM p2tr_bitcoin_inputs input
         JOIN p2tr_bitcoin_outputs output
          ON output.block_hash = input.prev_block_hash
          AND output.txid = input.prev_txid
          AND output.vout = input.prev_vout
         JOIN p2tr_bitcoin_blocks funding_block
           ON funding_block.hash = input.prev_block_hash
        WHERE input.block_hash = $1
          AND input.spending_txid = $2
          AND input.spending_wtxid = $3
          AND input.input_index = $4
          AND octet_length(output.script_pubkey) = 34`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
        uint32(inputIndex, "candidate input index"),
      ]
    )
    if (result.rows.length !== 1) {
      throw new Error("Candidate tracked input prevout is absent or not P2TR")
    }
    const row = result.rows[0]
    return {
      inputIndex: databaseInteger(row.input_index, "candidate input index"),
      txid: normalizeBytes32(row.prev_txid, "candidate funding txid"),
      vout: uint32(row.prev_vout, "candidate funding output index"),
      valueSats: nonNegativeInteger(
        databaseInteger(row.prev_value_sats, "candidate funding value"),
        "candidate funding value"
      ),
      scriptPubKey: Buffer.from(row.script_pubkey),
      fundingBlockHash: normalizeBytes32(
        row.prev_block_hash,
        "candidate funding block hash"
      ),
      fundingHeaderObjectDigest: normalizeBytes32(
        row.funding_header_object_digest,
        "candidate funding header object digest"
      ),
    }
  }

  private async persistEvidenceObject(
    client: P2TRPostgresClient,
    kind: string,
    bytes: Buffer
  ): Promise<string> {
    const object = buildImmutableEvidenceObject(kind, bytes)
    await client.query(
      `INSERT INTO p2tr_evidence_chunks (chunk_digest, chunk_bytes)
       SELECT decode(chunk.chunk_digest, 'hex'),
              decode(chunk.chunk_bytes, 'hex')
         FROM jsonb_to_recordset($1::jsonb)
              AS chunk(chunk_digest text, chunk_bytes text)
       ON CONFLICT (chunk_digest) DO NOTHING`,
      [
        JSON.stringify(
          object.chunks.map((chunk) => ({
            chunk_digest: chunk.chunkDigest,
            chunk_bytes: chunk.bytes.toString("hex"),
          }))
        ),
      ]
    )
    await client.query(
      `INSERT INTO p2tr_evidence_objects
         (object_digest, object_kind, byte_length, chunk_count,
          content_digest, chunk_manifest_root)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (object_digest) DO NOTHING`,
      [
        hexBuffer(object.objectDigest, "evidence object digest"),
        object.kind,
        object.byteLength,
        object.chunks.length,
        hexBuffer(object.contentDigest, "evidence content digest"),
        hexBuffer(object.chunkManifestRoot, "evidence chunk manifest root"),
      ]
    )
    await client.query(
      `INSERT INTO p2tr_evidence_object_chunks
         (object_digest, chunk_index, byte_offset, chunk_digest, leaf_digest)
       SELECT $1, chunk.chunk_index, chunk.byte_offset,
              decode(chunk.chunk_digest, 'hex'),
              decode(chunk.leaf_digest, 'hex')
         FROM jsonb_to_recordset($2::jsonb)
              AS chunk(chunk_index integer, byte_offset bigint,
                       chunk_digest text, leaf_digest text)
       ON CONFLICT (object_digest, chunk_index) DO NOTHING`,
      [
        hexBuffer(object.objectDigest, "evidence object digest"),
        JSON.stringify(
          object.chunks.map((chunk) => ({
            chunk_index: chunk.index,
            byte_offset: chunk.byteOffset,
            chunk_digest: chunk.chunkDigest,
            leaf_digest: chunk.leafDigest,
          }))
        ),
      ]
    )
    const complete = await client.query<{ complete: boolean }>(
      `SELECT p2tr_evidence_object_is_complete($1) AS complete`,
      [hexBuffer(object.objectDigest, "evidence object digest")]
    )
    if (complete.rows.length !== 1 || complete.rows[0].complete !== true) {
      throw new Error("Immutable evidence object is incomplete")
    }
    return object.objectDigest
  }

  private async loadBitcoinRawBlockContentCommitment(
    client: P2TRPostgresClient,
    objectDigest: string,
    point: P2TRBitcoinChainPoint
  ): Promise<string> {
    const normalizedObjectDigest = normalizeBytes32(
      objectDigest,
      "Bitcoin raw block object digest"
    )
    const result = await client.query<{
      object_kind: string
      byte_length: string | number
      chunk_count: string | number
      content_digest: string
      chunk_manifest_root: string
      object_bytes: Buffer
      complete: boolean
    }>(
      `SELECT object.object_kind,
              object.byte_length,
              object.chunk_count,
              encode(object.content_digest, 'hex') AS content_digest,
              encode(object.chunk_manifest_root, 'hex')
                AS chunk_manifest_root,
              decode(string_agg(
                encode(chunk.chunk_bytes, 'hex'),
                '' ORDER BY link.chunk_index
              ), 'hex') AS object_bytes,
              p2tr_evidence_object_is_complete(object.object_digest)
                AS complete
         FROM p2tr_evidence_objects object
         JOIN p2tr_evidence_object_chunks link
           ON link.object_digest = object.object_digest
         JOIN p2tr_evidence_chunks chunk
           ON chunk.chunk_digest = link.chunk_digest
        WHERE object.object_digest = $1
        GROUP BY object.object_digest, object.object_kind, object.byte_length,
                 object.chunk_count, object.content_digest,
                 object.chunk_manifest_root`,
      [hexBuffer(normalizedObjectDigest, "Bitcoin raw block object digest")]
    )
    if (result.rows.length !== 1) {
      throw new Error("Bitcoin raw block evidence object is absent")
    }
    const row = result.rows[0]
    const byteLength = nonNegativeInteger(
      databaseInteger(row.byte_length, "Bitcoin raw block byte length"),
      "Bitcoin raw block byte length"
    )
    const chunkCount = positiveInteger(
      databaseInteger(row.chunk_count, "Bitcoin raw block chunk count"),
      "Bitcoin raw block chunk count"
    )
    const contentDigest = normalizeBytes32(
      row.content_digest,
      "Bitcoin raw block content digest"
    )
    const chunkManifestRoot = normalizeBytes32(
      row.chunk_manifest_root,
      "Bitcoin raw block chunk manifest root"
    )
    if (
      row.object_kind !== "bitcoin_raw_block" ||
      row.complete !== true ||
      row.object_bytes.length !== byteLength ||
      calculateP2TREvidenceContentDigest(row.object_bytes) !== contentDigest ||
      calculateP2TREvidenceObjectDigest({
        kind: row.object_kind,
        byteLength,
        chunkCount,
        contentDigest,
        chunkManifestRoot,
      }) !== normalizedObjectDigest
    ) {
      throw new Error("Bitcoin raw block evidence object is inconsistent")
    }
    let parsed: Block
    let rootsAreValid = false
    try {
      parsed = Block.fromBuffer(row.object_bytes)
      rootsAreValid = parsed.checkTxRoots()
    } catch {
      throw new Error("Bitcoin raw block evidence is malformed")
    }
    if (
      !parsed.toBuffer(false).equals(row.object_bytes) ||
      parsed.transactions === undefined ||
      parsed.transactions.length === 0 ||
      parsed.getId() !== normalizeBytes32(point.hash, "Bitcoin block hash") ||
      !rootsAreValid
    ) {
      throw new Error(
        "Bitcoin raw block evidence does not match its chain point"
      )
    }
    return bitcoinRawBlockBytesContentCommitment(row.object_bytes)
  }

  private async loadDispositionEvidenceObject(
    client: P2TRPostgresClient,
    objectDigest: string
  ): Promise<Record<string, unknown>> {
    const result = await client.query<{
      object_kind: string
      byte_length: string | number
      object_bytes: Buffer
    }>(
      `SELECT object.object_kind,
              object.byte_length,
              decode(string_agg(
                encode(chunk.chunk_bytes, 'hex'),
                '' ORDER BY link.chunk_index
              ), 'hex') AS object_bytes
         FROM p2tr_evidence_objects object
         JOIN p2tr_evidence_object_chunks link
           ON link.object_digest = object.object_digest
         JOIN p2tr_evidence_chunks chunk
           ON chunk.chunk_digest = link.chunk_digest
        WHERE object.object_digest = $1
        GROUP BY object.object_digest, object.object_kind, object.byte_length`,
      [hexBuffer(objectDigest, "disposition evidence object digest")]
    )
    if (
      result.rows.length !== 1 ||
      result.rows[0].object_kind !== "complete_input_disposition" ||
      databaseInteger(
        result.rows[0].byte_length,
        "disposition evidence byte length"
      ) > 65_536 ||
      result.rows[0].object_bytes.length !==
        databaseInteger(
          result.rows[0].byte_length,
          "disposition evidence byte length"
        )
    ) {
      throw new Error("Candidate disposition evidence object is invalid")
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.rows[0].object_bytes.toString("utf8"))
    } catch {
      throw new Error("Candidate disposition evidence object is not JSON")
    }
    return requireRecord(parsed, "candidate disposition evidence")
  }

  private async replaceCandidateObservations(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity,
    generation: number,
    fingerprint: string,
    rows: CandidateEthereumProvenance[]
  ): Promise<void> {
    await client.query(
      `DELETE FROM p2tr_bitcoin_candidate_observations
        WHERE block_hash = $1 AND txid = $2 AND wtxid = $3`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
      ]
    )
    if (rows.length === 0) return
    const candidate = await client.query<CandidateRow>(
      `SELECT encode(candidate.txid, 'hex') AS txid,
              encode(candidate.wtxid, 'hex') AS wtxid,
              candidate.block_height,
              encode(candidate.block_hash, 'hex') AS block_hash,
              encode(journal_tx.raw_transaction, 'hex') AS raw_transaction,
              encode(journal_tx.raw_transaction_object_digest, 'hex')
                AS raw_transaction_object_digest,
              candidate.provenance_generation,
              encode(candidate.provenance_fingerprint, 'hex')
                AS provenance_fingerprint
         FROM p2tr_bitcoin_candidates candidate
         JOIN p2tr_bitcoin_transactions journal_tx
           ON journal_tx.block_hash = candidate.block_hash
          AND journal_tx.txid = candidate.txid
          AND journal_tx.wtxid = candidate.wtxid
        WHERE candidate.block_hash = $1
          AND candidate.txid = $2
          AND candidate.wtxid = $3
          AND candidate.provenance_generation = $4
          AND candidate.provenance_fingerprint = $5`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
        generation,
        hexBuffer(fingerprint, "candidate provenance fingerprint"),
      ]
    )
    if (candidate.rows.length !== 1) {
      throw new Error("Candidate observation parent state is inconsistent")
    }
    const { transaction, commitments } =
      await this.computeCandidateTransactionCommitments(
        client,
        candidate.rows[0]
      )
    nonNegativeInteger(
      databaseInteger(
        candidate.rows[0].block_height,
        "candidate observation block height"
      ),
      "candidate observation block height"
    )
    const rawTransactionObjectDigest = normalizeBytes32(
      candidate.rows[0].raw_transaction_object_digest,
      "candidate raw transaction object digest"
    )
    for (const provenance of rows) {
      const input = transaction.ins[provenance.inputIndex]
      if (input === undefined) {
        throw new Error("Candidate provenance input exceeds raw transaction")
      }
      const current = await this.loadCandidateCurrentPrevout(
        client,
        identity,
        provenance.inputIndex
      )
      if (
        current.txid !== provenance.fundingTxid ||
        current.vout !== provenance.fundingVout ||
        current.fundingBlockHash !== provenance.fundingBlockHash ||
        current.scriptPubKey.toString("hex") !== `5120${provenance.outputKey}`
      ) {
        throw new Error("Candidate observation funding provenance is stale")
      }
      const witnessBytes = serializeBitcoinWitness(input.witness)
      const witnessDigest = createHash("sha256")
        .update(witnessBytes)
        .digest("hex")
      const signingKey =
        provenance.bindingKind === "wallet"
          ? provenance.walletID
          : provenance.outputKey
      const bindingTxHash =
        provenance.bindingKind === "wallet"
          ? "00".repeat(32)
          : Buffer.from(provenance.fundingTxid, "hex").reverse().toString("hex")
      const bindingOutputIndex =
        provenance.bindingKind === "wallet" ? 0 : provenance.fundingVout

      let disposition:
        | "keypath_pending"
        | "refund_authenticated"
        | "malformed_blocking"
        | "ambiguous_blocking"
      let challengeIdentity: string | undefined
      let sighashType: number | undefined
      let sighash: string | undefined
      let nonceX: Buffer | undefined
      let signatureScalar: Buffer | undefined
      let annexDigest: string | undefined
      let refundLeafHash: string | undefined
      let refundScriptDigest: string | undefined
      let refundControlBlockDigest: string | undefined
      let blockingReason: string | undefined

      try {
        const witness = classifyP2TRWitness(input.witness)
        if (witness.kind === "empty") {
          disposition = "malformed_blocking"
          blockingReason = "empty-witness"
        } else if (witness.kind === "script-path") {
          if (provenance.bindingKind === "wallet") {
            disposition = "ambiguous_blocking"
            blockingReason = "wallet-script-path"
          } else {
            disposition = "refund_authenticated"
            refundLeafHash = calculateTapLeafHash(
              witness.script,
              witness.controlBlock
            )
            refundScriptDigest = createHash("sha256")
              .update(witness.script)
              .digest("hex")
            refundControlBlockDigest = createHash("sha256")
              .update(witness.controlBlock)
              .digest("hex")
          }
        } else {
          disposition = "keypath_pending"
          sighashType = witness.sighashType
          sighash = calculateP2TRKeyPathSighash({
            transaction,
            inputIndex: provenance.inputIndex,
            hashType: witness.sighashType,
            annex: witness.annex,
            currentPrevout: current,
            commitments,
          })
          nonceX = witness.nonceX
          signatureScalar = witness.signatureScalar
          annexDigest = createHash("sha256")
            .update(witness.annex ?? Buffer.alloc(0))
            .digest("hex")
          challengeIdentity = calculateP2TRCompleteV2ChallengeIdentity({
            ...this.authorizationDomain,
            walletID: provenance.walletID,
            signingKey,
            sighash,
          })
        }
      } catch (error) {
        disposition = "malformed_blocking"
        blockingReason =
          error instanceof P2TRWitnessError
            ? `witness-${error.code}`
            : "invalid-witness-evidence"
        challengeIdentity = undefined
        sighashType = undefined
        sighash = undefined
        nonceX = undefined
        signatureScalar = undefined
        annexDigest = undefined
        refundLeafHash = undefined
        refundScriptDigest = undefined
        refundControlBlockDigest = undefined
      }
      const blockingAlertDigest =
        blockingReason === undefined
          ? undefined
          : candidateBlockingAlertDigest({
              identity,
              inputIndex: provenance.inputIndex,
              generation,
              fingerprint,
              witnessDigest,
              reason: blockingReason,
            })
      const occurrenceID = calculateP2TRCanonicalOccurrenceID({
        domainDigest: this.authorizationDomain.digest,
        provenanceGeneration: generation,
        blockHash: identity.blockHash,
        txid: identity.txid,
        wtxid: identity.wtxid,
        inputIndex: provenance.inputIndex,
        provenanceFingerprint: fingerprint,
        ...(challengeIdentity === undefined ? {} : { challengeIdentity }),
      })
      await client.query(
        `INSERT INTO p2tr_bitcoin_candidate_observations
           (block_hash, txid, wtxid, input_index,
            provenance_generation, provenance_fingerprint, disposition,
            protocol_id, domain_chain_id, bridge_address, domain_digest,
            challenge_identity, occurrence_id, wallet_id, signing_key, output_key,
            binding_kind, local_funding_block_hash, local_funding_txid,
            local_funding_vout, local_funding_header_object_digest,
            binding_tx_hash, binding_output_index,
            sighash_type, sighash, nonce_x, signature_scalar,
            raw_transaction_digest, raw_transaction_bytes,
            witness_digest, annex_digest, raw_transaction_object_digest,
            disposition_evidence_object_digest, prevout_vector_root,
            prevout_count, prevout_bytes, sha_prevouts, sha_amounts,
            sha_script_pubkeys, sha_sequences, sha_outputs,
            candidate_block_header_hash, funding_block_header_hash,
            refund_leaf_hash, refund_script_digest,
            refund_control_block_digest, blocking_reason,
            blocking_alert_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11,
                 $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
                 $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33,
                 $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44,
                 $45, $46, $47, $48)`,
        [
          hexBuffer(identity.blockHash, "candidate block hash"),
          hexBuffer(identity.txid, "candidate transaction ID"),
          hexBuffer(identity.wtxid, "candidate witness transaction ID"),
          provenance.inputIndex,
          generation,
          hexBuffer(fingerprint, "candidate provenance fingerprint"),
          disposition,
          hexBuffer(P2TR_COMPLETE_V2_PROTOCOL_ID, "COMPLETE_V2 protocol ID"),
          this.authorizationDomain.chainID.toString(10),
          this.authorizationDomain.bridgeAddress,
          hexBuffer(this.authorizationDomain.digest, "COMPLETE domain digest"),
          challengeIdentity === undefined
            ? null
            : hexBuffer(challengeIdentity, "candidate challenge identity"),
          hexBuffer(occurrenceID, "candidate occurrence ID"),
          hexBuffer(provenance.walletID, "candidate wallet ID"),
          hexBuffer(signingKey, "candidate signing key"),
          hexBuffer(provenance.outputKey, "candidate output key"),
          provenance.bindingKind,
          hexBuffer(provenance.fundingBlockHash, "funding block hash"),
          hexBuffer(provenance.fundingTxid, "funding transaction ID"),
          provenance.fundingVout,
          hexBuffer(
            current.fundingHeaderObjectDigest,
            "funding header object digest"
          ),
          hexBuffer(bindingTxHash, "candidate binding transaction hash"),
          bindingOutputIndex,
          sighashType ?? null,
          sighash === undefined
            ? null
            : hexBuffer(sighash, "candidate sighash"),
          nonceX ?? null,
          signatureScalar ?? null,
          hexBuffer(
            commitments.rawTransactionDigest,
            "candidate raw transaction digest"
          ),
          commitments.rawTransactionBytes,
          hexBuffer(witnessDigest, "candidate witness digest"),
          annexDigest === undefined
            ? null
            : hexBuffer(annexDigest, "candidate annex digest"),
          hexBuffer(
            rawTransactionObjectDigest,
            "raw transaction object digest"
          ),
          null,
          disposition === "keypath_pending"
            ? hexBuffer(
                commitments.prevoutVectorRoot,
                "candidate prevout vector root"
              )
            : null,
          disposition === "keypath_pending" ? commitments.prevoutCount : null,
          disposition === "keypath_pending" ? commitments.prevoutBytes : null,
          disposition === "keypath_pending"
            ? hexBuffer(commitments.shaPrevouts, "candidate sha_prevouts")
            : null,
          disposition === "keypath_pending"
            ? hexBuffer(commitments.shaAmounts, "candidate sha_amounts")
            : null,
          disposition === "keypath_pending"
            ? hexBuffer(
                commitments.shaScriptPubKeys,
                "candidate sha_scriptpubkeys"
              )
            : null,
          disposition === "keypath_pending"
            ? hexBuffer(commitments.shaSequences, "candidate sha_sequences")
            : null,
          disposition === "keypath_pending"
            ? hexBuffer(commitments.shaOutputs, "candidate sha_outputs")
            : null,
          disposition === "keypath_pending"
            ? hexBuffer(identity.blockHash, "candidate block header hash")
            : null,
          disposition === "keypath_pending"
            ? hexBuffer(
                provenance.fundingBlockHash,
                "candidate funding block header hash"
              )
            : null,
          refundLeafHash === undefined
            ? null
            : hexBuffer(refundLeafHash, "refund leaf hash"),
          refundScriptDigest === undefined
            ? null
            : hexBuffer(refundScriptDigest, "refund script digest"),
          refundControlBlockDigest === undefined
            ? null
            : hexBuffer(
                refundControlBlockDigest,
                "refund control block digest"
              ),
          blockingReason ?? null,
          blockingAlertDigest === undefined
            ? null
            : hexBuffer(blockingAlertDigest, "blocking alert digest"),
        ]
      )
    }
  }

  private async lockCandidateProvenanceForMutation(
    client: P2TRPostgresClient,
    normalized: NormalizedCandidateIdentity
  ): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('p2tr-candidate-provenance', 0))"
    )
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [candidateIdentityKey(normalized)]
    )
  }

  private async assertLegacyCandidateMaterializationAllowed(
    client: P2TRPostgresClient
  ): Promise<void> {
    const checkpoint = await client.query<{
      checkpoint_height: string | number
    }>(
      `SELECT checkpoint_height
         FROM p2tr_bitcoin_cursor
        WHERE singleton = true
        FOR SHARE`
    )
    if (checkpoint.rows.length !== 1) {
      throw new Error(
        "Legacy candidate materialization requires an index cursor"
      )
    }
    if (
      databaseInteger(
        checkpoint.rows[0].checkpoint_height,
        "legacy materialization checkpoint height"
      ) === 0
    ) {
      throw new Error(
        "Legacy candidate materialization is forbidden for a genesis index"
      )
    }
  }

  async listInvalidatedCandidateProvenance(
    afterInvalidationID: number,
    limit: number
  ): Promise<{
    invalidations: P2TRInvalidatedCandidateProvenance[]
    complete: boolean
  }> {
    nonNegativeInteger(afterInvalidationID, "candidate invalidation cursor")
    positiveInteger(limit, "candidate invalidation page size")
    if (limit > this.maxProofPageSize) {
      throw new Error(
        `Candidate invalidation page exceeds the configured ${this.maxProofPageSize}-item bound`
      )
    }
    return this.withClient(async (client) => {
      const result = await client.query<InvalidatedProvenanceRow>(
        `SELECT invalidation_id,
                encode(block_hash, 'hex') AS block_hash,
                encode(txid, 'hex') AS txid,
                encode(wtxid, 'hex') AS wtxid,
                provenance_generation,
                encode(provenance_fingerprint, 'hex') AS provenance_fingerprint,
                reason,
                source_event_ids,
                CASE WHEN successor_fingerprint IS NULL THEN NULL
                     ELSE encode(successor_fingerprint, 'hex') END
                  AS successor_fingerprint
           FROM p2tr_invalidated_candidate_provenance
          WHERE invalidation_id > $1
          ORDER BY invalidation_id
          LIMIT $2`,
        [afterInvalidationID, limit + 1]
      )
      return {
        invalidations: result.rows
          .slice(0, limit)
          .map(invalidatedProvenanceFromRow),
        complete: result.rows.length <= limit,
      }
    })
  }

  async applyBitcoinScan(scan: P2TRCanonicalBitcoinScan): Promise<void> {
    validateBitcoinScan(scan)
    await this.mutate(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('p2tr-candidate-provenance', 0))"
      )
      const cursorResult = await client.query<CursorRow>(
        `SELECT store_id,
                encode(configuration_fingerprint, 'hex') AS configuration_fingerprint,
                network,
                trust_domain_id,
                checkpoint_height,
                encode(checkpoint_hash, 'hex') AS checkpoint_hash,
                current_height,
                encode(current_hash, 'hex') AS current_hash,
                encode(current_chain_commitment, 'hex') AS current_chain_commitment,
                encode(current_evidence_chain_commitment, 'hex') AS current_evidence_chain_commitment,
                journal_block_count,
                journal_transaction_count,
                journal_input_count,
                journal_output_count,
                journal_unresolved_input_count
           FROM p2tr_bitcoin_cursor
          WHERE singleton = true
          FOR UPDATE`
      )
      const stored = cursorResult.rows[0]
      const journalBlocks =
        stored === undefined
          ? [scan.checkpointBlock, ...scan.blocks]
          : scan.blocks
      if (stored !== undefined) this.assertCursorMatchesScan(stored, scan)
      if (scan.candidateObservationAcknowledgement !== undefined) {
        if (stored === undefined) {
          throw new Error(
            "Candidate observation acknowledgement requires an existing index"
          )
        }
        await this.acknowledgeCandidateObservationPage(
          client,
          scan.rollbackTo.height,
          scan.candidateObservationAcknowledgement
        )
      }
      if (stored === undefined) {
        if (scan.expectedCursor !== undefined) {
          throw new Error(
            "PostgreSQL Bitcoin cursor is absent but scan expected an existing cursor"
          )
        }
        if (!samePoint(scan.rollbackTo, scan.checkpoint)) {
          throw new Error("Initial Bitcoin scan must start at its checkpoint")
        }
        const checkpointCommitment = bitcoinChainCommitment(
          undefined,
          scan.checkpoint
        )
        const checkpointHeaderBytes = Buffer.from(
          normalizeFixedHex(
            scan.checkpointBlock.header80Hex,
            80,
            "Bitcoin checkpoint header"
          ),
          "hex"
        )
        const checkpointRawBlockBytes = Buffer.from(
          normalizeHex(
            scan.checkpointBlock.rawBlockHex,
            "raw Bitcoin checkpoint block"
          ),
          "hex"
        )
        const checkpointHeaderObjectDigest = await this.persistEvidenceObject(
          client,
          "bitcoin_header80",
          checkpointHeaderBytes
        )
        const checkpointRawBlockObjectDigest = await this.persistEvidenceObject(
          client,
          "bitcoin_raw_block",
          checkpointRawBlockBytes
        )
        const checkpointContentCommitment = bitcoinRawBlockContentCommitment(
          scan.checkpointBlock
        )
        const checkpointEvidenceCommitment = bitcoinEvidenceChainCommitment(
          undefined,
          scan.checkpoint,
          checkpointContentCommitment
        )
        const checkpointCounts = bitcoinBlockJournalCounts(scan.checkpointBlock)
        await client.query(
          `INSERT INTO p2tr_bitcoin_blocks
              (height, hash, header_bytes, header_object_digest,
              raw_block_object_digest, parent_height, parent_hash,
              parent_chain_commitment, chain_commitment,
              block_content_commitment, parent_evidence_chain_commitment,
              evidence_chain_commitment,
              transaction_count, input_count, output_count,
              unresolved_input_count, is_checkpoint)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL, $7, $8, NULL, $9,
                   $10, $11, $12, 0, true)`,
          [
            scan.checkpoint.height,
            hexBuffer(scan.checkpoint.hash, "checkpoint hash"),
            checkpointHeaderBytes,
            hexBuffer(
              checkpointHeaderObjectDigest,
              "checkpoint header object digest"
            ),
            hexBuffer(
              checkpointRawBlockObjectDigest,
              "checkpoint raw block object digest"
            ),
            hexBuffer(
              scan.checkpointBlock.parentHash,
              "checkpoint parent hash"
            ),
            hexBuffer(checkpointCommitment, "checkpoint chain commitment"),
            hexBuffer(
              checkpointContentCommitment,
              "checkpoint content commitment"
            ),
            hexBuffer(
              checkpointEvidenceCommitment,
              "checkpoint evidence commitment"
            ),
            checkpointCounts.transactions,
            checkpointCounts.inputs,
            checkpointCounts.outputs,
          ]
        )
        await client.query(
          `INSERT INTO p2tr_bitcoin_cursor
             (store_id, configuration_fingerprint, network, trust_domain_id,
              checkpoint_height, checkpoint_hash, current_height, current_hash,
              current_chain_commitment, current_evidence_chain_commitment,
              journal_block_count, journal_transaction_count,
              journal_input_count, journal_output_count,
              journal_unresolved_input_count)
           VALUES ($1, $2, $3, $4, $5, $6, $5, $6, $7, $8,
                   1, $9, $10, $11, 0)`,
          [
            this.p2trSignatureFraudWatchtowerTransactionalStoreID,
            hexBuffer(
              scan.configurationFingerprint,
              "configuration fingerprint"
            ),
            scan.network,
            scan.trustDomainID,
            scan.checkpoint.height,
            hexBuffer(scan.checkpoint.hash, "checkpoint hash"),
            hexBuffer(checkpointCommitment, "checkpoint chain commitment"),
            hexBuffer(
              checkpointEvidenceCommitment,
              "checkpoint evidence commitment"
            ),
            checkpointCounts.transactions,
            checkpointCounts.inputs,
            checkpointCounts.outputs,
          ]
        )
      }

      const rollbackBlock = await client.query<{
        hash: string
        chain_commitment: string
        evidence_chain_commitment: string
      }>(
        `SELECT encode(hash, 'hex') AS hash,
                encode(chain_commitment, 'hex') AS chain_commitment,
                encode(evidence_chain_commitment, 'hex')
                  AS evidence_chain_commitment
           FROM p2tr_bitcoin_blocks
          WHERE height = $1
          FOR UPDATE`,
        [scan.rollbackTo.height]
      )
      if (
        rollbackBlock.rows.length !== 1 ||
        rollbackBlock.rows[0].hash !== scan.rollbackTo.hash
      ) {
        throw new Error(
          "PostgreSQL Bitcoin rollback point is absent or hash-mismatched"
        )
      }
      const rollbackChainCommitment = normalizeBytes32(
        rollbackBlock.rows[0].chain_commitment,
        "rollback chain commitment"
      )
      const rollbackEvidenceCommitment = normalizeBytes32(
        rollbackBlock.rows[0].evidence_chain_commitment,
        "rollback evidence commitment"
      )

      let retainedCounts =
        stored === undefined
          ? {
              blocks: 1,
              ...bitcoinBlockJournalCounts(scan.checkpointBlock),
              unresolvedInputs: 0,
            }
          : journalCountsFromCursor(stored)
      if (
        stored !== undefined &&
        databaseInteger(stored.current_height, "stored cursor height") >
          scan.rollbackTo.height
      ) {
        const removed = await client.query<{
          blocks: string | number
          transactions: string | number
          inputs: string | number
          outputs: string | number
          unresolvedInputs: string | number
        }>(
          `SELECT count(*) AS blocks,
                  COALESCE(sum(transaction_count), 0) AS transactions,
                  COALESCE(sum(input_count), 0) AS inputs,
                  COALESCE(sum(output_count), 0) AS outputs,
                  COALESCE(sum(unresolved_input_count), 0)
                    AS "unresolvedInputs"
             FROM p2tr_bitcoin_blocks
            WHERE height > $1`,
          [scan.rollbackTo.height]
        )
        if (removed.rows.length !== 1) {
          throw new Error("PostgreSQL Bitcoin rollback count failed")
        }
        retainedCounts = subtractJournalCounts(
          retainedCounts,
          journalCountsFromRow(removed.rows[0], "rollback")
        )
      }

      // A Bitcoin reorganization invalidates every cross-source decision made
      // above the retained ancestor (or at the same height under another
      // hash). Remove that watermark in this same serializable transaction so
      // the replacement blocks/candidates below are replayed before another
      // cross-source advancement can commit.
      await client.query(
        `DELETE FROM p2tr_cross_source_watermark
          WHERE bitcoin_height > $1
             OR (bitcoin_height = $1 AND bitcoin_hash <> $2)`,
        [
          scan.rollbackTo.height,
          hexBuffer(scan.rollbackTo.hash, "Bitcoin rollback watermark hash"),
        ]
      )

      await client.query(
        `UPDATE p2tr_tracked_outpoints
            SET spent_by_txid = NULL,
                spent_by_wtxid = NULL,
                spent_input_index = NULL,
                spent_height = NULL,
                spent_hash = NULL
          WHERE spent_height > $1`,
        [scan.rollbackTo.height]
      )
      await client.query(
        `DELETE FROM p2tr_tracked_outpoints
          WHERE kind = 'wallet'
            AND created_height > $1`,
        [scan.rollbackTo.height]
      )
      await client.query(
        `UPDATE p2tr_pending_deposit_reveals
            SET resolved_funding_height = NULL,
                resolved_funding_hash = NULL,
                resolved_at = NULL
          WHERE resolved_funding_height > $1`,
        [scan.rollbackTo.height]
      )
      await client.query(
        `DELETE FROM p2tr_tracked_outpoints
          WHERE kind = 'deposit'
            AND created_height > $1`,
        [scan.rollbackTo.height]
      )
      // Move the FK-pinned cursor inside the retained chain before deleting
      // orphaned blocks. The transaction's final cursor update advances it to
      // nextCursor after replacement blocks and evidence are durable.
      await client.query(
        `UPDATE p2tr_bitcoin_cursor
            SET current_height = $1,
                current_hash = $2,
                current_chain_commitment = $3,
                current_evidence_chain_commitment = $4,
                journal_block_count = $5,
                journal_transaction_count = $6,
                journal_input_count = $7,
                journal_output_count = $8,
                journal_unresolved_input_count = $9,
                updated_at = clock_timestamp()
          WHERE singleton = true`,
        [
          scan.rollbackTo.height,
          hexBuffer(scan.rollbackTo.hash, "rollback cursor hash"),
          hexBuffer(rollbackChainCommitment, "rollback chain commitment"),
          hexBuffer(rollbackEvidenceCommitment, "rollback evidence commitment"),
          retainedCounts.blocks,
          retainedCounts.transactions,
          retainedCounts.inputs,
          retainedCounts.outputs,
          retainedCounts.unresolvedInputs,
        ]
      )
      await client.query(
        `DELETE FROM p2tr_bitcoin_blocks
          WHERE height > $1`,
        [scan.rollbackTo.height]
      )

      const nextJournalCounts = this.assertJournalCapacity(
        retainedCounts,
        scan.blocks
      )
      let nextChainCommitment = rollbackChainCommitment
      let nextEvidenceCommitment = rollbackEvidenceCommitment
      const blockRows: Array<Record<string, unknown>> = []
      for (const block of scan.blocks) {
        const parentChainCommitment = nextChainCommitment
        const parentEvidenceCommitment = nextEvidenceCommitment
        nextChainCommitment = bitcoinChainCommitment(
          parentChainCommitment,
          block
        )
        const blockContentCommitment = bitcoinRawBlockContentCommitment(block)
        nextEvidenceCommitment = bitcoinEvidenceChainCommitment(
          parentEvidenceCommitment,
          block,
          blockContentCommitment
        )
        const headerBytes = Buffer.from(
          normalizeFixedHex(block.header80Hex, 80, "Bitcoin block header"),
          "hex"
        )
        const rawBlockBytes = Buffer.from(
          normalizeHex(block.rawBlockHex, "raw Bitcoin block"),
          "hex"
        )
        const headerObjectDigest = await this.persistEvidenceObject(
          client,
          "bitcoin_header80",
          headerBytes
        )
        const rawBlockObjectDigest = await this.persistEvidenceObject(
          client,
          "bitcoin_raw_block",
          rawBlockBytes
        )
        blockRows.push({
          height: block.height,
          hash: normalizeBytes32(block.hash, "block hash"),
          header_bytes: headerBytes.toString("hex"),
          header_object_digest: headerObjectDigest,
          raw_block_object_digest: rawBlockObjectDigest,
          parent_height: block.height - 1,
          parent_hash: normalizeBytes32(block.parentHash, "block parent hash"),
          parent_chain_commitment: parentChainCommitment,
          chain_commitment: nextChainCommitment,
          block_content_commitment: blockContentCommitment,
          parent_evidence_chain_commitment: parentEvidenceCommitment,
          evidence_chain_commitment: nextEvidenceCommitment,
          transaction_count: block.transactions.length,
          input_count: block.transactions.reduce(
            (count, transaction) =>
              count + (transaction.coinbase ? 0 : transaction.inputs.length),
            0
          ),
          output_count: block.transactions.reduce(
            (count, transaction) => count + transaction.outputs.length,
            0
          ),
        })
      }
      const transactionRows: Array<Record<string, unknown>> = []
      const outputRows: Array<Record<string, unknown>> = []
      for (const block of journalBlocks) {
        for (const [
          transactionIndex,
          transaction,
        ] of block.transactions.entries()) {
          const rawTransaction = Buffer.from(
            normalizeHex(transaction.rawTransactionHex, "raw transaction"),
            "hex"
          )
          const rawTransactionObjectDigest = await this.persistEvidenceObject(
            client,
            "bitcoin_raw_transaction",
            rawTransaction
          )
          transactionRows.push({
            txid: normalizeBytes32(transaction.txid, "transaction ID"),
            wtxid: normalizeBytes32(
              transaction.wtxid,
              "witness transaction ID"
            ),
            block_height: block.height,
            block_hash: normalizeBytes32(block.hash, "transaction block hash"),
            transaction_index: transactionIndex,
            raw_transaction: rawTransaction.toString("hex"),
            raw_transaction_object_digest: rawTransactionObjectDigest,
          })
          for (const output of transaction.outputs) {
            outputRows.push({
              txid: normalizeBytes32(transaction.txid, "output transaction ID"),
              wtxid: normalizeBytes32(
                transaction.wtxid,
                "output witness transaction ID"
              ),
              vout: uint32(output.vout, "output index"),
              value_sats: nonNegativeInteger(output.valueSats, "output value"),
              script_pubkey: normalizeScriptHex(
                output.scriptPubKey,
                "output scriptPubKey"
              ),
              block_height: block.height,
              block_hash: normalizeBytes32(block.hash, "output block hash"),
            })
          }
        }
      }

      if (blockRows.length > 0) {
        await client.query(
          `INSERT INTO p2tr_bitcoin_blocks
             (height, hash, header_bytes, header_object_digest,
              raw_block_object_digest, parent_height, parent_hash,
              parent_chain_commitment, chain_commitment,
              block_content_commitment, parent_evidence_chain_commitment,
              evidence_chain_commitment,
              transaction_count, input_count, output_count,
              unresolved_input_count, is_checkpoint)
           SELECT row.height, decode(row.hash, 'hex'),
                  decode(row.header_bytes, 'hex'),
                  decode(row.header_object_digest, 'hex'),
                  decode(row.raw_block_object_digest, 'hex'), row.parent_height,
                  decode(row.parent_hash, 'hex'),
                  decode(row.parent_chain_commitment, 'hex'),
                  decode(row.chain_commitment, 'hex'),
                  decode(row.block_content_commitment, 'hex'),
                  decode(row.parent_evidence_chain_commitment, 'hex'),
                  decode(row.evidence_chain_commitment, 'hex'),
                  row.transaction_count,
                  row.input_count, row.output_count, 0, false
             FROM jsonb_to_recordset($1::jsonb)
                  AS row(height bigint, hash text, header_bytes text,
                         header_object_digest text,
                         raw_block_object_digest text, parent_height bigint,
                         parent_hash text, parent_chain_commitment text,
                         chain_commitment text, block_content_commitment text,
                         parent_evidence_chain_commitment text,
                         evidence_chain_commitment text,
                         transaction_count bigint,
                         input_count bigint, output_count bigint)
            ORDER BY row.height`,
          [JSON.stringify(blockRows)]
        )
      }
      if (transactionRows.length > 0) {
        await client.query(
          `INSERT INTO p2tr_bitcoin_transactions
             (txid, wtxid, block_height, block_hash, transaction_index,
              raw_transaction, raw_transaction_object_digest)
           SELECT decode(row.txid, 'hex'), decode(row.wtxid, 'hex'),
                  row.block_height, decode(row.block_hash, 'hex'),
                  row.transaction_index, decode(row.raw_transaction, 'hex'),
                  decode(row.raw_transaction_object_digest, 'hex')
             FROM jsonb_to_recordset($1::jsonb)
                  AS row(txid text, wtxid text, block_height bigint,
                         block_hash text, transaction_index integer,
                         raw_transaction text,
                         raw_transaction_object_digest text)
            ORDER BY row.block_height, row.transaction_index`,
          [JSON.stringify(transactionRows)]
        )
      }
      if (outputRows.length > 0) {
        await client.query(
          `INSERT INTO p2tr_bitcoin_outputs
             (txid, wtxid, vout, value_sats, script_pubkey,
              block_height, block_hash)
           SELECT decode(row.txid, 'hex'), decode(row.wtxid, 'hex'),
                  row.vout, row.value_sats, decode(row.script_pubkey, 'hex'),
                  row.block_height, decode(row.block_hash, 'hex')
             FROM jsonb_to_recordset($1::jsonb)
                  AS row(txid text, wtxid text, vout bigint,
                         value_sats bigint, script_pubkey text,
                         block_height bigint, block_hash text)
            ORDER BY row.block_height, row.txid, row.vout`,
          [JSON.stringify(outputRows)]
        )
      }
      let inputBatch: Array<Record<string, unknown>> = []
      let insertedInputCount = 0
      let newlyUnresolved = 0
      const flushInputBatch = async (): Promise<void> => {
        if (inputBatch.length === 0) return
        const stats = await this.insertBitcoinInputBatch(client, inputBatch)
        insertedInputCount += stats.inserted
        newlyUnresolved += stats.unresolved
        inputBatch = []
      }
      for (const block of journalBlocks) {
        for (const transaction of block.transactions) {
          if (transaction.coinbase) continue
          for (const input of transaction.inputs) {
            const row = {
              spending_txid: normalizeBytes32(
                transaction.txid,
                "spending transaction ID"
              ),
              spending_wtxid: normalizeBytes32(
                transaction.wtxid,
                "spending witness transaction ID"
              ),
              input_index: uint32(input.inputIndex, "input index"),
              prev_txid: normalizeBytes32(
                input.txid,
                "previous transaction ID"
              ),
              prev_vout: uint32(input.vout, "previous output index"),
              block_height: block.height,
              block_hash: normalizeBytes32(block.hash, "input block hash"),
            }
            inputBatch.push(row)
            if (inputBatch.length === BITCOIN_INPUT_INSERT_BATCH_SIZE) {
              await flushInputBatch()
            }
          }
        }
      }
      await flushInputBatch()
      if (
        insertedInputCount !==
        (stored === undefined
          ? journalBlocks.reduce(
              (total, block) => total + bitcoinBlockJournalCounts(block).inputs,
              0
            )
          : nextJournalCounts.inputs - retainedCounts.inputs)
      ) {
        throw new Error("Canonical Bitcoin input batch count is inconsistent")
      }
      if (scan.checkpoint.height === 0 && newlyUnresolved !== 0) {
        throw new Error(
          "Genesis-backed Bitcoin scan contains an unresolved prevout occurrence"
        )
      }
      nextJournalCounts.unresolvedInputs += newlyUnresolved
      if (newlyUnresolved > 0) {
        await client.query(
          `UPDATE p2tr_bitcoin_blocks block
                SET unresolved_input_count = unresolved.count
               FROM (
                 SELECT block_height, count(*) AS count
                   FROM p2tr_bitcoin_inputs
                  WHERE block_height = ANY($1::bigint[])
                    AND prev_block_hash IS NULL
                  GROUP BY block_height
               ) unresolved
              WHERE block.height = unresolved.block_height`,
          [journalBlocks.map((block) => block.height)]
        )
      }

      // The source's tracked rows, spend markers, and candidates are only a
      // staged preview. Ethereum projection may have rolled back after that
      // preview was built but before this transaction applies the Bitcoin
      // journal. Derive every durable tracking/candidate mutation again from
      // the current canonical Ethereum projection and exact journal
      // occurrences; never reinsert stale staged evidence.
      await this.reconcileFrostWalletBindings(client)
      await this.reconcilePendingDepositReveals(client)
      await this.reconcileTrackedSpendCandidates(client, scan.rollbackTo.height)
      const testOnlyAcknowledged = scan.testOnlyAcknowledgedCandidates ?? []
      if (testOnlyAcknowledged.length > 0) {
        await client.query(
          `WITH acknowledged AS (
             SELECT decode(item.block_hash, 'hex') AS block_hash,
                    decode(item.txid, 'hex') AS txid,
                    decode(item.wtxid, 'hex') AS wtxid,
                    item.provenance_generation,
                    decode(item.provenance_fingerprint, 'hex')
                      AS provenance_fingerprint
               FROM jsonb_to_recordset($1::jsonb)
                    AS item(block_hash text, txid text, wtxid text,
                            provenance_generation bigint,
                            provenance_fingerprint text)
           )
           UPDATE p2tr_bitcoin_candidate_observations observation
              SET disposition = 'keypath_delivered',
                  disposition_evidence_object_digest = NULL,
                  delivered_at = clock_timestamp()
             FROM acknowledged
            WHERE observation.block_hash = acknowledged.block_hash
              AND observation.txid = acknowledged.txid
              AND observation.wtxid = acknowledged.wtxid
              AND observation.provenance_generation =
                  acknowledged.provenance_generation
              AND observation.provenance_fingerprint =
                  acknowledged.provenance_fingerprint
              AND observation.disposition = 'keypath_pending'`,
          [
            JSON.stringify(
              testOnlyAcknowledged.map((identity) => ({
                block_hash: identity.blockHash,
                txid: identity.txid,
                wtxid: identity.wtxid,
                provenance_generation: identity.provenanceGeneration,
                provenance_fingerprint: identity.provenanceFingerprint,
              }))
            ),
          ]
        )
      }

      const cursorUpdate = await client.query(
        `UPDATE p2tr_bitcoin_cursor
            SET current_height = $1,
                current_hash = $2,
                current_chain_commitment = $3,
                current_evidence_chain_commitment = $4,
                journal_block_count = $5,
                journal_transaction_count = $6,
                journal_input_count = $7,
                journal_output_count = $8,
                journal_unresolved_input_count = $9,
                updated_at = clock_timestamp()
          WHERE singleton = true`,
        [
          scan.nextCursor.height,
          hexBuffer(scan.nextCursor.hash, "next cursor hash"),
          hexBuffer(nextChainCommitment, "next chain commitment"),
          hexBuffer(nextEvidenceCommitment, "next evidence commitment"),
          nextJournalCounts.blocks,
          nextJournalCounts.transactions,
          nextJournalCounts.inputs,
          nextJournalCounts.outputs,
          nextJournalCounts.unresolvedInputs,
        ]
      )
      if (cursorUpdate.rowCount !== 1) {
        throw new Error("PostgreSQL Bitcoin cursor update failed")
      }
      const readinessUpdate = await client.query(
        `UPDATE p2tr_readiness_projection_state
            SET generation = generation + 1,
                bitcoin_evidence_root = $1,
                updated_at = clock_timestamp()
          WHERE singleton = true`,
        [hexBuffer(nextEvidenceCommitment, "Bitcoin evidence root")]
      )
      if (readinessUpdate.rowCount !== 1) {
        throw new Error("PostgreSQL readiness projection update failed")
      }
    })
  }

  async addTaprootDepositBindings(
    bindings: P2TRTaprootDepositBinding[]
  ): Promise<void> {
    if (bindings.length === 0) return
    if (bindings.length > this.maxProofMutationBatchSize) {
      throw new Error(
        "Deposit reveal batch exceeds the configured mutation bound"
      )
    }
    await this.mutate(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('p2tr-candidate-provenance', 0))"
      )
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('p2tr-pending-deposit-capacity', 0))"
      )
      for (const binding of bindings) {
        validateDepositBinding(binding)
        const insert = await client.query(
          `INSERT INTO p2tr_pending_deposit_reveals
             (source_event_id, funding_txid, funding_vout, wallet_id,
              output_key, ethereum_block_number, ethereum_block_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (source_event_id) DO NOTHING`,
          [
            binding.sourceEventID,
            hexBuffer(binding.txid, "deposit funding txid"),
            uint32(binding.vout, "deposit funding output index"),
            hexBuffer(binding.walletID, "deposit wallet ID"),
            hexBuffer(binding.outputKey, "deposit output key"),
            binding.ethereum.blockNumber,
            hexBuffer(
              binding.ethereum.blockHash,
              "deposit Ethereum block hash"
            ),
          ]
        )
        if (insert.rowCount === 0) {
          await this.assertPendingDepositReveal(client, binding)
        }
      }
      await this.reconcilePendingDepositReveals(client)
      const count = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count
           FROM p2tr_pending_deposit_reveals
          WHERE resolved_at IS NULL`
      )
      if (
        count.rows.length !== 1 ||
        databaseInteger(count.rows[0].count, "pending deposit count") >
          this.maxPendingDepositReveals
      ) {
        throw new Error(
          `Pending deposit reveal backlog reached its ${this.maxPendingDepositReveals}-item capacity; lifecycle cursor advancement halted`
        )
      }
    })
  }

  async countPendingDepositReveals(): Promise<number> {
    return this.withClient(async (client) => {
      const result = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count
           FROM p2tr_pending_deposit_reveals
          WHERE resolved_at IS NULL`
      )
      if (result.rows.length !== 1) {
        throw new Error("Pending deposit reveal count failed")
      }
      return databaseInteger(result.rows[0].count, "pending deposit count")
    })
  }

  async assertP2TRSignatureFraudActivationIndexReady(
    genesis: P2TRBitcoinChainPoint
  ): Promise<void> {
    validatePoint(genesis, "P2TR activation Bitcoin genesis")
    if (genesis.height !== 0) {
      throw new Error(
        "P2TR fraud activation requires a Bitcoin checkpoint at genesis height 0"
      )
    }

    await this.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
      if ((await this.lockP2TRReadinessSnapshot()) === undefined) {
        throw new Error(
          "P2TR fraud activation requires a durable readiness snapshot"
        )
      }
      const client = this.requireTransactionClient()
      const cursor = await client.query<CursorRow>(
        `SELECT store_id,
                encode(configuration_fingerprint, 'hex') AS configuration_fingerprint,
                network,
                trust_domain_id,
                checkpoint_height,
                encode(checkpoint_hash, 'hex') AS checkpoint_hash,
                current_height,
                encode(current_hash, 'hex') AS current_hash,
                encode(current_chain_commitment, 'hex') AS current_chain_commitment,
                encode(current_evidence_chain_commitment, 'hex') AS current_evidence_chain_commitment,
                journal_block_count,
                journal_transaction_count,
                journal_input_count,
                journal_output_count,
                journal_unresolved_input_count
           FROM p2tr_bitcoin_cursor
          WHERE singleton = true`
      )
      const durable = cursor.rows[0]
      if (
        cursor.rows.length !== 1 ||
        durable.store_id !==
          this.p2trSignatureFraudWatchtowerTransactionalStoreID ||
        databaseInteger(
          durable.checkpoint_height,
          "activation checkpoint height"
        ) !== 0 ||
        durable.checkpoint_hash !== genesis.hash
      ) {
        throw new Error(
          "P2TR fraud activation requires the durable canonical index to start at the exact configured genesis"
        )
      }

      const expected = journalCountsFromCursor(durable)
      if (
        expected.blocks !==
          databaseInteger(durable.current_height, "activation cursor height") +
            1 ||
        expected.unresolvedInputs !== 0
      ) {
        throw new Error(
          "P2TR fraud activation found inconsistent canonical journal commitments"
        )
      }

      const roots = await client.query<{
        height: string | number
        hash: string
        chain_commitment: string
        block_content_commitment: string
        evidence_chain_commitment: string
        raw_block_object_digest: string
        is_checkpoint: boolean
      }>(
        `SELECT height,
                encode(hash, 'hex') AS hash,
                encode(chain_commitment, 'hex') AS chain_commitment,
                encode(block_content_commitment, 'hex')
                  AS block_content_commitment,
                encode(evidence_chain_commitment, 'hex')
                  AS evidence_chain_commitment,
                encode(raw_block_object_digest, 'hex')
                  AS raw_block_object_digest,
                is_checkpoint
           FROM p2tr_bitcoin_blocks
          WHERE height = ANY($1::bigint[])
          ORDER BY height`,
        [
          [
            genesis.height,
            databaseInteger(durable.current_height, "activation cursor height"),
          ],
        ]
      )
      const checkpointRoot = roots.rows.find(
        (row) => databaseInteger(row.height, "activation root height") === 0
      )
      const headRoot = roots.rows.find(
        (row) =>
          databaseInteger(row.height, "activation root height") ===
          databaseInteger(durable.current_height, "activation cursor height")
      )
      const checkpointContentCommitment =
        checkpointRoot === undefined
          ? undefined
          : await this.loadBitcoinRawBlockContentCommitment(
              client,
              checkpointRoot.raw_block_object_digest,
              genesis
            )
      if (
        checkpointRoot === undefined ||
        headRoot === undefined ||
        checkpointContentCommitment === undefined ||
        !checkpointRoot.is_checkpoint ||
        checkpointRoot.hash !== genesis.hash ||
        checkpointRoot.chain_commitment !==
          bitcoinChainCommitment(undefined, genesis) ||
        checkpointRoot.block_content_commitment !==
          checkpointContentCommitment ||
        checkpointRoot.evidence_chain_commitment !==
          bitcoinEvidenceChainCommitment(
            undefined,
            genesis,
            checkpointContentCommitment
          ) ||
        headRoot.hash !== durable.current_hash ||
        headRoot.chain_commitment !== durable.current_chain_commitment ||
        headRoot.evidence_chain_commitment !==
          durable.current_evidence_chain_commitment
      ) {
        throw new Error(
          "P2TR fraud activation requires a contiguous parent-committed Bitcoin journal"
        )
      }

      const backlogs = await client.query<{
        pending_reveals: string | number
        pending_candidates: string | number
        blocking_candidates: string | number
        invalid_dispositions: string | number
        unmatched_proofs: string | number
      }>(
        `SELECT
           (SELECT count(*)
              FROM p2tr_pending_deposit_reveals
             WHERE resolved_at IS NULL) AS pending_reveals,
           (SELECT count(*)
              FROM p2tr_bitcoin_candidate_observations
             WHERE disposition = 'keypath_pending') AS pending_candidates,
           (SELECT count(*)
              FROM p2tr_bitcoin_candidate_observations
             WHERE disposition IN (
               'malformed_blocking', 'ambiguous_blocking'
             )) AS blocking_candidates,
           (SELECT count(*)
              FROM (
                SELECT provenance.block_hash, provenance.txid,
                       provenance.wtxid, provenance.input_index,
                       provenance.provenance_generation
                  FROM p2tr_bitcoin_candidate_ethereum_provenance provenance
                  LEFT JOIN p2tr_bitcoin_candidate_observations observation
                    ON observation.block_hash = provenance.block_hash
                   AND observation.txid = provenance.txid
                   AND observation.wtxid = provenance.wtxid
                   AND observation.input_index = provenance.input_index
                   AND observation.provenance_generation =
                       provenance.provenance_generation
                 GROUP BY provenance.block_hash, provenance.txid,
                          provenance.wtxid, provenance.input_index,
                          provenance.provenance_generation
                HAVING count(observation.input_index) <> 1
              ) invalid) AS invalid_dispositions,
           (SELECT count(*)
              FROM p2tr_unmatched_proofs
             WHERE resolved_at IS NULL) AS unmatched_proofs`
      )
      const backlog = backlogs.rows[0]
      if (
        backlogs.rows.length !== 1 ||
        databaseInteger(
          backlog.pending_reveals,
          "activation pending deposit reveal count"
        ) !== 0 ||
        databaseInteger(
          backlog.pending_candidates,
          "activation pending candidate count"
        ) !== 0 ||
        databaseInteger(
          backlog.blocking_candidates,
          "activation blocking candidate input count"
        ) !== 0 ||
        databaseInteger(
          backlog.invalid_dispositions,
          "activation invalid candidate disposition count"
        ) !== 0 ||
        databaseInteger(
          backlog.unmatched_proofs,
          "activation unmatched proof count"
        ) !== 0
      ) {
        throw new Error(
          "P2TR fraud activation requires every canonical evidence backlog to be drained"
        )
      }

      const trackedViolations = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count
           FROM p2tr_tracked_outpoints tracked
           LEFT JOIN p2tr_bitcoin_outputs output
             ON output.block_hash = tracked.created_hash
            AND output.txid = tracked.txid
            AND output.vout = tracked.vout
           LEFT JOIN p2tr_frost_wallet_bindings wallet
             ON tracked.kind = 'wallet'
            AND wallet.wallet_id = tracked.wallet_id
           LEFT JOIN p2tr_pending_deposit_reveals reveal
             ON tracked.kind = 'deposit'
            AND reveal.source_event_id = tracked.source_event_id
          WHERE tracked.created_height <= $1
             OR output.txid IS NULL
             OR output.block_height <> tracked.created_height
             OR output.block_hash <> tracked.created_hash
             OR output.value_sats <> tracked.value_sats
             OR output.script_pubkey <> tracked.script_pubkey
             OR tracked.script_pubkey <>
                decode('5120' || encode(tracked.output_key, 'hex'), 'hex')
             OR (tracked.kind = 'wallet' AND
                 (wallet.wallet_id IS NULL OR
                  tracked.output_key <> tracked.wallet_id))
             OR (tracked.kind = 'deposit' AND
                 (reveal.source_event_id IS NULL OR
                  reveal.resolved_at IS NULL))`,
        [genesis.height]
      )
      if (
        trackedViolations.rows.length !== 1 ||
        databaseInteger(
          trackedViolations.rows[0].count,
          "activation tracked output violation count"
        ) !== 0
      ) {
        throw new Error(
          "P2TR fraud activation found a tracked FROST output outside the genesis-backed canonical journal"
        )
      }

      const revealViolations = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count
           FROM p2tr_pending_deposit_reveals reveal
           LEFT JOIN p2tr_bitcoin_outputs output
             ON output.block_hash = reveal.resolved_funding_hash
            AND output.txid = reveal.funding_txid
            AND output.vout = reveal.funding_vout
           LEFT JOIN p2tr_tracked_outpoints tracked
             ON tracked.txid = reveal.funding_txid
            AND tracked.vout = reveal.funding_vout
            AND tracked.created_hash = reveal.resolved_funding_hash
          WHERE reveal.resolved_at IS NOT NULL
            AND (
              reveal.resolved_funding_height <= $1
              OR output.txid IS NULL
              OR tracked.txid IS NULL
              OR tracked.kind <> 'deposit'
              OR output.block_height <> reveal.resolved_funding_height
              OR output.block_hash <> reveal.resolved_funding_hash
              OR tracked.created_height <> reveal.resolved_funding_height
              OR tracked.created_hash <> reveal.resolved_funding_hash
              OR tracked.wallet_id <> reveal.wallet_id
              OR tracked.output_key <> reveal.output_key
              OR output.script_pubkey <>
                 decode('5120' || encode(reveal.output_key, 'hex'), 'hex')
              OR tracked.value_sats <> output.value_sats
              OR tracked.script_pubkey <> output.script_pubkey
            )`,
        [genesis.height]
      )
      if (
        revealViolations.rows.length !== 1 ||
        databaseInteger(
          revealViolations.rows[0].count,
          "activation revealed output violation count"
        ) !== 0
      ) {
        throw new Error(
          "P2TR fraud activation found a revealed FROST output outside the genesis-backed canonical journal"
        )
      }

      const walletViolations = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count
         FROM p2tr_frost_wallet_bindings wallet
          JOIN p2tr_bitcoin_outputs output
             ON sha256(output.script_pubkey) = sha256(
                  decode('5120' || encode(wallet.wallet_id, 'hex'), 'hex')
                )
            AND output.script_pubkey =
                  decode('5120' || encode(wallet.wallet_id, 'hex'), 'hex')
           LEFT JOIN p2tr_tracked_outpoints tracked
             ON tracked.created_hash = output.block_hash
            AND tracked.txid = output.txid
            AND tracked.vout = output.vout
          WHERE tracked.txid IS NULL
             OR tracked.kind <> 'wallet'
             OR tracked.wallet_id <> wallet.wallet_id
             OR tracked.output_key <> wallet.wallet_id
             OR tracked.value_sats <> output.value_sats
             OR tracked.script_pubkey <> output.script_pubkey
             OR tracked.created_height <> output.block_height`
      )
      if (
        walletViolations.rows.length !== 1 ||
        databaseInteger(
          walletViolations.rows[0].count,
          "activation wallet binding violation count"
        ) !== 0
      ) {
        throw new Error(
          "P2TR fraud activation found an unreconciled FROST wallet output"
        )
      }

      const spendViolations = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count
           FROM p2tr_tracked_outpoints tracked
           JOIN p2tr_bitcoin_inputs input
             ON input.prev_block_hash = tracked.created_hash
            AND input.prev_txid = tracked.txid
            AND input.prev_vout = tracked.vout
           JOIN p2tr_bitcoin_transactions journal_tx
             ON journal_tx.block_hash = input.block_hash
            AND journal_tx.txid = input.spending_txid
            AND journal_tx.wtxid = input.spending_wtxid
           LEFT JOIN p2tr_bitcoin_candidates candidate
             ON candidate.block_hash = input.block_hash
            AND candidate.txid = input.spending_txid
            AND candidate.wtxid = input.spending_wtxid
           LEFT JOIN p2tr_frost_wallet_bindings wallet
             ON tracked.kind = 'wallet'
            AND wallet.wallet_id = tracked.wallet_id
           LEFT JOIN p2tr_pending_deposit_reveals reveal
             ON tracked.kind = 'deposit'
            AND reveal.source_event_id = tracked.source_event_id
           LEFT JOIN p2tr_bitcoin_candidate_ethereum_provenance provenance
             ON provenance.block_hash = candidate.block_hash
            AND provenance.txid = candidate.txid
            AND provenance.wtxid = candidate.wtxid
            AND provenance.provenance_generation =
                candidate.provenance_generation
            AND provenance.input_index = input.input_index
            AND provenance.funding_block_hash = tracked.created_hash
            AND provenance.funding_txid = tracked.txid
            AND provenance.funding_vout = tracked.vout
            AND provenance.source_event_id =
                CASE WHEN tracked.kind = 'wallet'
                     THEN wallet.source_event_id
                     ELSE reveal.source_event_id END
          WHERE tracked.spent_hash IS DISTINCT FROM input.block_hash
             OR tracked.spent_height IS DISTINCT FROM input.block_height
             OR tracked.spent_by_txid IS DISTINCT FROM input.spending_txid
             OR tracked.spent_by_wtxid IS DISTINCT FROM input.spending_wtxid
             OR tracked.spent_input_index IS DISTINCT FROM input.input_index
             OR candidate.txid IS NULL
             OR candidate.block_height <> journal_tx.block_height
             OR provenance.source_event_id IS NULL
             `
      )
      if (
        spendViolations.rows.length !== 1 ||
        databaseInteger(
          spendViolations.rows[0].count,
          "activation spend evidence violation count"
        ) !== 0
      ) {
        throw new Error(
          "P2TR fraud activation found an unreconciled tracked spend or candidate"
        )
      }

      const candidateViolations = await client.query<{
        count: string | number
      }>(
        `SELECT count(*) AS count
           FROM p2tr_bitcoin_candidates candidate
          WHERE NOT EXISTS (
            SELECT 1
              FROM p2tr_bitcoin_inputs input
              JOIN p2tr_tracked_outpoints tracked
                ON tracked.created_hash = input.prev_block_hash
               AND tracked.txid = input.prev_txid
               AND tracked.vout = input.prev_vout
             WHERE input.block_hash = candidate.block_hash
               AND input.spending_txid = candidate.txid
               AND input.spending_wtxid = candidate.wtxid
          )`
      )
      if (
        candidateViolations.rows.length !== 1 ||
        databaseInteger(
          candidateViolations.rows[0].count,
          "activation candidate provenance violation count"
        ) !== 0
      ) {
        throw new Error(
          "P2TR fraud activation found candidate evidence without an exact tracked input"
        )
      }
    })
  }

  async addFrostWalletBindings(
    bindings: P2TRFrostWalletBinding[]
  ): Promise<void> {
    if (bindings.length === 0) return
    if (bindings.length > this.maxProofMutationBatchSize) {
      throw new Error("FROST wallet binding batch exceeds the mutation bound")
    }
    await this.mutate(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('p2tr-candidate-provenance', 0))"
      )
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('p2tr-wallet-binding-capacity', 0))"
      )
      for (const binding of bindings) {
        validateFrostWalletBinding(binding)
        const insert = await client.query(
          `INSERT INTO p2tr_frost_wallet_bindings
             (wallet_id, wallet_pub_key_hash, source_event_id, ethereum_block_number,
              ethereum_block_hash)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (wallet_id) DO UPDATE
             SET wallet_pub_key_hash = EXCLUDED.wallet_pub_key_hash
           WHERE p2tr_frost_wallet_bindings.wallet_pub_key_hash IS NULL
             AND p2tr_frost_wallet_bindings.source_event_id = EXCLUDED.source_event_id
             AND p2tr_frost_wallet_bindings.ethereum_block_number = EXCLUDED.ethereum_block_number
             AND p2tr_frost_wallet_bindings.ethereum_block_hash = EXCLUDED.ethereum_block_hash`,
          [
            hexBuffer(binding.walletID, "FROST wallet ID"),
            hexBuffer(binding.walletPubKeyHash, "FROST wallet public-key hash"),
            binding.sourceEventID,
            binding.ethereum.blockNumber,
            hexBuffer(binding.ethereum.blockHash, "wallet Ethereum block hash"),
          ]
        )
        if (insert.rowCount === 0) {
          const existing = await client.query<{
            wallet_pub_key_hash: string
            source_event_id: string
            ethereum_block_number: string | number
            ethereum_block_hash: string
          }>(
            `SELECT encode(wallet_pub_key_hash, 'hex') AS wallet_pub_key_hash,
                    source_event_id,
                    ethereum_block_number,
                    encode(ethereum_block_hash, 'hex') AS ethereum_block_hash
               FROM p2tr_frost_wallet_bindings
              WHERE wallet_id = $1`,
            [hexBuffer(binding.walletID, "FROST wallet ID")]
          )
          const row = existing.rows[0]
          if (
            existing.rows.length !== 1 ||
            row.wallet_pub_key_hash !==
              normalizeBytes20(
                binding.walletPubKeyHash,
                "FROST wallet public-key hash"
              ) ||
            row.source_event_id !== binding.sourceEventID ||
            databaseInteger(
              row.ethereum_block_number,
              "wallet Ethereum block number"
            ) !== binding.ethereum.blockNumber ||
            row.ethereum_block_hash !== binding.ethereum.blockHash
          ) {
            throw new Error(
              `FROST wallet binding ${binding.walletID} conflicts with durable state`
            )
          }
          continue
        }
        await this.backfillFrostWallet(client, binding.walletID)
      }
      const count = await client.query<{ count: string | number }>(
        "SELECT count(*) AS count FROM p2tr_frost_wallet_bindings"
      )
      if (
        count.rows.length !== 1 ||
        databaseInteger(count.rows[0].count, "FROST wallet binding count") >
          this.maxWalletBindings
      ) {
        throw new Error(
          `FROST wallet binding registry reached its ${this.maxWalletBindings}-item capacity; lifecycle cursor advancement halted`
        )
      }
    })
  }

  async loadFrostWalletIDByPubKeyHash(
    walletPubKeyHash: string
  ): Promise<string | undefined> {
    const normalized = normalizeBytes20(
      walletPubKeyHash,
      "FROST wallet public-key hash"
    )
    return this.withClient(async (client) => {
      const result = await client.query<{ wallet_id: string }>(
        `SELECT encode(wallet_id, 'hex') AS wallet_id
           FROM p2tr_frost_wallet_bindings
          WHERE wallet_pub_key_hash = $1`,
        [hexBuffer(normalized, "FROST wallet public-key hash")]
      )
      if (result.rows.length > 1) {
        throw new Error("FROST wallet public-key hash uniqueness is violated")
      }
      return result.rows[0] === undefined
        ? undefined
        : normalizeBytes32(result.rows[0].wallet_id, "FROST wallet ID")
    })
  }

  async rollbackEthereumEvidenceTo(point: {
    blockNumber: number
    blockHash: string
  }): Promise<P2TRCandidateProvenanceIdentity[]> {
    const blockNumber = nonNegativeInteger(
      point.blockNumber,
      "Ethereum rollback block number"
    )
    const blockHash = normalizeBytes32(
      point.blockHash,
      "Ethereum rollback block hash"
    )
    return this.mutate(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('p2tr-candidate-provenance', 0))"
      )
      const affected = await client.query<CandidateProvenanceIdentityRow>(
        `SELECT DISTINCT encode(candidate.block_hash, 'hex') AS block_hash,
                encode(candidate.txid, 'hex') AS txid,
                encode(candidate.wtxid, 'hex') AS wtxid,
                candidate.provenance_generation,
                encode(candidate.provenance_fingerprint, 'hex')
                  AS provenance_fingerprint
           FROM p2tr_bitcoin_candidates candidate
           JOIN p2tr_bitcoin_candidate_ethereum_provenance provenance
             ON provenance.block_hash = candidate.block_hash
            AND provenance.txid = candidate.txid
            AND provenance.wtxid = candidate.wtxid
          WHERE provenance.ethereum_block_number > $1
             OR (provenance.ethereum_block_number = $1 AND
                 provenance.ethereum_block_hash <> $2)
          ORDER BY block_hash, txid, wtxid
          LIMIT $3`,
        [
          blockNumber,
          hexBuffer(blockHash, "Ethereum rollback block hash"),
          this.maxJournalTransactions + 1,
        ]
      )
      if (affected.rows.length > this.maxJournalTransactions) {
        throw new Error(
          "Ethereum rollback candidate invalidation exceeds its journal-derived bound"
        )
      }
      const invalidated = affected.rows.map(candidateProvenanceIdentityFromRow)
      const invalidationIDs = new Map<string, number>()
      for (const candidate of invalidated) {
        const identity = normalizeCandidateIdentity(candidate)
        invalidationIDs.set(
          candidateIdentityKey(identity),
          await this.invalidateCandidateProvenance(
            client,
            identity,
            {
              generation: candidate.provenanceGeneration,
              fingerprint: candidate.provenanceFingerprint,
            },
            "ethereum-reorg"
          )
        )
      }
      const deposits = await client.query<{
        source_event_id: string
        txid: string
        vout: string | number
        wallet_id: string
        output_key: string
      }>(
        `SELECT source_event_id,
                encode(funding_txid, 'hex') AS txid,
                funding_vout AS vout,
                encode(wallet_id, 'hex') AS wallet_id,
                encode(output_key, 'hex') AS output_key
           FROM p2tr_pending_deposit_reveals
          WHERE ethereum_block_number > $1
             OR (ethereum_block_number = $1 AND ethereum_block_hash <> $2)
          ORDER BY ethereum_block_number, source_event_id
          LIMIT $3
          FOR UPDATE`,
        [
          blockNumber,
          hexBuffer(blockHash, "Ethereum rollback block hash"),
          this.maxJournalOutputs + this.maxPendingDepositReveals + 1,
        ]
      )
      if (
        deposits.rows.length >
        this.maxJournalOutputs + this.maxPendingDepositReveals
      ) {
        throw new Error(
          "Ethereum deposit rollback exceeds its journal-derived durable bound"
        )
      }
      const depositEventIDs = deposits.rows.map((row) => row.source_event_id)
      if (depositEventIDs.length > 0) {
        await client.query(
          `DELETE FROM p2tr_tracked_outpoints
            WHERE source_event_id = ANY($1::text[])`,
          [depositEventIDs]
        )
        await client.query(
          `DELETE FROM p2tr_pending_deposit_reveals
            WHERE source_event_id = ANY($1::text[])`,
          [depositEventIDs]
        )
      }

      // Wallet registrations with no Bitcoin outputs do not consume journal
      // capacity, so an unrelated client-side LIMIT can make a large canonical
      // rollback impossible forever. Delete the complete server-side set in
      // this bounded transaction instead of materializing it in memory.
      await client.query(
        `WITH orphaned AS MATERIALIZED (
           SELECT wallet_id
             FROM p2tr_frost_wallet_bindings
            WHERE ethereum_block_number > $1
               OR (ethereum_block_number = $1 AND ethereum_block_hash <> $2)
            FOR UPDATE
         ), deleted_tracked AS (
           DELETE FROM p2tr_tracked_outpoints tracked
            USING orphaned
            WHERE tracked.kind = 'wallet'
              AND tracked.wallet_id = orphaned.wallet_id
           RETURNING tracked.wallet_id
         )
         DELETE FROM p2tr_frost_wallet_bindings wallet
          USING orphaned
          WHERE wallet.wallet_id = orphaned.wallet_id`,
        [blockNumber, hexBuffer(blockHash, "Ethereum rollback block hash")]
      )

      await client.query(
        `DELETE FROM p2tr_unmatched_proofs
          WHERE ethereum_block_number > $1
             OR (ethereum_block_number = $1 AND ethereum_block_hash <> $2)`,
        [blockNumber, hexBuffer(blockHash, "Ethereum rollback block hash")]
      )
      await client.query(
        `DELETE FROM p2tr_cross_source_watermark
          WHERE ethereum_block_number > $1
             OR (ethereum_block_number = $1 AND ethereum_block_hash <> $2)`,
        [blockNumber, hexBuffer(blockHash, "Ethereum rollback block hash")]
      )
      for (const invalidation of invalidated) {
        const identity = normalizeCandidateIdentity(invalidation)
        const rows = await this.deriveCandidateProvenanceRows(client, identity)
        if (rows.length === 0) {
          await client.query(
            `DELETE FROM p2tr_bitcoin_candidates
              WHERE block_hash = $1 AND txid = $2 AND wtxid = $3`,
            [
              hexBuffer(identity.blockHash, "candidate block hash"),
              hexBuffer(identity.txid, "candidate transaction ID"),
              hexBuffer(identity.wtxid, "candidate witness transaction ID"),
            ]
          )
          continue
        }
        const generation = await this.allocateCandidateProvenanceGeneration(
          client
        )
        const fingerprint = await this.candidateProvenanceFingerprint(
          client,
          identity,
          generation,
          rows
        )
        await client.query(
          `DELETE FROM p2tr_bitcoin_candidate_ethereum_provenance
            WHERE block_hash = $1 AND txid = $2 AND wtxid = $3`,
          [
            hexBuffer(identity.blockHash, "candidate block hash"),
            hexBuffer(identity.txid, "candidate transaction ID"),
            hexBuffer(identity.wtxid, "candidate witness transaction ID"),
          ]
        )
        const update = await client.query(
          `UPDATE p2tr_bitcoin_candidates
              SET provenance_generation = $4,
                  provenance_fingerprint = $5
            WHERE block_hash = $1 AND txid = $2 AND wtxid = $3`,
          [
            hexBuffer(identity.blockHash, "candidate block hash"),
            hexBuffer(identity.txid, "candidate transaction ID"),
            hexBuffer(identity.wtxid, "candidate witness transaction ID"),
            generation,
            hexBuffer(fingerprint, "candidate provenance fingerprint"),
          ]
        )
        if (update.rowCount !== 1) {
          throw new Error("Ethereum rollback candidate refresh failed")
        }
        await this.replaceCandidateProvenanceRows(
          client,
          identity,
          generation,
          fingerprint,
          rows
        )
        const invalidationID = invalidationIDs.get(
          candidateIdentityKey(identity)
        )
        if (invalidationID !== undefined) {
          await client.query(
            `UPDATE p2tr_invalidated_candidate_provenance
                SET successor_fingerprint = $2
              WHERE invalidation_id = $1`,
            [invalidationID, hexBuffer(fingerprint, "successor fingerprint")]
          )
        }
      }
      return invalidated
    })
  }

  async enqueueUnmatchedProofs(
    proofs: P2TRUnmatchedProofEnvelope[]
  ): Promise<void> {
    if (proofs.length === 0) return
    if (proofs.length > this.maxProofMutationBatchSize) {
      throw new Error(
        `Unmatched proof mutation exceeds the configured ${this.maxProofMutationBatchSize}-item bound`
      )
    }
    const unique = new Map<string, P2TRUnmatchedProofEnvelope>()
    for (const proof of proofs) {
      validateProofEnvelope(proof, this.maxProofPayloadBytes)
      const existing = unique.get(proof.eventID)
      if (
        existing !== undefined &&
        canonicalJSON(existing) !== canonicalJSON(proof)
      ) {
        throw new Error(
          `Unmatched proof ${proof.eventID} conflicts in its batch`
        )
      }
      unique.set(proof.eventID, proof)
    }

    await this.mutate(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('p2tr-unmatched-proof-capacity', 0))"
      )
      const existing = await client.query<ProofRow>(
        `${PROOF_SELECT}
          WHERE event_id = ANY($1::text[])`,
        [[...unique.keys()]]
      )
      const existingByID = new Map(
        existing.rows.map((row) => [row.event_id, proofFromRow(row)])
      )
      for (const [eventID, proof] of unique) {
        const durable = existingByID.get(eventID)
        if (
          durable !== undefined &&
          canonicalJSON(durable) !== canonicalJSON(proof)
        ) {
          throw new Error(
            `Unmatched proof ${eventID} conflicts with durable state`
          )
        }
      }

      const count = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count
           FROM p2tr_unmatched_proofs
          WHERE resolved_at IS NULL`
      )
      const newCount = [...unique.keys()].filter(
        (eventID) => !existingByID.has(eventID)
      ).length
      if (
        count.rows.length !== 1 ||
        databaseInteger(count.rows[0].count, "unmatched proof count") +
          newCount >
          this.maxUnmatchedProofs
      ) {
        throw new Error(
          `Unmatched proof backlog reached its ${this.maxUnmatchedProofs}-proof capacity; lifecycle cursor advancement halted`
        )
      }

      for (const [eventID, proof] of unique) {
        if (existingByID.has(eventID)) continue
        await client.query(
          `INSERT INTO p2tr_unmatched_proofs
             (event_id, ethereum_block_number, ethereum_block_hash,
              ethereum_transaction_hash, ethereum_log_index, bitcoin_txid,
              wallet_id, spend_type, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            proof.eventID,
            proof.ethereum.blockNumber,
            hexBuffer(proof.ethereum.blockHash, "proof Ethereum block hash"),
            hexBuffer(
              proof.ethereum.transactionHash,
              "proof Ethereum transaction hash"
            ),
            proof.ethereum.logIndex,
            hexBuffer(proof.bitcoinTxid, "proof Bitcoin txid"),
            hexBuffer(proof.walletID, "proof wallet ID"),
            proof.spendType,
            canonicalJSON(proof.payload),
          ]
        )
      }
    })
  }

  async listUnmatchedProofs(
    limit: number
  ): Promise<P2TRUnmatchedProofEnvelope[]> {
    positiveInteger(limit, "unmatched proof page size")
    if (limit > this.maxProofPageSize) {
      throw new Error(
        `Unmatched proof page exceeds the configured ${this.maxProofPageSize}-item bound`
      )
    }
    return this.withClient(async (client) => {
      const result = await client.query<ProofRow>(
        `${PROOF_SELECT}
          WHERE resolved_at IS NULL
          ORDER BY ethereum_block_number, ethereum_log_index
          LIMIT $1`,
        [limit]
      )
      return result.rows.map(proofFromRow)
    })
  }

  async resolveUnmatchedProofs(eventIDs: string[]): Promise<void> {
    if (eventIDs.length === 0) return
    if (eventIDs.length > this.maxProofMutationBatchSize) {
      throw new Error(
        `Unmatched proof resolution exceeds the configured ${this.maxProofMutationBatchSize}-item bound`
      )
    }
    const unique = [
      ...new Set(
        eventIDs.map((eventID) =>
          boundedString(eventID, 512, "unmatched proof event ID")
        )
      ),
    ]
    await this.mutate(async (client) => {
      const result = await client.query<{ event_id: string }>(
        `UPDATE p2tr_unmatched_proofs
            SET resolved_at = COALESCE(resolved_at, clock_timestamp())
          WHERE event_id = ANY($1::text[])
        RETURNING event_id`,
        [unique]
      )
      if (result.rows.length !== unique.length) {
        throw new Error("Unmatched proof resolution referenced an absent event")
      }
    })
  }

  async loadCrossSourceWatermark(): Promise<
    P2TRCrossSourceWatermark | undefined
  > {
    return this.withClient(async (client) => {
      const result = await client.query<WatermarkRow>(WATERMARK_SELECT)
      if (result.rows.length === 0) return undefined
      if (result.rows.length !== 1) {
        throw new Error("Cross-source watermark singleton is inconsistent")
      }
      return watermarkFromRow(result.rows[0])
    })
  }

  async advanceCrossSourceWatermark(
    expected: P2TRCrossSourceWatermark | undefined,
    next: P2TRCrossSourceWatermark
  ): Promise<void> {
    validateWatermark(next, "next cross-source watermark")
    if (expected !== undefined)
      validateWatermark(expected, "expected watermark")
    await this.mutate(async (client) => {
      // Cursor/block precede watermark in the global lock order. This both
      // proves the point is retained/not-future and prevents a concurrent
      // Bitcoin rollback from orphaning it between validation and CAS.
      const canonicalBitcoin = await client.query<{
        hash: string
        current_height: string | number
      }>(
        `SELECT encode(block.hash, 'hex') AS hash,
                cursor.current_height
           FROM p2tr_bitcoin_cursor cursor
           JOIN p2tr_bitcoin_blocks block ON block.height = $1
          WHERE cursor.singleton = true
            AND block.height <= cursor.current_height
          FOR SHARE OF cursor, block`,
        [next.bitcoin.height]
      )
      if (
        canonicalBitcoin.rows.length !== 1 ||
        canonicalBitcoin.rows[0].hash !== next.bitcoin.hash
      ) {
        throw new Error(
          "Cross-source watermark Bitcoin point is not in the canonical journal"
        )
      }
      const result = await client.query<WatermarkRow>(
        `${WATERMARK_SELECT} FOR UPDATE`
      )
      const durable =
        result.rows.length === 0 ? undefined : watermarkFromRow(result.rows[0])
      if (
        result.rows.length > 1 ||
        canonicalJSON(durable) !== canonicalJSON(expected)
      ) {
        throw new Error("Cross-source watermark compare-and-swap failed")
      }
      if (expected !== undefined) {
        assertMonotonicPoint(
          expected.bitcoin,
          next.bitcoin,
          "Bitcoin watermark"
        )
        if (
          next.ethereum.blockNumber < expected.ethereum.blockNumber ||
          (next.ethereum.blockNumber === expected.ethereum.blockNumber &&
            next.ethereum.blockHash !== expected.ethereum.blockHash)
        ) {
          throw new Error(
            "Ethereum watermark cannot move backward or change hash"
          )
        }
      }
      await client.query(
        `INSERT INTO p2tr_cross_source_watermark
           (bitcoin_height, bitcoin_hash, ethereum_block_number,
            ethereum_block_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (singleton) DO UPDATE
           SET bitcoin_height = EXCLUDED.bitcoin_height,
               bitcoin_hash = EXCLUDED.bitcoin_hash,
               ethereum_block_number = EXCLUDED.ethereum_block_number,
               ethereum_block_hash = EXCLUDED.ethereum_block_hash,
               updated_at = clock_timestamp()`,
        [
          next.bitcoin.height,
          hexBuffer(next.bitcoin.hash, "watermark Bitcoin hash"),
          next.ethereum.blockNumber,
          hexBuffer(next.ethereum.blockHash, "watermark Ethereum block hash"),
        ]
      )
    })
  }

  private assertCursorMatchesScan(
    row: CursorRow,
    scan: P2TRCanonicalBitcoinScan
  ): void {
    const expected = scan.expectedCursor
    if (expected === undefined) {
      throw new Error(
        "PostgreSQL Bitcoin cursor exists but scan expected initialization"
      )
    }
    if (
      row.store_id !== this.p2trSignatureFraudWatchtowerTransactionalStoreID ||
      row.configuration_fingerprint !== scan.configurationFingerprint ||
      row.network !== scan.network ||
      row.trust_domain_id !== scan.trustDomainID ||
      databaseInteger(row.checkpoint_height, "checkpoint height") !==
        scan.checkpoint.height ||
      row.checkpoint_hash !== scan.checkpoint.hash ||
      databaseInteger(row.current_height, "cursor height") !==
        expected.height ||
      row.current_hash !== expected.hash
    ) {
      throw new Error(
        "PostgreSQL Bitcoin cursor/configuration compare-and-swap failed"
      )
    }
  }

  private async assertPendingDepositReveal(
    client: P2TRPostgresClient,
    binding: P2TRTaprootDepositBinding
  ): Promise<void> {
    const existing = await client.query<{
      funding_txid: string
      funding_vout: string | number
      wallet_id: string
      output_key: string
      ethereum_block_number: string | number
      ethereum_block_hash: string
    }>(
      `SELECT encode(funding_txid, 'hex') AS funding_txid,
              funding_vout,
              encode(wallet_id, 'hex') AS wallet_id,
              encode(output_key, 'hex') AS output_key,
              ethereum_block_number,
              encode(ethereum_block_hash, 'hex') AS ethereum_block_hash
         FROM p2tr_pending_deposit_reveals
        WHERE source_event_id = $1
        FOR UPDATE`,
      [binding.sourceEventID]
    )
    const row = existing.rows[0]
    if (
      row === undefined ||
      row.funding_txid !== binding.txid ||
      databaseInteger(row.funding_vout, "deposit funding output index") !==
        binding.vout ||
      row.wallet_id !== binding.walletID ||
      row.output_key !== binding.outputKey ||
      databaseInteger(
        row.ethereum_block_number,
        "deposit Ethereum block number"
      ) !== binding.ethereum.blockNumber ||
      row.ethereum_block_hash !== binding.ethereum.blockHash
    ) {
      throw new Error(
        `Deposit reveal ${binding.sourceEventID} conflicts with durable state`
      )
    }
  }

  private async backfillFrostWallet(
    client: P2TRPostgresClient,
    walletID: string
  ): Promise<void> {
    const outputs = await client.query<JournalOutputRow>(
      `${JOURNAL_OUTPUT_SELECT}
        WHERE sha256(output.script_pubkey) = sha256($1)
          AND output.script_pubkey = $1
        ORDER BY output.block_height, output.txid, output.vout
        LIMIT $2`,
      [
        hexBuffer(`5120${walletID}`, "wallet P2TR script"),
        this.maxJournalOutputs + 1,
      ]
    )
    if (outputs.rows.length > this.maxJournalOutputs) {
      throw new Error("FROST wallet backfill exceeds its journal-derived bound")
    }
    for (const row of outputs.rows) {
      const tracked = trackedWalletFromOutputRow(row, walletID)
      const newlyTracked = await this.insertTrackedOutpoint(client, tracked)
      await this.backfillSpendCandidate(client, tracked, newlyTracked)
    }
  }

  private async reconcileFrostWalletBindings(
    client: P2TRPostgresClient
  ): Promise<void> {
    const outputs = await client.query<
      JournalOutputRow & { wallet_id: string }
    >(
      `SELECT ${JOURNAL_OUTPUT_COLUMNS},
              encode(wallet.wallet_id, 'hex') AS wallet_id
         FROM p2tr_frost_wallet_bindings wallet
         JOIN p2tr_bitcoin_outputs output
           ON sha256(output.script_pubkey) = sha256(
                decode('5120' || encode(wallet.wallet_id, 'hex'), 'hex')
              )
          AND output.script_pubkey =
                decode('5120' || encode(wallet.wallet_id, 'hex'), 'hex')
         LEFT JOIN p2tr_tracked_outpoints tracked
           ON tracked.created_hash = output.block_hash
          AND tracked.txid = output.txid
          AND tracked.vout = output.vout
        WHERE tracked.txid IS NULL
        ORDER BY output.block_height, output.txid, output.vout
        LIMIT $1`,
      [this.maxJournalOutputs + 1]
    )
    if (outputs.rows.length > this.maxJournalOutputs) {
      throw new Error(
        "FROST wallet reconciliation exceeds its journal-derived bound"
      )
    }
    for (const row of outputs.rows) {
      const walletID = normalizeBytes32(row.wallet_id, "FROST wallet ID")
      const tracked = trackedWalletFromOutputRow(row, walletID)
      const newlyTracked = await this.insertTrackedOutpoint(client, tracked)
      await this.backfillSpendCandidate(client, tracked, newlyTracked)
    }
  }

  private async reconcilePendingDepositReveals(
    client: P2TRPostgresClient
  ): Promise<void> {
    const matches = await client.query<
      JournalOutputRow & {
        source_event_id: string
        wallet_id: string
        output_key: string
      }
    >(
      `SELECT ${JOURNAL_OUTPUT_COLUMNS},
              reveal.source_event_id,
              encode(reveal.wallet_id, 'hex') AS wallet_id,
              encode(reveal.output_key, 'hex') AS output_key
         FROM p2tr_pending_deposit_reveals reveal
         JOIN p2tr_bitcoin_outputs output
           ON output.txid = reveal.funding_txid
          AND output.vout = reveal.funding_vout
        WHERE reveal.resolved_at IS NULL
          AND output.script_pubkey = decode('5120' || encode(reveal.output_key, 'hex'), 'hex')
        ORDER BY output.block_height, output.vout`
    )
    for (const row of matches.rows) {
      const tracked: P2TRTrackedOutpoint = {
        txid: normalizeBytes32(row.txid, "deposit funding txid"),
        vout: uint32(row.vout, "deposit funding output index"),
        kind: "deposit",
        walletID: normalizeBytes32(row.wallet_id, "deposit wallet ID"),
        outputKey: normalizeBytes32(row.output_key, "deposit output key"),
        valueSats: databaseInteger(row.value_sats, "deposit value"),
        scriptPubKey: normalizeHex(row.script_pubkey, "deposit scriptPubKey"),
        createdAt: {
          height: databaseInteger(row.block_height, "deposit funding height"),
          hash: normalizeBytes32(row.block_hash, "deposit funding hash"),
        },
      }
      const insert = await client.query(
        `INSERT INTO p2tr_tracked_outpoints
           (txid, vout, kind, wallet_id, output_key, value_sats,
            script_pubkey, created_height, created_hash, source_event_id)
         VALUES ($1, $2, 'deposit', $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (txid, vout) DO NOTHING`,
        [
          hexBuffer(tracked.txid, "deposit funding txid"),
          tracked.vout,
          hexBuffer(tracked.walletID, "deposit wallet ID"),
          hexBuffer(tracked.outputKey, "deposit output key"),
          tracked.valueSats,
          hexBuffer(tracked.scriptPubKey, "deposit scriptPubKey"),
          tracked.createdAt.height,
          hexBuffer(tracked.createdAt.hash, "deposit funding hash"),
          row.source_event_id,
        ]
      )
      if (insert.rowCount === 0) {
        const existing = await this.loadTrackedOutpointForUpdate(
          client,
          tracked.txid,
          tracked.vout
        )
        if (existing === undefined || !sameTrackedOutpoint(existing, tracked)) {
          throw new Error(
            "Resolved deposit binding conflicts with tracked state"
          )
        }
      }
      await client.query(
        `UPDATE p2tr_pending_deposit_reveals
            SET resolved_funding_height = $2,
                resolved_funding_hash = $3,
                resolved_at = clock_timestamp()
          WHERE source_event_id = $1
            AND resolved_at IS NULL`,
        [
          row.source_event_id,
          tracked.createdAt.height,
          hexBuffer(tracked.createdAt.hash, "deposit funding hash"),
        ]
      )
      await this.backfillSpendCandidate(client, tracked)
    }
  }

  private async reconcileTrackedSpendCandidates(
    client: P2TRPostgresClient,
    aboveHeight: number
  ): Promise<void> {
    const matches = await client.query<TrackedOutpointRow>(
      `SELECT DISTINCT ${TRACKED_OUTPOINT_COLUMNS}
         FROM p2tr_tracked_outpoints tracked
         JOIN p2tr_bitcoin_inputs input
           ON input.prev_block_hash = tracked.created_hash
          AND input.prev_txid = tracked.txid
          AND input.prev_vout = tracked.vout
        WHERE input.block_height > $1
        ORDER BY created_height, txid, vout
        LIMIT $2`,
      [aboveHeight, this.maxJournalInputs + 1]
    )
    if (matches.rows.length > this.maxJournalInputs) {
      throw new Error(
        "Tracked spend reconciliation exceeds its journal-derived bound"
      )
    }
    for (const row of matches.rows) {
      const tracked = trackedOutpointFromRow(row)
      await this.backfillSpendCandidate(client, tracked)
    }
  }

  private async backfillSpendCandidate(
    client: P2TRPostgresClient,
    tracked: P2TRTrackedOutpoint,
    forceRedelivery = false
  ): Promise<void> {
    const spend = await client.query<SpendRow>(
      `SELECT encode(spending_txid, 'hex') AS spending_txid,
              encode(spending_wtxid, 'hex') AS spending_wtxid,
              input_index,
              block_height,
              encode(block_hash, 'hex') AS block_hash
         FROM p2tr_bitcoin_inputs
        WHERE prev_block_hash = $1
          AND prev_txid = $2
          AND prev_vout = $3`,
      [
        hexBuffer(tracked.createdAt.hash, "tracked funding block hash"),
        hexBuffer(tracked.txid, "tracked funding txid"),
        tracked.vout,
      ]
    )
    if (spend.rows.length === 0) return
    if (spend.rows.length !== 1) {
      throw new Error("Canonical Bitcoin journal contains a double spend")
    }
    const row = spend.rows[0]
    const spendingTxid = normalizeBytes32(row.spending_txid, "spending txid")
    const spendingWtxid = normalizeBytes32(row.spending_wtxid, "spending wtxid")
    const identity = normalizeCandidateIdentity({
      blockHash: row.block_hash,
      txid: spendingTxid,
      wtxid: spendingWtxid,
    })
    await this.lockCandidateProvenanceForMutation(client, identity)
    const currentProvenance = await this.loadCandidateProvenanceState(
      client,
      identity
    )
    const initialProvenance =
      currentProvenance === undefined
        ? await this.prepareNewCandidateProvenance(client, identity)
        : currentProvenance
    await client.query(
      `INSERT INTO p2tr_bitcoin_candidates
         (txid, wtxid, block_height, block_hash, provenance_generation,
          provenance_fingerprint)
       SELECT journal_tx.txid,
              journal_tx.wtxid,
              journal_tx.block_height,
              journal_tx.block_hash,
              $4,
              $5
         FROM p2tr_bitcoin_transactions journal_tx
        WHERE journal_tx.block_hash = $1
          AND journal_tx.txid = $2
          AND journal_tx.wtxid = $3
       ON CONFLICT (block_hash, txid, wtxid) DO NOTHING`,
      [
        hexBuffer(row.block_hash, "spending block hash"),
        hexBuffer(spendingTxid, "spending txid"),
        hexBuffer(spendingWtxid, "spending wtxid"),
        initialProvenance.generation,
        hexBuffer(
          initialProvenance.fingerprint,
          "candidate provenance fingerprint"
        ),
      ]
    )
    if (currentProvenance === undefined) {
      await this.replaceCandidateProvenanceRows(
        client,
        identity,
        initialProvenance.generation,
        initialProvenance.fingerprint,
        (initialProvenance as CandidateProvenance).rows
      )
      await this.linkCandidateProvenanceSuccessors(
        client,
        identity,
        initialProvenance.fingerprint
      )
    } else {
      await this.refreshCandidateProvenance(client, identity, forceRedelivery)
    }
    await client.query(
      `UPDATE p2tr_tracked_outpoints
          SET spent_by_txid = $3,
              spent_by_wtxid = $4,
              spent_input_index = $5,
              spent_height = $6,
              spent_hash = $7
        WHERE txid = $1 AND vout = $2`,
      [
        hexBuffer(tracked.txid, "tracked funding txid"),
        tracked.vout,
        hexBuffer(spendingTxid, "spending txid"),
        hexBuffer(spendingWtxid, "spending wtxid"),
        databaseInteger(row.input_index, "spending input index"),
        databaseInteger(row.block_height, "spending block height"),
        hexBuffer(row.block_hash, "spending block hash"),
      ]
    )
  }

  private async loadTrackedOutpointForUpdate(
    client: P2TRPostgresClient,
    txid: string,
    vout: number
  ): Promise<P2TRTrackedOutpoint | undefined> {
    const result = await client.query<TrackedOutpointRow>(
      `${TRACKED_OUTPOINT_SELECT}
        WHERE txid = $1 AND vout = $2
        FOR UPDATE`,
      [hexBuffer(txid, "tracked txid"), vout]
    )
    return result.rows[0] && trackedOutpointFromRow(result.rows[0])
  }

  private assertJournalCapacity(
    retained: JournalCounts,
    blocks: readonly P2TRCanonicalBitcoinScan["blocks"][number][]
  ): JournalCounts {
    const newTransactions = blocks.reduce(
      (total, block) => total + block.transactions.length,
      0
    )
    const newInputs = blocks.reduce(
      (total, block) =>
        total +
        block.transactions.reduce(
          (blockTotal, transaction) =>
            blockTotal + (transaction.coinbase ? 0 : transaction.inputs.length),
          0
        ),
      0
    )
    const newOutputs = blocks.reduce(
      (total, block) =>
        total +
        block.transactions.reduce(
          (blockTotal, transaction) => blockTotal + transaction.outputs.length,
          0
        ),
      0
    )
    const next = {
      blocks: retained.blocks + blocks.length,
      transactions: retained.transactions + newTransactions,
      inputs: retained.inputs + newInputs,
      outputs: retained.outputs + newOutputs,
      unresolvedInputs: retained.unresolvedInputs,
    }
    if (next.blocks > this.maxJournalBlocks) {
      throw new Error(
        `PostgreSQL Bitcoin block journal reached its ${this.maxJournalBlocks}-row capacity; cursor advancement halted`
      )
    }
    if (next.transactions > this.maxJournalTransactions) {
      throw new Error(
        `PostgreSQL Bitcoin transaction journal reached its ${this.maxJournalTransactions}-row capacity; cursor advancement halted`
      )
    }
    if (next.inputs > this.maxJournalInputs) {
      throw new Error(
        `PostgreSQL Bitcoin input journal reached its ${this.maxJournalInputs}-row capacity; cursor advancement halted`
      )
    }
    if (next.outputs > this.maxJournalOutputs) {
      throw new Error(
        `PostgreSQL Bitcoin output journal reached its ${this.maxJournalOutputs}-row capacity; cursor advancement halted`
      )
    }
    return next
  }

  private async insertBitcoinInputBatch(
    client: P2TRPostgresClient,
    rows: Array<Record<string, unknown>>
  ): Promise<{ inserted: number; unresolved: number }> {
    if (rows.length === 0 || rows.length > BITCOIN_INPUT_INSERT_BATCH_SIZE) {
      throw new Error("Canonical Bitcoin input insertion batch is invalid")
    }
    const result = await client.query<{
      inserted_count: string | number
      unresolved_count: string | number
    }>(
      `WITH staged AS (
         SELECT decode(row.spending_txid, 'hex') AS spending_txid,
                decode(row.spending_wtxid, 'hex') AS spending_wtxid,
                row.input_index, decode(row.prev_txid, 'hex') AS prev_txid,
                row.prev_vout,
                row.block_height, decode(row.block_hash, 'hex') AS block_hash
           FROM jsonb_to_recordset($1::jsonb)
                AS row(spending_txid text, spending_wtxid text,
                       input_index integer, prev_txid text, prev_vout bigint,
                       block_height bigint, block_hash text)
       ), resolved AS (
         SELECT staged.*, previous.block_hash AS prev_block_hash
           FROM staged
           JOIN p2tr_bitcoin_transactions spending
             ON spending.block_hash = staged.block_hash
            AND spending.txid = staged.spending_txid
            AND spending.wtxid = staged.spending_wtxid
           LEFT JOIN LATERAL (
             SELECT output.block_hash
               FROM p2tr_bitcoin_outputs output
               JOIN p2tr_bitcoin_transactions funding
                 ON funding.block_hash = output.block_hash
                AND funding.txid = output.txid
                AND funding.wtxid = output.wtxid
              WHERE output.txid = staged.prev_txid
                AND output.vout = staged.prev_vout
                AND (
                  funding.block_height < spending.block_height OR
                  (funding.block_height = spending.block_height AND
                   funding.transaction_index < spending.transaction_index)
                )
              ORDER BY funding.block_height DESC,
                       funding.transaction_index DESC
              LIMIT 1
           ) previous ON true
       ), inserted AS (
         INSERT INTO p2tr_bitcoin_inputs
            (spending_txid, spending_wtxid, input_index, prev_txid,
             prev_vout, prev_block_hash, block_height, block_hash)
         SELECT spending_txid, spending_wtxid, input_index, prev_txid,
                prev_vout, prev_block_hash, block_height, block_hash
           FROM resolved
          ORDER BY block_height, spending_txid, input_index
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM inserted) AS inserted_count,
              count(*) FILTER (WHERE prev_block_hash IS NULL)
                AS unresolved_count
         FROM resolved`,
      [JSON.stringify(rows)]
    )
    if (result.rows.length !== 1) {
      throw new Error("Canonical Bitcoin input batch result is absent")
    }
    const stats = result.rows[0]
    const inserted = databaseInteger(
      stats.inserted_count,
      "inserted Bitcoin input count"
    )
    if (inserted !== rows.length) {
      throw new Error(
        "Canonical Bitcoin input prevouts conflict with the occurrence journal"
      )
    }
    return {
      inserted,
      unresolved: databaseInteger(
        stats.unresolved_count,
        "unresolved Bitcoin input occurrence count"
      ),
    }
  }

  private async insertTrackedOutpoint(
    client: P2TRPostgresClient,
    tracked: P2TRTrackedOutpoint
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO p2tr_tracked_outpoints
         (txid, vout, kind, wallet_id, output_key, value_sats,
          script_pubkey, created_height, created_hash, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
       ON CONFLICT (txid, vout) DO NOTHING`,
      [
        hexBuffer(tracked.txid, "tracked outpoint txid"),
        uint32(tracked.vout, "tracked outpoint index"),
        tracked.kind,
        hexBuffer(tracked.walletID, "tracked wallet ID"),
        hexBuffer(tracked.outputKey, "tracked output key"),
        nonNegativeInteger(tracked.valueSats, "tracked output value"),
        hexBuffer(tracked.scriptPubKey, "tracked scriptPubKey"),
        nonNegativeInteger(tracked.createdAt.height, "tracked creation height"),
        hexBuffer(tracked.createdAt.hash, "tracked creation hash"),
      ]
    )
    if (result.rowCount === 1) return true

    const existing = await client.query<TrackedOutpointRow>(
      `SELECT encode(txid, 'hex') AS txid,
              vout,
              kind,
              encode(wallet_id, 'hex') AS wallet_id,
              encode(output_key, 'hex') AS output_key,
              value_sats,
              encode(script_pubkey, 'hex') AS script_pubkey,
              created_height,
              encode(created_hash, 'hex') AS created_hash
         FROM p2tr_tracked_outpoints
        WHERE txid = $1 AND vout = $2`,
      [hexBuffer(tracked.txid, "tracked outpoint txid"), tracked.vout]
    )
    if (
      existing.rows.length !== 1 ||
      !sameTrackedOutpoint(trackedOutpointFromRow(existing.rows[0]), tracked)
    ) {
      throw new Error(
        `Tracked outpoint ${tracked.txid}:${tracked.vout} conflicts with durable state`
      )
    }
    return false
  }

  private async prepareNewCandidateProvenance(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity
  ): Promise<CandidateProvenance> {
    const generation = await this.allocateCandidateProvenanceGeneration(client)
    const rows = await this.deriveCandidateProvenanceRows(client, identity)
    if (rows.length === 0) {
      throw new Error(
        "Candidate creation requires non-empty exact canonical provenance"
      )
    }
    return {
      generation,
      rows,
      fingerprint: await this.candidateProvenanceFingerprint(
        client,
        identity,
        generation,
        rows
      ),
    }
  }

  private async linkCandidateProvenanceSuccessors(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity,
    fingerprint: string
  ): Promise<void> {
    await client.query(
      `UPDATE p2tr_invalidated_candidate_provenance
          SET successor_fingerprint = $4
        WHERE block_hash = $1 AND txid = $2 AND wtxid = $3
          AND successor_fingerprint IS NULL`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
        hexBuffer(fingerprint, "successor fingerprint"),
      ]
    )
  }

  private async allocateCandidateProvenanceGeneration(
    client: P2TRPostgresClient
  ): Promise<number> {
    const result = await client.query<{ generation: string | number }>(
      `UPDATE p2tr_candidate_provenance_generation
          SET next_generation = next_generation + 1
        WHERE singleton = true
      RETURNING next_generation - 1 AS generation`
    )
    if (result.rows.length !== 1) {
      throw new Error("Candidate provenance generation allocation failed")
    }
    return positiveInteger(
      databaseInteger(
        result.rows[0].generation,
        "candidate provenance generation"
      ),
      "candidate provenance generation"
    )
  }

  private async allocateCandidateInvalidationID(
    client: P2TRPostgresClient
  ): Promise<number> {
    const result = await client.query<{ invalidation_id: string | number }>(
      `UPDATE p2tr_candidate_provenance_generation
          SET next_invalidation_id = next_invalidation_id + 1
        WHERE singleton = true
      RETURNING next_invalidation_id - 1 AS invalidation_id`
    )
    if (result.rows.length !== 1) {
      throw new Error("Candidate invalidation ID allocation failed")
    }
    return positiveInteger(
      databaseInteger(
        result.rows[0].invalidation_id,
        "candidate invalidation ID"
      ),
      "candidate invalidation ID"
    )
  }

  private async deriveCandidateProvenanceRows(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity
  ): Promise<CandidateEthereumProvenance[]> {
    const result = await client.query<CandidateEthereumProvenanceRow>(
      `SELECT input.input_index,
              encode(tracked.created_hash, 'hex') AS funding_block_hash,
              encode(tracked.txid, 'hex') AS funding_txid,
              tracked.vout AS funding_vout,
              encode(tracked.wallet_id, 'hex') AS wallet_id,
              encode(tracked.output_key, 'hex') AS output_key,
              tracked.kind AS binding_kind,
              CASE WHEN tracked.kind = 'wallet'
                   THEN wallet.source_event_id
                   ELSE reveal.source_event_id END AS source_event_id,
              CASE WHEN tracked.kind = 'wallet'
                   THEN wallet.ethereum_block_number
                   ELSE reveal.ethereum_block_number END AS ethereum_block_number,
              CASE WHEN tracked.kind = 'wallet'
                   THEN encode(wallet.ethereum_block_hash, 'hex')
                   ELSE encode(reveal.ethereum_block_hash, 'hex')
                   END AS ethereum_block_hash
         FROM p2tr_bitcoin_inputs input
         JOIN p2tr_tracked_outpoints tracked
           ON tracked.created_hash = input.prev_block_hash
          AND tracked.txid = input.prev_txid
          AND tracked.vout = input.prev_vout
         LEFT JOIN p2tr_frost_wallet_bindings wallet
           ON tracked.kind = 'wallet'
          AND wallet.wallet_id = tracked.wallet_id
         LEFT JOIN p2tr_pending_deposit_reveals reveal
           ON tracked.kind = 'deposit'
          AND reveal.source_event_id = tracked.source_event_id
        WHERE input.block_hash = $1
          AND input.spending_txid = $2
          AND input.spending_wtxid = $3
          AND tracked.script_pubkey =
              decode('5120' || encode(tracked.output_key, 'hex'), 'hex')
          AND (
            (tracked.kind = 'wallet' AND wallet.source_event_id IS NOT NULL AND
             tracked.output_key = tracked.wallet_id) OR
            (tracked.kind = 'deposit' AND reveal.source_event_id IS NOT NULL AND
             reveal.funding_txid = tracked.txid AND
             reveal.funding_vout = tracked.vout AND
             reveal.wallet_id = tracked.wallet_id AND
             reveal.output_key = tracked.output_key AND
             reveal.resolved_funding_hash = tracked.created_hash)
          )
        ORDER BY input.input_index, binding_kind, source_event_id`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
      ]
    )
    return result.rows.map(candidateEthereumProvenanceFromRow)
  }

  private async candidateProvenanceFingerprint(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity,
    generation: number,
    rows: CandidateEthereumProvenance[]
  ): Promise<string> {
    const root = await client.query<{
      configuration_fingerprint: string
      evidence_chain_commitment: string
    }>(
      `SELECT encode(cursor.configuration_fingerprint, 'hex')
                AS configuration_fingerprint,
              encode(block.evidence_chain_commitment, 'hex')
                AS evidence_chain_commitment
         FROM p2tr_bitcoin_cursor cursor
         JOIN p2tr_bitcoin_blocks block
           ON block.hash = $1
        WHERE cursor.singleton = true`,
      [hexBuffer(identity.blockHash, "candidate block hash")]
    )
    if (root.rows.length !== 1) {
      throw new Error("Candidate provenance index root is absent")
    }
    return createHash("sha256")
      .update(
        canonicalJSON({
          version: 2,
          identity,
          generation,
          configurationFingerprint: normalizeBytes32(
            root.rows[0].configuration_fingerprint,
            "candidate configuration fingerprint"
          ),
          candidateEvidenceCommitment: normalizeBytes32(
            root.rows[0].evidence_chain_commitment,
            "candidate evidence commitment"
          ),
          ethereumBindings: rows,
        })
      )
      .digest("hex")
  }

  private async replaceCandidateProvenanceRows(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity,
    generation: number,
    fingerprint: string,
    rows: CandidateEthereumProvenance[]
  ): Promise<void> {
    await client.query(
      `DELETE FROM p2tr_bitcoin_candidate_ethereum_provenance
        WHERE block_hash = $1 AND txid = $2 AND wtxid = $3`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
      ]
    )
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO p2tr_bitcoin_candidate_ethereum_provenance
         (block_hash, txid, wtxid, input_index, funding_block_hash,
          funding_txid, funding_vout, wallet_id, output_key, binding_kind, source_event_id,
          ethereum_block_number, ethereum_block_hash, provenance_generation)
       SELECT $1, $2, $3, row.input_index,
              decode(row.funding_block_hash, 'hex'),
              decode(row.funding_txid, 'hex'), row.funding_vout,
              decode(row.wallet_id, 'hex'), decode(row.output_key, 'hex'),
              row.binding_kind, row.source_event_id,
              row.ethereum_block_number,
              decode(row.ethereum_block_hash, 'hex'), $4
         FROM jsonb_to_recordset($5::jsonb)
              AS row(input_index integer, funding_block_hash text,
                     funding_txid text, funding_vout bigint, binding_kind text,
                     wallet_id text, output_key text,
                     source_event_id text, ethereum_block_number bigint,
                     ethereum_block_hash text)
        ORDER BY row.input_index, row.binding_kind, row.source_event_id`,
        [
          hexBuffer(identity.blockHash, "candidate block hash"),
          hexBuffer(identity.txid, "candidate transaction ID"),
          hexBuffer(identity.wtxid, "candidate witness transaction ID"),
          generation,
          JSON.stringify(
            rows.map((row) => ({
              input_index: row.inputIndex,
              funding_block_hash: row.fundingBlockHash,
              funding_txid: row.fundingTxid,
              funding_vout: row.fundingVout,
              wallet_id: row.walletID,
              output_key: row.outputKey,
              binding_kind: row.bindingKind,
              source_event_id: row.sourceEventID,
              ethereum_block_number: row.ethereumBlockNumber,
              ethereum_block_hash: row.ethereumBlockHash,
            }))
          ),
        ]
      )
    }
    await this.replaceCandidateObservations(
      client,
      identity,
      generation,
      normalizeBytes32(fingerprint, "candidate provenance fingerprint"),
      rows
    )
  }

  private async loadCandidateProvenanceState(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity
  ): Promise<CandidateProvenanceState | undefined> {
    const result = await client.query<{
      provenance_generation: string | number
      provenance_fingerprint: string
    }>(
      `SELECT provenance_generation,
              encode(provenance_fingerprint, 'hex') AS provenance_fingerprint
         FROM p2tr_bitcoin_candidates
        WHERE block_hash = $1 AND txid = $2 AND wtxid = $3
        FOR UPDATE`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
      ]
    )
    const row = result.rows[0]
    if (row === undefined) return undefined
    if (result.rows.length !== 1) {
      throw new Error("Candidate provenance state is inconsistent")
    }
    return {
      generation: positiveInteger(
        databaseInteger(
          row.provenance_generation,
          "candidate provenance generation"
        ),
        "candidate provenance generation"
      ),
      fingerprint: normalizeBytes32(
        row.provenance_fingerprint,
        "candidate provenance fingerprint"
      ),
    }
  }

  private async refreshCandidateProvenance(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity,
    forceObservationRefresh = false
  ): Promise<CandidateProvenanceState> {
    const current = await this.loadCandidateProvenanceState(client, identity)
    if (current === undefined) {
      throw new Error("Candidate disappeared during provenance refresh")
    }
    const rows = await this.deriveCandidateProvenanceRows(client, identity)
    const currentFingerprint = await this.candidateProvenanceFingerprint(
      client,
      identity,
      current.generation,
      rows
    )
    if (currentFingerprint === current.fingerprint) {
      if (forceObservationRefresh) {
        await this.replaceCandidateProvenanceRows(
          client,
          identity,
          current.generation,
          current.fingerprint,
          rows
        )
      }
      return current
    }

    const invalidationID = await this.invalidateCandidateProvenance(
      client,
      identity,
      current,
      "provenance-superseded"
    )
    const generation = await this.allocateCandidateProvenanceGeneration(client)
    const fingerprint = await this.candidateProvenanceFingerprint(
      client,
      identity,
      generation,
      rows
    )
    await client.query(
      `DELETE FROM p2tr_bitcoin_candidate_ethereum_provenance
        WHERE block_hash = $1 AND txid = $2 AND wtxid = $3`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
      ]
    )
    const update = await client.query(
      `UPDATE p2tr_bitcoin_candidates
          SET provenance_generation = $4,
              provenance_fingerprint = $5
        WHERE block_hash = $1 AND txid = $2 AND wtxid = $3`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
        generation,
        hexBuffer(fingerprint, "candidate provenance fingerprint"),
      ]
    )
    if (update.rowCount !== 1) {
      throw new Error("Candidate provenance refresh update failed")
    }
    await this.replaceCandidateProvenanceRows(
      client,
      identity,
      generation,
      fingerprint,
      rows
    )
    await client.query(
      `UPDATE p2tr_invalidated_candidate_provenance
          SET successor_fingerprint = $2
        WHERE invalidation_id = $1`,
      [invalidationID, hexBuffer(fingerprint, "successor fingerprint")]
    )
    return { generation, fingerprint }
  }

  private async invalidateCandidateProvenance(
    client: P2TRPostgresClient,
    identity: NormalizedCandidateIdentity,
    current: CandidateProvenanceState,
    reason: "ethereum-reorg" | "provenance-superseded"
  ): Promise<number> {
    const sourceEvents = await client.query<{ source_event_id: string }>(
      `SELECT DISTINCT source_event_id
         FROM p2tr_bitcoin_candidate_ethereum_provenance
        WHERE block_hash = $1 AND txid = $2 AND wtxid = $3
        ORDER BY source_event_id`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
      ]
    )
    const sourceEventIDs = [
      ...new Set(sourceEvents.rows.map((row) => row.source_event_id)),
    ]
      .map((eventID) =>
        boundedString(eventID, 512, "candidate source event ID")
      )
      .sort()
    const existing = await client.query<{ invalidation_id: string | number }>(
      `SELECT invalidation_id
         FROM p2tr_invalidated_candidate_provenance
        WHERE block_hash = $1 AND txid = $2 AND wtxid = $3
          AND provenance_generation = $4
          AND provenance_fingerprint = $5`,
      [
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
        current.generation,
        hexBuffer(current.fingerprint, "candidate provenance fingerprint"),
      ]
    )
    if (existing.rows.length > 1) {
      throw new Error("Candidate provenance invalidation identity is ambiguous")
    }
    if (existing.rows.length === 1) {
      const invalidationID = positiveInteger(
        databaseInteger(
          existing.rows[0].invalidation_id,
          "candidate invalidation ID"
        ),
        "candidate invalidation ID"
      )
      await client.query(
        `UPDATE p2tr_invalidated_candidate_provenance
            SET source_event_ids = $2::jsonb
          WHERE invalidation_id = $1`,
        [invalidationID, JSON.stringify(sourceEventIDs)]
      )
      return invalidationID
    }
    const invalidationID = await this.allocateCandidateInvalidationID(client)
    const result = await client.query<{ invalidation_id: string | number }>(
      `INSERT INTO p2tr_invalidated_candidate_provenance
         (invalidation_id, block_hash, txid, wtxid, provenance_generation,
          provenance_fingerprint, reason, source_event_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING invalidation_id`,
      [
        invalidationID,
        hexBuffer(identity.blockHash, "candidate block hash"),
        hexBuffer(identity.txid, "candidate transaction ID"),
        hexBuffer(identity.wtxid, "candidate witness transaction ID"),
        current.generation,
        hexBuffer(current.fingerprint, "candidate provenance fingerprint"),
        reason,
        JSON.stringify(sourceEventIDs),
      ]
    )
    if (result.rows.length !== 1) {
      throw new Error("Candidate provenance invalidation failed")
    }
    const insertedID = positiveInteger(
      databaseInteger(
        result.rows[0].invalidation_id,
        "candidate invalidation ID"
      ),
      "candidate invalidation ID"
    )
    if (insertedID !== invalidationID) {
      throw new Error("Candidate invalidation allocator returned a stale ID")
    }
    return insertedID
  }

  private async assertDatabaseReady(client: P2TRPostgresClient): Promise<void> {
    const version = await client.query<{ server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num"
    )
    if (
      version.rows.length !== 1 ||
      Number(version.rows[0].server_version_num) < 160000
    ) {
      throw new Error("P2TR canonical evidence store requires PostgreSQL 16+")
    }
    const schema = await client.query<{ version: number }>(
      `SELECT version
         FROM p2tr_watchtower_schema_version
        WHERE component = 'canonical-evidence-index'`
    )
    if (
      schema.rows.length !== 1 ||
      Number(schema.rows[0].version) !== REQUIRED_SCHEMA_VERSION
    ) {
      throw new Error(
        `P2TR canonical evidence schema migration ${REQUIRED_SCHEMA_VERSION} is required`
      )
    }
    const domain = await client.query<{ domain_digest: string }>(
      `SELECT encode(
                p2tr_assert_complete_authorization_domain(
                  $1, $2::numeric, $3
                ),
                'hex'
              ) AS domain_digest`,
      [
        hexBuffer(P2TR_COMPLETE_V2_PROTOCOL_ID, "COMPLETE protocol ID"),
        this.authorizationDomain.chainID.toString(10),
        this.authorizationDomain.bridgeAddress,
      ]
    )
    if (
      domain.rows.length !== 1 ||
      normalizeBytes32(
        domain.rows[0].domain_digest,
        "persisted COMPLETE authorization domain digest"
      ) !== this.authorizationDomain.digest
    ) {
      throw new Error("PostgreSQL COMPLETE authorization domain mismatch")
    }
    const sourceIdentity = await client.query<{
      source_identity_digest: string
    }>(
      `SELECT encode(
                p2tr_assert_watchtower_source_identity(
                  $1, $2, $3, $4, $5
                ),
                'hex'
              ) AS source_identity_digest`,
      [
        this.p2trSignatureFraudWatchtowerTransactionalStoreID,
        this.sourceIdentity.clusterID,
        this.sourceIdentity.operatorID,
        hexBuffer(
          this.sourceIdentity.bitcoinIdentityDigest,
          "source Bitcoin identity digest"
        ),
        hexBuffer(
          this.sourceIdentity.ethereumIdentityDigest,
          "source Ethereum identity digest"
        ),
      ]
    )
    if (
      sourceIdentity.rows.length !== 1 ||
      normalizeBytes32(
        sourceIdentity.rows[0].source_identity_digest,
        "persisted source identity digest"
      ) !== this.sourceIdentity.digest
    ) {
      throw new Error("PostgreSQL watchtower source identity mismatch")
    }
  }

  private async withClient<T>(
    operation: (client: P2TRPostgresClient) => Promise<T>
  ): Promise<T> {
    const active = this.transaction.getStore()
    if (active !== undefined) return operation(active.client)

    const client = await this.pool.connect()
    try {
      await this.assertDatabaseReady(client)
      return await operation(client)
    } finally {
      client.release()
    }
  }

  private async mutate<T>(
    operation: (client: P2TRPostgresClient) => Promise<T>
  ): Promise<T> {
    const active = this.transaction.getStore()
    if (active !== undefined) {
      if (!active.readinessSnapshotLocked) {
        await this.lockReadinessProjectionWriter(active.client)
      }
      active.mutationStarted = true
      return operation(active.client)
    }
    return this.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
      const context = this.transaction.getStore() as TransactionContext
      await this.lockReadinessProjectionWriter(context.client)
      context.mutationStarted = true
      return operation(context.client)
    })
  }

  private requireTransactionClient(): P2TRPostgresClient {
    const context = this.transaction.getStore()
    if (context === undefined) {
      throw new Error("PostgreSQL mutation requires an active transaction")
    }
    return context.client
  }

  private ownConfirmedAbort(
    error: P2TRPostgresTransactionConfirmedAbortError
  ): P2TRPostgresTransactionConfirmedAbortError {
    this.ownConfirmedAborts.add(error)
    return error
  }

  private ownUnknownOutcome(
    error: P2TRPostgresTransactionUnknownOutcomeError
  ): P2TRPostgresTransactionUnknownOutcomeError {
    this.ownUnknownOutcomes.add(error)
    return error
  }
}

type TrackedOutpointRow = {
  txid: string
  vout: string | number
  kind: string
  wallet_id: string
  output_key: string
  value_sats: string | number
  script_pubkey: string
  created_height: string | number
  created_hash: string
}

type CandidateRow = {
  txid: string
  wtxid: string
  block_height: string | number
  block_hash: string
  raw_transaction: string
  raw_transaction_object_digest: string
  provenance_generation: string | number
  provenance_fingerprint: string
}

type CanonicalGenerationIdentityRow = {
  generation_id: string | number
  manifest_digest: string
  domain_digest: string
}

type ReadinessExportStreamRow = {
  stream_ordinal: string | number
  stream_leaf_digest: string
  object_digest: string
  object_kind: string
  byte_length: string | number
  content_digest: string
  chunk_count: string | number
  chunk_manifest_root: string
  chunk_index: string | number
  byte_offset: string | number
  chunk_digest: string
  chunk_leaf_digest: string
  chunk_bytes: Buffer
}

type CanonicalGenerationExportRow = CanonicalGenerationIdentityRow & {
  bitcoin_height: string | number
  bitcoin_hash: string
  bitcoin_chain_root: string
  projection_root: string
  semantic_root: string
}

type ReadinessExportAuditRow = {
  audit_manifest_root: string
  audit_stream_digest: string
  audit_object_count: string | number
  audit_total_bytes: string | number
}

type ReadinessExportRow = {
  request_nonce: string
  request_digest: string
  export_fence: string | number
  snapshot_root: string
  snapshot_semantic_root: string
  snapshot_generation: string | number
  pinned_generation: string | number
  generation_manifest_digest: string
  domain_digest: string
  source_store_id: string
  source_cluster_id: string
  source_operator_id: string
  source_trust_domain_id: string
  source_bitcoin_identity_digest: string
  source_ethereum_identity_digest: string
  source_identity_digest: string
  source_configuration_fingerprint: string
  source_signing_key_id: string
  source_signature: string
  source_signature_payload_digest: string
  canonical_request: unknown
  result_payload: unknown
  result_digest: string
  audit_manifest_root: string
  audit_stream_digest: string
  audit_object_count: string | number
  audit_total_bytes: string | number
}

type CandidateObservationPagePosition = {
  blockHeight: number
  blockHash: string
  txid: string
  wtxid: string
  inputIndex: number
}

type CandidatePrevoutRow = {
  input_index: string | number
  prev_txid: string
  prev_vout: string | number
  prev_value_sats: string | number
  prev_script_pubkey: string
}

type CandidateWalletBindingRow = {
  txid: string
  vout: string | number
  output_key: string
  wallet_id: string
}

type CandidatePrevoutLengthRow = {
  input_index: string | number
  prev_txid: string
  prev_vout: string | number
  prev_value_sats: string | number
  prev_block_hash: string
  script_bytes: string | number
}

type CandidateTransactionCommitments = {
  rawTransactionDigest: string
  rawTransactionBytes: number
  prevoutVectorRoot: string
  prevoutCount: number
  prevoutBytes: number
  shaPrevouts: string
  shaAmounts: string
  shaScriptPubKeys: string
  shaSequences: string
  shaOutputs: string
}

type CandidateCurrentPrevout = {
  inputIndex: number
  txid: string
  vout: number
  valueSats: number
  scriptPubKey: Buffer
  fundingBlockHash: string
  fundingHeaderObjectDigest: string
}

type ImmutableEvidenceObject = {
  objectDigest: string
  kind: string
  byteLength: number
  contentDigest: string
  chunkManifestRoot: string
  chunks: Array<{
    index: number
    byteOffset: number
    bytes: Buffer
    chunkDigest: string
    leafDigest: string
  }>
}

type NormalizedCandidateIdentity = {
  blockHash: string
  txid: string
  wtxid: string
}

type CandidateProvenanceState = {
  generation: number
  fingerprint: string
}

type CandidateEthereumProvenance = {
  inputIndex: number
  fundingBlockHash: string
  fundingTxid: string
  fundingVout: number
  walletID: string
  outputKey: string
  bindingKind: "wallet" | "deposit"
  sourceEventID: string
  ethereumBlockNumber: number
  ethereumBlockHash: string
}

type CandidateProvenance = CandidateProvenanceState & {
  rows: CandidateEthereumProvenance[]
}

type CandidateEthereumProvenanceRow = {
  input_index: string | number
  funding_block_hash: string
  funding_txid: string
  funding_vout: string | number
  wallet_id: string
  output_key: string
  binding_kind: string
  source_event_id: string
  ethereum_block_number: string | number
  ethereum_block_hash: string
}

type CandidateObservationRow = {
  protocol_id: string
  domain_digest: string
  txid: string
  wtxid: string
  block_height: string | number
  block_hash: string
  input_index: string | number
  wallet_id: string
  signing_key: string
  binding_tx_hash: string
  binding_output_index: string | number
  sighash_type: string | number
  sighash: string
  nonce_x: string
  signature_scalar: string
  challenge_identity: string
  occurrence_id: string
  raw_transaction_digest: string
  raw_transaction_bytes: string | number
  witness_digest: string
  annex_digest: string
  prevout_vector_root: string
  prevout_count: string | number
  prevout_bytes: string | number
  sha_prevouts: string
  sha_amounts: string
  sha_script_pubkeys: string
  sha_sequences: string
  sha_outputs: string
  candidate_block_header_hash: string
  funding_block_header_hash: string
  provenance_generation: string | number
  provenance_fingerprint: string
  funding_block_hash: string
  funding_txid: string
  funding_vout: string | number
  provenance_wallet_id: string
  output_key: string
  binding_kind: string
  source_event_id: string
  ethereum_block_number: string | number
  ethereum_block_hash: string
}

type CandidateProvenanceIdentityRow = {
  block_hash: string
  txid: string
  wtxid: string
  provenance_generation: string | number
  provenance_fingerprint: string
}

type CandidateObservationIdentityRow = CandidateProvenanceIdentityRow & {
  occurrence_id: string
  input_index: string | number
  challenge_identity: string
}

type InvalidatedProvenanceRow = CandidateProvenanceIdentityRow & {
  invalidation_id: string | number
  reason: string
  source_event_ids: unknown
  successor_fingerprint: string | null
}

type ProofRow = {
  event_id: string
  ethereum_block_number: string | number
  ethereum_block_hash: string
  ethereum_transaction_hash: string
  ethereum_log_index: string | number
  bitcoin_txid: string
  wallet_id: string
  spend_type: string
  payload: unknown
}

type WatermarkRow = {
  bitcoin_height: string | number
  bitcoin_hash: string
  ethereum_block_number: string | number
  ethereum_block_hash: string
}

type ReadinessSnapshotRow = {
  store_id: string | null
  configuration_fingerprint: string | null
  network: string | null
  trust_domain_id: string | null
  checkpoint_height: string | number | null
  checkpoint_hash: string | null
  current_height: string | number | null
  current_hash: string | null
  current_chain_commitment: string | null
  current_evidence_chain_commitment: string | null
  journal_block_count: string | number | null
  journal_transaction_count: string | number | null
  journal_input_count: string | number | null
  journal_output_count: string | number | null
  journal_unresolved_input_count: string | number | null
  authorization_protocol_id: string
  authorization_domain_chain_id: string
  authorization_bridge_address: string
  authorization_domain_digest: string
  generation: string | number
  next_generation: string | number
  next_invalidation_id: string | number
  next_export_fence: string | number
  max_provenance_generation: string | number
  max_invalidation_id: string | number
  max_export_fence: string | number
  bitcoin_evidence_root: string
  semantic_commitment: string
  semantic_row_count: string | number
  projection_commitment: string
  projection_row_count: string | number
  wallet_binding_count: string | number
  deposit_reveal_count: string | number
  pending_deposit_reveal_count: string | number
  tracked_outpoint_count: string | number
  candidate_count: string | number
  pending_candidate_count: string | number
  candidate_provenance_count: string | number
  invalidation_count: string | number
  unmatched_proof_count: string | number
  pending_unmatched_proof_count: string | number
  watermark_count: string | number
  watermark_bitcoin_height: string | number | null
  watermark_bitcoin_hash: string | null
  watermark_ethereum_block_number: string | number | null
  watermark_ethereum_block_hash: string | null
  pending_deposit_commitment: string
  pending_candidate_commitment: string
  pending_proof_commitment: string
}

type JournalOutputRow = {
  txid: string
  wtxid: string
  vout: string | number
  value_sats: string | number
  script_pubkey: string
  block_height: string | number
  block_hash: string
}

type SpendRow = {
  spending_txid: string
  spending_wtxid: string
  input_index: string | number
  block_height: string | number
  block_hash: string
}

const JOURNAL_OUTPUT_COLUMNS = `encode(output.txid, 'hex') AS txid,
       encode(output.wtxid, 'hex') AS wtxid,
       output.vout,
       output.value_sats,
       encode(output.script_pubkey, 'hex') AS script_pubkey,
       output.block_height,
       encode(output.block_hash, 'hex') AS block_hash`

const JOURNAL_OUTPUT_SELECT = `SELECT ${JOURNAL_OUTPUT_COLUMNS}
  FROM p2tr_bitcoin_outputs output`

const TRACKED_OUTPOINT_COLUMNS = `encode(tracked.txid, 'hex') AS txid,
       tracked.vout,
       tracked.kind,
       encode(tracked.wallet_id, 'hex') AS wallet_id,
       encode(tracked.output_key, 'hex') AS output_key,
       tracked.value_sats,
       encode(tracked.script_pubkey, 'hex') AS script_pubkey,
       tracked.created_height,
       encode(tracked.created_hash, 'hex') AS created_hash`

const TRACKED_OUTPOINT_SELECT = `SELECT ${TRACKED_OUTPOINT_COLUMNS}
  FROM p2tr_tracked_outpoints tracked`

const PROOF_SELECT = `SELECT event_id,
       ethereum_block_number,
       encode(ethereum_block_hash, 'hex') AS ethereum_block_hash,
       encode(ethereum_transaction_hash, 'hex') AS ethereum_transaction_hash,
       ethereum_log_index,
       encode(bitcoin_txid, 'hex') AS bitcoin_txid,
       encode(wallet_id, 'hex') AS wallet_id,
       spend_type,
       payload
  FROM p2tr_unmatched_proofs`

const WATERMARK_SELECT = `SELECT bitcoin_height,
       encode(bitcoin_hash, 'hex') AS bitcoin_hash,
       ethereum_block_number,
       encode(ethereum_block_hash, 'hex') AS ethereum_block_hash
  FROM p2tr_cross_source_watermark
 WHERE singleton = true`

const trackedOutpointFromRow = (
  row: TrackedOutpointRow
): P2TRTrackedOutpoint => {
  if (row.kind !== "wallet" && row.kind !== "deposit") {
    throw new Error("Stored tracked outpoint kind is invalid")
  }
  return {
    txid: normalizeBytes32(row.txid, "tracked outpoint txid"),
    vout: uint32(row.vout, "tracked outpoint index"),
    kind: row.kind,
    walletID: normalizeBytes32(row.wallet_id, "tracked wallet ID"),
    outputKey: normalizeBytes32(row.output_key, "tracked output key"),
    valueSats: databaseInteger(row.value_sats, "tracked output value"),
    scriptPubKey: normalizeHex(row.script_pubkey, "tracked scriptPubKey"),
    createdAt: {
      height: databaseInteger(row.created_height, "tracked creation height"),
      hash: normalizeBytes32(row.created_hash, "tracked creation hash"),
    },
  }
}

const trackedWalletFromOutputRow = (
  row: JournalOutputRow,
  walletID: string
): P2TRTrackedOutpoint => ({
  txid: normalizeBytes32(row.txid, "wallet funding txid"),
  vout: uint32(row.vout, "wallet funding output index"),
  kind: "wallet",
  walletID: normalizeBytes32(walletID, "wallet ID"),
  outputKey: normalizeBytes32(walletID, "wallet output key"),
  valueSats: databaseInteger(row.value_sats, "wallet output value"),
  scriptPubKey: normalizeHex(row.script_pubkey, "wallet scriptPubKey"),
  createdAt: {
    height: databaseInteger(row.block_height, "wallet funding height"),
    hash: normalizeBytes32(row.block_hash, "wallet funding hash"),
  },
})

const candidateFromRow = (
  row: CandidateRow,
  inputPrevouts: P2TRCanonicalBitcoinScan["candidates"][number]["inputPrevouts"],
  walletInputKeyBindings: P2TRCanonicalBitcoinScan["candidates"][number]["walletInputKeyBindings"]
): P2TRCanonicalBitcoinScan["candidates"][number] => ({
  txid: normalizeBytes32(row.txid, "candidate txid"),
  wtxid: normalizeBytes32(row.wtxid, "candidate wtxid"),
  rawTransactionHex: normalizeHex(
    row.raw_transaction,
    "candidate raw transaction"
  ),
  block: {
    height: databaseInteger(row.block_height, "candidate block height"),
    hash: normalizeBytes32(row.block_hash, "candidate block hash"),
  },
  inputPrevouts,
  walletInputKeyBindings,
  provenanceGeneration: positiveInteger(
    databaseInteger(
      row.provenance_generation,
      "candidate provenance generation"
    ),
    "candidate provenance generation"
  ),
  provenanceFingerprint: normalizeBytes32(
    row.provenance_fingerprint,
    "candidate provenance fingerprint"
  ),
})

const candidatePrevoutFromRow = (
  row: CandidatePrevoutRow
): P2TRCanonicalBitcoinScan["candidates"][number]["inputPrevouts"][number] => ({
  txid: normalizeBytes32(row.prev_txid, "candidate prevout txid"),
  vout: uint32(row.prev_vout, "candidate prevout index"),
  valueSats: databaseInteger(row.prev_value_sats, "candidate prevout value"),
  scriptPubKey: normalizeScriptHex(
    row.prev_script_pubkey,
    "candidate prevout script"
  ),
})

const candidateWalletBindingFromRow = (
  row: CandidateWalletBindingRow
): P2TRCanonicalBitcoinScan["candidates"][number]["walletInputKeyBindings"][number] => ({
  txid: normalizeBytes32(row.txid, "binding txid"),
  vout: uint32(row.vout, "binding output index"),
  outputKey: normalizeBytes32(row.output_key, "binding output key"),
  walletID: normalizeBytes32(row.wallet_id, "binding wallet ID"),
})

const proofFromRow = (row: ProofRow): P2TRUnmatchedProofEnvelope => ({
  eventID: boundedString(row.event_id, 512, "proof event ID"),
  ethereum: {
    blockNumber: databaseInteger(
      row.ethereum_block_number,
      "proof Ethereum block number"
    ),
    blockHash: normalizeBytes32(
      row.ethereum_block_hash,
      "proof Ethereum block hash"
    ),
    transactionHash: normalizeBytes32(
      row.ethereum_transaction_hash,
      "proof Ethereum transaction hash"
    ),
    logIndex: databaseInteger(
      row.ethereum_log_index,
      "proof Ethereum log index"
    ),
  },
  bitcoinTxid: normalizeBytes32(row.bitcoin_txid, "proof Bitcoin txid"),
  walletID: normalizeBytes32(row.wallet_id, "proof wallet ID"),
  spendType: boundedString(row.spend_type, 64, "proof spend type"),
  payload: requireRecord(row.payload, "proof payload"),
})

const watermarkFromRow = (row: WatermarkRow): P2TRCrossSourceWatermark => ({
  bitcoin: {
    height: databaseInteger(row.bitcoin_height, "watermark Bitcoin height"),
    hash: normalizeBytes32(row.bitcoin_hash, "watermark Bitcoin hash"),
  },
  ethereum: {
    blockNumber: databaseInteger(
      row.ethereum_block_number,
      "watermark Ethereum block number"
    ),
    blockHash: normalizeBytes32(
      row.ethereum_block_hash,
      "watermark Ethereum block hash"
    ),
  },
})

const readinessSnapshotFromRow = (
  row: ReadinessSnapshotRow
): P2TRReadinessSnapshot => {
  if (
    row.store_id === null ||
    row.configuration_fingerprint === null ||
    row.network === null ||
    row.trust_domain_id === null ||
    row.checkpoint_height === null ||
    row.checkpoint_hash === null ||
    row.current_height === null ||
    row.current_hash === null ||
    row.current_chain_commitment === null ||
    row.current_evidence_chain_commitment === null ||
    row.journal_block_count === null ||
    row.journal_transaction_count === null ||
    row.journal_input_count === null ||
    row.journal_output_count === null ||
    row.journal_unresolved_input_count === null
  ) {
    throw new Error("PostgreSQL readiness cursor is incomplete")
  }
  const generation = databaseInteger(row.generation, "readiness generation")
  const allocators: P2TRReadinessSnapshot["allocators"] = {
    nextCandidateProvenanceGeneration: positiveInteger(
      databaseInteger(
        row.next_generation,
        "next candidate provenance generation"
      ),
      "next candidate provenance generation"
    ),
    nextInvalidationID: positiveInteger(
      databaseInteger(row.next_invalidation_id, "next invalidation ID"),
      "next invalidation ID"
    ),
    nextExportFence: positiveInteger(
      databaseInteger(row.next_export_fence, "next readiness export fence"),
      "next readiness export fence"
    ),
  }
  const maxProvenanceGeneration = databaseInteger(
    row.max_provenance_generation,
    "maximum retained candidate provenance generation"
  )
  const maxInvalidationID = databaseInteger(
    row.max_invalidation_id,
    "maximum retained invalidation ID"
  )
  const maxExportFence = databaseInteger(
    row.max_export_fence,
    "maximum retained readiness export fence"
  )
  if (
    allocators.nextCandidateProvenanceGeneration <= maxProvenanceGeneration ||
    allocators.nextInvalidationID <= maxInvalidationID ||
    allocators.nextExportFence <= maxExportFence
  ) {
    throw new Error(
      "PostgreSQL readiness allocator would reuse retained identity"
    )
  }
  const storeID = boundedString(row.store_id, 255, "readiness store ID")
  const configurationFingerprint = normalizeBytes32(
    row.configuration_fingerprint,
    "readiness configuration fingerprint"
  )
  const network = boundedString(row.network, 32, "readiness Bitcoin network")
  const trustDomainID = boundedString(
    row.trust_domain_id,
    255,
    "readiness trust domain ID"
  )
  const bitcoinEvidenceRoot = normalizeBytes32(
    row.bitcoin_evidence_root,
    "readiness Bitcoin evidence root"
  )
  const bitcoin: P2TRReadinessSnapshot["bitcoin"] = {
    checkpoint: {
      height: databaseInteger(
        row.checkpoint_height,
        "readiness checkpoint height"
      ),
      hash: normalizeBytes32(row.checkpoint_hash, "readiness checkpoint hash"),
    },
    current: {
      height: databaseInteger(row.current_height, "readiness cursor height"),
      hash: normalizeBytes32(row.current_hash, "readiness cursor hash"),
    },
    chainCommitment: normalizeBytes32(
      row.current_chain_commitment,
      "readiness chain commitment"
    ),
    evidenceCommitment: normalizeBytes32(
      row.current_evidence_chain_commitment,
      "readiness cursor evidence commitment"
    ),
    journalCounts: {
      blocks: databaseInteger(row.journal_block_count, "readiness block count"),
      transactions: databaseInteger(
        row.journal_transaction_count,
        "readiness transaction count"
      ),
      inputs: databaseInteger(row.journal_input_count, "readiness input count"),
      outputs: databaseInteger(
        row.journal_output_count,
        "readiness output count"
      ),
      unresolvedInputs: databaseInteger(
        row.journal_unresolved_input_count,
        "readiness unresolved input count"
      ),
    },
  }
  if (bitcoinEvidenceRoot !== bitcoin.evidenceCommitment) {
    throw new Error("PostgreSQL readiness Bitcoin evidence root is stale")
  }
  const authorizationDomain: P2TRCompleteAuthorizationDomain = {
    protocolID: normalizeBytes32(
      row.authorization_protocol_id,
      "readiness COMPLETE protocol ID"
    ),
    domainChainID: normalizeUint256Decimal(
      row.authorization_domain_chain_id,
      "readiness COMPLETE domain chain ID"
    ),
    bridgeAddress: normalizeBytes20(
      row.authorization_bridge_address,
      "readiness COMPLETE Bridge address"
    ),
    domainDigest: normalizeBytes32(
      row.authorization_domain_digest,
      "readiness COMPLETE domain digest"
    ),
  }
  if (
    authorizationDomain.protocolID !== P2TR_COMPLETE_V2_PROTOCOL_ID ||
    authorizationDomain.domainDigest !==
      completeAuthorizationDomainDigest({
        chainID: BigInt(authorizationDomain.domainChainID),
        bridgeAddress: Buffer.from(authorizationDomain.bridgeAddress, "hex"),
      })
  ) {
    throw new Error("PostgreSQL readiness authorization domain is inconsistent")
  }

  const semanticRowCount = databaseInteger(
    row.semantic_row_count,
    "readiness semantic row count"
  )
  const rowCount = databaseInteger(
    row.projection_row_count,
    "readiness projection row count"
  )
  const pendingDepositReveals = databaseInteger(
    row.pending_deposit_reveal_count,
    "readiness pending deposit count"
  )
  const pendingCandidates = databaseInteger(
    row.pending_candidate_count,
    "readiness pending candidate count"
  )
  const pendingUnmatchedProofs = databaseInteger(
    row.pending_unmatched_proof_count,
    "readiness pending proof count"
  )
  const projection: P2TRReadinessSnapshot["projection"] = {
    semanticCommitment: normalizeBytes32(
      row.semantic_commitment,
      "readiness semantic MuHash3072 commitment"
    ),
    semanticRowCount,
    commitment: normalizeBytes32(
      row.projection_commitment,
      "readiness operational MuHash3072 commitment"
    ),
    rowCount,
    walletBindings: databaseInteger(
      row.wallet_binding_count,
      "readiness wallet count"
    ),
    depositReveals: databaseInteger(
      row.deposit_reveal_count,
      "readiness deposit count"
    ),
    pendingDepositReveals,
    trackedOutpoints: databaseInteger(
      row.tracked_outpoint_count,
      "readiness tracked count"
    ),
    candidates: databaseInteger(
      row.candidate_count,
      "readiness candidate count"
    ),
    pendingCandidates,
    candidateInputProvenance: databaseInteger(
      row.candidate_provenance_count,
      "readiness candidate provenance count"
    ),
    invalidations: databaseInteger(
      row.invalidation_count,
      "readiness invalidation count"
    ),
    unmatchedProofs: databaseInteger(
      row.unmatched_proof_count,
      "readiness proof count"
    ),
    pendingUnmatchedProofs,
    crossSourceWatermarks: databaseInteger(
      row.watermark_count,
      "readiness watermark count"
    ),
    pendingDepositCommitment: normalizeBytes32(
      row.pending_deposit_commitment,
      "readiness pending-deposit MuHash3072 commitment"
    ),
    pendingCandidateCommitment: normalizeBytes32(
      row.pending_candidate_commitment,
      "readiness pending-candidate MuHash3072 commitment"
    ),
    pendingProofCommitment: normalizeBytes32(
      row.pending_proof_commitment,
      "readiness pending-proof MuHash3072 commitment"
    ),
  }
  const crossSourceWatermark = readinessWatermarkFromRow(row)
  const semanticRoot = readinessRoot({
    version: 2,
    schemaVersion: REQUIRED_SCHEMA_VERSION,
    authorizationDomain,
    network,
    bitcoin,
    crossSourceWatermark: crossSourceWatermark ?? null,
    projection: {
      commitment: projection.semanticCommitment,
      rowCount: projection.semanticRowCount,
      walletBindings: projection.walletBindings,
      depositReveals: projection.depositReveals,
      pendingDepositReveals: projection.pendingDepositReveals,
      trackedOutpoints: projection.trackedOutpoints,
      candidates: projection.candidates,
      candidateInputProvenance: projection.candidateInputProvenance,
      unmatchedProofs: projection.unmatchedProofs,
      pendingUnmatchedProofs: projection.pendingUnmatchedProofs,
      pendingDepositCommitment: projection.pendingDepositCommitment,
      pendingProofCommitment: projection.pendingProofCommitment,
    },
  })
  const localCertificate = {
    storeID,
    configurationFingerprint,
    network,
    trustDomainID,
    generation,
    allocators,
    semanticRoot,
    authorizationDomain,
    bitcoin,
    crossSourceWatermark: crossSourceWatermark ?? null,
    projection,
  }
  return {
    storeID,
    configurationFingerprint,
    network,
    trustDomainID,
    generation,
    allocators,
    root: calculateUnsignedP2TRReadinessSnapshotRoot(localCertificate),
    semanticRoot,
    authorizationDomain,
    bitcoin,
    ...(crossSourceWatermark === undefined ? {} : { crossSourceWatermark }),
    projection,
  }
}

const readinessWatermarkFromRow = (
  row: ReadinessSnapshotRow
): P2TRCrossSourceWatermark | undefined => {
  const count = databaseInteger(
    row.watermark_count,
    "readiness watermark count"
  )
  const absent =
    row.watermark_bitcoin_height === null &&
    row.watermark_bitcoin_hash === null &&
    row.watermark_ethereum_block_number === null &&
    row.watermark_ethereum_block_hash === null
  if (count === 0 && absent) return undefined
  if (
    count !== 1 ||
    row.watermark_bitcoin_height === null ||
    row.watermark_bitcoin_hash === null ||
    row.watermark_ethereum_block_number === null ||
    row.watermark_ethereum_block_hash === null
  ) {
    throw new Error("PostgreSQL readiness watermark state is inconsistent")
  }
  return {
    bitcoin: {
      height: databaseInteger(
        row.watermark_bitcoin_height,
        "readiness watermark Bitcoin height"
      ),
      hash: normalizeBytes32(
        row.watermark_bitcoin_hash,
        "readiness watermark Bitcoin hash"
      ),
    },
    ethereum: {
      blockNumber: databaseInteger(
        row.watermark_ethereum_block_number,
        "readiness watermark Ethereum block number"
      ),
      blockHash: normalizeBytes32(
        row.watermark_ethereum_block_hash,
        "readiness watermark Ethereum block hash"
      ),
    },
  }
}

const readinessRoot = (value: unknown): string =>
  createHash("sha256").update(canonicalJSON(value)).digest("hex")

const calculateUnsignedP2TRReadinessSnapshotRoot = (
  snapshot: Omit<P2TRReadinessSnapshot, "root" | "crossSourceWatermark"> & {
    crossSourceWatermark: P2TRCrossSourceWatermark | null
  }
): string => readinessRoot({ version: 2, ...snapshot })

/** Recomputes the local whole-snapshot CAS root for certificate verification. */
export const calculateP2TRReadinessSnapshotRoot = (
  snapshot: P2TRReadinessSnapshot
): string => {
  const { root: _root, crossSourceWatermark, ...unsigned } = snapshot
  return calculateUnsignedP2TRReadinessSnapshotRoot({
    ...unsigned,
    crossSourceWatermark: crossSourceWatermark ?? null,
  })
}

const validateBitcoinScan = (scan: P2TRCanonicalBitcoinScan): void => {
  normalizeBytes32(scan.configurationFingerprint, "configuration fingerprint")
  boundedString(scan.network, 32, "Bitcoin network")
  boundedString(scan.trustDomainID, 255, "Bitcoin trust domain ID")
  validatePoint(scan.checkpoint, "Bitcoin checkpoint")
  validatePoint(scan.checkpointBlock, "Bitcoin checkpoint block")
  if (!samePoint(scan.checkpoint, scan.checkpointBlock)) {
    throw new Error("Bitcoin checkpoint evidence does not match its anchor")
  }
  validateBitcoinBlockEvidence(scan.checkpointBlock, "Bitcoin checkpoint")
  validatePoint(scan.rollbackTo, "Bitcoin rollback point")
  validatePoint(scan.nextCursor, "Bitcoin next cursor")
  validatePoint(scan.sampledFinalizedHead, "Bitcoin sampled head")
  if (scan.expectedCursor !== undefined) {
    validatePoint(scan.expectedCursor, "Bitcoin expected cursor")
    if (scan.rollbackTo.height > scan.expectedCursor.height) {
      throw new Error("Bitcoin rollback point follows the expected cursor")
    }
  }
  if (
    scan.rollbackTo.height < scan.checkpoint.height ||
    scan.nextCursor.height > scan.sampledFinalizedHead.height
  ) {
    throw new Error("Bitcoin scan cursor range is invalid")
  }

  let parent = scan.rollbackTo
  for (const block of scan.blocks) {
    validatePoint(block, "Bitcoin scan block")
    if (
      block.height !== parent.height + 1 ||
      block.parentHash !== parent.hash
    ) {
      throw new Error("Bitcoin scan blocks are not contiguous")
    }
    validateBitcoinBlockEvidence(block, "Bitcoin scan block")
    parent = { height: block.height, hash: block.hash }
  }
  if (!samePoint(parent, scan.nextCursor)) {
    throw new Error("Bitcoin scan next cursor does not match its final block")
  }

  const transactions = new Map<
    string,
    { raw: string; block: P2TRBitcoinChainPoint }
  >()
  for (const block of [scan.checkpointBlock, ...scan.blocks]) {
    const blockPoint = {
      height: nonNegativeInteger(
        block.height,
        "Bitcoin transaction block height"
      ),
      hash: normalizeBytes32(block.hash, "Bitcoin transaction block hash"),
    }
    for (const transaction of block.transactions) {
      const txid = normalizeBytes32(transaction.txid, "Bitcoin transaction ID")
      const wtxid = normalizeBytes32(
        transaction.wtxid,
        "Bitcoin witness transaction ID"
      )
      const raw = normalizeHex(
        transaction.rawTransactionHex,
        "raw Bitcoin transaction"
      )
      let parsed: Transaction
      try {
        parsed = Transaction.fromBuffer(Buffer.from(raw, "hex"))
      } catch {
        throw new Error("Raw Bitcoin transaction is not canonical wire data")
      }
      if (
        parsed.getId() !== txid ||
        serializedBitcoinTransactionHash(Buffer.from(raw, "hex")) !== wtxid
      ) {
        throw new Error("Raw Bitcoin transaction identity is inconsistent")
      }
      if (
        transaction.coinbase !== parsed.isCoinbase() ||
        transaction.inputs.length !== parsed.ins.length ||
        transaction.outputs.length !== parsed.outs.length
      ) {
        throw new Error(
          "Bitcoin transaction projection cardinality is inconsistent"
        )
      }
      transaction.inputs.forEach((input, index) => {
        const wireInput = parsed.ins[index]
        const wireTxid = Buffer.from(wireInput.hash).reverse().toString("hex")
        const inputTxid = normalizeBytes32(
          input.txid,
          "Bitcoin previous transaction ID"
        )
        if (
          normalizeBytes32(
            input.spendingTxid,
            "Bitcoin spending transaction ID"
          ) !== txid ||
          uint32(input.inputIndex, "Bitcoin transaction input index") !==
            index ||
          inputTxid !== wireTxid ||
          uint32(input.vout, "Bitcoin previous output index") !==
            wireInput.index ||
          (input.authenticatedPrevout !== undefined &&
            (normalizeBytes32(
              input.authenticatedPrevout.txid,
              "authenticated previous transaction ID"
            ) !== inputTxid ||
              uint32(
                input.authenticatedPrevout.vout,
                "authenticated previous output index"
              ) !== wireInput.index))
        ) {
          throw new Error("Bitcoin transaction input journal is inconsistent")
        }
      })
      transaction.outputs.forEach((output, index) => {
        const wireOutput = parsed.outs[index]
        if (
          normalizeBytes32(output.txid, "Bitcoin output transaction ID") !==
            txid ||
          uint32(output.vout, "Bitcoin output index") !== index ||
          nonNegativeInteger(output.valueSats, "Bitcoin output value") !==
            wireOutput.value ||
          normalizeScriptHex(
            output.scriptPubKey,
            "Bitcoin output scriptPubKey"
          ) !== wireOutput.script.toString("hex")
        ) {
          throw new Error("Bitcoin transaction output journal is inconsistent")
        }
      })
      const identity = `${blockPoint.hash}:${txid}:${wtxid}`
      if (transactions.has(identity)) {
        throw new Error(`Bitcoin transaction ${identity} is duplicated in scan`)
      }
      transactions.set(identity, {
        raw,
        block: blockPoint,
      })
    }
  }
  for (const candidate of scan.candidates) {
    const candidateBlock = {
      height: nonNegativeInteger(
        candidate.block.height,
        "Bitcoin candidate block height"
      ),
      hash: normalizeBytes32(
        candidate.block.hash,
        "Bitcoin candidate block hash"
      ),
    }
    const candidateTxid = normalizeBytes32(
      candidate.txid,
      "Bitcoin candidate transaction ID"
    )
    const candidateWtxid = normalizeBytes32(
      candidate.wtxid,
      "Bitcoin candidate witness transaction ID"
    )
    const transaction = transactions.get(
      `${candidateBlock.hash}:${candidateTxid}:${candidateWtxid}`
    )
    if (
      transaction === undefined ||
      transaction.raw !==
        normalizeHex(
          candidate.rawTransactionHex,
          "raw Bitcoin candidate transaction"
        ) ||
      !samePoint(transaction.block, candidateBlock)
    ) {
      throw new Error(
        `Bitcoin candidate ${candidate.txid} does not match its retained transaction`
      )
    }
  }
  const acknowledgement = scan.candidateObservationAcknowledgement
  if (acknowledgement !== undefined) {
    if (
      acknowledgement.schema !==
        "tbtc-p2tr-candidate-observation-page-acknowledgement/v1" ||
      typeof acknowledgement.complete !== "boolean"
    ) {
      throw new Error(
        "Bitcoin candidate observation acknowledgement is invalid"
      )
    }
    normalizeCanonicalGenerationIdentity(acknowledgement.generation)
    if (acknowledgement.after !== undefined) {
      boundedString(
        acknowledgement.after,
        2048,
        "candidate observation acknowledgement cursor"
      )
    }
    if (acknowledgement.nextAfter !== undefined) {
      boundedString(
        acknowledgement.nextAfter,
        2048,
        "candidate observation acknowledgement next cursor"
      )
    }
    acknowledgement.observations.forEach(validateCandidateObservationIdentity)
    if (
      new Set(acknowledgement.observations.map(candidateObservationIdentityKey))
        .size !== acknowledgement.observations.length
    ) {
      throw new Error(
        "Bitcoin candidate observation acknowledgements must be unique"
      )
    }
    if (
      (acknowledgement.complete && acknowledgement.nextAfter !== undefined) ||
      (!acknowledgement.complete &&
        (acknowledgement.nextAfter === undefined ||
          acknowledgement.observations.length === 0))
    ) {
      throw new Error("Bitcoin candidate observation page boundary is invalid")
    }
  }
  const testOnlyAcknowledged = scan.testOnlyAcknowledgedCandidates ?? []
  if (scan.checkpoint.height === 0 && testOnlyAcknowledged.length > 0) {
    throw new Error(
      "Candidate-wide acknowledgements are forbidden for genesis-backed production"
    )
  }
  for (const identity of testOnlyAcknowledged) {
    normalizeCandidateIdentity(identity)
    normalizeBytes32(
      identity.provenanceFingerprint,
      "test-only candidate provenance fingerprint"
    )
    positiveInteger(
      identity.provenanceGeneration,
      "test-only candidate provenance generation"
    )
  }
  if (
    new Set(testOnlyAcknowledged.map(candidateProvenanceIdentityKey)).size !==
    testOnlyAcknowledged.length
  ) {
    throw new Error("Test-only candidate acknowledgements must be unique")
  }
}

const validateDepositBinding = (binding: P2TRTaprootDepositBinding): void => {
  normalizeBytes32(binding.txid, "deposit funding txid")
  uint32(binding.vout, "deposit funding output index")
  normalizeBytes32(binding.walletID, "deposit wallet ID")
  normalizeBytes32(binding.outputKey, "deposit output key")
  boundedString(binding.sourceEventID, 512, "deposit source event ID")
  validatePoint(
    { height: binding.ethereum.blockNumber, hash: binding.ethereum.blockHash },
    "deposit Ethereum point"
  )
}

const validateFrostWalletBinding = (binding: P2TRFrostWalletBinding): void => {
  normalizeBytes32(binding.walletID, "FROST wallet ID")
  normalizeBytes20(binding.walletPubKeyHash, "FROST wallet public-key hash")
  boundedString(binding.sourceEventID, 512, "wallet source event ID")
  validatePoint(
    { height: binding.ethereum.blockNumber, hash: binding.ethereum.blockHash },
    "wallet Ethereum point"
  )
}

const validateProofEnvelope = (
  proof: P2TRUnmatchedProofEnvelope,
  maxPayloadBytes: number
): void => {
  boundedString(proof.eventID, 512, "proof event ID")
  validatePoint(
    { height: proof.ethereum.blockNumber, hash: proof.ethereum.blockHash },
    "proof Ethereum point"
  )
  normalizeBytes32(proof.ethereum.transactionHash, "proof transaction hash")
  nonNegativeInteger(proof.ethereum.logIndex, "proof log index")
  normalizeBytes32(proof.bitcoinTxid, "proof Bitcoin txid")
  normalizeBytes32(proof.walletID, "proof wallet ID")
  boundedString(proof.spendType, 64, "proof spend type")
  requireRecord(proof.payload, "proof payload")
  if (
    Buffer.byteLength(canonicalJSON(proof.payload), "utf8") > maxPayloadBytes
  ) {
    throw new Error(
      `Proof payload exceeds the configured ${maxPayloadBytes}-byte bound`
    )
  }
}

const validateWatermark = (
  watermark: P2TRCrossSourceWatermark,
  field: string
): void => {
  validatePoint(watermark.bitcoin, `${field} Bitcoin point`)
  validatePoint(
    {
      height: watermark.ethereum.blockNumber,
      hash: watermark.ethereum.blockHash,
    },
    `${field} Ethereum point`
  )
}

const validatePoint = (point: P2TRBitcoinChainPoint, field: string): void => {
  nonNegativeInteger(point.height, `${field} height`)
  normalizeBytes32(point.hash, `${field} hash`)
}

const assertMonotonicPoint = (
  previous: P2TRBitcoinChainPoint,
  next: P2TRBitcoinChainPoint,
  field: string
): void => {
  if (
    next.height < previous.height ||
    (next.height === previous.height && next.hash !== previous.hash)
  ) {
    throw new Error(`${field} cannot move backward or change hash`)
  }
}

const samePoint = (
  left: P2TRBitcoinChainPoint,
  right: P2TRBitcoinChainPoint
): boolean => left.height === right.height && left.hash === right.hash

const candidateIdentityKey = (identity: {
  txid: string
  wtxid: string
  blockHash: string
}): string => `${identity.blockHash}:${identity.txid}:${identity.wtxid}`

const candidateProvenanceIdentityKey = (
  identity: P2TRCandidateProvenanceIdentity
): string =>
  `${candidateIdentityKey(identity)}:${identity.provenanceGeneration}:${
    identity.provenanceFingerprint
  }`

const candidateObservationIdentityKey = (
  identity: P2TRCandidateObservationIdentity
): string =>
  `${identity.occurrenceID}:${candidateIdentityKey(identity)}:${
    identity.inputIndex
  }:${identity.challengeIdentity}:${identity.provenanceGeneration}:${
    identity.provenanceFingerprint
  }`

const candidateObservationIdentityFromObservation = (
  observation: P2TRCompleteV2CandidateObservation
): P2TRCandidateObservationIdentity => ({
  occurrenceID: observation.occurrenceID,
  blockHash: observation.blockHash,
  txid: observation.txid,
  wtxid: observation.wtxid,
  inputIndex: observation.inputIndex,
  challengeIdentity: observation.challengeIdentity,
  provenanceGeneration: observation.provenanceGeneration,
  provenanceFingerprint: observation.provenanceFingerprint,
})

const candidateObservationIdentityJSON = (
  identity: P2TRCandidateObservationIdentity
): Record<string, unknown> => ({
  occurrence_id: identity.occurrenceID,
  block_hash: identity.blockHash,
  txid: identity.txid,
  wtxid: identity.wtxid,
  input_index: identity.inputIndex,
  challenge_identity: identity.challengeIdentity,
  provenance_generation: identity.provenanceGeneration,
  provenance_fingerprint: identity.provenanceFingerprint,
})

const validateCandidateObservationIdentity = (
  identity: P2TRCandidateObservationIdentity
): void => {
  normalizeBytes32(
    identity.occurrenceID,
    "acknowledged candidate occurrence ID"
  )
  normalizeCandidateIdentity(identity)
  uint32(identity.inputIndex, "acknowledged candidate input index")
  normalizeBytes32(
    identity.challengeIdentity,
    "acknowledged candidate challenge identity"
  )
  positiveInteger(
    identity.provenanceGeneration,
    "acknowledged candidate provenance generation"
  )
  normalizeBytes32(
    identity.provenanceFingerprint,
    "acknowledged candidate provenance fingerprint"
  )
}

const normalizeCandidateIdentity = (identity: {
  txid: string
  wtxid: string
  blockHash: string
}): NormalizedCandidateIdentity => ({
  txid: normalizeBytes32(identity.txid, "candidate transaction ID"),
  wtxid: normalizeBytes32(identity.wtxid, "candidate witness transaction ID"),
  blockHash: normalizeBytes32(identity.blockHash, "candidate block hash"),
})

const candidateProvenanceIdentityFromRow = (
  row: CandidateProvenanceIdentityRow
): P2TRCandidateProvenanceIdentity => ({
  blockHash: normalizeBytes32(row.block_hash, "candidate block hash"),
  txid: normalizeBytes32(row.txid, "candidate transaction ID"),
  wtxid: normalizeBytes32(row.wtxid, "candidate witness transaction ID"),
  provenanceGeneration: positiveInteger(
    databaseInteger(
      row.provenance_generation,
      "candidate provenance generation"
    ),
    "candidate provenance generation"
  ),
  provenanceFingerprint: normalizeBytes32(
    row.provenance_fingerprint,
    "candidate provenance fingerprint"
  ),
})

const candidateObservationIdentityFromRow = (
  row: CandidateObservationIdentityRow
): P2TRCandidateObservationIdentity => ({
  ...candidateProvenanceIdentityFromRow(row),
  occurrenceID: normalizeBytes32(
    row.occurrence_id,
    "candidate observation occurrence ID"
  ),
  inputIndex: uint32(row.input_index, "candidate observation input index"),
  challengeIdentity: normalizeBytes32(
    row.challenge_identity,
    "candidate observation challenge identity"
  ),
})

const candidateEthereumProvenanceFromRow = (
  row: CandidateEthereumProvenanceRow
): CandidateEthereumProvenance => ({
  inputIndex: uint32(row.input_index, "candidate provenance input index"),
  fundingBlockHash: normalizeBytes32(
    row.funding_block_hash,
    "candidate provenance funding block hash"
  ),
  fundingTxid: normalizeBytes32(
    row.funding_txid,
    "candidate provenance funding txid"
  ),
  fundingVout: uint32(row.funding_vout, "candidate provenance funding vout"),
  walletID: normalizeBytes32(row.wallet_id, "candidate provenance wallet ID"),
  outputKey: normalizeBytes32(
    row.output_key,
    "candidate provenance output key"
  ),
  bindingKind: candidateBindingKind(row.binding_kind),
  sourceEventID: boundedString(
    row.source_event_id,
    512,
    "candidate provenance source event ID"
  ),
  ethereumBlockNumber: databaseInteger(
    row.ethereum_block_number,
    "candidate provenance Ethereum block number"
  ),
  ethereumBlockHash: normalizeBytes32(
    row.ethereum_block_hash,
    "candidate provenance Ethereum block hash"
  ),
})

const candidateObservationFromRow = (
  row: CandidateObservationRow
): P2TRCompleteV2CandidateObservation => {
  const inputIndex = uint32(
    row.input_index,
    "candidate observation input index"
  )
  const domainDigest = normalizeBytes32(
    row.domain_digest,
    "candidate observation domain digest"
  )
  const txid = normalizeBytes32(
    row.txid,
    "candidate observation transaction ID"
  )
  const wtxid = normalizeBytes32(
    row.wtxid,
    "candidate observation witness transaction ID"
  )
  const blockHash = normalizeBytes32(
    row.block_hash,
    "candidate observation block hash"
  )
  const challengeIdentity = normalizeBytes32(
    row.challenge_identity,
    "candidate observation challenge identity"
  )
  const occurrenceID = normalizeBytes32(
    row.occurrence_id,
    "candidate observation occurrence ID"
  )
  const provenanceGeneration = positiveInteger(
    databaseInteger(
      row.provenance_generation,
      "candidate observation provenance generation"
    ),
    "candidate observation provenance generation"
  )
  const provenanceFingerprint = normalizeBytes32(
    row.provenance_fingerprint,
    "candidate observation provenance fingerprint"
  )
  const walletID = normalizeBytes32(
    row.wallet_id,
    "candidate observation wallet ID"
  )
  const provenanceWalletID = normalizeBytes32(
    row.provenance_wallet_id,
    "candidate observation provenance wallet ID"
  )
  if (walletID !== provenanceWalletID) {
    throw new Error("Candidate observation wallet provenance is inconsistent")
  }
  const inputProvenance: CandidateEthereumProvenance = {
    inputIndex,
    fundingBlockHash: normalizeBytes32(
      row.funding_block_hash,
      "candidate observation funding block hash"
    ),
    fundingTxid: normalizeBytes32(
      row.funding_txid,
      "candidate observation funding transaction ID"
    ),
    fundingVout: uint32(
      row.funding_vout,
      "candidate observation funding output index"
    ),
    walletID,
    outputKey: normalizeBytes32(
      row.output_key,
      "candidate observation output key"
    ),
    bindingKind: candidateBindingKind(row.binding_kind),
    sourceEventID: boundedString(
      row.source_event_id,
      512,
      "candidate observation source event ID"
    ),
    ethereumBlockNumber: databaseInteger(
      row.ethereum_block_number,
      "candidate observation Ethereum block number"
    ),
    ethereumBlockHash: normalizeBytes32(
      row.ethereum_block_hash,
      "candidate observation Ethereum block hash"
    ),
  }
  const observation: P2TRCompleteV2CandidateObservation = {
    schema: "tbtc-p2tr-complete-candidate/v2",
    protocolID: normalizeBytes32(
      row.protocol_id,
      "candidate observation protocol ID"
    ),
    txid,
    wtxid,
    blockHeight: databaseInteger(
      row.block_height,
      "candidate observation block height"
    ),
    blockHash,
    inputIndex,
    evidence: {
      walletID,
      signingKey: normalizeBytes32(
        row.signing_key,
        "candidate observation signing key"
      ),
      bindingTxHash: normalizeBytes32(
        row.binding_tx_hash,
        "candidate observation binding transaction hash"
      ),
      bindingOutputIndex: uint32(
        row.binding_output_index,
        "candidate observation binding output index"
      ),
      sighashType: p2trSighashType(
        row.sighash_type,
        "candidate observation sighash type"
      ),
      sighash: normalizeBytes32(row.sighash, "candidate observation sighash"),
      nonceX: normalizeBytes32(
        row.nonce_x,
        "candidate observation nonce x-coordinate"
      ),
      signatureScalar: normalizeBytes32(
        row.signature_scalar,
        "candidate observation signature scalar"
      ),
    },
    occurrenceID,
    challengeIdentity,
    commitments: {
      rawTransactionDigest: normalizeBytes32(
        row.raw_transaction_digest,
        "candidate raw transaction digest"
      ),
      rawTransactionBytes: positiveInteger(
        databaseInteger(
          row.raw_transaction_bytes,
          "candidate raw transaction byte length"
        ),
        "candidate raw transaction byte length"
      ),
      witnessDigest: normalizeBytes32(
        row.witness_digest,
        "candidate observation witness digest"
      ),
      annexDigest: normalizeBytes32(
        row.annex_digest,
        "candidate observation annex digest"
      ),
      prevoutVectorRoot: normalizeBytes32(
        row.prevout_vector_root,
        "candidate prevout vector root"
      ),
      prevoutCount: positiveInteger(
        databaseInteger(row.prevout_count, "candidate prevout count"),
        "candidate prevout count"
      ),
      prevoutBytes: nonNegativeInteger(
        databaseInteger(row.prevout_bytes, "candidate prevout byte length"),
        "candidate prevout byte length"
      ),
      shaPrevouts: normalizeBytes32(row.sha_prevouts, "candidate sha_prevouts"),
      shaAmounts: normalizeBytes32(row.sha_amounts, "candidate sha_amounts"),
      shaScriptPubKeys: normalizeBytes32(
        row.sha_script_pubkeys,
        "candidate sha_scriptpubkeys"
      ),
      shaSequences: normalizeBytes32(
        row.sha_sequences,
        "candidate sha_sequences"
      ),
      shaOutputs: normalizeBytes32(row.sha_outputs, "candidate sha_outputs"),
      candidateBlockHeaderHash: normalizeBytes32(
        row.candidate_block_header_hash,
        "candidate block header hash"
      ),
      fundingBlockHeaderHash: normalizeBytes32(
        row.funding_block_header_hash,
        "candidate funding block header hash"
      ),
    },
    inputProvenance,
    provenanceGeneration,
    provenanceFingerprint,
  }
  if (
    calculateP2TRCanonicalOccurrenceID({
      domainDigest,
      provenanceGeneration,
      blockHash,
      txid,
      wtxid,
      inputIndex,
      provenanceFingerprint,
      challengeIdentity,
    }) !== occurrenceID
  ) {
    throw new Error("Candidate observation occurrence identity is inconsistent")
  }
  return observation
}

const canonicalGenerationIdentityFromRow = (
  row: CanonicalGenerationIdentityRow
): P2TRCanonicalGenerationIdentity => ({
  generationID: positiveInteger(
    databaseInteger(row.generation_id, "canonical generation ID"),
    "canonical generation ID"
  ),
  manifestDigest: normalizeBytes32(
    row.manifest_digest,
    "canonical generation manifest digest"
  ),
  domainDigest: normalizeBytes32(
    row.domain_digest,
    "canonical generation domain digest"
  ),
})

const normalizeCanonicalGenerationIdentity = (
  value: P2TRCanonicalGenerationIdentity
): P2TRCanonicalGenerationIdentity => ({
  generationID: positiveInteger(
    value.generationID,
    "candidate observation generation ID"
  ),
  manifestDigest: normalizeBytes32(
    value.manifestDigest,
    "candidate observation generation manifest digest"
  ),
  domainDigest: normalizeBytes32(
    value.domainDigest,
    "candidate observation generation domain digest"
  ),
})

const sameCanonicalGeneration = (
  left: P2TRCanonicalGenerationIdentity,
  right: P2TRCanonicalGenerationIdentity
): boolean => {
  const normalized = normalizeCanonicalGenerationIdentity(left)
  return (
    normalized.generationID === right.generationID &&
    normalized.manifestDigest === right.manifestDigest &&
    normalized.domainDigest === right.domainDigest
  )
}

const candidateObservationFromDispositionEvidence = (
  dispositionPayload: string,
  provenancePayload: string,
  candidatePayload: string,
  expectedDomainDigest: string
): P2TRCompleteV2CandidateObservation => {
  if (
    [dispositionPayload, provenancePayload, candidatePayload].some(
      (payload) => Buffer.byteLength(payload, "utf8") > 65_536
    )
  ) {
    throw new Error("Candidate generation evidence exceeds its object bound")
  }
  let dispositionParsed: unknown
  let provenanceParsed: unknown
  let candidateParsed: unknown
  try {
    dispositionParsed = JSON.parse(dispositionPayload)
    provenanceParsed = JSON.parse(provenancePayload)
    candidateParsed = JSON.parse(candidatePayload)
  } catch {
    throw new Error("Candidate generation evidence is not JSON")
  }
  const disposition = requireRecord(
    dispositionParsed,
    "candidate disposition evidence"
  )
  const provenance = requireRecord(
    provenanceParsed,
    "candidate provenance evidence"
  )
  const candidate = requireRecord(candidateParsed, "candidate evidence")
  for (const field of ["block_hash", "txid", "wtxid"] as const) {
    if (
      disposition[field] !== provenance[field] ||
      disposition[field] !== candidate[field]
    ) {
      throw new Error("Candidate generation evidence identity is inconsistent")
    }
  }
  if (
    disposition.input_index !== provenance.input_index ||
    disposition.provenance_generation !== provenance.provenance_generation ||
    disposition.provenance_generation !== candidate.provenance_generation ||
    disposition.provenance_fingerprint !== candidate.provenance_fingerprint ||
    disposition.disposition !== "keypath_pending" ||
    normalizeBytes32(
      String(disposition.protocol_id),
      "candidate protocol ID"
    ) !== P2TR_COMPLETE_V2_PROTOCOL_ID ||
    normalizeBytes32(
      String(disposition.domain_digest),
      "candidate authorization domain digest"
    ) !== expectedDomainDigest
  ) {
    throw new Error("Candidate generation evidence is inconsistent")
  }
  return candidateObservationFromRow({
    protocol_id: String(disposition.protocol_id),
    domain_digest: String(disposition.domain_digest),
    txid: String(disposition.txid),
    wtxid: String(disposition.wtxid),
    block_height: candidate.block_height as string | number,
    block_hash: String(disposition.block_hash),
    input_index: disposition.input_index as string | number,
    wallet_id: String(disposition.wallet_id),
    signing_key: String(disposition.signing_key),
    binding_tx_hash: String(disposition.binding_tx_hash),
    binding_output_index: disposition.binding_output_index as string | number,
    sighash_type: disposition.sighash_type as string | number,
    sighash: String(disposition.sighash),
    nonce_x: String(disposition.nonce_x),
    signature_scalar: String(disposition.signature_scalar),
    challenge_identity: String(disposition.challenge_identity),
    occurrence_id: String(disposition.occurrence_id),
    raw_transaction_digest: String(disposition.raw_transaction_digest),
    raw_transaction_bytes: disposition.raw_transaction_bytes as string | number,
    witness_digest: String(disposition.witness_digest),
    annex_digest: String(disposition.annex_digest),
    prevout_vector_root: String(disposition.prevout_vector_root),
    prevout_count: disposition.prevout_count as string | number,
    prevout_bytes: disposition.prevout_bytes as string | number,
    sha_prevouts: String(disposition.sha_prevouts),
    sha_amounts: String(disposition.sha_amounts),
    sha_script_pubkeys: String(disposition.sha_script_pubkeys),
    sha_sequences: String(disposition.sha_sequences),
    sha_outputs: String(disposition.sha_outputs),
    candidate_block_header_hash: String(
      disposition.candidate_block_header_hash
    ),
    funding_block_header_hash: String(disposition.funding_block_header_hash),
    provenance_generation: disposition.provenance_generation as string | number,
    provenance_fingerprint: String(disposition.provenance_fingerprint),
    funding_block_hash: String(provenance.funding_block_hash),
    funding_txid: String(provenance.funding_txid),
    funding_vout: provenance.funding_vout as string | number,
    provenance_wallet_id: String(provenance.wallet_id),
    output_key: String(provenance.output_key),
    binding_kind: String(provenance.binding_kind),
    source_event_id: String(provenance.source_event_id),
    ethereum_block_number: provenance.ethereum_block_number as string | number,
    ethereum_block_hash: String(provenance.ethereum_block_hash),
  })
}

const encodeCandidateObservationPageCursor = (
  value: CandidateObservationPagePosition & {
    generation: P2TRCanonicalGenerationIdentity
    atOrBelowHeight: number
  }
): string => {
  const bytes = Buffer.from(
    canonicalJSON({
      schema: "tbtc-p2tr-candidate-observation-cursor/v1",
      generation: normalizeCanonicalGenerationIdentity(value.generation),
      atOrBelowHeight: nonNegativeInteger(
        value.atOrBelowHeight,
        "candidate observation cursor maximum height"
      ),
      blockHeight: nonNegativeInteger(
        value.blockHeight,
        "candidate observation cursor block height"
      ),
      blockHash: normalizeBytes32(
        value.blockHash,
        "candidate observation cursor block hash"
      ),
      txid: normalizeBytes32(
        value.txid,
        "candidate observation cursor transaction ID"
      ),
      wtxid: normalizeBytes32(
        value.wtxid,
        "candidate observation cursor witness transaction ID"
      ),
      inputIndex: uint32(
        value.inputIndex,
        "candidate observation cursor input index"
      ),
    }),
    "utf8"
  )
  const checksum = createHash("sha256")
    .update("tbtc-p2tr-candidate-observation-cursor-checksum-v1", "utf8")
    .update(bytes)
    .digest("hex")
  return `${bytes.toString("base64url")}.${checksum}`
}

const decodeCandidateObservationPageCursor = (
  token: string,
  expected: {
    generation: P2TRCanonicalGenerationIdentity
    atOrBelowHeight: number
  }
): CandidateObservationPagePosition => {
  const normalizedToken = boundedString(
    token,
    2048,
    "candidate observation page cursor"
  )
  const parts = normalizedToken.split(".")
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) {
    throw new Error("Candidate observation page cursor is malformed")
  }
  const bytes = Buffer.from(parts[0], "base64url")
  if (bytes.toString("base64url") !== parts[0]) {
    throw new Error("Candidate observation page cursor is not canonical")
  }
  const checksum = normalizeBytes32(
    parts[1],
    "candidate observation page cursor checksum"
  )
  const calculated = createHash("sha256")
    .update("tbtc-p2tr-candidate-observation-cursor-checksum-v1", "utf8")
    .update(bytes)
    .digest("hex")
  if (checksum !== calculated) {
    throw new Error("Candidate observation page cursor checksum is invalid")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("Candidate observation page cursor is not JSON")
  }
  if (canonicalJSON(parsed) !== bytes.toString("utf8")) {
    throw new Error(
      "Candidate observation page cursor encoding is not canonical"
    )
  }
  const value = requireRecord(parsed, "candidate observation page cursor")
  const generationValue = requireRecord(
    value.generation,
    "candidate observation page cursor generation"
  )
  const generation = normalizeCanonicalGenerationIdentity({
    generationID: generationValue.generationID as number,
    manifestDigest: String(generationValue.manifestDigest),
    domainDigest: String(generationValue.domainDigest),
  })
  const atOrBelowHeight = nonNegativeInteger(
    value.atOrBelowHeight as number,
    "candidate observation page cursor maximum height"
  )
  if (
    value.schema !== "tbtc-p2tr-candidate-observation-cursor/v1" ||
    !sameCanonicalGeneration(generation, expected.generation) ||
    atOrBelowHeight !== expected.atOrBelowHeight
  ) {
    throw new Error("Candidate observation page cursor scope is stale")
  }
  return {
    blockHeight: nonNegativeInteger(
      value.blockHeight as number,
      "candidate observation page cursor block height"
    ),
    blockHash: normalizeBytes32(
      String(value.blockHash),
      "candidate observation page cursor block hash"
    ),
    txid: normalizeBytes32(
      String(value.txid),
      "candidate observation page cursor transaction ID"
    ),
    wtxid: normalizeBytes32(
      String(value.wtxid),
      "candidate observation page cursor witness transaction ID"
    ),
    inputIndex: uint32(
      value.inputIndex,
      "candidate observation page cursor input index"
    ),
  }
}

const invalidatedProvenanceFromRow = (
  row: InvalidatedProvenanceRow
): P2TRInvalidatedCandidateProvenance => {
  if (
    row.reason !== "ethereum-reorg" &&
    row.reason !== "provenance-superseded"
  ) {
    throw new Error("Candidate provenance invalidation reason is invalid")
  }
  const sourceEventIDs = requireArray(
    row.source_event_ids,
    "candidate invalidation source events"
  ).map((value) => boundedString(String(value), 512, "source event ID"))
  if (
    sourceEventIDs.some(
      (eventID, index) => sourceEventIDs.indexOf(eventID) !== index
    ) ||
    sourceEventIDs.some(
      (eventID, index) => index > 0 && sourceEventIDs[index - 1] >= eventID
    )
  ) {
    throw new Error("Candidate invalidation source events are not canonical")
  }
  return {
    ...candidateProvenanceIdentityFromRow(row),
    invalidationID: positiveInteger(
      databaseInteger(row.invalidation_id, "candidate invalidation ID"),
      "candidate invalidation ID"
    ),
    reason: row.reason,
    sourceEventIDs,
    ...(row.successor_fingerprint === null
      ? {}
      : {
          successorFingerprint: normalizeBytes32(
            row.successor_fingerprint,
            "candidate successor fingerprint"
          ),
        }),
  }
}

const candidateBindingKind = (value: string): "wallet" | "deposit" => {
  if (value !== "wallet" && value !== "deposit") {
    throw new Error("Candidate provenance binding kind is invalid")
  }
  return value
}

const sameTrackedOutpoint = (
  left: P2TRTrackedOutpoint,
  right: P2TRTrackedOutpoint
): boolean =>
  left.txid === right.txid &&
  left.vout === right.vout &&
  left.kind === right.kind &&
  left.walletID === right.walletID &&
  left.outputKey === right.outputKey &&
  left.valueSats === right.valueSats &&
  left.scriptPubKey === right.scriptPubKey &&
  samePoint(left.createdAt, right.createdAt)

const requireArray = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value
}

const requireRecord = (
  value: unknown,
  field: string
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

const canonicalJSON = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (typeof input === "object" && input !== null) {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)])
      )
    }
    return input
  }
  return JSON.stringify(normalize(value)) ?? "undefined"
}

const normalizeReadinessExportStreamCursor = (
  value: P2TRReadinessExportStreamCursor | undefined
): P2TRReadinessExportStreamCursor | undefined =>
  value === undefined
    ? undefined
    : {
        streamOrdinal: nonNegativeInteger(
          value.streamOrdinal,
          "readiness export stream ordinal"
        ),
        chunkIndex: nonNegativeInteger(
          value.chunkIndex,
          "readiness export chunk index"
        ),
      }

const readinessExportID = (
  exportFence: number,
  requestDigest: string,
  generationManifestDigest: string
): string =>
  createHash("sha256")
    .update("tbtc-p2tr-readiness-export-id-v1", "utf8")
    .update(int64BE(exportFence, "readiness export fence"))
    .update(hexBuffer(requestDigest, "readiness export request digest"))
    .update(
      hexBuffer(
        generationManifestDigest,
        "readiness export generation manifest digest"
      )
    )
    .digest("hex")

const readinessExportStreamFrameFromRow = (
  exportID: string,
  exportFence: number,
  row: ReadinessExportStreamRow
): P2TRReadinessExportStreamFrame => {
  const streamOrdinal = nonNegativeInteger(
    databaseInteger(row.stream_ordinal, "readiness stream ordinal"),
    "readiness stream ordinal"
  )
  const byteLength = nonNegativeInteger(
    databaseInteger(row.byte_length, "readiness object byte length"),
    "readiness object byte length"
  )
  const chunkCount = positiveInteger(
    databaseInteger(row.chunk_count, "readiness object chunk count"),
    "readiness object chunk count"
  )
  const chunkIndex = nonNegativeInteger(
    databaseInteger(row.chunk_index, "readiness chunk index"),
    "readiness chunk index"
  )
  const byteOffset = nonNegativeInteger(
    databaseInteger(row.byte_offset, "readiness chunk byte offset"),
    "readiness chunk byte offset"
  )
  const expectedChunkLength = Math.min(
    P2TR_EVIDENCE_CHUNK_MAX_BYTES,
    byteLength - byteOffset
  )
  if (
    byteLength > 4_000_000 ||
    chunkCount > 64 ||
    chunkIndex >= chunkCount ||
    row.chunk_bytes.length > P2TR_EVIDENCE_CHUNK_MAX_BYTES ||
    byteOffset !== chunkIndex * P2TR_EVIDENCE_CHUNK_MAX_BYTES ||
    expectedChunkLength < 0 ||
    row.chunk_bytes.length !== expectedChunkLength
  ) {
    throw new Error("Readiness export stream frame exceeds its bounds")
  }
  const objectDigest = normalizeBytes32(
    row.object_digest,
    "readiness stream object digest"
  )
  const chunkDigest = normalizeBytes32(
    row.chunk_digest,
    "readiness stream chunk digest"
  )
  const calculatedChunkDigest = calculateP2TREvidenceChunkDigest(
    row.chunk_bytes
  )
  const calculatedLeafDigest = calculateP2TREvidenceChunkLeafDigest({
    chunkIndex,
    byteOffset,
    chunkDigest,
  })
  const chunkLeafDigest = normalizeBytes32(
    row.chunk_leaf_digest,
    "readiness stream chunk leaf digest"
  )
  if (
    calculatedChunkDigest !== chunkDigest ||
    calculatedLeafDigest !== chunkLeafDigest
  ) {
    throw new Error("Readiness export stream chunk is corrupt")
  }
  const objectKind = normalizeEvidenceObjectKind(row.object_kind)
  const contentDigest = normalizeBytes32(
    row.content_digest,
    "readiness object content digest"
  )
  const chunkManifestRoot = normalizeBytes32(
    row.chunk_manifest_root,
    "readiness object chunk manifest root"
  )
  if (
    calculateP2TREvidenceObjectDigest({
      kind: objectKind,
      byteLength,
      chunkCount,
      contentDigest,
      chunkManifestRoot,
    }) !== objectDigest
  ) {
    throw new Error("Readiness export object metadata is corrupt")
  }
  const streamLeafDigest = normalizeBytes32(
    row.stream_leaf_digest,
    "readiness stream leaf digest"
  )
  if (
    calculateP2TRReadinessExportStreamLeafDigest({
      exportFence,
      streamOrdinal,
      objectDigest,
      objectKind,
      byteLength,
      contentDigest,
      chunkManifestRoot,
    }) !== streamLeafDigest
  ) {
    throw new Error("Readiness export stream leaf is corrupt")
  }
  return {
    schema: "tbtc-p2tr-readiness-export-stream-frame/v1",
    exportID: normalizeBytes32(exportID, "readiness export ID"),
    exportFence: positiveInteger(exportFence, "readiness export fence"),
    streamOrdinal,
    streamLeafDigest,
    object: {
      digest: objectDigest,
      kind: objectKind,
      byteLength,
      contentDigest,
      chunkCount,
      chunkManifestRoot,
    },
    chunk: {
      index: chunkIndex,
      byteOffset,
      digest: chunkDigest,
      leafDigest: chunkLeafDigest,
      bytes: Uint8Array.from(row.chunk_bytes),
    },
  }
}

const normalizeOpaqueSignature = (value: string, field: string): string => {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9a-f]{2})+$/.test(value) ||
    value.length > 8192
  ) {
    throw new Error(`${field} must be 1..4096 lower-case hex bytes`)
  }
  return value
}

const normalizeReadinessExportAcknowledgement = (
  value: P2TRReadinessExportAcknowledgement
): P2TRReadinessExportAcknowledgement => {
  if (value.schema !== "tbtc-p2tr-readiness-export-acknowledgement/v1") {
    throw new Error("Readiness export acknowledgement schema is invalid")
  }
  return {
    schema: value.schema,
    requestNonce: normalizeBytes32(
      value.requestNonce,
      "readiness export nonce"
    ),
    requestDigest: normalizeBytes32(
      value.requestDigest,
      "readiness export request digest"
    ),
    exportFence: positiveInteger(value.exportFence, "readiness export fence"),
    snapshotRoot: normalizeBytes32(
      value.snapshotRoot,
      "readiness snapshot root"
    ),
    resultDigest: normalizeBytes32(
      value.resultDigest,
      "readiness result digest"
    ),
    consumerID: boundedString(value.consumerID, 255, "readiness consumer ID"),
    auditManifestRoot: normalizeBytes32(
      value.auditManifestRoot,
      "readiness audit manifest root"
    ),
    finalStreamDigest: normalizeBytes32(
      value.finalStreamDigest,
      "readiness final stream digest"
    ),
    streamedObjectCount: positiveInteger(
      value.streamedObjectCount,
      "readiness streamed object count"
    ),
    streamedBytes: nonNegativeInteger(
      value.streamedBytes,
      "readiness streamed byte count"
    ),
    consumerSigningKeyID: boundedString(
      value.consumerSigningKeyID,
      255,
      "readiness consumer signing key ID"
    ),
    consumerSignaturePayloadDigest: normalizeBytes32(
      value.consumerSignaturePayloadDigest,
      "readiness consumer signature payload digest"
    ),
    consumerSignature: normalizeOpaqueSignature(
      value.consumerSignature,
      "readiness consumer signature"
    ),
  }
}

const normalizeReadinessExportRequest = (
  value: P2TRReadinessExportRequest
): P2TRReadinessExportRequest => {
  if (value.schema !== "tbtc-p2tr-readiness-export-request/v1") {
    throw new Error("Readiness export request schema is invalid")
  }
  const parsedExpiry = new Date(value.expiresAt)
  if (
    !Number.isFinite(parsedExpiry.getTime()) ||
    parsedExpiry.toISOString() !== value.expiresAt
  ) {
    throw new Error("Readiness export expiry must be canonical ISO-8601")
  }
  return {
    schema: value.schema,
    requestNonce: normalizeBytes32(
      value.requestNonce,
      "readiness export nonce"
    ),
    manifestHash: normalizeBytes32(
      value.manifestHash,
      "readiness export request manifest hash"
    ),
    expiresAt: value.expiresAt,
    ...(value.candidate === undefined
      ? {}
      : {
          candidate: {
            txid: normalizeBytes32(
              value.candidate.txid,
              "readiness candidate transaction ID"
            ),
            wtxid: normalizeBytes32(
              value.candidate.wtxid,
              "readiness candidate witness transaction ID"
            ),
            blockHeight: nonNegativeInteger(
              value.candidate.blockHeight,
              "readiness candidate block height"
            ),
            blockHash: normalizeBytes32(
              value.candidate.blockHash,
              "readiness candidate block hash"
            ),
            inputIndex: uint32(
              value.candidate.inputIndex,
              "readiness candidate input index"
            ),
            observationID: normalizeBytes32(
              value.candidate.observationID,
              "readiness candidate observation ID"
            ),
            challengeKey: normalizeBytes32(
              value.candidate.challengeKey,
              "readiness candidate challenge key"
            ),
            expectedProvenanceFingerprint: normalizeBytes32(
              value.candidate.expectedProvenanceFingerprint,
              "readiness candidate provenance fingerprint"
            ),
          },
        }),
  }
}

const normalizeReadinessExportAuditRow = (
  row: ReadinessExportAuditRow
): {
  manifestRoot: string
  streamDigest: string
  objectCount: number
  totalBytes: number
} => ({
  manifestRoot: normalizeBytes32(
    row.audit_manifest_root,
    "readiness audit manifest root"
  ),
  streamDigest: normalizeBytes32(
    row.audit_stream_digest,
    "readiness audit stream digest"
  ),
  objectCount: positiveInteger(
    databaseInteger(row.audit_object_count, "readiness audit object count"),
    "readiness audit object count"
  ),
  totalBytes: nonNegativeInteger(
    databaseInteger(row.audit_total_bytes, "readiness audit total bytes"),
    "readiness audit total bytes"
  ),
})

const readinessExportHandleFromRow = (
  row: ReadinessExportRow
): P2TRReadinessExportHandle => {
  const payload = requireRecord(row.result_payload, "readiness export result")
  if (payload.schema !== "tbtc-p2tr-readiness-export-result/v1") {
    throw new Error("Readiness export result schema is invalid")
  }
  const snapshot = requireRecord(
    payload.snapshot,
    "readiness export snapshot"
  ) as unknown as P2TRReadinessSnapshot
  const resultDigest = normalizeBytes32(
    row.result_digest,
    "readiness export result digest"
  )
  const snapshotRoot = normalizeBytes32(
    row.snapshot_root,
    "readiness export snapshot root"
  )
  const snapshotSemanticRoot = normalizeBytes32(
    row.snapshot_semantic_root,
    "readiness export snapshot semantic root"
  )
  const snapshotGeneration = nonNegativeInteger(
    databaseInteger(row.snapshot_generation, "readiness snapshot generation"),
    "readiness snapshot generation"
  )
  if (
    readinessRoot(payload) !== resultDigest ||
    snapshot.root !== snapshotRoot ||
    snapshot.semanticRoot !== snapshotSemanticRoot ||
    snapshot.generation !== snapshotGeneration ||
    calculateP2TRReadinessSnapshotRoot(snapshot) !== snapshotRoot
  ) {
    throw new Error("Readiness export result does not match its sealed roots")
  }
  const audit = normalizeReadinessExportAuditRow(row)
  const exportFence = positiveInteger(
    databaseInteger(row.export_fence, "readiness export fence"),
    "readiness export fence"
  )
  const requestDigest = normalizeBytes32(
    row.request_digest,
    "readiness export request digest"
  )
  const request = normalizeReadinessExportRequest(
    requireRecord(
      row.canonical_request,
      "readiness export request"
    ) as unknown as P2TRReadinessExportRequest
  )
  if (
    readinessRoot(request) !== requestDigest ||
    request.requestNonce !==
      normalizeBytes32(row.request_nonce, "readiness export nonce")
  ) {
    throw new Error("Readiness export request ledger is inconsistent")
  }
  const generationManifestDigest = normalizeBytes32(
    row.generation_manifest_digest,
    "readiness generation manifest digest"
  )
  const candidate =
    payload.candidate === undefined
      ? undefined
      : (requireRecord(
          payload.candidate,
          "readiness export candidate"
        ) as unknown as P2TRReadinessExportHandle["candidate"])
  return {
    schema: "tbtc-p2tr-readiness-export-handle/v1",
    exportID: readinessExportID(
      exportFence,
      requestDigest,
      generationManifestDigest
    ),
    requestNonce: normalizeBytes32(row.request_nonce, "readiness export nonce"),
    request,
    requestDigest,
    exportFence,
    snapshotRoot,
    snapshotSemanticRoot,
    snapshotGeneration,
    resultDigest,
    ...(candidate === undefined ? {} : { candidate }),
    snapshot,
    authorizationDomain: snapshot.authorizationDomain,
    sourceIdentity: {
      storeID: boundedString(row.source_store_id, 255, "source store ID"),
      clusterID: boundedString(row.source_cluster_id, 255, "source cluster ID"),
      operatorID: boundedString(
        row.source_operator_id,
        255,
        "source operator ID"
      ),
      trustDomainID: boundedString(
        row.source_trust_domain_id,
        255,
        "source trust domain ID"
      ),
      bitcoinIdentityDigest: normalizeBytes32(
        row.source_bitcoin_identity_digest,
        "source Bitcoin identity digest"
      ),
      ethereumIdentityDigest: normalizeBytes32(
        row.source_ethereum_identity_digest,
        "source Ethereum identity digest"
      ),
      identityDigest: normalizeBytes32(
        row.source_identity_digest,
        "source identity digest"
      ),
      configurationFingerprint: normalizeBytes32(
        row.source_configuration_fingerprint,
        "source configuration fingerprint"
      ),
    },
    contentManifest: {
      schema: "tbtc-p2tr-readiness-export-content/v2",
      exportID: readinessExportID(
        exportFence,
        requestDigest,
        generationManifestDigest
      ),
      generation: {
        generationID: positiveInteger(
          databaseInteger(row.pinned_generation, "pinned generation ID"),
          "pinned generation ID"
        ),
        manifestDigest: generationManifestDigest,
        domainDigest: normalizeBytes32(
          row.domain_digest,
          "pinned generation domain digest"
        ),
      },
      auditManifestRoot: audit.manifestRoot,
      finalStreamDigest: audit.streamDigest,
      resultDigest,
      objectCount: audit.objectCount,
      totalBytes: audit.totalBytes,
      maxChunkBytes: P2TR_EVIDENCE_CHUNK_MAX_BYTES,
      sourceSignature: {
        signingKeyID: boundedString(
          row.source_signing_key_id,
          255,
          "readiness source signing key ID"
        ),
        payloadDigest: normalizeBytes32(
          row.source_signature_payload_digest,
          "readiness source signature payload digest"
        ),
        signature: normalizeOpaqueSignature(
          row.source_signature,
          "readiness source signature"
        ),
      },
    },
  }
}

const assertGenerationMatchesSnapshot = (
  row: CanonicalGenerationExportRow,
  snapshot: P2TRReadinessSnapshot
): void => {
  if (
    normalizeBytes32(row.domain_digest, "generation domain digest") !==
      snapshot.authorizationDomain.domainDigest ||
    databaseInteger(row.bitcoin_height, "generation Bitcoin height") !==
      snapshot.bitcoin.current.height ||
    normalizeBytes32(row.bitcoin_hash, "generation Bitcoin hash") !==
      snapshot.bitcoin.current.hash ||
    normalizeBytes32(
      row.bitcoin_chain_root,
      "generation Bitcoin chain root"
    ) !== snapshot.bitcoin.chainCommitment ||
    normalizeBytes32(row.projection_root, "generation projection root") !==
      snapshot.projection.commitment ||
    normalizeBytes32(row.semantic_root, "generation semantic root") !==
      snapshot.projection.semanticCommitment
  ) {
    throw new Error(
      "Latest canonical generation does not match readiness state"
    )
  }
}

export const calculateP2TRReadinessExportConsumerSignaturePayloadDigest = (
  value: P2TRReadinessExportAcknowledgement
): string =>
  createHash("sha256")
    .update(
      `tbtc-p2tr-readiness-acknowledgement-signature-v1\x1f${value.consumerID}\x1f${value.consumerSigningKeyID}`,
      "utf8"
    )
    .update(int64BE(value.exportFence, "readiness acknowledgement fence"))
    .update(hexBuffer(value.requestDigest, "readiness request digest"))
    .update(hexBuffer(value.snapshotRoot, "readiness snapshot root"))
    .update(hexBuffer(value.resultDigest, "readiness result digest"))
    .update(hexBuffer(value.auditManifestRoot, "readiness manifest root"))
    .update(hexBuffer(value.finalStreamDigest, "readiness stream digest"))
    .update(
      int64BE(value.streamedObjectCount, "readiness streamed object count")
    )
    .update(int64BE(value.streamedBytes, "readiness streamed byte count"))
    .digest("hex")

/** Recomputes the content address of one bounded evidence chunk. */
export const calculateP2TREvidenceChunkDigest = (bytes: Uint8Array): string => {
  const normalized = Buffer.from(bytes)
  if (normalized.length > P2TR_EVIDENCE_CHUNK_MAX_BYTES) {
    throw new Error("Evidence chunk exceeds 64 KiB")
  }
  return createHash("sha256")
    .update("tbtc-p2tr-evidence-chunk-v1", "utf8")
    .update(normalized)
    .digest("hex")
}

/** Recomputes the ordered leaf committed by an evidence object manifest. */
export const calculateP2TREvidenceChunkLeafDigest = (value: {
  chunkIndex: number
  byteOffset: number
  chunkDigest: string
}): string =>
  createHash("sha256")
    .update("tbtc-p2tr-evidence-chunk-leaf-v1", "utf8")
    .update(int32BE(value.chunkIndex, "evidence chunk index"))
    .update(int64BE(value.byteOffset, "evidence chunk byte offset"))
    .update(hexBuffer(value.chunkDigest, "evidence chunk digest"))
    .digest("hex")

/** Recomputes the SHA-256 content digest of one bounded evidence object. */
export const calculateP2TREvidenceContentDigest = (
  bytes: Uint8Array
): string => {
  const normalized = Buffer.from(bytes)
  if (normalized.length > 4_000_000) {
    throw new Error("Evidence object exceeds the four-megabyte bound")
  }
  return createHash("sha256").update(normalized).digest("hex")
}

/** Recomputes the root over one object's ordered chunk-leaf digests. */
export const calculateP2TREvidenceChunkManifestRoot = (
  chunkLeafDigests: readonly string[]
): string => {
  if (chunkLeafDigests.length < 1 || chunkLeafDigests.length > 64) {
    throw new Error(
      "Evidence chunk manifest must contain between 1 and 64 leaves"
    )
  }
  return createHash("sha256")
    .update(
      Buffer.concat(
        chunkLeafDigests.map((digest) =>
          hexBuffer(digest, "evidence chunk leaf digest")
        )
      )
    )
    .digest("hex")
}

/** Recomputes the immutable evidence-object identity from its full metadata. */
export const calculateP2TREvidenceObjectDigest = (value: {
  kind: string
  byteLength: number
  chunkCount: number
  contentDigest: string
  chunkManifestRoot: string
}): string => {
  const kind = normalizeEvidenceObjectKind(value.kind)
  const byteLength = nonNegativeInteger(
    value.byteLength,
    "evidence object byte length"
  )
  const chunkCount = positiveInteger(
    value.chunkCount,
    "evidence object chunk count"
  )
  if (
    byteLength > 4_000_000 ||
    chunkCount > 64 ||
    chunkCount !==
      Math.max(1, Math.ceil(byteLength / P2TR_EVIDENCE_CHUNK_MAX_BYTES))
  ) {
    throw new Error("Evidence object metadata exceeds its canonical bounds")
  }
  return createHash("sha256")
    .update(
      `tbtc-p2tr-evidence-object-v1\x1f${kind}\x1f${byteLength}\x1f${chunkCount}`,
      "utf8"
    )
    .update(hexBuffer(value.contentDigest, "evidence content digest"))
    .update(hexBuffer(value.chunkManifestRoot, "evidence chunk manifest root"))
    .digest("hex")
}

/** Recomputes an export inventory leaf for one immutable evidence object. */
export const calculateP2TRReadinessExportStreamLeafDigest = (value: {
  exportFence: number
  streamOrdinal: number
  objectDigest: string
  objectKind: string
  byteLength: number
  contentDigest: string
  chunkManifestRoot: string
}): string => {
  const objectKind = normalizeEvidenceObjectKind(value.objectKind)
  const byteLength = nonNegativeInteger(
    value.byteLength,
    "readiness object byte length"
  )
  if (byteLength > 4_000_000) {
    throw new Error("Readiness object exceeds the four-megabyte bound")
  }
  return createHash("sha256")
    .update(`tbtc-p2tr-readiness-export-object-v1\x1f${objectKind}`, "utf8")
    .update(int64BE(value.exportFence, "readiness export fence"))
    .update(int64BE(value.streamOrdinal, "readiness stream ordinal"))
    .update(hexBuffer(value.objectDigest, "readiness object digest"))
    .update(int64BE(byteLength, "readiness object byte length"))
    .update(hexBuffer(value.contentDigest, "readiness content digest"))
    .update(hexBuffer(value.chunkManifestRoot, "readiness chunk manifest root"))
    .digest("hex")
}

/** Initial root for folding the signed, ordered export object inventory. */
export const calculateP2TRReadinessAuditManifestSeed = (): string =>
  createHash("sha256")
    .update("tbtc-p2tr-readiness-export-manifest-v1", "utf8")
    .digest("hex")

/** Folds one ordered export object leaf into the audit manifest root. */
export const foldP2TRReadinessAuditManifestObject = (
  previousRoot: string,
  streamLeafDigest: string
): string =>
  createHash("sha256")
    .update(hexBuffer(previousRoot, "readiness audit manifest root"))
    .update(hexBuffer(streamLeafDigest, "readiness stream leaf digest"))
    .digest("hex")

export const calculateP2TRReadinessAuditStreamSeed = (): string =>
  createHash("sha256")
    .update("tbtc-p2tr-readiness-audit-stream-v1", "utf8")
    .digest("hex")

export const foldP2TRReadinessAuditStreamObject = (
  previousDigest: string,
  value: {
    streamOrdinal: number
    objectDigest: string
    chunkCount: number
    streamLeafDigest: string
  }
): string => {
  const frameDigest = createHash("sha256")
    .update("tbtc-p2tr-readiness-object-frame-v1", "utf8")
    .update(int64BE(value.streamOrdinal, "readiness stream ordinal"))
    .update(hexBuffer(value.objectDigest, "readiness object digest"))
    .update(int32BE(value.chunkCount, "readiness object chunk count"))
    .update(hexBuffer(value.streamLeafDigest, "readiness stream leaf digest"))
    .digest()
  return createHash("sha256")
    .update(hexBuffer(previousDigest, "readiness stream digest"))
    .update(frameDigest)
    .digest("hex")
}

export const foldP2TRReadinessAuditStreamChunk = (
  previousDigest: string,
  value: {
    streamOrdinal: number
    chunkIndex: number
    byteOffset: number
    objectDigest: string
    chunkDigest: string
    bytes: Uint8Array
  }
): string => {
  const bytes = Buffer.from(value.bytes)
  if (bytes.length > P2TR_EVIDENCE_CHUNK_MAX_BYTES) {
    throw new Error("Readiness stream chunk exceeds 64 KiB")
  }
  const frameDigest = createHash("sha256")
    .update("tbtc-p2tr-readiness-chunk-frame-v1", "utf8")
    .update(int64BE(value.streamOrdinal, "readiness stream ordinal"))
    .update(int32BE(value.chunkIndex, "readiness chunk index"))
    .update(int64BE(value.byteOffset, "readiness chunk byte offset"))
    .update(hexBuffer(value.objectDigest, "readiness object digest"))
    .update(hexBuffer(value.chunkDigest, "readiness chunk digest"))
    .update(int32BE(bytes.length, "readiness chunk byte length"))
    .update(bytes)
    .digest()
  return createHash("sha256")
    .update(hexBuffer(previousDigest, "readiness stream digest"))
    .update(frameDigest)
    .digest("hex")
}

/**
 * Verifies every frame for one object without retaining more than the
 * protocol-bounded 64 leaf digests and an incremental SHA-256 context.
 */
export const verifyP2TRReadinessExportObjectFrames = (
  frames: readonly P2TRReadinessExportStreamFrame[]
): {
  exportID: string
  exportFence: number
  streamOrdinal: number
  objectDigest: string
  contentDigest: string
  chunkManifestRoot: string
  streamLeafDigest: string
  byteLength: number
  chunkCount: number
} => {
  if (frames.length < 1 || frames.length > 64) {
    throw new Error("Readiness object verification requires 1 to 64 frames")
  }
  const first = frames[0]
  const exportID = normalizeBytes32(first.exportID, "readiness export ID")
  const exportFence = positiveInteger(
    first.exportFence,
    "readiness export fence"
  )
  const streamOrdinal = nonNegativeInteger(
    first.streamOrdinal,
    "readiness stream ordinal"
  )
  const objectDigest = normalizeBytes32(
    first.object.digest,
    "readiness object digest"
  )
  const objectKind = normalizeEvidenceObjectKind(first.object.kind)
  const byteLength = nonNegativeInteger(
    first.object.byteLength,
    "readiness object byte length"
  )
  const contentDigest = normalizeBytes32(
    first.object.contentDigest,
    "readiness object content digest"
  )
  const chunkCount = positiveInteger(
    first.object.chunkCount,
    "readiness object chunk count"
  )
  const chunkManifestRoot = normalizeBytes32(
    first.object.chunkManifestRoot,
    "readiness object chunk manifest root"
  )
  const streamLeafDigest = normalizeBytes32(
    first.streamLeafDigest,
    "readiness stream leaf digest"
  )
  if (
    byteLength > 4_000_000 ||
    chunkCount > 64 ||
    chunkCount !== frames.length ||
    chunkCount !==
      Math.max(1, Math.ceil(byteLength / P2TR_EVIDENCE_CHUNK_MAX_BYTES))
  ) {
    throw new Error("Readiness object frame cardinality is inconsistent")
  }

  const contentHasher = createHash("sha256")
  const leafDigests: string[] = []
  frames.forEach((frame, index) => {
    if (
      frame.schema !== "tbtc-p2tr-readiness-export-stream-frame/v1" ||
      normalizeBytes32(frame.exportID, "readiness export ID") !== exportID ||
      positiveInteger(frame.exportFence, "readiness export fence") !==
        exportFence ||
      nonNegativeInteger(frame.streamOrdinal, "readiness stream ordinal") !==
        streamOrdinal ||
      normalizeBytes32(frame.object.digest, "readiness object digest") !==
        objectDigest ||
      normalizeEvidenceObjectKind(frame.object.kind) !== objectKind ||
      nonNegativeInteger(
        frame.object.byteLength,
        "readiness object byte length"
      ) !== byteLength ||
      normalizeBytes32(
        frame.object.contentDigest,
        "readiness object content digest"
      ) !== contentDigest ||
      positiveInteger(
        frame.object.chunkCount,
        "readiness object chunk count"
      ) !== chunkCount ||
      normalizeBytes32(
        frame.object.chunkManifestRoot,
        "readiness object chunk manifest root"
      ) !== chunkManifestRoot ||
      normalizeBytes32(
        frame.streamLeafDigest,
        "readiness stream leaf digest"
      ) !== streamLeafDigest
    ) {
      throw new Error("Readiness object frame metadata is inconsistent")
    }
    const bytes = Buffer.from(frame.chunk.bytes)
    const byteOffset = index * P2TR_EVIDENCE_CHUNK_MAX_BYTES
    const expectedLength = Math.min(
      P2TR_EVIDENCE_CHUNK_MAX_BYTES,
      byteLength - byteOffset
    )
    const chunkDigest = calculateP2TREvidenceChunkDigest(bytes)
    const chunkLeafDigest = calculateP2TREvidenceChunkLeafDigest({
      chunkIndex: index,
      byteOffset,
      chunkDigest,
    })
    if (
      nonNegativeInteger(frame.chunk.index, "readiness chunk index") !==
        index ||
      nonNegativeInteger(
        frame.chunk.byteOffset,
        "readiness chunk byte offset"
      ) !== byteOffset ||
      bytes.length !== expectedLength ||
      normalizeBytes32(frame.chunk.digest, "readiness chunk digest") !==
        chunkDigest ||
      normalizeBytes32(
        frame.chunk.leafDigest,
        "readiness chunk leaf digest"
      ) !== chunkLeafDigest
    ) {
      throw new Error("Readiness object chunk frame is inconsistent")
    }
    contentHasher.update(bytes)
    leafDigests.push(chunkLeafDigest)
  })

  if (
    contentHasher.digest("hex") !== contentDigest ||
    calculateP2TREvidenceChunkManifestRoot(leafDigests) !== chunkManifestRoot ||
    calculateP2TREvidenceObjectDigest({
      kind: objectKind,
      byteLength,
      chunkCount,
      contentDigest,
      chunkManifestRoot,
    }) !== objectDigest ||
    calculateP2TRReadinessExportStreamLeafDigest({
      exportFence,
      streamOrdinal,
      objectDigest,
      objectKind,
      byteLength,
      contentDigest,
      chunkManifestRoot,
    }) !== streamLeafDigest
  ) {
    throw new Error("Readiness object digest chain is inconsistent")
  }
  return {
    exportID,
    exportFence,
    streamOrdinal,
    objectDigest,
    contentDigest,
    chunkManifestRoot,
    streamLeafDigest,
    byteLength,
    chunkCount,
  }
}

type ReadinessExportSourceSignaturePayloadFields = {
  exportFence: number
  requestDigest: string
  generation: P2TRCanonicalGenerationIdentity
  sourceIdentityDigest: string
  sourceSigningKeyID: string
  snapshotRoot: string
  snapshotSemanticRoot: string
  snapshotGeneration: number
  resultDigest: string
  auditManifestRoot: string
  finalStreamDigest: string
  objectCount: number
  totalBytes: number
  maxChunkBytes: number
  expiresAt: string
}

const calculateReadinessExportSourceSignaturePayloadDigest = (
  value: ReadinessExportSourceSignaturePayloadFields
): string => {
  const generation = normalizeCanonicalGenerationIdentity(value.generation)
  const expiry = new Date(value.expiresAt)
  if (
    !Number.isFinite(expiry.getTime()) ||
    expiry.toISOString() !== value.expiresAt
  ) {
    throw new Error("Readiness export expiry must be canonical ISO-8601")
  }
  const postgresEpochMilliseconds = Date.UTC(2000, 0, 1)
  const timestamp = Buffer.allocUnsafe(8)
  timestamp.writeBigInt64BE(
    BigInt(expiry.getTime() - postgresEpochMilliseconds) * 1000n
  )
  return createHash("sha256")
    .update(
      `tbtc-p2tr-readiness-export-signature-v1\x1f${boundedString(
        value.sourceSigningKeyID,
        255,
        "readiness source signing key ID"
      )}`,
      "utf8"
    )
    .update(int64BE(value.exportFence, "readiness export fence"))
    .update(hexBuffer(value.requestDigest, "readiness request digest"))
    .update(int64BE(generation.generationID, "pinned generation ID"))
    .update(hexBuffer(generation.manifestDigest, "generation manifest digest"))
    .update(hexBuffer(generation.domainDigest, "generation domain digest"))
    .update(hexBuffer(value.sourceIdentityDigest, "source identity digest"))
    .update(hexBuffer(value.snapshotRoot, "readiness snapshot root"))
    .update(hexBuffer(value.snapshotSemanticRoot, "readiness semantic root"))
    .update(int64BE(value.snapshotGeneration, "readiness snapshot generation"))
    .update(hexBuffer(value.resultDigest, "readiness result digest"))
    .update(hexBuffer(value.auditManifestRoot, "readiness manifest root"))
    .update(hexBuffer(value.finalStreamDigest, "readiness stream digest"))
    .update(int64BE(value.objectCount, "readiness object count"))
    .update(int64BE(value.totalBytes, "readiness total bytes"))
    .update(int32BE(value.maxChunkBytes, "readiness maximum chunk bytes"))
    .update(timestamp)
    .digest("hex")
}

export const calculateP2TRReadinessExportSourceSignaturePayloadDigest = (
  handle: P2TRReadinessExportHandle
): string =>
  calculateReadinessExportSourceSignaturePayloadDigest({
    exportFence: handle.exportFence,
    requestDigest: handle.requestDigest,
    generation: handle.contentManifest.generation,
    sourceIdentityDigest: handle.sourceIdentity.identityDigest,
    sourceSigningKeyID: handle.contentManifest.sourceSignature.signingKeyID,
    snapshotRoot: handle.snapshotRoot,
    snapshotSemanticRoot: handle.snapshotSemanticRoot,
    snapshotGeneration: handle.snapshotGeneration,
    resultDigest: handle.resultDigest,
    auditManifestRoot: handle.contentManifest.auditManifestRoot,
    finalStreamDigest: handle.contentManifest.finalStreamDigest,
    objectCount: handle.contentManifest.objectCount,
    totalBytes: handle.contentManifest.totalBytes,
    maxChunkBytes: handle.contentManifest.maxChunkBytes,
    expiresAt: handle.request.expiresAt,
  })

const normalizeHex = (value: string, field: string): string => {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(normalized)
  ) {
    throw new Error(`${field} must be non-empty, even-length hex`)
  }
  return normalized
}

const normalizeScriptHex = (value: string, field: string): string => {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (normalized.length % 2 !== 0 || !/^[0-9a-f]*$/.test(normalized)) {
    throw new Error(`${field} must be even-length hex`)
  }
  return normalized
}

const normalizeFixedHex = (
  value: string,
  bytes: number,
  field: string
): string => {
  const normalized = normalizeHex(value, field)
  if (normalized.length !== bytes * 2) {
    throw new Error(`${field} must be exactly ${bytes} bytes`)
  }
  return normalized
}

const hexBuffer = (value: string, field: string): Buffer =>
  Buffer.from(normalizeHex(value, field), "hex")

const scriptHexBuffer = (value: string, field: string): Buffer =>
  Buffer.from(normalizeScriptHex(value, field), "hex")

const normalizeEvidenceObjectKind = (value: string): string => {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error("Evidence object kind is invalid")
  }
  return value
}

const buildImmutableEvidenceObject = (
  kind: string,
  bytes: Buffer
): ImmutableEvidenceObject => {
  kind = normalizeEvidenceObjectKind(kind)
  if (bytes.length > 4_000_000) {
    throw new Error("Evidence object exceeds the four-megabyte bound")
  }
  const chunks: ImmutableEvidenceObject["chunks"] = []
  const chunkCount = Math.max(1, Math.ceil(bytes.length / 65_536))
  for (let index = 0; index < chunkCount; index++) {
    const byteOffset = index * 65_536
    const chunkBytes = Buffer.from(
      bytes.subarray(byteOffset, Math.min(bytes.length, byteOffset + 65_536))
    )
    const chunkDigest = calculateP2TREvidenceChunkDigest(chunkBytes)
    const leafDigest = calculateP2TREvidenceChunkLeafDigest({
      chunkIndex: index,
      byteOffset,
      chunkDigest,
    })
    chunks.push({
      index,
      byteOffset,
      bytes: chunkBytes,
      chunkDigest,
      leafDigest,
    })
  }
  const contentDigest = calculateP2TREvidenceContentDigest(bytes)
  const chunkManifestRoot = calculateP2TREvidenceChunkManifestRoot(
    chunks.map((chunk) => chunk.leafDigest)
  )
  const objectDigest = calculateP2TREvidenceObjectDigest({
    kind,
    byteLength: bytes.length,
    chunkCount: chunks.length,
    contentDigest,
    chunkManifestRoot,
  })
  return {
    objectDigest,
    kind,
    byteLength: bytes.length,
    contentDigest,
    chunkManifestRoot,
    chunks,
  }
}

const uint32LE = (value: number, field: string): Buffer => {
  const normalized = uint32(value, field)
  const output = Buffer.allocUnsafe(4)
  output.writeUInt32LE(normalized)
  return output
}

const int32BE = (value: number, field: string): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new Error(`${field} must be a non-negative int32`)
  }
  const output = Buffer.allocUnsafe(4)
  output.writeInt32BE(value)
  return output
}

const int64BE = (value: number, field: string): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  const output = Buffer.allocUnsafe(8)
  output.writeBigInt64BE(BigInt(value))
  return output
}

const uint32BE = (value: number, field: string): Buffer => {
  const normalized = uint32(value, field)
  const output = Buffer.allocUnsafe(4)
  output.writeUInt32BE(normalized)
  return output
}

const uint64LE = (value: number, field: string): Buffer => {
  const normalized = nonNegativeInteger(value, field)
  const output = Buffer.allocUnsafe(8)
  output.writeBigUInt64LE(BigInt(normalized))
  return output
}

const compactSize = (value: number): Buffer => {
  const normalized = nonNegativeInteger(value, "Bitcoin CompactSize value")
  if (normalized < 0xfd) return Buffer.from([normalized])
  if (normalized <= 0xffff) {
    const output = Buffer.allocUnsafe(3)
    output[0] = 0xfd
    output.writeUInt16LE(normalized, 1)
    return output
  }
  if (normalized <= 0xffffffff) {
    const output = Buffer.allocUnsafe(5)
    output[0] = 0xfe
    output.writeUInt32LE(normalized, 1)
    return output
  }
  const output = Buffer.allocUnsafe(9)
  output[0] = 0xff
  output.writeBigUInt64LE(BigInt(normalized), 1)
  return output
}

const serializeBitcoinOutput = (value: number, script: Buffer): Buffer =>
  Buffer.concat([
    uint64LE(value, "Bitcoin transaction output value"),
    compactSize(script.length),
    script,
  ])

const serializeBitcoinWitness = (witness: readonly Uint8Array[]): Buffer =>
  Buffer.concat([
    compactSize(witness.length),
    ...witness.flatMap((item) => {
      const bytes = Buffer.from(item)
      return [compactSize(bytes.length), bytes]
    }),
  ])

const taggedSha256 = (tag: string, payload: Buffer): string => {
  const tagHash = createHash("sha256").update(tag, "utf8").digest()
  return createHash("sha256")
    .update(tagHash)
    .update(tagHash)
    .update(payload)
    .digest("hex")
}

const calculateTapLeafHash = (
  script: Uint8Array,
  controlBlock: Uint8Array
): string => {
  const normalizedScript = Buffer.from(script)
  const normalizedControl = Buffer.from(controlBlock)
  if (
    normalizedControl.length < 33 ||
    normalizedControl.length > 33 + 32 * 128 ||
    (normalizedControl.length - 33) % 32 !== 0
  ) {
    throw new Error("Taproot control block length is invalid")
  }
  return taggedSha256(
    "TapLeaf",
    Buffer.concat([
      Buffer.from([normalizedControl[0] & 0xfe]),
      compactSize(normalizedScript.length),
      normalizedScript,
    ])
  )
}

const candidateBlockingAlertDigest = (value: {
  identity: NormalizedCandidateIdentity
  inputIndex: number
  generation: number
  fingerprint: string
  witnessDigest: string
  reason: string
}): string =>
  createHash("sha256")
    .update("tbtc-p2tr-candidate-blocking-alert-v1", "utf8")
    .update(
      hexBuffer(value.identity.blockHash, "blocking candidate block hash")
    )
    .update(hexBuffer(value.identity.txid, "blocking candidate transaction ID"))
    .update(
      hexBuffer(
        value.identity.wtxid,
        "blocking candidate witness transaction ID"
      )
    )
    .update(uint32BE(value.inputIndex, "blocking candidate input index"))
    .update(int64BE(value.generation, "blocking candidate generation"))
    .update(hexBuffer(value.fingerprint, "blocking provenance fingerprint"))
    .update(hexBuffer(value.witnessDigest, "blocking witness digest"))
    .update(value.reason, "utf8")
    .digest("hex")

const serializedBitcoinTransactionHash = (rawTransaction: Buffer): string =>
  createHash("sha256")
    .update(createHash("sha256").update(rawTransaction).digest())
    .digest()
    .reverse()
    .toString("hex")

const validateBitcoinBlockEvidence = (
  block: P2TRCanonicalBitcoinScan["blocks"][number],
  field: string
): void => {
  const header = Buffer.from(
    normalizeFixedHex(block.header80Hex, 80, `${field} header`),
    "hex"
  )
  const rawBlock = normalizeHex(block.rawBlockHex, `${field} raw block`)
  const rawBlockBytes = Buffer.from(rawBlock, "hex")
  let parsed: Block
  try {
    parsed = Block.fromBuffer(rawBlockBytes)
  } catch {
    throw new Error(`${field} raw bytes are not canonical Bitcoin block data`)
  }
  if (
    !parsed.toBuffer(true).equals(header) ||
    !parsed.toBuffer(false).equals(rawBlockBytes)
  ) {
    throw new Error(`${field} raw bytes do not encode its exact block/header`)
  }
  const headerHash = createHash("sha256")
    .update(createHash("sha256").update(header).digest())
    .digest()
    .reverse()
    .toString("hex")
  if (headerHash !== normalizeBytes32(block.hash, `${field} hash`)) {
    throw new Error(`${field} header hash is inconsistent`)
  }
  const parentHash = Buffer.from(header.subarray(4, 36))
    .reverse()
    .toString("hex")
  if (
    parentHash !== normalizeBytes32(block.parentHash, `${field} parent hash`)
  ) {
    throw new Error(`${field} header parent hash is inconsistent`)
  }
  if (parsed.getId() !== normalizeBytes32(block.hash, `${field} hash`)) {
    throw new Error(`${field} parsed block identity is inconsistent`)
  }
  const transactions = parsed.transactions
  if (
    transactions === undefined ||
    transactions.length === 0 ||
    transactions.length !== block.transactions.length
  ) {
    throw new Error(
      `${field} transaction projection cardinality is inconsistent`
    )
  }
  if (
    !transactions[0].isCoinbase() ||
    transactions.slice(1).some((transaction) => transaction.isCoinbase())
  ) {
    throw new Error(`${field} coinbase transaction ordering is inconsistent`)
  }
  let rootsAreValid = false
  try {
    rootsAreValid = parsed.checkTxRoots()
  } catch {
    rootsAreValid = false
  }
  if (!rootsAreValid) {
    throw new Error(
      `${field} transaction or witness commitment is inconsistent`
    )
  }
  transactions.forEach((transaction, index) => {
    const projected = Buffer.from(
      normalizeHex(
        block.transactions[index].rawTransactionHex,
        `${field} transaction ${index} raw bytes`
      ),
      "hex"
    )
    if (!transaction.toBuffer().equals(projected)) {
      throw new Error(
        `${field} transaction order/raw projection is inconsistent`
      )
    }
  })
}

const normalizeP2TRAuthorizationDomain = (value: {
  chainID: string
  bridgeAddress: string
}): { chainID: bigint; bridgeAddress: Buffer; digest: string } => {
  const chainID = BigInt(
    normalizeUint256Decimal(value.chainID, "P2TR authorization chain ID")
  )
  const bridgeAddress = Buffer.from(
    normalizeBytes20(value.bridgeAddress, "P2TR authorization Bridge address"),
    "hex"
  )
  return {
    chainID,
    bridgeAddress,
    digest: completeAuthorizationDomainDigest({ chainID, bridgeAddress }),
  }
}

const normalizeUint256Decimal = (value: string, field: string): string => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be canonical decimal`)
  }
  if (BigInt(value) >= 1n << 256n) {
    throw new Error(`${field} exceeds uint256`)
  }
  return value
}

const normalizeBytes20 = (value: string, field: string): string => {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${field} must be a 20-byte hex value`)
  }
  return normalized
}

const uint256BE = (value: bigint): Buffer => {
  if (value < 0 || value >= 1n << 256n) {
    throw new Error("P2TR authorization chain ID exceeds uint256")
  }
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex")
}

const completeAuthorizationDomainDigest = (value: {
  chainID: bigint
  bridgeAddress: Buffer
}): string =>
  computeP2TRCompleteAuthorizationDomainDigest({
    domainChainID: value.chainID.toString(10),
    bridgeAddress: `0x${value.bridgeAddress.toString("hex")}`,
  })

const watchtowerSourceIdentityDigest = (value: {
  storeID: string
  clusterID: string
  operatorID: string
  bitcoinIdentityDigest: string
  ethereumIdentityDigest: string
}): string =>
  createHash("sha256")
    .update(
      `tbtc-p2tr-watchtower-source-identity-v1\x1f${value.storeID}\x1f${value.clusterID}\x1f${value.operatorID}`,
      "utf8"
    )
    .update(
      hexBuffer(value.bitcoinIdentityDigest, "source Bitcoin identity digest")
    )
    .update(
      hexBuffer(value.ethereumIdentityDigest, "source Ethereum identity digest")
    )
    .digest("hex")

const calculateP2TRCompleteV2ChallengeIdentity = (value: {
  chainID: bigint
  bridgeAddress: Buffer
  walletID: string
  signingKey: string
  sighash: string
}): string =>
  createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("tbtc-p2tr-signature-fraud-authorization-v3", "utf8"),
        uint256BE(value.chainID),
        value.bridgeAddress,
        hexBuffer(value.walletID, "P2TR authorization wallet ID"),
        hexBuffer(value.signingKey, "P2TR authorization signing key"),
        hexBuffer(value.sighash, "P2TR authorization sighash"),
      ])
    )
    .digest("hex")

const postgresClientError = (value: unknown, context: string): Error =>
  value instanceof Error ? value : new Error(`${context}: ${String(value)}`)

const retryablePostgresSQLState = (
  value: unknown
): P2TRRetryablePostgresSQLState | undefined => {
  return retryablePostgresSQLStateCode(postgresSQLState(value))
}

const retryablePostgresSQLStateCode = (
  code: string | undefined
): P2TRRetryablePostgresSQLState | undefined => {
  return code === "40001" ||
    code === "40P01" ||
    code === "55P03" ||
    code === "57014"
    ? code
    : undefined
}

const definitivePostgresCommitAbortSQLState = (
  value: unknown
): string | undefined => {
  const code = postgresSQLState(value)
  return code !== undefined && (code.startsWith("23") || code === "P0001")
    ? code
    : undefined
}

const confirmedPostgresCommitAbortReason = (
  attempt: P2TRPostgresTransactionAttempt
): P2TRPostgresTransactionConfirmedAbortReason =>
  retryablePostgresSQLStateCode(attempt.confirmedAbort?.sqlState) === undefined
    ? "definitive-commit-sqlstate"
    : "retryable-sqlstate"

const observeRetryablePostgresAborts = (
  client: P2TRPostgresClient,
  attempt: P2TRPostgresTransactionAttempt
): P2TRPostgresClient => ({
  query: async <Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>> => {
    try {
      return await client.query<Row>(text, values)
    } catch (error) {
      // A server response to an ordinary statement proves the transaction can
      // be rolled back and retried. Keep COMMIT's stricter outcome boundary:
      // serialization/deadlock plus definitive integrity/trigger rejections
      // establish abort semantics there; cancellation and lock errors remain
      // unknown because they need not describe the completed transaction.
      const command = text.trim().toUpperCase()
      const commit = command === "COMMIT"
      const retryableSQLState = retryablePostgresSQLState(error)
      const confirmedCommitSQLState = commit
        ? definitivePostgresCommitAbortSQLState(error)
        : undefined
      const confirmedSQLState = commit
        ? retryableSQLState === "40001" || retryableSQLState === "40P01"
          ? retryableSQLState
          : confirmedCommitSQLState
        : retryableSQLState
      if (
        confirmedSQLState !== undefined &&
        attempt.confirmedAbort === undefined
      ) {
        attempt.confirmedAbort = { sqlState: confirmedSQLState, error }
      }
      if (
        command !== "COMMIT" &&
        command !== "ROLLBACK" &&
        postgresSQLState(error) === undefined &&
        attempt.preCommitTransportAbort === undefined
      ) {
        // An ordinary statement that loses its transport before COMMIT cannot
        // commit. Remember that provenance even if the callback catches or
        // wraps the raw client error; a successful ROLLBACK or destroyed
        // session then proves the whole attempt is safe to retry.
        attempt.preCommitTransportAbort = error
      }
      throw error
    }
  },
  release: (error?: Error | boolean): void => client.release(error),
})

const throwRecordedPostgresAbort = (
  attempt: P2TRPostgresTransactionAttempt
): void => {
  if (attempt.confirmedAbort !== undefined) {
    throw attempt.confirmedAbort.error
  }
  if (attempt.preCommitTransportAbort !== undefined) {
    throw attempt.preCommitTransportAbort
  }
}

const confirmedPostgresAbortError = (
  attempt: P2TRPostgresTransactionAttempt,
  reason: P2TRPostgresTransactionConfirmedAbortReason,
  operationError: unknown
): P2TRPostgresTransactionConfirmedAbortError =>
  new P2TRPostgresTransactionConfirmedAbortError(
    reason,
    attempt.confirmedAbort?.sqlState,
    attempt.confirmedAbort?.error ?? attempt.preCommitTransportAbort,
    operationError
  )

const postgresSQLState = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined
  }
  const code = (value as { code?: unknown }).code
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
    ? code
    : undefined
}

const normalizePostgresCommandTag = (value: unknown): string | undefined =>
  typeof value === "string" ? value.trim().toUpperCase() : undefined

const uint32 = (value: unknown, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`${field} must be a uint32`)
  }
  return parsed
}

const p2trSighashType = (value: unknown, field: string): number => {
  const normalized = uint32(value, field)
  if (![0, 1, 2, 3, 0x81, 0x82, 0x83].includes(normalized)) {
    throw new Error(`${field} is not a defined BIP-341 sighash type`)
  }
  return normalized
}

const positiveInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  return value
}

const nonNegativeInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return value
}

const boundedString = (value: string, max: number, field: string): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new Error(`${field} must contain between 1 and ${max} characters`)
  }
  return value
}

const normalizeBytes32 = (value: string, field: string): string => {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 32-byte hex value`)
  }
  return normalized
}

const databaseInteger = (value: string | number, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  return nonNegativeInteger(parsed, field)
}

const journalCountsFromCursor = (row: CursorRow): JournalCounts => ({
  blocks: databaseInteger(row.journal_block_count, "journal block count"),
  transactions: databaseInteger(
    row.journal_transaction_count,
    "journal transaction count"
  ),
  inputs: databaseInteger(row.journal_input_count, "journal input count"),
  outputs: databaseInteger(row.journal_output_count, "journal output count"),
  unresolvedInputs: databaseInteger(
    row.journal_unresolved_input_count,
    "journal unresolved input count"
  ),
})

const bitcoinBlockJournalCounts = (
  block: P2TRCanonicalBitcoinScan["blocks"][number]
): Pick<JournalCounts, "transactions" | "inputs" | "outputs"> => ({
  transactions: block.transactions.length,
  inputs: block.transactions.reduce(
    (total, transaction) =>
      total + (transaction.coinbase ? 0 : transaction.inputs.length),
    0
  ),
  outputs: block.transactions.reduce(
    (total, transaction) => total + transaction.outputs.length,
    0
  ),
})

const journalCountsFromRow = (
  row: Record<keyof JournalCounts, string | number>,
  context: string
): JournalCounts => ({
  blocks: databaseInteger(row.blocks, `${context} block count`),
  transactions: databaseInteger(
    row.transactions,
    `${context} transaction count`
  ),
  inputs: databaseInteger(row.inputs, `${context} input count`),
  outputs: databaseInteger(row.outputs, `${context} output count`),
  unresolvedInputs: databaseInteger(
    row.unresolvedInputs,
    `${context} unresolved input count`
  ),
})

const subtractJournalCounts = (
  total: JournalCounts,
  removed: JournalCounts
): JournalCounts => {
  const retained = {
    blocks: total.blocks - removed.blocks,
    transactions: total.transactions - removed.transactions,
    inputs: total.inputs - removed.inputs,
    outputs: total.outputs - removed.outputs,
    unresolvedInputs: total.unresolvedInputs - removed.unresolvedInputs,
  }
  for (const [name, value] of Object.entries(retained)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`PostgreSQL ${name} journal counter is inconsistent`)
    }
  }
  return retained
}

const bitcoinChainCommitment = (
  parentCommitment: string | undefined,
  point: P2TRBitcoinChainPoint
): string => {
  const height = nonNegativeInteger(point.height, "chain commitment height")
  const encodedHeight = Buffer.alloc(8)
  encodedHeight.writeBigUInt64BE(BigInt(height))
  return createHash("sha256")
    .update("tbtc-p2tr-canonical-chain-v1\0", "utf8")
    .update(
      parentCommitment === undefined
        ? Buffer.alloc(32)
        : hexBuffer(parentCommitment, "parent chain commitment")
    )
    .update(encodedHeight)
    .update(hexBuffer(point.hash, "chain commitment block hash"))
    .digest("hex")
}

const bitcoinRawBlockBytesContentCommitment = (bytes: Uint8Array): string => {
  const normalized = Buffer.from(bytes)
  if (normalized.length === 0 || normalized.length > 4_000_000) {
    throw new Error("Raw Bitcoin block exceeds its canonical byte bound")
  }
  return createHash("sha256")
    .update("tbtc-p2tr-raw-block-content-v1\0", "utf8")
    .update(normalized)
    .digest("hex")
}

const bitcoinRawBlockContentCommitment = (
  block: P2TRCanonicalBitcoinScan["blocks"][number]
): string =>
  bitcoinRawBlockBytesContentCommitment(
    hexBuffer(block.rawBlockHex, "raw block content")
  )

const bitcoinEvidenceChainCommitment = (
  parentCommitment: string | undefined,
  point: P2TRBitcoinChainPoint,
  contentCommitment: string
): string => {
  const height = nonNegativeInteger(point.height, "evidence commitment height")
  const encodedHeight = Buffer.alloc(8)
  encodedHeight.writeBigUInt64BE(BigInt(height))
  return createHash("sha256")
    .update("tbtc-p2tr-canonical-evidence-chain-v1\0", "utf8")
    .update(
      parentCommitment === undefined
        ? Buffer.alloc(32)
        : hexBuffer(parentCommitment, "parent evidence commitment")
    )
    .update(encodedHeight)
    .update(hexBuffer(point.hash, "evidence commitment block hash"))
    .update(hexBuffer(contentCommitment, "block content commitment"))
    .digest("hex")
}
