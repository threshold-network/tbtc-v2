// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../frost-registry/libraries/FrostRegistryWallets.sol";

/// @title FrostRegistryWallets test harness.
/// @notice Thin wrapper that exposes the library's internal
///         `validateXOnlyOutputKey` + `addWallet` functions for
///         unit tests. The harness has no production behaviour;
///         its sole purpose is to let
///         `test/frost-registry/FrostWalletRegistry.GuardsUnit.test.ts`
///         exercise each branch of the validation function
///         independently of the full DKG state machine.
contract FrostRegistryWalletsHarness {
    using FrostRegistryWallets for FrostRegistryWallets.Data;

    FrostRegistryWallets.Data internal data;

    /// @notice Calls the library's `validateXOnlyOutputKey`.
    /// @dev Intentionally NOT `view`: hardhat-waffle's
    ///      `revertedWith(...)` matcher does not surface the
    ///      revert string when the failing call is an `eth_call`
    ///      view (the JSON-RPC response carries an empty revert
    ///      reason for some node configurations). Making the
    ///      wrapper transactional forces the revert reason
    ///      through the receipt path where waffle can decode it.
    ///      The underlying library function is still
    ///      side-effect-free.
    function validateXOnlyOutputKey(bytes32 xOnlyOutputKey) external {
        data.validateXOnlyOutputKey(xOnlyOutputKey);
    }

    /// @notice Records a wallet as already-added so the next
    ///         `validateXOnlyOutputKey` call for the same key
    ///         exercises the duplicate-rejection branch.
    function recordAddedWallet(bytes32 xOnlyOutputKey) external {
        data.addWallet(bytes32(0), xOnlyOutputKey);
    }

    function recordAddedWalletWithMembers(
        bytes32 membersIdsHash,
        bytes32 xOnlyOutputKey
    ) external {
        data.addWallet(membersIdsHash, xOnlyOutputKey);
    }

    function deleteWallet(bytes32 walletID) external {
        data.deleteWallet(walletID);
    }

    function getWallet(bytes32 walletID)
        external
        view
        returns (FrostRegistryWallets.Wallet memory)
    {
        FrostRegistryWallets.Wallet storage wallet = data.registry[walletID];
        if (wallet.xOnlyOutputKey == bytes32(0)) {
            return data.archived[walletID];
        }
        return wallet;
    }

    function getArchivedWallet(bytes32 walletID)
        external
        view
        returns (bytes32 membersIdsHash, bytes32 xOnlyOutputKey)
    {
        FrostRegistryWallets.Wallet storage wallet = data.archived[walletID];
        return (wallet.membersIdsHash, wallet.xOnlyOutputKey);
    }

    function getRetainedWalletMembersIdsHash(bytes32 walletID)
        external
        view
        returns (bytes32)
    {
        return data.getRetainedWalletMembersIdsHash(walletID);
    }
}
