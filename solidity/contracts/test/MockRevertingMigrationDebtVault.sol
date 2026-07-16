// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../vault/ITBTCVaultMigrationDebt.sol";

contract MockRevertingMigrationDebtVault is ITBTCVaultMigrationDebt {
    mapping(address => uint256) public override migrationDebt;
    mapping(address => bool) public override isMigrationRevealer;

    bool public shouldRevert;
    bool private _hasOutstandingMigrationDebt;
    bool private _hasOutstandingOptimisticMintingDebtFlag;

    function setReverting(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function setHasOutstandingMigrationDebt(bool hasDebt) external {
        _hasOutstandingMigrationDebt = hasDebt;
    }

    function setHasOutstandingOptimisticMintingDebt(bool hasDebt) external {
        _hasOutstandingOptimisticMintingDebtFlag = hasDebt;
    }

    function registerMigrationDebt(address revealer, uint256 amount)
        external
        override
    {
        migrationDebt[revealer] = migrationDebt[revealer] + amount;
        if (amount > 0) {
            _hasOutstandingMigrationDebt = true;
        }
        emit MigrationDebtRegistered(revealer, amount);
    }

    function setMigrationRevealer(address revealer, bool allowed)
        external
        override
    {
        isMigrationRevealer[revealer] = allowed;
        emit MigrationRevealerSet(revealer, allowed);
    }

    function clearMigrationDebt(address revealer) external override {
        uint256 debt = migrationDebt[revealer];
        migrationDebt[revealer] = 0;
        _hasOutstandingMigrationDebt = false;
        emit MigrationDebtCleared(revealer, debt);
    }

    function canRevealMigration(address revealer)
        external
        view
        override
        returns (bool)
    {
        return isMigrationRevealer[revealer] && migrationDebt[revealer] > 0;
    }

    function hasOutstandingMigrationDebt()
        external
        view
        override
        returns (bool)
    {
        require(!shouldRevert, "Mock migration debt vault revert");
        return _hasOutstandingMigrationDebt;
    }

    function hasOutstandingOptimisticMintingDebt()
        external
        view
        override
        returns (bool)
    {
        require(!shouldRevert, "Mock migration debt vault revert");
        return _hasOutstandingOptimisticMintingDebtFlag;
    }
}
