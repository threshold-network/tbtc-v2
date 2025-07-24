// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../cross-chain/ccip/LockReleaseTokenPoolUpgradeable.sol";

// Special contract for testing initialization validation without disabled initializers
contract LockReleaseTokenPoolUpgradeableInitTest is
    LockReleaseTokenPoolUpgradeable
{
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Don't call _disableInitializers() to allow initialization testing
    }
} 