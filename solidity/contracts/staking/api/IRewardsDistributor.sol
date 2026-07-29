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
///         to their authorization weight, splitting each provider's accrual
///         between operator commission (claimable by the beneficiary) and
///         delegator rewards (credited to the stake vault).
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
}
