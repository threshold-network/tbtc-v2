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

        // Registration starts from zero (enforced above), so the new debt
        // balance equals `amount`.
        migrationDebt[revealer] = amount;
        return amount;
    }

    /// @notice Sets or clears the migration revealer status for an address.
    /// @param isMigrationRevealer Storage mapping of revealer addresses to
    ///        their allowed status.
    /// @param revealer Address whose revealer status is being updated. Must
    ///        not be the zero address.
    /// @param allowed True to grant migration revealer status, false to revoke.
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

    /// @notice Sets or clears the migration sweep reserve for a revealer.
    /// @param migrationSweepReserve Storage mapping of revealer addresses to
    ///        their designated sweep reserve address.
    /// @param pendingMigrationSweepCompletion Storage mapping tracking whether
    ///        a revealer's debt reached zero but the downstream notifier
    ///        callback has not yet been consumed.
    /// @param revealer Address whose reserve mapping is being updated. Must
    ///        not be the zero address.
    /// @param reserve Reserve address for the migration sweep completion
    ///        callback. Passing address(0) clears the mapping and also drops
    ///        any queued pending completion for the revealer.
    /// @return True if a pending sweep completion was cleared, false otherwise.
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
        if (
            reserve == address(0) && pendingMigrationSweepCompletion[revealer]
        ) {
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
    ///        `pendingMigrationSweepCompletion` is set to true only when a
    ///        reserve is already configured for the revealer, enabling the
    ///        downstream sweep completion callback. When no reserve is
    ///        configured the flag is left unset so no stale completion can
    ///        later be replayed. The excess (`amount - debt`) is returned as
    ///        `mintableAmount`.
    ///      - If `amount < debt`: Partial repayment. `mintableAmount` is
    ///        zero (all proceeds absorbed by outstanding debt). Remaining
    ///        debt decreases by `amount`.
    /// @param migrationDebt Storage mapping of revealer addresses to
    ///        outstanding debt.
    /// @param pendingMigrationSweepCompletion Storage flag set when debt
    ///        reaches zero for a revealer and a reserve is configured.
    /// @param migrationSweepReserve Storage mapping of revealer addresses to
    ///        their designated sweep reserve; a full repayment only queues a
    ///        pending completion when this is non-zero for the revealer.
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
        mapping(address => address) storage migrationSweepReserve,
        address revealer,
        uint256 amount
    ) internal returns (uint256, uint256) {
        uint256 debt = migrationDebt[revealer];
        if (debt == 0) {
            return (amount, 0);
        }

        if (amount >= debt) {
            migrationDebt[revealer] = 0;
            // Queue a sweep completion only when a reserve is already
            // configured to receive it. Setting the flag with no reserve
            // configured would strand a pending completion: the notifier path
            // cannot deliver it (there is nothing to notify), yet a reserve
            // configured after the fact could later consume the stale flag and
            // replay a completion that is not tied to this repayment event.
            // Gating on a configured reserve makes the "pending flag without a
            // reserve" state unreachable, so the completion lifecycle stays
            // bound to the reserve that was set before the debt was repaid.
            if (migrationSweepReserve[revealer] != address(0)) {
                pendingMigrationSweepCompletion[revealer] = true;
            }
            return (amount - debt, 0);
        }

        uint256 nextDebt = debt - amount;
        migrationDebt[revealer] = nextDebt;
        return (0, nextDebt);
    }

    /// @notice Consumes a revealer's pending migration sweep completion,
    ///         returning the configured reserve to notify.
    /// @dev `repayDebt` only queues a pending completion when a reserve is
    ///      already configured, and every reserve-clearing path also clears the
    ///      pending flag, so a pending completion normally always has a
    ///      non-zero reserve here. The zero-reserve branch below is retained as
    ///      defense-in-depth: should that invariant ever be violated, the
    ///      pending flag is dropped rather than left set, since leaving it set
    ///      would allow a reserve configured after the fact to replay an
    ///      already-elapsed sweep completion that is not tied to the original
    ///      repayment event.
    /// @param migrationSweepReserve Storage mapping of revealer addresses to
    ///        their designated sweep reserve address.
    /// @param pendingMigrationSweepCompletion Storage mapping tracking pending
    ///        completions per revealer.
    /// @param revealer Address whose pending completion is being consumed.
    /// @return reserve The configured reserve to notify, or address(0) when
    ///         there is no pending completion or no reserve was configured.
    /// @return clearedWithoutReserve True when a pending completion was
    ///         dropped because no reserve was configured at completion time.
    function pullPendingSweepReserve(
        mapping(address => address) storage migrationSweepReserve,
        mapping(address => bool) storage pendingMigrationSweepCompletion,
        address revealer
    ) internal returns (address reserve, bool clearedWithoutReserve) {
        if (!pendingMigrationSweepCompletion[revealer]) {
            return (address(0), false);
        }

        reserve = migrationSweepReserve[revealer];
        if (reserve == address(0)) {
            // Drop the queued completion so that later configuring a reserve
            // does not replay this already-elapsed sweep completion.
            pendingMigrationSweepCompletion[revealer] = false;
            return (address(0), true);
        }

        pendingMigrationSweepCompletion[revealer] = false;
        migrationSweepReserve[revealer] = address(0);
        return (reserve, false);
    }
}
