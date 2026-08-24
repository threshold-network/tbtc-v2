// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/Reservation.sol";

/// @title Reservation governance-setter test harness
/// @notice Exposes the two `Reservation` governance setters without the
///         router's `onlyGovernance` guard, so the amount-cap versus
///         slot-capacity invariant can be unit-tested.
/// @dev Test-only, and deliberately minimal: it declares the storage anchor
///      and forwards, nothing else.
///
///      The invariant lives in the `Reservation` library, which is the only
///      unit reachable today. `ReservationRouter` cannot be exercised
///      standalone — its `governance` is unset by design, so every
///      state-changing entry point reverts (see the router's invariant 3) —
///      and the Bridge seams that wire the router in arrive with the
///      Bridge-integration PR. Retire this stub once those seams exist and
///      both setters can be driven through Bridge governance.
contract ReservationCapsStub {
    using Reservation for BridgeState.Storage;

    BridgeState.Storage internal self;

    function updateReservationParameters(
        address reservationVault,
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationDissolutionDelay,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet,
        uint32 reservationActionTimeout,
        uint32 reservationRenewalWindowSeconds
    ) external {
        self.updateReservationParameters(
            reservationVault,
            reservationMinAmount,
            reservationTxMaxFee,
            reservationTermSeconds,
            reservationDissolutionDelay,
            reservationMaxTotalAmount,
            maxReservationsPerWallet,
            reservationActionTimeout,
            reservationRenewalWindowSeconds
        );
    }

    function updateReservationCaps(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    ) external {
        self.updateReservationCaps(
            maxReservationsAmountPerWallet,
            reservationMaxSingleAmount,
            maxActiveReservations
        );
    }

    /// @notice Returns the three fields the slot-capacity invariant relates.
    function caps()
        external
        view
        returns (
            uint64 reservationMaxTotalAmount,
            uint64 reservationMaxSingleAmount,
            uint32 maxActiveReservations
        )
    {
        reservationMaxTotalAmount = self.reservationMaxTotalAmount;
        reservationMaxSingleAmount = self.reservationMaxSingleAmount;
        maxActiveReservations = self.maxActiveReservations;
    }
}
