// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.17;

import "@keep-network/tbtc-v2/contracts/l2/L1BitcoinDepositor.sol";

/// @notice L1BitcoinDepositor for Base - upgraded version.
/// @dev This contract is intended solely for testing purposes.
contract BaseL1BitcoinDepositorUpgraded is L1BitcoinDepositor {
    string public newVar;

    function initializeV2(string memory _newVar) public {
        newVar = _newVar;
    }
}