-- Bind orphaned signer-boundary nonce-consumption evidence to an observed head
-- and enforce the same two-epoch finality floor as ordinary reconciliation.
--
-- Migration 003 is checksum-tracked and may already be present in production,
-- so this schema evolution must remain append-only. Existing v4 evidence rows
-- cannot be retroactively given an attested observed head; NOT VALID
-- grandfathers those immutable rows while PostgreSQL enforces the complete v5
-- evidence shape for every new insert.

INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('signer-boundary-nonce-finality', 1);

ALTER TABLE p2tr_signature_fraud_challenge_signer_boundary_resolution
    ADD COLUMN nonce_consumption_observed_head_block_number bigint
        CONSTRAINT p2tr_signer_boundary_observed_head_number_valid
        CHECK (
            nonce_consumption_observed_head_block_number IS NULL
            OR nonce_consumption_observed_head_block_number >= 0
        ),
    ADD COLUMN nonce_consumption_observed_head_block_hash bytea
        CONSTRAINT p2tr_signer_boundary_observed_head_hash_valid
        CHECK (
            nonce_consumption_observed_head_block_hash IS NULL
            OR octet_length(nonce_consumption_observed_head_block_hash) = 32
        );

ALTER TABLE p2tr_signature_fraud_challenge_signer_boundary_resolution
    ADD CONSTRAINT p2tr_signer_boundary_nonce_finality_v5
    CHECK (
        (
            nonce_consumption_transaction_hash IS NULL
            AND nonce_consumption_observed_head_block_number IS NULL
            AND nonce_consumption_observed_head_block_hash IS NULL
        )
        OR (
            nonce_consumption_transaction_hash IS NOT NULL
            AND nonce_consumption_observed_head_block_number IS NOT NULL
            AND nonce_consumption_observed_head_block_hash IS NOT NULL
            AND nonce_consumption_observed_head_block_number
                - nonce_consumption_finalized_block_number >= 64
        )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION p2tr_signature_fraud_guard_signer_boundary_resolution()
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

    IF NEW.outcome = 'never-invoked'
       AND NEW.provider_tombstone_receipt IS NULL THEN
        RAISE EXCEPTION
            'orphaned signer boundary never-invoked resolution requires a provider tombstone';
    END IF;

    -- The consumed nonce must be the one this boundary actually reserved, on
    -- the chain the record is bound to.
    IF NEW.outcome = 'nonce-consumed' THEN
        IF NEW.nonce_consumption_transaction_hash IS NULL THEN
            RAISE EXCEPTION
                'orphaned signer boundary nonce-consumed resolution requires consumption evidence';
        END IF;
        IF NEW.nonce_consumption_nonce IS DISTINCT FROM outbox_record.reserved_nonce
           OR NEW.nonce_consumption_chain_id IS DISTINCT FROM outbox_record.chain_id THEN
            RAISE EXCEPTION
                'orphaned signer boundary nonce consumption names another sender lane';
        END IF;
    END IF;

    IF NEW.resolution_evidence_digest <> sha256(
           convert_to(
               'tbtc-p2tr-signer-boundary-independent-resolution-v5',
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
           || CASE WHEN NEW.provider_tombstone_receipt IS NULL
                   THEN decode(repeat('00', 32), 'hex')
                   ELSE NEW.signer_invocation_id END
           || COALESCE(
                  sha256(NEW.provider_tombstone_receipt),
                  decode(repeat('00', 32), 'hex')
              )
           || int8send(COALESCE(NEW.provider_tombstone_at_unix_ms, 0))
           || int8send(COALESCE(NEW.nonce_consumption_chain_id, 0)::bigint)
           || int8send(COALESCE(NEW.nonce_consumption_nonce, 0))
           || int8send(COALESCE(NEW.nonce_consumption_account_nonce, 0))
           || int8send(COALESCE(NEW.nonce_consumption_read_at_block, 0))
           || COALESCE(
                  NEW.nonce_consumption_transaction_hash,
                  decode(repeat('00', 32), 'hex')
              )
           || int8send(
                  COALESCE(NEW.nonce_consumption_finalized_block_number, 0)
              )
           || COALESCE(
                  NEW.nonce_consumption_finalized_block_hash,
                  decode(repeat('00', 32), 'hex')
              )
           || int8send(
                  COALESCE(
                      NEW.nonce_consumption_observed_head_block_number,
                      0
                  )
              )
           || COALESCE(
                  NEW.nonce_consumption_observed_head_block_hash,
                  decode(repeat('00', 32), 'hex')
              )
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
