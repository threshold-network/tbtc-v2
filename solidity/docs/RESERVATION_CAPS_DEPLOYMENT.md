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

While calling `updateReservationParameters` first is accepted during initial bootstrap because `self.reservationMaxSingleAmount` and `self.maxActiveReservations` are still zero (the slot-capacity check `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` short-circuits when either operand is zero), calling in the reverse order introduces a potential hazard: if the subsequent `updateReservationCaps` call sets caps whose product `maxActiveReservations * reservationMaxSingleAmount` cannot accommodate the already-committed `reservationMaxTotalAmount`, that subsequent `updateReservationCaps` call will revert with `Amount cap exceeds slot capacity`. (Any call order succeeds if `reservationMaxSingleAmount` is set to zero, since a zero single-amount cap disables the slot-capacity ceiling check entirely, or if the parameters happen to satisfy the invariant regardless of order.)

Safe operational sequence:

1. Call `updateReservationCaps(maxReservationsAmountPerWallet, reservationMaxSingleAmount, maxActiveReservations)` — sets the per-wallet amount cap, the single-reservation amount cap, and the global occupancy cap together. The Decision 1 check evaluates `0 <= maxActiveReservations * reservationMaxSingleAmount` (trivially true because `reservationMaxTotalAmount` is still 0).
2. Call `updateReservationParameters(reservationVault, ...)` — sets `reservationMaxTotalAmount` and the other parameters. The Decision 1 check now evaluates `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` against the just-set storage values.

If the two updates must land in the same block, an atomic multicall preserves the ordering guarantee.

The existing regression test `Bridge.ReservationCaps.test.ts` in the `describe("bootstrap ordering")` group pins both the deploy-ordering hazard and the safe operational order; review it before any deployment.

---

## Occupancy Lifecycle and Capacity Management (maxActiveReservations)

In Milestone 1, `maxActiveReservations` acts as an occupancy launch gate and a one-way ratchet:

- **One-way occupancy ratchet in M1:** Once reservation requests are authorized and accepted on-chain, the active reservation count increments. There is no documented release procedure in Milestone 1 once occupancy saturates, because voluntary protocol-level exits from an accepted reservation position (such as dissolution, veto, and dedicated reservation redemptions) are deferred to Milestone 2.
- **Underlying tBTC funds are not locked:** This occupancy ratchet applies only to the accounting position of the dedicated-UTXO reservation. Depositor funds are not locked: upon `settleAcceptance`, the depositor is already credited liquid tBTC via the standard Bridge/vault redemption path. Only the dedicated-UTXO reservation position itself lacks an early voluntary close mechanism in M1.
- **Procedure for raising capacity:** When active occupancy saturates or additional headroom is required, governance can raise the occupancy limit by calling `updateReservationCaps(maxReservationsAmountPerWallet, reservationMaxSingleAmount, newMaxActiveReservations)` with a higher `newMaxActiveReservations` value.
- **Sizing constraint:** Any update to `maxActiveReservations` or `reservationMaxSingleAmount` must maintain the Decision 1 relational invariant:
  `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount`
  (unless `reservationMaxSingleAmount == 0`, which disables the amount cap). If lowering caps or raising `reservationMaxTotalAmount`, governance must ensure the new slot capacity accommodates `reservationMaxTotalAmount`.
- **Operational timeline considerations:** Whether the Milestone 1 launch is expected to reach reservation term expiry before Milestone 2 ships is an open operational question that the deploying team and governance should confirm prior to setting initial term lengths and occupancy limits.

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

Off-chain tooling updates required:

- Governance proposal builders (Defender, Safe Transaction Builder, Tenderly, custom multisend helpers) — regenerate the encoded calldata with the 3-argument signature.
- Indexers and dashboards (The Graph subgraphs, Dune queries, custom event listeners) — update the event ABI to 3 fields. Backward-compatible decoders will read the new field as the next positional argument; forward-compatible decoders ignore unknown fields.
- Monitoring alerts and circuit breakers keyed on `ReservationCapsUpdated` — confirm the alerts still fire on the new 3-field signature.

`IReservationBridge` in this PR includes the updated 3-argument `updateReservationCaps` declaration; consumers that bind through it are forward-compatible automatically.

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
