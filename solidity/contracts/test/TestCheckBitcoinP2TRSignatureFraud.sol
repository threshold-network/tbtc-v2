// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/CheckBitcoinP2TRSignatureFraud.sol";

contract TestCheckBitcoinP2TRSignatureFraud {
    function checkKeyPathSignature(
        bytes32 walletID,
        uint32 version,
        uint32 locktime,
        CheckBitcoinBIP341Sighash.TransactionInput[] calldata inputs,
        CheckBitcoinBIP341Sighash.InputPrevout[] calldata prevouts,
        CheckBitcoinBIP341Sighash.TransactionOutput[] calldata outputs,
        uint32 signedInputIndex,
        bytes calldata witnessSignature
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
                witnessSignature
            );
    }

    function computeKeyPathSighashForWitness(
        uint32 version,
        uint32 locktime,
        CheckBitcoinBIP341Sighash.TransactionInput[] calldata inputs,
        CheckBitcoinBIP341Sighash.InputPrevout[] calldata prevouts,
        CheckBitcoinBIP341Sighash.TransactionOutput[] calldata outputs,
        uint32 signedInputIndex,
        bytes calldata witnessSignature
    ) external pure returns (bytes32) {
        return
            CheckBitcoinP2TRSignatureFraud.computeKeyPathSighashForWitness(
                version,
                locktime,
                inputs,
                prevouts,
                outputs,
                signedInputIndex,
                witnessSignature
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
