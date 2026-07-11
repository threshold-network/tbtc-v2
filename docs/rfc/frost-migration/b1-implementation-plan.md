# Phase B-1: FROST WalletRegistry implementation plan

**Status as of:** 2026-05-24
**Companion to:** RFC #437 v4.1 (frozen),
`wallet-lifecycle-migration-plan.md`.
**Implementation branch:** `feat/b1-frost-wallet-registry-2026-05-24`.

## Scope

Port `@keep-network/ecdsa/contracts/WalletRegistry.sol` (and its
helper libraries) into the tbtc-v2 tree at
`contracts/tbtc-v2/contracts/frost-registry/`, applying the four
FROST-specific deltas in RFC v4.1 §"Contract surface (v3)" /
§"FROST-specific deltas".

Source files ported (1:1 with renames):

| Source (`@keep-network/ecdsa/contracts/...`) | Dest (`contracts/tbtc-v2/contracts/frost-registry/...`) | LOC   |
| -------------------------------------------- | ------------------------------------------------------- | ----- |
| `WalletRegistry.sol`                         | `FrostWalletRegistry.sol`                               | 1,303 |
| `EcdsaDkgValidator.sol`                      | `FrostDkgValidator.sol`                                 | 292   |
| `libraries/EcdsaDkg.sol`                     | `libraries/FrostDkg.sol`                                | 569   |
| `libraries/EcdsaAuthorization.sol`           | `libraries/FrostAuthorization.sol`                      | 671   |
| `libraries/Wallets.sol`                      | `libraries/FrostRegistryWallets.sol`                    | 170   |
| `libraries/EcdsaInactivity.sol`              | `libraries/FrostInactivity.sol`                         | 194   |
| _new_                                        | `api/IFrostWalletOwner.sol`                             | 41    |

Total: ~3.2K LOC.

## Sub-phases

B-1's scope is split into a sequence of focused sub-phases that
can each be reviewed independently. Sub-phase B-1.0 (this PR) is
the scaffolding commit; the remaining sub-phases apply the four
deltas + tests + deploy + fixture in order.

### B-1.0: Scaffolding (this PR)

- [x] Copy the six source files into
      `contracts/tbtc-v2/contracts/frost-registry/{,libraries/}`.
- [x] Mechanical renames: `EcdsaDkg` → `FrostDkg`,
      `EcdsaInactivity` → `FrostInactivity`,
      `EcdsaAuthorization` → `FrostAuthorization`,
      `EcdsaDkgValidator` → `FrostDkgValidator`, `Wallets` library →
      `FrostRegistryWallets`, contract `WalletRegistry` →
      `FrostWalletRegistry`.
- [x] Add `api/IFrostWalletOwner.sol` (FROST callback interface —
      `__frostWalletCreatedCallback(bytes32)`; no heartbeat-failed
      callback in this phase).
- [x] Drop `IWalletRegistry` inheritance (Bridge calls FROST's
      `requestNewWallet()` via the local
      `IFrostWalletRegistryRequest` interface declared in
      `contracts/bridge/Wallets.sol`; full IWalletRegistry would
      couple FROST's DKG state enum to the ECDSA namespace's).
- [x] Rewrite `FrostRegistryWallets` library struct from
      `(membersIdsHash, publicKeyX, publicKeyY)` to
      `(membersIdsHash, xOnlyOutputKey)` per RFC delta #1.
- [x] Apply RFC delta #1 to `FrostDkg.Result` struct:
      `bytes groupPubKey` → `bytes32 xOnlyOutputKey`.
- [x] Apply RFC delta #2 (partial) to `FrostDkgValidator`:
      digest is now
      `keccak256(abi.encode("tbtc-frost-dkg-result-v1", chainid, bridge, registry, seed, xOnlyOutputKey, keccak256(members), keccak256(misbehaved)))`. The
      validator's `validate(...)` and `validateSignatures(...)`
      signatures grew to accept `bridge` + `registry` addresses
      so the digest binds correctly across deployments.
- [x] Apply RFC delta #3 to `FrostWalletRegistry.approveDkgResult`:
      Bridge callback is now
      `walletOwner.__frostWalletCreatedCallback(xOnlyOutputKey)`
      instead of the ECDSA triple.

### B-1.1: Wire validator-call plumbing (next PR)

Three call sites in `FrostDkg.sol` (`submitResult` /
`challengeResult` / similar) invoke
`self.dkgValidator.validate(result, seed, startBlock)`. The
3-arg signature is gone — these need to pass `(result, seed, startBlock, bridge, registry)`. Approaches:

- **Option A (chosen):** add `address bridge; address registry;`
  fields to `FrostDkg.Data`; initialize at `dkg.init(...)` time
  from the registry's constructor / initializer. The library's
  internal validate calls then read them from `self`.
- Option B: pass them as args to every `submitResult` /
  `challengeResult` etc. — bigger surface change.

### B-1.2: Rewrite inactivity claim path (next PR)

`FrostWalletRegistry.notifyOperatorInactivity` reads
`wallets.getWalletPublicKeyCoordinates(walletID)` to recover the
ECDSA `(X, Y)` for `Inactivity.verifyClaim`. For FROST, the
wallet identity is the `xOnlyOutputKey`. Two paths to fix:

- Add `getWalletXOnlyOutputKey` view (done in B-1.0) and update
  `Inactivity.verifyClaim` to accept `bytes32` instead of
  `bytes`.
- The `heartbeatFailed` branch calls the now-removed ECDSA
  `__ecdsaWalletHeartbeatFailedCallback`. Per RFC, the FROST
  registry does not participate in heartbeat-failure reporting
  in this phase. Either remove the branch entirely or wire it
  to a separate `IFrostWalletOwner` extension if a heartbeat
  callback is added later.

### B-1.3: Apply RFC delta #4 — `registered[xOnlyOutputKey]` guard

Layer a `mapping(bytes32 => bool) registered` defensive guard on
top of Bridge's own duplicate-registration check (mirrors #435's
pattern for `fraudChallenges`). Set in `approveDkgResult`,
re-checked in `submitDkgResult` to fail fast.

### B-1.4: Deploy script + Bridge fixture wiring

- New deploy script at
  `contracts/tbtc-v2/deploy/48_deploy_frost_wallet_registry.ts`
  (depends on `Bridge`, `SortitionPool`, `RandomBeacon`; tags
  `["FrostWalletRegistry"]`).
- Extend `test/fixtures/bridge.ts` to deploy the registry and
  call `bridgeGovernance.setFrostWalletRegistry(registry.address)`.
  Integration tests can use the existing
  `test/integration/utils/fake-random-beacon.ts` pattern.

### B-1.5: Unit tests (per RFC §"B-1 unit tests")

Mirror the ECDSA registry's test coverage with FROST adaptations.
Split across two slices:

**First slice (landed):** harness-based unit tests that exercise
the new FROST-specific surfaces independently of the full DKG
state machine. Covers:

- ✓ Validator rejects the all-zero x-only key.
- ✓ Validator rejects a legacy-shaped key (high 12 bytes zero) —
  the wedge case from Codex round-2 P1 on PR #441.
- ✓ Validator accepts a well-formed native x-only key.
- ✓ Already-registered key (RFC delta #4) — second
  `validateXOnlyOutputKey` for the same key reverts via the
  storage-mapping collision branch.
- ✓ `resultDigest(...)` is deterministic across calls.
- ✓ Changing each digest field (xOnlyOutputKey / seed / bridge /
  registry / members / misbehavedMembersIndices) yields a
  distinct digest. Closes the wrong-key / wrong-request /
  wrong-Bridge / wrong-registry / wrong-group / reward-ban-edit
  replay vectors enumerated in RFC v4.1 §"DKG result message
  format".
- ✓ Digest format string equals the off-chain-computed RFC v4
  reference (catches silent version drift).

**Final slice (deferred):** integration tests covering the full
state machine via a fake random beacon + operator signing
fixture. This is substantial test infrastructure (the upstream
ECDSA WalletRegistry's equivalent is hundreds of LOC + an
operator-key generation helper). Covers:

- Happy path: request → seed → submit → challenge window →
  approve → Bridge callback fires with the x-only key.
- Sub-threshold signatures → submit reverts.
- Member not in `selectedGroup` → submit reverts.
- Mid-DKG operator-unbond attempt blocked by pool `lock()`.
- DKG timeout / seed timeout → state resets, pool unlocks.
- Successful challenge → submitter slashed, state reverts.
- **C-2-not-yet-shipped state**: registry deployed + wired via
  `setFrostWalletRegistry`, but `registry.requestNewWallet()`
  from an unprivileged caller reverts. Locks down the
  "B-1 unreachable until C-2 flips scheme" invariant.

The final slice is scoped to a follow-up PR so the harness-based
coverage can ship with the registry implementation. The deferred
cases are all about behaviour the registry inherits from the
upstream ECDSA implementation (state machine, beacon callback,
challenge harness) — the FROST-specific differences are already
covered by the harness suite + the digest binding suite.

### B-1.6: Phase B-2 coordination spec

Phase B-2's deliverable documents the keep-core coordinator
side: listen for `NewWalletRequested` +
`DkgResultSubmissionStarted`, read `selectedGroup` from the
registry view, run FROST DKG among those operators, compute the
v4 result digest, collect ECDSA signatures from each
participating operator, then `submitDkgResult` →
`approveDkgResult` after the challenge window. The Phase B-2
PR opens in `keep-core` (separate repo), not this repo.

## Known compile-state at B-1.0 close

The scaffold commit does NOT compile cleanly — three issues
remain, all surfaced + scoped above:

1. `FrostDkg.sol:424`, `:491` — 3-arg `validate(...)` calls need
   to be updated to the new 5-arg signature (B-1.1).
2. `FrostWalletRegistry.sol:908` —
   `wallets.getWalletPublicKeyCoordinates(walletID)` reference;
   `FrostRegistryWallets` no longer exposes this method (B-1.2).
3. `FrostWalletRegistry.sol:927` — heartbeat-failed callback
   path; `IFrostWalletOwner` does not declare the callback
   (B-1.2).

CI will accordingly mark the build red on this draft PR; the
red marker is the "B-1.0 scaffolding only" signal. The
follow-up sub-phases land the green build.

## Bytecode budget concerns

`FrostWalletRegistry` is a standalone contract (not part of
Bridge); EIP-170 applies to it independently. The ECDSA
`WalletRegistry` is currently ~23.6 KiB deployed at runs=200
(matches the upper bound — the original keep-network deploy
also worked around this); the FROST port should land in the
same neighborhood with the deltas applied (the FROST-specific
changes net out: x-only key is shorter than ECDSA's 64-byte
pubkey but the validator's expanded `validate(...)` signature
adds some bytes). B-1.5 records the final deployed size in
the storage layout snapshot test.

## Bridge integration prerequisite (carried from RFC)

B-1's `requestNewWallet()` entry is unreachable from Bridge
until C-2 ships AND governance flips
`currentNewWalletScheme` to FROST. C-2 (#439) landed on
2026-05-24 but governance has NOT yet flipped the scheme. B-1
can deploy as soon as the FROST registry implementation is
complete; production cutover waits for the explicit governance
flip after B-2 is also ready.

## Activation runbook (mandatory ordering)

To enable FROST wallet creation end-to-end without orphaning a
live wallet, governance MUST execute these steps in order. Each
step's pre-condition is enforced on-chain so a skipped step
fails fast.

1. Deploy `FrostWalletRegistry` (deploy script
   `48_deploy_frost_wallet_registry.ts`). Initialize wires
   `walletOwner = Bridge` automatically.
2. `BridgeGovernance.setFrostWalletRegistry(registry)` — wires
   Bridge → registry for wallet creation (one-time setter on
   Bridge).
3. Deploy `BridgeLifecycleRouter` (separate future PR; see
   `bridge-lifecycle-router-followup-plan.md`).
4. `BridgeGovernance.setLifecycleRouter(router)` — wires Bridge
   → router for lifecycle dispatch (one-time setter on Bridge).
5. `FrostWalletRegistry.updateLifecycleOwner(router)` — wires
   registry → router for `closeWallet`/`seize` authorization.
   **THIS STEP IS LOAD-BEARING.** Before it executes, the
   registry's `requestNewWallet` reverts with
   `LifecycleOwnerNotSet` (Codex P2 review on PR #441 added
   this fail-fast guard). The `approveDkgResult` path also
   re-checks the same invariant so any in-flight DKG can't
   register a live wallet without an active lifecycle path.
6. Upgrade the Bridge to the Taproot deposit-commitment implementation before
   the first FROST wallet or P2TR deposit is enabled. The commitment mapping is
   populated only by successful reveals after this upgrade and has no automatic
   backfill. As an activation preflight, replay `TaprootDepositRevealed` events
   and require every still-unspent revealed P2TR outpoint to have the expected
   nonzero `taprootDepositOutputKeyCommitment`. If any outstanding reveal lacks
   a commitment, delay activation until it is swept or refunded, or deploy an
   independently audited backfill mechanism first.
7. Choose and verify the proxy/cross-chain deposit policy before the first
   FROST wallet can become active. Direct L1 Taproot deposits can proceed, but
   every proxy-based route MUST remain disabled unless it explicitly declares
   end-to-end Taproot support. For each enabled destination, verify all of the
   following before allowing the SDK to return a P2TR deposit address:

   - the destination-chain depositor accepts and preserves
     `walletXOnlyPublicKey` and `refundXOnlyPublicKey`;
   - the L1 depositor accepts the Taproot reveal tuple and calls the Bridge's
     Taproot reveal entry point;
   - the relayer preserves both x-only keys across the complete route;
   - the deployed contract artifacts and SDK adapters match those versions and
     both adapters report `supportsTaprootDeposits() == true`; and
   - a staging deposit has completed reveal, sweep, and minting through that
     exact route.

   Existing deployed cross-chain depositors expose legacy reveal tuples. Until
   they and their relayers are upgraded, shipped SDK adapters MUST report the
   capability as false and reject P2TR before constructing a receipt or handing
   out a Bitcoin address. Activating FROST therefore temporarily disables those
   cross-chain deposit routes; it must never silently fall back to P2WSH.

8. No scheme flip is required in the canonical mirror: D-2.2
   slice 3 removed the scheme setter and `Bridge.requestNewWallet`
   dispatches only to the FROST registry. With steps 1-7 complete,
   the call succeeds and DKG starts.

Skipping step 5 strands every newly-created FROST wallet — the
registry refuses close + seize until lifecycle is wired. The
on-chain guards at Bridge's `requestNewWallet` and
`__frostWalletCreatedCallback` block this scenario; both revert until
`Bridge.lifecycleRouter() == FrostWalletRegistry.lifecycleOwner()`.
