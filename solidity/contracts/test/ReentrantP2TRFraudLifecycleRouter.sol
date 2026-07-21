// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/IBridgeLifecycleRouter.sol";

/// @notice Test-only lifecycle router that attempts to reenter the COMPLETE
///         fraud timeout while handling a Bridge seize callback.
contract ReentrantP2TRFraudLifecycleRouter is IBridgeLifecycleRouter {
    address public immutable bridge;
    address public immutable fraudRouter;

    bytes private reentryData;

    uint256 public seizeCalls;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    modifier onlyBridge() {
        require(msg.sender == bridge, "Caller is not Bridge");
        _;
    }

    constructor(address _bridge, address _fraudRouter) {
        bridge = _bridge;
        fraudRouter = _fraudRouter;
    }

    function configureReentry(bytes calldata data) external {
        reentryData = data;
    }

    function closeWallet(bytes20) external onlyBridge {}

    function seize(
        bytes20,
        uint96,
        uint32,
        address,
        uint32[] calldata
    ) external onlyBridge {
        seizeCalls++;
        reentryAttempted = true;
        // solhint-disable-next-line avoid-low-level-calls
        (reentrySucceeded, ) = fraudRouter.call(reentryData);
    }

    function isWalletMember(
        bytes20,
        uint32[] calldata,
        address,
        uint256
    ) external pure returns (bool) {
        return false;
    }
}
