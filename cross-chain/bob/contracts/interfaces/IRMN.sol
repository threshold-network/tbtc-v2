// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;

/// @notice Interface for Risk Management Network
interface IRMN {
    /// @notice Checks if a chain is cursed by RMN
    /// @param chainId The chain ID to check
    /// @return True if the chain is cursed
    function isCursed(bytes16 chainId) external view returns (bool);
}
