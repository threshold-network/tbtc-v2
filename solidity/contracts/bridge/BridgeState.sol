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
        // [RECONSTRUCTED-LIVE] Address of the account-control minting controller
        // authorized to increase Bank balances through this Bridge
        // (`controllerIncreaseBalance`/`controllerIncreaseBalances`). Its exact
        // storage location is not a design choice: the live Sepolia Bridge
        // implementation `0xa14a9607…` executes `SLOAD 0x51` (absolute slot 81)
        // for both `mintingController()` and `getMintingController()`, and the
        // live proxy slot 81 holds the deployed controller
        // `0x1433e4f7…`. Because `Bridge.self` begins at absolute slot 51, this
        // field must occupy relative slot 30 (absolute 81) and therefore must be
        // declared here, immediately after `rebateStaking` and BEFORE
        // `migrationDebtVault`. A layout that instead placed `migrationDebtVault`
        // at relative slot 30 (the pre-reconstruction ordering) would reinterpret
        // the live controller as the migration-debt vault and delete the
        // controller getters — the collision this ordering exists to prevent.
        // Upgrade note: this reconstructed field consumed one reserved slot,
        // reducing `__gap` from 45 to 44 for storage-layout compatibility while
        // keeping every post-gap field (absolute slots 129-131) unmoved.
        address mintingController;
        // Canonical migration debt vault used by non-migration reveal guard.
        // Optional and set through governance to enable global migration
        // revealer isolation checks.
        // Upgrade note: this field consumed one reserved slot, reducing
        // `__gap` from 48 to 47 for storage-layout compatibility.
        address migrationDebtVault;
        // Number of fraud challenges submitted against each wallet that have
        // not yet been resolved (neither defeated nor timed out), keyed by the
        // 20-byte wallet public key hash. Incremented in
        // `Fraud.submitFraudChallenge` and decremented when a challenge is
        // resolved. Used to keep a wallet in the `Closing` state while a
        // challenge can still mature, so the fraud-challenge timeout path
        // (which does not accept `Closed` wallets) stays reachable.
        // Upgrade note: this field consumed one reserved slot, reducing
        // `__gap` from 47 to 46 for storage-layout compatibility.
        mapping(bytes20 => uint32) walletPendingFraudChallenges;
        // Ordered list of every wallet's 20-byte public key hash appended in
        // registration order by `Wallets.registerNewWallet`. It mirrors the
        // off-chain `NewWalletRegistered` event ordering so the Bridge can
        // deterministically reconstruct the canonical moving-funds target
        // wallet set (the newest Live wallets) inside
        // `MovingFunds.submitMovingFundsCommitment`, instead of accepting any
        // valid sorted subset. Append-only: entries are never removed, and a
        // wallet's current eligibility is read live from `registeredWallets`.
        // Wallets registered before the upgrade that introduced this list are
        // absent from it; until enough Live wallets are recorded to reconstruct
        // the canonical target set, `submitMovingFundsCommitment` rejects the
        // commitment rather than accepting an arbitrary subset. See that
        // function for details.
        // Upgrade note: this field consumed one reserved slot, reducing
        // `__gap` from 46 to 45 for storage-layout compatibility.
        bytes20[] walletRegistrationOrder;
        // Reserved storage space in case we need to add more variables.
        // The convention from OpenZeppelin suggests the storage space should
        // add up to 50 slots. Here we want to have more slots as there are
        // planned upgrades of the Bridge contract. If more entires are added to
        // the struct in the upcoming versions we need to reduce the array size.
        // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
        // [RECONSTRUCTED-LIVE] Shrunk from 45 to 44 slots to make room for the
        // reconstructed `mintingController` field above without shifting any
        // post-gap field. This keeps `openFraudChallengeEscrow` at absolute slot
        // 129, the packed seed/registry slot at 130, and the legacy-vault
        // coordinator mapping at 131.
        // slither-disable-next-line unused-state
        uint256[44] __gap;
        /// @notice Sum of `depositAmount` across currently-open fraud
        ///         challenges, used to keep `recoverETH` scoped to
        ///         non-escrowed ETH.
        uint256 openFraudChallengeEscrow;
        /// @notice True once governance has accounted for pre-upgrade open
        ///         fraud challenges in `openFraudChallengeEscrow`.
        bool fraudChallengeEscrowSeeded;
        /// @notice True once governance has backfilled `walletRegistrationOrder`
        ///         with the wallets that were registered before the upgrade
        ///         that introduced the on-chain order. Until this is set, the
        ///         order cannot reconstruct the canonical target-wallet set for
        ///         those wallets, so `MovingFunds.submitMovingFundsCommitment`
        ///         rejects the commitment; backfilling it is a required
        ///         precondition for resuming moving-funds commitments after the
        ///         upgrade. Once set, the order is authoritative and the
        ///         deterministic target-wallet selection is enforced. Packs into
        ///         the slot shared with `fraudChallengeEscrowSeeded`; both
        ///         default to false on a fresh upgrade.
        bool walletRegistrationOrderSeeded;
        /// @notice Address of the covenant spend authorization registry
        ///         (`CovenantSpendAuthorization`). It attests, through the
        ///         account-control covenant proof flow, that a covenant active
        ///         UTXO may be spent by a given wallet, so
        ///         `Fraud.defeatFraudChallengeWithCovenantSpend` can recognize
        ///         a covenant migration signature as an honest spend. Optional
        ///         and set through governance; while unset (zero), the covenant
        ///         spend defeat path is unavailable and the covenant signer is
        ///         expected to stay fail-closed. Appended after `__gap` like the
        ///         fraud-escrow and registration-order fields, leaving the
        ///         reserved gap untouched. This 20-byte address packs into the
        ///         same slot as `fraudChallengeEscrowSeeded` and
        ///         `walletRegistrationOrderSeeded` (it occupies bytes 2-21 of
        ///         that slot); those bytes were previously zero, so on upgrade
        ///         it reads as `address(0)` and no existing field is disturbed.
        address covenantSpendAuthorization;
        /// @notice Per-legacy-vault attestation binding a retired
        ///         optimistic-minting legacy `TBTCVault` to the dedicated
        ///         migration coordinator that owns it. A nonzero value is both
        ///         governance's explicit, emitted assertion that every finalized
        ///         optimistic mint for that legacy vault was already swept at the
        ///         attested evidence snapshot, and the only coordinator allowed
        ///         to retire that vault. The zero default makes the exact known
        ///         mainnet legacy vault fail closed for untrust/rotation as soon
        ///         as the new Bridge implementation is active; governance must
        ///         take the explicit attestation transition to unlock retirement.
        ///         No initializer writes this mapping. A mapping root always
        ///         starts a fresh slot, so it is appended after
        ///         `covenantSpendAuthorization` at relative slot 80 (absolute
        ///         Bridge proxy slot 131); its keyed values live at
        ///         `keccak256(abi.encode(vault, uint256(131)))` and cannot
        ///         collide with the packed slot-130 fields. The reserved
        ///         `__gap` above is left untouched.
        mapping(address => address) legacyVaultOptimisticMintingDebtCoordinator;
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

        // Sweep solvency invariant: a deposit at the dust-threshold floor
        // pays the treasury fee plus the per-deposit sweep tx fee out of
        // its own value. `DepositSweep.submitDepositSweepProof` performs
        // `amount - treasuryFee - depositTxFee` and relies on the dust
        // threshold to prevent that subtraction from underflowing.
        // `treasuryFee = amount / depositTreasuryFeeDivisor` when the
        // divisor is non-zero (see `Deposit.sol:420`), so the worst case
        // at `amount == depositDustThreshold` is
        // `depositDustThreshold / depositTreasuryFeeDivisor`. Enforce
        // that the dust threshold strictly exceeds the worst-case
        // treasury+tx fee at parameter-set time so a misconfigured
        // divisor cannot strand revealed deposits at sweep time.
        if (_depositTreasuryFeeDivisor > 0) {
            require(
                _depositDustThreshold >
                    (_depositDustThreshold / _depositTreasuryFeeDivisor) +
                        _depositTxMaxFee,
                "Deposit dust threshold must cover treasury and TX max fee"
            );
        }

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
