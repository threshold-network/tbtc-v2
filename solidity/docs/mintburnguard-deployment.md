# Bridge Upgrade & MintBurnGuard Runbook

A single reference for upgrading the Sepolia Bridge proxy, transferring governance, configuring the MintBurnGuard, and validating the end-to-end controller flow. Use this whenever you need to re-run the deployment from this PR (bridge upgrade + guard authorization).

## 1. Environment & Inputs
- Copy `.env.example` → `.env` and fill only the values you truly need for this run (Sepolia RPC URL, deployer key, Bridge/MintBurnGuard addresses, cap/rate numbers, library addresses). Secrets such as `BRIDGE_GOVERNANCE_PK`, `PROXY_ADMIN_PK`, `TENDERLY_ACCESS_TOKEN` stay in your shell (`source ~/.zshrc`).
- Required env vars before executing scripts:
  - Network: `SEPOLIA_CHAIN_API_URL` (RPC endpoint) and `SEPOLIA_PRIVATE_KEYS` (comma-separated list containing the deployer/governance key). Populate both before running `hardhat` commands.
  - Bridge: `BRIDGE_ADDRESS`, `BRIDGE_GOVERNANCE_ADDRESS`, `NEW_BRIDGE_GOVERNANCE`, `BRIDGE_CONTROLLER_ADDRESS` (usually the MintBurnGuard).
  - Support contracts when deployments cache is missing: `BANK_ADDRESS`, `LIGHT_RELAY_ADDRESS`, `WALLET_REGISTRY_ADDRESS`, `REIMBURSEMENT_POOL_ADDRESS`.
- MintBurnGuard: `MINTBURN_GUARD_ADDRESS`, `MINT_BURN_GUARD_GLOBAL_CAP`, `MINT_BURN_GUARD_RATE_LIMIT`, `MINT_BURN_GUARD_RATE_WINDOW`, `MINT_BURN_GUARD_INITIAL_TOTAL_MINTED` (optional), `CONFIGURE_MINT_BURN_GUARD=true`.
  - `MINT_BURN_GUARD_INITIAL_TOTAL_MINTED` is the on-chain `totalMintedTbtc` seed for a freshly deployed guard; it preserves accounting continuity when the guard must be redeployed, so the new instance starts from the same exposure.
  - `MINT_BURN_GUARD_INITIAL_TOTAL_MINTED` must be `<= MINT_BURN_GUARD_GLOBAL_CAP` when the cap is non-zero; the constructor enforces this to prevent starting above the cap.
  - For Sepolia redeploys, snapshot the existing guard `totalMintedTbtc` and set `MINT_BURN_GUARD_INITIAL_TOTAL_MINTED` to that exact value unless you intentionally want to reset exposure (this redeploy uses `0` per request).
  - Upgrade toggles: `ENABLE_UPGRADE_BRIDGE=true` when running the bridge script; `ENABLE_POST_UPGRADE_GOVERNANCE=true` only if you want the upgrade tag to mutate MintBurnGuard controller after upgrade (defaults to skip); `ALLOW_LOCAL_UPGRADE=true` permits local dry-runs.
  - Safety overrides (discouraged): `ALLOW_STORAGE_SKIP`, `ALLOW_RENAMED_STORAGE`, or `UPGRADE_SAFETY_PRESET=relaxed` to bypass storage checks; `ALLOW_BRIDGE_CACHE_FROM_ENV` to write deployment cache from `BRIDGE_ADDRESS`; `BRIDGE_CONTROLLER_AUTHORIZE_DRY_RUN=true` skips the authorization tx. Leave all `false`/`strict` unless a reviewed plan exists.

## 2. Script Checklist
| Phase | Script / Command | Notes |
| --- | --- | --- |
| Bridge upgrade | `ENABLE_UPGRADE_BRIDGE=true npx hardhat deploy --tags UpgradeBridge --network sepolia --show-stack-traces` | Runs `deploy/80_upgrade_bridge_v2.ts`; proxy admin ownership + prerequisite checks; storage checks ON by default. Set `ALLOW_STORAGE_SKIP=true` / `ALLOW_RENAMED_STORAGE=true` or `UPGRADE_SAFETY_PRESET=relaxed` only with a reviewed diff. `ALLOW_LOCAL_UPGRADE=true` permits local dry-runs; otherwise hardhat/localhost auto-skip to prevent accidental mutations. Post-upgrade governance mutations run only when `ENABLE_POST_UPGRADE_GOVERNANCE=true`. |
| Governance transfer | `npx hardhat run scripts/bridge-governance-handoff.ts --network sepolia` | Initiates transfer and exits with a “finalize after” timestamp; rerun after the delay to finalize (no long sleeps). |
| MintBurnGuard deploy (optional) | `npx hardhat run scripts/mintburnguard-deploy.ts --network sepolia` | Wraps the MintBurnGuard deploy function without running Bridge dependencies. Fails if owner/controller after deploy differ from requested values, so misconfigurations surface loudly. |
| MintBurnGuard configuration | `CONFIGURE_MINT_BURN_GUARD=true npx hardhat run deploy/45_configure_mint_burn_guard.ts --network sepolia` | Reads guard address from deployments cache or `MINTBURN_GUARD_ADDRESS`, requires owner signer, only updates cap/rate values when needed, then prints remaining capacity / pause state. |
| MintBurnGuard controller wiring | `npx hardhat run scripts/mintburnguard-set-controller.ts --network sepolia` | Sets `MintBurnGuard.setController(MINT_BURN_GUARD_CONTROLLER)` via the guard owner (defaults to governance); run once AccountControl is deployed. |
| Controller authorization | `npx hardhat run scripts/bridge-controller-authorize.ts --network sepolia` | Uses `BRIDGE_GOVERNANCE_PK` to call `BridgeGovernance.setControllerBalanceIncreaser`; add `BRIDGE_CONTROLLER_AUTHORIZE_DRY_RUN=true` for validation-only mode. |
| Controller health check (read-only) | `BRIDGE_CONTROLLER_SYNC_DRY_RUN=true npx hardhat run scripts/bridge-controller-sync.ts --network sepolia` | Reuses the shared helper to prove the bridge/guard mapping is still correct without sending transactions. |

## 3. Execution Flow
1. **Environment validation**
   - `source ~/.zshrc && source .env` to load secrets + required variables.
   - Optional sanity check: `npx hardhat console --network sepolia --show-stack-traces` and evaluate `await hre.ethers.provider.getBlockNumber()`.
2. **Bridge upgrade**
   - Run the UpgradeBridge tag with `ENABLE_UPGRADE_BRIDGE=true` (storage checks on by default). Only set `ALLOW_STORAGE_SKIP`/`ALLOW_RENAMED_STORAGE` when a reviewed storage diff exists.
   - The script prints: proxy admin owner, governance owner, verification gates for Bridge / Bank / LightRelay / WalletRegistry / ReimbursementPool / MintBurnGuard, library bytecode comparisons, tx hash, and new implementation address. Post-upgrade governance/controller mutations are skipped unless `ENABLE_POST_UPGRADE_GOVERNANCE=true`.
   - Tenderly verification is best-effort (still logs a warning if their API returns 500).
3. **Governance transfer**
   - Use `scripts/bridge-governance-handoff.ts` with `BRIDGE_GOVERNANCE_PK` in the shell.
   - Script behavior: checks signer owns `BridgeGovernance`, confirms Bridge currently points to that governance contract, initiates transfer if needed, waits the configured delay (60s on Sepolia), finalizes, re-checks Bridge.governance(), and logs begin/finalize tx hashes.
4. **MintBurnGuard configuration**
   - Run `deploy/45_configure_mint_burn_guard.ts` via `hardhat run` (so no other deploy scripts execute). This script now supports both cached deployments and pure env overrides.
   - Outputs: signer address, guard owner status, before/after cap & rate limit comparisons, remaining capacity, pause status, minted amounts. Errors if `totalMintedTbtc` exceeds the cap or if minting is paused unexpectedly.
   - If you need to redeploy the guard first, run the tag `npx hardhat deploy --tags MintBurnGuard --network sepolia` and then rerun the security script.
5. **MintBurnGuard controller wiring**
   - Execute `scripts/mintburnguard-set-controller.ts` (requires `MINT_BURN_GUARD_CONTROLLER` to be set to the AccountControl address). Script enforces signer ownership, skips the transaction when the controller already matches, and logs the transaction hash when a change is applied.
6. **Controller authorization**
   - Execute `scripts/bridge-controller-authorize.ts` (or set `BRIDGE_CONTROLLER_AUTHORIZE_DRY_RUN=true` for validation-only). It enforces:
     - `Bridge.governance()` equals `BRIDGE_GOVERNANCE_ADDRESS`.
     - Signer owns the governance contract.
     - `setControllerBalanceIncreaser` exists on the governance ABI.
     - MintBurnGuard cap/rate/window match env values and minting is active.
   - If `Bridge.controllerBalanceIncreaser()` already equals `MINTBURN_GUARD_ADDRESS`, it logs `✅ Controller already set; skipping transaction.` Otherwise it submits the tx, waits for 1 confirmation, and re-checks the pointer. Warns if `authorizedBalanceIncreasers` mapping is unavailable or if `MintBurnGuard.controller()` is still zero (expected for governance-managed guards).
7. **Read-only controller verification**
   - Run the dry-run sync script once to document that the bridge controller plan is empty (`Controller already configured; nothing to do.`). This doubles as a post-deploy health check.

## 4. Verification Gates & Success Criteria
- **Bridge upgrade gates**: proxy admin ownership check, Bridge/Governance/Bank/LightRelay/WalletRegistry/ReimbursementPool deployment assertions, optional MintBurnGuard existence, external library bytecode comparison, governance state validation, controller preservation.
- **Governance transfer gates**: signer owns `BridgeGovernance`, Bridge currently points to old governance, enforced delay before finalize.
- **MintBurnGuard gates**: signer must be owner; cap/rate inputs parsed from env; script halts if minting paused or `totalMintedTbtc` > cap; controller wiring script also validates owner access before calling `setController`.
- **Controller authorization gates**: matching governance pointer, governance signer ownership, guard parameters aligned with env configuration, optional controller transaction when needed, final state logs.
- **Success criteria**:
  1. `Bridge.controllerBalanceIncreaser()` equals `MINTBURN_GUARD_ADDRESS` and the upgrade script’s post-check logs `✅ Controller address preserved` (or updated as expected).
 2. MintBurnGuard cap/rate settings match env values; `mintingPaused=false`; remaining capacity > 0.
 3. MintBurnGuard.controller() equals the deployed AccountControl contract.
 4. Governance contract ownership remains under the intended multisig address after transfer.
 5. Dry-run sync shows “controller already configured.”

## 5. Rollback & Recovery
- Keep the previous Bridge implementation address (printed by the upgrade script). You can downgrade via `ENABLE_UPGRADE_BRIDGE=true npx hardhat deploy --tags UpgradeBridge` while pointing `DEPLOY` to the earlier artifact.
- Emergency guard disable: run `npx hardhat run --network sepolia -e "const { ethers } = require('hardhat'); (async () => { const gov = await ethers.getSigner(process.env.BRIDGE_GOVERNANCE_PK ? (new ethers.Wallet(process.env.BRIDGE_GOVERNANCE_PK, ethers.provider)).address : (await ethers.getSigners())[0].address); const bridgeGov = await ethers.getContractAt('BridgeGovernance', process.env.BRIDGE_GOVERNANCE_ADDRESS, gov); await bridgeGov.setControllerBalanceIncreaser(ethers.constants.AddressZero); })().catch(console.error);"` to reset the controller.
- Always inspect logs from the scripts above; each emits `✅`/`⚠️` checkpoints that indicate whether a retry or manual intervention is required.

## 6. Notes & References
- Tenderly project: `pioros/project`. Keep `TENDERLY_ACCESS_TOKEN` in your shell. Upload artifacts via `hardhat tenderly:push` if you need to re-run simulations.
- Library addresses (`DEPOSIT_LIB_ADDRESS`, `DEPOSITSWEEP_LIB_ADDRESS`, etc.) should match the Sepolia deployments already recorded in `.env.example`. Update them only when a library is redeployed, then rerun the upgrade script’s verification step.
- This runbook supersedes the previous `docs/GOVERNANCE_UPGRADE.md`, `docs/mint-burn-guard.md`, and `docs/sepolia-deployment-plan.md`. All deployment/configuration guidance now lives here.
- Mint rate limit behavior: the first mint after configuring `setMintRateLimit` (or after a full window gap) anchors the new window start. Idle periods reset the window, so monitor the first post-idle mint size to avoid a surprise spike; alerts on `MintRateLimitExceeded` and on large first mints are recommended.
- Owner-only `setTotalMintedTbtc` updates the accounting baseline (same permissions as pause/other admin controls), enforces the cap when set, and emits `TotalMintedSet`.
- Latest Sepolia controller change (2025-12-19): Bridge controllerBalanceIncreaser switched to MintBurnGuard `0x19AAC2d5D2DbA9C987c497E81149B56fEF1006D7` via BridgeGovernance (`0x74122bdcD585d07156e537B13A7c948c2b6034b3`), tx `0x5f3250850b8458d9affea716ab5c5835e8a179ba48a71da7146201fde5bddc2a`.
- Latest MintBurnGuard execution target wiring (2025-12-19): `bridge=0x9b1a7fE5a16A15F2f9475C5B231750598b113403`, `bank=0x4918fD33a22e7E2948B7444CbDd68efAa9E6a087`, `vault=0xB5679dE944A79732A75CE556191DF11F489448d5` via tx `0x3c3f3a2a734d7da17ae3264020b037810145576bb790c6a3563de9543ea1f4ac`.
- Latest MintBurnGuard redeploy (2025-12-19): deployed `0x19AAC2d5D2DbA9C987c497E81149B56fEF1006D7` via owner `0xF4767Aecf1dFB3a63791538E065c0C9F7f8920C3`, tx `0x5a711112bb96ddb4a73d43ac89c54c39ef7713be3a73a01a9fe08cdf0d83a094`, block `9873135`. Constructor seeded `totalMintedTbtc=0` and `globalMintCapTbtc=5000e18`, controller set to `0x6a9f7ba9994e368f360b85214015AFc82B85581F`.
