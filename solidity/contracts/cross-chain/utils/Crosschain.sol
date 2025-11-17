// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity 0.8.17;

/// @title CrosschainUtils
/// @notice Library for LayerZero utilities.
library CrosschainUtils {
    /**
     * @dev Helper function to convert address to Bytes32 for peer setup.
     * @param _address The address needed to be converted.
     * @return The converted address.
     */
    function addressToBytes32(address _address)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(uint256(uint160(_address)));
    }

    /**
     * @dev Helper function to convert Bytes32 to address for peer setup.
     * @param _address The address needed to be converted.
     * @return The converted address.
     */
    // slither-disable-next-line dead-code
    function bytes32ToAddress(bytes32 _address)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(_address)));
    }
}
