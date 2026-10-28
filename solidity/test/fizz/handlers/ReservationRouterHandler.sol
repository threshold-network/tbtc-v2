// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";
import {Deposit} from "../../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../../contracts/bridge/Reservation.sol";
import {Wallets} from "../../../contracts/bridge/Wallets.sol";

/// @notice Handles the interaction with ReservationRouter (called through the
///         Bridge address, see `Base.reservationRouter`).
///
/// @dev Reservation lifecycle driven by this file:
///
///      1. `revealReservedDeposit*`   Bridge.revealDeposit with
///                                    `reveal.vault = reservationVault`.
///                                    Recorded `reserved = true`.
///      2. `requestReservationAcceptance`   by the deposit's depositor; the
///                                    reservation key (= deposit key) is
///                                    recorded once via `_recordReservation`.
///      3. `submitReservationAcceptanceProof`   anchor tx: 1 input (the
///                                    deposit outpoint), 1 output (the
///                                    designated wallet, fee <= txMaxFee).
///                                    Marks the harness deposit swept and
///                                    tracks the anchor outpoint.
///      4. `requestReservationReanchor` / `submitReservationReanchorProof`
///                                    anchor tx: 1 input (current anchor),
///                                    1 output (target wallet). The miner
///                                    fee drives `financeInKindFee`.
///      5. Failure paths: acceptance / action timeouts, stranding, stale
///                                    reserved deposits.
///
///      Timing: the reserved reveal requires `500M <= refundLocktime <=
///      now + reservationTermSeconds + 24h`, which is unsatisfiable while
///      `block.timestamp` is near zero (fuzzer start), so the reveal helper
///      warps once to `reservationRouter_ERA_START` when needed.
abstract contract ReservationRouterHandler is Properties {
    // ―――――――――――――――――――――――――― State ――――――――――――――――――――――――――――

    /// @dev First timestamp at which a reserved deposit with a valid refund
    ///      locktime (>= 500M) can be revealed.
    uint256 internal constant reservationRouter_ERA_START = 500_000_000;

    // Deposit pickers (over `harnessDeposits`).
    /// @dev Reserved, unswept, pending marker set, no acceptance in flight,
    ///      designated wallet Live, request still fits before refund window.
    uint8 internal constant reservationRouter_DEP_REQUESTABLE = 0;
    /// @dev Reserved, unswept, pending marker set, no acceptance in flight.
    uint8 internal constant reservationRouter_DEP_PENDING = 1;
    /// @dev DEP_PENDING and the refund deadline has elapsed.
    uint8 internal constant reservationRouter_DEP_STALE_READY = 2;

    // Reservation pickers (over `harnessReservationKeys`).
    uint8 internal constant reservationRouter_RES_ACCEPT_TIMEOUT_READY = 0;
    uint8 internal constant reservationRouter_RES_ACCEPT_SETTLEABLE = 1;
    uint8 internal constant reservationRouter_RES_ACTIVE = 2;
    uint8 internal constant reservationRouter_RES_ACTION_TIMEOUT_READY = 3;
    uint8 internal constant reservationRouter_RES_STRANDABLE = 4;
    uint8 internal constant reservationRouter_RES_REANCHOR_SETTLEABLE = 5;

    // Miner fee modes of anchor transactions.
    uint8 internal constant reservationRouter_FEE_RANDOM = 0;
    uint8 internal constant reservationRouter_FEE_ZERO = 1;
    uint8 internal constant reservationRouter_FEE_MAX = 2;
    uint8 internal constant reservationRouter_FEE_OVER_MAX = 3;

    // Word indexes of `reservationParameters()` return values.
    uint256 internal constant reservationRouter_P_VAULT = 0;
    uint256 internal constant reservationRouter_P_MIN_AMOUNT = 1;
    uint256 internal constant reservationRouter_P_TX_MAX_FEE = 2;
    uint256 internal constant reservationRouter_P_MAX_PER_WALLET = 7;
    uint256 internal constant reservationRouter_P_ACTION_TIMEOUT = 8;
    uint256 internal constant reservationRouter_P_MAX_TOTAL = 5;

    /// @dev Current anchor outpoint of a reservation, as last settled by one
    ///      of this file's proof handlers (mirror of
    ///      `reservations(key).anchor*`, kept for Step 9 properties).
    struct reservationRouter_Anchor {
        bytes32 txHash;
        uint32 outputIndex;
        uint64 amount;
        bytes20 walletPkh;
    }

    /// @dev Reservation key => current anchor. `txHash == 0` until the first
    ///      acceptance (or re-anchor) proof of the key succeeded.
    mapping(uint256 => reservationRouter_Anchor)
        internal reservationRouter_anchors;
    /// @dev Reservation keys already pushed to `harnessReservationKeys`.
    mapping(uint256 => bool) internal reservationRouter_keyRecorded;
    /// @dev Deposit key => exact refund deadline (BTC locktime) baked into
    ///      the deposit script at reveal. Zero for deposits not revealed here.
    mapping(uint256 => uint32) internal reservationRouter_refundDeadline;
    /// @dev Deposit key => index in `harnessDeposits` plus one.
    mapping(uint256 => uint256) internal reservationRouter_depositIndexPlusOne;
    /// @dev Monotonic counter making funding tx hashes unique.
    uint256 internal reservationRouter_revealCount;

    /// @dev Memory bag for the reveal helper (keeps stack depth small).
    struct reservationRouter_RevealCtx {
        uint64 amount;
        bytes20 wallet;
        address vault;
        address depositor;
        uint256 locktime;
        bytes32 entropy;
    }

    /// @dev Memory bag for `updateReservationParameters` arguments.
    struct reservationRouter_Params {
        address vault;
        uint64 minAmount;
        uint64 txMaxFee;
        uint32 term;
        uint32 dissolutionDelay;
        uint64 maxTotal;
        uint32 maxPerWallet;
        uint32 actionTimeout;
        uint32 renewalWindow;
    }

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    // ――― 1. Reserved deposit reveal ―――

    /// @dev Reveals a reserved deposit of `actor` to a Live wallet. Amount is
    ///      clamped to [minAmount + txMaxFee, reservationMaxSingleAmount],
    ///      the refund locktime to a window satisfying the reveal-ahead
    ///      period and the reserved cap (`now + term + 24h`), biased towards
    ///      deadlines that still leave room for an acceptance request.
    function reservationRouter_revealReservedDeposit(
        uint256 amountSeed,
        uint256 walletSeed,
        uint256 refundSeed,
        uint256 entropySeed
    ) public {
        (uint64 lo, uint64 hi) = _reservationRouter_amountBounds();
        if (hi < lo) return;
        uint64 amount = uint64(_reservationRouter_between(amountSeed, lo, hi));

        (bool ok, uint256 delta) = _reservationRouter_refundDelta(refundSeed);
        if (!ok) return;

        _reservationRouter_reveal(
            amount,
            walletSeed,
            delta,
            entropySeed,
            false
        );
    }

    /// @dev Amount boundary stress: `which % 4` = 0 minimum acceptable
    ///      (minAmount + txMaxFee), 1 single-reservation cap, 2 one satoshi
    ///      below the minimum (request must reject), 3 one satoshi above the
    ///      single cap (request must reject).
    function reservationRouter_revealReservedDeposit_boundaryAmount(
        uint8 which,
        uint256 walletSeed,
        uint256 refundSeed,
        uint256 entropySeed
    ) public {
        (uint64 lo, uint64 hi) = _reservationRouter_amountBounds();
        if (hi < lo) return;

        uint256 amount;
        which = uint8(which % 4);
        if (which == 0) amount = lo;
        else if (which == 1) amount = hi;
        else if (which == 2) amount = lo > 0 ? uint256(lo) - 1 : 0;
        else amount = uint256(hi) + 1;
        if (amount > type(uint64).max) return;

        (bool ok, uint256 delta) = _reservationRouter_refundDelta(refundSeed);
        if (!ok) return;

        _reservationRouter_reveal(
            uint64(amount),
            walletSeed,
            delta,
            entropySeed,
            false
        );
    }

    /// @dev Refund locktime boundary stress: `which % 4` = 0 exactly the
    ///      reveal-ahead period, 1 the smallest deadline still leaving a
    ///      request window (actionTimeout + 24h), 2 the reserved cap
    ///      (`term + 24h`), 3 one second beyond the cap (reveal must reject).
    function reservationRouter_revealReservedDeposit_boundaryRefund(
        uint8 which,
        uint256 amountSeed,
        uint256 walletSeed,
        uint256 entropySeed
    ) public {
        (uint64 lo, uint64 hi) = _reservationRouter_amountBounds();
        if (hi < lo) return;
        uint64 amount = uint64(_reservationRouter_between(amountSeed, lo, hi));

        (
            uint256 ahead,
            uint256 minDelta,
            uint256 maxDelta
        ) = _reservationRouter_refundBounds();
        uint256 delta;
        which = uint8(which % 4);
        if (which == 0) delta = ahead;
        else if (which == 1) delta = minDelta;
        else if (which == 2) delta = maxDelta;
        else delta = maxDelta + 1;

        _reservationRouter_reveal(
            amount,
            walletSeed,
            delta,
            entropySeed,
            false
        );
    }

    // ――― 2. Acceptance request ―――

    /// @dev Requests acceptance for a recorded reserved deposit, as its
    ///      depositor, towards the deposit's designated wallet. Records the
    ///      reservation key on success.
    function reservationRouter_requestReservationAcceptance_clamped(
        uint256 depositSeed
    ) public {
        (bool found, uint256 idx) = _reservationRouter_pickDeposit(
            depositSeed,
            reservationRouter_DEP_REQUESTABLE
        );
        if (!found) return;
        _reservationRouter_requestAcceptance(idx);
    }

    /// @dev R-01 negative check. Calls `requestReservationAcceptance` with the funding tx of a
    ///      requestable deposit and an SPV proof built for a different transaction (the locktime is
    ///      changed, so the hash differs). The proof is well formed and passes the harness relay, but
    ///      it does not cover the funding tx, so the router must reject the request. A router that
    ///      skips `BitcoinTx.validateProof` accepts it and the assertion fires.
    function reservationRouter_requestReservationAcceptance_mismatchedProof(
        uint256 depositSeed,
        uint256 tamperSeed
    ) public {
        (bool found, uint256 idx) = _reservationRouter_pickDeposit(
            depositSeed,
            reservationRouter_DEP_REQUESTABLE
        );
        if (!found) return;
        uint256 key = _reservationRouter_keyOf(idx);
        HarnessFunding storage funding = harnessDepositFundings[key];
        if (funding.info.inputVector.length == 0) return;

        BitcoinTx.Info memory info = funding.info;
        BitcoinTx.Info memory other = funding.info;
        other.locktime = bytes4(
            uint32(other.locktime) ^ uint32(1 + (tamperSeed % 0xFFFFFFFE))
        );
        BitcoinTx.Proof memory proof = BtcBuilder.prove(other, 1);

        bytes20 wallet = reservationRouter.reservedDepositWallet(key);
        vm.prank(harnessDeposits[idx].depositor);
        try
            reservationRouter.requestReservationAcceptance(
                info,
                proof,
                funding.outputIndex,
                wallet
            )
        {
            t(
                false,
                "R-01: acceptance requested with an SPV proof that does not cover the funding tx"
            );
        } catch {}
    }

    // ――― 3. Acceptance proof ―――

    /// @dev Settles a pending (or timed-out = late) acceptance generation of a
    ///      recorded reservation with an anchor tx whose miner fee is within
    ///      the generation's snapshotted txMaxFee.
    function reservationRouter_submitReservationAcceptanceProof_clamped(
        uint256 reservationSeed,
        uint256 feeSeed,
        uint256 nonceSeed
    ) public {
        _reservationRouter_acceptanceProof(
            reservationSeed,
            nonceSeed,
            reservationRouter_FEE_RANDOM,
            feeSeed
        );
    }

    /// @dev Miner fee 0: the anchor keeps the full deposit amount.
    function reservationRouter_submitReservationAcceptanceProof_zeroFee(
        uint256 reservationSeed,
        uint256 nonceSeed
    ) public {
        _reservationRouter_acceptanceProof(
            reservationSeed,
            nonceSeed,
            reservationRouter_FEE_ZERO,
            0
        );
    }

    /// @dev Miner fee exactly txMaxFee: the anchor sits exactly at the
    ///      minimum reservation amount (deposit == minAmount + txMaxFee).
    function reservationRouter_submitReservationAcceptanceProof_maxFee(
        uint256 reservationSeed,
        uint256 nonceSeed
    ) public {
        _reservationRouter_acceptanceProof(
            reservationSeed,
            nonceSeed,
            reservationRouter_FEE_MAX,
            0
        );
    }

    /// @dev Miner fee txMaxFee + 1: must be rejected ("fee is too high").
    function reservationRouter_submitReservationAcceptanceProof_overMaxFee(
        uint256 reservationSeed,
        uint256 nonceSeed
    ) public {
        _reservationRouter_acceptanceProof(
            reservationSeed,
            nonceSeed,
            reservationRouter_FEE_OVER_MAX,
            0
        );
    }

    // ――― Flows (same-timestamp lifecycle in one call) ―――

    /// @dev Request + prove acceptance of a requestable reserved deposit in
    ///      one call: guarantees the request, anchor spend and proof happen
    ///      inside the action timeout window.
    function reservationRouter_acceptReservedDeposit_flow(
        uint256 depositSeed,
        uint256 feeSeed
    ) public {
        (bool found, uint256 idx) = _reservationRouter_pickDeposit(
            depositSeed,
            reservationRouter_DEP_REQUESTABLE
        );
        if (!found) return;
        (uint256 key, uint64 nonce) = _reservationRouter_flowRequest(idx);
        if (nonce != 0)
            _reservationRouter_acceptance(
                key,
                nonce,
                reservationRouter_FEE_RANDOM,
                feeSeed
            );
        _resProp_flowBaseSet = false;
    }

    /// @dev Reveal + request + prove in one call (fresh, fully active
    ///      reservation). Amount clamped to the acceptable range, refund
    ///      locktime to a window that leaves a request window.
    function reservationRouter_revealAndAcceptReservedDeposit_flow(
        uint256 amountSeed,
        uint256 walletSeed,
        uint256 entropySeed,
        uint256 feeSeed
    ) public {
        (bool ok, uint256 idx) = _reservationRouter_flowReveal(
            amountSeed,
            walletSeed,
            entropySeed
        );
        if (!ok) return;
        (uint256 key, uint64 nonce) = _reservationRouter_flowRequest(idx);
        if (nonce != 0)
            _reservationRouter_acceptance(
                key,
                nonce,
                reservationRouter_FEE_RANDOM,
                feeSeed
            );
        _resProp_flowBaseSet = false;
    }

    /// @dev Two reserved deposits designated to the SAME Live wallet: reveal
    ///      both, request both acceptances (two pending marker slots), then
    ///      settle exactly one with a late acceptance proof. Leaves the
    ///      wallet with one settled + one pending reservation, the state
    ///      the multi-slot mutants (M-200/M-207/M-208) need.
    function reservationRouter_twoPendingOneWallet_flow(
        uint256 amountSeed,
        uint256 walletSeed,
        uint256 entropySeed,
        uint256 feeSeed
    ) public {
        uint256 idx1;
        uint256 idx2;
        {
            (bool ok1, uint256 i1) = _reservationRouter_flowReveal(
                amountSeed,
                walletSeed,
                entropySeed
            );
            if (!ok1) return;
            idx1 = i1;
            bytes20 shared = reservationRouter.reservedDepositWallet(
                _reservationRouter_keyOf(idx1)
            );
            uint64 amt;
            {
                (uint64 loB, uint64 hiB) = _reservationRouter_amountBounds();
                amt = uint64(
                    _reservationRouter_between(amountSeed / 8, loB, hiB)
                );
            }
            (, uint256 delta2) = _reservationRouter_refundDelta(entropySeed);
            (bool ok2, uint256 i2) = _reservationRouter_reveal(
                amt,
                walletSeed,
                delta2,
                entropySeed,
                true
            );
            if (
                !ok2 ||
                shared == bytes20(0) ||
                reservationRouter.reservedDepositWallet(
                    _reservationRouter_keyOf(i2)
                ) !=
                    shared
            ) return;
            idx2 = i2;
        }
        (, uint64 n1) = _reservationRouter_flowRequest(idx1);
        (, uint64 n2) = _reservationRouter_flowRequest(idx2);
        if (n1 == 0 || n2 == 0) return;
        _resProp_flowBaseSet = false;

        // Settle exactly one so the wallet held two pending markers at once
        // (above), then one settled + one pending after this step.
        if (feeSeed % 2 == 0) {
            _reservationRouter_acceptance(
                _reservationRouter_keyOf(idx1),
                n1,
                reservationRouter_FEE_MAX,
                feeSeed
            );
        } else {
            _reservationRouter_acceptance(
                _reservationRouter_keyOf(idx2),
                n2,
                reservationRouter_FEE_MAX,
                feeSeed
            );
        }
        _resProp_flowBaseSet = false;
    }

    /// @dev Ensures a wallet holds two Active reservations (two settled
    ///      acceptances to the same wallet), then re-anchors one of them to
    ///      another Live wallet in one call. The source must stay
    ///      re-anchorable (Live) at request time.
    function reservationRouter_reanchorFromSharedWallet_flow(
        uint256 amountSeed,
        uint256 walletSeed,
        uint256 entropySeed,
        uint256 targetSeed,
        uint256 feeSeed
    ) public {
        uint256 key1;
        uint256 key2;
        {
            (bool ok1, uint256 idx1) = _reservationRouter_flowReveal(
                amountSeed,
                walletSeed,
                entropySeed
            );
            if (!ok1) return;
            key1 = _reservationRouter_keyOf(idx1);
            (, uint64 n1) = _reservationRouter_flowRequest(idx1);
            if (n1 == 0) return;
            _reservationRouter_acceptance(
                key1,
                n1,
                reservationRouter_FEE_RANDOM,
                feeSeed
            );
            _resProp_flowBaseSet = false;
        }

        // Second active reservation on the same wallet (amounts sum must fit
        // the per-wallet cap, so the second is kept small).
        {
            uint64 amt2;
            {
                (uint64 lo2, ) = _reservationRouter_amountBounds();
                amt2 = uint64(
                    _reservationRouter_between(
                        amountSeed / 32,
                        lo2,
                        lo2 + lo2 / 4
                    )
                );
            }
            (, uint256 delta2b) = _reservationRouter_refundDelta(
                entropySeed / 4
            );
            (bool ok2, uint256 idx2) = _reservationRouter_reveal(
                amt2,
                walletSeed,
                delta2b,
                entropySeed,
                true
            );
            if (!ok2) return;
            key2 = _reservationRouter_keyOf(idx2);
            (, uint64 n2) = _reservationRouter_flowRequest(idx2);
            if (n2 == 0) return;
            _reservationRouter_acceptance(
                key2,
                n2,
                reservationRouter_FEE_ZERO,
                feeSeed
            );
            _resProp_flowBaseSet = false;
        }

        // Re-anchor one of the two to another Live wallet with capacity.
        (bool okR, uint256 rk) = _reservationRouter_requestReanchor(
            feeSeed % 2 == 0 ? key1 : key2,
            targetSeed
        );
        if (!okR) return;
        uint64 rnonce = reservationRouter.reservations(rk).requestNonce;
        _reservationRouter_reanchor(
            rk,
            rnonce,
            reservationRouter_FEE_RANDOM,
            feeSeed
        );
        _resProp_flowBaseSet = false;
    }

    // ――― 4. Timeouts and failure paths ―――

    /// @dev Picks a recorded reservation whose current pending acceptance
    ///      generation reached `timeoutAt`.
    function reservationRouter_notifyReservationAcceptanceTimedOut_clamped(
        uint256 reservationSeed
    ) public {
        (bool found, uint256 key) = _reservationRouter_pickReservation(
            reservationSeed,
            reservationRouter_RES_ACCEPT_TIMEOUT_READY
        );
        if (!found) return;
        reservationRouter_notifyReservationAcceptanceTimedOut(key);
    }

    /// @dev Picks a recorded reservation with a pending re-anchor generation
    ///      that reached `timeoutAt`.
    function reservationRouter_notifyReservationActionTimeout_clamped(
        uint256 reservationSeed
    ) public {
        (bool found, uint256 key) = _reservationRouter_pickReservation(
            reservationSeed,
            reservationRouter_RES_ACTION_TIMEOUT_READY
        );
        if (!found) return;
        reservationRouter_notifyReservationActionTimeout(key);
    }

    /// @dev Picks an Active recorded reservation whose wallet is Terminated /
    ///      Closed, or Closing past the reservation's dissolutionEligibleAt.
    function reservationRouter_notifyReservationStranded_clamped(
        uint256 reservationSeed
    ) public {
        (bool found, uint256 key) = _reservationRouter_pickReservation(
            reservationSeed,
            reservationRouter_RES_STRANDABLE
        );
        if (!found) return;
        reservationRouter_notifyReservationStranded(key);
    }

    /// @dev Picks a pending reserved deposit (no acceptance in flight) whose
    ///      refund deadline elapsed.
    function reservationRouter_notifyStaleReservedDeposit_clamped(
        uint256 depositSeed
    ) public {
        (bool found, uint256 idx) = _reservationRouter_pickDeposit(
            depositSeed,
            reservationRouter_DEP_STALE_READY
        );
        if (!found) return;
        reservationRouter_notifyStaleReservedDeposit(
            _reservationRouter_keyOf(idx)
        );
    }

    // ――― 5. Re-anchor ―――

    /// @dev Requests the re-anchor of an Active reservation to another Live
    ///      wallet with capacity. Source Live => governance branch; source
    ///      MovingFunds / Closing => permissionless branch (or governance on
    ///      a quarter of the seeds, which skips the cooldown).
    function reservationRouter_requestReservationReanchor_clamped(
        uint256 reservationSeed,
        uint256 targetSeed
    ) public {
        _reservationRouter_requestReanchor(reservationSeed, targetSeed);
    }

    /// @dev Settles a pending (or timed-out = late) re-anchor generation:
    ///      spends the current anchor, one output to the target wallet, miner
    ///      fee within the generation's txMaxFee (drives financeInKindFee).
    function reservationRouter_submitReservationReanchorProof_clamped(
        uint256 reservationSeed,
        uint256 feeSeed,
        uint256 nonceSeed
    ) public {
        _reservationRouter_reanchorProof(
            reservationSeed,
            nonceSeed,
            reservationRouter_FEE_RANDOM,
            feeSeed
        );
    }

    /// @dev Miner fee 0: `financeInKindFee(0)` early-return path.
    function reservationRouter_submitReservationReanchorProof_zeroFee(
        uint256 reservationSeed,
        uint256 nonceSeed
    ) public {
        _reservationRouter_reanchorProof(
            reservationSeed,
            nonceSeed,
            reservationRouter_FEE_ZERO,
            0
        );
    }

    /// @dev Miner fee exactly txMaxFee: largest in-kind fee the vault must
    ///      finance / book as debt, smallest allowed re-anchored amount.
    function reservationRouter_submitReservationReanchorProof_maxFee(
        uint256 reservationSeed,
        uint256 nonceSeed
    ) public {
        _reservationRouter_reanchorProof(
            reservationSeed,
            nonceSeed,
            reservationRouter_FEE_MAX,
            0
        );
    }

    /// @dev Miner fee txMaxFee + 1: must be rejected ("fee is too high").
    function reservationRouter_submitReservationReanchorProof_overMaxFee(
        uint256 reservationSeed,
        uint256 nonceSeed
    ) public {
        _reservationRouter_reanchorProof(
            reservationSeed,
            nonceSeed,
            reservationRouter_FEE_OVER_MAX,
            0
        );
    }

    /// @dev Request + prove a re-anchor in one call (same timestamp, so the
    ///      proof is always inside the authorization window).
    function reservationRouter_reanchorReservation_flow(
        uint256 reservationSeed,
        uint256 targetSeed,
        uint256 feeSeed
    ) public {
        (bool ok, uint256 key) = _reservationRouter_requestReanchor(
            reservationSeed,
            targetSeed
        );
        if (!ok) return;
        uint64 nonce = reservationRouter.reservations(key).requestNonce;
        _reservationRouter_reanchor(
            key,
            nonce,
            reservationRouter_FEE_RANDOM,
            feeSeed
        );
    }

    // ――― 6. Secondary dispatcher (governance) ―――

    /// @dev selector % 6: 0/1 forceStaleReservedDeposit (clamped / raw),
    ///      2/3 updateReservationCaps (clamped / raw), 4/5
    ///      updateReservationParameters (clamped / raw). Clamped variants keep
    ///      `maxTotal <= maxActive * maxSingle`, which is why caps are
    ///      sourced from the stored values of the other setter.
    function reservationRouter_secondary(
        uint8 selector,
        uint256 arg0,
        uint256 arg1,
        uint256 arg2,
        uint256 arg3,
        uint256 arg4,
        uint256 arg5,
        uint256 arg6,
        uint256 arg7,
        address arg8
    ) public {
        selector = uint8(selector % 6);
        if (selector >= 2) _reservationRouter_updateBegin();
        if (selector == 0)
            _reservationRouter_forceStaleReservedDeposit_clamped(arg0);
        else if (selector == 1)
            _reservationRouter_forceStaleReservedDeposit(arg0);
        else if (selector == 2)
            _reservationRouter_updateReservationCaps_clamped(arg0, arg1, arg2);
        else if (selector == 3)
            _reservationRouter_updateReservationCaps(
                uint64(arg0),
                uint64(arg1),
                uint32(arg2)
            );
        else if (selector == 4) {
            uint256[8] memory a = [
                arg0,
                arg1,
                arg2,
                arg3,
                arg4,
                arg5,
                arg6,
                arg7
            ];
            _reservationRouter_updateReservationParameters_clamped(a, arg8);
        } else
            _reservationRouter_updateReservationParameters(
                arg8,
                uint64(arg0),
                uint64(arg1),
                uint32(arg2),
                uint32(arg3),
                uint64(arg4),
                uint32(arg5),
                uint32(arg6),
                uint32(arg7)
            );
        if (selector >= 2) _reservationRouter_updateEnd();
        _reservationRouter_hub(0);
        _reservationRouter_secondaryProbes(arg6);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    /// @dev Raw request. Records the reservation key (harness gap fix) and
    ///      refuses new keys once `FIZZ_SCAN_CAP` reservations are tracked
    ///      (the ledger properties need the complete key set). The funding
    ///      transaction is looked up in the harness bookkeeping stored at
    ///      reveal time; keys without a stored funding transaction return
    ///      early (no proof can be built for them).
    function reservationRouter_requestReservationAcceptance(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) public asActor {
        if (
            !reservationRouter_keyRecorded[reservationKey] &&
            harnessReservationKeys.length >= FIZZ_SCAN_CAP
        ) return;
        HarnessFunding storage funding = harnessDepositFundings[reservationKey];
        if (funding.info.inputVector.length == 0) return;
        _reservationRouter_begin(
            HID_REQUEST_ACCEPTANCE,
            reservationKey,
            walletPubKeyHash,
            bytes20(0),
            bridge.deposits(reservationKey).depositor
        );
        // The SPV proof goes through the sha256 precompile, which consumes
        // the active `asActor` prank; build it outside the pranked region
        // and resume the prank so the router call is still made by the
        // deposit's depositor.
        vm.stopPrank();
        BitcoinTx.Proof memory fundingProof = BtcBuilder.prove(funding.info, 1);
        vm.startPrank(actor);
        reservationRouter.requestReservationAcceptance(
            funding.info,
            fundingProof,
            funding.outputIndex,
            walletPubKeyHash
        );
        _reservationRouter_recordKey(reservationKey);
        snapshotAfter();
        _reservationRouter_recordActionImage(reservationKey);
        property_acceptanceRequestPostconditions();
        property_acceptanceRequestAdmission();
        property_fakeAcceptancesCannotHoardWalletCapacity();
        _reservationRouter_hub(0);
    }

    /// @dev Raw proof: reverts when the call reverts. The shared builder
    ///      (`_reservationRouter_acceptance`) uses the probing variant.
    function reservationRouter_submitReservationAcceptanceProof(
        BitcoinTx.Info memory txInfo,
        BitcoinTx.Proof memory proof,
        uint256 reservationKey,
        uint64 requestNonce
    ) public {
        _reservationRouter_acceptanceSubmit(
            txInfo,
            proof,
            reservationKey,
            requestNonce,
            false,
            false
        );
    }

    /// @dev Records the funding transaction of a deposit revealed outside
    ///      the handlers (audit-poc tests call `bridge.revealDeposit`
    ///      directly), so `_fundingArgs` can prove it later (R-01).
    function _recordFunding(
        uint256 key,
        BitcoinTx.Info memory info,
        uint32 outputIndex
    ) internal {
        harnessDepositFundings[key] = HarnessFunding({
            info: info,
            outputIndex: outputIndex
        });
    }

    /// @dev Arguments of `requestReservationAcceptance` for a recorded
    ///      deposit: its funding transaction, an SPV proof of it and the
    ///      output index. Call it BEFORE `vm.prank` / `vm.expectRevert`: the
    ///      proof goes through the sha256 precompile, which consumes a
    ///      pending prank.
    function _fundingArgs(
        uint256 key
    )
        internal
        returns (
            BitcoinTx.Info memory info,
            BitcoinTx.Proof memory proof,
            uint32 outputIndex
        )
    {
        HarnessFunding storage f = harnessDepositFundings[key];
        require(f.info.inputVector.length != 0, "no recorded funding tx");
        info = f.info;
        outputIndex = f.outputIndex;
        proof = BtcBuilder.prove(info, 1);
    }

    /// @dev `caller` requests acceptance of the recorded deposit `key` for
    ///      `wallet`, proving its funding transaction (R-01).
    function _requestAcceptanceAs(
        address caller,
        uint256 key,
        bytes20 wallet
    ) internal {
        (
            BitcoinTx.Info memory info,
            BitcoinTx.Proof memory proof,
            uint32 outputIndex
        ) = _fundingArgs(key);
        vm.prank(caller);
        reservationRouter.requestReservationAcceptance(
            info,
            proof,
            outputIndex,
            wallet
        );
    }

    function reservationRouter_notifyReservationAcceptanceTimedOut(
        uint256 reservationKey
    ) public asActor {
        uint64 nonce = reservationRouter
            .reservations(reservationKey)
            .requestNonce;
        _reservationRouter_begin(
            HID_ACCEPTANCE_TIMEOUT,
            reservationKey,
            reservationRouter
                .reservationActions(reservationKey, nonce)
                .targetWalletPubKeyHash,
            bytes20(0),
            address(0)
        );
        reservationRouter.notifyReservationAcceptanceTimedOut(reservationKey);
        snapshotAfter();
        property_acceptanceTimeoutPostconditions();
        property_timeoutsNotEarly();
        _reservationRouter_hub(0);
    }

    function reservationRouter_notifyReservationActionTimeout(
        uint256 reservationKey
    ) public asActor {
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(reservationKey);
        _reservationRouter_begin(
            HID_ACTION_TIMEOUT,
            reservationKey,
            r.walletPubKeyHash,
            reservationRouter
                .reservationActions(reservationKey, r.requestNonce)
                .targetWalletPubKeyHash,
            address(0)
        );
        reservationRouter.notifyReservationActionTimeout(reservationKey);
        snapshotAfter();
        property_reanchorActionTimeoutPostconditions();
        property_timeoutsNotEarly();
        _reservationRouter_hub(0);
    }

    function reservationRouter_notifyReservationStranded(
        uint256 reservationKey
    ) public asActor {
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(reservationKey);
        _reservationRouter_begin(
            HID_STRAND,
            reservationKey,
            r.walletPubKeyHash,
            bytes20(0),
            r.owner
        );
        reservationRouter.notifyReservationStranded(reservationKey);
        snapshotAfter();
        _reservationRouter_pushHonest(r.anchorTxHash, r.anchorTxOutputIndex, 3);
        property_strandPostconditions();
        _reservationRouter_hub(reservationRouter_HUB_POOL);
    }

    function reservationRouter_notifyStaleReservedDeposit(
        uint256 depositKey
    ) public asActor {
        _reservationRouter_begin(
            HID_STALE,
            depositKey,
            reservationRouter.reservedDepositWallet(depositKey),
            bytes20(0),
            address(0)
        );
        reservationRouter.notifyStaleReservedDeposit(depositKey);
        snapshotAfter();
        property_staleReservedDepositPostconditions();
        property_timeoutsNotEarly();
        _reservationRouter_hub(0);
    }

    /// @dev Permissionless branch (caller != governance): only valid for a
    ///      MovingFunds / Closing source wallet and outside the cooldown.
    function reservationRouter_requestReservationReanchor(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash
    ) public asActor {
        _reservationRouter_reanchorRequestBegin(
            reservationKey,
            targetWalletPubKeyHash
        );
        reservationRouter.requestReservationReanchor(
            reservationKey,
            targetWalletPubKeyHash,
            new uint32[](0),
            0
        );
        _reservationRouter_reanchorRequestEnd(reservationKey);
    }

    /// @dev Privileged branch (`msg.sender == governance`): also rotates
    ///      anchors away from Live wallets and skips the cooldown.
    function reservationRouter_requestReservationReanchor_governance(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash
    ) public asGovernance {
        _reservationRouter_reanchorRequestBegin(
            reservationKey,
            targetWalletPubKeyHash
        );
        reservationRouter.requestReservationReanchor(
            reservationKey,
            targetWalletPubKeyHash,
            new uint32[](0),
            0
        );
        _reservationRouter_reanchorRequestEnd(reservationKey);
    }

    function reservationRouter_submitReservationReanchorProof(
        BitcoinTx.Info memory txInfo,
        BitcoinTx.Proof memory proof,
        uint256 reservationKey,
        uint64 requestNonce
    ) public {
        _reservationRouter_reanchorSubmit(
            txInfo,
            proof,
            reservationKey,
            requestNonce,
            false,
            false
        );
    }

    function _reservationRouter_forceStaleReservedDeposit(
        uint256 depositKey
    ) internal asGovernance {
        _reservationRouter_begin(
            HID_FORCE_STALE,
            depositKey,
            reservationRouter.reservedDepositWallet(depositKey),
            bytes20(0),
            address(0)
        );
        reservationRouter.forceStaleReservedDeposit(depositKey);
        snapshotAfter();
        property_staleReservedDepositPostconditions();
    }

    function _reservationRouter_updateReservationCaps(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    ) internal asGovernance {
        reservationRouter.updateReservationCaps(
            maxReservationsAmountPerWallet,
            reservationMaxSingleAmount,
            maxActiveReservations,
            MAX_THIRD_PARTY_REANCHOR_HOLDS_PER_WALLET,
            HANDOFF_RESERVE_WALLETS
        );
    }

    function _reservationRouter_updateReservationParameters(
        address reservationVault,
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationDissolutionDelay,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet,
        uint32 reservationActionTimeout,
        uint32 reservationRenewalWindowSeconds
    ) internal asGovernance {
        reservationRouter.updateReservationParameters(
            reservationVault,
            reservationMinAmount,
            reservationTxMaxFee,
            reservationTermSeconds,
            reservationDissolutionDelay,
            reservationMaxTotalAmount,
            maxReservationsPerWallet,
            reservationActionTimeout,
            reservationRenewalWindowSeconds
        );
    }

    // ――――――――――――――――――― Secondary clamping helpers ――――――――――――――――――

    /// @dev Force-stales a pending reserved deposit picked from harness
    ///      state; falls back to the raw seed when none exists.
    function _reservationRouter_forceStaleReservedDeposit_clamped(
        uint256 depositSeed
    ) internal {
        (bool found, uint256 idx) = _reservationRouter_pickDeposit(
            depositSeed,
            reservationRouter_DEP_PENDING
        );
        if (found)
            _reservationRouter_forceStaleReservedDeposit(
                _reservationRouter_keyOf(idx)
            );
        else _reservationRouter_forceStaleReservedDeposit(depositSeed);
    }

    /// @dev Caps keeping `reservationMaxTotalAmount <= maxActive * maxSingle`
    ///      against the stored maxTotal. Amount caps are zero (disabled) on
    ///      one eighth of the seeds; when the product would undercut the
    ///      stored maxTotal, slot capacity is raised (and, if that overflows
    ///      uint32, maxSingle).
    function _reservationRouter_updateReservationCaps_clamped(
        uint256 perWalletSeed,
        uint256 singleSeed,
        uint256 activeSeed
    ) internal {
        uint256 maxTotal = _reservationRouter_param(
            reservationRouter_P_MAX_TOTAL
        );

        uint256 single =
            singleSeed % 8 == 0
                ? 0
                : _reservationRouter_between(singleSeed / 8, 1_000, 500_000);
        uint256 active = _reservationRouter_between(activeSeed, 1, 200);

        if (single != 0 && maxTotal != 0 && single * active < maxTotal) {
            uint256 need = (maxTotal + single - 1) / single;
            if (need <= type(uint32).max) {
                active = need;
            } else {
                active = type(uint32).max;
                single = (maxTotal + active - 1) / active;
            }
        }

        uint256 perWallet =
            perWalletSeed % 8 == 0
                ? 0
                : _reservationRouter_between(
                    perWalletSeed / 8,
                    single == 0 ? 1_000 : single,
                    20_000_000
                );

        _reservationRouter_updateReservationCaps(
            uint64(perWallet),
            uint64(single),
            uint32(active)
        );
    }

    /// @dev Parameters within protocol bounds and against the stored caps:
    ///      `maxTotal <= maxActive * maxSingle` (or 0), min > txMaxFee, term
    ///      in [90d, 730d], renewal < term, actionTimeout > 2h, perWallet > 0.
    ///      The vault is kept (it can only change with no active / pending
    ///      reservations); `vaultSeed` sometimes disables it, and a disabled
    ///      vault is always restored to `reservationVault`.
    function _reservationRouter_updateReservationParameters_clamped(
        uint256[8] memory a,
        address vaultSeed
    ) internal {
        reservationRouter_Params memory p;

        address current = address(
            uint160(_reservationRouter_param(reservationRouter_P_VAULT))
        );
        if (current == address(0)) p.vault = address(reservationVault);
        else if (uint160(vaultSeed) % 32 == 0) p.vault = address(0);
        else p.vault = current;

        p.txMaxFee = uint64(_reservationRouter_between(a[1], 1, 2_000));
        p.minAmount = uint64(
            _reservationRouter_between(a[0], uint256(p.txMaxFee) + 1, 30_000)
        );
        p.term = uint32(_reservationRouter_between(a[2], 90 days, 730 days));
        p.dissolutionDelay = uint32(
            _reservationRouter_between(a[3], 0, 30 days)
        );

        {
            (, uint64 single, uint32 active, ) = reservationRouter
                .reservationCaps();
            uint256 totalCap =
                (single == 0 || active == 0)
                    ? 50_000_000
                    : uint256(single) * active;
            if (totalCap > type(uint64).max) totalCap = type(uint64).max;
            if ((a[4] / 8) % 2 == 0 && totalCap > 1_000_000)
                totalCap = 1_000_000;
            p.maxTotal =
                a[4] % 8 == 0
                    ? 0
                    : uint64(
                        _reservationRouter_between(
                            a[4] / 8,
                            totalCap < 20_000 ? totalCap : 20_000,
                            totalCap
                        )
                    );
        }

        p.maxPerWallet = uint32(_reservationRouter_between(a[5], 1, 20));
        // Lowest valid: SAFETY_MARGIN + DEPOSIT_MIN_AGE + 2 (R-50 setter floor).
        p.actionTimeout = uint32(
            _reservationRouter_between(a[6], 4 hours + 2, 7 days)
        );
        uint256 renewalHi = uint256(p.term) - 1;
        if (renewalHi > 60 days) renewalHi = 60 days;
        p.renewalWindow = uint32(
            _reservationRouter_between(a[7], 1, renewalHi)
        );

        _reservationRouter_updateReservationParameters(
            p.vault,
            p.minAmount,
            p.txMaxFee,
            p.term,
            p.dissolutionDelay,
            p.maxTotal,
            p.maxPerWallet,
            p.actionTimeout,
            p.renewalWindow
        );
    }

    // ――――――――――――――――――――――― Flow internals ――――――――――――――――――――――――

    /// @dev Reveals a reserved deposit of `actor`. Records it with
    ///      `reserved = true`, its exact refund deadline and its index only
    ///      after `Bridge.revealDeposit` succeeded. Warps once into the era
    ///      where a reserved refund locktime (>= 500M) is possible.
    function _reservationRouter_reveal(
        uint64 amount,
        uint256 walletSeed,
        uint256 refundDelta,
        uint256 entropySeed,
        bool needWalletCapacity
    ) internal returns (bool ok, uint256 idx) {
        if (ghosts.reservedDepositKeys.length >= FIZZ_SCAN_CAP)
            return (false, 0);
        reservationRouter_RevealCtx memory ctx;
        ctx.amount = amount;
        ctx.wallet = _reservationRouter_pickLiveWallet(
            walletSeed,
            bytes20(0),
            needWalletCapacity
        );
        if (ctx.wallet == bytes20(0)) return (false, 0);
        ctx.vault = address(
            uint160(_reservationRouter_param(reservationRouter_P_VAULT))
        );
        if (ctx.vault == address(0)) return (false, 0);

        if (block.timestamp < reservationRouter_ERA_START) {
            vm.warp(reservationRouter_ERA_START);
        }
        ctx.locktime = block.timestamp + refundDelta;
        if (ctx.locktime > type(uint32).max) return (false, 0);

        ctx.depositor = actor;
        ctx.entropy = keccak256(
            abi.encode(
                "fizz.reservationRouter.deposit",
                entropySeed,
                reservationRouter_revealCount
            )
        );
        reservationRouter_revealCount++;

        return (true, _reservationRouter_submitReveal(ctx));
    }

    /// @dev Reveal for the full-lifecycle flow: acceptable amount, wallet
    ///      with free slots, refund deadline in [minDelta + 1h, minDelta + 3d]
    ///      so the immediate acceptance request always fits.
    function _reservationRouter_flowReveal(
        uint256 amountSeed,
        uint256 walletSeed,
        uint256 entropySeed
    ) internal returns (bool, uint256) {
        (uint64 lo, uint64 hi) = _reservationRouter_amountBounds();
        if (hi < lo) return (false, 0);
        uint64 amount = uint64(_reservationRouter_between(amountSeed, lo, hi));

        (
            ,
            uint256 minDelta,
            uint256 maxDelta
        ) = _reservationRouter_refundBounds();
        if (minDelta > maxDelta) return (false, 0);
        uint256 delta = _reservationRouter_between(
            entropySeed,
            minDelta + 1 hours,
            minDelta + 3 days
        );
        if (delta > maxDelta) delta = maxDelta;

        return
            _reservationRouter_reveal(
                amount,
                walletSeed,
                delta,
                entropySeed,
                true
            );
    }

    function _reservationRouter_submitReveal(
        reservationRouter_RevealCtx memory ctx
    ) internal returns (uint256 idx) {
        Deposit.DepositRevealInfo memory reveal = Deposit.DepositRevealInfo({
            fundingOutputIndex: uint32(uint256(ctx.entropy) % 4),
            blindingFactor: bytes8(
                keccak256(abi.encode(ctx.entropy, "blinding"))
            ),
            walletPubKeyHash: ctx.wallet,
            refundPubKeyHash: bytes20(
                keccak256(abi.encode(ctx.entropy, ctx.depositor, "refund"))
            ),
            refundLocktime: _reservationRouter_le32(uint32(ctx.locktime)),
            vault: ctx.vault
        });
        (BitcoinTx.Info memory fundingTx, uint32 outputIndex) = BtcBuilder
            .depositFundingTx(
                reveal,
                ctx.depositor,
                bytes32(0),
                false,
                (uint256(ctx.entropy) >> 8) % 2 == 0,
                ctx.amount,
                ctx.entropy
            );

        bytes32 fundingTxHash = BtcBuilder.txHash(fundingTx);
        uint256 key = _reservationRouter_depositKey(fundingTxHash, outputIndex);
        _reservationRouter_begin(
            HID_REVEAL_RESERVED,
            key,
            ctx.wallet,
            bytes20(0),
            ctx.depositor
        );

        vm.startPrank(ctx.depositor);
        bridge.revealDeposit(fundingTx, reveal);
        vm.stopPrank();

        snapshotAfter();
        idx = _recordDeposit(
            fundingTxHash,
            outputIndex,
            ctx.amount,
            ctx.depositor,
            ctx.vault,
            ctx.wallet,
            true
        );
        reservationRouter_refundDeadline[key] = uint32(ctx.locktime);
        reservationRouter_depositIndexPlusOne[key] = idx + 1;
        harnessDepositFundings[key] = HarnessFunding({
            info: fundingTx,
            outputIndex: outputIndex
        });

        _reservationRouter_revealGhosts(key, ctx.locktime);
        property_depositRevealPostconditions();
        property_depositTreasuryFeeFloor();
        property_depositRecordWriteOnce();
        // Vacuity F5: the only reveal path that creates a reserved deposit,
        // so the reserved-deposit branch of SP-39 runs only here.
        property_rebateAppliedWithinPreview();
        _reservationRouter_hubReveal();
    }

    /// @dev Requests acceptance as the deposit's depositor towards its
    ///      designated wallet (the raw handler records the reservation key).
    function _reservationRouter_requestAcceptance(
        uint256 idx
    ) internal returns (uint256 key, uint64 nonce) {
        key = _reservationRouter_keyOf(idx);
        if (
            !reservationRouter_keyRecorded[key] &&
            harnessReservationKeys.length >= FIZZ_SCAN_CAP
        ) return (key, 0);
        bytes20 wallet = reservationRouter.reservedDepositWallet(key);

        address previousActor = actor;
        actor = harnessDeposits[idx].depositor;
        reservationRouter_requestReservationAcceptance(key, wallet);
        actor = previousActor;

        nonce = reservationRouter.reservations(key).requestNonce;
    }

    function _reservationRouter_acceptanceProof(
        uint256 reservationSeed,
        uint256 nonceSeed,
        uint8 feeMode,
        uint256 feeSeed
    ) internal {
        (bool found, uint256 key) = _reservationRouter_pickReservation(
            reservationSeed,
            reservationRouter_RES_ACCEPT_SETTLEABLE
        );
        if (!found) return;
        (bool hasNonce, uint64 nonce) = _reservationRouter_findNonce(
            key,
            Reservation.ActionType.Acceptance,
            nonceSeed
        );
        if (!hasNonce) return;
        _reservationRouter_acceptance(key, nonce, feeMode, feeSeed);
    }

    /// @dev Builds the 1-input (deposit outpoint) 1-output (designated
    ///      wallet) anchor tx for generation `nonce` and proves it through
    ///      the probing submit (SP-55: a compliant proof must not revert).
    ///      The harness mirrors (deposit swept, tracked anchor) are updated
    ///      by the submit hook after success.
    function _reservationRouter_acceptance(
        uint256 key,
        uint64 nonce,
        uint8 feeMode,
        uint256 feeSeed
    ) internal {
        uint64 fee = _reservationRouter_fee(
            feeMode,
            feeSeed,
            reservationRouter.reservationActions(key, nonce).txMaxFee
        );
        (
            bool found,
            BitcoinTx.Info memory anchorTx
        ) = _reservationRouter_acceptanceTx(
                key,
                nonce,
                fee,
                (feeSeed >> 128) % 2 == 1
            );
        if (!found) return;
        _reservationRouter_acceptanceSubmit(
            anchorTx,
            BtcBuilder.prove(anchorTx, 1),
            key,
            nonce,
            true,
            _reservationRouter_acceptanceCompliant(key, nonce, fee)
        );
    }

    /// @dev Picks an Active reservation and a Live target wallet and files
    ///      the re-anchor request through the right branch.
    function _reservationRouter_requestReanchor(
        uint256 reservationSeed,
        uint256 targetSeed
    ) internal returns (bool ok, uint256 key) {
        (bool found, uint256 picked) = _reservationRouter_pickReservation(
            reservationSeed,
            reservationRouter_RES_ACTIVE
        );
        if (!found) return (false, 0);
        key = picked;

        Reservation.ReservationRequest memory reservation = reservationRouter
            .reservations(key);
        bytes20 target = _reservationRouter_pickLiveWallet(
            targetSeed,
            reservation.walletPubKeyHash,
            true
        );
        if (target == bytes20(0)) return (false, 0);

        bool viaGovernance =
            _reservationRouter_walletState(reservation.walletPubKeyHash) ==
                Wallets.WalletState.Live ||
                targetSeed % 4 == 0;
        if (
            !viaGovernance &&
            block.timestamp < reservation.reanchorCooldownUntil
        ) {
            return (false, 0);
        }

        if (viaGovernance)
            reservationRouter_requestReservationReanchor_governance(
                key,
                target
            );
        else reservationRouter_requestReservationReanchor(key, target);
        return (true, key);
    }

    function _reservationRouter_reanchorProof(
        uint256 reservationSeed,
        uint256 nonceSeed,
        uint8 feeMode,
        uint256 feeSeed
    ) internal {
        (bool found, uint256 key) = _reservationRouter_pickReservation(
            reservationSeed,
            reservationRouter_RES_REANCHOR_SETTLEABLE
        );
        if (!found) return;
        (bool hasNonce, uint64 nonce) = _reservationRouter_findNonce(
            key,
            Reservation.ActionType.Reanchor,
            nonceSeed
        );
        if (!hasNonce) return;
        _reservationRouter_reanchor(key, nonce, feeMode, feeSeed);
    }

    /// @dev Builds the 1-input (current anchor) 1-output (target wallet)
    ///      re-anchor tx for generation `nonce` and proves it through the
    ///      probing submit (SP-61: a compliant proof must not revert). The
    ///      tracked anchor is updated by the submit hook after success.
    function _reservationRouter_reanchor(
        uint256 key,
        uint64 nonce,
        uint8 feeMode,
        uint256 feeSeed
    ) internal {
        uint64 fee = _reservationRouter_fee(
            feeMode,
            feeSeed,
            reservationRouter.reservationActions(key, nonce).txMaxFee
        );
        BitcoinTx.Info memory reanchorTx = _reservationRouter_reanchorTx(
            key,
            nonce,
            fee,
            (feeSeed >> 128) % 2 == 1
        );
        _reservationRouter_reanchorSubmit(
            reanchorTx,
            BtcBuilder.prove(reanchorTx, 1),
            key,
            nonce,
            true,
            _reservationRouter_reanchorCompliant(key, nonce, fee)
        );
    }

    // ――――――――――――――――――――――――― Pickers ――――――――――――――――――――――――――

    /// @dev First `harnessDeposits` index (cyclic from a seed-derived offset)
    ///      matching `kind`.
    function _reservationRouter_pickDeposit(
        uint256 seed,
        uint8 kind
    ) internal view returns (bool, uint256) {
        uint256 n = harnessDeposits.length;
        if (n == 0) return (false, 0);
        uint256 start = seed % n;
        for (uint256 j = 0; j < n; j++) {
            uint256 i = (start + j) % n;
            if (_reservationRouter_depositMatches(i, kind)) return (true, i);
        }
        return (false, 0);
    }

    /// @dev First `harnessReservationKeys` entry (cyclic from a seed-derived
    ///      offset) matching `kind`.
    function _reservationRouter_pickReservation(
        uint256 seed,
        uint8 kind
    ) internal view returns (bool, uint256) {
        uint256 n = harnessReservationKeys.length;
        if (n == 0) return (false, 0);
        uint256 start = seed % n;
        for (uint256 j = 0; j < n; j++) {
            uint256 key = harnessReservationKeys[(start + j) % n];
            if (_reservationRouter_reservationMatches(key, kind))
                return (true, key);
        }
        return (false, 0);
    }

    function _reservationRouter_depositMatches(
        uint256 i,
        uint8 kind
    ) internal view returns (bool) {
        if (!harnessDeposits[i].reserved || harnessDeposits[i].swept)
            return false;
        uint256 key = _reservationRouter_keyOf(i);

        bytes20 designated = reservationRouter.reservedDepositWallet(key);
        if (designated == bytes20(0)) return false;

        Reservation.ReservationRequest memory reservation = reservationRouter
            .reservations(key);
        if (reservation.state != Reservation.ReservationState.Unknown)
            return false;
        if (
            reservationRouter
                .reservationActions(key, reservation.requestNonce)
                .state == Reservation.ActionState.Pending
        ) return false;

        uint32 deadline = reservationRouter_refundDeadline[key];
        if (kind == reservationRouter_DEP_REQUESTABLE) {
            if (
                _reservationRouter_walletState(designated) !=
                Wallets.WalletState.Live
            ) return false;
            if (
                deadline != 0 &&
                block.timestamp +
                    _reservationRouter_param(
                        reservationRouter_P_ACTION_TIMEOUT
                    ) +
                    1 days >
                    deadline
            ) return false;
            return true;
        }
        if (kind == reservationRouter_DEP_STALE_READY) {
            return deadline == 0 || block.timestamp > deadline;
        }
        return true;
    }

    function _reservationRouter_reservationMatches(
        uint256 key,
        uint8 kind
    ) internal view returns (bool) {
        Reservation.ReservationRequest memory reservation = reservationRouter
            .reservations(key);

        if (kind == reservationRouter_RES_ACCEPT_TIMEOUT_READY) {
            if (reservation.state != Reservation.ReservationState.Unknown)
                return false;
            if (reservation.requestNonce == 0) return false;
            Reservation.ReservationAction memory latest = reservationRouter
                .reservationActions(key, reservation.requestNonce);
            return
                latest.actionType == Reservation.ActionType.Acceptance &&
                latest.state == Reservation.ActionState.Pending &&
                block.timestamp >= latest.timeoutAt;
        }
        if (kind == reservationRouter_RES_ACCEPT_SETTLEABLE) {
            (bool found, ) = _reservationRouter_findNonce(
                key,
                Reservation.ActionType.Acceptance,
                0
            );
            return found;
        }
        if (kind == reservationRouter_RES_REANCHOR_SETTLEABLE) {
            (bool found, ) = _reservationRouter_findNonce(
                key,
                Reservation.ActionType.Reanchor,
                0
            );
            return found;
        }
        if (kind == reservationRouter_RES_ACTIVE) {
            if (reservation.state != Reservation.ReservationState.Active)
                return false;
            Wallets.WalletState s = _reservationRouter_walletState(
                reservation.walletPubKeyHash
            );
            if (
                s != Wallets.WalletState.Live &&
                s != Wallets.WalletState.MovingFunds &&
                s != Wallets.WalletState.Closing
            ) return false;
            return
                uint256(reservation.anchorAmount) >
                _reservationRouter_param(reservationRouter_P_TX_MAX_FEE) +
                    _reservationRouter_param(reservationRouter_P_MIN_AMOUNT);
        }
        if (kind == reservationRouter_RES_ACTION_TIMEOUT_READY) {
            if (reservation.state != Reservation.ReservationState.ActionPending)
                return false;
            Reservation.ReservationAction memory pending = reservationRouter
                .reservationActions(key, reservation.requestNonce);
            return
                pending.actionType == Reservation.ActionType.Reanchor &&
                pending.state == Reservation.ActionState.Pending &&
                block.timestamp >= pending.timeoutAt;
        }
        // RES_STRANDABLE
        if (reservation.state != Reservation.ReservationState.Active)
            return false;
        Wallets.WalletState ws = _reservationRouter_walletState(
            reservation.walletPubKeyHash
        );
        return
            ws == Wallets.WalletState.Terminated ||
            ws == Wallets.WalletState.Closed ||
            (ws == Wallets.WalletState.Closing &&
                block.timestamp >= reservation.dissolutionEligibleAt);
    }

    /// @dev A generation of `key` of the given action type that an SPV proof
    ///      can settle right now (Pending and current, or TimedOut = late),
    ///      scanning nonces cyclically from a seed-derived offset.
    function _reservationRouter_findNonce(
        uint256 key,
        Reservation.ActionType actionType,
        uint256 seed
    ) internal view returns (bool, uint64) {
        Reservation.ReservationRequest memory reservation = reservationRouter
            .reservations(key);
        uint64 n = reservation.requestNonce;
        if (n == 0) return (false, 0);
        if (actionType == Reservation.ActionType.Acceptance) {
            (bool known, uint256 idx) = _reservationRouter_depositIndex(key);
            if (!known || harnessDeposits[idx].swept) return (false, 0);
        }

        uint64 start = uint64(seed % n);
        for (uint64 j = 0; j < n; j++) {
            uint64 nonce = ((start + j) % n) + 1;
            if (
                _reservationRouter_settleable(
                    key,
                    nonce,
                    reservation,
                    actionType
                )
            ) {
                return (true, nonce);
            }
        }
        return (false, 0);
    }

    function _reservationRouter_settleable(
        uint256 key,
        uint64 nonce,
        Reservation.ReservationRequest memory reservation,
        Reservation.ActionType actionType
    ) internal view returns (bool) {
        Reservation.ReservationAction memory action = reservationRouter
            .reservationActions(key, nonce);
        if (action.actionType != actionType) return false;
        bool late = action.state == Reservation.ActionState.TimedOut;
        if (!late && action.state != Reservation.ActionState.Pending)
            return false;
        if (!late && reservation.requestNonce != nonce) return false;

        if (actionType == Reservation.ActionType.Acceptance) {
            if (reservation.state != Reservation.ReservationState.Unknown)
                return false;
            // Late acceptance window: timeoutAt + termSeconds.
            if (
                late &&
                block.timestamp > uint256(action.timeoutAt) + action.termSeconds
            ) return false;
            return true;
        }

        // Reanchor
        bool stranded =
            reservation.state == Reservation.ReservationState.Stranded;
        if (
            !(reservation.state == Reservation.ReservationState.Active ||
                reservation.state ==
                    Reservation.ReservationState.ActionPending ||
                (stranded && late))
        ) return false;
        if (
            keccak256(
                abi.encodePacked(
                    reservation.anchorTxHash,
                    reservation.anchorTxOutputIndex
                )
            ) != action.sourceAnchorUtxoHash
        ) return false;
        if (
            stranded &&
            bridge.spentMainUTXOs(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            reservation.anchorTxHash,
                            reservation.anchorTxOutputIndex
                        )
                    )
                )
            )
        ) return false;
        return true;
    }

    /// @dev Live wallet from `harnessWallets` (cyclic from a seed-derived
    ///      offset), different from `exclude`, optionally with free
    ///      per-wallet reservation slots.
    function _reservationRouter_pickLiveWallet(
        uint256 seed,
        bytes20 exclude,
        bool needCapacity
    ) internal view returns (bytes20) {
        uint256 n = harnessWallets.length;
        if (n == 0) return bytes20(0);
        uint256 start = seed % n;
        for (uint256 j = 0; j < n; j++) {
            bytes20 candidate = harnessWallets[(start + j) % n];
            if (candidate == exclude) continue;
            if (
                _reservationRouter_walletState(candidate) !=
                Wallets.WalletState.Live
            ) continue;
            if (
                needCapacity &&
                uint256(reservationRouter.walletReservationsCount(candidate)) >=
                    _reservationRouter_param(reservationRouter_P_MAX_PER_WALLET)
            ) continue;
            return candidate;
        }
        return bytes20(0);
    }

    // ―――――――――――――――――――――――――― Helpers ―――――――――――――――――――――――――

    function _reservationRouter_recordKey(uint256 key) internal {
        if (reservationRouter_keyRecorded[key]) return;
        reservationRouter_keyRecorded[key] = true;
        _recordReservation(key);
    }

    /// @dev Mirrors the reservation's current anchor outpoint from the
    ///      Bridge after a successful settlement.
    function _reservationRouter_trackAnchor(uint256 key) internal {
        Reservation.ReservationRequest memory reservation = reservationRouter
            .reservations(key);
        reservationRouter_anchors[key] = reservationRouter_Anchor({
            txHash: reservation.anchorTxHash,
            outputIndex: reservation.anchorTxOutputIndex,
            amount: reservation.anchorAmount,
            walletPkh: reservation.walletPubKeyHash
        });
    }

    function _reservationRouter_keyOf(
        uint256 idx
    ) internal view returns (uint256) {
        return
            _reservationRouter_depositKey(
                harnessDeposits[idx].fundingTxHash,
                harnessDeposits[idx].outputIndex
            );
    }

    function _reservationRouter_depositKey(
        bytes32 fundingTxHash,
        uint32 outputIndex
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(fundingTxHash, outputIndex)));
    }

    /// @dev Index in `harnessDeposits` of the deposit with the given key:
    ///      indexed lookup for deposits revealed here, scan otherwise.
    function _reservationRouter_depositIndex(
        uint256 key
    ) internal view returns (bool, uint256) {
        uint256 indexPlusOne = reservationRouter_depositIndexPlusOne[key];
        if (indexPlusOne != 0) return (true, indexPlusOne - 1);
        uint256 n = harnessDeposits.length;
        for (uint256 i = 0; i < n; i++) {
            if (_reservationRouter_keyOf(i) == key) return (true, i);
        }
        return (false, 0);
    }

    function _reservationRouter_walletState(
        bytes20 walletPkh
    ) internal view returns (Wallets.WalletState) {
        return bridge.wallets(walletPkh).state;
    }

    /// @dev Word `index` of `reservationParameters()`: 0 vault, 1 minAmount,
    ///      2 txMaxFee, 3 term, 4 dissolutionDelay, 5 maxTotal, 6 totalAmount,
    ///      7 maxReservationsPerWallet, 8 actionTimeout, 9 renewalWindow.
    ///      Read as a raw word to avoid a 10-value stack destructuring.
    function _reservationRouter_param(
        uint256 index
    ) internal view returns (uint256 value) {
        (bool ok, bytes memory ret) = address(reservationRouter).staticcall(
            abi.encodeWithSelector(
                ReservationRouter.reservationParameters.selector
            )
        );
        require(
            ok && ret.length >= 320,
            "reservationRouter: parameters read failed"
        );
        // solhint-disable-next-line no-inline-assembly
        assembly {
            value := mload(add(add(ret, 32), mul(index, 32)))
        }
    }

    /// @dev [lo, hi] satoshi range of a reserved deposit the acceptance
    ///      request can accept: lo = max(minAmount + 2 * txMaxFee + 1,
    ///      deposit dust) (R-09 floor), hi = single-reservation cap (4 * lo
    ///      when the cap is disabled). `hi < lo` means no acceptable amount
    ///      exists (or overflow).
    function _reservationRouter_amountBounds()
        internal
        view
        returns (uint64 lo, uint64 hi)
    {
        uint256 low =
            _reservationRouter_param(reservationRouter_P_MIN_AMOUNT) +
                2 * _reservationRouter_param(reservationRouter_P_TX_MAX_FEE) +
                1;
        (uint64 dust, , , ) = bridge.depositParameters();
        if (low < dust) low = dust;
        (, uint64 single, , ) = reservationRouter.reservationCaps();
        uint256 high = single == 0 ? low * 4 : single;
        if (high > type(uint64).max) high = type(uint64).max;
        if (low > type(uint64).max) return (type(uint64).max, 0);
        return (uint64(low), uint64(high));
    }

    /// @dev Refund locktime delta bounds (seconds after now):
    ///      `ahead` = reveal-ahead period, `minDelta` = smallest delta that
    ///      still lets an acceptance request fit (reveal-ahead and
    ///      actionTimeout + 24h + 1), `maxDelta` = reserved cap
    ///      (term + 24h). `minDelta > maxDelta` means unusable parameters.
    function _reservationRouter_refundBounds()
        internal
        view
        returns (uint256 ahead, uint256 minDelta, uint256 maxDelta)
    {
        (, , , uint32 revealAhead) = bridge.depositParameters();
        ahead = revealAhead;
        minDelta =
            _reservationRouter_param(reservationRouter_P_ACTION_TIMEOUT) +
            1 days +
            1;
        if (minDelta < ahead) minDelta = ahead;
        // reservationTermSeconds is word 3.
        maxDelta = _reservationRouter_param(3) + 1 days;
    }

    /// @dev Biased refund delta: three quarters of the seeds land in
    ///      [minDelta, minDelta + 3 days) (deadlines the fuzzer's time
    ///      delays can actually cross, feeding the stale path), the rest
    ///      spread over the whole [minDelta, maxDelta] range.
    function _reservationRouter_refundDelta(
        uint256 seed
    ) internal view returns (bool, uint256) {
        (
            ,
            uint256 minDelta,
            uint256 maxDelta
        ) = _reservationRouter_refundBounds();
        if (minDelta > maxDelta) return (false, 0);
        uint256 span = maxDelta - minDelta + 1;
        uint256 s = seed / 4;
        if (seed % 4 == 0) return (true, minDelta + (s % span));
        uint256 near = span < 3 days ? span : 3 days;
        return (true, minDelta + (s % near));
    }

    function _reservationRouter_fee(
        uint8 mode,
        uint256 seed,
        uint64 txMaxFee
    ) internal pure returns (uint64) {
        if (mode == reservationRouter_FEE_ZERO) return 0;
        if (mode == reservationRouter_FEE_MAX) return txMaxFee;
        if (mode == reservationRouter_FEE_OVER_MAX) return txMaxFee + 1;
        return uint64(seed % (uint256(txMaxFee) + 1));
    }

    /// @dev 1-input-1-output tx paying `walletPkh` (P2PKH or P2WPKH).
    function _reservationRouter_singleOutputTx(
        bytes32 prevTxHash,
        uint32 prevOutIndex,
        uint64 value,
        bytes20 walletPkh,
        bool p2pkh
    ) internal pure returns (BitcoinTx.Info memory) {
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](1);
        ins[0] = BtcBuilder.TxIn({
            prevTxHash: prevTxHash,
            prevOutIndex: prevOutIndex
        });
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](1);
        outs[0] = BtcBuilder.TxOut({
            value: value,
            script: p2pkh
                ? BtcBuilder.p2pkh(walletPkh)
                : BtcBuilder.p2wpkh(walletPkh)
        });
        return BtcBuilder.buildTx(ins, outs);
    }

    function _reservationRouter_le32(uint32 v) internal pure returns (bytes4) {
        return
            bytes4(
                (v << 24) |
                    ((v & 0xff00) << 8) |
                    ((v >> 8) & 0xff00) |
                    (v >> 24)
            );
    }

    /// @dev Maps `v` into [lo, hi] (returns `lo` for an empty range). Unlike
    ///      `clampBetween` it does not log, so it is cheap in tight loops.
    function _reservationRouter_between(
        uint256 v,
        uint256 lo,
        uint256 hi
    ) internal pure returns (uint256) {
        if (hi <= lo) return lo;
        return lo + (v % (hi - lo + 1));
    }

    // ――――――――――――――――――― Property hooks (Step 9d wiring) ―――――――――――――――――――

    /// @dev Flags of `_reservationRouter_hub`.
    uint8 internal constant reservationRouter_HUB_DEBT = 1; // SP-83, SP-93
    uint8 internal constant reservationRouter_HUB_POOL = 2; // SP-96

    /// @dev Pre-call context of a proof handler (memory bag, keeps stacks small).
    struct reservationRouter_ProofCtx {
        bool late;
        bool trusted;
        uint16 bps;
        address depositor;
    }

    /// @dev Anchor outpoint keys already pushed to `ghosts.knownUtxoKeys` here.
    mapping(uint256 => bool) internal reservationRouter_utxoKnown;
    /// @dev Vault parameter before a `reservationRouter_secondary` update.
    address internal reservationRouter_secVaultBefore;

    // ――― Round-trip handlers (SP-51, SP-58) ―――

    /// @dev Request an acceptance and let it time out in one call; the
    ///      capacity counters must be exactly what they were before.
    function reservationRouter_acceptanceTimeoutRoundTrip(
        uint256 depositSeed
    ) public {
        (bool found, uint256 idx) = _reservationRouter_pickDeposit(
            depositSeed,
            reservationRouter_DEP_REQUESTABLE
        );
        if (!found) return;
        // Out of model: an action timeout that pushes the clock past the uint32 horizon (ECH-long verdict).
        if (
            !clockHasRoom(
                _reservationRouter_param(reservationRouter_P_ACTION_TIMEOUT)
            )
        ) return;
        uint256 key = _reservationRouter_keyOf(idx);
        bytes20 wallet = reservationRouter.reservedDepositWallet(key);
        address depositor = harnessDeposits[idx].depositor;

        _setFocus(key, wallet, bytes20(0), depositor, 0);
        snapshotBefore();
        // The inner hooked handlers overwrite the snapshots: keep the
        // pre-request one and restore it for the round-trip property.
        State memory beforeRequest = stateBefore;

        (, uint64 nonce) = _reservationRouter_requestAcceptance(idx);
        if (nonce == 0) return;
        skipTime(_reservationRouter_param(reservationRouter_P_ACTION_TIMEOUT));
        reservationRouter_notifyReservationAcceptanceTimedOut(key);

        _setFocus(key, wallet, bytes20(0), depositor, 0);
        stateBefore = beforeRequest;
        snapshotAfter();
        property_acceptanceTimeoutRoundTrip();
    }

    /// @dev Request a re-anchor (governance branch allowed) and let it time
    ///      out in one call; wallet and global capacity must be restored.
    function reservationRouter_reanchorTimeoutRoundTrip(
        uint256 reservationSeed,
        uint256 targetSeed
    ) public {
        (bool found, uint256 key) = _reservationRouter_pickReservation(
            reservationSeed,
            reservationRouter_RES_ACTIVE
        );
        if (!found) return;
        bytes20 source = reservationRouter.reservations(key).walletPubKeyHash;
        bytes20 target = _reservationRouter_pickLiveWallet(
            targetSeed,
            source,
            true
        );
        if (target == bytes20(0)) return;
        // Out of model: an action timeout that pushes the clock past the uint32 horizon (ECH-long verdict).
        if (
            !clockHasRoom(
                _reservationRouter_param(reservationRouter_P_ACTION_TIMEOUT)
            )
        ) return;

        _setFocus(key, source, target, address(0), 0);
        snapshotBefore();
        State memory beforeRequest = stateBefore;

        (bool ok, ) = _reservationRouter_requestReanchor(
            reservationSeed,
            targetSeed
        );
        if (!ok) return;
        skipTime(_reservationRouter_param(reservationRouter_P_ACTION_TIMEOUT));
        reservationRouter_notifyReservationActionTimeout(key);

        _setFocus(key, source, target, address(0), 0);
        stateBefore = beforeRequest;
        snapshotAfter();
        property_reanchorTimeoutRoundTrip();
    }

    // ――― Hook plumbing ―――

    /// @dev Starts a hooked handler: handler id for the attribution
    ///      properties, snapshot focus, "before" snapshot.
    function _reservationRouter_begin(
        uint8 hid,
        uint256 key,
        bytes20 wallet0,
        bytes20 wallet1,
        address counterparty
    ) internal {
        ghosts.lastHandlerId = hid;
        _setFocus(key, wallet0, wallet1, counterparty, 0);
        snapshotBefore();
    }

    /// @dev HUB_RES: ledgers over the complete key / wallet sets.
    function _reservationRouter_hubLedger() internal {
        property_activeCountLedger();
        property_totalAmountLedger();
        property_walletCountLedger();
        property_walletAmountLedger();
        property_walletLedgerCrossSums();
        property_pendingReservedDepositsLedger();
        property_reservedDepositSweptIffPosition();
        property_reservationZeroState();
        property_counterDirectionalAttribution();
    }

    /// @dev HUB_RES_STATE: per-key checks (focus key + cursor window).
    function _reservationRouter_hubState() internal {
        property_strandedWalletRetired();
        property_strandNotBeforeDissolutionEligible();
        property_strandLeavesReanchorWindow();
        property_reservationStateAlignment();
        property_anchorIndexConsistent();
        property_anchorLineageConserved();
        property_anchorNonIncreasingFeeAccumulates();
        property_holdingPositionWalletConsistent();
        property_activeReservationReanchorable();
        property_reservationStateMachine();
        property_actionGenerationMachine();
        property_requestNonceMonotone();
        property_acceptedFieldsFrozen();
        property_actionSnapshotImmutable();
        property_spentUtxoMonotone();
        property_reservationCapacityHasReleasePath();
    }

    /// @dev End of a reveal handler (no per-key state changed).
    function _reservationRouter_hubReveal() internal {
        _reservationRouter_hubLedger();
        ghosts.lastHandlerId = HID_NONE;
    }

    /// @dev End of every other hooked handler: ledgers, per-key checks,
    ///      optional debt / pool checks, then the shadow refresh (after the
    ///      checks) and the handler-id reset.
    function _reservationRouter_hub(uint8 flags) internal {
        _reservationRouter_hubLedger();
        _reservationRouter_hubState();
        if (flags & reservationRouter_HUB_DEBT != 0) {
            property_minerFeeLedger();
            property_inKindDebtAttribution();
        }
        if (flags & reservationRouter_HUB_POOL != 0) {
            property_poolLiquidityCoversLiabilities();
        }
        _reservationRouter_refresh();
    }

    /// @dev Refreshes the `prev*` shadows of the checked window, tracks the
    ///      touched anchors, advances the cursor and resets the handler id.
    function _reservationRouter_refresh() internal {
        _reservationRouter_trackUtxo(stateBefore.frAnchorTxHash);
        _reservationRouter_trackUtxo(stateAfter.frAnchorTxHash);

        uint256[] memory keys = _resProp_windowKeys();
        for (uint256 i; i < keys.length; i++) {
            _reservationRouter_refreshKey(keys[i]);
        }

        (uint256 start, uint256 size) = _resProp_window(
            ghosts.knownUtxoKeys.length
        );
        uint256 n =
            ghosts.knownUtxoKeys.length > FIZZ_SCAN_CAP
                ? FIZZ_SCAN_CAP
                : ghosts.knownUtxoKeys.length;
        for (uint256 j; j < size; j++) {
            uint256 k = ghosts.knownUtxoKeys[(start + j) % n];
            if (!ghosts.everSpent[k] && bridge.spentMainUTXOs(k))
                ghosts.everSpent[k] = true;
        }

        _resProp_cursor += FIZZ_CURSOR_STEP;
        if (
            ghosts.capsLoweredBelowOccupancy &&
            _reservationRouter_occupancyWithinCaps()
        ) {
            ghosts.capsLoweredBelowOccupancy = false;
        }
        ghosts.lastHandlerId = HID_NONE;
    }

    function _reservationRouter_refreshKey(uint256 key) internal {
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        if (
            r.state == Reservation.ReservationState.Stranded &&
            ghosts.prevResState[key] !=
                uint8(Reservation.ReservationState.Stranded)
        ) {
            ghosts.strandedAt[key] = uint32(block.timestamp);
        }
        ghosts.prevResState[key] = uint8(r.state);
        ghosts.prevResAnchor[key] = r.anchorAmount;
        ghosts.prevResCumFee[key] = r.cumulativeReanchorFee;
        ghosts.prevNonce[key] = r.requestNonce;
        uint64 n = r.requestNonce;
        uint64 from =
            n > FIZZ_CURSOR_STEP ? n - uint64(FIZZ_CURSOR_STEP) + 1 : 1;
        for (uint64 g = from; g <= n; g++) {
            ghosts.prevActionState[key][g] = uint8(
                reservationRouter.reservationActions(key, g).state
            );
        }
    }

    /// @dev Tracks the anchor outpoint `(txHash, 0)` in `ghosts.knownUtxoKeys`
    ///      (capped) and latches `everSpent` once the Bridge marks it spent.
    function _reservationRouter_trackUtxo(bytes32 txHash) internal {
        if (txHash == bytes32(0)) return;
        uint256 k = _resProp_anchorKey(txHash, 0);
        if (!reservationRouter_utxoKnown[k]) {
            if (ghosts.knownUtxoKeys.length >= FIZZ_SCAN_CAP) return;
            reservationRouter_utxoKnown[k] = true;
            ghosts.knownUtxoKeys.push(k);
        }
        if (!ghosts.everSpent[k] && bridge.spentMainUTXOs(k))
            ghosts.everSpent[k] = true;
    }

    function _reservationRouter_pushHonest(
        bytes32 txHash,
        uint32 index,
        uint8 kind
    ) internal {
        if (ghosts.honestOutpoints.length >= FIZZ_SCAN_CAP) return;
        ghosts.honestOutpoints.push(
            HonestOutpoint({txHash: txHash, index: index, kind: kind})
        );
    }

    /// @dev `capsHold`: occupancy within every cap.
    function _reservationRouter_occupancyWithinCaps()
        internal
        view
        returns (bool)
    {
        (uint64 perWalletAmount, , uint32 maxActive, ) = reservationRouter
            .reservationCaps();
        (uint32 active, ) = reservationRouter.activeReservationsCount();
        if (active > maxActive) return false;
        uint256 maxTotal = _reservationRouter_param(
            reservationRouter_P_MAX_TOTAL
        );
        if (
            maxTotal != 0 &&
            _reservationRouter_param(_resProp_P_TOTAL) > maxTotal
        ) return false;
        uint256 maxPerWallet = _reservationRouter_param(
            reservationRouter_P_MAX_PER_WALLET
        );
        uint256 n =
            harnessWallets.length > FIZZ_SCAN_CAP
                ? FIZZ_SCAN_CAP
                : harnessWallets.length;
        for (uint256 i; i < n; i++) {
            bytes20 w = harnessWallets[i];
            if (
                uint256(reservationRouter.walletReservationsCount(w)) >
                maxPerWallet
            ) return false;
            if (
                perWalletAmount != 0 &&
                reservationRouter.walletReservationsAmount(w) > perWalletAmount
            ) return false;
        }
        return true;
    }

    /// @dev Request-time snapshot of the newest generation (SP-90).
    function _reservationRouter_recordActionImage(uint256 key) internal {
        uint64 nonce = reservationRouter.reservations(key).requestNonce;
        ghosts.actionImageHash[
            _resProp_actionImageKey(key, nonce)
        ] = _resProp_actionImage(key, nonce);
    }

    // ――― Reveal ghosts ―――

    function _reservationRouter_revealGhosts(
        uint256 key,
        uint256 locktime
    ) internal {
        ghosts.refundDeadline[key] = uint32(locktime);
        bool reserved = bridge.isReservedDeposit(key);
        if (reserved) ghosts.reservedDepositKeys.push(key);
        Deposit.DepositRequest memory d = bridge.deposits(key);
        ghosts.depositImageHash[key] = keccak256(
            abi.encode(
                d.depositor,
                d.amount,
                d.revealedAt,
                d.vault,
                d.treasuryFee,
                d.extraData,
                reserved
            )
        );
    }

    // ――― Flows ―――

    /// @dev Acceptance request of a flow: remembers the reserved total
    ///      (SP-53 flow clause) and returns the new nonce (0 = not requested).
    function _reservationRouter_flowRequest(
        uint256 idx
    ) internal returns (uint256 key, uint64 nonce) {
        _resProp_flowTotalBase = uint64(_resProp_param(_resProp_P_TOTAL));
        _resProp_flowBaseSet = true;
        return _reservationRouter_requestAcceptance(idx);
    }

    // ――― Acceptance proof ―――

    function _reservationRouter_acceptanceTx(
        uint256 key,
        uint64 nonce,
        uint64 fee,
        bool p2pkh
    ) internal view returns (bool found, BitcoinTx.Info memory anchorTx) {
        uint256 idx;
        (found, idx) = _reservationRouter_depositIndex(key);
        if (!found) return (false, anchorTx);
        Reservation.ReservationAction memory action = reservationRouter
            .reservationActions(key, nonce);
        anchorTx = _reservationRouter_singleOutputTx(
            harnessDeposits[idx].fundingTxHash,
            harnessDeposits[idx].outputIndex,
            action.amount > fee ? action.amount - fee : uint64(0),
            action.targetWalletPubKeyHash,
            p2pkh
        );
    }

    /// @dev SP-55 precondition: every condition under which the proof of the
    ///      builder's well-formed anchor tx must succeed.
    function _reservationRouter_acceptanceCompliant(
        uint256 key,
        uint64 nonce,
        uint64 fee
    ) internal view returns (bool) {
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        Reservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, nonce);
        if (
            !_reservationRouter_settleable(
                key,
                nonce,
                r,
                Reservation.ActionType.Acceptance
            )
        ) return false;
        if (fee > a.txMaxFee) return false;
        if ((a.amount > fee ? a.amount - fee : uint64(0)) < a.minAmount)
            return false;
        if (bridge.deposits(key).sweptAt != 0) return false;
        return bridge.isReservedDeposit(key);
    }

    /// @dev Submits an acceptance proof as the SPV maintainer, hooked with
    ///      snapshots, ghosts and properties. `probe`: swallow a revert and
    ///      hand `pre` to SP-55; otherwise the revert propagates.
    function _reservationRouter_acceptanceSubmit(
        BitcoinTx.Info memory txInfo,
        BitcoinTx.Proof memory proof,
        uint256 key,
        uint64 nonce,
        bool probe,
        bool pre
    ) internal returns (bool ok) {
        reservationRouter_ProofCtx
            memory c = _reservationRouter_acceptanceBegin(key, nonce);
        vm.startPrank(spvMaintainer);
        if (probe) {
            try
                reservationRouter.submitReservationAcceptanceProof(
                    txInfo,
                    proof,
                    key,
                    nonce
                )
            {
                ok = true;
            } catch {}
        } else {
            reservationRouter.submitReservationAcceptanceProof(
                txInfo,
                proof,
                key,
                nonce
            );
            ok = true;
        }
        vm.stopPrank();
        if (!ok) {
            ghosts.lastHandlerId = HID_NONE;
            _resProp_probePre = pre;
            property_acceptanceProofNeverBlocked();
            _resProp_probePre = false;
            return false;
        }
        _reservationRouter_acceptanceEnd(c, key);
    }

    function _reservationRouter_acceptanceBegin(
        uint256 key,
        uint64 nonce
    ) internal returns (reservationRouter_ProofCtx memory c) {
        Reservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, nonce);
        Deposit.DepositRequest memory d = bridge.deposits(key);
        c.late = a.state == Reservation.ActionState.TimedOut;
        c.depositor = d.depositor;
        c.trusted = d.vault != address(0) && bridge.isVaultTrusted(d.vault);
        c.bps =
            d.vault == address(reservationVault)
                ? reservationVault.initiationFeeBps()
                : type(uint16).max;
        _reservationRouter_begin(
            HID_ACCEPTANCE_PROOF,
            key,
            a.targetWalletPubKeyHash,
            bytes20(0),
            d.depositor
        );
    }

    function _reservationRouter_acceptanceEnd(
        reservationRouter_ProofCtx memory c,
        uint256 key
    ) internal {
        snapshotAfter();
        _reservationRouter_acceptanceGhosts(c, key);
        _tv_clearOp();
        property_optimisticDebtAttribution();
        property_depositRecordWriteOnce();
        ghosts.depositSweptAt[key] = bridge.deposits(key).sweptAt;
        property_acceptanceProofRecord();
        property_acceptanceCapacityAccounting();
        property_acceptanceCreditRouting();
        _tv_refreshOptDebt();
        _reservationRouter_hub(
            reservationRouter_HUB_DEBT | reservationRouter_HUB_POOL
        );
    }

    function _reservationRouter_acceptanceGhosts(
        reservationRouter_ProofCtx memory c,
        uint256 key
    ) internal {
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        (bool known, uint256 idx) = _reservationRouter_depositIndex(key);
        if (known) {
            harnessDeposits[idx].swept = true;
            _reservationRouter_pushHonest(
                harnessDeposits[idx].fundingTxHash,
                harnessDeposits[idx].outputIndex,
                0
            );
        }
        _reservationRouter_trackAnchor(key);
        _reservationRouter_pushHonest(r.anchorTxHash, 0, 1);

        ghosts.lateFlag = c.late;
        ghosts.lastAcceptance = LastAcceptance({
            depositor: c.depositor,
            anchorAmount: r.anchorAmount,
            key: key,
            trustedBefore: c.trusted,
            bpsBefore: c.bps
        });
        ghosts.bankIssuedSat += r.anchorAmount;
        ghosts.btcCustodySat += r.anchorAmount;
        if (c.trusted && c.bps != type(uint16).max) {
            ghosts.rvFeesRetainedWei +=
                (uint256(r.anchorAmount) * SATOSHI_MULTIPLIER * c.bps) / 10000;
        }
        if (ghosts.initialAnchor[key] == 0)
            ghosts.initialAnchor[key] = r.anchorAmount;
        if (ghosts.acceptedImageHash[key] == bytes32(0))
            ghosts.acceptedImageHash[key] = _resProp_acceptedImage(r);
    }

    // ――― Re-anchor request / proof ―――

    function _reservationRouter_reanchorRequestBegin(
        uint256 key,
        bytes20 target
    ) internal {
        _reservationRouter_begin(
            HID_REQUEST_REANCHOR,
            key,
            reservationRouter.reservations(key).walletPubKeyHash,
            target,
            address(0)
        );
    }

    function _reservationRouter_reanchorRequestEnd(uint256 key) internal {
        snapshotAfter();
        _reservationRouter_recordActionImage(key);
        property_reanchorRequestPostconditions();
        _reservationRouter_hub(0);
    }

    function _reservationRouter_reanchorTx(
        uint256 key,
        uint64 nonce,
        uint64 fee,
        bool p2pkh
    ) internal view returns (BitcoinTx.Info memory) {
        Reservation.ReservationRequest memory reservation = reservationRouter
            .reservations(key);
        Reservation.ReservationAction memory action = reservationRouter
            .reservationActions(key, nonce);
        return
            _reservationRouter_singleOutputTx(
                reservation.anchorTxHash,
                reservation.anchorTxOutputIndex,
                action.amount > fee ? action.amount - fee : uint64(0),
                action.targetWalletPubKeyHash,
                p2pkh
            );
    }

    /// @dev SP-61 precondition: settleable generation of this anchor, fee
    ///      within txMaxFee, new anchor above the dust floor, and the
    ///      financing vault reachable when a fee is paid.
    function _reservationRouter_reanchorCompliant(
        uint256 key,
        uint64 nonce,
        uint64 fee
    ) internal view returns (bool) {
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        Reservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, nonce);
        if (
            !_reservationRouter_settleable(
                key,
                nonce,
                r,
                Reservation.ActionType.Reanchor
            )
        ) return false;
        if (fee > a.txMaxFee) return false;
        uint64 newAnchor = a.amount > fee ? a.amount - fee : uint64(0);
        if (newAnchor <= a.txMaxFee) return false;
        if (fee != 0 && bridge.deposits(key).vault != address(reservationVault))
            return false;
        return true;
    }

    function _reservationRouter_reanchorSubmit(
        BitcoinTx.Info memory txInfo,
        BitcoinTx.Proof memory proof,
        uint256 key,
        uint64 nonce,
        bool probe,
        bool pre
    ) internal returns (bool ok) {
        reservationRouter_ProofCtx memory c = _reservationRouter_reanchorBegin(
            key,
            nonce
        );
        vm.startPrank(spvMaintainer);
        if (probe) {
            try
                reservationRouter.submitReservationReanchorProof(
                    txInfo,
                    proof,
                    key,
                    nonce
                )
            {
                ok = true;
            } catch {}
        } else {
            reservationRouter.submitReservationReanchorProof(
                txInfo,
                proof,
                key,
                nonce
            );
            ok = true;
        }
        vm.stopPrank();
        if (!ok) {
            ghosts.lastHandlerId = HID_NONE;
            _resProp_probePre = pre;
            property_reanchorProofNeverBlocked();
            _resProp_probePre = false;
            return false;
        }
        _reservationRouter_reanchorEnd(c, key);
    }

    function _reservationRouter_reanchorBegin(
        uint256 key,
        uint64 nonce
    ) internal returns (reservationRouter_ProofCtx memory c) {
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        Reservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, nonce);
        c.late =
            a.state == Reservation.ActionState.TimedOut ||
            r.state == Reservation.ReservationState.Stranded;
        c.depositor = r.owner;
        _reservationRouter_begin(
            HID_REANCHOR_PROOF,
            key,
            r.walletPubKeyHash,
            a.targetWalletPubKeyHash,
            r.owner
        );
    }

    function _reservationRouter_reanchorEnd(
        reservationRouter_ProofCtx memory c,
        uint256 key
    ) internal {
        snapshotAfter();
        _reservationRouter_reanchorGhosts(c);
        _reservationRouter_trackAnchor(key);
        property_reanchorProofSettlement();
        property_inKindFeeFinancing();
        property_reanchorGrindBounded();
        _reservationRouter_hub(
            reservationRouter_HUB_DEBT | reservationRouter_HUB_POOL
        );
    }

    function _reservationRouter_reanchorGhosts(
        reservationRouter_ProofCtx memory c
    ) internal {
        uint256 a0 = stateBefore.frAnchorAmount;
        uint256 a1 = stateAfter.frAnchorAmount;
        uint256 f = a0 > a1 ? a0 - a1 : 0;
        uint256 reserveSat =
            stateBefore.tbtcReservationVault / SATOSHI_MULTIPLIER;
        uint256 burned = f < reserveSat ? f : reserveSat;

        ghosts.lateFlag = c.late;
        ghosts.minerFeeSat += f;
        ghosts.btcCustodySat =
            ghosts.btcCustodySat > f ? ghosts.btcCustodySat - f : 0;
        ghosts.bankBurnedSat += burned;
        ghosts.rvFinanceBurnedSat += burned;
        ghosts.rvShortfallSat += f - burned;
        if (ghosts.consumedAnchors.length < FIZZ_SCAN_CAP) {
            ghosts.consumedAnchors.push(
                _resProp_anchorKey(stateBefore.frAnchorTxHash, 0)
            );
        }
        _reservationRouter_pushHonest(stateBefore.frAnchorTxHash, 0, 2);
        _reservationRouter_pushHonest(
            stateAfter.frAnchorTxHash,
            0,
            stateAfter.frState == _resProp_RS_STRANDED ? 3 : 1
        );
    }

    // ――― Secondary dispatcher hooks ―――

    /// @dev Start of an update-caps / update-parameters branch (focus-free snapshot).
    function _reservationRouter_updateBegin() internal {
        reservationRouter_secVaultBefore = address(
            uint160(_reservationRouter_param(reservationRouter_P_VAULT))
        );
        _reservationRouter_begin(
            HID_NONE,
            0,
            bytes20(0),
            bytes20(0),
            address(0)
        );
    }

    function _reservationRouter_updateEnd() internal {
        snapshotAfter();
        _resProp_vaultChanged =
            reservationRouter_secVaultBefore !=
            address(
                uint160(_reservationRouter_param(reservationRouter_P_VAULT))
            );
        ghosts.capsLoweredBelowOccupancy =
            !_reservationRouter_occupancyWithinCaps();
        property_reservationParamUpdateGuards();
        _resProp_vaultChanged = false;
    }

    /// @dev State-changing governance probe (SP-68) on every fourth secondary
    ///      call, then the access-control probes (SP-112, SP-113).
    function _reservationRouter_secondaryProbes(uint256 seed) internal {
        if (seed % 4 == 0) property_governanceCanClearPendingReservedDeposits();
        property_noPrivilegeEscalation();
        property_lifecycleRolesEnforced();
    }
}
