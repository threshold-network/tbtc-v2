// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.0;

import "../integrator/IBank.sol";
import "../integrator/IRedemptionWatchtowerWithdrawal.sol";

/// @notice Minimal RedemptionWatchtower mock used to exercise the integrator's
///         vetoed-funds withdrawal path. On withdrawal it transfers the
///         configured Bank balance to the caller, mirroring the production
///         `withdrawVetoedFunds` behaviour.
contract MockRedemptionWatchtower is IRedemptionWatchtowerWithdrawal {
    IBank public bank;
    mapping(uint256 => uint64) public withdrawableAmount;

    constructor(address _bank) {
        bank = IBank(_bank);
    }

    function setWithdrawableAmount(uint256 redemptionKey, uint64 amount)
        external
    {
        withdrawableAmount[redemptionKey] = amount;
    }

    function withdrawVetoedFunds(uint256 redemptionKey) external override {
        uint64 amount = withdrawableAmount[redemptionKey];
        require(amount > 0, "No funds to withdraw");
        withdrawableAmount[redemptionKey] = 0;
        bank.transferBalance(msg.sender, amount);
    }
}
