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

    error PreviousMigrationDebtVaultIsZero();
    error PreviousMigrationDebtVaultMismatch(address expected, address actual);
    error MigrationDebtVaultUnchanged(address vault);
    error MigrationDebtVaultInterfaceMissing(address vault);
    error MigrationDebtVaultUnreachable(address vault);
    error PreviousMigrationDebtVaultHasDebt(address vault);
    error PreviousMigrationDebtVaultHasOptimisticDebt(address vault);
    error VaultIsCanonicalMigrationDebtVault(address vault);
    error VaultHasOutstandingMigrationDebt(address vault);
    error VaultHasOutstandingOptimisticMintingDebt(address vault);
    error VaultNotTrusted(address vault);

    /// @notice Mirrors Bridge.setVaultStatus vault trust management with
    ///         canonical vault protection and migration debt drain guard.
    function setVaultStatus(address vault, bool isTrusted) external {
        if (!isTrusted && self.migrationDebtVault == vault) {
            revert VaultIsCanonicalMigrationDebtVault(vault);
        }

        if (!isTrusted) {
            if (_hasOutstandingMigrationDebt(vault)) {
                revert VaultHasOutstandingMigrationDebt(vault);
            }
            if (_hasOutstandingOptimisticMintingDebt(vault)) {
                revert VaultHasOutstandingOptimisticMintingDebt(vault);
            }
        }

        self.isVaultTrusted[vault] = isTrusted;
        emit VaultStatusUpdated(vault, isTrusted);
    }

    /// @notice Mirrors Bridge.setMigrationDebtVault canonical pointer update,
    ///         including the fail-closed interface probe and the
    ///         outstanding-debt guard for the previous canonical vault.
    function setMigrationDebtVault(address vault) external {
        if (vault != address(0) && !self.isVaultTrusted[vault]) {
            revert VaultNotTrusted(vault);
        }

        if (vault != address(0)) {
            if (!_isMigrationDebtVaultConforming(vault)) {
                revert MigrationDebtVaultInterfaceMissing(vault);
            }
        }

        if (vault != address(0) && self.migrationDebtVault != address(0)) {
            (bool ok, bool hasDebt) = _getOutstandingMigrationDebt(
                self.migrationDebtVault
            );
            if (!ok) {
                revert MigrationDebtVaultUnreachable(self.migrationDebtVault);
            }
            if (hasDebt) {
                revert PreviousMigrationDebtVaultHasDebt(
                    self.migrationDebtVault
                );
            }
        }

        self.migrationDebtVault = vault;
        emit MigrationDebtVaultUpdated(vault);
    }

    /// @notice Mirrors Bridge.rotateMigrationDebtVault atomic rotation with
    ///         migration debt drain guard on the previous vault.
    function rotateMigrationDebtVault(address newVault, address previousVault)
        external
    {
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

        if (_hasOutstandingOptimisticMintingDebt(previousVault)) {
            revert PreviousMigrationDebtVaultHasOptimisticDebt(previousVault);
        }

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

    /// @notice Fail-open staticcall to check whether a vault has outstanding
    ///         migration debt. Returns false when the vault does not implement
    ///         the ITBTCVaultMigrationDebt interface.
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

    function _hasOutstandingMigrationDebt(address vault)
        private
        view
        returns (bool)
    {
        (, bool hasDebt) = _getOutstandingMigrationDebt(vault);
        return hasDebt;
    }

    /// @notice Fail-open staticcall mirroring
    ///         Bridge._hasOutstandingOptimisticMintingDebt.
    function _hasOutstandingOptimisticMintingDebt(address vault)
        private
        view
        returns (bool)
    {
        (, bool hasDebt) = _migrationDebtVaultStaticcall(
            vault,
            ITBTCVaultMigrationDebt
                .hasOutstandingOptimisticMintingDebt
                .selector,
            address(0),
            4
        );
        return hasDebt;
    }
}
