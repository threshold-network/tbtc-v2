// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

contract BridgeForVaultHarness {
    address public treasury;
    address public migrationDebtVault;

    constructor(address _treasury) {
        treasury = _treasury;
    }

    function setTreasury(address _treasury) external {
        treasury = _treasury;
    }

    function setMigrationDebtVault(address _migrationDebtVault) external {
        migrationDebtVault = _migrationDebtVault;
    }
}
