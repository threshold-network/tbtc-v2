// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal immutable handshake exposed by the current ECDSA fraud
///         router generation.
interface IEcdsaFraudRouterProtocol {
    function bridge() external view returns (address);

    function fraudProtocolID() external view returns (bytes32);

    function openFraudChallengeCount() external view returns (uint256);

    function openFraudChallengeEscrow() external view returns (uint256);

    function predecessor() external view returns (address);

    function predecessorCodeHash() external view returns (bytes32);

    function ancestryDepth() external view returns (uint8);
}

/// @notice Version identifier and strict validation helpers used while wiring
///         or replacing the stateful ECDSA fraud router.
/// @dev The protocol ID is a compatibility handshake, not a substitute for
///      governance review of the exact deployed bytecode. Exact ABI words are
///      required so absent selectors and permissive fallbacks fail closed.
library EcdsaFraudRouterProtocol {
    uint256 internal constant MAX_ANCESTRY_DEPTH = 8;
    bytes32 internal constant CURRENT_V2 =
        keccak256("tbtc/ecdsa-signature-fraud/router/current-v2");
    bytes32 internal constant CURRENT_V3 =
        keccak256("tbtc/ecdsa-signature-fraud/router/current-v3");

    error EcdsaFraudRouterUnavailable();
    error EcdsaFraudRouterHasOpenChallenges(uint256 openChallengeCount);
    error EcdsaFraudRouterUnexpectedOpenChallengeCount(
        uint256 expectedOpenChallengeCount,
        uint256 actualOpenChallengeCount
    );
    error EcdsaFraudRouterCodeHashZero();
    error EcdsaFraudRouterCodeHashMismatch(
        address router,
        bytes32 expectedCodeHash,
        bytes32 actualCodeHash
    );
    error EcdsaFraudRouterPredecessorMismatch(
        address expectedPredecessor,
        address actualPredecessor
    );
    error EcdsaFraudRouterAncestryInvalid(address router);
    error EcdsaFraudRouterAncestryTooDeep(uint256 ancestryDepth);
    error EcdsaFraudRouterAncestryHasOpenChallenges(
        address router,
        uint256 openChallengeCount,
        uint256 openChallengeEscrow
    );

    /// @notice Enforces governance's exact runtime-bytecode approval.
    function requireCodeHash(address router, bytes32 expectedCodeHash)
        internal
        view
    {
        if (expectedCodeHash == bytes32(0)) {
            revert EcdsaFraudRouterCodeHashZero();
        }

        bytes32 actualCodeHash = router.codehash;
        if (actualCodeHash != expectedCodeHash) {
            revert EcdsaFraudRouterCodeHashMismatch(
                router,
                expectedCodeHash,
                actualCodeHash
            );
        }
    }

    /// @notice Requires the current router protocol, bound to the expected
    ///         Bridge, with no pre-existing open challenge state.
    function requireEmptyCurrentRouter(
        address router,
        address expectedBridge,
        bytes32 expectedCodeHash,
        address expectedPredecessor
    ) internal view {
        requireCurrentRouter(
            router,
            expectedBridge,
            expectedCodeHash,
            expectedPredecessor
        );

        requireEmptyAncestry(router);
    }

    /// @notice Requires the current router protocol and immutable Bridge
    ///         binding without imposing an open-challenge count.
    function requireCurrentRouter(
        address router,
        address expectedBridge,
        bytes32 expectedCodeHash,
        address expectedPredecessor
    ) internal view {
        if (router == address(0)) {
            revert EcdsaFraudRouterUnavailable();
        }

        requireCodeHash(router, expectedCodeHash);

        if (
            _readAddress(router, IEcdsaFraudRouterProtocol.bridge.selector) !=
            expectedBridge
        ) {
            revert EcdsaFraudRouterUnavailable();
        }
        if (
            _readBytes32(
                router,
                IEcdsaFraudRouterProtocol.fraudProtocolID.selector
            ) != CURRENT_V3
        ) {
            revert EcdsaFraudRouterUnavailable();
        }
        address actualPredecessor = _readAddress(
            router,
            IEcdsaFraudRouterProtocol.predecessor.selector
        );
        if (actualPredecessor != expectedPredecessor) {
            revert EcdsaFraudRouterPredecessorMismatch(
                expectedPredecessor,
                actualPredecessor
            );
        }
        uint256 ancestryDepth = uint256(
            _readBytes32(
                router,
                IEcdsaFraudRouterProtocol.ancestryDepth.selector
            )
        );
        if (ancestryDepth > MAX_ANCESTRY_DEPTH) {
            revert EcdsaFraudRouterAncestryTooDeep(ancestryDepth);
        }
        _requireBoundedAncestry(
            router,
            expectedBridge,
            expectedPredecessor,
            ancestryDepth
        );
    }

    function _readBytes32(address target, bytes4 selector)
        private
        view
        returns (bytes32 result)
    {
        (bool succeeded, bytes memory returnData) = target.staticcall(
            abi.encodeWithSelector(selector)
        );
        if (!succeeded || returnData.length != 32) {
            revert EcdsaFraudRouterUnavailable();
        }
        result = abi.decode(returnData, (bytes32));
    }

    function _readAddress(address target, bytes4 selector)
        private
        view
        returns (address result)
    {
        bytes32 encoded = _readBytes32(target, selector);
        if (uint256(encoded) >> 160 != 0) {
            revert EcdsaFraudRouterUnavailable();
        }
        result = address(uint160(uint256(encoded)));
    }

    function _requireBoundedAncestry(
        address router,
        address expectedBridge,
        address expectedPredecessor,
        uint256 expectedDepth
    ) private view {
        address[MAX_ANCESTRY_DEPTH + 1] memory seen;
        address cursor = router;

        for (uint256 i = 0; i <= MAX_ANCESTRY_DEPTH; i++) {
            if (cursor == address(0) || cursor.code.length == 0) {
                revert EcdsaFraudRouterAncestryInvalid(cursor);
            }
            for (uint256 j = 0; j < i; j++) {
                if (seen[j] == cursor) {
                    revert EcdsaFraudRouterAncestryInvalid(cursor);
                }
            }
            seen[i] = cursor;

            if (
                _readAncestryAddress(
                    cursor,
                    IEcdsaFraudRouterProtocol.bridge.selector
                ) != expectedBridge
            ) {
                revert EcdsaFraudRouterAncestryInvalid(cursor);
            }

            bytes32 protocolID = _readAncestryWord(
                cursor,
                IEcdsaFraudRouterProtocol.fraudProtocolID.selector
            );

            (bool depthCallSucceeded, bytes memory depthResult) = cursor
                .staticcall(
                    abi.encodeWithSelector(
                        IEcdsaFraudRouterProtocol.ancestryDepth.selector
                    )
                );
            if (!depthCallSucceeded) {
                if (depthResult.length != 0 || i == 0 || expectedDepth != 0) {
                    revert EcdsaFraudRouterAncestryInvalid(cursor);
                }
                if (protocolID != CURRENT_V2) {
                    revert EcdsaFraudRouterAncestryInvalid(cursor);
                }
                (bool legacyCallSucceeded, bytes memory legacyResult) = cursor
                    .staticcall(
                        abi.encodeWithSignature("fraudChallenges(uint256)", 0)
                    );
                if (!legacyCallSucceeded || legacyResult.length != 128) {
                    revert EcdsaFraudRouterAncestryInvalid(cursor);
                }
                return;
            }
            if (
                protocolID != CURRENT_V3 ||
                depthResult.length != 32 ||
                abi.decode(depthResult, (uint256)) != expectedDepth
            ) {
                revert EcdsaFraudRouterAncestryInvalid(cursor);
            }

            address cursorPredecessor = _readAncestryAddress(
                cursor,
                IEcdsaFraudRouterProtocol.predecessor.selector
            );
            bytes32 pinnedPredecessorCodeHash = _readAncestryWord(
                cursor,
                IEcdsaFraudRouterProtocol.predecessorCodeHash.selector
            );
            if (i == 0 && cursorPredecessor != expectedPredecessor) {
                revert EcdsaFraudRouterPredecessorMismatch(
                    expectedPredecessor,
                    cursorPredecessor
                );
            }
            if (expectedDepth == 0) {
                if (
                    cursorPredecessor != address(0) ||
                    pinnedPredecessorCodeHash != bytes32(0)
                ) {
                    revert EcdsaFraudRouterAncestryInvalid(cursor);
                }
                return;
            }
            if (
                cursorPredecessor == address(0) ||
                pinnedPredecessorCodeHash == bytes32(0) ||
                cursorPredecessor.codehash != pinnedPredecessorCodeHash
            ) {
                revert EcdsaFraudRouterAncestryInvalid(cursor);
            }
            cursor = cursorPredecessor;
            expectedDepth--;
        }

        revert EcdsaFraudRouterAncestryTooDeep(expectedDepth);
    }

    function _readAncestryWord(address router, bytes4 selector)
        private
        view
        returns (bytes32 result)
    {
        (bool succeeded, bytes memory returnData) = router.staticcall(
            abi.encodeWithSelector(selector)
        );
        if (!succeeded || returnData.length != 32) {
            revert EcdsaFraudRouterAncestryInvalid(router);
        }
        result = abi.decode(returnData, (bytes32));
    }

    function _readAncestryAddress(address router, bytes4 selector)
        private
        view
        returns (address result)
    {
        bytes32 encoded = _readAncestryWord(router, selector);
        if (uint256(encoded) >> 160 != 0) {
            revert EcdsaFraudRouterAncestryInvalid(router);
        }
        result = address(uint160(uint256(encoded)));
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

    /// @notice Requires every router in a previously validated ancestry to
    ///         have no unresolved challenge state. Current routers expose an
    ///         exact escrow counter. The terminal v2 generation predates that
    ///         counter, so its zero unresolved count is the authoritative
    ///         escrow invariant.
    /// @dev Call only after `requireCurrentRouter`, which pins every link's
    ///      runtime code hash, protocol generation, depth, and predecessor.
    function requireEmptyAncestry(address router) internal view {
        address cursor = router;

        for (uint256 i = 0; i <= MAX_ANCESTRY_DEPTH; i++) {
            bytes32 protocolID = _readBytes32(
                cursor,
                IEcdsaFraudRouterProtocol.fraudProtocolID.selector
            );
            uint256 openChallengeCount = requireOpenChallengeCount(cursor);
            uint256 openChallengeEscrow;

            if (protocolID == CURRENT_V3) {
                openChallengeEscrow = uint256(
                    _readBytes32(
                        cursor,
                        IEcdsaFraudRouterProtocol
                            .openFraudChallengeEscrow
                            .selector
                    )
                );
            } else if (protocolID == CURRENT_V2) {
                (bool escrowCallSucceeded, bytes memory escrowResult) = cursor
                    .staticcall(
                        abi.encodeWithSelector(
                            IEcdsaFraudRouterProtocol
                                .openFraudChallengeEscrow
                                .selector
                        )
                    );
                if (escrowCallSucceeded) {
                    if (escrowResult.length != 32) {
                        revert EcdsaFraudRouterAncestryInvalid(cursor);
                    }
                    openChallengeEscrow = abi.decode(escrowResult, (uint256));
                } else if (escrowResult.length != 0) {
                    revert EcdsaFraudRouterAncestryInvalid(cursor);
                }
            } else {
                revert EcdsaFraudRouterAncestryInvalid(cursor);
            }

            if (openChallengeCount != 0 || openChallengeEscrow != 0) {
                revert EcdsaFraudRouterAncestryHasOpenChallenges(
                    cursor,
                    openChallengeCount,
                    openChallengeEscrow
                );
            }

            if (protocolID == CURRENT_V2) {
                return;
            }

            address cursorPredecessor = _readAddress(
                cursor,
                IEcdsaFraudRouterProtocol.predecessor.selector
            );
            if (cursorPredecessor == address(0)) {
                return;
            }
            cursor = cursorPredecessor;
        }

        revert EcdsaFraudRouterAncestryTooDeep(MAX_ANCESTRY_DEPTH + 1);
    }
}
