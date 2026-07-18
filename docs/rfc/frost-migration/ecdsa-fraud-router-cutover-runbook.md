# ECDSA fraud router governance handoff and cutover

Status: operational procedure for an existing, governed Bridge whose stateful
ECDSA fraud router must be replaced safely.

This procedure does **not** activate FROST/P2TR fraud handling or automatic
challenge submission. Those remain NO-GO until the canonical Bitcoin indexer,
transactional broadcast outbox, independent reconciliation, and separately
reviewed P2TR router are deployed and approved.

## Safety model

The cutover deliberately uses a distinct, freshly deployed
`BridgeGovernance`. Historical production governance artifacts do not contain
the coordinator methods and must not be overwritten or relinked in place.

The workflow enforces these invariants:

- The old governance runtime hash and its exact historical storage layout are
  pinned. All hidden pending parameter slots, pending delay fields, and pending
  governance-transfer fields are inspected directly before handoff begins.
- The replacement governance preserves the exact live delay and is owned by
  the same live owner/Safe before the old wrapper starts its delayed transfer.
- The canonical `BridgeGovernance` deployment alias remains the historical
  address until the old wrapper finalizes and `Bridge.governance()` reads back
  the new address. The incumbent remains permanently recorded as
  `BridgeGovernanceBeforeEcdsaCutover`.
- The old and replacement router runtime `EXTCODEHASH` values are signed and
  checked on every sensitive transition. Router handshake getters are
  supplemental, not the trust root. Every replacement also immutably pins the
  predecessor address and runtime hash; bounded traversal validates those pins
  through the terminal protocol-v2 router so resolved challenge identities can
  never be resurrected by a later generation.
- Governance handoff and router cutover are mutually exclusive. A pending
  Bridge-governance transfer blocks drain, and phases 1–5 block both beginning
  and finalizing a transfer. The fail-closed drain therefore cannot be orphaned
  by changing `Bridge.governance()` away from its coordinator.
- Drain is fail-closed and has no cancel path. It blocks new old-router
  challenges and all graceful ECDSA closure while allowing existing old-router
  challenges to resolve.
- The canonical legacy inventory starts at the Bridge deployment block. The
  scanner cannot shorten this range and must scan through a finalized block at
  or after the drain block.
- Staging, independent confirmation, and migration use a block that is 64–255
  blocks old. If its hash expires before migration, stage and independently
  confirm a newer snapshot; drain stays frozen throughout.
- Activation is permitted only for an empty canonical inventory. The CLI
  refuses to begin drain unless a fresh finalized reconstruction proves zero
  unresolved Bridge-resident records, zero legacy escrow, and zero old-router
  challenges. The on-chain finalizer independently requires zero committed
  count/escrow and walks every pinned predecessor to require zero unresolved
  state. The nonempty migration machinery remains recovery-only and can never
  activate a router.
- An independent account reads back both replacement counts and the exact
  escrow liability counter at zero. A full governance delay then runs before
  finalization repeats the readback, starts the router's migration-defense
  epoch, swaps the pointer, retires the old router, and finally clears drain.
- If the original reconciler key becomes unavailable after migration, the
  owner can propose a distinct replacement. The candidate must accept after
  the exact pinned governance delay before it can issue the independent
  migration confirmation.
- A retired router can never become a later replacement, preventing A→B→A.

## 1. Review and deploy the distinct governance wrapper

Record the live old-governance runtime hash from a trusted RPC and independently
review it against the deployed artifact. Deploy the reviewed replacement router
bound to the target Bridge, but do not activate it.

```sh
ECDSA_CUTOVER_DEPLOY_GOVERNANCE=true \
ECDSA_CUTOVER_OLD_GOVERNANCE_CODE_HASH=0x... \
ECDSA_CUTOVER_REPLACEMENT=0x... \
ECDSA_CUTOVER_RECONCILER=0x... \
npx hardhat deploy \
  --tags DeployEcdsaCutoverBridgeGovernance \
  --network <network>
```

Deployment 87:

1. proves the named historical governance is the live `Bridge.governance()`;
2. preserves its deployment record under the permanent historical name;
3. deploys distinct governance-parameter, coordinator-library, and governance
   artifacts;
4. copies the exact live delay and transfers ownership to the live owner/Safe;
5. verifies the old runtime hash and all historical hidden storage slots; and
6. writes a resumable manifest without changing the canonical governance alias.

The manifest pins chain ID, Bridge address/deployment block, old and new
governance addresses and hashes, both storage-layout fingerprints, owner,
delay, old and replacement router addresses and runtime hashes, canonical scan
floor, and independent reconciler.

## 2. Sign the immutable handoff plan

Print the EIP-191 message payload hash:

```sh
ECDSA_CUTOVER_ACTION=print-plan-hash \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

The independent reconciler signs the 32-byte hash as raw message bytes
(`signMessage(arrayify(planHash))`). Set the resulting signature as
`ECDSA_CUTOVER_MANIFEST_SIGNATURE` for every mutating action. Operational phase
and transaction hashes may be appended to the manifest without invalidating
the signature; no signed field may change.

By default the CLI only prints target, calldata, and expected sender. Set
`ECDSA_CUTOVER_EXECUTE=true` only when the expected owner or reconciler is an
intentionally configured local signer. Production Safe calls should use the
printed calldata.

## 3. Perform the delayed governance handoff

Begin through the **old** wrapper:

```sh
ECDSA_CUTOVER_ACTION=begin-governance-handoff \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_MANIFEST_SIGNATURE=0x... \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

The CLI repeats the exact runtime/storage inspection immediately before
generating or sending the call. If any hidden parameter or delay update is
pending, stop and resolve it through the historical process. A rerun accepts
only an already-pending transfer to the signed replacement address.

After the exact live governance delay, finalize through the **old** wrapper:

```sh
ECDSA_CUTOVER_ACTION=finalize-governance-handoff \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_MANIFEST_SIGNATURE=0x... \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

Only after reading `Bridge.governance() == newGovernance` does this action move
the canonical deployment alias. Verify the new runtime hash, owner, and exact
delay independently.

## 4. Begin fail-closed drain

```sh
ECDSA_CUTOVER_ACTION=begin-drain \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_MANIFEST_SIGNATURE=0x... \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

Verify all of the following from live calls, not deployment files or events:

- `Bridge.ecdsaFraudRouter()` is the signed old router;
- `Bridge.ecdsaFraudRouterInDrain()` is the same old router;
- `Bridge.ecdsaFraudRouterCodeHash()` is its signed runtime hash;
- `BridgeGovernance.bridgeGovernanceTransferChangeInitiated()` is zero;
- the old router is not retired;
- new old-router submissions fail;
- existing defeat/timeout operations still work; and
- graceful ECDSA closure fails with the drain-pending error.

Wait until `oldRouter.openFraudChallengeCount()` is exactly zero on a finalized
block. Event-derived counts are not sufficient.

Before the CLI emits the irreversible drain transaction it also rebuilds the
complete Bridge-resident legacy inventory at a 64-confirmation block. It
refuses any nonzero challenge count or escrow. Resolve or migrate such legacy
records through the currently active router before beginning drain; there is no
safe cancel after drain starts.

## 5. Build the canonical inventory

Once the drain block is at least 64 confirmations deep:

```sh
ECDSA_CUTOVER_ACTION=build-inventory \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_INVENTORY_OUT=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

The default finalized block is current head minus 64. An explicit block can be
selected with `ECDSA_CUTOVER_FINALIZED_BLOCK`. The scanner:

- queries every Bridge `FraudChallengeSubmitted` log from the signed Bridge
  deployment block through the finalized block, in bounded RPC ranges;
- fetches the original transaction calldata to reconstruct each challenge key;
- reads the exact legacy mapping slots at that historical block;
- keeps only unresolved records and orders keys strictly increasing;
- computes the exact record root and escrow sum;
- reads the old router count and Bridge balance at the same block; and
- records an event-source digest and finalized block hash.

The absolute legacy mapping slot is derived from and tested against the
compiled Bridge storage layout. Its fingerprint is part of the signed manifest,
so a stacked upgrade that shifts storage fails the formal layout check and the
operator preflight.

Run the same reconstruction on the independent reconciler infrastructure and
compare the complete evidence bundle, not only the key count.

For an activation cutover, the resulting bundle must have an empty key array,
zero count, and zero escrow. A nonempty bundle is a stop condition, not an
activation input.

## 6. Stage, confirm, and migrate before blockhash expiry

Stage as governance owner:

```sh
ECDSA_CUTOVER_ACTION=stage-inventory \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_MANIFEST_SIGNATURE=0x... \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

The CLI rebuilds the canonical inventory and requires byte-for-byte semantic
agreement before staging. The on-chain commitment binds chain ID, Bridge, old
and new routers, both runtime hashes, drain block, scan start/finalized block
and hash, challenge root/count, and escrow.

Confirm from the independent reconciler account:

```sh
ECDSA_CUTOVER_ACTION=confirm-inventory \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_MANIFEST_SIGNATURE=0x... \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

Migrate as governance owner before the finalized block becomes 256 blocks old:

```sh
ECDSA_CUTOVER_ACTION=migrate \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_MANIFEST_SIGNATURE=0x... \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

If the blockhash window expires before migration, build a newer inventory and
repeat stage and confirmation. This is permitted even after an earlier
inventory was confirmed, but never after migration. The old pointer and drain
remain unchanged.

For the empty activation inventory, migrate with an empty key array. After the
transaction, independently verify:

- replacement open and unattributed counts are zero;
- `openFraudChallengeEscrow` is zero;
- `migratedChallengesActivatedAt` is still zero while inactive; and
- current router and drain still both point to the old router.

## 7. Confirm migration, wait, and finalize

The reconciler confirms the independent post-migration readback:

```sh
ECDSA_CUTOVER_ACTION=confirm-migration \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_MANIFEST_SIGNATURE=0x... \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

This starts a fresh full governance delay. After it elapses, finalize as owner:

```sh
ECDSA_CUTOVER_ACTION=finalize \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_MANIFEST_SIGNATURE=0x... \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

Finalization repeats the entire post-migration readback before atomically
setting the replacement pointer and hash, permanently retiring the old router,
starting a nonzero `migratedChallengesActivatedAt` epoch, and clearing drain.
It rejects nonzero committed inventory and nonzero count/escrow anywhere in the
pinned predecessor ancestry. Verify the coordinator state is idle (including
cleared pending-reconciler fields), the replacement is current, drain is zero,
the old router is retired, and the approved hash is the signed replacement
runtime hash.

Update external indexer/watchtower router pointers only after this transaction
is finalized. This procedure still does not authorize FROST/P2TR fraud
activation.

## Abort and recovery

Before migration, any discrepancy means: leave drain active, investigate, and
stage a fresh finalized snapshot if necessary. There is intentionally no drain
cancel function.

Migration is atomic. A bad key, hash, escrow amount, replacement state, or ETH
transfer reverts every deletion and candidate write. After the supported empty
activation migration, do not attempt to reopen the old router or clear drain.
Correct the operational issue, obtain independent post-migration confirmation,
wait the full delay, and finalize. If nonempty state was moved through the
recovery-only contract path, finalization remains deliberately unavailable and
requires a separately reviewed recovery upgrade.

If the original reconciler key is lost in phase 4, choose a distinct recovery
reconciler and have it sign the immutable plan hash. Begin the delayed update:

```sh
ECDSA_CUTOVER_ACTION=begin-reconciler-update \
ECDSA_CUTOVER_RECOVERY_RECONCILER=0x... \
ECDSA_CUTOVER_RECOVERY_SIGNATURE=0x... \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

After the pinned governance delay, the proposed reconciler itself accepts:

```sh
ECDSA_CUTOVER_ACTION=finalize-reconciler-update \
ECDSA_CUTOVER_RECOVERY_SIGNATURE=0x... \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

Use the same recovery signature for `confirm-migration`; the CLI reads the
current reconciler from chain and emits calldata for that account. Governance
cannot complete the update on the candidate's behalf. A new proposal overwrites
an unusable pending candidate and restarts the full delay.

If the replacement is later found unsuitable after finalization, deploy a new
empty reviewed router and run another full cutover. The retired-router set
forbids returning to any prior address.
