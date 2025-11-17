// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/Heartbeat.sol";

/// @dev This is a contract implemented to test Heartbeat library directly.
contract HeartbeatStub {
    function isValidHeartbeatMessage(bytes calldata message)
        public
        pure
        returns (bool)
    {
        return Heartbeat.isValidHeartbeatMessage(message);
    }
}
