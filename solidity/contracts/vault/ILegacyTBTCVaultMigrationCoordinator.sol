// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal `Ownable` view used to read the current owner of an external
///         contract (the legacy vault, a successor vault, the TBTC token, or the
///         controlling `BridgeGovernance`) without importing its full
///         implementation. Only the `owner()` selector is declared.
interface ILegacyOwnable {
    function owner() external view returns (address);
}

/// @notice Minimal view of the immutable legacy `TBTCVault` consumed by the
///         migration coordinator. Only the selectors required to observe and
///         retire the legacy vault are declared, so the coordinator does not
///         depend on the concrete, and already deployed, legacy implementation.
interface ILegacyTBTCVault {
    function owner() external view returns (address);

    function isOptimisticMintingPaused() external view returns (bool);

    function newVault() external view returns (address);

    function tbtcToken() external view returns (address);

    function initiateUpgrade(address newVault) external;

    function finalizeUpgrade() external;
}

/// @notice Minimal view of the Bridge consumed by the migration coordinator,
///         avoiding a dependency on the concrete `Bridge` contract. It exposes
///         only the trust flag and the legacy-retirement attestation getter the
///         coordinator reads before finalizing the immutable legacy upgrade.
interface ILegacyRetirementBridge {
    function isVaultTrusted(address vault) external view returns (bool);

    function legacyVaultOptimisticMintingDebtCoordinator(address vault)
        external
        view
        returns (address);
}

/// @notice Interface of the dedicated legacy-vault migration coordinator
///         consumed by Bridge and BridgeGovernance. The coordinator owns the
///         immutable legacy `TBTCVault`, permanently keeps its optimistic
///         minting paused, and is the only address able to drive the legacy
///         `initiateUpgrade`/`finalizeUpgrade` flow.
/// @dev The selectors and their behavior are normative. The coordinator exposes
///      no generic call, delegatecall, unpause, controller-transfer, or
///      legacy-owner-return escape hatch.
interface ILegacyTBTCVaultMigrationCoordinator {
    /// @notice The only address allowed to drive the migration. It is the
    ///         `BridgeGovernance` that owns the Bridge, not the deployer nor the
    ///         Council Safe directly.
    function controller() external view returns (address);

    /// @notice The immutable legacy `TBTCVault` frozen and retired by this
    ///         coordinator.
    function legacyVault() external view returns (address);

    /// @notice The Bridge whose attestation and trust flag gate finalization.
    function bridge() external view returns (address);

    /// @notice The successor vault proposed for the legacy upgrade, or zero
    ///         before an initiation.
    function successorVault() external view returns (address);

    /// @notice True only when the coordinator owns the legacy vault and its
    ///         optimistic minting is paused, both read fail-closed.
    function migrationLocked() external view returns (bool);

    /// @notice Initiates the legacy vault upgrade towards `successorVault`.
    function initiateUpgrade(address successorVault) external;

    /// @notice Finalizes the legacy vault upgrade after the Bridge has recorded
    ///         the retirement attestation and untrusted the legacy vault.
    function finalizeUpgrade() external;
}
