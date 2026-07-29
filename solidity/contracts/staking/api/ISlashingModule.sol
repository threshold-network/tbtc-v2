// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity 0.8.17;

/// @notice Books slashes against staking providers' vault pools and manages
///         the delayed movement of seized funds. The economic haircut is
///         applied atomically at report time; only the payout of seized
///         funds is subject to a movement delay and a guardian pause.
interface ISlashingModule {
    /// @notice Books a slash of `perSeatAmount` per listed seat against the
    ///         corresponding staking providers' pools. Duplicate provider
    ///         entries carry per-seat semantics: N occurrences of a provider
    ///         mean N x `perSeatAmount` for that provider. For each unique
    ///         provider the module calls the vault's `applySlash` (which
    ///         caps at available balance) so the haircut lands atomically at
    ///         report time, then enqueues a pending slash whose seized funds
    ///         become movable after the movement delay. This function MUST
    ///         NOT revert — it is on the registry's malicious-behavior
    ///         reporting path, which the Bridge lifecycle depends on.
    /// @dev Callable only by the seat allocator. The provider list is
    ///      bounded by the maximum wallet size, and no reverting external
    ///      calls are made.
    /// @param stakingProviders Providers to slash, one entry per offending
    ///        seat (duplicates allowed and aggregated).
    /// @param perSeatAmount Slash amount per seat.
    /// @param rewardMultiplier Notifier reward percentage of the seized
    ///        amount, in the range [0, 100].
    /// @param notifier Address entitled to the notifier reward at execution.
    function report(
        address[] calldata stakingProviders,
        uint96 perSeatAmount,
        uint256 rewardMultiplier,
        address notifier
    ) external;

    /// @notice Returns the number of booked-but-not-yet-executed slashes for
    ///         the given staking provider. While this is non-zero the vault
    ///         blocks `finalizeUndelegate` and `finalizeSelfBondWithdrawal`
    ///         for the provider's pool.
    /// @param stakingProvider Address of the staking provider.
    /// @return Number of pending (unexecuted, uncancelled) slashes.
    function pendingSlashCount(address stakingProvider)
        external
        view
        returns (uint256);
}
