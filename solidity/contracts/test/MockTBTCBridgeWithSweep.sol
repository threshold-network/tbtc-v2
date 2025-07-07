// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../integrator/IBridge.sol";

contract MockTBTCBridgeWithSweep is IBridge {
    mapping(uint256 => IBridgeTypes.DepositRequest) private _deposits;
    // Added for redemption mocks
    mapping(uint256 => IBridgeTypes.RedemptionRequest)
        internal _pendingRedemptions;

    uint64 internal _redemptionDustThreshold = 50000;
    uint64 internal _redemptionTreasuryFeeDivisor = 200;
    uint64 internal _redemptionTxMaxFee = 10000;
    uint64 internal _redemptionTxMaxTotalFee = 50000;
    uint32 internal _redemptionTimeout = 6 * 3600;
    uint96 internal _redemptionTimeoutSlashingAmount = 10**18;
    uint32 internal _redemptionTimeoutNotifierRewardMultiplier = 5;

    // Track calls for testing
    bool public initializeDepositCalled;
    uint256 public nextDepositKey;

    // Events to match real Bridge
    event DepositRevealed(uint256 indexed depositKey);
    // Added for redemption mocks
    event RedemptionRequestedMock(
        bytes20 walletPubKeyHash,
        uint64 amount,
        bytes redeemerOutputScript,
        uint256 redemptionKey
    );

    constructor() {
        nextDepositKey = 12345; // Default test value
    }

    function revealDepositWithExtraData(
        IBridgeTypes.BitcoinTxInfo calldata,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external {
        initializeDepositCalled = true;

        // Use predefined deposit key for testing
        uint256 depositKey = nextDepositKey;

        // Create mock deposit
        _deposits[depositKey] = IBridgeTypes.DepositRequest({
            depositor: msg.sender,
            amount: 88800000, // Amount in satoshi that results in expectedTbtcAmount after fees
            revealedAt: uint32(block.timestamp), // solhint-disable-line not-rely-on-time
            vault: reveal.vault,
            treasuryFee: 898000, // Treasury fee in satoshi
            sweptAt: 0, // Not swept initially
            extraData: extraData
        });

        emit DepositRevealed(depositKey);
    }

    function deposits(uint256 depositKey)
        external
        view
        override
        returns (IBridgeTypes.DepositRequest memory)
    {
        return _deposits[depositKey];
    }

    function depositParameters()
        external
        pure
        returns (
            uint64,
            uint64,
            uint64 depositTxMaxFee,
            uint32
        )
    {
        return (0, 0, 1000000, 0); // 0.01 BTC max fee
    }

    // Test helper functions
    function wasInitializeDepositCalled() external view returns (bool) {
        return initializeDepositCalled;
    }

    function setNextDepositKey(uint256 _nextDepositKey) external {
        nextDepositKey = _nextDepositKey;
    }

    function resetMock() external {
        initializeDepositCalled = false;
        nextDepositKey = 12345;
    }

    function sweepDeposit(uint256 depositKey) external {
        require(_deposits[depositKey].revealedAt != 0, "Deposit not revealed");
        _deposits[depositKey].sweptAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    // --- Redemption related mock functions ---
    function requestRedemption(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata, /*mainUtxo*/ // Marked unused
        bytes calldata redeemerOutputScript,
        uint64 amount
    ) external override {
        bytes32 scriptHash = keccak256(redeemerOutputScript);
        uint256 redemptionKey;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(0, scriptHash)
            mstore(32, walletPubKeyHash)
            redemptionKey := keccak256(0, 52)
        }

        require(
            _pendingRedemptions[redemptionKey].requestedAt == 0,
            "Redemption already requested"
        );

        _pendingRedemptions[redemptionKey] = IBridgeTypes.RedemptionRequest({
            redeemer: msg.sender,
            requestedAmount: amount,
            treasuryFee: _redemptionTreasuryFeeDivisor > 0
                ? amount / _redemptionTreasuryFeeDivisor
                : 0,
            txMaxFee: _redemptionTxMaxFee,
            requestedAt: uint32(block.timestamp) // solhint-disable-line not-rely-on-time
        });

        emit RedemptionRequestedMock(
            walletPubKeyHash,
            amount,
            redeemerOutputScript,
            redemptionKey
        );
    }

    function pendingRedemptions(uint256 redemptionKey)
        external
        view
        override
        returns (IBridgeTypes.RedemptionRequest memory)
    {
        return _pendingRedemptions[redemptionKey];
    }

    function redemptionParameters()
        external
        view
        override
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
        redemptionDustThreshold = _redemptionDustThreshold;
        redemptionTreasuryFeeDivisor = _redemptionTreasuryFeeDivisor;
        redemptionTxMaxFee = _redemptionTxMaxFee;
        redemptionTxMaxTotalFee = _redemptionTxMaxTotalFee;
        redemptionTimeout = _redemptionTimeout;
        redemptionTimeoutSlashingAmount = _redemptionTimeoutSlashingAmount;
        redemptionTimeoutNotifierRewardMultiplier = _redemptionTimeoutNotifierRewardMultiplier;
    }
}
