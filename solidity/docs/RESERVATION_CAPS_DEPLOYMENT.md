# Reservation Caps Deployment Instructions for All Actors

## Overview

The milestone-1 reservation subsystem introduces two governance setters with a deploy-ordering dependency and a third ABI/event argument relative to the #1094 specification. This document covers the new coordination requirements.

Changes relative to #1094:

- `updateReservationCaps` now takes a third argument `maxActiveReservations` (uint32, must be > 0). The 4-byte selector changes; existing Defender / Safe / Tenderly / multisend scripts that encode the 2-argument version will revert.
- The `ReservationCapsUpdated` event gained a third field `maxActiveReservations`. Off-chain indexers and dashboards that decode the 2-field version will need to update their event ABI; consumers that only read a subset of fields and ignore unknown trailing fields may only need a rebind/restart.
- `updateReservationParameters` enforces the Decision 1 on-chain relational check `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` by reading both `self.maxActiveReservations` and `self.reservationMaxSingleAmount` from storage. In the pristine pre-launch bootstrap state, both are zero, so the check short-circuits and any `reservationMaxTotalAmount` is accepted. Subsequent calls can revert with `Amount cap exceeds slot capacity` if governance sets `reservationMaxTotalAmount` first and the later `updateReservationCaps` operands cannot accommodate it.

---

## Deploy Order (Decision 1)

During the initial bootstrap of the reservation subsystem, calling `updateReservationCaps` **before** `updateReservationParameters` is recommended as the safe runbook default.

While calling `updateReservationParameters` first is accepted during initial bootstrap because `self.reservationMaxSingleAmount` and `self.maxActiveReservations` are still zero (the slot-capacity check `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` short-circuits when either operand is zero), calling in the reverse order introduces a potential hazard: if the subsequent `updateReservationCaps` call sets caps whose product `maxActiveReservations * reservationMaxSingleAmount` cannot accommodate the already-committed `reservationMaxTotalAmount`, that subsequent `updateReservationCaps` call will revert with `Amount cap exceeds slot capacity`. (Any call order succeeds if `reservationMaxSingleAmount` is set to zero, since a zero single-amount cap disables the relational check).

Safe operational sequence:

1. Call `updateReservationCaps(maxReservationsAmountPerWallet, reservationMaxSingleAmount, maxActiveReservations)` — sets the per-wallet amount cap, the single-reservation amount cap, and the global occupancy cap together. The Decision 1 check evaluates `0 <= maxActiveReservations * reservationMaxSingleAmount` (trivially true because `reservationMaxTotalAmount` is still 0).
2. Call `updateReservationParameters(reservationVault, ...)` — sets `reservationMaxTotalAmount` and the other parameters. The Decision 1 check now evaluates `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` against the just-set storage values.

If the two updates must land in the same block, an atomic multicall preserves the ordering guarantee.

The existing regression test `Bridge.ReservationCaps.test.ts` in the `describe("bootstrap ordering")` group pins both the deploy-ordering hazard and the safe operational order; review it before any deployment.

---

## Irreversible Vault Activation Warning

> ⚠️ **IRREVERSIBLE CONFIGURATION WARNING: MANDATORY GOVERNANCE SIGN-OFF**
>
> Once any reservation is accepted, `ReservationVault` can only be swapped, upgraded, or repointed if the bridge reaches `reservationTotalAmount == 0 && pendingReservedDeposits == 0` — under Milestone 1 (variant B), this state is reachable **only** via complete wallet termination / stranding / acceptance timeouts, because voluntary early exits (such as redemptions or dissolutions) are deferred to Milestone 2.
>
> The vault re-point gate in `Bridge.updateReservationParameters` requires:
>
> ```solidity
> self.reservationTotalAmount == 0 && self.pendingReservedDeposits == 0
> ```
>
> Setting a non-zero `reservationVault` in `updateReservationParameters` and accepting the first reservation permanently locks in that vault contract for the entire lifetime of live reservations. Explicit governance and deployer sign-off acknowledging this irreversibility is **required** prior to the activation ceremony.

---

## Occupancy Lifecycle and Capacity Management (maxActiveReservations)

In Milestone 1, `maxActiveReservations` acts as an occupancy launch gate and capacity ceiling:

- **Occupancy lifecycle and release paths in M1:** Once reservation requests are authorized and accepted on-chain, `activeReservationsCount` increments. Voluntary protocol-level exits from an accepted reservation position (such as dissolution, veto, and dedicated reservation redemptions) are deferred to Milestone 2. However, `activeReservationsCount` is decremented on the two variant-B release paths that exist in M1: acceptance timeout (when acceptance proofs expire) and stranding (when a wallet closes or terminates). Thus, while not a strictly monotonic one-way ratchet, capacity releases occur exclusively through non-voluntary timeout/stranding paths rather than depositor-initiated exits. Occupancy is not derivable from a single field or event: the `ReservationOccupancyChanged` event alone reports only the raw `activeReservationsCount` counter, not effective occupancy. Deriving effective occupancy from current on-chain views requires combining `IReservationBridge.activeReservationsCount()` with `reservationParameters()` (for `maxReservationsPerWallet`) and the live-wallet count. This yields two distinct quantities that should not be conflated: aggregate wallet-slot utilization (`activeReservationsCount` against `liveWalletsCount * maxReservationsPerWallet`) and governance-cap utilization (`activeReservationsCount` against the global `maxActiveReservations` ceiling).
- **Underlying tBTC funds are not locked:** This occupancy accounting applies only to the position of the dedicated-UTXO reservation. Depositor funds are not locked: upon `settleAcceptance`, the depositor is already credited liquid tBTC via the standard Bridge/vault deposit-crediting (mint) path (this mint/credit flow is completely unrelated to the distinct `redeemReservation` feature, which is disabled in Milestone 1). Only the dedicated-UTXO reservation position itself lacks an early voluntary close mechanism in M1.
- **Wallet-closing gate dependency:** The safety story for `maxActiveReservations` relies on wallets not being able to retire while they still hold live reservation anchors. The `walletReservationInfo[wallet].count == 0` precondition is enforced at the two points that can still block _before_ any Bitcoin funds have moved: `moveFunds`'s routing decision (a wallet with a nonzero reservation count is always routed through `MovingFunds`, never straight to `Closing`) and `notifyWalletClosingPeriodElapsed`. It is deliberately _absent_ from `beginWalletClosing` and `finalizeWalletClosing`: both are reached only after a moving-funds Bitcoin transaction has already been proven on-chain via SPV proof, and blocking wallet retirement at that point (with funds already gone) would leave the wallet stuck mid-closing while its `movingFundsTimeout` clock keeps running, eventually triggering operator slashing for a state the protocol itself created. A wallet can therefore complete closing while still holding a live reservation anchor if reservations were requested against it after the `moveFunds` decision was made; the anchor itself is separately recovered via `notifyReservationStranded` once the wallet reaches `Terminated`/`Closed`/dissolution-eligible-`Closing`.
- **Procedure for raising capacity:** When active occupancy saturates or additional headroom is required, governance can raise the occupancy limit by calling `updateReservationCaps(maxReservationsAmountPerWallet, reservationMaxSingleAmount, newMaxActiveReservations)` with a higher `newMaxActiveReservations` value.
- **Sizing constraint:** Any update to `maxActiveReservations` or `reservationMaxSingleAmount` must maintain the Decision 1 relational invariant:
  `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount`
  (unless `reservationMaxSingleAmount == 0`, which disables the amount cap). If lowering caps or raising `reservationMaxTotalAmount`, governance must ensure the new slot capacity accommodates `reservationMaxTotalAmount`.
- **Operational timeline considerations:** Whether the Milestone 1 launch is expected to reach reservation term expiry before Milestone 2 ships is an open operational question that the deploying team and governance should confirm prior to setting initial term lengths and occupancy limits.

### Monitoring and Alerting (Occupancy & Risk Signals)

To ensure proactive capacity management and safe operational oversight:

- **Occupancy Signal & Calculation:** Effective system occupancy is defined as:
  $$\text{Occupancy} = \frac{\text{activeReservationsCount}}{\text{liveWalletsCount} \times \text{maxReservationsPerWallet}}$$
  Relative to the governance cap, occupancy is evaluated against `maxActiveReservations` (the slot capacity floor).
- **Event-Driven Telemetry:** The `ReservationOccupancyChanged(uint32 activeReservationsCount)` event enables off-chain indexers, subgraphs, and dashboards to track occupancy from logs alone without relying on continuous chain polling of `activeReservationsCount()`.
- **Recommended Alert Thresholds:**
  - **Warning Alert (70% of capacity):** Triggered when `activeReservationsCount` reaches 70% of `maxActiveReservations` (or 70% of the live-wallet slot floor). Governance and operators should review current demand and prepare a cap increase transaction if needed.
  - **Critical / Page Alert (90% of capacity):** Triggered when `activeReservationsCount` reaches 90% of capacity. Immediate operator attention is required; new reservation acceptances will revert if the cap is reached before governance raises `maxActiveReservations`.
- **Occupancy-Count Divergence During Pending Re-Anchors:** During any pending re-anchor (between `requestReservationReanchor` and its completion via proof or timeout), `activeReservationsCount` (global) and each wallet's per-wallet reservation count in `ReservationRouter.sol` can disagree, since re-anchor only moves the target wallet's per-wallet count and never touches the global count. At the launch value `maxReservationsPerWallet=1`, this means the occupancy-alert formula above (built on `activeReservationsCount`) can under-report true per-wallet slot pressure that a keep-core free-slot monitor tracking per-wallet counts would otherwise see; operators should not rely on `activeReservationsCount` alone to infer per-wallet slot availability during active re-anchor windows.

### Permissionless Re-Anchor Target Selection (Accepted Risk)

When a source wallet enters `MovingFunds` or `Closing`, calling `requestReservationReanchor` is permissionless and allows the caller to designate any Live wallet as the target wallet:

- **Mechanics:** Target-side capacity (`walletReservationInfo[target].count` and `walletReservationInfo[target].amount`) is reserved immediately at request time, before the source wallet signs or executes the Bitcoin transaction.
- **Risk Profile:** A malicious or griefing caller can temporarily occupy reservation slots on a chosen Live target wallet for up to `reservationActionTimeout` seconds at zero cost beyond gas, preventing other incoming reservations from targeting that wallet during the timeout window.
- **Accepted Risk Rationale:** Capacity occupation via `requestReservationReanchor` requires no signature at all — it is a permissionless bookkeeping call; only _completion_ (the actual Bitcoin re-anchor transaction) requires the source wallet's cooperation to sign. The risk is bounded only by `reservationActionTimeout` (after which unclaimed capacity is released via `notifyReservationActionTimeout`), not by any signature requirement on occupation itself. Because occupation is signature-free, a permissionless caller can pipeline multiple `requestReservationReanchor` calls for different reservations from different already-`MovingFunds`/`Closing` source wallets against the same Live target wallet within a single block, occupying that target wallet's capacity for a full `reservationActionTimeout` at gas-only cost. This aggregate burst risk is accepted per the review and does not require a code fix in this PR.
- **Monitoring Note:** Off-chain monitors should track repeated re-anchor requests against specific target wallets that are not followed by re-anchor proof submissions, alerting operators to potential griefing patterns.

---

## ABI Coordination

`updateReservationCaps` signature change:

```solidity
// #1094
function updateReservationCaps(
  uint64 maxReservationsAmountPerWallet,
  uint64 reservationMaxSingleAmount
) external;

// Milestone 1 (this PR)
function updateReservationCaps(
  uint64 maxReservationsAmountPerWallet,
  uint64 reservationMaxSingleAmount,
  uint32 maxActiveReservations
) external;

```

`ReservationCapsUpdated` event signature change:

```solidity
// #1094
event ReservationCapsUpdated(
    uint64 maxReservationsAmountPerWallet,
    uint64 reservationMaxSingleAmount
);

// Milestone 1 (this PR)
event ReservationCapsUpdated(
    uint64 maxReservationsAmountPerWallet,
    uint64 reservationMaxSingleAmount,
    uint32 maxActiveReservations
);
```

`ReservationReanchored` event signature change (ReservationRouter):

```solidity
// #1094
event ReservationReanchored(
    uint256 indexed reservationKey,
    uint64 requestNonce,
    bytes20 indexed newWalletPubKeyHash,
    bytes32 newAnchorTxHash,
    uint64 newAnchorAmount
);

// Milestone 1 (this PR)
event ReservationReanchored(
    uint256 indexed reservationKey,
    uint64 requestNonce,
    bytes20 indexed newWalletPubKeyHash,
    bytes32 newAnchorTxHash,
    uint64 newAnchorAmount,
    uint64 minerFee
);

```

Off-chain tooling updates required:

- Governance proposal builders (Defender, Safe Transaction Builder, Tenderly, custom multisend helpers) — regenerate the encoded calldata with the 3-argument signature for `updateReservationCaps`.
- Indexers and dashboards (The Graph subgraphs, Dune queries, custom event listeners) — update the event ABI to 3 fields for `ReservationCapsUpdated` and 6 fields for `ReservationReanchored` (appended `minerFee` field). Backward-compatible decoders will read the new fields as the next positional argument; forward-compatible decoders ignore unknown fields. Adding the `maxActiveReservations` field to `ReservationCapsUpdated` changes its event signature hash (topic0), so off-chain indexers watching the pre-PR `ReservationCapsUpdated` event signature will silently stop matching entirely until updated. Note that off-chain indexers watching the pre-PR `ReservationReanchored` event signature will likewise silently stop matching events until updated.
- Monitoring alerts and circuit breakers keyed on `ReservationCapsUpdated` or `ReservationReanchored` — confirm the alerts still fire on the new signatures.

**Note:** The `updateReservationCaps` selector change (3-arg vs 2-arg) means consumers MUST rebind/recompile against the new `IReservationBridge` interface. The interface in this PR declares the updated signature, but consumers that bind through it still need a recompile/rebind — the selector change (topic0 for events, 4-byte selector for functions) is not automatically absorbed by the interface binding alone.

### m1 router ABI delta vs. inventory/router.md

The `ReservationRouter` entry points that keep-core binds against have diverged from the frozen inventory keep-core#4274 was coded from. This is an intentional, already-decided divergence: keep-core will be updated via a separate follow-up (already filed). **Do not revert these selectors.**

**Reshaped entry points (keep-core#4274 needs an update before mainnet activation):**

- `submitReservationProof(...)` no longer exists at the Bridge address. It has been split into two typed entry points:
  - `submitReservationAcceptanceProof(...)` — handles acceptance proofs.
  - `submitReservationReanchorProof(...)` — handles re-anchor proofs.
- `notifyReservationActionTimeout(...)` lost its `walletMembersIDs` argument. Old signature: `notifyReservationActionTimeout(uint256 reservationKey, uint32[] walletMembersIDs)`; new signature: `notifyReservationActionTimeout(uint256 reservationKey)`.

keep-core#4274 must be updated to call the new selectors above before mainnet activation.

**Additive entry points (non-breaking, but undocumented in any spec/inventory):**

- `forceStaleReservedDeposit(...)` — new, `onlyGovernance`-gated, in `ReservationRouter.sol`. Additive; does not break any existing binding.
- `notifyReservationAcceptanceTimedOut(...)` — keep-core-facing entry point not present in prior spec/inventory documents. Additive; does not break any existing binding.

**Reshaped return type (keep-core#4274 needs an update before mainnet activation):**

- `reservationActions()`'s returned `ReservationAction` tuple has diverged from keep-core#4274's frozen 17-field Go binding. Current tbtc-v2 `Reservation.ReservationAction` has 20 fields: `actionDataHash`/`sourceAnchorUtxoHash` (bytes32) are inserted immediately after `redeemer` — ahead of `amount`, not after — and `termSeconds`, `dissolutionDelay`, `minAmount` are appended. From field 9 onward, every position's type diverges from keep-core's expectation. This is not cosmetic: keep-core#4274's maintainer loop calls `GetReservationAction(reservationKey, requestNonce)` (ABI-decoding this exact tuple) before every proof submission, on both the acceptance and reanchor paths — a tuple-arity mismatch at decode time fails that call outright. keep-core#4274 must regenerate its bindings against the final, stabilized shape of this struct (not an intermediate snapshot — the shape has moved multiple times during this epic's development) before mainnet activation.

---

## Tracked Follow-up: Quantify External-Router Alternative Bytecode Delta

The PR design rationale rejects a "genuinely external router with its own storage/authority interface" alternative (where the Bridge delegates or calls out to an external contract with its own authority) based on a qualitative argument: "more new Bridge bytecode than the refactor removes" (due to needing a wide set of privileged Bridge mutator callbacks).

Unlike the other two rejected alternatives (the naive port at 26,529B and the optimizer-only override), this alternative was not empirically measured with hard bytecode numbers in the PR body. With the Bridge currently at ~22,870B / 24,576B (leaving limited bytecode margin), the router-fallback design commits most remaining budget based on this qualitative claim.

**Tracked milestone-2 debt (non-blocking for milestone 1):**
Before milestone 2 ships, a short technical spike should be conducted to empirically quantify the bytecode delta of the callback-authority/external-router alternative. This will apply the same empirical rigor used for the other two architectural comparisons and validate whether the delegatecall-router pattern remains the optimal long-term seam as more reservation lifecycle features (dissolution, veto, dedicated redemptions) are added in milestone 2.

## Storage Layout and Tracked Follow-ups

- **BridgeState Storage Slot 33 Packing:** In `BridgeState.sol`, storage slot 33 packs five fields — `maxReservationsAmountPerWallet` (uint64, 8 bytes), `reservationMaxSingleAmount` (uint64, 8 bytes), `pendingReservedDeposits` (uint64, 8 bytes), `activeReservationsCount` (uint32, 4 bytes), and `maxActiveReservations` (uint32, 4 bytes) — for exactly 32 bytes with zero spare bytes, per the current storage-layout snapshot (`solidity/test/fixtures/BridgeState.storageLayout.snapshot.json`). `reservationDissolutionTxMaxFee` has since been removed from `BridgeState.sol` entirely, and the storage layout was regenerated accordingly; the previously tracked field-reordering follow-up is now moot, since this slot is already fully packed.

---

## Verification

After applying the upgrade on a live network:

```solidity
// Spot-check the Decision 1 invariant via three views on the bridge.
// reservationParameters() returns a 10-value tuple; the 1st value is reservationVault, the 6th is reservationMaxTotalAmount.
(address reservationVault, , , , , uint64 reservationMaxTotalAmount, , , , ) =
    IReservationBridge(bridgeAddress).reservationParameters();
(, uint64 reservationMaxSingleAmount, ) =
    IReservationBridge(bridgeAddress).reservationCaps();
(, uint32 maxActiveReservations) =
    IReservationBridge(bridgeAddress).activeReservationsCount();

// Pre-activation sanity checks (run before/alongside setting a non-zero reservationVault):
address router = IReservationBridge(bridgeAddress).reservationRouter();
require(router != address(0) && router == expectedRouterAddress, "Router mismatch");
require(reservationVault != address(0), "Vault not set");
require(Ownable(reservationVault).owner() == expectedVaultOwner, "Vault ownership mismatch");
require(Bridge(bridgeAddress).isVaultTrusted(reservationVault), "Vault not trusted");
```

The three views together supply the three quantities the Decision 1 invariant is written in terms of:
`reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` (or `reservationMaxSingleAmount == 0`).

> **Precondition note:** Setting a new non-zero `reservationVault` in `updateReservationParameters` also requires `maxActiveReservations > 0`; the call reverts otherwise, so the Decision 1 invariant check above is not sufficient on its own when activating the vault for the first time.

Because setter transactions revert on an invariant violation, a rejected configuration modifies no storage. If governance encounters a revert with `Amount cap exceeds slot capacity` during configuration, the remedy is:

1. Re-issue `updateReservationParameters` with a smaller `reservationMaxTotalAmount` that satisfies `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount`; or
2. Re-issue `updateReservationCaps` with the caps in the correct order (or with higher `maxActiveReservations` / `reservationMaxSingleAmount` values that accommodate the desired total amount).
