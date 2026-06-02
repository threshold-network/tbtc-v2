// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal mock TBTC token for testing.
contract MockTBTC is ERC20 {
    constructor() ERC20("Test TBTC", "TBTC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Minimal mock implementing the Vault-like unmint interface expected
///         by MintBurnGuard in tests.
contract MockBurnVault {
    uint256 public lastUnmintAmount;
    address public immutable tbtcToken;
    address public immutable bank;
    address public immutable bridge;

    constructor(address bank_, address bridge_) {
        MockTBTC token = new MockTBTC();
        tbtcToken = address(token);
        bank = bank_;
        bridge = bridge_;
    }

    function unmint(uint256 amount) external {
        lastUnmintAmount = amount;
        // The real vault burns TBTC from the caller and gives them Bank balance.
        // In this mock, we transfer from caller (guard) to this vault.
        // The guard must have approved this vault to spend its TBTC.
        MockTBTC(tbtcToken).transferFrom(msg.sender, address(this), amount);

        // In reality, vault would give Bank balance to caller here
        // but our mock just tracks the unmint amount
    }
}
