-- Canonical Ethereum journal and content-addressed activation state.
-- This migration depends on 001_p2tr_canonical_index.sql.

INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('canonical-ethereum-journal', 1);

ALTER TABLE p2tr_frost_wallet_bindings
    ADD COLUMN wallet_pub_key_hash bytea
        CHECK (octet_length(wallet_pub_key_hash) = 20);

CREATE UNIQUE INDEX p2tr_frost_wallet_bindings_pub_key_hash_idx
    ON p2tr_frost_wallet_bindings (wallet_pub_key_hash)
    WHERE wallet_pub_key_hash IS NOT NULL;

CREATE TABLE p2tr_ethereum_blocks (
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash bytea NOT NULL UNIQUE CHECK (octet_length(block_hash) = 32),
    parent_hash bytea NOT NULL CHECK (octet_length(parent_hash) = 32),
    block_timestamp bigint NOT NULL CHECK (block_timestamp >= 0),
    transactions_root bytea NOT NULL CHECK (octet_length(transactions_root) = 32),
    receipts_root bytea NOT NULL CHECK (octet_length(receipts_root) = 32),
    transaction_hashes jsonb NOT NULL CHECK (
        jsonb_typeof(transaction_hashes) = 'array'
    ),
    transaction_digest bytea NOT NULL CHECK (octet_length(transaction_digest) = 32),
    transaction_count bigint NOT NULL CHECK (transaction_count >= 0),
    receipt_digest bytea NOT NULL CHECK (octet_length(receipt_digest) = 32),
    receipt_count bigint NOT NULL CHECK (receipt_count >= 0),
    log_digest bytea NOT NULL CHECK (octet_length(log_digest) = 32),
    log_count bigint NOT NULL CHECK (log_count >= 0),
    required_event_digest bytea NOT NULL
        CHECK (octet_length(required_event_digest) = 32),
    block_required_event_count bigint NOT NULL
        CHECK (block_required_event_count >= 0),
    history_root bytea NOT NULL CHECK (octet_length(history_root) = 32),
    required_event_count bigint NOT NULL CHECK (required_event_count >= 0),
    cumulative_block_count bigint NOT NULL CHECK (cumulative_block_count >= 0),
    cumulative_transaction_count bigint NOT NULL
        CHECK (cumulative_transaction_count >= 0),
    cumulative_receipt_count bigint NOT NULL
        CHECK (cumulative_receipt_count >= 0),
    cumulative_log_count bigint NOT NULL CHECK (cumulative_log_count >= 0),
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (block_number, block_hash)
);

CREATE UNIQUE INDEX p2tr_ethereum_blocks_number_idx
    ON p2tr_ethereum_blocks (block_number);

CREATE TABLE p2tr_ethereum_cursor (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    store_id text NOT NULL CHECK (length(store_id) BETWEEN 1 AND 255),
    chain_id numeric(78, 0) NOT NULL CHECK (chain_id > 0),
    configuration_fingerprint bytea NOT NULL
        CHECK (octet_length(configuration_fingerprint) = 32),
    descriptor_set_hash bytea NOT NULL
        CHECK (octet_length(descriptor_set_hash) = 32),
    scan_start_block bigint NOT NULL CHECK (scan_start_block > 0),
    checkpoint_block_number bigint NOT NULL
        CHECK (checkpoint_block_number >= 0),
    checkpoint_block_hash bytea NOT NULL
        CHECK (octet_length(checkpoint_block_hash) = 32),
    current_block_number bigint NOT NULL
        CHECK (current_block_number >= checkpoint_block_number),
    current_block_hash bytea NOT NULL
        CHECK (octet_length(current_block_hash) = 32),
    generation bigint NOT NULL CHECK (generation > 0),
    journal_block_count bigint NOT NULL CHECK (journal_block_count > 0),
    journal_event_count bigint NOT NULL CHECK (journal_event_count >= 0),
    coverage_block_count bigint NOT NULL CHECK (coverage_block_count >= 0),
    coverage_transaction_count bigint NOT NULL
        CHECK (coverage_transaction_count >= 0),
    coverage_receipt_count bigint NOT NULL
        CHECK (coverage_receipt_count >= 0),
    coverage_log_count bigint NOT NULL CHECK (coverage_log_count >= 0),
    CHECK (scan_start_block = checkpoint_block_number + 1),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (current_block_number, current_block_hash)
        REFERENCES p2tr_ethereum_blocks (block_number, block_hash)
);

CREATE TABLE p2tr_ethereum_logs (
    event_id bytea PRIMARY KEY CHECK (octet_length(event_id) = 32),
    event_kind text NOT NULL CHECK (event_kind IN (
        'frost-wallet-registered',
        'taproot-deposit-revealed',
        'deposits-swept',
        'redemptions-completed',
        'moving-funds-completed',
        'moved-funds-swept',
        'p2tr-challenge-submitted',
        'p2tr-challenge-defeated',
        'p2tr-challenge-timed-out',
        'p2tr-challenge-migrated',
        'legacy-fraud-challenge-migrated',
        'p2tr-authorization-registered',
        'p2tr-reservation-authorized',
        'p2tr-reservation-settled',
        'p2tr-reservation-conflicted',
        'wallet-moving-funds',
        'wallet-closing',
        'wallet-closed',
        'wallet-terminated',
        'wallet-quarantined',
        'redemption-requested',
        'redemption-timed-out',
        'redemption-objection-raised',
        'redemption-veto-finalized',
        'redemption-veto-check-omitted',
        'redemption-watchtower-enabled',
        'redemption-watchtower-disabled',
        'redemption-watchtower-parameters-updated',
        'moving-funds-commitment-submitted',
        'moving-funds-timeout-reset',
        'moving-funds-timed-out',
        'moving-funds-below-dust',
        'moved-funds-sweep-timed-out',
        'p2tr-router-activated',
        'bridge-frost-registry-set',
        'bridge-ecdsa-router-set',
        'bridge-p2tr-router-set',
        'bridge-lifecycle-router-set',
        'bridge-ecdsa-retired',
        'deposit-parameters-updated',
        'redemption-parameters-updated',
        'moving-funds-parameters-updated',
        'wallet-parameters-updated',
        'fraud-parameters-updated',
        'redemption-watchtower-set',
        'ecdsa-router-drain-started',
        'ecdsa-router-inventory-staged',
        'ecdsa-router-inventory-confirmed',
        'ecdsa-router-migration-executed',
        'ecdsa-router-migration-confirmed',
        'ecdsa-router-cutover-finalized',
        'ecdsa-fraud-reconciler-update-started',
        'ecdsa-fraud-reconciler-updated',
        'ecdsa-migrated-challenges-activated'
    )),
    decoder_schema_id text NOT NULL
        CHECK (length(decoder_schema_id) BETWEEN 1 AND 128),
    decoder_code_hash bytea NOT NULL
        CHECK (octet_length(decoder_code_hash) = 32),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    transaction_hash bytea NOT NULL
        CHECK (octet_length(transaction_hash) = 32),
    transaction_index integer NOT NULL CHECK (transaction_index >= 0),
    log_index integer NOT NULL CHECK (log_index >= 0),
    emitter bytea NOT NULL CHECK (octet_length(emitter) = 20),
    topic0 bytea NOT NULL CHECK (octet_length(topic0) = 32),
    topics jsonb NOT NULL CHECK (
        jsonb_typeof(topics) = 'array'
        AND jsonb_array_length(topics) BETWEEN 1 AND 4
    ),
    data bytea NOT NULL,
    decoded_payload jsonb NOT NULL CHECK (
        jsonb_typeof(decoded_payload) = 'object'
    ),
    inserted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (block_hash, log_index),
    UNIQUE (block_hash, transaction_hash, log_index),
    FOREIGN KEY (block_number, block_hash)
        REFERENCES p2tr_ethereum_blocks (block_number, block_hash)
        ON DELETE CASCADE
);

CREATE INDEX p2tr_ethereum_logs_kind_position_idx
    ON p2tr_ethereum_logs (event_kind, block_number, log_index);

CREATE INDEX p2tr_ethereum_logs_transaction_idx
    ON p2tr_ethereum_logs (transaction_hash, log_index);

CREATE INDEX p2tr_ethereum_logs_position_idx
    ON p2tr_ethereum_logs (block_number, log_index);

-- Each independently operated Ethereum provider uses its own database/store
-- identity. These parent-linked roots make restart and per-dispatch work
-- proportional to a bounded tail instead of deployment-to-head history.
CREATE TABLE p2tr_ethereum_history_accumulators (
    accumulator_id text PRIMARY KEY CHECK (length(accumulator_id) BETWEEN 1 AND 128),
    store_fingerprint bytea NOT NULL CHECK (octet_length(store_fingerprint) = 32),
    chain_id numeric(78, 0) NOT NULL CHECK (chain_id > 0),
    descriptor_set_hash bytea NOT NULL CHECK (octet_length(descriptor_set_hash) = 32),
    checkpoint_block_number bigint NOT NULL CHECK (checkpoint_block_number >= 0),
    checkpoint_block_hash bytea NOT NULL CHECK (octet_length(checkpoint_block_hash) = 32),
    current_block_number bigint NOT NULL CHECK (current_block_number >= checkpoint_block_number),
    current_block_hash bytea NOT NULL CHECK (octet_length(current_block_hash) = 32),
    history_root bytea NOT NULL CHECK (octet_length(history_root) = 32),
    required_event_count bigint NOT NULL CHECK (required_event_count >= 0),
    cumulative_block_count bigint NOT NULL CHECK (cumulative_block_count >= 0),
    cumulative_transaction_count bigint NOT NULL
        CHECK (cumulative_transaction_count >= 0),
    cumulative_receipt_count bigint NOT NULL
        CHECK (cumulative_receipt_count >= 0),
    cumulative_log_count bigint NOT NULL CHECK (cumulative_log_count >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE p2tr_ethereum_history_accumulator_blocks (
    accumulator_id text NOT NULL REFERENCES p2tr_ethereum_history_accumulators(accumulator_id)
        ON DELETE CASCADE,
    block_number bigint NOT NULL CHECK (block_number >= 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    parent_hash bytea NOT NULL CHECK (octet_length(parent_hash) = 32),
    transactions_root bytea NOT NULL CHECK (octet_length(transactions_root) = 32),
    receipts_root bytea NOT NULL CHECK (octet_length(receipts_root) = 32),
    history_root bytea NOT NULL CHECK (octet_length(history_root) = 32),
    required_event_count bigint NOT NULL CHECK (required_event_count >= 0),
    transaction_digest bytea NOT NULL CHECK (octet_length(transaction_digest) = 32),
    transaction_count bigint NOT NULL CHECK (transaction_count >= 0),
    receipt_digest bytea NOT NULL CHECK (octet_length(receipt_digest) = 32),
    receipt_count bigint NOT NULL CHECK (receipt_count >= 0),
    log_digest bytea NOT NULL CHECK (octet_length(log_digest) = 32),
    log_count bigint NOT NULL CHECK (log_count >= 0),
    required_event_digest bytea NOT NULL
        CHECK (octet_length(required_event_digest) = 32),
    block_required_event_count bigint NOT NULL
        CHECK (block_required_event_count >= 0),
    cumulative_block_count bigint NOT NULL CHECK (cumulative_block_count >= 0),
    cumulative_transaction_count bigint NOT NULL
        CHECK (cumulative_transaction_count >= 0),
    cumulative_receipt_count bigint NOT NULL
        CHECK (cumulative_receipt_count >= 0),
    cumulative_log_count bigint NOT NULL CHECK (cumulative_log_count >= 0),
    PRIMARY KEY (accumulator_id, block_number),
    UNIQUE (accumulator_id, block_hash)
);

-- Exactly one reviewed manifest may authorize the live production profile.
-- Replacing it is an explicit operator transaction, not an environment-only
-- toggle; the runtime still verifies its trusted Ed25519 signer and all live
-- readbacks before every dispatch cycle.
CREATE TABLE p2tr_watchtower_activation_manifest (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    activation_sequence bigint NOT NULL CHECK (activation_sequence > 0),
    manifest_hash bytea NOT NULL UNIQUE
        CHECK (octet_length(manifest_hash) = 32),
    trusted_signer_key_hash bytea NOT NULL
        CHECK (octet_length(trusted_signer_key_hash) = 32),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
    activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION p2tr_watchtower_activation_manifest_monotonic()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'production activation manifest cannot be deleted';
    END IF;
    IF NEW.activation_sequence <= OLD.activation_sequence THEN
        RAISE EXCEPTION 'production activation sequence must increase';
    END IF;
    UPDATE p2tr_readiness_certificates
       SET is_current = false,
           invalidated_at = clock_timestamp()
     WHERE is_current;
    UPDATE p2tr_candidate_enqueue_authorizations
       SET invalidated_at = clock_timestamp()
     WHERE consumed_at IS NULL
       AND invalidated_at IS NULL;
    RETURN NEW;
END;
$body$;

CREATE TRIGGER p2tr_watchtower_activation_manifest_monotonic_trigger
BEFORE UPDATE OR DELETE ON p2tr_watchtower_activation_manifest
FOR EACH ROW EXECUTE FUNCTION p2tr_watchtower_activation_manifest_monotonic();

CREATE TABLE p2tr_watchtower_component_health (
    component text PRIMARY KEY CHECK (component IN (
        'bitcoin-index',
        'ethereum-journal',
        'ethereum-projector'
    )),
    configuration_fingerprint bytea NOT NULL
        CHECK (octet_length(configuration_fingerprint) = 32),
    position_number bigint NOT NULL CHECK (position_number >= 0),
    position_hash bytea NOT NULL CHECK (octet_length(position_hash) = 32),
    failure_generation bigint NOT NULL DEFAULT 0
        CHECK (failure_generation >= 0),
    cleared_failure_generation bigint NOT NULL DEFAULT 0 CHECK (
        cleared_failure_generation >= 0
        AND cleared_failure_generation <= failure_generation
    ),
    last_failure_digest bytea CHECK (
        last_failure_digest IS NULL OR octet_length(last_failure_digest) = 32
    ),
    last_failure_at timestamptz,
    last_success_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (failure_generation = cleared_failure_generation
         AND last_failure_digest IS NULL
         AND last_failure_at IS NULL)
        OR
        (failure_generation > cleared_failure_generation
         AND last_failure_digest IS NOT NULL
         AND last_failure_at IS NOT NULL)
    )
);

CREATE TABLE p2tr_readiness_certificate_generation (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    next_generation bigint NOT NULL CHECK (next_generation > 0)
);

INSERT INTO p2tr_readiness_certificate_generation (singleton, next_generation)
VALUES (true, 1);

-- Durable authority minted only while the global readiness lock excludes all
-- Bitcoin/Ethereum journal and projection writers. The JSON payload contains
-- the complete normalized snapshots/read sets; the scalar columns are the
-- exact CAS boundary rechecked by authorization, outbox claim, signing,
-- replacement, and broadcast.
CREATE TABLE p2tr_readiness_certificates (
    certificate_id bytea PRIMARY KEY CHECK (octet_length(certificate_id) = 32),
    certificate_generation bigint NOT NULL UNIQUE
        CHECK (certificate_generation > 0),
    manifest_hash bytea NOT NULL CHECK (octet_length(manifest_hash) = 32),
    manifest_activation_sequence bigint NOT NULL
        CHECK (manifest_activation_sequence > 0),
    primary_bitcoin_generation bigint NOT NULL
        CHECK (primary_bitcoin_generation > 0),
    primary_bitcoin_root bytea NOT NULL
        CHECK (octet_length(primary_bitcoin_root) = 32),
    primary_bitcoin_semantic_root bytea NOT NULL
        CHECK (octet_length(primary_bitcoin_semantic_root) = 32),
    reconciliation_bitcoin_store_id text NOT NULL
        CHECK (length(reconciliation_bitcoin_store_id) BETWEEN 1 AND 255),
    reconciliation_bitcoin_generation bigint NOT NULL
        CHECK (reconciliation_bitcoin_generation > 0),
    reconciliation_bitcoin_root bytea NOT NULL
        CHECK (octet_length(reconciliation_bitcoin_root) = 32),
    reconciliation_bitcoin_semantic_root bytea NOT NULL
        CHECK (octet_length(reconciliation_bitcoin_semantic_root) = 32),
    bitcoin_height bigint NOT NULL CHECK (bitcoin_height >= 0),
    bitcoin_hash bytea NOT NULL CHECK (octet_length(bitcoin_hash) = 32),
    ethereum_journal_generation bigint NOT NULL
        CHECK (ethereum_journal_generation > 0),
    ethereum_journal_root bytea NOT NULL
        CHECK (octet_length(ethereum_journal_root) = 32),
    ethereum_history_root bytea NOT NULL
        CHECK (octet_length(ethereum_history_root) = 32),
    ethereum_block_number bigint NOT NULL CHECK (ethereum_block_number >= 0),
    ethereum_block_hash bytea NOT NULL
        CHECK (octet_length(ethereum_block_hash) = 32),
    provider_read_set_hash bytea NOT NULL
        CHECK (octet_length(provider_read_set_hash) = 32),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    is_current boolean NOT NULL DEFAULT true,
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    invalidated_at timestamptz,
    CHECK (
        (is_current AND invalidated_at IS NULL) OR
        (NOT is_current AND invalidated_at IS NOT NULL)
    ),
    UNIQUE (certificate_id, certificate_generation)
);

CREATE UNIQUE INDEX p2tr_readiness_certificates_current_idx
    ON p2tr_readiness_certificates (is_current)
    WHERE is_current;

CREATE INDEX p2tr_readiness_certificates_manifest_idx
    ON p2tr_readiness_certificates
       (manifest_hash, certificate_generation DESC);

CREATE TABLE p2tr_candidate_enqueue_authorizations (
    token_id bytea PRIMARY KEY CHECK (octet_length(token_id) = 32),
    manifest_hash bytea NOT NULL CHECK (octet_length(manifest_hash) = 32),
    candidate_digest bytea NOT NULL CHECK (octet_length(candidate_digest) = 32),
    observation_id bytea NOT NULL CHECK (octet_length(observation_id) = 32),
    challenge_key bytea NOT NULL CHECK (octet_length(challenge_key) = 32),
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    wtxid bytea NOT NULL CHECK (octet_length(wtxid) = 32),
    input_index bigint NOT NULL CHECK (input_index BETWEEN 0 AND 4294967295),
    bitcoin_block_height bigint NOT NULL CHECK (bitcoin_block_height >= 0),
    bitcoin_block_hash bytea NOT NULL CHECK (octet_length(bitcoin_block_hash) = 32),
    verified_bitcoin_height bigint NOT NULL CHECK (
        verified_bitcoin_height >= bitcoin_block_height
    ),
    verified_bitcoin_hash bytea NOT NULL
        CHECK (octet_length(verified_bitcoin_hash) = 32),
    verified_ethereum_block bigint NOT NULL CHECK (verified_ethereum_block >= 0),
    verified_ethereum_hash bytea NOT NULL
        CHECK (octet_length(verified_ethereum_hash) = 32),
    funding_block_hash bytea NOT NULL
        CHECK (octet_length(funding_block_hash) = 32),
    funding_txid bytea NOT NULL CHECK (octet_length(funding_txid) = 32),
    funding_vout bigint NOT NULL CHECK (funding_vout BETWEEN 0 AND 4294967295),
    input_wallet_id bytea NOT NULL CHECK (octet_length(input_wallet_id) = 32),
    input_output_key bytea NOT NULL CHECK (octet_length(input_output_key) = 32),
    input_binding_kind text NOT NULL CHECK (input_binding_kind IN (
        'registered-wallet-output', 'deposit-binding'
    )),
    input_binding_source_event_id bytea NOT NULL
        CHECK (octet_length(input_binding_source_event_id) = 32),
    candidate_provenance_generation bigint NOT NULL
        CHECK (candidate_provenance_generation > 0),
    provenance_fingerprint bytea NOT NULL
        CHECK (octet_length(provenance_fingerprint) = 32),
    readiness_certificate_id bytea NOT NULL
        CHECK (octet_length(readiness_certificate_id) = 32),
    readiness_certificate_generation bigint NOT NULL
        CHECK (readiness_certificate_generation > 0),
    issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    invalidated_at timestamptz,
    outbox_intent_id bytea CHECK (
        outbox_intent_id IS NULL OR octet_length(outbox_intent_id) = 32
    ),
    CHECK (expires_at > issued_at),
    CHECK (
        (consumed_at IS NULL AND invalidated_at IS NULL AND outbox_intent_id IS NULL)
        OR (consumed_at IS NOT NULL AND invalidated_at IS NULL AND outbox_intent_id IS NOT NULL)
        OR (consumed_at IS NULL AND invalidated_at IS NOT NULL AND outbox_intent_id IS NULL)
    ),
    FOREIGN KEY (readiness_certificate_id, readiness_certificate_generation)
        REFERENCES p2tr_readiness_certificates
            (certificate_id, certificate_generation)
);

CREATE INDEX p2tr_candidate_enqueue_authorizations_live_idx
    ON p2tr_candidate_enqueue_authorizations (expires_at)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE UNIQUE INDEX p2tr_candidate_enqueue_authorizations_candidate_live_idx
    ON p2tr_candidate_enqueue_authorizations (candidate_digest)
    WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE UNIQUE INDEX p2tr_candidate_enqueue_authorizations_candidate_consumed_idx
    ON p2tr_candidate_enqueue_authorizations (candidate_digest)
    WHERE consumed_at IS NOT NULL;
