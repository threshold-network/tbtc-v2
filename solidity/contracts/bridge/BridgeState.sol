// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity 0.8.17;

import {IWalletRegistry as EcdsaWalletRegistry} from "@keep-network/ecdsa/contracts/api/IWalletRegistry.sol";
import "@keep-network/random-beacon/contracts/ReimbursementPool.sol";

import "./IRelay.sol";
import "./Deposit.sol";
import "./Redemption.sol";
import "./Fraud.sol";
import "./Wallets.sol";
import "./MovingFunds.sol";

import "../bank/Bank.sol";

library BridgeState {
    /// @notice On-chain identifier of the wallet scheme used when
    ///         `requestNewWallet` is invoked. `Ecdsa` is the legacy
    ///         keep-network ECDSA DKG path; `Frost` routes via the
    ///         registered FROST wallet registry. Defaults to `Ecdsa`
    ///         on activation of the C-2 upgrade so post-deploy
    ///         behavior is unchanged until governance explicitly
    ///         flips the scheme. See `setNewWalletScheme` and
    ///         `dispatchNewWalletRequest`.
    enum WalletScheme {
        Ecdsa,
        Frost
    }

    struct Storage {
        // Address of the Bank the Bridge belongs to.
        Bank bank;
        // Bitcoin relay providing the current Bitcoin network difficulty.
        IRelay relay;
        // The number of confirmations on the Bitcoin chain required to
        // successfully evaluate an SPV proof.
        uint96 txProofDifficultyFactor;
        // ECDSA Wallet Registry contract handle.
        EcdsaWalletRegistry ecdsaWalletRegistry;
        // Reimbursement Pool contract handle.
        ReimbursementPool reimbursementPool;
        // Address where the deposit and redemption treasury fees will be sent
        // to. Treasury takes part in the operators rewarding process.
        address treasury;
        // Move depositDustThreshold to the next storage slot for a more
        // efficient variable layout in the storage.
        // slither-disable-next-line unused-state
        bytes32 __treasuryAlignmentGap;
        // The minimal amount that can be requested to deposit.
        // Value of this parameter must take into account the value of
        // `depositTreasuryFeeDivisor` and `depositTxMaxFee` parameters in order
        // to make requests that can incur the treasury and transaction fee and
        // still satisfy the depositor.
        uint64 depositDustThreshold;
        // Divisor used to compute the treasury fee taken from each deposit and
        // transferred to the treasury upon sweep proof submission. That fee is
        // computed as follows:
        // `treasuryFee = depositedAmount / depositTreasuryFeeDivisor`
        // For example, if the treasury fee needs to be 2% of each deposit,
        // the `depositTreasuryFeeDivisor` should be set to `50` because
        // `1/50 = 0.02 = 2%`.
        uint64 depositTreasuryFeeDivisor;
        // Maximum amount of BTC transaction fee that can be incurred by each
        // swept deposit being part of the given sweep transaction. If the
        // maximum BTC transaction fee is exceeded, such transaction is
        // considered a fraud.
        //
        // This is a per-deposit input max fee for the sweep transaction.
        uint64 depositTxMaxFee;
        // Defines the length of the period that must be preserved between
        // the deposit reveal time and the deposit refund locktime. For example,
        // if the deposit become refundable on August 1st, and the ahead period
        // is 7 days, the latest moment for deposit reveal is July 25th.
        // Value in seconds. The value equal to zero disables the validation
        // of this parameter.
        uint32 depositRevealAheadPeriod;
        // Move movingFundsTxMaxTotalFee to the next storage slot for a more
        // efficient variable layout in the storage.
        // slither-disable-next-line unused-state
        bytes32 __depositAlignmentGap;
        // Maximum amount of the total BTC transaction fee that is acceptable in
        // a single moving funds transaction.
        //
        // This is a TOTAL max fee for the moving funds transaction. Note
        // that `depositTxMaxFee` is per single deposit and `redemptionTxMaxFee`
        // is per single redemption. `movingFundsTxMaxTotalFee` is a total
        // fee for the entire transaction.
        uint64 movingFundsTxMaxTotalFee;
        // The minimal satoshi amount that makes sense to be transferred during
        // the moving funds process. Moving funds wallets having their BTC
        // balance below that value can begin closing immediately as
        // transferring such a low value may not be possible due to
        // BTC network fees. The value of this parameter must always be lower
        // than `redemptionDustThreshold` in order to prevent redemption requests
        // with values lower or equal to `movingFundsDustThreshold`.
        uint64 movingFundsDustThreshold;
        // Time after which the moving funds timeout can be reset in case the
        // target wallet commitment cannot be submitted due to a lack of live
        // wallets in the system. It is counted from the moment when the wallet
        // was requested to move their funds and switched to the MovingFunds
        // state or from the moment the timeout was reset the last time.
        // Value in seconds. This value should be lower than the value
        // of the `movingFundsTimeout`.
        uint32 movingFundsTimeoutResetDelay;
        // Time after which the moving funds process can be reported as
        // timed out. It is counted from the moment when the wallet
        // was requested to move their funds and switched to the MovingFunds
        // state. Value in seconds.
        uint32 movingFundsTimeout;
        // The amount of stake slashed from each member of a wallet for a moving
        // funds timeout.
        uint96 movingFundsTimeoutSlashingAmount;
        // The percentage of the notifier reward from the staking contract
        // the notifier of a moving funds timeout receives. The value is in the
        // range [0, 100].
        uint32 movingFundsTimeoutNotifierRewardMultiplier;
        // The gas offset used for the target wallet commitment transaction cost
        // reimbursement.
        uint16 movingFundsCommitmentGasOffset;
        // Move movedFundsSweepTxMaxTotalFee to the next storage slot for a more
        // efficient variable layout in the storage.
        // slither-disable-next-line unused-state
        bytes32 __movingFundsAlignmentGap;
        // Maximum amount of the total BTC transaction fee that is acceptable in
        // a single moved funds sweep transaction.
        //
        // This is a TOTAL max fee for the moved funds sweep transaction. Note
        // that `depositTxMaxFee` is per single deposit and `redemptionTxMaxFee`
        // is per single redemption. `movedFundsSweepTxMaxTotalFee` is a total
        // fee for the entire transaction.
        uint64 movedFundsSweepTxMaxTotalFee;
        // Time after which the moved funds sweep process can be reported as
        // timed out. It is counted from the moment when the recipient wallet
        // was requested to sweep the received funds. Value in seconds.
        uint32 movedFundsSweepTimeout;
        // The amount of stake slashed from each member of a wallet for a moved
        // funds sweep timeout.
        uint96 movedFundsSweepTimeoutSlashingAmount;
        // The percentage of the notifier reward from the staking contract
        // the notifier of a moved funds sweep timeout receives. The value is
        // in the range [0, 100].
        uint32 movedFundsSweepTimeoutNotifierRewardMultiplier;
        // The minimal amount that can be requested for redemption.
        // Value of this parameter must take into account the value of
        // `redemptionTreasuryFeeDivisor` and `redemptionTxMaxFee`
        // parameters in order to make requests that can incur the
        // treasury and transaction fee and still satisfy the redeemer.
        // Additionally, the value of this parameter must always be greater
        // than `movingFundsDustThreshold` in order to prevent redemption
        // requests with values lower or equal to `movingFundsDustThreshold`.
        uint64 redemptionDustThreshold;
        // Divisor used to compute the treasury fee taken from each
        // redemption request and transferred to the treasury upon
        // successful request finalization. That fee is computed as follows:
        // `treasuryFee = requestedAmount / redemptionTreasuryFeeDivisor`
        // For example, if the treasury fee needs to be 2% of each
        // redemption request, the `redemptionTreasuryFeeDivisor` should
        // be set to `50` because `1/50 = 0.02 = 2%`.
        uint64 redemptionTreasuryFeeDivisor;
        // Maximum amount of BTC transaction fee that can be incurred by
        // each redemption request being part of the given redemption
        // transaction. If the maximum BTC transaction fee is exceeded, such
        // transaction is considered a fraud.
        //
        // This is a per-redemption output max fee for the redemption
        // transaction.
        uint64 redemptionTxMaxFee;
        // Maximum amount of the total BTC transaction fee that is acceptable in
        // a single redemption transaction.
        //
        // This is a TOTAL max fee for the redemption transaction. Note
        // that the `redemptionTxMaxFee` is per single redemption.
        // `redemptionTxMaxTotalFee` is a total fee for the entire transaction.
        uint64 redemptionTxMaxTotalFee;
        // Move redemptionTimeout to the next storage slot for a more efficient
        // variable layout in the storage.
        // slither-disable-next-line unused-state
        bytes32 __redemptionAlignmentGap;
        // Time after which the redemption request can be reported as
        // timed out. It is counted from the moment when the redemption
        // request was created via `requestRedemption` call. Reported
        // timed out requests are cancelled and locked TBTC is returned
        // to the redeemer in full amount. If a redemption watchtower
        // is set, the redemption timeout should be greater than the maximum
        // value of the redemption delay that can be enforced by the watchtower.
        // Consult `IRedemptionWatchtower.getRedemptionDelay` for more details.
        uint32 redemptionTimeout;
        // The amount of stake slashed from each member of a wallet for a
        // redemption timeout.
        uint96 redemptionTimeoutSlashingAmount;
        // The percentage of the notifier reward from the staking contract
        // the notifier of a redemption timeout receives. The value is in the
        // range [0, 100].
        uint32 redemptionTimeoutNotifierRewardMultiplier;
        // The amount of ETH in wei the party challenging the wallet for fraud
        // needs to deposit.
        uint96 fraudChallengeDepositAmount;
        // The amount of time the wallet has to defeat a fraud challenge.
        uint32 fraudChallengeDefeatTimeout;
        // The amount of stake slashed from each member of a wallet for a fraud.
        uint96 fraudSlashingAmount;
        // The percentage of the notifier reward from the staking contract
        // the notifier of a fraud receives. The value is in the range [0, 100].
        uint32 fraudNotifierRewardMultiplier;
        // Determines how frequently a new wallet creation can be requested.
        // Value in seconds.
        uint32 walletCreationPeriod;
        // The minimum BTC threshold in satoshi that is used to decide about
        // wallet creation. Specifically, we allow for the creation of a new
        // wallet if the active wallet is old enough and their amount of BTC
        // is greater than or equal this threshold.
        uint64 walletCreationMinBtcBalance;
        // The maximum BTC threshold in satoshi that is used to decide about
        // wallet creation. Specifically, we allow for the creation of a new
        // wallet if the active wallet's amount of BTC is greater than or equal
        // this threshold, regardless of the active wallet's age.
        uint64 walletCreationMaxBtcBalance;
        // The minimum BTC threshold in satoshi that is used to decide about
        // wallet closing. Specifically, we allow for the closure of the given
        // wallet if their amount of BTC is lesser than this threshold,
        // regardless of the wallet's age.
        uint64 walletClosureMinBtcBalance;
        // The maximum age of a wallet in seconds, after which the wallet
        // moving funds process can be requested.
        uint32 walletMaxAge;
        // 20-byte wallet public key hash being reference to the currently
        // active wallet. Can be unset to the zero value under certain
        // circumstances.
        bytes20 activeWalletPubKeyHash;
        // The current number of wallets in the Live state.
        uint32 liveWalletsCount;
        // The maximum BTC amount in satoshi than can be transferred to a single
        // target wallet during the moving funds process.
        uint64 walletMaxBtcTransfer;
        // Determines the length of the wallet closing period, i.e. the period
        // when the wallet remains in the Closing state and can be subject
        // of deposit fraud challenges. This value is in seconds and should be
        // greater than the deposit refund time plus some time margin.
        uint32 walletClosingPeriod;
        // Collection of all revealed deposits indexed by
        // `keccak256(fundingTxHash | fundingOutputIndex)`.
        // The `fundingTxHash` is `bytes32` (ordered as in Bitcoin internally)
        // and `fundingOutputIndex` an `uint32`. This mapping may contain valid
        // and invalid deposits and the wallet is responsible for validating
        // them before attempting to execute a sweep.
        mapping(uint256 => Deposit.DepositRequest) deposits;
        // Indicates if the vault with the given address is trusted.
        // Depositors can route their revealed deposits only to trusted vaults
        // and have trusted vaults notified about new deposits as soon as these
        // deposits get swept. Vaults not trusted by the Bridge can still be
        // used by Bank balance owners on their own responsibility - anyone can
        // approve their Bank balance to any address.
        mapping(address => bool) isVaultTrusted;
        // Indicates if the address is a trusted SPV maintainer.
        // The SPV proof does not check whether the transaction is a part of the
        // Bitcoin mainnet, it only checks whether the transaction has been
        // mined performing the required amount of work as on Bitcoin mainnet.
        // The possibility of submitting SPV proofs is limited to trusted SPV
        // maintainers. The system expects transaction confirmations with the
        // required work accumulated, so trusted SPV maintainers can not prove
        // the transaction without providing the required Bitcoin proof of work.
        // Trusted maintainers address the issue of an economic game between
        // tBTC and Bitcoin mainnet where large Bitcoin mining pools can decide
        // to use their hash power to mine fake Bitcoin blocks to prove them in
        // tBTC instead of receiving Bitcoin miner rewards.
        mapping(address => bool) isSpvMaintainer;
        // Collection of all moved funds sweep requests indexed by
        // `keccak256(movingFundsTxHash | movingFundsOutputIndex)`.
        // The `movingFundsTxHash` is `bytes32` (ordered as in Bitcoin
        // internally) and `movingFundsOutputIndex` an `uint32`. Each entry
        // is actually an UTXO representing the moved funds and is supposed
        // to be swept with the current main UTXO of the recipient wallet.
        mapping(uint256 => MovingFunds.MovedFundsSweepRequest) movedFundsSweepRequests;
        // Collection of all pending redemption requests indexed by
        // redemption key built as
        // `keccak256(keccak256(redeemerOutputScript) | walletPubKeyHash)`.
        // The `walletPubKeyHash` is the 20-byte wallet's public key hash
        // (computed using Bitcoin HASH160 over the compressed ECDSA
        // public key) and `redeemerOutputScript` is a Bitcoin script
        // (P2PKH, P2WPKH, P2SH or P2WSH) that will be used to lock
        // redeemed BTC as requested by the redeemer. Requests are added
        // to this mapping by the `requestRedemption` method (duplicates
        // not allowed) and are removed by one of the following methods:
        // - `submitRedemptionProof` in case the request was handled
        //    successfully,
        // - `notifyRedemptionTimeout` in case the request was reported
        //    to be timed out.
        mapping(uint256 => Redemption.RedemptionRequest) pendingRedemptions;
        // Collection of all timed out redemptions requests indexed by
        // redemption key built as
        // `keccak256(keccak256(redeemerOutputScript) | walletPubKeyHash)`.
        // The `walletPubKeyHash` is the 20-byte wallet's public key hash
        // (computed using Bitcoin HASH160 over the compressed ECDSA
        // public key) and `redeemerOutputScript` is the Bitcoin script
        // (P2PKH, P2WPKH, P2SH or P2WSH) that is involved in the timed
        // out request.
        // Only one method can add to this mapping:
        // - `notifyRedemptionTimeout` which puts the redemption key to this
        //    mapping based on a timed out request stored previously in
        //    `pendingRedemptions` mapping.
        // Only one method can remove entries from this mapping:
        // - `submitRedemptionProof` in case the timed out redemption request
        //    was a part of the proven transaction.
        mapping(uint256 => Redemption.RedemptionRequest) timedOutRedemptions;
        // Collection of all submitted fraud challenges indexed by challenge
        // key built as `keccak256(walletPublicKey|sighash)`.
        mapping(uint256 => Fraud.FraudChallenge) fraudChallenges;
        // Collection of main UTXOs that are honestly spent indexed by
        // `keccak256(fundingTxHash | fundingOutputIndex)`. The `fundingTxHash`
        // is `bytes32` (ordered as in Bitcoin internally) and
        // `fundingOutputIndex` an `uint32`. A main UTXO is considered honestly
        // spent if it was used as an input of a transaction that have been
        // proven in the Bridge.
        mapping(uint256 => bool) spentMainUTXOs;
        // Maps the 20-byte wallet public key hash (computed using Bitcoin
        // HASH160 over the compressed ECDSA public key) to the basic wallet
        // information like state and pending redemptions value.
        mapping(bytes20 => Wallets.Wallet) registeredWallets;
        // Address of the redemption watchtower. The redemption watchtower
        // is responsible for vetoing redemption requests.
        address redemptionWatchtower;
        // Address of the rebate staking contract used by the rebate mechanism.
        // This value is intended to be initialized exactly once via
        // governance wiring; changing it afterwards requires a dedicated
        // upgrade path of the Bridge implementation.
        address rebateStaking;
        // Upgrade note: the FROST wallet ID fields below and the FROST
        // wallet registry address consume three reserved slots, reducing
        // `__gap` from 50 to 47 for storage-layout compatibility.
        // Maps canonical wallet identifier to the wallet public key hash used
        // by legacy Bridge paths. For legacy ECDSA wallets, canonical wallet
        // ID is a left-padded 20-byte wallet public key hash. New wallet
        // generations can use a different canonical ID and still map to the
        // compatibility key expected by old interfaces.
        mapping(bytes32 => bytes20) walletPubKeyHashByWalletID;
        // Canonical identifier of the currently active wallet.
        // Legacy wallets use a left-padded 20-byte wallet public key hash,
        // while future wallet generations can store native 32-byte IDs.
        bytes32 activeWalletID;
        // Address of the FROST wallet registry. When non-zero, the registry
        // contract is the only caller authorized to invoke the Bridge's
        // FROST wallet registration entry point. The registry is intended
        // to be the on-chain receiver of the keep-core FROST DKG result;
        // it is set exactly once via governance and remains zero until the
        // FROST DKG coordinator and any required lifecycle-routing
        // follow-up work are deployed.
        address frostWalletRegistry;
        // Address of the EcdsaFraudRouter sidecar. The router holds
        // the new authoritative fraudChallenges mapping and the ETH
        // escrow for every fraud challenge opened after the
        // extraction cutover. Set exactly once via governance.
        // After cutover, Bridge no longer exposes fraud entry points;
        // consumers (watchtowers, indexers, MaintainerProxy, etc.)
        // must call the router directly. While zero, the legacy
        // fraud surface on Bridge is removed but the cutover is not
        // yet active.
        //
        // The legacy `fraudChallenges` mapping above remains in
        // storage so that the one-time
        // Bridge.migrateLegacyFraudChallenges helper (routerKind 0
        // for ECDSA, 1 for P2TR) can read and mark legacy entries
        // during the cutover. It is removed in a follow-up storage
        // cleanup once all legacy entries are migrated or aged out.
        address ecdsaFraudRouter;
        // Address of the P2TR signature-fraud sidecar router. Set
        // exactly once via governance (setP2TRFraudRouter). Sister
        // contract to ecdsaFraudRouter for the P2TR signature fraud
        // lifecycle; see EcdsaFraudRouter / P2TRSignatureFraudRouter.
        address p2trFraudRouter;
        // Address of the BridgeLifecycleRouter. The router is the
        // authorized dispatcher for FROST-scheme wallet lifecycle
        // operations (closeWallet, seize, isWalletMember). It reads
        // wallet state from this Bridge and forwards to the configured
        // frostWalletRegistry. ECDSA lifecycle operations are NOT
        // routed through it -- they continue to call
        // ecdsaWalletRegistry directly, preserving the current
        // ownership/callback model unchanged. Set exactly once via
        // governance; FROST wallet registration is gated on this
        // being non-zero (see registerNewFrostWallet) so a FROST
        // wallet cannot enter Live state without a configured
        // lifecycle router.
        address lifecycleRouter;
        // Reverse mapping for canonical wallet ID lookup. For ECDSA
        // wallets the walletID can be derived on-chain from the
        // public key hash via Wallets.deriveLegacyWalletID, so no
        // storage is needed. For FROST wallets the walletID
        // (xOnlyOutputKey) is NOT derivable from the legacy public
        // key hash alias (HASH160(0x02 || xOnlyKey) is one-way); we
        // store it explicitly at FROST wallet registration time so
        // the lifecycle router can recover it during dispatch
        // without an O(N) scan of walletPubKeyHashByWalletID.
        // Populated only for FROST wallets; bytes32(0) for any
        // wallet pubKeyHash that does not have a FROST registration
        // entry.
        mapping(bytes20 => bytes32) walletIDByWalletPubKeyHash;
        // Currently selected wallet scheme for `requestNewWallet`.
        // Governance flips via `setNewWalletScheme`. Defaults to
        // `Ecdsa` on C-2 activation (preserves prior behavior;
        // FROST opt-in must be explicit). Sits at slot 38 offset
        // 0 (the preceding field is a mapping, which always
        // occupies a full slot).
        WalletScheme currentNewWalletScheme;
        // Total ECDSA wallets ever registered on this Bridge,
        // counted from the C-2.1 activation block forward.
        // Used by D-2's `finalizeEcdsaRetirement` to verify the
        // governance-supplied retired-wallet list against the
        // post-activation counter (pre-activation wallets are
        // handled via off-chain governance attestation; the
        // historical-count `seedEcdsaWalletCount` setter
        // originally specified in RFC v6 is deferred — see
        // §"Deferred from C-2.1" in the migration plan doc).
        // Strictly monotonic: incremented in
        // `Wallets.registerNewWallet`; NEVER decremented.
        //
        // Packs into the SAME slot as `currentNewWalletScheme`
        // above (slot 38): solc places `uint128` (16B) at offset
        // 1, right after the 1-byte enum. Total slot 38 usage:
        // 17 bytes of 32. No __gap change from C-2.
        uint128 ecdsaWalletCount;
        // D-1 soft-retirement flag. Set by the one-time
        // governance setter `Bridge.retireEcdsa()` (the setter
        // itself is deferred to D-2 — see Bridge.sol). When
        // true, `Wallets.requestNewWallet` rejects new requests
        // routed to the ECDSA registry. Late callbacks from an
        // in-flight DKG that started BEFORE retirement are NOT
        // blocked: reverting `Wallets.registerNewWallet` would
        // strand the ECDSA registry in a non-IDLE state and
        // freeze every subsequent FROST wallet creation via
        // the unconditional IDLE precheck in `requestNewWallet`
        // (per PR #443 review). Governance therefore
        // enforces the "no late ECDSA wallets" invariant
        // operationally: pause Bridge, wait for in-flight DKGs
        // to settle (registry returns to IDLE), set the flag,
        // unpause. Existing ECDSA wallets' lifecycle paths
        // (sweeps, redemptions, fraud, moving funds, closing,
        // termination) remain fully functional — D-1 only
        // closes the *new wallet creation* boundary; D-2
        // performs the final structural removal.
        //
        // Packs at slot 38 offset 17 (just after
        // `ecdsaWalletCount`, which occupies bytes 1-16). Total
        // slot 38 usage: 18 bytes of 32. No __gap change from
        // C-2 / C-2.1.
        bool ecdsaRetired;
        // Reserved storage space in case we need to add more variables.
        // The convention from OpenZeppelin suggests the storage space should
        // add up to 50 slots. Here we want to have more slots as there are
        // planned upgrades of the Bridge contract. If more entires are added to
        // the struct in the upcoming versions we need to reduce the array size.
        // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
        // slither-disable-next-line unused-state
        uint256[40] __gap;
    }

    event DepositParametersUpdated(
        uint64 depositDustThreshold,
        uint64 depositTreasuryFeeDivisor,
        uint64 depositTxMaxFee,
        uint32 depositRevealAheadPeriod
    );

    event RedemptionParametersUpdated(
        uint64 redemptionDustThreshold,
        uint64 redemptionTreasuryFeeDivisor,
        uint64 redemptionTxMaxFee,
        uint64 redemptionTxMaxTotalFee,
        uint32 redemptionTimeout,
        uint96 redemptionTimeoutSlashingAmount,
        uint32 redemptionTimeoutNotifierRewardMultiplier
    );

    event MovingFundsParametersUpdated(
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
    );

    event WalletParametersUpdated(
        uint32 walletCreationPeriod,
        uint64 walletCreationMinBtcBalance,
        uint64 walletCreationMaxBtcBalance,
        uint64 walletClosureMinBtcBalance,
        uint32 walletMaxAge,
        uint64 walletMaxBtcTransfer,
        uint32 walletClosingPeriod
    );

    event FraudParametersUpdated(
        uint96 fraudChallengeDepositAmount,
        uint32 fraudChallengeDefeatTimeout,
        uint96 fraudSlashingAmount,
        uint32 fraudNotifierRewardMultiplier
    );

    event TreasuryUpdated(address treasury);

    event RedemptionWatchtowerSet(address redemptionWatchtower);

    // Event emitted when the FROST wallet registry address is initialized
    // through governance. Declared here so it can be emitted from
    // `setFrostWalletRegistry` below, alongside the matching event for the
    // redemption watchtower. Bridge.sol mirrors this declaration so the
    // event appears in the Bridge contract ABI (consumer indexers and
    // tests resolve event types from the Bridge artifact, not the
    // BridgeState library artifact).
    event FrostWalletRegistrySet(address frostWalletRegistry);

    // Mirror of the ECDSA fraud router setter event; Bridge.sol re-
    // declares this so the event appears in the Bridge contract ABI.
    event EcdsaFraudRouterSet(address ecdsaFraudRouter);

    // Mirror of the P2TR fraud router setter event; Bridge.sol re-
    // declares this so the event appears in the Bridge contract ABI.
    event P2TRFraudRouterSet(address p2trFraudRouter);

    // Mirror of the lifecycle router setter event; Bridge.sol re-
    // declares this so the event appears in the Bridge contract ABI.
    event LifecycleRouterSet(address lifecycleRouter);

    // Declared for ABI back-compat. D-2.2 slice 3 removed the
    // `setNewWalletScheme` setter so this event never fires;
    // the declaration stays in the Bridge ABI so any out-of-tree
    // tooling that registered for the topic doesn't see a
    // missing entry. Same pattern D-2.2 slice 1 used for
    // `EcdsaRetired`.
    event NewWalletSchemeSet(WalletScheme indexed scheme);

    // Declared for ABI back-compat. D-2.1 added the event
    // mirror + emitted it from `Bridge.retireEcdsa()` because
    // there was no on-chain getter for the flag — off-chain
    // consumers had no other observation path. D-2.2 added the
    // public `ecdsaRetired()` getter on Bridge and dropped the
    // emit (the two together exceeded the EIP-170 budget);
    // off-chain consumers now poll the getter, and the
    // governance transaction itself is the canonical
    // audit-trail record (block + tx + sender). The event
    // declaration stays so any out-of-tree tooling that
    // registered for the event-topic doesn't see a missing
    // ABI entry — it just never fires.
    event EcdsaRetired();

    // Custom errors for the FROST wallet registry setter. Used instead of
    // require strings to keep the Bridge implementation bytecode under the
    // 24 KiB EIP-170 deploy limit.
    error FrostWalletRegistryAlreadySet();
    error FrostWalletRegistryAddressZero();

    // Custom errors for the ECDSA fraud router setter; same rationale.
    error EcdsaFraudRouterAlreadySet();
    error EcdsaFraudRouterAddressZero();

    // Custom errors for the P2TR fraud router setter; same rationale.
    error P2TRFraudRouterAlreadySet();
    error P2TRFraudRouterAddressZero();

    // Custom errors for the lifecycle router setter; same rationale.
    error LifecycleRouterAlreadySet();
    error LifecycleRouterAddressZero();

    // Event emitted when the rebate staking address is initialized. Declared
    // in this library as the event is emitted from within `BridgeState` and
    // used by the Bridge contract following the same pattern as other
    // parameter events.
    event RebateStakingSet(address rebateStaking);

    /// @notice Updates parameters of deposits.
    /// @param _depositDustThreshold New value of the deposit dust threshold in
    ///        satoshis. It is the minimal amount that can be requested to
    ////       deposit. Value of this parameter must take into account the value
    ///        of `depositTreasuryFeeDivisor` and `depositTxMaxFee` parameters
    ///        in order to make requests that can incur the treasury and
    ///        transaction fee and still satisfy the depositor.
    /// @param _depositTreasuryFeeDivisor New value of the treasury fee divisor.
    ///        It is the divisor used to compute the treasury fee taken from
    ///        each deposit and transferred to the treasury upon sweep proof
    ///        submission. That fee is computed as follows:
    ///        `treasuryFee = depositedAmount / depositTreasuryFeeDivisor`
    ///        For example, if the treasury fee needs to be 2% of each deposit,
    ///        the `depositTreasuryFeeDivisor` should be set to `50`
    ///        because `1/50 = 0.02 = 2%`.
    /// @param _depositTxMaxFee New value of the deposit tx max fee in satoshis.
    ///        It is the maximum amount of BTC transaction fee that can
    ///        be incurred by each swept deposit being part of the given sweep
    ///        transaction. If the maximum BTC transaction fee is exceeded,
    ///        such transaction is considered a fraud.
    /// @param _depositRevealAheadPeriod New value of the deposit reveal ahead
    ///        period parameter in seconds. It defines the length of the period
    ///        that must be preserved between the deposit reveal time and the
    ///        deposit refund locktime.
    /// @dev Requirements:
    ///      - Deposit dust threshold must be greater than zero,
    ///      - Deposit dust threshold must be greater than deposit TX max fee,
    ///      - Deposit transaction max fee must be greater than zero.
    function updateDepositParameters(
        Storage storage self,
        uint64 _depositDustThreshold,
        uint64 _depositTreasuryFeeDivisor,
        uint64 _depositTxMaxFee,
        uint32 _depositRevealAheadPeriod
    ) internal {
        require(
            _depositDustThreshold > 0,
            "Deposit dust threshold must be greater than zero"
        );

        require(
            _depositDustThreshold > _depositTxMaxFee,
            "Deposit dust threshold must be greater than deposit TX max fee"
        );

        require(
            _depositTxMaxFee > 0,
            "Deposit transaction max fee must be greater than zero"
        );

        self.depositDustThreshold = _depositDustThreshold;
        self.depositTreasuryFeeDivisor = _depositTreasuryFeeDivisor;
        self.depositTxMaxFee = _depositTxMaxFee;
        self.depositRevealAheadPeriod = _depositRevealAheadPeriod;

        emit DepositParametersUpdated(
            _depositDustThreshold,
            _depositTreasuryFeeDivisor,
            _depositTxMaxFee,
            _depositRevealAheadPeriod
        );
    }

    /// @notice Updates parameters of redemptions.
    /// @param _redemptionDustThreshold New value of the redemption dust
    ///        threshold in satoshis. It is the minimal amount that can be
    ///        requested for redemption. Value of this parameter must take into
    ///        account the value of `redemptionTreasuryFeeDivisor` and
    ///        `redemptionTxMaxFee` parameters in order to make requests that
    ///        can incur the treasury and transaction fee and still satisfy the
    ///        redeemer.
    /// @param _redemptionTreasuryFeeDivisor New value of the redemption
    ///        treasury fee divisor. It is the divisor used to compute the
    ///        treasury fee taken from each redemption request and transferred
    ///        to the treasury upon successful request finalization. That fee is
    ///        computed as follows:
    ///        `treasuryFee = requestedAmount / redemptionTreasuryFeeDivisor`
    ///        For example, if the treasury fee needs to be 2% of each
    ///        redemption request, the `redemptionTreasuryFeeDivisor` should
    ///        be set to `50` because `1/50 = 0.02 = 2%`.
    /// @param _redemptionTxMaxFee New value of the redemption transaction max
    ///        fee in satoshis. It is the maximum amount of BTC transaction fee
    ///        that can be incurred by each redemption request being part of the
    ///        given redemption transaction. If the maximum BTC transaction fee
    ///        is exceeded, such transaction is considered a fraud.
    ///        This is a per-redemption output max fee for the redemption
    ///        transaction.
    /// @param _redemptionTxMaxTotalFee New value of the redemption transaction
    ///        max total fee in satoshis. It is the maximum amount of the total
    ///        BTC transaction fee that is acceptable in a single redemption
    ///        transaction. This is a _total_ max fee for the entire redemption
    ///        transaction.
    /// @param _redemptionTimeout New value of the redemption timeout in seconds.
    ///        It is the time after which the redemption request can be reported
    ///        as timed out. It is counted from the moment when the redemption
    ///        request was created via `requestRedemption` call. Reported  timed
    ///        out requests are cancelled and locked TBTC is returned to the
    ///        redeemer in full amount.
    /// @param _redemptionTimeoutSlashingAmount New value of the redemption
    ///        timeout slashing amount in T, it is the amount slashed from each
    ///        wallet member for redemption timeout.
    /// @param _redemptionTimeoutNotifierRewardMultiplier New value of the
    ///        redemption timeout notifier reward multiplier as percentage,
    ///        it determines the percentage of the notifier reward from the
    ///        staking contact the notifier of a redemption timeout receives.
    ///        The value must be in the range [0, 100].
    /// @dev Requirements:
    ///      - Redemption dust threshold must be greater than moving funds dust
    ///        threshold,
    ///      - Redemption dust threshold must be greater than the redemption TX
    ///        max fee,
    ///      - Redemption transaction max fee must be greater than zero,
    ///      - Redemption transaction max total fee must be greater than or
    ///        equal to the redemption transaction per-request max fee,
    ///      - Redemption timeout must be greater than zero,
    ///      - Redemption timeout notifier reward multiplier must be in the
    ///        range [0, 100].
    function updateRedemptionParameters(
        Storage storage self,
        uint64 _redemptionDustThreshold,
        uint64 _redemptionTreasuryFeeDivisor,
        uint64 _redemptionTxMaxFee,
        uint64 _redemptionTxMaxTotalFee,
        uint32 _redemptionTimeout,
        uint96 _redemptionTimeoutSlashingAmount,
        uint32 _redemptionTimeoutNotifierRewardMultiplier
    ) internal {
        require(
            _redemptionDustThreshold > self.movingFundsDustThreshold,
            "Redemption dust threshold must be greater than moving funds dust threshold"
        );

        require(
            _redemptionDustThreshold > _redemptionTxMaxFee,
            "Redemption dust threshold must be greater than redemption TX max fee"
        );

        require(
            _redemptionTxMaxFee > 0,
            "Redemption transaction max fee must be greater than zero"
        );

        require(
            _redemptionTxMaxTotalFee >= _redemptionTxMaxFee,
            "Redemption transaction max total fee must be greater than or equal to the redemption transaction per-request max fee"
        );

        require(
            _redemptionTimeout > 0,
            "Redemption timeout must be greater than zero"
        );

        require(
            _redemptionTimeoutNotifierRewardMultiplier <= 100,
            "Redemption timeout notifier reward multiplier must be in the range [0, 100]"
        );

        self.redemptionDustThreshold = _redemptionDustThreshold;
        self.redemptionTreasuryFeeDivisor = _redemptionTreasuryFeeDivisor;
        self.redemptionTxMaxFee = _redemptionTxMaxFee;
        self.redemptionTxMaxTotalFee = _redemptionTxMaxTotalFee;
        self.redemptionTimeout = _redemptionTimeout;
        self.redemptionTimeoutSlashingAmount = _redemptionTimeoutSlashingAmount;
        self
            .redemptionTimeoutNotifierRewardMultiplier = _redemptionTimeoutNotifierRewardMultiplier;

        emit RedemptionParametersUpdated(
            _redemptionDustThreshold,
            _redemptionTreasuryFeeDivisor,
            _redemptionTxMaxFee,
            _redemptionTxMaxTotalFee,
            _redemptionTimeout,
            _redemptionTimeoutSlashingAmount,
            _redemptionTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Updates parameters of moving funds.
    /// @param _movingFundsTxMaxTotalFee New value of the moving funds transaction
    ///        max total fee in satoshis. It is the maximum amount of the total
    ///        BTC transaction fee that is acceptable in a single moving funds
    ///        transaction. This is a _total_ max fee for the entire moving
    ///        funds transaction.
    /// @param _movingFundsDustThreshold New value of the moving funds dust
    ///        threshold. It is the minimal satoshi amount that makes sense to
    ///        be transferred during the moving funds process. Moving funds
    ///        wallets having their BTC balance below that value can begin
    ///        closing immediately as transferring such a low value may not be
    ///        possible due to BTC network fees.
    /// @param _movingFundsTimeoutResetDelay New value of the moving funds
    ///        timeout reset delay in seconds. It is the time after which the
    ///        moving funds timeout can be reset in case the target wallet
    ///        commitment cannot be submitted due to a lack of live wallets
    ///        in the system. It is counted from the moment when the wallet
    ///        was requested to move their funds and switched to the MovingFunds
    ///        state or from the moment the timeout was reset the last time.
    /// @param _movingFundsTimeout New value of the moving funds timeout in
    ///        seconds. It is the time after which the moving funds process can
    ///        be reported as timed out. It is counted from the moment when the
    ///        wallet was requested to move their funds and switched to the
    ///        MovingFunds state.
    /// @param _movingFundsTimeoutSlashingAmount New value of the moving funds
    ///        timeout slashing amount in T, it is the amount slashed from each
    ///        wallet member for moving funds timeout.
    /// @param _movingFundsTimeoutNotifierRewardMultiplier New value of the
    ///        moving funds timeout notifier reward multiplier as percentage,
    ///        it determines the percentage of the notifier reward from the
    ///        staking contact the notifier of a moving funds timeout receives.
    ///        The value must be in the range [0, 100].
    /// @param _movingFundsCommitmentGasOffset New value of the gas offset for
    ///        moving funds target wallet commitment transaction gas costs
    ///        reimbursement.
    /// @param _movedFundsSweepTxMaxTotalFee New value of the moved funds sweep
    ///        transaction max total fee in satoshis. It is the maximum amount
    ///        of the total BTC transaction fee that is acceptable in a single
    ///        moved funds sweep transaction. This is a _total_ max fee for the
    ///        entire moved funds sweep transaction.
    /// @param _movedFundsSweepTimeout New value of the moved funds sweep
    ///        timeout in seconds. It is the time after which the moved funds
    ///        sweep process can be reported as timed out. It is counted from
    ///        the moment when the wallet was requested to sweep the received
    ///        funds.
    /// @param _movedFundsSweepTimeoutSlashingAmount New value of the moved
    ///        funds sweep timeout slashing amount in T, it is the amount
    ///        slashed from each wallet member for moved funds sweep timeout.
    /// @param _movedFundsSweepTimeoutNotifierRewardMultiplier New value of
    ///        the moved funds sweep timeout notifier reward multiplier as
    ///        percentage, it determines the percentage of the notifier reward
    ///        from the staking contact the notifier of a moved funds sweep
    ///        timeout receives. The value must be in the range [0, 100].
    /// @dev Requirements:
    ///      - Moving funds transaction max total fee must be greater than zero,
    ///      - Moving funds dust threshold must be greater than zero and lower
    ///        than the redemption dust threshold,
    ///      - Moving funds timeout reset delay must be greater than zero,
    ///      - Moving funds timeout must be greater than the moving funds
    ///        timeout reset delay,
    ///      - Moving funds timeout slashing amount must be greater than zero,
    ///      - Moving funds timeout notifier reward multiplier must be in the
    ///        range [0, 100],
    ///      - Moved funds sweep transaction max total fee must be greater than zero,
    ///      - Moved funds sweep timeout must be greater than zero,
    ///      - Moved funds sweep timeout notifier reward multiplier must be in the
    ///        range [0, 100].
    function updateMovingFundsParameters(
        Storage storage self,
        uint64 _movingFundsTxMaxTotalFee,
        uint64 _movingFundsDustThreshold,
        uint32 _movingFundsTimeoutResetDelay,
        uint32 _movingFundsTimeout,
        uint96 _movingFundsTimeoutSlashingAmount,
        uint32 _movingFundsTimeoutNotifierRewardMultiplier,
        uint16 _movingFundsCommitmentGasOffset,
        uint64 _movedFundsSweepTxMaxTotalFee,
        uint32 _movedFundsSweepTimeout,
        uint96 _movedFundsSweepTimeoutSlashingAmount,
        uint32 _movedFundsSweepTimeoutNotifierRewardMultiplier
    ) internal {
        require(
            _movingFundsTxMaxTotalFee > 0,
            "Moving funds transaction max total fee must be greater than zero"
        );

        require(
            _movingFundsDustThreshold > 0 &&
                _movingFundsDustThreshold < self.redemptionDustThreshold,
            "Moving funds dust threshold must be greater than zero and lower than redemption dust threshold"
        );

        require(
            _movingFundsTimeoutResetDelay > 0,
            "Moving funds timeout reset delay must be greater than zero"
        );

        require(
            _movingFundsTimeout > _movingFundsTimeoutResetDelay,
            "Moving funds timeout must be greater than its reset delay"
        );

        require(
            _movingFundsTimeoutSlashingAmount > 0,
            "Moving funds timeout slashing amount must be greater than zero"
        );

        require(
            _movingFundsTimeoutNotifierRewardMultiplier <= 100,
            "Moving funds timeout notifier reward multiplier must be in the range [0, 100]"
        );

        require(
            _movedFundsSweepTxMaxTotalFee > 0,
            "Moved funds sweep transaction max total fee must be greater than zero"
        );

        require(
            _movedFundsSweepTimeout > 0,
            "Moved funds sweep timeout must be greater than zero"
        );

        require(
            _movedFundsSweepTimeoutNotifierRewardMultiplier <= 100,
            "Moved funds sweep timeout notifier reward multiplier must be in the range [0, 100]"
        );

        self.movingFundsTxMaxTotalFee = _movingFundsTxMaxTotalFee;
        self.movingFundsDustThreshold = _movingFundsDustThreshold;
        self.movingFundsTimeoutResetDelay = _movingFundsTimeoutResetDelay;
        self.movingFundsTimeout = _movingFundsTimeout;
        self
            .movingFundsTimeoutSlashingAmount = _movingFundsTimeoutSlashingAmount;
        self
            .movingFundsTimeoutNotifierRewardMultiplier = _movingFundsTimeoutNotifierRewardMultiplier;
        self.movingFundsCommitmentGasOffset = _movingFundsCommitmentGasOffset;
        self.movedFundsSweepTxMaxTotalFee = _movedFundsSweepTxMaxTotalFee;
        self.movedFundsSweepTimeout = _movedFundsSweepTimeout;
        self
            .movedFundsSweepTimeoutSlashingAmount = _movedFundsSweepTimeoutSlashingAmount;
        self
            .movedFundsSweepTimeoutNotifierRewardMultiplier = _movedFundsSweepTimeoutNotifierRewardMultiplier;

        emit MovingFundsParametersUpdated(
            _movingFundsTxMaxTotalFee,
            _movingFundsDustThreshold,
            _movingFundsTimeoutResetDelay,
            _movingFundsTimeout,
            _movingFundsTimeoutSlashingAmount,
            _movingFundsTimeoutNotifierRewardMultiplier,
            _movingFundsCommitmentGasOffset,
            _movedFundsSweepTxMaxTotalFee,
            _movedFundsSweepTimeout,
            _movedFundsSweepTimeoutSlashingAmount,
            _movedFundsSweepTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Updates parameters of wallets.
    /// @param _walletCreationPeriod New value of the wallet creation period in
    ///        seconds, determines how frequently a new wallet creation can be
    ///        requested.
    /// @param _walletCreationMinBtcBalance New value of the wallet minimum BTC
    ///        balance in satoshi, used to decide about wallet creation.
    /// @param _walletCreationMaxBtcBalance New value of the wallet maximum BTC
    ///        balance in satoshi, used to decide about wallet creation.
    /// @param _walletClosureMinBtcBalance New value of the wallet minimum BTC
    ///        balance in satoshi, used to decide about wallet closure.
    /// @param _walletMaxAge New value of the wallet maximum age in seconds,
    ///        indicates the maximum age of a wallet in seconds, after which
    ///        the wallet moving funds process can be requested.
    /// @param _walletMaxBtcTransfer New value of the wallet maximum BTC transfer
    ///        in satoshi, determines the maximum amount that can be transferred
    ///        to a single target wallet during the moving funds process.
    /// @param _walletClosingPeriod New value of the wallet closing period in
    ///        seconds, determines the length of the wallet closing period,
    //         i.e. the period when the wallet remains in the Closing state
    //         and can be subject of deposit fraud challenges.
    /// @dev Requirements:
    ///      - Wallet creation period must be greater than zero,
    ///      - Wallet maximum age must be greater than zero,
    ///      - Wallet maximum BTC balance must be greater than the wallet
    ///        minimum BTC balance,
    ///      - Wallet maximum BTC transfer must be greater than zero,
    ///      - Wallet closing period must be greater than zero.
    function updateWalletParameters(
        Storage storage self,
        uint32 _walletCreationPeriod,
        uint64 _walletCreationMinBtcBalance,
        uint64 _walletCreationMaxBtcBalance,
        uint64 _walletClosureMinBtcBalance,
        uint32 _walletMaxAge,
        uint64 _walletMaxBtcTransfer,
        uint32 _walletClosingPeriod
    ) internal {
        require(
            _walletCreationPeriod > 0,
            "Wallet creation period must be greater than zero"
        );
        require(
            _walletMaxAge > 0,
            "Wallet maximum age must be greater than zero"
        );
        require(
            _walletCreationMaxBtcBalance > _walletCreationMinBtcBalance,
            "Wallet creation maximum BTC balance must be greater than the creation minimum BTC balance"
        );
        require(
            _walletMaxBtcTransfer > 0,
            "Wallet maximum BTC transfer must be greater than zero"
        );
        require(
            _walletClosingPeriod > 0,
            "Wallet closing period must be greater than zero"
        );

        self.walletCreationPeriod = _walletCreationPeriod;
        self.walletCreationMinBtcBalance = _walletCreationMinBtcBalance;
        self.walletCreationMaxBtcBalance = _walletCreationMaxBtcBalance;
        self.walletClosureMinBtcBalance = _walletClosureMinBtcBalance;
        self.walletMaxAge = _walletMaxAge;
        self.walletMaxBtcTransfer = _walletMaxBtcTransfer;
        self.walletClosingPeriod = _walletClosingPeriod;

        emit WalletParametersUpdated(
            _walletCreationPeriod,
            _walletCreationMinBtcBalance,
            _walletCreationMaxBtcBalance,
            _walletClosureMinBtcBalance,
            _walletMaxAge,
            _walletMaxBtcTransfer,
            _walletClosingPeriod
        );
    }

    /// @notice Updates parameters related to frauds.
    /// @param _fraudChallengeDepositAmount New value of the fraud challenge
    ///        deposit amount in wei, it is the amount of ETH the party
    ///        challenging the wallet for fraud needs to deposit.
    /// @param _fraudChallengeDefeatTimeout New value of the challenge defeat
    ///        timeout in seconds, it is the amount of time the wallet has to
    ///        defeat a fraud challenge. The value must be greater than zero.
    /// @param _fraudSlashingAmount New value of the fraud slashing amount in T,
    ///        it is the amount slashed from each wallet member for committing
    ///        a fraud.
    /// @param _fraudNotifierRewardMultiplier New value of the fraud notifier
    ///        reward multiplier as percentage, it determines the percentage of
    ///        the notifier reward from the staking contact the notifier of
    ///        a fraud receives. The value must be in the range [0, 100].
    /// @dev Requirements:
    ///      - Fraud challenge deposit amount must be greater than zero,
    ///      - Fraud challenge defeat timeout must be greater than 0,
    ///      - Fraud notifier reward multiplier must be in the range [0, 100].
    ///      Note: `_fraudSlashingAmount` is intentionally unbounded on the
    ///      low end; the `DisableFraudChallenges` deploy flow relies on
    ///      setting it to zero to signal that fraud challenges are
    ///      disabled.
    function updateFraudParameters(
        Storage storage self,
        uint96 _fraudChallengeDepositAmount,
        uint32 _fraudChallengeDefeatTimeout,
        uint96 _fraudSlashingAmount,
        uint32 _fraudNotifierRewardMultiplier
    ) internal {
        require(
            _fraudChallengeDepositAmount > 0,
            "Fraud challenge deposit amount must be greater than zero"
        );

        require(
            _fraudChallengeDefeatTimeout > 0,
            "Fraud challenge defeat timeout must be greater than zero"
        );

        require(
            _fraudNotifierRewardMultiplier <= 100,
            "Fraud notifier reward multiplier must be in the range [0, 100]"
        );

        self.fraudChallengeDepositAmount = _fraudChallengeDepositAmount;
        self.fraudChallengeDefeatTimeout = _fraudChallengeDefeatTimeout;
        self.fraudSlashingAmount = _fraudSlashingAmount;
        self.fraudNotifierRewardMultiplier = _fraudNotifierRewardMultiplier;

        emit FraudParametersUpdated(
            _fraudChallengeDepositAmount,
            _fraudChallengeDefeatTimeout,
            _fraudSlashingAmount,
            _fraudNotifierRewardMultiplier
        );
    }

    /// @notice Updates treasury address. The treasury receives the system fees.
    /// @param _treasury New value of the treasury address.
    /// @dev The treasury address must not be 0x0.
    function updateTreasury(Storage storage self, address _treasury) internal {
        require(_treasury != address(0), "Treasury address must not be 0x0");

        self.treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    /// @notice Sets the redemption watchtower address.
    /// @param _redemptionWatchtower Address of the redemption watchtower.
    /// @dev Requirements:
    ///      - Redemption watchtower address must not be already set,
    ///      - Redemption watchtower address must not be 0x0.
    function setRedemptionWatchtower(
        Storage storage self,
        address _redemptionWatchtower
    ) internal {
        require(
            self.redemptionWatchtower == address(0),
            "Redemption watchtower already set"
        );

        require(
            _redemptionWatchtower != address(0),
            "Redemption watchtower address must not be 0x0"
        );

        self.redemptionWatchtower = _redemptionWatchtower;
        emit RedemptionWatchtowerSet(_redemptionWatchtower);
    }

    /// @notice Sets the FROST wallet registry address.
    /// @param _frostWalletRegistry Address of the FROST wallet registry.
    /// @dev One-time setter, matching the redemption watchtower pattern.
    ///      Once set, the registry address cannot be changed without a
    ///      Bridge implementation upgrade. Requirements:
    ///      - FROST wallet registry address must not be already set,
    ///      - FROST wallet registry address must not be 0x0.
    function setFrostWalletRegistry(
        Storage storage self,
        address _frostWalletRegistry
    ) internal {
        if (self.frostWalletRegistry != address(0)) {
            revert FrostWalletRegistryAlreadySet();
        }
        if (_frostWalletRegistry == address(0)) {
            revert FrostWalletRegistryAddressZero();
        }

        self.frostWalletRegistry = _frostWalletRegistry;
        emit FrostWalletRegistrySet(_frostWalletRegistry);
    }

    /// @notice Sets the EcdsaFraudRouter address.
    /// @param _ecdsaFraudRouter Address of the EcdsaFraudRouter sidecar.
    /// @dev One-time setter. Once set, the router address cannot be
    ///      changed without a Bridge implementation upgrade.
    ///      Requirements:
    ///      - ECDSA fraud router address must not be already set,
    ///      - ECDSA fraud router address must not be 0x0.
    function setEcdsaFraudRouter(
        Storage storage self,
        address _ecdsaFraudRouter
    ) internal {
        if (self.ecdsaFraudRouter != address(0)) {
            revert EcdsaFraudRouterAlreadySet();
        }
        if (_ecdsaFraudRouter == address(0)) {
            revert EcdsaFraudRouterAddressZero();
        }

        self.ecdsaFraudRouter = _ecdsaFraudRouter;
        emit EcdsaFraudRouterSet(_ecdsaFraudRouter);
    }

    /// @notice Sets the P2TR fraud router address.
    /// @param _p2trFraudRouter Address of the P2TR fraud router sidecar.
    /// @dev One-time setter; same pattern as setEcdsaFraudRouter.
    ///      Requirements:
    ///      - P2TR fraud router address must not be already set,
    ///      - P2TR fraud router address must not be 0x0.
    function setP2TRFraudRouter(Storage storage self, address _p2trFraudRouter)
        internal
    {
        if (self.p2trFraudRouter != address(0)) {
            revert P2TRFraudRouterAlreadySet();
        }
        if (_p2trFraudRouter == address(0)) {
            revert P2TRFraudRouterAddressZero();
        }

        self.p2trFraudRouter = _p2trFraudRouter;
        emit P2TRFraudRouterSet(_p2trFraudRouter);
    }

    /// @notice Sets the lifecycle router address.
    /// @param _lifecycleRouter Address of the BridgeLifecycleRouter.
    /// @dev One-time setter, matching the FROST wallet registry pattern.
    ///      Once set, the router address cannot be changed without a
    ///      Bridge implementation upgrade. Requirements:
    ///      - Lifecycle router address must not be already set,
    ///      - Lifecycle router address must not be 0x0.
    function setLifecycleRouter(Storage storage self, address _lifecycleRouter)
        internal
    {
        if (self.lifecycleRouter != address(0)) {
            revert LifecycleRouterAlreadySet();
        }
        if (_lifecycleRouter == address(0)) {
            revert LifecycleRouterAddressZero();
        }

        self.lifecycleRouter = _lifecycleRouter;
        emit LifecycleRouterSet(_lifecycleRouter);
    }

    // D-2.2 slice 3: `setNewWalletScheme` internal library
    // function removed. Pre-slice-3 it wrote the new scheme +
    // emitted `NewWalletSchemeSet`. The `currentNewWalletScheme`
    // storage field is preserved (upgrade-safety rule — never
    // remove a slot from a proxy storage layout) but no longer
    // written. `Wallets.requestNewWallet` no longer reads it
    // either; the dispatcher always targets the FROST registry.
    // See `d2-2-followups-plan.md` §"Slice 3".

    // D-2 canonical retire setter is inlined directly on
    // `Bridge.sol` (writes `self.ecdsaRetired = true` — D-2.2
    // dropped the `emit EcdsaRetired()` that D-2.1 originally
    // shipped, to fit the public `ecdsaRetired()` getter under
    // EIP-170) rather than routed through a library function
    // here, to shave the bytes of indirection that would
    // otherwise push the Bridge implementation past the 24 KiB
    // EIP-170 deploy limit. The bytecode budget for the setter
    // comes from D-2's removal of the
    // `__ecdsaWalletCreatedCallback` external function (~107
    // bytes reclaim).

    /// @notice Sets the rebate staking address.
    /// @param _rebateStaking Address of the rebate staking contract.
    /// @dev Requirements:
    ///      - Rebate staking address must not be already set,
    ///      - Rebate staking address must not be 0x0.
    ///
    /// @dev This function is designed to support a one-time
    ///      initialization of the rebate staking contract. Changing
    ///      the rebate staking address after it is set requires a
    ///      dedicated upgrade path.
    function setRebateStaking(Storage storage self, address _rebateStaking)
        internal
    {
        require(self.rebateStaking == address(0), "Rebate staking already set");

        require(
            _rebateStaking != address(0),
            "Rebate staking address must not be 0x0"
        );

        self.rebateStaking = _rebateStaking;
        emit RebateStakingSet(_rebateStaking);
    }
}
