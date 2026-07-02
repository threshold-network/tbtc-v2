// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @title P2TR signature-fraud challenge helpers
/// @notice Shared helpers for the selected P2TR signature-fraud challenge
///         direction.
/// @dev This library does not submit or resolve Bridge challenges by itself.
///      It only centralizes deterministic payload encoding and Taproot
///      witness-signature parsing so production Bridge wiring and test
///      harnesses consume the same code.
library P2TRSignatureFraud {
    string internal constant BridgeChallengeIdentityDomain =
        "tbtc-p2tr-signature-fraud-bridge-challenge-v0";
    string internal constant BridgeChallengeKeyDomain =
        "tbtc-p2tr-signature-fraud-bridge-key-v0";
    uint8 internal constant SighashDefault = 0;
    uint8 internal constant SighashAll = 1;
    uint8 internal constant SighashNone = 2;
    uint8 internal constant SighashSingle = 3;
    uint8 internal constant SighashBaseMask = 0x03;
    uint8 internal constant SighashAnyoneCanPayFlag = 0x80;

    /// @notice Returns true for the explicit (65-byte-encoded) Taproot key-path
    ///         sighash bytes this challenge direction accepts.
    /// @dev Excludes an explicit 0x00 byte: BIP-341 SIGHASH_DEFAULT is only ever
    ///      represented by the 64-byte omitted-sighash form, so an explicit 0x00
    ///      on a 65-byte signature is a malformed encoding and is rejected. Every
    ///      other byte outside {0x01,0x02,0x03} and their ANYONECANPAY variants
    ///      is rejected.
    function isSupportedExplicitSighashType(uint8 sighashType)
        internal
        pure
        returns (bool)
    {
        return
            sighashType == SighashAll ||
            sighashType == SighashNone ||
            sighashType == SighashSingle ||
            sighashType == (SighashAnyoneCanPayFlag | SighashAll) ||
            sighashType == (SighashAnyoneCanPayFlag | SighashNone) ||
            sighashType == (SighashAnyoneCanPayFlag | SighashSingle);
    }

    /// @notice Computes the domain-separated Bridge fraud challenge key for a
    ///         P2TR signature-fraud Bridge challenge identity.
    /// @dev The key commits to the chain and Bridge contract domain so the
    ///      same Bitcoin evidence cannot collide across deployments. The
    ///      production Bridge integration should use `block.chainid` and
    ///      `address(this)` for the domain inputs.
    function computeBridgeChallengeKey(
        uint256 chainID,
        address bridge,
        bytes32 bridgeChallengeIdentity
    ) internal pure returns (uint256) {
        require(chainID > 0, "Chain ID must be positive");
        require(bridge != address(0), "Bridge address must be non-zero");

        return
            uint256(
                keccak256(
                    abi.encode(
                        BridgeChallengeKeyDomain,
                        chainID,
                        bridge,
                        bridgeChallengeIdentity
                    )
                )
            );
    }

    /// @notice Parses Taproot key-path witness signature encodings supported by
    ///         the selected P2TR signature-fraud challenge direction.
    /// @dev BIP-341 represents SIGHASH_DEFAULT by omitting the sighash byte, so a
    ///      64-byte signature resolves to SIGHASH_DEFAULT. A 65-byte signature
    ///      carries an explicit sighash byte, which must be one of the supported
    ///      key-path types (ALL/NONE/SINGLE and their ANYONECANPAY variants). An
    ///      explicit 0x00 byte and any other byte are rejected.
    function parseWitnessSignature(bytes memory witnessSignature)
        internal
        pure
        returns (bytes memory signature, uint8 sighashType)
    {
        if (witnessSignature.length == 64) {
            return (copySignature(witnessSignature), SighashDefault);
        }

        require(
            witnessSignature.length == 65,
            "Invalid witness signature length"
        );

        sighashType = uint8(witnessSignature[64]);
        // A 65-byte signature carries an explicit sighash byte. SIGHASH_DEFAULT
        // is accepted only as the 64-byte omitted-sighash form, so an explicit
        // 0x00 byte (and any non key-path byte) is rejected.
        require(
            isSupportedExplicitSighashType(sighashType),
            "Unsupported witness sighash type"
        );

        return (copySignature(witnessSignature), sighashType);
    }

    function copySignature(bytes memory witnessSignature)
        internal
        pure
        returns (bytes memory signature)
    {
        signature = new bytes(64);

        for (uint256 i = 0; i < 64; i++) {
            signature[i] = witnessSignature[i];
        }
    }

    function bytesWithCompactSize(bytes memory payload)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(encodeCompactSize(payload.length), payload);
    }

    function encodeCompactSize(uint256 value)
        internal
        pure
        returns (bytes memory)
    {
        if (value < 0xfd) {
            return abi.encodePacked(bytes1(uint8(value)));
        }

        if (value <= type(uint16).max) {
            return abi.encodePacked(bytes1(0xfd), uint16LE(uint16(value)));
        }

        if (value <= type(uint32).max) {
            return abi.encodePacked(bytes1(0xfe), uint32LE(uint32(value)));
        }

        require(value <= type(uint64).max, "Compact size exceeds uint64");

        return abi.encodePacked(bytes1(0xff), uint64LE(uint64(value)));
    }

    function uint16LE(uint16 value)
        internal
        pure
        returns (bytes memory result)
    {
        result = new bytes(2);
        result[0] = bytes1(uint8(value));
        result[1] = bytes1(uint8(value >> 8));
    }

    function uint32LE(uint32 value)
        internal
        pure
        returns (bytes memory result)
    {
        result = new bytes(4);
        result[0] = bytes1(uint8(value));
        result[1] = bytes1(uint8(value >> 8));
        result[2] = bytes1(uint8(value >> 16));
        result[3] = bytes1(uint8(value >> 24));
    }

    function uint64LE(uint64 value)
        internal
        pure
        returns (bytes memory result)
    {
        result = new bytes(8);
        result[0] = bytes1(uint8(value));
        result[1] = bytes1(uint8(value >> 8));
        result[2] = bytes1(uint8(value >> 16));
        result[3] = bytes1(uint8(value >> 24));
        result[4] = bytes1(uint8(value >> 32));
        result[5] = bytes1(uint8(value >> 40));
        result[6] = bytes1(uint8(value >> 48));
        result[7] = bytes1(uint8(value >> 56));
    }
}
