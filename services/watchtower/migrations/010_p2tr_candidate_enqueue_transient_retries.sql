-- Preserve unresolved candidate guards when bounded PostgreSQL contention or
-- statement timeouts exhaust the enqueue retry budget. These SQLSTATEs prove
-- that the attempt did not commit and must remain restart-visible rather than
-- being terminalized as an application failure.
INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('candidate-enqueue-transient-retries', 1);

DO $body$
DECLARE
    prior_constraint_name name;
BEGIN
    SELECT constraint_row.conname
      INTO STRICT prior_constraint_name
      FROM pg_constraint constraint_row
     WHERE constraint_row.conrelid =
               'p2tr_candidate_enqueue_retry_exhaustion_alert'::regclass
       AND constraint_row.contype = 'c'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%last_sqlstate%';

    EXECUTE format(
        'ALTER TABLE p2tr_candidate_enqueue_retry_exhaustion_alert DROP CONSTRAINT %I',
        prior_constraint_name
    );
END;
$body$;

ALTER TABLE p2tr_candidate_enqueue_retry_exhaustion_alert
    ADD CONSTRAINT p2tr_candidate_enqueue_retry_sqlstate_check
    CHECK (last_sqlstate IN ('40001', '40P01', '55P03', '57014'));
