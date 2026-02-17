# Bridge Upgrade: Controller Authorization Allowlist (Explainer + Sepolia Report)

## Summary

- Objective: pin the Bridge’s controller pointer to a single governance‑managed MintBurnGuard instance that can mint via the Bridge by increasing Bank balances.
- Approach: upgrade the Bridge proxy implementation to add the controller pointer and execution entrypoints; redeploy BridgeGovernance with a forwarder setter; transfer governance; optionally sync the configured controller.
- Safety: evented changes, explicit zero‑address checks, governance‑only setters, snapshot + rollback tooling.

> **Note on AccountControl integration:** For AccountControl‑managed flows, the **MintBurnGuard** primitive (implemented in `solidity/contracts/account-control/MintBurnGuard.sol`) is the _only_ contract that should ever be configured as the Bridge controller via `setControllerBalanceIncreaser`. AccountControl itself is never directly authorized on the Bridge; instead, it acts as the sole controller of MintBurnGuard, and MintBurnGuard acts as the sole controller of the Bridge for those flows, executing both mint and burn/unmint operations on tBTC v2.

## Motivation

Integrations need a narrow, auditable way to mint balances through the Bridge without broad privileges. Introducing an “authorized balance increaser” allowlist lets governance approve specific controller contracts to call controlled minting functions, minimizing surface area while preserving the existing flow and roles.

This model provides:

- A least‑privilege controller minting gate on the Bridge.
- On‑chain audit trail via events.
- Operationally simple management via BridgeGovernance.
- A clean separation between:
  - Bridge: controller pointer + minting entrypoints + events. Bridge **does not** implement per‑controller caps or rate limits; it only enforces _who_ can mint.
- System-level net exposure caps and pauses, enforced by MintBurnGuard
  (implemented in `solidity/contracts/account-control/MintBurnGuard.sol`) and higher-level controller logic
  (e.g. AccountControl), which must route all AccountControl-managed TBTC
  mint and burn/unmint flows through MintBurnGuard.

- Controllers are high‑privilege actors. BridgeGovernance must point
  `setControllerBalanceIncreaser` at a reviewed MintBurnGuard before any
  controller-driven minting flow is enabled, and it should only be changed
  through the same multi-sig/change-review process that governs other
  system-critical parameters.
- Off-chain monitoring should alert on any unexpected `ControllerBalanceIncreaserUpdated`
  events or unusually large `BalanceIncreased` events; the controller pointer is now the
  main indicator of governance changes.
- The controller configuration tooling is intentionally conservative:
  - When no controller address is supplied via `BRIDGE_CONTROLLER_ADDRESS`,
    it simply reports the current pointer and exits without submitting
    transactions.
  - When `BRIDGE_CONTROLLER_SYNC_DRY_RUN=true`, it logs the plan without
    submitting any on-chain updates.
    Operationally, controllers should be treated as part of the governance surface
    area and managed via the same change‑management process (multi‑sig, change
    review, deployment runbooks, and monitoring).

## What Changed (Contracts)

- Bridge (proxy):
  - New state:
    - `controllerBalanceIncreaser` – a single governance‑managed controller contract that can increase Bank balances.
  - New events:
    - `ControllerBalanceIncreaserUpdated(address indexed previousController, address indexed newController)`.
    - `ControllerBalanceIncreased(address,address,uint256)`.
    - `ControllerBalancesIncreased(address,address[],uint256[])`.
  - New methods:
    - `setControllerBalanceIncreaser(address)` – owner‑only setter used by BridgeGovernance.
    - `controllerBalanceIncreaser() -> address` – read-only pointer for off-chain tooling.
    - `controllerIncreaseBalance(address,uint256)` / `controllerIncreaseBalances(address[],uint256[])` – entrypoints guarded by the pointer.
- BridgeGovernance (regular contract):
  - New owner‑only forwarder:
    - `setControllerBalanceIncreaser(address)` – updates the Bridge pointer.
- MintBurnGuard (global mint/burn guard implemented in `solidity/contracts/account-control/MintBurnGuard.sol`):
  - State:
    - `controller` – the only contract allowed to adjust totals and execute mints/burns (for AccountControl flows, this is `AccountControl`).
    - `totalMinted` – global net‑minted TBTC exposure for controller‑managed flows (expressed in TBTC satoshis, 1e8).
    - `globalMintCap` – optional system‑level cap on `totalMinted` (0 disables, value in satoshis).
    - `mintingPaused` – global pause flag for controller‑driven minting.
    - References to core tBTC v2 contracts:
      - `IBridgeMintingAuthorization bridge` – used to mint TBTC into the Bank via `controllerIncreaseBalance(s)`; MintBurnGuard converts satoshi-denominated inputs to 1e18 TBTC base units for Bridge/Bank/Vault calls.
      - Minimal Bank/Vault interfaces for burn/unmint operations.
  - Methods (high‑level):
    - Accounting helpers:
      - `setTotalMinted(uint256 newTotal)` – owner-only accounting helper for migrations/corrections; controllers cannot mutate totals directly and cap checks apply.
    - Mint executor:
      - `mintToBank(address recipient, uint256 tbtcAmount)` – enforces `mintingPaused` and `globalMintCap`, bumps `totalMinted`, emits a `BankMintExecuted` event, and calls `bridge.controllerIncreaseBalance(recipient, tbtcAmount)` with the satoshi amount converted to TBTC base units (1e18) to mint into the Bank.
    - Burn/unmint executors:
      - `burnFromBank(address from, uint256 tbtcAmount)` – decreases `totalMinted`, emits `BankBurnExecuted`, and calls Bank to burn TBTC from the given Bank balance (converted from satoshis to TBTC base units).
      - `unmintFromVault(uint256 tbtcAmount)` – decreases `totalMinted`, emits `VaultUnmintExecuted`, and calls Vault to unmint/burn TBTC held in the vault (converted from satoshis to TBTC base units).
    - Governance:
      - `setGlobalMintCap(uint256 newCap)` – owner‑only.
      - `setMintingPaused(bool paused)` – owner‑only.
      - `setController(address newController)` / `setBridge(...)` / `setBank(...)` / `setVault(...)` – owner‑only wiring functions.
    - Units:
      - Controller/owner inputs, caps, rate limits, and events use satoshis (1e8).
      - Mint/Burn/Unmint execution calls convert satoshi inputs to TBTC base units (1e18) for Bridge/Bank/Vault interactions.
    - Configuration notes:
      - Keep `globalMintCap` (when enabled) ≥ current `totalMinted` and any active `mintRateLimit`; prefer tightening after pausing to avoid unexpected mint reverts.
      - `setMintRateLimit(limit, windowSeconds)` requires `windowSeconds > 0` when `limit > 0` and `limit` ≤ `globalMintCap` when the cap is set; calling it resets the rate window.
  - Access model:
    - A single controller address (e.g. AccountControl) is allowed to use the execution helpers.
    - The owner (tBTC governance) configures caps, pauses, and underlying core contract references.
  - Roles/Usage:
    - Governance/owner: sets the Bridge controller pointer to MintBurnGuard, wires bridge/bank/vault, sets `globalMintCap`/`mintRateLimit`/`mintingPaused`, and uses `setTotalMinted` for migrations; AccountControl cannot change totals.
    - Controller (AccountControl): after validating reserve caps/backing, calls `mintToBank`/`burnFromBank`/`unmintFromVault` with satoshi amounts; these are the only controller-facing helpers and they obey the guard’s pause/cap/rate checks.
  - Flow:
    - AccountControl validates reserve/backing → calls MintBurnGuard (sats) → MintBurnGuard enforces pause/cap/rate, updates accounting, converts to 1e18, and forwards to Bridge/Bank/Vault for execution. Bridge is only whitelisting MintBurnGuard as the controller.
- New interface for integrators: `IBridgeMintingAuthorization` (minimal Bridge surface consumed by controller logic such as AccountControl).

## Why Governance Redeploy Is Needed

- Bridge’s governance role is the BridgeGovernance contract address. To manage the new allowlist on Bridge, BridgeGovernance itself must expose the matching forwarder function.
- The legacy governance contract does not have it, so we deploy a fresh BridgeGovernance and transfer Bridge governance to the new instance (governance delay applies).

## Upgrade Plan (High‑Level)

1. Pre‑upgrade snapshot of Bridge state (implementation/admin/governance, parameters, controllers).
2. Upgrade Bridge proxy implementation via ProxyAdmin to the version with the controller pointer entrypoints.
3. Redeploy BridgeGovernance (fresh instance) and transfer governance:
   - Begin transfer, wait governance delay, finalize.
4. Optionally sync the configured controller pointer from env/config; emit `ControllerBalanceIncreaserUpdated` for changes.
5. Post‑upgrade snapshot; compare and archive.

Supporting scripts (names as in repo):

- `solidity/deploy/80_upgrade_bridge_v2.ts` — upgrade Bridge, resolve libraries/addresses, conditional Tenderly verify.
- `solidity/deploy/09_deploy_bridge_governance.ts` — deploy BridgeGovernance (+Parameters), conditional Tenderly verify.
- `solidity/deploy/21_transfer_bridge_governance.ts` + `solidity/deploy/utils/governance-transfer.ts` — initiate/finalize governance transfer while respecting the governance delay (with optional begin‑only/finalize‑only modes for long delays).
- `solidity/scripts/configure-bridge-controllers.ts` + `solidity/deploy/utils/bridge-controller-authorization.ts` — ensure the Bridge controller pointer matches `BRIDGE_CONTROLLER_ADDRESS` when explicitly invoked as a Hardhat script.

## Risks & Mitigations

- Storage layout changes: Bridge reserves a slot for `controllerBalanceIncreaser` and keeps an ample storage gap; MintBurnGuard is a separate contract with its own state. Upgrade paths are accounted for in implementation.
- Misconfiguration risk (controller pointer): controller updates are still gated by governance and subject to `ControllerBalanceIncreaserUpdated` events; the sync tooling logs the planned pointer before submitting txs.
- Controller over‑minting risk:
  - Bridge enforces _who_ can mint but does not implement per‑controller caps or rate limits.
  - System‑level net exposure caps and global pauses are enforced by MintBurnGuard and controller logic (e.g. AccountControl) which must call MintBurnGuard on every net mint/burn operation.
  - Controllers are still expected to implement their own internal limits and pause/kill switches; MintBurnGuard is a coarse global circuit breaker, not a per‑reserve/per‑user policy engine.
- Tenderly availability: verification is conditional on local Tenderly config to avoid deployment failures.

## Environment Notes

- Env keys used during orchestration include: `BRIDGE_ADDRESS`, `PROXY_ADMIN_PK`, `BRIDGE_GOVERNANCE_PK`, `BRIDGE_CONTROLLER_ADDRESS`, `BRIDGE_CONTROLLER_SYNC_DRY_RUN`, and library/core contract address fallbacks.
- Controller configuration tooling is driven by `BRIDGE_CONTROLLER_ADDRESS`; omit it to leave the current pointer untouched or set `BRIDGE_CONTROLLER_SYNC_DRY_RUN=true` to only log the planned update.
- Sepolia RPC: prefer `SEPOLIA_CHAIN_API_URL`/`SEPOLIA_PRIVATE_KEYS` where applicable.
- Governance transfer helper: `BRIDGE_GOVERNANCE_TRANSFER_MODE` can be set to `begin`, `finalize`, or left unset (default `begin`) to control how `21_transfer_bridge_governance.ts` orchestrates begin/finalize steps for long governance delays.

---

## Appendix A: Sepolia Execution Report – Controller Allowlist Upgrade

The following section preserves the original Sepolia run report for traceability.

### Overview

- Proxy address: `0x9b1a7fE5a16A15F2f9475C5B231750598b113403`
- New implementation: `0x1c19BBF9afAfe5e8EA4F78c1178752cE62683694`
- Proxy admin: `0x39f60B25C4598Caf7e922d6fC063E9002db45845`
- New BridgeGovernance: `0x78c99F5B8981A7FDa02E9700778c8493b2eb7D6b`
- Upgrade signer: `0x68ad60CC5e8f3B7cC53beaB321cf0e6036962dBc`
- Governance owner: `0xF4767Aecf1dFB3a63791538E065c0C9F7f8920C3`

### Actions Performed

1. Bridge proxy upgrade  
   Executed `ProxyAdmin.upgrade` (tx `0x05e00adfc9f091443eb44ea619cac497ff9aa32a27e49539716a93ae8ed5a7fd`), swapping the Bridge proxy’s implementation to `0x1c19…`. The proxy address and admin remained unchanged (`deployments/sepolia/Bridge.json`).

2. BridgeGovernance redeployment  
   Deployed a fresh governance contract at `0x78c99F5…` with governance delay `60` seconds and finalized ownership to the treasury signer (`deployments/sepolia/BridgeGovernance.json`).

3. Environment updates  
   Updated `.env` and `.env.sepolia` to point at the new governance address and to use the treasury signer private key for governance actions.

4. Snapshots & tooling  
   Captured pre/post-upgrade snapshots in an internal upgrade log and verified proxy admin / implementation slots to confirm the upgrade.

### Post‑Upgrade State Verification

- `Bridge` proxy implementation slot resolves to `0x1c19…`; proxy admin slot remains `0x39f60B25…`.
- `Bridge.governance()` returns the new governance address `0x78c99F5…`.
- Bridge parameter structs, trusted vault list (vault `0xB5679dE…`), and SPV maintainers (`0x3Bc9a80…`, `0x68ad60…`) match pre-upgrade values.
- BridgeGovernance reports the treasury signer as owner and retains the 60 second governance delay.

### Summary

The Sepolia bridge stack now runs the refreshed Bridge implementation behind the existing proxy while delegating governance to the newly deployed BridgeGovernance contract. All intended configuration, allowlists, and operational parameters were carried forward without deviation. No outstanding issues were observed.

---

## Appendix B: Sepolia Execution Report – BridgeGovernance Redeploy (2025‑11‑16)

This appendix summarizes a later Sepolia operation where only `BridgeGovernance` was redeployed from current sources, without changing the Bridge proxy or its parameters, in order to restore a verifiable governance contract that can manage the controller allowlist.

### Overview

- Date (UTC): 2025-11-16
- Network: Sepolia (chainId 11155111)

### Objective

Redeploy `BridgeGovernance` from current sources and transfer `Bridge.governance()` to the new contract so that the controller allowlist (`setAuthorizedBalanceIncreaser`) can be used and verified, without changing the Bridge proxy or its parameters.

### Before

- Bridge proxy: `0x9b1a7fE5a16A15F2f9475C5B231750598b113403`
- Bridge implementation (EIP-1967): `0x1c19BBF9afAfe5e8EA4F78c1178752cE62683694`
- Bridge governance: `0xAe0A3Fdfc51718E0952b3BcC03f672eB13917558` (unverified and not reproducible from git)

Parameters (deposit, redemption, moving funds, wallet), treasury and external references (Bank, Relay, WalletRegistry, ReimbursementPool) were all in the expected state and preserved.

### Actions

- Deployed new `BridgeGovernance` from current sources.
  - Address: `0x459FcE83bF5CF413D793D5bBD79E81010e8599c2`
  - Constructor args: `(bridge = 0x9b1a7fE5a16A15F2f9475C5B231750598b113403, governanceDelay = 60)`
- Transferred governance on Bridge (old → new) using the old governance owner (`0x68ad60CC5e8f3B7cC53beaB321cf0e6036962dBc`).
  - After transfer: `Bridge.governance()` returns `0x459F…`
- Verified contracts on Sepolia via `npx hardhat verify`:
  - `BridgeGovernanceParameters` at `0x38CF632a41411e45d1c55A8F8E2586c8a69b2BB1`
  - Bridge implementation at `0x32498B20c542eAd1207006bdAe8D9D0085c6cd39`
  - New `BridgeGovernance` at `0x459F…` (`https://sepolia.etherscan.io/address/0x459FcE83bF5CF413D793D5bBD79E81010e8599c2#code`)
- Smoke-tested the controller allowlist:
  - Called `setAuthorizedBalanceIncreaser(0x0000000000000000000000000000000000000001, true)` via the new governance owner; confirmed `authorizedBalanceIncreasers(testAddr) == true`, then reverted it back to `false`.

### After

- Bridge proxy: `0x9b1a7fE5a16A15F2f9475C5B231750598b113403` (unchanged)
- Bridge implementation: `0x32498B20c542eAd1207006bdAe8D9D0085c6cd39` (contains allowlist entrypoints)
- Bridge governance: `0x459FcE83bF5CF413D793D5bBD79E81010e8599c2`
- Governance owner: `0x68ad60CC5e8f3B7cC53beaB321cf0e6036962dBc`
- No controllers are currently authorized; the allowlist feature is live and verified, but left empty by design.

Snapshots before and after the change are recorded in the internal upgrade log used for Sepolia operations (not committed to this repository).
