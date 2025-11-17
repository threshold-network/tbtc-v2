// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../relay/LightRelay.sol";

contract LightRelayStub is LightRelay {
    // Gas-reporting version of validateChain
    function validateChainGasReport(bytes memory headers)
        external
        returns (uint256, uint256)
    {
        return this.validateChain(headers);
    }
}
