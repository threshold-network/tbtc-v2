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

/// @notice Distributes TBTC protocol revenue to staking providers pro rata
///         to their capital-based reward weight, splitting each provider's
///         accrual between operator commission and the stake vault's
///         self-bond/delegated pool reward.
interface IRewardsDistributor {
    /// @notice Checkpoints the given staking provider's reward accrual at
    ///         its previous weight and records the new weight, updating the
    ///         distributor's total weight. Called on every authorization
    ///         weight change so that rewards accrued before the change are
    ///         settled at the old weight.
    /// @dev Callable only by the seat allocator.
    /// @param stakingProvider Address of the staking provider.
    /// @param newWeight The provider's new authorization weight.
    function onWeightChanged(address stakingProvider, uint96 newWeight)
        external;

    /// @notice Accounts a new TBTC reward tranche for distribution across
    ///         current weights. The TBTC MUST already have been transferred
    ///         to the distributor before this call. If the total weight is
    ///         zero the amount is carried as undistributed and folded into
    ///         the next tranche notified while weight is non-zero.
    /// @dev Callable only by the fee router.
    /// @param tbtcAmount TBTC amount (18 decimals) already held by the
    ///        distributor.
    function notifyReward(uint256 tbtcAmount) external;

    /// @notice Returns rewards parked while total weight was zero to the given
    ///         recipient when the fee router disables reward distribution.
    /// @dev Callable only by the fee router or distributor governance.
    function recoverUndistributedRewards(address recipient)
        external
        returns (uint256);

    /// @notice Settles all reward accrual currently attributable to the given
    ///         provider into the stake vault. Permissionless; a no-op when
    ///         nothing has accrued.
    function settleOperator(address stakingProvider) external;
}
