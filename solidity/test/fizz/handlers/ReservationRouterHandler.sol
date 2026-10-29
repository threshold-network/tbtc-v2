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
        _reservationRouter_hub(0);
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
        // The only reveal path that creates a reserved deposit,
        // so the reserved-deposit branch runs only here.
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

    /// @dev Builds the 1-input (deposit outpoint) 1-output (designated
    ///      wallet) anchor tx for generation `nonce` and proves it through
    ///      the probing submit (a compliant proof must not revert).
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
    uint8 internal constant reservationRouter_HUB_DEBT = 1;
    uint8 internal constant reservationRouter_HUB_POOL = 2;

    /// @dev Pre-call context of a proof handler (memory bag, keeps stacks small).
    struct reservationRouter_ProofCtx {
        bool late;
        bool trusted;
        uint16 bps;
        address depositor;
    }

    /// @dev Anchor outpoint keys already pushed to `ghosts.knownUtxoKeys` here.
    mapping(uint256 => bool) internal reservationRouter_utxoKnown;

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
    function _reservationRouter_hubLedger() internal {}

    /// @dev HUB_RES_STATE: per-key checks (focus key + cursor window).
    function _reservationRouter_hubState() internal {}

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
        if (flags & reservationRouter_HUB_DEBT != 0) {}
        if (flags & reservationRouter_HUB_POOL != 0) {}
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

    /// @dev Request-time snapshot of the newest generation.
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
    ///      and returns the new nonce (0 = not requested).
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

    /// @dev Precondition: every condition under which the proof of the
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
    ///      hand `pre` to the pre-check; otherwise the revert propagates.
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
        ghosts.depositSweptAt[key] = bridge.deposits(key).sweptAt;
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
}
