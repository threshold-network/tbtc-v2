// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../integrator/IBridge.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";

contract MockBridgeForStarkNet is IBridge {
    using BTCUtils for bytes;

    mapping(uint256 => IBridgeTypes.DepositRequest) private _deposits;

    // Track calls for testing
    bool public initializeDepositCalled;
    uint256 public lastDepositKey;
    mapping(uint256 => bool) public depositExists;

    // Events to match real Bridge
    event DepositRevealed(bytes32 indexed depositKey);

    constructor() {
        // Remove the fixed depositKey initialization
    }

    function revealDepositWithExtraData(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external {
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

    function getLastDepositKey() external view returns (uint256) {
        return lastDepositKey;
    }

    function resetMock() external {
        initializeDepositCalled = false;
        lastDepositKey = 0;
    }

    function sweepDeposit(uint256 depositKey) external {
        require(depositExists[depositKey], "Deposit does not exist");
        _deposits[depositKey].sweptAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
    }
}
