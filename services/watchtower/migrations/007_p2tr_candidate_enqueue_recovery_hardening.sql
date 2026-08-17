-- A committed enqueue guard is the durable authority for its exact candidate
-- after the short-lived authorization expires. Migration 006 only upgraded
-- live version-0 authorizations, so repair every still-unresolved guard-backed
-- row under the migration runner's canonical/outbox writer fence.
INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('candidate-enqueue-recovery-hardening', 1);

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
      JOIN p2tr_candidate_enqueue_transaction_guard guard_row
        ON guard_row.manifest_hash = authz.manifest_hash
       AND guard_row.token_id = authz.token_id
       AND guard_row.candidate_digest = authz.candidate_digest
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
       AND authz.generation_authority_version = 0
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
)
UPDATE p2tr_candidate_enqueue_authorizations authz
   SET generation_authority_version = 1,
       expected_outbox_series_id = authority.expected_series_id,
       expected_outbox_generation = authority.expected_generation,
       expected_outbox_disposition = authority.expected_disposition,
       expected_outbox_predecessor_id = authority.expected_predecessor_id,
       expected_outbox_evidence_id = authority.expected_evidence_id
  FROM expected_authorities authority
 WHERE authz.token_id = authority.token_id;

ALTER TABLE p2tr_candidate_enqueue_authorizations
ENABLE TRIGGER p2tr_candidate_enqueue_generation_authority_guard_trigger;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM p2tr_candidate_enqueue_authorizations authz
          JOIN p2tr_candidate_enqueue_transaction_guard guard_row
            ON guard_row.manifest_hash = authz.manifest_hash
           AND guard_row.token_id = authz.token_id
           AND guard_row.candidate_digest = authz.candidate_digest
         WHERE authz.consumed_at IS NULL
           AND authz.invalidated_at IS NULL
           AND authz.generation_authority_version = 0
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
    ) THEN
        RAISE EXCEPTION
            'unresolved candidate enqueue guard lacks generation-bound authority';
    END IF;
END
$$;

-- Retry exhaustion remains immutable incident evidence and a terminal guard
-- disposition. This paired append-only operator journal only acknowledges a
-- reviewed incident so the current manifest is not blocked forever.
ALTER TABLE p2tr_candidate_enqueue_retry_exhaustion_alert
ADD CONSTRAINT p2tr_candidate_enqueue_retry_alert_exact_unique
UNIQUE (manifest_hash, token_id, candidate_digest, detail_digest);

CREATE TABLE p2tr_candidate_enqueue_retry_exhaustion_resolution (
    manifest_hash bytea NOT NULL CHECK (octet_length(manifest_hash) = 32),
    token_id bytea NOT NULL CHECK (octet_length(token_id) = 32),
    candidate_digest bytea NOT NULL CHECK (octet_length(candidate_digest) = 32),
    alert_detail_digest bytea NOT NULL CHECK (
        octet_length(alert_detail_digest) = 32
    ),
    resolution_digest bytea NOT NULL CHECK (
        octet_length(resolution_digest) = 32
    ),
    reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1024),
    resolved_at_unix_ms bigint NOT NULL CHECK (
        resolved_at_unix_ms BETWEEN 0 AND 9007199254740991
    ),
    PRIMARY KEY (manifest_hash, token_id),
    FOREIGN KEY (
        manifest_hash,
        token_id,
        candidate_digest,
        alert_detail_digest
    ) REFERENCES p2tr_candidate_enqueue_retry_exhaustion_alert (
        manifest_hash,
        token_id,
        candidate_digest,
        detail_digest
    ) ON DELETE RESTRICT
);

CREATE TRIGGER p2tr_candidate_enqueue_retry_resolution_immutable_trigger
BEFORE UPDATE OR DELETE
ON p2tr_candidate_enqueue_retry_exhaustion_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_journal_reject_mutation();
