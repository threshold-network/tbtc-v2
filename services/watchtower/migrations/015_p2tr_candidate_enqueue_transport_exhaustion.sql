-- A confirmed pre-COMMIT transport abort is safe to replay, but exhausting
-- the bounded retry budget must not abandon its confirmed fraud candidate.
-- Record it as a distinct variant of the append-only, activation-blocking
-- retry-exhaustion journal so the existing operator resolution flow applies.
INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('candidate-enqueue-transport-exhaustion', 1);

ALTER TABLE p2tr_candidate_enqueue_retry_exhaustion_alert
    DROP CONSTRAINT p2tr_candidate_enqueue_retry_sqlstate_check,
    ALTER COLUMN last_sqlstate DROP NOT NULL,
    ADD COLUMN last_abort_reason text,
    ADD COLUMN failure_digest bytea CHECK (
        octet_length(failure_digest) = 32
    ),
    ADD CONSTRAINT p2tr_candidate_enqueue_retry_failure_kind_check CHECK (
        (
            last_sqlstate IN ('40001', '40P01', '55P03', '57014')
            AND last_abort_reason IS NULL
            AND failure_digest IS NULL
        )
        OR (
            last_sqlstate IS NULL
            AND last_abort_reason = 'pre-commit-transport-abort'
            AND failure_digest IS NOT NULL
        )
    );
