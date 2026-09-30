// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mintable token for local depositor tests.
contract TestERC20 is ERC20 {
    constructor() ERC20("Test tBTC", "TEST") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}
