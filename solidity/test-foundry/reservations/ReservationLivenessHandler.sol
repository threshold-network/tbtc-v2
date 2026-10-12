// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";

import {ReservationHandler} from "./ReservationHandler.sol";

/// @notice Adds a hand-off liveness property to the accounting handler.
/// @dev This property is expected to fail: the current design can leave a
///      position on a retiring wallet with no exit. It is kept out of the
///      Foundry invariant run and runs only with
///      `medusa-reservations-liveness.json`, to find and report the
///      sequences that block a hand-off.
contract ReservationLivenessHandler is ReservationHandler {
    uint8 public constant NO_TARGET_WITH_CAPACITY = 1;
    uint8 public constant ANCHOR_AT_REANCHOR_FLOOR = 2;

    /// @dev Every Active position on a MovingFunds or Closing wallet must
    ///      have an exit now: a re-anchor request that the capacity rules
    ///      accept, or a strand once a Closing wallet's position is
    ///      dissolution-eligible. The re-anchor cooldown is ignored because
    ///      it always ends.
    function property_everyRetiringPositionHasAnExit() public returns (bool) {
        (, uint8 reason) = firstStuckPosition();
        return reason == 0;
    }

    /// @return reservationKey The first position without an exit.
    /// @return reason 0 when every position has an exit, otherwise
    ///         `NO_TARGET_WITH_CAPACITY` or `ANCHOR_AT_REANCHOR_FLOOR`.
    function firstStuckPosition()
        public
        view
        returns (uint256 reservationKey, uint8 reason)
    {
        for (uint256 i = 0; i < keys.length; i++) {
            reason = stuckReason(keys[i]);
            if (reason != 0) {
                return (keys[i], reason);
            }
        }
        return (0, 0);
    }

    function stuckReason(uint256 key) internal view returns (uint8) {
        Reservation.ReservationRequest memory r = harness.reservation(key);
        if (r.state != Reservation.ReservationState.Active) {
            return 0;
        }
        Wallets.WalletState custodian = harness.walletState(r.walletPubKeyHash);
        if (
            custodian != Wallets.WalletState.MovingFunds &&
            custodian != Wallets.WalletState.Closing
        ) {
            return 0;
        }
        if (
            custodian == Wallets.WalletState.Closing &&
            block.timestamp >= r.dissolutionEligibleAt
        ) {
            return 0;
        }

        (uint64 minAmount, uint64 txMaxFee, ) = harness.parameters();
        if (r.anchorAmount <= minAmount + txMaxFee) {
            return ANCHOR_AT_REANCHOR_FLOOR;
        }
        return
            hasTargetWithCapacity(r.walletPubKeyHash, r.anchorAmount)
                ? 0
                : NO_TARGET_WITH_CAPACITY;
    }

    function hasTargetWithCapacity(
        bytes20 source,
        uint64 anchorAmount
    ) internal view returns (bool) {
        (uint64 maxAmountPerWallet, , , , , uint32 maxPerWallet) = harness
            .caps();
        for (uint256 i = 0; i < wallets.length; i++) {
            bytes20 target = wallets[i];
            if (
                target == source ||
                harness.walletState(target) != Wallets.WalletState.Live
            ) {
                continue;
            }
            (uint32 count, uint64 amount) = harness.walletReservationInfo(
                target
            );
            if (
                count + 1 <= maxPerWallet &&
                (maxAmountPerWallet == 0 ||
                    amount + anchorAmount <= maxAmountPerWallet)
            ) {
                return true;
            }
        }
        return false;
    }
}
