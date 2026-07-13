// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./BridgeState.sol";
import "../vault/ITBTCVaultMigrationDebt.sol";
import "../vault/ILegacyTBTCVaultMigrationCoordinator.sol";

/// @title Bridge vault management and legacy retirement
/// @notice Library carrying the Bridge vault trust list, the canonical
///         migration-debt vault management, and the legacy-vault
///         optimistic-minting retirement guard/attestation. It is delegatecalled
///         by the Bridge, so every read/write of `self` targets the Bridge proxy
///         storage, `emit` attributes the log to the Bridge, and `address(this)`
///         is the Bridge proxy.
/// @dev Deployed as an external library and linked into the Bridge, matching the
///      `Deposit`, `DepositSweep`, `Redemption`, `Fraud`, `Wallets`, and
///      `MovingFunds` pattern. The vault-management surface lives here so the
///      Bridge stays within the EIP-170 deployed-bytecode limit while gaining the
///      legacy-retirement guard and attestation.
///
///      The known-legacy identity (mainnet address and runtime code hash) is
///      passed in by the caller, so the production Bridge supplies its immutable
///      `public constant`s while the isolated test harness may supply a
///      configurable identity pointing at a mock vault. The production Bridge
///      always passes the exact constants, so the override can never apply to
///      any other address or bytecode.
///
///      Every external read that decides whether a retirement is authorized is
///      fail-closed: it validates the exact ABI return size and value and treats
///      any malformed or reverting response as a failed check, never a
///      permissive pass. The pre-existing migration-debt reads keep their prior
///      fail-open semantics for backwards compatibility.
library VaultManagement {
    event VaultStatusUpdated(address indexed vault, bool isTrusted);
    event MigrationDebtVaultUpdated(address indexed migrationDebtVault);
    /// @notice Emitted when governance records or revokes a legacy-vault
    ///         optimistic-minting retirement attestation. A nonzero
    ///         `coordinator` is governance's assertion that its complete scan
    ///         from the legacy deployment block through the named snapshot found
    ///         zero finalized optimistic-mint deposit keys with `sweptAt == 0`;
    ///         any nonzero residual mapping debt is accepted as already-swept
    ///         residual. Also declared on `Bridge` so it appears in the Bridge
    ///         ABI.
    event LegacyVaultOptimisticMintingDebtAttestationUpdated(
        address indexed vault,
        address indexed coordinator,
        uint256 snapshotBlockNumber,
        bytes32 snapshotBlockHash,
        bytes32 evidenceHash
    );

    error VaultIsCanonicalMigrationDebtVault(address vault);
    error VaultHasOutstandingMigrationDebt(address vault);
    error VaultHasOutstandingOptimisticMintingDebt(address vault);
    error VaultNotTrusted(address vault);
    error PreviousMigrationDebtVaultIsZero();
    error PreviousMigrationDebtVaultMismatch(address expected, address actual);
    error MigrationDebtVaultUnchanged(address vault);
    error MigrationDebtVaultInterfaceMissing(address vault);
    error MigrationDebtVaultUnreachable(address vault);
    error PreviousMigrationDebtVaultHasDebt(address vault);
    error PreviousMigrationDebtVaultHasOptimisticDebt(address vault);

    /// @notice The queried vault is not the exact known legacy deployment.
    error UnsupportedLegacyVault(address vault);
    /// @notice The known legacy address holds unexpected bytecode.
    error LegacyVaultCodeHashMismatch(address vault, bytes32 actualCodeHash);
    /// @notice The known legacy vault has no recorded retirement attestation.
    error LegacyVaultOptimisticMintingDebtAttestationMissing(address vault);
    /// @notice The known legacy vault does not report paused optimistic minting.
    error LegacyVaultOptimisticMintingNotPaused(address vault);
    /// @notice The bound coordinator fails a required binding or is not locked.
    error LegacyVaultMigrationCoordinatorInvalid(
        address vault,
        address coordinator
    );
    /// @notice The snapshot/evidence arguments are invalid for the requested
    ///         attestation form.
    error LegacyVaultEvidenceInvalid();
    /// @notice A revocation was attempted after the vault was already untrusted.
    error LegacyVaultAttestationCannotBeRevoked(address vault);
    /// @notice The attested-and-untrusted legacy vault cannot be re-trusted.
    error LegacyVaultAlreadyRetired(address vault);
    /// @notice A vault that decodably answers the aggregate optimistic-debt
    ///         selector may never use the legacy override.
    error LegacyVaultImplementsOptimisticMintingDebtInterface(address vault);
    /// @notice The known legacy vault is not trusted, so an attestation cannot
    ///         be recorded for it.
    error LegacyVaultNotTrusted(address vault);

    /// @notice Marks a vault trusted or no longer trusted. See
    ///         `Bridge.setVaultStatus` for the full guard description.
    /// @dev When untrusting: the canonical migration-debt vault cannot be
    ///      untrusted directly; a vault with outstanding migration debt cannot
    ///      be untrusted (fail-open probe); and a vault with outstanding
    ///      optimistic minting debt cannot be untrusted (fail-open/fail-closed
    ///      truth table, known-legacy fail-closed). When trusting: re-trusting an
    ///      attested-and-retired known legacy vault reverts.
    function setVaultStatus(
        BridgeState.Storage storage self,
        address vault,
        bool isTrusted,
        address governance,
        address knownVault,
        bytes32 knownCodeHash
    ) public {
        if (!isTrusted && self.migrationDebtVault == vault) {
            revert VaultIsCanonicalMigrationDebtVault(vault);
        }

        if (!isTrusted) {
            if (_hasOutstandingMigrationDebt(vault)) {
                revert VaultHasOutstandingMigrationDebt(vault);
            }
            if (
                _optimisticMintingUntrustBlocked(
                    self,
                    vault,
                    governance,
                    knownVault,
                    knownCodeHash
                )
            ) {
                revert VaultHasOutstandingOptimisticMintingDebt(vault);
            }
        } else {
            _requireRetrustAllowed(self, vault, knownVault, knownCodeHash);
        }

        self.isVaultTrusted[vault] = isTrusted;
        emit VaultStatusUpdated(vault, isTrusted);
    }

    /// @notice Sets the canonical migration-debt vault. See
    ///         `Bridge.setMigrationDebtVault`. Exempt from the optimistic-mint
    ///         guard because changing the pointer without changing trust does not
    ///         select the sweep-rerouting branch.
    function setMigrationDebtVault(
        BridgeState.Storage storage self,
        address vault
    ) public {
        if (vault != address(0) && !self.isVaultTrusted[vault]) {
            revert VaultNotTrusted(vault);
        }

        if (vault != address(0)) {
            if (!_isMigrationDebtVaultConforming(vault)) {
                revert MigrationDebtVaultInterfaceMissing(vault);
            }
        }

        address previousVault = self.migrationDebtVault;
        if (vault != address(0) && previousVault != address(0)) {
            (bool ok, bool hasDebt) = _getOutstandingMigrationDebt(
                previousVault
            );
            if (!ok) {
                revert MigrationDebtVaultUnreachable(previousVault);
            }
            if (hasDebt) {
                revert PreviousMigrationDebtVaultHasDebt(previousVault);
            }
        }

        self.migrationDebtVault = vault;
        emit MigrationDebtVaultUpdated(vault);
    }

    /// @notice Atomically rotates the canonical migration-debt vault and
    ///         untrusts the previous canonical vault. See
    ///         `Bridge.rotateMigrationDebtVault`. The previous-vault untrust
    ///         applies the same optimistic-mint truth table (including the
    ///         known-legacy fail-closed treatment) as `setVaultStatus`.
    function rotateMigrationDebtVault(
        BridgeState.Storage storage self,
        address newVault,
        address previousVault,
        address governance,
        address knownVault,
        bytes32 knownCodeHash
    ) public {
        if (previousVault == address(0)) {
            revert PreviousMigrationDebtVaultIsZero();
        }
        if (previousVault != self.migrationDebtVault) {
            revert PreviousMigrationDebtVaultMismatch(
                self.migrationDebtVault,
                previousVault
            );
        }
        if (newVault == previousVault) {
            revert MigrationDebtVaultUnchanged(newVault);
        }
        if (newVault != address(0) && !self.isVaultTrusted[newVault]) {
            revert VaultNotTrusted(newVault);
        }

        if (newVault != address(0)) {
            if (!_isMigrationDebtVaultConforming(newVault)) {
                revert MigrationDebtVaultInterfaceMissing(newVault);
            }
        }

        if (_hasOutstandingMigrationDebt(previousVault)) {
            revert PreviousMigrationDebtVaultHasDebt(previousVault);
        }

        if (
            _optimisticMintingUntrustBlocked(
                self,
                previousVault,
                governance,
                knownVault,
                knownCodeHash
            )
        ) {
            revert PreviousMigrationDebtVaultHasOptimisticDebt(previousVault);
        }

        self.migrationDebtVault = newVault;
        emit MigrationDebtVaultUpdated(newVault);

        self.isVaultTrusted[previousVault] = false;
        emit VaultStatusUpdated(previousVault, false);
    }

    /// @notice Records or revokes the legacy-vault retirement attestation. See
    ///         `Bridge.setLegacyVaultOptimisticMintingDebtAttestation`.
    function setAttestation(
        BridgeState.Storage storage self,
        address governance,
        address vault,
        address coordinator,
        uint256 snapshotBlockNumber,
        bytes32 snapshotBlockHash,
        bytes32 evidenceHash,
        address knownVault,
        bytes32 knownCodeHash
    ) public {
        // Both the set and the revoke forms are restricted to the exact known
        // legacy deployment. This is not a general bytecode allowlist: the
        // address check prevents matching other bytecode, and the code-hash
        // check prevents matching a different deployment at the same address on
        // another chain.
        if (vault != knownVault) {
            revert UnsupportedLegacyVault(vault);
        }
        bytes32 actualCodeHash = vault.codehash;
        if (actualCodeHash != knownCodeHash) {
            revert LegacyVaultCodeHashMismatch(vault, actualCodeHash);
        }

        if (coordinator == address(0)) {
            // Revocation: only while the vault is still trusted, with every
            // snapshot/evidence argument zero. Revoking after retirement would
            // let the attestation be removed between untrust and coordinator
            // finalization.
            if (
                snapshotBlockNumber != 0 ||
                snapshotBlockHash != bytes32(0) ||
                evidenceHash != bytes32(0)
            ) {
                revert LegacyVaultEvidenceInvalid();
            }
            if (!self.isVaultTrusted[vault]) {
                revert LegacyVaultAttestationCannotBeRevoked(vault);
            }

            self.legacyVaultOptimisticMintingDebtCoordinator[vault] = address(
                0
            );
            emit LegacyVaultOptimisticMintingDebtAttestationUpdated(
                vault,
                address(0),
                0,
                bytes32(0),
                bytes32(0)
            );
            return;
        }

        // Set form. The vault must be trusted; a conforming vault (one that
        // decodably answers the aggregate selector) may never use this override;
        // the evidence arguments must be well-formed; the vault must be paused;
        // and the bound coordinator must own the paused vault and be bound to
        // this vault, this Bridge, and the current governance.
        if (!self.isVaultTrusted[vault]) {
            revert LegacyVaultNotTrusted(vault);
        }
        (bool selectorDecodable, ) = _probeOptimisticMintingDebt(vault);
        if (selectorDecodable) {
            revert LegacyVaultImplementsOptimisticMintingDebtInterface(vault);
        }
        if (
            snapshotBlockNumber == 0 ||
            snapshotBlockNumber >= block.number ||
            snapshotBlockHash == bytes32(0) ||
            evidenceHash == bytes32(0)
        ) {
            revert LegacyVaultEvidenceInvalid();
        }
        if (!_optimisticMintingPaused(vault)) {
            revert LegacyVaultOptimisticMintingNotPaused(vault);
        }
        if (!_coordinatorBound(vault, coordinator, governance)) {
            revert LegacyVaultMigrationCoordinatorInvalid(vault, coordinator);
        }

        self.legacyVaultOptimisticMintingDebtCoordinator[vault] = coordinator;
        emit LegacyVaultOptimisticMintingDebtAttestationUpdated(
            vault,
            coordinator,
            snapshotBlockNumber,
            snapshotBlockHash,
            evidenceHash
        );
    }

    /// @notice Applies the untrust/rotation optimistic-minting-debt truth table
    ///         for a vault being untrusted or rotated away from.
    /// @return hasDebt True when the debt query decodes to `true`; the caller
    ///         then reverts with its operation-specific optimistic-debt error.
    /// @dev Truth table:
    ///      - decodable `true`  (any vault): returns true so the caller reverts;
    ///      - decodable `false` (any vault): returns false, guard allowed;
    ///      - failed/malformed, not the exact known legacy vault: returns false,
    ///        preserving the existing fail-open compatibility for pre-interface
    ///        vaults; and
    ///      - failed/malformed, the exact known legacy vault: requires a valid,
    ///        locked, attested retirement, otherwise reverts.
    function _optimisticMintingUntrustBlocked(
        BridgeState.Storage storage self,
        address vault,
        address governance,
        address knownVault,
        bytes32 knownCodeHash
    ) private view returns (bool hasDebt) {
        (bool decodable, bool debt) = _probeOptimisticMintingDebt(vault);
        if (decodable) {
            // A decodable answer is authoritative regardless of identity; a
            // conforming vault reporting outstanding debt always blocks.
            return debt;
        }

        // The query failed or was malformed. Only the exact known legacy
        // deployment is special-cased; every other vault keeps the historical
        // fail-open behavior.
        if (_isKnownLegacyVault(vault, knownVault, knownCodeHash)) {
            _requireRetirementAuthorized(self, vault, governance);
        }

        return false;
    }

    /// @notice Reverts when re-trusting an attested-and-retired known legacy
    ///         vault. A nonzero attestation marks an irreversible retirement.
    function _requireRetrustAllowed(
        BridgeState.Storage storage self,
        address vault,
        address knownVault,
        bytes32 knownCodeHash
    ) private view {
        if (
            _isKnownLegacyVault(vault, knownVault, knownCodeHash) &&
            self.legacyVaultOptimisticMintingDebtCoordinator[vault] !=
            address(0)
        ) {
            revert LegacyVaultAlreadyRetired(vault);
        }
    }

    /// @notice Requires the known legacy vault's retirement to be authorized: a
    ///         recorded attestation, paused optimistic minting, and a valid,
    ///         locked, bound coordinator. Reverts otherwise.
    function _requireRetirementAuthorized(
        BridgeState.Storage storage self,
        address vault,
        address governance
    ) private view {
        address coordinator = self.legacyVaultOptimisticMintingDebtCoordinator[
            vault
        ];
        if (coordinator == address(0)) {
            revert LegacyVaultOptimisticMintingDebtAttestationMissing(vault);
        }
        if (!_optimisticMintingPaused(vault)) {
            revert LegacyVaultOptimisticMintingNotPaused(vault);
        }
        if (!_coordinatorBound(vault, coordinator, governance)) {
            revert LegacyVaultMigrationCoordinatorInvalid(vault, coordinator);
        }
    }

    /// @notice True only when `vault` matches both the known legacy address and
    ///         its known runtime code hash.
    function _isKnownLegacyVault(
        address vault,
        address knownVault,
        bytes32 knownCodeHash
    ) private view returns (bool) {
        return vault == knownVault && vault.codehash == knownCodeHash;
    }

    /// @notice Fail-closed check that the bound coordinator owns the paused
    ///         legacy vault and is bound to this vault, Bridge, and governance.
    function _coordinatorBound(
        address vault,
        address coordinator,
        address governance
    ) private view returns (bool) {
        (bool okOwner, address vaultOwner) = _staticcallAddress(
            vault,
            ILegacyOwnable.owner.selector
        );
        if (!okOwner || vaultOwner != coordinator) {
            return false;
        }

        (bool okLegacy, address boundLegacy) = _staticcallAddress(
            coordinator,
            ILegacyTBTCVaultMigrationCoordinator.legacyVault.selector
        );
        if (!okLegacy || boundLegacy != vault) {
            return false;
        }

        (bool okBridge, address boundBridge) = _staticcallAddress(
            coordinator,
            ILegacyTBTCVaultMigrationCoordinator.bridge.selector
        );
        if (!okBridge || boundBridge != address(this)) {
            return false;
        }

        (bool okController, address boundController) = _staticcallAddress(
            coordinator,
            ILegacyTBTCVaultMigrationCoordinator.controller.selector
        );
        if (!okController || boundController != governance) {
            return false;
        }

        (bool okLocked, bool locked) = _staticcallBool(
            coordinator,
            ILegacyTBTCVaultMigrationCoordinator.migrationLocked.selector
        );
        return okLocked && locked;
    }

    /// @notice Fail-closed read of the legacy vault's paused flag.
    function _optimisticMintingPaused(address vault)
        private
        view
        returns (bool)
    {
        (bool ok, bool paused) = _staticcallBool(
            vault,
            ILegacyTBTCVault.isOptimisticMintingPaused.selector
        );
        return ok && paused;
    }

    /// @notice Probes the aggregate optimistic-minting-debt selector.
    /// @return ok True when the vault answers with a decodable boolean.
    /// @return hasDebt True when the decodable answer is `true`.
    function _probeOptimisticMintingDebt(address vault)
        private
        view
        returns (bool ok, bool hasDebt)
    {
        return
            _staticcallBool(
                vault,
                ITBTCVaultMigrationDebt
                    .hasOutstandingOptimisticMintingDebt
                    .selector
            );
    }

    /// @notice Queries whether a vault answers every migration debt selector
    ///         consumed by Bridge reveal and vault-management paths.
    function _isMigrationDebtVaultConforming(address vault)
        private
        view
        returns (bool)
    {
        (bool ok, ) = _getOutstandingMigrationDebt(vault);
        if (!ok) {
            return false;
        }

        (ok, ) = _migrationDebtVaultStaticcall(
            vault,
            ITBTCVaultMigrationDebt.isMigrationRevealer.selector,
            address(0),
            36
        );
        if (!ok) {
            return false;
        }

        (ok, ) = _migrationDebtVaultStaticcall(
            vault,
            ITBTCVaultMigrationDebt.canRevealMigration.selector,
            address(0),
            36
        );

        return ok;
    }

    /// @notice Queries whether a vault answers the migration debt interface and
    ///         whether it reports outstanding migration debt.
    function _getOutstandingMigrationDebt(address vault)
        private
        view
        returns (bool ok, bool hasDebt)
    {
        return
            _migrationDebtVaultStaticcall(
                vault,
                ITBTCVaultMigrationDebt.hasOutstandingMigrationDebt.selector,
                address(0),
                4
            );
    }

    /// @notice Fail-open staticcall to a migration-debt selector, preserving
    ///         backwards compatibility with vaults that predate the interface.
    function _hasOutstandingMigrationDebt(address vault)
        private
        view
        returns (bool)
    {
        (, bool hasDebt) = _getOutstandingMigrationDebt(vault);
        return hasDebt;
    }

    /// @notice Low-level staticcall to a selector taking an optional address
    ///         argument and returning a boolean. Used by the migration-debt
    ///         reads (`inputSize` 4 for no-argument selectors, 36 with a
    ///         revealer argument).
    function _migrationDebtVaultStaticcall(
        address vault,
        bytes4 selector,
        address revealer,
        uint256 inputSize
    ) private view returns (bool ok, bool value) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            mstore(add(ptr, 0x04), revealer)

            let success := staticcall(gas(), vault, ptr, inputSize, ptr, 0x20)
            let word := mload(ptr)
            ok := and(
                and(success, gt(returndatasize(), 0x1f)),
                or(iszero(word), eq(word, 1))
            )
            value := and(ok, eq(word, 1))
        }
    }

    /// @notice Fail-closed staticcall to a no-argument selector returning an
    ///         address.
    function _staticcallAddress(address target, bytes4 selector)
        private
        view
        returns (bool ok, address value)
    {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, selector)

            let success := staticcall(gas(), target, ptr, 0x04, ptr, 0x20)
            let word := mload(ptr)
            // Fail-closed: the call must succeed and return EXACTLY one 32-byte
            // word with clean high bits. A malformed oversized return (for
            // example 64 bytes `[address, junk]`) is rejected, not accepted.
            ok := and(
                and(success, eq(returndatasize(), 0x20)),
                iszero(shr(160, word))
            )
            value := mul(ok, word)
        }
    }

    /// @notice Fail-closed staticcall to a no-argument selector returning a
    ///         boolean.
    function _staticcallBool(address target, bytes4 selector)
        private
        view
        returns (bool ok, bool value)
    {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, selector)

            let success := staticcall(gas(), target, ptr, 0x04, ptr, 0x20)
            let word := mload(ptr)
            // Fail-closed: the call must succeed and return EXACTLY one 32-byte
            // word equal to 0 or 1. A malformed oversized return (for example
            // 64 bytes `[bool, junk]`) is rejected, not accepted.
            ok := and(
                and(success, eq(returndatasize(), 0x20)),
                or(iszero(word), eq(word, 1))
            )
            value := and(ok, eq(word, 1))
        }
    }
}
