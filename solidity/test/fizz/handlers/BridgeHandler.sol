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
    uint8 internal constant bridge_FEE_ZERO = 1;
    uint8 internal constant bridge_FEE_MAX = 2;
    uint8 internal constant bridge_FEE_OVER = 3;

    uint256 internal constant bridge_SCAN_LIMIT = 64;
    uint256 internal constant bridge_MAX_BATCH = 5;
    /// @dev Refund locktime offset (seconds) from `block.timestamp`: above the
    ///      500M threshold and above any reveal-ahead period the setters allow.
    uint256 internal constant bridge_LOCKTIME_OFFSET = 600_000_000;
    uint256 internal constant bridge_SPENT_RING = 256;

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

    /// @dev Near-zero stress: sweep that pays no Bitcoin fee at all.
    function bridge_submitDepositSweepProof_zeroFee(
        uint256 walletSeed,
        uint256 count,
        uint256 feeSeed
    ) public {
        _bridge_sweepClamped(walletSeed, count, feeSeed, bridge_FEE_ZERO);
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

    /// @dev Medusa optimization objective that steers sequences
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

    function bridge_requestNewWallet(
        BitcoinTx.UTXO memory activeWalletMainUtxo
    ) public asActor {
        bridge.requestNewWallet(activeWalletMainUtxo);
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
    ///      and 1. One pick-2 call in four revokes the
    ///      reservation vault, so the untrusted-vault acceptance branch
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

    function _bridge_prove(
        BitcoinTx.Info memory info,
        uint256 seed
    ) internal pure returns (BitcoinTx.Proof memory) {
        return BtcBuilder.prove(info, 1 + (seed % 3));
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

    /// @dev Remembers a main UTXO touched by a handler tx, as a monotone shadow.
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
        _tv_refreshOptDebt();
        _bridge_refreshEverSpent();
    }
}
