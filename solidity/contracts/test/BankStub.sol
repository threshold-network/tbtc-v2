// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.17;

import "../bank/Bank.sol";

contract BankStub is Bank {
    function setBalance(address addr, uint256 amount) external {
        balanceOf[addr] = amount;
    }
}
