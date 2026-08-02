-- A manifest rotation may terminalize an armed candidate-enqueue guard that
-- never reached the outbox. The disposition is immutable evidence, but it
-- must remain activation-blocking until an operator explicitly acknowledges
-- the abandoned confirmed fraud candidate with independent retained evidence.
INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('candidate-enqueue-manifest-rotation-resolution', 1);

ALTER TABLE p2tr_candidate_enqueue_manifest_rotation_disposition
ADD CONSTRAINT p2tr_candidate_enqueue_rotation_disposition_exact_unique
UNIQUE (
    manifest_hash,
    token_id,
    candidate_digest,
    failure_digest,
    replacement_manifest_hash,
    replacement_activation_sequence
);

CREATE TABLE p2tr_candidate_enqueue_manifest_rotation_resolution (
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
        failure_digest,
        replacement_manifest_hash,
        replacement_activation_sequence
    ) REFERENCES p2tr_candidate_enqueue_manifest_rotation_disposition (
        manifest_hash,
        token_id,
        candidate_digest,
        failure_digest,
        replacement_manifest_hash,
        replacement_activation_sequence
    ) ON DELETE RESTRICT
);

CREATE TRIGGER p2tr_candidate_enqueue_rotation_resolution_immutable_trigger
BEFORE UPDATE OR DELETE
ON p2tr_candidate_enqueue_manifest_rotation_resolution
FOR EACH ROW EXECUTE FUNCTION p2tr_candidate_enqueue_journal_reject_mutation();
