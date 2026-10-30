// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for two mutations of `submitReservationReanchorProof`
// found by the targeted slither-mutate pass of 2026-10-07. Before this file
// neither the Foundry gate nor the Hardhat suite killed them.
//
// 1. ReservationProofs.sol:890-894 (operator LOR): the input check
//    `anchorTxHash == outpointTxHash && anchorTxOutputIndex == outpointIndex`
//    becomes `||`. Every anchor has output index 0, so the mutant accepts a
//    re-anchor transaction that spends output 0 of ANY transaction. The real
//    anchor then stays recorded and is not marked spent, while the position
//    moves to the new output.
//    Test: a proof whose single input spends (other txid, 0) must revert.
//
// 2. ReservationProofs.sol:700 (operator MIA): `if (late)` becomes
//    `if (true)`, so an on-time settlement runs the late branch. The ledgers
//    net out (the re-take at :704-707 is undone by `unwindPendingAction` at
//    :714 for the same generation), but the Bridge emits
//    `ReservationLateSettled` and `ReservationActionSuperseded` for a
//    generation that settled on time. Off-chain consumers read these events.
//    Test: an on-time re-anchor settlement emits neither event.
//
// The setup copies the helpers of ReanchorCumulativeFee.t.sol: a real
// acceptance proof creates the anchor on w0, then governance requests a
// re-anchor to w1 and the SPV maintainer proves it.

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";

contract ReanchorProofChecksTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    uint64 internal constant DEPOSIT_SAT = 50_000;
    uint64 internal constant ACCEPT_FEE_SAT = 500;
    uint64 internal constant ANCHOR_SAT = DEPOSIT_SAT - ACCEPT_FEE_SAT;
    uint64 internal constant HOP_FEE_SAT = 150;

    string internal constant ERR_INPUT =
        "Transaction input must point to the reservation anchor";

    bytes20 internal w0;
    bytes20 internal w1;

    struct Dep {
        uint256 key;
        bytes32 fundingTxHash;
        uint32 outIdx;
    }

    function setUp() public {
        setup();
        w0 = harnessWallets[0];
        w1 = _registerWalletFromKey(1);
    }

    /// @notice A re-anchor transaction whose input spends output 0 of some
    ///         other transaction does not prove the reservation's anchor was
    ///         moved, so the proof must revert. The `||` mutant accepts it.
    function test_reanchorProof_rejectsInputFromAnotherTransactionAtIndexZero()
        public
    {
        (uint256 key, bytes32 anchorTxHash, uint64 nonce) = _activeAndRequest();
        assertEq(
            uint256(reservationRouter.reservations(key).anchorTxOutputIndex),
            0,
            "anchor output index is 0"
        );

        bytes32 otherTxHash = keccak256("not the reservation anchor");
        assertTrue(otherTxHash != anchorTxHash, "a different transaction");
        BitcoinTx.Info memory t = _singleOutputTx(
            otherTxHash,
            0,
            ANCHOR_SAT - HOP_FEE_SAT,
            w1
        );
        BitcoinTx.Proof memory proof = BtcBuilder.prove(t, 1);
        vm.prank(spvMaintainer);
        vm.expectRevert(bytes(ERR_INPUT));
        reservationRouter.submitReservationReanchorProof(t, proof, key, nonce);

        assertEq(
            reservationRouter.reservations(key).anchorTxHash,
            anchorTxHash,
            "anchor unchanged"
        );
    }

    /// @notice An on-time re-anchor settlement (the action is still Pending)
    ///         emits `ReservationReanchored` and no late-settlement or
    ///         supersede event.
    function test_reanchorProof_onTimeSettlementEmitsNoLateEvents() public {
        (uint256 key, bytes32 anchorTxHash, uint64 nonce) = _activeAndRequest();

        BitcoinTx.Info memory t = _singleOutputTx(
            anchorTxHash,
            0,
            ANCHOR_SAT - HOP_FEE_SAT,
            w1
        );
        BitcoinTx.Proof memory proof = BtcBuilder.prove(t, 1);
        vm.recordLogs();
        vm.prank(spvMaintainer);
        reservationRouter.submitReservationReanchorProof(t, proof, key, nonce);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(key, nonce).state)
            ),
            uint256(uint8(Reservation.ActionState.Settled)),
            "action Settled"
        );
        assertEq(
            _countTopic(
                logs,
                keccak256("ReservationLateSettled(uint256,uint64,uint8)")
            ),
            0,
            "no ReservationLateSettled for an on-time settlement"
        );
        assertEq(
            _countTopic(
                logs,
                keccak256("ReservationActionSuperseded(uint256,uint64)")
            ),
            0,
            "no ReservationActionSuperseded for an on-time settlement"
        );
        assertEq(
            _countTopic(
                logs,
                keccak256(
                    "ReservationReanchored(uint256,uint64,bytes20,bytes32,uint64,uint64)"
                )
            ),
            1,
            "one ReservationReanchored"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Active reservation anchored on w0 through a real acceptance
    ///      proof, then a governance re-anchor request to w1. Returns the
    ///      key, the current anchor txid and the re-anchor generation.
    function _activeAndRequest()
        internal
        returns (uint256 key, bytes32 anchorTxHash, uint64 nonce)
    {
        address depositor = actors[0];
        Dep memory d = _reveal(depositor, w0, DEPOSIT_SAT, 31);
        _requestAcceptanceAs(depositor, d.key, w0);
        anchorTxHash = _proveAcceptance(d, w0, ANCHOR_SAT, 1);
        key = d.key;

        vm.prank(governance);
        reservationRouter.requestReservationReanchor(
            key,
            w1,
            new uint32[](0),
            0
        );
        nonce = reservationRouter.reservations(key).requestNonce;
        assertEq(uint256(nonce), 2, "re-anchor is generation 2");
    }

    function _countTopic(
        Vm.Log[] memory logs,
        bytes32 topic0
    ) internal view returns (uint256 n) {
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
            keccak256(abi.encode("ReanchorProofChecks", salt))
        );
        d.fundingTxHash = BtcBuilder.txHash(fundingTx);
        d.key = uint256(keccak256(abi.encodePacked(d.fundingTxHash, d.outIdx)));
        vm.prank(depositor);
        bridge.revealDeposit(fundingTx, reveal);
        _recordFunding(d.key, fundingTx, d.outIdx);
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
