import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"

const migrationsURL = new URL("../migrations/", import.meta.url)
const migrationURL = new URL(
  "003_p2tr_signature_fraud_challenge_outbox.sql",
  migrationsURL
)
const migrationSource = readFileSync(migrationURL, "utf8")
const migration = migrationSource.replace(/\s+/g, " ")
const lateArtifactMigrationURL = new URL(
  "006_p2tr_signer_boundary_late_artifact.sql",
  migrationsURL
)
const lateArtifactMigrationSource = readFileSync(
  lateArtifactMigrationURL,
  "utf8"
)
const lateArtifactMigration = lateArtifactMigrationSource.replace(/\s+/g, " ")
const nonceFinalityMigrationURL = new URL(
  "007_p2tr_signer_boundary_nonce_finality.sql",
  migrationsURL
)
const nonceFinalityMigrationSource = readFileSync(
  nonceFinalityMigrationURL,
  "utf8"
)
const nonceFinalityMigration = nonceFinalityMigrationSource.replace(/\s+/g, " ")
const exactGasMigrationURL = new URL(
  "008_p2tr_signed_variant_exact_gas.sql",
  migrationsURL
)
const exactGasMigrationSource = readFileSync(exactGasMigrationURL, "utf8")
const exactGasMigration = exactGasMigrationSource.replace(/\s+/g, " ")
const canonicalIndexMigrationSource = readFileSync(
  new URL("001_p2tr_canonical_index.sql", migrationsURL),
  "utf8"
)
const canonicalIndexMigration = canonicalIndexMigrationSource.replace(
  /\s+/g,
  " "
)
const depositBindingByteOrderMigration = readFileSync(
  new URL("005_p2tr_deposit_binding_byte_order.sql", migrationsURL),
  "utf8"
).replace(/\s+/g, " ")
const activationHandshakeSource = readFileSync(
  new URL(
    "../src/PostgresP2TRSignatureFraudOutboxActivationHandshake.ts",
    import.meta.url
  ),
  "utf8"
)

test("leaves transaction ownership to the ordered migration runner", () => {
  const orderedMigrations = readdirSync(migrationsURL)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()

  for (const name of orderedMigrations) {
    assert.doesNotMatch(
      readFileSync(new URL(name, migrationsURL), "utf8"),
      /^\s*(?:BEGIN|COMMIT)\s*;/gim,
      `${name} embeds transaction control`
    )
  }
  assert.match(
    migrationURL.pathname,
    /\/003_p2tr_signature_fraud_challenge_outbox\.sql$/
  )
  const canonicalJournalIndex = orderedMigrations.findIndex((name) =>
    name.startsWith("002_")
  )
  const challengeOutboxIndex = orderedMigrations.indexOf(
    "003_p2tr_signature_fraud_challenge_outbox.sql"
  )
  const lateArtifactIndex = orderedMigrations.indexOf(
    "006_p2tr_signer_boundary_late_artifact.sql"
  )
  const nonceFinalityIndex = orderedMigrations.indexOf(
    "007_p2tr_signer_boundary_nonce_finality.sql"
  )
  assert.notEqual(challengeOutboxIndex, -1)
  assert.notEqual(lateArtifactIndex, -1)
  assert.notEqual(nonceFinalityIndex, -1)
  assert.ok(challengeOutboxIndex < lateArtifactIndex)
  assert.ok(lateArtifactIndex < nonceFinalityIndex)
  if (canonicalJournalIndex !== -1) {
    assert.ok(canonicalJournalIndex < challengeOutboxIndex)
  }
})

test("stores append-only evidence generations linked to an exact predecessor", () => {
  assert.match(
    migration,
    /record_id bytea PRIMARY KEY CHECK \(octet_length\(record_id\) = 32\)/
  )
  assert.match(migration, /UNIQUE \(series_id, generation\)/)
  assert.match(
    migration,
    /series_id bytea NOT NULL CHECK \(octet_length\(series_id\) = 32\)/
  )
  assert.match(migration, /UNIQUE \(previous_record_id\)/)
  assert.match(
    migration,
    /generation integer NOT NULL CHECK \(generation BETWEEN 0 AND 31\)/
  )
  assert.doesNotMatch(
    migration,
    /generation integer NOT NULL DEFAULT 0 CHECK \(generation = 0\)/
  )
  assert.match(migration, /prior_record\.generation \+ 1 <> NEW\.generation/)
  assert.match(migration, /prior_record\.series_id <> NEW\.series_id/)
  assert.match(
    migration,
    /fresh nonce generation lacks independently attested exact disposition/
  )
  assert.match(
    migration,
    /canonical reappearance lacks independently attested reorg evidence/
  )
  assert.match(
    migration,
    /P2TR challenge generation identity and evidence are immutable/
  )
  assert.match(
    migration,
    /BEFORE DELETE ON p2tr_signature_fraud_challenge_outbox/
  )
})

test("stores only compact fixed per-input evidence", () => {
  assert.match(
    migration,
    /canonical_provenance_event_set_hash bytea NOT NULL CHECK/
  )
  assert.match(
    migration,
    /canonical_provenance_event_count bigint NOT NULL CHECK \( canonical_provenance_event_count BETWEEN 1 AND 1000 \)/
  )
  assert.doesNotMatch(migration, /canonical_provenance_event_ids/)
  assert.match(
    migration,
    /calldata bytea NOT NULL CHECK \(octet_length\(calldata\) = 388\)/
  )
  assert.equal(
    (
      migration.match(/octet_length\(raw_transaction\) BETWEEN 1 AND 4096/g) ??
      []
    ).length,
    3
  )
})

test("serializes a manifest-bound global active-record capacity", () => {
  assert.match(migration, /payload #>> '\{outbox,maxActiveOutboxRecords\}'/)
  assert.match(
    migration,
    /p2tr_watchtower_manifest_outbox_capacity_check CHECK .* NOT VALID/
  )
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_outbox_capacity/
  )
  assert.match(
    migration,
    /SET active_generation_count = active_generation_count \+ 1 WHERE singleton = true AND active_generation_count < \(/
  )
  assert.match(
    migration,
    /p2tr_signature_fraud_consume_generation_capacity_trigger AFTER INSERT ON p2tr_signature_fraud_challenge_outbox/
  )
  assert.match(
    migration,
    /SET active_generation_count = active_generation_count - 1/
  )
  assert.match(
    migration,
    /manifest-bound global active outbox capacity is exhausted or missing/
  )
})

test("never expires a resultless allocator invocation by wall clock", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_nonce_release_invocation/
  )
  assert.match(
    migration,
    /nonce-release attempts must be contiguous and cannot replace a resultless invocation/
  )
  assert.match(
    migration,
    /p2tr_signature_fraud_validate_nonce_release_invocation_insert_trigger BEFORE INSERT/
  )
  assert.match(
    migration,
    /WHERE chain_id = lane_chain_id AND sender = lane_sender AND active_release_request_id IS NULL AND active_signer_invocation_count = 0/
  )
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_nonce_release_resolution/
  )
  assert.match(migration, /tbtc-p2tr-nonce-release-independent-resolution-v1/)
  assert.match(
    migration,
    /primary_evidence_digest = resolution_evidence_digest/
  )
  assert.match(
    migration,
    /corroborating_evidence_digest = resolution_evidence_digest/
  )
  assert.match(
    migration,
    /p2tr_signature_fraud_apply_nonce_release_resolution_barrier_trigger AFTER INSERT/
  )
})

test("binds the exact input, funding occurrence, and Ethereum binding point", () => {
  assert.match(
    migration,
    /canonical_input_index bigint NOT NULL CHECK \( canonical_input_index = bitcoin_input_index \)/
  )
  assert.match(
    migration,
    /canonical_funding_block_hash bytea NOT NULL CHECK \( octet_length\(canonical_funding_block_hash\) = 32 \)/
  )
  assert.match(migration, /canonical_funding_txid bytea NOT NULL/)
  assert.match(
    migration,
    /canonical_funding_vout bigint NOT NULL CHECK \( canonical_funding_vout BETWEEN 0 AND 4294967295 \)/
  )
  assert.match(
    migration,
    /canonical_binding_ethereum_block_number bigint NOT NULL CHECK \( canonical_binding_ethereum_block_number >= 0 AND canonical_binding_ethereum_block_number <= canonical_provenance_through_block_number \)/
  )
  assert.match(
    migration,
    /canonical_binding_ethereum_block_hash bytea NOT NULL CHECK \( octet_length\(canonical_binding_ethereum_block_hash\) = 32 \)/
  )
  assert.match(
    migration,
    /prior_record\.canonical_funding_block_hash <> NEW\.canonical_funding_block_hash/
  )
  assert.match(
    migration,
    /NEW\.canonical_binding_ethereum_block_hash, NEW\.canonical_provenance_fingerprint/
  )
})

test("admits only normalized COMPLETE_V2 evidence and its immutable domain", () => {
  assert.match(
    migration,
    /evidence_protocol_id bytea NOT NULL CHECK \( octet_length\(evidence_protocol_id\) = 32 AND evidence_protocol_id = decode\( '12c62b64ecf6d008bcff153495dcdbe7a981f3a9a1b9c0898b86b1e6d0d350ef', 'hex' \) \)/
  )
  assert.match(
    migration,
    /CHECK \(bridge_challenge_key = bridge_challenge_identity\)/
  )
  assert.match(migration, /CHECK \(intent_input_index = bitcoin_input_index\)/)
  assert.match(
    migration,
    /router_protocol_id bytea NOT NULL CHECK \( octet_length\(router_protocol_id\) = 32 AND router_protocol_id = evidence_protocol_id \)/
  )
  assert.match(
    migration,
    /router_domain_chain_id numeric\(78, 0\) NOT NULL CHECK \( router_domain_chain_id = domain_chain_id \)/
  )
  assert.match(
    migration,
    /fraud_challenge_deposit_amount numeric\(78, 0\) NOT NULL CHECK \( fraud_challenge_deposit_amount >= 0 \)/
  )
  assert.match(
    migration,
    /canonicalEthereumEligibility,fraudChallengeDepositAmount[\s\S]*?IS DISTINCT FROM NEW\.fraud_challenge_deposit_amount/
  )
  assert.doesNotMatch(
    migration,
    /router_domain_chain_id = domain_chain_id\s+AND router_domain_chain_id = chain_id/
  )
  assert.match(
    migration,
    /signing_key = wallet_id AND binding_tx_hash = decode\(repeat\('00', 32\), 'hex'\) AND binding_output_index = 0 AND canonical_input_binding_kind = 'registered-wallet-output'/
  )
  assert.match(
    migration,
    /signing_key <> wallet_id AND binding_output_index = canonical_funding_vout AND canonical_input_binding_kind = 'deposit-binding'/
  )
  assert.match(
    migration,
    /UNIQUE \( chain_id, router_address, bridge_challenge_key, observation_id, intent_input_index, bitcoin_tx_hash, bitcoin_wtxid, canonical_candidate_provenance_generation, generation \)/
  )
  assert.match(
    migration,
    /NEW\.generation_cause IN \( 'canonical-reappearance', 'provenance-restored' \)[\s\S]*?\(prior_record\.intent_id = NEW\.intent_id\)[\s\S]*?\(prior_record\.value_wei = NEW\.value_wei\)/
  )
})

test("persists deposit binding hashes in the Bridge's native byte order", () => {
  assert.equal(
    createHash("sha256").update(canonicalIndexMigrationSource).digest("hex"),
    "eb3df79d26d90b9acb59db776aacecb99b26a1788685f15dd4501cd95159c5cf"
  )
  assert.doesNotMatch(canonicalIndexMigration, /p2tr_reverse_bytea/)
  assert.match(
    depositBindingByteOrderMigration,
    /CREATE FUNCTION p2tr_reverse_bytea\(value bytea\)[\s\S]*?ORDER BY byte_index DESC/
  )
  assert.match(canonicalIndexMigration, /binding_tx_hash = local_funding_txid/)
  assert.match(
    depositBindingByteOrderMigration,
    /pg_get_functiondef\( 'p2tr_guard_candidate_input_disposition\(\)'::regprocedure \)[\s\S]*?OLD\.binding_tx_hash IS DISTINCT FROM OLD\.local_funding_txid[\s\S]*?UPDATE p2tr_bitcoin_candidate_observations SET binding_tx_hash = p2tr_reverse_bytea\(local_funding_txid\), disposition_evidence_object_digest = NULL WHERE binding_kind = 'deposit' AND binding_tx_hash IS DISTINCT FROM p2tr_reverse_bytea\(local_funding_txid\)[\s\S]*?EXECUTE original_disposition_guard_definition/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /binding_kind = 'wallet' AND signing_key = wallet_id/
  )
  assert.doesNotMatch(
    depositBindingByteOrderMigration,
    /binding_kind = 'registered-wallet-output' AND signing_key = wallet_id/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /pg_advisory_xact_lock\( hashtextextended\('p2tr-readiness-snapshot', 0\) \)/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /migrated_deposit_count = 0 THEN RETURN; END IF;[\s\S]*?WHERE state = 'committed'[\s\S]*?p2tr_begin_canonical_generation\([\s\S]*?p2tr_seal_canonical_generation\(migration_generation\)/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /binding_tx_hash = p2tr_reverse_bytea\(local_funding_txid\)/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /component = 'canonical-evidence-index' AND version = 3/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /ADD COLUMN legacy_deposit_binding_byte_order boolean NOT NULL DEFAULT false/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /retire_legacy_deposit_binding_trigger AFTER UPDATE[\s\S]*?NEW\.legacy_deposit_binding_byte_order AND NEW\.status = 'queued'/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /status = 'preparing'[\s\S]*?nonce_reservation_id IS NULL[\s\S]*?signer_invocation_started_at_unix_ms IS NULL[\s\S]*?prepared_transaction_hash IS NULL/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /legacy deposit-binding byte-order marker is migration-owned and immutable[\s\S]*?guard_legacy_deposit_binding_marker_trigger BEFORE INSERT OR UPDATE/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /legacy_deposit_binding_byte_order OR canonical_input_binding_kind <> 'deposit-binding' OR binding_tx_hash = p2tr_reverse_bytea\(canonical_funding_txid\) \);/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /INSERT INTO p2tr_signature_fraud_legacy_submission_quarantine[\s\S]*?legacy outbox intent uses display-order deposit binding hash/
  )
  assert.match(
    depositBindingByteOrderMigration,
    /reject_legacy_quarantine_mutation_trigger BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_legacy_submission_quarantine/
  )
})

test("requires a durable bound nonce guard before signer invocation", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_nonce_guard/
  )
  assert.match(
    migration,
    /CREATE UNIQUE INDEX p2tr_signature_fraud_unresolved_nonce_guard_idx/
  )
  assert.match(migration, /WHERE voided_before_sign_at_unix_ms IS NULL/)
  assert.match(
    migration,
    /num_nonnulls\( selected_signer_lane_id, selected_signer_identity, selected_sender \) IN \(0, 3\)/
  )
  assert.match(
    migration,
    /P2TR signer lane must be durably selected before nonce reservation/
  )
  assert.match(
    migration,
    /nonce reservation does not match the durable selected signer lane/
  )
  assert.match(
    migration,
    /num_nonnulls\( nonce_reservation_id, signer_lane_id, signer_identity, reserved_sender, reserved_nonce, nonce_reservation_binding, nonce_reserved_at_unix_ms \) IN \(0, 7\)/
  )
  assert.match(
    migration,
    /selected_signer_lane_id = signer_lane_id AND selected_signer_identity = signer_identity AND selected_sender = reserved_sender/
  )
  assert.match(
    migration,
    /signer_invocation_started_at_unix_ms IS NULL OR \( nonce_reservation_id IS NOT NULL AND signer_invocation_started_at_unix_ms >= nonce_reserved_at_unix_ms \)/
  )
  assert.match(
    migration,
    /active_signer_invocation_started_at_unix_ms IS NULL OR \( nonce_reservation_id IS NOT NULL AND active_signer_invocation_started_at_unix_ms >= nonce_reserved_at_unix_ms \)/
  )
  assert.match(
    migration,
    /P2TR challenge nonce was not durably bound before use/
  )
  assert.match(
    migration,
    /CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_active_lane_idx/
  )
  assert.match(
    migration,
    /CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_active_sender_idx/
  )
  assert.match(
    migration,
    /CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_selected_lane_idx/
  )
  assert.match(
    migration,
    /CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_selected_sender_idx/
  )
  assert.match(
    migration,
    /num_nonnulls\( voided_before_sign_at_unix_ms, void_reason, void_evidence_digest \) IN \(0, 3\)/
  )
  assert.match(migration, /only an unsigned selected reservation can be voided/)
  assert.match(
    migration,
    /contested nonce burn claim lacks its exact pre-I\/O boundary/
  )
  assert.match(
    migration,
    /contested nonce burn claim cannot release its reservation or change identity/
  )
  assert.match(
    migration,
    /signed contested nonce burn lacks its durable pre-I\/O claim/
  )
  assert.match(
    migration,
    /\( \(OLD\.record_state -> 'contestedNonceBurn'\) - 'broadcastAtUnixMs' \) IS DISTINCT FROM \( \(NEW\.record_state -> 'contestedNonceBurn'\) - 'broadcastAtUnixMs' \)/
  )
  assert.match(
    migration,
    /signed contested nonce burn is immutable after its durable append/
  )
  assert.match(
    migration,
    /signed contested nonce burn broadcast acknowledgement is invalid/
  )
  assert.match(migration, /P2TR challenge nonce guards cannot be deleted/)
})

test("stores immutable generation-scoped same-nonce EIP-1559 variants", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_signer_lane_configuration/
  )
  assert.match(
    migration,
    /UNIQUE \(activation_manifest_hash, chain_id, signer_identity\)/
  )
  assert.match(
    migration,
    /signer_code_hash bytea NOT NULL CHECK \(octet_length\(signer_code_hash\) = 32\)/
  )
  assert.match(
    migration,
    /configuration_hash bytea NOT NULL CHECK \( octet_length\(configuration_hash\) = 32/
  )
  assert.match(
    migration,
    /CREATE FUNCTION p2tr_signature_fraud_signer_lane_configuration_hash/
  )
  assert.match(
    migration,
    /configuration_hash = p2tr_signature_fraud_signer_lane_configuration_hash/
  )
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_fee_policy/
  )
  assert.match(
    migration,
    /selected signer lane lacks its manifest-bound fee and value policy/
  )
  assert.match(
    migration,
    /NEW\.gas_limit \* NEW\.max_fee_per_gas > fee_policy\.max_total_fee_wei/
  )
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_outbox_variant/
  )
  assert.match(
    migration,
    /PRIMARY KEY \(record_id, generation, variant_sequence\)/
  )
  assert.match(
    migration,
    /transaction_type smallint NOT NULL CHECK \(transaction_type = 2\)/
  )
  assert.match(
    migration,
    /NEW\.sender <> outbox_record\.reserved_sender OR NEW\.transaction_nonce <> outbox_record\.reserved_nonce/
  )
  assert.match(
    migration,
    /NEW\.sender <> previous_variant\.sender OR NEW\.transaction_nonce <> previous_variant\.transaction_nonce/
  )
  assert.match(
    migration,
    /outbox_record\.active_signer_invocation_started_at_unix_ms IS NOT NULL AND NEW\.signed_at_unix_ms < outbox_record\.active_signer_invocation_started_at_unix_ms/
  )
  assert.match(
    migration,
    /NEW\.max_fee_per_gas <= previous_variant\.max_fee_per_gas OR NEW\.max_priority_fee_per_gas <= previous_variant\.max_priority_fee_per_gas OR NEW\.gas_limit < previous_variant\.gas_limit/
  )
  assert.match(
    migration,
    /BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_outbox_variant/
  )
})

test("records append-only broadcast boundaries per generation and variant", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_outbox_broadcast_attempt/
  )
  assert.match(
    migration,
    /PRIMARY KEY \(record_id, generation, variant_sequence, attempt_number\)/
  )
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_outbox_broadcast_acknowledgement/
  )
  assert.match(
    migration,
    /FOREIGN KEY \(record_id, generation, variant_sequence, returned_transaction_hash\) REFERENCES p2tr_signature_fraud_challenge_outbox_variant\(record_id, generation, variant_sequence, transaction_hash\)/
  )
  assert.match(
    migration,
    /BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_outbox_broadcast_attempt/
  )
})

test("requires structured independently attested cancellation evidence", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_cancellation_evidence/
  )
  assert.match(migration, /conflicting_outpoint_tx_hash bytea/)
  assert.match(migration, /canonical_spend_tx_hash bytea/)
  assert.match(migration, /bridge_proof_transaction_hash bytea/)
  assert.match(migration, /replacement_bitcoin_block_hash bytea/)
  assert.match(migration, /bitcoin_cursor_block_hash bytea NOT NULL/)
  assert.match(migration, /ethereum_cursor_block_hash bytea NOT NULL/)
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_cancellation_attestation/
  )
  assert.match(
    migration,
    /UNIQUE \(cancellation_evidence_id, independence_domain_id\)/
  )
  assert.match(
    migration,
    /SELECT count\(DISTINCT independence_domain_id\) INTO attestation_count FROM p2tr_signature_fraud_challenge_cancellation_attestation/
  )
  assert.match(
    migration,
    /cancellation lacks matching independently attested canonical evidence/
  )
  assert.match(
    migration,
    /BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_cancellation_evidence/
  )
  assert.match(
    migration,
    /status <> 'cancelled-before-broadcast' OR \( cancellation_evidence_id IS NULL AND selected_signer_lane_id IS NULL AND nonce_reservation_id IS NULL AND signer_invocation_started_at_unix_ms IS NULL AND prepared_transaction_hash IS NULL AND broadcast_attempts = 0 AND last_error IS NOT NULL \)/
  )
  assert.match(
    migration,
    /operator cancellation is allowed only from an unsigned queued record/
  )
  assert.match(
    migration,
    /canonical cancellation is allowed only before signer invocation/
  )
  assert.doesNotMatch(migration, /canonical-ineligible/)
})

test("requires exact independently attested disposition before lane release", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_nonce_disposition/
  )
  assert.match(migration, /sender_account_nonce_at_finality numeric/)
  assert.match(migration, /finalized_through_block_hash bytea NOT NULL/)
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_nonce_disposition_attestation/
  )
  assert.match(
    migration,
    /UNIQUE \(nonce_disposition_id, independence_domain_id\)/
  )
  assert.match(
    migration,
    /nonce lane release requires independently attested final disposition/
  )
  assert.match(
    migration,
    /FOREIGN KEY \(previous_record_id, prior_nonce_disposition_id\) REFERENCES p2tr_signature_fraud_challenge_nonce_disposition\(record_id, nonce_disposition_id\)/
  )
  assert.match(migration, /submitted_late_artifact_id bytea CHECK/)
  assert.match(
    migration,
    /FOREIGN KEY \( record_id, generation, submitted_late_artifact_id, transaction_hash \) REFERENCES p2tr_signature_fraud_challenge_late_signed_artifact \( record_id, generation, artifact_id, transaction_hash \) DEFERRABLE INITIALLY DEFERRED/
  )
  assert.match(
    migration,
    /BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_nonce_disposition/
  )
})

test("isolates quarantined signers and protects escaped sender nonces", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_signer_quarantine/
  )
  assert.match(migration, /UNIQUE \(chain_id, signer_lane_id\)/)
  assert.match(migration, /UNIQUE \(chain_id, signer_identity\)/)
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_escaped_envelope/
  )
  assert.match(
    migration,
    /actual_sender <> expected_sender OR actual_nonce <> expected_nonce/
  )
  assert.match(migration, /guard_kind = 'escaped-envelope'/)
  assert.match(
    migration,
    /quarantine_reason IN \('wrong-sender', 'wrong-nonce'\)/
  )
  assert.match(
    migration,
    /BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_escaped_envelope/
  )
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_late_signed_artifact/
  )
  assert.match(migration, /expected_provenance_fingerprint bytea NOT NULL/)
  assert.match(
    migration,
    /late signed artifact does not match its durable signer boundary/
  )
  assert.match(lateArtifactMigration, /outcome = 'nonce-consumed'/)
  assert.match(
    lateArtifactMigration,
    /nonce_reservation_id = NEW\.expected_reservation_id/
  )
  assert.match(
    lateArtifactMigration,
    /CREATE OR REPLACE FUNCTION p2tr_signature_fraud_validate_late_signed_artifact_insert/
  )
  assert.match(
    migration,
    /BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_late_signed_artifact/
  )
})

test("records immutable activation-blocking alerts at bounded ledger caps", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_critical_alert/
  )
  assert.match(
    migration,
    /series_id bytea NOT NULL CHECK \(octet_length\(series_id\) = 32\)/
  )
  for (const code of [
    "generation-cap-exhausted",
    "signed-variant-cap-exhausted",
    "signed-state-quarantined",
    "late-signed-artifact-captured",
    "escaped-signed-envelope-captured",
    "reservation-release-failed",
    "reservation-state-ambiguous",
    "nonce-reservation-cap-exhausted",
    "provenance-reconciliation-incident",
  ]) {
    assert.match(migration, new RegExp(`'${code}'`))
  }
  assert.match(
    migration,
    /activation_blocking boolean NOT NULL CHECK \(activation_blocking\)/
  )
  assert.match(
    migration,
    /CHECK \(code <> 'generation-cap-exhausted' OR generation = 31\)/
  )
  assert.match(
    migration,
    /expected_latest_variant_sequence IS DISTINCT FROM 15/
  )
  assert.match(
    migration,
    /expected_status NOT IN \( 'generation-required', 'cancelled-reorg', 'cancelled-provenance-invalidated' \)/
  )
  assert.match(
    migration,
    /critical alert is not bound to the exact P2TR challenge series/
  )
  assert.match(
    migration,
    /late signer alert requires an immutable signed artifact/
  )
  assert.match(
    migration,
    /reservation release alert requires an immutable allocator contract mismatch/
  )
  assert.match(
    migration,
    /FOREIGN KEY \(record_id, generation, series_id\) REFERENCES p2tr_signature_fraud_challenge_outbox\(record_id, generation, series_id\)/
  )
  assert.match(
    migration,
    /BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_critical_alert/
  )
})

test("serializes nonce-release and signer I/O through a durable barrier", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_nonce_allocator_safety_barrier/
  )
  assert.match(migration, /unresolved_release_count integer NOT NULL DEFAULT 0/)
  assert.match(
    migration,
    /p2tr_signature_fraud_register_pending_nonce_release_trigger AFTER INSERT/
  )
  assert.match(
    migration,
    /active_signer_invocation_count = active_signer_invocation_count \+ 1/
  )
  assert.match(
    migration,
    /active_signer_invocation_count = active_signer_invocation_count - 1/
  )
  assert.match(
    migration,
    /NOT \(OLD\.record_state \? 'contestedNonceBurnClaim'\)[\s\S]*active_signer_invocation_count \+[\s\n]*1/
  )
  assert.match(
    migration,
    /OLD\.record_state \? 'contestedNonceBurnClaim'[\s\S]*active_signer_invocation_count -[\s\n]*1/
  )
  assert.match(
    migration,
    /contested nonce burn claim lacks its signer-I\/O barrier/
  )
  assert.match(
    migration,
    /p2tr_signature_fraud_apply_nonce_release_result_barrier_trigger AFTER INSERT/
  )
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_nonce_allocator_global_barrier/
  )
  // The lane barrier is keyed by the nonce lane -- the sending account -- so
  // one account's outstanding allocator I/O cannot freeze signing on another.
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_nonce_allocator_safety_barrier \( chain_id numeric\(78, 0\) NOT NULL CHECK \(chain_id > 0\), sender bytea NOT NULL CHECK \(octet_length\(sender\) = 20\),/
  )
  assert.match(migration, /PRIMARY KEY \(chain_id, sender\),/)
  // Without this the attempt reference carries no lane and one lane's row
  // could hold another lane's claim.
  assert.match(
    migration,
    /FOREIGN KEY \( chain_id, sender, active_release_request_id \) REFERENCES p2tr_signature_fraud_challenge_nonce_release_request \( chain_id, sender, release_request_id \)/
  )
  // Rows are seeded eagerly, because every gate reads a missing row as
  // fail-closed and the activation rollup needs the row set to be ground truth.
  assert.match(
    migration,
    /p2tr_signature_fraud_seed_nonce_allocator_lane_barrier_trigger AFTER INSERT ON p2tr_signature_fraud_signer_lane_configuration/
  )
  // The decrement must key off OLD: the update that clears the marker can clear
  // the lane selection at the same time.
  assert.match(
    migration,
    /active_signer_invocation_count - 1 WHERE chain_id = OLD.chain_id AND sender = OLD.selected_sender/
  )
  // A contract mismatch condemns the allocator, not one account, so it stays
  // global and blocks every lane.
  assert.match(
    migration,
    /UPDATE p2tr_signature_fraud_nonce_allocator_global_barrier SET contract_mismatch_blocked = true, incident_epoch = incident_epoch \+ 1/
  )
})

test("counts durable burn claims in activation signer-I/O truth", () => {
  assert.match(
    activationHandshakeSource,
    /count\(\*\) FILTER \([\s\S]*o\.record_state[\s\S]*\? 'contestedNonceBurnClaim'/
  )
  assert.match(
    activationHandshakeSource,
    /AS total_signer_count[\s\S]*rollup\.active_signer_invocation_count[\s\S]*truth\.total_signer_count/
  )
  assert.match(
    migration,
    /p2tr_signature_fraud_outbox_activation_revalidation[\s\S]*o\.record_state \? 'contestedNonceBurnClaim'/
  )
})

test("resolves an orphaned signer boundary only on dual-attested evidence", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_signer_boundary_resolution/
  )
  // The pre-production schema keeps the v4-to-v5 upgrade path executable so
  // both fresh databases and already-migrated test databases exercise it.
  assert.match(migration, /tbtc-p2tr-signer-boundary-independent-resolution-v4/)
  assert.doesNotMatch(migration, /nonce_consumption_observed_head/)
  assert.match(
    nonceFinalityMigration,
    /ADD COLUMN nonce_consumption_observed_head_block_number bigint/
  )
  assert.match(
    nonceFinalityMigration,
    /ADD COLUMN nonce_consumption_observed_head_block_hash bytea/
  )
  assert.match(
    nonceFinalityMigration,
    /ADD COLUMN resolution_evidence_version smallint NOT NULL DEFAULT 4/
  )
  assert.match(
    nonceFinalityMigration,
    /ALTER COLUMN resolution_evidence_version SET DEFAULT 5/
  )
  assert.match(
    nonceFinalityMigration,
    /ADD CONSTRAINT p2tr_signer_boundary_evidence_version_v5\s+CHECK \(resolution_evidence_version = 5\) NOT VALID/
  )
  assert.match(
    nonceFinalityMigration,
    /CREATE OR REPLACE FUNCTION p2tr_signature_fraud_guard_signer_boundary_resolution\(\)/
  )
  assert.match(
    nonceFinalityMigration,
    /tbtc-p2tr-signer-boundary-independent-resolution-v5/
  )
  // The deterministic invocation ID is the row identity, so evidence can never
  // speak for a boundary other than the one it names — and unlike the wall-clock
  // tuple it replaced, it cannot drift while the boundary is open.
  assert.match(migration, /PRIMARY KEY \(record_id, signer_invocation_id\)/)
  assert.match(
    migration,
    /signer_invocation_id bytea NOT NULL CHECK \( octet_length\(signer_invocation_id\) = 32 \)/
  )
  // A never-invoked outcome is inexpressible without a provider fencing
  // receipt, enforced by the database as well as by the resolver.
  assert.match(
    migration,
    /CHECK \( \(outcome = 'never-invoked'\) = \(provider_tombstone_receipt IS NOT NULL\) \)/
  )
  assert.match(
    migration,
    /never-invoked resolution requires a provider tombstone/
  )
  // The chain settles this outcome, so the database demands the consumption
  // evidence and checks it names this record's own lane and chain.
  assert.match(
    migration,
    /'never-invoked', 'signed', 'terminal-unsafe', 'nonce-consumed'/
  )
  assert.match(
    migration,
    /CHECK \( \(outcome = 'nonce-consumed'\) = \(nonce_consumption_transaction_hash IS NOT NULL\) \)/
  )
  assert.match(migration, /nonce consumption names another sender lane/)
  assert.match(
    nonceFinalityMigration,
    /nonce_consumption_observed_head_block_number\s+- nonce_consumption_finalized_block_number >= 64/
  )
  assert.match(
    nonceFinalityMigration,
    /p2tr_signer_boundary_nonce_finality_v5[\s\S]*NOT VALID/
  )
  assert.match(
    migration,
    /CHECK \(\(outcome = 'signed'\) = \(signed_transaction_hash IS NOT NULL\)\)/
  )
  assert.match(
    migration,
    /CHECK \(primary_trust_domain_id <> corroborating_trust_domain_id\), CHECK \(primary_evidence_digest = resolution_evidence_digest\)/
  )
  assert.match(
    migration,
    /orphaned signer boundary resolution does not name the durable boundary/
  )
  assert.match(
    migration,
    /preparation_resume_status IS NULL[\s\S]*?orphaned signer boundary resolution does not name the durable signer stage/
  )
  assert.match(
    nonceFinalityMigration,
    /preparation_resume_status IS NULL[\s\S]*?orphaned signer boundary resolution does not name the durable signer stage/
  )
  assert.match(
    migration,
    /orphaned signer boundary resolution requires a boundary with no signer escape evidence/
  )
  assert.match(nonceFinalityMigration, /record_state \? 'contestedNonceBurn'/)
  assert.match(
    migration,
    /resolution\.signed_transaction_hash <> NEW\.transaction_hash[\s\S]*?escaped signed artifact does not match the authenticated orphan resolution/
  )
  assert.match(
    migration,
    /p2tr_signature_fraud_guard_signer_boundary_resolution_trigger BEFORE INSERT/
  )
  assert.match(
    migration,
    /p2tr_signature_fraud_reject_signer_boundary_resolution_mutation_trigger BEFORE UPDATE OR DELETE/
  )
  assert.match(
    migration,
    /terminal unsafe signer-boundary alert requires independently attested evidence/
  )
})

test("keeps legacy quarantine resolutions append-only", () => {
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_legacy_submission_quarantine_resolution/
  )
  assert.match(
    migration,
    /p2tr_signature_fraud_reject_legacy_quarantine_resolution_mutation_trigger BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_legacy_submission_quarantine_resolution/
  )
})

test("applies the manifest recovery bound to health and blocking reasons", () => {
  assert.match(
    activationHandshakeSource,
    /if \(recoveryBacklogCount > binding\.maxRecoveryBacklog\)[\s\S]*?reasons\.push\("preparation-recovery-backlog"\)[\s\S]*?reasons\.push\("nonce-release-recovery-backlog"\)/
  )
  assert.doesNotMatch(
    activationHandshakeSource,
    /if \(recoveryBacklogCount > 0\) reasons\.push\("preparation-recovery-backlog"\)/
  )
})

test("counts unresolved Ethereum broadcasts in activation health", () => {
  assert.match(
    activationHandshakeSource,
    /p2tr_signature_fraud_challenge_outbox_broadcast_attempt attempt[\s\S]*?LEFT JOIN p2tr_signature_fraud_challenge_outbox_broadcast_acknowledgement acknowledgement[\s\S]*?outbox\.status <> ALL[\s\S]*?newer\.attempt_number > attempt\.attempt_number[\s\S]*?acknowledgement\.record_id IS NULL[\s\S]*?acknowledgement\.result = 'ambiguous'/
  )
  assert.match(
    activationHandshakeSource,
    /ambiguousNonceReleaseCount \+ ambiguousBroadcastCount/
  )
  assert.match(
    migration,
    /p2tr_signature_fraud_challenge_outbox_broadcast_attempt a[\s\S]*?LEFT JOIN p2tr_signature_fraud_challenge_outbox_broadcast_acknowledgement x[\s\S]*?o\.status NOT IN[\s\S]*?newer\.attempt_number > a\.attempt_number[\s\S]*?x\.record_id IS NULL OR x\.result = 'ambiguous'/
  )
})

test("rotates manifests and outbox provenance in one database trigger", () => {
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION p2tr_watchtower_activation_manifest_monotonic\(\)/
  )
  assert.match(
    migration,
    /INSERT INTO p2tr_signature_fraud_challenge_provenance_invalidation/
  )
  assert.match(
    migration,
    /INSERT INTO p2tr_signature_fraud_challenge_provenance_incident/
  )
  assert.match(
    migration,
    /activation manifest rotation invalidated the generation provenance/
  )
  assert.match(migration, /record_state = jsonb_set\(/)
  assert.match(
    migration,
    /CREATE TABLE p2tr_signature_fraud_challenge_outbox_state_history/
  )
  assert.match(
    migration,
    /o\.active_signer_invocation_started_at_unix_ms IS NOT NULL OR \( o\.signer_invocation_started_at_unix_ms IS NULL AND o\.prepared_transaction_hash IS NULL AND o\.broadcast_attempts = 0 \)/
  )
  // The rotation incident predicate must stay the adapter's exact
  // escaped/active-preparation/terminal preserve set. A row that keeps an
  // active signer boundary is later moved into
  // provenance-invalidated-awaiting-reconciliation, and the status trigger
  // rejects that transition without an activation-blocking incident.
  assert.match(
    migration,
    /OR \( o\.status = 'preparing' AND o\.preparation_lease_owner IS NOT NULL AND o\.active_signer_invocation_started_at_unix_ms IS NOT NULL \) \);/
  )
  assert.doesNotMatch(
    migration,
    /AND NOT \( o\.status = 'preparing' AND o\.signer_invocation_started_at_unix_ms IS NULL AND o\.prepared_transaction_hash IS NULL AND o\.broadcast_attempts = 0 \)/
  )
})

test("attests security-critical view definitions in the schema hash", () => {
  assert.match(activationHandshakeSource, /pg_get_viewdef\(r\.oid, true\)/)
  assert.match(activationHandshakeSource, /'view-definition'/)
  assert.match(activationHandshakeSource, /'enabled=' \|\| t\.tgenabled::text/)
  assert.match(activationHandshakeSource, /p\.proname = 'p2tr_reverse_bytea'/)
})

test("protects serialized generation identity alongside normalized columns", () => {
  assert.match(
    migration,
    /NEW\.record_state -> 'canonicalProvenance'[\s\S]*OLD\.record_state -> 'canonicalProvenance'/
  )
  assert.match(
    migration,
    /serialized P2TR outbox generation identity and evidence are immutable/
  )
})

test("makes the durable signed-variant gas invariant the exact runtime one", () => {
  // 003 is checksum-tracked, so the strict comparison arrives by replacing the
  // trigger function in an append-only migration rather than editing it there.
  assert.match(migration, /NEW\.gas_limit > fee_policy\.max_gas_limit/)
  assert.doesNotMatch(migration, /NEW\.gas_limit <> fee_policy\.max_gas_limit/)
  assert.match(
    exactGasMigration,
    /CREATE OR REPLACE FUNCTION p2tr_signature_fraud_validate_variant_append\(\)/
  )
  assert.match(exactGasMigration, /NEW\.gas_limit <> fee_policy\.max_gas_limit/)
  assert.doesNotMatch(
    exactGasMigration,
    /NEW\.gas_limit > fee_policy\.max_gas_limit/
  )
  // Everything else about the trigger has to survive the replacement.
  for (const preserved of [
    /signed variant does not match the durable bound nonce reservation/,
    /signed variant exceeds its manifest-bound fee or value policy/,
    /initial P2TR challenge variant is not append-only/,
    /P2TR challenge variant sequence is not contiguous/,
    /P2TR challenge replacement changed sender or nonce/,
    /P2TR challenge replacement fee envelope did not strictly increase/,
  ]) {
    assert.match(migration, preserved)
    assert.match(exactGasMigration, preserved)
  }
})
