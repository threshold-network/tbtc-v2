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

/// @title FROST wallet registry storage library.
/// @notice Mirrors `@keep-network/ecdsa/contracts/libraries/Wallets.sol` but
///         stores a FROST `xOnlyOutputKey` (bytes32) instead of an
///         uncompressed ECDSA public key (X, Y). The walletID itself is
///         the x-only output key — the FROST DKG's canonical wallet
///         identifier — so the `publicKeyHash → walletID` derivation step
///         used by the ECDSA registry is no longer needed.
library FrostRegistryWallets {
    /// @dev Custom errors instead of require strings: the 4-byte
    ///      custom-error selector survives every JSON-RPC node
    ///      configuration and hardhat-waffle matcher version we've
    ///      seen. The original require strings were correctly
    ///      embedded by solc, but in some environments waffle's
    ///      `revertedWith(...)` matcher reported "other reason was
    ///      found: \"\"" because the node response carried an empty
    ///      revert reason for transactional calls into pure
    ///      library functions. Custom errors sidestep the issue.
    error XOnlyOutputKeyIsZero();
    error XOnlyOutputKeyIsLegacyAlias();
    error XOnlyOutputKeyAlreadyRegistered();
    error WalletNotRegistered();
    error WalletMembersIdsHashIsZero();
    error WalletWasNeverRegistered();
    error WalletStillRegistered();
    error WalletAlreadyArchived();
    error WalletArchiveMigrationAlreadyCompleted();
    error WalletArchiveMigrationNotReady();

    enum ArchiveMigrationState {
        Uninitialized,
        Pending,
        ManifestCommitted,
        Completed,
        Fresh
    }

    struct Wallet {
        // Keccak256 hash of group members identifiers array. Group members
        // do not include operators selected by the sortition pool that
        // misbehaved during DKG.
        bytes32 membersIdsHash;
        // The 32-byte x-only Taproot output key produced by the FROST DKG
        // (BIP-340 / BIP-341). This IS the walletID — the registry maps
        // walletID → Wallet via this field's value.
        bytes32 xOnlyOutputKey;
        // This struct doesn't contain `__gap` property as the structure is
        // stored in a mapping, mappings store values in different slots and
        // they are not contiguous with other values.
    }

    struct Data {
        // Mapping of walletID (== xOnlyOutputKey) to wallet details.
        mapping(bytes32 => Wallet) registry;
        // Immutable tombstones for wallets removed from the active registry.
        // Membership commitments must remain available after lifecycle close
        // so delayed Bitcoin proofs and recovery obligations can still bind to
        // the wallet's original signing group. An archived wallet ID can never
        // be registered again.
        mapping(bytes32 => Wallet) archived;
        // Existing proxies read zero after the archive implementation is
        // installed. Fresh deployments and fully verified historical
        // migrations store their signed manifest root before new wallet work
        // is permitted. A non-zero root is the completion sentinel.
        bytes32 archiveMigrationManifestHash;
        // Independent authority attesting the canonical legacy-loss manifest.
        // Packed with the upgrade block and state in one slot.
        address archiveMigrationAuthority;
        uint64 archiveMigrationUpgradeBlock;
        ArchiveMigrationState archiveMigrationState;
        bytes32 archiveMigrationOldImplementationCodeHash;
        bytes32 archiveMigrationNewImplementationCodeHash;
        bytes32 archiveMigrationMerkleRoot;
        bytes32 archiveMigrationHistoryRoot;
        bytes32 archiveMigrationPendingManifestHash;
        uint256 archiveMigrationExpectedCount;
        uint256 archiveMigrationCompletedCount;
        mapping(uint256 => uint256) archiveMigrationClaimedBitMap;
        bytes32 archiveMigrationCheckpointHash;
        uint64 archiveMigrationCheckpointBlock;
        uint32 archiveMigrationMaxTailBlocks;
        uint64 archiveMigrationUpgradeDeadlineBlock;
        address archiveMigrationSourceAttester;
        address archiveMigrationReconcilerAttester;
        bytes32 archiveMigrationSourceAttestationHash;
        bytes32 archiveMigrationReconcilerAttestationHash;
        bytes32 archiveMigrationSourceIdentityHash;
        bytes32 archiveMigrationSourceEndpointIdentityHash;
        bytes32 archiveMigrationSourceTrustDomainHash;
        bytes32 archiveMigrationSourceEndpointPolicyHash;
        bytes32 archiveMigrationReconcilerIdentityHash;
        bytes32 archiveMigrationReconcilerEndpointIdentityHash;
        bytes32 archiveMigrationReconcilerTrustDomainHash;
        bytes32 archiveMigrationReconcilerEndpointPolicyHash;
        bytes32 archiveMigrationFinalSourceAttestationHash;
        bytes32 archiveMigrationFinalReconcilerAttestationHash;
        // Reserved storage space in case we need to add more variables.
        // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
        // slither-disable-next-line unused-state
        uint256[22] __gap;
    }

    /// @notice Performs preliminary validation of a new FROST wallet's
    ///         x-only output key. The key must be:
    ///         (a) non-zero,
    ///         (b) NOT a legacy-padded ECDSA alias (high 12 bytes
    ///             non-zero) — mirrors the Bridge's
    ///             `FrostWalletIdNotNative` guard in
    ///             `contracts/bridge/Wallets.sol:registerNewFrostWallet`,
    ///         (c) not already registered.
    ///         Reverts on failure.
    /// @dev RFC v4 + post-merge follow-up: enforcing the native-ID
    ///      shape HERE — before the result enters the challenge
    ///      window — prevents a wedge state where the validator
    ///      accepts a result with a legacy-shaped x-only key but
    ///      `approveDkgResult` later reverts on the Bridge's
    ///      `FrostWalletIdNotNative` check, leaving the DKG state
    ///      machine locked (no valid challenge basis, no successful
    ///      approval).
    /// @param xOnlyOutputKey The 32-byte x-only Taproot output key.
    function validateXOnlyOutputKey(Data storage self, bytes32 xOnlyOutputKey)
        internal
        view
    {
        if (xOnlyOutputKey == bytes32(0)) {
            revert XOnlyOutputKeyIsZero();
        }
        if (bytes12(xOnlyOutputKey) == bytes12(0)) {
            revert XOnlyOutputKeyIsLegacyAlias();
        }
        if (
            self.registry[xOnlyOutputKey].xOnlyOutputKey != bytes32(0) ||
            self.archived[xOnlyOutputKey].xOnlyOutputKey != bytes32(0)
        ) {
            revert XOnlyOutputKeyAlreadyRegistered();
        }
    }

    /// @notice Registers a new FROST wallet. Caller must have first
    ///         invoked `validateXOnlyOutputKey`.
    /// @param membersIdsHash Keccak256 hash of group members identifiers
    ///        array.
    /// @param xOnlyOutputKey The 32-byte x-only Taproot output key. Used
    ///        directly as the walletID.
    /// @return walletID The wallet's canonical id (== xOnlyOutputKey).
    /// @dev Inline duplicate guard (`registry[walletID].xOnlyOutputKey
    ///      == bytes32(0)`) re-checks the precondition that callers
    ///      must have invoked `validateXOnlyOutputKey`. Cheap invariant
    ///      hygiene so a future caller that forgets the precondition,
    ///      or a reentrancy from `__frostWalletCreatedCallback`, cannot
    ///      silently overwrite an existing wallet row.
    function addWallet(
        Data storage self,
        bytes32 membersIdsHash,
        bytes32 xOnlyOutputKey
    ) internal returns (bytes32 walletID) {
        walletID = xOnlyOutputKey;
        if (self.registry[walletID].xOnlyOutputKey != bytes32(0)) {
            revert XOnlyOutputKeyAlreadyRegistered();
        }
        self.registry[walletID].membersIdsHash = membersIdsHash;
        self.registry[walletID].xOnlyOutputKey = xOnlyOutputKey;
    }

    /// @notice Deletes a wallet with the given ID from the registry.
    /// @dev Reverts if the wallet is not registered.
    function deleteWallet(Data storage self, bytes32 walletID) internal {
        Wallet storage wallet = self.registry[walletID];
        if (wallet.xOnlyOutputKey == bytes32(0)) {
            revert WalletNotRegistered();
        }

        self.archived[walletID] = wallet;
        delete self.registry[walletID];
    }

    function isArchiveReady(Data storage self) internal view returns (bool) {
        return
            self.archiveMigrationState == ArchiveMigrationState.Completed ||
            self.archiveMigrationState == ArchiveMigrationState.Fresh;
    }

    /// @notice Restores the membership commitment of a wallet closed by an
    ///         implementation deployed before archive tombstones existed.
    /// @dev `registered` is the permanent registry-level record written when
    ///      DKG approval first created the wallet. It prevents governance from
    ///      manufacturing historical wallets. The caller must independently
    ///      reconstruct and verify `membersIdsHash` from canonical DKG events.
    function backfillArchivedWalletMembership(
        Data storage self,
        mapping(bytes32 => bool) storage registered,
        bytes32 walletID,
        bytes32 membersIdsHash
    ) internal {
        if (membersIdsHash == bytes32(0)) {
            revert WalletMembersIdsHashIsZero();
        }
        if (!registered[walletID]) {
            revert WalletWasNeverRegistered();
        }
        if (self.registry[walletID].xOnlyOutputKey != bytes32(0)) {
            revert WalletStillRegistered();
        }
        if (self.archived[walletID].xOnlyOutputKey != bytes32(0)) {
            revert WalletAlreadyArchived();
        }

        self.archived[walletID] = Wallet({
            membersIdsHash: membersIdsHash,
            xOnlyOutputKey: walletID
        });
    }

    /// @notice Checks if a wallet with the given ID is registered.
    function isWalletRegistered(Data storage self, bytes32 walletID)
        internal
        view
        returns (bool)
    {
        return self.registry[walletID].xOnlyOutputKey != bytes32(0);
    }

    /// @notice Returns Keccak256 hash of the wallet signing group members
    ///         identifiers array. Reverts if the wallet is not registered.
    function getWalletMembersIdsHash(Data storage self, bytes32 walletID)
        internal
        view
        returns (bytes32)
    {
        if (!isWalletRegistered(self, walletID)) {
            revert WalletNotRegistered();
        }
        return self.registry[walletID].membersIdsHash;
    }

    /// @notice Returns the members commitment for an active or archived
    ///         wallet. Reverts if the wallet ID has never been registered.
    function getRetainedWalletMembersIdsHash(
        Data storage self,
        bytes32 walletID
    ) internal view returns (bytes32) {
        Wallet storage wallet = self.registry[walletID];
        if (wallet.xOnlyOutputKey == bytes32(0)) {
            wallet = self.archived[walletID];
        }
        if (wallet.xOnlyOutputKey == bytes32(0)) {
            revert WalletNotRegistered();
        }
        return wallet.membersIdsHash;
    }

    /// @notice Returns the FROST x-only output key for a registered
    ///         wallet. Reverts if the wallet is not registered.
    function getWalletXOnlyOutputKey(Data storage self, bytes32 walletID)
        internal
        view
        returns (bytes32)
    {
        if (!isWalletRegistered(self, walletID)) {
            revert WalletNotRegistered();
        }
        return self.registry[walletID].xOnlyOutputKey;
    }
}
