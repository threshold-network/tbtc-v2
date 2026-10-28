// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression guard for a surviving mutant in
// `ReservationProofs.submitReservationReanchorProof`
// (solidity/contracts/bridge/ReservationProofs.sol):
//
//   line 662   prepareReservationForSettlement(self, reservation, late);
//   mutant     the call is commented out.
//
// `prepareReservationForSettlement` (262-304) accepts a Stranded reservation
// only for a late proof and restores the counters that stranding released
// (`reservationTotalAmount`, the wallet count and amount, and
// `activeReservationsCount`). The settlement code then consumes them:
//   - `settleReanchorAccounting` (779-809) subtracts the source wallet count
//     and amount (791-794),
//   - the late branch (700-723) re-takes the target wallet count and amount,
//   - `strandLateSettlementIfTargetWalletClosed` (228-249) releases the
//     position again only when the target wallet is Closing, Closed or
//     Terminated.
// Existing tests exercise the restore only for acceptance proofs. Without the
// call, the source wallet count is already 0 after stranding, so the checked
// subtraction at 791 underflows and the whole proof reverts: the funds-moving
// Bitcoin transaction can never be settled.
//
// Scenario (test/fizz/Base.sol: action timeout 1 day, term 90 days,
// dissolution delay 1 day):
//   1. Active reservation on w0 through a real acceptance proof.
//   2. Governance requests re-anchor N towards the Live wallet w1 and the
//      request times out (`notifyReservationActionTimeout`): the reservation
//      is Active again, the w1 capacity is released, N is TimedOut. A TimedOut
//      Reanchor stays settleable with no time bound (`loadSettleableAction`
//      179-212 bounds late settlement for Acceptance only).
//   3. w0 is pushed to Closing by the permissionless SP-107 route (a non-active
//      Live wallet with a zero main UTXO but count 1 goes to MovingFunds, then
//      `notifyMovingFundsBelowDust` makes it Closing). A Closing wallet is
//      strandable only from `dissolutionEligibleAt` (acceptedAt + term +
//      dissolution delay = 91 days), so the test warps there and calls the
//      permissionless `notifyReservationStranded` (Reservation.sol:1091-1116).
//      The strand needs state Active, which holds because the TimedOut
//      generation left the reservation Active, and it does not look at
//      TimedOut generations. All counters are released and the state is
//      Stranded.
//   4. The wallet's late proof of N (anchor outpoint spent, output paying w1)
//      arrives. `loadSettleableAction` accepts it (TimedOut Reanchor),
//      `requireCurrentSourceAnchor` passes (stranding does not change the
//      anchor fields), and the proof settles.
//
// Two end states, chosen by the state of w1 at proof time:
//   - w1 Live (test 1): the position settles. The reservation is Active on
//     w1, w0 count and amount are 0 (restored by prepare, then released by
//     settlement), w1 holds exactly one position of the new anchor amount,
//     the global active count is 1 and the global amount equals the anchor
//     amount. No second `ReservationStranded` is emitted.
//   - w1 Closing (test 2): the late settlement strands again with
//     `evidenceAlreadyEmitted = true`. The reservation ends Stranded, every
//     counter is back to 0 and no second `ReservationStranded` evidence is
//     emitted.
//
// Both tests PASS on the PR code and FAIL with the call removed (underflow
// revert at the source wallet subtraction). [INFERENCE] for the mutant side,
// derived by reading the code; not run.

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";

contract StrandedLateReanchorSettles is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    uint64 internal constant DEPOSIT_SAT = 50_000;
    uint64 internal constant ACCEPT_FEE_SAT = 500;
    uint64 internal constant ANCHOR_SAT = DEPOSIT_SAT - ACCEPT_FEE_SAT; // 49_500

    address internal constant ANYONE = address(0xA11CE);

    /// @dev w0: setup's wallet (Live, non-active), source of the anchor.
    ///      w1: target of generation N. w2: the active wallet.
    bytes20 internal w0;
    bytes20 internal w1;
    bytes20 internal w2;

    struct Dep {
        uint256 key;
        bytes32 fundingTxHash;
        uint32 outIdx;
    }

    function setUp() public {
        setup();
        w0 = harnessWallets[0];
        w1 = _registerWalletFromKey(1);
        w2 = _registerWalletFromKey(2);
        require(
            bridge.activeWalletPubKeyHash() == w2,
            "StrandedLateReanchor: w2 not active"
        );
    }

    // ------------------------------------------------------------------
    // Tests
    // ------------------------------------------------------------------

    /// @notice Target wallet w1 is Live: the late proof of a stranded
    ///         position settles it on w1 with consistent counters and no
    ///         second stranding evidence.
    function test_strandedPosition_lateReanchorProofSettlesOnLiveTarget()
        public
    {
        (Dep memory d, bytes32 oldAnchorTxHash, uint64 nonceN) = _strandPosition();

        assertEq(
            uint256(uint8(bridge.wallets(w1).state)),
            uint256(uint8(Wallets.WalletState.Live)),
            "w1 Live at proof time"
        );

        vm.recordLogs();
        bytes32 newAnchorTxHash = _proveReanchor(
            oldAnchorTxHash,
            ANCHOR_SAT,
            w1,
            d.key,
            nonceN
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // No second recovery evidence; the late settlement and the reanchor
        // are reported once each; prepare reported the restored occupancy.
        assertEq(
            _countLogs(
                logs,
                keccak256("ReservationStranded(uint256,bytes20,address,uint64)")
            ),
            0,
            "no second ReservationStranded"
        );
        assertEq(
            _countLogs(
                logs,
                keccak256("ReservationLateSettled(uint256,uint64,uint8)")
            ),
            1,
            "ReservationLateSettled emitted once"
        );
        assertEq(
            _countLogs(
                logs,
                keccak256("ReservationReanchored(uint256,uint64,bytes20,bytes32,uint64,uint64)")
            ),
            1,
            "ReservationReanchored emitted once"
        );
        assertEq(
            _countLogs(logs, keccak256("ReservationOccupancyChanged(uint32)")),
            1,
            "occupancy restored once by prepare"
        );

        // Action settled.
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(d.key, nonceN).state)
            ),
            uint256(uint8(Reservation.ActionState.Settled)),
            "N Settled"
        );

        // The position settled on w1.
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(d.key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "Active after the late proof"
        );
        assertTrue(r.walletPubKeyHash == w1, "custodian is w1");
        assertEq(uint256(r.anchorAmount), ANCHOR_SAT, "anchor amount");
        assertEq(uint256(r.mintedAmount), ANCHOR_SAT, "minted amount");
        assertEq(r.anchorTxHash, newAnchorTxHash, "new anchor tx");
        assertEq(uint256(r.anchorTxOutputIndex), 0, "new anchor index");
        assertEq(
            reservationRouter.reservationByAnchorUtxo(newAnchorTxHash, 0),
            d.key,
            "new anchor indexed"
        );
        assertEq(
            reservationRouter.reservationByAnchorUtxo(oldAnchorTxHash, 0),
            0,
            "old anchor stays unindexed"
        );
        assertTrue(
            bridge.spentMainUTXOs(_utxoKey(oldAnchorTxHash)),
            "old anchor recorded as spent"
        );

        // Counters: the source released its restored position, the target
        // holds exactly one position, the global ledgers track one.
        assertEq(_count(w0), 0, "w0 count");
        assertEq(_amount(w0), 0, "w0 amount");
        assertEq(_count(w1), 1, "w1 count");
        assertEq(_amount(w1), ANCHOR_SAT, "w1 amount");
        assertEq(_activeCount(), 1, "active reservations");
        assertEq(_totalAmount(), ANCHOR_SAT, "global amount");
    }

    /// @notice Target wallet w1 left Live before the proof (zero main UTXO
    ///         and count 0, so anyone sends it straight to Closing). The late
    ///         settlement strands the position again with the evidence flag
    ///         set: the reservation ends Stranded on w1, every counter is 0
    ///         and no second `ReservationStranded` is emitted.
    function test_strandedPosition_lateReanchorProofStrandsAgainOnClosingTarget()
        public
    {
        (Dep memory d, bytes32 oldAnchorTxHash, uint64 nonceN) = _strandPosition();

        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        vm.prank(ANYONE);
        bridge.notifyWalletCloseable(w1, none);
        assertEq(
            uint256(uint8(bridge.wallets(w1).state)),
            uint256(uint8(Wallets.WalletState.Closing)),
            "w1 Closing at proof time"
        );

        vm.recordLogs();
        bytes32 newAnchorTxHash = _proveReanchor(
            oldAnchorTxHash,
            ANCHOR_SAT,
            w1,
            d.key,
            nonceN
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            _countLogs(
                logs,
                keccak256("ReservationStranded(uint256,bytes20,address,uint64)")
            ),
            0,
            "no second ReservationStranded"
        );
        assertEq(
            _countLogs(
                logs,
                keccak256("ReservationLateSettled(uint256,uint64,uint8)")
            ),
            1,
            "ReservationLateSettled emitted once"
        );
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(d.key, nonceN).state)
            ),
            uint256(uint8(Reservation.ActionState.Settled)),
            "N Settled"
        );

        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(d.key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Stranded)),
            "Stranded again on the Closing target"
        );
        assertTrue(r.walletPubKeyHash == w1, "custodian is w1");
        assertEq(r.anchorTxHash, newAnchorTxHash, "new anchor tx");
        assertEq(uint256(r.anchorAmount), ANCHOR_SAT, "anchor amount");
        assertEq(
            reservationRouter.reservationByAnchorUtxo(newAnchorTxHash, 0),
            0,
            "new anchor not indexed"
        );
        assertTrue(
            bridge.spentMainUTXOs(_utxoKey(oldAnchorTxHash)),
            "old anchor recorded as spent"
        );

        assertEq(_count(w0), 0, "w0 count");
        assertEq(_amount(w0), 0, "w0 amount");
        assertEq(_count(w1), 0, "w1 count");
        assertEq(_amount(w1), 0, "w1 amount");
        assertEq(_activeCount(), 0, "active reservations");
        assertEq(_totalAmount(), 0, "global amount");
    }

    // ------------------------------------------------------------------
    // Scenario
    // ------------------------------------------------------------------

    /// @dev Steps 1 to 3 of the scenario: Active reservation on w0, a timed
    ///      out re-anchor generation N towards w1, then the reservation is
    ///      stranded because w0 is Closing past `dissolutionEligibleAt`.
    ///      Asserts the counters before and after stranding and returns the
    ///      data the late proof needs.
    function _strandPosition()
        internal
        returns (
            Dep memory d,
            bytes32 oldAnchorTxHash,
            uint64 nonceN
        )
    {
        address depositor = actors[0];

        // Active reservation on w0 through a real acceptance proof.
        d = _reveal(depositor, w0, DEPOSIT_SAT, 31);
        _request(depositor, w0, d.key);
        oldAnchorTxHash = _proveAcceptance(d, w0, ANCHOR_SAT, 1);
        assertEq(
            uint256(uint8(reservationRouter.reservations(d.key).state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "Active before the re-anchor"
        );

        // Generation N: governance rotates the anchor of the Live wallet w0
        // to w1.
        vm.prank(governance);
        reservationRouter.requestReservationReanchor(d.key, w1);
        nonceN = reservationRouter.reservations(d.key).requestNonce;
        assertEq(uint256(nonceN), 2, "N is the second generation");
        uint32 timeoutAtN = reservationRouter
            .reservationActions(d.key, nonceN)
            .timeoutAt;

        // N times out; w1 capacity is released, the reservation is Active.
        vm.warp(timeoutAtN);
        vm.prank(ANYONE);
        reservationRouter.notifyReservationActionTimeout(d.key);
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(d.key, nonceN).state)
            ),
            uint256(uint8(Reservation.ActionState.TimedOut)),
            "N TimedOut"
        );
        assertEq(
            uint256(uint8(reservationRouter.reservations(d.key).state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "Active after the timeout"
        );
        assertEq(_count(w1), 0, "timeout released w1 count");
        assertEq(_amount(w1), 0, "timeout released w1 amount");

        // Counters P before stranding: one position on w0, none on w1.
        assertEq(_count(w0), 1, "P: w0 count");
        assertEq(_amount(w0), ANCHOR_SAT, "P: w0 amount");
        assertEq(_activeCount(), 1, "P: active reservations");
        assertEq(_totalAmount(), ANCHOR_SAT, "P: global amount");

        // w0 becomes Closing (SP-107 route) and, once the reservation is
        // dissolution eligible, anyone strands it.
        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        vm.prank(ANYONE);
        bridge.notifyWalletCloseable(w0, none);
        vm.prank(ANYONE);
        bridge.notifyMovingFundsBelowDust(w0, none);
        assertEq(
            uint256(uint8(bridge.wallets(w0).state)),
            uint256(uint8(Wallets.WalletState.Closing)),
            "w0 Closing"
        );

        vm.warp(reservationRouter.reservations(d.key).dissolutionEligibleAt);
        vm.prank(ANYONE);
        reservationRouter.notifyReservationStranded(d.key);
        assertEq(
            uint256(uint8(reservationRouter.reservations(d.key).state)),
            uint256(uint8(Reservation.ReservationState.Stranded)),
            "Stranded"
        );
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(d.key, nonceN).state)
            ),
            uint256(uint8(Reservation.ActionState.TimedOut)),
            "N still TimedOut (late) after stranding"
        );

        // Stranding released every counter and the anchor index.
        assertEq(_count(w0), 0, "stranded: w0 count");
        assertEq(_amount(w0), 0, "stranded: w0 amount");
        assertEq(_count(w1), 0, "stranded: w1 count");
        assertEq(_amount(w1), 0, "stranded: w1 amount");
        assertEq(_activeCount(), 0, "stranded: active reservations");
        assertEq(_totalAmount(), 0, "stranded: global amount");
        assertEq(
            reservationRouter.reservationByAnchorUtxo(oldAnchorTxHash, 0),
            0,
            "stranded: anchor index released"
        );
        assertFalse(
            bridge.spentMainUTXOs(_utxoKey(oldAnchorTxHash)),
            "stranded: anchor not yet spent"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Counts bridge logs whose first topic is `topic0`.
    function _countLogs(Vm.Log[] memory logs, bytes32 topic0)
        internal
        view
        returns (uint256 n)
    {
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter == address(bridge) &&
                logs[i].topics.length > 0 &&
                logs[i].topics[0] == topic0
            ) {
                n++;
            }
        }
    }

    function _reveal(
        address depositor,
        bytes20 wallet,
        uint64 amount,
        uint256 salt
    ) internal returns (Dep memory d) {
        Deposit.DepositRevealInfo memory reveal = Deposit.DepositRevealInfo({
            fundingOutputIndex: uint32(salt % 4),
            blindingFactor: bytes8(keccak256(abi.encode(salt, "blinding"))),
            walletPubKeyHash: wallet,
            refundPubKeyHash: bytes20(keccak256(abi.encode(salt, "refund"))),
            refundLocktime: _le32(uint32(block.timestamp + 4 days)),
            vault: address(reservationVault)
        });
        BitcoinTx.Info memory fundingTx;
        (fundingTx, d.outIdx) = BtcBuilder.depositFundingTx(
            reveal,
            depositor,
            bytes32(0),
            false,
            true,
            amount,
            keccak256(abi.encode("StrandedLateReanchor", salt))
        );
        d.fundingTxHash = BtcBuilder.txHash(fundingTx);
        d.key = uint256(keccak256(abi.encodePacked(d.fundingTxHash, d.outIdx)));
        vm.prank(depositor);
        bridge.revealDeposit(fundingTx, reveal);
    }

    function _request(
        address depositor,
        bytes20 wallet,
        uint256 key
    ) internal {
        vm.prank(depositor);
        reservationRouter.requestReservationAcceptance(key, wallet);
    }

    /// @dev Proves the 1-input (deposit outpoint) 1-output (wallet) anchor
    ///      transaction of generation `nonce` as the SPV maintainer.
    function _proveAcceptance(
        Dep memory d,
        bytes20 wallet,
        uint64 anchorValue,
        uint64 nonce
    ) internal returns (bytes32 anchorTxHash) {
        BitcoinTx.Info memory t = _singleOutputTx(
            d.fundingTxHash,
            d.outIdx,
            anchorValue,
            wallet
        );
        anchorTxHash = BtcBuilder.txHash(t);
        // Build the proof before the prank: BtcBuilder calls the sha256
        // precompile, which would consume a pending vm.prank.
        BitcoinTx.Proof memory proof = BtcBuilder.prove(t, 1);
        vm.prank(spvMaintainer);
        reservationRouter.submitReservationAcceptanceProof(
            t,
            proof,
            d.key,
            nonce
        );
    }

    /// @dev Proves the 1-input (current anchor) 1-output (target wallet)
    ///      reanchor transaction of generation `nonce` as the SPV maintainer.
    function _proveReanchor(
        bytes32 prevAnchorTxHash,
        uint64 value,
        bytes20 target,
        uint256 key,
        uint64 nonce
    ) internal returns (bytes32 newAnchorTxHash) {
        BitcoinTx.Info memory t = _singleOutputTx(
            prevAnchorTxHash,
            0,
            value,
            target
        );
        newAnchorTxHash = BtcBuilder.txHash(t);
        BitcoinTx.Proof memory proof = BtcBuilder.prove(t, 1);
        vm.prank(spvMaintainer);
        reservationRouter.submitReservationReanchorProof(
            t,
            proof,
            key,
            nonce
        );
    }

    function _count(bytes20 wallet) internal view returns (uint256) {
        return uint256(reservationRouter.walletReservationsCount(wallet));
    }

    function _amount(bytes20 wallet) internal view returns (uint256) {
        return uint256(reservationRouter.walletReservationsAmount(wallet));
    }

    function _activeCount() internal view returns (uint256) {
        (uint32 count, ) = reservationRouter.activeReservationsCount();
        return count;
    }

    function _totalAmount() internal view returns (uint256 total) {
        (, , , , , , uint64 reservationTotalAmount, , , ) = reservationRouter
            .reservationParameters();
        total = reservationTotalAmount;
    }

    function _utxoKey(bytes32 txHash) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(txHash, uint32(0))));
    }

    function _singleOutputTx(
        bytes32 prevTxHash,
        uint32 prevOutIndex,
        uint64 value,
        bytes20 walletPkh
    ) internal pure returns (BitcoinTx.Info memory) {
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](1);
        ins[0] = BtcBuilder.TxIn({
            prevTxHash: prevTxHash,
            prevOutIndex: prevOutIndex
        });
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](1);
        outs[0] = BtcBuilder.TxOut({
            value: value,
            script: BtcBuilder.p2wpkh(walletPkh)
        });
        return BtcBuilder.buildTx(ins, outs);
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
