// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression test for the mutation that comments out
// `emit ReservationOccupancyChanged(self.activeReservationsCount);`
// at contracts/bridge/ReservationProofs.sol:534, in the late branch of
// `settleAcceptance` (called from `submitReservationAcceptanceProof`).
// Before this file no Foundry or Hardhat test checked the event on this path,
// so the mutant survived.
//
// Source lines involved (solidity/contracts/bridge):
//   Reservation.sol:656-692        notifyReservationAcceptanceTimedOut: marks
//                                  the acceptance `TimedOut` and releases the
//                                  wallet count and amount, the reserved
//                                  total and the global occupancy
//   ReservationProofs.sol:179-212  loadSettleableAction: a timed-out
//                                  acceptance stays settleable until
//                                  `timeoutAt + termSeconds`
//   ReservationProofs.sol:519-539  late branch of settleAcceptance: re-takes
//                                  the reserved total, the wallet count and
//                                  amount and the occupancy, then emits
//                                  `ReservationOccupancyChanged` (534) and
//                                  `ReservationLateSettled` (535)
//
// Off-chain occupancy trackers rely on `ReservationOccupancyChanged` to see
// the slot that the timeout freed being taken again. Without the event the
// tracker keeps showing one free slot while `activeReservationsCount` is 1.
//
// The flow uses the real Bridge.revealDeposit and the real Bridge fallback
// into ReservationRouter, with the deployment built by test/fizz/Base.sol.
// The proof is a one-header SPV proof (the relay difficulty is configured by
// `setup()`) submitted as the SPV maintainer, as in
// AcceptanceProofUntrustedVault.t.sol.
//
// Second mutation (targeted slither-mutate pass of 2026-10-07, operator
// ROR): `newer.state == Reservation.ActionState.Pending` at
// ReservationProofs.sol:514 becomes `>= Pending`. Then a late proof of an
// older generation also tries to unwind a newer generation that has already
// timed out, and `unwindPendingAction` reverts ("No pending action to
// unwind", line 831-834). The original settles. Pinned by
// `test_lateAcceptanceProof_settlesWhenNewerGenerationAlsoTimedOut`.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";

contract LateAcceptanceOccupancyTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    // Same signatures as Reservation.sol:404 and ReservationRouter.sol:156,192.
    // Declared here so `vm.expectEmit` can name them.
    event ReservationOccupancyChanged(uint32 activeReservationsCount);

    event ReservationLateSettled(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionType
    );

    uint64 internal constant DEPOSIT_SAT = 50_000;
    /// @dev Miner fee of the anchor transaction; within the fizz suite's
    ///      reservation tx max fee of 1_000 sat (test/fizz/Base.sol).
    uint64 internal constant ANCHOR_FEE_SAT = 500;
    uint64 internal constant ANCHOR_SAT = DEPOSIT_SAT - ANCHOR_FEE_SAT;

    struct Counters {
        uint32 walletCount;
        uint64 walletAmount;
        uint64 reservedTotal;
        uint32 occupancy;
    }

    address internal depositor;
    address internal anyone;
    bytes20 internal wallet0;
    uint256 internal nonce;

    function setUp() public {
        setup();
        wallet0 = BtcBuilder.pubKeyHash(walletPubX[0], walletPubY[0]);
        depositor = makeAddr("lateacceptance.depositor");
        anyone = makeAddr("lateacceptance.anyone");
    }

    /// @notice One reserved deposit is requested, times out and is notified
    ///         (occupancy drops back). The wallet's acceptance proof then
    ///         arrives inside the late window. The proof succeeds, re-takes
    ///         the capacity and emits `ReservationOccupancyChanged` with the
    ///         new count, followed by `ReservationLateSettled`.
    function test_lateAcceptanceProof_retakesOccupancyAndEmitsEvent() public {
        Counters memory baseline = _counters(wallet0);

        (
            uint256 key,
            BitcoinTx.Info memory fundingTx,
            uint32 outputIndex
        ) = _revealReserved(wallet0);

        uint64 requestNonce = _requestAndTimeOut(key, baseline);

        (
            BitcoinTx.Info memory anchorTx,
            BitcoinTx.Proof memory proof
        ) = _anchorTx(fundingTx, outputIndex, wallet0);

        // The occupancy event carries the re-taken count, then the late
        // settlement event follows. Both come from the bridge address, the
        // delegatecall context of the router.
        vm.expectEmit(false, false, false, true, address(bridge));
        emit ReservationOccupancyChanged(baseline.occupancy + 1);
        vm.expectEmit(true, false, false, true, address(bridge));
        emit ReservationLateSettled(
            key,
            requestNonce,
            Reservation.ActionType.Acceptance
        );
        vm.prank(spvMaintainer);
        reservationRouter.submitReservationAcceptanceProof(
            anchorTx,
            proof,
            key,
            requestNonce
        );

        _assertRetaken(key, requestNonce, baseline);
    }

    /// @notice Two generations of the same deposit time out, then the proof
    ///         of the first arrives late. The newer generation already
    ///         released its capacity, so nothing is unwound
    ///         (ReservationProofs.sol:500-516) and the proof settles the first
    ///         generation. The newer one stays TimedOut.
    function test_lateAcceptanceProof_settlesWhenNewerGenerationAlsoTimedOut()
        public
    {
        Counters memory baseline = _counters(wallet0);

        (
            uint256 key,
            BitcoinTx.Info memory fundingTx,
            uint32 outputIndex
        ) = _revealReserved(wallet0);

        uint64 first = _requestAndTimeOut(key, baseline);
        uint64 second = _requestAndTimeOut(key, baseline);
        assertEq(uint256(second), uint256(first) + 1, "second generation");

        (
            BitcoinTx.Info memory anchorTx,
            BitcoinTx.Proof memory proof
        ) = _anchorTx(fundingTx, outputIndex, wallet0);
        vm.prank(spvMaintainer);
        reservationRouter.submitReservationAcceptanceProof(
            anchorTx,
            proof,
            key,
            first
        );

        _assertRetaken(key, first, baseline);
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(key, second).state)
            ),
            uint256(uint8(Reservation.ActionState.TimedOut)),
            "newer generation stays TimedOut"
        );
    }

    /// @dev Requests acceptance of `key`, warps to `timeoutAt`, reports the
    ///      timeout and checks that the capacity was released. Leaves the
    ///      clock inside the late settlement window.
    function _requestAndTimeOut(uint256 key, Counters memory baseline)
        internal
        returns (uint64 requestNonce)
    {
        vm.prank(depositor);
        reservationRouter.requestReservationAcceptance(key, wallet0);
        requestNonce = reservationRouter.reservations(key).requestNonce;
        Reservation.ReservationAction memory action = reservationRouter
            .reservationActions(key, requestNonce);
        assertEq(
            uint256(uint8(action.state)),
            uint256(uint8(Reservation.ActionState.Pending)),
            "acceptance pending"
        );
        assertEq(
            uint256(_counters(wallet0).occupancy),
            uint256(baseline.occupancy) + 1,
            "request takes one occupancy slot"
        );

        // Time out the acceptance. The capacity is released.
        vm.warp(uint256(action.timeoutAt));
        vm.prank(anyone);
        reservationRouter.notifyReservationAcceptanceTimedOut(key);
        assertEq(
            uint256(
                uint8(
                    reservationRouter.reservationActions(key, requestNonce).state
                )
            ),
            uint256(uint8(Reservation.ActionState.TimedOut)),
            "acceptance timed out"
        );

        Counters memory released = _counters(wallet0);
        assertEq(
            uint256(released.occupancy),
            uint256(baseline.occupancy),
            "timeout releases the occupancy slot"
        );
        assertEq(
            uint256(released.walletCount),
            uint256(baseline.walletCount),
            "timeout releases the wallet count"
        );
        assertEq(
            uint256(released.walletAmount),
            uint256(baseline.walletAmount),
            "timeout releases the wallet amount"
        );
        assertEq(
            uint256(released.reservedTotal),
            uint256(baseline.reservedTotal),
            "timeout releases the reserved total"
        );
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.Unknown)),
            "position is still Unknown after the timeout"
        );

        // Still inside the late window: `timeoutAt + termSeconds`.
        assertTrue(
            block.timestamp <= uint256(action.timeoutAt) + action.termSeconds,
            "inside the late settlement window"
        );
    }

    /// @dev After the late proof: occupancy, wallet exposure and the reserved
    ///      total are re-taken for the actual anchor value, and the
    ///      reservation is Active.
    function _assertRetaken(
        uint256 key,
        uint64 requestNonce,
        Counters memory baseline
    ) internal {
        Counters memory settled = _counters(wallet0);
        assertEq(
            uint256(settled.occupancy),
            uint256(baseline.occupancy) + 1,
            "late settlement re-takes the occupancy slot"
        );
        assertEq(
            uint256(settled.walletCount),
            uint256(baseline.walletCount) + 1,
            "wallet count re-taken"
        );
        assertEq(
            uint256(settled.walletAmount),
            uint256(baseline.walletAmount) + uint256(ANCHOR_SAT),
            "wallet amount re-taken at the anchor value"
        );
        assertEq(
            uint256(settled.reservedTotal),
            uint256(baseline.reservedTotal) + uint256(ANCHOR_SAT),
            "reserved total re-taken at the anchor value"
        );

        Reservation.ReservationRequest memory reservation = reservationRouter
            .reservations(key);
        assertEq(
            uint256(uint8(reservation.state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "reservation is Active"
        );
        assertEq(
            uint256(reservation.anchorAmount),
            uint256(ANCHOR_SAT),
            "reservation anchored at the proven amount"
        );
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(key, requestNonce).state)
            ),
            uint256(uint8(Reservation.ActionState.Settled)),
            "acceptance action is Settled"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Reads the wallet exposure (count and amount), the global
    ///      reserved total and the global occupancy from the router getters.
    function _counters(bytes20 wallet) internal view returns (Counters memory c) {
        c.walletCount = reservationRouter.walletReservationsCount(wallet);
        c.walletAmount = reservationRouter.walletReservationsAmount(wallet);
        c.reservedTotal = uint64(_reservationParameterWords()[6]);
        (c.occupancy, ) = reservationRouter.activeReservationsCount();
    }

    /// @dev The ten static return words of `reservationParameters()`. Word 6
    ///      is the running reserved total.
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

    /// @dev Reveals a reserved deposit through the real Bridge and returns
    ///      its key and funding transaction. The refund deadline is 91 days
    ///      out, beyond `timeoutAt + 24h`. The funding transaction is
    ///      fabricated: nothing is proven on Bitcoin.
    function _revealReserved(bytes20 wallet)
        internal
        returns (
            uint256 key,
            BitcoinTx.Info memory fundingTx,
            uint32 outputIndex
        )
    {
        bytes32 entropy = keccak256(
            abi.encode("lateacceptance.deposit", ++nonce)
        );
        uint32 deadline = uint32(
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
        (fundingTx, outputIndex) = BtcBuilder.depositFundingTx(
            reveal,
            depositor,
            bytes32(0),
            false,
            true,
            DEPOSIT_SAT,
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

    /// @dev Builds the 1-in-1-out anchor transaction spending the deposit
    ///      funding output and a one-header SPV proof for it.
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
                (v << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | (v >> 24)
            );
    }
}
