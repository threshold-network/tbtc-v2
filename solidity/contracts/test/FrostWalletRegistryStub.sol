// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

interface IBridgeFrostWalletCallback {
    function __frostWalletCreatedCallback(bytes32 xOnlyOutputKey) external;

    function __frostWalletHeartbeatFailedCallback(bytes32 xOnlyOutputKey)
        external;
}

contract FrostWalletRegistryStub {
    address public lifecycleOwner;
    bool public requestNewWalletCalled;
    bool public closeWalletCalled;
    bytes32 public lastClosedWalletID;
    bool public seizeCalled;
    uint96 public lastSeizeAmount;
    uint256 public lastSeizeRewardMultiplier;
    address public lastSeizeNotifier;
    bytes32 public lastSeizeWalletID;
    uint32[] private lastSeizeWalletMembersIDs;
    bool public isWalletMemberResult;
    bytes32 private expectedIsWalletMemberWalletID;
    uint32[] private expectedIsWalletMemberWalletMembersIDs;
    address private expectedIsWalletMemberOperator;
    uint256 private expectedIsWalletMemberIndex;

    modifier onlyLifecycleOwner() {
        require(
            msg.sender == lifecycleOwner,
            "Caller is not the Lifecycle Owner"
        );
        _;
    }

    function setLifecycleOwner(address _lifecycleOwner) external {
        lifecycleOwner = _lifecycleOwner;
    }

    function requestNewWallet() external {
        requestNewWalletCalled = true;
    }

    function resetRequestNewWalletCalled() external {
        requestNewWalletCalled = false;
    }

    function closeWallet(bytes32 walletID) external onlyLifecycleOwner {
        closeWalletCalled = true;
        lastClosedWalletID = walletID;
    }

    function seize(
        uint96 amount,
        uint256 rewardMultiplier,
        address notifier,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs
    ) external onlyLifecycleOwner {
        seizeCalled = true;
        lastSeizeAmount = amount;
        lastSeizeRewardMultiplier = rewardMultiplier;
        lastSeizeNotifier = notifier;
        lastSeizeWalletID = walletID;

        delete lastSeizeWalletMembersIDs;
        for (uint256 i = 0; i < walletMembersIDs.length; i++) {
            lastSeizeWalletMembersIDs.push(walletMembersIDs[i]);
        }
    }

    function setExpectedIsWalletMember(
        bytes32 walletID,
        uint32[] calldata walletMembersIDs,
        address operator,
        uint256 walletMemberIndex,
        bool result
    ) external {
        expectedIsWalletMemberWalletID = walletID;
        expectedIsWalletMemberOperator = operator;
        expectedIsWalletMemberIndex = walletMemberIndex;
        isWalletMemberResult = result;

        delete expectedIsWalletMemberWalletMembersIDs;
        for (uint256 i = 0; i < walletMembersIDs.length; i++) {
            expectedIsWalletMemberWalletMembersIDs.push(walletMembersIDs[i]);
        }
    }

    function callBridgeFrostWalletCreatedCallback(
        address bridge,
        bytes32 xOnlyOutputKey
    ) external {
        IBridgeFrostWalletCallback(bridge).__frostWalletCreatedCallback(
            xOnlyOutputKey
        );
    }

    function callBridgeFrostWalletHeartbeatFailedCallback(
        address bridge,
        bytes32 xOnlyOutputKey
    ) external {
        IBridgeFrostWalletCallback(bridge).__frostWalletHeartbeatFailedCallback(
                xOnlyOutputKey
            );
    }

    function getLastSeizeWalletMembersIDs()
        external
        view
        returns (uint32[] memory)
    {
        return lastSeizeWalletMembersIDs;
    }

    function isWalletMember(
        bytes32 walletID,
        uint32[] calldata walletMembersIDs,
        address operator,
        uint256 walletMemberIndex
    ) external view returns (bool) {
        require(
            walletID == expectedIsWalletMemberWalletID,
            "Unexpected wallet"
        );
        require(
            operator == expectedIsWalletMemberOperator,
            "Unexpected operator"
        );
        require(
            walletMemberIndex == expectedIsWalletMemberIndex,
            "Unexpected member index"
        );
        require(
            walletMembersIDs.length ==
                expectedIsWalletMemberWalletMembersIDs.length,
            "Unexpected members length"
        );

        for (uint256 i = 0; i < walletMembersIDs.length; i++) {
            require(
                walletMembersIDs[i] ==
                    expectedIsWalletMemberWalletMembersIDs[i],
                "Unexpected member"
            );
        }

        return isWalletMemberResult;
    }
}
