-- Make the durable signed-variant gas invariant the exact one the runtime
-- enforces.
--
-- Migration 003 is checksum-tracked, so the trigger function is replaced here
-- rather than edited there. The only change is the gas-limit comparison: 003
-- accepted anything at or below the
-- manifest value, while the runtime validator has always required the exact
-- manifest-bound limit. A variant signed below it is affordable and passes the
-- fee ceilings, but runs out of gas on chain and consumes the reserved nonce
-- for nothing. Any writer that bypasses the runtime validator -- an older
-- worker during a rolling deployment, or a direct store write -- could make
-- exactly that transaction durable and broadcastable, so the database has to
-- hold the strict invariant too.
--
-- Replacing the function needs no backfill: it is validated per insert, and
-- every variant that reached the old trigger legitimately was produced by the
-- runtime validator and therefore already sits at the exact limit.

INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('signed-variant-exact-gas', 1);

CREATE OR REPLACE FUNCTION p2tr_signature_fraud_validate_variant_append()
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
       OR NEW.gas_limit <> fee_policy.max_gas_limit
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
