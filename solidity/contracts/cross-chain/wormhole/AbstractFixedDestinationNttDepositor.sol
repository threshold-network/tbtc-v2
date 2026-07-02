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

    function _destinationChainIdValue()
        internal
        view
        virtual
        returns (uint16);

    function _isFixedDestinationDeposit(uint256 depositKey)
        internal
        view
        virtual
        returns (bool);
}
