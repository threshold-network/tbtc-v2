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

-- A non-PostgreSQL failure (for example canonical candidate invalidation)
-- cannot be replayed safely, but it must not strand the separately committed
-- guard forever. This append-only disposition records that the guarded
-- transaction rolled back without consuming its authorization or capacity.
CREATE TABLE p2tr_candidate_enqueue_non_retryable_failure (
    manifest_hash bytea NOT NULL CHECK (octet_length(manifest_hash) = 32),
    token_id bytea NOT NULL CHECK (octet_length(token_id) = 32),
    candidate_digest bytea NOT NULL CHECK (octet_length(candidate_digest) = 32),
    failure_digest bytea NOT NULL CHECK (octet_length(failure_digest) = 32),
    failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (manifest_hash, token_id),
    FOREIGN KEY (manifest_hash, token_id, candidate_digest)
        REFERENCES p2tr_candidate_enqueue_transaction_guard
            (manifest_hash, token_id, candidate_digest)
        ON DELETE RESTRICT
);

-- An unresolved guard for the current manifest owns one global active-
-- generation slot until a durable resolution, retry-exhaustion alert, or
-- non-retryable rollback disposition exists.
-- This closes the cross-transaction gap
-- between committing the crash marker and inserting the outbox generation:
-- ordinary writers count every unresolved reservation, while the exact
-- manifest/candidate/observation-bound holder may consume its own slot. A
-- Any terminal disposition releases the reservation without mutating the
-- append-only guard. Authorization expiry alone cannot erase crash evidence
-- or release capacity that no restart path can replay.
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
          JOIN p2tr_candidate_enqueue_authorizations candidate_authorization
            ON candidate_authorization.manifest_hash = guard_row.manifest_hash
           AND candidate_authorization.token_id = guard_row.token_id
           AND candidate_authorization.candidate_digest =
                guard_row.candidate_digest
         WHERE guard_row.manifest_hash = NEW.activation_manifest_hash
           AND guard_row.candidate_digest = NEW.canonical_candidate_digest
           AND candidate_authorization.observation_id = NEW.observation_id
           AND candidate_authorization.challenge_key = NEW.bridge_challenge_key
           AND candidate_authorization.txid = NEW.bitcoin_tx_hash
           AND candidate_authorization.wtxid = NEW.bitcoin_wtxid
           AND candidate_authorization.input_index = NEW.bitcoin_input_index
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
      JOIN p2tr_candidate_enqueue_authorizations candidate_authorization
        ON candidate_authorization.manifest_hash = guard_row.manifest_hash
       AND candidate_authorization.token_id = guard_row.token_id
       AND candidate_authorization.candidate_digest =
            guard_row.candidate_digest
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
        RAISE EXCEPTION 'manifest-bound global active outbox capacity is exhausted or reserved';
    END IF;
    RETURN NEW;
END;
$body$;

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

CREATE TRIGGER p2tr_candidate_enqueue_non_retryable_failure_immutable_trigger
BEFORE UPDATE OR DELETE ON p2tr_candidate_enqueue_non_retryable_failure
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
    IF EXISTS (
        SELECT 1
          FROM p2tr_candidate_enqueue_non_retryable_failure failure
         WHERE failure.manifest_hash = NEW.manifest_hash
           AND failure.token_id = NEW.token_id
    ) THEN
        RAISE EXCEPTION 'candidate enqueue guard already failed non-retryably';
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
    IF EXISTS (
        SELECT 1
          FROM p2tr_candidate_enqueue_non_retryable_failure failure
         WHERE failure.manifest_hash = NEW.manifest_hash
           AND failure.token_id = NEW.token_id
    ) THEN
        RAISE EXCEPTION 'candidate enqueue guard already failed non-retryably';
    END IF;
    RETURN NEW;
END;
$body$;

CREATE TRIGGER p2tr_candidate_enqueue_retry_exhaustion_validate_trigger
BEFORE INSERT ON p2tr_candidate_enqueue_retry_exhaustion_alert
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_retry_exhaustion_validate();

CREATE FUNCTION p2tr_candidate_enqueue_non_retryable_failure_validate()
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
        RAISE EXCEPTION 'non-retryable candidate enqueue failure guard is absent';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM p2tr_candidate_enqueue_transaction_resolution resolution
         WHERE resolution.manifest_hash = NEW.manifest_hash
           AND resolution.token_id = NEW.token_id
    ) OR EXISTS (
        SELECT 1
          FROM p2tr_candidate_enqueue_retry_exhaustion_alert alert
         WHERE alert.manifest_hash = NEW.manifest_hash
           AND alert.token_id = NEW.token_id
    ) THEN
        RAISE EXCEPTION 'candidate enqueue guard already has a terminal disposition';
    END IF;

    SELECT authz.consumed_at, authz.outbox_intent_id
      INTO authorization_consumed_at, authorization_outbox_intent_id
      FROM p2tr_candidate_enqueue_authorizations authz
     WHERE authz.manifest_hash = NEW.manifest_hash
       AND authz.token_id = NEW.token_id
       AND authz.candidate_digest = NEW.candidate_digest
     FOR KEY SHARE;
    IF authorization_consumed_at IS NOT NULL
       OR authorization_outbox_intent_id IS NOT NULL THEN
        RAISE EXCEPTION 'non-retryable failure cannot resolve consumed authority';
    END IF;
    RETURN NEW;
END;
$body$;

CREATE TRIGGER p2tr_candidate_enqueue_non_retryable_failure_validate_trigger
BEFORE INSERT ON p2tr_candidate_enqueue_non_retryable_failure
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_non_retryable_failure_validate();
