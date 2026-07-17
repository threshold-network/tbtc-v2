// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../integrator/IBridge.sol";

contract MockTBTCBridge is IBridge {
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

    // Added for redemption mocks
    event RedemptionRequestedMock(
        bytes20 walletPubKeyHash,
        uint64 amount,
        bytes redeemerOutputScript,
        uint256 redemptionKey
    );

    IBridgeTypes.DepositRequest public deposit;
    bool public depositRevealed;
    bytes32 public depositKey;

    // Events to match real Bridge
    event DepositRevealed(bytes32 indexed depositKey);

    function revealDepositWithExtraData(
        IBridgeTypes.BitcoinTxInfo calldata,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external {
        depositRevealed = true;
        depositKey = keccak256(abi.encode(reveal, extraData));

        deposit = IBridgeTypes.DepositRequest({
            depositor: msg.sender,
            amount: 100000000 - 12098,
            revealedAt: uint32(block.timestamp), // solhint-disable-line not-rely-on-time
            vault: reveal.vault,
            treasuryFee: 12098,
            sweptAt: uint32(block.timestamp), // solhint-disable-line not-rely-on-time
            extraData: extraData
        });

        emit DepositRevealed(depositKey);
    }

    function deposits(uint256)
        external
        view
        override
        returns (IBridgeTypes.DepositRequest memory)
    {
        return deposit;
    }

    // Helper functions for testing
    function resetMock() external {
        depositRevealed = false;
        depositKey = bytes32(0);
        deposit = IBridgeTypes.DepositRequest({
            depositor: address(0),
            amount: 0,
            revealedAt: 0,
            vault: address(0),
            treasuryFee: 0,
            sweptAt: 0,
            extraData: bytes32(0)
        });
    }

    function setDepositSweptAt(uint32 sweptAt) external {
        deposit.sweptAt = sweptAt;
    }

    function sweepDeposit() external {
        deposit.sweptAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
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
        return (0, 0, 1000000, 0);
    }

    // Function to allow tests to modify the redemptionTxMaxFee
    function setRedemptionTxMaxFeeInternal(uint64 newFee) external {
        _redemptionTxMaxFee = newFee;
    }

    // --- Redemption related mock functions ---
    function requestRedemption(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata, /*mainUtxo*/ // Marked unused
        bytes calldata redeemerOutputScript,
        uint64 amount
    ) external override {
        // Added override
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

    function pendingRedemptions(
        uint256 redemptionKey // Added override
    ) external view override returns (IBridgeTypes.RedemptionRequest memory) {
        return _pendingRedemptions[redemptionKey];
    }

    function redemptionParameters()
        external
        view
        override
        returns (
            // Added override
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
