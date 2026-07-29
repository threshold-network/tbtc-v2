// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @title IBridgeLifecycleRouter
/// @notice Interface for the Bridge's FROST-scheme lifecycle router.
///
/// The Bridge dispatches FROST-scheme wallet lifecycle operations
/// (closeWallet, seize, isWalletMember) to a router implementing this
/// interface. The router resolves the configured FROST wallet registry
/// address and the wallet's canonical walletID from the Bridge's
/// `frostLifecycleContext(walletPubKeyHash)` view and forwards the call
/// to that registry. ECDSA-scheme lifecycle
/// operations bypass the router entirely and continue to call
/// `ecdsaWalletRegistry` directly, preserving the existing
/// ownership/callback model for ECDSA wallets.
///
/// The Bridge passes only the 20-byte wallet public key hash to the
/// router; the router reads the rest of the lifecycle state from the
/// Bridge's single `frostLifecycleContext(walletPubKeyHash)` view,
/// which returns the configured `frostWalletRegistry` address and the
/// canonical walletID in one call. The Bridge does not expose separate
/// `lifecycleRouter`, `frostWalletRegistry`, or
/// `walletIDByWalletPubKeyHash` getters; folding them into
/// `frostLifecycleContext` keeps the Bridge implementation under the
/// EIP-170 deploy limit. This keeps the per-call-site Bridge bytecode
/// footprint minimal (one external call with one argument) at the cost
/// of one cross-contract view per dispatch.
///
/// The router is stateless and immutable. `Bridge.setLifecycleRouter`
/// is a one-time setter that reverts once a router has been set, so the
/// Bridge cannot be repointed at a different router after
/// initialization; replacing the router requires a Bridge
/// implementation upgrade. There are no in-flight lifecycle operations
/// to migrate between router versions.
interface IBridgeLifecycleRouter {
    /// @notice Forwards a closeWallet call for the FROST wallet
    ///         identified by `walletPubKeyHash` to the configured
    ///         FROST wallet registry.
    function closeWallet(bytes20 walletPubKeyHash) external;

    /// @notice Forwards a seize call for the FROST wallet identified
    ///         by `walletPubKeyHash` to the configured FROST wallet
    ///         registry.
    function seize(
        bytes20 walletPubKeyHash,
        uint96 amount,
        uint32 rewardMultiplier,
        address notifier,
        uint32[] calldata walletMembersIDs
    ) external;

    /// @notice Forwards an isWalletMember query for the FROST wallet
    ///         identified by `walletPubKeyHash` to the configured
    ///         FROST wallet registry.
    function isWalletMember(
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs,
        address operator,
        uint256 walletMemberIndex
    ) external view returns (bool);
}
