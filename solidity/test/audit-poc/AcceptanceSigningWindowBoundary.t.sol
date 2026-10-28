// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for R-50: `updateReservationParameters` accepted any
// `reservationActionTimeout` above REQUEST_TIMEOUT_SAFETY_MARGIN (2 hours).
// `requestReservationAcceptance` (Reservation.sol:555-576) sets
//   timeoutAt = now + reservationActionTimeout
//   earliestSigningAt = max(revealedAt + DEPOSIT_MIN_AGE, now) + 1
//   actionSigningDeadline = timeoutAt - REQUEST_TIMEOUT_SAFETY_MARGIN
// and requires earliestSigningAt < actionSigningDeadline. At 7201 seconds no
// request can sign, and up to 4 hours + 1 second a deposit revealed in the
// request block cannot. The setter now requires a timeout above
// SAFETY_MARGIN + DEPOSIT_MIN_AGE + 1 (14,401 seconds).
//
// Before the fix, both `test_setter_rejects*` tests fail (the setter accepts
// the value). After it, the in-function window checks are defense in depth:
// no stored timeout can reach them, so the earlier mutation guards of this
// file (lower-bound lift at :567, MIA at :565) became equivalent mutants and
// were replaced by these tests.
//
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

    string internal constant ERR_SETTER =
        "Reservation action timeout leaves no signing window";

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

    /// @notice R-50: 7201 seconds passed the old setter check and made every
    ///         acceptance and re-anchor request revert. The setter now
    ///         rejects it.
    function test_setter_rejectsSafetyMarginPlusOne() public {
        _expectSetterRevert(SAFETY_MARGIN + 1);
    }

    /// @notice R-50 boundary: 4 hours + 1 second leaves a deposit revealed
    ///         in the request block no signing second, so the setter rejects
    ///         it.
    function test_setter_rejectsTimeoutWithNoWindowForFreshDeposit() public {
        _expectSetterRevert(SAFETY_MARGIN + uint32(DEPOSIT_MIN_AGE) + 1);
    }

    /// @notice The smallest accepted timeout (4 hours + 2 seconds) leaves a
    ///         deposit revealed in the request block exactly one signing
    ///         second, so its acceptance request succeeds.
    function test_setter_smallestTimeoutAcceptsFreshDeposit() public {
        _setActionTimeout(SAFETY_MARGIN + uint32(DEPOSIT_MIN_AGE) + 2);
        (uint256 key, ) = _revealReserved(wallet0);

        _requestAcceptanceAs(depositor, key, wallet0);

        uint64 requestNonce = reservationRouter.reservations(key).requestNonce;
        assertEq(uint256(requestNonce), 1, "first action generation");
        Reservation.ReservationAction memory action = reservationRouter
            .reservationActions(key, requestNonce);
        assertEq(
            uint256(uint8(action.state)),
            uint256(uint8(Reservation.ActionState.Pending)),
            "action pending"
        );
    }

    /// @notice At the smallest accepted timeout an older deposit is also
    ///         accepted: no admissible setting leaves it without a window.
    function test_setter_smallestTimeoutAcceptsOldDeposit() public {
        _setActionTimeout(SAFETY_MARGIN + uint32(DEPOSIT_MIN_AGE) + 2);
        (uint256 key, ) = _revealReserved(wallet0);
        vm.warp(block.timestamp + DEPOSIT_MIN_AGE + 1 hours);

        _requestAcceptanceAs(depositor, key, wallet0);
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

    /// @dev Same call as `_setActionTimeout`, expected to revert with the
    ///      R-50 setter message and leave the stored timeout unchanged. The
    ///      current words are read before `expectRevert`, which applies to
    ///      the next call only.
    function _expectSetterRevert(uint32 actionTimeout) internal {
        uint256[10] memory w = _reservationParameterWords();
        vm.prank(governance);
        vm.expectRevert(bytes(ERR_SETTER));
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
            w[8],
            "stored timeout unchanged"
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
    function _revealReserved(
        bytes20 wallet
    ) internal returns (uint256 key, uint32 deadline) {
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
        _recordFunding(key, fundingTx, outputIndex);
    }

    function _le32(uint32 v) internal pure returns (bytes4) {
        return
            bytes4(
                (v << 24) |
                    ((v & 0xff00) << 8) |
                    ((v >> 8) & 0xff00) |
                    (v >> 24)
            );
    }
}
