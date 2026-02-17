// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal mock implementing the Vault-like unmint interface expected
///         by MintBurnGuard in tests.
contract MockBurnVault {
    uint256 public lastUnmintAmount;

    function unmint(uint256 amount) external {
        lastUnmintAmount = amount;
    }
}
