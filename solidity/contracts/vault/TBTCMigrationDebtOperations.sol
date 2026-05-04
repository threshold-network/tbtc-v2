// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

library TBTCMigrationDebtOperations {
    /// @notice Records the expected migration debt for a revealer address.
    /// @dev One-time registration; reverts if the revealer already has
    ///      outstanding debt. The amount is stored directly in the
    ///      provided mapping. The caller (TBTCOptimisticMinting) must
    ///      ensure the amount is in the correct precision (1e18). See
    ///      `ITBTCVaultMigrationDebt.registerMigrationDebt` for amount
    ///      convention guidance on gross vs. net registration.
    /// @param migrationDebt Storage mapping of revealer addresses to
    ///        outstanding debt amounts.
    /// @param revealer Migration revealer address. Must not be zero.
    /// @param amount Debt amount in 1e18 precision. Must be greater
    ///        than zero.
    /// @return The new debt balance for the revealer (equals `amount`
    ///         since registration starts from zero).
    function registerDebt(
        mapping(address => uint256) storage migrationDebt,
        address revealer,
        uint256 amount
    ) internal returns (uint256) {
        require(
            revealer != address(0),
            "Migration revealer can not be the zero address"
        );
        require(amount > 0, "Amount must be greater than 0");
        require(
            migrationDebt[revealer] == 0,
            "Migration debt already registered"
        );

        uint256 nextDebt = migrationDebt[revealer] + amount;
        migrationDebt[revealer] = nextDebt;
        return nextDebt;
    }

    function setRevealer(
        mapping(address => bool) storage isMigrationRevealer,
        address revealer,
        bool allowed
    ) internal {
        require(
            revealer != address(0),
            "Migration revealer can not be the zero address"
        );
        isMigrationRevealer[revealer] = allowed;
    }

    function setSweepReserve(
        mapping(address => address) storage migrationSweepReserve,
        mapping(address => bool) storage pendingMigrationSweepCompletion,
        address revealer,
        address reserve
    ) internal returns (bool) {
        require(
            revealer != address(0),
            "Migration revealer can not be the zero address"
        );

        migrationSweepReserve[revealer] = reserve;
        if (reserve == address(0) && pendingMigrationSweepCompletion[revealer]) {
            pendingMigrationSweepCompletion[revealer] = false;
            return true;
        }

        return false;
    }

    /// @notice Repays migration debt using sweep proceeds routed to the
    ///         vault by the Bridge.
    /// @dev The `amount` is post treasury fee and miner fee deduction;
    ///      it is the post-fee value the Bridge delivers to the vault
    ///      after processing a deposit sweep. Before routing funds,
    ///      `DepositSweep.submitDepositSweepProof` deducts from each
    ///      deposit:
    ///      1. A treasury fee: `depositAmount / depositTreasuryFeeDivisor`
    ///         (configured in BridgeState).
    ///      2. A Bitcoin miner fee share: the total sweep transaction fee
    ///         divided evenly across all deposits in the batch.
    ///
    ///      As a result, `amount` is strictly less than the original gross
    ///      deposit value when fees are non-zero.
    ///
    ///      Debt repayment outcomes:
    ///      - If `amount >= debt`: Debt is fully repaid.
    ///        `pendingMigrationSweepCompletion` is set to true, enabling
    ///        the downstream sweep completion callback. The excess
    ///        (`amount - debt`) is returned as `mintableAmount`.
    ///      - If `amount < debt`: Partial repayment. `mintableAmount` is
    ///        zero (all proceeds absorbed by outstanding debt). Remaining
    ///        debt decreases by `amount`.
    /// @param migrationDebt Storage mapping of revealer addresses to
    ///        outstanding debt.
    /// @param pendingMigrationSweepCompletion Storage flag set when debt
    ///        reaches zero for a revealer.
    /// @param revealer Address whose migration debt is being repaid.
    /// @param amount Post-fee sweep proceeds in 1e18 precision routed to
    ///        the vault for this revealer.
    /// @return mintableAmount tBTC amount to mint after debt absorption.
    ///         Zero if all proceeds are absorbed by outstanding debt.
    /// @return remainingDebt Outstanding debt after repayment. Zero if
    ///         debt is fully repaid.
    function repayDebt(
        mapping(address => uint256) storage migrationDebt,
        mapping(address => bool) storage pendingMigrationSweepCompletion,
        address revealer,
        uint256 amount
    ) internal returns (uint256, uint256) {
        uint256 debt = migrationDebt[revealer];
        if (debt == 0) {
            return (amount, 0);
        }

        if (amount >= debt) {
            migrationDebt[revealer] = 0;
            pendingMigrationSweepCompletion[revealer] = true;
            return (amount - debt, 0);
        }

        uint256 nextDebt = debt - amount;
        migrationDebt[revealer] = nextDebt;
        return (0, nextDebt);
    }

    function pullPendingSweepReserve(
        mapping(address => address) storage migrationSweepReserve,
        mapping(address => bool) storage pendingMigrationSweepCompletion,
        address revealer
    ) internal returns (address) {
        if (!pendingMigrationSweepCompletion[revealer]) {
            return address(0);
        }

        address reserve = migrationSweepReserve[revealer];
        if (reserve == address(0)) {
            return address(0);
        }

        pendingMigrationSweepCompletion[revealer] = false;
        migrationSweepReserve[revealer] = address(0);
        return reserve;
    }
}
