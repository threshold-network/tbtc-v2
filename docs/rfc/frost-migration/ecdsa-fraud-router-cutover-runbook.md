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
- The signed preflight checkpoint `P` is already finalized. Permissionless
  begin must land at `B` with `64 <= B-P <= T`, where the signed maximum age
  `T` is in `[64,255]`. The contract derives the only staging deadline as
  `D=B+255`.
- The canonical inventory is pinned to the exact drain block `B`. Staging must
  occur only when `B` is 64–255 blocks old and its blockhash is still
  available. Once a valid snapshot is staged, independent confirmation and
  migration do not inherit a blockhash-expiry deadline.
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
  owner can propose a replacement with a distinct signer, source identity,
  durable store, endpoint, trust domain, and policy. The candidate signs an
  enrollment digest; the source authority separately signs the resulting
  recovery digest. The candidate must accept after the exact pinned governance
  delay before it can issue the independent migration confirmation.
- A retired router can never become a later replacement, preventing A→B→A.

## 1. Review and deploy the distinct governance wrapper

Record the live old-governance runtime hash from a trusted RPC and independently
review it against the deployed artifact. Deploy the reviewed replacement router
bound to the target Bridge, but do not activate it.

```sh
umask 077
install -d -m 700 /secure/tbtc-cutover

ECDSA_CUTOVER_DEPLOY_GOVERNANCE=true \
ECDSA_CUTOVER_MANIFEST=/secure/tbtc-cutover/manifest.json \
ECDSA_CUTOVER_OLD_GOVERNANCE_CODE_HASH=0x... \
ECDSA_CUTOVER_REPLACEMENT=0x... \
ECDSA_CUTOVER_SOURCE_SIGNER=0x... \
ECDSA_CUTOVER_SOURCE_ID=0x... \
ECDSA_CUTOVER_LOCAL_SOURCE_ID=0x... \
ECDSA_CUTOVER_SOURCE_JOURNAL=/secure/source/journal.json \
ECDSA_CUTOVER_SOURCE_DURABLE_STORE_IDENTITY=0x... \
ECDSA_CUTOVER_SOURCE_ENDPOINT_IDENTITY=0x... \
ECDSA_CUTOVER_SOURCE_TRUST_DOMAIN=0x... \
ECDSA_CUTOVER_SOURCE_POLICY_HASH=0x... \
ECDSA_CUTOVER_RECONCILER=0x... \
ECDSA_CUTOVER_RECONCILER_SOURCE_ID=0x... \
ECDSA_CUTOVER_RECONCILER_JOURNAL=/independent/reconciler/journal.json \
ECDSA_CUTOVER_RECONCILER_DURABLE_STORE_IDENTITY=0x... \
ECDSA_CUTOVER_RECONCILER_ENDPOINT_IDENTITY=0x... \
ECDSA_CUTOVER_RECONCILER_TRUST_DOMAIN=0x... \
ECDSA_CUTOVER_RECONCILER_POLICY_HASH=0x... \
ECDSA_CUTOVER_EXPECTED_UNRELATED_BRIDGE_BALANCE=... \
ECDSA_CUTOVER_EXPECTED_UNRELATED_EMITTER_BALANCES='{...}' \
npx hardhat deploy \
  --tags DeployEcdsaCutoverBridgeGovernance \
  --network <network>
```

Deployment 87:

1. proves the named historical governance is the live `Bridge.governance()`;
2. preserves its deployment record under the permanent historical name;
3. deploys distinct governance-parameter, verifier-library,
   coordinator-library, and governance artifacts, explicitly linking the
   current verifier into the coordinator;
4. copies the exact live delay and transfers ownership to the live owner/Safe;
5. verifies the old runtime hash and all historical hidden storage slots; and
6. validates physically distinct source and reconciler journals and their
   explicit durable-store UUIDs; and
7. writes a create-only, resumable manifest without changing the canonical
   governance alias.

The manifest pins chain ID, Bridge address/deployment block, old and new
governance addresses and hashes, both storage-layout fingerprints, owner,
delay, old and replacement router addresses and runtime hashes, canonical scan
floor, both authority contexts, the role-specific checkpoint commitments, and
the independent reconciler.

All manifest, inventory, and journal parents must be owned by the invoking user
and must not be group/world writable. Files are accepted only as regular files
owned by that user with mode exactly `0600`; symlinks are rejected. Writes use
an exclusive sibling lock, a file and directory `fsync`, atomic rename, and a
raw-file SHA-256 compare-and-swap token. Never copy the source and reconciler
journals onto the same mount or reuse a durable-store UUID.

## 2. Sign the immutable handoff plan

Print the EIP-191 message payload hash:

```sh
ECDSA_CUTOVER_ACTION=print-plan-hash \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

The source authority and independent reconciler each sign the 32-byte hash as
raw message bytes (`signMessage(arrayify(planHash))`). Supply the signatures as
`ECDSA_CUTOVER_SOURCE_MANIFEST_SIGNATURE` and
`ECDSA_CUTOVER_RECONCILER_MANIFEST_SIGNATURE`. The plan binds the owner’s prior
authorization, both authority contexts, role-specific checkpoint digests,
`P`, its canonical hash, and `T`. Operational phase and transaction hashes may
be appended to the manifest without invalidating the signature; no signed
field may change.

By default the CLI only prints target, calldata, and expected sender. Set
`ECDSA_CUTOVER_EXECUTE=true` only when the expected owner, reconciler, or
permissionless relayer is an intentionally configured local signer. For
permissionless begin/stage submission, also set `ECDSA_CUTOVER_RELAYER`.
Production Safe and transactional-outbox workflows should use the printed
calldata.

## 3. Perform the delayed governance handoff

Begin through the **old** wrapper:

```sh
ECDSA_CUTOVER_ACTION=begin-governance-handoff \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_SOURCE_MANIFEST_SIGNATURE=0x... \
ECDSA_CUTOVER_RECONCILER_MANIFEST_SIGNATURE=0x... \
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
ECDSA_CUTOVER_SOURCE_MANIFEST_SIGNATURE=0x... \
ECDSA_CUTOVER_RECONCILER_MANIFEST_SIGNATURE=0x... \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

Only after reading `Bridge.governance() == newGovernance` does this action move
the canonical deployment alias. Verify the new runtime hash, owner, and exact
delay independently.

## 4. Authorize and begin fail-closed drain

The owner first binds the exact routers, source/reconciler identities and
contexts, scan floor, and emitter set. This call does not start drain:

```sh
ECDSA_CUTOVER_ACTION=authorize-drain \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

Read back the emitted/on-chain owner authorization hash and compare it with the
CLI’s `ownerAuthorizationHash(manifest)`. Then any relayer may submit the dual
authority proof and start drain:

```sh
ECDSA_CUTOVER_ACTION=begin-drain \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_SOURCE_MANIFEST_SIGNATURE=0x... \
ECDSA_CUTOVER_RECONCILER_MANIFEST_SIGNATURE=0x... \
ECDSA_CUTOVER_RELAYER=0x... \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

Immediately before submission, let `P` be the signed preflight block and the
anticipated transaction block be `B=head+1`. The CLI requires
`64 <= B-P <= T`; the contract repeats the check against the actual mined block
and canonical `blockhash(P)`. If the window is closed, run `refresh-preflight`,
independently verify it, collect two new manifest signatures, and retry. A
successful begin stores `B` and derives `D=B+255` on chain.

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

The finalized block is always the on-chain drain block `B`; this is also the
CLI default. If `ECDSA_CUTOVER_FINALIZED_BLOCK` is supplied, it must equal `B`.
Build only after `B` is 64 confirmations deep and before `D=B+255`. The
scanner:

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

## 6. Stage before blockhash expiry, then confirm and migrate

Have each authority sign its role-specific digest from `print-inventory-hash`.
The source and reconciler digests intentionally differ because each binds its
own role and context. Any relayer may then stage:

```sh
ECDSA_CUTOVER_ACTION=stage-inventory \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
ECDSA_CUTOVER_INVENTORY_SOURCE_SIGNATURE=0x... \
ECDSA_CUTOVER_INVENTORY_RECONCILER_SIGNATURE=0x... \
ECDSA_CUTOVER_RELAYER=0x... \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

The CLI rebuilds the canonical inventory and requires byte-for-byte semantic
agreement before staging. The on-chain commitment binds chain ID, Bridge, old
and new routers, both runtime hashes, drain block, scan start/finalized block
and hash, challenge root/count, escrow, each authority context, and both
attestation hashes. The contract requires the finalized block to equal `B`,
requires age 64–255, and rejects staging after `D`.

Confirm from the independent reconciler account:

```sh
ECDSA_CUTOVER_ACTION=confirm-inventory \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

After a successful stage, migrate as governance owner. Confirmation and
migration have no blockhash-expiry deadline because staging already committed
the authenticated snapshot:

```sh
ECDSA_CUTOVER_ACTION=migrate \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

If the blockhash window expires before a successful stage, the cutover cannot
substitute a newer inventory because the snapshot is pinned to `B`. Leave drain
frozen and use a separately reviewed recovery upgrade; do not bypass the
deadline. Once stage succeeds, operational delay during confirmation or
migration does not invalidate the committed inventory.

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
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

This starts a fresh full governance delay. After it elapses, finalize as owner:

```sh
ECDSA_CUTOVER_ACTION=finalize \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
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

Before staging, any discrepancy means: leave drain active and investigate.
Because the authenticated snapshot is exactly the drain block, it cannot be
replaced with a later block. There is intentionally no drain cancel function.

Migration is atomic. A bad key, hash, escrow amount, replacement state, or ETH
transfer reverts every deletion and candidate write. After the supported empty
activation migration, do not attempt to reopen the old router or clear drain.
Correct the operational issue, obtain independent post-migration confirmation,
wait the full delay, and finalize. If nonempty state was moved through the
recovery-only contract path, finalization remains deliberately unavailable and
requires a separately reviewed recovery upgrade.

If the original reconciler key is lost in phase 4, provision a separately
operated recovery journal that contains the staged drain-block checkpoint. Its
signer, source ID, durable-store UUID, endpoint identity, trust domain, and
policy hash must all be independent of both existing authorities.

First print or independently compute the enrollment digest. The candidate
signs that digest as raw bytes. The source authority then signs the recovery
digest, which commits to the enrollment digest and the hash of the candidate’s
signature. Begin the delayed update:

```sh
# Export the manifest, inventory, all three journals, and recovery context first.
ECDSA_CUTOVER_ACTION=print-reconciler-enrollment-hash \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>

ECDSA_CUTOVER_ACTION=print-reconciler-recovery-hash \
ECDSA_CUTOVER_RECOVERY_ENROLLMENT_SIGNATURE=0x... \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

```sh
ECDSA_CUTOVER_ACTION=begin-reconciler-update \
ECDSA_CUTOVER_RECOVERY_RECONCILER=0x... \
ECDSA_CUTOVER_RECOVERY_RECONCILER_SOURCE_ID=0x... \
ECDSA_CUTOVER_RECOVERY_RECONCILER_JOURNAL=/independent/recovery/journal.json \
ECDSA_CUTOVER_RECOVERY_RECONCILER_DURABLE_STORE_IDENTITY=0x... \
ECDSA_CUTOVER_RECOVERY_RECONCILER_ENDPOINT_IDENTITY=0x... \
ECDSA_CUTOVER_RECOVERY_RECONCILER_TRUST_DOMAIN=0x... \
ECDSA_CUTOVER_RECOVERY_RECONCILER_POLICY_HASH=0x... \
ECDSA_CUTOVER_RECOVERY_ENROLLMENT_SIGNATURE=0x... \
ECDSA_CUTOVER_SOURCE_RECOVERY_SIGNATURE=0x... \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

After the pinned governance delay, the proposed reconciler itself accepts:

```sh
ECDSA_CUTOVER_ACTION=finalize-reconciler-update \
ECDSA_CUTOVER_MANIFEST=/secure/cutover-manifest.json \
ECDSA_CUTOVER_INVENTORY=/secure/inventory-<block>.json \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

The CLI reads the pending/current reconciler from chain and emits calldata for
that account. Governance cannot complete the update on the candidate's behalf.
A new proposal overwrites an unusable pending candidate and restarts the full
delay.

If the replacement is later found unsuitable after finalization, deploy a new
empty reviewed router and run another full cutover. The retired-router set
forbids returning to any prior address.
