// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with ReservationVault
abstract contract ReservationVaultHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev Repays between 1 sat and min(debt, actor TBTC balance in sat).
    ///      The TBTC allowance of every actor to the vault is seeded in setup.
    function reservationVault_repayInKindFeeDebt_clamped(
        uint64 amountSat
    ) public {
        uint256 maxSat = _reservationVault_maxRepayableSat();
        if (maxSat == 0) return;
        amountSat = uint64(clampBetween(amountSat, 1, maxSat));
        reservationVault_repayInKindFeeDebt(amountSat);
    }

    /// @dev Near-zero variant: repays a single satoshi (smallest burn).
    function reservationVault_repayInKindFeeDebt_oneSat() public {
        if (_reservationVault_maxRepayableSat() == 0) return;
        reservationVault_repayInKindFeeDebt(1);
    }

    /// @dev Full-debt variant: repays exactly the outstanding debt when the
    ///      actor can afford it.
    function reservationVault_repayInKindFeeDebt_full() public {
        uint64 debt = reservationVault.inKindFeeDebtSat();
        if (debt == 0) return;
        if (tbtc.balanceOf(actor) < uint256(debt) * SATOSHI_MULTIPLIER) return;
        reservationVault_repayInKindFeeDebt(debt);
    }

    /// @dev Type-boundary variant: passes `type(uint64).max`, which the
    ///      contract must cap at the outstanding debt.
    function reservationVault_repayInKindFeeDebt_overRepay() public {
        uint64 debt = reservationVault.inKindFeeDebtSat();
        if (debt == 0) return;
        if (tbtc.balanceOf(actor) < uint256(debt) * SATOSHI_MULTIPLIER) return;
        reservationVault_repayInKindFeeDebt(type(uint64).max);
    }

    /// @dev Donates TBTC from the actor to the vault; the donation changes the
    ///      reserve/surplus accounting (`sweepFees`, `financeInKindFee`).
    function reservationVault_donateTBTC(uint256 amount) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);

        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();

        vm.prank(actor);
        tbtc.transfer(address(reservationVault), amount);

        snapshotAfter();
        ghosts.tbtcDonatedToRvWei += amount;
        ghosts.anyDonation = true;

        _reservationVault_checkValueConservation();
    }

    /// @dev Near-zero variant: donates less than one satoshi of TBTC, leaving
    ///      a sub-satoshi remainder in the vault (truncated by `reserve / 1e10`).
    function reservationVault_donateTBTC_subSat(uint256 amount) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        uint256 maxAmount = SATOSHI_MULTIPLIER - 1;
        if (balance < maxAmount) maxAmount = balance;
        amount = clampBetween(amount, 1, maxAmount);

        vm.prank(actor);
        tbtc.transfer(address(reservationVault), amount);

        ghosts.tbtcDonatedToRvWei += amount;
        ghosts.anyDonation = true;
    }

    /// @dev Donates Bank balance (satoshi) from the actor to the vault. The
    ///      vault then holds Bank balance that no TBTC mint accounts for.
    function reservationVault_donateBankBalance(uint256 amountSat) public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        amountSat = clampBetween(amountSat, 1, balance);

        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();

        vm.prank(actor);
        bank.transferBalance(address(reservationVault), amountSat);

        snapshotAfter();
        ghosts.bankDonatedToRvSat += amountSat;
        ghosts.anyDonation = true;

        _reservationVault_checkValueConservation();
    }

    /// @dev Repays one to five times in a row, each cycle between 1 sat (first
    ///      cycle, one input in three) and min(debt, actor TBTC in sat). Every
    ///      cycle is checked on its own: a repay must never be profitable.
    function reservationVault_repayCycles(
        uint256 cycles,
        uint64 amountSat
    ) public {
        cycles = clampBetween(cycles, 1, 5);
        for (uint256 i; i < cycles; i++) {
            uint256 maxSat = _reservationVault_maxRepayableSat();
            if (maxSat == 0) break;
            uint64 repaySat =
                (i == 0 && amountSat % 3 == 0)
                    ? 1
                    : uint64(clampBetween(uint256(amountSat) + i, 1, maxSat));
            _reservationVault_repayStep(repaySat);
            property_repayCyclesNoProfit();
        }
        ghosts.lastHandlerId = HID_NONE;
    }

    /// @dev Odd selectors pass the fuzzed values untouched (raw path), even
    ///      selectors clamp them to values that pass the contract's checks.
    function reservationVault_secondary(
        uint8 selector,
        uint256 arg0,
        address arg1
    ) public {
        selector = uint8(selector % 6);
        bool sweep = selector <= 1;
        if (sweep) {
            // Recipient is the treasury or one of the actors (selector 0) or raw (selector 1).
            address recipient =
                selector == 1
                    ? arg1
                    : (uint160(arg1) % 2 == 0 ? treasury : toActor(arg1));
            _reservationVault_sweepStep(recipient);
        } else {
            _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
            ghosts.lastHandlerId = HID_NONE;
            snapshotBefore();
            if (selector == 2) {
                _reservationVault_updateInitiationFee(
                    uint16(
                        clampBetween(
                            arg0,
                            0,
                            reservationVault.MAX_FEE_BASIS_POINTS()
                        )
                    )
                );
            } else if (selector == 3) {
                _reservationVault_updateInitiationFee(uint16(arg0));
            } else if (selector == 4) {
                _reservationVault_updateFeeReserveTarget(
                    _reservationVault_clampFeeReserveTarget(arg0)
                );
            } else {
                _reservationVault_updateFeeReserveTarget(arg0);
            }
            snapshotAfter();
        }

        property_minerFeeLedger();
        property_inKindDebtAttribution();
        if (sweep) property_sweepFeesExact();
        property_noPrivilegeEscalation();
        property_lifecycleRolesEnforced();
        ghosts.lastHandlerId = HID_NONE;
        property_inKindDebtRepairable();
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function reservationVault_repayInKindFeeDebt(uint64 amountSat) public {
        _reservationVault_repayStep(amountSat);

        _reservationVault_checkValueConservation();
        property_noUnauthorizedBalanceChange();
        property_repayInKindFeeDebtExact();
        property_minerFeeLedger();
        property_inKindDebtAttribution();
        ghosts.lastHandlerId = HID_NONE;
        property_inKindDebtRepairable();
    }

    function _reservationVault_callRepay(uint64 amountSat) internal asActor {
        reservationVault.repayInKindFeeDebt(amountSat);
    }

    function _reservationVault_sweepFees(
        address recipient
    ) internal asGovernance {
        reservationVault.sweepFees(recipient);
    }

    function _reservationVault_updateInitiationFee(
        uint16 _initiationFeeBps
    ) internal asGovernance {
        reservationVault.updateInitiationFee(_initiationFeeBps);
    }

    function _reservationVault_updateFeeReserveTarget(
        uint256 _feeReserveTarget
    ) internal asGovernance {
        reservationVault.updateFeeReserveTarget(_feeReserveTarget);
    }

    // ―――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    /// @dev SP-07 for operations that are not a TokenVault op: clears the
    ///      TokenVault op kind so no transfer-specific tolerance applies.
    function _reservationVault_checkValueConservation() internal {
        _tv_setOp(TvKind.None, actor, address(0), 0);
        property_noValueCreationByActor();
    }

    /// @dev One repay with its snapshots and ghost updates (no property call).
    ///      The payer's counterparty is another actor, whose balances must not
    ///      change; the TBTC allowance of that actor to the payer is the
    ///      allowance bound for them.
    function _reservationVault_repayStep(uint64 amountSat) internal {
        address other = toActorNotCurrent(address(reservationVault));
        _setFocus(0, bytes20(0), bytes20(0), other, 0);
        ghosts.lastHandlerId = HID_REPAY;
        snapshotBefore();
        stateBefore.focusAllowance = tbtc.allowance(other, actor);

        _reservationVault_callRepay(amountSat);

        snapshotAfter();
        uint256 repaid = _peripheral_min(
            uint256(amountSat),
            uint256(stateBefore.inKindDebtSat)
        );
        ghosts.rvDebtRepaidSat += repaid;
        ghosts.bankBurnedSat += repaid;
        _peripheral_repayRequestedSat = amountSat;
    }

    /// @dev One governance `sweepFees` with its snapshots and ghost updates.
    ///      The expected burn / payout come from the pre-call state; SP-118
    ///      checks the observed state against the same formula.
    function _reservationVault_sweepStep(address recipient) internal {
        _setFocus(0, bytes20(0), bytes20(0), recipient, 0);
        ghosts.lastHandlerId = HID_SWEEP_FEES;
        snapshotBefore();

        _reservationVault_sweepFees(recipient);

        snapshotAfter();
        uint256 reserve = stateBefore.tbtcReservationVault;
        uint256 burnedSat = _peripheral_min(
            uint256(stateBefore.inKindDebtSat),
            reserve / SATOSHI_MULTIPLIER
        );
        uint256 balance = reserve - burnedSat * SATOSHI_MULTIPLIER;
        uint256 target = stateBefore.feeReserveTarget;
        uint256 paid = balance > target ? balance - target : 0;
        // A self-transfer moves nothing.
        if (recipient == address(reservationVault)) paid = 0;

        ghosts.rvSweepDebtBurnedSat += burnedSat;
        ghosts.bankBurnedSat += burnedSat;
        ghosts.rvFeesSweptWei += paid;
        if (!_reservationVault_isTbtcTracked(recipient)) {
            ghosts.tbtcToUntrackedWei += paid;
        }
    }

    /// @dev Whether `holder` is in the TBTC holder set summed by GL-03:
    ///      actors, TBTCVault, ReservationVault, Bridge, treasury, watchtower.
    function _reservationVault_isTbtcTracked(
        address holder
    ) internal view returns (bool) {
        if (
            holder == address(tbtcVault) ||
            holder == address(reservationVault) ||
            holder == address(bridge) ||
            holder == treasury ||
            holder == address(redemptionWatchtower)
        ) return true;
        for (uint256 i; i < actors.length; i++) {
            if (actors[i] == holder) return true;
        }
        return false;
    }

    /// @dev min(outstanding debt, actor TBTC balance in satoshi); zero when
    ///      there is no debt or the actor cannot pay a single satoshi.
    function _reservationVault_maxRepayableSat()
        internal
        view
        returns (uint256)
    {
        uint256 debt = reservationVault.inKindFeeDebtSat();
        if (debt == 0) return 0;
        uint256 affordable = tbtc.balanceOf(actor) / SATOSHI_MULTIPLIER;
        return debt < affordable ? debt : affordable;
    }

    /// @dev Reserve target relative to the vault's TBTC balance: zero, exactly
    ///      the balance, just below it, or anywhere up to twice the balance.
    function _reservationVault_clampFeeReserveTarget(
        uint256 target
    ) internal returns (uint256) {
        uint256 balance = tbtc.balanceOf(address(reservationVault));
        uint256 mode = target % 4;
        if (mode == 0) return 0;
        if (mode == 1) return balance;
        if (mode == 2) return balance == 0 ? 0 : balance - 1;
        return clampBetween(target, 0, balance * 2);
    }
}
