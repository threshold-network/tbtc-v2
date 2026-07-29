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
///         `IFrostAuthorizationSource`. Computes stake-derived authorization
///         weights (capped by the delegation factor and the maximum operator
///         weight), synchronizes them to the FROST wallet registry, and
///         gates exit finalization on wallet exposure.
interface ISeatAllocator {
    /// @notice Permissionlessly synchronizes the given staking provider's
    ///         authorization weight to the FROST wallet registry. Computes
    ///         the current stake-derived weight; on an increase it notifies
    ///         the registry immediately and records the new weight, on a
    ///         decrease it requests an authorization decrease and records
    ///         the target, to be finalized when the registry approves. Also
    ///         forwards the new weight to the rewards distributor.
    /// @param stakingProvider Address of the staking provider.
    function refreshAuthorization(address stakingProvider) external;

    /// @notice Returns the staking provider's live stake-derived weight:
    ///         zero if the provider is not active in the signer registry;
    ///         otherwise the total of effective self-bond and delegated
    ///         assets (both net of pending withdrawals/undelegations),
    ///         capped at `selfBond * delegationFactor` and at the maximum
    ///         operator weight, and zero if the self-bond falls below the
    ///         minimum self-bond or the result falls below the minimum
    ///         authorization. Note this is the live computation — the weight
    ///         the registry currently knows is `authorizedWeight` and may
    ///         lag until `refreshAuthorization` is called.
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
