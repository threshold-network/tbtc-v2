-- Preserve exact signer bytes that arrive after independently attested nonce
-- consumption clears an orphaned signer boundary. Migration 003 is
-- checksum-tracked, so the late-artifact guard evolves append-only here.

INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('signer-boundary-late-artifact', 1);

CREATE OR REPLACE FUNCTION p2tr_signature_fraud_validate_late_signed_artifact_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    outbox_record p2tr_signature_fraud_challenge_outbox%ROWTYPE;
    fee_policy p2tr_signature_fraud_challenge_fee_policy%ROWTYPE;
BEGIN
    SELECT * INTO outbox_record
      FROM p2tr_signature_fraud_challenge_outbox
     WHERE record_id = NEW.record_id
       AND generation = NEW.generation
     FOR SHARE;

    IF NOT FOUND
       OR outbox_record.canonical_provenance_fingerprint <>
            NEW.expected_provenance_fingerprint
       OR outbox_record.nonce_reservation_id <>
            NEW.expected_reservation_id
       OR outbox_record.intent_id <> NEW.intent_id
       OR outbox_record.chain_id <> NEW.chain_id
       OR outbox_record.reserved_sender <> NEW.sender
       OR outbox_record.reserved_nonce <> NEW.transaction_nonce
       OR outbox_record.signer_lane_id <> NEW.signer_lane_id
       OR outbox_record.signer_identity <> NEW.signer_identity
       OR (
            outbox_record.signer_invocation_started_at_unix_ms IS NULL
            AND outbox_record.active_signer_invocation_started_at_unix_ms IS NULL
            AND NOT EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_signer_boundary_resolution
                 WHERE record_id = NEW.record_id
                   AND outcome = 'nonce-consumed'
                   AND nonce_reservation_id = NEW.expected_reservation_id
            )
       )
       OR (
            outbox_record.signer_invocation_started_at_unix_ms IS NOT NULL
            AND NEW.captured_at_unix_ms <
                outbox_record.signer_invocation_started_at_unix_ms
       )
       OR (
            outbox_record.active_signer_invocation_started_at_unix_ms IS NOT NULL
            AND NEW.captured_at_unix_ms <
                outbox_record.active_signer_invocation_started_at_unix_ms
       ) THEN
        RAISE EXCEPTION 'late signed artifact does not match its durable signer boundary';
    END IF;

    SELECT * INTO fee_policy
      FROM p2tr_signature_fraud_challenge_fee_policy
     WHERE record_id = NEW.record_id
       AND signer_lane_id = NEW.signer_lane_id
       AND signer_identity = NEW.signer_identity
       AND sender = NEW.sender
       AND policy_hash = outbox_record.fee_policy_hash
     FOR SHARE;

    IF NOT FOUND
       OR NEW.gas_limit > fee_policy.max_gas_limit
       OR NEW.max_fee_per_gas > fee_policy.max_fee_per_gas
       OR NEW.max_priority_fee_per_gas > fee_policy.max_priority_fee_per_gas
       OR NEW.gas_limit * NEW.max_fee_per_gas > fee_policy.max_total_fee_wei THEN
        RAISE EXCEPTION 'late signed artifact exceeds its manifest-bound fee policy';
    END IF;
    RETURN NEW;
END;
$$;
