// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../../../../contracts/integrator/ITBTCVault.sol";

contract MockTBTCVault is ITBTCVault {
    address public override tbtcToken;
    mapping(uint256 => uint64) private _finalizedAt;

    // Test data storage
    struct DepositInfo {
        uint256 initialAmount;
        uint256 tbtcAmount;
        bytes32 l2DepositOwner;
        bool exists;
    }
    mapping(uint256 => DepositInfo) private _deposits;

    constructor() {
        // Will be set via setTbtcToken
    }

    function setTbtcToken(address _tbtcToken) external {
        tbtcToken = _tbtcToken;
    }

    function optimisticMintingRequests(uint256 depositKey)
        external
        view
        override
        returns (uint64 requestedAt, uint64 finalizedAt)
    {
        return (uint64(block.timestamp), _finalizedAt[depositKey]);
    }

    function optimisticMintingFeeDivisor()
        external
        pure
        override
        returns (uint32)
    {
        return 1000; // 0.1% fee
    }

    // Test helper functions
    function setOptimisticMintingFinalized(uint256 depositKey) external {
        _finalizedAt[depositKey] = uint64(block.timestamp);
    }

    function setDepositInfo(
        uint256 depositKey,
        uint256 initialAmount,
        uint256 tbtcAmount,
        bytes32 l2DepositOwner
    ) external {
        _deposits[depositKey] = DepositInfo({
            initialAmount: initialAmount,
            tbtcAmount: tbtcAmount,
            l2DepositOwner: l2DepositOwner,
            exists: true
        });
    }

    function getDepositInfo(uint256 depositKey)
        external
        view
        returns (
            uint256 initialAmount,
            uint256 tbtcAmount,
            bytes32 l2DepositOwner
        )
    {
        DepositInfo memory deposit = _deposits[depositKey];
        require(deposit.exists, "Deposit does not exist");
        return (
            deposit.initialAmount,
            deposit.tbtcAmount,
            deposit.l2DepositOwner
        );
    }

    function isOptimisticMintingFinalized(bytes32 depositKey)
        external
        view
        returns (bool)
    {
        return _finalizedAt[uint256(depositKey)] > 0;
    }
}
