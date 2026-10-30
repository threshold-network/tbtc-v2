// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";

import {Reservation} from "../../contracts/bridge/Reservation.sol";

import {ReservationStackHarness} from "./ReservationStackHarness.sol";
import {ReservationSurfaceHandler} from "./ReservationSurfaceHandler.sol";

/// @notice Fire tests for the four router properties of the reservations
///         surface campaign: the timeout gates, the governance-only role
///         matrix, the timeout cooldown and the router's view surface.
///
/// @dev A campaign property that never fails is indistinguishable from one
///      that cannot fail. Each case here drives the handler to a state where
///      the property is expected to hold, breaks exactly one thing that the
///      property judges, and asserts the property returns false. The positive
///      controls, which show the same properties passing on an unbroken run,
///      live in `ReservationSurface.t.sol`.
///
///      The corruption is always outside the protocol: a `vm.mockCall` on a
///      harness view, a governance hand-over the real router honours, or a
///      mocked harness call so the handler sees a router success that the
///      router's own deadline checks would have refused. No storage is
///      written directly and no production contract is modified.
contract ReservationRouterFiresTest is Test {
    ReservationSurfaceHandler internal handler;
    ReservationStackHarness internal stack;

    function setUp() public {
        handler = new ReservationSurfaceHandler();
        stack = handler.stack();
    }

    // ---------------------------------------------------------------------
    // P22 / INV-601: a timeout notification is refused before the deadline
    // ---------------------------------------------------------------------

    function test_timeoutsAreRefusedBeforeTheDeadlineFires() public {
        uint256 key = _revealAndRequest();

        Reservation.ReservationAction memory action = stack
            .reservationActionRecord(
                key,
                stack.reservationRecord(key).requestNonce
            );
        assertEq(
            uint8(action.state),
            uint8(Reservation.ActionState.Pending),
            "no pending generation to time out"
        );
        assertLt(
            block.timestamp,
            uint256(action.timeoutAt),
            "the generation is already past its deadline"
        );

        // The property holds on this state, so the corruption below is the
        // only difference.
        assertTrue(handler.property_timeoutsAreRefusedBeforeTheDeadline());

        // The real router refuses this call; the positive control is
        // `test_timeoutNotificationIsRefusedBeforeTheDeadline`. Report a
        // success from the harness wrapper instead, so the handler observes a
        // timeout that went through before the deadline.
        _reportRouterSuccess();
        handler.surfaceEarlyTimeout(0);

        assertTrue(
            handler.earlyTimeoutSucceeded(),
            "the corruption did not reach the violation flag"
        );
        assertFalse(handler.property_timeoutsAreRefusedBeforeTheDeadline());
    }

    // ---------------------------------------------------------------------
    // P22 / INV-601, INV-602: a timed-out re-anchor sets a cooldown
    // ---------------------------------------------------------------------

    function test_reanchorTimeoutSetsCooldownFires() public {
        uint256 key = _openPosition();
        handler.surfaceRequestReanchor(0, 1, 0);
        _assertPendingReanchor(key);

        assertTrue(handler.property_reanchorTimeoutSetsCooldown());

        // A re-anchor timeout writes a cooldown as long as the authorization
        // window it just expired. Report the router success without letting
        // the router run, so the action stays pending and no cooldown is
        // written.
        _reportRouterSuccess();
        handler.surfaceNotifyTimeout(0, 1);

        assertTrue(
            handler.reanchorTimeoutWithoutCooldown(),
            "the corruption did not reach the violation flag"
        );
        assertEq(
            uint256(stack.reservationRecord(key).reanchorCooldownUntil),
            0,
            "a cooldown was written after all"
        );
        assertFalse(handler.property_reanchorTimeoutSetsCooldown());
    }

    // ---------------------------------------------------------------------
    // P24 / INV-401: only governance changes the router parameters
    // ---------------------------------------------------------------------

    function test_onlyGovernanceChangesRouterParametersFires() public {
        // The harness is its own governance, so navigate the router's role
        // matrix by handing governance to the address the action calls
        // through. The mutator then passes `onlyGovernance` and the action
        // observes a parameter change from a non-governance caller.
        // Read the caller first: `vm.prank` applies to the next call, and an
        // argument expression that calls the handler would consume it.
        address caller = address(handler.nonGovernanceCaller());
        vm.prank(address(stack));
        stack.transferGovernance(caller);

        assertTrue(handler.property_onlyGovernanceChangesRouterParameters());

        (uint64 perWalletBefore, uint64 singleBefore, , ) = stack
            .reservationCapsProbe();

        // `which = 1` is the caps mutator. The seed is chosen so the new caps
        // satisfy the library's slot-capacity bound
        // (`total <= maxActive * single`): single 3_049_999 sat, 8 active
        // slots. The per-wallet amount cap moves too, so the parameter change
        // is visible to the action's own before/after probes.
        handler.routerNonGovernanceUpdate(1, 2_999_999);

        (uint64 perWalletAfter, uint64 singleAfter, , ) = stack
            .reservationCapsProbe();
        assertTrue(
            perWalletAfter != perWalletBefore || singleAfter != singleBefore,
            "the non-governance caller changed nothing"
        );
        assertTrue(
            handler.nonGovernanceParameterChange(),
            "the corruption did not reach the violation flag"
        );
        assertFalse(handler.property_onlyGovernanceChangesRouterParameters());
    }

    // ---------------------------------------------------------------------
    // P24 / INV-401: the router's views agree with the storage they read
    // ---------------------------------------------------------------------

    function test_routerViewsAgreeWithStorageFires() public {
        // The router's own view reads the harness storage through the
        // fallback; the property compares it with the harness probe. Report a
        // cap the router cannot be holding.
        handler.routerReadViews();
        assertTrue(handler.property_routerViewsAgreeWithStorage());

        (
            uint64 perWallet,
            uint64 single,
            uint32 maxActive,
            uint32 maxHolds
        ) = stack.reservationCapsProbe();
        vm.mockCall(
            address(stack),
            abi.encodeWithSelector(
                ReservationStackHarness.reservationCapsProbe.selector
            ),
            abi.encode(perWallet, single, maxActive + 1, maxHolds)
        );

        handler.routerReadViews();

        assertTrue(
            handler.routerViewMismatch(),
            "the corruption did not reach the violation flag"
        );
        assertFalse(handler.property_routerViewsAgreeWithStorage());
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev Reveals a reserved deposit and issues its acceptance
    ///      authorization, leaving a pending acceptance generation.
    function _revealAndRequest() internal returns (uint256 key) {
        handler.surfaceReveal(0, 2_000_001, 1);
        assertEq(handler.stackKeyCount(), 1, "the reveal recorded no key");
        key = handler.stackKeyAt(0);

        handler.surfaceRequestAcceptance(0);
        assertEq(
            uint256(stack.reservationRecord(key).requestNonce),
            1,
            "no acceptance authorization was issued"
        );
    }

    /// @dev Reveals, requests and settles an acceptance, leaving an Active
    ///      position that can be re-anchored.
    function _openPosition() internal returns (uint256 key) {
        key = _revealAndRequest();

        // The settlement needs the deposit to be older than the validator's
        // deposit minimum age.
        vm.warp(block.timestamp + 2 hours + 1);
        handler.surfaceProveAcceptance(0, 0, 0);

        assertEq(
            uint8(stack.reservationRecord(key).state),
            uint8(Reservation.ReservationState.Active),
            "the acceptance did not settle"
        );
    }

    function _assertPendingReanchor(uint256 key) internal view {
        Reservation.ReservationRequest memory r = stack.reservationRecord(key);
        Reservation.ReservationAction memory action = stack
            .reservationActionRecord(key, r.requestNonce);
        assertEq(
            uint8(action.actionType),
            uint8(Reservation.ActionType.Reanchor),
            "the request did not open a re-anchor generation"
        );
        assertEq(
            uint8(action.state),
            uint8(Reservation.ActionState.Pending),
            "the re-anchor generation is not pending"
        );
    }

    /// @dev Makes the harness wrapper report a successful router call, so the
    ///      handler observes the outcome of a router entry point without the
    ///      router's own guards running.
    function _reportRouterSuccess() internal {
        vm.mockCall(
            address(stack),
            abi.encodeWithSelector(ReservationStackHarness.callRouter.selector),
            abi.encode(true)
        );
    }
}
