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
    /// @dev Scope and KNOWN coverage limitation: this verifier reconstructs only
    ///      Taproot KEY-PATH spends signed with SIGHASH_DEFAULT or SIGHASH_ALL and
    ///      no witness annex -- the form honest tBTC wallet operations (sweeps,
    ///      redemptions, moving-funds) use. A signature using another sighash mode
    ///      (NONE/SINGLE/ANYONECANPAY), a script-path spend, or an annex cannot be
    ///      reconstructed here, so a P2TR signature-fraud proof for such a spend
    ///      cannot be built and the timeout path (P2TRSignatureFraudRouter ->
    ///      Bridge.slashWalletForP2TRFraud) cannot be reached for it. This is a
    ///      coverage gap of the on-chain fraud proof, NOT a claim that such spends
    ///      are harmless: it is a bypass of the P2TR fraud/slashing path for those
    ///      signing modes. Closing it requires extending the sighash
    ///      reconstruction to the remaining modes (SINGLE/ANYONECANPAY also need a
    ///      richer challenge payload carrying per-input/-output context).
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
        bytes[] memory parts = new bytes[](inputs.length);

        for (uint256 i = 0; i < inputs.length; i++) {
            parts[i] = abi.encodePacked(
                inputs[i].txid,
                P2TRSignatureFraud.uint32LE(inputs[i].vout)
            );
        }

        return sha256(concat(parts));
    }

    function hashAmounts(InputPrevout[] memory prevouts)
        internal
        pure
        returns (bytes32)
    {
        bytes[] memory parts = new bytes[](prevouts.length);

        for (uint256 i = 0; i < prevouts.length; i++) {
            parts[i] = P2TRSignatureFraud.uint64LE(prevouts[i].valueSats);
        }

        return sha256(concat(parts));
    }

    function hashScriptPubKeys(InputPrevout[] memory prevouts)
        internal
        pure
        returns (bytes32)
    {
        bytes[] memory parts = new bytes[](prevouts.length);

        for (uint256 i = 0; i < prevouts.length; i++) {
            parts[i] = P2TRSignatureFraud.bytesWithCompactSize(
                prevouts[i].scriptPubKey
            );
        }

        return sha256(concat(parts));
    }

    function hashSequences(TransactionInput[] memory inputs)
        internal
        pure
        returns (bytes32)
    {
        bytes[] memory parts = new bytes[](inputs.length);

        for (uint256 i = 0; i < inputs.length; i++) {
            parts[i] = P2TRSignatureFraud.uint32LE(inputs[i].sequence);
        }

        return sha256(concat(parts));
    }

    function hashOutputs(TransactionOutput[] memory outputs)
        internal
        pure
        returns (bytes32)
    {
        bytes[] memory parts = new bytes[](outputs.length);

        for (uint256 i = 0; i < outputs.length; i++) {
            parts[i] = abi.encodePacked(
                P2TRSignatureFraud.uint64LE(outputs[i].valueSats),
                P2TRSignatureFraud.bytesWithCompactSize(outputs[i].scriptPubKey)
            );
        }

        return sha256(concat(parts));
    }

    /// @notice Concatenates `parts` into a single byte string.
    /// @dev Equivalent to chaining `abi.encodePacked` over `parts`, but copies
    ///      each byte exactly once (O(total length)) instead of re-copying a
    ///      growing buffer on every element (which is O(n^2) in the element
    ///      count). The BIP-341 vector hashes above feed this with one part per
    ///      input or output, so an O(n^2) build would make large -- but valid --
    ///      protocol transaction shapes (redemption batches, moving-funds
    ///      fan-out, multi-input sweeps) exceed the block gas limit and become
    ///      impossible to submit as fraud challenges.
    function concat(bytes[] memory parts) internal pure returns (bytes memory) {
        uint256 totalLength = 0;
        for (uint256 i = 0; i < parts.length; i++) {
            totalLength += parts[i].length;
        }

        bytes memory serialized = new bytes(totalLength);
        uint256 offset = 0;
        for (uint256 i = 0; i < parts.length; i++) {
            bytes memory part = parts[i];
            for (uint256 j = 0; j < part.length; j++) {
                serialized[offset] = part[j];
                offset++;
            }
        }

        return serialized;
    }
}
