// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../vault/ITBTCVaultMigrationDebt.sol";

contract MockMigrationDebtVault is ITBTCVaultMigrationDebt {
    mapping(address => uint256) public override migrationDebt;
    mapping(address => bool) public override isMigrationRevealer;

    // Tracks the number of revealers with nonzero outstanding debt.
    uint256 private _outstandingDebtRevealerCount;

    // Test-controlled flag mirroring outstanding optimistic minting debt.
    bool private _hasOutstandingOptimisticMintingDebtFlag;

    function registerMigrationDebt(address revealer, uint256 amount)
        external
        override
    {
        bool hadDebt = migrationDebt[revealer] > 0;
        migrationDebt[revealer] = migrationDebt[revealer] + amount;
        if (!hadDebt && amount > 0) {
            _outstandingDebtRevealerCount++;
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
        require(debt > 0, "Migration debt not registered");

        migrationDebt[revealer] = 0;
        _outstandingDebtRevealerCount--;

        if (isMigrationRevealer[revealer]) {
            isMigrationRevealer[revealer] = false;
            emit MigrationRevealerSet(revealer, false);
        }

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

    /// @notice Returns true when at least one revealer has nonzero debt.
    function hasOutstandingMigrationDebt()
        external
        view
        override
        returns (bool)
    {
        return _outstandingDebtRevealerCount > 0;
    }

    /// @notice Allows tests to toggle the reported outstanding optimistic
    ///         minting debt state.
    function setHasOutstandingOptimisticMintingDebt(bool hasDebt) external {
        _hasOutstandingOptimisticMintingDebtFlag = hasDebt;
    }

    /// @notice Returns the test-controlled optimistic minting debt flag.
    function hasOutstandingOptimisticMintingDebt()
        external
        view
        override
        returns (bool)
    {
        return _hasOutstandingOptimisticMintingDebtFlag;
    }

    /// @notice Allows tests to simulate debt repayment by zeroing a
    ///         revealer's debt and decrementing the outstanding counter.
    function repayMigrationDebt(address revealer) external {
        if (migrationDebt[revealer] > 0) {
            _outstandingDebtRevealerCount--;
        }
        uint256 remaining = 0;
        migrationDebt[revealer] = 0;
        emit MigrationDebtRepaid(revealer, remaining);
    }
}
