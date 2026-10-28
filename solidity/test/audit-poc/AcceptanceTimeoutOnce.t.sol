// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression test for the mutation that comments out
// `require(action.state == ActionState.Pending, "Action is not pending");`
// at Reservation.sol:674 in `notifyReservationAcceptanceTimedOut`. Before this
// file neither the Foundry gate nor Hardhat could tell the mutant from the
// original, so it survived.
//
// Source lines involved (solidity/contracts/bridge):
//   Reservation.sol:656-692   notifyReservationAcceptanceTimedOut: requires an
//                             acceptance action, then `Pending` state, then
//                             `block.timestamp >= timeoutAt`; sets the action
//                             to `TimedOut` and calls
//                             `releaseAcceptanceCapacity`
//   Reservation.sol:963-973   releaseAcceptanceCapacity: decrements the
//                             wallet count and amount, the global reserved
//                             total and the global occupancy
//   Reservation.sol:921-959   reserveAcceptanceCapacity: the matching
//                             reservation done at request time
//
// Why the pending check is the only guard: after the first notification the
// action is `TimedOut`, but its `timeoutAt` is still in the past and the
// reservation's `requestNonce` still points at that action. Without the
// check a second notification passes every other require and releases the
// same capacity a second time. That steals the capacity held by other
// pending acceptances. With a single acceptance on the wallet the second
// release would underflow and revert anyway, which would hide the mutant, so
// the test keeps a second acceptance (B) on the same wallet. After A's
// release the wallet counters are non-zero, and the mutant would silently
// release B's share.
//
// Both deposits are revealed through the real Bridge.revealDeposit and all
// acceptance calls go through the real Bridge fallback into
// ReservationRouter, using the deployment built by test/fizz/Base.sol. The
// Base caps (5 reservations per wallet, 100 active, 100_000 sat single cap)
// admit two 50_000 sat acceptances on one wallet, so no cap change is needed.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";

contract AcceptanceTimeoutOnceTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    string internal constant ERR_NOT_PENDING = "Action is not pending";

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
        depositor = makeAddr("timeoutonce.depositor");
        anyone = makeAddr("timeoutonce.anyone");
    }

    /// @notice Two pending acceptances A and B on one wallet. A times out and
    ///         is reported once: its capacity, and only its capacity, is
    ///         released. Reporting A again reverts and leaves B's capacity
    ///         held. The mutant without the pending check accepts the second
    ///         report and releases B's share.
    function test_acceptanceTimeout_secondNotificationReverts() public {
        (uint256 keyA, ) = _revealReserved(wallet0);
        (uint256 keyB, ) = _revealReserved(wallet0);
        assertTrue(keyA != keyB, "distinct deposits");

        Counters memory beforeAny = _counters(wallet0);

        _requestAcceptanceAs(depositor, keyA, wallet0);
        _requestAcceptanceAs(depositor, keyB, wallet0);

        Reservation.ReservationAction memory actionA = reservationRouter
            .reservationActions(keyA, 1);
        Reservation.ReservationAction memory actionB = reservationRouter
            .reservationActions(keyB, 1);
        assertEq(
            uint256(uint8(actionA.state)),
            uint256(uint8(Reservation.ActionState.Pending)),
            "A pending"
        );
        assertEq(
            uint256(uint8(actionB.state)),
            uint256(uint8(Reservation.ActionState.Pending)),
            "B pending"
        );
        assertTrue(actionA.amount > 0, "A reserved a non-zero amount");

        // Both positions are reserved against the wallet and the globals.
        Counters memory held = _counters(wallet0);
        assertEq(
            uint256(held.walletCount),
            uint256(beforeAny.walletCount) + 2,
            "two positions held"
        );
        assertEq(
            uint256(held.walletAmount),
            uint256(beforeAny.walletAmount) +
                uint256(actionA.amount) +
                uint256(actionB.amount),
            "both amounts held on the wallet"
        );
        assertEq(
            uint256(held.reservedTotal),
            uint256(beforeAny.reservedTotal) +
                uint256(actionA.amount) +
                uint256(actionB.amount),
            "both amounts held globally"
        );
        assertEq(
            uint256(held.occupancy),
            uint256(beforeAny.occupancy) + 2,
            "two occupancy slots held"
        );

        // First report: succeeds exactly at `timeoutAt`.
        vm.warp(uint256(actionA.timeoutAt));
        vm.prank(anyone);
        reservationRouter.notifyReservationAcceptanceTimedOut(keyA);

        assertEq(
            uint256(uint8(reservationRouter.reservationActions(keyA, 1).state)),
            uint256(uint8(Reservation.ActionState.TimedOut)),
            "A timed out"
        );

        // Control: the first report released exactly A's capacity, one
        // position, and left B's share in place.
        Counters memory afterFirst = _counters(wallet0);
        assertEq(
            uint256(afterFirst.walletCount),
            uint256(held.walletCount) - 1,
            "wallet count dropped by one position"
        );
        assertEq(
            uint256(afterFirst.walletAmount),
            uint256(held.walletAmount) - uint256(actionA.amount),
            "wallet amount dropped by A's amount"
        );
        assertEq(
            uint256(afterFirst.reservedTotal),
            uint256(held.reservedTotal) - uint256(actionA.amount),
            "global total dropped by A's amount"
        );
        assertEq(
            uint256(afterFirst.occupancy),
            uint256(held.occupancy) - 1,
            "occupancy dropped by one position"
        );
        // B's share is still held, so the counters are not at the baseline.
        assertEq(
            uint256(afterFirst.walletCount),
            uint256(beforeAny.walletCount) + 1,
            "B's position still counted"
        );
        assertEq(
            uint256(afterFirst.walletAmount),
            uint256(beforeAny.walletAmount) + uint256(actionB.amount),
            "B's amount still counted"
        );

        // Second report of the same action: rejected, nothing changes.
        vm.prank(anyone);
        vm.expectRevert(bytes(ERR_NOT_PENDING));
        reservationRouter.notifyReservationAcceptanceTimedOut(keyA);

        Counters memory afterSecond = _counters(wallet0);
        assertEq(
            uint256(afterSecond.walletCount),
            uint256(afterFirst.walletCount),
            "wallet count unchanged by second report"
        );
        assertEq(
            uint256(afterSecond.walletAmount),
            uint256(afterFirst.walletAmount),
            "wallet amount unchanged by second report"
        );
        assertEq(
            uint256(afterSecond.reservedTotal),
            uint256(afterFirst.reservedTotal),
            "global total unchanged by second report"
        );
        assertEq(
            uint256(afterSecond.occupancy),
            uint256(afterFirst.occupancy),
            "occupancy unchanged by second report"
        );

        // B is still pending and its capacity is still held.
        assertEq(
            uint256(uint8(reservationRouter.reservationActions(keyB, 1).state)),
            uint256(uint8(Reservation.ActionState.Pending)),
            "B still pending"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Reads the wallet exposure (count and amount), the global
    ///      reserved total and the global occupancy from the router getters.
    function _counters(
        bytes20 wallet
    ) internal view returns (Counters memory c) {
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

    /// @dev Reveals an unfunded reserved deposit through the real Bridge and
    ///      returns its key and the exact refund deadline of its script. The
    ///      deadline is 91 days out, far beyond `timeoutAt + 24h`.
    function _revealReserved(
        bytes20 wallet
    ) internal returns (uint256 key, uint32 deadline) {
        bytes32 entropy = keccak256(abi.encode("timeoutonce.deposit", ++nonce));
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
        _recordFunding(key, fundingTx, outputIndex);
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
