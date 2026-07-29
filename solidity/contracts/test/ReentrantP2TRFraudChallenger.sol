// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

interface IP2TRFraudRouterForReentrancyTest {
    function processP2TRSignatureFraudChallenge(
        uint8 action,
        bytes calldata payload,
        uint32[] calldata walletMembersIDs
    ) external payable;
}

interface IBridgeForP2TRFraudReentrancyTest {
    function notifyWalletClosingPeriodElapsed(bytes20 walletPubKeyHash)
        external;
}

contract ReentrantP2TRFraudChallenger {
    IP2TRFraudRouterForReentrancyTest public immutable fraudRouter;
    IBridgeForP2TRFraudReentrancyTest public immutable bridge;
    bytes20 public immutable walletPubKeyHash;

    event ReentrantClosureAttempt(bool succeeded, bytes4 revertSelector);

    constructor(
        address _fraudRouter,
        address _bridge,
        bytes20 _walletPubKeyHash
    ) {
        fraudRouter = IP2TRFraudRouterForReentrancyTest(_fraudRouter);
        bridge = IBridgeForP2TRFraudReentrancyTest(_bridge);
        walletPubKeyHash = _walletPubKeyHash;
    }

    receive() external payable {
        /* solhint-disable avoid-low-level-calls */
        (bool succeeded, bytes memory returnData) = address(bridge).call(
            abi.encodeWithSelector(
                bridge.notifyWalletClosingPeriodElapsed.selector,
                walletPubKeyHash
            )
        );
        /* solhint-enable avoid-low-level-calls */

        bytes4 revertSelector;
        if (returnData.length >= 4) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revertSelector := mload(add(returnData, 32))
            }
        }

        emit ReentrantClosureAttempt(succeeded, revertSelector);
    }

    function submitFraudChallenge(bytes calldata payload) external payable {
        fraudRouter.processP2TRSignatureFraudChallenge{value: msg.value}(
            0,
            payload,
            new uint32[](0)
        );
    }
}
