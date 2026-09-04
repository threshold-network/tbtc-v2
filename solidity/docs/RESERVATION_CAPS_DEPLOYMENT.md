# Reservation Caps Deployment Instructions for All Actors

## Overview

The milestone-1 reservation subsystem introduces two governance setters with a deploy-ordering dependency and a third ABI/event argument relative to the #1094 specification. This document covers the new coordination requirements.

Changes relative to #1094:

- `updateReservationCaps` now takes a third argument `maxActiveReservations` (uint32, must be > 0). The 4-byte selector changes; existing Defender / Safe / Tenderly / multisend scripts that encode the 2-argument version will revert.
- The `ReservationCapsUpdated` event gained a third field `maxActiveReservations`. Off-chain indexers and dashboards that decode the 2-field version will need a redeploy.
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
> Once any reservation is accepted, `ReservationVault` can **never** be swapped, upgraded, or repointed to a patched version.
>
> The vault re-point gate in `Bridge.updateReservationParameters` requires:
> ```solidity
> self.reservationTotalAmount == 0 && self.pendingReservedDeposits == 0
> ```
> Under Milestone 1 (variant B), this state is reachable **only** via complete wallet termination / stranding / acceptance timeouts, because voluntary early exits (such as redemptions or dissolutions) are deferred to Milestone 2.
>
> Setting a non-zero `reservationVault` in `updateReservationParameters` and accepting the first reservation permanently locks in that vault contract for the entire lifetime of live reservations. Explicit governance and deployer sign-off acknowledging this irreversibility is **required** prior to the activation ceremony.

---

## Occupancy Lifecycle and Capacity Management (maxActiveReservations)

In Milestone 1, `maxActiveReservations` acts as an occupancy launch gate and capacity ceiling:

- **Occupancy lifecycle and release paths in M1:** Once reservation requests are authorized and accepted on-chain, `activeReservationsCount` increments. Voluntary protocol-level exits from an accepted reservation position (such as dissolution, veto, and dedicated reservation redemptions) are deferred to Milestone 2. However, `activeReservationsCount` is decremented on the two variant-B release paths that exist in M1: acceptance timeout (when acceptance proofs expire) and stranding (when a wallet closes or terminates). Thus, while not a strictly monotonic one-way ratchet, capacity releases occur exclusively through non-voluntary timeout/stranding paths rather than depositor-initiated exits.
- **Underlying tBTC funds are not locked:** This occupancy accounting applies only to the position of the dedicated-UTXO reservation. Depositor funds are not locked: upon `settleAcceptance`, the depositor is already credited liquid tBTC via the standard Bridge/vault deposit-crediting (mint) path (this mint/credit flow is completely unrelated to the distinct `redeemReservation` feature, which is disabled in Milestone 1). Only the dedicated-UTXO reservation position itself lacks an early voluntary close mechanism in M1.
- **Wallet-closing gate dependency (incomplete safety story):** The safety story for `maxActiveReservations` assumes that as wallets retire, capacity is safely bounded without stranding. However, the wallet-closing precondition (`walletReservationsCount == 0`) is NOT yet enforced in `Wallets.sol` (`beginWalletClosing` / `moveFunds`) on this branch. Until this gate lands, the occupancy safety story remains incomplete because a wallet with live reservation anchors could begin closing without all reservations first being re-anchored or cleared.
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

### Permissionless Re-Anchor Target Selection (Accepted Risk)

When a source wallet enters `MovingFunds` or `Closing`, calling `requestReservationReanchor` is permissionless and allows the caller to designate any Live wallet as the target wallet:

- **Mechanics:** Target-side capacity (`walletReservationInfo[target].count` and `walletReservationInfo[target].amount`) is reserved immediately at request time, before the source wallet signs or executes the Bitcoin transaction.
- **Risk Profile:** A malicious or griefing caller can temporarily occupy reservation slots on a chosen Live target wallet for up to `reservationActionTimeout` seconds at zero cost beyond gas, preventing other incoming reservations from targeting that wallet during the timeout window.
- **Accepted Risk Rationale:** The risk is cooldown-bounded by `reservationActionTimeout` (after which capacity is released via `notifyReservationReanchorTimeout`). Furthermore, successful execution requires the source wallet's cooperation to sign the re-anchor transaction on Bitcoin.
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
- Indexers and dashboards (The Graph subgraphs, Dune queries, custom event listeners) — update the event ABI to 3 fields for `ReservationCapsUpdated` and 6 fields for `ReservationReanchored` (appended `minerFee` field). Backward-compatible decoders will read the new fields as the next positional argument; forward-compatible decoders ignore unknown fields. Note that off-chain indexers watching the pre-PR `ReservationReanchored` event signature will silently stop matching events until updated.
- Monitoring alerts and circuit breakers keyed on `ReservationCapsUpdated` or `ReservationReanchored` — confirm the alerts still fire on the new signatures.

`IReservationBridge` in this PR includes the updated 3-argument `updateReservationCaps` declaration; consumers that bind through it are forward-compatible automatically.

---

## Tracked Follow-up: Quantify External-Router Alternative Bytecode Delta

The PR design rationale rejects a "genuinely external router with its own storage/authority interface" alternative (where the Bridge delegates or calls out to an external contract with its own authority) based on a qualitative argument: "more new Bridge bytecode than the refactor removes" (due to needing a wide set of privileged Bridge mutator callbacks).

Unlike the other two rejected alternatives (the naive port at 26,529B and the optimizer-only override), this alternative was not empirically measured with hard bytecode numbers in the PR body. With the Bridge currently at ~22,870B / 24,576B (leaving limited bytecode margin), the router-fallback design commits most remaining budget based on this qualitative claim.

**Tracked milestone-2 debt (non-blocking for milestone 1):**
Before milestone 2 ships, a short technical spike should be conducted to empirically quantify the bytecode delta of the callback-authority/external-router alternative. This will apply the same empirical rigor used for the other two architectural comparisons and validate whether the delegatecall-router pattern remains the optimal long-term seam as more reservation lifecycle features (dissolution, veto, dedicated redemptions) are added in milestone 2.

## Storage Layout and Tracked Follow-ups

- **BridgeState Storage Slot 34 Packing:** In `BridgeState.sol`, storage slot 34 currently packs three fields (`maxActiveReservations`, `activeReservationsCount`, and `strandingCooldownSeconds` / adjacent fields), leaving 16 spare bytes unused out of the 32-byte slot. This layout is append-only and verified safe, but leaves a minor packing inefficiency against the rationed `__gap` budget. To avoid modifying an already-verified upgradeable storage layout in this PR, a field reordering to fill the 16 spare bytes is tracked for a follow-up PR prior to the next `__gap` reduction.

---

## Verification

After applying the upgrade on a live network:

```solidity
// Spot-check the Decision 1 invariant via three views on the bridge.
// reservationParameters() returns a 10-value tuple; the 6th value is reservationMaxTotalAmount.
(, , , , , uint64 reservationMaxTotalAmount, , , , ) =
    IReservationBridge(bridgeAddress).reservationParameters();
(, uint64 reservationMaxSingleAmount) =
    IReservationBridge(bridgeAddress).reservationCaps();
(, uint32 maxActiveReservations) =
    IReservationBridge(bridgeAddress).activeReservationsCount();
```

The three views together supply the three quantities the Decision 1 invariant is written in terms of:
`reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` (or `reservationMaxSingleAmount == 0`).

Because setter transactions revert on an invariant violation, a rejected configuration modifies no storage. If governance encounters a revert with `Amount cap exceeds slot capacity` during configuration, the remedy is:

1. Re-issue `updateReservationParameters` with a smaller `reservationMaxTotalAmount` that satisfies `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount`; or
2. Re-issue `updateReservationCaps` with the caps in the correct order (or with higher `maxActiveReservations` / `reservationMaxSingleAmount` values that accommodate the desired total amount).
