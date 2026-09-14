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

-- Serialize the evidence rewrite with readiness snapshots and every canonical
-- writer for the duration of the migration transaction.
SELECT pg_advisory_xact_lock(
    hashtextextended('p2tr-readiness-snapshot', 0)
);

DO $$
DECLARE
    legacy_constraint_name text;
    legacy_constraint_count integer;
BEGIN
    SELECT count(*), min(constraint_record.conname)
      INTO legacy_constraint_count, legacy_constraint_name
      FROM pg_constraint constraint_record
     WHERE constraint_record.conrelid =
               'p2tr_bitcoin_candidate_observations'::regclass
       AND constraint_record.contype = 'c'
       AND pg_get_constraintdef(constraint_record.oid) LIKE
               '%binding_kind%deposit%binding_tx_hash = local_funding_txid%';

    IF legacy_constraint_count <> 1 THEN
        RAISE EXCEPTION
            'expected exactly one legacy P2TR deposit binding constraint, found %',
            legacy_constraint_count;
    END IF;

    EXECUTE format(
        'ALTER TABLE p2tr_bitcoin_candidate_observations DROP CONSTRAINT %I',
        legacy_constraint_name
    );
END
$$;

DO $$
DECLARE
    migrated_deposit_count bigint;
    configured_domain_digest bytea;
    canonical_state record;
    migration_generation bigint;
    original_disposition_guard_definition text;
BEGIN
    -- The disposition row is otherwise immutable after insert (and especially
    -- after delivery). Temporarily replace only that guard for this schema
    -- repair; ALTER TABLE ... DISABLE/ENABLE cannot be toggled back while the
    -- update has deferred trigger events pending. The replacement admits only
    -- the exact legacy-to-native binding rewrite, and the original definition
    -- is restored before this block can continue. The evidence, readiness, and
    -- membership-journal triggers remain enabled throughout.
    SELECT pg_get_functiondef(
               'p2tr_guard_candidate_input_disposition()'::regprocedure
           )
      INTO STRICT original_disposition_guard_definition;
    EXECUTE $replacement_guard$
        CREATE OR REPLACE FUNCTION p2tr_guard_candidate_input_disposition()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $repair_guard$
        BEGIN
            IF TG_OP <> 'UPDATE' OR
               OLD.binding_kind <> 'deposit' OR
               OLD.binding_tx_hash IS DISTINCT FROM OLD.local_funding_txid OR
               NEW.binding_tx_hash IS DISTINCT FROM
                   p2tr_reverse_bytea(OLD.local_funding_txid) OR
               (to_jsonb(NEW) - ARRAY[
                   'binding_tx_hash',
                   'disposition_evidence_object_digest'
               ]) IS DISTINCT FROM
               (to_jsonb(OLD) - ARRAY[
                   'binding_tx_hash',
                   'disposition_evidence_object_digest'
               ]) THEN
                RAISE EXCEPTION
                    'candidate input disposition migration changed unsupported fields';
            END IF;
            RETURN NEW;
        END
        $repair_guard$
    $replacement_guard$;
    UPDATE p2tr_bitcoin_candidate_observations
       SET binding_tx_hash = p2tr_reverse_bytea(local_funding_txid),
           disposition_evidence_object_digest = NULL
     WHERE binding_kind = 'deposit'
       AND binding_tx_hash IS DISTINCT FROM
            p2tr_reverse_bytea(local_funding_txid);
    GET DIAGNOSTICS migrated_deposit_count = ROW_COUNT;
    EXECUTE original_disposition_guard_definition;
    -- Drain deferred foreign-key trigger events before the replacement CHECK
    -- constraint is installed later in this transaction. PostgreSQL refuses
    -- ALTER TABLE while a table still has pending trigger events.
    SET CONSTRAINTS ALL IMMEDIATE;

    IF migrated_deposit_count = 0 THEN
        RETURN;
    END IF;

    -- Rows that have never belonged to a committed generation remain in the
    -- open epoch for the first normal checkpoint commit. If a committed
    -- generation exists, however, seal the rewrite now so no readiness reader
    -- can observe new projection roots paired with the previous generation.
    SELECT domain_digest
      INTO configured_domain_digest
      FROM p2tr_canonical_generations
     WHERE state = 'committed'
     ORDER BY generation_id DESC
     LIMIT 1;
    IF configured_domain_digest IS NULL THEN
        RETURN;
    END IF;

    SELECT cursor.current_height AS bitcoin_height,
           cursor.current_hash AS bitcoin_hash,
           canonical_block.header_object_digest AS bitcoin_header_object_digest,
           cursor.current_chain_commitment AS bitcoin_chain_root,
           coalesce(watermark.ethereum_block_number, 0)
               AS ethereum_block_number,
           coalesce(watermark.ethereum_block_hash, decode(repeat('00', 32), 'hex'))
               AS ethereum_block_hash,
           p2tr_muhash_finalize(
               projection.projection_numerator,
               projection.projection_denominator
           ) AS projection_root,
           p2tr_muhash_finalize(
               projection.semantic_numerator,
               projection.semantic_denominator
           ) AS semantic_root
      INTO STRICT canonical_state
      FROM p2tr_bitcoin_cursor cursor
      JOIN p2tr_bitcoin_blocks canonical_block
        ON canonical_block.height = cursor.current_height
       AND canonical_block.hash = cursor.current_hash
      JOIN p2tr_readiness_projection_state projection
        ON projection.singleton = true
      LEFT JOIN p2tr_cross_source_watermark watermark
        ON watermark.singleton = true
     WHERE cursor.singleton = true
     FOR SHARE OF cursor, canonical_block, projection;

    migration_generation := p2tr_begin_canonical_generation(
        configured_domain_digest,
        canonical_state.bitcoin_height,
        canonical_state.bitcoin_hash,
        canonical_state.bitcoin_header_object_digest,
        canonical_state.ethereum_block_number,
        canonical_state.ethereum_block_hash,
        canonical_state.bitcoin_chain_root,
        canonical_state.projection_root,
        canonical_state.semantic_root
    );
    PERFORM p2tr_seal_canonical_generation(migration_generation);
END
$$;

ALTER TABLE p2tr_bitcoin_candidate_observations
ADD CONSTRAINT p2tr_candidate_observation_binding_matches_funding
CHECK (
    (binding_kind = 'wallet' AND signing_key = wallet_id AND
     binding_tx_hash = decode(repeat('00', 32), 'hex') AND
     binding_output_index = 0) OR
    (binding_kind = 'deposit' AND signing_key = output_key AND
     binding_tx_hash = p2tr_reverse_bytea(local_funding_txid) AND
     binding_output_index = local_funding_vout)
) NOT VALID;

-- Legacy outbox identities may already own a nonce or signed envelope, so they
-- cannot be rewritten. Mark those rows explicitly. A queued marked row is
-- retired immediately, while a boundary-bearing row remains mutable for safe
-- release/reconciliation and is retired automatically if recovery returns it
-- to queued. The marker is immutable after this migration and forbidden on new
-- inserts, so it cannot become a general constraint bypass.
ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD COLUMN legacy_deposit_binding_byte_order boolean NOT NULL DEFAULT false;

CREATE FUNCTION p2tr_signature_fraud_retire_legacy_deposit_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    transition_at_unix_ms bigint := greatest(
        NEW.updated_at_unix_ms,
        (extract(epoch FROM clock_timestamp()) * 1000)::bigint
    );
    transition_reason text :=
        'legacy display-order deposit binding retired before broadcast';
BEGIN
    UPDATE p2tr_signature_fraud_challenge_outbox
       SET status = 'cancelled-before-broadcast',
           version = NEW.version + 1,
           preparation_lease_owner = NULL,
           preparation_lease_expires_at_unix_ms = NULL,
           preparation_resume_status = NULL,
           selected_signer_lane_id = NULL,
           selected_signer_identity = NULL,
           selected_sender = NULL,
           updated_at_unix_ms = transition_at_unix_ms,
           last_error = transition_reason,
           record_state = (
               NEW.record_state - ARRAY[
                   'preparationLease',
                   'preparationResumeStatus',
                   'preparationSender',
                   'selectedLaneID',
                   'selectedSignerIdentity'
               ]
           ) || jsonb_build_object(
               'status', 'cancelled-before-broadcast',
               'version', NEW.version + 1,
               'updatedAtUnixMs', transition_at_unix_ms,
               'lastError', transition_reason
           )
     WHERE record_id = NEW.record_id
       AND version = NEW.version
       AND status = 'queued'
       AND legacy_deposit_binding_byte_order;
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'legacy deposit-binding retirement lost its exact queued CAS';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_signature_fraud_retire_legacy_deposit_binding_trigger
AFTER UPDATE ON p2tr_signature_fraud_challenge_outbox
FOR EACH ROW
WHEN (
    NEW.legacy_deposit_binding_byte_order
    AND NEW.status = 'queued'
)
EXECUTE FUNCTION p2tr_signature_fraud_retire_legacy_deposit_binding();

WITH migration_clock AS (
    SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint
               AS now_unix_ms
)
UPDATE p2tr_signature_fraud_challenge_outbox outbox
   SET legacy_deposit_binding_byte_order = true,
       version = outbox.version + 1,
       updated_at_unix_ms = greatest(
           outbox.updated_at_unix_ms,
           migration_clock.now_unix_ms
       ),
       last_error =
           'legacy display-order deposit binding requires operator resolution',
       record_state = outbox.record_state || jsonb_build_object(
           'version', outbox.version + 1,
           'updatedAtUnixMs', greatest(
               outbox.updated_at_unix_ms,
               migration_clock.now_unix_ms
           ),
           'lastError',
               'legacy display-order deposit binding requires operator resolution'
       )
  FROM migration_clock
 WHERE outbox.canonical_input_binding_kind = 'deposit-binding'
   AND outbox.binding_tx_hash IS DISTINCT FROM
       p2tr_reverse_bytea(outbox.canonical_funding_txid);

-- A preparing record with no nonce, signer invocation, signed bytes, or send
-- boundary is still fully reversible. Return it to queued; the AFTER trigger
-- above atomically converts that transient queued state into a terminal
-- pre-broadcast cancellation and releases its capacity.
WITH migration_clock AS (
    SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint
               AS now_unix_ms
)
UPDATE p2tr_signature_fraud_challenge_outbox outbox
   SET status = 'queued',
       version = outbox.version + 1,
       preparation_lease_owner = NULL,
       preparation_lease_expires_at_unix_ms = NULL,
       preparation_resume_status = NULL,
       selected_signer_lane_id = NULL,
       selected_signer_identity = NULL,
       selected_sender = NULL,
       updated_at_unix_ms = greatest(
           outbox.updated_at_unix_ms,
           migration_clock.now_unix_ms
       ),
       last_error =
           'legacy display-order deposit binding returned for safe retirement',
       record_state = (
           outbox.record_state - ARRAY[
               'preparationLease',
               'preparationResumeStatus',
               'preparationSender',
               'selectedLaneID',
               'selectedSignerIdentity'
           ]
       ) || jsonb_build_object(
           'status', 'queued',
           'version', outbox.version + 1,
           'updatedAtUnixMs', greatest(
               outbox.updated_at_unix_ms,
               migration_clock.now_unix_ms
           ),
           'lastError',
               'legacy display-order deposit binding returned for safe retirement'
       )
  FROM migration_clock
 WHERE outbox.legacy_deposit_binding_byte_order
   AND outbox.status = 'preparing'
   AND outbox.nonce_reservation_id IS NULL
   AND outbox.signer_invocation_started_at_unix_ms IS NULL
   AND outbox.active_signer_invocation_started_at_unix_ms IS NULL
   AND outbox.prepared_transaction_hash IS NULL
   AND outbox.broadcast_attempts = 0
   AND outbox.signer_quarantine_id IS NULL
   AND NOT EXISTS (
       SELECT 1
         FROM p2tr_signature_fraud_challenge_late_signed_artifact artifact
        WHERE artifact.record_id = outbox.record_id
   )
   AND NOT EXISTS (
       SELECT 1
         FROM p2tr_signature_fraud_challenge_escaped_envelope envelope
        WHERE envelope.record_id = outbox.record_id
   );

CREATE FUNCTION p2tr_signature_fraud_guard_legacy_deposit_binding_marker()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (TG_OP = 'INSERT' AND NEW.legacy_deposit_binding_byte_order)
       OR (TG_OP = 'UPDATE' AND
           NEW.legacy_deposit_binding_byte_order IS DISTINCT FROM
               OLD.legacy_deposit_binding_byte_order) THEN
        RAISE EXCEPTION
            'legacy deposit-binding byte-order marker is migration-owned and immutable';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER p2tr_signature_fraud_guard_legacy_deposit_binding_marker_trigger
BEFORE INSERT OR UPDATE ON p2tr_signature_fraud_challenge_outbox
FOR EACH ROW
EXECUTE FUNCTION p2tr_signature_fraud_guard_legacy_deposit_binding_marker();

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_outbox_deposit_binding_uses_bridge_byte_order
CHECK (
    legacy_deposit_binding_byte_order OR
    canonical_input_binding_kind <> 'deposit-binding' OR
    binding_tx_hash = p2tr_reverse_bytea(canonical_funding_txid)
);

-- A v3 outbox intent may already be signed, broadcast, or terminal, so its
-- calldata-bound hash and derived identities cannot be rewritten safely. Keep
-- those rows in place for audit/reconciliation and add an unresolved durable
-- quarantine that the existing activation handshake counts. The immutable
-- marker above permits only those exact migrated rows to finish recovery.
INSERT INTO p2tr_signature_fraud_legacy_submission_quarantine (
    observation_id,
    bridge_challenge_key,
    legacy_status,
    submission_attempts,
    challenge_transaction_hash,
    reason,
    quarantined_at_unix_ms
)
SELECT sha256(
           convert_to(
               'tbtc/p2tr/legacy-deposit-binding-byte-order/v1',
               'UTF8'
           ) || outbox.record_id
       ),
       outbox.bridge_challenge_key,
       'outbox-' || outbox.status,
       (
           SELECT count(*)::integer
             FROM p2tr_signature_fraud_challenge_outbox_broadcast_attempt attempt
            WHERE attempt.record_id = outbox.record_id
              AND attempt.generation = outbox.generation
       ),
       outbox.prepared_transaction_hash,
       'legacy outbox intent uses display-order deposit binding hash; automatic mutation is unsafe',
       (extract(epoch FROM clock_timestamp()) * 1000)::bigint
 FROM p2tr_signature_fraud_challenge_outbox outbox
 WHERE outbox.canonical_input_binding_kind = 'deposit-binding'
   AND outbox.binding_tx_hash IS DISTINCT FROM
       p2tr_reverse_bytea(outbox.canonical_funding_txid)
   AND NOT (
       outbox.status = 'cancelled-before-broadcast'
       AND outbox.legacy_deposit_binding_byte_order
   );

CREATE TRIGGER p2tr_signature_fraud_reject_legacy_quarantine_mutation_trigger
BEFORE UPDATE OR DELETE
ON p2tr_signature_fraud_legacy_submission_quarantine
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

UPDATE p2tr_watchtower_schema_version
   SET version = 4,
       applied_at = clock_timestamp()
 WHERE component = 'canonical-evidence-index'
   AND version = 3;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM p2tr_watchtower_schema_version
         WHERE component = 'canonical-evidence-index'
           AND version = 4
    ) THEN
        RAISE EXCEPTION
            'canonical evidence schema must advance from version 3 to 4';
    END IF;
END
$$;
