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

pragma solidity ^0.8.0;

/// @notice Interface of the Bank contract.
/// @dev See bank/Bank.sol
interface IBank {
    /// @notice Emitted when an approval for `spender` to transfer `value`
    ///         tokens from `owner` is set.
    event BalanceApproval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );

    /// @notice Emitted when `value` tokens are transferred from `from` to `to`.
    event TransferBalance(
        address indexed from,
        address indexed to,
        uint256 value
    );

    /// @notice Decrease the balance of the caller by `amount`.
    /// @param amount Amount to decrease.
    function decreaseBalance(uint256 amount) external;

    /// @notice Increase the allowance of the spender address.
    /// @param spender Address of the spender.
    /// @param amount Amount of the allowance to increase.
    function increaseBalanceAllowance(address spender, uint256 amount) external;

    /// @notice Returns the amount of tokens owned by `account`.
    function balanceAvailable(address account) external view returns (uint256);

    /// @notice Transfers `amount` tokens from `sender` to `recipient` using
    ///         the allowance mechanism.
    /// @param sender Address of the sender.
    /// @param recipient Address of the recipient.
    /// @param amount Amount of tokens to transfer.
    function transferBalanceFrom(
        address sender,
        address recipient,
        uint256 amount
    ) external;
}
