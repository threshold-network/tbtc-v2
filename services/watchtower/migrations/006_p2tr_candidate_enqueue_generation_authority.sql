-- Candidate enqueue authority is one-use per exact outbox generation, not per
-- Bitcoin candidate forever. A finalized nonce disposition can require a new
-- generation for the same canonical candidate, so retain the generation cause
-- and its immutable predecessor evidence as part of the durable authority.
INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('candidate-enqueue-generation-authority', 1);

-- Migration 005 originally took its canonical-writer lock after its
-- SERIALIZABLE transaction had already opened. The runner now fences writers
-- before BEGIN. Re-run the narrowly scoped observation repair under that
-- session fence as well, so a database that applied the older runner cannot
-- retain a display-order deposit row that committed while 005 was waiting.
DO $$
DECLARE
    migrated_deposit_count bigint;
    configured_domain_digest bytea;
    canonical_state record;
    migration_generation bigint;
    original_disposition_guard_definition text;
BEGIN
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
    SET CONSTRAINTS ALL IMMEDIATE;

    IF migrated_deposit_count = 0 THEN
        RETURN;
    END IF;

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
VALIDATE CONSTRAINT p2tr_candidate_observation_binding_matches_funding;

ALTER TABLE p2tr_candidate_enqueue_authorizations
    ADD COLUMN generation_authority_version smallint NOT NULL DEFAULT 0,
    ADD COLUMN expected_outbox_generation integer,
    ADD COLUMN expected_outbox_disposition text,
    ADD COLUMN expected_outbox_predecessor_id bytea,
    ADD COLUMN expected_outbox_evidence_id bytea;

ALTER TABLE p2tr_candidate_enqueue_authorizations
    ADD CONSTRAINT p2tr_candidate_enqueue_generation_authority_shape
    CHECK (
        (
            generation_authority_version = 0
            AND expected_outbox_generation IS NULL
            AND expected_outbox_disposition IS NULL
            AND expected_outbox_predecessor_id IS NULL
            AND expected_outbox_evidence_id IS NULL
        )
        OR
        (
            generation_authority_version = 1
            AND expected_outbox_generation IS NOT NULL
            AND expected_outbox_generation BETWEEN 0 AND 32
            AND expected_outbox_disposition IS NOT NULL
            AND expected_outbox_disposition IN (
                'initial',
                'nonce-disposition',
                'canonical-reappearance',
                'provenance-restored'
            )
            AND (
                (
                    expected_outbox_generation = 0
                    AND expected_outbox_disposition = 'initial'
                    AND expected_outbox_predecessor_id IS NULL
                    AND expected_outbox_evidence_id IS NULL
                )
                OR
                (
                    expected_outbox_generation > 0
                    AND expected_outbox_disposition <> 'initial'
                    AND expected_outbox_predecessor_id IS NOT NULL
                    AND octet_length(expected_outbox_predecessor_id) = 32
                    AND expected_outbox_evidence_id IS NOT NULL
                    AND octet_length(expected_outbox_evidence_id) = 32
                )
            )
        )
    );

-- The exact series identity used by the scheduler contains these immutable
-- candidate/binding fields. The activation manifest may rotate between a
-- cancelled predecessor and its authorized successor, so it is deliberately
-- not used to hide the retained series head.
CREATE FUNCTION p2tr_candidate_enqueue_expected_authority(
    observation_id_value bytea,
    challenge_key_value bytea,
    txid_value bytea,
    wtxid_value bytea,
    input_index_value bigint,
    input_output_key_value bytea,
    input_binding_kind_value text,
    funding_txid_value bytea,
    funding_vout_value bigint
)
RETURNS TABLE (
    expected_generation integer,
    expected_disposition text,
    expected_predecessor_id bytea,
    expected_evidence_id bytea
)
LANGUAGE plpgsql
STABLE
AS $body$
DECLARE
    head_count bigint;
    head_record record;
BEGIN
    SELECT count(*)
      INTO head_count
      FROM p2tr_signature_fraud_challenge_outbox outbox
     WHERE outbox.observation_id = observation_id_value
       AND outbox.bridge_challenge_key = challenge_key_value
       AND outbox.bitcoin_tx_hash = txid_value
       AND outbox.bitcoin_wtxid = wtxid_value
       AND outbox.bitcoin_input_index = input_index_value
       AND outbox.signing_key = input_output_key_value
       AND outbox.binding_tx_hash = CASE input_binding_kind_value
               WHEN 'registered-wallet-output'
                   THEN decode(repeat('00', 32), 'hex')
               WHEN 'deposit-binding'
                   THEN p2tr_reverse_bytea(funding_txid_value)
           END
       AND outbox.binding_output_index = CASE input_binding_kind_value
               WHEN 'registered-wallet-output' THEN 0
               WHEN 'deposit-binding' THEN funding_vout_value
           END
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_outbox successor
            WHERE successor.previous_record_id = outbox.record_id
       );

    IF head_count > 1 THEN
        RAISE EXCEPTION
            'candidate enqueue authority resolves multiple outbox series heads';
    END IF;

    SELECT outbox.*
      INTO head_record
      FROM p2tr_signature_fraud_challenge_outbox outbox
     WHERE outbox.observation_id = observation_id_value
       AND outbox.bridge_challenge_key = challenge_key_value
       AND outbox.bitcoin_tx_hash = txid_value
       AND outbox.bitcoin_wtxid = wtxid_value
       AND outbox.bitcoin_input_index = input_index_value
       AND outbox.signing_key = input_output_key_value
       AND outbox.binding_tx_hash = CASE input_binding_kind_value
               WHEN 'registered-wallet-output'
                   THEN decode(repeat('00', 32), 'hex')
               WHEN 'deposit-binding'
                   THEN p2tr_reverse_bytea(funding_txid_value)
           END
       AND outbox.binding_output_index = CASE input_binding_kind_value
               WHEN 'registered-wallet-output' THEN 0
               WHEN 'deposit-binding' THEN funding_vout_value
           END
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_outbox successor
            WHERE successor.previous_record_id = outbox.record_id
       );

    IF NOT FOUND THEN
        expected_generation := 0;
        expected_disposition := 'initial';
        expected_predecessor_id := NULL;
        expected_evidence_id := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    IF head_record.status = 'generation-required' THEN
        IF head_record.nonce_disposition_id IS NULL THEN
            RAISE EXCEPTION
                'generation-required outbox head lacks nonce disposition';
        END IF;
        expected_generation := head_record.generation + 1;
        expected_disposition := 'nonce-disposition';
        expected_predecessor_id := head_record.record_id;
        expected_evidence_id := head_record.nonce_disposition_id;
    ELSIF head_record.status = 'cancelled-reorg' THEN
        IF head_record.cancellation_evidence_id IS NULL THEN
            RAISE EXCEPTION
                'cancelled-reorg outbox head lacks cancellation evidence';
        END IF;
        expected_generation := head_record.generation + 1;
        expected_disposition := 'canonical-reappearance';
        expected_predecessor_id := head_record.record_id;
        expected_evidence_id := head_record.cancellation_evidence_id;
    ELSIF head_record.status = 'cancelled-provenance-invalidated' THEN
        IF head_record.provenance_invalidation_id IS NULL THEN
            RAISE EXCEPTION
                'provenance-invalidated outbox head lacks invalidation evidence';
        END IF;
        expected_generation := head_record.generation + 1;
        expected_disposition := 'provenance-restored';
        expected_predecessor_id := head_record.record_id;
        expected_evidence_id := head_record.provenance_invalidation_id;
    ELSE
        expected_generation := head_record.generation;
        expected_disposition := CASE
            WHEN head_record.generation_cause IS NULL THEN 'initial'
            WHEN head_record.generation_cause = 'finalized-revert'
                THEN 'nonce-disposition'
            WHEN head_record.generation_cause = 'finalized-nonce-consumed'
                THEN 'nonce-disposition'
            WHEN head_record.generation_cause = 'canonical-reappearance'
                THEN 'canonical-reappearance'
            WHEN head_record.generation_cause = 'provenance-restored'
                THEN 'provenance-restored'
        END;
        expected_predecessor_id := head_record.previous_record_id;
        expected_evidence_id := CASE head_record.generation_cause
            WHEN 'finalized-revert' THEN head_record.prior_nonce_disposition_id
            WHEN 'finalized-nonce-consumed' THEN head_record.prior_nonce_disposition_id
            WHEN 'canonical-reappearance' THEN head_record.prior_cancellation_evidence_id
            WHEN 'provenance-restored' THEN head_record.prior_provenance_invalidation_id
        END;
    END IF;

    IF expected_generation > 32 OR expected_disposition IS NULL THEN
        RAISE EXCEPTION 'candidate enqueue outbox generation authority is invalid';
    END IF;
    RETURN NEXT;
END;
$body$;

-- Backfill every authorization whose generation can be proven from its linked
-- outbox record. The intentionally retained pre-outbox consumed rows have no
-- intent identity and remain version 0; issuance continues to fail closed for
-- those candidates because their exact generation cannot be reconstructed.
WITH linked_authorities AS (
    SELECT authz.token_id,
           outbox.record_id,
           outbox.generation,
           outbox.generation_cause,
           outbox.previous_record_id,
           outbox.prior_nonce_disposition_id,
           outbox.prior_cancellation_evidence_id,
           outbox.prior_provenance_invalidation_id,
           outbox.status,
           outbox.nonce_disposition_id,
           outbox.cancellation_evidence_id,
           outbox.provenance_invalidation_id,
           resolution.outcome_kind
      FROM p2tr_candidate_enqueue_authorizations authz
      JOIN p2tr_signature_fraud_challenge_outbox outbox
        ON outbox.record_id = authz.outbox_intent_id
      LEFT JOIN p2tr_candidate_enqueue_transaction_resolution resolution
        ON resolution.manifest_hash = authz.manifest_hash
       AND resolution.token_id = authz.token_id
)
UPDATE p2tr_candidate_enqueue_authorizations authz
   SET generation_authority_version = 1,
       expected_outbox_generation = CASE
           WHEN linked.outcome_kind = 'generation-cap-exhausted'
               THEN linked.generation + 1
           ELSE linked.generation
       END,
       expected_outbox_disposition = CASE
           WHEN linked.outcome_kind = 'generation-cap-exhausted'
               AND linked.status = 'generation-required'
               THEN 'nonce-disposition'
           WHEN linked.outcome_kind = 'generation-cap-exhausted'
               AND linked.status = 'cancelled-reorg'
               THEN 'canonical-reappearance'
           WHEN linked.outcome_kind = 'generation-cap-exhausted'
               AND linked.status = 'cancelled-provenance-invalidated'
               THEN 'provenance-restored'
           WHEN linked.generation_cause IS NULL THEN 'initial'
           WHEN linked.generation_cause IN (
               'finalized-revert', 'finalized-nonce-consumed'
           ) THEN 'nonce-disposition'
           ELSE linked.generation_cause
       END,
       expected_outbox_predecessor_id = CASE
           WHEN linked.outcome_kind = 'generation-cap-exhausted'
               THEN linked.record_id
           ELSE linked.previous_record_id
       END,
       expected_outbox_evidence_id = CASE
           WHEN linked.outcome_kind = 'generation-cap-exhausted'
               AND linked.status = 'generation-required'
               THEN linked.nonce_disposition_id
           WHEN linked.outcome_kind = 'generation-cap-exhausted'
               AND linked.status = 'cancelled-reorg'
               THEN linked.cancellation_evidence_id
           WHEN linked.outcome_kind = 'generation-cap-exhausted'
               AND linked.status = 'cancelled-provenance-invalidated'
               THEN linked.provenance_invalidation_id
           WHEN linked.generation_cause IN (
               'finalized-revert', 'finalized-nonce-consumed'
           ) THEN linked.prior_nonce_disposition_id
           WHEN linked.generation_cause = 'canonical-reappearance'
               THEN linked.prior_cancellation_evidence_id
           WHEN linked.generation_cause = 'provenance-restored'
               THEN linked.prior_provenance_invalidation_id
       END
  FROM linked_authorities linked
 WHERE authz.token_id = linked.token_id;

-- Unconsumed authorizations can be bound safely while the migration runner's
-- session fence excludes canonical and outbox writers.
WITH expected_authorities AS (
    SELECT authz.token_id,
           authority.expected_generation,
           authority.expected_disposition,
           authority.expected_predecessor_id,
           authority.expected_evidence_id
      FROM p2tr_candidate_enqueue_authorizations authz
      CROSS JOIN LATERAL p2tr_candidate_enqueue_expected_authority(
          authz.observation_id,
          authz.challenge_key,
          authz.txid,
          authz.wtxid,
          authz.input_index,
          authz.input_output_key,
          authz.input_binding_kind,
          authz.funding_txid,
          authz.funding_vout
      ) authority
     WHERE authz.consumed_at IS NULL
       AND authz.generation_authority_version = 0
)
UPDATE p2tr_candidate_enqueue_authorizations authz
   SET generation_authority_version = 1,
       expected_outbox_generation = authority.expected_generation,
       expected_outbox_disposition = authority.expected_disposition,
       expected_outbox_predecessor_id = authority.expected_predecessor_id,
       expected_outbox_evidence_id = authority.expected_evidence_id
  FROM expected_authorities authority
 WHERE authz.token_id = authority.token_id;

DROP INDEX p2tr_candidate_enqueue_authorizations_candidate_consumed_idx;

CREATE UNIQUE INDEX p2tr_candidate_enqueue_authorizations_generation_consumed_idx
    ON p2tr_candidate_enqueue_authorizations (
        candidate_digest,
        expected_outbox_generation,
        expected_outbox_disposition
    )
    WHERE consumed_at IS NOT NULL AND generation_authority_version = 1;

CREATE FUNCTION p2tr_candidate_enqueue_generation_authority_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.generation_authority_version <> 1 THEN
        RAISE EXCEPTION
            'new candidate authorization lacks generation-bound authority';
    END IF;
    IF TG_OP = 'UPDATE' AND (
        NEW.generation_authority_version IS DISTINCT FROM
            OLD.generation_authority_version
        OR NEW.expected_outbox_generation IS DISTINCT FROM
            OLD.expected_outbox_generation
        OR NEW.expected_outbox_disposition IS DISTINCT FROM
            OLD.expected_outbox_disposition
        OR NEW.expected_outbox_predecessor_id IS DISTINCT FROM
            OLD.expected_outbox_predecessor_id
        OR NEW.expected_outbox_evidence_id IS DISTINCT FROM
            OLD.expected_outbox_evidence_id
    ) THEN
        RAISE EXCEPTION
            'candidate generation authority is immutable after issuance';
    END IF;
    RETURN NEW;
END;
$body$;

CREATE TRIGGER p2tr_candidate_enqueue_generation_authority_guard_trigger
BEFORE INSERT OR UPDATE ON p2tr_candidate_enqueue_authorizations
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_generation_authority_guard();
