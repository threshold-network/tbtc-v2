# Formal Verification Roadmap (ROAST/FROST Migration)

Date: 2026-03-01
Status: Draft
Owner: Threshold Labs
Scope: targeted formal methods for high-risk protocol and custody invariants

## 1. Decision Summary

Full formal verification of the entire monorepo is not practical.
A targeted program is practical and high value:

1. ROAST/FROST signer state-machine invariants (`tools/tbtc-signer`).
2. Custody-critical smart-contract invariants (`contracts/tbtc-v2`, selected
   cross-chain bridge components).
3. Spec/model-level verification of attempt-transition policy and rollout
   no-go/rollback semantics.

## 2. Verification Objectives

The formal-methods program should prove (or exhaustively falsify) that:

1. Unauthorized attempt advancement is impossible under specified assumptions.
2. Stale/replayed attempt payloads are always rejected (including after
   restart/reload scenarios).
3. Attempt/coordinator/fingerprint constraints are deterministic and
   fail-closed.
4. Contract custody and authorization invariants cannot be violated by arbitrary
   call sequences.

## 3. Priority Targets

### P0: Signer state machine (`tools/tbtc-signer/src/engine.rs`)

Primary invariants:

1. `attempt_number` monotonicity and stale-attempt rejection.
2. `attempt_id`/participants fingerprint/coordinator consistency.
3. Attempt transition authorization requires valid transition evidence and
   active-round linkage.
4. Replay protection survives restart/reload and cache-loss scenarios.
5. Capacity bounds fail closed (no eviction weakening replay guarantees).

Recommended methods:

1. **TLA+ model** for protocol state machine and transition rules.
2. **Rust model-based property tests** (`proptest`) against implementation.
3. **Bounded model checking** (`kani`) for pure helper invariants and edge
   conditions (canonicalization, hashing inputs, transition validators).

### P0: Custody-critical Solidity invariants

Initial candidate contracts:

1. `contracts/tbtc-v2/contracts/vault/TBTCVault.sol`
2. `contracts/tbtc-v2/contracts/bridge/Bridge.sol`
3. `contracts/tbtc-v2/contracts/bank/Bank.sol`

Primary invariants:

1. Accounting conservation (mint/unmint/balance transfer relationships).
2. Authorization gates (only allowed roles/callers can execute privileged
   actions).
3. Upgrade/governance delay invariants (no bypass of configured timelock
   constraints).

Recommended methods:

1. **Echidna/Foundry invariant testing** for sequence-level invariants.
2. **SMTChecker/Halmos** for symbolic path exploration on selected properties.
3. **Certora** (if budget/tooling available) for strongest temporal/role
   properties.

### P1: Cross-repo contract compatibility model

Scope:

1. Attempt-context hashing/serialization compatibility between signer and
   keep-core.
2. Transition telemetry/error-schema consistency assumptions used by runtime.

Methods:

1. Shared vector conformance gates.
2. Lightweight executable spec for payload schema/state assumptions.

### P1: Rollout policy model checks

Scope:

1. Hold/rollback/no-go trigger semantics in
   `roast-phase-5-security-rollout-gates.md` and
   `roast-phase-5-rollout-runbook.md`.

Methods:

1. TLA+/PlusCal model for canary stage progression and rollback actions.
2. Property checks for “no silent progression under no-go conditions”.

## 3A. Audit-Fix Delta Scope (2026-03-01)

Recent audit remediations and hardening changes add P0 verification scope in
`tools/tbtc-signer/src/engine.rs`.

### P0: Encrypted state + key-provider invariants

Primary invariants:

1. Encrypted-state decode is fail-closed on malformed envelope metadata.
2. `key_id` binding is enforced: decrypt must fail if envelope key ID and
   configured key ID differ.
3. Production profile policy is fail-closed:
   - `TBTC_SIGNER_PROFILE=production` must reject
     `TBTC_SIGNER_STATE_KEY_PROVIDER=env`.
   - Production path must require
     `TBTC_SIGNER_STATE_KEY_PROVIDER=command`.
4. Command-provider contract is enforced:
   - command must succeed,
   - stdout must be valid 32-byte hex key material,
   - invalid/empty/non-UTF8 output fails closed.
5. Legacy plaintext migration preserves safety:
   - successful plaintext load rewrites to encrypted envelope atomically,
   - restart/reload and replay/idempotency invariants remain unchanged.

Recommended methods:

1. TLA+ extension for state-load/store and provider-selection policy transitions.
2. Rust model-based/property tests for provider/env combinations and fail-closed
   outcomes.
3. Bounded model checking (`kani`) for pure helpers (hex decode/validation,
   key ID derivation, envelope field checks).

Success criteria additions:

1. No unresolved HIGH/CRITICAL violations in encrypted-state/provider-policy
   invariants.
2. CI contains executable checks for production provider gating and key-ID
   mismatch fail-closed behavior.
3. Evidence is linked from Phase 5 approval records.

## 3B. Additional Formalizable Surfaces From Adjacent PRs

1. PR 80 (`tee-whitelisted-signer-enforcement-plan.md`):
   session admission, token expiry/grace-window, and break-glass TTL/no-silent-
   downgrade properties are model-checkable.
2. PR 81 (`permissioned-signer-hardening-rfc.md`):
   provenance fail-closed gates, policy-firewall safety, quarantine thresholds,
   and canary/rollback progression rules are model-checkable.
3. PR 82 (`tools/tbtc-signer/src/engine.rs`):
   strongest immediate code-level formalization target for provider-selection
   and encrypted-state key-binding invariants.

## 4. Non-Goals

1. Full proof of all TypeScript services/apps in this cycle.
2. Full cryptographic proof of FROST primitives (assumed from upstream
   vetted libraries).
3. Formal verification of every non-custody utility contract in one pass.

## 5. Deliverables

### Phase A (1-2 weeks): Signer formal-spec foundation

1. TLA+ state machine for ROAST attempt-transition replay safety.
2. Machine-checkable invariant set mapped to `engine.rs` functions.
3. CI job running model checks (or deterministic replay traces) on PRs touching
   signer attempt logic.

### Phase A implementation snapshot (2026-03-03)

1. Rust property tests added in `tools/tbtc-signer/src/engine.rs`:
   `formal_verification_*` invariants for attempt-context canonicalization and
   encrypted-state key-id fail-closed behavior.
2. TLA+ models added under
   `docs/frost-migration/formal-verification/models/`:
   - `RoastAttemptStateMachine.tla` (bounded attempt-transition model; full
     Aborted/Completed/Nonce lifecycle is out of scope for this artifact)
   - `StateKeyProviderPolicy.tla`
   - `TeeEnforcementModes.tla`
3. Model runner script added at `scripts/formal/run_tla_models.sh`.
4. CI workflow added at `.github/workflows/ci-formal-verification.yml`.
5. Scope note for adjacent PRs:
   - PR #82 coverage is represented by the provider/key-binding policy model.
   - PR #88 coverage is represented by TEE mode/admission policy model checks.
6. Scope note for signing firewall coverage:
   - enforcement-path tests already exist in `tools/tbtc-signer/src/engine.rs`
     (`start_sign_round_signing_policy_firewall_*`,
     `finalize_sign_round_signing_policy_firewall_*`).
   - a dedicated formal model for signing-policy firewall behavior remains
     follow-up work.

### Phase B (1-2 weeks): Solidity invariant harness

1. Invariant harness for TBTC vault/bridge/bank critical flows.
2. Reproducible property campaign scripts and seed corpus.
3. Triage report of violated/confirmed invariants.

### Phase B implementation snapshot (2026-03-03)

1. Added deterministic custody campaign harness:
   - `contracts/tbtc-v2/test/formal/CustodyInvariantHarness.test.ts`
2. Added reproducible seed corpus:
   - `contracts/tbtc-v2/test/formal/seed-corpus.json`
3. Added contract package script:
   - `@keep-network/tbtc-v2` `test:formal-invariants`
4. Added implementation notes and bounds:
   - `docs/frost-migration/formal-verification/solidity-invariant-harness.md`
5. Extended custody action coverage:
   - Added TBTC user-to-user transfer action in
     `contracts/tbtc-v2/test/formal/CustodyInvariantHarness.test.ts`
6. Added nightly campaign depth expansion:
   - `contracts/tbtc-v2/test/formal/seed-corpus-nightly.json`
   - `.github/workflows/nightly-formal-invariants.yml`

### Phase C (1 week): Cross-repo + rollout policy checks

1. Shared vector conformance package and gate.
2. Rollout policy model and proof artifacts for stage/rollback constraints.
3. Final formal-methods summary packet linked from Phase 5 sign-off docs.

### Phase C implementation snapshot (2026-03-03)

1. Added shared ROAST attempt-context vector corpus:
   - `docs/frost-migration/test-vectors/roast-attempt-context-v1.json`
2. Added shared vector conformance gates:
   - `scripts/formal/check_roast_attempt_context_vectors.mjs`
   - `tools/tbtc-signer/src/engine.rs`
     (`formal_verification_roast_attempt_context_shared_vectors_match_expected_values`)
   - `.github/workflows/ci-formal-verification.yml`
     (`Vector conformance gate` job)
3. Added rollout policy model artifacts:
   - `docs/frost-migration/formal-verification/models/RoastRolloutPolicy.tla`
   - `docs/frost-migration/formal-verification/models/RoastRolloutPolicy.cfg`
   - `docs/frost-migration/formal-verification/rollout-policy-model.md`
4. Added final summary packet and rollout linkage:
   - `docs/frost-migration/formal-verification/formal-methods-summary-packet.md`
   - `docs/frost-migration/roast-phase-5-baseline-calibration.md`

## 6. Success Criteria

1. No unresolved HIGH/CRITICAL invariant violations in P0 targets.
2. All P0 properties encoded as executable checks and running in CI.
3. Evidence artifacts linked from:
   - `docs/frost-migration/roast-phase-5-baseline-calibration.md`

## 7. Suggested CI Additions

1. `cargo test` property/invariant target for signer model-based tests.
2. Formal-model check target (TLA+/trace checker) for signer transitions.
3. Contract invariant campaign target (nightly + release-candidate gating).

## 8. Practical Recommendation

Start with **P0 signer + P0 contracts** immediately.

That gives highest audit/deploy risk reduction while keeping scope controlled.
