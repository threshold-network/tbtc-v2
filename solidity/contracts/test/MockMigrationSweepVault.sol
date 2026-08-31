// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../vault/IVault.sol";
import "../vault/ITBTCVaultMigrationSweepHook.sol";

contract MockMigrationSweepVault is IVault, ITBTCVaultMigrationSweepHook {
    bytes32 public lastReceiveDepositorsHash;
    bytes32 public lastReceiveAmountsHash;
    uint256 public receiveBalanceIncreaseCalls;

    bytes32 public lastSweepTxHash;
    bytes32 public lastSweepRevealersHash;
    uint256 public migrationSweepNotificationCalls;

    bool public shouldRevertMigrationSweepBatchHook;
    bool public shouldRevertMigrationSweepSingleHook;

    function setShouldRevertMigrationSweepHook(bool shouldRevert) external {
        shouldRevertMigrationSweepBatchHook = shouldRevert;
        shouldRevertMigrationSweepSingleHook = shouldRevert;
    }

    function setShouldRevertMigrationSweepBatchHook(bool shouldRevert)
        external
    {
        shouldRevertMigrationSweepBatchHook = shouldRevert;
    }

    function setShouldRevertMigrationSweepSingleHook(bool shouldRevert)
        external
    {
        shouldRevertMigrationSweepSingleHook = shouldRevert;
    }

    function receiveBalanceApproval(
        address,
        uint256,
        bytes calldata
    ) external override {}

    function receiveBalanceIncrease(
        address[] calldata depositors,
        uint256[] calldata depositedAmounts
    ) external override {
        receiveBalanceIncreaseCalls++;
        lastReceiveDepositorsHash = keccak256(abi.encode(depositors));
        lastReceiveAmountsHash = keccak256(abi.encode(depositedAmounts));
    }

    function notifyPendingMigrationSweep(
        bytes32 sweepTxHash,
        address[] calldata revealers
    ) external override {
        require(
            !shouldRevertMigrationSweepBatchHook,
            "Mock migration sweep batch hook revert"
        );

        migrationSweepNotificationCalls++;
        lastSweepTxHash = sweepTxHash;
        lastSweepRevealersHash = keccak256(abi.encode(revealers));
    }

    function notifyPendingMigrationSweepForRevealer(
        bytes32 sweepTxHash,
        address revealer
    ) external override {
        require(
            !shouldRevertMigrationSweepSingleHook,
            "Mock migration sweep single hook revert"
        );

        migrationSweepNotificationCalls++;
        lastSweepTxHash = sweepTxHash;
        address[] memory revealers = new address[](1);
        revealers[0] = revealer;
        lastSweepRevealersHash = keccak256(abi.encode(revealers));
    }
}
