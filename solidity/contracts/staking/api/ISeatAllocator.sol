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

/// @notice The seat allocator's own surface beyond
///         `IFrostAuthorizationSource`. Computes uniform, curation-derived
///         authorization weights (the same `equalSeatWeight` for every
///         eligible active operator, independent of delegation), synchronizes
///         them to the FROST wallet registry, and gates exit finalization on
///         wallet exposure.
interface ISeatAllocator {
    /// @notice True while this allocator is the wallet registry's active
    ///         authorization source. Governed parameter updates may still land
    ///         while detached; their roster synchronization is deferred until
    ///         the next authorization-source migration.
    function authorizationAttached() external view returns (bool);

    /// @notice Permissionlessly synchronizes the given staking provider's
    ///         authorization weight to the FROST wallet registry. Computes
    ///         the current seat weight; on an increase it notifies the
    ///         registry immediately and records the new weight, on a decrease
    ///         it requests an authorization decrease and records the target,
    ///         to be finalized when the registry approves. Also forwards the
    ///         provider's uncapped reward weight to the rewards distributor.
    /// @param stakingProvider Address of the staking provider.
    function refreshAuthorization(address stakingProvider) external;

    /// @notice Checkpoints reward and commission accounting immediately
    ///         before the signer registry overwrites a commission schedule.
    /// @dev Callable only by the signer registry.
    function checkpointRewards(address stakingProvider) external;

    /// @notice Synchronizes a provider's reward weight immediately after the
    ///         slashing module mutates its vault capital. Reverts if the
    ///         distributor cannot accept the reduction so the slash report is
    ///         queued and exits remain blocked instead of leaving stale reward
    ///         weight behind.
    function syncRewardWeightAfterSlash(address stakingProvider) external;

    /// @notice Atomically synchronizes authorization and reward weights for
    ///         the complete current sortition-pool roster after the vault
    ///         changes a global eligibility parameter.
    /// @dev Callable only by the stake vault. The wallet registry validates
    ///      roster completeness and rewrites every pool leaf in the same
    ///      transaction.
    /// @param stakingProviders Complete current sortition-pool roster.
    function synchronizeAuthorizationRoster(address[] calldata stakingProviders)
        external;

    /// @notice Number of failed slash reports queued against the provider.
    ///         The stake vault treats any non-zero value as an exit hold until
    ///         the report is retried successfully.
    function queuedSlashCount(address stakingProvider)
        external
        view
        returns (uint256);

    /// @notice Returns the staking provider's live seat weight: zero if the
    ///         provider is not active in the signer registry, or its effective
    ///         self-bond (net of any queued self-bond withdrawal) is below the
    ///         vault's minimum self-bond; otherwise the uniform
    ///         `equalSeatWeight` shared by every eligible active operator.
    ///         Delegated stake does NOT affect seat weight — signing power is
    ///         set by allowlist curation, not by delegated capital. Note this
    ///         is the live computation — the weight the registry currently
    ///         knows is `authorizedWeight` and may lag until
    ///         `refreshAuthorization` is called.
    /// @param stakingProvider Address of the staking provider.
    /// @return Live authorization weight.
    function currentWeight(address stakingProvider)
        external
        view
        returns (uint96);

    /// @notice Returns true if an exit requested at `epochAtRequest` may be
    ///         finalized with respect to wallet exposure, i.e. the staking
    ///         provider has no live wallet whose exposure epoch is at or
    ///         before `epochAtRequest`. Consulted by the stake vault in
    ///         `finalizeUndelegate` and `finalizeSelfBondWithdrawal`
    ///         alongside the time delay and the pending-slash gate.
    /// @param stakingProvider Address of the staking provider.
    /// @param epochAtRequest The provider's exposure epoch recorded when the
    ///        exit was requested.
    /// @return True if no blocking live wallet exposure exists.
    function canFinalizeUndelegate(
        address stakingProvider,
        uint64 epochAtRequest
    ) external view returns (bool);
}
