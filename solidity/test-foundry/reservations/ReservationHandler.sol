// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Vm} from "forge-std/Vm.sol";

import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";

import {ReservationInvariantHarness} from "./ReservationInvariantHarness.sol";
import {ReservationProperties} from "./ReservationProperties.sol";

/// @notice Fuzz entry point for the reservation state machine. Every
///         public non-property function is one fuzzer action; inputs are
///         seeds that the handler maps onto valid-looking calls. Reverts
///         are expected and swallowed: the properties judge the state.
/// @dev Deploys everything in the constructor so Medusa can use it as its
///      only target contract.
contract ReservationHandler is ReservationProperties {
    Vm internal constant vm = Vm(
        address(uint160(uint256(keccak256("hevm cheat code"))))
    );

    address internal constant THIRD_PARTY = address(0xBEEF);
    uint256 internal constant MAX_KEYS = 24;
    uint256 internal constant MAX_WALLETS = 8;

    uint256 internal nextTxId;

    // Successful calls per action, for campaign reports.
    mapping(string => uint256) public successes;

    constructor() {
        harness = new ReservationInvariantHarness();
        // Caps first: enabling the vault requires a positive active cap.
        harness.updateReservationCaps(3_000_000, 2_000_000, 4, 1, 1);
        harness.updateReservationParameters(
            100_000, // min amount
            10_000, // tx max fee
            90 days, // term
            7 days, // dissolution delay
            6_000_000, // max total amount
            2, // max reservations per wallet
            6 hours, // action timeout
            7 days // renewal window
        );
        for (uint256 i = 0; i < 4; i++) {
            addWalletInternal();
        }
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    function revealReservedDeposit(
        uint256 walletSeed,
        uint64 amountSeed,
        uint32 deadlineSeed
    ) external {
        if (keys.length >= MAX_KEYS) {
            return;
        }
        (uint64 amount, uint32 refundDeadline) = revealValues(
            amountSeed,
            deadlineSeed
        );
        bytes20 wallet = wallets[walletSeed % wallets.length];
        bytes32 fundingTxHash = keccak256(
            abi.encodePacked("funding", nextTxId++)
        );

        keys.push(
            harness.revealReservedDeposit(
                fundingTxHash,
                address(this),
                amount,
                wallet,
                refundDeadline
            )
        );
        successes["reveal"] += 1;
    }

    /// @dev The amount reaches up to 25% above the single cap, so the cap
    ///      check is exercised. The refund deadline leaves room for at
    ///      least one acceptance window plus the refund safety margin.
    function revealValues(
        uint64 amountSeed,
        uint32 deadlineSeed
    ) internal view returns (uint64 amount, uint32 refundDeadline) {
        (uint64 minAmount, uint64 txMaxFee, uint32 timeout) = harness
            .parameters();
        amount = minAmount + txMaxFee + (amountSeed % 2_500_000);
        refundDeadline =
            uint32(block.timestamp) +
            timeout +
            1 days +
            (deadlineSeed % 60 days);
    }

    function requestAcceptance(uint256 keySeed) external {
        if (keys.length == 0) return;
        uint256 key = keys[keySeed % keys.length];
        bytes20 wallet = harness.pendingReservedDepositWallet(key);
        try harness.requestReservationAcceptance(key, wallet) {
            successes["requestAcceptance"] += 1;
            checkCapsAfterAcceptance(key, wallet);
        } catch {}
    }

    function notifyAcceptanceTimedOut(uint256 keySeed) external {
        if (keys.length == 0) return;
        try
            harness.notifyReservationAcceptanceTimedOut(
                keys[keySeed % keys.length]
            )
        {
            successes["acceptanceTimedOut"] += 1;
        } catch {}
    }

    function proveAcceptance(
        uint256 keySeed,
        uint64 nonceSeed,
        uint64 feeSeed
    ) external {
        if (keys.length == 0) return;
        uint256 key = keys[keySeed % keys.length];
        uint64 latest = harness.reservation(key).requestNonce;
        if (latest == 0) return;
        uint64 nonce = 1 + (nonceSeed % latest);
        Reservation.ReservationAction memory a = harness.action(key, nonce);
        uint64 anchorAmount = a.amount - (feeSeed % (a.txMaxFee + 1));

        try
            harness.proveAcceptance(
                key,
                nonce,
                keccak256(abi.encodePacked("anchor", nextTxId++)),
                anchorAmount
            )
        returns (bool late) {
            ghostCreditedSat += anchorAmount;
            successes[late ? "proveAcceptanceLate" : "proveAcceptance"] += 1;
            recordTerminals(key);
        } catch {}
    }

    /// @param mode 0: the owner, 1: a third party, 2: governance.
    function requestReanchor(
        uint256 keySeed,
        uint256 targetSeed,
        uint8 mode
    ) external {
        if (keys.length == 0) return;
        uint256 key = keys[keySeed % keys.length];
        bytes20 target = wallets[targetSeed % wallets.length];
        mode = mode % 3;

        // A privileged request off a retiring (non-Live) source skips the
        // target's per-wallet caps on purpose, so the hand-off stays possible
        // when the target's own slots are full (Reservation.sol, hand-off
        // capacity). Every other request keeps them. Computed before the
        // prank, which applies to the next call only.
        bool exemptHandoff = mode != 1 &&
            !harness.isWalletLive(harness.reservation(key).walletPubKeyHash);

        if (mode == 1) {
            vm.prank(THIRD_PARTY);
        }
        try harness.requestReservationReanchor(key, target, mode == 2) {
            successes["requestReanchor"] += 1;
            checkCapsAfterReanchor(target, mode == 1, exemptHandoff);
        } catch {}
    }

    function notifyReanchorTimedOut(uint256 keySeed) external {
        if (keys.length == 0) return;
        try
            harness.notifyReservationActionTimeout(keys[keySeed % keys.length])
        {
            successes["reanchorTimedOut"] += 1;
        } catch {}
    }

    function proveReanchor(
        uint256 keySeed,
        uint64 nonceSeed,
        uint64 feeSeed
    ) external {
        if (keys.length == 0) return;
        uint256 key = keys[keySeed % keys.length];
        Reservation.ReservationRequest memory r = harness.reservation(key);
        if (r.requestNonce == 0) return;
        uint64 nonce = 1 + (nonceSeed % r.requestNonce);
        Reservation.ReservationAction memory a = harness.action(key, nonce);
        uint64 newAmount = a.amount - (feeSeed % (a.txMaxFee + 1));

        try
            harness.proveReanchor(
                key,
                nonce,
                keccak256(abi.encodePacked("reanchor", nextTxId++)),
                newAmount
            )
        returns (bool late) {
            ghostMinerFeeSat += r.anchorAmount - newAmount;
            successes[late ? "proveReanchorLate" : "proveReanchor"] += 1;
            recordTerminals(key);
        } catch {}
    }

    function notifyStranded(uint256 keySeed) external {
        if (keys.length == 0) return;
        try harness.notifyReservationStranded(keys[keySeed % keys.length]) {
            successes["stranded"] += 1;
        } catch {}
    }

    function retirePendingDeposit(uint256 keySeed, uint8 path) external {
        if (keys.length == 0) return;
        uint256 key = keys[keySeed % keys.length];
        path = path % 3;
        if (path == 0) {
            try harness.notifyStaleReservedDeposit(key) {
                successes["stale"] += 1;
            } catch {}
        } else if (path == 1) {
            try harness.forceStaleReservedDeposit(key) {
                successes["forceStale"] += 1;
            } catch {}
        } else {
            try harness.releaseReservedDepositToPool(key) {
                successes["releaseToPool"] += 1;
            } catch {}
        }
    }

    /// @dev Live -> MovingFunds -> Closing -> Closed, or any of the first
    ///      three -> Terminated.
    function advanceWallet(uint256 walletSeed, bool terminate) external {
        bytes20 wallet = wallets[walletSeed % wallets.length];
        Wallets.WalletState s = harness.walletState(wallet);
        if (
            s == Wallets.WalletState.Closed ||
            s == Wallets.WalletState.Terminated
        ) {
            return;
        }
        Wallets.WalletState next =
            terminate
                ? Wallets.WalletState.Terminated
                : Wallets.WalletState(uint8(s) + 1);
        harness.setWalletState(wallet, next);
        successes["advanceWallet"] += 1;
    }

    function addWallet() external {
        if (wallets.length >= MAX_WALLETS) return;
        addWalletInternal();
    }

    function updateCaps(
        uint64 perWalletAmountSeed,
        uint64 singleSeed,
        uint32 maxActiveSeed,
        uint32 holdsSeed,
        uint32 reserveSeed
    ) external {
        try
            harness.updateReservationCaps(
                perWalletAmountSeed % 6_000_000,
                singleSeed % 4_000_000,
                1 + (maxActiveSeed % 8),
                holdsSeed % 3,
                1 + (reserveSeed % 2)
            )
        {
            successes["updateCaps"] += 1;
        } catch {}
    }

    function updateLimits(uint32 perWalletSeed, uint64 totalSeed) external {
        try
            harness.updateReservationParameters(
                100_000,
                10_000,
                90 days,
                7 days,
                totalSeed % 12_000_000,
                1 + (perWalletSeed % 4),
                6 hours,
                7 days
            )
        {
            successes["updateLimits"] += 1;
        } catch {}
    }

    function warp(uint32 secondsSeed) external {
        vm.warp(block.timestamp + 1 + (secondsSeed % 3 days));
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function addWalletInternal() internal {
        bytes20 wallet = bytes20(uint160(0x1000 + wallets.length));
        harness.registerLiveWallet(wallet);
        wallets.push(wallet);
    }

    function checkCapsAfterAcceptance(uint256 key, bytes20 wallet) internal {
        if (
            !globalCapsHold() || !walletCapsHold(wallet) || !singleCapHolds(key)
        ) {
            capViolation = true;
        }
    }

    function checkCapsAfterReanchor(
        bytes20 target,
        bool thirdParty,
        bool exemptHandoff
    ) internal {
        if (
            (!exemptHandoff && !walletCapsHold(target)) ||
            (thirdParty && !thirdPartyHoldCapHolds(target))
        ) {
            capViolation = true;
        }
    }

    function globalCapsHold() internal view returns (bool) {
        (, , uint32 maxActive, , uint64 maxTotal, ) = harness.caps();
        (uint32 active, uint64 total, ) = harness.totals();
        return active <= maxActive && (maxTotal == 0 || total <= maxTotal);
    }

    function walletCapsHold(bytes20 wallet) internal view returns (bool) {
        (uint64 maxAmountPerWallet, , , , , uint32 maxPerWallet) = harness
            .caps();
        (uint32 count, uint64 amount) = harness.walletReservationInfo(wallet);
        return
            count <= maxPerWallet &&
            (maxAmountPerWallet == 0 || amount <= maxAmountPerWallet);
    }

    function singleCapHolds(uint256 key) internal view returns (bool) {
        (, uint64 maxSingle, , , , ) = harness.caps();
        return maxSingle == 0 || harness.deposit(key).amount <= maxSingle;
    }

    function thirdPartyHoldCapHolds(
        bytes20 target
    ) internal view returns (bool) {
        (, , , uint32 maxHolds, , ) = harness.caps();
        return harness.pendingThirdPartyReanchorHolds(target) <= maxHolds;
    }
}
