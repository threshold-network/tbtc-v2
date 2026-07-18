import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"

import {
  Hex,
  validateP2TRSignatureFraudPreparedChallengeTransactionReservation,
  validateP2TRSignatureFraudPreparedEIP1559ChallengeTransaction,
} from "@keep-network/tbtc-v2.ts"

import {
  P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE,
  P2TRSignatureFraudCanonicalProvenanceBinding,
  P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence,
  P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  P2TRSignatureFraudChallengeOutboxPage,
  P2TRSignatureFraudChallengeOutboxPageRequest,
  P2TRSignatureFraudChallengeOutboxRecord,
  P2TRSignatureFraudChallengeOutboxStore,
  P2TRSignatureFraudLegacySubmissionQuarantine,
  P2TRSignatureFraudOutboxCriticalAlert,
  P2TRSignatureFraudPreparedTransactionVariant,
  P2TRSignatureFraudSignerQuarantine,
  P2TRSignatureFraudUnexpectedSignedArtifact,
  P2TRSignatureFraudVoidedNonceReservation,
  computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash,
  computeP2TRSignatureFraudDispositionHash,
  computeP2TRSignatureFraudResolutionEvidenceDigest,
} from "./P2TRSignatureFraudChallengeOutbox.js"
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
  >
  assertTransactionSession(session: P2TRPostgresOutboxTransactionSession): void
  /**
   * Must prove the runtime's exclusive readiness snapshot is held in this
   * transaction and compare every exact input-level field before returning.
   * The outbox never accepts a fingerprint-only assertion.
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
  active_signer_invocation_started_at_unix_ms: string | number | null
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

const STORED_ROW_COLUMNS = `
  record_state, status, version, updated_at_unix_ms,
  preparation_attempts, broadcast_attempts, reconciliation_attempts,
  preparation_lease_owner, preparation_lease_expires_at_unix_ms,
  preparation_resume_status, selected_signer_lane_id,
  selected_signer_identity, selected_sender, nonce_reservation_id,
  signer_invocation_started_at_unix_ms,
  active_signer_invocation_started_at_unix_ms,
  last_broadcast_at_unix_ms, last_reconciliation_at_unix_ms,
  last_pre_broadcast_recheck_at_unix_ms,
  last_pre_broadcast_recheck_status, last_resolution_status, last_error,
  provenance_invalidation_id`

/**
 * PostgreSQL implementation for the activation-grade outbox. It deliberately
 * owns neither a connection nor transaction: all methods require the runtime
 * coordinator's minted session, so observation/cursor writes and enqueue/CAS
 * effects share one commit or rollback decision.
 */
export class PostgresP2TRSignatureFraudChallengeOutboxStore implements P2TRSignatureFraudChallengeOutboxStore {
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  private readonly durableProvenanceInvalidationIDs = new Map<string, string>()
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

  async installSignerLaneConfiguration(
    configuration: P2TRProductionSignerLaneConfiguration
  ): Promise<void> {
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
    this.assertSession()
    const existing = await this.getByRecordOrSeriesGeneration(
      record.recordID,
      record.seriesID,
      record.generation
    )
    if (existing !== undefined) return existing

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
    const conflicted = await this.getByRecordOrSeriesGeneration(
      record.recordID,
      record.seriesID,
      record.generation
    )
    if (conflicted === undefined) {
      throw new Error(
        "PostgreSQL outbox insertion conflicted with another identity"
      )
    }
    return conflicted
  }

  async get(
    recordID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
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

  async hasExpiredPreparationLeases(nowUnixMs: number): Promise<boolean> {
    this.assertSession()
    const result = await this.options.session.query<{ exists: boolean }>(
      `SELECT EXISTS (
          SELECT 1
            FROM p2tr_signature_fraud_challenge_outbox
           WHERE status = 'preparing'
             AND preparation_lease_expires_at_unix_ms <= $1
       ) AS exists`,
      [unixMilliseconds(nowUnixMs, "Preparation recovery time")]
    )
    return result.rows[0]?.exists === true
  }

  async compareAndSwap(
    recordID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    this.assertSession()
    return this.compareAndSwapLocked(recordID, expectedVersion, next)
  }

  async compareAndSwapWithCurrentCanonicalProvenance(
    recordID: string,
    expectedVersion: number,
    expectedProvenance: P2TRSignatureFraudCanonicalProvenanceBinding,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
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
    artifact: P2TRSignatureFraudUnexpectedSignedArtifact
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
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
    if (
      hasSignedTransactionHash(
        current,
        artifact.preparedTransaction.transactionHash.toPrefixedString()
      )
    ) {
      return current
    }
    if (current.provenanceInvalidationEvidence === undefined) {
      throw new Error(
        "Escaped signed artifact has no durable provenance invalidation context"
      )
    }
    await this.insertUnexpectedArtifact(current, artifact)
    await this.insertProvenanceIncident(
      current,
      current.provenanceInvalidationEvidence.evidenceHash,
      "signed-envelope-escaped",
      artifact.reason,
      artifact.capturedAtUnixMs
    )
    const artifacts = current.unexpectedSignedArtifacts ?? []
    const next: P2TRSignatureFraudChallengeOutboxRecord = {
      ...current,
      version: current.version + 1,
      updatedAtUnixMs: Math.max(
        current.updatedAtUnixMs,
        artifact.capturedAtUnixMs
      ),
      unexpectedSignedArtifacts: [...artifacts, artifact],
    }
    const updated = await this.updateMutableState(current, next)
    if (!updated) throw new Error("Escaped artifact CAS unexpectedly failed")
    await this.saveCriticalAlert({
      code: "provenance-reconciliation-incident",
      seriesID: current.seriesID,
      recordID: current.recordID,
      generation: current.generation,
      activationBlocking: true,
      createdAtUnixMs: artifact.capturedAtUnixMs,
      detail: artifact.reason,
    })
    return (await this.get(recordID))!
  }

  async invalidateCanonicalProvenance(
    evidence: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence
  ): Promise<readonly P2TRSignatureFraudChallengeOutboxRecord[]> {
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
      const reservationIntentInFlight =
        current.status === "preparing" &&
        current.selectedLaneID !== undefined &&
        current.selectedSignerIdentity !== undefined &&
        current.preparationSender !== undefined &&
        current.reservedNonce === undefined &&
        current.signerInvocationStartedAtUnixMs === undefined &&
        current.activeSignerInvocationStartedAtUnixMs === undefined
      const escaped =
        reservationIntentInFlight ||
        current.reservedNonce !== undefined ||
        current.signerInvocationStartedAtUnixMs !== undefined ||
        current.activeSignerInvocationStartedAtUnixMs !== undefined ||
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
      if (escaped || terminal) {
        await this.insertProvenanceIncident(
          current,
          evidence.evidenceHash,
          provenanceIncidentKind(current, reservationIntentInFlight, terminal),
          evidence.reason,
          evidence.invalidatedAtUnixMs
        )
      }
      const next: P2TRSignatureFraudChallengeOutboxRecord = {
        ...current,
        status: reservationIntentInFlight
          ? "preparing"
          : terminal
            ? current.status
            : escaped
              ? "provenance-invalidated-awaiting-reconciliation"
              : "cancelled-provenance-invalidated",
        version: current.version + 1,
        provenanceInvalidationEvidence: evidence,
        preparationLease: reservationIntentInFlight
          ? current.preparationLease
          : undefined,
        activeSignerInvocationStartedAtUnixMs: undefined,
        updatedAtUnixMs: Math.max(
          current.updatedAtUnixMs,
          evidence.invalidatedAtUnixMs
        ),
        lastError: evidence.reason,
      }
      if (!(await this.updateMutableState(current, next))) {
        throw new Error("Canonical provenance invalidation CAS failed")
      }
      if (escaped || terminal) {
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

  private async compareAndSwapLocked(
    recordID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord,
    expectedProvenance?: P2TRSignatureFraudCanonicalProvenanceBinding
  ): Promise<boolean> {
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
    await this.syncChildLedgers(current, next)
    return this.updateMutableState(current, next)
  }

  private async updateMutableState(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    const columns = outboxMutableColumns(
      next,
      this.durableProvenanceInvalidationIDs.get(next.recordID.toLowerCase())
    )
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
      "activeSignerInvocationStartedAtUnixMs",
      optionalDatabaseInteger(row.active_signer_invocation_started_at_unix_ms)
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
      this.durableProvenanceInvalidationIDs.set(
        state.recordID.toLowerCase(),
        prefixedHex(row.provenance_invalidation_id)
      )
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
  }

  private async insertNonceGuard(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    const reservation = record.reservedNonce!
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_guard (
          nonce_guard_id, record_id, guard_kind, chain_id, signer_lane_id,
          signer_identity, sender, transaction_nonce, reservation_binding,
          guarded_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), 'bound-reservation', $3,
          $4, $5, decode($6, 'hex'), $7, decode($8, 'hex'), $9
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
          candidate.reasonCode === "wrong-nonce"
      )
    if (quarantine === undefined) {
      throw new Error(
        "Escaped wrong-lane envelope lacks signer quarantine evidence"
      )
    }
    const actualGuardID = hashStructured({
      domain: "tbtc-p2tr-signature-fraud-escaped-nonce-guard-v1",
      recordID: record.recordID,
      transactionHash: hexValue(
        transaction.transactionHash,
        "Escaped transaction hash"
      ),
      sender: address(transaction.sender, "Escaped sender"),
      nonce: transaction.nonce,
    })
    await this.options.session.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_guard (
          nonce_guard_id, record_id, guard_kind, chain_id, signer_lane_id,
          signer_identity, sender, transaction_nonce, parent_reservation_id,
          guarded_at_unix_ms
       ) VALUES (
          decode($1, 'hex'), decode($2, 'hex'), 'escaped-envelope', $3,
          $4, $5, decode($6, 'hex'), $7, decode($8, 'hex'), $9
       )`,
      [
        stripHex(actualGuardID),
        stripHex(bytes32(record.recordID, "Escaped guard record ID")),
        record.intent.chainID,
        reservation.laneID,
        reservation.signerIdentity,
        stripHex(address(transaction.sender, "Escaped sender")),
        transaction.nonce,
        stripHex(hexValue(reservation.reservationID, "Parent reservation ID")),
        artifact.capturedAtUnixMs,
      ]
    )
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
        stripHex(bytes32(record.recordID, "Actual guard record ID")),
        stripHex(actualGuardID),
        record.intent.chainID,
        reservation.laneID,
        reservation.signerIdentity,
        stripHex(address(reservation.sender, "Expected sender")),
        reservation.nonce,
        stripHex(address(transaction.sender, "Actual sender")),
        transaction.nonce,
        reservation.laneID,
        reservation.signerIdentity,
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
    this.durableProvenanceInvalidationIDs.set(
      record.recordID.toLowerCase(),
      bytes32(evidence.evidenceHash, "Provenance invalidation ID")
    )
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
    canonical_provenance_event_ids: JSON.stringify(
      record.canonicalProvenance.eventIDs
    ),
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
  record: P2TRSignatureFraudChallengeOutboxRecord,
  durableProvenanceInvalidationID?: string
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
    active_signer_invocation_started_at_unix_ms:
      record.activeSignerInvocationStartedAtUnixMs ?? null,
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
      durableProvenanceInvalidationID ??
        record.provenanceInvalidationEvidence?.evidenceHash
    ),
    signer_quarantine_id: optionalDatabaseBytes(
      latestQuarantine === undefined
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
  for (const key of [
    "intentID",
    "observationID",
    "bridgeChallengeKey",
    "walletID",
    "bridgeChallengeIdentity",
    "sighash",
  ] as const) {
    intent[key] = Hex.from(hexValue(intent[key], `Stored intent ${key}`))
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
