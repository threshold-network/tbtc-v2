// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/VaultManagement.sol";

/// @notice Test harness that exercises the Bridge vault-management logic in
///         isolation, without deploying the full Bridge contract and its
///         dependencies. It links and delegates to the same `VaultManagement`
///         library the production Bridge uses, so the guard truth table
///         (including the known-legacy classification, retirement attestation,
///         and coordinator validation) can never diverge from production.
/// @dev The production Bridge hard-codes the exact mainnet legacy address and
///      code hash as immutable constants. Because a headless test cannot install
///      that exact runtime at that exact address, this harness makes the
///      known-legacy identity and the "governance" address configurable and
///      passes them into the library, matching the production wiring while
///      pointing the override at a mock legacy vault.
contract BridgeVaultStatusHarness {
    using VaultManagement for BridgeState.Storage;

    BridgeState.Storage internal self;

    /// @notice Configurable stand-in for the Bridge's immutable
    ///         `LEGACY_MAINNET_TBTC_VAULT` constant.
    address public knownLegacyVault;
    /// @notice Configurable stand-in for the Bridge's immutable
    ///         `LEGACY_MAINNET_TBTC_VAULT_CODE_HASH` constant.
    bytes32 public knownLegacyCodeHash;
    /// @notice Configurable stand-in for the Bridge's `governance` address, used
    ///         by the coordinator-binding validation.
    address public harnessGovernance;

    // Re-declared so `.to.emit(harness, ...)` resolves against the harness ABI;
    // the library emits them under delegatecall, attributing the log here.
    event VaultStatusUpdated(address indexed vault, bool isTrusted);
    event MigrationDebtVaultUpdated(address indexed migrationDebtVault);
    event LegacyVaultOptimisticMintingDebtAttestationUpdated(
        address indexed vault,
        address indexed coordinator,
        uint256 snapshotBlockNumber,
        bytes32 snapshotBlockHash,
        bytes32 evidenceHash
    );

    /// @notice Configures the known-legacy identity the guard is fail-closed for.
    function setKnownLegacyVault(address vault, bytes32 codeHash) external {
        knownLegacyVault = vault;
        knownLegacyCodeHash = codeHash;
    }

    /// @notice Configures the "governance" address passed to the coordinator
    ///         binding validation.
    function setHarnessGovernance(address governance) external {
        harnessGovernance = governance;
    }

    /// @notice Test-only: sets the canonical migration-debt vault pointer
    ///         directly, bypassing the conformance guard. Used to stage the
    ///         rotation path against a non-conforming known-legacy vault; the
    ///         rotation guard logic itself still runs through `VaultManagement`.
    function forceSetMigrationDebtVault(address vault) external {
        self.migrationDebtVault = vault;
    }

    /// @notice Mirrors `Bridge.setVaultStatus` by delegating to the shared
    ///         `VaultManagement` library.
    function setVaultStatus(address vault, bool isTrusted) external {
        self.setVaultStatus(
            vault,
            isTrusted,
            harnessGovernance,
            knownLegacyVault,
            knownLegacyCodeHash
        );
    }

    /// @notice Mirrors `Bridge.setMigrationDebtVault`.
    function setMigrationDebtVault(address vault) external {
        self.setMigrationDebtVault(vault);
    }

    /// @notice Mirrors `Bridge.rotateMigrationDebtVault`.
    function rotateMigrationDebtVault(address newVault, address previousVault)
        external
    {
        self.rotateMigrationDebtVault(
            newVault,
            previousVault,
            harnessGovernance,
            knownLegacyVault,
            knownLegacyCodeHash
        );
    }

    /// @notice Mirrors `Bridge.setLegacyVaultOptimisticMintingDebtAttestation`.
    function setLegacyVaultOptimisticMintingDebtAttestation(
        address vault,
        address coordinator,
        uint256 snapshotBlockNumber,
        bytes32 snapshotBlockHash,
        bytes32 evidenceHash
    ) external {
        self.setAttestation(
            harnessGovernance,
            vault,
            coordinator,
            snapshotBlockNumber,
            snapshotBlockHash,
            evidenceHash,
            knownLegacyVault,
            knownLegacyCodeHash
        );
    }

    function isVaultTrusted(address vault) external view returns (bool) {
        return self.isVaultTrusted[vault];
    }

    function migrationDebtVault() external view returns (address) {
        return self.migrationDebtVault;
    }

    function legacyVaultOptimisticMintingDebtCoordinator(address vault)
        external
        view
        returns (address)
    {
        return self.legacyVaultOptimisticMintingDebtCoordinator[vault];
    }
}
