# Bridge Upgrade: Controller Authorization Allowlist (Explainer + Sepolia Report)

## Summary

- Objective: enable a governance‑managed allowlist of controller contracts that can mint via the Bridge by increasing Bank balances.
- Approach: upgrade the Bridge proxy implementation to add the allowlist and controller entrypoints; redeploy BridgeGovernance with a forwarder function; transfer governance; optionally sync the allowlist.
- Safety: evented changes, explicit zero‑address checks, governance‑only setters, snapshot + rollback tooling.

## Motivation

Integrations need a narrow, auditable way to mint balances through the Bridge without broad privileges. Introducing an “authorized balance increaser” allowlist lets governance approve specific controller contracts to call controlled minting functions, minimizing surface area while preserving the existing flow and roles.

This model provides:

- Least‑privilege controller minting gate on the Bridge.
- On‑chain audit trail via events.
- Operationally simple management via BridgeGovernance.

## What Changed (Contracts)

- Bridge (proxy):
  - New state: `authorizedBalanceIncreasers` mapping (storage layout extended).
  - New events: `AuthorizedBalanceIncreaserUpdated(address,bool)`.
  - New methods (gated at runtime by allowlist):
    - `controllerIncreaseBalance(address,uint256)`
    - `controllerIncreaseBalances(address[],uint256[])`
    - `authorizedBalanceIncreasers(address) -> bool`
  - New governance setter: `setAuthorizedBalanceIncreaser(address,bool)` (onlyGovernance).
- BridgeGovernance (regular contract):
  - New owner‑only forwarder: `setAuthorizedBalanceIncreaser(address,bool)` that calls into Bridge.
- New interface for integrators: `IBridgeMintingAuthorization` (minimal surface consumed by account‑control).

## Why Governance Redeploy Is Needed

- Bridge’s governance role is the BridgeGovernance contract address. To manage the new allowlist on Bridge, BridgeGovernance itself must expose the matching forwarder function.
- The legacy governance contract does not have it, so we deploy a fresh BridgeGovernance and transfer Bridge governance to the new instance (governance delay applies).

## Upgrade Plan (High‑Level)

1. Pre‑upgrade snapshot of Bridge state (implementation/admin/governance, parameters, allowlists).
2. Upgrade Bridge proxy implementation via ProxyAdmin to the version with controller allowlist.
3. Redeploy BridgeGovernance (fresh instance) and transfer governance:
   - Begin transfer, wait governance delay, finalize.
4. Optionally sync authorized controllers from env/config; emit events for adds/removals.
5. Post‑upgrade snapshot; compare and archive.

Supporting scripts (names as in repo):

- `solidity/deploy/80_upgrade_bridge_v2.ts` — upgrade Bridge, resolve libraries/addresses, conditional Tenderly verify.
- `solidity/deploy/09_deploy_bridge_governance.ts` — deploy BridgeGovernance (+Parameters), conditional Tenderly verify.
- `solidity/deploy/21_transfer_bridge_governance.ts` + `solidity/deploy/utils/governance-transfer.ts` — initiate/wait/finalize governance transfer while respecting the governance delay.
- `solidity/deploy/99_configure_bridge_controllers.ts` + `solidity/deploy/utils/bridge-controller-authorization.ts` — sync allowlist from env.

## Risks & Mitigations

- Storage layout changes: uses mapped slot and reduces the storage gap accordingly; upgrade path accounted for in implementation.
- Misconfiguration risk: snapshot + rollback scripts provided; allowlist sync is explicit and evented.
- Tenderly availability: verification is conditional on local Tenderly config to avoid deployment failures.

## Environment Notes

- Env keys used during orchestration include: `BRIDGE_ADDRESS`, `PROXY_ADMIN_PK`, `BRIDGE_GOVERNANCE_PK`, `BRIDGE_AUTHORIZED_INCREASERS`, and library/core contract address fallbacks.
- Mass revocation safeguard: to revoke all existing controller authorizations when no `BRIDGE_AUTHORIZED_INCREASERS` are provided, set `BRIDGE_ALLOW_MASS_CONTROLLER_REVOKE=true` (otherwise existing authorizations are left unchanged).
- Sepolia RPC: prefer `SEPOLIA_CHAIN_API_URL`/`SEPOLIA_PRIVATE_KEYS` where applicable.

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
   Captured pre/post-upgrade snapshots (`deployments/sepolia/bridge-upgrade.json`) and verified proxy admin / implementation slots to confirm the upgrade.

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

Snapshots before and after the change are appended to `solidity/deployments/sepolia/bridge-upgrade.json`.
