// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../cross-chain/ccip/BurnFromMintTokenPoolUpgradeable.sol";

contract BurnFromMintTokenPoolUpgradeableTest is
    BurnFromMintTokenPoolUpgradeable
{
    function setRouter(address newRouter) public {
        s_router = newRouter;
    }

    function initialize(
        address token,
        address[] memory allowlist,
        address rmnProxy,
        address router
    ) public override initializer {
        super.initialize(token, allowlist, rmnProxy, router);
    }
}
