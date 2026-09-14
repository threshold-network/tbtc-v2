# RFC: New-wallet scheme preference + ECDSA retirement

**Status:** v7 — post-implementation reconciliation against
shipped C-2 (via earlier PRs) + D-1 (PR #443) + D-2.1 (PR #445)
**Date:** 2026-05-24
**Phases:** C-2 (governance new-wallet-scheme preference) + D (ECDSA wallet retirement migration)
**Decision sought:** Originally requested approval of the v6
shape. Granted; implementation shipped. This v7 revision is a
historical-record cleanup — reconciles the RFC text with the
deltas that landed during implementation review, so future
readers cite a consistent design.

> **Security-continuity correction (2026-07-13):** The current canonical
> upgrade retains `__ecdsaWalletCreatedCallback` with its exact legacy selector
> and registry authentication. The deployed contracts do not expose the pause
> and scheme-setter sequence described by the v7 historical reconciliation, so
> the callback must remain available for a DKG initiated immediately before the
> proxy upgrade. It is not gated by `ecdsaRetired`; new requests nevertheless
> remain FROST-only because the post-upgrade request path has no ECDSA dispatch.
> References below to structural callback removal describe the superseded v7
> implementation, not the current activation procedure.

## Revision history

### v7 — 2026-05-24 (post-implementation reconciliation)

Several v6 design decisions were modified during
implementation review of D-1 (PR #443) and D-2.1 (PR #445).
Most changes are bytecode-budget-driven (the post-#435 Bridge
ceiling is unforgiving) or Codex-correctness-driven (the
on-chain enforcement architecture got simpler, the operational
runbook gained the slack). Reconciled here so future audits
cite a consistent v7 spec.

#### C-2 implementation deltas (vs. v6 design)

- **Storage layout differs from v6's three-field plan.** v6
  proposed packing `uint128 ecdsaWalletCount`,
  `WalletScheme currentNewWalletScheme`, and
  `bool ecdsaWalletCountSeeded` into slot 38 in that
  declaration order. Shipped: `currentNewWalletScheme`
  (enum, 1B, offset 0) FIRST, then `ecdsaWalletCount`
  (uint128, 16B, offset 1) added later in **C-2.1a** (not
  C-2). The order swap is a side-effect of phasing:
  C-2 shipped only the scheme enum; C-2.1a (PR #442) added
  the counter as an additive append. D-1 (PR #443) then
  appended `bool ecdsaRetired` at offset 17. Total slot 37
  usage: 18 bytes / 32 bytes. **(Updated post-v7:** the
  packed slot landed at 37, not 38, because `frostWalletRegistry`
  (slot 32) + `ecdsaFraudRouter` (33) + `p2trFraudRouter`
  (34) + `lifecycleRouter` (35) + `walletIDByWalletPubKeyHash`
  (36) were appended before C-2's packed fields. The
  canonical storage-layout snapshot
  `solidity/test/formal/Bridge.storage-layout.json` is the
  source of truth; any "slot 38" claim in the body of this
  RFC is stale. See the table in §"Storage layout" below.)

- **`ecdsaWalletCountSeeded` flag DEFERRED indefinitely.**
  v6's `seedEcdsaWalletCount` one-time setter would have
  initialized the counter from a governance-supplied
  historical count (count of pre-C-2 `NewWalletRegistered`
  events) AND set a `ecdsaWalletCountSeeded = true` flag that
  D-2 enforced. Shipped: neither the setter nor the flag
  exist. Bytecode budget on the C-2.1a Bridge implementation
  could not absorb the setter (~300 bytes), and D-2 ended up
  not needing the flag (see D-2 deltas below — D-2 dropped
  `finalizeEcdsaRetirement` entirely). Documented as a
  deferred follow-up ("C-2.1b") that may land if a future
  PR needs the historical count for some other purpose.

- **`requestNewWalletOfScheme` governance override DEFERRED.**
  v6 specified a per-request scheme override callable by
  governance. Not shipped — bytecode budget on C-2 was tight
  and Codex review surfaced no concrete need. The scheme
  enum is already governance-flippable via the global
  setter; per-request override stays available as a future
  addition.

- **Counter increment site differs from v6's expectation.**
  v6 said the counter increments "in
  `__ecdsaWalletCreatedCallback`". Shipped: the increment
  lives in `Wallets.registerNewWallet` (the external library
  function the callback calls into). Same net behavior —
  ECDSA wallet creation through the registry path
  monotonically grows the counter — but the call site sits
  one delegation level lower. After D-2 removed the
  callback, the library increment is unreachable for new
  wallets, which is the desired terminal state.

#### D-1 implementation deltas (vs. v6 design)

- **D-1 setter DEFERRED to D-2** for bytecode-budget reasons.
  v6 specified `retireEcdsa(uint64 bufferPeriodSeconds)` on
  Bridge, an `EcdsaRetired(uint64, uint64)` event, and a
  `uint64 ecdsaRetirementBufferEnd` storage slot. Shipped
  D-1 (PR #443): only the storage flag (`bool ecdsaRetired`)

  - the Wallets-library request-side guard. The setter
    surface (~94 bytes Bridge) plus the buffer-end slot pushed
    Bridge past EIP-170; deferred the entire governance
    surface to D-2 (which freed reciprocal budget by removing
    `__ecdsaWalletCreatedCallback`).

- **Buffer period is no longer on-chain.** v6 stored
  `ecdsaRetirementBufferEnd` to enforce the 30-day-minimum
  buffer between D-1 and D-2. Shipped: no buffer slot, no
  on-chain enforcement of the buffer. The buffer is now an
  operational requirement only — governance commits to
  waiting the buffer period off-chain. (Made implicit by
  D-2's dropping `finalizeEcdsaRetirement`, which was the
  on-chain consumer of the buffer-end timestamp.)

- **Late-callback guard REMOVED (Codex P1 on #443).** v6
  said D-1's `__ecdsaWalletCreatedCallback` reverts on
  `ecdsaRetired`. Codex P1 review proved this creates a
  deadlock: the late callback's revert propagates through
  `WalletRegistry.approveDkgResult` and prevents the
  ECDSA registry's DKG state machine from transitioning back
  to IDLE; meanwhile, `Wallets.requestNewWallet` has an
  unconditional IDLE precheck on the ECDSA registry BEFORE
  the scheme branch, so a stuck registry blocks every
  subsequent FROST wallet creation too. Resolution: only
  the request-side guard ships in D-1; the "no late ECDSA
  wallets after retirement" invariant is enforced
  operationally (governance pauses Bridge → drains in-flight
  DKGs → sets flag → unpauses).

- **D-1 emits no event** (since no setter). v6 said D-1
  emits `EcdsaRetired`. Shipped: the event declaration is
  deferred to D-2 alongside the setter, where it lands as
  a no-arg `EcdsaRetired()` (the v6-spec'd args
  `(uint64 retiredAt, uint64 bufferEnd)` are both
  irrelevant in the no-buffer-on-chain architecture).

#### D-2 implementation deltas (vs. v6 design)

- **`finalizeEcdsaRetirement` DROPPED entirely.** v6 spent
  the bulk of its D-2 surface on a sophisticated
  `finalizeEcdsaRetirement(bytes20[])` function with a 4+1
  check verification chain (seeded + buffer + length +
  per-entry strictly-ascending + per-entry ECDSA-marker +
  per-entry Closed/Terminated state). Shipped D-2.1
  (PR #445) DOES NOT include this function. All four
  preconditions migrated off-chain to the activation
  runbook:

  - "Seeded" prereq doesn't exist (seed setter dropped).
  - Buffer period is operational only (no on-chain timer).
  - "All ECDSA wallets closed" is a governance commitment
    verifiable independently against on-chain state.
  - The on-chain ratchet that the function used to enforce
    is now provided by `Wallets.requestNewWallet`
    unconditionally reverting on Ecdsa scheme (Codex P1
    re-raise on #444) — no list-based check needed.

- **`__ecdsaWalletCreatedCallback` REMOVED, not "reverts".**
  v6 specified the function body becomes
  `revert("ECDSA retired")` (keep selector for older
  indexers). Shipped D-2.1: function and its `IWalletOwner`
  interface inheritance both REMOVED entirely. Attempting
  to call the removed selector reverts at the EVM dispatcher
  with no return data. Tradeoff: ~107 bytes of Bridge
  bytecode reclaim (needed to fit the D-1-deferred
  `retireEcdsa()` setter); cost is that older indexer
  ABIs see the selector vanish from Bridge.
  > **(Updated post-v7 per the 2026-08-14 canonical-mirror
  > review):** the canonical mirror (PR #971) RETURNS the
  > callback with its exact legacy selector and registry
  > authentication, so a DKG initiated in the last pre-upgrade
  > block can still complete after the proxy upgrade. The
  > "REMOVED entirely" claim above describes the v7 D-2.1
  > architecture that was reverted by the security-continuity
  > correction; see "Security-continuity correction" at the top
  > of this RFC. The `IWalletOwner` inheritance is also
  > retained on the canonical mirror (the `override` keyword
  > is preserved on `__ecdsaWalletHeartbeatFailedCallback`).
- **`Wallets.requestNewWallet` Ecdsa branch always-reverts
  (Codex P1 re-raise on #444).** v6's D-2 had the Ecdsa
  branch reverting only if a prior `finalizeEcdsaRetirement`
  succeeded. With finalizeEcdsaRetirement dropped, Codex
  flagged that the dispatch was still reachable in code
  on any Bridge where governance hadn't manually called
  `setNewWalletScheme(Frost)`. Resolution: the Ecdsa branch
  unconditionally reverts with `"ECDSA wallet creation retired"` regardless of scheme or flag state. The
  deadlock vector closes at the bytecode level.

- **`retireEcdsa()` setter is OPTIONAL (audit-trail only).**
  v6 framed the retire flag as load-bearing for D-2's
  precondition checks. With those checks dropped (no
  finalizeEcdsaRetirement) and the dispatch hard-blocked
  in code, the flag has no on-chain consequence — it's a
  governance-decision marker that emits `EcdsaRetired` for
  off-chain consumers. The setter on Bridge exists, but
  exercising it on mainnet requires redeploying
  BridgeGovernance (the v6 `BridgeGovernance.retireEcdsa()`
  forwarder is new source; the deployed non-proxy
  BridgeGovernance doesn't have the selector).

- **`__ecdsaWalletHeartbeatFailedCallback` PRESERVED** as a
  standalone external function (no `override` since
  `IWalletOwner` was dropped). Existing ECDSA wallets still
  report heartbeat failures via this callback; not removing
  it lets the existing lifecycle work indefinitely.

- **No public `ecdsaRetired()` getter on Bridge.** Bytecode
  budget. Off-chain consumers observe the flag via the
  `EcdsaRetired` event + storage slot 37 byte 17 decode
  (canonical storage-layout snapshot
  `solidity/test/formal/Bridge.storage-layout.json` packs
  `currentNewWalletScheme` (off 0) + `ecdsaWalletCount`
  (off 1) + `ecdsaRetired` (off 17) all into slot 37; the
  body bullets above at :40/:47 that say "slot 38" are stale
  — see "Storage layout differs from v6's three-field plan"
  reconciliation at the top of this section, and the
  "Updated post-v7" inline note below).
  (**Updated post-v7:** D-2.2 slice 1 — PR #447 — added the
  public `ecdsaRetired()` getter by trading the `emit EcdsaRetired()` in `retireEcdsa()` for the bytecode
  budget. The event declaration stays on BridgeState for
  ABI back-compat but no longer fires; off-chain consumers
  now poll the getter directly. See
  [`d2-2-followups-plan.md`](./d2-2-followups-plan.md) for
  the full D-2.2 slice plan, including deferred slices 2-4
  and the open question on re-introducing the event once
  D-2.2 slice 4 reclaims sufficient bytecode budget.)

#### Activation runbook (canonical mirror — supersedes the v7 numbered steps below)

The canonical mirror (PR #971 + the D-2.2 slice 3 follow-up)
removed the `setNewWalletScheme` setter, the `pause` ceremony,
and the `pause`/`unpause` step ordering described in the v6-era
runbook below. ECDSA wallet creation is removed permanently
from the canonical Bridge implementation; `requestNewWallet`
dispatches unconditionally to the FROST wallet registry and
reverts until governance wires the FROST wallet registry and
the lifecycle router. The live, authoritative activation
sequence is:

1. Deploy `BridgeLifecycleRouter(bridge)` (script
   `solidity/deploy/49_deploy_bridge_lifecycle_router.ts`
   ships with PR #971).
2. Verify the router's immutable `bridge` value.
3. Governance calls `Bridge.setLifecycleRouter(router)`.
4. Governance calls
   `FrostWalletRegistry.updateLifecycleOwner(router)`.
5. Verify `Bridge.lifecycleRouter() == router`,
   `FrostWalletRegistry.lifecycleOwner() == router`, and
   `Bridge.frostWalletRegistry() == FrostWalletRegistry`.

Steps 3 + 4 should be batched in the same governance action
where possible. If they cannot be batched, the system remains
safe because `Bridge.requestNewWallet` and
`Bridge.__frostWalletCreatedCallback` both fail closed until
the two addresses match (defense-in-depth via
`LifecycleRouterNotSet` and `LifecycleOwnerMismatch`).

ECDSA wallet creation is **not reversible by code** on the
canonical mirror — recovery from any FROST-path bug requires
a Bridge implementation upgrade (redeploy + proxy upgrade)
that reintroduces a scheme branch.

> **DEPRECATED — preserved for historical reference only.** The
> numbered v7 runbook below describes the original v6/v7
> activation sequence: pause → drain IDLE → call
> `setNewWalletScheme(Frost)` → deploy D-2 → unpause. That
> sequence is impossible on the canonical mirror because the
> `pause` modifier and the `setNewWalletScheme` setter were
> both removed.

v6's "Phase ordering summary" was a high-level dependency
DAG. Shipped activation requires a precise governance call
sequence to avoid the deadlock vector v7 closed:

1. (D-1 deployment) Bridge upgrade lands with the
   `ecdsaRetired` flag + Wallets-library guards.
2. (Pre-D-2) Governance pauses Bridge.
3. (Pre-D-2) Governance waits for the ECDSA registry to
   return to IDLE (drains any in-flight DKG).
4. (Pre-D-2 — **MANDATORY**) Governance calls
   `BridgeGovernance.setNewWalletScheme(Frost)` via the
   already-deployed BridgeGovernance (the function exists
   since C-2; no redeploy required).
5. (D-2 deployment) Bridge upgrade lands with
   `__ecdsaWalletCreatedCallback` removed +
   `Wallets.requestNewWallet` Ecdsa branch always-reverting.
6. Governance unpauses Bridge.
7. (Optional, audit-trail) Governance redeploys
   BridgeGovernance with the `retireEcdsa()` forwarder,
   transfers Bridge governance to the new instance, calls
   `BridgeGovernance.retireEcdsa()`. Flips the `ecdsaRetired`
   flag and emits `EcdsaRetired`. Skippable — the flag has
   no on-chain consequence post-D-2.

Steps 4 + 5 are the load-bearing pair. Skipping step 4 + 5
order would let an in-flight DKG result land on a Bridge
with the callback removed → strand the registry → block
all FROST creation.

#### Indexer / SDK impact (post-shipped behavior)

v6 said post-D-2 the `__ecdsaWalletCreatedCallback` selector
stays in the ABI as a `revert`-only function. Shipped: the
selector is fully gone from the Bridge ABI. Tooling that
referenced it must read the pre-D-2 ABI snapshot for
historical decoding.

### v6 — 2026-05-24

Codex round-5 caught one substantive bug + one prose cleanup:

- **[Codex P2 - D-2 list doesn't prove unique ECDSA wallets]**
  v5's `finalizeEcdsaRetirement` checked seeded + buffer +
  length-matches-counter + per-wallet terminal-state. But it
  didn't prove (a) each entry is actually an ECDSA wallet
  (governance could supply FROST wallet hashes, whose
  `ecdsaWalletID == 0`) or (b) each entry is unique
  (governance could duplicate a closed wallet to inflate the
  count while omitting a live ECDSA one). Either bypass means
  D-2 could finalize while a live ECDSA wallet still exists.
  **Fixed in v6:** the per-entry check adds
  `require(wallet.ecdsaWalletID != bytes32(0), "Not an ECDSA wallet")`
  AND the list is required to be in strictly-ascending hash
  order (enforced inline during the loop:
  `require(h > lastH, "Hashes not strictly ascending")`).
  Strictly-ascending forces uniqueness without an O(n²)
  dedup loop.

- **[Codex P3 - stale C-2 checklist wording]** v5 added the
  `ecdsaWalletCountSeeded` storage field to the design sketch
  but the implementation-plan step still said "C-2 adds two
  storage fields" (counting only the original two). The
  unit-test description said the post-seed count is "supplied
  value + post-seed creations" — missing the
  pre-seed-post-upgrade increments that v5's additive seed
  preserves. **Fixed in v6:** both prose strings updated to
  match the design.

### v5 — 2026-05-24

Codex round-4 review on v4 caught two more bugs:

- **[Codex P2 - seed overwrites post-upgrade counter]** v4's
  `seedEcdsaWalletCount` does `ecdsaWalletCount = historicalCount`. After C-2 ships, the default scheme is
  still ECDSA + any in-flight pre-C-2 DKG can complete and
  fire `__ecdsaWalletCreatedCallback` (incrementing the
  counter) BEFORE governance calls the seed. The seed
  overwrite would lose those increments, leaving the counter
  short and allowing D-2 to skip verifying the post-upgrade
  ones. **Fixed in v5:** seed is additive
  (`ecdsaWalletCount += historicalCount`), not overwriting.
  Governance supplies only the HISTORICAL portion (events
  emitted before the C-2 activation block); post-upgrade
  increments are preserved verbatim. The total
  `historical + post-upgrade` is what D-2 verifies against.

- **[Codex P2 - D-2 doesn't require seed flag]** v4's
  `finalizeEcdsaRetirement` checked buffer + list-length +
  per-wallet state — but not `ecdsaWalletCountSeeded`. If
  governance never called the seed, the counter is at 0
  (plus any post-upgrade increments) and a list whose length
  matches passes. The threat matrix called this out as
  "defense-in-depth" but didn't enforce on-chain. **Fixed in
  v5:** `finalizeEcdsaRetirement` adds
  `require(ecdsaWalletCountSeeded, "Counter not seeded")` as
  its first check. D-2 cannot run without an explicit seed
  call having happened.

### v4 — 2026-05-24

Codex round-3 review on v3 caught two stale-contradicts-design
issues:

- **[Codex P2 - counter init for pre-C-2 wallets]** v3 claimed
  the total-created counter has "no init step", but the field
  is introduced in C-2 to a LIVE proxy that already has ECDSA
  wallets registered before C-2 shipped. The counter would
  default to zero. If governance then flips to FROST without
  creating new ECDSA wallets, D-2 could accept an empty
  `remainingEcdsaWalletPubKeyHashes` list (0 == 0) and skip
  verifying any existing wallet is closed. **Fixed in v4:** C-2
  adds an explicit `seedEcdsaWalletCount(uint128 historicalCount)`
  one-time governance setter, called once at C-2 deployment
  with the count of `NewWalletRegistered` events emitted before
  the C-2 upgrade block. Verifiable by anyone via event replay
  (the seed is "trust but verify" — governance attests + anyone
  can audit the supplied count against the historical event
  stream).

- **[Codex P2 - stale decrement instruction in impl plan]** v3
  removed the decrement from the design + added a "no decrement"
  test, but implementation-plan step 8 still said "Add counter
  increment in `__ecdsaWalletCreatedCallback` AND counter
  decrement on the wallet state transition to Closed/Terminated".
  Following that step would reintroduce the empty-list D-2 bug.
  **Fixed in v4:** step 8 says increment only; no decrement.

### v3 — 2026-05-24

Codex round-2 review on v2 surfaced three more structural
issues:

- **[Codex P2 - Scenario B packing was wrong]** v2 claimed both
  `currentNewWalletScheme` (enum, 1B) and `ecdsaWalletCount`
  (uint128, 16B) would pack into one slot if C-2 lands before
  Phase A. Wrong: Solidity packs by declaration order. With the
  v2-shown order (enum first, uint128 second), the enum packs
  into slot 35 offset 20 (alongside `p2trFraudRouter`) and the
  uint128 starts slot 36 fresh — TWO slots, not one. **Fixed in
  v3:** the storage section now explicitly says
  `uint128 ecdsaWalletCount` MUST be declared FIRST so the enum
  packs into the trailing 16 bytes of the uint128's slot. Adds
  an explicit code-comment requirement in the implementation
  plan.

- **[Codex P2 - ecdsaWalletCount semantics inconsistent]** v2
  said the counter "increments on creation, decrements on
  Closed/Terminated" BUT D-2 used it as if it counts every
  ECDSA wallet ever created. If it decrements, after all
  wallets close the count is 0 and an empty list `[]` passes
  D-2's `list.length == ecdsaWalletCount` check without
  verifying any wallet's state. **Fixed in v3:** counter is a
  total-created counter (only increments, never decrements).
  D-2 then verifies the governance-supplied list covers every
  wallet we ever created. Tradeoff considered: an alternative
  "open-wallet" counter (decrements; D-2 requires `== 0`) is
  simpler at D-2 but trickier at C-2 deployment (existing
  pre-C-2 open wallets aren't counted, so the counter would
  need a governance-supplied initial value — re-introducing
  governance-trust); the total-created design has no init
  step + the on-chain counter is verifiable by anyone against
  `NewWalletRegistered` event count.

- **[Codex P2 - D-1 prereq checklist still had all-closed]**
  v2 correctly removed the all-closed pre-condition from the
  D-1 design AND moved it to D-2's design — but the D-1
  prerequisite CHECKLIST (a different section of the RFC)
  still listed "All existing ECDSA wallets in
  Closed/Terminated state" as a D-1 prereq. That preserved
  the contradiction in a later section. **Fixed in v3:** the
  all-closed item is removed from D-1's checklist and lives
  only under D-2's prereqs.

### v2 — 2026-05-24

Codex round-1 review surfaced three structural bugs; Gemini's
parallel review surfaced two refinements. All five addressed:

- **[Codex P2] C-2 storage slot accounting was wrong.** v1
  claimed `currentNewWalletScheme` would land at slot 38 with
  `__gap[39]`. On the merged #436 base, `p2trFraudRouter` is at
  slot 35; an appended 1-byte enum would pack into slot 35 at
  offset 20 (alongside the 20-byte `p2trFraudRouter` address),
  not start a new slot 38. The math also wasn't honest about
  whether Phase A (#434) lands first or after C-2 — Phase A
  adds two slots that shift everything. **Fixed in v2:** "Storage
  layout" section now presents both scenarios (Phase A landed
  first vs not), recommends explicit-own-slot placement via
  declaration order, and notes the storage-layout snapshot
  bootstrap is the authoritative source.

- **[Codex P2] D-1 pre-condition was self-contradictory.** v1
  required every ECDSA wallet to already be Closed/Terminated
  before D-1 could activate — but D-1's whole purpose is to
  block new ECDSA wallets WHILE existing ones finish their
  lifecycle. Pre-requiring everything to be drained means D-1
  can never activate during the drain period. **Fixed in v2:**
  D-1 has no all-closed pre-condition. D-2 keeps the closed-
  wallets check (the original v1 location was wrong; the right
  location is the hard-retirement gate).

- **[Codex P2] D-2 would have corrupted proxy storage.** v1
  said to "remove the `ecdsaWalletRegistry` storage slot
  reference" in D-2. That slot is NEAR THE START of
  `BridgeState.Storage`; removing it would shift every
  subsequent field's storage offset and corrupt the proxy.
  **Fixed in v2:** D-2 keeps the slot intact as a reserved
  placeholder. The contract address it holds becomes
  read-only (no production code path writes to or reads from
  it after D-2), but the slot itself is never deleted from the
  struct.

- **[Codex P2 + Gemini overlap] On-chain iteration over
  `registeredWallets` mapping is impossible.** v1's "enforced
  by an on-chain `require`" was a non-starter — Solidity
  mappings aren't enumerable. **Fixed in v2:** D-2 takes
  `bytes20[] calldata remainingEcdsaWalletPubKeyHashes` as a
  governance-supplied list of every wallet with a non-zero
  ecdsaWalletID; the on-chain check verifies each one is in
  Closed/Terminated and that the count matches a counter
  Bridge maintains (added in C-2 as a small bookkeeping
  field). Governance attestation + on-chain verification of
  the supplied list.

- **[Gemini] `requestNewWalletOfScheme` was missing the same
  registry-set guard.** When scheme==FROST, the governance
  override should still reject if `frostWalletRegistry == 0`.
  Otherwise governance can bypass the safety net the regular
  `setNewWalletScheme` guards. **Fixed in v2:** override
  enforces the same guard.

## Why one RFC for two phases

C-2 and D are tightly coupled by a hard sequencing constraint:

- C-2 must be live AND set to the FROST default BEFORE D can
  activate (otherwise `requestNewWallet` would silently mint an
  ECDSA wallet during the retirement transition).
- D must NOT activate until enough lead time has elapsed for
  active ECDSA wallets to complete `moveFunds` (drain BTC to FROST
  successors).

Splitting them into separate RFCs would force a meta-RFC just to
document the sequencing. Co-locating the two phases makes the
ordering invariants visible at one site.

## Context

After Phase A (#434) + Phase B-1/B-2:

- Bridge supports both ECDSA wallets (legacy path) and FROST
  wallets (registered via `setFrostWalletRegistry`'s target
  contract per the B-1 RFC).
- The lifecycle dispatch (`BridgeLifecycleRouter`, PR #434) routes
  per-wallet operations to the right path based on
  `wallet.ecdsaWalletID != 0`.
- Bridge's `requestNewWallet` still unconditionally calls
  `ecdsaWalletRegistry.requestNewWallet()` — there is no
  scheme-aware selection at request time.

C-2 adds the scheme-aware selection. D removes the legacy ECDSA
path once it's safe to do so.

## Phase C-2: scheme preference

> **NOTE (v7):** The detailed design sections below describe
> the v6 plan. Major elements (`seedEcdsaWalletCount`,
> `ecdsaWalletCountSeeded`, `requestNewWalletOfScheme`) were
> deferred or dropped during implementation. See the "C-2
> implementation deltas" subsection in §"Revision history /
> v7" at the top of this document for the as-shipped
> behavior. The body sections are preserved as historical
> design record; do NOT use them as the operator-facing
> reference.

### Goals

1. Governance can flip the default new-wallet scheme between ECDSA
   and FROST without a Bridge implementation upgrade.
2. The change takes effect on the next `requestNewWallet` call,
   not retroactively on wallets in-flight.
3. The default is ECDSA on activation of the C-2 upgrade
   (preserves current behavior; FROST opt-in must be explicit).
4. The mechanism is upgrade-safe (storage append-only, snapshot
   refreshed).
5. The mechanism cannot accidentally produce hybrid wallets (a
   single request becomes one ECDSA OR one FROST, never both).

### Design space + chosen shape

Three plausible shapes, summarized:

| Shape                                                                                                                                                                                 | Pros                                                                                                                   | Cons                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **A: Per-request scheme parameter.** Caller of `requestNewWallet(scheme)` picks ECDSA or FROST.                                                                                       | No governance flip needed; flexible per-request.                                                                       | Bridge API breaking change; permission question (any caller, governance only, sortition-pool?); harder to coordinate operator readiness. |
| **B: Stateful enum on Bridge (governance-flipped).** Bridge stores `currentNewWalletScheme` ∈ {ECDSA, FROST}. `requestNewWallet` reads it; governance flips via `setNewWalletScheme`. | Clean operator coordination (single global flag); easy auditability of when the flip happened; preserves existing API. | Sequential coordination (cannot have two schemes in-flight simultaneously).                                                              |
| **C: Round-robin with weights.** Bridge stores a weighted policy; each request advances a counter.                                                                                    | Lets governance gradually shift load between schemes; useful if ECDSA retirement is slow.                              | Significantly more state + dispatch logic; harder to reason about; tested-state explosion.                                               |

**Recommendation: shape B (stateful enum, governance-flipped).**

Rationale:

- Operator readiness is the binding constraint. FROST requires
  Phase B-2 (keep-core DKG coordinator) to be deployed on every
  operator. A single global flip aligns all operators on one
  cutover moment instead of asking them to handle both schemes
  per-request.
- B's audit story is trivially "when did the flip happen". A
  per-request shape (A) or weighted shape (C) needs governance
  to inspect every individual request to understand operator
  behavior.
- B's failure modes are tractable (the flip is idempotent; in v6
  the flip was rollback-able, but D-2.2 slice 3 (PR #971) removed
  the setter so the canonical mirror is irreversible by code).
  A and C introduce more complex unwind stories.

### Storage + interface

```solidity
// BridgeState.Storage (appended after existing fields).
// IMPORTANT: declaration order matters for Solidity slot packing.
// `ecdsaWalletCount` (uint128, 16B) MUST be declared FIRST so the
// trailing 1-byte enum + 1-byte bool pack into the same slot.
// Reversing the order would put each field in its own slot.
enum WalletScheme { Ecdsa, Frost }
uint128 ecdsaWalletCount;             // total ECDSA wallets EVER created.
                                       // Only increments (in
                                       // __ecdsaWalletCreatedCallback);
                                       // NEVER decrements on close. D-2
                                       // verifies the governance-supplied
                                       // remainingEcdsaWalletPubKeyHashes
                                       // list covers exactly this many
                                       // wallets and each is in
                                       // Closed/Terminated state.
WalletScheme currentNewWalletScheme;  // defaults to Ecdsa on init.
                                       // Packs into the same slot as
                                       // ecdsaWalletCount.
bool ecdsaWalletCountSeeded;          // guard so seedEcdsaWalletCount
                                       // can only run once. Packs
                                       // alongside the above (uint128 + enum
                                       // + bool = 18 bytes used).
// __gap decremented by 1 (all three new fields pack into one slot)

// Bridge.sol:
event NewWalletSchemeSet(WalletScheme indexed scheme);
event EcdsaWalletCountSeeded(uint128 historicalCount, uint128 totalAfterSeed);

function setNewWalletScheme(WalletScheme scheme)
    external onlyGovernance
{
    self.setNewWalletScheme(scheme);
}

/// One-time seed of the total-created counter from the off-chain
/// audit of NewWalletRegistered events emitted before the C-2
/// upgrade block. MUST be called exactly once, as the FIRST
/// post-deployment governance action (and before any subsequent
/// governance action that depends on counter accuracy, e.g. before
/// flipping the scheme via setNewWalletScheme). Reverts on second
/// call -- the counter cannot be re-seeded.
///
/// Verifiable by anyone via on-chain event replay; the seed is
/// "trust but verify" not zero-trust, but is auditable.
function seedEcdsaWalletCount(uint128 historicalCount)
    external onlyGovernance
{
    self.seedEcdsaWalletCount(historicalCount);
}

function newWalletScheme() external view returns (WalletScheme) {
    return self.currentNewWalletScheme;
}

function ecdsaWalletCount() external view returns (uint128) {
    return self.ecdsaWalletCount;
}

// Optional governance override (per open consideration #6).
// Same registry-set guard as the regular setter — bypasses the
// stateful default but NOT the safety net.
function requestNewWalletOfScheme(
    WalletScheme scheme,
    BitcoinTx.UTXO calldata u
) external onlyGovernance {
    if (scheme == WalletScheme.Frost) {
        require(
            self.frostWalletRegistry != address(0),
            "FROST registry not set"
        );
    }
    self.dispatchNewWalletRequest(scheme, u);
}

// Wallets.requestNewWallet (or Bridge.requestNewWallet wrapper):
function requestNewWallet(BitcoinTx.UTXO calldata u) external {
    self.dispatchNewWalletRequest(self.currentNewWalletScheme, u);
}

// Wallets internal helper:
function dispatchNewWalletRequest(
    BridgeState.Storage storage self,
    WalletScheme scheme,
    BitcoinTx.UTXO calldata
) internal {
    if (scheme == WalletScheme.Ecdsa) {
        require(!self.ecdsaRetired, "ECDSA retired");
        self.ecdsaWalletRegistry.requestNewWallet();
    } else {
        // setNewWalletScheme already guarantees frostWalletRegistry
        // is set when scheme can be Frost; this is defense-in-depth
        // for the requestNewWalletOfScheme override path and against
        // any future state-machine bug.
        require(
            self.frostWalletRegistry != address(0),
            "FROST registry not set"
        );
        IFrostWalletRegistry(self.frostWalletRegistry)
            .requestNewWallet();
    }
    emit NewWalletRequested();  // unchanged
}

// BridgeState internal: one-time additive seed for the
// total-created counter. Adds the historical (pre-C-2) count
// to whatever post-C-2 increments have already accumulated.
// Reverts if already seeded.
//
// CRITICAL: additive (`+=`), NOT overwriting. Between C-2
// activation and the seed call, the default scheme is still
// ECDSA + in-flight pre-C-2 DKGs can complete and increment
// the counter. Overwriting would lose those increments and
// let D-2 verify against a too-small count.
function seedEcdsaWalletCount(
    Storage storage self,
    uint128 historicalCount
) internal {
    require(!self.ecdsaWalletCountSeeded, "Already seeded");
    self.ecdsaWalletCount += historicalCount;  // additive, not overwrite
    self.ecdsaWalletCountSeeded = true;
    emit EcdsaWalletCountSeeded(historicalCount, self.ecdsaWalletCount);
}
```

The `ecdsaWalletCountSeeded` bool is appended to
`BridgeState.Storage` alongside the other v4 fields (packs into
the same slot — total: uint128 + enum + bool = 18 bytes used in
one 32-byte slot).

`BridgeGovernance.setNewWalletScheme(WalletScheme)` +
`requestNewWalletOfScheme(WalletScheme, UTXO)` both forward (no
governance delay, mirroring `setRedemptionWatchtower` /
`setEcdsaFraudRouter` patterns — single-flag toggles, not
parameter changes).

### Bytecode budget

After #434 (Phase A) + #435 (extraction) + #437 (B-1, doesn't
touch Bridge):

- Bridge: 23.831 KiB deployed
- EIP-170 headroom: 745 bytes

C-2 additions:

- `setNewWalletScheme` external (~50 bytes)
- `newWalletScheme` view (~30 bytes)
- `setNewWalletScheme` internal in BridgeState (~80 bytes)
- `NewWalletSchemeSet` event (~0 bytes)
- `dispatchNewWalletRequest` internal in Wallets (~80 bytes,
  replaces the inline-if-branch from v1's lower estimate)
- `requestNewWalletOfScheme` external on Bridge (~70 bytes)
- `ecdsaWalletCount` view (~30 bytes)
- Counter increment in `__ecdsaWalletCreatedCallback` (~15 bytes,
  ONLY increments — no decrement on close per v3)
- `seedEcdsaWalletCount` external + internal + event (~70 bytes,
  v4-added; one-time seed for pre-C-2 wallets)
- New error types (~20 bytes)
- Total: ~335 bytes (was ~265 in v3; v4 adds the seed step).

Headroom after C-2: ~410 bytes. Tighter than v3 but still
workable. Phases D-1 + D-2 are NET-NEGATIVE on Bridge bytecode
(D-2 reclaims ~1.3-2 KiB), so the temporary squeeze reabsorbs
by the time D-2 ships.

### Storage layout

C-2 appends three fields to `BridgeState.Storage` (all packed
into one slot per the declaration order):

- `ecdsaWalletCount` (uint128, 16 bytes) — total-created
  bookkeeping for the D-2 closed-wallets check. Incremented on
  every successful `__ecdsaWalletCreatedCallback`; NEVER
  decremented. D-2 verifies the governance-supplied list of
  remaining wallet pubkey hashes covers exactly this many
  wallets and each is in Closed/Terminated.
- `currentNewWalletScheme` (enum WalletScheme, 1 byte) — packs
  into the same slot as `ecdsaWalletCount` IFF
  `ecdsaWalletCount` is declared FIRST (Solidity packs in
  declaration order; the trailing 1-byte field uses the unused
  15B of the uint128's slot).
- `ecdsaWalletCountSeeded` (bool, 1 byte) — guard so
  `seedEcdsaWalletCount` can only run once. Joins the same
  packed slot as the other two
  (uint128 + enum + bool = 18 bytes in one 32-byte slot).

**Slot allocation depends on the Phase A (#434) merge order:**

Scenario A — Phase A merges before C-2 (the expected order):

| Slot | Field                                                                                              | Source |
| ---- | -------------------------------------------------------------------------------------------------- | ------ |
| 34   | `ecdsaFraudRouter` (address)                                                                       | #435   |
| 35   | `p2trFraudRouter` (address)                                                                        | #435   |
| 36   | `lifecycleRouter` (address)                                                                        | #434   |
| 37   | `walletIDByWalletPubKeyHash` (mapping)                                                             | #434   |
| 38   | `ecdsaWalletCount` (16B) + `currentNewWalletScheme` (1B) + `ecdsaWalletCountSeeded` (1B) co-packed | C-2    |
| 39+  | `__gap` (uint256[39] after C-2)                                                                    | —      |

Scenario B — C-2 merges before Phase A (less likely):

| Slot | Field                                                                                              | Source |
| ---- | -------------------------------------------------------------------------------------------------- | ------ |
| 34   | `ecdsaFraudRouter` (address, 20B)                                                                  | #435   |
| 35   | `p2trFraudRouter` (address, 20B)                                                                   | #435   |
| 36   | `ecdsaWalletCount` (16B) + `currentNewWalletScheme` (1B) + `ecdsaWalletCountSeeded` (1B) co-packed | C-2    |
| 37+  | `__gap` (uint256[41] after C-2)                                                                    | —      |

The Solidity-packing rule applied: declaring `uint128 ecdsaWalletCount` BEFORE `enum currentNewWalletScheme` causes
the enum (1B) to pack into the trailing 15B of the uint128's
slot. **Reversing the order would land them in two separate
slots** (the enum would pack into the trailing 12B of slot 35
alongside `p2trFraudRouter`, and the uint128 would start slot
36/38 fresh). The implementation PR MUST declare the uint128
first; this is asserted in the storage-layout snapshot.

The two new fields do NOT pack into the preceding slot — in
Scenario A the preceding field is a mapping (always its own
slot), and in Scenario B the preceding `address p2trFraudRouter`
has only 12B free which is not enough for the uint128.

Whichever order the merges happen in, the **storage-layout
snapshot test** (`test/formal/BridgeStorageLayout.test.ts`,
PR #433) is the authoritative source. The implementation PR
runs `BRIDGE_STORAGE_LAYOUT_BOOTSTRAP=1` to regenerate the
snapshot at merge time and commits it. The above table is for
RFC-reader orientation, not for hard-coding slot numbers in the
implementation.

`EXPECTED_RESERVED_TOTAL = 104` preserved either way (two new
fields packed into one slot decrements `__gap` by 1).

### Phase ordering invariant

C-2 MUST land AFTER B-1 + B-2 because `requestNewWallet` would
revert if `currentNewWalletScheme == Frost` but the FROST
registry isn't set / can't process requests.

To enforce this in code: `setNewWalletScheme(Frost)` reverts if
`self.frostWalletRegistry == address(0)`. Cannot flip to FROST
before the registry is wired.

## Phase D: ECDSA retirement

> **NOTE (v7):** The D-1 and D-2 design subsections below
> describe the v6 plan. Several load-bearing v6 elements
> were modified during implementation:
>
> - **D-1's `__ecdsaWalletCreatedCallback` revert guard was
>   REMOVED** (Codex P1 deadlock — a late callback revert
>   strands the ECDSA registry non-IDLE and blocks all
>   subsequent FROST wallet creation via the unconditional
>   IDLE precheck). The "no late ECDSA wallets" invariant is
>   enforced via the activation runbook (pause → drain
>   in-flight DKGs → set flag → unpause), NOT by the body
>   prose's `revert if ecdsaRetired` snippet.
>
> - **D-2's `finalizeEcdsaRetirement(bytes20[])` was DROPPED
>   ENTIRELY.** The seeded/buffer/list/per-entry verification
>   chain the body describes does NOT exist in the shipped
>   contract. On-chain safety instead comes from
>   `Wallets.requestNewWallet` unconditionally reverting on
>   the `Ecdsa` scheme regardless of any flag, plus the
>   structural removal of `__ecdsaWalletCreatedCallback`.
>
> See the "D-1 implementation deltas" and "D-2 implementation
> deltas" subsections in §"Revision history / v7" at the
> top of this document for the as-shipped behavior. The body
> sections are preserved as historical design record; do
> NOT use them as the operator-facing reference.

### Goals

1. Stop minting new ECDSA wallets (covered by C-2 flip to FROST).
2. Allow existing ECDSA wallets to complete their lifecycle
   (deposits sweep, redemptions finalize, moving-funds drain BTC
   to FROST successors).
3. Once all ECDSA wallets are in `Closed` or `Terminated` state,
   remove the ECDSA-specific contract surface from Bridge to free
   bytecode for future expansions.
4. Preserve historical indexer / SDK readability (ECDSA wallet
   records stay in Bridge state, just no new ones; events emitted
   prior to retirement remain unchanged).
5. The retirement is one-way (governance cannot un-retire);
   prevents accidental re-introduction of ECDSA capacity.

### Two-step retirement

D is a two-stage process, not a single PR. Each stage is its own
PR with its own activation:

**D-1: Soft retirement (block new, allow drain)**

D-1's job is to STOP NEW ECDSA wallets while existing ones
continue their lifecycle. No pre-condition on existing wallet
state — D-1 must be activatable DURING the drain period, not
after it.

Governance calls a new `retireEcdsa()` one-time setter on Bridge.
This:

- Sets a `bool ecdsaRetired` storage flag.
- (Historical — superseded by canonical mirror hardening.)
  Modifies `requestNewWallet` to revert if
  `currentNewWalletScheme == Ecdsa` AND `ecdsaRetired == true`.
  **In the canonical mirror (PR #971), the
  `currentNewWalletScheme` enum and its setter were removed
  under D-2.2 slice 3, and `Wallets.requestNewWallet`
  unconditionally reverts the Ecdsa branch with
  `"ECDSA wallet creation retired"` regardless of scheme or
  flag state.** The dead-state-check is moot; the
  always-reverts branch is what closes the deadlock vector.
- (Historical — was reverted during implementation review.)
  Reverts `__ecdsaWalletCreatedCallback` if `ecdsaRetired`.
  **In the canonical mirror the callback is retained (with
  legacy selector + registry authentication) so a DKG
  initiated in the last pre-upgrade block can still complete
  after the proxy upgrade; it is not gated by `ecdsaRetired`.
  New post-upgrade `requestNewWallet` calls are FROST-only
  because the post-upgrade request path has no ECDSA dispatch.
  See "Security-continuity correction" at the top of this
  RFC.**

D-1's only pre-condition is the governance-delay window
(standard for any one-time setter); there is no on-chain check
of existing wallet state. The intent is to set this flag as
EARLY as operators are confident no new ECDSA wallets are
needed, even while existing ones still have BTC to drain.

After D-1: no new ECDSA wallets can be created; existing ECDSA
wallets continue to operate normally until they reach Closed.

**D-2: Hard retirement (storage placeholder + bytecode cleanup)**

After all ECDSA wallets are in Closed/Terminated state AND the
buffer period has elapsed since D-1 activation (minimum 30 days,
default 90), a second upgrade.

Governance calls
`finalizeEcdsaRetirement(bytes20[] calldata remainingEcdsaWalletPubKeyHashes)`.
The on-chain check verifies (in order):

1. `ecdsaWalletCountSeeded == true` (v5-added). If the seed
   was never called, the counter is stale and the
   `length == ecdsaWalletCount` check below would be against
   an unseeded value — possibly 0, allowing an empty list to
   pass without verifying any wallet. The seed flag check
   blocks D-2 entirely until the seed has happened.
2. `block.timestamp >= ecdsaRetirementBufferEnd` (from D-1).
3. `remainingEcdsaWalletPubKeyHashes.length == ecdsaWalletCount`
   (uses the counter added in C-2; the governance-supplied list
   covers every wallet we ever created — pre-C-2 historical
   PLUS post-C-2 increments, courtesy of the additive seed in v5).
4. **Strictly-ascending hashes** (v6-added): the loop enforces
   `h[i] > h[i-1]`, forcing uniqueness without an O(n²) dedup
   scan. Prevents governance from inflating the count via
   duplicates while omitting a live ECDSA wallet.
5. For each entry `h` (v6-strengthened):
   - `registeredWallets[h].ecdsaWalletID != bytes32(0)` —
     proves the wallet is actually ECDSA. Prevents governance
     from supplying FROST wallet hashes (whose
     `ecdsaWalletID == 0` per the FROST marker convention) to
     fake-pad the list.
   - `registeredWallets[h].state == Closed OR Terminated` —
     proves the wallet has reached a terminal state.

The governance-supplied list is how we work around the
non-iterable mapping: governance attests off-chain to the
complete set; the on-chain check verifies the count matches the
counter (so nothing was hidden), every entry is uniquely the
hash of an ECDSA wallet (no padding with FROST or duplicates),
and every supplied wallet is in the expected terminal state.

After that pre-condition passes:

- Reverts `__ecdsaWalletCreatedCallback` from Bridge ABI
  (keep the function body as `revert("ECDSA retired")` to leave
  the ABI slot stable for older indexer integrations — bytecode
  cost is ~10 bytes, smaller than removing entirely + leaving
  callers with selector-not-found mysteries).
- Removes the ECDSA branches from
  `Wallets.requestNewWallet` / `registerNewWallet`.
- **Preserves `ecdsaWalletRegistry` storage slot intact.** That
  slot is near the start of `BridgeState.Storage`; removing it
  would shift every subsequent field's storage offset and
  corrupt proxy storage. The slot stays as a reserved
  placeholder for the lifetime of the proxy. No code path reads
  or writes to it after D-2; treated as immutable
  historical state.
- Same for `ecdsaWalletCount` and any other field used during
  drain — keep the slot, stop writing.
- Removes the ECDSA-specific branches from `BridgeLifecycleRouter`
  (the contract from #434).

After D-2: Bridge bytecode is smaller by an estimated ~1.3-2 KiB.
Historical ECDSA wallet records stay in `registeredWallets` for
indexer back-compat; write paths removed. `ecdsaWalletRegistry`
slot stays populated with its last-set address (the contract
remains deployed for cross-reference); no new on-chain writes
touch it.

### Bytecode reclaim estimate

The ECDSA-specific Bridge surface roughly comprises:

- `requestNewWallet`'s ECDSA branch + the `ecdsaWalletRegistry`
  `requestNewWallet` call — ~50 bytes
- `__ecdsaWalletCreatedCallback` — ~150 bytes
- `Wallets.registerNewWallet` ECDSA-specific (linked, but
  contributes to deployment cost via library link) — ~500 bytes
- ECDSA slashing/inactivity callbacks — ~300 bytes
- ECDSA-specific lifecycle branches in `BridgeLifecycleRouter` —
  ~200 bytes
- `__ecdsaWalletHeartbeatFailedCallback` — ~100 bytes

Combined: 1.3 KiB to 2 KiB of Bridge bytecode + ~3 KiB of linked
library bytecode that can be unlinked. Material savings; enables
future Phase E/F expansions without a fresh bytecode squeeze.

### Sequencing constraints

> **NOTE (v7):** The D-2 prerequisite list below cites
> `finalizeEcdsaRetirement(bytes20[])` and its list +
> counter + per-wallet on-chain checks as the enforcement
> mechanism for "all ECDSA wallets in Closed/Terminated".
> That function was DROPPED ENTIRELY in shipped D-2.1 (see
> the v7 "D-2 implementation deltas" subsection at the top
> of this document). On-chain safety in the shipped
> architecture instead comes from `Wallets.requestNewWallet`
> unconditionally reverting on the Ecdsa scheme; the
> "all-closed" prerequisite migrates to an operational
> commitment by governance, verifiable off-chain against
> Bridge state. The activation runbook in the v7 section
> at the top of this document is the authoritative
> sequencing reference for shipped behavior; the lists
> below describe the v6 plan that was approved but
> superseded during implementation.

D-1 prerequisites (all must be true):

- [x] #434 Phase A merged (lifecycle routing in place)
- [x] #435 fraud extraction merged
- [ ] #437 B-1 (FrostWalletRegistry) merged + wired via
      `setFrostWalletRegistry`
- [ ] Phase B-2 keep-core coordinator deployed + operators
      migrated (off-chain prereq)
- [ ] C-2 merged + governance has flipped
      `currentNewWalletScheme` to FROST
- [ ] At least 1 successful FROST wallet registered + signing
      sweeps on mainnet (smoke test)

D-1 has NO all-wallets-closed prereq (that was the v1 bug
fixed in v2; D-1's whole purpose is to BLOCK new ECDSA wallets
WHILE existing ones finish their lifecycle). The all-closed
check lives in D-2 only.

D-2 prerequisites (in addition to D-1):

- D-1 must have been live for the buffer period (30 days
  minimum, default 90)
- **All existing ECDSA wallets in `Closed` or `Terminated`
  state** (drained via `moveFunds` to FROST successors).
  Enforced on-chain by `finalizeEcdsaRetirement(bytes20[])`'s
  list + counter + per-wallet state checks.
- Zero on-chain activity touching the ECDSA write paths
  during the buffer period (verified via subgraph; not
  enforced on-chain)
- No outstanding ECDSA fraud challenges (verified via the
  legacy Bridge `fraudChallenges` mapping that #435 left in
  place for one-time migration; either the mapping is empty
  or `migrateLegacyFraudChallenges` has been run to move
  them to `EcdsaFraudRouter`)

### Indexer / SDK back-compat

D-1 changes:

- Subgraph: no new ECDSA `NewWalletRegistered` events after D-1
  activation; existing events stay queryable.
- SDK: deposit/redemption flows continue to work against existing
  ECDSA wallets; new wallet creation requests result in FROST
  wallets only.

D-2 changes:

- Subgraph: the `ecdsaWalletRegistry` datasource (if any) can be
  removed; historical ECDSA events stay queryable from prior
  blocks.
- SDK: `__ecdsaWalletCreatedCallback` is no longer in Bridge's
  ABI; any tooling that referenced it must read the historical
  ABI snapshot instead.

## Threat analysis (v2)

> **NOTE (v7):** Several mitigation rows below cite v6
> machinery that was deferred/dropped during implementation:
>
> - `requestNewWalletOfScheme` — DEFERRED (governance
>   override never shipped).
> - `seedEcdsaWalletCount` / `ecdsaWalletCountSeeded` —
>   DEFERRED (the seed setter + companion flag never
>   shipped). Rows that cite the seed flag as a D-2
>   precondition no longer apply.
> - `finalizeEcdsaRetirement(bytes20[])` + the
>   strictly-ascending-hash / per-entry-ECDSA-marker /
>   per-entry-Closed-or-Terminated chain — DROPPED ENTIRELY.
>   The corresponding "Governance supplies wrong list" /
>   "Governance pads with FROST" / "Governance duplicates
>   entry" rows describe a defense surface that no longer
>   exists on-chain. Equivalent protection comes from
>   `Wallets.requestNewWallet` unconditionally reverting on
>   the Ecdsa scheme (no list-based check needed — no new
>   ECDSA wallet can be created regardless of what
>   governance claims).
> - `setNewWalletScheme(Frost)` setter — REMOVED under D-2.2
>   slice 3 (PR #971). The "roll back to ECDSA" mitigation
>   that v6 promised in the row below is no longer reachable
>   on-chain. ECDSA wallet creation is removed permanently
>   from the canonical Bridge implementation; recovery from
>   any FROST-path bug requires a Bridge implementation
>   upgrade (redeploy + proxy upgrade) that reintroduces a
>   scheme branch.
> - `currentNewWalletScheme` enum — retained in storage for
>   layout preservation but no longer read or written.
>   `Wallets.requestNewWallet` dispatches unconditionally to
>   the FROST registry and reverts with
>   `FrostWalletRegistryNotSet` / `LifecycleRouterNotSet` /
>   `LifecycleOwnerMismatch` until the FROST wallet registry
>   and lifecycle router are wired. Once wired, every call
>   goes to FROST regardless of any prior intent.
>
> Threat rows preserved unchanged below: scheme dispatch
> guard, replay protection via chainid/governance binding,
> indexer back-compat, bytecode-budget regression check,
> counter monotonicity. See the v7 implementation-deltas
> subsections at the top of this document for the
> as-shipped defense surface.

| Threat                                                                                                       | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governance flips to FROST before B-1/B-2 ready → all new wallet requests revert                              | Canonical mirror (PR #971): `setNewWalletScheme(Frost)` setter is REMOVED (D-2.2 slice 3). `Wallets.requestNewWallet` reverts with `FrostWalletRegistryNotSet` until `Bridge.frostWalletRegistry != address(0)`, and additionally reverts with `LifecycleRouterNotSet` / `LifecycleOwnerMismatch` until both `Bridge.lifecycleRouter == FrostWalletRegistry.lifecycleOwner != address(0)`. The PR explicitly does not ship any scheme-flip path; the activation sequence is governance-wires-the-registry-then-the-router. |
| Governance override bypasses the registry-set guard (v1 gap)                                                 | `requestNewWalletOfScheme(Frost, ...)` DEFERRED, never shipped; the canonical mirror exposes no governance override of the dispatch path. Activation requires wiring the FROST wallet registry and the lifecycle router as one unit. |
| Bug discovered in FROST path after the flip — need to roll back | **There is no on-chain rollback.** The `setNewWalletScheme` setter, `requestNewWalletOfScheme` override, and `currentNewWalletScheme` enum were all removed under D-2.2 slice 3. `Wallets.requestNewWallet` dispatches unconditionally to the FROST registry and reverts with `FrostWalletRegistryNotSet` / `LifecycleRouterNotSet` / `LifecycleOwnerMismatch` until the FROST wallet registry and lifecycle router are wired; once they are, every call goes to FROST regardless of any prior intent. Recovery from a FROST-path bug requires a Bridge implementation upgrade (redeploy + proxy upgrade) that reintroduces a scheme branch. |
| D-1 activation blocked during drain period (v1 contradiction)                                                | D-1 has no on-chain pre-condition beyond the governance call itself. The all-wallets-closed check moved to D-2 where it semantically belongs                                                                                                                                                                                                                                                                     |
| D-2 closed-wallets check needs to iterate `registeredWallets` mapping (v1 impossibility)                     | DROPPED. `finalizeEcdsaRetirement(bytes20[])` was removed entirely; D-2.1 ships no list-based check. Canonical mirror (PR #971): the security property ("no live ECDSA wallet") is enforced by `Wallets.requestNewWallet` unconditionally reverting on the Ecdsa scheme, not by enumerating closed wallets on-chain.                                                                                                                                                                  |
| Governance lies about the remaining-wallets list                                                             | N/A on the canonical mirror — `finalizeEcdsaRetirement` was dropped; there is no list-based D-2 check for governance to lie about. The "all ECDSA wallets closed" invariant is enforced by the unconditional Ecdsa-branch revert in `Wallets.requestNewWallet`, which makes any future ECDSA wallet creation impossible regardless of governance claims.                                                                                                                                                          |
| D-2 corrupts proxy storage by removing `ecdsaWalletRegistry` slot (v1 bug)                                   | D-2 preserves the slot intact as a reserved placeholder; the slot stays for the lifetime of the proxy. Only write paths are removed                                                                                                                                                                                                                                                                              |
| Indexer-state corruption during retirement                                                                   | D is staged (D-1 soft / D-2 hard) + 30+ day buffer between them; operators have ample time to migrate indexer queries                                                                                                                                                                                                                                                                                            |
| Bytecode budget regression on the C-2 upgrade                                                                | ~280-byte cost estimated (v2 adds the counter + dispatch helper + override guard vs v1's ~230); leaves ~465 bytes EIP-170 headroom (verified before merge)                                                                                                                                                                                                                                                       |
| Hybrid wallet (one request becomes both schemes)                                                             | Canonical mirror: `Wallets.requestNewWallet` no longer branches on scheme — it dispatches unconditionally to the FROST registry. No hybrid path is reachable on-chain; an ECDSA-scheme selection is impossible because no setter exists.                                                                                                                                                                          |
| Replay of an old `setNewWalletScheme` transaction on a different chain                                       | N/A — canonical mirror (PR #971) has no `setNewWalletScheme` function. Cross-chain replay of the scheme-flip path is not reachable.                                                                                                                                                                                                                                                                            |
| Operator confusion about which scheme is current                                                             | Canonical mirror: `NewWalletSchemeSet` event declaration is preserved for ABI back-compat but no longer fires (the setter was removed). The scheme is by definition always FROST after the lifecycle router is wired; consumers must not rely on `NewWalletSchemeSet` as an activation signal. Read `Bridge.frostWalletRegistry()` / `Bridge.lifecycleRouter()` to determine whether FROST activation is complete. |
| ECDSA counter desync (count != actual total-ever-created)                                                    | Counter increments ONLY in `__ecdsaWalletCreatedCallback`; never decrements. Unit test verifies counter monotonically grows across a full request → register → close cycle. Cross-checkable off-chain by anyone via `NewWalletRegistered` event count                                                                                                                                                            |
| Counter incorrectly decremented (semantics bug)                                                              | Implementation MUST NOT add any decrement path. Verified by unit test that asserts counter doesn't decrement on wallet close/terminate. Codex v2-review specifically flagged this as a v2-design bug                                                                                                                                                                                                             |
| Counter starts at 0 for pre-C-2 wallets, D-2 bypassed with empty list (v3 bug Codex caught)                  | C-2 adds a one-time `seedEcdsaWalletCount(uint128)` governance setter; deployment runbook requires this is called BEFORE flipping the scheme. The supplied count is auditable by anyone via on-chain `NewWalletRegistered` event replay; `ecdsaWalletCountSeeded` flag prevents re-seeding                                                                                                                       |
| Governance seeds the wrong (low) count                                                                       | Anyone can audit the supplied value against the on-chain event count BEFORE the next governance action; the multi-step deployment (seed → audit-window → scheme-flip → drain → D-2) gives independent operators time to flag a wrong seed before it matters                                                                                                                                                      |
| Seed call overwrites post-C-2 increments (v4 bug Codex caught)                                               | v5 seed is ADDITIVE (`ecdsaWalletCount += historicalCount`), not overwriting. Between C-2 activation and the seed call, the default scheme is still ECDSA + in-flight pre-C-2 DKGs can complete and increment the counter; the additive seed preserves those increments. Governance supplies only the historical (pre-C-2) portion; the post-C-2 portion is whatever the running counter shows at seed-call time |
| Governance never calls `seedEcdsaWalletCount` and runs D-2 anyway                                            | D-2 enforces `require(ecdsaWalletCountSeeded)` as its first check (v5-added). The seed call is REQUIRED on-chain before D-2 can run, not just runbook-recommended                                                                                                                                                                                                                                                |
| Governance supplies D-2 list with duplicates (inflates length to match counter while omitting a live wallet) | Strictly-ascending `bytes20` hashes enforced in the loop (`h > lastH`). Forces uniqueness without an O(n²) dedup scan. v6-added                                                                                                                                                                                                                                                                                  |
| Governance pads D-2 list with FROST wallet hashes (length matches but doesn't prove ECDSA wallets closed)    | Per-entry `registeredWallets[h].ecdsaWalletID != bytes32(0)` check rejects FROST-keyed wallets (whose `ecdsaWalletID == 0` per the on-chain scheme marker). v6-added                                                                                                                                                                                                                                             |

## Open considerations

> **NOTE (v7):** Several open-consideration recommendations
> below propose v6 machinery that ultimately did NOT ship
> (or shipped in different form). Specifically:
>
> - **#1 D-2 buffer period parameter at D-1 activation:** No
>   `ecdsaRetirementBufferEnd` slot ships on-chain in D-1
>   (PR #443); buffer is operational only. The recommendation
>   for a contract-enforced minimum-30-day floor is moot.
> - **#6 `requestNewWalletOfScheme` governance override:**
>   DEFERRED (never shipped). The recommendation here was
>   approved in v6 but the bytecode budget on shipped C-2
>   could not fit it and Codex review surfaced no concrete
>   need; treat the recommendation as future-work-only.
>
> The other items (#2 D-1+D-2 split into separate PRs, #3
> keep BridgeLifecycleRouter post-retirement, #4 legacy
> fraud-challenge migration, #5 per-chain timing) are still
> live; #2 and #4 played out essentially as recommended.
> Read this section as the v6-era design rationale, not as
> open work; see the v7 implementation deltas at the top of
> this document + the per-phase plan docs for as-shipped
> behavior.

1. **D-2 buffer period.** 90 days is a reasonable default but
   governance may want longer for mainnet (allows operators to
   fully drain operationally + lets indexer migration breathe).
   **Recommendation:** make it a parameter set at D-1 activation
   time, with a minimum floor of 30 days enforced by the
   contract.

2. **D-1 + D-2 in one PR vs two?** D-1 changes are small (one
   setter + one bool + a couple of guards). D-2 is large
   (removal of code paths + library cleanup + storage layout
   adjustments). **Recommendation:** separate PRs. D-1 ships
   when operators are FROST-ready; D-2 ships after the buffer
   period, giving review focus to the storage/bytecode change.

3. **Should D-2 also delete `BridgeLifecycleRouter`?** After
   ECDSA retirement there's only one scheme in flight; the
   router's dispatch becomes a no-op. **Recommendation:** keep
   the router for one more cycle. If we later add a third
   scheme (e.g., FROST-with-Adaptor-Sigs), the router slot is
   already there. If after another year there's no third
   scheme, a Phase E could trim it. Premature cleanup of a
   working abstraction is worse than carrying it.

4. **Migration of legacy ECDSA fraud challenges.** #435 stubbed
   `Bridge.migrateLegacyFraudChallenges`. By D-1 activation,
   that helper either needs a real body (so legacy challenges
   migrate to the router) OR the legacy mapping needs to be
   confirmed empty. **Recommendation:** the migration helper
   body should land in a focused PR before D-1, as part of the
   D-1 prerequisite checklist. Documented in the cutover
   playbook in
   `Bridge.migrateLegacyFraudChallenges`'s NatSpec.

5. **Per-chain timing.** If Bridge ever deploys to a second
   chain (currently only Ethereum L1), each chain runs through
   D-1 + D-2 independently on its own schedule. The contracts
   are chain-local; no cross-chain coordination needed.

6. **C-2 vs per-request scheme override.** Some operators might
   want to occasionally request a specific scheme (e.g., test a
   FROST wallet on Sepolia without flipping the global default).
   **Recommendation:** add a `requestNewWalletOfScheme(scheme)`
   variant in C-2, callable only by governance, that bypasses
   the default. Keeps the global flip clean while enabling
   targeted experiments. ~100 bytes extra; budget allows.

## Implementation plan

> **NOTE (v7):** The numbered steps below are the v6
> implementation plan. They describe what was originally
> intended; the actually-shipped PRs (C-2, C-2.1a, D-1, D-2.1)
> diverged from this plan per the v7 deltas at the top of
> this document. Highlights of the divergence:
>
> - C-2 step 9 (`seedEcdsaWalletCount`) — DEFERRED, never
>   shipped.
> - C-2 step 7 (`requestNewWalletOfScheme`) — DEFERRED.
> - D-1 step 2 (`retireEcdsa(uint64 bufferPeriodSeconds)`
>   on Bridge) — DEFERRED to D-2; signature became
>   `retireEcdsa()` no-arg (no buffer slot on-chain).
> - D-1 step 4 (`__ecdsaWalletCreatedCallback` reverts if
>   `ecdsaRetired`) — REMOVED (Codex P1 deadlock; see body
>   §"Phase D" v7 note).
> - D-2 step 1 (`finalizeEcdsaRetirement(bytes20[])`) —
>   DROPPED ENTIRELY.
> - **C-2 setter removed under D-2.2 slice 3 (PR #971):**
>   `setNewWalletScheme` external + `setNewWalletScheme`
>   internal + `requestNewWalletOfScheme` governance override
>   + `NewWalletSchemeSet` event emission were all removed.
>   `currentNewWalletScheme` storage field is preserved
>   (layout-only) but never read or written. Steps 2/3/6/7
>   below describe a surface that no longer ships on the
>   canonical Bridge implementation; the canonical mirror is
>   irreversible by code.
>
> Use the body of this section as historical design intent
> only; the live operator-facing reference is the v7
> reconciliation at the top + the per-phase plan docs
> (`d1-ecdsa-soft-retirement-plan.md`,
> `d2-ecdsa-hard-retirement-plan.md`).

### C-2 (one PR) — DEPRECATED

> **DEPRECATED — preserved for historical reference only.** The
> numbered steps below describe the v6 implementation plan that
> was approved before the implementation diverged. Steps 2, 3,
> 7, 9, and 10 describe setters / overrides / forwarders that
> the canonical mirror (PR #971) does not ship: `setNewWalletScheme`
> external + internal, `requestNewWalletOfScheme` governance
> override, and `seedEcdsaWalletCount` historical-count setter
> were all deferred or removed (see "C-2 implementation deltas"
> in §"Revision history / v7" at the top of this document for
> the per-step shipped-vs-deferred reconciliation). The live
> canonical activation sequence is the activation runbook in
> the d2-2-followups-plan.md slice-3 section, not this body.

1. Add three fields to `BridgeState.Storage`, in this declaration
   order (so they all pack into one slot):
   - `uint128 ecdsaWalletCount;` (16B)
   - `WalletScheme currentNewWalletScheme;` (enum, 1B)
   - `bool ecdsaWalletCountSeeded;` (1B)
     Decrement `__gap` by 1. (Plus declare `enum WalletScheme { Ecdsa, Frost }` adjacent to the struct.) The reverse
     declaration order would put each field in its own slot — the
     storage-layout snapshot test catches this drift.
2. Add `setNewWalletScheme` internal in BridgeState (reversible
   — flips between Ecdsa and Frost; rejects Frost if
   `frostWalletRegistry == 0`).
3. Add `setNewWalletScheme` external on Bridge gated by
   `onlyGovernance`.
4. Add `newWalletScheme` + `ecdsaWalletCount` views on Bridge.
5. Add `NewWalletSchemeSet` event on BridgeState (mirror on
   Bridge for ABI).
6. Add `dispatchNewWalletRequest` internal in Wallets; rewrite
   `requestNewWallet` to call it with the current scheme.
7. Add `requestNewWalletOfScheme` external on Bridge gated by
   `onlyGovernance`; enforces same `frostWalletRegistry != 0`
   guard.
8. Add counter increment in `__ecdsaWalletCreatedCallback`
   (the new ECDSA wallet creation entry — increments
   `ecdsaWalletCount`). **NO decrement** anywhere; the counter
   is total-created and monotonically grows per v4. The unit
   test explicitly asserts no decrement path exists.
9. Add `seedEcdsaWalletCount(uint128 historicalCount)` one-time
   governance setter that initializes `ecdsaWalletCount` from
   the off-chain audit of `NewWalletRegistered` events emitted
   before the C-2 upgrade activation block. Reverts after the
   first successful call (cannot be re-seeded). Without this
   step, the counter would default to 0 for existing pre-C-2
   wallets and D-2 could be bypassed with an empty list.
10. Add `setNewWalletScheme` + `requestNewWalletOfScheme` +
    `seedEcdsaWalletCount` forwarders to `BridgeGovernance`.
11. Regenerate storage-layout snapshot.
12. Unit tests: scheme defaults to ECDSA; flip to FROST reverts
    if `frostWalletRegistry == 0`; happy-path flip;
    reversibility; `requestNewWallet` dispatches correctly per
    scheme; `requestNewWalletOfScheme` honors override AND
    enforces the FROST registry-set guard; counter increments
    on ECDSA creation; counter does NOT decrement on
    Closed/Terminated (verify the counter monotonically grows
    across the full request → register → close cycle); storage
    layout test verifies `ecdsaWalletCount` is declared FIRST
    (before `currentNewWalletScheme` and
    `ecdsaWalletCountSeeded`) so all three fields pack into one
    slot; `seedEcdsaWalletCount` reverts on second call;
    post-seed, the counter equals `supplied historicalCount + any pre-seed post-upgrade increments + any post-seed creations` (v6-corrected: the v5 additive seed preserves
    pre-seed post-upgrade increments, which v5's test
    description had elided).
13. **C-2 deployment runbook**: off-chain operator counts
    `NewWalletRegistered` events from Bridge contract creation
    up to (and including) the block immediately before C-2's
    activation. Governance calls `seedEcdsaWalletCount(N)` with
    that count as the FIRST post-deployment governance action.
    Independent operators verify the supplied count against the
    same event audit before any subsequent governance action
    (e.g. before flipping the scheme).
14. Update `tbtc-monorepo` cutover playbook +
    `wallet-lifecycle-migration-plan.md` to reflect C-2.

### D-1 (separate PR; gated on B-1/B-2/C-2 live + governance call) — DEPRECATED

> **DEPRECATED — preserved for historical reference only.** The
> numbered steps below describe the v6 design. Step 1 adds a
> `ecdsaRetirementBufferEnd` slot that D-2.2 confirmed never
> shipped. Step 2 specifies a `retireEcdsa(uint64)` setter that
> ships in the canonical mirror as `retireEcdsa()` no-arg. Step
> 4 specifies a late-callback revert that was REMOVED during
> implementation review (Codex P1 deadlock); the canonical
> mirror RETURNS the callback with its legacy selector and
> registry authentication. Step 5 specifies a
> `EcdsaRetired(uint64,uint64)` event that ships as a no-arg
> `EcdsaRetired()` declaration that never fires. The live D-1
> / D-2 narrative is in `d1-ecdsa-soft-retirement-plan.md` and
> `d2-ecdsa-hard-retirement-plan.md`.

1. Add `bool ecdsaRetired` + `uint64 ecdsaRetirementBufferEnd`
   slots to BridgeState (pack into one slot; decrement `__gap`
   by 1).
2. Add `retireEcdsa(uint64 bufferPeriodSeconds)` external on
   Bridge gated by `onlyGovernance`. **No pre-condition on
   existing wallet state** (D-1 must be activatable during the
   drain period). Sets `ecdsaRetired = true` + stores
   `block.timestamp + max(bufferPeriodSeconds, 30 days)`.
3. `dispatchNewWalletRequest` reverts if `ecdsaRetired` AND
   scheme is Ecdsa (defense in depth on top of C-2's flip
   semantics).
4. Bridge's `__ecdsaWalletCreatedCallback` reverts if
   `ecdsaRetired`.
5. Emit `EcdsaRetired(uint64 retiredAt, uint64 bufferEnd)` event.
6. Unit tests: happy-path activation (no pre-condition on
   wallet state); `requestNewWallet` reverts for Ecdsa after
   activation; `__ecdsaWalletCreatedCallback` reverts after
   activation; existing ECDSA wallet lifecycle paths (move
   funds, slash, inactivity, close) STILL succeed after
   activation; the legacy ECDSA registry's slashing/inactivity
   callbacks STILL succeed after activation.
> **DEPRECATED — preserved for historical reference only.** The
> numbered steps below describe the v6 design. Step 1 specifies
> `finalizeEcdsaRetirement(bytes20[])` with the v6 5-check
> chain — DROPPED ENTIRELY in the canonical mirror; no list-
> based D-2 verification ships. Step 2 specifies reverting the
> `__ecdsaWalletCreatedCallback` body; the canonical mirror
> RETURNS the callback with its legacy selector. Step 3
> describes an Ecdsa scheme branch in
> `Wallets.requestNewWallet`; the canonical mirror removed
> the scheme branch and dispatches unconditionally to FROST.
> The live D-2 narrative is in `d2-ecdsa-hard-retirement-plan.md`.
### D-2 (separate PR; gated on D-1 + buffer period elapsed + all wallets closed) — DEPRECATED

1. Add `finalizeEcdsaRetirement(bytes20[] calldata remainingEcdsaWalletPubKeyHashes)`
   external on Bridge gated by `onlyGovernance`.
   Pre-conditions verified on-chain (in order):
   - **`ecdsaWalletCountSeeded == true`** (v5-added; ensures
     the counter is post-seed so the length check below is
     meaningful — without this, an unseeded counter could be
     0 and an empty list would pass).
   - `block.timestamp >= ecdsaRetirementBufferEnd` (from D-1).
   - `remainingEcdsaWalletPubKeyHashes.length == ecdsaWalletCount`
     (the supplied list MUST cover every wallet we ever
     registered — pre-C-2 historical + post-C-2 increments,
     totaled by the v5 additive seed).
   - For each entry `h` in the list (loop iteration; v6-added):
     - `h > lastH` (strictly ascending; forces uniqueness
       without an O(n²) dedup scan).
     - `registeredWallets[h].ecdsaWalletID != bytes32(0)` (the
       entry is actually an ECDSA wallet, not a FROST one with
       the matching pubKeyHash20).
     - `registeredWallets[h].state == Closed OR Terminated`.
       On success: marks an `ecdsaFinalized` flag.
2. Rewrite `__ecdsaWalletCreatedCallback` body to
   `revert("ECDSA retired")` (keep selector in ABI — cheaper
   bytecode than removing entirely + clearer for older
   indexer integrations).
3. Remove ECDSA branches from `dispatchNewWalletRequest` /
   `Wallets.registerNewWallet`. Keep an `if (scheme == Ecdsa) revert ("ECDSA retired");` as the new branch (defense in
   depth; bytecode-cheap).
4. **PRESERVE all ECDSA-related storage slots** (`ecdsaWalletRegistry`,
   `ecdsaWalletCount`, etc.). These are near the start of
   `BridgeState.Storage`; removing them would shift every
   subsequent slot and corrupt proxy storage. Treated as
   immutable historical state.
5. Remove ECDSA-specific dispatch from `BridgeLifecycleRouter`
   (the contract from #434) — or leave as `revert("ECDSA retired")` per open consideration #3.
6. Storage-layout snapshot regenerated (verifies no slots moved
   — only code-path removals).
7. Bytecode-budget verification: estimated savings 1.3–2 KiB on
   Bridge.
8. Unit tests: pre-condition `require`s — incomplete list rejects;
   wrong-state entry rejects; buffer-not-elapsed rejects; happy
   path; post-finalize all ECDSA write paths revert; post-
   finalize all ECDSA read paths (historical wallet records)
   still succeed.

## Phase ordering summary

```
#431 + #432 + #433 (merged)
  ├─ #434 Phase A (rebased, CI in flight)
  │
  ├─ #435 fraud extraction (merged) ──► #436 cleanup (merged)
  │
  └─ #437 B-1 RFC (in review) ───► B-1 impl PR ───► B-2 impl ─┐
                                                              │
                                                              ▼
                                              ┌─ C-1 PR (datasource retarget)
                                              │
                                              └─ C-2 PR (scheme preference)
                                                          │
                                                          ▼
                                              (governance flips to FROST)
                                                          │
                                                          ▼
                                              (operators drain ECDSA wallets)
                                                          │
                                                          ▼
                                                  D-1 PR (soft retire)
                                                          │
                                                          ▼
                                              (buffer period: 90+ days)
                                                          │
                                                          ▼
                                                  D-2 PR (hard retire)
```

C-1 is parallel-shippable with C-2; B-2 is a long-lead off-chain
prereq, started as soon as B-1 lands.

## Approval needed (v6) — HISTORICAL

> **NOTE (v7):** The numbered approval items below are the
> v6 design's approval requests. They were granted at the
> time and the implementation began, but the implementation
> diverged from v6 in the ways the v7 reconciliation at the
> top of this document captures.
>
> Specifically, the following v6 approval items shipped in
> a materially different form than approved:
>
> - #1 — `requestNewWalletOfScheme` governance override:
>   DEFERRED, never shipped.
> - #2 — three packed fields incl. `ecdsaWalletCountSeeded`:
>   `ecdsaWalletCountSeeded` was DEFERRED. Shipped layout:
>   `currentNewWalletScheme` + `ecdsaWalletCount` +
>   `ecdsaRetired` (the last from D-1).
> - #2 (continued) — additive `seedEcdsaWalletCount`:
>   DEFERRED, never shipped. The historical-count seeding
>   never happened on the live chain.
> - #4 — `finalizeEcdsaRetirement` 5-check chain: DROPPED
>   ENTIRELY. D-2's on-chain safety comes from
>   `Wallets.requestNewWallet` unconditionally reverting on
>   the Ecdsa scheme, not from the list-based check.
> - #6 — minimum-30-day buffer floor between D-1 and D-2:
>   not enforced on-chain (no `ecdsaRetirementBufferEnd`
>   slot shipped). Buffer is an operational requirement
>   only.
> - #8 — runbook requiring `seedEcdsaWalletCount` as FIRST
>   post-deploy governance action: moot — the function
>   doesn't exist on the live chain.
>
> This section is preserved as historical record of the
> design that was approved. For the as-shipped contract,
> see "C-2 implementation deltas" / "D-1 implementation
> deltas" / "D-2 implementation deltas" in §"Revision
> history / v7" at the top of this document.

Approve:

1. C-2 shape B (stateful enum, governance-flipped; **D-2.2 slice 3
   later removed the flip surface — see top of this RFC for the
   as-shipped irreversible state**)
   - the `requestNewWalletOfScheme` governance override
     (Gemini-required `frostWalletRegistry != 0` guard included)?
2. C-2's three new storage fields packed into one slot in this
   declaration order:
   - `uint128 ecdsaWalletCount` (total-created; only increments,
     never decrements);
   - `WalletScheme currentNewWalletScheme` (enum);
   - `bool ecdsaWalletCountSeeded` (one-time seed guard);
     plus the v5-additive `seedEcdsaWalletCount(uint128)` one-time
     governance setter for pre-C-2 wallets (additive, NOT
     overwriting — preserves any pre-seed post-upgrade
     increments)?
3. D's two-stage structure with **no all-closed pre-condition
   on D-1** (the pre-condition was wrong in v1; it belongs at
   D-2)?
4. D-2's `finalizeEcdsaRetirement(bytes20[])` verification
   chain (each check in order):
   - `require(ecdsaWalletCountSeeded)` — seed must have
     happened (v5);
   - `require(block.timestamp >= ecdsaRetirementBufferEnd)` —
     buffer elapsed;
   - `require(list.length == ecdsaWalletCount)` — list size
     matches total-created counter;
   - per-entry loop enforces:
     - `h > lastH` — strictly-ascending hashes (uniqueness
       without O(n²), v6-added);
     - `registeredWallets[h].ecdsaWalletID != bytes32(0)` —
       entry is actually ECDSA (not a FROST wallet whose
       `ecdsaWalletID == 0`, v6-added);
     - `registeredWallets[h].state == Closed || Terminated`?
5. D-2's storage-preservation rule (`ecdsaWalletRegistry` slot
   stays as a reserved placeholder; never removed — removing
   it would shift every subsequent slot and corrupt the proxy)?
6. The minimum-30-day buffer floor between D-1 and D-2 (default
   90 if governance doesn't specify)?
7. The phase-ordering invariants (D-1 requires only governance;
   D-2 requires the full v6 verification chain above)?
8. The C-2 deployment runbook requirement that
   `seedEcdsaWalletCount` is the FIRST post-deployment
   governance action and operationally blocks all subsequent
   governance actions (scheme flip, etc.) until independent
   operators have audited the supplied count against the
   on-chain event stream?

If approved, the implementation PRs drop in the order shown in
"Phase ordering summary".
