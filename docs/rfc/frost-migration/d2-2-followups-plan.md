# D-2.2: ECDSA hard-retirement follow-ups

## Status

In review for the canonical mirror. In `threshold-network/tbtc-v2`,
slice 1 and slice 3 land as part of PR #971 rather than as standalone
canonical PRs. Slice 2 and slice 4 remain deferred with their
operational prerequisites.

## Context

D-2.1 (PR #445) shipped the structural ECDSA hard retirement:

- `Bridge.__ecdsaWalletCreatedCallback` removed entirely.
- `Wallets.requestNewWallet` Ecdsa-branch reverts
  unconditionally (Codex P1 re-raise).
- `Bridge.retireEcdsa()` + `EcdsaRetired` event added.
- `IWalletOwner` interface inheritance dropped.

It deferred several smaller follow-ups for EIP-170 budget +
operational-drain reasons. D-2.2 picks those up as a series
of slices. The umbrella source PRs tracked some slices separately;
the canonical mirror batches slice 1 and slice 3 into PR #971.

## Lifecycle-router dependency

All FROST wallet-creation and lifecycle paths assume a deployed
`BridgeLifecycleRouter`, but PR #971 ships only the Bridge-side hooks
and `IBridgeLifecycleRouter` interface. Production activation must
therefore land the router follow-up before any FROST wallet creation
is enabled. See
[`bridge-lifecycle-router-followup-plan.md`](./bridge-lifecycle-router-followup-plan.md)
for the router contract requirements, deployment ordering, and
acceptance criteria.

## Slice plan

### Slice 1 — public `Bridge.ecdsaRetired()` getter (PR #447)

**Status:** included in canonical PR #971.

D-2.1 dropped the getter for ~16 bytes of EIP-170 headroom.
D-2.2 slice 1 re-adds it, trading the `emit EcdsaRetired()`
in `retireEcdsa()` for the budget. The event was only added
in D-2.1 as an observability fallback because no getter
existed; with the getter in place, polling is the canonical
observation path and the governance transaction itself
provides the audit-trail record.

The `event EcdsaRetired();` declaration stays on BridgeState
so out-of-tree tooling that registered for the event topic
doesn't see a missing ABI entry — the event just never fires
post-D-2.2.

Bytecode: Bridge runtime 24,547 → 24,552 bytes (24-byte
EIP-170 headroom).

### Slice 2 — remove `Bridge.slashWalletForFraud` ECDSA callback

**Status:** deferred. Drain-dependent.

`slashWalletForFraud` is the privileged callback the
`EcdsaFraudRouter` (PR #435) invokes to perform the wallet
termination + operator stake seizure when a fraud challenge
times out. The callback only exists for the ECDSA fraud
lifecycle (P2TR fraud is handled by the separate
`P2TRSignatureFraudRouter` which doesn't call back into
Bridge for slashing).

Removing the callback in slice 2 would:

- Bytecode reclaim: ~200-300 bytes on Bridge (function body
  - selector dispatch + the `EcdsaFraudRouter` setter and
    view that gate it).
- Free corresponding storage slot: `ecdsaFraudRouter` slot
  could be repurposed (note: standard storage-layout
  preservation rules still apply — the slot stays in place
  but stops being written to; never delete a slot from a
  proxy storage layout).

**Operational prerequisite:** no live ECDSA wallets in any
fraud-challenge lifecycle path. Specifically:

- `EcdsaFraudRouter.openFraudChallengeCount() == 0`.
- No ECDSA wallets in `Live`, `MovingFunds`, or `Closing` state (those
  are the states where fraud challenges can begin against a
  wallet).

The activation runbook for slice 2 must include a step that
governance verifies this before the upgrade transaction:

- On-chain: read `EcdsaFraudRouter.openFraudChallengeCount()` and
  require zero.
- Off-chain: query wallet-state events/subgraph data and require no
  ECDSA wallet remains in a challengeable state. Bridge's registered
  wallets are mapping-backed, so this cannot be enumerated on-chain
  without adding a separate index.

This is an explicit runbook-only mitigation for the wallet-state half
of the drain. The alternative is a new router freeze mode plus a
wallet-state index, which adds bytecode/storage and is left to the
slice 2 implementation PR if governance wants stricter on-chain
enforcement. Without the drain, an in-flight fraud challenge that
times out post-D-2.2.2 would hit the removed selector and revert — no
slashing, no stake seizure, fraud goes unpunished.

For pre-mainnet deployments where no ECDSA wallets exist
(test/staging), slice 2 is safe to ship immediately. For
mainnet, governance must complete the drain first.

### Slice 3 — remove scheme dispatch + governance setters

**Status:** included in canonical PR #971.

After D-2.1, `Wallets.requestNewWallet` unconditionally reverted the
Ecdsa branch. The branch + scheme-enum check existed purely as
dead-code: any Ecdsa-scheme selection reverted before dispatch.
Removing the request-time scheme branch:

- Bytecode reclaim: ~50 bytes on Wallets library (smaller
  branch + simplified dispatch).
- Surface cleanup: `setNewWalletScheme(scheme)` becomes a
  governance-flippable knob that no longer affects routing
  — confusing to leave in place.

**Operational prerequisite:** governance commits to never flipping the
scheme back to Ecdsa for any reason. Once the request-time scheme
branch and setter are gone, that decision is irreversible by code; only
a Bridge implementation upgrade could reintroduce scheme selection.

Slice 3 removes:

- `BridgeGovernance.setNewWalletScheme(scheme)` forwarder.
- `Bridge.setNewWalletScheme(scheme)` external function.
- The `NewWalletSchemeSet(scheme)` event (declared but no
  longer fires).
- The `currentNewWalletScheme` storage field (PRESERVED in
  layout per the OZ storage-layout convention; just stops
  being read).

The `WalletScheme` enum remains declared because the preserved storage
field and ABI-compatible event declaration still refer to the type.

Slice 3 reclaim: ~150-200 bytes Bridge + library combined. In the
canonical mirror this is already reflected by the removed Bridge and
BridgeGovernance setters plus the FROST-only request dispatch in
`Wallets.requestNewWallet`.

### Slice 4 — remove `ecdsaWalletRegistry` handle + heartbeat callback

**Status:** deferred. Hard drain-dependent.

The last ECDSA-related surface on Bridge consists of:

- `ecdsaWalletRegistry` storage slot (the IWalletRegistry
  handle pointed at the keep-network ECDSA registry).
- `Wallets.requestNewWallet`'s pre-dispatch IDLE precheck
  (`require(self.ecdsaWalletRegistry.getWalletCreationState() == EcdsaDkg.State.IDLE)`).
- `Bridge.__ecdsaWalletHeartbeatFailedCallback` (preserved
  through D-2 because existing ECDSA wallets still need to
  report heartbeat failures via the ECDSA registry).
- `notifyWalletHeartbeatFailed` in the Wallets library.

Slice 4 removes all of them. Reclaim: substantial
(~400-600 bytes) but only safe when:

- All ECDSA wallets have reached Closed/Terminated state.
- The ECDSA registry is no longer expected to call into
  Bridge for any purpose.

This is the strongest drain dependency in the D-2 series.
Likely the final slice in the migration.

## Bytecode trajectory

| Phase   | Bridge runtime (bytes) | Notes                                     |
| ------- | ---------------------- | ----------------------------------------- |
| D-1     | 24,547                 | Storage flag + Wallets-library guard only |
| D-2.1   | 24,547                 | Callback removal + setter (net-zero)      |
| D-2.2.1 | 24,552                 | Public getter + event drop (this PR)      |
| D-2.2.2 | ~24,200-300            | slashWalletForFraud removal (estimate)    |
| D-2.2.3 | ~24,000-100            | Scheme enum cleanup (estimate)            |
| D-2.2.4 | ~23,400-600            | Full ECDSA handle removal (estimate)      |

Cumulative reclaim from D-2.1 baseline by end-state: ~1.0-1.2 KiB.

Gas visibility note: this migration also carries the project-wide
optimizer-runs change from 1000 to 200 to keep Bridge under EIP-170
after the FROST surface lands. Before external audit kickoff or
governance activation, publish a small gas snapshot for the hottest
Bridge paths (`revealDeposit`, redemption request/proof, sweep/moving
funds) comparing the pre-FROST baseline against the canonical mirror
head. The bytecode numbers above are point-in-time measurements; rerun
contract-sizer before each deferred slice and update this table if a
slice ships separately.

## Closed question: D-2.2.5 — do not re-add `EcdsaRetired` emit

The `event EcdsaRetired();` ABI declaration remains for
back-compat, but `retireEcdsa()` no longer emits it. Re-adding the
emit later is not recommended: already-retired Bridges would not emit
retroactively, consumers would have to support both behaviors anyway,
and the public `ecdsaRetired()` getter plus the governance transaction
record provide the canonical audit trail.

## Tests + cross-slice validation

Each slice ships with its own focused test additions:

- Slice 1: 6/6 retirement tests updated to use the public
  getter instead of event-emission assertions.
- Slice 2 (when shipping): assertion that
  `slashWalletForFraud` selector is no longer in Bridge ABI;
  EcdsaFraudRouter integration tests updated to reflect the
  removed callback.
- Slice 3: storage-layout snapshot refreshed;
  scheme-preference tests updated to assert the scheme setter is gone.
- Slice 4 (when shipping): full Bridge.Wallets.test.ts
  sweep to ensure no test depends on the removed handle
  - IDLE precheck.
