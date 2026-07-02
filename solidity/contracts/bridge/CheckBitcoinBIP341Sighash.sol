// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./P2TRSignatureFraud.sol";

/// @title Check Bitcoin BIP-341 Key-Path Sighash
/// @notice Reconstructs Taproot key-path sighashes for the P2TR signature-fraud
///         verifier feasibility path.
/// @dev This is intentionally not wired into Bridge fraud entrypoints yet. It
///      reconstructs every KEY-PATH (ext_flag = 0) Taproot sighash mode -- the
///      base types DEFAULT (implicit 0x00), ALL (0x01), NONE (0x02) and
///      SINGLE (0x03), each optionally combined with the ANYONECANPAY flag
///      (0x81/0x82/0x83) -- with or without a witness annex.
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
    uint8 internal constant SighashNone = 2;
    uint8 internal constant SighashSingle = 3;
    uint8 internal constant SighashBaseMask = 0x03;
    uint8 internal constant SighashAnyoneCanPayFlag = 0x80;

    /// @notice SHA-256("TapSighash").
    bytes32 internal constant TapSighashTagHash =
        0xf40a48df4b2a70c8b4924bf2654661ed3d95fd66a313eb87237597c628e4a031;

    /// @notice Returns true for the Taproot KEY-PATH sighash types this verifier
    ///         reconstructs.
    /// @dev Only the four base types (DEFAULT/ALL/NONE/SINGLE) and their
    ///      ANYONECANPAY variants are valid. In particular an explicit
    ///      ANYONECANPAY|DEFAULT (0x80) is not a real Bitcoin sighash type
    ///      (DEFAULT is only ever the 64-byte omitted-byte form) and every byte
    ///      that sets bits outside the 0x83 mask is rejected.
    function isSupportedKeyPathSighashType(uint8 sighashType)
        internal
        pure
        returns (bool)
    {
        return
            sighashType == SighashDefault ||
            sighashType == SighashAll ||
            sighashType == SighashNone ||
            sighashType == SighashSingle ||
            sighashType == (SighashAnyoneCanPayFlag | SighashAll) ||
            sighashType == (SighashAnyoneCanPayFlag | SighashNone) ||
            sighashType == (SighashAnyoneCanPayFlag | SighashSingle);
    }

    /// @notice Computes a BIP-341 key-path sighash for any supported sighash
    ///         mode, with or without a witness annex.
    /// @param version Transaction version.
    /// @param locktime Transaction locktime.
    /// @param inputs Ordered transaction input outpoints and sequences.
    /// @param prevouts Ordered previous outputs corresponding to `inputs`.
    /// @param outputs Ordered transaction outputs.
    /// @param signedInputIndex Index of the input whose key-path signature is
    ///        being checked.
    /// @param sighashType Supported Taproot key-path sighash type: DEFAULT,
    ///        ALL, NONE, SINGLE or any of those OR-ed with ANYONECANPAY.
    /// @param annex Witness annex bytes including their mandatory 0x50 prefix,
    ///        or empty when the spend carries no annex.
    /// @dev Scope and remaining boundary: this reconstructs every KEY-PATH
    ///      (ext_flag = 0) sighash mode plus the annex, which spans everything a
    ///      tBTC FROST wallet signer can sign. SCRIPT-PATH (ext_flag = 1) spends
    ///      are deliberately NOT reconstructed and are structurally out of scope
    ///      rather than a coverage gap: a key-path-only tBTC FROST wallet signer
    ///      holds no script tree / leaf material, so it cannot produce a
    ///      script-path (tapleaf) signature at all. A script-path spend of a
    ///      wallet UTXO is therefore not a signer-producible fraud, and there is
    ///      no honest or malicious signer message for this verifier to
    ///      reconstruct. SIGHASH_SINGLE requires the output at
    ///      `signedInputIndex` to exist (BIP-341 makes the corresponding output
    ///      mandatory); a SINGLE signature without it is invalid and is rejected
    ///      here instead of hashing a bogus message.
    function computeKeyPathSighash(
        uint32 version,
        uint32 locktime,
        TransactionInput[] memory inputs,
        InputPrevout[] memory prevouts,
        TransactionOutput[] memory outputs,
        uint32 signedInputIndex,
        uint8 sighashType,
        bytes memory annex
    ) internal pure returns (bytes32) {
        require(
            isSupportedKeyPathSighashType(sighashType),
            "Unsupported BIP341 sighash type"
        );
        require(inputs.length == prevouts.length, "Prevout count mismatch");
        require(signedInputIndex < inputs.length, "Signed input out of range");

        if ((sighashType & SighashBaseMask) == SighashSingle) {
            require(
                signedInputIndex < outputs.length,
                "SIGHASH_SINGLE output missing"
            );
        }

        // Assemble the sigmsg as an ordered set of parts and concatenate once.
        // Building it this way (rather than repeatedly re-`abi.encodePacked`-ing
        // a growing buffer) keeps each encode step small enough to stay within
        // the EVM stack limit and copies each byte exactly once. Unset parts stay
        // empty and contribute nothing, matching the BIP-341 mode branches.
        bytes[] memory parts = new bytes[](7);

        parts[0] = abi.encodePacked(
            bytes1(sighashType),
            P2TRSignatureFraud.uint32LE(version),
            P2TRSignatureFraud.uint32LE(locktime)
        );

        // Input commitments are omitted for ANYONECANPAY (only the signed input
        // is committed below); otherwise commit every input's outpoint, amount,
        // scriptPubKey and sequence.
        if ((sighashType & SighashAnyoneCanPayFlag) == 0) {
            parts[1] = abi.encodePacked(
                hashPrevouts(inputs),
                hashAmounts(prevouts),
                hashScriptPubKeys(prevouts),
                hashSequences(inputs)
            );
        }

        // ALL and DEFAULT commit to every output; NONE and SINGLE do not commit
        // the full output set here (SINGLE commits one output at the end).
        if (
            (sighashType & SighashBaseMask) != SighashNone &&
            (sighashType & SighashBaseMask) != SighashSingle
        ) {
            parts[2] = abi.encodePacked(hashOutputs(outputs));
        }

        // spend_type = (ext_flag * 2) + annex_present, with ext_flag = 0 for a
        // key-path spend.
        parts[3] = abi.encodePacked(
            bytes1(annex.length > 0 ? uint8(1) : uint8(0))
        );

        if ((sighashType & SighashAnyoneCanPayFlag) != 0) {
            parts[4] = anyoneCanPayInput(
                inputs[signedInputIndex],
                prevouts[signedInputIndex]
            );
        } else {
            parts[4] = P2TRSignatureFraud.uint32LE(signedInputIndex);
        }

        if (annex.length > 0) {
            parts[5] = abi.encodePacked(
                sha256(P2TRSignatureFraud.bytesWithCompactSize(annex))
            );
        }

        if ((sighashType & SighashBaseMask) == SighashSingle) {
            parts[6] = abi.encodePacked(
                hashSingleOutput(outputs[signedInputIndex])
            );
        }

        return taggedTapSighash(concat(parts));
    }

    /// @notice Applies the BIP-341 "TapSighash" tagged hash over the epoch and
    ///         signature message.
    /// @dev taggedHash(tag, m) = sha256(sha256(tag) || sha256(tag) || m); the
    ///      Taproot signature-message epoch byte (0x00) is prepended to the
    ///      sigmsg per BIP-341.
    function taggedTapSighash(bytes memory sigMessage)
        internal
        pure
        returns (bytes32)
    {
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

    /// @notice Serializes the signed input for an ANYONECANPAY sigmsg.
    /// @dev BIP-341 commits, for the signed input only, its outpoint (36 bytes),
    ///      spent amount (8 LE), prevout scriptPubKey (compactSize-prefixed) and
    ///      nSequence (4 LE).
    function anyoneCanPayInput(
        TransactionInput memory input,
        InputPrevout memory prevout
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                input.txid,
                P2TRSignatureFraud.uint32LE(input.vout),
                P2TRSignatureFraud.uint64LE(prevout.valueSats),
                P2TRSignatureFraud.bytesWithCompactSize(prevout.scriptPubKey),
                P2TRSignatureFraud.uint32LE(input.sequence)
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

    /// @notice SHA-256 over a single output in CTxOut format.
    /// @dev Used for the SIGHASH_SINGLE `sha_single_output` commitment, which
    ///      hashes only the output paired with the signed input index.
    function hashSingleOutput(TransactionOutput memory output)
        internal
        pure
        returns (bytes32)
    {
        return
            sha256(
                abi.encodePacked(
                    P2TRSignatureFraud.uint64LE(output.valueSats),
                    P2TRSignatureFraud.bytesWithCompactSize(output.scriptPubKey)
                )
            );
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
