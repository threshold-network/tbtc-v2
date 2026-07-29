// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/P2TRSignatureFraud.sol";

/// @title Prototype P2TR signature-fraud helpers
/// @notice Draft-only challenge identity helper retained for vector evidence.
/// @dev This library must not be wired into production Bridge challenge keys.
library PrototypeP2TRSignatureFraud {
    struct Prevout {
        bytes32 txid;
        uint32 vout;
        uint64 valueSats;
        bytes scriptPubKey;
    }

    string internal constant DraftChallengeIdentityDomain =
        "tbtc-p2tr-signature-fraud-challenge-v0";

    /// @notice Computes the draft P2TR signature-fraud challenge identity.
    /// @dev This identity is still pending final production approval. It is
    ///      prototype/vector evidence and has no Bridge side effects.
    function computeDraftChallengeIdentity(
        bytes32 walletID,
        bytes32 sighash,
        bytes calldata signature,
        uint8 sighashType,
        uint32 signedInputIndex,
        bytes calldata unsignedTransaction,
        Prevout[] calldata prevouts
    ) internal pure returns (bytes32) {
        require(signature.length == 64, "Signature must be 64 bytes");

        bytes memory preimage = abi.encodePacked(
            DraftChallengeIdentityDomain,
            walletID,
            sighash,
            signature,
            bytes1(sighashType),
            P2TRSignatureFraud.uint32LE(signedInputIndex),
            P2TRSignatureFraud.bytesWithCompactSize(unsignedTransaction),
            P2TRSignatureFraud.encodeCompactSize(prevouts.length)
        );

        for (uint256 i = 0; i < prevouts.length; i++) {
            preimage = abi.encodePacked(
                preimage,
                prevouts[i].txid,
                P2TRSignatureFraud.uint32LE(prevouts[i].vout),
                P2TRSignatureFraud.uint64LE(prevouts[i].valueSats),
                P2TRSignatureFraud.bytesWithCompactSize(
                    prevouts[i].scriptPubKey
                )
            );
        }

        return sha256(preimage);
    }
}
