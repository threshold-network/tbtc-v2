// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../vault/ITBTCVaultMigrationSweepNotifier.sol";

contract MockMigrationSweepNotifier is ITBTCVaultMigrationSweepNotifier {
    address public lastReserve;
    bytes32 public lastCompletionRef;
    uint256 public notificationCount;
    bool public shouldRevert;

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function notifyMigrationSweep(address reserve, bytes32 completionRef)
        external
        override
    {
        require(!shouldRevert, "Mock migration sweep notifier revert");

        lastReserve = reserve;
        lastCompletionRef = completionRef;
        notificationCount++;
    }
}
