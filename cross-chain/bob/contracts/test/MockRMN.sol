// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.19;

import "../interfaces/IRMN.sol";

contract MockRMN is IRMN {
    bool public cursed = false;

    function isCursed(
        bytes16 /* chainId */
    ) external view override returns (bool) {
        return cursed;
    }

    function setCursed(bool _cursed) external {
        cursed = _cursed;
    }
}
