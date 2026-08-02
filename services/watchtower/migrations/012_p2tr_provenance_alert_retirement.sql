-- A provenance-reconciliation critical alert mirrors the record-scoped
-- provenance incident journal. It has no independent admissible resolution,
-- so append-only retirement of every incident for that record must also stop
-- the duplicate alert from blocking readiness.
CREATE OR REPLACE FUNCTION p2tr_signature_fraud_outbox_activation_revalidation(
    activation_manifest_hash bytea,
    sampled_at_unix_ms bigint
)
RETURNS TABLE (
    activation_blocking_critical_alert_count bigint,
    ambiguous_transaction_count bigint,
    unresolved_legacy_quarantine_count bigint,
    recovery_backlog_count bigint,
    active_generation_count bigint,
    configured_signer_lane_count bigint,
    configured_signer_lane_set_hash text,
    quarantined_signer_lane_count bigint,
    active_old_manifest_generation_count bigint,
    stale_manifest_generation_successor_count bigint,
    active_signer_invocation_count bigint,
    active_nonce_release_attempt_count bigint
)
LANGUAGE sql
STABLE
AS $$
    SELECT (
             (
               SELECT count(*)
                 FROM p2tr_signature_fraud_challenge_critical_alert a
                WHERE a.activation_blocking
                  AND NOT EXISTS (
                      SELECT 1
                        FROM p2tr_signature_fraud_challenge_critical_alert_resolution ar
                       WHERE ar.alert_id = a.alert_id
                  )
                  AND (
                      a.code <> 'provenance-reconciliation-incident'
                      OR EXISTS (
                          SELECT 1
                            FROM p2tr_signature_fraud_challenge_provenance_incident pi
                           WHERE pi.record_id = a.record_id
                             AND pi.activation_blocking
                             AND NOT EXISTS (
                                 SELECT 1
                                   FROM p2tr_signature_fraud_challenge_provenance_incident_resolution ir
                                  WHERE ir.incident_id = pi.incident_id
                             )
                      )
                  )
             ) + (
               SELECT count(*)
                 FROM p2tr_signature_fraud_challenge_provenance_incident i
                WHERE i.activation_blocking
                  AND NOT EXISTS (
                      SELECT 1
                        FROM p2tr_signature_fraud_challenge_provenance_incident_resolution ir
                       WHERE ir.incident_id = i.incident_id
                  )
             )
           )::bigint,
           (
             (
               SELECT count(*)
                 FROM p2tr_signature_fraud_challenge_nonce_release_request r
                 JOIN LATERAL (
                   SELECT x.result_kind
                     FROM p2tr_signature_fraud_challenge_nonce_release_attempt a
                     LEFT JOIN p2tr_signature_fraud_challenge_nonce_release_result x
                       ON x.release_request_id = a.release_request_id
                      AND x.attempt_sequence = a.attempt_sequence
                    WHERE a.release_request_id = r.release_request_id
                    ORDER BY a.attempt_sequence DESC
                    LIMIT 1
                 ) latest ON true
                WHERE NOT EXISTS (
                      SELECT 1
                        FROM p2tr_signature_fraud_challenge_nonce_release_terminal ok
                       WHERE ok.release_request_id = r.release_request_id
                  )
                  AND (latest.result_kind IS NULL OR latest.result_kind NOT IN (
                      'released', 'already-released'
                  ))
             ) + (
               SELECT count(*)
                 FROM p2tr_signature_fraud_challenge_outbox_broadcast_attempt a
                 JOIN p2tr_signature_fraud_challenge_outbox o
                   ON o.record_id = a.record_id
                  AND o.generation = a.generation
                 LEFT JOIN p2tr_signature_fraud_challenge_outbox_broadcast_acknowledgement x
                   ON x.record_id = a.record_id
                  AND x.generation = a.generation
                  AND x.variant_sequence = a.variant_sequence
                  AND x.attempt_number = a.attempt_number
                WHERE o.status NOT IN (
                    'accepted-own',
                    'satisfied-external',
                    'terminal-reverted',
                    'terminal-nonce-consumed',
                    'generation-required',
                    'cancelled-before-broadcast',
                    'cancelled-honest-spend',
                    'cancelled-reorg',
                    'cancelled-provenance-invalidated'
                )
                  AND NOT EXISTS (
                      SELECT 1
                        FROM p2tr_signature_fraud_challenge_outbox_broadcast_attempt newer
                       WHERE newer.record_id = a.record_id
                         AND newer.generation = a.generation
                         AND newer.variant_sequence = a.variant_sequence
                         AND newer.attempt_number > a.attempt_number
                  )
                  AND (x.record_id IS NULL OR x.result = 'ambiguous')
             )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_legacy_submission_quarantine q
              WHERE NOT EXISTS (
                    SELECT 1
                      FROM p2tr_signature_fraud_legacy_submission_quarantine_resolution qr
                     WHERE qr.observation_id = q.observation_id
                )
           )::bigint,
           (
             (
               SELECT count(*)
                 FROM p2tr_signature_fraud_challenge_outbox o
                WHERE o.status = 'preparing'
                  AND o.preparation_lease_expires_at_unix_ms
                      <= p2tr_signature_fraud_outbox_activation_revalidation.sampled_at_unix_ms
             ) + (
               SELECT count(*)
                 FROM p2tr_signature_fraud_challenge_nonce_release_request r
                WHERE NOT EXISTS (
                      SELECT 1
                        FROM p2tr_signature_fraud_challenge_nonce_release_terminal x
                       WHERE x.release_request_id = r.release_request_id
                  )
             )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_challenge_outbox o
              WHERE o.status NOT IN (
                  'accepted-own',
                  'satisfied-external',
                  'terminal-reverted',
                  'terminal-nonce-consumed',
                  'generation-required',
                  'cancelled-before-broadcast',
                  'cancelled-honest-spend',
                  'cancelled-reorg',
                  'cancelled-provenance-invalidated'
              )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_signer_lane_configuration c
              WHERE c.activation_manifest_hash
                    = p2tr_signature_fraud_outbox_activation_revalidation.activation_manifest_hash
                AND c.enabled
           )::bigint,
           (
             '0x' || encode(
               sha256(
                 convert_to(
                   'tbtc-p2tr-production-signer-lane-set/v1',
                   'UTF8'
                 ) || decode('00', 'hex') || coalesce(
                   (
                     SELECT string_agg(
                              c.configuration_hash,
                              ''::bytea
                              ORDER BY c.configuration_hash
                            )
                       FROM p2tr_signature_fraud_signer_lane_configuration c
                      WHERE c.activation_manifest_hash
                            = p2tr_signature_fraud_outbox_activation_revalidation.activation_manifest_hash
                        AND c.enabled
                   ),
                   ''::bytea
                 )
               ),
               'hex'
             )
           )::text,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_signer_lane_configuration c
              WHERE c.activation_manifest_hash
                    = p2tr_signature_fraud_outbox_activation_revalidation.activation_manifest_hash
                AND c.enabled
                AND EXISTS (
                    SELECT 1
                      FROM p2tr_signature_fraud_challenge_signer_quarantine q
                     WHERE q.chain_id = c.chain_id
                       AND (q.signer_lane_id = c.signer_lane_id
                            OR q.signer_identity = c.signer_identity
                            OR q.expected_sender = c.sender)
                )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_challenge_outbox o
              WHERE o.activation_manifest_hash
                    <> p2tr_signature_fraud_outbox_activation_revalidation.activation_manifest_hash
                AND o.status NOT IN (
                    'accepted-own',
                    'satisfied-external',
                    'terminal-reverted',
                    'terminal-nonce-consumed',
                    'generation-required',
                    'cancelled-before-broadcast',
                    'cancelled-honest-spend',
                    'cancelled-reorg',
                    'cancelled-provenance-invalidated'
                )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_challenge_outbox o
              WHERE o.status = 'generation-required'
                AND o.activation_manifest_hash
                    <> p2tr_signature_fraud_outbox_activation_revalidation.activation_manifest_hash
                AND NOT EXISTS (
                    SELECT 1
                      FROM p2tr_signature_fraud_challenge_outbox s
                     WHERE s.previous_record_id = o.record_id
                )
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_challenge_outbox o
              WHERE o.active_signer_invocation_started_at_unix_ms IS NOT NULL
           )::bigint,
           (
             SELECT count(*)
               FROM p2tr_signature_fraud_nonce_allocator_safety_barrier b
              WHERE b.active_release_request_id IS NOT NULL
           )::bigint;
$$;
