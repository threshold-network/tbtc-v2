// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression guard for a surviving mutant in
// `ReservationProofs.submitReservationReanchorProof`
// (solidity/contracts/bridge/ReservationProofs.sol):
//
//   line 714   unwindPendingAction(self, reservation, reservationKey, true);
//   mutant     revert();
//
// The line sits in the late branch (700-723). A late proof of an older,
// timed-out re-anchor generation N lands while a newer generation N+1 is
// pending (`reservation.state == ActionPending`). The proof of N spends the
// anchor outpoint that N+1 was authorized to spend, so N+1 can never settle.
// `unwindPendingAction` (819-859) must therefore:
//   - mark N+1 `Superseded`,
//   - release the target capacity N+1 reserved at request time
//     (`Reservation.releaseReanchorTargetCapacity`, Reservation.sol:977-984),
//   - emit `ReservationActionSuperseded(reservationKey, N+1)`.
// With the mutant the whole proof reverts, so the funds-moving Bitcoin
// transaction can never be settled on chain while N+1 is pending.
//
// Source lines involved:
//   Reservation.sol:723-859   requestReservationReanchor (governance may
//                             rotate a Live source wallet and bypasses the
//                             cooldown, 737-742 and 749-753)
//   Reservation.sol:861-915   notifyReservationActionTimeout (target
//                             capacity released, state back to Active,
//                             cooldown = timeoutAt - requestedAt, 906-909)
//   ReservationProofs.sol:179-212  loadSettleableAction (a TimedOut
//                             Reanchor stays settleable with no time bound:
//                             the late-window check at 204-211 applies to
//                             Acceptance only)
//
// Timing (test/fizz/Base.sol: action timeout 1 day), with T0 the time of
// the request of generation N:
//   timeoutAt(N)         = T0 + 1 day
//   cooldown end         = timeoutAt(N) + 1 day   (notify at timeoutAt(N))
//   request of N+1       = cooldown end           (so the scenario also
//                                                  holds for a non-governance
//                                                  caller on a non-Live
//                                                  source, cooldown elapsed)
//   late proof of N      = request of N+1 + 1 hour, inside the window of N+1
//   late window of N     = unbounded (no upper limit for Reanchor)
// The late window is therefore longer than the cooldown and the scenario is
// reachable; the mutant is not equivalent.
//
// Every test PASSES when the PR behaviour is observed and FAILS on the
// mutant.

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";

contract LateReanchorUnwindsNewerGeneration is Test, Handlers {
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
    ///      w1: target of generation N. w2: active wallet, target of N+1 in
    ///      the main test.
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
            "LateReanchorUnwind: w2 not active"
        );
    }

    // ------------------------------------------------------------------
    // Tests
    // ------------------------------------------------------------------

    /// @notice N targets w1 and times out; N+1 targets a third wallet w2.
    ///         The late proof of N must succeed, unwind N+1 (Superseded,
    ///         w2 capacity back to its pre-request value, event emitted)
    ///         and leave the reservation Active on w1 with the new anchor.
    function test_lateReanchorProof_unwindsNewerPendingGeneration() public {
        _runScenario(w2);
    }

    /// @notice Same as above but N+1 targets the same wallet w1 as N. The
    ///         late proof re-takes one position on w1 and the unwind
    ///         releases the other, so w1 ends with exactly one position of
    ///         the new anchor amount.
    function test_lateReanchorProof_unwindsNewerPendingGeneration_sameTarget()
        public
    {
        _runScenario(w1);
    }

    // ------------------------------------------------------------------
    // Scenario
    // ------------------------------------------------------------------

    function _runScenario(bytes20 newerTarget) internal {
        address depositor = actors[0];

        // Active reservation on w0 through a real acceptance proof.
        Dep memory d = _reveal(depositor, w0, DEPOSIT_SAT, 21);
        _request(depositor, w0, d.key);
        bytes32 oldAnchorTxHash = _proveAcceptance(d, w0, ANCHOR_SAT, 1);
        assertEq(
            uint256(uint8(reservationRouter.reservations(d.key).state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "Active before the first re-anchor"
        );

        // Generation N: governance rotates the anchor of the Live wallet w0
        // to w1.
        vm.prank(governance);
        reservationRouter.requestReservationReanchor(d.key, w1);
        uint64 nonceN = reservationRouter.reservations(d.key).requestNonce;
        assertEq(uint256(nonceN), 2, "N is the second generation");
        uint32 timeoutAtN = reservationRouter
            .reservationActions(d.key, nonceN)
            .timeoutAt;
        assertEq(_count(w1), 1, "N reserved w1 count");
        assertEq(_amount(w1), ANCHOR_SAT, "N reserved w1 amount");

        // N times out; anyone reports it. w1 capacity is released, the
        // reservation is Active again and the cooldown is set.
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
        assertEq(_count(w1), 0, "timeout released w1 count");
        assertEq(_amount(w1), 0, "timeout released w1 amount");
        uint32 cooldownEnd = reservationRouter
            .reservations(d.key)
            .reanchorCooldownUntil;
        assertEq(
            uint256(cooldownEnd),
            uint256(timeoutAtN) + RESERVATION_ACTION_TIMEOUT,
            "cooldown end = timeoutAt + one action timeout"
        );
        assertEq(
            uint256(uint8(reservationRouter.reservations(d.key).state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "Active after the timeout"
        );

        // Past the cooldown, still inside N's (unbounded) late window:
        // generation N+1.
        vm.warp(cooldownEnd);
        vm.prank(governance);
        reservationRouter.requestReservationReanchor(d.key, newerTarget);
        uint64 nonceNewer = reservationRouter.reservations(d.key).requestNonce;
        assertEq(uint256(nonceNewer), uint256(nonceN) + 1, "N+1 nonce");
        assertEq(
            uint256(uint8(reservationRouter.reservations(d.key).state)),
            uint256(uint8(Reservation.ReservationState.ActionPending)),
            "ActionPending on N+1"
        );
        assertEq(
            uint256(
                uint8(
                    reservationRouter.reservationActions(d.key, nonceNewer).state
                )
            ),
            uint256(uint8(Reservation.ActionState.Pending)),
            "N+1 Pending"
        );
        // N+1 took one position on its target (w1 is empty after N's
        // timeout, so the pre-request value is 0 for both targets).
        assertEq(_count(newerTarget), 1, "N+1 reserved target count");
        assertEq(_amount(newerTarget), ANCHOR_SAT, "N+1 reserved amount");

        // Inside N+1's own window the wallet's late proof of N lands.
        vm.warp(block.timestamp + 1 hours);
        assertTrue(
            block.timestamp <
                reservationRouter.reservationActions(d.key, nonceNewer).timeoutAt,
            "inside N+1 window"
        );
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(d.key, nonceN).state)
            ),
            uint256(uint8(Reservation.ActionState.TimedOut)),
            "N still TimedOut (late)"
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

        // N+1 was unwound: terminally Superseded, never settleable again.
        assertEq(
            uint256(
                uint8(
                    reservationRouter.reservationActions(d.key, nonceNewer).state
                )
            ),
            uint256(uint8(Reservation.ActionState.Superseded)),
            "N+1 Superseded"
        );
        assertTrue(
            _sawSuperseded(logs, d.key, nonceNewer),
            "ReservationActionSuperseded(key, N+1) emitted"
        );

        // N settled late.
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(d.key, nonceN).state)
            ),
            uint256(uint8(Reservation.ActionState.Settled)),
            "N Settled"
        );

        // The reservation is Active on w1 with the new anchor.
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(d.key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "Active after the late proof"
        );
        assertTrue(r.walletPubKeyHash == w1, "custodian is w1");
        assertEq(uint256(r.anchorAmount), ANCHOR_SAT, "anchor amount");
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
            "old anchor index cleared"
        );
        assertTrue(
            bridge.spentMainUTXOs(
                uint256(keccak256(abi.encodePacked(oldAnchorTxHash, uint32(0))))
            ),
            "old anchor recorded as spent"
        );

        // Capacity. The source released its position.
        assertEq(_count(w0), 0, "w0 count released");
        assertEq(_amount(w0), 0, "w0 amount released");
        // The reservation holds exactly one position, on w1. When N+1
        // targeted w1, the late proof re-took one position (count 2) and the
        // unwind released the other one, leaving exactly one. When N+1
        // targeted w2, w2 is back to its value before N+1 was requested (0)
        // and w1 holds the single position the late proof re-took.
        assertEq(_count(w1), 1, "w1 holds exactly one position");
        assertEq(_amount(w1), ANCHOR_SAT, "w1 holds exactly one anchor amount");
        if (newerTarget != w1) {
            assertEq(_count(newerTarget), 0, "N+1 target count released");
            assertEq(_amount(newerTarget), 0, "N+1 target amount released");
        }
        // The global ledger still tracks the single reservation.
        assertEq(_activeCount(), 1, "one active reservation");
        assertEq(_totalAmount(), ANCHOR_SAT, "global amount unchanged");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _sawSuperseded(
        Vm.Log[] memory logs,
        uint256 key,
        uint64 nonce
    ) internal view returns (bool) {
        bytes32 topic0 = keccak256("ReservationActionSuperseded(uint256,uint64)");
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter == address(bridge) &&
                logs[i].topics.length == 2 &&
                logs[i].topics[0] == topic0 &&
                uint256(logs[i].topics[1]) == key &&
                abi.decode(logs[i].data, (uint64)) == nonce
            ) {
                return true;
            }
        }
        return false;
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
            keccak256(abi.encode("LateReanchorUnwind", salt))
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
