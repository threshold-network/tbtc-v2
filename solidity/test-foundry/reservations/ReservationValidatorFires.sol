// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";

import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {ReservationRouter} from "../../contracts/bridge/ReservationRouter.sol";
import {WalletProposalValidator} from "../../contracts/bridge/WalletProposalValidator.sol";

import {ReservationSurfaceHandler} from "./ReservationSurfaceHandler.sol";
import {ReservationStackHarness} from "./ReservationStackHarness.sol";

/// @notice Negative controls for the validator properties of the surface
///         campaign. Each test drives the campaign to a state where the
///         property holds, corrupts exactly one thing, and asserts the
///         property reports the violation. Without these, a property that
///         merely cannot fire is indistinguishable from one that cannot fail.
/// @dev Corrupting harness state is not enough to produce a wrongly accepted
///      proposal: the probe builds the proposal from the same reads the
///      validator then checks, so a state change that weakens an admission
///      rule weakens the proposal with it. The two paths the tests take are
///      therefore the two places where the probe and the validator can be
///      made to disagree:
///      - a harness view that reports a generation the state never issued
///        (the validator runs its real code and accepts a proposal no action
///        backs),
///      - the validator's own verdict (for the fee bound, which is derived
///        from the same read the probe uses, so no state change can separate
///        the proposed fee from the bound).
contract ReservationValidatorFiresTest is Test {
    ReservationSurfaceHandler internal handler;
    ReservationStackHarness internal stack;

    function setUp() public {
        handler = new ReservationSurfaceHandler();
        stack = handler.stack();
    }

    /// @dev `property_validatorRejectsUnbackedProposals`: the campaign must
    ///      catch a proposal that no pending action backs.
    /// @dev The harness is made to answer as if the next generation had been
    ///      issued. The real validator then accepts the proposal, the probe
    ///      records the acceptance, and the property has to fail.
    function test_validatorRejectsUnbackedProposalsFires() public {
        handler.surfaceReveal(0, 2_000_001, 1);
        handler.surfaceRequestAcceptance(0);

        uint256 key = handler.stackKeyAt(0);
        uint64 pendingNonce = stack.reservationRecord(key).requestNonce;
        assertEq(
            pendingNonce,
            1,
            "the acceptance request issued no generation"
        );
        // The deposit must be old enough for an acceptance: otherwise the
        // validator rejects the proposal for its age, the flag stays false,
        // and the test fails for a reason unrelated to the property.
        vm.warp(block.timestamp + 2 hours + 1);

        assertTrue(
            handler.property_validatorRejectsUnbackedProposals(),
            "the property must hold before the corruption"
        );
        assertFalse(
            handler.unbackedAnchorAccepted(),
            "no unbacked proposal was accepted before the corruption"
        );

        // `surfaceValidateUnbackedAnchor(keySeed, 0, feeSeed)` proposes for
        // `requestNonce + 1`; give that nonce the record of the pending one.
        vm.mockCall(
            address(stack),
            abi.encodeWithSelector(
                ReservationRouter.reservationActions.selector,
                key,
                pendingNonce + 1
            ),
            abi.encode(stack.reservationActionRecord(key, pendingNonce))
        );

        handler.surfaceValidateUnbackedAnchor(0, 0, 0);

        assertTrue(
            handler.unbackedAnchorAccepted(),
            "the probe did not record the accepted unbacked proposal"
        );
        assertFalse(
            handler.property_validatorRejectsUnbackedProposals(),
            "the property missed an accepted unbacked proposal"
        );
    }

    /// @dev `property_validatorRejectsOutOfBoundProposals`: the campaign must
    ///      catch a proposal whose fee exceeds the action's snapshotted
    ///      maximum.
    /// @dev The probe derives the proposed fee from the same `txMaxFee` it
    ///      then proposes above, so a state change moves both together and the
    ///      proposal stays inside its bound. Only the verdict itself can be
    ///      corrupted here.
    function test_validatorRejectsOutOfBoundProposalsFires() public {
        handler.surfaceReveal(0, 2_000_001, 1);
        handler.surfaceRequestAcceptance(0);

        assertTrue(
            handler.property_validatorRejectsOutOfBoundProposals(),
            "the property must hold before the corruption"
        );
        assertFalse(
            handler.overFeeAnchorAccepted(),
            "no over-fee proposal was accepted before the corruption"
        );

        WalletProposalValidator validator = stack.validator();
        vm.mockCall(
            address(validator),
            abi.encodeWithSelector(
                WalletProposalValidator
                    .validateReservationAnchorProposal
                    .selector
            ),
            abi.encode(true)
        );

        // Mutation 1 raises the proposed fee above the action's `txMaxFee`.
        handler.surfaceValidateAnchor(0, 0, 1);

        assertTrue(
            handler.overFeeAnchorAccepted(),
            "the probe did not record the accepted over-fee proposal"
        );
        assertFalse(
            handler.property_validatorRejectsOutOfBoundProposals(),
            "the property missed an accepted out-of-bound proposal"
        );
    }

    /// @dev `property_validatorNeverSweepsReservedDeposits`: the campaign must
    ///      catch an ordinary deposit-sweep proposal that would take a deposit
    ///      revealed as reserved. That guard lives in
    ///      `validateDepositSweepProposal`, a different entry point from the
    ///      two reservation proposal validators.
    function test_validatorNeverSweepsReservedDepositsFires() public {
        // Positive control: the real validator accepts a sweep over a pool
        // deposit, which also means the reservation rule had to say "not
        // reserved" for the accepted proposal.
        handler.surfaceValidateSweep(0, 1, 0);
        assertEq(
            handler.ghostSweepAccepted(),
            1,
            "the pool sweep was not accepted"
        );
        assertTrue(
            handler.property_validatorNeverSweepsReservedDeposits(),
            "the property must hold before the corruption"
        );
        assertFalse(
            handler.reservedSweepAccepted(),
            "no reserved deposit was swept before the corruption"
        );

        // A reserved deposit, with the reservation marker hidden from the
        // validator's own read. The real validator then accepts a proposal
        // that would take reserved funds, and the handler's own code path
        // records it.
        handler.surfaceReveal(0, 2_000_001, 1);
        uint256 reservedKey = handler.stackKeyAt(0);
        assertTrue(
            stack.isReservedDepositProbe(reservedKey),
            "the revealed deposit is not marked reserved"
        );

        // The guard really fires first: the same proposal, with the marker
        // visible, is rejected and nothing is recorded.
        handler.surfaceValidateSweep(0, 1, 1);
        assertEq(
            handler.ghostSweepAccepted(),
            1,
            "the reserved sweep was accepted with its marker visible"
        );
        assertFalse(
            handler.reservedSweepAccepted(),
            "a rejected reserved sweep set the violation flag"
        );

        vm.mockCall(
            address(stack),
            abi.encodeWithSelector(
                ReservationStackHarness.isReservedDeposit.selector,
                reservedKey
            ),
            abi.encode(false)
        );

        handler.surfaceValidateSweep(0, 1, 1);

        assertTrue(
            handler.reservedSweepAccepted(),
            "the probe did not record the accepted reserved sweep"
        );
        assertFalse(
            handler.property_validatorNeverSweepsReservedDeposits(),
            "the property missed an accepted reserved sweep"
        );
    }
}
