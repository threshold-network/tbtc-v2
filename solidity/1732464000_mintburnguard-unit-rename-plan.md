# MintBurnGuard Unit Clarity & Rename Plan

## Goal
Clarify unit semantics (sats vs TBTC 1e18) by renaming identifiers, tightening docs, and aligning tests/configs without changing runtime behavior or units.

## Target naming scheme
- Storage/state (TBTC 1e18):
  - `totalMintedTbtc`
  - `globalMintCapTbtc`
  - `mintRateLimitTbtc`
  - `mintRateWindowAmountTbtc`
- Setter: `setTotalMintedTbtc` (owner-only as today unless changed).
- Events:
  - `TotalMintedIncreased/Decreased/Set` -> fields: `amountSats` (where applicable) or `amount`? keep amounts as-is per event purpose; rename `newTotalMinted` -> `newTotalMintedTbtc`.
  - `BankMintExecuted`, `BankBurnExecuted`, `ExposureReduced`, `VaultUnmintExecuted`: keep `amountSats` for per-call amounts; rename total field to `newTotalMintedTbtc`.
- Helper params: keep `amountSats` in all external helpers.
- Conversion helper: `_satsToTbtc` -> `_satsToTbtcUnits` (or similar explicit name).
- Top-level doc: add “Unit conventions” block stating helpers/events use sats; internal accounting/caps/rate limits use TBTC base units (1e18).

## Edit steps
1) Interfaces
   - Update `contracts/account-control/interfaces/IMintBurnGuard.sol` signatures and NatSpec to new names/units (functions, getters, events if declared, and setter).

2) Implementation
   - In `contracts/account-control/MintBurnGuard.sol` rename state vars, functions, events, and all internal references.
   - Update `_satsToTbtc` name and callers.
   - Add/expand file-level comment explaining dual-unit convention.
   - Adjust NatSpec on helpers/events to restate units explicitly.

3) Events
   - Rename event fields to `newTotalMintedTbtc`; ensure emits match new names.
   - Keep `amountSats` for per-call values.

4) Docs
   - Update `docs/bridge-controller-authorization-upgrade.md` (and any other guard doc) to reflect new identifiers and re-state unit split and rationale.

5) Tests & mocks
   - Update `test/account-control/MintBurnGuard.test.ts` to use new names and event field keys.
   - Refresh Typechain typings usage if needed after ABI change.
   - Adjust any deploy/config scripts in the repo that reference renamed ABI fields (search for `totalMinted`, `globalMintCap`, rate limit field names, and `setTotalMinted`).

6) Validation
   - Run `npx hardhat test test/account-control/MintBurnGuard.test.ts`.
   - If other suites depend on the ABI, run broader tests or targeted scripts.

7) Migration note
   - No on-chain rescaling: stored values remain in TBTC units; only identifiers and docs change. If upgrading a live deployment, ensure off-chain consumers (monitoring, dashboards) are updated to the new event field names.

## Decisions to confirm before execution
- Keep owner-only for `setTotalMintedTbtc`? (default: yes).
- Final name for conversion helper: `_satsToTbtcUnits` vs `_satsToTbtc` (preference: `_satsToTbtcUnits`).
- Whether to rename rate-limit window trackers; plan assumes yes.
