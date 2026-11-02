// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// PoC for audit finding F08 "Anyone can strand an aged reservation before a
// reanchor can run" (solidity/docs/audit/pr-1116-reservations.md).
//
// Source lines involved (solidity/contracts/bridge):
//   Reservation.sol:1091-1116  notifyReservationStranded (no caller check;
//                              Closing wallet branch gated only by
//                              block.timestamp >= dissolutionEligibleAt)
//   Reservation.sol:990-1029   strandReservation (state -> Stranded, capacity
//                              released, anchor index deleted)
//   Reservation.sol:723-859    requestReservationReanchor (requires state ==
//                              Active; Live source wallet only for governance;
//                              MovingFunds or Closing source for anyone)
//   ReservationProofs.sol:570  dissolutionEligibleAt = expiresAt +
//                              action.dissolutionDelay
//   Wallets.sol:300-351        notifyWalletCloseable (permissionless)
//   Wallets.sol:607-639        moveFunds (zero main UTXO + count > 0 =>
//                              MovingFunds)
//   MovingFunds.sol:603-624    notifyMovingFundsBelowDust (permissionless;
//                              the balance check reads only the main UTXO)
//   Wallets.sol:360-387        notifyWalletClosingPeriodElapsed (needs
//                              reservation count == 0)
//
// Timing parameters (test/fizz/Base.sol): reservation term 90 days,
// dissolution delay 1 day, action timeout 1 day, wallet closing period 2
// days, moving funds dust 5_000 sat, wallet max age 14 days. A reservation
// accepted at T0 therefore becomes strandable on a Closing wallet at
// T0 + 91 days.
//
// Every test PASSES when the behaviour described in its name is observed.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {Bridge} from "../../contracts/bridge/Bridge.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {ReservationRouter} from "../../contracts/bridge/ReservationRouter.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";

/// @dev Throwaway contract an unprivileged account deploys to run the whole
///      attack (Live -> MovingFunds -> Closing -> Stranded) in one tx.
contract F08Striker {
    Bridge internal immutable target;

    constructor(Bridge _target) {
        target = _target;
    }

    function strike(bytes20 wallet, uint256 reservationKey) external {
        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        target.notifyWalletCloseable(wallet, none);
        target.notifyMovingFundsBelowDust(wallet, none);
        ReservationRouter(address(target)).notifyReservationStranded(
            reservationKey
        );
    }
}

contract F08StrandBeforeReanchor is Test, Handlers {
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
    string internal constant ERR_LIVE_NEEDS_GOV =
        "Only governance can rotate a Live wallet's anchor";
    string internal constant ERR_COOLDOWN = "Reanchor cooldown in effect";
    string internal constant ERR_WALLET_HAS_RESERVATIONS =
        "Wallet still custodies reservations";

    uint256 internal constant ANCHOR_SAT = 50_000;

    address internal attacker;
    address internal honest;

    function setUp() public {
        setup();
        attacker = makeAddr("f08.attacker");
        honest = makeAddr("f08.honestReanchorer");
    }

    // ------------------------------------------------------------------
    // Main PoC: one transaction from a Live wallet to a Stranded position
    // ------------------------------------------------------------------

    /// @notice R-07 regression. An aged reservation sits on a wallet that is
    ///         still Live. The one-transaction strike (Live -> MovingFunds ->
    ///         Closing -> Stranded) now reverts: a Closing wallet's positions
    ///         are strandable only after its closing period. If the attacker
    ///         stops after forcing Closing, the owner can still re-anchor.
    function test_F08_oneTxStrikeRevertsAndReanchorRightSurvives() public {
        (uint256 key, bytes20 src, bytes20 dst) = _openReservation();
        Reservation.ReservationRequest memory r0 = reservationRouter
            .reservations(key);
        vm.warp(_dissolutionEligibleAt(r0));

        vm.prank(attacker);
        F08Striker striker = new F08Striker(bridge);
        vm.prank(attacker);
        vm.expectRevert(bytes(ERR_WALLET_NOT_STRANDABLE));
        striker.strike(src, key);

        // The whole strike reverted: the wallet is still Live and the
        // position Active.
        assertEq(_ws(src), _w(Wallets.WalletState.Live), "src still Live");
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.Active))
        );

        // Forcing Closing without the strand leaves the closing period as
        // an exclusive re-anchor window.
        _forceClosing(src);
        vm.prank(attacker);
        vm.expectRevert(bytes(ERR_WALLET_NOT_STRANDABLE));
        reservationRouter.notifyReservationStranded(key);

        vm.warp(
            uint256(bridge.wallets(src).closingStartedAt) +
                WALLET_CLOSING_PERIOD -
                1
        );
        vm.prank(attacker);
        vm.expectRevert(bytes(ERR_WALLET_NOT_STRANDABLE));
        reservationRouter.notifyReservationStranded(key);

        vm.prank(honest);
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.ActionPending)),
            "owner re-anchored inside the closing period"
        );
    }

    // ------------------------------------------------------------------
    // Window analysis
    // ------------------------------------------------------------------

    /// @notice At the first second the wallet is Closing and
    ///         block.timestamp >= dissolutionEligibleAt, BOTH a reanchor
    ///         request and a strand are allowed. Whoever lands first wins:
    ///         here the honest reanchor goes first and the strand then
    ///         reverts with "Reservation is not active". The mirror case is
    ///         the main PoC above.
    function test_F08_atEligibilityBothCallableAndReanchorFirstBlocksStrand()
        public
    {
        (uint256 key, bytes20 src, bytes20 dst) = _openReservation();
        Reservation.ReservationRequest memory r0 = reservationRouter
            .reservations(key);
        vm.warp(_dissolutionEligibleAt(r0));
        _forceClosing(src);
        assertEq(_ws(src), _w(Wallets.WalletState.Closing));

        vm.prank(honest);
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );

        Reservation.ReservationRequest memory r1 = reservationRouter
            .reservations(key);
        assertEq(
            uint256(uint8(r1.state)),
            uint256(uint8(Reservation.ReservationState.ActionPending))
        );
        assertEq(uint256(r1.requestNonce), uint256(r0.requestNonce) + 1);
        Reservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, r1.requestNonce);
        assertEq(
            uint256(uint8(a.actionType)),
            uint256(uint8(Reservation.ActionType.Reanchor))
        );
        assertTrue(a.targetWalletPubKeyHash == dst);
        assertEq(uint256(reservationRouter.walletReservationsCount(dst)), 1);

        // The wallet-state precondition of the strand is met, yet it reverts.
        vm.expectRevert(bytes(ERR_NOT_ACTIVE));
        reservationRouter.notifyReservationStranded(key);
        assertEq(uint256(reservationRouter.walletReservationsCount(src)), 1);
    }

    /// @notice Before dissolutionEligibleAt the strand is refused on a
    ///         Closing wallet, down to the last second, and the honest
    ///         reanchor is allowed. A pending reanchor then keeps blocking the
    ///         strand after eligibility. Numbers: wallet Closing at
    ///         T0 + 15 days, eligible at T0 + 91 days, i.e. 76 days of
    ///         exclusive reanchor window with no one needing to act early.
    function test_F08_noStrandBeforeEligibilityAndPendingReanchorBlocksIt()
        public
    {
        (uint256 key, bytes20 src, bytes20 dst) = _openReservation();
        Reservation.ReservationRequest memory r0 = reservationRouter
            .reservations(key);
        uint256 eligibleAt = _dissolutionEligibleAt(r0);

        vm.warp(uint256(r0.acceptedAt) + 15 days);
        _forceClosing(src);
        assertEq(eligibleAt - block.timestamp, 76 days, "window length");

        vm.expectRevert(bytes(ERR_WALLET_NOT_STRANDABLE));
        reservationRouter.notifyReservationStranded(key);

        vm.warp(eligibleAt - 1);
        vm.expectRevert(bytes(ERR_WALLET_NOT_STRANDABLE));
        reservationRouter.notifyReservationStranded(key);

        // Reanchor is allowed in the very same second.
        vm.prank(honest);
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );

        vm.warp(eligibleAt);
        vm.expectRevert(bytes(ERR_NOT_ACTIVE));
        reservationRouter.notifyReservationStranded(key);
    }

    /// @notice A re-anchor request that times out starts a cooldown of one
    ///         action timeout. With the R-07 window the strand stays closed
    ///         until the wallet's closing period ends, so it cannot land
    ///         inside the cooldown (test/fizz/Base.sol: action timeout 1 day,
    ///         closing period 2 days, both counted from the same second).
    function test_F08_noStrandInsideReanchorCooldownAfterTimedOutRequest()
        public
    {
        (uint256 key, bytes20 src, bytes20 dst) = _openReservation();
        Reservation.ReservationRequest memory r0 = reservationRouter
            .reservations(key);
        vm.warp(_dissolutionEligibleAt(r0));
        _forceClosing(src);
        uint256 closingEnd =
            uint256(bridge.wallets(src).closingStartedAt) +
                WALLET_CLOSING_PERIOD;

        vm.prank(honest);
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );
        uint64 nonce = reservationRouter.reservations(key).requestNonce;
        uint32 timeoutAt = reservationRouter
            .reservationActions(key, nonce)
            .timeoutAt;

        vm.warp(timeoutAt);
        vm.prank(attacker);
        reservationRouter.notifyReservationActionTimeout(key);
        Reservation.ReservationRequest memory r1 = reservationRouter
            .reservations(key);
        assertLe(
            uint256(r1.reanchorCooldownUntil),
            closingEnd,
            "cooldown ends inside the window"
        );

        // Inside the cooldown neither the honest retry nor a strand lands.
        vm.prank(honest);
        vm.expectRevert(bytes(ERR_COOLDOWN));
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );
        vm.prank(attacker);
        vm.expectRevert(bytes(ERR_WALLET_NOT_STRANDABLE));
        reservationRouter.notifyReservationStranded(key);

        // At the end of the cooldown the honest retry goes through.
        vm.warp(r1.reanchorCooldownUntil);
        vm.prank(honest);
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.ActionPending))
        );
    }

    // ------------------------------------------------------------------
    // Downstream consequence
    // ------------------------------------------------------------------

    /// @notice The reservation blocks the Closing -> Closed step
    ///         ("Wallet still custodies reservations") until it is stranded.
    ///         After the strand the wallet closes with the 50_000 sat anchor
    ///         untouched on Bitcoin: no spend was proven, the main UTXO is
    ///         empty, and nothing tracks the anchor any more.
    function test_F08_strandedWalletClosesWithAnchorUnspent() public {
        (uint256 key, bytes20 src, bytes20 dst) = _openReservation();
        Reservation.ReservationRequest memory r0 = reservationRouter
            .reservations(key);
        vm.warp(_dissolutionEligibleAt(r0));
        _forceClosing(src);

        uint256 closeAt =
            uint256(bridge.wallets(src).closingStartedAt) +
                WALLET_CLOSING_PERIOD +
                1;
        vm.warp(closeAt);

        // Control: the reservation pins the wallet in Closing.
        vm.expectRevert(bytes(ERR_WALLET_HAS_RESERVATIONS));
        bridge.notifyWalletClosingPeriodElapsed(src);

        // Anyone strands it (the honest reanchor never happened).
        vm.prank(attacker);
        reservationRouter.notifyReservationStranded(key);

        vm.prank(attacker);
        bridge.notifyWalletClosingPeriodElapsed(src);

        Wallets.Wallet memory w = bridge.wallets(src);
        assertEq(uint256(uint8(w.state)), _w(Wallets.WalletState.Closed));
        assertEq(w.mainUtxoHash, bytes32(0), "no main UTXO");
        assertFalse(
            bridge.spentMainUTXOs(_utxoKey(r0.anchorTxHash)),
            "anchor never spent"
        );
        Reservation.ReservationRequest memory r1 = reservationRouter
            .reservations(key);
        assertEq(uint256(r1.anchorAmount), ANCHOR_SAT);
        assertEq(
            reservationRouter.reservationByAnchorUtxo(r0.anchorTxHash, 0),
            0
        );

        vm.prank(honest);
        vm.expectRevert(bytes(ERR_NOT_ACTIVE));
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Wallet 1 is registered first so that it becomes the active wallet;
    ///      wallet 0 (setup's wallet) is then a non-active Live wallet that
    ///      custodies a freshly accepted 50_000 sat reservation.
    function _openReservation()
        internal
        returns (uint256 key, bytes20 src, bytes20 dst)
    {
        dst = _registerWalletFromKey(1);
        src = harnessWallets[0];

        // amount = 12_001 (R-09 floor: minAmount + 2 * txMaxFee + 1)
        // + 37_999 = 50_000 sat, miner fee 0, wallet index 0.
        reservationRouter_revealAndAcceptReservedDeposit_flow(37_999, 0, 1, 0);

        require(harnessReservationKeys.length == 1, "F08: no reservation");
        key = harnessReservationKeys[0];
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        require(
            r.state == Reservation.ReservationState.Active,
            "F08: not active"
        );
        require(r.walletPubKeyHash == src, "F08: wrong wallet");
        require(r.anchorAmount == ANCHOR_SAT, "F08: wrong anchor amount");
    }

    /// @dev What the attack does, minus the strand: any account pushes a
    ///      non-active Live wallet with no main UTXO to Closing.
    function _forceClosing(bytes20 wallet) internal {
        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        vm.startPrank(attacker);
        bridge.notifyWalletCloseable(wallet, none);
        bridge.notifyMovingFundsBelowDust(wallet, none);
        vm.stopPrank();
    }

    function _dissolutionEligibleAt(
        Reservation.ReservationRequest memory r
    ) internal pure returns (uint256) {
        return uint256(r.dissolutionEligibleAt);
    }

    function _ws(bytes20 wallet) internal view returns (uint256) {
        return uint256(uint8(bridge.wallets(wallet).state));
    }

    function _w(Wallets.WalletState s) internal pure returns (uint256) {
        return uint256(uint8(s));
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
