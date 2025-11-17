## Sepolia – BridgeGovernance Redeploy (Summary)

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
