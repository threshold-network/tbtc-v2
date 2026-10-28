// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";
import {Redemption} from "../../../contracts/bridge/Redemption.sol";
import {EnumerableSet as WtEnumerableSet} from "../utils/EnumerableSet.sol";

/// @notice Handles the interaction with RedemptionWatchtower
abstract contract RedemptionWatchtowerHandler is Properties {
    using WtEnumerableSet for WtEnumerableSet.UintSet;

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev One objection by an eligible guardian (still a guardian, has not
    ///      objected yet) against a harness redemption that is pending in the
    ///      Bridge, not vetoed and still inside its veto delay window.
    function redemptionWatchtower_raiseObjection_clamped(
        uint256 redemptionSeed,
        uint256 guardianSeed
    ) public {
        (
            bool found,
            uint256 index,
            uint256 key
        ) = _redemptionWatchtower_pickObjectable(redemptionSeed);
        if (!found) return;
        (bool ok, uint256 guardianIndex) = _redemptionWatchtower_pickGuardian(
            key,
            guardianSeed
        );
        if (!ok) return;

        HarnessRedemption storage r = harnessRedemptions[index];
        redemptionWatchtower_raiseObjection(
            guardianIndex,
            r.walletPkh,
            r.redeemerOutputScript
        );
    }

    /// @dev Full-veto variant: raises objections from distinct eligible
    ///      guardians in a single call until the veto is finalized (three
    ///      objections), which the veto delay windows make hard to reach by
    ///      chance across separate calls.
    function redemptionWatchtower_vetoRedemption_clamped(
        uint256 redemptionSeed,
        uint256 guardianSeed
    ) public {
        (
            bool found,
            uint256 index,
            uint256 key
        ) = _redemptionWatchtower_pickObjectable(redemptionSeed);
        if (!found) return;

        HarnessRedemption storage r = harnessRedemptions[index];
        for (uint256 n; n < guardians.length; n++) {
            if (
                _redemptionWatchtower_objectionsCount(key) >=
                redemptionWatchtower.REQUIRED_OBJECTIONS_COUNT()
            ) break;
            (
                bool ok,
                uint256 guardianIndex
            ) = _redemptionWatchtower_pickGuardian(key, guardianSeed);
            if (!ok) break;
            redemptionWatchtower_raiseObjection(
                guardianIndex,
                r.walletPkh,
                r.redeemerOutputScript
            );
        }
    }

    /// @dev Withdraws the funds of a finalized veto whose freeze period has
    ///      elapsed. The call is made as the veto's redeemer.
    function redemptionWatchtower_withdrawVetoedFunds_clamped(
        uint256 redemptionSeed
    ) public {
        (
            bool found,
            uint256 key,
            address redeemer
        ) = _redemptionWatchtower_pickWithdrawable(redemptionSeed);
        if (!found) return;

        address previousActor = actor;
        actor = redeemer;
        redemptionWatchtower_withdrawVetoedFunds(key);
        actor = previousActor;
    }

    /// @dev Donates Bank balance from the actor to the watchtower, which
    ///      separates its Bank balance from the sum of withdrawable veto
    ///      amounts.
    function redemptionWatchtower_donateBankBalance(uint256 amountSat) public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        amountSat = clampBetween(amountSat, 1, balance);

        vm.prank(actor);
        bank.transferBalance(address(redemptionWatchtower), amountSat);

        ghosts.bankDonatedToWatchtowerSat += amountSat;
        ghosts.anyDonation = true;
    }

    /// @dev The watchtower lifetime (18 months) exceeds Medusa's per-call time
    ///      delay, so `disableWatchtower` is unreachable without this: warps
    ///      to 1 s .. 1 day after the lifetime expiry.
    function redemptionWatchtower_warpToLifetimeExpiry(uint256 extra) public {
        uint256 enabledAt = redemptionWatchtower.watchtowerEnabledAt();
        if (enabledAt == 0 || redemptionWatchtower.watchtowerDisabledAt() != 0)
            return;
        uint256 target =
            enabledAt +
                redemptionWatchtower.watchtowerLifetime() +
                clampBetween(extra, 1, 1 days);
        // Keep the fuzz clock below the uint32 timestamp wrap of 2106 (target above the ceiling is out of model).
        if (block.timestamp >= target || target > FIZZ_CLOCK_CEILING) return;
        skipTime(target - block.timestamp);
    }

    /// @dev Odd selectors pass the fuzzed values untouched (raw path), even
    ///      selectors clamp them to values the setters accept.
    ///      `p` carries the seven `updateWatchtowerParameters` arguments in
    ///      declaration order (an array keeps the dispatcher under the stack
    ///      limit); `a` is the address argument of unban/add/remove.
    function redemptionWatchtower_secondary(
        uint8 selector,
        uint256[7] memory p,
        address a
    ) public {
        selector = uint8(selector % 10);
        if (selector == 0) {
            (bool ok, address banned) = _redemptionWatchtower_pickBanned(
                uint256(uint160(a))
            );
            if (ok) {
                _redemptionWatchtower_unban(banned);
                ghosts.unbanned[banned] = true;
            }
        } else if (selector == 1) {
            _redemptionWatchtower_unban(a);
            ghosts.unbanned[a] = true;
        } else if (selector == 2) {
            _redemptionWatchtower_addGuardian(
                _redemptionWatchtower_pickNewGuardian(p[0])
            );
        } else if (selector == 3) {
            _redemptionWatchtower_addGuardian(a);
        } else if (selector == 4) {
            (bool ok, address removable) = _redemptionWatchtower_pickRemovable(
                p[0]
            );
            if (ok) _redemptionWatchtower_removeGuardian(removable);
        } else if (selector == 5) {
            _redemptionWatchtower_removeGuardian(a);
        } else if (selector == 6) {
            if (_redemptionWatchtower_canDisable())
                _redemptionWatchtower_disableWatchtower();
        } else if (selector == 7) {
            _redemptionWatchtower_disableWatchtower();
        } else if (selector == 8) {
            uint256[7] memory c = _redemptionWatchtower_clampParams(p);
            _redemptionWatchtower_updateWatchtowerParameters(
                uint32(c[0]),
                uint64(c[1]),
                uint32(c[2]),
                uint32(c[3]),
                uint32(c[4]),
                uint32(c[5]),
                uint64(c[6])
            );
            _redemptionWatchtower_afterParametersUpdate();
        } else {
            _redemptionWatchtower_updateWatchtowerParameters(
                uint32(p[0]),
                uint64(p[1]),
                uint32(p[2]),
                uint32(p[3]),
                uint32(p[4]),
                uint32(p[5]),
                uint64(p[6])
            );
            _redemptionWatchtower_afterParametersUpdate();
        }

        if (redemptionWatchtower.watchtowerDisabledAt() != 0) {
            ghosts.watchtowerDisabledSeen = true;
        }

        property_noPrivilegeEscalation();
        property_lifecycleRolesEnforced();
        property_guardianMinterPowersGated();
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    /// @dev `guardianSeed` selects one of the original `guardians` (the
    ///      `asGuardian` modifier takes it modulo the array length). When the
    ///      call finalizes a veto, the matching harness redemption is closed.
    function redemptionWatchtower_raiseObjection(
        uint256 guardianSeed,
        bytes20 walletPubKeyHash,
        bytes memory redeemerOutputScript
    ) public {
        uint256 key = _redemptionWatchtower_beginObjection(
            walletPubKeyHash,
            redeemerOutputScript
        );
        _redemptionWatchtower_callRaiseObjectionAsGuardian(
            guardianSeed,
            walletPubKeyHash,
            redeemerOutputScript
        );
        _redemptionWatchtower_endObjection(
            key,
            walletPubKeyHash,
            redeemerOutputScript,
            false
        );
    }

    /// @dev Raw objection from the current actor: succeeds only when the actor
    ///      was added as guardian through `addGuardian`.
    function redemptionWatchtower_raiseObjectionAsActor(
        bytes20 walletPubKeyHash,
        bytes memory redeemerOutputScript
    ) public {
        uint256 key = _redemptionWatchtower_beginObjection(
            walletPubKeyHash,
            redeemerOutputScript
        );
        _redemptionWatchtower_callRaiseObjectionAsActor(
            walletPubKeyHash,
            redeemerOutputScript
        );
        _redemptionWatchtower_endObjection(
            key,
            walletPubKeyHash,
            redeemerOutputScript,
            true
        );
    }

    function redemptionWatchtower_withdrawVetoedFunds(
        uint256 redemptionKey
    ) public {
        _setFocus(0, bytes20(0), bytes20(0), actor, redemptionKey);
        snapshotBefore();

        _redemptionWatchtower_callWithdrawVetoedFunds(redemptionKey);

        snapshotAfter();
        _redemptionWatchtower_refreshVetoShadow(redemptionKey);

        property_withdrawVetoedFundsExact();
        property_redemptionEscrowCoversPending();
        property_pendingRedemptionsValueSync();
        property_vetoEscrowCoversWithdrawable();
    }

    function _redemptionWatchtower_callRaiseObjectionAsGuardian(
        uint256 guardianSeed,
        bytes20 walletPubKeyHash,
        bytes memory redeemerOutputScript
    ) internal asGuardian(guardianSeed) {
        redemptionWatchtower.raiseObjection(
            walletPubKeyHash,
            redeemerOutputScript
        );
    }

    function _redemptionWatchtower_callRaiseObjectionAsActor(
        bytes20 walletPubKeyHash,
        bytes memory redeemerOutputScript
    ) internal asActor {
        redemptionWatchtower.raiseObjection(
            walletPubKeyHash,
            redeemerOutputScript
        );
    }

    function _redemptionWatchtower_callWithdrawVetoedFunds(
        uint256 redemptionKey
    ) internal asActor {
        redemptionWatchtower.withdrawVetoedFunds(redemptionKey);
    }

    function _redemptionWatchtower_unban(
        address redeemer
    ) internal asWatchtowerManager {
        redemptionWatchtower.unban(redeemer);
    }

    /// @dev Guardians are added by the watchtower manager.
    function _redemptionWatchtower_addGuardian(
        address guardian
    ) internal asWatchtowerManager {
        redemptionWatchtower.addGuardian(guardian);
    }

    /// @dev Guardians are removed by the owner (governance).
    function _redemptionWatchtower_removeGuardian(
        address guardian
    ) internal asGovernance {
        redemptionWatchtower.removeGuardian(guardian);
    }

    /// @dev Callable by anyone once the watchtower lifetime has expired.
    function _redemptionWatchtower_disableWatchtower() internal asActor {
        redemptionWatchtower.disableWatchtower();
    }

    /// @dev Parameters are updated by the watchtower manager.
    function _redemptionWatchtower_updateWatchtowerParameters(
        uint32 _watchtowerLifetime,
        uint64 _vetoPenaltyFeeDivisor,
        uint32 _vetoFreezePeriod,
        uint32 _defaultDelay,
        uint32 _levelOneDelay,
        uint32 _levelTwoDelay,
        uint64 _waivedAmountLimit
    ) internal asWatchtowerManager {
        redemptionWatchtower.updateWatchtowerParameters(
            _watchtowerLifetime,
            _vetoPenaltyFeeDivisor,
            _vetoFreezePeriod,
            _defaultDelay,
            _levelOneDelay,
            _levelTwoDelay,
            _waivedAmountLimit
        );
    }

    // ―――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    /// @dev Ghosts of a successful parameter update (GL-16 / GL-17).
    function _redemptionWatchtower_afterParametersUpdate() internal {
        ghosts.watchtowerParamsUpdated = true;
        uint256 lifetime = redemptionWatchtower.watchtowerLifetime();
        if (lifetime > ghosts.maxWatchtowerLifetime) {
            ghosts.maxWatchtowerLifetime = lifetime;
        }
    }

    /// @dev Sets the focus and the scratch inputs of the veto properties and
    ///      takes the "before" snapshot. The rebate fields of the snapshot
    ///      are read for the staker that would be credited with the rebate of
    ///      the request (`RebateStaking.getStaker` of the request redeemer).
    function _redemptionWatchtower_beginObjection(
        bytes20 walletPubKeyHash,
        bytes memory script
    ) internal returns (uint256 key) {
        key = _redemptionWatchtower_key(walletPubKeyHash, script);
        address redeemer = bridge.pendingRedemptions(key).redeemer;
        address staker =
            redeemer == address(0) ? actor : _peripheral_stakerOf(redeemer);

        _peripheral_vetoWallet = walletPubKeyHash;
        _peripheral_vetoScript = script;
        _peripheral_vetoRedeemer = redeemer;
        _peripheral_vetoStaker = staker;

        _setFocus(0, bytes20(0), bytes20(0), address(0), key);
        _peripheral_snapshotBeforeAs(staker);
    }

    /// @dev Snapshot, ghost updates and property calls after a successful objection.
    function _redemptionWatchtower_endObjection(
        uint256 key,
        bytes20 walletPubKeyHash,
        bytes memory script,
        bool calledAsActor
    ) internal {
        _peripheral_snapshotAfterAs(_peripheral_vetoStaker);
        _redemptionWatchtower_closeIfVetoed(walletPubKeyHash, script);

        if (
            stateBefore.vetoFinalizedAt == 0 && stateAfter.vetoFinalizedAt != 0
        ) {
            uint256 divisor = redemptionWatchtower.vetoPenaltyFeeDivisor();
            ghosts.bankBurnedSat +=
                divisor > 0 ? stateBefore.rdRequestedAmount / divisor : 0;
            // GL-05: the penalty burn removes Bank supply with no Bitcoin leaving custody, so it is surplus BTC (negative absorbed fee).
            ghosts.absorbedFeeSat -= int256(
                divisor > 0 ? stateBefore.rdRequestedAmount / divisor : 0
            );
            ghosts.pendingRedemptionKeys.remove(key);
            if (ghosts.vetoKeys.length < FIZZ_SCAN_CAP) {
                ghosts.vetoKeys.push(key);
            }
            _redemptionWatchtower_retireGrant(key);
        }

        property_vetoObjectionMachine();
        property_vetoPenaltySplit();
        property_redemptionEscrowCoversPending();
        property_pendingRedemptionsValueSync();
        property_vetoEscrowCoversWithdrawable();
        property_vetoFinalizedNotPending();
        property_cancelRebateRestoresOwnRebate();
        property_rebateDoubleDipNone();
        property_rebateHistoryAppendOnly();
        property_vetoRequesterBinding();
        if (calledAsActor) property_guardianMinterPowersGated();

        _redemptionWatchtower_refreshVetoShadow(key);
        _peripheral_refreshRebateShadow();
    }

    /// @dev Marks the live rebate grant of the vetoed request as released:
    ///      `cancelRebate` gives its rolling-window entry back.
    function _redemptionWatchtower_retireGrant(uint256 key) internal {
        uint64 rebate = ghosts.rebateApplied[key];
        if (rebate == 0) return;
        uint256 n = ghosts.rebateGrants.length;
        if (n > FIZZ_SCAN_CAP) n = FIZZ_SCAN_CAP;
        for (uint256 i; i < n; i++) {
            RebateGrant storage g = ghosts.rebateGrants[i];
            if (
                g.live &&
                g.timestamp == stateBefore.rdRequestedAt &&
                g.rebate == rebate &&
                (g.staker == _peripheral_vetoStaker ||
                    g.staker == _peripheral_vetoRedeemer)
            ) {
                g.live = false;
                return;
            }
        }
    }

    /// @dev Refreshes the `prevVeto*` shadows of `key` (after the checks).
    function _redemptionWatchtower_refreshVetoShadow(uint256 key) internal {
        (
            ,
            uint64 withdrawable,
            uint32 finalizedAt,
            uint8 objectionsCount
        ) = redemptionWatchtower.vetoProposals(key);
        ghosts.prevVetoObjections[key] = objectionsCount;
        ghosts.prevVetoFinalizedAt[key] = finalizedAt;
        ghosts.prevVetoWithdrawable[key] = withdrawable;
    }

    /// @dev `keccak256(keccak256(script) | walletPubKeyHash)`, as built by
    ///      `Redemption.getRedemptionKey`.
    function _redemptionWatchtower_key(
        bytes20 walletPubKeyHash,
        bytes memory script
    ) internal pure returns (uint256) {
        return
            uint256(
                keccak256(abi.encodePacked(keccak256(script), walletPubKeyHash))
            );
    }

    function _redemptionWatchtower_objectionsCount(
        uint256 key
    ) internal view returns (uint8 count) {
        (, , , count) = redemptionWatchtower.vetoProposals(key);
    }

    /// @dev Closes the newest open harness redemption matching the wallet and
    ///      script when the watchtower finalized its veto (the Bridge deleted
    ///      the pending request). Only called after a successful objection.
    function _redemptionWatchtower_closeIfVetoed(
        bytes20 walletPubKeyHash,
        bytes memory script
    ) internal {
        uint256 key = _redemptionWatchtower_key(walletPubKeyHash, script);
        (, , uint32 finalizedAt, ) = redemptionWatchtower.vetoProposals(key);
        if (finalizedAt == 0) return;

        bytes32 scriptHash = keccak256(script);
        for (uint256 i = harnessRedemptions.length; i > 0; i--) {
            HarnessRedemption storage r = harnessRedemptions[i - 1];
            if (
                !r.closed &&
                r.walletPkh == walletPubKeyHash &&
                keccak256(r.redeemerOutputScript) == scriptHash
            ) {
                r.closed = true;
                return;
            }
        }
    }

    /// @dev Whether harness redemption `index` can currently be objected to.
    function _redemptionWatchtower_isObjectable(
        uint256 index
    ) internal view returns (bool, uint256) {
        HarnessRedemption storage r = harnessRedemptions[index];
        if (r.closed) return (false, 0);

        uint256 key = _redemptionWatchtower_key(
            r.walletPkh,
            r.redeemerOutputScript
        );
        Redemption.RedemptionRequest memory request = bridge.pendingRedemptions(
            key
        );
        if (request.requestedAt == 0) return (false, 0);
        if (
            _redemptionWatchtower_objectionsCount(key) >=
            redemptionWatchtower.REQUIRED_OBJECTIONS_COUNT()
        ) {
            return (false, 0);
        }
        if (
            request.requestedAt >= redemptionWatchtower.watchtowerEnabledAt() &&
            block.timestamp >=
                uint256(request.requestedAt) +
                    redemptionWatchtower.getRedemptionDelay(key)
        ) {
            return (false, 0);
        }
        return (true, key);
    }

    /// @dev First objectable harness redemption from `seed % length`; looks at
    ///      no more than 32 entries.
    function _redemptionWatchtower_pickObjectable(
        uint256 seed
    ) internal view returns (bool, uint256, uint256) {
        uint256 len = harnessRedemptions.length;
        if (len == 0) return (false, 0, 0);
        uint256 limit = len < 32 ? len : 32;
        for (uint256 n; n < limit; n++) {
            uint256 index = ((seed % len) + n) % len;
            (bool ok, uint256 key) = _redemptionWatchtower_isObjectable(index);
            if (ok) return (true, index, key);
        }
        return (false, 0, 0);
    }

    /// @dev Index in `guardians` of the first guardian (from `seed`) that is
    ///      still registered in the watchtower and has not objected to `key`.
    function _redemptionWatchtower_pickGuardian(
        uint256 key,
        uint256 seed
    ) internal view returns (bool, uint256) {
        uint256 n = guardians.length;
        for (uint256 j; j < n; j++) {
            uint256 i = ((seed % n) + j) % n;
            address guardian = guardians[i];
            if (!redemptionWatchtower.isGuardian(guardian)) continue;
            if (
                redemptionWatchtower.objections(
                    uint256(keccak256(abi.encodePacked(key, guardian)))
                )
            ) continue;
            return (true, i);
        }
        return (false, 0);
    }

    /// @dev Whether the veto of `key` is finalized, past its freeze period and
    ///      still holds withdrawable funds; returns the redeemer.
    function _redemptionWatchtower_isWithdrawable(
        uint256 key
    ) internal view returns (bool, address) {
        (
            address redeemer,
            uint64 withdrawableAmount,
            uint32 finalizedAt,

        ) = redemptionWatchtower.vetoProposals(key);
        if (finalizedAt == 0 || withdrawableAmount == 0)
            return (false, address(0));
        if (
            block.timestamp <=
            uint256(finalizedAt) + redemptionWatchtower.vetoFreezePeriod()
        ) {
            return (false, address(0));
        }
        return (true, redeemer);
    }

    /// @dev First harness redemption (from `seed`, at most 32 entries) with
    ///      withdrawable vetoed funds.
    function _redemptionWatchtower_pickWithdrawable(
        uint256 seed
    ) internal view returns (bool, uint256, address) {
        uint256 len = harnessRedemptions.length;
        if (len == 0) return (false, 0, address(0));
        uint256 limit = len < 32 ? len : 32;
        for (uint256 n; n < limit; n++) {
            HarnessRedemption storage r = harnessRedemptions[
                ((seed % len) + n) % len
            ];
            uint256 key = _redemptionWatchtower_key(
                r.walletPkh,
                r.redeemerOutputScript
            );
            (bool ok, address redeemer) = _redemptionWatchtower_isWithdrawable(
                key
            );
            if (ok) return (true, key, redeemer);
        }
        return (false, 0, address(0));
    }

    /// @dev First banned actor, starting from `seed`.
    function _redemptionWatchtower_pickBanned(
        uint256 seed
    ) internal view returns (bool, address) {
        uint256 n = actors.length;
        for (uint256 j; j < n; j++) {
            address candidate = actors[((seed % n) + j) % n];
            if (redemptionWatchtower.isBanned(candidate))
                return (true, candidate);
        }
        return (false, address(0));
    }

    /// @dev A removed original guardian (re-add), else an actor (so an actor
    ///      can become a guardian), else a fresh address.
    function _redemptionWatchtower_pickNewGuardian(
        uint256 seed
    ) internal view returns (address) {
        address candidate = guardians[seed % guardians.length];
        if (!redemptionWatchtower.isGuardian(candidate)) return candidate;
        candidate = actors[seed % actors.length];
        if (!redemptionWatchtower.isGuardian(candidate)) return candidate;
        return
            address(
                uint160(
                    uint256(
                        keccak256(abi.encode("fizz.watchtower.guardian", seed))
                    )
                )
            );
    }

    /// @dev A registered original guardian, only while at least two original
    ///      guardians remain registered.
    function _redemptionWatchtower_pickRemovable(
        uint256 seed
    ) internal view returns (bool, address) {
        uint256 n = guardians.length;
        uint256 live;
        for (uint256 i; i < n; i++) {
            if (redemptionWatchtower.isGuardian(guardians[i])) live++;
        }
        if (live <= 1) return (false, address(0));
        for (uint256 j; j < n; j++) {
            address candidate = guardians[((seed % n) + j) % n];
            if (redemptionWatchtower.isGuardian(candidate))
                return (true, candidate);
        }
        return (false, address(0));
    }

    function _redemptionWatchtower_canDisable() internal view returns (bool) {
        uint256 enabledAt = redemptionWatchtower.watchtowerEnabledAt();
        return
            enabledAt != 0 &&
            redemptionWatchtower.watchtowerDisabledAt() == 0 &&
            block.timestamp >
                enabledAt + redemptionWatchtower.watchtowerLifetime();
    }

    /// @dev Clamps `updateWatchtowerParameters` arguments to the setter's
    ///      requires: lifetime >= current, divisor 0 or >= 20, delays sorted
    ///      default <= level one <= level two.
    function _redemptionWatchtower_clampParams(
        uint256[7] memory p
    ) internal returns (uint256[7] memory c) {
        uint256 current = redemptionWatchtower.watchtowerLifetime();
        uint256 maxLifetime = current + 365 days;
        if (maxLifetime > type(uint32).max) maxLifetime = type(uint32).max;
        c[0] = clampBetween(p[0], current, maxLifetime);

        c[1] = p[1] % 4 == 0 ? 0 : clampBetween(p[1], 20, 1000);
        c[2] = clampBetween(p[2], 0, 30 days);

        uint256 d0 = clampBetween(p[3], 0, 7 days);
        uint256 d1 = clampBetween(p[4], 0, 7 days);
        uint256 d2 = clampBetween(p[5], 0, 7 days);
        if (d0 > d1) (d0, d1) = (d1, d0);
        if (d1 > d2) (d1, d2) = (d2, d1);
        if (d0 > d1) (d0, d1) = (d1, d0);
        c[3] = d0;
        c[4] = d1;
        c[5] = d2;

        // 0 (no waiver), type(uint64).max (every redemption waived) or a
        // limit up to 10 BTC.
        uint256 mode = p[6] % 4;
        if (mode == 0) c[6] = 0;
        else if (mode == 1) c[6] = type(uint64).max;
        else c[6] = clampBetween(p[6], 1, 1_000_000_000);
    }
}
