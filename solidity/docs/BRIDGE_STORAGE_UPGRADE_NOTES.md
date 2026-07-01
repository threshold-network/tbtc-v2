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

## walletPendingFraudChallenges slot consumption

- `BridgeState.Storage` added `mapping(bytes20 => uint32) walletPendingFraudChallenges`
  at `contracts/bridge/BridgeState.sol`, before `__gap`. It counts the fraud
  challenges open against each wallet so the wallet stays in `Closing` while a
  challenge can still mature.
- To preserve layout continuity, `__gap` was reduced from `uint256[47]` to
  `uint256[46]`.
- This change is intentional and must be reflected in any future storage-layout
  diff review before proxy upgrades.

## walletRegistrationOrder slot consumption

- `BridgeState.Storage` added `bytes20[] walletRegistrationOrder` at
  `contracts/bridge/BridgeState.sol`, before `__gap`. It records every wallet's
  20-byte public key hash in registration order so the moving-funds
  target-wallet selection can be reconstructed deterministically on-chain.
- To preserve layout continuity, `__gap` was reduced from `uint256[46]` to
  `uint256[45]`.
- This change is intentional and must be reflected in any future storage-layout
  diff review before proxy upgrades.

## walletRegistrationOrderSeeded slot

- `walletRegistrationOrderSeeded` was appended after `fraudChallengeEscrowSeeded`
  and packs into the same slot 130 (both are single-byte `bool` values placed
  consecutively). Fresh deployments set it during `initialize`; upgraded
  deployments start with the default `false` value.
- Until governance calls `seedWalletRegistrationOrder`, the on-chain order
  cannot reconstruct the canonical target-wallet set for wallets registered
  before the upgrade, so `MovingFunds.submitMovingFundsCommitment` rejects the
  commitment. Seeding it is a required precondition for resuming moving-funds
  commitments after the upgrade. The seed prepends the supplied pre-upgrade
  wallets and de-duplicates any that also registered post-upgrade, so it does
  not require an empty order.
