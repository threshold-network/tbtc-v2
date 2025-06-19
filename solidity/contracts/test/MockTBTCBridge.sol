// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../integrator/IBridge.sol";

contract MockTBTCBridge is IBridge {
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
}
