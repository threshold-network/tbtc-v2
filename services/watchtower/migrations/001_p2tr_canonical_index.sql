BEGIN;

CREATE TABLE p2tr_watchtower_schema_version (
    component text PRIMARY KEY,
    version integer NOT NULL CHECK (version > 0),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('canonical-evidence-index', 1);

CREATE TABLE p2tr_bitcoin_blocks (
    height bigint PRIMARY KEY CHECK (height >= 0),
    hash bytea NOT NULL UNIQUE CHECK (octet_length(hash) = 32),
    parent_hash bytea NOT NULL CHECK (octet_length(parent_hash) = 32),
    is_checkpoint boolean NOT NULL DEFAULT false,
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (height, hash)
);

CREATE TABLE p2tr_bitcoin_cursor (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    store_id text NOT NULL CHECK (length(store_id) BETWEEN 1 AND 255),
    configuration_fingerprint bytea NOT NULL
        CHECK (octet_length(configuration_fingerprint) = 32),
    network text NOT NULL CHECK (length(network) BETWEEN 1 AND 32),
    checkpoint_height bigint NOT NULL CHECK (checkpoint_height >= 0),
    checkpoint_hash bytea NOT NULL CHECK (octet_length(checkpoint_hash) = 32),
    current_height bigint NOT NULL CHECK (current_height >= checkpoint_height),
    current_hash bytea NOT NULL CHECK (octet_length(current_hash) = 32),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (current_height, current_hash)
        REFERENCES p2tr_bitcoin_blocks (height, hash)
);

-- Raw canonical transactions and every authenticated prevout vector are
-- retained from the explicit checkpoint. This lets a deposit reveal learned
-- after its Bitcoin spend deterministically backfill the missed candidate.
CREATE TABLE p2tr_bitcoin_transactions (
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    wtxid bytea NOT NULL CHECK (octet_length(wtxid) = 32),
    block_height bigint NOT NULL CHECK (block_height >= 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    transaction_index integer NOT NULL CHECK (transaction_index >= 0),
    raw_transaction bytea NOT NULL CHECK (octet_length(raw_transaction) > 0),
    input_prevouts jsonb NOT NULL CHECK (jsonb_typeof(input_prevouts) = 'array'),
    PRIMARY KEY (block_hash, txid, wtxid),
    UNIQUE (txid),
    UNIQUE (block_height, transaction_index),
    FOREIGN KEY (block_height, block_hash)
        REFERENCES p2tr_bitcoin_blocks (height, hash) ON DELETE CASCADE
);

CREATE TABLE p2tr_bitcoin_inputs (
    spending_txid bytea NOT NULL CHECK (octet_length(spending_txid) = 32),
    spending_wtxid bytea NOT NULL CHECK (octet_length(spending_wtxid) = 32),
    input_index integer NOT NULL CHECK (input_index >= 0),
    prev_txid bytea NOT NULL CHECK (octet_length(prev_txid) = 32),
    prev_vout bigint NOT NULL CHECK (prev_vout BETWEEN 0 AND 4294967295),
    block_height bigint NOT NULL CHECK (block_height >= 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    PRIMARY KEY (block_hash, spending_txid, spending_wtxid, input_index),
    UNIQUE (prev_txid, prev_vout),
    FOREIGN KEY (block_hash, spending_txid, spending_wtxid)
        REFERENCES p2tr_bitcoin_transactions (block_hash, txid, wtxid)
        ON DELETE CASCADE,
    FOREIGN KEY (block_height, block_hash)
        REFERENCES p2tr_bitcoin_blocks (height, hash) ON DELETE CASCADE
);

CREATE INDEX p2tr_bitcoin_inputs_prevout_idx
    ON p2tr_bitcoin_inputs (prev_txid, prev_vout);

CREATE TABLE p2tr_bitcoin_outputs (
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    wtxid bytea NOT NULL CHECK (octet_length(wtxid) = 32),
    vout bigint NOT NULL CHECK (vout BETWEEN 0 AND 4294967295),
    value_sats bigint NOT NULL CHECK (value_sats >= 0),
    script_pubkey bytea NOT NULL,
    block_height bigint NOT NULL CHECK (block_height >= 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    PRIMARY KEY (block_hash, txid, wtxid, vout),
    UNIQUE (txid, vout),
    FOREIGN KEY (block_hash, txid, wtxid)
        REFERENCES p2tr_bitcoin_transactions (block_hash, txid, wtxid)
        ON DELETE CASCADE
);

CREATE INDEX p2tr_bitcoin_outputs_script_idx
    ON p2tr_bitcoin_outputs (script_pubkey);

CREATE TABLE p2tr_tracked_outpoints (
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    vout bigint NOT NULL CHECK (vout BETWEEN 0 AND 4294967295),
    kind text NOT NULL CHECK (kind IN ('wallet', 'deposit')),
    wallet_id bytea NOT NULL CHECK (octet_length(wallet_id) = 32),
    output_key bytea NOT NULL CHECK (octet_length(output_key) = 32),
    value_sats bigint NOT NULL CHECK (value_sats >= 0),
    script_pubkey bytea NOT NULL CHECK (octet_length(script_pubkey) > 0),
    created_height bigint NOT NULL CHECK (created_height >= 0),
    created_hash bytea NOT NULL CHECK (octet_length(created_hash) = 32),
    source_event_id text UNIQUE,
    spent_by_txid bytea CHECK (
        spent_by_txid IS NULL OR octet_length(spent_by_txid) = 32
    ),
    spent_by_wtxid bytea CHECK (
        spent_by_wtxid IS NULL OR octet_length(spent_by_wtxid) = 32
    ),
    spent_input_index integer CHECK (
        spent_input_index IS NULL OR spent_input_index >= 0
    ),
    spent_height bigint CHECK (spent_height IS NULL OR spent_height >= 0),
    spent_hash bytea CHECK (spent_hash IS NULL OR octet_length(spent_hash) = 32),
    PRIMARY KEY (txid, vout),
    CHECK (
        (kind = 'wallet' AND source_event_id IS NULL) OR
        (kind = 'deposit' AND source_event_id IS NOT NULL)
    ),
    CHECK (
        (spent_by_txid IS NULL AND spent_by_wtxid IS NULL AND spent_input_index IS NULL AND
         spent_height IS NULL AND spent_hash IS NULL) OR
        (spent_by_txid IS NOT NULL AND spent_by_wtxid IS NOT NULL AND spent_input_index IS NOT NULL AND
         spent_height IS NOT NULL AND spent_hash IS NOT NULL)
    )
);

CREATE INDEX p2tr_tracked_outpoints_spent_idx
    ON p2tr_tracked_outpoints (spent_height)
    WHERE spent_height IS NOT NULL;

CREATE TABLE p2tr_bitcoin_candidates (
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    wtxid bytea NOT NULL CHECK (octet_length(wtxid) = 32),
    block_height bigint NOT NULL CHECK (block_height >= 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    raw_transaction bytea NOT NULL CHECK (octet_length(raw_transaction) > 0),
    input_prevouts jsonb NOT NULL CHECK (jsonb_typeof(input_prevouts) = 'array'),
    wallet_input_key_bindings jsonb NOT NULL
        CHECK (jsonb_typeof(wallet_input_key_bindings) = 'array'),
    delivered boolean NOT NULL DEFAULT false,
    delivered_at timestamptz,
    CHECK (
        (delivered = false AND delivered_at IS NULL) OR
        (delivered = true AND delivered_at IS NOT NULL)
    ),
    PRIMARY KEY (block_hash, txid, wtxid),
    FOREIGN KEY (block_hash, txid, wtxid)
        REFERENCES p2tr_bitcoin_transactions (block_hash, txid, wtxid)
        ON DELETE CASCADE,
    FOREIGN KEY (block_height, block_hash)
        REFERENCES p2tr_bitcoin_blocks (height, hash) ON DELETE CASCADE
);

CREATE INDEX p2tr_bitcoin_candidates_block_idx
    ON p2tr_bitcoin_candidates (block_height);

CREATE INDEX p2tr_bitcoin_candidates_pending_idx
    ON p2tr_bitcoin_candidates (block_height, txid, wtxid)
    WHERE delivered = false;

CREATE TABLE p2tr_frost_wallet_bindings (
    wallet_id bytea PRIMARY KEY CHECK (octet_length(wallet_id) = 32),
    source_event_id text NOT NULL UNIQUE CHECK (length(source_event_id) BETWEEN 1 AND 512),
    ethereum_block_number bigint NOT NULL CHECK (ethereum_block_number >= 0),
    ethereum_block_hash bytea NOT NULL CHECK (octet_length(ethereum_block_hash) = 32),
    inserted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE p2tr_pending_deposit_reveals (
    source_event_id text PRIMARY KEY CHECK (length(source_event_id) BETWEEN 1 AND 512),
    funding_txid bytea NOT NULL CHECK (octet_length(funding_txid) = 32),
    funding_vout bigint NOT NULL CHECK (funding_vout BETWEEN 0 AND 4294967295),
    wallet_id bytea NOT NULL CHECK (octet_length(wallet_id) = 32),
    output_key bytea NOT NULL CHECK (octet_length(output_key) = 32),
    ethereum_block_number bigint NOT NULL CHECK (ethereum_block_number >= 0),
    ethereum_block_hash bytea NOT NULL CHECK (octet_length(ethereum_block_hash) = 32),
    resolved_funding_height bigint,
    resolved_funding_hash bytea CHECK (
        resolved_funding_hash IS NULL OR octet_length(resolved_funding_hash) = 32
    ),
    inserted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    resolved_at timestamptz,
    UNIQUE (funding_txid, funding_vout),
    CHECK (
        (resolved_funding_height IS NULL AND resolved_funding_hash IS NULL AND resolved_at IS NULL) OR
        (resolved_funding_height IS NOT NULL AND resolved_funding_hash IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX p2tr_pending_deposit_reveals_open_idx
    ON p2tr_pending_deposit_reveals (funding_txid, funding_vout)
    WHERE resolved_at IS NULL;

CREATE TABLE p2tr_unmatched_proofs (
    event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 512),
    ethereum_block_number bigint NOT NULL CHECK (ethereum_block_number >= 0),
    ethereum_block_hash bytea NOT NULL
        CHECK (octet_length(ethereum_block_hash) = 32),
    ethereum_transaction_hash bytea NOT NULL
        CHECK (octet_length(ethereum_transaction_hash) = 32),
    ethereum_log_index integer NOT NULL CHECK (ethereum_log_index >= 0),
    bitcoin_txid bytea NOT NULL CHECK (octet_length(bitcoin_txid) = 32),
    wallet_id bytea NOT NULL CHECK (octet_length(wallet_id) = 32),
    spend_type text NOT NULL CHECK (length(spend_type) BETWEEN 1 AND 64),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    inserted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    resolved_at timestamptz,
    UNIQUE (ethereum_block_hash, ethereum_log_index)
);

CREATE INDEX p2tr_unmatched_proofs_open_idx
    ON p2tr_unmatched_proofs (ethereum_block_number, ethereum_log_index)
    WHERE resolved_at IS NULL;

CREATE TABLE p2tr_cross_source_watermark (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    bitcoin_height bigint NOT NULL CHECK (bitcoin_height >= 0),
    bitcoin_hash bytea NOT NULL CHECK (octet_length(bitcoin_hash) = 32),
    ethereum_block_number bigint NOT NULL CHECK (ethereum_block_number >= 0),
    ethereum_block_hash bytea NOT NULL
        CHECK (octet_length(ethereum_block_hash) = 32),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
