// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../vault/TBTCVault.sol";
import "../bank/Bank.sol";
import "../token/TBTC.sol";
import "../bridge/Bridge.sol";

/// @dev Test stub for `TBTCOptimisticMinting`'s throttle-exemption seam.
///      Allows arbitrary requesters to bypass all optimistic minting throttle
///      checks.
contract TBTCVaultThrottleExemptStub is TBTCVault {
    mapping(address => bool) public throttleExempt;

    constructor(
        Bank _bank,
        TBTC _tbtcToken,
        Bridge _bridge
    ) TBTCVault(_bank, _tbtcToken, _bridge) {}

    function setThrottleExempt(address requester, bool exempt) external {
        throttleExempt[requester] = exempt;
    }

    function _isOptimisticMintingThrottleExempt(
        address requester
    ) internal view override returns (bool) {
        return throttleExempt[requester];
    }
}
