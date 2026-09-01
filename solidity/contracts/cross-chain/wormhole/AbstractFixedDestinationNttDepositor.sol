// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../AbstractL1BTCDepositor.sol";

/// @notice Shared fixed-destination logic for Wormhole NTT depositors.
/// @dev This base intentionally has no storage. Child contracts keep their
///      storage fields in place to preserve upgradeable proxy layouts.
abstract contract AbstractFixedDestinationNttDepositor is
    AbstractL1BTCDepositor
{
    uint256 private constant LEGACY_DESTINATION_RECEIVER_MASK =
        type(uint240).max;

    /// @notice Emitted when the fixed NTT destination chain is migrated.
    event DestinationChainUpdated(
        uint16 indexed oldDestinationChain,
        uint16 indexed newDestinationChain
    );

    /// @notice Migrates the fixed destination chain during a proxy upgrade.
    /// @param _destinationChainId Wormhole chain ID of the destination chain
    /// @dev Intended as a one-time backfill hook for proxies that were
    ///      initialized before the fixed-destination slot existed and had no
    ///      default destination set. Fresh deployments configure the
    ///      destination during `initialize` and cannot use this hook to
    ///      retarget in-flight deposits. Shared by both children so the two
    ///      copies cannot silently diverge (e.g. a guard tightened in one
    ///      but not the other).
    function initializeV2DestinationChain(uint16 _destinationChainId)
        external
        onlyOwner
        reinitializer(2)
    {
        require(
            _destinationChainIdValue() == 0,
            "Destination chain already configured"
        );
        _updateDestinationChain(_destinationChainId);
    }

    /// @notice Owner-only corrective setter for the fixed destination chain.
    /// @param _destinationChainId Wormhole chain ID of the destination chain
    /// @dev Unlike `initializeV2DestinationChain`, this is not gated on the
    ///      slot being unset and is not a one-time reinitializer step. It
    ///      exists to repair a mis-migrated `destinationChainId` -- e.g. an
    ///      inherited non-zero value left over in the storage slot this
    ///      field reuses from the pre-upgrade proxy -- without requiring a
    ///      second implementation upgrade to unblock
    ///      `initializeV2DestinationChain`.
    function setDestinationChainId(uint16 _destinationChainId)
        external
        onlyOwner
    {
        _updateDestinationChain(_destinationChainId);
    }

    /// @notice Updates the fixed destination chain.
    function _updateDestinationChain(uint16 _destinationChainId) internal {
        require(_destinationChainId != 0, "Chain ID cannot be zero");

        uint16 oldDestinationChainId = _destinationChainIdValue();
        _setDestinationChainId(_destinationChainId);

        emit DestinationChainUpdated(
            oldDestinationChainId,
            _destinationChainId
        );
    }

    /// @notice Marks deposits initialized under the fixed-destination format.
    function _afterDepositInitialized(
        uint256 depositKey,
        bytes32 // destinationChainDepositOwner
    ) internal override {
        _markFixedDestinationDeposit(depositKey);
    }

    function _setDestinationChainId(uint16 _destinationChainId)
        internal
        virtual;

    function _markFixedDestinationDeposit(uint256 depositKey) internal virtual;

    /// @notice Requires destination configuration before deposit initialization.
    function _beforeDepositInitialized(
        bytes32 // destinationChainDepositOwner
    ) internal view override {
        _destinationChain();
    }

    /// @notice Decodes legacy packed recipients for in-flight upgraded deposits.
    function _destinationChainDepositOwnerForTransfer(
        uint256 depositKey,
        bytes32 destinationChainDepositOwner
    ) internal view override returns (bytes32) {
        if (_isFixedDestinationDeposit(depositKey)) {
            return destinationChainDepositOwner;
        }

        uint16 legacyDestinationChain = uint16(
            uint256(destinationChainDepositOwner) >> 240
        );
        require(
            legacyDestinationChain == _destinationChain(),
            "Legacy destination chain mismatch"
        );

        return
            bytes32(
                uint256(destinationChainDepositOwner) &
                    LEGACY_DESTINATION_RECEIVER_MASK
            );
    }

    /// @notice Returns the configured destination chain and reverts if unset.
    function _destinationChain() internal view returns (uint16 chainId) {
        chainId = _destinationChainIdValue();
        require(chainId != 0, "Destination chain not configured");
    }

    function _destinationChainIdValue() internal view virtual returns (uint16);

    function _isFixedDestinationDeposit(uint256 depositKey)
        internal
        view
        virtual
        returns (bool);
}
