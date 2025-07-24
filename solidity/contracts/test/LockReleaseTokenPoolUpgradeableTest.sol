// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../cross-chain/ccip/LockReleaseTokenPoolUpgradeable.sol";

contract LockReleaseTokenPoolUpgradeableTest is
    LockReleaseTokenPoolUpgradeable
{

    function setRouter(address newRouter) public {
        s_router = newRouter;
    }

    function setRmnProxy(address newRmnProxy) public {
        s_rmnProxy = newRmnProxy;
    }
}