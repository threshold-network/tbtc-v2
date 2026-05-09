# Bridge Storage Upgrade Notes

## migrationDebtVault slot consumption

- `BridgeState.Storage` added `migrationDebtVault` at
  `contracts/bridge/BridgeState.sol`.
- As part of this upgrade, `__gap` was reduced from `uint256[48]` to
  `uint256[47]` to preserve layout continuity.
- This change is intentional and must be reflected in any future storage-layout
  diff review before proxy upgrades.

## fraud challenge escrow slots

- `openFraudChallengeEscrow` was appended at slot 129. It tracks the sum of
  `depositAmount` over currently open fraud challenges so `recoverETH` cannot
  rescue challenge-backed ETH.
- `fraudChallengeEscrowSeeded` was appended at slot 130. Fresh deployments set
  it during `initialize`; upgraded deployments start with the default `false`
  value and must call `seedFraudChallengeEscrow` through governance after the
  upgrade.
- Until the seed runs, `recoverETH` and new fraud-challenge submissions are
  disabled. Pre-upgrade challenges can still resolve; if they do so before the
  seed, they are omitted from the one-time seed. Challenges submitted after the
  seed are marked as counted on submit.
