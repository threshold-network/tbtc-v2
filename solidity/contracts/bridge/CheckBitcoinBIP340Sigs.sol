// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @title Check Bitcoin BIP-340 Signatures
/// @notice Verifies Bitcoin Schnorr signatures according to BIP-340.
/// @dev This verifier is intentionally not wired into Bridge fraud entrypoints
///      yet. It exists as a correctness and gas-measurement seed for the P2TR
///      signature-fraud production path.
library CheckBitcoinBIP340Sigs {
    struct Point {
        uint256 x;
        uint256 y;
        bool infinity;
    }

    struct JacobianPoint {
        uint256 x;
        uint256 y;
        uint256 z;
        bool infinity;
    }

    // Scratch space keeps the Jacobian addition formula under Solidity's stack
    // limit without splitting the arithmetic across less-auditable helpers.
    struct JacobianAddState {
        uint256 z1Squared;
        uint256 z2Squared;
        uint256 leftX;
        uint256 rightX;
        uint256 leftY;
        uint256 rightY;
        uint256 xDelta;
        uint256 xDeltaTwiceSquared;
        uint256 xDeltaCubed;
        uint256 yDeltaTwice;
        uint256 leftXTimesDeltaSquared;
        uint256 resultX;
    }

    uint256 internal constant Secp256k1P =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant Secp256k1N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant Secp256k1Gx =
        0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 internal constant Secp256k1Gy =
        0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;
    uint256 internal constant FieldSqrtExponent = (Secp256k1P + 1) / 4;
    uint256 internal constant FieldInverseExponent = Secp256k1P - 2;
    uint16 internal constant MaxScalarMulBits = 256;

    /// @notice SHA-256("BIP0340/challenge").
    bytes32 internal constant BIP340ChallengeTagHash =
        0x7bb52d7a9fef58323eb1bf7a407db382d2f3f2d81bb1224f49fe518f6d48d37c;

    /// @notice Verifies a 64-byte BIP-340 signature.
    /// @param pubKeyX X-only public key committing to an even-y secp256k1 key.
    /// @param message 32-byte message being signed.
    /// @param signature 64-byte BIP-340 signature: R.x || s.
    function checkSig(
        bytes32 pubKeyX,
        bytes32 message,
        bytes calldata signature
    ) internal view returns (bool) {
        if (signature.length != 64) {
            return false;
        }

        bytes32 nonceX;
        bytes32 signatureScalar;

        // solhint-disable-next-line no-inline-assembly
        assembly {
            nonceX := calldataload(signature.offset)
            signatureScalar := calldataload(add(signature.offset, 32))
        }

        return checkSig(pubKeyX, message, nonceX, signatureScalar);
    }

    /// @notice Verifies a BIP-340 signature split into R.x and s fields.
    /// @param pubKeyX X-only public key committing to an even-y secp256k1 key.
    /// @param message 32-byte message being signed.
    /// @param nonceX X-coordinate of the signature nonce point R.
    /// @param signatureScalar Signature scalar s.
    function checkSig(
        bytes32 pubKeyX,
        bytes32 message,
        bytes32 nonceX,
        bytes32 signatureScalar
    ) internal view returns (bool) {
        uint256 nonceXUint = uint256(nonceX);
        uint256 signatureScalarUint = uint256(signatureScalar);

        if (nonceXUint >= Secp256k1P || signatureScalarUint >= Secp256k1N) {
            return false;
        }

        (bool lifted, Point memory publicKey) = liftX(uint256(pubKeyX));
        if (!lifted) {
            return false;
        }

        uint256 challenge = uint256(
            computeBIP340TaggedChallenge(nonceX, pubKeyX, message)
        ) % Secp256k1N;

        (bool signaturePointComputed, Point memory signaturePoint) = scalarMul(
            signatureScalarUint,
            generator()
        );
        if (!signaturePointComputed) {
            return false;
        }

        uint256 negatedChallenge = challenge == 0 ? 0 : Secp256k1N - challenge;
        (bool challengePointComputed, Point memory challengePoint) = scalarMul(
            negatedChallenge,
            publicKey
        );
        if (!challengePointComputed) {
            return false;
        }

        // Both addends are already affine from scalarMul, and we only need
        // R.x to compare against nonceXUint, so the final reconstruction stays
        // on the affine pointAdd to avoid an extra Jacobian round-trip and to
        // keep the parity comparison on the canonical affine y coordinate.
        (bool noncePointComputed, Point memory noncePoint) = pointAdd(
            signaturePoint,
            challengePoint
        );
        if (!noncePointComputed || noncePoint.infinity) {
            return false;
        }

        return noncePoint.x == nonceXUint && noncePoint.y % 2 == 0;
    }

    function scalarMul(uint256 scalar, Point memory point)
        internal
        view
        returns (bool, Point memory)
    {
        JacobianPoint memory result = JacobianPoint(0, 0, 0, true);
        JacobianPoint memory addend = toJacobian(point);

        for (uint16 bit = 0; bit < MaxScalarMulBits && scalar != 0; bit++) {
            if (scalar & 1 == 1) {
                result = jacobianAdd(result, addend);
            }

            scalar >>= 1;

            if (scalar != 0) {
                addend = jacobianDouble(addend);
            }
        }

        return jacobianToAffine(result);
    }

    function toJacobian(Point memory point)
        internal
        pure
        returns (JacobianPoint memory)
    {
        if (point.infinity) {
            return JacobianPoint(0, 0, 0, true);
        }

        return JacobianPoint(point.x, point.y, 1, false);
    }

    function jacobianAdd(JacobianPoint memory left, JacobianPoint memory right)
        internal
        pure
        returns (JacobianPoint memory)
    {
        if (left.infinity) {
            return right;
        }

        if (right.infinity) {
            return left;
        }

        JacobianAddState memory state;
        state.z1Squared = mulmod(left.z, left.z, Secp256k1P);
        state.z2Squared = mulmod(right.z, right.z, Secp256k1P);
        state.leftX = mulmod(left.x, state.z2Squared, Secp256k1P);
        state.rightX = mulmod(right.x, state.z1Squared, Secp256k1P);
        state.leftY = mulmod(
            left.y,
            mulmod(right.z, state.z2Squared, Secp256k1P),
            Secp256k1P
        );
        state.rightY = mulmod(
            right.y,
            mulmod(left.z, state.z1Squared, Secp256k1P),
            Secp256k1P
        );

        if (state.leftX == state.rightX) {
            if (state.leftY == state.rightY) {
                return jacobianDouble(left);
            }

            return JacobianPoint(0, 0, 0, true);
        }

        state.xDelta = submod(state.rightX, state.leftX);
        state.xDeltaTwiceSquared = mulmod(
            addmod(state.xDelta, state.xDelta, Secp256k1P),
            addmod(state.xDelta, state.xDelta, Secp256k1P),
            Secp256k1P
        );
        state.xDeltaCubed = mulmod(
            state.xDelta,
            state.xDeltaTwiceSquared,
            Secp256k1P
        );
        state.yDeltaTwice = addmod(
            submod(state.rightY, state.leftY),
            submod(state.rightY, state.leftY),
            Secp256k1P
        );
        state.leftXTimesDeltaSquared = mulmod(
            state.leftX,
            state.xDeltaTwiceSquared,
            Secp256k1P
        );
        state.resultX = submod(
            submod(
                mulmod(state.yDeltaTwice, state.yDeltaTwice, Secp256k1P),
                state.xDeltaCubed
            ),
            addmod(
                state.leftXTimesDeltaSquared,
                state.leftXTimesDeltaSquared,
                Secp256k1P
            )
        );

        return
            JacobianPoint(
                state.resultX,
                submod(
                    mulmod(
                        state.yDeltaTwice,
                        submod(state.leftXTimesDeltaSquared, state.resultX),
                        Secp256k1P
                    ),
                    mulmod(
                        addmod(state.leftY, state.leftY, Secp256k1P),
                        state.xDeltaCubed,
                        Secp256k1P
                    )
                ),
                mulmod(
                    submod(
                        submod(
                            mulmod(
                                addmod(left.z, right.z, Secp256k1P),
                                addmod(left.z, right.z, Secp256k1P),
                                Secp256k1P
                            ),
                            state.z1Squared
                        ),
                        state.z2Squared
                    ),
                    state.xDelta,
                    Secp256k1P
                ),
                false
            );
    }

    function jacobianDouble(JacobianPoint memory point)
        internal
        pure
        returns (JacobianPoint memory)
    {
        if (point.infinity) {
            return point;
        }

        if (point.y == 0) {
            return JacobianPoint(0, 0, 0, true);
        }

        uint256 xSquared = mulmod(point.x, point.x, Secp256k1P);
        uint256 ySquared = mulmod(point.y, point.y, Secp256k1P);
        uint256 yFourth = mulmod(ySquared, ySquared, Secp256k1P);
        uint256 xPlusYSquared = addmod(point.x, ySquared, Secp256k1P);
        uint256 dSource = submod(
            submod(mulmod(xPlusYSquared, xPlusYSquared, Secp256k1P), xSquared),
            yFourth
        );
        uint256 d = addmod(dSource, dSource, Secp256k1P);
        uint256 e = mulmod(3, xSquared, Secp256k1P);
        uint256 resultX = submod(
            mulmod(e, e, Secp256k1P),
            addmod(d, d, Secp256k1P)
        );

        return
            JacobianPoint(
                resultX,
                submod(
                    mulmod(e, submod(d, resultX), Secp256k1P),
                    mulmod(8, yFourth, Secp256k1P)
                ),
                mulmod(
                    addmod(point.y, point.y, Secp256k1P),
                    point.z,
                    Secp256k1P
                ),
                false
            );
    }

    function jacobianToAffine(JacobianPoint memory point)
        internal
        view
        returns (bool, Point memory)
    {
        if (point.infinity) {
            return (true, Point(0, 0, true));
        }

        (bool inverted, uint256 zInverse) = modInverse(point.z);
        if (!inverted) {
            return (false, Point(0, 0, true));
        }

        uint256 zInverseSquared = mulmod(zInverse, zInverse, Secp256k1P);
        uint256 zInverseCubed = mulmod(zInverseSquared, zInverse, Secp256k1P);

        return (
            true,
            Point(
                mulmod(point.x, zInverseSquared, Secp256k1P),
                mulmod(point.y, zInverseCubed, Secp256k1P),
                false
            )
        );
    }

    /// @notice Affine reference scalar multiplication kept only as a
    ///         differential-testing oracle for the Jacobian production path.
    /// @dev    Pays one field inversion per loop iteration via `pointAdd` /
    ///         `pointDouble`, which is why production callers must use
    ///         `scalarMul`. This function is exposed via the test harness so
    ///         tests can prove the two implementations agree on arbitrary
    ///         scalars without trusting the BIP-340 vector corpus alone.
    function affineScalarMul(uint256 scalar, Point memory point)
        internal
        view
        returns (bool, Point memory)
    {
        Point memory result = Point(0, 0, true);
        Point memory addend = point;

        for (uint16 bit = 0; bit < MaxScalarMulBits && scalar != 0; bit++) {
            if (scalar & 1 == 1) {
                (bool added, Point memory nextResult) = pointAdd(
                    result,
                    addend
                );
                if (!added) {
                    return (false, result);
                }

                result = nextResult;
            }

            scalar >>= 1;

            if (scalar != 0) {
                (bool doubled, Point memory nextAddend) = pointDouble(addend);
                if (!doubled) {
                    return (false, result);
                }

                addend = nextAddend;
            }
        }

        return (true, result);
    }

    function pointAdd(Point memory left, Point memory right)
        internal
        view
        returns (bool, Point memory)
    {
        if (left.infinity) {
            return (true, right);
        }

        if (right.infinity) {
            return (true, left);
        }

        if (left.x == right.x) {
            if (left.y == right.y) {
                return pointDouble(left);
            }

            return (true, Point(0, 0, true));
        }

        (bool inverted, uint256 denominatorInverse) = modInverse(
            submod(right.x, left.x)
        );
        if (!inverted) {
            return (false, Point(0, 0, true));
        }

        uint256 slope = mulmod(
            submod(right.y, left.y),
            denominatorInverse,
            Secp256k1P
        );
        uint256 resultX = submod(
            submod(mulmod(slope, slope, Secp256k1P), left.x),
            right.x
        );
        uint256 resultY = submod(
            mulmod(slope, submod(left.x, resultX), Secp256k1P),
            left.y
        );

        return (true, Point(resultX, resultY, false));
    }

    function pointDouble(Point memory point)
        internal
        view
        returns (bool, Point memory)
    {
        if (point.infinity) {
            return (true, point);
        }

        if (point.y == 0) {
            return (true, Point(0, 0, true));
        }

        (bool inverted, uint256 denominatorInverse) = modInverse(
            mulmod(2, point.y, Secp256k1P)
        );
        if (!inverted) {
            return (false, Point(0, 0, true));
        }

        uint256 slope = mulmod(
            mulmod(3, mulmod(point.x, point.x, Secp256k1P), Secp256k1P),
            denominatorInverse,
            Secp256k1P
        );
        uint256 resultX = submod(
            submod(mulmod(slope, slope, Secp256k1P), point.x),
            point.x
        );
        uint256 resultY = submod(
            mulmod(slope, submod(point.x, resultX), Secp256k1P),
            point.y
        );

        return (true, Point(resultX, resultY, false));
    }

    function liftX(uint256 x) internal view returns (bool, Point memory point) {
        if (x >= Secp256k1P) {
            return (false, point);
        }

        uint256 ySquared = addmod(
            mulmod(mulmod(x, x, Secp256k1P), x, Secp256k1P),
            7,
            Secp256k1P
        );

        (bool squareRootComputed, uint256 y) = modExp(
            ySquared,
            FieldSqrtExponent,
            Secp256k1P
        );
        if (!squareRootComputed || mulmod(y, y, Secp256k1P) != ySquared) {
            return (false, point);
        }

        if (y % 2 == 1) {
            y = Secp256k1P - y;
        }

        return (true, Point(x, y, false));
    }

    function modInverse(uint256 value) internal view returns (bool, uint256) {
        if (value == 0) {
            return (false, 0);
        }

        return modExp(value, FieldInverseExponent, Secp256k1P);
    }

    function modExp(
        uint256 base,
        uint256 exponent,
        uint256 modulus
    ) internal view returns (bool success, uint256 result) {
        bytes memory input = abi.encode(
            uint256(32),
            uint256(32),
            uint256(32),
            base,
            exponent,
            modulus
        );
        bytes memory output = new bytes(32);

        // solhint-disable-next-line no-inline-assembly
        assembly {
            success := staticcall(
                gas(),
                0x05,
                add(input, 32),
                mload(input),
                add(output, 32),
                32
            )
            result := mload(add(output, 32))
        }
    }

    /// @notice Computes BIP-340 tagged challenge hash.
    /// @dev Tagged hash per BIP340:
    ///      sha256(tagHash || tagHash || nonceX || pubKeyX || message).
    function computeBIP340TaggedChallenge(
        bytes32 nonceX,
        bytes32 pubKeyX,
        bytes32 message
    ) internal pure returns (bytes32) {
        return
            sha256(
                abi.encodePacked(
                    BIP340ChallengeTagHash,
                    BIP340ChallengeTagHash,
                    nonceX,
                    pubKeyX,
                    message
                )
            );
    }

    function generator() internal pure returns (Point memory) {
        return Point(Secp256k1Gx, Secp256k1Gy, false);
    }

    function submod(uint256 left, uint256 right)
        internal
        pure
        returns (uint256)
    {
        return addmod(left, Secp256k1P - right, Secp256k1P);
    }
}
