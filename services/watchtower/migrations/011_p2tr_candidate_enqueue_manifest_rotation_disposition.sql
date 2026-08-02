-- Manifest rotation invalidates every unconsumed authorization. Atomically
-- terminalize any still-armed guard from the replaced manifest so it remains
-- visible as append-only audit evidence without blocking all future readiness.
INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('candidate-enqueue-manifest-rotation-disposition', 1);

ALTER TABLE p2tr_candidate_enqueue_non_retryable_failure
ADD CONSTRAINT p2tr_candidate_enqueue_non_retryable_failure_exact_unique
UNIQUE (manifest_hash, token_id, candidate_digest, failure_digest);

CREATE TABLE p2tr_candidate_enqueue_manifest_rotation_disposition (
    manifest_hash bytea NOT NULL CHECK (octet_length(manifest_hash) = 32),
    token_id bytea NOT NULL CHECK (octet_length(token_id) = 32),
    candidate_digest bytea NOT NULL CHECK (octet_length(candidate_digest) = 32),
    failure_digest bytea NOT NULL CHECK (octet_length(failure_digest) = 32),
    replacement_manifest_hash bytea NOT NULL CHECK (
        octet_length(replacement_manifest_hash) = 32
        AND replacement_manifest_hash <> manifest_hash
    ),
    replacement_activation_sequence bigint NOT NULL CHECK (
        replacement_activation_sequence > 0
    ),
    disposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (manifest_hash, token_id),
    FOREIGN KEY (manifest_hash, token_id, candidate_digest)
        REFERENCES p2tr_candidate_enqueue_transaction_guard
            (manifest_hash, token_id, candidate_digest)
        ON DELETE RESTRICT,
    FOREIGN KEY (
        manifest_hash,
        token_id,
        candidate_digest,
        failure_digest
    ) REFERENCES p2tr_candidate_enqueue_non_retryable_failure (
        manifest_hash,
        token_id,
        candidate_digest,
        failure_digest
    ) ON DELETE RESTRICT
);

CREATE TRIGGER p2tr_candidate_enqueue_manifest_rotation_disposition_immutable_trigger
BEFORE UPDATE OR DELETE
ON p2tr_candidate_enqueue_manifest_rotation_disposition
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_journal_reject_mutation();

CREATE FUNCTION p2tr_candidate_enqueue_dispose_stale_manifest_guards(
    stale_manifest_hash bytea,
    replacement_manifest_hash_value bytea,
    replacement_activation_sequence_value bigint
)
RETURNS void
LANGUAGE plpgsql
AS $body$
BEGIN
    IF stale_manifest_hash = replacement_manifest_hash_value THEN
        RETURN;
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM p2tr_watchtower_activation_manifest current_manifest
         WHERE current_manifest.singleton = true
           AND current_manifest.manifest_hash = replacement_manifest_hash_value
           AND current_manifest.activation_sequence =
                replacement_activation_sequence_value
    ) THEN
        RAISE EXCEPTION
            'candidate enqueue rotation disposition lacks the current manifest';
    END IF;

    INSERT INTO p2tr_candidate_enqueue_non_retryable_failure (
        manifest_hash,
        token_id,
        candidate_digest,
        failure_digest
    )
    SELECT guard_row.manifest_hash,
           guard_row.token_id,
           guard_row.candidate_digest,
           sha256(
               convert_to(
                   'p2tr-candidate-enqueue-manifest-rotation-failure-v1',
                   'UTF8'
               )
               || guard_row.manifest_hash
               || guard_row.token_id
               || guard_row.candidate_digest
               || replacement_manifest_hash_value
               || int8send(replacement_activation_sequence_value)
           )
      FROM p2tr_candidate_enqueue_transaction_guard guard_row
      JOIN p2tr_candidate_enqueue_authorizations authz
        ON authz.manifest_hash = guard_row.manifest_hash
       AND authz.token_id = guard_row.token_id
       AND authz.candidate_digest = guard_row.candidate_digest
     WHERE guard_row.manifest_hash = stale_manifest_hash
       AND authz.consumed_at IS NULL
       AND authz.outbox_intent_id IS NULL
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
    ON CONFLICT (manifest_hash, token_id) DO NOTHING;

    INSERT INTO p2tr_candidate_enqueue_manifest_rotation_disposition (
        manifest_hash,
        token_id,
        candidate_digest,
        failure_digest,
        replacement_manifest_hash,
        replacement_activation_sequence
    )
    SELECT guard_row.manifest_hash,
           guard_row.token_id,
           guard_row.candidate_digest,
           failure.failure_digest,
           replacement_manifest_hash_value,
           replacement_activation_sequence_value
      FROM p2tr_candidate_enqueue_transaction_guard guard_row
      JOIN p2tr_candidate_enqueue_non_retryable_failure failure
        ON failure.manifest_hash = guard_row.manifest_hash
       AND failure.token_id = guard_row.token_id
       AND failure.candidate_digest = guard_row.candidate_digest
     WHERE guard_row.manifest_hash = stale_manifest_hash
       AND failure.failure_digest = sha256(
           convert_to(
               'p2tr-candidate-enqueue-manifest-rotation-failure-v1',
               'UTF8'
           )
           || guard_row.manifest_hash
           || guard_row.token_id
           || guard_row.candidate_digest
           || replacement_manifest_hash_value
           || int8send(replacement_activation_sequence_value)
       )
    ON CONFLICT (manifest_hash, token_id) DO NOTHING;
END;
$body$;

-- Backfill any guard stranded by a rotation that committed before this
-- migration. The current manifest is the only available replacement point and
-- its monotonic activation sequence makes the disposition deterministic.
DO $body$
DECLARE
    current_manifest_hash bytea;
    current_activation_sequence bigint;
    stale_manifest_hash bytea;
BEGIN
    SELECT manifest_hash, activation_sequence
      INTO current_manifest_hash, current_activation_sequence
      FROM p2tr_watchtower_activation_manifest
     WHERE singleton = true;

    IF FOUND THEN
        FOR stale_manifest_hash IN
            SELECT DISTINCT guard_row.manifest_hash
              FROM p2tr_candidate_enqueue_transaction_guard guard_row
             WHERE guard_row.manifest_hash <> current_manifest_hash
        LOOP
            PERFORM p2tr_candidate_enqueue_dispose_stale_manifest_guards(
                stale_manifest_hash,
                current_manifest_hash,
                current_activation_sequence
            );
        END LOOP;
    END IF;
END;
$body$;

CREATE FUNCTION p2tr_candidate_enqueue_dispose_guards_after_manifest_rotation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
    PERFORM p2tr_candidate_enqueue_dispose_stale_manifest_guards(
        OLD.manifest_hash,
        NEW.manifest_hash,
        NEW.activation_sequence
    );
    RETURN NEW;
END;
$body$;

CREATE TRIGGER p2tr_candidate_enqueue_dispose_guards_after_manifest_rotation_trigger
AFTER UPDATE ON p2tr_watchtower_activation_manifest
FOR EACH ROW
EXECUTE FUNCTION p2tr_candidate_enqueue_dispose_guards_after_manifest_rotation();
