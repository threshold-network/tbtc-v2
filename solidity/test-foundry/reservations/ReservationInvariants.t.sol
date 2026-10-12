// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {Reservation} from "../../contracts/bridge/Reservation.sol";

import {ReservationHandler} from "./ReservationHandler.sol";
import {
    ReservationInvariantHarness,
    FeeFinancerRecorder
} from "./ReservationInvariantHarness.sol";

/// @notice Stateful invariant tests for the reservation accounting. The
///         handler drives random sequences of requests, timeouts, proofs,
///         strandings, wallet retirements and governance cap changes.
contract ReservationInvariantsTest is Test {
    ReservationHandler internal handler;
    ReservationInvariantHarness internal harness;

    function setUp() public {
        handler = new ReservationHandler();
        harness = handler.harness();

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = handler.revealReservedDeposit.selector;
        selectors[1] = handler.requestAcceptance.selector;
        selectors[2] = handler.notifyAcceptanceTimedOut.selector;
        selectors[3] = handler.proveAcceptance.selector;
        selectors[4] = handler.requestReanchor.selector;
        selectors[5] = handler.notifyReanchorTimedOut.selector;
        selectors[6] = handler.proveReanchor.selector;
        selectors[7] = handler.notifyStranded.selector;
        selectors[8] = handler.retirePendingDeposit.selector;
        selectors[9] = handler.advanceWallet.selector;
        selectors[10] = handler.addWallet.selector;
        selectors[11] = handler.updateCaps.selector;
        selectors[12] = handler.updateLimits.selector;
        selectors[13] = handler.warp.selector;
        targetSelector(
            StdInvariant.FuzzSelector({
                addr: address(handler),
                selectors: selectors
            })
        );
        targetContract(address(handler));
    }

    // ---------------------------------------------------------------------
    // Invariants
    // ---------------------------------------------------------------------

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 100
    /// forge-config: ci.invariant.runs = 256
    /// forge-config: ci.invariant.depth = 100
    function invariant_reservationAccounting() public {
        assertTrue(
            handler.property_activeCountMatchesOpenPositions(),
            "active count"
        );
        assertTrue(
            handler.property_totalAmountMatchesOpenPositions(),
            "total amount"
        );
        assertTrue(
            handler.property_walletCountersMatchOpenPositions(),
            "wallet counters"
        );
        assertTrue(
            handler.property_thirdPartyHoldsMatchPendingRequests(),
            "third-party holds"
        );
        assertTrue(
            handler.property_pendingReservedDepositsMatchMarkers(),
            "pending reserved deposits"
        );
        assertTrue(
            handler.property_anchorIndexPointsAtOpenPositions(),
            "anchor index"
        );
        assertTrue(
            handler.property_settledAndSupersededActionsAreFinal(),
            "final actions"
        );
        assertTrue(handler.property_capsHoldAfterEveryRequest(), "caps");
        assertTrue(handler.property_creditsMatchSettlements(), "credits");
    }

    // ---------------------------------------------------------------------
    // Scripted lifecycles: each step must keep every property true
    // ---------------------------------------------------------------------

    function test_acceptReanchorAndStrand() public {
        uint256 key = acceptOne();

        // The custodian retires; a third party moves the anchor.
        handler.advanceWallet(0, false);
        handler.requestReanchor(0, 1, 1);
        assertEq(handler.successes("requestReanchor"), 1);
        assertEq(
            harness.pendingThirdPartyReanchorHolds(handler.walletAt(1)),
            1
        );
        assertAllProperties();

        handler.proveReanchor(0, 1, 5_000);
        assertEq(handler.successes("proveReanchor"), 1);
        assertEq(
            harness.reservation(key).walletPubKeyHash,
            handler.walletAt(1)
        );
        assertAllProperties();

        // The new custodian is terminated; anyone strands the position.
        handler.advanceWallet(1, true);
        handler.notifyStranded(0);
        assertEq(handler.successes("stranded"), 1);
        assertAllProperties();
    }

    function test_lateAcceptanceAfterTimeout() public {
        handler.revealReservedDeposit(0, 0, 0);
        handler.requestAcceptance(0);
        handler.warp(7 hours);
        handler.notifyAcceptanceTimedOut(0);
        assertEq(handler.successes("acceptanceTimedOut"), 1);
        assertAllProperties();

        handler.proveAcceptance(0, 0, 0);
        assertEq(handler.successes("proveAcceptanceLate"), 1);
        assertAllProperties();
    }

    function test_reanchorTimeoutThenLateProof() public {
        acceptOne();
        handler.advanceWallet(0, false);
        handler.requestReanchor(0, 1, 0);
        handler.warp(7 hours);
        handler.notifyReanchorTimedOut(0);
        assertEq(handler.successes("reanchorTimedOut"), 1);
        assertAllProperties();

        handler.proveReanchor(0, 1, 1_000);
        assertEq(handler.successes("proveReanchorLate"), 1);
        assertAllProperties();
    }

    // ---------------------------------------------------------------------
    // Fire tests: each property must fail on a corrupted state
    // ---------------------------------------------------------------------

    function test_activeCountPropertyFires() public {
        acceptOne();
        (uint32 active, uint64 total, ) = harness.totals();
        harness.corruptTotals(active + 1, total);
        assertFalse(handler.property_activeCountMatchesOpenPositions());
    }

    function test_totalAmountPropertyFires() public {
        acceptOne();
        (uint32 active, uint64 total, ) = harness.totals();
        harness.corruptTotals(active, total + 1);
        assertFalse(handler.property_totalAmountMatchesOpenPositions());
    }

    function test_walletCountersPropertyFires() public {
        acceptOne();
        bytes20 wallet = handler.walletAt(0);
        (uint32 count, uint64 amount) = harness.walletReservationInfo(wallet);
        harness.corruptWalletInfo(wallet, count, amount - 1);
        assertFalse(handler.property_walletCountersMatchOpenPositions());
    }

    function test_thirdPartyHoldsPropertyFires() public {
        acceptOne();
        handler.advanceWallet(0, false);
        handler.requestReanchor(0, 1, 1);
        harness.corruptThirdPartyHolds(handler.walletAt(1), 0);
        assertFalse(handler.property_thirdPartyHoldsMatchPendingRequests());
    }

    function test_pendingReservedDepositsPropertyFires() public {
        handler.revealReservedDeposit(0, 0, 0);
        harness.corruptPendingReservedDeposits(2);
        assertFalse(handler.property_pendingReservedDepositsMatchMarkers());
    }

    function test_anchorIndexPropertyFires() public {
        uint256 key = acceptOne();
        harness.corruptAnchorIndex(key);
        assertFalse(handler.property_anchorIndexPointsAtOpenPositions());
    }

    function test_finalActionsPropertyFires() public {
        uint256 key = acceptOne();
        harness.corruptActionState(key, 1, Reservation.ActionState.TimedOut);
        assertFalse(handler.property_settledAndSupersededActionsAreFinal());
    }

    function test_capsPropertyFires() public {
        // Report an active cap of zero after the request succeeds; the
        // post-request check must flag the occupancy as over the cap.
        vm.mockCall(
            address(harness),
            abi.encodeWithSelector(harness.caps.selector),
            abi.encode(
                uint64(3_000_000),
                uint64(2_000_000),
                uint32(0),
                uint32(1),
                uint64(6_000_000),
                uint32(2)
            )
        );
        handler.revealReservedDeposit(0, 0, 0);
        handler.requestAcceptance(0);
        assertFalse(handler.property_capsHoldAfterEveryRequest());
    }

    function test_creditsPropertyFires() public {
        acceptOne();
        FeeFinancerRecorder feeVault = harness.feeVault();
        vm.mockCall(
            address(feeVault),
            abi.encodeWithSelector(feeVault.financedSat.selector),
            abi.encode(uint256(1))
        );
        assertFalse(handler.property_creditsMatchSettlements());
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function acceptOne() internal returns (uint256 key) {
        // Well above min + fee so the anchor clears the re-anchor floor.
        handler.revealReservedDeposit(0, 500_000, 0);
        handler.requestAcceptance(0);
        handler.proveAcceptance(0, 0, 0);
        assertEq(handler.successes("proveAcceptance"), 1, "accepted");
        key = handler.keyAt(0);
        assertEq(
            uint8(harness.reservation(key).state),
            uint8(Reservation.ReservationState.Active)
        );
        assertAllProperties();
    }

    function assertAllProperties() internal {
        invariant_reservationAccounting();
    }
}
