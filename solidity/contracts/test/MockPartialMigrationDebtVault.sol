// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

contract MockPartialMigrationDebtVault {
    bool private _hasOutstandingMigrationDebt;

    function setHasOutstandingMigrationDebt(bool hasDebt) external {
        _hasOutstandingMigrationDebt = hasDebt;
    }

    function hasOutstandingMigrationDebt() external view returns (bool) {
        return _hasOutstandingMigrationDebt;
    }
}
