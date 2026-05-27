// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./P2TRSignatureFraud.sol";

/// @title Check Bitcoin BIP-341 Key-Path Sighash
/// @notice Reconstructs Taproot key-path sighashes for the P2TR signature-fraud
///         verifier feasibility path.
/// @dev This is intentionally not wired into Bridge fraud entrypoints yet. It
///      supports only annex-free key-path SIGHASH_DEFAULT and SIGHASH_ALL
///      payloads used by the current draft vector corpus.
library CheckBitcoinBIP341Sighash {
    struct TransactionInput {
        bytes32 txid;
        uint32 vout;
        uint32 sequence;
    }

    struct InputPrevout {
        uint64 valueSats;
        bytes scriptPubKey;
    }

    struct TransactionOutput {
        uint64 valueSats;
        bytes scriptPubKey;
    }

    uint8 internal constant SighashDefault = 0;
    uint8 internal constant SighashAll = 1;

    /// @notice SHA-256("TapSighash").
    bytes32 internal constant TapSighashTagHash =
        0xf40a48df4b2a70c8b4924bf2654661ed3d95fd66a313eb87237597c628e4a031;

    /// @notice Computes an annex-free BIP-341 key-path sighash.
    /// @param version Transaction version.
    /// @param locktime Transaction locktime.
    /// @param inputs Ordered transaction input outpoints and sequences.
    /// @param prevouts Ordered previous outputs corresponding to `inputs`.
    /// @param outputs Ordered transaction outputs.
    /// @param signedInputIndex Index of the input whose key-path signature is
    ///        being checked.
    /// @param sighashType Supported Taproot sighash type: DEFAULT or ALL.
    function computeKeyPathSighash(
        uint32 version,
        uint32 locktime,
        TransactionInput[] memory inputs,
        InputPrevout[] memory prevouts,
        TransactionOutput[] memory outputs,
        uint32 signedInputIndex,
        uint8 sighashType
    ) internal pure returns (bytes32) {
        require(
            sighashType == SighashDefault || sighashType == SighashAll,
            "Unsupported BIP341 sighash type"
        );
        require(inputs.length == prevouts.length, "Prevout count mismatch");
        require(signedInputIndex < inputs.length, "Signed input out of range");

        bytes memory sigMessage = abi.encodePacked(bytes1(sighashType));
        sigMessage = abi.encodePacked(
            sigMessage,
            P2TRSignatureFraud.uint32LE(version)
        );
        sigMessage = abi.encodePacked(
            sigMessage,
            P2TRSignatureFraud.uint32LE(locktime)
        );
        sigMessage = abi.encodePacked(sigMessage, hashPrevouts(inputs));
        sigMessage = abi.encodePacked(sigMessage, hashAmounts(prevouts));
        sigMessage = abi.encodePacked(sigMessage, hashScriptPubKeys(prevouts));
        sigMessage = abi.encodePacked(sigMessage, hashSequences(inputs));
        sigMessage = abi.encodePacked(sigMessage, hashOutputs(outputs));
        sigMessage = abi.encodePacked(
            sigMessage,
            bytes1(0), // spend_type: key-path, no annex, ext_flag = 0
            P2TRSignatureFraud.uint32LE(signedInputIndex)
        );

        return
            sha256(
                abi.encodePacked(
                    TapSighashTagHash,
                    TapSighashTagHash,
                    bytes1(0), // Taproot signature-message epoch.
                    sigMessage
                )
            );
    }

    function hashPrevouts(TransactionInput[] memory inputs)
        internal
        pure
        returns (bytes32)
    {
        bytes memory serialized;

        for (uint256 i = 0; i < inputs.length; i++) {
            serialized = abi.encodePacked(
                serialized,
                inputs[i].txid,
                P2TRSignatureFraud.uint32LE(inputs[i].vout)
            );
        }

        return sha256(serialized);
    }

    function hashAmounts(InputPrevout[] memory prevouts)
        internal
        pure
        returns (bytes32)
    {
        bytes memory serialized;

        for (uint256 i = 0; i < prevouts.length; i++) {
            serialized = abi.encodePacked(
                serialized,
                P2TRSignatureFraud.uint64LE(prevouts[i].valueSats)
            );
        }

        return sha256(serialized);
    }

    function hashScriptPubKeys(InputPrevout[] memory prevouts)
        internal
        pure
        returns (bytes32)
    {
        bytes memory serialized;

        for (uint256 i = 0; i < prevouts.length; i++) {
            serialized = abi.encodePacked(
                serialized,
                P2TRSignatureFraud.bytesWithCompactSize(
                    prevouts[i].scriptPubKey
                )
            );
        }

        return sha256(serialized);
    }

    function hashSequences(TransactionInput[] memory inputs)
        internal
        pure
        returns (bytes32)
    {
        bytes memory serialized;

        for (uint256 i = 0; i < inputs.length; i++) {
            serialized = abi.encodePacked(
                serialized,
                P2TRSignatureFraud.uint32LE(inputs[i].sequence)
            );
        }

        return sha256(serialized);
    }

    function hashOutputs(TransactionOutput[] memory outputs)
        internal
        pure
        returns (bytes32)
    {
        bytes memory serialized;

        for (uint256 i = 0; i < outputs.length; i++) {
            serialized = abi.encodePacked(
                serialized,
                P2TRSignatureFraud.uint64LE(outputs[i].valueSats),
                P2TRSignatureFraud.bytesWithCompactSize(outputs[i].scriptPubKey)
            );
        }

        return sha256(serialized);
    }
}
