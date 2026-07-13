// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./ILegacyTBTCVaultMigrationCoordinator.sol";

/// @title Legacy TBTCVault migration coordinator
/// @notice Dedicated, non-upgradeable, single-purpose owner of the immutable
///         mainnet legacy `TBTCVault`. Once the legacy vault's ownership is
///         transferred to an instance of this contract, optimistic minting can
///         never be resumed and the legacy `finalizeUpgrade` can never be called
///         directly by the Council Safe: the only path to retire the legacy
///         vault runs through this coordinator, and only its `controller` (the
///         `BridgeGovernance` that owns the Bridge) may drive it.
/// @dev The coordinator exposes no `unpauseOptimisticMinting`, generic
///      `execute`/`delegatecall`, controller-transfer, or legacy-owner-return
///      function. Its only mutating entry points are `initiateUpgrade` and
///      `finalizeUpgrade`, both `onlyController`. This is the enforceable
///      equivalent, for the immutable legacy deployment, of the
///      `TBTCVault.finalizeUpgrade` optimistic-minting-debt guard that only runs
///      in the new vault bytecode.
///
///      Every external read that decides whether the migration is safe to
///      advance is fail-closed: `migrationLocked` validates the exact ABI
///      return sizes/values of the legacy `owner()` and `isOptimisticMintingPaused()`
///      reads and returns false on any malformed or reverting response. The
///      mutating functions read through typed calls whose reverts abort the
///      whole transaction, so a malformed response can never advance the
///      migration.
contract LegacyTBTCVaultMigrationCoordinator is
    ILegacyTBTCVaultMigrationCoordinator
{
    /// @notice The only address allowed to drive the migration: the newly
    ///         deployed `BridgeGovernance` that owns the Bridge.
    address public immutable override controller;
    /// @notice The immutable legacy `TBTCVault` frozen and retired here.
    address public immutable override legacyVault;
    /// @notice The Bridge whose retirement attestation and trust flag gate
    ///         finalization.
    address public immutable override bridge;

    /// @notice The successor vault proposed for the legacy upgrade. Zero before
    ///         the first initiation; may be re-pointed to another
    ///         governance-owned successor before finalization.
    address public override successorVault;
    /// @notice True once the legacy upgrade has been finalized through this
    ///         coordinator. Latches the coordinator permanently.
    bool public finalized;

    event LegacyVaultUpgradeInitiated(
        address indexed legacyVault,
        address indexed successorVault
    );
    event LegacyVaultUpgradeFinalized(
        address indexed legacyVault,
        address indexed successorVault
    );

    modifier onlyController() {
        require(msg.sender == controller, "Caller is not the controller");
        _;
    }

    /// @param _controller The `BridgeGovernance` that owns the Bridge. It, and
    ///        only it, may call `initiateUpgrade` and `finalizeUpgrade`.
    /// @param _legacyVault The immutable legacy `TBTCVault` to retire.
    /// @param _bridge The Bridge proxy whose attestation binds this coordinator.
    /// @dev All three arguments must be nonzero contracts. None is inferred from
    ///      `msg.sender`, so the deployer is never implicitly trusted.
    constructor(
        address _controller,
        address _legacyVault,
        address _bridge
    ) {
        require(
            _controller != address(0) && _controller.code.length > 0,
            "Controller must be a contract"
        );
        require(
            _legacyVault != address(0) && _legacyVault.code.length > 0,
            "Legacy vault must be a contract"
        );
        require(
            _bridge != address(0) && _bridge.code.length > 0,
            "Bridge must be a contract"
        );

        controller = _controller;
        legacyVault = _legacyVault;
        bridge = _bridge;
    }

    /// @notice Initiates the legacy vault upgrade towards `successor`, resetting
    ///         the legacy 24-hour delay.
    /// @param successor The successor vault. Must be a contract, distinct from
    ///        the legacy vault, and owned by the controller's owner (the Council
    ///        Safe), preserving the governance-owned canonical successor
    ///        invariant.
    /// @dev May be called again before finalization with a different
    ///      governance-owned successor. This is the rollback path if a proposed
    ///      new vault fails review; it resets the legacy delay without ever
    ///      restoring unpause authority.
    function initiateUpgrade(address successor)
        external
        override
        onlyController
    {
        require(!finalized, "Migration already finalized");
        require(migrationLocked(), "Legacy vault not locked to coordinator");
        require(successor != address(0), "Successor vault cannot be zero");
        require(
            successor != legacyVault,
            "Successor must differ from the legacy vault"
        );
        require(successor.code.length > 0, "Successor must be a contract");
        require(
            ILegacyOwnable(successor).owner() ==
                ILegacyOwnable(controller).owner(),
            "Successor must be owned by the controller owner"
        );

        successorVault = successor;

        ILegacyTBTCVault(legacyVault).initiateUpgrade(successor);
        require(
            ILegacyTBTCVault(legacyVault).newVault() == successor,
            "Legacy upgrade initiation failed"
        );

        emit LegacyVaultUpgradeInitiated(legacyVault, successor);
    }

    /// @notice Finalizes the legacy vault upgrade, moving TBTC ownership and the
    ///         legacy Bank balance to the successor.
    /// @dev Requires the successor to already be recorded on the legacy vault,
    ///      the legacy vault to already be untrusted by the Bridge, and the
    ///      Bridge attestation to bind this coordinator. The legacy
    ///      `finalizeUpgrade` retains its own 24-hour delay check. This function
    ///      does not catch any revert; any failed sub-step aborts the whole
    ///      cutover.
    function finalizeUpgrade() external override onlyController {
        require(!finalized, "Migration already finalized");
        require(migrationLocked(), "Legacy vault not locked to coordinator");

        address successor = successorVault;
        require(successor != address(0), "Successor vault not set");
        require(
            ILegacyTBTCVault(legacyVault).newVault() == successor,
            "Legacy successor mismatch"
        );
        require(
            ILegacyOwnable(successor).owner() ==
                ILegacyOwnable(controller).owner(),
            "Successor must be owned by the controller owner"
        );
        require(
            !ILegacyRetirementBridge(bridge).isVaultTrusted(legacyVault),
            "Legacy vault must be untrusted before finalization"
        );
        require(
            ILegacyRetirementBridge(bridge)
                .legacyVaultOptimisticMintingDebtCoordinator(legacyVault) ==
                address(this),
            "Bridge attestation must bind this coordinator"
        );

        // Capture the TBTC token before the cutover so its post-finalization
        // owner can be asserted. The legacy vault is TBTC owner until the call.
        address tbtcToken = ILegacyTBTCVault(legacyVault).tbtcToken();

        ILegacyTBTCVault(legacyVault).finalizeUpgrade();

        require(
            ILegacyTBTCVault(legacyVault).newVault() == address(0),
            "Legacy upgrade finalization failed"
        );
        require(
            ILegacyOwnable(tbtcToken).owner() == successor,
            "TBTC ownership did not move to the successor"
        );

        finalized = true;

        emit LegacyVaultUpgradeFinalized(legacyVault, successor);
    }

    /// @notice Returns true only when this coordinator owns the legacy vault and
    ///         its optimistic minting is paused.
    /// @dev Both reads are fail-closed: a malformed or reverting response
    ///      produces false, never a permissive pass. This latches the "no new
    ///      finalized optimistic debt can be created" property that the Bridge
    ///      attestation and the deployment scan rely on.
    function migrationLocked() public view override returns (bool) {
        (bool okOwner, address currentOwner) = _staticcallAddress(
            legacyVault,
            ILegacyOwnable.owner.selector
        );
        if (!okOwner || currentOwner != address(this)) {
            return false;
        }

        (bool okPaused, bool paused) = _staticcallBool(
            legacyVault,
            ILegacyTBTCVault.isOptimisticMintingPaused.selector
        );

        return okPaused && paused;
    }

    /// @notice Fail-closed staticcall to a no-argument selector returning an
    ///         address.
    /// @return ok True only when the call succeeds, returns EXACTLY 32 bytes,
    ///         and the high 96 bits are zero (a clean 20-byte address). An
    ///         oversized return (for example 64 bytes `[address, junk]`) is
    ///         rejected, not accepted.
    /// @return value The decoded address (zero when `ok` is false).
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
            ok := and(
                and(success, eq(returndatasize(), 0x20)),
                iszero(shr(160, word))
            )
            value := mul(ok, word)
        }
    }

    /// @notice Fail-closed staticcall to a no-argument selector returning a
    ///         boolean.
    /// @return ok True only when the call succeeds, returns EXACTLY 32 bytes,
    ///         and the word is exactly 0 or 1. An oversized return (for example
    ///         64 bytes `[bool, junk]`) is rejected, not accepted.
    /// @return value The decoded boolean (false when `ok` is false).
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
            ok := and(
                and(success, eq(returndatasize(), 0x20)),
                or(iszero(word), eq(word, 1))
            )
            value := and(ok, eq(word, 1))
        }
    }
}
