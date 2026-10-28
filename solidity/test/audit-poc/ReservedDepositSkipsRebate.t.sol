// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression test for the mutation that comments out `!isReserved &&` at
// Deposit.sol:407 in `_revealDeposit`. Before this file neither the Foundry
// gate nor the Hardhat suite could tell the mutant from the original, so it
// survived.
//
// Source lines involved (solidity/contracts/bridge):
//   Deposit.sol:381-383   deposit.treasuryFee = amount / depositTreasuryFeeDivisor
//                         (zero only when the divisor is zero)
//   Deposit.sol:397-417   the rebate is applied only when the deposit is not
//                         reserved, the fee is above zero and the Bridge has a
//                         RebateStaking address. A reserved deposit is never
//                         charged the fee (acceptance mints the gross amount),
//                         so calling `applyForRebate` would burn the
//                         depositor's rolling-window rebate budget for nothing
//   RebateStaking.sol:371-403  applyForRebate pushes a rebate entry into the
//                         staker's rolling window and returns the fee minus
//                         the rebate
//
// How the preconditions of the mutated branch are met (and asserted so the
// test cannot pass vacuously):
//   - `treasuryFee > 0`: test/fizz/Base.sol already sets the deposit treasury
//     fee divisor to DEPOSIT_TREASURY_FEE_DIVISOR (2000) through
//     `updateDepositParameters`. The test reads the divisor back from the
//     Bridge, asserts it is non-zero and asserts the stored fee of the
//     revealed deposit is `amount / divisor > 0`.
//   - `rebateStaking != address(0)`: Base wires the RebateStaking proxy with
//     `bridge.setRebateStaking`. The Bridge exposes no getter for it, so the
//     test proves the wiring by revealing an ordinary deposit for the same
//     depositor inside a state snapshot, requiring that it reaches
//     `applyForRebate` and creates a rebate entry, and then reverting.
//   - A rebate allowance: the depositor stakes 10_000 T, which gives a rebate
//     cap of 1e8 sat at REBATE_PER_TOKEN, far above the deposit fee, so an
//     applied rebate always changes the rebate state and the stored fee.
//
// Hardhat counterpart: none. The deposit is revealed through the real
// Bridge.revealDeposit, using the deployment built by test/fizz/Base.sol.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {RebateStaking} from "../../contracts/bridge/RebateStaking.sol";

contract ReservedDepositSkipsRebateTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    uint64 internal constant DEPOSIT_AMOUNT_SAT = 200_000;
    uint96 internal constant DEPOSITOR_STAKE = 10_000 ether; // 10_000 T

    address internal depositor;
    bytes20 internal wallet0;
    uint256 internal nonce;

    function setUp() public {
        setup();
        wallet0 = BtcBuilder.pubKeyHash(walletPubX[0], walletPubY[0]);
        depositor = makeAddr("rebate.depositor");

        // Rebate allowance: the depositor stakes T in RebateStaking.
        tToken.deal(depositor, DEPOSITOR_STAKE);
        vm.startPrank(depositor);
        tToken.approve(address(rebateStaking), type(uint256).max);
        rebateStaking.stake(DEPOSITOR_STAKE);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Reserved deposit: the rebate budget must stay untouched
    // ------------------------------------------------------------------

    /// @notice A reserved reveal never calls `applyForRebate`, leaves the
    ///         depositor's rebate entries and available rebate unchanged and
    ///         stores the undiscounted treasury fee. The mutant without
    ///         `!isReserved &&` calls `applyForRebate`, pushes a rebate entry,
    ///         shrinks the available rebate and stores a fee of zero.
    function test_reservedReveal_doesNotApplyForRebate() public {
        uint256 fullFee = _assertPreconditions();

        uint64 capBefore = rebateStaking.getRebateCap(depositor);
        uint64 availableBefore = rebateStaking.getAvailableRebate(depositor);
        uint256 lengthBefore = rebateStaking.getRebateLength(depositor);
        assertEq(uint256(availableBefore), uint256(capBefore), "full budget");
        assertEq(lengthBefore, 0, "no rebate entries yet");

        // (a) Zero calls to applyForRebate during the reserved reveal.
        vm.expectCall(
            address(rebateStaking),
            abi.encodeWithSelector(RebateStaking.applyForRebate.selector),
            0
        );
        uint256 key = _reveal(address(reservationVault));

        assertTrue(bridge.isReservedDeposit(key), "classified as reserved");

        // (b) Rebate state is unchanged.
        assertEq(
            rebateStaking.getRebateLength(depositor),
            lengthBefore,
            "no rebate entry pushed"
        );
        assertEq(
            uint256(rebateStaking.getAvailableRebate(depositor)),
            uint256(availableBefore),
            "available rebate unchanged"
        );

        // (c) The stored fee is the undiscounted one.
        Deposit.DepositRequest memory d = bridge.deposits(key);
        assertEq(uint256(d.amount), uint256(DEPOSIT_AMOUNT_SAT), "amount");
        assertEq(d.depositor, depositor, "depositor");
        assertEq(uint256(d.treasuryFee), fullFee, "fee is not discounted");
    }

    // ------------------------------------------------------------------
    // Control: an ordinary deposit does consume the rebate budget
    // ------------------------------------------------------------------

    /// @notice The same depositor and amount revealed to the pooled
    ///         TBTCVault path calls `applyForRebate`, pushes a rebate entry,
    ///         reduces the available rebate by the full fee and stores a fee
    ///         of zero. This proves that the observations of the reserved test
    ///         are meaningful. It passes on the original code and on the
    ///         mutant.
    function test_ordinaryReveal_appliesForRebate() public {
        uint256 fullFee = _assertDivisorAndFee();

        uint64 availableBefore = rebateStaking.getAvailableRebate(depositor);
        uint256 lengthBefore = rebateStaking.getRebateLength(depositor);
        assertEq(lengthBefore, 0, "no rebate entries yet");

        vm.expectCall(
            address(rebateStaking),
            abi.encodeWithSelector(RebateStaking.applyForRebate.selector),
            1
        );
        uint256 key = _reveal(address(tbtcVault));

        assertFalse(bridge.isReservedDeposit(key), "not reserved");

        assertEq(
            rebateStaking.getRebateLength(depositor),
            lengthBefore + 1,
            "rebate entry pushed"
        );
        (, uint64 feeRebate) = rebateStaking.getRebate(depositor, lengthBefore);
        assertEq(uint256(feeRebate), fullFee, "entire fee rebated");
        assertEq(
            uint256(rebateStaking.getAvailableRebate(depositor)),
            uint256(availableBefore) - fullFee,
            "available rebate reduced by the fee"
        );
        assertEq(
            uint256(bridge.deposits(key).treasuryFee),
            0,
            "stored fee fully rebated"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Asserts the divisor is non-zero and returns the expected
    ///      undiscounted fee of a `DEPOSIT_AMOUNT_SAT` deposit, which must be
    ///      above zero.
    function _assertDivisorAndFee() internal returns (uint256 fullFee) {
        (, uint64 divisor, , ) = bridge.depositParameters();
        assertGt(uint256(divisor), 0, "precondition: treasury fee divisor set");
        fullFee = uint256(DEPOSIT_AMOUNT_SAT) / uint256(divisor);
        assertGt(fullFee, 0, "precondition: treasury fee above zero");
        assertGt(
            uint256(rebateStaking.getRebateCap(depositor)),
            fullFee,
            "precondition: rebate cap covers the fee"
        );
    }

    /// @dev Asserts `treasuryFee > 0` and `rebateStaking != address(0)` for
    ///      this setup. The Bridge has no getter for its RebateStaking
    ///      address, so an ordinary reveal is made in a state snapshot and
    ///      must reach `applyForRebate`; the snapshot is reverted afterwards.
    function _assertPreconditions() internal returns (uint256 fullFee) {
        fullFee = _assertDivisorAndFee();

        uint256 snapshotId = vm.snapshotState();
        uint256 lengthBefore = rebateStaking.getRebateLength(depositor);
        uint256 key = _reveal(address(tbtcVault));
        assertEq(
            rebateStaking.getRebateLength(depositor),
            lengthBefore + 1,
            "precondition: Bridge is wired to RebateStaking"
        );
        assertLt(
            uint256(bridge.deposits(key).treasuryFee),
            fullFee,
            "precondition: rebate lowers the stored fee"
        );
        assertTrue(vm.revertToState(snapshotId), "snapshot reverted");
    }

    /// @dev Reveals an unfunded deposit of `DEPOSIT_AMOUNT_SAT` for
    ///      `depositor` through the real Bridge to `vault` and returns its
    ///      key. The refund deadline is far enough away for both the
    ///      ordinary reveal-ahead check and the reservation cap.
    function _reveal(address vault) internal returns (uint256 key) {
        bytes32 entropy = keccak256(abi.encode("rebate.deposit", ++nonce));
        uint32 deadline = uint32(
            block.timestamp + uint256(RESERVATION_TERM_SECONDS) + 1 days
        );
        Deposit.DepositRevealInfo memory reveal = Deposit.DepositRevealInfo({
            fundingOutputIndex: 0,
            blindingFactor: bytes8(keccak256(abi.encode(entropy, "blinding"))),
            walletPubKeyHash: wallet0,
            refundPubKeyHash: bytes20(
                keccak256(abi.encode(entropy, depositor, "refund"))
            ),
            refundLocktime: _le32(deadline),
            vault: vault
        });
        (BitcoinTx.Info memory fundingTx, uint32 outputIndex) = BtcBuilder
            .depositFundingTx(
                reveal,
                depositor,
                bytes32(0),
                false,
                uint256(entropy) % 2 == 0,
                DEPOSIT_AMOUNT_SAT,
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
