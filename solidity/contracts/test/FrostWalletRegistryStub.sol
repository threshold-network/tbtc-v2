// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

interface IBridgeFrostWalletCallback {
    function __frostWalletCreatedCallback(bytes32 xOnlyOutputKey) external;
}

contract FrostWalletRegistryStub {
    address public lifecycleOwner;
    bool public requestNewWalletCalled;

    function setLifecycleOwner(address _lifecycleOwner) external {
        lifecycleOwner = _lifecycleOwner;
    }

    function requestNewWallet() external {
        requestNewWalletCalled = true;
    }

    function resetRequestNewWalletCalled() external {
        requestNewWalletCalled = false;
    }

    function callBridgeFrostWalletCreatedCallback(
        address bridge,
        bytes32 xOnlyOutputKey
    ) external {
        IBridgeFrostWalletCallback(bridge).__frostWalletCreatedCallback(
            xOnlyOutputKey
        );
    }
}
