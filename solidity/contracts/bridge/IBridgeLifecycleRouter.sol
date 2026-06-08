// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @title IBridgeLifecycleRouter
/// @notice Interface for the Bridge's FROST-scheme lifecycle router.
///
/// The Bridge dispatches wallet lifecycle operations
/// (closeWallet, seize, isWalletMember) to a router implementing this
/// interface. The router resolves the wallet's canonical walletID from
/// the Bridge's `walletIDByWalletPubKeyHash` mapping and forwards the
/// call to the configured `frostWalletRegistry`.
///
/// The Bridge passes only the 20-byte wallet public key hash to the
/// router; the router reads the rest of the lifecycle state from the
/// Bridge via its public view functions (lifecycleRouter,
/// frostWalletRegistry, walletIDByWalletPubKeyHash). This keeps the
/// per-call-site Bridge bytecode footprint minimal (one external call
/// with one argument) at the cost of one cross-contract view per
/// dispatch.
///
/// The router is stateless and immutable; replacement is done by
/// deploying a new router contract and using
/// `Bridge.setLifecycleRouter` to point the Bridge at the new
/// implementation. There are no in-flight lifecycle operations to
/// migrate between router versions.
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
