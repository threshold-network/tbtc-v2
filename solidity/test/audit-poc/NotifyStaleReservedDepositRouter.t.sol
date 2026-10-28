// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression test for the mutation `self.notifyStaleReservedDeposit(depositKey);`
// -> `revert();` at ReservationRouter.sol:386. Before this file, the Foundry
// gate (test/{fizz,fizz-periphery,audit-poc}/**) never completed a successful
// router call to `notifyStaleReservedDeposit`, so the mutant survived.
//
// Source lines involved (solidity/contracts/bridge):
//   ReservationRouter.sol:385-387  notifyStaleReservedDeposit entry point the
//                                  production Bridge exposes through its
//                                  fallback; forwards to the library call
//   Reservation.sol:1128-1166      notifyStaleReservedDeposit: requires a
//                                  pending marker, an unswept deposit, a
//                                  block.timestamp strictly greater than the
//                                  snapshotted refund deadline, and no
//                                  pending acceptance action; then wipes
//                                  walletPubKeyHash, refundDeadline and
//                                  refundDeadlineValidated, decrements
//                                  pendingReservedDeposits and emits
//                                  ReservedDepositMarkedStale(depositKey)
//   Deposit.sol:215-233            reveal-time refund deadline: for a reserved
//                                  deposit it is the exact refund locktime of
//                                  the deposit script
//
// Hardhat counterpart: test/bridge/Bridge.ReservationStranding.test.ts,
// describe("notifyStaleReservedDeposit").
//
// The deposit is revealed through the real Bridge.revealDeposit and the stale
// call goes through the real Bridge fallback into ReservationRouter, using the
// deployment built by test/fizz/Base.sol.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";

contract NotifyStaleReservedDepositRouterTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    event ReservedDepositMarkedStale(uint256 indexed depositKey);

    string internal constant ERR_NOT_PENDING = "Not a pending reserved deposit";
    string internal constant ERR_DEADLINE_NOT_ELAPSED =
        "Deposit refund deadline has not elapsed";
    string internal constant ERR_ACCEPTANCE_PENDING =
        "Acceptance authorization pending";
    string internal constant ERR_WRONG_WALLET =
        "Wallet is not the deposit's designated wallet";

    address internal depositor;
    address internal anyone;
    bytes20 internal wallet0;
    uint256 internal nonce;

    function setUp() public {
        setup();
        wallet0 = BtcBuilder.pubKeyHash(walletPubX[0], walletPubY[0]);
        depositor = makeAddr("stale.depositor");
        anyone = makeAddr("stale.anyone");
    }

    // ------------------------------------------------------------------
    // Positive case
    // ------------------------------------------------------------------

    /// @notice Once the refund deadline has strictly elapsed, any account can
    ///         call the router entry point. The pending marker is wiped, the
    ///         pending-reserved-deposit counter drops by one, the event is
    ///         emitted, and the deposit can no longer be authorized for
    ///         acceptance.
    function test_notifyStaleReservedDeposit_routerClearsStaleReservedDeposit()
        public
    {
        (uint256 key, uint32 deadline) = _revealReserved(wallet0);

        // Pre-state: pending marker set, one pending reserved deposit.
        assertEq(
            reservationRouter.reservedDepositWallet(key),
            wallet0,
            "pending marker set"
        );
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 1);
        assertTrue(bridge.isReservedDeposit(key), "classified as reserved");
        assertEq(uint256(bridge.deposits(key).sweptAt), 0, "not swept");

        // Strictly past the refund deadline: `block.timestamp > deadline`.
        vm.warp(uint256(deadline) + 1);

        vm.expectEmit(true, false, false, true, address(bridge));
        emit ReservedDepositMarkedStale(key);
        vm.prank(anyone);
        reservationRouter.notifyStaleReservedDeposit(key);

        // The marker is wiped and the guard counter decremented.
        assertEq(
            reservationRouter.reservedDepositWallet(key),
            bytes20(0),
            "pending marker cleared"
        );
        assertEq(
            uint256(reservationRouter.pendingReservedDeposits()),
            0,
            "pending reserved deposits decremented"
        );
        // The reserved classification is deliberately kept.
        assertTrue(bridge.isReservedDeposit(key), "reserved bit kept");
        // No reservation position or capacity was created or touched.
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.Unknown))
        );
        assertEq(uint256(reservationRouter.walletReservationsCount(wallet0)), 0);

        // A stale deposit cannot be authorized for acceptance any more.
        vm.prank(depositor);
        vm.expectRevert(bytes(ERR_WRONG_WALLET));
        reservationRouter.requestReservationAcceptance(key, wallet0);

        // It cannot be marked stale twice.
        vm.prank(anyone);
        vm.expectRevert(bytes(ERR_NOT_PENDING));
        reservationRouter.notifyStaleReservedDeposit(key);
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 0);
    }

    /// @notice With two pending reserved deposits only the called one is
    ///         cleared: the counter goes 2 -> 1 and the other marker stays.
    function test_notifyStaleReservedDeposit_routerClearsOnlyTheCalledDeposit()
        public
    {
        (uint256 keyA, uint32 deadlineA) = _revealReserved(wallet0);
        (uint256 keyB, uint32 deadlineB) = _revealReserved(wallet0);
        assertTrue(keyA != keyB, "distinct deposits");
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 2);

        uint32 later = deadlineA > deadlineB ? deadlineA : deadlineB;
        vm.warp(uint256(later) + 1);

        vm.prank(anyone);
        reservationRouter.notifyStaleReservedDeposit(keyA);

        assertEq(reservationRouter.reservedDepositWallet(keyA), bytes20(0));
        assertEq(reservationRouter.reservedDepositWallet(keyB), wallet0);
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 1);

        vm.prank(anyone);
        reservationRouter.notifyStaleReservedDeposit(keyB);

        assertEq(reservationRouter.reservedDepositWallet(keyB), bytes20(0));
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 0);
    }

    // ------------------------------------------------------------------
    // Negative cases
    // ------------------------------------------------------------------

    /// @notice Up to and including the refund deadline second the call
    ///         reverts and changes nothing; one second later it succeeds.
    function test_notifyStaleReservedDeposit_routerRevertsBeforeRefundDeadline()
        public
    {
        (uint256 key, uint32 deadline) = _revealReserved(wallet0);

        vm.prank(anyone);
        vm.expectRevert(bytes(ERR_DEADLINE_NOT_ELAPSED));
        reservationRouter.notifyStaleReservedDeposit(key);

        vm.warp(uint256(deadline));
        vm.prank(anyone);
        vm.expectRevert(bytes(ERR_DEADLINE_NOT_ELAPSED));
        reservationRouter.notifyStaleReservedDeposit(key);

        assertEq(reservationRouter.reservedDepositWallet(key), wallet0);
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 1);

        vm.warp(uint256(deadline) + 1);
        vm.prank(anyone);
        reservationRouter.notifyStaleReservedDeposit(key);
        assertEq(reservationRouter.reservedDepositWallet(key), bytes20(0));
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 0);
    }

    /// @notice An unknown deposit key is rejected with the exact string.
    function test_notifyStaleReservedDeposit_routerRevertsForUnknownDeposit()
        public
    {
        vm.prank(anyone);
        vm.expectRevert(bytes(ERR_NOT_PENDING));
        reservationRouter.notifyStaleReservedDeposit(uint256(0xdead));
    }

    /// @notice A pending acceptance authorization blocks the stale call even
    ///         past the refund deadline. The request is made while the
    ///         deadline is still far enough away, then the clock moves past
    ///         the deadline without the action timing out.
    function test_notifyStaleReservedDeposit_routerRevertsWhilePendingAcceptance()
        public
    {
        (uint256 key, uint32 deadline) = _revealReserved(wallet0);

        vm.prank(depositor);
        reservationRouter.requestReservationAcceptance(key, wallet0);

        // Past the refund deadline. The action is still `Pending` because
        // nobody called `notifyReservationAcceptanceTimedOut`.
        vm.warp(uint256(deadline) + 1);

        vm.prank(anyone);
        vm.expectRevert(bytes(ERR_ACCEPTANCE_PENDING));
        reservationRouter.notifyStaleReservedDeposit(key);

        assertEq(reservationRouter.reservedDepositWallet(key), wallet0);
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 1);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Reveals an unfunded reserved deposit through the real Bridge and
    ///      returns its key and the exact refund deadline of its script.
    function _revealReserved(bytes20 wallet)
        internal
        returns (uint256 key, uint32 deadline)
    {
        bytes32 entropy = keccak256(abi.encode("stale.deposit", ++nonce));
        deadline = uint32(
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
        (BitcoinTx.Info memory fundingTx, uint32 outputIndex) = BtcBuilder
            .depositFundingTx(
                reveal,
                depositor,
                bytes32(0),
                false,
                uint256(entropy) % 2 == 0,
                50_000,
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

    function _le32(uint32 v) internal pure returns (bytes4) {
        return
            bytes4(
                (v << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | (v >> 24)
            );
    }
}
