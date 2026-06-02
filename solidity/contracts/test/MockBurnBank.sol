// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal mock implementing the Bank-like burn interface expected
///         by MintBurnGuard in tests.
contract MockBurnBank {
    uint256 public lastBurnAmount;
    address public lastTransferFrom;
    address public lastTransferTo;
    uint256 public lastTransferAmount;

    mapping(address => mapping(address => uint256)) private allowances;
    mapping(address => uint256) public balanceOf;

    function decreaseBalance(uint256 amount) external {
        lastBurnAmount = amount;
        if (balanceOf[msg.sender] >= amount) {
            balanceOf[msg.sender] -= amount;
        }
    }

    function transferBalanceFrom(
        address sender,
        address recipient,
        uint256 amount
    ) external {
        require(
            allowances[sender][msg.sender] >= amount,
            "MockBurnBank: insufficient allowance"
        );
        lastTransferFrom = sender;
        lastTransferTo = recipient;
        lastTransferAmount = amount;

        if (balanceOf[sender] >= amount) {
            balanceOf[sender] -= amount;
            balanceOf[recipient] += amount;
        } else {
            balanceOf[recipient] += amount;
        }

        allowances[sender][msg.sender] -= amount;
    }

    function approve(address spender, uint256 amount) external {
        allowances[msg.sender][spender] = amount;
    }

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }
}
