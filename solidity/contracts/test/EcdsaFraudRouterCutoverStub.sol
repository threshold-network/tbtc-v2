// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

interface IBridgeForEcdsaFraudRouterCutoverTest {
    function fraudParameters()
        external
        view
        returns (
            uint96 fraudChallengeDepositAmount,
            uint32 fraudChallengeDefeatTimeout,
            uint96 fraudSlashingAmount,
            uint32 fraudNotifierRewardMultiplier
        );

    function notifyWalletClosingPeriodElapsed(bytes20 walletPubKeyHash)
        external;
}

/// @notice Configurable handshake used to exercise fail-closed router
///         validation without depending on a particular implementation.
contract EcdsaFraudRouterCutoverStub {
    address public immutable bridge;
    bytes32 public immutable fraudProtocolID;
    uint256 public openFraudChallengeCount;

    constructor(
        address _bridge,
        bytes32 _fraudProtocolID,
        uint256 _openFraudChallengeCount
    ) {
        bridge = _bridge;
        fraudProtocolID = _fraudProtocolID;
        openFraudChallengeCount = _openFraudChallengeCount;
    }

    function setOpenFraudChallengeCount(uint256 count) external {
        openFraudChallengeCount = count;
    }
}

/// @notice Returns deliberately malformed data for every selector. A
///         permissive fallback must never satisfy the router handshake.
contract MalformedEcdsaFraudRouterCutoverStub {
    fallback() external payable {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(0, 1)
            return(31, 1)
        }
    }
}

/// @notice Models the dangerous ordering used by the pre-fix stateful router:
///         the global count reaches zero before the untrusted refund callback.
contract LegacyEcdsaFraudRouterCutoverStub {
    IBridgeForEcdsaFraudRouterCutoverTest public immutable bridge;
    uint256 public openFraudChallengeCount;

    address payable internal challenger;
    uint256 internal challengeDeposit;

    constructor(address _bridge) {
        bridge = IBridgeForEcdsaFraudRouterCutoverTest(_bridge);
    }

    function submitChallengeForTest() external payable {
        (uint96 requiredDeposit, , , ) = bridge.fraudParameters();
        require(msg.value >= requiredDeposit, "Deposit too low");
        require(openFraudChallengeCount == 0, "Challenge already open");

        challenger = payable(msg.sender);
        challengeDeposit = msg.value;
        openFraudChallengeCount = 1;
    }

    function resolveWithVulnerableRefundOrderingForTest() external {
        require(openFraudChallengeCount == 1, "Challenge not open");

        // Historical timeout resolution reads the timeout from this shared
        // Bridge view. Drain must leave that read usable even while raising
        // the returned submission deposit to its sentinel maximum.
        (, uint32 defeatTimeout, , ) = bridge.fraudParameters();
        require(defeatTimeout != 0, "Timeout unavailable");

        address payable refundRecipient = challenger;
        uint256 refundAmount = challengeDeposit;
        openFraudChallengeCount = 0;
        delete challenger;
        delete challengeDeposit;

        // Match the historical router boundary: ignore a failed refund, but
        // expose the zero-count interval to the recipient callback.
        /* solhint-disable avoid-low-level-calls */
        // slither-disable-next-line low-level-calls,unchecked-lowlevel,arbitrary-send-eth
        refundRecipient.call{gas: 100000, value: refundAmount}("");
        /* solhint-enable avoid-low-level-calls */
    }
}

contract ReentrantEcdsaFraudChallenger {
    LegacyEcdsaFraudRouterCutoverStub public immutable fraudRouter;
    IBridgeForEcdsaFraudRouterCutoverTest public immutable bridge;
    bytes20 public immutable walletPubKeyHash;

    event ReentrantClosureAttempt(bool succeeded, bytes4 revertSelector);

    constructor(
        address _fraudRouter,
        address _bridge,
        bytes20 _walletPubKeyHash
    ) {
        fraudRouter = LegacyEcdsaFraudRouterCutoverStub(_fraudRouter);
        bridge = IBridgeForEcdsaFraudRouterCutoverTest(_bridge);
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

    function submitChallenge() external payable {
        fraudRouter.submitChallengeForTest{value: msg.value}();
    }

    function resolveChallenge() external {
        fraudRouter.resolveWithVulnerableRefundOrderingForTest();
    }
}
