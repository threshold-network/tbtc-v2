# UTXO Reservations — Sepolia Deployment Runbook

Step-by-step activation of the milestone-1 reservation subsystem on Sepolia,
for the operator who holds the Sepolia deployer key. The on-chain sequence
mirrors the 22-step activation dry-run in `scripts/reservations-fork-dryrun.ts`
(branch `reservations-fork-dryrun`) and the activation order in
`RESERVATION_CAPS_DEPLOYMENT.md`.

Scope: upgrading the live Sepolia Bridge proxy, deploying the
`ReservationRouter`/`ReservationVault`, swapping `BridgeGovernance`, and the
governance begin/finalize activation ceremony. Out of scope: lifecycle
actions (reveal, acceptance, re-anchor) — those are exercised by keep-core
once its Sepolia build is live.

## Verified live state (read-only, 2026-10-09, Sepolia block ~11,878,000)

Every value below was read with `cast` against `SEPOLIA_RPC_URL`:

| Fact | Value |
|---|---|
| Chain ID | `11155111` |
| Bridge (proxy) | `0x2220acE07d86B508742D511478e517716B675940` |
| Bridge implementation | `0xc9CEec54a8b25D7051B702322675ee3014bA4685` |
| Bridge ProxyAdmin | `0x0E9bD483CC8Fb649636e0cd7a60BC48b6C040103` |
| ProxyAdmin owner | `0xb9B8a92677fcad86dc8d36fe947184283B03b3C8` (the Sepolia deployer EOA — **not** the Timelock) |
| BridgeGovernance | `0x61700ebaCCfd9FB0100C35DDd38e4cC3e9057c5A` |
| BridgeGovernance owner | `0xb9B8a92677fcad86dc8d36fe947184283B03b3C8` |
| `governanceDelays[0]` on the live BridgeGovernance | `60` seconds (`governanceDelays[1]` = 0) |
| Timelock | `0x92bBB99ae3BBBcE9fC75cAC14ac28e89e3EeF50c`, OZ `TimelockController`, `getMinDelay()` = 86400 |
| Timelock PROPOSER/EXECUTOR role holder | `0xb9B8a92677fcad86dc8d36fe947184283B03b3C8` (the deployer EOA; the mainnet-style Council Safe has no role on Sepolia) |
| Bank | `0xa75F2b01dF21469f32e6f5651049C67984038D4e` (code on-chain) |
| TBTCVault | `0xf0C653c5818EBA421F935Bc0b2282dE806A7988e` (code on-chain) |
| LightRelay | `0x978bC82B68f7E0cAf3e655a6389fd72cA05DE338` (code on-chain) |
| TBTC token | `0xA7f6952d1cD478F4D8331F247A91BEf9c6482271` |

Bridge proxy slots (OpenZeppelin v4 EIP-1967 constants, as exported by
`deploy/85_deploy_tip109_governance_upgrade.ts`):

```sh
# implementation slot
cast storage 0x2220acE07d86B508742D511478e517716B675940 \
  0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $SEPOLIA_RPC_URL
# -> 0x...c9CEec54a8b25D7051B702322675ee3014bA4685 (matches the implementation row above)
# admin slot
cast storage 0x2220acE07d86B508742D511478e517716B675940 \
  0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103 --rpc-url $SEPOLIA_RPC_URL
# -> 0x...0E9bD483CC8Fb649636e0cd7a60BC48b6C040103
```

Cross-checked from the ProxyAdmin itself:

```sh
cast call 0x0E9bD483CC8Fb649636e0cd7a60BC48b6C040103 \
  'getProxyImplementation(address)(address)' 0x2220acE07d86B508742D511478e517716B675940 --rpc-url $SEPOLIA_RPC_URL
# -> 0xc9CEec54a8b25D7051B702322675ee3014bA4685
cast call 0x0E9bD483CC8Fb649636e0cd7a60BC48b6C040103 'owner()(address)' --rpc-url $SEPOLIA_RPC_URL
# -> 0xb9B8a92677fcad86dc8d36fe947184283B03b3C8
```

Conclusions used throughout this runbook:

- The Bridge is a **transparent proxy**; upgrades go through its OZ-style
  `ProxyAdmin` (`upgrade(address,address)`), and on Sepolia the **deployer
  EOA owns the ProxyAdmin** — no Timelock scheduling is required (that is the
  mainnet pattern).
- The live Bridge implementation does **not** expose the reservation surface
  (`getReservationRouter`, `reservationCaps`, `reservationParameters`,
  `isReservedDeposit` all revert); `isVaultTrusted(0)` returns `false`.
- The live `BridgeGovernance` is a plain (non-proxy) contract whose ABI has
  `setVaultStatus`/`beginBridgeGovernanceTransfer`/`finalizeBridgeGovernanceTransfer`
  but **no** `beginReservationCapsUpdate`/`setReservationRouter` — a new
  governance contract must be deployed and swapped in.
- Live `BridgeGovernance.governanceDelays[0]` is **60 seconds**; every
  begin/finalize pair in this runbook therefore only needs a 60 s (or
  longer) wait on Sepolia.

TO VERIFY before touching anything: that the key you hold is
`0xb9B8a92677fcad86dc8d36fe947184283B03b3C8` — it must own both the
ProxyAdmin and the live BridgeGovernance. If you hold a different key, first
transfer the two `Ownable`s to it (ProxyAdmin `transferOwnership`,
BridgeGovernance `transferOwnership`).

## Environment (solidity/)

All commands below run from the `solidity/` directory of this branch. The
`sepolia` network in `hardhat.config.ts` is configured as:

- `url`: `CHAIN_API_URL` (export `SEPOLIA_RPC_URL` as `CHAIN_API_URL` for
  hardhat; keep `SEPOLIA_RPC_URL` for `cast`).
- `accounts`: comma-separated list in `ACCOUNTS_PRIVATE_KEYS`; the
  sepolia named accounts (`deployer`, `governance`, `esdm`, `spvMaintainer`,
  ...) are all index 0, i.e. the first key in that list.
- `timeout`: `CHAIN_HTTP_TIMEOUT_MS` (default 120000).
- `gasPrice`: `GAS_PRICE_GWEI` (default 5 gwei).
- Optional: `ETHERSCAN_API_KEY` (the sepolia network has no `etherscan` tag,
  so verification on sepolia is a no-op), `TENDERLY_TOKEN` (tag `tenderly`).

```sh
cd solidity
export CHAIN_API_URL="$SEPOLIA_RPC_URL"
export ACCOUNTS_PRIVATE_KEYS="$SEPOLIA_PRIVATE_KEY"   # first key = all sepolia named accounts
export GAS_PRICE_GWEI=2
yarn install --immutable
```

## Pre-flight checklist

Do all of these **before** sending a single transaction. Each check is
read-only.

1. **Dry run passed.** The activation sequence has been run against a pinned
   mainnet fork (`reservations-fork-dryrun` branch):

   ```sh
   cd ../tbtc-v2-fork/solidity   # worktree on branch reservations-fork-dryrun
   FORKING_URL="$FORKING_URL" FORKING_BLOCK=26154824 \
   RESERVATION_PER_WALLET_CAP_SATS=1000000 \
   RESERVATION_SINGLE_AMOUNT_CAP_SATS=100000 \
   RESERVATION_MAX_ACTIVE=5 \
   RESERVATION_MAX_THIRD_PARTY_REANCHOR_HOLDS=1 \
   RESERVATION_MIN_AMOUNT_SATS=10000 \
   RESERVATION_TX_MAX_FEE_SATS=1000 \
   RESERVATION_TERM_SECONDS=7776000 \
   RESERVATION_DISSOLUTION_DELAY_SECONDS=86400 \
   RESERVATION_MAX_TOTAL_AMOUNT_SATS=500000 \
   RESERVATION_MAX_PER_WALLET=1 \
   RESERVATION_ACTION_TIMEOUT_SECONDS=86400 \
   RESERVATION_RENEWAL_WINDOW_SECONDS=86400 \
   npx hardhat run --network hardhat scripts/reservations-fork-dryrun.ts
   ```

   Expected: all 22 steps PASS, exit code 0. The RESERVATION_* values above
   are the canonical set the script hard-enforces (e.g.
   `RESERVATION_MAX_PER_WALLET` must be exactly 1,
   `RESERVATION_MAX_TOTAL_AMOUNT_SATS` must fit under
   `RESERVATION_MAX_ACTIVE × RESERVATION_SINGLE_AMOUNT_CAP_SATS`). Reuse the
   **same twelve values** for the Sepolia ceremony so the dry run and the
   live run stay comparable.

2. **Key check.** The deployer EOA you hold matches the owners found in the
   live-state table (ProxyAdmin owner and BridgeGovernance owner both
   `0xb9B8a926...`). TO VERIFY if you use a different key: ownership of both
   contracts must be transferred to your key first.
3. **Balance.** The deployer EOA holds enough Sepolia ETH for ~10 txs
   (libraries + implementations + upgrades + governance calls; gas price is
   configurable via `GAS_PRICE_GWEI`).
4. **State snapshot.** Record the pre-upgrade Bridge state so the
   state-preservation check in step 4 has a baseline. Use the same slots the
   fork dry run checks (`SLOTS` map in `scripts/reservations-fork-dryrun.ts`):
   `governance`=0, `initialized`=50, `ecdsaWalletRegistry`=53,
   `depositParameters`=57, `liveWalletsCount`=68, `rebateStaking`=80,
   `reservationVault`=81, `reservationRouter`=83 — the last four read zero
   before this upgrade.

   ```sh
   for s in 0 50 53 57 68 80 81 83; do
     cast storage $BRIDGE $s --rpc-url $SEPOLIA_RPC_URL
   done
   cast call $BRIDGE 'depositParameters()(uint64,uint64,uint64,uint32)' --rpc-url $SEPOLIA_RPC_URL
   cast call $BRIDGE 'liveWalletsCount()(uint32)' --rpc-url $SEPOLIA_RPC_URL
   cast call $BRIDGE 'governance()(address)' --rpc-url $SEPOLIA_RPC_URL
   ```
5. **Block height.** Note the current block (`cast block-number`); it is
   the reference for choosing the activation block in step 6.
6. **No in-flight governance.** Check that the live BridgeGovernance has no
   pending staged changes: `cast call $OLD_GOV 'governanceDelays(uint256)(uint256)' 1 --rpc-url $SEPOLIA_RPC_URL`
   returns 0 (verified 2026-10-09; `$OLD_GOV` =
   `0x61700ebaCCfd9FB0100C35DDd38e4cC3e9057c5A`).
7. **keep-core artifact availability** is resolved in steps 10–11 — do not
   skip the build order.

## Step 0 — compile and sanity-check the new contracts

```sh
yarn build
yarn test:foundry        # optional; the hardhat suite is the CI gate
```

The new Bridge implementation links six external libraries, exactly the set
`deploy/06_deploy_bridge.ts` links into the proxy factory:
`Deposit`, `DepositSweep`, `Redemption`, `Wallets`, `Fraud`,
`MovingFunds` (`unsafeAllow: external-library-linking` — all six are
stateless computation libraries, same as the current on-chain Bridge).
The router links `Reservation` and `ReservationProofs`
(`deploy/06a_deploy_reservation_router.ts`). `ReservationVault` links
nothing (plain constructor `(Bank, TBTCVault, Bridge)`).

Expected after build: `build/` populated; the Bridge artifact under the
EIP-170 limit (CI enforces this via `hardhat-contract-sizer`).

## Step 1 — deploy the ReservationVault (deploy tag 95)

```sh
yarn deploy --tags ReservationVault --network sepolia
```

Script `deploy/95_deploy_reservation_vault.ts` deploys
`ReservationVault(Bank, TBTCVault, Bridge)` from `deployments.get("Bank")`,
`get("TBTCVault")`, `get("Bridge")` — i.e. the existing Sepolia addresses —
and writes the `deployments/sepolia/ReservationVault.json` record
(address + tx hash). It does **not** activate anything: the activation is
the governance ceremony in steps 5–8 (`beginReservationCapsUpdate` →
`beginReservationParametersUpdate` → `setVaultStatus`, per script 95's
comment block).

On-chain checks:

```sh
VAULT=<address printed by the script>
cast code $VAULT --rpc-url $SEPOLIA_RPC_URL | head -c 20          # non-empty
cast call $VAULT 'feeReserveTarget()(uint256)' --rpc-url $SEPOLIA_RPC_URL   # -> 0
cast call $VAULT 'owner()(address)' --rpc-url $SEPOLIA_RPC_URL      # -> deployer EOA
cast call $VAULT 'bank()(address)' --rpc-url $SEPOLIA_RPC_URL        # -> Bank address
```

**Rollback / abort:** none — this is a fresh, unreferenced contract. An
aborted deploy is inert (no address points at it yet). Just do not record
it in `deployments/sepolia/` as the canonical vault.

## Step 2 — transfer vault ownership (deploy tag 96)

```sh
yarn deploy --tags ReservationVaultOwnership --network sepolia
```

`deploy/96_transfer_reservation_vault_ownership.ts` runs `transferOwnership`
on the vault from `deployer` to the `governance` named account (on Sepolia
both are index 0 of `ACCOUNTS_PRIVATE_KEYS`). `runAtTheEnd = true`.

On-chain check: `cast call $VAULT 'owner()(address)'` now returns the
governance EOA.

**Rollback / abort:** `transferOwnership(deployer)` by the current owner —
fully reversible until the vault is wired into the Bridge in step 6.

## Step 3 — deploy the upgrade artifacts

Scripts 06/06a/09 cannot be re-run: 06 would `deployProxy` a second Bridge
(same-name record exists and the script errors), and 09/21/22 belong to the
initial deploy. Instead, run a one-off script that deploys the artifacts the
same way and upgrades the proxy through the **on-chain** ProxyAdmin (this is
exactly the fork dry-run's step 3: `proxyAdmin.connect(adminSigner).upgrade(bridge, newImpl)`).

Add `scripts/sepolia-reservations-upgrade.ts` (new file, committed with this
runbook), called from top level (`npx hardhat run` never calls a TS
`export default`):

```ts
import { ethers, deployments, getNamedAccounts } from "hardhat"

// Called via `npx hardhat run --network sepolia scripts/sepolia-reservations-upgrade.ts`.
// (`npx hardhat run` never calls a TS script's `export default`, so the entry
// point is invoked at top level — same convention as
// scripts/reservations-fork-dryrun.ts on the reservations-fork-dryrun branch.)
async function main() {
  const { deployer } = await getNamedAccounts()
  const signer = await ethers.getSigner(deployer)
  const opts = { from: signer, log: true, waitConfirmations: 1 }

  // 1. Fresh linked libraries for the NEW implementation (same set as 06).
  const libs: Record<string, string> = {}
  for (const name of ["Deposit", "DepositSweep", "Redemption", "Wallets", "Fraud", "MovingFunds"]) {
    const deployed = await deployments.deploy(name, { ...opts, skipIfAlreadyDeployed: false })
    libs[name] = deployed.address
  }

  // 2. New Bridge implementation, external libraries linked.
  const bridgeImpl = await deployments.deploy("Bridge", {
    ...opts,
    libraries: libs,
    skipIfAlreadyDeployed: false,
  })

  // 3. Reservation subsystem artifacts (06a pattern, minus setReservationRouter —
  //    the router is wired by governance in step 5, not by the deploy pipeline).
  const ReservationProofs = await deployments.deploy("ReservationProofs", { ...opts, skipIfAlreadyDeployed: false })
  const Reservation = await deployments.deploy("Reservation", { ...opts, skipIfAlreadyDeployed: false })
  const router = await deployments.deploy("ReservationRouter", {
    ...opts,
    libraries: { Reservation: Reservation.address, ReservationProofs: Reservation.address },
    skipIfAlreadyDeployed: false,
  })

  // 4. New BridgeGovernance (09_deploy_bridge_governance.ts pattern): a fresh
  //    plain contract, 60s delay on Sepolia, owner = deployer until step 5a'.
  const bgParams = await deployments.deploy("BridgeGovernanceParameters", { ...opts, skipIfAlreadyDeployed: false })
  const oldBridge = await deployments.get("Bridge") // the proxy (existing record)
  const bridgeGov = await deployments.deploy("BridgeGovernance", {
    ...opts,
    args: [oldBridge.address, 60],
    libraries: { BridgeGovernanceParameters: bgParams.address },
    skipIfAlreadyDeployed: false,
  })

  console.log("NEW_IMPL ", bridgeImpl.address)
  console.log("ROUTER   ", router.address)
  console.log("NEW_GOV  ", bridgeGov.address)
  // The three addresses are used as $NEW_IMPL / $ROUTER / $NEW_GOV in the
  // steps below. The deployment records are written into deployments/sepolia/
  // by hardhat-deploy; commit them together with step 4.
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

```sh
npx hardhat run --network sepolia scripts/sepolia-reservations-upgrade.ts
```

Notes:

- `skipIfAlreadyDeployed: false` forces fresh code even though the
  hardhat-deploy record names exist (the scripts above deploy under the
  same logical names; the `deployments/` records get the new addresses,
  which is what step 5 and the npm publish in step 10 need).
- The ProxyAdmin upgrade itself happens next; this script only deploys.

On-chain checks:

```sh
cast code $NEW_IMPL --rpc-url $SEPOLIA_RPC_URL | head -c 20    # non-empty
cast code $ROUTER --rpc-url $SEPOLIA_RPC_URL | head -c 20
cast code $NEW_GOV --rpc-url $SEPOLIA_RPC_URL | head -c 20
# New implementation is inert: it only executes through the proxy
# after the upgrade below. Nothing references it yet.
```

**Rollback / abort:** the three contracts are unreferenced — nothing to roll
back. Do not commit `deployments/sepolia/` records until step 4 succeeds.

## Step 4 — upgrade the Bridge proxy (and only then commit the deployment records)

The Sepolia proxy is admin'd by the OZ-style ProxyAdmin
`0x0E9bD483CC8Fb649636e0cd7a60BC48b6C040103`, owned by the deployer EOA
(verified above). A **plain** `upgrade(address,address)` is correct: the
new implementation's highest reinitializer is `reinitializer(5)` (same
ceiling as the current one), and its OZ initializer flag still matches the
live proxy's, so no initializer call is needed or wanted (the fork dry run
documents this: "no reinitializer is invoked on this branch"). Do **not**
use `upgradeAndCall`.

```sh
cast send $ADMIN 'upgrade(address,address)' $BRIDGE $NEW_IMPL \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
```

(`$ADMIN` = `0x0E9bD483CC8Fb649636e0cd7a60BC48b6C040103`, `$BRIDGE` as
before. Do **not** use `upgradeAndCall` — there is nothing to call.)

Immediately after, run the state-preservation check (fork dry-run step 4):
the same stable views and slots must read identical to the pre-upgrade
snapshot from pre-flight item 4, with the EIP-1967 implementation slot now
reading `$NEW_IMPL`:

```sh
for s in 0 50 53 57 68 80 81 83; do
  cast storage $BRIDGE $s --rpc-url $SEPOLIA_RPC_URL
done
cast call $BRIDGE 'depositParameters()(uint64,uint64,uint64,uint32)' --rpc-url $SEPOLIA_RPC_URL
cast call $BRIDGE 'liveWalletsCount()(uint32)' --rpc-url $SEPOLIA_RPC_URL
cast call $BRIDGE 'governance()(address)' --rpc-url $SEPOLIA_RPC_URL
cast storage $BRIDGE 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $SEPOLIA_RPC_URL
# last one must now read $NEW_IMPL
```

Then commit the updated `deployments/sepolia/*.json` records (the repo
pattern is a `feat(deployments)` commit — see the history for
`deployments/sepolia/BridgeGovernance.json`):

```sh
cd ..
git add solidity/deployments/sepolia solidity/scripts/sepolia-reservations-upgrade.ts
git commit -m "chore(deployments): record the Sepolia reservations upgrade"
```

**Rollback / abort (irreversible point, step 1 of two):** the proxy now runs
the new implementation. Reverting is a single `upgrade()` back to the old
implementation, while no reservation state has been written yet (the router
is not set, the vault is not trusted, caps are zero — re-verified below):

```sh
cast send $ADMIN 'upgrade(address,address)' $BRIDGE 0xc9CEec54a8b25D7051B702322675ee3014bA4685 \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
```

Safety precondition for that rollback: `getReservationRouter` still returns
`0` and no `setVaultStatus` has run (both checked in step 6). Once the
router is wired (step 5) the downgrade is no longer safe, because the new
storage layout fields (`reservationRouter` slot 83, `reservationVault` slot
81, ...) are live.

## Step 5 — wire the router and swap the governance

Two actions, in this order:

1. **`setReservationRouter(router)` — write-once.** The old live
   BridgeGovernance has no such method, so this runs against the **new**
   governance. Because Bridge governance is still `oldGov` at this point,
   the new governance is not yet the Bridge's governance: first swap
   governance (5a), then wire the router (5b). The router's own deploy
   script (06a) notes `setReservationRouter` reverts on a second call —
   get the address right.

2. Governance swap (the dry-run's steps 06/07, via the old governance's
   `begin/finalizeBridgeGovernanceTransfer`):

```sh
OLD_GOV=0x61700ebaCCfd9FB0100C35DDd38e4cC3e9057c5A
# 5a. begin — staged, not yet active
cast send $OLD_GOV 'beginBridgeGovernanceTransfer(address)' $NEW_GOV \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
# wait > 60s (governanceDelays[0] on the live governance; verify:
#   cast call $OLD_GOV 'governanceDelays(uint256)(uint256)' 0 --rpc-url $SEPOLIA_RPC_URL)
# 5a'. (optional) the new governance's owner is already the deployer EOA from
# Step 3, so on Sepolia this transfer is a no-op — skip it unless you want a
# different governance owner than the deployer EOA:
#   cast send $NEW_GOV 'transferOwnership(address)' <governance-owner> \
#     --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
# 5a''. finalize — executes bridge.transferGovernance(newGov)
cast send $OLD_GOV 'finalizeBridgeGovernanceTransfer()' \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
```

On-chain checks:

```sh
cast call $BRIDGE 'governance()(address)' --rpc-url $SEPOLIA_RPC_URL   # -> $NEW_GOV
cast call $NEW_GOV 'bridge()(address)' --rpc-url $SEPOLIA_RPC_URL       # -> $BRIDGE
cast call $NEW_GOV 'governanceDelays(uint256)(uint256)' 0 --rpc-url $SEPOLIA_RPC_URL  # -> 60
```

Then wire the router (5b) — MUST be the first reservation action (it
unblocks the Bridge fallback; without it every reservation selector reverts
with "Reservation router not set", and it is write-once):

```sh
cast send $NEW_GOV 'setReservationRouter(address)' $ROUTER \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
```

On-chain check:

```sh
cast call $BRIDGE 'getReservationRouter()(address)' --rpc-url $SEPOLIA_RPC_URL  # -> $ROUTER
```

**Rollback / abort:**

- 5a (begin only): no state visible to the Bridge; the staged transfer
  simply times out and is cleared by the next `begin*` or finalize attempt.
- 5a'' (finalize): `bridge.governance` now points at the new governance.
  Reversible **while no reservation state exists** by running the same
  begin/finalize pair on the *new* governance with `oldGov` as the target
  (`$NEW_GOV.beginBridgeGovernanceTransfer($OLD_GOV)` → wait →
  `finalize`), or, if the old governance contract is still owner-able, by
  directly calling `bridge.transferGovernance` from whatever holds
  governance. After the router is wired (5b), do not attempt to point
  the Bridge at the *old* governance: the old ABI lacks
  `setReservationRouter` and the fallback would be left pointing at a
  router no governance can manage. The router wiring itself (5b) is
  **irreversible** — no "clear router" setter exists.

## Step 6 — client activation ordering gate C-4 (keep-core release BEFORE activation)

From `RESERVATION_CAPS_DEPLOYMENT.md`, "Client Activation Ordering Gate":
the on-chain `setVaultStatus(vault, true)` MUST execute at or after the
block written into keep-core's `reservationsActivationBlocks[Sepolia]`.
Release the client first, verify every Sepolia node is on that binary,
**then** choose the activation block at or after the rollout completes.
(If no entry is written for Sepolia in keep-core, `ReservationsActivationBlock`
falls through to `math.MaxUint64` and coordination never starts — the gate
is runbook discipline; nothing on-chain enforces it.)

Practical choice for Sepolia: activation block = (current block at the time
of the ceremony) + a comfortable margin (e.g. +1h of Sepolia blocks), far
after the 60-second governance windows in step 7. Record the chosen block
number in the governance log; it is the value written in step 9's keep-core
change.

## Step 7 — stage and finalize the reservation parameters (governance, 60 s delays)

The new BridgeGovernance exposes the begin/finalize pairs. Order is fixed
(Decision 1, `RESERVATION_CAPS_DEPLOYMENT.md` "Deploy Order"): caps **first**
(trivially passes on bootstrap), then parameters (whose
`reservationMaxTotalAmount` is checked against the just-applied
`maxActiveReservations × reservationMaxSingleAmount` slot capacity). The
`reservationVault` address is the **first argument** of
`beginReservationParametersUpdate` — there is no separate vault setter.

Script 98 (`GenerateReservationMainnetCalldata`) is the **mainnet** path and
hard-fails on Sepolia: after the local-network skip it verifies the
ProxyAdmin owner against the hardcoded `KNOWN_TIMELOCK` and the
BridgeGovernance owner against the hardcoded `KNOWN_COUNCIL_SAFE` — on
Sepolia both owners are the deployer EOA, so those checks throw. Do **not**
run 98 for Sepolia. Use the manual `cast` ceremony below (identical to the
dry-run's six ordered actions) with the twelve canonical RESERVATION_* values,
or run `deploy/97` (`--tags ReservationParameters --network sepolia`) for its
hardcoded test values (97 stages the two `begin*` calls and logs PENDING
FINALIZE / PENDING ACTIVATION; it deliberately does not finalize or activate
on live networks, so you still issue the finalizers and `setVaultStatus`
yourself, as below).

Signer note: on Sepolia every named account in `hardhat.config.ts` maps to
index 0 of `ACCOUNTS_PRIVATE_KEYS`, so the **governance signer is the same
deployer EOA** as the ProxyAdmin/BridgeGovernance owner — use
`$SEPOLIA_PRIVATE_KEY` for every call below (drop the
`<governance-EOA>` transfer in step 5a' as a no-op: the new governance is
already owned by that EOA).

Execute, in order, as the deployer/governance EOA (all against `$NEW_GOV`):

```sh
# 7.1 begin caps:  (perWalletCap, singleAmount, maxActive, thirdPartyHolds)
cast send $NEW_GOV 'beginReservationCapsUpdate(uint64,uint64,uint32,uint32)' 1000000 100000 5 1 \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
# 7.2 begin parameters: (vault, min, txMaxFee, term, dissolutionDelay, maxTotal, perWallet, actionTimeout, renewalWindow)
cast send $NEW_GOV 'beginReservationParametersUpdate(address,uint64,uint64,uint32,uint32,uint64,uint32,uint32,uint32)' \
  $VAULT 10000 1000 7776000 86400 500000 1 86400 86400 \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
# wait > 60s (governanceDelays[0] = 60 on the new governance)
# 7.3 finalize caps  (MUST precede finalize parameters)
cast send $NEW_GOV 'finalizeReservationCapsUpdate()' \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
# 7.4 finalize parameters
cast send $NEW_GOV 'finalizeReservationParametersUpdate()' \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
```

On-chain checks (post-7.4; router views are reached **through the Bridge
proxy** — encode against the router ABI and call `$BRIDGE`):

```sh
cast call $BRIDGE 'reservationCaps()(uint64,uint64,uint32,uint32)' --rpc-url $SEPOLIA_RPC_URL
# -> (1000000, 100000, 5, 1)
cast call $BRIDGE 'reservationParameters()(address,uint64,uint64,uint32,uint32,uint64,uint32,uint32,uint32,uint32)' --rpc-url $SEPOLIA_RPC_URL
# -> vault == $VAULT, maxTotalAmount == 500000, ...
```

**Rollback / abort:**

- 7.1/7.2 (began, not finalized): re-stage overwrites; a stale `begin*`
  simply never gets finalized and is inert.
- 7.3/7.4 (finalized): caps and parameters are re-settable by another
  begin/finalize pair (another 60 s each). The `reservationVault` address,
  however, is gated by `reservationTotalAmount == 0 && pendingReservedDeposits
  == 0` — before any reservation exists, re-pointing the vault is still a
  governance call and reversible; after the first acceptance it is not
  (irreversibility warning in `RESERVATION_CAPS_DEPLOYMENT.md`).

## Step 8 — fee-reserve target, then activate the vault

Governance step from `RESERVATION_CAPS_DEPLOYMENT.md` "Fee-Reserve Target
Governance Step" — complete it **before** activation (or explicitly accept a
zero reserve and record that decision):

```sh
# the vault's owner is the deployer/governance EOA (step 2)
cast send $VAULT 'updateFeeReserveTarget(uint256)' <target in TBTC, 18 decimals> \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
cast call $VAULT 'feeReserveTarget()(uint256)' --rpc-url $SEPOLIA_RPC_URL  # -> the chosen value
```

Activation — only at or after the keep-core activation block chosen in
step 6 (C-4 gate):

```sh
cast send $NEW_GOV 'setVaultStatus(address,bool)' $VAULT true \
  --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY
```

On-chain check (fork dry-run step 5 model):

```sh
cast call $BRIDGE 'isVaultTrusted(address)(bool)' $VAULT --rpc-url $SEPOLIA_RPC_URL   # -> true
```

**Rollback / abort:** `setVaultStatus(vault, false)` reverts the trusted
flag at any time (fee fallback: acceptances settling while untrusted are
direct-credit, no initiation fee — see the "Fee Fallback" section of
RESERVATION_CAPS_DEPLOYMENT.md). It is **not** a rollback of anything else:
vault trust is the final, one-way-for-practical-purposes gate of M1 —
after the first reservation acceptance, the vault can only be swapped when
`reservationTotalAmount == 0 && pendingReservedDeposits == 0` (M1 variant-B
release paths only). The C-4 ordering is the true "point of no return":
activating on-chain before the keep-core release means reserved deposits
can be accepted with no client coordinating them until the activation block.

## Step 9 — post-activation verification (full set)

The fork dry-run's steps 9–10 are the model. All calls below go through the
Bridge proxy (the reservation views are router methods reached via the
Bridge fallback).

```sh
# 9.1 caps
cast call $BRIDGE 'reservationCaps()(uint64,uint64,uint32,uint32)' --rpc-url $SEPOLIA_RPC_URL
# -> (1000000, 100000, 5, 1) — must equal the staged caps
# 9.2 parameters (1st field = $VAULT, 6th = staged max total amount;
#     10-value tuple per IReservationBridge.reservationParameters)
cast call $BRIDGE 'reservationParameters()(address,uint64,uint64,uint32,uint32,uint64,uint32,uint32,uint32,uint32)' \
  --rpc-url $SEPOLIA_RPC_URL
# 9.3 vault trusted
cast call $BRIDGE 'isVaultTrusted(address)(bool)' $VAULT --rpc-url $SEPOLIA_RPC_URL   # -> true
# 9.4 router wired
cast call $BRIDGE 'getReservationRouter()(address)' --rpc-url $SEPOLIA_RPC_URL   # -> $ROUTER
```

9.1–9.4 must equal the staged ceremony values.

**9.5 negative check** (fork dry-run step 10): a third party re-anchoring a
nonexistent reservation must revert with `Reservation is not active`
(`contracts/bridge/Reservation.sol:755`), proving the new router ABI is live
through the Bridge fallback. Simulate with a gasless `eth_call` (any `from`
EOA; the lookup of the bogus `reservationKey` reverts before any
caller-membership check):

```sh
python3 - <<'EOF'
import json, os, urllib.request
from eth_hash.auto import keccak
BRIDGE = "0x2220acE07d86B508742D511478e517716B675940"
sel = keccak(b"requestReservationReanchor(uint256,bytes20,uint32[],uint256)").hex()[:8]
# bogus key, arbitrary target pk (20 zero bytes), empty member proof, index 0
data = "0x" + sel + format(9999, "064x") + "00" * 20 + format(128, "064x") + format(0, "064x") + "00" * 32
req = urllib.request.Request(
    os.environ["SEPOLIA_RPC_URL"],
    data=json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "eth_call",
        "params": [{
            "to": BRIDGE, "data": data,
            "from": "0xb9B8a92677fcad86dc8d36fe947184283B03b3C8",  # deployer EOA (a "third party")
        }, "latest"],
    }).encode(),
    headers={"Content-Type": "application/json"},
)
res = json.loads(urllib.request.urlopen(req, timeout=30).read())
err = res.get("error", {})
hx = (err.get("data") or "").removeprefix("0x")
decoded = bytes.fromhex(hx).decode(errors="replace") if hx else ""
assert "Reservation is not active" in decoded, res
print("OK: router negative check reverted with 'Reservation is not active'")
EOF
```

## Step 10 — publish the npm `sepolia` package (consumed by keep-core)

keep-core's `Makefile` resolves Sepolia contracts exclusively from the npm
registry:

```
make all environment=sepolia
  -> get_artifacts:  npm pack @keep-network/tbtc-v2@sepolia  (and
     @keep-network/random-beacon@sepolia, @keep-network/ecdsa@sepolia,
     @threshold-network/solidity-contracts@sepolia)
     -> extracts package/artifacts/ into tmp/contracts/sepolia/<pkg>/
  -> generate:  go generate ./...  (pkg/chain/ethereum/tbtc/gen/Makefile
     runs abigen + keep-common generator over ${artifacts_dir}/<Name>.json
     for Bridge, MaintainerProxy, LightRelay, LightRelayMaintainerProxy,
     WalletProposalValidator, RedemptionWatchtower, ReservationRouter,
     ReservationVault, TBTC)
```

Critical: for **non-`development`** environments the gen Makefile
**hard-fails** if `ReservationRouter.json` or `ReservationVault.json` is
missing from the fetched artifacts (the vendored fallback is development
only). The current published `@keep-network/tbtc-v2@sepolia` tag (checked
2026-10-09: `1.6.0-sepolia.6`) predates the reservation artifacts, so the
sepolia tag **must** be re-published from this branch after steps 4–5 have
written the `deployments/sepolia/` records (`ReservationRouter`,
`ReservationVault`, `BridgeGovernance`, `Bridge`).

Publish (CI does this in `.github/workflows/contracts.yml` via
`workflow_dispatch` with `environment: sepolia`; manually, from `solidity/`):

```sh
# ensure deployments/sepolia records are current and committed (Step 4 commit)
# npm auth in CI: NODE_AUTH_TOKEN
npm publish --access=public --tag sepolia --network=sepolia
```

`--network=sepolia` sets `$npm_config_network`, so `prepublishOnly`
(`scripts/prepare-artifacts.sh --network sepolia`) copies
`deployments/sepolia/` into the package's `artifacts/` directory — the
directory keep-core's `get_npm_package` extracts. `prepack` additionally
runs `tsc -p tsconfig.export.json && hardhat export-artifacts export/artifacts`.

On-chain/npm checks after publishing:

```sh
npm view @keep-network/tbtc-v2@sepolia version            # new version
npm pack $(npm view @keep-network/tbtc-v2@sepolia dist.tarball | grep -o 'https://.*') -p .
tar tzf <tarball> | grep -E 'ReservationRouter|ReservationVault'   # both present under package/artifacts/
```

**Rollback / abort:** none — the npm tag is re-publishable; an operator who
already built keep-core against a bad artifact just rebuilds after the
re-publish.

## Step 11 — keep-core follow-up: activation block + bindings

In the keep-core working tree (`pr-4282-drill` layout):

1. Regenerate bindings against the freshly published package:

   ```sh
   make get_artifacts environment=sepolia   # fetch @keep-network/tbtc-v2@sepolia (new)
   cd pkg/chain/ethereum/tbtc/gen && make   # abigen + keep-common generator,
                                            # writes abi/, contract/, cmd/, _address/
   cd ../../../..
   make generate environment=sepolia        # go generate ./...
   ```

   The addresses land in `pkg/chain/ethereum/tbtc/gen/_address/*` (embedded
   into the binary; on a real environment the on-chain addresses are used,
   not zeros — zeros are development-only).
   TO VERIFY: `go build ./...` and, if a vendored fallback file was
   touched, `make verify-vendored-fallback` in `pkg/chain/ethereum/tbtc/gen`
   (it needs the real fetched artifacts, i.e. run it in a tree that has
   them, not CI's hermetic environment).

2. Set the activation block chosen in step 6 in
   `pkg/tbtc/coordination.go` — `reservationsActivationBlocks` is a
   `map[ethereum.Network]uint64` currently **empty**; without an entry for
   `ethereum.Sepolia`, `ReservationsActivationBlock` returns
   `math.MaxUint64` and coordination never activates for Sepolia:

   ```go
   var reservationsActivationBlocks = map[ethereum.Network]uint64{
       ethereum.Sepolia: <activation block from step 6>,
   }
   ```

   Rule from the doc comment: only add a **real** height chosen after the
   release plan is fixed — an invented placeholder is indistinguishable
   from a live one.

3. Build and ship the binary to **all** Sepolia operators before the
   activation block is reached:

   ```sh
   make sepolia        # == make all environment=sepolia: get_artifacts, generate, build, release
   ```

**Rollback / abort:** the `reservationsActivationBlocks` entry has no
on-chain counterpart — lowering the height or removing the entry and
re-releasing is the only rollback; on-chain trust revocation
(`setVaultStatus(vault, false)`) is the paired chain-side escape.

## Summary of irreversible points (in order)

| Step | Action | Irreversible? | Escape |
|---|---|---|---|
| 4 | Bridge proxy `upgrade` | reversible while reservation state is empty | `upgrade` back to `0xc9CE...` |
| 5b | `setReservationRouter` | **yes** (write-once) | none — address must be right |
| 7.4 | `finalizeReservationParametersUpdate` | no until first acceptance | re-stage/re-finalize |
| 8 | `setVaultStatus(true)` | no for the flag; the vault lock is permanent after first acceptance | `setVaultStatus(false)` (fee fallback applies) |
| 9+ | keep-core release with activation block | no (client-side) | remove entry / raise height, re-release |

## Open items (TO VERIFY)

- Exact current holder of the Sepolia deployer key vs `0xb9B8a926...`
  (the pre-flight in this document assumes identity; verify before step 4).
- Whether `.openzeppelin/sepolia.json` (OZ upgrades manifest) should be
  created for this network — the runbook deliberately bypasses the OZ
  plugin for the upgrade and uses the on-chain ProxyAdmin directly; if a
  future step needs `helpers.upgrades.upgradeProxy`, the manifest entries
  for the old and new Bridge implementations must be force-imported first
  (pattern in `deploy/44_upgrade_native_btc_depositor_to_968.ts`).
- The exact `updateFeeReserveTarget` target value (governance decision;
  zero is allowed and must be recorded as a decision).
- `RESERVATION_MAX_TOTAL_AMOUNT_SATS=500000` vs script 97's hardcoded
  `10000000` test value: the ceremony uses the dry-run canonical set above
  (`500000`); confirm governance wants the same values on Sepolia as on the
  mainnet dry run, or run script 97's own values and adjust 7.1/7.2.
- The new governance address (`$NEW_GOV`) and the new Bridge implementation
  address (`$NEW_IMPL`) are not known until step 3 runs; every command that
  references them must be filled in from the script's stdout.
- The exact upgrade path for the **new** BridgeGovernance contract is left
  to the operator: this runbook deploys it fresh (step 3) and hands
  ownership to the deployer EOA; a production runbook would instead have
  the operational governance (Council Safe on mainnet) own it.
