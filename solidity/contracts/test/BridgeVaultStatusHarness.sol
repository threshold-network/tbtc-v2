// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../vault/ITBTCVaultMigrationDebt.sol";

/// @notice Test harness that mirrors the vault management logic of Bridge.sol
///         in isolation, without deploying the full Bridge contract and its
///         dependencies. Guard logic in this harness must stay in sync with
///         Bridge.setVaultStatus, Bridge.setMigrationDebtVault, and
///         Bridge.rotateMigrationDebtVault.
contract BridgeVaultStatusHarness {
    BridgeState.Storage internal self;

    event VaultStatusUpdated(address indexed vault, bool isTrusted);
    event MigrationDebtVaultUpdated(address indexed migrationDebtVault);

    /// @notice Mirrors Bridge.setVaultStatus vault trust management with
    ///         canonical vault protection and migration debt drain guard.
    function setVaultStatus(address vault, bool isTrusted) external {
        require(
            isTrusted || self.migrationDebtVault != vault,
            "Vault is canonical migration debt vault"
        );

        if (!isTrusted) {
            require(
                !_hasOutstandingMigrationDebt(vault),
                "Vault has outstanding migration debt"
            );
        }

        self.isVaultTrusted[vault] = isTrusted;
        emit VaultStatusUpdated(vault, isTrusted);
    }

    /// @notice Mirrors Bridge.setMigrationDebtVault canonical pointer update.
    function setMigrationDebtVault(address vault) external {
        require(
            vault == address(0) || self.isVaultTrusted[vault],
            "Vault is not trusted"
        );

        self.migrationDebtVault = vault;
        emit MigrationDebtVaultUpdated(vault);
    }

    /// @notice Mirrors Bridge.rotateMigrationDebtVault atomic rotation with
    ///         migration debt drain guard on the previous vault.
    function rotateMigrationDebtVault(address newVault, address previousVault)
        external
    {
        require(previousVault != address(0), "Previous vault is zero");
        require(
            previousVault == self.migrationDebtVault,
            "Previous vault is not canonical"
        );
        require(newVault != previousVault, "Vault unchanged");
        require(
            newVault == address(0) || self.isVaultTrusted[newVault],
            "Vault is not trusted"
        );

        require(
            !_hasOutstandingMigrationDebt(previousVault),
            "Previous vault has outstanding migration debt"
        );

        self.migrationDebtVault = newVault;
        emit MigrationDebtVaultUpdated(newVault);

        self.isVaultTrusted[previousVault] = false;
        emit VaultStatusUpdated(previousVault, false);
    }

    function isVaultTrusted(address vault) external view returns (bool) {
        return self.isVaultTrusted[vault];
    }

    function migrationDebtVault() external view returns (address) {
        return self.migrationDebtVault;
    }

    /// @notice Fail-open staticcall to check whether a vault has outstanding
    ///         migration debt. Returns false when the vault does not implement
    ///         the ITBTCVaultMigrationDebt interface.
    function _hasOutstandingMigrationDebt(address vault)
        private
        view
        returns (bool)
    {
        (bool success, bytes memory data) = vault.staticcall(
            abi.encodeWithSelector(
                ITBTCVaultMigrationDebt.hasOutstandingMigrationDebt.selector
            )
        );
        if (success && data.length >= 32) {
            return abi.decode(data, (bool));
        }
        return false;
    }
}
