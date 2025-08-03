// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;

/// @notice Interface for CCIP Router
interface IRouter {
    /// @notice Gets the onRamp address for a given chain
    /// @param chainSelector The chain selector
    /// @return The onRamp address
    function getOnRamp(uint64 chainSelector) external view returns (address);

    /// @notice Checks if an address is an offRamp for a given chain
    /// @param chainSelector The chain selector
    /// @param offRamp The offRamp address to check
    /// @return True if the address is an offRamp
    function isOffRamp(
        uint64 chainSelector,
        address offRamp
    ) external view returns (bool);
}
