// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression test for the mutation that comments out
// `signingLowerBound = block.timestamp;` at Reservation.sol:567 in
// `requestReservationAcceptance`. Before this file no Foundry test could tell
// the mutant from the original, so it survived.
//
// Source lines involved (solidity/contracts/bridge):
//   Reservation.sol:555-576   timeoutAt = now + reservationActionTimeout;
//                             signingLowerBound = max(revealedAt + DEPOSIT_MIN_AGE, now);
//                             earliestSigningAt = signingLowerBound + 1;
//                             actionSigningDeadline = timeoutAt
//                                                     - REQUEST_TIMEOUT_SAFETY_MARGIN;
//                             requires earliestSigningAt < actionSigningDeadline,
//                             else "Acceptance authorization has no signing window"
//   Reservation.sol:1291-1295 updateReservationParameters accepts any
//                             reservationActionTimeout strictly above
//                             REQUEST_TIMEOUT_SAFETY_MARGIN (2 hours), so
//                             7201 seconds is admissible
//
// Why the boundary is the only observable difference: with an action timeout
// of 7201 seconds the signing deadline is exactly `now + 1`. For a deposit
// revealed more than DEPOSIT_MIN_AGE (2 hours) ago the original code lifts the
// lower bound to `now`, so earliestSigningAt = now + 1 is not below the
// deadline and the call reverts. Without the lift the lower bound stays at
// `revealedAt + 2 hours`, which is in the past, so earliestSigningAt is below
// `now + 1` and the call is wrongly accepted. With 7202 seconds both versions
// accept.
//
// Second mutation (targeted pass of 2026-10-07, slither-mutate MIA): the
// condition at Reservation.sol:565 replaced by `true`, so the lower bound is
// always `now` and the DEPOSIT_MIN_AGE floor is lost. For a fresh deposit and
// an action timeout of 4 hours the original needs a signing time after
// `revealedAt + 2 hours`, which is past the deadline `now + 2 hours`, and
// reverts; the mutant accepts. The two `freshDeposit` tests below pin it.

// The deposit is revealed through the real Bridge.revealDeposit and the
// acceptance request goes through the real Bridge fallback into
// ReservationRouter, using the deployment built by test/fizz/Base.sol. The
// action timeout is changed through `updateReservationParameters` as the
// governance account, the same call the fizz handlers use.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";

contract AcceptanceSigningWindowBoundaryTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    string internal constant ERR_NO_SIGNING_WINDOW =
        "Acceptance authorization has no signing window";

    // REQUEST_TIMEOUT_SAFETY_MARGIN in WalletProposalValidatorConstants.
    uint32 internal constant SAFETY_MARGIN = 2 hours;
    uint256 internal constant DEPOSIT_MIN_AGE = 2 hours;

    address internal depositor;
    bytes20 internal wallet0;
    uint256 internal nonce;

    function setUp() public {
        setup();
        wallet0 = BtcBuilder.pubKeyHash(walletPubX[0], walletPubY[0]);
        depositor = makeAddr("window.depositor");
    }

    /// @notice Action timeout of 7201 seconds and a deposit older than the
    ///         minimum age: the signing deadline is `now + 1`, so no integer
    ///         timestamp fits and the request reverts. The mutant without the
    ///         lower-bound lift accepts here.
    function test_acceptance_revertsWhenActionTimeoutLeavesNoSigningWindow()
        public
    {
        _setActionTimeout(SAFETY_MARGIN + 1);
        (uint256 key, ) = _revealReserved(wallet0);

        // Older than DEPOSIT_MIN_AGE and far from the refund deadline.
        vm.warp(block.timestamp + DEPOSIT_MIN_AGE + 1 hours);

        vm.prank(depositor);
        vm.expectRevert(bytes(ERR_NO_SIGNING_WINDOW));
        reservationRouter.requestReservationAcceptance(key, wallet0);

        assertEq(
            uint256(reservationRouter.reservations(key).requestNonce),
            0,
            "no action generation created"
        );
    }

    /// @notice One second above the boundary (7202 seconds) the same old
    ///         deposit is accepted and the action is `Pending`.
    function test_acceptance_succeedsOneSecondAboveTheBoundary() public {
        _setActionTimeout(SAFETY_MARGIN + 2);
        (uint256 key, ) = _revealReserved(wallet0);

        vm.warp(block.timestamp + DEPOSIT_MIN_AGE + 1 hours);

        vm.prank(depositor);
        reservationRouter.requestReservationAcceptance(key, wallet0);

        uint64 requestNonce = reservationRouter.reservations(key).requestNonce;
        assertEq(uint256(requestNonce), 1, "first action generation");
        Reservation.ReservationAction memory action = reservationRouter
            .reservationActions(key, requestNonce);
        assertEq(
            uint256(uint8(action.state)),
            uint256(uint8(Reservation.ActionState.Pending)),
            "action pending"
        );
        assertEq(
            uint256(action.timeoutAt),
            block.timestamp + uint256(SAFETY_MARGIN) + 2,
            "timeout is now + action timeout"
        );
    }

    /// @notice A deposit younger than the minimum age is also rejected at
    ///         7201 seconds, so that value blocks every acceptance. Both the
    ///         original and the mutant revert here.
    function test_acceptance_revertsAtBoundaryForFreshDeposit() public {
        _setActionTimeout(SAFETY_MARGIN + 1);
        (uint256 key, ) = _revealReserved(wallet0);

        vm.prank(depositor);
        vm.expectRevert(bytes(ERR_NO_SIGNING_WINDOW));
        reservationRouter.requestReservationAcceptance(key, wallet0);
    }

    /// @notice Fresh deposit, action timeout 4 hours: the signing deadline is
    ///         `now + 2 hours` but the deposit is only signable after
    ///         `revealedAt + 2 hours + 1`, so the request reverts. The MIA
    ///         mutant at line 565 drops the minimum-age floor and accepts.
    function test_acceptance_revertsForFreshDepositWhenWindowEndsBeforeMinAge()
        public
    {
        _setActionTimeout(SAFETY_MARGIN + uint32(DEPOSIT_MIN_AGE));
        (uint256 key, ) = _revealReserved(wallet0);

        vm.prank(depositor);
        vm.expectRevert(bytes(ERR_NO_SIGNING_WINDOW));
        reservationRouter.requestReservationAcceptance(key, wallet0);
    }

    /// @notice Two seconds more (4 hours + 2 seconds) leave exactly one
    ///         signing second after the minimum age, so the fresh deposit is
    ///         accepted.
    function test_acceptance_freshDepositAcceptedWhenWindowCoversMinAge()
        public
    {
        _setActionTimeout(SAFETY_MARGIN + uint32(DEPOSIT_MIN_AGE) + 2);
        (uint256 key, ) = _revealReserved(wallet0);

        vm.prank(depositor);
        reservationRouter.requestReservationAcceptance(key, wallet0);
        assertEq(
            uint256(reservationRouter.reservations(key).requestNonce),
            1,
            "first action generation"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Resubmits the current reservation parameters through governance
    ///      with only the action timeout replaced. Word 6 of
    ///      `reservationParameters()` is the running total and is not an
    ///      argument of the setter.
    function _setActionTimeout(uint32 actionTimeout) internal {
        uint256[10] memory w = _reservationParameterWords();
        vm.prank(governance);
        reservationRouter.updateReservationParameters(
            address(uint160(w[0])),
            uint64(w[1]),
            uint64(w[2]),
            uint32(w[3]),
            uint32(w[4]),
            uint64(w[5]),
            uint32(w[7]),
            actionTimeout,
            uint32(w[9])
        );
        assertEq(
            _reservationParameterWords()[8],
            uint256(actionTimeout),
            "timeout set"
        );
    }

    /// @dev The ten static return words of `reservationParameters()`.
    function _reservationParameterWords()
        internal
        view
        returns (uint256[10] memory)
    {
        (bool ok, bytes memory ret) = address(reservationRouter).staticcall(
            abi.encodeWithSelector(
                reservationRouter.reservationParameters.selector
            )
        );
        require(ok, "reservationParameters failed");
        return abi.decode(ret, (uint256[10]));
    }

    /// @dev Reveals an unfunded reserved deposit through the real Bridge and
    ///      returns its key and the exact refund deadline of its script. The
    ///      deadline is 91 days out, far beyond `timeoutAt + 24h`.
    function _revealReserved(bytes20 wallet)
        internal
        returns (uint256 key, uint32 deadline)
    {
        bytes32 entropy = keccak256(abi.encode("window.deposit", ++nonce));
        deadline = uint32(
            block.timestamp + uint256(RESERVATION_TERM_SECONDS) + 1 days
        );
        Deposit.DepositRevealInfo memory reveal = Deposit.DepositRevealInfo({
            fundingOutputIndex: 0,
            blindingFactor: bytes8(keccak256(abi.encode(entropy, "blinding"))),
            walletPubKeyHash: wallet,
            refundPubKeyHash: bytes20(
                keccak256(abi.encode(entropy, depositor, "refund"))
            ),
            refundLocktime: _le32(deadline),
            vault: address(reservationVault)
        });
        (BitcoinTx.Info memory fundingTx, uint32 outputIndex) = BtcBuilder
            .depositFundingTx(
                reveal,
                depositor,
                bytes32(0),
                false,
                uint256(entropy) % 2 == 0,
                50_000,
                entropy
            );
        key = uint256(
            keccak256(
                abi.encodePacked(BtcBuilder.txHash(fundingTx), outputIndex)
            )
        );
        vm.prank(depositor);
        bridge.revealDeposit(fundingTx, reveal);
    }

    function _le32(uint32 v) internal pure returns (bytes4) {
        return
            bytes4(
                (v << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | (v >> 24)
            );
    }
}
