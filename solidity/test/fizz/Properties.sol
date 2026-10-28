// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Snapshots} from "./Snapshots.sol";
import {PropertiesAsserts} from "./utils/PropertiesAsserts.sol";
import {vm} from "./utils/Hevm.sol";
import {Wallets as GlWallets} from "../../contracts/bridge/Wallets.sol";
import {BitcoinTx as PeBitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {BtcBuilder as PeBtcBuilder} from "./utils/BtcBuilder.sol";
import {Reservation as PeReservation} from "../../contracts/bridge/Reservation.sol";
import {Deposit as BrDeposit} from "../../contracts/bridge/Deposit.sol";
import {Redemption as BrRedemption} from "../../contracts/bridge/Redemption.sol";
import {Wallets as BrWallets} from "../../contracts/bridge/Wallets.sol";
import {MovingFunds as BrMovingFunds} from "../../contracts/bridge/MovingFunds.sol";
import {Fraud as BrFraud} from "../../contracts/bridge/Fraud.sol";
import {EnumerableSet as BrEnumerableSet} from "./utils/EnumerableSet.sol";
import {Reservation as RsReservation} from "../../contracts/bridge/Reservation.sol";
import {vm as RsVm} from "./utils/Hevm.sol";
import {Wallets as TvWallets} from "../../contracts/bridge/Wallets.sol";
import {Deposit as TvDeposit} from "../../contracts/bridge/Deposit.sol";
import {Redemption as TvRedemption} from "../../contracts/bridge/Redemption.sol";
import {EnumerableSet as TvEnumerableSet} from "./utils/EnumerableSet.sol";

/// @notice Contains the functions that check the properties (invariants)
abstract contract Properties is PropertiesAsserts, Snapshots {
    // ―――――――――――――――――――― Known-Failing Switch ―――――――――――――――――――――

    /// @dev Long-run campaigns skip the properties whose findings are still
    ///      open. That list belongs to the campaign records and is not part of
    ///      this snapshot, so nothing is skipped here.
    string internal constant KNOWN_FAILING_PROPERTY_IDS = "";

    /// @dev Compile-time switch for long-run fuzzing campaigns.
    ///      Returns false by default in FuzzTester and FoundryTester.
    ///      Overridden to true in FuzzTesterLongRun.
    function _skipKnownFailing() internal view virtual returns (bool) {
        return false;
    }

    // ―――――――――――――――――――― Global properties ―――――――――――――――――――――
    // These properties must always hold after any function call.
    // They MUST BE PUBLIC so that fuzzers can find and call them.

    // Global helpers (prefixed `_gl`): view-only, no ghost writes.

    uint8 internal constant GL_WS_LIVE = 1;
    uint8 internal constant GL_WS_MOVING_FUNDS = 2;
    uint8 internal constant GL_WS_CLOSING = 3;
    uint8 internal constant GL_WS_CLOSED = 4;
    /// @dev Conservative gas-safe bound for a staker's rebate array.
    uint256 internal constant GL_MAX_REBATE_LEN = 2000;

    struct GlResParams {
        address vault;
        uint64 minAmount;
        uint64 txMaxFee;
        uint32 term;
        uint64 maxTotal;
        uint64 total;
        uint32 maxPerWallet;
        uint32 actionTimeout;
        uint32 renewal;
    }

    /// @dev Number of recorded wallets to scan, capped at FIZZ_SCAN_CAP.
    function _glWalletCount() internal view returns (uint256) {
        uint256 n = harnessWallets.length;
        return n > FIZZ_SCAN_CAP ? FIZZ_SCAN_CAP : n;
    }

    /// @dev `reservationParameters()` has ten static return words; decoded
    ///      word by word because a ten-value tuple assignment exceeds the
    ///      stack limit without via_ir.
    function _glResParams() internal view returns (GlResParams memory p) {
        (bool ok, bytes memory ret) = address(reservationRouter).staticcall(
            abi.encodeWithSelector(
                reservationRouter.reservationParameters.selector
            )
        );
        require(
            ok && ret.length == 320,
            "GL: reservationParameters unavailable"
        );
        p.vault = address(uint160(_glWord(ret, 0)));
        p.minAmount = uint64(_glWord(ret, 1));
        p.txMaxFee = uint64(_glWord(ret, 2));
        p.term = uint32(_glWord(ret, 3));
        p.maxTotal = uint64(_glWord(ret, 5));
        p.total = uint64(_glWord(ret, 6));
        p.maxPerWallet = uint32(_glWord(ret, 7));
        p.actionTimeout = uint32(_glWord(ret, 8));
        p.renewal = uint32(_glWord(ret, 9));
    }

    function _glWord(
        bytes memory b,
        uint256 index
    ) private pure returns (uint256 w) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            w := mload(add(add(b, 32), mul(index, 32)))
        }
    }

    /// @dev Sum of Bank balances over B_HOLDERS (actors, TBTCVault,
    ///      ReservationVault, Bridge, treasury, RedemptionWatchtower).
    function _glBankTracked() internal view returns (uint256 sum) {
        sum =
            bank.balanceOf(address(tbtcVault)) +
            bank.balanceOf(address(reservationVault)) +
            bank.balanceOf(address(bridge)) +
            bank.balanceOf(treasury) +
            bank.balanceOf(address(redemptionWatchtower));
        for (uint256 i; i < actors.length; i++) {
            sum += bank.balanceOf(actors[i]);
        }
    }

    /// @dev Sum of TBTC balances over the same closed holder set.
    function _glTbtcTracked() internal view returns (uint256 sum) {
        sum =
            tbtc.balanceOf(address(tbtcVault)) +
            tbtc.balanceOf(address(reservationVault)) +
            tbtc.balanceOf(address(bridge)) +
            tbtc.balanceOf(treasury) +
            tbtc.balanceOf(address(redemptionWatchtower));
        for (uint256 i; i < actors.length; i++) {
            sum += tbtc.balanceOf(actors[i]);
        }
    }

    function _glOptDebtSum() internal view returns (uint256 sum) {
        for (uint256 i; i < actors.length; i++) {
            sum += tbtcVault.optimisticMintingDebt(actors[i]);
        }
    }

    function _glInList(
        address[] memory list,
        uint256 n,
        address c
    ) internal pure returns (bool) {
        for (uint256 i; i < n; i++) {
            if (list[i] == c) {
                return true;
            }
        }
        return false;
    }

    function _glCheckMinterListed(
        address[] memory list,
        uint256 n,
        address c
    ) internal {
        if (tbtcVault.isMinter(c)) {
            t(
                _glInList(list, n, c),
                "GL-19: isMinter address missing from getMinters"
            );
        }
    }

    /// @notice GL-01: TBTC supply never exceeds the TBTCVault Bank balance (x 1e10) plus optimistic-minting debt.
    function property_pegSolvency() public {
        lte(
            tbtc.totalSupply(),
            bank.balanceOf(address(tbtcVault)) * SATOSHI_MULTIPLIER +
                _glOptDebtSum(),
            "GL-01: TBTC supply exceeds Bank backing plus optimistic debt"
        );
    }

    /// @notice GL-02: supply + direct burns == (vault Bank balance - donations) * 1e10 + optimistic debt.
    function property_pegExactIdentity() public {
        uint256 bankTv = bank.balanceOf(address(tbtcVault));
        gte(
            bankTv,
            ghosts.bankDonatedToTbtcVaultSat,
            "GL-02: donated Bank balance exceeds TBTCVault Bank balance"
        );
        eq(
            tbtc.totalSupply() + ghosts.tbtcBurnedDirectWei,
            (bankTv - ghosts.bankDonatedToTbtcVaultSat) * SATOSHI_MULTIPLIER +
                _glOptDebtSum(),
            "GL-02: peg identity broken (unpaired mint/burn)"
        );
    }

    /// @notice GL-03: TBTC supply == sum of tracked-holder balances + TBTC sent to untracked recipients.
    function property_tbtcSupplyEqualsTrackedHolders() public {
        eq(
            _glTbtcTracked() + ghosts.tbtcToUntrackedWei,
            tbtc.totalSupply(),
            "GL-03: tracked TBTC balances + untracked != totalSupply"
        );
    }

    /// @notice GL-04: tracked + untracked Bank balance == setup baseline + issued - burned.
    function property_bankIssuanceLedger() public {
        eq(
            _glBankTracked() + ghosts.bankToUntrackedSat + ghosts.bankBurnedSat,
            actors.length * ACTOR_BANK_BALANCE_SAT + ghosts.bankIssuedSat,
            "GL-04: Bank issuance ledger mismatch"
        );
    }

    /// @notice GL-05: Bank supply above the setup baseline == Bitcoin custody + in-kind debt + absorbed fees.
    /// @dev Untracked Bank balance is included on the supply side (consistent with GL-04).
    function property_btcBackingLedger() public {
        int256 supplyAboveBase =
            int256(_glBankTracked() + ghosts.bankToUntrackedSat) -
                int256(INIT_BANK_SAT);
        int256 backing =
            int256(ghosts.btcCustodySat) +
                int256(uint256(reservationVault.inKindFeeDebtSat())) +
                ghosts.absorbedFeeSat;
        eq(supplyAboveBase, backing, "GL-05: Bitcoin backing ledger mismatch");
    }

    /// @notice GL-06: ReservationVault Bank balance equals the Bank balance donated to it.
    function property_rvBankBalanceEqualsDonations() public {
        eq(
            bank.balanceOf(address(reservationVault)),
            ghosts.bankDonatedToRvSat,
            "GL-06: ReservationVault Bank balance != donations"
        );
    }

    /// @notice GL-07: no residual Bank/TBTC allowance from ReservationVault to TBTCVault.
    function property_rvNoResidualAllowances() public {
        eq(
            bank.allowance(address(reservationVault), address(tbtcVault)),
            0,
            "GL-07: residual Bank allowance rv -> tbtcVault"
        );
        eq(
            tbtc.allowance(address(reservationVault), address(tbtcVault)),
            0,
            "GL-07: residual TBTC allowance rv -> tbtcVault"
        );
    }

    /// @notice GL-08: ReservationVault TBTC balance == fees retained + donated - swept - burned from reserve.
    function property_rvTbtcLedger() public {
        eq(
            tbtc.balanceOf(address(reservationVault)) +
                ghosts.rvFeesSweptWei +
                (ghosts.rvFinanceBurnedSat + ghosts.rvSweepDebtBurnedSat) *
                    SATOSHI_MULTIPLIER,
            ghosts.rvFeesRetainedWei + ghosts.tbtcDonatedToRvWei,
            "GL-08: ReservationVault TBTC ledger mismatch"
        );
    }

    /// @notice GL-09: financed miner fee == burned from reserve + outstanding debt + repaid debt + swept debt.
    function property_inKindDebtLedger() public {
        eq(
            ghosts.minerFeeSat,
            ghosts.rvFinanceBurnedSat +
                uint256(reservationVault.inKindFeeDebtSat()) +
                ghosts.rvDebtRepaidSat +
                ghosts.rvSweepDebtBurnedSat,
            "GL-09: in-kind fee debt ledger mismatch"
        );
    }

    /// @notice GL-10: post-setup wiring and role latches stay intact.
    function property_wiringAndRoleLatches() public {
        t(
            tbtc.owner() == address(tbtcVault),
            "GL-10: TBTC owner is not TBTCVault"
        );
        t(bank.bridge() == address(bridge), "GL-10: Bank bridge changed");
        t(bank.owner() == governance, "GL-10: Bank owner != governance");
        t(
            tbtcVault.owner() == governance,
            "GL-10: TBTCVault owner != governance"
        );
        t(
            reservationVault.owner() == governance,
            "GL-10: ReservationVault owner != governance"
        );
        t(
            rebateStaking.owner() == governance,
            "GL-10: RebateStaking owner != governance"
        );
        t(
            redemptionWatchtower.owner() == governance,
            "GL-10: RedemptionWatchtower owner != governance"
        );
        t(
            reservationRouter.reservationRouter() ==
                address(reservationRouterImpl),
            "GL-10: reservation router latch changed"
        );
        t(
            address(reservationVault.tbtcVault()) == address(tbtcVault),
            "GL-10: ReservationVault tbtcVault changed"
        );
        t(
            address(reservationVault.bridge()) == address(bridge),
            "GL-10: ReservationVault bridge changed"
        );
        t(
            address(reservationVault.tbtcToken()) == address(tbtc),
            "GL-10: ReservationVault tbtcToken changed"
        );
        if (!ghosts.vaultTrustRevoked) {
            t(
                bridge.isVaultTrusted(address(tbtcVault)),
                "GL-10: TBTCVault not trusted"
            );
            t(
                bridge.isVaultTrusted(address(reservationVault)),
                "GL-10: ReservationVault not trusted"
            );
        }
        for (uint256 i; i < actors.length; i++) {
            eq(bank.nonces(actors[i]), 0, "GL-10: Bank nonce advanced");
        }
    }

    /// @notice GL-11: the Bank never holds a balance for itself.
    function property_bankNoSelfBalance() public {
        eq(
            bank.balanceOf(address(bank)),
            0,
            "GL-11: Bank holds a balance for itself"
        );
    }

    /// @notice GL-12: nothing is ever credited to address(0) (TBTC, Bank, T).
    function property_zeroAddressClean() public {
        eq(tbtc.balanceOf(address(0)), 0, "GL-12: TBTC credited to address(0)");
        eq(
            bank.balanceOf(address(0)),
            0,
            "GL-12: Bank balance credited to address(0)"
        );
        eq(tToken.balanceOf(address(0)), 0, "GL-12: T credited to address(0)");
    }

    /// @notice GL-13: amountToSatoshis is a fixed pure conversion regardless of donations (stateful half lives in the mint handlers).
    function property_noMintRateManipulation() public {
        uint256 p = 1e18 + 123;
        (uint256 c, uint256 r, uint256 s) = tbtcVault.amountToSatoshis(p);
        eq(
            c,
            p - (p % SATOSHI_MULTIPLIER),
            "GL-13: convertible amount drifted"
        );
        eq(r, p % SATOSHI_MULTIPLIER, "GL-13: remainder drifted");
        eq(s, c / SATOSHI_MULTIPLIER, "GL-13: satoshis drifted");
        (c, r, s) = tbtcVault.amountToSatoshis(SATOSHI_MULTIPLIER);
        eq(c, SATOSHI_MULTIPLIER, "GL-13: 1 sat of TBTC not convertible");
        eq(r, 0, "GL-13: 1 sat of TBTC has a remainder");
        eq(s, 1, "GL-13: 1 sat of TBTC does not yield 1 sat");
    }

    /// @notice GL-14: amountToSatoshis splits any amount exactly and is monotone.
    function property_amountToSatoshisSound() public {
        uint256[6] memory xs = [
            0,
            1,
            SATOSHI_MULTIPLIER - 1,
            SATOSHI_MULTIPLIER,
            SATOSHI_MULTIPLIER + 1,
            ghosts.lastFuzzedAmount
        ];
        for (uint256 i; i < xs.length; i++) {
            (uint256 c, uint256 r, uint256 s) = tbtcVault.amountToSatoshis(
                xs[i]
            );
            eq(c + r, xs[i], "GL-14: convertible + remainder != amount");
            lt(r, SATOSHI_MULTIPLIER, "GL-14: remainder >= SATOSHI_MULTIPLIER");
            eq(
                c,
                s * SATOSHI_MULTIPLIER,
                "GL-14: convertible != satoshis * 1e10"
            );
        }
        uint256 last = ghosts.lastFuzzedAmount;
        if (last != type(uint256).max) {
            (, , uint256 s0) = tbtcVault.amountToSatoshis(last);
            (, , uint256 s1) = tbtcVault.amountToSatoshis(last + 1);
            gte(s1, s0, "GL-14: amountToSatoshis not monotone");
        }
    }

    /// @notice GL-15: protocol infrastructure addresses are never banned by the RedemptionWatchtower.
    function property_infraNeverBanned() public {
        t(
            !redemptionWatchtower.isBanned(address(tbtcVault)),
            "GL-15: TBTCVault banned"
        );
        t(
            !redemptionWatchtower.isBanned(address(reservationVault)),
            "GL-15: ReservationVault banned"
        );
        t(
            !redemptionWatchtower.isBanned(address(bridge)),
            "GL-15: Bridge banned"
        );
        t(!redemptionWatchtower.isBanned(address(bank)), "GL-15: Bank banned");
    }

    /// @notice GL-16: after a watchtower parameter update the veto penalty divisor is 0 or >= 20 (<= 5%).
    function property_vetoPenaltyDivisorCapped() public {
        uint64 d = redemptionWatchtower.vetoPenaltyFeeDivisor();
        t(
            !ghosts.watchtowerParamsUpdated || d == 0 || d >= 20,
            "GL-16: veto penalty above 5%"
        );
    }

    /// @notice GL-17: watchtower delays stay ordered, lifetime never shrinks, enabled/disabled markers stick.
    function property_watchtowerParamsOrdered() public {
        t(
            redemptionWatchtower.defaultDelay() <=
                redemptionWatchtower.levelOneDelay(),
            "GL-17: defaultDelay > levelOneDelay"
        );
        t(
            redemptionWatchtower.levelOneDelay() <=
                redemptionWatchtower.levelTwoDelay(),
            "GL-17: levelOneDelay > levelTwoDelay"
        );
        gte(
            uint256(redemptionWatchtower.watchtowerLifetime()),
            ghosts.maxWatchtowerLifetime,
            "GL-17: watchtower lifetime decreased"
        );
        t(
            redemptionWatchtower.watchtowerEnabledAt() != 0,
            "GL-17: watchtower enabled marker cleared"
        );
        t(
            !ghosts.watchtowerDisabledSeen ||
                redemptionWatchtower.watchtowerDisabledAt() != 0,
            "GL-17: watchtower disabled marker cleared"
        );
    }

    /// @notice GL-18: TBTCVault staged parameter slots are zero when no update is initiated.
    function property_tbtcVaultStagingClean() public {
        if (tbtcVault.optimisticMintingFeeUpdateInitiatedTimestamp() == 0) {
            eq(
                uint256(tbtcVault.newOptimisticMintingFeeDivisor()),
                0,
                "GL-18: stale staged fee divisor"
            );
        }
        if (tbtcVault.optimisticMintingDelayUpdateInitiatedTimestamp() == 0) {
            eq(
                uint256(tbtcVault.newOptimisticMintingDelay()),
                0,
                "GL-18: stale staged minting delay"
            );
        }
    }

    /// @notice GL-19: TBTCVault minter list and isMinter mapping stay in sync, without duplicates.
    function property_tbtcVaultRoleSetSync() public {
        address[] memory list = tbtcVault.getMinters();
        uint256 n = list.length > FIZZ_SCAN_CAP ? FIZZ_SCAN_CAP : list.length;
        for (uint256 i; i < n; i++) {
            t(tbtcVault.isMinter(list[i]), "GL-19: listed minter not flagged");
            for (uint256 j; j < i; j++) {
                t(list[i] != list[j], "GL-19: duplicate minter");
            }
        }
        if (list.length > n) {
            return;
        }
        for (uint256 i; i < minters.length; i++) {
            _glCheckMinterListed(list, n, minters[i]);
        }
        for (uint256 i; i < actors.length; i++) {
            _glCheckMinterListed(list, n, actors[i]);
        }
        for (uint256 i; i < guardians.length; i++) {
            _glCheckMinterListed(list, n, guardians[i]);
        }
    }

    /// @notice GL-20: RebateStaking holds at least the T recorded as staked by the actors.
    function property_rebateStakingCustody() public {
        uint256 staked;
        for (uint256 i; i < actors.length; i++) {
            staked += rebateStaking.getStake(actors[i]);
        }
        gte(
            tToken.balanceOf(address(rebateStaking)),
            staked,
            "GL-20: RebateStaking T balance below recorded stakes"
        );
    }

    /// @notice GL-21: an actor's pending unstaking amount never exceeds the staked amount.
    function property_unstakingWithinStake() public {
        for (uint256 i; i < actors.length; i++) {
            (uint96 un, ) = rebateStaking.getUnstakingAmount(actors[i]);
            lte(
                uint256(un),
                uint256(rebateStaking.getStake(actors[i])),
                "GL-21: unstaking amount exceeds stake"
            );
        }
    }

    /// @notice GL-22: RebateStaking stake / unstaking / delegation state is coherent.
    function property_rebateDelegationCoherent() public {
        for (uint256 i; i < actors.length; i++) {
            address a = actors[i];
            (uint96 un, uint32 ts) = rebateStaking.getUnstakingAmount(a);
            t(
                (ts == 0) == (un == 0),
                "GL-22: unstaking timestamp/amount out of sync"
            );
            address d = rebateStaking.getDelegatee(a);
            if (rebateStaking.getStake(a) == 0) {
                t(d == address(0), "GL-22: non-staker has a delegatee");
            }
            if (d != address(0)) {
                t(
                    rebateStaking.delegates(d) == a,
                    "GL-22: delegates map not symmetric"
                );
                t(
                    rebateStaking.getStake(d) == 0,
                    "GL-22: delegatee holds stake"
                );
            }
            address s = rebateStaking.delegates(a);
            if (s != address(0)) {
                t(
                    rebateStaking.getDelegatee(s) == a,
                    "GL-22: delegation back-reference missing"
                );
            }
        }
    }

    /// @notice GL-23: rebate cap rounds down and splitting stake cannot amplify it.
    function property_rebateCapFloor() public {
        uint256 rpt = rebateStaking.rebatePerToken();
        uint256 capSum;
        uint256 effSum;
        for (uint256 i; i < actors.length; i++) {
            uint256 stake = rebateStaking.getStake(actors[i]);
            (uint96 un, ) = rebateStaking.getUnstakingAmount(actors[i]);
            if (uint256(un) > stake) {
                continue; // reported by GL-21
            }
            uint256 eff = stake - uint256(un);
            uint256 expected = rpt == 0 ? 0 : eff / rpt;
            if (expected > type(uint64).max) {
                continue; // reported by GL-24
            }
            eq(
                uint256(rebateStaking.getRebateCap(actors[i])),
                expected,
                "GL-23: rebate cap != floor((stake - unstaking) / rebatePerToken)"
            );
            capSum += expected;
            effSum += eff;
        }
        if (rpt != 0) {
            lte(
                capSum,
                effSum / rpt,
                "GL-23: summed caps exceed floor of summed stake"
            );
        }
    }

    /// @notice GL-24: rebate cap fits uint64 and the rebate array stays gas-safe.
    function property_rebateCapAndWindowBounded() public {
        if (_skipKnownFailing()) return;
        uint256 rpt = rebateStaking.rebatePerToken();
        for (uint256 i; i < actors.length; i++) {
            if (rpt != 0) {
                uint256 stake = rebateStaking.getStake(actors[i]);
                (uint96 un, ) = rebateStaking.getUnstakingAmount(actors[i]);
                if (uint256(un) <= stake) {
                    lte(
                        (stake - uint256(un)) / rpt,
                        uint256(type(uint64).max),
                        "GL-24: rebate cap overflows uint64"
                    );
                }
            }
            lte(
                rebateStaking.getRebateLength(actors[i]),
                GL_MAX_REBATE_LEN,
                "GL-24: rebate array too long"
            );
        }
    }

    /// @notice GL-25: getAvailableRebate never reverts for an actor.
    function property_availableRebateNeverReverts() public {
        if (_skipKnownFailing()) return;
        for (uint256 i; i < actors.length; i++) {
            try rebateStaking.getAvailableRebate(actors[i]) returns (
                uint64
            ) {} catch {
                t(false, "GL-25: getAvailableRebate reverted");
            }
        }
    }

    /// @notice GL-26: a Closed wallet holds no reservations.
    function property_closedWalletHoldsNoReservations() public {
        uint256 n = _glWalletCount();
        for (uint256 i; i < n; i++) {
            bytes20 w = harnessWallets[i];
            if (uint8(bridge.wallets(w).state) == GL_WS_CLOSED) {
                eq(
                    uint256(reservationRouter.walletReservationsCount(w)),
                    0,
                    "GL-26: Closed wallet still custodies reservations"
                );
                eq(
                    uint256(reservationRouter.walletReservationsAmount(w)),
                    0,
                    "GL-26: Closed wallet still holds reserved amount"
                );
            }
        }
    }

    /// @notice GL-27: liveWalletsCount matches the Live wallets and the active wallet is Live.
    function property_liveWalletsCountSync() public {
        uint256 n = _glWalletCount();
        uint256 live;
        for (uint256 i; i < n; i++) {
            if (uint8(bridge.wallets(harnessWallets[i]).state) == GL_WS_LIVE) {
                live++;
            }
        }
        eq(
            uint256(bridge.liveWalletsCount()),
            live,
            "GL-27: liveWalletsCount != number of Live wallets"
        );
        bytes20 active = bridge.activeWalletPubKeyHash();
        if (active != bytes20(0)) {
            t(
                uint8(bridge.wallets(active).state) == GL_WS_LIVE,
                "GL-27: active wallet is not Live"
            );
        }
    }

    /// @notice GL-28: reservation caps hold as bounds (skipped while governance lowered a cap below occupancy).
    function property_capsHold() public {
        if (ghosts.capsLoweredBelowOccupancy) {
            return;
        }
        GlResParams memory p = _glResParams();
        (uint64 perWalletAmt, , uint32 maxActive, ) = reservationRouter
            .reservationCaps();
        (uint32 active, ) = reservationRouter.activeReservationsCount();
        lte(
            uint256(active),
            uint256(maxActive),
            "GL-28: active reservations above cap"
        );
        if (p.maxTotal != 0) {
            lte(
                uint256(p.total),
                uint256(p.maxTotal),
                "GL-28: total reserved amount above cap"
            );
        }
        uint256 n = _glWalletCount();
        for (uint256 i; i < n; i++) {
            bytes20 w = harnessWallets[i];
            lte(
                uint256(reservationRouter.walletReservationsCount(w)),
                uint256(p.maxPerWallet),
                "GL-28: wallet reservation count above cap"
            );
            if (perWalletAmt != 0) {
                lte(
                    uint256(reservationRouter.walletReservationsAmount(w)),
                    uint256(perWalletAmt),
                    "GL-28: wallet reserved amount above cap"
                );
            }
        }
    }

    /// @notice GL-29: reservation parameter / cap relations hold whenever parameters are configured.
    function property_reservationParamsRelational() public {
        GlResParams memory p = _glResParams();
        if (p.vault == address(0)) {
            return;
        }
        t(p.txMaxFee > 0, "GL-29: txMaxFee is zero");
        t(p.minAmount > p.txMaxFee, "GL-29: minAmount <= txMaxFee");
        t(p.term >= 90 days && p.term <= 730 days, "GL-29: term out of bounds");
        t(
            p.renewal > 0 && p.renewal < p.term,
            "GL-29: renewal window not in (0, term)"
        );
        t(
            p.actionTimeout > 2 hours,
            "GL-29: actionTimeout <= 2h safety margin"
        );
        t(p.maxPerWallet > 0, "GL-29: maxReservationsPerWallet is zero");
        (, uint64 maxSingle, uint32 maxActive, ) = reservationRouter
            .reservationCaps();
        t(maxActive > 0, "GL-29: maxActiveReservations is zero");
        if (p.maxTotal != 0 && maxSingle != 0) {
            lte(
                uint256(p.maxTotal),
                uint256(maxActive) * uint256(maxSingle),
                "GL-29: maxTotal above slot capacity"
            );
        }
        lte(
            uint256(reservationVault.initiationFeeBps()),
            500,
            "GL-29: initiation fee above 5%"
        );
    }

    /// @notice GL-30: active reservation count is zero iff the total reserved amount is zero; amount >= count.
    function property_reservationCountersZeroIff() public {
        GlResParams memory p = _glResParams();
        (uint32 active, ) = reservationRouter.activeReservationsCount();
        t(
            (active == 0) == (p.total == 0),
            "GL-30: active count and total reserved amount disagree on emptiness"
        );
        gte(
            uint256(p.total),
            uint256(active),
            "GL-30: total reserved amount below active count"
        );
    }

    /// @notice GL-31: a Closing/Closed wallet has no pending moved-funds sweep requests.
    function property_closedWalletNoPendingSweeps() public {
        uint256 n = _glWalletCount();
        for (uint256 i; i < n; i++) {
            GlWallets.Wallet memory w = bridge.wallets(harnessWallets[i]);
            uint8 st = uint8(w.state);
            if (st == GL_WS_CLOSING || st == GL_WS_CLOSED) {
                eq(
                    uint256(w.pendingMovedFundsSweepRequestsCount),
                    0,
                    "GL-31: Closing/Closed wallet has pending sweep requests"
                );
            }
        }
    }

    /// @notice GL-32: a Closing/Closed wallet has no pending redemptions value.
    function property_closedWalletNoPendingRedemptions() public {
        uint256 n = _glWalletCount();
        for (uint256 i; i < n; i++) {
            GlWallets.Wallet memory w = bridge.wallets(harnessWallets[i]);
            uint8 st = uint8(w.state);
            if (st == GL_WS_CLOSING || st == GL_WS_CLOSED) {
                eq(
                    uint256(w.pendingRedemptionsValue),
                    0,
                    "GL-32: Closing/Closed wallet has pending redemptions"
                );
            }
        }
    }

    /// @notice GL-33: pending redemptions value of a Live/MovingFunds wallet never exceeds its main UTXO value.
    function property_walletPendingValueWithinMainUtxo() public {
        uint256 n = _glWalletCount();
        for (uint256 i; i < n; i++) {
            bytes20 wh = harnessWallets[i];
            GlWallets.Wallet memory w = bridge.wallets(wh);
            uint8 st = uint8(w.state);
            if (
                (st == GL_WS_LIVE || st == GL_WS_MOVING_FUNDS) &&
                w.mainUtxoHash != bytes32(0)
            ) {
                // GL-33: allow the Bitcoin fee slack the wallet itself created (fee it paid beyond what it charged requests).
                lte(
                    uint256(w.pendingRedemptionsValue),
                    uint256(harnessMainUtxo[wh].txOutputValue) +
                        ghosts.walletFeeSlackSat[wh],
                    "GL-33: pending redemptions exceed main UTXO value (beyond wallet-absorbed fees)"
                );
            }
        }
    }

    /// @notice GL-34: deposit parameters keep every swept deposit strictly positive after fees.
    function property_depositParamsConsistent() public {
        (uint64 dust, uint64 div, uint64 txMax, ) = bridge.depositParameters();
        if (div == 0) {
            gt(uint256(dust), uint256(txMax), "GL-34: dust <= txMaxFee");
        } else {
            gt(
                uint256(dust),
                uint256(txMax) + uint256(dust) / uint256(div),
                "GL-34: dust <= txMaxFee + treasury fee"
            );
        }
    }

    /// @notice GL-35: per-state wallet timestamp / commitment fields stay consistent.
    function property_walletFieldSync() public {
        uint256 n = _glWalletCount();
        for (uint256 i; i < n; i++) {
            GlWallets.Wallet memory w = bridge.wallets(harnessWallets[i]);
            uint8 st = uint8(w.state);
            if (st == GL_WS_LIVE) {
                eq(
                    uint256(w.movingFundsRequestedAt),
                    0,
                    "GL-35: Live wallet has movingFundsRequestedAt"
                );
                eq(
                    uint256(w.closingStartedAt),
                    0,
                    "GL-35: Live wallet has closingStartedAt"
                );
                t(
                    w.movingFundsTargetWalletsCommitmentHash == bytes32(0),
                    "GL-35: Live wallet has a moving-funds commitment"
                );
            } else if (st == GL_WS_MOVING_FUNDS) {
                gt(
                    uint256(w.movingFundsRequestedAt),
                    0,
                    "GL-35: MovingFunds wallet without movingFundsRequestedAt"
                );
                eq(
                    uint256(w.closingStartedAt),
                    0,
                    "GL-35: MovingFunds wallet has closingStartedAt"
                );
            } else if (st == GL_WS_CLOSING || st == GL_WS_CLOSED) {
                gt(
                    uint256(w.closingStartedAt),
                    0,
                    "GL-35: Closing/Closed wallet without closingStartedAt"
                );
            }
            if (w.movingFundsTargetWalletsCommitmentHash != bytes32(0)) {
                t(
                    st != GL_WS_LIVE && st != 0,
                    "GL-35: commitment set on Live/Unknown wallet"
                );
            }
        }
    }

    // ――――――――――――――――――― Specific properties ――――――――――――――――――――
    // These properties must hold after specific function calls.
    // They MUST BE INTERNAL and called at the end of the relevant handlers.

    // ── Specific: TokenVault shard (Bank / TBTC / TBTCVault handlers) ──
    // Context carried from the TokenVault handlers to the specific properties
    // (handler-written, like a ghost; every handler clears it with
    // `_tv_clearOp()` when done).

    uint256 internal constant TV_GOVERNANCE_DELAY = 24 hours;

    enum TvKind {
        None,
        Mint,
        Unmint,
        UnmintRedeem,
        BankTransfer,
        BankTransferFrom,
        BankApprove,
        BankIncrease,
        BankDecrease,
        TbtcTransfer,
        TbtcTransferFrom,
        TbtcBurn,
        TbtcBurnFrom,
        OptRequest,
        OptFinalize,
        OptCancel,
        GovPause,
        GovUnpause,
        GovBeginFee,
        GovFinalizeFee,
        GovBeginDelay,
        GovFinalizeDelay
    }

    struct TvOp {
        TvKind kind;
        // Balance owner / source of the move (transfers, burns, redemptions).
        address owner;
        // Receiver of the move (transfers).
        address recipient;
        // Amount of the operation (unit depends on `kind`).
        uint256 amount;
        // Redemption key / deposit key of the operation.
        uint256 key;
        // Free slot: ghost value read before the operation.
        uint256 aux;
        // SP-27: all preconditions of the redemption request held.
        bool pre;
        // SP-27: the redemption request reverted.
        bool reverted;
    }

    TvOp internal tvOp;

    /// @dev Next harness deposit scanned by the optimistic-minting shadow check.
    uint256 internal tvOptCursor;

    /// @dev Redemption request under construction by a TokenVault handler.
    struct TvRedeem {
        bytes20 pkh;
        address redeemer;
        address owner;
        uint256 key;
        uint256 amountSat;
        bytes32 utxoTxHash;
        uint32 utxoIndex;
        uint64 utxoValue;
        bytes script;
        bool pre;
    }

    // ── TokenVault helpers ──

    function _tv_setOp(
        TvKind kind,
        address owner,
        address recipient,
        uint256 amount
    ) internal {
        tvOp = TvOp({
            kind: kind,
            owner: owner,
            recipient: recipient,
            amount: amount,
            key: 0,
            aux: 0,
            pre: false,
            reverted: false
        });
    }

    function _tv_clearOp() internal {
        delete tvOp;
    }

    function _tv_pendingRedemptionCount() internal view returns (uint256) {
        return TvEnumerableSet.length(ghosts.pendingRedemptionKeys);
    }

    /// @dev `after_ - before_` as a signed number.
    function _tv_d(
        uint256 before_,
        uint256 after_
    ) internal pure returns (int256) {
        return int256(after_) - int256(before_);
    }

    /// @dev Expected balance change of `a` for the move described by `tvOp`.
    function _tv_deltaFor(address a) internal view returns (int256 d) {
        if (a == tvOp.owner) d -= int256(tvOp.amount);
        if (a == tvOp.recipient) d += int256(tvOp.amount);
    }

    /// @dev Tracked holder set (actors, TBTCVault, ReservationVault, Bridge,
    ///      treasury, RedemptionWatchtower).
    function _tv_isHolder(address a) internal view returns (bool) {
        for (uint256 i; i < actors.length; i++) {
            if (actors[i] == a) return true;
        }
        return
            a == address(tbtcVault) ||
            a == address(reservationVault) ||
            a == address(bridge) ||
            a == treasury ||
            a == address(redemptionWatchtower);
    }

    /// @dev An actor different from the current one.
    function _tv_otherActor() internal view returns (address) {
        uint256 n = actors.length;
        for (uint256 i; i < n; i++) {
            if (actors[i] == actor) return actors[(i + 1) % n];
        }
        return actors[0];
    }

    /// @dev `allowance` spent by a transferFrom / burnFrom: exactly `amt`
    ///      unless it was the `uint256` maximum.
    function _tv_checkAllowanceSpent(
        uint256 amt,
        string memory reason
    ) internal {
        uint256 aB = stateBefore.focusAllowance;
        uint256 aA = stateAfter.focusAllowance;
        if (aB == type(uint256).max) {
            eq(aA, aB, reason);
        } else {
            eq(_tv_d(aA, aB), int256(amt), reason);
        }
    }

    function _tv_refreshOptDebt() internal {
        for (uint256 i; i < actors.length; i++) {
            ghosts.prevOptDebt[actors[i]] = tbtcVault.optimisticMintingDebt(
                actors[i]
            );
        }
    }

    /// @dev Refreshes the optimistic-minting shadows of the window scanned by
    ///      `property_optimisticRequestMachine` and advances the cursor. Call
    ///      after the check.
    function _tv_advanceOptShadows() internal {
        uint256 n = harnessDeposits.length;
        if (n == 0) return;
        uint256 steps = n < FIZZ_CURSOR_STEP ? n : FIZZ_CURSOR_STEP;
        for (uint256 s; s < steps; s++) {
            HarnessDeposit storage hd = harnessDeposits[(tvOptCursor + s) % n];
            if (hd.vault != address(tbtcVault)) continue;
            uint256 key = tbtcVault.calculateDepositKey(
                hd.fundingTxHash,
                hd.outputIndex
            );
            (uint64 rq, uint64 fin) = tbtcVault.optimisticMintingRequests(key);
            ghosts.prevOptRequestedAt[key] = rq;
            ghosts.prevOptFinalizedAt[key] = fin;
        }
        tvOptCursor = (tvOptCursor + steps) % n;
    }

    /// @dev Donation / untracked bookkeeping for a Bank transfer to `recipient`.
    function _tv_bankRecipientGhosts(
        address recipient,
        uint256 amount
    ) internal {
        if (recipient == address(tbtcVault)) {
            ghosts.bankDonatedToTbtcVaultSat += amount;
            ghosts.anyDonation = true;
        } else if (recipient == address(reservationVault)) {
            ghosts.bankDonatedToRvSat += amount;
            ghosts.anyDonation = true;
        } else if (recipient == address(bridge)) {
            ghosts.bankDonatedToBridgeSat += amount;
            ghosts.anyDonation = true;
        } else if (recipient == address(redemptionWatchtower)) {
            ghosts.bankDonatedToWatchtowerSat += amount;
            ghosts.anyDonation = true;
        } else if (!_tv_isHolder(recipient)) {
            ghosts.bankToUntrackedSat += amount;
        }
    }

    /// @dev Donation / untracked bookkeeping for a TBTC transfer to `recipient`.
    function _tv_tbtcRecipientGhosts(
        address recipient,
        uint256 amount
    ) internal {
        if (recipient == address(reservationVault)) {
            ghosts.tbtcDonatedToRvWei += amount;
            ghosts.anyDonation = true;
        } else if (
            recipient == address(tbtcVault) || recipient == address(bridge)
        ) {
            ghosts.anyDonation = true;
        } else if (!_tv_isHolder(recipient)) {
            ghosts.tbtcToUntrackedWei += amount;
        }
    }

    /// @dev `ghosts.prevRebateLen/FeeSum[user]` refresh (after the check).
    function _tv_refreshRebateShadow(address user) internal {
        uint256 len = rebateStaking.getRebateLength(user);
        uint256 n = len < FIZZ_SCAN_CAP ? len : FIZZ_SCAN_CAP;
        uint256 sum;
        for (uint256 i; i < n; i++) {
            (, uint64 fee) = rebateStaking.getRebate(user, i);
            sum += fee;
        }
        ghosts.prevRebateLen[user] = len;
        ghosts.prevRebateFeeSum[user] = sum;
    }

    /// @dev True when two live rebate grants of the same staker share the
    ///      current timestamp (cancelRebate aliasing).
    function _tv_sameBlockRebate() internal view returns (bool) {
        uint256 n = ghosts.rebateGrants.length;
        for (uint256 i; i < n; i++) {
            RebateGrant storage gi = ghosts.rebateGrants[i];
            if (!gi.live || gi.timestamp != uint32(block.timestamp)) continue;
            for (uint256 j = i + 1; j < n; j++) {
                RebateGrant storage gj = ghosts.rebateGrants[j];
                if (
                    gj.live &&
                    gj.timestamp == gi.timestamp &&
                    gj.staker == gi.staker
                ) return true;
            }
        }
        return false;
    }

    /// @dev True when any live rebate grant carries the current timestamp. A later zero-rebate request in the
    ///      same second aliases onto it in RebateStaking.cancelRebate (SP-40).
    function _tv_liveGrantAtNow() internal view returns (bool) {
        uint256 n = ghosts.rebateGrants.length;
        for (uint256 i; i < n; i++) {
            RebateGrant storage g = ghosts.rebateGrants[i];
            if (g.live && g.timestamp == uint32(block.timestamp)) return true;
        }
        return false;
    }

    function _tv_b20(
        bytes memory s,
        uint256 off
    ) private pure returns (bytes20 out) {
        for (uint256 i; i < 20; i++) {
            out |= bytes20(s[off + i]) >> (8 * i);
        }
    }

    /// @dev Length-prefixed P2PKH / P2WPKH / P2SH / P2WSH output script whose
    ///      20-byte payload (if any) is not the wallet public key hash.
    function _tv_isStandardScript(
        bytes memory s,
        bytes20 pkh
    ) internal pure returns (bool) {
        if (s.length < 2) return false;
        uint256 n = uint8(s[0]);
        if (s.length != n + 1) return false;
        bytes20 payload;
        if (
            n == 25 &&
            s[1] == 0x76 &&
            s[2] == 0xa9 &&
            s[3] == 0x14 &&
            s[24] == 0x88 &&
            s[25] == 0xac
        ) {
            payload = _tv_b20(s, 4);
        } else if (n == 22 && s[1] == 0x00 && s[2] == 0x14) {
            payload = _tv_b20(s, 3);
        } else if (n == 23 && s[1] == 0xa9 && s[2] == 0x14 && s[23] == 0x87) {
            payload = _tv_b20(s, 3);
        } else if (n == 34 && s[1] == 0x00 && s[2] == 0x20) {
            return true;
        } else {
            return false;
        }
        return payload != pkh;
    }

    /// @dev Decodes the redemption data, sets the focus (wallet, counterparty
    ///      `cp`, redemption key) and returns the request context. Reverts on
    ///      malformed data exactly like the Bridge decode would.
    function _tv_redeemBefore(
        address owner,
        address cp,
        uint256 amountSat,
        bytes memory data
    ) internal returns (TvRedeem memory r) {
        (
            r.redeemer,
            r.pkh,
            r.utxoTxHash,
            r.utxoIndex,
            r.utxoValue,
            r.script
        ) = abi.decode(
            data,
            (address, bytes20, bytes32, uint32, uint64, bytes)
        );
        r.owner = owner;
        r.amountSat = amountSat;
        r.key = uint256(
            keccak256(abi.encodePacked(keccak256(r.script), r.pkh))
        );
        _setFocus(0, r.pkh, bytes20(0), cp, r.key);
    }

    /// @dev SP-27 precondition; call right after `snapshotBefore()`. `extra`
    ///      carries the path-specific preconditions (TBTC balance, allowance).
    function _tv_redeemPre(
        TvRedeem memory r,
        bool extra
    ) internal view returns (bool) {
        if (!extra) return false;
        if (r.redeemer == address(0)) return false;
        if (r.amountSat == 0 || r.amountSat > type(uint64).max) return false;
        (uint64 dust, , , , , , ) = bridge.redemptionParameters();
        if (r.amountSat < dust) return false;
        if (stateBefore.fw0State != uint8(TvWallets.WalletState.Live))
            return false;
        if (stateBefore.fw0MainUtxoHash == bytes32(0)) return false;
        if (
            keccak256(
                abi.encodePacked(r.utxoTxHash, r.utxoIndex, r.utxoValue)
            ) != stateBefore.fw0MainUtxoHash
        ) {
            return false;
        }
        if (stateBefore.rdRequestedAt != 0) return false;
        if (
            uint256(r.utxoValue) <
            uint256(stateBefore.fw0PendingValue) + r.amountSat
        ) return false;
        if (bank.balanceOf(r.owner) < r.amountSat) return false;
        if (!_tv_isStandardScript(r.script, r.pkh)) return false;
        try
            redemptionWatchtower.isSafeRedemption(
                r.pkh,
                r.script,
                r.owner,
                r.redeemer
            )
        returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// @dev Ghost updates of an accepted redemption request (call after
    ///      `snapshotAfter()`, before the properties).
    function _tv_redeemAfter(TvRedeem memory r) internal {
        TvEnumerableSet.add(ghosts.pendingRedemptionKeys, r.key);
        (, uint64 div, , , , , ) = bridge.redemptionParameters();
        uint64 full = div > 0 ? uint64(r.amountSat / div) : 0;
        uint64 stored = stateAfter.rdTreasuryFee;
        uint64 rebate = full > stored ? full - stored : 0;
        ghosts.fullTreasuryFee[r.key] = full;
        ghosts.rebateApplied[r.key] = rebate;
        ghosts.requesterOf[r.key] = actor;
        if (rebate > 0 && ghosts.rebateGrants.length < FIZZ_SCAN_CAP) {
            ghosts.rebateGrants.push(
                RebateGrant({
                    staker: r.redeemer,
                    timestamp: uint32(block.timestamp),
                    rebate: rebate,
                    live: true
                })
            );
        }
        // SP-40: a zero-rebate request sharing the second with a live grant is the aliasing case too.
        ghosts.sameBlockSecondRebate =
            _tv_sameBlockRebate() || (rebate == 0 && _tv_liveGrantAtNow());
    }

    /// @dev Properties common to every accepted redemption request.
    function _tv_redeemProps() internal {
        property_redemptionRequestPostconditions();
        property_redemptionRequestPayable();
        property_redemptionRequestNeverBlocked();
        property_redemptionEscrowCoversPending();
        property_pendingRedemptionsValueSync();
        property_vetoEscrowCoversWithdrawable();
        property_rebateAppliedWithinPreview();
        property_rebateWindowNoHistoryLoss();
        property_rebateBudgetNotRecyclable();
        property_rebateHistoryAppendOnly();
        property_poolLiquidityCoversLiabilities();
    }

    /// @dev Shadow refresh after the redemption properties.
    function _tv_redeemRefresh(TvRedeem memory r) internal {
        _tv_refreshRebateShadow(r.redeemer);
    }

    /// @dev A redemption request reverted: SP-27 decides whether it was
    ///      allowed to, then the handler reverts like the unwrapped call would
    ///      (so the harness never records a redemption the Bridge rejected).
    function _tv_redeemBlocked(TvRedeem memory r) internal {
        _tv_setOp(TvKind.None, r.owner, address(0), r.amountSat);
        tvOp.key = r.key;
        tvOp.pre = r.pre;
        tvOp.reverted = true;
        property_redemptionRequestNeverBlocked();
        revert("TokenVault: redemption request reverted");
    }

    function _tv_ownerBankDelta(address owner) internal view returns (int256) {
        if (owner == actor)
            return _tv_d(stateBefore.actorBank, stateAfter.actorBank);
        if (owner == address(tbtcVault))
            return _tv_d(stateBefore.bankTbtcVault, stateAfter.bankTbtcVault);
        return _tv_d(stateBefore.cpBank, stateAfter.cpBank);
    }

    // ── TokenVault specific properties ──

    /// @notice SP-01: TBTCVault.mint(x) converts with floor: caller Bank -floor(x/1e10), TBTCVault Bank +same, caller TBTC and supply +floor(x/1e10)*1e10 (x < 1e10: no change)
    function property_mintExact() internal {
        uint256 sat = ghosts.lastFuzzedAmount / SATOSHI_MULTIPLIER;
        int256 wei_ = int256(sat * SATOSHI_MULTIPLIER);
        eq(
            _tv_d(stateBefore.actorBank, stateAfter.actorBank),
            -int256(sat),
            "SP-01: actor Bank delta != -floor(x/1e10)"
        );
        eq(
            _tv_d(stateBefore.bankTbtcVault, stateAfter.bankTbtcVault),
            int256(sat),
            "SP-01: TBTCVault Bank delta != +floor(x/1e10)"
        );
        eq(
            _tv_d(stateBefore.actorTbtc, stateAfter.actorTbtc),
            wei_,
            "SP-01: actor TBTC delta != +floor(x/1e10)*1e10"
        );
        eq(
            _tv_d(stateBefore.tbtcSupply, stateAfter.tbtcSupply),
            wei_,
            "SP-01: TBTC supply delta != +floor(x/1e10)*1e10"
        );
    }

    /// @notice SP-02: TBTCVault.unmint(x) burns floor(x/1e10)*1e10 TBTC and returns floor(x/1e10) Bank balance (x < 1e10: no change)
    function property_unmintExact() internal {
        uint256 sat = ghosts.lastFuzzedAmount / SATOSHI_MULTIPLIER;
        int256 wei_ = int256(sat * SATOSHI_MULTIPLIER);
        eq(
            _tv_d(stateBefore.actorTbtc, stateAfter.actorTbtc),
            -wei_,
            "SP-02: actor TBTC delta != -floor(x/1e10)*1e10"
        );
        eq(
            _tv_d(stateBefore.tbtcSupply, stateAfter.tbtcSupply),
            -wei_,
            "SP-02: TBTC supply delta != -floor(x/1e10)*1e10"
        );
        eq(
            _tv_d(stateBefore.actorBank, stateAfter.actorBank),
            int256(sat),
            "SP-02: actor Bank delta != +floor(x/1e10)"
        );
        eq(
            _tv_d(stateBefore.bankTbtcVault, stateAfter.bankTbtcVault),
            -int256(sat),
            "SP-02: TBTCVault Bank delta != -floor(x/1e10)"
        );
    }

    /// @notice SP-03: TBTCVault.unmintAndRedeem(x): caller TBTC and supply -floor(x/1e10)*1e10, TBTCVault Bank -floor(x/1e10), Bridge Bank +same, pending request amount == floor(x/1e10)
    function property_unmintAndRedeemExact() internal {
        uint256 sat = ghosts.lastFuzzedAmount / SATOSHI_MULTIPLIER;
        int256 wei_ = int256(sat * SATOSHI_MULTIPLIER);
        eq(
            _tv_d(stateBefore.actorTbtc, stateAfter.actorTbtc),
            -wei_,
            "SP-03: actor TBTC delta != -floor(x/1e10)*1e10"
        );
        eq(
            _tv_d(stateBefore.tbtcSupply, stateAfter.tbtcSupply),
            -wei_,
            "SP-03: TBTC supply delta != -floor(x/1e10)*1e10"
        );
        eq(
            _tv_d(stateBefore.bankTbtcVault, stateAfter.bankTbtcVault),
            -int256(sat),
            "SP-03: TBTCVault Bank delta != -floor(x/1e10)"
        );
        eq(
            _tv_d(stateBefore.bankBridge, stateAfter.bankBridge),
            int256(sat),
            "SP-03: Bridge Bank delta != +floor(x/1e10)"
        );
        eq(
            uint256(stateAfter.rdRequestedAmount),
            sat,
            "SP-03: pending request amount != floor(x/1e10)"
        );
    }

    /// @notice SP-04: N cycles of mint(x) then unmint(x) leave actor TBTC/Bank, TBTC supply and TBTCVault Bank unchanged
    function property_mintUnmintRoundTripNoProfit() internal {
        eq(
            stateAfter.actorTbtc,
            stateBefore.actorTbtc,
            "SP-04: mint/unmint cycle changed the actor TBTC"
        );
        eq(
            stateAfter.actorBank,
            stateBefore.actorBank,
            "SP-04: mint/unmint cycle changed the actor Bank balance"
        );
        eq(
            stateAfter.tbtcSupply,
            stateBefore.tbtcSupply,
            "SP-04: mint/unmint cycle changed the TBTC supply"
        );
        eq(
            stateAfter.bankTbtcVault,
            stateBefore.bankTbtcVault,
            "SP-04: mint/unmint cycle changed the TBTCVault Bank balance"
        );
    }

    /// @notice SP-05: Bank.approveBalanceAndCall(tbtcVault, sat) then TBTC.approveAndCall(tbtcVault, sat*1e10) round trip is exact (the mint leg is asserted inside the handler)
    function property_approveCallRoundTrip() internal {
        eq(
            stateAfter.actorTbtc,
            stateBefore.actorTbtc,
            "SP-05: approveAndCall round trip changed the actor TBTC"
        );
        eq(
            stateAfter.actorBank,
            stateBefore.actorBank,
            "SP-05: approveAndCall round trip changed the actor Bank balance"
        );
        eq(
            stateAfter.tbtcSupply,
            stateBefore.tbtcSupply,
            "SP-05: approveAndCall round trip changed the TBTC supply"
        );
        eq(
            stateAfter.bankTbtcVault,
            stateBefore.bankTbtcVault,
            "SP-05: approveAndCall round trip changed the TBTCVault Bank balance"
        );
    }

    /// @notice SP-06: dust/zero mint+unmint change nothing; unmintAndRedeem of a dust amount is rejected (asserted in the handler) and changes nothing
    function property_zeroAndDustSafe() internal {
        eq(
            stateAfter.actorTbtc,
            stateBefore.actorTbtc,
            "SP-06: dust operations changed the actor TBTC"
        );
        eq(
            stateAfter.actorBank,
            stateBefore.actorBank,
            "SP-06: dust operations changed the actor Bank balance"
        );
        eq(
            stateAfter.tbtcSupply,
            stateBefore.tbtcSupply,
            "SP-06: dust operations changed the TBTC supply"
        );
    }

    /// @notice SP-07: no operation increases the total actor value sum(tbtc/1e10 + bank); the acting actor's own value never grows except through allowance pulls
    function property_noValueCreationByActor() internal {
        TvKind k = tvOp.kind;
        // TBTC remainders (< 1e10 wei) of different actors merge into whole
        // satoshi when moved between actors: at most n - 1 satoshi per call.
        uint256 tol =
            (k == TvKind.TbtcTransfer || k == TvKind.TbtcTransferFrom)
                ? actors.length - 1
                : 0;
        lte(
            stateAfter.actorValueSumSat,
            stateBefore.actorValueSumSat + tol,
            "SP-07: total actor value grew"
        );
        if (k != TvKind.BankTransferFrom && k != TvKind.TbtcTransferFrom) {
            lte(
                stateAfter.actorTbtc / SATOSHI_MULTIPLIER +
                    stateAfter.actorBank,
                stateBefore.actorTbtc / SATOSHI_MULTIPLIER +
                    stateBefore.actorBank,
                "SP-07: acting actor value grew"
            );
        }
    }

    /// @notice SP-08: another actor's TBTC/Bank balance only decreases within the allowance it granted the acting actor
    function property_noUnauthorizedBalanceChange() internal {
        address c = stateAfter.cp;
        if (c == address(0) || c == actor) return;
        uint256 allowed = stateBefore.focusAllowance;
        if (stateBefore.cpTbtc > stateAfter.cpTbtc) {
            lte(
                stateBefore.cpTbtc - stateAfter.cpTbtc,
                allowed,
                "SP-08: other actor TBTC fell beyond its allowance"
            );
        }
        if (stateBefore.cpBank > stateAfter.cpBank) {
            lte(
                stateBefore.cpBank - stateAfter.cpBank,
                allowed,
                "SP-08: other actor Bank balance fell beyond its allowance"
            );
        }
    }

    /// @notice SP-09: Bank transfers move exactly x (self-transfer unchanged), tracked total conserved, allowance spent == x unless max; allowance ops change only the allowance entry
    function property_bankTransferExact() internal {
        TvKind k = tvOp.kind;
        uint256 amt = tvOp.amount;
        address c = stateAfter.cp;
        if (
            k == TvKind.BankApprove ||
            k == TvKind.BankIncrease ||
            k == TvKind.BankDecrease
        ) {
            eq(
                stateAfter.actorBank,
                stateBefore.actorBank,
                "SP-09: allowance op changed the actor Bank balance"
            );
            if (c != address(0)) {
                eq(
                    stateAfter.cpBank,
                    stateBefore.cpBank,
                    "SP-09: allowance op changed the spender Bank balance"
                );
            }
            eq(
                stateAfter.bankTracked,
                stateBefore.bankTracked,
                "SP-09: allowance op changed the tracked Bank total"
            );
            uint256 a0 = stateBefore.focusAllowance;
            uint256 a1 = stateAfter.focusAllowance;
            if (k == TvKind.BankApprove) {
                eq(a1, amt, "SP-09: approveBalance did not set the allowance");
            } else if (k == TvKind.BankIncrease) {
                eq(
                    a1,
                    a0 + amt,
                    "SP-09: increaseBalanceAllowance wrong result"
                );
            } else {
                eq(
                    a1,
                    a0 - amt,
                    "SP-09: decreaseBalanceAllowance wrong result"
                );
            }
            return;
        }
        eq(
            _tv_d(stateBefore.actorBank, stateAfter.actorBank),
            _tv_deltaFor(actor),
            "SP-09: actor Bank delta wrong"
        );
        if (c != address(0) && c != actor) {
            eq(
                _tv_d(stateBefore.cpBank, stateAfter.cpBank),
                _tv_deltaFor(c),
                "SP-09: counterparty Bank delta wrong"
            );
        }
        int256 tracked;
        if (_tv_isHolder(tvOp.recipient)) tracked += int256(amt);
        if (_tv_isHolder(tvOp.owner)) tracked -= int256(amt);
        eq(
            _tv_d(stateBefore.bankTracked, stateAfter.bankTracked),
            tracked,
            "SP-09: tracked Bank total not conserved"
        );
        if (k == TvKind.BankTransferFrom) {
            _tv_checkAllowanceSpent(
                amt,
                "SP-09: transferBalanceFrom did not spend exactly x of the allowance"
            );
        }
    }

    /// @notice SP-10: tbtc.transfer/transferFrom: sender -x, receiver +x, supply unchanged, allowance spent == x unless max
    function property_tbtcTransferExact() internal {
        TvKind k = tvOp.kind;
        address c = stateAfter.cp;
        eq(
            stateAfter.tbtcSupply,
            stateBefore.tbtcSupply,
            "SP-10: transfer changed the TBTC supply"
        );
        eq(
            _tv_d(stateBefore.actorTbtc, stateAfter.actorTbtc),
            _tv_deltaFor(actor),
            "SP-10: actor TBTC delta wrong"
        );
        if (c != address(0) && c != actor) {
            eq(
                _tv_d(stateBefore.cpTbtc, stateAfter.cpTbtc),
                _tv_deltaFor(c),
                "SP-10: counterparty TBTC delta wrong"
            );
        }
        if (k == TvKind.TbtcTransferFrom) {
            _tv_checkAllowanceSpent(
                tvOp.amount,
                "SP-10: transferFrom did not spend exactly x of the allowance"
            );
        }
    }

    /// @notice SP-11: direct tbtc.burn/burnFrom lowers supply and the target balance by exactly x, releases no Bank balance, ghosts.tbtcBurnedDirectWei += x
    function property_tbtcBurnNoBankRelease() internal {
        TvKind k = tvOp.kind;
        uint256 amt = tvOp.amount;
        address target = k == TvKind.TbtcBurn ? actor : tvOp.owner;
        eq(
            _tv_d(stateBefore.tbtcSupply, stateAfter.tbtcSupply),
            -int256(amt),
            "SP-11: supply delta != -x"
        );
        if (target == actor) {
            eq(
                _tv_d(stateBefore.actorTbtc, stateAfter.actorTbtc),
                -int256(amt),
                "SP-11: actor TBTC delta != -x"
            );
        } else {
            eq(
                _tv_d(stateBefore.cpTbtc, stateAfter.cpTbtc),
                -int256(amt),
                "SP-11: burn target TBTC delta != -x"
            );
        }
        eq(
            stateAfter.bankTbtcVault,
            stateBefore.bankTbtcVault,
            "SP-11: burn released TBTCVault Bank balance"
        );
        eq(
            stateAfter.bankTracked,
            stateBefore.bankTracked,
            "SP-11: burn changed the tracked Bank total"
        );
        eq(
            ghosts.tbtcBurnedDirectWei,
            tvOp.aux + amt,
            "SP-11: tbtcBurnedDirectWei ghost not advanced by x"
        );
        if (k == TvKind.TbtcBurnFrom) {
            _tv_checkAllowanceSpent(
                amt,
                "SP-11: burnFrom did not spend exactly x of the allowance"
            );
        }
    }

    /// @notice SP-12: transferBalance there-and-back and increase/decreaseBalanceAllowance round trips restore balances and allowance exactly
    function property_bankTransferRoundTrip() internal {
        eq(
            stateAfter.actorBank,
            stateBefore.actorBank,
            "SP-12: round trip changed the actor Bank balance"
        );
        eq(
            stateAfter.cpBank,
            stateBefore.cpBank,
            "SP-12: round trip changed the counterparty Bank balance"
        );
        eq(
            stateAfter.bankTracked,
            stateBefore.bankTracked,
            "SP-12: round trip changed the tracked Bank total"
        );
        eq(
            stateAfter.focusAllowance,
            stateBefore.focusAllowance,
            "SP-12: round trip changed the allowance"
        );
    }

    /// @notice SP-13: finalizeOptimisticMint mints A = (amount - treasuryFee)*1e10 in total: depositor A - fee, treasury fee, debt[depositor] += A, Bank balance of TBTCVault unchanged, deposit not swept
    function property_finalizeOptimisticMintExact() internal {
        uint256 a = tvOp.amount;
        uint256 divisor = stateBefore.govFeeDivisor;
        uint256 fee = divisor > 0 ? a / divisor : 0;
        eq(
            _tv_d(stateBefore.tbtcSupply, stateAfter.tbtcSupply),
            int256(a),
            "SP-13: supply delta != A"
        );
        // SP-13: the fee is minted to the CURRENT Bridge treasury, which governance can retarget to the depositor.
        address bt = bridge.treasury();
        if (stateAfter.cp == bt) {
            eq(
                _tv_d(stateBefore.cpTbtc, stateAfter.cpTbtc),
                int256(a),
                "SP-13: depositor==bridge treasury TBTC delta != A"
            );
        } else {
            eq(
                _tv_d(stateBefore.cpTbtc, stateAfter.cpTbtc),
                int256(a - fee),
                "SP-13: depositor TBTC delta != A - fee"
            );
            // tbtcTreasury snapshots the harness treasury address; only check it while it is also the Bridge treasury.
            if (bt == treasury) {
                eq(
                    _tv_d(stateBefore.tbtcTreasury, stateAfter.tbtcTreasury),
                    int256(fee),
                    "SP-13: treasury TBTC delta != fee"
                );
            }
        }
        eq(
            _tv_d(stateBefore.cpOptDebt, stateAfter.cpOptDebt),
            int256(a),
            "SP-13: depositor debt delta != A"
        );
        eq(
            stateAfter.bankTbtcVault,
            stateBefore.bankTbtcVault,
            "SP-13: finalize moved TBTCVault Bank balance"
        );
        eq(
            uint256(stateAfter.fdSweptAt),
            0,
            "SP-13: finalized deposit marked swept"
        );
    }

    /// @notice SP-14: optimistic request machine per tracked deposit: finalized records are frozen and finalizedAt > requestedAt (+ delay at finalization); requests only for TBTCVault-routed, non-reserved deposits; no request/finalize while paused
    function property_optimisticRequestMachine() internal {
        TvKind k = tvOp.kind;
        if (k == TvKind.OptRequest || k == TvKind.OptFinalize) {
            t(
                !stateBefore.govPaused,
                "SP-14: request/finalize succeeded while optimistic minting is paused"
            );
        }
        if (k == TvKind.OptFinalize) {
            (uint64 frq, uint64 ffin) = tbtcVault.optimisticMintingRequests(
                tvOp.key
            );
            gt(
                uint256(ffin),
                uint256(frq) + stateAfter.govDelay,
                "SP-14: finalizedAt <= requestedAt + delay"
            );
        }
        uint256 n = harnessDeposits.length;
        if (n == 0) return;
        uint256 steps = n < FIZZ_CURSOR_STEP ? n : FIZZ_CURSOR_STEP;
        for (uint256 s; s < steps; s++) {
            HarnessDeposit storage hd = harnessDeposits[(tvOptCursor + s) % n];
            if (hd.vault != address(tbtcVault)) continue;
            uint256 key = tbtcVault.calculateDepositKey(
                hd.fundingTxHash,
                hd.outputIndex
            );
            (uint64 rq, uint64 fin) = tbtcVault.optimisticMintingRequests(key);
            if (fin != 0) {
                t(
                    rq != 0 && fin > rq,
                    "SP-14: finalized request without an earlier request"
                );
            }
            if (ghosts.prevOptFinalizedAt[key] != 0) {
                eq(
                    uint256(fin),
                    uint256(ghosts.prevOptFinalizedAt[key]),
                    "SP-14: finalizedAt of a finalized request changed"
                );
                eq(
                    uint256(rq),
                    uint256(ghosts.prevOptRequestedAt[key]),
                    "SP-14: requestedAt of a finalized request changed"
                );
            }
            if (rq != 0) {
                t(
                    bridge.deposits(key).vault == address(tbtcVault),
                    "SP-14: request for a deposit not routed to TBTCVault"
                );
                t(
                    !bridge.isReservedDeposit(key),
                    "SP-14: request for a reserved deposit"
                );
            }
        }
    }

    /// @notice SP-15: optimisticMintingDebt of an actor increases only in finalizeOptimisticMint and decreases only in sweeps / acceptance proofs (any handler that does not set a TokenVault context)
    function property_optimisticDebtAttribution() internal {
        TvKind k = tvOp.kind;
        for (uint256 i; i < actors.length; i++) {
            uint256 cur = tbtcVault.optimisticMintingDebt(actors[i]);
            uint256 prev = ghosts.prevOptDebt[actors[i]];
            if (cur > prev) {
                t(
                    k == TvKind.OptFinalize,
                    "SP-15: optimistic debt increased outside finalizeOptimisticMint"
                );
            } else if (cur < prev) {
                t(
                    k == TvKind.None,
                    "SP-15: optimistic debt decreased outside a sweep / acceptance proof"
                );
            }
        }
    }

    /// @notice SP-16: TBTCVault governance: pause toggles exactly the flag, begin*Update stages (value, now) without touching the live parameter, finalize*Update only after 24h applying exactly the staged value and clearing the staging; nothing else changes the live parameters
    function property_optimisticPauseAndStaging() internal {
        TvKind k = tvOp.kind;
        State storage b = stateBefore;
        State storage a = stateAfter;
        if (k == TvKind.GovBeginFee) {
            eq(
                a.govFeeDivisor,
                b.govFeeDivisor,
                "SP-16: beginFeeUpdate changed the live fee divisor"
            );
            eq(
                a.govFeeUpdateTs,
                block.timestamp,
                "SP-16: beginFeeUpdate timestamp != now"
            );
            eq(
                a.govNewFeeDivisor,
                tvOp.amount,
                "SP-16: beginFeeUpdate staged value != argument"
            );
        } else if (k == TvKind.GovFinalizeFee) {
            neq(
                b.govFeeUpdateTs,
                0,
                "SP-16: fee update finalized without being initiated"
            );
            gte(
                block.timestamp - b.govFeeUpdateTs,
                TV_GOVERNANCE_DELAY,
                "SP-16: fee update finalized before the governance delay"
            );
            eq(
                a.govFeeDivisor,
                b.govNewFeeDivisor,
                "SP-16: finalized fee divisor != staged value"
            );
            eq(a.govFeeUpdateTs, 0, "SP-16: fee staging timestamp not cleared");
            eq(a.govNewFeeDivisor, 0, "SP-16: staged fee divisor not cleared");
        } else {
            eq(
                a.govFeeDivisor,
                b.govFeeDivisor,
                "SP-16: live fee divisor changed outside finalize"
            );
            eq(
                a.govNewFeeDivisor,
                b.govNewFeeDivisor,
                "SP-16: staged fee divisor changed outside begin/finalize"
            );
            eq(
                a.govFeeUpdateTs,
                b.govFeeUpdateTs,
                "SP-16: fee staging timestamp changed outside begin/finalize"
            );
        }
        if (k == TvKind.GovBeginDelay) {
            eq(
                a.govDelay,
                b.govDelay,
                "SP-16: beginDelayUpdate changed the live delay"
            );
            eq(
                a.govDelayUpdateTs,
                block.timestamp,
                "SP-16: beginDelayUpdate timestamp != now"
            );
            eq(
                a.govNewDelay,
                tvOp.amount,
                "SP-16: beginDelayUpdate staged value != argument"
            );
        } else if (k == TvKind.GovFinalizeDelay) {
            neq(
                b.govDelayUpdateTs,
                0,
                "SP-16: delay update finalized without being initiated"
            );
            gte(
                block.timestamp - b.govDelayUpdateTs,
                TV_GOVERNANCE_DELAY,
                "SP-16: delay update finalized before the governance delay"
            );
            eq(
                a.govDelay,
                b.govNewDelay,
                "SP-16: finalized delay != staged value"
            );
            eq(
                a.govDelayUpdateTs,
                0,
                "SP-16: delay staging timestamp not cleared"
            );
            eq(a.govNewDelay, 0, "SP-16: staged delay not cleared");
        } else {
            eq(
                a.govDelay,
                b.govDelay,
                "SP-16: live delay changed outside finalize"
            );
            eq(
                a.govNewDelay,
                b.govNewDelay,
                "SP-16: staged delay changed outside begin/finalize"
            );
            eq(
                a.govDelayUpdateTs,
                b.govDelayUpdateTs,
                "SP-16: delay staging timestamp changed outside begin/finalize"
            );
        }
        if (k == TvKind.GovPause) {
            t(a.govPaused, "SP-16: pause did not set the flag");
        } else if (k == TvKind.GovUnpause) {
            t(!a.govPaused, "SP-16: unpause did not clear the flag");
        } else {
            t(
                a.govPaused == b.govPaused,
                "SP-16: pause flag changed outside pause/unpause"
            );
        }
    }

    /// @notice SP-25: an accepted redemption request creates one pending request {amount a, now}, wallet pendingRedemptionsValue += a - fee, balance owner Bank -a, Bridge Bank +a, fullTreasuryFee ghost == a/div
    function property_redemptionRequestPostconditions() internal {
        if (tvOp.reverted) return;
        uint256 a = tvOp.amount;
        eq(
            uint256(stateBefore.rdRequestedAt),
            0,
            "SP-25: redemption key already pending before the request"
        );
        eq(
            uint256(stateAfter.rdRequestedAt),
            block.timestamp,
            "SP-25: requestedAt != now"
        );
        eq(
            uint256(stateAfter.rdRequestedAmount),
            a,
            "SP-25: requestedAmount != a"
        );
        eq(
            _tv_d(
                uint256(stateBefore.fw0PendingValue),
                uint256(stateAfter.fw0PendingValue)
            ),
            int256(a) - int256(uint256(stateAfter.rdTreasuryFee)),
            "SP-25: wallet pendingRedemptionsValue delta != a - treasuryFee"
        );
        eq(
            _tv_d(stateBefore.bankBridge, stateAfter.bankBridge),
            int256(a),
            "SP-25: Bridge Bank delta != +a"
        );
        eq(
            _tv_ownerBankDelta(tvOp.owner),
            -int256(a),
            "SP-25: balance owner Bank delta != -a"
        );
        eq(
            uint256(stateBefore.fw0State),
            uint256(uint8(TvWallets.WalletState.Live)),
            "SP-25: redemption from a non-Live wallet"
        );
        t(
            stateBefore.fw0MainUtxoHash != bytes32(0),
            "SP-25: redemption from a wallet without main UTXO"
        );
        t(
            stateAfter.fw0MainUtxoHash == stateBefore.fw0MainUtxoHash,
            "SP-25: redemption request changed the main UTXO hash"
        );
        (, uint64 div, , , , , ) = bridge.redemptionParameters();
        uint256 full = div > 0 ? a / div : 0;
        eq(
            uint256(ghosts.fullTreasuryFee[tvOp.key]),
            full,
            "SP-25: fullTreasuryFee ghost != a / divisor"
        );
        lte(
            uint256(stateAfter.rdTreasuryFee),
            full,
            "SP-25: stored treasury fee above the full fee"
        );
    }

    /// @notice SP-26: an accepted redemption request stays payable: requestedAmount > treasuryFee + txMaxFee
    function property_redemptionRequestPayable() internal {
        if (tvOp.reverted) return;
        TvRedemption.RedemptionRequest memory r = bridge.pendingRedemptions(
            tvOp.key
        );
        gt(
            uint256(r.requestedAmount),
            uint256(r.treasuryFee) + uint256(r.txMaxFee),
            "SP-26: accepted redemption request is not payable"
        );
    }

    /// @notice SP-27: a well-formed redemption request cannot be made to revert: if every precondition held before the call, a revert is a violation
    function property_redemptionRequestNeverBlocked() internal {
        if (_skipKnownFailing()) return;
        if (tvOp.reverted) {
            t(!tvOp.pre, "SP-27: well-formed redemption request reverted");
        }
    }

    // ── end TokenVault shard ──

    // ── Specific: Bridge shard (BridgeHandler) ──

    // Hook context written by BridgeHandler BEFORE / AROUND a protocol call and
    // read by the zero-parameter SP functions below (the Snapshots `State`
    // cannot carry multi-key data such as sweeps and redemption proofs).
    // Every field is (re)initialised by the handler hook that uses it.
    uint8 internal constant bridge_MK_COMMITMENT = 1;
    uint8 internal constant bridge_MK_PROOF = 2;
    uint8 internal constant bridge_MK_TIMEOUT = 3;
    uint8 internal constant bridge_MK_BELOW_DUST = 4;
    uint8 internal constant bridge_MK_CLOSEABLE = 5;
    uint8 internal constant bridge_SK_PROOF = 1;
    uint8 internal constant bridge_SK_TIMEOUT = 2;
    uint8 internal constant bridge_FK_SUBMIT = 1;
    uint8 internal constant bridge_FK_DEFEAT = 2;
    uint8 internal constant bridge_FK_TIMEOUT = 3;

    struct bridge_Range {
        uint64 out;
        uint64 redeemable;
        uint64 maxFee;
    }

    struct bridge_Hook {
        // Hook kinds.
        uint8 movingKind;
        uint8 sweepKind;
        uint8 fraudKind;
        // Probes (`try/catch` around a protocol call that must not revert).
        bool probePre;
        bool probeReverted;
        bool honestReverted;
        bool honestSettled;
        // The actor is the staker of the rebate (no delegation, direct caller).
        bool directRebate;
        // Wallet registration.
        bytes32 walletId;
        // Main UTXO consumed by the call.
        bytes32 oldMainTxHash;
        uint32 oldMainIndex;
        uint64 oldMainValue;
        // Main UTXO created by the call (change output / sweep output).
        bytes32 newMainTxHash;
        uint32 newMainIndex;
        uint64 newMainValue;
        // Deposit sweep.
        bool sweepOk;
        bool sweepViaTbtcVault;
        bool sweepTrusted;
        uint256 sweepFee;
        uint256 sumAmount;
        uint256 sumTreasuryFee;
        address bridgeTreasury;
        uint256 treasuryBankBefore;
        // Redemption proof.
        bool redOk;
        uint256 sumReq;
        uint256 sumFee;
        uint256 sumBurn;
        uint256 sumTimedOut;
        // Moving funds / moved funds sweeps.
        uint256 mfTotal;
        uint256 mfFirstIdx;
        uint256 mfCount;
        uint256 sweepKey;
        uint256 mainValue;
        uint256 seizeBefore;
        bytes32 commitBefore;
        // Fraud challenge under test.
        uint256 fraudKey;
        uint256 fraudValue;
        uint32 fraudReportedAt;
        // SP-108: the call was the permissionless resetMovingFundsTimeout.
        bool timeoutReset;
    }

    bridge_Hook internal bridge_hook;
    /// @dev Deposit keys of a sweep (input order) / pending requests proven by a redemption proof.
    uint256[] internal bridge_hookKeys;
    /// @dev Distinct depositors of a sweep with their aggregated credit (sat) and pre-call balances.
    address[] internal bridge_hookDepositors;
    uint256[] internal bridge_hookCredit;
    uint256[] internal bridge_hookDebt;
    uint256[] internal bridge_hookTbtc;
    uint256[] internal bridge_hookBank;
    bridge_Range[] internal bridge_hookRanges;
    /// @dev `pendingMovedFundsSweepRequestsCount` of `harnessWallets[i]` before the call.
    uint32[] internal bridge_hookPendSweeps;
    /// @dev Non-reserved deposit keys revealed through BridgeHandler (SP-24 scan; reserved keys live in `ghosts.reservedDepositKeys`).
    uint256[] internal bridge_revealedKeys;
    uint256 internal bridge_revealCursor;
    uint256 internal bridge_sweepCursor;

    // ―――― Views shared by several Bridge-shard properties ――――

    function bridge_stateOf(bytes20 w) internal view returns (uint8) {
        return uint8(bridge.wallets(w).state);
    }

    /// @dev Number and total anchor amount of Active / ActionPending reservations anchored at `w`
    ///      (scan of the harness reservation keys, capped at FIZZ_SCAN_CAP).
    function bridge_provenAnchors(
        bytes20 w
    ) internal view returns (uint256 count, uint256 sum) {
        uint256 n = harnessReservationKeys.length;
        if (n > FIZZ_SCAN_CAP) n = FIZZ_SCAN_CAP;
        for (uint256 i; i < n; i++) {
            PeReservation.ReservationRequest memory r = reservationRouter
                .reservations(harnessReservationKeys[i]);
            if (r.walletPubKeyHash != w) continue;
            if (
                r.state == PeReservation.ReservationState.Active ||
                r.state == PeReservation.ReservationState.ActionPending
            ) {
                count++;
                sum += r.anchorAmount;
            }
        }
    }

    function bridge_utxoKeyOf(
        bytes32 txHash,
        uint32 index
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(txHash, index)));
    }

    // ―――― Deposits ――――

    /// @notice SP-17: Outstanding optimistic minting debt of the actors is bounded by the net value of finalized-but-unswept optimistic deposits plus at most depositTxMaxFee per finalized-and-swept deposit
    function property_optimisticDebtBounded() internal {
        uint256 debt;
        for (uint256 i; i < actors.length; i++) {
            debt += tbtcVault.optimisticMintingDebt(actors[i]);
        }
        uint256 n = ghosts.omFinalizedKeys.length;
        if (n > FIZZ_SCAN_CAP) n = FIZZ_SCAN_CAP;
        (, , uint64 maxFee, ) = bridge.depositParameters();
        uint256 bound;
        for (uint256 i; i < n; i++) {
            BrDeposit.DepositRequest memory d = bridge.deposits(
                ghosts.omFinalizedKeys[i]
            );
            bound +=
                d.sweptAt != 0
                    ? uint256(maxFee) * SATOSHI_MULTIPLIER
                    : (uint256(d.amount) - d.treasuryFee) * SATOSHI_MULTIPLIER;
        }
        lte(
            debt,
            bound,
            "SP-17: optimistic debt exceeds the finalized-deposit bound"
        );
    }

    /// @notice SP-18: Reveal postconditions (marker / pending counter / no rebate for reserved reveals, revealedAt == now, sweptAt == 0, fee <= amount / divisor)
    function property_depositRevealPostconditions() internal {
        uint256 key = focus.resKey;
        if (key == 0) return;
        BrDeposit.DepositRequest memory d = bridge.deposits(key);
        eq(uint256(d.revealedAt), block.timestamp, "SP-18: revealedAt != now");
        eq(uint256(d.sweptAt), 0, "SP-18: fresh deposit already swept");
        (, uint64 divisor, , ) = bridge.depositParameters();
        uint256 original = divisor > 0 ? uint256(d.amount) / divisor : 0;
        lte(
            uint256(d.treasuryFee),
            original,
            "SP-18: treasury fee above amount / divisor"
        );
        if (bridge.isReservedDeposit(key)) {
            neq(
                uint256(uint160(stateAfter.fdMarker)),
                0,
                "SP-18: reserved reveal left no wallet marker"
            );
            eq(
                uint256(stateAfter.resPendingReserved),
                uint256(stateBefore.resPendingReserved) + 1,
                "SP-18: reserved reveal did not add exactly one pending reserved deposit"
            );
            eq(
                uint256(stateAfter.resActive),
                uint256(stateBefore.resActive),
                "SP-18: reserved reveal touched the active reservation count"
            );
            eq(
                uint256(stateAfter.resTotal),
                uint256(stateBefore.resTotal),
                "SP-18: reserved reveal touched the reserved total amount"
            );
            eq(
                stateAfter.rebateLen,
                stateBefore.rebateLen,
                "SP-18: reserved reveal consumed rebate budget"
            );
        } else {
            eq(
                uint256(stateAfter.resPendingReserved),
                uint256(stateBefore.resPendingReserved),
                "SP-18: pooled reveal changed pending reserved deposits"
            );
        }
    }

    /// @notice SP-19: Deposit treasury fee rounds down: fee == amount / divisor without rebate (always for reserved deposits), fee <= amount / divisor with a rebate
    function property_depositTreasuryFeeFloor() internal {
        uint256 key = focus.resKey;
        if (key == 0) return;
        BrDeposit.DepositRequest memory d = bridge.deposits(key);
        (, uint64 divisor, , ) = bridge.depositParameters();
        uint256 original = divisor > 0 ? uint256(d.amount) / divisor : 0;
        lte(
            uint256(d.treasuryFee),
            original,
            "SP-19: treasury fee above amount / divisor"
        );
        bool delegated = rebateStaking.delegates(actor) != address(0);
        bool noRebate =
            stateAfter.rebateLen == stateBefore.rebateLen && !delegated;
        if (bridge.isReservedDeposit(key) || noRebate) {
            eq(
                uint256(d.treasuryFee),
                original,
                "SP-19: treasury fee != amount / divisor without rebate"
            );
        }
        if (divisor > 0) {
            lte(
                original * divisor,
                uint256(d.amount),
                "SP-19: fee * divisor > amount"
            );
            lt(
                uint256(d.amount),
                (original + 1) * divisor,
                "SP-19: amount >= (fee + 1) * divisor"
            );
        }
    }

    /// @notice SP-20: Everything the Bank credits in a sweep (depositors or vault + treasury) equals the net Bitcoin added to the wallet main UTXO; treasury credit equals the sum of the deposits' treasury fees; sweep fee <= n * depositTxMaxFee
    function property_sweepBankCreditEqualsBtcDelta() internal {
        bridge_Hook storage h = bridge_hook;
        if (!h.sweepOk) return;
        eq(
            stateAfter.bankTracked + h.oldMainValue,
            stateBefore.bankTracked + h.newMainValue,
            "SP-20: tracked Bank credit != BTC delta of the main UTXO"
        );
        uint256 treasuryAfter = bank.balanceOf(h.bridgeTreasury);
        bool treasuryIsDepositor;
        for (uint256 i; i < bridge_hookDepositors.length; i++) {
            if (bridge_hookDepositors[i] == h.bridgeTreasury)
                treasuryIsDepositor = true;
        }
        if (treasuryIsDepositor) {
            gte(
                treasuryAfter,
                h.treasuryBankBefore + h.sumTreasuryFee,
                "SP-20: treasury credit below the sum of treasury fees"
            );
        } else {
            eq(
                treasuryAfter,
                h.treasuryBankBefore + h.sumTreasuryFee,
                "SP-20: treasury credit != sum of treasury fees"
            );
        }
        (, , uint64 maxFee, ) = bridge.depositParameters();
        lte(
            h.sweepFee,
            bridge_hookKeys.length * uint256(maxFee),
            "SP-20: sweep fee above n * depositTxMaxFee"
        );
        eq(
            h.sumAmount + h.oldMainValue,
            h.sweepFee + h.newMainValue,
            "SP-20: inputs != output + fee"
        );
    }

    /// @notice SP-21: Sweep fee distribution is exact (floor(F/n) per deposit, remainder on the last, shares sum to F, last share <= depositTxMaxFee, credits non-negative)
    function property_sweepFeeDistribution() internal {
        bridge_Hook storage h = bridge_hook;
        if (!h.sweepOk) return;
        uint256 n = bridge_hookKeys.length;
        if (n == 0) return;
        uint256 base = h.sweepFee / n;
        uint256 rem = h.sweepFee % n;
        eq(
            base * (n - 1) + base + rem,
            h.sweepFee,
            "SP-21: fee shares do not sum to the sweep fee"
        );
        lt(rem, n, "SP-21: remainder >= n");
        (, , uint64 maxFee, ) = bridge.depositParameters();
        lte(
            base + rem,
            uint256(maxFee),
            "SP-21: last deposit fee share above depositTxMaxFee"
        );
        for (uint256 i; i < n; i++) {
            BrDeposit.DepositRequest memory d = bridge.deposits(
                bridge_hookKeys[i]
            );
            gte(
                uint256(d.amount) - d.treasuryFee,
                i == n - 1 ? base + rem : base,
                "SP-21: fee share exceeds the net deposit amount"
            );
        }
    }

    /// @notice SP-22: A pooled sweep routed to TBTCVault conserves the peg: debt falls by min(debt, c*1e10), depositors receive c*1e10 minus the repaid debt, Bank(tbtcVault) and TBTC supply move accordingly
    function property_sweepTbtcVaultMintAndDebt() internal {
        bridge_Hook storage h = bridge_hook;
        if (!h.sweepOk || !h.sweepViaTbtcVault) return;
        uint256 sumSat;
        uint256 sumRepaid;
        for (uint256 i; i < bridge_hookDepositors.length; i++) {
            address dep = bridge_hookDepositors[i];
            uint256 credit = bridge_hookCredit[i] * SATOSHI_MULTIPLIER;
            uint256 debtBefore = bridge_hookDebt[i];
            uint256 repaid = credit < debtBefore ? credit : debtBefore;
            eq(
                tbtcVault.optimisticMintingDebt(dep),
                debtBefore - repaid,
                "SP-22: debt != max(0, debt - credit)"
            );
            eq(
                tbtc.balanceOf(dep),
                bridge_hookTbtc[i] + credit - repaid,
                "SP-22: minted TBTC != credit - repaid debt"
            );
            sumSat += bridge_hookCredit[i];
            sumRepaid += repaid;
        }
        eq(
            stateAfter.bankTbtcVault,
            stateBefore.bankTbtcVault + sumSat,
            "SP-22: Bank(tbtcVault) != + sum(credit)"
        );
        eq(
            stateAfter.tbtcSupply,
            stateBefore.tbtcSupply + sumSat * SATOSHI_MULTIPLIER - sumRepaid,
            "SP-22: TBTC supply != + sum(credit)*1e10 - repaid debt"
        );
    }

    /// @notice SP-23: Sweep postconditions (sweptAt == now, never reserved, new main UTXO hash, old main UTXO spent, wallet state / pending value / live count / active wallet unchanged, depositors not credited individually behind a trusted vault)
    function property_sweepPostconditions() internal {
        bridge_Hook storage h = bridge_hook;
        if (!h.sweepOk) return;
        for (uint256 i; i < bridge_hookKeys.length; i++) {
            BrDeposit.DepositRequest memory d = bridge.deposits(
                bridge_hookKeys[i]
            );
            eq(
                uint256(d.sweptAt),
                block.timestamp,
                "SP-23: swept deposit sweptAt != now"
            );
            t(
                !bridge.isReservedDeposit(bridge_hookKeys[i]),
                "SP-23: a reserved deposit was swept"
            );
        }
        BrWallets.Wallet memory wal = bridge.wallets(focus.wallet0);
        eq(
            uint256(wal.mainUtxoHash),
            uint256(
                keccak256(
                    abi.encodePacked(h.newMainTxHash, uint32(0), h.newMainValue)
                )
            ),
            "SP-23: main UTXO hash != sweep output"
        );
        if (h.oldMainTxHash != bytes32(0)) {
            t(
                bridge.spentMainUTXOs(
                    bridge_utxoKeyOf(h.oldMainTxHash, h.oldMainIndex)
                ),
                "SP-23: previous main UTXO not marked spent"
            );
        }
        eq(
            uint256(stateAfter.fw0State),
            uint256(stateBefore.fw0State),
            "SP-23: sweep changed the wallet state"
        );
        eq(
            uint256(stateAfter.fw0PendingValue),
            uint256(stateBefore.fw0PendingValue),
            "SP-23: sweep changed the pending redemptions value"
        );
        eq(
            uint256(stateAfter.liveWallets),
            uint256(stateBefore.liveWallets),
            "SP-23: sweep changed the live wallets count"
        );
        t(
            stateAfter.activeWallet == stateBefore.activeWallet,
            "SP-23: sweep changed the active wallet"
        );
        for (uint256 i; i < bridge_hookDepositors.length; i++) {
            address dep = bridge_hookDepositors[i];
            uint256 expected = bridge_hookBank[i];
            if (!h.sweepTrusted) expected += bridge_hookCredit[i];
            if (dep == h.bridgeTreasury) expected += h.sumTreasuryFee;
            eq(
                bank.balanceOf(dep),
                expected,
                "SP-23: depositor Bank balance routing mismatch"
            );
        }
    }

    /// @notice SP-24: Deposit records are write-once (image hash taken at reveal never changes, sweptAt frozen once set); cursor scan of FIZZ_CURSOR_STEP keys per call
    function property_depositRecordWriteOnce() internal {
        if (focus.resKey != 0) _bridge_checkDepositRecord(focus.resKey);
        uint256 a = bridge_revealedKeys.length;
        uint256 total = a + ghosts.reservedDepositKeys.length;
        if (total == 0) return;
        uint256 steps = total < FIZZ_CURSOR_STEP ? total : FIZZ_CURSOR_STEP;
        uint256 cursor = bridge_revealCursor % total;
        for (uint256 i; i < steps; i++) {
            uint256 idx = (cursor + i) % total;
            _bridge_checkDepositRecord(
                idx < a
                    ? bridge_revealedKeys[idx]
                    : ghosts.reservedDepositKeys[idx - a]
            );
        }
        bridge_revealCursor = (cursor + steps) % total;
    }

    function _bridge_checkDepositRecord(uint256 key) private {
        bytes32 image = ghosts.depositImageHash[key];
        if (image == bytes32(0)) return;
        BrDeposit.DepositRequest memory d = bridge.deposits(key);
        bytes32 now_ = keccak256(
            abi.encode(
                d.depositor,
                d.amount,
                d.revealedAt,
                d.vault,
                d.treasuryFee,
                d.extraData,
                bridge.isReservedDeposit(key)
            )
        );
        t(now_ == image, "SP-24: deposit record changed after reveal");
        uint32 swept = ghosts.depositSweptAt[key];
        if (swept != 0)
            eq(
                uint256(d.sweptAt),
                uint256(swept),
                "SP-24: sweptAt changed once set"
            );
    }

    // ―――― Redemptions ――――

    /// @notice SP-28: A redemption proof burns exactly sum(requested - fee) of the proven pending requests, moves sum(fee) to the treasury (Bridge Bank -sum(requested)), deletes the proven requests, reduces pendingRedemptionsValue by the burned sum, sets the change output as the new main UTXO (or deletes it) and marks the old main UTXO spent
    function property_redemptionProofAccounting() internal {
        bridge_Hook storage h = bridge_hook;
        if (!h.redOk) return;
        eq(
            stateBefore.bankBridge,
            stateAfter.bankBridge + h.sumReq,
            "SP-28: Bridge Bank balance fell by != sum(requested)"
        );
        if (h.bridgeTreasury == treasury) {
            eq(
                stateAfter.bankTreasury,
                stateBefore.bankTreasury + h.sumFee,
                "SP-28: treasury credit != sum(treasury fees)"
            );
        }
        eq(
            stateBefore.bankTracked,
            stateAfter.bankTracked + h.sumBurn,
            "SP-28: tracked Bank fell by != sum(requested - fee)"
        );
        eq(
            uint256(stateBefore.fw0PendingValue),
            uint256(stateAfter.fw0PendingValue) + h.sumBurn,
            "SP-28: pendingRedemptionsValue fell by != sum(requested - fee)"
        );
        for (uint256 i; i < bridge_hookKeys.length; i++) {
            eq(
                uint256(
                    bridge.pendingRedemptions(bridge_hookKeys[i]).requestedAt
                ),
                0,
                "SP-28: proven request still pending"
            );
            bridge_Range storage r = bridge_hookRanges[i];
            gte(
                uint256(r.out),
                uint256(r.redeemable) - r.maxFee,
                "SP-28: output below redeemable - txMaxFee"
            );
            lte(
                uint256(r.out),
                uint256(r.redeemable),
                "SP-28: output above redeemable amount"
            );
        }
        BrWallets.Wallet memory wal = bridge.wallets(focus.wallet0);
        bytes32 expected =
            h.newMainValue > 0
                ? keccak256(
                    abi.encodePacked(
                        h.newMainTxHash,
                        h.newMainIndex,
                        h.newMainValue
                    )
                )
                : bytes32(0);
        t(wal.mainUtxoHash == expected, "SP-28: main UTXO != change output");
        t(
            bridge.spentMainUTXOs(
                bridge_utxoKeyOf(h.oldMainTxHash, h.oldMainIndex)
            ),
            "SP-28: previous main UTXO not marked spent"
        );
        eq(
            uint256(stateAfter.fw0State),
            uint256(stateBefore.fw0State),
            "SP-28: redemption proof changed the wallet state"
        );
    }

    /// @notice SP-29: Wallet-side shortfall of a redemption proof is bounded: (oldMain - change) - totalBurnable <= redemptionTxMaxTotalFee
    function property_redemptionWalletShortfallBounded() internal {
        bridge_Hook storage h = bridge_hook;
        if (!h.redOk) return;
        (, , , uint64 maxTotal, , , ) = bridge.redemptionParameters();
        // Outputs paying already timed-out requests leave the wallet without a Bank burn (the redeemer was refunded at the timeout).
        lte(
            uint256(h.oldMainValue),
            uint256(h.newMainValue) +
                h.sumTimedOut +
                (stateBefore.bankTracked - stateAfter.bankTracked) +
                maxTotal,
            "SP-29: wallet shortfall above redemptionTxMaxTotalFee"
        );
    }

    /// @notice SP-30: A redemption timeout moves the request unchanged to timedOutRedemptions, refunds exactly requestedAmount to the redeemer, reduces pendingRedemptionsValue by requested - fee and moves a Live wallet to MovingFunds / Closing
    function property_redemptionTimeoutRefund() internal {
        uint256 key = focus.redemptionKey;
        if (key == 0 || stateBefore.rdRequestedAt == 0) return;
        bytes20 w = focus.wallet0;
        uint256 requested = stateBefore.rdRequestedAmount;
        uint256 fee = stateBefore.rdTreasuryFee;
        eq(
            stateAfter.cpBank,
            stateBefore.cpBank + requested,
            "SP-30: redeemer not refunded requestedAmount"
        );
        eq(
            stateBefore.bankBridge,
            stateAfter.bankBridge + requested,
            "SP-30: Bridge Bank balance fell by != requestedAmount"
        );
        eq(
            uint256(stateBefore.fw0PendingValue),
            uint256(stateAfter.fw0PendingValue) + requested - fee,
            "SP-30: pendingRedemptionsValue fell by != requested - fee"
        );
        eq(
            uint256(stateAfter.rdRequestedAt),
            0,
            "SP-30: timed-out key still pending"
        );
        BrRedemption.RedemptionRequest memory timedOut = bridge
            .timedOutRedemptions(key);
        eq(
            uint256(timedOut.requestedAt),
            uint256(stateBefore.rdRequestedAt),
            "SP-30: timedOut requestedAt differs from the pending request"
        );
        eq(
            uint256(timedOut.requestedAmount),
            requested,
            "SP-30: timedOut requestedAmount differs"
        );
        eq(
            uint256(timedOut.treasuryFee),
            fee,
            "SP-30: timedOut treasuryFee differs"
        );
        if (stateBefore.fw0State == 1) {
            t(
                stateAfter.fw0State != 1,
                "SP-30: wallet still Live after a redemption timeout"
            );
            eq(
                uint256(stateAfter.liveWallets) + 1,
                uint256(stateBefore.liveWallets),
                "SP-30: live wallets count not decremented"
            );
            // R-13: routing counts proven anchors (unchanged by the call), not pending capacity.
            (uint256 anchoredCount, ) = bridge_provenAnchors(w);
            bool idle =
                stateBefore.fw0MainUtxoHash == bytes32(0) && anchoredCount == 0;
            eq(
                uint256(stateAfter.fw0State),
                idle ? 3 : 2,
                "SP-30: wallet routed to the wrong state"
            );
            if (stateBefore.activeWallet == w) {
                t(
                    stateAfter.activeWallet == bytes20(0),
                    "SP-30: active wallet slot not cleared"
                );
            }
        } else {
            eq(
                uint256(stateAfter.fw0State),
                uint256(stateBefore.fw0State),
                "SP-30: non-Live wallet changed state"
            );
            eq(
                uint256(stateAfter.liveWallets),
                uint256(stateBefore.liveWallets),
                "SP-30: non-Live timeout changed the live wallets count"
            );
        }
    }

    /// @notice SP-31: An elapsed pending redemption request on a Live / MovingFunds / Terminated wallet must remain reportable (probe set by the handler: precondition holds and notifyRedemptionTimeout reverted)
    function property_redemptionTimeoutNeverBlocked() internal {
        t(
            !(bridge_hook.probePre && bridge_hook.probeReverted),
            "SP-31: notifyRedemptionTimeout reverted although the timeout elapsed"
        );
    }

    /// @notice SP-35: Bridge Bank balance == sum of requestedAmount over all pending redemptions + Bank balance donated to the Bridge
    function property_redemptionEscrowCoversPending() internal {
        uint256 n = BrEnumerableSet.length(ghosts.pendingRedemptionKeys);
        uint256 sum;
        for (uint256 i; i < n; i++) {
            sum += bridge
                .pendingRedemptions(
                    BrEnumerableSet.at(ghosts.pendingRedemptionKeys, i)
                )
                .requestedAmount;
        }
        eq(
            bank.balanceOf(address(bridge)),
            sum + ghosts.bankDonatedToBridgeSat,
            "SP-35: Bridge Bank balance != pending requests + donations"
        );
    }

    struct bridge_PendView {
        uint256[] keys;
        uint256[] vals;
        bool[] placed;
        uint256 m;
        uint256 total;
    }

    /// @notice SP-36: For each wallet pendingRedemptionsValue == sum(requestedAmount - treasuryFee) of its pending requests; a key is never pending and timed out; a timed-out key belongs to a wallet that is not Live / Unknown
    function property_pendingRedemptionsValueSync() internal {
        bridge_PendView memory pv = _bridge_pendingView();
        uint256 nw = harnessWallets.length;
        uint256 sumWallets;
        for (uint256 i; i < nw; i++) {
            sumWallets += bridge
                .wallets(harnessWallets[i])
                .pendingRedemptionsValue;
        }
        eq(
            sumWallets,
            pv.total,
            "SP-36: sum of wallet pending values != sum of pending requests"
        );
        uint256[] memory perWallet = new uint256[](nw);
        uint256 placed = _bridge_placePending(pv, perWallet);
        if (placed != pv.m) return;
        for (uint256 i; i < nw; i++) {
            eq(
                uint256(
                    bridge.wallets(harnessWallets[i]).pendingRedemptionsValue
                ),
                perWallet[i],
                "SP-36: wallet pendingRedemptionsValue != its pending requests"
            );
        }
    }

    function _bridge_pendingView() private returns (bridge_PendView memory pv) {
        uint256 n = BrEnumerableSet.length(ghosts.pendingRedemptionKeys);
        pv.keys = new uint256[](n);
        pv.vals = new uint256[](n);
        pv.placed = new bool[](n);
        for (uint256 i; i < n; i++) {
            uint256 k = BrEnumerableSet.at(ghosts.pendingRedemptionKeys, i);
            BrRedemption.RedemptionRequest memory r = bridge.pendingRedemptions(
                k
            );
            if (r.requestedAt == 0) continue;
            lte(
                uint256(r.treasuryFee),
                uint256(r.requestedAmount),
                "SP-36: treasuryFee > requestedAmount"
            );
            pv.keys[pv.m] = k;
            pv.vals[pv.m] = uint256(r.requestedAmount) - r.treasuryFee;
            pv.total += pv.vals[pv.m];
            pv.m++;
        }
    }

    /// @dev Attributes the tracked pending keys to wallets through the last FIZZ_SCAN_CAP harness redemptions; also checks the timed-out invariants of the scanned entries.
    function _bridge_placePending(
        bridge_PendView memory pv,
        uint256[] memory perWallet
    ) private returns (uint256 placedCount) {
        uint256 total = harnessRedemptions.length;
        uint256 from = total > FIZZ_SCAN_CAP ? total - FIZZ_SCAN_CAP : 0;
        for (uint256 e = total; e > from; e--) {
            HarnessRedemption storage hr = harnessRedemptions[e - 1];
            uint256 key = uint256(
                keccak256(
                    abi.encodePacked(
                        keccak256(hr.redeemerOutputScript),
                        hr.walletPkh
                    )
                )
            );
            if (bridge.timedOutRedemptions(key).requestedAt != 0) {
                uint8 st = bridge_stateOf(hr.walletPkh);
                t(
                    st != 0 && st != 1,
                    "SP-36: timed-out request on a Unknown / Live wallet"
                );
                t(
                    bridge.pendingRedemptions(key).requestedAt == 0,
                    "SP-36: key both pending and timed out"
                );
            }
            uint256 wi = type(uint256).max;
            for (uint256 j; j < harnessWallets.length; j++) {
                if (harnessWallets[j] == hr.walletPkh) {
                    wi = j;
                    break;
                }
            }
            if (wi == type(uint256).max) continue;
            for (uint256 j; j < pv.m; j++) {
                if (pv.keys[j] == key && !pv.placed[j]) {
                    pv.placed[j] = true;
                    perWallet[wi] += pv.vals[j];
                    placedCount++;
                    break;
                }
            }
        }
    }

    /// @notice SP-37: The RedemptionWatchtower's Bank balance == sum of withdrawableAmount over the finalized veto proposals + Bank balance donated to it
    function property_vetoEscrowCoversWithdrawable() internal {
        uint256 n = ghosts.vetoKeys.length;
        if (n > FIZZ_SCAN_CAP) n = FIZZ_SCAN_CAP;
        uint256 sum;
        for (uint256 i; i < n; i++) {
            bool dup;
            for (uint256 j; j < i; j++) {
                if (ghosts.vetoKeys[j] == ghosts.vetoKeys[i]) dup = true;
            }
            if (dup) continue;
            (, uint64 withdrawable, , ) = redemptionWatchtower.vetoProposals(
                ghosts.vetoKeys[i]
            );
            sum += withdrawable;
        }
        eq(
            bank.balanceOf(address(redemptionWatchtower)),
            sum + ghosts.bankDonatedToWatchtowerSat,
            "SP-37: watchtower Bank balance != withdrawable amounts + donations"
        );
    }

    // ―――― Rebates ――――

    /// @notice SP-39: An applied rebate never exceeds the previewed availability: rebate == min(original fee, getAvailableRebate before the call) for a direct, non-delegated, rebate-enabled staker, one Rebate entry appended when > 0, none for reserved deposits
    function property_rebateAppliedWithinPreview() internal {
        uint256 fee0;
        uint256 stored;
        bool isDeposit = focus.redemptionKey == 0;
        if (isDeposit) {
            uint256 key = focus.resKey;
            if (key == 0) return;
            BrDeposit.DepositRequest memory d = bridge.deposits(key);
            (, uint64 divisor, , ) = bridge.depositParameters();
            fee0 = divisor > 0 ? uint256(d.amount) / divisor : 0;
            stored = d.treasuryFee;
            if (bridge.isReservedDeposit(key)) {
                eq(stored, fee0, "SP-39: rebate applied to a reserved deposit");
                return;
            }
        } else {
            fee0 = ghosts.fullTreasuryFee[focus.redemptionKey];
            stored = bridge.pendingRedemptions(focus.redemptionKey).treasuryFee;
        }
        lte(stored, fee0, "SP-39: stored treasury fee above the full fee");
        uint256 rebate = fee0 > stored ? fee0 - stored : 0;
        bool grew = stateAfter.rebateLen > stateBefore.rebateLen;
        if (grew) {
            eq(
                stateAfter.rebateLen,
                stateBefore.rebateLen + 1,
                "SP-39: more than one Rebate entry appended"
            );
            (, uint64 entry) = rebateStaking.getRebate(
                actor,
                stateBefore.rebateLen
            );
            if (rebate > 0)
                eq(
                    uint256(entry),
                    rebate,
                    "SP-39: Rebate entry != fee reduction"
                );
            if (rebate > 0 && stateBefore.rebateAvailOk) {
                lte(
                    rebate,
                    uint256(stateBefore.rebateAvail),
                    "SP-39: rebate above the previewed availability"
                );
                eq(
                    rebate,
                    fee0 < stateBefore.rebateAvail
                        ? fee0
                        : uint256(stateBefore.rebateAvail),
                    "SP-39: rebate != min(fee, availability)"
                );
            }
        } else if (
            bridge_hook.directRebate &&
            stateBefore.rebateAvailOk &&
            rebateStaking.delegates(actor) == address(0)
        ) {
            uint8 mode = uint8(rebateStaking.getRebateTreasuryFeeMode(actor));
            bool enabled =
                mode == 0 ||
                    (mode == 1 && isDeposit) ||
                    (mode == 2 && !isDeposit);
            if (enabled && fee0 > 0 && stateBefore.rebateAvail > 0) {
                t(false, "SP-39: rebate available but not applied");
            }
        }
    }

    /// @notice SP-41: getAvailableRebate == cap - rebates inside the rolling window (full scan from index 0, last FIZZ_SCAN_CAP entries), i.e. the window pointer never hides usage still inside the window
    function property_rebateWindowNoHistoryLoss() internal {
        if (_skipKnownFailing()) return;
        if (!stateAfter.rebateAvailOk || stateAfter.rebateLen > FIZZ_SCAN_CAP)
            return;
        uint256 cap = rebateStaking.getRebateCap(actor);
        uint256 used = stateAfter.rebateWindowTotal;
        eq(
            uint256(stateAfter.rebateAvail),
            cap > used ? cap - used : 0,
            "SP-41: available rebate != cap - full-scan window usage"
        );
    }

    /// @notice SP-43: The rebates recorded across the actors inside one rolling window are at most tToken.totalSupply() / rebatePerToken (last FIZZ_SCAN_CAP entries per actor)
    function property_rebateBudgetNotRecyclable() internal {
        uint256 rpt = rebateStaking.rebatePerToken();
        if (rpt == 0) return;
        uint256 window = rebateStaking.rollingWindow();
        uint256 start = block.timestamp > window ? block.timestamp - window : 0;
        uint256 sum;
        for (uint256 a; a < actors.length; a++) {
            if (ghosts.rebateHistoryMoved[actors[a]]) continue;
            uint256 len = rebateStaking.getRebateLength(actors[a]);
            uint256 first = len > FIZZ_SCAN_CAP ? len - FIZZ_SCAN_CAP : 0;
            for (uint256 i = first; i < len; i++) {
                (uint32 ts, uint64 fee) = rebateStaking.getRebate(actors[a], i);
                if (ts >= start && ts > ghosts.rebatePerTokenChangedAt)
                    sum += fee;
            }
        }
        lte(
            sum,
            tToken.totalSupply() / rpt,
            "SP-43: rebates in the window exceed totalSupply / rebatePerToken"
        );
    }

    // ―――― Wallets ――――

    /// @notice SP-97: Wallet state only moves forward along Unknown -> Live -> {MovingFunds, Closing, Terminated}, MovingFunds -> {Closing, Terminated}, Closing -> {Closed, Terminated}; Closed and Terminated are absorbing
    function property_walletStateMachine() internal {
        uint256 n = harnessWallets.length;
        for (uint256 i; i < n; i++) {
            bytes20 w = harnessWallets[i];
            uint8 prev = ghosts.prevWalletState[w];
            uint8 cur = bridge_stateOf(w);
            gte(
                uint256(cur),
                uint256(prev),
                "SP-97: wallet state moved backwards"
            );
            if (prev >= 4) {
                eq(
                    uint256(cur),
                    uint256(prev),
                    "SP-97: Closed / Terminated wallet changed state"
                );
            } else if (prev == 0) {
                lte(uint256(cur), 1, "SP-97: Unknown wallet jumped past Live");
            } else if (prev == 1) {
                t(cur != 4, "SP-97: Live wallet jumped to Closed");
            } else if (prev == 2) {
                t(
                    cur == 2 || cur == 3 || cur == 5,
                    "SP-97: invalid MovingFunds transition"
                );
            } else {
                t(
                    cur == 3 || cur == 4 || cur == 5,
                    "SP-97: invalid Closing transition"
                );
            }
        }
    }

    /// @notice SP-98: New wallet registration (Unknown -> Live, ecdsaWalletID set, createdAt == now, counters / timestamps / commitment zero, becomes the active wallet, liveWalletsCount + 1)
    function property_walletRegistration() internal {
        bytes20 w = focus.wallet0;
        if (w == bytes20(0)) return;
        eq(
            uint256(stateBefore.fw0State),
            0,
            "SP-98: registered wallet was already known"
        );
        eq(
            uint256(stateAfter.fw0State),
            1,
            "SP-98: registered wallet not Live"
        );
        BrWallets.Wallet memory wal = bridge.wallets(w);
        t(
            wal.ecdsaWalletID == bridge_hook.walletId,
            "SP-98: ecdsaWalletID not stored"
        );
        eq(uint256(wal.createdAt), block.timestamp, "SP-98: createdAt != now");
        eq(
            uint256(wal.pendingRedemptionsValue),
            0,
            "SP-98: new wallet has pending redemptions"
        );
        t(wal.mainUtxoHash == bytes32(0), "SP-98: new wallet has a main UTXO");
        eq(
            uint256(wal.movingFundsRequestedAt),
            0,
            "SP-98: new wallet movingFundsRequestedAt set"
        );
        eq(
            uint256(wal.closingStartedAt),
            0,
            "SP-98: new wallet closingStartedAt set"
        );
        eq(
            uint256(wal.pendingMovedFundsSweepRequestsCount),
            0,
            "SP-98: new wallet has pending sweeps"
        );
        t(
            wal.movingFundsTargetWalletsCommitmentHash == bytes32(0),
            "SP-98: new wallet has a commitment"
        );
        t(
            stateAfter.activeWallet == w,
            "SP-98: new wallet is not the active wallet"
        );
        eq(
            uint256(stateAfter.liveWallets),
            uint256(stateBefore.liveWallets) + 1,
            "SP-98: live wallets count not incremented"
        );
    }

    /// @notice SP-99: Moving a Live wallet out of Live: Closing iff no main UTXO and no proven reservation anchors, otherwise MovingFunds; liveWalletsCount - 1; active slot cleared iff the wallet was active
    function property_moveFundsRouting() internal {
        bytes20 w = focus.wallet0;
        if (w == bytes20(0)) return;
        uint8 b = stateBefore.fw0State;
        uint8 a = stateAfter.fw0State;
        if (b != 1 || a == 1) {
            eq(uint256(a), uint256(b), "SP-99: non-Live wallet changed state");
            eq(
                uint256(stateAfter.liveWallets),
                uint256(stateBefore.liveWallets),
                "SP-99: live wallets count changed without a Live exit"
            );
            return;
        }
        eq(
            uint256(stateAfter.liveWallets) + 1,
            uint256(stateBefore.liveWallets),
            "SP-99: live wallets count not decremented"
        );
        // R-13: routing counts proven anchors (unchanged by the call), not pending capacity.
        (uint256 anchoredCount, ) = bridge_provenAnchors(w);
        bool idle =
            stateBefore.fw0MainUtxoHash == bytes32(0) && anchoredCount == 0;
        eq(uint256(a), idle ? 3 : 2, "SP-99: wallet routed to the wrong state");
        BrWallets.Wallet memory wal = bridge.wallets(w);
        if (idle) {
            eq(
                uint256(wal.closingStartedAt),
                block.timestamp,
                "SP-99: closingStartedAt != now"
            );
        } else {
            eq(
                uint256(wal.movingFundsRequestedAt),
                block.timestamp,
                "SP-99: movingFundsRequestedAt != now"
            );
        }
        if (stateBefore.activeWallet == w) {
            t(
                stateAfter.activeWallet == bytes20(0),
                "SP-99: active wallet slot not cleared"
            );
        } else {
            t(
                stateAfter.activeWallet == stateBefore.activeWallet,
                "SP-99: active wallet changed for a non-active wallet"
            );
        }
    }

    /// @notice SP-100: notifyWalletClosingPeriodElapsed: Closing -> Closed only after the closing period and with zero reservations at the wallet
    function property_walletClosing() internal {
        bytes20 w = focus.wallet0;
        if (w == bytes20(0)) return;
        eq(
            uint256(stateBefore.fw0State),
            3,
            "SP-100: closed a wallet that was not Closing"
        );
        eq(uint256(stateAfter.fw0State), 4, "SP-100: wallet not Closed");
        (, , , , , , uint32 closingPeriod) = bridge.walletParameters();
        gt(
            block.timestamp,
            uint256(stateBefore.fw0ClosingStartedAt) + closingPeriod,
            "SP-100: closing period not elapsed"
        );
        eq(
            uint256(stateAfter.fw0Count),
            0,
            "SP-100: Closed wallet still custodies reservations"
        );
        eq(
            uint256(stateAfter.fw0Amount),
            0,
            "SP-100: Closed wallet still has reserved amount"
        );
        eq(
            uint256(stateAfter.liveWallets),
            uint256(stateBefore.liveWallets),
            "SP-100: closing changed the live wallets count"
        );
        t(
            stateAfter.activeWallet == stateBefore.activeWallet,
            "SP-100: closing changed the active wallet"
        );
    }

    /// @notice SP-101: Moving-funds exits (commitment, proof, timeout, below dust): states, commitment, main UTXO, sweep request counters and timestamps
    function property_movingFundsExits() internal {
        bridge_Hook storage h = bridge_hook;
        uint8 kind = h.movingKind;
        if (kind == 0 || kind == bridge_MK_CLOSEABLE) return;
        bytes20 w = focus.wallet0;
        eq(
            uint256(stateBefore.fw0State),
            2,
            "SP-101: moving-funds exit from a non-MovingFunds wallet"
        );
        BrWallets.Wallet memory wal = bridge.wallets(w);
        if (kind == bridge_MK_COMMITMENT) {
            eq(
                uint256(stateAfter.fw0State),
                2,
                "SP-101: commitment changed the wallet state"
            );
            eq(
                uint256(stateBefore.fw0PendingValue),
                0,
                "SP-101: commitment with pending redemptions"
            );
            eq(
                uint256(stateBefore.fw0PendingSweeps),
                0,
                "SP-101: commitment with pending sweeps"
            );
            t(h.commitBefore == bytes32(0), "SP-101: commitment overwritten");
            t(
                wal.movingFundsTargetWalletsCommitmentHash != bytes32(0),
                "SP-101: commitment not stored"
            );
        } else if (kind == bridge_MK_PROOF) {
            eq(
                uint256(stateAfter.fw0State),
                3,
                "SP-101: moving-funds proof did not start closing"
            );
            t(
                stateAfter.fw0MainUtxoHash == bytes32(0),
                "SP-101: source wallet kept its main UTXO"
            );
            t(
                bridge.spentMainUTXOs(
                    bridge_utxoKeyOf(h.oldMainTxHash, h.oldMainIndex)
                ),
                "SP-101: old main UTXO not marked spent"
            );
            eq(
                uint256(wal.closingStartedAt),
                block.timestamp,
                "SP-101: closingStartedAt != now"
            );
            uint256 nw = harnessWallets.length;
            for (uint256 i; i < nw && i < bridge_hookPendSweeps.length; i++) {
                uint256 occurrences;
                for (uint256 j; j < ghosts.lastMovedTargets.length; j++) {
                    if (ghosts.lastMovedTargets[j] == harnessWallets[i])
                        occurrences++;
                }
                eq(
                    uint256(
                        bridge
                            .wallets(harnessWallets[i])
                            .pendingMovedFundsSweepRequestsCount
                    ),
                    uint256(bridge_hookPendSweeps[i]) + occurrences,
                    "SP-101: target pending sweeps counter mismatch"
                );
            }
        } else if (kind == bridge_MK_TIMEOUT) {
            eq(
                uint256(stateAfter.fw0State),
                5,
                "SP-101: moving-funds timeout did not terminate the wallet"
            );
            eq(
                uint256(stateAfter.liveWallets),
                uint256(stateBefore.liveWallets),
                "SP-101: timeout changed the live wallets count"
            );
            eq(
                walletRegistry.seizeCalls(),
                h.seizeBefore + 1,
                "SP-101: timeout did not slash exactly once"
            );
        } else if (kind == bridge_MK_BELOW_DUST) {
            eq(
                uint256(stateAfter.fw0State),
                3,
                "SP-101: below-dust did not start closing"
            );
            t(
                stateAfter.fw0MainUtxoHash == stateBefore.fw0MainUtxoHash,
                "SP-101: below-dust changed the main UTXO"
            );
            eq(
                uint256(wal.closingStartedAt),
                block.timestamp,
                "SP-101: closingStartedAt != now"
            );
            (, uint64 dust, , , , , , , , , ) = bridge.movingFundsParameters();
            lt(
                h.mainValue,
                uint256(dust),
                "SP-101: below-dust accepted a balance above the dust threshold"
            );
        }
    }

    /// @notice SP-102: Moving-funds proof conservation: registered sweep requests sum to the transaction outputs T, are evenly distributed, fee oldMain - T <= movingFundsTxMaxTotalFee, source wallet has no main UTXO / pending redemptions
    function property_movingFundsProofConservation() internal {
        bridge_Hook storage h = bridge_hook;
        uint256 n = h.mfCount;
        if (n == 0) return;
        uint256 low = h.mfTotal / n;
        uint256 high = low + (h.mfTotal % n);
        uint256 sum;
        for (uint256 i; i < n; i++) {
            BrMovingFunds.MovedFundsSweepRequest memory req = bridge
                .movedFundsSweepRequests(
                    ghosts.movedFundsKeys[h.mfFirstIdx + i]
                );
            gte(
                uint256(req.value),
                low,
                "SP-102: sweep request below floor(T / n)"
            );
            lte(
                uint256(req.value),
                high,
                "SP-102: sweep request above floor(T / n) + T % n"
            );
            eq(uint256(req.state), 1, "SP-102: sweep request not Pending");
            sum += req.value;
        }
        eq(
            sum,
            h.mfTotal,
            "SP-102: sweep requests do not sum to the transaction outputs"
        );
        (uint64 maxTotalFee, , , , , , , , , , ) = bridge
            .movingFundsParameters();
        lte(
            uint256(h.oldMainValue) - h.mfTotal,
            uint256(maxTotalFee),
            "SP-102: Bitcoin fee above movingFundsTxMaxTotalFee"
        );
        t(
            stateAfter.fw0MainUtxoHash == bytes32(0),
            "SP-102: source wallet kept its main UTXO"
        );
        eq(
            uint256(stateAfter.fw0PendingValue),
            0,
            "SP-102: source wallet has pending redemptions"
        );
    }

    /// @notice SP-103: Moved-funds sweep request state machine Unknown -> Pending -> {Processed, TimedOut} (cursor scan + the affected key), sweep proof / timeout postconditions on the target wallet
    function property_movedFundsSweepStateMachine() internal {
        uint256 n = ghosts.movedFundsKeys.length;
        if (n > 0) {
            uint256 steps = n < FIZZ_CURSOR_STEP ? n : FIZZ_CURSOR_STEP;
            uint256 cursor = bridge_sweepCursor % n;
            for (uint256 i; i < steps; i++) {
                _bridge_checkSweepEdge(ghosts.movedFundsKeys[(cursor + i) % n]);
            }
        }
        bridge_Hook storage h = bridge_hook;
        if (h.sweepKind == 0) return;
        _bridge_checkSweepEdge(h.sweepKey);
        uint8 cur = uint8(bridge.movedFundsSweepRequests(h.sweepKey).state);
        eq(
            uint256(stateAfter.fw0PendingSweeps) + 1,
            uint256(stateBefore.fw0PendingSweeps),
            "SP-103: target pending sweeps counter not decremented"
        );
        if (h.sweepKind == bridge_SK_PROOF) {
            eq(
                uint256(cur),
                2,
                "SP-103: sweep proof did not mark the request Processed"
            );
            t(
                stateAfter.fw0MainUtxoHash ==
                    keccak256(
                        abi.encodePacked(
                            h.newMainTxHash,
                            uint32(0),
                            h.newMainValue
                        )
                    ),
                "SP-103: target main UTXO not replaced by the sweep output"
            );
            if (h.oldMainTxHash != bytes32(0)) {
                t(
                    bridge.spentMainUTXOs(
                        bridge_utxoKeyOf(h.oldMainTxHash, h.oldMainIndex)
                    ),
                    "SP-103: previous target main UTXO not marked spent"
                );
            }
            eq(
                uint256(stateAfter.fw0State),
                uint256(stateBefore.fw0State),
                "SP-103: sweep proof changed the target wallet state"
            );
        } else {
            eq(
                uint256(cur),
                3,
                "SP-103: sweep timeout did not mark the request TimedOut"
            );
            if (stateBefore.fw0State == 5) {
                eq(
                    uint256(stateAfter.fw0State),
                    5,
                    "SP-103: Terminated target changed state"
                );
                eq(
                    uint256(stateAfter.liveWallets),
                    uint256(stateBefore.liveWallets),
                    "SP-103: Terminated timeout changed the live wallets count"
                );
            } else {
                eq(
                    uint256(stateAfter.fw0State),
                    5,
                    "SP-103: sweep timeout did not terminate the target"
                );
                eq(
                    uint256(stateAfter.liveWallets) +
                        (stateBefore.fw0State == 1 ? 1 : 0),
                    uint256(stateBefore.liveWallets),
                    "SP-103: live wallets count mismatch after termination"
                );
            }
        }
    }

    function _bridge_checkSweepEdge(uint256 key) private {
        uint8 cur = uint8(bridge.movedFundsSweepRequests(key).state);
        uint8 prev = ghosts.prevSweepState[key];
        bool ok = prev == 0 ? cur <= 1 : (prev == 1 ? cur >= 1 : cur == prev);
        t(ok, "SP-103: invalid moved-funds sweep request transition");
    }

    /// @notice SP-104: pendingMovedFundsSweepRequestsCount of every wallet equals the number of tracked Pending sweep requests targeting it
    function property_pendingMovedFundsCountSync() internal {
        uint256 n = ghosts.movedFundsKeys.length;
        if (n > FIZZ_SCAN_CAP) n = FIZZ_SCAN_CAP;
        uint256 nw = harnessWallets.length;
        uint256[] memory counts = new uint256[](nw);
        for (uint256 k; k < n; k++) {
            BrMovingFunds.MovedFundsSweepRequest memory req = bridge
                .movedFundsSweepRequests(ghosts.movedFundsKeys[k]);
            if (req.state != BrMovingFunds.MovedFundsSweepRequestState.Pending)
                continue;
            for (uint256 j; j < nw; j++) {
                if (harnessWallets[j] == req.walletPubKeyHash) counts[j]++;
            }
        }
        for (uint256 j; j < nw; j++) {
            eq(
                uint256(
                    bridge
                        .wallets(harnessWallets[j])
                        .pendingMovedFundsSweepRequestsCount
                ),
                counts[j],
                "SP-104: pendingMovedFundsSweepRequestsCount != tracked Pending requests"
            );
        }
    }

    /// @notice SP-105: A Pending moved-funds sweep request always targets a Live, MovingFunds or Terminated wallet (the only states from which a sweep proof / timeout is processable)
    function property_pendingSweepTargetsProcessable() internal {
        uint256 n = ghosts.movedFundsKeys.length;
        if (n > FIZZ_SCAN_CAP) n = FIZZ_SCAN_CAP;
        for (uint256 k; k < n; k++) {
            BrMovingFunds.MovedFundsSweepRequest memory req = bridge
                .movedFundsSweepRequests(ghosts.movedFundsKeys[k]);
            if (req.state != BrMovingFunds.MovedFundsSweepRequestState.Pending)
                continue;
            uint8 st = bridge_stateOf(req.walletPubKeyHash);
            t(
                st == 1 || st == 2 || st == 5,
                "SP-105: Pending sweep request targets a Closing / Closed / Unknown wallet"
            );
        }
    }

    /// @notice SP-106: A wallet enters MovingFunds only if it had a main UTXO or at least one proven (Active / ActionPending) anchor; a moving-funds timeout slash only follows such a wallet
    function property_walletMovesNeedBtcOrProvenAnchors() internal {
        uint256 n = harnessWallets.length;
        for (uint256 i; i < n; i++) {
            bytes20 w = harnessWallets[i];
            if (ghosts.prevWalletState[w] == 1 && bridge_stateOf(w) == 2) {
                t(
                    ghosts.hadMainUtxoWhenMovingFunds[w] ||
                        ghosts.hadProvenAnchorsWhenMovingFunds[w],
                    "SP-106: wallet entered MovingFunds without a main UTXO or proven anchors"
                );
            }
        }
        bytes20 w0 = focus.wallet0;
        if (
            bridge_hook.movingKind == bridge_MK_TIMEOUT &&
            w0 != bytes20(0) &&
            walletRegistry.seizeCalls() > bridge_hook.seizeBefore
        ) {
            t(
                ghosts.hadMainUtxoWhenMovingFunds[w0] ||
                    ghosts.hadProvenAnchorsWhenMovingFunds[w0],
                "SP-106: moving-funds timeout slashed a wallet without a main UTXO or proven anchors"
            );
        }
    }

    /// @notice SP-107: The closeability test must count Bitcoin held in reservation anchors: a low-balance closeable / below-dust exit needs main UTXO + Active / ActionPending anchors below the threshold
    function property_closeabilityCountsAnchors() internal {
        if (_skipKnownFailing()) return;
        bridge_Hook storage h = bridge_hook;
        uint8 kind = h.movingKind;
        if (kind != bridge_MK_CLOSEABLE && kind != bridge_MK_BELOW_DUST) return;
        bytes20 w = focus.wallet0;
        if (w == bytes20(0) || stateAfter.fw0State == stateBefore.fw0State)
            return;
        (, uint256 anchors) = bridge_provenAnchors(w);
        if (kind == bridge_MK_CLOSEABLE) {
            (, , , uint64 closureMin, uint32 maxAge, , ) = bridge
                .walletParameters();
            bool old =
                block.timestamp >=
                    uint256(bridge.wallets(w).createdAt) + maxAge;
            t(
                old || h.mainValue + anchors < uint256(closureMin),
                "SP-107: wallet holding anchors flipped out of Live through the low-balance route"
            );
        } else {
            (, uint64 dust, , , , , , , , , ) = bridge.movingFundsParameters();
            lt(
                h.mainValue + anchors,
                uint256(dust),
                "SP-107: below-dust exit ignored reservation anchors"
            );
        }
    }

    /// @notice SP-108: Wallet timestamps are write-once per entered state: createdAt never changes, movingFundsRequestedAt / closingStartedAt keep their value once set, none decreases
    function property_walletTimestampsWriteOnce() internal {
        uint256 n = harnessWallets.length;
        for (uint256 i; i < n; i++) {
            bytes20 w = harnessWallets[i];
            BrWallets.Wallet memory wal = bridge.wallets(w);
            uint32 pc = ghosts.prevCreatedAt[w];
            if (pc != 0)
                eq(
                    uint256(wal.createdAt),
                    uint256(pc),
                    "SP-108: createdAt changed"
                );
            uint32 pm = ghosts.prevMovingFundsRequestedAt[w];
            if (pm != 0) {
                if (
                    bridge_hook.timeoutReset && wal.movingFundsRequestedAt != pm
                ) {
                    eq(
                        uint256(wal.movingFundsRequestedAt),
                        block.timestamp,
                        "SP-108: timeout reset did not stamp now"
                    );
                } else {
                    eq(
                        uint256(wal.movingFundsRequestedAt),
                        uint256(pm),
                        "SP-108: movingFundsRequestedAt changed once set"
                    );
                }
            }
            uint32 pcl = ghosts.prevClosingStartedAt[w];
            if (pcl != 0)
                eq(
                    uint256(wal.closingStartedAt),
                    uint256(pcl),
                    "SP-108: closingStartedAt changed once set"
                );
            gte(
                uint256(wal.movingFundsRequestedAt),
                uint256(pm),
                "SP-108: movingFundsRequestedAt decreased"
            );
            gte(
                uint256(wal.closingStartedAt),
                uint256(pcl),
                "SP-108: closingStartedAt decreased"
            );
        }
    }

    // ―――― Fraud ――――

    /// @notice SP-109: Fraud challenge lifecycle: submit stores {reportedAt = now, resolved = false, depositAmount = msg.value, challenger}; defeat resolves it and sends the deposit to the treasury; defeat-timeout resolves it, refunds the challenger and terminates a Live / MovingFunds / Closing wallet
    function property_fraudChallengeLifecycle() internal {
        bridge_Hook storage h = bridge_hook;
        uint8 kind = h.fraudKind;
        if (kind == 0) return;
        BrFraud.FraudChallenge memory c = bridge.fraudChallenges(h.fraudKey);
        if (kind == bridge_FK_SUBMIT) {
            eq(
                uint256(c.reportedAt),
                block.timestamp,
                "SP-109: reportedAt != now"
            );
            t(!c.resolved, "SP-109: new challenge already resolved");
            eq(
                c.depositAmount,
                h.fraudValue,
                "SP-109: depositAmount != msg.value"
            );
            t(c.challenger == actor, "SP-109: challenger != caller");
            eq(
                stateAfter.bridgeEth,
                stateBefore.bridgeEth + h.fraudValue,
                "SP-109: Bridge ETH balance did not grow by the deposit"
            );
            eq(
                uint256(stateAfter.fw0State),
                uint256(stateBefore.fw0State),
                "SP-109: submit changed the wallet state"
            );
            eq(
                uint256(stateAfter.liveWallets),
                uint256(stateBefore.liveWallets),
                "SP-109: submit changed the live wallets count"
            );
            return;
        }
        t(c.resolved, "SP-109: challenge not resolved");
        eq(
            uint256(c.reportedAt),
            uint256(h.fraudReportedAt),
            "SP-109: reportedAt changed"
        );
        eq(
            stateBefore.bridgeEth,
            stateAfter.bridgeEth + c.depositAmount,
            "SP-109: Bridge ETH balance did not fall by the deposit"
        );
        if (kind == bridge_FK_DEFEAT) {
            if (bridge.treasury() == treasury) {
                eq(
                    stateAfter.treasuryEth,
                    stateBefore.treasuryEth + c.depositAmount,
                    "SP-109: deposit not sent to the treasury"
                );
            }
            eq(
                uint256(stateAfter.fw0State),
                uint256(stateBefore.fw0State),
                "SP-109: defeat changed the wallet state"
            );
            eq(
                uint256(stateAfter.liveWallets),
                uint256(stateBefore.liveWallets),
                "SP-109: defeat changed the live wallets count"
            );
        } else {
            uint8 b = stateBefore.fw0State;
            if (b == 1 || b == 2 || b == 3) {
                eq(
                    uint256(stateAfter.fw0State),
                    5,
                    "SP-109: defeat timeout did not terminate the wallet"
                );
                eq(
                    uint256(stateAfter.liveWallets) + (b == 1 ? 1 : 0),
                    uint256(stateBefore.liveWallets),
                    "SP-109: live wallets count mismatch after termination"
                );
                if (stateBefore.activeWallet == focus.wallet0) {
                    t(
                        stateAfter.activeWallet == bytes20(0),
                        "SP-109: active wallet slot not cleared"
                    );
                }
            } else {
                eq(
                    uint256(stateAfter.fw0State),
                    uint256(b),
                    "SP-109: Terminated wallet changed state on a defeat timeout"
                );
                eq(
                    uint256(stateAfter.liveWallets),
                    uint256(stateBefore.liveWallets),
                    "SP-109: Terminated timeout changed the live wallets count"
                );
            }
        }
    }

    /// @notice SP-110: The Bridge's ETH balance covers the deposits of all unresolved fraud challenges
    function property_fraudEthEscrow() internal {
        uint256 n = ghosts.challengeKeys.length;
        if (n > FIZZ_SCAN_CAP) n = FIZZ_SCAN_CAP;
        uint256 owed;
        for (uint256 i; i < n; i++) {
            BrFraud.FraudChallenge memory c = bridge.fraudChallenges(
                ghosts.challengeKeys[i]
            );
            if (c.reportedAt != 0 && !c.resolved) owed += c.depositAmount;
        }
        gte(
            address(bridge).balance,
            owed,
            "SP-110: Bridge ETH balance below the unresolved challenge deposits"
        );
    }

    /// @notice SP-111: A fraud challenge against a wallet-signed spend of an honestly spent reservation outpoint must be defeatable (defeat did not revert and the Bridge recognises the outpoint as spent)
    function property_honestAnchorSpendDefeatable() internal {
        t(
            !bridge_hook.honestReverted,
            "SP-111: defeatFraudChallenge reverted for an honest spend of a reservation outpoint"
        );
        t(
            bridge_hook.honestSettled,
            "SP-111: honestly spent reservation outpoint not recognised as spent"
        );
    }

    // ── end Bridge shard ──

    // ── Specific: Reservation shard (ReservationRouterHandler) ──

    // ── Reservation shard helpers (prefix `_resProp_`) ──
    // Enum mirrors as uint8: Reservation.ReservationState / ActionState and
    // Wallets.WalletState (snapshot fields are uint8).
    uint8 internal constant _resProp_RS_UNKNOWN = 0;
    uint8 internal constant _resProp_RS_ACTIVE = 1;
    uint8 internal constant _resProp_RS_ACTION_PENDING = 2;
    uint8 internal constant _resProp_RS_CLOSED = 3;
    uint8 internal constant _resProp_RS_STRANDED = 4;
    uint8 internal constant _resProp_AS_UNKNOWN = 0;
    uint8 internal constant _resProp_AS_PENDING = 1;
    uint8 internal constant _resProp_AS_SETTLED = 2;
    uint8 internal constant _resProp_AS_TIMED_OUT = 3;
    uint8 internal constant _resProp_AS_VETOED = 4;
    uint8 internal constant _resProp_AS_SUPERSEDED = 5;
    uint8 internal constant _resProp_WS_UNKNOWN = 0;
    uint8 internal constant _resProp_WS_LIVE = 1;
    uint8 internal constant _resProp_WS_MOVING_FUNDS = 2;
    uint8 internal constant _resProp_WS_CLOSING = 3;
    uint8 internal constant _resProp_WS_CLOSED = 4;
    uint8 internal constant _resProp_WS_TERMINATED = 5;
    /// @dev Word indexes of `reservationParameters()`.
    uint256 internal constant _resProp_P_MIN_AMOUNT = 1;
    uint256 internal constant _resProp_P_TX_MAX_FEE = 2;
    uint256 internal constant _resProp_P_MAX_TOTAL = 5;
    uint256 internal constant _resProp_P_TOTAL = 6;
    uint256 internal constant _resProp_P_MAX_PER_WALLET = 7;
    uint256 internal constant _resProp_P_ACTION_TIMEOUT = 8;
    /// @dev Bridge `DEPOSIT_REFUND_SAFETY_MARGIN` (WalletProposalValidatorConstants).
    uint256 internal constant _resProp_REFUND_MARGIN = 24 hours;

    /// @dev Rotating start of the per-call key window (advanced by the
    ///      reservation hub of the handlers, never by a property).
    uint256 internal _resProp_cursor;
    /// @dev SP-55 / SP-61: precondition of a proof that reverted; set by the
    ///      handler right before the NeverBlocked property in the catch path.
    bool internal _resProp_probePre;
    /// @dev SP-69: the reservation vault parameter changed in the update.
    bool internal _resProp_vaultChanged;
    /// @dev SP-53 flows: reservationTotalAmount before the acceptance request.
    bool internal _resProp_flowBaseSet;
    uint64 internal _resProp_flowTotalBase;

    /// @dev Aggregates over `harnessReservationKeys` (complete key set,
    ///      <= FIZZ_SCAN_CAP by admission control) and `harnessWallets`.
    struct ResPropLedger {
        uint256 nHold;
        uint256 amtHold;
        uint256 nPendAcc;
        uint256 amtPendAcc;
        uint256 nPendRe;
        uint256 amtPendRe;
        uint256 amtStranded;
        uint256[] wCount;
        uint256[] wAmount;
        uint256[] wPendAcc;
    }

    function _resProp_cap(uint256 n) internal pure returns (uint256) {
        return n > FIZZ_SCAN_CAP ? FIZZ_SCAN_CAP : n;
    }

    /// @dev Word `index` of `reservationParameters()` (raw read avoids a
    ///      10-value stack destructuring).
    function _resProp_param(
        uint256 index
    ) internal view returns (uint256 value) {
        (bool ok, bytes memory ret) = address(reservationRouter).staticcall(
            abi.encodeWithSelector(
                reservationRouter.reservationParameters.selector
            )
        );
        require(ok && ret.length >= 320, "resProp: parameters read failed");
        // solhint-disable-next-line no-inline-assembly
        assembly {
            value := mload(add(add(ret, 32), mul(index, 32)))
        }
    }

    function _resProp_anchorKey(
        bytes32 txHash,
        uint32 outputIndex
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(txHash, outputIndex)));
    }

    function _resProp_holds(
        RsReservation.ReservationRequest memory r
    ) internal pure returns (bool) {
        return
            r.state == RsReservation.ReservationState.Active ||
            r.state == RsReservation.ReservationState.ActionPending;
    }

    function _resProp_walletState(bytes20 w) internal view returns (uint8) {
        return uint8(bridge.wallets(w).state);
    }

    function _resProp_walletIndex(
        bytes20 w,
        uint256 nw
    ) internal view returns (uint256) {
        for (uint256 i; i < nw; i++) {
            if (harnessWallets[i] == w) return i;
        }
        return nw;
    }

    /// @dev False when `harnessWallets[i]` repeats an earlier entry.
    function _resProp_isFirstWallet(uint256 i) internal view returns (bool) {
        bytes20 w = harnessWallets[i];
        for (uint256 j; j < i; j++) {
            if (harnessWallets[j] == w) return false;
        }
        return true;
    }

    function _resProp_actionImageKey(
        uint256 key,
        uint64 nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, nonce));
    }

    /// @dev Hash of every request-time snapshot field of a generation (all
    ///      fields but `state`).
    function _resProp_actionImage(
        uint256 key,
        uint64 nonce
    ) internal view returns (bytes32) {
        RsReservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, nonce);
        bytes32 h1 = keccak256(
            abi.encode(
                a.targetWalletPubKeyHash,
                a.requestedAt,
                a.timeoutAt,
                a.txMaxFee,
                uint8(a.actionType),
                a.feePaid,
                a.redeemer
            )
        );
        bytes32 h2 = keccak256(
            abi.encode(
                a.actionDataHash,
                a.sourceAnchorUtxoHash,
                a.amount,
                a.termSeconds,
                a.dissolutionDelay,
                a.minAmount
            )
        );
        return keccak256(abi.encode(h1, h2));
    }

    function _resProp_acceptedImage(
        RsReservation.ReservationRequest memory r
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    r.owner,
                    r.acceptedAt,
                    r.expiresAt,
                    r.dissolutionEligibleAt
                )
            );
    }

    /// @dev Keys checked by the per-key shadow properties: the focus
    ///      reservation (if any) plus a `FIZZ_CURSOR_STEP` window of
    ///      `harnessReservationKeys` starting at the cursor.
    function _resProp_windowKeys()
        internal
        view
        returns (uint256[] memory keys)
    {
        uint256 n = _resProp_cap(harnessReservationKeys.length);
        uint256 step = n < FIZZ_CURSOR_STEP ? n : FIZZ_CURSOR_STEP;
        keys = new uint256[](step + 1);
        uint256 count;
        uint256 fk = focus.resKey;
        if (fk != 0) {
            keys[count++] = fk;
        }
        uint256 start = n == 0 ? 0 : _resProp_cursor % n;
        for (uint256 j; j < step; j++) {
            uint256 k = harnessReservationKeys[(start + j) % n];
            if (k != fk) {
                keys[count++] = k;
            }
        }
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(keys, count)
        }
    }

    /// @dev Window start / size over a ghost array of length `len`.
    function _resProp_window(
        uint256 len
    ) internal view returns (uint256 start, uint256 size) {
        uint256 n = _resProp_cap(len);
        size = n < FIZZ_CURSOR_STEP ? n : FIZZ_CURSOR_STEP;
        start = n == 0 ? 0 : _resProp_cursor % n;
    }

    function _resProp_scan() internal view returns (ResPropLedger memory L) {
        uint256 nk = _resProp_cap(harnessReservationKeys.length);
        uint256 nw = _resProp_cap(harnessWallets.length);
        L.wCount = new uint256[](nw);
        L.wAmount = new uint256[](nw);
        L.wPendAcc = new uint256[](nw);
        for (uint256 i; i < nk; i++) {
            _resProp_scanKey(L, harnessReservationKeys[i], nw);
        }
    }

    function _resProp_scanKey(
        ResPropLedger memory L,
        uint256 key,
        uint256 nw
    ) internal view {
        RsReservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        if (r.state == RsReservation.ReservationState.Stranded)
            L.amtStranded += r.anchorAmount;
        if (_resProp_holds(r)) {
            L.nHold++;
            L.amtHold += r.anchorAmount;
            uint256 wi = _resProp_walletIndex(r.walletPubKeyHash, nw);
            if (wi < nw) {
                L.wCount[wi]++;
                L.wAmount[wi] += r.anchorAmount;
            }
        }
        RsReservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, r.requestNonce);
        if (a.state != RsReservation.ActionState.Pending) return;
        uint256 ti = _resProp_walletIndex(a.targetWalletPubKeyHash, nw);
        if (a.actionType == RsReservation.ActionType.Acceptance) {
            L.nPendAcc++;
            L.amtPendAcc += a.amount;
            if (ti < nw) {
                L.wCount[ti]++;
                L.wAmount[ti] += a.amount;
                L.wPendAcc[ti]++;
            }
        } else if (a.actionType == RsReservation.ActionType.Reanchor) {
            L.nPendRe++;
            L.amtPendRe += a.amount;
            if (ti < nw) {
                L.wCount[ti]++;
                L.wAmount[ti] += a.amount;
                L.wPendAcc[ti]++;
            }
        }
    }

    // ── Reservation shard: handler-local postconditions ──

    /// @notice SP-48: a successful acceptance request advances the generation by one, reserves exactly the deposit amount (globally and on the designated wallet) and leaves the position Unknown
    function property_acceptanceRequestPostconditions() internal {
        uint256 key = stateAfter.frKey;
        if (key == 0) return;
        uint256 d = bridge.deposits(key).amount;
        RsReservation.ReservationAction memory act = reservationRouter
            .reservationActions(key, stateAfter.frNonce);
        eq(
            uint256(stateAfter.frNonce),
            uint256(stateBefore.frNonce) + 1,
            "SP-48: request nonce did not advance by one"
        );
        eq(
            uint256(stateAfter.frState),
            uint256(_resProp_RS_UNKNOWN),
            "SP-48: position left Unknown on an acceptance request"
        );
        eq(
            uint256(stateAfter.frActState),
            uint256(_resProp_AS_PENDING),
            "SP-48: new generation is not Pending"
        );
        eq(
            uint256(stateAfter.frActAmount),
            d,
            "SP-48: generation amount != deposit amount"
        );
        eq(
            uint256(act.requestedAt),
            block.timestamp,
            "SP-48: requestedAt != now"
        );
        eq(
            uint256(act.timeoutAt),
            uint256(act.requestedAt) +
                _resProp_param(_resProp_P_ACTION_TIMEOUT),
            "SP-48: timeoutAt != requestedAt + actionTimeout"
        );
        eq(
            uint256(stateAfter.resActive),
            uint256(stateBefore.resActive) + 1,
            "SP-48: active count did not grow by one"
        );
        eq(
            uint256(stateAfter.resTotal),
            uint256(stateBefore.resTotal) + d,
            "SP-48: reserved total did not grow by the deposit amount"
        );
        eq(
            uint256(stateAfter.fw0Count),
            uint256(stateBefore.fw0Count) + 1,
            "SP-48: wallet count did not grow by one"
        );
        eq(
            uint256(stateAfter.fw0Amount),
            uint256(stateBefore.fw0Amount) + d,
            "SP-48: wallet amount did not grow by the deposit amount"
        );
        eq(
            uint256(stateAfter.resPendingReserved),
            uint256(stateBefore.resPendingReserved),
            "SP-48: pending reserved deposits changed"
        );
        eq(
            stateAfter.tbtcSupply,
            stateBefore.tbtcSupply,
            "SP-48: TBTC supply changed on a request"
        );
    }

    /// @notice SP-49: a pending acceptance window ends at least DEPOSIT_REFUND_SAFETY_MARGIN before the deposit refund deadline
    function property_acceptanceRequestAdmission() internal {
        uint256 key = stateAfter.frKey;
        if (key == 0) return;
        uint32 deadline = ghosts.refundDeadline[key];
        if (deadline == 0) return;
        RsReservation.ReservationAction memory act = reservationRouter
            .reservationActions(key, stateAfter.frNonce);
        if (act.state != RsReservation.ActionState.Pending) return;
        lte(
            uint256(act.timeoutAt) + _resProp_REFUND_MARGIN,
            uint256(deadline),
            "SP-49: acceptance window overlaps the refund window"
        );
    }

    /// @notice SP-50: reporting an acceptance timeout releases exactly the capacity the request reserved and moves no tokens
    function property_acceptanceTimeoutPostconditions() internal {
        eq(
            uint256(stateAfter.frActState),
            uint256(_resProp_AS_TIMED_OUT),
            "SP-50: generation is not TimedOut"
        );
        eq(
            uint256(stateAfter.resActive) + 1,
            uint256(stateBefore.resActive),
            "SP-50: active count did not drop by one"
        );
        eq(
            uint256(stateAfter.resTotal) + uint256(stateBefore.frActAmount),
            uint256(stateBefore.resTotal),
            "SP-50: reserved total did not drop by the generation amount"
        );
        eq(
            uint256(stateAfter.fw0Count) + 1,
            uint256(stateBefore.fw0Count),
            "SP-50: wallet count did not drop by one"
        );
        eq(
            uint256(stateAfter.fw0Amount) + uint256(stateBefore.frActAmount),
            uint256(stateBefore.fw0Amount),
            "SP-50: wallet amount did not drop by the generation amount"
        );
        eq(
            stateAfter.tbtcSupply,
            stateBefore.tbtcSupply,
            "SP-50: TBTC supply changed on a timeout"
        );
        eq(
            stateAfter.bankTracked,
            stateBefore.bankTracked,
            "SP-50: Bank balances changed on a timeout"
        );
    }

    /// @notice SP-51: request + timeout of an acceptance leaves the global and wallet capacity counters as they were before the request
    function property_acceptanceTimeoutRoundTrip() internal {
        eq(
            uint256(stateAfter.resActive),
            uint256(stateBefore.resActive),
            "SP-51: active count not restored"
        );
        eq(
            uint256(stateAfter.resTotal),
            uint256(stateBefore.resTotal),
            "SP-51: reserved total not restored"
        );
        eq(
            uint256(stateAfter.fw0Count),
            uint256(stateBefore.fw0Count),
            "SP-51: wallet count not restored"
        );
        eq(
            uint256(stateAfter.fw0Amount),
            uint256(stateBefore.fw0Amount),
            "SP-51: wallet amount not restored"
        );
    }

    /// @notice SP-52: an acceptance proof records the position (owner, anchor, term), sweeps the deposit exactly once and clears the pending marker
    function property_acceptanceProofRecord() internal {
        uint256 key = stateAfter.frKey;
        if (key == 0) return;
        RsReservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        eq(
            uint256(stateAfter.fdSweptAt),
            block.timestamp,
            "SP-52: deposit sweptAt != now"
        );
        eq(
            uint256(uint160(stateAfter.fdMarker)),
            0,
            "SP-52: pending marker not cleared"
        );
        eq(
            uint256(stateAfter.resPendingReserved) +
                (stateBefore.fdMarker != bytes20(0) ? 1 : 0),
            uint256(stateBefore.resPendingReserved),
            "SP-52: pending reserved deposits not decremented once"
        );
        t(
            stateAfter.frState == _resProp_RS_ACTIVE ||
                stateAfter.frState == _resProp_RS_STRANDED,
            "SP-52: settled position is neither Active nor Stranded"
        );
        eq(
            uint256(uint160(r.owner)),
            uint256(uint160(bridge.deposits(key).depositor)),
            "SP-52: owner != depositor"
        );
        eq(
            uint256(r.mintedAmount),
            uint256(r.anchorAmount),
            "SP-52: mintedAmount != anchorAmount"
        );
        eq(uint256(r.acceptedAt), block.timestamp, "SP-52: acceptedAt != now");
        eq(
            uint256(r.anchorTxOutputIndex),
            0,
            "SP-52: anchor output index != 0"
        );
        eq(
            uint256(r.cumulativeReanchorFee),
            0,
            "SP-52: fresh position carries a re-anchor fee"
        );
        if (stateAfter.frState == _resProp_RS_ACTIVE) {
            eq(
                reservationRouter.reservationByAnchorUtxo(r.anchorTxHash, 0),
                key,
                "SP-52: anchor index not set"
            );
        }
        if (!ghosts.lateFlag) {
            _resProp_acceptanceProofGeneration(key, r);
        }
    }

    /// @dev On-time settlement only: the settled generation is the current one.
    function _resProp_acceptanceProofGeneration(
        uint256 key,
        RsReservation.ReservationRequest memory r
    ) internal {
        RsReservation.ReservationAction memory act = reservationRouter
            .reservationActions(key, stateAfter.frNonce);
        eq(
            uint256(stateAfter.frActState),
            uint256(_resProp_AS_SETTLED),
            "SP-52: generation not Settled"
        );
        eq(
            uint256(r.expiresAt),
            block.timestamp + act.termSeconds,
            "SP-52: expiresAt != now + snapshotted term"
        );
        eq(
            uint256(r.dissolutionEligibleAt),
            uint256(r.expiresAt) + act.dissolutionDelay,
            "SP-52: dissolutionEligibleAt != expiresAt + snapshotted delay"
        );
        gte(
            uint256(r.anchorAmount),
            uint256(act.minAmount),
            "SP-52: anchor below the snapshotted minimum"
        );
        lte(
            uint256(act.amount),
            uint256(r.anchorAmount) + uint256(act.txMaxFee),
            "SP-52: anchor fee above the snapshotted txMaxFee"
        );
        lte(
            uint256(r.anchorAmount),
            uint256(act.amount),
            "SP-52: anchor above the reserved deposit amount"
        );
    }

    /// @notice SP-53: acceptance settlement releases the miner-fee delta (on time) or re-takes the anchor capacity (late), unwinding / stranding as applicable
    function property_acceptanceCapacityAccounting() internal {
        uint256 v = stateAfter.frAnchorAmount;
        bool stranded = stateAfter.frState == _resProp_RS_STRANDED;
        uint256 s = stranded ? 1 : 0;
        uint256 sv = stranded ? v : 0;
        if (!ghosts.lateFlag) {
            uint256 a0 = stateBefore.frActAmount;
            eq(
                uint256(stateAfter.resActive) + s,
                uint256(stateBefore.resActive),
                "SP-53: on-time active count changed"
            );
            eq(
                uint256(stateAfter.resTotal) + (a0 - v) + sv,
                uint256(stateBefore.resTotal),
                "SP-53: on-time reserved total != minus miner fee"
            );
            eq(
                uint256(stateAfter.fw0Count) + s,
                uint256(stateBefore.fw0Count),
                "SP-53: on-time wallet count changed"
            );
            eq(
                uint256(stateAfter.fw0Amount) + (a0 - v) + sv,
                uint256(stateBefore.fw0Amount),
                "SP-53: on-time wallet amount != minus miner fee"
            );
            if (_resProp_flowBaseSet && !stranded) {
                eq(
                    uint256(stateAfter.resTotal),
                    uint256(_resProp_flowTotalBase) + v,
                    "SP-53: flow total != total before request + anchor"
                );
            }
        } else {
            // A pending newer generation is unwound (capacity released) by a
            // late settlement of an older one.
            bool unwound = stateBefore.frActState == _resProp_AS_PENDING;
            uint256 u = unwound ? 1 : 0;
            uint256 ua = unwound ? uint256(stateBefore.frActAmount) : 0;
            eq(
                uint256(stateAfter.resActive) + u + s,
                uint256(stateBefore.resActive) + 1,
                "SP-53: late active count != +1 -unwind -strand"
            );
            eq(
                uint256(stateAfter.resTotal) + ua + sv,
                uint256(stateBefore.resTotal) + v,
                "SP-53: late reserved total != +anchor -unwind -strand"
            );
        }
    }

    /// @notice SP-54: a trusted acceptance mints the gross anchor and forwards it minus the initiation fee; an untrusted one credits the depositor's Bank balance
    function property_acceptanceCreditRouting() internal {
        LastAcceptance memory la = ghosts.lastAcceptance;
        uint256 v = la.anchorAmount;
        eq(
            stateAfter.bankTracked,
            stateBefore.bankTracked + v,
            "SP-54: Bank total did not grow by the anchor"
        );
        if (la.trustedBefore) {
            if (la.bpsBefore == type(uint16).max) return;
            uint256 gross = v * SATOSHI_MULTIPLIER;
            uint256 fee = (gross * la.bpsBefore) / 10000;
            eq(
                stateAfter.tbtcSupply,
                stateBefore.tbtcSupply + gross,
                "SP-54: TBTC supply did not grow by the gross anchor"
            );
            eq(
                stateAfter.cpTbtc,
                stateBefore.cpTbtc + gross - fee,
                "SP-54: depositor did not receive gross - fee"
            );
            eq(
                stateAfter.tbtcReservationVault,
                stateBefore.tbtcReservationVault + fee,
                "SP-54: vault did not retain the initiation fee"
            );
            eq(
                stateAfter.bankTbtcVault,
                stateBefore.bankTbtcVault + v,
                "SP-54: TBTCVault Bank balance did not grow by the anchor"
            );
            eq(
                stateAfter.bankReservationVault,
                stateBefore.bankReservationVault,
                "SP-54: ReservationVault Bank balance changed"
            );
        } else {
            eq(
                stateAfter.cpBank,
                stateBefore.cpBank + v,
                "SP-54: depositor Bank balance did not grow by the anchor"
            );
            eq(
                stateAfter.tbtcSupply,
                stateBefore.tbtcSupply,
                "SP-54: TBTC supply changed for an untrusted vault"
            );
        }
    }

    /// @notice SP-55: an acceptance proof whose preconditions hold must not revert (called only from the handler's catch path)
    function property_acceptanceProofNeverBlocked() internal {
        t(
            !_resProp_probePre,
            "SP-55: acceptance proof reverted although every precondition holds"
        );
    }

    /// @notice SP-56: a re-anchor request moves Active -> ActionPending, reserves the anchor on the target wallet only and leaves the source wallet and global counters untouched
    function property_reanchorRequestPostconditions() internal {
        eq(
            uint256(stateBefore.frState),
            uint256(_resProp_RS_ACTIVE),
            "SP-56: source position was not Active"
        );
        eq(
            uint256(stateAfter.frState),
            uint256(_resProp_RS_ACTION_PENDING),
            "SP-56: position not ActionPending"
        );
        eq(
            uint256(stateAfter.frNonce),
            uint256(stateBefore.frNonce) + 1,
            "SP-56: request nonce did not advance by one"
        );
        eq(
            uint256(stateAfter.frActState),
            uint256(_resProp_AS_PENDING),
            "SP-56: new generation not Pending"
        );
        eq(
            uint256(uint160(stateAfter.frActTarget)),
            uint256(uint160(stateAfter.fw1)),
            "SP-56: generation target != requested target"
        );
        eq(
            uint256(stateAfter.fw1Count),
            uint256(stateBefore.fw1Count) + 1,
            "SP-56: target wallet count did not grow by one"
        );
        eq(
            uint256(stateAfter.fw1Amount),
            uint256(stateBefore.fw1Amount) +
                uint256(stateBefore.frAnchorAmount),
            "SP-56: target wallet amount did not grow by the anchor"
        );
        eq(
            uint256(stateAfter.fw0Count),
            uint256(stateBefore.fw0Count),
            "SP-56: source wallet count changed"
        );
        eq(
            uint256(stateAfter.fw0Amount),
            uint256(stateBefore.fw0Amount),
            "SP-56: source wallet amount changed"
        );
        eq(
            uint256(stateAfter.resActive),
            uint256(stateBefore.resActive),
            "SP-56: active count changed"
        );
        eq(
            uint256(stateAfter.resTotal),
            uint256(stateBefore.resTotal),
            "SP-56: reserved total changed"
        );
    }

    /// @notice SP-57: a re-anchor action timeout restores Active, sets the cooldown and releases only the target wallet capacity
    function property_reanchorActionTimeoutPostconditions() internal {
        uint256 key = stateAfter.frKey;
        if (key == 0) return;
        RsReservation.ReservationAction memory act = reservationRouter
            .reservationActions(key, stateBefore.frNonce);
        eq(
            uint256(stateAfter.frState),
            uint256(_resProp_RS_ACTIVE),
            "SP-57: position not Active after the timeout"
        );
        eq(
            uint256(stateAfter.frActState),
            uint256(_resProp_AS_TIMED_OUT),
            "SP-57: generation not TimedOut"
        );
        eq(
            uint256(stateAfter.frCooldownUntil),
            block.timestamp +
                (uint256(act.timeoutAt) - uint256(act.requestedAt)),
            "SP-57: cooldown != now + (timeoutAt - requestedAt)"
        );
        eq(
            uint256(stateAfter.fw1Count) + 1,
            uint256(stateBefore.fw1Count),
            "SP-57: target wallet count did not drop by one"
        );
        eq(
            uint256(stateAfter.fw1Amount) + uint256(stateBefore.frActAmount),
            uint256(stateBefore.fw1Amount),
            "SP-57: target wallet amount did not drop by the generation amount"
        );
        eq(
            uint256(stateAfter.fw0Count),
            uint256(stateBefore.fw0Count),
            "SP-57: source wallet count changed"
        );
        eq(
            uint256(stateAfter.fw0Amount),
            uint256(stateBefore.fw0Amount),
            "SP-57: source wallet amount changed"
        );
        eq(
            uint256(stateAfter.resActive),
            uint256(stateBefore.resActive),
            "SP-57: active count changed"
        );
        eq(
            uint256(stateAfter.resTotal),
            uint256(stateBefore.resTotal),
            "SP-57: reserved total changed"
        );
    }

    /// @notice SP-58: re-anchor request + action timeout restores every wallet / global counter and puts the position back to Active under the action-timeout cooldown
    function property_reanchorTimeoutRoundTrip() internal {
        eq(
            uint256(stateAfter.fw1Count),
            uint256(stateBefore.fw1Count),
            "SP-58: target wallet count not restored"
        );
        eq(
            uint256(stateAfter.fw1Amount),
            uint256(stateBefore.fw1Amount),
            "SP-58: target wallet amount not restored"
        );
        eq(
            uint256(stateAfter.fw0Count),
            uint256(stateBefore.fw0Count),
            "SP-58: source wallet count changed"
        );
        eq(
            uint256(stateAfter.fw0Amount),
            uint256(stateBefore.fw0Amount),
            "SP-58: source wallet amount changed"
        );
        eq(
            uint256(stateAfter.resTotal),
            uint256(stateBefore.resTotal),
            "SP-58: reserved total changed"
        );
        eq(
            uint256(stateAfter.resActive),
            uint256(stateBefore.resActive),
            "SP-58: active count changed"
        );
        eq(
            uint256(stateAfter.frState),
            uint256(_resProp_RS_ACTIVE),
            "SP-58: position not Active"
        );
        eq(
            uint256(stateAfter.frCooldownUntil),
            block.timestamp + _resProp_param(_resProp_P_ACTION_TIMEOUT),
            "SP-58: cooldown != now + action timeout"
        );
    }

    /// @notice SP-59: a re-anchor proof consumes the old anchor, writes the new one down by the miner fee and moves the wallet / global capacity accordingly
    function property_reanchorProofSettlement() internal {
        uint256 key = stateAfter.frKey;
        if (key == 0) return;
        uint256 a0 = stateBefore.frAnchorAmount;
        uint256 a1 = stateAfter.frAnchorAmount;
        lte(a1, a0, "SP-59: re-anchor grew the anchor");
        uint256 f = a0 - a1;
        eq(
            uint256(stateAfter.frCumFee),
            uint256(stateBefore.frCumFee) + f,
            "SP-59: cumulativeReanchorFee != previous + miner fee"
        );
        t(
            stateAfter.frState == _resProp_RS_ACTIVE ||
                stateAfter.frState == _resProp_RS_STRANDED,
            "SP-59: settled position is neither Active nor Stranded"
        );
        t(
            stateAfter.frAnchorTxHash != stateBefore.frAnchorTxHash,
            "SP-59: anchor outpoint not replaced"
        );
        t(
            bridge.spentMainUTXOs(
                _resProp_anchorKey(stateBefore.frAnchorTxHash, 0)
            ),
            "SP-59: consumed anchor not marked spent"
        );
        eq(
            reservationRouter.reservationByAnchorUtxo(
                stateBefore.frAnchorTxHash,
                0
            ),
            0,
            "SP-59: consumed anchor still indexed"
        );
        _resProp_reanchorGlobalAccounting(f, a0, a1);
        if (!ghosts.lateFlag) {
            _resProp_reanchorWalletAccounting(f, a0, a1);
        }
    }

    function _resProp_reanchorGlobalAccounting(
        uint256 f,
        uint256 a0,
        uint256 a1
    ) internal {
        bool bs = stateBefore.frState == _resProp_RS_STRANDED;
        bool as_ = stateAfter.frState == _resProp_RS_STRANDED;
        eq(
            uint256(stateAfter.resActive) + (as_ ? 1 : 0),
            uint256(stateBefore.resActive) + (bs ? 1 : 0),
            "SP-59: active count accounting"
        );
        eq(
            uint256(stateAfter.resTotal) + f + (as_ ? a1 : 0),
            uint256(stateBefore.resTotal) + (bs ? a0 : 0),
            "SP-59: reserved total != minus miner fee"
        );
    }

    /// @dev On-time settlement: source wallet loses the old anchor, the target
    ///      wallet (reserved at request time) is written down by the fee.
    function _resProp_reanchorWalletAccounting(
        uint256 f,
        uint256 a0,
        uint256 a1
    ) internal {
        bool as_ = stateAfter.frState == _resProp_RS_STRANDED;
        eq(
            uint256(stateAfter.fw0Count) + 1,
            uint256(stateBefore.fw0Count),
            "SP-59: source wallet count did not drop by one"
        );
        eq(
            uint256(stateAfter.fw0Amount) + a0,
            uint256(stateBefore.fw0Amount),
            "SP-59: source wallet amount did not drop by the old anchor"
        );
        eq(
            uint256(stateAfter.fw1Count) + (as_ ? 1 : 0),
            uint256(stateBefore.fw1Count),
            "SP-59: target wallet count accounting"
        );
        eq(
            uint256(stateAfter.fw1Amount) + f + (as_ ? a1 : 0),
            uint256(stateBefore.fw1Amount),
            "SP-59: target wallet amount != minus miner fee"
        );
    }

    /// @notice SP-60: the in-kind fee burns min(fee, reserve) satoshi of TBTC + Bank balance from the ReservationVault and books the rest as debt
    function property_inKindFeeFinancing() internal {
        uint256 a0 = stateBefore.frAnchorAmount;
        uint256 a1 = stateAfter.frAnchorAmount;
        lte(a1, a0, "SP-60: re-anchor grew the anchor");
        uint256 f = a0 - a1;
        uint256 reserveSat =
            stateBefore.tbtcReservationVault / SATOSHI_MULTIPLIER;
        uint256 b = f < reserveSat ? f : reserveSat;
        uint256 burnWei = b * SATOSHI_MULTIPLIER;
        eq(
            stateAfter.tbtcSupply + burnWei,
            stateBefore.tbtcSupply,
            "SP-60: TBTC supply did not shrink by the burn"
        );
        eq(
            stateAfter.tbtcReservationVault + burnWei,
            stateBefore.tbtcReservationVault,
            "SP-60: vault TBTC did not shrink by the burn"
        );
        eq(
            stateAfter.bankTbtcVault + b,
            stateBefore.bankTbtcVault,
            "SP-60: TBTCVault Bank balance did not shrink by the burn"
        );
        eq(
            stateAfter.bankReservationVault,
            stateBefore.bankReservationVault,
            "SP-60: ReservationVault Bank balance changed"
        );
        eq(
            stateAfter.bankTracked + b,
            stateBefore.bankTracked,
            "SP-60: Bank total did not shrink by the burn"
        );
        eq(
            uint256(stateAfter.inKindDebtSat),
            uint256(stateBefore.inKindDebtSat) + (f - b),
            "SP-60: debt did not grow by the shortfall"
        );
    }

    /// @notice SP-61: a re-anchor proof whose preconditions hold must not revert (called only from the handler's catch path)
    function property_reanchorProofNeverBlocked() internal {
        t(
            !_resProp_probePre,
            "SP-61: re-anchor proof reverted although every precondition holds"
        );
    }

    /// @notice SP-62: after a re-anchor hop the anchor stays above the snapshotted floors and the cumulative fee within the initial anchor minus the minimum
    function property_reanchorGrindBounded() internal {
        uint256 key = stateAfter.frKey;
        if (key == 0) return;
        uint256 init = ghosts.initialAnchor[key];
        if (init == 0) return;
        RsReservation.ReservationAction memory g1 = reservationRouter
            .reservationActions(key, 1);
        gt(
            uint256(stateAfter.frAnchorAmount),
            uint256(g1.txMaxFee),
            "SP-62: anchor not above the snapshotted txMaxFee"
        );
        gt(
            uint256(stateAfter.frAnchorAmount),
            uint256(g1.minAmount),
            "SP-62: anchor not above the snapshotted minimum"
        );
        lte(
            uint256(stateAfter.frCumFee) + uint256(g1.minAmount),
            init,
            "SP-62: cumulative fee grinds below the minimum"
        );
    }

    /// @notice SP-63: stranding an Active position releases its capacity, drops the anchor index and moves no tokens
    function property_strandPostconditions() internal {
        uint256 a = stateBefore.frAnchorAmount;
        eq(
            uint256(stateBefore.frState),
            uint256(_resProp_RS_ACTIVE),
            "SP-63: stranded position was not Active"
        );
        eq(
            uint256(stateAfter.frState),
            uint256(_resProp_RS_STRANDED),
            "SP-63: position not Stranded"
        );
        eq(
            uint256(stateAfter.resActive) + 1,
            uint256(stateBefore.resActive),
            "SP-63: active count did not drop by one"
        );
        eq(
            uint256(stateAfter.resTotal) + a,
            uint256(stateBefore.resTotal),
            "SP-63: reserved total did not drop by the anchor"
        );
        eq(
            uint256(stateAfter.fw0Count) + 1,
            uint256(stateBefore.fw0Count),
            "SP-63: wallet count did not drop by one"
        );
        eq(
            uint256(stateAfter.fw0Amount) + a,
            uint256(stateBefore.fw0Amount),
            "SP-63: wallet amount did not drop by the anchor"
        );
        eq(
            reservationRouter.reservationByAnchorUtxo(
                stateBefore.frAnchorTxHash,
                0
            ),
            0,
            "SP-63: stranded anchor still indexed"
        );
        eq(
            stateAfter.tbtcSupply,
            stateBefore.tbtcSupply,
            "SP-63: TBTC supply changed"
        );
        eq(
            stateAfter.bankTracked,
            stateBefore.bankTracked,
            "SP-63: Bank balances changed"
        );
    }

    /// @notice SP-64: every Stranded position sits on a wallet that is at least Closing
    function property_strandedWalletRetired() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            if (r.state != RsReservation.ReservationState.Stranded) continue;
            gte(
                uint256(_resProp_walletState(r.walletPubKeyHash)),
                uint256(_resProp_WS_CLOSING),
                "SP-64: stranded position on a wallet that is not retired"
            );
        }
    }

    /// @notice SP-65: a Stranded position's wallet is Terminated / Closed, or Closing past the position's dissolutionEligibleAt
    function property_strandNotBeforeDissolutionEligible() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            if (r.state != RsReservation.ReservationState.Stranded) continue;
            uint8 ws = _resProp_walletState(r.walletPubKeyHash);
            t(
                ws == _resProp_WS_TERMINATED ||
                    ws == _resProp_WS_CLOSED ||
                    (ws == _resProp_WS_CLOSING &&
                        block.timestamp >= r.dissolutionEligibleAt),
                "SP-65: stranded before the dissolution eligibility time"
            );
        }
    }

    /// @notice SP-66: the edge to Stranded happens only once the wallet is Terminated / Closed, or Live past dissolutionEligibleAt (R-12), or Closing past dissolutionEligibleAt and past the wallet closing period (R-07)
    function property_strandLeavesReanchorWindow() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            if (r.state != RsReservation.ReservationState.Stranded) continue;
            if (ghosts.prevResState[keys[i]] == _resProp_RS_STRANDED) continue;
            uint8 ws = _resProp_walletState(r.walletPubKeyHash);
            bool ok = ws == _resProp_WS_TERMINATED || ws == _resProp_WS_CLOSED;
            if (!ok && ws == _resProp_WS_LIVE) {
                ok = block.timestamp >= r.dissolutionEligibleAt;
            }
            if (!ok && ws == _resProp_WS_CLOSING) {
                uint256 closingStartedAt = bridge
                    .wallets(r.walletPubKeyHash)
                    .closingStartedAt;
                (, , , , , , uint32 closingPeriod) = bridge.walletParameters();
                ok =
                    block.timestamp >= r.dissolutionEligibleAt &&
                    block.timestamp >= closingStartedAt + closingPeriod;
            }
            t(ok, "SP-66: stranded outside the release conditions");
        }
    }

    /// @notice SP-67: marking a reserved deposit stale clears its pending marker, decrements the pending counter and touches nothing else
    function property_staleReservedDepositPostconditions() internal {
        uint256 key = stateAfter.frKey;
        t(
            stateBefore.fdMarker != bytes20(0),
            "SP-67: stale deposit had no pending marker"
        );
        eq(
            uint256(uint160(stateAfter.fdMarker)),
            0,
            "SP-67: pending marker not cleared"
        );
        eq(
            uint256(stateAfter.resPendingReserved) + 1,
            uint256(stateBefore.resPendingReserved),
            "SP-67: pending reserved deposits did not drop by one"
        );
        eq(
            uint256(stateAfter.resActive),
            uint256(stateBefore.resActive),
            "SP-67: active count changed"
        );
        eq(
            uint256(stateAfter.resTotal),
            uint256(stateBefore.resTotal),
            "SP-67: reserved total changed"
        );
        eq(uint256(stateAfter.fdSweptAt), 0, "SP-67: stale deposit swept");
        t(
            bridge.isReservedDeposit(key),
            "SP-67: reserved classification cleared"
        );
    }

    /// @notice SP-68: governance can always clear pending reserved deposits and re-submit the current parameters when nothing is reserved (state-changing probe, run on a subset of secondary calls)
    function property_governanceCanClearPendingReservedDeposits() internal {
        if (_resProp_param(_resProp_P_TOTAL) == 0) {
            uint256 n = _resProp_cap(ghosts.reservedDepositKeys.length);
            for (uint256 i; i < n; i++) {
                uint256 k = ghosts.reservedDepositKeys[i];
                if (reservationRouter.reservedDepositWallet(k) == bytes20(0))
                    continue;
                RsVm.prank(governance);
                try reservationRouter.forceStaleReservedDeposit(k) {} catch {
                    t(
                        false,
                        "SP-68: governance cannot clear a pending reserved deposit"
                    );
                }
                break;
            }
        }
        if (reservationRouter.pendingReservedDeposits() == 0) {
            _resProp_resubmitParameters();
        }
    }

    /// @dev Re-submits the current parameters (vault kept) as governance:
    ///      `reservationParameters()` words 0..5 and 7..9 become the nine
    ///      `updateReservationParameters` arguments (word 6 = total is skipped).
    function _resProp_resubmitParameters() internal {
        (bool ok, bytes memory ret) = address(reservationRouter).staticcall(
            abi.encodeWithSelector(
                reservationRouter.reservationParameters.selector
            )
        );
        require(ok && ret.length >= 320, "resProp: parameters read failed");
        bytes memory data = new bytes(292);
        bytes4 sel = reservationRouter.updateReservationParameters.selector;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(add(data, 32), sel)
            for {
                let w := 0
            } lt(w, 6) {
                w := add(w, 1)
            } {
                mstore(
                    add(add(data, 36), mul(w, 32)),
                    mload(add(add(ret, 32), mul(w, 32)))
                )
            }
            for {
                let w := 7
            } lt(w, 10) {
                w := add(w, 1)
            } {
                mstore(
                    add(add(data, 36), mul(sub(w, 1), 32)),
                    mload(add(add(ret, 32), mul(w, 32)))
                )
            }
        }
        RsVm.prank(governance);
        (bool updated, ) = address(reservationRouter).call(data);
        t(
            updated,
            "SP-68: governance cannot re-submit the current reservation parameters"
        );
    }

    /// @notice SP-69: a reservation parameter / cap update never moves the counters, and changes the vault only with nothing reserved or pending
    function property_reservationParamUpdateGuards() internal {
        if (_resProp_vaultChanged) {
            eq(
                uint256(stateBefore.resTotal),
                0,
                "SP-69: vault changed with reserved capacity"
            );
            eq(
                uint256(stateBefore.resPendingReserved),
                0,
                "SP-69: vault changed with pending reserved deposits"
            );
            eq(
                uint256(stateBefore.resActive),
                0,
                "SP-69: vault changed with open positions"
            );
        }
        eq(
            uint256(stateAfter.resTotal),
            uint256(stateBefore.resTotal),
            "SP-69: update moved the reserved total"
        );
        eq(
            uint256(stateAfter.resActive),
            uint256(stateBefore.resActive),
            "SP-69: update moved the active count"
        );
        eq(
            uint256(stateAfter.resPendingReserved),
            uint256(stateBefore.resPendingReserved),
            "SP-69: update moved the pending counter"
        );
    }

    /// @notice SP-70: timeouts fire only at/after their deadline (acceptance / action: timeoutAt; stale: after the refund deadline; redemption: requestedAt + redemptionTimeout)
    function property_timeoutsNotEarly() internal {
        uint8 h = ghosts.lastHandlerId;
        if (h == HID_ACCEPTANCE_TIMEOUT || h == HID_ACTION_TIMEOUT) {
            RsReservation.ReservationAction memory a = reservationRouter
                .reservationActions(stateAfter.frKey, stateBefore.frNonce);
            gte(
                block.timestamp,
                uint256(a.timeoutAt),
                "SP-70: generation timed out before timeoutAt"
            );
            eq(
                uint256(a.state),
                uint256(_resProp_AS_TIMED_OUT),
                "SP-70: generation not TimedOut"
            );
        } else if (h == HID_STALE) {
            uint32 deadline = ghosts.refundDeadline[stateAfter.frKey];
            if (deadline != 0) {
                gt(
                    block.timestamp,
                    uint256(deadline),
                    "SP-70: deposit marked stale before its refund deadline"
                );
            }
        } else if (h == HID_NONE && stateBefore.rdRequestedAt != 0) {
            (, , , , uint32 redemptionTimeout, , ) = bridge
                .redemptionParameters();
            gte(
                block.timestamp,
                uint256(stateBefore.rdRequestedAt) + redemptionTimeout,
                "SP-70: redemption timed out early"
            );
        }
    }

    // ── Reservation shard: hub ledgers (HUB_RES) ──

    /// @notice SP-71: activeReservationsCount equals the number of open positions plus pending acceptance authorizations
    function property_activeCountLedger() internal {
        ResPropLedger memory L = _resProp_scan();
        (uint32 count, ) = reservationRouter.activeReservationsCount();
        eq(
            uint256(count),
            L.nHold + L.nPendAcc,
            "SP-71: active count != open positions + pending acceptances"
        );
    }

    /// @notice SP-72: reservationTotalAmount equals the open anchors plus the reserved capacity of pending acceptances
    function property_totalAmountLedger() internal {
        ResPropLedger memory L = _resProp_scan();
        eq(
            _resProp_param(_resProp_P_TOTAL),
            L.amtHold + L.amtPendAcc,
            "SP-72: reserved total != anchors + pending acceptances"
        );
    }

    /// @notice SP-73: per-wallet reservation count equals the wallet's open positions plus pending acceptance / re-anchor targets
    function property_walletCountLedger() internal {
        ResPropLedger memory L = _resProp_scan();
        for (uint256 i; i < L.wCount.length; i++) {
            if (!_resProp_isFirstWallet(i)) continue;
            eq(
                uint256(
                    reservationRouter.walletReservationsCount(harnessWallets[i])
                ),
                L.wCount[i],
                "SP-73: wallet reservation count != positions + pending targets"
            );
        }
    }

    /// @notice SP-74: per-wallet reserved amount equals the wallet's open anchors plus the reserved capacity of pending actions targeting it
    function property_walletAmountLedger() internal {
        ResPropLedger memory L = _resProp_scan();
        for (uint256 i; i < L.wAmount.length; i++) {
            if (!_resProp_isFirstWallet(i)) continue;
            eq(
                uint256(
                    reservationRouter.walletReservationsAmount(
                        harnessWallets[i]
                    )
                ),
                L.wAmount[i],
                "SP-74: wallet reserved amount != anchors + pending capacity"
            );
        }
    }

    /// @notice SP-75: wallet ledgers sum to the global counters plus the wallet-only capacity reserved by pending re-anchors
    function property_walletLedgerCrossSums() internal {
        ResPropLedger memory L = _resProp_scan();
        uint256 sumCount;
        uint256 sumAmount;
        for (uint256 i; i < L.wCount.length; i++) {
            if (!_resProp_isFirstWallet(i)) continue;
            sumCount += reservationRouter.walletReservationsCount(
                harnessWallets[i]
            );
            sumAmount += reservationRouter.walletReservationsAmount(
                harnessWallets[i]
            );
        }
        (uint32 active, ) = reservationRouter.activeReservationsCount();
        eq(
            sumCount,
            uint256(active) + L.nPendRe,
            "SP-75: sum of wallet counts != active + pending re-anchors"
        );
        eq(
            sumAmount,
            _resProp_param(_resProp_P_TOTAL) + L.amtPendRe,
            "SP-75: sum of wallet amounts != total + pending re-anchor capacity"
        );
    }

    /// @notice SP-76: pendingReservedDeposits equals the number of tracked reserved deposits that still carry a pending marker
    function property_pendingReservedDepositsLedger() internal {
        uint256 n = _resProp_cap(ghosts.reservedDepositKeys.length);
        uint256 pending;
        for (uint256 i; i < n; i++) {
            uint256 k = ghosts.reservedDepositKeys[i];
            if (reservationRouter.reservedDepositWallet(k) != bytes20(0)) {
                pending++;
                eq(
                    uint256(bridge.deposits(k).sweptAt),
                    0,
                    "SP-76: pending reserved deposit already swept"
                );
                eq(
                    uint256(reservationRouter.reservations(k).state),
                    uint256(_resProp_RS_UNKNOWN),
                    "SP-76: pending reserved deposit has a position"
                );
            }
        }
        eq(
            uint256(reservationRouter.pendingReservedDeposits()),
            pending,
            "SP-76: pending reserved deposits counter != markers"
        );
    }

    /// @notice SP-77: a reserved deposit is swept exactly when its reservation position exists
    function property_reservedDepositSweptIffPosition() internal {
        uint256 n = _resProp_cap(ghosts.reservedDepositKeys.length);
        for (uint256 i; i < n; i++) {
            uint256 k = ghosts.reservedDepositKeys[i];
            bool swept = bridge.deposits(k).sweptAt != 0;
            bool position =
                reservationRouter.reservations(k).state !=
                    RsReservation.ReservationState.Unknown;
            t(
                swept == position,
                "SP-77: reserved deposit swept status != position existence"
            );
        }
    }

    /// @notice SP-78: with no open position and no pending action every reservation counter is zero
    function property_reservationZeroState() internal {
        ResPropLedger memory L = _resProp_scan();
        if (L.nHold != 0 || L.nPendAcc != 0 || L.nPendRe != 0) return;
        (uint32 active, ) = reservationRouter.activeReservationsCount();
        eq(
            _resProp_param(_resProp_P_TOTAL),
            0,
            "SP-78: reserved total != 0 with no position"
        );
        eq(uint256(active), 0, "SP-78: active count != 0 with no position");
        for (uint256 i; i < L.wCount.length; i++) {
            if (!_resProp_isFirstWallet(i)) continue;
            eq(
                uint256(
                    reservationRouter.walletReservationsCount(harnessWallets[i])
                ),
                0,
                "SP-78: wallet count != 0 with no position"
            );
            eq(
                uint256(
                    reservationRouter.walletReservationsAmount(
                        harnessWallets[i]
                    )
                ),
                0,
                "SP-78: wallet amount != 0 with no position"
            );
        }
    }

    // ── Reservation shard: hub shadows (HUB_RES_STATE) ──

    /// @notice SP-79: ActionPending positions have a pending re-anchor generation; a pending generation matches the position state
    function property_reservationStateAlignment() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            RsReservation.ReservationAction memory a = reservationRouter
                .reservationActions(keys[i], r.requestNonce);
            if (r.state == RsReservation.ReservationState.ActionPending) {
                t(
                    a.actionType == RsReservation.ActionType.Reanchor &&
                        a.state == RsReservation.ActionState.Pending,
                    "SP-79: ActionPending position without a pending re-anchor"
                );
            }
            if (a.state == RsReservation.ActionState.Pending) {
                t(
                    (a.actionType == RsReservation.ActionType.Acceptance &&
                        r.state == RsReservation.ReservationState.Unknown) ||
                        (a.actionType == RsReservation.ActionType.Reanchor &&
                            r.state ==
                                RsReservation.ReservationState.ActionPending),
                    "SP-79: pending generation does not match the position state"
                );
            }
        }
    }

    /// @notice SP-80: open positions are indexed by their unspent anchor; Stranded / consumed anchors are not indexed (consumed ones are spent)
    function property_anchorIndexConsistent() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            uint256 indexed_ = reservationRouter.reservationByAnchorUtxo(
                r.anchorTxHash,
                r.anchorTxOutputIndex
            );
            if (_resProp_holds(r)) {
                eq(
                    indexed_,
                    keys[i],
                    "SP-80: open position not indexed by its anchor"
                );
                t(
                    !bridge.spentMainUTXOs(
                        _resProp_anchorKey(
                            r.anchorTxHash,
                            r.anchorTxOutputIndex
                        )
                    ),
                    "SP-80: open position anchored on a spent outpoint"
                );
            } else if (r.state == RsReservation.ReservationState.Stranded) {
                eq(indexed_, 0, "SP-80: stranded anchor still indexed");
            }
        }
        (uint256 start, uint256 size) = _resProp_window(
            ghosts.consumedAnchors.length
        );
        uint256 n = _resProp_cap(ghosts.consumedAnchors.length);
        for (uint256 j; j < size; j++) {
            uint256 ck = ghosts.consumedAnchors[(start + j) % n];
            t(bridge.spentMainUTXOs(ck), "SP-80: consumed anchor not spent");
        }
        (start, size) = _resProp_window(ghosts.honestOutpoints.length);
        n = _resProp_cap(ghosts.honestOutpoints.length);
        for (uint256 j; j < size; j++) {
            HonestOutpoint memory h = ghosts.honestOutpoints[(start + j) % n];
            if (h.kind == 2) {
                t(
                    bridge.spentMainUTXOs(
                        _resProp_anchorKey(h.txHash, h.index)
                    ),
                    "SP-80: consumed outpoint not spent"
                );
                eq(
                    reservationRouter.reservationByAnchorUtxo(
                        h.txHash,
                        h.index
                    ),
                    0,
                    "SP-80: consumed outpoint still indexed"
                );
            } else if (h.kind == 3) {
                eq(
                    reservationRouter.reservationByAnchorUtxo(
                        h.txHash,
                        h.index
                    ),
                    0,
                    "SP-80: stranded outpoint still indexed"
                );
            }
        }
    }

    /// @notice SP-81: initial anchor == current anchor + cumulative re-anchor fee, and an open position's minted amount equals its anchor
    function property_anchorLineageConserved() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            if (r.state == RsReservation.ReservationState.Unknown) continue;
            eq(
                uint256(ghosts.initialAnchor[keys[i]]),
                uint256(r.anchorAmount) + uint256(r.cumulativeReanchorFee),
                "SP-81: initial anchor != anchor + cumulative fee"
            );
            if (_resProp_holds(r)) {
                eq(
                    uint256(r.mintedAmount),
                    uint256(r.anchorAmount),
                    "SP-81: minted amount != anchor"
                );
            }
        }
    }

    /// @notice SP-82: the anchor never grows and the cumulative fee grows by exactly the anchor decrease
    function property_anchorNonIncreasingFeeAccumulates() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            if (ghosts.prevResState[keys[i]] == _resProp_RS_UNKNOWN) continue;
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            uint256 prevAnchor = ghosts.prevResAnchor[keys[i]];
            lte(uint256(r.anchorAmount), prevAnchor, "SP-82: anchor grew");
            eq(
                uint256(r.cumulativeReanchorFee) -
                    uint256(ghosts.prevResCumFee[keys[i]]),
                prevAnchor - uint256(r.anchorAmount),
                "SP-82: cumulative fee delta != anchor decrease"
            );
        }
    }

    /// @notice SP-83: the sum of cumulative re-anchor fees equals the tracked miner-fee ledger and bounds the in-kind debt
    function property_minerFeeLedger() internal {
        uint256 n = _resProp_cap(harnessReservationKeys.length);
        uint256 sum;
        for (uint256 i; i < n; i++) {
            sum += reservationRouter
                .reservations(harnessReservationKeys[i])
                .cumulativeReanchorFee;
        }
        eq(
            sum,
            ghosts.minerFeeSat,
            "SP-83: sum of cumulative fees != miner-fee ledger"
        );
        lte(
            uint256(reservationVault.inKindFeeDebtSat()),
            ghosts.minerFeeSat,
            "SP-83: in-kind debt above the miner fees paid"
        );
    }

    /// @notice SP-84: an open position sits on a wallet that is neither Unknown nor Closed and is counted in the wallet's ledgers
    function property_holdingPositionWalletConsistent() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            if (!_resProp_holds(r)) continue;
            uint8 ws = _resProp_walletState(r.walletPubKeyHash);
            t(
                ws != _resProp_WS_UNKNOWN && ws != _resProp_WS_CLOSED,
                "SP-84: open position on an Unknown / Closed wallet"
            );
            gte(
                uint256(
                    reservationRouter.walletReservationsCount(
                        r.walletPubKeyHash
                    )
                ),
                1,
                "SP-84: open position not counted on its wallet"
            );
            gte(
                uint256(
                    reservationRouter.walletReservationsAmount(
                        r.walletPubKeyHash
                    )
                ),
                uint256(r.anchorAmount),
                "SP-84: wallet amount below an open anchor"
            );
        }
    }

    /// @notice SP-85: an Active position's anchor stays above the re-anchor floor (txMaxFee + minAmount of its first generation)
    function property_activeReservationReanchorable() internal {
        if (_skipKnownFailing()) return;
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            if (r.state != RsReservation.ReservationState.Active) continue;
            RsReservation.ReservationAction memory g1 = reservationRouter
                .reservationActions(keys[i], 1);
            gt(
                uint256(r.anchorAmount),
                uint256(g1.txMaxFee) + uint256(g1.minAmount),
                "SP-85: Active anchor cannot be re-anchored (floor reached)"
            );
        }
    }

    /// @notice SP-86: reservation state transitions follow the state machine and are attributed to the executing handler
    function property_reservationStateMachine() internal {
        uint256[] memory keys = _resProp_windowKeys();
        uint8 h = ghosts.lastHandlerId;
        for (uint256 i; i < keys.length; i++) {
            uint8 cur = uint8(reservationRouter.reservations(keys[i]).state);
            t(
                cur != _resProp_RS_CLOSED,
                "SP-86: position reached Closed (no production caller)"
            );
            uint8 prev = ghosts.prevResState[keys[i]];
            if (cur == prev) continue;
            t(
                _resProp_edgeAllowed(prev, cur, h),
                "SP-86: illegal or unattributed reservation state edge"
            );
        }
    }

    function _resProp_edgeAllowed(
        uint8 prev,
        uint8 cur,
        uint8 h
    ) internal pure returns (bool) {
        if (prev == _resProp_RS_UNKNOWN) {
            return
                (cur == _resProp_RS_ACTIVE || cur == _resProp_RS_STRANDED) &&
                h == HID_ACCEPTANCE_PROOF;
        }
        if (prev == _resProp_RS_ACTIVE) {
            if (cur == _resProp_RS_ACTION_PENDING)
                return h == HID_REQUEST_REANCHOR;
            if (cur == _resProp_RS_STRANDED)
                return h == HID_STRAND || h == HID_REANCHOR_PROOF;
            return false;
        }
        if (prev == _resProp_RS_ACTION_PENDING) {
            if (cur == _resProp_RS_ACTIVE)
                return h == HID_ACTION_TIMEOUT || h == HID_REANCHOR_PROOF;
            if (cur == _resProp_RS_STRANDED) return h == HID_REANCHOR_PROOF;
            return false;
        }
        if (prev == _resProp_RS_STRANDED) {
            return cur == _resProp_RS_ACTIVE && h == HID_REANCHOR_PROOF;
        }
        return false;
    }

    /// @notice SP-87: at most one pending generation per position (the current one), legal generation transitions, never Vetoed
    function property_actionGenerationMachine() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            uint64 n = reservationRouter.reservations(keys[i]).requestNonce;
            uint64 from =
                n > FIZZ_CURSOR_STEP ? n - uint64(FIZZ_CURSOR_STEP) + 1 : 1;
            uint256 pending;
            for (uint64 g = from; g <= n; g++) {
                uint8 st = uint8(
                    reservationRouter.reservationActions(keys[i], g).state
                );
                t(st != _resProp_AS_VETOED, "SP-87: generation Vetoed");
                if (st == _resProp_AS_PENDING) {
                    pending++;
                    t(
                        g == n,
                        "SP-87: pending generation is not the current one"
                    );
                    lt(
                        uint256(
                            reservationRouter
                                .reservationActions(keys[i], g)
                                .requestedAt
                        ),
                        uint256(
                            reservationRouter
                                .reservationActions(keys[i], g)
                                .timeoutAt
                        ),
                        "SP-87: pending generation window is empty"
                    );
                }
                uint8 prev = ghosts.prevActionState[keys[i]][g];
                if (st != prev) {
                    t(
                        _resProp_actionEdgeAllowed(prev, st),
                        "SP-87: illegal generation state edge"
                    );
                }
            }
            eq(
                uint256(
                    reservationRouter.reservationActions(keys[i], n + 1).state
                ),
                uint256(_resProp_AS_UNKNOWN),
                "SP-87: next generation is not Unknown"
            );
            lte(pending, 1, "SP-87: more than one pending generation");
        }
    }

    function _resProp_actionEdgeAllowed(
        uint8 prev,
        uint8 cur
    ) internal pure returns (bool) {
        if (prev == _resProp_AS_UNKNOWN) return cur == _resProp_AS_PENDING;
        if (prev == _resProp_AS_PENDING) {
            return
                cur == _resProp_AS_SETTLED ||
                cur == _resProp_AS_TIMED_OUT ||
                cur == _resProp_AS_SUPERSEDED;
        }
        if (prev == _resProp_AS_TIMED_OUT) {
            return cur == _resProp_AS_SETTLED || cur == _resProp_AS_SUPERSEDED;
        }
        return false;
    }

    /// @notice SP-88: the request nonce only grows by one, and only in a request handler
    function property_requestNonceMonotone() internal {
        uint256[] memory keys = _resProp_windowKeys();
        uint8 h = ghosts.lastHandlerId;
        for (uint256 i; i < keys.length; i++) {
            uint256 cur = reservationRouter.reservations(keys[i]).requestNonce;
            uint256 prev = ghosts.prevNonce[keys[i]];
            if (cur == prev) continue;
            eq(
                cur,
                prev + 1,
                "SP-88: request nonce did not grow by exactly one"
            );
            t(
                h == HID_REQUEST_ACCEPTANCE || h == HID_REQUEST_REANCHOR,
                "SP-88: request nonce grew outside a request handler"
            );
        }
    }

    /// @notice SP-89: the accepted-position fields (owner, acceptedAt, expiresAt, dissolutionEligibleAt) never change after the first settlement and the owner is the depositor
    function property_acceptedFieldsFrozen() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            bytes32 image = ghosts.acceptedImageHash[keys[i]];
            if (image == bytes32(0)) continue;
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            eq(
                uint256(_resProp_acceptedImage(r)),
                uint256(image),
                "SP-89: accepted-position fields changed"
            );
            eq(
                uint256(uint160(r.owner)),
                uint256(uint160(bridge.deposits(keys[i]).depositor)),
                "SP-89: owner != depositor"
            );
        }
    }

    /// @notice SP-90: the request-time snapshot of every generation is immutable
    function property_actionSnapshotImmutable() internal {
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            uint64 n = reservationRouter.reservations(keys[i]).requestNonce;
            uint64 from =
                n > FIZZ_CURSOR_STEP ? n - uint64(FIZZ_CURSOR_STEP) + 1 : 1;
            for (uint64 g = from; g <= n; g++) {
                bytes32 image = ghosts.actionImageHash[
                    _resProp_actionImageKey(keys[i], g)
                ];
                if (image == bytes32(0)) continue;
                eq(
                    uint256(_resProp_actionImage(keys[i], g)),
                    uint256(image),
                    "SP-90: generation snapshot changed after the request"
                );
            }
        }
    }

    /// @notice SP-91: spent main-UTXO / anchor outpoints stay spent, and open positions are never anchored on a spent outpoint
    function property_spentUtxoMonotone() internal {
        (uint256 start, uint256 size) = _resProp_window(
            ghosts.knownUtxoKeys.length
        );
        uint256 n = _resProp_cap(ghosts.knownUtxoKeys.length);
        for (uint256 j; j < size; j++) {
            uint256 k = ghosts.knownUtxoKeys[(start + j) % n];
            if (ghosts.everSpent[k]) {
                t(
                    bridge.spentMainUTXOs(k),
                    "SP-91: spent outpoint became unspent"
                );
            }
        }
        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            if (_resProp_holds(r)) {
                t(
                    !bridge.spentMainUTXOs(
                        _resProp_anchorKey(
                            r.anchorTxHash,
                            r.anchorTxOutputIndex
                        )
                    ),
                    "SP-91: open position anchored on a spent outpoint"
                );
            }
        }
    }

    /// @notice SP-92: the pending-reserved and active counters move only in the handlers that may move them, by exactly one
    function property_counterDirectionalAttribution() internal {
        uint8 h = ghosts.lastHandlerId;
        int256 dP =
            int256(uint256(stateAfter.resPendingReserved)) -
                int256(uint256(stateBefore.resPendingReserved));
        int256 dC =
            int256(uint256(stateAfter.resActive)) -
                int256(uint256(stateBefore.resActive));
        if (dP > 0) {
            t(
                h == HID_REVEAL_RESERVED,
                "SP-92: pending reserved deposits grew outside a reserved reveal"
            );
            eq(
                dP,
                int256(1),
                "SP-92: pending reserved deposits grew by more than one"
            );
        } else if (dP < 0) {
            t(
                h == HID_ACCEPTANCE_PROOF ||
                    h == HID_STALE ||
                    h == HID_FORCE_STALE,
                "SP-92: pending reserved deposits dropped outside a proof / stale handler"
            );
            eq(
                dP,
                int256(-1),
                "SP-92: pending reserved deposits dropped by more than one"
            );
        }
        if (dC > 0) {
            t(
                h == HID_REQUEST_ACCEPTANCE ||
                    h == HID_ACCEPTANCE_PROOF ||
                    h == HID_REANCHOR_PROOF,
                "SP-92: active count grew outside a request / late settlement"
            );
            lte(dC, int256(1), "SP-92: active count grew by more than one");
        } else if (dC < 0) {
            t(
                h == HID_ACCEPTANCE_TIMEOUT ||
                    h == HID_STRAND ||
                    h == HID_ACCEPTANCE_PROOF ||
                    h == HID_REANCHOR_PROOF,
                "SP-92: active count dropped outside a release path"
            );
            gte(dC, int256(-1), "SP-92: active count dropped by more than one");
        }
    }

    /// @notice SP-93: in-kind debt only grows in a re-anchor proof (by at most that hop's fee), only shrinks in repay / sweepFees, and equals shortfalls - repayments - sweeps
    function property_inKindDebtAttribution() internal {
        uint8 h = ghosts.lastHandlerId;
        uint256 dB = stateBefore.inKindDebtSat;
        uint256 dA = stateAfter.inKindDebtSat;
        if (dA > dB) {
            t(
                h == HID_REANCHOR_PROOF,
                "SP-93: in-kind debt grew outside a re-anchor proof"
            );
            gte(
                uint256(stateAfter.frCumFee),
                uint256(stateBefore.frCumFee),
                "SP-93: cumulative fee decreased"
            );
            lte(
                dA - dB,
                uint256(stateAfter.frCumFee) - uint256(stateBefore.frCumFee),
                "SP-93: in-kind debt grew by more than the hop's miner fee"
            );
        } else if (dA < dB) {
            t(
                h == HID_REPAY || h == HID_SWEEP_FEES,
                "SP-93: in-kind debt shrank outside repay / sweepFees"
            );
        }
        eq(
            dA + ghosts.rvDebtRepaidSat + ghosts.rvSweepDebtBurnedSat,
            ghosts.rvShortfallSat,
            "SP-93: debt != shortfalls - repayments - sweeps"
        );
    }

    /// @notice SP-94: pending acceptance authorizations plus pending re-anchor targets never fill a Live wallet's reservation slots
    function property_fakeAcceptancesCannotHoardWalletCapacity() internal {
        ResPropLedger memory L = _resProp_scan();
        uint256 maxPerWallet = _resProp_param(_resProp_P_MAX_PER_WALLET);
        for (uint256 i; i < L.wPendAcc.length; i++) {
            if (!_resProp_isFirstWallet(i)) continue;
            if (_resProp_walletState(harnessWallets[i]) != _resProp_WS_LIVE)
                continue;
            lt(
                L.wPendAcc[i],
                maxPerWallet,
                "SP-94: pending acceptances fill a Live wallet's reservation slots"
            );
        }
    }

    // Gas forwarded to the SP-95 probe. A static call that passes the wallet guard halts on its first storage
    // write, and that halt burns ALL forwarded gas (63/64 of what is left). Uncapped, campaign 12 showed one
    // probe taking 840M of 898M gas, so under Medusa's 150M limit the next proof call ran out of gas (false
    // SP-55). The guard's refusal path is a few thousand gas (the whole delegate call up to the halt cost 2,208
    // gas in the campaign trace), so this cap leaves ample room and a refusal is never cut off.
    uint256 internal constant SP95_PROBE_GAS = 300_000;

    /// @notice SP-95: an Active position past its dissolution eligibility time on a Live wallet has a release
    ///         path: `notifyReservationStranded` passes its wallet guard. Probed with a staticcall, so no state
    ///         changes: a guard refusal returns the guard's Error(string); a call that passes the guard reverts
    ///         later on the first storage write (static context) with no matching reason.
    function property_reservationCapacityHasReleasePath() internal {
        uint256[] memory keys = _resProp_windowKeys();
        bytes32 refused = keccak256(
            abi.encodeWithSignature(
                "Error(string)",
                "Wallet is not terminated, closed, or a dissolution-eligible closing wallet"
            )
        );
        for (uint256 i; i < keys.length; i++) {
            RsReservation.ReservationRequest memory r = reservationRouter
                .reservations(keys[i]);
            if (r.state != RsReservation.ReservationState.Active) continue;
            if (block.timestamp < r.dissolutionEligibleAt) continue;
            if (_resProp_walletState(r.walletPubKeyHash) != _resProp_WS_LIVE)
                continue;
            (bool ok, bytes memory ret) = address(reservationRouter).staticcall{
                gas: SP95_PROBE_GAS
            }(
                abi.encodeWithSelector(
                    reservationRouter.notifyReservationStranded.selector,
                    keys[i]
                )
            );
            t(
                ok || keccak256(ret) != refused,
                "SP-95: dissolution-eligible position on a Live wallet has no release path"
            );
        }
    }

    /// @notice SP-96: Bitcoin liquidity (main UTXOs of Live / MovingFunds wallets + pending moved funds) covers the Bank claims net of in-kind debt, absorbed fees, open anchors (incl. those on Terminated wallets, subtracted once), Stranded anchors and the main UTXOs orphaned by retired (non-Live / non-MovingFunds) wallets and by timed-out moved-funds sweep requests (their target wallet was terminated, so no Bridge-controlled Bitcoin backs them)
    function property_poolLiquidityCoversLiabilities() internal {
        int256 pool;
        int256 orphaned;
        uint256 nw = _resProp_cap(harnessWallets.length);
        for (uint256 i; i < nw; i++) {
            if (!_resProp_isFirstWallet(i)) continue;
            bytes20 w = harnessWallets[i];
            uint8 ws = _resProp_walletState(w);
            if (ws == _resProp_WS_LIVE || ws == _resProp_WS_MOVING_FUNDS) {
                pool += int256(uint256(harnessMainUtxo[w].txOutputValue));
            } else {
                orphaned += int256(uint256(harnessMainUtxo[w].txOutputValue));
            }
        }
        uint256 nm = _resProp_cap(ghosts.movedFundsKeys.length);
        for (uint256 j; j < nm; j++) {
            uint8 sweepState = uint8(
                bridge.movedFundsSweepRequests(ghosts.movedFundsKeys[j]).state
            );
            uint256 sweepValue = uint256(
                bridge.movedFundsSweepRequests(ghosts.movedFundsKeys[j]).value
            );
            if (sweepState == 1) {
                pool += int256(sweepValue);
            } else if (sweepState == 3) {
                orphaned += int256(sweepValue);
            }
        }
        ResPropLedger memory L = _resProp_scan();
        int256 liabilities =
            int256(stateAfter.bankTracked) -
                int256(INIT_BANK_SAT) -
                int256(uint256(stateAfter.inKindDebtSat)) -
                ghosts.absorbedFeeSat -
                int256(L.amtHold) -
                int256(L.amtStranded) -
                orphaned;
        gte(
            pool,
            liabilities,
            "SP-96: pool liquidity below the Bank liabilities"
        );
    }

    // ── end Reservation shard ──

    // ── Specific: Peripheral shard (ReservationVault / RebateStaking / RedemptionWatchtower handlers) ──

    // Scratch inputs. Peripheral handlers write them right before a property
    // call and reset them afterwards; the zero-parameter properties read them.

    /// @dev Amount argument of the `repayInKindFeeDebt` call under check.
    uint64 internal _peripheral_repayRequestedSat;

    /// @dev Wallet / output script / redeemer of the objection under check.
    bytes20 internal _peripheral_vetoWallet;
    bytes internal _peripheral_vetoScript;
    address internal _peripheral_vetoRedeemer;
    /// @dev Staker whose rebate window the objection snapshots cover.
    address internal _peripheral_vetoStaker;

    /// @dev RebateStaking lifecycle operation under check:
    ///      0 none, 1 stake, 2 startUnstaking, 3 finalizeUnstaking.
    uint8 internal _peripheral_stakeOp;
    uint96 internal _peripheral_stakeArg;
    address internal _peripheral_stakeReceiver;
    uint256 internal _peripheral_stakeContractTBefore;
    uint256 internal _peripheral_stakeReceiverTBefore;

    /// @dev Rebate cap of the actor before the stake / unstake round trip.
    bool internal _peripheral_capBeforeOk;
    uint64 internal _peripheral_capBefore;

    /// @dev Stake transfer (forceStakeTransfer) under check.
    bool internal _peripheral_xferActive;
    address internal _peripheral_xferOld;
    address internal _peripheral_xferNew;
    uint96 internal _peripheral_xferOldStake;
    uint96 internal _peripheral_xferOldUnstaking;
    uint32 internal _peripheral_xferOldUnstakingTs;
    uint8 internal _peripheral_xferOldMode;

    // ――― Peripheral helpers ―――

    function _peripheral_min(
        uint256 a,
        uint256 b
    ) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @dev Mirror of `RebateStaking.getStaker`: the address whose stake is
    ///      credited with the rebate of `user`.
    function _peripheral_stakerOf(
        address user
    ) internal view returns (address) {
        address delegator = rebateStaking.delegates(user);
        if (rebateStaking.getStake(user) == 0 && delegator != address(0)) {
            return delegator;
        }
        return user;
    }

    /// @dev Sum of the Bank balances of every tracked holder (actors,
    ///      TBTCVault, ReservationVault, Bridge, treasury, watchtower).
    function _peripheral_bankTrackedNow() internal view returns (uint256 sum) {
        for (uint256 i; i < actors.length; i++) {
            sum += bank.balanceOf(actors[i]);
        }
        sum += bank.balanceOf(address(tbtcVault));
        sum += bank.balanceOf(address(reservationVault));
        sum += bank.balanceOf(address(bridge));
        sum += bank.balanceOf(treasury);
        sum += bank.balanceOf(address(redemptionWatchtower));
    }

    function _peripheral_rebateWindowStart() internal view returns (uint256) {
        uint256 window = rebateStaking.rollingWindow();
        return block.timestamp > window ? block.timestamp - window : 0;
    }

    /// @dev Refreshes `ghosts.prevRebateLen` / `ghosts.prevRebateFeeSum` of
    ///      every actor. Called by handlers AFTER the history check.
    function _peripheral_refreshRebateShadow() internal {
        for (uint256 i; i < actors.length; i++) {
            address a = actors[i];
            uint256 len = rebateStaking.getRebateLength(a);
            uint256 n = len < FIZZ_SCAN_CAP ? len : FIZZ_SCAN_CAP;
            uint256 sum;
            for (uint256 j; j < n; j++) {
                (, uint64 fee) = rebateStaking.getRebate(a, j);
                sum += fee;
            }
            ghosts.prevRebateLen[a] = len;
            ghosts.prevRebateFeeSum[a] = sum;
        }
    }

    /// @dev `snapshotBefore()` with the rebate fields (keyed on `actor`) read
    ///      for `who`.
    function _peripheral_snapshotBeforeAs(address who) internal {
        address previous = actor;
        actor = who;
        snapshotBefore();
        actor = previous;
    }

    function _peripheral_snapshotAfterAs(address who) internal {
        address previous = actor;
        actor = who;
        snapshotAfter();
        actor = previous;
    }

    /// @dev Calls `target` as `caller` with `data`; any success is a failure
    ///      of the access control under test.
    function _peripheral_mustRevert(
        address caller,
        address target,
        bytes memory data,
        string memory reason
    ) internal {
        vm.prank(caller);
        (bool ok, ) = target.call(data);
        t(!ok, reason);
    }

    // ――― Watchtower / veto ―――

    /// @notice SP-32: an objection adds exactly one objection, finalizes the veto exactly at the third one, never reopens it and bans the redeemer
    function property_vetoObjectionMachine() internal {
        uint256 key = focus.redemptionKey;
        uint256 countBefore = stateBefore.vetoObjections;
        uint256 countAfter = stateAfter.vetoObjections;
        eq(
            countAfter,
            countBefore + 1,
            "Objection did not add exactly one objection"
        );
        lte(
            countAfter,
            uint256(redemptionWatchtower.REQUIRED_OBJECTIONS_COUNT()),
            "Objections exceed the veto threshold"
        );
        t(
            (stateAfter.vetoFinalizedAt != 0) ==
                (countAfter ==
                    uint256(redemptionWatchtower.REQUIRED_OBJECTIONS_COUNT())),
            "Veto finalized iff the third objection was raised"
        );

        uint256 prevFinalizedAt = ghosts.prevVetoFinalizedAt[key];
        if (prevFinalizedAt != 0) {
            eq(
                uint256(stateAfter.vetoFinalizedAt),
                prevFinalizedAt,
                "Veto finalization time changed"
            );
            lte(
                uint256(stateAfter.vetoWithdrawable),
                uint256(ghosts.prevVetoWithdrawable[key]),
                "Veto withdrawable amount grew after finalization"
            );
        }

        if (stateAfter.vetoFinalizedAt != 0) {
            (address redeemer, , , ) = redemptionWatchtower.vetoProposals(key);
            t(
                redemptionWatchtower.isBanned(redeemer) ||
                    ghosts.unbanned[redeemer],
                "Vetoed redeemer is not banned"
            );
        }
    }

    /// @notice SP-33: a finalizing objection moves requested - penalty to the watchtower, burns the penalty and leaves requested - penalty withdrawable
    function property_vetoPenaltySplit() internal {
        if (stateBefore.vetoFinalizedAt != 0 || stateAfter.vetoFinalizedAt == 0)
            return;

        uint256 requested = stateBefore.rdRequestedAmount;
        uint256 divisor = redemptionWatchtower.vetoPenaltyFeeDivisor();
        uint256 penalty = divisor > 0 ? requested / divisor : 0;

        eq(
            stateAfter.bankWatchtower + penalty,
            stateBefore.bankWatchtower + requested,
            "Watchtower did not receive requested - penalty"
        );
        eq(
            stateAfter.bankTracked + penalty,
            stateBefore.bankTracked,
            "Veto did not burn exactly the penalty"
        );
        eq(
            stateAfter.bankBridge + requested,
            stateBefore.bankBridge,
            "Bridge did not release the whole requested amount"
        );
        eq(
            uint256(stateAfter.vetoWithdrawable),
            requested - penalty,
            "Withdrawable amount is not requested - penalty"
        );
    }

    /// @notice SP-34: withdrawing vetoed funds pays the redeemer exactly the withdrawable amount after the freeze period and zeroes it
    function property_withdrawVetoedFundsExact() internal {
        uint256 withdrawable = stateBefore.vetoWithdrawable;
        eq(
            stateAfter.cpBank,
            stateBefore.cpBank + withdrawable,
            "Redeemer Bank balance did not grow by the withdrawable amount"
        );
        eq(
            stateAfter.bankWatchtower + withdrawable,
            stateBefore.bankWatchtower,
            "Watchtower Bank balance did not drop by the withdrawable amount"
        );
        eq(
            uint256(stateAfter.vetoWithdrawable),
            0,
            "Withdrawable amount not zeroed"
        );
        gt(
            block.timestamp,
            uint256(stateBefore.vetoFinalizedAt) +
                uint256(redemptionWatchtower.vetoFreezePeriod()),
            "Withdrawal before the freeze period expired"
        );
    }

    /// @notice SP-38: a finalized veto removed the request from the Bridge and made the redemption unsafe
    function property_vetoFinalizedNotPending() internal {
        if (stateAfter.vetoFinalizedAt == 0) return;
        eq(
            uint256(stateAfter.rdRequestedAt),
            0,
            "Vetoed redemption is still pending in the Bridge"
        );
        t(
            !redemptionWatchtower.isSafeRedemption(
                _peripheral_vetoWallet,
                _peripheral_vetoScript,
                _peripheral_vetoRedeemer,
                _peripheral_vetoRedeemer
            ),
            "Vetoed redemption is still considered safe"
        );
        t(
            bridge.getRedemptionWatchtower() == address(redemptionWatchtower),
            "Bridge watchtower pointer differs from the watchtower"
        );
    }

    /// @notice SP-115: every vetoed redemption was requested by its redeemer or by a balance owner the redeemer authorized
    function property_vetoRequesterBinding() internal {
        uint256 n = ghosts.vetoKeys.length;
        if (n > FIZZ_SCAN_CAP) n = FIZZ_SCAN_CAP;
        for (uint256 i; i < n; i++) {
            uint256 key = ghosts.vetoKeys[i];
            address requester = ghosts.requesterOf[key];
            if (requester == address(0)) continue;
            (address redeemer, , , ) = redemptionWatchtower.vetoProposals(key);
            t(
                requester == redeemer ||
                    rebateStaking.rebateAuthorizations(redeemer, requester),
                "Vetoed redeemer never authorized the balance owner that requested the redemption"
            );
        }
    }

    // ――― Rebate ledger ―――

    /// @notice SP-40: cancelling a rebate (timeout / veto) removes exactly the rebate of that request from the staker's rolling window and touches nothing else
    function property_cancelRebateRestoresOwnRebate() internal {
        if (ghosts.sameBlockSecondRebate) return;
        if (
            stateBefore.rebateLen > FIZZ_SCAN_CAP ||
            stateAfter.rebateLen > FIZZ_SCAN_CAP
        ) return;

        uint256 expected;
        bool cancelled =
            stateBefore.rdRequestedAt != 0 && stateAfter.rdRequestedAt == 0;
        if (
            cancelled &&
            stateBefore.stakeAmount != 0 &&
            uint256(stateBefore.rdRequestedAt) >=
                _peripheral_rebateWindowStart()
        ) {
            expected = ghosts.rebateApplied[focus.redemptionKey];
        }
        eq(
            stateBefore.rebateWindowTotal,
            stateAfter.rebateWindowTotal + expected,
            "Rebate window total did not drop by exactly the cancelled rebate"
        );
    }

    /// @notice SP-42: the rebate entries inside the rolling window always cover the live rebate grants of the staker
    function property_rebateDoubleDipNone() internal {
        if (_skipKnownFailing()) return;
        uint256 windowStart = _peripheral_rebateWindowStart();
        uint256 grants = ghosts.rebateGrants.length;
        if (grants > FIZZ_SCAN_CAP) grants = FIZZ_SCAN_CAP;
        for (uint256 i; i < actors.length; i++) {
            address a = actors[i];
            uint256 granted;
            for (uint256 j; j < grants; j++) {
                RebateGrant storage g = ghosts.rebateGrants[j];
                if (
                    g.live &&
                    g.staker == a &&
                    uint256(g.timestamp) >= windowStart
                ) {
                    granted += g.rebate;
                }
            }
            if (granted == 0) continue;

            uint256 len = rebateStaking.getRebateLength(a);
            uint256 first = len > FIZZ_SCAN_CAP ? len - FIZZ_SCAN_CAP : 0;
            uint256 used;
            for (uint256 k = first; k < len; k++) {
                (uint32 ts, uint64 fee) = rebateStaking.getRebate(a, k);
                if (uint256(ts) >= windowStart) used += fee;
            }
            gte(
                used,
                granted,
                "Live rebate grants exceed the rebate recorded in the rolling window"
            );
        }
    }

    /// @notice SP-44: the rebate history of every actor is append-only: it never shrinks, its fee sum never grows retroactively and its timestamps never decrease
    function property_rebateHistoryAppendOnly() internal {
        for (uint256 i; i < actors.length; i++) {
            address a = actors[i];
            uint256 len = rebateStaking.getRebateLength(a);
            uint256 prevLen = ghosts.prevRebateLen[a];
            gte(len, prevLen, "Rebate history shrank");

            uint256 n = len < FIZZ_SCAN_CAP ? len : FIZZ_SCAN_CAP;
            uint256 sum;
            uint256 prevTs;
            for (uint256 j; j < n; j++) {
                (uint32 ts, uint64 fee) = rebateStaking.getRebate(a, j);
                if (j < prevLen) sum += fee;
                t(uint256(ts) >= prevTs, "Rebate timestamps decreased");
                prevTs = ts;
            }
            if (prevLen != 0) {
                lte(
                    sum,
                    ghosts.prevRebateFeeSum[a],
                    "Rebate fee of an existing entry grew"
                );
            }
        }
    }

    // ――― Staking ―――

    /// @notice SP-45: stake / startUnstaking / finalizeUnstaking move exactly the stated amounts, set the stated timestamps and respect the unstaking period
    function property_stakeLifecycleExact() internal {
        uint8 op = _peripheral_stakeOp;
        if (op == 1) {
            uint256 x = _peripheral_stakeArg;
            eq(
                uint256(stateAfter.stakeAmount),
                uint256(stateBefore.stakeAmount) + x,
                "stake: stake did not grow by the amount"
            );
            eq(
                stateAfter.actorT + x,
                stateBefore.actorT,
                "stake: actor T balance did not drop by the amount"
            );
            eq(
                tToken.balanceOf(address(rebateStaking)),
                _peripheral_stakeContractTBefore + x,
                "stake: RebateStaking T balance did not grow by the amount"
            );
            eq(
                uint256(stateAfter.unstakingAmount),
                uint256(stateBefore.unstakingAmount),
                "stake: unstaking amount changed"
            );
            eq(
                uint256(stateAfter.unstakingTs),
                uint256(stateBefore.unstakingTs),
                "stake: unstaking timestamp changed"
            );
            t(
                rebateStaking.delegates(actor) == address(0),
                "stake: incoming delegation not cleared"
            );
        } else if (op == 2) {
            eq(
                uint256(stateAfter.unstakingAmount),
                uint256(_peripheral_stakeArg),
                "startUnstaking: wrong unstaking amount"
            );
            eq(
                uint256(stateAfter.unstakingTs),
                block.timestamp,
                "startUnstaking: wrong unstaking timestamp"
            );
            eq(
                uint256(stateAfter.stakeAmount),
                uint256(stateBefore.stakeAmount),
                "startUnstaking: stake changed"
            );
            eq(
                stateAfter.actorT,
                stateBefore.actorT,
                "startUnstaking: actor T balance changed"
            );
        } else if (op == 3) {
            uint256 amount = stateBefore.unstakingAmount;
            neq(
                uint256(stateBefore.unstakingTs),
                0,
                "finalizeUnstaking: finalized without an unstaking process"
            );
            gte(
                block.timestamp,
                uint256(stateBefore.unstakingTs) +
                    rebateStaking.unstakingPeriod(),
                "finalizeUnstaking: finalized before the unstaking period elapsed"
            );
            eq(
                uint256(stateAfter.stakeAmount) + amount,
                uint256(stateBefore.stakeAmount),
                "finalizeUnstaking: stake did not drop by the unstaking amount"
            );
            eq(
                uint256(stateAfter.unstakingAmount),
                0,
                "finalizeUnstaking: unstaking amount not cleared"
            );
            eq(
                uint256(stateAfter.unstakingTs),
                0,
                "finalizeUnstaking: unstaking timestamp not cleared"
            );
            if (_peripheral_stakeReceiver != address(rebateStaking)) {
                eq(
                    tToken.balanceOf(_peripheral_stakeReceiver),
                    _peripheral_stakeReceiverTBefore + amount,
                    "finalizeUnstaking: receiver did not get the unstaked amount"
                );
                eq(
                    tToken.balanceOf(address(rebateStaking)) + amount,
                    _peripheral_stakeContractTBefore,
                    "finalizeUnstaking: RebateStaking T balance did not drop by the amount"
                );
            }
            if (stateAfter.stakeAmount == 0) {
                t(
                    rebateStaking.getDelegatee(actor) == address(0),
                    "finalizeUnstaking: delegatee kept without stake"
                );
            }
        }
    }

    /// @notice SP-46: stake(x); startUnstaking(x); wait; finalizeUnstaking leaves the actor's T balance, stake and rebate cap unchanged
    function property_stakeUnstakeRoundTrip() internal {
        eq(
            stateAfter.actorT,
            stateBefore.actorT,
            "Round trip changed the actor T balance"
        );
        eq(
            uint256(stateAfter.stakeAmount),
            uint256(stateBefore.stakeAmount),
            "Round trip changed the stake"
        );
        eq(
            uint256(stateAfter.unstakingAmount),
            uint256(stateBefore.unstakingAmount),
            "Round trip left an unstaking amount"
        );
        eq(
            uint256(stateAfter.unstakingTs),
            uint256(stateBefore.unstakingTs),
            "Round trip left an unstaking timestamp"
        );
        (bool ok, uint64 cap) = _peripheral_rebateCap(actor);
        t(
            ok == _peripheral_capBeforeOk,
            "Round trip changed whether the rebate cap is computable"
        );
        if (ok) {
            eq(
                uint256(cap),
                uint256(_peripheral_capBefore),
                "Round trip changed the rebate cap"
            );
        }
    }

    /// @dev Rebate cap of `user`; `ok` is false when the cap computation reverts (uint64 overflow).
    function _peripheral_rebateCap(
        address user
    ) internal view returns (bool ok, uint64 cap) {
        try rebateStaking.getRebateCap(user) returns (uint64 c) {
            return (true, c);
        } catch {
            return (false, 0);
        }
    }

    /// @notice SP-47: force-transferring a stake moves the whole stake image to the new staker and leaves the delegation links symmetric
    function property_stakeIdentityMoves() internal {
        if (_peripheral_xferActive) {
            address oldStaker = _peripheral_xferOld;
            address newStaker = _peripheral_xferNew;
            eq(
                uint256(rebateStaking.getStake(oldStaker)),
                0,
                "Transfer left stake on the old staker"
            );
            eq(
                uint256(rebateStaking.getStake(newStaker)),
                uint256(_peripheral_xferOldStake),
                "New staker did not receive the old stake"
            );
            (uint96 newUn, uint32 newUnTs) = rebateStaking.getUnstakingAmount(
                newStaker
            );
            eq(
                uint256(newUn),
                uint256(_peripheral_xferOldUnstaking),
                "New staker did not receive the unstaking amount"
            );
            eq(
                uint256(newUnTs),
                uint256(_peripheral_xferOldUnstakingTs),
                "New staker did not receive the unstaking timestamp"
            );
            (uint96 oldUn, uint32 oldUnTs) = rebateStaking.getUnstakingAmount(
                oldStaker
            );
            eq(
                uint256(oldUn),
                0,
                "Transfer left an unstaking amount on the old staker"
            );
            eq(
                uint256(oldUnTs),
                0,
                "Transfer left an unstaking timestamp on the old staker"
            );
            eq(
                uint256(
                    uint8(rebateStaking.getRebateTreasuryFeeMode(newStaker))
                ),
                uint256(_peripheral_xferOldMode),
                "New staker did not inherit the rebate treasury fee mode"
            );
            _peripheral_checkDelegationLinks(oldStaker);
            _peripheral_checkDelegationLinks(newStaker);
        }
        for (uint256 i; i < actors.length; i++) {
            _peripheral_checkDelegationLinks(actors[i]);
        }
    }

    function _peripheral_checkDelegationLinks(address a) internal {
        address delegatee = rebateStaking.getDelegatee(a);
        if (delegatee != address(0)) {
            t(
                rebateStaking.delegates(delegatee) == a,
                "Delegatee does not point back to its staker"
            );
        }
        address delegator = rebateStaking.delegates(a);
        if (delegator != address(0)) {
            t(
                rebateStaking.getDelegatee(delegator) == a,
                "Delegator does not point to its delegatee"
            );
        }
    }

    // ――― ReservationVault ―――

    /// @notice SP-116: repayInKindFeeDebt(a) burns exactly r = min(a, debt) satoshi of the caller's TBTC together with r satoshi of Bank balance and lowers the debt by r
    function property_repayInKindFeeDebtExact() internal {
        uint256 repaid = _peripheral_min(
            uint256(_peripheral_repayRequestedSat),
            uint256(stateBefore.inKindDebtSat)
        );
        uint256 repaidWei = repaid * SATOSHI_MULTIPLIER;
        eq(
            uint256(stateAfter.inKindDebtSat) + repaid,
            uint256(stateBefore.inKindDebtSat),
            "Debt did not drop by the repaid amount"
        );
        eq(
            stateAfter.actorTbtc + repaidWei,
            stateBefore.actorTbtc,
            "Caller TBTC did not drop by the repaid amount"
        );
        eq(
            stateAfter.tbtcSupply + repaidWei,
            stateBefore.tbtcSupply,
            "TBTC supply did not drop by the repaid amount"
        );
        eq(
            stateAfter.bankTbtcVault + repaid,
            stateBefore.bankTbtcVault,
            "TBTCVault Bank balance did not drop by the repaid amount"
        );
        eq(
            stateAfter.bankTracked + repaid,
            stateBefore.bankTracked,
            "Tracked Bank balance did not drop by the repaid amount"
        );
        eq(
            stateAfter.tbtcReservationVault,
            stateBefore.tbtcReservationVault,
            "Repay changed the vault TBTC reserve"
        );
        eq(
            stateAfter.bankReservationVault,
            stateBefore.bankReservationVault,
            "Repay changed the vault Bank balance"
        );
        eq(
            stateAfter.actorBank,
            stateBefore.actorBank,
            "Repay changed the caller Bank balance"
        );
    }

    /// @notice SP-117: a repay cycle costs the caller exactly r*1e10 TBTC, removes r from debt / supply / vault Bank balance and never raises the caller's Bank balance
    function property_repayCyclesNoProfit() internal {
        uint256 repaid = _peripheral_min(
            uint256(_peripheral_repayRequestedSat),
            uint256(stateBefore.inKindDebtSat)
        );
        uint256 repaidWei = repaid * SATOSHI_MULTIPLIER;
        eq(
            stateAfter.actorTbtc + repaidWei,
            stateBefore.actorTbtc,
            "Repay cycle did not cost exactly the repaid TBTC"
        );
        eq(
            uint256(stateAfter.inKindDebtSat) + repaid,
            uint256(stateBefore.inKindDebtSat),
            "Repay cycle debt delta differs from the repaid amount"
        );
        eq(
            stateAfter.tbtcSupply + repaidWei,
            stateBefore.tbtcSupply,
            "Repay cycle supply delta differs from the repaid TBTC"
        );
        eq(
            stateAfter.bankTbtcVault + repaid,
            stateBefore.bankTbtcVault,
            "Repay cycle Bank delta differs from the repaid amount"
        );
        lte(
            stateAfter.actorBank,
            stateBefore.actorBank,
            "Repay cycle raised the caller Bank balance"
        );
    }

    /// @notice SP-118: sweepFees first burns min(debt, reserve) satoshi against the debt, then pays out exactly the excess over the reserve target
    function property_sweepFeesExact() internal {
        address recipient = stateBefore.cp;
        uint256 reserve = stateBefore.tbtcReservationVault;
        uint256 burnedSat = _peripheral_min(
            uint256(stateBefore.inKindDebtSat),
            reserve / SATOSHI_MULTIPLIER
        );
        uint256 balance = reserve - burnedSat * SATOSHI_MULTIPLIER;
        uint256 target = stateBefore.feeReserveTarget;
        uint256 paid = balance > target ? balance - target : 0;
        // A self-transfer leaves the vault balance untouched.
        if (recipient == address(reservationVault)) paid = 0;

        eq(
            uint256(stateAfter.inKindDebtSat) + burnedSat,
            uint256(stateBefore.inKindDebtSat),
            "sweepFees: debt did not drop by the burned amount"
        );
        eq(
            stateAfter.tbtcReservationVault,
            balance - paid,
            "sweepFees: vault TBTC balance differs from balance - paid"
        );
        if (recipient != address(reservationVault)) {
            eq(
                stateAfter.cpTbtc,
                stateBefore.cpTbtc + paid,
                "sweepFees: recipient did not receive the excess"
            );
        }
        eq(
            stateAfter.tbtcSupply + burnedSat * SATOSHI_MULTIPLIER,
            stateBefore.tbtcSupply,
            "sweepFees: supply did not drop by the burned debt"
        );
        eq(
            stateAfter.bankTbtcVault + burnedSat,
            stateBefore.bankTbtcVault,
            "sweepFees: TBTCVault Bank balance did not drop by the burned debt"
        );
    }

    /// @notice SP-119: while debt is outstanding a payer with TBTC can always repay one satoshi and governance can always sweep to the treasury
    function property_inKindDebtRepairable() internal {
        if (reservationVault.inKindFeeDebtSat() == 0) return;

        for (uint256 i; i < actors.length; i++) {
            address payer = actors[i];
            if (
                tbtc.balanceOf(payer) >= SATOSHI_MULTIPLIER &&
                tbtc.allowance(payer, address(reservationVault)) >=
                    SATOSHI_MULTIPLIER &&
                bank.balanceOf(address(tbtcVault)) >= 1
            ) {
                vm.prank(payer);
                try reservationVault.repayInKindFeeDebt(1) {
                    ghosts.rvDebtRepaidSat += 1;
                    ghosts.bankBurnedSat += 1;
                } catch {
                    t(
                        false,
                        "Outstanding in-kind fee debt cannot be repaid by a payer holding TBTC"
                    );
                }
                break;
            }
        }
        _peripheral_probeSweepFees();
    }

    function _peripheral_probeSweepFees() private {
        uint256 reserve = tbtc.balanceOf(address(reservationVault));
        uint256 burnedSat = _peripheral_min(
            uint256(reservationVault.inKindFeeDebtSat()),
            reserve / SATOSHI_MULTIPLIER
        );
        // The debt burn unmints through TBTCVault, which needs the Bank balance behind it.
        if (bank.balanceOf(address(tbtcVault)) < burnedSat) return;
        uint256 balance = reserve - burnedSat * SATOSHI_MULTIPLIER;
        uint256 target = reservationVault.feeReserveTarget();
        uint256 paid = balance > target ? balance - target : 0;

        vm.prank(governance);
        try reservationVault.sweepFees(treasury) {
            ghosts.rvSweepDebtBurnedSat += burnedSat;
            ghosts.bankBurnedSat += burnedSat;
            ghosts.rvFeesSweptWei += paid;
        } catch {
            t(
                false,
                "Governance cannot sweep fees to the treasury while debt is outstanding"
            );
        }
    }

    // ――― Access control probes ―――

    /// @notice SP-112: a plain actor cannot call any Bank / TBTC / vault / staking entry point reserved for the Bridge, the Bank or governance
    function property_noPrivilegeEscalation() internal {
        uint256 supplyBefore = tbtc.totalSupply();
        uint256 bankBefore = _peripheral_bankTrackedNow();

        _peripheral_probeBankAndTokenPrivileges();
        _peripheral_probeVaultPrivileges();
        _peripheral_probeStakingPrivileges();

        eq(
            tbtc.totalSupply(),
            supplyBefore,
            "Privilege probe changed the TBTC supply"
        );
        eq(
            _peripheral_bankTrackedNow(),
            bankBefore,
            "Privilege probe changed the tracked Bank balance"
        );
    }

    function _peripheral_probeBankAndTokenPrivileges() private {
        address a = actor;
        address[] memory recipients = new address[](1);
        recipients[0] = a;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;

        _peripheral_mustRevert(
            a,
            address(bank),
            abi.encodeWithSelector(
                bank.increaseBalance.selector,
                a,
                uint256(1)
            ),
            "Bank.increaseBalance callable by a non-Bridge"
        );
        _peripheral_mustRevert(
            a,
            address(bank),
            abi.encodeWithSelector(
                bank.increaseBalances.selector,
                recipients,
                amounts
            ),
            "Bank.increaseBalances callable by a non-Bridge"
        );
        _peripheral_mustRevert(
            a,
            address(bank),
            abi.encodeWithSelector(
                bank.increaseBalanceAndCall.selector,
                address(reservationVault),
                recipients,
                amounts
            ),
            "Bank.increaseBalanceAndCall callable by a non-Bridge"
        );
        _peripheral_mustRevert(
            a,
            address(tbtc),
            abi.encodeWithSelector(tbtc.mint.selector, a, uint256(1)),
            "TBTC.mint callable by a non-owner"
        );
        _peripheral_mustRevert(
            a,
            address(tbtc),
            abi.encodeWithSelector(tbtc.transferOwnership.selector, a),
            "TBTC.transferOwnership callable by a non-owner"
        );
        _peripheral_mustRevert(
            a,
            address(bank),
            abi.encodeWithSelector(bank.updateBridge.selector, a),
            "Bank.updateBridge callable by a non-owner"
        );
    }

    function _peripheral_probeVaultPrivileges() private {
        address a = actor;
        address[] memory recipients = new address[](1);
        recipients[0] = a;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1;
        address rv = address(reservationVault);

        _peripheral_mustRevert(
            a,
            rv,
            abi.encodeWithSelector(
                reservationVault.receiveBalanceIncrease.selector,
                recipients,
                amounts
            ),
            "ReservationVault.receiveBalanceIncrease callable by a non-Bank"
        );
        _peripheral_mustRevert(
            a,
            rv,
            abi.encodeWithSelector(
                reservationVault.financeInKindFee.selector,
                uint64(1)
            ),
            "ReservationVault.financeInKindFee callable by a non-Bridge"
        );
        _peripheral_mustRevert(
            a,
            rv,
            abi.encodeWithSelector(reservationVault.sweepFees.selector, a),
            "ReservationVault.sweepFees callable by a non-owner"
        );
        _peripheral_mustRevert(
            a,
            rv,
            abi.encodeWithSelector(
                reservationVault.updateInitiationFee.selector,
                uint16(0)
            ),
            "ReservationVault.updateInitiationFee callable by a non-owner"
        );
        _peripheral_mustRevert(
            a,
            rv,
            abi.encodeWithSelector(
                reservationVault.updateFeeReserveTarget.selector,
                uint256(0)
            ),
            "ReservationVault.updateFeeReserveTarget callable by a non-owner"
        );
        _peripheral_mustRevert(
            a,
            address(tbtcVault),
            abi.encodeWithSelector(tbtcVault.addMinter.selector, a),
            "TBTCVault.addMinter callable by a non-owner"
        );
        _peripheral_mustRevert(
            a,
            address(tbtcVault),
            abi.encodeWithSelector(tbtcVault.initiateUpgrade.selector, a),
            "TBTCVault.initiateUpgrade callable by a non-owner"
        );
    }

    function _peripheral_probeStakingPrivileges() private {
        address a = actor;
        address rs = address(rebateStaking);

        _peripheral_mustRevert(
            a,
            rs,
            abi.encodeWithSelector(
                rebateStaking.applyForRebate.selector,
                a,
                uint64(1),
                uint8(0)
            ),
            "RebateStaking.applyForRebate callable by a non-Bridge"
        );
        _peripheral_mustRevert(
            a,
            rs,
            abi.encodeWithSelector(
                rebateStaking.cancelRebate.selector,
                a,
                uint256(1)
            ),
            "RebateStaking.cancelRebate callable by a non-Bridge"
        );
        _peripheral_mustRevert(
            a,
            rs,
            abi.encodeWithSelector(
                rebateStaking.forceStakeTransfer.selector,
                a,
                address(1)
            ),
            "RebateStaking.forceStakeTransfer callable by a non-owner"
        );
        _peripheral_mustRevert(
            a,
            rs,
            abi.encodeWithSelector(
                rebateStaking.updateRebatePerToken.selector,
                uint256(0)
            ),
            "RebateStaking.updateRebatePerToken callable by a non-owner"
        );
        _peripheral_mustRevert(
            a,
            rs,
            abi.encodeWithSelector(
                rebateStaking.updateRollingWindow.selector,
                uint256(1)
            ),
            "RebateStaking.updateRollingWindow callable by a non-owner"
        );
        _peripheral_mustRevert(
            a,
            rs,
            abi.encodeWithSelector(
                rebateStaking.updateUnstakingPeriod.selector,
                uint256(0)
            ),
            "RebateStaking.updateUnstakingPeriod callable by a non-owner"
        );
    }

    /// @notice SP-113: a plain actor cannot call the SPV-maintainer, governance, watchtower-only and depositor-only lifecycle entry points
    function property_lifecycleRolesEnforced() internal {
        _peripheral_probeRouterRoles();
        _peripheral_probeBridgeGovernance();
        _peripheral_probeReservationOwnership();
    }

    function _peripheral_probeRouterRoles() private {
        address a = actor;
        address router = address(reservationRouter);
        PeBitcoinTx.Info memory info;
        PeBitcoinTx.Proof memory proof;

        _peripheral_mustRevert(
            a,
            router,
            abi.encodeWithSelector(
                reservationRouter.submitReservationAcceptanceProof.selector,
                info,
                proof,
                uint256(0),
                uint64(0)
            ),
            "submitReservationAcceptanceProof succeeded for a plain actor"
        );
        _peripheral_mustRevert(
            a,
            router,
            abi.encodeWithSelector(
                reservationRouter.submitReservationReanchorProof.selector,
                info,
                proof,
                uint256(0),
                uint64(0)
            ),
            "submitReservationReanchorProof succeeded for a plain actor"
        );
        _peripheral_mustRevert(
            a,
            router,
            abi.encodeWithSelector(
                reservationRouter.updateReservationCaps.selector,
                uint64(1),
                uint64(1),
                uint32(1)
            ),
            "updateReservationCaps callable by a non-governance caller"
        );
        _peripheral_mustRevert(
            a,
            router,
            abi.encodeWithSelector(
                reservationRouter.forceStaleReservedDeposit.selector,
                uint256(0)
            ),
            "forceStaleReservedDeposit callable by a non-governance caller"
        );
        _peripheral_probeUpdateReservationParameters(a, router);
    }

    function _peripheral_probeUpdateReservationParameters(
        address caller,
        address router
    ) private {
        bytes memory data = abi.encodeWithSelector(
            reservationRouter.updateReservationParameters.selector,
            address(0),
            uint64(0),
            uint64(0),
            uint32(0),
            uint32(0),
            uint64(0),
            uint32(0),
            uint32(0),
            uint32(0)
        );
        _peripheral_mustRevert(
            caller,
            router,
            data,
            "updateReservationParameters callable by a non-governance caller"
        );
    }

    function _peripheral_probeBridgeGovernance() private {
        address a = actor;
        address b = address(bridge);

        _peripheral_mustRevert(
            a,
            b,
            abi.encodeWithSelector(bridge.setVaultStatus.selector, a, true),
            "Bridge.setVaultStatus callable by a non-governance caller"
        );
        _peripheral_mustRevert(
            a,
            b,
            abi.encodeWithSelector(
                bridge.setSpvMaintainerStatus.selector,
                a,
                true
            ),
            "Bridge.setSpvMaintainerStatus callable by a non-governance caller"
        );
        _peripheral_mustRevert(
            a,
            b,
            abi.encodeWithSelector(bridge.setRebateStaking.selector, a),
            "Bridge.setRebateStaking callable by a non-governance caller"
        );
        _peripheral_mustRevert(
            a,
            b,
            abi.encodeWithSelector(bridge.setRedemptionWatchtower.selector, a),
            "Bridge.setRedemptionWatchtower callable by a non-governance caller"
        );
        _peripheral_mustRevert(
            a,
            b,
            abi.encodeWithSelector(
                bridge.notifyRedemptionVeto.selector,
                bytes20(0),
                bytes("")
            ),
            "Bridge.notifyRedemptionVeto callable by a non-watchtower caller"
        );
    }

    /// @dev Depositor-only acceptance requests and governance-only rotation of a Live wallet's anchor.
    function _peripheral_probeReservationOwnership() private {
        address a = actor;
        address router = address(reservationRouter);
        uint256 start = block.timestamp;

        uint256 deposits = harnessDeposits.length;
        uint256 limit =
            deposits < FIZZ_CURSOR_STEP ? deposits : FIZZ_CURSOR_STEP;
        for (uint256 n; n < limit; n++) {
            HarnessDeposit storage d = harnessDeposits[(start + n) % deposits];
            if (!d.reserved || d.swept || d.depositor == a) continue;
            // A valid funding proof, so the probe reaches the depositor check
            // instead of failing on the proof (R-01 router check runs first).
            HarnessFunding storage f = harnessDepositFundings[
                uint256(
                    keccak256(abi.encodePacked(d.fundingTxHash, d.outputIndex))
                )
            ];
            if (f.info.inputVector.length == 0) continue;
            PeBitcoinTx.Proof memory fundingProof = PeBtcBuilder.prove(
                f.info,
                1
            );
            _peripheral_mustRevert(
                a,
                router,
                abi.encodeWithSelector(
                    reservationRouter.requestReservationAcceptance.selector,
                    f.info,
                    fundingProof,
                    d.outputIndex,
                    d.walletPkh
                ),
                "requestReservationAcceptance succeeded for a caller that is not the depositor"
            );
            break;
        }

        uint256 keys = harnessReservationKeys.length;
        limit = keys < FIZZ_CURSOR_STEP ? keys : FIZZ_CURSOR_STEP;
        for (uint256 n; n < limit; n++) {
            uint256 key = harnessReservationKeys[(start + n) % keys];
            // 1 == Reservation.ReservationState.Active, 1 == Wallets.WalletState.Live.
            if (uint8(reservationRouter.reservations(key).state) != 1) continue;
            if (
                uint8(
                    bridge
                        .wallets(
                            reservationRouter.reservations(key).walletPubKeyHash
                        )
                        .state
                ) != 1
            ) continue;
            _peripheral_mustRevert(
                a,
                router,
                abi.encodeWithSelector(
                    reservationRouter.requestReservationReanchor.selector,
                    key,
                    bytes20(0)
                ),
                "requestReservationReanchor rotated a Live wallet's anchor for a non-governance caller"
            );
            break;
        }
    }

    /// @notice SP-114: a plain actor cannot use guardian, manager, owner or minter powers of the watchtower and of the optimistic minting module
    function property_guardianMinterPowersGated() internal {
        address a = actor;
        address rw = address(redemptionWatchtower);

        if (!redemptionWatchtower.isGuardian(a)) {
            _peripheral_mustRevert(
                a,
                rw,
                abi.encodeWithSelector(
                    redemptionWatchtower.raiseObjection.selector,
                    bytes20(0),
                    bytes("")
                ),
                "raiseObjection succeeded for a non-guardian"
            );
        }
        if (a != redemptionWatchtower.manager()) {
            _peripheral_mustRevert(
                a,
                rw,
                abi.encodeWithSelector(
                    redemptionWatchtower.addGuardian.selector,
                    a
                ),
                "addGuardian callable by a non-manager"
            );
            _peripheral_mustRevert(
                a,
                rw,
                abi.encodeWithSelector(redemptionWatchtower.unban.selector, a),
                "unban callable by a non-manager"
            );
            _peripheral_probeWatchtowerParams(a, rw);
        }
        if (a != redemptionWatchtower.owner()) {
            _peripheral_mustRevert(
                a,
                rw,
                abi.encodeWithSelector(
                    redemptionWatchtower.removeGuardian.selector,
                    guardians[0]
                ),
                "removeGuardian callable by a non-owner"
            );
        }

        address tv = address(tbtcVault);
        if (!tbtcVault.isMinter(a)) {
            _peripheral_mustRevert(
                a,
                tv,
                abi.encodeWithSelector(
                    tbtcVault.requestOptimisticMint.selector,
                    bytes32(0),
                    uint32(0)
                ),
                "requestOptimisticMint succeeded for a non-minter"
            );
            _peripheral_mustRevert(
                a,
                tv,
                abi.encodeWithSelector(
                    tbtcVault.finalizeOptimisticMint.selector,
                    bytes32(0),
                    uint32(0)
                ),
                "finalizeOptimisticMint succeeded for a non-minter"
            );
        }
        if (!tbtcVault.isGuardian(a)) {
            _peripheral_mustRevert(
                a,
                tv,
                abi.encodeWithSelector(
                    tbtcVault.cancelOptimisticMint.selector,
                    bytes32(0),
                    uint32(0)
                ),
                "cancelOptimisticMint succeeded for a non-guardian"
            );
        }
    }

    function _peripheral_probeWatchtowerParams(
        address caller,
        address target
    ) private {
        bytes memory data = abi.encodeWithSelector(
            redemptionWatchtower.updateWatchtowerParameters.selector,
            uint32(1),
            uint64(0),
            uint32(0),
            uint32(0),
            uint32(0),
            uint32(0),
            uint64(0)
        );
        _peripheral_mustRevert(
            caller,
            target,
            data,
            "updateWatchtowerParameters callable by a non-manager"
        );
    }

    // ── end Peripheral shard ──
}
