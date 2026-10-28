// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";

/// @notice Handles the interaction with RebateStaking
abstract contract RebateStakingHandler is Properties {
    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev Stakes between 1 wei and the actor's T balance, bounded so that
    ///      the staked amount stays within `uint96`. The T allowance to
    ///      RebateStaking is seeded in setup.
    function rebateStaking_stake_clamped(uint96 amount) public {
        uint256 maxAmount = _rebateStaking_maxStakeable();
        if (maxAmount == 0) return;
        amount = uint96(clampBetween(amount, 1, maxAmount));
        rebateStaking_stake(amount);
    }

    /// @dev Type-boundary variant: mints T to the actor (mock token) and
    ///      stakes up to `type(uint96).max - pad`, pushing `stakedAmount`
    ///      (uint96) to its limit. `pad` is clamped to [0, 1e18].
    function rebateStaking_stake_typeBoundary(uint256 pad) public {
        uint256 staked = rebateStaking.getStake(actor);
        uint256 room = uint256(type(uint96).max) - staked;
        pad = clampBetween(pad, 0, 1e18);
        if (room <= pad) return;
        uint256 amount = room - pad;

        uint256 balance = tToken.balanceOf(actor);
        if (balance < amount) tToken.deal(actor, amount - balance);
        rebateStaking_stake(uint96(amount));
    }

    /// @dev Starts unstaking between 1 wei and the actor's whole stake; only
    ///      when no unstaking process is running.
    function rebateStaking_startUnstaking_clamped(uint96 amount) public {
        uint96 staked = rebateStaking.getStake(actor);
        if (staked == 0) return;
        (, uint32 unstakingTimestamp) = rebateStaking.getUnstakingAmount(actor);
        if (unstakingTimestamp != 0) return;
        amount = uint96(clampBetween(amount, 1, staked));
        rebateStaking_startUnstaking(amount);
    }

    /// @dev Full-amount variant: unstakes the actor's entire stake.
    function rebateStaking_startUnstaking_full() public {
        uint96 staked = rebateStaking.getStake(actor);
        if (staked == 0) return;
        (, uint32 unstakingTimestamp) = rebateStaking.getUnstakingAmount(actor);
        if (unstakingTimestamp != 0) return;
        rebateStaking_startUnstaking(staked);
    }

    /// @dev Finalizes a running unstaking process once the unstaking period
    ///      has elapsed, sending the tokens to an actor.
    function rebateStaking_finalizeUnstaking_clamped(address receiver) public {
        (, uint32 unstakingTimestamp) = rebateStaking.getUnstakingAmount(actor);
        if (unstakingTimestamp == 0) return;
        if (
            uint256(unstakingTimestamp) + rebateStaking.unstakingPeriod() >
            block.timestamp
        ) return;
        receiver = toActor(receiver);
        rebateStaking_finalizeUnstaking(receiver);
    }

    /// @dev Delegates the actor's rebate to a stake-less actor, or clears the
    ///      delegation (every fifth input).
    function rebateStaking_setDelegatee_clamped(address _delegatee) public {
        if (rebateStaking.getStake(actor) == 0) return;
        if (uint160(_delegatee) % 5 == 0) {
            _delegatee = address(0);
        } else {
            _delegatee = toActor(_delegatee);
            if (
                _delegatee == actor ||
                rebateStaking.getStake(_delegatee) != 0 ||
                rebateStaking.delegates(_delegatee) != address(0)
            ) return;
        }
        rebateStaking_setDelegatee(_delegatee);
    }

    /// @dev Authorizes / revokes an actor as Bank balance owner for the
    ///      staking actor; the caller must be a staker.
    function rebateStaking_setRebateAuthorization_clamped(
        address balanceOwner,
        bool authorized
    ) public {
        if (rebateStaking.getStake(actor) == 0) return;
        balanceOwner = toActor(balanceOwner);
        rebateStaking_setRebateAuthorization(balanceOwner, authorized);
    }

    /// @dev Donates T from the actor to RebateStaking (not recorded as stake),
    ///      which separates the contract's T balance from the sum of stakes.
    function rebateStaking_donateERC20(uint256 amount) public {
        uint256 balance = tToken.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);

        vm.prank(actor);
        tToken.transfer(address(rebateStaking), amount);

        ghosts.anyDonation = true;
    }

    /// @dev Round trip: stakes `amount`, starts unstaking exactly that amount,
    ///      waits out the unstaking period and finalizes to the actor. Only
    ///      runs when the actor has no unstaking process pending. The actor's
    ///      T balance, stake and rebate cap must come back unchanged.
    function rebateStaking_stakeUnstakeRoundTrip(uint96 amount) public {
        (, uint32 unstakingTimestamp) = rebateStaking.getUnstakingAmount(actor);
        if (unstakingTimestamp != 0) return;
        // Out of model: an unstaking period that pushes the clock past the uint32 horizon (ECH-long verdict).
        if (!clockHasRoom(rebateStaking.unstakingPeriod())) return;
        uint256 maxAmount = _rebateStaking_maxStakeable();
        if (maxAmount == 0) return;
        amount = uint96(clampBetween(amount, 1, maxAmount));

        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        (
            _peripheral_capBeforeOk,
            _peripheral_capBefore
        ) = _peripheral_rebateCap(actor);
        snapshotBefore();

        _rebateStaking_callStake(amount);
        _rebateStaking_callStartUnstaking(amount);
        skipTime(rebateStaking.unstakingPeriod() + 1);
        _rebateStaking_callFinalizeUnstaking(actor);

        snapshotAfter();
        property_stakeUnstakeRoundTrip();
    }

    /// @dev Odd selectors pass the fuzzed values untouched (raw path), even
    ///      selectors clamp them to valid ranges. `setRebateTreasuryFeeMode`
    ///      is not owner-gated (it sets the mode of `msg.sender`), so it is
    ///      sent as the current actor.
    function rebateStaking_secondary(
        uint8 selector,
        uint256 arg0,
        address arg1,
        address arg2
    ) public {
        selector = uint8(selector % 10);
        _peripheral_xferActive = false;
        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();

        if (selector == 0) {
            (
                bool ok,
                address oldStaker,
                address newStaker
            ) = _rebateStaking_pickTransfer(
                    uint256(uint160(arg1)),
                    uint256(uint160(arg2))
                );
            if (ok) {
                _rebateStaking_captureTransfer(oldStaker, newStaker);
                _rebateStaking_forceStakeTransfer(oldStaker, newStaker);
            }
        } else if (selector == 1) {
            _rebateStaking_captureTransfer(arg1, arg2);
            _rebateStaking_forceStakeTransfer(arg1, arg2);
        } else if (selector == 2) {
            _rebateStaking_updateRebatePerToken(
                _rebateStaking_clampRebatePerToken(arg0)
            );
        } else if (selector == 3) {
            _rebateStaking_updateRebatePerToken(arg0);
        } else if (selector == 4) {
            _rebateStaking_updateRollingWindow(
                _rebateStaking_clampRollingWindow(arg0)
            );
        } else if (selector == 5) {
            _rebateStaking_updateRollingWindow(arg0);
        } else if (selector == 6) {
            _rebateStaking_updateUnstakingPeriod(
                clampBetween(arg0, 0, 14 days)
            );
        } else if (selector == 7) {
            _rebateStaking_updateUnstakingPeriod(arg0);
        } else if (selector == 8) {
            _rebateStaking_setRebateTreasuryFeeMode(uint8(arg0 % 3));
        } else {
            _rebateStaking_setRebateTreasuryFeeMode(uint8(arg0));
        }

        snapshotAfter();
        property_rebateWindowNoHistoryLoss();
        property_rebateHistoryAppendOnly();
        property_stakeIdentityMoves();
        _peripheral_xferActive = false;
        _peripheral_refreshRebateShadow();
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function rebateStaking_stake(uint96 amount) public {
        _rebateStaking_beginLifecycle(1, amount, address(0));
        _rebateStaking_callStake(amount);
        _rebateStaking_endLifecycle();
    }

    function rebateStaking_startUnstaking(uint96 amount) public {
        _rebateStaking_beginLifecycle(2, amount, address(0));
        _rebateStaking_callStartUnstaking(amount);
        _rebateStaking_endLifecycle();
    }

    function rebateStaking_finalizeUnstaking(address receiver) public {
        _rebateStaking_beginLifecycle(3, 0, receiver);
        _rebateStaking_callFinalizeUnstaking(receiver);
        _rebateStaking_endLifecycle();
    }

    function rebateStaking_setDelegatee(address _delegatee) public {
        _peripheral_xferActive = false;
        _rebateStaking_callSetDelegatee(_delegatee);
        _rebateStaking_endIdentity();
    }

    function rebateStaking_setRebateAuthorization(
        address balanceOwner,
        bool authorized
    ) public {
        _peripheral_xferActive = false;
        _rebateStaking_callSetRebateAuthorization(balanceOwner, authorized);
        _rebateStaking_endIdentity();
    }

    function _rebateStaking_callStake(uint96 amount) internal asActor {
        rebateStaking.stake(amount);
    }

    function _rebateStaking_callStartUnstaking(uint96 amount) internal asActor {
        rebateStaking.startUnstaking(amount);
    }

    function _rebateStaking_callFinalizeUnstaking(
        address receiver
    ) internal asActor {
        rebateStaking.finalizeUnstaking(receiver);
    }

    function _rebateStaking_callSetDelegatee(
        address _delegatee
    ) internal asActor {
        rebateStaking.setDelegatee(_delegatee);
    }

    function _rebateStaking_callSetRebateAuthorization(
        address balanceOwner,
        bool authorized
    ) internal asActor {
        rebateStaking.setRebateAuthorization(balanceOwner, authorized);
    }

    function _rebateStaking_forceStakeTransfer(
        address oldStaker,
        address newStaker
    ) internal asGovernance {
        rebateStaking.forceStakeTransfer(oldStaker, newStaker);
        ghosts.rebateHistoryMoved[oldStaker] = true;
    }

    function _rebateStaking_updateRebatePerToken(
        uint256 _newRebatePerToken
    ) internal asGovernance {
        rebateStaking.updateRebatePerToken(_newRebatePerToken);
        ghosts.rebatePerTokenChangedAt = block.timestamp;
    }

    function _rebateStaking_updateRollingWindow(
        uint256 _newRollingWindow
    ) internal asGovernance {
        rebateStaking.updateRollingWindow(_newRollingWindow);
    }

    function _rebateStaking_updateUnstakingPeriod(
        uint256 _newUnstakingPeriod
    ) internal asGovernance {
        rebateStaking.updateUnstakingPeriod(_newUnstakingPeriod);
    }

    /// @dev Raw ABI call so that out-of-range enum values (> 2) reach the
    ///      contract's ABI decoder instead of reverting inside the harness.
    function _rebateStaking_setRebateTreasuryFeeMode(
        uint8 _rebateTreasuryFeeMode
    ) internal asActor {
        (bool success, ) = address(rebateStaking).call(
            abi.encodeWithSignature(
                "setRebateTreasuryFeeMode(uint8)",
                _rebateTreasuryFeeMode
            )
        );
        require(success, "rebateStaking_setRebateTreasuryFeeMode failed");
    }

    // ―――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    /// @dev Records the scratch inputs of SP-45 and takes the "before"
    ///      snapshot of a stake / startUnstaking / finalizeUnstaking call.
    function _rebateStaking_beginLifecycle(
        uint8 op,
        uint96 arg,
        address receiver
    ) internal {
        _peripheral_xferActive = false;
        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        _peripheral_stakeOp = op;
        _peripheral_stakeArg = arg;
        _peripheral_stakeReceiver = receiver;
        _peripheral_stakeContractTBefore = tToken.balanceOf(
            address(rebateStaking)
        );
        _peripheral_stakeReceiverTBefore =
            receiver == address(0) ? 0 : tToken.balanceOf(receiver);
        snapshotBefore();
    }

    function _rebateStaking_endLifecycle() internal {
        snapshotAfter();
        property_stakeLifecycleExact();
        property_rebateBudgetNotRecyclable();
        property_rebateHistoryAppendOnly();
        _peripheral_stakeOp = 0;
        _peripheral_refreshRebateShadow();
    }

    function _rebateStaking_endIdentity() internal {
        property_rebateHistoryAppendOnly();
        property_stakeIdentityMoves();
        _peripheral_refreshRebateShadow();
    }

    /// @dev Records the stake image of `oldStaker` for SP-47.
    function _rebateStaking_captureTransfer(
        address oldStaker,
        address newStaker
    ) internal {
        _peripheral_xferActive = true;
        _peripheral_xferOld = oldStaker;
        _peripheral_xferNew = newStaker;
        _peripheral_xferOldStake = rebateStaking.getStake(oldStaker);
        (
            _peripheral_xferOldUnstaking,
            _peripheral_xferOldUnstakingTs
        ) = rebateStaking.getUnstakingAmount(oldStaker);
        _peripheral_xferOldMode = uint8(
            rebateStaking.getRebateTreasuryFeeMode(oldStaker)
        );
    }

    /// @dev min(actor T balance, room left below `type(uint96).max`).
    function _rebateStaking_maxStakeable() internal view returns (uint256) {
        uint256 balance = tToken.balanceOf(actor);
        uint256 room =
            uint256(type(uint96).max) - rebateStaking.getStake(actor);
        return balance < room ? balance : room;
    }

    /// @dev First actor holding a stake (from `a`) and first different,
    ///      stake-less, non-delegatee actor (from `b`).
    function _rebateStaking_pickTransfer(
        uint256 a,
        uint256 b
    ) internal view returns (bool, address, address) {
        uint256 n = actors.length;
        for (uint256 i; i < n; i++) {
            address oldStaker = actors[((a % n) + i) % n];
            if (rebateStaking.getStake(oldStaker) == 0) continue;
            for (uint256 j; j < n; j++) {
                address newStaker = actors[((b % n) + j) % n];
                if (
                    newStaker == oldStaker ||
                    rebateStaking.getStake(newStaker) != 0 ||
                    rebateStaking.delegates(newStaker) != address(0)
                ) continue;
                return (true, oldStaker, newStaker);
            }
        }
        return (false, address(0), address(0));
    }

    /// @dev Zero (no cap), 1 (tiny coefficient: cap = stake / 1 must still fit
    ///      uint64), the setup value, or [1e10, 1e18] T wei per satoshi.
    function _rebateStaking_clampRebatePerToken(
        uint256 value
    ) internal returns (uint256) {
        uint256 mode = value % 4;
        if (mode == 0) return 0;
        if (mode == 1) return 1;
        if (mode == 2) return REBATE_PER_TOKEN;
        return clampBetween(value, 1e10, 1e18);
    }

    /// @dev One second, the setup value, or [1 s, 30 days]; never zero.
    function _rebateStaking_clampRollingWindow(
        uint256 value
    ) internal returns (uint256) {
        uint256 mode = value % 4;
        if (mode == 0) return 1;
        if (mode == 1) return REBATE_ROLLING_WINDOW;
        return clampBetween(value, 1, 30 days);
    }
}
