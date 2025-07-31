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

import "@openzeppelin/contracts/access/Ownable.sol";
import "./BridgeGovernanceParameters.sol";

import "./Bridge.sol";

/// @title Bridge Governance
/// @notice Owns the `Bridge` contract and is responsible for updating
///         its governable parameters in respect to governance delay individual
///         for each parameter. The other responsibility is marking a vault
///         address as trusted or no longer trusted.
contract BridgeGovernance is Ownable {
    using BridgeGovernanceParameters for BridgeGovernanceParameters.DepositData;
    using BridgeGovernanceParameters for BridgeGovernanceParameters.RedemptionData;
    using BridgeGovernanceParameters for BridgeGovernanceParameters.MovingFundsData;
    using BridgeGovernanceParameters for BridgeGovernanceParameters.WalletData;
    using BridgeGovernanceParameters for BridgeGovernanceParameters.FraudData;
    using BridgeGovernanceParameters for BridgeGovernanceParameters.TreasuryData;

    BridgeGovernanceParameters.DepositData internal depositData;
    BridgeGovernanceParameters.RedemptionData internal redemptionData;
    BridgeGovernanceParameters.MovingFundsData internal movingFundsData;
    BridgeGovernanceParameters.WalletData internal walletData;
    BridgeGovernanceParameters.FraudData internal fraudData;
    BridgeGovernanceParameters.TreasuryData internal treasuryData;

    Bridge internal bridge;

    // Array is used to mitigate the problem with the contract size limit.
    // governanceDelays[0] -> governanceDelay
    // governanceDelays[1] -> newGovernanceDelay
    // governanceDelays[2] -> governanceDelayChangeInitiated
    uint256[3] public governanceDelays;

    uint256 public bridgeGovernanceTransferChangeInitiated;
    address internal newBridgeGovernance;

    // We skip emitting event on *Update to go down with the contract size
    // limit. The reason why we leave *Started but not including *Updated is
    // because Bridge governance transferred event can also be read from the
    // Governable bridge contract 'GovernanceTransferred(old, new)'.
    event BridgeGovernanceTransferStarted(
        address newBridgeGovernance,
        uint256 timestamp
    );

    event DepositDustThresholdUpdateStarted(
        uint64 newDepositDustThreshold,
        uint256 timestamp
    );
    event DepositDustThresholdUpdated(uint64 depositDustThreshold);

    event DepositTreasuryFeeDivisorUpdateStarted(
        uint64 depositTreasuryFeeDivisor,
        uint256 timestamp
    );
    event DepositTreasuryFeeDivisorUpdated(uint64 depositTreasuryFeeDivisor);

    event DepositTxMaxFeeUpdateStarted(
        uint64 newDepositTxMaxFee,
        uint256 timestamp
    );
    event DepositTxMaxFeeUpdated(uint64 depositTxMaxFee);

    event DepositRevealAheadPeriodUpdateStarted(
        uint32 newDepositRevealAheadPeriod,
        uint256 timestamp
    );
    event DepositRevealAheadPeriodUpdated(uint32 depositRevealAheadPeriod);

    event RedemptionDustThresholdUpdateStarted(
        uint64 newRedemptionDustThreshold,
        uint256 timestamp
    );
    event RedemptionDustThresholdUpdated(uint64 redemptionDustThreshold);

    event RedemptionTreasuryFeeDivisorUpdateStarted(
        uint64 newRedemptionTreasuryFeeDivisor,
        uint256 timestamp
    );
    event RedemptionTreasuryFeeDivisorUpdated(
        uint64 redemptionTreasuryFeeDivisor
    );

    event RedemptionTxMaxFeeUpdateStarted(
        uint64 newRedemptionTxMaxFee,
        uint256 timestamp
    );
    event RedemptionTxMaxFeeUpdated(uint64 redemptionTxMaxFee);

    event RedemptionTxMaxTotalFeeUpdateStarted(
        uint64 newRedemptionTxMaxTotalFee,
        uint256 timestamp
    );
    event RedemptionTxMaxTotalFeeUpdated(uint64 redemptionTxMaxTotalFee);

    event RedemptionTimeoutUpdateStarted(
        uint32 newRedemptionTimeout,
        uint256 timestamp
    );
    event RedemptionTimeoutUpdated(uint32 redemptionTimeout);

    event RedemptionTimeoutSlashingAmountUpdateStarted(
        uint96 newRedemptionTimeoutSlashingAmount,
        uint256 timestamp
    );
    event RedemptionTimeoutSlashingAmountUpdated(
        uint96 redemptionTimeoutSlashingAmount
    );

    event RedemptionTimeoutNotifierRewardMultiplierUpdateStarted(
        uint32 newRedemptionTimeoutNotifierRewardMultiplier,
        uint256 timestamp
    );
    event RedemptionTimeoutNotifierRewardMultiplierUpdated(
        uint32 redemptionTimeoutNotifierRewardMultiplier
    );

    event MovingFundsTxMaxTotalFeeUpdateStarted(
        uint64 newMovingFundsTxMaxTotalFee,
        uint256 timestamp
    );
    event MovingFundsTxMaxTotalFeeUpdated(uint64 movingFundsTxMaxTotalFee);

    event MovingFundsDustThresholdUpdateStarted(
        uint64 newMovingFundsDustThreshold,
        uint256 timestamp
    );
    event MovingFundsDustThresholdUpdated(uint64 movingFundsDustThreshold);

    event MovingFundsTimeoutResetDelayUpdateStarted(
        uint32 newMovingFundsTimeoutResetDelay,
        uint256 timestamp
    );
    event MovingFundsTimeoutResetDelayUpdated(
        uint32 movingFundsTimeoutResetDelay
    );

    event MovingFundsTimeoutUpdateStarted(
        uint32 newMovingFundsTimeout,
        uint256 timestamp
    );
    event MovingFundsTimeoutUpdated(uint32 movingFundsTimeout);

    event MovingFundsTimeoutSlashingAmountUpdateStarted(
        uint96 newMovingFundsTimeoutSlashingAmount,
        uint256 timestamp
    );
    event MovingFundsTimeoutSlashingAmountUpdated(
        uint96 movingFundsTimeoutSlashingAmount
    );

    event MovingFundsTimeoutNotifierRewardMultiplierUpdateStarted(
        uint32 newMovingFundsTimeoutNotifierRewardMultiplier,
        uint256 timestamp
    );
    event MovingFundsTimeoutNotifierRewardMultiplierUpdated(
        uint32 movingFundsTimeoutNotifierRewardMultiplier
    );

    event MovingFundsCommitmentGasOffsetUpdateStarted(
        uint16 newMovingFundsCommitmentGasOffset,
        uint256 timestamp
    );
    event MovingFundsCommitmentGasOffsetUpdated(
        uint16 movingFundsCommitmentGasOffset
    );

    event MovedFundsSweepTxMaxTotalFeeUpdateStarted(
        uint64 newMovedFundsSweepTxMaxTotalFee,
        uint256 timestamp
    );
    event MovedFundsSweepTxMaxTotalFeeUpdated(
        uint64 movedFundsSweepTxMaxTotalFee
    );

    event MovedFundsSweepTimeoutUpdateStarted(
        uint32 newMovedFundsSweepTimeout,
        uint256 timestamp
    );
    event MovedFundsSweepTimeoutUpdated(uint32 movedFundsSweepTimeout);

    event MovedFundsSweepTimeoutSlashingAmountUpdateStarted(
        uint96 newMovedFundsSweepTimeoutSlashingAmount,
        uint256 timestamp
    );
    event MovedFundsSweepTimeoutSlashingAmountUpdated(
        uint96 movedFundsSweepTimeoutSlashingAmount
    );

    event MovedFundsSweepTimeoutNotifierRewardMultiplierUpdateStarted(
        uint32 newMovedFundsSweepTimeoutNotifierRewardMultiplier,
        uint256 timestamp
    );
    event MovedFundsSweepTimeoutNotifierRewardMultiplierUpdated(
        uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
    );

    event WalletCreationPeriodUpdateStarted(
        uint32 newWalletCreationPeriod,
        uint256 timestamp
    );
    event WalletCreationPeriodUpdated(uint32 walletCreationPeriod);

    event WalletCreationMinBtcBalanceUpdateStarted(
        uint64 newWalletCreationMinBtcBalance,
        uint256 timestamp
    );
    event WalletCreationMinBtcBalanceUpdated(
        uint64 walletCreationMinBtcBalance
    );

    event WalletCreationMaxBtcBalanceUpdateStarted(
        uint64 newWalletCreationMaxBtcBalance,
        uint256 timestamp
    );
    event WalletCreationMaxBtcBalanceUpdated(
        uint64 walletCreationMaxBtcBalance
    );

    event WalletClosureMinBtcBalanceUpdateStarted(
        uint64 newWalletClosureMinBtcBalance,
        uint256 timestamp
    );
    event WalletClosureMinBtcBalanceUpdated(uint64 walletClosureMinBtcBalance);

    event WalletMaxAgeUpdateStarted(uint32 newWalletMaxAge, uint256 timestamp);
    event WalletMaxAgeUpdated(uint32 walletMaxAge);

    event WalletMaxBtcTransferUpdateStarted(
        uint64 newWalletMaxBtcTransfer,
        uint256 timestamp
    );
    event WalletMaxBtcTransferUpdated(uint64 walletMaxBtcTransfer);

    event WalletClosingPeriodUpdateStarted(
        uint32 newWalletClosingPeriod,
        uint256 timestamp
    );
    event WalletClosingPeriodUpdated(uint32 walletClosingPeriod);

    event FraudChallengeDepositAmountUpdateStarted(
        uint96 newFraudChallengeDepositAmount,
        uint256 timestamp
    );
    event FraudChallengeDepositAmountUpdated(
        uint96 fraudChallengeDepositAmount
    );

    event FraudChallengeDefeatTimeoutUpdateStarted(
        uint32 newFraudChallengeDefeatTimeout,
        uint256 timestamp
    );
    event FraudChallengeDefeatTimeoutUpdated(
        uint32 fraudChallengeDefeatTimeout
    );

    event FraudSlashingAmountUpdateStarted(
        uint96 newFraudSlashingAmount,
        uint256 timestamp
    );
    event FraudSlashingAmountUpdated(uint96 fraudSlashingAmount);

    event FraudNotifierRewardMultiplierUpdateStarted(
        uint32 newFraudNotifierRewardMultiplier,
        uint256 timestamp
    );
    event FraudNotifierRewardMultiplierUpdated(
        uint32 fraudNotifierRewardMultiplier
    );

    event TreasuryUpdateStarted(address newTreasury, uint256 timestamp);
    event TreasuryUpdated(address treasury);

    constructor(Bridge _bridge, uint256 _governanceDelay) {
        bridge = _bridge;
        governanceDelays[0] = _governanceDelay;
    }

    /// @notice Allows the Governance to mark the given vault address as trusted
    ///         or no longer trusted. Vaults are not trusted by default.
    ///         Trusted vault must meet the following criteria:
    ///         - `IVault.receiveBalanceIncrease` must have a known, low gas
    ///           cost,
    ///         - `IVault.receiveBalanceIncrease` must never revert.
    /// @param vault The address of the vault.
    /// @param isTrusted flag indicating whether the vault is trusted or not.
    function setVaultStatus(address vault, bool isTrusted) external onlyOwner {
        bridge.setVaultStatus(vault, isTrusted);
    }

    /// @notice Allows the Governance to mark the given address as trusted
    ///         or no longer trusted SPV maintainer. Addresses are not trusted
    ///         as SPV maintainers by default.
    /// @param spvMaintainer The address of the SPV maintainer.
    /// @param isTrusted flag indicating whether the address is trusted or not.
    function setSpvMaintainerStatus(address spvMaintainer, bool isTrusted)
        external
        onlyOwner
    {
        bridge.setSpvMaintainerStatus(spvMaintainer, isTrusted);
    }

    /// @notice Begins the governance delay update process.
    /// @dev Can be called only by the contract owner. The event that informs about
    ///      the start of the governance delay was skipped on purpose to trim
    ///      the contract size. All the params inside of the `governanceDelays`
    ///      array are public and can be easily fetched.
    /// @param _newGovernanceDelay New governance delay
    function beginGovernanceDelayUpdate(uint256 _newGovernanceDelay)
        external
        onlyOwner
    {
        governanceDelays[1] = _newGovernanceDelay;
        /* solhint-disable not-rely-on-time */
        governanceDelays[2] = block.timestamp;
        /* solhint-enable not-rely-on-time */
    }

    /// @notice Finalizes the governance delay update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses. Updated event was skipped on purpose to trim the
    ///      contract size. All the params inside of the `governanceDelays`
    ///      array are public and can be easily fetched.
    function finalizeGovernanceDelayUpdate() external onlyOwner {
        require(governanceDelays[2] > 0, "Change not initiated");
        /* solhint-disable not-rely-on-time */
        require(
            block.timestamp - governanceDelays[2] > governanceDelay(),
            "Governance delay has not elapsed"
        );
        /* solhint-enable not-rely-on-time */
        governanceDelays[0] = governanceDelays[1];
        governanceDelays[1] = 0;
        governanceDelays[2] = 0;
    }

    /// @notice Begins the Bridge governance transfer process.
    /// @dev Can be called only by the contract owner. It is the governance
    ///      responsibility to validate the correctness of the new Bridge
    ///      Governance contract. The other reason for not adding this check is
    ///      to go down with the contract size and leaving only the essential code.
    function beginBridgeGovernanceTransfer(address _newBridgeGovernance)
        external
        onlyOwner
    {
        // slither-disable-next-line missing-zero-check
        newBridgeGovernance = _newBridgeGovernance;
        /* solhint-disable not-rely-on-time */
        bridgeGovernanceTransferChangeInitiated = block.timestamp;
        emit BridgeGovernanceTransferStarted(
            _newBridgeGovernance,
            bridgeGovernanceTransferChangeInitiated
        );
        /* solhint-enable not-rely-on-time */
    }

    /// @notice Finalizes the bridge governance transfer process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses. Bridge governance transferred event can be read
    ///      from the Governable bridge contract 'GovernanceTransferred(old, new)'.
    ///      Event that informs about the transfer in this function is skipped on
    ///      purpose to go down with the contract size.
    function finalizeBridgeGovernanceTransfer() external onlyOwner {
        require(
            bridgeGovernanceTransferChangeInitiated > 0,
            "Change not initiated"
        );
        /* solhint-disable not-rely-on-time */
        require(
            block.timestamp - bridgeGovernanceTransferChangeInitiated >=
                governanceDelay(),
            "Governance delay has not elapsed"
        );
        /* solhint-enable not-rely-on-time */
        // slither-disable-next-line reentrancy-no-eth
        bridge.transferGovernance(newBridgeGovernance);
        bridgeGovernanceTransferChangeInitiated = 0;
        newBridgeGovernance = address(0);
    }

    // --- Deposit

    /// @notice Begins the deposit dust threshold amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newDepositDustThreshold New deposit dust threshold amount.
    function beginDepositDustThresholdUpdate(uint64 _newDepositDustThreshold)
        external
        onlyOwner
    {
        depositData.beginDepositDustThresholdUpdate(_newDepositDustThreshold);
    }

    /// @notice Finalizes the deposit dust threshold amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeDepositDustThresholdUpdate() external onlyOwner {
        (
            ,
            uint64 depositTreasuryFeeDivisor,
            uint64 depositTxMaxFee,
            uint32 depositRevealAheadPeriod
        ) = bridge.depositParameters();
        uint64 newDepositDustThreshold = depositData.newDepositDustThreshold;
        depositData.finalizeDepositDustThresholdUpdate(governanceDelay());
        bridge.updateDepositParameters(
            newDepositDustThreshold,
            depositTreasuryFeeDivisor,
            depositTxMaxFee,
            depositRevealAheadPeriod
        );
    }

    /// @notice Begins the deposit treasury fee divisor amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newDepositTreasuryFeeDivisor New deposit treasury fee divisor.
    function beginDepositTreasuryFeeDivisorUpdate(
        uint64 _newDepositTreasuryFeeDivisor
    ) external onlyOwner {
        depositData.beginDepositTreasuryFeeDivisorUpdate(
            _newDepositTreasuryFeeDivisor
        );
    }

    /// @notice Finalizes the deposit treasury fee divisor amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeDepositTreasuryFeeDivisorUpdate() external onlyOwner {
        (
            uint64 depositDustThreshold,
            ,
            uint64 depositTxMaxFee,
            uint32 depositRevealAheadPeriod
        ) = bridge.depositParameters();
        uint64 newDepositTreasuryFeeDivisor = depositData
            .newDepositTreasuryFeeDivisor;
        depositData.finalizeDepositTreasuryFeeDivisorUpdate(governanceDelay());
        bridge.updateDepositParameters(
            depositDustThreshold,
            newDepositTreasuryFeeDivisor,
            depositTxMaxFee,
            depositRevealAheadPeriod
        );
    }

    /// @notice Begins the deposit tx max fee amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newDepositTxMaxFee New deposit tx max fee.
    function beginDepositTxMaxFeeUpdate(uint64 _newDepositTxMaxFee)
        external
        onlyOwner
    {
        depositData.beginDepositTxMaxFeeUpdate(_newDepositTxMaxFee);
    }

    /// @notice Finalizes the deposit tx max fee amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeDepositTxMaxFeeUpdate() external onlyOwner {
        (
            uint64 depositDustThreshold,
            uint64 depositTreasuryFeeDivisor,
            ,
            uint32 depositRevealAheadPeriod
        ) = bridge.depositParameters();
        uint64 newDepositTxMaxFee = depositData.newDepositTxMaxFee;
        depositData.finalizeDepositTxMaxFeeUpdate(governanceDelay());
        bridge.updateDepositParameters(
            depositDustThreshold,
            depositTreasuryFeeDivisor,
            newDepositTxMaxFee,
            depositRevealAheadPeriod
        );
    }

    /// @notice Begins the deposit reveal ahead period update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newDepositRevealAheadPeriod New deposit reveal ahead period.
    function beginDepositRevealAheadPeriodUpdate(
        uint32 _newDepositRevealAheadPeriod
    ) external onlyOwner {
        depositData.beginDepositRevealAheadPeriodUpdate(
            _newDepositRevealAheadPeriod
        );
    }

    /// @notice Finalizes the deposit reveal ahead period update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeDepositRevealAheadPeriodUpdate() external onlyOwner {
        (
            uint64 depositDustThreshold,
            uint64 depositTreasuryFeeDivisor,
            uint64 depositTxMaxFee,

        ) = bridge.depositParameters();
        uint32 newDepositRevealAheadPeriod = depositData
            .newDepositRevealAheadPeriod;
        depositData.finalizeDepositRevealAheadPeriodUpdate(governanceDelay());
        bridge.updateDepositParameters(
            depositDustThreshold,
            depositTreasuryFeeDivisor,
            depositTxMaxFee,
            newDepositRevealAheadPeriod
        );
    }

    // --- Redemption

    /// @notice Begins the redemption dust threshold amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newRedemptionDustThreshold New redemption dust threshold.
    function beginRedemptionDustThresholdUpdate(
        uint64 _newRedemptionDustThreshold
    ) external onlyOwner {
        redemptionData.beginRedemptionDustThresholdUpdate(
            _newRedemptionDustThreshold
        );
    }

    /// @notice Finalizes the dust threshold amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeRedemptionDustThresholdUpdate() external onlyOwner {
        (
            ,
            uint64 redemptionTreasuryFeeDivisor,
            uint64 redemptionTxMaxFee,
            uint64 redemptionTxMaxTotalFee,
            uint32 redemptionTimeout,
            uint96 redemptionTimeoutSlashingAmount,
            uint32 redemptionTimeoutNotifierRewardMultiplier
        ) = bridge.redemptionParameters();
        uint64 newRedemptionDustThreshold = redemptionData
            .newRedemptionDustThreshold;
        redemptionData.finalizeRedemptionDustThresholdUpdate(governanceDelay());
        bridge.updateRedemptionParameters(
            newRedemptionDustThreshold,
            redemptionTreasuryFeeDivisor,
            redemptionTxMaxFee,
            redemptionTxMaxTotalFee,
            redemptionTimeout,
            redemptionTimeoutSlashingAmount,
            redemptionTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the redemption treasury fee divisor amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newRedemptionTreasuryFeeDivisor New redemption treasury fee divisor.
    function beginRedemptionTreasuryFeeDivisorUpdate(
        uint64 _newRedemptionTreasuryFeeDivisor
    ) external onlyOwner {
        redemptionData.beginRedemptionTreasuryFeeDivisorUpdate(
            _newRedemptionTreasuryFeeDivisor
        );
    }

    /// @notice Finalizes the redemption treasury fee divisor amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeRedemptionTreasuryFeeDivisorUpdate() external onlyOwner {
        (
            uint64 redemptionDustThreshold,
            ,
            uint64 redemptionTxMaxFee,
            uint64 redemptionTxMaxTotalFee,
            uint32 redemptionTimeout,
            uint96 redemptionTimeoutSlashingAmount,
            uint32 redemptionTimeoutNotifierRewardMultiplier
        ) = bridge.redemptionParameters();
        // slither-disable-next-line reentrancy-no-eth
        uint64 newRedemptionTreasuryFeeDivisor = redemptionData
            .newRedemptionTreasuryFeeDivisor;
        redemptionData.finalizeRedemptionTreasuryFeeDivisorUpdate(
            governanceDelay()
        );
        bridge.updateRedemptionParameters(
            redemptionDustThreshold,
            newRedemptionTreasuryFeeDivisor,
            redemptionTxMaxFee,
            redemptionTxMaxTotalFee,
            redemptionTimeout,
            redemptionTimeoutSlashingAmount,
            redemptionTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the redemption tx max fee amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newRedemptionTxMaxFee New redemption tx max fee.
    function beginRedemptionTxMaxFeeUpdate(uint64 _newRedemptionTxMaxFee)
        external
        onlyOwner
    {
        redemptionData.beginRedemptionTxMaxFeeUpdate(_newRedemptionTxMaxFee);
    }

    /// @notice Finalizes the redemption tx max fee amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeRedemptionTxMaxFeeUpdate() external onlyOwner {
        (
            uint64 redemptionDustThreshold,
            uint64 redemptionTreasuryFeeDivisor,
            ,
            uint64 redemptionTxMaxTotalFee,
            uint32 redemptionTimeout,
            uint96 redemptionTimeoutSlashingAmount,
            uint32 redemptionTimeoutNotifierRewardMultiplier
        ) = bridge.redemptionParameters();
        uint64 newRedemptionTxMaxFee = redemptionData.newRedemptionTxMaxFee;
        redemptionData.finalizeRedemptionTxMaxFeeUpdate(governanceDelay());
        bridge.updateRedemptionParameters(
            redemptionDustThreshold,
            redemptionTreasuryFeeDivisor,
            newRedemptionTxMaxFee,
            redemptionTxMaxTotalFee,
            redemptionTimeout,
            redemptionTimeoutSlashingAmount,
            redemptionTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the redemption tx max total fee amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newRedemptionTxMaxTotalFee New redemption tx max total fee.
    function beginRedemptionTxMaxTotalFeeUpdate(
        uint64 _newRedemptionTxMaxTotalFee
    ) external onlyOwner {
        redemptionData.beginRedemptionTxMaxTotalFeeUpdate(
            _newRedemptionTxMaxTotalFee
        );
    }

    /// @notice Finalizes the redemption tx max total fee amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeRedemptionTxMaxTotalFeeUpdate() external onlyOwner {
        (
            uint64 redemptionDustThreshold,
            uint64 redemptionTreasuryFeeDivisor,
            uint64 redemptionTxMaxFee,
            ,
            uint32 redemptionTimeout,
            uint96 redemptionTimeoutSlashingAmount,
            uint32 redemptionTimeoutNotifierRewardMultiplier
        ) = bridge.redemptionParameters();
        uint64 newRedemptionTxMaxTotalFee = redemptionData
            .newRedemptionTxMaxTotalFee;
        redemptionData.finalizeRedemptionTxMaxTotalFeeUpdate(governanceDelay());
        bridge.updateRedemptionParameters(
            redemptionDustThreshold,
            redemptionTreasuryFeeDivisor,
            redemptionTxMaxFee,
            newRedemptionTxMaxTotalFee,
            redemptionTimeout,
            redemptionTimeoutSlashingAmount,
            redemptionTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the redemption timeout amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newRedemptionTimeout New redemption timeout.
    function beginRedemptionTimeoutUpdate(uint32 _newRedemptionTimeout)
        external
        onlyOwner
    {
        redemptionData.beginRedemptionTimeoutUpdate(_newRedemptionTimeout);
    }

    /// @notice Finalizes the redemption timeout amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeRedemptionTimeoutUpdate() external onlyOwner {
        (
            uint64 redemptionDustThreshold,
            uint64 redemptionTreasuryFeeDivisor,
            uint64 redemptionTxMaxFee,
            uint64 redemptionTxMaxTotalFee,
            ,
            uint96 redemptionTimeoutSlashingAmount,
            uint32 redemptionTimeoutNotifierRewardMultiplier
        ) = bridge.redemptionParameters();
        uint32 newRedemptionTimeout = redemptionData.newRedemptionTimeout;
        redemptionData.finalizeRedemptionTimeoutUpdate(governanceDelay());
        bridge.updateRedemptionParameters(
            redemptionDustThreshold,
            redemptionTreasuryFeeDivisor,
            redemptionTxMaxFee,
            redemptionTxMaxTotalFee,
            newRedemptionTimeout,
            redemptionTimeoutSlashingAmount,
            redemptionTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the redemption timeout slashing amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newRedemptionTimeoutSlashingAmount New redemption timeout slashing
    ///         amount.
    function beginRedemptionTimeoutSlashingAmountUpdate(
        uint96 _newRedemptionTimeoutSlashingAmount
    ) external onlyOwner {
        redemptionData.beginRedemptionTimeoutSlashingAmountUpdate(
            _newRedemptionTimeoutSlashingAmount
        );
    }

    /// @notice Finalizes the redemption timeout slashing amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeRedemptionTimeoutSlashingAmountUpdate()
        external
        onlyOwner
    {
        (
            uint64 redemptionDustThreshold,
            uint64 redemptionTreasuryFeeDivisor,
            uint64 redemptionTxMaxFee,
            uint64 redemptionTxMaxTotalFee,
            uint32 redemptionTimeout,
            ,
            uint32 redemptionTimeoutNotifierRewardMultiplier
        ) = bridge.redemptionParameters();
        uint96 newRedemptionTimeoutSlashingAmount = redemptionData
            .newRedemptionTimeoutSlashingAmount;
        redemptionData.finalizeRedemptionTimeoutSlashingAmountUpdate(
            governanceDelay()
        );
        bridge.updateRedemptionParameters(
            redemptionDustThreshold,
            redemptionTreasuryFeeDivisor,
            redemptionTxMaxFee,
            redemptionTxMaxTotalFee,
            redemptionTimeout,
            newRedemptionTimeoutSlashingAmount,
            redemptionTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the redemption timeout notifier reward multiplier amount
    ///         update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newRedemptionTimeoutNotifierRewardMultiplier New redemption timeout
    ///         notifier reward multiplier.
    function beginRedemptionTimeoutNotifierRewardMultiplierUpdate(
        uint32 _newRedemptionTimeoutNotifierRewardMultiplier
    ) external onlyOwner {
        redemptionData.beginRedemptionTimeoutNotifierRewardMultiplierUpdate(
            _newRedemptionTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Finalizes the redemption timeout notifier reward multiplier amount
    ///         update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeRedemptionTimeoutNotifierRewardMultiplierUpdate()
        external
        onlyOwner
    {
        (
            uint64 redemptionDustThreshold,
            uint64 redemptionTreasuryFeeDivisor,
            uint64 redemptionTxMaxFee,
            uint64 redemptionTxMaxTotalFee,
            uint32 redemptionTimeout,
            uint96 redemptionTimeoutSlashingAmount,

        ) = bridge.redemptionParameters();
        uint32 newRedemptionTimeoutNotifierRewardMultiplier = redemptionData
            .newRedemptionTimeoutNotifierRewardMultiplier;
        redemptionData.finalizeRedemptionTimeoutNotifierRewardMultiplierUpdate(
            governanceDelay()
        );
        bridge.updateRedemptionParameters(
            redemptionDustThreshold,
            redemptionTreasuryFeeDivisor,
            redemptionTxMaxFee,
            redemptionTxMaxTotalFee,
            redemptionTimeout,
            redemptionTimeoutSlashingAmount,
            newRedemptionTimeoutNotifierRewardMultiplier
        );
    }

    // --- Moving funds

    /// @notice Begins the moving funds tx max total fee update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovingFundsTxMaxTotalFee New moving funds tx max total fee.
    function beginMovingFundsTxMaxTotalFeeUpdate(
        uint64 _newMovingFundsTxMaxTotalFee
    ) external onlyOwner {
        movingFundsData.beginMovingFundsTxMaxTotalFeeUpdate(
            _newMovingFundsTxMaxTotalFee
        );
    }

    /// @notice Finalizes the moving funds tx max total fee update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovingFundsTxMaxTotalFeeUpdate() external onlyOwner {
        (
            ,
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
        ) = bridge.movingFundsParameters();
        uint64 newMovingFundsTxMaxTotalFee = movingFundsData
            .newMovingFundsTxMaxTotalFee;
        movingFundsData.finalizeMovingFundsTxMaxTotalFeeUpdate(
            governanceDelay()
        );
        bridge.updateMovingFundsParameters(
            newMovingFundsTxMaxTotalFee,
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

    /// @notice Begins the moving funds dust threshold update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovingFundsDustThreshold New moving funds dust threshold.
    function beginMovingFundsDustThresholdUpdate(
        uint64 _newMovingFundsDustThreshold
    ) external onlyOwner {
        movingFundsData.beginMovingFundsDustThresholdUpdate(
            _newMovingFundsDustThreshold
        );
    }

    /// @notice Finalizes the moving funds dust threshold update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovingFundsDustThresholdUpdate() external onlyOwner {
        (
            uint64 movingFundsTxMaxTotalFee,
            ,
            uint32 movingFundsTimeoutResetDelay,
            uint32 movingFundsTimeout,
            uint96 movingFundsTimeoutSlashingAmount,
            uint32 movingFundsTimeoutNotifierRewardMultiplier,
            uint16 movingFundsCommitmentGasOffset,
            uint64 movedFundsSweepTxMaxTotalFee,
            uint32 movedFundsSweepTimeout,
            uint96 movedFundsSweepTimeoutSlashingAmount,
            uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
        ) = bridge.movingFundsParameters();
        uint64 newMovingFundsDustThreshold = movingFundsData
            .newMovingFundsDustThreshold;
        movingFundsData.finalizeMovingFundsDustThresholdUpdate(
            governanceDelay()
        );
        bridge.updateMovingFundsParameters(
            movingFundsTxMaxTotalFee,
            newMovingFundsDustThreshold,
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

    /// @notice Begins the moving funds timeout reset delay update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovingFundsTimeoutResetDelay New moving funds timeout reset
    ///         delay.
    function beginMovingFundsTimeoutResetDelayUpdate(
        uint32 _newMovingFundsTimeoutResetDelay
    ) external onlyOwner {
        movingFundsData.beginMovingFundsTimeoutResetDelayUpdate(
            _newMovingFundsTimeoutResetDelay
        );
    }

    /// @notice Finalizes the moving funds timeout reset delay update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovingFundsTimeoutResetDelayUpdate() external onlyOwner {
        (
            uint64 movingFundsTxMaxTotalFee,
            uint64 movingFundsDustThreshold,
            ,
            uint32 movingFundsTimeout,
            uint96 movingFundsTimeoutSlashingAmount,
            uint32 movingFundsTimeoutNotifierRewardMultiplier,
            uint16 movingFundsCommitmentGasOffset,
            uint64 movedFundsSweepTxMaxTotalFee,
            uint32 movedFundsSweepTimeout,
            uint96 movedFundsSweepTimeoutSlashingAmount,
            uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
        ) = bridge.movingFundsParameters();
        uint32 newMovingFundsTimeoutResetDelay = movingFundsData
            .newMovingFundsTimeoutResetDelay;
        movingFundsData.finalizeMovingFundsTimeoutResetDelayUpdate(
            governanceDelay()
        );
        bridge.updateMovingFundsParameters(
            movingFundsTxMaxTotalFee,
            movingFundsDustThreshold,
            newMovingFundsTimeoutResetDelay,
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

    /// @notice Begins the moving funds timeout update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovingFundsTimeout New moving funds timeout.
    function beginMovingFundsTimeoutUpdate(uint32 _newMovingFundsTimeout)
        external
        onlyOwner
    {
        movingFundsData.beginMovingFundsTimeoutUpdate(_newMovingFundsTimeout);
    }

    /// @notice Finalizes the moving funds timeout update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovingFundsTimeoutUpdate() external onlyOwner {
        (
            uint64 movingFundsTxMaxTotalFee,
            uint64 movingFundsDustThreshold,
            uint32 movingFundsTimeoutResetDelay,
            ,
            uint96 movingFundsTimeoutSlashingAmount,
            uint32 movingFundsTimeoutNotifierRewardMultiplier,
            uint16 movingFundsCommitmentGasOffset,
            uint64 movedFundsSweepTxMaxTotalFee,
            uint32 movedFundsSweepTimeout,
            uint96 movedFundsSweepTimeoutSlashingAmount,
            uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
        ) = bridge.movingFundsParameters();
        uint32 newMovingFundsTimeout = movingFundsData.newMovingFundsTimeout;
        movingFundsData.finalizeMovingFundsTimeoutUpdate(governanceDelay());
        bridge.updateMovingFundsParameters(
            movingFundsTxMaxTotalFee,
            movingFundsDustThreshold,
            movingFundsTimeoutResetDelay,
            newMovingFundsTimeout,
            movingFundsTimeoutSlashingAmount,
            movingFundsTimeoutNotifierRewardMultiplier,
            movingFundsCommitmentGasOffset,
            movedFundsSweepTxMaxTotalFee,
            movedFundsSweepTimeout,
            movedFundsSweepTimeoutSlashingAmount,
            movedFundsSweepTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the moving funds timeout slashing amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovingFundsTimeoutSlashingAmount New moving funds timeout
    ///         slashing amount.
    function beginMovingFundsTimeoutSlashingAmountUpdate(
        uint96 _newMovingFundsTimeoutSlashingAmount
    ) external onlyOwner {
        movingFundsData.beginMovingFundsTimeoutSlashingAmountUpdate(
            _newMovingFundsTimeoutSlashingAmount
        );
    }

    /// @notice Finalizes the moving funds timeout slashing amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovingFundsTimeoutSlashingAmountUpdate()
        external
        onlyOwner
    {
        (
            uint64 movingFundsTxMaxTotalFee,
            uint64 movingFundsDustThreshold,
            uint32 movingFundsTimeoutResetDelay,
            uint32 movingFundsTimeout,
            ,
            uint32 movingFundsTimeoutNotifierRewardMultiplier,
            uint16 movingFundsCommitmentGasOffset,
            uint64 movedFundsSweepTxMaxTotalFee,
            uint32 movedFundsSweepTimeout,
            uint96 movedFundsSweepTimeoutSlashingAmount,
            uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
        ) = bridge.movingFundsParameters();
        uint96 newMovingFundsTimeoutSlashingAmount = movingFundsData
            .newMovingFundsTimeoutSlashingAmount;
        movingFundsData.finalizeMovingFundsTimeoutSlashingAmountUpdate(
            governanceDelay()
        );
        bridge.updateMovingFundsParameters(
            movingFundsTxMaxTotalFee,
            movingFundsDustThreshold,
            movingFundsTimeoutResetDelay,
            movingFundsTimeout,
            newMovingFundsTimeoutSlashingAmount,
            movingFundsTimeoutNotifierRewardMultiplier,
            movingFundsCommitmentGasOffset,
            movedFundsSweepTxMaxTotalFee,
            movedFundsSweepTimeout,
            movedFundsSweepTimeoutSlashingAmount,
            movedFundsSweepTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the moving funds timeout notifier reward multiplier update
    ///         process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovingFundsTimeoutNotifierRewardMultiplier New moving funds
    ///         timeout notifier reward multiplier.
    function beginMovingFundsTimeoutNotifierRewardMultiplierUpdate(
        uint32 _newMovingFundsTimeoutNotifierRewardMultiplier
    ) external onlyOwner {
        movingFundsData.beginMovingFundsTimeoutNotifierRewardMultiplierUpdate(
            _newMovingFundsTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Finalizes the moving funds timeout notifier reward multiplier
    ///         update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovingFundsTimeoutNotifierRewardMultiplierUpdate()
        external
        onlyOwner
    {
        (
            uint64 movingFundsTxMaxTotalFee,
            uint64 movingFundsDustThreshold,
            uint32 movingFundsTimeoutResetDelay,
            uint32 movingFundsTimeout,
            uint96 movingFundsTimeoutSlashingAmount,
            ,
            uint16 movingFundsCommitmentGasOffset,
            uint64 movedFundsSweepTxMaxTotalFee,
            uint32 movedFundsSweepTimeout,
            uint96 movedFundsSweepTimeoutSlashingAmount,
            uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
        ) = bridge.movingFundsParameters();
        uint32 newMovingFundsTimeoutNotifierRewardMultiplier = movingFundsData
            .newMovingFundsTimeoutNotifierRewardMultiplier;
        movingFundsData
            .finalizeMovingFundsTimeoutNotifierRewardMultiplierUpdate(
                governanceDelay()
            );
        bridge.updateMovingFundsParameters(
            movingFundsTxMaxTotalFee,
            movingFundsDustThreshold,
            movingFundsTimeoutResetDelay,
            movingFundsTimeout,
            movingFundsTimeoutSlashingAmount,
            newMovingFundsTimeoutNotifierRewardMultiplier,
            movingFundsCommitmentGasOffset,
            movedFundsSweepTxMaxTotalFee,
            movedFundsSweepTimeout,
            movedFundsSweepTimeoutSlashingAmount,
            movedFundsSweepTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the moving funds commitment gas offset update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovingFundsCommitmentGasOffset New moving funds commitment
    ///        gas offset.
    function beginMovingFundsCommitmentGasOffsetUpdate(
        uint16 _newMovingFundsCommitmentGasOffset
    ) external onlyOwner {
        movingFundsData.beginMovingFundsCommitmentGasOffsetUpdate(
            _newMovingFundsCommitmentGasOffset
        );
    }

    /// @notice Finalizes the moving funds commitment gas offset update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovingFundsCommitmentGasOffsetUpdate() external onlyOwner {
        (
            uint64 movingFundsTxMaxTotalFee,
            uint64 movingFundsDustThreshold,
            uint32 movingFundsTimeoutResetDelay,
            uint32 movingFundsTimeout,
            uint96 movingFundsTimeoutSlashingAmount,
            uint32 movingFundsTimeoutNotifierRewardMultiplier,
            ,
            uint64 movedFundsSweepTxMaxTotalFee,
            uint32 movedFundsSweepTimeout,
            uint96 movedFundsSweepTimeoutSlashingAmount,
            uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
        ) = bridge.movingFundsParameters();
        uint16 newMovingFundsCommitmentGasOffset = movingFundsData
            .newMovingFundsCommitmentGasOffset;
        movingFundsData.finalizeMovingFundsCommitmentGasOffsetUpdate(
            governanceDelay()
        );
        bridge.updateMovingFundsParameters(
            movingFundsTxMaxTotalFee,
            movingFundsDustThreshold,
            movingFundsTimeoutResetDelay,
            movingFundsTimeout,
            movingFundsTimeoutSlashingAmount,
            movingFundsTimeoutNotifierRewardMultiplier,
            newMovingFundsCommitmentGasOffset,
            movedFundsSweepTxMaxTotalFee,
            movedFundsSweepTimeout,
            movedFundsSweepTimeoutSlashingAmount,
            movedFundsSweepTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the moved funds sweep tx max total fee update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovedFundsSweepTxMaxTotalFee New moved funds sweep tx max total
    ///         fee.
    function beginMovedFundsSweepTxMaxTotalFeeUpdate(
        uint64 _newMovedFundsSweepTxMaxTotalFee
    ) external onlyOwner {
        movingFundsData.beginMovedFundsSweepTxMaxTotalFeeUpdate(
            _newMovedFundsSweepTxMaxTotalFee
        );
    }

    /// @notice Finalizes the moved funds sweep tx max total fee update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovedFundsSweepTxMaxTotalFeeUpdate() external onlyOwner {
        (
            uint64 movingFundsTxMaxTotalFee,
            uint64 movingFundsDustThreshold,
            uint32 movingFundsTimeoutResetDelay,
            uint32 movingFundsTimeout,
            uint96 movingFundsTimeoutSlashingAmount,
            uint32 movingFundsTimeoutNotifierRewardMultiplier,
            uint16 movingFundsCommitmentGasOffset,
            ,
            uint32 movedFundsSweepTimeout,
            uint96 movedFundsSweepTimeoutSlashingAmount,
            uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
        ) = bridge.movingFundsParameters();
        uint64 newMovedFundsSweepTxMaxTotalFee = movingFundsData
            .newMovedFundsSweepTxMaxTotalFee;
        movingFundsData.finalizeMovedFundsSweepTxMaxTotalFeeUpdate(
            governanceDelay()
        );
        bridge.updateMovingFundsParameters(
            movingFundsTxMaxTotalFee,
            movingFundsDustThreshold,
            movingFundsTimeoutResetDelay,
            movingFundsTimeout,
            movingFundsTimeoutSlashingAmount,
            movingFundsTimeoutNotifierRewardMultiplier,
            movingFundsCommitmentGasOffset,
            newMovedFundsSweepTxMaxTotalFee,
            movedFundsSweepTimeout,
            movedFundsSweepTimeoutSlashingAmount,
            movedFundsSweepTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the moved funds sweep timeout update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovedFundsSweepTimeout New moved funds sweep timeout.
    function beginMovedFundsSweepTimeoutUpdate(
        uint32 _newMovedFundsSweepTimeout
    ) external onlyOwner {
        movingFundsData.beginMovedFundsSweepTimeoutUpdate(
            _newMovedFundsSweepTimeout
        );
    }

    /// @notice Finalizes the moved funds sweep timeout update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovedFundsSweepTimeoutUpdate() external onlyOwner {
        (
            uint64 movingFundsTxMaxTotalFee,
            uint64 movingFundsDustThreshold,
            uint32 movingFundsTimeoutResetDelay,
            uint32 movingFundsTimeout,
            uint96 movingFundsTimeoutSlashingAmount,
            uint32 movingFundsTimeoutNotifierRewardMultiplier,
            uint16 movingFundsCommitmentGasOffset,
            uint64 movedFundsSweepTxMaxTotalFee,
            ,
            uint96 movedFundsSweepTimeoutSlashingAmount,
            uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
        ) = bridge.movingFundsParameters();
        uint32 newMovedFundsSweepTimeout = movingFundsData
            .newMovedFundsSweepTimeout;
        movingFundsData.finalizeMovedFundsSweepTimeoutUpdate(governanceDelay());
        bridge.updateMovingFundsParameters(
            movingFundsTxMaxTotalFee,
            movingFundsDustThreshold,
            movingFundsTimeoutResetDelay,
            movingFundsTimeout,
            movingFundsTimeoutSlashingAmount,
            movingFundsTimeoutNotifierRewardMultiplier,
            movingFundsCommitmentGasOffset,
            movedFundsSweepTxMaxTotalFee,
            newMovedFundsSweepTimeout,
            movedFundsSweepTimeoutSlashingAmount,
            movedFundsSweepTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the moved funds sweep timeout slashing amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovedFundsSweepTimeoutSlashingAmount New moved funds sweep
    ///         timeout slashing amount.
    function beginMovedFundsSweepTimeoutSlashingAmountUpdate(
        uint96 _newMovedFundsSweepTimeoutSlashingAmount
    ) external onlyOwner {
        movingFundsData.beginMovedFundsSweepTimeoutSlashingAmountUpdate(
            _newMovedFundsSweepTimeoutSlashingAmount
        );
    }

    /// @notice Finalizes the moved funds sweep timeout slashing amount update
    ///         process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovedFundsSweepTimeoutSlashingAmountUpdate()
        external
        onlyOwner
    {
        (
            uint64 movingFundsTxMaxTotalFee,
            uint64 movingFundsDustThreshold,
            uint32 movingFundsTimeoutResetDelay,
            uint32 movingFundsTimeout,
            uint96 movingFundsTimeoutSlashingAmount,
            uint32 movingFundsTimeoutNotifierRewardMultiplier,
            uint16 movingFundsCommitmentGasOffset,
            uint64 movedFundsSweepTxMaxTotalFee,
            uint32 movedFundsSweepTimeout,
            ,
            uint32 movedFundsSweepTimeoutNotifierRewardMultiplier
        ) = bridge.movingFundsParameters();
        uint96 newMovedFundsSweepTimeoutSlashingAmount = movingFundsData
            .newMovedFundsSweepTimeoutSlashingAmount;
        movingFundsData.finalizeMovedFundsSweepTimeoutSlashingAmountUpdate(
            governanceDelay()
        );
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
            newMovedFundsSweepTimeoutSlashingAmount,
            movedFundsSweepTimeoutNotifierRewardMultiplier
        );
    }

    /// @notice Begins the moved funds sweep timeout notifier reward multiplier
    ///         update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newMovedFundsSweepTimeoutNotifierRewardMultiplier New moved funds
    ///         sweep timeout notifier reward multiplier.
    function beginMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate(
        uint32 _newMovedFundsSweepTimeoutNotifierRewardMultiplier
    ) external onlyOwner {
        movingFundsData
            .beginMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate(
                _newMovedFundsSweepTimeoutNotifierRewardMultiplier
            );
    }

    /// @notice Finalizes the moved funds sweep timeout notifier reward multiplier
    ///         update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate()
        external
        onlyOwner
    {
        (
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

        ) = bridge.movingFundsParameters();
        uint32 newMovedFundsSweepTimeoutNotifierRewardMultiplier = movingFundsData
                .newMovedFundsSweepTimeoutNotifierRewardMultiplier;
        movingFundsData
            .finalizeMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate(
                governanceDelay()
            );
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
            newMovedFundsSweepTimeoutNotifierRewardMultiplier
        );
    }

    // --- Wallet creation

    /// @notice Begins the wallet creation period update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newWalletCreationPeriod New wallet creation period.
    function beginWalletCreationPeriodUpdate(uint32 _newWalletCreationPeriod)
        external
        onlyOwner
    {
        walletData.beginWalletCreationPeriodUpdate(_newWalletCreationPeriod);
    }

    /// @notice Finalizes the wallet creation period update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeWalletCreationPeriodUpdate() external onlyOwner {
        (
            ,
            uint64 walletCreationMinBtcBalance,
            uint64 walletCreationMaxBtcBalance,
            uint64 walletClosureMinBtcBalance,
            uint32 walletMaxAge,
            uint64 walletMaxBtcTransfer,
            uint32 walletClosingPeriod
        ) = bridge.walletParameters();
        uint32 newWalletCreationPeriod = walletData.newWalletCreationPeriod;
        walletData.finalizeWalletCreationPeriodUpdate(governanceDelay());
        bridge.updateWalletParameters(
            newWalletCreationPeriod,
            walletCreationMinBtcBalance,
            walletCreationMaxBtcBalance,
            walletClosureMinBtcBalance,
            walletMaxAge,
            walletMaxBtcTransfer,
            walletClosingPeriod
        );
    }

    /// @notice Begins the wallet creation min btc balance update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newWalletCreationMinBtcBalance New wallet creation min btc balance.
    function beginWalletCreationMinBtcBalanceUpdate(
        uint64 _newWalletCreationMinBtcBalance
    ) external onlyOwner {
        walletData.beginWalletCreationMinBtcBalanceUpdate(
            _newWalletCreationMinBtcBalance
        );
    }

    /// @notice Finalizes the wallet creation min btc balance update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeWalletCreationMinBtcBalanceUpdate() external onlyOwner {
        (
            uint32 walletCreationPeriod,
            ,
            uint64 walletCreationMaxBtcBalance,
            uint64 walletClosureMinBtcBalance,
            uint32 walletMaxAge,
            uint64 walletMaxBtcTransfer,
            uint32 walletClosingPeriod
        ) = bridge.walletParameters();
        uint64 newWalletCreationMinBtcBalance = walletData
            .newWalletCreationMinBtcBalance;
        walletData.finalizeWalletCreationMinBtcBalanceUpdate(governanceDelay());
        bridge.updateWalletParameters(
            walletCreationPeriod,
            newWalletCreationMinBtcBalance,
            walletCreationMaxBtcBalance,
            walletClosureMinBtcBalance,
            walletMaxAge,
            walletMaxBtcTransfer,
            walletClosingPeriod
        );
    }

    /// @notice Begins the wallet creation max btc balance update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newWalletCreationMaxBtcBalance New wallet creation max btc
    ///         balance.
    function beginWalletCreationMaxBtcBalanceUpdate(
        uint64 _newWalletCreationMaxBtcBalance
    ) external onlyOwner {
        walletData.beginWalletCreationMaxBtcBalanceUpdate(
            _newWalletCreationMaxBtcBalance
        );
    }

    /// @notice Finalizes the wallet creation max btc balance update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeWalletCreationMaxBtcBalanceUpdate() external onlyOwner {
        (
            uint32 walletCreationPeriod,
            uint64 walletCreationMinBtcBalance,
            ,
            uint64 walletClosureMinBtcBalance,
            uint32 walletMaxAge,
            uint64 walletMaxBtcTransfer,
            uint32 walletClosingPeriod
        ) = bridge.walletParameters();
        uint64 newWalletCreationMaxBtcBalance = walletData
            .newWalletCreationMaxBtcBalance;
        walletData.finalizeWalletCreationMaxBtcBalanceUpdate(governanceDelay());
        bridge.updateWalletParameters(
            walletCreationPeriod,
            walletCreationMinBtcBalance,
            newWalletCreationMaxBtcBalance,
            walletClosureMinBtcBalance,
            walletMaxAge,
            walletMaxBtcTransfer,
            walletClosingPeriod
        );
    }

    /// @notice Begins the wallet closure min btc balance update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newWalletClosureMinBtcBalance New wallet closure min btc balance.
    function beginWalletClosureMinBtcBalanceUpdate(
        uint64 _newWalletClosureMinBtcBalance
    ) external onlyOwner {
        walletData.beginWalletClosureMinBtcBalanceUpdate(
            _newWalletClosureMinBtcBalance
        );
    }

    /// @notice Finalizes the wallet closure min btc balance update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeWalletClosureMinBtcBalanceUpdate() external onlyOwner {
        (
            uint32 walletCreationPeriod,
            uint64 walletCreationMinBtcBalance,
            uint64 walletCreationMaxBtcBalance,
            ,
            uint32 walletMaxAge,
            uint64 walletMaxBtcTransfer,
            uint32 walletClosingPeriod
        ) = bridge.walletParameters();
        uint64 newWalletClosureMinBtcBalance = walletData
            .newWalletClosureMinBtcBalance;
        walletData.finalizeWalletClosureMinBtcBalanceUpdate(governanceDelay());
        bridge.updateWalletParameters(
            walletCreationPeriod,
            walletCreationMinBtcBalance,
            walletCreationMaxBtcBalance,
            newWalletClosureMinBtcBalance,
            walletMaxAge,
            walletMaxBtcTransfer,
            walletClosingPeriod
        );
    }

    /// @notice Begins the wallet max age update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newWalletMaxAge New wallet max age.
    function beginWalletMaxAgeUpdate(uint32 _newWalletMaxAge)
        external
        onlyOwner
    {
        walletData.beginWalletMaxAgeUpdate(_newWalletMaxAge);
    }

    /// @notice Finalizes the wallet max age update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeWalletMaxAgeUpdate() external onlyOwner {
        (
            uint32 walletCreationPeriod,
            uint64 walletCreationMinBtcBalance,
            uint64 walletCreationMaxBtcBalance,
            uint64 walletClosureMinBtcBalance,
            ,
            uint64 walletMaxBtcTransfer,
            uint32 walletClosingPeriod
        ) = bridge.walletParameters();
        uint32 newWalletMaxAge = walletData.newWalletMaxAge;
        walletData.finalizeWalletMaxAgeUpdate(governanceDelay());
        bridge.updateWalletParameters(
            walletCreationPeriod,
            walletCreationMinBtcBalance,
            walletCreationMaxBtcBalance,
            walletClosureMinBtcBalance,
            newWalletMaxAge,
            walletMaxBtcTransfer,
            walletClosingPeriod
        );
    }

    /// @notice Begins the wallet max btc transfer amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newWalletMaxBtcTransfer New wallet max btc transfer.
    function beginWalletMaxBtcTransferUpdate(uint64 _newWalletMaxBtcTransfer)
        external
        onlyOwner
    {
        walletData.beginWalletMaxBtcTransferUpdate(_newWalletMaxBtcTransfer);
    }

    /// @notice Finalizes the wallet max btc transfer amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeWalletMaxBtcTransferUpdate() external onlyOwner {
        (
            uint32 walletCreationPeriod,
            uint64 walletCreationMinBtcBalance,
            uint64 walletCreationMaxBtcBalance,
            uint64 walletClosureMinBtcBalance,
            uint32 walletMaxAge,
            ,
            uint32 walletClosingPeriod
        ) = bridge.walletParameters();
        uint64 newWalletMaxBtcTransfer = walletData.newWalletMaxBtcTransfer;
        walletData.finalizeWalletMaxBtcTransferUpdate(governanceDelay());
        bridge.updateWalletParameters(
            walletCreationPeriod,
            walletCreationMinBtcBalance,
            walletCreationMaxBtcBalance,
            walletClosureMinBtcBalance,
            walletMaxAge,
            newWalletMaxBtcTransfer,
            walletClosingPeriod
        );
    }

    /// @notice Begins the wallet closing period update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newWalletClosingPeriod New wallet closing period.
    function beginWalletClosingPeriodUpdate(uint32 _newWalletClosingPeriod)
        external
        onlyOwner
    {
        walletData.beginWalletClosingPeriodUpdate(_newWalletClosingPeriod);
    }

    /// @notice Finalizes the wallet closing period update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeWalletClosingPeriodUpdate() external onlyOwner {
        (
            uint32 walletCreationPeriod,
            uint64 walletCreationMinBtcBalance,
            uint64 walletCreationMaxBtcBalance,
            uint64 walletClosureMinBtcBalance,
            uint32 walletMaxAge,
            uint64 walletMaxBtcTransfer,

        ) = bridge.walletParameters();
        uint32 newWalletClosingPeriod = walletData.newWalletClosingPeriod;
        walletData.finalizeWalletClosingPeriodUpdate(governanceDelay());
        bridge.updateWalletParameters(
            walletCreationPeriod,
            walletCreationMinBtcBalance,
            walletCreationMaxBtcBalance,
            walletClosureMinBtcBalance,
            walletMaxAge,
            walletMaxBtcTransfer,
            newWalletClosingPeriod
        );
    }

    // --- Fraud

    /// @notice Begins the fraud challenge deposit amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newFraudChallengeDepositAmount New fraud challenge deposit amount.
    function beginFraudChallengeDepositAmountUpdate(
        uint96 _newFraudChallengeDepositAmount
    ) external onlyOwner {
        fraudData.beginFraudChallengeDepositAmountUpdate(
            _newFraudChallengeDepositAmount
        );
    }

    /// @notice Finalizes the fraud challenge deposit amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeFraudChallengeDepositAmountUpdate() external onlyOwner {
        (
            ,
            uint32 fraudChallengeDefeatTimeout,
            uint96 fraudSlashingAmount,
            uint32 fraudNotifierRewardMultiplier
        ) = bridge.fraudParameters();
        uint96 newFraudChallengeDepositAmount = fraudData
            .newFraudChallengeDepositAmount;
        fraudData.finalizeFraudChallengeDepositAmountUpdate(governanceDelay());
        bridge.updateFraudParameters(
            newFraudChallengeDepositAmount,
            fraudChallengeDefeatTimeout,
            fraudSlashingAmount,
            fraudNotifierRewardMultiplier
        );
    }

    /// @notice Begins the fraud challenge defeat timeout update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newFraudChallengeDefeatTimeout New fraud challenge defeat timeout.
    function beginFraudChallengeDefeatTimeoutUpdate(
        uint32 _newFraudChallengeDefeatTimeout
    ) external onlyOwner {
        fraudData.beginFraudChallengeDefeatTimeoutUpdate(
            _newFraudChallengeDefeatTimeout
        );
    }

    /// @notice Finalizes the fraud challenge defeat timeout update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeFraudChallengeDefeatTimeoutUpdate() external onlyOwner {
        (
            uint96 fraudChallengeDepositAmount,
            ,
            uint96 fraudSlashingAmount,
            uint32 fraudNotifierRewardMultiplier
        ) = bridge.fraudParameters();
        uint32 newFraudChallengeDefeatTimeout = fraudData
            .newFraudChallengeDefeatTimeout;
        fraudData.finalizeFraudChallengeDefeatTimeoutUpdate(governanceDelay());
        bridge.updateFraudParameters(
            fraudChallengeDepositAmount,
            newFraudChallengeDefeatTimeout,
            fraudSlashingAmount,
            fraudNotifierRewardMultiplier
        );
    }

    /// @notice Begins the fraud slashing amount update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newFraudSlashingAmount New fraud slashing amount.
    function beginFraudSlashingAmountUpdate(uint96 _newFraudSlashingAmount)
        external
        onlyOwner
    {
        fraudData.beginFraudSlashingAmountUpdate(_newFraudSlashingAmount);
    }

    /// @notice Finalizes the fraud slashing amount update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeFraudSlashingAmountUpdate() external onlyOwner {
        (
            uint96 fraudChallengeDepositAmount,
            uint32 fraudChallengeDefeatTimeout,
            ,
            uint32 fraudNotifierRewardMultiplier
        ) = bridge.fraudParameters();
        uint96 newFraudSlashingAmount = fraudData.newFraudSlashingAmount;
        fraudData.finalizeFraudSlashingAmountUpdate(governanceDelay());
        bridge.updateFraudParameters(
            fraudChallengeDepositAmount,
            fraudChallengeDefeatTimeout,
            newFraudSlashingAmount,
            fraudNotifierRewardMultiplier
        );
    }

    /// @notice Begins the fraud notifier reward multiplier update process.
    /// @dev Can be called only by the contract owner.
    /// @param _newFraudNotifierRewardMultiplier New fraud notifier reward
    ///         multiplier.
    function beginFraudNotifierRewardMultiplierUpdate(
        uint32 _newFraudNotifierRewardMultiplier
    ) external onlyOwner {
        fraudData.beginFraudNotifierRewardMultiplierUpdate(
            _newFraudNotifierRewardMultiplier
        );
    }

    /// @notice Finalizes the fraud notifier reward multiplier update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeFraudNotifierRewardMultiplierUpdate() external onlyOwner {
        (
            uint96 fraudChallengeDepositAmount,
            uint32 fraudChallengeDefeatTimeout,
            uint96 fraudSlashingAmount,

        ) = bridge.fraudParameters();
        uint32 newFraudNotifierRewardMultiplier = fraudData
            .newFraudNotifierRewardMultiplier;
        fraudData.finalizeFraudNotifierRewardMultiplierUpdate(
            governanceDelay()
        );
        bridge.updateFraudParameters(
            fraudChallengeDepositAmount,
            fraudChallengeDefeatTimeout,
            fraudSlashingAmount,
            newFraudNotifierRewardMultiplier
        );
    }

    /// @notice Begins the treasury address update process.
    /// @dev Can be called only by the contract owner. It does not perform
    ///      any parameter validation.
    /// @param _newTreasury New treasury address.
    function beginTreasuryUpdate(address _newTreasury) external onlyOwner {
        treasuryData.beginTreasuryUpdate(_newTreasury);
    }

    /// @notice Finalizes the treasury address update process.
    /// @dev Can be called only by the contract owner, after the governance
    ///      delay elapses.
    function finalizeTreasuryUpdate() external onlyOwner {
        address newTreasury = treasuryData.newTreasury;
        treasuryData.finalizeTreasuryUpdate(governanceDelay());
        bridge.updateTreasury(newTreasury);
    }

    /// @notice Gets the governance delay parameter.
    function governanceDelay() internal view returns (uint256) {
        return governanceDelays[0];
    }

    /// @notice Sets the redemption watchtower address. This function does not
    ///         have a governance delay as setting the redemption watchtower is
    ///         a one-off action performed during initialization of the
    ///         redemption veto mechanism.
    /// @param redemptionWatchtower Address of the redemption watchtower.
    /// @dev Requirements:
    ///      - The caller must be the owner,
    ///      - Redemption watchtower address must not be already set,
    ///      - Redemption watchtower address must not be 0x0.
    function setRedemptionWatchtower(address redemptionWatchtower)
        external
        onlyOwner
    {
        bridge.setRedemptionWatchtower(redemptionWatchtower);
    }

    /// @notice Sets the rebate staking address.
    /// @param rebateStaking Address of the rebate staking.
    /// @dev Requirements:
    ///      - Rebate staking address must not be already set,
    ///      - Rebate staking address must not be 0x0.
    function setRebateStaking(address rebateStaking) external onlyOwner {
        bridge.setRebateStaking(rebateStaking);
    }
}
