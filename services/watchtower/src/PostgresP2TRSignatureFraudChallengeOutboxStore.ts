import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { utils } from "ethers"

import {
  Hex,
  P2TRSignatureFraudBoundNonceReservation,
  P2TR_SIGNATURE_FRAUD_NONCE_BURN_GAS_LIMIT,
  validateP2TRCompleteV2SignatureFraudSubmissionIntent,
  validateP2TRSignatureFraudPreparedChallengeTransactionReservation,
  validateP2TRSignatureFraudPreparedEIP1559ChallengeTransaction,
} from "@keep-network/tbtc-v2.ts"

import {
  P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE,
  P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_VOIDED_RESERVATIONS,
  P2TRSignatureFraudCanonicalProvenanceBinding,
  P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence,
  P2TRSignatureFraudIndependentSignerBoundaryResolution,
  P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  P2TRSignatureFraudChallengeOutboxPage,
  P2TRSignatureFraudChallengeOutboxPageRequest,
  P2TRSignatureFraudChallengeOutboxRecord,
  P2TRSignatureFraudChallengeOutboxStore,
  P2TRSignatureFraudLegacySubmissionQuarantine,
  P2TRSignatureFraudAmbiguousNonceReleaseInvocation,
  P2TRSignatureFraudIndependentNonceReleaseResolution,
  P2TRSignatureFraudOutboxCriticalAlert,
  P2TRSignatureFraudNonceReleaseAttempt,
  P2TRSignatureFraudNonceReleaseAttemptResult,
  P2TRSignatureFraudNonceReleasePage,
  P2TRSignatureFraudNonceReleasePageRequest,
  P2TRSignatureFraudNonceReleaseRequest,
  P2TRSignatureFraudPreparedTransactionVariant,
  P2TRSignatureFraudSignerQuarantine,
  P2TRSignatureFraudUnexpectedSignedArtifact,
  P2TRSignatureFraudVoidedNonceReservation,
  computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash,
  computeP2TRSignatureFraudDispositionHash,
  computeP2TRSignatureFraudNonceReleaseRequestID,
  computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest,
  computeP2TRSignatureFraudResolutionEvidenceDigest,
  appendSignerQuarantine,
  assertP2TRSignatureFraudOrphanedSignerBoundaryOwnership,
  normalizeP2TRSignatureFraudSigningLane,
  validateP2TRSignatureFraudIndependentSignerBoundaryResolution,
  validateP2TRSignatureFraudLegacyV4SignerBoundaryResolutionReplay,
} from "./P2TRSignatureFraudChallengeOutbox.js"
import type { P2TRSignatureFraudSigningLane } from "./P2TRSignatureFraudChallengeOutbox.js"
import type { P2TRPostgresOutboxTransactionSession } from "./PostgresP2TRSignatureFraudOutboxActivationHandshake.js"
import type { P2TRSignatureFraudWatchtowerTransactionCoordinator } from "./types.js"

export type P2TRPostgresOutboxCanonicalClaimBinding = {
  recordID: string
  observationID: string
  bridgeChallengeKey: string
  candidate: {
    txid: string
    wtxid: string
    inputIndex: number
    blockHash: string
    blockHeight: number
  }
  provenance: P2TRSignatureFraudCanonicalProvenanceBinding
}

export type PostgresP2TRSignatureFraudChallengeOutboxStoreOptions = {
  storeID: string
  session: P2TRPostgresOutboxTransactionSession
  transactionCoordinator: Pick<
    P2TRSignatureFraudWatchtowerTransactionCoordinator,
    "runInP2TRSignatureFraudWatchtowerTransaction"
  > & {
    isP2TRSignatureFraudWatchtowerTransactionActive(): boolean
  }
  assertTransactionSession(session: P2TRPostgresOutboxTransactionSession): void
  /**
   * Must prove the runtime's exclusive readiness snapshot is held in this
   * transaction, recompute the committed event-set hash/count from that
   * canonical journal, prove the input-binding source event is a member, and
   * compare every exact input-level field before returning. The outbox never
   * accepts a fingerprint-only assertion.
   */
  lockAndAssertCurrentCanonicalProvenance(
    session: P2TRPostgresOutboxTransactionSession,
    binding: P2TRPostgresOutboxCanonicalClaimBinding
  ): Promise<boolean>
  /** Must authenticate the canonical tombstone under the same rollback lock. */
  lockAndAssertCanonicalProvenanceInvalidation(
    session: P2TRPostgresOutboxTransactionSession,
    evidence: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence
  ): Promise<void>
  /** Must load the exact canonical input occurrence through this session. */
  loadEligibilitySnapshot(
    session: P2TRPostgresOutboxTransactionSession,
    observationID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxEligibilitySnapshot>
  /**
   * Pure, local verification boundary. It must authenticate both independent
   * attestations and their exact provider evidence without network or database
   * I/O; this callback runs while the ambiguous attempt and barrier are locked.
   */
  assertIndependentNonceReleaseResolution(
    invocation: P2TRSignatureFraudAmbiguousNonceReleaseInvocation,
    resolution: P2TRSignatureFraudIndependentNonceReleaseResolution
  ): true | Promise<true>
  broadcastProviderID: string
}

export type P2TRProductionSignerLaneConfiguration = {
  activationManifestHash: string
  chainID: number
  policyHash: string
  challengeValueWei: string
  laneID: string
  signerIdentity: string
  sender: string
  maxGasLimit: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  maxTotalFeeWei: string
  signerCodeHash: string
  configurationHash: string
  configuredAtUnixMs: number
}

type P2TRProductionSignerLaneConfigurationBinding = Omit<
  P2TRProductionSignerLaneConfiguration,
  "configurationHash" | "configuredAtUnixMs"
>

export const computeP2TRProductionSignerLaneConfigurationHash = (
  configuration: P2TRProductionSignerLaneConfigurationBinding
): string =>
  hashStructured({
    domain: "tbtc-p2tr-production-signer-lane-configuration-v1",
    ...normalizeProductionSignerLaneConfiguration(configuration),
  })

type StoredOutboxRow = {
  record_state: unknown
  status: P2TRSignatureFraudChallengeOutboxRecord["status"]
  version: string | number
  updated_at_unix_ms: string | number
  preparation_attempts: number
  broadcast_attempts: number
  reconciliation_attempts: number
  preparation_lease_owner: string | null
  preparation_lease_expires_at_unix_ms: string | number | null
  preparation_resume_status: "prepared" | "broadcast-pending" | null
  selected_signer_lane_id: string | null
  selected_signer_identity: string | null
  selected_sender: Buffer | null
  nonce_reservation_id: Buffer | null
  signer_invocation_started_at_unix_ms: string | number | null
  signer_invocation_id: Buffer | null
  active_signer_invocation_started_at_unix_ms: string | number | null
  active_signer_invocation_id: Buffer | null
  last_broadcast_at_unix_ms: string | number | null
  last_reconciliation_at_unix_ms: string | number | null
  last_pre_broadcast_recheck_at_unix_ms: string | number | null
  last_pre_broadcast_recheck_status: NonNullable<
    P2TRSignatureFraudChallengeOutboxRecord["lastPreBroadcastRecheckStatus"]
  > | null
  last_resolution_status: NonNullable<
    P2TRSignatureFraudChallengeOutboxRecord["lastResolutionStatus"]
  > | null
  last_error: string | null
  provenance_invalidation_id: Buffer | null
}

type ProvenanceInvalidationRow = {
  provenance_invalidation_id: Buffer
  provenance_tombstone_id: Buffer
  observation_id: Buffer
  bitcoin_tx_hash: Buffer
  bitcoin_wtxid: Buffer
  bitcoin_input_index: string | number
  bitcoin_block_hash: Buffer
  bitcoin_block_height: string | number
  canonical_candidate_digest: Buffer
  canonical_candidate_provenance_generation: string | number
  canonical_provenance_fingerprint: Buffer
  canonical_provenance_manifest_hash: Buffer
  ethereum_rollback_block_hash: Buffer
  ethereum_rollback_block_number: string | number
  provenance_invalidation_sequence: string | number
  reason: string
  invalidated_at_unix_ms: string | number
}

type NonceReleaseRequestRow = {
  release_request_id: Buffer
  record_id: Buffer
  generation: string | number
  nonce_guard_id: Buffer
  chain_id: string | number
  signer_lane_id: string
  signer_identity: string
  sender: Buffer
  transaction_nonce: string | number
  reservation_epoch: string | number
  reservation_binding: Buffer
  void_evidence_digest: Buffer
  requested_at_unix_ms: string | number
  attempt_count: string | number
  ambiguous: boolean
}

const STORED_ROW_COLUMNS = `
  record_state, status, version, updated_at_unix_ms,
  preparation_attempts, broadcast_attempts, reconciliation_attempts,
  preparation_lease_owner, preparation_lease_expires_at_unix_ms,
  preparation_resume_status, selected_signer_lane_id,
  selected_signer_identity, selected_sender, nonce_reservation_id,
  signer_invocation_started_at_unix_ms, signer_invocation_id,
  active_signer_invocation_started_at_unix_ms, active_signer_invocation_id,
  last_broadcast_at_unix_ms, last_reconciliation_at_unix_ms,
  last_pre_broadcast_recheck_at_unix_ms,
  last_pre_broadcast_recheck_status, last_resolution_status, last_error,
  provenance_invalidation_id`

const MAX_DURABLE_OUTBOX_RECORD_BYTES = 262_144
const MAX_SIGNED_ETHEREUM_TRANSACTION_BYTES = 4_096

/**
 * PostgreSQL implementation for the activation-grade outbox. Every public
 * operation enters the runtime coordinator's transaction boundary. Nested
 * calls reuse the same AsyncLocalStorage scope, so eligibility loading and its
 * enqueue/authorization updates share one commit while dispatcher transitions
 * commit before any signer or broadcaster I/O begins.
 */
export class PostgresP2TRSignatureFraudChallengeOutboxStore
  implements P2TRSignatureFraudChallengeOutboxStore
{
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  private readonly transaction = new AsyncLocalStorage<boolean>()

  constructor(
    private readonly options: PostgresP2TRSignatureFraudChallengeOutboxStoreOptions
  ) {
    requireText(options.storeID, "PostgreSQL outbox store ID", 255)
    requireText(
      options.broadcastProviderID,
      "Outbox broadcaster provider ID",
      128
    )
    this.p2trSignatureFraudWatchtowerTransactionalStoreID = options.storeID
  }

  assertExternalIOTransactionBoundary(): void {
    if (
      this.inTransaction() ||
      this.options.transactionCoordinator.isP2TRSignatureFraudWatchtowerTransactionActive()
    ) {
      throw new Error(
        "Irreversible outbox I/O cannot run inside an ambient database transaction"
      )
    }
  }

  async installSignerLaneConfiguration(
    configuration: P2TRProductionSignerLaneConfiguration
  ): Promise<void> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.installSignerLaneConfiguration(configuration)
      )
    }
    this.assertSession()
    const {
      configurationHash: _ignored,
      configuredAtUnixMs: _time,
      ...binding
    } = configuration
    const normalized = normalizeProductionSignerLaneConfiguration(binding)
    if (
      bytes32(configuration.configurationHash, "Signer configuration hash") !==
      computeP2TRProductionSignerLaneConfigurationHash(normalized)
    ) {
      throw new Error("Signer lane configuration hash is invalid")
    }
    // Every outbox operation enters the coordinator's shared pre-snapshot
    // fence before BEGIN. If this writer wins the fence, readiness revalidates
    // the inserted lane before minting; if readiness wins, its committed
    // certificate is visible here after the shared fence is acquired.
    const readiness = await this.options.session.query<{
      readiness_is_current: boolean
    }>(
      `SELECT EXISTS (
          SELECT 1
            FROM p2tr_readiness_certificates
           WHERE is_current
             AND manifest_hash = decode($1, 'hex')
       ) AS readiness_is_current`,
      [stripHex(normalized.activationManifestHash)]
    )
    if (
      readiness.rows.length !== 1 ||
      typeof readiness.rows[0].readiness_is_current !== "boolean"
    ) {
      throw new Error("Current readiness certificate state is unavailable")
    }
    if (readiness.rows[0].readiness_is_current) {
      throw new Error(
        "Signer lane configuration is frozen while readiness is current"
      )
    }
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_signer_lane_configuration (
          activation_manifest_hash, chain_id, policy_hash, signer_lane_id,
          signer_identity, sender, challenge_value_wei, max_gas_limit,
          max_fee_per_gas, max_priority_fee_per_gas, max_total_fee_wei,
          signer_code_hash, configuration_hash, enabled,
          configured_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), $2, decode($3, 'hex'), $4, $5,
          decode($6, 'hex'), $7, $8, $9, $10, $11, decode($12, 'hex'),
          decode($13, 'hex'), true, $14
       )`,
      [
        stripHex(normalized.activationManifestHash),
        normalized.chainID,
        stripHex(normalized.policyHash),
        normalized.laneID,
        normalized.signerIdentity,
        stripHex(normalized.sender),
        normalized.challengeValueWei,
        normalized.maxGasLimit,
        normalized.maxFeePerGas,
        normalized.maxPriorityFeePerGas,
        normalized.maxTotalFeeWei,
        stripHex(normalized.signerCodeHash),
        stripHex(
          bytes32(configuration.configurationHash, "Signer configuration hash")
        ),
        unixMilliseconds(
          configuration.configuredAtUnixMs,
          "Signer configuration time"
        ),
      ]
    )
  }

  async insertGenerationIfAbsent(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() => this.insertGenerationIfAbsent(record))
    }
    this.assertSession()
    assertCompactDurableOutboxRecord(record)
    const existing = await this.getByRecordOrSeriesGeneration(
      record.recordID,
      record.seriesID,
      record.generation
    )
    if (existing !== undefined) return existing

    const serializedExisting = await this.lockAndAssertActiveOutboxCapacity(
      record
    )
    if (serializedExisting !== undefined) return serializedExisting
    const priorLinks = await this.loadPriorGenerationLinks(record)
    const columns = outboxInsertColumns(record, priorLinks)
    const inserted = await insertObject(
      this.options.session,
      "p2tr_signature_fraud_challenge_outbox",
      columns,
      "ON CONFLICT DO NOTHING RETURNING record_id"
    )
    if (inserted.rowCount === 1) {
      await this.insertFeePolicy(record)
      return (await this.get(record.recordID))!
    }
    const winner = await this.getByRecordOrSeriesGeneration(
      record.recordID,
      record.seriesID,
      record.generation
    )
    if (winner !== undefined) return winner
    throw new Error("PostgreSQL outbox insertion returned no durable identity")
  }

  async get(
    recordID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() => this.get(recordID))
    }
    this.assertSession()
    const result = await this.options.session.query<StoredOutboxRow>(
      `SELECT ${STORED_ROW_COLUMNS}
         FROM p2tr_signature_fraud_challenge_outbox
        WHERE record_id = decode($1, 'hex')`,
      [stripHex(bytes32(recordID, "Outbox record ID"))]
    )
    if (result.rows.length === 0) return undefined
    return this.hydrateRow(result.rows[0])
  }

  async getLatest(
    seriesID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() => this.getLatest(seriesID))
    }
    this.assertSession()
    const result = await this.options.session.query<StoredOutboxRow>(
      `SELECT ${STORED_ROW_COLUMNS}
         FROM p2tr_signature_fraud_challenge_outbox
        WHERE series_id = decode($1, 'hex')
        ORDER BY generation DESC
        LIMIT 1`,
      [stripHex(bytes32(seriesID, "Outbox series ID"))]
    )
    if (result.rows.length === 0) return undefined
    return this.hydrateRow(result.rows[0])
  }

  async isSignerQuarantined(
    chainID: number,
    signerIdentity: string
  ): Promise<boolean> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.isSignerQuarantined(chainID, signerIdentity)
      )
    }
    this.assertSession()
    const result = await this.options.session.query<{ exists: boolean }>(
      `SELECT EXISTS (
          SELECT 1
            FROM p2tr_signature_fraud_challenge_signer_quarantine
           WHERE chain_id = $1
             AND signer_identity = $2
       ) AS exists`,
      [
        positiveSafeInteger(chainID, "Signer quarantine chain ID"),
        signerIdentity,
      ]
    )
    return result.rows[0]?.exists === true
  }

  async hasExpiredPreparationLeases(
    nowUnixMs: number,
    lane?: P2TRSignatureFraudSigningLane
  ): Promise<boolean> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.hasExpiredPreparationLeases(nowUnixMs, lane)
      )
    }
    this.assertSession()
    const normalized =
      lane === undefined
        ? undefined
        : normalizeP2TRSignatureFraudSigningLane(lane)
    // `lane_released_at_unix_ms IS NULL` is not a filter of convenience. A
    // record that has released its lane is no longer occupying it, so freezing
    // the lane on its behalf would be wrong -- and the partial unique index on
    // (chain_id, selected_sender) carries the same predicate, so stating it
    // keeps this an index lookup instead of a scan.
    const result = await this.options.session.query<{ exists: boolean }>(
      `SELECT EXISTS (
          SELECT 1
            FROM p2tr_signature_fraud_challenge_outbox
           WHERE status = 'preparing'
             AND preparation_lease_expires_at_unix_ms <= $1
             ${
               normalized === undefined
                 ? ""
                 : `AND chain_id = $2
             AND selected_sender = decode($3, 'hex')
             AND lane_released_at_unix_ms IS NULL`
             }
       ) AS exists`,
      normalized === undefined
        ? [unixMilliseconds(nowUnixMs, "Preparation recovery time")]
        : [
            unixMilliseconds(nowUnixMs, "Preparation recovery time"),
            normalized.chainID,
            stripHex(normalized.sender),
          ]
    )
    return result.rows[0]?.exists === true
  }

  async hasPendingNonceReleases(
    lane?: P2TRSignatureFraudSigningLane
  ): Promise<boolean> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() => this.hasPendingNonceReleases(lane))
    }
    this.assertSession()
    const normalized =
      lane === undefined
        ? undefined
        : normalizeP2TRSignatureFraudSigningLane(lane)
    const result = await this.options.session.query<{ exists: boolean }>(
      `SELECT EXISTS (
          SELECT 1
            FROM p2tr_signature_fraud_challenge_nonce_release_request r
           WHERE NOT EXISTS (
                 SELECT 1
                   FROM p2tr_signature_fraud_challenge_nonce_release_terminal x
                  WHERE x.release_request_id = r.release_request_id
               )
             ${
               normalized === undefined
                 ? ""
                 : `AND r.chain_id = $1
             AND r.sender = decode($2, 'hex')`
             }
       ) AS exists`,
      normalized === undefined
        ? []
        : [normalized.chainID, stripHex(normalized.sender)]
    )
    return result.rows[0]?.exists === true
  }

  async getNonceReleaseRequest(
    releaseRequestID: string
  ): Promise<P2TRSignatureFraudNonceReleaseRequest | undefined> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.getNonceReleaseRequest(releaseRequestID)
      )
    }
    this.assertSession()
    const result = await this.queryNonceReleaseRequests(
      `r.release_request_id = decode($1, 'hex')`,
      [stripHex(bytes32(releaseRequestID, "Nonce-release request ID"))],
      1
    )
    if (result.length === 0) return undefined
    return this.hydrateNonceReleaseRequest(result[0])
  }

  async listPendingNonceReleases(
    request: P2TRSignatureFraudNonceReleasePageRequest
  ): Promise<P2TRSignatureFraudNonceReleasePage> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() => this.listPendingNonceReleases(request))
    }
    this.assertSession()
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit <= 0 ||
      request.limit > P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE
    ) {
      throw new Error("PostgreSQL nonce-release page request is invalid")
    }
    const cursor =
      request.cursor === undefined
        ? undefined
        : bytes32(request.cursor, "Nonce-release page cursor")
    const rows = await this.queryNonceReleaseRequests(
      `NOT EXISTS (
          SELECT 1
            FROM p2tr_signature_fraud_challenge_nonce_release_terminal x
           WHERE x.release_request_id = r.release_request_id
        )
        AND ($1::text IS NULL OR r.release_request_id > decode($1, 'hex'))`,
      [cursor === undefined ? null : stripHex(cursor)],
      request.limit + 1
    )
    const pageRows = rows.slice(0, request.limit)
    const requests: P2TRSignatureFraudNonceReleaseRequest[] = []
    for (const row of pageRows) {
      requests.push(await this.hydrateNonceReleaseRequest(row))
    }
    return {
      requests,
      nextCursor:
        rows.length > request.limit
          ? prefixedHex(pageRows[pageRows.length - 1].release_request_id)
          : undefined,
    }
  }

  async getActiveAmbiguousNonceReleaseInvocation(
    nowUnixMs: number
  ): Promise<P2TRSignatureFraudAmbiguousNonceReleaseInvocation | undefined> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.getActiveAmbiguousNonceReleaseInvocation(nowUnixMs)
      )
    }
    this.assertSession()
    const now = unixMilliseconds(
      nowUnixMs,
      "Ambiguous nonce-release recovery time"
    )
    const result = await this.options.session.query<{
      active_release_request_id: Buffer | null
      active_release_attempt_sequence: string | number | null
      active_release_expires_at_unix_ms: string | number | null
      owner: string | null
      started_at_unix_ms: string | number | null
      expires_at_unix_ms: string | number | null
      invoked_at_unix_ms: string | number | null
      result_kind: string | null
      response_digest: Buffer | null
      resolution_outcome: string | null
    }>(
      `SELECT b.active_release_request_id,
              b.active_release_attempt_sequence,
              b.active_release_expires_at_unix_ms,
              a.owner, a.started_at_unix_ms, a.expires_at_unix_ms,
              i.invoked_at_unix_ms, x.result_kind, x.response_digest,
              rx.outcome AS resolution_outcome
         FROM p2tr_signature_fraud_nonce_allocator_safety_barrier b
         LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_attempt a
           ON a.release_request_id = b.active_release_request_id
          AND a.attempt_sequence = b.active_release_attempt_sequence
         LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_invocation i
           ON i.release_request_id = a.release_request_id
          AND i.attempt_sequence = a.attempt_sequence
         LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_result x
           ON x.release_request_id = a.release_request_id
          AND x.attempt_sequence = a.attempt_sequence
         LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_resolution rx
           ON rx.release_request_id = a.release_request_id
          AND rx.attempt_sequence = a.attempt_sequence
        WHERE b.active_release_request_id IS NOT NULL
        ORDER BY b.chain_id, b.sender
        FOR UPDATE OF b`
    )
    // The barrier is keyed per nonce lane, so several lanes can hold a claim at
    // once. Every claim is validated — a malformed one throws even if it is not
    // the claim this call recovers — and the first recoverable one is returned.
    // The caller drains the rest on subsequent passes.
    let recoverable:
      | P2TRSignatureFraudAmbiguousNonceReleaseInvocation
      | undefined
    for (const row of result.rows) {
      const candidate = await this.hydrateAmbiguousNonceReleaseInvocation(
        row,
        now
      )
      if (recoverable === undefined) recoverable = candidate
    }
    return recoverable
  }

  private async hydrateAmbiguousNonceReleaseInvocation(
    row: {
      active_release_request_id: Buffer | null
      active_release_attempt_sequence: string | number | null
      active_release_expires_at_unix_ms: string | number | null
      owner: string | null
      started_at_unix_ms: string | number | null
      expires_at_unix_ms: string | number | null
      invoked_at_unix_ms: string | number | null
      result_kind: string | null
      response_digest: Buffer | null
      resolution_outcome: string | null
    },
    now: number
  ): Promise<P2TRSignatureFraudAmbiguousNonceReleaseInvocation | undefined> {
    if (row.active_release_request_id === null) {
      if (
        row.active_release_attempt_sequence !== null ||
        row.active_release_expires_at_unix_ms !== null
      ) {
        throw new Error(
          "Nonce allocator safety barrier is internally inconsistent"
        )
      }
      return undefined
    }
    if (
      row.active_release_attempt_sequence === null ||
      row.active_release_expires_at_unix_ms === null ||
      row.owner === null ||
      row.started_at_unix_ms === null ||
      row.expires_at_unix_ms === null ||
      row.invoked_at_unix_ms === null ||
      row.resolution_outcome !== null ||
      (row.result_kind !== null && row.result_kind !== "ambiguous-error")
    ) {
      throw new Error(
        "Active nonce-release barrier cannot hydrate its exact ambiguous invocation"
      )
    }
    const releaseRequestID = prefixedHex(row.active_release_request_id)
    const attemptSequence = databaseSafeInteger(
      row.active_release_attempt_sequence,
      "Active nonce-release attempt sequence"
    )
    const startedAtUnixMs = databaseSafeInteger(
      row.started_at_unix_ms,
      "Active nonce-release attempt start"
    )
    const expiresAtUnixMs = databaseSafeInteger(
      row.expires_at_unix_ms,
      "Active nonce-release attempt expiration"
    )
    const barrierExpiresAtUnixMs = databaseSafeInteger(
      row.active_release_expires_at_unix_ms,
      "Active nonce-release barrier expiration"
    )
    const invokedAtUnixMs = databaseSafeInteger(
      row.invoked_at_unix_ms,
      "Active nonce-release invocation time"
    )
    if (
      barrierExpiresAtUnixMs !== expiresAtUnixMs ||
      expiresAtUnixMs <= startedAtUnixMs ||
      invokedAtUnixMs < startedAtUnixMs ||
      invokedAtUnixMs > expiresAtUnixMs ||
      (row.result_kind === "ambiguous-error" && row.response_digest === null)
    ) {
      throw new Error(
        "Active nonce-release invocation is internally inconsistent"
      )
    }
    if (row.result_kind === null && expiresAtUnixMs > now) return undefined
    const request = await this.getNonceReleaseRequest(releaseRequestID)
    if (request === undefined) {
      throw new Error(
        "Active nonce-release invocation lacks its durable request"
      )
    }
    return {
      request,
      attempt: {
        releaseRequestID,
        attemptSequence,
        owner: requireCanonicalOwner(
          row.owner,
          "Active nonce-release attempt owner",
          128
        ),
        startedAtUnixMs,
        expiresAtUnixMs,
      },
      invokedAtUnixMs,
      ambiguousResponseDigest:
        row.response_digest === null
          ? undefined
          : prefixedHex(row.response_digest),
    }
  }

  async claimNonceReleaseAttempt(
    releaseRequestID: string,
    owner: string,
    startedAtUnixMs: number,
    expiresAtUnixMs: number
  ): Promise<P2TRSignatureFraudNonceReleaseAttempt | undefined> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.claimNonceReleaseAttempt(
          releaseRequestID,
          owner,
          startedAtUnixMs,
          expiresAtUnixMs
        )
      )
    }
    this.assertSession()
    const normalizedOwner = requireCanonicalOwner(
      owner,
      "Nonce-release attempt owner",
      128
    )
    const releaseID = stripHex(
      bytes32(releaseRequestID, "Claimed nonce-release request ID")
    )
    const started = unixMilliseconds(
      startedAtUnixMs,
      "Nonce-release attempt start time"
    )
    const expires = unixMilliseconds(
      expiresAtUnixMs,
      "Nonce-release attempt expiration"
    )
    if (expires <= started) {
      throw new Error("Nonce-release attempt expiration must follow its start")
    }
    const locked = await this.options.session.query<{
      release_request_id: Buffer
    }>(
      `SELECT release_request_id
         FROM p2tr_signature_fraud_challenge_nonce_release_request
        WHERE release_request_id = decode($1, 'hex')
        FOR UPDATE`,
      [releaseID]
    )
    if (locked.rows.length !== 1) {
      throw new Error("Nonce-release request does not exist")
    }
    const state = await this.options.session.query<{
      attempt_sequence: string | number | null
      owner: string | null
      started_at_unix_ms: string | number | null
      expires_at_unix_ms: string | number | null
      result_kind: string | null
      invoked: boolean
      acknowledged: boolean
    }>(
      `SELECT a.attempt_sequence,
              a.owner,
              a.started_at_unix_ms,
              a.expires_at_unix_ms,
              x.result_kind,
              EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_nonce_release_invocation i
                 WHERE i.release_request_id = decode($1, 'hex')
                   AND i.attempt_sequence = a.attempt_sequence
              ) AS invoked,
              EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_nonce_release_terminal ok
                 WHERE ok.release_request_id = decode($1, 'hex')
              ) AS acknowledged
         FROM (SELECT 1) seed
         LEFT JOIN LATERAL (
           SELECT attempt_sequence, owner, started_at_unix_ms,
                  expires_at_unix_ms
             FROM p2tr_signature_fraud_challenge_nonce_release_attempt
            WHERE release_request_id = decode($1, 'hex')
            ORDER BY attempt_sequence DESC
            LIMIT 1
         ) a ON true
         LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_result x
           ON x.release_request_id = decode($1, 'hex')
          AND x.attempt_sequence = a.attempt_sequence`,
      [releaseID]
    )
    const latest = state.rows[0]
    if (latest?.acknowledged === true) return undefined
    if (
      latest?.attempt_sequence !== null &&
      latest?.attempt_sequence !== undefined &&
      ((latest.result_kind === null &&
        (latest.invoked ||
          databaseSafeInteger(
            latest.expires_at_unix_ms!,
            "Latest nonce-release attempt expiration"
          ) > started)) ||
        (latest.invoked && latest.result_kind === "ambiguous-error"))
    ) {
      if (
        latest.result_kind === null &&
        !latest.invoked &&
        latest.owner === normalizedOwner
      ) {
        return {
          releaseRequestID: bytes32(
            releaseRequestID,
            "Reclaimed nonce-release request ID"
          ),
          attemptSequence: databaseSafeInteger(
            latest.attempt_sequence,
            "Reclaimed nonce-release attempt sequence"
          ),
          owner: normalizedOwner,
          startedAtUnixMs: databaseSafeInteger(
            latest.started_at_unix_ms!,
            "Reclaimed nonce-release attempt start"
          ),
          expiresAtUnixMs: databaseSafeInteger(
            latest.expires_at_unix_ms!,
            "Reclaimed nonce-release attempt expiration"
          ),
        }
      }
      return undefined
    }
    const attemptSequence =
      latest?.attempt_sequence === null ||
      latest?.attempt_sequence === undefined
        ? 1
        : databaseSafeInteger(
            latest.attempt_sequence,
            "Latest nonce-release attempt sequence"
          ) + 1
    const inserted = await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_release_attempt (
          release_request_id, attempt_sequence, owner,
          started_at_unix_ms, expires_at_unix_ms
       ) VALUES (decode($1, 'hex'), $2, $3, $4, $5)
       RETURNING release_request_id`,
      [releaseID, attemptSequence, normalizedOwner, started, expires]
    )
    if (inserted.rowCount !== 1) return undefined
    return {
      releaseRequestID: bytes32(
        releaseRequestID,
        "Claimed nonce-release request ID"
      ),
      attemptSequence,
      owner: normalizedOwner,
      startedAtUnixMs: started,
      expiresAtUnixMs: expires,
    }
  }

  async beginNonceReleaseAttempt(
    attempt: P2TRSignatureFraudNonceReleaseAttempt,
    invokedAtUnixMs: number
  ): Promise<boolean> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.beginNonceReleaseAttempt(attempt, invokedAtUnixMs)
      )
    }
    this.assertSession()
    const attemptOwner = requireCanonicalOwner(
      attempt.owner,
      "Nonce-release invocation owner",
      128
    )
    const releaseID = stripHex(
      bytes32(attempt.releaseRequestID, "Invoked nonce-release request ID")
    )
    const invokedAt = unixMilliseconds(
      invokedAtUnixMs,
      "Nonce-release invocation time"
    )
    const inserted = await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_release_invocation (
          release_request_id, attempt_sequence, owner, invoked_at_unix_ms
       ) VALUES (decode($1, 'hex'), $2, $3, $4)
       ON CONFLICT (release_request_id, attempt_sequence) DO NOTHING
       RETURNING release_request_id`,
      [
        releaseID,
        positiveSafeInteger(
          attempt.attemptSequence,
          "Invoked nonce-release attempt sequence"
        ),
        attemptOwner,
        invokedAt,
      ]
    )
    return inserted.rowCount === 1
  }

  async recordNonceReleaseAttemptResult(
    attempt: P2TRSignatureFraudNonceReleaseAttempt,
    result: P2TRSignatureFraudNonceReleaseAttemptResult
  ): Promise<"acknowledged" | "ambiguous"> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.recordNonceReleaseAttemptResult(attempt, result)
      )
    }
    this.assertSession()
    const attemptOwner = requireCanonicalOwner(
      attempt.owner,
      "Nonce-release result owner",
      128
    )
    const releaseID = stripHex(
      bytes32(attempt.releaseRequestID, "Completed nonce-release request ID")
    )
    type ReleaseLaneRow = {
      record_id: Buffer
      generation: string | number
      series_id: Buffer
      chain_id: string | number
      signer_lane_id: string
      signer_identity: string
      sender: Buffer
    }
    const requestState = await this.options.session.query<ReleaseLaneRow>(
      `SELECT r.record_id, r.generation, o.series_id, r.chain_id,
              r.signer_lane_id, r.signer_identity, r.sender
         FROM p2tr_signature_fraud_challenge_nonce_release_request r
         JOIN p2tr_signature_fraud_challenge_outbox o
           ON o.record_id = r.record_id
          AND o.generation = r.generation
        WHERE r.release_request_id = decode($1, 'hex')
        FOR UPDATE OF r`,
      [releaseID]
    )
    if (requestState.rows.length !== 1) {
      throw new Error("Nonce-release request does not exist")
    }
    const attemptState = await this.options.session.query<{
      attempt_sequence: string | number
      owner: string
      started_at_unix_ms: string | number
      expires_at_unix_ms: string | number
      latest_sequence: string | number
    }>(
      `SELECT a.attempt_sequence,
              a.owner,
              a.started_at_unix_ms,
              a.expires_at_unix_ms,
              (SELECT max(all_attempts.attempt_sequence)
                 FROM p2tr_signature_fraud_challenge_nonce_release_attempt all_attempts
                WHERE all_attempts.release_request_id = a.release_request_id
              ) AS latest_sequence
         FROM p2tr_signature_fraud_challenge_nonce_release_attempt a
        WHERE a.release_request_id = decode($1, 'hex')
          AND a.attempt_sequence = $2`,
      [releaseID, attempt.attemptSequence]
    )
    if (attemptState.rows.length !== 1) {
      throw new Error("Nonce-release attempt does not exist")
    }
    const state = attemptState.rows[0]
    if (
      state.owner !== attemptOwner ||
      databaseSafeInteger(
        state.started_at_unix_ms,
        "Persisted nonce-release attempt start"
      ) !== attempt.startedAtUnixMs ||
      databaseSafeInteger(
        state.expires_at_unix_ms,
        "Persisted nonce-release attempt expiration"
      ) !== attempt.expiresAtUnixMs
    ) {
      throw new Error(
        "Nonce-release attempt token does not match durable state"
      )
    }
    const recordedAtUnixMs = unixMilliseconds(
      result.recordedAtUnixMs,
      "Nonce-release result time"
    )
    const successful =
      result.kind === "released" || result.kind === "already-released"
    const currentAndOnTime =
      databaseSafeInteger(
        state.latest_sequence,
        "Latest nonce-release attempt sequence"
      ) === attempt.attemptSequence &&
      recordedAtUnixMs >= attempt.startedAtUnixMs &&
      recordedAtUnixMs <=
        databaseSafeInteger(
          state.expires_at_unix_ms,
          "Nonce-release attempt expiration"
        )
    const resultKind =
      successful && !currentAndOnTime ? "ambiguous-late" : result.kind
    let acknowledgement:
      | Extract<
          P2TRSignatureFraudNonceReleaseAttemptResult,
          { kind: "released" | "already-released" }
        >["acknowledgement"]
      | undefined
    let responseDigest: string
    let detail: string
    if (result.kind === "released" || result.kind === "already-released") {
      acknowledgement = result.acknowledgement
      responseDigest = bytes32(
        acknowledgement.responseDigest,
        "Nonce-release provider response digest"
      )
      detail = `${resultKind}:${acknowledgement.outcome}`
    } else {
      if (!("responseDigest" in result) || !("detail" in result)) {
        throw new Error("Nonce-release result shape is invalid")
      }
      responseDigest = bytes32(
        result.responseDigest,
        "Nonce-release error response digest"
      )
      detail = requireText(result.detail, "Nonce-release result detail", 1024)
    }
    const returnedReleaseRequestID =
      acknowledgement !== undefined
        ? bytes32(
            acknowledgement.releaseRequestID,
            "Returned nonce-release request ID"
          )
        : result.kind === "contract-mismatch" &&
          result.returnedReleaseRequestID !== undefined
        ? bytes32(
            result.returnedReleaseRequestID,
            "Mismatched returned nonce-release request ID"
          )
        : undefined
    const returnedReservationID =
      acknowledgement !== undefined
        ? bytes32(
            acknowledgement.reservationID,
            "Returned nonce-release reservation ID"
          )
        : result.kind === "contract-mismatch" &&
          result.returnedReservationID !== undefined
        ? bytes32(
            result.returnedReservationID,
            "Mismatched returned nonce-release reservation ID"
          )
        : undefined

    let mismatchLanes: ReleaseLaneRow[] = []
    if (resultKind === "contract-mismatch") {
      const durableRequest = requestState.rows[0]
      const returnedLanes = await this.options.session.query<ReleaseLaneRow>(
        `SELECT DISTINCT g.record_id, o.generation, o.series_id, g.chain_id,
                g.signer_lane_id, g.signer_identity, g.sender
           FROM p2tr_signature_fraud_challenge_nonce_guard g
           JOIN p2tr_signature_fraud_challenge_outbox o
             ON o.record_id = g.record_id
           LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_request rr
             ON rr.nonce_guard_id = g.nonce_guard_id
          WHERE g.nonce_guard_id = decode($1, 'hex')
             OR rr.release_request_id = decode($2, 'hex')`,
        [
          returnedReservationID === undefined
            ? null
            : stripHex(returnedReservationID),
          returnedReleaseRequestID === undefined
            ? null
            : stripHex(returnedReleaseRequestID),
        ]
      )
      const affectedLanes = new Map<string, ReleaseLaneRow>()
      for (const lane of [durableRequest, ...returnedLanes.rows]) {
        const key = `${lane.chain_id}:${lane.signer_lane_id}:${
          lane.signer_identity
        }:${prefixedHex(lane.sender)}`
        affectedLanes.set(key, lane)
      }
      mismatchLanes = [...affectedLanes.values()].sort((left, right) =>
        `${left.chain_id}:${left.signer_lane_id}:${
          left.signer_identity
        }:${prefixedHex(left.sender)}`.localeCompare(
          `${right.chain_id}:${right.signer_lane_id}:${
            right.signer_identity
          }:${prefixedHex(right.sender)}`
        )
      )
      // Signer state transitions lock the outbox row, then its configured lane,
      // then the global I/O barrier. Use that same total order for every lane
      // affected by a malformed allocator acknowledgement so the post-I/O
      // evidence transaction cannot deadlock and roll itself back.
      for (const lane of mismatchLanes) {
        const outboxLock = await this.options.session.query(
          `SELECT 1
             FROM p2tr_signature_fraud_challenge_outbox
            WHERE record_id = decode($1, 'hex')
            FOR UPDATE`,
          [stripHex(prefixedHex(lane.record_id))]
        )
        if (outboxLock.rows.length !== 1) {
          throw new Error("Mismatched nonce release lacks its outbox record")
        }
      }
      for (const lane of mismatchLanes) {
        const laneLock = await this.options.session.query(
          `SELECT 1
             FROM p2tr_signature_fraud_signer_lane_configuration c
             JOIN p2tr_signature_fraud_challenge_outbox o
               ON o.activation_manifest_hash = c.activation_manifest_hash
            WHERE o.record_id = decode($1, 'hex')
              AND c.chain_id = $2
              AND c.signer_lane_id = $3
              AND c.signer_identity = $4
              AND c.sender = decode($5, 'hex')
            FOR UPDATE OF c`,
          [
            stripHex(prefixedHex(lane.record_id)),
            databaseSafeInteger(lane.chain_id, "Mismatched release chain ID"),
            lane.signer_lane_id,
            lane.signer_identity,
            stripHex(prefixedHex(lane.sender)),
          ]
        )
        if (laneLock.rows.length !== 1) {
          throw new Error("Mismatched nonce release lacks its configured lane")
        }
      }
    }
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_release_result (
          release_request_id, attempt_sequence, result_kind,
          returned_release_request_id, returned_reservation_id,
          response_digest, detail_digest, recorded_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), $2, $3, decode($4, 'hex'), decode($5, 'hex'),
          decode($6, 'hex'), decode($7, 'hex'), $8
       ) ON CONFLICT (release_request_id, attempt_sequence) DO NOTHING`,
      [
        releaseID,
        attempt.attemptSequence,
        resultKind,
        returnedReleaseRequestID === undefined
          ? null
          : stripHex(returnedReleaseRequestID),
        returnedReservationID === undefined
          ? null
          : stripHex(returnedReservationID),
        stripHex(responseDigest),
        stripHex(hashText(detail)),
        recordedAtUnixMs,
      ]
    )
    if (resultKind === "contract-mismatch") {
      const durableRequest = requestState.rows[0]
      for (const lane of mismatchLanes) {
        const quarantine: P2TRSignatureFraudSignerQuarantine = {
          laneID: lane.signer_lane_id,
          signerIdentity: lane.signer_identity,
          expectedSender: prefixedHex(lane.sender),
          reasonCode: "reservation-provider-failure",
          quarantinedAtUnixMs: recordedAtUnixMs,
          reason: detail,
          detailsDigest: responseDigest,
        }
        await this.options.session.query(
          `INSERT INTO p2tr_signature_fraud_challenge_signer_quarantine (
              signer_quarantine_id, record_id, nonce_reservation_id, chain_id,
              signer_lane_id, signer_identity, expected_sender, expected_nonce,
              quarantine_reason, details_digest, quarantined_at_unix_ms
           ) VALUES (
              decode($1, 'hex'), decode($2, 'hex'), NULL, $3, $4, $5,
              decode($6, 'hex'), NULL, 'reservation-provider-failure',
              decode($7, 'hex'), $8
           ) ON CONFLICT DO NOTHING`,
          [
            stripHex(signerQuarantineID(quarantine)),
            stripHex(prefixedHex(lane.record_id)),
            databaseSafeInteger(lane.chain_id, "Mismatched release chain ID"),
            lane.signer_lane_id,
            lane.signer_identity,
            stripHex(prefixedHex(lane.sender)),
            stripHex(responseDigest),
            recordedAtUnixMs,
          ]
        )
      }
      await this.saveCriticalAlert({
        code: "reservation-release-failed",
        seriesID: prefixedHex(durableRequest.series_id),
        recordID: prefixedHex(durableRequest.record_id),
        generation: databaseSafeInteger(
          durableRequest.generation,
          "Mismatched release generation"
        ),
        activationBlocking: true,
        createdAtUnixMs: recordedAtUnixMs,
        detail,
      })
    }
    const persisted = await this.options.session.query<{ result_kind: string }>(
      `SELECT result_kind
         FROM p2tr_signature_fraud_challenge_nonce_release_result
        WHERE release_request_id = decode($1, 'hex')
          AND attempt_sequence = $2`,
      [releaseID, attempt.attemptSequence]
    )
    return persisted.rows[0]?.result_kind === "released" ||
      persisted.rows[0]?.result_kind === "already-released"
      ? "acknowledged"
      : "ambiguous"
  }

  async resolveAmbiguousNonceRelease(
    resolution: P2TRSignatureFraudIndependentNonceReleaseResolution
  ): Promise<"acknowledged" | "unsafe"> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.resolveAmbiguousNonceRelease(resolution)
      )
    }
    this.assertSession()
    const releaseRequestID = bytes32(
      resolution.releaseRequestID,
      "Resolved nonce-release request ID"
    )
    const attemptSequence = positiveSafeInteger(
      resolution.attemptSequence,
      "Resolved nonce-release attempt sequence"
    )
    const attemptOwner = requireCanonicalOwner(
      resolution.attemptOwner,
      "Resolved nonce-release attempt owner",
      128
    )
    const attemptStartedAtUnixMs = unixMilliseconds(
      resolution.attemptStartedAtUnixMs,
      "Resolved nonce-release attempt start"
    )
    const attemptExpiresAtUnixMs = unixMilliseconds(
      resolution.attemptExpiresAtUnixMs,
      "Resolved nonce-release attempt expiration"
    )
    const invokedAtUnixMs = unixMilliseconds(
      resolution.invokedAtUnixMs,
      "Resolved nonce-release invocation time"
    )
    const resolvedAtUnixMs = unixMilliseconds(
      resolution.resolvedAtUnixMs,
      "Independent nonce-release resolution time"
    )
    if (
      attemptExpiresAtUnixMs <= attemptStartedAtUnixMs ||
      invokedAtUnixMs < attemptStartedAtUnixMs ||
      invokedAtUnixMs > attemptExpiresAtUnixMs ||
      !["released", "already-released", "terminal-unsafe"].includes(
        resolution.outcome
      )
    ) {
      throw new Error("Independent nonce-release resolution is malformed")
    }
    const providerEvidenceDigest = bytes32(
      resolution.providerEvidenceDigest,
      "Nonce-release provider evidence digest"
    )
    const evidenceDigest = bytes32(
      resolution.evidenceDigest,
      "Independent nonce-release resolution digest"
    )
    if (
      computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest({
        releaseRequestID,
        attemptSequence,
        attemptOwner,
        attemptStartedAtUnixMs,
        attemptExpiresAtUnixMs,
        invokedAtUnixMs,
        outcome: resolution.outcome,
        providerEvidenceDigest,
      }) !== evidenceDigest
    ) {
      throw new Error("Independent nonce-release resolution digest is invalid")
    }
    if (
      !Array.isArray(resolution.canonicalAttestations) ||
      resolution.canonicalAttestations.length !== 2
    ) {
      throw new Error(
        "Independent nonce-release resolution requires exactly two attestations"
      )
    }
    const [primary, corroborating] = resolution.canonicalAttestations
    const primaryTrustDomainID = requireText(
      primary.trustDomainID,
      "Primary release-resolution trust domain",
      128
    )
    const corroboratingTrustDomainID = requireText(
      corroborating.trustDomainID,
      "Corroborating release-resolution trust domain",
      128
    )
    const primaryIndependenceDomainID = requireText(
      primary.independenceDomainID,
      "Primary release-resolution independence domain",
      128
    )
    const corroboratingIndependenceDomainID = requireText(
      corroborating.independenceDomainID,
      "Corroborating release-resolution independence domain",
      128
    )
    const primaryAttestation = hexData(
      primary.attestation,
      "Primary release-resolution attestation"
    )
    const corroboratingAttestation = hexData(
      corroborating.attestation,
      "Corroborating release-resolution attestation"
    )
    if (
      primaryTrustDomainID === corroboratingTrustDomainID ||
      primaryIndependenceDomainID === corroboratingIndependenceDomainID ||
      primaryAttestation === corroboratingAttestation ||
      primaryAttestation === "0x" ||
      corroboratingAttestation === "0x" ||
      primaryAttestation.length > 4098 ||
      corroboratingAttestation.length > 4098 ||
      bytes32(primary.evidenceDigest, "Primary release evidence digest") !==
        evidenceDigest ||
      bytes32(
        corroborating.evidenceDigest,
        "Corroborating release evidence digest"
      ) !== evidenceDigest
    ) {
      throw new Error(
        "Independent nonce-release attestations do not bind the same evidence across distinct domains"
      )
    }
    const primaryAttestedAtUnixMs = unixMilliseconds(
      primary.attestedAtUnixMs,
      "Primary release-resolution attestation time"
    )
    const corroboratingAttestedAtUnixMs = unixMilliseconds(
      corroborating.attestedAtUnixMs,
      "Corroborating release-resolution attestation time"
    )

    const invocationState = await this.options.session.query<{
      owner: string
      started_at_unix_ms: string | number
      expires_at_unix_ms: string | number
      invoked_at_unix_ms: string | number
      response_digest: Buffer | null
      result_kind: string | null
    }>(
      `SELECT a.owner, a.started_at_unix_ms, a.expires_at_unix_ms,
              i.invoked_at_unix_ms, x.response_digest, x.result_kind
         FROM p2tr_signature_fraud_challenge_nonce_release_request r
         JOIN p2tr_signature_fraud_challenge_nonce_release_attempt a
           ON a.release_request_id = r.release_request_id
          AND a.attempt_sequence = $2
         JOIN p2tr_signature_fraud_challenge_nonce_release_invocation i
           ON i.release_request_id = a.release_request_id
          AND i.attempt_sequence = a.attempt_sequence
         LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_result x
           ON x.release_request_id = a.release_request_id
          AND x.attempt_sequence = a.attempt_sequence
        WHERE r.release_request_id = decode($1, 'hex')
        FOR UPDATE OF r, a`,
      [stripHex(releaseRequestID), attemptSequence]
    )
    if (invocationState.rows.length !== 1) {
      throw new Error("Ambiguous nonce-release invocation does not exist")
    }
    const state = invocationState.rows[0]
    if (
      state.owner !== attemptOwner ||
      databaseSafeInteger(state.started_at_unix_ms, "Stored release start") !==
        attemptStartedAtUnixMs ||
      databaseSafeInteger(
        state.expires_at_unix_ms,
        "Stored release expiration"
      ) !== attemptExpiresAtUnixMs ||
      databaseSafeInteger(
        state.invoked_at_unix_ms,
        "Stored release invocation"
      ) !== invokedAtUnixMs ||
      (state.result_kind !== null && state.result_kind !== "ambiguous-error")
    ) {
      throw new Error(
        "Independent resolution does not bind the exact ambiguous invocation"
      )
    }
    const existing = await this.options.session.query<{
      outcome: "released" | "already-released" | "terminal-unsafe"
      resolution_evidence_digest: Buffer
    }>(
      `SELECT outcome, resolution_evidence_digest
         FROM p2tr_signature_fraud_challenge_nonce_release_resolution
        WHERE release_request_id = decode($1, 'hex')
          AND attempt_sequence = $2`,
      [stripHex(releaseRequestID), attemptSequence]
    )
    if (existing.rows.length === 1) {
      if (
        existing.rows[0].outcome !== resolution.outcome ||
        prefixedHex(existing.rows[0].resolution_evidence_digest) !==
          evidenceDigest
      ) {
        throw new Error("Independent nonce-release resolution conflicts")
      }
      return resolution.outcome === "terminal-unsafe"
        ? "unsafe"
        : "acknowledged"
    }
    const request = await this.getNonceReleaseRequest(releaseRequestID)
    if (request === undefined) {
      throw new Error("Independent resolution lacks its release request")
    }
    const outboxLock = await this.options.session.query(
      `SELECT 1
         FROM p2tr_signature_fraud_challenge_outbox
        WHERE record_id = decode($1, 'hex')
        FOR UPDATE`,
      [stripHex(bytes32(request.recordID, "Resolved release outbox record ID"))]
    )
    if (outboxLock.rows.length !== 1) {
      throw new Error("Independent resolution lacks its locked outbox record")
    }
    const invocation: P2TRSignatureFraudAmbiguousNonceReleaseInvocation = {
      request,
      attempt: {
        releaseRequestID,
        attemptSequence,
        owner: attemptOwner,
        startedAtUnixMs: attemptStartedAtUnixMs,
        expiresAtUnixMs: attemptExpiresAtUnixMs,
      },
      invokedAtUnixMs,
      ambiguousResponseDigest:
        state.response_digest === null
          ? undefined
          : prefixedHex(state.response_digest),
    }
    if (
      (await this.options.assertIndependentNonceReleaseResolution(
        invocation,
        resolution
      )) !== true
    ) {
      throw new Error(
        "Independent nonce-release resolution authentication failed"
      )
    }
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_release_resolution (
          release_request_id, attempt_sequence, attempt_owner,
          attempt_started_at_unix_ms, attempt_expires_at_unix_ms,
          invoked_at_unix_ms, outcome, provider_evidence_digest,
          resolution_evidence_digest, primary_trust_domain_id,
          primary_independence_domain_id, primary_evidence_digest,
          primary_attestation, primary_attested_at_unix_ms,
          corroborating_trust_domain_id,
          corroborating_independence_domain_id,
          corroborating_evidence_digest, corroborating_attestation,
          corroborating_attested_at_unix_ms, resolved_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), $2, $3, $4, $5, $6, $7,
          decode($8, 'hex'), decode($9, 'hex'), $10, $11,
          decode($9, 'hex'), decode($12, 'hex'), $13, $14, $15,
          decode($9, 'hex'), decode($16, 'hex'), $17, $18
       )`,
      [
        stripHex(releaseRequestID),
        attemptSequence,
        attemptOwner,
        attemptStartedAtUnixMs,
        attemptExpiresAtUnixMs,
        invokedAtUnixMs,
        resolution.outcome,
        stripHex(providerEvidenceDigest),
        stripHex(evidenceDigest),
        primaryTrustDomainID,
        primaryIndependenceDomainID,
        stripHex(primaryAttestation),
        primaryAttestedAtUnixMs,
        corroboratingTrustDomainID,
        corroboratingIndependenceDomainID,
        stripHex(corroboratingAttestation),
        corroboratingAttestedAtUnixMs,
        resolvedAtUnixMs,
      ]
    )
    if (resolution.outcome === "terminal-unsafe") {
      const record = await this.get(request.recordID)
      if (record === undefined) {
        throw new Error(
          "Unsafe nonce-release resolution lost its outbox record"
        )
      }
      await this.saveCriticalAlert({
        code: "nonce-release-terminal-unsafe",
        seriesID: record.seriesID,
        recordID: record.recordID,
        generation: record.generation,
        activationBlocking: true,
        createdAtUnixMs: resolvedAtUnixMs,
        detail:
          "Independent allocator reconciliation proved a terminal unsafe nonce-release outcome",
      })
      return "unsafe"
    }
    return "acknowledged"
  }

  /**
   * Resolves one exact ORPHANED signer boundary: the durable pre-I/O marker
   * left behind when the owning process died between the boundary CAS and any
   * observable signer result.
   *
   * The marker is committed before boundary authorization and therefore before
   * the signer RPC, so nothing inside the process-local recovery path may clear
   * it — `recoverExpiredPreparation` deliberately refuses, because a lease
   * timeout is not proof that a remote call stopped. Meanwhile the marker holds
   * the lane's `active_signer_invocation_count` at one, which blocks every
   * nonce-release invocation on that lane and freezes challenge signing for
   * that account. Only out-of-band, dual-attested evidence of what the signer actually
   * did can break that, and every effect below lands in one transaction.
   */
  async resolveOrphanedSignerBoundary(
    resolution: P2TRSignatureFraudIndependentSignerBoundaryResolution
  ): Promise<"acknowledged" | "unsafe"> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.resolveOrphanedSignerBoundary(resolution)
      )
    }
    this.assertSession()
    type StoredSignerBoundaryResolution = {
      outcome: "never-invoked" | "signed" | "terminal-unsafe" | "nonce-consumed"
      resolution_evidence_digest: Buffer
      resolution_evidence_version: 4 | 5
    }
    const loadExisting = async (recordID: string, signerInvocationID: string) =>
      this.options.session.query<StoredSignerBoundaryResolution>(
        `SELECT outcome, resolution_evidence_digest,
                resolution_evidence_version
           FROM p2tr_signature_fraud_challenge_signer_boundary_resolution
          WHERE record_id = decode($1, 'hex')
            AND signer_invocation_id = decode($2, 'hex')`,
        [stripHex(recordID), stripHex(signerInvocationID)]
      )
    const acceptLegacyV4Replay = (
      existing: StoredSignerBoundaryResolution
    ): "acknowledged" | "unsafe" => {
      let legacy
      try {
        legacy =
          validateP2TRSignatureFraudLegacyV4SignerBoundaryResolutionReplay(
            resolution
          )
      } catch {
        throw new Error("Independent signer-boundary resolution conflicts")
      }
      if (
        existing.outcome !== legacy.outcome ||
        prefixedHex(existing.resolution_evidence_digest) !==
          legacy.evidenceDigest
      ) {
        throw new Error("Independent signer-boundary resolution conflicts")
      }
      return legacy.outcome === "terminal-unsafe" ? "unsafe" : "acknowledged"
    }
    let normalized
    try {
      normalized =
        validateP2TRSignatureFraudIndependentSignerBoundaryResolution(
          resolution
        )
    } catch (validationError) {
      // A pre-006 response may be retried after the database committed its v4
      // evidence but before the caller observed the response. Look up only by
      // the two bounded identity fields, then accept solely an exact, fully
      // validated replay of a row migration 006 marked as grandfathered.
      const recordID = bytes32(
        resolution.recordID,
        "Orphaned signer boundary record ID"
      )
      const signerInvocationID = bytes32(
        resolution.signerInvocationID,
        "Orphaned signer boundary invocation ID"
      )
      const existing = await loadExisting(recordID, signerInvocationID)
      if (
        existing.rows.length !== 1 ||
        existing.rows[0].resolution_evidence_version !== 4
      ) {
        throw validationError
      }
      return acceptLegacyV4Replay(existing.rows[0])
    }
    const currentRow = await this.lockRecord(normalized.recordID)
    if (currentRow === undefined) {
      throw new Error(
        "Orphaned signer boundary resolution names an absent outbox record"
      )
    }
    const current = await this.hydrateRow(currentRow)
    const existing = await loadExisting(
      normalized.recordID,
      normalized.signerInvocationID
    )
    if (existing.rows.length === 1) {
      if (existing.rows[0].resolution_evidence_version === 4) {
        return acceptLegacyV4Replay(existing.rows[0])
      }
      if (
        existing.rows[0].outcome !== normalized.outcome ||
        prefixedHex(existing.rows[0].resolution_evidence_digest) !==
          normalized.evidenceDigest
      ) {
        throw new Error("Independent signer-boundary resolution conflicts")
      }
      return normalized.outcome === "terminal-unsafe"
        ? "unsafe"
        : "acknowledged"
    }
    assertP2TRSignatureFraudOrphanedSignerBoundaryOwnership(current, normalized)
    const [primary, corroborating] = normalized.attestations
    // Appended BEFORE the barrier-clearing swap so the guard trigger still sees
    // the live boundary it must bind, and so a rejected swap can never leave
    // evidence claiming a boundary was resolved.
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_signer_boundary_resolution (
          record_id, signer_invocation_id, boundary_started_at_unix_ms,
          preparation_attempts,
          nonce_reservation_id, stage, invoked_at_unix_ms, outcome,
          signed_transaction_hash, provider_evidence_digest,
          resolution_evidence_digest, primary_trust_domain_id,
          primary_independence_domain_id, primary_evidence_digest,
          primary_attestation, primary_attested_at_unix_ms,
          corroborating_trust_domain_id,
          corroborating_independence_domain_id,
          corroborating_evidence_digest, corroborating_attestation,
          corroborating_attested_at_unix_ms, resolved_at_unix_ms,
          provider_tombstone_receipt, provider_tombstone_at_unix_ms,
          nonce_consumption_chain_id, nonce_consumption_nonce,
          nonce_consumption_account_nonce, nonce_consumption_read_at_block,
          nonce_consumption_transaction_hash,
          nonce_consumption_finalized_block_number,
          nonce_consumption_finalized_block_hash,
          nonce_consumption_observed_head_block_number,
          nonce_consumption_observed_head_block_hash,
          resolution_evidence_version
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), $3, $4,
          decode($5, 'hex'), $6, $7, $8,
          CASE WHEN $9::text IS NULL THEN NULL ELSE decode($9, 'hex') END,
          decode($10, 'hex'), decode($11, 'hex'), $12, $13,
          decode($11, 'hex'), decode($14, 'hex'), $15, $16, $17,
          decode($11, 'hex'), decode($18, 'hex'), $19, $20,
          CASE WHEN $21::text IS NULL THEN NULL ELSE decode($21, 'hex') END,
          $22,
          $23, $24, $25, $26,
          CASE WHEN $27::text IS NULL THEN NULL ELSE decode($27, 'hex') END,
          $28,
          CASE WHEN $29::text IS NULL THEN NULL ELSE decode($29, 'hex') END,
          $30,
          CASE WHEN $31::text IS NULL THEN NULL ELSE decode($31, 'hex') END,
          5
       )`,
      [
        stripHex(normalized.recordID),
        stripHex(normalized.signerInvocationID),
        normalized.boundaryStartedAtUnixMs,
        normalized.preparationAttempts,
        stripHex(normalized.nonceReservationID),
        normalized.stage,
        normalized.invokedAtUnixMs,
        normalized.outcome,
        normalized.signedTransactionHash === undefined
          ? null
          : stripHex(normalized.signedTransactionHash),
        stripHex(normalized.providerEvidenceDigest),
        stripHex(normalized.evidenceDigest),
        primary.trustDomainID,
        primary.independenceDomainID,
        stripHex(primary.attestation),
        primary.attestedAtUnixMs,
        corroborating.trustDomainID,
        corroborating.independenceDomainID,
        stripHex(corroborating.attestation),
        corroborating.attestedAtUnixMs,
        normalized.resolvedAtUnixMs,
        normalized.providerTombstone === undefined
          ? null
          : stripHex(normalized.providerTombstone.receipt),
        normalized.providerTombstone?.tombstonedAtUnixMs ?? null,
        normalized.nonceConsumption?.chainID ?? null,
        normalized.nonceConsumption?.transactionNonce ?? null,
        normalized.nonceConsumption?.finalizedAccountNonce ?? null,
        normalized.nonceConsumption?.accountNonceReadAtBlock ?? null,
        normalized.nonceConsumption === undefined
          ? null
          : stripHex(
              normalized.nonceConsumption.consumingTransaction.transactionHash
            ),
        normalized.nonceConsumption?.finalizedThrough.blockNumber ?? null,
        normalized.nonceConsumption === undefined
          ? null
          : stripHex(normalized.nonceConsumption.finalizedThrough.blockHash),
        normalized.nonceConsumption?.observedHead.blockNumber ?? null,
        normalized.nonceConsumption === undefined
          ? null
          : stripHex(normalized.nonceConsumption.observedHead.blockHash),
      ]
    )
    if (normalized.outcome === "never-invoked") {
      // The same retirement path a first-person uninvoked completion uses: the
      // swap that clears the marker and the retirement of the incidents raised
      // over that exact boundary must land in one transaction.
      const cleared: P2TRSignatureFraudChallengeOutboxRecord = {
        ...current,
        version: current.version + 1,
        activeSignerInvocationStartedAtUnixMs: undefined,
        activeSignerInvocationID: undefined,
        updatedAtUnixMs: Math.max(
          current.updatedAtUnixMs,
          normalized.resolvedAtUnixMs
        ),
        lastError:
          "Independent attestation proved the orphaned signer boundary never reached the signer",
      }
      if (
        !(await this.compareAndSwapRetiringUninvokedSignerBoundary(
          normalized.recordID,
          current.version,
          cleared,
          {
            signerInvocationID: normalized.signerInvocationID,
            startedAtUnixMs: normalized.boundaryStartedAtUnixMs,
            preparationAttempts: normalized.preparationAttempts,
            nonceReservationID: normalized.nonceReservationID,
          },
          normalized.resolvedAtUnixMs
        ))
      ) {
        throw new Error(
          "Orphaned signer boundary resolution lost its barrier-clearing swap"
        )
      }
      return "acknowledged"
    }
    if (normalized.outcome === "nonce-consumed") {
      const consumption = normalized.nonceConsumption
      if (consumption === undefined) {
        throw new Error(
          "Nonce-consumed signer boundary resolution lost its consumption evidence"
        )
      }
      // NOT the never-invoked shape. Clearing the marker and stopping would
      // leave the record in `preparing` with a live reservation, which lease
      // recovery treats as pre-signer: it would void the nonce guard and hand
      // the nonce back to the allocator, dropping the partial-unique index that
      // stops a second reservation at it. The whole claim is that the nonce is
      // SPENT, not free. So the record moves to `generation-required`, a status
      // the guard-void trigger permanently refuses to free a nonce from, while
      // the reservation is retained so a late signer envelope stays capturable.
      //
      // `quarantined`, not `generation-required`: the latter requires a linked
      // nonce-disposition row, and producing one from here would mean
      // reconciling a record whose signer may still be live. `quarantined` is
      // itself reconcilable, so the ordinary reconcile loop takes it to a
      // disposition and a successor generation through the normal path — this
      // resolution only has to clear the barrier and keep the nonce unfreeable.
      const settled: P2TRSignatureFraudChallengeOutboxRecord = {
        ...current,
        version: current.version + 1,
        status: "quarantined",
        // `quarantined` with a returned-signer marker requires a signer
        // quarantine, and the honest one is ambiguity: the signer was invoked
        // and nothing here establishes what it did. The chain settled the
        // NONCE, not the signer's behaviour.
        signerQuarantines:
          current.signerInvocationStartedAtUnixMs === undefined ||
          current.reservedNonce === undefined
            ? current.signerQuarantines
            : appendSignerQuarantine(
                current.signerQuarantines,
                current.reservedNonce,
                normalized.resolvedAtUnixMs,
                "The reserved nonce was consumed at finality while this signer invocation was unresolved",
                "ambiguous-signer-invocation"
              ),
        preparationLease: undefined,
        preparationResumeStatus: undefined,
        activeSignerInvocationStartedAtUnixMs: undefined,
        activeSignerInvocationID: undefined,
        updatedAtUnixMs: Math.max(
          current.updatedAtUnixMs,
          normalized.resolvedAtUnixMs
        ),
        lastError:
          "The reserved nonce was consumed at finality, so any signer bytes for it are inert",
      }
      if (
        !(await this.compareAndSwapLocked(
          normalized.recordID,
          current.version,
          settled
        ))
      ) {
        throw new Error(
          "Nonce-consumed signer boundary resolution lost its barrier-clearing swap"
        )
      }
      return "acknowledged"
    }
    if (normalized.outcome === "terminal-unsafe") {
      await this.saveCriticalAlert({
        code: "signer-boundary-terminal-unsafe",
        seriesID: current.seriesID,
        recordID: current.recordID,
        generation: current.generation,
        activationBlocking: true,
        createdAtUnixMs: normalized.resolvedAtUnixMs,
        detail:
          "Independent reconciliation proved a terminal unsafe orphaned signer boundary outcome",
      })
      return "unsafe"
    }
    // `signed`: the boundary is deliberately RETAINED. It is the only thing
    // that still authorizes `captureEscapedSignedArtifact` to quarantine the
    // escaped bytes against this exact reservation, and clearing it here would
    // silently release a nonce whose signed envelope is loose.
    return "acknowledged"
  }

  async compareAndSwap(
    recordID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.compareAndSwap(recordID, expectedVersion, next)
      )
    }
    this.assertSession()
    return this.compareAndSwapLocked(recordID, expectedVersion, next)
  }

  /**
   * Compare-and-swap that additionally retires the activation-blocking
   * incidents raised over one exact signer boundary that provably never
   * reached the signer.
   *
   * The incident is raised the moment invalidation observes an active
   * boundary, because the boundary marker is durable BEFORE authorization and
   * therefore before any signer call — at that instant the store cannot tell
   * "stuck in authorization" from "signer call outstanding". Only the
   * boundary's owner witnesses authorization failing before signer I/O, and
   * that same first-person observation is already trusted to clear the
   * lane's signer barrier. Retirement is therefore performed in the SAME
   * transaction as the barrier-clearing swap: never resolve-then-clear (which
   * would unblock activation while the barrier is still live) and never
   * clear-then-resolve (which strands a permanently blocking incident).
   *
   * Only boundary-shaped incident kinds are retired. Escape-shaped kinds are
   * unreachable here and are additionally refused by the database trigger.
   */
  async compareAndSwapRetiringUninvokedSignerBoundary(
    recordID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord,
    boundary: {
      signerInvocationID: string
      startedAtUnixMs: number
      preparationAttempts: number
      nonceReservationID: string
    },
    resolvedAtUnixMs: number
  ): Promise<boolean> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.compareAndSwapRetiringUninvokedSignerBoundary(
          recordID,
          expectedVersion,
          next,
          boundary,
          resolvedAtUnixMs
        )
      )
    }
    this.assertSession()
    const swapped = await this.compareAndSwapLocked(
      recordID,
      expectedVersion,
      next
    )
    if (!swapped) return false
    await this.retireUninvokedBoundaryIncidents(
      recordID,
      boundary,
      resolvedAtUnixMs
    )
    return true
  }

  private async retireUninvokedBoundaryIncidents(
    recordID: string,
    boundary: {
      signerInvocationID: string
      startedAtUnixMs: number
      preparationAttempts: number
      nonceReservationID: string
    },
    resolvedAtUnixMs: number
  ): Promise<void> {
    const normalizedRecordID = bytes32(
      recordID,
      "Uninvoked boundary retirement record ID"
    )
    if (
      !Number.isSafeInteger(boundary.preparationAttempts) ||
      boundary.preparationAttempts < 0
    ) {
      throw new Error(
        "Uninvoked boundary preparation attempts must be a non-negative integer"
      )
    }
    const startedAtUnixMs = unixMilliseconds(
      boundary.startedAtUnixMs,
      "Uninvoked boundary start time"
    )
    // The reservation ID reaches this boundary either as a `Hex` rendered
    // without its prefix or as an already-prefixed string, depending on
    // whether the record has round-tripped through the durable JSON state.
    const nonceReservationID = bytes32(
      boundary.nonceReservationID.startsWith("0x")
        ? boundary.nonceReservationID
        : `0x${boundary.nonceReservationID}`,
      "Uninvoked boundary nonce reservation ID"
    )
    const signerInvocationID = bytes32(
      boundary.signerInvocationID.startsWith("0x")
        ? boundary.signerInvocationID
        : `0x${boundary.signerInvocationID}`,
      "Uninvoked boundary signer invocation ID"
    )
    // v2 binds the invocation ID, so both halves of one retirement — this
    // incident row and the signer-boundary resolution committed in the same
    // transaction — name the same boundary identity.
    const resolutionDigest = hashStructured({
      domain: "tbtc-p2tr-signature-fraud-provenance-incident-resolution-v2",
      recordID: normalizedRecordID,
      signerInvocationID,
      boundaryStartedAtUnixMs: startedAtUnixMs,
      preparationAttempts: boundary.preparationAttempts,
      nonceReservationID,
    })
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_provenance_incident_resolution (
          incident_id, record_id, provenance_invalidation_id,
          signer_invocation_id,
          boundary_started_at_unix_ms, preparation_attempts,
          nonce_reservation_id, resolution_digest, resolved_at_unix_ms
       )
       SELECT incident.incident_id,
              incident.record_id,
              incident.provenance_invalidation_id,
              decode($7, 'hex'), $2, $3, decode($4, 'hex'),
              decode($5, 'hex'), $6
         FROM p2tr_signature_fraud_challenge_provenance_incident incident
        WHERE incident.record_id = decode($1, 'hex')
          AND incident.incident_kind IN (
                'signer-boundary-active',
                'reservation-intent-in-flight'
              )
       ON CONFLICT (incident_id) DO NOTHING`,
      [
        stripHex(normalizedRecordID),
        startedAtUnixMs,
        boundary.preparationAttempts,
        stripHex(nonceReservationID),
        stripHex(resolutionDigest),
        unixMilliseconds(
          resolvedAtUnixMs,
          "Uninvoked boundary retirement time"
        ),
        stripHex(signerInvocationID),
      ]
    )
  }

  async compareAndSwapWithCurrentCanonicalProvenance(
    recordID: string,
    expectedVersion: number,
    expectedProvenance: P2TRSignatureFraudCanonicalProvenanceBinding,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.compareAndSwapWithCurrentCanonicalProvenance(
          recordID,
          expectedVersion,
          expectedProvenance,
          next
        )
      )
    }
    this.assertSession()
    const binding = canonicalClaimBinding(next, expectedProvenance)
    if (
      !(await this.options.lockAndAssertCurrentCanonicalProvenance(
        this.options.session,
        binding
      ))
    ) {
      return false
    }
    return this.compareAndSwapLocked(
      recordID,
      expectedVersion,
      next,
      expectedProvenance
    )
  }

  async captureEscapedSignedArtifact(
    recordID: string,
    expectedProvenanceFingerprint: string,
    artifact: P2TRSignatureFraudUnexpectedSignedArtifact,
    signerQuarantine?: P2TRSignatureFraudSignerQuarantine
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.captureEscapedSignedArtifact(
          recordID,
          expectedProvenanceFingerprint,
          artifact,
          signerQuarantine
        )
      )
    }
    this.assertSession()
    const currentRow = await this.lockRecord(recordID)
    if (currentRow === undefined)
      throw new Error("Outbox record does not exist")
    const current = await this.hydrateRow(currentRow)
    if (
      bytes32(
        current.canonicalProvenance.provenanceFingerprint,
        "Stored provenance fingerprint"
      ) !==
      bytes32(expectedProvenanceFingerprint, "Expected provenance fingerprint")
    ) {
      throw new Error("Escaped signed artifact provenance mismatch")
    }
    const alreadyCaptured = hasSignedTransactionHash(
      current,
      artifact.preparedTransaction.transactionHash.toPrefixedString()
    )
    // A boundary resolved as nonce-consumed has cleared its marker but still
    // retains the reservation, precisely so a late envelope stays capturable:
    // the bytes are inert once the nonce is spent, but losing the RECORD of a
    // signer that leaked them is not acceptable. Authorize this exception from
    // the append-only resolution itself rather than the mutable record status,
    // which may advance again before the signer response arrives.
    const resolvedNonceConsumption =
      current.reservedNonce === undefined
        ? { rowCount: 0 }
        : await this.options.session.query(
            `SELECT 1
               FROM p2tr_signature_fraud_challenge_signer_boundary_resolution
              WHERE record_id = decode($1, 'hex')
                AND outcome = 'nonce-consumed'
                AND nonce_reservation_id = decode($2, 'hex')
              LIMIT 1`,
            [
              stripHex(current.recordID),
              stripHex(current.reservedNonce.reservationID.toPrefixedString()),
            ]
          )
    const retainsResolvedBoundary =
      current.reservedNonce !== undefined &&
      (current.status === "generation-required" ||
        resolvedNonceConsumption.rowCount === 1)
    if (
      alreadyCaptured &&
      current.activeSignerInvocationStartedAtUnixMs === undefined &&
      !retainsResolvedBoundary
    ) {
      return current
    }
    if (
      current.reservedNonce === undefined ||
      (current.activeSignerInvocationStartedAtUnixMs === undefined &&
        !retainsResolvedBoundary) ||
      bytes32(
        current.reservedNonce.reservationID.toPrefixedString(),
        "Stored signer-boundary reservation ID"
      ) !==
        bytes32(artifact.expectedReservationID, "Late artifact reservation ID")
    ) {
      throw new Error(
        "Late signed artifact has no retained durable signer boundary"
      )
    }
    let captureRecord = current
    if (signerQuarantine !== undefined) {
      const existingQuarantineIDs = new Set(
        (current.signerQuarantines ?? []).map(signerQuarantineID)
      )
      if (!existingQuarantineIDs.has(signerQuarantineID(signerQuarantine))) {
        captureRecord = {
          ...current,
          signerQuarantines: [
            ...(current.signerQuarantines ?? []),
            signerQuarantine,
          ],
        }
        // The quarantine and any actual-nonce guard must exist before the
        // escaped-envelope trigger validates the returned wrong-lane bytes.
        await this.syncSignerQuarantines(current, captureRecord)
      }
    }
    if (!alreadyCaptured) {
      await this.insertUnexpectedArtifact(captureRecord, artifact)
    }
    if (
      !alreadyCaptured &&
      current.provenanceInvalidationEvidence !== undefined
    ) {
      await this.insertProvenanceIncident(
        current,
        current.provenanceInvalidationEvidence.evidenceHash,
        "signed-envelope-escaped",
        artifact.reason,
        artifact.capturedAtUnixMs
      )
      await this.saveCriticalAlert({
        code: "provenance-reconciliation-incident",
        seriesID: current.seriesID,
        recordID: current.recordID,
        generation: current.generation,
        activationBlocking: true,
        createdAtUnixMs: artifact.capturedAtUnixMs,
        detail: artifact.reason,
      })
    }
    const artifacts = current.unexpectedSignedArtifacts ?? []
    const next: P2TRSignatureFraudChallengeOutboxRecord = {
      ...captureRecord,
      version: current.version + 1,
      status:
        current.provenanceInvalidationEvidence === undefined
          ? current.status
          : "provenance-invalidated-awaiting-reconciliation",
      preparationLease:
        current.provenanceInvalidationEvidence === undefined
          ? current.preparationLease
          : undefined,
      preparationResumeStatus:
        current.provenanceInvalidationEvidence === undefined
          ? current.preparationResumeStatus
          : undefined,
      updatedAtUnixMs: Math.max(
        current.updatedAtUnixMs,
        artifact.capturedAtUnixMs
      ),
      activeSignerInvocationStartedAtUnixMs: undefined,
      activeSignerInvocationID: undefined,
      signerInvocationStartedAtUnixMs:
        current.signerInvocationStartedAtUnixMs ??
        current.activeSignerInvocationStartedAtUnixMs,
      signerInvocationID:
        current.signerInvocationID ?? current.activeSignerInvocationID,
      unexpectedSignedArtifacts: alreadyCaptured
        ? artifacts
        : [...artifacts, artifact],
    }
    assertCompactDurableOutboxRecord(next)
    const updated = await this.updateMutableState(current, next)
    if (!updated) throw new Error("Escaped artifact CAS unexpectedly failed")
    await this.persistDerivedCriticalAlerts(current, next)
    const expectedLaneArtifact =
      address(
        artifact.preparedTransaction.sender,
        "Captured signed artifact sender"
      ) === address(current.reservedNonce.sender, "Reserved signer sender") &&
      artifact.preparedTransaction.nonce === current.reservedNonce.nonce
    if (!alreadyCaptured) {
      await this.saveCriticalAlert({
        code: expectedLaneArtifact
          ? "late-signed-artifact-captured"
          : "escaped-signed-envelope-captured",
        seriesID: current.seriesID,
        recordID: current.recordID,
        generation: current.generation,
        activationBlocking: true,
        createdAtUnixMs: artifact.capturedAtUnixMs,
        detail: artifact.reason,
      })
    }
    await this.resolveEligibleCriticalAlerts(next)
    return (await this.get(recordID))!
  }

  async invalidateCanonicalProvenance(
    evidence: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence
  ): Promise<readonly P2TRSignatureFraudChallengeOutboxRecord[]> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.invalidateCanonicalProvenance(evidence)
      )
    }
    this.assertSession()
    await this.options.lockAndAssertCanonicalProvenanceInvalidation(
      this.options.session,
      evidence
    )
    const result = await this.options.session.query<
      StoredOutboxRow & { record_id: Buffer }
    >(
      `SELECT record_id, ${STORED_ROW_COLUMNS}
         FROM p2tr_signature_fraud_challenge_outbox
        WHERE canonical_provenance_fingerprint = decode($1, 'hex')
          AND canonical_candidate_digest = decode($2, 'hex')
          AND canonical_candidate_provenance_generation = $3
          AND provenance_invalidation_id IS NULL
          AND status NOT IN (
            'cancelled-before-broadcast', 'cancelled-honest-spend',
            'cancelled-reorg', 'cancelled-provenance-invalidated'
          )
        ORDER BY record_id
        FOR UPDATE`,
      [
        stripHex(
          bytes32(
            evidence.provenanceFingerprint,
            "Invalidated provenance fingerprint"
          )
        ),
        stripHex(
          bytes32(evidence.candidateDigest, "Invalidated candidate digest")
        ),
        positiveSafeInteger(
          evidence.candidateProvenanceGeneration,
          "Invalidated candidate provenance generation"
        ),
      ]
    )
    const transitioned: P2TRSignatureFraudChallengeOutboxRecord[] = []
    for (const row of result.rows) {
      const current = await this.hydrateRow(row)
      await this.insertProvenanceInvalidation(current, evidence)
      const unsignedPreparationInFlight =
        current.status === "preparing" &&
        current.selectedLaneID !== undefined &&
        current.selectedSignerIdentity !== undefined &&
        current.preparationSender !== undefined &&
        current.signerInvocationStartedAtUnixMs === undefined &&
        (current.preparedTransactionVariants?.length ?? 0) === 0 &&
        (current.unexpectedSignedArtifacts?.length ?? 0) === 0 &&
        current.broadcastAttempts === 0
      const activePreparationInFlight =
        current.status === "preparing" &&
        current.preparationLease !== undefined &&
        current.activeSignerInvocationStartedAtUnixMs !== undefined
      const preservePreparationClaim =
        unsignedPreparationInFlight || activePreparationInFlight
      const escaped =
        current.signerInvocationStartedAtUnixMs !== undefined ||
        (current.preparedTransactionVariants?.length ?? 0) > 0 ||
        (current.unexpectedSignedArtifacts?.length ?? 0) > 0 ||
        current.broadcastAttempts > 0
      const terminal = [
        "accepted-own",
        "satisfied-external",
        "terminal-reverted",
        "terminal-nonce-consumed",
        "generation-required",
      ].includes(current.status)
      // A record keeps an activation-blocking provenance incident whenever it
      // escaped, still owns an active signer boundary, or already produced a
      // terminal chain effect. Only a genuinely inactive unsigned preparation
      // is excluded. An active-initial boundary is preserved as `preparing`
      // here, but the worker that later observes the signer RPC return moves
      // it to `provenance-invalidated-awaiting-reconciliation`, and the SQL
      // status trigger refuses that transition without an activation-blocking
      // incident. Omitting it would deadlock the resolver on a rejected CAS.
      // Migration 003's manifest-rotation trigger applies the identical
      // predicate so both invalidation paths preserve the same set.
      const preserveProvenanceIncident =
        escaped || activePreparationInFlight || terminal
      if (preserveProvenanceIncident) {
        await this.insertProvenanceIncident(
          current,
          evidence.evidenceHash,
          provenanceIncidentKind(
            current,
            unsignedPreparationInFlight,
            terminal
          ),
          evidence.reason,
          evidence.invalidatedAtUnixMs
        )
      }
      const next: P2TRSignatureFraudChallengeOutboxRecord = {
        ...current,
        status: preservePreparationClaim
          ? "preparing"
          : terminal
          ? current.status
          : escaped
          ? "provenance-invalidated-awaiting-reconciliation"
          : "cancelled-provenance-invalidated",
        version: current.version + 1,
        provenanceInvalidationEvidence: evidence,
        preparationLease: preservePreparationClaim
          ? current.preparationLease
          : undefined,
        preparationResumeStatus: preservePreparationClaim
          ? current.preparationResumeStatus
          : undefined,
        // Canonical rollback cannot cancel an already-issued signer RPC.
        // Preserve the marker until the caller observes the RPC return and
        // atomically journals its signed bytes or failure disposition.
        activeSignerInvocationStartedAtUnixMs:
          current.activeSignerInvocationStartedAtUnixMs,
        activeSignerInvocationID: current.activeSignerInvocationID,
        updatedAtUnixMs: Math.max(
          current.updatedAtUnixMs,
          evidence.invalidatedAtUnixMs
        ),
        lastError: evidence.reason,
      }
      assertCompactDurableOutboxRecord(next)
      if (!(await this.updateMutableState(current, next))) {
        throw new Error("Canonical provenance invalidation CAS failed")
      }
      if (preserveProvenanceIncident) {
        await this.saveCriticalAlert({
          code: "provenance-reconciliation-incident",
          seriesID: next.seriesID,
          recordID: next.recordID,
          generation: next.generation,
          activationBlocking: true,
          createdAtUnixMs: evidence.invalidatedAtUnixMs,
          detail: evidence.reason,
        })
      }
      transitioned.push(next)
    }
    return transitioned
  }

  async listPage(
    request: P2TRSignatureFraudChallengeOutboxPageRequest
  ): Promise<P2TRSignatureFraudChallengeOutboxPage> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() => this.listPage(request))
    }
    this.assertSession()
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit <= 0 ||
      request.limit > P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE ||
      !Array.isArray(request.statuses) ||
      request.statuses.length === 0
    ) {
      throw new Error("PostgreSQL outbox page request is invalid")
    }
    const cursor =
      request.cursor === undefined
        ? undefined
        : bytes32(request.cursor, "Outbox page cursor")
    const result = await this.options.session.query<
      StoredOutboxRow & { record_id: Buffer }
    >(
      `SELECT record_id, ${STORED_ROW_COLUMNS}
         FROM p2tr_signature_fraud_challenge_outbox
        WHERE status = ANY($1::text[])
          AND ($2::text IS NULL OR record_id > decode($2, 'hex'))
        ORDER BY record_id
        LIMIT $3`,
      [
        request.statuses,
        cursor === undefined ? null : stripHex(cursor),
        request.limit + 1,
      ]
    )
    const pageRows = result.rows.slice(0, request.limit)
    const records: P2TRSignatureFraudChallengeOutboxRecord[] = []
    for (const row of pageRows) records.push(await this.hydrateRow(row))
    return {
      records,
      nextCursor:
        result.rows.length > request.limit
          ? prefixedHex(pageRows[pageRows.length - 1].record_id)
          : undefined,
    }
  }

  async saveLegacyQuarantine(
    quarantine: P2TRSignatureFraudLegacySubmissionQuarantine
  ): Promise<void> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() => this.saveLegacyQuarantine(quarantine))
    }
    this.assertSession()
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_legacy_submission_quarantine (
          observation_id, bridge_challenge_key, legacy_status,
          submission_attempts, challenge_transaction_hash, reason,
          quarantined_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), $3, $4,
          decode($5, 'hex'), $6, $7
       ) ON CONFLICT (observation_id) DO NOTHING`,
      [
        stripHex(bytes32(quarantine.observationID, "Legacy observation ID")),
        optionalStripHex(quarantine.bridgeChallengeKey, "Legacy challenge key"),
        quarantine.legacyStatus,
        nonNegativeSafeInteger(
          quarantine.submissionAttempts,
          "Legacy submission attempts"
        ),
        optionalStripHex(
          quarantine.challengeTxHash,
          "Legacy challenge transaction hash"
        ),
        requireText(quarantine.reason, "Legacy quarantine reason", 1024),
        unixMilliseconds(
          quarantine.quarantinedAtUnixMs,
          "Legacy quarantine time"
        ),
      ]
    )
  }

  async saveCriticalAlert(
    alert: P2TRSignatureFraudOutboxCriticalAlert
  ): Promise<void> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() => this.saveCriticalAlert(alert))
    }
    this.assertSession()
    const alertID = hashStructured({
      domain: "tbtc-p2tr-signature-fraud-outbox-alert-v1",
      recordID: bytes32(alert.recordID, "Critical alert record ID"),
      generation: alert.generation,
      code: alert.code,
    })
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_critical_alert (
          alert_id, series_id, record_id, generation, code, details_digest,
          created_at_unix_ms, activation_blocking
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), decode($3, 'hex'),
          $4, $5, decode($6, 'hex'), $7, true
       ) ON CONFLICT (record_id, generation, code) DO NOTHING`,
      [
        stripHex(alertID),
        stripHex(bytes32(alert.seriesID, "Critical alert series ID")),
        stripHex(bytes32(alert.recordID, "Critical alert record ID")),
        nonNegativeSafeInteger(alert.generation, "Critical alert generation"),
        alert.code,
        stripHex(
          hashText(requireText(alert.detail, "Critical alert detail", 1024))
        ),
        unixMilliseconds(alert.createdAtUnixMs, "Critical alert time"),
      ]
    )
  }

  async runInEligibilityTransaction<T>(
    observationID: string,
    operation: (
      snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
    ) => Promise<T>
  ): Promise<T> {
    if (!this.inTransaction()) {
      return this.runInTransaction(() =>
        this.runInEligibilityTransaction(observationID, operation)
      )
    }
    this.assertSession()
    const normalized = bytes32(observationID, "Eligibility observation ID")
    const snapshot = await this.options.loadEligibilitySnapshot(
      this.options.session,
      normalized
    )
    if (
      hexValue(
        snapshot.challengeRecord.observationID,
        "Snapshot observation ID"
      ) !== normalized
    ) {
      throw new Error(
        "Eligibility loader returned another observation occurrence"
      )
    }
    return operation(snapshot)
  }

  private assertSession(): void {
    this.options.assertTransactionSession(this.options.session)
  }

  private inTransaction(): boolean {
    return this.transaction.getStore() === true
  }

  private async runInTransaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.inTransaction()) return operation()
    return this.options.transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
      () =>
        this.transaction.run(true, async () => {
          this.assertSession()
          return operation()
        })
    )
  }

  private async queryNonceReleaseRequests(
    predicate: string,
    values: readonly unknown[],
    limit: number
  ): Promise<NonceReleaseRequestRow[]> {
    const result = await this.options.session.query<NonceReleaseRequestRow>(
      `SELECT r.release_request_id,
              r.record_id,
              r.generation,
              r.nonce_guard_id,
              r.chain_id,
              r.signer_lane_id,
              r.signer_identity,
              r.sender,
              r.transaction_nonce,
              r.reservation_epoch,
              g.reservation_binding,
              r.void_evidence_digest,
              r.requested_at_unix_ms,
              (SELECT count(*)::bigint
                 FROM p2tr_signature_fraud_challenge_nonce_release_attempt a
                WHERE a.release_request_id = r.release_request_id
              ) AS attempt_count,
              EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_nonce_release_attempt a
                  LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_result x
                    ON x.release_request_id = a.release_request_id
                   AND x.attempt_sequence = a.attempt_sequence
                 WHERE a.release_request_id = r.release_request_id
                   AND (x.result_kind IS NULL OR x.result_kind NOT IN (
                     'released', 'already-released'
                   ))
              ) AS ambiguous
         FROM p2tr_signature_fraud_challenge_nonce_release_request r
         JOIN p2tr_signature_fraud_challenge_nonce_guard g
           ON g.nonce_guard_id = r.nonce_guard_id
        WHERE ${predicate}
        ORDER BY r.release_request_id
        LIMIT ${positiveSafeInteger(limit, "Nonce-release query limit")}`,
      values
    )
    return result.rows
  }

  private async hydrateNonceReleaseRequest(
    row: NonceReleaseRequestRow
  ): Promise<P2TRSignatureFraudNonceReleaseRequest> {
    const recordID = prefixedHex(row.record_id)
    const record = await this.get(recordID)
    if (record === undefined) {
      throw new Error(
        "Nonce-release request references a missing outbox record"
      )
    }
    const reservationID = prefixedHex(row.nonce_guard_id)
    const tombstone = (record.voidedNonceReservations ?? []).find(
      (item) =>
        hexValue(item.reservation.reservationID, "Voided reservation ID") ===
        reservationID
    )
    if (tombstone === undefined) {
      throw new Error(
        "Nonce-release request is absent from the durable record tombstones"
      )
    }
    const reservation = tombstone.reservation
    if (
      record.generation !==
        databaseSafeInteger(row.generation, "Nonce-release generation") ||
      record.intent.chainID !==
        databaseSafeInteger(row.chain_id, "Nonce-release chain ID") ||
      reservation.laneID !== row.signer_lane_id ||
      reservation.signerIdentity !== row.signer_identity ||
      address(reservation.sender, "Nonce-release sender") !==
        prefixedHex(row.sender) ||
      reservation.nonce !==
        databaseSafeInteger(row.transaction_nonce, "Nonce-release nonce") ||
      reservation.reservationEpoch !==
        databaseSafeInteger(
          row.reservation_epoch,
          "Nonce-release reservation epoch"
        ) ||
      hexData(reservation.bindingSignature, "Nonce-release binding") !==
        prefixedHex(row.reservation_binding) ||
      bytes32(tombstone.evidenceDigest, "Void evidence digest") !==
        prefixedHex(row.void_evidence_digest)
    ) {
      throw new Error(
        "Nonce-release request does not match its exact durable reservation"
      )
    }
    const releaseRequestID = prefixedHex(row.release_request_id)
    if (
      computeP2TRSignatureFraudNonceReleaseRequestID(
        recordID,
        reservationID,
        tombstone.evidenceDigest
      ) !== releaseRequestID
    ) {
      throw new Error("Nonce-release request identity is invalid")
    }
    return {
      releaseRequestID,
      recordID,
      generation: record.generation,
      reservation,
      voidEvidenceDigest: tombstone.evidenceDigest,
      requestedAtUnixMs: databaseSafeInteger(
        row.requested_at_unix_ms,
        "Nonce-release request time"
      ),
      attemptCount: databaseSafeInteger(
        row.attempt_count,
        "Nonce-release attempt count"
      ),
      ambiguous: row.ambiguous,
    }
  }

  private async compareAndSwapLocked(
    recordID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord,
    expectedProvenance?: P2TRSignatureFraudCanonicalProvenanceBinding
  ): Promise<boolean> {
    assertCompactDurableOutboxRecord(next)
    const row = await this.lockRecord(recordID)
    if (row === undefined) return false
    const current = await this.hydrateRow(row)
    if (
      current.version !== expectedVersion ||
      next.version !== expectedVersion + 1 ||
      bytes32(current.recordID, "Stored record ID") !==
        bytes32(next.recordID, "Next record ID") ||
      (expectedProvenance !== undefined &&
        canonicalJSON(current.canonicalProvenance) !==
          canonicalJSON(expectedProvenance)) ||
      !preservesCASIdentities(current, next)
    ) {
      return false
    }
    if (
      ((current.selectedLaneID === undefined &&
        next.selectedLaneID !== undefined) ||
        (current.activeSignerInvocationStartedAtUnixMs === undefined &&
          next.activeSignerInvocationStartedAtUnixMs !== undefined)) &&
      !(await this.lockAndAssertSignerLaneAvailable(next))
    ) {
      return false
    }
    await this.syncChildLedgers(current, next)
    const updated = await this.updateMutableState(current, next)
    if (updated) {
      await this.persistDerivedCriticalAlerts(current, next)
      await this.resolveEligibleCriticalAlerts(next)
    }
    return updated
  }

  private async persistDerivedCriticalAlerts(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    const existing = new Set(
      (current.signerQuarantines ?? []).map(signerQuarantineID)
    )
    const signerBoundaryQuarantine = (next.signerQuarantines ?? []).find(
      (quarantine) =>
        !existing.has(signerQuarantineID(quarantine)) &&
        quarantine.reservationID !== undefined &&
        quarantine.reasonCode !== "reservation-binding-mismatch" &&
        quarantine.reasonCode !== "reservation-provider-failure"
    )
    if (signerBoundaryQuarantine === undefined) return
    await this.saveCriticalAlert({
      code: "signed-state-quarantined",
      seriesID: next.seriesID,
      recordID: next.recordID,
      generation: next.generation,
      activationBlocking: true,
      createdAtUnixMs: signerBoundaryQuarantine.quarantinedAtUnixMs,
      detail: signerBoundaryQuarantine.reason,
    })
  }

  private async lockAndAssertSignerLaneAvailable(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    if (
      record.selectedLaneID === undefined ||
      record.selectedSignerIdentity === undefined ||
      record.preparationSender === undefined
    ) {
      return false
    }
    const manifestHash = stripHex(
      bytes32(
        record.feePolicyManifest.activationManifestHash,
        "Selected lane manifest hash"
      )
    )
    const sender = stripHex(
      address(record.preparationSender, "Selected lane sender")
    )
    const locked = await this.options.session.query(
      `SELECT 1
         FROM p2tr_signature_fraud_signer_lane_configuration
        WHERE activation_manifest_hash = decode($1, 'hex')
          AND chain_id = $2
          AND signer_lane_id = $3
          AND signer_identity = $4
          AND sender = decode($5, 'hex')
          AND enabled
        FOR UPDATE`,
      [
        manifestHash,
        record.intent.chainID,
        record.selectedLaneID,
        record.selectedSignerIdentity,
        sender,
      ]
    )
    if (locked.rows.length !== 1) return false
    const blocked = await this.options.session.query<{ blocked: boolean }>(
      `SELECT EXISTS (
          SELECT 1
            FROM p2tr_signature_fraud_challenge_nonce_release_request r
           WHERE r.chain_id = $1
             AND (r.signer_lane_id = $2
                  OR r.signer_identity = $3
                  OR r.sender = decode($4, 'hex'))
             AND NOT EXISTS (
                   SELECT 1
                     FROM p2tr_signature_fraud_challenge_nonce_release_terminal x
                    WHERE x.release_request_id = r.release_request_id
                 )
        ) OR EXISTS (
          SELECT 1
            FROM p2tr_signature_fraud_challenge_signer_quarantine q
           WHERE q.chain_id = $1
             AND (q.signer_lane_id = $2
                  OR q.signer_identity = $3
                  OR q.expected_sender = decode($4, 'hex'))
        ) OR EXISTS (
          SELECT 1
            FROM p2tr_signature_fraud_challenge_critical_alert a
           WHERE a.code = 'reservation-release-failed'
             AND NOT EXISTS (
                   SELECT 1
                     FROM p2tr_signature_fraud_challenge_critical_alert_resolution ar
                    WHERE ar.alert_id = a.alert_id
                 )
        ) AS blocked`,
      [
        record.intent.chainID,
        record.selectedLaneID,
        record.selectedSignerIdentity,
        sender,
      ]
    )
    return blocked.rows[0]?.blocked !== true
  }

  private async resolveEligibleCriticalAlerts(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    if (record.finalNonceResolution === undefined) return
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_critical_alert_resolution (
          alert_id, record_id, generation, nonce_disposition_id,
          resolution_digest, resolved_at_unix_ms
       )
       SELECT a.alert_id,
              o.record_id,
              o.generation,
              o.nonce_disposition_id,
              sha256(a.alert_id || o.nonce_disposition_id || d.evidence_digest),
              o.updated_at_unix_ms
         FROM p2tr_signature_fraud_challenge_critical_alert a
         JOIN p2tr_signature_fraud_challenge_outbox o
           ON o.record_id = a.record_id
          AND o.generation = a.generation
         JOIN p2tr_signature_fraud_challenge_nonce_disposition d
           ON d.record_id = o.record_id
          AND d.nonce_disposition_id = o.nonce_disposition_id
        WHERE a.record_id = decode($1, 'hex')
          AND a.code IN (
                'late-signed-artifact-captured',
                'signed-state-quarantined'
              )
          AND o.lane_released_at_unix_ms IS NOT NULL
          AND NOT EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_escaped_envelope ee
                 WHERE ee.record_id = o.record_id
              )
          AND EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_late_signed_artifact la
                 WHERE la.record_id = o.record_id
                   AND la.generation = o.generation
                   AND la.expected_reservation_id = o.nonce_reservation_id
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_critical_alert_resolution ar
                 WHERE ar.alert_id = a.alert_id
              )
       ON CONFLICT (alert_id) DO NOTHING`,
      [stripHex(bytes32(record.recordID, "Alert-resolution record ID"))]
    )
  }

  private async updateMutableState(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    const columns = outboxMutableColumns(next)
    const entries = Object.entries(columns)
    const values = entries.map(([, value]) => value)
    const assignments = entries
      .map(([name], index) => `${quoteIdentifier(name)} = $${index + 3}`)
      .join(", ")
    const result = await this.options.session.query(
      `UPDATE p2tr_signature_fraud_challenge_outbox
          SET ${assignments}
        WHERE record_id = decode($1, 'hex')
          AND version = $2`,
      [
        stripHex(bytes32(current.recordID, "CAS record ID")),
        current.version,
        ...values,
      ]
    )
    return result.rowCount === 1
  }

  private async lockRecord(
    recordID: string
  ): Promise<StoredOutboxRow | undefined> {
    const result = await this.options.session.query<StoredOutboxRow>(
      `SELECT ${STORED_ROW_COLUMNS}
         FROM p2tr_signature_fraud_challenge_outbox
        WHERE record_id = decode($1, 'hex')
        FOR UPDATE`,
      [stripHex(bytes32(recordID, "Outbox record ID"))]
    )
    return result.rows[0]
  }

  private async getByRecordOrSeriesGeneration(
    recordID: string,
    seriesID: string,
    generation: number
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    const result = await this.options.session.query<StoredOutboxRow>(
      `SELECT ${STORED_ROW_COLUMNS}
         FROM p2tr_signature_fraud_challenge_outbox
        WHERE record_id = decode($1, 'hex')
           OR (series_id = decode($2, 'hex') AND generation = $3)
        ORDER BY (record_id = decode($1, 'hex')) DESC
        LIMIT 1`,
      [
        stripHex(bytes32(recordID, "Outbox record ID")),
        stripHex(bytes32(seriesID, "Outbox series ID")),
        nonNegativeSafeInteger(generation, "Outbox generation"),
      ]
    )
    return result.rows[0] === undefined
      ? undefined
      : this.hydrateRow(result.rows[0])
  }

  private async lockAndAssertActiveOutboxCapacity(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    const manifest = await this.options.session.query<{
      manifest_hash: Buffer
      max_active_records: string | number
    }>(
      `SELECT manifest_hash,
              (payload #>> '{outbox,maxActiveOutboxRecords}')::integer
                AS max_active_records
        FROM p2tr_watchtower_activation_manifest
        WHERE singleton = true
        FOR SHARE`
    )
    if (
      manifest.rows.length !== 1 ||
      prefixedHex(manifest.rows[0].manifest_hash) !==
        bytes32(
          record.evidenceCheckpoint.activationManifest.manifestHash,
          "Outbox activation manifest hash"
        )
    ) {
      throw new Error(
        "New challenge generation is not bound to the current activation manifest"
      )
    }
    // Recheck idempotency immediately before INSERT. The database trigger's
    // singleton counter is the capacity authority and forces concurrent
    // SERIALIZABLE writers through a write/write conflict.
    const existing = await this.getByRecordOrSeriesGeneration(
      record.recordID,
      record.seriesID,
      record.generation
    )
    if (existing !== undefined) return existing
    const maxActiveRecords = positiveSafeInteger(
      manifest.rows[0].max_active_records,
      "Manifest-bound active outbox capacity"
    )
    if (maxActiveRecords > 1_000_000) {
      throw new Error("Manifest-bound active outbox capacity is invalid")
    }
    return undefined
  }

  private async hydrateRow(
    row: StoredOutboxRow
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const state = hydrateRecordState(row.record_state)
    state.status = row.status
    state.version = databaseSafeInteger(row.version, "Stored outbox version")
    state.updatedAtUnixMs = databaseSafeInteger(
      row.updated_at_unix_ms,
      "Stored outbox update time"
    )
    state.preparationAttempts = row.preparation_attempts
    state.broadcastAttempts = row.broadcast_attempts
    state.reconciliationAttempts = row.reconciliation_attempts
    setOptional(
      state,
      "preparationLease",
      row.preparation_lease_owner === null
        ? undefined
        : {
            owner: row.preparation_lease_owner,
            expiresAtUnixMs: databaseSafeInteger(
              row.preparation_lease_expires_at_unix_ms!,
              "Stored preparation lease expiry"
            ),
          }
    )
    setOptional(
      state,
      "preparationResumeStatus",
      row.preparation_resume_status ?? undefined
    )
    setOptional(
      state,
      "selectedLaneID",
      row.selected_signer_lane_id ?? undefined
    )
    setOptional(
      state,
      "selectedSignerIdentity",
      row.selected_signer_identity ?? undefined
    )
    setOptional(
      state,
      "preparationSender",
      optionalAddress(row.selected_sender)
    )
    if (row.nonce_reservation_id === null) {
      delete state.reservedNonce
      delete state.nonceReservedAtUnixMs
    }
    setOptional(
      state,
      "signerInvocationStartedAtUnixMs",
      optionalDatabaseInteger(row.signer_invocation_started_at_unix_ms)
    )
    setOptional(
      state,
      "signerInvocationID",
      row.signer_invocation_id === null
        ? undefined
        : prefixedHex(row.signer_invocation_id)
    )
    setOptional(
      state,
      "activeSignerInvocationStartedAtUnixMs",
      optionalDatabaseInteger(row.active_signer_invocation_started_at_unix_ms)
    )
    setOptional(
      state,
      "activeSignerInvocationID",
      row.active_signer_invocation_id === null
        ? undefined
        : prefixedHex(row.active_signer_invocation_id)
    )
    setOptional(
      state,
      "lastBroadcastAtUnixMs",
      optionalDatabaseInteger(row.last_broadcast_at_unix_ms)
    )
    setOptional(
      state,
      "lastReconciliationAtUnixMs",
      optionalDatabaseInteger(row.last_reconciliation_at_unix_ms)
    )
    setOptional(
      state,
      "lastPreBroadcastRecheckAtUnixMs",
      optionalDatabaseInteger(row.last_pre_broadcast_recheck_at_unix_ms)
    )
    setOptional(
      state,
      "lastPreBroadcastRecheckStatus",
      row.last_pre_broadcast_recheck_status ?? undefined
    )
    setOptional(
      state,
      "lastResolutionStatus",
      row.last_resolution_status ?? undefined
    )
    setOptional(state, "lastError", row.last_error ?? undefined)
    if (row.provenance_invalidation_id !== null) {
      state.provenanceInvalidationEvidence =
        await this.loadProvenanceInvalidation(
          state.recordID,
          row.provenance_invalidation_id
        )
    }
    return state
  }

  private async loadProvenanceInvalidation(
    recordID: string,
    invalidationID: Buffer
  ): Promise<P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence> {
    const result = await this.options.session.query<ProvenanceInvalidationRow>(
      `SELECT *
         FROM p2tr_signature_fraud_challenge_provenance_invalidation
        WHERE record_id = decode($1, 'hex')
          AND provenance_invalidation_id = $2`,
      [stripHex(bytes32(recordID, "Invalidated record ID")), invalidationID]
    )
    if (result.rows.length !== 1) {
      throw new Error("Outbox provenance invalidation link is dangling")
    }
    const row = result.rows[0]
    const withoutHash = {
      provenanceTombstoneID: prefixedHex(row.provenance_tombstone_id),
      candidate: {
        txid: prefixedHex(row.bitcoin_tx_hash),
        wtxid: prefixedHex(row.bitcoin_wtxid),
        inputIndex: databaseSafeInteger(
          row.bitcoin_input_index,
          "Invalidated input index"
        ),
        blockHash: prefixedHex(row.bitcoin_block_hash),
        blockHeight: databaseSafeInteger(
          row.bitcoin_block_height,
          "Invalidated block height"
        ),
      },
      observationID: prefixedHex(row.observation_id),
      candidateDigest: prefixedHex(row.canonical_candidate_digest),
      candidateProvenanceGeneration: databaseSafeInteger(
        row.canonical_candidate_provenance_generation,
        "Invalidated candidate provenance generation"
      ),
      provenanceFingerprint: prefixedHex(row.canonical_provenance_fingerprint),
      manifestHash: prefixedHex(row.canonical_provenance_manifest_hash),
      ethereumRollbackBlockHash: prefixedHex(row.ethereum_rollback_block_hash),
      ethereumRollbackBlockNumber: databaseSafeInteger(
        row.ethereum_rollback_block_number,
        "Provenance rollback block number"
      ),
      provenanceInvalidationSequence: databaseSafeInteger(
        row.provenance_invalidation_sequence,
        "Provenance invalidation sequence"
      ),
      invalidatedAtUnixMs: databaseSafeInteger(
        row.invalidated_at_unix_ms,
        "Provenance invalidation time"
      ),
      reason: row.reason,
    }
    return {
      ...withoutHash,
      evidenceHash:
        computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash(
          withoutHash
        ),
    }
  }

  private async loadPriorGenerationLinks(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<PriorGenerationLinks> {
    if (record.generationTrigger.kind === "initial") return {}
    const previousID = bytes32(
      record.generationTrigger.previousRecordID,
      "Previous outbox record ID"
    )
    const result = await this.options.session.query<{
      generation: number
      nonce_disposition_id: Buffer | null
      cancellation_evidence_id: Buffer | null
      provenance_invalidation_id: Buffer | null
      disposition_kind: string | null
    }>(
      `SELECT o.generation, o.nonce_disposition_id,
              o.cancellation_evidence_id, o.provenance_invalidation_id,
              d.disposition_kind
         FROM p2tr_signature_fraud_challenge_outbox o
         LEFT JOIN p2tr_signature_fraud_challenge_nonce_disposition d
           ON d.record_id = o.record_id
          AND d.nonce_disposition_id = o.nonce_disposition_id
        WHERE o.record_id = decode($1, 'hex')
        FOR SHARE OF o`,
      [stripHex(previousID)]
    )
    if (
      result.rows.length !== 1 ||
      result.rows[0].generation + 1 !== record.generation
    ) {
      throw new Error(
        "Outbox generation predecessor is absent or non-contiguous"
      )
    }
    const prior = result.rows[0]
    switch (record.generationTrigger.kind) {
      case "nonce-disposition":
        if (
          prior.nonce_disposition_id === null ||
          prior.disposition_kind === null
        ) {
          throw new Error(
            "Nonce successor lacks its durable predecessor disposition"
          )
        }
        return {
          previousRecordID: previousID,
          generationCause:
            prior.disposition_kind === "finalized-reverted"
              ? "finalized-revert"
              : "finalized-nonce-consumed",
          priorNonceDispositionID: prefixedHex(prior.nonce_disposition_id),
        }
      case "canonical-reappearance":
        if (prior.cancellation_evidence_id === null) {
          throw new Error("Canonical reappearance lacks durable reorg evidence")
        }
        return {
          previousRecordID: previousID,
          generationCause: "canonical-reappearance",
          priorCancellationEvidenceID: prefixedHex(
            prior.cancellation_evidence_id
          ),
        }
      case "provenance-restored":
        if (prior.provenance_invalidation_id === null) {
          throw new Error("Provenance restoration lacks a durable tombstone")
        }
        return {
          previousRecordID: previousID,
          generationCause: "provenance-restored",
          priorProvenanceInvalidationID: prefixedHex(
            prior.provenance_invalidation_id
          ),
        }
    }
  }

  private async insertFeePolicy(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    for (const lane of record.feePolicyManifest.lanes) {
      await this.options.session.query(
        `INSERT INTO p2tr_signature_fraud_challenge_fee_policy (
            record_id, policy_hash, activation_manifest_hash, chain_id,
            challenge_value_wei, signer_lane_id, signer_identity, sender,
            max_gas_limit, max_fee_per_gas, max_priority_fee_per_gas,
            max_total_fee_wei
         ) VALUES (
            decode($1, 'hex'), decode($2, 'hex'), decode($3, 'hex'), $4,
            $5, $6, $7, decode($8, 'hex'), $9, $10, $11, $12
         )`,
        [
          stripHex(bytes32(record.recordID, "Fee-policy record ID")),
          stripHex(
            bytes32(record.feePolicyManifest.policyHash, "Fee-policy hash")
          ),
          stripHex(
            bytes32(
              record.feePolicyManifest.activationManifestHash,
              "Fee-policy manifest hash"
            )
          ),
          record.feePolicyManifest.chainID,
          unsignedDecimal(
            record.feePolicyManifest.challengeValueWei,
            "Challenge value"
          ),
          lane.laneID,
          lane.signerIdentity,
          stripHex(address(lane.sender, "Fee-policy sender")),
          unsignedDecimal(lane.maxGasLimit, "Maximum gas limit"),
          unsignedDecimal(lane.maxFeePerGas, "Maximum fee per gas"),
          unsignedDecimal(
            lane.maxPriorityFeePerGas,
            "Maximum priority fee per gas"
          ),
          unsignedDecimal(lane.maxTotalFeeWei, "Maximum total fee"),
        ]
      )
    }
  }

  private async syncChildLedgers(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    await this.syncVoidedReservations(current, next)
    if (
      current.reservedNonce === undefined &&
      next.reservedNonce !== undefined
    ) {
      await this.insertNonceGuard(next)
    }
    await this.syncPreparedVariants(current, next)
    await this.syncBroadcastLedger(current, next)
    if (
      current.cancellationEvidence === undefined &&
      next.cancellationEvidence !== undefined
    ) {
      await this.insertCancellationEvidence(next)
    }
    if (
      current.finalNonceResolution === undefined &&
      next.finalNonceResolution !== undefined
    ) {
      await this.insertNonceDisposition(next)
    }
    await this.syncSignerQuarantines(current, next)
    await this.syncUnexpectedArtifacts(current, next)
  }

  private async syncVoidedReservations(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    const currentIDs = new Set(
      (current.voidedNonceReservations ?? []).map((item) =>
        item.reservation.reservationID.toPrefixedString().toLowerCase()
      )
    )
    for (const item of next.voidedNonceReservations ?? []) {
      const id = item.reservation.reservationID.toPrefixedString().toLowerCase()
      if (currentIDs.has(id)) continue
      const currentReservationID = current.reservedNonce?.reservationID
        .toPrefixedString()
        .toLowerCase()
      if (currentReservationID !== id) {
        await this.insertReturnedReservationTombstone(current, item)
      } else {
        const result = await this.options.session.query(
          `UPDATE p2tr_signature_fraud_challenge_nonce_guard
              SET voided_before_sign_at_unix_ms = $2,
                  void_reason = $3,
                  void_evidence_digest = decode($4, 'hex')
            WHERE nonce_guard_id = decode($1, 'hex')
              AND voided_before_sign_at_unix_ms IS NULL`,
          [
            stripHex(bytes32(id, "Voided reservation ID")),
            unixMilliseconds(item.voidedAtUnixMs, "Reservation void time"),
            item.reasonCode,
            stripHex(bytes32(item.evidenceDigest, "Reservation void digest")),
          ]
        )
        if (result.rowCount !== 1) {
          throw new Error(
            "Durable nonce reservation could not be voided exactly once"
          )
        }
      }
      const aliasOfActiveNonce =
        current.reservedNonce !== undefined &&
        currentReservationID !== id &&
        current.intent.chainID === next.intent.chainID &&
        address(current.reservedNonce.sender, "Active reservation sender") ===
          address(item.reservation.sender, "Returned reservation sender") &&
        current.reservedNonce.nonce === item.reservation.nonce
      if (!aliasOfActiveNonce) {
        await this.insertNonceReleaseRequest(next, item)
      }
      if (item.reasonCode === "reservation-binding-invalid") {
        await this.saveCriticalAlert({
          code: "reservation-state-ambiguous",
          seriesID: next.seriesID,
          recordID: next.recordID,
          generation: next.generation,
          activationBlocking: true,
          createdAtUnixMs: item.voidedAtUnixMs,
          detail: item.reason,
        })
      }
    }
  }

  private async insertNonceReleaseRequest(
    record: P2TRSignatureFraudChallengeOutboxRecord,
    item: P2TRSignatureFraudVoidedNonceReservation
  ): Promise<void> {
    const reservation = item.reservation
    const releaseRequestID = computeP2TRSignatureFraudNonceReleaseRequestID(
      record.recordID,
      reservation.reservationID,
      item.evidenceDigest
    )
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_release_request (
          release_request_id, allocator_idempotency_key, record_id,
          generation, nonce_guard_id, chain_id, signer_lane_id,
          signer_identity, sender, transaction_nonce, reservation_epoch,
          void_evidence_digest, requested_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), decode($1, 'hex'), decode($2, 'hex'), $3,
          decode($4, 'hex'), $5, $6, $7, decode($8, 'hex'), $9, $10,
          decode($11, 'hex'), $12
       )`,
      [
        stripHex(releaseRequestID),
        stripHex(bytes32(record.recordID, "Release request record ID")),
        record.generation,
        stripHex(hexValue(reservation.reservationID, "Release reservation ID")),
        record.intent.chainID,
        reservation.laneID,
        reservation.signerIdentity,
        stripHex(address(reservation.sender, "Release reservation sender")),
        reservation.nonce,
        reservation.reservationEpoch,
        stripHex(bytes32(item.evidenceDigest, "Release void evidence digest")),
        unixMilliseconds(item.voidedAtUnixMs, "Release request time"),
      ]
    )
  }

  private async insertReturnedReservationTombstone(
    record: P2TRSignatureFraudChallengeOutboxRecord,
    item: P2TRSignatureFraudVoidedNonceReservation
  ): Promise<void> {
    if (
      record.reservedNonce !== undefined &&
      hexValue(
        record.reservedNonce.reservationID,
        "Active nonce reservation ID"
      ) ===
        hexValue(
          item.reservation.reservationID,
          "Returned nonce reservation ID"
        )
    ) {
      throw new Error(
        "The currently active nonce reservation cannot be tombstoned as a returned conflict"
      )
    }
    await this.insertReturnedReservationTombstoneRow(record, item)
  }

  private async insertReturnedReservationTombstoneRow(
    record: P2TRSignatureFraudChallengeOutboxRecord,
    item: P2TRSignatureFraudVoidedNonceReservation
  ): Promise<void> {
    const reservation = item.reservation
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_guard (
          nonce_guard_id, record_id, guard_kind, chain_id, signer_lane_id,
          signer_identity, sender, transaction_nonce, reservation_binding,
          reservation_epoch, guarded_at_unix_ms,
          voided_before_sign_at_unix_ms, void_reason, void_evidence_digest
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), 'bound-reservation', $3,
          $4, $5, decode($6, 'hex'), $7, decode($8, 'hex'), $9, $10, $10,
          $11, decode($12, 'hex')
       )`,
      returnedReservationTombstoneValues(record, item, reservation)
    )
  }

  private async insertNonceGuard(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    const reservation = record.reservedNonce!
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_guard (
          nonce_guard_id, record_id, guard_kind, chain_id, signer_lane_id,
          signer_identity, sender, transaction_nonce, reservation_binding,
          reservation_epoch, guarded_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), 'bound-reservation', $3,
          $4, $5, decode($6, 'hex'), $7, decode($8, 'hex'), $9, $10
       )`,
      [
        stripHex(hexValue(reservation.reservationID, "Nonce reservation ID")),
        stripHex(bytes32(record.recordID, "Nonce reservation record ID")),
        record.intent.chainID,
        reservation.laneID,
        reservation.signerIdentity,
        stripHex(address(reservation.sender, "Reserved sender")),
        reservation.nonce,
        stripHex(
          hexData(reservation.bindingSignature, "Nonce reservation binding")
        ),
        reservation.reservationEpoch,
        unixMilliseconds(
          record.nonceReservedAtUnixMs,
          "Nonce reservation time"
        ),
      ]
    )
  }

  private async syncPreparedVariants(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    const count = current.preparedTransactionVariants?.length ?? 0
    const variants = next.preparedTransactionVariants ?? []
    for (const variant of variants.slice(count)) {
      await this.insertVariant(next, variant)
    }
  }

  private async insertVariant(
    record: P2TRSignatureFraudChallengeOutboxRecord,
    variant: P2TRSignatureFraudPreparedTransactionVariant
  ): Promise<void> {
    if (record.reservedNonce === undefined) {
      throw new Error("Prepared variant lacks a durable nonce reservation")
    }
    const transaction =
      validateP2TRSignatureFraudPreparedChallengeTransactionReservation(
        record.intent,
        record.reservedNonce,
        variant.preparedTransaction
      )
    if (transaction.eip1559?.transactionType !== 2) {
      throw new Error(
        "Production outbox variants must be signed EIP-1559 envelopes"
      )
    }
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_outbox_variant (
          record_id, generation, variant_sequence, raw_transaction,
          transaction_hash, sender, transaction_nonce, transaction_type,
          gas_limit, max_fee_per_gas, max_priority_fee_per_gas,
          signed_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), $2, $3, decode($4, 'hex'), decode($5, 'hex'),
          decode($6, 'hex'), $7, 2, $8, $9, $10, $11
       )`,
      [
        stripHex(bytes32(record.recordID, "Variant record ID")),
        record.generation,
        variant.sequence,
        stripHex(hexData(transaction.rawTransaction, "Signed raw transaction")),
        stripHex(
          hexValue(transaction.transactionHash, "Signed transaction hash")
        ),
        stripHex(address(transaction.sender, "Signed transaction sender")),
        transaction.nonce,
        unsignedDecimal(transaction.eip1559.gasLimit, "Signed gas limit"),
        unsignedDecimal(transaction.eip1559.maxFeePerGas, "Signed maximum fee"),
        unsignedDecimal(
          transaction.eip1559.maxPriorityFeePerGas,
          "Signed priority fee"
        ),
        variant.signedAtUnixMs,
      ]
    )
  }

  private async syncBroadcastLedger(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    const currentBySequence = new Map(
      (current.preparedTransactionVariants ?? []).map((item) => [
        item.sequence,
        item,
      ])
    )
    for (const variant of next.preparedTransactionVariants ?? []) {
      const prior = currentBySequence.get(variant.sequence)
      const priorAttempts = prior?.broadcastAttempts ?? 0
      if (variant.broadcastAttempts > priorAttempts) {
        if (variant.broadcastAttempts !== priorAttempts + 1) {
          throw new Error(
            "Broadcast attempt ledger cannot skip an attempt number"
          )
        }
        await this.options.session.query(
          `INSERT INTO p2tr_signature_fraud_challenge_outbox_broadcast_attempt (
              record_id, generation, variant_sequence, attempt_number,
              provider_id, attempted_at_unix_ms
           ) VALUES (decode($1, 'hex'), $2, $3, $4, $5, $6)`,
          [
            stripHex(bytes32(next.recordID, "Broadcast record ID")),
            next.generation,
            variant.sequence,
            variant.broadcastAttempts,
            this.options.broadcastProviderID,
            unixMilliseconds(
              variant.lastBroadcastAtUnixMs,
              "Broadcast attempt time"
            ),
          ]
        )
      }
      const acknowledgementChanged =
        prior !== undefined &&
        prior.broadcastAttempts === variant.broadcastAttempts &&
        prior.lastBroadcastProviderAccepted !==
          variant.lastBroadcastProviderAccepted
      const ambiguousRecorded =
        prior !== undefined &&
        prior.broadcastAttempts === variant.broadcastAttempts &&
        prior.lastError !== variant.lastError &&
        variant.lastError !== undefined &&
        variant.lastBroadcastProviderAccepted === undefined
      if (acknowledgementChanged || ambiguousRecorded) {
        const accepted = variant.lastBroadcastProviderAccepted === true
        await this.options.session.query(
          `INSERT INTO p2tr_signature_fraud_challenge_outbox_broadcast_acknowledgement (
              record_id, generation, variant_sequence, attempt_number, result,
              returned_transaction_hash, error, acknowledged_at_unix_ms
           ) VALUES (
              decode($1, 'hex'), $2, $3, $4, $5, decode($6, 'hex'), $7, $8
           )`,
          [
            stripHex(
              bytes32(next.recordID, "Broadcast acknowledgement record ID")
            ),
            next.generation,
            variant.sequence,
            variant.broadcastAttempts,
            accepted ? "accepted" : "ambiguous",
            accepted
              ? stripHex(
                  hexValue(
                    variant.preparedTransaction.transactionHash,
                    "Acknowledged transaction hash"
                  )
                )
              : null,
            accepted
              ? null
              : requireText(
                  variant.lastError,
                  "Ambiguous broadcast error",
                  1024
                ),
            next.updatedAtUnixMs,
          ]
        )
      }
    }
  }

  private async insertCancellationEvidence(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    const evidence = record.cancellationEvidence!
    const honest = evidence.kind === "honest-spend" ? evidence : undefined
    const reorg = evidence.kind === "canonical-reorg" ? evidence : undefined
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_cancellation_evidence (
          cancellation_evidence_id, record_id, evidence_kind, evidence_digest,
          prior_bitcoin_tx_hash, prior_bitcoin_wtxid,
          prior_bitcoin_input_index, prior_bitcoin_block_hash,
          prior_bitcoin_block_height, bitcoin_cursor_block_hash,
          bitcoin_cursor_block_height, ethereum_cursor_block_hash,
          ethereum_cursor_block_number, replacement_bitcoin_block_hash,
          replacement_bitcoin_block_height, conflicting_outpoint_tx_hash,
          conflicting_outpoint_index, canonical_spend_tx_hash,
          canonical_spend_wtxid, canonical_spend_block_hash,
          canonical_spend_block_height, canonical_spend_input_index,
          bridge_proof_transaction_hash, bridge_proof_block_hash,
          bridge_proof_block_number, bridge_proof_log_index,
          bridge_proof_type, verified_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), $3, decode($4, 'hex'),
          decode($5, 'hex'), decode($6, 'hex'), $7, decode($8, 'hex'), $9,
          decode($10, 'hex'), $11, decode($12, 'hex'), $13,
          decode($14, 'hex'), $15, decode($16, 'hex'), $17,
          decode($18, 'hex'), decode($19, 'hex'), decode($20, 'hex'), $21,
          $22, decode($23, 'hex'), decode($24, 'hex'), $25, $26, $27, $28
       )`,
      [
        stripHex(bytes32(evidence.evidenceHash, "Cancellation evidence ID")),
        stripHex(bytes32(record.recordID, "Cancellation record ID")),
        evidence.kind,
        stripHex(
          bytes32(evidence.evidenceHash, "Cancellation evidence digest")
        ),
        stripHex(
          bytes32(evidence.originalCandidate.txid, "Cancelled candidate txid")
        ),
        stripHex(
          bytes32(evidence.originalCandidate.wtxid, "Cancelled candidate wtxid")
        ),
        evidence.originalCandidate.inputIndex,
        stripHex(
          bytes32(
            evidence.originalCandidate.blockHash,
            "Cancelled candidate block hash"
          )
        ),
        evidence.originalCandidate.blockHeight,
        stripHex(
          bytes32(
            evidence.canonicalCursor.bitcoinBlockHash,
            "Cancellation Bitcoin cursor"
          )
        ),
        evidence.canonicalCursor.bitcoinBlockHeight,
        stripHex(
          bytes32(
            evidence.canonicalCursor.ethereumBlockHash,
            "Cancellation Ethereum cursor"
          )
        ),
        evidence.canonicalCursor.ethereumBlockNumber,
        reorg === undefined
          ? null
          : stripHex(
              bytes32(
                reorg.replacementCanonicalTip.blockHash,
                "Replacement block hash"
              )
            ),
        reorg?.replacementCanonicalTip.blockHeight ?? null,
        honest === undefined
          ? null
          : stripHex(
              bytes32(
                honest.conflictingOutpoint.txid,
                "Conflicting outpoint txid"
              )
            ),
        honest?.conflictingOutpoint.vout ?? null,
        honest === undefined
          ? null
          : stripHex(
              bytes32(honest.canonicalSpend.txid, "Canonical spend txid")
            ),
        honest === undefined
          ? null
          : stripHex(
              bytes32(honest.canonicalSpend.wtxid, "Canonical spend wtxid")
            ),
        honest === undefined
          ? null
          : stripHex(
              bytes32(
                honest.canonicalSpend.blockHash,
                "Canonical spend block hash"
              )
            ),
        honest?.canonicalSpend.blockHeight ?? null,
        honest?.canonicalSpend.inputIndex ?? null,
        honest === undefined
          ? null
          : stripHex(
              bytes32(
                honest.bridgeProofReceipt.transactionHash,
                "Bridge proof transaction hash"
              )
            ),
        honest === undefined
          ? null
          : stripHex(
              bytes32(
                honest.bridgeProofReceipt.blockHash,
                "Bridge proof block hash"
              )
            ),
        honest?.bridgeProofReceipt.blockNumber ?? null,
        honest?.bridgeProofReceipt.logIndex ?? null,
        honest?.bridgeProofReceipt.proofType ?? null,
        evidence.agreement.checkedAtUnixMs,
      ]
    )
    const attestations = [
      {
        trust: evidence.agreement.primaryTrustDomainID,
        independence: evidence.agreement.primaryIndependenceDomainID,
        attestation: evidence.agreement.primaryAttestation,
      },
      {
        trust: evidence.agreement.corroboratingTrustDomainID,
        independence: evidence.agreement.corroboratingIndependenceDomainID,
        attestation: evidence.agreement.corroboratingAttestation,
      },
    ]
    for (const attestation of attestations) {
      await this.options.session.query(
        `INSERT INTO p2tr_signature_fraud_challenge_cancellation_attestation (
            cancellation_evidence_id, trust_domain_id, independence_domain_id,
            evidence_digest, bitcoin_cursor_block_hash,
            bitcoin_cursor_block_height, ethereum_cursor_block_hash,
            ethereum_cursor_block_number, attestation, attested_at_unix_ms
         ) VALUES (
            decode($1, 'hex'), $2, $3, decode($4, 'hex'), decode($5, 'hex'),
            $6, decode($7, 'hex'), $8, decode($9, 'hex'), $10
         )`,
        [
          stripHex(bytes32(evidence.evidenceHash, "Cancellation evidence ID")),
          attestation.trust,
          attestation.independence,
          stripHex(
            bytes32(evidence.evidenceHash, "Cancellation evidence digest")
          ),
          stripHex(
            bytes32(
              evidence.canonicalCursor.bitcoinBlockHash,
              "Cancellation Bitcoin cursor"
            )
          ),
          evidence.canonicalCursor.bitcoinBlockHeight,
          stripHex(
            bytes32(
              evidence.canonicalCursor.ethereumBlockHash,
              "Cancellation Ethereum cursor"
            )
          ),
          evidence.canonicalCursor.ethereumBlockNumber,
          stripHex(
            hexData(attestation.attestation, "Cancellation attestation")
          ),
          evidence.agreement.checkedAtUnixMs,
        ]
      )
    }
  }

  private async insertNonceDisposition(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    const resolution = record.finalNonceResolution!
    const reservation = record.reservedNonce
    if (reservation === undefined) {
      throw new Error("Final nonce disposition lacks a durable reservation")
    }
    const dispositionID = nonceDispositionID(resolution)
    const evidenceDigest =
      computeP2TRSignatureFraudResolutionEvidenceDigest(resolution)
    const external =
      resolution.status === "satisfied-external" ? resolution : undefined
    const ownDisposition = external?.ownTransactionDisposition
    const reverted =
      resolution.status === "terminal-reverted"
        ? resolution.receipt
        : ownDisposition?.status === "reverted"
        ? ownDisposition.receipt
        : undefined
    const nonceConsumed =
      resolution.status === "terminal-nonce-consumed"
        ? resolution
        : ownDisposition?.status === "nonce-consumed"
        ? ownDisposition
        : undefined
    const accepted =
      resolution.status === "accepted-own" ? resolution : undefined
    const transactionHash =
      reverted?.transactionHash ??
      nonceConsumed?.consumingTransaction.transactionHash ??
      accepted?.transaction.transactionHash ??
      external!.transaction.transactionHash
    const blockHash =
      reverted?.blockHash ??
      nonceConsumed?.consumingTransaction.blockHash ??
      accepted?.transaction.blockHash ??
      external!.transaction.blockHash
    const blockNumber =
      reverted?.blockNumber ??
      nonceConsumed?.consumingTransaction.blockNumber ??
      accepted?.transaction.blockNumber ??
      external!.transaction.blockNumber
    const submittedArtifact = findSubmittedArtifact(record, transactionHash)
    const kind =
      resolution.status === "terminal-reverted"
        ? "finalized-reverted"
        : resolution.status === "terminal-nonce-consumed"
        ? "finalized-nonce-consumed"
        : resolution.status === "accepted-own"
        ? "finalized-accepted-own"
        : "finalized-after-external-satisfaction"
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_disposition (
          nonce_disposition_id, record_id, generation, nonce_reservation_id,
          chain_id, signer_lane_id, signer_identity, sender,
          transaction_nonce, disposition_kind, transaction_hash,
          submitted_variant_sequence, submitted_late_artifact_id,
          transaction_receipt_status,
          transaction_block_hash, transaction_block_number, transaction_index,
          finalized_through_block_hash, finalized_through_block_number,
          sender_account_nonce_at_finality, router_challenge_present,
          external_challenge_transaction_hash, external_challenge_block_hash,
          external_challenge_block_number, external_challenge_log_index,
          evidence_digest, verified_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), $3, decode($4, 'hex'), $5,
          $6, $7, decode($8, 'hex'), $9, $10, decode($11, 'hex'), $12,
          decode($13, 'hex'), $14, decode($15, 'hex'), $16, NULL,
          decode($17, 'hex'), $18, $19, $20, decode($21, 'hex'),
          decode($22, 'hex'), $23, $24, decode($25, 'hex'), $26
       )`,
      [
        stripHex(dispositionID),
        stripHex(bytes32(record.recordID, "Disposition record ID")),
        record.generation,
        stripHex(
          hexValue(reservation.reservationID, "Disposition reservation ID")
        ),
        record.intent.chainID,
        reservation.laneID,
        reservation.signerIdentity,
        stripHex(address(reservation.sender, "Disposition sender")),
        reservation.nonce,
        kind,
        stripHex(bytes32(transactionHash, "Disposition transaction hash")),
        submittedArtifact.variantSequence,
        submittedArtifact.lateArtifactID === null
          ? null
          : stripHex(submittedArtifact.lateArtifactID),
        reverted !== undefined
          ? false
          : nonceConsumed !== undefined
          ? null
          : true,
        stripHex(bytes32(blockHash, "Disposition block hash")),
        blockNumber,
        stripHex(
          bytes32(
            resolution.finalizedThrough.blockHash,
            "Finalized disposition block hash"
          )
        ),
        resolution.finalizedThrough.blockNumber,
        nonceConsumed?.finalizedAccountNonce ?? null,
        resolution.routerChallenge.exists,
        external === undefined
          ? null
          : stripHex(
              bytes32(
                external.transaction.transactionHash,
                "External challenge transaction hash"
              )
            ),
        external === undefined
          ? null
          : stripHex(
              bytes32(
                external.transaction.blockHash,
                "External challenge block hash"
              )
            ),
        external?.transaction.blockNumber ?? null,
        external?.submittedEvent.logIndex ?? null,
        stripHex(evidenceDigest),
        record.updatedAtUnixMs,
      ]
    )
    for (const attestation of resolution.canonicalAttestations) {
      await this.options.session.query(
        `INSERT INTO p2tr_signature_fraud_challenge_nonce_disposition_attestation (
            nonce_disposition_id, trust_domain_id, independence_domain_id,
            evidence_digest, finalized_through_block_hash,
            finalized_through_block_number, attestation, attested_at_unix_ms
         ) VALUES (
            decode($1, 'hex'), $2, $3, decode($4, 'hex'),
            decode($5, 'hex'), $6, decode($7, 'hex'), $8
         )`,
        [
          stripHex(dispositionID),
          attestation.trustDomainID,
          attestation.independenceDomainID,
          stripHex(evidenceDigest),
          stripHex(
            bytes32(
              resolution.finalizedThrough.blockHash,
              "Disposition finalized hash"
            )
          ),
          resolution.finalizedThrough.blockNumber,
          stripHex(hexData(attestation.attestation, "Disposition attestation")),
          attestation.attestedAtUnixMs,
        ]
      )
    }
  }

  private async syncSignerQuarantines(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    const existing = new Set(
      (current.signerQuarantines ?? []).map(signerQuarantineID)
    )
    for (const quarantine of next.signerQuarantines ?? []) {
      const id = signerQuarantineID(quarantine)
      if (existing.has(id)) continue
      const laneLock = await this.options.session.query(
        `SELECT 1
           FROM p2tr_signature_fraud_signer_lane_configuration
          WHERE activation_manifest_hash = decode($1, 'hex')
            AND chain_id = $2
            AND signer_lane_id = $3
            AND signer_identity = $4
            AND sender = decode($5, 'hex')
          FOR UPDATE`,
        [
          stripHex(
            bytes32(
              next.feePolicyManifest.activationManifestHash,
              "Quarantined lane manifest hash"
            )
          ),
          next.intent.chainID,
          quarantine.laneID,
          quarantine.signerIdentity,
          stripHex(address(quarantine.expectedSender, "Quarantine sender")),
        ]
      )
      if (laneLock.rows.length !== 1) {
        throw new Error("Signer quarantine lacks its manifest-bound lane")
      }
      await this.options.session.query(
        `INSERT INTO p2tr_signature_fraud_challenge_signer_quarantine (
            signer_quarantine_id, record_id, nonce_reservation_id, chain_id,
            signer_lane_id, signer_identity, expected_sender, expected_nonce,
            quarantine_reason, details_digest, quarantined_at_unix_ms
         ) VALUES (
            decode($1, 'hex'), decode($2, 'hex'), decode($3, 'hex'), $4,
            $5, $6, decode($7, 'hex'), $8, $9, decode($10, 'hex'), $11
         )`,
        [
          stripHex(id),
          stripHex(bytes32(next.recordID, "Signer quarantine record ID")),
          optionalStripHex(
            quarantine.reservationID,
            "Quarantine reservation ID"
          ),
          next.intent.chainID,
          quarantine.laneID,
          quarantine.signerIdentity,
          stripHex(
            address(quarantine.expectedSender, "Quarantine expected sender")
          ),
          quarantine.expectedNonce ?? null,
          quarantine.reasonCode,
          stripHex(
            bytes32(quarantine.detailsDigest, "Quarantine details digest")
          ),
          quarantine.quarantinedAtUnixMs,
        ]
      )
    }
  }

  private async syncUnexpectedArtifacts(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    const currentHashes = new Set(
      (current.unexpectedSignedArtifacts ?? []).map((artifact) =>
        hexValue(
          artifact.preparedTransaction.transactionHash,
          "Unexpected transaction hash"
        )
      )
    )
    for (const artifact of next.unexpectedSignedArtifacts ?? []) {
      const hash = hexValue(
        artifact.preparedTransaction.transactionHash,
        "Unexpected transaction hash"
      )
      if (!currentHashes.has(hash))
        await this.insertUnexpectedArtifact(next, artifact)
    }
  }

  private async insertUnexpectedArtifact(
    record: P2TRSignatureFraudChallengeOutboxRecord,
    artifact: P2TRSignatureFraudUnexpectedSignedArtifact
  ): Promise<void> {
    const reservation = record.reservedNonce
    if (reservation === undefined) {
      throw new Error("Unexpected signed artifact lacks its nonce reservation")
    }
    const transaction = artifact.preparedTransaction
    const validatedTransaction =
      validateP2TRSignatureFraudPreparedEIP1559ChallengeTransaction(
        record.intent,
        transaction
      )
    const sameLane =
      address(transaction.sender, "Unexpected signed sender") ===
        address(reservation.sender, "Reserved sender") &&
      transaction.nonce === reservation.nonce
    if (sameLane) {
      if (validatedTransaction.eip1559?.transactionType !== 2) {
        throw new Error("Unexpected production artifact must be EIP-1559")
      }
      await this.options.session.query(
        `INSERT INTO p2tr_signature_fraud_challenge_late_signed_artifact (
            artifact_id, record_id, generation,
            expected_provenance_fingerprint, expected_reservation_id,
            chain_id, signer_lane_id, signer_identity, intent_id,
            raw_transaction, transaction_hash, sender, transaction_nonce,
            transaction_type, gas_limit, max_fee_per_gas,
            max_priority_fee_per_gas, captured_at_unix_ms, reason,
            reason_digest
         ) VALUES (
            decode($1, 'hex'), decode($2, 'hex'), $3, decode($4, 'hex'),
            decode($5, 'hex'), $6, $7, $8, decode($9, 'hex'),
            decode($10, 'hex'), decode($11, 'hex'), decode($12, 'hex'),
            $13, 2, $14, $15, $16, $17, $18, decode($19, 'hex')
         )`,
        [
          stripHex(hexValue(transaction.transactionHash, "Late artifact ID")),
          stripHex(bytes32(record.recordID, "Late artifact record ID")),
          record.generation,
          stripHex(
            bytes32(
              record.canonicalProvenance.provenanceFingerprint,
              "Late artifact provenance"
            )
          ),
          stripHex(
            bytes32(
              artifact.expectedReservationID,
              "Late artifact reservation ID"
            )
          ),
          record.intent.chainID,
          reservation.laneID,
          reservation.signerIdentity,
          stripHex(hexValue(transaction.intentID, "Late artifact intent ID")),
          stripHex(
            hexData(transaction.rawTransaction, "Late artifact raw transaction")
          ),
          stripHex(
            hexValue(
              transaction.transactionHash,
              "Late artifact transaction hash"
            )
          ),
          stripHex(address(transaction.sender, "Late artifact sender")),
          transaction.nonce,
          unsignedDecimal(
            validatedTransaction.eip1559.gasLimit,
            "Late artifact gas limit"
          ),
          unsignedDecimal(
            validatedTransaction.eip1559.maxFeePerGas,
            "Late artifact maximum fee"
          ),
          unsignedDecimal(
            validatedTransaction.eip1559.maxPriorityFeePerGas,
            "Late artifact priority fee"
          ),
          artifact.capturedAtUnixMs,
          requireText(artifact.reason, "Late artifact reason", 1024),
          stripHex(hashText(artifact.reason)),
        ]
      )
      return
    }

    const quarantine = [...(record.signerQuarantines ?? [])]
      .reverse()
      .find(
        (candidate) =>
          candidate.reasonCode === "wrong-sender" ||
          candidate.reasonCode === "wrong-nonce" ||
          candidate.reasonCode === "ambiguous-signer-invocation"
      )
    if (quarantine === undefined) {
      throw new Error(
        "Escaped wrong-lane envelope lacks signer quarantine evidence"
      )
    }
    let actualGuardID = hashStructured({
      domain: "tbtc-p2tr-signature-fraud-escaped-nonce-guard-v1",
      recordID: record.recordID,
      transactionHash: hexValue(
        transaction.transactionHash,
        "Escaped transaction hash"
      ),
      sender: address(transaction.sender, "Escaped sender"),
      nonce: transaction.nonce,
    })
    let actualGuardRecordID = record.recordID
    let actualGuardLaneID = reservation.laneID
    let actualGuardSignerIdentity = reservation.signerIdentity
    const existingGuard = await this.options.session.query<{
      nonce_guard_id: Buffer
      record_id: Buffer
      signer_lane_id: string
      signer_identity: string
    }>(
      `SELECT nonce_guard_id, record_id, signer_lane_id, signer_identity
         FROM p2tr_signature_fraud_challenge_nonce_guard
        WHERE chain_id = $1
          AND sender = decode($2, 'hex')
          AND transaction_nonce = $3
          AND voided_before_sign_at_unix_ms IS NULL
        ORDER BY guarded_at_unix_ms DESC,
                 nonce_guard_id
        LIMIT 1
        FOR SHARE`,
      [
        record.intent.chainID,
        stripHex(address(transaction.sender, "Escaped sender")),
        transaction.nonce,
      ]
    )
    if (existingGuard.rows.length === 1) {
      actualGuardID = prefixedHex(existingGuard.rows[0].nonce_guard_id)
      actualGuardRecordID = prefixedHex(existingGuard.rows[0].record_id)
      actualGuardLaneID = existingGuard.rows[0].signer_lane_id
      actualGuardSignerIdentity = existingGuard.rows[0].signer_identity
    } else {
      await this.options.session.query(
        `INSERT INTO p2tr_signature_fraud_challenge_nonce_guard (
          nonce_guard_id, record_id, guard_kind, chain_id, signer_lane_id,
          signer_identity, sender, transaction_nonce, parent_reservation_id,
          guarded_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), 'escaped-envelope', $3,
          $4, $5, decode($6, 'hex'), $7, decode($8, 'hex'), $9
       ) ON CONFLICT (chain_id, sender, transaction_nonce)
           WHERE voided_before_sign_at_unix_ms IS NULL
           DO NOTHING`,
        [
          stripHex(actualGuardID),
          stripHex(bytes32(record.recordID, "Escaped guard record ID")),
          record.intent.chainID,
          reservation.laneID,
          reservation.signerIdentity,
          stripHex(address(transaction.sender, "Escaped sender")),
          transaction.nonce,
          stripHex(
            hexValue(reservation.reservationID, "Parent reservation ID")
          ),
          artifact.capturedAtUnixMs,
        ]
      )
      const durableGuard = await this.options.session.query<{
        nonce_guard_id: Buffer
        record_id: Buffer
        signer_lane_id: string
        signer_identity: string
      }>(
        `SELECT nonce_guard_id, record_id, signer_lane_id, signer_identity
           FROM p2tr_signature_fraud_challenge_nonce_guard
          WHERE chain_id = $1
            AND sender = decode($2, 'hex')
            AND transaction_nonce = $3
            AND voided_before_sign_at_unix_ms IS NULL
          ORDER BY nonce_guard_id
          LIMIT 1
          FOR SHARE`,
        [
          record.intent.chainID,
          stripHex(address(transaction.sender, "Escaped sender")),
          transaction.nonce,
        ]
      )
      if (durableGuard.rows.length !== 1) {
        throw new Error("Escaped nonce guard could not be acquired")
      }
      actualGuardID = prefixedHex(durableGuard.rows[0].nonce_guard_id)
      actualGuardRecordID = prefixedHex(durableGuard.rows[0].record_id)
      actualGuardLaneID = durableGuard.rows[0].signer_lane_id
      actualGuardSignerIdentity = durableGuard.rows[0].signer_identity
    }
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_escaped_envelope (
          escaped_envelope_id, record_id, signer_quarantine_id,
          expected_reservation_id, actual_guard_record_id,
          actual_nonce_guard_id, chain_id, signer_lane_id, signer_identity,
          expected_sender, expected_nonce, actual_sender, actual_nonce,
          actual_guard_signer_lane_id, actual_guard_signer_identity,
          transaction_type, raw_transaction, transaction_hash,
          captured_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), decode($3, 'hex'),
          decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'), $7,
          $8, $9, decode($10, 'hex'), $11, decode($12, 'hex'), $13,
          $14, $15, $16, decode($17, 'hex'), decode($18, 'hex'), $19
       )`,
      [
        stripHex(hexValue(transaction.transactionHash, "Escaped envelope ID")),
        stripHex(bytes32(record.recordID, "Escaped envelope record ID")),
        stripHex(signerQuarantineID(quarantine)),
        stripHex(
          bytes32(artifact.expectedReservationID, "Expected reservation ID")
        ),
        stripHex(bytes32(actualGuardRecordID, "Actual guard record ID")),
        stripHex(actualGuardID),
        record.intent.chainID,
        reservation.laneID,
        reservation.signerIdentity,
        stripHex(address(reservation.sender, "Expected sender")),
        reservation.nonce,
        stripHex(address(transaction.sender, "Actual sender")),
        transaction.nonce,
        actualGuardLaneID,
        actualGuardSignerIdentity,
        transaction.eip1559?.transactionType ?? 0,
        stripHex(
          hexData(transaction.rawTransaction, "Escaped raw transaction")
        ),
        stripHex(
          hexValue(transaction.transactionHash, "Escaped transaction hash")
        ),
        artifact.capturedAtUnixMs,
      ]
    )
  }

  private async insertProvenanceInvalidation(
    record: P2TRSignatureFraudChallengeOutboxRecord,
    evidence: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence
  ): Promise<void> {
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_provenance_invalidation (
          provenance_invalidation_id, record_id, provenance_tombstone_id,
          observation_id, bitcoin_tx_hash, bitcoin_wtxid,
          bitcoin_input_index, bitcoin_block_hash, bitcoin_block_height,
          canonical_candidate_digest,
          canonical_candidate_provenance_generation,
          canonical_provenance_fingerprint,
          canonical_provenance_manifest_hash, ethereum_rollback_block_hash,
          ethereum_rollback_block_number, provenance_invalidation_sequence,
          evidence_digest, reason, invalidated_at_unix_ms, invalidation_source
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), decode($3, 'hex'),
          decode($4, 'hex'), decode($5, 'hex'), decode($6, 'hex'), $7,
          decode($8, 'hex'), $9, decode($10, 'hex'), $11,
          decode($12, 'hex'), decode($13, 'hex'), decode($14, 'hex'), $15,
          $16, decode($17, 'hex'), $18, $19, 'canonical-rollback'
       )`,
      [
        stripHex(bytes32(evidence.evidenceHash, "Provenance invalidation ID")),
        stripHex(bytes32(record.recordID, "Provenance invalidation record ID")),
        stripHex(
          bytes32(evidence.provenanceTombstoneID, "Provenance tombstone ID")
        ),
        stripHex(bytes32(evidence.observationID, "Invalidated observation ID")),
        stripHex(
          bytes32(evidence.candidate.txid, "Invalidated candidate txid")
        ),
        stripHex(
          bytes32(evidence.candidate.wtxid, "Invalidated candidate wtxid")
        ),
        evidence.candidate.inputIndex,
        stripHex(
          bytes32(
            evidence.candidate.blockHash,
            "Invalidated candidate block hash"
          )
        ),
        evidence.candidate.blockHeight,
        stripHex(
          bytes32(evidence.candidateDigest, "Invalidated candidate digest")
        ),
        evidence.candidateProvenanceGeneration,
        stripHex(
          bytes32(
            evidence.provenanceFingerprint,
            "Invalidated provenance fingerprint"
          )
        ),
        stripHex(
          bytes32(evidence.manifestHash, "Invalidated provenance manifest")
        ),
        stripHex(
          bytes32(evidence.ethereumRollbackBlockHash, "Rollback block hash")
        ),
        evidence.ethereumRollbackBlockNumber,
        evidence.provenanceInvalidationSequence,
        stripHex(bytes32(evidence.evidenceHash, "Provenance evidence digest")),
        requireText(evidence.reason, "Provenance invalidation reason", 1024),
        evidence.invalidatedAtUnixMs,
      ]
    )
  }

  private async insertProvenanceIncident(
    record: P2TRSignatureFraudChallengeOutboxRecord,
    invalidationID: string,
    kind: ProvenanceIncidentKind,
    detail: string,
    createdAtUnixMs: number
  ): Promise<void> {
    const incidentID = hashStructured({
      domain: "tbtc-p2tr-signature-fraud-provenance-incident-v1",
      recordID: record.recordID,
      invalidationID,
      kind,
    })
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_provenance_incident (
          incident_id, record_id, provenance_invalidation_id, incident_kind,
          details_digest, activation_blocking, created_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), decode($3, 'hex'), $4,
          decode($5, 'hex'), true, $6
       ) ON CONFLICT (record_id, provenance_invalidation_id, incident_kind)
         DO NOTHING`,
      [
        stripHex(incidentID),
        stripHex(bytes32(record.recordID, "Provenance incident record ID")),
        stripHex(
          bytes32(invalidationID, "Provenance incident invalidation ID")
        ),
        kind,
        stripHex(
          hashText(requireText(detail, "Provenance incident detail", 1024))
        ),
        unixMilliseconds(createdAtUnixMs, "Provenance incident time"),
      ]
    )
  }
}

const DURABLE_OUTBOX_RECORD_KEYS = new Set([
  "seriesID",
  "recordID",
  "intent",
  "evidenceCheckpoint",
  "canonicalEthereumEligibility",
  "canonicalProvenance",
  "feePolicyManifest",
  "status",
  "version",
  "generation",
  "generationTrigger",
  "createdAtUnixMs",
  "updatedAtUnixMs",
  "preparationAttempts",
  "broadcastAttempts",
  "reconciliationAttempts",
  "preparationSender",
  "selectedLaneID",
  "selectedSignerIdentity",
  "reservedNonce",
  "nonceReservedAtUnixMs",
  "voidedNonceReservations",
  "signerQuarantines",
  "unexpectedSignedArtifacts",
  "cancellationEvidence",
  "provenanceInvalidationEvidence",
  "finalNonceResolution",
  "generationDisposition",
  "preparationLease",
  "preparationResumeStatus",
  "activeSignerInvocationStartedAtUnixMs",
  "activeSignerInvocationID",
  "signerInvocationStartedAtUnixMs",
  "signerInvocationID",
  "contestedNonceBurnClaim",
  "contestedNonceBurn",
  "preparedTransaction",
  "preparedTransactionVariants",
  "lastBroadcastAtUnixMs",
  "lastBroadcastProviderAccepted",
  "lastReconciliationAtUnixMs",
  "lastPreBroadcastRecheckAtUnixMs",
  "lastPreBroadcastRecheckStatus",
  "lastResolutionStatus",
  "lastError",
])

const DURABLE_INTENT_KEYS = new Set([
  "protocol",
  "evidenceProtocolID",
  "intentID",
  "observationID",
  "inputIndex",
  "bridgeChallengeKey",
  "walletID",
  "signingKey",
  "bindingTxHash",
  "bindingOutputIndex",
  "bridgeChallengeIdentity",
  "sighash",
  "nonceX",
  "signatureScalar",
  "domainChainID",
  "chainID",
  "bridgeAddress",
  "routerAddress",
  "calldata",
  "value",
])

const DURABLE_EVIDENCE_CHECKPOINT_KEYS = new Set([
  "confirmedSourceComplete",
  "bitcoinTxHash",
  "bitcoinWitnessTxHash",
  "bitcoinInputIndex",
  "bitcoinBlockHash",
  "bitcoinBlockHeight",
  "bitcoinCursorBlockHash",
  "bitcoinCursorBlockHeight",
  "ethereumLifecycleBlockHash",
  "ethereumLifecycleBlockNumber",
  "activationManifest",
  "submittedEventScanFromBlock",
])

const DURABLE_ACTIVATION_MANIFEST_KEYS = new Set([
  "manifestHash",
  "routerCodeHash",
  "routerProtocolID",
  "routerDomainChainID",
  "completeAuthorizationRegistryAddress",
  "completeAuthorizationRegistryCodeHash",
  "completeAuthorizationRegistryProtocolID",
  "completeReservationModel",
])

const DURABLE_ETHEREUM_ELIGIBILITY_KEYS = new Set([
  "readAtBlockNumber",
  "readAtBlockHash",
  "chainID",
  "routerDomainChainID",
  "routerAddress",
  "routerCodeHash",
  "routerProtocolID",
  "routerBridgeAddress",
  "routerChallengeKey",
  "routerChallengeAbsent",
  "completeAuthorizationRegistryAddress",
  "completeAuthorizationRegistryCodeHash",
  "completeAuthorizationRegistryProtocolID",
  "completeReservationModel",
  "completeChallengeIdentity",
  "completeWalletID",
  "completeExactChallengeAuthorizationAbsent",
  "completeExactTransactionAuthorizationAbsent",
  "completeWalletReservationActive",
  "completeActiveReservationChallengeIdentity",
  "walletChallengeable",
  "canonicalProofBacklogComplete",
  "activationManifestHash",
  "readSetHash",
])

const DURABLE_PROVENANCE_KEYS = new Set([
  "journalStoreID",
  "descriptorSetHash",
  "throughBlockNumber",
  "throughBlockHash",
  "historyRoot",
  "eventSetHash",
  "eventCount",
  "challengeKey",
  "candidateDigest",
  "readinessCertificateID",
  "readinessCertificateGeneration",
  "candidateProvenanceGeneration",
  "inputBindingKind",
  "inputBindingSourceEventID",
  "inputIndex",
  "fundingBlockHash",
  "fundingTxid",
  "fundingVout",
  "inputWalletID",
  "inputOutputKey",
  "bindingEthereumBlockNumber",
  "bindingEthereumBlockHash",
  "provenanceFingerprint",
  "manifestHash",
])

const DURABLE_FEE_POLICY_MANIFEST_KEYS = new Set([
  "policyHash",
  "activationManifestHash",
  "chainID",
  "challengeValueWei",
  "lanes",
])

const DURABLE_FEE_POLICY_LANE_KEYS = new Set([
  "laneID",
  "signerIdentity",
  "sender",
  "maxGasLimit",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "maxTotalFeeWei",
])

const DURABLE_NONCE_RESERVATION_KEYS = new Set([
  "reservationID",
  "outboxRecordID",
  "intentID",
  "generation",
  "reservationEpoch",
  "laneID",
  "signerIdentity",
  "sender",
  "nonce",
  "bindingSignature",
])

const DURABLE_PREPARED_TRANSACTION_KEYS = new Set([
  "intentID",
  "rawTransaction",
  "transactionHash",
  "sender",
  "nonce",
  "invocation",
  "eip1559",
])

const DURABLE_CONTESTED_NONCE_BURN_KEYS = new Set([
  "transactionHash",
  "rawTransaction",
  "nonce",
  "sender",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "signerInvocationID",
  "signedAtUnixMs",
  "broadcastAtUnixMs",
])

const DURABLE_CONTESTED_NONCE_BURN_CLAIM_KEYS = new Set([
  "signerInvocationID",
  "signerRequestDigest",
  "reservationID",
  "recordVersion",
  "preparationAttempts",
  "claimedAtUnixMs",
])

const DURABLE_SIGNER_INVOCATION_KEYS = new Set([
  "invocationID",
  "requestDigest",
])

const DURABLE_EIP1559_KEYS = new Set([
  "transactionType",
  "gasLimit",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
])

const DURABLE_VOIDED_RESERVATION_KEYS = new Set([
  "reservation",
  "voidedAtUnixMs",
  "reasonCode",
  "reason",
  "evidenceDigest",
])

const DURABLE_SIGNER_QUARANTINE_KEYS = new Set([
  "laneID",
  "signerIdentity",
  "expectedSender",
  "expectedNonce",
  "reservationID",
  "reasonCode",
  "quarantinedAtUnixMs",
  "reason",
  "detailsDigest",
])

const DURABLE_UNEXPECTED_ARTIFACT_KEYS = new Set([
  "preparedTransaction",
  "expectedReservationID",
  "capturedAtUnixMs",
  "reason",
])

const DURABLE_PREPARATION_LEASE_KEYS = new Set(["owner", "expiresAtUnixMs"])

const DURABLE_PREPARED_VARIANT_KEYS = new Set([
  "sequence",
  "preparedTransaction",
  "signedAtUnixMs",
  "broadcastAttempts",
  "lastBroadcastAtUnixMs",
  "lastBroadcastProviderAccepted",
  "lastError",
])

const DURABLE_PROVENANCE_INVALIDATION_KEYS = new Set([
  "evidenceHash",
  "provenanceTombstoneID",
  "candidate",
  "observationID",
  "candidateDigest",
  "candidateProvenanceGeneration",
  "provenanceFingerprint",
  "manifestHash",
  "ethereumRollbackBlockHash",
  "ethereumRollbackBlockNumber",
  "provenanceInvalidationSequence",
  "invalidatedAtUnixMs",
  "reason",
])

const DURABLE_CANDIDATE_POINTER_KEYS = new Set([
  "txid",
  "wtxid",
  "blockHash",
  "blockHeight",
  "inputIndex",
])

const DURABLE_CANONICAL_CURSOR_KEYS = new Set([
  "bitcoinBlockHash",
  "bitcoinBlockHeight",
  "ethereumBlockHash",
  "ethereumBlockNumber",
])

const DURABLE_CANCELLATION_AGREEMENT_KEYS = new Set([
  "primaryTrustDomainID",
  "corroboratingTrustDomainID",
  "primaryIndependenceDomainID",
  "corroboratingIndependenceDomainID",
  "primaryAttestation",
  "corroboratingAttestation",
  "checkedAtUnixMs",
])

const FORBIDDEN_RAW_OBSERVATION_KEYS = new Set([
  "canonicalObservation",
  "transactionPayload",
  "transactionHex",
  "rawTransactionHex",
  "unsignedTransaction",
  "unsignedTransactionHex",
  "inputPrevouts",
  "witnessSignature",
  "scriptPubKey",
])

function assertCompactDurableOutboxRecord(
  record: P2TRSignatureFraudChallengeOutboxRecord
): void {
  assertExactKeys(record, DURABLE_OUTBOX_RECORD_KEYS, "outbox record")
  assertExactKeys(record.intent, DURABLE_INTENT_KEYS, "COMPLETE_V2 intent")
  assertExactKeys(
    record.evidenceCheckpoint,
    DURABLE_EVIDENCE_CHECKPOINT_KEYS,
    "evidence checkpoint"
  )
  assertExactKeys(
    record.evidenceCheckpoint.activationManifest,
    DURABLE_ACTIVATION_MANIFEST_KEYS,
    "activation manifest binding"
  )
  assertExactKeys(
    record.canonicalEthereumEligibility,
    DURABLE_ETHEREUM_ELIGIBILITY_KEYS,
    "canonical Ethereum eligibility"
  )
  assertExactKeys(
    record.canonicalProvenance,
    DURABLE_PROVENANCE_KEYS,
    "canonical provenance"
  )
  assertExactKeys(
    record.feePolicyManifest,
    DURABLE_FEE_POLICY_MANIFEST_KEYS,
    "fee-policy manifest"
  )
  for (const lane of record.feePolicyManifest.lanes) {
    assertExactKeys(lane, DURABLE_FEE_POLICY_LANE_KEYS, "fee-policy lane")
  }
  assertGenerationTriggerKeys(record.generationTrigger)
  if (record.reservedNonce !== undefined) {
    assertExactKeys(
      record.reservedNonce,
      DURABLE_NONCE_RESERVATION_KEYS,
      "nonce reservation"
    )
  }
  assertContestedNonceBurnClaim(record)
  assertContestedNonceBurn(record)
  const voidedReservations = record.voidedNonceReservations ?? []
  if (
    voidedReservations.length >
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_VOIDED_RESERVATIONS
  ) {
    throw new Error("Voided nonce-reservation ledger exceeded its fixed cap")
  }
  const voidedReservationIDs = new Set<string>()
  for (const item of voidedReservations) {
    assertExactKeys(
      item,
      DURABLE_VOIDED_RESERVATION_KEYS,
      "voided nonce reservation wrapper"
    )
    assertExactKeys(
      item.reservation,
      DURABLE_NONCE_RESERVATION_KEYS,
      "voided nonce reservation"
    )
    const reservationID = hexValue(
      item.reservation.reservationID,
      "Voided nonce reservation ID"
    )
    if (voidedReservationIDs.has(reservationID)) {
      throw new Error("Voided nonce-reservation ledger contains a duplicate")
    }
    voidedReservationIDs.add(reservationID)
  }
  for (const quarantine of record.signerQuarantines ?? []) {
    assertExactKeys(
      quarantine,
      DURABLE_SIGNER_QUARANTINE_KEYS,
      "signer quarantine"
    )
  }
  for (const artifact of record.unexpectedSignedArtifacts ?? []) {
    assertExactKeys(
      artifact,
      DURABLE_UNEXPECTED_ARTIFACT_KEYS,
      "unexpected signed artifact"
    )
  }
  if (record.cancellationEvidence !== undefined) {
    assertCancellationEvidenceKeys(record.cancellationEvidence)
  }
  if (record.provenanceInvalidationEvidence !== undefined) {
    assertExactKeys(
      record.provenanceInvalidationEvidence,
      DURABLE_PROVENANCE_INVALIDATION_KEYS,
      "provenance invalidation evidence"
    )
    assertExactKeys(
      record.provenanceInvalidationEvidence.candidate,
      DURABLE_CANDIDATE_POINTER_KEYS,
      "provenance invalidation candidate"
    )
  }
  if (record.finalNonceResolution !== undefined) {
    assertResolutionKeys(record.finalNonceResolution, "final nonce resolution")
  }
  if (record.generationDisposition !== undefined) {
    assertResolutionKeys(record.generationDisposition, "generation disposition")
  }
  if (record.preparationLease !== undefined) {
    assertExactKeys(
      record.preparationLease,
      DURABLE_PREPARATION_LEASE_KEYS,
      "preparation lease"
    )
  }
  for (const variant of record.preparedTransactionVariants ?? []) {
    assertExactKeys(
      variant,
      DURABLE_PREPARED_VARIANT_KEYS,
      "prepared transaction variant"
    )
  }
  validateP2TRCompleteV2SignatureFraudSubmissionIntent(record.intent)
  assertNoRawObservationFields(record)
  for (const transaction of [
    record.preparedTransaction,
    ...(record.preparedTransactionVariants ?? []).map(
      ({ preparedTransaction }) => preparedTransaction
    ),
    ...(record.unexpectedSignedArtifacts ?? []).map(
      ({ preparedTransaction }) => preparedTransaction
    ),
  ]) {
    if (transaction === undefined) continue
    assertExactKeys(
      transaction,
      DURABLE_PREPARED_TRANSACTION_KEYS,
      "prepared transaction"
    )
    if (transaction.invocation !== undefined) {
      assertExactKeys(
        transaction.invocation,
        DURABLE_SIGNER_INVOCATION_KEYS,
        "prepared signer invocation request"
      )
    }
    if (transaction.eip1559 !== undefined) {
      assertExactKeys(
        transaction.eip1559,
        DURABLE_EIP1559_KEYS,
        "prepared EIP-1559 envelope"
      )
    }
    const byteLength =
      stripHex(hexData(transaction.rawTransaction, "Signed transaction"))
        .length / 2
    if (byteLength > MAX_SIGNED_ETHEREUM_TRANSACTION_BYTES) {
      throw new Error("Signed Ethereum transaction exceeds the durable bound")
    }
  }
  const serializedBytes = Buffer.byteLength(
    JSON.stringify(serializeJSON(record)),
    "utf8"
  )
  if (serializedBytes > MAX_DURABLE_OUTBOX_RECORD_BYTES) {
    throw new Error("Durable outbox record exceeds the compact evidence bound")
  }
}

function assertContestedNonceBurnClaim(
  record: P2TRSignatureFraudChallengeOutboxRecord
): void {
  const claim = record.contestedNonceBurnClaim
  if (claim === undefined) return
  assertExactKeys(
    claim,
    DURABLE_CONTESTED_NONCE_BURN_CLAIM_KEYS,
    "contested nonce burn claim"
  )
  if (record.contestedNonceBurn !== undefined) {
    throw new Error(
      "Contested nonce burn claim must be replaced by signed bytes atomically"
    )
  }
  bytes32(
    claim.signerInvocationID,
    "Contested nonce burn claim signer invocation ID"
  )
  bytes32(
    claim.signerRequestDigest,
    "Contested nonce burn claim request digest"
  )
  const reservationID = bytes32(
    claim.reservationID,
    "Contested nonce burn claim reservation ID"
  )
  const recordVersion = nonNegativeSafeInteger(
    claim.recordVersion,
    "Contested nonce burn claim record version"
  )
  if (recordVersion >= record.version) {
    throw new Error(
      "Contested nonce burn claim must name the record version before its durable append"
    )
  }
  if (
    positiveSafeInteger(
      claim.preparationAttempts,
      "Contested nonce burn claim preparation attempt"
    ) !== record.preparationAttempts
  ) {
    throw new Error(
      "Contested nonce burn claim preparation attempt does not match the record"
    )
  }
  const claimedAtUnixMs = unixMilliseconds(
    claim.claimedAtUnixMs,
    "Contested nonce burn claim time"
  )
  if (
    claimedAtUnixMs < record.createdAtUnixMs ||
    claimedAtUnixMs > record.updatedAtUnixMs
  ) {
    throw new Error("Contested nonce burn claim time is outside the record")
  }
  if (
    record.reservedNonce === undefined ||
    bytes32(
      record.reservedNonce.reservationID,
      "Contested nonce burn reserved nonce ID"
    ) !== reservationID
  ) {
    throw new Error("Contested nonce burn claim lacks its durable reservation")
  }
}

function assertContestedNonceBurn(
  record: P2TRSignatureFraudChallengeOutboxRecord
): void {
  const burn = record.contestedNonceBurn
  if (burn === undefined) return
  assertExactKeys(
    burn,
    DURABLE_CONTESTED_NONCE_BURN_KEYS,
    "contested nonce burn"
  )
  const rawTransaction = hexData(
    burn.rawTransaction,
    "Contested nonce burn raw transaction"
  )
  const byteLength = stripHex(rawTransaction).length / 2
  if (byteLength === 0 || byteLength > MAX_SIGNED_ETHEREUM_TRANSACTION_BYTES) {
    throw new Error("Contested nonce burn exceeds the durable byte bound")
  }
  let parsed: ReturnType<typeof utils.parseTransaction>
  try {
    parsed = utils.parseTransaction(rawTransaction)
  } catch {
    throw new Error(
      "Contested nonce burn must be a signed raw Ethereum transaction"
    )
  }
  const sender = utils.getAddress(
    address(burn.sender, "Contested nonce burn sender")
  )
  const nonce = nonNegativeSafeInteger(burn.nonce, "Contested nonce burn nonce")
  const maxFeePerGas = unsignedDecimal(
    burn.maxFeePerGas,
    "Contested nonce burn maximum fee per gas"
  )
  const maxPriorityFeePerGas = unsignedDecimal(
    burn.maxPriorityFeePerGas,
    "Contested nonce burn maximum priority fee per gas"
  )
  if (
    parsed.hash === undefined ||
    parsed.from === undefined ||
    bytes32(burn.transactionHash, "Contested nonce burn hash") !==
      parsed.hash.toLowerCase() ||
    parsed.to === undefined ||
    utils.getAddress(parsed.from) !== sender ||
    utils.getAddress(parsed.to) !== sender ||
    parsed.chainId !== record.intent.chainID ||
    parsed.nonce !== nonce ||
    !parsed.value.isZero() ||
    parsed.data.toLowerCase() !== "0x" ||
    parsed.type !== 2 ||
    parsed.maxFeePerGas === undefined ||
    parsed.maxPriorityFeePerGas === undefined ||
    !parsed.gasLimit.eq(P2TR_SIGNATURE_FRAUD_NONCE_BURN_GAS_LIMIT) ||
    !parsed.maxFeePerGas.eq(maxFeePerGas) ||
    !parsed.maxPriorityFeePerGas.eq(maxPriorityFeePerGas) ||
    parsed.maxPriorityFeePerGas.gt(parsed.maxFeePerGas) ||
    (parsed.accessList !== undefined && parsed.accessList.length > 0)
  ) {
    throw new Error(
      "Contested nonce burn does not match its signed self-transfer envelope"
    )
  }
  if (
    record.reservedNonce !== undefined &&
    (utils.getAddress(record.reservedNonce.sender) !== sender ||
      record.reservedNonce.nonce !== nonce)
  ) {
    throw new Error("Contested nonce burn names another durable reservation")
  }
  bytes32(burn.signerInvocationID, "Contested nonce burn signer invocation ID")
  const signedAtUnixMs = unixMilliseconds(
    burn.signedAtUnixMs,
    "Contested nonce burn signing time"
  )
  if (
    burn.broadcastAtUnixMs !== undefined &&
    unixMilliseconds(
      burn.broadcastAtUnixMs,
      "Contested nonce burn broadcast time"
    ) < signedAtUnixMs
  ) {
    throw new Error("Contested nonce burn broadcast precedes signing")
  }
}

function assertGenerationTriggerKeys(
  trigger: P2TRSignatureFraudChallengeOutboxRecord["generationTrigger"]
): void {
  const allowed =
    trigger.kind === "initial"
      ? new Set(["kind"])
      : trigger.kind === "nonce-disposition"
      ? new Set(["kind", "previousRecordID", "dispositionHash"])
      : trigger.kind === "canonical-reappearance"
      ? new Set(["kind", "previousRecordID", "cancellationEvidenceHash"])
      : new Set([
          "kind",
          "previousRecordID",
          "invalidationEvidenceHash",
          "previousProvenanceFingerprint",
        ])
  assertExactKeys(trigger, allowed, "generation trigger")
}

function assertCancellationEvidenceKeys(
  evidence: NonNullable<
    P2TRSignatureFraudChallengeOutboxRecord["cancellationEvidence"]
  >
): void {
  const common = [
    "evidenceHash",
    "kind",
    "originalCandidate",
    "canonicalCursor",
    "agreement",
  ]
  assertExactKeys(
    evidence,
    evidence.kind === "canonical-reorg"
      ? new Set([...common, "candidateCurrent", "replacementCanonicalTip"])
      : new Set([
          ...common,
          "conflictingOutpoint",
          "canonicalSpend",
          "bridgeProofReceipt",
        ]),
    "canonical cancellation evidence"
  )
  assertExactKeys(
    evidence.originalCandidate,
    DURABLE_CANDIDATE_POINTER_KEYS,
    "cancellation original candidate"
  )
  assertExactKeys(
    evidence.canonicalCursor,
    DURABLE_CANONICAL_CURSOR_KEYS,
    "cancellation canonical cursor"
  )
  assertExactKeys(
    evidence.agreement,
    DURABLE_CANCELLATION_AGREEMENT_KEYS,
    "cancellation agreement"
  )
  if (evidence.kind === "canonical-reorg") {
    assertExactKeys(
      evidence.replacementCanonicalTip,
      new Set(["blockHash", "blockHeight"]),
      "canonical replacement tip"
    )
    return
  }
  assertExactKeys(
    evidence.conflictingOutpoint,
    new Set(["txid", "vout"]),
    "honest-spend conflicting outpoint"
  )
  assertExactKeys(
    evidence.canonicalSpend,
    DURABLE_CANDIDATE_POINTER_KEYS,
    "honest canonical spend"
  )
  assertExactKeys(
    evidence.bridgeProofReceipt,
    new Set([
      "transactionHash",
      "blockHash",
      "blockNumber",
      "logIndex",
      "proofType",
    ]),
    "honest-spend Bridge proof receipt"
  )
}

function assertResolutionKeys(
  resolution:
    | NonNullable<
        P2TRSignatureFraudChallengeOutboxRecord["finalNonceResolution"]
      >
    | NonNullable<
        P2TRSignatureFraudChallengeOutboxRecord["generationDisposition"]
      >,
  label: string
): void {
  const common = [
    "status",
    "observedHead",
    "finalizedThrough",
    "canonicalAttestations",
    "routerChallenge",
  ]
  if (resolution.status === "terminal-reverted") {
    assertExactKeys(resolution, new Set([...common, "receipt"]), label)
  } else if (resolution.status === "terminal-nonce-consumed") {
    assertExactKeys(
      resolution,
      new Set([
        ...common,
        "sender",
        "transactionNonce",
        "finalizedAccountNonce",
        "accountNonceReadAtBlock",
        "transactionAbsent",
        "consumingTransaction",
      ]),
      label
    )
    assertNonceConsumingTransactionKeys(resolution.consumingTransaction, label)
  } else {
    assertExactKeys(
      resolution,
      new Set([
        ...common,
        "receipt",
        "transaction",
        "submittedEvent",
        "ownTransactionDisposition",
      ]),
      label
    )
    assertCanonicalTransactionKeys(resolution.transaction, label)
    assertExactKeys(
      resolution.submittedEvent,
      new Set([
        "routerAddress",
        "transactionHash",
        "blockNumber",
        "blockHash",
        "blockTimestamp",
        "logIndex",
        "walletID",
        "walletPubKeyHash",
        "bridgeChallengeIdentity",
        "challengeKey",
        "sighash",
      ]),
      `${label} submitted event`
    )
    if (resolution.ownTransactionDisposition !== undefined) {
      const disposition = resolution.ownTransactionDisposition
      if (disposition.status === "reverted") {
        assertExactKeys(
          disposition,
          new Set(["status", "receipt"]),
          `${label} own transaction disposition`
        )
        assertCanonicalReceiptKeys(disposition.receipt, label)
      } else {
        assertExactKeys(
          disposition,
          new Set([
            "status",
            "sender",
            "transactionNonce",
            "finalizedAccountNonce",
            "accountNonceReadAtBlock",
            "transactionAbsent",
            "consumingTransaction",
          ]),
          `${label} own transaction disposition`
        )
        assertNonceConsumingTransactionKeys(
          disposition.consumingTransaction,
          label
        )
      }
    }
  }
  assertExactKeys(
    resolution.observedHead,
    new Set(["blockNumber", "blockHash"]),
    `${label} observed head`
  )
  assertExactKeys(
    resolution.finalizedThrough,
    new Set(["blockNumber", "blockHash"]),
    `${label} finalized boundary`
  )
  for (const attestation of resolution.canonicalAttestations) {
    assertExactKeys(
      attestation,
      new Set([
        "trustDomainID",
        "independenceDomainID",
        "evidenceDigest",
        "attestation",
        "attestedAtUnixMs",
      ]),
      `${label} canonical attestation`
    )
  }
  assertCanonicalRouterChallengeKeys(resolution.routerChallenge, label)
  if ("receipt" in resolution) {
    assertCanonicalReceiptKeys(resolution.receipt, label)
  }
}

function assertCanonicalReceiptKeys(value: object, label: string): void {
  assertExactKeys(
    value,
    new Set(["transactionHash", "status", "blockNumber", "blockHash"]),
    `${label} canonical receipt`
  )
}

function assertNonceConsumingTransactionKeys(
  value: object,
  label: string
): void {
  assertExactKeys(
    value,
    new Set(["transactionHash", "sender", "nonce", "blockNumber", "blockHash"]),
    `${label} nonce-consuming transaction`
  )
}

function assertCanonicalRouterChallengeKeys(
  value: { exists: boolean },
  label: string
): void {
  assertExactKeys(
    value,
    value.exists
      ? new Set([
          "exists",
          "challengeKey",
          "challenger",
          "depositAmount",
          "reportedAt",
          "resolved",
          "readAtBlock",
        ])
      : new Set(["exists", "challengeKey", "readAtBlock"]),
    `${label} Router challenge`
  )
}

function assertCanonicalTransactionKeys(
  value: {
    decodedSubmissionCall: object
  },
  label: string
): void {
  assertExactKeys(
    value,
    new Set([
      "transactionHash",
      "sender",
      "routerAddress",
      "calldata",
      "value",
      "nonce",
      "chainID",
      "blockNumber",
      "blockHash",
      "decodedSubmissionCall",
    ]),
    `${label} canonical transaction`
  )
  assertExactKeys(
    value.decodedSubmissionCall,
    new Set([
      "variant",
      "selector",
      "action",
      "walletID",
      "bridgeChallengeIdentity",
      "challengeKey",
      "sighash",
    ]),
    `${label} decoded submission call`
  )
}

function returnedReservationTombstoneValues(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  item: P2TRSignatureFraudVoidedNonceReservation,
  reservation: P2TRSignatureFraudVoidedNonceReservation["reservation"]
): readonly unknown[] {
  return [
    stripHex(hexValue(reservation.reservationID, "Nonce reservation ID")),
    stripHex(bytes32(record.recordID, "Nonce reservation record ID")),
    record.intent.chainID,
    reservation.laneID,
    reservation.signerIdentity,
    stripHex(address(reservation.sender, "Reserved sender")),
    reservation.nonce,
    stripHex(hexData(reservation.bindingSignature, "Reservation binding")),
    reservation.reservationEpoch,
    unixMilliseconds(item.voidedAtUnixMs, "Reservation tombstone time"),
    item.reasonCode,
    stripHex(bytes32(item.evidenceDigest, "Reservation tombstone digest")),
  ]
}

function assertExactKeys(
  value: object,
  allowed: ReadonlySet<string>,
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported durable field ${key}`)
    }
  }
}

function assertNoRawObservationFields(value: unknown): void {
  if (value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) assertNoRawObservationFields(item)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_RAW_OBSERVATION_KEYS.has(key)) {
      throw new Error(
        `Durable outbox state cannot contain raw observation field ${key}`
      )
    }
    assertNoRawObservationFields(item)
  }
}

type ProvenanceIncidentKind =
  | "reservation-intent-in-flight"
  | "signer-boundary-active"
  | "signed-envelope-escaped"
  | "broadcast-attempt-active"
  | "terminal-chain-effect"
  | "manifest-rotation-signed-state"

type PriorGenerationLinks = {
  previousRecordID?: string
  generationCause?:
    | "finalized-revert"
    | "finalized-nonce-consumed"
    | "canonical-reappearance"
    | "provenance-restored"
  priorNonceDispositionID?: string
  priorCancellationEvidenceID?: string
  priorProvenanceInvalidationID?: string
}

function provenanceIncidentKind(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  reservationIntentInFlight: boolean,
  terminal: boolean
): ProvenanceIncidentKind {
  if (terminal) return "terminal-chain-effect"
  if (record.broadcastAttempts > 0) return "broadcast-attempt-active"
  if ((record.preparedTransactionVariants?.length ?? 0) > 0) {
    return "signed-envelope-escaped"
  }
  if (
    record.signerInvocationStartedAtUnixMs !== undefined ||
    record.activeSignerInvocationStartedAtUnixMs !== undefined
  ) {
    return "signer-boundary-active"
  }
  if (reservationIntentInFlight) return "reservation-intent-in-flight"
  return "signer-boundary-active"
}

function outboxInsertColumns(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  prior: PriorGenerationLinks
): Record<string, unknown> {
  const identity: Record<string, unknown> = {
    record_id: databaseBytes(bytes32(record.recordID, "Outbox record ID")),
    series_id: databaseBytes(bytes32(record.seriesID, "Outbox series ID")),
    intent_id: databaseBytes(
      hexValue(record.intent.intentID, "Outbox intent ID")
    ),
    generation: record.generation,
    previous_record_id: optionalDatabaseBytes(prior.previousRecordID),
    generation_cause: prior.generationCause ?? null,
    prior_nonce_disposition_id: optionalDatabaseBytes(
      prior.priorNonceDispositionID
    ),
    prior_cancellation_evidence_id: optionalDatabaseBytes(
      prior.priorCancellationEvidenceID
    ),
    prior_provenance_invalidation_id: optionalDatabaseBytes(
      prior.priorProvenanceInvalidationID
    ),
    observation_id: databaseBytes(
      hexValue(record.intent.observationID, "Outbox observation ID")
    ),
    evidence_protocol_id: databaseBytes(
      hexValue(
        record.intent.evidenceProtocolID,
        "COMPLETE_V2 evidence protocol ID"
      )
    ),
    intent_input_index: record.intent.inputIndex,
    bridge_challenge_key: databaseBytes(
      hexValue(record.intent.bridgeChallengeKey, "Bridge challenge key")
    ),
    wallet_id: databaseBytes(hexValue(record.intent.walletID, "Wallet ID")),
    signing_key: databaseBytes(
      hexValue(record.intent.signingKey, "COMPLETE_V2 signing key")
    ),
    binding_tx_hash: databaseBytes(
      hexValue(record.intent.bindingTxHash, "COMPLETE_V2 binding txid")
    ),
    binding_output_index: record.intent.bindingOutputIndex,
    bridge_challenge_identity: databaseBytes(
      hexValue(
        record.intent.bridgeChallengeIdentity,
        "Bridge challenge identity"
      )
    ),
    sighash: databaseBytes(hexValue(record.intent.sighash, "Fraud sighash")),
    signature_nonce_x: databaseBytes(
      hexValue(record.intent.nonceX, "COMPLETE_V2 signature nonce X")
    ),
    signature_scalar: databaseBytes(
      hexValue(record.intent.signatureScalar, "COMPLETE_V2 signature scalar")
    ),
    domain_chain_id: record.intent.domainChainID,
    chain_id: record.intent.chainID,
    bridge_address: databaseBytes(
      address(record.intent.bridgeAddress, "Bridge address")
    ),
    router_address: databaseBytes(
      address(record.intent.routerAddress, "Router address")
    ),
    calldata: databaseBytes(
      hexData(record.intent.calldata, "Challenge calldata")
    ),
    value_wei: unsignedDecimal(record.intent.value, "Challenge value"),
    fee_policy_hash: databaseBytes(
      bytes32(record.feePolicyManifest.policyHash, "Fee policy hash")
    ),
    bitcoin_tx_hash: databaseBytes(
      bytes32(record.evidenceCheckpoint.bitcoinTxHash, "Bitcoin txid")
    ),
    bitcoin_wtxid: databaseBytes(
      bytes32(record.evidenceCheckpoint.bitcoinWitnessTxHash, "Bitcoin wtxid")
    ),
    bitcoin_input_index: record.evidenceCheckpoint.bitcoinInputIndex,
    bitcoin_block_hash: databaseBytes(
      bytes32(record.evidenceCheckpoint.bitcoinBlockHash, "Bitcoin block hash")
    ),
    bitcoin_block_height: record.evidenceCheckpoint.bitcoinBlockHeight,
    bitcoin_cursor_block_hash: databaseBytes(
      bytes32(
        record.evidenceCheckpoint.bitcoinCursorBlockHash,
        "Bitcoin cursor hash"
      )
    ),
    bitcoin_cursor_block_height:
      record.evidenceCheckpoint.bitcoinCursorBlockHeight,
    ethereum_lifecycle_block_hash: databaseBytes(
      bytes32(
        record.evidenceCheckpoint.ethereumLifecycleBlockHash,
        "Ethereum lifecycle hash"
      )
    ),
    ethereum_lifecycle_block_number:
      record.evidenceCheckpoint.ethereumLifecycleBlockNumber,
    activation_manifest_hash: databaseBytes(
      bytes32(
        record.evidenceCheckpoint.activationManifest.manifestHash,
        "Activation manifest hash"
      )
    ),
    router_code_hash: databaseBytes(
      bytes32(
        record.evidenceCheckpoint.activationManifest.routerCodeHash,
        "Router code hash"
      )
    ),
    router_protocol_id: databaseBytes(
      bytes32(
        record.evidenceCheckpoint.activationManifest.routerProtocolID,
        "Router protocol ID"
      )
    ),
    router_domain_chain_id:
      record.evidenceCheckpoint.activationManifest.routerDomainChainID,
    complete_authorization_registry_address: databaseBytes(
      address(
        record.evidenceCheckpoint.activationManifest
          .completeAuthorizationRegistryAddress,
        "COMPLETE registry address"
      )
    ),
    complete_authorization_registry_code_hash: databaseBytes(
      bytes32(
        record.evidenceCheckpoint.activationManifest
          .completeAuthorizationRegistryCodeHash,
        "COMPLETE registry code hash"
      )
    ),
    complete_authorization_registry_protocol_id: databaseBytes(
      bytes32(
        record.evidenceCheckpoint.activationManifest
          .completeAuthorizationRegistryProtocolID,
        "COMPLETE authorization registry protocol ID"
      )
    ),
    complete_reservation_model: databaseBytes(
      bytes32(
        record.evidenceCheckpoint.activationManifest.completeReservationModel,
        "COMPLETE reservation model"
      )
    ),
    ethereum_eligibility_read_set_hash: databaseBytes(
      bytes32(
        record.canonicalEthereumEligibility.readSetHash,
        "Eligibility read-set hash"
      )
    ),
    canonical_provenance_journal_store_id:
      record.canonicalProvenance.journalStoreID,
    canonical_provenance_descriptor_set_hash: databaseBytes(
      bytes32(
        record.canonicalProvenance.descriptorSetHash,
        "Provenance descriptor-set hash"
      )
    ),
    canonical_provenance_through_block_number:
      record.canonicalProvenance.throughBlockNumber,
    canonical_provenance_through_block_hash: databaseBytes(
      bytes32(
        record.canonicalProvenance.throughBlockHash,
        "Provenance through block hash"
      )
    ),
    canonical_provenance_history_root: databaseBytes(
      bytes32(record.canonicalProvenance.historyRoot, "Provenance history root")
    ),
    canonical_provenance_event_set_hash: databaseBytes(
      bytes32(
        record.canonicalProvenance.eventSetHash,
        "Provenance event-set hash"
      )
    ),
    canonical_provenance_event_count: record.canonicalProvenance.eventCount,
    canonical_candidate_digest: databaseBytes(
      bytes32(
        record.canonicalProvenance.candidateDigest,
        "Canonical candidate digest"
      )
    ),
    canonical_candidate_provenance_generation:
      record.canonicalProvenance.candidateProvenanceGeneration,
    canonical_provenance_challenge_key: databaseBytes(
      bytes32(
        record.canonicalProvenance.challengeKey,
        "Canonical challenge key"
      )
    ),
    canonical_readiness_certificate_id: databaseBytes(
      bytes32(
        record.canonicalProvenance.readinessCertificateID,
        "Readiness certificate ID"
      )
    ),
    canonical_readiness_certificate_generation:
      record.canonicalProvenance.readinessCertificateGeneration,
    canonical_input_binding_kind: record.canonicalProvenance.inputBindingKind,
    canonical_input_binding_source_event_id: databaseBytes(
      bytes32(
        record.canonicalProvenance.inputBindingSourceEventID,
        "Input binding event ID"
      )
    ),
    canonical_input_index: record.canonicalProvenance.inputIndex,
    canonical_funding_block_hash: databaseBytes(
      bytes32(record.canonicalProvenance.fundingBlockHash, "Funding block hash")
    ),
    canonical_funding_txid: databaseBytes(
      bytes32(record.canonicalProvenance.fundingTxid, "Funding txid")
    ),
    canonical_funding_vout: record.canonicalProvenance.fundingVout,
    canonical_input_wallet_id: databaseBytes(
      bytes32(record.canonicalProvenance.inputWalletID, "Input wallet ID")
    ),
    canonical_input_output_key: databaseBytes(
      bytes32(record.canonicalProvenance.inputOutputKey, "Input output key")
    ),
    canonical_binding_ethereum_block_number:
      record.canonicalProvenance.bindingEthereumBlockNumber,
    canonical_binding_ethereum_block_hash: databaseBytes(
      bytes32(
        record.canonicalProvenance.bindingEthereumBlockHash,
        "Binding Ethereum block hash"
      )
    ),
    canonical_provenance_fingerprint: databaseBytes(
      bytes32(
        record.canonicalProvenance.provenanceFingerprint,
        "Provenance fingerprint"
      )
    ),
    canonical_provenance_manifest_hash: databaseBytes(
      bytes32(
        record.canonicalProvenance.manifestHash,
        "Provenance manifest hash"
      )
    ),
    router_challenge_absent:
      record.canonicalEthereumEligibility.routerChallengeAbsent,
    complete_exact_challenge_authorization_absent:
      record.canonicalEthereumEligibility
        .completeExactChallengeAuthorizationAbsent,
    complete_exact_transaction_authorization_absent:
      record.canonicalEthereumEligibility
        .completeExactTransactionAuthorizationAbsent,
    complete_wallet_reservation_active:
      record.canonicalEthereumEligibility.completeWalletReservationActive,
    complete_active_reservation_challenge_identity: optionalDatabaseBytes(
      record.canonicalEthereumEligibility
        .completeActiveReservationChallengeIdentity
    ),
    wallet_challengeable:
      record.canonicalEthereumEligibility.walletChallengeable,
    canonical_proof_backlog_complete:
      record.canonicalEthereumEligibility.canonicalProofBacklogComplete,
    submitted_event_scan_from_block:
      record.evidenceCheckpoint.submittedEventScanFromBlock,
    confirmed_source_complete:
      record.evidenceCheckpoint.confirmedSourceComplete,
    created_at_unix_ms: record.createdAtUnixMs,
  }
  return { ...identity, ...outboxMutableColumns(record) }
}

function outboxMutableColumns(
  record: P2TRSignatureFraudChallengeOutboxRecord
): Record<string, unknown> {
  const reservation = record.reservedNonce
  const variants = record.preparedTransactionVariants ?? []
  const latestVariant = variants[variants.length - 1]
  const latestQuarantine =
    record.signerQuarantines?.[record.signerQuarantines.length - 1]
  const dispositionID =
    record.finalNonceResolution === undefined
      ? undefined
      : nonceDispositionID(record.finalNonceResolution)
  return {
    status: record.status,
    version: record.version,
    updated_at_unix_ms: record.updatedAtUnixMs,
    preparation_attempts: record.preparationAttempts,
    preparation_lease_owner: record.preparationLease?.owner ?? null,
    preparation_lease_expires_at_unix_ms:
      record.preparationLease?.expiresAtUnixMs ?? null,
    preparation_resume_status: record.preparationResumeStatus ?? null,
    selected_signer_lane_id: record.selectedLaneID ?? null,
    selected_signer_identity: record.selectedSignerIdentity ?? null,
    selected_sender:
      record.preparationSender === undefined
        ? null
        : databaseBytes(address(record.preparationSender, "Selected sender")),
    nonce_reservation_id:
      reservation === undefined
        ? null
        : databaseBytes(
            hexValue(reservation.reservationID, "Nonce reservation ID")
          ),
    signer_lane_id: reservation?.laneID ?? null,
    signer_identity: reservation?.signerIdentity ?? null,
    reserved_sender:
      reservation === undefined
        ? null
        : databaseBytes(address(reservation.sender, "Reserved sender")),
    reserved_nonce: reservation?.nonce ?? null,
    nonce_reservation_binding:
      reservation === undefined
        ? null
        : databaseBytes(
            hexData(reservation.bindingSignature, "Nonce reservation binding")
          ),
    nonce_reserved_at_unix_ms: record.nonceReservedAtUnixMs ?? null,
    signer_invocation_started_at_unix_ms:
      record.signerInvocationStartedAtUnixMs ?? null,
    signer_invocation_id: optionalDatabaseBytes(record.signerInvocationID),
    active_signer_invocation_started_at_unix_ms:
      record.activeSignerInvocationStartedAtUnixMs ?? null,
    active_signer_invocation_id: optionalDatabaseBytes(
      record.activeSignerInvocationID
    ),
    latest_variant_sequence: latestVariant?.sequence ?? null,
    prepared_transaction_hash:
      latestVariant === undefined
        ? null
        : databaseBytes(
            hexValue(
              latestVariant.preparedTransaction.transactionHash,
              "Latest prepared transaction hash"
            )
          ),
    nonce_disposition_id: optionalDatabaseBytes(dispositionID),
    lane_released_at_unix_ms:
      record.finalNonceResolution === undefined ? null : record.updatedAtUnixMs,
    cancellation_evidence_id: optionalDatabaseBytes(
      record.cancellationEvidence?.evidenceHash
    ),
    provenance_invalidation_id: optionalDatabaseBytes(
      record.provenanceInvalidationEvidence?.evidenceHash
    ),
    signer_quarantine_id: optionalDatabaseBytes(
      latestQuarantine === undefined || record.status !== "quarantined"
        ? undefined
        : signerQuarantineID(latestQuarantine)
    ),
    broadcast_attempts: record.broadcastAttempts,
    last_broadcast_at_unix_ms: record.lastBroadcastAtUnixMs ?? null,
    reconciliation_attempts: record.reconciliationAttempts,
    last_reconciliation_at_unix_ms: record.lastReconciliationAtUnixMs ?? null,
    last_pre_broadcast_recheck_at_unix_ms:
      record.lastPreBroadcastRecheckAtUnixMs ?? null,
    last_pre_broadcast_recheck_status:
      record.lastPreBroadcastRecheckStatus ?? null,
    last_resolution_status: record.lastResolutionStatus ?? null,
    last_error: record.lastError ?? null,
    record_state: JSON.stringify(serializeJSON(record)),
  }
}

function nonceDispositionID(
  resolution: P2TRSignatureFraudChallengeOutboxRecord["finalNonceResolution"]
): string {
  if (resolution === undefined) {
    throw new Error("Nonce disposition is absent")
  }
  if (
    resolution.status === "terminal-reverted" ||
    resolution.status === "terminal-nonce-consumed"
  ) {
    return computeP2TRSignatureFraudDispositionHash(resolution)
  }
  return hashStructured({
    domain: "tbtc-p2tr-signature-fraud-final-nonce-resolution-v1",
    evidenceDigest:
      computeP2TRSignatureFraudResolutionEvidenceDigest(resolution),
    canonicalAttestations: resolution.canonicalAttestations,
  })
}

function signerQuarantineID(
  quarantine: P2TRSignatureFraudSignerQuarantine
): string {
  return hashStructured({
    domain: "tbtc-p2tr-signature-fraud-signer-quarantine-v1",
    ...quarantine,
  })
}

function findSubmittedArtifact(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  transactionHash: string
): { variantSequence: number | null; lateArtifactID: string | null } {
  const normalized = bytes32(transactionHash, "Disposition transaction hash")
  const variant = record.preparedTransactionVariants?.find(
    (variant) =>
      hexValue(
        variant.preparedTransaction.transactionHash,
        "Prepared transaction hash"
      ) === normalized
  )
  if (variant !== undefined) {
    return { variantSequence: variant.sequence, lateArtifactID: null }
  }
  const late = record.unexpectedSignedArtifacts?.find(
    (artifact) =>
      hexValue(
        artifact.preparedTransaction.transactionHash,
        "Late transaction hash"
      ) === normalized
  )
  return {
    variantSequence: null,
    lateArtifactID: late === undefined ? null : normalized,
  }
}

function hasSignedTransactionHash(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  transactionHash: string
): boolean {
  const normalized = bytes32(transactionHash, "Signed transaction hash")
  return [
    ...(record.preparedTransactionVariants ?? []).map((variant) =>
      hexValue(
        variant.preparedTransaction.transactionHash,
        "Prepared transaction hash"
      )
    ),
    ...(record.unexpectedSignedArtifacts ?? []).map((artifact) =>
      hexValue(
        artifact.preparedTransaction.transactionHash,
        "Unexpected transaction hash"
      )
    ),
  ].includes(normalized)
}

function canonicalClaimBinding(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  expectedProvenance: P2TRSignatureFraudCanonicalProvenanceBinding
): P2TRPostgresOutboxCanonicalClaimBinding {
  if (
    canonicalJSON(record.canonicalProvenance) !==
    canonicalJSON(expectedProvenance)
  ) {
    throw new Error(
      "Claim provenance differs from the durable outbox generation"
    )
  }
  return {
    recordID: bytes32(record.recordID, "Claim record ID"),
    observationID: hexValue(
      record.intent.observationID,
      "Claim observation ID"
    ),
    bridgeChallengeKey: hexValue(
      record.intent.bridgeChallengeKey,
      "Claim challenge key"
    ),
    candidate: {
      txid: bytes32(record.evidenceCheckpoint.bitcoinTxHash, "Claim txid"),
      wtxid: bytes32(
        record.evidenceCheckpoint.bitcoinWitnessTxHash,
        "Claim wtxid"
      ),
      inputIndex: record.evidenceCheckpoint.bitcoinInputIndex,
      blockHash: bytes32(
        record.evidenceCheckpoint.bitcoinBlockHash,
        "Claim Bitcoin block hash"
      ),
      blockHeight: record.evidenceCheckpoint.bitcoinBlockHeight,
    },
    provenance: expectedProvenance,
  }
}

function preservesCASIdentities(
  current: P2TRSignatureFraudChallengeOutboxRecord,
  next: P2TRSignatureFraudChallengeOutboxRecord
): boolean {
  const immutable = (record: P2TRSignatureFraudChallengeOutboxRecord) => ({
    seriesID: record.seriesID,
    recordID: record.recordID,
    intent: record.intent,
    evidenceCheckpoint: record.evidenceCheckpoint,
    canonicalEthereumEligibility: record.canonicalEthereumEligibility,
    canonicalProvenance: record.canonicalProvenance,
    feePolicyManifest: record.feePolicyManifest,
    generation: record.generation,
    generationTrigger: record.generationTrigger,
    createdAtUnixMs: record.createdAtUnixMs,
  })
  if (canonicalJSON(immutable(current)) !== canonicalJSON(immutable(next))) {
    return false
  }
  if (
    !arrayHasImmutablePrefix(
      current.voidedNonceReservations,
      next.voidedNonceReservations
    ) ||
    !arrayHasImmutablePrefix(
      current.signerQuarantines,
      next.signerQuarantines
    ) ||
    !arrayHasImmutablePrefix(
      current.unexpectedSignedArtifacts,
      next.unexpectedSignedArtifacts
    )
  ) {
    return false
  }
  for (const [index, prior] of (
    current.preparedTransactionVariants ?? []
  ).entries()) {
    const candidate = next.preparedTransactionVariants?.[index]
    if (
      candidate === undefined ||
      canonicalJSON({
        sequence: prior.sequence,
        preparedTransaction: prior.preparedTransaction,
        signedAtUnixMs: prior.signedAtUnixMs,
      }) !==
        canonicalJSON({
          sequence: candidate.sequence,
          preparedTransaction: candidate.preparedTransaction,
          signedAtUnixMs: candidate.signedAtUnixMs,
        }) ||
      candidate.broadcastAttempts < prior.broadcastAttempts
    ) {
      return false
    }
  }
  const nextVariantCount = next.preparedTransactionVariants?.length ?? 0
  const currentVariantCount = current.preparedTransactionVariants?.length ?? 0
  if (nextVariantCount > currentVariantCount + 1) return false
  if (
    current.reservedNonce !== undefined &&
    next.reservedNonce !== undefined &&
    canonicalJSON(current.reservedNonce) !== canonicalJSON(next.reservedNonce)
  ) {
    return false
  }
  if (current.contestedNonceBurn !== undefined) {
    if (next.contestedNonceBurn === undefined) return false
    const {
      broadcastAtUnixMs: currentBroadcastAtUnixMs,
      ...currentSignedBurn
    } = current.contestedNonceBurn
    const { broadcastAtUnixMs: nextBroadcastAtUnixMs, ...nextSignedBurn } =
      next.contestedNonceBurn
    if (canonicalJSON(currentSignedBurn) !== canonicalJSON(nextSignedBurn)) {
      return false
    }
    if (
      currentBroadcastAtUnixMs !== undefined &&
      nextBroadcastAtUnixMs !== currentBroadcastAtUnixMs
    ) {
      return false
    }
  }
  const currentBurnClaim = current.contestedNonceBurnClaim
  const nextBurnClaim = next.contestedNonceBurnClaim
  if (currentBurnClaim !== undefined) {
    if (next.reservedNonce === undefined) return false
    if (nextBurnClaim !== undefined) {
      if (canonicalJSON(currentBurnClaim) !== canonicalJSON(nextBurnClaim)) {
        return false
      }
    } else if (
      next.contestedNonceBurn === undefined ||
      bytes32(
        next.contestedNonceBurn.signerInvocationID,
        "Contested nonce burn signer invocation ID"
      ) !==
        bytes32(
          currentBurnClaim.signerInvocationID,
          "Contested nonce burn claim signer invocation ID"
        )
    ) {
      return false
    }
  } else if (nextBurnClaim !== undefined) {
    if (
      current.activeSignerInvocationStartedAtUnixMs === undefined ||
      current.reservedNonce === undefined ||
      nextBurnClaim.recordVersion !== current.version
    ) {
      return false
    }
  }
  if (
    current.contestedNonceBurn === undefined &&
    next.contestedNonceBurn !== undefined &&
    currentBurnClaim === undefined
  ) {
    return false
  }
  if (nextVariantCount === currentVariantCount) {
    if (
      canonicalJSON(current.preparedTransaction ?? null) !==
      canonicalJSON(next.preparedTransaction ?? null)
    ) {
      return false
    }
  } else if (
    canonicalJSON(next.preparedTransaction ?? null) !==
    canonicalJSON(
      next.preparedTransactionVariants?.[nextVariantCount - 1]
        .preparedTransaction ?? null
    )
  ) {
    return false
  }
  for (const key of [
    "cancellationEvidence",
    "provenanceInvalidationEvidence",
    "finalNonceResolution",
    "generationDisposition",
  ] as const) {
    if (
      current[key] !== undefined &&
      canonicalJSON(current[key]) !== canonicalJSON(next[key])
    ) {
      return false
    }
  }
  return true
}

function arrayHasImmutablePrefix<T>(
  current: readonly T[] | undefined,
  next: readonly T[] | undefined
): boolean {
  const before = current ?? []
  const after = next ?? []
  return (
    after.length >= before.length &&
    before.every(
      (entry, index) => canonicalJSON(entry) === canonicalJSON(after[index])
    )
  )
}

async function insertObject(
  session: P2TRPostgresOutboxTransactionSession,
  table: string,
  columns: Record<string, unknown>,
  suffix = ""
) {
  const entries = Object.entries(columns)
  const names = entries.map(([name]) => quoteIdentifier(name)).join(", ")
  const placeholders = entries.map((_, index) => `$${index + 1}`).join(", ")
  return session.query(
    `INSERT INTO ${quoteIdentifier(table)} (${names})
     VALUES (${placeholders}) ${suffix}`,
    entries.map(([, value]) => value)
  )
}

function hydrateRecordState(
  value: unknown
): P2TRSignatureFraudChallengeOutboxRecord {
  const parsed =
    typeof value === "string"
      ? (JSON.parse(value) as Record<string, any>)
      : value
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stored outbox record state is not a JSON object")
  }
  const state = parsed as P2TRSignatureFraudChallengeOutboxRecord
  hydrateIntent(state.intent)
  if (state.reservedNonce !== undefined) hydrateReservation(state.reservedNonce)
  for (const item of state.voidedNonceReservations ?? []) {
    hydrateReservation(item.reservation)
  }
  if (state.preparedTransaction !== undefined) {
    hydratePreparedTransaction(state.preparedTransaction)
  }
  for (const variant of state.preparedTransactionVariants ?? []) {
    hydratePreparedTransaction(variant.preparedTransaction)
  }
  for (const artifact of state.unexpectedSignedArtifacts ?? []) {
    hydratePreparedTransaction(artifact.preparedTransaction)
  }
  return state
}

function hydrateIntent(
  intent: P2TRSignatureFraudChallengeOutboxRecord["intent"]
): void {
  if (intent === undefined || typeof intent !== "object") {
    throw new Error("Stored outbox intent is absent")
  }
  const hydrated = intent as unknown as Record<string, unknown>
  for (const key of [
    "evidenceProtocolID",
    "intentID",
    "observationID",
    "bridgeChallengeKey",
    "walletID",
    "signingKey",
    "bindingTxHash",
    "bridgeChallengeIdentity",
    "sighash",
    "nonceX",
    "signatureScalar",
  ] as const) {
    hydrated[key] = Hex.from(hexValue(intent[key], `Stored intent ${key}`))
  }
}

function hydrateReservation(
  reservation: NonNullable<
    P2TRSignatureFraudChallengeOutboxRecord["reservedNonce"]
  >
): void {
  reservation.reservationID = Hex.from(
    hexValue(reservation.reservationID, "Stored reservation ID")
  )
  reservation.outboxRecordID = Hex.from(
    hexValue(reservation.outboxRecordID, "Stored reservation record ID")
  )
  reservation.intentID = Hex.from(
    hexValue(reservation.intentID, "Stored reservation intent ID")
  )
}

function hydratePreparedTransaction(
  transaction: P2TRSignatureFraudPreparedTransactionVariant["preparedTransaction"]
): void {
  transaction.intentID = Hex.from(
    hexValue(transaction.intentID, "Stored prepared intent ID")
  )
  transaction.transactionHash = Hex.from(
    hexValue(transaction.transactionHash, "Stored prepared transaction hash")
  )
  if (transaction.invocation !== undefined) {
    transaction.invocation.invocationID = Hex.from(
      hexValue(
        transaction.invocation.invocationID,
        "Stored prepared signer invocation ID"
      )
    )
    transaction.invocation.requestDigest = Hex.from(
      hexValue(
        transaction.invocation.requestDigest,
        "Stored prepared signer invocation request digest"
      )
    )
  }
}

function serializeJSON(value: unknown): unknown {
  if (value === undefined) return undefined
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (Buffer.isBuffer(value)) return `0x${value.toString("hex")}`
  if (value instanceof Hex) return value.toPrefixedString()
  if (Array.isArray(value)) return value.map(serializeJSON)
  if (typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const serialized = serializeJSON(entry)
      if (serialized !== undefined) result[key] = serialized
    }
    return result
  }
  throw new Error("Outbox record contains a non-serializable value")
}

function setOptional<K extends keyof P2TRSignatureFraudChallengeOutboxRecord>(
  state: P2TRSignatureFraudChallengeOutboxRecord,
  key: K,
  value: P2TRSignatureFraudChallengeOutboxRecord[K] | undefined
): void {
  if (value === undefined) delete state[key]
  else state[key] = value
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error("Unsafe PostgreSQL identifier")
  }
  return `"${value}"`
}

function databaseBytes(value: string): Buffer {
  return Buffer.from(
    stripHex(hexData(value, "Database hexadecimal value")),
    "hex"
  )
}

function optionalDatabaseBytes(value: string | undefined): Buffer | null {
  return value === undefined ? null : databaseBytes(value)
}

function prefixedHex(value: Buffer): string {
  return `0x${value.toString("hex")}`
}

function optionalAddress(value: Buffer | null): string | undefined {
  return value === null
    ? undefined
    : address(prefixedHex(value), "Stored address")
}

function optionalDatabaseInteger(
  value: string | number | null
): number | undefined {
  return value === null
    ? undefined
    : databaseSafeInteger(value, "Stored integer")
}

function databaseSafeInteger(value: string | number, label: string): number {
  const result = typeof value === "number" ? value : Number(value)
  return nonNegativeSafeInteger(result, label)
}

function hexValue(value: unknown, label: string): string {
  if (value instanceof Hex) return hexData(value.toPrefixedString(), label)
  if (Buffer.isBuffer(value)) return `0x${value.toString("hex")}`
  if (typeof value === "string") return hexData(value, label)
  throw new Error(`${label} is not hexadecimal data`)
}

function hexData(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} must be even-length prefixed hexadecimal data`)
  }
  return value.toLowerCase()
}

function bytes32(value: unknown, label: string): string {
  const normalized = hexValue(value, label)
  if (normalized.length !== 66) throw new Error(`${label} must be 32 bytes`)
  return normalized
}

function address(value: unknown, label: string): string {
  const normalized = hexValue(value, label)
  if (normalized.length !== 42) throw new Error(`${label} must be 20 bytes`)
  return normalized
}

function stripHex(value: string): string {
  return value.slice(2)
}

function optionalStripHex(value: unknown, label: string): string | null {
  return value === undefined || value === null
    ? null
    : stripHex(bytes32(value, label))
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function positiveSafeInteger(value: unknown, label: string): number {
  const result = nonNegativeSafeInteger(value, label)
  if (result === 0) throw new Error(`${label} must be positive`)
  return result
}

function unixMilliseconds(value: unknown, label: string): number {
  return nonNegativeSafeInteger(value, label)
}

function unsignedDecimal(value: unknown, label: string): string {
  const normalized = String(value)
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error(`${label} must be an unsigned decimal integer`)
  }
  return normalized
}

function requireText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must contain between 1 and ${maximum} characters`)
  }
  return value
}

function requireCanonicalOwner(
  value: unknown,
  label: string,
  maximum: number
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must contain between 1 and ${maximum} characters`)
  }
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    !/^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/.test(normalized)
  ) {
    throw new Error(`${label} must contain between 1 and ${maximum} characters`)
  }
  return normalized
}

function normalizeProductionSignerLaneConfiguration(
  configuration: P2TRProductionSignerLaneConfigurationBinding
): P2TRProductionSignerLaneConfigurationBinding {
  const maxFeePerGas = positiveUint256(
    configuration.maxFeePerGas,
    "Signer maximum fee"
  )
  const maxPriorityFeePerGas = uint256(
    configuration.maxPriorityFeePerGas,
    "Signer priority fee"
  )
  if (BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
    throw new Error("Signer priority fee exceeds its maximum fee")
  }
  return {
    activationManifestHash: bytes32(
      configuration.activationManifestHash,
      "Signer manifest hash"
    ),
    chainID: positiveSafeInteger(configuration.chainID, "Signer chain ID"),
    policyHash: bytes32(configuration.policyHash, "Signer fee-policy hash"),
    challengeValueWei: uint256(
      configuration.challengeValueWei,
      "Signer challenge value"
    ),
    laneID: trimmedText(configuration.laneID, "Signer lane ID", 128),
    signerIdentity: trimmedText(
      configuration.signerIdentity,
      "Signer identity",
      128
    ),
    sender: address(configuration.sender, "Signer sender"),
    maxGasLimit: positiveUint256(
      configuration.maxGasLimit,
      "Signer maximum gas limit"
    ),
    maxFeePerGas,
    maxPriorityFeePerGas,
    maxTotalFeeWei: positiveUint256(
      configuration.maxTotalFeeWei,
      "Signer maximum total fee"
    ),
    signerCodeHash: bytes32(configuration.signerCodeHash, "Signer code hash"),
  }
}

function uint256(value: unknown, label: string): string {
  const normalized = unsignedDecimal(value, label)
  if (BigInt(normalized) > (1n << 256n) - 1n) {
    throw new Error(`${label} exceeds uint256`)
  }
  return normalized
}

function positiveUint256(value: unknown, label: string): string {
  const normalized = uint256(value, label)
  if (normalized === "0") throw new Error(`${label} must be positive`)
  return normalized
}

function trimmedText(value: unknown, label: string, maximum: number): string {
  const normalized = requireText(value, label, maximum)
  if (normalized.trim() !== normalized) {
    throw new Error(`${label} must not contain surrounding whitespace`)
  }
  return normalized
}

function hashText(value: string): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`
}

function hashStructured(value: unknown): string {
  return `0x${createHash("sha256").update(canonicalJSON(value)).digest("hex")}`
}

function canonicalJSON(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Canonical JSON number is unsafe")
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(serializeJSON(value) as Record<string, unknown>)
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJSON(entry)}`)
      .join(",")}}`
  }
  throw new Error("Canonical JSON value is unsupported")
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
