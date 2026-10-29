// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";

import {TBTC} from "../../contracts/token/TBTC.sol";
import {ReservationVault} from "../../contracts/vault/ReservationVault.sol";

import {ReservationStackHarness} from "./ReservationStackHarness.sol";
import {ReservationSurfaceHandler} from "./ReservationSurfaceHandler.sol";

/// @notice Fire tests for the six vault properties of the reservation
///         surface campaign. A property that never fails is
///         indistinguishable from one that cannot fail, so every case here
///         drives the handler's own actions to a state where the property
///         holds, breaks exactly one thing through a route the campaign
///         cannot take, and asserts the property flips to false.
/// @dev The corruptions are the two the campaign cannot reach on its own:
///      a vault operation the handler's accounting never sees, and a value
///      reported to a reader (`vm.mockCall`) that the protocol cannot hold.
///      Neither writes storage behind the contract's back.
contract ReservationVaultFiresTest is Test {
    uint256 internal constant SATOSHI_MULTIPLIER = 1e10;

    /// @dev In `ReservationSurfaceHandler`'s depositor set, so the
    ///      depositor-side property compares this address.
    address internal constant DEPOSITOR = address(0xA11CE);
    address internal constant TREASURY = address(0x5EED);

    ReservationSurfaceHandler internal handler;
    ReservationStackHarness internal stack;
    ReservationVault internal vault;
    TBTC internal tbtc;

    function setUp() public {
        handler = new ReservationSurfaceHandler();
        stack = handler.stack();
        vault = stack.reservationVault();
        tbtc = stack.tbtcToken();
    }

    // ---------------------------------------------------------------------
    // P8 / INV-209, INV-701, INV-704: the vault balance ledger
    // ---------------------------------------------------------------------

    function test_vaultTbtcBalanceMatchesFeesBurnedAndSweptFires() public {
        _creditOnce();
        assertTrue(
            handler.property_vaultTbtcBalanceMatchesFeesBurnedAndSwept(),
            "the property must hold on a campaign-reachable state"
        );
        uint256 reserveTbtc = tbtc.balanceOf(address(vault));
        assertEq(reserveTbtc, 44_000_000_000_000, "the retained fee");
        assertEq(vault.feeReserveTarget(), 0, "the target is unset");

        // A sweep outside the campaign: the real reserve leaves the vault
        // while the predicted balance stays where the credit put it.
        stack.sweepFees(TREASURY);

        assertEq(
            tbtc.balanceOf(address(vault)),
            0,
            "the reserve should have been swept"
        );
        assertEq(
            tbtc.balanceOf(TREASURY),
            reserveTbtc,
            "the treasury should hold the swept fee"
        );
        assertFalse(
            handler.property_vaultTbtcBalanceMatchesFeesBurnedAndSwept(),
            "an unaccounted sweep must break the ledger"
        );
    }

    // ---------------------------------------------------------------------
    // P8 / INV-209, INV-701, INV-704: the depositor's share
    // ---------------------------------------------------------------------

    function test_depositorReceivesGrossMinusInitiationFeeFires() public {
        _creditOnce();
        assertTrue(
            handler.property_depositorReceivesGrossMinusInitiationFee(),
            "the property must hold on a campaign-reachable state"
        );
        uint256 paidBefore = tbtc.balanceOf(DEPOSITOR);

        // A credit that bypasses the campaign's accounting: the depositor's
        // real balance moves and the predicted one does not.
        stack.creditVault(DEPOSITOR, 250_000);

        assertGt(
            tbtc.balanceOf(DEPOSITOR),
            paidBefore,
            "the unaccounted credit should have paid the depositor"
        );
        assertFalse(
            handler.property_depositorReceivesGrossMinusInitiationFee(),
            "an unaccounted credit must break the depositor ledger"
        );
    }

    // ---------------------------------------------------------------------
    // P9 / INV-207, INV-705: the in-kind fee debt
    // ---------------------------------------------------------------------

    function test_inKindFeeDebtMatchesFinancingFires() public {
        _creditOnce();
        assertTrue(
            handler.property_inKindFeeDebtMatchesFinancing(),
            "the property must hold on a campaign-reachable state"
        );
        uint256 reserveTbtc = tbtc.balanceOf(address(vault));
        uint64 reserveSat = uint64(reserveTbtc / SATOSHI_MULTIPLIER);
        uint64 feeSat = 10_000;
        assertLt(reserveSat, feeSat, "the fee must exceed the reserve");

        // A financing the campaign's accounting never sees: the reserve
        // covers part of it and the rest is recorded as debt.
        stack.fundVaultBank(reserveSat);
        stack.financeInKindFee(feeSat);

        assertEq(
            vault.inKindFeeDebtSat(),
            feeSat - reserveSat,
            "the shortfall should be recorded as debt"
        );
        assertFalse(
            handler.property_inKindFeeDebtMatchesFinancing(),
            "unaccounted debt must break the debt ledger"
        );
    }

    // ---------------------------------------------------------------------
    // P11 / INV-212: supply tracks the routed satoshi
    // ---------------------------------------------------------------------

    function test_supplyStaysInLockstepWithRoutedSatoshiFires() public {
        _creditOnce();
        assertTrue(
            handler.property_supplyStaysInLockstepWithRoutedSatoshi(),
            "the property must hold on a campaign-reachable state"
        );
        uint256 supplyBefore = tbtc.totalSupply();

        // A gross mint the campaign did not route: supply grows past the
        // predicted figure.
        stack.creditVault(address(0xB0B), 500_000);

        assertGt(
            tbtc.totalSupply(),
            supplyBefore,
            "the unaccounted credit should have minted"
        );
        assertFalse(
            handler.property_supplyStaysInLockstepWithRoutedSatoshi(),
            "unaccounted supply must break the lockstep"
        );
    }

    // ---------------------------------------------------------------------
    // P24 / INV-401: the initiation fee ceiling
    // ---------------------------------------------------------------------

    function test_vaultFeeStaysWithinTheCeilingFires() public {
        _creditOnce();
        assertTrue(
            handler.property_vaultFeeStaysWithinTheCeiling(),
            "the property must hold on a campaign-reachable state"
        );

        // `updateInitiationFee` refuses a fee above the ceiling, so the only
        // way to produce this read is a write path that skipped the guard.
        // Report it and check the property rejects it.
        vm.mockCall(
            address(vault),
            abi.encodeWithSelector(vault.initiationFeeBps.selector),
            abi.encode(uint16(600))
        );

        assertGt(
            uint256(vault.initiationFeeBps()),
            uint256(vault.MAX_FEE_BASIS_POINTS()),
            "the reported fee should exceed the ceiling"
        );
        assertFalse(
            handler.property_vaultFeeStaysWithinTheCeiling(),
            "a fee above the ceiling must break the property"
        );
    }

    // ---------------------------------------------------------------------
    // P7 / INV-109: no re-point while a deposit is pending
    // ---------------------------------------------------------------------

    function test_vaultIsNeverRepointedWhileDepositsArePendingFires() public {
        _creditOnce();
        assertTrue(
            handler.property_vaultIsNeverRepointedWhileDepositsArePending(),
            "the property must hold on a campaign-reachable state"
        );
        assertEq(
            stack.pendingReservedDepositsProbe(),
            0,
            "no reserved deposit should be pending yet"
        );
        address vaultBefore = stack.reservationVaultAddress();

        // Report a pending deposit the router's own storage does not hold.
        // The router's guard reads the counter, sees zero, and lets the
        // re-point through: the exact state INV-109 forbids.
        vm.mockCall(
            address(stack),
            abi.encodeWithSelector(stack.pendingReservedDepositsProbe.selector),
            abi.encode(uint64(1))
        );

        handler.routerUpdateParameters(1, 0, 0);

        assertEq(
            stack.reservationVaultAddress(),
            address(0xBAAD),
            "the re-point should have landed"
        );
        assertTrue(
            stack.reservationVaultAddress() != vaultBefore,
            "the vault must actually have moved"
        );
        assertFalse(
            handler.property_vaultIsNeverRepointedWhileDepositsArePending(),
            "a re-point with a deposit pending must break the property"
        );
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev One campaign credit: a 1_100_000 satoshi deposit to 0xA11CE at
    ///      the 40 bps initiation fee, which retains 4_400 satoshi
    ///      (44_000_000_000_000 wei) in the vault.
    function _creditOnce() internal {
        handler.surfaceCredit(2, 1_000_000);
        assertEq(handler.successes("surfaceCredit"), 1, "credit did not land");
    }
}
