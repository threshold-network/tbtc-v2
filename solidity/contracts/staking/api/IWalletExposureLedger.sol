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

/// @notice Tracks which wallets each staking provider has live signing
///         exposure to, using per-provider monotonically increasing epochs.
///         Each wallet registration assigns the provider a fresh epoch;
///         wallet closure clears it. Exit finalization consults the ledger
///         to ensure a provider has no live wallet registered at or before
///         the epoch recorded when the exit was requested.
interface IWalletExposureLedger {
    /// @notice Registry address authorized to invoke lifecycle hooks.
    function frostWalletRegistry() external view returns (address);

    /// @notice Records live exposure for every unique staking provider that
    ///         holds seats in the newly registered wallet. For each provider
    ///         the ledger assigns the next epoch (`++epochCounter`), marks it
    ///         live, and increments the provider's live wallet count. Seat
    ///         counts are stored for future seat-exposure rewards and are
    ///         not otherwise used in v1.
    /// @dev Callable only by the FROST wallet registry. The registry invokes
    ///      this inside try/catch so a failure cannot brick DKG result
    ///      approval.
    /// @param walletID Identifier of the registered wallet.
    /// @param stakingProviders Unique staking providers holding seats in the
    ///        wallet.
    /// @param seatCounts Seat count per provider, aligned with
    ///        `stakingProviders`.
    function onWalletRegistered(
        bytes32 walletID,
        address[] calldata stakingProviders,
        uint32[] calldata seatCounts
    ) external;

    /// @notice Clears live exposure for every staking provider recorded for
    ///         the given wallet: unmarks each provider's epoch, decrements
    ///         the live wallet count, and lazily advances the provider's
    ///         oldest live epoch. Idempotent — closing an already-closed or
    ///         unknown wallet is a no-op.
    /// @dev Callable only by the FROST wallet registry. The registry invokes
    ///      this inside try/catch so a failure cannot brick wallet closure
    ///      (which is Bridge-called and must not revert).
    /// @param walletID Identifier of the closed wallet.
    function onWalletClosed(bytes32 walletID) external;

    /// @notice Returns the given staking provider's current (latest
    ///         assigned) exposure epoch. Recorded by the stake vault at exit
    ///         request time as `epochAtRequest`.
    /// @param stakingProvider Address of the staking provider.
    /// @return Latest epoch assigned to the provider; 0 if never exposed.
    function currentEpoch(address stakingProvider)
        external
        view
        returns (uint64);

    /// @notice Returns the number of live (registered, not yet closed)
    ///         wallets the given staking provider has exposure to.
    /// @param stakingProvider Address of the staking provider.
    /// @return Live wallet count.
    function liveWalletCount(address stakingProvider)
        external
        view
        returns (uint32);

    /// @notice Returns true if the staking provider still has live exposure
    ///         to any wallet whose per-provider epoch is at or before the
    ///         given epoch. Used to gate exit finalization: an exit
    ///         requested at `epochAtRequest` may only finalize once this
    ///         returns false. The implementation is fail-safe — if the
    ///         internal bounded walk cannot determine the answer it returns
    ///         true, keeping exits locked rather than unlocking early.
    /// @param stakingProvider Address of the staking provider.
    /// @param epoch Epoch threshold (inclusive).
    /// @return True if live exposure at or before `epoch` exists (or cannot
    ///         be ruled out).
    function hasLiveExposureAtOrBefore(address stakingProvider, uint64 epoch)
        external
        view
        returns (bool);

    /// @notice Returns the stored exposure record of the given wallet. Used
    ///         by the registry's permissionless reconcile path to detect
    ///         divergence between the registry's authoritative wallet state
    ///         and the ledger's recorded exposure: an empty record
    ///         (`epochs.length == 0`) means the wallet was never recorded,
    ///         while `live` reports whether a recorded wallet is still open.
    /// @param walletID Identifier of the wallet.
    /// @return stakingProviders Unique staking providers holding seats in the
    ///         wallet at registration.
    /// @return epochs Per-provider exposure epochs assigned at registration.
    /// @return seatCounts Seat count per provider.
    /// @return live True while the wallet is registered and not yet closed.
    function getWalletExposure(bytes32 walletID)
        external
        view
        returns (
            address[] memory stakingProviders,
            uint64[] memory epochs,
            uint32[] memory seatCounts,
            bool live
        );

    /// @notice Permissionlessly advances a provider's oldest-live pointer by a
    ///         bounded amount. May be called repeatedly after a closure leaves
    ///         a long dead epoch range.
    function advanceOldestLiveEpoch(address stakingProvider)
        external
        returns (uint64);
}
