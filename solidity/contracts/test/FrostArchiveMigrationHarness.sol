// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../frost-registry/libraries/FrostRegistryWallets.sol";
import {FrostDkg as DKG} from "../frost-registry/libraries/FrostDkg.sol";
import {FrostInactivity as Inactivity} from "../frost-registry/libraries/FrostInactivity.sol";

abstract contract FrostArchiveMigrationHarnessStorage {
    using FrostRegistryWallets for FrostRegistryWallets.Data;

    FrostRegistryWallets.Data internal wallets;
    DKG.Data internal dkg;
    mapping(bytes32 => bool) public registered;
    address public governance;
    bool internal initialized;

    event WalletClosed(bytes32 indexed walletID);
}

contract FrostArchiveMigrationHarnessV1 is FrostArchiveMigrationHarnessStorage {
    using FrostRegistryWallets for FrostRegistryWallets.Data;

    event JournalEntry(bytes32 indexed value);

    function initialize(address _governance) external {
        require(!initialized, "Already initialized");
        initialized = true;
        governance = _governance;
    }

    function addWallet(bytes32 walletID, bytes32 membersIdsHash) external {
        wallets.addWallet(membersIdsHash, walletID);
        registered[walletID] = true;
    }

    function legacyCloseWallet(bytes32 walletID) external {
        delete wallets.registry[walletID];
        emit WalletClosed(walletID);
    }

    function emitJournalEntry(bytes32 value) external {
        emit JournalEntry(value);
    }
}

contract FrostArchiveMigrationHarnessV2 is FrostArchiveMigrationHarnessStorage {
    using FrostRegistryWallets for FrostRegistryWallets.Data;

    address internal immutable implementationSelf;

    constructor() {
        implementationSelf = address(this);
    }

    function beginArchiveMigration(bytes calldata encodedStart) external {
        Inactivity.beginArchiveMigration(
            wallets,
            governance,
            implementationSelf,
            encodedStart
        );
    }

    function commitArchiveMigrationManifest(bytes calldata encodedCommit)
        external
    {
        Inactivity.commitArchiveMigrationManifest(
            wallets,
            governance,
            encodedCommit
        );
    }

    function backfillArchivedWalletMembership(
        uint256 index,
        bytes32 walletID,
        bytes32 dkgResultHash,
        bytes32 membersIdsHash,
        bytes32[] calldata proof
    ) external {
        Inactivity.backfillArchivedWalletMembership(
            wallets,
            registered,
            index,
            walletID,
            dkgResultHash,
            membersIdsHash,
            proof
        );
    }

    function finalizeArchiveMigration() external {
        Inactivity.finalizeArchiveMigration(wallets, dkg);
    }

    function closeWallet(bytes32 walletID) external {
        wallets.deleteWallet(walletID);
        emit WalletClosed(walletID);
    }

    function getRetainedWalletMembersIdsHash(bytes32 walletID)
        external
        view
        returns (bytes32)
    {
        return wallets.getRetainedWalletMembersIdsHash(walletID);
    }

    function getMigration()
        external
        view
        returns (
            FrostRegistryWallets.ArchiveMigrationState state,
            address authority,
            uint256 upgradeBlock,
            bytes32 oldCodeHash,
            bytes32 newCodeHash,
            bytes32 root,
            bytes32 historyRoot,
            bytes32 manifestHash,
            uint256 expected,
            uint256 completed,
            bytes32 checkpointHash,
            uint256 checkpointBlockNumber,
            uint256 maxTailBlocks
        )
    {
        return (
            wallets.archiveMigrationState,
            wallets.archiveMigrationAuthority,
            wallets.archiveMigrationUpgradeBlock,
            wallets.archiveMigrationOldImplementationCodeHash,
            wallets.archiveMigrationNewImplementationCodeHash,
            wallets.archiveMigrationMerkleRoot,
            wallets.archiveMigrationHistoryRoot,
            wallets.archiveMigrationPendingManifestHash,
            wallets.archiveMigrationExpectedCount,
            wallets.archiveMigrationCompletedCount,
            wallets.archiveMigrationCheckpointHash,
            wallets.archiveMigrationCheckpointBlock,
            wallets.archiveMigrationMaxTailBlocks
        );
    }

    function getAttestations()
        external
        view
        returns (
            uint256 upgradeDeadlineBlock,
            address sourceAttester,
            bytes32 sourceAttestationHash,
            bytes32 sourceIdentityHash,
            bytes32 sourceEndpointIdentityHash,
            bytes32 sourceTrustDomainHash,
            bytes32 sourceEndpointPolicyHash,
            address reconcilerAttester,
            bytes32 reconcilerAttestationHash,
            bytes32 reconcilerIdentityHash,
            bytes32 reconcilerEndpointIdentityHash,
            bytes32 reconcilerTrustDomainHash,
            bytes32 reconcilerEndpointPolicyHash
        )
    {
        return (
            wallets.archiveMigrationUpgradeDeadlineBlock,
            wallets.archiveMigrationSourceAttester,
            wallets.archiveMigrationSourceAttestationHash,
            wallets.archiveMigrationSourceIdentityHash,
            wallets.archiveMigrationSourceEndpointIdentityHash,
            wallets.archiveMigrationSourceTrustDomainHash,
            wallets.archiveMigrationSourceEndpointPolicyHash,
            wallets.archiveMigrationReconcilerAttester,
            wallets.archiveMigrationReconcilerAttestationHash,
            wallets.archiveMigrationReconcilerIdentityHash,
            wallets.archiveMigrationReconcilerEndpointIdentityHash,
            wallets.archiveMigrationReconcilerTrustDomainHash,
            wallets.archiveMigrationReconcilerEndpointPolicyHash
        );
    }

    function getFinalAttestations()
        external
        view
        returns (
            bytes32 sourceAttestationHash,
            bytes32 reconcilerAttestationHash
        )
    {
        return (
            wallets.archiveMigrationFinalSourceAttestationHash,
            wallets.archiveMigrationFinalReconcilerAttestationHash
        );
    }
}
