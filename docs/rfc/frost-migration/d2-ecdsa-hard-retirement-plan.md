# D-2: ECDSA hard retirement (slice 1 — callback removal + canonical setter)

## Status

Merged as PR #445. Branched from `feat/d1-ecdsa-soft-retirement-2026-05-24`.
Removes the `__ecdsaWalletCreatedCallback` external function from
Bridge (structural removal of the ECDSA wallet creation pathway)
and uses the reclaimed bytecode budget to land the canonical
`retireEcdsa()` governance setter + supporting surface that was
deferred from D-1.

> **NOTE (post-D-2.2 reconciliation, 2026-05-25):** Several
> claims in the body below are stale relative to the as-shipped
> contract after PR #447 (D-2.2 slice 1) merged:
>
> - The "Bridge.retireEcdsa()" bullet in §"Additions" says the
>   setter "emits EcdsaRetired" and re-calls "re-emit the event".
>   D-2.2 dropped the `emit EcdsaRetired()` to fit the new public
>   getter under EIP-170. The setter no longer emits.
> - The "event EcdsaRetired()" bullet in §"Additions" describes
>   the event being "mirrored on Bridge for ABI visibility". The
>   mirror declaration on Bridge IS preserved (`Bridge.sol` still
>   declares `event EcdsaRetired();` for ABI back-compat); D-2.2
>   only dropped the `emit EcdsaRetired()` in `retireEcdsa()`.
>   The event therefore stays in the Bridge ABI but never fires.
>   Off-chain consumers polling the new public `ecdsaRetired()`
>   getter are the canonical observation path.
> - The "Public Bridge.ecdsaRetired() getter [deferred]" bullet
>   in §"What this PR did NOT ship" is doubly stale: D-2.2 slice
>   1 SHIPPED the getter, AND the alternative observation path
>   it references ("the EcdsaRetired event") was dropped in the
>   same PR.
> - The activation runbook §"Sequence" step 6 references both
>   the emit AND "no public getter — see §..."; both stale.
> - Any body text that tells consumers to decode storage slot 38 byte
>   17 is stale. The canonical storage-layout snapshot places
>   `ecdsaRetired` at slot 37 byte 17.
>
> The body sections are preserved verbatim as historical design
> record for PR #445. The live operator-facing reference for
> post-D-2.2 behavior is
> [`d2-2-followups-plan.md`](./d2-2-followups-plan.md) (slice 1
> details + bytecode trajectory + the four follow-up slices)
> plus the v7 reconciliation block in
> [`scheme-preference-and-retirement-rfc.md`](./scheme-preference-and-retirement-rfc.md).

## What this PR ships

### Removals

1. `Bridge.__ecdsaWalletCreatedCallback` — gone entirely. No new
   ECDSA wallets can be created after D-2 ships; any registry
   attempt to invoke this selector reverts at the EVM dispatcher
   with no data (function not in ABI).
2. `IWalletOwner` inheritance on the Bridge contract. The
   heartbeat callback (`__ecdsaWalletHeartbeatFailedCallback`)
   is preserved as a standalone external function (existing
   ECDSA wallets still need to report heartbeat failures); the
   `override` keyword is dropped since there is no interface
   to satisfy.

### Additions

3. `Bridge.retireEcdsa() external onlyGovernance` — canonical
   D-2 setter. Writes `self.ecdsaRetired = true` and emits
   `EcdsaRetired`. Idempotent (re-calls are warm SSTORE no-ops
   that re-emit the event).
4. `event EcdsaRetired()` — declared on BridgeState (library)
   and mirrored on Bridge for ABI visibility.
5. `BridgeGovernance.retireEcdsa() external onlyOwner` —
   governance forwarder. No timelock delay (idempotent one-way
   flip).
6. `BridgeStub.__ecdsaWalletCreatedCallbackForTest` — test-only
   helper that replaces the removed callback for test fixtures
   that need to create ECDSA wallets for downstream-flow
   testing (redemptions, deposits, fraud, etc.).

## What this PR did NOT ship

- Public `Bridge.ecdsaRetired()` getter. Adding it pushed the
  Bridge implementation back over EIP-170. Off-chain consumers
  observe the transition via the `EcdsaRetired` event;
  on-chain consumers and indexers can decode storage slot 38
  byte 17 directly.
- `Bridge.slashWalletForFraud` ECDSA-only callback. Still
  needed by the EcdsaFraudRouter sidecar for existing ECDSA
  wallets' fraud lifecycle; deferred to a follow-up that also
  removes the legacy ECDSA wallet registry handle from
  BridgeState storage when no live ECDSA wallets remain.
- Removal of the `currentNewWalletScheme` enum and dispatch in
  `Wallets.requestNewWallet`. Once no ECDSA wallets exist
  (post-drain) the Ecdsa branch becomes dead code; cleanup
  would simplify the library but is not load-bearing for the
  D-2 hardening.

**See also:** the follow-up slices listed above are tracked
end-to-end in
[`d2-2-followups-plan.md`](./d2-2-followups-plan.md), which
documents D-2.2 slice 1 (public `ecdsaRetired()` getter,
shipped via PR #447) and the deferral status + operational
prerequisites for slices 2 (`slashWalletForFraud` removal),
3 (scheme-enum cleanup), and 4 (registry handle + heartbeat
removal). The follow-ups plan also captures the bytecode
trajectory across all four slices and an open question on
re-introducing the `EcdsaRetired` event once D-2.2 slice 4
reclaims sufficient bytecode budget.

## Bytecode measurements

| Stage                         | Bridge runtime size | Delta vs C-2.1a |
| ----------------------------- | ------------------- | --------------- |
| C-2.1a baseline               | 24,547 bytes        | 0               |
| D-1 (request-side guard only) | 24,547 bytes        | 0               |
| D-2 callback removal only     | 24,440 bytes        | -107            |
| **D-2 as shipped (this PR)**  | **24,562 bytes**    | **+15**         |

The D-2 setter + getter + event mirror originally measured
~152 bytes; dropping the public getter brought the net delta
to +15 bytes — under the 24,576-byte EIP-170 limit by 14
bytes.

## Activation runbook

The deadlock vector (dispatch → DKG → late callback into
removed selector → stuck registry → blocked FROST wallets)
is structurally closed by D-2 at two layers:

### Layer 1 — code (load-bearing)

`Wallets.requestNewWallet` unconditionally reverts the
`scheme == Ecdsa` branch in D-2 with
`"ECDSA wallet creation retired"`. The revert does not
depend on the `ecdsaRetired` flag or on the scheme
selector; any future or accidental
`setNewWalletScheme(Ecdsa)` is harmless because no dispatch
to the ECDSA registry can be reached. (Codex P1 re-raise
on this PR — the previous version of D-2 left the dispatch
gated on a governance-set flag whose setter was unreachable
on the deployed non-proxy BridgeGovernance, leaving the
vector exploitable until a separate BridgeGovernance
redeploy.)

### Layer 2 — operations (defense in depth)

The governance ceremony for the D-2 upgrade should still
call `BridgeGovernance.setNewWalletScheme(Frost)` BEFORE
the proxy upgrade to close the pre-upgrade window: between
the governance decision to retire and the actual proxy
upgrade transaction, the old Bridge implementation is still
deployed and could honor an in-flight ECDSA wallet request
to completion. Flipping scheme = Frost first ensures no new
requests land on the ECDSA registry during that window.
`setNewWalletScheme(Frost)` is callable on the existing
deployed BridgeGovernance (the function shipped in C-2);
no BridgeGovernance redeploy is required.

The `retireEcdsa()` flag flip is an **optional** audit-trail
step that publicly marks "governance has formally retired
ECDSA wallet creation". Since `BridgeGovernance.retireEcdsa()`
ships only as new source in this PR (the deployed non-proxy
BridgeGovernance does not have it), exercising this step on
mainnet requires either redeploying BridgeGovernance and
transferring Bridge governance to the new instance, or
calling `Bridge.retireEcdsa()` directly via a temporary
governance transfer to a multisig/EOA. Neither is required
for the safety property — Layer 1 (code-level hard block)
already closes the deadlock vector unconditionally.

Sequence:

1. Pause the Bridge via the existing `BridgeGovernance`.
2. Wait for `ecdsaWalletRegistry.getWalletCreationState()` to
   return `IDLE`. If a DKG is mid-flight, either let it
   complete (the callback fires under the still-deployed
   pre-D-2 contract, the registry transitions to IDLE, one
   final ECDSA wallet is registered) or use the registry's
   own challenge/timeout path to abandon it.
3. **MANDATORY:** Call
   `BridgeGovernance.setNewWalletScheme(WalletScheme.Frost)`
   via the existing BridgeGovernance. From this point on, any
   `requestNewWallet` call routes to the FROST registry.
4. Deploy the D-2 Bridge upgrade. Post-upgrade, the registry's
   `__ecdsaWalletCreatedCallback` invocation reverts at the
   EVM dispatcher (selector not in the new ABI). Combined
   with step 3, no ECDSA dispatch path remains reachable.
5. Unpause Bridge.
6. **OPTIONAL** (audit trail): if BridgeGovernance was also
   redeployed with the new `retireEcdsa()` forwarder, transfer
   Bridge governance to the new instance and call
   `BridgeGovernance.retireEcdsa()` to flip the `ecdsaRetired`
   flag and emit `EcdsaRetired`. The flag is observable on-
   chain via storage slot 38 byte 17 (no public getter — see
   §"What this PR did NOT ship"), and the event provides a
   single canonical "ECDSA retired" marker for off-chain
   indexers. Step is purely informational; skipping it does
   not weaken the structural hard retirement that steps 3+4
   establish.

## Upgrade-safety check

- No storage layout changes vs D-1. `ecdsaRetired` continues
  to pack at slot 38 offset 17.
- `Bridge.storage-layout.json` snapshot unchanged (D-2 added
  no new storage fields).
- `__gap[39]` unchanged.

## Tests

- `test/bridge/Bridge.D1EcdsaRetirement.test.ts` — renamed to
  cover both D-1 guard and D-2 setter; 8 cases all green
  (3 D-1 request-side, 5 D-2 setter / governance / idempotency).
- `test/bridge/Bridge.Wallets.test.ts` — 100 cases green
  (existing tests using the removed `__ecdsaWalletCreatedCallback`
  now route through `__ecdsaWalletCreatedCallbackForTest`).
- `test/bridge/Bridge.FrostWalletRegistration.test.ts` — the
  ECDSA-ID-non-zero guard test now exercises the stub helper
  (the production guard moved from `__ecdsaWalletCreatedCallback`
  to the test-only helper alongside the rest of the library
  body). 4 pre-existing unrelated `LifecycleRouterNotSet`
  failures persist (not D-2 regressions; reproduce on D-1
  baseline).
- `test/bridge/Bridge.Frauds.test.ts` — 84/86 pass; 2 pre-
  existing failures unrelated to D-2 (also on D-1 baseline).
- `test/maintainer/MaintainerProxy.test.ts` — single callsite
  updated; not re-run in this measurement pass but the change
  is mechanical find/replace.
- `test/formal/BridgeStorageLayout.test.ts` — snapshot match
  - `__gap` reserved-total (106) pass.
