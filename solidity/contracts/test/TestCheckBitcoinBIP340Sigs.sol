// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/CheckBitcoinBIP340Sigs.sol";

contract TestCheckBitcoinBIP340Sigs {
    function checkSig(
        bytes32 pubKeyX,
        bytes32 message,
        bytes calldata signature
    ) external view returns (bool) {
        return CheckBitcoinBIP340Sigs.checkSig(pubKeyX, message, signature);
    }

    function checkSig(
        bytes32 pubKeyX,
        bytes32 message,
        bytes32 nonceX,
        bytes32 signatureScalar
    ) external view returns (bool) {
        return
            CheckBitcoinBIP340Sigs.checkSig(
                pubKeyX,
                message,
                nonceX,
                signatureScalar
            );
    }

    function computeBIP340TaggedChallenge(
        bytes32 nonceX,
        bytes32 pubKeyX,
        bytes32 message
    ) external pure returns (bytes32) {
        return
            CheckBitcoinBIP340Sigs.computeBIP340TaggedChallenge(
                nonceX,
                pubKeyX,
                message
            );
    }

    function scalarMulGenerator(uint256 scalar)
        external
        view
        returns (
            bool,
            uint256,
            uint256,
            bool
        )
    {
        CheckBitcoinBIP340Sigs.Point memory generator = CheckBitcoinBIP340Sigs
            .generator();
        (
            bool computed,
            CheckBitcoinBIP340Sigs.Point memory point
        ) = CheckBitcoinBIP340Sigs.scalarMul(scalar, generator);

        return (computed, point.x, point.y, point.infinity);
    }

    function affineScalarMulGenerator(uint256 scalar)
        external
        view
        returns (
            bool,
            uint256,
            uint256,
            bool
        )
    {
        CheckBitcoinBIP340Sigs.Point memory generator = CheckBitcoinBIP340Sigs
            .generator();
        (
            bool computed,
            CheckBitcoinBIP340Sigs.Point memory point
        ) = CheckBitcoinBIP340Sigs.affineScalarMul(scalar, generator);

        return (computed, point.x, point.y, point.infinity);
    }
}
