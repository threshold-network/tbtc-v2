// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

// The reveal-time refund locktime cap for reserved deposits, promoted from
// the opt-in audit PoC (`test/audit-poc/ReservationTimeBounds.t.sol`) into the
// CI-visible Foundry suite.
//
// `Deposit._revealDeposit` caps the refund deadline of a *reserved* deposit
// at `now + reservationTermSeconds + DEPOSIT_REFUND_SAFETY_MARGIN` and reverts
// with "Refund locktime too far in the future for a reservation" above it.
// The cap keeps a reserved deposit that is never anchored able to clear
// itself, so the pending-reserved counter (which blocks a vault change)
// cannot be parked forever.
//
// This suite covers the cap from both sides: one second past the cap is
// rejected, exactly at the cap is accepted and recorded as reserved, and the
// same far-future locktime on a *pool* (non-reserved) reveal is accepted,
// because the cap is scoped to reserved deposits only.
//
// The fixture is the `test/fizz` deployment (`Base.sol`): the real Bridge
// with the real ReservationVault, ReservationRouter and Bank, so the test
// drives the production `Bridge.revealDeposit` path. The `reservations/`
// suite's `ReservationStackHarness` writes the reveal-time records itself
// and never calls `Deposit._revealDeposit`, so it cannot reach the cap.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../test/fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../test/fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../contracts/bridge/Deposit.sol";
import {WalletProposalValidatorConstants} from "../contracts/bridge/WalletProposalValidatorConstants.sol";

contract ReservationRefundLocktimeCapTest is Test, Handlers {
    string internal constant ERR_LOCKTIME =
        "Refund locktime too far in the future for a reservation";

    uint64 internal constant DEPOSIT_SAT = 50_000;

    address internal depositor;
    bytes20 internal wallet0;
    uint256 internal nonce;

    /// @dev The cap the Bridge enforces on a reserved reveal:
    ///      `now + reservationTermSeconds + DEPOSIT_REFUND_SAFETY_MARGIN`.
    uint256 internal constant REFUND_MARGIN = WalletProposalValidatorConstants
        .DEPOSIT_REFUND_SAFETY_MARGIN;

    function setUp() public {
        setup();
        wallet0 = BtcBuilder.pubKeyHash(walletPubX[0], walletPubY[0]);
        depositor = makeAddr("refundlocktime.depositor");
    }

    /// @notice One second past the cap the reserved reveal is rejected.
    function test_reservedReveal_rejectsLocktimeOneSecondPastCap() public {
        uint32 deadline = _capDeadline() + 1;
        (
            BitcoinTx.Info memory fundingTx,
            Deposit.DepositRevealInfo memory reveal,
            uint256 key
        ) = _buildReveal(deadline, address(reservationVault));

        vm.prank(depositor);
        vm.expectRevert(bytes(ERR_LOCKTIME));
        bridge.revealDeposit(fundingTx, reveal);
        assertFalse(
            bridge.isReservedDeposit(key),
            "rejected reveal was not recorded"
        );
    }

    /// @notice Exactly at the cap the reserved reveal is accepted and the
    ///         deposit is recorded as reserved.
    function test_reservedReveal_acceptsLocktimeAtCap() public {
        uint32 deadline = _capDeadline();
        (
            BitcoinTx.Info memory fundingTx,
            Deposit.DepositRevealInfo memory reveal,
            uint256 key
        ) = _buildReveal(deadline, address(reservationVault));

        vm.prank(depositor);
        bridge.revealDeposit(fundingTx, reveal);

        assertTrue(bridge.isReservedDeposit(key), "recorded as reserved");
    }

    /// @notice The cap is scoped to reserved deposits: a pool reveal with the
    ///         same far-future locktime is accepted and is not reserved.
    function test_poolReveal_acceptsSameFarFutureLocktime() public {
        uint32 deadline = _capDeadline() + 1;
        (
            BitcoinTx.Info memory fundingTx,
            Deposit.DepositRevealInfo memory reveal,
            uint256 key
        ) = _buildReveal(deadline, address(0));

        vm.prank(depositor);
        bridge.revealDeposit(fundingTx, reveal);

        assertFalse(bridge.isReservedDeposit(key), "not reserved");
        assertTrue(
            bridge.deposits(key).revealedAt != 0,
            "pool deposit was revealed"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev The highest refund deadline a reserved reveal may carry:
    ///      `now + reservationTermSeconds + DEPOSIT_REFUND_SAFETY_MARGIN`.
    function _capDeadline() internal view returns (uint32) {
        return
            uint32(
                block.timestamp +
                    uint256(RESERVATION_TERM_SECONDS) +
                    REFUND_MARGIN
            );
    }

    /// @dev Builds a deposit funding transaction and its reveal info for a
    ///      deposit that routes to `vault` (the reservation vault for a
    ///      reserved deposit, the zero address for a pool deposit).
    function _buildReveal(
        uint32 deadline,
        address vault
    )
        internal
        returns (
            BitcoinTx.Info memory fundingTx,
            Deposit.DepositRevealInfo memory reveal,
            uint256 key
        )
    {
        bytes32 entropy = keccak256(
            abi.encode("refundlocktime.deposit", ++nonce)
        );
        reveal = Deposit.DepositRevealInfo({
            fundingOutputIndex: 0,
            blindingFactor: bytes8(keccak256(abi.encode(entropy, "blinding"))),
            walletPubKeyHash: wallet0,
            refundPubKeyHash: bytes20(
                keccak256(abi.encode(entropy, depositor, "refund"))
            ),
            refundLocktime: _le32(deadline),
            vault: vault
        });
        uint32 outputIndex;
        (fundingTx, outputIndex) = BtcBuilder.depositFundingTx(
            reveal,
            depositor,
            bytes32(0),
            false,
            true,
            DEPOSIT_SAT,
            entropy
        );
        reveal.fundingOutputIndex = outputIndex;
        key = uint256(
            keccak256(
                abi.encodePacked(BtcBuilder.txHash(fundingTx), outputIndex)
            )
        );
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
