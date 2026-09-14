// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/P2TRSignatureFraud.sol";

/// @dev Test-only harness for production P2TR signature-fraud challenge key
///      derivation. Draft challenge identity coverage was retired alongside
///      solidity/contracts/prototypes/PrototypeP2TRSignatureFraud.sol; this
///      harness now exercises only the production P2TRSignatureFraud witness
///      parser and Bridge challenge-key derivation.
contract TestP2TRSignatureFraudChallenge {
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