// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/CheckBitcoinP2TRSignatureFraud.sol";

contract TestCheckBitcoinP2TRSignatureFraud {
    // The array/bytes arguments below are declared `memory` rather than
    // `calldata` deliberately. With the annex added these entry points carry
    // five dynamic arguments, and the legacy (non-IR) code generator overflows
    // the stack by one slot generating the calldata->memory copy for five
    // dynamic arguments in a single call. The `memory` decoder is shallower and
    // compiles without the IR pipeline (unavailable here -- see the P2TR note in
    // hardhat.config). This is a test-harness detail only; the production
    // library keeps its native `memory` signatures.
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
    ) external view returns (bool) {
        return
            CheckBitcoinP2TRSignatureFraud.checkKeyPathSignature(
                walletID,
                version,
                locktime,
                inputs,
                prevouts,
                outputs,
                signedInputIndex,
                witnessSignature,
                annex
            );
    }

    function computeKeyPathSighashForWitness(
        uint32 version,
        uint32 locktime,
        CheckBitcoinBIP341Sighash.TransactionInput[] memory inputs,
        CheckBitcoinBIP341Sighash.InputPrevout[] memory prevouts,
        CheckBitcoinBIP341Sighash.TransactionOutput[] memory outputs,
        uint32 signedInputIndex,
        bytes memory witnessSignature,
        bytes memory annex
    ) external pure returns (bytes32) {
        return
            CheckBitcoinP2TRSignatureFraud.computeKeyPathSighashForWitness(
                version,
                locktime,
                inputs,
                prevouts,
                outputs,
                signedInputIndex,
                witnessSignature,
                annex
            );
    }

    function computeBridgeChallengeIdentity(
        CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload
            calldata payload
    ) external pure returns (bytes32) {
        return
            CheckBitcoinP2TRSignatureFraud.computeBridgeChallengeIdentity(
                payload
            );
    }

    function validatePayloadShape(
        CheckBitcoinP2TRSignatureFraud.BridgeChallengeIdentityPayload
            calldata payload,
        CheckBitcoinP2TRSignatureFraud.PayloadBounds calldata bounds
    ) external pure {
        CheckBitcoinP2TRSignatureFraud.validatePayloadShape(payload, bounds);
    }
}
