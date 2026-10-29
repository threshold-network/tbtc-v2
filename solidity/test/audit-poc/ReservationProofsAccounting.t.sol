// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for five mutations of ReservationProofs that survived the
// Foundry gate and the Hardhat reservation suites (slither-mutate AOR pass of
// 2026-10-09, rows M-200 to M-204 in the audit record
// (solidity/docs/audit/pr-1116-reservations.md, section 7)).
//
// 1. ReservationProofs.sol:434 `pendingReservedDeposits -= 1` becomes `%= 1`.
//    With one pending reserved deposit both give 0; with two the mutant zeroes
//    the counter. Test: accept one of two reserved deposits, one stays pending.
// 2. ReservationProofs.sol:688 `action.amount - newAnchorAmount <= txMaxFee`
//    becomes `/` or `%`. With `/` the quotient is 1 for any fee below half the
//    anchor, so a fee of txMaxFee + 1 passes. With `%` the remainder equals the
//    difference while the new anchor is above half the old one, but a new
//    anchor of exactly half gives 0, so a 50% miner fee passes. Tests: both
//    proofs must revert with "Transaction fee is too high".
// 3. ReservationProofs.sol:791 and :794: the old wallet's count and amount
//    `-=` become `%=`, which zeroes them. They differ only when the old wallet
//    holds another reservation. Test: re-anchor one of two reservations on w0,
//    w0 keeps the other one's count and amount.
//
// The setup copies the helpers of ReanchorProofChecks.t.sol.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";

contract ReservationProofsAccountingTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    uint64 internal constant DEPOSIT_SAT = 50_000;
    uint64 internal constant ACCEPT_FEE_SAT = 500;
    uint64 internal constant ANCHOR_SAT = DEPOSIT_SAT - ACCEPT_FEE_SAT;

    string internal constant ERR_FEE = "Transaction fee is too high";

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

    /// @notice Accepting one of two pending reserved deposits releases only
    ///         that deposit's pending marker.
    function test_acceptance_decrementsPendingReservedDepositsByOne() public {
        uint256 before = reservationRouter.pendingReservedDeposits();
        Dep memory a = _reveal(actors[0], w0, DEPOSIT_SAT, 41);
        _reveal(actors[1], w0, DEPOSIT_SAT, 42);
        assertEq(
            reservationRouter.pendingReservedDeposits(),
            before + 2,
            "two pending reserved deposits"
        );

        _requestAcceptanceAs(actors[0], a.key, w0);
        _proveAcceptance(a, w0, ANCHOR_SAT, 1);

        assertEq(
            reservationRouter.pendingReservedDeposits(),
            before + 1,
            "the other deposit stays pending"
        );
    }

    /// @notice A re-anchor paying one satoshi more than the snapshotted fee
    ///         bound is rejected.
    function test_reanchorProof_rejectsFeeOneAboveTxMaxFee() public {
        (uint256 key, bytes32 anchorTxHash, uint64 nonce) = _activeAndRequest(
            51
        );
        uint64 txMaxFee = reservationRouter
            .reservationActions(key, nonce)
            .txMaxFee;
        uint64 newAnchor = ANCHOR_SAT - txMaxFee - 1;
        assertGt(uint256(newAnchor), uint256(ANCHOR_SAT) / 2, "precondition");

        _expectReanchorFeeRevert(key, anchorTxHash, nonce, newAnchor);
    }

    /// @notice A re-anchor that pays half the anchor as miner fee is rejected
    ///         even though the new anchor stays above the dust floor.
    function test_reanchorProof_rejectsHalfAnchorFee() public {
        (uint256 key, bytes32 anchorTxHash, uint64 nonce) = _activeAndRequest(
            52
        );
        uint64 txMaxFee = reservationRouter
            .reservationActions(key, nonce)
            .txMaxFee;
        uint64 newAnchor = ANCHOR_SAT / 2;
        assertEq(uint256(ANCHOR_SAT % newAnchor), 0, "precondition");
        assertGt(uint256(newAnchor), uint256(txMaxFee), "above dust floor");
        assertGt(uint256(ANCHOR_SAT - newAnchor), uint256(txMaxFee), "fee");

        _expectReanchorFeeRevert(key, anchorTxHash, nonce, newAnchor);
    }

    /// @notice Re-anchoring one of two reservations away from w0 removes only
    ///         that reservation's count and amount from w0.
    function test_reanchor_keepsOtherReservationOnSourceWallet() public {
        (uint256 key, bytes32 anchorTxHash, uint64 nonce) = _activeAndRequest(
            61
        );
        _active(actors[1], 62);
        // Before the proof w0 still holds both anchors.
        assertEq(
            uint256(reservationRouter.walletReservationsCount(w0)),
            2,
            "w0 holds two reservations"
        );
        assertEq(
            uint256(reservationRouter.walletReservationsAmount(w0)),
            2 * uint256(ANCHOR_SAT),
            "w0 holds two anchors"
        );

        uint64 txMaxFee = reservationRouter
            .reservationActions(key, nonce)
            .txMaxFee;
        BitcoinTx.Info memory t = _singleOutputTx(
            anchorTxHash,
            0,
            ANCHOR_SAT - txMaxFee,
            w1
        );
        BitcoinTx.Proof memory proof = BtcBuilder.prove(t, 1);
        vm.prank(spvMaintainer);
        reservationRouter.submitReservationReanchorProof(t, proof, key, nonce);

        assertEq(
            uint256(reservationRouter.walletReservationsCount(w0)),
            1,
            "w0 keeps the other reservation"
        );
        assertEq(
            uint256(reservationRouter.walletReservationsAmount(w0)),
            uint256(ANCHOR_SAT),
            "w0 keeps the other anchor amount"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _expectReanchorFeeRevert(
        uint256 key,
        bytes32 anchorTxHash,
        uint64 nonce,
        uint64 newAnchor
    ) internal {
        BitcoinTx.Info memory t = _singleOutputTx(
            anchorTxHash,
            0,
            newAnchor,
            w1
        );
        BitcoinTx.Proof memory proof = BtcBuilder.prove(t, 1);
        vm.prank(spvMaintainer);
        vm.expectRevert(bytes(ERR_FEE));
        reservationRouter.submitReservationReanchorProof(t, proof, key, nonce);

        assertEq(
            reservationRouter.reservations(key).anchorTxHash,
            anchorTxHash,
            "anchor unchanged"
        );
    }

    /// @dev Active reservation anchored on w0 through a real acceptance proof.
    function _active(
        address depositor,
        uint256 salt
    ) internal returns (uint256 key, bytes32 anchorTxHash) {
        Dep memory d = _reveal(depositor, w0, DEPOSIT_SAT, salt);
        _requestAcceptanceAs(depositor, d.key, w0);
        anchorTxHash = _proveAcceptance(d, w0, ANCHOR_SAT, 1);
        key = d.key;
    }

    /// @dev Active reservation on w0, then a governance re-anchor request to
    ///      w1. Returns the key, the current anchor txid and the generation.
    function _activeAndRequest(
        uint256 salt
    ) internal returns (uint256 key, bytes32 anchorTxHash, uint64 nonce) {
        (key, anchorTxHash) = _active(actors[0], salt);
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
            keccak256(abi.encode("ReservationProofsAccounting", salt))
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
