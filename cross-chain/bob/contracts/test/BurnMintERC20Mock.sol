// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract BurnMintERC20Mock is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    constructor(
        string memory name,
        string memory symbol,
        address initialHolder,
        uint256 initialSupply
    ) ERC20(name, symbol) {
        _grantRole(DEFAULT_ADMIN_ROLE, initialHolder);
        _grantRole(MINTER_ROLE, initialHolder);
        _grantRole(BURNER_ROLE, initialHolder);
        _mint(initialHolder, initialSupply);
    }

    function mint(address to, uint256 amount) public onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function burn(uint256 amount) public {
        _burn(_msgSender(), amount);
    }

    function burnFrom(address account, uint256 amount) public {
        _spendAllowance(account, _msgSender(), amount);
        _burn(account, amount);
    }

    // Allow burning from any address if caller has BURNER_ROLE
    function burnFromWithRole(
        address account,
        uint256 amount
    ) public onlyRole(BURNER_ROLE) {
        _burn(account, amount);
    }
}
