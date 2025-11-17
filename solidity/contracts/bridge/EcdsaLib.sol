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

import "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

library EcdsaLib {
    using BytesLib for bytes;

    /// @notice Converts public key X and Y coordinates (32-byte each) to a
    ///         compressed public key (33-byte). Compressed public key is X
    ///         coordinate prefixed with `02` or `03` based on the Y coordinate parity.
    ///         It is expected that the uncompressed public key is stripped
    ///         (i.e. it is not prefixed with `04`).
    /// @param x Wallet's public key's X coordinate.
    /// @param y Wallet's public key's Y coordinate.
    /// @return Compressed public key (33-byte), prefixed with `02` or `03`.
    function compressPublicKey(bytes32 x, bytes32 y)
        internal
        pure
        returns (bytes memory)
    {
        bytes1 prefix;
        if (uint256(y) % 2 == 0) {
            prefix = hex"02";
        } else {
            prefix = hex"03";
        }

        return bytes.concat(prefix, x);
    }
}
