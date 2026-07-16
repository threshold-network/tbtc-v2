-- Durable, immutable signed-transaction outbox for P2TR fraud challenges.
--
-- The enqueue INSERT must commit in the same database transaction as the
-- confirmed Bitcoin observation and both canonical source cursors. Dispatch
-- uses UPDATE ... WHERE intent_id = $1 AND version = $2 for every transition.

BEGIN;

INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('signature-fraud-challenge-outbox', 1);

CREATE TABLE p2tr_signature_fraud_challenge_outbox (
    intent_id bytea PRIMARY KEY CHECK (octet_length(intent_id) = 32),
    observation_id bytea NOT NULL CHECK (octet_length(observation_id) = 32),
    bridge_challenge_key bytea NOT NULL CHECK (octet_length(bridge_challenge_key) = 32),
    wallet_id bytea NOT NULL CHECK (octet_length(wallet_id) = 32),
    bridge_challenge_identity bytea NOT NULL CHECK (octet_length(bridge_challenge_identity) = 32),
    sighash bytea NOT NULL CHECK (octet_length(sighash) = 32),
    chain_id numeric(78, 0) NOT NULL CHECK (chain_id > 0),
    bridge_address bytea NOT NULL CHECK (octet_length(bridge_address) = 20),
    router_address bytea NOT NULL CHECK (octet_length(router_address) = 20),
    calldata bytea NOT NULL,
    value_wei numeric(78, 0) NOT NULL CHECK (value_wei >= 0),

    bitcoin_tx_hash bytea NOT NULL CHECK (octet_length(bitcoin_tx_hash) = 32),
    bitcoin_wtxid bytea NOT NULL CHECK (octet_length(bitcoin_wtxid) = 32),
    bitcoin_input_index bigint NOT NULL CHECK (
        bitcoin_input_index BETWEEN 0 AND 4294967295
    ),
    bitcoin_block_hash bytea NOT NULL CHECK (octet_length(bitcoin_block_hash) = 32),
    bitcoin_block_height bigint NOT NULL CHECK (bitcoin_block_height >= 0),
    bitcoin_cursor_block_hash bytea NOT NULL CHECK (octet_length(bitcoin_cursor_block_hash) = 32),
    bitcoin_cursor_block_height bigint NOT NULL CHECK (bitcoin_cursor_block_height >= bitcoin_block_height),
    ethereum_lifecycle_block_hash bytea NOT NULL CHECK (octet_length(ethereum_lifecycle_block_hash) = 32),
    ethereum_lifecycle_block_number bigint NOT NULL CHECK (ethereum_lifecycle_block_number >= 0),
    activation_manifest_hash bytea NOT NULL CHECK (octet_length(activation_manifest_hash) = 32),
    router_code_hash bytea NOT NULL CHECK (octet_length(router_code_hash) = 32),
    router_protocol_id text NOT NULL CHECK (length(router_protocol_id) BETWEEN 1 AND 128),
    complete_authorization_registry_address bytea NOT NULL CHECK (octet_length(complete_authorization_registry_address) = 20),
    complete_authorization_registry_code_hash bytea NOT NULL CHECK (octet_length(complete_authorization_registry_code_hash) = 32),
    complete_authorization_registry_protocol_id text NOT NULL CHECK (length(complete_authorization_registry_protocol_id) BETWEEN 1 AND 128),
    complete_reservation_model text NOT NULL CHECK (length(complete_reservation_model) BETWEEN 1 AND 128),
    ethereum_eligibility_read_set_hash bytea NOT NULL CHECK (octet_length(ethereum_eligibility_read_set_hash) = 32),
    router_challenge_absent boolean NOT NULL CHECK (router_challenge_absent),
    complete_authorization_absent boolean NOT NULL CHECK (complete_authorization_absent),
    complete_reservation_absent boolean NOT NULL CHECK (complete_reservation_absent),
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
        'cancelled-before-broadcast',
        'cancelled-honest-spend',
        'cancelled-reorg',
        'quarantined'
    )),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    generation integer NOT NULL DEFAULT 0 CHECK (generation = 0),
    created_at_unix_ms bigint NOT NULL CHECK (
        created_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    updated_at_unix_ms bigint NOT NULL CHECK (
        updated_at_unix_ms BETWEEN created_at_unix_ms AND 9007199254740991
    ),

    preparation_attempts integer NOT NULL DEFAULT 0 CHECK (preparation_attempts >= 0),
    preparation_sender bytea CHECK (
        preparation_sender IS NULL OR octet_length(preparation_sender) = 20
    ),
    preparation_lease_owner text CHECK (
        preparation_lease_owner IS NULL
        OR length(preparation_lease_owner) BETWEEN 1 AND 128
    ),
    preparation_lease_expires_at_unix_ms bigint CHECK (
        preparation_lease_expires_at_unix_ms IS NULL
        OR preparation_lease_expires_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    signer_invocation_started_at_unix_ms bigint CHECK (
        signer_invocation_started_at_unix_ms IS NULL
        OR signer_invocation_started_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    prepared_raw_transaction bytea,
    prepared_transaction_hash bytea CHECK (
        prepared_transaction_hash IS NULL
        OR octet_length(prepared_transaction_hash) = 32
    ),
    prepared_sender bytea CHECK (
        prepared_sender IS NULL
        OR octet_length(prepared_sender) = 20
    ),
    prepared_nonce bigint CHECK (prepared_nonce IS NULL OR prepared_nonce >= 0),

    broadcast_attempts integer NOT NULL DEFAULT 0 CHECK (broadcast_attempts >= 0),
    last_broadcast_at_unix_ms bigint CHECK (
        last_broadcast_at_unix_ms IS NULL
        OR last_broadcast_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    last_broadcast_provider_accepted boolean,
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

    UNIQUE (chain_id, router_address, bridge_challenge_key),
    CHECK (
        (status = 'preparing') =
        (preparation_lease_owner IS NOT NULL AND preparation_lease_expires_at_unix_ms IS NOT NULL)
    ),
    CHECK (
        status NOT IN (
            'preparing',
            'prepared',
            'broadcast-pending',
            'external-satisfied-awaiting-own-transaction'
        )
        OR preparation_sender IS NOT NULL
    ),
    CHECK (
        (prepared_raw_transaction IS NULL) =
        (prepared_transaction_hash IS NULL)
    ),
    CHECK (
        (prepared_raw_transaction IS NULL) =
        (prepared_sender IS NULL)
    ),
    CHECK (
        (prepared_raw_transaction IS NULL) =
        (prepared_nonce IS NULL)
    ),
    CHECK (
        prepared_raw_transaction IS NULL
        OR signer_invocation_started_at_unix_ms IS NOT NULL
    ),
    CHECK (
        status NOT IN (
            'queued',
            'cancelled-before-broadcast',
            'cancelled-honest-spend',
            'cancelled-reorg'
        )
        OR signer_invocation_started_at_unix_ms IS NULL
    ),
    CHECK (
        preparation_sender IS NULL
        OR prepared_sender IS NULL
        OR prepared_sender = preparation_sender
    ),
    CHECK (
        broadcast_attempts = 0
        OR (
            prepared_raw_transaction IS NOT NULL
            AND last_broadcast_at_unix_ms IS NOT NULL
        )
    ),
    CHECK (
        status <> 'broadcast-pending'
        OR broadcast_attempts > 0
    ),
    CHECK (
        status <> 'cancelled-before-broadcast'
        OR broadcast_attempts = 0
    ),
    CHECK (
        status NOT IN ('cancelled-honest-spend', 'cancelled-reorg')
        OR broadcast_attempts = 0
    ),
    CHECK (
        (last_pre_broadcast_recheck_at_unix_ms IS NULL) =
        (last_pre_broadcast_recheck_status IS NULL)
    )
);

CREATE INDEX p2tr_signature_fraud_challenge_outbox_dispatch_idx
    ON p2tr_signature_fraud_challenge_outbox (
        status,
        updated_at_unix_ms,
        intent_id
    );

CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_sender_lane_idx
    ON p2tr_signature_fraud_challenge_outbox (
        chain_id,
        preparation_sender
    )
    WHERE preparation_sender IS NOT NULL;

CREATE UNIQUE INDEX p2tr_signature_fraud_challenge_outbox_sender_nonce_idx
    ON p2tr_signature_fraud_challenge_outbox (
        chain_id,
        prepared_sender,
        prepared_nonce
    )
    WHERE prepared_sender IS NOT NULL AND prepared_nonce IS NOT NULL;

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

COMMIT;
