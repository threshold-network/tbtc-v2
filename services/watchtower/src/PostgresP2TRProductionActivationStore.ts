import { createHash } from "node:crypto"
import {
  type P2TRActivationMigrationBinding,
  type P2TRProductionActivationEnvelope,
  type P2TRProductionBitcoinCandidate,
  type P2TRProductionCandidateAuthorizationReceipt,
  type P2TRProductionCandidateEnqueueRetryExhaustionAlert,
  type P2TRProductionCandidateEnqueueTransactionGuard,
  type P2TRProductionCandidateEnqueueTransactionResolution,
  type P2TRProductionEthereumJournalHealth,
  type P2TRProductionBitcoinIndexHealth,
  type P2TRProductionMigrationReadback,
  type P2TRProductionOutboxRevalidation,
  type P2TRProductionReadinessCertificateInput,
  type P2TRProductionReadinessCertificateReference,
  type P2TRProductionRuntimeAlertHealth,
  type P2TRProductionStateStore,
} from "./P2TRProductionActivation.js"
import {
  assertP2TRPostgresTransactionSession,
  type P2TRPostgresTransactionSession,
} from "./PostgresP2TRCanonicalIndexStore.js"

export type PostgresP2TRProductionActivationStoreOptions = {
  storeID: string
  maxEventHistoryRecords: number
  maxManifestBytes?: number
  maxCandidateAuthorizationLifetimeMs?: number
}

export type P2TRProductionComponent =
  | "bitcoin-index"
  | "ethereum-journal"
  | "ethereum-projector"

type ComponentHealthRow = {
  component: P2TRProductionComponent
  configuration_fingerprint: string
  position_number: string | number
  position_hash: string
  failure_generation: string | number
  cleared_failure_generation: string | number
}

type ReadinessCertificateStateRow = {
  activation_sequence: string | number
  outbox_max_recovery_backlog: string | number
  primary_bitcoin_generation: string | number
  primary_bitcoin_root: string
  primary_bitcoin_semantic_root: string
  local_bitcoin_height: string | number
  local_bitcoin_hash: string
  ethereum_journal_generation: string | number
  ethereum_history_root: string
  local_ethereum_block: string | number
  local_ethereum_hash: string
}

const DEFAULT_MAX_MANIFEST_BYTES = 1_048_576
const DEFAULT_MAX_AUTHORIZATION_LIFETIME_MS = 60_000

/** Reads the revalidation function's row into the gate's comparison shape. */
export function normalizeOutboxRevalidation(
  row: Record<string, string | number>
): P2TRProductionOutboxRevalidation {
  return {
    activationBlockingCriticalAlertCount: databaseInteger(
      row.activation_blocking_critical_alert_count,
      "revalidated activation-blocking alert count"
    ),
    ambiguousTransactionCount: databaseInteger(
      row.ambiguous_transaction_count,
      "revalidated ambiguous transaction count"
    ),
    unresolvedLegacyQuarantineCount: databaseInteger(
      row.unresolved_legacy_quarantine_count,
      "revalidated legacy quarantine count"
    ),
    recoveryBacklogCount: databaseInteger(
      row.recovery_backlog_count,
      "revalidated recovery backlog count"
    ),
    configuredSignerLaneCount: databaseInteger(
      row.configured_signer_lane_count,
      "revalidated configured signer lane count"
    ),
    configuredSignerLaneSetHash: bytes32(
      String(row.configured_signer_lane_set_hash),
      "revalidated configured signer lane set hash"
    ),
    quarantinedSignerLaneCount: databaseInteger(
      row.quarantined_signer_lane_count,
      "revalidated quarantined signer lane count"
    ),
    activeOldManifestGenerationCount: databaseInteger(
      row.active_old_manifest_generation_count,
      "revalidated old-manifest generation count"
    ),
    staleManifestGenerationSuccessorCount: databaseInteger(
      row.stale_manifest_generation_successor_count,
      "revalidated stale-manifest generation successor count"
    ),
    activeSignerInvocationCount: databaseInteger(
      row.active_signer_invocation_count,
      "revalidated active signer invocation count"
    ),
    activeNonceReleaseAttemptCount: databaseInteger(
      row.active_nonce_release_attempt_count,
      "revalidated active nonce release attempt count"
    ),
  }
}

/**
 * Activation readback and one-use authorization journal bound to the exact
 * coordinator-owned PostgreSQL session. It cannot silently fall back to an
 * autocommit client.
 */
export class PostgresP2TRProductionActivationStore
  implements P2TRProductionStateStore, P2TRProductionMigrationReadback
{
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  private readonly maxManifestBytes: number
  private readonly maxCandidateAuthorizationLifetimeMs: number

  constructor(
    private readonly session: P2TRPostgresTransactionSession,
    options: PostgresP2TRProductionActivationStoreOptions
  ) {
    assertP2TRPostgresTransactionSession(session)
    this.p2trSignatureFraudWatchtowerTransactionalStoreID = boundedString(
      options.storeID,
      255,
      "activation store ID"
    )
    positiveInteger(
      options.maxEventHistoryRecords,
      "activation event history bound"
    )
    this.maxManifestBytes = positiveInteger(
      options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES,
      "activation manifest byte bound"
    )
    this.maxCandidateAuthorizationLifetimeMs = positiveInteger(
      options.maxCandidateAuthorizationLifetimeMs ??
        DEFAULT_MAX_AUTHORIZATION_LIFETIME_MS,
      "candidate authorization lifetime bound"
    )
  }

  async listAppliedMigrations(): Promise<
    readonly P2TRActivationMigrationBinding[]
  > {
    const result = await this.session.query<{
      version: string | number
      name: string
      checksum: string
    }>(
      `SELECT version, name, encode(checksum, 'hex') AS checksum
         FROM p2tr_watchtower_migrations
        ORDER BY version
        LIMIT 1025`
    )
    if (result.rows.length > 1024) {
      throw new Error("Applied migration history exceeds its production bound")
    }
    return result.rows.map((row, index) => {
      const version = databaseInteger(row.version, "migration version")
      if (version !== index + 1) {
        throw new Error("Applied migration history is not consecutive")
      }
      return {
        version,
        name: boundedString(row.name, 128, "migration name"),
        checksum: bytes32(row.checksum, "migration checksum"),
      }
    })
  }

  async lockReadinessSnapshot(): Promise<void> {
    await this.session.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('p2tr-readiness-snapshot', 0))"
    )
  }

  /**
   * Re-derives the outbox facts the signed handshake attested to. The
   * handshake is sampled in the outbox's own already-committed transaction, so
   * on its own it says nothing about the moment readiness is minted. The
   * coordinator's pre-snapshot exclusive fence stabilizes outbox writers while
   * these facts are read and the certificate is inserted. Preparation leases
   * expire on the clock rather than on a write, so the backlog is returned for
   * a bound check, not for equality.
   */
  async readOutboxRevalidation(
    manifestHash: string,
    sampledAtUnixMs: number
  ): Promise<P2TRProductionOutboxRevalidation> {
    const result = await this.session.query<Record<string, string | number>>(
      `SELECT *
         FROM p2tr_signature_fraud_outbox_activation_revalidation($1, $2)`,
      [
        hexBuffer(manifestHash, "outbox revalidation manifest"),
        nonNegativeInteger(sampledAtUnixMs, "outbox revalidation sample time"),
      ]
    )
    if (result.rows.length !== 1) {
      throw new Error("Outbox activation revalidation is unavailable")
    }
    return normalizeOutboxRevalidation(result.rows[0])
  }

  async mintReadinessCertificate(
    input: P2TRProductionReadinessCertificateInput
  ): Promise<P2TRProductionReadinessCertificateReference> {
    // Candidate issuance takes the same transaction-scoped lock. This makes
    // certificate replacement and authorization issuance one cross-process
    // serialization domain rather than relying on an in-memory gate mutex.
    await this.lockReadinessSnapshot()
    const normalized = normalizeReadinessCertificateInput(input)
    const payload = canonicalJSON(normalized.payload)
    if (Buffer.byteLength(payload, "utf8") > this.maxManifestBytes) {
      throw new Error("Readiness certificate payload exceeds its byte bound")
    }
    const state = await this.session.query<ReadinessCertificateStateRow>(
      `SELECT manifest.activation_sequence,
              manifest.payload #>> '{outbox,maxRecoveryBacklog}'
                AS outbox_max_recovery_backlog,
              generation.generation_id AS primary_bitcoin_generation,
              encode(generation.bitcoin_chain_root, 'hex')
                AS primary_bitcoin_root,
              encode(generation.semantic_root, 'hex')
                AS primary_bitcoin_semantic_root,
              bitcoin.current_height AS local_bitcoin_height,
              encode(bitcoin.current_hash, 'hex') AS local_bitcoin_hash,
              ethereum.generation AS ethereum_journal_generation,
              encode(ethereum_block.history_root, 'hex')
                AS ethereum_history_root,
              ethereum.current_block_number AS local_ethereum_block,
              encode(ethereum.current_block_hash, 'hex')
                AS local_ethereum_hash
         FROM p2tr_watchtower_activation_manifest manifest
         JOIN p2tr_bitcoin_cursor bitcoin ON bitcoin.singleton = true
         JOIN p2tr_ethereum_cursor ethereum ON ethereum.singleton = true
         JOIN p2tr_ethereum_blocks ethereum_block
           ON ethereum_block.block_number = ethereum.current_block_number
          AND ethereum_block.block_hash = ethereum.current_block_hash
         JOIN p2tr_canonical_generations generation
           ON generation.state = 'committed'
          AND generation.bitcoin_height = bitcoin.current_height
          AND generation.bitcoin_hash = bitcoin.current_hash
          AND generation.ethereum_block_number = ethereum.current_block_number
          AND generation.ethereum_block_hash = ethereum.current_block_hash
        WHERE manifest.singleton = true
          AND manifest.manifest_hash = $1
        ORDER BY generation.generation_id DESC
        LIMIT 1
        FOR SHARE OF manifest, bitcoin, ethereum, ethereum_block, generation`,
      [hexBuffer(normalized.manifestHash, "readiness manifest")]
    )
    if (state.rows.length !== 1) {
      throw new Error(
        "Readiness certificate requires the exact committed local snapshot"
      )
    }
    const snapshot = normalizeReadinessCertificateState(state.rows[0])
    if (
      snapshot.localBitcoin.height !== normalized.bitcoinIndex.current.height ||
      snapshot.localBitcoin.hash !== normalized.bitcoinIndex.current.hash ||
      snapshot.localEthereum.blockNumber !==
        normalized.ethereumJournal.current.blockNumber ||
      snapshot.localEthereum.blockHash !==
        normalized.ethereumJournal.current.blockHash
    ) {
      throw new Error(
        "Readiness certificate local snapshot changed during verification"
      )
    }
    const liveAuthorizations = await this.session.query<{
      live_authorization_count: string | number
    }>(
      `SELECT count(*)::bigint AS live_authorization_count
         FROM p2tr_candidate_enqueue_authorizations authorization
         JOIN p2tr_readiness_certificates certificate
           ON certificate.certificate_id =
                authorization.readiness_certificate_id
          AND certificate.certificate_generation =
                authorization.readiness_certificate_generation
          AND certificate.is_current
          AND certificate.invalidated_at IS NULL
        WHERE authorization.consumed_at IS NULL
          AND authorization.invalidated_at IS NULL
          AND authorization.expires_at > clock_timestamp()`
    )
    if (
      liveAuthorizations.rows.length !== 1 ||
      databaseInteger(
        liveAuthorizations.rows[0].live_authorization_count,
        "live candidate authorization count"
      ) !== 0
    ) {
      throw new Error(
        "Readiness certificate replacement is blocked by a live candidate authorization"
      )
    }
    const generation = await this.session.query<{
      certificate_generation: string | number
    }>(
      `UPDATE p2tr_readiness_certificate_generation
          SET next_generation = next_generation + 1
        WHERE singleton = true
      RETURNING next_generation - 1 AS certificate_generation`
    )
    if (generation.rows.length !== 1) {
      throw new Error("Readiness certificate generation allocation failed")
    }
    const certificateGeneration = positiveInteger(
      databaseInteger(
        generation.rows[0].certificate_generation,
        "readiness certificate generation"
      ),
      "readiness certificate generation"
    )
    const providerReadSetHash = `0x${createHash("sha256")
      .update("tbtc-p2tr-production-readiness-read-set/v1\u0000", "utf8")
      .update(payload, "utf8")
      .digest("hex")}`
    const certificateID = `0x${createHash("sha256")
      .update("tbtc-p2tr-production-readiness-certificate/v1\u0000", "utf8")
      .update(String(certificateGeneration), "utf8")
      .update("\u0000", "utf8")
      .update(hexBuffer(normalized.manifestHash, "readiness manifest"))
      .update(hexBuffer(providerReadSetHash, "readiness provider read set"))
      .digest("hex")}`
    await this.session.query(
      `UPDATE p2tr_readiness_certificates
          SET is_current = false,
              invalidated_at = clock_timestamp()
        WHERE is_current`
    )
    const inserted = await this.session.query(
      `INSERT INTO p2tr_readiness_certificates
         (certificate_id, certificate_generation, manifest_hash,
          manifest_activation_sequence, primary_bitcoin_generation,
          primary_bitcoin_root, primary_bitcoin_semantic_root,
          bitcoin_height, bitcoin_hash, ethereum_journal_generation,
          ethereum_history_root, ethereum_block_number, ethereum_block_hash,
          provider_read_set_hash, payload)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
              $13, $14, $15::jsonb
         FROM p2tr_signature_fraud_outbox_activation_revalidation(
                $3,
                floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              ) revalidation
        WHERE revalidation.recovery_backlog_count <= $16`,
      [
        hexBuffer(certificateID, "readiness certificate"),
        certificateGeneration,
        hexBuffer(normalized.manifestHash, "readiness manifest"),
        snapshot.activationSequence,
        snapshot.primaryBitcoinGeneration,
        hexBuffer(snapshot.primaryBitcoinRoot, "primary Bitcoin root"),
        hexBuffer(
          snapshot.primaryBitcoinSemanticRoot,
          "primary Bitcoin semantic root"
        ),
        normalized.verifiedBitcoin.height,
        hexBuffer(normalized.verifiedBitcoin.hash, "verified Bitcoin hash"),
        snapshot.ethereumJournalGeneration,
        hexBuffer(snapshot.ethereumHistoryRoot, "Ethereum history root"),
        normalized.verifiedEthereum.blockNumber,
        hexBuffer(
          normalized.verifiedEthereum.blockHash,
          "verified Ethereum hash"
        ),
        hexBuffer(providerReadSetHash, "readiness provider read set"),
        payload,
        snapshot.outboxMaxRecoveryBacklog,
      ]
    )
    if (inserted.rowCount !== 1) {
      throw new Error(
        "Readiness certificate insertion failed because the outbox recovery backlog exceeded its manifest bound"
      )
    }
    return { certificateID, generation: certificateGeneration }
  }

  async readBitcoinIndexHealth(): Promise<P2TRProductionBitcoinIndexHealth> {
    const cursor = await this.session.query<{
      store_id: string
      configuration_fingerprint: string
      network: string
      checkpoint_height: string | number
      checkpoint_hash: string
      current_height: string | number
      current_hash: string
    }>(
      `SELECT store_id,
              encode(configuration_fingerprint, 'hex') AS configuration_fingerprint,
              network, checkpoint_height,
              encode(checkpoint_hash, 'hex') AS checkpoint_hash,
              current_height, encode(current_hash, 'hex') AS current_hash
         FROM p2tr_bitcoin_cursor
        WHERE singleton = true
        FOR SHARE`
    )
    if (cursor.rows.length !== 1) {
      throw new Error("Canonical Bitcoin cursor is absent or non-singleton")
    }
    const row = cursor.rows[0]
    const checkpointHeight = databaseInteger(
      row.checkpoint_height,
      "Bitcoin checkpoint height"
    )
    const currentHeight = databaseInteger(
      row.current_height,
      "Bitcoin cursor height"
    )
    const counts = await this.session.query<{
      canonical_block_count: string | number
      minimum_height: string | number | null
      maximum_height: string | number | null
      pending_candidates: string | number
      pending_deposit_reveals: string | number
      unmatched_proofs: string | number
      live_candidate_authorizations: string | number
      unbackfilled_frost_wallet_bindings: string | number
    }>(
      `SELECT
         (SELECT count(*) FROM p2tr_bitcoin_blocks
           WHERE height BETWEEN $1 AND $2) AS canonical_block_count,
         (SELECT min(height) FROM p2tr_bitcoin_blocks
           WHERE height BETWEEN $1 AND $2) AS minimum_height,
         (SELECT max(height) FROM p2tr_bitcoin_blocks
           WHERE height BETWEEN $1 AND $2) AS maximum_height,
         (SELECT count(*) FROM p2tr_bitcoin_candidate_observations
           WHERE disposition IN (
             'keypath_pending', 'malformed_blocking', 'ambiguous_blocking'
           )) AS pending_candidates,
         (SELECT count(*) FROM p2tr_pending_deposit_reveals
           WHERE resolved_at IS NULL) AS pending_deposit_reveals,
         (SELECT count(*) FROM p2tr_unmatched_proofs
           WHERE resolved_at IS NULL) AS unmatched_proofs,
         (SELECT count(*) FROM p2tr_candidate_enqueue_authorizations
           WHERE consumed_at IS NULL
             AND invalidated_at IS NULL
             AND expires_at > clock_timestamp()) AS live_candidate_authorizations,
         (SELECT count(*) FROM p2tr_frost_wallet_bindings
           WHERE wallet_pub_key_hash IS NULL) AS unbackfilled_frost_wallet_bindings`,
      [checkpointHeight, currentHeight]
    )
    if (counts.rows.length !== 1) {
      throw new Error("Canonical Bitcoin health aggregation failed")
    }
    const count = counts.rows[0]
    const canonicalBlockCount = databaseInteger(
      count.canonical_block_count,
      "canonical Bitcoin block count"
    )
    if (
      count.minimum_height === null ||
      count.maximum_height === null ||
      databaseInteger(count.minimum_height, "minimum Bitcoin height") !==
        checkpointHeight ||
      databaseInteger(count.maximum_height, "maximum Bitcoin height") !==
        currentHeight ||
      canonicalBlockCount !== currentHeight - checkpointHeight + 1
    ) {
      throw new Error("Canonical Bitcoin history has a gap")
    }
    const fingerprint = bytes32(
      row.configuration_fingerprint,
      "Bitcoin configuration fingerprint"
    )
    const currentHash = bytes32(row.current_hash, "Bitcoin cursor hash")
    const component = await this.readComponentHealth("bitcoin-index")
    assertComponentPosition(component, fingerprint, currentHeight, currentHash)
    return {
      storeID: boundedString(row.store_id, 255, "Bitcoin cursor store ID"),
      configurationFingerprint: fingerprint,
      network: boundedString(row.network, 32, "Bitcoin network"),
      checkpoint: {
        height: checkpointHeight,
        hash: bytes32(row.checkpoint_hash, "Bitcoin checkpoint hash"),
      },
      current: { height: currentHeight, hash: currentHash },
      canonicalBlockCount,
      pendingCandidates: databaseInteger(
        count.pending_candidates,
        "pending Bitcoin candidate count"
      ),
      pendingDepositReveals: databaseInteger(
        count.pending_deposit_reveals,
        "pending deposit reveal count"
      ),
      unmatchedProofs: databaseInteger(
        count.unmatched_proofs,
        "unmatched proof count"
      ),
      liveCandidateAuthorizations: databaseInteger(
        count.live_candidate_authorizations,
        "live candidate authorization count"
      ),
      unbackfilledFrostWalletBindings: databaseInteger(
        count.unbackfilled_frost_wallet_bindings,
        "unbackfilled FROST wallet binding count"
      ),
      failureGeneration: databaseInteger(
        component.failure_generation,
        "Bitcoin failure generation"
      ),
      clearedFailureGeneration: databaseInteger(
        component.cleared_failure_generation,
        "Bitcoin cleared failure generation"
      ),
    }
  }

  async readRuntimeAlertHealth(): Promise<P2TRProductionRuntimeAlertHealth> {
    const result = await this.session.query<{
      manifest_hash: string
      unresolved_candidate_enqueue_transaction_guard_count: string | number
      candidate_enqueue_retry_exhaustion_count: string | number
    }>(
      `SELECT encode(manifest.manifest_hash, 'hex') AS manifest_hash,
              (SELECT count(*)
                 FROM p2tr_candidate_enqueue_transaction_guard guard_row
                WHERE guard_row.manifest_hash = manifest.manifest_hash
                  AND NOT EXISTS (
                    SELECT 1
                      FROM p2tr_candidate_enqueue_transaction_resolution resolution
                     WHERE resolution.manifest_hash = guard_row.manifest_hash
                       AND resolution.token_id = guard_row.token_id
                  )) AS unresolved_candidate_enqueue_transaction_guard_count,
              (SELECT count(*)
                 FROM p2tr_candidate_enqueue_retry_exhaustion_alert alert
                WHERE alert.manifest_hash = manifest.manifest_hash
                  AND alert.activation_blocking = true)
                AS candidate_enqueue_retry_exhaustion_count
         FROM p2tr_watchtower_activation_manifest manifest
        WHERE manifest.singleton = true
        FOR SHARE OF manifest`
    )
    if (result.rows.length !== 1) {
      throw new Error(
        "Production runtime alert health is absent or non-singleton"
      )
    }
    return {
      manifestHash: bytes32(
        result.rows[0].manifest_hash,
        "runtime alert manifest"
      ),
      unresolvedCandidateEnqueueTransactionGuardCount: databaseInteger(
        result.rows[0].unresolved_candidate_enqueue_transaction_guard_count,
        "unresolved candidate enqueue transaction guard count"
      ),
      candidateEnqueueRetryExhaustionCount: databaseInteger(
        result.rows[0].candidate_enqueue_retry_exhaustion_count,
        "candidate enqueue retry-exhaustion alert count"
      ),
    }
  }

  async readEthereumJournalHealth(): Promise<P2TRProductionEthereumJournalHealth> {
    const cursor = await this.session.query<{
      store_id: string
      chain_id: string | number
      configuration_fingerprint: string
      descriptor_set_hash: string
      scan_start_block: string | number
      checkpoint_block_number: string | number
      checkpoint_block_hash: string
      current_block_number: string | number
      current_block_hash: string
      history_root: string
      required_event_count: string | number
      coverage_block_count: string | number
      coverage_transaction_count: string | number
      coverage_receipt_count: string | number
      coverage_log_count: string | number
    }>(
      `SELECT store_id, chain_id,
              encode(configuration_fingerprint, 'hex') AS configuration_fingerprint,
              encode(descriptor_set_hash, 'hex') AS descriptor_set_hash,
              scan_start_block, checkpoint_block_number,
              encode(checkpoint_block_hash, 'hex') AS checkpoint_block_hash,
              cursor.current_block_number,
              encode(cursor.current_block_hash, 'hex') AS current_block_hash,
              encode(block.history_root, 'hex') AS history_root,
              block.required_event_count,
              cursor.coverage_block_count,
              cursor.coverage_transaction_count,
              cursor.coverage_receipt_count,
              cursor.coverage_log_count
         FROM p2tr_ethereum_cursor cursor
         JOIN p2tr_ethereum_blocks block
           ON block.block_number = cursor.current_block_number
          AND block.block_hash = cursor.current_block_hash
        WHERE singleton = true
        FOR SHARE`
    )
    if (cursor.rows.length !== 1) {
      throw new Error("Canonical Ethereum cursor is absent or non-singleton")
    }
    const row = cursor.rows[0]
    const scanStartBlock = databaseInteger(
      row.scan_start_block,
      "Ethereum scan start"
    )
    const currentBlock = databaseInteger(
      row.current_block_number,
      "Ethereum cursor block"
    )
    const checkpointBlock = databaseInteger(
      row.checkpoint_block_number,
      "Ethereum checkpoint block"
    )
    const blocks = await this.session.query<{
      canonical_block_count: string | number
      minimum_block: string | number | null
      maximum_block: string | number | null
    }>(
      `SELECT count(*) AS canonical_block_count,
              min(block_number) AS minimum_block,
              max(block_number) AS maximum_block
         FROM p2tr_ethereum_blocks
        WHERE block_number BETWEEN $1 AND $2`,
      [checkpointBlock, currentBlock]
    )
    if (
      blocks.rows.length !== 1 ||
      blocks.rows[0].minimum_block === null ||
      blocks.rows[0].maximum_block === null ||
      databaseInteger(
        blocks.rows[0].canonical_block_count,
        "canonical Ethereum block count"
      ) !==
        currentBlock - checkpointBlock + 1 ||
      databaseInteger(
        blocks.rows[0].minimum_block,
        "minimum Ethereum block"
      ) !== checkpointBlock ||
      databaseInteger(
        blocks.rows[0].maximum_block,
        "maximum Ethereum block"
      ) !== currentBlock
    ) {
      throw new Error("Canonical Ethereum history has a gap")
    }
    const fingerprint = bytes32(
      row.configuration_fingerprint,
      "Ethereum configuration fingerprint"
    )
    const currentHash = bytes32(row.current_block_hash, "Ethereum cursor hash")
    const [journal, projector] = await Promise.all([
      this.readComponentHealth("ethereum-journal"),
      this.readComponentHealth("ethereum-projector"),
    ])
    assertComponentPosition(journal, fingerprint, currentBlock, currentHash)
    assertComponentPosition(projector, fingerprint, currentBlock, currentHash)
    return {
      storeID: boundedString(row.store_id, 255, "Ethereum cursor store ID"),
      chainID: databaseInteger(row.chain_id, "Ethereum chain ID"),
      configurationFingerprint: fingerprint,
      descriptorSetHash: bytes32(
        row.descriptor_set_hash,
        "Ethereum descriptor set hash"
      ),
      checkpoint: {
        blockNumber: checkpointBlock,
        blockHash: bytes32(
          row.checkpoint_block_hash,
          "Ethereum checkpoint hash"
        ),
      },
      scanStartBlock,
      current: { blockNumber: currentBlock, blockHash: currentHash },
      requiredEventHistoryDigest: bytes32(
        row.history_root,
        "Ethereum journal history root"
      ),
      requiredEventCount: databaseInteger(
        row.required_event_count,
        "Ethereum journal event count"
      ),
      requiredEventCoverage: {
        blocks: databaseInteger(
          row.coverage_block_count,
          "Ethereum journal coverage block count"
        ),
        transactions: databaseInteger(
          row.coverage_transaction_count,
          "Ethereum journal coverage transaction count"
        ),
        receipts: databaseInteger(
          row.coverage_receipt_count,
          "Ethereum journal coverage receipt count"
        ),
        logs: databaseInteger(
          row.coverage_log_count,
          "Ethereum journal coverage log count"
        ),
        requiredEvents: databaseInteger(
          row.required_event_count,
          "Ethereum journal required-event coverage count"
        ),
      },
      failureGeneration:
        databaseInteger(
          journal.failure_generation,
          "journal failure generation"
        ) +
        databaseInteger(
          projector.failure_generation,
          "projector failure generation"
        ),
      clearedFailureGeneration:
        databaseInteger(
          journal.cleared_failure_generation,
          "journal cleared generation"
        ) +
        databaseInteger(
          projector.cleared_failure_generation,
          "projector cleared generation"
        ),
    }
  }

  async assertCandidateIndexed(
    candidate: P2TRProductionBitcoinCandidate
  ): Promise<void> {
    const normalized = normalizeCandidate(candidate)
    const result = await this.session.query<{ found: boolean }>(
      `SELECT true AS found
         FROM p2tr_bitcoin_candidates candidate
         JOIN p2tr_bitcoin_candidate_observations observation
           ON observation.block_hash = candidate.block_hash
          AND observation.txid = candidate.txid
          AND observation.wtxid = candidate.wtxid
          AND observation.provenance_generation =
              candidate.provenance_generation
         JOIN p2tr_bitcoin_cursor cursor ON cursor.singleton = true
         JOIN p2tr_bitcoin_blocks block
           ON block.height = candidate.block_height
          AND block.hash = candidate.block_hash
        WHERE candidate.txid = $1
          AND candidate.wtxid = $2
          AND candidate.block_height = $3
          AND candidate.block_hash = $4
          AND candidate.block_height <= cursor.current_height
          AND observation.input_index = $5
          AND observation.occurrence_id = $6
          AND observation.challenge_identity = $7
          AND observation.disposition = 'keypath_delivered'
        FOR SHARE OF candidate, observation, block`,
      [
        hexBuffer(normalized.txid, "candidate txid"),
        hexBuffer(normalized.wtxid, "candidate wtxid"),
        normalized.blockHeight,
        hexBuffer(normalized.blockHash, "candidate block hash"),
        normalized.inputIndex,
        hexBuffer(normalized.observationID, "candidate observation ID"),
        hexBuffer(normalized.challengeKey, "candidate challenge key"),
      ]
    )
    if (result.rows.length !== 1 || result.rows[0].found !== true) {
      throw new Error("Reconciled candidate is absent from the canonical index")
    }
  }

  async issueCandidateAuthorization(
    receipt: P2TRProductionCandidateAuthorizationReceipt
  ): Promise<void> {
    await this.lockReadinessSnapshot()
    const normalized = normalizeReceipt(receipt)
    await this.assertCurrentActivationManifest(normalized.manifestHash)
    await this.session.query(
      `UPDATE p2tr_candidate_enqueue_authorizations
          SET invalidated_at = clock_timestamp()
        WHERE candidate_digest = $1
          AND consumed_at IS NULL
          AND invalidated_at IS NULL
          AND expires_at <= clock_timestamp()`,
      [hexBuffer(normalized.candidateDigest, "candidate digest")]
    )
    const result = await this.session.query(
      `WITH eligible_observation AS (
         SELECT observation.occurrence_id AS observation_id,
                observation.challenge_identity AS challenge_key,
                observation.input_index,
                provenance.funding_block_hash,
                provenance.funding_txid,
                provenance.funding_vout,
                provenance.wallet_id AS input_wallet_id,
                provenance.output_key AS input_output_key,
                CASE provenance.binding_kind
                  WHEN 'wallet' THEN 'registered-wallet-output'
                  WHEN 'deposit' THEN 'deposit-binding'
                END AS input_binding_kind,
                decode(
                  regexp_replace(
                    lower(provenance.source_event_id), '^0x', ''
                  ),
                  'hex'
                )
                  AS input_binding_source_event_id,
                observation.provenance_generation
                  AS candidate_provenance_generation,
                observation.provenance_fingerprint,
                certificate.certificate_id AS readiness_certificate_id,
                certificate.certificate_generation
                  AS readiness_certificate_generation
           FROM p2tr_bitcoin_candidates candidate
           JOIN p2tr_bitcoin_candidate_observations observation
             ON observation.block_hash = candidate.block_hash
            AND observation.txid = candidate.txid
            AND observation.wtxid = candidate.wtxid
            AND observation.provenance_generation =
                candidate.provenance_generation
           JOIN p2tr_bitcoin_candidate_ethereum_provenance provenance
             ON provenance.block_hash = observation.block_hash
            AND provenance.txid = observation.txid
            AND provenance.wtxid = observation.wtxid
            AND provenance.input_index = observation.input_index
            AND provenance.provenance_generation =
                observation.provenance_generation
           JOIN p2tr_readiness_certificates certificate
             ON certificate.certificate_id = $17
            AND certificate.certificate_generation = $18
            AND certificate.is_current
            AND certificate.invalidated_at IS NULL
            AND certificate.manifest_hash = $2
            AND certificate.bitcoin_height = $8
            AND certificate.bitcoin_hash = $9
            AND certificate.ethereum_block_number = $10
            AND certificate.ethereum_block_hash = $11
           JOIN p2tr_canonical_generations certified_generation
             ON certified_generation.generation_id =
                  certificate.primary_bitcoin_generation
            AND certified_generation.state = 'committed'
            AND certified_generation.bitcoin_chain_root =
                  certificate.primary_bitcoin_root
            AND certified_generation.semantic_root =
                  certificate.primary_bitcoin_semantic_root
           JOIN p2tr_bitcoin_cursor certified_bitcoin
             ON certified_bitcoin.singleton
            AND certified_bitcoin.current_height =
                  certified_generation.bitcoin_height
            AND certified_bitcoin.current_hash =
                  certified_generation.bitcoin_hash
           JOIN p2tr_ethereum_cursor certified_ethereum
             ON certified_ethereum.singleton
            AND certified_ethereum.generation =
                  certificate.ethereum_journal_generation
            AND certified_ethereum.current_block_number =
                  certified_generation.ethereum_block_number
            AND certified_ethereum.current_block_hash =
                  certified_generation.ethereum_block_hash
           JOIN p2tr_ethereum_blocks certified_ethereum_block
             ON certified_ethereum_block.block_number =
                  certified_ethereum.current_block_number
            AND certified_ethereum_block.block_hash =
                  certified_ethereum.current_block_hash
            AND certified_ethereum_block.history_root =
                  certificate.ethereum_history_root
          WHERE candidate.txid = $4
            AND candidate.wtxid = $5
            AND candidate.block_height = $6
            AND candidate.block_hash = $7
            AND observation.input_index = $14
            AND observation.occurrence_id = $15
            AND observation.challenge_identity = $16
            AND observation.disposition = 'keypath_delivered'
            AND observation.challenge_identity IS NOT NULL
            AND provenance.source_event_id ~*
                '^(0x)?[0-9a-f]{64}$'
            AND certified_generation.generation_id = (
              SELECT max(generation_id)
                FROM p2tr_canonical_generations
               WHERE state = 'committed'
            )
       )
       INSERT INTO p2tr_candidate_enqueue_authorizations
         (token_id, manifest_hash, candidate_digest,
          observation_id, challenge_key, txid, wtxid, input_index,
          bitcoin_block_height, bitcoin_block_hash,
          verified_bitcoin_height, verified_bitcoin_hash,
          verified_ethereum_block, verified_ethereum_hash,
          funding_block_hash, funding_txid, funding_vout,
          input_wallet_id, input_output_key, input_binding_kind,
          input_binding_source_event_id, candidate_provenance_generation,
          provenance_fingerprint, readiness_certificate_id,
          readiness_certificate_generation, expires_at)
       SELECT $1, $2, $3,
              eligible.observation_id, eligible.challenge_key,
              $4, $5, eligible.input_index, $6, $7, $8, $9, $10, $11,
              eligible.funding_block_hash, eligible.funding_txid,
              eligible.funding_vout, eligible.input_wallet_id,
              eligible.input_output_key, eligible.input_binding_kind,
              eligible.input_binding_source_event_id,
              eligible.candidate_provenance_generation,
              eligible.provenance_fingerprint,
              eligible.readiness_certificate_id,
              eligible.readiness_certificate_generation,
              $12::timestamptz
         FROM eligible_observation eligible
        WHERE $12::timestamptz > clock_timestamp()
          AND $12::timestamptz <=
              clock_timestamp() + ($13 * interval '1 millisecond')
          AND NOT EXISTS (
            SELECT 1 FROM p2tr_candidate_enqueue_authorizations
             WHERE candidate_digest = $3 AND consumed_at IS NOT NULL
          )`,
      [
        hexBuffer(normalized.tokenID, "candidate token"),
        hexBuffer(normalized.manifestHash, "candidate manifest"),
        hexBuffer(normalized.candidateDigest, "candidate digest"),
        hexBuffer(normalized.candidate.txid, "candidate txid"),
        hexBuffer(normalized.candidate.wtxid, "candidate wtxid"),
        normalized.candidate.blockHeight,
        hexBuffer(normalized.candidate.blockHash, "candidate block hash"),
        normalized.verifiedBitcoin.height,
        hexBuffer(normalized.verifiedBitcoin.hash, "verified Bitcoin hash"),
        normalized.verifiedEthereum.blockNumber,
        hexBuffer(
          normalized.verifiedEthereum.blockHash,
          "verified Ethereum hash"
        ),
        normalized.expiresAt,
        this.maxCandidateAuthorizationLifetimeMs,
        normalized.candidate.inputIndex,
        hexBuffer(
          normalized.candidate.observationID,
          "candidate observation ID"
        ),
        hexBuffer(normalized.candidate.challengeKey, "candidate challenge key"),
        hexBuffer(
          normalized.readinessCertificate.certificateID,
          "readiness certificate"
        ),
        normalized.readinessCertificate.generation,
      ]
    )
    if (result.rowCount !== 1) {
      throw new Error(
        "Candidate authorization expiry is invalid or token is reused"
      )
    }
  }

  async lockCandidateAuthorization(
    tokenID: string,
    candidateDigest: string,
    manifestHash: string
  ): Promise<void> {
    const result = await this.session.query<{
      candidate_digest: string
      consumed_at: string | null
      invalidated_at: string | null
      live: boolean
      canonical: boolean
      current_manifest_hash: string
    }>(
      `SELECT encode(candidate_digest, 'hex') AS candidate_digest,
              consumed_at,
              invalidated_at,
              expires_at > clock_timestamp() AS live,
              encode(manifest.manifest_hash, 'hex') AS current_manifest_hash,
              true AS canonical
         FROM p2tr_candidate_enqueue_authorizations authorization
         JOIN p2tr_readiness_certificates certificate
           ON certificate.certificate_id =
                authorization.readiness_certificate_id
          AND certificate.certificate_generation =
                authorization.readiness_certificate_generation
          AND certificate.is_current
          AND certificate.invalidated_at IS NULL
          AND certificate.manifest_hash = authorization.manifest_hash
          AND certificate.bitcoin_height =
                authorization.verified_bitcoin_height
          AND certificate.bitcoin_hash =
                authorization.verified_bitcoin_hash
          AND certificate.ethereum_block_number =
                authorization.verified_ethereum_block
          AND certificate.ethereum_block_hash =
                authorization.verified_ethereum_hash
         JOIN p2tr_watchtower_activation_manifest manifest
           ON manifest.singleton = true
          AND manifest.manifest_hash = authorization.manifest_hash
          AND manifest.activation_sequence =
                certificate.manifest_activation_sequence
         JOIN p2tr_canonical_generations certified_generation
           ON certified_generation.generation_id =
                certificate.primary_bitcoin_generation
          AND certified_generation.state = 'committed'
          AND certified_generation.bitcoin_chain_root =
                certificate.primary_bitcoin_root
          AND certified_generation.semantic_root =
                certificate.primary_bitcoin_semantic_root
         JOIN p2tr_bitcoin_cursor certified_bitcoin
           ON certified_bitcoin.singleton
          AND certified_bitcoin.current_height =
                certified_generation.bitcoin_height
          AND certified_bitcoin.current_hash =
                certified_generation.bitcoin_hash
         JOIN p2tr_ethereum_cursor certified_ethereum
           ON certified_ethereum.singleton
          AND certified_ethereum.generation =
                certificate.ethereum_journal_generation
          AND certified_ethereum.current_block_number =
                certified_generation.ethereum_block_number
          AND certified_ethereum.current_block_hash =
                certified_generation.ethereum_block_hash
         JOIN p2tr_ethereum_blocks certified_ethereum_block
           ON certified_ethereum_block.block_number =
                certified_ethereum.current_block_number
          AND certified_ethereum_block.block_hash =
                certified_ethereum.current_block_hash
          AND certified_ethereum_block.history_root =
                certificate.ethereum_history_root
        WHERE token_id = $1
          AND certified_generation.generation_id = (
            SELECT max(generation_id)
              FROM p2tr_canonical_generations
             WHERE state = 'committed'
          )
        FOR UPDATE OF authorization
        FOR SHARE OF manifest, certificate, certified_generation,
                     certified_bitcoin, certified_ethereum,
                     certified_ethereum_block`,
      [hexBuffer(tokenID, "candidate token")]
    )
    if (
      result.rows.length !== 1 ||
      bytes32(result.rows[0].candidate_digest, "stored candidate digest") !==
        bytes32(candidateDigest, "candidate digest") ||
      bytes32(result.rows[0].current_manifest_hash, "current manifest hash") !==
        bytes32(manifestHash, "expected manifest hash") ||
      result.rows[0].consumed_at !== null ||
      result.rows[0].invalidated_at !== null ||
      result.rows[0].live !== true ||
      result.rows[0].canonical !== true
    ) {
      throw new Error(
        "Candidate authorization is absent, expired, used, or mismatched"
      )
    }
  }

  async consumeCandidateAuthorization(
    tokenID: string,
    outboxIntentID: string,
    manifestHash: string
  ): Promise<void> {
    await this.assertCurrentActivationManifest(manifestHash)
    const result = await this.session.query(
      `UPDATE p2tr_candidate_enqueue_authorizations
          SET consumed_at = clock_timestamp(), outbox_intent_id = $2
        WHERE token_id = $1
          AND manifest_hash = $3
          AND manifest_hash = (
            SELECT manifest_hash
              FROM p2tr_watchtower_activation_manifest
             WHERE singleton = true
          )
          AND consumed_at IS NULL
          AND invalidated_at IS NULL
          AND expires_at > clock_timestamp()`,
      [
        hexBuffer(tokenID, "candidate token"),
        hexBuffer(outboxIntentID, "outbox intent ID"),
        hexBuffer(manifestHash, "expected manifest hash"),
      ]
    )
    if (result.rowCount !== 1) {
      throw new Error("Candidate authorization consumption failed")
    }
  }

  async armCandidateEnqueueTransactionGuard(
    guard: P2TRProductionCandidateEnqueueTransactionGuard
  ): Promise<void> {
    const normalized = normalizeCandidateEnqueueTransactionGuard(guard)
    await this.assertCurrentActivationManifest(normalized.manifestHash)
    const guardDigest = candidateEnqueueTransactionGuardDigest(normalized)
    const inserted = await this.session.query(
      `INSERT INTO p2tr_candidate_enqueue_transaction_guard
         (manifest_hash, token_id, candidate_digest, max_attempt_count,
          guard_digest)
       SELECT $1, $2, $3, $4, $5
         FROM p2tr_candidate_enqueue_authorizations authorization
         JOIN p2tr_watchtower_activation_manifest manifest
           ON manifest.singleton = true
          AND manifest.manifest_hash = authorization.manifest_hash
        WHERE authorization.token_id = $2
          AND authorization.manifest_hash = $1
          AND authorization.candidate_digest = $3
          AND authorization.consumed_at IS NULL
          AND authorization.invalidated_at IS NULL
          AND authorization.expires_at > clock_timestamp()
       ON CONFLICT (manifest_hash, token_id) DO NOTHING`,
      [
        hexBuffer(normalized.manifestHash, "enqueue guard manifest"),
        hexBuffer(normalized.tokenID, "enqueue guard token"),
        hexBuffer(normalized.candidateDigest, "enqueue guard candidate"),
        normalized.maxAttemptCount,
        guardDigest,
      ]
    )
    if (inserted.rowCount !== 0 && inserted.rowCount !== 1) {
      throw new Error(
        "Candidate enqueue transaction guard insert is inconsistent"
      )
    }
    const stored = await this.session.query<{
      candidate_digest: string
      max_attempt_count: string | number
      guard_digest: string
    }>(
      `SELECT encode(candidate_digest, 'hex') AS candidate_digest,
              max_attempt_count,
              encode(guard_digest, 'hex') AS guard_digest
         FROM p2tr_candidate_enqueue_transaction_guard
        WHERE manifest_hash = $1 AND token_id = $2
        FOR SHARE`,
      [
        hexBuffer(normalized.manifestHash, "enqueue guard manifest"),
        hexBuffer(normalized.tokenID, "enqueue guard token"),
      ]
    )
    if (
      stored.rows.length !== 1 ||
      bytes32(stored.rows[0].candidate_digest, "stored guard candidate") !==
        normalized.candidateDigest ||
      databaseInteger(
        stored.rows[0].max_attempt_count,
        "stored guard attempt bound"
      ) !== normalized.maxAttemptCount ||
      bytes32(stored.rows[0].guard_digest, "stored guard digest") !==
        `0x${guardDigest.toString("hex")}`
    ) {
      throw new Error(
        "Candidate enqueue transaction guard conflicts with durable state"
      )
    }
  }

  async resolveCandidateEnqueueTransactionGuard(
    resolution: P2TRProductionCandidateEnqueueTransactionResolution
  ): Promise<void> {
    const normalized =
      normalizeCandidateEnqueueTransactionResolution(resolution)
    await this.assertCurrentActivationManifest(normalized.manifestHash)
    const guard = await this.session.query<{
      candidate_digest: string
      consumed_at: string | null
      outbox_intent_id: string | null
    }>(
      `SELECT encode(guard_row.candidate_digest, 'hex') AS candidate_digest,
              authorization.consumed_at,
              encode(authorization.outbox_intent_id, 'hex') AS outbox_intent_id
         FROM p2tr_candidate_enqueue_transaction_guard guard_row
         JOIN p2tr_candidate_enqueue_authorizations authorization
           ON authorization.manifest_hash = guard_row.manifest_hash
          AND authorization.token_id = guard_row.token_id
          AND authorization.candidate_digest = guard_row.candidate_digest
        WHERE guard_row.manifest_hash = $1 AND guard_row.token_id = $2
        FOR UPDATE OF guard_row, authorization`,
      [
        hexBuffer(normalized.manifestHash, "enqueue resolution manifest"),
        hexBuffer(normalized.tokenID, "enqueue resolution token"),
      ]
    )
    if (
      guard.rows.length !== 1 ||
      bytes32(guard.rows[0].candidate_digest, "resolution guard candidate") !==
        normalized.candidateDigest ||
      guard.rows[0].consumed_at === null ||
      guard.rows[0].outbox_intent_id === null ||
      bytes32(
        guard.rows[0].outbox_intent_id,
        "resolution authorization outbox intent"
      ) !== normalized.outboxIntentID
    ) {
      throw new Error(
        "Candidate enqueue resolution lacks exact consumed authorization state"
      )
    }
    const resolutionDigest =
      candidateEnqueueTransactionResolutionDigest(normalized)
    const inserted = await this.session.query(
      `INSERT INTO p2tr_candidate_enqueue_transaction_resolution
         (manifest_hash, token_id, candidate_digest, outbox_intent_id,
          outcome_kind, resolution_digest)
       SELECT guard_row.manifest_hash, guard_row.token_id,
              guard_row.candidate_digest, $4, $5, $6
         FROM p2tr_candidate_enqueue_transaction_guard guard_row
        WHERE guard_row.manifest_hash = $1
          AND guard_row.token_id = $2
          AND guard_row.candidate_digest = $3
          AND (
            $5 <> 'generation-cap-exhausted'
            OR EXISTS (
              SELECT 1
                FROM p2tr_signature_fraud_challenge_critical_alert outbox_alert
               WHERE outbox_alert.record_id = $4
                 AND outbox_alert.code = 'generation-cap-exhausted'
                 AND outbox_alert.activation_blocking = true
            )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM p2tr_candidate_enqueue_retry_exhaustion_alert alert
             WHERE alert.manifest_hash = guard_row.manifest_hash
               AND alert.token_id = guard_row.token_id
          )
       ON CONFLICT (manifest_hash, token_id) DO NOTHING`,
      [
        hexBuffer(normalized.manifestHash, "enqueue resolution manifest"),
        hexBuffer(normalized.tokenID, "enqueue resolution token"),
        hexBuffer(normalized.candidateDigest, "enqueue resolution candidate"),
        hexBuffer(
          normalized.outboxIntentID,
          "enqueue resolution outbox intent"
        ),
        normalized.outcomeKind,
        resolutionDigest,
      ]
    )
    if (inserted.rowCount !== 0 && inserted.rowCount !== 1) {
      throw new Error("Candidate enqueue resolution insert is inconsistent")
    }
    const stored = await this.session.query<{
      candidate_digest: string
      outbox_intent_id: string
      outcome_kind: string
      resolution_digest: string
    }>(
      `SELECT encode(candidate_digest, 'hex') AS candidate_digest,
              encode(outbox_intent_id, 'hex') AS outbox_intent_id,
              outcome_kind,
              encode(resolution_digest, 'hex') AS resolution_digest
         FROM p2tr_candidate_enqueue_transaction_resolution
        WHERE manifest_hash = $1 AND token_id = $2
        FOR SHARE`,
      [
        hexBuffer(normalized.manifestHash, "enqueue resolution manifest"),
        hexBuffer(normalized.tokenID, "enqueue resolution token"),
      ]
    )
    if (
      stored.rows.length !== 1 ||
      bytes32(
        stored.rows[0].candidate_digest,
        "stored enqueue resolution candidate"
      ) !== normalized.candidateDigest ||
      bytes32(
        stored.rows[0].outbox_intent_id,
        "stored enqueue resolution outbox intent"
      ) !== normalized.outboxIntentID ||
      stored.rows[0].outcome_kind !== normalized.outcomeKind ||
      bytes32(
        stored.rows[0].resolution_digest,
        "stored enqueue resolution digest"
      ) !== `0x${resolutionDigest.toString("hex")}`
    ) {
      throw new Error(
        "Candidate enqueue resolution conflicts with durable state"
      )
    }
  }

  async saveCandidateEnqueueRetryExhaustionAlert(
    alert: P2TRProductionCandidateEnqueueRetryExhaustionAlert
  ): Promise<void> {
    const normalized = normalizeCandidateEnqueueRetryExhaustionAlert(alert)
    await this.assertCurrentActivationManifest(normalized.manifestHash)
    const guard = await this.session.query<{
      candidate_digest: string
      max_attempt_count: string | number
    }>(
      `SELECT encode(candidate_digest, 'hex') AS candidate_digest,
              max_attempt_count
         FROM p2tr_candidate_enqueue_transaction_guard
        WHERE manifest_hash = $1 AND token_id = $2
        FOR UPDATE`,
      [
        hexBuffer(normalized.manifestHash, "retry alert manifest"),
        hexBuffer(normalized.tokenID, "retry alert token"),
      ]
    )
    if (
      guard.rows.length !== 1 ||
      bytes32(guard.rows[0].candidate_digest, "retry guard candidate") !==
        normalized.candidateDigest ||
      databaseInteger(
        guard.rows[0].max_attempt_count,
        "retry guard attempt bound"
      ) !== normalized.attemptCount
    ) {
      throw new Error("Candidate enqueue retry alert does not match its guard")
    }
    const detailDigest = candidateEnqueueRetryExhaustionDigest(normalized)
    const inserted = await this.session.query(
      `INSERT INTO p2tr_candidate_enqueue_retry_exhaustion_alert
         (manifest_hash, token_id, candidate_digest, attempt_count,
          last_sqlstate, detail_digest, activation_blocking)
       SELECT guard_row.manifest_hash, guard_row.token_id,
              guard_row.candidate_digest, $4, $5, $6, true
         FROM p2tr_candidate_enqueue_transaction_guard guard_row
        WHERE guard_row.manifest_hash = $1
          AND guard_row.token_id = $2
          AND guard_row.candidate_digest = $3
          AND NOT EXISTS (
            SELECT 1
              FROM p2tr_candidate_enqueue_transaction_resolution resolution
             WHERE resolution.manifest_hash = guard_row.manifest_hash
               AND resolution.token_id = guard_row.token_id
          )
       ON CONFLICT (manifest_hash, token_id) DO NOTHING`,
      [
        hexBuffer(normalized.manifestHash, "retry alert manifest"),
        hexBuffer(normalized.tokenID, "retry alert token"),
        hexBuffer(normalized.candidateDigest, "retry alert candidate"),
        normalized.attemptCount,
        normalized.lastSQLState,
        detailDigest,
      ]
    )
    if (inserted.rowCount !== 0 && inserted.rowCount !== 1) {
      throw new Error("Candidate enqueue retry alert insert is inconsistent")
    }
    const stored = await this.session.query<{
      candidate_digest: string
      attempt_count: string | number
      last_sqlstate: string
      detail_digest: string
      activation_blocking: boolean
    }>(
      `SELECT encode(candidate_digest, 'hex') AS candidate_digest,
              attempt_count, last_sqlstate,
              encode(detail_digest, 'hex') AS detail_digest,
              activation_blocking
         FROM p2tr_candidate_enqueue_retry_exhaustion_alert
        WHERE manifest_hash = $1 AND token_id = $2
        FOR SHARE`,
      [
        hexBuffer(normalized.manifestHash, "retry alert manifest"),
        hexBuffer(normalized.tokenID, "retry alert token"),
      ]
    )
    if (
      stored.rows.length !== 1 ||
      bytes32(stored.rows[0].candidate_digest, "stored retry candidate") !==
        normalized.candidateDigest ||
      databaseInteger(
        stored.rows[0].attempt_count,
        "stored retry attempt count"
      ) !== normalized.attemptCount ||
      stored.rows[0].last_sqlstate !== normalized.lastSQLState ||
      bytes32(stored.rows[0].detail_digest, "stored retry alert digest") !==
        `0x${detailDigest.toString("hex")}` ||
      stored.rows[0].activation_blocking !== true
    ) {
      throw new Error(
        "Candidate enqueue retry alert conflicts with durable state"
      )
    }
  }

  async loadActivationEnvelope(
    trustedSignerKeyHash: string
  ): Promise<P2TRProductionActivationEnvelope> {
    const trusted = bytes32(trustedSignerKeyHash, "trusted activation signer")
    const result = await this.session.query<{
      activation_sequence: string | number
      manifest_hash: string
      trusted_signer_key_hash: string
      payload: unknown
      envelope: unknown
      payload_bytes: string | number
      envelope_bytes: string | number
    }>(
      `SELECT activation_sequence,
              encode(manifest_hash, 'hex') AS manifest_hash,
              encode(trusted_signer_key_hash, 'hex') AS trusted_signer_key_hash,
              payload, envelope,
              octet_length(payload::text) AS payload_bytes,
              octet_length(envelope::text) AS envelope_bytes
         FROM p2tr_watchtower_activation_manifest
        WHERE singleton = true
        FOR SHARE`
    )
    if (result.rows.length !== 1) {
      throw new Error(
        "Production activation manifest is absent or non-singleton"
      )
    }
    const row = result.rows[0]
    if (
      bytes32(row.trusted_signer_key_hash, "stored activation signer") !==
        trusted ||
      databaseInteger(row.payload_bytes, "activation payload bytes") >
        this.maxManifestBytes ||
      databaseInteger(row.envelope_bytes, "activation envelope bytes") >
        this.maxManifestBytes ||
      !isPlainObject(row.payload) ||
      !isPlainObject(row.envelope)
    ) {
      throw new Error("Stored activation envelope signer/size/shape is invalid")
    }
    const envelope = structuredClone(
      row.envelope
    ) as P2TRProductionActivationEnvelope
    if (
      !isPlainObject(envelope.payload) ||
      databaseInteger(row.activation_sequence, "activation sequence") !==
        envelope.payload.activationSequence ||
      canonicalJSON(row.payload) !== canonicalJSON(envelope.payload) ||
      bytes32(row.manifest_hash, "stored activation manifest hash") !==
        bytes32(envelope.payloadSha256, "envelope manifest hash")
    ) {
      throw new Error(
        "Stored activation envelope does not match its durable index"
      )
    }
    return envelope
  }

  private async readComponentHealth(
    component: P2TRProductionComponent
  ): Promise<ComponentHealthRow> {
    const result = await this.session.query<ComponentHealthRow>(
      `SELECT component,
              encode(configuration_fingerprint, 'hex') AS configuration_fingerprint,
              position_number, encode(position_hash, 'hex') AS position_hash,
              failure_generation, cleared_failure_generation
         FROM p2tr_watchtower_component_health
        WHERE component = $1
        FOR SHARE`,
      [component]
    )
    if (result.rows.length !== 1 || result.rows[0].component !== component) {
      throw new Error(`Production component health is absent for ${component}`)
    }
    return result.rows[0]
  }

  private async assertCurrentActivationManifest(
    manifestHash: string
  ): Promise<void> {
    const result = await this.session.query<{ manifest_hash: string }>(
      `SELECT encode(manifest_hash, 'hex') AS manifest_hash
         FROM p2tr_watchtower_activation_manifest
        WHERE singleton = true
        FOR SHARE`
    )
    if (
      result.rows.length !== 1 ||
      bytes32(result.rows[0].manifest_hash, "current activation manifest") !==
        bytes32(manifestHash, "expected activation manifest")
    ) {
      throw new Error("Candidate authority belongs to a superseded manifest")
    }
  }
}

/** Health mutations are explicit and transaction-bound; callers record a
 * failure in a fresh transaction after the failed work transaction rolls back. */
export class PostgresP2TRProductionComponentHealthRecorder {
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string

  constructor(
    private readonly session: P2TRPostgresTransactionSession,
    storeID: string
  ) {
    assertP2TRPostgresTransactionSession(session)
    this.p2trSignatureFraudWatchtowerTransactionalStoreID = boundedString(
      storeID,
      255,
      "component health store ID"
    )
  }

  async recordSuccess(
    component: P2TRProductionComponent,
    configurationFingerprint: string,
    position: { number: number; hash: string }
  ): Promise<void> {
    const result = await this.session.query(
      `INSERT INTO p2tr_watchtower_component_health
         (component, configuration_fingerprint, position_number, position_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (component) DO UPDATE
         SET configuration_fingerprint = EXCLUDED.configuration_fingerprint,
             position_number = EXCLUDED.position_number,
             position_hash = EXCLUDED.position_hash,
             cleared_failure_generation = p2tr_watchtower_component_health.failure_generation,
             last_failure_digest = NULL,
             last_failure_at = NULL,
             last_success_at = clock_timestamp(),
             updated_at = clock_timestamp()`,
      [
        componentName(component),
        hexBuffer(configurationFingerprint, "component fingerprint"),
        nonNegativeInteger(position.number, "component position"),
        hexBuffer(position.hash, "component position hash"),
      ]
    )
    if (result.rowCount !== 1) {
      throw new Error(`Failed to record ${component} success`)
    }
  }

  async recordFailure(
    component: P2TRProductionComponent,
    configurationFingerprint: string,
    position: { number: number; hash: string },
    failure: unknown
  ): Promise<void> {
    const digest = createHash("sha256")
      .update(normalizeFailure(failure))
      .digest()
    const result = await this.session.query(
      `INSERT INTO p2tr_watchtower_component_health
         (component, configuration_fingerprint, position_number, position_hash,
          failure_generation, cleared_failure_generation,
          last_failure_digest, last_failure_at)
       VALUES ($1, $2, $3, $4, 1, 0, $5, clock_timestamp())
       ON CONFLICT (component) DO UPDATE
         SET configuration_fingerprint = EXCLUDED.configuration_fingerprint,
             position_number = EXCLUDED.position_number,
             position_hash = EXCLUDED.position_hash,
             failure_generation = p2tr_watchtower_component_health.failure_generation + 1,
             last_failure_digest = EXCLUDED.last_failure_digest,
             last_failure_at = clock_timestamp(),
             updated_at = clock_timestamp()`,
      [
        componentName(component),
        hexBuffer(configurationFingerprint, "component fingerprint"),
        nonNegativeInteger(position.number, "component position"),
        hexBuffer(position.hash, "component position hash"),
        digest,
      ]
    )
    if (result.rowCount !== 1) {
      throw new Error(`Failed to record ${component} failure`)
    }
  }
}

function assertComponentPosition(
  row: ComponentHealthRow,
  fingerprint: string,
  position: number,
  hash: string
): void {
  if (
    bytes32(row.configuration_fingerprint, "component fingerprint") !==
      fingerprint ||
    databaseInteger(row.position_number, "component position") !== position ||
    bytes32(row.position_hash, "component position hash") !== hash
  ) {
    throw new Error(`Production component ${row.component} health is stale`)
  }
}

function normalizeReceipt(
  receipt: P2TRProductionCandidateAuthorizationReceipt
): P2TRProductionCandidateAuthorizationReceipt {
  const expires = new Date(receipt.expiresAt)
  if (
    !Number.isFinite(expires.getTime()) ||
    expires.toISOString() !== receipt.expiresAt
  ) {
    throw new Error("Candidate authorization expiry is not canonical")
  }
  return {
    tokenID: bytes32(receipt.tokenID, "candidate token"),
    manifestHash: bytes32(receipt.manifestHash, "candidate manifest"),
    candidateDigest: bytes32(receipt.candidateDigest, "candidate digest"),
    candidate: normalizeCandidate(receipt.candidate),
    readinessCertificate: {
      certificateID: bytes32(
        receipt.readinessCertificate.certificateID,
        "readiness certificate"
      ),
      generation: positiveInteger(
        receipt.readinessCertificate.generation,
        "readiness certificate generation"
      ),
    },
    verifiedBitcoin: {
      height: nonNegativeInteger(
        receipt.verifiedBitcoin.height,
        "verified Bitcoin height"
      ),
      hash: bytes32(receipt.verifiedBitcoin.hash, "verified Bitcoin hash"),
    },
    verifiedEthereum: {
      blockNumber: nonNegativeInteger(
        receipt.verifiedEthereum.blockNumber,
        "verified Ethereum block"
      ),
      blockHash: bytes32(
        receipt.verifiedEthereum.blockHash,
        "verified Ethereum hash"
      ),
    },
    expiresAt: expires.toISOString(),
  }
}

function normalizeReadinessCertificateInput(
  input: P2TRProductionReadinessCertificateInput
): P2TRProductionReadinessCertificateInput {
  if (
    !isPlainObject(input.payload) ||
    input.payload.schema !== "tbtc-p2tr-production-readiness-certificate/v1" ||
    bytes32(
      String(input.payload.manifestHash),
      "readiness payload manifest"
    ) !== bytes32(input.manifestHash, "readiness manifest")
  ) {
    throw new Error("Readiness certificate payload is malformed")
  }
  return {
    manifestHash: bytes32(input.manifestHash, "readiness manifest"),
    verifiedBitcoin: {
      height: nonNegativeInteger(
        input.verifiedBitcoin.height,
        "verified Bitcoin height"
      ),
      hash: bytes32(input.verifiedBitcoin.hash, "verified Bitcoin hash"),
    },
    verifiedEthereum: {
      blockNumber: nonNegativeInteger(
        input.verifiedEthereum.blockNumber,
        "verified Ethereum block"
      ),
      blockHash: bytes32(
        input.verifiedEthereum.blockHash,
        "verified Ethereum hash"
      ),
    },
    bitcoinIndex: normalizeBitcoinIndexHealth(input.bitcoinIndex),
    ethereumJournal: normalizeEthereumJournalHealth(input.ethereumJournal),
    payload: input.payload,
  }
}

function normalizeBitcoinIndexHealth(
  value: P2TRProductionBitcoinIndexHealth
): P2TRProductionBitcoinIndexHealth {
  return {
    ...value,
    storeID: boundedString(value.storeID, 255, "Bitcoin store ID"),
    configurationFingerprint: bytes32(
      value.configurationFingerprint,
      "Bitcoin configuration fingerprint"
    ),
    network: boundedString(value.network, 32, "Bitcoin network"),
    checkpoint: {
      height: nonNegativeInteger(
        value.checkpoint.height,
        "Bitcoin checkpoint height"
      ),
      hash: bytes32(value.checkpoint.hash, "Bitcoin checkpoint hash"),
    },
    current: {
      height: nonNegativeInteger(value.current.height, "Bitcoin cursor height"),
      hash: bytes32(value.current.hash, "Bitcoin cursor hash"),
    },
  }
}

function normalizeEthereumJournalHealth(
  value: P2TRProductionEthereumJournalHealth
): P2TRProductionEthereumJournalHealth {
  return {
    ...value,
    storeID: boundedString(value.storeID, 255, "Ethereum store ID"),
    chainID: positiveInteger(value.chainID, "Ethereum chain ID"),
    configurationFingerprint: bytes32(
      value.configurationFingerprint,
      "Ethereum configuration fingerprint"
    ),
    descriptorSetHash: bytes32(
      value.descriptorSetHash,
      "Ethereum descriptor set"
    ),
    checkpoint: {
      blockNumber: nonNegativeInteger(
        value.checkpoint.blockNumber,
        "Ethereum checkpoint block"
      ),
      blockHash: bytes32(
        value.checkpoint.blockHash,
        "Ethereum checkpoint hash"
      ),
    },
    scanStartBlock: positiveInteger(
      value.scanStartBlock,
      "Ethereum scan start block"
    ),
    current: {
      blockNumber: nonNegativeInteger(
        value.current.blockNumber,
        "Ethereum cursor block"
      ),
      blockHash: bytes32(value.current.blockHash, "Ethereum cursor hash"),
    },
    requiredEventHistoryDigest: bytes32(
      value.requiredEventHistoryDigest,
      "Ethereum event history digest"
    ),
  }
}

function normalizeReadinessCertificateState(row: ReadinessCertificateStateRow) {
  return {
    activationSequence: positiveInteger(
      databaseInteger(row.activation_sequence, "activation sequence"),
      "activation sequence"
    ),
    outboxMaxRecoveryBacklog: nonNegativeInteger(
      databaseInteger(
        row.outbox_max_recovery_backlog,
        "outbox recovery backlog bound"
      ),
      "outbox recovery backlog bound"
    ),
    primaryBitcoinGeneration: positiveInteger(
      databaseInteger(
        row.primary_bitcoin_generation,
        "primary Bitcoin generation"
      ),
      "primary Bitcoin generation"
    ),
    primaryBitcoinRoot: bytes32(
      row.primary_bitcoin_root,
      "primary Bitcoin root"
    ),
    primaryBitcoinSemanticRoot: bytes32(
      row.primary_bitcoin_semantic_root,
      "primary Bitcoin semantic root"
    ),
    localBitcoin: {
      height: nonNegativeInteger(
        databaseInteger(row.local_bitcoin_height, "local Bitcoin height"),
        "local Bitcoin height"
      ),
      hash: bytes32(row.local_bitcoin_hash, "local Bitcoin hash"),
    },
    ethereumJournalGeneration: positiveInteger(
      databaseInteger(
        row.ethereum_journal_generation,
        "Ethereum journal generation"
      ),
      "Ethereum journal generation"
    ),
    ethereumHistoryRoot: bytes32(
      row.ethereum_history_root,
      "Ethereum history root"
    ),
    localEthereum: {
      blockNumber: nonNegativeInteger(
        databaseInteger(row.local_ethereum_block, "local Ethereum block"),
        "local Ethereum block"
      ),
      blockHash: bytes32(row.local_ethereum_hash, "local Ethereum hash"),
    },
  }
}

function normalizeCandidate(
  candidate: P2TRProductionBitcoinCandidate
): P2TRProductionBitcoinCandidate {
  const identity = {
    txid: bytes32(candidate.txid, "candidate txid"),
    wtxid: bytes32(candidate.wtxid, "candidate wtxid"),
    blockHeight: nonNegativeInteger(
      candidate.blockHeight,
      "candidate block height"
    ),
    blockHash: bytes32(candidate.blockHash, "candidate block hash"),
    inputIndex: uint32(candidate.inputIndex, "candidate input index"),
    observationID: bytes32(candidate.observationID, "candidate observation ID"),
    challengeKey: bytes32(candidate.challengeKey, "candidate challenge key"),
  }
  return identity
}

function normalizeCandidateEnqueueTransactionGuard(
  guard: P2TRProductionCandidateEnqueueTransactionGuard
): P2TRProductionCandidateEnqueueTransactionGuard {
  return {
    tokenID: bytes32(guard.tokenID, "enqueue guard token"),
    manifestHash: bytes32(guard.manifestHash, "enqueue guard manifest"),
    candidateDigest: bytes32(guard.candidateDigest, "enqueue guard candidate"),
    maxAttemptCount: boundedPositiveInteger(
      guard.maxAttemptCount,
      8,
      "enqueue guard attempt bound"
    ),
  }
}

function normalizeCandidateEnqueueTransactionResolution(
  resolution: P2TRProductionCandidateEnqueueTransactionResolution
): P2TRProductionCandidateEnqueueTransactionResolution {
  if (
    resolution.outcomeKind !== "enqueued" &&
    resolution.outcomeKind !== "generation-cap-exhausted"
  ) {
    throw new Error("Candidate enqueue resolution outcome is unsupported")
  }
  return {
    tokenID: bytes32(resolution.tokenID, "enqueue resolution token"),
    manifestHash: bytes32(
      resolution.manifestHash,
      "enqueue resolution manifest"
    ),
    candidateDigest: bytes32(
      resolution.candidateDigest,
      "enqueue resolution candidate"
    ),
    outboxIntentID: bytes32(
      resolution.outboxIntentID,
      "enqueue resolution outbox intent"
    ),
    outcomeKind: resolution.outcomeKind,
  }
}

function normalizeCandidateEnqueueRetryExhaustionAlert(
  alert: P2TRProductionCandidateEnqueueRetryExhaustionAlert
): P2TRProductionCandidateEnqueueRetryExhaustionAlert {
  if (alert.lastSQLState !== "40001" && alert.lastSQLState !== "40P01") {
    throw new Error("Candidate enqueue retry alert SQLSTATE is unsupported")
  }
  return {
    tokenID: bytes32(alert.tokenID, "retry alert token"),
    manifestHash: bytes32(alert.manifestHash, "retry alert manifest"),
    candidateDigest: bytes32(alert.candidateDigest, "retry alert candidate"),
    attemptCount: boundedPositiveInteger(
      alert.attemptCount,
      8,
      "retry alert attempt count"
    ),
    lastSQLState: alert.lastSQLState,
  }
}

function candidateEnqueueTransactionGuardDigest(
  guard: P2TRProductionCandidateEnqueueTransactionGuard
): Buffer {
  return durableCandidateEnqueueDigest(
    "tbtc-p2tr-candidate-enqueue-transaction-guard/v1",
    guard
  )
}

function candidateEnqueueTransactionResolutionDigest(
  resolution: P2TRProductionCandidateEnqueueTransactionResolution
): Buffer {
  return durableCandidateEnqueueDigest(
    "tbtc-p2tr-candidate-enqueue-transaction-resolution/v1",
    resolution
  )
}

function candidateEnqueueRetryExhaustionDigest(
  alert: P2TRProductionCandidateEnqueueRetryExhaustionAlert
): Buffer {
  return durableCandidateEnqueueDigest(
    "tbtc-p2tr-candidate-enqueue-retry-exhaustion/v1",
    alert
  )
}

function durableCandidateEnqueueDigest(domain: string, value: unknown): Buffer {
  return createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(canonicalJSON(value), "utf8")
    .digest()
}

function componentName(
  value: P2TRProductionComponent
): P2TRProductionComponent {
  if (
    value !== "bitcoin-index" &&
    value !== "ethereum-journal" &&
    value !== "ethereum-projector"
  ) {
    throw new Error("Unknown production component")
  }
  return value
}

function normalizeFailure(value: unknown): string {
  const text =
    value instanceof Error
      ? `${value.name}:${value.message}`
      : typeof value === "string"
      ? value
      : "unknown production component failure"
  return text.slice(0, 4096)
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
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical activation state contains an unsafe number")
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`
  }
  throw new Error("Canonical activation state contains an unsupported value")
}

function databaseInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return nonNegativeInteger(parsed, label)
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function boundedPositiveInteger(
  value: number,
  maximum: number,
  label: string
): number {
  const normalized = positiveInteger(value, label)
  if (normalized > maximum) {
    throw new Error(`${label} exceeds its ${maximum}-item bound`)
  }
  return normalized
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function uint32(value: number, label: string): number {
  const normalized = nonNegativeInteger(value, label)
  if (normalized > 0xffffffff) {
    throw new Error(`${label} must be a uint32`)
  }
  return normalized
}

function boundedString(value: string, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

function bytes32(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be 32 bytes`)
  }
  return `0x${normalized}`
}

function hexBuffer(value: string, label: string): Buffer {
  return Buffer.from(bytes32(value, label).slice(2), "hex")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}
