// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal mock implementing the Bank-like burn interface expected
///         by MintBurnGuard in tests.
contract MockBurnBank {
    uint256 public lastBurnAmount;

    function decreaseBalance(uint256 amount) external {
        lastBurnAmount = amount;
    }
}
