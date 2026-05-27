# Schnorr/FROST Migration — Source-of-Truth Notice

> **2026-05-27 — Source-of-truth pivot.** This document previously
> tracked the import direction (umbrella `tlabs-xyz/tbtc` → canonical
> `threshold-network/tbtc-v2` + `threshold-network/keep-core`). That
> mirror workflow is **retired**. The canonical repositories
> (`threshold-network/tbtc-v2`, `threshold-network/keep-core`) are
> now the **source of truth** for the FROST/Schnorr migration and
> all D-2.2 follow-up work.
>
> The full historical mirror-tracking content is preserved in git
> history at any commit before `e37051da` on
> `extraction/frost-mirror-2026-05-26`. New contributors should not
> refer to it for current state.

## What this means in practice

- **All new work** lands directly on `threshold-network/tbtc-v2` and
  `threshold-network/keep-core` via standard PRs against `main`.
  No upstream-mirror step is required or expected.

- **Source manifests** (the per-file `sourceCommit` / sha256
  tracking that proved canonical files equalled umbrella PR HEAD
  at a recorded commit) are **no longer load-bearing**. Existing
  manifest content in commit history and in
  `docs/test-vectors/*.json` provenance comments is historical;
  nothing new needs adding.

- **Dual-signoff per file** (extraction lead + canonical
  maintainer) for allowlisted-divergence entries is **retired**.
  Standard PR review against canonical convention suffices.

- The `umbrella` term, references to `tlabs-xyz/tbtc`, and
  "extraction" framing in _existing_ commit messages and PR titles
  are durable historical artifacts. Don't rewrite history to
  remove them; just use plain `feat:` / `fix:` / `refactor:` /
  `docs:` prefixes for new work.

- The `frost-extraction-source-v1` signed tag on the umbrella is
  no longer maintained. The corresponding "tag re-sign on umbrella
  HEAD" task is dropped from any plan documents that mentioned it.

## Scope of canonical going forward

The canonical FROST stack covers (only):

- `solidity/contracts/bridge/` — Bridge core + FrostWalletRegistry
  wiring + EcdsaFraudRouter + P2TRSignatureFraudRouter + lifecycle
  router interface.
- `solidity/contracts/frost-registry/` — FROST DKG + registry +
  authorization / inactivity libraries.
- `solidity/contracts/test/` — test stubs for the above (allowlisted
  divergence between Bridge and BridgeStub is normal).
- `services/watchtower/` — P2TR signature fraud watchtower.
- `typescript/src/` — SDK additions for P2TR fraud submission and
  watchtower runner.
- `docs/rfc/frost-migration/` — RFCs + plans for B-1/B-2/C-2/D-1/D-2
  phases.

**Explicitly out of scope** for this canonical stack (kept separate
from the FROST work):

- Account-control / AC watchdog / covenant work.
- TBTCVault migration-debt machinery (`ITBTCVaultMigrationDebt`,
  `ITBTCVaultMigrationSweepHook`, `ITBTCVaultMigrationSweepNotifier`,
  `TBTCMigrationDebtOperations`). These belong in a separate effort.
- PSBT covenant merge readiness, PSBT signing helpers.
- The wider FROST-Taproot readiness work that exists in upstream
  repositories outside the canonical FROST migration scope.

## In-flight PRs at the time of the pivot

| PR           | Repo      | Status                 | Notes                                                                                                                                    |
| ------------ | --------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| #971         | tbtc-v2   | open, ready for review | Core FROST extraction. 3 commits, all CI green.                                                                                          |
| #972         | tbtc-v2   | open, drain-dependent  | D-2.2 slice 2 — remove `slashWalletForFraud`. Stacked on #971's branch. DO NOT MERGE until ECDSA wallet drain complete.                  |
| #973         | tbtc-v2   | open, drain-dependent  | D-2.2 slice 4 — remove `ecdsaWalletRegistry` handle + heartbeat callback. Stacked on #971's branch. DO NOT MERGE until full ECDSA drain. |
| #4005, #4007 | keep-core | open, all CI green     | Companion Go-side work.                                                                                                                  |

## Reference: phases that landed via the mirror workflow (historical)

These are now closed out and the work is canonical:

- **Phase A** — ECDSA fraud router + P2TR signature fraud router
  sidecars; library size optimizer fix.
- **Phase B-1** — FrostWalletRegistry, FROST DKG validator,
  sortition pool integration.
- **Phase B-1.5** — full DKG state-machine integration tests.
- **Phase C-1** — companion services (indexer/subgraph/relayer).
- **Phase C-2 / D-2.2 slice 3** — scheme preference removal
  (`setNewWalletScheme` + scheme dispatch).
- **Phase D-1** — ECDSA soft retirement (bool flag + retire setter).
- **Phase D-2.1** — ECDSA hard retirement (setter surface +
  callback removal).
- **D-2.2 slice 1** — public `Bridge.ecdsaRetired()` getter.

## Reference: phases still pending (canonical-direction)

- **Phase B-2** — keep-core Go-side FROST DKG coordination
  protocol. Required before integration tests for FROST wallet
  creation flow can be un-skipped on canonical.
- **D-2.2 slices 2 + 4** — the two drain-dependent slices listed
  above; merge gated on operational drain completion.
