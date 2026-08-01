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

-- The same old-runner race could admit an outbox row after migration 005's
-- snapshot but before its readiness lock was acquired. Repeat the immutable
-- marker, safe pre-boundary retirement, and durable quarantine scan while the
-- runner's session fence excludes every canonical/outbox writer before BEGIN.
DO $$
DECLARE
    original_marker_guard_definition text;
BEGIN
    SELECT pg_get_functiondef(
               'p2tr_signature_fraud_guard_legacy_deposit_binding_marker()'::regprocedure
           )
      INTO STRICT original_marker_guard_definition;
    EXECUTE $replacement_guard$
        CREATE OR REPLACE FUNCTION
            p2tr_signature_fraud_guard_legacy_deposit_binding_marker()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $repair_guard$
        BEGIN
            IF (TG_OP = 'INSERT' AND NEW.legacy_deposit_binding_byte_order)
               OR (TG_OP = 'UPDATE'
                   AND NEW.legacy_deposit_binding_byte_order IS DISTINCT FROM
                       OLD.legacy_deposit_binding_byte_order
                   AND NOT (
                       NOT OLD.legacy_deposit_binding_byte_order
                       AND NEW.legacy_deposit_binding_byte_order
                       AND OLD.canonical_input_binding_kind = 'deposit-binding'
                       AND OLD.binding_tx_hash IS DISTINCT FROM
                           p2tr_reverse_bytea(OLD.canonical_funding_txid)
                   )) THEN
                RAISE EXCEPTION
                    'legacy deposit-binding byte-order marker is migration-owned and immutable';
            END IF;
            RETURN NEW;
        END
        $repair_guard$
    $replacement_guard$;

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
     WHERE NOT outbox.legacy_deposit_binding_byte_order
       AND outbox.canonical_input_binding_kind = 'deposit-binding'
       AND outbox.binding_tx_hash IS DISTINCT FROM
           p2tr_reverse_bytea(outbox.canonical_funding_txid);

    EXECUTE original_marker_guard_definition;
END
$$;

-- A missed preparing row that has still not crossed any nonce/signer/send
-- boundary is reversible. The migration-005 AFTER trigger turns this queued
-- transition into the terminal cancellation in the same transaction.
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
   )
   AND NOT EXISTS (
       SELECT 1
         FROM p2tr_signature_fraud_legacy_submission_quarantine quarantine
        WHERE quarantine.observation_id = sha256(
                  convert_to(
                      'tbtc/p2tr/legacy-deposit-binding-byte-order/v1',
                      'UTF8'
                  ) || outbox.record_id
              )
   );

-- Migration 005 could have marked this CHECK valid from its stale snapshot.
-- Recreate and validate it after the replayed scan so every pre-existing row
-- is examined under the new session-level fence.
ALTER TABLE p2tr_signature_fraud_challenge_outbox
    DROP CONSTRAINT p2tr_outbox_deposit_binding_uses_bridge_byte_order;

ALTER TABLE p2tr_signature_fraud_challenge_outbox
    ADD CONSTRAINT p2tr_outbox_deposit_binding_uses_bridge_byte_order
    CHECK (
        legacy_deposit_binding_byte_order OR
        canonical_input_binding_kind <> 'deposit-binding' OR
        binding_tx_hash = p2tr_reverse_bytea(canonical_funding_txid)
    ) NOT VALID;

ALTER TABLE p2tr_signature_fraud_challenge_outbox
    VALIDATE CONSTRAINT p2tr_outbox_deposit_binding_uses_bridge_byte_order;

-- An unprotected legacy type-0 signature has no replay-domain chain ID. Keep
-- the forensic chain-zero guard on its escaped envelope, and journal the
-- concrete active guard that excludes the same sender/nonce on every chain
-- where that sender is configured under the record's activation manifest.
CREATE TABLE p2tr_signature_fraud_challenge_chainless_replay_guard (
    escaped_envelope_id bytea NOT NULL REFERENCES
        p2tr_signature_fraud_challenge_escaped_envelope(escaped_envelope_id)
        ON DELETE RESTRICT,
    replay_chain_id numeric(78, 0) NOT NULL CHECK (
        replay_chain_id BETWEEN 1 AND 9007199254740991
    ),
    nonce_guard_record_id bytea NOT NULL CHECK (
        octet_length(nonce_guard_record_id) = 32
    ),
    nonce_guard_id bytea NOT NULL CHECK (octet_length(nonce_guard_id) = 32),
    sender bytea NOT NULL CHECK (octet_length(sender) = 20),
    transaction_nonce numeric(78, 0) NOT NULL CHECK (transaction_nonce >= 0),
    guard_signer_lane_id text NOT NULL CHECK (
        length(guard_signer_lane_id) BETWEEN 1 AND 128
    ),
    guard_signer_identity text NOT NULL CHECK (
        length(guard_signer_identity) BETWEEN 1 AND 128
    ),
    guarded_at_unix_ms bigint NOT NULL CHECK (
        guarded_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (escaped_envelope_id, replay_chain_id),
    FOREIGN KEY (
        nonce_guard_record_id,
        nonce_guard_id,
        replay_chain_id,
        sender,
        transaction_nonce,
        guard_signer_lane_id,
        guard_signer_identity
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

CREATE TRIGGER p2tr_signature_fraud_reject_chainless_replay_guard_mutation_trigger
BEFORE UPDATE OR DELETE
ON p2tr_signature_fraud_challenge_chainless_replay_guard
FOR EACH ROW EXECUTE FUNCTION p2tr_signature_fraud_reject_append_only_mutation();

-- Chainless evidence quarantines every matching configured lane even though
-- those lanes did not own the original reservation. Extend the existing
-- permanent quarantine journal with this evidence-bound, nonce-less reason.
DO $$
DECLARE
    constraint_name text;
BEGIN
    FOR constraint_name IN
        SELECT constraint_record.conname
          FROM pg_constraint constraint_record
         WHERE constraint_record.conrelid =
                   'p2tr_signature_fraud_challenge_signer_quarantine'::regclass
           AND constraint_record.contype = 'c'
           AND pg_get_constraintdef(constraint_record.oid) LIKE
                   '%quarantine_reason%'
    LOOP
        EXECUTE format(
            'ALTER TABLE p2tr_signature_fraud_challenge_signer_quarantine DROP CONSTRAINT %I',
            constraint_name
        );
    END LOOP;
END
$$;

ALTER TABLE p2tr_signature_fraud_challenge_signer_quarantine
    ADD CONSTRAINT p2tr_signature_fraud_signer_quarantine_reason_check CHECK (
        quarantine_reason IN (
            'ambiguous-signer-invocation',
            'wrong-chain',
            'wrong-sender',
            'wrong-nonce',
            'malformed-signed-envelope',
            'invalid-replacement-envelope',
            'reservation-binding-mismatch',
            'reservation-provider-failure',
            'chainless-envelope'
        )
    ),
    ADD CONSTRAINT p2tr_signature_fraud_signer_quarantine_shape_check CHECK (
        (
            quarantine_reason IN (
                'reservation-binding-mismatch',
                'reservation-provider-failure',
                'chainless-envelope'
            )
            AND nonce_reservation_id IS NULL
            AND expected_nonce IS NULL
        )
        OR
        (
            quarantine_reason NOT IN (
                'reservation-binding-mismatch',
                'reservation-provider-failure',
                'chainless-envelope'
            )
            AND nonce_reservation_id IS NOT NULL
            AND expected_nonce IS NOT NULL
        )
    );

CREATE OR REPLACE FUNCTION p2tr_signature_fraud_validate_signer_quarantine_insert()
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
        'reservation-provider-failure',
        'chainless-envelope'
    ) AND NEW.nonce_reservation_id IS NOT NULL THEN
        RAISE EXCEPTION 'pre-reservation quarantine cannot claim a durable nonce';
    END IF;

    IF NEW.quarantine_reason = 'chainless-envelope'
       AND NOT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_escaped_envelope envelope
            WHERE envelope.record_id = NEW.record_id
              AND envelope.actual_chain_id = 0
              AND envelope.actual_sender = NEW.expected_sender
       ) THEN
        RAISE EXCEPTION
            'chainless signer quarantine lacks its immutable escaped envelope';
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

ALTER TABLE p2tr_candidate_enqueue_authorizations
    ADD COLUMN generation_authority_version smallint NOT NULL DEFAULT 0,
    ADD COLUMN expected_outbox_series_id bytea,
    ADD COLUMN expected_outbox_generation integer,
    ADD COLUMN expected_outbox_disposition text,
    ADD COLUMN expected_outbox_predecessor_id bytea,
    ADD COLUMN expected_outbox_evidence_id bytea;

ALTER TABLE p2tr_candidate_enqueue_authorizations
    ADD CONSTRAINT p2tr_candidate_enqueue_generation_authority_shape
    CHECK (
        (
            generation_authority_version = 0
            AND expected_outbox_series_id IS NULL
            AND expected_outbox_generation IS NULL
            AND expected_outbox_disposition IS NULL
            AND expected_outbox_predecessor_id IS NULL
            AND expected_outbox_evidence_id IS NULL
        )
        OR
        (
            generation_authority_version = 1
            AND expected_outbox_series_id IS NOT NULL
            AND octet_length(expected_outbox_series_id) = 32
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

-- Reproduce the scheduler's exact JSON-ordered series digest from the current
-- manifest and immutable candidate binding. In particular, Router or chain
-- rotation creates a new generation-zero series even when every Bitcoin field
-- is unchanged. Fee/policy-only manifest rotation retains the same digest.
CREATE FUNCTION p2tr_candidate_enqueue_series_id(
    manifest_hash_value bytea,
    observation_id_value bytea,
    challenge_key_value bytea,
    input_index_value bigint,
    input_output_key_value bytea,
    input_binding_kind_value text,
    funding_txid_value bytea,
    funding_vout_value bigint
)
RETURNS bytea
LANGUAGE plpgsql
STABLE
STRICT
AS $body$
DECLARE
    manifest_payload jsonb;
    chain_id_value numeric;
    router_address_value bytea;
    binding_tx_hash_value bytea;
    binding_output_index_value bigint;
BEGIN
    SELECT payload
      INTO STRICT manifest_payload
      FROM p2tr_watchtower_activation_manifest
     WHERE manifest_hash = manifest_hash_value;

    IF (manifest_payload #>> '{ethereum,chainID}') !~ '^[1-9][0-9]{0,15}$'
       OR (manifest_payload #>> '{outbox,routerAddress}') !~*
              '^0x[0-9a-f]{40}$' THEN
        RAISE EXCEPTION
            'candidate enqueue manifest lacks its series domain';
    END IF;
    chain_id_value := (manifest_payload #>> '{ethereum,chainID}')::numeric;
    IF chain_id_value > 9007199254740991 THEN
        RAISE EXCEPTION 'candidate enqueue series chain ID is unsafe';
    END IF;
    router_address_value := decode(
        regexp_replace(
            lower(manifest_payload #>> '{outbox,routerAddress}'),
            '^0x',
            ''
        ),
        'hex'
    );
    binding_tx_hash_value := CASE input_binding_kind_value
        WHEN 'registered-wallet-output' THEN decode(repeat('00', 32), 'hex')
        WHEN 'deposit-binding' THEN p2tr_reverse_bytea(funding_txid_value)
    END;
    binding_output_index_value := CASE input_binding_kind_value
        WHEN 'registered-wallet-output' THEN 0
        WHEN 'deposit-binding' THEN funding_vout_value
    END;
    IF binding_tx_hash_value IS NULL OR binding_output_index_value IS NULL THEN
        RAISE EXCEPTION 'candidate enqueue series binding kind is invalid';
    END IF;

    RETURN sha256(convert_to(
        '{"domain":"tbtc-p2tr-signature-fraud-outbox-series-v1"' ||
        ',"protocol":"COMPLETE_V2"' ||
        ',"evidenceProtocolID":"0x12c62b64ecf6d008bcff153495dcdbe7a981f3a9a1b9c0898b86b1e6d0d350ef"' ||
        ',"chainID":' || chain_id_value::text ||
        ',"domainChainID":' || chain_id_value::text ||
        ',"routerAddress":' ||
            to_json(('0x' || encode(router_address_value, 'hex'))::text)::text ||
        ',"observationID":' ||
            to_json(('0x' || encode(observation_id_value, 'hex'))::text)::text ||
        ',"inputIndex":' || input_index_value::text ||
        ',"bridgeChallengeKey":' ||
            to_json(('0x' || encode(challenge_key_value, 'hex'))::text)::text ||
        ',"signingKey":' ||
            to_json(('0x' || encode(input_output_key_value, 'hex'))::text)::text ||
        ',"bindingTxHash":' ||
            to_json(('0x' || encode(binding_tx_hash_value, 'hex'))::text)::text ||
        ',"bindingOutputIndex":' || binding_output_index_value::text ||
        '}',
        'UTF8'
    ));
END;
$body$;

CREATE FUNCTION p2tr_candidate_enqueue_expected_authority(
    manifest_hash_value bytea,
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
    expected_series_id bytea,
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
    expected_series_id := p2tr_candidate_enqueue_series_id(
        manifest_hash_value,
        observation_id_value,
        challenge_key_value,
        input_index_value,
        input_output_key_value,
        input_binding_kind_value,
        funding_txid_value,
        funding_vout_value
    );
    SELECT count(*)
      INTO head_count
      FROM p2tr_signature_fraud_challenge_outbox outbox
     WHERE outbox.series_id = expected_series_id
       AND outbox.observation_id = observation_id_value
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
     WHERE outbox.series_id = expected_series_id
       AND outbox.observation_id = observation_id_value
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
           outbox.series_id,
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
       expected_outbox_series_id = linked.series_id,
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
           authority.expected_series_id,
           authority.expected_generation,
           authority.expected_disposition,
           authority.expected_predecessor_id,
           authority.expected_evidence_id
      FROM p2tr_candidate_enqueue_authorizations authz
      CROSS JOIN LATERAL p2tr_candidate_enqueue_expected_authority(
          authz.manifest_hash,
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
       AND authz.invalidated_at IS NULL
       AND authz.expires_at > clock_timestamp()
       AND authz.generation_authority_version = 0
)
UPDATE p2tr_candidate_enqueue_authorizations authz
   SET generation_authority_version = 1,
       expected_outbox_series_id = authority.expected_series_id,
       expected_outbox_generation = authority.expected_generation,
       expected_outbox_disposition = authority.expected_disposition,
       expected_outbox_predecessor_id = authority.expected_predecessor_id,
       expected_outbox_evidence_id = authority.expected_evidence_id
  FROM expected_authorities authority
 WHERE authz.token_id = authority.token_id;

DROP INDEX p2tr_candidate_enqueue_authorizations_candidate_consumed_idx;

CREATE UNIQUE INDEX p2tr_candidate_enqueue_authorizations_generation_consumed_idx
    ON p2tr_candidate_enqueue_authorizations (
        expected_outbox_series_id,
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
        OR NEW.expected_outbox_series_id IS DISTINCT FROM
            OLD.expected_outbox_series_id
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
