# Slither PR triage (PR #1116, Reservations Upgrade)

Scope: findings on this PR's changed lines, and in the files this PR changes. Findings in contracts the PR
does not touch are not part of this record.

## 1. Summary

This document records the triage of all 108 static analysis findings produced by Slither 0.11.6 on the tbtc-v2 repository. The run was executed against the PR #1116 code at commit `eec999aa`. Findings are mapped against the PR diff between merge-base `502cd3982b5b2dc3ff0e1e6085a24502f78cfe26` and `eec999aa`.

### Overview Counts

- Total Slither SARIF findings: 108
- Findings on PR-changed lines: 15
- Findings in PR-changed files (untouched lines): 54
- Findings in untouched files elsewhere: 39

### Verdict Counts for Findings on PR-Changed Lines (15 total)

- True Positive (new security issue): 0
- False Positive (benign tuple destructuring / gas stipend pattern): 10 (7 `unused-return`, 3 `return-bomb`)
- By Design / Informational (configuration event parameter indexing convention): 5 (`unindexed-event-address`)

### New issues candidate summary

No new unrecorded security issues were found among the 15 Slither findings on PR-changed lines.

- The 7 `unused-return` findings on PR-changed lines are false positives caused by standard Solidity tuple destructuring where unneeded parameters are left blank.
- The 3 `return-bomb` findings are false positives on gas-capped calls to the trusted `ReimbursementPool` contract. One of these call sites in `AbstractL1BTCDepositor.sol` contains the deferred reimbursement failure handling already catalogued as `R-21`.
- The 5 `unindexed-event-address` findings follow the established repository convention for singleton configuration events.

---

## 2. Mapping Method and Category Counts

### Methodology

1. The merge base between `main` and `eec999aa` was determined as commit `502cd3982b5b2dc3ff0e1e6085a24502f78cfe26` via `git merge-base main eec999aa`.
2. The added and modified line numbers across all Solidity contracts were extracted from `git diff 502cd3982b5b2dc3ff0e1e6085a24502f78cfe26 eec999aa -- solidity/contracts`.
3. Each of the 108 findings from `solidity/fizz_data/tooling-runs-2026-10-03/slither.sarif.gz` was mapped by its primary physical location (`physicalLocation.region`) and cited source expression into one of three disjoint categories:
   - PR-changed lines: The flagged line or expression was added or modified in the PR.
   - PR-changed files (untouched lines): The enclosing file was touched by the PR, but the specific line or function was unchanged from base.
   - Elsewhere: The finding is in a contract file untouched by the PR.

### Detector Counts Across Categories

| Detector Rule                 | Total Count | In PR-Changed Lines | In PR Files (Untouched Lines) | Elsewhere |
| ----------------------------- | ----------- | ------------------- | ----------------------------- | --------- |
| `1-1-unused-return`           | 54          | 7                   | 38                            | 9         |
| `3-0-unindexed-event-address` | 46          | 5                   | 15                            | 26        |
| `2-1-return-bomb`             | 3           | 3                   | 0                             | 0         |
| `4-0-immutable-states`        | 2           | 0                   | 1                             | 1         |
| `0-0-msg-value-in-nonpayable` | 1           | 0                   | 0                             | 1         |
| `0-1-reentrancy-balance`      | 1           | 0                   | 0                             | 1         |
| `1-1-uninitialized-local`     | 1           | 0                   | 0                             | 1         |
| **Total**                     | **108**     | **15**              | **54**                        | **39**    |

---

## 3. Triage of Findings on PR-Changed Lines

### Result 40: `1-1-unused-return`

- **Location**: `contracts/cross-chain/wormhole/L1BTCDepositorWormholeV2Arbitrum.sol:424-531 (cited line 442)`
- **Detector**: `1-1-unused-return`
- **Slither message**: L1BTCDepositorWormholeV2Arbitrum.finalizeDeposit(uint256) ignores return value by (None,None,depositTxMaxFee,None) = bridge.depositParameters()
- **Verdict**: False Positive / By Design
- **Register Cross-Reference**: none (fee-parameter getter)
- **Code Citation**:

```solidity
(, , uint256 depositTxMaxFee, ) = bridge.depositParameters();
```

- **Reasoning**: The function only requires `depositTxMaxFee` from `bridge.depositParameters()` to compute reimbursement amounts. Omission of the other 3 returned values via tuple destructuring is intentional and harmless.

### Result 47: `1-1-unused-return`

- **Location**: `contracts/bridge/ReservationProofs.sol:863-875 (cited line 868)`
- **Detector**: `1-1-unused-return`
- **Slither message**: ReservationProofs.parseSingleOutput(bytes) ignores return value by (None,outputsCount) = outputVector.parseVarInt()
- **Verdict**: False Positive / By Design
- **Register Cross-Reference**: None
- **Code Citation**:

```solidity
(, uint256 outputsCount) = outputVector.parseVarInt();
require(
    outputsCount == 1,
    "Reservation transaction must have a single output"
);
```

- **Reasoning**: Helper `parseVarInt()` returns `(uint256 value, uint256 length)`. `outputsCount` is the parsed value. The byte length consumed is not needed because the function asserts `outputsCount == 1` and immediately extracts output index 0.

### Result 48: `1-1-unused-return`

- **Location**: `contracts/cross-chain/AbstractL1BTCDepositor.sol:388-537 (cited line 411)`
- **Detector**: `1-1-unused-return`
- **Slither message**: AbstractL1BTCDepositor.finalizeDeposit(uint256) ignores return value by (None,None,depositTxMaxFee,None) = bridge.depositParameters()
- **Verdict**: False Positive / By Design
- **Register Cross-Reference**: none (fee-parameter getter)
- **Code Citation**:

```solidity
(, , uint256 depositTxMaxFee, ) = bridge.depositParameters();
```

- **Reasoning**: The function only needs `depositTxMaxFee` from `bridge.depositParameters()`. Standard tuple destructuring ignores the other tuple components.

### Result 52: `1-1-unused-return`

- **Location**: `contracts/cross-chain/wormhole/L1BTCDepositorWormholeV2Base.sol:420-527 (cited line 438)`
- **Detector**: `1-1-unused-return`
- **Slither message**: L1BTCDepositorWormholeV2Base.finalizeDeposit(uint256) ignores return value by (None,None,depositTxMaxFee,None) = bridge.depositParameters()
- **Verdict**: False Positive / By Design
- **Register Cross-Reference**: none (fee-parameter getter)
- **Code Citation**:

```solidity
(, , uint256 depositTxMaxFee, ) = bridge.depositParameters();
```

- **Reasoning**: Standard tuple destructuring to read `depositTxMaxFee` for fee calculation.

### Result 54: `1-1-unused-return`

- **Location**: `contracts/bridge/WalletProposalValidator.sol:966-1079 (cited lines 970-972)`
- **Detector**: `1-1-unused-return`
- **Slither message**: WalletProposalValidator.validateReservationAnchorProposal(...) ignores return value by (reservationVault,None,None,None,None,None,None,None,None,None) = IReservationBridge(address(bridge)).reservationParameters()
- **Verdict**: False Positive / By Design
- **Register Cross-Reference**: None
- **Code Citation**:

```solidity
(address reservationVault, , , , , , , , , ) = IReservationBridge(
    address(bridge)
).reservationParameters();
require(reservationVault != address(0), "Reservations are disabled");
```

- **Reasoning**: `reservationParameters()` returns a 10-parameter tuple. Proposal validation only needs to verify that reservations are enabled by checking `reservationVault != address(0)`. Leaving unused positions blank is the intended Solidity idiom.

### Result 55: `1-1-unused-return`

- **Location**: `contracts/bridge/WalletProposalValidator.sol:1111-1199 (cited lines 1158-1169)`
- **Detector**: `1-1-unused-return`
- **Slither message**: WalletProposalValidator.validateReservationReanchorProposal(...) ignores return value by (None,None,None,None,None,None,None,maxReservationsPerWallet,None,None) = IReservationBridge(address(bridge)).reservationParameters()
- **Verdict**: False Positive / By Design
- **Register Cross-Reference**: None
- **Code Citation**:

```solidity
(
    ,
    ,
    ,
    ,
    ,
    ,
    ,
    uint32 maxReservationsPerWallet,
    ,

) = IReservationBridge(address(bridge)).reservationParameters();
require(
    IReservationBridge(address(bridge)).walletReservationsCount(
        proposal.targetWalletPubKeyHash
    ) <= maxReservationsPerWallet,
    "Wallet reservations cap exceeded"
);
```

- **Reasoning**: The reanchor validation step only checks the per-wallet count cap `maxReservationsPerWallet`. Omission of other tuple parameters is intentional.

### Result 56: `1-1-unused-return`

- **Location**: `contracts/bridge/WalletProposalValidator.sol:1111-1199 (cited lines 1177-1179)`
- **Detector**: `1-1-unused-return`
- **Slither message**: WalletProposalValidator.validateReservationReanchorProposal(...) ignores return value by (maxReservationsAmountPerWallet,None,None) = IReservationBridge(address(bridge)).reservationCaps()
- **Verdict**: False Positive / By Design
- **Register Cross-Reference**: None
- **Code Citation**:

```solidity
(uint64 maxReservationsAmountPerWallet, , ) = IReservationBridge(
    address(bridge)
).reservationCaps();
```

- **Reasoning**: `reservationCaps()` returns `(maxReservationsAmountPerWallet, reservationMaxSingleAmount, maxActiveReservations)`. The validator only checks the per-wallet satoshi amount cap.

### Result 57: `2-1-return-bomb`

- **Location**: `contracts/cross-chain/AbstractL1BTCDepositor.sol:388-537 (cited lines 509-517)`
- **Detector**: `2-1-return-bomb`
- **Slither message**: AbstractL1BTCDepositor.finalizeDeposit(uint256) tries to limit the gas of an external call that controls implicit decoding (success,None) = address(reimbursementPool).call{gas: 2_000_000}(...)
- **Verdict**: False Positive for return-bomb; By Design gas-bounding pattern (cross-reference: R-21 for the storage-retention defect)
- **Register Cross-Reference**: R-21 (failed deferred reimbursement re-stored with no payout path)
- **Code Citation**:

```solidity
/* solhint-disable avoid-low-level-calls */
// slither-disable-next-line unchecked-lowlevel,low-level-calls
(bool success, ) = address(reimbursementPool).call{
    gas: 2_000_000
}(
    abi.encodeWithSelector(
        reimbursementPool.refund.selector,
        reimbursement.gasSpent,
        reimbursement.receiver
    )
);
/* solhint-enable avoid-low-level-calls */

if (!success) {
    gasReimbursements[depositKey] = reimbursement;
    emit DeferredReimbursementFailed(
        depositKey,
        reimbursement.receiver,
        reimbursement.gasSpent
    );
}
```

- **Reasoning**: The target `reimbursementPool` is a trusted protocol contract set by `onlyReimbursableAdmin`. It does not return large byte payloads. The gas stipend (2,000,000) was introduced to ensure an untrusted or gas-heavy receiver called by `ReimbursementPool` cannot revert the entire deposit finalization. Developer NatSpec documents: 'Best-effort: a deferred receiver that cannot be reimbursed within the gas stipend must not block this deposit finalization for everyone.' The call return is not decoded into variables. However, the subsequent failure branch re-storing `gasReimbursements[depositKey]` is recorded as R-21 (real-low).

### Result 58: `2-1-return-bomb`

- **Location**: `contracts/cross-chain/wormhole/L1BTCDepositorWormholeV2Arbitrum.sol:424-531 (cited lines 521-527)`
- **Detector**: `2-1-return-bomb`
- **Slither message**: L1BTCDepositorWormholeV2Arbitrum.finalizeDeposit(uint256) tries to limit the gas of an external call that controls implicit decoding
- **Verdict**: False Positive / By Design
- **Register Cross-Reference**: none (fee-parameter getter)
- **Code Citation**:

```solidity
/* solhint-disable avoid-low-level-calls */
// slither-disable-next-line unchecked-lowlevel,low-level-calls
address(reimbursementPool).call{gas: 2_000_000}(
    abi.encodeWithSelector(
        reimbursementPool.refund.selector,
        reimbursement.gasSpent,
        reimbursement.receiver
    )
);
/* solhint-enable avoid-low-level-calls */
```

- **Reasoning**: The call targets the trusted `reimbursementPool` with a 2,000,000 gas limit to bound execution cost. Return boolean and return data are ignored entirely in this contract. No return bomb risk.

### Result 59: `2-1-return-bomb`

- **Location**: `contracts/cross-chain/wormhole/L1BTCDepositorWormholeV2Base.sol:420-527 (cited lines 517-523)`
- **Detector**: `2-1-return-bomb`
- **Slither message**: L1BTCDepositorWormholeV2Base.finalizeDeposit(uint256) tries to limit the gas of an external call that controls implicit decoding
- **Verdict**: False Positive / By Design
- **Register Cross-Reference**: none (fee-parameter getter)
- **Code Citation**:

```solidity
/* solhint-disable avoid-low-level-calls */
// slither-disable-next-line unchecked-lowlevel,low-level-calls
address(reimbursementPool).call{gas: 2_000_000}(
    abi.encodeWithSelector(
        reimbursementPool.refund.selector,
        reimbursement.gasSpent,
        reimbursement.receiver
    )
);
/* solhint-enable avoid-low-level-calls */
```

- **Reasoning**: Identical to Result #58. Gas-bounded best-effort invocation of the trusted `ReimbursementPool` refund method.

### Result 63: `3-0-unindexed-event-address`

- **Location**: `contracts/bridge/IReservationBridge.sol:230-230`
- **Detector**: `3-0-unindexed-event-address`
- **Slither message**: Event IReservationBridge.ReservationVaultUpdated(address) has address parameters but no indexed parameters
- **Verdict**: By Design / Informational
- **Register Cross-Reference**: None
- **Code Citation**:

```solidity
event ReservationVaultUpdated(address reservationVault);
```

- **Reasoning**: Singleton governance configuration event. In tbtc-v2, global singleton address updates omit `indexed` parameters by design as off-chain indexers filter on event signatures rather than topic addresses.

### Result 69: `3-0-unindexed-event-address`

- **Location**: `contracts/bridge/BridgeGovernanceParameters.sol:353-364`
- **Detector**: `3-0-unindexed-event-address`
- **Slither message**: Event BridgeGovernanceParameters.ReservationParametersUpdateStarted(...) has address parameters but no indexed parameters
- **Verdict**: By Design / Informational
- **Register Cross-Reference**: None
- **Code Citation**:

```solidity
event ReservationParametersUpdateStarted(
  address newReservationVault,
  uint64 newReservationMinAmount,
  uint64 newReservationTxMaxFee,
  uint32 newReservationTermSeconds,
  uint32 newReservationDissolutionDelay,
  uint64 newReservationMaxTotalAmount,
  uint32 newMaxReservationsPerWallet,
  uint32 newReservationActionTimeout,
  uint32 newReservationRenewalWindowSeconds,
  uint256 timestamp
);
```

- **Reasoning**: Governance timelock initiation event. Follows the existing pattern in `BridgeGovernanceParameters` (for example `TreasuryUpdateStarted`).

### Result 87: `3-0-unindexed-event-address`

- **Location**: `contracts/bridge/ReservationRouter.sol:184-184`
- **Detector**: `3-0-unindexed-event-address`
- **Slither message**: Event ReservationRouter.ReservationVaultUpdated(address) has address parameters but no indexed parameters
- **Verdict**: By Design / Informational
- **Register Cross-Reference**: None
- **Code Citation**:

```solidity
event ReservationVaultUpdated(address reservationVault);
```

- **Reasoning**: Matches the declaration in `IReservationBridge`. Singleton configuration update event.

### Result 88: `3-0-unindexed-event-address`

- **Location**: `contracts/bridge/BridgeState.sol:562-562`
- **Detector**: `3-0-unindexed-event-address`
- **Slither message**: Event BridgeState.ReservationRouterSet(address) has address parameters but no indexed parameters
- **Verdict**: By Design / Informational
- **Register Cross-Reference**: None
- **Code Citation**:

```solidity
event ReservationRouterSet(address reservationRouter);
```

- **Reasoning**: Library event declared alongside `event RebateStakingSet(address)` (line 561) and `event TreasuryUpdated(address)` (line 553). Follows repository conventions.

### Result 104: `3-0-unindexed-event-address`

- **Location**: `contracts/bridge/Reservation.sol:390-390`
- **Detector**: `3-0-unindexed-event-address`
- **Slither message**: Event Reservation.ReservationVaultUpdated(address) has address parameters but no indexed parameters
- **Verdict**: By Design / Informational
- **Register Cross-Reference**: None
- **Code Citation**:

```solidity
event ReservationVaultUpdated(address reservationVault);
```

- **Reasoning**: Library event matching `IReservationBridge` and `ReservationRouter`. Follows repository conventions.

---

## 4. Findings in PR-Changed Files (Untouched Lines)

The following 54 findings reside in files touched by PR #1116, but their flagged lines or declarations are pre-existing and unchanged from main.

| SARIF result | Detector                      | Location                                                                      | Stated Issue / Message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Verdict                                                                           |
| ------------ | ----------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 3            | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#969-998`                               | BridgeGovernance.finalizeMovingFundsTimeoutUpdate() (contracts/bridge/BridgeGovernance.sol#969-998) ignores return value by (movingFundsTxMaxTotalFee,movingFundsDustThreshold,movingFundsTimeoutResetDelay,None,movingFundsTimeoutSlashingAmount,movingFundsTimeoutNotifierRewardMultiplier,movingFundsCommitmentGasOffset,movedFundsSweepTxMaxTotalFee,movedFundsSweepTimeout,movedFundsSweepTimeoutSlashingAmount,movedFundsSweepTimeoutNotifierRewardMultiplier) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#970-982)     | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 4            | `1-1-unused-return`           | `contracts/bridge/WalletProposalValidator.sol#839-892`                        | WalletProposalValidator.validateMovedFundsSweepProposal(WalletProposalValidator.MovedFundsSweepProposal) (contracts/bridge/WalletProposalValidator.sol#839-892) ignores return value by (None,None,None,None,None,None,None,movedFundsSweepTxMaxTotalFee,None,None,None) = bridge.movingFundsParameters() (contracts/bridge/WalletProposalValidator.sol#878-879)                                                                                                                                                                                          | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 5            | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1700-1715`                             | BridgeGovernance.finalizeFraudSlashingAmountUpdate() (contracts/bridge/BridgeGovernance.sol#1700-1715) ignores return value by (fraudChallengeDepositAmount,fraudChallengeDefeatTimeout,None,fraudNotifierRewardMultiplier) = bridge.fraudParameters() (contracts/bridge/BridgeGovernance.sol#1701-1706)                                                                                                                                                                                                                                                  | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 6            | `1-1-unused-return`           | `contracts/bridge/WalletProposalValidator.sol#555-699`                        | WalletProposalValidator.validateRedemptionProposal(WalletProposalValidator.RedemptionProposal) (contracts/bridge/WalletProposalValidator.sol#555-699) ignores return value by (None,None,None,redemptionTxMaxTotalFee,redemptionTimeout,None,None) = bridge.redemptionParameters() (contracts/bridge/WalletProposalValidator.sol#579-587)                                                                                                                                                                                                                 | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 7            | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1267-1302`                             | BridgeGovernance.finalizeMovedFundsSweepTimeoutSlashingAmountUpdate() (contracts/bridge/BridgeGovernance.sol#1267-1302) ignores return value by (movingFundsTxMaxTotalFee,movingFundsDustThreshold,movingFundsTimeoutResetDelay,movingFundsTimeout,movingFundsTimeoutSlashingAmount,movingFundsTimeoutNotifierRewardMultiplier,movingFundsCommitmentGasOffset,movedFundsSweepTxMaxTotalFee,movedFundsSweepTimeout,None,movedFundsSweepTimeoutNotifierRewardMultiplier) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#1271-1283) | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 8            | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#417-432`                               | BridgeGovernance.finalizeDepositDustThresholdUpdate() (contracts/bridge/BridgeGovernance.sol#417-432) ignores return value by (None,depositTreasuryFeeDivisor,depositTxMaxFee,depositRevealAheadPeriod) = bridge.depositParameters() (contracts/bridge/BridgeGovernance.sol#418-423)                                                                                                                                                                                                                                                                      | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 10           | `1-1-unused-return`           | `contracts/bridge/WalletProposalValidator.sol#373-398`                        | WalletProposalValidator.validateSweepTxFee(uint256,uint256) (contracts/bridge/WalletProposalValidator.sol#373-398) ignores return value by (None,None,depositTxMaxFee,None) = bridge.depositParameters() (contracts/bridge/WalletProposalValidator.sol#387)                                                                                                                                                                                                                                                                                               | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 11           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1015-1050`                             | BridgeGovernance.finalizeMovingFundsTimeoutSlashingAmountUpdate() (contracts/bridge/BridgeGovernance.sol#1015-1050) ignores return value by (movingFundsTxMaxTotalFee,movingFundsDustThreshold,movingFundsTimeoutResetDelay,movingFundsTimeout,None,movingFundsTimeoutNotifierRewardMultiplier,movingFundsCommitmentGasOffset,movedFundsSweepTxMaxTotalFee,movedFundsSweepTimeout,movedFundsSweepTimeoutSlashingAmount,movedFundsSweepTimeoutNotifierRewardMultiplier) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#1019-1031) | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 12           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1451-1473`                             | BridgeGovernance.finalizeWalletCreationMaxBtcBalanceUpdate() (contracts/bridge/BridgeGovernance.sol#1451-1473) ignores return value by (walletCreationPeriod,walletCreationMinBtcBalance,None,walletClosureMinBtcBalance,walletMaxAge,walletMaxBtcTransfer,walletClosingPeriod) = bridge.walletParameters() (contracts/bridge/BridgeGovernance.sol#1452-1460)                                                                                                                                                                                             | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 13           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1412-1434`                             | BridgeGovernance.finalizeWalletCreationMinBtcBalanceUpdate() (contracts/bridge/BridgeGovernance.sol#1412-1434) ignores return value by (walletCreationPeriod,None,walletCreationMaxBtcBalance,walletClosureMinBtcBalance,walletMaxAge,walletMaxBtcTransfer,walletClosingPeriod) = bridge.walletParameters() (contracts/bridge/BridgeGovernance.sol#1413-1421)                                                                                                                                                                                             | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 15           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#659-681`                               | BridgeGovernance.finalizeRedemptionTxMaxTotalFeeUpdate() (contracts/bridge/BridgeGovernance.sol#659-681) ignores return value by (redemptionDustThreshold,redemptionTreasuryFeeDivisor,redemptionTxMaxFee,None,redemptionTimeout,redemptionTimeoutSlashingAmount,redemptionTimeoutNotifierRewardMultiplier) = bridge.redemptionParameters() (contracts/bridge/BridgeGovernance.sol#660-668)                                                                                                                                                               | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 16           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1122-1154`                             | BridgeGovernance.finalizeMovingFundsCommitmentGasOffsetUpdate() (contracts/bridge/BridgeGovernance.sol#1122-1154) ignores return value by (movingFundsTxMaxTotalFee,movingFundsDustThreshold,movingFundsTimeoutResetDelay,movingFundsTimeout,movingFundsTimeoutSlashingAmount,movingFundsTimeoutNotifierRewardMultiplier,None,movedFundsSweepTxMaxTotalFee,movedFundsSweepTimeout,movedFundsSweepTimeoutSlashingAmount,movedFundsSweepTimeoutNotifierRewardMultiplier) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#1123-1135) | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 17           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1375-1396`                             | BridgeGovernance.finalizeWalletCreationPeriodUpdate() (contracts/bridge/BridgeGovernance.sol#1375-1396) ignores return value by (None,walletCreationMinBtcBalance,walletCreationMaxBtcBalance,walletClosureMinBtcBalance,walletMaxAge,walletMaxBtcTransfer,walletClosingPeriod) = bridge.walletParameters() (contracts/bridge/BridgeGovernance.sol#1376-1384)                                                                                                                                                                                             | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 18           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1489-1511`                             | BridgeGovernance.finalizeWalletClosureMinBtcBalanceUpdate() (contracts/bridge/BridgeGovernance.sol#1489-1511) ignores return value by (walletCreationPeriod,walletCreationMinBtcBalance,walletCreationMaxBtcBalance,None,walletMaxAge,walletMaxBtcTransfer,walletClosingPeriod) = bridge.walletParameters() (contracts/bridge/BridgeGovernance.sol#1490-1498)                                                                                                                                                                                             | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 19           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#448-464`                               | BridgeGovernance.finalizeDepositTreasuryFeeDivisorUpdate() (contracts/bridge/BridgeGovernance.sol#448-464) ignores return value by (depositDustThreshold,None,depositTxMaxFee,depositRevealAheadPeriod) = bridge.depositParameters() (contracts/bridge/BridgeGovernance.sol#449-454)                                                                                                                                                                                                                                                                      | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 20           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#582-607`                               | BridgeGovernance.finalizeRedemptionTreasuryFeeDivisorUpdate() (contracts/bridge/BridgeGovernance.sol#582-607) ignores return value by (redemptionDustThreshold,None,redemptionTxMaxFee,redemptionTxMaxTotalFee,redemptionTimeout,redemptionTimeoutSlashingAmount,redemptionTimeoutNotifierRewardMultiplier) = bridge.redemptionParameters() (contracts/bridge/BridgeGovernance.sol#583-591)                                                                                                                                                               | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 21           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#780-807`                               | BridgeGovernance.finalizeRedemptionTimeoutNotifierRewardMultiplierUpdate() (contracts/bridge/BridgeGovernance.sol#780-807) ignores return value by (redemptionDustThreshold,redemptionTreasuryFeeDivisor,redemptionTxMaxFee,redemptionTxMaxTotalFee,redemptionTimeout,redemptionTimeoutSlashingAmount,None) = bridge.redemptionParameters() (contracts/bridge/BridgeGovernance.sol#784-792)                                                                                                                                                               | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 24           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1637-1653`                             | BridgeGovernance.finalizeFraudChallengeDepositAmountUpdate() (contracts/bridge/BridgeGovernance.sol#1637-1653) ignores return value by (None,fraudChallengeDefeatTimeout,fraudSlashingAmount,fraudNotifierRewardMultiplier) = bridge.fraudParameters() (contracts/bridge/BridgeGovernance.sol#1638-1643)                                                                                                                                                                                                                                                  | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 25           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#873-905`                               | BridgeGovernance.finalizeMovingFundsDustThresholdUpdate() (contracts/bridge/BridgeGovernance.sol#873-905) ignores return value by (movingFundsTxMaxTotalFee,None,movingFundsTimeoutResetDelay,movingFundsTimeout,movingFundsTimeoutSlashingAmount,movingFundsTimeoutNotifierRewardMultiplier,movingFundsCommitmentGasOffset,movedFundsSweepTxMaxTotalFee,movedFundsSweepTimeout,movedFundsSweepTimeoutSlashingAmount,movedFundsSweepTimeoutNotifierRewardMultiplier) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#874-886)     | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 27           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#544-566`                               | BridgeGovernance.finalizeRedemptionDustThresholdUpdate() (contracts/bridge/BridgeGovernance.sol#544-566) ignores return value by (None,redemptionTreasuryFeeDivisor,redemptionTxMaxFee,redemptionTxMaxTotalFee,redemptionTimeout,redemptionTimeoutSlashingAmount,redemptionTimeoutNotifierRewardMultiplier) = bridge.redemptionParameters() (contracts/bridge/BridgeGovernance.sol#545-553)                                                                                                                                                               | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 28           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1219-1249`                             | BridgeGovernance.finalizeMovedFundsSweepTimeoutUpdate() (contracts/bridge/BridgeGovernance.sol#1219-1249) ignores return value by (movingFundsTxMaxTotalFee,movingFundsDustThreshold,movingFundsTimeoutResetDelay,movingFundsTimeout,movingFundsTimeoutSlashingAmount,movingFundsTimeoutNotifierRewardMultiplier,movingFundsCommitmentGasOffset,movedFundsSweepTxMaxTotalFee,None,movedFundsSweepTimeoutSlashingAmount,movedFundsSweepTimeoutNotifierRewardMultiplier) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#1220-1232) | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 29           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1526-1547`                             | BridgeGovernance.finalizeWalletMaxAgeUpdate() (contracts/bridge/BridgeGovernance.sol#1526-1547) ignores return value by (walletCreationPeriod,walletCreationMinBtcBalance,walletCreationMaxBtcBalance,walletClosureMinBtcBalance,None,walletMaxBtcTransfer,walletClosingPeriod) = bridge.walletParameters() (contracts/bridge/BridgeGovernance.sol#1527-1535)                                                                                                                                                                                             | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 30           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1598-1619`                             | BridgeGovernance.finalizeWalletClosingPeriodUpdate() (contracts/bridge/BridgeGovernance.sol#1598-1619) ignores return value by (walletCreationPeriod,walletCreationMinBtcBalance,walletCreationMaxBtcBalance,walletClosureMinBtcBalance,walletMaxAge,walletMaxBtcTransfer,None) = bridge.walletParameters() (contracts/bridge/BridgeGovernance.sol#1599-1607)                                                                                                                                                                                             | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 31           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#510-526`                               | BridgeGovernance.finalizeDepositRevealAheadPeriodUpdate() (contracts/bridge/BridgeGovernance.sol#510-526) ignores return value by (depositDustThreshold,depositTreasuryFeeDivisor,depositTxMaxFee,None) = bridge.depositParameters() (contracts/bridge/BridgeGovernance.sol#511-516)                                                                                                                                                                                                                                                                      | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 32           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1171-1203`                             | BridgeGovernance.finalizeMovedFundsSweepTxMaxTotalFeeUpdate() (contracts/bridge/BridgeGovernance.sol#1171-1203) ignores return value by (movingFundsTxMaxTotalFee,movingFundsDustThreshold,movingFundsTimeoutResetDelay,movingFundsTimeout,movingFundsTimeoutSlashingAmount,movingFundsTimeoutNotifierRewardMultiplier,movingFundsCommitmentGasOffset,None,movedFundsSweepTimeout,movedFundsSweepTimeoutSlashingAmount,movedFundsSweepTimeoutNotifierRewardMultiplier) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#1172-1184) | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 33           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#696-717`                               | BridgeGovernance.finalizeRedemptionTimeoutUpdate() (contracts/bridge/BridgeGovernance.sol#696-717) ignores return value by (redemptionDustThreshold,redemptionTreasuryFeeDivisor,redemptionTxMaxFee,redemptionTxMaxTotalFee,None,redemptionTimeoutSlashingAmount,redemptionTimeoutNotifierRewardMultiplier) = bridge.redemptionParameters() (contracts/bridge/BridgeGovernance.sol#697-705)                                                                                                                                                               | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 34           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1669-1685`                             | BridgeGovernance.finalizeFraudChallengeDefeatTimeoutUpdate() (contracts/bridge/BridgeGovernance.sol#1669-1685) ignores return value by (fraudChallengeDepositAmount,None,fraudSlashingAmount,fraudNotifierRewardMultiplier) = bridge.fraudParameters() (contracts/bridge/BridgeGovernance.sol#1670-1675)                                                                                                                                                                                                                                                  | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 35           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1069-1105`                             | BridgeGovernance.finalizeMovingFundsTimeoutNotifierRewardMultiplierUpdate() (contracts/bridge/BridgeGovernance.sol#1069-1105) ignores return value by (movingFundsTxMaxTotalFee,movingFundsDustThreshold,movingFundsTimeoutResetDelay,movingFundsTimeout,movingFundsTimeoutSlashingAmount,None,movingFundsCommitmentGasOffset,movedFundsSweepTxMaxTotalFee,movedFundsSweepTimeout,movedFundsSweepTimeoutSlashingAmount,movedFundsSweepTimeoutNotifierRewardMultiplier) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#1073-1085) | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 36           | `1-1-unused-return`           | `contracts/bridge/DepositSweep.sol#330-353`                                   | DepositSweep.processDepositSweepTxOutput(BridgeState.Storage,bytes) (contracts/bridge/DepositSweep.sol#330-353) ignores return value by (None,outputsCount) = sweepTxOutputVector.parseVarInt() (contracts/bridge/DepositSweep.sol#342)                                                                                                                                                                                                                                                                                                                   | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 37           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1322-1358`                             | BridgeGovernance.finalizeMovedFundsSweepTimeoutNotifierRewardMultiplierUpdate() (contracts/bridge/BridgeGovernance.sol#1322-1358) ignores return value by (movingFundsTxMaxTotalFee,movingFundsDustThreshold,movingFundsTimeoutResetDelay,movingFundsTimeout,movingFundsTimeoutSlashingAmount,movingFundsTimeoutNotifierRewardMultiplier,movingFundsCommitmentGasOffset,movedFundsSweepTxMaxTotalFee,movedFundsSweepTimeout,movedFundsSweepTimeoutSlashingAmount,None) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#1326-1338) | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 38           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#622-643`                               | BridgeGovernance.finalizeRedemptionTxMaxFeeUpdate() (contracts/bridge/BridgeGovernance.sol#622-643) ignores return value by (redemptionDustThreshold,redemptionTreasuryFeeDivisor,None,redemptionTxMaxTotalFee,redemptionTimeout,redemptionTimeoutSlashingAmount,redemptionTimeoutNotifierRewardMultiplier) = bridge.redemptionParameters() (contracts/bridge/BridgeGovernance.sol#623-631)                                                                                                                                                               | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 39           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#922-954`                               | BridgeGovernance.finalizeMovingFundsTimeoutResetDelayUpdate() (contracts/bridge/BridgeGovernance.sol#922-954) ignores return value by (movingFundsTxMaxTotalFee,movingFundsDustThreshold,None,movingFundsTimeout,movingFundsTimeoutSlashingAmount,movingFundsTimeoutNotifierRewardMultiplier,movingFundsCommitmentGasOffset,movedFundsSweepTxMaxTotalFee,movedFundsSweepTimeout,movedFundsSweepTimeoutSlashingAmount,movedFundsSweepTimeoutNotifierRewardMultiplier) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#923-935)     | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 41           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1562-1583`                             | BridgeGovernance.finalizeWalletMaxBtcTransferUpdate() (contracts/bridge/BridgeGovernance.sol#1562-1583) ignores return value by (walletCreationPeriod,walletCreationMinBtcBalance,walletCreationMaxBtcBalance,walletClosureMinBtcBalance,walletMaxAge,None,walletClosingPeriod) = bridge.walletParameters() (contracts/bridge/BridgeGovernance.sol#1563-1571)                                                                                                                                                                                             | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 42           | `1-1-unused-return`           | `contracts/bridge/WalletProposalValidator.sol#724-788`                        | WalletProposalValidator.validateMovingFundsProposal(WalletProposalValidator.MovingFundsProposal,BitcoinTx.UTXO) (contracts/bridge/WalletProposalValidator.sol#724-788) ignores return value by (movingFundsTxMaxTotalFee,movingFundsDustThreshold,None,None,None,None,None,None,None,None,None) = bridge.movingFundsParameters() (contracts/bridge/WalletProposalValidator.sol#751-763)                                                                                                                                                                   | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 43           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#825-857`                               | BridgeGovernance.finalizeMovingFundsTxMaxTotalFeeUpdate() (contracts/bridge/BridgeGovernance.sol#825-857) ignores return value by (None,movingFundsDustThreshold,movingFundsTimeoutResetDelay,movingFundsTimeout,movingFundsTimeoutSlashingAmount,movingFundsTimeoutNotifierRewardMultiplier,movingFundsCommitmentGasOffset,movedFundsSweepTxMaxTotalFee,movedFundsSweepTimeout,movedFundsSweepTimeoutSlashingAmount,movedFundsSweepTimeoutNotifierRewardMultiplier) = bridge.movingFundsParameters() (contracts/bridge/BridgeGovernance.sol#826-838)     | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 44           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#1732-1750`                             | BridgeGovernance.finalizeFraudNotifierRewardMultiplierUpdate() (contracts/bridge/BridgeGovernance.sol#1732-1750) ignores return value by (fraudChallengeDepositAmount,fraudChallengeDefeatTimeout,fraudSlashingAmount,None) = bridge.fraudParameters() (contracts/bridge/BridgeGovernance.sol#1733-1738)                                                                                                                                                                                                                                                  | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 46           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#734-761`                               | BridgeGovernance.finalizeRedemptionTimeoutSlashingAmountUpdate() (contracts/bridge/BridgeGovernance.sol#734-761) ignores return value by (redemptionDustThreshold,redemptionTreasuryFeeDivisor,redemptionTxMaxFee,redemptionTxMaxTotalFee,redemptionTimeout,None,redemptionTimeoutNotifierRewardMultiplier) = bridge.redemptionParameters() (contracts/bridge/BridgeGovernance.sol#738-746)                                                                                                                                                               | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 50           | `1-1-unused-return`           | `contracts/bridge/BridgeGovernance.sol#479-494`                               | BridgeGovernance.finalizeDepositTxMaxFeeUpdate() (contracts/bridge/BridgeGovernance.sol#479-494) ignores return value by (depositDustThreshold,depositTreasuryFeeDivisor,None,depositRevealAheadPeriod) = bridge.depositParameters() (contracts/bridge/BridgeGovernance.sol#480-485)                                                                                                                                                                                                                                                                      | False positive: benign tuple destructuring / ignored getter return (pre-existing) |
| 62           | `3-0-unindexed-event-address` | `contracts/bridge/Bridge.sol#242-242`                                         | Event Bridge.RebateStakingSet(address) (contracts/bridge/Bridge.sol#242) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                                                                 | By design / Informational: singleton configuration event parameter (pre-existing) |
| 64           | `3-0-unindexed-event-address` | `contracts/bridge/Bridge.sol#238-238`                                         | Event Bridge.TreasuryUpdated(address) (contracts/bridge/Bridge.sol#238) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                                                                  | By design / Informational: singleton configuration event parameter (pre-existing) |
| 66           | `3-0-unindexed-event-address` | `contracts/bridge/BridgeState.sol#555-555`                                    | Event BridgeState.RedemptionWatchtowerSet(address) (contracts/bridge/BridgeState.sol#555) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                                                | By design / Informational: singleton configuration event parameter (pre-existing) |
| 67           | `3-0-unindexed-event-address` | `contracts/bridge/BridgeGovernance.sol#293-293`                               | Event BridgeGovernance.TreasuryUpdated(address) (contracts/bridge/BridgeGovernance.sol#293) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                                              | By design / Informational: singleton configuration event parameter (pre-existing) |
| 70           | `3-0-unindexed-event-address` | `contracts/bridge/Bridge.sol#243-246`                                         | Event Bridge.RebateStakingRepaired(address,address) (contracts/bridge/Bridge.sol#243-246) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                                                | By design / Informational: singleton configuration event parameter (pre-existing) |
| 73           | `3-0-unindexed-event-address` | `contracts/bridge/BridgeState.sol#561-561`                                    | Event BridgeState.RebateStakingSet(address) (contracts/bridge/BridgeState.sol#561) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                                                       | By design / Informational: singleton configuration event parameter (pre-existing) |
| 76           | `3-0-unindexed-event-address` | `contracts/bridge/BridgeGovernanceParameters.sol#350-350`                     | Event BridgeGovernanceParameters.TreasuryUpdateStarted(address,uint256) (contracts/bridge/BridgeGovernanceParameters.sol#350) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                            | By design / Informational: singleton configuration event parameter (pre-existing) |
| 78           | `3-0-unindexed-event-address` | `contracts/cross-chain/wormhole/L1BTCDepositorWormholeV2Arbitrum.sol#182-186` | Event L1BTCDepositorWormholeV2Arbitrum.TokensTransferredWithPayload(uint256,address,uint64) (contracts/cross-chain/wormhole/L1BTCDepositorWormholeV2Arbitrum.sol#182-186) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                | By design / Informational: singleton configuration event parameter (pre-existing) |
| 80           | `3-0-unindexed-event-address` | `contracts/cross-chain/starknet/StarkNetBitcoinDepositor.sol#54-54`           | Event StarkNetBitcoinDepositor.StarkNetBitcoinDepositorInitialized(address) (contracts/cross-chain/starknet/StarkNetBitcoinDepositor.sol#54) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                             | By design / Informational: singleton configuration event parameter (pre-existing) |
| 81           | `3-0-unindexed-event-address` | `contracts/bridge/BridgeState.sol#553-553`                                    | Event BridgeState.TreasuryUpdated(address) (contracts/bridge/BridgeState.sol#553) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                                                        | By design / Informational: singleton configuration event parameter (pre-existing) |
| 83           | `3-0-unindexed-event-address` | `contracts/bridge/BridgeGovernance.sol#292-292`                               | Event BridgeGovernance.TreasuryUpdateStarted(address,uint256) (contracts/bridge/BridgeGovernance.sol#292) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                                | By design / Informational: singleton configuration event parameter (pre-existing) |
| 91           | `3-0-unindexed-event-address` | `contracts/bridge/BridgeGovernance.sol#62-65`                                 | Event BridgeGovernance.BridgeGovernanceTransferStarted(address,uint256) (contracts/bridge/BridgeGovernance.sol#62-65) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                    | By design / Informational: singleton configuration event parameter (pre-existing) |
| 92           | `3-0-unindexed-event-address` | `contracts/bridge/BridgeGovernanceParameters.sol#351-351`                     | Event BridgeGovernanceParameters.TreasuryUpdated(address) (contracts/bridge/BridgeGovernanceParameters.sol#351) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                          | By design / Informational: singleton configuration event parameter (pre-existing) |
| 97           | `3-0-unindexed-event-address` | `contracts/bridge/Bridge.sol#240-240`                                         | Event Bridge.RedemptionWatchtowerSet(address) (contracts/bridge/Bridge.sol#240) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                                                                                                          | By design / Informational: singleton configuration event parameter (pre-existing) |
| 101          | `3-0-unindexed-event-address` | `contracts/cross-chain/wormhole/L1BTCDepositorWormholeV2Base.sol#178-182`     | Event L1BTCDepositorWormholeV2Base.TokensTransferredWithPayload(uint256,address,uint64) (contracts/cross-chain/wormhole/L1BTCDepositorWormholeV2Base.sol#178-182) has address parameters but no indexed parameters                                                                                                                                                                                                                                                                                                                                        | By design / Informational: singleton configuration event parameter (pre-existing) |
| 107          | `4-0-immutable-states`        | `contracts/bridge/BridgeGovernance.sol#47-47`                                 | BridgeGovernance.bridge (contracts/bridge/BridgeGovernance.sol#47) should be immutable                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Informational: state variable initialized in constructor/setter (pre-existing)    |

---
