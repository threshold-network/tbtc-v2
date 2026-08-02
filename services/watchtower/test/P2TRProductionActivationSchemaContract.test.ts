import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const activationStore = readFileSync(
  new URL("../src/PostgresP2TRProductionActivationStore.ts", import.meta.url),
  "utf8"
)
const activationGate = readFileSync(
  new URL("../src/P2TRProductionActivation.ts", import.meta.url),
  "utf8"
)
const activationRuntime = readFileSync(
  new URL("../src/P2TRProductionActivationRuntime.ts", import.meta.url),
  "utf8"
)
const transactionCoordinator = readFileSync(
  new URL("../src/PostgresP2TRCanonicalIndexStore.ts", import.meta.url),
  "utf8"
)
const canonicalEthereumMigration = readFileSync(
  new URL("../migrations/002_p2tr_canonical_ethereum.sql", import.meta.url),
  "utf8"
)
const outboxMigration = readFileSync(
  new URL(
    "../migrations/003_p2tr_signature_fraud_challenge_outbox.sql",
    import.meta.url
  ),
  "utf8"
)
const generationAuthorityMigration = readFileSync(
  new URL(
    "../migrations/006_p2tr_candidate_enqueue_generation_authority.sql",
    import.meta.url
  ),
  "utf8"
)
const recoveryHardeningMigration = readFileSync(
  new URL(
    "../migrations/007_p2tr_candidate_enqueue_recovery_hardening.sql",
    import.meta.url
  ),
  "utf8"
)
const challengeSeriesMigration = readFileSync(
  new URL(
    "../migrations/008_p2tr_candidate_enqueue_challenge_series.sql",
    import.meta.url
  ),
  "utf8"
)
const capacityAuthorityMigration = readFileSync(
  new URL(
    "../migrations/009_p2tr_candidate_enqueue_capacity_authority.sql",
    import.meta.url
  ),
  "utf8"
)
const transientRetryMigration = readFileSync(
  new URL(
    "../migrations/010_p2tr_candidate_enqueue_transient_retries.sql",
    import.meta.url
  ),
  "utf8"
)
const manifestRotationDispositionMigration = readFileSync(
  new URL(
    "../migrations/011_p2tr_candidate_enqueue_manifest_rotation_disposition.sql",
    import.meta.url
  ),
  "utf8"
)
const provenanceAlertRetirementMigration = readFileSync(
  new URL(
    "../migrations/012_p2tr_provenance_alert_retirement.sql",
    import.meta.url
  ),
  "utf8"
)

describe("production activation PostgreSQL schema contract", () => {
  it("does not use PostgreSQL's reserved authorization keyword as an alias", () => {
    assert.doesNotMatch(
      activationStore,
      /p2tr_candidate_enqueue_authorizations authorization/
    )
  })

  it("does not retain a duplicate provenance alert after incident retirement", () => {
    assert.match(
      provenanceAlertRetirementMigration,
      /a\.code <> 'provenance-reconciliation-incident'[\s\S]*?pi\.record_id = a\.record_id[\s\S]*?p2tr_signature_fraud_challenge_provenance_incident_resolution/
    )
  })

  it("reads pending and blocking dispositions from candidate observations", () => {
    assert.doesNotMatch(
      activationStore,
      /FROM p2tr_bitcoin_candidates\s+WHERE delivered/
    )
    assert.match(
      activationStore,
      /FROM p2tr_bitcoin_candidate_observations[\s\S]*?'keypath_pending'[\s\S]*?'malformed_blocking'[\s\S]*?'ambiguous_blocking'/
    )
  })

  it("populates every required candidate-authorization column", () => {
    const table = requiredTableColumns(
      canonicalEthereumMigration,
      "p2tr_candidate_enqueue_authorizations"
    )
    const inserted = insertedColumns(
      activationStore,
      "p2tr_candidate_enqueue_authorizations"
    )
    assert.deepEqual(
      table.filter((column) => !inserted.includes(column)),
      [],
      "candidate authorization INSERT omits required schema columns"
    )
    assert.match(
      activationStore,
      /JOIN p2tr_bitcoin_candidate_observations observation/
    )
    assert.match(
      activationStore,
      /JOIN p2tr_bitcoin_candidate_ethereum_provenance provenance/
    )
    assert.match(
      activationStore,
      /JOIN p2tr_readiness_certificates certificate/
    )
    assert.match(
      activationStore,
      /certificate\.certificate_id = \$17[\s\S]*?certificate\.certificate_generation = \$18/
    )
    assert.match(
      activationStore,
      /certified_generation\.generation_id = \([\s\S]*?SELECT max\(generation_id\)/
    )
    assert.match(
      activationStore,
      /observation\.input_index = \$14[\s\S]*?observation\.occurrence_id = \$15[\s\S]*?observation\.challenge_identity = \$16/
    )
    assert.match(
      activationStore,
      /provenance\.source_event_id ~\*[\s\S]*?'\^\(0x\)\?\[0-9a-f\]\{64\}\$'/
    )
    assert.match(
      activationStore,
      /p2tr_candidate_enqueue_expected_authority\([\s\S]*?generation_authority_version[\s\S]*?expected_outbox_series_id[\s\S]*?expected_outbox_generation[\s\S]*?expected_outbox_disposition/
    )
    assert.doesNotMatch(
      activationStore,
      /WHERE candidate_digest = \$3 AND consumed_at IS NOT NULL/
    )
    assert.match(
      generationAuthorityMigration,
      /DROP INDEX p2tr_candidate_enqueue_authorizations_candidate_consumed_idx/
    )
  })

  it("keeps occurrence provenance separate from the SDK challenge-series identity", () => {
    assert.match(
      activationStore,
      /outbox\.observation_id =\s*p2tr_candidate_enqueue_authorizations\.challenge_key[\s\S]*?outbox\.bridge_challenge_key =\s*p2tr_candidate_enqueue_authorizations\.challenge_key/
    )
    assert.match(
      challengeSeriesMigration,
      /'\,"observationID\":' \|\|[\s\S]*?encode\(challenge_key_value, 'hex'\)/
    )
    assert.match(
      capacityAuthorityMigration,
      /'\,"observationID\":' \|\|[\s\S]*?encode\(challenge_key_value, 'hex'\)/
    )
    assert.match(
      capacityAuthorityMigration,
      /outbox\.observation_id = challenge_key_value[\s\S]*?outbox\.bridge_challenge_key = challenge_key_value/
    )
    assert.match(
      capacityAuthorityMigration,
      /authz\.challenge_key = NEW\.observation_id[\s\S]*?authz\.challenge_key = NEW\.bridge_challenge_key/
    )
  })

  it("persists exhaustion for bounded contention and statement timeouts", () => {
    assert.match(
      transientRetryMigration,
      /last_sqlstate IN \('40001', '40P01', '55P03', '57014'\)/
    )
    assert.match(transactionCoordinator, /code === "55P03"/)
    assert.match(transactionCoordinator, /code === "57014"/)
  })

  it("retries confirmed pre-COMMIT aborts while arming the guard", () => {
    const armWithRetry = methodSource(
      activationGate,
      "armCandidateEnqueueTransactionGuardWithRetry",
      "runCandidateEnqueueTransactionWithRetry"
    )
    assert.match(
      armWithRetry,
      /isP2TRSignatureFraudWatchtowerTransactionConfirmedPreCommitTransportAbort[\s\S]*?attemptCount < this\.candidateEnqueueTransactionMaxAttempts[\s\S]*?continue/
    )
  })

  it("terminalizes stale-manifest guards during and after rotation", () => {
    assert.match(
      manifestRotationDispositionMigration,
      /CREATE TABLE p2tr_candidate_enqueue_manifest_rotation_disposition/
    )
    assert.match(
      manifestRotationDispositionMigration,
      /INSERT INTO p2tr_candidate_enqueue_non_retryable_failure[\s\S]*?INSERT INTO p2tr_candidate_enqueue_manifest_rotation_disposition/
    )
    assert.match(
      manifestRotationDispositionMigration,
      /FOR stale_manifest_hash IN[\s\S]*?p2tr_candidate_enqueue_dispose_stale_manifest_guards/
    )
    assert.match(
      manifestRotationDispositionMigration,
      /AFTER UPDATE ON p2tr_watchtower_activation_manifest/
    )
  })

  it("preserves expired authority owned by an unresolved enqueue guard", () => {
    assert.match(
      activationStore,
      /UPDATE p2tr_candidate_enqueue_authorizations[\s\S]*?expires_at <= clock_timestamp\(\)[\s\S]*?FROM p2tr_candidate_enqueue_transaction_guard guard_row[\s\S]*?p2tr_candidate_enqueue_transaction_resolution resolution[\s\S]*?p2tr_candidate_enqueue_retry_exhaustion_alert alert[\s\S]*?p2tr_candidate_enqueue_non_retryable_failure failure/
    )
  })

  it("mints a schema-complete readiness certificate under the snapshot lock", () => {
    const table = requiredTableColumns(
      canonicalEthereumMigration,
      "p2tr_readiness_certificates"
    )
    const inserted = insertedColumns(
      activationStore,
      "p2tr_readiness_certificates"
    )
    assert.deepEqual(
      table.filter((column) => !inserted.includes(column)),
      [],
      "readiness certificate INSERT omits required schema columns"
    )
    assert.match(
      activationStore,
      /pg_advisory_xact_lock\(hashtextextended\('p2tr-readiness-snapshot'/
    )
    assert.match(
      activationStore,
      /UPDATE p2tr_readiness_certificate_generation[\s\S]*?RETURNING next_generation - 1/
    )
    const lock = activationGate.indexOf("lockReadinessSnapshot()")
    const health = activationGate.indexOf("readBitcoinIndexHealth()", lock)
    const mint = activationGate.indexOf("mintReadinessCertificate({", health)
    assert.ok(lock >= 0 && health > lock && mint > health)
    const readinessMethod = methodSource(
      activationGate,
      "assertReadyUnderAuthority",
      "assertCandidateReconciled"
    )
    assert.match(readinessMethod, /readinessFence: "exclusive"/)
    const sessionFence = transactionCoordinator.indexOf(
      "SELECT pg_advisory_lock_shared"
    )
    const lockTimeoutSetup = transactionCoordinator.indexOf(
      "set_config('lock_timeout'"
    )
    const transactionBegin = transactionCoordinator.indexOf(
      'client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")',
      sessionFence
    )
    assert.ok(
      lockTimeoutSetup >= 0 &&
        sessionFence > lockTimeoutSetup &&
        transactionBegin > sessionFence,
      "readiness writer fence must be acquired before the SERIALIZABLE transaction"
    )
    const mintMethod = methodSource(
      activationStore,
      "mintReadinessCertificate",
      "readBitcoinIndexHealth"
    )
    assert.match(mintMethod, /await this\.lockReadinessSnapshot\(\)/)
    assert.match(
      mintMethod,
      /p2tr_candidate_enqueue_authorizations[\s\S]*?consumed_at IS NULL[\s\S]*?invalidated_at IS NULL[\s\S]*?expires_at > clock_timestamp\(\)/
    )
    assert.ok(
      mintMethod.indexOf("live_authorization_count") <
        mintMethod.indexOf("UPDATE p2tr_readiness_certificate_generation"),
      "live authorization check must precede certificate replacement"
    )
    assert.match(
      mintMethod,
      /p2tr_signature_fraud_outbox_activation_revalidation\([\s\S]*?clock_timestamp\(\)[\s\S]*?recovery_backlog_count <= \$16/
    )
    assert.match(
      mintMethod,
      /manifest\.payload #>> '\{outbox,maxRecoveryBacklog\}'[\s\S]*?snapshot\.outboxMaxRecoveryBacklog/
    )
    const issueMethod = methodSource(
      activationStore,
      "issueCandidateAuthorization",
      "lockCandidateAuthorization"
    )
    assert.match(issueMethod, /await this\.lockReadinessSnapshot\(\)/)
  })

  it("revalidates the exact manifest-bound signer-lane set", () => {
    assert.match(
      outboxMigration,
      /configured_signer_lane_count bigint[\s\S]*?configured_signer_lane_set_hash text/
    )
    assert.match(
      outboxMigration,
      /string_agg\([\s\S]*?c\.configuration_hash[\s\S]*?ORDER BY c\.configuration_hash/
    )
    assert.match(
      activationGate,
      /revalidation\.configuredSignerLaneCount[\s\S]*?signed\.configuredSignerLaneCount[\s\S]*?revalidation\.configuredSignerLaneSetHash[\s\S]*?signed\.configuredSignerLaneSetHash/
    )
  })

  it("declares and validates the database-enforced outbox capacity", () => {
    assert.match(activationGate, /maxActiveOutboxRecords: number/)
    assert.match(
      activationGate,
      /positiveInteger\(\s*outbox\.maxActiveOutboxRecords,[\s\S]*?maxActiveOutboxRecords > 1_000_000/
    )
    assert.match(
      outboxMigration,
      /payload #>> '\{outbox,maxActiveOutboxRecords\}'/
    )
    assert.doesNotMatch(
      activationGate,
      /actual\.activeGenerationCount[\s\S]*?>= expected\.maxActiveOutboxRecords/
    )
    assert.doesNotMatch(
      activationGate,
      /revalidation\.activeGenerationCount[\s\S]*?signed\.activeGenerationCount/
    )
  })

  it("keeps armed enqueue capacity reserved after authorization expiry", () => {
    const runtimeAlerts = methodSource(
      activationStore,
      "readRuntimeAlertHealth",
      "readEthereumJournalHealth"
    )
    const armGuard = methodSource(
      activationStore,
      "armCandidateEnqueueTransactionGuard",
      "resolveCandidateEnqueueTransactionGuard"
    )
    assert.match(
      runtimeAlerts,
      /JOIN p2tr_candidate_enqueue_authorizations authz/
    )
    assert.doesNotMatch(
      runtimeAlerts,
      /authz\.expires_at > clock_timestamp\(\)/
    )
    assert.match(armGuard, /JOIN p2tr_candidate_enqueue_authorizations authz/)
    assert.match(
      armGuard,
      /authz\.consumed_at IS NULL[\s\S]*?authz\.invalidated_at IS NULL[\s\S]*?authz\.expires_at > clock_timestamp\(\)/
    )
    assert.match(
      armGuard,
      /JOIN p2tr_watchtower_activation_manifest current_manifest[\s\S]*?current_manifest\.manifest_hash = guard_row\.manifest_hash/
    )
  })

  it("backfills expired guarded authority and resolves reviewed retry alerts", () => {
    assert.match(
      recoveryHardeningMigration,
      /JOIN p2tr_candidate_enqueue_transaction_guard guard_row/
    )
    assert.doesNotMatch(
      recoveryHardeningMigration,
      /authz\.expires_at > clock_timestamp\(\)/
    )
    assert.match(
      recoveryHardeningMigration,
      /CREATE TABLE p2tr_candidate_enqueue_retry_exhaustion_resolution/
    )
    const runtimeAlerts = methodSource(
      activationStore,
      "readRuntimeAlertHealth",
      "readEthereumJournalHealth"
    )
    assert.match(
      runtimeAlerts,
      /p2tr_candidate_enqueue_retry_exhaustion_resolution resolution/
    )
    assert.doesNotMatch(
      runtimeAlerts,
      /alert\.manifest_hash = manifest\.manifest_hash/
    )
    const resolution = methodSource(
      activationStore,
      "resolveCandidateEnqueueRetryExhaustionAlert",
      "saveCandidateEnqueueNonRetryableFailure"
    )
    assert.match(
      resolution,
      /INSERT INTO p2tr_candidate_enqueue_retry_exhaustion_resolution/
    )
    assert.doesNotMatch(resolution, /assertCurrentActivationManifest/)
  })

  it("revalidates durable candidate authority without steady-state dispatcher gates", () => {
    const lock = methodSource(
      activationStore,
      "lockCandidateAuthorization",
      "consumeCandidateAuthorization"
    )
    const consume = methodSource(
      activationStore,
      "consumeCandidateAuthorization",
      "armCandidateEnqueueTransactionGuard"
    )
    assert.match(
      lock,
      /JOIN p2tr_candidate_enqueue_transaction_guard guard_row[\s\S]*?guard_row\.manifest_hash = authz\.manifest_hash[\s\S]*?guard_row\.token_id = authz\.token_id[\s\S]*?guard_row\.candidate_digest = authz\.candidate_digest/
    )
    assert.doesNotMatch(lock, /expires_at > clock_timestamp\(\)/)
    assert.match(
      lock,
      /NOT EXISTS \([\s\S]*?p2tr_candidate_enqueue_transaction_resolution[\s\S]*?NOT EXISTS \([\s\S]*?p2tr_candidate_enqueue_retry_exhaustion_alert[\s\S]*?NOT EXISTS \([\s\S]*?p2tr_candidate_enqueue_non_retryable_failure/
    )
    assert.match(
      consume,
      /EXISTS \([\s\S]*?p2tr_candidate_enqueue_transaction_guard guard_row[\s\S]*?guard_row\.candidate_digest =\s+p2tr_candidate_enqueue_authorizations\.candidate_digest/
    )
    assert.doesNotMatch(consume, /expires_at > clock_timestamp\(\)/)
    assert.match(
      lock,
      /JOIN p2tr_readiness_certificates certificate[\s\S]*?certificate\.certificate_id =\s+authz\.readiness_certificate_id[\s\S]*?certificate\.certificate_generation =\s+authz\.readiness_certificate_generation/
    )
    assert.match(
      lock,
      /certificate\.bitcoin_height =\s+authz\.verified_bitcoin_height[\s\S]*?certificate\.bitcoin_hash =\s+authz\.verified_bitcoin_hash[\s\S]*?certificate\.ethereum_block_number =\s+authz\.verified_ethereum_block[\s\S]*?certificate\.ethereum_block_hash =\s+authz\.verified_ethereum_hash/
    )
    assert.match(
      lock,
      /JOIN p2tr_canonical_generations certified_generation[\s\S]*?certificate\.primary_bitcoin_root[\s\S]*?certificate\.primary_bitcoin_semantic_root/
    )
    assert.match(
      lock,
      /JOIN p2tr_bitcoin_cursor certified_bitcoin[\s\S]*?JOIN p2tr_ethereum_cursor certified_ethereum[\s\S]*?certificate\.ethereum_history_root/
    )
    assert.match(
      lock,
      /certified_generation\.generation_id = \([\s\S]*?SELECT max\(generation_id\)/
    )
    assert.match(
      lock,
      /p2tr_signature_fraud_outbox_activation_revalidation\([\s\S]*?activation_blocking_critical_alert_count = 0[\s\S]*?ambiguous_transaction_count = 0[\s\S]*?unresolved_legacy_quarantine_count = 0[\s\S]*?configured_signer_lane_count =[\s\S]*?configured_signer_lane_set_hash =/
    )
    assert.doesNotMatch(
      lock,
      /outbox_health\.(?:recovery_backlog_count|active_generation_count|quarantined_signer_lane_count|active_old_manifest_generation_count|stale_manifest_generation_successor_count|active_signer_invocation_count|active_nonce_release_attempt_count)/
    )
    const enqueue = methodSource(
      activationGate,
      "runCandidateEnqueueTransactionWithRetry",
      "readVerifiedEthereum"
    )
    assert.match(enqueue, /readinessFence: "exclusive"/)
    const issuance = methodSource(
      activationGate,
      "assertCandidateReconciledUnderAuthority",
      "consumeCandidateAuthorization"
    )
    assert.match(issuance, /issueCandidateAuthorization\(receipt\)/)
    assert.match(issuance, /readinessFence: "exclusive"/)
    assert.doesNotMatch(lock, /JOIN p2tr_bitcoin_blocks bitcoin_block\b/)
    assert.doesNotMatch(lock, /JOIN p2tr_ethereum_blocks ethereum_block\b/)
  })

  it("recovers armed candidate guards before startup readiness", () => {
    const recovery = methodSource(
      activationStore,
      "listUnresolvedCandidateEnqueueTransactionGuards",
      "resolveCandidateEnqueueTransactionGuard"
    )
    assert.match(
      recovery,
      /FROM p2tr_candidate_enqueue_transaction_guard guard_row[\s\S]*?JOIN p2tr_candidate_enqueue_authorizations authz/
    )
    assert.match(recovery, /ORDER BY guard_row\.token_id/)
    const runtimeHealth = methodSource(
      activationStore,
      "readRuntimeAlertHealth",
      "readEthereumJournalHealth"
    )
    assert.match(
      runtimeHealth,
      /FROM p2tr_candidate_enqueue_transaction_guard guard_row[\s\S]*?JOIN p2tr_candidate_enqueue_authorizations authz/
    )
    assert.doesNotMatch(
      runtimeHealth,
      /guard_row\.manifest_hash = manifest\.manifest_hash/
    )
    assert.match(
      activationRuntime,
      /await gate\.recoverCandidateEnqueueTransactionGuards\(\)[\s\S]*?await gate\.assertReady\(\)/
    )
  })

  it("binds independently verified history at the local Ethereum cursor", () => {
    const readiness = methodSource(
      activationGate,
      "assertReadyUnderAuthority",
      "assertCandidateReconciled"
    )
    assert.match(
      readiness,
      /readVerifiedEthereumHistory\(\s*ethereumHealth\.current,\s*ethereum\s*\)/
    )
    assert.match(
      readiness,
      /assertP2TRProductionEthereumJournalHealth\([\s\S]*?verifiedEthereumJournalHistory[\s\S]*?mintReadinessCertificate\([\s\S]*?verifiedEthereumJournalHistory/
    )
    const verification = methodSource(
      activationGate,
      "readVerifiedEthereumHistory",
      "readVerifiedBitcoin"
    )
    assert.match(
      verification,
      /ethereumSource\.getBlockHash[\s\S]*?ethereumVerifier\.getBlockHash[\s\S]*?ethereumSource\.readHistoryState[\s\S]*?ethereumVerifier\.readHistoryState/
    )
    const historyRead = verification.indexOf(
      "ethereumVerifier.readHistoryState"
    )
    const canonicalRecheck = verification.indexOf(
      "assertVerifiedEthereumPointCanonical(canonicalPoint)",
      historyRead
    )
    assert.ok(historyRead >= 0 && canonicalRecheck > historyRead)
  })
})

function requiredTableColumns(source: string, table: string): string[] {
  const match = source.match(
    new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`)
  )
  assert.ok(match, `${table} schema is absent`)
  return match[1].split("\n").flatMap((line) => {
    const column = line.match(/^\s+([a-z_]+)\s+.*\bNOT NULL\b/)
    return column !== null && !/\bDEFAULT\b/.test(line) ? [column[1]] : []
  })
}

function insertedColumns(source: string, table: string): string[] {
  const match = source.match(
    new RegExp(`INSERT INTO ${table}\\s*\\(([\\s\\S]*?)\\)\\s*SELECT`)
  )
  assert.ok(match, `${table} INSERT is absent`)
  return match[1]
    .split(",")
    .map((column) => column.trim())
    .filter((column) => /^[a-z_]+$/.test(column))
}

function methodSource(
  source: string,
  method: string,
  followingMethod: string
): string {
  const start = source.indexOf(`async ${method}(`)
  const end = source.indexOf(`async ${followingMethod}(`, start)
  assert.ok(start >= 0 && end > start, `${method} source is absent`)
  return source.slice(start, end)
}
