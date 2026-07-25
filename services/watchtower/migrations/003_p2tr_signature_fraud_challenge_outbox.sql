-- Activation-grade durable outbox for automatic P2TR fraud challenges.
--
-- The initial generation is inserted in the same database transaction as the
-- confirmed Bitcoin observation and both canonical source cursors. Later
-- generations never rewrite that evidence: they append a new record linked to
-- independently attested cancellation or nonce-disposition evidence.

INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('signature-fraud-challenge-outbox', 1);

-- Capacity is part of the signed activation-manifest payload. It is not an
-- environment knob: every insert locks the singleton manifest row and counts
-- all globally active generations before consuming another slot.
ALTER TABLE p2tr_watchtower_activation_manifest
ADD CONSTRAINT p2tr_watchtower_manifest_outbox_capacity_check CHECK (
    payload #>> '{outbox,maxActiveOutboxRecords}' IS NOT NULL
    AND (payload #>> '{outbox,maxActiveOutboxRecords}') ~ '^[1-9][0-9]{0,6}$'
    AND (payload #>> '{outbox,maxActiveOutboxRecords}')::integer
        BETWEEN 1 AND 1000000
) NOT VALID;

CREATE TABLE p2tr_signature_fraud_challenge_outbox_capacity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    active_generation_count bigint NOT NULL CHECK (
        active_generation_count BETWEEN 0 AND 1000000
    )
);

INSERT INTO p2tr_signature_fraud_challenge_outbox_capacity (
    singleton,
    active_generation_count
) VALUES (true, 0);

CREATE TABLE p2tr_signature_fraud_challenge_outbox (
    record_id bytea PRIMARY KEY CHECK (octet_length(record_id) = 32),
    series_id bytea NOT NULL CHECK (octet_length(series_id) = 32),
    intent_id bytea NOT NULL CHECK (octet_length(intent_id) = 32),
    generation integer NOT NULL CHECK (generation BETWEEN 0 AND 31),
    previous_record_id bytea REFERENCES p2tr_signature_fraud_challenge_outbox(record_id) ON DELETE RESTRICT,
    generation_cause text CHECK (generation_cause IN (
        'finalized-revert',
        'finalized-nonce-consumed',
        'canonical-reappearance',
        'provenance-restored'
    )),
    prior_nonce_disposition_id bytea CHECK (
        prior_nonce_disposition_id IS NULL
        OR octet_length(prior_nonce_disposition_id) = 32
    ),
    prior_cancellation_evidence_id bytea CHECK (
        prior_cancellation_evidence_id IS NULL
        OR octet_length(prior_cancellation_evidence_id) = 32
    ),
    prior_provenance_invalidation_id bytea CHECK (
        prior_provenance_invalidation_id IS NULL
        OR octet_length(prior_provenance_invalidation_id) = 32
    ),

    observation_id bytea NOT NULL CHECK (octet_length(observation_id) = 32),
    evidence_protocol_id bytea NOT NULL CHECK (
        octet_length(evidence_protocol_id) = 32
        AND evidence_protocol_id = decode(
            '12c62b64ecf6d008bcff153495dcdbe7a981f3a9a1b9c0898b86b1e6d0d350ef',
            'hex'
        )
    ),
    intent_input_index bigint NOT NULL CHECK (
        intent_input_index BETWEEN 0 AND 4294967295
    ),
    bridge_challenge_key bytea NOT NULL CHECK (octet_length(bridge_challenge_key) = 32),
    wallet_id bytea NOT NULL CHECK (octet_length(wallet_id) = 32),
    signing_key bytea NOT NULL CHECK (octet_length(signing_key) = 32),
    binding_tx_hash bytea NOT NULL CHECK (octet_length(binding_tx_hash) = 32),
    binding_output_index bigint NOT NULL CHECK (
        binding_output_index BETWEEN 0 AND 4294967295
    ),
    bridge_challenge_identity bytea NOT NULL CHECK (octet_length(bridge_challenge_identity) = 32),
    sighash bytea NOT NULL CHECK (octet_length(sighash) = 32),
    signature_nonce_x bytea NOT NULL CHECK (octet_length(signature_nonce_x) = 32),
    signature_scalar bytea NOT NULL CHECK (octet_length(signature_scalar) = 32),
    domain_chain_id numeric(78, 0) NOT NULL CHECK (domain_chain_id > 0),
    chain_id numeric(78, 0) NOT NULL CHECK (chain_id > 0),
    bridge_address bytea NOT NULL CHECK (octet_length(bridge_address) = 20),
    router_address bytea NOT NULL CHECK (octet_length(router_address) = 20),
    calldata bytea NOT NULL CHECK (octet_length(calldata) = 388),
    value_wei numeric(78, 0) NOT NULL CHECK (value_wei >= 0),
    fee_policy_hash bytea NOT NULL CHECK (octet_length(fee_policy_hash) = 32),

    bitcoin_tx_hash bytea NOT NULL CHECK (octet_length(bitcoin_tx_hash) = 32),
    bitcoin_wtxid bytea NOT NULL CHECK (octet_length(bitcoin_wtxid) = 32),
    bitcoin_input_index bigint NOT NULL CHECK (
        bitcoin_input_index BETWEEN 0 AND 4294967295
    ),
    bitcoin_block_hash bytea NOT NULL CHECK (octet_length(bitcoin_block_hash) = 32),
    bitcoin_block_height bigint NOT NULL CHECK (bitcoin_block_height >= 0),
    bitcoin_cursor_block_hash bytea NOT NULL CHECK (octet_length(bitcoin_cursor_block_hash) = 32),
    bitcoin_cursor_block_height bigint NOT NULL CHECK (
        bitcoin_cursor_block_height >= bitcoin_block_height
    ),
    ethereum_lifecycle_block_hash bytea NOT NULL CHECK (octet_length(ethereum_lifecycle_block_hash) = 32),
    ethereum_lifecycle_block_number bigint NOT NULL CHECK (ethereum_lifecycle_block_number >= 0),
    activation_manifest_hash bytea NOT NULL CHECK (octet_length(activation_manifest_hash) = 32),
    router_code_hash bytea NOT NULL CHECK (octet_length(router_code_hash) = 32),
    router_protocol_id bytea NOT NULL CHECK (
        octet_length(router_protocol_id) = 32
        AND router_protocol_id = evidence_protocol_id
    ),
    router_domain_chain_id numeric(78, 0) NOT NULL CHECK (
        router_domain_chain_id = domain_chain_id
        AND router_domain_chain_id = chain_id
    ),
    complete_authorization_registry_address bytea NOT NULL CHECK (octet_length(complete_authorization_registry_address) = 20),
    complete_authorization_registry_code_hash bytea NOT NULL CHECK (octet_length(complete_authorization_registry_code_hash) = 32),
    complete_authorization_registry_protocol_id bytea NOT NULL CHECK (octet_length(complete_authorization_registry_protocol_id) = 32),
    complete_reservation_model bytea NOT NULL CHECK (octet_length(complete_reservation_model) = 32),
    ethereum_eligibility_read_set_hash bytea NOT NULL CHECK (octet_length(ethereum_eligibility_read_set_hash) = 32),
    canonical_provenance_journal_store_id text NOT NULL CHECK (
        length(canonical_provenance_journal_store_id) BETWEEN 1 AND 128
    ),
    canonical_provenance_descriptor_set_hash bytea NOT NULL CHECK (
        octet_length(canonical_provenance_descriptor_set_hash) = 32
    ),
    canonical_provenance_through_block_number bigint NOT NULL CHECK (
        canonical_provenance_through_block_number = ethereum_lifecycle_block_number
    ),
    canonical_provenance_through_block_hash bytea NOT NULL CHECK (
        octet_length(canonical_provenance_through_block_hash) = 32
        AND canonical_provenance_through_block_hash = ethereum_lifecycle_block_hash
    ),
    canonical_provenance_history_root bytea NOT NULL CHECK (
        octet_length(canonical_provenance_history_root) = 32
    ),
    canonical_provenance_event_set_hash bytea NOT NULL CHECK (
        octet_length(canonical_provenance_event_set_hash) = 32
    ),
    canonical_provenance_event_count bigint NOT NULL CHECK (
        canonical_provenance_event_count BETWEEN 1 AND 1000
    ),
    canonical_candidate_digest bytea NOT NULL CHECK (
        octet_length(canonical_candidate_digest) = 32
    ),
    canonical_candidate_provenance_generation bigint NOT NULL CHECK (
        canonical_candidate_provenance_generation > 0
    ),
    canonical_provenance_challenge_key bytea NOT NULL CHECK (
        octet_length(canonical_provenance_challenge_key) = 32
        AND canonical_provenance_challenge_key = bridge_challenge_key
    ),
    canonical_readiness_certificate_id bytea NOT NULL CHECK (
        octet_length(canonical_readiness_certificate_id) = 32
    ),
    canonical_readiness_certificate_generation bigint NOT NULL CHECK (
        canonical_readiness_certificate_generation > 0
    ),
    canonical_input_binding_kind text NOT NULL CHECK (
        canonical_input_binding_kind IN (
            'registered-wallet-output',
            'deposit-binding'
        )
    ),
    canonical_input_binding_source_event_id bytea NOT NULL CHECK (
        octet_length(canonical_input_binding_source_event_id) = 32
    ),
    canonical_input_index bigint NOT NULL CHECK (
        canonical_input_index = bitcoin_input_index
    ),
    canonical_funding_block_hash bytea NOT NULL CHECK (
        octet_length(canonical_funding_block_hash) = 32
    ),
    canonical_funding_txid bytea NOT NULL CHECK (
        octet_length(canonical_funding_txid) = 32
    ),
    canonical_funding_vout bigint NOT NULL CHECK (
        canonical_funding_vout BETWEEN 0 AND 4294967295
    ),
    canonical_input_wallet_id bytea NOT NULL CHECK (
        octet_length(canonical_input_wallet_id) = 32
        AND canonical_input_wallet_id = wallet_id
    ),
    canonical_input_output_key bytea NOT NULL CHECK (
        octet_length(canonical_input_output_key) = 32
        AND canonical_input_output_key = signing_key
    ),
    canonical_binding_ethereum_block_number bigint NOT NULL CHECK (
        canonical_binding_ethereum_block_number >= 0
        AND canonical_binding_ethereum_block_number <=
            canonical_provenance_through_block_number
    ),
    canonical_binding_ethereum_block_hash bytea NOT NULL CHECK (
        octet_length(canonical_binding_ethereum_block_hash) = 32
    ),
    CHECK (
        canonical_input_binding_kind <> 'registered-wallet-output'
        OR canonical_input_output_key = canonical_input_wallet_id
    ),
    CHECK (bridge_challenge_key = bridge_challenge_identity),
    CHECK (intent_input_index = bitcoin_input_index),
    CHECK (
        (
            signing_key = wallet_id
            AND binding_tx_hash = decode(repeat('00', 32), 'hex')
            AND binding_output_index = 0
            AND canonical_input_binding_kind = 'registered-wallet-output'
        )
        OR
        (
            signing_key <> wallet_id
            AND binding_tx_hash = canonical_funding_txid
            AND binding_output_index = canonical_funding_vout
            AND canonical_input_binding_kind = 'deposit-binding'
        )
    ),
    canonical_provenance_fingerprint bytea NOT NULL CHECK (
        octet_length(canonical_provenance_fingerprint) = 32
    ),
    canonical_provenance_manifest_hash bytea NOT NULL CHECK (
        octet_length(canonical_provenance_manifest_hash) = 32
        AND canonical_provenance_manifest_hash = activation_manifest_hash
    ),
    router_challenge_absent boolean NOT NULL CHECK (router_challenge_absent),
    complete_exact_challenge_authorization_absent boolean NOT NULL CHECK (
        complete_exact_challenge_authorization_absent
    ),
    complete_exact_transaction_authorization_absent boolean NOT NULL CHECK (
        complete_exact_transaction_authorization_absent
    ),
    complete_wallet_reservation_active boolean NOT NULL,
    complete_active_reservation_challenge_identity bytea CHECK (
        complete_active_reservation_challenge_identity IS NULL
        OR octet_length(complete_active_reservation_challenge_identity) = 32
    ),
    wallet_challengeable boolean NOT NULL CHECK (wallet_challengeable),
    canonical_proof_backlog_complete boolean NOT NULL CHECK (canonical_proof_backlog_complete),
    submitted_event_scan_from_block bigint NOT NULL CHECK (
        submitted_event_scan_from_block >= 0
        AND submitted_event_scan_from_block <= ethereum_lifecycle_block_number
    ),
    confirmed_source_complete boolean NOT NULL CHECK (confirmed_source_complete),

    status text NOT NULL CHECK (status IN (
        'queued',
        'preparing',
        'prepared',
        'broadcast-pending',
        'external-satisfied-awaiting-own-transaction',
        'accepted-own',
        'satisfied-external',
        'terminal-reverted',
        'terminal-nonce-consumed',
        'generation-required',
        'cancelled-before-broadcast',
        'cancelled-honest-spend',
        'cancelled-reorg',
        'cancelled-provenance-invalidated',
        'provenance-invalidated-awaiting-reconciliation',
        'quarantined'
    )),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at_unix_ms bigint NOT NULL CHECK (
        created_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    updated_at_unix_ms bigint NOT NULL CHECK (
        updated_at_unix_ms BETWEEN created_at_unix_ms AND 9007199254740991
    ),

    preparation_attempts integer NOT NULL DEFAULT 0 CHECK (preparation_attempts >= 0),
    preparation_lease_owner text CHECK (
        preparation_lease_owner IS NULL
        OR length(preparation_lease_owner) BETWEEN 1 AND 128
    ),
    preparation_lease_expires_at_unix_ms bigint CHECK (
        preparation_lease_expires_at_unix_ms IS NULL
        OR preparation_lease_expires_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    preparation_resume_status text CHECK (
        preparation_resume_status IN ('prepared', 'broadcast-pending')
    ),

    selected_signer_lane_id text CHECK (
        selected_signer_lane_id IS NULL
        OR length(selected_signer_lane_id) BETWEEN 1 AND 128
    ),
    selected_signer_identity text CHECK (
        selected_signer_identity IS NULL
        OR length(selected_signer_identity) BETWEEN 1 AND 128
    ),
    selected_sender bytea CHECK (
        selected_sender IS NULL OR octet_length(selected_sender) = 20
    ),

    nonce_reservation_id bytea CHECK (
        nonce_reservation_id IS NULL OR octet_length(nonce_reservation_id) = 32
    ),
    signer_lane_id text CHECK (
        signer_lane_id IS NULL OR length(signer_lane_id) BETWEEN 1 AND 128
    ),
    signer_identity text CHECK (
        signer_identity IS NULL OR length(signer_identity) BETWEEN 1 AND 128
    ),
    reserved_sender bytea CHECK (
        reserved_sender IS NULL OR octet_length(reserved_sender) = 20
    ),
    reserved_nonce numeric(78, 0) CHECK (
        reserved_nonce IS NULL OR reserved_nonce >= 0
    ),
    nonce_reservation_binding bytea CHECK (
        nonce_reservation_binding IS NULL
        OR octet_length(nonce_reservation_binding) > 0
    ),
    nonce_reserved_at_unix_ms bigint CHECK (
        nonce_reserved_at_unix_ms IS NULL
        OR nonce_reserved_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    signer_invocation_started_at_unix_ms bigint CHECK (
        signer_invocation_started_at_unix_ms IS NULL
        OR signer_invocation_started_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    -- Deterministic identity of the boundary the marker below names, committed
    -- in the same swap. The activation barrier counts outstanding invocations
    -- by the marker's NULL transitions alone, so the two must be NULL together
    -- or the counter stops meaning "a signer call may be outstanding".
    signer_invocation_id bytea CHECK (
        signer_invocation_id IS NULL
        OR octet_length(signer_invocation_id) = 32
    ),
    active_signer_invocation_started_at_unix_ms bigint CHECK (
        active_signer_invocation_started_at_unix_ms IS NULL
        OR active_signer_invocation_started_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    active_signer_invocation_id bytea CHECK (
        active_signer_invocation_id IS NULL
        OR octet_length(active_signer_invocation_id) = 32
    ),
    CHECK (
        (active_signer_invocation_started_at_unix_ms IS NULL)
            = (active_signer_invocation_id IS NULL)
    ),
    -- The historical pair is deliberately NOT required to agree. The active
    -- pair drives the barrier counter and must be exact; the historical marker
    -- is proof that some signer call began, and a failure record may have to
    -- assert that from a fallback clock when no identity survived.
    CHECK (
        signer_invocation_id IS NULL
        OR signer_invocation_started_at_unix_ms IS NOT NULL
    ),
    latest_variant_sequence smallint CHECK (
        latest_variant_sequence IS NULL
        OR latest_variant_sequence BETWEEN 0 AND 15
    ),
    prepared_transaction_hash bytea CHECK (
        prepared_transaction_hash IS NULL
        OR octet_length(prepared_transaction_hash) = 32
    ),

    nonce_disposition_id bytea CHECK (
        nonce_disposition_id IS NULL
        OR octet_length(nonce_disposition_id) = 32
    ),
    lane_released_at_unix_ms bigint CHECK (
        lane_released_at_unix_ms IS NULL
        OR lane_released_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    cancellation_evidence_id bytea CHECK (
        cancellation_evidence_id IS NULL
        OR octet_length(cancellation_evidence_id) = 32
    ),
    provenance_invalidation_id bytea CHECK (
        provenance_invalidation_id IS NULL
        OR octet_length(provenance_invalidation_id) = 32
    ),
    signer_quarantine_id bytea CHECK (
        signer_quarantine_id IS NULL
        OR octet_length(signer_quarantine_id) = 32
    ),

    broadcast_attempts integer NOT NULL DEFAULT 0 CHECK (broadcast_attempts >= 0),
    last_broadcast_at_unix_ms bigint CHECK (
        last_broadcast_at_unix_ms IS NULL
        OR last_broadcast_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0),
    last_reconciliation_at_unix_ms bigint CHECK (
        last_reconciliation_at_unix_ms IS NULL
        OR last_reconciliation_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    last_pre_broadcast_recheck_at_unix_ms bigint CHECK (
        last_pre_broadcast_recheck_at_unix_ms IS NULL
        OR last_pre_broadcast_recheck_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    last_pre_broadcast_recheck_status text CHECK (
        last_pre_broadcast_recheck_status IN (
            'eligible',
            'unknown',
            'cancelled-honest-spend',
            'cancelled-reorg'
        )
    ),
    last_resolution_status text CHECK (last_resolution_status IN (
        'pending',
        'unknown',
        'accepted-own',
        'satisfied-external',
        'external-satisfied-awaiting-own-transaction',
        'terminal-reverted',
        'terminal-nonce-consumed'
    )),
    last_error text CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 1024),
    record_state jsonb NOT NULL CHECK (jsonb_typeof(record_state) = 'object'),

    UNIQUE (record_id, generation),
    UNIQUE (record_id, generation, series_id),
    UNIQUE (
        record_id,
        fee_policy_hash,
        activation_manifest_hash,
        chain_id,
        value_wei
    ),
    UNIQUE (
        record_id,
        observation_id,
        bitcoin_tx_hash,
        bitcoin_wtxid,
        bitcoin_input_index,
        bitcoin_block_hash,
        bitcoin_block_height,
        canonical_candidate_digest,
        canonical_candidate_provenance_generation,
        canonical_provenance_fingerprint,
        canonical_provenance_manifest_hash
    ),
    UNIQUE (series_id, generation),
    UNIQUE (
        chain_id,
        router_address,
        bridge_challenge_key,
        observation_id,
        intent_input_index,
        bitcoin_tx_hash,
        bitcoin_wtxid,
        canonical_candidate_provenance_generation,
        generation
    ),
    UNIQUE (previous_record_id),
    CHECK (
        (generation = 0 AND previous_record_id IS NULL AND generation_cause IS NULL
            AND prior_nonce_disposition_id IS NULL
            AND prior_cancellation_evidence_id IS NULL
            AND prior_provenance_invalidation_id IS NULL)
        OR
        (generation > 0 AND previous_record_id IS NOT NULL AND generation_cause IS NOT NULL
            AND (
                (generation_cause IN ('finalized-revert', 'finalized-nonce-consumed')
                    AND prior_nonce_disposition_id IS NOT NULL
                    AND prior_cancellation_evidence_id IS NULL
                    AND prior_provenance_invalidation_id IS NULL)
                OR
                (generation_cause = 'canonical-reappearance'
                    AND prior_nonce_disposition_id IS NULL
                    AND prior_cancellation_evidence_id IS NOT NULL
                    AND prior_provenance_invalidation_id IS NULL)
                OR
                (generation_cause = 'provenance-restored'
                    AND prior_nonce_disposition_id IS NULL
                    AND prior_cancellation_evidence_id IS NULL
                    AND prior_provenance_invalidation_id IS NOT NULL)
            ))
    ),
    CHECK (
        num_nonnulls(
            selected_signer_lane_id,
            selected_signer_identity,
            selected_sender
        ) IN (0, 3)
    ),
    CHECK (
        num_nonnulls(
            nonce_reservation_id,
            signer_lane_id,
            signer_identity,
            reserved_sender,
            reserved_nonce,
            nonce_reservation_binding,
            nonce_reserved_at_unix_ms
        ) IN (0, 7)
    ),
    CHECK (
        nonce_reservation_id IS NULL
        OR (
            selected_signer_lane_id = signer_lane_id
            AND selected_signer_identity = signer_identity
            AND selected_sender = reserved_sender
        )
    ),
    CHECK (
        signer_invocation_started_at_unix_ms IS NULL
        OR (
            nonce_reservation_id IS NOT NULL
            AND signer_invocation_started_at_unix_ms >= nonce_reserved_at_unix_ms
        )
    ),
    CHECK (
        nonce_reservation_id IS NULL
        OR status NOT IN (
            'queued',
            'cancelled-before-broadcast',
            'cancelled-honest-spend',
            'cancelled-reorg',
            'cancelled-provenance-invalidated'
        )
    ),
    CHECK (
        selected_signer_lane_id IS NULL
        OR status = 'preparing'
        OR nonce_reservation_id IS NOT NULL
    ),
    CHECK (
        active_signer_invocation_started_at_unix_ms IS NULL
        OR (
            nonce_reservation_id IS NOT NULL
            AND active_signer_invocation_started_at_unix_ms >=
                nonce_reserved_at_unix_ms
        )
    ),
    CHECK (
        (latest_variant_sequence IS NULL) =
        (prepared_transaction_hash IS NULL)
    ),
    CHECK (
        prepared_transaction_hash IS NULL
        OR signer_invocation_started_at_unix_ms IS NOT NULL
    ),
    CHECK (
        status NOT IN (
            'prepared',
            'broadcast-pending',
            'external-satisfied-awaiting-own-transaction'
        )
        OR prepared_transaction_hash IS NOT NULL
    ),
    CHECK (
        (status = 'preparing') =
        (preparation_lease_owner IS NOT NULL
            AND preparation_lease_expires_at_unix_ms IS NOT NULL)
    ),
    CHECK (
        preparation_resume_status IS NULL
        OR (status = 'preparing' AND prepared_transaction_hash IS NOT NULL)
    ),
    CHECK (
        num_nonnulls(nonce_disposition_id, lane_released_at_unix_ms) IN (0, 2)
    ),
    CHECK (
        status NOT IN (
            'accepted-own',
            'satisfied-external',
            'terminal-reverted',
            'terminal-nonce-consumed',
            'generation-required'
        )
        OR nonce_disposition_id IS NOT NULL
    ),
    CHECK (
        nonce_disposition_id IS NULL
        OR status IN (
            'accepted-own',
            'satisfied-external',
            'terminal-reverted',
            'terminal-nonce-consumed',
            'generation-required'
        )
    ),
    CHECK (
        status NOT IN ('cancelled-honest-spend', 'cancelled-reorg')
        OR (
            cancellation_evidence_id IS NOT NULL
            AND selected_signer_lane_id IS NULL
            AND nonce_reservation_id IS NULL
            AND signer_invocation_started_at_unix_ms IS NULL
            AND prepared_transaction_hash IS NULL
            AND broadcast_attempts = 0
        )
    ),
    CHECK (
        cancellation_evidence_id IS NULL
        OR status IN ('cancelled-honest-spend', 'cancelled-reorg')
    ),
    CHECK (
        provenance_invalidation_id IS NULL
        OR status IN (
            'preparing',
            'cancelled-provenance-invalidated',
            'provenance-invalidated-awaiting-reconciliation',
            'accepted-own',
            'satisfied-external',
            'terminal-reverted',
            'terminal-nonce-consumed',
            'generation-required'
        )
    ),
    CHECK (
        status NOT IN (
            'cancelled-provenance-invalidated',
            'provenance-invalidated-awaiting-reconciliation'
        )
        OR provenance_invalidation_id IS NOT NULL
    ),
    CHECK (
        (complete_wallet_reservation_active
            AND complete_active_reservation_challenge_identity IS NOT NULL
            AND complete_active_reservation_challenge_identity <>
                bridge_challenge_identity)
        OR
        (NOT complete_wallet_reservation_active
            AND complete_active_reservation_challenge_identity IS NULL)
    ),
    CHECK (
        status <> 'cancelled-before-broadcast'
        OR (
            cancellation_evidence_id IS NULL
            AND selected_signer_lane_id IS NULL
            AND nonce_reservation_id IS NULL
            AND signer_invocation_started_at_unix_ms IS NULL
            AND prepared_transaction_hash IS NULL
            AND broadcast_attempts = 0
            AND last_error IS NOT NULL
        )
    ),
    CHECK (
        status <> 'quarantined'
        OR signer_invocation_started_at_unix_ms IS NULL
        OR signer_quarantine_id IS NOT NULL
    ),
    CHECK (
        broadcast_attempts = 0
        OR (prepared_transaction_hash IS NOT NULL AND last_broadcast_at_unix_ms IS NOT NULL)
    ),
    CHECK (status <> 'broadcast-pending' OR broadcast_attempts > 0),
    CHECK (
        (last_pre_broadcast_recheck_at_unix_ms IS NULL) =
        (last_pre_broadcast_recheck_status IS NULL)
    )
);

-- Every normalized state version is retained automatically, including
-- manifest-rotation and rollback transitions executed entirely inside SQL.
CREATE TABLE p2tr_signature_fraud_challenge_outbox_state_history (
    record_id bytea NOT NULL CHECK (octet_length(record_id) = 32),
    version bigint NOT NULL CHECK (version >= 0),
    status text NOT NULL,
    normalized_state jsonb NOT NULL CHECK (
        jsonb_typeof(normalized_state) = 'object'
    ),
    state_digest bytea NOT NULL CHECK (octet_length(state_digest) = 32),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (record_id, version),
    FOREIGN KEY (record_id)
        REFERENCES p2tr_signature_fraud_challenge_outbox(record_id)
        ON DELETE RESTRICT
);

CREATE FUNCTION p2tr_signature_fraud_capture_outbox_state_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    state jsonb;
BEGIN
    state := NEW.record_state || jsonb_build_object(
        'status', NEW.status,
        'version', NEW.version,
        'updatedAtUnixMs', NEW.updated_at_unix_ms,
        'lastError', NEW.last_error
    );
    INSERT INTO p2tr_signature_fraud_challenge_outbox_state_history (
        record_id,
        version,
        status,
        normalized_state,
        state_digest
    ) VALUES (
        NEW.record_id,
        NEW.version,
        NEW.status,
        state,
        sha256(convert_to(state::text, 'UTF8'))
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_capture_outbox_state_history_trigger
AFTER INSERT OR UPDATE ON p2tr_signature_fraud_challenge_outbox
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_capture_outbox_state_history();

-- Signer lanes exist independently from queued generations. Activation must
-- be able to prove that an empty outbox still has at least one healthy,
-- manifest-bound sender with an immutable code/configuration and fee/value
-- envelope. Historical manifest rows remain as an append-only audit trail.
CREATE FUNCTION p2tr_signature_fraud_signer_lane_configuration_hash(
    _activation_manifest_hash bytea,
    _chain_id numeric,
    _policy_hash bytea,
    _signer_lane_id text,
    _signer_identity text,
    _sender bytea,
    _challenge_value_wei numeric,
    _max_gas_limit numeric,
    _max_fee_per_gas numeric,
    _max_priority_fee_per_gas numeric,
    _max_total_fee_wei numeric,
    _signer_code_hash bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(convert_to(
        '{"activationManifestHash":' ||
            to_json(('0x' || encode(_activation_manifest_hash, 'hex'))::text)::text ||
        ',"chainID":' || _chain_id::text ||
        ',"challengeValueWei":' || to_json(_challenge_value_wei::text)::text ||
        ',"domain":"tbtc-p2tr-production-signer-lane-configuration-v1"' ||
        ',"laneID":' || to_json(_signer_lane_id)::text ||
        ',"maxFeePerGas":' || to_json(_max_fee_per_gas::text)::text ||
        ',"maxGasLimit":' || to_json(_max_gas_limit::text)::text ||
        ',"maxPriorityFeePerGas":' || to_json(_max_priority_fee_per_gas::text)::text ||
        ',"maxTotalFeeWei":' || to_json(_max_total_fee_wei::text)::text ||
        ',"policyHash":' ||
            to_json(('0x' || encode(_policy_hash, 'hex'))::text)::text ||
        ',"sender":' || to_json(('0x' || encode(_sender, 'hex'))::text)::text ||
        ',"signerCodeHash":' ||
            to_json(('0x' || encode(_signer_code_hash, 'hex'))::text)::text ||
        ',"signerIdentity":' || to_json(_signer_identity)::text ||
        '}',
        'UTF8'
    ));
$$;

CREATE TABLE p2tr_signature_fraud_signer_lane_configuration (
    activation_manifest_hash bytea NOT NULL CHECK (
        octet_length(activation_manifest_hash) = 32
    ),
    chain_id numeric(78, 0) NOT NULL CHECK (
        chain_id BETWEEN 1 AND 9007199254740991
    ),
    policy_hash bytea NOT NULL CHECK (octet_length(policy_hash) = 32),
    signer_lane_id text NOT NULL CHECK (length(signer_lane_id) BETWEEN 1 AND 128),
    signer_identity text NOT NULL CHECK (length(signer_identity) BETWEEN 1 AND 128),
    sender bytea NOT NULL CHECK (octet_length(sender) = 20),
    challenge_value_wei numeric(78, 0) NOT NULL CHECK (
        challenge_value_wei >= 0
        AND challenge_value_wei <=
            115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    max_gas_limit numeric(78, 0) NOT NULL CHECK (
        max_gas_limit BETWEEN 1 AND
            115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    max_fee_per_gas numeric(78, 0) NOT NULL CHECK (
        max_fee_per_gas BETWEEN 1 AND
            115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    max_priority_fee_per_gas numeric(78, 0) NOT NULL CHECK (
        max_priority_fee_per_gas >= 0
        AND max_priority_fee_per_gas <= max_fee_per_gas
    ),
    max_total_fee_wei numeric(78, 0) NOT NULL CHECK (
        max_total_fee_wei BETWEEN 1 AND
            115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    signer_code_hash bytea NOT NULL CHECK (octet_length(signer_code_hash) = 32),
    configuration_hash bytea NOT NULL CHECK (
        octet_length(configuration_hash) = 32
        AND configuration_hash =
            p2tr_signature_fraud_signer_lane_configuration_hash(
                activation_manifest_hash,
                chain_id,
                policy_hash,
                signer_lane_id,
                signer_identity,
                sender,
                challenge_value_wei,
                max_gas_limit,
                max_fee_per_gas,
                max_priority_fee_per_gas,
                max_total_fee_wei,
                signer_code_hash
            )
    ),
    enabled boolean NOT NULL CHECK (enabled),
    configured_at_unix_ms bigint NOT NULL CHECK (
        configured_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (activation_manifest_hash, chain_id, signer_lane_id),
    UNIQUE (activation_manifest_hash, chain_id, signer_identity),
    UNIQUE (activation_manifest_hash, chain_id, sender),
    UNIQUE (
        activation_manifest_hash,
        chain_id,
        signer_lane_id,
        signer_identity,
        sender,
        policy_hash,
        signer_code_hash,
        configuration_hash
    ),
    UNIQUE (
        activation_manifest_hash,
        chain_id,
        policy_hash,
        challenge_value_wei,
        signer_lane_id,
        signer_identity,
        sender,
        max_gas_limit,
        max_fee_per_gas,
        max_priority_fee_per_gas,
        max_total_fee_wei
    )
);

-- Every configured signer lane is pinned to an activation-manifest fee and
-- exact challenge-value envelope before any nonce can be selected or signed.
CREATE TABLE p2tr_signature_fraud_challenge_fee_policy (
    record_id bytea NOT NULL,
    policy_hash bytea NOT NULL CHECK (octet_length(policy_hash) = 32),
    activation_manifest_hash bytea NOT NULL CHECK (
        octet_length(activation_manifest_hash) = 32
    ),
    chain_id numeric(78, 0) NOT NULL CHECK (
        chain_id BETWEEN 1 AND 9007199254740991
    ),
    challenge_value_wei numeric(78, 0) NOT NULL CHECK (
        challenge_value_wei BETWEEN 0 AND
            115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    signer_lane_id text NOT NULL CHECK (length(signer_lane_id) BETWEEN 1 AND 128),
    signer_identity text NOT NULL CHECK (length(signer_identity) BETWEEN 1 AND 128),
    sender bytea NOT NULL CHECK (octet_length(sender) = 20),
    max_gas_limit numeric(78, 0) NOT NULL CHECK (
        max_gas_limit BETWEEN 1 AND
            115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    max_fee_per_gas numeric(78, 0) NOT NULL CHECK (
        max_fee_per_gas BETWEEN 1 AND
            115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    max_priority_fee_per_gas numeric(78, 0) NOT NULL CHECK (
        max_priority_fee_per_gas >= 0
        AND max_priority_fee_per_gas <= max_fee_per_gas
    ),
    max_total_fee_wei numeric(78, 0) NOT NULL CHECK (
        max_total_fee_wei BETWEEN 1 AND
            115792089237316195423570985008687907853269984665640564039457584007913129639935
    ),
    PRIMARY KEY (record_id, signer_lane_id),
    UNIQUE (record_id, signer_identity),
    UNIQUE (record_id, sender),
    UNIQUE (
        record_id,
        signer_lane_id,
        signer_identity,
        sender,
        policy_hash
    ),
    FOREIGN KEY (
        record_id,
        policy_hash,
        activation_manifest_hash,
        chain_id,
        challenge_value_wei
    ) REFERENCES p2tr_signature_fraud_challenge_outbox (
        record_id,
        fee_policy_hash,
        activation_manifest_hash,
        chain_id,
        value_wei
    ) ON DELETE RESTRICT
    ,
    FOREIGN KEY (
        activation_manifest_hash,
        chain_id,
        policy_hash,
        challenge_value_wei,
        signer_lane_id,
        signer_identity,
        sender,
        max_gas_limit,
        max_fee_per_gas,
        max_priority_fee_per_gas,
        max_total_fee_wei
    ) REFERENCES p2tr_signature_fraud_signer_lane_configuration (
        activation_manifest_hash,
        chain_id,
        policy_hash,
        challenge_value_wei,
        signer_lane_id,
        signer_identity,
        sender,
        max_gas_limit,
        max_fee_per_gas,
        max_priority_fee_per_gas,
        max_total_fee_wei
    ) ON DELETE RESTRICT
);

-- A nonce guard is inserted and committed before invoking the signer. It is
-- never deleted, so neither a normal reservation nor an escaped wrong-sender
-- envelope can cause the same sender/nonce pair to be reused.
CREATE TABLE p2tr_signature_fraud_challenge_nonce_guard (
    nonce_guard_id bytea PRIMARY KEY CHECK (octet_length(nonce_guard_id) = 32),
    record_id bytea NOT NULL REFERENCES p2tr_signature_fraud_challenge_outbox(record_id) ON DELETE RESTRICT,
    guard_kind text NOT NULL CHECK (guard_kind IN (
        'bound-reservation',
        'escaped-envelope'
    )),
    chain_id numeric(78, 0) NOT NULL CHECK (chain_id > 0),
    signer_lane_id text NOT NULL CHECK (length(signer_lane_id) BETWEEN 1 AND 128),
    signer_identity text NOT NULL CHECK (length(signer_identity) BETWEEN 1 AND 128),
    sender bytea NOT NULL CHECK (octet_length(sender) = 20),
    transaction_nonce numeric(78, 0) NOT NULL CHECK (transaction_nonce >= 0),
    reservation_epoch integer CHECK (
        reservation_epoch IS NULL OR reservation_epoch BETWEEN 1 AND 2147483647
    ),
    reservation_binding bytea CHECK (
        reservation_binding IS NULL OR octet_length(reservation_binding) > 0
    ),
    parent_reservation_id bytea REFERENCES p2tr_signature_fraud_challenge_nonce_guard(nonce_guard_id) ON DELETE RESTRICT,
    guarded_at_unix_ms bigint NOT NULL CHECK (
        guarded_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    voided_before_sign_at_unix_ms bigint CHECK (
        voided_before_sign_at_unix_ms IS NULL
        OR voided_before_sign_at_unix_ms BETWEEN guarded_at_unix_ms AND 9007199254740991
    ),
    void_reason text CHECK (
        void_reason IS NULL OR void_reason IN (
            'reservation-abandoned',
            'reservation-expired',
            'reservation-provider-rejected',
            'reservation-binding-invalid'
        )
    ),
    void_evidence_digest bytea CHECK (
        void_evidence_digest IS NULL OR octet_length(void_evidence_digest) = 32
    ),
    UNIQUE (
        record_id,
        nonce_guard_id,
        chain_id,
        sender,
        transaction_nonce,
        signer_lane_id,
        signer_identity
    ),
    CHECK (
        num_nonnulls(
            voided_before_sign_at_unix_ms,
            void_reason,
            void_evidence_digest
        ) IN (0, 3)
    ),
    CHECK (
        (guard_kind = 'bound-reservation'
            AND reservation_binding IS NOT NULL
            AND reservation_epoch IS NOT NULL
            AND parent_reservation_id IS NULL)
        OR
        (guard_kind = 'escaped-envelope'
            AND reservation_binding IS NULL
            AND reservation_epoch IS NULL
            AND parent_reservation_id IS NOT NULL
            AND voided_before_sign_at_unix_ms IS NULL)
    )
);

CREATE UNIQUE INDEX p2tr_signature_fraud_one_bound_reservation_per_record_idx
    ON p2tr_signature_fraud_challenge_nonce_guard (record_id)
    WHERE guard_kind = 'bound-reservation'
      AND voided_before_sign_at_unix_ms IS NULL;

CREATE UNIQUE INDEX p2tr_signature_fraud_unresolved_nonce_guard_idx
    ON p2tr_signature_fraud_challenge_nonce_guard (
        chain_id,
        sender,
        transaction_nonce
    )
    WHERE voided_before_sign_at_unix_ms IS NULL;

-- The allocator release request is committed in the same transaction as the
-- pre-sign nonce-guard tombstone. Attempts and results are append-only, so a
-- crash before, during, or after provider I/O is distinguishable and retryable
-- with one stable idempotency key.
CREATE TABLE p2tr_signature_fraud_challenge_nonce_release_request (
    release_request_id bytea PRIMARY KEY CHECK (octet_length(release_request_id) = 32),
    allocator_idempotency_key bytea NOT NULL UNIQUE CHECK (
        octet_length(allocator_idempotency_key) = 32
        AND allocator_idempotency_key = release_request_id
    ),
    record_id bytea NOT NULL,
    generation integer NOT NULL CHECK (generation BETWEEN 0 AND 31),
    nonce_guard_id bytea NOT NULL UNIQUE CHECK (octet_length(nonce_guard_id) = 32),
    chain_id numeric(78, 0) NOT NULL CHECK (chain_id > 0),
    signer_lane_id text NOT NULL CHECK (length(signer_lane_id) BETWEEN 1 AND 128),
    signer_identity text NOT NULL CHECK (length(signer_identity) BETWEEN 1 AND 128),
    sender bytea NOT NULL CHECK (octet_length(sender) = 20),
    transaction_nonce numeric(78, 0) NOT NULL CHECK (transaction_nonce >= 0),
    reservation_epoch integer NOT NULL CHECK (
        reservation_epoch BETWEEN 1 AND 2147483647
    ),
    void_evidence_digest bytea NOT NULL CHECK (octet_length(void_evidence_digest) = 32),
    requested_at_unix_ms bigint NOT NULL CHECK (
        requested_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    UNIQUE (record_id, release_request_id),
    FOREIGN KEY (record_id, generation)
        REFERENCES p2tr_signature_fraud_challenge_outbox(record_id, generation)
        ON DELETE RESTRICT,
    FOREIGN KEY (
        record_id,
        nonce_guard_id,
        chain_id,
        sender,
        transaction_nonce,
        signer_lane_id,
        signer_identity
    ) REFERENCES p2tr_signature_fraud_challenge_nonce_guard (
        record_id,
        nonce_guard_id,
        chain_id,
        sender,
        transaction_nonce,
        signer_lane_id,
        signer_identity
    ) ON DELETE RESTRICT
);

CREATE TABLE p2tr_signature_fraud_challenge_nonce_release_attempt (
    release_request_id bytea NOT NULL REFERENCES p2tr_signature_fraud_challenge_nonce_release_request(release_request_id) ON DELETE RESTRICT,
    attempt_sequence integer NOT NULL CHECK (attempt_sequence BETWEEN 1 AND 1000000),
    owner text NOT NULL CHECK (
        length(owner) BETWEEN 1 AND 128
        AND owner ~ '^[!-~]([ -~]{0,126}[!-~])?$'
    ),
    started_at_unix_ms bigint NOT NULL CHECK (
        started_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    expires_at_unix_ms bigint NOT NULL CHECK (
        expires_at_unix_ms BETWEEN started_at_unix_ms + 1 AND 9007199254740991
    ),
    PRIMARY KEY (release_request_id, attempt_sequence)
);

-- The attempt row is a reclaimable pre-I/O lease. This separate append-only
-- marker is the irreversible boundary proving that its owner may have entered
-- the allocator. A resultless invocation is never expired by wall clock: it
-- remains activation-blocking until the exact caller journals a result or an
-- operator supplies a future, independently fenced recovery migration.
CREATE TABLE p2tr_signature_fraud_challenge_nonce_release_invocation (
    release_request_id bytea NOT NULL,
    attempt_sequence integer NOT NULL,
    owner text NOT NULL CHECK (
        length(owner) BETWEEN 1 AND 128
        AND owner ~ '^[!-~]([ -~]{0,126}[!-~])?$'
    ),
    invoked_at_unix_ms bigint NOT NULL CHECK (
        invoked_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (release_request_id, attempt_sequence),
    FOREIGN KEY (release_request_id, attempt_sequence)
        REFERENCES p2tr_signature_fraud_challenge_nonce_release_attempt(
            release_request_id,
            attempt_sequence
        ) ON DELETE RESTRICT
);

CREATE TABLE p2tr_signature_fraud_challenge_nonce_release_result (
    release_request_id bytea NOT NULL,
    attempt_sequence integer NOT NULL,
    result_kind text NOT NULL CHECK (result_kind IN (
        'released',
        'already-released',
        'ambiguous-error',
        'ambiguous-late',
        'contract-mismatch'
    )),
    returned_release_request_id bytea CHECK (
        returned_release_request_id IS NULL
        OR octet_length(returned_release_request_id) = 32
    ),
    returned_reservation_id bytea CHECK (
        returned_reservation_id IS NULL
        OR octet_length(returned_reservation_id) = 32
    ),
    response_digest bytea NOT NULL CHECK (octet_length(response_digest) = 32),
    detail_digest bytea NOT NULL CHECK (octet_length(detail_digest) = 32),
    recorded_at_unix_ms bigint NOT NULL CHECK (
        recorded_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (release_request_id, attempt_sequence),
    FOREIGN KEY (release_request_id, attempt_sequence)
        REFERENCES p2tr_signature_fraud_challenge_nonce_release_attempt(
            release_request_id,
            attempt_sequence
        ) ON DELETE RESTRICT,
    CHECK (
        (result_kind IN ('released', 'already-released')
            AND returned_release_request_id IS NOT NULL
            AND returned_reservation_id IS NOT NULL
            AND returned_release_request_id = release_request_id
        )
        OR
        (result_kind NOT IN ('released', 'already-released')
            AND (
                (result_kind = 'ambiguous-late'
                    AND returned_release_request_id IS NOT NULL
                    AND returned_reservation_id IS NOT NULL)
                OR
                (result_kind = 'contract-mismatch')
                OR
                (result_kind = 'ambiguous-error'
                    AND returned_release_request_id IS NULL
                    AND returned_reservation_id IS NULL)
            ))
    )
);

-- Independently verified terminal evidence for an invoked release whose
-- original RPC returned ambiguously. The two attestations must come from
-- distinct trust and independence domains and are immutable once appended.
CREATE TABLE p2tr_signature_fraud_challenge_nonce_release_resolution (
    release_request_id bytea NOT NULL,
    attempt_sequence integer NOT NULL,
    attempt_owner text NOT NULL CHECK (
        length(attempt_owner) BETWEEN 1 AND 128
        AND attempt_owner ~ '^[!-~]([ -~]{0,126}[!-~])?$'
    ),
    attempt_started_at_unix_ms bigint NOT NULL CHECK (
        attempt_started_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    attempt_expires_at_unix_ms bigint NOT NULL CHECK (
        attempt_expires_at_unix_ms BETWEEN attempt_started_at_unix_ms + 1
            AND 9007199254740991
    ),
    invoked_at_unix_ms bigint NOT NULL CHECK (
        invoked_at_unix_ms BETWEEN attempt_started_at_unix_ms
            AND attempt_expires_at_unix_ms
    ),
    outcome text NOT NULL CHECK (outcome IN (
        'released', 'already-released', 'terminal-unsafe'
    )),
    provider_evidence_digest bytea NOT NULL CHECK (
        octet_length(provider_evidence_digest) = 32
    ),
    resolution_evidence_digest bytea NOT NULL CHECK (
        octet_length(resolution_evidence_digest) = 32
    ),
    primary_trust_domain_id text NOT NULL CHECK (
        length(primary_trust_domain_id) BETWEEN 1 AND 128
    ),
    primary_independence_domain_id text NOT NULL CHECK (
        length(primary_independence_domain_id) BETWEEN 1 AND 128
    ),
    primary_evidence_digest bytea NOT NULL CHECK (
        octet_length(primary_evidence_digest) = 32
    ),
    primary_attestation bytea NOT NULL CHECK (
        octet_length(primary_attestation) BETWEEN 1 AND 2048
    ),
    primary_attested_at_unix_ms bigint NOT NULL CHECK (
        primary_attested_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    corroborating_trust_domain_id text NOT NULL CHECK (
        length(corroborating_trust_domain_id) BETWEEN 1 AND 128
    ),
    corroborating_independence_domain_id text NOT NULL CHECK (
        length(corroborating_independence_domain_id) BETWEEN 1 AND 128
    ),
    corroborating_evidence_digest bytea NOT NULL CHECK (
        octet_length(corroborating_evidence_digest) = 32
    ),
    corroborating_attestation bytea NOT NULL CHECK (
        octet_length(corroborating_attestation) BETWEEN 1 AND 2048
    ),
    corroborating_attested_at_unix_ms bigint NOT NULL CHECK (
        corroborating_attested_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    resolved_at_unix_ms bigint NOT NULL CHECK (
        resolved_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (release_request_id, attempt_sequence),
    FOREIGN KEY (release_request_id, attempt_sequence)
        REFERENCES p2tr_signature_fraud_challenge_nonce_release_invocation(
            release_request_id,
            attempt_sequence
        ) ON DELETE RESTRICT,
    CHECK (primary_trust_domain_id <> corroborating_trust_domain_id),
    CHECK (primary_evidence_digest = resolution_evidence_digest),
    CHECK (corroborating_evidence_digest = resolution_evidence_digest),
    CHECK (
        primary_independence_domain_id <>
            corroborating_independence_domain_id
    ),
    CHECK (primary_attestation <> corroborating_attestation)
);

CREATE VIEW p2tr_signature_fraud_challenge_nonce_release_terminal AS
SELECT release_request_id, attempt_sequence, result_kind AS outcome
  FROM p2tr_signature_fraud_challenge_nonce_release_result
 WHERE result_kind IN ('released', 'already-released')
UNION ALL
SELECT release_request_id, attempt_sequence, outcome
  FROM p2tr_signature_fraud_challenge_nonce_release_resolution
 WHERE outcome IN ('released', 'already-released');

-- External nonce-release and signer calls never run inside a database
-- transaction, so their mutually exclusive durable claims live here. A
-- release invocation is committed before allocator I/O; a signer claim is
-- committed before signer I/O. Contract mismatch permanently flips the same singleton
-- to no-go, eliminating stale-snapshot races between unrelated lanes.
CREATE TABLE p2tr_signature_fraud_nonce_allocator_safety_barrier (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    active_release_request_id bytea CHECK (
        active_release_request_id IS NULL
        OR octet_length(active_release_request_id) = 32
    ),
    active_release_attempt_sequence integer CHECK (
        active_release_attempt_sequence IS NULL
        OR active_release_attempt_sequence BETWEEN 1 AND 1000000
    ),
    active_release_expires_at_unix_ms bigint CHECK (
        active_release_expires_at_unix_ms IS NULL
        OR active_release_expires_at_unix_ms BETWEEN 1 AND 9007199254740991
    ),
    active_signer_invocation_count integer NOT NULL DEFAULT 0 CHECK (
        active_signer_invocation_count BETWEEN 0 AND 1000000
    ),
    unresolved_release_count integer NOT NULL DEFAULT 0 CHECK (
        unresolved_release_count BETWEEN 0 AND 1000000
    ),
    contract_mismatch_blocked boolean NOT NULL DEFAULT false,
    incident_epoch bigint NOT NULL DEFAULT 0 CHECK (
        incident_epoch BETWEEN 0 AND 9007199254740991
    ),
    CHECK (
        num_nonnulls(
            active_release_request_id,
            active_release_attempt_sequence,
            active_release_expires_at_unix_ms
        ) IN (0, 3)
    ),
    FOREIGN KEY (
        active_release_request_id,
        active_release_attempt_sequence
    ) REFERENCES p2tr_signature_fraud_challenge_nonce_release_attempt (
        release_request_id,
        attempt_sequence
    ) DEFERRABLE INITIALLY DEFERRED
);

INSERT INTO p2tr_signature_fraud_nonce_allocator_safety_barrier (
    singleton,
    active_signer_invocation_count,
    unresolved_release_count,
    contract_mismatch_blocked,
    incident_epoch
) VALUES (true, 0, 0, false, 0);

CREATE INDEX p2tr_signature_fraud_pending_nonce_release_idx
    ON p2tr_signature_fraud_challenge_nonce_release_request (release_request_id);

-- Every signed EIP-1559 envelope is an immutable, generation-scoped identity.
-- Reconciliation scans all variants; the main row only caches the latest key.
CREATE TABLE p2tr_signature_fraud_challenge_outbox_variant (
    record_id bytea NOT NULL,
    generation integer NOT NULL CHECK (generation BETWEEN 0 AND 31),
    variant_sequence smallint NOT NULL CHECK (variant_sequence BETWEEN 0 AND 15),
    raw_transaction bytea NOT NULL CHECK (
        octet_length(raw_transaction) BETWEEN 1 AND 4096
    ),
    transaction_hash bytea NOT NULL CHECK (octet_length(transaction_hash) = 32),
    sender bytea NOT NULL CHECK (octet_length(sender) = 20),
    transaction_nonce numeric(78, 0) NOT NULL CHECK (transaction_nonce >= 0),
    transaction_type smallint NOT NULL CHECK (transaction_type = 2),
    gas_limit numeric(78, 0) NOT NULL CHECK (gas_limit > 0),
    max_fee_per_gas numeric(78, 0) NOT NULL CHECK (max_fee_per_gas > 0),
    max_priority_fee_per_gas numeric(78, 0) NOT NULL CHECK (
        max_priority_fee_per_gas >= 0
        AND max_priority_fee_per_gas <= max_fee_per_gas
    ),
    signed_at_unix_ms bigint NOT NULL CHECK (
        signed_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (record_id, generation, variant_sequence),
    UNIQUE (record_id, generation, transaction_hash),
    UNIQUE (record_id, generation, variant_sequence, transaction_hash),
    UNIQUE (transaction_hash),
    FOREIGN KEY (record_id, generation)
        REFERENCES p2tr_signature_fraud_challenge_outbox(record_id, generation)
        ON DELETE RESTRICT
);

-- Attempt rows are committed before calling the provider. A missing immutable
-- acknowledgement is the durable ambiguous-broadcast state.
CREATE TABLE p2tr_signature_fraud_challenge_outbox_broadcast_attempt (
    record_id bytea NOT NULL,
    generation integer NOT NULL CHECK (generation BETWEEN 0 AND 31),
    variant_sequence smallint NOT NULL CHECK (variant_sequence BETWEEN 0 AND 15),
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
    attempted_at_unix_ms bigint NOT NULL CHECK (
        attempted_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (record_id, generation, variant_sequence, attempt_number),
    FOREIGN KEY (record_id, generation, variant_sequence)
        REFERENCES p2tr_signature_fraud_challenge_outbox_variant(record_id, generation, variant_sequence)
        ON DELETE RESTRICT
);

CREATE TABLE p2tr_signature_fraud_challenge_outbox_broadcast_acknowledgement (
    record_id bytea NOT NULL,
    generation integer NOT NULL CHECK (generation BETWEEN 0 AND 31),
    variant_sequence smallint NOT NULL CHECK (variant_sequence BETWEEN 0 AND 15),
    attempt_number integer NOT NULL CHECK (attempt_number > 0),
    result text NOT NULL CHECK (result IN ('accepted', 'rejected', 'ambiguous')),
    returned_transaction_hash bytea CHECK (
        returned_transaction_hash IS NULL
        OR octet_length(returned_transaction_hash) = 32
    ),
    error text CHECK (error IS NULL OR length(error) BETWEEN 1 AND 1024),
    acknowledged_at_unix_ms bigint NOT NULL CHECK (
        acknowledged_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (record_id, generation, variant_sequence, attempt_number),
    FOREIGN KEY (record_id, generation, variant_sequence, attempt_number)
        REFERENCES p2tr_signature_fraud_challenge_outbox_broadcast_attempt(record_id, generation, variant_sequence, attempt_number)
        ON DELETE RESTRICT,
    FOREIGN KEY (record_id, generation, variant_sequence, returned_transaction_hash)
        REFERENCES p2tr_signature_fraud_challenge_outbox_variant(record_id, generation, variant_sequence, transaction_hash)
        ON DELETE RESTRICT,
    CHECK (
        (result = 'accepted' AND returned_transaction_hash IS NOT NULL AND error IS NULL)
        OR
        (result IN ('rejected', 'ambiguous') AND returned_transaction_hash IS NULL AND error IS NOT NULL)
    )
);

-- Cancellation evidence records exact canonical facts. Independent adapters
-- attest the same digest and pinned cursors in separate append-only rows.
CREATE TABLE p2tr_signature_fraud_challenge_cancellation_evidence (
    cancellation_evidence_id bytea PRIMARY KEY CHECK (octet_length(cancellation_evidence_id) = 32),
    record_id bytea NOT NULL UNIQUE REFERENCES p2tr_signature_fraud_challenge_outbox(record_id) ON DELETE RESTRICT,
    evidence_kind text NOT NULL CHECK (evidence_kind IN (
        'honest-spend',
        'canonical-reorg'
    )),
    evidence_digest bytea NOT NULL CHECK (octet_length(evidence_digest) = 32),
    prior_bitcoin_tx_hash bytea NOT NULL CHECK (octet_length(prior_bitcoin_tx_hash) = 32),
    prior_bitcoin_wtxid bytea NOT NULL CHECK (octet_length(prior_bitcoin_wtxid) = 32),
    prior_bitcoin_input_index bigint NOT NULL CHECK (
        prior_bitcoin_input_index BETWEEN 0 AND 4294967295
    ),
    prior_bitcoin_block_hash bytea NOT NULL CHECK (octet_length(prior_bitcoin_block_hash) = 32),
    prior_bitcoin_block_height bigint NOT NULL CHECK (prior_bitcoin_block_height >= 0),
    bitcoin_cursor_block_hash bytea NOT NULL CHECK (octet_length(bitcoin_cursor_block_hash) = 32),
    bitcoin_cursor_block_height bigint NOT NULL CHECK (
        bitcoin_cursor_block_height >= prior_bitcoin_block_height
    ),
    ethereum_cursor_block_hash bytea NOT NULL CHECK (octet_length(ethereum_cursor_block_hash) = 32),
    ethereum_cursor_block_number bigint NOT NULL CHECK (ethereum_cursor_block_number >= 0),
    replacement_bitcoin_block_hash bytea CHECK (
        replacement_bitcoin_block_hash IS NULL
        OR octet_length(replacement_bitcoin_block_hash) = 32
    ),
    replacement_bitcoin_block_height bigint CHECK (
        replacement_bitcoin_block_height IS NULL
        OR replacement_bitcoin_block_height >= 0
    ),
    conflicting_outpoint_tx_hash bytea CHECK (
        conflicting_outpoint_tx_hash IS NULL
        OR octet_length(conflicting_outpoint_tx_hash) = 32
    ),
    conflicting_outpoint_index bigint CHECK (
        conflicting_outpoint_index IS NULL
        OR conflicting_outpoint_index BETWEEN 0 AND 4294967295
    ),
    canonical_spend_tx_hash bytea CHECK (
        canonical_spend_tx_hash IS NULL
        OR octet_length(canonical_spend_tx_hash) = 32
    ),
    canonical_spend_wtxid bytea CHECK (
        canonical_spend_wtxid IS NULL
        OR octet_length(canonical_spend_wtxid) = 32
    ),
    canonical_spend_block_hash bytea CHECK (
        canonical_spend_block_hash IS NULL
        OR octet_length(canonical_spend_block_hash) = 32
    ),
    canonical_spend_block_height bigint CHECK (
        canonical_spend_block_height IS NULL
        OR canonical_spend_block_height >= 0
    ),
    canonical_spend_input_index bigint CHECK (
        canonical_spend_input_index IS NULL
        OR canonical_spend_input_index BETWEEN 0 AND 4294967295
    ),
    bridge_proof_transaction_hash bytea CHECK (
        bridge_proof_transaction_hash IS NULL
        OR octet_length(bridge_proof_transaction_hash) = 32
    ),
    bridge_proof_block_hash bytea CHECK (
        bridge_proof_block_hash IS NULL
        OR octet_length(bridge_proof_block_hash) = 32
    ),
    bridge_proof_block_number bigint CHECK (
        bridge_proof_block_number IS NULL
        OR bridge_proof_block_number >= 0
    ),
    bridge_proof_log_index bigint CHECK (
        bridge_proof_log_index IS NULL
        OR bridge_proof_log_index >= 0
    ),
    bridge_proof_type text CHECK (
        bridge_proof_type IS NULL OR length(bridge_proof_type) BETWEEN 1 AND 128
    ),
    verified_at_unix_ms bigint NOT NULL CHECK (
        verified_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    UNIQUE (record_id, cancellation_evidence_id),
    UNIQUE (
        cancellation_evidence_id,
        evidence_digest,
        bitcoin_cursor_block_hash,
        bitcoin_cursor_block_height,
        ethereum_cursor_block_hash,
        ethereum_cursor_block_number
    ),
    CHECK (
        (evidence_kind = 'honest-spend'
            AND num_nonnulls(
                conflicting_outpoint_tx_hash,
                conflicting_outpoint_index,
                canonical_spend_tx_hash,
                canonical_spend_wtxid,
                canonical_spend_block_hash,
                canonical_spend_block_height,
                canonical_spend_input_index,
                bridge_proof_transaction_hash,
                bridge_proof_block_hash,
                bridge_proof_block_number,
                bridge_proof_log_index,
                bridge_proof_type
            ) = 12
            AND bitcoin_cursor_block_height >= canonical_spend_block_height
            AND ethereum_cursor_block_number >= bridge_proof_block_number
            AND replacement_bitcoin_block_hash IS NULL
            AND replacement_bitcoin_block_height IS NULL)
        OR
        (evidence_kind = 'canonical-reorg'
            AND replacement_bitcoin_block_hash IS NOT NULL
            AND replacement_bitcoin_block_height IS NOT NULL
            AND bitcoin_cursor_block_height >= replacement_bitcoin_block_height
            AND num_nonnulls(
                conflicting_outpoint_tx_hash,
                conflicting_outpoint_index,
                canonical_spend_tx_hash,
                canonical_spend_wtxid,
                canonical_spend_block_hash,
                canonical_spend_block_height,
                canonical_spend_input_index,
                bridge_proof_transaction_hash,
                bridge_proof_block_hash,
                bridge_proof_block_number,
                bridge_proof_log_index,
                bridge_proof_type
            ) = 0)
    )
);

CREATE TABLE p2tr_signature_fraud_challenge_cancellation_attestation (
    cancellation_evidence_id bytea NOT NULL,
    trust_domain_id text NOT NULL CHECK (length(trust_domain_id) BETWEEN 1 AND 128),
    independence_domain_id text NOT NULL CHECK (
        length(independence_domain_id) BETWEEN 1 AND 128
    ),
    evidence_digest bytea NOT NULL CHECK (octet_length(evidence_digest) = 32),
    bitcoin_cursor_block_hash bytea NOT NULL CHECK (octet_length(bitcoin_cursor_block_hash) = 32),
    bitcoin_cursor_block_height bigint NOT NULL CHECK (bitcoin_cursor_block_height >= 0),
    ethereum_cursor_block_hash bytea NOT NULL CHECK (octet_length(ethereum_cursor_block_hash) = 32),
    ethereum_cursor_block_number bigint NOT NULL CHECK (ethereum_cursor_block_number >= 0),
    attestation bytea NOT NULL CHECK (octet_length(attestation) > 0),
    attested_at_unix_ms bigint NOT NULL CHECK (
        attested_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (cancellation_evidence_id, trust_domain_id),
    UNIQUE (cancellation_evidence_id, independence_domain_id),
    FOREIGN KEY (
        cancellation_evidence_id,
        evidence_digest,
        bitcoin_cursor_block_hash,
        bitcoin_cursor_block_height,
        ethereum_cursor_block_hash,
        ethereum_cursor_block_number
    ) REFERENCES p2tr_signature_fraud_challenge_cancellation_evidence (
        cancellation_evidence_id,
        evidence_digest,
        bitcoin_cursor_block_hash,
        bitcoin_cursor_block_height,
        ethereum_cursor_block_hash,
        ethereum_cursor_block_number
    ) ON DELETE RESTRICT
);

-- A canonical Ethereum rollback or manifest rotation invalidates the exact
-- provenance certificate, never merely a transaction hash alias. The source
-- tombstone ID is retained even when the canonical-index implementation keeps
-- its tombstone in a separate append-only journal table.
CREATE TABLE p2tr_signature_fraud_challenge_provenance_invalidation (
    provenance_invalidation_id bytea NOT NULL CHECK (
        octet_length(provenance_invalidation_id) = 32
    ),
    record_id bytea NOT NULL UNIQUE,
    provenance_tombstone_id bytea NOT NULL CHECK (
        octet_length(provenance_tombstone_id) = 32
    ),
    observation_id bytea NOT NULL CHECK (octet_length(observation_id) = 32),
    bitcoin_tx_hash bytea NOT NULL CHECK (octet_length(bitcoin_tx_hash) = 32),
    bitcoin_wtxid bytea NOT NULL CHECK (octet_length(bitcoin_wtxid) = 32),
    bitcoin_input_index bigint NOT NULL CHECK (
        bitcoin_input_index BETWEEN 0 AND 4294967295
    ),
    bitcoin_block_hash bytea NOT NULL CHECK (octet_length(bitcoin_block_hash) = 32),
    bitcoin_block_height bigint NOT NULL CHECK (bitcoin_block_height >= 0),
    canonical_candidate_digest bytea NOT NULL CHECK (
        octet_length(canonical_candidate_digest) = 32
    ),
    canonical_candidate_provenance_generation bigint NOT NULL CHECK (
        canonical_candidate_provenance_generation > 0
    ),
    canonical_provenance_fingerprint bytea NOT NULL CHECK (
        octet_length(canonical_provenance_fingerprint) = 32
    ),
    canonical_provenance_manifest_hash bytea NOT NULL CHECK (
        octet_length(canonical_provenance_manifest_hash) = 32
    ),
    ethereum_rollback_block_hash bytea NOT NULL CHECK (
        octet_length(ethereum_rollback_block_hash) = 32
    ),
    ethereum_rollback_block_number bigint NOT NULL CHECK (
        ethereum_rollback_block_number >= 0
    ),
    provenance_invalidation_sequence bigint NOT NULL CHECK (
        provenance_invalidation_sequence > 0
    ),
    evidence_digest bytea NOT NULL CHECK (octet_length(evidence_digest) = 32),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1024),
    invalidated_at_unix_ms bigint NOT NULL CHECK (
        invalidated_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    invalidation_source text NOT NULL CHECK (invalidation_source IN (
        'canonical-rollback',
        'manifest-rotation'
    )),
    PRIMARY KEY (record_id, provenance_invalidation_id),
    UNIQUE (
        record_id,
        provenance_invalidation_id,
        canonical_provenance_fingerprint
    ),
    UNIQUE (record_id, provenance_invalidation_id),
    FOREIGN KEY (
        record_id,
        observation_id,
        bitcoin_tx_hash,
        bitcoin_wtxid,
        bitcoin_input_index,
        bitcoin_block_hash,
        bitcoin_block_height,
        canonical_candidate_digest,
        canonical_candidate_provenance_generation,
        canonical_provenance_fingerprint,
        canonical_provenance_manifest_hash
    ) REFERENCES p2tr_signature_fraud_challenge_outbox (
        record_id,
        observation_id,
        bitcoin_tx_hash,
        bitcoin_wtxid,
        bitcoin_input_index,
        bitcoin_block_hash,
        bitcoin_block_height,
        canonical_candidate_digest,
        canonical_candidate_provenance_generation,
        canonical_provenance_fingerprint,
        canonical_provenance_manifest_hash
    ) ON DELETE RESTRICT
);

CREATE TABLE p2tr_signature_fraud_challenge_provenance_incident (
    incident_id bytea PRIMARY KEY CHECK (octet_length(incident_id) = 32),
    record_id bytea NOT NULL,
    provenance_invalidation_id bytea NOT NULL,
    incident_kind text NOT NULL CHECK (incident_kind IN (
        'reservation-intent-in-flight',
        'signer-boundary-active',
        'signed-envelope-escaped',
        'broadcast-attempt-active',
        'terminal-chain-effect',
        'manifest-rotation-signed-state'
    )),
    details_digest bytea NOT NULL CHECK (octet_length(details_digest) = 32),
    activation_blocking boolean NOT NULL CHECK (activation_blocking),
    created_at_unix_ms bigint NOT NULL CHECK (
        created_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    UNIQUE (record_id, provenance_invalidation_id, incident_kind),
    FOREIGN KEY (record_id, provenance_invalidation_id)
        REFERENCES p2tr_signature_fraud_challenge_provenance_invalidation(
            record_id,
            provenance_invalidation_id
        ) ON DELETE RESTRICT
);

-- Retirement evidence for an incident raised over a boundary that provably
-- never reached the signer.
--
-- An incident is raised the moment invalidation observes an active boundary,
-- because `active_signer_invocation_started_at_unix_ms` is made durable BEFORE
-- boundary authorization and therefore before any signer call: at that instant
-- the store genuinely cannot distinguish "stuck in authorization" from "signer
-- call outstanding". That ambiguity is resolvable only by the boundary's own
-- owner, which is the single witness that authorization failed before any
-- signer I/O. The same first-person observation is already trusted to clear the
-- singleton signer barrier, so it is equally sufficient to retire the incident.
--
-- A lease timeout is NOT such evidence and can never produce a row here.
CREATE TABLE p2tr_signature_fraud_challenge_provenance_incident_resolution (
    incident_id bytea PRIMARY KEY
        REFERENCES p2tr_signature_fraud_challenge_provenance_incident(incident_id)
        ON DELETE RESTRICT,
    record_id bytea NOT NULL,
    provenance_invalidation_id bytea NOT NULL,
    -- The exact boundary this resolution speaks for. Retiring an incident
    -- raised over a different boundary must be impossible. Carries the same
    -- deterministic identity as the signer-boundary resolution committed in the
    -- same transaction, so one retirement cannot name two boundaries.
    signer_invocation_id bytea NOT NULL CHECK (
        octet_length(signer_invocation_id) = 32
    ),
    boundary_started_at_unix_ms bigint NOT NULL CHECK (
        boundary_started_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    preparation_attempts integer NOT NULL CHECK (preparation_attempts >= 0),
    nonce_reservation_id bytea NOT NULL CHECK (
        octet_length(nonce_reservation_id) = 32
    ),
    resolution_digest bytea NOT NULL CHECK (
        octet_length(resolution_digest) = 32
    ),
    resolved_at_unix_ms bigint NOT NULL CHECK (
        resolved_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    FOREIGN KEY (record_id, provenance_invalidation_id)
        REFERENCES p2tr_signature_fraud_challenge_provenance_invalidation(
            record_id,
            provenance_invalidation_id
        ) ON DELETE RESTRICT
);

-- Defence in depth: even a buggy or malicious caller must not be able to retire
-- an incident for a record that carries ANY escape evidence. This mirrors the
-- `hasPriorSignedState` predicate in the TypeScript uninvoked-completion path,
-- and is enforced against the durable row rather than the caller's claim.
CREATE FUNCTION p2tr_signature_fraud_guard_provenance_incident_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    escaped boolean;
BEGIN
    SELECT
        outbox.signer_invocation_started_at_unix_ms IS NOT NULL
        OR outbox.prepared_transaction_hash IS NOT NULL
        OR outbox.broadcast_attempts > 0
        OR coalesce(
               jsonb_array_length(
                   outbox.record_state -> 'unexpectedSignedArtifacts'
               ),
               0
           ) > 0
      INTO escaped
      FROM p2tr_signature_fraud_challenge_outbox outbox
     WHERE outbox.record_id = NEW.record_id
     FOR SHARE;

    IF escaped IS NULL THEN
        RAISE EXCEPTION
            'provenance incident resolution names an absent outbox record';
    END IF;
    IF escaped THEN
        RAISE EXCEPTION
            'provenance incident resolution requires a boundary with no signer escape evidence';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_signature_fraud_guard_provenance_incident_resolution_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_provenance_incident_resolution
FOR EACH ROW
EXECUTE FUNCTION p2tr_signature_fraud_guard_provenance_incident_resolution();

-- Independently verified terminal evidence for one exact ORPHANED signer
-- boundary: the durable pre-I/O marker whose owning process died before any
-- signer result could be witnessed.
--
-- `active_signer_invocation_started_at_unix_ms` is committed BEFORE boundary
-- authorization and therefore before the signer RPC, so a lost owner leaves the
-- singleton `active_signer_invocation_count` at one. That blocks every
-- nonce-release invocation store-wide and freezes challenge signing on every
-- lane. Lease expiry is not evidence and can never produce a row here; only an
-- out-of-band observation of what the signer actually did, carrying two
-- attestations from distinct trust AND independence domains, may.
--
-- The two attestations are immutable once appended, exactly like the ambiguous
-- nonce-release resolution this table mirrors.
CREATE TABLE p2tr_signature_fraud_challenge_signer_boundary_resolution (
    record_id bytea NOT NULL
        REFERENCES p2tr_signature_fraud_challenge_outbox(record_id)
        ON DELETE RESTRICT,
    -- The exact boundary this resolution speaks for. Resolving a boundary the
    -- durable row does not currently own must be impossible. The identity is
    -- the invocation ID; the three fields after it are operator-facing detail,
    -- bound into the evidence digest but no longer deciding ownership.
    signer_invocation_id bytea NOT NULL CHECK (
        octet_length(signer_invocation_id) = 32
    ),
    boundary_started_at_unix_ms bigint NOT NULL CHECK (
        boundary_started_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    preparation_attempts integer NOT NULL CHECK (preparation_attempts >= 0),
    nonce_reservation_id bytea NOT NULL CHECK (
        octet_length(nonce_reservation_id) = 32
    ),
    stage text NOT NULL CHECK (stage IN ('prepare', 'replacement')),
    invoked_at_unix_ms bigint NOT NULL CHECK (
        invoked_at_unix_ms BETWEEN boundary_started_at_unix_ms
            AND 9007199254740991
    ),
    outcome text NOT NULL CHECK (outcome IN (
        'never-invoked', 'signed', 'terminal-unsafe'
    )),
    signed_transaction_hash bytea CHECK (
        signed_transaction_hash IS NULL
        OR octet_length(signed_transaction_hash) = 32
    ),
    provider_evidence_digest bytea NOT NULL CHECK (
        octet_length(provider_evidence_digest) = 32
    ),
    resolution_evidence_digest bytea NOT NULL CHECK (
        octet_length(resolution_evidence_digest) = 32
    ),
    primary_trust_domain_id text NOT NULL CHECK (
        length(primary_trust_domain_id) BETWEEN 1 AND 128
    ),
    primary_independence_domain_id text NOT NULL CHECK (
        length(primary_independence_domain_id) BETWEEN 1 AND 128
    ),
    primary_evidence_digest bytea NOT NULL CHECK (
        octet_length(primary_evidence_digest) = 32
    ),
    primary_attestation bytea NOT NULL CHECK (
        octet_length(primary_attestation) BETWEEN 1 AND 2048
    ),
    primary_attested_at_unix_ms bigint NOT NULL CHECK (
        primary_attested_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    corroborating_trust_domain_id text NOT NULL CHECK (
        length(corroborating_trust_domain_id) BETWEEN 1 AND 128
    ),
    corroborating_independence_domain_id text NOT NULL CHECK (
        length(corroborating_independence_domain_id) BETWEEN 1 AND 128
    ),
    corroborating_evidence_digest bytea NOT NULL CHECK (
        octet_length(corroborating_evidence_digest) = 32
    ),
    corroborating_attestation bytea NOT NULL CHECK (
        octet_length(corroborating_attestation) BETWEEN 1 AND 2048
    ),
    corroborating_attested_at_unix_ms bigint NOT NULL CHECK (
        corroborating_attested_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    resolved_at_unix_ms bigint NOT NULL CHECK (
        resolved_at_unix_ms BETWEEN invoked_at_unix_ms AND 9007199254740991
    ),
    -- Keyed on the deterministic invocation identity, not the wall-clock tuple
    -- it replaces. `record_id` stays as the leading column because this is the
    -- table's only index and two queries filter on it alone.
    PRIMARY KEY (record_id, signer_invocation_id),
    -- Signed bytes are named exactly when, and only when, the signer is proven
    -- to have produced them.
    CHECK ((outcome = 'signed') = (signed_transaction_hash IS NOT NULL)),
    CHECK (primary_trust_domain_id <> corroborating_trust_domain_id),
    CHECK (primary_evidence_digest = resolution_evidence_digest),
    CHECK (corroborating_evidence_digest = resolution_evidence_digest),
    CHECK (
        primary_independence_domain_id <>
            corroborating_independence_domain_id
    ),
    CHECK (primary_attestation <> corroborating_attestation)
);

-- Defence in depth, mirroring
-- `p2tr_signature_fraud_guard_provenance_incident_resolution`: even a buggy or
-- malicious caller must not be able to retire a boundary it does not currently
-- own, forge the evidence digest, or claim `never-invoked` for a record that
-- carries ANY escape evidence. Every predicate is evaluated against the durable
-- row rather than the caller's claim.
CREATE FUNCTION p2tr_signature_fraud_guard_signer_boundary_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    outbox_record p2tr_signature_fraud_challenge_outbox%ROWTYPE;
    escaped boolean;
BEGIN
    SELECT * INTO outbox_record
      FROM p2tr_signature_fraud_challenge_outbox
     WHERE record_id = NEW.record_id
     FOR SHARE;

    IF outbox_record.record_id IS NULL THEN
        RAISE EXCEPTION
            'orphaned signer boundary resolution names an absent outbox record';
    END IF;

    -- Identity is the invocation ID, compared against the durable column rather
    -- than re-derived: PostgreSQL cannot recompute it (the binding preimage
    -- spans three tables and a TypeScript layout), which is the same standard
    -- nonce_reservation_id already met.
    --
    -- The other three remain checked. They are descriptive columns of
    -- append-only evidence that nothing downstream reads, so leaving them
    -- unchecked would let a resolution naming the right boundary write
    -- permanently wrong forensics about it. None can drift while the marker is
    -- set: the start is immutable in flight and NULL-paired with the ID, the
    -- reservation cannot be NULLed under an active marker, and every transition
    -- that bumps the attempt clears the marker in the same swap.
    IF outbox_record.active_signer_invocation_id
           IS DISTINCT FROM NEW.signer_invocation_id
       OR outbox_record.active_signer_invocation_started_at_unix_ms
           IS DISTINCT FROM NEW.boundary_started_at_unix_ms
       OR outbox_record.preparation_attempts <> NEW.preparation_attempts
       OR outbox_record.nonce_reservation_id
           IS DISTINCT FROM NEW.nonce_reservation_id THEN
        RAISE EXCEPTION
            'orphaned signer boundary resolution does not name the durable boundary';
    END IF;

    IF NEW.resolution_evidence_digest <> sha256(
           convert_to(
               'tbtc-p2tr-signer-boundary-independent-resolution-v2',
               'UTF8'
           )
           || NEW.record_id
           || NEW.signer_invocation_id
           || int8send(NEW.boundary_started_at_unix_ms)
           || int8send(NEW.preparation_attempts::bigint)
           || NEW.nonce_reservation_id
           || sha256(convert_to(NEW.stage, 'UTF8'))
           || int8send(NEW.invoked_at_unix_ms)
           || sha256(convert_to(NEW.outcome, 'UTF8'))
           || COALESCE(
                  NEW.signed_transaction_hash,
                  decode(repeat('00', 32), 'hex')
              )
           || NEW.provider_evidence_digest
       ) THEN
        RAISE EXCEPTION
            'orphaned signer boundary resolution digest is invalid';
    END IF;

    IF NEW.primary_attested_at_unix_ms < NEW.invoked_at_unix_ms
       OR NEW.corroborating_attested_at_unix_ms < NEW.invoked_at_unix_ms
       OR NEW.primary_attested_at_unix_ms > NEW.resolved_at_unix_ms
       OR NEW.corroborating_attested_at_unix_ms > NEW.resolved_at_unix_ms THEN
        RAISE EXCEPTION
            'orphaned signer boundary attestations fall outside the invocation window';
    END IF;

    IF NEW.outcome = 'never-invoked' THEN
        escaped :=
            outbox_record.signer_invocation_started_at_unix_ms IS NOT NULL
            OR outbox_record.prepared_transaction_hash IS NOT NULL
            OR outbox_record.broadcast_attempts > 0
            OR coalesce(
                   jsonb_array_length(
                       outbox_record.record_state -> 'unexpectedSignedArtifacts'
                   ),
                   0
               ) > 0;
        IF escaped THEN
            RAISE EXCEPTION
                'orphaned signer boundary resolution requires a boundary with no signer escape evidence';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_signature_fraud_guard_signer_boundary_resolution_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_signer_boundary_resolution
FOR EACH ROW
EXECUTE FUNCTION p2tr_signature_fraud_guard_signer_boundary_resolution();

-- The lane can be released only after exact, finalized nonce-disposition
-- evidence has two independent attestations. Failed dispositions are also the
-- only nonce-related parents allowed to create a fresh generation.
CREATE TABLE p2tr_signature_fraud_challenge_nonce_disposition (
    nonce_disposition_id bytea PRIMARY KEY CHECK (octet_length(nonce_disposition_id) = 32),
    record_id bytea NOT NULL UNIQUE REFERENCES p2tr_signature_fraud_challenge_outbox(record_id) ON DELETE RESTRICT,
    generation integer NOT NULL CHECK (generation BETWEEN 0 AND 31),
    nonce_reservation_id bytea NOT NULL CHECK (octet_length(nonce_reservation_id) = 32),
    chain_id numeric(78, 0) NOT NULL CHECK (chain_id > 0),
    signer_lane_id text NOT NULL CHECK (length(signer_lane_id) BETWEEN 1 AND 128),
    signer_identity text NOT NULL CHECK (length(signer_identity) BETWEEN 1 AND 128),
    sender bytea NOT NULL CHECK (octet_length(sender) = 20),
    transaction_nonce numeric(78, 0) NOT NULL CHECK (transaction_nonce >= 0),
    disposition_kind text NOT NULL CHECK (disposition_kind IN (
        'finalized-reverted',
        'finalized-nonce-consumed',
        'finalized-accepted-own',
        'finalized-after-external-satisfaction'
    )),
    transaction_hash bytea NOT NULL CHECK (octet_length(transaction_hash) = 32),
    submitted_variant_sequence smallint CHECK (
        submitted_variant_sequence IS NULL
        OR submitted_variant_sequence BETWEEN 0 AND 15
    ),
    submitted_late_artifact_id bytea CHECK (
        submitted_late_artifact_id IS NULL
        OR octet_length(submitted_late_artifact_id) = 32
    ),
    transaction_receipt_status boolean,
    transaction_block_hash bytea NOT NULL CHECK (octet_length(transaction_block_hash) = 32),
    transaction_block_number bigint NOT NULL CHECK (transaction_block_number >= 0),
    transaction_index bigint CHECK (
        transaction_index IS NULL OR transaction_index >= 0
    ),
    finalized_through_block_hash bytea NOT NULL CHECK (octet_length(finalized_through_block_hash) = 32),
    finalized_through_block_number bigint NOT NULL CHECK (
        finalized_through_block_number >= transaction_block_number
    ),
    sender_account_nonce_at_finality numeric(78, 0) CHECK (
        sender_account_nonce_at_finality IS NULL
        OR sender_account_nonce_at_finality > transaction_nonce
    ),
    router_challenge_present boolean NOT NULL,
    external_challenge_transaction_hash bytea CHECK (
        external_challenge_transaction_hash IS NULL
        OR octet_length(external_challenge_transaction_hash) = 32
    ),
    external_challenge_block_hash bytea CHECK (
        external_challenge_block_hash IS NULL
        OR octet_length(external_challenge_block_hash) = 32
    ),
    external_challenge_block_number bigint CHECK (
        external_challenge_block_number IS NULL
        OR external_challenge_block_number >= 0
    ),
    external_challenge_log_index bigint CHECK (
        external_challenge_log_index IS NULL
        OR external_challenge_log_index >= 0
    ),
    evidence_digest bytea NOT NULL CHECK (octet_length(evidence_digest) = 32),
    verified_at_unix_ms bigint NOT NULL CHECK (
        verified_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    UNIQUE (record_id, nonce_disposition_id),
    UNIQUE (
        nonce_disposition_id,
        evidence_digest,
        finalized_through_block_hash,
        finalized_through_block_number
    ),
    FOREIGN KEY (record_id, generation)
        REFERENCES p2tr_signature_fraud_challenge_outbox(record_id, generation)
        ON DELETE RESTRICT,
    FOREIGN KEY (
        record_id,
        nonce_reservation_id,
        chain_id,
        sender,
        transaction_nonce,
        signer_lane_id,
        signer_identity
    ) REFERENCES p2tr_signature_fraud_challenge_nonce_guard (
        record_id,
        nonce_guard_id,
        chain_id,
        sender,
        transaction_nonce,
        signer_lane_id,
        signer_identity
    ) ON DELETE RESTRICT,
    FOREIGN KEY (record_id, generation, submitted_variant_sequence, transaction_hash)
        REFERENCES p2tr_signature_fraud_challenge_outbox_variant(record_id, generation, variant_sequence, transaction_hash)
        ON DELETE RESTRICT,
    CHECK (
        (disposition_kind = 'finalized-reverted'
            AND num_nonnulls(
                submitted_variant_sequence,
                submitted_late_artifact_id
            ) = 1
            AND transaction_receipt_status IS FALSE
            AND sender_account_nonce_at_finality IS NULL
            AND NOT router_challenge_present
            AND num_nonnulls(
                external_challenge_transaction_hash,
                external_challenge_block_hash,
                external_challenge_block_number,
                external_challenge_log_index
            ) = 0)
        OR
        (disposition_kind = 'finalized-nonce-consumed'
            AND submitted_variant_sequence IS NULL
            AND submitted_late_artifact_id IS NULL
            AND transaction_receipt_status IS NULL
            AND sender_account_nonce_at_finality IS NOT NULL
            AND NOT router_challenge_present
            AND num_nonnulls(
                external_challenge_transaction_hash,
                external_challenge_block_hash,
                external_challenge_block_number,
                external_challenge_log_index
            ) = 0)
        OR
        (disposition_kind = 'finalized-accepted-own'
            AND num_nonnulls(
                submitted_variant_sequence,
                submitted_late_artifact_id
            ) = 1
            AND transaction_receipt_status IS TRUE
            AND sender_account_nonce_at_finality IS NULL
            AND router_challenge_present
            AND num_nonnulls(
                external_challenge_transaction_hash,
                external_challenge_block_hash,
                external_challenge_block_number,
                external_challenge_log_index
            ) = 0)
        OR
        (disposition_kind = 'finalized-after-external-satisfaction'
            AND router_challenge_present
            AND num_nonnulls(
                external_challenge_transaction_hash,
                external_challenge_block_hash,
                external_challenge_block_number,
                external_challenge_log_index
            ) = 4)
    )
);

CREATE TABLE p2tr_signature_fraud_challenge_nonce_disposition_attestation (
    nonce_disposition_id bytea NOT NULL,
    trust_domain_id text NOT NULL CHECK (length(trust_domain_id) BETWEEN 1 AND 128),
    independence_domain_id text NOT NULL CHECK (
        length(independence_domain_id) BETWEEN 1 AND 128
    ),
    evidence_digest bytea NOT NULL CHECK (octet_length(evidence_digest) = 32),
    finalized_through_block_hash bytea NOT NULL CHECK (octet_length(finalized_through_block_hash) = 32),
    finalized_through_block_number bigint NOT NULL CHECK (finalized_through_block_number >= 0),
    attestation bytea NOT NULL CHECK (octet_length(attestation) > 0),
    attested_at_unix_ms bigint NOT NULL CHECK (
        attested_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (nonce_disposition_id, trust_domain_id),
    UNIQUE (nonce_disposition_id, independence_domain_id),
    FOREIGN KEY (
        nonce_disposition_id,
        evidence_digest,
        finalized_through_block_hash,
        finalized_through_block_number
    ) REFERENCES p2tr_signature_fraud_challenge_nonce_disposition (
        nonce_disposition_id,
        evidence_digest,
        finalized_through_block_hash,
        finalized_through_block_number
    ) ON DELETE RESTRICT
);

-- Signer quarantine is permanent and lane-scoped. A broken signer does not
-- disable independent senders, but it can never receive another reservation.
CREATE TABLE p2tr_signature_fraud_challenge_signer_quarantine (
    signer_quarantine_id bytea PRIMARY KEY CHECK (octet_length(signer_quarantine_id) = 32),
    record_id bytea NOT NULL REFERENCES p2tr_signature_fraud_challenge_outbox(record_id) ON DELETE RESTRICT,
    nonce_reservation_id bytea CHECK (
        nonce_reservation_id IS NULL OR octet_length(nonce_reservation_id) = 32
    ),
    chain_id numeric(78, 0) NOT NULL CHECK (chain_id > 0),
    signer_lane_id text NOT NULL CHECK (length(signer_lane_id) BETWEEN 1 AND 128),
    signer_identity text NOT NULL CHECK (length(signer_identity) BETWEEN 1 AND 128),
    expected_sender bytea NOT NULL CHECK (octet_length(expected_sender) = 20),
    expected_nonce numeric(78, 0) CHECK (
        expected_nonce IS NULL OR expected_nonce >= 0
    ),
    quarantine_reason text NOT NULL CHECK (quarantine_reason IN (
        'ambiguous-signer-invocation',
        'wrong-sender',
        'wrong-nonce',
        'malformed-signed-envelope',
        'wrong-signer-invocation-request',
        'invalid-replacement-envelope',
        'reservation-binding-mismatch',
        'reservation-provider-failure'
    )),
    details_digest bytea NOT NULL CHECK (octet_length(details_digest) = 32),
    quarantined_at_unix_ms bigint NOT NULL CHECK (
        quarantined_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    UNIQUE (record_id, signer_quarantine_id),
    UNIQUE (chain_id, signer_lane_id),
    UNIQUE (chain_id, signer_identity),
    FOREIGN KEY (
        record_id,
        nonce_reservation_id,
        chain_id,
        expected_sender,
        expected_nonce,
        signer_lane_id,
        signer_identity
    ) REFERENCES p2tr_signature_fraud_challenge_nonce_guard (
        record_id,
        nonce_guard_id,
        chain_id,
        sender,
        transaction_nonce,
        signer_lane_id,
        signer_identity
    ) ON DELETE RESTRICT,
    CHECK (
        (quarantine_reason IN (
            'reservation-binding-mismatch',
            'reservation-provider-failure'
        ) AND nonce_reservation_id IS NULL AND expected_nonce IS NULL)
        OR
        (quarantine_reason NOT IN (
            'reservation-binding-mismatch',
            'reservation-provider-failure'
        ) AND nonce_reservation_id IS NOT NULL AND expected_nonce IS NOT NULL)
    )
);

CREATE FUNCTION p2tr_signature_fraud_validate_signer_quarantine_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    record_manifest_hash bytea;
BEGIN
    SELECT activation_manifest_hash INTO record_manifest_hash
      FROM p2tr_signature_fraud_challenge_outbox
     WHERE record_id = NEW.record_id
     FOR SHARE;

    PERFORM 1
      FROM p2tr_signature_fraud_signer_lane_configuration
     WHERE activation_manifest_hash = record_manifest_hash
       AND chain_id = NEW.chain_id
       AND signer_lane_id = NEW.signer_lane_id
       AND signer_identity = NEW.signer_identity
       AND sender = NEW.expected_sender
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'signer quarantine lacks its exact manifest-bound lane';
    END IF;

    IF NEW.quarantine_reason IN (
        'reservation-binding-mismatch',
        'reservation-provider-failure'
    ) AND NEW.nonce_reservation_id IS NOT NULL THEN
        RAISE EXCEPTION 'pre-reservation quarantine cannot claim a durable nonce';
    END IF;

    IF NEW.quarantine_reason = 'reservation-provider-failure'
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_nonce_release_result x
             JOIN p2tr_signature_fraud_challenge_nonce_release_request r
               ON r.release_request_id = x.release_request_id
             LEFT JOIN p2tr_signature_fraud_challenge_nonce_guard returned_guard
               ON returned_guard.nonce_guard_id = x.returned_reservation_id
             LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_request returned_request
               ON returned_request.release_request_id = x.returned_release_request_id
            WHERE x.result_kind = 'contract-mismatch'
              AND (
                  (r.chain_id = NEW.chain_id
                   AND r.signer_lane_id = NEW.signer_lane_id
                   AND r.signer_identity = NEW.signer_identity
                   AND r.sender = NEW.expected_sender)
                  OR
                  (returned_guard.chain_id = NEW.chain_id
                   AND returned_guard.signer_lane_id = NEW.signer_lane_id
                   AND returned_guard.signer_identity = NEW.signer_identity
                   AND returned_guard.sender = NEW.expected_sender)
                  OR
                  (returned_request.chain_id = NEW.chain_id
                   AND returned_request.signer_lane_id = NEW.signer_lane_id
                   AND returned_request.signer_identity = NEW.signer_identity
                   AND returned_request.sender = NEW.expected_sender)
              )
       ) THEN
        RAISE EXCEPTION 'nonce allocator quarantine lacks an immutable contract mismatch';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_signer_quarantine_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_signer_quarantine
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_signer_quarantine_insert();

-- If a signer returns a valid envelope for an unexpected sender or nonce, the
-- exact bytes and the actual sender/nonce guard are retained forever.
CREATE TABLE p2tr_signature_fraud_challenge_escaped_envelope (
    escaped_envelope_id bytea PRIMARY KEY CHECK (octet_length(escaped_envelope_id) = 32),
    record_id bytea NOT NULL REFERENCES p2tr_signature_fraud_challenge_outbox(record_id) ON DELETE RESTRICT,
    signer_quarantine_id bytea NOT NULL CHECK (octet_length(signer_quarantine_id) = 32),
    expected_reservation_id bytea NOT NULL CHECK (octet_length(expected_reservation_id) = 32),
    actual_guard_record_id bytea NOT NULL CHECK (octet_length(actual_guard_record_id) = 32),
    actual_nonce_guard_id bytea NOT NULL CHECK (octet_length(actual_nonce_guard_id) = 32),
    chain_id numeric(78, 0) NOT NULL CHECK (chain_id > 0),
    signer_lane_id text NOT NULL CHECK (length(signer_lane_id) BETWEEN 1 AND 128),
    signer_identity text NOT NULL CHECK (length(signer_identity) BETWEEN 1 AND 128),
    expected_sender bytea NOT NULL CHECK (octet_length(expected_sender) = 20),
    expected_nonce numeric(78, 0) NOT NULL CHECK (expected_nonce >= 0),
    actual_sender bytea NOT NULL CHECK (octet_length(actual_sender) = 20),
    actual_nonce numeric(78, 0) NOT NULL CHECK (actual_nonce >= 0),
    actual_guard_signer_lane_id text NOT NULL CHECK (
        length(actual_guard_signer_lane_id) BETWEEN 1 AND 128
    ),
    actual_guard_signer_identity text NOT NULL CHECK (
        length(actual_guard_signer_identity) BETWEEN 1 AND 128
    ),
    transaction_type smallint NOT NULL CHECK (transaction_type IN (0, 1, 2)),
    raw_transaction bytea NOT NULL CHECK (
        octet_length(raw_transaction) BETWEEN 1 AND 4096
    ),
    transaction_hash bytea NOT NULL UNIQUE CHECK (octet_length(transaction_hash) = 32),
    captured_at_unix_ms bigint NOT NULL CHECK (
        captured_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    FOREIGN KEY (record_id, signer_quarantine_id)
        REFERENCES p2tr_signature_fraud_challenge_signer_quarantine(record_id, signer_quarantine_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (
        record_id,
        expected_reservation_id,
        chain_id,
        expected_sender,
        expected_nonce,
        signer_lane_id,
        signer_identity
    ) REFERENCES p2tr_signature_fraud_challenge_nonce_guard (
        record_id,
        nonce_guard_id,
        chain_id,
        sender,
        transaction_nonce,
        signer_lane_id,
        signer_identity
    ) ON DELETE RESTRICT,
    FOREIGN KEY (
        actual_guard_record_id,
        actual_nonce_guard_id,
        chain_id,
        actual_sender,
        actual_nonce,
        actual_guard_signer_lane_id,
        actual_guard_signer_identity
    ) REFERENCES p2tr_signature_fraud_challenge_nonce_guard (
        record_id,
        nonce_guard_id,
        chain_id,
        sender,
        transaction_nonce,
        signer_lane_id,
        signer_identity
    ) ON DELETE RESTRICT,
    CHECK (actual_sender <> expected_sender OR actual_nonce <> expected_nonce)
);

-- A signer can return the exact expected sender/nonce envelope after any
-- concurrent transition (including lease expiry or canonical invalidation)
-- has already won the normal state CAS. Those bytes are not a normal variant,
-- but they are still capable of reaching the network and are an immutable,
-- activation-blocking incident independent from the mutable outbox head.
CREATE TABLE p2tr_signature_fraud_challenge_late_signed_artifact (
    artifact_id bytea PRIMARY KEY CHECK (octet_length(artifact_id) = 32),
    record_id bytea NOT NULL,
    generation integer NOT NULL CHECK (generation BETWEEN 0 AND 31),
    expected_provenance_fingerprint bytea NOT NULL CHECK (
        octet_length(expected_provenance_fingerprint) = 32
    ),
    expected_reservation_id bytea NOT NULL CHECK (
        octet_length(expected_reservation_id) = 32
    ),
    chain_id numeric(78, 0) NOT NULL CHECK (chain_id > 0),
    signer_lane_id text NOT NULL CHECK (length(signer_lane_id) BETWEEN 1 AND 128),
    signer_identity text NOT NULL CHECK (length(signer_identity) BETWEEN 1 AND 128),
    intent_id bytea NOT NULL CHECK (octet_length(intent_id) = 32),
    raw_transaction bytea NOT NULL CHECK (
        octet_length(raw_transaction) BETWEEN 1 AND 4096
    ),
    transaction_hash bytea NOT NULL UNIQUE CHECK (
        octet_length(transaction_hash) = 32
    ),
    sender bytea NOT NULL CHECK (octet_length(sender) = 20),
    transaction_nonce numeric(78, 0) NOT NULL CHECK (transaction_nonce >= 0),
    transaction_type smallint NOT NULL CHECK (transaction_type = 2),
    gas_limit numeric(78, 0) NOT NULL CHECK (gas_limit > 0),
    max_fee_per_gas numeric(78, 0) NOT NULL CHECK (max_fee_per_gas > 0),
    max_priority_fee_per_gas numeric(78, 0) NOT NULL CHECK (
        max_priority_fee_per_gas >= 0
        AND max_priority_fee_per_gas <= max_fee_per_gas
    ),
    captured_at_unix_ms bigint NOT NULL CHECK (
        captured_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1024),
    reason_digest bytea NOT NULL CHECK (octet_length(reason_digest) = 32),
    UNIQUE (record_id, generation, transaction_hash),
    UNIQUE (record_id, generation, artifact_id, transaction_hash),
    FOREIGN KEY (record_id, generation)
        REFERENCES p2tr_signature_fraud_challenge_outbox(record_id, generation)
        ON DELETE RESTRICT,
    FOREIGN KEY (
        record_id,
        expected_reservation_id,
        chain_id,
        sender,
        transaction_nonce,
        signer_lane_id,
        signer_identity
    ) REFERENCES p2tr_signature_fraud_challenge_nonce_guard (
        record_id,
        nonce_guard_id,
        chain_id,
        sender,
        transaction_nonce,
        signer_lane_id,
        signer_identity
    ) ON DELETE RESTRICT
);

ALTER TABLE p2tr_signature_fraud_challenge_nonce_disposition
ADD CONSTRAINT p2tr_signature_fraud_disposition_late_artifact_fk
FOREIGN KEY (
    record_id,
    generation,
    submitted_late_artifact_id,
    transaction_hash
) REFERENCES p2tr_signature_fraud_challenge_late_signed_artifact (
    record_id,
    generation,
    artifact_id,
    transaction_hash
) DEFERRABLE INITIALLY DEFERRED;

-- Exhausting either bounded append-only ledger is a fail-closed activation
-- condition. Alerts are immutable and bind the exact intent series and
-- generation that requires operator intervention.
CREATE TABLE p2tr_signature_fraud_challenge_critical_alert (
    alert_id bytea PRIMARY KEY CHECK (octet_length(alert_id) = 32),
    series_id bytea NOT NULL CHECK (octet_length(series_id) = 32),
    record_id bytea NOT NULL,
    generation integer NOT NULL CHECK (generation BETWEEN 0 AND 31),
    code text NOT NULL CHECK (code IN (
        'generation-cap-exhausted',
        'signed-variant-cap-exhausted',
        'signed-state-quarantined',
        'late-signed-artifact-captured',
        'escaped-signed-envelope-captured',
        'reservation-release-failed',
        'nonce-release-terminal-unsafe',
        'signer-boundary-terminal-unsafe',
        'reservation-state-ambiguous',
        'nonce-reservation-cap-exhausted',
        'provenance-reconciliation-incident'
    )),
    details_digest bytea NOT NULL CHECK (octet_length(details_digest) = 32),
    created_at_unix_ms bigint NOT NULL CHECK (
        created_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    activation_blocking boolean NOT NULL CHECK (activation_blocking),
    UNIQUE (record_id, generation, code),
    FOREIGN KEY (record_id, generation, series_id)
        REFERENCES p2tr_signature_fraud_challenge_outbox(record_id, generation, series_id)
        ON DELETE RESTRICT,
    CHECK (code <> 'generation-cap-exhausted' OR generation = 31)
);

-- Alerts remain immutable. A separate append-only row may resolve only a
-- late expected-lane artifact after the exact nonce has an independently
-- attested final disposition. Unrecoverable cap/provider-contract alerts have
-- no admissible resolution path.
CREATE TABLE p2tr_signature_fraud_challenge_critical_alert_resolution (
    alert_id bytea PRIMARY KEY REFERENCES p2tr_signature_fraud_challenge_critical_alert(alert_id) ON DELETE RESTRICT,
    record_id bytea NOT NULL,
    generation integer NOT NULL CHECK (generation BETWEEN 0 AND 31),
    nonce_disposition_id bytea NOT NULL CHECK (octet_length(nonce_disposition_id) = 32),
    resolution_digest bytea NOT NULL CHECK (octet_length(resolution_digest) = 32),
    resolved_at_unix_ms bigint NOT NULL CHECK (
        resolved_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    FOREIGN KEY (record_id, generation)
        REFERENCES p2tr_signature_fraud_challenge_outbox(record_id, generation)
        ON DELETE RESTRICT,
    FOREIGN KEY (record_id, nonce_disposition_id)
        REFERENCES p2tr_signature_fraud_challenge_nonce_disposition(
            record_id,
            nonce_disposition_id
        ) ON DELETE RESTRICT
);

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_signature_fraud_bound_nonce_reservation_fk
FOREIGN KEY (
    record_id,
    nonce_reservation_id,
    chain_id,
    reserved_sender,
    reserved_nonce,
    signer_lane_id,
    signer_identity
) REFERENCES p2tr_signature_fraud_challenge_nonce_guard (
    record_id,
    nonce_guard_id,
    chain_id,
    sender,
    transaction_nonce,
    signer_lane_id,
    signer_identity
) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_signature_fraud_latest_variant_fk
FOREIGN KEY (
    record_id,
    generation,
    latest_variant_sequence,
    prepared_transaction_hash
) REFERENCES p2tr_signature_fraud_challenge_outbox_variant (
    record_id,
    generation,
    variant_sequence,
    transaction_hash
) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_signature_fraud_current_disposition_fk
FOREIGN KEY (record_id, nonce_disposition_id)
REFERENCES p2tr_signature_fraud_challenge_nonce_disposition(record_id, nonce_disposition_id)
DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_signature_fraud_prior_disposition_fk
FOREIGN KEY (previous_record_id, prior_nonce_disposition_id)
REFERENCES p2tr_signature_fraud_challenge_nonce_disposition(record_id, nonce_disposition_id)
DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_signature_fraud_current_cancellation_fk
FOREIGN KEY (record_id, cancellation_evidence_id)
REFERENCES p2tr_signature_fraud_challenge_cancellation_evidence(record_id, cancellation_evidence_id)
DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_signature_fraud_prior_cancellation_fk
FOREIGN KEY (previous_record_id, prior_cancellation_evidence_id)
REFERENCES p2tr_signature_fraud_challenge_cancellation_evidence(record_id, cancellation_evidence_id)
DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_signature_fraud_current_provenance_invalidation_fk
FOREIGN KEY (record_id, provenance_invalidation_id)
REFERENCES p2tr_signature_fraud_challenge_provenance_invalidation(
    record_id,
    provenance_invalidation_id
)
DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_signature_fraud_prior_provenance_invalidation_fk
FOREIGN KEY (previous_record_id, prior_provenance_invalidation_id)
REFERENCES p2tr_signature_fraud_challenge_provenance_invalidation(
    record_id,
    provenance_invalidation_id
)
DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_signature_fraud_signer_quarantine_fk
FOREIGN KEY (record_id, signer_quarantine_id)
REFERENCES p2tr_signature_fraud_challenge_signer_quarantine(record_id, signer_quarantine_id)
DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION p2tr_signature_fraud_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'P2TR challenge evidence is append-only';
END;
$$;

CREATE FUNCTION p2tr_signature_fraud_validate_critical_alert_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    expected_series_id bytea;
    expected_status text;
    expected_latest_variant_sequence smallint;
BEGIN
    SELECT series_id, status, latest_variant_sequence
    INTO expected_series_id, expected_status, expected_latest_variant_sequence
    FROM p2tr_signature_fraud_challenge_outbox
    WHERE record_id = NEW.record_id
      AND generation = NEW.generation
    FOR SHARE;

    IF expected_series_id IS NULL OR NEW.series_id <> expected_series_id THEN
        RAISE EXCEPTION 'critical alert is not bound to the exact P2TR challenge series';
    END IF;

    IF NEW.code = 'generation-cap-exhausted'
       AND expected_status NOT IN (
           'generation-required',
           'cancelled-reorg',
           'cancelled-provenance-invalidated'
       ) THEN
        RAISE EXCEPTION 'generation cap alert requires a terminal record eligible to reappear';
    END IF;

    IF NEW.code = 'signed-variant-cap-exhausted'
       AND expected_latest_variant_sequence IS DISTINCT FROM 15 THEN
        RAISE EXCEPTION 'signed-variant cap alert requires the final immutable variant';
    END IF;
    IF NEW.code = 'signed-state-quarantined'
       AND expected_latest_variant_sequence IS NULL
       AND expected_status <> 'quarantined' THEN
        RAISE EXCEPTION 'signed-state quarantine alert requires a signer boundary';
    END IF;
    IF NEW.code = 'late-signed-artifact-captured'
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_late_signed_artifact la
            WHERE la.record_id = NEW.record_id
              AND la.generation = NEW.generation
       ) THEN
        RAISE EXCEPTION 'late signer alert requires an immutable signed artifact';
    END IF;
    IF NEW.code = 'escaped-signed-envelope-captured'
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_escaped_envelope ee
            WHERE ee.record_id = NEW.record_id
       ) THEN
        RAISE EXCEPTION 'escaped signer alert requires an immutable wrong-lane envelope';
    END IF;
    IF NEW.code = 'reservation-release-failed'
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_nonce_release_request r
             JOIN p2tr_signature_fraud_challenge_nonce_release_result x
               ON x.release_request_id = r.release_request_id
            WHERE r.record_id = NEW.record_id
              AND r.generation = NEW.generation
              AND x.result_kind = 'contract-mismatch'
       ) THEN
        RAISE EXCEPTION 'reservation release alert requires an immutable allocator contract mismatch';
    END IF;
    IF NEW.code = 'nonce-release-terminal-unsafe'
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_nonce_release_request r
             JOIN p2tr_signature_fraud_challenge_nonce_release_resolution x
               ON x.release_request_id = r.release_request_id
            WHERE r.record_id = NEW.record_id
              AND r.generation = NEW.generation
              AND x.outcome = 'terminal-unsafe'
       ) THEN
        RAISE EXCEPTION 'terminal unsafe release alert requires independently attested evidence';
    END IF;
    IF NEW.code = 'signer-boundary-terminal-unsafe'
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_signer_boundary_resolution sb
            WHERE sb.record_id = NEW.record_id
              AND sb.outcome = 'terminal-unsafe'
       ) THEN
        RAISE EXCEPTION 'terminal unsafe signer-boundary alert requires independently attested evidence';
    END IF;
    IF NEW.code = 'reservation-state-ambiguous'
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_nonce_guard ng
            WHERE ng.record_id = NEW.record_id
              AND ng.void_reason = 'reservation-binding-invalid'
              AND ng.voided_before_sign_at_unix_ms IS NOT NULL
       ) THEN
        RAISE EXCEPTION 'ambiguous reservation alert requires its exact conflicting tombstone';
    END IF;
    IF NEW.code = 'nonce-reservation-cap-exhausted'
       AND (
           SELECT count(*)
             FROM p2tr_signature_fraud_challenge_nonce_guard ng
            WHERE ng.record_id = NEW.record_id
              AND ng.guard_kind = 'bound-reservation'
              AND ng.voided_before_sign_at_unix_ms IS NOT NULL
       ) < 32 THEN
        RAISE EXCEPTION 'nonce reservation cap alert requires the full bounded tombstone ledger';
    END IF;
    IF NEW.code = 'provenance-reconciliation-incident'
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_provenance_incident pi
            WHERE pi.record_id = NEW.record_id
              AND pi.activation_blocking
       ) THEN
        RAISE EXCEPTION 'provenance alert requires an immutable reconciliation incident';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_critical_alert_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_critical_alert
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_critical_alert_insert();

CREATE FUNCTION p2tr_signature_fraud_validate_critical_alert_resolution_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    alert_code text;
    current_disposition_id bytea;
    current_reservation_id bytea;
    lane_released_at bigint;
    disposition_evidence_digest bytea;
    attestation_count integer;
BEGIN
    SELECT code INTO alert_code
    FROM p2tr_signature_fraud_challenge_critical_alert
    WHERE alert_id = NEW.alert_id
      AND record_id = NEW.record_id
      AND generation = NEW.generation
    FOR SHARE;

    IF alert_code NOT IN (
        'late-signed-artifact-captured',
        'signed-state-quarantined'
    ) THEN
        RAISE EXCEPTION 'only an expected-lane signed-state alert can be resolved';
    END IF;

    SELECT nonce_disposition_id, nonce_reservation_id, lane_released_at_unix_ms
    INTO current_disposition_id, current_reservation_id, lane_released_at
    FROM p2tr_signature_fraud_challenge_outbox
    WHERE record_id = NEW.record_id
      AND generation = NEW.generation
    FOR SHARE;

    SELECT evidence_digest INTO disposition_evidence_digest
    FROM p2tr_signature_fraud_challenge_nonce_disposition
    WHERE record_id = NEW.record_id
      AND nonce_disposition_id = NEW.nonce_disposition_id
      AND nonce_reservation_id = current_reservation_id;

    SELECT count(DISTINCT independence_domain_id) INTO attestation_count
    FROM p2tr_signature_fraud_challenge_nonce_disposition_attestation
    WHERE nonce_disposition_id = NEW.nonce_disposition_id;

    IF current_disposition_id IS DISTINCT FROM NEW.nonce_disposition_id
       OR lane_released_at IS NULL
       OR disposition_evidence_digest IS NULL
       OR attestation_count < 2
       OR NOT EXISTS (
           SELECT 1
           FROM p2tr_signature_fraud_challenge_late_signed_artifact la
           WHERE la.record_id = NEW.record_id
             AND la.generation = NEW.generation
             AND la.expected_reservation_id = current_reservation_id
       )
       OR EXISTS (
           SELECT 1
           FROM p2tr_signature_fraud_challenge_escaped_envelope ee
           WHERE ee.record_id = NEW.record_id
       ) THEN
        RAISE EXCEPTION 'late artifact alert lacks an exact independently attested safe disposition';
    END IF;

    IF NEW.resolution_digest <> sha256(
        NEW.alert_id || NEW.nonce_disposition_id || disposition_evidence_digest
    ) THEN
        RAISE EXCEPTION 'critical alert resolution digest is invalid';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_critical_alert_resolution_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_critical_alert_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_critical_alert_resolution_insert();

CREATE FUNCTION p2tr_signature_fraud_validate_escaped_envelope_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    actual_guard p2tr_signature_fraud_challenge_nonce_guard%ROWTYPE;
    recorded_reason text;
BEGIN
    SELECT * INTO actual_guard
    FROM p2tr_signature_fraud_challenge_nonce_guard
    WHERE record_id = NEW.actual_guard_record_id
      AND nonce_guard_id = NEW.actual_nonce_guard_id
    FOR SHARE;

    SELECT quarantine_reason INTO recorded_reason
    FROM p2tr_signature_fraud_challenge_signer_quarantine
    WHERE record_id = NEW.record_id
      AND signer_quarantine_id = NEW.signer_quarantine_id;

    IF actual_guard.nonce_guard_id IS NULL
       OR NOT FOUND
       OR actual_guard.voided_before_sign_at_unix_ms IS NOT NULL
       OR recorded_reason NOT IN (
           'wrong-sender',
           'wrong-nonce',
           'ambiguous-signer-invocation'
       )
       OR (NEW.actual_sender = NEW.expected_sender
           AND NEW.actual_nonce = NEW.expected_nonce)
       OR (recorded_reason = 'wrong-sender'
           AND NEW.actual_sender = NEW.expected_sender)
       OR (recorded_reason = 'wrong-nonce'
           AND (NEW.actual_sender <> NEW.expected_sender
                OR NEW.actual_nonce = NEW.expected_nonce)) THEN
        RAISE EXCEPTION 'escaped signed envelope does not match its quarantine reason';
    END IF;

    -- The actual guard is a global (chain, sender, nonce) exclusion. Multiple
    -- records may independently retain signed bytes that collide with it; the
    -- envelope's separate expected-reservation FK preserves each invocation's
    -- provenance while this FK prevents the actual nonce from being reused.
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_escaped_envelope_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_escaped_envelope
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_escaped_envelope_insert();

CREATE FUNCTION p2tr_signature_fraud_validate_late_signed_artifact_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    outbox_record p2tr_signature_fraud_challenge_outbox%ROWTYPE;
    fee_policy p2tr_signature_fraud_challenge_fee_policy%ROWTYPE;
BEGIN
    SELECT * INTO outbox_record
      FROM p2tr_signature_fraud_challenge_outbox
     WHERE record_id = NEW.record_id
       AND generation = NEW.generation
     FOR SHARE;

    IF NOT FOUND
       OR outbox_record.canonical_provenance_fingerprint <>
            NEW.expected_provenance_fingerprint
       OR outbox_record.nonce_reservation_id <>
            NEW.expected_reservation_id
       OR outbox_record.intent_id <> NEW.intent_id
       OR outbox_record.chain_id <> NEW.chain_id
       OR outbox_record.reserved_sender <> NEW.sender
       OR outbox_record.reserved_nonce <> NEW.transaction_nonce
       OR outbox_record.signer_lane_id <> NEW.signer_lane_id
       OR outbox_record.signer_identity <> NEW.signer_identity
       OR (
            outbox_record.signer_invocation_started_at_unix_ms IS NULL
            AND outbox_record.active_signer_invocation_started_at_unix_ms IS NULL
       )
       OR (
            outbox_record.signer_invocation_started_at_unix_ms IS NOT NULL
            AND NEW.captured_at_unix_ms <
                outbox_record.signer_invocation_started_at_unix_ms
       )
       OR (
            outbox_record.active_signer_invocation_started_at_unix_ms IS NOT NULL
            AND NEW.captured_at_unix_ms <
                outbox_record.active_signer_invocation_started_at_unix_ms
       ) THEN
        RAISE EXCEPTION 'late signed artifact does not match its durable signer boundary';
    END IF;

    SELECT * INTO fee_policy
      FROM p2tr_signature_fraud_challenge_fee_policy
     WHERE record_id = NEW.record_id
       AND signer_lane_id = NEW.signer_lane_id
       AND signer_identity = NEW.signer_identity
       AND sender = NEW.sender
       AND policy_hash = outbox_record.fee_policy_hash
     FOR SHARE;

    IF NOT FOUND
       OR NEW.gas_limit > fee_policy.max_gas_limit
       OR NEW.max_fee_per_gas > fee_policy.max_fee_per_gas
       OR NEW.max_priority_fee_per_gas > fee_policy.max_priority_fee_per_gas
       OR NEW.gas_limit * NEW.max_fee_per_gas > fee_policy.max_total_fee_wei THEN
        RAISE EXCEPTION 'late signed artifact exceeds its manifest-bound fee policy';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_late_signed_artifact_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_late_signed_artifact
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_late_signed_artifact_insert();

CREATE FUNCTION p2tr_signature_fraud_validate_nonce_guard_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_guard p2tr_signature_fraud_challenge_nonce_guard%ROWTYPE;
BEGIN
    IF NEW.guard_kind = 'bound-reservation' THEN
        IF NEW.voided_before_sign_at_unix_ms IS NOT NULL THEN
            -- A valid reservation can return after its preparation lease or
            -- canonical claim lost the state CAS. It is admitted only already
            -- tombstoned and only while no signer/signed envelope exists.
            PERFORM 1
            FROM p2tr_signature_fraud_challenge_outbox
            WHERE record_id = NEW.record_id
              AND chain_id = NEW.chain_id
              AND nonce_reservation_id IS DISTINCT FROM NEW.nonce_guard_id
            FOR SHARE;
        ELSE
            PERFORM 1
            FROM p2tr_signature_fraud_challenge_outbox
            WHERE record_id = NEW.record_id
              AND chain_id = NEW.chain_id
              AND selected_signer_lane_id = NEW.signer_lane_id
              AND selected_signer_identity = NEW.signer_identity
              AND selected_sender = NEW.sender
              AND nonce_reservation_id IS NULL
            FOR SHARE;
        END IF;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'nonce reservation does not match the durable selected signer lane';
        END IF;

        IF NEW.voided_before_sign_at_unix_ms IS NULL AND EXISTS (
            SELECT 1
            FROM p2tr_signature_fraud_challenge_signer_quarantine
            WHERE chain_id = NEW.chain_id
              AND (signer_lane_id = NEW.signer_lane_id
                   OR signer_identity = NEW.signer_identity)
        ) THEN
            RAISE EXCEPTION 'P2TR challenge signer lane is quarantined';
        END IF;
    ELSE
        SELECT * INTO parent_guard
        FROM p2tr_signature_fraud_challenge_nonce_guard
        WHERE nonce_guard_id = NEW.parent_reservation_id
        FOR SHARE;

        IF NOT FOUND
           OR parent_guard.guard_kind <> 'bound-reservation'
           OR parent_guard.record_id <> NEW.record_id
           OR parent_guard.chain_id <> NEW.chain_id
           OR parent_guard.signer_lane_id <> NEW.signer_lane_id
           OR parent_guard.signer_identity <> NEW.signer_identity
           OR parent_guard.voided_before_sign_at_unix_ms IS NOT NULL THEN
            RAISE EXCEPTION 'escaped nonce guard is not bound to its signer reservation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_nonce_guard_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_nonce_guard
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_nonce_guard_insert();

CREATE FUNCTION p2tr_signature_fraud_validate_nonce_release_request_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    guard p2tr_signature_fraud_challenge_nonce_guard%ROWTYPE;
    manifest_hash bytea;
BEGIN
    SELECT * INTO guard
    FROM p2tr_signature_fraud_challenge_nonce_guard
    WHERE nonce_guard_id = NEW.nonce_guard_id
      AND record_id = NEW.record_id
    FOR SHARE;

    IF guard.nonce_guard_id IS NULL
       OR guard.guard_kind <> 'bound-reservation'
       OR guard.voided_before_sign_at_unix_ms IS NULL
       OR guard.void_evidence_digest <> NEW.void_evidence_digest
       OR guard.voided_before_sign_at_unix_ms <> NEW.requested_at_unix_ms
       OR guard.reservation_epoch <> NEW.reservation_epoch
       OR guard.chain_id <> NEW.chain_id
       OR guard.signer_lane_id <> NEW.signer_lane_id
       OR guard.signer_identity <> NEW.signer_identity
       OR guard.sender <> NEW.sender
       OR guard.transaction_nonce <> NEW.transaction_nonce THEN
        RAISE EXCEPTION 'nonce-release request does not bind the exact voided reservation';
    END IF;

    IF NEW.release_request_id <> sha256(
        convert_to(
            'tbtc-p2tr-signature-fraud-nonce-release-request-v1',
            'UTF8'
        ) || NEW.record_id || NEW.nonce_guard_id || NEW.void_evidence_digest
    ) THEN
        RAISE EXCEPTION 'nonce-release request identity is invalid';
    END IF;

    SELECT activation_manifest_hash INTO manifest_hash
    FROM p2tr_signature_fraud_challenge_outbox
    WHERE record_id = NEW.record_id
      AND generation = NEW.generation;

    PERFORM 1
    FROM p2tr_signature_fraud_signer_lane_configuration
    WHERE activation_manifest_hash = manifest_hash
      AND chain_id = NEW.chain_id
      AND signer_lane_id = NEW.signer_lane_id
      AND signer_identity = NEW.signer_identity
      AND sender = NEW.sender
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'nonce-release request lacks its manifest signer lane';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_nonce_release_request_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_nonce_release_request
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_nonce_release_request_insert();

CREATE FUNCTION p2tr_signature_fraud_register_pending_nonce_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE p2tr_signature_fraud_nonce_allocator_safety_barrier
       SET unresolved_release_count = unresolved_release_count + 1
     WHERE singleton = true;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'nonce allocator safety barrier is missing';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_register_pending_nonce_release_trigger
AFTER INSERT ON p2tr_signature_fraud_challenge_nonce_release_request
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_register_pending_nonce_release();

CREATE FUNCTION p2tr_signature_fraud_validate_nonce_release_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    prior_sequence integer;
    prior_expires_at bigint;
    prior_invoked boolean;
    prior_result_kind text;
BEGIN
    IF COALESCE((
        SELECT contract_mismatch_blocked
        FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
        WHERE singleton = true
    ), true) THEN
        RETURN NULL;
    END IF;

    PERFORM 1
    FROM p2tr_signature_fraud_challenge_nonce_release_request
    WHERE release_request_id = NEW.release_request_id
    FOR UPDATE;

    IF NOT FOUND OR EXISTS (
        SELECT 1
        FROM p2tr_signature_fraud_challenge_nonce_release_terminal
        WHERE release_request_id = NEW.release_request_id
    ) THEN
        RAISE EXCEPTION 'acknowledged or missing nonce-release request cannot be claimed';
    END IF;

    SELECT a.attempt_sequence,
           a.expires_at_unix_ms,
           EXISTS (
               SELECT 1
               FROM p2tr_signature_fraud_challenge_nonce_release_invocation i
               WHERE i.release_request_id = a.release_request_id
                 AND i.attempt_sequence = a.attempt_sequence
           ),
           (
               SELECT x.result_kind
               FROM p2tr_signature_fraud_challenge_nonce_release_result x
               WHERE x.release_request_id = a.release_request_id
                 AND x.attempt_sequence = a.attempt_sequence
           )
      INTO prior_sequence, prior_expires_at, prior_invoked, prior_result_kind
      FROM p2tr_signature_fraud_challenge_nonce_release_attempt a
     WHERE a.release_request_id = NEW.release_request_id
     ORDER BY a.attempt_sequence DESC
     LIMIT 1;

    IF NEW.attempt_sequence <> COALESCE(prior_sequence, 0) + 1
       OR (
           prior_sequence IS NOT NULL
           AND NOT (
               prior_result_kind IS NOT NULL
               AND NOT (
                   COALESCE(prior_invoked, false)
                   AND prior_result_kind = 'ambiguous-error'
               )
           )
           AND (
               COALESCE(prior_invoked, false)
               OR NEW.started_at_unix_ms < prior_expires_at
           )
       ) THEN
        RAISE EXCEPTION 'nonce-release attempts must be contiguous and cannot replace a resultless invocation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_nonce_release_attempt_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_nonce_release_attempt
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_nonce_release_attempt_insert();

CREATE FUNCTION p2tr_signature_fraud_validate_nonce_release_invocation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    attempt p2tr_signature_fraud_challenge_nonce_release_attempt%ROWTYPE;
BEGIN
    SELECT * INTO attempt
    FROM p2tr_signature_fraud_challenge_nonce_release_attempt
    WHERE release_request_id = NEW.release_request_id
      AND attempt_sequence = NEW.attempt_sequence
    FOR UPDATE;

    IF attempt.release_request_id IS NULL
       OR attempt.owner <> NEW.owner
       OR NEW.invoked_at_unix_ms < attempt.started_at_unix_ms
       OR NEW.invoked_at_unix_ms > attempt.expires_at_unix_ms
       OR NEW.attempt_sequence <> (
           SELECT max(attempt_sequence)
           FROM p2tr_signature_fraud_challenge_nonce_release_attempt
           WHERE release_request_id = NEW.release_request_id
       )
       OR EXISTS (
           SELECT 1
           FROM p2tr_signature_fraud_challenge_nonce_release_result
           WHERE release_request_id = NEW.release_request_id
             AND attempt_sequence = NEW.attempt_sequence
       ) THEN
        RAISE EXCEPTION 'nonce-release invocation lacks its exact live attempt';
    END IF;

    UPDATE p2tr_signature_fraud_nonce_allocator_safety_barrier
       SET active_release_request_id = NEW.release_request_id,
           active_release_attempt_sequence = NEW.attempt_sequence,
           active_release_expires_at_unix_ms = attempt.expires_at_unix_ms
     WHERE singleton = true
       AND active_release_request_id IS NULL
       AND active_signer_invocation_count = 0
       AND unresolved_release_count > 0
       AND NOT contract_mismatch_blocked;
    IF NOT FOUND THEN
        IF NOT EXISTS (
            SELECT 1
            FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
            WHERE singleton = true
        ) THEN
            RAISE EXCEPTION 'nonce allocator safety barrier is missing';
        END IF;
        -- Contention is not malformed state. Suppress this append so the same
        -- uninvoked attempt can retry after the current signer/release exits.
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_nonce_release_invocation_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_nonce_release_invocation
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_nonce_release_invocation_insert();

CREATE FUNCTION p2tr_signature_fraud_validate_nonce_release_result_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    request p2tr_signature_fraud_challenge_nonce_release_request%ROWTYPE;
    attempt p2tr_signature_fraud_challenge_nonce_release_attempt%ROWTYPE;
    latest_sequence integer;
    invoked_at bigint;
BEGIN
    SELECT * INTO request
    FROM p2tr_signature_fraud_challenge_nonce_release_request
    WHERE release_request_id = NEW.release_request_id
    FOR UPDATE;

    SELECT * INTO attempt
    FROM p2tr_signature_fraud_challenge_nonce_release_attempt
    WHERE release_request_id = NEW.release_request_id
      AND attempt_sequence = NEW.attempt_sequence;

    SELECT max(attempt_sequence) INTO latest_sequence
    FROM p2tr_signature_fraud_challenge_nonce_release_attempt
    WHERE release_request_id = NEW.release_request_id;

    SELECT invoked_at_unix_ms INTO invoked_at
    FROM p2tr_signature_fraud_challenge_nonce_release_invocation
    WHERE release_request_id = NEW.release_request_id
      AND attempt_sequence = NEW.attempt_sequence;

    IF request.release_request_id IS NULL
       OR attempt.release_request_id IS NULL
       OR NEW.recorded_at_unix_ms < attempt.started_at_unix_ms
       OR (invoked_at IS NOT NULL AND NEW.recorded_at_unix_ms < invoked_at)
       OR (invoked_at IS NULL AND NEW.result_kind <> 'ambiguous-error')
       OR EXISTS (
           SELECT 1
           FROM p2tr_signature_fraud_challenge_nonce_release_resolution rx
           WHERE rx.release_request_id = NEW.release_request_id
             AND rx.attempt_sequence = NEW.attempt_sequence
       ) THEN
        RAISE EXCEPTION 'nonce-release result lacks its exact durable attempt';
    END IF;

    IF NEW.result_kind IN ('released', 'already-released') THEN
        IF invoked_at IS NULL
           OR NEW.attempt_sequence <> latest_sequence
           OR NEW.recorded_at_unix_ms > attempt.expires_at_unix_ms
           OR NEW.returned_release_request_id IS DISTINCT FROM request.release_request_id
           OR NEW.returned_reservation_id IS DISTINCT FROM request.nonce_guard_id
           OR EXISTS (
               SELECT 1
               FROM p2tr_signature_fraud_challenge_nonce_release_result
               WHERE release_request_id = NEW.release_request_id
                 AND result_kind IN ('released', 'already-released')
           ) THEN
            RAISE EXCEPTION 'nonce-release acknowledgement is not exact, current, and on-time';
        END IF;
    ELSIF NEW.result_kind = 'ambiguous-late' THEN
        IF invoked_at IS NULL
           OR NEW.returned_release_request_id <> request.release_request_id
           OR NEW.returned_reservation_id <> request.nonce_guard_id
           OR (NEW.attempt_sequence = latest_sequence
               AND NEW.recorded_at_unix_ms <= attempt.expires_at_unix_ms) THEN
            RAISE EXCEPTION 'late nonce-release result is not demonstrably late';
        END IF;
    ELSIF NEW.result_kind = 'contract-mismatch' AND invoked_at IS NULL THEN
        RAISE EXCEPTION 'nonce-release contract mismatch lacks an invoked provider call';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_nonce_release_result_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_nonce_release_result
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_nonce_release_result_insert();

CREATE FUNCTION p2tr_signature_fraud_apply_nonce_release_result_barrier()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    barrier_release_request bytea;
    barrier_release_sequence integer;
    invocation_exists boolean;
BEGIN
    SELECT active_release_request_id, active_release_attempt_sequence
      INTO barrier_release_request, barrier_release_sequence
      FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
     WHERE singleton = true
     FOR UPDATE;

    SELECT EXISTS (
        SELECT 1
        FROM p2tr_signature_fraud_challenge_nonce_release_invocation
        WHERE release_request_id = NEW.release_request_id
          AND attempt_sequence = NEW.attempt_sequence
    ) INTO invocation_exists;

    IF invocation_exists
       AND ROW(barrier_release_request, barrier_release_sequence)
           IS DISTINCT FROM ROW(NEW.release_request_id, NEW.attempt_sequence) THEN
        RAISE EXCEPTION 'nonce-release result does not own the durable I/O barrier';
    END IF;

    UPDATE p2tr_signature_fraud_nonce_allocator_safety_barrier
       SET active_release_request_id = CASE
               WHEN ROW(barrier_release_request, barrier_release_sequence)
                    IS NOT DISTINCT FROM ROW(
                        NEW.release_request_id,
                        NEW.attempt_sequence
                    )
                    AND NOT (
                        invocation_exists
                        AND NEW.result_kind = 'ambiguous-error'
                    ) THEN NULL
               ELSE active_release_request_id
           END,
           active_release_attempt_sequence = CASE
               WHEN ROW(barrier_release_request, barrier_release_sequence)
                    IS NOT DISTINCT FROM ROW(
                        NEW.release_request_id,
                        NEW.attempt_sequence
                    )
                    AND NOT (
                        invocation_exists
                        AND NEW.result_kind = 'ambiguous-error'
                    ) THEN NULL
               ELSE active_release_attempt_sequence
           END,
           active_release_expires_at_unix_ms = CASE
               WHEN ROW(barrier_release_request, barrier_release_sequence)
                    IS NOT DISTINCT FROM ROW(
                        NEW.release_request_id,
                        NEW.attempt_sequence
                    )
                    AND NOT (
                        invocation_exists
                        AND NEW.result_kind = 'ambiguous-error'
                    ) THEN NULL
               ELSE active_release_expires_at_unix_ms
           END,
           contract_mismatch_blocked =
               contract_mismatch_blocked
               OR NEW.result_kind = 'contract-mismatch',
           unresolved_release_count = unresolved_release_count - CASE
               WHEN NEW.result_kind IN ('released', 'already-released') THEN 1
               ELSE 0
           END,
           incident_epoch = incident_epoch + CASE
               WHEN NEW.result_kind = 'contract-mismatch' THEN 1
               ELSE 0
           END
     WHERE singleton = true
       AND (
           NEW.result_kind NOT IN ('released', 'already-released')
           OR unresolved_release_count > 0
       );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'nonce-release safety barrier counter underflow';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_apply_nonce_release_result_barrier_trigger
AFTER INSERT ON p2tr_signature_fraud_challenge_nonce_release_result
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_apply_nonce_release_result_barrier();

CREATE FUNCTION p2tr_signature_fraud_validate_nonce_release_resolution_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    attempt p2tr_signature_fraud_challenge_nonce_release_attempt%ROWTYPE;
    invocation p2tr_signature_fraud_challenge_nonce_release_invocation%ROWTYPE;
    ambiguous_result p2tr_signature_fraud_challenge_nonce_release_result%ROWTYPE;
    barrier_request bytea;
    barrier_sequence integer;
BEGIN
    SELECT * INTO attempt
    FROM p2tr_signature_fraud_challenge_nonce_release_attempt
    WHERE release_request_id = NEW.release_request_id
      AND attempt_sequence = NEW.attempt_sequence
    FOR UPDATE;

    SELECT * INTO invocation
    FROM p2tr_signature_fraud_challenge_nonce_release_invocation
    WHERE release_request_id = NEW.release_request_id
      AND attempt_sequence = NEW.attempt_sequence;

    SELECT * INTO ambiguous_result
    FROM p2tr_signature_fraud_challenge_nonce_release_result
    WHERE release_request_id = NEW.release_request_id
      AND attempt_sequence = NEW.attempt_sequence;

    SELECT active_release_request_id, active_release_attempt_sequence
      INTO barrier_request, barrier_sequence
      FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
     WHERE singleton = true
     FOR UPDATE;

    IF attempt.release_request_id IS NULL
       OR invocation.release_request_id IS NULL
       OR (
           ambiguous_result.result_kind IS NOT NULL
           AND ambiguous_result.result_kind <> 'ambiguous-error'
       )
       OR ROW(barrier_request, barrier_sequence) IS DISTINCT FROM ROW(
           NEW.release_request_id,
           NEW.attempt_sequence
       )
       OR NEW.attempt_owner <> attempt.owner
       OR NEW.attempt_started_at_unix_ms <> attempt.started_at_unix_ms
       OR NEW.attempt_expires_at_unix_ms <> attempt.expires_at_unix_ms
       OR NEW.invoked_at_unix_ms <> invocation.invoked_at_unix_ms
       OR NEW.resolution_evidence_digest <> sha256(
           convert_to(
               'tbtc-p2tr-nonce-release-independent-resolution-v1',
               'UTF8'
           )
           || NEW.release_request_id
           || int8send(NEW.attempt_sequence::bigint)
           || sha256(convert_to(NEW.attempt_owner, 'UTF8'))
           || int8send(NEW.attempt_started_at_unix_ms)
           || int8send(NEW.attempt_expires_at_unix_ms)
           || int8send(NEW.invoked_at_unix_ms)
           || sha256(convert_to(NEW.outcome, 'UTF8'))
           || NEW.provider_evidence_digest
       )
       OR NEW.resolved_at_unix_ms < COALESCE(
           ambiguous_result.recorded_at_unix_ms,
           invocation.invoked_at_unix_ms
       )
       OR NEW.primary_attested_at_unix_ms < invocation.invoked_at_unix_ms
       OR NEW.corroborating_attested_at_unix_ms < invocation.invoked_at_unix_ms
       OR NEW.primary_attested_at_unix_ms > NEW.resolved_at_unix_ms
       OR NEW.corroborating_attested_at_unix_ms > NEW.resolved_at_unix_ms THEN
        RAISE EXCEPTION 'independent nonce-release resolution lacks its exact sticky ambiguous invocation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_nonce_release_resolution_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_nonce_release_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_nonce_release_resolution_insert();

CREATE FUNCTION p2tr_signature_fraud_apply_nonce_release_resolution_barrier()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE p2tr_signature_fraud_nonce_allocator_safety_barrier
       SET active_release_request_id = NULL,
           active_release_attempt_sequence = NULL,
           active_release_expires_at_unix_ms = NULL,
           unresolved_release_count = unresolved_release_count - CASE
               WHEN NEW.outcome IN ('released', 'already-released') THEN 1
               ELSE 0
           END,
           contract_mismatch_blocked =
               contract_mismatch_blocked
               OR NEW.outcome = 'terminal-unsafe',
           incident_epoch = incident_epoch + CASE
               WHEN NEW.outcome = 'terminal-unsafe' THEN 1
               ELSE 0
           END
     WHERE singleton = true
       AND active_release_request_id = NEW.release_request_id
       AND active_release_attempt_sequence = NEW.attempt_sequence
       AND (
           NEW.outcome = 'terminal-unsafe'
           OR unresolved_release_count > 0
       );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'independent nonce-release resolution lost its durable barrier';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_apply_nonce_release_resolution_barrier_trigger
AFTER INSERT ON p2tr_signature_fraud_challenge_nonce_release_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_apply_nonce_release_resolution_barrier();

CREATE FUNCTION p2tr_signature_fraud_validate_variant_append()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    outbox_record p2tr_signature_fraud_challenge_outbox%ROWTYPE;
    fee_policy p2tr_signature_fraud_challenge_fee_policy%ROWTYPE;
    previous_variant p2tr_signature_fraud_challenge_outbox_variant%ROWTYPE;
BEGIN
    SELECT * INTO outbox_record
    FROM p2tr_signature_fraud_challenge_outbox
    WHERE record_id = NEW.record_id
      AND generation = NEW.generation
    FOR SHARE;

    IF NOT FOUND
       OR outbox_record.nonce_reservation_id IS NULL
       OR (
            outbox_record.signer_invocation_started_at_unix_ms IS NULL
            AND outbox_record.active_signer_invocation_started_at_unix_ms IS NULL
       )
       OR NEW.sender <> outbox_record.reserved_sender
           OR NEW.transaction_nonce <> outbox_record.reserved_nonce
           OR (
               outbox_record.signer_invocation_started_at_unix_ms IS NOT NULL
               AND NEW.signed_at_unix_ms <
                   outbox_record.signer_invocation_started_at_unix_ms
           )
           OR (
               outbox_record.active_signer_invocation_started_at_unix_ms IS NOT NULL
               AND NEW.signed_at_unix_ms <
                   outbox_record.active_signer_invocation_started_at_unix_ms
           )
           OR NEW.signed_at_unix_ms < outbox_record.nonce_reserved_at_unix_ms THEN
        RAISE EXCEPTION 'signed variant does not match the durable bound nonce reservation';
    END IF;

    SELECT * INTO fee_policy
    FROM p2tr_signature_fraud_challenge_fee_policy
    WHERE record_id = NEW.record_id
      AND signer_lane_id = outbox_record.signer_lane_id
      AND signer_identity = outbox_record.signer_identity
      AND sender = NEW.sender
      AND policy_hash = outbox_record.fee_policy_hash
    FOR SHARE;

    IF NOT FOUND
       OR NEW.gas_limit > fee_policy.max_gas_limit
       OR NEW.max_fee_per_gas > fee_policy.max_fee_per_gas
       OR NEW.max_priority_fee_per_gas > fee_policy.max_priority_fee_per_gas
       OR NEW.gas_limit * NEW.max_fee_per_gas > fee_policy.max_total_fee_wei THEN
        RAISE EXCEPTION 'signed variant exceeds its manifest-bound fee or value policy';
    END IF;

    IF NEW.variant_sequence = 0 THEN
        IF EXISTS (
            SELECT 1
            FROM p2tr_signature_fraud_challenge_outbox_variant
            WHERE record_id = NEW.record_id
              AND generation = NEW.generation
        ) THEN
            RAISE EXCEPTION 'initial P2TR challenge variant is not append-only';
        END IF;
    ELSE
        SELECT * INTO previous_variant
        FROM p2tr_signature_fraud_challenge_outbox_variant
        WHERE record_id = NEW.record_id
          AND generation = NEW.generation
          AND variant_sequence = NEW.variant_sequence - 1
        FOR SHARE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'P2TR challenge variant sequence is not contiguous';
        END IF;
        IF NEW.sender <> previous_variant.sender
           OR NEW.transaction_nonce <> previous_variant.transaction_nonce THEN
            RAISE EXCEPTION 'P2TR challenge replacement changed sender or nonce';
        END IF;
        IF NEW.max_fee_per_gas <= previous_variant.max_fee_per_gas
           OR NEW.max_priority_fee_per_gas <= previous_variant.max_priority_fee_per_gas
           OR NEW.gas_limit < previous_variant.gas_limit THEN
            RAISE EXCEPTION 'P2TR challenge replacement fee envelope did not strictly increase';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_variant_append_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_outbox_variant
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_variant_append();

CREATE FUNCTION p2tr_signature_fraud_validate_generation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    prior_record p2tr_signature_fraud_challenge_outbox%ROWTYPE;
    prior_kind text;
    attestation_count integer;
    current_manifest_hash bytea;
    max_active_records integer;
BEGIN
    IF lower(NEW.record_state ->> 'recordID') <>
            '0x' || encode(NEW.record_id, 'hex')
       OR lower(NEW.record_state ->> 'seriesID') <>
            '0x' || encode(NEW.series_id, 'hex')
       OR (NEW.record_state ->> 'generation')::integer <> NEW.generation
       OR (NEW.record_state ->> 'version')::bigint <> NEW.version
       OR NEW.record_state ->> 'status' <> NEW.status THEN
        RAISE EXCEPTION 'serialized P2TR outbox state does not match its normalized generation key';
    END IF;

    IF NEW.status <> 'queued'
       OR NEW.version <> 0
       OR NEW.created_at_unix_ms <> NEW.updated_at_unix_ms
       OR NEW.selected_signer_lane_id IS NOT NULL
       OR NEW.nonce_reservation_id IS NOT NULL
       OR NEW.signer_invocation_started_at_unix_ms IS NOT NULL
       OR NEW.prepared_transaction_hash IS NOT NULL THEN
        RAISE EXCEPTION 'new P2TR challenge generation must begin as an unsigned queued record';
    END IF;

    SELECT manifest_hash,
           (payload #>> '{outbox,maxActiveOutboxRecords}')::integer
      INTO current_manifest_hash, max_active_records
      FROM p2tr_watchtower_activation_manifest
     WHERE singleton = true
     FOR SHARE;

    IF current_manifest_hash IS NULL
       OR NEW.activation_manifest_hash IS DISTINCT FROM current_manifest_hash THEN
        RAISE EXCEPTION 'new P2TR challenge generation is not bound to the current activation manifest';
    END IF;

    -- Capacity is consumed only by the AFTER INSERT trigger. A BEFORE trigger
    -- runs before uniqueness arbitration, so rejecting a full counter here
    -- would break idempotent concurrent INSERT ... ON CONFLICT DO NOTHING.
    IF max_active_records IS NULL THEN
        RAISE EXCEPTION 'manifest-bound global active outbox capacity is invalid';
    END IF;

    IF NEW.generation = 0 THEN
        RETURN NEW;
    END IF;

    SELECT * INTO prior_record
    FROM p2tr_signature_fraud_challenge_outbox
    WHERE record_id = NEW.previous_record_id
    FOR SHARE;

    IF NOT FOUND
       OR prior_record.series_id <> NEW.series_id
       OR prior_record.intent_id <> NEW.intent_id
       OR prior_record.generation + 1 <> NEW.generation
       OR prior_record.chain_id <> NEW.chain_id
       OR prior_record.bridge_address <> NEW.bridge_address
       OR prior_record.router_address <> NEW.router_address
       OR prior_record.bridge_challenge_key <> NEW.bridge_challenge_key
       OR prior_record.wallet_id <> NEW.wallet_id
       OR prior_record.bridge_challenge_identity <> NEW.bridge_challenge_identity
       OR prior_record.sighash <> NEW.sighash
       OR prior_record.calldata <> NEW.calldata
       OR prior_record.value_wei <> NEW.value_wei
       OR prior_record.bitcoin_tx_hash <> NEW.bitcoin_tx_hash
       OR prior_record.bitcoin_wtxid <> NEW.bitcoin_wtxid
       OR prior_record.bitcoin_input_index <> NEW.bitcoin_input_index
       OR prior_record.canonical_input_binding_kind <>
            NEW.canonical_input_binding_kind
       OR prior_record.canonical_input_binding_source_event_id <>
            NEW.canonical_input_binding_source_event_id
       OR prior_record.canonical_input_index <>
            NEW.canonical_input_index
       OR prior_record.canonical_funding_block_hash <>
            NEW.canonical_funding_block_hash
       OR prior_record.canonical_funding_txid <>
            NEW.canonical_funding_txid
       OR prior_record.canonical_funding_vout <>
            NEW.canonical_funding_vout
       OR prior_record.canonical_input_wallet_id <>
            NEW.canonical_input_wallet_id
       OR prior_record.canonical_input_output_key <>
            NEW.canonical_input_output_key
       OR prior_record.canonical_binding_ethereum_block_number <>
            NEW.canonical_binding_ethereum_block_number
       OR prior_record.canonical_binding_ethereum_block_hash <>
            NEW.canonical_binding_ethereum_block_hash
       OR (
           NEW.generation_cause <> 'provenance-restored'
           AND (
               prior_record.fee_policy_hash <> NEW.fee_policy_hash
               OR prior_record.activation_manifest_hash <>
                    NEW.activation_manifest_hash
               OR prior_record.router_code_hash <> NEW.router_code_hash
               OR prior_record.router_protocol_id <> NEW.router_protocol_id
               OR prior_record.complete_authorization_registry_address <>
                    NEW.complete_authorization_registry_address
               OR prior_record.complete_authorization_registry_code_hash <>
                    NEW.complete_authorization_registry_code_hash
               OR prior_record.complete_authorization_registry_protocol_id <>
                    NEW.complete_authorization_registry_protocol_id
               OR prior_record.complete_reservation_model <>
                    NEW.complete_reservation_model
           )
       ) THEN
        RAISE EXCEPTION 'P2TR challenge generation does not extend the exact prior intent';
    END IF;

    IF NEW.generation_cause IN ('finalized-revert', 'finalized-nonce-consumed') THEN
        IF prior_record.status NOT IN (
            'terminal-reverted',
            'terminal-nonce-consumed',
            'generation-required'
        ) THEN
            RAISE EXCEPTION 'fresh nonce generation lacks a finalized failed predecessor';
        END IF;

        SELECT disposition_kind INTO prior_kind
        FROM p2tr_signature_fraud_challenge_nonce_disposition
        WHERE record_id = prior_record.record_id
          AND nonce_disposition_id = NEW.prior_nonce_disposition_id;

        SELECT count(DISTINCT independence_domain_id) INTO attestation_count
        FROM p2tr_signature_fraud_challenge_nonce_disposition_attestation
        WHERE nonce_disposition_id = NEW.prior_nonce_disposition_id;

        IF prior_kind IS NULL
           OR (NEW.generation_cause = 'finalized-revert'
               AND prior_kind <> 'finalized-reverted')
           OR (NEW.generation_cause = 'finalized-nonce-consumed'
               AND prior_kind <> 'finalized-nonce-consumed')
           OR attestation_count < 2 THEN
            RAISE EXCEPTION 'fresh nonce generation lacks independently attested exact disposition';
        END IF;
    ELSIF NEW.generation_cause = 'canonical-reappearance' THEN
        IF prior_record.status <> 'cancelled-reorg' THEN
            RAISE EXCEPTION 'canonical reappearance must extend a reorg cancellation';
        END IF;

        SELECT evidence_kind INTO prior_kind
        FROM p2tr_signature_fraud_challenge_cancellation_evidence
        WHERE record_id = prior_record.record_id
          AND cancellation_evidence_id = NEW.prior_cancellation_evidence_id;

        SELECT count(DISTINCT independence_domain_id) INTO attestation_count
        FROM p2tr_signature_fraud_challenge_cancellation_attestation
        WHERE cancellation_evidence_id = NEW.prior_cancellation_evidence_id;

        IF prior_kind IS DISTINCT FROM 'canonical-reorg'
           OR attestation_count < 2 THEN
            RAISE EXCEPTION 'canonical reappearance lacks independently attested reorg evidence';
        END IF;
    ELSIF NEW.generation_cause = 'provenance-restored' THEN
        IF prior_record.status <> 'cancelled-provenance-invalidated'
           OR prior_record.provenance_invalidation_id IS NULL
           OR NEW.prior_provenance_invalidation_id IS DISTINCT FROM
                prior_record.provenance_invalidation_id
           OR NEW.canonical_candidate_digest <>
                prior_record.canonical_candidate_digest
           OR NEW.canonical_candidate_provenance_generation <=
                prior_record.canonical_candidate_provenance_generation
           OR NEW.canonical_readiness_certificate_generation <=
                prior_record.canonical_readiness_certificate_generation
           OR NEW.canonical_provenance_fingerprint =
                prior_record.canonical_provenance_fingerprint
           OR NEW.canonical_provenance_through_block_number <=
                prior_record.canonical_provenance_through_block_number
           OR NEW.ethereum_eligibility_read_set_hash =
                prior_record.ethereum_eligibility_read_set_hash
           OR NEW.activation_manifest_hash <>
                (SELECT manifest_hash
                   FROM p2tr_watchtower_activation_manifest
                  WHERE singleton = true) THEN
            RAISE EXCEPTION 'provenance restoration lacks a fresh current manifest-bound canonical certificate';
        END IF;

        PERFORM 1
          FROM p2tr_signature_fraud_challenge_provenance_invalidation pi
         WHERE pi.record_id = prior_record.record_id
           AND pi.provenance_invalidation_id =
                NEW.prior_provenance_invalidation_id
           AND pi.canonical_candidate_digest =
                prior_record.canonical_candidate_digest
           AND pi.canonical_candidate_provenance_generation =
                prior_record.canonical_candidate_provenance_generation
           AND pi.canonical_provenance_fingerprint =
                prior_record.canonical_provenance_fingerprint
         FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'provenance restoration lacks exact durable invalidation lineage';
        END IF;
    ELSE
        RAISE EXCEPTION 'unknown P2TR challenge generation cause';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_validate_generation_insert_trigger
BEFORE INSERT ON p2tr_signature_fraud_challenge_outbox
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_generation_insert();

CREATE FUNCTION p2tr_signature_fraud_consume_generation_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE p2tr_signature_fraud_challenge_outbox_capacity
       SET active_generation_count = active_generation_count + 1
     WHERE singleton = true
       AND active_generation_count < (
           SELECT (payload #>> '{outbox,maxActiveOutboxRecords}')::integer
             FROM p2tr_watchtower_activation_manifest
            WHERE singleton = true
       );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'manifest-bound global active outbox capacity is exhausted or missing';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_consume_generation_capacity_trigger
AFTER INSERT ON p2tr_signature_fraud_challenge_outbox
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_consume_generation_capacity();

CREATE FUNCTION p2tr_signature_fraud_protect_outbox_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    guard_kind text;
    evidence_kind text;
    disposition_kind text;
    quarantine_reason text;
    attestation_count integer;
    reservation_voided_at bigint;
BEGIN
    IF lower(NEW.record_state ->> 'recordID') <>
            '0x' || encode(NEW.record_id, 'hex')
       OR lower(NEW.record_state ->> 'seriesID') <>
            '0x' || encode(NEW.series_id, 'hex')
       OR (NEW.record_state ->> 'generation')::integer <> NEW.generation
       OR (NEW.record_state ->> 'version')::bigint <> NEW.version
       OR NEW.record_state ->> 'status' <> NEW.status THEN
        RAISE EXCEPTION 'serialized P2TR outbox state does not match its normalized CAS state';
    END IF;

    -- The adapter hydrates the immutable generation identity from record_state
    -- while PostgreSQL also keeps a normalized copy for constraints and
    -- joins. Protect both representations: otherwise a direct SQL writer
    -- could preserve the normalized columns while changing the serialized
    -- intent, evidence, provenance, or manifest seen after restart.
    IF jsonb_build_array(
        NEW.record_state -> 'seriesID',
        NEW.record_state -> 'recordID',
        NEW.record_state -> 'intent',
        NEW.record_state -> 'evidenceCheckpoint',
        NEW.record_state -> 'canonicalEthereumEligibility',
        NEW.record_state -> 'canonicalProvenance',
        NEW.record_state -> 'feePolicyManifest',
        NEW.record_state -> 'generation',
        NEW.record_state -> 'generationTrigger',
        NEW.record_state -> 'createdAtUnixMs'
    ) IS DISTINCT FROM jsonb_build_array(
        OLD.record_state -> 'seriesID',
        OLD.record_state -> 'recordID',
        OLD.record_state -> 'intent',
        OLD.record_state -> 'evidenceCheckpoint',
        OLD.record_state -> 'canonicalEthereumEligibility',
        OLD.record_state -> 'canonicalProvenance',
        OLD.record_state -> 'feePolicyManifest',
        OLD.record_state -> 'generation',
        OLD.record_state -> 'generationTrigger',
        OLD.record_state -> 'createdAtUnixMs'
    ) THEN
        RAISE EXCEPTION 'serialized P2TR outbox generation identity and evidence are immutable';
    END IF;

    IF ROW(
        NEW.record_id,
        NEW.series_id,
        NEW.intent_id,
        NEW.generation,
        NEW.previous_record_id,
        NEW.generation_cause,
        NEW.prior_nonce_disposition_id,
        NEW.prior_cancellation_evidence_id,
        NEW.prior_provenance_invalidation_id,
        NEW.observation_id,
        NEW.evidence_protocol_id,
        NEW.intent_input_index,
        NEW.bridge_challenge_key,
        NEW.wallet_id,
        NEW.signing_key,
        NEW.binding_tx_hash,
        NEW.binding_output_index,
        NEW.bridge_challenge_identity,
        NEW.sighash,
        NEW.signature_nonce_x,
        NEW.signature_scalar,
        NEW.domain_chain_id,
        NEW.chain_id,
        NEW.bridge_address,
        NEW.router_address,
        NEW.calldata,
        NEW.value_wei,
        NEW.fee_policy_hash,
        NEW.bitcoin_tx_hash,
        NEW.bitcoin_wtxid,
        NEW.bitcoin_input_index,
        NEW.bitcoin_block_hash,
        NEW.bitcoin_block_height,
        NEW.bitcoin_cursor_block_hash,
        NEW.bitcoin_cursor_block_height,
        NEW.ethereum_lifecycle_block_hash,
        NEW.ethereum_lifecycle_block_number,
        NEW.activation_manifest_hash,
        NEW.router_code_hash,
        NEW.router_protocol_id,
        NEW.router_domain_chain_id,
        NEW.complete_authorization_registry_address,
        NEW.complete_authorization_registry_code_hash,
        NEW.complete_authorization_registry_protocol_id,
        NEW.complete_reservation_model,
        NEW.ethereum_eligibility_read_set_hash,
        NEW.canonical_provenance_journal_store_id,
        NEW.canonical_provenance_descriptor_set_hash,
        NEW.canonical_provenance_through_block_number,
        NEW.canonical_provenance_through_block_hash,
        NEW.canonical_provenance_history_root,
        NEW.canonical_provenance_event_set_hash,
        NEW.canonical_provenance_event_count,
        NEW.canonical_candidate_digest,
        NEW.canonical_provenance_challenge_key,
        NEW.canonical_readiness_certificate_id,
        NEW.canonical_readiness_certificate_generation,
        NEW.canonical_candidate_provenance_generation,
        NEW.canonical_input_binding_kind,
        NEW.canonical_input_binding_source_event_id,
        NEW.canonical_input_index,
        NEW.canonical_funding_block_hash,
        NEW.canonical_funding_txid,
        NEW.canonical_funding_vout,
        NEW.canonical_input_wallet_id,
        NEW.canonical_input_output_key,
        NEW.canonical_binding_ethereum_block_number,
        NEW.canonical_binding_ethereum_block_hash,
        NEW.canonical_provenance_fingerprint,
        NEW.canonical_provenance_manifest_hash,
        NEW.router_challenge_absent,
        NEW.complete_exact_challenge_authorization_absent,
        NEW.complete_exact_transaction_authorization_absent,
        NEW.complete_wallet_reservation_active,
        NEW.complete_active_reservation_challenge_identity,
        NEW.wallet_challengeable,
        NEW.canonical_proof_backlog_complete,
        NEW.submitted_event_scan_from_block,
        NEW.confirmed_source_complete,
        NEW.created_at_unix_ms
    ) IS DISTINCT FROM ROW(
        OLD.record_id,
        OLD.series_id,
        OLD.intent_id,
        OLD.generation,
        OLD.previous_record_id,
        OLD.generation_cause,
        OLD.prior_nonce_disposition_id,
        OLD.prior_cancellation_evidence_id,
        OLD.prior_provenance_invalidation_id,
        OLD.observation_id,
        OLD.evidence_protocol_id,
        OLD.intent_input_index,
        OLD.bridge_challenge_key,
        OLD.wallet_id,
        OLD.signing_key,
        OLD.binding_tx_hash,
        OLD.binding_output_index,
        OLD.bridge_challenge_identity,
        OLD.sighash,
        OLD.signature_nonce_x,
        OLD.signature_scalar,
        OLD.domain_chain_id,
        OLD.chain_id,
        OLD.bridge_address,
        OLD.router_address,
        OLD.calldata,
        OLD.value_wei,
        OLD.fee_policy_hash,
        OLD.bitcoin_tx_hash,
        OLD.bitcoin_wtxid,
        OLD.bitcoin_input_index,
        OLD.bitcoin_block_hash,
        OLD.bitcoin_block_height,
        OLD.bitcoin_cursor_block_hash,
        OLD.bitcoin_cursor_block_height,
        OLD.ethereum_lifecycle_block_hash,
        OLD.ethereum_lifecycle_block_number,
        OLD.activation_manifest_hash,
        OLD.router_code_hash,
        OLD.router_protocol_id,
        OLD.router_domain_chain_id,
        OLD.complete_authorization_registry_address,
        OLD.complete_authorization_registry_code_hash,
        OLD.complete_authorization_registry_protocol_id,
        OLD.complete_reservation_model,
        OLD.ethereum_eligibility_read_set_hash,
        OLD.canonical_provenance_journal_store_id,
        OLD.canonical_provenance_descriptor_set_hash,
        OLD.canonical_provenance_through_block_number,
        OLD.canonical_provenance_through_block_hash,
        OLD.canonical_provenance_history_root,
        OLD.canonical_provenance_event_set_hash,
        OLD.canonical_provenance_event_count,
        OLD.canonical_candidate_digest,
        OLD.canonical_provenance_challenge_key,
        OLD.canonical_readiness_certificate_id,
        OLD.canonical_readiness_certificate_generation,
        OLD.canonical_candidate_provenance_generation,
        OLD.canonical_input_binding_kind,
        OLD.canonical_input_binding_source_event_id,
        OLD.canonical_input_index,
        OLD.canonical_funding_block_hash,
        OLD.canonical_funding_txid,
        OLD.canonical_funding_vout,
        OLD.canonical_input_wallet_id,
        OLD.canonical_input_output_key,
        OLD.canonical_binding_ethereum_block_number,
        OLD.canonical_binding_ethereum_block_hash,
        OLD.canonical_provenance_fingerprint,
        OLD.canonical_provenance_manifest_hash,
        OLD.router_challenge_absent,
        OLD.complete_exact_challenge_authorization_absent,
        OLD.complete_exact_transaction_authorization_absent,
        OLD.complete_wallet_reservation_active,
        OLD.complete_active_reservation_challenge_identity,
        OLD.wallet_challengeable,
        OLD.canonical_proof_backlog_complete,
        OLD.submitted_event_scan_from_block,
        OLD.confirmed_source_complete,
        OLD.created_at_unix_ms
    ) THEN
        RAISE EXCEPTION 'P2TR challenge generation identity and evidence are immutable';
    END IF;

    IF NEW.version <> OLD.version + 1
       OR NEW.updated_at_unix_ms < OLD.updated_at_unix_ms THEN
        RAISE EXCEPTION 'P2TR challenge state update must be monotonic CAS';
    END IF;

    IF NEW.preparation_attempts < OLD.preparation_attempts
       OR NEW.broadcast_attempts < OLD.broadcast_attempts
       OR NEW.reconciliation_attempts < OLD.reconciliation_attempts THEN
        RAISE EXCEPTION 'P2TR challenge attempt counters cannot decrease';
    END IF;

    IF OLD.status NOT IN (
           'accepted-own', 'satisfied-external', 'terminal-reverted',
           'terminal-nonce-consumed', 'generation-required',
           'cancelled-before-broadcast', 'cancelled-honest-spend',
           'cancelled-reorg', 'cancelled-provenance-invalidated'
       ) AND NEW.status IN (
           'accepted-own', 'satisfied-external', 'terminal-reverted',
           'terminal-nonce-consumed', 'generation-required',
           'cancelled-before-broadcast', 'cancelled-honest-spend',
           'cancelled-reorg', 'cancelled-provenance-invalidated'
       ) THEN
        UPDATE p2tr_signature_fraud_challenge_outbox_capacity
           SET active_generation_count = active_generation_count - 1
         WHERE singleton = true
           AND active_generation_count > 0;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'active outbox capacity counter underflow';
        END IF;
    ELSIF OLD.status IN (
           'accepted-own', 'satisfied-external', 'terminal-reverted',
           'terminal-nonce-consumed', 'generation-required',
           'cancelled-before-broadcast', 'cancelled-honest-spend',
           'cancelled-reorg', 'cancelled-provenance-invalidated'
       ) AND NEW.status NOT IN (
           'accepted-own', 'satisfied-external', 'terminal-reverted',
           'terminal-nonce-consumed', 'generation-required',
           'cancelled-before-broadcast', 'cancelled-honest-spend',
           'cancelled-reorg', 'cancelled-provenance-invalidated'
       ) THEN
        RAISE EXCEPTION 'terminal outbox generations cannot reactivate capacity';
    END IF;

    IF OLD.nonce_reservation_id IS NOT NULL THEN
        SELECT voided_before_sign_at_unix_ms INTO reservation_voided_at
        FROM p2tr_signature_fraud_challenge_nonce_guard
        WHERE nonce_guard_id = OLD.nonce_reservation_id
          AND record_id = OLD.record_id;
    END IF;

    IF OLD.selected_signer_lane_id IS NOT NULL
       AND ROW(
            NEW.selected_signer_lane_id,
            NEW.selected_signer_identity,
            NEW.selected_sender
       ) IS DISTINCT FROM ROW(
            OLD.selected_signer_lane_id,
            OLD.selected_signer_identity,
            OLD.selected_sender
       )
       AND NOT (
            NEW.selected_signer_lane_id IS NULL
            AND OLD.signer_invocation_started_at_unix_ms IS NULL
            AND OLD.prepared_transaction_hash IS NULL
            AND (OLD.nonce_reservation_id IS NULL
                 OR reservation_voided_at IS NOT NULL)
       ) THEN
        RAISE EXCEPTION 'selected P2TR signer lane cannot change after reservation or signing';
    END IF;

    IF OLD.selected_signer_lane_id IS NULL
       AND NEW.selected_signer_lane_id IS NOT NULL THEN
        PERFORM 1
        FROM p2tr_signature_fraud_signer_lane_configuration
        WHERE activation_manifest_hash = NEW.activation_manifest_hash
          AND chain_id = NEW.chain_id
          AND signer_lane_id = NEW.selected_signer_lane_id
          AND signer_identity = NEW.selected_signer_identity
          AND sender = NEW.selected_sender
          AND enabled
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'selected signer lane is not enabled by the current manifest';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM p2tr_signature_fraud_challenge_nonce_release_request r
            WHERE r.chain_id = NEW.chain_id
              AND (r.signer_lane_id = NEW.selected_signer_lane_id
                   OR r.signer_identity = NEW.selected_signer_identity
                   OR r.sender = NEW.selected_sender)
              AND NOT EXISTS (
                  SELECT 1
                  FROM p2tr_signature_fraud_challenge_nonce_release_terminal x
                  WHERE x.release_request_id = r.release_request_id
              )
        ) THEN
            RAISE EXCEPTION 'selected signer lane has an unacknowledged nonce release';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM p2tr_signature_fraud_challenge_signer_quarantine q
            WHERE q.chain_id = NEW.chain_id
              AND (q.signer_lane_id = NEW.selected_signer_lane_id
                   OR q.signer_identity = NEW.selected_signer_identity
                   OR q.expected_sender = NEW.selected_sender)
        ) THEN
            RAISE EXCEPTION 'selected P2TR challenge signer lane is quarantined';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM p2tr_signature_fraud_challenge_critical_alert a
            WHERE a.code = 'reservation-release-failed'
              AND NOT EXISTS (
                  SELECT 1
                  FROM p2tr_signature_fraud_challenge_critical_alert_resolution ar
                  WHERE ar.alert_id = a.alert_id
              )
        ) THEN
            RAISE EXCEPTION 'nonce allocator contract mismatch globally blocks signer lanes';
        END IF;

        PERFORM 1
        FROM p2tr_signature_fraud_challenge_fee_policy
        WHERE record_id = NEW.record_id
          AND policy_hash = NEW.fee_policy_hash
          AND signer_lane_id = NEW.selected_signer_lane_id
          AND signer_identity = NEW.selected_signer_identity
          AND sender = NEW.selected_sender
          AND chain_id = NEW.chain_id
          AND challenge_value_wei = NEW.value_wei
        FOR SHARE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'selected signer lane lacks its manifest-bound fee and value policy';
        END IF;
    END IF;

    IF OLD.nonce_reservation_id IS NOT NULL
       AND ROW(
            NEW.nonce_reservation_id,
            NEW.signer_lane_id,
            NEW.signer_identity,
            NEW.reserved_sender,
            NEW.reserved_nonce,
            NEW.nonce_reservation_binding,
            NEW.nonce_reserved_at_unix_ms
       ) IS DISTINCT FROM ROW(
            OLD.nonce_reservation_id,
            OLD.signer_lane_id,
            OLD.signer_identity,
            OLD.reserved_sender,
            OLD.reserved_nonce,
            OLD.nonce_reservation_binding,
            OLD.nonce_reserved_at_unix_ms
       ) THEN
        IF NEW.nonce_reservation_id IS NOT NULL
           OR OLD.signer_invocation_started_at_unix_ms IS NOT NULL
           OR OLD.prepared_transaction_hash IS NOT NULL
           OR reservation_voided_at IS NULL THEN
            RAISE EXCEPTION 'durable P2TR challenge nonce reservation is immutable';
        END IF;
    END IF;

    IF OLD.nonce_reservation_id IS NULL
       AND NEW.nonce_reservation_id IS NOT NULL THEN
        IF OLD.selected_signer_lane_id IS NULL THEN
            RAISE EXCEPTION 'P2TR signer lane must be durably selected before nonce reservation';
        END IF;

        SELECT ng.guard_kind INTO guard_kind
        FROM p2tr_signature_fraud_challenge_nonce_guard ng
        WHERE ng.nonce_guard_id = NEW.nonce_reservation_id
          AND ng.record_id = NEW.record_id
          AND ng.chain_id = NEW.chain_id
          AND ng.signer_lane_id = NEW.signer_lane_id
          AND ng.signer_identity = NEW.signer_identity
          AND ng.sender = NEW.reserved_sender
          AND ng.transaction_nonce = NEW.reserved_nonce
          AND ng.reservation_binding = NEW.nonce_reservation_binding
          AND ng.guarded_at_unix_ms = NEW.nonce_reserved_at_unix_ms;

        IF guard_kind IS DISTINCT FROM 'bound-reservation' THEN
            RAISE EXCEPTION 'P2TR challenge nonce was not durably bound before use';
        END IF;
    END IF;

    IF OLD.signer_invocation_started_at_unix_ms IS NOT NULL
       AND NEW.signer_invocation_started_at_unix_ms IS DISTINCT FROM
           OLD.signer_invocation_started_at_unix_ms THEN
        RAISE EXCEPTION 'P2TR challenge signer invocation boundary is immutable';
    END IF;
    IF OLD.signer_invocation_id IS NOT NULL
       AND NEW.signer_invocation_id IS DISTINCT FROM OLD.signer_invocation_id THEN
        RAISE EXCEPTION 'P2TR challenge signer invocation boundary is immutable';
    END IF;
    IF OLD.active_signer_invocation_started_at_unix_ms IS NOT NULL
       AND NEW.active_signer_invocation_started_at_unix_ms IS NOT NULL
       AND NEW.active_signer_invocation_started_at_unix_ms IS DISTINCT FROM
           OLD.active_signer_invocation_started_at_unix_ms THEN
        RAISE EXCEPTION 'active signer invocation boundary cannot be replaced in flight';
    END IF;
    IF OLD.active_signer_invocation_id IS NOT NULL
       AND NEW.active_signer_invocation_id IS NOT NULL
       AND NEW.active_signer_invocation_id IS DISTINCT FROM
           OLD.active_signer_invocation_id THEN
        RAISE EXCEPTION 'active signer invocation boundary cannot be replaced in flight';
    END IF;
    IF OLD.active_signer_invocation_started_at_unix_ms IS NULL
       AND NEW.active_signer_invocation_started_at_unix_ms IS NOT NULL THEN
        -- Reacquire the exact manifest lane lock at the irreversible signer
        -- boundary. A lane can be selected long before signing; release-journal
        -- or quarantine evidence committed in between must still win this
        -- serialization race and keep the signer closed.
        PERFORM 1
        FROM p2tr_signature_fraud_signer_lane_configuration
        WHERE activation_manifest_hash = NEW.activation_manifest_hash
          AND chain_id = NEW.chain_id
          AND signer_lane_id = NEW.selected_signer_lane_id
          AND signer_identity = NEW.selected_signer_identity
          AND sender = NEW.selected_sender
          AND enabled
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'signer invocation lane is not enabled by the current manifest';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM p2tr_signature_fraud_challenge_nonce_release_request r
            WHERE r.chain_id = NEW.chain_id
              AND (r.signer_lane_id = NEW.selected_signer_lane_id
                   OR r.signer_identity = NEW.selected_signer_identity
                   OR r.sender = NEW.selected_sender)
              AND NOT EXISTS (
                  SELECT 1
                  FROM p2tr_signature_fraud_challenge_nonce_release_terminal x
                  WHERE x.release_request_id = r.release_request_id
              )
        ) THEN
            RAISE EXCEPTION 'signer invocation lane has an unacknowledged nonce release';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM p2tr_signature_fraud_challenge_signer_quarantine q
            WHERE q.chain_id = NEW.chain_id
              AND (q.signer_lane_id = NEW.selected_signer_lane_id
                   OR q.signer_identity = NEW.selected_signer_identity
                   OR q.expected_sender = NEW.selected_sender)
        ) THEN
            RAISE EXCEPTION 'signer invocation lane is quarantined';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM p2tr_signature_fraud_challenge_critical_alert a
            WHERE a.code = 'reservation-release-failed'
              AND NOT EXISTS (
                  SELECT 1
                  FROM p2tr_signature_fraud_challenge_critical_alert_resolution ar
                  WHERE ar.alert_id = a.alert_id
              )
        ) THEN
            RAISE EXCEPTION 'nonce allocator contract mismatch globally blocks signer invocation';
        END IF;

        UPDATE p2tr_signature_fraud_nonce_allocator_safety_barrier
           SET active_signer_invocation_count =
                   active_signer_invocation_count + 1
         WHERE singleton = true
           AND active_release_request_id IS NULL
           AND unresolved_release_count = 0
           AND NOT contract_mismatch_blocked;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'signer invocation is blocked by active nonce-release I/O';
        END IF;
    ELSIF OLD.active_signer_invocation_started_at_unix_ms IS NOT NULL
       AND NEW.active_signer_invocation_started_at_unix_ms IS NULL THEN
        UPDATE p2tr_signature_fraud_nonce_allocator_safety_barrier
           SET active_signer_invocation_count =
                   active_signer_invocation_count - 1
         WHERE singleton = true
           AND active_signer_invocation_count > 0;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'active signer invocation barrier counter underflow';
        END IF;
    END IF;
    IF NEW.signer_invocation_started_at_unix_ms IS NOT NULL
       AND NEW.nonce_reservation_id IS NULL THEN
        RAISE EXCEPTION 'signer invocation requires a durable bound nonce reservation';
    END IF;

    IF OLD.latest_variant_sequence IS NOT NULL
       AND (
           NEW.latest_variant_sequence IS NULL
           OR NEW.latest_variant_sequence < OLD.latest_variant_sequence
           OR (NEW.latest_variant_sequence = OLD.latest_variant_sequence
               AND NEW.prepared_transaction_hash <> OLD.prepared_transaction_hash)
       ) THEN
        RAISE EXCEPTION 'latest signed variant pointer cannot move backward or mutate';
    END IF;

    IF OLD.cancellation_evidence_id IS NOT NULL
       AND NEW.cancellation_evidence_id IS DISTINCT FROM OLD.cancellation_evidence_id THEN
        RAISE EXCEPTION 'P2TR challenge cancellation evidence link is immutable';
    END IF;
    IF OLD.provenance_invalidation_id IS NOT NULL
       AND NEW.provenance_invalidation_id IS DISTINCT FROM
            OLD.provenance_invalidation_id THEN
        RAISE EXCEPTION 'P2TR challenge provenance invalidation link is immutable';
    END IF;
    IF OLD.nonce_disposition_id IS NOT NULL
       AND NEW.nonce_disposition_id IS DISTINCT FROM OLD.nonce_disposition_id THEN
        RAISE EXCEPTION 'P2TR challenge nonce disposition link is immutable';
    END IF;
    IF OLD.lane_released_at_unix_ms IS NOT NULL
       AND NEW.lane_released_at_unix_ms IS DISTINCT FROM OLD.lane_released_at_unix_ms THEN
        RAISE EXCEPTION 'P2TR challenge nonce lane release is immutable';
    END IF;
    IF OLD.lane_released_at_unix_ms IS NULL
       AND NEW.lane_released_at_unix_ms IS NOT NULL THEN
        SELECT count(DISTINCT independence_domain_id) INTO attestation_count
        FROM p2tr_signature_fraud_challenge_nonce_disposition_attestation
        WHERE nonce_disposition_id = NEW.nonce_disposition_id;

        IF NEW.nonce_disposition_id IS NULL OR attestation_count < 2 THEN
            RAISE EXCEPTION 'nonce lane release requires independently attested final disposition';
        END IF;
    END IF;

    IF OLD.status IN (
        'accepted-own',
        'satisfied-external',
        'generation-required',
        'cancelled-before-broadcast',
        'cancelled-honest-spend',
        'cancelled-reorg',
        'cancelled-provenance-invalidated'
    ) AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'terminal P2TR challenge generation cannot be resurrected';
    END IF;

    IF NEW.status <> OLD.status
       AND NEW.status = 'cancelled-before-broadcast'
       AND OLD.status <> 'queued' THEN
        RAISE EXCEPTION 'operator cancellation is allowed only from an unsigned queued record';
    END IF;

    IF NEW.status <> OLD.status
       AND NEW.status IN ('cancelled-honest-spend', 'cancelled-reorg')
       AND OLD.status NOT IN ('queued', 'preparing') THEN
        RAISE EXCEPTION 'canonical cancellation is allowed only before signer invocation';
    END IF;

    IF NEW.cancellation_evidence_id IS NOT NULL THEN
        SELECT ce.evidence_kind INTO evidence_kind
        FROM p2tr_signature_fraud_challenge_cancellation_evidence ce
        WHERE ce.record_id = NEW.record_id
          AND ce.cancellation_evidence_id = NEW.cancellation_evidence_id
          AND ce.prior_bitcoin_tx_hash = NEW.bitcoin_tx_hash
          AND ce.prior_bitcoin_wtxid = NEW.bitcoin_wtxid
          AND ce.prior_bitcoin_input_index = NEW.bitcoin_input_index
          AND ce.prior_bitcoin_block_hash = NEW.bitcoin_block_hash
          AND ce.prior_bitcoin_block_height = NEW.bitcoin_block_height
          AND ce.bitcoin_cursor_block_height >= NEW.bitcoin_cursor_block_height
          AND (ce.bitcoin_cursor_block_height > NEW.bitcoin_cursor_block_height
               OR ce.bitcoin_cursor_block_hash = NEW.bitcoin_cursor_block_hash)
          AND ce.ethereum_cursor_block_number >= NEW.ethereum_lifecycle_block_number
          AND (ce.ethereum_cursor_block_number > NEW.ethereum_lifecycle_block_number
               OR ce.ethereum_cursor_block_hash = NEW.ethereum_lifecycle_block_hash);

        SELECT count(DISTINCT independence_domain_id) INTO attestation_count
        FROM p2tr_signature_fraud_challenge_cancellation_attestation
        WHERE cancellation_evidence_id = NEW.cancellation_evidence_id;

        IF evidence_kind IS NULL
           OR attestation_count < 2
           OR (NEW.status = 'cancelled-honest-spend'
               AND evidence_kind <> 'honest-spend')
           OR (NEW.status = 'cancelled-reorg'
               AND evidence_kind <> 'canonical-reorg') THEN
            RAISE EXCEPTION 'cancellation lacks matching independently attested canonical evidence';
        END IF;
    END IF;

    IF NEW.provenance_invalidation_id IS NOT NULL THEN
        PERFORM 1
          FROM p2tr_signature_fraud_challenge_provenance_invalidation pi
         WHERE pi.record_id = NEW.record_id
           AND pi.provenance_invalidation_id =
                NEW.provenance_invalidation_id
           AND pi.observation_id = NEW.observation_id
           AND pi.bitcoin_tx_hash = NEW.bitcoin_tx_hash
           AND pi.bitcoin_wtxid = NEW.bitcoin_wtxid
           AND pi.bitcoin_input_index = NEW.bitcoin_input_index
           AND pi.bitcoin_block_hash = NEW.bitcoin_block_hash
           AND pi.bitcoin_block_height = NEW.bitcoin_block_height
           AND pi.canonical_candidate_digest = NEW.canonical_candidate_digest
           AND pi.canonical_candidate_provenance_generation =
                NEW.canonical_candidate_provenance_generation
           AND pi.canonical_provenance_fingerprint =
                NEW.canonical_provenance_fingerprint
           AND pi.canonical_provenance_manifest_hash =
                NEW.canonical_provenance_manifest_hash
         FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'provenance transition lacks exact immutable invalidation evidence';
        END IF;

        IF NEW.status = 'cancelled-provenance-invalidated'
           AND (
               NEW.selected_signer_lane_id IS NOT NULL
               OR NEW.nonce_reservation_id IS NOT NULL
               OR NEW.signer_invocation_started_at_unix_ms IS NOT NULL
               OR NEW.prepared_transaction_hash IS NOT NULL
               OR NEW.broadcast_attempts > 0
           ) THEN
            RAISE EXCEPTION 'provenance cancellation cannot discard a signer, nonce, or send boundary';
        END IF;

        IF NEW.status = 'provenance-invalidated-awaiting-reconciliation'
           AND NEW.nonce_reservation_id IS NULL
           AND NEW.signer_invocation_started_at_unix_ms IS NULL
           AND NEW.prepared_transaction_hash IS NULL
           AND NEW.broadcast_attempts = 0 THEN
            RAISE EXCEPTION 'provenance reconciliation requires an escaped nonce, signer, or send boundary';
        END IF;

        IF NEW.status IN (
            'provenance-invalidated-awaiting-reconciliation',
            'accepted-own',
            'satisfied-external',
            'terminal-reverted',
            'terminal-nonce-consumed',
            'generation-required'
        ) AND NOT EXISTS (
            SELECT 1
              FROM p2tr_signature_fraud_challenge_provenance_incident pii
             WHERE pii.record_id = NEW.record_id
               AND pii.provenance_invalidation_id =
                    NEW.provenance_invalidation_id
               AND pii.activation_blocking
        ) THEN
            RAISE EXCEPTION 'escaped provenance invalidation lacks an activation-blocking incident';
        END IF;
    END IF;

    IF NEW.nonce_disposition_id IS NOT NULL THEN
        SELECT nd.disposition_kind INTO disposition_kind
        FROM p2tr_signature_fraud_challenge_nonce_disposition nd
        WHERE nd.record_id = NEW.record_id
          AND nd.nonce_disposition_id = NEW.nonce_disposition_id
          AND nd.nonce_reservation_id = NEW.nonce_reservation_id;

        SELECT count(DISTINCT independence_domain_id) INTO attestation_count
        FROM p2tr_signature_fraud_challenge_nonce_disposition_attestation
        WHERE nonce_disposition_id = NEW.nonce_disposition_id;

        IF disposition_kind IS NULL
           OR attestation_count < 2
           OR (NEW.status = 'terminal-reverted'
               AND disposition_kind <> 'finalized-reverted')
           OR (NEW.status = 'terminal-nonce-consumed'
               AND disposition_kind <> 'finalized-nonce-consumed')
           OR (NEW.status = 'generation-required'
               AND disposition_kind NOT IN ('finalized-reverted', 'finalized-nonce-consumed'))
           OR (NEW.status = 'accepted-own'
               AND disposition_kind <> 'finalized-accepted-own')
           OR (NEW.status = 'satisfied-external'
               AND disposition_kind <> 'finalized-after-external-satisfaction') THEN
            RAISE EXCEPTION 'terminal state lacks matching independently attested nonce disposition';
        END IF;
    END IF;

    IF NEW.signer_quarantine_id IS NOT NULL THEN
        SELECT sq.quarantine_reason INTO quarantine_reason
        FROM p2tr_signature_fraud_challenge_signer_quarantine sq
        WHERE sq.record_id = NEW.record_id
          AND sq.signer_quarantine_id = NEW.signer_quarantine_id
          AND sq.nonce_reservation_id = NEW.nonce_reservation_id;

        IF quarantine_reason IS NULL
           OR NEW.status <> 'quarantined'
           OR (quarantine_reason IN ('wrong-sender', 'wrong-nonce')
               AND NOT EXISTS (
                   SELECT 1
                   FROM p2tr_signature_fraud_challenge_escaped_envelope ee
                   WHERE ee.record_id = NEW.record_id
                     AND ee.signer_quarantine_id = NEW.signer_quarantine_id
               )) THEN
            RAISE EXCEPTION 'quarantined signer outcome lacks immutable evidence';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_protect_outbox_update_trigger
BEFORE UPDATE ON p2tr_signature_fraud_challenge_outbox
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_protect_outbox_update();

CREATE FUNCTION p2tr_signature_fraud_validate_nonce_guard_void()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'P2TR challenge nonce guards cannot be deleted';
    END IF;

    IF OLD.guard_kind <> 'bound-reservation'
       OR OLD.voided_before_sign_at_unix_ms IS NOT NULL
       OR NEW.voided_before_sign_at_unix_ms IS NULL
       OR NEW.void_reason IS NULL
       OR NEW.void_evidence_digest IS NULL
       OR ROW(
            NEW.nonce_guard_id,
            NEW.record_id,
            NEW.guard_kind,
            NEW.chain_id,
            NEW.signer_lane_id,
            NEW.signer_identity,
            NEW.sender,
            NEW.transaction_nonce,
            NEW.reservation_binding,
            NEW.reservation_epoch,
            NEW.parent_reservation_id,
            NEW.guarded_at_unix_ms
       ) IS DISTINCT FROM ROW(
            OLD.nonce_guard_id,
            OLD.record_id,
            OLD.guard_kind,
            OLD.chain_id,
            OLD.signer_lane_id,
            OLD.signer_identity,
            OLD.sender,
            OLD.transaction_nonce,
            OLD.reservation_binding,
            OLD.reservation_epoch,
            OLD.parent_reservation_id,
            OLD.guarded_at_unix_ms
       ) THEN
        RAISE EXCEPTION 'P2TR challenge nonce guard mutation is not a safe pre-sign void';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM p2tr_signature_fraud_challenge_escaped_envelope ee
        WHERE ee.actual_guard_record_id = OLD.record_id
          AND ee.actual_nonce_guard_id = OLD.nonce_guard_id
    ) THEN
        RAISE EXCEPTION 'nonce guard referenced by escaped signed bytes cannot be voided';
    END IF;

    PERFORM 1
    FROM p2tr_signature_fraud_challenge_outbox
    WHERE record_id = OLD.record_id
      AND status IN ('queued', 'preparing')
      AND signer_invocation_started_at_unix_ms IS NULL
      AND active_signer_invocation_started_at_unix_ms IS NULL
      AND prepared_transaction_hash IS NULL
      AND broadcast_attempts = 0
      AND (
          nonce_reservation_id = OLD.nonce_guard_id
          OR (
              nonce_reservation_id IS NULL
              AND selected_signer_lane_id = OLD.signer_lane_id
              AND selected_signer_identity = OLD.signer_identity
              AND selected_sender = OLD.sender
          )
      )
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'only an unsigned selected reservation can be voided';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER p2tr_signature_fraud_reject_outbox_generation_delete_trigger
BEFORE DELETE ON p2tr_signature_fraud_challenge_outbox
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_fee_policy_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_fee_policy
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_lane_configuration_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_signer_lane_configuration
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_state_history_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_outbox_state_history
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_validate_nonce_guard_void_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_nonce_guard
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_validate_nonce_guard_void();

CREATE TRIGGER p2tr_signature_fraud_reject_nonce_release_request_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_nonce_release_request
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_nonce_release_attempt_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_nonce_release_attempt
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_nonce_release_invocation_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_nonce_release_invocation
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_nonce_release_result_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_nonce_release_result
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_nonce_release_resolution_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_nonce_release_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_variant_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_outbox_variant
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_attempt_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_outbox_broadcast_attempt
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_acknowledgement_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_outbox_broadcast_acknowledgement
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_cancellation_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_cancellation_evidence
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_cancellation_attestation_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_cancellation_attestation
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_provenance_invalidation_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_provenance_invalidation
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_provenance_incident_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_provenance_incident
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_incident_resolution_mutation_trigger
BEFORE UPDATE OR DELETE
ON p2tr_signature_fraud_challenge_provenance_incident_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_signer_boundary_resolution_mutation_trigger
BEFORE UPDATE OR DELETE
ON p2tr_signature_fraud_challenge_signer_boundary_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_disposition_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_nonce_disposition
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_disposition_attestation_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_nonce_disposition_attestation
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_signer_quarantine_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_signer_quarantine
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_escaped_envelope_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_escaped_envelope
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_late_signed_artifact_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_late_signed_artifact
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_critical_alert_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_critical_alert
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

CREATE TRIGGER p2tr_signature_fraud_reject_critical_alert_resolution_mutation_trigger
BEFORE UPDATE OR DELETE ON p2tr_signature_fraud_challenge_critical_alert_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

-- Extend migration 002's manifest monotonicity trigger in place. Because the
-- existing trigger invokes this function by OID, CREATE OR REPLACE makes the
-- manifest update, authorization invalidation, outbox provenance tombstones,
-- incidents, alerts, and row transitions one database transaction. There is
-- no crash window for an application-level sweep.
CREATE OR REPLACE FUNCTION p2tr_watchtower_activation_manifest_monotonic()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
DECLARE
    rotation_at timestamptz;
    rotation_at_unix_ms bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'production activation manifest cannot be deleted';
    END IF;
    IF NEW.activation_sequence <= OLD.activation_sequence THEN
        RAISE EXCEPTION 'production activation sequence must increase';
    END IF;

    rotation_at := clock_timestamp();
    rotation_at_unix_ms := floor(extract(epoch FROM rotation_at) * 1000)::bigint;

    UPDATE p2tr_candidate_enqueue_authorizations
       SET invalidated_at = rotation_at
     WHERE consumed_at IS NULL
       AND invalidated_at IS NULL;

    INSERT INTO p2tr_signature_fraud_challenge_provenance_invalidation (
        provenance_invalidation_id,
        record_id,
        provenance_tombstone_id,
        observation_id,
        bitcoin_tx_hash,
        bitcoin_wtxid,
        bitcoin_input_index,
        bitcoin_block_hash,
        bitcoin_block_height,
        canonical_candidate_digest,
        canonical_candidate_provenance_generation,
        canonical_provenance_fingerprint,
        canonical_provenance_manifest_hash,
        ethereum_rollback_block_hash,
        ethereum_rollback_block_number,
        provenance_invalidation_sequence,
        evidence_digest,
        reason,
        invalidated_at_unix_ms,
        invalidation_source
    )
    SELECT
        sha256(convert_to('p2tr-outbox-manifest-invalidation-v1', 'UTF8')
            || o.record_id || OLD.manifest_hash || NEW.manifest_hash
            || int8send(NEW.activation_sequence)),
        o.record_id,
        sha256(convert_to('p2tr-manifest-rotation-tombstone-v1', 'UTF8')
            || o.record_id || OLD.manifest_hash || NEW.manifest_hash
            || int8send(NEW.activation_sequence)),
        o.observation_id,
        o.bitcoin_tx_hash,
        o.bitcoin_wtxid,
        o.bitcoin_input_index,
        o.bitcoin_block_hash,
        o.bitcoin_block_height,
        o.canonical_candidate_digest,
        o.canonical_candidate_provenance_generation,
        o.canonical_provenance_fingerprint,
        o.canonical_provenance_manifest_hash,
        (SELECT current_block_hash
           FROM p2tr_ethereum_cursor
          WHERE singleton = true),
        (SELECT current_block_number
           FROM p2tr_ethereum_cursor
          WHERE singleton = true),
        NEW.activation_sequence,
        sha256(convert_to('p2tr-outbox-manifest-evidence-v1', 'UTF8')
            || o.record_id || o.canonical_provenance_fingerprint
            || OLD.manifest_hash || NEW.manifest_hash
            || int8send(NEW.activation_sequence)),
        'activation manifest rotation invalidated the generation provenance',
        rotation_at_unix_ms,
        'manifest-rotation'
      FROM p2tr_signature_fraud_challenge_outbox o
     WHERE o.activation_manifest_hash = OLD.manifest_hash
       AND o.provenance_invalidation_id IS NULL
       AND o.status NOT IN (
           'cancelled-before-broadcast',
           'cancelled-honest-spend',
           'cancelled-reorg',
           'cancelled-provenance-invalidated'
       );

    INSERT INTO p2tr_signature_fraud_challenge_provenance_incident (
        incident_id,
        record_id,
        provenance_invalidation_id,
        incident_kind,
        details_digest,
        activation_blocking,
        created_at_unix_ms
    )
    SELECT
        sha256(convert_to('p2tr-outbox-manifest-incident-v1', 'UTF8')
            || o.record_id || pi.provenance_invalidation_id),
        o.record_id,
        pi.provenance_invalidation_id,
        CASE
            WHEN o.status IN (
                'accepted-own',
                'satisfied-external',
                'terminal-reverted',
                'terminal-nonce-consumed',
                'generation-required'
            ) THEN 'terminal-chain-effect'
            WHEN o.broadcast_attempts > 0 THEN 'broadcast-attempt-active'
            WHEN o.prepared_transaction_hash IS NOT NULL
                THEN 'manifest-rotation-signed-state'
            WHEN o.signer_invocation_started_at_unix_ms IS NOT NULL
              OR o.active_signer_invocation_started_at_unix_ms IS NOT NULL
                THEN 'signer-boundary-active'
            ELSE 'reservation-intent-in-flight'
        END,
        sha256(convert_to('p2tr-outbox-manifest-incident-details-v1', 'UTF8')
            || o.record_id || pi.provenance_invalidation_id
            || int8send(o.version)),
        true,
        rotation_at_unix_ms
      FROM p2tr_signature_fraud_challenge_outbox o
      JOIN p2tr_signature_fraud_challenge_provenance_invalidation pi
        ON pi.record_id = o.record_id
       AND pi.invalidation_source = 'manifest-rotation'
     WHERE o.activation_manifest_hash = OLD.manifest_hash
       -- This is the exact predicate the adapter's canonical-rollback
       -- invalidation applies: escaped OR active preparation in flight OR
       -- terminal preserves an activation-blocking incident, and only a
       -- genuinely inactive unsigned preparation is excluded. An
       -- active-initial boundary stays 'preparing' below, but the worker that
       -- observes the signer RPC return moves it to
       -- 'provenance-invalidated-awaiting-reconciliation', and the status
       -- trigger rejects that transition without this incident.
       AND (
           -- terminal
           o.status IN (
               'accepted-own',
               'satisfied-external',
               'terminal-reverted',
               'terminal-nonce-consumed',
               'generation-required'
           )
           -- escaped
           OR o.signer_invocation_started_at_unix_ms IS NOT NULL
           OR o.prepared_transaction_hash IS NOT NULL
           OR o.broadcast_attempts > 0
           OR coalesce(
                  jsonb_array_length(
                      o.record_state -> 'unexpectedSignedArtifacts'
                  ),
                  0
              ) > 0
           -- active preparation in flight
           OR (
               o.status = 'preparing'
               AND o.preparation_lease_owner IS NOT NULL
               AND o.active_signer_invocation_started_at_unix_ms IS NOT NULL
           )
       );

    INSERT INTO p2tr_signature_fraud_challenge_critical_alert (
        alert_id,
        series_id,
        record_id,
        generation,
        code,
        details_digest,
        created_at_unix_ms,
        activation_blocking
    )
    SELECT
        sha256(convert_to('p2tr-outbox-provenance-alert-v1', 'UTF8')
            || o.record_id),
        o.series_id,
        o.record_id,
        o.generation,
        'provenance-reconciliation-incident',
        pii.details_digest,
        rotation_at_unix_ms,
        true
      FROM p2tr_signature_fraud_challenge_outbox o
      JOIN p2tr_signature_fraud_challenge_provenance_incident pii
        ON pii.record_id = o.record_id
     WHERE o.activation_manifest_hash = OLD.manifest_hash
    ON CONFLICT (record_id, generation, code) DO NOTHING;

    UPDATE p2tr_signature_fraud_challenge_outbox o
       SET provenance_invalidation_id = pi.provenance_invalidation_id,
           status = CASE
               WHEN o.status IN (
                   'accepted-own',
                   'satisfied-external',
                   'terminal-reverted',
                   'terminal-nonce-consumed',
                   'generation-required'
               ) THEN o.status
               WHEN o.status = 'preparing'
                    AND o.selected_signer_lane_id IS NOT NULL
                    AND (
                        o.active_signer_invocation_started_at_unix_ms IS NOT NULL
                        OR (
                            o.signer_invocation_started_at_unix_ms IS NULL
                            AND o.prepared_transaction_hash IS NULL
                            AND o.broadcast_attempts = 0
                        )
                    )
                   THEN 'preparing'
               WHEN o.nonce_reservation_id IS NOT NULL
                    OR o.signer_invocation_started_at_unix_ms IS NOT NULL
                    OR o.prepared_transaction_hash IS NOT NULL
                    OR o.broadcast_attempts > 0
                   THEN 'provenance-invalidated-awaiting-reconciliation'
               ELSE 'cancelled-provenance-invalidated'
           END,
           preparation_lease_owner = CASE
               WHEN o.status = 'preparing'
                    AND o.selected_signer_lane_id IS NOT NULL
                    AND (
                        o.active_signer_invocation_started_at_unix_ms IS NOT NULL
                        OR o.signer_invocation_started_at_unix_ms IS NULL
                    )
                   THEN o.preparation_lease_owner
               ELSE NULL
           END,
           preparation_lease_expires_at_unix_ms = CASE
               WHEN o.status = 'preparing'
                    AND o.selected_signer_lane_id IS NOT NULL
                    AND (
                        o.active_signer_invocation_started_at_unix_ms IS NOT NULL
                        OR o.signer_invocation_started_at_unix_ms IS NULL
                    )
                   THEN o.preparation_lease_expires_at_unix_ms
               ELSE NULL
           END,
           preparation_resume_status = CASE
               WHEN o.status = 'preparing'
                    AND o.selected_signer_lane_id IS NOT NULL
                    AND (
                        o.active_signer_invocation_started_at_unix_ms IS NOT NULL
                        OR o.signer_invocation_started_at_unix_ms IS NULL
                    )
                   THEN o.preparation_resume_status
               ELSE NULL
           END,
           selected_signer_lane_id = CASE
               WHEN o.status = 'preparing'
                    AND o.selected_signer_lane_id IS NOT NULL
                    AND (
                        o.active_signer_invocation_started_at_unix_ms IS NOT NULL
                        OR o.signer_invocation_started_at_unix_ms IS NULL
                    )
                   THEN o.selected_signer_lane_id
               WHEN o.nonce_reservation_id IS NULL
                    AND o.signer_invocation_started_at_unix_ms IS NULL
                   THEN NULL
               ELSE o.selected_signer_lane_id
           END,
           selected_signer_identity = CASE
               WHEN o.status = 'preparing'
                    AND o.selected_signer_lane_id IS NOT NULL
                    AND (
                        o.active_signer_invocation_started_at_unix_ms IS NOT NULL
                        OR o.signer_invocation_started_at_unix_ms IS NULL
                    )
                   THEN o.selected_signer_identity
               WHEN o.nonce_reservation_id IS NULL
                    AND o.signer_invocation_started_at_unix_ms IS NULL
                   THEN NULL
               ELSE o.selected_signer_identity
           END,
           selected_sender = CASE
               WHEN o.status = 'preparing'
                    AND o.selected_signer_lane_id IS NOT NULL
                    AND (
                        o.active_signer_invocation_started_at_unix_ms IS NOT NULL
                        OR o.signer_invocation_started_at_unix_ms IS NULL
                    )
                   THEN o.selected_sender
               WHEN o.nonce_reservation_id IS NULL
                    AND o.signer_invocation_started_at_unix_ms IS NULL
                   THEN NULL
               ELSE o.selected_sender
           END,
           version = o.version + 1,
           updated_at_unix_ms = greatest(
               o.updated_at_unix_ms,
               rotation_at_unix_ms
           ),
           last_error =
               'activation manifest rotation invalidated canonical provenance',
           record_state = jsonb_set(
               jsonb_set(
                   jsonb_set(
                       jsonb_set(
                           CASE
                               WHEN o.status = 'preparing'
                                    AND o.selected_signer_lane_id IS NOT NULL
                                    AND (
                                        o.active_signer_invocation_started_at_unix_ms IS NOT NULL
                                        OR o.signer_invocation_started_at_unix_ms IS NULL
                                    )
                                   THEN o.record_state
                               ELSE o.record_state - 'preparationResumeStatus'
                           END,
                           '{status}',
                           to_jsonb(CASE
                               WHEN o.status IN (
                                   'accepted-own',
                                   'satisfied-external',
                                   'terminal-reverted',
                                   'terminal-nonce-consumed',
                                   'generation-required'
                               ) THEN o.status
                               WHEN o.status = 'preparing'
                                    AND o.selected_signer_lane_id IS NOT NULL
                                    AND (
                                        o.active_signer_invocation_started_at_unix_ms IS NOT NULL
                                        OR (
                                            o.signer_invocation_started_at_unix_ms IS NULL
                                            AND o.prepared_transaction_hash IS NULL
                                            AND o.broadcast_attempts = 0
                                        )
                                    )
                                   THEN 'preparing'
                               WHEN o.nonce_reservation_id IS NOT NULL
                                    OR o.signer_invocation_started_at_unix_ms IS NOT NULL
                                    OR o.prepared_transaction_hash IS NOT NULL
                                    OR o.broadcast_attempts > 0
                                   THEN 'provenance-invalidated-awaiting-reconciliation'
                               ELSE 'cancelled-provenance-invalidated'
                           END),
                           true
                       ),
                       '{version}',
                       to_jsonb(o.version + 1),
                       true
                   ),
                   '{updatedAtUnixMs}',
                   to_jsonb(greatest(o.updated_at_unix_ms, rotation_at_unix_ms)),
                   true
               ),
               '{lastError}',
               to_jsonb('activation manifest rotation invalidated canonical provenance'::text),
               true
           )
      FROM p2tr_signature_fraud_challenge_provenance_invalidation pi
     WHERE pi.record_id = o.record_id
       AND pi.invalidation_source = 'manifest-rotation'
       AND o.activation_manifest_hash = OLD.manifest_hash
       AND o.provenance_invalidation_id IS NULL;

    RETURN NEW;
END;
$body$;

CREATE INDEX p2tr_signature_fraud_challenge_outbox_dispatch_idx
    ON p2tr_signature_fraud_challenge_outbox (
        status,
        updated_at_unix_ms,
        record_id
    );

CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_active_generation_idx
    ON p2tr_signature_fraud_challenge_outbox (
        chain_id,
        router_address,
        bridge_challenge_key
    )
    WHERE status NOT IN (
        'accepted-own',
        'satisfied-external',
        'terminal-reverted',
        'terminal-nonce-consumed',
        'generation-required',
        'cancelled-before-broadcast',
        'cancelled-honest-spend',
        'cancelled-reorg',
        'cancelled-provenance-invalidated'
    );

CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_active_lane_idx
    ON p2tr_signature_fraud_challenge_outbox (chain_id, signer_lane_id)
    WHERE nonce_reservation_id IS NOT NULL
      AND lane_released_at_unix_ms IS NULL;

CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_selected_lane_idx
    ON p2tr_signature_fraud_challenge_outbox (
        chain_id,
        selected_signer_lane_id
    )
    WHERE selected_signer_lane_id IS NOT NULL
      AND lane_released_at_unix_ms IS NULL;

CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_selected_sender_idx
    ON p2tr_signature_fraud_challenge_outbox (chain_id, selected_sender)
    WHERE selected_sender IS NOT NULL
      AND lane_released_at_unix_ms IS NULL;

CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_active_sender_idx
    ON p2tr_signature_fraud_challenge_outbox (chain_id, reserved_sender)
    WHERE nonce_reservation_id IS NOT NULL
      AND lane_released_at_unix_ms IS NULL;

CREATE TABLE p2tr_signature_fraud_legacy_submission_quarantine (
    observation_id bytea PRIMARY KEY CHECK (octet_length(observation_id) = 32),
    bridge_challenge_key bytea CHECK (
        bridge_challenge_key IS NULL
        OR octet_length(bridge_challenge_key) = 32
    ),
    legacy_status text NOT NULL CHECK (length(legacy_status) BETWEEN 1 AND 64),
    submission_attempts integer NOT NULL CHECK (submission_attempts >= 0),
    challenge_transaction_hash bytea CHECK (
        challenge_transaction_hash IS NULL
        OR octet_length(challenge_transaction_hash) = 32
    ),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1024),
    quarantined_at_unix_ms bigint NOT NULL CHECK (
        quarantined_at_unix_ms BETWEEN 0 AND 9007199254740991
    )
);

-- A quarantined legacy submission is an unauthenticated broadcast whose chain
-- effect the outbox cannot reconstruct, so it is never retried automatically
-- and never expires on its own. The activation handshake counts every row that
-- has no resolution here, which keeps the gate closed until an operator has
-- established what the legacy broadcast actually did and recorded that finding
-- against the observation. Without this journal the quarantine would either
-- block activation forever or -- as it did before -- not block it at all.
CREATE TABLE p2tr_signature_fraud_legacy_submission_quarantine_resolution (
    observation_id bytea PRIMARY KEY
        REFERENCES p2tr_signature_fraud_legacy_submission_quarantine(
            observation_id
        ) ON DELETE RESTRICT,
    outcome text NOT NULL CHECK (outcome IN (
        'legacy-submission-never-landed',
        'legacy-submission-canonically-settled',
        'legacy-submission-superseded-by-outbox'
    )),
    resolution_digest bytea NOT NULL CHECK (
        octet_length(resolution_digest) = 32
    ),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1024),
    resolved_at_unix_ms bigint NOT NULL CHECK (
        resolved_at_unix_ms BETWEEN 0 AND 9007199254740991
    )
);

-- The activation gate signs the outbox handshake in the outbox's own committed
-- transaction and then mints readiness in a second, separate transaction. This
-- function is what the readiness transaction re-derives for itself, so the two
-- samples can be compared and the second one joins the minting transaction's
-- SERIALIZABLE read set. Keeping it here rather than in the gate's TypeScript
-- means the handshake and the revalidation cannot drift apart into two
-- different definitions of the same safety facts.
CREATE FUNCTION p2tr_signature_fraud_outbox_activation_revalidation(
    activation_manifest_hash bytea,
    sampled_at_unix_ms bigint
)
RETURNS TABLE (
    activation_blocking_critical_alert_count bigint,
    ambiguous_transaction_count bigint,
    unresolved_legacy_quarantine_count bigint,
    recovery_backlog_count bigint,
    quarantined_signer_lane_count bigint,
    active_old_manifest_generation_count bigint,
    stale_manifest_generation_successor_count bigint,
    active_signer_invocation_count bigint,
    active_nonce_release_attempt_count bigint
)
LANGUAGE sql
STABLE
AS $$
    SELECT (
             (
               SELECT count(*)
                 FROM p2tr_signature_fraud_challenge_critical_alert a
                WHERE a.activation_blocking
                  AND NOT EXISTS (
                      SELECT 1
                        FROM p2tr_signature_fraud_challenge_critical_alert_resolution ar
                       WHERE ar.alert_id = a.alert_id
                  )
             ) + (
               SELECT count(*)
                 FROM p2tr_signature_fraud_challenge_provenance_incident i
                WHERE i.activation_blocking
                  AND NOT EXISTS (
                      SELECT 1
                        FROM p2tr_signature_fraud_challenge_provenance_incident_resolution ir
                       WHERE ir.incident_id = i.incident_id
                  )
             )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_challenge_nonce_release_request r
               JOIN LATERAL (
                 SELECT x.result_kind
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
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_legacy_submission_quarantine q
              WHERE NOT EXISTS (
                    SELECT 1
                      FROM p2tr_signature_fraud_legacy_submission_quarantine_resolution qr
                     WHERE qr.observation_id = q.observation_id
                )
           )::bigint,
           (
             (
               SELECT count(*)
                 FROM p2tr_signature_fraud_challenge_outbox o
                WHERE o.status = 'preparing'
                  AND o.preparation_lease_expires_at_unix_ms
                      <= p2tr_signature_fraud_outbox_activation_revalidation.sampled_at_unix_ms
             ) + (
               SELECT count(*)
                 FROM p2tr_signature_fraud_challenge_nonce_release_request r
                WHERE NOT EXISTS (
                      SELECT 1
                        FROM p2tr_signature_fraud_challenge_nonce_release_terminal x
                       WHERE x.release_request_id = r.release_request_id
                  )
             )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_signer_lane_configuration c
              WHERE c.activation_manifest_hash
                    = p2tr_signature_fraud_outbox_activation_revalidation.activation_manifest_hash
                AND c.enabled
                AND EXISTS (
                    SELECT 1
                      FROM p2tr_signature_fraud_challenge_signer_quarantine q
                     WHERE q.chain_id = c.chain_id
                       AND (q.signer_lane_id = c.signer_lane_id
                            OR q.signer_identity = c.signer_identity
                            OR q.expected_sender = c.sender)
                )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_challenge_outbox o
              WHERE o.activation_manifest_hash
                    <> p2tr_signature_fraud_outbox_activation_revalidation.activation_manifest_hash
                AND o.status NOT IN (
                    'accepted-own',
                    'satisfied-external',
                    'terminal-reverted',
                    'terminal-nonce-consumed',
                    'generation-required',
                    'cancelled-before-broadcast',
                    'cancelled-honest-spend',
                    'cancelled-reorg',
                    'cancelled-provenance-invalidated'
                )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_challenge_outbox o
              WHERE o.status = 'generation-required'
                AND o.activation_manifest_hash
                    <> p2tr_signature_fraud_outbox_activation_revalidation.activation_manifest_hash
                AND NOT EXISTS (
                    SELECT 1
                      FROM p2tr_signature_fraud_challenge_outbox s
                     WHERE s.previous_record_id = o.record_id
                )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_challenge_outbox o
              WHERE o.active_signer_invocation_started_at_unix_ms IS NOT NULL
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_nonce_allocator_safety_barrier b
              WHERE b.active_release_request_id IS NOT NULL
           )::bigint;
$$;
