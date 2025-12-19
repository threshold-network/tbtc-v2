# MintBurnGuard Hardening Plan (controller accounting lock-down)

## Context
- Current guard exposes controller-callable pure accounting methods (`increaseTotalMinted`, `decreaseTotalMinted`, `reduceExposureAndBurn`) that can desync accounting vs. actual TBTC supply if misused or malicious.
- Bridge enforces *who* can mint but not *how much*; guard caps/pauses rely on accurate controller reporting.

## Goal
Eliminate the ability for the controller to “free capacity” without actually burning/unminting TBTC. Restrict raw accounting to governance-only reconciliation, and couple controller flows to execution helpers.

## Proposed changes
1. Lock down raw accounting
   - Change `increaseTotalMinted` and `decreaseTotalMinted` to `onlyOwner` (or `internal`) and document as migration/reconciliation helpers.
   - Remove `reduceExposureAndBurn` or make it `onlyOwner`; it is accounting-only.

2. Controller-facing flows (keep)
   - `mintToBank(recipient, amount)` → bumps totals + calls Bridge `controllerIncreaseBalance`.
   - `burnFromBank(from, amount)` → bumps totals down + `bank.decreaseBalance`.
   - `unmintFromVault(amount)` → bumps totals down + `vault.unmint`.
   - Optional: add `mintToBankMany` to support batch mints without reopening raw accounting.

3. Governance reconciliation helper
   - If needed, add `adjustTotalMinted(int256 delta)` `onlyOwner` for rare resyncs; emits a dedicated event and is **not** callable by controller.

4. Optional rollout safety
   - Introduce `strictMode` (bool, owner-set): when true, controller calls to raw accounting revert. Default `false` for migration, flip to `true` post-rollout. Remove mode after cutover if desired.

5. Tests & tooling updates
   - Update controller/AC tests to use execution helpers (and `mintToBankMany` if added).
   - Remove/adjust any scripts using raw accounting.
   - Add negative tests confirming controller cannot call locked methods in `strictMode` (or after removal).

## Risks / impact
- ABI breaking: AccountControl or any integrator using raw accounting must be updated.
- Batch mint flows need the new helper or multiple `mintToBank` calls.
- Governance misuse of reconciliation helper could still desync totals; treat as emergency-only and monitor.

## Monitoring
- Continue to alert on divergence between Bank/Vault balances and `TotalMinted{Increased,Decreased}` events.
- Alert on any call to reconciliation helper (owner-only) to flag manual interventions.
