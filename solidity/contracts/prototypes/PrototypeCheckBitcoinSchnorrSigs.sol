// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @title Check Bitcoin Schnorr Signatures (prototype)
/// @notice Verifies a secp256k1 Schnorr-style signature using an `ecrecover`
///         reduction. This implementation is intended as a Phase 0 prototype
///         for gas-path validation and does not implement BIP-340 tagged-hash
///         challenges yet.
/// @dev The measured gas for this contract applies to the ecrecover-reduction
///      path only. Production BIP-340 verification will use a different
///      challenge model and verification strategy, and must be benchmarked
///      separately.
library PrototypeCheckBitcoinSchnorrSigs {
    /// @notice secp256k1 curve order.
    uint256 internal constant Secp256k1N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// @notice SHA-256("BIP0340/challenge").
    bytes32 internal constant BIP340ChallengeTagHash =
        0x7bb52d7a9fef58323eb1bf7a407db382d2f3f2d81bb1224f49fe518f6d48d37c;

    /// @notice Computes prototype Schnorr challenge value.
    /// @dev Challenge domain:
    ///      keccak256(nonceAddress || pubKeyYParity || pubKeyX || message).
    function computeChallenge(
        address nonceAddress,
        uint8 pubKeyYParity,
        bytes32 pubKeyX,
        bytes32 message
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(nonceAddress, pubKeyYParity, pubKeyX, message)
            );
    }

    /// @notice Computes BIP340 tagged challenge hash.
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

    /// @notice Verifies a prototype Schnorr signature.
    /// @param pubKeyX X coordinate of the signer's public key.
    /// @param pubKeyYParity Y parity of the signer's public key (27 or 28).
    /// @param message 32-byte message being signed.
    /// @param challenge Schnorr challenge scalar.
    /// @param signature Schnorr signature scalar (`s`).
    function checkSig(
        bytes32 pubKeyX,
        uint8 pubKeyYParity,
        bytes32 message,
        bytes32 challenge,
        bytes32 signature
    ) internal pure returns (bool) {
        require(
            pubKeyYParity == 27 || pubKeyYParity == 28,
            "Public key parity must be 27 or 28"
        );

        uint256 pubKeyXUint = uint256(pubKeyX);
        require(
            pubKeyXUint > 0 && pubKeyXUint < Secp256k1N,
            "Public key x must be in [1, n-1]"
        );
        // For this ecrecover-reduction prototype, pubKeyX is treated as an
        // ECDSA `r`-like scalar in [1, n-1]. This excludes theoretical
        // secp256k1 x-coordinates in [n, p-1].

        uint256 challengeUint = uint256(challenge);
        require(
            challengeUint > 0 && challengeUint < Secp256k1N,
            "Challenge must be in [1, n-1]"
        );

        uint256 signatureUint = uint256(signature);
        require(
            signatureUint > 0 && signatureUint < Secp256k1N,
            "Signature must be in [1, n-1]"
        );

        bytes32 ecrecoverMessage = bytes32(
            Secp256k1N - mulmod(signatureUint, pubKeyXUint, Secp256k1N)
        );
        bytes32 ecrecoverS = bytes32(
            Secp256k1N - mulmod(challengeUint, pubKeyXUint, Secp256k1N)
        );

        address nonceAddress = ecrecover(
            ecrecoverMessage,
            pubKeyYParity,
            pubKeyX,
            ecrecoverS
        );

        if (nonceAddress == address(0)) {
            return false;
        }

        return
            challenge ==
            computeChallenge(nonceAddress, pubKeyYParity, pubKeyX, message);
    }
}
