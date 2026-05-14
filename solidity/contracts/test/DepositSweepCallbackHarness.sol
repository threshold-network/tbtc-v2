// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/DepositSweep.sol";

contract DepositSweepCallbackHarness {
    BridgeState.Storage private self;

    event MigrationSweepCallbackFailed(
        address indexed vault,
        bytes32 indexed sweepTxHash
    );
    event MigrationSweepCallbackRetryFailed(
        address indexed vault,
        bytes32 indexed sweepTxHash,
        address indexed revealer
    );

    function maxMigrationSweepBatchSize() external pure returns (uint256) {
        return DepositSweep.MAX_MIGRATION_SWEEP_BATCH_SIZE;
    }

    function setMigrationDebtVault(address vault) external {
        self.migrationDebtVault = vault;
    }

    function notifyMigrationSweepCallback(
        address vault,
        bytes32 sweepTxHash,
        address[] calldata revealers
    ) external {
        DepositSweep.notifyMigrationSweepCallback(
            self,
            vault,
            sweepTxHash,
            revealers
        );
    }
}
