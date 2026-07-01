# tBTC FROST Wallet-Lifecycle Migration Plan

**Status as of:** 2026-05-27
**Owner:** Bridge contracts team
**Tracker PRs:** #431 (FROST registration entry), #433 (storage-layout
snapshot test), #434 (Phase A), #435 (fraud extraction), #436 (gate
retargeting), #437 (B-1 RFC), #438 (C-2 + D RFC), #439 (C-2
implementation).

This doc tracks the Bridge-contract changes that enable FROST-keyed
wallets to coexist with (and eventually replace) the legacy
ECDSA-keyed wallets in Bridge.sol. It complements
`docs/frost-migration/roast-implementation-plan.md` (which scopes the
signer side) and `docs/frost-migration/p2tr-signature-fraud-execution-spec.md`
(which scopes the P2TR fraud surface).

## Phase summary

| Phase                    | Scope                                                                                                                                                                                                          | PR          | Status                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| Pre-Phase A              | `setFrostWalletRegistry` + `registerNewFrostWallet` entry on Bridge                                                                                                                                            | #431        | Merged                                                                     |
| Storage invariant test   | Pinned storage-layout snapshot + invariant test                                                                                                                                                                | #433        | Merged                                                                     |
| Pre-Phase B / extraction | ECDSA + P2TR fraud lifecycle extracted into peer sidecars                                                                                                                                                      | #435        | Merged 2026-05-24                                                          |
| Gate retarget + cleanup  | Retarget readiness gates at P2TR router source; drop dead lifecycle library                                                                                                                                    | #436        | Merged 2026-05-24                                                          |
| Phase A                  | Scheme-aware lifecycle routing hooks + `IBridgeLifecycleRouter` interface. Canonical PR #971 ships the Bridge-side hooks; the router contract itself is tracked in `bridge-lifecycle-router-followup-plan.md`. | #434 / #971 | **Partially mirrored; router follow-up required before FROST activation**  |
| Phase B-1 (RFC)          | On-chain FROST `WalletRegistry` contract trust model — sortition-attested DKG result with threshold pre-aggregated transcript                                                                                  | #437        | RFC open (v4.1)                                                            |
| Phase B-1 (impl)         | Implementation of the FROST `WalletRegistry` contract per RFC #437                                                                                                                                             | #971        | Included in canonical mirror; activation blocked on lifecycle router + B-2 |
| Phase B-2                | keep-core Go-side FROST DKG coordination protocol                                                                                                                                                              | #4005       | External companion PR                                                      |
| Phase C-1                | Indexer / subgraph / relayer companion PRs (re-target fraud events at the new routers; teach indexers about the FROST wallet event surface + new C-2 scheme/seed events)                                       | TBD         | Not started                                                                |
| Phase C-2 (RFC)          | Governance new-wallet-scheme preference + ECDSA wallet counter for D-2                                                                                                                                         | #438        | RFC open (v6.1)                                                            |
| Phase C-2 (impl)         | Implementation of scheme selector + counter per RFC #438                                                                                                                                                       | #439        | **Open 2026-05-24 (draft)**                                                |
| Phase D-1                | Soft ECDSA retirement (block new ECDSA wallets)                                                                                                                                                                | TBD         | Blocked on C-2 merge + FROST registry being live                           |
| Phase D-2                | Hard ECDSA retirement (storage placeholder + bytecode reclaim)                                                                                                                                                 | TBD         | Blocked on D-1 + buffer period                                             |

## Bridge bytecode budget evolution

EIP-170 deploy limit: **24.576 KiB** (24 KiB exact). Optimizer is the
project-default `runs=200` unless noted.

| Branch state                                       | Bridge deployed               | Headroom          |
| -------------------------------------------------- | ----------------------------- | ----------------- |
| `feat/frost-schnorr-migration` pre-PR-431 baseline | 22.708 KiB                    | 1.87 KiB          |
| + PR #431 (FROST registration entry)               | 22.708 KiB                    | 1.87 KiB          |
| + PR #434 Phase A inlined (runs=200)               | 24.259 KiB                    | -120 bytes (over) |
| + PR #434 Phase A inlined (runs=1 stopgap)         | 23.917 KiB                    | 660 bytes         |
| + PR #435 fraud extraction (no Phase A)            | 23.185 KiB                    | 1.39 KiB          |
| + PR #435 + rebased Phase A (runs=200)             | **23.831 KiB**                | 745 bytes         |
| + PR #439 C-2 at runs=200 (over budget)            | 24.751 KiB                    | -175 bytes (over) |
| + PR #439 C-2 at **runs=1**                        | **23.996 KiB** (24,572 bytes) | **4 bytes**       |

PR #435 was the structural fix for Phase A's EIP-170 squeeze. With
the ECDSA + P2TR fraud lifecycles extracted to peer sidecars (10.6
KiB and 17.3 KiB respectively), Bridge sheds the runs=1 optimizer
trim that both Codex and Gemini blocked Phase A on. Phase A fits at
the standard runs=200 with ~745 bytes EIP-170 headroom.

C-2 (#439) consumed that headroom and then some — the measured C-2
delta at runs=200 was ~920 bytes vs the RFC v6 budget estimate of
~335 bytes. C-2 ships under the EIP-170 ceiling via three
budget-deferral levers (documented in the PR description and
RFC v6 implementation notes): (a) revert Bridge to runs=1, (b)
combine the C-2 scheme + seed setters into one Bridge entry, (c)
defer the standalone view getters + per-call governance override.
All three deferrals are temporary; D-2's ~1.3–2 KiB reclaim is
expected to restore runs=200 and reintroduce the deferred surface.

## Storage layout snapshot

`test/formal/Bridge.storage-layout.json` is the pinned snapshot;
`test/formal/BridgeStorageLayout.test.ts` enforces upgrade-safety
invariants. Current slot order:

| Slot        | Field                                                                                                                                              | Source                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 0..31       | Pre-existing fields through `activeWalletID`                                                                                                       | pre-PR-431                |
| 32          | `frostWalletRegistry`                                                                                                                              | #431 / #971               |
| 33          | `ecdsaFraudRouter`                                                                                                                                 | #435 / #971               |
| 34          | `p2trFraudRouter`                                                                                                                                  | #436 / #971               |
| 35          | `lifecycleRouter`                                                                                                                                  | #434 / #971               |
| 36          | `walletIDByWalletPubKeyHash` (mapping)                                                                                                             | #434 / #971               |
| 37 (packed) | `currentNewWalletScheme` (enum @ off 0) + `ecdsaWalletCount` (uint128 @ off 1) + `ecdsaRetired` (bool @ off 17) + `slashingActive` (bool @ off 18) | #439 / D-1 / #971 / #1002 |
| 38+         | `__gap` (uint256[40])                                                                                                                              | —                         |

`EXPECTED_RESERVED_TOTAL` is pinned by the storage-layout test
(BridgeState's own header carries the rationale: "more slots as
there are planned upgrades"). The pinned total moved from 104 →
**106** with the canonical mirror because the packed scheme/counter/
retirement fields share one slot (each counts as one explicit member;
`__gap` decrements by 1, net +2 to the total). The slashing-active
gate then appends `slashingActive` (bool) into the same packed slot 37
without taking a new slot or decrementing `__gap`, moving the pinned
total to **107** (#1002).

The authoritative source is the generated storage snapshot, not this
table. Any future storage-layout doc update must be checked against
`solidity/test/formal/Bridge.storage-layout.json`.

## Cutover playbook recap (from `Bridge.migrateLegacyFraudChallenges` NatSpec)

The migration helper for legacy fraud challenges is intentionally
stubbed in #435 to save ~1.1 KiB of Bridge bytecode. Acceptable only
under this per-chain operational contract:

1. **Off-chain audit** — enumerate every `FraudChallengeSubmitted` and
   `P2TRSignatureFraudChallengeSubmitted` event on the target chain;
   confirm count == 0 OR every emitted submission has a matching
   `Defeated` / `DefeatTimedOut`. Capture proof in the deployment /
   governance record.
2. **Pre-upgrade quiet period** during the governance delay window:
   no new wallets enabled; maintainers hold off any fraud-eligible
   signing.
3. **Atomic cutover** — the same governance proposal that sets the
   routers (`setEcdsaFraudRouter` + `setP2TRFraudRouter`) activates
   the upgrade. No in-between window where Bridge accepts fraud
   calls but routers are not wired.

If any chain can't satisfy (1) or (2), the migration body MUST be
added back via a focused upgrade BEFORE the router upgrade activates
on that chain. Bridge is upgradeable; the function signature, event,
and `IEcdsaFraudRouterMigration` interface stay in place so the
follow-up upgrade is a body swap, not an ABI change.

**Chains in scope** at the time of #435: Ethereum L1 (mainnet +
Sepolia per `contracts/tbtc-v2/deployments/`); no L2/sidechain Bridge
deployments. Mainnet has never seen an opened fraud challenge;
Sepolia has never seen one either. Both chains satisfy step (1) with
count = 0. Release-checklist item: snapshot the audit proof into the
deployment record before the router upgrade is queued.

## Phase B-1 design

RFC #437 (v4.1, frozen) selects **sortition-attested DKG result**:
the FROST DKG produces a threshold pre-aggregated transcript +
threshold-signed group public key; the on-chain registry verifies
the sortition pool sortition-seed → operator-set derivation and the
threshold signature over the DKG transcript before invoking
`Bridge.__frostWalletCreatedCallback`. The two earlier-considered
alternatives (single owner key, plain multisig) are documented as
rejected.

Co-design with B-2 (keep-core Go DKG coordinator) is required: the
coordinator must produce the threshold-attested transcript in a
shape the registry can verify without trusting any individual
operator. The B-1 RFC's `RegistrationTranscript` struct (operator
set, DKG seed, group public key, threshold signature) is the
contract surface; B-2 fills it.

## Phase C-1 known follow-ups (subgraph/indexer/relayer)

Concrete items the fraud extraction + Phase A + C-2 create for the
indexer + service layer to absorb in Phase C-1. Split into the
existing #435/#434 retargeting work and the #439-added surface:

**Fraud-router retargeting (from #435):**

- **`data/tbtc-subgraph/subgraph.yaml`** — currently subscribes to
  `FraudChallengeSubmitted` / `Defeated` / `DefeatTimedOut` on the
  Bridge address. Post-cutover those events are emitted by
  `EcdsaFraudRouter`. Add a new `EcdsaFraudRouter` datasource (and a
  `P2TRSignatureFraudRouter` datasource for the P2TR
  `P2TRSignatureFraudChallengeSubmitted` / `Defeated` /
  `DefeatTimedOut`) to keep the indexer in sync.
- **`services/p2tr-signature-fraud-watchtower/`** — the duck-typed
  contract reference (`P2TREthersBridgeLifecycleContract`) is preserved
  for source compat, but production callers must instantiate it with
  the router contract instance, not Bridge. JSDoc on
  `P2TRSignatureFraudBridgeChallengeContract` in
  `sdk/tbtc-v2-ts/src/services/maintenance/p2tr-signature-fraud.ts`
  flags this for callers. The type rename
  (`...BridgeChallengeContract` → `...RouterContract`) is queued for a
  follow-up SDK breaking-change release.
- **Watchtower event scanner**
  (`EthersP2TRSignatureFraudBridgeLifecycleEventSource.ts`) — scans an
  arbitrary contract instance for events; needs to be pointed at the
  P2TR router address post-cutover.
- **Backend Bridge interface** (`services/backend/src/interfaces/Bridge.ts`)
  — if it references fraud entry points, retarget at the router.

**Phase A lifecycle routing (from #434):**

- Subgraph + indexer must learn about `LifecycleRouterSet` (new Bridge
  event), `NewWalletRegisteredV2` (replaces the legacy V1 event for
  consumers that need the canonical 32-byte walletID), and
  `NewFrostWalletRegistered` (FROST-specific lifecycle).

**C-2 / D-2 canonical mirror deltas:**

- `NewWalletSchemeSet` remains declared for ABI back-compat but no
  longer fires because D-2.2 slice 3 removed the scheme setter and
  request-time branch. Consumers should not use it as an activation
  signal.
- `EcdsaWalletCountSeeded` and `ecdsaWalletCountSeeded` were dropped /
  deferred indefinitely before the canonical mirror. Consumers derive
  ECDSA historical counts by replaying `NewWalletRegistered`.
- Operator-facing dashboards / SDK helpers can read the public
  `Bridge.ecdsaRetired()` getter. Scheme selection is no longer a live
  runtime value in the canonical mirror; new wallet creation dispatches
  only to the FROST registry once the lifecycle router and registry
  owner are wired.

- ~~Formal-evidence manifest update~~ — DONE in PR #436. The two
  readiness gates
  (`scripts/formal/check_p2tr_fraud_gas_dos_gate.mjs` and
  `check_p2tr_fraud_gas_dos_freeze_candidate.mjs`), the evidence
  manifest
  (`docs/operations/frost-roast-p2tr-fraud-gas-dos-evidence-v0.json`),
  and the review runbook
  (`docs/operations/frost-roast-p2tr-fraud-gas-dos-review-runbook-2026-05-21.md`)
  now read the router source
  (`contracts/tbtc-v2/contracts/bridge/P2TRSignatureFraudRouter.sol`)
  instead of the deleted
  `P2TRSignatureFraudLifecycle.sol` library. The constants and
  revert string the gates parse (`P2TRSignatureFraudMaxInputs`,
  `MaxOutputs`, `MaxScriptPubKeyBytes`, `MaxPayloadBytes`,
  `"P2TR payload too large"`) all carried over verbatim from the
  library to the router during PR #435, so the retarget was a
  pure path change with no value/guard drift.

## Open release-checklist items

- [ ] Snapshot zero-challenge event-audit proof for mainnet + Sepolia
      into the deployment record (release prerequisite per cutover
      playbook).
- [x] Phase A (#434) merges once CI green + reviewer re-validation.
      **Merged 2026-05-24 as `00e0838d1e`**.
- [x] Phase B-1 trust-model design + RFC. **RFC #437 v4.1 frozen.**
- [ ] Phase B-1 implementation (port the on-chain
      `FrostWalletRegistry` per RFC #437).
- [ ] Phase B-2 implementation (keep-core Go-side DKG coordinator
      that produces the threshold-attested transcript B-1's
      registry verifies).
- [x] Phase C-2 governance `newWalletScheme` preference.
      **Implementation PR #439 open (draft) 2026-05-24**; RFC #438
      v6.1 frozen.
- [ ] Phase C-1 subgraph + watchtower retargeting PR (now should
      also absorb the C-2 scheme + counter events from #439).
- [ ] Phase D-1 soft retirement (blocked on C-2 merge + FROST
      registry live).
- [ ] Phase D-2 hard retirement (blocked on D-1 buffer expiry +
      governance-supplied retired-wallet list).
