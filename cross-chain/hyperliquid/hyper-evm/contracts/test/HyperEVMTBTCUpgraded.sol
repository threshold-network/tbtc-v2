// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.17;

import "@keep-network/tbtc-v2/contracts/l2/L2TBTC.sol";

/// @notice Canonical tBTC Token on Arbitrum - upgraded version.
/// @dev This contract is intended solely for testing purposes. As it currently
///      stands in the implementation of L2TBTC.sol, there are no reserved
///      storage gap slots available, thereby limiting the upgradability to a
///      child contract only.
contract ArbitrumTBTCUpgraded is L2TBTC {
    string public newVar;

    function initializeV2(string memory _newVar) public {
        newVar = _newVar;
    }
}
