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

/// @notice Malicious current-generation handshake whose ancestry can be wired
///         into a cycle after deployment. Production routers use immutables;
///         this stub proves the cutover independently traverses and rejects a
///         dishonest graph instead of trusting the candidate's depth word.
contract MutableEcdsaFraudRouterAncestryStub {
    struct FraudChallenge {
        address challenger;
        uint256 depositAmount;
        uint32 reportedAt;
        bool resolved;
    }

    address public immutable bridge;
    bytes32 public constant fraudProtocolID =
        keccak256("tbtc/ecdsa-signature-fraud/router/current-v3");
    address public predecessor;
    bytes32 public predecessorCodeHash;
    uint8 public ancestryDepth;
    uint256 public openFraudChallengeCount;
    uint256 public unattributedOpenFraudChallengeCount;
    uint256 public openFraudChallengeEscrow;
    mapping(uint256 => FraudChallenge) public fraudChallenges;

    constructor(address _bridge) {
        bridge = _bridge;
    }

    function setAncestry(address _predecessor, uint8 _ancestryDepth) external {
        predecessor = _predecessor;
        predecessorCodeHash = _predecessor == address(0)
            ? bytes32(0)
            : _predecessor.codehash;
        ancestryDepth = _ancestryDepth;
    }

    function setPredecessorCodeHash(bytes32 codeHash) external {
        predecessorCodeHash = codeHash;
    }

    function setOpenFraudChallengeEscrowForTest(uint256 escrow) external {
        openFraudChallengeEscrow = escrow;
    }
}

/// @notice Current-generation predecessor whose identity lookup fails with
///         empty revert data. Its legacy-shaped mapping deliberately exists so
///         tests prove an OOG/empty revert cannot be misclassified as v2.
contract RevertingIdentityEcdsaFraudRouterStub {
    struct FraudChallenge {
        address challenger;
        uint256 depositAmount;
        uint32 reportedAt;
        bool resolved;
    }

    address public immutable bridge;
    bytes32 public constant fraudProtocolID =
        keccak256("tbtc/ecdsa-signature-fraud/router/current-v3");
    address public constant predecessor = address(0);
    bytes32 public constant predecessorCodeHash = bytes32(0);
    uint8 public constant ancestryDepth = 0;
    mapping(uint256 => FraudChallenge) public fraudChallenges;

    constructor(address _bridge) {
        bridge = _bridge;
    }

    function challengeIdentityExists(uint256) external pure returns (bool) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            revert(0, 0)
        }
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
    struct FraudChallenge {
        address challenger;
        uint256 depositAmount;
        uint32 reportedAt;
        bool resolved;
    }

    IBridgeForEcdsaFraudRouterCutoverTest public immutable bridge;
    bytes32 public constant fraudProtocolID =
        keccak256("tbtc/ecdsa-signature-fraud/router/current-v2");
    uint256 public openFraudChallengeCount;
    mapping(uint256 => FraudChallenge) public fraudChallenges;

    address payable internal challenger;
    uint256 internal challengeDeposit;

    constructor(address _bridge) {
        bridge = IBridgeForEcdsaFraudRouterCutoverTest(_bridge);
    }

    function setOpenFraudChallengeCountForTest(uint256 count) external {
        openFraudChallengeCount = count;
    }

    function setFraudChallenge(
        uint256 challengeKey,
        address _challenger,
        uint256 depositAmount,
        uint32 reportedAt,
        bool resolved
    ) external {
        fraudChallenges[challengeKey] = FraudChallenge(
            _challenger,
            depositAmount,
            reportedAt,
            resolved
        );
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
