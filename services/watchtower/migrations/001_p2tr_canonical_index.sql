CREATE TABLE p2tr_watchtower_schema_version (
    component text PRIMARY KEY,
    version integer NOT NULL CHECK (version > 0),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('canonical-evidence-index', 3);

-- Bitcoin transaction IDs are persisted in display order, while COMPLETE_V2
-- evidence must carry the native uint256/wire byte order used by the Bridge.
CREATE FUNCTION p2tr_reverse_bytea(value bytea)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT decode(coalesce(string_agg(
        lpad(to_hex(get_byte(value, byte_index)), 2, '0'),
        '' ORDER BY byte_index DESC
    ), ''), 'hex')
    FROM generate_series(0, octet_length(value) - 1) AS bytes(byte_index)
$$;

-- Evidence is stored independently from the mutable canonical projection.
-- Reorganizations may delete projection rows, but cannot rewrite an object or
-- an ordered chunk once its content address has been published. Objects are
-- deliberately capped at Bitcoin's four-megabyte serialized block ceiling;
-- their 64 KiB chunks can therefore be audited without materializing an
-- attacker-selected aggregate prevout vector in either PostgreSQL or Node.
CREATE FUNCTION p2tr_evidence_chunk_digest(chunk_bytes bytea)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to('tbtc-p2tr-evidence-chunk-v1', 'UTF8') || chunk_bytes
    )
$$;

CREATE FUNCTION p2tr_evidence_chunk_leaf_digest(
    chunk_index integer,
    byte_offset bigint,
    chunk_digest bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to('tbtc-p2tr-evidence-chunk-leaf-v1', 'UTF8') ||
        int4send(chunk_index) || int8send(byte_offset) || chunk_digest
    )
$$;

CREATE FUNCTION p2tr_evidence_object_digest(
    object_kind text,
    byte_length bigint,
    chunk_count integer,
    content_digest bytea,
    chunk_manifest_root bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to(
            'tbtc-p2tr-evidence-object-v1' || chr(31) || object_kind ||
            chr(31) || byte_length::text || chr(31) || chunk_count::text,
            'UTF8'
        ) || content_digest || chunk_manifest_root
    )
$$;

CREATE TABLE p2tr_evidence_chunks (
    chunk_digest bytea PRIMARY KEY CHECK (octet_length(chunk_digest) = 32),
    chunk_bytes bytea NOT NULL CHECK (octet_length(chunk_bytes) <= 65536),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (chunk_digest = p2tr_evidence_chunk_digest(chunk_bytes))
);

CREATE TABLE p2tr_evidence_objects (
    object_digest bytea PRIMARY KEY CHECK (octet_length(object_digest) = 32),
    object_kind text NOT NULL CHECK (
        object_kind ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    ),
    byte_length bigint NOT NULL CHECK (byte_length BETWEEN 0 AND 4000000),
    chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 64),
    content_digest bytea NOT NULL CHECK (octet_length(content_digest) = 32),
    chunk_manifest_root bytea NOT NULL
        CHECK (octet_length(chunk_manifest_root) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (
        object_digest, object_kind, content_digest, byte_length, chunk_count,
        chunk_manifest_root
    ),
    CHECK (
        object_kind <> 'bitcoin_header80' OR
        (byte_length = 80 AND chunk_count = 1)
    ),
    CHECK (
        chunk_count = greatest(
            1,
            ((byte_length + 65535) / 65536)::integer
        )
    ),
    CHECK (
        object_digest = p2tr_evidence_object_digest(
            object_kind, byte_length, chunk_count, content_digest,
            chunk_manifest_root
        )
    )
);

CREATE TABLE p2tr_evidence_object_chunks (
    object_digest bytea NOT NULL CHECK (octet_length(object_digest) = 32),
    chunk_index integer NOT NULL CHECK (chunk_index >= 0),
    byte_offset bigint NOT NULL CHECK (byte_offset >= 0),
    chunk_digest bytea NOT NULL CHECK (octet_length(chunk_digest) = 32),
    leaf_digest bytea NOT NULL CHECK (octet_length(leaf_digest) = 32),
    PRIMARY KEY (object_digest, chunk_index),
    UNIQUE (object_digest, byte_offset),
    FOREIGN KEY (object_digest) REFERENCES p2tr_evidence_objects (object_digest)
        ON DELETE CASCADE,
    FOREIGN KEY (chunk_digest) REFERENCES p2tr_evidence_chunks (chunk_digest),
    CHECK (
        leaf_digest = p2tr_evidence_chunk_leaf_digest(
            chunk_index, byte_offset, chunk_digest
        )
    )
);

CREATE INDEX p2tr_evidence_object_chunks_chunk_idx
    ON p2tr_evidence_object_chunks (chunk_digest);

CREATE FUNCTION p2tr_evidence_object_is_complete(target_digest bytea)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
PARALLEL SAFE
AS $$
    WITH ordered_chunks AS (
        SELECT
            links.chunk_index,
            links.byte_offset,
            chunks.chunk_bytes,
            links.leaf_digest,
            coalesce(sum(octet_length(chunks.chunk_bytes)) OVER (
                ORDER BY links.chunk_index
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
            ), 0)::bigint AS expected_offset
        FROM p2tr_evidence_object_chunks links
        JOIN p2tr_evidence_chunks chunks USING (chunk_digest)
        WHERE links.object_digest = target_digest
    ), measured AS (
        SELECT
            count(*)::integer AS actual_chunk_count,
            coalesce(sum(octet_length(chunk_bytes)), 0)::bigint AS actual_bytes,
            coalesce(min(chunk_index), -1) AS first_index,
            coalesce(max(chunk_index), -1) AS last_index,
            coalesce(bool_and(byte_offset = expected_offset), false)
                AS offsets_are_contiguous,
            sha256(decode(coalesce(
                string_agg(encode(chunk_bytes, 'hex'), '' ORDER BY chunk_index),
                ''
            ), 'hex')) AS actual_content_digest,
            sha256(decode(coalesce(
                string_agg(encode(leaf_digest, 'hex'), '' ORDER BY chunk_index),
                ''
            ), 'hex')) AS actual_manifest_root
        FROM ordered_chunks
    )
    SELECT
        measured.actual_chunk_count = objects.chunk_count AND
        measured.actual_bytes = objects.byte_length AND
        measured.first_index = 0 AND
        measured.last_index = objects.chunk_count - 1 AND
        measured.offsets_are_contiguous AND
        measured.actual_content_digest = objects.content_digest AND
        measured.actual_manifest_root = objects.chunk_manifest_root AND
        NOT EXISTS (
            SELECT 1
              FROM p2tr_evidence_object_chunks links
              JOIN p2tr_evidence_chunks chunks USING (chunk_digest)
             WHERE links.object_digest = objects.object_digest
               AND octet_length(chunks.chunk_bytes) <>
                   least(65536::bigint, objects.byte_length - links.byte_offset)
        )
    FROM p2tr_evidence_objects objects
    CROSS JOIN measured
    WHERE objects.object_digest = target_digest
$$;

CREATE FUNCTION p2tr_assert_evidence_object_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_digest bytea := CASE
        WHEN TG_TABLE_NAME = 'p2tr_evidence_objects' THEN NEW.object_digest
        ELSE NEW.object_digest
    END;
BEGIN
    IF NOT p2tr_evidence_object_is_complete(target_digest) THEN
        RAISE EXCEPTION 'incomplete or corrupt evidence object %',
            encode(target_digest, 'hex');
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER p2tr_evidence_object_complete
AFTER INSERT ON p2tr_evidence_objects
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION p2tr_assert_evidence_object_complete();

CREATE CONSTRAINT TRIGGER p2tr_evidence_object_chunk_complete
AFTER INSERT ON p2tr_evidence_object_chunks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION p2tr_assert_evidence_object_complete();

CREATE FUNCTION p2tr_reject_immutable_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER p2tr_evidence_chunks_no_update
BEFORE UPDATE ON p2tr_evidence_chunks
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE TRIGGER p2tr_evidence_objects_no_update
BEFORE UPDATE ON p2tr_evidence_objects
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE TRIGGER p2tr_evidence_object_chunks_no_update
BEFORE UPDATE ON p2tr_evidence_object_chunks
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE TABLE p2tr_bitcoin_blocks (
    height bigint PRIMARY KEY CHECK (height >= 0),
    hash bytea NOT NULL UNIQUE CHECK (octet_length(hash) = 32),
    header_bytes bytea NOT NULL CHECK (octet_length(header_bytes) = 80),
    header_object_digest bytea NOT NULL
        CHECK (octet_length(header_object_digest) = 32),
    raw_block_object_digest bytea NOT NULL
        CHECK (octet_length(raw_block_object_digest) = 32),
    parent_height bigint,
    parent_hash bytea NOT NULL CHECK (octet_length(parent_hash) = 32),
    parent_chain_commitment bytea CHECK (
        parent_chain_commitment IS NULL OR
        octet_length(parent_chain_commitment) = 32
    ),
    chain_commitment bytea NOT NULL UNIQUE
        CHECK (octet_length(chain_commitment) = 32),
    block_content_commitment bytea NOT NULL
        CHECK (octet_length(block_content_commitment) = 32),
    parent_evidence_chain_commitment bytea CHECK (
        parent_evidence_chain_commitment IS NULL OR
        octet_length(parent_evidence_chain_commitment) = 32
    ),
    evidence_chain_commitment bytea NOT NULL UNIQUE
        CHECK (octet_length(evidence_chain_commitment) = 32),
    transaction_count bigint NOT NULL CHECK (transaction_count >= 0),
    input_count bigint NOT NULL CHECK (input_count >= 0),
    output_count bigint NOT NULL CHECK (output_count >= 0),
    unresolved_input_count bigint NOT NULL
        CHECK (unresolved_input_count >= 0 AND
               unresolved_input_count <= input_count),
    is_checkpoint boolean NOT NULL DEFAULT false,
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (height, hash),
    UNIQUE (height, hash, chain_commitment),
    UNIQUE (height, hash, chain_commitment, evidence_chain_commitment),
    CHECK (
        (is_checkpoint AND parent_height IS NULL AND
         parent_chain_commitment IS NULL AND
         parent_evidence_chain_commitment IS NULL) OR
        (NOT is_checkpoint AND parent_height = height - 1 AND
         parent_chain_commitment IS NOT NULL AND
         parent_evidence_chain_commitment IS NOT NULL AND
         header_bytes IS NOT NULL AND header_object_digest IS NOT NULL AND
         raw_block_object_digest IS NOT NULL)
    ),
    FOREIGN KEY (
        parent_height, parent_hash, parent_chain_commitment,
        parent_evidence_chain_commitment
    ) REFERENCES p2tr_bitcoin_blocks (
        height, hash, chain_commitment, evidence_chain_commitment
    ),
    FOREIGN KEY (header_object_digest)
        REFERENCES p2tr_evidence_objects (object_digest),
    FOREIGN KEY (raw_block_object_digest)
        REFERENCES p2tr_evidence_objects (object_digest)
);

CREATE TABLE p2tr_bitcoin_cursor (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    store_id text NOT NULL CHECK (length(store_id) BETWEEN 1 AND 255),
    configuration_fingerprint bytea NOT NULL
        CHECK (octet_length(configuration_fingerprint) = 32),
    network text NOT NULL CHECK (length(network) BETWEEN 1 AND 32),
    trust_domain_id text NOT NULL CHECK (length(trust_domain_id) BETWEEN 1 AND 255),
    checkpoint_height bigint NOT NULL CHECK (checkpoint_height >= 0),
    checkpoint_hash bytea NOT NULL CHECK (octet_length(checkpoint_hash) = 32),
    current_height bigint NOT NULL CHECK (current_height >= checkpoint_height),
    current_hash bytea NOT NULL CHECK (octet_length(current_hash) = 32),
    current_chain_commitment bytea NOT NULL
        CHECK (octet_length(current_chain_commitment) = 32),
    current_evidence_chain_commitment bytea NOT NULL
        CHECK (octet_length(current_evidence_chain_commitment) = 32),
    journal_block_count bigint NOT NULL CHECK (journal_block_count > 0),
    journal_transaction_count bigint NOT NULL
        CHECK (journal_transaction_count >= 0),
    journal_input_count bigint NOT NULL CHECK (journal_input_count >= 0),
    journal_output_count bigint NOT NULL CHECK (journal_output_count >= 0),
    journal_unresolved_input_count bigint NOT NULL
        CHECK (journal_unresolved_input_count >= 0 AND
               journal_unresolved_input_count <= journal_input_count),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (journal_block_count = current_height - checkpoint_height + 1),
    FOREIGN KEY (
        current_height, current_hash, current_chain_commitment,
        current_evidence_chain_commitment
    ) REFERENCES p2tr_bitcoin_blocks (
        height, hash, chain_commitment, evidence_chain_commitment
    )
);

-- Raw canonical transactions and every authenticated prevout are retained
-- from the explicit checkpoint. Prevouts stay normalized in
-- p2tr_bitcoin_inputs: a valid transaction can reference enough large scripts
-- that duplicating its entire vector in one JSON value exceeds PostgreSQL's
-- practical row/parameter limits.
CREATE TABLE p2tr_bitcoin_transactions (
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    wtxid bytea NOT NULL CHECK (octet_length(wtxid) = 32),
    block_height bigint NOT NULL CHECK (block_height >= 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    transaction_index integer NOT NULL CHECK (transaction_index >= 0),
    raw_transaction bytea NOT NULL CHECK (octet_length(raw_transaction) > 0),
    raw_transaction_object_digest bytea NOT NULL
        CHECK (octet_length(raw_transaction_object_digest) = 32),
    PRIMARY KEY (block_hash, txid, wtxid),
    UNIQUE (block_height, transaction_index),
    FOREIGN KEY (block_height, block_hash)
        REFERENCES p2tr_bitcoin_blocks (height, hash) ON DELETE CASCADE,
    FOREIGN KEY (raw_transaction_object_digest)
        REFERENCES p2tr_evidence_objects (object_digest)
);

CREATE FUNCTION p2tr_assert_inline_evidence_object()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_digest bytea;
    target_kind text;
    target_bytes bytea;
    stored_kind text;
    stored_length bigint;
    stored_content_digest bytea;
    raw_block_kind text;
    raw_block_header bytea;
BEGIN
    IF TG_TABLE_NAME = 'p2tr_bitcoin_blocks' THEN
        target_digest := NEW.header_object_digest;
        target_kind := 'bitcoin_header80';
        target_bytes := NEW.header_bytes;
    ELSIF TG_TABLE_NAME = 'p2tr_bitcoin_transactions' THEN
        target_digest := NEW.raw_transaction_object_digest;
        target_kind := 'bitcoin_raw_transaction';
        target_bytes := NEW.raw_transaction;
    ELSE
        RAISE EXCEPTION 'unsupported inline evidence table %', TG_TABLE_NAME;
    END IF;

    SELECT object_kind, byte_length, content_digest
      INTO stored_kind, stored_length, stored_content_digest
      FROM p2tr_evidence_objects
     WHERE object_digest = target_digest;

    IF stored_kind IS DISTINCT FROM target_kind OR
       stored_length IS DISTINCT FROM octet_length(target_bytes) OR
       stored_content_digest IS DISTINCT FROM sha256(target_bytes) OR
       NOT p2tr_evidence_object_is_complete(target_digest) THEN
        RAISE EXCEPTION '% does not match its immutable evidence object',
            TG_TABLE_NAME;
    END IF;
    IF TG_TABLE_NAME = 'p2tr_bitcoin_blocks' THEN
        SELECT objects.object_kind, substring(chunks.chunk_bytes FROM 1 FOR 80)
          INTO raw_block_kind, raw_block_header
          FROM p2tr_evidence_objects objects
          JOIN p2tr_evidence_object_chunks links
            ON links.object_digest = objects.object_digest
           AND links.chunk_index = 0
           AND links.byte_offset = 0
          JOIN p2tr_evidence_chunks chunks USING (chunk_digest)
         WHERE objects.object_digest = NEW.raw_block_object_digest;
        IF raw_block_kind IS DISTINCT FROM 'bitcoin_raw_block' OR
           raw_block_header IS DISTINCT FROM NEW.header_bytes OR
           NOT p2tr_evidence_object_is_complete(
               NEW.raw_block_object_digest
           ) THEN
            RAISE EXCEPTION
                'Bitcoin raw block does not match its exact 80-byte header';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_bitcoin_blocks_inline_evidence
BEFORE INSERT OR UPDATE OF
    header_bytes, header_object_digest, raw_block_object_digest
ON p2tr_bitcoin_blocks
FOR EACH ROW EXECUTE FUNCTION p2tr_assert_inline_evidence_object();

CREATE TRIGGER p2tr_bitcoin_transactions_inline_evidence
BEFORE INSERT OR UPDATE OF raw_transaction, raw_transaction_object_digest
ON p2tr_bitcoin_transactions
FOR EACH ROW EXECUTE FUNCTION p2tr_assert_inline_evidence_object();

CREATE INDEX p2tr_bitcoin_transactions_txid_idx
    ON p2tr_bitcoin_transactions (txid);

CREATE TABLE p2tr_bitcoin_outputs (
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    wtxid bytea NOT NULL CHECK (octet_length(wtxid) = 32),
    vout bigint NOT NULL CHECK (vout BETWEEN 0 AND 4294967295),
    value_sats bigint NOT NULL CHECK (value_sats >= 0),
    script_pubkey bytea NOT NULL,
    block_height bigint NOT NULL CHECK (block_height >= 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    PRIMARY KEY (block_hash, txid, wtxid, vout),
    UNIQUE (block_hash, txid, vout),
    FOREIGN KEY (block_hash, txid, wtxid)
        REFERENCES p2tr_bitcoin_transactions (block_hash, txid, wtxid)
        ON DELETE CASCADE
);

CREATE INDEX p2tr_bitcoin_outputs_outpoint_idx
    ON p2tr_bitcoin_outputs (txid, vout);

CREATE INDEX p2tr_bitcoin_outputs_height_idx
    ON p2tr_bitcoin_outputs (block_height);

-- A full bytea B-tree rejects valid incompressible scripts once one index row
-- exceeds PostgreSQL's page limit. Every lookup uses this fixed-width digest
-- as a prefilter and then confirms the exact script bytes.
CREATE INDEX p2tr_bitcoin_outputs_script_hash_idx
    ON p2tr_bitcoin_outputs (sha256(script_pubkey));

CREATE TABLE p2tr_bitcoin_inputs (
    spending_txid bytea NOT NULL CHECK (octet_length(spending_txid) = 32),
    spending_wtxid bytea NOT NULL CHECK (octet_length(spending_wtxid) = 32),
    input_index integer NOT NULL CHECK (input_index >= 0),
    prev_txid bytea NOT NULL CHECK (octet_length(prev_txid) = 32),
    prev_vout bigint NOT NULL CHECK (prev_vout BETWEEN 0 AND 4294967295),
    -- NULL is permitted only for rehearsal scans beginning after genesis.
    -- Genesis-backed production scans resolve every input to one exact output
    -- occurrence, including the historical BIP30 duplicate-txid blocks.
    prev_block_hash bytea CHECK (
        prev_block_hash IS NULL OR octet_length(prev_block_hash) = 32
    ),
    block_height bigint NOT NULL CHECK (block_height >= 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    PRIMARY KEY (block_hash, spending_txid, spending_wtxid, input_index),
    FOREIGN KEY (block_hash, spending_txid, spending_wtxid)
        REFERENCES p2tr_bitcoin_transactions (block_hash, txid, wtxid)
        ON DELETE CASCADE,
    FOREIGN KEY (block_height, block_hash)
        REFERENCES p2tr_bitcoin_blocks (height, hash) ON DELETE CASCADE,
    FOREIGN KEY (prev_block_hash, prev_txid, prev_vout)
        REFERENCES p2tr_bitcoin_outputs (block_hash, txid, vout)
);

CREATE UNIQUE INDEX p2tr_bitcoin_inputs_prev_occurrence_idx
    ON p2tr_bitcoin_inputs (prev_block_hash, prev_txid, prev_vout)
    WHERE prev_block_hash IS NOT NULL;

CREATE INDEX p2tr_bitcoin_inputs_prevout_idx
    ON p2tr_bitcoin_inputs (prev_txid, prev_vout);

CREATE INDEX p2tr_bitcoin_inputs_height_idx
    ON p2tr_bitcoin_inputs (block_height);

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
    ),
    FOREIGN KEY (created_hash, txid, vout)
        REFERENCES p2tr_bitcoin_outputs (block_hash, txid, vout),
    CHECK (script_pubkey = decode('5120' || encode(output_key, 'hex'), 'hex'))
);

CREATE INDEX p2tr_tracked_outpoints_spent_idx
    ON p2tr_tracked_outpoints (spent_height)
    WHERE spent_height IS NOT NULL;

CREATE INDEX p2tr_tracked_outpoints_created_height_idx
    ON p2tr_tracked_outpoints (created_height);

CREATE TABLE p2tr_candidate_provenance_generation (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    next_generation bigint NOT NULL CHECK (next_generation > 0),
    next_invalidation_id bigint NOT NULL CHECK (next_invalidation_id > 0),
    next_export_fence bigint NOT NULL CHECK (next_export_fence > 0)
);

INSERT INTO p2tr_candidate_provenance_generation (
    singleton, next_generation, next_invalidation_id, next_export_fence
) VALUES (true, 1, 1, 1);

CREATE TABLE p2tr_bitcoin_candidates (
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    wtxid bytea NOT NULL CHECK (octet_length(wtxid) = 32),
    block_height bigint NOT NULL CHECK (block_height >= 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    provenance_generation bigint NOT NULL CHECK (provenance_generation > 0),
    provenance_fingerprint bytea NOT NULL
        CHECK (octet_length(provenance_fingerprint) = 32),
    PRIMARY KEY (block_hash, txid, wtxid),
    UNIQUE (block_hash, txid, wtxid, provenance_generation),
    UNIQUE (
        block_hash, txid, wtxid, provenance_generation,
        provenance_fingerprint
    ),
    FOREIGN KEY (block_hash, txid, wtxid)
        REFERENCES p2tr_bitcoin_transactions (block_hash, txid, wtxid)
        ON DELETE CASCADE,
    FOREIGN KEY (block_height, block_hash)
        REFERENCES p2tr_bitcoin_blocks (height, hash) ON DELETE CASCADE
);

CREATE INDEX p2tr_bitcoin_candidates_block_idx
    ON p2tr_bitcoin_candidates (block_height);

CREATE INDEX p2tr_bitcoin_candidates_generation_idx
    ON p2tr_bitcoin_candidates (provenance_generation DESC);

CREATE TABLE p2tr_frost_wallet_bindings (
    wallet_id bytea PRIMARY KEY CHECK (octet_length(wallet_id) = 32),
    source_event_id text NOT NULL UNIQUE CHECK (length(source_event_id) BETWEEN 1 AND 512),
    ethereum_block_number bigint NOT NULL CHECK (ethereum_block_number >= 0),
    ethereum_block_hash bytea NOT NULL CHECK (octet_length(ethereum_block_hash) = 32),
    inserted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX p2tr_frost_wallet_bindings_ethereum_point_idx
    ON p2tr_frost_wallet_bindings
       (ethereum_block_number, ethereum_block_hash);

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

CREATE INDEX p2tr_pending_deposit_reveals_ethereum_point_idx
    ON p2tr_pending_deposit_reveals
       (ethereum_block_number, ethereum_block_hash);

CREATE INDEX p2tr_pending_deposit_reveals_resolved_height_idx
    ON p2tr_pending_deposit_reveals (resolved_funding_height)
    WHERE resolved_funding_height IS NOT NULL;

CREATE TABLE p2tr_bitcoin_candidate_ethereum_provenance (
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    wtxid bytea NOT NULL CHECK (octet_length(wtxid) = 32),
    input_index integer NOT NULL CHECK (input_index >= 0),
    funding_block_hash bytea NOT NULL
        CHECK (octet_length(funding_block_hash) = 32),
    funding_txid bytea NOT NULL CHECK (octet_length(funding_txid) = 32),
    funding_vout bigint NOT NULL CHECK (funding_vout BETWEEN 0 AND 4294967295),
    wallet_id bytea NOT NULL CHECK (octet_length(wallet_id) = 32),
    output_key bytea NOT NULL CHECK (octet_length(output_key) = 32),
    binding_kind text NOT NULL CHECK (binding_kind IN ('wallet', 'deposit')),
    source_event_id text NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 512),
    ethereum_block_number bigint NOT NULL CHECK (ethereum_block_number >= 0),
    ethereum_block_hash bytea NOT NULL
        CHECK (octet_length(ethereum_block_hash) = 32),
    provenance_generation bigint NOT NULL CHECK (provenance_generation > 0),
    PRIMARY KEY (
        block_hash, txid, wtxid, input_index, funding_block_hash,
        funding_txid, funding_vout, source_event_id
    ),
    FOREIGN KEY (block_hash, txid, wtxid, provenance_generation)
        REFERENCES p2tr_bitcoin_candidates
            (block_hash, txid, wtxid, provenance_generation)
        ON DELETE CASCADE,
    FOREIGN KEY (funding_block_hash, funding_txid, funding_vout)
        REFERENCES p2tr_bitcoin_outputs (block_hash, txid, vout),
    CHECK (binding_kind <> 'wallet' OR output_key = wallet_id)
);

CREATE INDEX p2tr_candidate_provenance_source_event_idx
    ON p2tr_bitcoin_candidate_ethereum_provenance (source_event_id);

CREATE INDEX p2tr_candidate_provenance_ethereum_point_idx
    ON p2tr_bitcoin_candidate_ethereum_provenance
       (ethereum_block_number, ethereum_block_hash);

CREATE UNIQUE INDEX p2tr_candidate_provenance_input_idx
    ON p2tr_bitcoin_candidate_ethereum_provenance
       (block_hash, txid, wtxid, input_index, provenance_generation);

CREATE UNIQUE INDEX p2tr_candidate_provenance_observation_binding_idx
    ON p2tr_bitcoin_candidate_ethereum_provenance
       (block_hash, txid, wtxid, input_index, provenance_generation,
        funding_block_hash, funding_txid, funding_vout, wallet_id, output_key,
        binding_kind);

CREATE FUNCTION p2tr_uint256_big_endian(value numeric)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
    remaining numeric := value;
    output bytea := decode(repeat('00', 32), 'hex');
    byte_index integer;
BEGIN
    IF value < 0 OR value >= power(2::numeric, 256) OR value <> trunc(value) THEN
        RAISE EXCEPTION 'value is not a uint256';
    END IF;
    FOR byte_index IN REVERSE 31..0 LOOP
        output := set_byte(output, byte_index, mod(remaining, 256)::integer);
        remaining := div(remaining, 256);
    END LOOP;
    RETURN output;
END
$$;

-- COMPLETE challenge identities are meaningful only inside one immutable
-- authorization domain. The first writer transaction installs the configured
-- tuple; every restart calls the same function and fails closed on any
-- protocol, chain, or Bridge mismatch.
CREATE FUNCTION p2tr_complete_domain_digest(
    protocol_id bytea,
    domain_chain_id numeric,
    bridge_address bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to('tbtc-p2tr-complete-domain-v1', 'UTF8') || protocol_id ||
        p2tr_uint256_big_endian(domain_chain_id) || bridge_address
    )
$$;

CREATE TABLE p2tr_complete_authorization_domain (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    protocol_id bytea NOT NULL CHECK (
        protocol_id = decode(
          '12c62b64ecf6d008bcff153495dcdbe7a981f3a9a1b9c0898b86b1e6d0d350ef',
          'hex'
        )
    ),
    domain_chain_id numeric(78, 0) NOT NULL CHECK (
        domain_chain_id >= 0 AND domain_chain_id < power(2::numeric, 256)
    ),
    bridge_address bytea NOT NULL CHECK (octet_length(bridge_address) = 20),
    domain_digest bytea NOT NULL UNIQUE CHECK (octet_length(domain_digest) = 32),
    configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (
        protocol_id, domain_chain_id, bridge_address, domain_digest
    ),
    CHECK (
        domain_digest = p2tr_complete_domain_digest(
            protocol_id, domain_chain_id, bridge_address
        )
    )
);

CREATE TRIGGER p2tr_complete_authorization_domain_immutable
BEFORE UPDATE OR DELETE ON p2tr_complete_authorization_domain
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE FUNCTION p2tr_assert_complete_authorization_domain(
    configured_protocol_id bytea,
    configured_chain_id numeric,
    configured_bridge_address bytea
)
RETURNS bytea
LANGUAGE plpgsql
AS $$
DECLARE
    configured_digest bytea;
    persisted p2tr_complete_authorization_domain%ROWTYPE;
BEGIN
    IF configured_protocol_id <> decode(
        '12c62b64ecf6d008bcff153495dcdbe7a981f3a9a1b9c0898b86b1e6d0d350ef',
        'hex'
    ) OR configured_chain_id < 0 OR
       configured_chain_id >= power(2::numeric, 256) OR
       configured_chain_id <> trunc(configured_chain_id) OR
       octet_length(configured_bridge_address) <> 20 THEN
        RAISE EXCEPTION 'invalid COMPLETE authorization domain';
    END IF;

    configured_digest := p2tr_complete_domain_digest(
        configured_protocol_id, configured_chain_id,
        configured_bridge_address
    );

    INSERT INTO p2tr_complete_authorization_domain (
        singleton, protocol_id, domain_chain_id, bridge_address, domain_digest
    ) VALUES (
        true, configured_protocol_id, configured_chain_id,
        configured_bridge_address, configured_digest
    ) ON CONFLICT (singleton) DO NOTHING;

    SELECT * INTO STRICT persisted
      FROM p2tr_complete_authorization_domain
     WHERE singleton = true
     FOR SHARE;

    IF persisted.protocol_id <> configured_protocol_id OR
       persisted.domain_chain_id <> configured_chain_id OR
       persisted.bridge_address <> configured_bridge_address OR
       persisted.domain_digest <> configured_digest THEN
        RAISE EXCEPTION 'COMPLETE authorization domain mismatch';
    END IF;
    RETURN persisted.domain_digest;
END
$$;

CREATE FUNCTION p2tr_watchtower_source_identity_digest(
    source_store_id text,
    source_cluster_id text,
    source_operator_id text,
    bitcoin_identity_digest bytea,
    ethereum_identity_digest bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to(
            'tbtc-p2tr-watchtower-source-identity-v1' || chr(31) ||
            source_store_id || chr(31) || source_cluster_id || chr(31) ||
            source_operator_id,
            'UTF8'
        ) || bitcoin_identity_digest || ethereum_identity_digest
    )
$$;

CREATE TABLE p2tr_watchtower_source_identity (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    source_store_id text NOT NULL
        CHECK (length(source_store_id) BETWEEN 1 AND 255),
    source_cluster_id text NOT NULL
        CHECK (length(source_cluster_id) BETWEEN 1 AND 255),
    source_operator_id text NOT NULL
        CHECK (length(source_operator_id) BETWEEN 1 AND 255),
    bitcoin_identity_digest bytea NOT NULL
        CHECK (octet_length(bitcoin_identity_digest) = 32),
    ethereum_identity_digest bytea NOT NULL
        CHECK (octet_length(ethereum_identity_digest) = 32),
    source_identity_digest bytea NOT NULL UNIQUE
        CHECK (octet_length(source_identity_digest) = 32),
    configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (
        source_store_id, source_cluster_id, source_operator_id,
        bitcoin_identity_digest, ethereum_identity_digest,
        source_identity_digest
    ),
    CHECK (
        source_identity_digest = p2tr_watchtower_source_identity_digest(
            source_store_id, source_cluster_id, source_operator_id,
            bitcoin_identity_digest, ethereum_identity_digest
        )
    )
);

CREATE TRIGGER p2tr_watchtower_source_identity_immutable
BEFORE UPDATE OR DELETE ON p2tr_watchtower_source_identity
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE FUNCTION p2tr_assert_watchtower_source_identity(
    configured_store_id text,
    configured_cluster_id text,
    configured_operator_id text,
    configured_bitcoin_identity_digest bytea,
    configured_ethereum_identity_digest bytea
)
RETURNS bytea
LANGUAGE plpgsql
AS $$
DECLARE
    configured_digest bytea;
    persisted p2tr_watchtower_source_identity%ROWTYPE;
BEGIN
    IF length(configured_store_id) NOT BETWEEN 1 AND 255 OR
       length(configured_cluster_id) NOT BETWEEN 1 AND 255 OR
       length(configured_operator_id) NOT BETWEEN 1 AND 255 OR
       octet_length(configured_bitcoin_identity_digest) <> 32 OR
       octet_length(configured_ethereum_identity_digest) <> 32 THEN
        RAISE EXCEPTION 'invalid watchtower source identity';
    END IF;
    configured_digest := p2tr_watchtower_source_identity_digest(
        configured_store_id, configured_cluster_id, configured_operator_id,
        configured_bitcoin_identity_digest,
        configured_ethereum_identity_digest
    );
    INSERT INTO p2tr_watchtower_source_identity (
        singleton, source_store_id, source_cluster_id, source_operator_id,
        bitcoin_identity_digest, ethereum_identity_digest,
        source_identity_digest
    ) VALUES (
        true, configured_store_id, configured_cluster_id,
        configured_operator_id, configured_bitcoin_identity_digest,
        configured_ethereum_identity_digest, configured_digest
    ) ON CONFLICT (singleton) DO NOTHING;

    SELECT * INTO STRICT persisted
      FROM p2tr_watchtower_source_identity
     WHERE singleton = true
     FOR SHARE;
    IF persisted.source_store_id <> configured_store_id OR
       persisted.source_cluster_id <> configured_cluster_id OR
       persisted.source_operator_id <> configured_operator_id OR
       persisted.bitcoin_identity_digest <>
           configured_bitcoin_identity_digest OR
       persisted.ethereum_identity_digest <>
           configured_ethereum_identity_digest OR
       persisted.source_identity_digest <> configured_digest THEN
        RAISE EXCEPTION 'watchtower source identity mismatch';
    END IF;
    RETURN persisted.source_identity_digest;
END
$$;

-- Local identity for one exact canonical input/provenance occurrence. The
-- optional challenge identity is included only for key-path dispositions; it
-- remains a non-unique Bridge challenge-series identity.
CREATE FUNCTION p2tr_canonical_occurrence_id(
    candidate_domain_digest bytea,
    candidate_provenance_generation bigint,
    candidate_block_hash bytea,
    candidate_txid bytea,
    candidate_wtxid bytea,
    candidate_input_index integer,
    candidate_provenance_fingerprint bytea,
    candidate_challenge_identity bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to('tbtc-p2tr-canonical-occurrence-v1', 'UTF8') ||
        candidate_domain_digest || int8send(candidate_provenance_generation) ||
        candidate_block_hash || candidate_txid || candidate_wtxid ||
        int4send(candidate_input_index) || candidate_provenance_fingerprint ||
        CASE WHEN candidate_challenge_identity IS NULL
             THEN decode('00', 'hex')
             ELSE decode('01', 'hex') || candidate_challenge_identity END
    )
$$;

-- Compact, independently deliverable COMPLETE_V2 per-input dispositions.
-- Raw transactions and prevout vectors are never duplicated here. Exactly one
-- row exists for each authenticated provenance input: challengeable key-path,
-- authenticated script-path refund, or a durable fail-closed parsing alert.
CREATE TABLE p2tr_bitcoin_candidate_observations (
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    wtxid bytea NOT NULL CHECK (octet_length(wtxid) = 32),
    input_index integer NOT NULL CHECK (input_index >= 0),
    provenance_generation bigint NOT NULL CHECK (provenance_generation > 0),
    provenance_fingerprint bytea NOT NULL
        CHECK (octet_length(provenance_fingerprint) = 32),
    disposition text NOT NULL CHECK (disposition IN (
        'keypath_pending',
        'keypath_delivered',
        'refund_authenticated',
        'malformed_blocking',
        'ambiguous_blocking'
    )),
    protocol_id bytea NOT NULL CHECK (
        protocol_id = decode(
          '12c62b64ecf6d008bcff153495dcdbe7a981f3a9a1b9c0898b86b1e6d0d350ef',
          'hex'
        )
    ),
    domain_chain_id numeric(78, 0) NOT NULL CHECK (
        domain_chain_id >= 0 AND domain_chain_id < power(2::numeric, 256)
    ),
    bridge_address bytea NOT NULL CHECK (octet_length(bridge_address) = 20),
    domain_digest bytea NOT NULL CHECK (octet_length(domain_digest) = 32),
    challenge_identity bytea CHECK (
        challenge_identity IS NULL OR octet_length(challenge_identity) = 32
    ),
    occurrence_id bytea NOT NULL CHECK (octet_length(occurrence_id) = 32),
    wallet_id bytea NOT NULL CHECK (octet_length(wallet_id) = 32),
    signing_key bytea NOT NULL CHECK (octet_length(signing_key) = 32),
    output_key bytea NOT NULL CHECK (octet_length(output_key) = 32),
    binding_kind text NOT NULL CHECK (binding_kind IN ('wallet', 'deposit')),
    local_funding_block_hash bytea NOT NULL
        CHECK (octet_length(local_funding_block_hash) = 32),
    local_funding_txid bytea NOT NULL
        CHECK (octet_length(local_funding_txid) = 32),
    local_funding_vout bigint NOT NULL
        CHECK (local_funding_vout BETWEEN 0 AND 4294967295),
    local_funding_header_object_digest bytea NOT NULL
        CHECK (octet_length(local_funding_header_object_digest) = 32),
    binding_tx_hash bytea NOT NULL CHECK (octet_length(binding_tx_hash) = 32),
    binding_output_index bigint NOT NULL
        CHECK (binding_output_index BETWEEN 0 AND 4294967295),
    sighash_type smallint CHECK (
        sighash_type IS NULL OR
        sighash_type IN (0, 1, 2, 3, 129, 130, 131)
    ),
    sighash bytea CHECK (sighash IS NULL OR octet_length(sighash) = 32),
    nonce_x bytea CHECK (nonce_x IS NULL OR octet_length(nonce_x) = 32),
    signature_scalar bytea CHECK (
        signature_scalar IS NULL OR octet_length(signature_scalar) = 32
    ),
    raw_transaction_digest bytea NOT NULL
        CHECK (octet_length(raw_transaction_digest) = 32),
    raw_transaction_bytes integer NOT NULL
        CHECK (raw_transaction_bytes BETWEEN 1 AND 4000000),
    witness_digest bytea NOT NULL CHECK (octet_length(witness_digest) = 32),
    annex_digest bytea CHECK (
        annex_digest IS NULL OR octet_length(annex_digest) = 32
    ),
    raw_transaction_object_digest bytea NOT NULL
        CHECK (octet_length(raw_transaction_object_digest) = 32),
    disposition_evidence_object_digest bytea NOT NULL
        CHECK (octet_length(disposition_evidence_object_digest) = 32),
    prevout_vector_root bytea CHECK (
        prevout_vector_root IS NULL OR octet_length(prevout_vector_root) = 32
    ),
    prevout_count integer CHECK (prevout_count IS NULL OR prevout_count > 0),
    prevout_bytes bigint CHECK (prevout_bytes IS NULL OR prevout_bytes >= 0),
    sha_prevouts bytea CHECK (
        sha_prevouts IS NULL OR octet_length(sha_prevouts) = 32
    ),
    sha_amounts bytea CHECK (
        sha_amounts IS NULL OR octet_length(sha_amounts) = 32
    ),
    sha_script_pubkeys bytea CHECK (
        sha_script_pubkeys IS NULL OR octet_length(sha_script_pubkeys) = 32
    ),
    sha_sequences bytea CHECK (
        sha_sequences IS NULL OR octet_length(sha_sequences) = 32
    ),
    sha_outputs bytea CHECK (
        sha_outputs IS NULL OR octet_length(sha_outputs) = 32
    ),
    candidate_block_header_hash bytea CHECK (
        candidate_block_header_hash IS NULL OR
        octet_length(candidate_block_header_hash) = 32
    ),
    funding_block_header_hash bytea CHECK (
        funding_block_header_hash IS NULL OR
        octet_length(funding_block_header_hash) = 32
    ),
    refund_leaf_hash bytea CHECK (
        refund_leaf_hash IS NULL OR octet_length(refund_leaf_hash) = 32
    ),
    refund_script_digest bytea CHECK (
        refund_script_digest IS NULL OR octet_length(refund_script_digest) = 32
    ),
    refund_control_block_digest bytea CHECK (
        refund_control_block_digest IS NULL OR
        octet_length(refund_control_block_digest) = 32
    ),
    blocking_reason text CHECK (
        blocking_reason IS NULL OR length(blocking_reason) BETWEEN 1 AND 128
    ),
    blocking_alert_digest bytea CHECK (
        blocking_alert_digest IS NULL OR
        octet_length(blocking_alert_digest) = 32
    ),
    delivered_at timestamptz,
    observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (block_hash, txid, wtxid, input_index),
    UNIQUE (
        block_hash, txid, wtxid, input_index,
        provenance_generation, challenge_identity
    ),
    FOREIGN KEY (block_hash, txid, wtxid, provenance_generation)
        REFERENCES p2tr_bitcoin_candidates
            (block_hash, txid, wtxid, provenance_generation)
        ON DELETE CASCADE,
    FOREIGN KEY (
        block_hash, txid, wtxid, provenance_generation,
        provenance_fingerprint
    ) REFERENCES p2tr_bitcoin_candidates (
        block_hash, txid, wtxid, provenance_generation,
        provenance_fingerprint
    ) ON DELETE CASCADE,
    FOREIGN KEY (
        block_hash, txid, wtxid, input_index, provenance_generation,
        local_funding_block_hash, local_funding_txid, local_funding_vout,
        wallet_id, output_key, binding_kind
    ) REFERENCES p2tr_bitcoin_candidate_ethereum_provenance (
        block_hash, txid, wtxid, input_index, provenance_generation,
        funding_block_hash, funding_txid, funding_vout, wallet_id, output_key,
        binding_kind
    ) ON DELETE CASCADE,
    FOREIGN KEY (
        protocol_id, domain_chain_id, bridge_address, domain_digest
    ) REFERENCES p2tr_complete_authorization_domain (
        protocol_id, domain_chain_id, bridge_address, domain_digest
    ),
    FOREIGN KEY (local_funding_header_object_digest)
        REFERENCES p2tr_evidence_objects (object_digest),
    FOREIGN KEY (raw_transaction_object_digest)
        REFERENCES p2tr_evidence_objects (object_digest),
    FOREIGN KEY (disposition_evidence_object_digest)
        REFERENCES p2tr_evidence_objects (object_digest),
    CHECK (
        domain_digest = p2tr_complete_domain_digest(
            protocol_id, domain_chain_id, bridge_address
        )
    ),
    CHECK (
        occurrence_id = p2tr_canonical_occurrence_id(
            domain_digest, provenance_generation, block_hash, txid, wtxid,
            input_index, provenance_fingerprint, challenge_identity
        )
    ),
    CHECK (
        (binding_kind = 'wallet' AND signing_key = wallet_id AND
         binding_tx_hash = decode(repeat('00', 32), 'hex') AND
         binding_output_index = 0) OR
        (binding_kind = 'deposit' AND signing_key = output_key AND
         binding_tx_hash = p2tr_reverse_bytea(local_funding_txid) AND
         binding_output_index = local_funding_vout)
    ),
    CHECK (
        (disposition IN ('keypath_pending', 'keypath_delivered') AND
         challenge_identity = sha256(
             convert_to(
                 'tbtc-p2tr-signature-fraud-authorization-v3', 'UTF8'
             ) ||
             p2tr_uint256_big_endian(domain_chain_id) ||
             bridge_address || wallet_id || signing_key || sighash
         )) OR
        (disposition NOT IN ('keypath_pending', 'keypath_delivered') AND
         challenge_identity IS NULL)
    ),
    CHECK (
        (disposition IN ('keypath_pending', 'keypath_delivered') AND
         sighash_type IS NOT NULL AND sighash IS NOT NULL AND
         nonce_x IS NOT NULL AND signature_scalar IS NOT NULL AND
         annex_digest IS NOT NULL AND prevout_vector_root IS NOT NULL AND
         prevout_count IS NOT NULL AND prevout_bytes IS NOT NULL AND
         sha_prevouts IS NOT NULL AND sha_amounts IS NOT NULL AND
         sha_script_pubkeys IS NOT NULL AND sha_sequences IS NOT NULL AND
         sha_outputs IS NOT NULL AND candidate_block_header_hash IS NOT NULL AND
         funding_block_header_hash IS NOT NULL) OR
        (disposition NOT IN ('keypath_pending', 'keypath_delivered') AND
         sighash_type IS NULL AND sighash IS NULL AND nonce_x IS NULL AND
         signature_scalar IS NULL AND annex_digest IS NULL AND
         prevout_vector_root IS NULL AND prevout_count IS NULL AND
         prevout_bytes IS NULL AND sha_prevouts IS NULL AND
         sha_amounts IS NULL AND sha_script_pubkeys IS NULL AND
         sha_sequences IS NULL AND sha_outputs IS NULL AND
         candidate_block_header_hash IS NULL AND
         funding_block_header_hash IS NULL)
    ),
    CHECK (
        (disposition = 'refund_authenticated' AND
         refund_leaf_hash IS NOT NULL AND refund_script_digest IS NOT NULL AND
         refund_control_block_digest IS NOT NULL) OR
        (disposition <> 'refund_authenticated' AND
         refund_leaf_hash IS NULL AND refund_script_digest IS NULL AND
         refund_control_block_digest IS NULL)
    ),
    CHECK (
        (disposition IN ('malformed_blocking', 'ambiguous_blocking') AND
         blocking_reason IS NOT NULL AND blocking_alert_digest IS NOT NULL) OR
        (disposition NOT IN ('malformed_blocking', 'ambiguous_blocking') AND
         blocking_reason IS NULL AND blocking_alert_digest IS NULL)
    ),
    CHECK (
        (disposition = 'keypath_delivered' AND delivered_at IS NOT NULL) OR
        (disposition <> 'keypath_delivered' AND delivered_at IS NULL)
    )
);

CREATE INDEX p2tr_bitcoin_candidate_observations_pending_idx
    ON p2tr_bitcoin_candidate_observations
       (block_hash, txid, wtxid, input_index)
    WHERE disposition = 'keypath_pending';

CREATE INDEX p2tr_bitcoin_candidate_observations_blocking_idx
    ON p2tr_bitcoin_candidate_observations
       (block_hash, txid, wtxid, input_index)
    WHERE disposition IN ('malformed_blocking', 'ambiguous_blocking');

CREATE INDEX p2tr_bitcoin_candidate_observations_generation_idx
    ON p2tr_bitcoin_candidate_observations (provenance_generation DESC);

CREATE UNIQUE INDEX p2tr_bitcoin_candidate_observations_occurrence_idx
    ON p2tr_bitcoin_candidate_observations (occurrence_id);

CREATE FUNCTION p2tr_guard_candidate_input_disposition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    candidate_raw_object bytea;
    funding_header_object bytea;
    local_header_kind text;
    raw_object p2tr_evidence_objects%ROWTYPE;
    disposition_object_kind text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.disposition <> 'keypath_pending' OR
           NEW.disposition <> 'keypath_delivered' OR
           NEW.delivered_at IS NULL OR
           (to_jsonb(NEW) - ARRAY[
               'disposition', 'delivered_at',
               'disposition_evidence_object_digest'
           ]) IS DISTINCT FROM
           (to_jsonb(OLD) - ARRAY[
               'disposition', 'delivered_at',
               'disposition_evidence_object_digest'
           ]) THEN
            RAISE EXCEPTION
                'candidate input disposition is immutable except pending delivery';
        END IF;
    END IF;

    SELECT raw_transaction_object_digest
      INTO candidate_raw_object
      FROM p2tr_bitcoin_transactions
     WHERE block_hash = NEW.block_hash
       AND txid = NEW.txid
       AND wtxid = NEW.wtxid;
    IF candidate_raw_object IS DISTINCT FROM
       NEW.raw_transaction_object_digest THEN
        RAISE EXCEPTION 'disposition raw transaction evidence is not canonical';
    END IF;

    SELECT header_object_digest
      INTO funding_header_object
      FROM p2tr_bitcoin_blocks
     WHERE hash = NEW.local_funding_block_hash;
    IF funding_header_object IS DISTINCT FROM
       NEW.local_funding_header_object_digest THEN
        RAISE EXCEPTION 'disposition funding header evidence is not canonical';
    END IF;

    SELECT object_kind INTO local_header_kind
      FROM p2tr_evidence_objects
     WHERE object_digest = NEW.local_funding_header_object_digest;
    SELECT * INTO STRICT raw_object
      FROM p2tr_evidence_objects
     WHERE object_digest = NEW.raw_transaction_object_digest;
    SELECT object_kind INTO disposition_object_kind
      FROM p2tr_evidence_objects
     WHERE object_digest = NEW.disposition_evidence_object_digest;

    IF local_header_kind IS DISTINCT FROM 'bitcoin_header80' OR
       raw_object.object_kind <> 'bitcoin_raw_transaction' OR
       raw_object.content_digest <> NEW.raw_transaction_digest OR
       raw_object.byte_length <> NEW.raw_transaction_bytes OR
       disposition_object_kind IS DISTINCT FROM 'complete_input_disposition' OR
       NOT p2tr_evidence_object_is_complete(
           NEW.local_funding_header_object_digest
       ) OR NOT p2tr_evidence_object_is_complete(
           NEW.raw_transaction_object_digest
       ) OR NOT p2tr_evidence_object_is_complete(
           NEW.disposition_evidence_object_digest
       ) THEN
        RAISE EXCEPTION 'candidate input disposition evidence is corrupt';
    END IF;

    IF NEW.disposition IN ('keypath_pending', 'keypath_delivered') AND
       (NEW.candidate_block_header_hash <> NEW.block_hash OR
        NEW.funding_block_header_hash <> NEW.local_funding_block_hash) THEN
        RAISE EXCEPTION 'COMPLETE header hash commitment is not canonical';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_candidate_input_disposition_guard
BEFORE INSERT OR UPDATE ON p2tr_bitcoin_candidate_observations
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_candidate_input_disposition();

CREATE FUNCTION p2tr_assert_exactly_one_input_disposition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_block_hash bytea;
    target_txid bytea;
    target_wtxid bytea;
    target_input_index integer;
    target_generation bigint;
    provenance_exists boolean;
    disposition_count bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_block_hash := OLD.block_hash;
        target_txid := OLD.txid;
        target_wtxid := OLD.wtxid;
        target_input_index := OLD.input_index;
        target_generation := OLD.provenance_generation;
    ELSE
        target_block_hash := NEW.block_hash;
        target_txid := NEW.txid;
        target_wtxid := NEW.wtxid;
        target_input_index := NEW.input_index;
        target_generation := NEW.provenance_generation;
    END IF;
    SELECT EXISTS (
        SELECT 1
          FROM p2tr_bitcoin_candidate_ethereum_provenance
         WHERE block_hash = target_block_hash
           AND txid = target_txid
           AND wtxid = target_wtxid
           AND input_index = target_input_index
           AND provenance_generation = target_generation
    ) INTO provenance_exists;

    SELECT count(*) INTO disposition_count
      FROM p2tr_bitcoin_candidate_observations
     WHERE block_hash = target_block_hash
       AND txid = target_txid
       AND wtxid = target_wtxid
       AND input_index = target_input_index
       AND provenance_generation = target_generation;

    IF provenance_exists AND disposition_count <> 1 THEN
        RAISE EXCEPTION
            'candidate input must have exactly one persisted disposition';
    ELSIF NOT provenance_exists AND disposition_count <> 0 THEN
        RAISE EXCEPTION 'disposition has no authenticated provenance input';
    END IF;
    RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER p2tr_provenance_requires_disposition
AFTER INSERT OR UPDATE OR DELETE
ON p2tr_bitcoin_candidate_ethereum_provenance
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION p2tr_assert_exactly_one_input_disposition();

CREATE CONSTRAINT TRIGGER p2tr_disposition_requires_provenance
AFTER INSERT OR UPDATE OR DELETE
ON p2tr_bitcoin_candidate_observations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION p2tr_assert_exactly_one_input_disposition();

CREATE TABLE p2tr_invalidated_candidate_provenance (
    -- Transactionally allocated so rollback/retry cannot create uncommitted
    -- page-cursor gaps or silently alter a later local readiness identity.
    invalidation_id bigint PRIMARY KEY CHECK (invalidation_id > 0),
    block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
    txid bytea NOT NULL CHECK (octet_length(txid) = 32),
    wtxid bytea NOT NULL CHECK (octet_length(wtxid) = 32),
    provenance_generation bigint NOT NULL CHECK (provenance_generation > 0),
    provenance_fingerprint bytea NOT NULL
        CHECK (octet_length(provenance_fingerprint) = 32),
    reason text NOT NULL CHECK (
        reason IN ('ethereum-reorg', 'provenance-superseded')
    ),
    source_event_ids jsonb NOT NULL CHECK (
        jsonb_typeof(source_event_ids) = 'array' AND
        octet_length(convert_to(source_event_ids::text, 'UTF8')) <= 60000
    ),
    successor_fingerprint bytea CHECK (
        successor_fingerprint IS NULL OR octet_length(successor_fingerprint) = 32
    ),
    invalidated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (
        block_hash, txid, wtxid, provenance_generation,
        provenance_fingerprint
    )
);

CREATE INDEX p2tr_invalidated_candidate_generation_idx
    ON p2tr_invalidated_candidate_provenance
       (provenance_generation DESC);

-- Each committed generation is an immutable, restart-stable statement of the
-- canonical Bitcoin/Ethereum state. Projection rows can continue to be
-- updated efficiently, while these temporal memberships retain the exact
-- object set that an older readiness export committed to before a reorg.
CREATE FUNCTION p2tr_canonical_generation_manifest_digest(
    generation_id bigint,
    journal_epoch bigint,
    parent_manifest_digest bytea,
    domain_digest bytea,
    bitcoin_height bigint,
    bitcoin_hash bytea,
    bitcoin_header_object_digest bytea,
    ethereum_block_number bigint,
    ethereum_block_hash bytea,
    bitcoin_chain_root bytea,
    projection_root bytea,
    semantic_root bytea,
    transition_root bytea,
    source_receipt_root bytea,
    candidate_disposition_root bytea,
    membership_root bytea,
    active_membership_count bigint,
    active_object_bytes bigint
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to('tbtc-p2tr-canonical-generation-v1', 'UTF8') ||
        int8send(generation_id) || int8send(journal_epoch) ||
        coalesce(parent_manifest_digest, decode(repeat('00', 32), 'hex')) ||
        domain_digest || int8send(bitcoin_height) || bitcoin_hash ||
        bitcoin_header_object_digest || int8send(ethereum_block_number) ||
        ethereum_block_hash || bitcoin_chain_root || projection_root ||
        semantic_root || transition_root || source_receipt_root ||
        candidate_disposition_root || membership_root ||
        int8send(active_membership_count) || int8send(active_object_bytes)
    )
$$;

CREATE TABLE p2tr_canonical_generations (
    generation_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
        CHECK (generation_id > 0),
    journal_epoch bigint NOT NULL UNIQUE CHECK (journal_epoch > 0),
    parent_generation_id bigint,
    parent_manifest_digest bytea CHECK (
        parent_manifest_digest IS NULL OR
        octet_length(parent_manifest_digest) = 32
    ),
    state text NOT NULL DEFAULT 'building'
        CHECK (state IN ('building', 'committed')),
    domain_digest bytea NOT NULL CHECK (octet_length(domain_digest) = 32),
    bitcoin_height bigint NOT NULL CHECK (bitcoin_height >= 0),
    bitcoin_hash bytea NOT NULL CHECK (octet_length(bitcoin_hash) = 32),
    bitcoin_header_object_digest bytea NOT NULL
        CHECK (octet_length(bitcoin_header_object_digest) = 32),
    ethereum_block_number bigint NOT NULL CHECK (ethereum_block_number >= 0),
    ethereum_block_hash bytea NOT NULL
        CHECK (octet_length(ethereum_block_hash) = 32),
    bitcoin_chain_root bytea NOT NULL
        CHECK (octet_length(bitcoin_chain_root) = 32),
    projection_root bytea NOT NULL CHECK (octet_length(projection_root) = 32),
    semantic_root bytea NOT NULL CHECK (octet_length(semantic_root) = 32),
    transition_root bytea CHECK (
        transition_root IS NULL OR octet_length(transition_root) = 32
    ),
    source_receipt_root bytea CHECK (
        source_receipt_root IS NULL OR octet_length(source_receipt_root) = 32
    ),
    candidate_disposition_root bytea CHECK (
        candidate_disposition_root IS NULL OR
        octet_length(candidate_disposition_root) = 32
    ),
    membership_root bytea CHECK (
        membership_root IS NULL OR octet_length(membership_root) = 32
    ),
    active_membership_count bigint CHECK (
        active_membership_count IS NULL OR active_membership_count >= 0
    ),
    active_object_bytes bigint CHECK (
        active_object_bytes IS NULL OR active_object_bytes >= 0
    ),
    manifest_digest bytea UNIQUE CHECK (
        manifest_digest IS NULL OR octet_length(manifest_digest) = 32
    ),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    committed_at timestamptz,
    UNIQUE (generation_id, manifest_digest),
    UNIQUE (generation_id, manifest_digest, domain_digest),
    FOREIGN KEY (parent_generation_id, parent_manifest_digest)
        REFERENCES p2tr_canonical_generations
            (generation_id, manifest_digest),
    FOREIGN KEY (domain_digest)
        REFERENCES p2tr_complete_authorization_domain (domain_digest),
    CHECK (
        (parent_generation_id IS NULL AND parent_manifest_digest IS NULL) OR
        (parent_generation_id IS NOT NULL AND parent_manifest_digest IS NOT NULL)
    ),
    CHECK (
        (state = 'building' AND transition_root IS NULL AND
         source_receipt_root IS NULL AND candidate_disposition_root IS NULL AND
         membership_root IS NULL AND
         active_membership_count IS NULL AND active_object_bytes IS NULL AND
         manifest_digest IS NULL AND committed_at IS NULL) OR
        (state = 'committed' AND transition_root IS NOT NULL AND
         source_receipt_root IS NOT NULL AND
         candidate_disposition_root IS NOT NULL AND membership_root IS NOT NULL AND
         active_membership_count IS NOT NULL AND
         active_object_bytes IS NOT NULL AND manifest_digest IS NOT NULL AND
         committed_at IS NOT NULL)
    ),
    CHECK (
        state <> 'committed' OR
        manifest_digest = p2tr_canonical_generation_manifest_digest(
            generation_id, journal_epoch, parent_manifest_digest,
            domain_digest,
            bitcoin_height, bitcoin_hash, bitcoin_header_object_digest,
            ethereum_block_number, ethereum_block_hash, bitcoin_chain_root,
            projection_root, semantic_root, transition_root,
            source_receipt_root, candidate_disposition_root, membership_root,
            active_membership_count, active_object_bytes
        )
    )
);

CREATE UNIQUE INDEX p2tr_canonical_generations_single_builder_idx
    ON p2tr_canonical_generations (state)
    WHERE state = 'building';

CREATE INDEX p2tr_canonical_generations_committed_idx
    ON p2tr_canonical_generations (generation_id DESC)
    WHERE state = 'committed';

CREATE FUNCTION p2tr_canonical_logical_key_digest(
    namespace text,
    canonical_key bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to(
            'tbtc-p2tr-canonical-logical-key-v1' || chr(31) || namespace,
            'UTF8'
        ) || canonical_key
    )
$$;

-- Canonical key encodings. Hashes and transaction IDs are the 32 bytes in the
-- display-order convention used by the watchtower API; heights are signed
-- eight-byte network order and uint32 values are their final four big-endian
-- bytes. Namespace separation prevents cross-type key aliasing.
CREATE FUNCTION p2tr_bitcoin_block_logical_key_digest(
    namespace text,
    height bigint,
    block_hash bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT p2tr_canonical_logical_key_digest(
        namespace, int8send(height) || block_hash
    )
$$;

CREATE FUNCTION p2tr_bitcoin_transaction_logical_key_digest(
    block_hash bytea,
    txid bytea,
    wtxid bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT p2tr_canonical_logical_key_digest(
        'bitcoin_raw_transaction', block_hash || txid || wtxid
    )
$$;

CREATE FUNCTION p2tr_bitcoin_outpoint_logical_key_digest(
    namespace text,
    block_hash bytea,
    txid bytea,
    vout bigint
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT p2tr_canonical_logical_key_digest(
        namespace,
        block_hash || txid || substring(
            p2tr_uint256_big_endian(vout::numeric) FROM 29 FOR 4
        )
    )
$$;

CREATE FUNCTION p2tr_candidate_input_logical_key_digest(
    block_hash bytea,
    txid bytea,
    wtxid bytea,
    input_index integer
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT p2tr_canonical_logical_key_digest(
        'complete_input_disposition',
        block_hash || txid || wtxid || substring(
            p2tr_uint256_big_endian(input_index::numeric) FROM 29 FOR 4
        )
    )
$$;

CREATE FUNCTION p2tr_canonical_membership_digest(
    namespace text,
    logical_key_digest bytea,
    object_digest bytea,
    valid_from_generation bigint
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to(
            'tbtc-p2tr-canonical-membership-v1' || chr(31) || namespace,
            'UTF8'
        ) || logical_key_digest || object_digest ||
        int8send(valid_from_generation)
    )
$$;

CREATE TABLE p2tr_canonical_memberships (
    namespace text NOT NULL CHECK (namespace IN (
        'authorization_domain',
        'watchtower_source_identity',
        'frost_wallet_binding',
        'pending_deposit_reveal',
        'tracked_outpoint',
        'bitcoin_candidate',
        'ethereum_provenance',
        'invalidation',
        'unmatched_proof',
        'cross_source_watermark',
        'bitcoin_header80',
        'bitcoin_raw_block',
        'bitcoin_raw_transaction',
        'bitcoin_prevout_script',
        'complete_input_disposition',
        'source_receipt',
        'canonical_projection_row'
    )),
    logical_key_digest bytea NOT NULL
        CHECK (octet_length(logical_key_digest) = 32),
    object_digest bytea NOT NULL CHECK (octet_length(object_digest) = 32),
    object_kind text NOT NULL CHECK (
        object_kind ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    ),
    valid_from_generation bigint NOT NULL CHECK (valid_from_generation > 0),
    valid_to_generation bigint CHECK (
        valid_to_generation IS NULL OR valid_to_generation > valid_from_generation
    ),
    membership_digest bytea NOT NULL UNIQUE
        CHECK (octet_length(membership_digest) = 32),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_at timestamptz,
    PRIMARY KEY (namespace, logical_key_digest, valid_from_generation),
    FOREIGN KEY (valid_from_generation)
        REFERENCES p2tr_canonical_generations (generation_id),
    FOREIGN KEY (valid_to_generation)
        REFERENCES p2tr_canonical_generations (generation_id),
    CHECK (
        membership_digest = p2tr_canonical_membership_digest(
            namespace, logical_key_digest, object_digest,
            valid_from_generation
        )
    ),
    CHECK (
        (valid_to_generation IS NULL AND closed_at IS NULL) OR
        (valid_to_generation IS NOT NULL AND closed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX p2tr_canonical_memberships_active_idx
    ON p2tr_canonical_memberships (namespace, logical_key_digest)
    WHERE valid_to_generation IS NULL;

CREATE INDEX p2tr_canonical_memberships_generation_idx
    ON p2tr_canonical_memberships
       (valid_from_generation, valid_to_generation, namespace);

CREATE INDEX p2tr_canonical_memberships_object_idx
    ON p2tr_canonical_memberships (object_digest);

CREATE FUNCTION p2tr_canonical_generation_membership_root(
    target_generation bigint
)
RETURNS bytea
LANGUAGE plpgsql
STABLE
STRICT
AS $$
DECLARE
    current_root bytea := sha256(
        convert_to('tbtc-p2tr-canonical-membership-root-v1', 'UTF8')
    );
    leaf record;
BEGIN
    FOR leaf IN
        SELECT membership_digest
          FROM p2tr_canonical_memberships
         WHERE valid_from_generation <= target_generation
           AND (
               valid_to_generation IS NULL OR
               valid_to_generation > target_generation
           )
         ORDER BY namespace, logical_key_digest
    LOOP
        current_root := sha256(current_root || leaf.membership_digest);
    END LOOP;
    RETURN current_root;
END
$$;

CREATE FUNCTION p2tr_canonical_generation_namespace_root(
    target_generation bigint,
    target_namespace text
)
RETURNS bytea
LANGUAGE plpgsql
STABLE
STRICT
AS $$
DECLARE
    current_root bytea := sha256(convert_to(
        'tbtc-p2tr-canonical-namespace-root-v1' || chr(31) ||
        target_namespace,
        'UTF8'
    ));
    leaf record;
BEGIN
    FOR leaf IN
        SELECT membership_digest
          FROM p2tr_canonical_memberships
         WHERE namespace = target_namespace
           AND valid_from_generation <= target_generation
           AND (
               valid_to_generation IS NULL OR
               valid_to_generation > target_generation
           )
         ORDER BY logical_key_digest
    LOOP
        current_root := sha256(current_root || leaf.membership_digest);
    END LOOP;
    RETURN current_root;
END
$$;

CREATE FUNCTION p2tr_canonical_generation_transition_root(
    target_generation bigint
)
RETURNS bytea
LANGUAGE plpgsql
STABLE
STRICT
AS $$
DECLARE
    current_root bytea := sha256(
        convert_to('tbtc-p2tr-canonical-transition-root-v1', 'UTF8')
    );
    leaf record;
BEGIN
    FOR leaf IN
        SELECT operation, namespace, logical_key_digest, membership_digest
          FROM (
              SELECT 1::smallint AS operation, namespace,
                     logical_key_digest, membership_digest
                FROM p2tr_canonical_memberships
               WHERE valid_from_generation = target_generation
              UNION ALL
              SELECT 0::smallint AS operation, namespace,
                     logical_key_digest, membership_digest
                FROM p2tr_canonical_memberships
               WHERE valid_to_generation = target_generation
          ) transitions
         ORDER BY namespace, logical_key_digest, operation
    LOOP
        current_root := sha256(
            current_root || int2send(leaf.operation) || leaf.membership_digest
        );
    END LOOP;
    RETURN current_root;
END
$$;

CREATE FUNCTION p2tr_guard_canonical_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_state text;
    stored_kind text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT state INTO target_state
          FROM p2tr_canonical_generations
         WHERE generation_id = NEW.valid_from_generation
         FOR SHARE;
        IF target_state IS DISTINCT FROM 'building' THEN
            RAISE EXCEPTION 'membership must open in the building generation';
        END IF;
        SELECT object_kind INTO stored_kind
          FROM p2tr_evidence_objects
         WHERE object_digest = NEW.object_digest;
        IF stored_kind IS DISTINCT FROM NEW.object_kind OR
           NOT p2tr_evidence_object_is_complete(NEW.object_digest) THEN
            RAISE EXCEPTION 'membership references missing or corrupt evidence';
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.valid_to_generation IS NOT NULL OR
           NEW.valid_to_generation IS NULL OR
           NEW.closed_at IS NULL OR
           NEW.namespace IS DISTINCT FROM OLD.namespace OR
           NEW.logical_key_digest IS DISTINCT FROM OLD.logical_key_digest OR
           NEW.object_digest IS DISTINCT FROM OLD.object_digest OR
           NEW.object_kind IS DISTINCT FROM OLD.object_kind OR
           NEW.valid_from_generation IS DISTINCT FROM OLD.valid_from_generation OR
           NEW.membership_digest IS DISTINCT FROM OLD.membership_digest OR
           NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'canonical membership may only be closed once';
        END IF;
        SELECT state INTO target_state
          FROM p2tr_canonical_generations
         WHERE generation_id = NEW.valid_to_generation
         FOR SHARE;
        IF target_state IS DISTINCT FROM 'building' THEN
            RAISE EXCEPTION 'membership must close in the building generation';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'canonical memberships are append-only temporal records';
END
$$;

CREATE TRIGGER p2tr_canonical_memberships_guard
BEFORE INSERT OR UPDATE OR DELETE ON p2tr_canonical_memberships
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_canonical_membership();

CREATE FUNCTION p2tr_guard_canonical_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    latest_generation_id bigint;
    parent_state text;
    measured_count bigint;
    measured_bytes bigint;
    corrupt_count bigint;
    header_kind text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'canonical generations are append-only';
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'building' THEN
            RAISE EXCEPTION 'canonical generation must begin in building state';
        END IF;
        SELECT generation_id INTO latest_generation_id
          FROM p2tr_canonical_generations
         WHERE state = 'committed'
         ORDER BY generation_id DESC
         LIMIT 1
         FOR SHARE;
        IF NEW.parent_generation_id IS DISTINCT FROM latest_generation_id THEN
            RAISE EXCEPTION 'canonical generation parent is not the latest commit';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.state <> 'building' OR NEW.state <> 'committed' OR
       NEW.generation_id IS DISTINCT FROM OLD.generation_id OR
       NEW.journal_epoch IS DISTINCT FROM OLD.journal_epoch OR
       NEW.parent_generation_id IS DISTINCT FROM OLD.parent_generation_id OR
       NEW.parent_manifest_digest IS DISTINCT FROM OLD.parent_manifest_digest OR
       NEW.domain_digest IS DISTINCT FROM OLD.domain_digest OR
       NEW.bitcoin_height IS DISTINCT FROM OLD.bitcoin_height OR
       NEW.bitcoin_hash IS DISTINCT FROM OLD.bitcoin_hash OR
       NEW.bitcoin_header_object_digest IS DISTINCT FROM
           OLD.bitcoin_header_object_digest OR
       NEW.ethereum_block_number IS DISTINCT FROM OLD.ethereum_block_number OR
       NEW.ethereum_block_hash IS DISTINCT FROM OLD.ethereum_block_hash OR
       NEW.bitcoin_chain_root IS DISTINCT FROM OLD.bitcoin_chain_root OR
       NEW.projection_root IS DISTINCT FROM OLD.projection_root OR
       NEW.semantic_root IS DISTINCT FROM OLD.semantic_root OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'canonical generation is immutable after construction';
    END IF;

    IF NEW.parent_generation_id IS NOT NULL THEN
        SELECT state INTO parent_state
          FROM p2tr_canonical_generations
         WHERE generation_id = NEW.parent_generation_id
           AND manifest_digest = NEW.parent_manifest_digest
         FOR SHARE;
        IF parent_state IS DISTINCT FROM 'committed' THEN
            RAISE EXCEPTION 'canonical generation parent is not committed';
        END IF;
    END IF;

    SELECT object_kind INTO header_kind
      FROM p2tr_evidence_objects
     WHERE object_digest = NEW.bitcoin_header_object_digest;
    IF header_kind IS DISTINCT FROM 'bitcoin_header80' OR
       NOT p2tr_evidence_object_is_complete(
           NEW.bitcoin_header_object_digest
       ) THEN
        RAISE EXCEPTION 'generation header evidence is missing or corrupt';
    END IF;

    SELECT
        count(*),
        coalesce(sum(objects.byte_length), 0),
        count(*) FILTER (
            WHERE objects.object_digest IS NULL OR
                  objects.object_kind <> memberships.object_kind OR
                  NOT p2tr_evidence_object_is_complete(
                      memberships.object_digest
                  )
        )
      INTO measured_count, measured_bytes, corrupt_count
      FROM p2tr_canonical_memberships memberships
      LEFT JOIN p2tr_evidence_objects objects
        ON objects.object_digest = memberships.object_digest
     WHERE memberships.valid_from_generation <= NEW.generation_id
       AND (
           memberships.valid_to_generation IS NULL OR
           memberships.valid_to_generation > NEW.generation_id
       );

    IF corrupt_count <> 0 OR
       measured_count <> NEW.active_membership_count OR
       measured_bytes <> NEW.active_object_bytes THEN
        RAISE EXCEPTION 'canonical generation membership inventory mismatch';
    END IF;
    IF NEW.membership_root <>
           p2tr_canonical_generation_membership_root(NEW.generation_id) OR
       NEW.transition_root <>
           p2tr_canonical_generation_transition_root(NEW.generation_id) OR
       NEW.source_receipt_root <>
           p2tr_canonical_generation_namespace_root(
               NEW.generation_id, 'source_receipt'
           ) OR
       NEW.candidate_disposition_root <>
           p2tr_canonical_generation_namespace_root(
               NEW.generation_id, 'complete_input_disposition'
           ) THEN
        RAISE EXCEPTION 'canonical generation root mismatch';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_canonical_generations_guard
BEFORE INSERT OR UPDATE OR DELETE ON p2tr_canonical_generations
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_canonical_generation();

-- Durable nonce ledger for cross-cluster readiness exports. The sealed row is
-- a fixed-size handle. Raw evidence stays in immutable objects and is exposed
-- only through the ordered, digest-authenticated, byte-bounded stream below.
CREATE FUNCTION p2tr_readiness_export_source_signature_payload_digest(
    export_fence bigint,
    request_digest bytea,
    pinned_generation bigint,
    generation_manifest_digest bytea,
    domain_digest bytea,
    source_identity_digest bytea,
    source_signing_key_id text,
    snapshot_root bytea,
    snapshot_semantic_root bytea,
    snapshot_generation bigint,
    result_digest bytea,
    audit_manifest_root bytea,
    audit_stream_digest bytea,
    audit_object_count bigint,
    audit_total_bytes bigint,
    audit_page_max_bytes integer,
    expires_at timestamptz
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to(
            'tbtc-p2tr-readiness-export-signature-v1' || chr(31) ||
            source_signing_key_id,
            'UTF8'
        ) || int8send(export_fence) || request_digest ||
        int8send(pinned_generation) || generation_manifest_digest ||
        domain_digest || source_identity_digest || snapshot_root ||
        snapshot_semantic_root || int8send(snapshot_generation) ||
        result_digest || audit_manifest_root || audit_stream_digest ||
        int8send(audit_object_count) ||
        int8send(audit_total_bytes) || int4send(audit_page_max_bytes) ||
        timestamptz_send(expires_at)
    )
$$;

CREATE TABLE p2tr_readiness_exports (
    request_nonce bytea PRIMARY KEY CHECK (octet_length(request_nonce) = 32),
    request_digest bytea NOT NULL UNIQUE
        CHECK (octet_length(request_digest) = 32),
    export_fence bigint NOT NULL UNIQUE CHECK (export_fence > 0),
    snapshot_root bytea NOT NULL CHECK (octet_length(snapshot_root) = 32),
    snapshot_semantic_root bytea NOT NULL
        CHECK (octet_length(snapshot_semantic_root) = 32),
    snapshot_generation bigint NOT NULL CHECK (snapshot_generation >= 0),
    pinned_generation bigint NOT NULL CHECK (pinned_generation > 0),
    generation_manifest_digest bytea NOT NULL
        CHECK (octet_length(generation_manifest_digest) = 32),
    domain_digest bytea NOT NULL CHECK (octet_length(domain_digest) = 32),
    source_store_id text NOT NULL CHECK (length(source_store_id) BETWEEN 1 AND 255),
    source_cluster_id text NOT NULL
        CHECK (length(source_cluster_id) BETWEEN 1 AND 255),
    source_operator_id text NOT NULL
        CHECK (length(source_operator_id) BETWEEN 1 AND 255),
    source_trust_domain_id text NOT NULL
        CHECK (length(source_trust_domain_id) BETWEEN 1 AND 255),
    source_bitcoin_identity_digest bytea NOT NULL
        CHECK (octet_length(source_bitcoin_identity_digest) = 32),
    source_ethereum_identity_digest bytea NOT NULL
        CHECK (octet_length(source_ethereum_identity_digest) = 32),
    source_identity_digest bytea NOT NULL
        CHECK (octet_length(source_identity_digest) = 32),
    source_signing_key_id text NOT NULL
        CHECK (length(source_signing_key_id) BETWEEN 1 AND 255),
    source_signature bytea CHECK (
        source_signature IS NULL OR
        octet_length(source_signature) BETWEEN 1 AND 4096
    ),
    source_signature_payload_digest bytea CHECK (
        source_signature_payload_digest IS NULL OR
        octet_length(source_signature_payload_digest) = 32
    ),
    source_configuration_fingerprint bytea NOT NULL
        CHECK (octet_length(source_configuration_fingerprint) = 32),
    candidate_provenance_generation bigint CHECK (
        candidate_provenance_generation IS NULL OR
        candidate_provenance_generation > 0
    ),
    candidate_provenance_fingerprint bytea CHECK (
        candidate_provenance_fingerprint IS NULL OR
        octet_length(candidate_provenance_fingerprint) = 32
    ),
    candidate_input_index integer CHECK (
        candidate_input_index IS NULL OR candidate_input_index >= 0
    ),
    candidate_challenge_identity bytea CHECK (
        candidate_challenge_identity IS NULL OR
        octet_length(candidate_challenge_identity) = 32
    ),
    candidate_occurrence_id bytea CHECK (
        candidate_occurrence_id IS NULL OR
        octet_length(candidate_occurrence_id) = 32
    ),
    canonical_request jsonb NOT NULL
        CHECK (
            jsonb_typeof(canonical_request) = 'object' AND
            octet_length(convert_to(canonical_request::text, 'UTF8')) <= 4096
        ),
    result_payload jsonb NOT NULL CHECK (
        jsonb_typeof(result_payload) = 'object' AND
        octet_length(convert_to(result_payload::text, 'UTF8')) <= 65536
    ),
    result_digest bytea NOT NULL CHECK (octet_length(result_digest) = 32),
    state text NOT NULL DEFAULT 'building'
        CHECK (state IN ('building', 'sealed')),
    audit_manifest_root bytea CHECK (
        audit_manifest_root IS NULL OR octet_length(audit_manifest_root) = 32
    ),
    audit_stream_digest bytea CHECK (
        audit_stream_digest IS NULL OR octet_length(audit_stream_digest) = 32
    ),
    audit_object_count bigint CHECK (
        audit_object_count IS NULL OR audit_object_count > 0
    ),
    audit_total_bytes bigint CHECK (
        audit_total_bytes IS NULL OR audit_total_bytes >= 0
    ),
    audit_page_max_bytes integer NOT NULL DEFAULT 65536
        CHECK (audit_page_max_bytes BETWEEN 1024 AND 65536),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    sealed_at timestamptz,
    UNIQUE (
        export_fence, request_digest, snapshot_root, result_digest,
        audit_manifest_root,
        audit_stream_digest, audit_object_count, audit_total_bytes
    ),
    FOREIGN KEY (
        pinned_generation, generation_manifest_digest, domain_digest
    ) REFERENCES p2tr_canonical_generations (
        generation_id, manifest_digest, domain_digest
    ),
    FOREIGN KEY (
        source_store_id, source_cluster_id, source_operator_id,
        source_bitcoin_identity_digest, source_ethereum_identity_digest,
        source_identity_digest
    ) REFERENCES p2tr_watchtower_source_identity (
        source_store_id, source_cluster_id, source_operator_id,
        bitcoin_identity_digest, ethereum_identity_digest,
        source_identity_digest
    ),
    CHECK (expires_at > created_at),
    CHECK (
        (state = 'building' AND source_signature IS NULL AND
         source_signature_payload_digest IS NULL AND
         audit_manifest_root IS NULL AND audit_stream_digest IS NULL AND
         audit_object_count IS NULL AND audit_total_bytes IS NULL AND
         sealed_at IS NULL) OR
        (state = 'sealed' AND source_signature IS NOT NULL AND
         source_signature_payload_digest IS NOT NULL AND
         audit_manifest_root IS NOT NULL AND audit_stream_digest IS NOT NULL AND
         audit_object_count IS NOT NULL AND audit_total_bytes IS NOT NULL AND
         sealed_at IS NOT NULL)
    ),
    CHECK (
        state <> 'sealed' OR
        source_signature_payload_digest =
            p2tr_readiness_export_source_signature_payload_digest(
                export_fence, request_digest, pinned_generation,
                generation_manifest_digest, domain_digest,
                source_identity_digest, source_signing_key_id, snapshot_root,
                snapshot_semantic_root, snapshot_generation, result_digest,
                audit_manifest_root, audit_stream_digest,
                audit_object_count, audit_total_bytes,
                audit_page_max_bytes, expires_at
            )
    ),
    CHECK (
        (candidate_provenance_generation IS NULL AND
         candidate_provenance_fingerprint IS NULL AND
         candidate_input_index IS NULL AND
         candidate_challenge_identity IS NULL AND
         candidate_occurrence_id IS NULL) OR
        (candidate_provenance_generation IS NOT NULL AND
         candidate_provenance_fingerprint IS NOT NULL AND
         candidate_input_index IS NOT NULL AND
         candidate_challenge_identity IS NOT NULL AND
         candidate_occurrence_id IS NOT NULL)
    )
);

CREATE FUNCTION p2tr_readiness_export_object_leaf_digest(
    export_fence bigint,
    stream_ordinal bigint,
    object_digest bytea,
    object_kind text,
    byte_length bigint,
    content_digest bytea,
    chunk_manifest_root bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to(
            'tbtc-p2tr-readiness-export-object-v1' || chr(31) || object_kind,
            'UTF8'
        ) || int8send(export_fence) || int8send(stream_ordinal) ||
        object_digest || int8send(byte_length) || content_digest ||
        chunk_manifest_root
    )
$$;

CREATE TABLE p2tr_readiness_export_objects (
    export_fence bigint NOT NULL CHECK (export_fence > 0),
    stream_ordinal bigint NOT NULL CHECK (stream_ordinal >= 0),
    object_digest bytea NOT NULL CHECK (octet_length(object_digest) = 32),
    object_kind text NOT NULL CHECK (
        object_kind ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    ),
    byte_length bigint NOT NULL CHECK (byte_length BETWEEN 0 AND 4000000),
    content_digest bytea NOT NULL CHECK (octet_length(content_digest) = 32),
    chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 64),
    chunk_manifest_root bytea NOT NULL
        CHECK (octet_length(chunk_manifest_root) = 32),
    stream_leaf_digest bytea NOT NULL
        CHECK (octet_length(stream_leaf_digest) = 32),
    PRIMARY KEY (export_fence, stream_ordinal),
    UNIQUE (export_fence, object_digest),
    FOREIGN KEY (export_fence)
        REFERENCES p2tr_readiness_exports (export_fence),
    CHECK (
        stream_leaf_digest = p2tr_readiness_export_object_leaf_digest(
            export_fence, stream_ordinal, object_digest, object_kind,
            byte_length, content_digest, chunk_manifest_root
        )
    )
);

CREATE INDEX p2tr_readiness_export_objects_digest_idx
    ON p2tr_readiness_export_objects (object_digest);

CREATE FUNCTION p2tr_readiness_export_manifest_root(target_fence bigint)
RETURNS bytea
LANGUAGE plpgsql
STABLE
STRICT
AS $$
DECLARE
    current_root bytea := sha256(
        convert_to('tbtc-p2tr-readiness-export-manifest-v1', 'UTF8')
    );
    leaf record;
BEGIN
    FOR leaf IN
        SELECT stream_leaf_digest
          FROM p2tr_readiness_export_objects
         WHERE export_fence = target_fence
         ORDER BY stream_ordinal
    LOOP
        current_root := sha256(current_root || leaf.stream_leaf_digest);
    END LOOP;
    RETURN current_root;
END
$$;

-- Incremental audit stream digest. Consumers begin with SHA256 of the stream
-- domain tag. For each object in stream_ordinal order they fold one object
-- frame, then each canonical 64 KiB chunk in chunk_index order. Each fold is
-- SHA256(previous_digest || frame_digest), so verification needs only one
-- chunk and two 32-byte digests in memory and no ordered-hash array.
CREATE FUNCTION p2tr_readiness_export_stream_digest(target_fence bigint)
RETURNS bytea
LANGUAGE plpgsql
STABLE
STRICT
AS $$
DECLARE
    current_digest bytea := sha256(
        convert_to('tbtc-p2tr-readiness-audit-stream-v1', 'UTF8')
    );
    exported record;
    chunk record;
    frame_digest bytea;
BEGIN
    FOR exported IN
        SELECT stream_ordinal, object_digest, chunk_count,
               stream_leaf_digest
          FROM p2tr_readiness_export_objects
         WHERE export_fence = target_fence
         ORDER BY stream_ordinal
    LOOP
        frame_digest := sha256(
            convert_to('tbtc-p2tr-readiness-object-frame-v1', 'UTF8') ||
            int8send(exported.stream_ordinal) || exported.object_digest ||
            int4send(exported.chunk_count) || exported.stream_leaf_digest
        );
        current_digest := sha256(current_digest || frame_digest);
        FOR chunk IN
            SELECT links.chunk_index, links.byte_offset,
                   links.chunk_digest, chunks.chunk_bytes
              FROM p2tr_evidence_object_chunks links
              JOIN p2tr_evidence_chunks chunks USING (chunk_digest)
             WHERE links.object_digest = exported.object_digest
             ORDER BY links.chunk_index
        LOOP
            frame_digest := sha256(
                convert_to('tbtc-p2tr-readiness-chunk-frame-v1', 'UTF8') ||
                int8send(exported.stream_ordinal) ||
                int4send(chunk.chunk_index) || int8send(chunk.byte_offset) ||
                exported.object_digest || chunk.chunk_digest ||
                int4send(octet_length(chunk.chunk_bytes)) || chunk.chunk_bytes
            );
            current_digest := sha256(current_digest || frame_digest);
        END LOOP;
    END LOOP;
    RETURN current_digest;
END
$$;

CREATE FUNCTION p2tr_guard_readiness_export_object()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    export_state text;
    stored p2tr_evidence_objects%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'readiness export object manifests are append-only';
    END IF;
    SELECT state INTO export_state
      FROM p2tr_readiness_exports
     WHERE export_fence = NEW.export_fence
     FOR SHARE;
    IF export_state IS DISTINCT FROM 'building' THEN
        RAISE EXCEPTION 'cannot alter a sealed readiness export';
    END IF;
    SELECT * INTO STRICT stored
      FROM p2tr_evidence_objects
     WHERE object_digest = NEW.object_digest;
    IF stored.object_kind <> NEW.object_kind OR
       stored.byte_length <> NEW.byte_length OR
       stored.content_digest <> NEW.content_digest OR
       stored.chunk_count <> NEW.chunk_count OR
       stored.chunk_manifest_root <> NEW.chunk_manifest_root OR
       NOT p2tr_evidence_object_is_complete(NEW.object_digest) THEN
        RAISE EXCEPTION 'export references missing or corrupt evidence';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_readiness_export_objects_guard
BEFORE INSERT OR UPDATE OR DELETE ON p2tr_readiness_export_objects
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_readiness_export_object();

CREATE FUNCTION p2tr_guard_readiness_export()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    generation_state text;
    measured_count bigint;
    measured_bytes bigint;
    first_ordinal bigint;
    last_ordinal bigint;
    missing_count bigint;
    extra_count bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'readiness exports are append-only';
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'building' THEN
            RAISE EXCEPTION 'readiness export must begin in building state';
        END IF;
        SELECT state INTO generation_state
          FROM p2tr_canonical_generations
         WHERE generation_id = NEW.pinned_generation
           AND manifest_digest = NEW.generation_manifest_digest
           AND domain_digest = NEW.domain_digest
         FOR SHARE;
        IF generation_state IS DISTINCT FROM 'committed' THEN
            RAISE EXCEPTION 'readiness export must pin a committed generation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.state <> 'building' OR NEW.state <> 'sealed' OR
       NEW.request_nonce IS DISTINCT FROM OLD.request_nonce OR
       NEW.request_digest IS DISTINCT FROM OLD.request_digest OR
       NEW.export_fence IS DISTINCT FROM OLD.export_fence OR
       NEW.snapshot_root IS DISTINCT FROM OLD.snapshot_root OR
       NEW.snapshot_semantic_root IS DISTINCT FROM OLD.snapshot_semantic_root OR
       NEW.snapshot_generation IS DISTINCT FROM OLD.snapshot_generation OR
       NEW.pinned_generation IS DISTINCT FROM OLD.pinned_generation OR
       NEW.generation_manifest_digest IS DISTINCT FROM
           OLD.generation_manifest_digest OR
       NEW.domain_digest IS DISTINCT FROM OLD.domain_digest OR
       NEW.source_store_id IS DISTINCT FROM OLD.source_store_id OR
       NEW.source_cluster_id IS DISTINCT FROM OLD.source_cluster_id OR
       NEW.source_operator_id IS DISTINCT FROM OLD.source_operator_id OR
       NEW.source_trust_domain_id IS DISTINCT FROM OLD.source_trust_domain_id OR
       NEW.source_bitcoin_identity_digest IS DISTINCT FROM
           OLD.source_bitcoin_identity_digest OR
       NEW.source_ethereum_identity_digest IS DISTINCT FROM
           OLD.source_ethereum_identity_digest OR
       NEW.source_identity_digest IS DISTINCT FROM OLD.source_identity_digest OR
       NEW.source_signing_key_id IS DISTINCT FROM OLD.source_signing_key_id OR
       NEW.source_configuration_fingerprint IS DISTINCT FROM
           OLD.source_configuration_fingerprint OR
       NEW.candidate_provenance_generation IS DISTINCT FROM
           OLD.candidate_provenance_generation OR
       NEW.candidate_provenance_fingerprint IS DISTINCT FROM
           OLD.candidate_provenance_fingerprint OR
       NEW.candidate_input_index IS DISTINCT FROM OLD.candidate_input_index OR
       NEW.candidate_challenge_identity IS DISTINCT FROM
           OLD.candidate_challenge_identity OR
       NEW.candidate_occurrence_id IS DISTINCT FROM
           OLD.candidate_occurrence_id OR
       NEW.canonical_request IS DISTINCT FROM OLD.canonical_request OR
       NEW.result_payload IS DISTINCT FROM OLD.result_payload OR
       NEW.result_digest IS DISTINCT FROM OLD.result_digest OR
       NEW.audit_page_max_bytes IS DISTINCT FROM OLD.audit_page_max_bytes OR
       NEW.created_at IS DISTINCT FROM OLD.created_at OR
       NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'sealed readiness export handle is immutable';
    END IF;

    SELECT count(*), coalesce(sum(byte_length), 0),
           coalesce(min(stream_ordinal), -1),
           coalesce(max(stream_ordinal), -1)
      INTO measured_count, measured_bytes, first_ordinal, last_ordinal
      FROM p2tr_readiness_export_objects
     WHERE export_fence = NEW.export_fence;

    SELECT count(*) INTO missing_count
      FROM (
          SELECT DISTINCT memberships.object_digest
            FROM p2tr_canonical_memberships memberships
           WHERE memberships.valid_from_generation <= NEW.pinned_generation
             AND (
                 memberships.valid_to_generation IS NULL OR
                 memberships.valid_to_generation > NEW.pinned_generation
             )
          UNION
          SELECT bitcoin_header_object_digest
            FROM p2tr_canonical_generations
           WHERE generation_id = NEW.pinned_generation
      ) required
      LEFT JOIN p2tr_readiness_export_objects exported
        ON exported.export_fence = NEW.export_fence
       AND exported.object_digest = required.object_digest
     WHERE exported.object_digest IS NULL;

    SELECT count(*) INTO extra_count
      FROM p2tr_readiness_export_objects exported
      LEFT JOIN (
          SELECT DISTINCT memberships.object_digest
            FROM p2tr_canonical_memberships memberships
           WHERE memberships.valid_from_generation <= NEW.pinned_generation
             AND (
                 memberships.valid_to_generation IS NULL OR
                 memberships.valid_to_generation > NEW.pinned_generation
             )
          UNION
          SELECT bitcoin_header_object_digest
            FROM p2tr_canonical_generations
           WHERE generation_id = NEW.pinned_generation
      ) required USING (object_digest)
     WHERE exported.export_fence = NEW.export_fence
       AND required.object_digest IS NULL;

    IF measured_count <> NEW.audit_object_count OR
       measured_bytes <> NEW.audit_total_bytes OR first_ordinal <> 0 OR
       last_ordinal <> measured_count - 1 OR missing_count <> 0 OR
       extra_count <> 0 OR
       p2tr_readiness_export_manifest_root(NEW.export_fence) <>
           NEW.audit_manifest_root OR
       p2tr_readiness_export_stream_digest(NEW.export_fence) <>
           NEW.audit_stream_digest THEN
        RAISE EXCEPTION 'readiness export manifest does not match pinned generation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_readiness_exports_guard
BEFORE INSERT OR UPDATE OR DELETE ON p2tr_readiness_exports
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_readiness_export();

CREATE FUNCTION p2tr_readiness_export_consumer_signature_payload_digest(
    export_fence bigint,
    consumer_id text,
    consumer_signing_key_id text,
    request_digest bytea,
    snapshot_root bytea,
    result_digest bytea,
    audit_manifest_root bytea,
    final_stream_digest bytea,
    streamed_object_count bigint,
    streamed_bytes bigint
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to(
            'tbtc-p2tr-readiness-acknowledgement-signature-v1' || chr(31) ||
            consumer_id || chr(31) || consumer_signing_key_id,
            'UTF8'
        ) || int8send(export_fence) || request_digest || snapshot_root ||
        result_digest || audit_manifest_root || final_stream_digest ||
        int8send(streamed_object_count) || int8send(streamed_bytes)
    )
$$;

CREATE TABLE p2tr_readiness_export_acknowledgements (
    export_fence bigint NOT NULL CHECK (export_fence > 0),
    consumer_id text NOT NULL CHECK (length(consumer_id) BETWEEN 1 AND 255),
    request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
    snapshot_root bytea NOT NULL CHECK (octet_length(snapshot_root) = 32),
    result_digest bytea NOT NULL CHECK (octet_length(result_digest) = 32),
    audit_manifest_root bytea NOT NULL
        CHECK (octet_length(audit_manifest_root) = 32),
    final_stream_digest bytea NOT NULL
        CHECK (octet_length(final_stream_digest) = 32),
    streamed_object_count bigint NOT NULL CHECK (streamed_object_count > 0),
    streamed_bytes bigint NOT NULL CHECK (streamed_bytes >= 0),
    consumer_signing_key_id text NOT NULL
        CHECK (length(consumer_signing_key_id) BETWEEN 1 AND 255),
    consumer_signature_payload_digest bytea NOT NULL
        CHECK (octet_length(consumer_signature_payload_digest) = 32),
    consumer_signature bytea NOT NULL
        CHECK (octet_length(consumer_signature) BETWEEN 1 AND 4096),
    acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (export_fence, consumer_id),
    FOREIGN KEY (
        export_fence, request_digest, snapshot_root, result_digest,
        audit_manifest_root,
        final_stream_digest, streamed_object_count, streamed_bytes
    ) REFERENCES p2tr_readiness_exports (
        export_fence, request_digest, snapshot_root, result_digest,
        audit_manifest_root,
        audit_stream_digest, audit_object_count, audit_total_bytes
    ),
    CHECK (
        consumer_signature_payload_digest =
            p2tr_readiness_export_consumer_signature_payload_digest(
                export_fence, consumer_id, consumer_signing_key_id,
                request_digest, snapshot_root, result_digest,
                audit_manifest_root, final_stream_digest,
                streamed_object_count, streamed_bytes
            )
    )
);

CREATE TRIGGER p2tr_readiness_export_acknowledgements_immutable
BEFORE UPDATE OR DELETE ON p2tr_readiness_export_acknowledgements
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE FUNCTION p2tr_evidence_retention_pin_digest(
    generation_id bigint,
    pin_kind text,
    export_fence bigint,
    owner_id text,
    expires_at timestamptz
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT sha256(convert_to(
        'tbtc-p2tr-evidence-retention-pin-v1' || chr(31) ||
        generation_id::text || chr(31) || pin_kind || chr(31) ||
        coalesce(export_fence::text, '') || chr(31) || owner_id || chr(31) ||
        coalesce(extract(epoch FROM expires_at)::numeric::text, ''),
        'UTF8'
    ))
$$;

CREATE TABLE p2tr_evidence_retention_pins (
    pin_digest bytea PRIMARY KEY CHECK (octet_length(pin_digest) = 32),
    generation_id bigint NOT NULL CHECK (generation_id > 0),
    pin_kind text NOT NULL CHECK (
        pin_kind IN ('export', 'activation', 'forensic')
    ),
    export_fence bigint,
    owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 255),
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (generation_id)
        REFERENCES p2tr_canonical_generations (generation_id),
    FOREIGN KEY (export_fence)
        REFERENCES p2tr_readiness_exports (export_fence),
    CHECK (
        (pin_kind = 'export' AND export_fence IS NOT NULL AND
         expires_at IS NOT NULL) OR
        (pin_kind = 'activation' AND export_fence IS NULL AND
         expires_at IS NULL) OR
        (pin_kind = 'forensic' AND export_fence IS NULL AND
         expires_at IS NOT NULL)
    ),
    CHECK (
        pin_digest = p2tr_evidence_retention_pin_digest(
            generation_id, pin_kind, export_fence, owner_id, expires_at
        )
    )
);

CREATE TRIGGER p2tr_evidence_retention_pins_immutable
BEFORE UPDATE OR DELETE ON p2tr_evidence_retention_pins
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE TABLE p2tr_evidence_retention_releases (
    pin_digest bytea PRIMARY KEY CHECK (octet_length(pin_digest) = 32),
    release_digest bytea NOT NULL UNIQUE
        CHECK (octet_length(release_digest) = 32),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 255),
    released_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (pin_digest)
        REFERENCES p2tr_evidence_retention_pins (pin_digest)
);

CREATE TRIGGER p2tr_evidence_retention_releases_immutable
BEFORE UPDATE OR DELETE ON p2tr_evidence_retention_releases
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE FUNCTION p2tr_guard_export_acknowledgement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    export_state text;
BEGIN
    SELECT state INTO export_state
      FROM p2tr_readiness_exports
     WHERE export_fence = NEW.export_fence
     FOR SHARE;
    IF export_state IS DISTINCT FROM 'sealed' THEN
        RAISE EXCEPTION 'cannot acknowledge an unsealed readiness export';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_readiness_export_acknowledgements_guard
BEFORE INSERT ON p2tr_readiness_export_acknowledgements
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_export_acknowledgement();

CREATE FUNCTION p2tr_acknowledge_readiness_export(
    ack_export_fence bigint,
    ack_consumer_id text,
    ack_consumer_signing_key_id text,
    ack_request_digest bytea,
    ack_snapshot_root bytea,
    ack_result_digest bytea,
    ack_audit_manifest_root bytea,
    ack_final_stream_digest bytea,
    ack_streamed_object_count bigint,
    ack_streamed_bytes bigint,
    ack_consumer_signature_payload_digest bytea,
    ack_consumer_signature bytea
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    persisted p2tr_readiness_export_acknowledgements%ROWTYPE;
BEGIN
    INSERT INTO p2tr_readiness_export_acknowledgements (
        export_fence, consumer_id, consumer_signing_key_id,
        request_digest, snapshot_root, result_digest, audit_manifest_root,
        final_stream_digest, streamed_object_count, streamed_bytes,
        consumer_signature_payload_digest, consumer_signature
    ) VALUES (
        ack_export_fence, ack_consumer_id, ack_consumer_signing_key_id,
        ack_request_digest, ack_snapshot_root, ack_result_digest,
        ack_audit_manifest_root, ack_final_stream_digest,
        ack_streamed_object_count, ack_streamed_bytes,
        ack_consumer_signature_payload_digest, ack_consumer_signature
    ) ON CONFLICT (export_fence, consumer_id) DO NOTHING;

    SELECT * INTO STRICT persisted
      FROM p2tr_readiness_export_acknowledgements
     WHERE export_fence = ack_export_fence
       AND consumer_id = ack_consumer_id
     FOR SHARE;
    IF persisted.request_digest <> ack_request_digest OR
       persisted.snapshot_root <> ack_snapshot_root OR
       persisted.result_digest <> ack_result_digest OR
       persisted.audit_manifest_root <> ack_audit_manifest_root OR
       persisted.final_stream_digest <> ack_final_stream_digest OR
       persisted.streamed_object_count <> ack_streamed_object_count OR
       persisted.streamed_bytes <> ack_streamed_bytes OR
       persisted.consumer_signing_key_id <> ack_consumer_signing_key_id OR
       persisted.consumer_signature_payload_digest <>
           ack_consumer_signature_payload_digest OR
       persisted.consumer_signature <> ack_consumer_signature THEN
        RAISE EXCEPTION 'conflicting readiness export acknowledgement';
    END IF;
END
$$;

CREATE FUNCTION p2tr_guard_evidence_retention_pin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    generation_state text;
    export_record p2tr_readiness_exports%ROWTYPE;
BEGIN
    SELECT state INTO generation_state
      FROM p2tr_canonical_generations
     WHERE generation_id = NEW.generation_id
     FOR SHARE;
    IF generation_state IS DISTINCT FROM 'committed' THEN
        RAISE EXCEPTION 'retention pin requires a committed generation';
    END IF;
    IF NEW.pin_kind = 'export' THEN
        SELECT * INTO STRICT export_record
          FROM p2tr_readiness_exports
         WHERE export_fence = NEW.export_fence
         FOR SHARE;
        IF export_record.state <> 'sealed' OR
           export_record.pinned_generation <> NEW.generation_id OR
           export_record.expires_at <> NEW.expires_at THEN
            RAISE EXCEPTION 'export retention pin does not match sealed export';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_evidence_retention_pins_guard
BEFORE INSERT ON p2tr_evidence_retention_pins
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_evidence_retention_pin();

CREATE FUNCTION p2tr_create_export_retention_pin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.state = 'building' AND NEW.state = 'sealed' THEN
        INSERT INTO p2tr_evidence_retention_pins (
            pin_digest, generation_id, pin_kind, export_fence, owner_id,
            expires_at
        ) VALUES (
            p2tr_evidence_retention_pin_digest(
                NEW.pinned_generation, 'export', NEW.export_fence,
                NEW.source_store_id, NEW.expires_at
            ),
            NEW.pinned_generation, 'export', NEW.export_fence,
            NEW.source_store_id, NEW.expires_at
        );
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER p2tr_readiness_export_retention_pin
AFTER UPDATE OF state ON p2tr_readiness_exports
FOR EACH ROW EXECUTE FUNCTION p2tr_create_export_retention_pin();

CREATE FUNCTION p2tr_guard_evidence_retention_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    pin p2tr_evidence_retention_pins%ROWTYPE;
    export_is_acknowledged boolean;
BEGIN
    SELECT * INTO STRICT pin
      FROM p2tr_evidence_retention_pins
     WHERE pin_digest = NEW.pin_digest
     FOR SHARE;
    IF pin.pin_kind = 'activation' THEN
        RAISE EXCEPTION 'activation evidence retention pins cannot be released';
    ELSIF pin.expires_at > NEW.released_at THEN
        RAISE EXCEPTION 'evidence retention pin has not expired';
    ELSIF pin.pin_kind = 'export' THEN
        SELECT EXISTS (
            SELECT 1
              FROM p2tr_readiness_export_acknowledgements
             WHERE export_fence = pin.export_fence
        ) INTO export_is_acknowledged;
        IF NOT export_is_acknowledged THEN
            RAISE EXCEPTION 'unacknowledged export pin cannot be released';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_evidence_retention_releases_guard
BEFORE INSERT ON p2tr_evidence_retention_releases
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_evidence_retention_release();

-- An object is collectible only when it is outside the live canonical set,
-- every export that names it is both acknowledged and expired, and no active
-- activation/forensic/export generation pin reaches it. Historical digests
-- remain in temporal manifests so an intentionally expired handle fails
-- explicitly instead of silently resolving to different bytes.
CREATE FUNCTION p2tr_guard_evidence_object_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    is_protected boolean;
BEGIN
    SELECT
        EXISTS (
            SELECT 1
              FROM p2tr_canonical_memberships memberships
             WHERE memberships.object_digest = OLD.object_digest
               AND memberships.valid_to_generation IS NULL
        ) OR EXISTS (
            SELECT 1
              FROM p2tr_canonical_generations generations
             WHERE generations.state = 'committed'
               AND generations.bitcoin_header_object_digest =
                   OLD.object_digest
               AND generations.generation_id = (
                   SELECT max(latest.generation_id)
                     FROM p2tr_canonical_generations latest
                    WHERE latest.state = 'committed'
               )
        ) OR EXISTS (
            SELECT 1
              FROM p2tr_readiness_export_objects exported
              JOIN p2tr_readiness_exports exports USING (export_fence)
             WHERE exported.object_digest = OLD.object_digest
               AND (
                   exports.state = 'building' OR exports.expires_at > now() OR
                   NOT EXISTS (
                       SELECT 1
                         FROM p2tr_readiness_export_acknowledgements ack
                        WHERE ack.export_fence = exports.export_fence
                   )
               )
        ) OR EXISTS (
            SELECT 1
              FROM p2tr_evidence_retention_pins pins
              LEFT JOIN p2tr_evidence_retention_releases releases
                USING (pin_digest)
             WHERE releases.pin_digest IS NULL
               AND (pins.expires_at IS NULL OR pins.expires_at > now())
               AND (
                   EXISTS (
                       SELECT 1
                         FROM p2tr_canonical_memberships memberships
                        WHERE memberships.object_digest = OLD.object_digest
                          AND memberships.valid_from_generation <=
                              pins.generation_id
                          AND (
                              memberships.valid_to_generation IS NULL OR
                              memberships.valid_to_generation >
                                  pins.generation_id
                          )
                   ) OR EXISTS (
                       SELECT 1
                         FROM p2tr_canonical_generations generations
                        WHERE generations.generation_id = pins.generation_id
                          AND generations.bitcoin_header_object_digest =
                              OLD.object_digest
                   )
               )
        )
      INTO is_protected;

    IF is_protected THEN
        RAISE EXCEPTION 'evidence object is reachable from protected state';
    END IF;
    RETURN OLD;
END
$$;

CREATE TRIGGER p2tr_evidence_objects_delete_guard
BEFORE DELETE ON p2tr_evidence_objects
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_evidence_object_delete();

CREATE FUNCTION p2tr_guard_evidence_object_chunk_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'evidence object chunks may only be garbage-collected with their object';
    END IF;
    RETURN OLD;
END
$$;

CREATE TRIGGER p2tr_evidence_object_chunks_delete_guard
BEFORE DELETE ON p2tr_evidence_object_chunks
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_evidence_object_chunk_delete();

CREATE FUNCTION p2tr_guard_evidence_chunk_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM p2tr_evidence_object_chunks
         WHERE chunk_digest = OLD.chunk_digest
    ) THEN
        RAISE EXCEPTION 'evidence chunk is still referenced';
    END IF;
    RETURN OLD;
END
$$;

CREATE TRIGGER p2tr_evidence_chunks_delete_guard
BEFORE DELETE ON p2tr_evidence_chunks
FOR EACH ROW EXECUTE FUNCTION p2tr_guard_evidence_chunk_delete();


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
    payload jsonb NOT NULL CHECK (
        jsonb_typeof(payload) = 'object' AND
        octet_length(convert_to(payload::text, 'UTF8')) <= 60000
    ),
    inserted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    resolved_at timestamptz,
    UNIQUE (ethereum_block_hash, ethereum_log_index)
);

CREATE INDEX p2tr_unmatched_proofs_open_idx
    ON p2tr_unmatched_proofs (ethereum_block_number, ethereum_log_index)
    WHERE resolved_at IS NULL;

CREATE INDEX p2tr_unmatched_proofs_ethereum_point_idx
    ON p2tr_unmatched_proofs (ethereum_block_number, ethereum_block_hash);

CREATE TABLE p2tr_cross_source_watermark (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    bitcoin_height bigint NOT NULL CHECK (bitcoin_height >= 0),
    bitcoin_hash bytea NOT NULL CHECK (octet_length(bitcoin_hash) = 32),
    ethereum_block_number bigint NOT NULL CHECK (ethereum_block_number >= 0),
    ethereum_block_hash bytea NOT NULL
        CHECK (octet_length(ethereum_block_hash) = 32),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- O(1), transaction-locked activation/readiness commitment. Dynamic
-- projection sets use Bitcoin Core's MuHash3072 construction: SHA-256 maps
-- each canonical leaf to a ChaCha20 key, counters 0..5 expand it to a
-- 384-byte little-endian field element, and products are reduced modulo the
-- 3072-bit safe prime 2^3072 - 1103717. Numerator/denominator products make
-- inserts and deletes equally bounded; snapshot finalization performs the
-- single inverse, fixed-width serialization, and final SHA-256.
CREATE FUNCTION p2tr_muhash_modulus()
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT power(2::numeric, 3072) - 1103717
$$;

CREATE FUNCTION p2tr_rotl32(value bigint, bits integer)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT (((value << bits) & 4294967295) |
            (value >> (32 - bits))) & 4294967295
$$;

-- Bitcoin Core's ChaCha20 block function with a zero 96-bit nonce.
CREATE FUNCTION p2tr_chacha20_block(key bytea, counter integer)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
    initial_state bigint[] := ARRAY[
        1634760805, 857760878, 2036477234, 1797285236,
        0, 0, 0, 0, 0, 0, 0, 0,
        counter::bigint, 0, 0, 0
    ];
    state bigint[];
    round_a integer[] := ARRAY[1,2,3,4,1,2,3,4];
    round_b integer[] := ARRAY[5,6,7,8,6,7,8,5];
    round_c integer[] := ARRAY[9,10,11,12,11,12,9,10];
    round_d integer[] := ARRAY[13,14,15,16,16,13,14,15];
    double_round integer;
    quarter_round integer;
    key_word integer;
    byte_index integer;
    a integer;
    b integer;
    c integer;
    d integer;
    word bigint;
    output bytea := decode(repeat('00', 64), 'hex');
BEGIN
    IF octet_length(key) <> 32 OR counter < 0 THEN
        RAISE EXCEPTION 'invalid ChaCha20 key or counter';
    END IF;
    FOR key_word IN 0..7 LOOP
        initial_state[5 + key_word] :=
            get_byte(key, key_word * 4)::bigint +
            get_byte(key, key_word * 4 + 1)::bigint * 256 +
            get_byte(key, key_word * 4 + 2)::bigint * 65536 +
            get_byte(key, key_word * 4 + 3)::bigint * 16777216;
    END LOOP;
    state := initial_state;
    FOR double_round IN 1..10 LOOP
        FOR quarter_round IN 1..8 LOOP
            a := round_a[quarter_round];
            b := round_b[quarter_round];
            c := round_c[quarter_round];
            d := round_d[quarter_round];
            state[a] := (state[a] + state[b]) & 4294967295;
            word := state[d] # state[a];
            state[d] := (((word << 16) & 4294967295) |
                         (word >> 16)) & 4294967295;
            state[c] := (state[c] + state[d]) & 4294967295;
            word := state[b] # state[c];
            state[b] := (((word << 12) & 4294967295) |
                         (word >> 20)) & 4294967295;
            state[a] := (state[a] + state[b]) & 4294967295;
            word := state[d] # state[a];
            state[d] := (((word << 8) & 4294967295) |
                         (word >> 24)) & 4294967295;
            state[c] := (state[c] + state[d]) & 4294967295;
            word := state[b] # state[c];
            state[b] := (((word << 7) & 4294967295) |
                         (word >> 25)) & 4294967295;
        END LOOP;
    END LOOP;
    FOR key_word IN 0..15 LOOP
        word := (state[1 + key_word] + initial_state[1 + key_word]) &
            4294967295;
        FOR byte_index IN 0..3 LOOP
            output := set_byte(
                output,
                key_word * 4 + byte_index,
                ((word >> (byte_index * 8)) & 255)::integer
            );
        END LOOP;
    END LOOP;
    RETURN output;
END
$$;

CREATE FUNCTION p2tr_muhash_data_element(data bytea)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
    key bytea := sha256(data);
    expanded bytea := ''::bytea;
    element numeric := 0;
    factor numeric := 1;
    counter integer;
    byte_index integer;
BEGIN
    FOR counter IN 0..5 LOOP
        expanded := expanded || p2tr_chacha20_block(key, counter);
    END LOOP;
    FOR byte_index IN 0..383 LOOP
        element := element + get_byte(expanded, byte_index) * factor;
        factor := factor * 256;
    END LOOP;
    RETURN element;
END
$$;

CREATE FUNCTION p2tr_muhash_element(table_name text, row_value jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT p2tr_muhash_data_element(convert_to(
        'tbtc-p2tr-muhash3072-leaf-v1' || chr(31) || table_name ||
        chr(31) || row_value::text,
        'UTF8'
    ))
$$;

CREATE FUNCTION p2tr_muhash_multiply(accumulator numeric, element numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
    reduced numeric := mod(accumulator * element, p2tr_muhash_modulus());
BEGIN
    -- Core's field mapping can theoretically yield zero modulo the prime.
    -- It has probability approximately 2^-3072; fail closed instead of
    -- persisting a non-invertible activation commitment if it ever occurs.
    IF reduced = 0 THEN
        RAISE EXCEPTION 'MuHash3072 product is not invertible';
    END IF;
    RETURN reduced;
END
$$;

CREATE FUNCTION p2tr_muhash_to_little_endian(value numeric)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
    remaining numeric := value;
    output bytea := decode(repeat('00', 384), 'hex');
    byte_index integer;
BEGIN
    IF value < 0 OR value >= p2tr_muhash_modulus() THEN
        RAISE EXCEPTION 'MuHash3072 value is outside the field';
    END IF;
    FOR byte_index IN 0..383 LOOP
        output := set_byte(output, byte_index, mod(remaining, 256)::integer);
        remaining := div(remaining, 256);
    END LOOP;
    IF remaining <> 0 THEN
        RAISE EXCEPTION 'MuHash3072 serialization overflow';
    END IF;
    RETURN output;
END
$$;

-- Trigger records cannot be hashed through to_jsonb(record) directly: bytea
-- output follows the session's bytea_output setting and timestamp output can
-- follow TimeZone/DateStyle. Reconstruct every committed row explicitly,
-- round-tripping bytea through its input parser and emitting lowercase hex,
-- casting integers/booleans to their native JSON scalars, retaining JSONB as
-- JSONB, and representing timestamp-backed lifecycle state only as booleans.
-- This makes a leaf independent of the writer connection's GUCs.
CREATE FUNCTION p2tr_jsonb_bytea_hex(row_value jsonb, field_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN row_value->>field_name IS NULL THEN NULL
        ELSE encode((row_value->>field_name)::bytea, 'hex')
    END
$$;

CREATE FUNCTION p2tr_canonical_readiness_row(
    table_name text,
    row_value jsonb,
    semantic boolean
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
    canonical jsonb;
BEGIN
    CASE table_name
    WHEN 'p2tr_complete_authorization_domain' THEN
        canonical := jsonb_build_object(
            'protocol_id', p2tr_jsonb_bytea_hex(row_value, 'protocol_id'),
            'domain_chain_id', (row_value->>'domain_chain_id')::numeric,
            'bridge_address',
                p2tr_jsonb_bytea_hex(row_value, 'bridge_address'),
            'domain_digest',
                p2tr_jsonb_bytea_hex(row_value, 'domain_digest')
        );
    WHEN 'p2tr_watchtower_source_identity' THEN
        canonical := jsonb_build_object(
            'source_store_id', row_value->>'source_store_id',
            'source_cluster_id', row_value->>'source_cluster_id',
            'source_operator_id', row_value->>'source_operator_id',
            'bitcoin_identity_digest', p2tr_jsonb_bytea_hex(
                row_value, 'bitcoin_identity_digest'
            ),
            'ethereum_identity_digest', p2tr_jsonb_bytea_hex(
                row_value, 'ethereum_identity_digest'
            ),
            'source_identity_digest', p2tr_jsonb_bytea_hex(
                row_value, 'source_identity_digest'
            )
        );
    WHEN 'p2tr_frost_wallet_bindings' THEN
        canonical := jsonb_build_object(
            'wallet_id', encode((row_value->>'wallet_id')::bytea, 'hex'),
            'source_event_id', row_value->>'source_event_id',
            'ethereum_block_number',
                (row_value->>'ethereum_block_number')::bigint,
            'ethereum_block_hash',
                encode((row_value->>'ethereum_block_hash')::bytea, 'hex')
        );
    WHEN 'p2tr_pending_deposit_reveals' THEN
        canonical := jsonb_build_object(
            'source_event_id', row_value->>'source_event_id',
            'funding_txid',
                encode((row_value->>'funding_txid')::bytea, 'hex'),
            'funding_vout', (row_value->>'funding_vout')::bigint,
            'wallet_id', encode((row_value->>'wallet_id')::bytea, 'hex'),
            'output_key', encode((row_value->>'output_key')::bytea, 'hex'),
            'ethereum_block_number',
                (row_value->>'ethereum_block_number')::bigint,
            'ethereum_block_hash',
                encode((row_value->>'ethereum_block_hash')::bytea, 'hex'),
            'resolved_funding_height',
                (row_value->>'resolved_funding_height')::bigint,
            'resolved_funding_hash', CASE
                WHEN row_value->>'resolved_funding_hash' IS NULL THEN NULL
                ELSE encode(
                    (row_value->>'resolved_funding_hash')::bytea, 'hex'
                ) END,
            'resolved', row_value->>'resolved_at' IS NOT NULL
        );
        IF semantic THEN
            canonical := canonical - 'resolved';
        END IF;
    WHEN 'p2tr_tracked_outpoints' THEN
        canonical := jsonb_build_object(
            'txid', encode((row_value->>'txid')::bytea, 'hex'),
            'vout', (row_value->>'vout')::bigint,
            'kind', row_value->>'kind',
            'wallet_id', encode((row_value->>'wallet_id')::bytea, 'hex'),
            'output_key', encode((row_value->>'output_key')::bytea, 'hex'),
            'value_sats', (row_value->>'value_sats')::bigint,
            'script_pubkey',
                encode((row_value->>'script_pubkey')::bytea, 'hex'),
            'created_height', (row_value->>'created_height')::bigint,
            'created_hash',
                encode((row_value->>'created_hash')::bytea, 'hex'),
            'source_event_id', row_value->>'source_event_id',
            'spent_by_txid', CASE
                WHEN row_value->>'spent_by_txid' IS NULL THEN NULL
                ELSE encode((row_value->>'spent_by_txid')::bytea, 'hex') END,
            'spent_by_wtxid', CASE
                WHEN row_value->>'spent_by_wtxid' IS NULL THEN NULL
                ELSE encode((row_value->>'spent_by_wtxid')::bytea, 'hex') END,
            'spent_input_index',
                (row_value->>'spent_input_index')::integer,
            'spent_height', (row_value->>'spent_height')::bigint,
            'spent_hash', CASE
                WHEN row_value->>'spent_hash' IS NULL THEN NULL
                ELSE encode((row_value->>'spent_hash')::bytea, 'hex') END
        );
    WHEN 'p2tr_bitcoin_candidates' THEN
        canonical := jsonb_build_object(
            'txid', encode((row_value->>'txid')::bytea, 'hex'),
            'wtxid', encode((row_value->>'wtxid')::bytea, 'hex'),
            'block_height', (row_value->>'block_height')::bigint,
            'block_hash',
                encode((row_value->>'block_hash')::bytea, 'hex'),
            'provenance_generation',
                (row_value->>'provenance_generation')::bigint,
            'provenance_fingerprint',
                encode((row_value->>'provenance_fingerprint')::bytea, 'hex')
        );
        IF semantic THEN
            canonical := canonical - ARRAY[
                'provenance_generation', 'provenance_fingerprint'
            ];
        END IF;
    WHEN 'p2tr_bitcoin_candidate_observations' THEN
        canonical := jsonb_build_object(
            'block_hash', p2tr_jsonb_bytea_hex(row_value, 'block_hash'),
            'txid', p2tr_jsonb_bytea_hex(row_value, 'txid'),
            'wtxid', p2tr_jsonb_bytea_hex(row_value, 'wtxid'),
            'input_index', (row_value->>'input_index')::integer,
            'provenance_generation',
                (row_value->>'provenance_generation')::bigint,
            'provenance_fingerprint', p2tr_jsonb_bytea_hex(
                row_value, 'provenance_fingerprint'
            ),
            'disposition', CASE
                WHEN semantic AND row_value->>'disposition' IN (
                    'keypath_pending', 'keypath_delivered'
                ) THEN 'keypath'
                ELSE row_value->>'disposition' END,
            'protocol_id', p2tr_jsonb_bytea_hex(row_value, 'protocol_id'),
            'domain_chain_id', (row_value->>'domain_chain_id')::numeric,
            'bridge_address',
                p2tr_jsonb_bytea_hex(row_value, 'bridge_address'),
            'domain_digest', p2tr_jsonb_bytea_hex(row_value, 'domain_digest'),
            'challenge_identity',
                p2tr_jsonb_bytea_hex(row_value, 'challenge_identity'),
            'occurrence_id',
                p2tr_jsonb_bytea_hex(row_value, 'occurrence_id'),
            'wallet_id', p2tr_jsonb_bytea_hex(row_value, 'wallet_id'),
            'signing_key', p2tr_jsonb_bytea_hex(row_value, 'signing_key'),
            'output_key', p2tr_jsonb_bytea_hex(row_value, 'output_key'),
            'binding_kind', row_value->>'binding_kind',
            'local_funding_block_hash', p2tr_jsonb_bytea_hex(
                row_value, 'local_funding_block_hash'
            ),
            'local_funding_txid',
                p2tr_jsonb_bytea_hex(row_value, 'local_funding_txid'),
            'local_funding_vout',
                (row_value->>'local_funding_vout')::bigint,
            'local_funding_header_object_digest', p2tr_jsonb_bytea_hex(
                row_value, 'local_funding_header_object_digest'
            ),
            'binding_tx_hash',
                p2tr_jsonb_bytea_hex(row_value, 'binding_tx_hash'),
            'binding_output_index',
                (row_value->>'binding_output_index')::bigint,
            'sighash_type', (row_value->>'sighash_type')::smallint,
            'sighash', p2tr_jsonb_bytea_hex(row_value, 'sighash'),
            'nonce_x', p2tr_jsonb_bytea_hex(row_value, 'nonce_x'),
            'signature_scalar',
                p2tr_jsonb_bytea_hex(row_value, 'signature_scalar'),
            'raw_transaction_digest', p2tr_jsonb_bytea_hex(
                row_value, 'raw_transaction_digest'
            ),
            'raw_transaction_bytes',
                (row_value->>'raw_transaction_bytes')::integer,
            'witness_digest',
                p2tr_jsonb_bytea_hex(row_value, 'witness_digest'),
            'annex_digest', p2tr_jsonb_bytea_hex(row_value, 'annex_digest'),
            'raw_transaction_object_digest', p2tr_jsonb_bytea_hex(
                row_value, 'raw_transaction_object_digest'
            ),
            'prevout_vector_root',
                p2tr_jsonb_bytea_hex(row_value, 'prevout_vector_root'),
            'prevout_count', (row_value->>'prevout_count')::integer,
            'prevout_bytes', (row_value->>'prevout_bytes')::bigint,
            'sha_prevouts', p2tr_jsonb_bytea_hex(row_value, 'sha_prevouts'),
            'sha_amounts', p2tr_jsonb_bytea_hex(row_value, 'sha_amounts'),
            'sha_script_pubkeys',
                p2tr_jsonb_bytea_hex(row_value, 'sha_script_pubkeys'),
            'sha_sequences',
                p2tr_jsonb_bytea_hex(row_value, 'sha_sequences'),
            'sha_outputs', p2tr_jsonb_bytea_hex(row_value, 'sha_outputs'),
            'candidate_block_header_hash', p2tr_jsonb_bytea_hex(
                row_value, 'candidate_block_header_hash'
            ),
            'funding_block_header_hash', p2tr_jsonb_bytea_hex(
                row_value, 'funding_block_header_hash'
            ),
            'refund_leaf_hash',
                p2tr_jsonb_bytea_hex(row_value, 'refund_leaf_hash'),
            'refund_script_digest',
                p2tr_jsonb_bytea_hex(row_value, 'refund_script_digest'),
            'refund_control_block_digest', p2tr_jsonb_bytea_hex(
                row_value, 'refund_control_block_digest'
            ),
            'blocking_reason', row_value->>'blocking_reason',
            'blocking_alert_digest', p2tr_jsonb_bytea_hex(
                row_value, 'blocking_alert_digest'
            )
        );
        IF semantic THEN
            canonical := canonical - ARRAY[
                'provenance_generation', 'provenance_fingerprint',
                'occurrence_id'
            ];
        END IF;
    WHEN 'p2tr_bitcoin_candidate_ethereum_provenance' THEN
        canonical := jsonb_build_object(
            'block_hash',
                encode((row_value->>'block_hash')::bytea, 'hex'),
            'txid', encode((row_value->>'txid')::bytea, 'hex'),
            'wtxid', encode((row_value->>'wtxid')::bytea, 'hex'),
            'input_index', (row_value->>'input_index')::integer,
            'funding_block_hash',
                encode((row_value->>'funding_block_hash')::bytea, 'hex'),
            'funding_txid',
                encode((row_value->>'funding_txid')::bytea, 'hex'),
            'funding_vout', (row_value->>'funding_vout')::bigint,
            'wallet_id', encode((row_value->>'wallet_id')::bytea, 'hex'),
            'output_key', encode((row_value->>'output_key')::bytea, 'hex'),
            'binding_kind', row_value->>'binding_kind',
            'source_event_id', row_value->>'source_event_id',
            'ethereum_block_number',
                (row_value->>'ethereum_block_number')::bigint,
            'ethereum_block_hash',
                encode((row_value->>'ethereum_block_hash')::bytea, 'hex'),
            'provenance_generation',
                (row_value->>'provenance_generation')::bigint
        );
        IF semantic THEN
            canonical := canonical - 'provenance_generation';
        END IF;
    WHEN 'p2tr_invalidated_candidate_provenance' THEN
        canonical := jsonb_build_object(
            -- This append-only ID is the reconciliation page cursor and is
            -- therefore part of the local/operational certificate.
            'invalidation_id', (row_value->>'invalidation_id')::bigint,
            'block_hash',
                encode((row_value->>'block_hash')::bytea, 'hex'),
            'txid', encode((row_value->>'txid')::bytea, 'hex'),
            'wtxid', encode((row_value->>'wtxid')::bytea, 'hex'),
            'provenance_generation',
                (row_value->>'provenance_generation')::bigint,
            'provenance_fingerprint',
                encode((row_value->>'provenance_fingerprint')::bytea, 'hex'),
            'reason', row_value->>'reason',
            'source_event_ids', row_value->'source_event_ids',
            'successor_fingerprint', CASE
                WHEN row_value->>'successor_fingerprint' IS NULL THEN NULL
                ELSE encode(
                    (row_value->>'successor_fingerprint')::bytea, 'hex'
                ) END
        );
    WHEN 'p2tr_unmatched_proofs' THEN
        canonical := jsonb_build_object(
            'event_id', row_value->>'event_id',
            'ethereum_block_number',
                (row_value->>'ethereum_block_number')::bigint,
            'ethereum_block_hash',
                encode((row_value->>'ethereum_block_hash')::bytea, 'hex'),
            'ethereum_transaction_hash', encode(
                (row_value->>'ethereum_transaction_hash')::bytea, 'hex'
            ),
            'ethereum_log_index',
                (row_value->>'ethereum_log_index')::integer,
            'bitcoin_txid',
                encode((row_value->>'bitcoin_txid')::bytea, 'hex'),
            'wallet_id', encode((row_value->>'wallet_id')::bytea, 'hex'),
            'spend_type', row_value->>'spend_type',
            'payload', row_value->'payload',
            'resolved', row_value->>'resolved_at' IS NOT NULL
        );
        IF semantic THEN
            canonical := canonical - 'resolved';
        END IF;
    WHEN 'p2tr_cross_source_watermark' THEN
        canonical := jsonb_build_object(
            'singleton', (row_value->>'singleton')::boolean,
            'bitcoin_height', (row_value->>'bitcoin_height')::bigint,
            'bitcoin_hash',
                encode((row_value->>'bitcoin_hash')::bytea, 'hex'),
            'ethereum_block_number',
                (row_value->>'ethereum_block_number')::bigint,
            'ethereum_block_hash',
                encode((row_value->>'ethereum_block_hash')::bytea, 'hex')
        );
    ELSE
        RAISE EXCEPTION 'unsupported readiness projection table: %', table_name;
    END CASE;
    RETURN canonical;
END
$$;

-- Wallet deletions are the only lifecycle set whose legitimate cardinality is
-- independent of the Bitcoin journal. Cache both domain-separated factors at
-- insert/update time so a maximum-capacity Ethereum rollback performs only
-- field multiplication, not 20,000 PL/pgSQL ChaCha20 expansions.
ALTER TABLE p2tr_frost_wallet_bindings
    ADD COLUMN readiness_operational_leaf numeric NOT NULL,
    ADD COLUMN readiness_semantic_leaf numeric NOT NULL;

CREATE FUNCTION p2tr_cache_frost_wallet_readiness_leaves()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    canonical jsonb;
BEGIN
    canonical := p2tr_canonical_readiness_row(
        'p2tr_frost_wallet_bindings', to_jsonb(NEW), false
    );
    NEW.readiness_operational_leaf := p2tr_muhash_element(
        'p2tr_frost_wallet_bindings', canonical
    );
    NEW.readiness_semantic_leaf := p2tr_muhash_element(
        'p2tr_frost_wallet_bindings:semantic', canonical
    );
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_frost_wallet_cache_readiness_leaves
BEFORE INSERT ON p2tr_frost_wallet_bindings
FOR EACH ROW EXECUTE FUNCTION p2tr_cache_frost_wallet_readiness_leaves();

-- Wallet registrations are append-only Ethereum receipts. Reorg handling
-- deletes orphaned rows and replays their canonical replacements; permitting
-- an in-place identity/source-event rewrite would leave the old temporal
-- membership and source-receipt logical keys without a matching tombstone.
CREATE TRIGGER p2tr_frost_wallet_binding_immutable
BEFORE UPDATE ON p2tr_frost_wallet_bindings
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE FUNCTION p2tr_muhash_inverse(value numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
    modulus numeric := p2tr_muhash_modulus();
    t numeric := 0;
    next_t numeric := 1;
    r numeric := modulus;
    next_r numeric := mod(value, modulus);
    quotient numeric;
    temporary numeric;
BEGIN
    WHILE next_r <> 0 LOOP
        quotient := div(r, next_r);
        temporary := t - quotient * next_t;
        t := next_t;
        next_t := temporary;
        temporary := r - quotient * next_r;
        r := next_r;
        next_r := temporary;
    END LOOP;
    IF r <> 1 THEN
        RAISE EXCEPTION 'MuHash element is not invertible';
    END IF;
    IF t < 0 THEN
        t := t + modulus;
    END IF;
    RETURN t;
END
$$;

CREATE FUNCTION p2tr_muhash_finalize(numerator numeric, denominator numeric)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(p2tr_muhash_to_little_endian(mod(
        numerator * p2tr_muhash_inverse(denominator),
        p2tr_muhash_modulus()
    )))
$$;

CREATE TABLE p2tr_readiness_projection_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    generation bigint NOT NULL CHECK (generation >= 0),
    bitcoin_evidence_root bytea NOT NULL
        CHECK (octet_length(bitcoin_evidence_root) = 32),
    semantic_numerator numeric NOT NULL CHECK (
        semantic_numerator > 0 AND
        semantic_numerator < p2tr_muhash_modulus()
    ),
    semantic_denominator numeric NOT NULL CHECK (
        semantic_denominator > 0 AND
        semantic_denominator < p2tr_muhash_modulus()
    ),
    semantic_row_count bigint NOT NULL CHECK (semantic_row_count >= 0),
    projection_numerator numeric NOT NULL CHECK (
        projection_numerator > 0 AND
        projection_numerator < p2tr_muhash_modulus()
    ),
    projection_denominator numeric NOT NULL CHECK (
        projection_denominator > 0 AND
        projection_denominator < p2tr_muhash_modulus()
    ),
    projection_row_count bigint NOT NULL CHECK (projection_row_count >= 0),
    authorization_domain_count bigint NOT NULL
        CHECK (authorization_domain_count BETWEEN 0 AND 1),
    source_identity_count bigint NOT NULL
        CHECK (source_identity_count BETWEEN 0 AND 1),
    wallet_binding_count bigint NOT NULL CHECK (wallet_binding_count >= 0),
    deposit_reveal_count bigint NOT NULL CHECK (deposit_reveal_count >= 0),
    pending_deposit_reveal_count bigint NOT NULL
        CHECK (pending_deposit_reveal_count >= 0),
    tracked_outpoint_count bigint NOT NULL CHECK (tracked_outpoint_count >= 0),
    candidate_count bigint NOT NULL CHECK (candidate_count >= 0),
    pending_candidate_count bigint NOT NULL
        CHECK (pending_candidate_count >= 0),
    blocking_candidate_input_count bigint NOT NULL
        CHECK (blocking_candidate_input_count >= 0),
    candidate_provenance_count bigint NOT NULL
        CHECK (candidate_provenance_count >= 0),
    invalidation_count bigint NOT NULL CHECK (invalidation_count >= 0),
    unmatched_proof_count bigint NOT NULL CHECK (unmatched_proof_count >= 0),
    pending_unmatched_proof_count bigint NOT NULL
        CHECK (pending_unmatched_proof_count >= 0),
    watermark_count bigint NOT NULL CHECK (watermark_count BETWEEN 0 AND 1),
    pending_deposit_numerator numeric NOT NULL CHECK (
        pending_deposit_numerator > 0 AND
        pending_deposit_numerator < p2tr_muhash_modulus()
    ),
    pending_deposit_denominator numeric NOT NULL CHECK (
        pending_deposit_denominator > 0 AND
        pending_deposit_denominator < p2tr_muhash_modulus()
    ),
    pending_candidate_numerator numeric NOT NULL CHECK (
        pending_candidate_numerator > 0 AND
        pending_candidate_numerator < p2tr_muhash_modulus()
    ),
    pending_candidate_denominator numeric NOT NULL CHECK (
        pending_candidate_denominator > 0 AND
        pending_candidate_denominator < p2tr_muhash_modulus()
    ),
    pending_proof_numerator numeric NOT NULL CHECK (
        pending_proof_numerator > 0 AND
        pending_proof_numerator < p2tr_muhash_modulus()
    ),
    pending_proof_denominator numeric NOT NULL CHECK (
        pending_proof_denominator > 0 AND
        pending_proof_denominator < p2tr_muhash_modulus()
    ),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO p2tr_readiness_projection_state (
    singleton, generation, bitcoin_evidence_root, semantic_numerator,
    semantic_denominator, semantic_row_count, projection_numerator,
    projection_denominator, projection_row_count,
    authorization_domain_count, source_identity_count,
    wallet_binding_count, deposit_reveal_count,
    pending_deposit_reveal_count, tracked_outpoint_count, candidate_count,
    pending_candidate_count, blocking_candidate_input_count,
    candidate_provenance_count, invalidation_count,
    unmatched_proof_count, pending_unmatched_proof_count, watermark_count,
    pending_deposit_numerator, pending_deposit_denominator,
    pending_candidate_numerator, pending_candidate_denominator,
    pending_proof_numerator, pending_proof_denominator
) VALUES (
    true, 0, decode(repeat('00', 32), 'hex'), 1, 1,
    0, 1, 1,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 1, 1
);

CREATE FUNCTION p2tr_touch_readiness_generation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE p2tr_readiness_projection_state
       SET generation = generation + 1,
           updated_at = clock_timestamp()
     WHERE singleton = true;
    RETURN NULL;
END
$$;

CREATE TRIGGER p2tr_provenance_allocator_readiness_generation
AFTER UPDATE ON p2tr_candidate_provenance_generation
FOR EACH ROW EXECUTE FUNCTION p2tr_touch_readiness_generation();

CREATE FUNCTION p2tr_update_readiness_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    old_json jsonb;
    new_json jsonb;
    old_leaf numeric := 1;
    new_leaf numeric := 1;
    old_semantic_leaf numeric := 1;
    new_semantic_leaf numeric := 1;
    old_semantic_present bigint := 0;
    new_semantic_present bigint := 0;
    old_present bigint := 0;
    new_present bigint := 0;
    old_pending_deposit bigint := 0;
    new_pending_deposit bigint := 0;
    old_pending_candidate bigint := 0;
    new_pending_candidate bigint := 0;
    old_blocking_candidate bigint := 0;
    new_blocking_candidate bigint := 0;
    old_pending_proof bigint := 0;
    new_pending_proof bigint := 0;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        old_json := to_jsonb(OLD);
        old_pending_deposit := CASE
            WHEN TG_TABLE_NAME = 'p2tr_pending_deposit_reveals' AND
                 old_json->'resolved_at' = 'null'::jsonb THEN 1 ELSE 0 END;
        old_pending_candidate := CASE
            WHEN TG_TABLE_NAME = 'p2tr_bitcoin_candidate_observations' AND
                 old_json->>'disposition' = 'keypath_pending'
            THEN 1 ELSE 0 END;
        old_blocking_candidate := CASE
            WHEN TG_TABLE_NAME = 'p2tr_bitcoin_candidate_observations' AND
                 old_json->>'disposition' IN (
                     'malformed_blocking', 'ambiguous_blocking'
                 ) THEN 1 ELSE 0 END;
        old_pending_proof := CASE
            WHEN TG_TABLE_NAME = 'p2tr_unmatched_proofs' AND
                 old_json->'resolved_at' = 'null'::jsonb THEN 1 ELSE 0 END;
        IF TG_TABLE_NAME = 'p2tr_frost_wallet_bindings' THEN
            old_leaf := (old_json->>'readiness_operational_leaf')::numeric;
        ELSE
            old_json := p2tr_canonical_readiness_row(
                TG_TABLE_NAME, old_json, false
            );
            old_leaf := p2tr_muhash_element(TG_TABLE_NAME, old_json);
        END IF;
        old_present := 1;
        IF TG_TABLE_NAME NOT IN (
            'p2tr_invalidated_candidate_provenance',
            'p2tr_cross_source_watermark'
        ) THEN
            IF TG_TABLE_NAME = 'p2tr_frost_wallet_bindings' THEN
                old_semantic_leaf :=
                    (to_jsonb(OLD)->>'readiness_semantic_leaf')::numeric;
            ELSE
                old_json := p2tr_canonical_readiness_row(
                    TG_TABLE_NAME, to_jsonb(OLD), true
                );
                old_semantic_leaf := p2tr_muhash_element(
                    TG_TABLE_NAME || ':semantic', old_json
                );
            END IF;
            old_semantic_present := 1;
        END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        new_json := to_jsonb(NEW);
        new_pending_deposit := CASE
            WHEN TG_TABLE_NAME = 'p2tr_pending_deposit_reveals' AND
                 new_json->'resolved_at' = 'null'::jsonb THEN 1 ELSE 0 END;
        new_pending_candidate := CASE
            WHEN TG_TABLE_NAME = 'p2tr_bitcoin_candidate_observations' AND
                 new_json->>'disposition' = 'keypath_pending'
            THEN 1 ELSE 0 END;
        new_blocking_candidate := CASE
            WHEN TG_TABLE_NAME = 'p2tr_bitcoin_candidate_observations' AND
                 new_json->>'disposition' IN (
                     'malformed_blocking', 'ambiguous_blocking'
                 ) THEN 1 ELSE 0 END;
        new_pending_proof := CASE
            WHEN TG_TABLE_NAME = 'p2tr_unmatched_proofs' AND
                 new_json->'resolved_at' = 'null'::jsonb THEN 1 ELSE 0 END;
        IF TG_TABLE_NAME = 'p2tr_frost_wallet_bindings' THEN
            new_leaf := (new_json->>'readiness_operational_leaf')::numeric;
        ELSE
            new_json := p2tr_canonical_readiness_row(
                TG_TABLE_NAME, new_json, false
            );
            new_leaf := p2tr_muhash_element(TG_TABLE_NAME, new_json);
        END IF;
        new_present := 1;
        IF TG_TABLE_NAME NOT IN (
            'p2tr_invalidated_candidate_provenance',
            'p2tr_cross_source_watermark'
        ) THEN
            IF TG_TABLE_NAME = 'p2tr_frost_wallet_bindings' THEN
                new_semantic_leaf :=
                    (to_jsonb(NEW)->>'readiness_semantic_leaf')::numeric;
            ELSE
                new_json := p2tr_canonical_readiness_row(
                    TG_TABLE_NAME, to_jsonb(NEW), true
                );
                new_semantic_leaf := p2tr_muhash_element(
                    TG_TABLE_NAME || ':semantic', new_json
                );
            END IF;
            new_semantic_present := 1;
        END IF;
    END IF;

    UPDATE p2tr_readiness_projection_state
       SET generation = generation + 1,
           semantic_numerator = p2tr_muhash_multiply(
               semantic_numerator, new_semantic_leaf
           ),
           semantic_denominator = p2tr_muhash_multiply(
               semantic_denominator, old_semantic_leaf
           ),
           semantic_row_count = semantic_row_count +
               new_semantic_present - old_semantic_present,
           projection_numerator = p2tr_muhash_multiply(
               projection_numerator, new_leaf
           ),
           projection_denominator = p2tr_muhash_multiply(
               projection_denominator, old_leaf
           ),
           projection_row_count = projection_row_count + new_present - old_present,
           authorization_domain_count = authorization_domain_count +
               CASE WHEN TG_TABLE_NAME = 'p2tr_complete_authorization_domain'
                    THEN new_present - old_present ELSE 0 END,
           source_identity_count = source_identity_count +
               CASE WHEN TG_TABLE_NAME = 'p2tr_watchtower_source_identity'
                    THEN new_present - old_present ELSE 0 END,
           wallet_binding_count = wallet_binding_count +
               CASE WHEN TG_TABLE_NAME = 'p2tr_frost_wallet_bindings'
                    THEN new_present - old_present ELSE 0 END,
           deposit_reveal_count = deposit_reveal_count +
               CASE WHEN TG_TABLE_NAME = 'p2tr_pending_deposit_reveals'
                    THEN new_present - old_present ELSE 0 END,
           pending_deposit_reveal_count = pending_deposit_reveal_count +
               new_pending_deposit - old_pending_deposit,
           tracked_outpoint_count = tracked_outpoint_count +
               CASE WHEN TG_TABLE_NAME = 'p2tr_tracked_outpoints'
                    THEN new_present - old_present ELSE 0 END,
           candidate_count = candidate_count +
               CASE WHEN TG_TABLE_NAME = 'p2tr_bitcoin_candidates'
                    THEN new_present - old_present ELSE 0 END,
           pending_candidate_count = pending_candidate_count +
               new_pending_candidate - old_pending_candidate,
           blocking_candidate_input_count = blocking_candidate_input_count +
               new_blocking_candidate - old_blocking_candidate,
           candidate_provenance_count = candidate_provenance_count +
               CASE WHEN TG_TABLE_NAME =
                          'p2tr_bitcoin_candidate_ethereum_provenance'
                    THEN new_present - old_present ELSE 0 END,
           invalidation_count = invalidation_count +
               CASE WHEN TG_TABLE_NAME =
                          'p2tr_invalidated_candidate_provenance'
                    THEN new_present - old_present ELSE 0 END,
           unmatched_proof_count = unmatched_proof_count +
               CASE WHEN TG_TABLE_NAME = 'p2tr_unmatched_proofs'
                    THEN new_present - old_present ELSE 0 END,
           pending_unmatched_proof_count = pending_unmatched_proof_count +
               new_pending_proof - old_pending_proof,
           watermark_count = watermark_count +
               CASE WHEN TG_TABLE_NAME = 'p2tr_cross_source_watermark'
                    THEN new_present - old_present ELSE 0 END,
           pending_deposit_numerator = p2tr_muhash_multiply(
               pending_deposit_numerator,
               CASE WHEN new_pending_deposit = 1 THEN new_leaf ELSE 1 END
           ),
           pending_deposit_denominator = p2tr_muhash_multiply(
               pending_deposit_denominator,
               CASE WHEN old_pending_deposit = 1 THEN old_leaf ELSE 1 END
           ),
           pending_candidate_numerator = p2tr_muhash_multiply(
               pending_candidate_numerator,
               CASE WHEN new_pending_candidate = 1 THEN new_leaf ELSE 1 END
           ),
           pending_candidate_denominator = p2tr_muhash_multiply(
               pending_candidate_denominator,
               CASE WHEN old_pending_candidate = 1 THEN old_leaf ELSE 1 END
           ),
           pending_proof_numerator = p2tr_muhash_multiply(
               pending_proof_numerator,
               CASE WHEN new_pending_proof = 1 THEN new_leaf ELSE 1 END
           ),
           pending_proof_denominator = p2tr_muhash_multiply(
               pending_proof_denominator,
               CASE WHEN old_pending_proof = 1 THEN old_leaf ELSE 1 END
           ),
           updated_at = clock_timestamp()
     WHERE singleton = true;
    RETURN NULL;
END
$$;

-- Wallet lifecycle rollback can legitimately delete the complete configured
-- registry in one statement. Accumulate the old factors from the transition
-- table and touch the singleton once, instead of serially rewriting it for
-- every deleted wallet. Leaf mapping remains identical to the row trigger.
CREATE FUNCTION p2tr_delete_wallet_readiness_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    row_record record;
    deleted_count bigint := 0;
    semantic_product numeric := 1;
    projection_product numeric := 1;
BEGIN
    FOR row_record IN SELECT * FROM deleted_wallets LOOP
        projection_product := p2tr_muhash_multiply(
            projection_product,
            row_record.readiness_operational_leaf
        );
        semantic_product := p2tr_muhash_multiply(
            semantic_product,
            row_record.readiness_semantic_leaf
        );
        deleted_count := deleted_count + 1;
    END LOOP;
    IF deleted_count = 0 THEN
        RETURN NULL;
    END IF;
    UPDATE p2tr_readiness_projection_state
       SET generation = generation + 1,
           semantic_denominator = p2tr_muhash_multiply(
               semantic_denominator, semantic_product
           ),
           semantic_row_count = semantic_row_count - deleted_count,
           projection_denominator = p2tr_muhash_multiply(
               projection_denominator, projection_product
           ),
           projection_row_count = projection_row_count - deleted_count,
           wallet_binding_count = wallet_binding_count - deleted_count,
           updated_at = clock_timestamp()
     WHERE singleton = true;
    RETURN NULL;
END
$$;

-- A historical backfill can register the complete wallet inventory in one
-- statement. Fold its already-cached MuHash factors and update the singleton
-- projection once so cost stays linear without serially rewriting one row for
-- every wallet. The transition relation contains only rows actually inserted
-- (including under ON CONFLICT DO NOTHING).
CREATE FUNCTION p2tr_insert_wallet_readiness_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    row_record record;
    inserted_count bigint := 0;
    semantic_product numeric := 1;
    projection_product numeric := 1;
BEGIN
    FOR row_record IN SELECT * FROM inserted_wallets LOOP
        projection_product := p2tr_muhash_multiply(
            projection_product,
            row_record.readiness_operational_leaf
        );
        semantic_product := p2tr_muhash_multiply(
            semantic_product,
            row_record.readiness_semantic_leaf
        );
        inserted_count := inserted_count + 1;
    END LOOP;
    IF inserted_count = 0 THEN
        RETURN NULL;
    END IF;
    UPDATE p2tr_readiness_projection_state
       SET generation = generation + 1,
           semantic_numerator = p2tr_muhash_multiply(
               semantic_numerator, semantic_product
           ),
           semantic_row_count = semantic_row_count + inserted_count,
           projection_numerator = p2tr_muhash_multiply(
               projection_numerator, projection_product
           ),
           projection_row_count = projection_row_count + inserted_count,
           wallet_binding_count = wallet_binding_count + inserted_count,
           updated_at = clock_timestamp()
     WHERE singleton = true;
    RETURN NULL;
END
$$;

CREATE TRIGGER p2tr_frost_wallet_insert_readiness_projection
AFTER INSERT ON p2tr_frost_wallet_bindings
REFERENCING NEW TABLE AS inserted_wallets
FOR EACH STATEMENT EXECUTE FUNCTION p2tr_insert_wallet_readiness_projection();
CREATE TRIGGER p2tr_complete_domain_readiness_projection
AFTER INSERT ON p2tr_complete_authorization_domain
FOR EACH ROW EXECUTE FUNCTION p2tr_update_readiness_projection();
CREATE TRIGGER p2tr_source_identity_readiness_projection
AFTER INSERT ON p2tr_watchtower_source_identity
FOR EACH ROW EXECUTE FUNCTION p2tr_update_readiness_projection();
CREATE TRIGGER p2tr_frost_wallet_delete_readiness_projection
AFTER DELETE ON p2tr_frost_wallet_bindings
REFERENCING OLD TABLE AS deleted_wallets
FOR EACH STATEMENT EXECUTE FUNCTION p2tr_delete_wallet_readiness_projection();
CREATE TRIGGER p2tr_deposit_readiness_projection
AFTER INSERT OR UPDATE OR DELETE ON p2tr_pending_deposit_reveals
FOR EACH ROW EXECUTE FUNCTION p2tr_update_readiness_projection();
CREATE TRIGGER p2tr_tracked_readiness_projection
AFTER INSERT OR UPDATE OR DELETE ON p2tr_tracked_outpoints
FOR EACH ROW EXECUTE FUNCTION p2tr_update_readiness_projection();
CREATE TRIGGER p2tr_candidate_readiness_projection
AFTER INSERT OR UPDATE OR DELETE ON p2tr_bitcoin_candidates
FOR EACH ROW EXECUTE FUNCTION p2tr_update_readiness_projection();
CREATE TRIGGER p2tr_candidate_observation_readiness_projection
AFTER INSERT OR UPDATE OR DELETE ON p2tr_bitcoin_candidate_observations
FOR EACH ROW EXECUTE FUNCTION p2tr_update_readiness_projection();
CREATE TRIGGER p2tr_candidate_provenance_readiness_projection
AFTER INSERT OR UPDATE OR DELETE ON p2tr_bitcoin_candidate_ethereum_provenance
FOR EACH ROW EXECUTE FUNCTION p2tr_update_readiness_projection();
CREATE TRIGGER p2tr_invalidation_readiness_projection
AFTER INSERT OR UPDATE OR DELETE ON p2tr_invalidated_candidate_provenance
FOR EACH ROW EXECUTE FUNCTION p2tr_update_readiness_projection();
CREATE TRIGGER p2tr_proof_readiness_projection
AFTER INSERT OR UPDATE OR DELETE ON p2tr_unmatched_proofs
FOR EACH ROW EXECUTE FUNCTION p2tr_update_readiness_projection();
CREATE TRIGGER p2tr_watermark_readiness_projection
AFTER INSERT OR UPDATE OR DELETE ON p2tr_cross_source_watermark
FOR EACH ROW EXECUTE FUNCTION p2tr_update_readiness_projection();

-- Trigger-backed temporal evidence journal. Every readiness-relevant row
-- mutation and every linked Bitcoin evidence object enters one locked epoch.
-- The sealing procedure below reduces the final change per logical key into
-- temporal memberships, records consumption of every journal record, computes
-- all roots inside the same transaction, and only then commits the generation.
CREATE TABLE p2tr_canonical_change_journal_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    current_epoch bigint NOT NULL UNIQUE CHECK (current_epoch > 0),
    building_generation_id bigint UNIQUE,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (building_generation_id)
        REFERENCES p2tr_canonical_generations (generation_id)
);

INSERT INTO p2tr_canonical_change_journal_state (
    singleton, current_epoch, building_generation_id
) VALUES (true, 1, NULL);

CREATE FUNCTION p2tr_canonical_membership_change_digest(
    journal_epoch bigint,
    source_table text,
    operation text,
    namespace text,
    logical_key_digest bytea,
    object_digest bytea,
    object_kind text
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to(
            'tbtc-p2tr-canonical-membership-change-v1' || chr(31) ||
            source_table || chr(31) || operation || chr(31) || namespace ||
            chr(31) || coalesce(object_kind, ''),
            'UTF8'
        ) || int8send(journal_epoch) || logical_key_digest ||
        coalesce(object_digest, decode(repeat('00', 32), 'hex'))
    )
$$;

CREATE TABLE p2tr_canonical_membership_change_journal (
    change_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
        CHECK (change_id > 0),
    journal_epoch bigint NOT NULL CHECK (journal_epoch > 0),
    source_table text NOT NULL CHECK (length(source_table) BETWEEN 1 AND 63),
    operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
    namespace text NOT NULL CHECK (namespace IN (
        'authorization_domain',
        'watchtower_source_identity',
        'frost_wallet_binding',
        'pending_deposit_reveal',
        'tracked_outpoint',
        'bitcoin_candidate',
        'complete_input_disposition',
        'ethereum_provenance',
        'invalidation',
        'unmatched_proof',
        'cross_source_watermark',
        'bitcoin_header80',
        'bitcoin_raw_block',
        'bitcoin_raw_transaction',
        'bitcoin_prevout_script',
        'source_receipt',
        'canonical_projection_row'
    )),
    logical_key_digest bytea NOT NULL
        CHECK (octet_length(logical_key_digest) = 32),
    object_digest bytea CHECK (
        object_digest IS NULL OR octet_length(object_digest) = 32
    ),
    object_kind text CHECK (
        object_kind IS NULL OR
        object_kind ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    ),
    change_digest bytea NOT NULL
        CHECK (octet_length(change_digest) = 32),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (operation = 'upsert' AND object_digest IS NOT NULL AND
         object_kind IS NOT NULL) OR
        (operation = 'delete' AND object_digest IS NULL AND
         object_kind IS NULL)
    ),
    CHECK (
        change_digest = p2tr_canonical_membership_change_digest(
            journal_epoch, source_table, operation, namespace,
            logical_key_digest, object_digest, object_kind
        )
    ),
    UNIQUE (change_id, change_digest)
);

CREATE INDEX p2tr_membership_change_journal_epoch_idx
    ON p2tr_canonical_membership_change_journal
       (journal_epoch, namespace, logical_key_digest, change_id DESC);

CREATE TRIGGER p2tr_membership_change_journal_immutable
BEFORE UPDATE OR DELETE ON p2tr_canonical_membership_change_journal
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE FUNCTION p2tr_membership_change_consumption_digest(
    generation_id bigint,
    change_id bigint,
    change_digest bytea
)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT sha256(
        convert_to('tbtc-p2tr-membership-change-consumption-v1', 'UTF8') ||
        int8send(generation_id) || int8send(change_id) || change_digest
    )
$$;

CREATE TABLE p2tr_canonical_membership_change_consumptions (
    change_id bigint PRIMARY KEY CHECK (change_id > 0),
    generation_id bigint NOT NULL CHECK (generation_id > 0),
    change_digest bytea NOT NULL CHECK (octet_length(change_digest) = 32),
    consumption_digest bytea NOT NULL UNIQUE
        CHECK (octet_length(consumption_digest) = 32),
    consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (change_id, change_digest)
        REFERENCES p2tr_canonical_membership_change_journal
            (change_id, change_digest),
    FOREIGN KEY (generation_id)
        REFERENCES p2tr_canonical_generations (generation_id),
    CHECK (
        consumption_digest = p2tr_membership_change_consumption_digest(
            generation_id, change_id, change_digest
        )
    )
);

CREATE TRIGGER p2tr_membership_change_consumptions_immutable
BEFORE UPDATE OR DELETE ON p2tr_canonical_membership_change_consumptions
FOR EACH ROW EXECUTE FUNCTION p2tr_reject_immutable_update();

CREATE FUNCTION p2tr_store_single_chunk_evidence_object(
    stored_object_kind text,
    stored_bytes bytea
)
RETURNS bytea
LANGUAGE plpgsql
AS $$
DECLARE
    stored_chunk_digest bytea;
    stored_leaf_digest bytea;
    stored_manifest_root bytea;
    stored_content_digest bytea;
    stored_object_digest bytea;
BEGIN
    IF stored_object_kind !~ '^[a-z0-9][a-z0-9_-]{0,63}$' OR
       octet_length(stored_bytes) > 65536 THEN
        RAISE EXCEPTION 'invalid bounded single-chunk evidence object';
    END IF;
    stored_chunk_digest := p2tr_evidence_chunk_digest(stored_bytes);
    stored_leaf_digest := p2tr_evidence_chunk_leaf_digest(
        0, 0, stored_chunk_digest
    );
    stored_manifest_root := sha256(stored_leaf_digest);
    stored_content_digest := sha256(stored_bytes);
    stored_object_digest := p2tr_evidence_object_digest(
        stored_object_kind, octet_length(stored_bytes), 1,
        stored_content_digest, stored_manifest_root
    );

    INSERT INTO p2tr_evidence_chunks (chunk_digest, chunk_bytes)
    VALUES (stored_chunk_digest, stored_bytes)
    ON CONFLICT (chunk_digest) DO NOTHING;
    INSERT INTO p2tr_evidence_objects (
        object_digest, object_kind, byte_length, chunk_count,
        content_digest, chunk_manifest_root
    ) VALUES (
        stored_object_digest, stored_object_kind,
        octet_length(stored_bytes), 1, stored_content_digest,
        stored_manifest_root
    ) ON CONFLICT (object_digest) DO NOTHING;
    INSERT INTO p2tr_evidence_object_chunks (
        object_digest, chunk_index, byte_offset, chunk_digest, leaf_digest
    ) VALUES (
        stored_object_digest, 0, 0, stored_chunk_digest, stored_leaf_digest
    ) ON CONFLICT (object_digest, chunk_index) DO NOTHING;

    IF NOT p2tr_evidence_object_is_complete(stored_object_digest) THEN
        RAISE EXCEPTION 'content-addressed evidence collision or corruption';
    END IF;
    RETURN stored_object_digest;
END
$$;

CREATE FUNCTION p2tr_readiness_table_namespace(table_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT CASE table_name
        WHEN 'p2tr_complete_authorization_domain' THEN 'authorization_domain'
        WHEN 'p2tr_watchtower_source_identity' THEN 'watchtower_source_identity'
        WHEN 'p2tr_frost_wallet_bindings' THEN 'frost_wallet_binding'
        WHEN 'p2tr_pending_deposit_reveals' THEN 'pending_deposit_reveal'
        WHEN 'p2tr_tracked_outpoints' THEN 'tracked_outpoint'
        WHEN 'p2tr_bitcoin_candidates' THEN 'bitcoin_candidate'
        WHEN 'p2tr_bitcoin_candidate_observations' THEN
            'complete_input_disposition'
        WHEN 'p2tr_bitcoin_candidate_ethereum_provenance' THEN
            'ethereum_provenance'
        WHEN 'p2tr_invalidated_candidate_provenance' THEN 'invalidation'
        WHEN 'p2tr_unmatched_proofs' THEN 'unmatched_proof'
        WHEN 'p2tr_cross_source_watermark' THEN 'cross_source_watermark'
        ELSE NULL
    END
$$;

CREATE FUNCTION p2tr_set_candidate_disposition_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    canonical_row jsonb;
    calculated_object_digest bytea;
BEGIN
    canonical_row := p2tr_canonical_readiness_row(
        'p2tr_bitcoin_candidate_observations', to_jsonb(NEW), false
    );
    calculated_object_digest := p2tr_store_single_chunk_evidence_object(
        'complete_input_disposition',
        convert_to(canonical_row::text, 'UTF8')
    );
    IF NEW.disposition_evidence_object_digest IS NOT NULL AND
       NEW.disposition_evidence_object_digest <> calculated_object_digest THEN
        RAISE EXCEPTION 'candidate disposition evidence digest mismatch';
    END IF;
    NEW.disposition_evidence_object_digest := calculated_object_digest;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_candidate_input_disposition_evidence
BEFORE INSERT OR UPDATE ON p2tr_bitcoin_candidate_observations
FOR EACH ROW EXECUTE FUNCTION p2tr_set_candidate_disposition_evidence();

CREATE FUNCTION p2tr_readiness_row_logical_key_digest(
    table_name text,
    row_value jsonb
)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
    namespace text := p2tr_readiness_table_namespace(table_name);
    canonical_key bytea;
BEGIN
    CASE table_name
    WHEN 'p2tr_complete_authorization_domain',
         'p2tr_watchtower_source_identity',
         'p2tr_cross_source_watermark' THEN
        canonical_key := convert_to('singleton', 'UTF8');
    WHEN 'p2tr_frost_wallet_bindings' THEN
        canonical_key := (row_value->>'wallet_id')::bytea;
    WHEN 'p2tr_pending_deposit_reveals' THEN
        canonical_key := convert_to(row_value->>'source_event_id', 'UTF8');
    WHEN 'p2tr_tracked_outpoints' THEN
        canonical_key := (row_value->>'txid')::bytea || substring(
            p2tr_uint256_big_endian((row_value->>'vout')::numeric)
            FROM 29 FOR 4
        );
    WHEN 'p2tr_bitcoin_candidates' THEN
        canonical_key := (row_value->>'block_hash')::bytea ||
            (row_value->>'txid')::bytea || (row_value->>'wtxid')::bytea;
    WHEN 'p2tr_bitcoin_candidate_observations',
         'p2tr_bitcoin_candidate_ethereum_provenance' THEN
        canonical_key := (row_value->>'block_hash')::bytea ||
            (row_value->>'txid')::bytea || (row_value->>'wtxid')::bytea ||
            substring(p2tr_uint256_big_endian(
                (row_value->>'input_index')::numeric
            ) FROM 29 FOR 4);
    WHEN 'p2tr_invalidated_candidate_provenance' THEN
        canonical_key := int8send((row_value->>'invalidation_id')::bigint);
    WHEN 'p2tr_unmatched_proofs' THEN
        canonical_key := convert_to(row_value->>'event_id', 'UTF8');
    ELSE
        RAISE EXCEPTION 'unsupported readiness journal table %', table_name;
    END CASE;
    RETURN p2tr_canonical_logical_key_digest(namespace, canonical_key);
END
$$;

CREATE FUNCTION p2tr_append_canonical_membership_change(
    change_source_table text,
    change_operation text,
    change_namespace text,
    change_logical_key_digest bytea,
    change_object_digest bytea,
    change_object_kind text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    target_epoch bigint;
BEGIN
    SELECT current_epoch INTO STRICT target_epoch
      FROM p2tr_canonical_change_journal_state
     WHERE singleton = true
     FOR SHARE;
    INSERT INTO p2tr_canonical_membership_change_journal (
        journal_epoch, source_table, operation, namespace,
        logical_key_digest, object_digest, object_kind, change_digest
    ) VALUES (
        target_epoch, change_source_table, change_operation, change_namespace,
        change_logical_key_digest, change_object_digest, change_object_kind,
        p2tr_canonical_membership_change_digest(
            target_epoch, change_source_table, change_operation,
            change_namespace, change_logical_key_digest,
            change_object_digest, change_object_kind
        )
    );
END
$$;

CREATE FUNCTION p2tr_record_readiness_membership_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    row_json jsonb;
    canonical_row jsonb;
    namespace text := p2tr_readiness_table_namespace(TG_TABLE_NAME);
    logical_key_digest bytea;
    object_kind text;
    object_digest bytea;
    operation text;
    source_event_id text;
    source_receipt_key bytea;
BEGIN
    IF TG_OP = 'DELETE' THEN
        row_json := to_jsonb(OLD);
        operation := 'delete';
    ELSE
        row_json := to_jsonb(NEW);
        operation := 'upsert';
    END IF;
    logical_key_digest := p2tr_readiness_row_logical_key_digest(
        TG_TABLE_NAME, row_json
    );
    IF operation = 'upsert' THEN
        canonical_row := p2tr_canonical_readiness_row(
            TG_TABLE_NAME, row_json, false
        );
        object_kind := CASE
            WHEN TG_TABLE_NAME = 'p2tr_bitcoin_candidate_observations'
                THEN 'complete_input_disposition'
            WHEN TG_TABLE_NAME IN (
                'p2tr_frost_wallet_bindings',
                'p2tr_pending_deposit_reveals',
                'p2tr_bitcoin_candidate_ethereum_provenance',
                'p2tr_unmatched_proofs'
            ) THEN 'source_receipt'
            ELSE 'canonical_projection_row'
        END;
        object_digest := p2tr_store_single_chunk_evidence_object(
            object_kind, convert_to(canonical_row::text, 'UTF8')
        );
    END IF;
    PERFORM p2tr_append_canonical_membership_change(
        TG_TABLE_NAME, operation, namespace, logical_key_digest,
        object_digest, object_kind
    );

    source_event_id := CASE TG_TABLE_NAME
        WHEN 'p2tr_frost_wallet_bindings' THEN row_json->>'source_event_id'
        WHEN 'p2tr_pending_deposit_reveals' THEN row_json->>'source_event_id'
        WHEN 'p2tr_bitcoin_candidate_ethereum_provenance' THEN
            row_json->>'source_event_id'
        WHEN 'p2tr_unmatched_proofs' THEN row_json->>'event_id'
        ELSE NULL
    END;
    IF source_event_id IS NOT NULL THEN
        source_receipt_key := p2tr_canonical_logical_key_digest(
            'source_receipt', convert_to(source_event_id, 'UTF8')
        );
        PERFORM p2tr_append_canonical_membership_change(
            TG_TABLE_NAME, operation, 'source_receipt', source_receipt_key,
            object_digest, object_kind
        );
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER p2tr_complete_domain_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_complete_authorization_domain
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();
CREATE TRIGGER p2tr_source_identity_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_watchtower_source_identity
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();
CREATE TRIGGER p2tr_frost_wallet_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_frost_wallet_bindings
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();
CREATE TRIGGER p2tr_deposit_reveal_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_pending_deposit_reveals
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();
CREATE TRIGGER p2tr_tracked_outpoint_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_tracked_outpoints
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();
CREATE TRIGGER p2tr_candidate_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_bitcoin_candidates
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();
CREATE TRIGGER p2tr_candidate_disposition_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_bitcoin_candidate_observations
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();
CREATE TRIGGER p2tr_ethereum_provenance_membership_journal
AFTER INSERT OR UPDATE OR DELETE
ON p2tr_bitcoin_candidate_ethereum_provenance
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();
CREATE TRIGGER p2tr_invalidation_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_invalidated_candidate_provenance
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();
CREATE TRIGGER p2tr_unmatched_proof_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_unmatched_proofs
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();
CREATE TRIGGER p2tr_watermark_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_cross_source_watermark
FOR EACH ROW EXECUTE FUNCTION p2tr_record_readiness_membership_change();

CREATE FUNCTION p2tr_record_linked_bitcoin_evidence_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    row_json jsonb := CASE WHEN TG_OP = 'DELETE'
        THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    operation text := CASE WHEN TG_OP = 'DELETE'
        THEN 'delete' ELSE 'upsert' END;
    key_digest bytea;
    object_digest bytea;
    object_kind text;
BEGIN
    IF TG_TABLE_NAME = 'p2tr_bitcoin_blocks' THEN
        key_digest := p2tr_bitcoin_block_logical_key_digest(
            'bitcoin_header80', (row_json->>'height')::bigint,
            (row_json->>'hash')::bytea
        );
        PERFORM p2tr_append_canonical_membership_change(
            TG_TABLE_NAME, operation, 'bitcoin_header80', key_digest,
            CASE WHEN operation = 'upsert'
                THEN (row_json->>'header_object_digest')::bytea ELSE NULL END,
            CASE WHEN operation = 'upsert' THEN 'bitcoin_header80' ELSE NULL END
        );
        key_digest := p2tr_bitcoin_block_logical_key_digest(
            'bitcoin_raw_block', (row_json->>'height')::bigint,
            (row_json->>'hash')::bytea
        );
        PERFORM p2tr_append_canonical_membership_change(
            TG_TABLE_NAME, operation, 'bitcoin_raw_block', key_digest,
            CASE WHEN operation = 'upsert'
                THEN (row_json->>'raw_block_object_digest')::bytea ELSE NULL END,
            CASE WHEN operation = 'upsert' THEN 'bitcoin_raw_block' ELSE NULL END
        );
    ELSIF TG_TABLE_NAME = 'p2tr_bitcoin_transactions' THEN
        key_digest := p2tr_bitcoin_transaction_logical_key_digest(
            (row_json->>'block_hash')::bytea,
            (row_json->>'txid')::bytea,
            (row_json->>'wtxid')::bytea
        );
        PERFORM p2tr_append_canonical_membership_change(
            TG_TABLE_NAME, operation, 'bitcoin_raw_transaction', key_digest,
            CASE WHEN operation = 'upsert' THEN
                (row_json->>'raw_transaction_object_digest')::bytea
                ELSE NULL END,
            CASE WHEN operation = 'upsert'
                THEN 'bitcoin_raw_transaction' ELSE NULL END
        );
    ELSIF TG_TABLE_NAME = 'p2tr_bitcoin_outputs' THEN
        key_digest := p2tr_bitcoin_outpoint_logical_key_digest(
            'bitcoin_prevout_script', (row_json->>'block_hash')::bytea,
            (row_json->>'txid')::bytea, (row_json->>'vout')::bigint
        );
        IF operation = 'upsert' THEN
            object_kind := 'bitcoin_prevout_script';
            object_digest := p2tr_store_single_chunk_evidence_object(
                object_kind, (row_json->>'script_pubkey')::bytea
            );
        END IF;
        PERFORM p2tr_append_canonical_membership_change(
            TG_TABLE_NAME, operation, 'bitcoin_prevout_script', key_digest,
            object_digest, object_kind
        );
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER p2tr_bitcoin_block_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_bitcoin_blocks
FOR EACH ROW EXECUTE FUNCTION p2tr_record_linked_bitcoin_evidence_change();
CREATE TRIGGER p2tr_bitcoin_transaction_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_bitcoin_transactions
FOR EACH ROW EXECUTE FUNCTION p2tr_record_linked_bitcoin_evidence_change();
CREATE TRIGGER p2tr_bitcoin_output_membership_journal
AFTER INSERT OR UPDATE OR DELETE ON p2tr_bitcoin_outputs
FOR EACH ROW EXECUTE FUNCTION p2tr_record_linked_bitcoin_evidence_change();

CREATE FUNCTION p2tr_begin_canonical_generation(
    configured_domain_digest bytea,
    target_bitcoin_height bigint,
    target_bitcoin_hash bytea,
    target_bitcoin_header_object_digest bytea,
    target_ethereum_block_number bigint,
    target_ethereum_block_hash bytea,
    target_bitcoin_chain_root bytea,
    target_projection_root bytea,
    target_semantic_root bytea
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    journal_state p2tr_canonical_change_journal_state%ROWTYPE;
    parent_generation bigint;
    parent_manifest bytea;
    created_generation bigint;
BEGIN
    SELECT * INTO STRICT journal_state
      FROM p2tr_canonical_change_journal_state
     WHERE singleton = true
     FOR UPDATE;
    IF journal_state.building_generation_id IS NOT NULL THEN
        RAISE EXCEPTION 'a canonical generation is already building';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM p2tr_complete_authorization_domain
         WHERE domain_digest = configured_domain_digest
    ) OR NOT EXISTS (
        SELECT 1 FROM p2tr_watchtower_source_identity
    ) THEN
        RAISE EXCEPTION 'domain and source identity must be persisted first';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM p2tr_bitcoin_blocks
         WHERE height = target_bitcoin_height
           AND hash = target_bitcoin_hash
           AND header_object_digest =
               target_bitcoin_header_object_digest
           AND chain_commitment = target_bitcoin_chain_root
    ) THEN
        RAISE EXCEPTION 'generation Bitcoin point is not canonical evidence';
    END IF;
    SELECT generation_id, manifest_digest
      INTO parent_generation, parent_manifest
      FROM p2tr_canonical_generations
     WHERE state = 'committed'
     ORDER BY generation_id DESC
     LIMIT 1
     FOR SHARE;

    INSERT INTO p2tr_canonical_generations (
        journal_epoch, parent_generation_id, parent_manifest_digest,
        domain_digest, bitcoin_height, bitcoin_hash,
        bitcoin_header_object_digest, ethereum_block_number,
        ethereum_block_hash, bitcoin_chain_root, projection_root,
        semantic_root
    ) VALUES (
        journal_state.current_epoch, parent_generation, parent_manifest,
        configured_domain_digest, target_bitcoin_height, target_bitcoin_hash,
        target_bitcoin_header_object_digest, target_ethereum_block_number,
        target_ethereum_block_hash, target_bitcoin_chain_root,
        target_projection_root, target_semantic_root
    ) RETURNING generation_id INTO created_generation;

    UPDATE p2tr_canonical_change_journal_state
       SET building_generation_id = created_generation,
           updated_at = clock_timestamp()
     WHERE singleton = true;
    RETURN created_generation;
END
$$;

CREATE FUNCTION p2tr_seal_canonical_generation(target_generation bigint)
RETURNS bytea
LANGUAGE plpgsql
AS $$
DECLARE
    journal_state p2tr_canonical_change_journal_state%ROWTYPE;
    generation p2tr_canonical_generations%ROWTYPE;
    final_change record;
    active_membership p2tr_canonical_memberships%ROWTYPE;
    calculated_membership_root bytea;
    calculated_transition_root bytea;
    calculated_source_receipt_root bytea;
    calculated_disposition_root bytea;
    measured_count bigint;
    measured_bytes bigint;
    calculated_manifest bytea;
    actual_projection_root bytea;
    actual_semantic_root bytea;
BEGIN
    SELECT * INTO STRICT journal_state
      FROM p2tr_canonical_change_journal_state
     WHERE singleton = true
     FOR UPDATE;
    SELECT * INTO STRICT generation
      FROM p2tr_canonical_generations
     WHERE generation_id = target_generation
     FOR UPDATE;
    IF generation.state <> 'building' OR
       journal_state.building_generation_id <> target_generation OR
       generation.journal_epoch <> journal_state.current_epoch THEN
        RAISE EXCEPTION 'generation is not the active journal consumer';
    END IF;
    SELECT
        p2tr_muhash_finalize(projection_numerator, projection_denominator),
        p2tr_muhash_finalize(semantic_numerator, semantic_denominator)
      INTO actual_projection_root, actual_semantic_root
      FROM p2tr_readiness_projection_state
     WHERE singleton = true
     FOR SHARE;
    IF actual_projection_root <> generation.projection_root OR
       actual_semantic_root <> generation.semantic_root THEN
        RAISE EXCEPTION 'generation readiness projection changed before seal';
    END IF;

    FOR final_change IN
        SELECT DISTINCT ON (namespace, logical_key_digest)
               namespace, logical_key_digest, operation,
               object_digest, object_kind
          FROM p2tr_canonical_membership_change_journal
         WHERE journal_epoch = generation.journal_epoch
         ORDER BY namespace, logical_key_digest, change_id DESC
    LOOP
        SELECT * INTO active_membership
          FROM p2tr_canonical_memberships
         WHERE namespace = final_change.namespace
           AND logical_key_digest = final_change.logical_key_digest
           AND valid_to_generation IS NULL
         FOR UPDATE;

        IF FOUND AND (
            final_change.operation = 'delete' OR
            active_membership.object_digest <> final_change.object_digest OR
            active_membership.object_kind <> final_change.object_kind
        ) THEN
            UPDATE p2tr_canonical_memberships
               SET valid_to_generation = target_generation,
                   closed_at = clock_timestamp()
             WHERE namespace = active_membership.namespace
               AND logical_key_digest = active_membership.logical_key_digest
               AND valid_from_generation =
                   active_membership.valid_from_generation;
        END IF;

        IF final_change.operation = 'upsert' AND (
            NOT FOUND OR active_membership.object_digest <>
                final_change.object_digest OR
            active_membership.object_kind <> final_change.object_kind
        ) THEN
            INSERT INTO p2tr_canonical_memberships (
                namespace, logical_key_digest, object_digest, object_kind,
                valid_from_generation, membership_digest
            ) VALUES (
                final_change.namespace, final_change.logical_key_digest,
                final_change.object_digest, final_change.object_kind,
                target_generation, p2tr_canonical_membership_digest(
                    final_change.namespace, final_change.logical_key_digest,
                    final_change.object_digest, target_generation
                )
            );
        END IF;
    END LOOP;

    INSERT INTO p2tr_canonical_membership_change_consumptions (
        change_id, generation_id, change_digest, consumption_digest
    )
    SELECT change_id, target_generation, change_digest,
           p2tr_membership_change_consumption_digest(
               target_generation, change_id, change_digest
           )
      FROM p2tr_canonical_membership_change_journal
     WHERE journal_epoch = generation.journal_epoch
     ORDER BY change_id;

    IF EXISTS (
        SELECT 1
          FROM p2tr_canonical_membership_change_journal journal
          LEFT JOIN p2tr_canonical_membership_change_consumptions consumed
            ON consumed.change_id = journal.change_id
           AND consumed.generation_id = target_generation
         WHERE journal.journal_epoch = generation.journal_epoch
           AND consumed.change_id IS NULL
    ) THEN
        RAISE EXCEPTION 'generation did not consume its complete change journal';
    END IF;

    SELECT count(*), coalesce(sum(objects.byte_length), 0)
      INTO measured_count, measured_bytes
      FROM p2tr_canonical_memberships memberships
      JOIN p2tr_evidence_objects objects USING (object_digest)
     WHERE memberships.valid_from_generation <= target_generation
       AND (
           memberships.valid_to_generation IS NULL OR
           memberships.valid_to_generation > target_generation
       );
    calculated_membership_root := p2tr_canonical_generation_membership_root(
        target_generation
    );
    calculated_transition_root := p2tr_canonical_generation_transition_root(
        target_generation
    );
    calculated_source_receipt_root := p2tr_canonical_generation_namespace_root(
        target_generation, 'source_receipt'
    );
    calculated_disposition_root := p2tr_canonical_generation_namespace_root(
        target_generation, 'complete_input_disposition'
    );
    calculated_manifest := p2tr_canonical_generation_manifest_digest(
        generation.generation_id, generation.journal_epoch,
        generation.parent_manifest_digest, generation.domain_digest,
        generation.bitcoin_height, generation.bitcoin_hash,
        generation.bitcoin_header_object_digest,
        generation.ethereum_block_number, generation.ethereum_block_hash,
        generation.bitcoin_chain_root, generation.projection_root,
        generation.semantic_root, calculated_transition_root,
        calculated_source_receipt_root, calculated_disposition_root,
        calculated_membership_root, measured_count, measured_bytes
    );

    UPDATE p2tr_canonical_generations
       SET state = 'committed',
           transition_root = calculated_transition_root,
           source_receipt_root = calculated_source_receipt_root,
           candidate_disposition_root = calculated_disposition_root,
           membership_root = calculated_membership_root,
           active_membership_count = measured_count,
           active_object_bytes = measured_bytes,
           manifest_digest = calculated_manifest,
           committed_at = clock_timestamp()
     WHERE generation_id = target_generation;

    UPDATE p2tr_canonical_change_journal_state
       SET current_epoch = current_epoch + 1,
           building_generation_id = NULL,
           updated_at = clock_timestamp()
     WHERE singleton = true;
    RETURN calculated_manifest;
END
$$;

CREATE FUNCTION p2tr_assert_generation_journal_complete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    journal_count bigint;
    consumed_count bigint;
    active_builder bigint;
    unapplied_change_exists boolean;
    unrelated_consumption_exists boolean;
    unjournaled_transition_exists boolean;
BEGIN
    IF OLD.state = 'building' AND NEW.state = 'committed' THEN
        SELECT building_generation_id INTO active_builder
          FROM p2tr_canonical_change_journal_state
         WHERE singleton = true
         FOR SHARE;
        SELECT count(*) INTO journal_count
          FROM p2tr_canonical_membership_change_journal
         WHERE journal_epoch = NEW.journal_epoch;
        SELECT count(*) INTO consumed_count
          FROM p2tr_canonical_membership_change_consumptions
         WHERE generation_id = NEW.generation_id;
        SELECT EXISTS (
            SELECT 1
              FROM p2tr_canonical_membership_change_journal journal
              LEFT JOIN p2tr_canonical_membership_change_consumptions consumed
                ON consumed.change_id = journal.change_id
               AND consumed.generation_id = NEW.generation_id
             WHERE journal.journal_epoch = NEW.journal_epoch
               AND consumed.change_id IS NULL
        ) INTO unapplied_change_exists;
        SELECT EXISTS (
            SELECT 1
              FROM p2tr_canonical_membership_change_consumptions consumed
              JOIN p2tr_canonical_membership_change_journal journal
                USING (change_id)
             WHERE consumed.generation_id = NEW.generation_id
               AND journal.journal_epoch <> NEW.journal_epoch
        ) INTO unrelated_consumption_exists;
        WITH final_changes AS (
            SELECT DISTINCT ON (namespace, logical_key_digest)
                   namespace, logical_key_digest, operation,
                   object_digest, object_kind
              FROM p2tr_canonical_membership_change_journal
             WHERE journal_epoch = NEW.journal_epoch
             ORDER BY namespace, logical_key_digest, change_id DESC
        ), active_at_generation AS (
            SELECT namespace, logical_key_digest, object_digest, object_kind
              FROM p2tr_canonical_memberships
             WHERE valid_from_generation <= NEW.generation_id
               AND (
                   valid_to_generation IS NULL OR
                   valid_to_generation > NEW.generation_id
               )
        )
        SELECT EXISTS (
            SELECT 1
              FROM final_changes changes
              LEFT JOIN active_at_generation active
                USING (namespace, logical_key_digest)
             WHERE (
                 changes.operation = 'upsert' AND (
                     active.object_digest IS NULL OR
                     active.object_digest <> changes.object_digest OR
                     active.object_kind <> changes.object_kind
                 )
             ) OR (
                 changes.operation = 'delete' AND
                 active.object_digest IS NOT NULL
             )
        ) OR EXISTS (
            SELECT 1
              FROM p2tr_canonical_memberships memberships
              LEFT JOIN final_changes changes
                USING (namespace, logical_key_digest)
             WHERE (
                 memberships.valid_from_generation = NEW.generation_id OR
                 memberships.valid_to_generation = NEW.generation_id
             ) AND changes.logical_key_digest IS NULL
        ) INTO unjournaled_transition_exists;
        IF active_builder IS DISTINCT FROM NEW.generation_id OR
           journal_count <> consumed_count OR unapplied_change_exists OR
           unrelated_consumption_exists OR unjournaled_transition_exists THEN
            RAISE EXCEPTION 'cannot commit a partial canonical generation';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_canonical_generation_journal_complete
BEFORE UPDATE ON p2tr_canonical_generations
FOR EACH ROW EXECUTE FUNCTION p2tr_assert_generation_journal_complete();
