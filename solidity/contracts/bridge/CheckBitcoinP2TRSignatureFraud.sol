// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./CheckBitcoinBIP340Sigs.sol";
import "./CheckBitcoinBIP341Sighash.sol";
import "./P2TRSignatureFraud.sol";

/// @title Check Bitcoin P2TR Signature Fraud
/// @notice Reconstructs Taproot key-path sighashes for every supported sighash
///         mode -- with or without a witness annex -- and verifies the
///         corresponding BIP-340 witness signature.
/// @dev This helper is intentionally not wired into Bridge fraud entrypoints
///      yet. It combines the BIP-341 key-path sighash and BIP-340 verifier
///      behind one contract-facing API for verifier feasibility testing.
///      Script-path (ext_flag = 1) spends stay out of scope: a key-path-only
///      tBTC FROST wallet signer cannot produce a script-path signature, so
///      such a spend is not a signer-producible fraud.
library CheckBitcoinP2TRSignatureFraud {
    struct PayloadBounds {
        uint16 maxInputs;
        uint16 maxOutputs;
        uint16 maxScriptPubKeyBytes;
    }

    struct BridgeChallengeIdentityPayload {
        bytes32 walletID;
        uint32 version;
        uint32 locktime;
        CheckBitcoinBIP341Sighash.TransactionInput[] inputs;
        CheckBitcoinBIP341Sighash.InputPrevout[] prevouts;
        CheckBitcoinBIP341Sighash.TransactionOutput[] outputs;
        uint32 signedInputIndex;
        bytes witnessSignature;
        bytes annex;
    }

    /// @notice Verifies the Taproot key-path witness signature for the given
    ///         structured transaction and prevout data.
    /// @param walletID X-only Taproot wallet public key.
    /// @param version Transaction version.
    /// @param locktime Transaction locktime.
    /// @param inputs Ordered transaction input outpoints and sequences.
    /// @param prevouts Ordered previous outputs corresponding to `inputs`.
    /// @param outputs Ordered transaction outputs.
    /// @param signedInputIndex Index of the input whose key-path signature is
    ///        being checked.
    /// @param witnessSignature Taproot witness signature: 64-byte BIP-340
    ///        signature for SIGHASH_DEFAULT or 65-byte signature with a trailing
    ///        explicit sighash byte (ALL/NONE/SINGLE, optionally ANYONECANPAY).
    /// @param annex Witness annex bytes including their 0x50 prefix, or empty
    ///        when the spend carries no annex.
    function checkKeyPathSignature(
        bytes32 walletID,
        uint32 version,
        uint32 locktime,
        CheckBitcoinBIP341Sighash.TransactionInput[] memory inputs,
        CheckBitcoinBIP341Sighash.InputPrevout[] memory prevouts,
        CheckBitcoinBIP341Sighash.TransactionOutput[] memory outputs,
        uint32 signedInputIndex,
        bytes memory witnessSignature,
        bytes memory annex
    ) internal view returns (bool) {
        bytes32 sighash = computeKeyPathSighashForWitness(
            version,
            locktime,
            inputs,
            prevouts,
            outputs,
            signedInputIndex,
            witnessSignature,
            annex
        );

        return checkSignature(walletID, sighash, witnessSignature);
    }

    function checkSignature(
        bytes32 walletID,
        bytes32 sighash,
        bytes memory witnessSignature
    ) internal view returns (bool) {
        (bytes memory signature, ) = P2TRSignatureFraud.parseWitnessSignature(
            witnessSignature
        );
        (bytes32 nonceX, bytes32 signatureScalar) = splitSignature(signature);

        return
            CheckBitcoinBIP340Sigs.checkSig(
                walletID,
                sighash,
                nonceX,
                signatureScalar
            );
    }

    /// @notice Computes the BIP-341 key-path sighash implied by a Taproot
    ///         witness signature encoding.
    /// @param version Transaction version.
    /// @param locktime Transaction locktime.
    /// @param inputs Ordered transaction input outpoints and sequences.
    /// @param prevouts Ordered previous outputs corresponding to `inputs`.
    /// @param outputs Ordered transaction outputs.
    /// @param signedInputIndex Index of the input whose key-path signature is
    ///        being checked.
    /// @param witnessSignature Taproot witness signature: 64-byte BIP-340
    ///        signature for SIGHASH_DEFAULT or 65-byte signature with a trailing
    ///        explicit sighash byte (ALL/NONE/SINGLE, optionally ANYONECANPAY).
    /// @param annex Witness annex bytes including their 0x50 prefix, or empty
    ///        when the spend carries no annex.
    function computeKeyPathSighashForWitness(
        uint32 version,
        uint32 locktime,
        CheckBitcoinBIP341Sighash.TransactionInput[] memory inputs,
        CheckBitcoinBIP341Sighash.InputPrevout[] memory prevouts,
        CheckBitcoinBIP341Sighash.TransactionOutput[] memory outputs,
        uint32 signedInputIndex,
        bytes memory witnessSignature,
        bytes memory annex
    ) internal pure returns (bytes32) {
        (, uint8 sighashType) = P2TRSignatureFraud.parseWitnessSignature(
            witnessSignature
        );

        return
            CheckBitcoinBIP341Sighash.computeKeyPathSighash(
                version,
                locktime,
                inputs,
                prevouts,
                outputs,
                signedInputIndex,
                sighashType,
                annex
            );
    }

    /// @notice Computes the Bridge-facing challenge identity from the
    ///         structured Taproot payload fields verified by this helper.
    /// @dev This identity avoids committing to an opaque raw transaction blob.
    ///      It commits to the fields the Bridge verifier reconstructs: version,
    ///      locktime, input outpoints and sequences, prevout values and scripts,
    ///      outputs, signed input index, BIP-341 sighash, and BIP-340
    ///      signature.
    function computeBridgeChallengeIdentity(
        BridgeChallengeIdentityPayload memory payload
    ) internal pure returns (bytes32) {
        (bytes memory signature, uint8 sighashType) = P2TRSignatureFraud
            .parseWitnessSignature(payload.witnessSignature);
        bytes
            memory transactionPayload = encodeBridgeChallengeTransactionPayload(
                payload
            );

        return
            computeBridgeChallengeIdentityForPayload(
                payload.walletID,
                computeBridgeChallengeIdentitySighash(payload),
                signature,
                sighashType,
                transactionPayload
            );
    }

    function computeBridgeChallengeIdentitySighash(
        BridgeChallengeIdentityPayload memory payload
    ) internal pure returns (bytes32) {
        validateAnnex(payload.annex);

        return
            computeKeyPathSighashForWitness(
                payload.version,
                payload.locktime,
                payload.inputs,
                payload.prevouts,
                payload.outputs,
                payload.signedInputIndex,
                payload.witnessSignature,
                payload.annex
            );
    }

    function computeBridgeChallengeIdentityForPayload(
        bytes32 walletID,
        bytes32 sighash,
        bytes memory signature,
        uint8 sighashType,
        bytes memory transactionPayload
    ) internal pure returns (bytes32) {
        return
            sha256(
                abi.encodePacked(
                    P2TRSignatureFraud.BridgeChallengeIdentityDomain,
                    walletID,
                    sighash,
                    signature,
                    bytes1(sighashType),
                    transactionPayload
                )
            );
    }

    function encodeBridgeChallengeTransactionPayload(
        BridgeChallengeIdentityPayload memory payload
    ) internal pure returns (bytes memory) {
        // Collect every fixed-format field as a separate part and concatenate
        // once -- each byte is copied exactly once (O(n)). Appending into a
        // growing `abi.encodePacked` buffer per element would be O(n^2) in the
        // input/output count, so large but valid protocol-shaped evidence
        // (redemption batches, moving-funds fan-out, multi-input sweeps) that the
        // raised shape caps now accept could run out of gas building the
        // challenge identity before the challenge is recorded. The concatenation
        // order for the transaction fields is byte-identical to the prior
        // incremental encoding; an annex, when present, is committed as a
        // length-prefixed trailer so an annex-free payload stays byte-identical
        // to the pre-annex encoding. The encoding reads the struct pointer
        // directly (rather than unpacking every field into locals) to keep this
        // routine's stack shallow enough for the legacy code generator.
        bool annexPresent = payload.annex.length > 0;
        bytes[] memory parts = new bytes[](
            3 +
                payload.inputs.length +
                payload.prevouts.length +
                payload.outputs.length +
                (annexPresent ? 1 : 0)
        );
        uint256 next = 0;

        parts[next++] = abi.encodePacked(
            P2TRSignatureFraud.uint32LE(payload.signedInputIndex),
            P2TRSignatureFraud.uint32LE(payload.version),
            P2TRSignatureFraud.uint32LE(payload.locktime),
            P2TRSignatureFraud.encodeCompactSize(payload.inputs.length)
        );

        for (uint256 i = 0; i < payload.inputs.length; i++) {
            parts[next++] = abi.encodePacked(
                payload.inputs[i].txid,
                P2TRSignatureFraud.uint32LE(payload.inputs[i].vout),
                P2TRSignatureFraud.uint32LE(payload.inputs[i].sequence)
            );
        }

        parts[next++] = P2TRSignatureFraud.encodeCompactSize(
            payload.prevouts.length
        );
        for (uint256 i = 0; i < payload.prevouts.length; i++) {
            parts[next++] = abi.encodePacked(
                P2TRSignatureFraud.uint64LE(payload.prevouts[i].valueSats),
                P2TRSignatureFraud.bytesWithCompactSize(
                    payload.prevouts[i].scriptPubKey
                )
            );
        }

        parts[next++] = P2TRSignatureFraud.encodeCompactSize(
            payload.outputs.length
        );
        for (uint256 i = 0; i < payload.outputs.length; i++) {
            parts[next++] = abi.encodePacked(
                P2TRSignatureFraud.uint64LE(payload.outputs[i].valueSats),
                P2TRSignatureFraud.bytesWithCompactSize(
                    payload.outputs[i].scriptPubKey
                )
            );
        }

        if (annexPresent) {
            parts[next++] = P2TRSignatureFraud.bytesWithCompactSize(
                payload.annex
            );
        }

        return CheckBitcoinBIP341Sighash.concat(parts);
    }

    /// @notice Validates bounded Taproot signature-fraud payload shape.
    /// @dev The bounds are explicit inputs so the production Bridge integration
    ///      can freeze reviewed limits without changing verifier semantics.
    function validatePayloadShape(
        BridgeChallengeIdentityPayload memory payload,
        PayloadBounds memory bounds
    ) internal pure {
        require(bounds.maxInputs > 0, "Input bound must be positive");
        require(bounds.maxOutputs > 0, "Output bound must be positive");
        require(
            bounds.maxScriptPubKeyBytes > 0,
            "Script bound must be positive"
        );
        require(payload.inputs.length > 0, "No inputs");
        require(payload.outputs.length > 0, "No outputs");
        require(
            payload.inputs.length == payload.prevouts.length,
            "Prevout count mismatch"
        );
        require(payload.inputs.length <= bounds.maxInputs, "Too many inputs");
        require(
            payload.outputs.length <= bounds.maxOutputs,
            "Too many outputs"
        );
        require(
            payload.signedInputIndex < payload.inputs.length,
            "Signed input out of range"
        );
        validateAnnex(payload.annex);

        P2TRSignatureFraud.parseWitnessSignature(payload.witnessSignature);

        for (uint256 i = 0; i < payload.prevouts.length; i++) {
            require(
                payload.prevouts[i].scriptPubKey.length <=
                    bounds.maxScriptPubKeyBytes,
                "Prevout script too large"
            );
        }

        for (uint256 i = 0; i < payload.outputs.length; i++) {
            require(
                payload.outputs[i].scriptPubKey.length <=
                    bounds.maxScriptPubKeyBytes,
                "Output script too large"
            );
        }
    }

    /// @notice Validates a witness annex, if present.
    /// @dev An empty `annex` denotes an annex-free spend and is accepted. A
    ///      non-empty annex must carry its mandatory BIP-341 0x50 prefix byte;
    ///      any other leading byte is not a valid annex and is rejected. This is
    ///      key-path only: the verifier never treats the second witness stack
    ///      item as a script-path control block, so script-path spends remain
    ///      unsupported by construction.
    function validateAnnex(bytes memory annex) internal pure {
        if (annex.length > 0) {
            require(uint8(annex[0]) == 0x50, "Annex must start with 0x50");
        }
    }

    function splitSignature(bytes memory signature)
        internal
        pure
        returns (bytes32 nonceX, bytes32 signatureScalar)
    {
        require(signature.length == 64, "Signature must be 64 bytes");

        // solhint-disable-next-line no-inline-assembly
        assembly {
            nonceX := mload(add(signature, 32))
            signatureScalar := mload(add(signature, 64))
        }
    }
}
