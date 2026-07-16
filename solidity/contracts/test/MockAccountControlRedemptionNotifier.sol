// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.0;

import "../vault/IAccountControlRedemptionNotifier.sol";

/// @notice Test double for the Account Control redemption notifier. Records the
///         last legacy-redemption reconciliation and can be configured to
///         revert, mirroring an AC reserve whose minted exposure cannot be
///         reconciled.
contract MockAccountControlRedemptionNotifier is
    IAccountControlRedemptionNotifier
{
    address public lastRedeemer;
    uint256 public lastAmount;
    uint256 public callCount;
    bool public shouldRevert;

    event LegacyRedemptionNotified(address redeemer, uint256 amount);

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function notifyLegacyRedemption(address redeemer, uint256 amount)
        external
        override
    {
        require(!shouldRevert, "AC reconciliation failed");
        lastRedeemer = redeemer;
        lastAmount = amount;
        callCount++;
        emit LegacyRedemptionNotified(redeemer, amount);
    }
}
