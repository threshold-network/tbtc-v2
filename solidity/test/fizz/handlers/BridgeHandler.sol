// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";
import {Deposit} from "../../../contracts/bridge/Deposit.sol";
import {Wallets} from "../../../contracts/bridge/Wallets.sol";
import {Redemption} from "../../../contracts/bridge/Redemption.sol";
import {MovingFunds} from "../../../contracts/bridge/MovingFunds.sol";
import {Reservation} from "../../../contracts/bridge/Reservation.sol";

/// @notice Handles the interaction with Bridge.
///
/// @dev Bitcoin side of the system is simulated with `BtcBuilder`: every
///      clamped proof handler builds a Bitcoin transaction that the Bridge
///      accepts, proves it with `BtcBuilder.prove` and submits it as the SPV
///      maintainer. The Bridge stores only hashes, so the preimages live in
///      the Base bookkeeping (`harnessDeposits`, `harnessMainUtxo`,
///      `harnessRedemptions`, `harnessWallets`) and in the handler-local state
///      below. Handlers read the Bridge views before building a transaction and
///      skip (return) whenever the harness view of a wallet is out of sync with
///      the Bridge, so a desynchronised wallet never turns into a reverting
///      handler.
///
///      Bookkeeping semantics kept by this file:
///      - `harnessMainUtxo[w]` is the preimage of `wallets(w).mainUtxoHash`
///        (zero struct when the Bridge has no main UTXO),
///      - `harnessDeposits[i].swept` is set after a sweep proof (or lazily when
///        the Bridge reports `sweptAt != 0`),
///      - `harnessRedemptions[i].closed` is set once the Bridge has neither a
///        pending nor a timed-out request for it (proven or vetoed). A timed-out
///        request is NOT closed: the wallet can still pay it in a later proof.
abstract contract BridgeHandler is Properties {
    // ――――――――――――――――――――――――― Constants ――――――――――――――――――――――――――

    // Bit masks over `Wallets.WalletState` (Unknown, Live, MovingFunds,
    // Closing, Closed, Terminated).
    uint256 internal constant bridge_LIVE = 1 << 1;
    uint256 internal constant bridge_MOVING_FUNDS = 1 << 2;
    uint256 internal constant bridge_CLOSING = 1 << 3;
    uint256 internal constant bridge_TERMINATED = 1 << 5;

    // Eligibility kinds of `_bridge_eligible`.
    uint8 internal constant bridge_KIND_COMMITMENT = 0;
    uint8 internal constant bridge_KIND_MOVING_PROOF = 1;
    uint8 internal constant bridge_KIND_MOVING_TIMEOUT = 2;
    uint8 internal constant bridge_KIND_BELOW_DUST = 3;
    uint8 internal constant bridge_KIND_RESET = 4;
    uint8 internal constant bridge_KIND_CLOSING_ELAPSED = 5;
    uint8 internal constant bridge_KIND_CLOSEABLE = 6;

    // Fee modes of the proof builders.
    uint8 internal constant bridge_FEE_RANDOM = 0;
    uint8 internal constant bridge_FEE_ZERO = 1;
    uint8 internal constant bridge_FEE_MAX = 2;
    uint8 internal constant bridge_FEE_OVER = 3;
    // Redemption proofs only: total fee one satoshi above the maximum.
    uint8 internal constant bridge_FEE_OVER_TOTAL = 4;

    uint256 internal constant bridge_SCAN_LIMIT = 64;
    uint256 internal constant bridge_MAX_BATCH = 5;
    /// @dev Refund locktime offset (seconds) from `block.timestamp`: above the
    ///      500M threshold and above any reveal-ahead period the setters allow.
    uint256 internal constant bridge_LOCKTIME_OFFSET = 600_000_000;
    uint256 internal constant bridge_SPENT_RING = 256;

    // ―――――――――――――――――――――――――― State ――――――――――――――――――――――――――――

    /// @dev Moved funds sweep request created by a proven moving funds tx.
    struct bridge_MovedFunds {
        bytes32 txHash;
        uint32 outputIndex;
        bytes20 target;
        uint64 value;
    }

    /// @dev Fraud challenge submitted by `bridge_submitFraudChallenge_clamped`.
    ///      `preimage` is the heartbeat message when `heartbeat` is set.
    struct bridge_Challenge {
        bytes20 walletPkh;
        bytes walletPublicKey;
        bytes preimage;
        bytes32 preimageSha256;
        bool witness;
        bool heartbeat;
        uint256 utxoKey;
    }

    struct bridge_SweepPlan {
        bytes20 wallet;
        address vault;
        BitcoinTx.UTXO main;
        uint256[] picked;
        uint256 inputsTotal;
        uint256 minNet;
    }

    struct bridge_RedemptionPlan {
        bytes20 wallet;
        BitcoinTx.UTXO main;
        uint256[] picked;
        uint64[] values;
        uint256 sumOut;
    }

    struct bridge_Eligible {
        uint256 key;
        uint256 redeemable;
        uint64 txMaxFee;
    }

    struct bridge_MovingParams {
        uint64 txMaxTotalFee;
        uint64 dust;
        uint32 resetDelay;
        uint32 timeout;
        uint64 sweepTxMaxTotalFee;
        uint32 sweepTimeout;
    }

    struct bridge_RedemptionParams {
        uint64 dust;
        uint64 divisor;
        uint64 txMaxFee;
        uint64 txMaxTotalFee;
        uint32 timeout;
    }

    struct bridge_WalletParams {
        uint32 creationPeriod;
        uint64 creationMin;
        uint64 creationMax;
        uint64 closureMin;
        uint32 maxAge;
        uint64 maxTransfer;
        uint32 closingPeriod;
    }

    bridge_MovedFunds[] internal bridge_movedFunds;
    bridge_Challenge[] internal bridge_challenges;
    /// @dev Ring buffer of main UTXOs spent by proven transactions; honest
    ///      material for fraud challenge preimages.
    BitcoinTx.UTXO[] internal bridge_spentMainUtxos;
    /// @dev Target wallets commitment of a wallet in MovingFunds state.
    mapping(bytes20 => bytes20[]) internal bridge_commitments;
    /// @dev Makes every generated Bitcoin transaction unique.
    uint256 internal bridge_nonce;
    /// @dev Target wallets of the moving funds proof under test (hook context, see `bridge_hook`).
    bytes20[] internal bridge_hookTargets;

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    // ―――― Deposits ――――

    function bridge_revealDeposit_clamped(
        uint256 walletSeed,
        uint64 amount,
        uint256 seed
    ) public {
        _bridge_revealClamped(walletSeed, amount, seed, bytes32(0), 0);
    }

    function bridge_revealDepositWithExtraData_clamped(
        uint256 walletSeed,
        uint64 amount,
        bytes32 extraData,
        uint256 seed
    ) public {
        if (extraData == bytes32(0))
            extraData = keccak256(abi.encodePacked("fizz.extraData", seed));
        _bridge_revealClamped(walletSeed, amount, seed, extraData, 0);
    }

    /// @dev Near-zero stress: amount within 2 satoshi of the dust threshold
    ///      (`amount / depositTreasuryFeeDivisor` truncation boundary).
    function bridge_revealDeposit_nearDust(
        uint256 walletSeed,
        uint64 offset,
        uint256 seed
    ) public {
        bytes32 extraData =
            seed % 2 == 0
                ? bytes32(0)
                : keccak256(abi.encodePacked("fizz.extraData", seed));
        _bridge_revealClamped(walletSeed, offset, seed, extraData, 1);
    }

    /// @dev Full-amount stress: the largest amount allowed by the clamp bound.
    function bridge_revealDeposit_fullAmount(
        uint256 walletSeed,
        uint256 seed
    ) public {
        _bridge_revealClamped(walletSeed, 0, seed, bytes32(0), 3);
    }

    /// @dev Type-boundary stress: uint64 satoshi amount close to its maximum.
    function bridge_revealDeposit_typeBoundary(
        uint256 walletSeed,
        uint64 offset,
        uint256 seed
    ) public {
        _bridge_revealClamped(walletSeed, offset, seed, bytes32(0), 2);
    }

    // ―――― Deposit sweeps ――――

    function bridge_submitDepositSweepProof_clamped(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed
    ) public {
        _bridge_sweepClamped(walletSeed, count, feeSeed, bridge_FEE_RANDOM);
    }

    /// @dev Boundary stress: total fee exactly at the `depositTxMaxFee` limit
    ///      (including the indivisible remainder charged to the last deposit).
    function bridge_submitDepositSweepProof_maxFee(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed
    ) public {
        _bridge_sweepClamped(walletSeed, count, feeSeed, bridge_FEE_MAX);
    }

    /// @dev Near-zero stress: sweep that pays no Bitcoin fee at all.
    function bridge_submitDepositSweepProof_zeroFee(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed
    ) public {
        _bridge_sweepClamped(walletSeed, count, feeSeed, bridge_FEE_ZERO);
    }

    /// @dev Boundary stress: per-deposit fee one satoshi above the limit.
    function bridge_submitDepositSweepProof_overMaxFee(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed
    ) public {
        _bridge_sweepClamped(walletSeed, count, feeSeed, bridge_FEE_OVER);
    }

    // ―――― Redemptions ――――

    function bridge_requestRedemption_clamped(
        uint256 walletSeed,
        uint256 scriptSeed,
        uint256 amount
    ) public {
        _bridge_requestRedemptionClamped(walletSeed, scriptSeed, amount, 0);
    }

    /// @dev Near-zero stress: exactly the redemption dust threshold.
    function bridge_requestRedemption_dust(
        uint256 walletSeed,
        uint256 scriptSeed
    ) public {
        _bridge_requestRedemptionClamped(walletSeed, scriptSeed, 0, 1);
    }

    /// @dev Full-amount stress: everything the actor's Bank balance and the
    ///      wallet's unreserved main UTXO value allow.
    function bridge_requestRedemption_full(
        uint256 walletSeed,
        uint256 scriptSeed
    ) public {
        _bridge_requestRedemptionClamped(walletSeed, scriptSeed, 0, 2);
    }

    function bridge_submitRedemptionProof_clamped(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed
    ) public {
        _bridge_redemptionProofClamped(
            walletSeed,
            count,
            feeSeed,
            bridge_FEE_RANDOM
        );
    }

    /// @dev Boundary stress: every output pays the minimum accepted value and
    ///      the transaction fee is the maximum accepted one.
    function bridge_submitRedemptionProof_maxFee(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed
    ) public {
        _bridge_redemptionProofClamped(
            walletSeed,
            count,
            feeSeed,
            bridge_FEE_MAX
        );
    }

    /// @dev Boundary stress: first output one satoshi below the accepted range.
    function bridge_submitRedemptionProof_overOutputFee(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed
    ) public {
        _bridge_redemptionProofClamped(
            walletSeed,
            count,
            feeSeed,
            bridge_FEE_OVER
        );
    }

    /// @dev Boundary stress: total fee one satoshi above `redemptionTxMaxTotalFee`.
    function bridge_submitRedemptionProof_overTotalFee(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed
    ) public {
        _bridge_redemptionProofClamped(
            walletSeed,
            count,
            feeSeed,
            bridge_FEE_OVER_TOTAL
        );
    }

    function bridge_notifyRedemptionTimeout_clamped(
        uint256 redemptionSeed,
        uint256 membersSeed
    ) public {
        (bool found, uint256 idx) = _bridge_pickTimedOutRedemption(
            redemptionSeed
        );
        if (!found) return;
        HarnessRedemption storage r = harnessRedemptions[idx];
        bridge_notifyRedemptionTimeout(
            r.walletPkh,
            _bridge_members(membersSeed),
            r.redeemerOutputScript
        );
    }

    // ―――― Wallet lifecycle ――――

    function bridge_requestNewWallet_clamped() public {
        bytes20 active = bridge.activeWalletPubKeyHash();
        BitcoinTx.UTXO memory main;
        if (active != bytes20(0)) {
            bool ok;
            (ok, main) = _bridge_mainUtxo(active);
            if (!ok) return;
        }
        bridge_requestNewWallet(main);
    }

    /// @dev Registers the next unused harness wallet key through the registry
    ///      mock (the registry is the only authorized callback caller) and
    ///      records it. The registry does not enforce a prior request, so this
    ///      is also reachable on its own.
    function bridge___ecdsaWalletCreatedCallback_clamped(
        bytes32 ecdsaWalletID
    ) public {
        (bool found, uint256 keyIndex, ) = _bridge_nextWalletKey();
        if (!found) return;
        _bridge_registerWallet(ecdsaWalletID, keyIndex, true);
    }

    /// @dev Full wallet creation flow: request (spending the active wallet main
    ///      UTXO as the Bridge requires) followed by the registry callback.
    function bridge_requestAndCreateWallet_clamped(
        bytes32 ecdsaWalletID
    ) public {
        bridge_requestNewWallet_clamped();
        bridge___ecdsaWalletCreatedCallback_clamped(ecdsaWalletID);
    }

    function bridge_notifyWalletCloseable_clamped(uint256 walletSeed) public {
        (bool found, bytes20 w) = _bridge_pickEligible(
            walletSeed,
            bridge_KIND_CLOSEABLE
        );
        if (!found) return;
        (, BitcoinTx.UTXO memory main) = _bridge_mainUtxo(w);
        bridge_notifyWalletCloseable(w, main);
    }

    function bridge_notifyWalletClosingPeriodElapsed_clamped(
        uint256 walletSeed
    ) public {
        (bool found, bytes20 w) = _bridge_pickEligible(
            walletSeed,
            bridge_KIND_CLOSING_ELAPSED
        );
        if (!found) return;
        bridge_notifyWalletClosingPeriodElapsed(w);
    }

    // ―――― Moving funds ――――

    function bridge_submitMovingFundsCommitment_clamped(
        uint256 walletSeed,
        uint256 pickSeed,
        uint256 membersSeed
    ) public {
        (bool found, bytes20 w) = _bridge_pickEligible(
            walletSeed,
            bridge_KIND_COMMITMENT
        );
        if (!found) return;
        (, BitcoinTx.UTXO memory main) = _bridge_mainUtxo(w);
        (bool ok, bytes20[] memory targets) = _bridge_targets(
            w,
            main.txOutputValue,
            pickSeed
        );
        if (!ok) return;
        uint32[] memory ids = _bridge_members(membersSeed);
        bridge_submitMovingFundsCommitment(
            w,
            main,
            ids,
            1 + ((membersSeed >> 8) % ids.length),
            targets
        );
    }

    function bridge_submitMovingFundsProof_clamped(
        uint256 walletSeed,
        uint256 feeSeed
    ) public {
        _bridge_movingFundsProofClamped(walletSeed, feeSeed, bridge_FEE_RANDOM);
    }

    /// @dev Boundary stress: fee exactly `movingFundsTxMaxTotalFee`.
    function bridge_submitMovingFundsProof_maxFee(
        uint256 walletSeed,
        uint256 feeSeed
    ) public {
        _bridge_movingFundsProofClamped(walletSeed, feeSeed, bridge_FEE_MAX);
    }

    /// @dev Boundary stress: fee one satoshi above `movingFundsTxMaxTotalFee`.
    function bridge_submitMovingFundsProof_overMaxFee(
        uint256 walletSeed,
        uint256 feeSeed
    ) public {
        _bridge_movingFundsProofClamped(walletSeed, feeSeed, bridge_FEE_OVER);
    }

    function bridge_notifyMovingFundsTimeout_clamped(
        uint256 walletSeed,
        uint256 membersSeed
    ) public {
        (bool found, bytes20 w) = _bridge_pickEligible(
            walletSeed,
            bridge_KIND_MOVING_TIMEOUT
        );
        if (!found) return;
        bridge_notifyMovingFundsTimeout(w, _bridge_members(membersSeed));
    }

    function bridge_notifyMovingFundsBelowDust_clamped(
        uint256 walletSeed
    ) public {
        (bool found, bytes20 w) = _bridge_pickEligible(
            walletSeed,
            bridge_KIND_BELOW_DUST
        );
        if (!found) return;
        (, BitcoinTx.UTXO memory main) = _bridge_mainUtxo(w);
        bridge_notifyMovingFundsBelowDust(w, main);
    }

    function bridge_submitMovedFundsSweepProof_clamped(
        uint256 requestSeed,
        uint256 feeSeed
    ) public {
        _bridge_movedFundsSweepClamped(requestSeed, feeSeed, bridge_FEE_RANDOM);
    }

    /// @dev Boundary stress: fee exactly `movedFundsSweepTxMaxTotalFee`.
    function bridge_submitMovedFundsSweepProof_maxFee(
        uint256 requestSeed,
        uint256 feeSeed
    ) public {
        _bridge_movedFundsSweepClamped(requestSeed, feeSeed, bridge_FEE_MAX);
    }

    function bridge_notifyMovedFundsSweepTimeout_clamped(
        uint256 requestSeed,
        uint256 membersSeed
    ) public {
        (bool found, uint256 i) = _bridge_pickMovedFunds(requestSeed, true);
        if (!found) return;
        bridge_MovedFunds memory mf = bridge_movedFunds[i];
        bridge_notifyMovedFundsSweepTimeout(
            mf.txHash,
            mf.outputIndex,
            _bridge_members(membersSeed)
        );
    }

    /// @dev Vacuity F1: a moving-funds proof followed in the same call by a
    ///      sweep proof (even `mode`) or, after the sweep timeout, a sweep
    ///      timeout (odd `mode`) of one of the moved-funds requests it created.
    ///      Separate calls almost never chain these (15 proofs in 500k calls),
    ///      so the sweep clauses of SP-103 never ran.
    function bridge_movingFundsThenSweep_flow(
        uint256 walletSeed,
        uint256 feeSeed,
        uint256 requestSeed,
        uint256 mode
    ) public {
        uint256 n0 = bridge_movedFunds.length;
        _bridge_movingFundsProofClamped(walletSeed, feeSeed, bridge_FEE_RANDOM);
        uint256 added = bridge_movedFunds.length - n0;
        if (added == 0) return;
        uint256 pick = n0 + (requestSeed % added);
        if (mode % 2 == 0) {
            _bridge_movedFundsSweepClamped(
                pick,
                feeSeed >> 64,
                bridge_FEE_RANDOM
            );
        } else {
            skipTime(uint256(_bridge_movingParams().sweepTimeout) + 1);
            bridge_notifyMovedFundsSweepTimeout_clamped(pick, feeSeed >> 128);
        }
    }

    /// @dev Vacuity F1: Medusa optimization objective that steers sequences
    ///      toward settled moved-funds sweeps. Active only when the Medusa
    ///      config enables `optimizationTesting`.
    function optimize_movedFundsSweepDepth() public view returns (int256) {
        return int256(ghosts.sweepsSettled);
    }

    // ―――― Fraud ――――

    /// @dev `kind`: 0 honest witness preimage of a swept deposit, 1 honest
    ///      non-witness preimage of a spent main UTXO, 2 witness preimage of an
    ///      unspent main UTXO, 3 heartbeat message, 4 random outpoint. The
    ///      signature is produced with the wallet key and the deposit is paid
    ///      by the actor.
    function bridge_submitFraudChallenge_clamped(
        uint256 walletSeed,
        uint8 kind,
        uint256 seed
    ) public {
        (bool found, bytes20 w) = _bridge_pickWallet(
            walletSeed,
            bridge_LIVE | bridge_MOVING_FUNDS | bridge_CLOSING
        );
        if (!found) return;
        bridge_Challenge memory c = _bridge_buildChallenge(w, kind % 5, seed);
        _bridge_submitChallenge(c, seed);
    }

    function bridge_defeatFraudChallenge_clamped(uint256 challengeSeed) public {
        (bool found, uint256 idx) = _bridge_pickChallenge(challengeSeed, 0);
        if (!found) return;
        bridge_Challenge storage c = bridge_challenges[idx];
        bridge_defeatFraudChallenge(c.walletPublicKey, c.preimage, c.witness);
    }

    function bridge_notifyFraudChallengeDefeatTimeout_clamped(
        uint256 challengeSeed,
        uint256 membersSeed
    ) public {
        (bool found, uint256 idx) = _bridge_pickChallenge(challengeSeed, 2);
        if (!found) return;
        bridge_Challenge storage c = bridge_challenges[idx];
        bridge_notifyFraudChallengeDefeatTimeout(
            c.walletPublicKey,
            _bridge_members(membersSeed),
            abi.encodePacked(c.preimageSha256)
        );
    }

    // ―――― Donations ――――

    /// @dev The Bridge holds the fraud challenge deposits in ETH.
    function bridge_donateETH(uint256 amount) public {
        if (actor.balance == 0) return;
        amount = clampBetween(amount, 1, actor.balance);
        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();
        Actor(payable(actor)).forceSendETH(address(bridge), amount);
        snapshotAfter();
        ghosts.ethDonatedToBridgeWei += amount;
        ghosts.anyDonation = true;
        property_fraudEthEscrow();
    }

    /// @dev The Bridge holds the escrowed redemption amounts as Bank balance.
    function bridge_donateBank(uint256 amount) public asActor {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();
        bank.transferBalance(address(bridge), amount);
        snapshotAfter();
        ghosts.bankDonatedToBridgeSat += amount;
        ghosts.anyDonation = true;
        property_noValueCreationByActor();
    }

    // ―――― Secondary dispatcher ――――

    /// @dev Twelve parameters is the most an external function can decode with
    ///      the legacy code generator (no `viaIR`), hence `arg0..arg9` and the
    ///      single address `arg10`.
    function bridge_secondary(
        uint8 selector,
        uint256 arg0,
        uint256 arg1,
        uint256 arg2,
        uint256 arg3,
        uint256 arg4,
        uint256 arg5,
        uint256 arg6,
        uint256 arg7,
        uint256 arg8,
        uint256 arg9,
        address arg10
    ) public {
        selector = uint8(selector % 11);
        _bridge_secondaryPre(selector, arg0);
        if (selector == 0) _bridge_heartbeatFailedClamped(arg0);
        else if (selector == 1) _bridge_defeatHeartbeatClamped(arg0);
        else if (selector == 2) _bridge_resetMovingFundsTimeoutClamped(arg0);
        else if (selector == 3) _bridge_setVaultStatusClamped(arg10, arg0);
        else if (selector == 4)
            _bridge_setSpvMaintainerStatusClamped(arg10, arg0);
        else if (selector == 5)
            _bridge_updateDepositParametersClamped(arg0, arg1, arg2, arg3);
        else if (selector == 6)
            _bridge_updateRedemptionParametersClamped(
                arg0,
                arg1,
                arg2,
                arg3,
                arg4,
                arg5,
                arg6
            );
        else if (selector == 7)
            _bridge_updateMovingFundsParametersClamped(
                arg0,
                arg1,
                arg2,
                arg3,
                arg4,
                arg5,
                arg6,
                arg7,
                arg8,
                arg9
            );
        else if (selector == 8)
            _bridge_updateWalletParametersClamped(
                arg0,
                arg1,
                arg2,
                arg3,
                arg4,
                arg5,
                arg6
            );
        else if (selector == 9)
            _bridge_updateFraudParametersClamped(arg0, arg1, arg2, arg3);
        else _bridge_updateTreasuryClamped(arg10, arg0);
        _bridge_secondaryPost(selector);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function bridge_revealDeposit(
        BitcoinTx.Info memory fundingTx,
        Deposit.DepositRevealInfo memory reveal
    ) public asActor {
        _bridge_reveal(fundingTx, reveal, false, bytes32(0));
    }

    function bridge_revealDepositWithExtraData(
        BitcoinTx.Info memory fundingTx,
        Deposit.DepositRevealInfo memory reveal,
        bytes32 extraData
    ) public asActor {
        _bridge_reveal(fundingTx, reveal, true, extraData);
    }

    function bridge_submitDepositSweepProof(
        BitcoinTx.Info memory sweepTx,
        BitcoinTx.Proof memory sweepProof,
        BitcoinTx.UTXO memory mainUtxo,
        address vault
    ) public asSpvMaintainer {
        bool hooked = _bridge_sweepPre(sweepTx, mainUtxo, vault);
        bridge.submitDepositSweepProof(sweepTx, sweepProof, mainUtxo, vault);
        if (hooked) _bridge_sweepPost();
    }

    /// @dev Hook pipeline shared with the TokenVault redemption handlers (`_tv_redeem*`).
    function bridge_requestRedemption(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO memory mainUtxo,
        bytes memory redeemerOutputScript,
        uint64 amount
    ) public asActor {
        if (_tv_pendingRedemptionCount() >= FIZZ_SCAN_CAP) return;
        _bridge_resetHook();
        bridge_hook.directRebate = true;
        TvRedeem memory r = _tv_redeemBefore(
            actor,
            _tv_otherActor(),
            amount,
            abi.encode(
                actor,
                walletPubKeyHash,
                mainUtxo.txHash,
                mainUtxo.txOutputIndex,
                mainUtxo.txOutputValue,
                redeemerOutputScript
            )
        );
        snapshotBefore();
        r.pre = _tv_redeemPre(
            r,
            bank.allowance(actor, address(bridge)) >= amount
        );
        try
            bridge.requestRedemption(
                walletPubKeyHash,
                mainUtxo,
                redeemerOutputScript,
                amount
            )
        {} catch {
            _tv_redeemBlocked(r);
        }
        _recordRedemption(
            walletPubKeyHash,
            redeemerOutputScript,
            actor,
            amount
        );
        snapshotAfter();
        _tv_setOp(TvKind.None, actor, address(0), amount);
        tvOp.key = r.key;
        _tv_redeemAfter(r);
        property_noUnauthorizedBalanceChange();
        _tv_redeemProps();
        _tv_redeemRefresh(r);
        _tv_clearOp();
        bridge_hook.directRebate = false;
    }

    function bridge_submitRedemptionProof(
        BitcoinTx.Info memory redemptionTx,
        BitcoinTx.Proof memory redemptionProof,
        BitcoinTx.UTXO memory mainUtxo,
        bytes20 walletPubKeyHash
    ) public asSpvMaintainer {
        bool hooked = _bridge_redemptionPre(
            redemptionTx,
            mainUtxo,
            walletPubKeyHash
        );
        bridge.submitRedemptionProof(
            redemptionTx,
            redemptionProof,
            mainUtxo,
            walletPubKeyHash
        );
        if (hooked) _bridge_redemptionPost();
    }

    function bridge_notifyRedemptionTimeout(
        bytes20 walletPubKeyHash,
        uint32[] memory walletMembersIDs,
        bytes memory redeemerOutputScript
    ) public asActor {
        _bridge_redemptionTimeout(
            walletPubKeyHash,
            walletMembersIDs,
            redeemerOutputScript
        );
    }

    function bridge_requestNewWallet(
        BitcoinTx.UTXO memory activeWalletMainUtxo
    ) public asActor {
        bridge.requestNewWallet(activeWalletMainUtxo);
    }

    /// @dev Only the registry may call the callback. The raw coordinates are
    ///      mapped onto a harness wallet key (`publicKeyX % keys`; `publicKeyY`
    ///      is ignored) so that every registered wallet is in `harnessWallets`
    ///      and has a signing key; an already registered wallet is skipped.
    function bridge___ecdsaWalletCreatedCallback(
        bytes32 ecdsaWalletID,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) public {
        publicKeyY;
        uint256 keyIndex = uint256(publicKeyX) % walletPrivKeys.length;
        bytes20 pkh = BtcBuilder.pubKeyHash(
            walletPubX[keyIndex],
            walletPubY[keyIndex]
        );
        if (bridge.wallets(pkh).state != Wallets.WalletState.Unknown) return;
        _bridge_registerWallet(ecdsaWalletID, keyIndex, false);
    }

    function bridge_notifyWalletCloseable(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO memory walletMainUtxo
    ) public asActor {
        _bridge_hubBegin(
            walletPubKeyHash,
            true,
            bridge_MK_CLOSEABLE,
            _bridge_mainValueOf(walletPubKeyHash, walletMainUtxo)
        );
        bridge.notifyWalletCloseable(walletPubKeyHash, walletMainUtxo);
        snapshotAfter();
        property_moveFundsRouting();
        property_closeabilityCountsAnchors();
        property_pendingSweepTargetsProcessable();
        _bridge_walletPost();
    }

    function bridge_notifyWalletClosingPeriodElapsed(
        bytes20 walletPubKeyHash
    ) public asActor {
        _bridge_hubBegin(walletPubKeyHash, false, 0, 0);
        bridge.notifyWalletClosingPeriodElapsed(walletPubKeyHash);
        snapshotAfter();
        property_walletClosing();
        _bridge_walletPost();
    }

    function bridge_submitMovingFundsCommitment(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO memory walletMainUtxo,
        uint32[] memory walletMembersIDs,
        uint256 walletMemberIndex,
        bytes20[] memory targetWallets
    ) public asActor {
        _bridge_hubBegin(walletPubKeyHash, false, bridge_MK_COMMITMENT, 0);
        bridge_hook.commitBefore = bridge
            .wallets(walletPubKeyHash)
            .movingFundsTargetWalletsCommitmentHash;
        bridge.submitMovingFundsCommitment(
            walletPubKeyHash,
            walletMainUtxo,
            walletMembersIDs,
            walletMemberIndex,
            targetWallets
        );
        // The Bridge accepted the commitment: it is exactly `targetWallets`.
        bridge_commitments[walletPubKeyHash] = targetWallets;
        snapshotAfter();
        property_movingFundsExits();
        _bridge_walletPost();
    }

    function bridge_submitMovingFundsProof(
        BitcoinTx.Info memory movingFundsTx,
        BitcoinTx.Proof memory movingFundsProof,
        BitcoinTx.UTXO memory mainUtxo,
        bytes20 walletPubKeyHash
    ) public asSpvMaintainer {
        uint8 mode = _bridge_movingProofPre(
            movingFundsTx,
            mainUtxo,
            walletPubKeyHash
        );
        if (mode == 0) return;
        bridge.submitMovingFundsProof(
            movingFundsTx,
            movingFundsProof,
            mainUtxo,
            walletPubKeyHash
        );
        if (mode == 1) _bridge_movingProofPost();
    }

    function bridge_notifyMovingFundsTimeout(
        bytes20 walletPubKeyHash,
        uint32[] memory walletMembersIDs
    ) public asActor {
        _bridge_hubBegin(walletPubKeyHash, false, bridge_MK_TIMEOUT, 0);
        bridge.notifyMovingFundsTimeout(walletPubKeyHash, walletMembersIDs);
        snapshotAfter();
        property_movingFundsExits();
        _bridge_walletPost();
    }

    function bridge_notifyMovingFundsBelowDust(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO memory mainUtxo
    ) public asActor {
        _bridge_hubBegin(
            walletPubKeyHash,
            false,
            bridge_MK_BELOW_DUST,
            _bridge_mainValueOf(walletPubKeyHash, mainUtxo)
        );
        bridge.notifyMovingFundsBelowDust(walletPubKeyHash, mainUtxo);
        snapshotAfter();
        property_movingFundsExits();
        property_closeabilityCountsAnchors();
        property_pendingSweepTargetsProcessable();
        _bridge_walletPost();
    }

    function bridge_submitMovedFundsSweepProof(
        BitcoinTx.Info memory sweepTx,
        BitcoinTx.Proof memory sweepProof,
        BitcoinTx.UTXO memory mainUtxo
    ) public asSpvMaintainer {
        bool hooked = _bridge_movedSweepPre(sweepTx, mainUtxo);
        bridge.submitMovedFundsSweepProof(sweepTx, sweepProof, mainUtxo);
        if (hooked) _bridge_movedSweepPost();
    }

    function bridge_notifyMovedFundsSweepTimeout(
        bytes32 movingFundsTxHash,
        uint32 movingFundsTxOutputIndex,
        uint32[] memory walletMembersIDs
    ) public asActor {
        uint256 key = _bridge_utxoKey(
            movingFundsTxHash,
            movingFundsTxOutputIndex
        );
        MovingFunds.MovedFundsSweepRequest memory req = bridge
            .movedFundsSweepRequests(key);
        _bridge_hubBegin(req.walletPubKeyHash, false, 0, 0);
        bridge_hook.sweepKind = bridge_SK_TIMEOUT;
        bridge_hook.sweepKey = key;
        ghosts.prevSweepState[key] = uint8(req.state);
        bridge.notifyMovedFundsSweepTimeout(
            movingFundsTxHash,
            movingFundsTxOutputIndex,
            walletMembersIDs
        );
        ghosts.sweepsSettled++;
        snapshotAfter();
        property_movedFundsSweepStateMachine();
        property_pendingMovedFundsCountSync();
        property_pendingSweepTargetsProcessable();
        property_spentUtxoMonotone();
        _bridge_walletPost();
        ghosts.prevSweepState[key] = uint8(
            bridge.movedFundsSweepRequests(key).state
        );
        _bridge_refreshSweepShadows();
        _bridge_refreshEverSpent();
    }

    /// @dev The challenge deposit is paid by the actor (`msg.value` is the
    ///      amount the actor forwards to the Bridge).
    function bridge_submitFraudChallenge(
        bytes memory walletPublicKey,
        bytes memory preimageSha256,
        BitcoinTx.RSVSignature memory signature
    ) public payable {
        if (ghosts.challengeKeys.length >= FIZZ_SCAN_CAP) return;
        _bridge_doSubmitFraudChallenge(
            msg.value,
            walletPublicKey,
            preimageSha256,
            signature
        );
    }

    function bridge_defeatFraudChallenge(
        bytes memory walletPublicKey,
        bytes memory preimage,
        bool witness
    ) public asActor {
        (bool okPk, bytes20 w) = _bridge_pkhOfPubKey(walletPublicKey);
        _bridge_resetHook();
        uint256 key = uint256(
            keccak256(
                abi.encodePacked(
                    walletPublicKey,
                    sha256(abi.encodePacked(sha256(preimage)))
                )
            )
        );
        bridge_hook.fraudKind = bridge_FK_DEFEAT;
        bridge_hook.fraudKey = key;
        bridge_hook.fraudReportedAt = bridge.fraudChallenges(key).reportedAt;
        _setFocus(0, okPk ? w : bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();
        bridge.defeatFraudChallenge(walletPublicKey, preimage, witness);
        snapshotAfter();
        property_fraudChallengeLifecycle();
        property_fraudEthEscrow();
    }

    function bridge_notifyFraudChallengeDefeatTimeout(
        bytes memory walletPublicKey,
        uint32[] memory walletMembersIDs,
        bytes memory preimageSha256
    ) public asActor {
        (bool okPk, bytes20 w) = _bridge_pkhOfPubKey(walletPublicKey);
        _bridge_hubBegin(okPk ? w : bytes20(0), false, 0, 0);
        uint256 key = uint256(
            keccak256(abi.encodePacked(walletPublicKey, sha256(preimageSha256)))
        );
        bridge_hook.fraudKind = bridge_FK_TIMEOUT;
        bridge_hook.fraudKey = key;
        bridge_hook.fraudReportedAt = bridge.fraudChallenges(key).reportedAt;
        bridge.notifyFraudChallengeDefeatTimeout(
            walletPublicKey,
            walletMembersIDs,
            preimageSha256
        );
        snapshotAfter();
        property_fraudChallengeLifecycle();
        property_fraudEthEscrow();
        _bridge_walletPost();
    }

    function _bridge_doSubmitFraudChallenge(
        uint256 value,
        bytes memory walletPublicKey,
        bytes memory preimageSha256,
        BitcoinTx.RSVSignature memory signature
    ) internal asActor {
        (bool okPk, bytes20 w) = _bridge_pkhOfPubKey(walletPublicKey);
        _bridge_resetHook();
        uint256 key = uint256(
            keccak256(abi.encodePacked(walletPublicKey, sha256(preimageSha256)))
        );
        bridge_hook.fraudKind = bridge_FK_SUBMIT;
        bridge_hook.fraudKey = key;
        bridge_hook.fraudValue = value;
        _setFocus(0, okPk ? w : bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();
        bridge.submitFraudChallenge{value: value}(
            walletPublicKey,
            preimageSha256,
            signature
        );
        snapshotAfter();
        ghosts.challengeKeys.push(key);
        property_fraudChallengeLifecycle();
        property_fraudEthEscrow();
    }

    /// @dev Honest-spend probe (SP-111): a wallet-signed fraud challenge against the spend of an outpoint the
    ///      Bridge recognises as an accepted reserved deposit or a consumed anchor must be defeatable. Stranded
    ///      anchors are not probed (unspent, never recorded as spent). The signer is any Live/MovingFunds/Closing
    ///      wallet: the Bridge does not bind a challenge to the outpoint owner (Fraud.sol:140-190).
    function bridge_fraudChallengeHonestAnchorSpend(
        uint256 pickSeed,
        uint256 walletSeed,
        uint256 seed
    ) public {
        uint256 n = ghosts.honestOutpoints.length;
        if (n == 0 || ghosts.challengeKeys.length >= FIZZ_SCAN_CAP) return;
        (bool foundWallet, bytes20 w) = _bridge_pickWallet(
            walletSeed,
            bridge_LIVE | bridge_MOVING_FUNDS | bridge_CLOSING
        );
        if (!foundWallet) return;
        (bool found, HonestOutpoint memory o) = _bridge_pickHonest(pickSeed);
        if (!found) return;
        bridge_Challenge memory c;
        c.walletPkh = w;
        c.witness = true;
        c.utxoKey = _bridge_utxoKey(o.txHash, o.index);
        c.preimage = _bridge_witnessPreimage(
            o.txHash,
            o.index,
            _bridge_entropy(seed)
        );
        BitcoinTx.RSVSignature memory sig = _bridge_sign(c);
        (uint96 required, , , ) = bridge.fraudParameters();
        if (actor.balance < required) return;
        _bridge_doSubmitFraudChallenge(
            required,
            c.walletPublicKey,
            abi.encodePacked(c.preimageSha256),
            sig
        );
        bridge_challenges.push(c);
        _bridge_honestDefeat(c);
        property_honestAnchorSpendDefeatable();
    }

    function _bridge_honestDefeat(bridge_Challenge memory c) internal asActor {
        bridge_hook.honestReverted = false;
        try
            bridge.defeatFraudChallenge(c.walletPublicKey, c.preimage, true)
        {} catch {
            bridge_hook.honestReverted = true;
        }
        bridge_hook.honestSettled = _bridge_utxoSpent(c.utxoKey);
    }

    // ―――― Secondary (internal, reachable through `bridge_secondary`) ――――

    /// @dev The ECDSA registry mock is the only caller the Bridge accepts.
    function _bridge___ecdsaWalletHeartbeatFailedCallback(
        bytes32 _arg0,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) internal {
        walletRegistry.heartbeatFailed(_arg0, publicKeyX, publicKeyY);
    }

    function _bridge_defeatFraudChallengeWithHeartbeat(
        bytes memory walletPublicKey,
        bytes memory heartbeatMessage
    ) internal asActor {
        bridge.defeatFraudChallengeWithHeartbeat(
            walletPublicKey,
            heartbeatMessage
        );
    }

    function _bridge_resetMovingFundsTimeout(
        bytes20 walletPubKeyHash
    ) internal asActor {
        bridge_hook.timeoutReset = true;
        bridge.resetMovingFundsTimeout(walletPubKeyHash);
    }

    function _bridge_setVaultStatus(
        address vault,
        bool isTrusted
    ) internal asGovernance {
        bridge.setVaultStatus(vault, isTrusted);
    }

    function _bridge_setSpvMaintainerStatus(
        address maintainer,
        bool isTrusted
    ) internal asGovernance {
        bridge.setSpvMaintainerStatus(maintainer, isTrusted);
    }

    function _bridge_updateDepositParameters(
        uint64 depositDustThreshold,
        uint64 depositTreasuryFeeDivisor,
        uint64 depositTxMaxFee,
        uint32 depositRevealAheadPeriod
    ) internal asGovernance {
        bridge.updateDepositParameters(
            depositDustThreshold,
            depositTreasuryFeeDivisor,
            depositTxMaxFee,
            depositRevealAheadPeriod
        );
    }

    function _bridge_updateRedemptionParameters(
        uint64 redemptionDustThreshold,
        uint64 redemptionTreasuryFeeDivisor,
        uint64 redemptionTxMaxFee,
        uint64 redemptionTxMaxTotalFee,
        uint32 redemptionTimeout,
        uint96 redemptionTimeoutSlashingAmount,
        uint32 redemptionTimeoutNotifierRewardMultiplier
    ) internal asGovernance {
        bridge.updateRedemptionParameters(
            redemptionDustThreshold,
            redemptionTreasuryFeeDivisor,
            redemptionTxMaxFee,
            redemptionTxMaxTotalFee,
            redemptionTimeout,
            redemptionTimeoutSlashingAmount,
            redemptionTimeoutNotifierRewardMultiplier
        );
    }

    function _bridge_updateMovingFundsParameters(
        uint64 movingFundsTxMaxTotalFee,
        uint64 movingFundsDustThreshold,
        uint32 movingFundsTimeoutResetDelay,
        uint32 movingFundsTimeout,
        uint96 movingFundsTimeoutSlashingAmount,
        uint32 movingFundsTimeoutNotifierRewardMultiplier,
        uint16 movingFundsCommitmentGasOffset,
        uint64 movedFundsSweepTxMaxTotalFee,
        uint32 movedFundsSweepTimeout,
        uint96 movedFundsSweepTimeoutSlashingAmount,
        uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
    ) internal asGovernance {
        bridge.updateMovingFundsParameters(
            movingFundsTxMaxTotalFee,
            movingFundsDustThreshold,
            movingFundsTimeoutResetDelay,
            movingFundsTimeout,
            movingFundsTimeoutSlashingAmount,
            movingFundsTimeoutNotifierRewardMultiplier,
            movingFundsCommitmentGasOffset,
            movedFundsSweepTxMaxTotalFee,
            movedFundsSweepTimeout,
            movedFundsSweepTimeoutSlashingAmount,
            movedFundsSweepTimeoutNotifierRewardMultiplier
        );
    }

    function _bridge_updateWalletParameters(
        uint32 walletCreationPeriod,
        uint64 walletCreationMinBtcBalance,
        uint64 walletCreationMaxBtcBalance,
        uint64 walletClosureMinBtcBalance,
        uint32 walletMaxAge,
        uint64 walletMaxBtcTransfer,
        uint32 walletClosingPeriod
    ) internal asGovernance {
        bridge.updateWalletParameters(
            walletCreationPeriod,
            walletCreationMinBtcBalance,
            walletCreationMaxBtcBalance,
            walletClosureMinBtcBalance,
            walletMaxAge,
            walletMaxBtcTransfer,
            walletClosingPeriod
        );
    }

    function _bridge_updateFraudParameters(
        uint96 fraudChallengeDepositAmount,
        uint32 fraudChallengeDefeatTimeout,
        uint96 fraudSlashingAmount,
        uint32 fraudNotifierRewardMultiplier
    ) internal asGovernance {
        bridge.updateFraudParameters(
            fraudChallengeDepositAmount,
            fraudChallengeDefeatTimeout,
            fraudSlashingAmount,
            fraudNotifierRewardMultiplier
        );
    }

    function _bridge_updateTreasury(address newTreasury) internal asGovernance {
        bridge.updateTreasury(newTreasury);
    }

    // ――――――――――――――――――――――― Secondary clamps ――――――――――――――――――――――――

    /// @dev Heartbeat failure of a Live harness wallet, reported through the
    ///      registry with that wallet's key and ECDSA wallet ID.
    function _bridge_heartbeatFailedClamped(uint256 seed) internal {
        (bool found, bytes20 w) = _bridge_pickWallet(seed, bridge_LIVE);
        if (!found) return;
        uint256 k = walletKeyIndex[w];
        _bridge___ecdsaWalletHeartbeatFailedCallback(
            bridge.wallets(w).ecdsaWalletID,
            walletPubX[k],
            walletPubY[k]
        );
    }

    function _bridge_defeatHeartbeatClamped(uint256 seed) internal {
        (bool found, uint256 idx) = _bridge_pickChallenge(seed, 1);
        if (!found) return;
        bridge_Challenge storage c = bridge_challenges[idx];
        _bridge_defeatFraudChallengeWithHeartbeat(
            c.walletPublicKey,
            c.preimage
        );
    }

    function _bridge_resetMovingFundsTimeoutClamped(uint256 seed) internal {
        (bool found, bytes20 w) = _bridge_pickEligible(seed, bridge_KIND_RESET);
        if (!found) return;
        _bridge_resetMovingFundsTimeout(w);
    }

    /// @dev The two vaults the harness depends on are re-trusted on picks 0
    ///      and 1. Vacuity F4: one pick-2 call in four revokes the
    ///      reservation vault, so the untrusted-vault acceptance branch (SP-54)
    ///      and the `vaultTrustRevoked` latch run; pick 1 re-trusts it.
    ///      Arbitrary addresses toggle freely.
    function _bridge_setVaultStatusClamped(
        address vault,
        uint256 seed
    ) internal {
        uint256 pick = uint160(vault) % 4;
        if (pick == 0) _bridge_setVaultStatus(address(tbtcVault), true);
        else if (pick == 1)
            _bridge_setVaultStatus(address(reservationVault), true);
        else if (pick == 2 && seed % 4 == 0)
            _bridge_setVaultStatus(address(reservationVault), false);
        else _bridge_setVaultStatus(vault, seed > 0);
    }

    /// @dev The SPV maintainer used by the proof handlers is always
    ///      (re-)trusted; arbitrary addresses toggle freely.
    function _bridge_setSpvMaintainerStatusClamped(
        address maintainer,
        uint256 seed
    ) internal {
        if (uint160(maintainer) % 3 == 0)
            _bridge_setSpvMaintainerStatus(spvMaintainer, true);
        else _bridge_setSpvMaintainerStatus(maintainer, seed > 0);
    }

    /// @dev Keeps `dust > txMaxFee > 0` with a per-deposit fee of at most half
    ///      the dust and a treasury divisor of 0 (disabled) or >= 200, so
    ///      `amount - treasuryFee - txFee` cannot underflow for any deposit.
    function _bridge_updateDepositParametersClamped(
        uint256 a0,
        uint256 a1,
        uint256 a2,
        uint256 a3
    ) internal {
        uint256 dust = clampBetween(a0, 2_000, 100_000);
        uint256 divisor = a1 % 16 == 0 ? 0 : clampBetween(a1, 200, 50_000);
        uint256 maxFee = clampBetween(a2, 1, min(dust / 2, 5_000));
        uint256 ahead = a3 % 8 == 0 ? 0 : clampBetween(a3, 1 hours, 30 days);
        _bridge_updateDepositParameters(
            uint64(dust),
            uint64(divisor),
            uint64(maxFee),
            uint32(ahead)
        );
    }

    function _bridge_updateRedemptionParametersClamped(
        uint256 a0,
        uint256 a1,
        uint256 a2,
        uint256 a3,
        uint256 a4,
        uint256 a5,
        uint256 a6
    ) internal {
        uint256 dust = clampBetween(
            a0,
            max(2_000, uint256(_bridge_movingParams().dust) + 1),
            100_000
        );
        uint256 divisor = a1 % 16 == 0 ? 0 : clampBetween(a1, 200, 50_000);
        uint256 maxFee = clampBetween(a2, 1, min(dust / 2, 5_000));
        uint256 maxTotal = clampBetween(a3, maxFee, 50_000);
        uint256 timeout = clampBetween(a4, 1 hours, 7 days);
        uint256 slashing = clampBetween(a5, 0, 1_000 ether);
        uint256 multiplier = clampBetween(a6, 0, 100);
        _bridge_updateRedemptionParameters(
            uint64(dust),
            uint64(divisor),
            uint64(maxFee),
            uint64(maxTotal),
            uint32(timeout),
            uint96(slashing),
            uint32(multiplier)
        );
    }

    function _bridge_updateMovingFundsParametersClamped(
        uint256 a0,
        uint256 a1,
        uint256 a2,
        uint256 a3,
        uint256 a4,
        uint256 a5,
        uint256 a6,
        uint256 a7,
        uint256 a8,
        uint256 a9
    ) internal {
        uint256[] memory a = new uint256[](10);
        a[0] = a0;
        a[1] = a1;
        a[2] = a2;
        a[3] = a3;
        a[4] = a4;
        a[5] = a5;
        a[6] = a6;
        a[7] = a7;
        a[8] = a8;
        a[9] = a9;
        _bridge_applyMovingFundsParameters(a);
    }

    /// @dev Keeps `0 < dust < redemptionDust`, `0 < resetDelay < timeout` and
    ///      every multiplier in [0, 100]. The moved funds sweep slashing amount
    ///      and notifier reward multiplier share `a[9]` (low / high 128 bits).
    function _bridge_applyMovingFundsParameters(uint256[] memory a) internal {
        a[0] = clampBetween(a[0], 1, 50_000);
        a[1] = clampBetween(
            a[1],
            1,
            min(uint256(_bridge_redemptionParams().dust) - 1, 50_000)
        );
        a[2] = clampBetween(a[2], 1, 3 days);
        a[3] = clampBetween(a[3], a[2] + 1, 7 days);
        a[4] = clampBetween(a[4], 0, 1_000 ether);
        a[5] = clampBetween(a[5], 0, 100);
        a[7] = clampBetween(a[7], 1, 50_000);
        a[8] = clampBetween(a[8], 1 hours, 7 days);
        uint256 sweepSlashing = clampBetween(
            a[9] & type(uint128).max,
            0,
            1_000 ether
        );
        a[9] = clampBetween(a[9] >> 128, 0, 100);
        _bridge_updateMovingFundsParameters(
            uint64(a[0]),
            uint64(a[1]),
            uint32(a[2]),
            uint32(a[3]),
            uint96(a[4]),
            uint32(a[5]),
            uint16(a[6]),
            uint64(a[7]),
            uint32(a[8]),
            uint96(sweepSlashing),
            uint32(a[9])
        );
    }

    function _bridge_updateWalletParametersClamped(
        uint256 a0,
        uint256 a1,
        uint256 a2,
        uint256 a3,
        uint256 a4,
        uint256 a5,
        uint256 a6
    ) internal {
        uint256 creationMin = clampBetween(a1, 0, 1_000_000);
        _bridge_updateWalletParameters(
            uint32(clampBetween(a0, 0, 7 days)),
            uint64(creationMin),
            uint64(clampBetween(a2, creationMin + 1, 100_000_000)),
            uint64(clampBetween(a3, 0, 1_000_000)),
            uint32(clampBetween(a4, 1 days, 30 days)),
            uint64(clampBetween(a5, 1, 100_000_000)),
            uint32(clampBetween(a6, 1, 7 days))
        );
    }

    function _bridge_updateFraudParametersClamped(
        uint256 a0,
        uint256 a1,
        uint256 a2,
        uint256 a3
    ) internal {
        _bridge_updateFraudParameters(
            uint96(clampBetween(a0, 0, 10 ether)),
            uint32(clampBetween(a1, 1 hours, 7 days)),
            uint96(clampBetween(a2, 0, 1_000 ether)),
            uint32(clampBetween(a3, 0, 100))
        );
    }

    /// @dev Treasury is either the Base treasury or an actor (never the zero
    ///      address, the Bank or the Bridge).
    function _bridge_updateTreasuryClamped(address who, uint256 seed) internal {
        _bridge_updateTreasury(seed % 2 == 0 ? treasury : toActor(who));
    }

    // ――――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    // ―――― Encoding ――――

    function _bridge_le32(uint32 v) internal pure returns (bytes4) {
        return
            bytes4(
                (v << 24) |
                    ((v & 0xff00) << 8) |
                    ((v >> 8) & 0xff00) |
                    (v >> 24)
            );
    }

    function _bridge_le64(uint64 v) internal pure returns (bytes8) {
        return
            bytes8(
                (uint64(uint32(_bridge_le32(uint32(v)))) << 32) |
                    uint64(uint32(_bridge_le32(uint32(v >> 32))))
            );
    }

    function _bridge_entropy(uint256 seed) internal returns (bytes32) {
        bridge_nonce++;
        return keccak256(abi.encodePacked("fizz.bridge", seed, bridge_nonce));
    }

    function _bridge_scriptFor(
        bytes20 pkh,
        uint256 seed
    ) internal pure returns (bytes memory) {
        return (seed & 1) == 0 ? BtcBuilder.p2wpkh(pkh) : BtcBuilder.p2pkh(pkh);
    }

    /// @dev `redeemerOutputScript` is length-prefixed, a `BtcBuilder.TxOut`
    ///      script is not.
    function _bridge_stripPrefix(
        bytes memory s
    ) internal pure returns (bytes memory out) {
        if (s.length == 0) return s;
        out = new bytes(s.length - 1);
        for (uint256 i = 0; i < out.length; i++) out[i] = s[i + 1];
    }

    /// @dev The registry mock ignores the member IDs and the member index.
    function _bridge_members(
        uint256 seed
    ) internal pure returns (uint32[] memory ids) {
        ids = new uint32[](1 + (seed % 5));
        for (uint256 i = 0; i < ids.length; i++) ids[i] = uint32(i + 1);
    }

    function _bridge_prove(
        BitcoinTx.Info memory info,
        uint256 seed
    ) internal pure returns (BitcoinTx.Proof memory) {
        return BtcBuilder.prove(info, 1 + (seed % 3));
    }

    function _bridge_contains(
        uint256[] memory a,
        uint256 len,
        uint256 v
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < len; i++) {
            if (a[i] == v) return true;
        }
        return false;
    }

    /// @dev Total Bitcoin fee in `[0, min(maxFee, room)]`; `FEE_OVER` returns
    ///      one satoshi above `maxFee` when `room` allows it.
    function _bridge_totalFee(
        uint256 seed,
        uint8 mode,
        uint256 maxFee,
        uint256 room
    ) internal pure returns (uint256) {
        uint256 cap = min(maxFee, room);
        if (mode == bridge_FEE_ZERO) return 0;
        if (mode == bridge_FEE_MAX) return cap;
        if (mode == bridge_FEE_OVER) return room > maxFee ? maxFee + 1 : room;
        return seed % (cap + 1);
    }

    // ―――― Parameter snapshots ――――

    function _bridge_movingParams()
        internal
        view
        returns (bridge_MovingParams memory p)
    {
        (
            uint64 a,
            uint64 b,
            uint32 c,
            uint32 d,
            ,
            ,
            ,
            uint64 h,
            uint32 i,
            ,

        ) = bridge.movingFundsParameters();
        p = bridge_MovingParams(a, b, c, d, h, i);
    }

    function _bridge_redemptionParams()
        internal
        view
        returns (bridge_RedemptionParams memory p)
    {
        (uint64 a, uint64 b, uint64 c, uint64 d, uint32 e, , ) = bridge
            .redemptionParameters();
        p = bridge_RedemptionParams(a, b, c, d, e);
    }

    function _bridge_walletParams()
        internal
        view
        returns (bridge_WalletParams memory p)
    {
        (
            uint32 a,
            uint64 b,
            uint64 c,
            uint64 d,
            uint32 e,
            uint64 f,
            uint32 g
        ) = bridge.walletParameters();
        p = bridge_WalletParams(a, b, c, d, e, f, g);
    }

    // ―――― Wallets and main UTXO ――――

    function _bridge_state(bytes20 pkh) internal view returns (uint256) {
        return uint256(uint8(bridge.wallets(pkh).state));
    }

    /// @dev First harness wallet (starting at `seed`) whose state is in `mask`.
    function _bridge_pickWallet(
        uint256 seed,
        uint256 mask
    ) internal view returns (bool, bytes20) {
        uint256 n = harnessWallets.length;
        for (uint256 i = 0; i < n; i++) {
            bytes20 w = harnessWallets[((seed % n) + i) % n];
            if (((uint256(1) << _bridge_state(w)) & mask) != 0)
                return (true, w);
        }
        return (false, bytes20(0));
    }

    /// @dev `ok` is false when the harness main UTXO does not hash to the
    ///      Bridge's `mainUtxoHash`. A wallet without a main UTXO yields the
    ///      zero UTXO and `ok == true`.
    function _bridge_mainUtxo(
        bytes20 pkh
    ) internal view returns (bool ok, BitcoinTx.UTXO memory utxo) {
        bytes32 h = bridge.wallets(pkh).mainUtxoHash;
        if (h == bytes32(0)) return (true, utxo);
        utxo = harnessMainUtxo[pkh];
        ok =
            keccak256(
                abi.encodePacked(
                    utxo.txHash,
                    utxo.txOutputIndex,
                    utxo.txOutputValue
                )
            ) == h;
    }

    function _bridge_replaceMainUtxo(
        bytes20 pkh,
        BitcoinTx.UTXO memory oldUtxo,
        BitcoinTx.UTXO memory newUtxo
    ) internal {
        if (oldUtxo.txHash != bytes32(0)) {
            if (bridge_spentMainUtxos.length < bridge_SPENT_RING)
                bridge_spentMainUtxos.push(oldUtxo);
            else
                bridge_spentMainUtxos[bridge_nonce % bridge_SPENT_RING] =
                    oldUtxo;
        }
        _setMainUtxo(pkh, newUtxo);
    }

    function _bridge_nextWalletKey()
        internal
        view
        returns (bool, uint256, bytes20)
    {
        for (uint256 i = 0; i < walletPrivKeys.length; i++) {
            bytes20 pkh = BtcBuilder.pubKeyHash(walletPubX[i], walletPubY[i]);
            if (bridge.wallets(pkh).state == Wallets.WalletState.Unknown)
                return (true, i, pkh);
        }
        return (false, 0, bytes20(0));
    }

    function _bridge_closeable(
        bytes20 w,
        Wallets.Wallet memory wal
    ) internal view returns (bool) {
        if (
            wal.state != Wallets.WalletState.Live ||
            w == bridge.activeWalletPubKeyHash()
        ) return false;
        (bool ok, BitcoinTx.UTXO memory main) = _bridge_mainUtxo(w);
        if (!ok) return false;
        bridge_WalletParams memory p = _bridge_walletParams();
        return
            block.timestamp >= uint256(wal.createdAt) + p.maxAge ||
            main.txOutputValue < p.closureMin;
    }

    /// @dev Whether the moving funds / closing / closeable step `kind` can
    ///      succeed for `w` right now.
    function _bridge_eligible(
        bytes20 w,
        uint8 kind
    ) internal view returns (bool) {
        Wallets.Wallet memory wal = bridge.wallets(w);
        if (kind == bridge_KIND_CLOSING_ELAPSED) {
            return
                wal.state == Wallets.WalletState.Closing &&
                block.timestamp >
                    uint256(wal.closingStartedAt) +
                        _bridge_walletParams().closingPeriod;
        }
        if (kind == bridge_KIND_CLOSEABLE) return _bridge_closeable(w, wal);
        if (wal.state != Wallets.WalletState.MovingFunds) return false;
        if (kind == bridge_KIND_MOVING_TIMEOUT) {
            return
                block.timestamp >
                uint256(wal.movingFundsRequestedAt) +
                    _bridge_movingParams().timeout;
        }
        if (kind == bridge_KIND_RESET) {
            return
                wal.movingFundsTargetWalletsCommitmentHash == bytes32(0) &&
                bridge.liveWalletsCount() == 0 &&
                block.timestamp >
                    uint256(wal.movingFundsRequestedAt) +
                        _bridge_movingParams().resetDelay;
        }
        (bool ok, BitcoinTx.UTXO memory main) = _bridge_mainUtxo(w);
        if (!ok) return false;
        if (kind == bridge_KIND_COMMITMENT) {
            return
                wal.movingFundsTargetWalletsCommitmentHash == bytes32(0) &&
                wal.pendingRedemptionsValue == 0 &&
                wal.pendingMovedFundsSweepRequestsCount == 0 &&
                main.txOutputValue > 0;
        }
        if (kind == bridge_KIND_MOVING_PROOF) {
            bytes20[] memory t = bridge_commitments[w];
            return
                t.length > 0 &&
                main.txHash != bytes32(0) &&
                wal.movingFundsTargetWalletsCommitmentHash ==
                    keccak256(abi.encodePacked(t));
        }
        if (kind == bridge_KIND_BELOW_DUST)
            return main.txOutputValue < _bridge_movingParams().dust;
        return false;
    }

    function _bridge_pickEligible(
        uint256 seed,
        uint8 kind
    ) internal view returns (bool, bytes20) {
        uint256 n = harnessWallets.length;
        for (uint256 i = 0; i < n; i++) {
            bytes20 w = harnessWallets[((seed % n) + i) % n];
            if (_bridge_eligible(w, kind)) return (true, w);
        }
        return (false, bytes20(0));
    }

    // ―――― Deposits ――――

    function _bridge_refundLocktime() internal view returns (bytes4) {
        uint256 ts = block.timestamp + bridge_LOCKTIME_OFFSET;
        if (ts > type(uint32).max) ts = type(uint32).max;
        return _bridge_le32(uint32(ts));
    }

    /// @dev Three out of four deposits are routed to the TBTCVault.
    function _bridge_depositVault(
        uint256 seed
    ) internal view returns (address) {
        if (seed % 4 == 0 || !bridge.isVaultTrusted(address(tbtcVault)))
            return address(0);
        return address(tbtcVault);
    }

    /// @dev mode 0: clamp to [dust, max(dust, WALLET_MAX_BTC_TRANSFER)],
    ///      1: dust + (hint % 3), 2: close to type(uint64).max, 3: upper bound.
    function _bridge_depositAmount(
        uint64 hint,
        uint8 mode
    ) internal returns (uint64) {
        (uint64 dust, , , ) = bridge.depositParameters();
        if (mode == 1) return dust + uint64(hint % 3);
        if (mode == 2) return type(uint64).max - uint64(hint % 1_000_000);
        uint256 hi = max(dust, WALLET_MAX_BTC_TRANSFER);
        if (mode == 3) return uint64(hi);
        return uint64(clampBetween(hint, dust, hi));
    }

    /// @dev `extraData != 0` selects the extra-data script variant. The
    ///      depositor baked into the script is the current actor, which is the
    ///      `msg.sender` of the reveal.
    function _bridge_buildDeposit(
        bytes20 wallet,
        uint64 amount,
        uint256 seed,
        bytes32 extraData
    )
        internal
        returns (
            BitcoinTx.Info memory fundingTx,
            Deposit.DepositRevealInfo memory reveal
        )
    {
        bytes32 entropy = _bridge_entropy(seed);
        reveal.fundingOutputIndex = uint32(uint256(entropy) % 4);
        reveal.blindingFactor = bytes8(
            keccak256(abi.encodePacked("fizz.blinding", entropy))
        );
        reveal.walletPubKeyHash = wallet;
        reveal.refundPubKeyHash = bytes20(
            keccak256(abi.encodePacked("fizz.refund", entropy))
        );
        reveal.refundLocktime = _bridge_refundLocktime();
        reveal.vault = _bridge_depositVault(seed);
        bool witness = ((uint256(entropy) >> 8) & 1) == 1;
        (fundingTx, ) = BtcBuilder.depositFundingTx(
            reveal,
            actor,
            extraData,
            extraData != bytes32(0),
            witness,
            amount,
            entropy
        );
    }

    function _bridge_revealClamped(
        uint256 walletSeed,
        uint64 amountHint,
        uint256 seed,
        bytes32 extraData,
        uint8 mode
    ) internal {
        (bool found, bytes20 wallet) = _bridge_pickWallet(
            walletSeed,
            bridge_LIVE
        );
        if (!found) return;
        uint64 amount = _bridge_depositAmount(amountHint, mode);
        (
            BitcoinTx.Info memory fundingTx,
            Deposit.DepositRevealInfo memory reveal
        ) = _bridge_buildDeposit(wallet, amount, seed, extraData);
        if (extraData == bytes32(0)) bridge_revealDeposit(fundingTx, reveal);
        else bridge_revealDepositWithExtraData(fundingTx, reveal, extraData);
    }

    /// @dev Records the accepted reveal from the Bridge's own deposit record.
    function _bridge_recordRevealedDeposit(
        BitcoinTx.Info memory fundingTx,
        Deposit.DepositRevealInfo memory reveal
    ) internal {
        bytes32 fundingTxHash = BtcBuilder.txHash(fundingTx);
        uint256 key = uint256(
            keccak256(
                abi.encodePacked(fundingTxHash, reveal.fundingOutputIndex)
            )
        );
        Deposit.DepositRequest memory d = bridge.deposits(key);
        _recordDeposit(
            fundingTxHash,
            reveal.fundingOutputIndex,
            d.amount,
            d.depositor,
            d.vault,
            reveal.walletPubKeyHash,
            bridge.isReservedDeposit(key)
        );
        if (bridge.isReservedDeposit(key))
            harnessDepositFundings[key] = HarnessFunding({
                info: fundingTx,
                outputIndex: reveal.fundingOutputIndex
            });
    }

    // ―――― Deposit sweeps ――――

    function _bridge_tryAddDeposit(
        bridge_SweepPlan memory plan,
        uint256[] memory tmp,
        uint256 found,
        uint256 idx
    ) internal returns (bool) {
        HarnessDeposit storage d = harnessDeposits[idx];
        if (d.walletPkh != plan.wallet || d.swept || d.reserved) return false;
        uint256 key = uint256(
            keccak256(abi.encodePacked(d.fundingTxHash, d.outputIndex))
        );
        Deposit.DepositRequest memory r = bridge.deposits(key);
        if (r.revealedAt == 0) return false;
        if (r.sweptAt != 0) {
            d.swept = true;
            return false;
        }
        if (bridge.isReservedDeposit(key)) {
            d.reserved = true;
            return false;
        }
        if (found == 0) plan.vault = r.vault;
        else if (r.vault != plan.vault) return false;
        tmp[found] = idx;
        plan.inputsTotal += r.amount;
        plan.minNet = min(plan.minNet, uint256(r.amount) - r.treasuryFee);
        return true;
    }

    function _bridge_fillSweep(
        bridge_SweepPlan memory plan,
        uint256 seed,
        uint256 maxCount
    ) internal returns (bool) {
        if (
            ((uint256(1) << _bridge_state(plan.wallet)) &
                (bridge_LIVE | bridge_MOVING_FUNDS)) == 0
        ) return false;
        bool ok;
        (ok, plan.main) = _bridge_mainUtxo(plan.wallet);
        if (!ok) return false;
        plan.vault = address(0);
        plan.inputsTotal = 0;
        plan.minNet = type(uint256).max;
        uint256 n = harnessDeposits.length;
        uint256[] memory tmp = new uint256[](maxCount);
        uint256 found;
        for (
            uint256 k = 0;
            k < min(n, bridge_SCAN_LIMIT) && found < maxCount;
            k++
        ) {
            if (_bridge_tryAddDeposit(plan, tmp, found, ((seed % n) + k) % n))
                found++;
        }
        if (found == 0) return false;
        plan.picked = new uint256[](found);
        for (uint256 j = 0; j < found; j++) plan.picked[j] = tmp[j];
        plan.inputsTotal += plan.main.txOutputValue;
        return true;
    }

    function _bridge_findSweep(
        uint256 walletSeed,
        uint256 count
    ) internal returns (bool ok, bridge_SweepPlan memory plan) {
        uint256 n = harnessWallets.length;
        for (uint256 i = 0; i < n; i++) {
            plan.wallet = harnessWallets[((walletSeed % n) + i) % n];
            if (
                _bridge_fillSweep(
                    plan,
                    walletSeed >> 16,
                    1 + (count % bridge_MAX_BATCH)
                )
            ) return (true, plan);
        }
        return (false, plan);
    }

    /// @dev Total fee `n * q + r` with `q + r <= min(depositTxMaxFee, smallest
    ///      deposit net amount - 1)`: the Bridge charges `q` to every deposit
    ///      and the remainder `r < n` to the last one.
    function _bridge_sweepFee(
        bridge_SweepPlan memory plan,
        uint256 seed,
        uint8 mode
    ) internal view returns (bool, uint256) {
        (, , uint64 maxFee, ) = bridge.depositParameters();
        if (plan.minNet == 0) return (false, 0);
        uint256 n = plan.picked.length;
        uint256 cap = min(maxFee, plan.minNet - 1);
        uint256 q;
        uint256 r;
        if (mode == bridge_FEE_ZERO) {
            // no fee
        } else if (mode == bridge_FEE_MAX) {
            r = min(n - 1, cap);
            q = cap - r;
        } else if (mode == bridge_FEE_OVER) {
            q = uint256(maxFee) + 1;
        } else {
            q = seed % (cap + 1);
            r = (seed >> 64) % (min(n - 1, cap - q) + 1);
        }
        return (true, n * q + r);
    }

    function _bridge_sweepTx(
        bridge_SweepPlan memory plan,
        uint256 seed,
        uint64 output
    ) internal view returns (BitcoinTx.Info memory) {
        bool hasMain = plan.main.txHash != bytes32(0);
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](
            plan.picked.length + (hasMain ? 1 : 0)
        );
        uint256 mainPos = (hasMain && (seed & 2) != 0) ? ins.length - 1 : 0;
        uint256 next;
        for (uint256 i = 0; i < ins.length; i++) {
            if (hasMain && i == mainPos) {
                ins[i] = BtcBuilder.TxIn(
                    plan.main.txHash,
                    plan.main.txOutputIndex
                );
            } else {
                HarnessDeposit storage d = harnessDeposits[plan.picked[next++]];
                ins[i] = BtcBuilder.TxIn(d.fundingTxHash, d.outputIndex);
            }
        }
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](1);
        outs[0] = BtcBuilder.TxOut(
            output,
            _bridge_scriptFor(plan.wallet, seed >> 8)
        );
        return BtcBuilder.buildTx(ins, outs);
    }

    function _bridge_sweepClamped(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed,
        uint8 mode
    ) internal {
        (bool ok, bridge_SweepPlan memory plan) = _bridge_findSweep(
            walletSeed,
            count
        );
        if (!ok) return;
        uint256 fee;
        (ok, fee) = _bridge_sweepFee(plan, feeSeed, mode);
        if (!ok || fee >= plan.inputsTotal) return;
        uint256 output = plan.inputsTotal - fee;
        if (output > type(uint64).max) return;
        BitcoinTx.Info memory sweepTx = _bridge_sweepTx(
            plan,
            feeSeed,
            uint64(output)
        );
        bridge_submitDepositSweepProof(
            sweepTx,
            _bridge_prove(sweepTx, feeSeed >> 32),
            plan.main,
            plan.vault
        );
        for (uint256 i = 0; i < plan.picked.length; i++)
            harnessDeposits[plan.picked[i]].swept = true;
        _bridge_replaceMainUtxo(
            plan.wallet,
            plan.main,
            BitcoinTx.UTXO(BtcBuilder.txHash(sweepTx), 0, uint64(output))
        );
    }

    // ―――― Redemptions ――――

    function _bridge_redemptionKey(
        bytes20 wallet,
        bytes memory script
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(keccak256(script), wallet)));
    }

    /// @dev Length-prefixed script of the four standard types from fuzzed bytes.
    function _bridge_redeemerScript(
        uint256 seed
    ) internal pure returns (bytes memory) {
        uint256 kind = seed % 4;
        bytes32 h = keccak256(abi.encodePacked("fizz.redeemer", seed >> 2));
        if (kind == 0)
            return bytes.concat(hex"1976a914", bytes20(h), hex"88ac"); // P2PKH
        if (kind == 1) return bytes.concat(hex"160014", bytes20(h)); // P2WPKH
        if (kind == 2) return bytes.concat(hex"17a914", bytes20(h), hex"87"); // P2SH
        return bytes.concat(hex"220020", h); // P2WSH
    }

    /// @dev mode 0: amount clamped to [dust, upper], 1: dust, 2: upper, where
    ///      upper = min(actor Bank balance, main UTXO value - pending value).
    function _bridge_requestRedemptionClamped(
        uint256 walletSeed,
        uint256 scriptSeed,
        uint256 amount,
        uint8 mode
    ) internal {
        (bool found, bytes20 w) = _bridge_pickWallet(walletSeed, bridge_LIVE);
        if (!found) return;
        (bool ok, BitcoinTx.UTXO memory main) = _bridge_mainUtxo(w);
        uint256 pending = bridge.wallets(w).pendingRedemptionsValue;
        if (!ok || main.txOutputValue <= pending) return;
        uint256 upper = min(
            main.txOutputValue - pending,
            bank.balanceOf(actor)
        );
        uint256 dust = _bridge_redemptionParams().dust;
        if (upper < dust) return;
        if (mode == 1) amount = dust;
        else if (mode == 2) amount = upper;
        else amount = clampBetween(amount, dust, upper);
        bytes memory script = _bridge_redeemerScript(scriptSeed);
        if (
            bridge
                .pendingRedemptions(_bridge_redemptionKey(w, script))
                .requestedAt != 0
        ) return;
        bridge_requestRedemption(w, main, script, uint64(amount));
    }

    /// @dev Existing request (pending or already timed out) behind a harness
    ///      redemption. A redemption the Bridge no longer knows is closed.
    function _bridge_eligibleRedemption(
        uint256 idx,
        bytes20 wallet
    ) internal returns (bool, bridge_Eligible memory e) {
        HarnessRedemption storage r = harnessRedemptions[idx];
        if (r.walletPkh != wallet || r.closed) return (false, e);
        e.key = _bridge_redemptionKey(wallet, r.redeemerOutputScript);
        Redemption.RedemptionRequest memory req = bridge.pendingRedemptions(
            e.key
        );
        if (req.requestedAt == 0) req = bridge.timedOutRedemptions(e.key);
        if (req.requestedAt == 0) {
            r.closed = true;
            return (false, e);
        }
        e.redeemable = uint256(req.requestedAmount) - req.treasuryFee;
        e.txMaxFee = req.txMaxFee;
        return (true, e);
    }

    /// @dev Per-output fee in `[0, txMaxFee]`; `FEE_OVER` is one above the
    ///      limit for the first output.
    function _bridge_outputFee(
        uint64 txMaxFee,
        uint256 seed,
        uint8 mode,
        uint256 position
    ) internal pure returns (uint256) {
        if (mode == bridge_FEE_ZERO) return 0;
        if (mode == bridge_FEE_MAX) return txMaxFee;
        if (mode == bridge_FEE_OVER && position == 0)
            return uint256(txMaxFee) + 1;
        return
            uint256(keccak256(abi.encodePacked(seed, position))) %
            (uint256(txMaxFee) + 1);
    }

    function _bridge_tryAddRedemption(
        bridge_RedemptionPlan memory plan,
        uint256[] memory keys,
        uint256 found,
        uint256 idx,
        uint256 feeSeed,
        uint8 mode
    ) internal returns (bool) {
        (bool ok, bridge_Eligible memory e) = _bridge_eligibleRedemption(
            idx,
            plan.wallet
        );
        if (!ok || _bridge_contains(keys, found, e.key)) return false;
        uint256 fee = _bridge_outputFee(e.txMaxFee, feeSeed, mode, found);
        if (fee > e.redeemable) return false;
        uint256 value = e.redeemable - fee;
        if (plan.sumOut + value > plan.main.txOutputValue) return false;
        plan.picked[found] = idx;
        plan.values[found] = uint64(value);
        keys[found] = e.key;
        plan.sumOut += value;
        return true;
    }

    function _bridge_fillRedemptions(
        bridge_RedemptionPlan memory plan,
        uint256 seed,
        uint256 maxCount,
        uint256 feeSeed,
        uint8 mode
    ) internal returns (bool) {
        uint256 n = harnessRedemptions.length;
        plan.picked = new uint256[](maxCount);
        plan.values = new uint64[](maxCount);
        plan.sumOut = 0;
        uint256[] memory keys = new uint256[](maxCount);
        uint256 found;
        for (
            uint256 k = 0;
            k < min(n, bridge_SCAN_LIMIT) && found < maxCount;
            k++
        ) {
            if (
                _bridge_tryAddRedemption(
                    plan,
                    keys,
                    found,
                    ((seed % n) + k) % n,
                    feeSeed,
                    mode
                )
            ) found++;
        }
        if (found == 0) return false;
        uint256[] memory picked = new uint256[](found);
        uint64[] memory values = new uint64[](found);
        for (uint256 j = 0; j < found; j++) {
            picked[j] = plan.picked[j];
            values[j] = plan.values[j];
        }
        plan.picked = picked;
        plan.values = values;
        return true;
    }

    function _bridge_tryPlanRedemption(
        bridge_RedemptionPlan memory plan,
        uint256 seed,
        uint256 count,
        uint256 feeSeed,
        uint8 mode
    ) internal returns (bool) {
        if (
            ((uint256(1) << _bridge_state(plan.wallet)) &
                (bridge_LIVE | bridge_MOVING_FUNDS)) == 0
        ) return false;
        bool ok;
        (ok, plan.main) = _bridge_mainUtxo(plan.wallet);
        if (!ok || plan.main.txHash == bytes32(0)) return false;
        return
            _bridge_fillRedemptions(
                plan,
                seed,
                1 + (count % bridge_MAX_BATCH),
                feeSeed,
                mode
            );
    }

    function _bridge_planRedemptionProof(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed,
        uint8 mode
    ) internal returns (bool, bridge_RedemptionPlan memory plan) {
        uint256 n = harnessWallets.length;
        for (uint256 i = 0; i < n; i++) {
            plan.wallet = harnessWallets[((walletSeed % n) + i) % n];
            if (
                _bridge_tryPlanRedemption(
                    plan,
                    walletSeed >> 16,
                    count,
                    feeSeed,
                    mode
                )
            ) return (true, plan);
        }
        return (false, plan);
    }

    /// @dev Total Bitcoin fee observed by the Bridge for a redemption tx is
    ///      `main - outputs`; this returns the wallet change that leaves a fee
    ///      in `[0, redemptionTxMaxTotalFee]` (or one above the limit for
    ///      `FEE_OVER_TOTAL`). Zero means no change output.
    function _bridge_redemptionChange(
        bridge_RedemptionPlan memory plan,
        uint256 seed,
        uint8 mode
    ) internal view returns (uint256) {
        uint256 room = plan.main.txOutputValue - plan.sumOut;
        uint8 feeMode =
            mode == bridge_FEE_OVER_TOTAL
                ? bridge_FEE_OVER
                : (mode == bridge_FEE_OVER ? bridge_FEE_RANDOM : mode);
        return
            room -
            _bridge_totalFee(
                seed >> 48,
                feeMode,
                _bridge_redemptionParams().txMaxTotalFee,
                room
            );
    }

    function _bridge_redemptionOutput(
        bridge_RedemptionPlan memory plan,
        uint256 i
    ) internal view returns (BtcBuilder.TxOut memory) {
        return
            BtcBuilder.TxOut(
                plan.values[i],
                _bridge_stripPrefix(
                    harnessRedemptions[plan.picked[i]].redeemerOutputScript
                )
            );
    }

    /// @dev The chosen redemptions plus an optional wallet change output
    ///      (P2WPKH or P2PKH), placed first or last.
    function _bridge_redemptionOutputs(
        bridge_RedemptionPlan memory plan,
        uint256 change,
        uint256 seed
    )
        internal
        view
        returns (BtcBuilder.TxOut[] memory outs, uint32 changeIndex)
    {
        bool changeFirst = (seed & 4) != 0;
        uint256 count = plan.picked.length;
        outs = new BtcBuilder.TxOut[](count + (change > 0 ? 1 : 0));
        for (uint256 i = 0; i < count; i++) {
            outs[
                ((change > 0 && changeFirst) ? 1 : 0) + i
            ] = _bridge_redemptionOutput(plan, i);
        }
        if (change > 0) {
            changeIndex = changeFirst ? 0 : uint32(count);
            outs[changeIndex] = BtcBuilder.TxOut(
                uint64(change),
                _bridge_scriptFor(plan.wallet, seed >> 8)
            );
        }
    }

    function _bridge_redemptionTx(
        bridge_RedemptionPlan memory plan,
        uint256 seed,
        uint8 mode
    ) internal view returns (BitcoinTx.Info memory, uint32, uint256) {
        uint256 change = _bridge_redemptionChange(plan, seed, mode);
        (
            BtcBuilder.TxOut[] memory outs,
            uint32 changeIndex
        ) = _bridge_redemptionOutputs(plan, change, seed);
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](1);
        ins[0] = BtcBuilder.TxIn(plan.main.txHash, plan.main.txOutputIndex);
        return (BtcBuilder.buildTx(ins, outs), changeIndex, change);
    }

    function _bridge_redemptionProofClamped(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed,
        uint8 mode
    ) internal {
        (
            bool ok,
            bridge_RedemptionPlan memory plan
        ) = _bridge_planRedemptionProof(walletSeed, count, feeSeed, mode);
        if (!ok) return;
        (
            BitcoinTx.Info memory redemptionTx,
            uint32 changeIndex,
            uint256 change
        ) = _bridge_redemptionTx(plan, feeSeed, mode);
        bridge_submitRedemptionProof(
            redemptionTx,
            _bridge_prove(redemptionTx, feeSeed >> 32),
            plan.main,
            plan.wallet
        );
        for (uint256 i = 0; i < plan.picked.length; i++)
            harnessRedemptions[plan.picked[i]].closed = true;
        BitcoinTx.UTXO memory newMain;
        if (change > 0)
            newMain = BitcoinTx.UTXO(
                BtcBuilder.txHash(redemptionTx),
                changeIndex,
                uint64(change)
            );
        _bridge_replaceMainUtxo(plan.wallet, plan.main, newMain);
    }

    /// @dev A pending request whose timeout elapsed, on a wallet the Bridge
    ///      accepts a timeout notification for.
    function _bridge_pickTimedOutRedemption(
        uint256 seed
    ) internal view returns (bool, uint256) {
        uint256 n = harnessRedemptions.length;
        uint256 timeout = _bridge_redemptionParams().timeout;
        for (uint256 k = 0; k < min(n, bridge_SCAN_LIMIT); k++) {
            uint256 idx = ((seed % n) + k) % n;
            HarnessRedemption storage r = harnessRedemptions[idx];
            if (r.closed) continue;
            if (
                ((uint256(1) << _bridge_state(r.walletPkh)) &
                    (bridge_LIVE | bridge_MOVING_FUNDS | bridge_TERMINATED)) ==
                0
            ) continue;
            uint256 requestedAt = bridge
                .pendingRedemptions(
                    _bridge_redemptionKey(r.walletPkh, r.redeemerOutputScript)
                )
                .requestedAt;
            if (requestedAt != 0 && block.timestamp > requestedAt + timeout)
                return (true, idx);
        }
        return (false, 0);
    }

    // ―――― Moving funds ――――

    /// @dev Target wallets of a commitment: `N = min(liveWalletsCount,
    ///      ceil(balance / walletMaxBtcTransfer))` Live harness wallets other
    ///      than the source, sorted strictly ascending as the Bridge requires.
    function _bridge_targets(
        bytes20 source,
        uint256 balance,
        uint256 seed
    ) internal view returns (bool, bytes20[] memory targets) {
        uint256 maxTransfer = _bridge_walletParams().maxTransfer;
        uint256 expected = min(
            bridge.liveWalletsCount(),
            (balance + maxTransfer - 1) / maxTransfer
        );
        uint256 n = harnessWallets.length;
        bytes20[] memory candidates = new bytes20[](n);
        uint256 c;
        for (uint256 i = 0; i < n; i++) {
            bytes20 w = harnessWallets[i];
            if (w != source && _bridge_state(w) == 1) candidates[c++] = w;
        }
        if (expected == 0 || c < expected) return (false, targets);
        targets = new bytes20[](expected);
        for (uint256 i = 0; i < expected; i++)
            targets[i] = candidates[((seed % c) + i) % c];
        for (uint256 i = 1; i < expected; i++) {
            bytes20 key = targets[i];
            uint256 j = i;
            while (j > 0 && uint160(targets[j - 1]) > uint160(key)) {
                targets[j] = targets[j - 1];
                j--;
            }
            targets[j] = key;
        }
        return (true, targets);
    }

    /// @dev Single input (the main UTXO); one P2WPKH/P2PKH output per
    ///      committed target in commitment order, value split evenly with the
    ///      remainder on the first output.
    function _bridge_movingFundsTx(
        BitcoinTx.UTXO memory main,
        bytes20[] memory targets,
        uint256 total,
        uint256 seed
    ) internal pure returns (BitcoinTx.Info memory) {
        uint256 n = targets.length;
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 value = total / n + (i == 0 ? total % n : 0);
            outs[i] = BtcBuilder.TxOut(
                uint64(value),
                _bridge_scriptFor(targets[i], seed >> i)
            );
        }
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](1);
        ins[0] = BtcBuilder.TxIn(main.txHash, main.txOutputIndex);
        return BtcBuilder.buildTx(ins, outs);
    }

    function _bridge_movingFundsProofClamped(
        uint256 walletSeed,
        uint256 feeSeed,
        uint8 mode
    ) internal {
        (bool found, bytes20 w) = _bridge_pickEligible(
            walletSeed,
            bridge_KIND_MOVING_PROOF
        );
        if (!found) return;
        (, BitcoinTx.UTXO memory main) = _bridge_mainUtxo(w);
        bytes20[] memory targets = bridge_commitments[w];
        uint256 n = targets.length;
        if (main.txOutputValue <= n) return;
        if (ghosts.movedFundsKeys.length + n > FIZZ_SCAN_CAP) return;
        uint256 fee = _bridge_totalFee(
            feeSeed,
            mode,
            _bridge_movingParams().txMaxTotalFee,
            main.txOutputValue - n
        );
        BitcoinTx.Info memory movingFundsTx = _bridge_movingFundsTx(
            main,
            targets,
            main.txOutputValue - fee,
            feeSeed
        );
        bridge_submitMovingFundsProof(
            movingFundsTx,
            _bridge_prove(movingFundsTx, feeSeed >> 32),
            main,
            w
        );
        _bridge_recordMovedFunds(
            BtcBuilder.txHash(movingFundsTx),
            targets,
            main.txOutputValue - fee
        );
        // Moving funds deletes the main UTXO of the source wallet.
        _bridge_replaceMainUtxo(w, main, BitcoinTx.UTXO(bytes32(0), 0, 0));
        delete bridge_commitments[w];
    }

    function _bridge_recordMovedFunds(
        bytes32 txHash,
        bytes20[] memory targets,
        uint256 total
    ) internal {
        uint256 n = targets.length;
        for (uint256 i = 0; i < n; i++) {
            bridge_movedFunds.push(
                bridge_MovedFunds(
                    txHash,
                    uint32(i),
                    targets[i],
                    uint64(total / n + (i == 0 ? total % n : 0))
                )
            );
        }
    }

    /// @dev Pending sweep request whose target wallet can still sweep it
    ///      (`forTimeout == false`) or whose timeout elapsed (`true`).
    function _bridge_pickMovedFunds(
        uint256 seed,
        bool forTimeout
    ) internal view returns (bool, uint256) {
        uint256 n = bridge_movedFunds.length;
        uint256 timeout = _bridge_movingParams().sweepTimeout;
        for (uint256 k = 0; k < min(n, bridge_SCAN_LIMIT); k++) {
            uint256 i = ((seed % n) + k) % n;
            bridge_MovedFunds memory mf = bridge_movedFunds[i];
            MovingFunds.MovedFundsSweepRequest memory req = bridge
                .movedFundsSweepRequests(
                    uint256(
                        keccak256(abi.encodePacked(mf.txHash, mf.outputIndex))
                    )
                );
            if (req.state != MovingFunds.MovedFundsSweepRequestState.Pending)
                continue;
            uint256 targetState = _bridge_state(mf.target);
            if (forTimeout) {
                uint256 mask =
                    bridge_LIVE | bridge_MOVING_FUNDS | bridge_TERMINATED;
                if (
                    ((uint256(1) << targetState) & mask) != 0 &&
                    block.timestamp > uint256(req.createdAt) + timeout
                ) return (true, i);
            } else {
                (bool ok, ) = _bridge_mainUtxo(mf.target);
                if (
                    ok &&
                    ((uint256(1) << targetState) &
                        (bridge_LIVE | bridge_MOVING_FUNDS)) !=
                        0
                ) return (true, i);
            }
        }
        return (false, 0);
    }

    /// @dev Inputs: the moved funds UTXO first, then the target wallet main
    ///      UTXO when there is one. One P2WPKH/P2PKH output to the target.
    function _bridge_movedFundsSweepClamped(
        uint256 requestSeed,
        uint256 feeSeed,
        uint8 mode
    ) internal {
        (bool found, uint256 i) = _bridge_pickMovedFunds(requestSeed, false);
        if (!found) return;
        bridge_MovedFunds memory mf = bridge_movedFunds[i];
        (, BitcoinTx.UTXO memory main) = _bridge_mainUtxo(mf.target);
        uint256 inputsTotal = uint256(mf.value) + main.txOutputValue;
        if (inputsTotal <= 1 || inputsTotal - 1 > type(uint64).max) return;
        uint256 output =
            inputsTotal -
                _bridge_totalFee(
                    feeSeed,
                    mode,
                    _bridge_movingParams().sweepTxMaxTotalFee,
                    inputsTotal - 1
                );
        BitcoinTx.Info memory sweepTx = _bridge_movedSweepTx(
            mf,
            main,
            uint64(output),
            feeSeed
        );
        bridge_submitMovedFundsSweepProof(
            sweepTx,
            _bridge_prove(sweepTx, feeSeed >> 32),
            main
        );
        _bridge_replaceMainUtxo(
            mf.target,
            main,
            BitcoinTx.UTXO(BtcBuilder.txHash(sweepTx), 0, uint64(output))
        );
    }

    function _bridge_movedSweepTx(
        bridge_MovedFunds memory mf,
        BitcoinTx.UTXO memory main,
        uint64 output,
        uint256 seed
    ) internal pure returns (BitcoinTx.Info memory) {
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](
            main.txHash != bytes32(0) ? 2 : 1
        );
        ins[0] = BtcBuilder.TxIn(mf.txHash, mf.outputIndex);
        if (ins.length == 2)
            ins[1] = BtcBuilder.TxIn(main.txHash, main.txOutputIndex);
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](1);
        outs[0] = BtcBuilder.TxOut(
            output,
            _bridge_scriptFor(mf.target, seed >> 8)
        );
        return BtcBuilder.buildTx(ins, outs);
    }

    // ―――― Fraud ――――

    function _bridge_pubKey(
        uint256 keyIndex
    ) internal view returns (bytes memory) {
        return abi.encodePacked(walletPubX[keyIndex], walletPubY[keyIndex]);
    }

    function _bridge_challengeKey(
        bytes memory pubKey,
        bytes32 preimageSha256
    ) internal pure returns (uint256) {
        return
            uint256(
                keccak256(
                    abi.encodePacked(
                        pubKey,
                        sha256(abi.encodePacked(preimageSha256))
                    )
                )
            );
    }

    function _bridge_utxoKey(
        bytes32 txHash,
        uint32 index
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(txHash, index)));
    }

    /// @dev BIP-143 style preimage. Only the outpoint (offset 68) and the
    ///      sighash type (last 4 bytes) are parsed by the Bridge; the other
    ///      fields are salted junk so repeated challenges stay unique.
    function _bridge_witnessPreimage(
        bytes32 txHash,
        uint32 index,
        bytes32 salt
    ) internal pure returns (bytes memory) {
        bytes memory head = abi.encodePacked(
            hex"01000000",
            keccak256(abi.encodePacked("fizz.prevouts", salt)),
            keccak256(abi.encodePacked("fizz.sequences", salt))
        );
        // Outpoint at offset 68, then the script code, amount and sequence.
        bytes memory body = abi.encodePacked(
            txHash,
            _bridge_le32(index),
            hex"1976a914",
            bytes20(salt),
            hex"88ac",
            _bridge_le64(uint64(uint256(salt)))
        );
        bytes memory tail = abi.encodePacked(
            hex"ffffffff",
            keccak256(abi.encodePacked("fizz.outputs", salt)),
            hex"00000000",
            hex"01000000" // SIGHASH_ALL
        );
        return bytes.concat(head, body, tail);
    }

    /// @dev Legacy preimage with a single input whose scriptSig is non-empty.
    function _bridge_nonWitnessPreimage(
        bytes32 txHash,
        uint32 index,
        bytes32 salt
    ) internal pure returns (bytes memory) {
        bytes memory inputs = abi.encodePacked(
            hex"01000000",
            hex"01", // one input
            txHash,
            _bridge_le32(index),
            hex"0151", // scriptSig: 1 byte
            hex"ffffffff"
        );
        bytes memory rest = abi.encodePacked(
            hex"01", // one output (junk, not parsed)
            _bridge_le64(1),
            hex"20",
            salt,
            hex"00000000",
            hex"01000000" // SIGHASH_ALL
        );
        return bytes.concat(inputs, rest);
    }

    function _bridge_heartbeatMessage(
        bytes32 salt
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"ffffffffffffffff", uint64(uint256(salt)));
    }

    /// @dev First swept harness deposit starting at `seed`.
    function _bridge_findSweptDeposit(
        uint256 seed
    ) internal view returns (bool, bytes32, uint32) {
        uint256 n = harnessDeposits.length;
        for (uint256 k = 0; k < min(n, bridge_SCAN_LIMIT); k++) {
            HarnessDeposit storage d = harnessDeposits[((seed % n) + k) % n];
            if (d.swept) return (true, d.fundingTxHash, d.outputIndex);
        }
        return (false, bytes32(0), 0);
    }

    function _bridge_buildChallenge(
        bytes20 w,
        uint8 kind,
        uint256 seed
    ) internal returns (bridge_Challenge memory c) {
        bytes32 salt = _bridge_entropy(seed);
        c.walletPkh = w;
        c.witness = (seed & 1) == 0;
        bytes32 txHash;
        uint32 index;
        bool ok;

        if (kind == 3) {
            c.heartbeat = true;
            c.preimage = _bridge_heartbeatMessage(salt);
            return c;
        }
        if (kind == 0)
            (ok, txHash, index) = _bridge_findSweptDeposit(seed >> 8);
        else if (kind == 1 && bridge_spentMainUtxos.length > 0) {
            BitcoinTx.UTXO memory spent = bridge_spentMainUtxos[
                (seed >> 8) % bridge_spentMainUtxos.length
            ];
            (ok, txHash, index) = (true, spent.txHash, spent.txOutputIndex);
        } else if (kind == 2) {
            BitcoinTx.UTXO memory main;
            (, main) = _bridge_mainUtxo(w);
            (ok, txHash, index) = (
                main.txHash != bytes32(0),
                main.txHash,
                main.txOutputIndex
            );
        }
        if (!ok) {
            // Random outpoint nobody has spent: an actual fraud claim.
            (txHash, index) = (
                keccak256(abi.encodePacked("fizz.outpoint", salt)),
                uint32(uint256(salt) % 4)
            );
        }
        c.utxoKey = _bridge_utxoKey(txHash, index);
        c.preimage =
            c.witness
                ? _bridge_witnessPreimage(txHash, index, salt)
                : _bridge_nonWitnessPreimage(txHash, index, salt);
    }

    function _bridge_sign(
        bridge_Challenge memory c
    ) internal returns (BitcoinTx.RSVSignature memory sig) {
        uint256 k = walletKeyIndex[c.walletPkh];
        c.walletPublicKey = _bridge_pubKey(k);
        c.preimageSha256 = sha256(c.preimage);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            walletPrivKeys[k],
            sha256(abi.encodePacked(c.preimageSha256))
        );
        sig = BitcoinTx.RSVSignature(r, s, v);
    }

    /// @dev Challenge deposit: the required amount, sometimes plus a random
    ///      surplus below 1 ether.
    function _bridge_challengeValue(
        uint256 seed
    ) internal view returns (uint256) {
        (uint96 required, , , ) = bridge.fraudParameters();
        return uint256(required) + (seed % 5 == 0 ? (seed >> 16) % 1 ether : 0);
    }

    function _bridge_submitChallenge(
        bridge_Challenge memory c,
        uint256 seed
    ) internal {
        BitcoinTx.RSVSignature memory sig = _bridge_sign(c);
        uint256 value = _bridge_challengeValue(seed);
        if (ghosts.challengeKeys.length >= FIZZ_SCAN_CAP) return;
        if (actor.balance < value) return;
        _bridge_doSubmitFraudChallenge(
            value,
            c.walletPublicKey,
            abi.encodePacked(c.preimageSha256),
            sig
        );
        bridge_challenges.push(c);
    }

    function _bridge_isOpen(
        bridge_Challenge storage c
    ) internal view returns (bool) {
        uint256 key = _bridge_challengeKey(c.walletPublicKey, c.preimageSha256);
        return
            bridge.fraudChallenges(key).reportedAt > 0 &&
            !bridge.fraudChallenges(key).resolved;
    }

    function _bridge_utxoSpent(uint256 key) internal view returns (bool) {
        return
            bridge.deposits(key).sweptAt > 0 ||
            bridge.spentMainUTXOs(key) ||
            bridge.movedFundsSweepRequests(key).state ==
                MovingFunds.MovedFundsSweepRequestState.Processed;
    }

    /// @dev kind 0: open non-heartbeat challenge whose UTXO is honestly spent
    ///      (one in four ignores that and attempts an undefendable defeat),
    ///      1: open heartbeat challenge, 2: open challenge whose defeat timeout
    ///      elapsed on a wallet the Bridge can still slash/terminate.
    function _bridge_challengeMatches(
        bridge_Challenge storage c,
        uint8 kind,
        uint256 seed
    ) internal view returns (bool) {
        if (!_bridge_isOpen(c)) return false;
        if (kind == 1) return c.heartbeat;
        if (kind == 0)
            return
                !c.heartbeat &&
                ((seed >> 200) % 4 == 0 || _bridge_utxoSpent(c.utxoKey));
        uint256 reportedAt = bridge
            .fraudChallenges(
                _bridge_challengeKey(c.walletPublicKey, c.preimageSha256)
            )
            .reportedAt;
        (, uint32 defeatTimeout, , ) = bridge.fraudParameters();
        uint256 mask =
            bridge_LIVE |
                bridge_MOVING_FUNDS |
                bridge_CLOSING |
                bridge_TERMINATED;
        return
            block.timestamp >= reportedAt + defeatTimeout &&
            ((uint256(1) << _bridge_state(c.walletPkh)) & mask) != 0;
    }

    function _bridge_pickChallenge(
        uint256 seed,
        uint8 kind
    ) internal view returns (bool, uint256) {
        uint256 n = bridge_challenges.length;
        for (uint256 k = 0; k < min(n, bridge_SCAN_LIMIT); k++) {
            uint256 idx = ((seed % n) + k) % n;
            if (_bridge_challengeMatches(bridge_challenges[idx], kind, seed))
                return (true, idx);
        }
        return (false, 0);
    }

    // ―――――――――――――――――――― Property hooks ―――――――――――――――――――――
    // The hooks fill `bridge_hook*` (declared in Properties.sol), set the
    // snapshot focus, wrap the protocol call with snapshots, update the ghosts
    // (only after the call succeeded) and then call the SP functions.

    function _bridge_resetHook() internal {
        delete bridge_hook;
        delete bridge_hookKeys;
        delete bridge_hookDepositors;
        delete bridge_hookCredit;
        delete bridge_hookDebt;
        delete bridge_hookTbtc;
        delete bridge_hookBank;
        delete bridge_hookRanges;
        delete bridge_hookPendSweeps;
        delete bridge_hookTargets;
    }

    function _bridge_subSat(
        uint256 a,
        uint256 b
    ) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    // ―――― Byte parsing (never reverts on well-formed lengths; malformed data yields ok == false) ――――

    function _bridge_word(
        bytes memory b,
        uint256 off
    ) internal pure returns (bytes32 w) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            w := mload(add(add(b, 32), off))
        }
    }

    function _bridge_leU32(
        bytes memory b,
        uint256 off
    ) internal pure returns (uint32 v) {
        for (uint256 i = 0; i < 4; i++)
            v |= uint32(uint8(b[off + i])) << uint32(8 * i);
    }

    function _bridge_leU64(
        bytes memory b,
        uint256 off
    ) internal pure returns (uint64 v) {
        for (uint256 i = 0; i < 8; i++)
            v |= uint64(uint8(b[off + i])) << uint64(8 * i);
    }

    function _bridge_slice(
        bytes memory b,
        uint256 off,
        uint256 len
    ) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) out[i] = b[off + i];
    }

    /// @dev Outpoints (hash, index) of a serialized input vector (compact size < 0xfd).
    function _bridge_parseInputs(
        bytes memory v
    ) internal pure returns (bool ok, bytes32[] memory hs, uint32[] memory ix) {
        if (v.length == 0) return (false, hs, ix);
        uint256 n = uint8(v[0]);
        if (n == 0 || n >= 0xfd) return (false, hs, ix);
        hs = new bytes32[](n);
        ix = new uint32[](n);
        uint256 off = 1;
        for (uint256 i = 0; i < n; i++) {
            if (off + 41 > v.length) return (false, hs, ix);
            hs[i] = _bridge_word(v, off);
            ix[i] = _bridge_leU32(v, off + 32);
            uint256 sl = uint8(v[off + 36]);
            if (sl >= 0xfd) return (false, hs, ix);
            off += 41 + sl;
        }
        ok = off == v.length;
    }

    /// @dev Values and LENGTH-PREFIXED scripts of a serialized output vector.
    function _bridge_parseOutputs(
        bytes memory v
    )
        internal
        pure
        returns (bool ok, uint64[] memory vals, bytes[] memory scripts)
    {
        if (v.length == 0) return (false, vals, scripts);
        uint256 n = uint8(v[0]);
        if (n == 0 || n >= 0xfd) return (false, vals, scripts);
        vals = new uint64[](n);
        scripts = new bytes[](n);
        uint256 off = 1;
        for (uint256 i = 0; i < n; i++) {
            if (off + 9 > v.length) return (false, vals, scripts);
            vals[i] = _bridge_leU64(v, off);
            uint256 sl = uint8(v[off + 8]);
            if (sl >= 0xfd || off + 9 + sl > v.length)
                return (false, vals, scripts);
            scripts[i] = _bridge_slice(v, off + 8, 1 + sl);
            off += 9 + sl;
        }
        ok = off == v.length;
    }

    /// @dev Public key hash of a length-prefixed P2WPKH / P2PKH script.
    function _bridge_scriptPkh(
        bytes memory s
    ) internal pure returns (bool, bytes20) {
        if (
            s.length == 23 &&
            uint8(s[0]) == 0x16 &&
            uint8(s[1]) == 0x00 &&
            uint8(s[2]) == 0x14
        ) {
            return (true, bytes20(_bridge_word(s, 3)));
        }
        if (
            s.length == 26 &&
            uint8(s[0]) == 0x19 &&
            uint8(s[1]) == 0x76 &&
            uint8(s[2]) == 0xa9 &&
            uint8(s[3]) == 0x14 &&
            uint8(s[24]) == 0x88 &&
            uint8(s[25]) == 0xac
        ) {
            return (true, bytes20(_bridge_word(s, 4)));
        }
        return (false, bytes20(0));
    }

    function _bridge_pkhOfPubKey(
        bytes memory pk
    ) internal pure returns (bool, bytes20) {
        if (pk.length < 64) return (false, bytes20(0));
        return (
            true,
            BtcBuilder.pubKeyHash(_bridge_word(pk, 0), _bridge_word(pk, 32))
        );
    }

    // ―――― UTXO / shadow tracking ――――

    /// @dev Remembers a main UTXO touched by a handler tx (SP-91 monotone shadow).
    function _bridge_trackUtxo(bytes32 txHash, uint32 index) internal {
        if (txHash == bytes32(0)) return;
        uint256 key = _bridge_utxoKey(txHash, index);
        uint256 n = ghosts.knownUtxoKeys.length;
        for (uint256 i = 0; i < n; i++) {
            if (ghosts.knownUtxoKeys[i] == key) return;
        }
        if (n < FIZZ_SCAN_CAP) ghosts.knownUtxoKeys.push(key);
    }

    /// @dev Refreshes `ghosts.everSpent` of every tracked key (after the check).
    function _bridge_refreshEverSpent() internal {
        uint256 n = ghosts.knownUtxoKeys.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 key = ghosts.knownUtxoKeys[i];
            if (!ghosts.everSpent[key] && bridge.spentMainUTXOs(key))
                ghosts.everSpent[key] = true;
        }
    }

    /// @dev Refreshes the sweep request shadows of the window scanned by SP-103 and advances the cursor.
    function _bridge_refreshSweepShadows() internal {
        uint256 n = ghosts.movedFundsKeys.length;
        if (n == 0) return;
        uint256 steps = n < FIZZ_CURSOR_STEP ? n : FIZZ_CURSOR_STEP;
        uint256 cursor = bridge_sweepCursor % n;
        for (uint256 i = 0; i < steps; i++) {
            uint256 key = ghosts.movedFundsKeys[(cursor + i) % n];
            ghosts.prevSweepState[key] = uint8(
                bridge.movedFundsSweepRequests(key).state
            );
        }
        bridge_sweepCursor = (cursor + steps) % n;
    }

    // ―――― Wallet hub (HUB_WALLET) ――――

    function _bridge_refreshWalletShadows() internal {
        uint256 n = harnessWallets.length;
        for (uint256 i = 0; i < n; i++) {
            bytes20 w = harnessWallets[i];
            Wallets.Wallet memory wal = bridge.wallets(w);
            ghosts.prevWalletState[w] = uint8(wal.state);
            ghosts.prevCreatedAt[w] = wal.createdAt;
            ghosts.prevMovingFundsRequestedAt[w] = wal.movingFundsRequestedAt;
            ghosts.prevClosingStartedAt[w] = wal.closingStartedAt;
        }
    }

    /// @dev Number of Active / ActionPending reservations anchored at each harness wallet.
    function _bridge_anchorCounts()
        internal
        view
        returns (uint256[] memory counts)
    {
        uint256 nw = harnessWallets.length;
        counts = new uint256[](nw);
        uint256 n = min(harnessReservationKeys.length, FIZZ_SCAN_CAP);
        for (uint256 k = 0; k < n; k++) {
            Reservation.ReservationRequest memory r = reservationRouter
                .reservations(harnessReservationKeys[k]);
            if (
                r.state != Reservation.ReservationState.Active &&
                r.state != Reservation.ReservationState.ActionPending
            ) continue;
            for (uint256 j = 0; j < nw; j++) {
                if (harnessWallets[j] == r.walletPubKeyHash) counts[j]++;
            }
        }
    }

    /// @dev Pre-call: shadows of every harness wallet = current values (so the hub checks the
    ///      transitions of THIS call), and, when `captureMoves`, whether each Live wallet has a main
    ///      UTXO / proven anchors (they persist once the wallet leaves Live). Call after `_bridge_resetHook`.
    function _bridge_walletPre(bool captureMoves) internal {
        _bridge_refreshWalletShadows();
        if (captureMoves) {
            uint256[] memory anchors = _bridge_anchorCounts();
            for (uint256 i = 0; i < harnessWallets.length; i++) {
                bytes20 w = harnessWallets[i];
                Wallets.Wallet memory wal = bridge.wallets(w);
                if (wal.state != Wallets.WalletState.Live) continue;
                ghosts.hadMainUtxoWhenMovingFunds[w] =
                    wal.mainUtxoHash != bytes32(0);
                ghosts.hadProvenAnchorsWhenMovingFunds[w] = anchors[i] > 0;
            }
        }
        bridge_hook.seizeBefore = walletRegistry.seizeCalls();
    }

    function _bridge_walletPost() internal {
        property_walletStateMachine();
        property_walletMovesNeedBtcOrProvenAnchors();
        property_walletTimestampsWriteOnce();
        _bridge_refreshWalletShadows();
    }

    /// @dev Common start of the wallet hub handlers: reset, pre-call shadows, hook kind, focus, snapshot.
    function _bridge_hubBegin(
        bytes20 w,
        bool captureMoves,
        uint8 movingKind,
        uint256 mainValue
    ) internal {
        _bridge_resetHook();
        _bridge_walletPre(captureMoves);
        bridge_hook.movingKind = movingKind;
        bridge_hook.mainValue = mainValue;
        _setFocus(0, w, bytes20(0), address(0), 0);
        snapshotBefore();
    }

    function _bridge_mainValueOf(
        bytes20 w,
        BitcoinTx.UTXO memory m
    ) internal view returns (uint256) {
        return
            bridge.wallets(w).mainUtxoHash != bytes32(0) ? m.txOutputValue : 0;
    }

    function _bridge_registerWallet(
        bytes32 id,
        uint256 keyIndex,
        bool viaRegistryMock
    ) internal {
        bytes20 pkh = BtcBuilder.pubKeyHash(
            walletPubX[keyIndex],
            walletPubY[keyIndex]
        );
        _bridge_hubBegin(pkh, false, 0, 0);
        bridge_hook.walletId = id;
        if (viaRegistryMock) {
            walletRegistry.createWallet(
                id,
                walletPubX[keyIndex],
                walletPubY[keyIndex]
            );
        } else {
            vm.prank(address(walletRegistry));
            bridge.__ecdsaWalletCreatedCallback(
                id,
                walletPubX[keyIndex],
                walletPubY[keyIndex]
            );
        }
        walletKeyIndex[pkh] = keyIndex;
        _recordWallet(pkh);
        snapshotAfter();
        property_walletRegistration();
        _bridge_walletPost();
    }

    function _bridge_secondaryPre(uint8 selector, uint256 arg0) internal {
        _bridge_resetHook();
        _bridge_walletPre(true);
        bytes20 w;
        if (selector == 0) {
            (bool found, bytes20 picked) = _bridge_pickWallet(
                arg0,
                bridge_LIVE
            );
            if (found) w = picked;
        }
        _setFocus(0, w, bytes20(0), address(0), 0);
        snapshotBefore();
    }

    function _bridge_secondaryPost(uint8 selector) internal {
        snapshotAfter();
        if (
            selector == 3 &&
            (!bridge.isVaultTrusted(address(tbtcVault)) ||
                !bridge.isVaultTrusted(address(reservationVault)))
        ) {
            ghosts.vaultTrustRevoked = true;
        }
        property_moveFundsRouting();
        property_noPrivilegeEscalation();
        property_lifecycleRolesEnforced();
        _bridge_walletPost();
    }

    // ―――― Deposit reveals (HUB_RES / REVEAL_BRIDGE) ――――

    function _bridge_reveal(
        BitcoinTx.Info memory fundingTx,
        Deposit.DepositRevealInfo memory reveal,
        bool withExtra,
        bytes32 extraData
    ) internal {
        if (
            reveal.vault == address(reservationVault) &&
            ghosts.reservedDepositKeys.length >= FIZZ_SCAN_CAP
        ) return;
        uint256 key = _bridge_utxoKey(
            BtcBuilder.txHash(fundingTx),
            reveal.fundingOutputIndex
        );
        _bridge_resetHook();
        bridge_hook.directRebate = true;
        ghosts.lastHandlerId = HID_REVEAL_RESERVED;
        _setFocus(key, bytes20(0), bytes20(0), actor, 0);
        snapshotBefore();
        if (withExtra)
            bridge.revealDepositWithExtraData(fundingTx, reveal, extraData);
        else bridge.revealDeposit(fundingTx, reveal);
        _bridge_recordRevealedDeposit(fundingTx, reveal);
        snapshotAfter();
        _bridge_revealGhosts(key, reveal);
        property_depositRevealPostconditions();
        property_depositTreasuryFeeFloor();
        property_depositRecordWriteOnce();
        property_rebateAppliedWithinPreview();
        property_rebateWindowNoHistoryLoss();
        property_rebateBudgetNotRecyclable();
        property_rebateHistoryAppendOnly();
        property_activeCountLedger();
        property_totalAmountLedger();
        property_walletCountLedger();
        property_walletAmountLedger();
        property_walletLedgerCrossSums();
        property_pendingReservedDepositsLedger();
        property_reservedDepositSweptIffPosition();
        property_reservationZeroState();
        property_counterDirectionalAttribution();
        _peripheral_refreshRebateShadow();
        ghosts.lastHandlerId = HID_NONE;
        bridge_hook.directRebate = false;
    }

    function _bridge_revealGhosts(
        uint256 key,
        Deposit.DepositRevealInfo memory reveal
    ) internal {
        Deposit.DepositRequest memory d = bridge.deposits(key);
        bool isRes = bridge.isReservedDeposit(key);
        ghosts.depositImageHash[key] = keccak256(
            abi.encode(
                d.depositor,
                d.amount,
                d.revealedAt,
                d.vault,
                d.treasuryFee,
                d.extraData,
                isRes
            )
        );
        ghosts.refundDeadline[key] = uint32(
            _bridge_le32(uint32(reveal.refundLocktime))
        );
        if (isRes) {
            ghosts.reservedDepositKeys.push(key);
            return;
        }
        bridge_revealedKeys.push(key);
        (, uint64 divisor, , ) = bridge.depositParameters();
        uint256 full = divisor > 0 ? uint256(d.amount) / divisor : 0;
        if (
            full > d.treasuryFee && ghosts.rebateGrants.length < FIZZ_SCAN_CAP
        ) {
            ghosts.rebateGrants.push(
                RebateGrant({
                    staker: _peripheral_stakerOf(d.depositor),
                    timestamp: uint32(block.timestamp),
                    rebate: uint64(full - d.treasuryFee),
                    live: true
                })
            );
        }
        ghosts.sameBlockSecondRebate = _tv_sameBlockRebate();
    }

    // ―――― Deposit sweeps (SWEEP) ――――

    struct bridge_SweepParse {
        bool ok;
        bytes20 w;
        uint64 out;
        bytes32[] hs;
        uint32[] ix;
    }

    /// @dev Single-output transaction paying a wallet P2PKH / P2WPKH.
    function _bridge_parseSweep(
        BitcoinTx.Info memory info
    ) internal pure returns (bridge_SweepParse memory p) {
        (
            bool okIn,
            bytes32[] memory hs,
            uint32[] memory ix
        ) = _bridge_parseInputs(info.inputVector);
        (
            bool okOut,
            uint64[] memory vals,
            bytes[] memory scripts
        ) = _bridge_parseOutputs(info.outputVector);
        if (!okIn || !okOut || vals.length != 1) return p;
        (bool okW, bytes20 w) = _bridge_scriptPkh(scripts[0]);
        if (!okW) return p;
        p = bridge_SweepParse(true, w, vals[0], hs, ix);
    }

    /// @dev Stores the wallet's current main UTXO in the hook; false when `m` does not match the Bridge's hash.
    function _bridge_loadOldMain(
        bytes20 w,
        BitcoinTx.UTXO memory m
    ) internal returns (bool) {
        bytes32 hash = bridge.wallets(w).mainUtxoHash;
        if (hash == bytes32(0)) return true;
        if (
            keccak256(
                abi.encodePacked(m.txHash, m.txOutputIndex, m.txOutputValue)
            ) != hash
        ) return false;
        bridge_hook.oldMainTxHash = m.txHash;
        bridge_hook.oldMainIndex = m.txOutputIndex;
        bridge_hook.oldMainValue = m.txOutputValue;
        return true;
    }

    function _bridge_sweepPre(
        BitcoinTx.Info memory sweepTx,
        BitcoinTx.UTXO memory mainUtxo,
        address vault
    ) internal returns (bool) {
        _bridge_resetHook();
        bridge_SweepParse memory p = _bridge_parseSweep(sweepTx);
        if (!p.ok || p.hs.length > FIZZ_SCAN_CAP) return false;
        if (!_bridge_loadOldMain(p.w, mainUtxo)) return false;
        if (!_bridge_loadDeposits(p.hs, p.ix)) return false;
        if (!_bridge_prepareCredits(vault, p.out, BtcBuilder.txHash(sweepTx)))
            return false;
        _setFocus(0, p.w, bytes20(0), address(0), 0);
        snapshotBefore();
        bridge_hook.sweepOk = true;
        return true;
    }

    function _bridge_loadDeposits(
        bytes32[] memory hs,
        uint32[] memory ix
    ) internal returns (bool) {
        bridge_Hook storage h = bridge_hook;
        bool mainSkipped = h.oldMainTxHash == bytes32(0);
        for (uint256 i = 0; i < hs.length; i++) {
            if (
                !mainSkipped &&
                hs[i] == h.oldMainTxHash &&
                ix[i] == h.oldMainIndex
            ) {
                mainSkipped = true;
                continue;
            }
            uint256 key = _bridge_utxoKey(hs[i], ix[i]);
            Deposit.DepositRequest memory d = bridge.deposits(key);
            if (d.revealedAt == 0 || d.sweptAt != 0) return false;
            bridge_hookKeys.push(key);
            h.sumAmount += d.amount;
            h.sumTreasuryFee += d.treasuryFee;
        }
        return bridge_hookKeys.length > 0;
    }

    /// @dev Fee, routing, new main UTXO and the per-depositor credit / pre-call balances of a sweep.
    function _bridge_prepareCredits(
        address vault,
        uint64 out,
        bytes32 txHash
    ) internal returns (bool) {
        bridge_Hook storage h = bridge_hook;
        uint256 inputs = h.sumAmount + h.oldMainValue;
        if (out > inputs) return false;
        h.sweepFee = inputs - out;
        h.sweepTrusted = vault != address(0) && bridge.isVaultTrusted(vault);
        h.sweepViaTbtcVault = h.sweepTrusted && vault == address(tbtcVault);
        h.bridgeTreasury = bridge.treasury();
        h.treasuryBankBefore = bank.balanceOf(h.bridgeTreasury);
        h.newMainTxHash = txHash;
        h.newMainIndex = 0;
        h.newMainValue = out;
        uint256 n = bridge_hookKeys.length;
        uint256 base = h.sweepFee / n;
        uint256 rem = h.sweepFee % n;
        for (uint256 i = 0; i < n; i++) {
            Deposit.DepositRequest memory d = bridge.deposits(
                bridge_hookKeys[i]
            );
            uint256 share = i == n - 1 ? base + rem : base;
            uint256 net = uint256(d.amount) - d.treasuryFee;
            if (net < share) return false;
            _bridge_addCredit(d.depositor, net - share);
        }
        return true;
    }

    function _bridge_addCredit(address dep, uint256 credit) internal {
        uint256 n = bridge_hookDepositors.length;
        for (uint256 i = 0; i < n; i++) {
            if (bridge_hookDepositors[i] == dep) {
                bridge_hookCredit[i] += credit;
                return;
            }
        }
        bridge_hookDepositors.push(dep);
        bridge_hookCredit.push(credit);
        bridge_hookDebt.push(tbtcVault.optimisticMintingDebt(dep));
        bridge_hookTbtc.push(tbtc.balanceOf(dep));
        bridge_hookBank.push(bank.balanceOf(dep));
    }

    function _bridge_sweepPost() internal {
        snapshotAfter();
        bridge_Hook storage h = bridge_hook;
        uint256 delta = h.sumAmount - h.sweepFee;
        ghosts.bankIssuedSat += delta;
        ghosts.btcCustodySat += delta;
        for (uint256 i = 0; i < bridge_hookKeys.length; i++) {
            ghosts.depositSweptAt[bridge_hookKeys[i]] = bridge
                .deposits(bridge_hookKeys[i])
                .sweptAt;
        }
        _bridge_trackUtxo(h.oldMainTxHash, h.oldMainIndex);
        property_sweepBankCreditEqualsBtcDelta();
        property_sweepFeeDistribution();
        property_sweepTbtcVaultMintAndDebt();
        property_sweepPostconditions();
        property_depositRecordWriteOnce();
        property_optimisticDebtBounded();
        property_optimisticDebtAttribution();
        property_spentUtxoMonotone();
        _tv_refreshOptDebt();
        _bridge_refreshEverSpent();
    }

    // ―――― Redemption proofs / timeouts (REDEEM_PROOF / REDEEM_TIMEOUT) ――――

    function _bridge_redemptionPre(
        BitcoinTx.Info memory redemptionTx,
        BitcoinTx.UTXO memory mainUtxo,
        bytes20 w
    ) internal returns (bool) {
        _bridge_resetHook();
        (
            bool okOut,
            uint64[] memory vals,
            bytes[] memory scripts
        ) = _bridge_parseOutputs(redemptionTx.outputVector);
        if (!okOut) return false;
        if (
            bridge.wallets(w).mainUtxoHash == bytes32(0) ||
            !_bridge_loadOldMain(w, mainUtxo)
        ) return false;
        bridge_hook.bridgeTreasury = bridge.treasury();
        bridge_hook.newMainTxHash = BtcBuilder.txHash(redemptionTx);
        _bridge_scanRedemptionOutputs(w, vals, scripts);
        bridge_hook.redOk = true;
        _setFocus(0, w, bytes20(0), address(0), 0);
        snapshotBefore();
        return true;
    }

    /// @dev Splits the outputs into the (first) wallet change output and the pending requests they pay.
    function _bridge_scanRedemptionOutputs(
        bytes20 w,
        uint64[] memory vals,
        bytes[] memory scripts
    ) internal {
        bridge_Hook storage h = bridge_hook;
        bool changeSeen;
        for (uint256 j = 0; j < vals.length; j++) {
            (bool isWallet, bytes20 pkh) = _bridge_scriptPkh(scripts[j]);
            if (!changeSeen && isWallet && pkh == w && vals[j] > 0) {
                changeSeen = true;
                h.newMainIndex = uint32(j);
                h.newMainValue = vals[j];
                continue;
            }
            uint256 key = _bridge_redemptionKey(w, scripts[j]);
            Redemption.RedemptionRequest memory req = bridge.pendingRedemptions(
                key
            );
            if (req.requestedAt == 0) {
                if (bridge.timedOutRedemptions(key).requestedAt != 0)
                    h.sumTimedOut += vals[j];
                continue;
            }
            bridge_hookKeys.push(key);
            bridge_hookRanges.push(
                bridge_Range(
                    vals[j],
                    req.requestedAmount - req.treasuryFee,
                    req.txMaxFee
                )
            );
            h.sumReq += req.requestedAmount;
            h.sumFee += req.treasuryFee;
            h.sumBurn += req.requestedAmount - req.treasuryFee;
        }
    }

    function _bridge_redemptionPost() internal {
        snapshotAfter();
        bridge_Hook storage h = bridge_hook;
        ghosts.bankBurnedSat += h.sumBurn;
        uint256 outflow = uint256(h.oldMainValue) - h.newMainValue;
        ghosts.btcCustodySat = _bridge_subSat(ghosts.btcCustodySat, outflow);
        ghosts.absorbedFeeSat += int256(outflow) - int256(h.sumBurn);
        // GL-33: Bitcoin fee the wallet paid beyond the fee shares it charged its requests.
        if (outflow > h.sumBurn)
            ghosts.walletFeeSlackSat[focus.wallet0] += outflow - h.sumBurn;
        for (uint256 i = 0; i < bridge_hookKeys.length; i++) {
            EnumerableSet.remove(
                ghosts.pendingRedemptionKeys,
                bridge_hookKeys[i]
            );
        }
        _bridge_trackUtxo(h.oldMainTxHash, h.oldMainIndex);
        property_redemptionProofAccounting();
        property_redemptionWalletShortfallBounded();
        property_redemptionEscrowCoversPending();
        property_pendingRedemptionsValueSync();
        property_vetoEscrowCoversWithdrawable();
        property_spentUtxoMonotone();
        property_poolLiquidityCoversLiabilities();
        _bridge_refreshEverSpent();
    }

    function _bridge_redemptionTimeout(
        bytes20 w,
        uint32[] memory ids,
        bytes memory script
    ) internal {
        uint256 key = _bridge_redemptionKey(w, script);
        Redemption.RedemptionRequest memory req = bridge.pendingRedemptions(
            key
        );
        _bridge_resetHook();
        _bridge_walletPre(true);
        _setFocus(0, w, bytes20(0), req.redeemer, key);
        address staker = _peripheral_stakerOf(req.redeemer);
        _peripheral_snapshotBeforeAs(staker);
        uint8 st = bridge_stateOf(w);
        (, , , , uint32 timeout, , ) = bridge.redemptionParameters();
        // Out of model here: a rollingWindow above the chain clock.
        bridge_hook.probePre =
            req.requestedAt != 0 &&
            block.timestamp > uint256(req.requestedAt) + timeout &&
            (st == 1 || st == 2 || st == 5) &&
            rebateStaking.rollingWindow() <= block.timestamp;
        try bridge.notifyRedemptionTimeout(w, ids, script) {} catch {
            bridge_hook.probeReverted = true;
        }
        if (bridge_hook.probeReverted) {
            property_redemptionTimeoutNeverBlocked();
            return;
        }
        _peripheral_snapshotAfterAs(staker);
        EnumerableSet.remove(ghosts.pendingRedemptionKeys, key);
        _bridge_cancelGrant(staker, req.requestedAt, key);
        property_redemptionTimeoutRefund();
        property_redemptionTimeoutNeverBlocked();
        property_redemptionEscrowCoversPending();
        property_pendingRedemptionsValueSync();
        property_vetoEscrowCoversWithdrawable();
        property_cancelRebateRestoresOwnRebate();
        property_rebateDoubleDipNone();
        property_rebateHistoryAppendOnly();
        property_timeoutsNotEarly();
        property_moveFundsRouting();
        _peripheral_refreshRebateShadow();
        _bridge_walletPost();
    }

    /// @dev A timed-out request releases the rebate grant it consumed.
    function _bridge_cancelGrant(
        address staker,
        uint32 requestedAt,
        uint256 key
    ) internal {
        if (ghosts.rebateApplied[key] == 0) return;
        uint256 n = ghosts.rebateGrants.length;
        for (uint256 i = 0; i < n; i++) {
            RebateGrant storage g = ghosts.rebateGrants[i];
            if (g.live && g.staker == staker && g.timestamp == requestedAt) {
                g.live = false;
                return;
            }
        }
    }

    // ―――― Moving funds / moved funds sweeps (MOVING_PROOF / MOVED) ――――

    /// @return mode 0: skip the call, 1: hooked, 2: call without hooks.
    function _bridge_movingProofPre(
        BitcoinTx.Info memory movingFundsTx,
        BitcoinTx.UTXO memory mainUtxo,
        bytes20 w
    ) internal returns (uint8) {
        _bridge_resetHook();
        _bridge_walletPre(false);
        (
            bool ok,
            uint64[] memory vals,
            bytes[] memory scripts
        ) = _bridge_parseOutputs(movingFundsTx.outputVector);
        if (!ok) return 2;
        if (ghosts.movedFundsKeys.length + vals.length > FIZZ_SCAN_CAP)
            return 0;
        if (
            bridge.wallets(w).mainUtxoHash == bytes32(0) ||
            !_bridge_loadOldMain(w, mainUtxo)
        ) return 2;
        bridge_Hook storage h = bridge_hook;
        uint256 total;
        for (uint256 j = 0; j < vals.length; j++) {
            total += vals[j];
            (bool isPkh, bytes20 pkh) = _bridge_scriptPkh(scripts[j]);
            if (!isPkh) return 2;
            bridge_hookTargets.push(pkh);
        }
        if (total > h.oldMainValue) return 2;
        h.movingKind = bridge_MK_PROOF;
        h.mfTotal = total;
        h.mfFirstIdx = ghosts.movedFundsKeys.length;
        h.mfCount = vals.length;
        h.newMainTxHash = BtcBuilder.txHash(movingFundsTx);
        for (uint256 i = 0; i < harnessWallets.length; i++) {
            bridge_hookPendSweeps.push(
                bridge
                    .wallets(harnessWallets[i])
                    .pendingMovedFundsSweepRequestsCount
            );
        }
        _setFocus(0, w, bytes20(0), address(0), 0);
        snapshotBefore();
        return 1;
    }

    function _bridge_movingProofPost() internal {
        snapshotAfter();
        bridge_Hook storage h = bridge_hook;
        for (uint256 i = 0; i < h.mfCount; i++) {
            ghosts.movedFundsKeys.push(
                _bridge_utxoKey(h.newMainTxHash, uint32(i))
            );
        }
        delete ghosts.lastMovedTargets;
        for (uint256 i = 0; i < bridge_hookTargets.length; i++) {
            ghosts.lastMovedTargets.push(bridge_hookTargets[i]);
        }
        uint256 fee = uint256(h.oldMainValue) - h.mfTotal;
        ghosts.btcCustodySat = _bridge_subSat(ghosts.btcCustodySat, fee);
        ghosts.absorbedFeeSat += int256(fee);
        _bridge_trackUtxo(h.oldMainTxHash, h.oldMainIndex);
        property_movingFundsExits();
        property_movingFundsProofConservation();
        property_movedFundsSweepStateMachine();
        property_pendingMovedFundsCountSync();
        property_pendingSweepTargetsProcessable();
        property_spentUtxoMonotone();
        _bridge_walletPost();
        for (uint256 i = 0; i < h.mfCount; i++) {
            ghosts.prevSweepState[ghosts.movedFundsKeys[h.mfFirstIdx + i]] = 1;
        }
        _bridge_refreshSweepShadows();
        _bridge_refreshEverSpent();
    }

    /// @return hooked True when the sweep request context was captured (otherwise the call runs unhooked).
    function _bridge_movedSweepPre(
        BitcoinTx.Info memory sweepTx,
        BitcoinTx.UTXO memory mainUtxo
    ) internal returns (bool) {
        _bridge_resetHook();
        _bridge_walletPre(false);
        bridge_SweepParse memory p = _bridge_parseSweep(sweepTx);
        if (!p.ok || p.hs.length == 0 || p.hs.length > 2) return false;
        uint256 key = _bridge_utxoKey(p.hs[0], p.ix[0]);
        MovingFunds.MovedFundsSweepRequest memory req = bridge
            .movedFundsSweepRequests(key);
        if (
            req.state != MovingFunds.MovedFundsSweepRequestState.Pending ||
            req.walletPubKeyHash != p.w
        ) return false;
        if (!_bridge_loadOldMain(p.w, mainUtxo)) return false;
        uint256 inputs = uint256(req.value) + bridge_hook.oldMainValue;
        if (p.out > inputs) return false;
        bridge_hook.sweepKind = bridge_SK_PROOF;
        bridge_hook.sweepKey = key;
        bridge_hook.sweepFee = inputs - p.out;
        bridge_hook.newMainTxHash = BtcBuilder.txHash(sweepTx);
        bridge_hook.newMainIndex = 0;
        bridge_hook.newMainValue = p.out;
        ghosts.prevSweepState[key] = uint8(req.state);
        _setFocus(0, p.w, bytes20(0), address(0), 0);
        snapshotBefore();
        return true;
    }

    function _bridge_movedSweepPost() internal {
        snapshotAfter();
        ghosts.sweepsSettled++;
        bridge_Hook storage h = bridge_hook;
        ghosts.btcCustodySat = _bridge_subSat(ghosts.btcCustodySat, h.sweepFee);
        ghosts.absorbedFeeSat += int256(h.sweepFee);
        // GL-33: the sweep fee can lower the main UTXO without lowering pending redemptions.
        ghosts.walletFeeSlackSat[focus.wallet0] += h.sweepFee;
        _bridge_trackUtxo(h.oldMainTxHash, h.oldMainIndex);
        property_movedFundsSweepStateMachine();
        property_pendingMovedFundsCountSync();
        property_pendingSweepTargetsProcessable();
        property_spentUtxoMonotone();
        _bridge_walletPost();
        ghosts.prevSweepState[h.sweepKey] = uint8(
            bridge.movedFundsSweepRequests(h.sweepKey).state
        );
        _bridge_refreshSweepShadows();
        _bridge_refreshEverSpent();
    }

    // ―――― Honest anchor spends (SP-111) ――――

    /// @dev First outpoint (from `pickSeed`) that is an accepted reserved deposit (kind 0) or a consumed anchor
    ///      (kind 2). A stranded anchor (kind 3) is excluded: it is unspent and unproven by definition, and no
    ///      wallet is authorised to spend it (`requestReservationReanchor` needs state Active).
    function _bridge_pickHonest(
        uint256 pickSeed
    ) internal view returns (bool, HonestOutpoint memory) {
        uint256 n = ghosts.honestOutpoints.length;
        if (n > FIZZ_SCAN_CAP) n = FIZZ_SCAN_CAP;
        for (uint256 k = 0; k < n; k++) {
            HonestOutpoint memory o = ghosts.honestOutpoints[
                ((pickSeed % n) + k) % n
            ];
            if (o.kind == 0 || o.kind == 2) return (true, o);
        }
        HonestOutpoint memory none;
        return (false, none);
    }
}
