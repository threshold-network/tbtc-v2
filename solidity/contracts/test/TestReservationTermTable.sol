// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/Reservation.sol";

/// @notice Test harness exposing the reservation term table helpers of
///         `BridgeState`, which are `internal`. Entries are written raw,
///         bypassing `Reservation.setReservationTerm`, so the helpers can be
///         exercised on table shapes the setter never produces (ids outside
///         [1, MAX_RESERVATION_TERM_ID]).
contract TestReservationTermTable {
    using BridgeState for BridgeState.Storage;

    BridgeState.Storage internal self;

    function setRawTerm(
        uint8 termId,
        uint32 termSeconds,
        uint16 custodyBps,
        bool enabled
    ) external {
        self.reservationTerms[termId] = Reservation.ReservationTerm(
            termSeconds,
            custodyBps,
            enabled
        );
    }

    function largestReservationTermSeconds() external view returns (uint32) {
        return self.largestReservationTermSeconds();
    }

    function smallestReservationTermSeconds() external view returns (uint32) {
        return self.smallestReservationTermSeconds();
    }
}
