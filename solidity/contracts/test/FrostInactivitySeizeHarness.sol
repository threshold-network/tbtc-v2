// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@keep-network/sortition-pools/contracts/SortitionPool.sol";

import "../frost-registry/api/IFrostAuthorizationSource.sol";
import {FrostAuthorization as Authorization} from "../frost-registry/libraries/FrostAuthorization.sol";
import {FrostInactivity as Inactivity} from "../frost-registry/libraries/FrostInactivity.sol";
import "../frost-registry/libraries/FrostRegistryWallets.sol";

/// @notice Test-only wrapper for the archived-members seizure path moved into
///         the registry's linked inactivity library.
contract FrostInactivitySeizeHarness {
    using FrostRegistryWallets for FrostRegistryWallets.Data;

    FrostRegistryWallets.Data internal wallets;
    Authorization.Data internal authorization;

    SortitionPool public immutable sortitionPool;
    IFrostAuthorizationSource public immutable authorizationSource;

    constructor(
        SortitionPool _sortitionPool,
        IFrostAuthorizationSource _authorizationSource
    ) {
        sortitionPool = _sortitionPool;
        authorizationSource = _authorizationSource;
    }

    function recordWallet(bytes32 walletID, bytes32 membersIdsHash) external {
        wallets.addWallet(membersIdsHash, walletID);
    }

    function archiveWallet(bytes32 walletID) external {
        wallets.deleteWallet(walletID);
    }

    function setStakingProvider(address operator, address stakingProvider)
        external
    {
        authorization.operatorToStakingProvider[operator] = stakingProvider;
    }

    function seize(
        uint96 amount,
        uint256 rewardMultiplier,
        address notifier,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs
    ) external {
        Inactivity.seize(
            wallets,
            authorization,
            sortitionPool,
            authorizationSource,
            amount,
            rewardMultiplier,
            notifier,
            walletID,
            walletMembersIDs
        );
    }
}
