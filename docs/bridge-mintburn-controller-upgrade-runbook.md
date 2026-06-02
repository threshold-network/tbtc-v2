# Bridge MintBurnController Upgrade — Runbook

**Branch:** `fix/upgrade-bridge-after-rebate-repair`
**Script:** `solidity/deploy/84_upgrade_bridge_mint_burn_controller.ts`
**Fork test:** `solidity/test/bridge/Bridge.MintBurnControllerUpgrade.test.ts`
**Target:** Sepolia Bridge proxy `0x9b1a7fE5a16A15F2f9475C5B231750598b113403`

## Background

PR#933 upgraded the Sepolia Bridge proxy to repair `rebateStaking` (using `reinitializer(5)`).
That upgrade overwrote a prior deployment from `new/bank-decreaser`, which had introduced
MintBurnGuard controller support. The current on-chain Bridge lacks:

- `setMintingController()` / `getMintingController()`
- `controllerIncreaseBalance()` / `controllerIncreaseBalances()`

This runbook upgrades the Bridge proxy to the `new/bank-decreaser` implementation, restoring
those methods. No reinitializer is called — the `mintingController` storage slot defaults to
`address(0)` and is set post-upgrade via governance.

---

## Prerequisites

```bash
# Tools
node --version   # 24+
cast --version   # Foundry cast, for on-chain reads
anvil --version  # Foundry Anvil, required for fork test (Phase 4)
yarn --version

# Set once for the whole session
export RPC=<sepolia-archive-rpc-url>   # Alchemy or Infura archival endpoint
export BRIDGE=0x9b1a7fE5a16A15F2f9475C5B231750598b113403
```

---

## Phase 1 — Snapshot current on-chain state

Record every value before touching anything. You will compare against these after the upgrade.

The snapshot script reads all relevant on-chain values, validates all abort conditions
(key ownership, rebateStaking, library code), and prints a summary to record.

```bash
cd solidity
source .env # must export RPC and PROXY_ADMIN_PK
bash scripts/snapshot.sh
```

The script exits non-zero and prints an `ABORT` message on the first failed check.
Copy the printed summary values (`IMPL_BEFORE`, `PROXY_ADMIN_ADDRESS`, `GOVERNANCE_ADDRESS`,
etc.) — you will need them in Phase 7.

---

## Phase 2 — Build and lint

```bash
cd solidity
npm run build    # must complete with 0 errors
npm run lint     # TypeScript linting — must pass
npm run lint:sol # Solidity linting — must pass
```

---

## Phase 3 — Standard test suite

Confirms the `new/bank-decreaser` contracts are healthy before touching the upgrade path.

```bash
cd solidity
npm run test
```

All tests must pass. Do not proceed if there are any failures.

---

## Phase 4 — Fork test

Runs the full upgrade against a Sepolia fork using account impersonation and asserts the
post-upgrade state is correct.

**Requires Anvil** (part of [Foundry](https://getfoundry.sh/)). Hardhat's built-in forking does
not support the JSON-RPC signer semantics needed for account impersonation in this test.
The `system_tests` network in `hardhat.config.ts` points to `http://127.0.0.1:8545`, where
Anvil listens by default.

**4a. Start Anvil forking Sepolia**

```bash
anvil --fork-url $RPC --port 8545
```

Leave this running in a separate terminal.

**4b. Run the fork test**

```bash
cd solidity
yarn hardhat test \
  ./test/bridge/Bridge.MintBurnControllerUpgrade.test.ts \
  --network system_tests
```

Expected: **4 passing** tests:

- `sets the Bridge implementation to the deployed target`
- `preserves pre-upgrade minting controller address`
- `controllerIncreaseBalance reverts with 'Caller is not the authorized controller'`
- `setMintingController is callable by Bridge governance`

**4c. Re-run with strict library bytecode checking**

```bash
STRICT_LIB_CHECK=true \
  yarn hardhat test \
  ./test/bridge/Bridge.MintBurnControllerUpgrade.test.ts \
  --network system_tests
```

Bytecode mismatch warnings are expected (Sepolia libraries were deployed with older compiler
settings) and are not a blocker. If this fails with **missing code** (`has no code on-chain`),
**stop** — one of the library addresses is wrong or the contract was never deployed. Investigate
before proceeding.

---

## Phase 5 — Dry run with real keys against a fork

This phase validates what the fork test cannot: that the private key actually controls the
ProxyAdmin. It runs the real deploy script end-to-end against a Sepolia fork using the same
env var configuration that the live upgrade will use, exercising the full hardhat-deploy
machinery instead of the test wrapper.

**Requires Anvil** (same reason as Phase 4 — `system_tests` is the network that points to the
local Anvil node at `http://127.0.0.1:8545`). If Anvil is still running from Phase 4, reuse it.
If not, start it again:

```bash
anvil --fork-url $RPC --port 8545
```

**5a. Enable the deploy script**

In `solidity/deploy/84_upgrade_bridge_mint_burn_controller.ts`, comment out the skip line:

```typescript
// func.skip = async () => true
```

**5b. Run against the Anvil fork**

```bash
cd solidity

BRIDGE_ADDRESS=0x9b1a7fE5a16A15F2f9475C5B231750598b113403 \
  DEPOSIT_LIB_ADDRESS=0xad39ED2D3aF448C14b960746F1F63451D366000c \
  DEPOSITSWEEP_LIB_ADDRESS=0x762B5E9dE8b3cF81d71Cc6f5ea1a9a7B7Eb7b8cB \
  REDEMPTION_LIB_ADDRESS=0x88BEEF1F01cD6c74063E398da1114eb4B8C985a6 \
  WALLETS_LIB_ADDRESS=0x21eB46af48705A52f122931ddb8E9df036D8F2c1 \
  FRAUD_LIB_ADDRESS=0xe60FFb5037aC31603B1AeDEf440fFad088dF0a17 \
  MOVINGFUNDS_LIB_ADDRESS=0xbF138155D789007c43dda3cc39B75fB70991e7E3 \
  PROXY_ADMIN_PK= \
  deploy < real-private-key > \
yarn --tags UpgradeBridgeMintBurnController --network system_tests
```

Watch for:

- All 6 libraries resolved from env vars — **no fresh deployments**
- `verifyLibraryBytecodes` may log bytecode mismatch warnings — this is expected for Sepolia
  libraries deployed with older compiler settings and is not a blocker at this phase
- New Bridge implementation deployed and tx hash logged
- `ProxyAdmin.upgrade` tx confirmed

> Note: Tenderly verification will not run because the `system_tests` network does not carry the
> `tenderly` tag. That is expected.

If the script reverts with `execution reverted` or `caller is not the owner`, the private key
does not control the ProxyAdmin on Sepolia. **Stop and resolve the key issue** before
proceeding to Phase 6.

---

## Phase 6 — Execute the live upgrade

The deploy script should still have `func.skip` commented out from Phase 5.

**6a. Set environment variables**

```bash
export SEPOLIA_CHAIN_API_URL=$RPC
export SEPOLIA_PRIVATE_KEYS=<real-private-key>
export PROXY_ADMIN_PK=<real-private-key>
export STRICT_LIB_CHECK=true
# Only required if the deployments cache does not already have the Bridge address:
export BRIDGE_ADDRESS=0x9b1a7fE5a16A15F2f9475C5B231750598b113403
```

**6b. Run the upgrade**

```bash
cd solidity
yarn deploy --tags UpgradeBridgeMintBurnController --network sepolia
```

You must see in the output:

- All 6 libraries resolved — no fresh deployments
- `verifyLibraryBytecodes` — no warnings
- New Bridge implementation deployed — **record the tx hash**
- `ProxyAdmin.upgrade` executed — **record the tx hash**
- Tenderly verification completed (Sepolia carries the `tenderly` tag)

---

## Phase 7 — Post-upgrade verification

Set the baseline values recorded in Phase 1, then run the verification script:

```bash
cd solidity
export IMPL_BEFORE=<value from Phase 1 snapshot>
export GOVERNANCE_ADDRESS=<value from Phase 1 snapshot>
export PROXY_ADMIN_ADDRESS=<value from Phase 1 snapshot>
bash scripts/verify-upgrade.sh
```

The script checks:

1. Implementation slot changed from `IMPL_BEFORE`
2. `getMintingController()` exists and returns `address(0)`
3. `controllerIncreaseBalance()` reverts with `"Caller is not the authorized controller"`
4. `getRebateStaking()` still returns `address(0)` — PR#933 fix not overwritten
5. `governance()` unchanged from Phase 1
6. ProxyAdmin slot unchanged from Phase 1

The script exits non-zero on the first failed check and prints an `ABORT` message.
All checks must pass before closing out. If any fail, record the tx hashes and escalate
before taking further action.

---

## Phase 8 — Restore skip guard and commit

Re-enable the skip so the script cannot accidentally re-run:

```typescript
func.skip = async () => true
```

Commit both files:

```bash
git add solidity/deploy/84_upgrade_bridge_mint_burn_controller.ts \
  solidity/test/bridge/Bridge.MintBurnControllerUpgrade.test.ts
git commit -m "fix(bridge): upgrade Bridge proxy to MintBurnGuard-aware implementation"
```

---

## Abort criteria

Stop immediately and do not advance to the next phase if any of the following are true:

| Phase | Condition                                                                        | Action                                                       |
| ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1     | `snapshot.sh` exits non-zero for any reason                                      | Fix the flagged condition before proceeding                  |
| 3     | Any test failure in the standard suite                                           | Fix failing tests first                                      |
| 4     | Anvil is not running or `system_tests` network unreachable                       | Start Anvil (`anvil --fork-url $RPC`) before running         |
| 4     | Any of the 4 fork tests fail                                                     | Do not proceed to Phase 5                                    |
| 4     | `STRICT_LIB_CHECK=true` raises a **missing code** error (not a mismatch warning) | Wrong library address or contract not deployed — investigate |
| 5     | Anvil is not running or `system_tests` network unreachable                       | Start Anvil (`anvil --fork-url $RPC`) before running         |
| 5     | Script reverts due to ownership or signing error                                 | Verify key controls ProxyAdmin                               |
| 7     | `verify-upgrade.sh` exits non-zero for any reason                                | Record tx hashes and escalate before taking further action   |
| 7     | Implementation slot unchanged after upgrade                                      | Upgrade did not execute; investigate                         |
| 7     | `getRebateStaking()` returns non-zero                                            | Storage corruption; escalate immediately                     |
