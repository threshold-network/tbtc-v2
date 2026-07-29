// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal handshake required before Bridge may activate FROST custody.
interface IP2TRFraudEvidenceProtocol {
    function bridge() external view returns (address);

    function evidenceProtocolID() external view returns (bytes32);
}

/// @notice Version identifiers and strict handshake for P2TR signature-fraud
///         evidence protocols.
/// @dev BOUNDED_V1 reconstructs full BIP-341 sighashes subject to finite
///      transaction-shape limits. It is useful for verification and testing,
///      but cannot safely protect FROST custody because a valid Bitcoin
///      transaction can exceed those limits. COMPLETE_V2 is reserved for a
///      future, reviewed protocol that can adjudicate every valid wallet spend
///      shape and correlate an accepted spend with the exact BIP-341
///      authorization being challenged. That correlation must authenticate
///      witness data through a wtxid proof anchored in the BIP-141 witness
///      commitment, and separately authenticate authoritative prevout
///      values/scripts through trusted Bridge state or Bitcoin UTXO evidence.
///      It must also bind the signed outpoint to the wallet and map every
///      accepted representation/sighash mode to the challenged authorization.
///      A txid alone is insufficient because it commits neither witness/annex
///      data nor the prevout data used by the Taproot sighash.
///
///      The protocol ID is a compatibility handshake, not a security
///      certification. Governance must separately review the router bytecode,
///      immutability, and evidence construction before activating custody.
library P2TRFraudEvidenceProtocol {
    bytes32 internal constant BOUNDED_V1 =
        keccak256("tbtc/p2tr-signature-fraud/evidence/bounded-v1");
    bytes32 internal constant COMPLETE_V2 =
        keccak256("tbtc/p2tr-signature-fraud/evidence/complete-v2");

    error P2TRFraudEvidenceUnavailable();

    /// @notice Requires an exact COMPLETE_V2 handshake bound to the expected
    ///         Bridge address.
    /// @dev Absent, reverting, malformed, wrong-Bridge, and bounded routers all
    ///      fail closed with the same error. Exact 32-byte ABI words are
    ///      required so fallback data cannot accidentally satisfy the check.
    function requireCompleteRouter(address router, address expectedBridge)
        internal
        view
    {
        if (router == address(0)) {
            revert P2TRFraudEvidenceUnavailable();
        }

        (bool bridgeCallSucceeded, bytes memory bridgeResult) = router
            .staticcall(
                abi.encodeWithSelector(
                    IP2TRFraudEvidenceProtocol.bridge.selector
                )
            );
        if (!bridgeCallSucceeded || bridgeResult.length != 32) {
            revert P2TRFraudEvidenceUnavailable();
        }

        bytes32 encodedBridge = abi.decode(bridgeResult, (bytes32));
        if (
            uint256(encodedBridge) >> 160 != 0 ||
            address(uint160(uint256(encodedBridge))) != expectedBridge
        ) {
            revert P2TRFraudEvidenceUnavailable();
        }

        (bool protocolCallSucceeded, bytes memory protocolResult) = router
            .staticcall(
                abi.encodeWithSelector(
                    IP2TRFraudEvidenceProtocol.evidenceProtocolID.selector
                )
            );
        if (!protocolCallSucceeded || protocolResult.length != 32) {
            revert P2TRFraudEvidenceUnavailable();
        }

        if (abi.decode(protocolResult, (bytes32)) != COMPLETE_V2) {
            revert P2TRFraudEvidenceUnavailable();
        }
    }
}
