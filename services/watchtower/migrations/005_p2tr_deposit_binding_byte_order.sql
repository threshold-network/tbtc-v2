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

UPDATE p2tr_bitcoin_candidate_observations
   SET binding_tx_hash = p2tr_reverse_bytea(local_funding_txid)
 WHERE binding_kind = 'deposit';

ALTER TABLE p2tr_bitcoin_candidate_observations
ADD CONSTRAINT p2tr_candidate_observation_binding_matches_funding
CHECK (
    (binding_kind = 'registered-wallet-output' AND signing_key = wallet_id AND
     binding_tx_hash = decode(repeat('00', 32), 'hex') AND
     binding_output_index = 0) OR
    (binding_kind = 'deposit' AND signing_key = output_key AND
     binding_tx_hash = p2tr_reverse_bytea(local_funding_txid) AND
     binding_output_index = local_funding_vout)
);

ALTER TABLE p2tr_signature_fraud_challenge_outbox
ADD CONSTRAINT p2tr_outbox_deposit_binding_uses_bridge_byte_order
CHECK (
    canonical_input_binding_kind <> 'deposit-binding' OR
    binding_tx_hash = p2tr_reverse_bytea(canonical_funding_txid)
);

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
