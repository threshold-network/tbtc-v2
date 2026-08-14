# D-1: ECDSA soft retirement (guards-in-place edition)

## Status

In review. Branched from `feat/c2-1-ecdsa-wallet-counter-seed-2026-05-24`.
Ships the storage flag and the request-side guard that blocks new
ECDSA wallet creation when the flag is set. The Bridge-side
governance setter that flips the flag is **deferred to D-2** for
the bytecode-budget reason captured below.

> **Canonical-mirror correction (2026-08-14):** PR #971 + the
> D-2.2 slice 3 follow-up further removed `setNewWalletScheme`
> and the `requestNewWallet` scheme branch. ECDSA wallet creation
> is removed permanently from the canonical Bridge implementation:
> `Wallets.requestNewWallet` dispatches unconditionally to the
> FROST wallet registry and reverts with `FrostWalletRegistryNotSet`
> / `LifecycleRouterNotSet` / `LifecycleOwnerMismatch` until the
> FROST wallet registry and lifecycle router are wired. Once
> wired, every call goes to FROST regardless of any prior intent.
> Rollback requires a Bridge implementation upgrade (redeploy +
> proxy upgrade) that reintroduces a scheme branch. The
> description of "flipping to FROST" via `setNewWalletScheme`
> below describes the superseded v6/C-2 design, not the canonical
> mirror.

1. `BridgeState.Storage.ecdsaRetired` (bool, 1 byte) — packed into
   slot 37 at offset 17, alongside the existing
   `currentNewWalletScheme` (offset 0, enum 1 byte) and
   `ecdsaWalletCount` (offset 1, uint128 16 bytes) from C-2 / C-2.1.
   Total slot 37 usage: 18 bytes; no `__gap` decrement.
2. Guard inside `Wallets.requestNewWallet` (external library):
   `require(!self.ecdsaRetired, "ECDSA wallet creation retired")`
   on the ECDSA-scheme branch. Frost-scheme routing is untouched.
3. `Wallets.registerNewWallet` is intentionally **not** guarded
   by the flag. Reverting from the ECDSA registry's
   `__ecdsaWalletCreatedCallback` would propagate up through
   `WalletRegistry.approveDkgResult` and prevent the registry's
   own DKG state machine from transitioning back to IDLE.
   `Wallets.requestNewWallet` has an unconditional IDLE precheck
   on the ECDSA registry **before** the scheme branch, so a
   stuck ECDSA registry would also freeze every subsequent
   FROST wallet creation — the exact failure mode D-1 is meant
   to prevent. (Codex P1 review on this PR; original design
   carried this guard and was removed during review.) The
   "no late ECDSA wallets after retirement" invariant is
   enforced operationally — see the activation runbook below.
4. Storage-layout snapshot refresh (`Bridge.storage-layout.json`)
   - `EXPECTED_RESERVED_TOTAL` bump from 105 → 106 in
     `BridgeStorageLayout.test.ts`.
5. `BridgeStub.setEcdsaRetiredForTest(bool)` — test-only helper
   that pokes the flag directly. Mirrors how mainnet would
   activate the flag through a storage-layout-compatible upgrade
   when D-2 lands.
6. Five-case unit test suite at
   `test/bridge/Bridge.D1EcdsaRetirement.test.ts`:
   request-side guard fires when retired, doesn't fire when
   not retired, doesn't forward to the ECDSA registry on revert;
   late callback registers the wallet in both retired and
   non-retired states (the retired-state case is the explicit
   no-deadlock regression pin).

## What this PR deferred to D-2

- `Bridge.retireEcdsa()` external governance setter +
  `BridgeGovernance.retireEcdsa()` forwarder + `EcdsaRetired()`
  event mirror on Bridge.
- Public `Bridge.ecdsaRetired()` getter.

### Why deferred

Adding the setter, getter, and event-mirror pushed the Bridge
implementation past the **24 KiB EIP-170 deploy limit** by
approximately 94 bytes (compiled at the runs=200 optimizer setting
the rest of the migration stack uses; lowering optimizer runs to
buy back the headroom is blocked by the OpenZeppelin
upgrades-core `deployProxy` validations path documented in PR
#435 / #439).

The Bridge implementation is currently at **24,547 bytes**
(C-2.1a baseline); the EIP-170 limit is 24,576 bytes. D-1 with
the full setter surface measured **24,670 bytes** (94-byte
overrun).

### Why this is safe to defer

The hazard D-1 closes is **"new ECDSA wallet requests keep
being accepted after governance has decided to stop them."**
That hazard already has a primary mitigation in C-2:
`setNewWalletScheme(Frost)` routes every subsequent
`requestNewWallet` call to the FROST registry instead of the
ECDSA registry. The `ecdsaRetired` flag is a **defense-in-depth
ratchet** on top of that: once flipped it prevents a future
governance flip back to `Ecdsa` from re-opening the request
boundary. In-flight DKGs that started before the flip are
drained operationally rather than neutralized on-chain (see
§"Activation runbook" below) — neutralizing them on-chain
would have required reverting from the registry's late callback,
which strands the registry in a non-IDLE state and deadlocks
all subsequent FROST wallet creation.

Until the setter lands:

- Governance enforces "no new ECDSA wallets" by calling
  `setNewWalletScheme(Frost)` and committing to not flip back.
- The on-chain `requestNewWallet` guard still fires if the
  flag is somehow set via a storage-layout-compatible upgrade
  — the defense-in-depth property survives intact.
- The storage slot exists and is observable via
  `eth_getStorageAt(bridge, 38)` (decode byte 17).

## Activation runbook (when the setter lands in D-2)

Because `Wallets.registerNewWallet` deliberately doesn't gate
on `ecdsaRetired` (see §"What this PR ships" item 3), flipping
the flag while an ECDSA DKG is in the approval/challenge phase
would let the late-arriving callback create one final ECDSA
wallet. To prevent that, governance MUST follow this sequence:

1. Pause the Bridge via `BridgeGovernance` (blocks new
   `requestNewWallet` invocations on both schemes).
2. Wait for `ecdsaWalletRegistry.getWalletCreationState()`
   to return `IDLE`. If a DKG is mid-flight, either let it
   finish (the callback fires, the registry transitions back
   to IDLE, and a final ECDSA wallet is registered) or use
   the registry's own challenge/timeout path to abandon it.
3. Call `BridgeGovernance.retireEcdsa()` (added in D-2).
4. Unpause Bridge.

After step 3 every subsequent `requestNewWallet` routed to the
ECDSA scheme reverts with `"ECDSA wallet creation retired"`.
Wallets already in any post-Live state continue their full
lifecycle (sweeps, redemptions, fraud, moving funds, closing,
termination).

## Activation path when D-2 lands

D-2 will reclaim bytecode budget by removing the ECDSA-specific
machinery that D-2 itself supersedes:

- `Bridge.__ecdsaWalletCreatedCallback`
- `Bridge.slashWalletForFraud` ECDSA-only callback
- Legacy ECDSA wallet registry wiring on Bridge

That reclaim opens enough bytecode budget to re-introduce:

- `function retireEcdsa() external onlyGovernance` on Bridge
- `function retireEcdsa() external onlyOwner` forwarder on
  BridgeGovernance
- `event EcdsaRetired()` — both the BridgeState library
  declaration (also deferred in D-1 to avoid declaring an
  event with no emitter) and the Bridge-side ABI mirror that
  surfaces it for off-chain consumers
- `function ecdsaRetired() external view returns (bool)`
  getter on Bridge

The internal library body that backs the setter is intentionally
**not** declared in this PR either — adding an unused internal
function to BridgeState would not increase Bridge bytecode (it
would just be dead code) but it would invite drift between the
deferral note in `Bridge.sol` and the live library surface. The
D-2 PR adds them together.

## Upgrade-safety check

- Slot 38 layout before D-1: `currentNewWalletScheme` (offset 0,
  1 byte) + `ecdsaWalletCount` (offset 1, 16 bytes) = 17 bytes
  used, 15 bytes free.
- Slot 38 layout after D-1: above + `ecdsaRetired` (offset 17,
  1 byte) = 18 bytes used, 14 bytes free.
- `__gap[39]` unchanged.
- Storage snapshot `Bridge.storage-layout.json` regenerated and
  checked in. `BridgeStorageLayout.test.ts` passes against the
  new pin.

## Bytecode measurements

| Stage                        | Bridge runtime size | Delta vs C-2.1a |
| ---------------------------- | ------------------- | --------------- |
| C-2.1a baseline              | 24,547 bytes        | 0               |
| D-1 with full setter surface | 24,670 bytes        | +123            |
| **D-1 as shipped (this PR)** | **24,547 bytes**    | **0**           |

The Wallets external library grows by approximately 25 bytes for
the single `require` string on the request-side guard; it
remains under 5 KiB.

## Tests

- `test/bridge/Bridge.D1EcdsaRetirement.test.ts` — 5 cases.
  Request-side guard fires when retired, does not fire and
  forwards to the registry when not retired, does not forward
  on revert. Late callback registers the wallet in both retired
  and non-retired states (the retired-state case is the
  explicit no-deadlock regression pin).
- `test/formal/BridgeStorageLayout.test.ts` — snapshot match +
  `__gap` reserved-total check pass against the refreshed pin
  (106 total slots: explicit fields + gap).
- `test/bridge/Bridge.Wallets.test.ts` — 103 cases unchanged,
  all green (regression check that the new guards don't
  perturb existing non-retired flows).
