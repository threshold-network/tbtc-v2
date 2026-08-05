// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./SepoliaLightRelay.sol";

/// @dev Exposes SepoliaLightRelay's internal virtual methods for unit testing.
contract TestSepoliaLightRelay is SepoliaLightRelay {
    function isValidPreRetargetTargetPublic(
        uint256 headerTarget,
        uint256 oldTarget
    ) external view returns (bool) {
        return isValidPreRetargetTarget(headerTarget, oldTarget);
    }

    function isValidPostRetargetTargetPublic(
        uint256 headerTarget,
        uint256 minedTarget
    ) external view returns (bool) {
        return isValidPostRetargetTarget(headerTarget, minedTarget);
    }
}
