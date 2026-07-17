// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @title IStarkGateBridge Interface
/// @notice Interface for the StarkGate bridge contract that enables L1→L2 token transfers
interface IStarkGateBridge {
    /// @notice Deposits tokens to StarkNet L2 without a message
    /// @dev This function locks tokens on L1 and mints them on L2
    /// @param token The address of the ERC-20 token to deposit
    /// @param amount The amount of tokens to deposit
    /// @param l2Recipient The recipient address on StarkNet L2 (as uint256)
    function deposit(
        address token,
        uint256 amount,
        uint256 l2Recipient
    ) external payable;

    /// @notice Estimates the fee required for L1→L2 message
    /// @return The estimated fee in wei
    function estimateDepositFeeWei() external view returns (uint256);
}
