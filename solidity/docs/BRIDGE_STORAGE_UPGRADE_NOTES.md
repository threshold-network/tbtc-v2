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
- The Sepolia Stage-3 combined upgrade (`Wallets.migrateV6Stage3Combined`,
  invoked from `Bridge.initializeV6_Stage3Combined`) seeds the same slot 129
  directly in the reinitializer instead of through `seedFraudChallengeEscrow`.
  It enforces the event-derived open-challenge sum only as a lower bound on
  the live Bridge ETH balance, then seeds slot 129 from the full live
  balance — not the supplied sum. Forced or otherwise unattributed ETH sent to
  the Bridge before the upgrade (which cannot be distinguished on-chain from a
  genuine late challenge deposit) is therefore conservatively folded into the
  escrow accounting rather than left unclassified or allowed to block the
  upgrade indefinitely. This migration path reuses the existing slot 129 /
  slot 130 layout described above; it introduces no field, slot, packing, gap,
  or storage type change.

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

## covenantSpendAuthorization slot

- `covenantSpendAuthorization` (an `address`) was appended after
  `walletRegistrationOrderSeeded`. It does **not** consume a fresh absolute slot:
  its 20 bytes pack into the same slot 130 as `fraudChallengeEscrowSeeded`
  (offset 0) and `walletRegistrationOrderSeeded` (offset 1), occupying offset 2
  (bytes 2–21 of the slot). On upgrade those bytes were previously zero, so it
  reads as `address(0)` and no existing field moves. `Bridge.self` starts at
  absolute slot 51, so this field's relative slot 79 maps to absolute slot 130.

## legacyVaultOptimisticMintingDebtCoordinator slot

- `mapping(address => address) legacyVaultOptimisticMintingDebtCoordinator` was
  appended after `covenantSpendAuthorization`, before nothing (it is the last
  field). A mapping root always starts a fresh slot, so it occupies relative
  slot 80 in `BridgeState.Storage`, absolute Bridge proxy slot 131. Its keyed
  values live at `keccak256(abi.encode(vault, uint256(131)))`; the mapping root
  slot 131 stores no packed data and cannot collide with the packed slot-130
  fields.
- `__gap` (`uint256[45]`, absolute slots 84–128) is unchanged and MUST NOT be
  resized or moved. No pre-existing field moves. Live slots 130 and 131 were both
  observed as zero on the deployed Bridge before the upgrade.
- The zero default makes the exact known mainnet legacy `TBTCVault` fail closed
  for untrust/rotation as soon as the new implementation is active; governance
  unlocks retirement only via the explicit
  `setLegacyVaultOptimisticMintingDebtAttestation` transition, which binds the
  vault to its dedicated, locked migration coordinator.
- This change is intentional and must be reflected in any future storage-layout
  diff review before proxy upgrades. The compiler-derived layout is asserted by
  `test/bridge/BridgeState.StorageLayout.test.ts`.
