// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

interface ITBTCVaultMigrationSweepHook {
    function notifyPendingMigrationSweep(
        bytes32 sweepTxHash,
        address[] calldata revealers
    ) external;

    /// @notice Single-revealer recovery hook used for targeted retries when
    ///         batched sweep notification cannot complete all revealers.
    function notifyPendingMigrationSweepForRevealer(
        bytes32 sweepTxHash,
        address revealer
    ) external;
}
