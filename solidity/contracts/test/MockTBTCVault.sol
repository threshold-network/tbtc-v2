// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../integrator/ITBTCVault.sol";

contract MockTBTCVault is ITBTCVault {
    struct DepositInfo {
        address depositor;
        uint256 amount;
        uint32 revealedAt;
    }

    address public override tbtcToken;
    uint32 public override optimisticMintingFeeDivisor = 1000; // 0.1% fee
    mapping(uint256 => DepositInfo) private deposits;

    constructor() {
        // Will be set via setTbtcToken
    }

    function setTbtcToken(address _tbtcToken) external {
        tbtcToken = _tbtcToken;
    }

    function setOptimisticMintingFeeDivisor(uint32 _divisor) external {
        optimisticMintingFeeDivisor = _divisor;
    }

    function setDepositInfo(
        uint256 depositKey,
        address depositor,
        uint256 amount
    ) external {
        deposits[depositKey] = DepositInfo({
            depositor: depositor,
            amount: amount,
            revealedAt: uint32(block.timestamp) // solhint-disable-line not-rely-on-time
        });
    }

    function optimisticMintingRequests(uint256 depositKey)
        external
        view
        override
        returns (uint64 requestedAt, uint64 finalizedAt)
    {
        DepositInfo memory info = deposits[depositKey];
        if (info.revealedAt != 0) {
            return (uint64(info.revealedAt), uint64(block.timestamp)); // solhint-disable-line not-rely-on-time
        }
        return (0, 0);
    }

    function isOptimisticMintingFinalized(bytes32 depositKey)
        external
        view
        returns (bool)
    {
        DepositInfo memory info = deposits[uint256(depositKey)];
        return info.revealedAt != 0;
    }
}
