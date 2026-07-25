import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto"

export const P2TR_PRODUCTION_ACTIVATION_HANDSHAKE_SCHEMA =
  "tbtc-p2tr-production-activation-handshake/v1" as const

export type P2TRProductionActivationEthereumPoint = {
  blockNumber: number
  blockHash: string
}

export type P2TRProductionActivationHandshakeRequest = {
  schema: typeof P2TR_PRODUCTION_ACTIVATION_HANDSHAKE_SCHEMA
  challenge: {
    nonce: string
    manifestHash: string
    ethereumPoint: P2TRProductionActivationEthereumPoint
  }
}

export type P2TROutboxProductionSignedHandshake<State> = {
  payload: {
    kind: "outbox"
    nonce: string
    manifestHash: string
    ethereumPoint: P2TRProductionActivationEthereumPoint
    state: State
  }
  signerPublicKeySpki: string
  signature: string
}

export type P2TROutboxCurrentReadinessCertificate = {
  certificateID: string
  certificateGeneration: number
  manifestHash: string
  ethereumPoint: P2TRProductionActivationEthereumPoint
}

export type P2TRProductionOutboxActivationState = {
  storeID: string
  schemaVersion: number
  schemaConstraintHash: string
  manifestActivationSequence: number
  manifestOutboxCapacityConfigured: boolean
  currentReadinessCertificate: P2TROutboxCurrentReadinessCertificate
  statusCounts: Readonly<Record<string, number>>
  activeGenerationCount: number
  activeOldManifestGenerationCount: number
  expiredPreparationLeaseCount: number
  pendingNonceReleaseCount: number
  pendingNonceReleaseSetHash: string
  ambiguousNonceReleaseCount: number
  ambiguousNonceReleaseSetHash: string
  recoveryBacklogCount: number
  activationBlockingAlertCount: number
  activationBlockingAlertSetHash: string
  provenanceIncidentCount: number
  provenanceIncidentSetHash: string
  unresolvedNonceGuardCount: number
  danglingNonceGuardCount: number
  configuredSignerLaneCount: number
  configuredSignerLaneSetHash: string
  quarantinedSignerLaneCount: number
  healthySignerLaneCount: number
  healthySignerLaneSetHash: string
  stateHistoryMismatchCount: number
  capacityCounterMismatchCount: number
  activeNonceReleaseAttemptCount: number
  activeSignerInvocationCount: number
  unresolvedReleaseBarrierCount: number
  nonceAllocatorContractMismatchBlocked: boolean
  nonceAllocatorBarrierMismatchCount: number
  activationBlocked: boolean
  activationBlockingReasons: readonly string[]
  sampledAtUnixMs: number
}

export type P2TRPostgresQueryResult<Row> = {
  rows: Row[]
  rowCount: number | null
}

/** Structurally compatible only after the runtime coordinator mints it. */
export interface P2TRPostgresOutboxTransactionSession {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>>
}

export interface P2TRProductionActivationHandshakeKeyProvider {
  readonly signerPublicKeySpki: string
  signP2TRActivationPayload(payloadBytes: Uint8Array): Promise<Uint8Array>
}

export type PostgresP2TRSignatureFraudOutboxActivationHandshakeOptions = {
  storeID: string
  session: P2TRPostgresOutboxTransactionSession
  assertTransactionSession(session: P2TRPostgresOutboxTransactionSession): void
  keyProvider: P2TRProductionActivationHandshakeKeyProvider
  /** Must query the canonical readiness row through the same minted session. */
  readCurrentReadinessCertificate(
    session: P2TRPostgresOutboxTransactionSession,
    challenge: P2TRProductionActivationHandshakeRequest["challenge"]
  ): Promise<P2TROutboxCurrentReadinessCertificate>
  now?: () => number
}

type ManifestAndCursorRow = {
  transaction_isolation: string
  activation_sequence: string | number
  manifest_hash: string
  max_active_outbox_records: string | null
  current_block_number: string | number
  current_block_hash: string
}

type CountRow = { count: string | number }
type StatusCountRow = { status: string; count: string | number }
type DigestRow = { id: string; details_digest: string }
type CatalogDefinitionRow = {
  object_kind: string
  object_name: string
  definition: string
}
type SignerLaneStateRow = {
  chain_id: string
  signer_lane_id: string
  signer_identity: string
  sender: string
  policy_hash: string
  signer_code_hash: string
  configuration_hash: string
  quarantined: boolean
}
type NonceAllocatorBarrierRow = {
  active_release_attempt_count: string | number
  active_signer_invocation_count: string | number
  unresolved_release_count: string | number
  contract_mismatch_blocked: boolean
  mismatch_count: string | number
}

const TERMINAL_STATUSES = [
  "accepted-own",
  "satisfied-external",
  "terminal-reverted",
  "terminal-nonce-consumed",
  "generation-required",
  "cancelled-before-broadcast",
  "cancelled-honest-spend",
  "cancelled-reorg",
  "cancelled-provenance-invalidated",
] as const

/**
 * Produces the runtime wire handshake from one coordinator-owned PostgreSQL
 * transaction. It never opens a connection or transaction of its own.
 */
export class PostgresP2TRSignatureFraudOutboxActivationHandshakeProvider {
  private readonly now: () => number

  constructor(
    private readonly options: PostgresP2TRSignatureFraudOutboxActivationHandshakeOptions
  ) {
    this.now = options.now ?? Date.now
    this.assertSession()
    requireText(options.storeID, "PostgreSQL outbox store ID", 255)
    canonicalBase64(
      options.keyProvider.signerPublicKeySpki,
      "Activation signer public-key SPKI"
    )
  }

  async attestActivationChallenge(
    request: P2TRProductionActivationHandshakeRequest
  ): Promise<
    P2TROutboxProductionSignedHandshake<P2TRProductionOutboxActivationState>
  > {
    this.assertSession()
    const challenge = validateRequest(request)
    const state = await this.readActivationState(challenge)
    const payload = {
      kind: "outbox" as const,
      nonce: challenge.nonce,
      manifestHash: challenge.manifestHash,
      ethereumPoint: challenge.ethereumPoint,
      state,
    }
    const payloadBytes = Buffer.from(canonicalJSON(payload), "utf8")
    const signatureBytes = Buffer.from(
      await this.options.keyProvider.signP2TRActivationPayload(payloadBytes)
    )
    if (signatureBytes.length !== 64) {
      throw new Error("Activation handshake Ed25519 signature must be 64 bytes")
    }
    const signerPublicKeySpki = canonicalBase64(
      this.options.keyProvider.signerPublicKeySpki,
      "Activation signer public-key SPKI"
    )
    let publicKey
    try {
      publicKey = createPublicKey({
        key: Buffer.from(signerPublicKeySpki, "base64"),
        format: "der",
        type: "spki",
      })
    } catch {
      throw new Error("Activation signer public-key SPKI is invalid DER")
    }
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      !verifySignature(null, payloadBytes, publicKey, signatureBytes)
    ) {
      throw new Error(
        "Activation key provider did not produce a valid Ed25519 payload signature"
      )
    }
    return {
      payload,
      signerPublicKeySpki,
      signature: signatureBytes.toString("base64"),
    }
  }

  private async readActivationState(
    challenge: P2TRProductionActivationHandshakeRequest["challenge"]
  ): Promise<P2TRProductionOutboxActivationState> {
    const session = this.options.session
    const sampledAtUnixMs = requireUnixMilliseconds(
      this.now(),
      "Activation handshake sample time"
    )
    const manifestResult = await session.query<ManifestAndCursorRow>(
      `SELECT current_setting('transaction_isolation') AS transaction_isolation,
              m.activation_sequence,
              encode(m.manifest_hash, 'hex') AS manifest_hash,
              m.payload #>> '{outbox,maxActiveOutboxRecords}'
                AS max_active_outbox_records,
              c.current_block_number,
              encode(c.current_block_hash, 'hex') AS current_block_hash
         FROM p2tr_watchtower_activation_manifest m
         JOIN p2tr_ethereum_cursor c ON c.singleton = true
        WHERE m.singleton = true
        FOR SHARE OF m, c`
    )
    if (manifestResult.rows.length !== 1) {
      throw new Error(
        "PostgreSQL activation manifest and Ethereum cursor must be singletons"
      )
    }
    const manifest = manifestResult.rows[0]
    if (manifest.transaction_isolation !== "serializable") {
      throw new Error(
        "Outbox activation handshake requires the coordinator's SERIALIZABLE transaction"
      )
    }
    const manifestHash = bytes32FromDatabase(
      manifest.manifest_hash,
      "PostgreSQL activation manifest hash"
    )
    const ethereumPoint = {
      blockNumber: databaseSafeInteger(
        manifest.current_block_number,
        "PostgreSQL Ethereum cursor block number"
      ),
      blockHash: bytes32FromDatabase(
        manifest.current_block_hash,
        "PostgreSQL Ethereum cursor block hash"
      ),
    }
    if (
      manifestHash !== challenge.manifestHash ||
      ethereumPoint.blockNumber !== challenge.ethereumPoint.blockNumber ||
      ethereumPoint.blockHash !== challenge.ethereumPoint.blockHash
    ) {
      throw new Error(
        "Activation handshake challenge is not pinned to the current PostgreSQL manifest and Ethereum point"
      )
    }

    const readiness = await this.options.readCurrentReadinessCertificate(
      session,
      challenge
    )
    const currentReadinessCertificate = validateReadinessCertificate(
      readiness,
      challenge
    )

    const [
      schemaVersionResult,
      statusResult,
      oldManifestResult,
      leaseResult,
      pendingReleaseResult,
      ambiguousReleaseResult,
      alertResult,
      incidentResult,
      guardResult,
      laneResult,
      danglingGuardResult,
      historyResult,
      capacityCounterResult,
      nonceAllocatorBarrierResult,
      catalogResult,
    ] = await Promise.all([
      session.query<{ version: string | number }>(
        `SELECT version
           FROM p2tr_watchtower_schema_version
          WHERE component = 'signature-fraud-challenge-outbox'
          FOR SHARE`
      ),
      session.query<StatusCountRow>(
        `SELECT status, count(*)::bigint AS count
           FROM p2tr_signature_fraud_challenge_outbox
          GROUP BY status
          ORDER BY status`
      ),
      session.query<CountRow>(
        `SELECT count(*)::bigint AS count
           FROM p2tr_signature_fraud_challenge_outbox
          WHERE activation_manifest_hash <> decode($1, 'hex')
            AND status <> ALL($2::text[])`,
        [strip0x(challenge.manifestHash), TERMINAL_STATUSES]
      ),
      session.query<CountRow>(
        `SELECT count(*)::bigint AS count
           FROM p2tr_signature_fraud_challenge_outbox
          WHERE status = 'preparing'
            AND preparation_lease_expires_at_unix_ms <= $1`,
        [sampledAtUnixMs]
      ),
      session.query<DigestRow>(
        `SELECT encode(r.release_request_id, 'hex') AS id,
                encode(sha256(
                  r.record_id || r.nonce_guard_id || r.void_evidence_digest
                ), 'hex') AS details_digest
           FROM p2tr_signature_fraud_challenge_nonce_release_request r
          WHERE NOT EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_nonce_release_terminal x
                 WHERE x.release_request_id = r.release_request_id
          )
          ORDER BY r.release_request_id`
      ),
      session.query<DigestRow>(
        `SELECT encode(r.release_request_id, 'hex') AS id,
                encode(sha256(
                  r.record_id || r.nonce_guard_id ||
                  COALESCE(latest.response_digest, r.void_evidence_digest)
                ), 'hex') AS details_digest
           FROM p2tr_signature_fraud_challenge_nonce_release_request r
           JOIN LATERAL (
             SELECT a.attempt_sequence, x.result_kind, x.response_digest
               FROM p2tr_signature_fraud_challenge_nonce_release_attempt a
               LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_result x
                 ON x.release_request_id = a.release_request_id
                AND x.attempt_sequence = a.attempt_sequence
              WHERE a.release_request_id = r.release_request_id
              ORDER BY a.attempt_sequence DESC
              LIMIT 1
           ) latest ON true
          WHERE NOT EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_nonce_release_terminal ok
                 WHERE ok.release_request_id = r.release_request_id
          )
            AND (latest.result_kind IS NULL OR latest.result_kind NOT IN (
              'released', 'already-released'
            ))
          ORDER BY r.release_request_id`
      ),
      session.query<DigestRow>(
        `SELECT encode(alert_id, 'hex') AS id,
                encode(details_digest, 'hex') AS details_digest
           FROM p2tr_signature_fraud_challenge_critical_alert
          WHERE activation_blocking
            AND NOT EXISTS (
                  SELECT 1
                    FROM p2tr_signature_fraud_challenge_critical_alert_resolution ar
                   WHERE ar.alert_id = p2tr_signature_fraud_challenge_critical_alert.alert_id
                )
          ORDER BY alert_id`
      ),
      session.query<DigestRow>(
        `SELECT encode(incident_id, 'hex') AS id,
                encode(details_digest, 'hex') AS details_digest
           FROM p2tr_signature_fraud_challenge_provenance_incident
          WHERE activation_blocking
            AND NOT EXISTS (
                  SELECT 1
                    FROM p2tr_signature_fraud_challenge_provenance_incident_resolution ir
                   WHERE ir.incident_id =
                         p2tr_signature_fraud_challenge_provenance_incident.incident_id
                )
          ORDER BY incident_id`
      ),
      session.query<CountRow>(
        `SELECT count(*)::bigint AS count
           FROM p2tr_signature_fraud_challenge_nonce_guard
          WHERE voided_before_sign_at_unix_ms IS NULL`
      ),
      session.query<SignerLaneStateRow>(
        `SELECT c.chain_id::text AS chain_id,
                c.signer_lane_id,
                c.signer_identity,
                encode(c.sender, 'hex') AS sender,
                encode(c.policy_hash, 'hex') AS policy_hash,
                encode(c.signer_code_hash, 'hex') AS signer_code_hash,
                encode(c.configuration_hash, 'hex') AS configuration_hash,
                EXISTS (
                      SELECT 1
                        FROM p2tr_signature_fraud_challenge_signer_quarantine q
                       WHERE q.chain_id = c.chain_id
                         AND (q.signer_lane_id = c.signer_lane_id
                              OR q.signer_identity = c.signer_identity
                              OR q.expected_sender = c.sender)
                    ) AS quarantined
           FROM p2tr_signature_fraud_signer_lane_configuration c
          WHERE c.activation_manifest_hash = decode($1, 'hex')
            AND c.enabled
          ORDER BY c.chain_id, c.signer_lane_id`,
        [strip0x(challenge.manifestHash)]
      ),
      session.query<CountRow>(
        `SELECT count(*)::bigint AS count
           FROM p2tr_signature_fraud_challenge_nonce_guard g
          WHERE g.voided_before_sign_at_unix_ms IS NULL
            AND (
              (g.guard_kind = 'bound-reservation' AND NOT EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_outbox o
                 WHERE o.record_id = g.record_id
                   AND o.nonce_reservation_id = g.nonce_guard_id
                   AND o.chain_id = g.chain_id
                   AND o.reserved_sender = g.sender
                   AND o.reserved_nonce = g.transaction_nonce
                   AND o.signer_lane_id = g.signer_lane_id
                   AND o.signer_identity = g.signer_identity
              ))
              OR
              (g.guard_kind = 'escaped-envelope' AND NOT EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_escaped_envelope e
                 WHERE e.actual_guard_record_id = g.record_id
                   AND e.actual_nonce_guard_id = g.nonce_guard_id
              ))
            )`
      ),
      session.query<CountRow>(
        `SELECT count(*)::bigint AS count
           FROM p2tr_signature_fraud_challenge_outbox o
           LEFT JOIN LATERAL (
               SELECT max(h.version) AS version
                 FROM p2tr_signature_fraud_challenge_outbox_state_history h
                WHERE h.record_id = o.record_id
           ) history ON true
          WHERE history.version IS DISTINCT FROM o.version`
      ),
      session.query<CountRow>(
        `SELECT CASE
                  WHEN c.active_generation_count = (
                    SELECT count(*)
                      FROM p2tr_signature_fraud_challenge_outbox o
                     WHERE o.status <> ALL($1::text[])
                  ) THEN 0
                  ELSE 1
                END::bigint AS count
           FROM p2tr_signature_fraud_challenge_outbox_capacity c
          WHERE c.singleton = true`,
        [TERMINAL_STATUSES]
      ),
      // The barrier is keyed per nonce lane, so this audit is a rollup, not a
      // row read. Activation is a whole-service event: it must refuse if ANY
      // lane has outstanding allocator or signer I/O, including a lane whose
      // barrier row is absent entirely. Per-lane equality alone cannot see a
      // missing row — a lane holding a live signer invocation with no barrier
      // row would produce zero failing groups and zero counters, and activation
      // would pass. The whole-store SUM equalities below are what close that:
      // together with per-lane equality they force any lane without a row to
      // account for nothing, which is exactly the completeness the old
      // single-row read got from the singleton.
      session.query<NonceAllocatorBarrierRow>(
        `WITH lane AS (
             SELECT b.active_release_request_id,
                    b.active_signer_invocation_count,
                    b.unresolved_release_count,
                    (
                      SELECT count(*)
                        FROM p2tr_signature_fraud_challenge_outbox o
                       WHERE o.active_signer_invocation_started_at_unix_ms
                             IS NOT NULL
                         AND o.chain_id = b.chain_id
                         AND o.selected_sender = b.sender
                    ) AS observed_signer_count,
                    (
                      SELECT count(*)
                        FROM p2tr_signature_fraud_challenge_nonce_release_request r
                       WHERE r.chain_id = b.chain_id
                         AND r.sender = b.sender
                         AND NOT EXISTS (
                             SELECT 1
                               FROM p2tr_signature_fraud_challenge_nonce_release_terminal x
                              WHERE x.release_request_id = r.release_request_id
                         )
                    ) AS observed_unresolved_count,
                    (
                      (b.active_release_request_id IS NULL
                       AND b.active_release_attempt_sequence IS NULL
                       AND b.active_release_expires_at_unix_ms IS NULL)
                      OR EXISTS (
                          SELECT 1
                            FROM p2tr_signature_fraud_challenge_nonce_release_attempt a
                            JOIN p2tr_signature_fraud_challenge_nonce_release_invocation i
                              ON i.release_request_id = a.release_request_id
                             AND i.attempt_sequence = a.attempt_sequence
                            JOIN p2tr_signature_fraud_challenge_nonce_release_request rr
                              ON rr.release_request_id = a.release_request_id
                           WHERE a.release_request_id = b.active_release_request_id
                             AND a.attempt_sequence = b.active_release_attempt_sequence
                             AND a.expires_at_unix_ms = b.active_release_expires_at_unix_ms
                             AND rr.chain_id = b.chain_id
                             AND rr.sender = b.sender
                             AND NOT EXISTS (
                                 SELECT 1
                                   FROM p2tr_signature_fraud_challenge_nonce_release_result x
                                  WHERE x.release_request_id = a.release_request_id
                                    AND x.attempt_sequence = a.attempt_sequence
                                    AND x.result_kind <> 'ambiguous-error'
                             )
                             AND NOT EXISTS (
                                 SELECT 1
                                   FROM p2tr_signature_fraud_challenge_nonce_release_resolution rx
                                  WHERE rx.release_request_id = a.release_request_id
                                    AND rx.attempt_sequence = a.attempt_sequence
                             )
                      )
                    ) AS claim_is_live
               FROM p2tr_signature_fraud_nonce_allocator_safety_barrier b
         ), rollup AS (
             SELECT count(*) FILTER (
                        WHERE active_release_request_id IS NOT NULL
                    ) AS active_release_attempt_count,
                    COALESCE(sum(active_signer_invocation_count), 0)
                        AS active_signer_invocation_count,
                    COALESCE(sum(unresolved_release_count), 0)
                        AS unresolved_release_count,
                    count(*) FILTER (
                        WHERE observed_signer_count <> active_signer_invocation_count
                           OR observed_unresolved_count <> unresolved_release_count
                           OR NOT claim_is_live
                    ) AS lane_mismatch_count
               FROM lane
         ), truth AS (
             SELECT (
                      SELECT count(*)
                        FROM p2tr_signature_fraud_challenge_outbox o
                       WHERE o.active_signer_invocation_started_at_unix_ms
                             IS NOT NULL
                    ) AS total_signer_count,
                    (
                      SELECT count(*)
                        FROM p2tr_signature_fraud_challenge_nonce_release_request r
                       WHERE NOT EXISTS (
                             SELECT 1
                               FROM p2tr_signature_fraud_challenge_nonce_release_terminal x
                              WHERE x.release_request_id = r.release_request_id
                       )
                    ) AS total_unresolved_count
         ), global AS (
             SELECT contract_mismatch_blocked
               FROM p2tr_signature_fraud_nonce_allocator_global_barrier
              WHERE singleton = true
         )
         SELECT rollup.active_release_attempt_count::bigint
                    AS active_release_attempt_count,
                rollup.active_signer_invocation_count::bigint
                    AS active_signer_invocation_count,
                rollup.unresolved_release_count::bigint
                    AS unresolved_release_count,
                (SELECT contract_mismatch_blocked FROM global)
                    AS contract_mismatch_blocked,
                (
                  rollup.lane_mismatch_count
                  + CASE
                      WHEN rollup.active_signer_invocation_count
                           = truth.total_signer_count THEN 0
                      ELSE 1
                    END
                  + CASE
                      WHEN rollup.unresolved_release_count
                           = truth.total_unresolved_count THEN 0
                      ELSE 1
                    END
                  + CASE
                      WHEN (SELECT contract_mismatch_blocked FROM global)
                           IS NOT DISTINCT FROM (EXISTS (
                             SELECT 1
                               FROM p2tr_signature_fraud_challenge_nonce_release_result x
                              WHERE x.result_kind = 'contract-mismatch'
                             UNION ALL
                             SELECT 1
                               FROM p2tr_signature_fraud_challenge_nonce_release_resolution rx
                              WHERE rx.outcome = 'terminal-unsafe'
                           )) THEN 0
                      ELSE 1
                    END
                  + CASE
                      WHEN (SELECT contract_mismatch_blocked FROM global)
                           IS NOT DISTINCT FROM (EXISTS (
                             SELECT 1
                               FROM p2tr_signature_fraud_challenge_critical_alert a
                              WHERE a.code IN (
                                    'reservation-release-failed',
                                    'nonce-release-terminal-unsafe'
                                )
                                AND NOT EXISTS (
                                    SELECT 1
                                      FROM p2tr_signature_fraud_challenge_critical_alert_resolution ar
                                     WHERE ar.alert_id = a.alert_id
                                )
                           )) THEN 0
                      ELSE 1
                    END
                )::bigint AS mismatch_count
           FROM rollup, truth`
      ),
      session.query<CatalogDefinitionRow>(
        `SELECT 'relation'::text AS object_kind,
                r.relname AS object_name,
                concat_ws('|',
                    'kind=' || r.relkind::text,
                    'persistence=' || r.relpersistence::text,
                    'row_security=' || r.relrowsecurity::text,
                    'force_row_security=' || r.relforcerowsecurity::text
                ) AS definition
           FROM pg_class r
           JOIN pg_namespace n ON n.oid = r.relnamespace
          WHERE n.nspname = current_schema()
            AND r.relname LIKE 'p2tr_signature_fraud_%'
         UNION ALL
         SELECT 'view-definition', r.relname, pg_get_viewdef(r.oid, true)
           FROM pg_class r
           JOIN pg_namespace n ON n.oid = r.relnamespace
          WHERE n.nspname = current_schema()
            AND r.relkind IN ('v', 'm')
            AND r.relname LIKE 'p2tr_signature_fraud_%'
         UNION ALL
         SELECT 'column',
                r.relname || '.' || a.attnum::text || '.' || a.attname,
                concat_ws('|',
                    'type=' || pg_catalog.format_type(a.atttypid, a.atttypmod),
                    'not_null=' || a.attnotnull,
                    'identity=' || a.attidentity::text,
                    'generated=' || a.attgenerated::text,
                    'collation=' || COALESCE(coll.collname, ''),
                    'default=' || COALESCE(
                        pg_get_expr(d.adbin, d.adrelid, true),
                        ''
                    )
                )
           FROM pg_attribute a
           JOIN pg_class r ON r.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = r.relnamespace
           LEFT JOIN pg_attrdef d
             ON d.adrelid = a.attrelid
            AND d.adnum = a.attnum
           LEFT JOIN pg_collation coll ON coll.oid = a.attcollation
          WHERE n.nspname = current_schema()
            AND r.relname LIKE 'p2tr_signature_fraud_%'
            AND a.attnum > 0
            AND NOT a.attisdropped
         UNION ALL
         SELECT 'constraint'::text AS object_kind,
                c.conname AS object_name,
                pg_get_constraintdef(c.oid, true) AS definition
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname LIKE 'p2tr_signature_fraud_%'
         UNION ALL
         SELECT 'index', indexname, indexdef
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename LIKE 'p2tr_signature_fraud_%'
         UNION ALL
         SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid, true)
           FROM pg_trigger t
           JOIN pg_class r ON r.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = r.relnamespace
          WHERE NOT t.tgisinternal
            AND n.nspname = current_schema()
            AND r.relname LIKE 'p2tr_signature_fraud_%'
         UNION ALL
         SELECT 'function', p.proname, pg_get_functiondef(p.oid)
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = current_schema()
            AND p.proname LIKE 'p2tr_signature_fraud_%'
          ORDER BY object_kind, object_name, definition`
      ),
    ])

    if (schemaVersionResult.rows.length !== 1) {
      throw new Error("PostgreSQL outbox schema version is absent or ambiguous")
    }
    const schemaVersion = databaseSafeInteger(
      schemaVersionResult.rows[0].version,
      "PostgreSQL outbox schema version"
    )
    if (schemaVersion !== 1) {
      throw new Error("PostgreSQL outbox schema version is unsupported")
    }

    const statusCounts = Object.fromEntries(
      statusResult.rows.map((row) => [
        requireText(row.status, "PostgreSQL outbox status", 128),
        databaseSafeInteger(row.count, "PostgreSQL outbox status count"),
      ])
    )
    const activeGenerationCount = Object.entries(statusCounts)
      .filter(([status]) => !TERMINAL_STATUSES.includes(status as never))
      .reduce((total, [, count]) => total + count, 0)
    const activeOldManifestGenerationCount = oneCount(
      oldManifestResult,
      "old-manifest outbox generation count"
    )
    const expiredPreparationLeaseCount = oneCount(
      leaseResult,
      "expired outbox lease count"
    )
    const pendingNonceReleaseCount = pendingReleaseResult.rows.length
    const ambiguousNonceReleaseCount = ambiguousReleaseResult.rows.length
    const activationBlockingAlertCount = alertResult.rows.length
    const provenanceIncidentCount = incidentResult.rows.length
    const unresolvedNonceGuardCount = oneCount(
      guardResult,
      "unresolved nonce-guard count"
    )
    const configuredSignerLaneCount = laneResult.rows.length
    const quarantinedSignerLaneCount = laneResult.rows.filter(
      (lane) => lane.quarantined
    ).length
    const healthySignerLanes = laneResult.rows.filter(
      (lane) => !lane.quarantined
    )
    const healthySignerLaneCount = healthySignerLanes.length
    const danglingNonceGuardCount = oneCount(
      danglingGuardResult,
      "dangling nonce-guard count"
    )
    const stateHistoryMismatchCount = oneCount(
      historyResult,
      "outbox state-history mismatch count"
    )
    const capacityCounterMismatchCount = oneCount(
      capacityCounterResult,
      "outbox capacity-counter mismatch count"
    )
    // The rollup always yields one row, so unlike the singleton read this
    // replaced, this guard no longer proves the barrier covers every lane —
    // the SUM equalities inside `mismatch_count` do. It is retained only to
    // reject a shape the query cannot legitimately produce.
    if (nonceAllocatorBarrierResult.rows.length !== 1) {
      throw new Error("PostgreSQL nonce-allocator safety barrier is invalid")
    }
    const nonceAllocatorBarrier = nonceAllocatorBarrierResult.rows[0]
    const activeNonceReleaseAttemptCount = databaseSafeInteger(
      nonceAllocatorBarrier.active_release_attempt_count,
      "active nonce-release attempt count"
    )
    const activeSignerInvocationCount = databaseSafeInteger(
      nonceAllocatorBarrier.active_signer_invocation_count,
      "active signer invocation count"
    )
    const unresolvedReleaseBarrierCount = databaseSafeInteger(
      nonceAllocatorBarrier.unresolved_release_count,
      "unresolved release barrier count"
    )
    const nonceAllocatorContractMismatchBlocked =
      nonceAllocatorBarrier.contract_mismatch_blocked
    if (typeof nonceAllocatorContractMismatchBlocked !== "boolean") {
      throw new Error("PostgreSQL nonce-allocator mismatch barrier is invalid")
    }
    const nonceAllocatorBarrierMismatchCount = databaseSafeInteger(
      nonceAllocatorBarrier.mismatch_count,
      "nonce-allocator barrier mismatch count"
    )
    const recoveryBacklogCount =
      expiredPreparationLeaseCount + pendingNonceReleaseCount

    const reasons: string[] = []
    if (activeOldManifestGenerationCount > 0) {
      reasons.push("active-old-manifest-generation")
    }
    if (recoveryBacklogCount > 0) reasons.push("preparation-recovery-backlog")
    if (pendingNonceReleaseCount > 0) {
      reasons.push("nonce-release-recovery-backlog")
    }
    if (ambiguousNonceReleaseCount > 0) {
      reasons.push("ambiguous-nonce-release-response")
    }
    if (activationBlockingAlertCount > 0) {
      reasons.push("activation-blocking-outbox-alert")
    }
    if (provenanceIncidentCount > 0) {
      reasons.push("provenance-reconciliation-incident")
    }
    if (stateHistoryMismatchCount > 0) {
      reasons.push("outbox-state-history-mismatch")
    }
    const manifestOutboxCapacityConfigured =
      manifest.max_active_outbox_records !== null &&
      /^[1-9][0-9]{0,6}$/.test(manifest.max_active_outbox_records) &&
      Number(manifest.max_active_outbox_records) <= 1_000_000
    if (!manifestOutboxCapacityConfigured) {
      reasons.push("manifest-outbox-capacity-not-configured")
    }
    if (capacityCounterMismatchCount > 0) {
      reasons.push("outbox-capacity-counter-mismatch")
    }
    if (activeNonceReleaseAttemptCount > 0 || activeSignerInvocationCount > 0) {
      reasons.push("nonce-allocator-external-io-active")
    }
    if (nonceAllocatorContractMismatchBlocked) {
      reasons.push("nonce-allocator-contract-mismatch")
    }
    if (
      nonceAllocatorBarrierMismatchCount > 0 ||
      unresolvedReleaseBarrierCount !== pendingNonceReleaseCount
    ) {
      reasons.push("nonce-allocator-barrier-mismatch")
    }
    if (danglingNonceGuardCount > 0) {
      reasons.push("dangling-unaccounted-nonce-guard")
    }
    if (configuredSignerLaneCount === 0 || healthySignerLaneCount === 0) {
      reasons.push("no-healthy-manifest-bound-signer-lane")
    }

    return {
      storeID: requireText(
        this.options.storeID,
        "PostgreSQL outbox store ID",
        255
      ),
      schemaVersion,
      schemaConstraintHash: sha256Canonical(catalogResult.rows),
      manifestActivationSequence: databaseSafeInteger(
        manifest.activation_sequence,
        "PostgreSQL manifest activation sequence"
      ),
      manifestOutboxCapacityConfigured,
      currentReadinessCertificate,
      statusCounts,
      activeGenerationCount,
      activeOldManifestGenerationCount,
      expiredPreparationLeaseCount,
      pendingNonceReleaseCount,
      pendingNonceReleaseSetHash: sha256Canonical(pendingReleaseResult.rows),
      ambiguousNonceReleaseCount,
      ambiguousNonceReleaseSetHash: sha256Canonical(
        ambiguousReleaseResult.rows
      ),
      recoveryBacklogCount,
      activationBlockingAlertCount,
      activationBlockingAlertSetHash: sha256Canonical(alertResult.rows),
      provenanceIncidentCount,
      provenanceIncidentSetHash: sha256Canonical(incidentResult.rows),
      unresolvedNonceGuardCount,
      danglingNonceGuardCount,
      configuredSignerLaneCount,
      configuredSignerLaneSetHash: sha256Canonical(laneResult.rows),
      quarantinedSignerLaneCount,
      healthySignerLaneCount,
      healthySignerLaneSetHash: sha256Canonical(healthySignerLanes),
      stateHistoryMismatchCount,
      capacityCounterMismatchCount,
      activeNonceReleaseAttemptCount,
      activeSignerInvocationCount,
      unresolvedReleaseBarrierCount,
      nonceAllocatorContractMismatchBlocked,
      nonceAllocatorBarrierMismatchCount,
      activationBlocked: reasons.length > 0,
      activationBlockingReasons: reasons,
      sampledAtUnixMs,
    }
  }

  private assertSession(): void {
    this.options.assertTransactionSession(this.options.session)
  }
}

export const canonicalP2TRProductionActivationJSON = canonicalJSON

function validateRequest(
  request: P2TRProductionActivationHandshakeRequest
): P2TRProductionActivationHandshakeRequest["challenge"] {
  if (
    request === undefined ||
    typeof request !== "object" ||
    request.schema !== P2TR_PRODUCTION_ACTIVATION_HANDSHAKE_SCHEMA ||
    request.challenge === undefined ||
    typeof request.challenge !== "object"
  ) {
    throw new Error("Activation handshake request schema is invalid")
  }
  return {
    nonce: bytes32(request.challenge.nonce, "Activation challenge nonce"),
    manifestHash: bytes32(
      request.challenge.manifestHash,
      "Activation challenge manifest hash"
    ),
    ethereumPoint: {
      blockNumber: nonNegativeSafeInteger(
        request.challenge.ethereumPoint?.blockNumber,
        "Activation challenge Ethereum block number"
      ),
      blockHash: bytes32(
        request.challenge.ethereumPoint?.blockHash,
        "Activation challenge Ethereum block hash"
      ),
    },
  }
}

function validateReadinessCertificate(
  certificate: P2TROutboxCurrentReadinessCertificate,
  challenge: P2TRProductionActivationHandshakeRequest["challenge"]
): P2TROutboxCurrentReadinessCertificate {
  if (certificate === undefined || typeof certificate !== "object") {
    throw new Error("Current canonical readiness certificate is absent")
  }
  const normalized = {
    certificateID: bytes32(
      certificate.certificateID,
      "Current readiness certificate ID"
    ),
    certificateGeneration: positiveSafeInteger(
      certificate.certificateGeneration,
      "Current readiness certificate generation"
    ),
    manifestHash: bytes32(
      certificate.manifestHash,
      "Current readiness manifest hash"
    ),
    ethereumPoint: {
      blockNumber: nonNegativeSafeInteger(
        certificate.ethereumPoint?.blockNumber,
        "Current readiness Ethereum block number"
      ),
      blockHash: bytes32(
        certificate.ethereumPoint?.blockHash,
        "Current readiness Ethereum block hash"
      ),
    },
  }
  if (
    normalized.manifestHash !== challenge.manifestHash ||
    normalized.ethereumPoint.blockNumber !==
      challenge.ethereumPoint.blockNumber ||
    normalized.ethereumPoint.blockHash !== challenge.ethereumPoint.blockHash
  ) {
    throw new Error(
      "Current readiness certificate is not bound to the challenged manifest and Ethereum point"
    )
  }
  return normalized
}

function oneCount(
  result: P2TRPostgresQueryResult<CountRow>,
  label: string
): number {
  if (result.rows.length !== 1)
    throw new Error(`PostgreSQL ${label} is invalid`)
  return databaseSafeInteger(result.rows[0].count, `PostgreSQL ${label}`)
}

function sha256Canonical(value: unknown): string {
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
    if (!Number.isSafeInteger(value)) {
      throw new Error("Activation payload numbers must be safe integers")
    }
    return String(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)
    )
    if (entries.some(([, entry]) => entry === undefined)) {
      throw new Error("Activation payload cannot contain undefined values")
    }
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJSON(entry)}`)
      .join(",")}}`
  }
  throw new Error("Activation payload contains a non-canonical value")
}

function canonicalBase64(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be canonical base64`)
  }
  const decoded = Buffer.from(value, "base64")
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64`)
  }
  return value
}

function bytes32(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be 32-byte hexadecimal data`)
  }
  return value.toLowerCase()
}

function bytes32FromDatabase(value: string, label: string): string {
  return bytes32(`0x${value}`, label)
}

function strip0x(value: string): string {
  return value.slice(2)
}

function databaseSafeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return nonNegativeSafeInteger(parsed, label)
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function positiveSafeInteger(value: unknown, label: string): number {
  const normalized = nonNegativeSafeInteger(value, label)
  if (normalized === 0) throw new Error(`${label} must be positive`)
  return normalized
}

function requireUnixMilliseconds(value: unknown, label: string): number {
  const normalized = nonNegativeSafeInteger(value, label)
  if (normalized > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} is out of range`)
  }
  return normalized
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(
      `${label} must contain between 1 and ${maxLength} characters`
    )
  }
  return value
}
