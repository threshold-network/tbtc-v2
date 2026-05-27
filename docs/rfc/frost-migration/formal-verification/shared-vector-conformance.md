# Shared ROAST Vector Conformance Gate

Date: 2026-03-03  
Status: Implemented (Phase C)  
Owner: Threshold Labs

## Objective

Use one canonical vector corpus for ROAST attempt-context hashing and enforce
cross-language conformance in CI.

## Canonical Vector Corpus

- `docs/frost-migration/test-vectors/roast-attempt-context-v1.json`

Schema fields:

- `session_id`
- `message_digest_hex`
- `attempt_number`
- `coordinator_identifier`
- `included_participants`
- `expected_included_participants_fingerprint`
- `expected_attempt_id`

Domain separators in the corpus are pinned to:

- `FROST-ROAST-INCLUDED-FPR-v1`
- `FROST-ROAST-ATTEMPT-ID-v1`

## CI Gates

1. Node gate (independent implementation):
   - `scripts/formal/check_roast_attempt_context_vectors.mjs`
   - workflow job: `Vector conformance gate`
2. Rust gate (engine implementation):
   - `tools/tbtc-signer/src/engine.rs`
   - test:
     `formal_verification_roast_attempt_context_shared_vectors_match_expected_values`
   - covered by workflow job: `Signer formal invariants`

## Local Run Commands

```bash
node scripts/formal/check_roast_attempt_context_vectors.mjs
cargo test --manifest-path tools/tbtc-signer/Cargo.toml formal_verification_roast_attempt_context_shared_vectors_match_expected_values
```

## Notes

- Vectors are canonicalized by participant sorting before fingerprint
  derivation.
- The `vector-session-4-unsorted-participants` case intentionally uses
  unsorted input to prove canonicalization parity across implementations.
- Boundary coverage includes:
  - minimum bounds (`attempt_number = 1`, single participant),
  - u16 identifier ceiling (`coordinator_identifier = 65535`).
