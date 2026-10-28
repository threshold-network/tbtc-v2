// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for R-08 (audit findings F09, F10 and F11). Before the
// fix the settlement helper stranded a newly settled anchor at once when its
// target wallet was Closing, so the three tests below fail on the unfixed
// code ("reservation stays Active on the Closing wallet"). With the fix the
// helper strands only on Closed and Terminated wallets. The original
// findings (solidity/docs/audit/pr-1116-reservations.md):
//   F09  "Acceptance proof strands the new anchor on a
//                         Closing wallet"
//   F10  "Settlement strands a reservation on a Closing
//                         wallet at once"
//   F11  "Reanchor proof strands the new anchor when the
//                         target wallet is Closing"
//
// Source lines involved (solidity/contracts/bridge):
//   ReservationProofs.sol:228-249   strandLateSettlementIfTargetWalletClosed
//                                   (strands at once on Closing, Closed and
//                                   Terminated; no dissolutionEligibleAt
//                                   check)
//   ReservationProofs.sol:473-626   settleAcceptance (late path 493-539,
//                                   unconditional strand call at 595-600)
//   ReservationProofs.sol:640-762   submitReservationReanchorProof (strand
//                                   call at 746-751)
//   ReservationProofs.sol:179-212   loadSettleableAction (a TimedOut
//                                   acceptance stays settleable for
//                                   timeoutAt + termSeconds)
//   Reservation.sol:990-1029        strandReservation (capacity released,
//                                   anchor index deleted, state Stranded)
//   Reservation.sol:1091-1116       notifyReservationStranded (Closing
//                                   wallet only once block.timestamp >=
//                                   dissolutionEligibleAt)
//   Reservation.sol:723-859         requestReservationReanchor (needs state
//                                   Active; Closing source allowed)
//   Wallets.sol:323-351             notifyWalletCloseable (permissionless)
//   Wallets.sol:607-639             moveFunds (zero main UTXO and count == 0
//                                   goes straight to Closing; count > 0 goes
//                                   to MovingFunds)
//   MovingFunds.sol:603-624         notifyMovingFundsBelowDust
//                                   (permissionless, balance read from the
//                                   main UTXO only: SP-107 route)
//   Wallets.sol:360-387             notifyWalletClosingPeriodElapsed (needs
//                                   reservation count == 0)
//
// Routes to a Closing wallet used here (all permissionless):
//   - F09, F10 contrast, F11: the SP-107 route. A non-active Live wallet with
//     a zero main UTXO but count > 0 (a pending acceptance authorization or a
//     pending reanchor counts) passes notifyWalletCloseable (balance read as
//     0), goes to MovingFunds, then notifyMovingFundsBelowDust (balance 0)
//     makes it Closing.
//   - F10 main test: the late-settlement route. The acceptance authorization
//     times out (count released to 0), so notifyWalletCloseable sends the
//     wallet straight to Closing with no SP-107 dependency, and the already
//     confirmed anchor is then proven late.
//
// Timing parameters (test/fizz/Base.sol): action timeout 1 day, reservation
// term 90 days, dissolution delay 1 day, wallet closing period 2 days,
// initiation fee 40 bps. A reservation accepted at T0 would be strandable on
// a Closing wallet only from T0 + 91 days.
//
// Every test PASSES when the behaviour named by the test is observed.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";

contract F09to11ClosingWalletStrands is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    event ReservationStranded(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        uint64 anchorAmount
    );

    string internal constant ERR_NOT_ACTIVE = "Reservation is not active";
    string internal constant ERR_WALLET_NOT_STRANDABLE =
        "Wallet is not terminated, closed, or a dissolution-eligible closing wallet";
    string internal constant ERR_WALLET_HAS_RESERVATIONS =
        "Wallet still custodies reservations";

    uint64 internal constant DEPOSIT_SAT = 50_000;
    uint64 internal constant ACCEPT_FEE_SAT = 500;
    uint64 internal constant ANCHOR_SAT = DEPOSIT_SAT - ACCEPT_FEE_SAT; // 49_500

    address internal constant ANYONE = address(0xA11CE);

    /// @dev w0: setup's wallet (non-active after setUp). w1: second wallet,
    ///      reanchor target. w2: becomes the active wallet.
    bytes20 internal w0;
    bytes20 internal w1;
    bytes20 internal w2;

    struct Dep {
        uint256 key;
        bytes32 fundingTxHash;
        uint32 outIdx;
    }

    struct Snap {
        uint256 userTbtc;
        uint256 rvTbtc;
        uint256 tvBank;
        uint256 rvBank;
    }

    function setUp() public {
        setup();
        w0 = harnessWallets[0];
        w1 = _registerWalletFromKey(1);
        w2 = _registerWalletFromKey(2);
        require(
            bridge.activeWalletPubKeyHash() == w2,
            "F09to11: w2 not active"
        );
    }

    // ------------------------------------------------------------------
    // F09
    // ------------------------------------------------------------------

    /// @notice R-08 regression (was F09). A pending acceptance authorization
    ///         pins wallet w0 (count 1). Anyone pushes w0 to Closing (SP-107
    ///         route). The wallet's already confirmed anchor transaction is
    ///         then proven on time. The new reservation stays Active on the
    ///         Closing wallet with its re-anchor right, and it pins w0 so the
    ///         wallet cannot close with the anchor untracked.
    function test_F09_acceptanceProofOnClosingWalletKeepsReanchorRight()
        public
    {
        address depositor = actors[0];
        Dep memory y = _reveal(depositor, w0, DEPOSIT_SAT, 1);
        _request(depositor, w0, y.key);

        _forceClosingAnchorBlind(w0);
        assertEq(
            uint256(uint8(bridge.wallets(w0).state)),
            uint256(uint8(Wallets.WalletState.Closing)),
            "w0 Closing before the proof"
        );

        Snap memory before = _snap(depositor);
        bytes32 anchorTxHash = _proveAcceptance(y, w0, ANCHOR_SAT, 1);

        // The depositor is credited gross minus the initiation fee.
        {
            uint256 gross = uint256(ANCHOR_SAT) * SATOSHI_MULTIPLIER;
            uint256 fee = (gross * reservationVault.initiationFeeBps()) / 10000;
            assertEq(tbtc.balanceOf(depositor), before.userTbtc + gross - fee);
        }
        _assertActiveOnClosingWallet(y.key, w0, anchorTxHash);
        _assertReanchorRightAndPin(y.key, w0, w1);
    }

    // ------------------------------------------------------------------
    // F10
    // ------------------------------------------------------------------

    /// @notice R-08 regression (was F10). Late-settlement route, no SP-107
    ///         dependency. The acceptance authorization times out, which
    ///         releases the wallet's count to 0, and w0 goes straight to
    ///         Closing. The already confirmed anchor is then proven late: the
    ///         settlement re-takes the capacity and the position stays Active
    ///         on the Closing wallet instead of being stranded about 91 days
    ///         before `notifyReservationStranded` would allow it.
    function test_F10_lateSettlementOnClosingWalletKeepsReanchorRight() public {
        address depositor = actors[0];
        Dep memory y = _reveal(depositor, w0, DEPOSIT_SAT, 2);
        _request(depositor, w0, y.key);
        uint32 timeoutAt = reservationRouter
            .reservationActions(y.key, 1)
            .timeoutAt;

        vm.warp(timeoutAt);
        vm.prank(ANYONE);
        reservationRouter.notifyReservationAcceptanceTimedOut(y.key);
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);

        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        vm.prank(ANYONE);
        bridge.notifyWalletCloseable(w0, none);
        assertEq(
            uint256(uint8(bridge.wallets(w0).state)),
            uint256(uint8(Wallets.WalletState.Closing)),
            "w0 Closing"
        );

        bytes32 anchorTxHash = _proveAcceptance(y, w0, ANCHOR_SAT, 1);
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(y.key, 1).state)
            ),
            uint256(uint8(Reservation.ActionState.Settled))
        );
        _assertActiveOnClosingWallet(y.key, w0, anchorTxHash);
        _assertReanchorRightAndPin(y.key, w0, w1);
    }

    /// @notice Contrast for F10. A reservation accepted while w0 was Live and
    ///         then sitting on the same kind of Closing wallet (SP-107 route)
    ///         is NOT strandable before dissolutionEligibleAt, pins the wallet
    ///         in Closing, and keeps its permissionless reanchor right. The
    ///         settlement helper treats the same wallet state differently.
    function test_F10_contrast_activeReservationOnClosingWalletKeepsReanchorRight()
        public
    {
        address depositor = actors[0];
        Dep memory x = _reveal(depositor, w0, 60_000, 3);
        _request(depositor, w0, x.key);
        _proveAcceptance(x, w0, 60_000, 1);
        assertEq(
            uint256(uint8(reservationRouter.reservations(x.key).state)),
            uint256(uint8(Reservation.ReservationState.Active))
        );

        // R-14: the proven 60_000 sat anchor counts in the closeable check,
        // so the wallet can only be pushed once it is old enough.
        skipTime(WALLET_MAX_AGE);
        _forceClosingAnchorBlind(w0);
        assertEq(
            uint256(uint8(bridge.wallets(w0).state)),
            uint256(uint8(Wallets.WalletState.Closing))
        );

        // Not strandable on a Closing wallet before dissolutionEligibleAt.
        assertTrue(
            block.timestamp <
                reservationRouter.reservations(x.key).dissolutionEligibleAt
        );
        vm.expectRevert(bytes(ERR_WALLET_NOT_STRANDABLE));
        reservationRouter.notifyReservationStranded(x.key);

        // The reservation pins the wallet in Closing.
        skipTime(WALLET_CLOSING_PERIOD + 1);
        vm.expectRevert(bytes(ERR_WALLET_HAS_RESERVATIONS));
        bridge.notifyWalletClosingPeriodElapsed(w0);

        // And the permissionless reanchor right is intact.
        vm.prank(ANYONE);
        reservationRouter.requestReservationReanchor(
            x.key,
            w1,
            new uint32[](0),
            0
        );
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(x.key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.ActionPending))
        );
        assertEq(uint256(r.requestNonce), 2);
        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 1);
    }

    // ------------------------------------------------------------------
    // F11
    // ------------------------------------------------------------------

    /// @notice R-08 regression (was F11). A reservation on w0 is re-anchored
    ///         to w1. Between the request and the proof, w1 is pushed to
    ///         Closing (SP-107 route). The proof moves the anchor to w1 and
    ///         the position stays Active there with its re-anchor right.
    function test_F11_reanchorProofOnClosingTargetKeepsReanchorRight() public {
        address depositor = actors[0];

        Dep memory d = _reveal(depositor, w0, DEPOSIT_SAT, 4);
        _request(depositor, w0, d.key);
        bytes32 oldAnchorTxHash = _proveAcceptance(d, w0, ANCHOR_SAT, 1);

        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        vm.prank(ANYONE);
        bridge.notifyWalletCloseable(w0, none);
        vm.prank(ANYONE);
        reservationRouter.requestReservationReanchor(
            d.key,
            w1,
            new uint32[](0),
            0
        );
        uint64 nonce = reservationRouter.reservations(d.key).requestNonce;
        assertEq(uint256(nonce), 2);

        _forceClosingAnchorBlind(w1);
        assertEq(
            uint256(uint8(bridge.wallets(w1).state)),
            uint256(uint8(Wallets.WalletState.Closing)),
            "target Closing before the proof"
        );

        bytes32 newAnchorTxHash = _proveReanchor(
            oldAnchorTxHash,
            ANCHOR_SAT,
            w1,
            d.key,
            nonce
        );
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(d.key, nonce).state)
            ),
            uint256(uint8(Reservation.ActionState.Settled))
        );
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);
        assertEq(
            reservationRouter.reservationByAnchorUtxo(oldAnchorTxHash, 0),
            0
        );
        assertTrue(bridge.spentMainUTXOs(_utxoKey(oldAnchorTxHash)));

        _assertActiveOnClosingWallet(d.key, w1, newAnchorTxHash);
        _assertReanchorRightAndPin(d.key, w1, w2);
    }

    /// @dev After settlement onto a Closing wallet: Active, custodied by
    ///      `wallet`, counted on it and in the global ledgers, anchor indexed.
    function _assertActiveOnClosingWallet(
        uint256 key,
        bytes20 wallet,
        bytes32 anchorTxHash
    ) internal {
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "reservation stays Active on the Closing wallet"
        );
        assertTrue(
            r.walletPubKeyHash == wallet,
            "custodian is the Closing wallet"
        );
        assertEq(uint256(r.anchorAmount), ANCHOR_SAT);
        assertEq(r.anchorTxHash, anchorTxHash);
        assertEq(uint256(reservationRouter.walletReservationsCount(wallet)), 1);
        assertEq(
            uint256(reservationRouter.walletReservationsAmount(wallet)),
            ANCHOR_SAT
        );
        assertEq(_activeCount(), 1);
        assertEq(_totalAmount(), ANCHOR_SAT);
        assertEq(
            reservationRouter.reservationByAnchorUtxo(anchorTxHash, 0),
            key
        );
    }

    /// @dev The position is not strandable before `dissolutionEligibleAt`,
    ///      it pins the Closing wallet, and anyone can re-anchor it to the
    ///      Live wallet `target`.
    function _assertReanchorRightAndPin(
        uint256 key,
        bytes20 wallet,
        bytes20 target
    ) internal {
        assertTrue(
            block.timestamp <
                reservationRouter.reservations(key).dissolutionEligibleAt,
            "before dissolution eligibility"
        );
        vm.expectRevert(bytes(ERR_WALLET_NOT_STRANDABLE));
        reservationRouter.notifyReservationStranded(key);

        skipTime(WALLET_CLOSING_PERIOD + 1);
        vm.prank(ANYONE);
        vm.expectRevert(bytes(ERR_WALLET_HAS_RESERVATIONS));
        bridge.notifyWalletClosingPeriodElapsed(wallet);

        vm.prank(ANYONE);
        reservationRouter.requestReservationReanchor(
            key,
            target,
            new uint32[](0),
            0
        );
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.ActionPending)),
            "re-anchor requested from the Closing wallet"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Pushes a non-active Live wallet with a zero main UTXO to Closing
    ///      with permissionless calls. A wallet with a proven anchor goes
    ///      Live -> MovingFunds -> Closing (below-dust exit); since R-13 a
    ///      wallet loaded only with pending capacity goes straight to Closing.
    function _forceClosingAnchorBlind(bytes20 wallet) internal {
        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        vm.prank(ANYONE);
        bridge.notifyWalletCloseable(wallet, none);
        if (bridge.wallets(wallet).state == Wallets.WalletState.MovingFunds) {
            vm.prank(ANYONE);
            bridge.notifyMovingFundsBelowDust(wallet, none);
        }
        assertEq(
            uint256(uint8(bridge.wallets(wallet).state)),
            uint256(uint8(Wallets.WalletState.Closing)),
            "wallet pushed to Closing"
        );
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
            keccak256(abi.encode("F09to11", salt))
        );
        d.fundingTxHash = BtcBuilder.txHash(fundingTx);
        d.key = uint256(keccak256(abi.encodePacked(d.fundingTxHash, d.outIdx)));
        vm.prank(depositor);
        bridge.revealDeposit(fundingTx, reveal);
        _recordFunding(d.key, fundingTx, d.outIdx);
    }

    function _request(address depositor, bytes20 wallet, uint256 key) internal {
        _requestAcceptanceAs(depositor, key, wallet);
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
        reservationRouter.submitReservationReanchorProof(t, proof, key, nonce);
    }

    function _snap(address depositor) internal view returns (Snap memory s) {
        s.userTbtc = tbtc.balanceOf(depositor);
        s.rvTbtc = tbtc.balanceOf(address(reservationVault));
        s.tvBank = bank.balanceOf(address(tbtcVault));
        s.rvBank = bank.balanceOf(address(reservationVault));
    }

    function _activeCount() internal view returns (uint256) {
        (uint32 count, ) = reservationRouter.activeReservationsCount();
        return count;
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

    function _totalAmount() internal view returns (uint256 total) {
        (, , , , , , uint64 reservationTotalAmount, , , ) = reservationRouter
            .reservationParameters();
        total = reservationTotalAmount;
    }

    function _utxoKey(bytes32 txHash) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(txHash, uint32(0))));
    }
}
