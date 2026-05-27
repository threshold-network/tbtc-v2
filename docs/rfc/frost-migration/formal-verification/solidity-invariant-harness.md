# Solidity Invariant Harness (Phase B)

Date: 2026-03-03
Scope: custody-critical accounting and authorization invariants in
`contracts/tbtc-v2`

## Implemented Harness

Primary campaign test:

- `contracts/tbtc-v2/test/formal/CustodyInvariantHarness.test.ts`

Seed corpus:

- `contracts/tbtc-v2/test/formal/seed-corpus.json`
- Nightly depth corpus:
  `contracts/tbtc-v2/test/formal/seed-corpus-nightly.json`

NPM script:

- `pnpm --filter @keep-network/tbtc-v2 run test:formal-invariants`

## Invariants Checked

1. Bank accounting conservation over tracked custody actors:
   - `sum(bank.balanceOf(campaign accounts + vault)) == cumulative bridge-issued satoshis`
2. TBTC supply consistency:
   - `sum(tbtc.balanceOf(campaign accounts)) == tbtc.totalSupply()`
3. Vault collateralization consistency (campaign scope):
   - `tbtc.totalSupply() == bank.balanceOf(vault) * SATOSHI_MULTIPLIER`
4. Governance fail-closed gates:
   - non-owner cannot call `Bank.updateBridge`
   - non-owner cannot call `TBTCVault.initiateUpgrade`
   - owner cannot bypass `TBTCVault.finalizeUpgrade` governance delay

## Campaign Design

Each seed executes a deterministic action sequence over:

- bridge balance issuance (`increaseBalance`)
- peer balance transfer (`transferBalance`)
- allowance-based transfer (`increaseBalanceAllowance` + `transferBalanceFrom`)
- vault mint (`mint`)
- vault unmint (`unmint`)
- TBTC user-to-user ERC20 transfer (`transfer`)
- negative governance gate probes

The harness validates invariants after each step.

## Campaign Configuration

The harness supports deterministic runtime overrides:

1. `TBTC_FORMAL_SEED_CORPUS_PATH`:
   path to corpus JSON (resolved relative to `test/formal` when not absolute).
2. `TBTC_FORMAL_SEEDS`:
   comma-separated positive integer seed list override.
3. `TBTC_FORMAL_STEPS_PER_SEED`:
   positive integer override for campaign depth.
4. Minimum campaign floor enforcement:
   at least 2 seeds and at least 10 steps per seed are required.

Nightly campaign workflow:

- `.github/workflows/nightly-formal-invariants.yml`

## Current Bounds

1. Actor set is bounded to 4 campaign accounts + vault.
2. Action count per seed is bounded by `steps_per_seed`.
3. Bridge operational flows (deposit reveal/sweep/redemption state machine) are
   out of scope for this campaign and remain follow-up.
4. Adding action types changes the modulus-driven action dispatch (`% N`), so
   existing seeds remain deterministic but produce different action sequences as
   `N` changes.

## Follow-up Targets

1. Extend campaign to bridge redemption/deposit paths using bridge fixture
   state-machine actions.
2. Export failure traces in a machine-readable artifact for triage packets.
