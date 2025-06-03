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
    /// @return The nonce of the L1→L2 message
    function deposit(
        address token,
        uint256 amount,
        uint256 l2Recipient
    ) external payable returns (uint256);

    /// @notice Deposits tokens to StarkNet L2 with a message
    /// @dev This function locks tokens on L1 and mints them on L2 with additional data
    /// @param token The address of the ERC-20 token to deposit
    /// @param amount The amount of tokens to deposit
    /// @param l2Recipient The recipient address on StarkNet L2 (as uint256)
    /// @param message Message data for L2 contract execution
    /// @return The nonce of the L1→L2 message
    function depositWithMessage(
        address token,
        uint256 amount,
        uint256 l2Recipient,
        uint256[] calldata message
    ) external payable returns (uint256);

    /// @notice Estimates the fee required for L1→L2 message
    /// @return The estimated fee in wei
    function estimateMessageFee() external view returns (uint256);

    /// @notice Cancels a failed deposit after the waiting period
    /// @param token The token that was deposited
    /// @param amount The amount that was deposited
    /// @param l2Recipient The L2 recipient of the failed deposit
    /// @param message The message data from the failed deposit
    /// @param nonce The nonce of the failed deposit
    function depositWithMessageCancelRequest(
        address token,
        uint256 amount,
        uint256 l2Recipient,
        uint256[] calldata message,
        uint256 nonce
    ) external;

    /// @notice Gets the current nonce for L1→L2 messages
    /// @return The current nonce value
    function l1ToL2MessageNonce() external view returns (uint256);

    /// @notice Checks if a deposit can be cancelled
    /// @param nonce The nonce of the deposit to check
    /// @return Whether the deposit can be cancelled
    function isDepositCancellable(uint256 nonce) external view returns (bool);
}
