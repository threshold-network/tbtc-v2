// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../prototypes/PrototypeCheckBitcoinSchnorrSigs.sol";

/// @dev Test wrapper for direct verification of PrototypeCheckBitcoinSchnorrSigs.
contract TestCheckBitcoinSchnorrSigs {
    function computeChallenge(
        address nonceAddress,
        uint8 pubKeyYParity,
        bytes32 pubKeyX,
        bytes32 message
    ) external pure returns (bytes32) {
        return
            PrototypeCheckBitcoinSchnorrSigs.computeChallenge(
                nonceAddress,
                pubKeyYParity,
                pubKeyX,
                message
            );
    }

    function computeBIP340TaggedChallenge(
        bytes32 nonceX,
        bytes32 pubKeyX,
        bytes32 message
    ) external pure returns (bytes32) {
        return
            PrototypeCheckBitcoinSchnorrSigs.computeBIP340TaggedChallenge(
                nonceX,
                pubKeyX,
                message
            );
    }

    function checkSig(
        bytes32 pubKeyX,
        uint8 pubKeyYParity,
        bytes32 message,
        bytes32 challenge,
        bytes32 signature
    ) external pure returns (bool) {
        return
            PrototypeCheckBitcoinSchnorrSigs.checkSig(
                pubKeyX,
                pubKeyYParity,
                message,
                challenge,
                signature
            );
    }
}
