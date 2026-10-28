// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression guard for a surviving mutant in
// `ReservationProofs.settleReanchorAccounting`
// (solidity/contracts/bridge/ReservationProofs.sol):
//
//   line 797   reservation.cumulativeReanchorFee += minerFee;
//   mutant     (line commented out)
//
// `cumulativeReanchorFee` is the only on-chain record of the lifetime miner
// fee across re-anchor hops (the `ReservationReanchored` event carries the
// per-hop fee only). The fuzz properties that read the field never reached a
// re-anchor with a non-zero fee, and the existing Foundry PoCs prove every
// re-anchor with fee 0, so the line was never exercised with a fee above
// zero.
//
// This test drives two governance re-anchor hops (w0 -> w1 -> w2) whose
// Bitcoin transactions pay a non-zero miner fee (the output is
// `anchor - fee`) and checks, after each hop:
//   - `cumulativeReanchorFee` is the running sum of the hop fees (the
//     assertion the mutant breaks),
//   - the anchor amount, the per-wallet reserved amounts and the global
//     reserved amount all dropped by the fee
//     (ReservationProofs.sol:787-797),
//   - the reservation vault financed the fee
//     (`financeInKindFee`, ReservationProofs.sol:758-761): the reserve is
//     burned first and any shortfall is booked as `inKindFeeDebtSat`
//     (ReservationVault.sol:215-234, 359-377).
//
// Bounds (test/fizz/Base.sol): reservationTxMaxFee = 1_000 sat,
// reservationMinAmount = 10_000 sat. Both hop fees are below the action's
// snapshotted `txMaxFee` and the re-anchored amount stays above it
// (ReservationProofs.sol:687-698). Governance bypasses the re-anchor
// cooldown and may rotate a Live wallet (Reservation.sol:737-753), so no
// time passes between the hops.
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

contract ReanchorCumulativeFee is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    uint64 internal constant DEPOSIT_SAT = 50_000;
    uint64 internal constant ACCEPT_FEE_SAT = 500;
    uint64 internal constant ANCHOR_SAT = DEPOSIT_SAT - ACCEPT_FEE_SAT; // 49_500

    /// @dev Miner fees of the two hops, both non-zero and below the
    ///      snapshotted per-transaction bound (RESERVATION_TX_MAX_FEE).
    uint64 internal constant FEE_HOP1 = 150;
    uint64 internal constant FEE_HOP2 = 200;

    /// @dev w0: setup's wallet (Live), source of the acceptance anchor.
    ///      w1: target of hop 1. w2: active wallet, target of hop 2.
    bytes20 internal w0;
    bytes20 internal w1;
    bytes20 internal w2;

    struct Dep {
        uint256 key;
        bytes32 fundingTxHash;
        uint32 outIdx;
    }

    /// @dev State of one hop sampled between the request and the proof.
    struct Hop {
        uint64 nonce;
        uint64 anchorBefore;
        uint256 reserveTbtc;
        uint64 debtSat;
        uint64 burnedSat;
        uint64 shortfallSat;
    }

    function setUp() public {
        setup();
        w0 = harnessWallets[0];
        w1 = _registerWalletFromKey(1);
        w2 = _registerWalletFromKey(2);
        require(
            bridge.activeWalletPubKeyHash() == w2,
            "ReanchorCumulativeFee: w2 not active"
        );
    }

    // ------------------------------------------------------------------
    // Tests
    // ------------------------------------------------------------------

    /// @notice Two fee-bearing re-anchor hops accumulate their miner fees in
    ///         `cumulativeReanchorFee` and reduce the anchor and the
    ///         reserved ledgers by the same total.
    function test_reanchor_accumulatesMinerFeeAcrossHops() public {
        address depositor = actors[0];

        // Active reservation on w0 through a real acceptance proof.
        Dep memory d = _reveal(depositor, w0, DEPOSIT_SAT, 31);
        _request(depositor, w0, d.key);
        bytes32 anchorTxHash = _proveAcceptance(d, w0, ANCHOR_SAT, 1);

        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(d.key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "Active before the first re-anchor"
        );
        assertEq(uint256(r.anchorAmount), ANCHOR_SAT, "A0 anchor amount");
        assertEq(
            uint256(r.cumulativeReanchorFee),
            0,
            "no fee before any re-anchor"
        );
        assertEq(_amount(w0), ANCHOR_SAT, "w0 holds A0 before hop 1");
        assertEq(_totalAmount(), ANCHOR_SAT, "global amount is A0");

        // Hop 1: w0 -> w1, miner fee FEE_HOP1.
        anchorTxHash = _hop(d.key, anchorTxHash, w1, FEE_HOP1);

        r = reservationRouter.reservations(d.key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "Active after hop 1"
        );
        assertTrue(r.walletPubKeyHash == w1, "custodian is w1");
        assertEq(r.anchorTxHash, anchorTxHash, "hop 1 anchor tx");
        assertEq(
            uint256(r.cumulativeReanchorFee),
            uint256(FEE_HOP1),
            "cumulative fee after hop 1 == f1"
        );
        assertEq(
            uint256(r.anchorAmount),
            uint256(ANCHOR_SAT - FEE_HOP1),
            "anchor amount after hop 1 == A0 - f1"
        );
        assertEq(
            uint256(r.mintedAmount),
            uint256(ANCHOR_SAT - FEE_HOP1),
            "minted amount after hop 1 == A0 - f1"
        );
        assertEq(_count(w0), 0, "w0 count released");
        assertEq(_amount(w0), 0, "w0 amount released");
        assertEq(_count(w1), 1, "w1 holds one position");
        assertEq(
            _amount(w1),
            uint256(ANCHOR_SAT - FEE_HOP1),
            "w1 amount == A0 - f1"
        );
        assertEq(
            _totalAmount(),
            uint256(ANCHOR_SAT - FEE_HOP1),
            "global amount dropped by f1"
        );

        // Hop 2: w1 -> w2, miner fee FEE_HOP2.
        anchorTxHash = _hop(d.key, anchorTxHash, w2, FEE_HOP2);

        r = reservationRouter.reservations(d.key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "Active after hop 2"
        );
        assertTrue(r.walletPubKeyHash == w2, "custodian is w2");
        assertEq(r.anchorTxHash, anchorTxHash, "hop 2 anchor tx");
        assertEq(
            uint256(r.cumulativeReanchorFee),
            uint256(FEE_HOP1) + uint256(FEE_HOP2),
            "cumulative fee after hop 2 == f1 + f2"
        );
        assertEq(
            uint256(r.anchorAmount),
            uint256(ANCHOR_SAT - FEE_HOP1 - FEE_HOP2),
            "anchor amount after hop 2 == A0 - f1 - f2"
        );
        assertEq(
            uint256(r.mintedAmount),
            uint256(ANCHOR_SAT - FEE_HOP1 - FEE_HOP2),
            "minted amount after hop 2 == A0 - f1 - f2"
        );
        assertEq(_count(w1), 0, "w1 count released");
        assertEq(_amount(w1), 0, "w1 amount released");
        assertEq(_count(w2), 1, "w2 holds one position");
        assertEq(
            _amount(w2),
            uint256(ANCHOR_SAT - FEE_HOP1 - FEE_HOP2),
            "w2 amount == A0 - f1 - f2"
        );
        assertEq(
            _totalAmount(),
            uint256(ANCHOR_SAT - FEE_HOP1 - FEE_HOP2),
            "global amount dropped by f1 + f2"
        );
        assertEq(_activeCount(), 1, "one active reservation");
    }

    // ------------------------------------------------------------------
    // Hop
    // ------------------------------------------------------------------

    /// @dev Governance requests a re-anchor of `key` to `target`, then the
    ///      SPV maintainer proves a transaction that spends the current
    ///      anchor and pays `anchor - fee` to `target`. Also checks the
    ///      action bounds and the vault's fee financing for this hop.
    function _hop(
        uint256 key,
        bytes32 prevAnchorTxHash,
        bytes20 target,
        uint64 fee
    ) internal returns (bytes32 newAnchorTxHash) {
        Hop memory h = _requestHop(key, target, fee);

        vm.recordLogs();
        newAnchorTxHash = _proveReanchor(
            prevAnchorTxHash,
            h.anchorBefore - fee,
            target,
            key,
            h.nonce
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(key, h.nonce).state)
            ),
            uint256(uint8(Reservation.ActionState.Settled)),
            "action Settled"
        );

        // The financing call ran without reverting and produced exactly the
        // expected burn and debt.
        assertTrue(
            _sawFinanced(logs, fee, h.shortfallSat),
            "InKindFeeFinanced(fee, shortfall) emitted by the vault"
        );
        assertEq(
            tbtc.balanceOf(address(reservationVault)),
            h.reserveTbtc - uint256(h.burnedSat) * SATOSHI_MULTIPLIER,
            "vault reserve decreased by the burned part of the fee"
        );
        assertEq(
            uint256(reservationVault.inKindFeeDebtSat()),
            uint256(h.debtSat) + uint256(h.shortfallSat),
            "debt increased by the uncovered part of the fee"
        );
    }

    /// @dev Requests the governance re-anchor, checks that `fee` fits the
    ///      action's snapshotted `txMaxFee` and the dust floor
    ///      (ReservationProofs.sol:687-698), and samples the vault state
    ///      together with the expected financing outcome
    ///      (ReservationVault.sol:215-234, 359-377): burn min(fee, reserve in
    ///      sat) and book the rest as debt.
    function _requestHop(
        uint256 key,
        bytes20 target,
        uint64 fee
    ) internal returns (Hop memory h) {
        h.anchorBefore = reservationRouter.reservations(key).anchorAmount;

        vm.prank(governance);
        reservationRouter.requestReservationReanchor(key, target);
        h.nonce = reservationRouter.reservations(key).requestNonce;

        uint64 txMaxFee = reservationRouter
            .reservationActions(key, h.nonce)
            .txMaxFee;
        assertTrue(fee > 0, "hop fee is non-zero");
        assertTrue(fee <= txMaxFee, "hop fee within the snapshotted txMaxFee");
        assertTrue(
            h.anchorBefore - fee > txMaxFee,
            "new anchor above the dust floor"
        );

        h.reserveTbtc = tbtc.balanceOf(address(reservationVault));
        h.debtSat = reservationVault.inKindFeeDebtSat();
        uint256 reserveSat = h.reserveTbtc / SATOSHI_MULTIPLIER;
        h.burnedSat = uint64(reserveSat < fee ? reserveSat : fee);
        h.shortfallSat = fee - h.burnedSat;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _sawFinanced(
        Vm.Log[] memory logs,
        uint64 feeSat,
        uint64 shortfallSat
    ) internal view returns (bool) {
        bytes32 topic0 = keccak256("InKindFeeFinanced(uint64,uint64)");
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter == address(reservationVault) &&
                logs[i].topics.length == 1 &&
                logs[i].topics[0] == topic0
            ) {
                (uint64 fee, uint64 shortfall) = abi.decode(
                    logs[i].data,
                    (uint64, uint64)
                );
                if (fee == feeSat && shortfall == shortfallSat) {
                    return true;
                }
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
            keccak256(abi.encode("ReanchorCumulativeFee", salt))
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
    ///      reanchor transaction of generation `nonce` as the SPV
    ///      maintainer. `value` is the output value, i.e. the previous
    ///      anchor amount minus the miner fee.
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
