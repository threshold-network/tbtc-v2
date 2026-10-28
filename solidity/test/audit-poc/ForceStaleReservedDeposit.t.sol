// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression test for the mutation `self.pendingReservedDeposits -= 1;` ->
// commented out at Reservation.sol:1211 in `forceStaleReservedDeposit`. With
// the decrement gone the pending-reserved-deposit counter stays inflated
// after a governance force-clear, and that counter blocks governance from
// changing `reservationVault` until it is zero. Before this file neither the
// Foundry gate (test/{fizz,fizz-periphery,audit-poc}/**) nor Hardhat checked
// the counter after a successful force-clear, so the mutant survived.
//
// Source lines involved (solidity/contracts/bridge):
//   ReservationRouter.sol:399-404  forceStaleReservedDeposit entry point,
//                                  `onlyGovernance`, forwards to the library
//   Reservation.sol:1184-1214      forceStaleReservedDeposit: requires a
//                                  pending marker, an unswept deposit and no
//                                  pending acceptance action; it does NOT
//                                  check the refund deadline. It wipes
//                                  walletPubKeyHash, refundDeadline and
//                                  refundDeadlineValidated, decrements
//                                  pendingReservedDeposits and emits
//                                  ReservedDepositMarkedStale(depositKey)
//   Reservation.sol:1301-1318      vault change guard in
//                                  updateReservationParameters: a different
//                                  vault needs maxActiveReservations > 0
//                                  (when the new vault is non-zero), a zero
//                                  reservationTotalAmount ("Active
//                                  reservations exist") and a zero
//                                  pendingReservedDeposits ("Pending reserved
//                                  deposits exist")
//   Deposit.sol:215-233            reveal-time refund deadline: for a reserved
//                                  deposit it is the exact refund locktime of
//                                  the deposit script
//
// Companion of NotifyStaleReservedDepositRouter.t.sol, which covers the
// permissionless stale path after the refund deadline.
//
// The deposits are revealed through the real Bridge.revealDeposit and the
// governance call goes through the real Bridge fallback into
// ReservationRouter, using the deployment built by test/fizz/Base.sol.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";

contract ForceStaleReservedDepositTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    event ReservedDepositMarkedStale(uint256 indexed depositKey);
    event ReservationVaultUpdated(address reservationVault);

    string internal constant ERR_NOT_GOVERNANCE =
        "Caller is not the governance";
    string internal constant ERR_NOT_PENDING = "Not a pending reserved deposit";
    string internal constant ERR_PENDING_EXIST =
        "Pending reserved deposits exist";

    address internal depositor;
    address internal anyone;
    bytes20 internal wallet0;
    uint256 internal nonce;

    function setUp() public {
        setup();
        wallet0 = BtcBuilder.pubKeyHash(walletPubX[0], walletPubY[0]);
        depositor = makeAddr("force.depositor");
        anyone = makeAddr("force.anyone");
    }

    // ------------------------------------------------------------------
    // Positive cases
    // ------------------------------------------------------------------

    /// @notice Governance clears pending reserved deposits one at a time
    ///         while the refund deadline is still far away. Each call drops
    ///         the counter by exactly one, wipes only the called marker and
    ///         emits the event.
    function test_forceStale_clearsTheCounterBeforeTheDeadline() public {
        (uint256 keyA, uint32 deadlineA) = _revealReserved(wallet0);
        (uint256 keyB, uint32 deadlineB) = _revealReserved(wallet0);
        assertTrue(keyA != keyB, "distinct deposits");
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 2);
        assertEq(reservationRouter.reservedDepositWallet(keyA), wallet0);
        assertEq(reservationRouter.reservedDepositWallet(keyB), wallet0);

        // The refund deadlines are still in the future for both deposits.
        assertLt(block.timestamp, uint256(deadlineA), "A before deadline");
        assertLt(block.timestamp, uint256(deadlineB), "B before deadline");

        vm.expectEmit(true, false, false, true, address(bridge));
        emit ReservedDepositMarkedStale(keyA);
        vm.prank(governance);
        reservationRouter.forceStaleReservedDeposit(keyA);

        assertEq(
            reservationRouter.reservedDepositWallet(keyA),
            bytes20(0),
            "first marker cleared"
        );
        assertEq(
            reservationRouter.reservedDepositWallet(keyB),
            wallet0,
            "second marker untouched"
        );
        assertEq(
            uint256(reservationRouter.pendingReservedDeposits()),
            1,
            "counter decremented once"
        );
        // The reserved classification is deliberately kept.
        assertTrue(bridge.isReservedDeposit(keyA), "reserved bit kept");

        vm.expectEmit(true, false, false, true, address(bridge));
        emit ReservedDepositMarkedStale(keyB);
        vm.prank(governance);
        reservationRouter.forceStaleReservedDeposit(keyB);

        assertEq(
            reservationRouter.reservedDepositWallet(keyB),
            bytes20(0),
            "second marker cleared"
        );
        assertEq(
            uint256(reservationRouter.pendingReservedDeposits()),
            0,
            "counter back to zero"
        );

        // A cleared entry cannot be force-cleared twice.
        vm.prank(governance);
        vm.expectRevert(bytes(ERR_NOT_PENDING));
        reservationRouter.forceStaleReservedDeposit(keyA);
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 0);
    }

    /// @notice The vault-change guard reads the counter. While one reserved
    ///         deposit is still pending the vault change reverts; once
    ///         governance has force-cleared every pending deposit the same
    ///         change succeeds. A counter left inflated by a missing
    ///         decrement keeps the change blocked forever.
    function test_forceStale_zeroCounterUnblocksVaultChange() public {
        (uint256 keyA, ) = _revealReserved(wallet0);
        (uint256 keyB, ) = _revealReserved(wallet0);
        address newVault = makeAddr("force.newVault");
        address oldVault = address(reservationVault);

        // Preconditions of the other guard branches hold, so only the
        // pending-reserved-deposit counter can block the change.
        (uint32 active, uint32 maxActive) = reservationRouter
            .activeReservationsCount();
        assertEq(uint256(active), 0, "no active reservations");
        assertGt(uint256(maxActive), 0, "max active reservations set");
        assertEq(_reservationParameterWords()[6], 0, "no reserved amount");
        assertEq(
            uint256(_reservationParameterWords()[0]),
            uint256(uint160(oldVault))
        );

        // Two pending: blocked.
        _expectVaultChangeReverts(newVault);

        // One still pending after the first force-clear: still blocked.
        vm.prank(governance);
        reservationRouter.forceStaleReservedDeposit(keyA);
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 1);
        _expectVaultChangeReverts(newVault);
        assertEq(
            _reservationParameterWords()[0],
            uint256(uint160(oldVault)),
            "vault unchanged while blocked"
        );

        // Nothing pending: the change goes through.
        vm.prank(governance);
        reservationRouter.forceStaleReservedDeposit(keyB);
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 0);

        uint256[10] memory words = _reservationParameterWords();
        vm.expectEmit(false, false, false, true, address(bridge));
        emit ReservationVaultUpdated(newVault);
        _updateVault(words, newVault);
        assertEq(
            _reservationParameterWords()[0],
            uint256(uint160(newVault)),
            "vault changed"
        );
    }

    // ------------------------------------------------------------------
    // Negative cases
    // ------------------------------------------------------------------

    /// @notice Only governance may force-clear. Any other caller reverts with
    ///         the exact governance string and nothing changes.
    function test_forceStale_onlyGovernance() public {
        (uint256 key, ) = _revealReserved(wallet0);

        vm.prank(anyone);
        vm.expectRevert(bytes(ERR_NOT_GOVERNANCE));
        reservationRouter.forceStaleReservedDeposit(key);

        vm.prank(depositor);
        vm.expectRevert(bytes(ERR_NOT_GOVERNANCE));
        reservationRouter.forceStaleReservedDeposit(key);

        assertEq(reservationRouter.reservedDepositWallet(key), wallet0);
        assertEq(uint256(reservationRouter.pendingReservedDeposits()), 1);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Expects the vault change to revert with the pending-deposit
    ///      guard string. The parameter words are read before the revert
    ///      expectation is armed, because the read is an external call.
    function _expectVaultChangeReverts(address newVault) internal {
        uint256[10] memory w = _reservationParameterWords();
        vm.expectRevert(bytes(ERR_PENDING_EXIST));
        _updateVault(w, newVault);
    }

    /// @dev Resubmits the given reservation parameter words through
    ///      governance with only the vault replaced. Word 6 of
    ///      `reservationParameters()` is the running total and is not an
    ///      argument of the setter. Makes exactly one external call.
    function _updateVault(uint256[10] memory w, address newVault) internal {
        vm.prank(governance);
        reservationRouter.updateReservationParameters(
            newVault,
            uint64(w[1]),
            uint64(w[2]),
            uint32(w[3]),
            uint32(w[4]),
            uint64(w[5]),
            uint32(w[7]),
            uint32(w[8]),
            uint32(w[9])
        );
    }

    /// @dev The ten static return words of `reservationParameters()`.
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
    ///      returns its key and the exact refund deadline of its script.
    function _revealReserved(
        bytes20 wallet
    ) internal returns (uint256 key, uint32 deadline) {
        bytes32 entropy = keccak256(abi.encode("force.deposit", ++nonce));
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
                (v << 24) |
                    ((v & 0xff00) << 8) |
                    ((v >> 8) & 0xff00) |
                    (v >> 24)
            );
    }
}
