// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity ^0.8.17;

/// @title IReceiveBalanceApproval
/// @notice `IReceiveBalanceApproval` is an interface for a smart contract
///         consuming Bank balances approved to them in the same transaction by
///         other contracts or externally owned accounts (EOA).
interface IReceiveBalanceApproval {
    /// @notice Called by the Bank in `approveBalanceAndCall` function after
    ///         the balance `owner` approved `amount` of their balance in the
    ///         Bank for the contract. This way, the depositor can approve
    ///         balance and call the contract to use the approved balance in
    ///         a single transaction.
    /// @param owner Address of the Bank balance owner who approved their
    ///        balance to be used by the contract.
    /// @param amount The amount of the Bank balance approved by the owner
    ///        to be used by the contract.
    /// @param extraData The `extraData` passed to `Bank.approveBalanceAndCall`.
    /// @dev The implementation must ensure this function can only be called
    ///      by the Bank. The Bank does _not_ guarantee that the `amount`
    ///      approved by the `owner` currently exists on their balance. That is,
    ///      the `owner` could approve more balance than they currently have.
    ///      This works the same as `Bank.approve` function. The contract must
    ///      ensure the actual balance is checked before performing any action
    ///      based on it.
    function receiveBalanceApproval(
        address owner,
        uint256 amount,
        bytes calldata extraData
    ) external;
}
