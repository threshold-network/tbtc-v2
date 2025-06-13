// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.0;

import "../integrator/IBank.sol";

contract MockBank is IBank {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    function balanceAvailable(address account)
        external
        view
        override
        returns (uint256)
    {
        return _balances[account];
    }

    function increaseBalanceAllowance(address spender, uint256 amount)
        external
        override
    {
        _allowances[msg.sender][spender] += amount;
        emit BalanceApproval(
            msg.sender,
            spender,
            _allowances[msg.sender][spender]
        );
    }

    function transferBalanceFrom(
        address sender,
        address recipient,
        uint256 amount
    ) external override returns (bool) {
        uint256 currentAllowance = _allowances[sender][msg.sender];
        require(currentAllowance >= amount, "MockBank: insufficient allowance");
        require(_balances[sender] >= amount, "MockBank: insufficient balance");

        _balances[sender] -= amount;
        _balances[recipient] += amount;
        _allowances[sender][msg.sender] = currentAllowance - amount;

        emit TransferBalance(sender, recipient, amount);
        return true;
    }

    // Mock-specific functions for testing setup
    function setBalance(address account, uint256 amount) external {
        _balances[account] = amount;
    }

    function getAllowance(address owner, address spender)
        external
        view
        returns (uint256)
    {
        return _allowances[owner][spender];
    }
}
