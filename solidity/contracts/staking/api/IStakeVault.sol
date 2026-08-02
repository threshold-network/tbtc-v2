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

/// @notice Custodies all staked T (operator self-bond and delegated stake)
///         and delegator TBTC rewards for the delegated staking module.
///         Per-provider pools use non-transferable shares; the vault settles
///         rewards on every share mutation and exposes slashing entry points
///         to the slashing module and reward-crediting to the rewards
///         distributor.
interface IStakeVault {
    /// @notice Returns the operator's own bonded T for the given staking
    ///         provider, including any self-bond amount that is queued for
    ///         withdrawal but not yet finalized.
    /// @param stakingProvider Address of the staking provider.
    /// @return Self-bonded T amount.
    function selfBondOf(address stakingProvider) external view returns (uint96);

    /// @notice Returns the total T assets delegated to the given staking
    ///         provider's pool, including assets backing pending
    ///         undelegation requests (those remain slashable and
    ///         reward-earning until finalized).
    /// @param stakingProvider Address of the staking provider.
    /// @return Delegated T assets in the provider's pool.
    function delegatedAssetsOf(address stakingProvider)
        external
        view
        returns (uint96);

    /// @notice Returns the T assets currently backing pending undelegation
    ///         requests for the given staking provider, valued at the
    ///         current share price. These assets are excluded from
    ///         authorization weight immediately upon the undelegation
    ///         request but remain part of `delegatedAssetsOf` until
    ///         finalization.
    /// @param stakingProvider Address of the staking provider.
    /// @return Pending undelegation assets.
    function pendingUndelegationAssetsOf(address stakingProvider)
        external
        view
        returns (uint96);

    /// @notice Returns the pool shares held by the given delegator in the
    ///         given staking provider's pool. Shares are non-transferable.
    /// @param stakingProvider Address of the staking provider.
    /// @param delegator Address of the delegator.
    /// @return Share balance.
    function sharesOf(address stakingProvider, address delegator)
        external
        view
        returns (uint256);

    /// @notice Seizes up to `amount` of T from the given staking provider's
    ///         pool, consuming self-bond first (down to zero, including any
    ///         queued-but-unfinalized self-bond withdrawal) and only then
    ///         haircutting delegated assets (share-price drop borne by all
    ///         delegators, pending exits included). Caps at the available
    ///         balance and MUST NOT revert when `amount` exceeds what is
    ///         available — it seizes what it can and returns the seized
    ///         amount. Seized T is held by the vault, earmarked to the
    ///         slashing module until paid out via `payoutSeized`.
    /// @dev Callable only by the slashing module. Part of the never-revert
    ///      malicious-behavior reporting path; performs no external calls
    ///      that could revert.
    /// @param stakingProvider Address of the staking provider to slash.
    /// @param amount Requested slash amount.
    /// @return seized Actual amount seized (<= `amount`).
    function applySlash(address stakingProvider, uint96 amount)
        external
        returns (uint96 seized);

    /// @notice Transfers `amount` of previously seized T from the vault's
    ///         seized balance to `to`. Used by the slashing module during
    ///         slash execution to pay the notifier reward, the executor cut,
    ///         and the restitution reserve.
    /// @dev Callable only by the slashing module.
    /// @param to Recipient of the seized T.
    /// @param amount Amount of seized T to transfer.
    function payoutSeized(address to, uint96 amount) external;

    /// @notice Credits `tbtcAmount` of post-commission TBTC rewards to the
    ///         given staking provider. The self-bond tranche is routed to the
    ///         provider beneficiary and the delegated tranche increases the
    ///         pool's reward-per-share accumulator, pro rata to their T
    ///         capital. The TBTC MUST already be held by the vault. If there
    ///         are no shares, the full amount is routed to the beneficiary.
    /// @dev Callable only by the rewards distributor.
    /// @param stakingProvider Address of the staking provider whose pool is
    ///        credited.
    /// @param tbtcAmount TBTC amount (18 decimals) already held by the
    ///        vault.
    function creditReward(address stakingProvider, uint256 tbtcAmount) external;
}
