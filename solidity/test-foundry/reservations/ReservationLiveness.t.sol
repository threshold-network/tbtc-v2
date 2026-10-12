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
        acceptOn(0, 500_000);
        handler.advanceWallet(0, false);

        assertTrue(handler.property_everyRetiringPositionHasAnExit());
        handler.requestReanchor(0, 1, 0);
        assertEq(handler.successes("requestReanchor"), 1);
    }

    /// @dev One reservation per wallet with a per-wallet cap of one: when a
    ///      custodian retires, every Live wallet is full. Raising the cap
    ///      restores the hand-off.
    function test_firesWhenEveryLiveWalletIsFull() public {
        handler.updateLimits(0, 6_000_000); // max 1 reservation per wallet
        for (uint256 i = 0; i < 4; i++) {
            acceptOn(i, 500_000);
        }
        handler.advanceWallet(0, false);

        assertFalse(handler.property_everyRetiringPositionHasAnExit());
        (uint256 key, uint8 reason) = handler.firstStuckPosition();
        assertEq(key, handler.keyAt(0));
        assertEq(reason, handler.NO_TARGET_WITH_CAPACITY());
        for (uint256 target = 1; target < 4; target++) {
            handler.requestReanchor(0, target, 0);
        }
        assertEq(handler.successes("requestReanchor"), 0, "library agrees");

        handler.updateLimits(1, 6_000_000); // max 2 reservations per wallet
        assertTrue(handler.property_everyRetiringPositionHasAnExit());
        handler.requestReanchor(0, 1, 0);
        assertEq(handler.successes("requestReanchor"), 1);
    }

    /// @dev An anchor at or below `min + txMaxFee` passes acceptance but
    ///      fails the re-anchor amount floor, so it cannot be handed off
    ///      even when every other wallet is empty.
    function test_firesWhenTheAnchorIsAtTheReanchorFloor() public {
        acceptOn(0, 0); // deposit = min + txMaxFee, zero miner fee
        handler.advanceWallet(0, false);

        assertFalse(handler.property_everyRetiringPositionHasAnExit());
        (, uint8 reason) = handler.firstStuckPosition();
        assertEq(reason, handler.ANCHOR_AT_REANCHOR_FLOOR());
        handler.requestReanchor(0, 1, 0);
        assertEq(handler.successes("requestReanchor"), 0, "library agrees");
    }

    function acceptOn(uint256 walletIndex, uint64 amountSeed) internal {
        uint256 index = handler.keyCount();
        handler.revealReservedDeposit(walletIndex, amountSeed, 0);
        handler.requestAcceptance(index);
        handler.proveAcceptance(index, 0, 0);
        assertEq(handler.successes("proveAcceptance"), index + 1, "accepted");
    }
}
