// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";

import {ReservationInvariantHarness} from "./ReservationInvariantHarness.sol";
import {ReservationLivenessHandler} from "./ReservationLivenessHandler.sol";

/// @notice Checks that the hand-off liveness property agrees with the real
///         re-anchor rules: it holds when a hand-off is possible and fails
///         exactly when the library rejects every hand-off.
contract ReservationLivenessTest is Test {
    ReservationLivenessHandler internal handler;
    ReservationInvariantHarness internal harness;

    function setUp() public {
        handler = new ReservationLivenessHandler();
        harness = handler.harness();
    }

    function test_holdsWhenALiveWalletHasCapacity() public {
        acceptOn(0, 500_000, 0);
        handler.advanceWallet(0, false);

        assertTrue(handler.property_everyRetiringPositionHasAnExit());
        handler.requestReanchor(0, 1, 0);
        assertEq(handler.successes("requestReanchor"), 1);
    }

    /// @dev One reservation per wallet with a per-wallet cap of one and a
    ///      hand-off reserve of one wallet: acceptance admits at most
    ///      `live wallets - reserve` positions, so a free target always
    ///      remains when a custodian retires. The fourth acceptance is
    ///      rejected and the retiring position can still be handed off.
    function test_reserveKeepsAFreeTargetWhenEveryOtherWalletIsFull() public {
        handler.updateLimits(0, 6_000_000); // max 1 reservation per wallet
        for (uint256 i = 0; i < 3; i++) {
            acceptOn(i, 500_000, 0);
        }
        uint256 fourth = handler.keyCount();
        handler.revealReservedDeposit(3, 500_000, 0);
        handler.requestAcceptance(fourth);
        assertEq(handler.successes("requestAcceptance"), 3, "reserve admits 3");

        handler.advanceWallet(0, false);

        assertTrue(handler.property_everyRetiringPositionHasAnExit());
        handler.requestReanchor(0, 3, 0);
        assertEq(handler.successes("requestReanchor"), 1);
    }

    /// @dev A deposit at `min + 2 * txMaxFee` could pay the full fee and
    ///      land on the re-anchor floor, so acceptance rejects it.
    function test_acceptanceRejectsADepositThatCouldNotHandOff() public {
        handler.revealReservedDeposit(0, 10_000, 0); // min + 2 * txMaxFee
        handler.requestAcceptance(0);
        assertEq(handler.successes("requestAcceptance"), 0);
    }

    /// @dev The smallest accepted deposit, anchored with the full fee,
    ///      still clears the re-anchor floor: the first hand-off works.
    function test_firstHandOffWorksAtTheSmallestAcceptedAmount() public {
        acceptOn(0, 10_001, 10_000); // min + 2 * txMaxFee + 1, full fee
        handler.advanceWallet(0, false);

        assertTrue(handler.property_everyRetiringPositionHasAnExit());
        handler.requestReanchor(0, 1, 0);
        assertEq(handler.successes("requestReanchor"), 1);
    }

    /// @dev The acceptance floor guarantees one hop only. If that hop also
    ///      pays the full fee, the anchor lands on the re-anchor floor and a
    ///      second retirement blocks the position.
    function test_secondHandOffCanStillBeBlocked() public {
        acceptOn(0, 10_001, 10_000);
        handler.advanceWallet(0, false);
        handler.requestReanchor(0, 1, 0);
        handler.proveReanchor(0, 1, 10_000); // full fee again
        assertEq(handler.successes("proveReanchor"), 1);
        handler.advanceWallet(1, false);

        assertFalse(handler.property_everyRetiringPositionHasAnExit());
        (, uint8 reason) = handler.firstStuckPosition();
        assertEq(reason, handler.ANCHOR_AT_REANCHOR_FLOOR());
        handler.requestReanchor(0, 2, 0);
        assertEq(handler.successes("requestReanchor"), 1, "library agrees");
    }

    /// @dev The campaign action `tryHandOff` finds no refusal when the
    ///      target is full: the owner's hand-off is accepted anyway.
    function test_tryHandOffIsAcceptedOntoAFullTarget() public {
        handler.updateLimits(0, 6_000_000); // max 1 reservation per wallet
        acceptOn(0, 500_000, 0);
        acceptOn(1, 500_000, 0);
        handler.advanceWallet(0, false);

        handler.tryHandOff(0, 1);

        assertEq(handler.successes("tryHandOff"), 1);
        assertFalse(handler.handOffRefused());
        assertTrue(handler.property_aPossibleHandOffIsNeverRefused());
    }

    /// @dev After a timed-out re-anchor the library refuses the owner until
    ///      the cooldown ends. That is a delay, not a missing exit: the
    ///      action `tryHandOff` stays out of the cooldown and succeeds once
    ///      it ends.
    function test_tryHandOffWaitsOutTheCooldownAfterATimeout() public {
        acceptOn(0, 500_000, 0);
        handler.advanceWallet(0, false);
        handler.requestReanchor(0, 1, 0);
        uint256 key = handler.keyAt(0);
        vm.warp(harness.action(key, 1).timeoutAt);
        handler.notifyReanchorTimedOut(0);
        assertEq(handler.successes("reanchorTimedOut"), 1);

        handler.tryHandOff(0, 1);
        assertEq(handler.successes("tryHandOff"), 0, "inside the cooldown");
        assertFalse(handler.handOffRefused());
        assertTrue(handler.property_everyRetiringPositionHasAnExit());

        // The library does refuse the owner inside the cooldown.
        bytes20 target = handler.walletAt(1);
        vm.expectRevert("Reanchor cooldown in effect");
        harness.requestReservationReanchor(key, target, false);

        vm.warp(harness.reservation(key).reanchorCooldownUntil);
        handler.tryHandOff(0, 1);
        assertEq(handler.successes("tryHandOff"), 1, "after the cooldown");
        assertFalse(handler.handOffRefused());
    }

    /// @dev A retiring position has an exit even when every other Live
    ///      wallet is full: a privileged request skips the target's
    ///      per-wallet caps. A third party does not, and a privileged
    ///      request off a Live source keeps them.
    function test_privilegedHandOffSkipsAFullTargetOthersDoNot() public {
        handler.updateLimits(0, 6_000_000); // max 1 reservation per wallet
        harness.updateReservationCaps(6_000_000, 4_000_000, 8, 1, 1);
        acceptOn(0, 500_000, 0);
        acceptOn(1, 500_000, 0);
        uint256 key = handler.keyAt(0);
        bytes20 fullTarget = handler.walletAt(1);

        // Source still Live: even governance is held to the target's caps.
        vm.expectRevert("Wallet reservations cap exceeded");
        harness.requestReservationReanchor(key, fullTarget, true);

        handler.advanceWallet(0, false);
        assertTrue(handler.property_everyRetiringPositionHasAnExit());

        // A third party is still held to the caps off a retiring source.
        vm.expectRevert("Wallet reservations cap exceeded");
        harness.requestReservationReanchor(key, fullTarget, false);

        // The owner is privileged and lands on the full wallet.
        handler.requestReanchor(0, 1, 0);
        assertEq(handler.successes("requestReanchor"), 1);
        handler.proveReanchor(0, 1, 0);
        assertEq(handler.successes("proveReanchor"), 1);
        (uint32 count, ) = harness.walletReservationInfo(fullTarget);
        assertEq(count, 2, "hand-off passes the per-wallet cap of 1");
        assertTrue(handler.property_capsHoldAfterEveryRequest());
        assertTrue(handler.property_activeCountMatchesOpenPositions());
        assertTrue(handler.property_walletCountersMatchOpenPositions());
    }

    /// @dev Hand-offs can pile onto one wallet beyond its per-wallet cap,
    ///      but only by moving existing positions: the global active count
    ///      and the accounting properties do not change.
    function test_handOffsPileOnOneWalletWithoutBreakingGlobalAccounting()
        public
    {
        handler.updateLimits(0, 6_000_000); // max 1 reservation per wallet
        acceptOn(0, 500_000, 0);
        acceptOn(1, 500_000, 0);
        acceptOn(2, 500_000, 0);
        handler.advanceWallet(0, false);
        handler.advanceWallet(1, false);

        handler.requestReanchor(0, 2, 0);
        handler.proveReanchor(0, 1, 0);
        handler.requestReanchor(1, 2, 0);
        handler.proveReanchor(1, 1, 0);
        assertEq(handler.successes("proveReanchor"), 2);

        (uint32 count, ) = harness.walletReservationInfo(handler.walletAt(2));
        assertEq(count, 3, "all three positions sit on one wallet");
        assertTrue(handler.property_capsHoldAfterEveryRequest());
        assertTrue(handler.property_activeCountMatchesOpenPositions());
        assertTrue(handler.property_walletCountersMatchOpenPositions());
        assertTrue(handler.property_everyRetiringPositionHasAnExit());
    }

    /// @dev The property fires when no other wallet is Live, and the
    ///      library rejects every hand-off for the same reason.
    function test_firesWhenNoOtherWalletIsLive() public {
        acceptOn(0, 500_000, 0);
        for (uint256 i = 0; i < 4; i++) {
            handler.advanceWallet(i, false);
        }

        assertFalse(handler.property_everyRetiringPositionHasAnExit());
        (, uint8 reason) = handler.firstStuckPosition();
        assertEq(reason, handler.NO_LIVE_TARGET());
        handler.requestReanchor(0, 1, 0);
        assertEq(handler.successes("requestReanchor"), 0, "library agrees");
    }

    /// @dev A stuck position of one reason does not hide a stuck position of
    ///      the other reason: key 0 sits at the re-anchor floor, key 1 has
    ///      no Live target, and both split properties fail.
    function test_oneStuckReasonDoesNotHideTheOther() public {
        acceptOn(0, 10_001, 10_000);
        handler.advanceWallet(0, false);
        handler.requestReanchor(0, 1, 0);
        handler.proveReanchor(0, 1, 10_000);
        assertEq(handler.successes("proveReanchor"), 1);
        acceptOn(3, 500_000, 0);
        for (uint256 i = 1; i < 4; i++) {
            handler.advanceWallet(i, false);
        }

        (uint256 firstKey, uint8 firstReason) = handler.firstStuckPosition();
        assertEq(firstKey, handler.keyAt(0));
        assertEq(firstReason, handler.ANCHOR_AT_REANCHOR_FLOOR());
        assertFalse(handler.property_noPositionIsStuckAtTheReanchorFloor());
        assertFalse(handler.property_noPositionIsStuckWithoutALiveTarget());
    }

    function acceptOn(
        uint256 walletIndex,
        uint64 amountSeed,
        uint64 feeSeed
    ) internal {
        uint256 index = handler.keyCount();
        handler.revealReservedDeposit(walletIndex, amountSeed, 0);
        handler.requestAcceptance(index);
        handler.proveAcceptance(index, 0, feeSeed);
        assertEq(handler.successes("proveAcceptance"), index + 1, "accepted");
    }
}
