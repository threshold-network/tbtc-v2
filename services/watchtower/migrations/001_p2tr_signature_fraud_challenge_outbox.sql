-- Durable, immutable signed-transaction outbox for P2TR fraud challenges.
--
-- The enqueue INSERT must commit in the same database transaction as the
-- confirmed Bitcoin observation and both canonical source cursors. Dispatch
-- uses UPDATE ... WHERE intent_id = $1 AND version = $2 for every transition.

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
    bitcoin_block_hash bytea NOT NULL CHECK (octet_length(bitcoin_block_hash) = 32),
    bitcoin_block_height bigint NOT NULL CHECK (bitcoin_block_height >= 0),
    bitcoin_cursor_block_hash bytea NOT NULL CHECK (octet_length(bitcoin_cursor_block_hash) = 32),
    bitcoin_cursor_block_height bigint NOT NULL CHECK (bitcoin_cursor_block_height >= bitcoin_block_height),
    ethereum_lifecycle_block_hash bytea NOT NULL CHECK (octet_length(ethereum_lifecycle_block_hash) = 32),
    ethereum_lifecycle_block_number bigint NOT NULL CHECK (ethereum_lifecycle_block_number >= 0),
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
        'accepted-own',
        'satisfied-external',
        'terminal-reverted',
        'terminal-nonce-consumed',
        'cancelled-before-broadcast',
        'quarantined'
    )),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    generation integer NOT NULL DEFAULT 0 CHECK (generation = 0),
    created_at_unix_ms bigint NOT NULL CHECK (created_at_unix_ms >= 0),
    updated_at_unix_ms bigint NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),

    preparation_attempts integer NOT NULL DEFAULT 0 CHECK (preparation_attempts >= 0),
    preparation_lease_owner text,
    preparation_lease_expires_at_unix_ms bigint,
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
    last_broadcast_at_unix_ms bigint,
    last_broadcast_provider_accepted boolean,
    reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK (reconciliation_attempts >= 0),
    last_reconciliation_at_unix_ms bigint,
    last_resolution_status text CHECK (last_resolution_status IN (
        'pending',
        'unknown',
        'accepted-own',
        'satisfied-external',
        'terminal-reverted',
        'terminal-nonce-consumed'
    )),
    last_error text,

    UNIQUE (chain_id, router_address, bridge_challenge_key),
    CHECK (
        (status = 'preparing') =
        (preparation_lease_owner IS NOT NULL AND preparation_lease_expires_at_unix_ms IS NOT NULL)
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
    )
);

CREATE INDEX p2tr_signature_fraud_challenge_outbox_dispatch_idx
    ON p2tr_signature_fraud_challenge_outbox (status, updated_at_unix_ms);

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
    legacy_status text NOT NULL,
    submission_attempts integer NOT NULL CHECK (submission_attempts > 0),
    challenge_transaction_hash bytea CHECK (
        challenge_transaction_hash IS NULL
        OR octet_length(challenge_transaction_hash) = 32
    ),
    reason text NOT NULL CHECK (length(reason) > 0),
    quarantined_at_unix_ms bigint NOT NULL CHECK (quarantined_at_unix_ms >= 0)
);
