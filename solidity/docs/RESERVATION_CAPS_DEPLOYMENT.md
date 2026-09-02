# Reservation Caps Deployment Instructions for All Actors

## Overview

The milestone-1 reservation subsystem introduces two governance setters with a deploy-ordering dependency and a third ABI/event argument relative to the #1094 specification. This document covers the new coordination requirements.

Changes relative to #1094:

- `updateReservationCaps` now takes a third argument `maxActiveReservations` (uint32, must be > 0). The 4-byte selector changes; existing Defender / Safe / Tenderly / multisend scripts that encode the 2-argument version will revert.
- The `ReservationCapsUpdated` event gained a third field `maxActiveReservations`. Off-chain indexers and dashboards that decode the 2-field version will need a redeploy.
- `updateReservationParameters` enforces the Decision 1 on-chain relational check `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` by reading both `self.maxActiveReservations` and `self.reservationMaxSingleAmount` from storage. In the pristine pre-launch bootstrap state, both are zero, so the check short-circuits and any `reservationMaxTotalAmount` is accepted. Subsequent calls can revert with `Amount cap exceeds slot capacity` if governance sets `reservationMaxTotalAmount` first and the later `updateReservationCaps` operands cannot accommodate it.

---

## Deploy Order (Decision 1)

During the initial bootstrap of the reservation subsystem, governance must call `updateReservationCaps` **before** `updateReservationParameters`. Calling them in the opposite order leaves the storage in a state where the next `updateReservationCaps` reverts because the standing `reservationMaxTotalAmount` exceeds `maxActiveReservations * reservationMaxSingleAmount`.

Safe operational sequence:

1. Call `updateReservationCaps(maxReservationsAmountPerWallet, reservationMaxSingleAmount, maxActiveReservations)` — sets the per-wallet amount cap, the single-reservation amount cap, and the global occupancy cap together. The Decision 1 check evaluates `0 <= maxActiveReservations * reservationMaxSingleAmount` (true because `reservationMaxTotalAmount` is still 0).
2. Call `updateReservationParameters(reservationVault, ...)` — sets `reservationMaxTotalAmount` and the other parameters. The Decision 1 check now evaluates `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` against the just-set storage values.

If the two updates must land in the same block, an atomic multicall preserves the ordering guarantee.

The existing regression test `Bridge.ReservationCaps.test.ts` in the `describe("bootstrap ordering")` group pins both the deploy-ordering hazard and the safe operational order; review it before any deployment.

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
// Spot-check the new cap state via the bridge fallback or directly via the router.
(uint64 maxReservationsAmountPerWallet, uint64 reservationMaxSingleAmount, uint32 maxActiveReservations) =
    IReservationBridge(bridgeAddress).reservationParameters(); // returns the full parameter set
```

The `reservationParameters()` view returns the full parameter record including `reservationMaxTotalAmount` and `maxReservationsPerWallet`, sufficient to verify the Decision 1 invariant holds:

```
reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount
```

If the invariant is violated, the on-chain setter has rejected the configuration and the upgrade is in an inconsistent state. Roll back to the prior implementation (the post-upgrade `BridgeState.Storage` snapshot preserved in the upgrade transaction) and re-apply the upgrade with the correct deploy ordering.
