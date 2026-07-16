# ECDSA fraud router drain-and-replace runbook

Status: operational procedure for replacing a previously wired, stateful
`EcdsaFraudRouter`. This procedure does **not** activate FROST/P2TR fraud
handling. FROST custody and automatic P2TR challenge submission remain NO-GO
until the canonical Bitcoin indexer, transactional broadcast outbox,
independent reconciliation, and complete P2TR fraud router are separately
approved.

## Why replacement requires a drain

The legacy router is a plain contract. Its challenge records and ETH escrow
cannot be exported by an implementation upgrade. Repointing Bridge while any
challenge remains open would make that challenge impossible to complete.
Moreover, pre-fix timeout code temporarily decrements its global count before
an untrusted refund callback. A challenger could use that callback to close the
wallet before the timeout callback reaches Bridge.

The upgraded Bridge therefore implements a fail-closed two-stage cutover:

1. `beginEcdsaFraudRouterDrain` pins the authoritative old router, raises the
   submission deposit returned to it to `uint96.max`, and blocks every graceful
   ECDSA wallet closure. Existing defeat and timeout paths remain available.
2. `replaceEcdsaFraudRouter` requires the pinned router still be current and
   have exactly zero open challenges. In one transaction it validates an empty,
   Bridge-bound current-generation replacement; retires and swaps the old
   router; clears the drain; and migrates explicitly inventoried unresolved
   records still held in legacy Bridge storage.

After retirement, Bridge rejects `fraudParameters` calls from the old router so
pre-fix bytecode cannot accept zombie escrow after losing callback authority.
There is intentionally no global-count fallback for wallet closure.

## Preconditions and NO-GO checks

Do not begin if any of these checks fail:

- The Bridge proxy is not yet upgraded to expose
  `ecdsaFraudRouterInDrain`, `beginEcdsaFraudRouterDrain`,
  `replaceEcdsaFraudRouter`, and `isEcdsaFraudRouterRetired`.
- The current router does not expose an exact ABI-encoded
  `openFraudChallengeCount()` value.
- The replacement's `bridge()` is not the target Bridge, its
  `fraudProtocolID()` is not
  `keccak256("tbtc/ecdsa-signature-fraud/router/current-v2")`, or its open
  count is nonzero.
- The full finalized-chain inventory of unresolved legacy Bridge-resident
  challenge keys has not been independently reconstructed and reconciled.
- Governance cannot tolerate graceful ECDSA closure being unavailable for the
  full drain window.

The Bridge implementation upgrade and the `BridgeGovernance` owner call use
different authorities in production and cannot generally be one L1
transaction. Upgrade first. The intermediate state is safe because the drain
fails closed; do not replace until the upgraded getters and behavior have been
verified live.

## 1. Inspect the live state

Use a finalized RPC and the deployment records for the target network:

```sh
ECDSA_CUTOVER_ACTION=inspect \
ECDSA_CUTOVER_REPLACEMENT=0x... \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

Record the Bridge, BridgeGovernance, governance owner, current router, drain
router, old open count, replacement address, replacement code hash, and block
number. A custom deployment must supply the reviewed replacement address with
`ECDSA_CUTOVER_REPLACEMENT`; never assume the named deployment is correct.

For official mainnet/Sepolia deployment histories the router may be fresh or
unwired, but deployment manifests are not proof of current proxy storage.
Always inspect the live getter. If the current value is zero, use the fresh
`44_deploy_ecdsa_fraud_router.ts` wiring path instead of this cutover.

## 2. Inventory Bridge-resident legacy challenges

From the Bridge deployment block through a finalized head, reconstruct every
legacy ECDSA challenge key from transaction calldata and fraud lifecycle
events. Read each corresponding legacy record directly from the upgraded
Bridge and classify it as absent, resolved, or unresolved. Reconcile the result
with an independent indexer/operator and retain the evidence bundle, queried
block hash, and ordered unresolved key list.

An empty list must be represented explicitly as `[]`; absence of a list is not
equivalent to an empty inventory. Router-owned records are not included in this
list—they must resolve in the old router until its authoritative count is zero.

## 3. Begin the fail-closed drain

Generate calldata first:

```sh
ECDSA_CUTOVER_ACTION=begin-drain \
ECDSA_CUTOVER_REPLACEMENT=0x... \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

Submit the printed call through the BridgeGovernance owner. On a development
network whose configured signer is the owner, append
`ECDSA_CUTOVER_EXECUTE=true` to submit directly.

Verify the `EcdsaFraudRouterDrainStarted(oldRouter)` event and that
`ecdsaFraudRouterInDrain()` equals `ecdsaFraudRouter()`. Also verify:

- an ordinary new submission through the old router fails because the returned
  deposit is `uint96.max`;
- defeat and timeout transactions for existing challenges still succeed; and
- `notifyWalletClosingPeriodElapsed` for an ECDSA wallet fails with
  `EcdsaFraudRouterDrainPending`.

Monitor until `oldRouter.openFraudChallengeCount()` is exactly zero at a
finalized block. Do not infer zero from an event index alone.

## 4. Atomically replace and migrate

Generate the exact replacement calldata:

```sh
ECDSA_CUTOVER_ACTION=replace \
ECDSA_CUTOVER_REPLACEMENT=0x... \
ECDSA_LEGACY_FRAUD_INVENTORY_COMPLETE=true \
ECDSA_LEGACY_FRAUD_CHALLENGE_KEYS='["0x...","0x..."]' \
npx hardhat run scripts/ecdsa-fraud-router-cutover.ts --network <network>
```

The script refuses to produce/submit a replacement when the drain pin differs,
the old count is nonzero, the replacement handshake/state is invalid, the
inventory acknowledgement is absent, or the key list is absent/malformed.
Review the target and calldata independently, then submit through governance.
Use `ECDSA_CUTOVER_EXECUTE=true` only on a network where the configured signer
is intentionally the BridgeGovernance owner.

Any bad legacy key, duplicate migrated record, escrow mismatch, or router
validation failure reverts the entire transaction, leaving the old pointer,
drain, and retirement state unchanged.

## 5. Post-cutover verification

At the confirmed replacement block, verify all of the following:

- `EcdsaFraudRouterRetired(old)`, `EcdsaFraudRouterReplaced(old,new)`, and
  `EcdsaFraudRouterSet(new)` were emitted by Bridge.
- `ecdsaFraudRouter()` equals the replacement and
  `ecdsaFraudRouterInDrain()` is zero.
- `isEcdsaFraudRouterRetired(old)` is true.
- The old router's open count remains zero; a new old-router submission fails
  before escrow/state is recorded.
- Every supplied Bridge-resident record was deleted from Bridge, recreated in
  the new router, and transferred with its exact ETH deposit. Reconcile router
  balance and migrated events independently.
- Graceful closure works again for an otherwise eligible ECDSA wallet, while a
  wallet with a new router-owned challenge remains locked by the per-wallet
  counter.

Update watchtower/indexer router pointers only after the finalized cutover
block. Alert on any later call or balance increase involving the retired
router. Forced ETH or historical failed-refund dust in the old contract cannot
be migrated by this procedure and must never be counted as open-challenge
escrow.

## Abort and recovery

Before replacement, the safe response to any inconsistency is to leave the
drain active, continue resolving known challenges, and investigate. There is no
"cancel drain" shortcut because reopening graceful closure against an
unreviewed pre-fix router would recreate the refund-reentrancy window.

If atomic replacement reverts, no cutover state is changed. Correct the
inventory/replacement issue and resubmit. If replacement succeeds, do not point
Bridge back to the retired router; deploy and review another empty,
Bridge-bound current-generation router and perform a new governed drain and
replacement if another rotation is required.
