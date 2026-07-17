// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../integrator/IBridge.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";

contract MockBridgeForStarkNet is IBridge {
    using BTCUtils for bytes;

    // Added for redemption mocks
    mapping(uint256 => IBridgeTypes.RedemptionRequest)
        internal _pendingRedemptions;

    uint64 internal _redemptionDustThreshold = 50000; // 0.0005 BTC
    uint64 internal _redemptionTreasuryFeeDivisor = 200; // 0.5%
    uint64 internal _redemptionTxMaxFee = 10000; // 0.0001 BTC
    uint64 internal _redemptionTxMaxTotalFee = 50000; // 0.0005 BTC
    uint32 internal _redemptionTimeout = 6 * 3600; // 6 hours in seconds
    uint96 internal _redemptionTimeoutSlashingAmount = 10**18; // 1 TBTC with 18 decimals
    uint32 internal _redemptionTimeoutNotifierRewardMultiplier = 5; // 5%

    mapping(uint256 => IBridgeTypes.DepositRequest) private _deposits;

    // Track calls for testing
    bool public initializeDepositCalled;
    uint256 public lastDepositKey;
    mapping(uint256 => bool) public depositExists;

    // Events to match real Bridge
    event DepositRevealed(bytes32 indexed depositKey);
    // Added for redemption mocks
    event RedemptionRequestedMock(
        bytes20 walletPubKeyHash,
        uint64 amount,
        bytes redeemerOutputScript,
        uint256 redemptionKey
    );

    constructor() {
        // Remove the fixed depositKey initialization
    }

    function revealDepositWithExtraData(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external override {
        initializeDepositCalled = true;

        // Calculate deposit key the same way as AbstractBTCDepositor
        bytes32 fundingTxHash = abi
            .encodePacked(
                fundingTx.version,
                fundingTx.inputVector,
                fundingTx.outputVector,
                fundingTx.locktime
            )
            .hash256View();

        uint256 depositKey = uint256(
            keccak256(
                abi.encodePacked(fundingTxHash, reveal.fundingOutputIndex)
            )
        );

        lastDepositKey = depositKey;

        // Create mock deposit
        _deposits[depositKey] = IBridgeTypes.DepositRequest({
            depositor: msg.sender,
            amount: 88800000, // Amount in satoshi that results in expectedTbtcAmount after fees
            revealedAt: uint32(block.timestamp), // solhint-disable-line not-rely-on-time
            vault: reveal.vault,
            treasuryFee: 898000, // Treasury fee in satoshi
            sweptAt: 0, // Not swept yet
            extraData: extraData
        });
        depositExists[depositKey] = true;

        emit DepositRevealed(bytes32(depositKey));
    }

    function resetMock() external {
        initializeDepositCalled = false;
        lastDepositKey = 0;
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

    function sweepDeposit(uint256 depositKey) external {
        require(depositExists[depositKey], "Deposit does not exist");
        _deposits[depositKey].sweptAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    function deposits(uint256 depositKey)
        external
        view
        override
        returns (IBridgeTypes.DepositRequest memory)
    {
        return _deposits[depositKey];
    }

    // Test helper functions
    function wasInitializeDepositCalled() external view returns (bool) {
        return initializeDepositCalled;
    }

    function getLastDepositKey() external view returns (uint256) {
        return lastDepositKey;
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
}
