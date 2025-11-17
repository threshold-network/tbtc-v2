// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/EcdsaLib.sol";

// TODO: Rename to EcdsLibStub
/// @dev This is a contract implemented to test EcdsaLib library directly.
contract TestEcdsaLib {
    function compressPublicKey(bytes32 x, bytes32 y)
        public
        pure
        returns (bytes memory)
    {
        return EcdsaLib.compressPublicKey(x, y);
    }
}
