// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/P2TRFraudEvidenceProtocol.sol";

/// @notice Test-only registry that satisfies the full COMPLETE_V2 handshake
///         wiring while letting tests drive the accounting counters directly.
/// @dev The production registry's `activeReservationSetVersion` and
///      `authorizedChallengeIdentityCount` are strictly monotonic and are never
///      reset, and `activeReservationCount` is non-zero whenever a wallet is
///      mid-signing. Modeling them explicitly is what lets tests distinguish a
///      router that is correctly WIRED from a router whose accounting is still
///      pristine.
contract CompleteP2TRHandshakeRegistryStub {
    address public immutable bridge;
    address public immutable frostRegistry;
    uint256 public immutable domainChainID;

    uint256 public activeReservationCount;
    uint256 public activeReservationSetVersion;
    uint256 public authorizedChallengeIdentityCount;

    constructor(address bridgeAddress, address frostRegistryAddress) {
        bridge = bridgeAddress;
        frostRegistry = frostRegistryAddress;
        domainChainID = block.chainid;
    }

    /// @notice Models one completed pre-signing ceremony.
    /// @dev Mirrors P2TRAuthorizationRegistry: `_registerAuthorizations`
    ///      increments the authorization count and `_storeReservation`
    ///      increments the reservation set version. Neither ever decreases.
    function recordPreSigningCeremony() external {
        authorizedChallengeIdentityCount++;
        activeReservationSetVersion++;
    }

    function setActiveReservationCount(uint256 value) external {
        activeReservationCount = value;
    }

    function reservationProtocolID() external pure returns (bytes32) {
        return P2TRFraudEvidenceProtocol.THRESHOLD_RESERVATION_V1;
    }

    function signingPolicyHash() external pure returns (bytes32) {
        return P2TRFraudEvidenceProtocol.SIGNING_POLICY_V1;
    }
}

/// @notice Test-only router that satisfies the full COMPLETE_V2 handshake
///         wiring while letting tests drive the router-side counters.
contract CompleteP2TRHandshakeRouterStub {
    address public immutable bridge;
    address public immutable authorizationRegistry;

    uint256 public openFraudChallengeCount;
    uint256 public totalChallengeEscrow;
    uint256 public totalWithdrawablePayouts;

    constructor(address bridgeAddress, address registryAddress) {
        bridge = bridgeAddress;
        authorizationRegistry = registryAddress;
    }

    function setOpenFraudChallengeCount(uint256 value) external {
        openFraudChallengeCount = value;
    }

    function setTotalChallengeEscrow(uint256 value) external {
        totalChallengeEscrow = value;
    }

    function setTotalWithdrawablePayouts(uint256 value) external {
        totalWithdrawablePayouts = value;
    }

    function evidenceProtocolID() external pure returns (bytes32) {
        return P2TRFraudEvidenceProtocol.COMPLETE_V2;
    }

    function preauthorizationProtocolID() external pure returns (bytes32) {
        return P2TRFraudEvidenceProtocol.THRESHOLD_RESERVATION_V1;
    }

    function signingPolicyHash() external pure returns (bytes32) {
        return P2TRFraudEvidenceProtocol.SIGNING_POLICY_V1;
    }
}

/// @notice Exposes both handshake helpers so tests can assert that the
///         wiring-only gate and the install-time gate diverge exactly on the
///         accounting counters.
contract P2TRFraudEvidenceHandshakeHarness {
    function checkWiring(
        address router,
        address expectedBridge,
        address expectedFrostRegistry
    ) external view returns (address registry) {
        return
            P2TRFraudEvidenceProtocol.requireCompleteRouterWiring(
                router,
                expectedBridge,
                expectedFrostRegistry
            );
    }

    function checkInstall(
        address router,
        address expectedBridge,
        address expectedFrostRegistry
    ) external view {
        P2TRFraudEvidenceProtocol.requireCompleteRouter(
            router,
            expectedBridge,
            expectedFrostRegistry
        );
    }
}
