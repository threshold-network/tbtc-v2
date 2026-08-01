-- Crash-safe retry authority for the production candidate-to-outbox boundary.
-- This migration intentionally follows the transactional outbox migration 003.

INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('candidate-enqueue-retry-journal', 1);

ALTER TABLE p2tr_candidate_enqueue_authorizations
    ADD CONSTRAINT p2tr_candidate_enqueue_authorizations_exact_authority_key
    UNIQUE (manifest_hash, token_id, candidate_digest);

ALTER TABLE p2tr_candidate_enqueue_authorizations
    ADD CONSTRAINT p2tr_candidate_enqueue_authorizations_outbox_intent_fk
    FOREIGN KEY (outbox_intent_id)
    REFERENCES p2tr_signature_fraud_challenge_outbox (record_id)
    ON DELETE RESTRICT
    NOT VALID;

CREATE TABLE p2tr_candidate_enqueue_transaction_guard (
    manifest_hash bytea NOT NULL CHECK (octet_length(manifest_hash) = 32),
    token_id bytea NOT NULL CHECK (octet_length(token_id) = 32),
    candidate_digest bytea NOT NULL CHECK (octet_length(candidate_digest) = 32),
    max_attempt_count integer NOT NULL CHECK (max_attempt_count BETWEEN 1 AND 8),
    guard_digest bytea NOT NULL CHECK (octet_length(guard_digest) = 32),
    armed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (manifest_hash, token_id),
    UNIQUE (manifest_hash, token_id, candidate_digest),
    FOREIGN KEY (manifest_hash, token_id, candidate_digest)
        REFERENCES p2tr_candidate_enqueue_authorizations
            (manifest_hash, token_id, candidate_digest)
        ON DELETE RESTRICT
);

CREATE INDEX p2tr_candidate_enqueue_transaction_guard_manifest_idx
    ON p2tr_candidate_enqueue_transaction_guard (manifest_hash, armed_at);

CREATE TABLE p2tr_candidate_enqueue_transaction_resolution (
    manifest_hash bytea NOT NULL CHECK (octet_length(manifest_hash) = 32),
    token_id bytea NOT NULL CHECK (octet_length(token_id) = 32),
    candidate_digest bytea NOT NULL CHECK (octet_length(candidate_digest) = 32),
    outbox_intent_id bytea NOT NULL CHECK (octet_length(outbox_intent_id) = 32),
    outcome_kind text NOT NULL CHECK (outcome_kind IN (
        'enqueued', 'generation-cap-exhausted'
    )),
    resolution_digest bytea NOT NULL CHECK (octet_length(resolution_digest) = 32),
    resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (manifest_hash, token_id),
    FOREIGN KEY (manifest_hash, token_id, candidate_digest)
        REFERENCES p2tr_candidate_enqueue_transaction_guard
            (manifest_hash, token_id, candidate_digest)
        ON DELETE RESTRICT,
    FOREIGN KEY (outbox_intent_id)
        REFERENCES p2tr_signature_fraud_challenge_outbox (record_id)
        ON DELETE RESTRICT
);

CREATE TABLE p2tr_candidate_enqueue_retry_exhaustion_alert (
    manifest_hash bytea NOT NULL CHECK (octet_length(manifest_hash) = 32),
    token_id bytea NOT NULL CHECK (octet_length(token_id) = 32),
    candidate_digest bytea NOT NULL CHECK (octet_length(candidate_digest) = 32),
    attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 1 AND 8),
    last_sqlstate text NOT NULL CHECK (last_sqlstate IN ('40001', '40P01')),
    detail_digest bytea NOT NULL CHECK (octet_length(detail_digest) = 32),
    activation_blocking boolean NOT NULL CHECK (activation_blocking),
    exhausted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (manifest_hash, token_id),
    FOREIGN KEY (manifest_hash, token_id, candidate_digest)
        REFERENCES p2tr_candidate_enqueue_transaction_guard
            (manifest_hash, token_id, candidate_digest)
        ON DELETE RESTRICT
);

CREATE INDEX p2tr_candidate_enqueue_retry_exhaustion_manifest_idx
    ON p2tr_candidate_enqueue_retry_exhaustion_alert
        (manifest_hash, exhausted_at);

CREATE FUNCTION p2tr_candidate_enqueue_journal_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
    RAISE EXCEPTION 'candidate enqueue retry journal is append-only';
END;
$body$;

CREATE TRIGGER p2tr_candidate_enqueue_transaction_guard_immutable_trigger
BEFORE UPDATE OR DELETE ON p2tr_candidate_enqueue_transaction_guard
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_journal_reject_mutation();

CREATE TRIGGER p2tr_candidate_enqueue_transaction_resolution_immutable_trigger
BEFORE UPDATE OR DELETE ON p2tr_candidate_enqueue_transaction_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_journal_reject_mutation();

CREATE TRIGGER p2tr_candidate_enqueue_retry_exhaustion_immutable_trigger
BEFORE UPDATE OR DELETE ON p2tr_candidate_enqueue_retry_exhaustion_alert
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_journal_reject_mutation();

CREATE FUNCTION p2tr_candidate_enqueue_resolution_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
DECLARE
    authorization_consumed_at timestamptz;
    authorization_outbox_intent_id bytea;
BEGIN
    PERFORM 1
      FROM p2tr_candidate_enqueue_transaction_guard guard_row
     WHERE guard_row.manifest_hash = NEW.manifest_hash
       AND guard_row.token_id = NEW.token_id
       AND guard_row.candidate_digest = NEW.candidate_digest
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'candidate enqueue resolution guard is absent';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM p2tr_candidate_enqueue_retry_exhaustion_alert alert
         WHERE alert.manifest_hash = NEW.manifest_hash
           AND alert.token_id = NEW.token_id
    ) THEN
        RAISE EXCEPTION 'candidate enqueue guard is already exhausted';
    END IF;

    SELECT candidate_authorization.consumed_at,
           candidate_authorization.outbox_intent_id
      INTO authorization_consumed_at, authorization_outbox_intent_id
      FROM p2tr_candidate_enqueue_authorizations candidate_authorization
     WHERE candidate_authorization.manifest_hash = NEW.manifest_hash
       AND candidate_authorization.token_id = NEW.token_id
       AND candidate_authorization.candidate_digest = NEW.candidate_digest
     FOR KEY SHARE;
    IF authorization_consumed_at IS NULL
       OR authorization_outbox_intent_id IS DISTINCT FROM NEW.outbox_intent_id THEN
        RAISE EXCEPTION 'candidate enqueue resolution lacks exact consumed authority';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM p2tr_signature_fraud_challenge_outbox outbox_record
         WHERE outbox_record.record_id = NEW.outbox_intent_id
    ) THEN
        RAISE EXCEPTION 'candidate enqueue resolution outbox intent is absent';
    END IF;

    IF NEW.outcome_kind = 'generation-cap-exhausted' AND NOT EXISTS (
        SELECT 1
          FROM p2tr_signature_fraud_challenge_critical_alert outbox_alert
         WHERE outbox_alert.record_id = NEW.outbox_intent_id
           AND outbox_alert.code = 'generation-cap-exhausted'
           AND outbox_alert.activation_blocking = true
    ) THEN
        RAISE EXCEPTION 'generation-cap resolution lacks its durable alert';
    END IF;
    RETURN NEW;
END;
$body$;

CREATE TRIGGER p2tr_candidate_enqueue_resolution_validate_trigger
BEFORE INSERT ON p2tr_candidate_enqueue_transaction_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_resolution_validate();

CREATE FUNCTION p2tr_candidate_enqueue_retry_exhaustion_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
DECLARE
    guard_attempt_count integer;
BEGIN
    SELECT guard_row.max_attempt_count
      INTO guard_attempt_count
      FROM p2tr_candidate_enqueue_transaction_guard guard_row
     WHERE guard_row.manifest_hash = NEW.manifest_hash
       AND guard_row.token_id = NEW.token_id
       AND guard_row.candidate_digest = NEW.candidate_digest
     FOR UPDATE;
    IF guard_attempt_count IS NULL OR guard_attempt_count <> NEW.attempt_count THEN
        RAISE EXCEPTION 'candidate enqueue exhaustion does not match its guard';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM p2tr_candidate_enqueue_transaction_resolution resolution
         WHERE resolution.manifest_hash = NEW.manifest_hash
           AND resolution.token_id = NEW.token_id
    ) THEN
        RAISE EXCEPTION 'candidate enqueue guard is already resolved';
    END IF;
    RETURN NEW;
END;
$body$;

CREATE TRIGGER p2tr_candidate_enqueue_retry_exhaustion_validate_trigger
BEFORE INSERT ON p2tr_candidate_enqueue_retry_exhaustion_alert
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_retry_exhaustion_validate();
