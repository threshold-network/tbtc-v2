// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.17;

import "@thesis/solidity-contracts/contracts/token/ERC20WithPermit.sol";

contract TestERC20 is ERC20WithPermit {
    string public constant NAME = "Test ERC20 Token";
    string public constant SYMBOL = "TT";

    constructor() ERC20WithPermit(NAME, SYMBOL) {}
}
