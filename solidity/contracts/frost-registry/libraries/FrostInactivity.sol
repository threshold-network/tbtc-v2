// SPDX-License-Identifier: GPL-3.0-only
//
// ▓▓▌ ▓▓ ▐▓▓ ▓▓▓▓▓▓▓▓▓▓▌▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▄
// ▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▌▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
//   ▓▓▓▓▓▓    ▓▓▓▓▓▓▓▀    ▐▓▓▓▓▓▓    ▐▓▓▓▓▓   ▓▓▓▓▓▓     ▓▓▓▓▓   ▐▓▓▓▓▓▌   ▐▓▓▓▓▓▓
//   ▓▓▓▓▓▓▄▄▓▓▓▓▓▓▓▀      ▐▓▓▓▓▓▓▄▄▄▄         ▓▓▓▓▓▓▄▄▄▄         ▐▓▓▓▓▓▌   ▐▓▓▓▓▓▓
//   ▓▓▓▓▓▓▓▓▓▓▓▓▓▀        ▐▓▓▓▓▓▓▓▓▓▓         ▓▓▓▓▓▓▓▓▓▓         ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
//   ▓▓▓▓▓▓▀▀▓▓▓▓▓▓▄       ▐▓▓▓▓▓▓▀▀▀▀         ▓▓▓▓▓▓▀▀▀▀         ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▀
//   ▓▓▓▓▓▓   ▀▓▓▓▓▓▓▄     ▐▓▓▓▓▓▓     ▓▓▓▓▓   ▓▓▓▓▓▓     ▓▓▓▓▓   ▐▓▓▓▓▓▌
// ▓▓▓▓▓▓▓▓▓▓ █▓▓▓▓▓▓▓▓▓ ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓
// ▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓ ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓
//
//                           Trust math, not hardware.

pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import "@keep-network/random-beacon/contracts/libraries/BytesLib.sol";
import "@keep-network/random-beacon/contracts/ReimbursementPool.sol";
import "@keep-network/sortition-pools/contracts/SortitionPool.sol";

import "../api/IFrostWalletOwner.sol";
import {FrostDkg as DKG} from "./FrostDkg.sol";
import "./FrostRegistryWallets.sol";

library FrostInactivity {
    using BytesLib for bytes;
    using ECDSAUpgradeable for bytes32;
    using DKG for DKG.Data;
    using FrostRegistryWallets for FrostRegistryWallets.Data;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 internal constant ARCHIVE_MANIFEST_TYPEHASH =
        keccak256("FrostArchiveManifest(bytes32 fieldsHash)");
    bytes32 internal constant ARCHIVE_START_TYPEHASH =
        keccak256("FrostArchiveMigrationStart(bytes32 fieldsHash)");
    bytes32 internal constant ARCHIVE_CHECKPOINT_ATTESTATION_TYPEHASH =
        keccak256("FrostArchiveCheckpointAttestation(bytes32 fieldsHash)");
    bytes32 internal constant ARCHIVE_MANIFEST_ATTESTATION_TYPEHASH =
        keccak256("FrostArchiveManifestAttestation(bytes32 fieldsHash)");
    bytes32 internal constant ARCHIVE_LEAF_TYPEHASH =
        keccak256(
            "FrostArchiveWallet(uint256 index,bytes32 walletID,bytes32 dkgResultHash,bytes32 membersIdsHash)"
        );
    bytes32 internal constant ARCHIVE_NAME_HASH =
        keccak256("tBTC FROST Wallet Archive");
    bytes32 internal constant ARCHIVE_VERSION_HASH = keccak256("3");
    bytes32 internal constant ARCHIVE_SCHEMA_HASH =
        keccak256("tbtc/frost-wallet-archive/v3");
    bytes32 internal constant ARCHIVE_START_SCHEMA_HASH =
        keccak256("tbtc/frost-wallet-archive/start-v3");
    bytes32 internal constant ARCHIVE_CHECKPOINT_ATTESTATION_SCHEMA_HASH =
        keccak256("tbtc/frost-wallet-archive/checkpoint-attestation-v1");
    bytes32 internal constant ARCHIVE_MANIFEST_ATTESTATION_SCHEMA_HASH =
        keccak256("tbtc/frost-wallet-archive/manifest-attestation-v1");
    bytes32 internal constant ARCHIVE_SOURCE_ATTESTATION_ROLE =
        keccak256("tbtc/frost-wallet-archive/source");
    bytes32 internal constant ARCHIVE_RECONCILER_ATTESTATION_ROLE =
        keccak256("tbtc/frost-wallet-archive/reconciler");
    bytes32 internal constant FRESH_SCHEMA_HASH =
        keccak256("tbtc/frost-wallet-archive/fresh-v2");
    bytes32 internal constant EIP1967_ADMIN_SLOT =
        0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes4 internal constant EIP1271_MAGIC_VALUE =
        IERC1271.isValidSignature.selector;
    uint256 internal constant MAX_ARCHIVE_TAIL_BLOCKS = 64;

    struct ArchiveManifest {
        uint256 chainId;
        address registry;
        bytes32 oldImplementationCodeHash;
        bytes32 newImplementationCodeHash;
        bytes32 checkpointHash;
        uint256 checkpointBlockNumber;
        uint256 maxTailBlocks;
        uint256 upgradeDeadlineBlock;
        address sourceAttester;
        bytes32 sourceAttestationHash;
        bytes32 sourceIdentityHash;
        bytes32 sourceEndpointIdentityHash;
        bytes32 sourceTrustDomainHash;
        bytes32 sourceEndpointPolicyHash;
        address reconcilerAttester;
        bytes32 reconcilerAttestationHash;
        bytes32 reconcilerIdentityHash;
        bytes32 reconcilerEndpointIdentityHash;
        bytes32 reconcilerTrustDomainHash;
        bytes32 reconcilerEndpointPolicyHash;
        uint256 upgradeBlockNumber;
        bytes32 upgradeBlockHash;
        uint256 upgradeTransactionIndex;
        uint256 scanFromBlock;
        uint256 scanToBlock;
        bytes32 historyRoot;
        bytes32 walletsRoot;
        uint256 walletCount;
        bytes32 schemaHash;
    }

    struct CheckpointAttestation {
        address attester;
        bytes32 sourceIdentityHash;
        bytes32 endpointIdentityHash;
        bytes32 trustDomainHash;
        bytes32 endpointPolicyHash;
        bytes signature;
    }

    struct CheckpointAttestationPayload {
        uint256 chainId;
        address registry;
        bytes32 role;
        address attester;
        bytes32 checkpointHash;
        uint256 scanFromBlock;
        uint256 checkpointBlockNumber;
        bytes32 checkpointBlockHash;
        bytes32 historyCommitment;
        bytes32 inventoryRoot;
        uint256 inventoryCount;
        uint256 maxTailBlocks;
        uint256 upgradeDeadlineBlock;
        bytes32 sourceIdentityHash;
        bytes32 endpointIdentityHash;
        bytes32 trustDomainHash;
        bytes32 endpointPolicyHash;
        bytes32 schemaHash;
    }

    struct ManifestAttestationPayload {
        uint256 chainId;
        address registry;
        bytes32 role;
        address attester;
        bytes32 manifestHash;
        bytes32 checkpointHash;
        uint256 upgradeBlockNumber;
        bytes32 upgradeBlockHash;
        uint256 upgradeTransactionIndex;
        bytes32 historyRoot;
        bytes32 walletsRoot;
        uint256 walletCount;
        bytes32 schemaHash;
    }

    struct ArchiveManifestCommit {
        ArchiveManifest manifest;
        bytes authoritySignature;
        bytes sourceSignature;
        bytes reconcilerSignature;
    }

    struct ArchiveStartAuthorizationPayload {
        uint256 chainId;
        address registry;
        bytes32 oldImplementationCodeHash;
        bytes32 newImplementationCodeHash;
        address authority;
        bytes32 checkpointHash;
        uint256 checkpointBlockNumber;
        uint256 maxTailBlocks;
        uint256 upgradeDeadlineBlock;
        address sourceAttester;
        bytes32 sourceAttestationHash;
        address reconcilerAttester;
        bytes32 reconcilerAttestationHash;
        bytes32 schemaHash;
    }

    struct ArchiveMigrationStart {
        address authority;
        address oldImplementation;
        bytes32 checkpointHash;
        uint256 scanFromBlock;
        uint256 checkpointBlockNumber;
        bytes32 checkpointBlockHash;
        bytes32 historyCommitment;
        bytes32 inventoryRoot;
        uint256 inventoryCount;
        uint256 maxTailBlocks;
        uint256 upgradeDeadlineBlock;
        CheckpointAttestation sourceAttestation;
        CheckpointAttestation reconcilerAttestation;
        bytes authoritySignature;
    }

    error ArchiveMigrationInvalidState();
    error ArchiveMigrationUnauthorizedInitializer();
    error ArchiveMigrationInvalidAuthority();
    error ArchiveMigrationInvalidImplementation();
    error ArchiveMigrationInvalidManifest();
    error ArchiveMigrationInvalidSignature();
    error ArchiveMigrationInvalidProof();
    error ArchiveMigrationIndexAlreadyClaimed();
    error ArchiveMigrationIncomplete();

    struct Claim {
        // ID of the wallet whose signing group is raising the inactivity claim.
        bytes32 walletID;
        // Indices of group members accused of being inactive. Indices must be in
        // range [1, groupMembers.length], unique, and sorted in ascending order.
        uint256[] inactiveMembersIndices;
        // Indicates if inactivity claim is a wallet-wide heartbeat failure.
        // If wallet failed a heartbeat, this is signalled to the wallet owner
        // who may decide to move responsibilities to another wallet
        // given that the wallet who failed the heartbeat is at risk of not
        // being able to sign messages soon.
        bool heartbeatFailed;
        // Concatenation of signatures from members supporting the claim.
        // The message to be signed by each member is keccak256 hash of the
        // concatenation of the chain ID, inactivity claim nonce for the given
        // wallet, wallet public key, inactive members indices, and boolean flag
        // indicating if this is a wallet-wide heartbeat failure. The calculated
        // hash should be prefixed with `\x19Ethereum signed message:\n` before
        // signing, so the message to sign is:
        // `\x19Ethereum signed message:\n${keccak256(
        //    chainID | nonce | walletPubKey | inactiveMembersIndices | heartbeatFailed
        // )}`
        bytes signatures;
        // Indices of members corresponding to each signature. Indices must be
        // in range [1, groupMembers.length], unique, and sorted in ascending
        // order.
        uint256[] signingMembersIndices;
        // This struct doesn't contain `__gap` property as the structure is not
        // stored, it is used as a function's calldata argument.
    }

    /// @notice The minimum number of wallet signing group members needed to
    ///         interact according to the protocol to produce a valid inactivity
    ///         claim.
    uint256 public constant groupThreshold = 51;

    /// @notice Size in bytes of a single signature produced by member
    ///         supporting the inactivity claim.
    uint256 public constant signatureByteSize = 65;

    event InactivityClaimed(
        bytes32 indexed walletID,
        uint256 nonce,
        address notifier
    );

    event WalletMembershipBackfilled(
        bytes32 indexed walletID,
        bytes32 membersIdsHash
    );

    event WalletArchiveMigrationCompleted(bytes32 indexed manifestHash);

    event WalletCreated(bytes32 indexed walletID, bytes32 dkgResultHash);

    event WalletArchiveMigrationStarted(
        address indexed authority,
        uint256 indexed upgradeBlockNumber,
        bytes32 oldImplementationCodeHash,
        bytes32 newImplementationCodeHash,
        bytes32 checkpointHash,
        uint256 checkpointBlockNumber,
        uint256 maxTailBlocks,
        uint256 upgradeDeadlineBlock,
        address sourceAttester,
        bytes32 sourceAttestationHash,
        address reconcilerAttester,
        bytes32 reconcilerAttestationHash
    );

    event WalletArchiveMigrationManifestCommitted(
        bytes32 indexed manifestHash,
        bytes32 indexed walletsRoot,
        uint256 walletCount,
        bytes32 historyRoot,
        bytes32 upgradeBlockHash,
        uint256 upgradeTransactionIndex,
        uint256 scanFromBlock,
        uint256 scanToBlock
    );

    /// @notice Checks membership against an active wallet commitment.
    /// @dev Archived membership must never authorize new protocol work.
    function isWalletMember(
        FrostRegistryWallets.Data storage wallets,
        SortitionPool sortitionPool,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs,
        address operator,
        uint256 walletMemberIndex
    ) external view returns (bool) {
        uint32 operatorID = sortitionPool.getOperatorID(operator);

        require(operatorID != 0, "Not a sortition pool operator");

        bytes32 memberIdsHash = wallets.getWalletMembersIdsHash(walletID);

        require(
            memberIdsHash == keccak256(abi.encode(walletMembersIDs)),
            "Invalid wallet members identifiers"
        );

        require(
            1 <= walletMemberIndex &&
                walletMemberIndex <= walletMembersIDs.length,
            "Wallet member index is out of range"
        );

        return walletMembersIDs[walletMemberIndex - 1] == operatorID;
    }

    /// @notice Returns an active or archived wallet membership commitment.
    /// @dev Historical consumers must opt into this accessor explicitly. The
    ///      wallet ID itself is the x-only key, so this commitment is the only
    ///      additional retained field. New-work authorization must continue to
    ///      use the active-only APIs.
    function getRetainedWalletMembersIdsHash(
        FrostRegistryWallets.Data storage wallets,
        bytes32 walletID
    ) external view returns (bytes32) {
        return wallets.getRetainedWalletMembersIdsHash(walletID);
    }

    function initializeFreshArchive(FrostRegistryWallets.Data storage wallets)
        external
    {
        if (
            wallets.archiveMigrationState !=
            FrostRegistryWallets.ArchiveMigrationState.Uninitialized ||
            wallets.archiveMigrationManifestHash != bytes32(0)
        ) {
            revert ArchiveMigrationInvalidState();
        }

        bytes32 freshManifestHash = keccak256(
            abi.encode(FRESH_SCHEMA_HASH, block.chainid, address(this))
        );
        wallets.archiveMigrationManifestHash = freshManifestHash;
        wallets.archiveMigrationState = FrostRegistryWallets
            .ArchiveMigrationState
            .Fresh;
        emit WalletArchiveMigrationCompleted(freshManifestHash);
    }

    /// @notice Atomically enters the frozen migration phase during
    ///         ProxyAdmin.upgradeAndCall.
    function beginArchiveMigration(
        FrostRegistryWallets.Data storage wallets,
        address governance,
        address implementationSelf,
        bytes calldata encodedStart
    ) external {
        ArchiveMigrationStart memory start = abi.decode(
            encodedStart,
            (ArchiveMigrationStart)
        );
        (address proxyAdmin, address proxyAdminOwner) = _archiveProxyAdmin();
        _validateArchiveStartAuthority(
            start,
            governance,
            proxyAdmin,
            proxyAdminOwner
        );
        _validateArchiveStartContext(wallets, start, implementationSelf);
        ArchiveStartHashes memory hashes = _verifyArchiveStart(
            start,
            implementationSelf
        );
        _storeArchiveStart(wallets, start, hashes);
    }

    struct ArchiveStartHashes {
        bytes32 oldImplementationCodeHash;
        bytes32 newImplementationCodeHash;
        bytes32 sourceAttestationHash;
        bytes32 reconcilerAttestationHash;
    }

    function _archiveProxyAdmin()
        private
        view
        returns (address proxyAdmin, address proxyAdminOwner)
    {
        bytes32 adminSlot = EIP1967_ADMIN_SLOT;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            proxyAdmin := sload(adminSlot)
        }
        if (msg.sender != proxyAdmin) {
            revert ArchiveMigrationUnauthorizedInitializer();
        }
        (bool ownerRead, bytes memory ownerResult) = proxyAdmin.staticcall(
            abi.encodeWithSignature("owner()")
        );
        if (!ownerRead || ownerResult.length != 32) {
            revert ArchiveMigrationUnauthorizedInitializer();
        }
        proxyAdminOwner = abi.decode(ownerResult, (address));
    }

    function _validateArchiveStartAuthority(
        ArchiveMigrationStart memory start,
        address governance,
        address proxyAdmin,
        address proxyAdminOwner
    ) private pure {
        if (
            start.authority == address(0) ||
            start.authority == governance ||
            start.authority == proxyAdmin ||
            start.authority == proxyAdminOwner ||
            start.sourceAttestation.attester == address(0) ||
            start.reconcilerAttestation.attester == address(0) ||
            start.sourceAttestation.attester ==
            start.reconcilerAttestation.attester ||
            start.sourceAttestation.attester == start.authority ||
            start.reconcilerAttestation.attester == start.authority ||
            start.sourceAttestation.attester == governance ||
            start.reconcilerAttestation.attester == governance ||
            start.sourceAttestation.attester == proxyAdmin ||
            start.reconcilerAttestation.attester == proxyAdmin ||
            start.sourceAttestation.attester == proxyAdminOwner ||
            start.reconcilerAttestation.attester == proxyAdminOwner
        ) {
            revert ArchiveMigrationInvalidAuthority();
        }
    }

    function _validateArchiveStartContext(
        FrostRegistryWallets.Data storage wallets,
        ArchiveMigrationStart memory start,
        address implementationSelf
    ) private view {
        if (
            wallets.archiveMigrationState !=
            FrostRegistryWallets.ArchiveMigrationState.Uninitialized ||
            wallets.archiveMigrationManifestHash != bytes32(0) ||
            start.oldImplementation == address(0) ||
            start.oldImplementation == implementationSelf ||
            start.oldImplementation.code.length == 0 ||
            implementationSelf.code.length == 0 ||
            start.checkpointHash == bytes32(0) ||
            start.checkpointBlockHash == bytes32(0) ||
            start.historyCommitment == bytes32(0) ||
            start.scanFromBlock > start.checkpointBlockNumber ||
            start.checkpointBlockNumber >= block.number ||
            start.checkpointBlockNumber > type(uint64).max ||
            start.maxTailBlocks == 0 ||
            start.maxTailBlocks > MAX_ARCHIVE_TAIL_BLOCKS ||
            start.upgradeDeadlineBlock !=
            start.checkpointBlockNumber + start.maxTailBlocks ||
            start.upgradeDeadlineBlock > type(uint64).max ||
            block.number > start.upgradeDeadlineBlock ||
            (start.inventoryCount == 0 && start.inventoryRoot != bytes32(0)) ||
            (start.inventoryCount != 0 && start.inventoryRoot == bytes32(0)) ||
            start.sourceAttestation.sourceIdentityHash == bytes32(0) ||
            start.reconcilerAttestation.sourceIdentityHash == bytes32(0) ||
            start.sourceAttestation.endpointIdentityHash == bytes32(0) ||
            start.reconcilerAttestation.endpointIdentityHash == bytes32(0) ||
            start.sourceAttestation.trustDomainHash == bytes32(0) ||
            start.reconcilerAttestation.trustDomainHash == bytes32(0) ||
            start.sourceAttestation.endpointPolicyHash == bytes32(0) ||
            start.reconcilerAttestation.endpointPolicyHash == bytes32(0) ||
            start.sourceAttestation.sourceIdentityHash ==
            start.reconcilerAttestation.sourceIdentityHash ||
            start.sourceAttestation.endpointIdentityHash ==
            start.reconcilerAttestation.endpointIdentityHash ||
            start.sourceAttestation.trustDomainHash ==
            start.reconcilerAttestation.trustDomainHash ||
            block.number > type(uint64).max
        ) {
            revert ArchiveMigrationInvalidImplementation();
        }
    }

    function _verifyArchiveStart(
        ArchiveMigrationStart memory start,
        address implementationSelf
    ) private view returns (ArchiveStartHashes memory hashes) {
        hashes.oldImplementationCodeHash = start.oldImplementation.codehash;
        hashes.newImplementationCodeHash = implementationSelf.codehash;
        hashes.sourceAttestationHash = _checkpointAttestationDigest(
            start,
            start.sourceAttestation,
            ARCHIVE_SOURCE_ATTESTATION_ROLE
        );
        hashes.reconcilerAttestationHash = _checkpointAttestationDigest(
            start,
            start.reconcilerAttestation,
            ARCHIVE_RECONCILER_ATTESTATION_ROLE
        );
        if (
            !SignatureChecker.isValidSignatureNow(
                start.sourceAttestation.attester,
                hashes.sourceAttestationHash,
                start.sourceAttestation.signature
            ) ||
            !SignatureChecker.isValidSignatureNow(
                start.reconcilerAttestation.attester,
                hashes.reconcilerAttestationHash,
                start.reconcilerAttestation.signature
            )
        ) {
            revert ArchiveMigrationInvalidSignature();
        }
        bytes32 startDigest = _archiveStartDigest(
            start,
            hashes.oldImplementationCodeHash,
            hashes.newImplementationCodeHash,
            hashes.sourceAttestationHash,
            hashes.reconcilerAttestationHash
        );
        if (
            !SignatureChecker.isValidSignatureNow(
                start.authority,
                startDigest,
                start.authoritySignature
            )
        ) {
            revert ArchiveMigrationInvalidSignature();
        }
    }

    function _storeArchiveStart(
        FrostRegistryWallets.Data storage wallets,
        ArchiveMigrationStart memory start,
        ArchiveStartHashes memory hashes
    ) private {
        wallets.archiveMigrationAuthority = start.authority;
        wallets.archiveMigrationUpgradeBlock = uint64(block.number);
        wallets.archiveMigrationState = FrostRegistryWallets
            .ArchiveMigrationState
            .Pending;
        wallets.archiveMigrationOldImplementationCodeHash = hashes
            .oldImplementationCodeHash;
        wallets.archiveMigrationNewImplementationCodeHash = hashes
            .newImplementationCodeHash;
        wallets.archiveMigrationCheckpointHash = start.checkpointHash;
        wallets.archiveMigrationCheckpointBlock = uint64(
            start.checkpointBlockNumber
        );
        wallets.archiveMigrationMaxTailBlocks = uint32(start.maxTailBlocks);
        wallets.archiveMigrationUpgradeDeadlineBlock = uint64(
            start.upgradeDeadlineBlock
        );
        wallets.archiveMigrationSourceAttester = start
            .sourceAttestation
            .attester;
        wallets.archiveMigrationReconcilerAttester = start
            .reconcilerAttestation
            .attester;
        wallets.archiveMigrationSourceAttestationHash = hashes
            .sourceAttestationHash;
        wallets.archiveMigrationReconcilerAttestationHash = hashes
            .reconcilerAttestationHash;
        wallets.archiveMigrationSourceIdentityHash = start
            .sourceAttestation
            .sourceIdentityHash;
        wallets.archiveMigrationSourceEndpointIdentityHash = start
            .sourceAttestation
            .endpointIdentityHash;
        wallets.archiveMigrationSourceTrustDomainHash = start
            .sourceAttestation
            .trustDomainHash;
        wallets.archiveMigrationSourceEndpointPolicyHash = start
            .sourceAttestation
            .endpointPolicyHash;
        wallets.archiveMigrationReconcilerIdentityHash = start
            .reconcilerAttestation
            .sourceIdentityHash;
        wallets.archiveMigrationReconcilerEndpointIdentityHash = start
            .reconcilerAttestation
            .endpointIdentityHash;
        wallets.archiveMigrationReconcilerTrustDomainHash = start
            .reconcilerAttestation
            .trustDomainHash;
        wallets.archiveMigrationReconcilerEndpointPolicyHash = start
            .reconcilerAttestation
            .endpointPolicyHash;

        emit WalletArchiveMigrationStarted(
            start.authority,
            block.number,
            hashes.oldImplementationCodeHash,
            hashes.newImplementationCodeHash,
            start.checkpointHash,
            start.checkpointBlockNumber,
            start.maxTailBlocks,
            start.upgradeDeadlineBlock,
            start.sourceAttestation.attester,
            hashes.sourceAttestationHash,
            start.reconcilerAttestation.attester,
            hashes.reconcilerAttestationHash
        );
    }

    function _checkpointAttestationDigest(
        ArchiveMigrationStart memory start,
        CheckpointAttestation memory attestation,
        bytes32 role
    ) private view returns (bytes32) {
        CheckpointAttestationPayload memory payload;
        payload.chainId = block.chainid;
        payload.registry = address(this);
        payload.role = role;
        payload.attester = attestation.attester;
        payload.checkpointHash = start.checkpointHash;
        payload.scanFromBlock = start.scanFromBlock;
        payload.checkpointBlockNumber = start.checkpointBlockNumber;
        payload.checkpointBlockHash = start.checkpointBlockHash;
        payload.historyCommitment = start.historyCommitment;
        payload.inventoryRoot = start.inventoryRoot;
        payload.inventoryCount = start.inventoryCount;
        payload.maxTailBlocks = start.maxTailBlocks;
        payload.upgradeDeadlineBlock = start.upgradeDeadlineBlock;
        payload.sourceIdentityHash = attestation.sourceIdentityHash;
        payload.endpointIdentityHash = attestation.endpointIdentityHash;
        payload.trustDomainHash = attestation.trustDomainHash;
        payload.endpointPolicyHash = attestation.endpointPolicyHash;
        payload.schemaHash = ARCHIVE_CHECKPOINT_ATTESTATION_SCHEMA_HASH;
        bytes32 structHash = keccak256(
            abi.encode(
                ARCHIVE_CHECKPOINT_ATTESTATION_TYPEHASH,
                keccak256(abi.encode(payload))
            )
        );
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    _archiveDomainSeparator(),
                    structHash
                )
            );
    }

    function _archiveStartDigest(
        ArchiveMigrationStart memory start,
        bytes32 oldImplementationCodeHash,
        bytes32 newImplementationCodeHash,
        bytes32 sourceAttestationHash,
        bytes32 reconcilerAttestationHash
    ) private view returns (bytes32) {
        ArchiveStartAuthorizationPayload memory payload;
        payload.chainId = block.chainid;
        payload.registry = address(this);
        payload.oldImplementationCodeHash = oldImplementationCodeHash;
        payload.newImplementationCodeHash = newImplementationCodeHash;
        payload.authority = start.authority;
        payload.checkpointHash = start.checkpointHash;
        payload.checkpointBlockNumber = start.checkpointBlockNumber;
        payload.maxTailBlocks = start.maxTailBlocks;
        payload.upgradeDeadlineBlock = start.upgradeDeadlineBlock;
        payload.sourceAttester = start.sourceAttestation.attester;
        payload.sourceAttestationHash = sourceAttestationHash;
        payload.reconcilerAttester = start.reconcilerAttestation.attester;
        payload.reconcilerAttestationHash = reconcilerAttestationHash;
        payload.schemaHash = ARCHIVE_START_SCHEMA_HASH;
        bytes32 structHash = keccak256(
            abi.encode(ARCHIVE_START_TYPEHASH, keccak256(abi.encode(payload)))
        );
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    _archiveDomainSeparator(),
                    structHash
                )
            );
    }

    function _archiveDomainSeparator() private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    ARCHIVE_NAME_HASH,
                    ARCHIVE_VERSION_HASH,
                    block.chainid,
                    address(this)
                )
            );
    }

    function commitArchiveMigrationManifest(
        FrostRegistryWallets.Data storage wallets,
        address governance,
        bytes calldata encodedCommit
    ) external {
        require(msg.sender == governance, "Caller is not the governance");
        ArchiveManifestCommit memory commit = abi.decode(
            encodedCommit,
            (ArchiveManifestCommit)
        );
        ArchiveManifest memory manifest = commit.manifest;
        if (
            wallets.archiveMigrationState !=
            FrostRegistryWallets.ArchiveMigrationState.Pending
        ) {
            revert ArchiveMigrationInvalidState();
        }
        if (
            manifest.chainId != block.chainid ||
            manifest.registry != address(this) ||
            manifest.oldImplementationCodeHash !=
            wallets.archiveMigrationOldImplementationCodeHash ||
            manifest.newImplementationCodeHash !=
            wallets.archiveMigrationNewImplementationCodeHash ||
            manifest.checkpointHash != wallets.archiveMigrationCheckpointHash ||
            manifest.checkpointBlockNumber !=
            wallets.archiveMigrationCheckpointBlock ||
            manifest.maxTailBlocks != wallets.archiveMigrationMaxTailBlocks ||
            manifest.upgradeDeadlineBlock !=
            wallets.archiveMigrationUpgradeDeadlineBlock ||
            manifest.sourceAttester != wallets.archiveMigrationSourceAttester ||
            manifest.sourceAttestationHash !=
            wallets.archiveMigrationSourceAttestationHash ||
            manifest.sourceIdentityHash !=
            wallets.archiveMigrationSourceIdentityHash ||
            manifest.sourceEndpointIdentityHash !=
            wallets.archiveMigrationSourceEndpointIdentityHash ||
            manifest.sourceTrustDomainHash !=
            wallets.archiveMigrationSourceTrustDomainHash ||
            manifest.sourceEndpointPolicyHash !=
            wallets.archiveMigrationSourceEndpointPolicyHash ||
            manifest.reconcilerAttester !=
            wallets.archiveMigrationReconcilerAttester ||
            manifest.reconcilerAttestationHash !=
            wallets.archiveMigrationReconcilerAttestationHash ||
            manifest.reconcilerIdentityHash !=
            wallets.archiveMigrationReconcilerIdentityHash ||
            manifest.reconcilerEndpointIdentityHash !=
            wallets.archiveMigrationReconcilerEndpointIdentityHash ||
            manifest.reconcilerTrustDomainHash !=
            wallets.archiveMigrationReconcilerTrustDomainHash ||
            manifest.reconcilerEndpointPolicyHash !=
            wallets.archiveMigrationReconcilerEndpointPolicyHash ||
            manifest.upgradeBlockNumber !=
            wallets.archiveMigrationUpgradeBlock ||
            manifest.upgradeBlockNumber >= block.number ||
            manifest.upgradeBlockNumber > manifest.upgradeDeadlineBlock ||
            manifest.upgradeBlockHash == bytes32(0) ||
            manifest.scanFromBlock > manifest.scanToBlock ||
            manifest.scanFromBlock > manifest.checkpointBlockNumber ||
            manifest.scanToBlock != manifest.upgradeBlockNumber ||
            manifest.checkpointBlockNumber >= manifest.upgradeBlockNumber ||
            manifest.upgradeBlockNumber - manifest.checkpointBlockNumber >
            manifest.maxTailBlocks ||
            manifest.historyRoot == bytes32(0) ||
            manifest.schemaHash != ARCHIVE_SCHEMA_HASH ||
            (manifest.walletCount == 0 && manifest.walletsRoot != bytes32(0)) ||
            (manifest.walletCount != 0 && manifest.walletsRoot == bytes32(0))
        ) {
            revert ArchiveMigrationInvalidManifest();
        }

        if (
            block.number - manifest.upgradeBlockNumber <= 256 &&
            blockhash(manifest.upgradeBlockNumber) != manifest.upgradeBlockHash
        ) {
            revert ArchiveMigrationInvalidManifest();
        }

        bytes32 manifestHash = _archiveManifestDigest(manifest);
        bytes32 sourceAttestationHash = _archiveManifestAttestationDigest(
            manifest,
            manifestHash,
            ARCHIVE_SOURCE_ATTESTATION_ROLE,
            wallets.archiveMigrationSourceAttester
        );
        bytes32 reconcilerAttestationHash = _archiveManifestAttestationDigest(
            manifest,
            manifestHash,
            ARCHIVE_RECONCILER_ATTESTATION_ROLE,
            wallets.archiveMigrationReconcilerAttester
        );
        if (
            !SignatureChecker.isValidSignatureNow(
                wallets.archiveMigrationAuthority,
                manifestHash,
                commit.authoritySignature
            ) ||
            !SignatureChecker.isValidSignatureNow(
                wallets.archiveMigrationSourceAttester,
                sourceAttestationHash,
                commit.sourceSignature
            ) ||
            !SignatureChecker.isValidSignatureNow(
                wallets.archiveMigrationReconcilerAttester,
                reconcilerAttestationHash,
                commit.reconcilerSignature
            )
        ) {
            revert ArchiveMigrationInvalidSignature();
        }

        wallets.archiveMigrationMerkleRoot = manifest.walletsRoot;
        wallets.archiveMigrationHistoryRoot = manifest.historyRoot;
        wallets.archiveMigrationPendingManifestHash = manifestHash;
        wallets
            .archiveMigrationFinalSourceAttestationHash = sourceAttestationHash;
        wallets
            .archiveMigrationFinalReconcilerAttestationHash = reconcilerAttestationHash;
        wallets.archiveMigrationExpectedCount = manifest.walletCount;
        wallets.archiveMigrationState = FrostRegistryWallets
            .ArchiveMigrationState
            .ManifestCommitted;

        emit WalletArchiveMigrationManifestCommitted(
            manifestHash,
            manifest.walletsRoot,
            manifest.walletCount,
            manifest.historyRoot,
            manifest.upgradeBlockHash,
            manifest.upgradeTransactionIndex,
            manifest.scanFromBlock,
            manifest.scanToBlock
        );
    }

    /// @notice ABI-encodes the immutable checkpoint attestation identity set.
    /// @dev Kept in the linked library so the registry retains an EIP-170
    ///      safety margin. Consumers decode the returned bytes in this order:
    ///      deadline, then six source words, then six reconciler words.
    function getArchiveAttestations(FrostRegistryWallets.Data storage wallets)
        external
        view
        returns (bytes memory)
    {
        return
            abi.encode(
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

    function backfillArchivedWalletMembership(
        FrostRegistryWallets.Data storage wallets,
        mapping(bytes32 => bool) storage registered,
        uint256 index,
        bytes32 walletID,
        bytes32 dkgResultHash,
        bytes32 membersIdsHash,
        bytes32[] calldata proof
    ) external {
        if (
            wallets.archiveMigrationState !=
            FrostRegistryWallets.ArchiveMigrationState.ManifestCommitted ||
            index >= wallets.archiveMigrationExpectedCount
        ) {
            revert ArchiveMigrationInvalidState();
        }

        uint256 claimedWordIndex = index >> 8;
        uint256 claimedBit = 1 << (index & 0xff);
        uint256 claimedWord = wallets.archiveMigrationClaimedBitMap[
            claimedWordIndex
        ];
        if (claimedWord & claimedBit != 0) {
            revert ArchiveMigrationIndexAlreadyClaimed();
        }

        bytes32 leaf = keccak256(
            abi.encode(
                ARCHIVE_LEAF_TYPEHASH,
                index,
                walletID,
                dkgResultHash,
                membersIdsHash
            )
        );
        if (
            !MerkleProof.verifyCalldata(
                proof,
                wallets.archiveMigrationMerkleRoot,
                leaf
            )
        ) {
            revert ArchiveMigrationInvalidProof();
        }

        wallets.archiveMigrationClaimedBitMap[claimedWordIndex] =
            claimedWord |
            claimedBit;
        wallets.backfillArchivedWalletMembership(
            registered,
            walletID,
            membersIdsHash
        );
        wallets.archiveMigrationCompletedCount++;
        emit WalletMembershipBackfilled(walletID, membersIdsHash);
    }

    function finalizeArchiveMigration(
        FrostRegistryWallets.Data storage wallets,
        DKG.Data storage dkg
    ) external {
        if (
            wallets.archiveMigrationState !=
            FrostRegistryWallets.ArchiveMigrationState.ManifestCommitted
        ) {
            revert ArchiveMigrationInvalidState();
        }
        if (
            wallets.archiveMigrationCompletedCount !=
            wallets.archiveMigrationExpectedCount
        ) {
            revert ArchiveMigrationIncomplete();
        }

        if (dkg.submittedResultBlock != 0) {
            dkg.submittedResultBlock = block.number;
        }
        bytes32 manifestHash = wallets.archiveMigrationPendingManifestHash;
        wallets.archiveMigrationManifestHash = manifestHash;
        wallets.archiveMigrationState = FrostRegistryWallets
            .ArchiveMigrationState
            .Completed;
        emit WalletArchiveMigrationCompleted(manifestHash);
    }

    function _archiveManifestDigest(ArchiveManifest memory manifest)
        private
        view
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                ARCHIVE_NAME_HASH,
                ARCHIVE_VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                ARCHIVE_MANIFEST_TYPEHASH,
                keccak256(abi.encode(manifest))
            )
        );
        return
            keccak256(
                abi.encodePacked("\x19\x01", domainSeparator, structHash)
            );
    }

    function _archiveManifestAttestationDigest(
        ArchiveManifest memory manifest,
        bytes32 manifestHash,
        bytes32 role,
        address attester
    ) private view returns (bytes32) {
        ManifestAttestationPayload memory payload;
        payload.chainId = block.chainid;
        payload.registry = address(this);
        payload.role = role;
        payload.attester = attester;
        payload.manifestHash = manifestHash;
        payload.checkpointHash = manifest.checkpointHash;
        payload.upgradeBlockNumber = manifest.upgradeBlockNumber;
        payload.upgradeBlockHash = manifest.upgradeBlockHash;
        payload.upgradeTransactionIndex = manifest.upgradeTransactionIndex;
        payload.historyRoot = manifest.historyRoot;
        payload.walletsRoot = manifest.walletsRoot;
        payload.walletCount = manifest.walletCount;
        payload.schemaHash = ARCHIVE_MANIFEST_ATTESTATION_SCHEMA_HASH;
        bytes32 structHash = keccak256(
            abi.encode(
                ARCHIVE_MANIFEST_ATTESTATION_TYPEHASH,
                keccak256(abi.encode(payload))
            )
        );
        return
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    _archiveDomainSeparator(),
                    structHash
                )
            );
    }

    /// @notice Completes DKG approval and wallet registration. This remains in
    ///         the linked library to keep the registry under EIP-170.
    function approveDkgResult(
        DKG.Data storage dkg,
        FrostRegistryWallets.Data storage wallets,
        mapping(bytes32 => bool) storage registered,
        SortitionPool sortitionPool,
        IFrostWalletOwner walletOwner,
        ReimbursementPool reimbursementPool,
        uint256 rewardsBanDuration,
        uint256 submissionGas,
        uint256 approvalGasOffset,
        DKG.Result calldata dkgResult
    ) external {
        uint256 gasStart = gasleft();
        uint32[] memory misbehavedMembers = dkg.approveResult(dkgResult);

        bytes32 walletID = wallets.addWallet(
            dkgResult.membersHash,
            dkgResult.xOnlyOutputKey
        );
        registered[dkgResult.xOnlyOutputKey] = true;
        emit WalletCreated(walletID, keccak256(abi.encode(dkgResult)));

        if (misbehavedMembers.length > 0) {
            sortitionPool.setRewardIneligibility(
                misbehavedMembers,
                // solhint-disable-next-line not-rely-on-time
                block.timestamp + rewardsBanDuration
            );
        }

        walletOwner.__frostWalletCreatedCallback(dkgResult.xOnlyOutputKey);
        dkg.complete();

        reimbursementPool.refund(
            submissionGas + (gasStart - gasleft()) + approvalGasOffset,
            msg.sender
        );
    }

    function submitDkgResult(
        DKG.Data storage dkg,
        FrostRegistryWallets.Data storage wallets,
        mapping(bytes32 => bool) storage registered,
        DKG.Result calldata dkgResult
    ) external {
        if (registered[dkgResult.xOnlyOutputKey]) {
            revert FrostRegistryWallets.XOnlyOutputKeyAlreadyRegistered();
        }
        wallets.validateXOnlyOutputKey(dkgResult.xOnlyOutputKey);
        dkg.submitResult(dkgResult);
    }

    /// @notice Verifies and finalizes an inactivity claim. The nonce is
    ///         consumed before any external effect, so a failed wallet-owner
    ///         callback reverts atomically and leaves the claim retryable.
    /// @dev Kept in the already-linked inactivity library to preserve the
    ///      registry implementation's EIP-170 deployment-size budget.
    function processClaim(
        mapping(bytes32 => uint256) storage inactivityClaimNonce,
        SortitionPool sortitionPool,
        IFrostWalletOwner walletOwner,
        Claim calldata claim,
        bytes32 xOnlyOutputKey,
        uint256 nonce,
        uint32[] calldata groupMembers,
        uint256 rewardsBanDuration
    ) external {
        uint32[] memory ineligibleOperators = _verifyClaim(
            sortitionPool,
            claim,
            xOnlyOutputKey,
            nonce,
            groupMembers
        );

        inactivityClaimNonce[claim.walletID]++;

        emit InactivityClaimed(claim.walletID, nonce, msg.sender);

        sortitionPool.setRewardIneligibility(
            ineligibleOperators,
            // solhint-disable-next-line not-rely-on-time
            block.timestamp + rewardsBanDuration
        );

        if (claim.heartbeatFailed) {
            walletOwner.__frostWalletHeartbeatFailedCallback(xOnlyOutputKey);
        }
    }

    /// @notice Verifies the inactivity claim according to the rules defined in
    ///         `Claim` struct documentation. Reverts if verification fails.
    /// @dev Wallet signing group members hash is validated upstream in
    ///      `WalletRegistry.notifyOperatorInactivity()`
    /// @param sortitionPool Sortition pool reference
    /// @param claim Inactivity claim
    /// @param xOnlyOutputKey FROST x-only Taproot output key of the
    ///        wallet (replaces the ECDSA-shaped `bytes walletPubKey`
    ///        param). Signed alongside the other digest fields by
    ///        each participating member.
    /// @param nonce Current inactivity nonce for wallet used in the claim
    /// @param groupMembers Identifiers of group members
    /// @return inactiveMembers Identifiers of members who are inactive
    function verifyClaim(
        SortitionPool sortitionPool,
        Claim calldata claim,
        bytes32 xOnlyOutputKey,
        uint256 nonce,
        uint32[] calldata groupMembers
    ) external view returns (uint32[] memory inactiveMembers) {
        return
            _verifyClaim(
                sortitionPool,
                claim,
                xOnlyOutputKey,
                nonce,
                groupMembers
            );
    }

    function _verifyClaim(
        SortitionPool sortitionPool,
        Claim calldata claim,
        bytes32 xOnlyOutputKey,
        uint256 nonce,
        uint32[] calldata groupMembers
    ) internal view returns (uint32[] memory inactiveMembers) {
        // Validate inactive members indices. Maximum indices count is equal to
        // the group size and is not limited deliberately to leave a theoretical
        // possibility to accuse more members than `groupSize - groupThreshold`.
        validateMembersIndices(
            claim.inactiveMembersIndices,
            groupMembers.length
        );

        // Validate signatures array is properly formed and number of
        // signatures and signers is correct.
        uint256 signaturesCount = claim.signatures.length / signatureByteSize;
        require(claim.signatures.length != 0, "No signatures provided");
        require(
            claim.signatures.length % signatureByteSize == 0,
            "Malformed signatures array"
        );
        require(
            signaturesCount == claim.signingMembersIndices.length,
            "Unexpected signatures count"
        );
        require(signaturesCount >= groupThreshold, "Too few signatures");
        require(signaturesCount <= groupMembers.length, "Too many signatures");

        // Validate signing members indices. Note that `signingMembersIndices`
        // were already partially validated during `signatures` parameter
        // validation.
        validateMembersIndices(
            claim.signingMembersIndices,
            groupMembers.length
        );

        bytes32 signedMessageHash = keccak256(
            abi.encode(
                block.chainid,
                nonce,
                xOnlyOutputKey,
                claim.inactiveMembersIndices,
                claim.heartbeatFailed
            )
        ).toEthSignedMessageHash();

        address[] memory groupMembersAddresses = sortitionPool.getIDOperators(
            groupMembers
        );

        // Verify each signature.
        bytes memory checkedSignature;
        bool senderSignatureExists = false;
        for (uint256 i = 0; i < signaturesCount; i++) {
            uint256 memberIndex = claim.signingMembersIndices[i];
            checkedSignature = claim.signatures.slice(
                signatureByteSize * i,
                signatureByteSize
            );
            address recoveredAddress = signedMessageHash.recover(
                checkedSignature
            );

            require(
                groupMembersAddresses[memberIndex - 1] == recoveredAddress,
                "Invalid signature"
            );

            if (!senderSignatureExists && msg.sender == recoveredAddress) {
                senderSignatureExists = true;
            }
        }

        require(senderSignatureExists, "Sender must be claim signer");

        inactiveMembers = new uint32[](claim.inactiveMembersIndices.length);
        for (uint256 i = 0; i < claim.inactiveMembersIndices.length; i++) {
            uint256 memberIndex = claim.inactiveMembersIndices[i];
            inactiveMembers[i] = groupMembers[memberIndex - 1];
        }

        return inactiveMembers;
    }

    /// @notice Validates members indices array. Array is considered valid
    ///         if its size and each single index are in [1, groupSize] range,
    ///         indexes are unique, and sorted in an ascending order.
    ///         Reverts if validation fails.
    /// @param indices Array to validate.
    /// @param groupSize Group size used as reference.
    function validateMembersIndices(
        uint256[] calldata indices,
        uint256 groupSize
    ) internal pure {
        require(
            indices.length > 0 && indices.length <= groupSize,
            "Corrupted members indices"
        );

        // Check if first and last indices are in range [1, groupSize].
        // This check combined with the loop below makes sure every single
        // index is in the correct range.
        require(
            indices[0] > 0 && indices[indices.length - 1] <= groupSize,
            "Corrupted members indices"
        );

        for (uint256 i = 0; i < indices.length - 1; i++) {
            // Check whether given index is smaller than the next one. This
            // way we are sure indexes are ordered in the ascending order
            // and there are no duplicates.
            require(indices[i] < indices[i + 1], "Corrupted members indices");
        }
    }
}
