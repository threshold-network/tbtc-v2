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

import "@keep-network/random-beacon/contracts/Governable.sol";
import "@keep-network/random-beacon/contracts/ReimbursementPool.sol";
import {IWalletOwner as EcdsaWalletOwner} from "@keep-network/ecdsa/contracts/api/IWalletOwner.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";

import "./IRelay.sol";
import "./BridgeState.sol";
import "./Deposit.sol";
import "./DepositSweep.sol";
import "./Redemption.sol";
import "./BitcoinTx.sol";
import "./EcdsaLib.sol";
import "./Wallets.sol";
import "./Fraud.sol";
import "./MovingFunds.sol";

import "../bank/IReceiveBalanceApproval.sol";
import "../bank/Bank.sol";

/// @title Bitcoin Bridge
/// @notice Bridge manages BTC deposit and redemption flow and is increasing and
///         decreasing balances in the Bank as a result of BTC deposit and
///         redemption operations performed by depositors and redeemers.
///
///         Depositors send BTC funds to the most recently created off-chain
///         ECDSA wallet of the bridge using pay-to-script-hash (P2SH) or
///         pay-to-witness-script-hash (P2WSH) containing hashed information
///         about the depositor’s Ethereum address. Then, the depositor reveals
///         their Ethereum address along with their deposit blinding factor,
///         refund public key hash and refund locktime to the Bridge on Ethereum
///         chain. The off-chain ECDSA wallet listens for these sorts of
///         messages and when it gets one, it checks the Bitcoin network to make
///         sure the deposit lines up. If it does, the off-chain ECDSA wallet
///         may decide to pick the deposit transaction for sweeping, and when
///         the sweep operation is confirmed on the Bitcoin network, the ECDSA
///         wallet informs the Bridge about the sweep increasing appropriate
///         balances in the Bank.
/// @dev Bridge is an upgradeable component of the Bank. The order of
///      functionalities in this contract is: deposit, sweep, redemption,
///      moving funds, wallet lifecycle, frauds, parameters.
contract Bridge is
    Governable,
    EcdsaWalletOwner,
    Initializable,
    IReceiveBalanceApproval
{
    using BridgeState for BridgeState.Storage;
    using Deposit for BridgeState.Storage;
    using DepositSweep for BridgeState.Storage;
    using Redemption for BridgeState.Storage;
    using MovingFunds for BridgeState.Storage;
    using Wallets for BridgeState.Storage;
    using Fraud for BridgeState.Storage;

    BridgeState.Storage internal self;

    event DepositRevealed(
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex,
        address indexed depositor,
        uint64 amount,
        bytes8 blindingFactor,
        bytes20 indexed walletPubKeyHash,
        bytes20 refundPubKeyHash,
        bytes4 refundLocktime,
        address vault
    );

    event DepositsSwept(bytes20 walletPubKeyHash, bytes32 sweepTxHash);

    event RedemptionRequested(
        bytes20 indexed walletPubKeyHash,
        bytes redeemerOutputScript,
        address indexed redeemer,
        uint64 requestedAmount,
        uint64 treasuryFee,
        uint64 txMaxFee
    );

    event RedemptionsCompleted(
        bytes20 indexed walletPubKeyHash,
        bytes32 redemptionTxHash
    );

    event RedemptionTimedOut(
        bytes20 indexed walletPubKeyHash,
        bytes redeemerOutputScript
    );

    event WalletMovingFunds(
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    event MovingFundsCommitmentSubmitted(
        bytes20 indexed walletPubKeyHash,
        bytes20[] targetWallets,
        address submitter
    );

    event MovingFundsTimeoutReset(bytes20 indexed walletPubKeyHash);

    event MovingFundsCompleted(
        bytes20 indexed walletPubKeyHash,
        bytes32 movingFundsTxHash
    );

    event MovingFundsTimedOut(bytes20 indexed walletPubKeyHash);

    event MovingFundsBelowDustReported(bytes20 indexed walletPubKeyHash);

    event MovedFundsSwept(
        bytes20 indexed walletPubKeyHash,
        bytes32 sweepTxHash
    );

    event MovedFundsSweepTimedOut(
        bytes20 indexed walletPubKeyHash,
        bytes32 movingFundsTxHash,
        uint32 movingFundsTxOutputIndex
    );

    event NewWalletRequested();

    event NewWalletRegistered(
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    event WalletClosing(
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    event WalletClosed(
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    event WalletTerminated(
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    event FraudChallengeSubmitted(
        bytes20 indexed walletPubKeyHash,
        bytes32 sighash,
        uint8 v,
        bytes32 r,
        bytes32 s
    );

    event FraudChallengeDefeated(
        bytes20 indexed walletPubKeyHash,
        bytes32 sighash
    );

    event FraudChallengeDefeatTimedOut(
        bytes20 indexed walletPubKeyHash,
        bytes32 sighash
    );

    event VaultStatusUpdated(address indexed vault, bool isTrusted);

    event SpvMaintainerStatusUpdated(
        address indexed spvMaintainer,
        bool isTrusted
    );

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

    modifier onlySpvMaintainer() {
        require(
            self.isSpvMaintainer[msg.sender],
            "Caller is not SPV maintainer"
        );
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Initializes upgradable contract on deployment.
    /// @param _bank Address of the Bank the Bridge belongs to.
    /// @param _relay Address of the Bitcoin relay providing the current Bitcoin
    ///        network difficulty.
    /// @param _treasury Address where the deposit and redemption treasury fees
    ///        will be sent to.
    /// @param _ecdsaWalletRegistry Address of the ECDSA Wallet Registry contract.
    /// @param _reimbursementPool Address of the Reimbursement Pool contract.
    /// @param _txProofDifficultyFactor The number of confirmations on the Bitcoin
    ///        chain required to successfully evaluate an SPV proof.
    function initialize(
        address _bank,
        address _relay,
        address _treasury,
        address _ecdsaWalletRegistry,
        address payable _reimbursementPool,
        uint96 _txProofDifficultyFactor
    ) external initializer {
        require(_bank != address(0), "Bank address cannot be zero");
        self.bank = Bank(_bank);

        require(_relay != address(0), "Relay address cannot be zero");
        self.relay = IRelay(_relay);

        require(
            _ecdsaWalletRegistry != address(0),
            "ECDSA Wallet Registry address cannot be zero"
        );
        self.ecdsaWalletRegistry = EcdsaWalletRegistry(_ecdsaWalletRegistry);

        require(
            _reimbursementPool != address(0),
            "Reimbursement Pool address cannot be zero"
        );
        self.reimbursementPool = ReimbursementPool(_reimbursementPool);

        require(_treasury != address(0), "Treasury address cannot be zero");
        self.treasury = _treasury;

        self.txProofDifficultyFactor = _txProofDifficultyFactor;

        //
        // All parameters set in the constructor are initial ones, used at the
        // moment contracts were deployed for the first time. Parameters are
        // governable and values assigned in the constructor do not need to
        // reflect the current ones. Keep in mind the initial parameters are
        // pretty forgiving and valid only for the early stage of the network.
        //

        self.depositDustThreshold = 1000000; // 1000000 satoshi = 0.01 BTC
        self.depositTxMaxFee = 100000; // 100000 satoshi = 0.001 BTC
        self.depositRevealAheadPeriod = 15 days;
        self.depositTreasuryFeeDivisor = 2000; // 1/2000 == 5bps == 0.05% == 0.0005
        self.redemptionDustThreshold = 1000000; // 1000000 satoshi = 0.01 BTC
        self.redemptionTreasuryFeeDivisor = 2000; // 1/2000 == 5bps == 0.05% == 0.0005
        self.redemptionTxMaxFee = 100000; // 100000 satoshi = 0.001 BTC
        self.redemptionTxMaxTotalFee = 1000000; // 1000000 satoshi = 0.01 BTC
        self.redemptionTimeout = 5 days;
        self.redemptionTimeoutSlashingAmount = 100 * 1e18; // 100 T
        self.redemptionTimeoutNotifierRewardMultiplier = 100; // 100%
        self.movingFundsTxMaxTotalFee = 100000; // 100000 satoshi = 0.001 BTC
        self.movingFundsDustThreshold = 200000; // 200000 satoshi = 0.002 BTC
        self.movingFundsTimeoutResetDelay = 6 days;
        self.movingFundsTimeout = 7 days;
        self.movingFundsTimeoutSlashingAmount = 100 * 1e18; // 100 T
        self.movingFundsTimeoutNotifierRewardMultiplier = 100; //100%
        self.movingFundsCommitmentGasOffset = 15000;
        self.movedFundsSweepTxMaxTotalFee = 100000; // 100000 satoshi = 0.001 BTC
        self.movedFundsSweepTimeout = 7 days;
        self.movedFundsSweepTimeoutSlashingAmount = 100 * 1e18; // 100 T
        self.movedFundsSweepTimeoutNotifierRewardMultiplier = 100; //100%
        self.fraudChallengeDepositAmount = 5 ether;
        self.fraudChallengeDefeatTimeout = 7 days;
        self.fraudSlashingAmount = 100 * 1e18; // 100 T
        self.fraudNotifierRewardMultiplier = 100; // 100%
        self.walletCreationPeriod = 1 weeks;
        self.walletCreationMinBtcBalance = 1e8; // 1 BTC
        self.walletCreationMaxBtcBalance = 100e8; // 100 BTC
        self.walletClosureMinBtcBalance = 5 * 1e7; // 0.5 BTC
        self.walletMaxAge = 26 weeks; // ~6 months
        self.walletMaxBtcTransfer = 10e8; // 10 BTC
        self.walletClosingPeriod = 40 days;

        _transferGovernance(msg.sender);
    }

    /// @notice Used by the depositor to reveal information about their P2(W)SH
    ///         Bitcoin deposit to the Bridge on Ethereum chain. The off-chain
    ///         wallet listens for revealed deposit events and may decide to
    ///         include the revealed deposit in the next executed sweep.
    ///         Information about the Bitcoin deposit can be revealed before or
    ///         after the Bitcoin transaction with P2(W)SH deposit is mined on
    ///         the Bitcoin chain. Worth noting, the gas cost of this function
    ///         scales with the number of P2(W)SH transaction inputs and
    ///         outputs. The deposit may be routed to one of the trusted vaults.
    ///         When a deposit is routed to a vault, vault gets notified when
    ///         the deposit gets swept and it may execute the appropriate action.
    /// @param fundingTx Bitcoin funding transaction data, see `BitcoinTx.Info`.
    /// @param reveal Deposit reveal data, see `RevealInfo struct.
    /// @dev Requirements:
    ///      - This function must be called by the same Ethereum address as the
    ///        one used in the P2(W)SH BTC deposit transaction as a depositor,
    ///      - `reveal.walletPubKeyHash` must identify a `Live` wallet,
    ///      - `reveal.vault` must be 0x0 or point to a trusted vault,
    ///      - `reveal.fundingOutputIndex` must point to the actual P2(W)SH
    ///        output of the BTC deposit transaction,
    ///      - `reveal.blindingFactor` must be the blinding factor used in the
    ///        P2(W)SH BTC deposit transaction,
    ///      - `reveal.walletPubKeyHash` must be the wallet pub key hash used in
    ///        the P2(W)SH BTC deposit transaction,
    ///      - `reveal.refundPubKeyHash` must be the refund pub key hash used in
    ///        the P2(W)SH BTC deposit transaction,
    ///      - `reveal.refundLocktime` must be the refund locktime used in the
    ///        P2(W)SH BTC deposit transaction,
    ///      - BTC deposit for the given `fundingTxHash`, `fundingOutputIndex`
    ///        can be revealed only one time.
    ///
    ///      If any of these requirements is not met, the wallet _must_ refuse
    ///      to sweep the deposit and the depositor has to wait until the
    ///      deposit script unlocks to receive their BTC back.
    function revealDeposit(
        BitcoinTx.Info calldata fundingTx,
        Deposit.DepositRevealInfo calldata reveal
    ) external {
        self.revealDeposit(fundingTx, reveal);
    }

    /// @notice Sibling of the `revealDeposit` function. This function allows
    ///         to reveal a P2(W)SH Bitcoin deposit with 32-byte extra data
    ///         embedded in the deposit script. The extra data allows to
    ///         attach additional context to the deposit. For example,
    ///         it allows a third-party smart contract to reveal the
    ///         deposit on behalf of the original depositor and provide
    ///         additional services once the deposit is handled. In this
    ///         case, the address of the original depositor can be encoded
    ///         as extra data.
    /// @param fundingTx Bitcoin funding transaction data, see `BitcoinTx.Info`.
    /// @param reveal Deposit reveal data, see `RevealInfo struct.
    /// @param extraData 32-byte deposit extra data.
    /// @dev Requirements:
    ///      - All requirements from `revealDeposit` function must be met,
    ///      - `extraData` must not be bytes32(0),
    ///      - `extraData` must be the actual extra data used in the P2(W)SH
    ///        BTC deposit transaction.
    ///
    ///      If any of these requirements is not met, the wallet _must_ refuse
    ///      to sweep the deposit and the depositor has to wait until the
    ///      deposit script unlocks to receive their BTC back.
    function revealDepositWithExtraData(
        BitcoinTx.Info calldata fundingTx,
        Deposit.DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external {
        self.revealDepositWithExtraData(fundingTx, reveal, extraData);
    }

    /// @notice Used by the wallet to prove the BTC deposit sweep transaction
    ///         and to update Bank balances accordingly. Sweep is only accepted
    ///         if it satisfies SPV proof.
    ///
    ///         The function is performing Bank balance updates by first
    ///         computing the Bitcoin fee for the sweep transaction. The fee is
    ///         divided evenly between all swept deposits. Each depositor
    ///         receives a balance in the bank equal to the amount inferred
    ///         during the reveal transaction, minus their fee share.
    ///
    ///         It is possible to prove the given sweep only one time.
    /// @param sweepTx Bitcoin sweep transaction data.
    /// @param sweepProof Bitcoin sweep proof data.
    /// @param mainUtxo Data of the wallet's main UTXO, as currently known on
    ///        the Ethereum chain. If no main UTXO exists for the given wallet,
    ///        this parameter is ignored.
    /// @param vault Optional address of the vault where all swept deposits
    ///        should be routed to. All deposits swept as part of the transaction
    ///        must have their `vault` parameters set to the same address.
    ///        If this parameter is set to an address of a trusted vault, swept
    ///        deposits are routed to that vault.
    ///        If this parameter is set to the zero address or to an address
    ///        of a non-trusted vault, swept deposits are not routed to a
    ///        vault but depositors' balances are increased in the Bank
    ///        individually.
    /// @dev Requirements:
    ///      - `sweepTx` components must match the expected structure. See
    ///        `BitcoinTx.Info` docs for reference. Their values must exactly
    ///        correspond to appropriate Bitcoin transaction fields to produce
    ///        a provable transaction hash,
    ///      - The `sweepTx` should represent a Bitcoin transaction with 1..n
    ///        inputs. If the wallet has no main UTXO, all n inputs should
    ///        correspond to P2(W)SH revealed deposits UTXOs. If the wallet has
    ///        an existing main UTXO, one of the n inputs must point to that
    ///        main UTXO and remaining n-1 inputs should correspond to P2(W)SH
    ///        revealed deposits UTXOs. That transaction must have only
    ///        one P2(W)PKH output locking funds on the 20-byte wallet public
    ///        key hash,
    ///      - All revealed deposits that are swept by `sweepTx` must have
    ///        their `vault` parameters set to the same address as the address
    ///        passed in the `vault` function parameter,
    ///      - `sweepProof` components must match the expected structure. See
    ///        `BitcoinTx.Proof` docs for reference. The `bitcoinHeaders`
    ///        field must contain a valid number of block headers, not less
    ///        than the `txProofDifficultyFactor` contract constant,
    ///      - `mainUtxo` components must point to the recent main UTXO
    ///        of the given wallet, as currently known on the Ethereum chain.
    ///        If there is no main UTXO, this parameter is ignored.
    function submitDepositSweepProof(
        BitcoinTx.Info calldata sweepTx,
        BitcoinTx.Proof calldata sweepProof,
        BitcoinTx.UTXO calldata mainUtxo,
        address vault
    ) external onlySpvMaintainer {
        self.submitDepositSweepProof(sweepTx, sweepProof, mainUtxo, vault);
    }

    /// @notice Requests redemption of the given amount from the specified
    ///         wallet to the redeemer Bitcoin output script. Handles the
    ///         simplest case in which the redeemer's balance is decreased in
    ///         the Bank.
    /// @param walletPubKeyHash The 20-byte wallet public key hash (computed
    ///        using Bitcoin HASH160 over the compressed ECDSA public key).
    /// @param mainUtxo Data of the wallet's main UTXO, as currently known on
    ///        the Ethereum chain.
    /// @param redeemerOutputScript The redeemer's length-prefixed output
    ///        script (P2PKH, P2WPKH, P2SH or P2WSH) that will be used to lock
    ///        redeemed BTC.
    /// @param amount Requested amount in satoshi. This is also the Bank balance
    ///        that is taken from the `balanceOwner` upon request.
    ///        Once the request is handled, the actual amount of BTC locked
    ///        on the redeemer output script will be always lower than this value
    ///        since the treasury and Bitcoin transaction fees must be incurred.
    ///        The minimal amount satisfying the request can be computed as:
    ///        `amount - (amount / redemptionTreasuryFeeDivisor) - redemptionTxMaxFee`.
    ///        Fees values are taken at the moment of request creation.
    /// @dev Requirements:
    ///      - Wallet behind `walletPubKeyHash` must be live,
    ///      - `mainUtxo` components must point to the recent main UTXO
    ///        of the given wallet, as currently known on the Ethereum chain,
    ///      - `redeemerOutputScript` must be a proper Bitcoin script,
    ///      - `redeemerOutputScript` cannot have wallet PKH as payload,
    ///      - `amount` must be above or equal the `redemptionDustThreshold`,
    ///      - Given `walletPubKeyHash` and `redeemerOutputScript` pair can be
    ///        used for only one pending request at the same time,
    ///      - Wallet must have enough Bitcoin balance to process the request,
    ///      - Redeemer must make an allowance in the Bank that the Bridge
    ///        contract can spend the given `amount`.
    function requestRedemption(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes calldata redeemerOutputScript,
        uint64 amount
    ) external {
        self.requestRedemption(
            walletPubKeyHash,
            mainUtxo,
            msg.sender,
            redeemerOutputScript,
            amount
        );
    }

    /// @notice Requests redemption of the given amount from the specified
    ///         wallet to the redeemer Bitcoin output script. Used by
    ///         `Bank.approveBalanceAndCall`. Can handle more complex cases
    ///         where balance owner may be someone else than the redeemer.
    ///         For example, vault redeeming its balance for some depositor.
    /// @param balanceOwner The address of the Bank balance owner whose balance
    ///        is getting redeemed.
    /// @param amount Requested amount in satoshi. This is also the Bank balance
    ///        that is taken from the `balanceOwner` upon request.
    ///        Once the request is handled, the actual amount of BTC locked
    ///        on the redeemer output script will be always lower than this value
    ///        since the treasury and Bitcoin transaction fees must be incurred.
    ///        The minimal amount satisfying the request can be computed as:
    ///        `amount - (amount / redemptionTreasuryFeeDivisor) - redemptionTxMaxFee`.
    ///        Fees values are taken at the moment of request creation.
    /// @param redemptionData ABI-encoded redemption data:
    ///        [
    ///          address redeemer,
    ///          bytes20 walletPubKeyHash,
    ///          bytes32 mainUtxoTxHash,
    ///          uint32 mainUtxoTxOutputIndex,
    ///          uint64 mainUtxoTxOutputValue,
    ///          bytes redeemerOutputScript
    ///        ]
    ///
    ///        - redeemer: The Ethereum address of the redeemer who will be able
    ///        to claim Bank balance if anything goes wrong during the redemption.
    ///        In the most basic case, when someone redeems their balance
    ///        from the Bank, `balanceOwner` is the same as `redeemer`.
    ///        However, when a Vault is redeeming part of its balance for some
    ///        redeemer address (for example, someone who has earlier deposited
    ///        into that Vault), `balanceOwner` is the Vault, and `redeemer` is
    ///        the address for which the vault is redeeming its balance to,
    ///        - walletPubKeyHash: The 20-byte wallet public key hash (computed
    ///        using Bitcoin HASH160 over the compressed ECDSA public key),
    ///        - mainUtxoTxHash: Data of the wallet's main UTXO TX hash, as
    ///        currently known on the Ethereum chain,
    ///        - mainUtxoTxOutputIndex: Data of the wallet's main UTXO output
    ///        index, as currently known on Ethereum chain,
    ///        - mainUtxoTxOutputValue: Data of the wallet's main UTXO output
    ///        value, as currently known on Ethereum chain,
    ///        - redeemerOutputScript The redeemer's length-prefixed output
    ///        script (P2PKH, P2WPKH, P2SH or P2WSH) that will be used to lock
    ///        redeemed BTC.
    /// @dev Requirements:
    ///      - The caller must be the Bank,
    ///      - Wallet behind `walletPubKeyHash` must be live,
    ///      - `mainUtxo` components must point to the recent main UTXO
    ///        of the given wallet, as currently known on the Ethereum chain,
    ///      - `redeemerOutputScript` must be a proper Bitcoin script,
    ///      - `redeemerOutputScript` cannot have wallet PKH as payload,
    ///      - `amount` must be above or equal the `redemptionDustThreshold`,
    ///      - Given `walletPubKeyHash` and `redeemerOutputScript` pair can be
    ///        used for only one pending request at the same time,
    ///      - Wallet must have enough Bitcoin balance to process the request.
    ///
    ///      Note on upgradeability:
    ///      Bridge is an upgradeable contract deployed behind
    ///      a TransparentUpgradeableProxy. Accepting redemption data as bytes
    ///      provides great flexibility. The Bridge is just like any other
    ///      contract with a balance approved in the Bank and can be upgraded
    ///      to another version without being bound to a particular interface
    ///      forever. This flexibility comes with the cost - developers
    ///      integrating their vaults and dApps with `Bridge` using
    ///      `approveBalanceAndCall` need to pay extra attention to
    ///      `redemptionData` and adjust the code in case the expected structure
    ///      of `redemptionData`  changes.
    function receiveBalanceApproval(
        address balanceOwner,
        uint256 amount,
        bytes calldata redemptionData
    ) external override {
        require(msg.sender == address(self.bank), "Caller is not the bank");

        self.requestRedemption(
            balanceOwner,
            SafeCastUpgradeable.toUint64(amount),
            redemptionData
        );
    }

    /// @notice Used by the wallet to prove the BTC redemption transaction
    ///         and to make the necessary bookkeeping. Redemption is only
    ///         accepted if it satisfies SPV proof.
    ///
    ///         The function is performing Bank balance updates by burning
    ///         the total redeemed Bitcoin amount from Bridge balance and
    ///         transferring the treasury fee sum to the treasury address.
    ///
    ///         It is possible to prove the given redemption only one time.
    /// @param redemptionTx Bitcoin redemption transaction data.
    /// @param redemptionProof Bitcoin redemption proof data.
    /// @param mainUtxo Data of the wallet's main UTXO, as currently known on
    ///        the Ethereum chain.
    /// @param walletPubKeyHash 20-byte public key hash (computed using Bitcoin
    ///        HASH160 over the compressed ECDSA public key) of the wallet which
    ///        performed the redemption transaction.
    /// @dev Requirements:
    ///      - `redemptionTx` components must match the expected structure. See
    ///        `BitcoinTx.Info` docs for reference. Their values must exactly
    ///        correspond to appropriate Bitcoin transaction fields to produce
    ///        a provable transaction hash,
    ///      - The `redemptionTx` should represent a Bitcoin transaction with
    ///        exactly 1 input that refers to the wallet's main UTXO. That
    ///        transaction should have 1..n outputs handling existing pending
    ///        redemption requests or pointing to reported timed out requests.
    ///        There can be also 1 optional output representing the
    ///        change and pointing back to the 20-byte wallet public key hash.
    ///        The change should be always present if the redeemed value sum
    ///        is lower than the total wallet's BTC balance,
    ///      - `redemptionProof` components must match the expected structure.
    ///        See `BitcoinTx.Proof` docs for reference. The `bitcoinHeaders`
    ///        field must contain a valid number of block headers, not less
    ///        than the `txProofDifficultyFactor` contract constant,
    ///      - `mainUtxo` components must point to the recent main UTXO
    ///        of the given wallet, as currently known on the Ethereum chain.
    ///        Additionally, the recent main UTXO on Ethereum must be set,
    ///      - `walletPubKeyHash` must be connected with the main UTXO used
    ///        as transaction single input.
    ///      Other remarks:
    ///      - Putting the change output as the first transaction output can
    ///        save some gas because the output processing loop begins each
    ///        iteration by checking whether the given output is the change
    ///        thus uses some gas for making the comparison. Once the change
    ///        is identified, that check is omitted in further iterations.
    function submitRedemptionProof(
        BitcoinTx.Info calldata redemptionTx,
        BitcoinTx.Proof calldata redemptionProof,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes20 walletPubKeyHash
    ) external onlySpvMaintainer {
        self.submitRedemptionProof(
            redemptionTx,
            redemptionProof,
            mainUtxo,
            walletPubKeyHash
        );
    }

    /// @notice Notifies that there is a pending redemption request associated
    ///         with the given wallet, that has timed out. The redemption
    ///         request is identified by the key built as
    ///         `keccak256(keccak256(redeemerOutputScript) | walletPubKeyHash)`.
    ///         The results of calling this function:
    ///         - The pending redemptions value for the wallet will be decreased
    ///           by the requested amount (minus treasury fee),
    ///         - The tokens taken from the redeemer on redemption request will
    ///           be returned to the redeemer,
    ///         - The request will be moved from pending redemptions to
    ///           timed-out redemptions,
    ///         - If the state of the wallet is `Live` or `MovingFunds`, the
    ///           wallet operators will be slashed and the notifier will be
    ///           rewarded,
    ///         - If the state of wallet is `Live`, the wallet will be closed or
    ///           marked as `MovingFunds` (depending on the presence or absence
    ///           of the wallet's main UTXO) and the wallet will no longer be
    ///           marked as the active wallet (if it was marked as such).
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @param redeemerOutputScript  The redeemer's length-prefixed output
    ///        script (P2PKH, P2WPKH, P2SH or P2WSH).
    /// @dev Requirements:
    ///      - The wallet must be in the Live or MovingFunds or Terminated state,
    ///      - The redemption request identified by `walletPubKeyHash` and
    ///        `redeemerOutputScript` must exist,
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given `walletID`. Those IDs are not directly stored
    ///        in the contract for gas efficiency purposes but they can be
    ///        read from appropriate `DkgResultSubmitted` and `DkgResultApproved`
    ///        events of the `WalletRegistry` contract,
    ///      - The amount of time defined by `redemptionTimeout` must have
    ///        passed since the redemption was requested (the request must be
    ///        timed-out).
    function notifyRedemptionTimeout(
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs,
        bytes calldata redeemerOutputScript
    ) external {
        self.notifyRedemptionTimeout(
            walletPubKeyHash,
            walletMembersIDs,
            redeemerOutputScript
        );
    }

    /// @notice Submits the moving funds target wallets commitment.
    ///         Once all requirements are met, that function registers the
    ///         target wallets commitment and opens the way for moving funds
    ///         proof submission.
    ///         The caller is reimbursed for the transaction costs.
    /// @param walletPubKeyHash 20-byte public key hash of the source wallet.
    /// @param walletMainUtxo Data of the source wallet's main UTXO, as
    ///        currently known on the Ethereum chain.
    /// @param walletMembersIDs Identifiers of the source wallet signing group
    ///        members.
    /// @param walletMemberIndex Position of the caller in the source wallet
    ///        signing group members list.
    /// @param targetWallets List of 20-byte public key hashes of the target
    ///        wallets that the source wallet commits to move the funds to.
    /// @dev Requirements:
    ///      - The source wallet must be in the MovingFunds state,
    ///      - The source wallet must not have pending redemption requests,
    ///      - The source wallet must not have pending moved funds sweep requests,
    ///      - The source wallet must not have submitted its commitment already,
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given source wallet in the ECDSA registry. Those IDs are
    ///        not directly stored in the contract for gas efficiency purposes
    ///        but they can be read from appropriate `DkgResultSubmitted`
    ///        and `DkgResultApproved` events,
    ///      - The `walletMemberIndex` must be in range [1, walletMembersIDs.length],
    ///      - The caller must be the member of the source wallet signing group
    ///        at the position indicated by `walletMemberIndex` parameter,
    ///      - The `walletMainUtxo` components must point to the recent main
    ///        UTXO of the source wallet, as currently known on the Ethereum
    ///        chain,
    ///      - Source wallet BTC balance must be greater than zero,
    ///      - At least one Live wallet must exist in the system,
    ///      - Submitted target wallets count must match the expected count
    ///        `N = min(liveWalletsCount, ceil(walletBtcBalance / walletMaxBtcTransfer))`
    ///        where `N > 0`,
    ///      - Each target wallet must be not equal to the source wallet,
    ///      - Each target wallet must follow the expected order i.e. all
    ///        target wallets 20-byte public key hashes represented as numbers
    ///        must form a strictly increasing sequence without duplicates,
    ///      - Each target wallet must be in Live state.
    function submitMovingFundsCommitment(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata walletMainUtxo,
        uint32[] calldata walletMembersIDs,
        uint256 walletMemberIndex,
        bytes20[] calldata targetWallets
    ) external {
        uint256 gasStart = gasleft();

        self.submitMovingFundsCommitment(
            walletPubKeyHash,
            walletMainUtxo,
            walletMembersIDs,
            walletMemberIndex,
            targetWallets
        );

        self.reimbursementPool.refund(
            (gasStart - gasleft()) + self.movingFundsCommitmentGasOffset,
            msg.sender
        );
    }

    /// @notice Resets the moving funds timeout for the given wallet if the
    ///         target wallet commitment cannot be submitted due to a lack
    ///         of live wallets in the system.
    /// @param walletPubKeyHash 20-byte public key hash of the moving funds wallet.
    /// @dev Requirements:
    ///      - The wallet must be in the MovingFunds state,
    ///      - The target wallets commitment must not be already submitted for
    ///        the given moving funds wallet,
    ///      - Live wallets count must be zero,
    ///      - The moving funds timeout reset delay must be elapsed.
    function resetMovingFundsTimeout(bytes20 walletPubKeyHash) external {
        self.resetMovingFundsTimeout(walletPubKeyHash);
    }

    /// @notice Used by the wallet to prove the BTC moving funds transaction
    ///         and to make the necessary state changes. Moving funds is only
    ///         accepted if it satisfies SPV proof.
    ///
    ///         The function validates the moving funds transaction structure
    ///         by checking if it actually spends the main UTXO of the declared
    ///         wallet and locks the value on the pre-committed target wallets
    ///         using a reasonable transaction fee. If all preconditions are
    ///         met, this functions closes the source wallet.
    ///
    ///         It is possible to prove the given moving funds transaction only
    ///         one time.
    /// @param movingFundsTx Bitcoin moving funds transaction data.
    /// @param movingFundsProof Bitcoin moving funds proof data.
    /// @param mainUtxo Data of the wallet's main UTXO, as currently known on
    ///        the Ethereum chain.
    /// @param walletPubKeyHash 20-byte public key hash (computed using Bitcoin
    ///        HASH160 over the compressed ECDSA public key) of the wallet
    ///        which performed the moving funds transaction.
    /// @dev Requirements:
    ///      - `movingFundsTx` components must match the expected structure. See
    ///        `BitcoinTx.Info` docs for reference. Their values must exactly
    ///        correspond to appropriate Bitcoin transaction fields to produce
    ///        a provable transaction hash,
    ///      - The `movingFundsTx` should represent a Bitcoin transaction with
    ///        exactly 1 input that refers to the wallet's main UTXO. That
    ///        transaction should have 1..n outputs corresponding to the
    ///        pre-committed target wallets. Outputs must be ordered in the
    ///        same way as their corresponding target wallets are ordered
    ///        within the target wallets commitment,
    ///      - `movingFundsProof` components must match the expected structure.
    ///        See `BitcoinTx.Proof` docs for reference. The `bitcoinHeaders`
    ///        field must contain a valid number of block headers, not less
    ///        than the `txProofDifficultyFactor` contract constant,
    ///      - `mainUtxo` components must point to the recent main UTXO
    ///        of the given wallet, as currently known on the Ethereum chain.
    ///        Additionally, the recent main UTXO on Ethereum must be set,
    ///      - `walletPubKeyHash` must be connected with the main UTXO used
    ///        as transaction single input,
    ///      - The wallet that `walletPubKeyHash` points to must be in the
    ///        MovingFunds state,
    ///      - The target wallets commitment must be submitted by the wallet
    ///        that `walletPubKeyHash` points to,
    ///      - The total Bitcoin transaction fee must be lesser or equal
    ///        to `movingFundsTxMaxTotalFee` governable parameter.
    function submitMovingFundsProof(
        BitcoinTx.Info calldata movingFundsTx,
        BitcoinTx.Proof calldata movingFundsProof,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes20 walletPubKeyHash
    ) external onlySpvMaintainer {
        self.submitMovingFundsProof(
            movingFundsTx,
            movingFundsProof,
            mainUtxo,
            walletPubKeyHash
        );
    }

    /// @notice Notifies about a timed out moving funds process. Terminates
    ///         the wallet and slashes signing group members as a result.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @dev Requirements:
    ///      - The wallet must be in the MovingFunds state,
    ///      - The moving funds timeout must be actually exceeded,
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given `walletID`. Those IDs are not directly stored
    ///        in the contract for gas efficiency purposes but they can be
    ///        read from appropriate `DkgResultSubmitted` and `DkgResultApproved`
    ///        events of the `WalletRegistry` contract.
    function notifyMovingFundsTimeout(
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs
    ) external {
        self.notifyMovingFundsTimeout(walletPubKeyHash, walletMembersIDs);
    }

    /// @notice Notifies about a moving funds wallet whose BTC balance is
    ///         below the moving funds dust threshold. Ends the moving funds
    ///         process and begins wallet closing immediately.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet
    /// @param mainUtxo Data of the wallet's main UTXO, as currently known
    ///        on the Ethereum chain.
    /// @dev Requirements:
    ///      - The wallet must be in the MovingFunds state,
    ///      - The `mainUtxo` components must point to the recent main UTXO
    ///        of the given wallet, as currently known on the Ethereum chain.
    ///        If the wallet has no main UTXO, this parameter can be empty as it
    ///        is ignored,
    ///      - The wallet BTC balance must be below the moving funds threshold.
    function notifyMovingFundsBelowDust(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo
    ) external {
        self.notifyMovingFundsBelowDust(walletPubKeyHash, mainUtxo);
    }

    /// @notice Used by the wallet to prove the BTC moved funds sweep
    ///         transaction and to make the necessary state changes. Moved
    ///         funds sweep is only accepted if it satisfies SPV proof.
    ///
    ///         The function validates the sweep transaction structure by
    ///         checking if it actually spends the moved funds UTXO and the
    ///         sweeping wallet's main UTXO (optionally), and if it locks the
    ///         value on the sweeping wallet's 20-byte public key hash using a
    ///         reasonable transaction fee. If all preconditions are
    ///         met, this function updates the sweeping wallet main UTXO, thus
    ///         their BTC balance.
    ///
    ///         It is possible to prove the given sweep transaction only
    ///         one time.
    /// @param sweepTx Bitcoin sweep funds transaction data.
    /// @param sweepProof Bitcoin sweep funds proof data.
    /// @param mainUtxo Data of the sweeping wallet's main UTXO, as currently
    ///        known on the Ethereum chain.
    /// @dev Requirements:
    ///      - `sweepTx` components must match the expected structure. See
    ///        `BitcoinTx.Info` docs for reference. Their values must exactly
    ///        correspond to appropriate Bitcoin transaction fields to produce
    ///        a provable transaction hash,
    ///      - The `sweepTx` should represent a Bitcoin transaction with
    ///        the first input pointing to a moved funds sweep request targeted
    ///        to the wallet, and optionally, the second input pointing to the
    ///        wallet's main UTXO, if the sweeping wallet has a main UTXO set.
    ///        There should be only one output locking funds on the sweeping
    ///        wallet 20-byte public key hash,
    ///      - `sweepProof` components must match the expected structure.
    ///        See `BitcoinTx.Proof` docs for reference. The `bitcoinHeaders`
    ///        field must contain a valid number of block headers, not less
    ///        than the `txProofDifficultyFactor` contract constant,
    ///      - `mainUtxo` components must point to the recent main UTXO
    ///        of the sweeping wallet, as currently known on the Ethereum chain.
    ///        If there is no main UTXO, this parameter is ignored,
    ///      - The sweeping wallet must be in the Live or MovingFunds state,
    ///      - The total Bitcoin transaction fee must be lesser or equal
    ///        to `movedFundsSweepTxMaxTotalFee` governable parameter.
    function submitMovedFundsSweepProof(
        BitcoinTx.Info calldata sweepTx,
        BitcoinTx.Proof calldata sweepProof,
        BitcoinTx.UTXO calldata mainUtxo
    ) external onlySpvMaintainer {
        self.submitMovedFundsSweepProof(sweepTx, sweepProof, mainUtxo);
    }

    /// @notice Notifies about a timed out moved funds sweep process. If the
    ///         wallet is not terminated yet, that function terminates
    ///         the wallet and slashes signing group members as a result.
    ///         Marks the given sweep request as TimedOut.
    /// @param movingFundsTxHash 32-byte hash of the moving funds transaction
    ///        that caused the sweep request to be created.
    /// @param movingFundsTxOutputIndex Index of the moving funds transaction
    ///        output that is subject of the sweep request.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @dev Requirements:
    ///      - The moved funds sweep request must be in the Pending state,
    ///      - The moved funds sweep timeout must be actually exceeded,
    ///      - The wallet must be either in the Live or MovingFunds or
    ///        Terminated state,
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given `walletID`. Those IDs are not directly stored
    ///        in the contract for gas efficiency purposes but they can be
    ///        read from appropriate `DkgResultSubmitted` and `DkgResultApproved`
    ///        events of the `WalletRegistry` contract.
    function notifyMovedFundsSweepTimeout(
        bytes32 movingFundsTxHash,
        uint32 movingFundsTxOutputIndex,
        uint32[] calldata walletMembersIDs
    ) external {
        self.notifyMovedFundsSweepTimeout(
            movingFundsTxHash,
            movingFundsTxOutputIndex,
            walletMembersIDs
        );
    }

    /// @notice Requests creation of a new wallet. This function just
    ///         forms a request and the creation process is performed
    ///         asynchronously. Once a wallet is created, the ECDSA Wallet
    ///         Registry will notify this contract by calling the
    ///         `__ecdsaWalletCreatedCallback` function.
    /// @param activeWalletMainUtxo Data of the active wallet's main UTXO, as
    ///        currently known on the Ethereum chain.
    /// @dev Requirements:
    ///      - `activeWalletMainUtxo` components must point to the recent main
    ///        UTXO of the given active wallet, as currently known on the
    ///        Ethereum chain. If there is no active wallet at the moment, or
    ///        the active wallet has no main UTXO, this parameter can be
    ///        empty as it is ignored,
    ///      - Wallet creation must not be in progress,
    ///      - If the active wallet is set, one of the following
    ///        conditions must be true:
    ///        - The active wallet BTC balance is above the minimum threshold
    ///          and the active wallet is old enough, i.e. the creation period
    ///          was elapsed since its creation time,
    ///        - The active wallet BTC balance is above the maximum threshold.
    function requestNewWallet(BitcoinTx.UTXO calldata activeWalletMainUtxo)
        external
    {
        self.requestNewWallet(activeWalletMainUtxo);
    }

    /// @notice A callback function that is called by the ECDSA Wallet Registry
    ///         once a new ECDSA wallet is created.
    /// @param ecdsaWalletID Wallet's unique identifier.
    /// @param publicKeyX Wallet's public key's X coordinate.
    /// @param publicKeyY Wallet's public key's Y coordinate.
    /// @dev Requirements:
    ///      - The only caller authorized to call this function is `registry`,
    ///      - Given wallet data must not belong to an already registered wallet.
    function __ecdsaWalletCreatedCallback(
        bytes32 ecdsaWalletID,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) external override {
        self.registerNewWallet(ecdsaWalletID, publicKeyX, publicKeyY);
    }

    /// @notice A callback function that is called by the ECDSA Wallet Registry
    ///         once a wallet heartbeat failure is detected.
    /// @param publicKeyX Wallet's public key's X coordinate.
    /// @param publicKeyY Wallet's public key's Y coordinate.
    /// @dev Requirements:
    ///      - The only caller authorized to call this function is `registry`,
    ///      - Wallet must be in Live state.
    function __ecdsaWalletHeartbeatFailedCallback(
        bytes32,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) external override {
        self.notifyWalletHeartbeatFailed(publicKeyX, publicKeyY);
    }

    /// @notice Notifies that the wallet is either old enough or has too few
    ///         satoshi left and qualifies to be closed.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param walletMainUtxo Data of the wallet's main UTXO, as currently
    ///        known on the Ethereum chain.
    /// @dev Requirements:
    ///      - Wallet must not be set as the current active wallet,
    ///      - Wallet must exceed the wallet maximum age OR the wallet BTC
    ///        balance must be lesser than the minimum threshold. If the latter
    ///        case is true, the `walletMainUtxo` components must point to the
    ///        recent main UTXO of the given wallet, as currently known on the
    ///        Ethereum chain. If the wallet has no main UTXO, this parameter
    ///        can be empty as it is ignored since the wallet balance is
    ///        assumed to be zero,
    ///      - Wallet must be in Live state.
    function notifyWalletCloseable(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata walletMainUtxo
    ) external {
        self.notifyWalletCloseable(walletPubKeyHash, walletMainUtxo);
    }

    /// @notice Notifies about the end of the closing period for the given wallet.
    ///         Closes the wallet ultimately and notifies the ECDSA registry
    ///         about this fact.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @dev Requirements:
    ///      - The wallet must be in the Closing state,
    ///      - The wallet closing period must have elapsed.
    function notifyWalletClosingPeriodElapsed(bytes20 walletPubKeyHash)
        external
    {
        self.notifyWalletClosingPeriodElapsed(walletPubKeyHash);
    }

    /// @notice Submits a fraud challenge indicating that a UTXO being under
    ///         wallet control was unlocked by the wallet but was not used
    ///         according to the protocol rules. That means the wallet signed
    ///         a transaction input pointing to that UTXO and there is a unique
    ///         sighash and signature pair associated with that input. This
    ///         function uses those parameters to create a fraud accusation that
    ///         proves a given transaction input unlocking the given UTXO was
    ///         actually signed by the wallet. This function cannot determine
    ///         whether the transaction was actually broadcast and the input was
    ///         consumed in a fraudulent way so it just opens a challenge period
    ///         during which the wallet can defeat the challenge by submitting
    ///         proof of a transaction that consumes the given input according
    ///         to protocol rules. To prevent spurious allegations, the caller
    ///         must deposit ETH that is returned back upon justified fraud
    ///         challenge or confiscated otherwise.
    /// @param walletPublicKey The public key of the wallet in the uncompressed
    ///        and unprefixed format (64 bytes).
    /// @param preimageSha256 The hash that was generated by applying SHA-256
    ///        one time over the preimage used during input signing. The preimage
    ///        is a serialized subset of the transaction and its structure
    ///        depends on the transaction input (see BIP-143 for reference).
    ///        Notice that applying SHA-256 over the `preimageSha256` results
    ///        in `sighash`.  The path from `preimage` to `sighash` looks like
    ///        this:
    ///        preimage -> (SHA-256) -> preimageSha256 -> (SHA-256) -> sighash.
    /// @param signature Bitcoin signature in the R/S/V format.
    /// @dev Requirements:
    ///      - Wallet behind `walletPublicKey` must be in Live or MovingFunds
    ///        or Closing state,
    ///      - The challenger must send appropriate amount of ETH used as
    ///        fraud challenge deposit,
    ///      - The signature (represented by r, s and v) must be generated by
    ///        the wallet behind `walletPubKey` during signing of `sighash`
    ///        which was calculated from `preimageSha256`,
    ///      - Wallet can be challenged for the given signature only once.
    function submitFraudChallenge(
        bytes calldata walletPublicKey,
        bytes memory preimageSha256,
        BitcoinTx.RSVSignature calldata signature
    ) external payable {
        self.submitFraudChallenge(walletPublicKey, preimageSha256, signature);
    }

    /// @notice Allows to defeat a pending fraud challenge against a wallet if
    ///         the transaction that spends the UTXO follows the protocol rules.
    ///         In order to defeat the challenge the same `walletPublicKey` and
    ///         signature (represented by `r`, `s` and `v`) must be provided as
    ///         were used to calculate the sighash during input signing.
    ///         The fraud challenge defeat attempt will only succeed if the
    ///         inputs in the preimage are considered honestly spent by the
    ///         wallet. Therefore the transaction spending the UTXO must be
    ///         proven in the Bridge before a challenge defeat is called.
    ///         If successfully defeated, the fraud challenge is marked as
    ///         resolved and the amount of ether deposited by the challenger is
    ///         sent to the treasury.
    /// @param walletPublicKey The public key of the wallet in the uncompressed
    ///        and unprefixed format (64 bytes).
    /// @param preimage The preimage which produces sighash used to generate the
    ///        ECDSA signature that is the subject of the fraud claim. It is a
    ///        serialized subset of the transaction. The exact subset used as
    ///        the preimage depends on the transaction input the signature is
    ///        produced for. See BIP-143 for reference.
    /// @param witness Flag indicating whether the preimage was produced for a
    ///        witness input. True for witness, false for non-witness input.
    /// @dev Requirements:
    ///      - `walletPublicKey` and `sighash` calculated as `hash256(preimage)`
    ///        must identify an open fraud challenge,
    ///      - the preimage must be a valid preimage of a transaction generated
    ///        according to the protocol rules and already proved in the Bridge,
    ///      - before a defeat attempt is made the transaction that spends the
    ///        given UTXO must be proven in the Bridge.
    function defeatFraudChallenge(
        bytes calldata walletPublicKey,
        bytes calldata preimage,
        bool witness
    ) external {
        self.defeatFraudChallenge(walletPublicKey, preimage, witness);
    }

    /// @notice Allows to defeat a pending fraud challenge against a wallet by
    ///         proving the sighash and signature were produced for an off-chain
    ///         wallet heartbeat message following a strict format.
    ///         In order to defeat the challenge the same `walletPublicKey` and
    ///         signature (represented by `r`, `s` and `v`) must be provided as
    ///         were used to calculate the sighash during heartbeat message
    ///         signing. The fraud challenge defeat attempt will only succeed if
    ///         the signed message follows a strict format required for
    ///         heartbeat messages. If successfully defeated, the fraud
    ///         challenge is marked as resolved and the amount of ether
    ///         deposited by the challenger is sent to the treasury.
    /// @param walletPublicKey The public key of the wallet in the uncompressed
    ///        and unprefixed format (64 bytes).
    /// @param heartbeatMessage Off-chain heartbeat message meeting the heartbeat
    ///        message format requirements which produces sighash used to
    ///        generate the ECDSA signature that is the subject of the fraud
    ///        claim.
    /// @dev Requirements:
    ///      - `walletPublicKey` and `sighash` calculated as
    ///        `hash256(heartbeatMessage)` must identify an open fraud challenge,
    ///      - `heartbeatMessage` must follow a strict format of heartbeat
    ///        messages.
    function defeatFraudChallengeWithHeartbeat(
        bytes calldata walletPublicKey,
        bytes calldata heartbeatMessage
    ) external {
        self.defeatFraudChallengeWithHeartbeat(
            walletPublicKey,
            heartbeatMessage
        );
    }

    /// @notice Notifies about defeat timeout for the given fraud challenge.
    ///         Can be called only if there was a fraud challenge identified by
    ///         the provided `walletPublicKey` and `sighash` and it was not
    ///         defeated on time. The amount of time that needs to pass after
    ///         a fraud challenge is reported is indicated by the
    ///         `challengeDefeatTimeout`. After a successful fraud challenge
    ///         defeat timeout notification the fraud challenge is marked as
    ///         resolved, the stake of each operator is slashed, the ether
    ///         deposited is returned to the challenger and the challenger is
    ///         rewarded.
    /// @param walletPublicKey The public key of the wallet in the uncompressed
    ///        and unprefixed format (64 bytes).
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @param preimageSha256 The hash that was generated by applying SHA-256
    ///        one time over the preimage used during input signing. The preimage
    ///        is a serialized subset of the transaction and its structure
    ///        depends on the transaction input (see BIP-143 for reference).
    ///        Notice that applying SHA-256 over the `preimageSha256` results
    ///        in `sighash`.  The path from `preimage` to `sighash` looks like
    ///        this:
    ///        preimage -> (SHA-256) -> preimageSha256 -> (SHA-256) -> sighash.
    /// @dev Requirements:
    ///      - The wallet must be in the Live or MovingFunds or Closing or
    ///        Terminated state,
    ///      - The `walletPublicKey` and `sighash` calculated from
    ///        `preimageSha256` must identify an open fraud challenge,
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given `walletID`. Those IDs are not directly stored
    ///        in the contract for gas efficiency purposes but they can be
    ///        read from appropriate `DkgResultSubmitted` and `DkgResultApproved`
    ///        events of the `WalletRegistry` contract,
    ///      - The amount of time indicated by `challengeDefeatTimeout` must pass
    ///        after the challenge was reported.
    function notifyFraudChallengeDefeatTimeout(
        bytes calldata walletPublicKey,
        uint32[] calldata walletMembersIDs,
        bytes memory preimageSha256
    ) external {
        self.notifyFraudChallengeDefeatTimeout(
            walletPublicKey,
            walletMembersIDs,
            preimageSha256
        );
    }

    /// @notice Allows the Governance to mark the given vault address as trusted
    ///         or no longer trusted. Vaults are not trusted by default.
    ///         Trusted vault must meet the following criteria:
    ///         - `IVault.receiveBalanceIncrease` must have a known, low gas
    ///           cost,
    ///         - `IVault.receiveBalanceIncrease` must never revert.
    /// @dev Without restricting reveal only to trusted vaults, malicious
    ///      vaults not meeting the criteria would be able to nuke sweep proof
    ///      transactions executed by ECDSA wallet with  deposits routed to
    ///      them.
    /// @param vault The address of the vault.
    /// @param isTrusted flag indicating whether the vault is trusted or not.
    /// @dev Can only be called by the Governance.
    function setVaultStatus(address vault, bool isTrusted)
        external
        onlyGovernance
    {
        self.isVaultTrusted[vault] = isTrusted;
        emit VaultStatusUpdated(vault, isTrusted);
    }

    /// @notice Allows the Governance to mark the given address as trusted
    ///         or no longer trusted SPV maintainer. Addresses are not trusted
    ///         as SPV maintainers by default.
    /// @dev The SPV proof does not check whether the transaction is a part of
    ///      the Bitcoin mainnet, it only checks whether the transaction has been
    ///      mined performing the required amount of work as on Bitcoin mainnet.
    ///      The possibility of submitting SPV proofs is limited to trusted SPV
    ///      maintainers. The system expects transaction confirmations with the
    ///      required work accumulated, so trusted SPV maintainers can not prove
    ///      the transaction without providing the required Bitcoin proof of work.
    ///      Trusted maintainers address the issue of an economic game between
    ///      tBTC and Bitcoin mainnet where large Bitcoin mining pools can decide
    ///      to use their hash power to mine fake Bitcoin blocks to prove them in
    ///      tBTC instead of receiving Bitcoin miner rewards.
    /// @param spvMaintainer The address of the SPV maintainer.
    /// @param isTrusted flag indicating whether the address is trusted or not.
    /// @dev Can only be called by the Governance.
    function setSpvMaintainerStatus(address spvMaintainer, bool isTrusted)
        external
        onlyGovernance
    {
        self.isSpvMaintainer[spvMaintainer] = isTrusted;
        emit SpvMaintainerStatusUpdated(spvMaintainer, isTrusted);
    }

    /// @notice Updates parameters of deposits.
    /// @param depositDustThreshold New value of the deposit dust threshold in
    ///        satoshis. It is the minimal amount that can be requested to
    ////       deposit. Value of this parameter must take into account the value
    ///        of `depositTreasuryFeeDivisor` and `depositTxMaxFee` parameters
    ///        in order to make requests that can incur the treasury and
    ///        transaction fee and still satisfy the depositor.
    /// @param depositTreasuryFeeDivisor New value of the treasury fee divisor.
    ///        It is the divisor used to compute the treasury fee taken from
    ///        each deposit and transferred to the treasury upon sweep proof
    ///        submission. That fee is computed as follows:
    ///        `treasuryFee = depositedAmount / depositTreasuryFeeDivisor`
    ///        For example, if the treasury fee needs to be 2% of each deposit,
    ///        the `depositTreasuryFeeDivisor` should be set to `50`
    ///        because `1/50 = 0.02 = 2%`.
    /// @param depositTxMaxFee New value of the deposit tx max fee in satoshis.
    ///        It is the maximum amount of BTC transaction fee that can
    ///        be incurred by each swept deposit being part of the given sweep
    ///        transaction. If the maximum BTC transaction fee is exceeded,
    ///        such transaction is considered a fraud.
    /// @param depositRevealAheadPeriod New value of the deposit reveal ahead
    ///        period parameter in seconds. It defines the length of the period
    ///        that must be preserved between the deposit reveal time and the
    ///        deposit refund locktime.
    /// @dev Requirements:
    ///      - Deposit dust threshold must be greater than zero,
    ///      - Deposit dust threshold must be greater than deposit TX max fee,
    ///      - Deposit transaction max fee must be greater than zero.
    function updateDepositParameters(
        uint64 depositDustThreshold,
        uint64 depositTreasuryFeeDivisor,
        uint64 depositTxMaxFee,
        uint32 depositRevealAheadPeriod
    ) external onlyGovernance {
        self.updateDepositParameters(
            depositDustThreshold,
            depositTreasuryFeeDivisor,
            depositTxMaxFee,
            depositRevealAheadPeriod
        );
    }

    /// @notice Updates parameters of redemptions.
    /// @param redemptionDustThreshold New value of the redemption dust
    ///        threshold in satoshis. It is the minimal amount that can be
    ///        requested for redemption. Value of this parameter must take into
    ///        account the value of `redemptionTreasuryFeeDivisor` and
    ///        `redemptionTxMaxFee` parameters in order to make requests that
    ///        can incur the treasury and transaction fee and still satisfy the
    ///        redeemer.
    /// @param redemptionTreasuryFeeDivisor New value of the redemption
    ///        treasury fee divisor. It is the divisor used to compute the
    ///        treasury fee taken from each redemption request and transferred
    ///        to the treasury upon successful request finalization. That fee is
    ///        computed as follows:
    ///        `treasuryFee = requestedAmount / redemptionTreasuryFeeDivisor`
    ///        For example, if the treasury fee needs to be 2% of each
    ///        redemption request, the `redemptionTreasuryFeeDivisor` should
    ///        be set to `50` because `1/50 = 0.02 = 2%`.
    /// @param redemptionTxMaxFee New value of the redemption transaction max
    ///        fee in satoshis. It is the maximum amount of BTC transaction fee
    ///        that can be incurred by each redemption request being part of the
    ///        given redemption transaction. If the maximum BTC transaction fee
    ///        is exceeded, such transaction is considered a fraud.
    ///        This is a per-redemption output max fee for the redemption
    ///        transaction.
    /// @param redemptionTxMaxTotalFee New value of the redemption transaction
    ///        max total fee in satoshis. It is the maximum amount of the total
    ///        BTC transaction fee that is acceptable in a single redemption
    ///        transaction. This is a _total_ max fee for the entire redemption
    ///        transaction.
    /// @param redemptionTimeout New value of the redemption timeout in seconds.
    ///        It is the time after which the redemption request can be reported
    ///        as timed out. It is counted from the moment when the redemption
    ///        request was created via `requestRedemption` call. Reported  timed
    ///        out requests are cancelled and locked balance is returned to the
    ///        redeemer in full amount.
    /// @param redemptionTimeoutSlashingAmount New value of the redemption
    ///        timeout slashing amount in T, it is the amount slashed from each
    ///        wallet member for redemption timeout.
    /// @param redemptionTimeoutNotifierRewardMultiplier New value of the
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
        uint64 redemptionDustThreshold,
        uint64 redemptionTreasuryFeeDivisor,
        uint64 redemptionTxMaxFee,
        uint64 redemptionTxMaxTotalFee,
        uint32 redemptionTimeout,
        uint96 redemptionTimeoutSlashingAmount,
        uint32 redemptionTimeoutNotifierRewardMultiplier
    ) external onlyGovernance {
        self.updateRedemptionParameters(
            redemptionDustThreshold,
            redemptionTreasuryFeeDivisor,
            redemptionTxMaxFee,
            redemptionTxMaxTotalFee,
            redemptionTimeout,
            redemptionTimeoutSlashingAmount,
            redemptionTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Updates parameters of moving funds.
    /// @param movingFundsTxMaxTotalFee New value of the moving funds transaction
    ///        max total fee in satoshis. It is the maximum amount of the total
    ///        BTC transaction fee that is acceptable in a single moving funds
    ///        transaction. This is a _total_ max fee for the entire moving
    ///        funds transaction.
    /// @param movingFundsDustThreshold New value of the moving funds dust
    ///        threshold. It is the minimal satoshi amount that makes sense to
    ///        be transferred during the moving funds process. Moving funds
    ///        wallets having their BTC balance below that value can begin
    ///        closing immediately as transferring such a low value may not be
    ///        possible due to BTC network fees.
    /// @param movingFundsTimeoutResetDelay New value of the moving funds
    ///        timeout reset delay in seconds. It is the time after which the
    ///        moving funds timeout can be reset in case the target wallet
    ///        commitment cannot be submitted due to a lack of live wallets
    ///        in the system. It is counted from the moment when the wallet
    ///        was requested to move their funds and switched to the MovingFunds
    ///        state or from the moment the timeout was reset the last time.
    /// @param movingFundsTimeout New value of the moving funds timeout in
    ///        seconds. It is the time after which the moving funds process can
    ///        be reported as timed out. It is counted from the moment when the
    ///        wallet was requested to move their funds and switched to the
    ///        MovingFunds state.
    /// @param movingFundsTimeoutSlashingAmount New value of the moving funds
    ///        timeout slashing amount in T, it is the amount slashed from each
    ///        wallet member for moving funds timeout.
    /// @param movingFundsTimeoutNotifierRewardMultiplier New value of the
    ///        moving funds timeout notifier reward multiplier as percentage,
    ///        it determines the percentage of the notifier reward from the
    ///        staking contact the notifier of a moving funds timeout receives.
    ///        The value must be in the range [0, 100].
    /// @param movingFundsCommitmentGasOffset New value of the gas offset for
    ///        moving funds target wallet commitment transaction gas costs
    ///        reimbursement.
    /// @param movedFundsSweepTxMaxTotalFee New value of the moved funds sweep
    ///        transaction max total fee in satoshis. It is the maximum amount
    ///        of the total BTC transaction fee that is acceptable in a single
    ///        moved funds sweep transaction. This is a _total_ max fee for the
    ///        entire moved funds sweep transaction.
    /// @param movedFundsSweepTimeout New value of the moved funds sweep
    ///        timeout in seconds. It is the time after which the moved funds
    ///        sweep process can be reported as timed out. It is counted from
    ///        the moment when the wallet was requested to sweep the received
    ///        funds.
    /// @param movedFundsSweepTimeoutSlashingAmount New value of the moved
    ///        funds sweep timeout slashing amount in T, it is the amount
    ///        slashed from each wallet member for moved funds sweep timeout.
    /// @param movedFundsSweepTimeoutNotifierRewardMultiplier New value of
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
    ///      - Moving funds timeout notifier reward multiplier must be in the
    ///        range [0, 100],
    ///      - Moved funds sweep transaction max total fee must be greater than zero,
    ///      - Moved funds sweep timeout must be greater than zero,
    ///      - Moved funds sweep timeout notifier reward multiplier must be in the
    ///        range [0, 100].
    function updateMovingFundsParameters(
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
    ) external onlyGovernance {
        self.updateMovingFundsParameters(
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

    /// @notice Updates parameters of wallets.
    /// @param walletCreationPeriod New value of the wallet creation period in
    ///        seconds, determines how frequently a new wallet creation can be
    ///        requested.
    /// @param walletCreationMinBtcBalance New value of the wallet minimum BTC
    ///        balance in satoshi, used to decide about wallet creation.
    /// @param walletCreationMaxBtcBalance New value of the wallet maximum BTC
    ///        balance in satoshi, used to decide about wallet creation.
    /// @param walletClosureMinBtcBalance New value of the wallet minimum BTC
    ///        balance in satoshi, used to decide about wallet closure.
    /// @param walletMaxAge New value of the wallet maximum age in seconds,
    ///        indicates the maximum age of a wallet in seconds, after which
    ///        the wallet moving funds process can be requested.
    /// @param walletMaxBtcTransfer New value of the wallet maximum BTC transfer
    ///        in satoshi, determines the maximum amount that can be transferred
    //         to a single target wallet during the moving funds process.
    /// @param walletClosingPeriod New value of the wallet closing period in
    ///        seconds, determines the length of the wallet closing period,
    //         i.e. the period when the wallet remains in the Closing state
    //         and can be subject of deposit fraud challenges.
    /// @dev Requirements:
    ///      - Wallet maximum BTC balance must be greater than the wallet
    ///        minimum BTC balance,
    ///      - Wallet maximum BTC transfer must be greater than zero,
    ///      - Wallet closing period must be greater than zero.
    function updateWalletParameters(
        uint32 walletCreationPeriod,
        uint64 walletCreationMinBtcBalance,
        uint64 walletCreationMaxBtcBalance,
        uint64 walletClosureMinBtcBalance,
        uint32 walletMaxAge,
        uint64 walletMaxBtcTransfer,
        uint32 walletClosingPeriod
    ) external onlyGovernance {
        self.updateWalletParameters(
            walletCreationPeriod,
            walletCreationMinBtcBalance,
            walletCreationMaxBtcBalance,
            walletClosureMinBtcBalance,
            walletMaxAge,
            walletMaxBtcTransfer,
            walletClosingPeriod
        );
    }

    /// @notice Updates parameters related to frauds.
    /// @param fraudChallengeDepositAmount New value of the fraud challenge
    ///        deposit amount in wei, it is the amount of ETH the party
    ///        challenging the wallet for fraud needs to deposit.
    /// @param fraudChallengeDefeatTimeout New value of the challenge defeat
    ///        timeout in seconds, it is the amount of time the wallet has to
    ///        defeat a fraud challenge. The value must be greater than zero.
    /// @param fraudSlashingAmount New value of the fraud slashing amount in T,
    ///        it is the amount slashed from each wallet member for committing
    ///        a fraud.
    /// @param fraudNotifierRewardMultiplier New value of the fraud notifier
    ///        reward multiplier as percentage, it determines the percentage of
    ///        the notifier reward from the staking contact the notifier of
    ///        a fraud receives. The value must be in the range [0, 100].
    /// @dev Requirements:
    ///      - Fraud challenge defeat timeout must be greater than 0,
    ///      - Fraud notifier reward multiplier must be in the range [0, 100].
    function updateFraudParameters(
        uint96 fraudChallengeDepositAmount,
        uint32 fraudChallengeDefeatTimeout,
        uint96 fraudSlashingAmount,
        uint32 fraudNotifierRewardMultiplier
    ) external onlyGovernance {
        self.updateFraudParameters(
            fraudChallengeDepositAmount,
            fraudChallengeDefeatTimeout,
            fraudSlashingAmount,
            fraudNotifierRewardMultiplier
        );
    }

    /// @notice Updates treasury address. The treasury receives the system fees.
    /// @param treasury New value of the treasury address.
    /// @dev The treasury address must not be 0x0.
    // slither-disable-next-line shadowing-local
    function updateTreasury(address treasury) external onlyGovernance {
        self.updateTreasury(treasury);
    }

    /// @notice Collection of all revealed deposits indexed by
    ///         keccak256(fundingTxHash | fundingOutputIndex).
    ///         The fundingTxHash is bytes32 (ordered as in Bitcoin internally)
    ///         and fundingOutputIndex an uint32. This mapping may contain valid
    ///         and invalid deposits and the wallet is responsible for
    ///         validating them before attempting to execute a sweep.
    function deposits(uint256 depositKey)
        external
        view
        returns (Deposit.DepositRequest memory)
    {
        return self.deposits[depositKey];
    }

    /// @notice Collection of all pending redemption requests indexed by
    ///         redemption key built as
    ///         `keccak256(keccak256(redeemerOutputScript) | walletPubKeyHash)`.
    ///         The walletPubKeyHash is the 20-byte wallet's public key hash
    ///         (computed using Bitcoin HASH160 over the compressed ECDSA
    ///         public key) and `redeemerOutputScript` is a Bitcoin script
    ///         (P2PKH, P2WPKH, P2SH or P2WSH) that will be used to lock
    ///         redeemed BTC as requested by the redeemer. Requests are added
    ///         to this mapping by the `requestRedemption` method (duplicates
    ///         not allowed) and are removed by one of the following methods:
    ///         - `submitRedemptionProof` in case the request was handled
    ///           successfully,
    ///         - `notifyRedemptionTimeout` in case the request was reported
    ///           to be timed out.
    function pendingRedemptions(uint256 redemptionKey)
        external
        view
        returns (Redemption.RedemptionRequest memory)
    {
        return self.pendingRedemptions[redemptionKey];
    }

    /// @notice Collection of all timed out redemptions requests indexed by
    ///         redemption key built as
    ///         `keccak256(keccak256(redeemerOutputScript) | walletPubKeyHash)`.
    ///         The walletPubKeyHash is the 20-byte wallet's public key hash
    ///         (computed using Bitcoin HASH160 over the compressed ECDSA
    ///         public key) and `redeemerOutputScript` is the Bitcoin script
    ///         (P2PKH, P2WPKH, P2SH or P2WSH) that is involved in the timed
    ///         out request.
    ///         Only one method can add to this mapping:
    ///         - `notifyRedemptionTimeout` which puts the redemption key
    ///           to this mapping based on a timed out request stored
    ///           previously in `pendingRedemptions` mapping.
    ///         Only one method can remove entries from this mapping:
    ///         - `submitRedemptionProof` in case the timed out redemption
    ///           request was a part of the proven transaction.
    function timedOutRedemptions(uint256 redemptionKey)
        external
        view
        returns (Redemption.RedemptionRequest memory)
    {
        return self.timedOutRedemptions[redemptionKey];
    }

    /// @notice Collection of main UTXOs that are honestly spent indexed by
    ///         keccak256(fundingTxHash | fundingOutputIndex). The fundingTxHash
    ///         is bytes32 (ordered as in Bitcoin internally) and
    ///         fundingOutputIndex an uint32. A main UTXO is considered honestly
    ///         spent if it was used as an input of a transaction that have been
    ///         proven in the Bridge.
    function spentMainUTXOs(uint256 utxoKey) external view returns (bool) {
        return self.spentMainUTXOs[utxoKey];
    }

    /// @notice Gets details about a registered wallet.
    /// @param walletPubKeyHash The 20-byte wallet public key hash (computed
    ///        using Bitcoin HASH160 over the compressed ECDSA public key).
    /// @return Wallet details.
    function wallets(bytes20 walletPubKeyHash)
        external
        view
        returns (Wallets.Wallet memory)
    {
        return self.registeredWallets[walletPubKeyHash];
    }

    /// @notice Gets the public key hash of the active wallet.
    /// @return The 20-byte public key hash (computed using Bitcoin HASH160
    ///         over the compressed ECDSA public key) of the active wallet.
    ///         Returns bytes20(0) if there is no active wallet at the moment.
    function activeWalletPubKeyHash() external view returns (bytes20) {
        return self.activeWalletPubKeyHash;
    }

    /// @notice Gets the live wallets count.
    /// @return The current count of wallets being in the Live state.
    function liveWalletsCount() external view returns (uint32) {
        return self.liveWalletsCount;
    }

    /// @notice Returns the fraud challenge identified by the given key built
    ///         as keccak256(walletPublicKey|sighash).
    function fraudChallenges(uint256 challengeKey)
        external
        view
        returns (Fraud.FraudChallenge memory)
    {
        return self.fraudChallenges[challengeKey];
    }

    /// @notice Collection of all moved funds sweep requests indexed by
    ///         `keccak256(movingFundsTxHash | movingFundsOutputIndex)`.
    ///         The `movingFundsTxHash` is `bytes32` (ordered as in Bitcoin
    ///         internally) and `movingFundsOutputIndex` an `uint32`. Each entry
    ///         is actually an UTXO representing the moved funds and is supposed
    ///         to be swept with the current main UTXO of the recipient wallet.
    /// @param requestKey Request key built as
    ///        `keccak256(movingFundsTxHash | movingFundsOutputIndex)`.
    /// @return Details of the moved funds sweep request.
    function movedFundsSweepRequests(uint256 requestKey)
        external
        view
        returns (MovingFunds.MovedFundsSweepRequest memory)
    {
        return self.movedFundsSweepRequests[requestKey];
    }

    /// @notice Indicates if the vault with the given address is trusted or not.
    ///         Depositors can route their revealed deposits only to trusted
    ///         vaults and have trusted vaults notified about new deposits as
    ///         soon as these deposits get swept. Vaults not trusted by the
    ///         Bridge can still be used by Bank balance owners on their own
    ///         responsibility - anyone can approve their Bank balance to any
    ///         address.
    function isVaultTrusted(address vault) external view returns (bool) {
        return self.isVaultTrusted[vault];
    }

    /// @notice Returns the current values of Bridge deposit parameters.
    /// @return depositDustThreshold The minimal amount that can be requested
    ///         to deposit. Value of this parameter must take into account the
    ///         value of `depositTreasuryFeeDivisor` and `depositTxMaxFee`
    ///         parameters in order to make requests that can incur the
    ///         treasury and transaction fee and still satisfy the depositor.
    /// @return depositTreasuryFeeDivisor Divisor used to compute the treasury
    ///         fee taken from each deposit and transferred to the treasury upon
    ///         sweep proof submission. That fee is computed as follows:
    ///         `treasuryFee = depositedAmount / depositTreasuryFeeDivisor`
    ///         For example, if the treasury fee needs to be 2% of each deposit,
    ///         the `depositTreasuryFeeDivisor` should be set to `50`
    ///         because `1/50 = 0.02 = 2%`.
    /// @return depositTxMaxFee Maximum amount of BTC transaction fee that can
    ///         be incurred by each swept deposit being part of the given sweep
    ///         transaction. If the maximum BTC transaction fee is exceeded,
    ///         such transaction is considered a fraud.
    /// @return depositRevealAheadPeriod Defines the length of the period that
    ///         must be preserved between the deposit reveal time and the
    ///         deposit refund locktime. For example, if the deposit become
    ///         refundable on August 1st, and the ahead period is 7 days, the
    ///         latest moment for deposit reveal is July 25th. Value in seconds.
    function depositParameters()
        external
        view
        returns (
            uint64 depositDustThreshold,
            uint64 depositTreasuryFeeDivisor,
            uint64 depositTxMaxFee,
            uint32 depositRevealAheadPeriod
        )
    {
        depositDustThreshold = self.depositDustThreshold;
        depositTreasuryFeeDivisor = self.depositTreasuryFeeDivisor;
        depositTxMaxFee = self.depositTxMaxFee;
        depositRevealAheadPeriod = self.depositRevealAheadPeriod;
    }

    /// @notice Returns the current values of Bridge redemption parameters.
    /// @return redemptionDustThreshold The minimal amount that can be requested
    ///         for redemption. Value of this parameter must take into account
    ///         the value of `redemptionTreasuryFeeDivisor` and `redemptionTxMaxFee`
    ///         parameters in order to make requests that can incur the
    ///         treasury and transaction fee and still satisfy the redeemer.
    /// @return redemptionTreasuryFeeDivisor Divisor used to compute the treasury
    ///         fee taken from each redemption request and transferred to the
    ///         treasury upon successful request finalization. That fee is
    ///         computed as follows:
    ///         `treasuryFee = requestedAmount / redemptionTreasuryFeeDivisor`
    ///         For example, if the treasury fee needs to be 2% of each
    ///         redemption request, the `redemptionTreasuryFeeDivisor` should
    ///         be set to `50` because `1/50 = 0.02 = 2%`.
    /// @return redemptionTxMaxFee Maximum amount of BTC transaction fee that
    ///         can be incurred by each redemption request being part of the
    ///         given redemption transaction. If the maximum BTC transaction
    ///         fee is exceeded, such transaction is considered a fraud.
    ///         This is a per-redemption output max fee for the redemption
    ///         transaction.
    /// @return redemptionTxMaxTotalFee Maximum amount of the total BTC
    ///         transaction fee that is acceptable in a single redemption
    ///         transaction. This is a _total_ max fee for the entire redemption
    ///         transaction.
    /// @return redemptionTimeout Time after which the redemption request can be
    ///         reported as timed out. It is counted from the moment when the
    ///         redemption request was created via `requestRedemption` call.
    ///         Reported  timed out requests are cancelled and locked balance is
    ///         returned to the redeemer in full amount.
    /// @return redemptionTimeoutSlashingAmount The amount of stake slashed
    ///         from each member of a wallet for a redemption timeout.
    /// @return redemptionTimeoutNotifierRewardMultiplier The percentage of the
    ///         notifier reward from the staking contract the notifier of a
    ///         redemption timeout receives. The value is in the range [0, 100].
    function redemptionParameters()
        external
        view
        returns (
            uint64 redemptionDustThreshold,
            uint64 redemptionTreasuryFeeDivisor,
            uint64 redemptionTxMaxFee,
            uint64 redemptionTxMaxTotalFee,
            uint32 redemptionTimeout,
            uint96 redemptionTimeoutSlashingAmount,
            uint32 redemptionTimeoutNotifierRewardMultiplier
        )
    {
        redemptionDustThreshold = self.redemptionDustThreshold;
        redemptionTreasuryFeeDivisor = self.redemptionTreasuryFeeDivisor;
        redemptionTxMaxFee = self.redemptionTxMaxFee;
        redemptionTxMaxTotalFee = self.redemptionTxMaxTotalFee;
        redemptionTimeout = self.redemptionTimeout;
        redemptionTimeoutSlashingAmount = self.redemptionTimeoutSlashingAmount;
        redemptionTimeoutNotifierRewardMultiplier = self
            .redemptionTimeoutNotifierRewardMultiplier;
    }

    /// @notice Returns the current values of Bridge moving funds between
    ///         wallets parameters.
    /// @return movingFundsTxMaxTotalFee Maximum amount of the total BTC
    ///         transaction fee that is acceptable in a single moving funds
    ///         transaction. This is a _total_ max fee for the entire moving
    ///         funds transaction.
    /// @return movingFundsDustThreshold The minimal satoshi amount that makes
    ///         sense to be transferred during the moving funds process. Moving
    ///         funds wallets having their BTC balance below that value can
    ///         begin closing immediately as transferring such a low value may
    ///         not be possible due to BTC network fees.
    /// @return movingFundsTimeoutResetDelay Time after which the moving funds
    ///         timeout can be reset in case the target wallet commitment
    ///         cannot be submitted due to a lack of live wallets in the system.
    ///         It is counted from the moment when the wallet was requested to
    ///         move their funds and switched to the MovingFunds state or from
    ///         the moment the timeout was reset the last time. Value in seconds
    ///         This value should be lower than the value of the
    ///         `movingFundsTimeout`.
    /// @return movingFundsTimeout Time after which the moving funds process
    ///         can be reported as timed out. It is counted from the moment
    ///         when the wallet was requested to move their funds and switched
    ///         to the MovingFunds state. Value in seconds.
    /// @return movingFundsTimeoutSlashingAmount The amount of stake slashed
    ///         from each member of a wallet for a moving funds timeout.
    /// @return movingFundsTimeoutNotifierRewardMultiplier The percentage of the
    ///         notifier reward from the staking contract the notifier of a
    ///         moving funds timeout receives. The value is in the range [0, 100].
    /// @return movingFundsCommitmentGasOffset The gas offset used for the
    ///         moving funds target wallet commitment transaction cost
    ///         reimbursement.
    /// @return movedFundsSweepTxMaxTotalFee Maximum amount of the total BTC
    ///         transaction fee that is acceptable in a single moved funds
    ///         sweep transaction. This is a _total_ max fee for the entire
    ///         moved funds sweep transaction.
    /// @return movedFundsSweepTimeout Time after which the moved funds sweep
    ///         process can be reported as timed out. It is counted from the
    ///         moment when the wallet was requested to sweep the received funds.
    ///         Value in seconds.
    /// @return movedFundsSweepTimeoutSlashingAmount The amount of stake slashed
    ///         from each member of a wallet for a moved funds sweep timeout.
    /// @return movedFundsSweepTimeoutNotifierRewardMultiplier The percentage
    ///         of the notifier reward from the staking contract the notifier
    ///         of a moved funds sweep timeout receives. The value is in the
    ///         range [0, 100].
    function movingFundsParameters()
        external
        view
        returns (
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
        )
    {
        movingFundsTxMaxTotalFee = self.movingFundsTxMaxTotalFee;
        movingFundsDustThreshold = self.movingFundsDustThreshold;
        movingFundsTimeoutResetDelay = self.movingFundsTimeoutResetDelay;
        movingFundsTimeout = self.movingFundsTimeout;
        movingFundsTimeoutSlashingAmount = self
            .movingFundsTimeoutSlashingAmount;
        movingFundsTimeoutNotifierRewardMultiplier = self
            .movingFundsTimeoutNotifierRewardMultiplier;
        movingFundsCommitmentGasOffset = self.movingFundsCommitmentGasOffset;
        movedFundsSweepTxMaxTotalFee = self.movedFundsSweepTxMaxTotalFee;
        movedFundsSweepTimeout = self.movedFundsSweepTimeout;
        movedFundsSweepTimeoutSlashingAmount = self
            .movedFundsSweepTimeoutSlashingAmount;
        movedFundsSweepTimeoutNotifierRewardMultiplier = self
            .movedFundsSweepTimeoutNotifierRewardMultiplier;
    }

    /// @return walletCreationPeriod Determines how frequently a new wallet
    ///         creation can be requested. Value in seconds.
    /// @return walletCreationMinBtcBalance The minimum BTC threshold in satoshi
    ///         that is used to decide about wallet creation.
    /// @return walletCreationMaxBtcBalance The maximum BTC threshold in satoshi
    ///         that is used to decide about wallet creation.
    /// @return walletClosureMinBtcBalance The minimum BTC threshold in satoshi
    ///         that is used to decide about wallet closure.
    /// @return walletMaxAge The maximum age of a wallet in seconds, after which
    ///         the wallet moving funds process can be requested.
    /// @return walletMaxBtcTransfer The maximum BTC amount in satoshi than
    ///         can be transferred to a single target wallet during the moving
    ///         funds process.
    /// @return walletClosingPeriod Determines the length of the wallet closing
    ///         period, i.e. the period when the wallet remains in the Closing
    ///         state and can be subject of deposit fraud challenges. Value
    ///         in seconds.
    function walletParameters()
        external
        view
        returns (
            uint32 walletCreationPeriod,
            uint64 walletCreationMinBtcBalance,
            uint64 walletCreationMaxBtcBalance,
            uint64 walletClosureMinBtcBalance,
            uint32 walletMaxAge,
            uint64 walletMaxBtcTransfer,
            uint32 walletClosingPeriod
        )
    {
        walletCreationPeriod = self.walletCreationPeriod;
        walletCreationMinBtcBalance = self.walletCreationMinBtcBalance;
        walletCreationMaxBtcBalance = self.walletCreationMaxBtcBalance;
        walletClosureMinBtcBalance = self.walletClosureMinBtcBalance;
        walletMaxAge = self.walletMaxAge;
        walletMaxBtcTransfer = self.walletMaxBtcTransfer;
        walletClosingPeriod = self.walletClosingPeriod;
    }

    /// @notice Returns the current values of Bridge fraud parameters.
    /// @return fraudChallengeDepositAmount The amount of ETH in wei the party
    ///         challenging the wallet for fraud needs to deposit.
    /// @return fraudChallengeDefeatTimeout The amount of time the wallet has to
    ///         defeat a fraud challenge.
    /// @return fraudSlashingAmount The amount slashed from each wallet member
    ///         for committing a fraud.
    /// @return fraudNotifierRewardMultiplier The percentage of the notifier
    ///         reward from the staking contract the notifier of a fraud
    ///         receives. The value is in the range [0, 100].
    function fraudParameters()
        external
        view
        returns (
            uint96 fraudChallengeDepositAmount,
            uint32 fraudChallengeDefeatTimeout,
            uint96 fraudSlashingAmount,
            uint32 fraudNotifierRewardMultiplier
        )
    {
        fraudChallengeDepositAmount = self.fraudChallengeDepositAmount;
        fraudChallengeDefeatTimeout = self.fraudChallengeDefeatTimeout;
        fraudSlashingAmount = self.fraudSlashingAmount;
        fraudNotifierRewardMultiplier = self.fraudNotifierRewardMultiplier;
    }

    /// @notice Returns the addresses of contracts Bridge is interacting with.
    /// @return bank Address of the Bank the Bridge belongs to.
    /// @return relay Address of the Bitcoin relay providing the current Bitcoin
    ///         network difficulty.
    /// @return ecdsaWalletRegistry Address of the ECDSA Wallet Registry.
    /// @return reimbursementPool Address of the Reimbursement Pool.
    function contractReferences()
        external
        view
        returns (
            Bank bank,
            IRelay relay,
            EcdsaWalletRegistry ecdsaWalletRegistry,
            ReimbursementPool reimbursementPool
        )
    {
        bank = self.bank;
        relay = self.relay;
        ecdsaWalletRegistry = self.ecdsaWalletRegistry;
        reimbursementPool = self.reimbursementPool;
    }

    /// @notice Address where the deposit treasury fees will be sent to.
    ///         Treasury takes part in the operators rewarding process.
    function treasury() external view returns (address) {
        return self.treasury;
    }

    /// @notice The number of confirmations on the Bitcoin chain required to
    ///         successfully evaluate an SPV proof.
    function txProofDifficultyFactor() external view returns (uint256) {
        return self.txProofDifficultyFactor;
    }

    /// @notice Sets the redemption watchtower address.
    /// @param redemptionWatchtower Address of the redemption watchtower.
    /// @dev Requirements:
    ///      - The caller must be the governance,
    ///      - Redemption watchtower address must not be already set,
    ///      - Redemption watchtower address must not be 0x0.
    function setRedemptionWatchtower(address redemptionWatchtower)
        external
        onlyGovernance
    {
        // The internal function is defined in the `BridgeState` library.
        self.setRedemptionWatchtower(redemptionWatchtower);
    }

    /// @return Address of the redemption watchtower.
    function getRedemptionWatchtower() external view returns (address) {
        return self.redemptionWatchtower;
    }

    /// @notice Sets the rebate staking address.
    /// @param rebateStaking Address of the rebate staking.
    /// @dev Requirements:
    ///      - Rebate staking address must not be already set,
    ///      - Rebate staking address must not be 0x0.
    function setRebateStaking(address rebateStaking)
        external
        onlyGovernance
    {
        // The internal function is defined in the `BridgeState` library.
        self.setRebateStaking(rebateStaking);
    }

    /// @return Address of the rebate staking.
    function getRebateStaking() external view returns (RebateStaking) {
        return self.rebateStaking;
    }

    /// @notice Notifies that a redemption request was vetoed in the watchtower.
    ///         This function is responsible for adjusting the Bridge's state
    ///         accordingly.
    ///         The results of calling this function:
    ///         - the pending redemptions value for the wallet is decreased
    ///           by the requested amount (minus treasury fee),
    ///         - the request is removed from pending redemptions mapping,
    ///         - the tokens taken from the redeemer on redemption request are
    ///           detained and passed to the redemption watchtower
    ///           (as Bank's balance) for further processing.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param redeemerOutputScript  The redeemer's length-prefixed output
    ///        script (P2PKH, P2WPKH, P2SH or P2WSH).
    /// @dev Requirements:
    ///      - The caller must be the redemption watchtower,
    ///      - The redemption request identified by `walletPubKeyHash` and
    ///        `redeemerOutputScript` must exist.
    function notifyRedemptionVeto(
        bytes20 walletPubKeyHash,
        bytes calldata redeemerOutputScript
    ) external {
        // The caller is checked in the internal function.
        self.notifyRedemptionVeto(walletPubKeyHash, redeemerOutputScript);
    }
}
