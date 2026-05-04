# Bridge Storage Upgrade Notes

## migrationDebtVault slot consumption

- `BridgeState.Storage` added `migrationDebtVault` at
  `contracts/bridge/BridgeState.sol`.
- As part of this upgrade, `__gap` was reduced from `uint256[48]` to
  `uint256[47]` to preserve layout continuity.
- This change is intentional and must be reflected in any future storage-layout
  diff review before proxy upgrades.
