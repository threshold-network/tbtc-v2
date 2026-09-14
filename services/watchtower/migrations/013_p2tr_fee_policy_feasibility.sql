-- A prepared challenge transaction uses the lane's exact max gas limit and a
-- strictly positive per-gas fee. The total-fee cap must therefore fund at
-- least one wei per unit of that fixed gas limit.
ALTER TABLE p2tr_signature_fraud_signer_lane_configuration
ADD CONSTRAINT p2tr_signer_lane_total_fee_funds_fixed_gas
CHECK (max_total_fee_wei >= max_gas_limit);

ALTER TABLE p2tr_signature_fraud_challenge_fee_policy
ADD CONSTRAINT p2tr_challenge_fee_policy_total_fee_funds_fixed_gas
CHECK (max_total_fee_wei >= max_gas_limit);

INSERT INTO p2tr_watchtower_schema_version (component, version)
VALUES ('signature-fraud-fee-policy-feasibility', 1);
