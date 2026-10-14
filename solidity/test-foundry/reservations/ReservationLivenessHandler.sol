// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";

import {ReservationHandler} from "./ReservationHandler.sol";

/// @notice Adds a hand-off liveness property to the accounting handler.
/// @dev This property is expected to fail: the current design can leave a
///      position on a retiring wallet with no exit (every other wallet
///      retired, or an anchor at the re-anchor floor). It is kept out of
///      the Foundry invariant run and runs only with
///      `medusa-reservations-liveness.json`, to find and report the
///      sequences that block a hand-off.
contract ReservationLivenessHandler is ReservationHandler {
    uint8 public constant NO_LIVE_TARGET = 1;
    uint8 public constant ANCHOR_AT_REANCHOR_FLOOR = 2;

    /// @dev Every Active position on a MovingFunds or Closing wallet must
    ///      have an exit now: a privileged re-anchor request that the
    ///      library accepts, or a strand once a Closing wallet's position
    ///      is dissolution-eligible. A privileged hand-off off a retiring
    ///      source skips the target's per-wallet caps, so a Live target
    ///      with free slots is not required. The re-anchor cooldown is
    ///      ignored because it always ends.
    function property_everyRetiringPositionHasAnExit() public returns (bool) {
        (, uint8 reason) = firstStuckPosition();
        return reason == 0;
    }

    /// @dev Canary: expected to FAIL. A failure proves that the campaign
    ///      reaches a successful `tryHandOff`, so
    ///      `property_aPossibleHandOffIsNeverRefused` is not passing only
    ///      because the action never runs.
    function property_canaryTryHandOffNeverSucceeds()
        public
        view
        returns (bool)
    {
        return successes["tryHandOff"] == 0;
    }

    /// @dev The two stuck reasons, reported separately so a campaign names
    ///      which known case a failing sequence reaches. Both are expected
    ///      to fail.
    function property_noPositionIsStuckWithoutALiveTarget()
        public
        view
        returns (bool)
    {
        (, uint8 reason) = firstStuckPosition();
        return reason != NO_LIVE_TARGET;
    }

    function property_noPositionIsStuckAtTheReanchorFloor()
        public
        view
        returns (bool)
    {
        (, uint8 reason) = firstStuckPosition();
        return reason != ANCHOR_AT_REANCHOR_FLOOR;
    }

    /// @dev Set when the library refuses an owner hand-off that the rules
    ///      say it must accept: an Active position on a MovingFunds or
    ///      Closing wallet, a Live target other than the source, and an
    ///      anchor above the re-anchor floor.
    bool public handOffRefused;
    string public handOffRefusal;

    function tryHandOff(uint256 keySeed, uint256 targetSeed) external {
        if (keys.length == 0) return;
        uint256 key = keys[keySeed % keys.length];
        bytes20 target = wallets[targetSeed % wallets.length];
        Reservation.ReservationRequest memory r = harness.reservation(key);
        if (r.state != Reservation.ReservationState.Active) return;
        Wallets.WalletState custodian = harness.walletState(r.walletPubKeyHash);
        if (
            custodian != Wallets.WalletState.MovingFunds &&
            custodian != Wallets.WalletState.Closing
        ) {
            return;
        }
        if (
            target == r.walletPubKeyHash ||
            harness.walletState(target) != Wallets.WalletState.Live
        ) {
            return;
        }
        (uint64 minAmount, uint64 txMaxFee, ) = harness.parameters();
        if (r.anchorAmount <= minAmount + txMaxFee) return;

        try harness.requestReservationReanchor(key, target, false) {
            successes["tryHandOff"] += 1;
            checkCapsAfterReanchor(target, false, true);
        } catch Error(string memory reason) {
            handOffRefused = true;
            handOffRefusal = reason;
        } catch {
            handOffRefused = true;
            handOffRefusal = "non-string revert";
        }
    }

    /// @dev A hand-off that the rules call possible is never refused. Any
    ///      failure here is a gap between this model and the library.
    function property_aPossibleHandOffIsNeverRefused()
        public
        view
        returns (bool)
    {
        return !handOffRefused;
    }

    /// @return reservationKey The first position without an exit.
    /// @return reason 0 when every position has an exit, otherwise
    ///         `NO_LIVE_TARGET` or `ANCHOR_AT_REANCHOR_FLOOR`.
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
        return hasLiveTarget(r.walletPubKeyHash) ? 0 : NO_LIVE_TARGET;
    }

    function hasLiveTarget(bytes20 source) internal view returns (bool) {
        for (uint256 i = 0; i < wallets.length; i++) {
            if (
                wallets[i] != source &&
                harness.walletState(wallets[i]) == Wallets.WalletState.Live
            ) {
                return true;
            }
        }
        return false;
    }
}
