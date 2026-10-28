// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for access-control modifiers that survived the MRM
// (modifier removal) mutation pass of 2026-10-12: removing the modifier did
// not make any Foundry or Hardhat test fail. Rows in
// fizz_data/mutation/TRIAGE.md (fifth pass, part 2).
//
//   ReservationRouter.sol:257  submitReservationAcceptanceProof onlySpvMaintainer
//   ReservationRouter.sol:366  updateReservationParameters      onlyGovernance
//   ReservationRouter.sol:438  updateReservationCaps            onlyGovernance
//   ReservationVault.sol:164   receiveBalanceIncrease           onlyBank
//
// Each test calls the function from an account without the role, with
// arguments that would otherwise pass far enough to change state, and
// expects the modifier's revert.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";

contract AccessControlGuardsTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    address internal stranger;

    function setUp() public {
        setup();
        stranger = makeAddr("acl.stranger");
    }

    /// @notice Only a trusted SPV maintainer may submit an acceptance proof.
    function test_acceptanceProof_refusedForNonMaintainer() public {
        BitcoinTx.Info memory t;
        BitcoinTx.Proof memory proof;
        vm.prank(stranger);
        vm.expectRevert(bytes("Caller is not SPV maintainer"));
        reservationRouter.submitReservationAcceptanceProof(t, proof, 1, 1);
    }

    /// @notice Only governance may change the reservation caps; the caps
    ///         stay as they were.
    function test_updateReservationCaps_refusedForNonGovernance() public {
        (uint64 perWallet, uint64 single, uint32 maxActive) = reservationRouter
            .reservationCaps();
        vm.prank(stranger);
        vm.expectRevert(bytes("Caller is not the governance"));
        reservationRouter.updateReservationCaps(perWallet + 1, single, maxActive);
        (uint64 after_, , ) = reservationRouter.reservationCaps();
        assertEq(uint256(after_), uint256(perWallet), "caps unchanged");
    }

    /// @notice Only governance may change the reservation parameters; the
    ///         stored values stay as they were. The call resubmits the
    ///         current values, so it would succeed without the modifier.
    function test_updateReservationParameters_refusedForNonGovernance() public {
        (bool ok, bytes memory ret) = address(reservationRouter).staticcall(
            abi.encodeWithSelector(
                reservationRouter.reservationParameters.selector
            )
        );
        require(ok, "reservationParameters failed");
        uint256[10] memory w = abi.decode(ret, (uint256[10]));
        vm.prank(stranger);
        vm.expectRevert(bytes("Caller is not the governance"));
        reservationRouter.updateReservationParameters(
            address(uint160(w[0])),
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

    /// @notice Only the Bank may notify the vault of a balance increase
    ///         (which mints tBTC to the depositors).
    function test_vaultReceiveBalanceIncrease_refusedForNonBank() public {
        address[] memory depositors = new address[](1);
        depositors[0] = stranger;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;
        uint256 before = tbtc.balanceOf(stranger);
        vm.prank(stranger);
        vm.expectRevert(bytes("Caller is not the Bank"));
        reservationVault.receiveBalanceIncrease(depositors, amounts);
        assertEq(tbtc.balanceOf(stranger), before, "nothing minted");
    }
}
