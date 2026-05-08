// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Interface for TBTCVault migration debt accounting.
interface ITBTCVaultMigrationDebt {
    event MigrationDebtRegistered(address indexed revealer, uint256 amount);
    event MigrationDebtRepaid(address indexed revealer, uint256 remaining);
    event MigrationDebtCleared(address indexed revealer, uint256 amount);
    event MigrationRevealerSet(address indexed revealer, bool allowed);

    /// @notice Registers the expected total migration debt for a revealer.
    ///         Must be called before revealing migration-tagged deposits.
    ///         The revealer cannot reveal migration deposits without an
    ///         outstanding debt registration (enforced by
    ///         `canRevealMigration`).
    /// @dev The `amount` parameter should represent the expected total BTC
    ///      value of migration deposits for this revealer, converted to
    ///      1e18 Ethereum precision.
    ///
    ///      Amount convention trade-off: the caller must decide whether to
    ///      register the gross (pre-fee) deposit value or an estimated net
    ///      (post-fee) value:
    ///
    ///      Gross registration (registering the full pre-fee deposit
    ///      amount): conservative approach. After the Bridge sweeps the
    ///      deposit, it deducts a treasury fee per deposit
    ///      (`depositAmount / depositTreasuryFeeDivisor`) and a share of
    ///      the Bitcoin sweep transaction miner fee
    ///      (`depositTxFeeIncurred`). The post-fee amount reaching the
    ///      vault is less than the registered debt, leaving a residual
    ///      positive debt. Migration lifecycle completion requires an
    ///      owner-initiated `notifyMigrationSweep` call to transition
    ///      the reserve to MIGRATED state. This approach avoids excess
    ///      tBTC minting.
    ///
    ///      Net registration (estimating post-fee value): if the fee
    ///      estimate matches actual deductions, debt reaches zero
    ///      automatically on sweep and triggers the migration completion
    ///      callback. However, the Bitcoin miner fee component is
    ///      unknowable at registration time since it depends on the
    ///      sweep batch composition and Bitcoin fee market conditions.
    ///      Underestimating fees causes excess tBTC minting;
    ///      overestimating fees leaves residual debt requiring owner
    ///      intervention.
    ///
    ///      Registration is one-time: reverts if the revealer already has
    ///      outstanding debt.
    /// @param revealer The address that will reveal migration-tagged
    ///        deposits on the Bridge.
    /// @param amount Expected migration debt in 1e18 Ethereum precision
    ///        (satoshi values are scaled by SATOSHI_MULTIPLIER = 10^10).
    function registerMigrationDebt(address revealer, uint256 amount) external;

    function migrationDebt(address revealer) external view returns (uint256);

    /// @notice Clears any remaining migration debt for `revealer`.
    /// @dev Intended for the over-registration residual-debt case once the
    ///      migration lifecycle has been completed out-of-band and no further
    ///      migration deposits should be revealed for this address.
    ///      Implementations should zero the debt, update aggregate debt
    ///      accounting, and disable migration reveals for `revealer`.
    /// @param revealer The revealer whose residual migration debt should be
    ///        cleared.
    function clearMigrationDebt(address revealer) external;

    function setMigrationRevealer(address revealer, bool allowed) external;

    function isMigrationRevealer(address revealer) external view returns (bool);

    /// @notice Returns whether the given revealer is allowed to reveal
    ///         migration-tagged deposits.
    /// @dev Returns true only when both `isMigrationRevealer[revealer]`
    ///      is set and `migrationDebt[revealer] > 0`. This ensures a
    ///      revealer cannot reveal migration deposits without a
    ///      corresponding debt registration, and cannot reveal beyond
    ///      the registered capacity once debt is fully repaid.
    /// @param revealer Address to check migration reveal eligibility.
    /// @return True if the revealer can reveal migration deposits.
    function canRevealMigration(address revealer) external view returns (bool);

    /// @notice Returns whether this vault has any outstanding migration debt
    ///         across all revealers.
    /// @dev Implementations should maintain an internal counter that is
    ///      incremented when migration debt is registered and decremented
    ///      when a revealer's debt reaches zero, whether via repayment or an
    ///      owner-authorized residual debt clear-out. This provides an O(1)
    ///      aggregate query without enumerating individual revealers.
    /// @return True if at least one revealer has nonzero migration debt.
    function hasOutstandingMigrationDebt() external view returns (bool);
}
