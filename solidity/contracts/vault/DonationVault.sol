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

import "./IVault.sol";
import "../bank/Bank.sol";

/// @title BTC donation vault
/// @notice Vault that allows making BTC donations to the system. Upon deposit,
///         this vault does not increase depositors' balances and always
///         decreases its own balance in the same transaction. The vault also
///         allows making donations using existing Bank balances.
///
///         BEWARE: ALL BTC DEPOSITS TARGETING THIS VAULT ARE NOT REDEEMABLE
///         AND THERE IS NO WAY TO RESTORE THE DONATED BALANCE.
///         USE THIS VAULT ONLY WHEN YOU REALLY KNOW WHAT YOU ARE DOING!
contract DonationVault is IVault {
    Bank public bank;

    event DonationReceived(address donor, uint256 donatedAmount);

    modifier onlyBank() {
        require(msg.sender == address(bank), "Caller is not the Bank");
        _;
    }

    constructor(Bank _bank) {
        require(
            address(_bank) != address(0),
            "Bank can not be the zero address"
        );

        bank = _bank;
    }

    /// @notice Transfers the given `amount` of the Bank balance from the
    ///         caller to the Donation Vault and immediately decreases the
    ///         vault's balance in the Bank by the transferred `amount`.
    /// @param amount Amount of the Bank balance to donate.
    /// @dev Requirements:
    ///      - The caller's balance in the Bank must be greater than or equal
    ///        to the `amount`,
    ///      - Donation Vault must have an allowance for caller's balance in
    ///        the Bank for at least `amount`.
    function donate(uint256 amount) external {
        require(
            bank.balanceOf(msg.sender) >= amount,
            "Amount exceeds balance in the bank"
        );

        emit DonationReceived(msg.sender, amount);

        bank.transferBalanceFrom(msg.sender, address(this), amount);
        bank.decreaseBalance(amount);
    }

    /// @notice Transfers the given `amount` of the Bank balance from the
    ///         `owner` to the Donation Vault and immediately decreases the
    ///         vault's balance in the Bank by the transferred `amount`.
    /// @param owner Address of the Bank balance owner who approved their
    ///        balance to be used by the vault.
    /// @param amount The amount of the Bank balance approved by the owner
    ///        to be used by the vault.
    /// @dev Requirements:
    ///      - Can only be called by the Bank via `approveBalanceAndCall`,
    ///      - The `owner` balance in the Bank must be greater than or equal
    ///        to the `amount`.
    function receiveBalanceApproval(
        address owner,
        uint256 amount,
        bytes memory
    ) external override onlyBank {
        require(
            bank.balanceOf(owner) >= amount,
            "Amount exceeds balance in the bank"
        );

        emit DonationReceived(owner, amount);

        bank.transferBalanceFrom(owner, address(this), amount);
        bank.decreaseBalance(amount);
    }

    /// @notice Ignores the deposited amounts and does not increase depositors'
    ///         individual balances. The vault decreases its own tBTC balance
    ///         in the Bank by the total deposited amount.
    /// @param depositors Addresses of depositors whose deposits have been swept.
    /// @param depositedAmounts Amounts deposited by individual depositors and
    ///        swept.
    /// @dev Requirements:
    ///      - Can only be called by the Bank after the Bridge swept deposits
    ///        and Bank increased balance for the vault,
    ///      - The `depositors` array must not be empty,
    ///      - The `depositors` array length must be equal to the
    ///        `depositedAmounts` array length.
    function receiveBalanceIncrease(
        address[] calldata depositors,
        uint256[] calldata depositedAmounts
    ) external override onlyBank {
        require(depositors.length != 0, "No depositors specified");

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < depositors.length; i++) {
            totalAmount += depositedAmounts[i];
            emit DonationReceived(depositors[i], depositedAmounts[i]);
        }

        bank.decreaseBalance(totalAmount);
    }
}
