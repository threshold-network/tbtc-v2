// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../../../../contracts/integrator/IBridge.sol";

contract MockTBTCBridge is IBridge {
    mapping(uint256 => IBridgeTypes.DepositRequest) private _deposits;

    // Track calls for testing
    bool public initializeDepositCalled;
    uint256 public nextDepositKey;

    // Events to match real Bridge
    event DepositRevealed(uint256 indexed depositKey);

    constructor() {
        nextDepositKey = 12345; // Default test value
    }

    function revealDepositWithExtraData(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 extraData
    ) external {
        initializeDepositCalled = true;

        // Use predefined deposit key for testing
        uint256 depositKey = nextDepositKey;

        // Create mock deposit
        _deposits[depositKey] = IBridgeTypes.DepositRequest({
            depositor: msg.sender,
            amount: 100000000, // 1 BTC in satoshi
            revealedAt: uint32(block.timestamp),
            vault: reveal.vault,
            treasuryFee: 1000000, // 0.01 BTC in satoshi
            sweptAt: uint32(block.timestamp + 1),
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
        _deposits[depositKey].sweptAt = uint32(block.timestamp);
    }
}
