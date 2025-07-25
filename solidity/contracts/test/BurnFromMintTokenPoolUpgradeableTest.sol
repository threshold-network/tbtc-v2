// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../cross-chain/ccip/BurnFromMintTokenPoolUpgradeable.sol";

contract BurnFromMintTokenPoolUpgradeableTest is
    BurnFromMintTokenPoolUpgradeable
{
    function setRouter(address newRouter) public {
        s_router = newRouter;
    }
}
