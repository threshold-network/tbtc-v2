// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../relay/Testnet4LightRelay.sol";

contract Testnet4LightRelayStub is Testnet4LightRelay {
    // Gas-reporting version of validateChain
    function validateChainGasReport(bytes memory headers)
        external
        returns (uint256, uint256)
    {
        return this.validateChain(headers);
    }

    /// @notice Public wrapper for the internal _isTolerableTarget hook, for
    ///         direct unit testing of the DIFF1 acceptance logic.
    function isTolerableTarget(uint256 target) external view returns (bool) {
        return _isTolerableTarget(target);
    }
}
