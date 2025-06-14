// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "@keep-network/tbtc-v2/contracts/Timelock.sol";

/// @notice Timelock contract for the Keep Network TBTc V2.
/// @dev This contract is intended solely for testing purposes.
contract TimelockDeployed is Timelock {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors
    ) Timelock(minDelay, proposers, executors) {}
}
