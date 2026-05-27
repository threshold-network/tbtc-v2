// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/P2TRSignatureFraud.sol";
import "../prototypes/PrototypeP2TRSignatureFraud.sol";

/// @dev Test-only harness for draft P2TR signature-fraud challenge identities.
///      This contract is vector evidence, not production challenge-key logic.
contract TestP2TRSignatureFraudChallenge {
    function computeDraftChallengeIdentity(
        bytes32 walletID,
        bytes32 sighash,
        bytes calldata signature,
        uint8 sighashType,
        uint32 signedInputIndex,
        bytes calldata unsignedTransaction,
        PrototypeP2TRSignatureFraud.Prevout[] calldata prevouts
    ) external pure returns (bytes32) {
        return
            PrototypeP2TRSignatureFraud.computeDraftChallengeIdentity(
                walletID,
                sighash,
                signature,
                sighashType,
                signedInputIndex,
                unsignedTransaction,
                prevouts
            );
    }

    function parseWitnessSignature(bytes calldata witnessSignature)
        external
        pure
        returns (bytes memory signature, uint8 sighashType)
    {
        return P2TRSignatureFraud.parseWitnessSignature(witnessSignature);
    }

    function computeBridgeChallengeKey(
        uint256 chainID,
        address bridge,
        bytes32 draftChallengeIdentity
    ) external pure returns (uint256) {
        return
            P2TRSignatureFraud.computeBridgeChallengeKey(
                chainID,
                bridge,
                draftChallengeIdentity
            );
    }
}
