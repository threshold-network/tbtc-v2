// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Base} from "./Base.sol";

import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Redemption} from "../../contracts/bridge/Redemption.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";

/// @notice Used to take snapshots of the state before and after a function call
abstract contract Snapshots is Base {
    /// @dev Snapshot of the protocol state. Per-key / per-wallet / per-
    ///      counterparty slots belong to the handler's `focus` selection and
    ///      stay zero when the matching focus field is zero.
    struct State {
        // ── Actor balances ──
        uint256 actorTbtc;
        uint256 actorBank;
        uint256 actorT;
        uint256 actorValueSumSat;
        // ── Token / Bank totals ──
        uint256 tbtcSupply;
        uint256 bankTbtcVault;
        uint256 bankReservationVault;
        uint256 bankBridge;
        uint256 bankTreasury;
        uint256 bankWatchtower;
        uint256 tbtcReservationVault;
        uint256 tbtcTreasury;
        uint256 bankTracked;
        uint256 optDebtSum;
        uint64 inKindDebtSat;
        uint256 feeReserveTarget;
        // ── Reservation aggregates ──
        uint64 resTotal;
        uint32 resActive;
        uint64 resPendingReserved;
        // ── Wallet aggregates ──
        uint32 liveWallets;
        bytes20 activeWallet;
        // ── Focus wallet 0 ──
        bytes20 fw0;
        uint32 fw0Count;
        uint64 fw0Amount;
        uint8 fw0State;
        uint64 fw0PendingValue;
        bytes32 fw0MainUtxoHash;
        uint32 fw0PendingSweeps;
        uint32 fw0ClosingStartedAt;
        // ── Focus wallet 1 ──
        bytes20 fw1;
        uint32 fw1Count;
        uint64 fw1Amount;
        uint8 fw1State;
        uint32 fw1PendingSweeps;
        // ── Focus reservation ──
        uint256 frKey;
        uint8 frState;
        uint64 frNonce;
        uint64 frAnchorAmount;
        uint64 frMintedAmount;
        uint64 frCumFee;
        bytes20 frWallet;
        uint32 frCooldownUntil;
        bytes32 frAnchorTxHash;
        uint8 frActState;
        uint64 frActAmount;
        bytes20 frActTarget;
        uint32 fdSweptAt;
        bytes20 fdMarker;
        // ── Focus counterparty ──
        address cp;
        uint256 cpTbtc;
        uint256 cpBank;
        uint256 cpOptDebt;
        /// @dev Defaults to `bank.allowance(cp, actor)`. A handler whose
        ///      property needs another (token, owner, spender) allowance
        ///      overwrites `stateBefore.focusAllowance` right after
        ///      `snapshotBefore()`.
        uint256 focusAllowance;
        // ── Focus redemption ──
        uint32 rdRequestedAt;
        uint64 rdRequestedAmount;
        uint64 rdTreasuryFee;
        // ── Rebate staking (actor) ──
        uint64 rebateAvail;
        bool rebateAvailOk;
        uint256 rebateWindowTotal;
        uint256 rebateLen;
        uint96 stakeAmount;
        uint96 unstakingAmount;
        uint32 unstakingTs;
        // ── Veto (focus redemption) ──
        uint8 vetoObjections;
        uint32 vetoFinalizedAt;
        uint64 vetoWithdrawable;
        // ── TBTCVault governance ──
        bool govPaused;
        uint256 govFeeDivisor;
        uint256 govNewFeeDivisor;
        uint256 govFeeUpdateTs;
        uint256 govDelay;
        uint256 govNewDelay;
        uint256 govDelayUpdateTs;
        // ── ETH ──
        uint256 bridgeEth;
        uint256 treasuryEth;
    }

    /// @dev The slots the next snapshot reads. Written by handlers through
    ///      `_setFocus` BEFORE `snapshotBefore()`; unused slots stay zero and
    ///      their reads are skipped.
    struct Focus {
        uint256 resKey;
        bytes20 wallet0;
        bytes20 wallet1;
        address counterparty;
        uint256 redemptionKey;
    }

    Focus internal focus;

    State internal stateBefore;
    State internal stateAfter;

    function _setFocus(
        uint256 resKey,
        bytes20 wallet0,
        bytes20 wallet1,
        address counterparty,
        uint256 redemptionKey
    ) internal {
        focus = Focus({
            resKey: resKey,
            wallet0: wallet0,
            wallet1: wallet1,
            counterparty: counterparty,
            redemptionKey: redemptionKey
        });
    }

    function snapshotBefore() internal {
        _takeSnapshot(stateBefore);
    }

    function snapshotAfter() internal {
        _takeSnapshot(stateAfter);
    }

    /// @dev Never reverts: every call that can revert (Bridge / router views
    ///      and anything keyed by a fuzzed focus) is wrapped in try/catch and
    ///      leaves the field at zero on failure.
    function _takeSnapshot(State storage state) private {
        _snapBalances(state);
        _snapAggregates(state);
        _snapWallets(state);
        _snapReservation(state);
        _snapCounterparty(state);
        _snapRedemption(state);
        _snapRebate(state);
        _snapGovernance(state);
    }

    function _snapBalances(State storage state) private {
        state.actorTbtc = tbtc.balanceOf(actor);
        state.actorBank = bank.balanceOf(actor);
        state.actorT = tToken.balanceOf(actor);

        state.tbtcSupply = tbtc.totalSupply();
        state.bankTbtcVault = bank.balanceOf(address(tbtcVault));
        state.bankReservationVault = bank.balanceOf(address(reservationVault));
        state.bankBridge = bank.balanceOf(address(bridge));
        state.bankTreasury = bank.balanceOf(treasury);
        state.bankWatchtower = bank.balanceOf(address(redemptionWatchtower));
        state.tbtcReservationVault = tbtc.balanceOf(address(reservationVault));
        state.tbtcTreasury = tbtc.balanceOf(treasury);

        state.bankTracked =
            state.bankTbtcVault +
            state.bankReservationVault +
            state.bankBridge +
            state.bankTreasury +
            state.bankWatchtower;
        state.actorValueSumSat = 0;
        state.optDebtSum = 0;
        for (uint256 i; i < actors.length; i++) {
            uint256 aBank = bank.balanceOf(actors[i]);
            state.actorValueSumSat +=
                tbtc.balanceOf(actors[i]) / SATOSHI_MULTIPLIER +
                aBank;
            state.bankTracked += aBank;
            state.optDebtSum += tbtcVault.optimisticMintingDebt(actors[i]);
        }

        state.inKindDebtSat = reservationVault.inKindFeeDebtSat();
        state.feeReserveTarget = reservationVault.feeReserveTarget();

        state.bridgeEth = address(bridge).balance;
        state.treasuryEth = treasury.balance;
    }

    function _snapAggregates(State storage state) private {
        try reservationRouter.reservationParameters() returns (
            address,
            uint64,
            uint64,
            uint32,
            uint32,
            uint64,
            uint64 totalAmount,
            uint32,
            uint32,
            uint32
        ) {
            state.resTotal = totalAmount;
        } catch {
            state.resTotal = 0;
        }
        try reservationRouter.activeReservationsCount() returns (
            uint32 count,
            uint32
        ) {
            state.resActive = count;
        } catch {
            state.resActive = 0;
        }
        try reservationRouter.pendingReservedDeposits() returns (uint64 p) {
            state.resPendingReserved = p;
        } catch {
            state.resPendingReserved = 0;
        }
        try bridge.liveWalletsCount() returns (uint32 n) {
            state.liveWallets = n;
        } catch {
            state.liveWallets = 0;
        }
        try bridge.activeWalletPubKeyHash() returns (bytes20 w) {
            state.activeWallet = w;
        } catch {
            state.activeWallet = bytes20(0);
        }
    }

    function _snapWallets(State storage state) private {
        bytes20 w0 = focus.wallet0;
        bytes20 w1 = focus.wallet1;

        state.fw0 = w0;
        state.fw0Count = 0;
        state.fw0Amount = 0;
        state.fw0State = 0;
        state.fw0PendingValue = 0;
        state.fw0MainUtxoHash = bytes32(0);
        state.fw0PendingSweeps = 0;
        state.fw0ClosingStartedAt = 0;
        if (w0 != bytes20(0)) {
            try reservationRouter.walletReservationsCount(w0) returns (
                uint32 c
            ) {
                state.fw0Count = c;
            } catch {}
            try reservationRouter.walletReservationsAmount(w0) returns (
                uint64 a
            ) {
                state.fw0Amount = a;
            } catch {}
            try bridge.wallets(w0) returns (Wallets.Wallet memory w) {
                state.fw0State = uint8(w.state);
                state.fw0PendingValue = w.pendingRedemptionsValue;
                state.fw0MainUtxoHash = w.mainUtxoHash;
                state.fw0PendingSweeps = w.pendingMovedFundsSweepRequestsCount;
                state.fw0ClosingStartedAt = w.closingStartedAt;
            } catch {}
        }

        state.fw1 = w1;
        state.fw1Count = 0;
        state.fw1Amount = 0;
        state.fw1State = 0;
        state.fw1PendingSweeps = 0;
        if (w1 != bytes20(0)) {
            try reservationRouter.walletReservationsCount(w1) returns (
                uint32 c
            ) {
                state.fw1Count = c;
            } catch {}
            try reservationRouter.walletReservationsAmount(w1) returns (
                uint64 a
            ) {
                state.fw1Amount = a;
            } catch {}
            try bridge.wallets(w1) returns (Wallets.Wallet memory w) {
                state.fw1State = uint8(w.state);
                state.fw1PendingSweeps = w.pendingMovedFundsSweepRequestsCount;
            } catch {}
        }
    }

    function _snapReservation(State storage state) private {
        uint256 key = focus.resKey;
        state.frKey = key;
        state.frState = 0;
        state.frNonce = 0;
        state.frAnchorAmount = 0;
        state.frMintedAmount = 0;
        state.frCumFee = 0;
        state.frWallet = bytes20(0);
        state.frCooldownUntil = 0;
        state.frAnchorTxHash = bytes32(0);
        state.frActState = 0;
        state.frActAmount = 0;
        state.frActTarget = bytes20(0);
        state.fdSweptAt = 0;
        state.fdMarker = bytes20(0);
        if (key == 0) {
            return;
        }

        try reservationRouter.reservations(key) returns (
            Reservation.ReservationRequest memory r
        ) {
            state.frState = uint8(r.state);
            state.frNonce = r.requestNonce;
            state.frAnchorAmount = r.anchorAmount;
            state.frMintedAmount = r.mintedAmount;
            state.frCumFee = r.cumulativeReanchorFee;
            state.frWallet = r.walletPubKeyHash;
            state.frCooldownUntil = r.reanchorCooldownUntil;
            state.frAnchorTxHash = r.anchorTxHash;
        } catch {}

        try reservationRouter.reservationActions(key, state.frNonce) returns (
            Reservation.ReservationAction memory a
        ) {
            state.frActState = uint8(a.state);
            state.frActAmount = a.amount;
            state.frActTarget = a.targetWalletPubKeyHash;
        } catch {}

        try bridge.deposits(key) returns (Deposit.DepositRequest memory d) {
            state.fdSweptAt = d.sweptAt;
        } catch {}

        try reservationRouter.reservedDepositWallet(key) returns (
            bytes20 marker
        ) {
            state.fdMarker = marker;
        } catch {}
    }

    function _snapCounterparty(State storage state) private {
        address c = focus.counterparty;
        state.cp = c;
        state.cpTbtc = 0;
        state.cpBank = 0;
        state.cpOptDebt = 0;
        state.focusAllowance = 0;
        if (c == address(0)) {
            return;
        }
        state.cpTbtc = tbtc.balanceOf(c);
        state.cpBank = bank.balanceOf(c);
        state.cpOptDebt = tbtcVault.optimisticMintingDebt(c);
        state.focusAllowance = bank.allowance(c, actor);
    }

    function _snapRedemption(State storage state) private {
        uint256 key = focus.redemptionKey;
        state.rdRequestedAt = 0;
        state.rdRequestedAmount = 0;
        state.rdTreasuryFee = 0;
        state.vetoObjections = 0;
        state.vetoFinalizedAt = 0;
        state.vetoWithdrawable = 0;
        if (key == 0) {
            return;
        }
        try bridge.pendingRedemptions(key) returns (
            Redemption.RedemptionRequest memory r
        ) {
            state.rdRequestedAt = r.requestedAt;
            state.rdRequestedAmount = r.requestedAmount;
            state.rdTreasuryFee = r.treasuryFee;
        } catch {}
        try redemptionWatchtower.vetoProposals(key) returns (
            address,
            uint64 withdrawable,
            uint32 finalizedAt,
            uint8 objections
        ) {
            state.vetoObjections = objections;
            state.vetoFinalizedAt = finalizedAt;
            state.vetoWithdrawable = withdrawable;
        } catch {}
    }

    function _snapRebate(State storage state) private {
        state.rebateAvail = 0;
        state.rebateAvailOk = false;
        try rebateStaking.getAvailableRebate(actor) returns (uint64 r) {
            state.rebateAvail = r;
            state.rebateAvailOk = true;
        } catch {}

        uint256 len = rebateStaking.getRebateLength(actor);
        state.rebateLen = len;
        uint256 windowTotal;
        if (len != 0) {
            uint256 window = rebateStaking.rollingWindow();
            uint256 windowStart =
                block.timestamp > window ? block.timestamp - window : 0;
            uint256 first = len > FIZZ_SCAN_CAP ? len - FIZZ_SCAN_CAP : 0;
            for (uint256 i = first; i < len; i++) {
                (uint32 ts, uint64 rebate) = rebateStaking.getRebate(actor, i);
                if (ts >= windowStart) {
                    windowTotal += rebate;
                }
            }
        }
        state.rebateWindowTotal = windowTotal;

        state.stakeAmount = rebateStaking.getStake(actor);
        (uint96 un, uint32 unTs) = rebateStaking.getUnstakingAmount(actor);
        state.unstakingAmount = un;
        state.unstakingTs = unTs;
    }

    function _snapGovernance(State storage state) private {
        state.govPaused = tbtcVault.isOptimisticMintingPaused();
        state.govFeeDivisor = tbtcVault.optimisticMintingFeeDivisor();
        state.govNewFeeDivisor = tbtcVault.newOptimisticMintingFeeDivisor();
        state.govFeeUpdateTs = tbtcVault
            .optimisticMintingFeeUpdateInitiatedTimestamp();
        state.govDelay = tbtcVault.optimisticMintingDelay();
        state.govNewDelay = tbtcVault.newOptimisticMintingDelay();
        state.govDelayUpdateTs = tbtcVault
            .optimisticMintingDelayUpdateInitiatedTimestamp();
    }
}
