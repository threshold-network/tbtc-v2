// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/Reservation.sol";

/// @notice Test harness exposing the reservation term table helpers of
///         `BridgeState`, which are `internal`. Entries are added through
///         `BridgeState.addReservationTerm`, the write path that maintains
///         the cached largest and smallest lengths, bypassing the
///         validation in `Reservation.setReservationTerm` so the aggregates
///         can be exercised on table shapes the setter would refuse.
///         `setEnabled` is the raw flag write the setter's flip branch
///         performs, so a flip can be shown to leave the aggregates alone.
contract TestReservationTermTable {
    using BridgeState for BridgeState.Storage;

    BridgeState.Storage internal self;

    function addTerm(
        uint8 termId,
        uint32 termSeconds,
        uint16 custodyBps,
        bool enabled
    ) external {
        self.addReservationTerm(termId, termSeconds, custodyBps, enabled);
    }

    function setEnabled(uint8 termId, bool enabled) external {
        self.reservationTerms[termId].enabled = enabled;
    }

    function largestReservationTermSeconds() external view returns (uint32) {
        return self.largestReservationTermSeconds();
    }

    function smallestReservationTermSeconds() external view returns (uint32) {
        return self.smallestReservationTermSeconds();
    }
}
