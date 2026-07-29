# Formal Methods Summary Packet

Date: 2026-03-03  
Status: Ready for Phase 5 sign-off linkage  
Owner: Threshold Labs

## 1. Scope

Consolidated formal-methods coverage for signer hardening and ROAST rollout
controls across Phase A, Phase B, and Phase C roadmap deliverables.

## 2. Executable Artifact Index

### Phase A: Signer formal-spec foundation

1. Rust property/invariant tests:
   - `tools/tbtc-signer/src/engine.rs`
   - CI gate: `Signer formal invariants`
2. TLA+ models:
   - `docs/frost-migration/formal-verification/models/RoastAttemptStateMachine.tla`
   - `docs/frost-migration/formal-verification/models/StateKeyProviderPolicy.tla`
   - `docs/frost-migration/formal-verification/models/TeeEnforcementModes.tla`
   - CI gate: `TLA model checks`

### Phase B: Solidity invariant harness

1. Deterministic campaign harness:
   - `contracts/tbtc-v2/test/formal/CustodyInvariantHarness.test.ts`
2. Seed corpus:
   - `contracts/tbtc-v2/test/formal/seed-corpus.json`
3. CI gate:
   - `Solidity formal invariants`
4. Nightly depth campaign:
   - `contracts/tbtc-v2/test/formal/seed-corpus-nightly.json`
   - `.github/workflows/nightly-formal-invariants.yml`

### Phase C: Cross-repo + rollout policy checks

1. Shared ROAST vector corpus:
   - `docs/frost-migration/test-vectors/roast-attempt-context-v1.json`
2. Node vector conformance gate:
   - `scripts/formal/check_roast_attempt_context_vectors.mjs`
   - CI gate: `Vector conformance gate`
3. Rust vector conformance gate:
   - `formal_verification_roast_attempt_context_shared_vectors_match_expected_values`
     in `tools/tbtc-signer/src/engine.rs`
4. Rollout policy model:
   - `docs/frost-migration/formal-verification/models/RoastRolloutPolicy.tla`
   - `docs/frost-migration/formal-verification/models/RoastRolloutPolicy.cfg`

## 3. CI Workflow Wiring

Formal CI workflow:

- `.github/workflows/ci-formal-verification.yml`

Formal jobs:

1. `Vector conformance gate`
2. `Signer formal invariants`
3. `TLA model checks`
4. `Solidity formal invariants`

## 4. Residual Risk Notes

1. Phase B residual-risk closures:
   - TBTC user-to-user transfer action is now included in the Solidity harness
     campaign.
   - Nightly depth expansion is now wired through
     `seed-corpus-nightly.json` and
     `.github/workflows/nightly-formal-invariants.yml`.
2. Remaining bounded scope:
   - Bridge operational flows (deposit reveal/sweep/redemption state machine)
     remain out of scope for the current custody campaign.

## 5. Rollout Link Target

This packet is intended to be referenced from:

1. `docs/frost-migration/roast-phase-5-baseline-calibration.md`
