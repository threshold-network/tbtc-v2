// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.0;

/// @notice Test-only programmable mock. Answers any call according to a table
///         set up from the test, and records the calls it receives.
///
///         This is the contract half of the replacement for the archived
///         defi-wonderland smock package. smock worked by reaching into
///         Hardhat's provider internals, which is why it broke on Hardhat
///         >= 2.20 and why it cannot be carried forward. Everything here is
///         ordinary EVM state, so it survives any Hardhat, ethers, viem or
///         Foundry change.
///
///         The model is deliberately Foundry's `vm.mockCall`: a
///         calldata-to-returndata table plus call recording. If the suite ever
///         moves to Solidity tests, the semantics carry over unchanged.
///
///         Lookup order for an incoming call, first match wins:
///           1. exact full-calldata match — smock's `whenCalledWith`
///           2. selector match — smock's bare `returns`
///           3. the response of last resort installed by the helper when the
///              mock was created: the zero value of the function's return
///              type, which is how smock answered an unstubbed function
///
///         Reverts are configured the same way and take priority over returns
///         at the same specificity.
///
/// @dev Administrative entry points are prefixed `__mock__` so they are
///      addressable alongside whatever interface is being mocked. A four-byte
///      collision between one of them and a real function of the mocked
///      interface would silently shadow that function, so the TypeScript helper
///      asserts no collision exists at construction time rather than leaving it
///      to chance.
contract MockContract {
    // The `__mock__` prefix namespaces this contract's own entry points away
    // from whatever interface it is answering, which is the point; mixedCase
    // would defeat it.
    // solhint-disable func-name-mixedcase

    enum Behaviour {
        Unset,
        Return,
        Revert
    }

    struct Response {
        Behaviour behaviour;
        bytes data;
    }

    /// @dev keccak256(full calldata) => response.
    mapping(bytes32 => Response) private responseByCalldata;
    /// @dev selector => response.
    mapping(bytes4 => Response) private responseBySelector;

    /// @dev selector => response of last resort, installed once when the mock
    ///      is created and never cleared by `reset`.
    ///
    ///      Solidity checks returndatasize against the size its ABI expects and
    ///      reverts on a short answer, so an unconfigured function cannot
    ///      simply return nothing: it has to return a correctly encoded zero
    ///      value. Only the helper knows the mocked ABI, so it computes those
    ///      encodings and installs them here. That reproduces smock, where an
    ///      unstubbed function yields the zero value of its return type.
    mapping(bytes4 => Response) private baseResponseBySelector;

    /// @dev Keys of every exact-calldata entry configured so far, with the
    ///      selector each belongs to. Exact-calldata entries are keyed by hash
    ///      and so cannot be enumerated from the mapping; `reset` needs to
    ///      clear them, and inferring them from recorded calls would be wrong
    ///      because recording is best-effort (see `__mock__record`).
    bytes32[] private configuredCalldataKeys;
    mapping(bytes32 => bytes4) private selectorOfCalldataKey;
    mapping(bytes32 => bool) private calldataKeyKnown;

    /// @dev Selectors given a default response, for the same reason: a
    ///      selector configured but never called — or only ever called by
    ///      STATICCALL, which is not recorded — must still be cleared by
    ///      `reset`.
    bytes4[] private configuredSelectors;
    mapping(bytes4 => bool) private selectorKnown;

    /// @dev Every call recorded, in order, as raw calldata. Kept whole rather
    ///      than decoded so the helper can decode against whichever ABI the
    ///      test declared.
    bytes[] private receivedCalls;

    /// @notice Configures the response for one exact calldata payload.
    /// @param callData Full ABI-encoded calldata, selector included.
    /// @param returnData ABI-encoded return value. Empty for void functions.
    function __mock__setReturnForCalldata(
        bytes calldata callData,
        bytes calldata returnData
    ) external {
        __mock__rememberCalldataKey(callData);
        responseByCalldata[keccak256(callData)] = Response(
            Behaviour.Return,
            returnData
        );
    }

    /// @notice Configures the default response for a selector, used when no
    ///         exact-calldata entry matches.
    function __mock__setReturnForSelector(
        bytes4 selector,
        bytes calldata returnData
    ) external {
        __mock__rememberSelector(selector);
        responseBySelector[selector] = Response(Behaviour.Return, returnData);
    }

    /// @notice Makes one exact calldata payload revert.
    /// @param revertData Raw revert payload. Empty reverts with no data.
    function __mock__setRevertForCalldata(
        bytes calldata callData,
        bytes calldata revertData
    ) external {
        __mock__rememberCalldataKey(callData);
        responseByCalldata[keccak256(callData)] = Response(
            Behaviour.Revert,
            revertData
        );
    }

    /// @notice Makes every call to a selector revert, unless an exact-calldata
    ///         entry matches first.
    function __mock__setRevertForSelector(
        bytes4 selector,
        bytes calldata revertData
    ) external {
        __mock__rememberSelector(selector);
        responseBySelector[selector] = Response(Behaviour.Revert, revertData);
    }

    /// @notice Clears every response configured for one selector and forgets
    ///         the calls recorded for it. This is smock's `fn.reset()`.
    function __mock__resetSelector(bytes4 selector) external {
        delete responseBySelector[selector];

        uint256 keptKeys = 0;
        uint256 totalKeys = configuredCalldataKeys.length;
        for (uint256 i = 0; i < totalKeys; i++) {
            bytes32 key = configuredCalldataKeys[i];

            if (selectorOfCalldataKey[key] == selector) {
                delete responseByCalldata[key];
                delete selectorOfCalldataKey[key];
                delete calldataKeyKnown[key];
            } else {
                configuredCalldataKeys[keptKeys] = key;
                keptKeys++;
            }
        }
        while (configuredCalldataKeys.length > keptKeys) {
            configuredCalldataKeys.pop();
        }

        uint256 keptCalls = 0;
        uint256 totalCalls = receivedCalls.length;
        for (uint256 i = 0; i < totalCalls; i++) {
            if (__mock__selectorOf(receivedCalls[i]) != selector) {
                receivedCalls[keptCalls] = receivedCalls[i];
                keptCalls++;
            }
        }
        while (receivedCalls.length > keptCalls) {
            receivedCalls.pop();
        }
    }

    /// @notice Clears every configured response and every recorded call.
    function __mock__reset() external {
        uint256 totalKeys = configuredCalldataKeys.length;
        for (uint256 i = 0; i < totalKeys; i++) {
            bytes32 key = configuredCalldataKeys[i];
            delete responseByCalldata[key];
            delete selectorOfCalldataKey[key];
            delete calldataKeyKnown[key];
        }
        delete configuredCalldataKeys;

        uint256 totalSelectors = configuredSelectors.length;
        for (uint256 i = 0; i < totalSelectors; i++) {
            delete responseBySelector[configuredSelectors[i]];
            delete selectorKnown[configuredSelectors[i]];
        }
        delete configuredSelectors;

        delete receivedCalls;
    }

    /// @notice Installs the responses of last resort. Called once by the
    ///         helper at construction with the zero value of every function's
    ///         return type.
    function __mock__setBaseReturns(
        bytes4[] calldata selectors,
        bytes[] calldata returnData
    ) external {
        require(
            selectors.length == returnData.length,
            "MockContract: length mismatch"
        );

        for (uint256 i = 0; i < selectors.length; i++) {
            baseResponseBySelector[selectors[i]] = Response(
                Behaviour.Return,
                returnData[i]
            );
        }
    }

    /// @notice Clears the default response for one selector without touching
    ///         its exact-calldata entries or recorded calls.
    function __mock__clearSelector(bytes4 selector) external {
        delete responseBySelector[selector];
    }

    /// @notice Appends a recorded call. Only ever invoked by this contract, on
    ///         itself, from `fallback`.
    /// @dev Recording is a storage write, so it is impossible when the mocked
    ///      function was reached by STATICCALL — which is what Solidity emits
    ///      for a `view` or `pure` function on the mocked interface. Routing
    ///      the write through an external self-call lets `fallback` attempt it
    ///      and carry on when it fails, so a stubbed view function still
    ///      answers instead of reverting.
    ///
    ///      The cost is that calls to view functions are not recorded, and so
    ///      cannot be asserted on. That is sound for this suite: every call
    ///      assertion in it targets a state-changing function, and a `view`
    ///      that a test wanted to count could not have been reached by
    ///      STATICCALL in the first place.
    function __mock__record(bytes calldata callData) external {
        require(
            msg.sender == address(this),
            "MockContract: recording is internal"
        );
        receivedCalls.push(callData);
    }

    /// @notice Number of calls recorded, across all selectors.
    function __mock__callCount() external view returns (uint256) {
        return receivedCalls.length;
    }

    /// @notice Raw calldata of the i-th call recorded, across all selectors.
    function __mock__callAt(uint256 index)
        external
        view
        returns (bytes memory)
    {
        return receivedCalls[index];
    }

    /// @notice Number of calls recorded for one selector.
    function __mock__callCountForSelector(bytes4 selector)
        external
        view
        returns (uint256 count)
    {
        uint256 total = receivedCalls.length;
        for (uint256 i = 0; i < total; i++) {
            if (__mock__selectorOf(receivedCalls[i]) == selector) {
                count++;
            }
        }
    }

    /// @notice Raw calldata of the i-th call recorded for one selector.
    function __mock__callForSelectorAt(bytes4 selector, uint256 index)
        external
        view
        returns (bytes memory)
    {
        uint256 seen = 0;
        uint256 total = receivedCalls.length;

        for (uint256 i = 0; i < total; i++) {
            if (__mock__selectorOf(receivedCalls[i]) == selector) {
                if (seen == index) {
                    return receivedCalls[i];
                }
                seen++;
            }
        }

        revert("MockContract: call index out of range");
    }

    /// @dev Leading four bytes of `callData`, or zero if it is shorter.
    function __mock__selectorOf(bytes memory callData)
        public
        pure
        returns (bytes4 selector)
    {
        if (callData.length < 4) {
            return bytes4(0);
        }

        // solhint-disable-next-line no-inline-assembly
        assembly {
            selector := mload(add(callData, 32))
        }
    }

    // A typed `fallback(bytes calldata) returns (bytes memory)` would read
    // better, but prettier-plugin-solidity silently rewrites it to
    // `fallback() external payable`, dropping the parameter and the return
    // type — a formatter quietly changing semantics. Reading msg.data and
    // returning through assembly is immune to that.
    // solhint-disable-next-line no-complex-fallback
    fallback() external payable {
        // Best-effort: silently skipped under STATICCALL. See `__mock__record`.
        // solhint-disable-next-line no-empty-blocks
        try this.__mock__record(msg.data) {} catch {}

        bytes memory result = __mock__responseFor(msg.data);

        // solhint-disable-next-line no-inline-assembly
        assembly {
            return(add(result, 32), mload(result))
        }
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}

    /// @dev Resolves an incoming call against the three layers, most specific
    ///      first. Reverts here if the matched response is a configured revert.
    function __mock__responseFor(bytes memory callData)
        private
        view
        returns (bytes memory)
    {
        Response storage exact = responseByCalldata[keccak256(callData)];
        if (exact.behaviour != Behaviour.Unset) {
            return __mock__respond(exact);
        }

        bytes4 selector = __mock__selectorOf(callData);

        Response storage bySelector = responseBySelector[selector];
        if (bySelector.behaviour != Behaviour.Unset) {
            return __mock__respond(bySelector);
        }

        Response storage base = baseResponseBySelector[selector];
        if (base.behaviour != Behaviour.Unset) {
            return __mock__respond(base);
        }

        return "";
    }

    function __mock__rememberSelector(bytes4 selector) private {
        if (!selectorKnown[selector]) {
            selectorKnown[selector] = true;
            configuredSelectors.push(selector);
        }
    }

    function __mock__rememberCalldataKey(bytes calldata callData) private {
        bytes32 key = keccak256(callData);

        if (!calldataKeyKnown[key]) {
            calldataKeyKnown[key] = true;
            selectorOfCalldataKey[key] = __mock__selectorOf(callData);
            configuredCalldataKeys.push(key);
        }
    }

    function __mock__respond(Response storage response)
        private
        view
        returns (bytes memory)
    {
        if (response.behaviour == Behaviour.Revert) {
            bytes memory revertData = response.data;

            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(revertData, 32), mload(revertData))
            }
        }

        return response.data;
    }
}
