// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// PoC for audit findings F09, F10 and F11
// (.solidity-auditor/runs/20260930-085204/full-report.md):
//   F09 (lines 317-364)  "Acceptance proof strands the new anchor on a
//                         Closing wallet"
//   F10 (lines 365-409)  "Settlement strands a reservation on a Closing
//                         wallet at once"
//   F11 (lines 410-440)  "Reanchor proof strands the new anchor when the
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
        require(bridge.activeWalletPubKeyHash() == w2, "F09to11: w2 not active");
    }

    // ------------------------------------------------------------------
    // F09
    // ------------------------------------------------------------------

    /// @notice A pending acceptance authorization pins wallet w0 (count 1).
    ///         Anyone pushes w0 to Closing (SP-107 route). The wallet's
    ///         already confirmed anchor transaction is then proven on time
    ///         and settleAcceptance strands the brand new reservation in the
    ///         same call. The depositor is still credited gross minus the
    ///         initiation fee, the capacity and anchor index are released,
    ///         reanchor and strand calls revert with "Reservation is not
    ///         active", and w0 closes with the 49_500 sat anchor untracked.
    function test_F09_acceptanceProofStrandsNewAnchorOnClosingWallet() public {
        address depositor = actors[0];
        Dep memory y = _reveal(depositor, w0, DEPOSIT_SAT, 1);
        _request(depositor, w0, y.key);

        // Pre-state: authorization pending, reservation not yet created.
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 1);
        assertEq(
            uint256(reservationRouter.walletReservationsAmount(w0)),
            DEPOSIT_SAT
        );
        assertEq(
            uint256(uint8(reservationRouter.reservations(y.key).state)),
            uint256(uint8(Reservation.ReservationState.Unknown))
        );

        _forceClosingAnchorBlind(w0);
        assertEq(
            uint256(uint8(bridge.wallets(w0).state)),
            uint256(uint8(Wallets.WalletState.Closing)),
            "w0 Closing before the proof"
        );
        assertEq(bridge.wallets(w0).mainUtxoHash, bytes32(0), "no main UTXO");
        // The pending authorization still pins the wallet.
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 1);

        Snap memory before = _snap(depositor);

        // The wallet's anchor tx (deposit -> w0, fee 500) is proven on time.
        vm.expectEmit(true, true, true, true, address(bridge));
        emit ReservationStranded(y.key, w0, depositor, ANCHOR_SAT);
        bytes32 anchorTxHash = _proveAcceptance(y, w0, ANCHOR_SAT, 1);

        // The reservation was created and stranded in the same call.
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(y.key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Stranded)),
            "reservation Stranded at once"
        );
        assertEq(r.owner, depositor);
        assertEq(uint256(r.mintedAmount), ANCHOR_SAT);
        assertEq(uint256(r.anchorAmount), ANCHOR_SAT);
        assertTrue(r.walletPubKeyHash == w0, "custodian is the Closing wallet");
        assertEq(r.anchorTxHash, anchorTxHash);
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(y.key, 1).state)
            ),
            uint256(uint8(Reservation.ActionState.Settled))
        );

        // Capacity and anchor tracking released.
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);
        assertEq(uint256(reservationRouter.walletReservationsAmount(w0)), 0);
        assertEq(_activeCount(), 0);
        assertEq(_totalAmount(), 0);
        assertEq(reservationRouter.reservationByAnchorUtxo(anchorTxHash, 0), 0);
        assertFalse(bridge.spentMainUTXOs(_utxoKey(anchorTxHash)), "unspent");

        // The depositor is still credited gross minus the initiation fee; the
        // fee stays in the ReservationVault; the TBTCVault holds the Bank
        // balance backing the mint (49_500 sat of BTC sitting in w0).
        {
            uint256 gross = uint256(ANCHOR_SAT) * SATOSHI_MULTIPLIER;
            uint256 fee = (gross * reservationVault.initiationFeeBps()) / 10000;
            assertEq(tbtc.balanceOf(depositor), before.userTbtc + gross - fee);
            assertEq(
                tbtc.balanceOf(address(reservationVault)),
                before.rvTbtc + fee
            );
            assertEq(
                bank.balanceOf(address(tbtcVault)),
                before.tvBank + ANCHOR_SAT
            );
            assertEq(bank.balanceOf(address(reservationVault)), before.rvBank);
        }

        // The owner lost the reanchor right: every request reverts, for
        // anyone and for governance.
        vm.prank(ANYONE);
        vm.expectRevert(bytes(ERR_NOT_ACTIVE));
        reservationRouter.requestReservationReanchor(y.key, w1);
        vm.prank(governance);
        vm.expectRevert(bytes(ERR_NOT_ACTIVE));
        reservationRouter.requestReservationReanchor(y.key, w1);
        vm.expectRevert(bytes(ERR_NOT_ACTIVE));
        reservationRouter.notifyReservationStranded(y.key);

        // Nothing pins w0 any more: it closes with the anchor unspent.
        skipTime(WALLET_CLOSING_PERIOD + 1);
        vm.prank(ANYONE);
        bridge.notifyWalletClosingPeriodElapsed(w0);
        assertEq(
            uint256(uint8(bridge.wallets(w0).state)),
            uint256(uint8(Wallets.WalletState.Closed))
        );
        assertEq(bridge.wallets(w0).mainUtxoHash, bytes32(0), "still no main UTXO");
        assertFalse(bridge.spentMainUTXOs(_utxoKey(anchorTxHash)), "still unspent");
        assertEq(reservationRouter.reservationByAnchorUtxo(anchorTxHash, 0), 0);
    }

    // ------------------------------------------------------------------
    // F10
    // ------------------------------------------------------------------

    /// @notice Late-settlement route, no SP-107 dependency. The acceptance
    ///         authorization times out (permissionless), which releases the
    ///         wallet's count to 0. w0 has no main UTXO and no reservations,
    ///         so notifyWalletCloseable sends it straight to Closing. The
    ///         already confirmed anchor is then proven late: the settlement
    ///         re-takes the capacity and the helper strands the reservation in
    ///         the same call, about 91 days before the permissionless strand
    ///         rule would allow it. The wallet then closes with the anchor
    ///         unspent.
    function test_F10_lateSettlementOnClosingWalletStrandsAtOnce() public {
        address depositor = actors[0];
        Dep memory y = _reveal(depositor, w0, DEPOSIT_SAT, 2);
        _request(depositor, w0, y.key);
        uint32 timeoutAt = reservationRouter.reservationActions(y.key, 1).timeoutAt;

        // Authorization window passes without a proof; anyone reports it.
        vm.warp(timeoutAt);
        vm.prank(ANYONE);
        reservationRouter.notifyReservationAcceptanceTimedOut(y.key);
        assertEq(
            uint256(uint8(reservationRouter.reservationActions(y.key, 1).state)),
            uint256(uint8(Reservation.ActionState.TimedOut))
        );
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);

        // The wallet has no reservations and no main UTXO: straight to
        // Closing (the MovingFunds hop is skipped).
        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        vm.prank(ANYONE);
        bridge.notifyWalletCloseable(w0, none);
        assertEq(
            uint256(uint8(bridge.wallets(w0).state)),
            uint256(uint8(Wallets.WalletState.Closing)),
            "w0 Closing"
        );

        // The anchor tx the wallet signed inside the authorization window is
        // proven late.
        vm.expectEmit(true, true, true, true, address(bridge));
        emit ReservationStranded(y.key, w0, depositor, ANCHOR_SAT);
        bytes32 anchorTxHash = _proveAcceptance(y, w0, ANCHOR_SAT, 1);

        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(y.key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Stranded)),
            "reservation Stranded at once"
        );
        assertEq(uint256(r.anchorAmount), ANCHOR_SAT);
        assertEq(r.anchorTxHash, anchorTxHash);
        assertEq(
            uint256(
                uint8(reservationRouter.reservationActions(y.key, 1).state)
            ),
            uint256(uint8(Reservation.ActionState.Settled))
        );

        // The late path re-took the capacity and the strand released it again.
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);
        assertEq(uint256(reservationRouter.walletReservationsAmount(w0)), 0);
        assertEq(_activeCount(), 0);
        assertEq(_totalAmount(), 0);
        assertEq(reservationRouter.reservationByAnchorUtxo(anchorTxHash, 0), 0);

        // notifyReservationStranded would not have allowed this yet: the
        // reservation becomes strandable on a Closing wallet only at
        // dissolutionEligibleAt = acceptedAt + term + dissolution delay,
        // i.e. 91 days from now.
        assertEq(uint256(r.acceptedAt), block.timestamp);
        assertEq(
            uint256(r.dissolutionEligibleAt),
            block.timestamp + RESERVATION_TERM_SECONDS + RESERVATION_DISSOLUTION_DELAY
        );
        assertEq(uint256(r.dissolutionEligibleAt) - block.timestamp, 91 days);

        // The owner has no reanchor right any more.
        vm.prank(ANYONE);
        vm.expectRevert(bytes(ERR_NOT_ACTIVE));
        reservationRouter.requestReservationReanchor(y.key, w1);
        vm.expectRevert(bytes(ERR_NOT_ACTIVE));
        reservationRouter.notifyReservationStranded(y.key);

        // The wallet closes with the anchor unspent and untracked.
        skipTime(WALLET_CLOSING_PERIOD + 1);
        vm.prank(ANYONE);
        bridge.notifyWalletClosingPeriodElapsed(w0);
        assertEq(
            uint256(uint8(bridge.wallets(w0).state)),
            uint256(uint8(Wallets.WalletState.Closed))
        );
        assertEq(bridge.wallets(w0).mainUtxoHash, bytes32(0));
        assertFalse(bridge.spentMainUTXOs(_utxoKey(anchorTxHash)));
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
        reservationRouter.requestReservationReanchor(x.key, w1);
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

    /// @notice A reservation on w0 is reanchored to w1. Between the request
    ///         and the proof, w1 (zero main UTXO, count 1 from the pending
    ///         reanchor) is pushed to Closing by anyone (SP-107 route). The
    ///         proof of the already confirmed reanchor tx moves the anchor to
    ///         w1 and strands the reservation in the same call: both wallets
    ///         end with count 0, nothing tracks the new anchor, further
    ///         reanchors revert, and w1 closes with the 49_500 sat anchor
    ///         untracked.
    function test_F11_reanchorProofStrandsNewAnchorOnClosingTarget() public {
        address depositor = actors[0];

        // R: accepted on w0 while w0 is Live (anchor 49_500 sat).
        Dep memory d = _reveal(depositor, w0, DEPOSIT_SAT, 4);
        _request(depositor, w0, d.key);
        bytes32 oldAnchorTxHash = _proveAcceptance(d, w0, ANCHOR_SAT, 1);
        assertEq(
            uint256(uint8(reservationRouter.reservations(d.key).state)),
            uint256(uint8(Reservation.ReservationState.Active))
        );
        assertEq(
            reservationRouter.reservationByAnchorUtxo(oldAnchorTxHash, 0),
            d.key
        );

        // w0 leaves Live (non-active, zero main UTXO, count 1): MovingFunds.
        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        vm.prank(ANYONE);
        bridge.notifyWalletCloseable(w0, none);
        assertEq(
            uint256(uint8(bridge.wallets(w0).state)),
            uint256(uint8(Wallets.WalletState.MovingFunds))
        );

        // Permissionless reanchor request towards the Live wallet w1.
        vm.prank(ANYONE);
        reservationRouter.requestReservationReanchor(d.key, w1);
        uint64 nonce = reservationRouter.reservations(d.key).requestNonce;
        assertEq(uint256(nonce), 2);
        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 1);
        assertEq(
            uint256(reservationRouter.walletReservationsAmount(w1)),
            ANCHOR_SAT
        );

        // Before the proof lands, w1 leaves Live and ends up Closing.
        _forceClosingAnchorBlind(w1);
        assertEq(
            uint256(uint8(bridge.wallets(w1).state)),
            uint256(uint8(Wallets.WalletState.Closing)),
            "target Closing before the proof"
        );
        assertEq(bridge.wallets(w1).mainUtxoHash, bytes32(0));

        // The wallet's reanchor tx (old anchor -> w1, fee 0) is proven.
        Snap memory before = _snap(depositor);

        vm.expectEmit(true, true, true, true, address(bridge));
        emit ReservationStranded(d.key, w1, depositor, ANCHOR_SAT);
        bytes32 newAnchorTxHash = _proveReanchor(
            oldAnchorTxHash,
            ANCHOR_SAT,
            w1,
            d.key,
            nonce
        );

        // The anchor moved to w1 and the reservation is Stranded at once.
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(d.key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Stranded)),
            "reservation Stranded at once"
        );
        assertTrue(r.walletPubKeyHash == w1, "custodian is the Closing target");
        assertEq(uint256(r.anchorAmount), ANCHOR_SAT);
        assertEq(r.anchorTxHash, newAnchorTxHash);
        assertEq(
            uint256(uint8(reservationRouter.reservationActions(d.key, nonce).state)),
            uint256(uint8(Reservation.ActionState.Settled))
        );

        // Both wallets and the global ledgers are released; neither anchor is
        // tracked; the old anchor is recorded as honestly spent, the new one
        // is unspent.
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);
        assertEq(uint256(reservationRouter.walletReservationsAmount(w0)), 0);
        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 0);
        assertEq(uint256(reservationRouter.walletReservationsAmount(w1)), 0);
        assertEq(_activeCount(), 0);
        assertEq(_totalAmount(), 0);
        assertEq(reservationRouter.reservationByAnchorUtxo(oldAnchorTxHash, 0), 0);
        assertEq(reservationRouter.reservationByAnchorUtxo(newAnchorTxHash, 0), 0);
        assertTrue(bridge.spentMainUTXOs(_utxoKey(oldAnchorTxHash)));
        assertFalse(bridge.spentMainUTXOs(_utxoKey(newAnchorTxHash)));
        assertEq(bridge.wallets(w1).mainUtxoHash, bytes32(0), "not in main UTXO");

        // Fee 0: no vault financing, no balance movement.
        assertEq(tbtc.balanceOf(depositor), before.userTbtc);
        assertEq(tbtc.balanceOf(address(reservationVault)), before.rvTbtc);
        assertEq(bank.balanceOf(address(tbtcVault)), before.tvBank);
        assertEq(bank.balanceOf(address(reservationVault)), before.rvBank);

        // No further reanchor is possible.
        vm.prank(ANYONE);
        vm.expectRevert(bytes(ERR_NOT_ACTIVE));
        reservationRouter.requestReservationReanchor(d.key, w2);
        vm.expectRevert(bytes(ERR_NOT_ACTIVE));
        reservationRouter.notifyReservationStranded(d.key);

        // w1 closes with the anchor unspent and untracked.
        skipTime(WALLET_CLOSING_PERIOD + 1);
        vm.prank(ANYONE);
        bridge.notifyWalletClosingPeriodElapsed(w1);
        assertEq(
            uint256(uint8(bridge.wallets(w1).state)),
            uint256(uint8(Wallets.WalletState.Closed))
        );
        assertEq(bridge.wallets(w1).mainUtxoHash, bytes32(0));
        assertFalse(bridge.spentMainUTXOs(_utxoKey(newAnchorTxHash)));
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev SP-107 route: a non-active Live wallet with zero main UTXO but
    ///      reservation count > 0 is moved Live -> MovingFunds -> Closing by
    ///      an unprivileged caller (both balance checks read only the main
    ///      UTXO).
    function _forceClosingAnchorBlind(bytes20 wallet) internal {
        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        vm.prank(ANYONE);
        bridge.notifyWalletCloseable(wallet, none);
        assertEq(
            uint256(uint8(bridge.wallets(wallet).state)),
            uint256(uint8(Wallets.WalletState.MovingFunds)),
            "closeable routes to MovingFunds"
        );
        vm.prank(ANYONE);
        bridge.notifyMovingFundsBelowDust(wallet, none);
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
