// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal immutable handshake exposed by the current ECDSA fraud
///         router generation.
interface IEcdsaFraudRouterProtocol {
    function bridge() external view returns (address);

    function fraudProtocolID() external view returns (bytes32);

    function openFraudChallengeCount() external view returns (uint256);
}

/// @notice Version identifier and strict validation helpers used while wiring
///         or replacing the stateful ECDSA fraud router.
/// @dev The protocol ID is a compatibility handshake, not a substitute for
///      governance review of the exact deployed bytecode. Exact ABI words are
///      required so absent selectors and permissive fallbacks fail closed.
library EcdsaFraudRouterProtocol {
    bytes32 internal constant CURRENT_V2 =
        keccak256("tbtc/ecdsa-signature-fraud/router/current-v2");

    error EcdsaFraudRouterUnavailable();
    error EcdsaFraudRouterHasOpenChallenges(uint256 openChallengeCount);

    /// @notice Requires the current router protocol, bound to the expected
    ///         Bridge, with no pre-existing open challenge state.
    function requireEmptyCurrentRouter(address router, address expectedBridge)
        internal
        view
    {
        if (router == address(0)) {
            revert EcdsaFraudRouterUnavailable();
        }

        (bool bridgeCallSucceeded, bytes memory bridgeResult) = router
            .staticcall(
                abi.encodeWithSelector(
                    IEcdsaFraudRouterProtocol.bridge.selector
                )
            );
        if (!bridgeCallSucceeded || bridgeResult.length != 32) {
            revert EcdsaFraudRouterUnavailable();
        }

        bytes32 encodedBridge = abi.decode(bridgeResult, (bytes32));
        if (
            uint256(encodedBridge) >> 160 != 0 ||
            address(uint160(uint256(encodedBridge))) != expectedBridge
        ) {
            revert EcdsaFraudRouterUnavailable();
        }

        (bool protocolCallSucceeded, bytes memory protocolResult) = router
            .staticcall(
                abi.encodeWithSelector(
                    IEcdsaFraudRouterProtocol.fraudProtocolID.selector
                )
            );
        if (!protocolCallSucceeded || protocolResult.length != 32) {
            revert EcdsaFraudRouterUnavailable();
        }
        if (abi.decode(protocolResult, (bytes32)) != CURRENT_V2) {
            revert EcdsaFraudRouterUnavailable();
        }

        uint256 openChallengeCount = requireOpenChallengeCount(router);
        if (openChallengeCount != 0) {
            revert EcdsaFraudRouterHasOpenChallenges(openChallengeCount);
        }
    }

    /// @notice Reads the router-wide unresolved challenge count with strict
    ///         return-data validation. This selector exists on both legacy and
    ///         current router generations and is the cutover drain invariant.
    function requireOpenChallengeCount(address router)
        internal
        view
        returns (uint256 openChallengeCount)
    {
        (bool countCallSucceeded, bytes memory countResult) = router.staticcall(
            abi.encodeWithSelector(
                IEcdsaFraudRouterProtocol.openFraudChallengeCount.selector
            )
        );
        if (!countCallSucceeded || countResult.length != 32) {
            revert EcdsaFraudRouterUnavailable();
        }

        openChallengeCount = abi.decode(countResult, (uint256));
    }
}
