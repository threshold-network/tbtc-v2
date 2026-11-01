// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for two time bounds that no Foundry or Hardhat test checked
// before the mutation pass of 2026-10-08. Each mutant survived both suites.
//
// 1. Deposit.sol:235-253 (`_revealDeposit`, reserved path). A reserved deposit
//    must have a refund locktime at most `now + reservationTermSeconds +
//    DEPOSIT_REFUND_SAFETY_MARGIN` ("Refund locktime too far in the future for
//    a reservation"), so a deposit that is never anchored can always clear
//    itself and cannot park `pendingReservedDeposits` (which blocks a vault
//    change) forever. Mutant: `if (isReserved)` at line 235 becomes
//    `if (false)` (slither-mutate MIA), which drops the cap.
// 2. ReservationProofs.sol:199-211 (`loadSettleableAction`). A timed-out
//    acceptance may be settled late only until `timeoutAt + termSeconds`
//    ("Late acceptance settlement window expired", the M15 deferral bound).
//    Mutant: `timeoutAt + termSeconds` becomes `timeoutAt * termSeconds`
//    (slither-mutate AOR), which removes the bound in practice.
//
// Both flows use the real Bridge.revealDeposit and the Bridge fallback into
// ReservationRouter on the deployment built by test/fizz/Base.sol
// (reveal-ahead period 1 day, reservation term 90 days).

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";

contract ReservationTimeBoundsTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    string internal constant ERR_LOCKTIME =
        "Refund locktime too far in the future for a reservation";
    string internal constant ERR_LATE_WINDOW =
        "Late acceptance settlement window expired";

    uint64 internal constant DEPOSIT_SAT = 50_000;
    uint64 internal constant ANCHOR_SAT = DEPOSIT_SAT - 500;
    // DEPOSIT_REFUND_SAFETY_MARGIN in WalletProposalValidatorConstants.
    uint256 internal constant REFUND_MARGIN = 24 hours;

    address internal depositor;
    bytes20 internal wallet0;
    uint256 internal nonce;

    function setUp() public {
        setup();
        wallet0 = BtcBuilder.pubKeyHash(walletPubX[0], walletPubY[0]);
        depositor = makeAddr("timebounds.depositor");
    }

    // ------------------------------------------------------------------
    // Reserved reveal: refund locktime cap
    // ------------------------------------------------------------------

    /// @notice One second past `now + term + 24h` the reserved reveal
    ///         reverts. The mutant without the cap accepts it.
    function test_reservedReveal_rejectsLocktimeOneSecondPastCap() public {
        uint32 deadline = uint32(
            block.timestamp +
                uint256(RESERVATION_TERM_SECONDS) +
                REFUND_MARGIN +
                1
        );
        (
            BitcoinTx.Info memory fundingTx,
            Deposit.DepositRevealInfo memory reveal,

        ) = _buildReserved(deadline);
        vm.prank(depositor);
        vm.expectRevert(bytes(ERR_LOCKTIME));
        bridge.revealDeposit(fundingTx, reveal);
    }

    /// @notice Exactly at the cap the reserved reveal is accepted and marked
    ///         as reserved.
    function test_reservedReveal_acceptsLocktimeAtCap() public {
        uint32 deadline = uint32(
            block.timestamp + uint256(RESERVATION_TERM_SECONDS) + REFUND_MARGIN
        );
        (
            BitcoinTx.Info memory fundingTx,
            Deposit.DepositRevealInfo memory reveal,
            uint256 key
        ) = _buildReserved(deadline);
        vm.prank(depositor);
        bridge.revealDeposit(fundingTx, reveal);
        assertTrue(bridge.isReservedDeposit(key), "recorded as reserved");
    }

    // ------------------------------------------------------------------
    // Late acceptance settlement window
    // ------------------------------------------------------------------

    /// @notice One second after `timeoutAt + termSeconds` the late proof of a
    ///         timed-out acceptance reverts. The mutant accepts it.
    function test_lateAcceptanceProof_rejectedAfterWindow() public {
        (
            uint256 key,
            uint64 requestNonce,
            BitcoinTx.Info memory anchorTx,
            BitcoinTx.Proof memory proof,
            uint256 windowEnd
        ) = _timedOutAcceptance();

        vm.warp(windowEnd + 1);
        vm.prank(spvMaintainer);
        vm.expectRevert(bytes(ERR_LATE_WINDOW));
        reservationRouter.submitReservationAcceptanceProof(
            anchorTx,
            proof,
            key,
            requestNonce
        );
    }

    /// @notice At exactly `timeoutAt + termSeconds` the late proof still
    ///         settles the acceptance.
    function test_lateAcceptanceProof_settlesAtWindowEnd() public {
        (
            uint256 key,
            uint64 requestNonce,
            BitcoinTx.Info memory anchorTx,
            BitcoinTx.Proof memory proof,
            uint256 windowEnd
        ) = _timedOutAcceptance();

        vm.warp(windowEnd);
        vm.prank(spvMaintainer);
        reservationRouter.submitReservationAcceptanceProof(
            anchorTx,
            proof,
            key,
            requestNonce
        );
        assertEq(
            uint256(
                uint8(
                    reservationRouter
                        .reservationActions(key, requestNonce)
                        .state
                )
            ),
            uint256(uint8(Reservation.ActionState.Settled)),
            "settled at the window end"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Reveals a reserved deposit (91-day locktime), requests its
    ///      acceptance, lets it time out and reports the timeout. Returns
    ///      the anchor transaction and the end of the late window.
    function _timedOutAcceptance()
        internal
        returns (
            uint256 key,
            uint64 requestNonce,
            BitcoinTx.Info memory anchorTx,
            BitcoinTx.Proof memory proof,
            uint256 windowEnd
        )
    {
        uint32 deadline = uint32(
            block.timestamp + uint256(RESERVATION_TERM_SECONDS) + 1 days
        );
        BitcoinTx.Info memory fundingTx;
        Deposit.DepositRevealInfo memory reveal;
        (fundingTx, reveal, key) = _buildReserved(deadline);
        vm.prank(depositor);
        bridge.revealDeposit(fundingTx, reveal);
        _recordFunding(key, fundingTx, reveal.fundingOutputIndex);

        _requestAcceptanceAs(depositor, key, wallet0);
        requestNonce = reservationRouter.reservations(key).requestNonce;
        Reservation.ReservationAction memory action = reservationRouter
            .reservationActions(key, requestNonce);

        vm.warp(uint256(action.timeoutAt));
        reservationRouter.notifyReservationAcceptanceTimedOut(key);
        assertEq(
            uint256(
                uint8(
                    reservationRouter
                        .reservationActions(key, requestNonce)
                        .state
                )
            ),
            uint256(uint8(Reservation.ActionState.TimedOut)),
            "acceptance timed out"
        );

        windowEnd = uint256(action.timeoutAt) + uint256(action.termSeconds);
        (anchorTx, proof) = _anchorTx(
            fundingTx,
            reveal.fundingOutputIndex,
            wallet0
        );
    }

    function _buildReserved(
        uint32 deadline
    )
        internal
        returns (
            BitcoinTx.Info memory fundingTx,
            Deposit.DepositRevealInfo memory reveal,
            uint256 key
        )
    {
        bytes32 entropy = keccak256(abi.encode("timebounds.deposit", ++nonce));
        reveal = Deposit.DepositRevealInfo({
            fundingOutputIndex: 0,
            blindingFactor: bytes8(keccak256(abi.encode(entropy, "blinding"))),
            walletPubKeyHash: wallet0,
            refundPubKeyHash: bytes20(
                keccak256(abi.encode(entropy, depositor, "refund"))
            ),
            refundLocktime: _le32(deadline),
            vault: address(reservationVault)
        });
        uint32 outputIndex;
        (fundingTx, outputIndex) = BtcBuilder.depositFundingTx(
            reveal,
            depositor,
            bytes32(0),
            false,
            true,
            DEPOSIT_SAT,
            entropy
        );
        reveal.fundingOutputIndex = outputIndex;
        key = uint256(
            keccak256(
                abi.encodePacked(BtcBuilder.txHash(fundingTx), outputIndex)
            )
        );
    }

    function _anchorTx(
        BitcoinTx.Info memory fundingTx,
        uint32 outputIndex,
        bytes20 wallet
    )
        internal
        pure
        returns (BitcoinTx.Info memory anchorTx, BitcoinTx.Proof memory proof)
    {
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](1);
        ins[0] = BtcBuilder.TxIn({
            prevTxHash: BtcBuilder.txHash(fundingTx),
            prevOutIndex: outputIndex
        });
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](1);
        outs[0] = BtcBuilder.TxOut({
            value: ANCHOR_SAT,
            script: BtcBuilder.p2wpkh(wallet)
        });
        anchorTx = BtcBuilder.buildTx(ins, outs);
        proof = BtcBuilder.prove(anchorTx, 1);
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
