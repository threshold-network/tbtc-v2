// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal handshake required before Bridge may activate FROST custody.
interface IP2TRFraudEvidenceProtocol {
    function bridge() external view returns (address);

    function evidenceProtocolID() external view returns (bytes32);

    function authorizationRegistry() external view returns (address);

    function preauthorizationProtocolID() external view returns (bytes32);

    function signingPolicyHash() external view returns (bytes32);

    function openFraudChallengeCount() external view returns (uint256);

    function totalChallengeEscrow() external view returns (uint256);

    function totalWithdrawablePayouts() external view returns (uint256);
}

interface IP2TRFraudAuthorizationRegistryHandshake {
    function bridge() external view returns (address);

    function domainChainID() external view returns (uint256);

    function reservationProtocolID() external view returns (bytes32);

    function signingPolicyHash() external view returns (bytes32);

    function frostRegistry() external view returns (address);

    function activeReservationCount() external view returns (uint256);

    function activeReservationSetVersion() external view returns (uint256);

    function authorizedChallengeIdentityCount() external view returns (uint256);
}

/// @notice Version identifiers and strict handshake for P2TR signature-fraud
///         evidence protocols.
/// @dev BOUNDED_V1 reconstructs full BIP-341 sighashes subject to finite
///      transaction-shape limits. It is useful for verification and testing,
///      but cannot safely protect FROST custody because a valid Bitcoin
///      transaction can exceed those limits. COMPLETE_V2 is reserved for a
///      reviewed protocol that can adjudicate every BIP-340 signed 32-byte
///      message without decoding an unbounded Bitcoin transaction on Ethereum.
///
///      COMPLETE_V2 uses a protocol-approved digest allowlist, not an
///      after-the-fact claim about which witness was mined. A challenge proves
///      a signature over a raw message under either the FROST group key or a
///      deposit key bound to that group at reveal. Only Bridge proof paths may
///      authorize a digest, and only after their normal SPV and protocol checks
///      succeed. Those paths derive the exact annex-free SIGHASH_DEFAULT digest
///      from the SPV-proven stripped transaction and authoritative input
///      values/scripts held in Bridge state. Timeout rechecks the immutable
///      allowlist atomically before slashing. All other modes and off-chain
///      messages are fraud except the strict base-key heartbeat format.
///
///      This construction does not need a witness proof: BIP-340 authenticates
///      the challenged digest, while the accepted-context registry defines the
///      protocol authorization independently of mutable witness encodings. It
///      also avoids the unsound txid-only shortcut, since a txid by itself does
///      not authorize any digest.
///
///      The protocol ID is a compatibility handshake, not a security
///      certification. Governance must separately review the router bytecode,
///      immutability, and evidence construction before activating custody.
library P2TRFraudEvidenceProtocol {
    bytes32 internal constant BOUNDED_V1 =
        keccak256("tbtc/p2tr-signature-fraud/evidence/bounded-v1");
    bytes32 internal constant COMPLETE_V2 =
        keccak256("tbtc/p2tr-signature-fraud/evidence/complete-v2");
    bytes32 internal constant THRESHOLD_RESERVATION_V1 =
        keccak256("tbtc/p2tr-pre-signing-reservation/threshold-v1");
    bytes32 internal constant SIGNING_POLICY_V1 =
        keccak256("tbtc/p2tr-pre-signing-policy/default-no-annex-51-seats-v1");

    error P2TRFraudEvidenceUnavailable();

    /// @notice Requires an exact COMPLETE_V2 handshake bound to the expected
    ///         Bridge address, checking wiring and policy only.
    /// @dev Absent, reverting, malformed, wrong-Bridge, and bounded routers all
    ///      fail closed with the same error. Exact 32-byte ABI words are
    ///      required so fallback data cannot accidentally satisfy the check.
    ///
    ///      This deliberately excludes the router/registry accounting counters.
    ///      Those are monotonic once custody is live, so they are a valid
    ///      freshness gate when INSTALLING a router but are not an invariant
    ///      any later call can satisfy. Hot paths must use this function; only
    ///      the one-time installer may use `requireCompleteRouter`.
    /// @return registry The authorization registry bound to `router`.
    function requireCompleteRouterWiring(
        address router,
        address expectedBridge,
        address expectedFrostRegistry
    ) internal view returns (address registry) {
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

        registry = _readAddress(
            router,
            IP2TRFraudEvidenceProtocol.authorizationRegistry.selector
        );
        if (registry == address(0)) {
            revert P2TRFraudEvidenceUnavailable();
        }
        if (
            _readBytes32(
                router,
                IP2TRFraudEvidenceProtocol.preauthorizationProtocolID.selector
            ) !=
            THRESHOLD_RESERVATION_V1 ||
            _readBytes32(
                router,
                IP2TRFraudEvidenceProtocol.signingPolicyHash.selector
            ) !=
            SIGNING_POLICY_V1 ||
            _readAddress(
                registry,
                IP2TRFraudAuthorizationRegistryHandshake.bridge.selector
            ) !=
            expectedBridge ||
            _readAddress(
                registry,
                IP2TRFraudAuthorizationRegistryHandshake.frostRegistry.selector
            ) !=
            expectedFrostRegistry ||
            _readUint256(
                registry,
                IP2TRFraudAuthorizationRegistryHandshake.domainChainID.selector
            ) !=
            block.chainid ||
            _readBytes32(
                registry,
                IP2TRFraudAuthorizationRegistryHandshake
                    .reservationProtocolID
                    .selector
            ) !=
            THRESHOLD_RESERVATION_V1 ||
            _readBytes32(
                registry,
                IP2TRFraudAuthorizationRegistryHandshake
                    .signingPolicyHash
                    .selector
            ) !=
            SIGNING_POLICY_V1
        ) {
            revert P2TRFraudEvidenceUnavailable();
        }
    }

    /// @notice Requires an exact COMPLETE_V2 handshake AND a router whose
    ///         accounting is still pristine.
    /// @dev Install-time only. `activeReservationSetVersion` and
    ///      `authorizedChallengeIdentityCount` are strictly monotonic and are
    ///      never reset, and `activeReservationCount`,
    ///      `openFraudChallengeCount`, `totalChallengeEscrow` and
    ///      `totalWithdrawablePayouts` are non-zero during entirely normal
    ///      operation. Calling this on a hot path would therefore revert
    ///      permanently after the first pre-signing ceremony. Use
    ///      `requireCompleteRouterWiring` there instead.
    function requireCompleteRouter(
        address router,
        address expectedBridge,
        address expectedFrostRegistry
    ) internal view {
        address registry = requireCompleteRouterWiring(
            router,
            expectedBridge,
            expectedFrostRegistry
        );
        if (
            _readUint256(
                router,
                IP2TRFraudEvidenceProtocol.openFraudChallengeCount.selector
            ) !=
            0 ||
            _readUint256(
                router,
                IP2TRFraudEvidenceProtocol.totalChallengeEscrow.selector
            ) !=
            0 ||
            _readUint256(
                router,
                IP2TRFraudEvidenceProtocol.totalWithdrawablePayouts.selector
            ) !=
            0 ||
            _readUint256(
                registry,
                IP2TRFraudAuthorizationRegistryHandshake
                    .activeReservationCount
                    .selector
            ) !=
            0 ||
            _readUint256(
                registry,
                IP2TRFraudAuthorizationRegistryHandshake
                    .activeReservationSetVersion
                    .selector
            ) !=
            0 ||
            _readUint256(
                registry,
                IP2TRFraudAuthorizationRegistryHandshake
                    .authorizedChallengeIdentityCount
                    .selector
            ) !=
            0
        ) {
            revert P2TRFraudEvidenceUnavailable();
        }
    }

    function _readAddress(address target, bytes4 selector)
        private
        view
        returns (address result)
    {
        (bool succeeded, bytes memory data) = target.staticcall(
            abi.encodeWithSelector(selector)
        );
        if (!succeeded || data.length != 32) {
            revert P2TRFraudEvidenceUnavailable();
        }
        bytes32 encoded = abi.decode(data, (bytes32));
        if (uint256(encoded) >> 160 != 0) {
            revert P2TRFraudEvidenceUnavailable();
        }
        result = address(uint160(uint256(encoded)));
    }

    function _readBytes32(address target, bytes4 selector)
        private
        view
        returns (bytes32 result)
    {
        (bool succeeded, bytes memory data) = target.staticcall(
            abi.encodeWithSelector(selector)
        );
        if (!succeeded || data.length != 32) {
            revert P2TRFraudEvidenceUnavailable();
        }
        result = abi.decode(data, (bytes32));
    }

    function _readUint256(address target, bytes4 selector)
        private
        view
        returns (uint256 result)
    {
        (bool succeeded, bytes memory data) = target.staticcall(
            abi.encodeWithSelector(selector)
        );
        if (!succeeded || data.length != 32) {
            revert P2TRFraudEvidenceUnavailable();
        }
        result = abi.decode(data, (uint256));
    }
}
