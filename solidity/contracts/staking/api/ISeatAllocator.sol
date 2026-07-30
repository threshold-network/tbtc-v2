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
    /// @notice Permissionlessly synchronizes the given staking provider's
    ///         authorization weight to the FROST wallet registry. Computes
    ///         the current seat weight; on an increase it notifies the
    ///         registry immediately and records the new weight, on a decrease
    ///         it requests an authorization decrease and records the target,
    ///         to be finalized when the registry approves. Also forwards the
    ///         provider's uncapped reward weight to the rewards distributor.
    /// @param stakingProvider Address of the staking provider.
    function refreshAuthorization(address stakingProvider) external;

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
