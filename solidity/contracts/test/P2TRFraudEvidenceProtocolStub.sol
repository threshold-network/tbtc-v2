// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/P2TRFraudEvidenceProtocol.sol";
import "../bridge/P2TRSignatureFraudRouter.sol";

/// @notice Handshake-only test stub advertising the reserved future protocol.
/// @dev This is not a functional COMPLETE_V2 implementation and must never be
///      deployed as custody protection. It only lets tests exercise Bridge's
///      strict request/callback compatibility gate.
contract HandshakeOnlyCompleteP2TRSignatureFraudRouterStub is
    P2TRSignatureFraudRouter
{
    constructor(address bridgeAddress)
        P2TRSignatureFraudRouter(bridgeAddress)
    {}

    function evidenceProtocolID() public pure override returns (bytes32) {
        return P2TRFraudEvidenceProtocol.COMPLETE_V2;
    }
}

/// @notice Configurable handshake stub for activation-gate tests.
contract P2TRFraudEvidenceProtocolStub {
    address public immutable bridge;
    bytes32 public immutable evidenceProtocolID;

    constructor(address bridgeAddress, bytes32 protocolID) {
        bridge = bridgeAddress;
        evidenceProtocolID = protocolID;
    }
}

/// @notice Returns a truncated protocol word to prove strict ABI validation.
contract MalformedP2TRFraudEvidenceProtocolStub {
    address public immutable bridge;

    constructor(address bridgeAddress) {
        bridge = bridgeAddress;
    }

    function evidenceProtocolID() external pure {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(0, 0)
            return(0, 31)
        }
    }
}
