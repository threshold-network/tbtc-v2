// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

interface ITBTCVaultMigrationSweepNotifier {
    function notifyMigrationSweep(address reserve, bytes32 completionRef)
        external;
}
