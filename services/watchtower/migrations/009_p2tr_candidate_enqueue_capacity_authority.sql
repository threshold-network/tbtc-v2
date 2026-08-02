-- Restore byte-for-byte parity with the SDK series digest after migration 008
-- accidentally substituted the Bridge challenge key for the distinct canonical
-- occurrence ID. Then bind pre-armed capacity consumption to the authorization's
-- exact expected outbox series, generation, disposition, and immutable evidence.
INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('candidate-enqueue-capacity-authority', 1);

CREATE OR REPLACE FUNCTION p2tr_candidate_enqueue_series_id(
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
    domain_chain_id_value numeric;
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
    SELECT domain_chain_id
      INTO STRICT domain_chain_id_value
      FROM p2tr_complete_authorization_domain
     WHERE singleton = true;
    IF domain_chain_id_value < 1
       OR domain_chain_id_value > 9007199254740991 THEN
        RAISE EXCEPTION
            'candidate enqueue immutable domain chain ID is unsafe';
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
        ',"domainChainID":' || domain_chain_id_value::text ||
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

CREATE OR REPLACE FUNCTION p2tr_candidate_enqueue_expected_authority(
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
            WHEN 'finalized-revert'
                THEN head_record.prior_nonce_disposition_id
            WHEN 'finalized-nonce-consumed'
                THEN head_record.prior_nonce_disposition_id
            WHEN 'canonical-reappearance'
                THEN head_record.prior_cancellation_evidence_id
            WHEN 'provenance-restored'
                THEN head_record.prior_provenance_invalidation_id
        END;
    END IF;

    IF expected_generation > 32 OR expected_disposition IS NULL THEN
        RAISE EXCEPTION
            'candidate enqueue outbox generation authority is invalid';
    END IF;
    RETURN NEXT;
END;
$body$;

-- Rebind unconsumed authorizations after restoring the occurrence-bound series
-- function. Consumed authorizations retain the exact identity under which their
-- already-linked outbox generation committed.
ALTER TABLE p2tr_candidate_enqueue_authorizations
DISABLE TRIGGER p2tr_candidate_enqueue_generation_authority_guard_trigger;

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
       AND authz.generation_authority_version = 1
)
UPDATE p2tr_candidate_enqueue_authorizations authz
   SET expected_outbox_series_id = authority.expected_series_id,
       expected_outbox_generation = authority.expected_generation,
       expected_outbox_disposition = authority.expected_disposition,
       expected_outbox_predecessor_id = authority.expected_predecessor_id,
       expected_outbox_evidence_id = authority.expected_evidence_id
  FROM expected_authorities authority
 WHERE authz.token_id = authority.token_id;

ALTER TABLE p2tr_candidate_enqueue_authorizations
ENABLE TRIGGER p2tr_candidate_enqueue_generation_authority_guard_trigger;

CREATE OR REPLACE FUNCTION p2tr_signature_fraud_consume_generation_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
DECLARE
    has_exact_capacity_reservation boolean;
    unresolved_capacity_reservation_count bigint;
BEGIN
    SELECT EXISTS (
        SELECT 1
          FROM p2tr_candidate_enqueue_transaction_guard guard_row
          JOIN p2tr_candidate_enqueue_authorizations authz
            ON authz.manifest_hash = guard_row.manifest_hash
           AND authz.token_id = guard_row.token_id
           AND authz.candidate_digest = guard_row.candidate_digest
         WHERE authz.manifest_hash = NEW.activation_manifest_hash
           AND authz.consumed_at IS NULL
           AND authz.invalidated_at IS NULL
           AND authz.generation_authority_version = 1
           AND authz.expected_outbox_series_id = NEW.series_id
           AND authz.expected_outbox_generation = NEW.generation
           AND authz.expected_outbox_disposition = CASE
               WHEN NEW.generation = 0 AND NEW.generation_cause IS NULL
                   THEN 'initial'
               WHEN NEW.generation_cause IN (
                   'finalized-revert', 'finalized-nonce-consumed'
               ) THEN 'nonce-disposition'
               WHEN NEW.generation_cause = 'canonical-reappearance'
                   THEN 'canonical-reappearance'
               WHEN NEW.generation_cause = 'provenance-restored'
                   THEN 'provenance-restored'
           END
           AND authz.expected_outbox_predecessor_id IS NOT DISTINCT FROM
                NEW.previous_record_id
           AND authz.expected_outbox_evidence_id IS NOT DISTINCT FROM CASE
               WHEN NEW.generation_cause IN (
                   'finalized-revert', 'finalized-nonce-consumed'
               ) THEN NEW.prior_nonce_disposition_id
               WHEN NEW.generation_cause = 'canonical-reappearance'
                   THEN NEW.prior_cancellation_evidence_id
               WHEN NEW.generation_cause = 'provenance-restored'
                   THEN NEW.prior_provenance_invalidation_id
           END
           AND authz.observation_id = NEW.observation_id
           AND authz.challenge_key = NEW.bridge_challenge_key
           AND authz.txid = NEW.bitcoin_tx_hash
           AND authz.wtxid = NEW.bitcoin_wtxid
           AND authz.input_index = NEW.bitcoin_input_index
           AND authz.input_output_key = NEW.signing_key
           AND authz.input_binding_source_event_id =
                NEW.canonical_input_binding_source_event_id
           AND authz.candidate_provenance_generation =
                NEW.canonical_candidate_provenance_generation
           AND authz.provenance_fingerprint =
                NEW.canonical_provenance_fingerprint
           AND authz.readiness_certificate_id =
                NEW.canonical_readiness_certificate_id
           AND authz.readiness_certificate_generation =
                NEW.canonical_readiness_certificate_generation
           AND authz.funding_block_hash = NEW.canonical_funding_block_hash
           AND authz.funding_txid = NEW.canonical_funding_txid
           AND authz.funding_vout = NEW.canonical_funding_vout
           AND authz.input_wallet_id = NEW.canonical_input_wallet_id
           AND authz.input_output_key = NEW.canonical_input_output_key
           AND NEW.binding_tx_hash = CASE authz.input_binding_kind
               WHEN 'registered-wallet-output'
                   THEN decode(repeat('00', 32), 'hex')
               WHEN 'deposit-binding'
                   THEN p2tr_reverse_bytea(authz.funding_txid)
           END
           AND NEW.binding_output_index = CASE authz.input_binding_kind
               WHEN 'registered-wallet-output' THEN 0
               WHEN 'deposit-binding' THEN authz.funding_vout
           END
           AND NOT EXISTS (
               SELECT 1
                 FROM p2tr_candidate_enqueue_transaction_resolution resolution
                WHERE resolution.manifest_hash = guard_row.manifest_hash
                  AND resolution.token_id = guard_row.token_id
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM p2tr_candidate_enqueue_retry_exhaustion_alert alert
                WHERE alert.manifest_hash = guard_row.manifest_hash
                  AND alert.token_id = guard_row.token_id
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM p2tr_candidate_enqueue_non_retryable_failure failure
                WHERE failure.manifest_hash = guard_row.manifest_hash
                  AND failure.token_id = guard_row.token_id
           )
    ) INTO has_exact_capacity_reservation;

    SELECT count(*)
      INTO unresolved_capacity_reservation_count
      FROM p2tr_candidate_enqueue_transaction_guard guard_row
      JOIN p2tr_candidate_enqueue_authorizations authz
        ON authz.manifest_hash = guard_row.manifest_hash
       AND authz.token_id = guard_row.token_id
       AND authz.candidate_digest = guard_row.candidate_digest
      JOIN p2tr_watchtower_activation_manifest current_manifest
        ON current_manifest.singleton = true
       AND current_manifest.manifest_hash = guard_row.manifest_hash
     WHERE NOT EXISTS (
               SELECT 1
                 FROM p2tr_candidate_enqueue_transaction_resolution resolution
                WHERE resolution.manifest_hash = guard_row.manifest_hash
                  AND resolution.token_id = guard_row.token_id
           )
       AND NOT EXISTS (
               SELECT 1
                 FROM p2tr_candidate_enqueue_retry_exhaustion_alert alert
                WHERE alert.manifest_hash = guard_row.manifest_hash
                  AND alert.token_id = guard_row.token_id
           )
       AND NOT EXISTS (
               SELECT 1
                 FROM p2tr_candidate_enqueue_non_retryable_failure failure
                WHERE failure.manifest_hash = guard_row.manifest_hash
                  AND failure.token_id = guard_row.token_id
           );

    UPDATE p2tr_signature_fraud_challenge_outbox_capacity
       SET active_generation_count = active_generation_count + 1
     WHERE singleton = true
       AND active_generation_count < (
           SELECT (payload #>> '{outbox,maxActiveOutboxRecords}')::integer
             FROM p2tr_watchtower_activation_manifest
            WHERE singleton = true
       )
       AND (
           has_exact_capacity_reservation
           OR active_generation_count +
                unresolved_capacity_reservation_count < (
               SELECT (payload #>>
                        '{outbox,maxActiveOutboxRecords}')::integer
                 FROM p2tr_watchtower_activation_manifest
                WHERE singleton = true
           )
       );
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'manifest-bound global active outbox capacity is exhausted or reserved';
    END IF;
    RETURN NEW;
END;
$body$;
