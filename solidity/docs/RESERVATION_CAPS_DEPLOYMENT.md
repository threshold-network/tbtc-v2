# Reservation Caps Deployment Instructions for All Actors

## Overview

The milestone-1 reservation subsystem introduces two governance setters with a deploy-ordering dependency and two further ABI/event arguments relative to the #1094 specification. This document covers the new coordination requirements.

Changes relative to #1094:

- `updateReservationCaps` now takes two further arguments, `maxThirdPartyReanchorHoldsPerWallet` (uint32, zero allowed) and `handoffReserveWallets` (uint32, at least one). The 4-byte selector changes; existing Defender / Safe / Tenderly / multisend scripts that encode the 3-argument or 4-argument version will revert.
- The `ReservationCapsUpdated` event gained two further fields, `maxThirdPartyReanchorHoldsPerWallet` and `handoffReserveWallets`. Off-chain indexers and dashboards that decode the 3-field or 4-field version will need to update their event ABI; consumers that only read a subset of fields and ignore unknown trailing fields may only need a rebind/restart.
- `updateReservationParameters` enforces the Decision 1 on-chain relational check `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` by reading both `self.maxActiveReservations` and `self.reservationMaxSingleAmount` from storage. In the pristine pre-launch bootstrap state, both are zero, so the check short-circuits and any `reservationMaxTotalAmount` is accepted. Subsequent calls can revert with `Amount cap exceeds slot capacity` if governance sets `reservationMaxTotalAmount` first and the later `updateReservationCaps` operands cannot accommodate it.
- A second, independent precondition applies whenever `updateReservationParameters` changes `reservationVault` to a non-zero address: the stored `self.maxActiveReservations` must already be greater than zero, or the call reverts with `Max active reservations must be greater than zero`. On a chain that has never run `updateReservationCaps`, `maxActiveReservations` is zero, so the bootstrap write that wires the vault into the Bridge **cannot** be the first reservation write. The caps write must land first — see "Deploy Order (Decision 1)".
- `requestReservationReanchor` now takes a source-wallet member proof (`walletMembersIDs`, `walletMemberIndex`). The reservation owner, an SPV maintainer, and a proven source-wallet member are exempt from the per-target third-party re-anchor hold cap; every other caller reserves a pending third-party hold against the target wallet and reverts with "Target third-party re-anchor holds exceeded" once the target's pending count reaches `maxThirdPartyReanchorHoldsPerWallet` (zero blocks third-party holds entirely).

---

## Deploy Order (Decision 1)

During the initial bootstrap of the reservation subsystem, `updateReservationCaps` **must** land before `updateReservationParameters`. Two independent on-chain reasons make that order mandatory rather than merely recommended:

1. **The vault-wiring precondition.** `updateReservationParameters` only re-points `reservationVault` when the value actually changes. On a chain where the vault has never been wired, that write changes the value from the zero address to the vault address, and the setter then requires `self.maxActiveReservations > 0`, reverting with `Max active reservations must be greater than zero` otherwise. `maxActiveReservations` is written only by `updateReservationCaps`, so on a fresh chain the parameters write cannot go first.
2. **The Decision 1 relational check.** `updateReservationCaps` mirrors the check that `updateReservationParameters` owns: it re-evaluates `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` using its _own_ new operands against the _stored_ `reservationMaxTotalAmount`. If the parameters write landed first and committed a total that the later caps operands cannot accommodate, that caps write reverts with `Amount cap exceeds slot capacity`.

The check itself short-circuits when either operand is zero (`reservationMaxSingleAmount == 0 || maxActiveReservations == 0`), which is why the pristine pre-launch state accepts any total. That short-circuit is what makes the _first_ (caps) write safe: at that moment the stored `reservationMaxTotalAmount` is still 0, so the check evaluates `0 <= anything`. It is **not** a licence to write the parameters first on a fresh chain, because reason (1) still applies independently of the relational check.

Safe operational sequence (the ordering the staged governance ceremony in "Activation Runbook" implements):

1. Call `updateReservationCaps(maxReservationsAmountPerWallet, reservationMaxSingleAmount, maxActiveReservations, maxThirdPartyReanchorHoldsPerWallet, handoffReserveWallets)` — sets the per-wallet amount cap, the single-reservation amount cap, the global occupancy cap, the per-target third-party re-anchor hold cap and the hand-off reserve together. `maxActiveReservations` must be greater than zero or the call reverts with `Active reservations cap must be greater than zero`, and `handoffReserveWallets` must be greater than zero or it reverts with `Hand-off reserve must be greater than zero`. The Decision 1 check evaluates `0 <= maxActiveReservations * reservationMaxSingleAmount` (trivially true because the stored `reservationMaxTotalAmount` is still 0).
2. Call `updateReservationParameters(reservationVault, ...)` — sets `reservationMaxTotalAmount` and the other parameters, and wires the vault address into the Bridge (there is no separate `setReservationVault` setter). The Decision 1 check now evaluates `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` against the just-set storage values, and the vault-repoint branch sees `maxActiveReservations > 0`.

If the two updates must land in the same block, an atomic multicall preserves the ordering guarantee.

The existing regression test `Bridge.ReservationCaps.test.ts` in the `describe("bootstrap ordering")` group pins both the deploy-ordering hazard and the safe operational order; review it before any deployment.

---

## Activation Runbook

This section is the executable ceremony. Every selector, argument, actor and delay below is taken from the merged contracts and deploy scripts; nothing here is illustrative.

### Two distinct governance paths — do not conflate them

**Proxy upgrades**

- Actor: the ProxyAdmin owner, acting through the Timelock.
- Contract called: `ProxyAdmin.upgrade` / `ProxyAdmin.upgradeAndCall`.
- Delay: the Timelock's `minDelay` (24h on mainnet).
- Ownership: the ProxyAdmin is owned by the Timelock.

**Reservation bootstrap**

- Actor: the Council Safe, acting through `BridgeGovernance`.
- Contract called: `BridgeGovernance.<method>`.
- Delay: `BridgeGovernance.governanceDelays(0)` = 172800s (48h) for the `begin*`/`finalize*` pairs; the one-off hooks carry no delay.
- Ownership: `BridgeGovernance` is `Ownable`, owned by the Council Safe.

Routing a reservation setter through the Timelock makes `msg.sender` the Timelock and reverts on `BridgeGovernance`'s `onlyOwner` check. There is no bypass in the other direction either: a proxy upgrade must go through the Timelock, because `ProxyAdmin` is `Ownable` and its owner is the Timelock, so a direct `ProxyAdmin.upgrade` from the Council Safe is rejected by `ProxyAdmin`'s `onlyOwner` check. The two paths are independent ceremonies, and neither one can be used in place of the other.

### Pre-flight — Irreversibility sign-off (before Stage 0)

The vault address is a one-time choice. `Reservation.updateReservationParameters` only touches `reservationVault` when the incoming value differs from the stored one, and that branch is gated on two counters:

```solidity
require(self.reservationTotalAmount == 0, "Active reservations exist");
require(self.pendingReservedDeposits == 0, "Pending reserved deposits exist");
```

That is `Reservation.sol:1671-1678`, inside the `reservationVault != self.reservationVault` branch at `Reservation.sol:1664-1681`. Once the first reservation is accepted, `reservationTotalAmount` is non-zero and the Bridge refuses **any** new vault address: neither a different non-zero address nor the zero address can be written until both counters are back to zero. In milestone 1 that cleared state is reachable only through wallet termination, stranding and acceptance timeouts (see "Irreversible Vault Activation Warning" below), so the accepted vault is fixed for the lifetime of every live reservation.

The lock starts earlier than the acceptance. A revealed reserved deposit that is still awaiting acceptance already holds `pendingReservedDeposits` above zero (`Deposit.sol:395`), and either counter alone blocks the write, so the vault is effectively frozen from the first reserved deposit reveal onwards, not from its settlement.

Nothing on-chain enforces the sign-off. It is a precondition the signers and the release owner impose on themselves, and it lands before any reservation write precisely because no reservation write can be undone afterwards. Complete all four points before Stage 0:

1. **Obtain the written acknowledgement.** The Threshold Council governance signers acknowledge, in the governance log and in their own signatures, that once the first reservation is accepted the Bridge refuses a new `reservationVault` address, and that milestone 1 offers no voluntary exit that would reopen the gate.
2. **Name the address it covers.** The acknowledgement must name the exact `RESERVATION_VAULT` address. A later change of that address needs its own acknowledgement, signed before the reservation call that would wire it.
3. **Record the client activation block.** The release owner records the client activation block that will be compiled into the keep-core release. The recorded block must satisfy the C-4 ordering enforced by the "Client Activation Ordering Gate" below: chosen before the release is built, live on every operator before the block is reached, and `setVaultStatus(vault, true)` (Call 6) executed at or after it. Record it in the same governance log entry as the acknowledgement.
4. **Gate the ceremony on both.** Stage 0 does not start until the signed acknowledgement and the recorded client activation block are in the governance log; the go/no-go for the ceremony is that pair, not the delay windows.

### Stage 0 — Establish a reservation-capable `BridgeGovernance`

The reservation setters only exist on a `BridgeGovernance` build that carries them. Decide **fresh deployment vs. reuse** from on-chain state, not from the repository — and never from a bytecode substring match. A selector present in the deployed bytecode proves at most that _some_ build exposes that selector: it does not identify the deployed source revision, the linked libraries, or the ABI, so a `cast code ... | grep -c <selector>` scan may support inspection but never authorizes reuse. Every candidate — reused or freshly deployed — must clear the same two preflights. Declare the addresses as environment variables first; every `cast` command in this document is read-only and broadcasts nothing:

```bash
: "${BRIDGE:?Set BRIDGE from the verified Bridge deployment record}"
: "${BRIDGE_GOVERNANCE:?Set BRIDGE_GOVERNANCE from the verified candidate deployment}"
: "${COUNCIL_SAFE:?Set COUNCIL_SAFE from the approved governance record}"
: "${REBATE_STAKING_PROXY:?Set REBATE_STAKING_PROXY from the verified deployment record}"
: "${REBATE_STAKING_IMPL:?Set REBATE_STAKING_IMPL from the proxy implementation slot}"
: "${RESERVATION_VAULT:?Set RESERVATION_VAULT from the verified deployment record}"
: "${FEE_RESERVE_TARGET:?Set FEE_RESERVE_TARGET to the approved integer base-unit amount}"

# The reservation API must be callable on the candidate.
cast call "$BRIDGE_GOVERNANCE" "governanceDelays(uint256)(uint256)" 0 # expect 172800
cast call "$BRIDGE_GOVERNANCE" "owner()(address)"                     # expect $COUNCIL_SAFE
cast call "$BRIDGE" "governance()(address)"                           # expect the candidate, after Stage 1
```

1. **Correct deployment, source and ABI.** The candidate's deployment is recorded, its deployed bytecode matches the artifact built from this repository's `BridgeGovernance.sol` together with its linked library `BridgeGovernanceParameters`, and its ABI exposes the whole reservation surface this runbook uses — `setReservationRouter(address)`, `beginReservationCapsUpdate(uint64,uint64,uint32,uint32,uint32)`, `finalizeReservationCapsUpdate()`, `pendingReservationCapsUpdate()`, `beginReservationParametersUpdate(address,uint64,uint64,uint32,uint32,uint64,uint32,uint32,uint32)`, `finalizeReservationParametersUpdate()`, `setVaultStatus(address,bool)`, plus the `governanceDelays(uint256)` and `owner()` getters. A candidate built from a different source revision, or linked differently, is a fresh-deployment decision, not a reuse decision.
2. **Successful read-only preflights.** Each call above must succeed. Verify the candidate's `governanceDelays(0)` and Council Safe ownership. Record `Bridge.governance()` before the handoff: it may still return the old governance address. Equality with the candidate is the postcondition of Stage 1, not a prerequisite for deploying the candidate. A candidate still owned by the deployer must transfer ownership to the Council Safe before Safe calls.

- **Reuse** a candidate whose deployment, source, ABI, owner and delay are verified. Stage 1 determines whether the Bridge governance handoff is still required.
- **Fresh deployment** is required if no verified reservation-capable candidate exists. Deploy `BridgeGovernanceParameters` and `BridgeGovernance` as `deploy/09_deploy_bridge_governance.ts` specifies (`args: [Bridge.address, 172800]`; 60s only on Sepolia), then transfer ownership to the Council Safe as `deploy/22_transfer_bridge_governance_ownership.ts` specifies. Verify the source, ABI, owner and delay before Stage 1; verify `Bridge.governance()` equals the candidate after Stage 1.

### Stage 1 — Hand Bridge governance over to `BridgeGovernance` (48h)

`BridgeGovernance`'s setters call into the Bridge, and the Bridge accepts them only from its own `governance` slot. That slot must point at `BridgeGovernance` before any reservation call.

If the Bridge's governance already points at a reservation-capable `BridgeGovernance`, skip Stage 1 and record that fact in the governance log. Otherwise the handoff runs through the **old** `BridgeGovernance`, which owns the Bridge:

1. Council Safe → old `BridgeGovernance.beginBridgeGovernanceTransfer(newBridgeGovernance)` (selector `0x8b18a505`). One-off, no delay on the begin itself.
2. Wait the governance delay of the _old_ `BridgeGovernance` (read `governanceDelays(0)` on it; 172800s on mainnet).
3. Council Safe → old `BridgeGovernance.finalizeBridgeGovernanceTransfer()` (selector `0x605da053`). This calls `Bridge.transferGovernance(newBridgeGovernance)`.

Verify after the finalize: re-run the Stage 0 preflight `cast call "$BRIDGE" "governance()(address)"` and confirm it now returns the new `BridgeGovernance` (until this handoff completes it returns the old one).

### Stage 2 — RebateStaking and Bridge implementation ordering

The Bridge implementation upgrade and the `RebateStaking` proxy upgrade are **proxy upgrades**: they run through the ProxyAdmin under the Timelock's 24h delay (see "Two distinct governance paths" above). They are not part of the 48h reservation ceremony, but their relative order matters.

Ordering hazard: the Bridge's `Deposit` and `Redemption` libraries call `RebateStaking` for the treasury-fee rebate. `Redemption` calls `RebateStaking.isRebateAuthorized(address,address)` (selector `0x96253dad`) on the callback-redemption path, and `Deposit`/`Redemption` call `applyForRebate(address,uint64,uint8)`. `RebateStaking` has **no fallback function**: a call to a selector the installed implementation does not expose reverts. So a Bridge implementation that calls a newer `RebateStaking` selector while the on-chain `RebateStaking` proxy still points at the older implementation turns ordinary deposits and redemptions into reverting calls.

Therefore: **the `RebateStaking` proxy upgrade must land before, or in the same scheduled batch as and ahead of, the Bridge implementation upgrade.** The existing upgrade scripts already encode that order — the `RebateStaking` proxy upgrade is Timelock action `[0]` and the Bridge upgrade is action `[1]` in `deploy/85_deploy_tip109_governance_upgrade.ts` and `deploy/86_deploy_tip109_hotfix.ts`.

Fresh on-chain selector and state verification before submitting either upgrade:

```bash
# 1. Which implementation does the RebateStaking proxy point at? EIP-1967
#    implementation slot, as used by deploy/85_deploy_tip109_governance_upgrade.ts.
cast storage "$REBATE_STAKING_PROXY" 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc

# 2. Does that implementation expose the selectors the new Bridge libraries call?
cast code "$REBATE_STAKING_IMPL" | grep -c 96253dad # isRebateAuthorized(address,address)
cast code "$REBATE_STAKING_IMPL" | grep -c cd2387f6 # applyForRebate(address,uint64,uint8)

# 3. The proxy's Bridge pointer must stay the Bridge proxy across the upgrade.
cast call "$REBATE_STAKING_PROXY" "bridge()(address)"

# 4. The Bridge's rebate pointer, before and after.
cast call "$BRIDGE" "getRebateStaking()(address)" # selector 0x3edf8238

# 5. The Bridge proxy's initializer slot: the reservation upgrade needs no bump.
cast storage "$BRIDGE" 0x32 # slot 50; expect 5 (the spent reinitializer(5))
```

The `applyForRebate` selector above is the one the current `RebateStaking` source exposes. Those greps are inspection only: they show that a selector string occurs in the installed bytecode, not which source revision produced it, so they never on their own establish compatibility. Verify the implementation actually being installed — its deployed bytecode and its ABI — rather than assuming: the `RebateStaking` deployment artifacts recorded in this repository predate the current source, so an older installed implementation may expose a different `applyForRebate` selector than the one the newly deployed Bridge libraries will call. If the Bridge's `getRebateStaking()` is still the zero address, the Bridge-side wiring (`BridgeGovernance.setRebateStaking(address)`, selector `0xca73c462`) has not run yet; that call is a direct `onlyOwner` action on `BridgeGovernance` with no staging delay, and it is separate from the reservation ceremony.

Schedule `ProxyAdmin.upgrade(proxy, implementation)` through the Timelock. This reservation implementation introduces no new initializer. Verify the expected zero bits and slots against the recorded pre-upgrade storage layout before the implementation swap; do not assume that deployed state matches the expected layout.

Do **not** replay the TIP-109 `upgradeAndCall` payload. At the rehearsed block, initializer slot 50 held version 5 and `initializeV5_RepairRebateStaking(address)` was already spent. Recheck the current initializer version and layout before this upgrade. The expected reservation path is plain `ProxyAdmin.upgrade(Bridge, newImplementation)`, without an initializer call. If the live version is not the expected 5, or a different implementation requires another initializer, stop for a separate maintainer-reviewed upgrade plan.

### Stage 3 — The six Council Safe → `BridgeGovernance` calls

All six calls target `BridgeGovernance` and are submitted by the Council Safe (its owner). The `begin*`/`finalize*` pairs each wait 48h; the two one-off hooks carry no delay.

**Call 1 — `setReservationRouter(router)`** (selector `0xd394a4d3`, one-off, no delay).

Must be first. Every later reservation selector (`updateReservationCaps`, `updateReservationParameters`, and the reservation getters) is a router selector reached through `Bridge.fallback()`, and the fallback reverts with `Reservation router not set` while the router is unset. The Bridge-side setter is write-once: it reverts with `Reservation router already set` on a second call, requires a non-zero address, and requires the address to be a contract. Pre-check with `cast call "$BRIDGE" "getReservationRouter()(address)"` (selector `0x5157ec0a`); expect the zero address.

**Call 2 — `beginReservationCapsUpdate(maxReservationsAmountPerWallet, reservationMaxSingleAmount, maxActiveReservations, maxThirdPartyReanchorHoldsPerWallet, handoffReserveWallets)`** (selector `0x4c1cda81`).

Stages all five caps values. `maxActiveReservations` must be greater than zero, and `handoffReserveWallets` must be greater than zero.

**Preflight before Call 2 — read the pending caps slot.** `BridgeGovernance` holds exactly one staged caps slot, and `beginReservationCapsUpdate` overwrites it in place: a second `begin` replaces the tuple and the initiation timestamp with no prompt, no revert and no cancel. Before submitting the begin, read what is already staged:

```sh
cast call "$BRIDGE_GOVERNANCE" \
  "pendingReservationCapsUpdate()(uint64,uint64,uint32,uint32,uint32,uint256)"
```

The call (selector `0x2f6962b6`) returns the five staged values in this function's argument order, then the initiation timestamp. An all-zero tuple with a zero timestamp means nothing is staged. A non-zero timestamp means another caps change is already staged — a capacity reduction ahead of activation, for instance, which stages the same five values through the same slot — and this begin will replace it silently. Record the returned tuple and the timestamp in the governance log, together with the begin that follows. This read replaces the earlier workaround of comparing the last `ReservationCapsUpdateStarted` on `BridgeGovernance` against the last `ReservationCapsUpdated` on the Bridge: the event pair can only be compared after the fact, while the view reports the slot itself. `finalizeReservationCapsUpdate` clears the timestamp, so the same read after a finalize confirms the slot is empty again.

**Call 3 — `beginReservationParametersUpdate(reservationVault, reservationMinAmount, reservationTxMaxFee, reservationTermSeconds, reservationDissolutionDelay, reservationMaxTotalAmount, maxReservationsPerWallet, reservationActionTimeout, reservationRenewalWindowSeconds)`** (selector `0x674ccdcb`).

Stages all nine parameters, including the vault address — there is no separate `setReservationVault`. The `begin*` calls carry no ordering constraint among themselves and may be batched; only the two `finalize*` calls are order-constrained.

**Wait 48 hours.** Read the live delay from `governanceDelays(0)` on the `BridgeGovernance` that owns the staged change. The `begin*` calls are not delayed: they only record the initiation timestamp (`block.timestamp`) of the staged change. The delay is enforced on the `finalize*` calls, each of which reverts with `Governance delay has not elapsed` unless `block.timestamp - <its own initiation timestamp> >= governanceDelay`. Each staged pair carries its own initiation timestamp, so a single 48h wait suffices when Calls 2 and 3 are submitted in the same batch; if they are submitted separately, each pair needs its own full delay measured from its own begin.

**Call 4 — `finalizeReservationCapsUpdate()`** (selector `0x7d87eff2`).

Applies the staged caps. Must execute **before** Call 5: the parameters finalize reads the caps this call writes.

**Call 5 — `finalizeReservationParametersUpdate()`** (selector `0x093bc481`).

Applies the staged parameters and wires the vault into the Bridge. On a fresh bootstrap, finalizing parameters **before** caps does not reach the slot-capacity check at all: the vault-wiring branch fires first and reverts with `Max active reservations must be greater than zero`, because the stored `maxActiveReservations` is still zero. `Amount cap exceeds slot capacity` is the _second_, independent guard: it fires only once `maxActiveReservations > 0` is already stored (i.e. the caps write has landed) and the staged total exceeds `maxActiveReservations * reservationMaxSingleAmount`. Both guards are described under "Deploy Order (Decision 1)"; a params-first attempt on a fresh chain hits the first one.

**Call 6 — `setVaultStatus(vault, true)`** (selector `0x60d712fc`, one-off, no delay). Marks the vault trusted. It must not execute before Call 5 is confirmed on-chain: while `reservationVault` is still the zero address, a trusted vault lets deposits routed to it be revealed as ordinary, non-reserved deposits. It must also not execute before the client gate in "Client Activation Ordering Gate" is satisfied.

### SPV Maintainer Authorization for Reservation Proofs (mainnet, no delay)

On mainnet, reservation proofs are submitted **directly** by keep-core maintainer addresses. There is no proxy in the path and no gas refund: the maintainer whose key signs the transaction pays for it.

**Which calls are gated.** Both reservation settlement entry points are `onlySpvMaintainer`:

- `submitReservationAcceptanceProof(BitcoinTx.Info,BitcoinTx.Proof,uint256,uint64)` — `ReservationRouter.sol:293-298`.
- `submitReservationReanchorProof(BitcoinTx.Info,BitcoinTx.Proof,uint256,uint64)` — `ReservationRouter.sol:319-324`.

The modifier (`ReservationRouter.sol:202-206`) requires `self.isSpvMaintainer[msg.sender]` and reverts with `Caller is not SPV maintainer` otherwise. Both functions are router selectors served by `Bridge.fallback()`'s `delegatecall`, which preserves the external caller's `msg.sender`, so the address to authorize is exactly the address the keep-core client sends the proof transaction from.

**Why `MaintainerProxy` is not used.** `MaintainerProxy` exposes no reservation proof entry point and has no fallback, so it cannot relay these calls at all, and its `ReimbursementPool.refund` path covers only the proofs it wraps (deposit sweep, redemption, moved funds sweep, and the wallet-maintainer calls). A reservation proof therefore earns no refund, and its gas cost stays with the maintainer. Budget that cost explicitly in the operator runbook; do not assume the existing refund flow carries over.

**The governance call.** `BridgeGovernance.setSpvMaintainerStatus(address,bool)` (`BridgeGovernance.sol:317-322`, selector `0x5f2b2d0d`) is `onlyOwner` and forwards to `Bridge.setSpvMaintainerStatus` (`Bridge.sol:1313-1319`, `onlyGovernance`).

- Actor: the Council Safe, as the owner of `BridgeGovernance`. One Safe transaction per address, no `begin*`/`finalize*` pair.
- Delay: **none**. This is a one-off hook, not one of the six ceremony calls in Stage 3, so it does not wait out `governanceDelays(0)` and may be executed while the 48h window of Calls 2 and 3 is still running.
- Path: it must not be routed through the Timelock. A Timelock-signed call arrives with `msg.sender = Timelock` and reverts on `BridgeGovernance`'s `onlyOwner`.
- Precondition: Stage 1 is complete, that is, `Bridge.governance()` already returns the `BridgeGovernance` being called. Otherwise the forward call into the Bridge reverts on the Bridge's own `onlyGovernance` check.

**Addresses to authorize.** Take the keep-core maintainer addresses designated for reservation proof submission from the approved operator record, and authorize every one of them with `isTrusted = true`. The record must enumerate each address: a proof transaction sent from an unlisted address reverts at the modifier, and its acceptance or re-anchor stays unsettled until an authorized maintainer resubmits it. The flag is not a pure submission whitelist, so do not authorize a superset: `isSpvMaintainer` also makes the caller privileged in `requestReservationReanchor` (`Reservation.sol:818-822`), where it is exempt from the per-target third-party re-anchor hold cap and its request is never recorded as a third-party hold (`Reservation.sol:900-902`, `Reservation.sol:973`). It does not grant the governance-only ability to rotate a `Live` source wallet's anchor, which reads the raw governance flag (`Reservation.sol:828-832`). Authorize exactly the designated addresses.

```bash
: "${RESERVATION_MAINTAINER:?Set RESERVATION_MAINTAINER to the maintainer address being authorized}"

# Read-only: encodes the Council Safe transaction, broadcasts nothing.
cast calldata "setSpvMaintainerStatus(address,bool)" "$RESERVATION_MAINTAINER" true
```

Submit that calldata as a Council Safe transaction to `$BRIDGE_GOVERNANCE`. De-authorize a rotated or retired address with the same call and `false`; de-authorization affects only future submissions and leaves already settled proofs untouched.

**The check.** The Bridge declares no public getter for `isSpvMaintainer`, so verify with the event and with a storage read:

1. The `SpvMaintainerStatusUpdated(address indexed spvMaintainer, bool isTrusted)` event (`Bridge.sol:185-188`) emitted by `Bridge.setSpvMaintainerStatus` in the Safe transaction's receipt.
2. The mapping slot itself. `BridgeState.Storage` sits at Bridge slot 51 and `isSpvMaintainer` is member slot 21 of that struct in `test/fixtures/BridgeState.storageLayout.snapshot.json`, which puts the mapping base at slot 72:

```bash
cast index address "$RESERVATION_MAINTAINER" 72 # per-address slot
cast storage "$BRIDGE" "$(cast index address "$RESERVATION_MAINTAINER" 72)"
# expect 0x00..01 while authorized, 0x00..00 after de-authorization
```

Record the authorized addresses, the Safe transaction hash for each, and the block of the storage read in the governance log.

**Timing.** Authorization activates nothing by itself: reservations settle only once the vault is trusted by Call 6. It must be in place before the first acceptance or re-anchor proof is submitted, so the practical deadline is the activation block, and the recommended slot is right after Stage 3, in parallel with the 48h wait.

### Stage 4 — Launch values are a human decision

No launch value is fixed by this document, and `deploy/98_generate_reservation_mainnet_calldata.ts` deliberately has **no defaults**: every value is a required environment variable, and a missing or malformed one hard-fails rather than silently generating example calldata. Governance must supply and sign off on each of `RESERVATION_PER_WALLET_CAP_SATS`, `RESERVATION_SINGLE_AMOUNT_CAP_SATS`, `RESERVATION_MAX_ACTIVE`, `RESERVATION_MAX_THIRD_PARTY_REANCHOR_HOLDS`, `RESERVATION_HANDOFF_RESERVE_WALLETS`, `RESERVATION_MIN_AMOUNT_SATS`, `RESERVATION_TX_MAX_FEE_SATS`, `RESERVATION_TERM_SECONDS`, `RESERVATION_DISSOLUTION_DELAY_SECONDS`, `RESERVATION_MAX_TOTAL_AMOUNT_SATS`, `RESERVATION_MAX_PER_WALLET`, `RESERVATION_ACTION_TIMEOUT_SECONDS`, `RESERVATION_RENEWAL_WINDOW_SECONDS`.

The script hard-fails on the launch-posture values that are already decided, and on every remaining on-chain `require` it mirrors:

- `RESERVATION_MAX_PER_WALLET` must be exactly 1 (the decided M1 launch value).
- `RESERVATION_MAX_ACTIVE` must not exceed `liveWalletsCount * maxReservationsPerWallet`. A global cap **at or below** that slot capacity is reachable: the global cap binds once that many positions are open. Only a global cap **above** the physical slot capacity is dead configuration — individual wallets saturate first with `Wallet reservations cap exceeded`, so the global ceiling never becomes the binding constraint and the value buys nothing. The script re-checks this relation twice during calldata generation — once with the initial read and once with a fresh `liveWalletsCount` read immediately before emitting the finalize calldata — because up to 48h can pass between the begin calls and the actual finalize execution, and a wallet can retire in that window. That re-check is **not** performed automatically 48h later at execution time: the operator must re-run the script (or otherwise re-read `liveWalletsCount` and re-derive the relation) immediately before finalizing the transactions, and abort if the relation no longer holds.
- `RESERVATION_MAX_ACTIVE` must also not exceed the **hand-off reserve-aware** capacity `max(0, liveWalletsCount - handoffReserveWallets) * maxReservationsPerWallet`. This is the stricter, on-chain relation: `Reservation.reserveAcceptanceCapacity` reverts an acceptance with `Hand-off reserve exceeded` unless the active position count _after_ that acceptance is at most this value, because `handoffReserveWallets` Live wallets must stay free to retire together while every open position still fits on the remaining ones. A cap above it is unreachable — the acceptance reverts instead of the position being opened — so the script hard-fails on it, at calldata generation and again immediately before emitting the finalize calldata. Note that this relation is _stricter_ than the `liveWalletsCount * maxReservationsPerWallet` one above: with the default hand-off reserve of 1, the effective ceiling is one position lower.
- `RESERVATION_DISSOLUTION_DELAY_SECONDS` must be greater than zero and at most 730 days (63,072,000s). The **maximum is now an on-chain bound**: `Reservation.MAX_RESERVATION_DISSOLUTION_DELAY` is 730 days, and both `Reservation.updateReservationParameters` and `BridgeGovernanceParameters.beginReservationParametersUpdate` reject a larger delay with `Reservation dissolution delay out of protocol bounds`. The script mirrors that bound so an operator learns at calldata-generation time instead of up to 48h later, at finalize. The **greater-than-zero rule stays a deploy-script policy, not an on-chain rule**: the chain imposes no minimum on the delay, because a zero delay is a valid governance choice — the position simply becomes strand-eligible as soon as its term expires — but a zero delay makes every position releasable the instant its term expires, so the script refuses it.
- `RESERVATION_TX_MAX_FEE_SATS > 0`, `RESERVATION_MIN_AMOUNT_SATS > RESERVATION_TX_MAX_FEE_SATS`, `0 < RESERVATION_RENEWAL_WINDOW_SECONDS < RESERVATION_TERM_SECONDS`, and `RESERVATION_ACTION_TIMEOUT_SECONDS > REQUEST_TIMEOUT_SAFETY_MARGIN + DEPOSIT_MIN_AGE + 1` (7200 + 7200 + 1 = 14401), each mirroring the corresponding `require` in `Reservation.updateReservationParameters`.
- Decision 1: `RESERVATION_MAX_TOTAL_AMOUNT_SATS <= RESERVATION_MAX_ACTIVE * RESERVATION_SINGLE_AMOUNT_CAP_SATS`.

### Stage 5 — Term and reveal-window feasibility

The term is not free-form. `Reservation.MIN_RESERVATION_TERM` is 90 days (7,776,000s) and `MAX_RESERVATION_TERM` is 730 days (63,072,000s); `updateReservationParameters` reverts with `Reservation term out of protocol bounds` outside that band.

There is a second, tighter constraint, because `Deposit._revealDeposit` bounds a reserved deposit's refund locktime and `Reservation.requestReservationAcceptance` needs the deadline to be at least the reveal time plus the action timeout plus the 24h refund safety margin. `deploy/98_generate_reservation_mainnet_calldata.ts` mirrors this as a feasibility formula rather than a magic number:

```
lowest       = max(depositRevealAheadPeriod + 7200,
                   reservationActionTimeout + 86400 + 7200)
minFeasibleTerm = lowest - 86400 + 3600
```

where `depositRevealAheadPeriod` is read live from `Bridge.depositParameters()` and the constants are `REVEAL_DRIFT_SECONDS = 7200`, `DEPOSIT_REFUND_SAFETY_MARGIN = 86400`, `REVEAL_FEASIBILITY_MARGIN_SECONDS = 3600`. The chosen term must be at least `minFeasibleTerm`, otherwise the reveal window is empty or too thin and every reserved reveal reverts with `Refund locktime too far in the future for a reservation`. The formula is only meaningful while `depositRevealAheadPeriod > 0`; when it is zero the ahead-period check is disabled and the on-chain term bounds alone apply. A 90-day term is **not** a safe default — with a 150-day reveal-ahead period the minimum feasible term is 12,884,400s (149.125 days), so the term must be raised or `depositRevealAheadPeriod` lowered through `deploy/14_set_deposit_parameters.ts` governance.

The deposit-side bound is a live read, not a constant: `depositRevealAheadPeriod` can change between the begin and the finalize, so re-derive the feasible term against the value in force at finalize time.

### Stage 6 — Reserve-target decision (before activation)

See "Fee-Reserve Target Governance Step" below for the full rationale. `ReservationVault.updateFeeReserveTarget(uint256)` is `onlyOwner` and returns nothing — it has no return value, so it is not a `(bool)`-returning call — and the vault's owner is the Council Safe, not an EOA. The calldata is therefore built for a Safe transaction and submitted by the Council Safe; no key, no `cast send` from a deployer, and no direct EOA broadcast:

```bash
# Build the calldata for the Council Safe transaction (read-only: encodes,
# does not broadcast). $FEE_RESERVE_TARGET is in TBTC with 18 decimals.
cast calldata "updateFeeReserveTarget(uint256)" "$FEE_RESERVE_TARGET"
```

Submit that calldata as a **Council Safe transaction** to `ReservationVault` (`updateFeeReserveTarget(uint256)`, selector `0x3f2bac56`); the Safe is the owner, so the transaction must be proposed, approved and executed by the Safe itself. It applies instantly in M1, with no governance delay. Verify the resulting state through the public getter, and the state change through the event:

```bash
cast call "$RESERVATION_VAULT" "feeReserveTarget()(uint256)" # selector 0x5dc5296c
```

The state change is observable as the `FeeReserveTargetUpdated(uint256)` event on the vault. Record the chosen target, or the explicit decision to accept a zero reserve, in the governance log together with the launch values from Stage 4 and the activation block from the client gate.

### Stage 7 — Client-first gate and activation block

See "Client Activation Ordering Gate" below. The client release must be live on every node before the on-chain activation, and the chosen activation block must be at or after that release is live.

### Post-activation verification

```bash
# Router is wired.
cast call "$BRIDGE" "getReservationRouter()(address)"
# Vault is wired and trusted.
cast call "$BRIDGE" "isVaultTrusted(address)(bool)" "$RESERVATION_VAULT"
cast call "$BRIDGE" "reservationParameters()(address,uint64,uint64,uint32,uint32,uint64,uint64,uint32,uint32,uint32)"
# Caps, occupancy and pending-deposit counters.
cast call "$BRIDGE" "reservationCaps()(uint64,uint64,uint32,uint32)"
cast call "$BRIDGE" "reservationHandoffReserveWallets()(uint32)"
cast call "$BRIDGE" "activeReservationsCount()(uint32,uint32)"
cast call "$BRIDGE" "pendingReservedDeposits()(uint64)"
```

Note that the reservation getters are router selectors: before the router is set they revert with `Reservation router not set`, and after it is set they are served by the router's `delegatecall` on the Bridge's own storage.

## Generating the Mainnet Calldata (deploy script 98)

`deploy/98_generate_reservation_mainnet_calldata.ts` builds the governance calldata for the steps above. It has no numeric defaults: every value below is required, and a missing or malformed value stops the script. Run it with:

```sh
DEPLOY_RESERVATION_BOOTSTRAP_CALDATA=true yarn deploy --tags GenerateReservationMainnetCalldata --network mainnet
```

`DEPLOY_RESERVATION_BOOTSTRAP_CALDATA=true` is needed on any network other than `mainnet`; on `hardhat`, `localhost`, `development` and `system_tests` the script skips itself (use script 97 there).

| Env var                                      | `BridgeGovernance` argument                                            | Script check                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RESERVATION_PER_WALLET_CAP_SATS`            | `beginReservationCapsUpdate._newMaxReservationsAmountPerWallet`        |                                                                                                                                                                                      |
| `RESERVATION_SINGLE_AMOUNT_CAP_SATS`         | `beginReservationCapsUpdate._newReservationMaxSingleAmount`            |                                                                                                                                                                                      |
| `RESERVATION_MAX_ACTIVE`                     | `beginReservationCapsUpdate._newMaxActiveReservations`                 | must not exceed `liveWalletsCount * maxReservationsPerWallet`, nor the stricter hand-off reserve-aware `max(0, liveWalletsCount - handoffReserveWallets) * maxReservationsPerWallet` |
| `RESERVATION_MAX_THIRD_PARTY_REANCHOR_HOLDS` | `beginReservationCapsUpdate._newMaxThirdPartyReanchorHoldsPerWallet`   | 0 blocks third-party holds                                                                                                                                                           |
| `RESERVATION_HANDOFF_RESERVE_WALLETS`        | `beginReservationCapsUpdate._newHandoffReserveWallets`                 | must be > 0 (mirrors `updateReservationCaps`'s "Hand-off reserve must be greater than zero" require)                                                                                 |
| `RESERVATION_MIN_AMOUNT_SATS`                | `beginReservationParametersUpdate._newReservationMinAmount`            | must exceed the tx max fee                                                                                                                                                           |
| `RESERVATION_TX_MAX_FEE_SATS`                | `beginReservationParametersUpdate._newReservationTxMaxFee`             | must be > 0                                                                                                                                                                          |
| `RESERVATION_TERM_SECONDS`                   | `beginReservationParametersUpdate._newReservationTermSeconds`          | 90 to 730 days                                                                                                                                                                       |
| `RESERVATION_DISSOLUTION_DELAY_SECONDS`      | `beginReservationParametersUpdate._newReservationDissolutionDelay`     | must be > 0 (deploy-script policy; the chain imposes no minimum) and at most 730 days (on-chain bound: `Reservation.MAX_RESERVATION_DISSOLUTION_DELAY`)                              |
| `RESERVATION_MAX_TOTAL_AMOUNT_SATS`          | `beginReservationParametersUpdate._newReservationMaxTotalAmount`       | Decision 1 invariant                                                                                                                                                                 |
| `RESERVATION_MAX_PER_WALLET`                 | `beginReservationParametersUpdate._newMaxReservationsPerWallet`        | must be 1 (M1 launch value)                                                                                                                                                          |
| `RESERVATION_ACTION_TIMEOUT_SECONDS`         | `beginReservationParametersUpdate._newReservationActionTimeout`        | must exceed `REQUEST_TIMEOUT_SAFETY_MARGIN + DEPOSIT_MIN_AGE + 1` and be at most 730 days (on-chain bound: `Reservation.MAX_RESERVATION_TERM`)                                       |
| `RESERVATION_RENEWAL_WINDOW_SECONDS`         | `beginReservationParametersUpdate._newReservationRenewalWindowSeconds` |                                                                                                                                                                                      |

The vault address is not an env var: the script reads the deployed `ReservationVault` and passes it as `_newReservationVault`.

The script mirrors the on-chain `require` checks of `updateReservationParameters` and `updateReservationCaps`, so a bad value fails here instead of at finalize, 48 hours later. The `Script check` column lists the main ones; the script's error message names the exact rule.

Tooling note: under the repository's Node version, `npx hardhat run` does not call a TypeScript script's `export default` function, and the run still exits 0. A script run that way must call its entry point at top level (see `scripts/reservations-fork-dryrun.ts` on the `reservations-fork-dryrun` branch).

---

## Irreversible Vault Activation Warning

> ⚠️ **IRREVERSIBLE CONFIGURATION WARNING: MANDATORY GOVERNANCE SIGN-OFF**
>
> Once any reservation is accepted, `ReservationVault` can only be swapped, upgraded, or repointed if the bridge reaches `reservationTotalAmount == 0 && pendingReservedDeposits == 0` — under Milestone 1 (variant B), this state is reachable **only** via complete wallet termination / stranding / acceptance timeouts, because voluntary early exits (such as redemptions or dissolutions) are deferred to Milestone 2.
>
> The vault re-point gate in `Bridge.updateReservationParameters` requires, exactly and in this order:
>
> ```solidity
> self.reservationTotalAmount == 0     // "Active reservations exist"
> self.pendingReservedDeposits == 0    // "Pending reserved deposits exist"
> ```
>
> Both conditions must hold. `reservationTotalAmount` is the total satoshi amount locked under open reservation positions; `pendingReservedDeposits` counts revealed reserved deposits that have been neither accepted nor marked stale. The two are cleared by different paths: a pending reserved deposit clears when it is accepted (`consumeAcceptedDeposit`), marked stale by the permissionless `notifyStaleReservedDeposit` after its refund deadline elapses, or force-cleared by governance via `BridgeGovernance.forceStaleReservedDeposit(uint256)`; the locked total clears when the position is stranded (`notifyReservationStranded`) or closed.
>
> Setting a non-zero `reservationVault` in `updateReservationParameters` and accepting the first reservation permanently locks in that vault contract for the entire lifetime of live reservations. Explicit governance and deployer sign-off acknowledging this irreversibility is **required** prior to the activation ceremony. The executable form of that sign-off is the "Pre-flight — Irreversibility sign-off (before Stage 0)" step of the Activation Runbook, which must be complete before any reservation call is submitted.

## WalletProposalValidator Deployment (M1)

M1 ships a **new** `WalletProposalValidator`. The deployed mainnet validator
(`0x30019D85a86ABD3cDA1167F4C052690c32FBDEc2`) predates the reservation
feature: its runtime carries neither the reserved-deposit check nor
`validateReservationAnchorProposal` / `validateReservationReanchorProposal`, so
it cannot validate a reservation proposal at all, and it accepts a deposit sweep
that spends a reserved deposit.

**Deploy it with `scripts/deploy-reservation-validator.ts`, not with
`hardhat deploy --tags WalletProposalValidator`.** The tag path resolves the
`Bridge` dependency and re-runs the deployment graph in front of it; measured on
a mainnet fork at block 26320694 it starts redeploying `Bank`, `LightRelay` and
the bridge libraries, and would finish by deploying a new Bridge proxy with new
storage. The script performs the single `deploy("WalletProposalValidator",
[Bridge])` call of `deploy/39_deploy_wallet_proposal_validator.ts` after a
preflight, archives the previous record as
`deployments/mainnet/WalletProposalValidator.pre-m1.json`, and verifies the
deployed runtime.

### Ordering against the Bridge upgrade

The validator's reserved-deposit rule calls `bridge.isReservedDeposit(key)` for
**every** deposit in a sweep proposal. A pre-reservation Bridge has no such
function, so a client pointed at the M1 validator before the Bridge carries the
reservation implementation fails validation of every sweep proposal - a
protocol-wide deposit-sweep halt, not a reservation-only failure. The deploy
itself is inert (the contract holds no state); what must not precede the Bridge
upgrade is the **client cut-over** to the new address. The script refuses to run
while the Bridge cannot answer `isReservedDeposit`; `PRE_UPGRADE=1` overrides
that for an early, inert deployment.

### How the address reaches the client

The validator address is not governance state: keep-core resolves it from
`pkg/chain/ethereum/tbtc/gen/_address/WalletProposalValidator`, which `make`
fills from `deployments/mainnet/WalletProposalValidator.json` of the published
`@keep-network/tbtc-v2` npm package. The chain is therefore:

1. run `scripts/deploy-reservation-validator.ts` on mainnet,
2. publish the npm package carrying that record,
3. `make` in `pkg/chain/ethereum/tbtc/gen` (`environment=mainnet`) and build the
   release binary,
4. run the gate below against the release's activation block.

A release built before step 2 keeps naming the pre-M1 validator, which is the
one failure mode in which the on-chain reserved-deposit guard is absent while
everything else looks wired.

### Release gate

`scripts/check-reservation-activation-gate.ts` is the executable form of the
validator and activation-block gate. It reads the validator and Bridge addresses
from the deployment records (or `BRIDGE_ADDRESS` / `VALIDATOR_ADDRESS`) and
asserts:

- the validator's **deployed** runtime calls `isReservedDeposit` and exposes both
  reservation proposal entry points. A substring search for
  `"Reserved deposits must not be swept"` is not a valid check: solc emits a
  revert string as one `PUSH32`-and-`MSTORE` per 32-byte word, with the store
  sequence between consecutive words (`7f <32 bytes> 60 44 82 01 52 7f <next>`),
  so the message never appears contiguously and the search reports a correct
  build as missing. The gate therefore looks for the 32-byte words in order, no
  more than 16 bytes apart; a looser rule is satisfied by unrelated literals
  (`"Deposit already swept"` contains `"wept"`);
- the validator's `bridge()` equals the Bridge the release expects, and the
  `isReservedDeposit(0)` probe is made **on that address**, not on the
  deployment record. The reserved-deposit rule calls this Bridge for every
  deposit in a proposal, so a validator built against another Bridge would fail
  every sweep validation;
- `RELEASE_BLOCK < ACTIVATION_BLOCK <= SET_VAULT_STATUS_BLOCK`, with the two
  heights recorded by the "Client Activation Ordering Gate" above.

Both this script and `scripts/deploy-reservation-validator.ts` refuse to run
with a non-empty `HARDHAT_DEPLOY_FIXTURE` (`0` and `false` included): fixture
mode resolves the deployment records to the fixture directory, where a missing
record is not an error.

```bash
CHAIN_API_URL=[MAINNET_RPC] \
  ACTIVATION_BLOCK=[CLIENT_ACTIVATION_BLOCK] \
  RELEASE_BLOCK=[RELEASE_ROLLOUT_BLOCK] \
  SET_VAULT_STATUS_BLOCK=[SET_VAULT_STATUS_BLOCK] \
  npx hardhat run --network mainnet scripts/check-reservation-activation-gate.ts
```

Exit code 0 means every check passed; 1 means a check failed; 2 means an input
was missing or malformed, or an error escaped the script (a deployment-record
lookup, a provider error), in which case no verdict was reached. Run it before Call 6 of the Activation Runbook.

## Client Activation Ordering Gate

On-chain activation (`setVaultStatus(vault, true)`) and client activation (keep-core's reservation task scheduling) are two independent axes that MUST be coupled in this order:

1. **Ship the keep-core release first.** Release and deploy a keep-core binary whose `reservationsActivationBlocks` table contains the chosen entry for the target network (see `keep-core pkg/tbtc/coordination.go`: `ReservationsActivationBlock`). All maintainers, orchestrators, and tBTCpg coordinators on that network must run that release before the on-chain activation block is reached. The entry must be an explicit height for the target network: `ReservationsActivationBlock` returns 0 only for the local developer network, and returns `math.MaxUint64` for every network without an entry, so a release that omits the network's entry never activates reservation coordination there.
2. **Choose the activation block at or after the release is live on every node.** The value written into `reservationsActivationBlocks` for the network is the block height at which clients start proposing acceptance and re-anchor actions. The `setVaultStatus(vault, true)` transaction must execute at or after that block. The block height is a human decision and must be recorded in the governance log alongside the launch values; it is not derivable from the tbtc-v2 side of this release. The release owner records it as part of the pre-flight irreversibility sign-off ("Pre-flight — Irreversibility sign-off (before Stage 0)"), which requires the recorded block to satisfy this ordering.

Executable form of the gate, to be completed before Call 6 of the Activation Runbook:

```bash
# The on-chain activation block must be at or after the client activation block.
# Read the height at which setVaultStatus is mined, and compare it with the
# height recorded in keep-core's reservationsActivationBlocks for the network.
cast block [SET_VAULT_STATUS_TX_HASH] # -> number
```

The check is a comparison against the recorded client activation block, not an on-chain read: the client activation block lives in the keep-core release, not in a contract. Record both heights (the client activation block and the mined `setVaultStatus` block) in the governance log; the pair is the evidence that the ordering gate was honoured.

Consequence of the wrong order (activating on-chain before the released clients are live): the Bridge immediately accepts reserved reveals and acceptance requests, but no keep-core client coordinates acceptance or re-anchor until the network's activation block is reached. keep-core starts coordinating a network only once the chain's block height reaches the activation block configured for that network in `reservationsActivationBlocks` (see `keep-core pkg/tbtc/coordination.go`: `ReservationsActivationBlock`), so the gap has two distinct shapes:

- **(a) Network with a configured activation block:** the wrong order opens a temporary gap - reserved deposits can be revealed and accepted on-chain while no client produces the anchor proof, and the gap lasts only until the configured block, after which coordination starts and the positions settle normally.
- **(b) Network with no entry in `reservationsActivationBlocks`:** `ReservationsActivationBlock` falls through to `math.MaxUint64` and the client never activates reservation coordination for that network. Reserved deposits can still be revealed and acceptance requested on-chain, but no client coordinates anchor signing, so without a separately signed and confirmed anchor transaction an SPV maintainer has no acceptance proof to submit. The normal fallback is that pending acceptances time out and depositors take the Bitcoin refund after the deposit locktime, after which the stale pending-deposit record can be cleared. If the custodying wallet does sign and broadcast an anchor outside client coordination, an SPV maintainer can still prove it while the acceptance is pending or, after timeout, within the late-settlement window (`timeoutAt + termSeconds`).

This gate is runbook discipline; nothing on-chain enforces it.

## Fee Fallback When Vault Trust Is Revoked

Governance can revoke the reveal-time vault's trust at any point, including while acceptance actions are still proof-settleable (pending or after their `timeoutAt`, within the late-settlement window). Once governance executes `setVaultStatus(vault, false)`, every acceptance that settles against that vault while it is untrusted - on time or late - takes a direct-credit fallback: instead of routing the gross anchored amount through `ReservationVault.receiveBalanceIncrease` (which would mint TBTC and retain the initiation fee as in-kind fee reserve), the Bridge credits the depositor directly through `Bank.increaseBalances`. The reservation position is still registered and the anchor is still indexed, but **no initiation fee is charged** and no fee reserve accumulates in the vault for that settlement. The `settleAcceptance` branch checks `isVaultTrusted[vault]` without checking lateness, so the fallback does not discriminate between on-time and late proofs.

Operational consequences:

- Fee revenue accounting must not assume every settled acceptance retains its initiation fee in the vault. Any settlement against a since-untrusted vault - on time or late - produces zero vault-side fee income for that position.
- This is the intended M1 behavior: a confirmed Bitcoin anchor must settle even if the vault lost trust, so the fallback credits the depositor directly rather than reverting the already-confirmed BTC spend. Re-trusting the vault does not retroactively charge the skipped fee.
- Before revoking trust, governance should verify that no pending or timed-out acceptance actions remain on that vault, or accept the fee loss on the settlements that race the revocation.

## Fee-Reserve Target Governance Step

`ReservationVault` deploys with `feeReserveTarget == 0`. Nothing in the activation flow (scripts 95/96/97 or the mainnet calldata script 98) calls `updateFeeReserveTarget`: script 97 performs only the caps update, the parameters update, and `setVaultStatus(vault, true)`. Re-anchor settlement already finances miner fees in kind in milestone 1, so the reserve-target decision cannot wait for a later milestone: a zero reserve target means `sweepFees` may sweep the vault's entire TBTC balance to the recipient, including the TBTC that in-kind fee financing needs: if a re-anchor hop or late fee event consumes more than the vault holds, the shortfall is recorded as `inKindFeeDebtSat` and the system runs over-supplied by that amount until `repayInKindFeeDebt` or a later `sweepFees` burns it back down. This does not block any milestone-1 settlement, but the fee debt must be consciously owned.

Explicit governance step, to be completed before on-chain activation (`setVaultStatus(vault, true)`), i.e. before the first M1 re-anchor settlement can land in kind. See "Stage 6 — Reserve-target decision" in the Activation Runbook for the executable form.

1. Choose the target: a TBTC amount (18 decimals) large enough to cover the expected in-kind miner-fee pipeline, or deliberately accept a zero reserve. The target is a TBTC amount, not a satoshi amount; the vault's own accounting is satoshi-granular (`inKindFeeDebtSat`), so a target that is not a whole number of satoshis leaves a sub-satoshi remainder the vault cannot hold exactly.
2. Execute `ReservationVault.updateFeeReserveTarget(target)` via the Council Safe. The call is `onlyOwner`-gated, and the vault owner is the Council Safe (`deploy/96_transfer_reservation_vault_ownership.ts` transfers `ReservationVault` ownership from the deployer to the `governance` named account). It applies instantly in M1 — there is no governance delay on this setter — so it can be executed as a standalone Safe transaction.
3. Verify: call the public getter `ReservationVault.feeReserveTarget()` (selector `0x5dc5296c`) and confirm it returns the chosen value; the state change is also observable as a `FeeReserveTargetUpdated(uint256)` event on the vault.
4. Record the decision in the governance log, together with the launch values and the activation block. The record must state the chosen target, or the explicit decision to accept a zero reserve, and must be reproducible from the vault getter at a stated block.

If a zero reserve is accepted, note that in-kind fee debt is expected to be repaid opportunistically and is a known, publicly visible (`inKindFeeDebtSat`) accounting item. Note also that `feeReserveTarget` bounds only what `sweepFees` may remove: it is not a floor protecting debt repayment, because `sweepFees` repays outstanding in-kind debt from the vault's full balance first, including the part the target would otherwise keep.

---

## Occupancy Lifecycle and Capacity Management (maxActiveReservations)

In Milestone 1, `maxActiveReservations` acts as an occupancy launch gate and capacity ceiling:

- **Occupancy lifecycle and release paths in M1:** Once reservation requests are authorized on-chain, `activeReservationsCount` increments (`reserveAcceptanceCapacity`, at request time — not at proof time). Voluntary protocol-level exits from an accepted reservation position (such as dissolution, veto, and dedicated reservation redemptions) are deferred to Milestone 2, and `closeReservation` has no reachable caller in M1. The global counter is nevertheless decremented on the two release paths that exist in M1: (a) acceptance timeout — `notifyReservationAcceptanceTimedOut(uint256)` releases the capacity reserved at request time, including the global `activeReservationsCount`, when an acceptance authorization expires; and (b) stranding — `notifyReservationStranded(uint256)` releases the position's capacity entirely. A third path, the re-anchor action timeout (`notifyReservationActionTimeout(uint256)`), releases only the _target_ wallet's reserved capacity and returns the position to `Active`; it does **not** touch `activeReservationsCount` or `reservationTotalAmount`, because the position stays custodied at the source wallet. Capacity release is therefore not strictly monotonic, and not all of it is depositor-initiated. Occupancy is not derivable from a single field or event: the `ReservationOccupancyChanged` event alone reports only the raw `activeReservationsCount` counter, not effective occupancy. Deriving effective occupancy from current on-chain views requires combining `IReservationBridge.activeReservationsCount()` with `reservationParameters()` (for `maxReservationsPerWallet`) and the live-wallet count. This yields two distinct quantities that should not be conflated: aggregate wallet-slot utilization (`activeReservationsCount` against `liveWalletsCount * maxReservationsPerWallet`) and governance-cap utilization (`activeReservationsCount` against the global `maxActiveReservations` ceiling).
- **Permissionless stranding of eligible positions (including on Live wallets):** `notifyReservationStranded(uint256)` is permissionless and router-reachable, and it does **not** require the custodying wallet to have closed or terminated. It accepts a position whose custodying wallet is:

  - `Terminated` or `Closed` — no further condition;
  - `Live` — once `block.timestamp >= reservation.dissolutionEligibleAt` (the position's term plus its dissolution delay). Milestone 1 has no other release path for such a position (`closeReservation` has no caller), so without this branch an expired position would pin its wallet's and the global capacity forever; only governance can re-anchor from a Live wallet, so no owner action is protected by withholding the strand;
  - `Closing` — once `block.timestamp >= reservation.dissolutionEligibleAt` **and** `block.timestamp >= wallet.closingStartedAt + walletClosingPeriod`. The closing period is an exclusive re-anchor window, because `requestReservationReanchor` accepts a `Closing` source wallet; without it, a wallet pushed `Live -> MovingFunds -> Closing` by permissionless calls could be stranded in the same transaction, before the owner could request a re-anchor.

  In every branch the position must still be `Active`, and whichever of a re-anchor and a strand lands first flips the state and makes the other revert. A stranded position's owner keeps the ordinary pooled Bank claim for the already-minted amount; the `ReservationStranded` event is the canonical recovery evidence. The consequence for capacity management: an occupancy ceiling can free up without any depositor action and without the wallet retiring, so operators must not treat a non-zero `activeReservationsCount` as evidence that a wallet is still holding a live anchor, and must not treat a decreasing counter as evidence of a voluntary exit.

- **Underlying tBTC funds are not locked:** This occupancy accounting applies only to the position of the dedicated-UTXO reservation. Depositor funds are not locked: upon `settleAcceptance`, the depositor is already credited liquid tBTC via the standard Bridge/vault deposit-crediting (mint) path (this mint/credit flow is completely unrelated to the distinct `redeemReservation` feature, which is disabled in Milestone 1). Only the dedicated-UTXO reservation position itself lacks an early voluntary close mechanism in M1.
- **Wallet-closing gate dependency:** The safety story for `maxActiveReservations` relies on wallets not being able to retire while they still hold live reservation anchors. Two different counters play different roles here. `moveFunds`'s routing decision uses `walletAnchoredInfo[wallet].count == 0` — the number of **proven** reservation anchors — not the reserved-count field: a wallet with no main UTXO and no proven anchors begins closing immediately, while a wallet that still custodies proven anchors is routed through `MovingFunds` so that `WalletMovingFunds` is emitted to trigger re-anchoring of the remaining reservations. Capacity reserved for a pending acceptance or re-anchor target deliberately does not count there, because no Bitcoin proof backs it. The stricter `walletReservationInfo[wallet].count == 0` precondition (which also covers reserved pending-action capacity) is enforced at `notifyWalletClosingPeriodElapsed`, i.e. at the `Closing -> Closed` step. It is deliberately _absent_ from `beginWalletClosing` and `finalizeWalletClosing`: both are reached only after a moving-funds Bitcoin transaction has already been proven on-chain via SPV proof, and blocking wallet retirement at that point (with funds already gone) would leave the wallet stuck mid-closing while its `movingFundsTimeout` clock keeps running, eventually triggering operator slashing for a state the protocol itself created. A wallet can therefore complete closing while still holding a live reservation anchor if reservations were requested against it after the `moveFunds` decision was made; the anchor itself is separately recovered via `notifyReservationStranded` once the wallet reaches `Terminated`/`Closed`, or once a `Closing` wallet passes both its closing period and the position's `dissolutionEligibleAt`.
- **Procedure for raising capacity:** When active occupancy saturates or additional headroom is required, governance can raise the occupancy limit by calling `updateReservationCaps(maxReservationsAmountPerWallet, reservationMaxSingleAmount, newMaxActiveReservations, maxThirdPartyReanchorHoldsPerWallet, handoffReserveWallets)` with a higher `newMaxActiveReservations` value and the current value of every other cap.
- **Sizing constraint:** Any update to `maxActiveReservations` or `reservationMaxSingleAmount` must maintain the Decision 1 relational invariant:
  `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount`
  (unless `reservationMaxSingleAmount == 0`, which disables the amount cap). If lowering caps or raising `reservationMaxTotalAmount`, governance must ensure the new slot capacity accommodates `reservationMaxTotalAmount`.
- **Operational timeline considerations:** Whether the Milestone 1 launch is expected to reach reservation term expiry before Milestone 2 ships is an open operational question that the deploying team and governance should confirm prior to setting initial term lengths and occupancy limits.

### Emergency Step: Free Target Slots Run Low

Privileged hand-offs from `MovingFunds` or `Closing` do not need ordinary target headroom. Raise `maxReservationsPerWallet` or `maxReservationsAmountPerWallet` only when governance wants more ordinary admission, third-party target headroom or Live-source rotation capacity. `maxReservationsPerWallet` uses the delayed reservation-parameters update. `maxReservationsAmountPerWallet` uses the delayed caps update and must include the current hand-off reserve. Raising the per-wallet count increases the reserve-gated admission budget; it does not override `maxActiveReservations` or change existing pending actions.

### Monitoring and Alerting (Occupancy & Risk Signals)

To ensure proactive capacity management and safe operational oversight:

- **Occupancy Signal & Calculation:** Effective system occupancy is defined as:
  $$\text{Occupancy} = \frac{\text{activeReservationsCount}}{\text{liveWalletsCount} \times \text{maxReservationsPerWallet}}$$
  Relative to the governance cap, occupancy is evaluated against `maxActiveReservations` (the slot capacity floor).
- **Event-Driven Telemetry:** The `ReservationOccupancyChanged(uint32 activeReservationsCount)` event enables off-chain indexers, subgraphs, and dashboards to track occupancy from logs alone without relying on continuous chain polling of `activeReservationsCount()`.
- **Recommended Alert Thresholds:**
  - **Warning Alert (70% of capacity):** Triggered when `activeReservationsCount` reaches 70% of `maxActiveReservations` (or 70% of the live-wallet slot floor). Governance and operators should review current demand and prepare a cap increase transaction if needed.
  - **Critical / Page Alert (90% of capacity):** Triggered when `activeReservationsCount` reaches 90% of capacity. Immediate operator attention is required; new reservation acceptances will revert if the cap is reached before governance raises `maxActiveReservations`.
- **Occupancy-Count Divergence During Pending Re-Anchors:** During any pending re-anchor (between `requestReservationReanchor` and its completion via proof or timeout), `activeReservationsCount` (global) and each wallet's per-wallet reservation count in `ReservationRouter.sol` can disagree, since re-anchor only moves the target wallet's per-wallet count and never touches the global count. At the launch value `maxReservationsPerWallet=1`, this means the occupancy-alert formula above (built on `activeReservationsCount`) can under-report true per-wallet slot pressure that a keep-core free-slot monitor tracking per-wallet counts would otherwise see; operators should not rely on `activeReservationsCount` alone to infer per-wallet slot availability during active re-anchor windows.

### Permissionless Re-Anchor Target Selection (Accepted Risk)

When a source wallet enters `MovingFunds` or `Closing`, calling `requestReservationReanchor` is permissionless and allows the caller to designate any Live wallet as the target wallet:

- **Mechanics:** Target-side capacity (`walletReservationInfo[target].count` and `walletReservationInfo[target].amount`) is reserved immediately at request time, before the source wallet signs or executes the Bitcoin transaction.
- **Risk Profile:** A malicious or griefing caller can temporarily occupy reservation slots on a chosen Live target wallet for up to `reservationActionTimeout` seconds at zero cost beyond gas, preventing other incoming reservations from targeting that wallet during the timeout window.
- **Accepted Risk Rationale:** Capacity occupation via `requestReservationReanchor` requires no signature at all — it is a permissionless bookkeeping call; only _completion_ (the actual Bitcoin re-anchor transaction) requires the source wallet's cooperation to sign. The risk is bounded only by `reservationActionTimeout` (after which unclaimed capacity is released via `notifyReservationActionTimeout`), not by any signature requirement on occupation itself. Because occupation is signature-free, a permissionless caller can pipeline multiple `requestReservationReanchor` calls for different reservations from different already-`MovingFunds`/`Closing` source wallets against the same Live target wallet within a single block, occupying that target wallet's capacity for a full `reservationActionTimeout` at gas-only cost. This aggregate burst risk is accepted per the review and does not require a code fix in this PR.
- **Monitoring Note:** Off-chain monitors should track repeated re-anchor requests against specific target wallets that are not followed by re-anchor proof submissions, alerting operators to potential griefing patterns.

---

## ABI Coordination

`updateReservationCaps` signature change:

```solidity
// #1094
function updateReservationCaps(
  uint64 maxReservationsAmountPerWallet,
  uint64 reservationMaxSingleAmount
) external;

// Milestone 1 (this PR)
function updateReservationCaps(
  uint64 maxReservationsAmountPerWallet,
  uint64 reservationMaxSingleAmount,
  uint32 maxActiveReservations
) external;

// Milestone 1, third-party re-anchor hold cap
function updateReservationCaps(
  uint64 maxReservationsAmountPerWallet,
  uint64 reservationMaxSingleAmount,
  uint32 maxActiveReservations,
  uint32 maxThirdPartyReanchorHoldsPerWallet
) external;

// Milestone 1, hand-off reserve
function updateReservationCaps(
  uint64 maxReservationsAmountPerWallet,
  uint64 reservationMaxSingleAmount,
  uint32 maxActiveReservations,
  uint32 maxThirdPartyReanchorHoldsPerWallet,
  uint32 handoffReserveWallets
) external;
```

`ReservationCapsUpdated` event signature change:

```solidity
// #1094
event ReservationCapsUpdated(
  uint64 maxReservationsAmountPerWallet,
  uint64 reservationMaxSingleAmount
);

// Milestone 1 (this PR)
event ReservationCapsUpdated(
  uint64 maxReservationsAmountPerWallet,
  uint64 reservationMaxSingleAmount,
  uint32 maxActiveReservations
);

// Milestone 1, third-party re-anchor hold cap
event ReservationCapsUpdated(
  uint64 maxReservationsAmountPerWallet,
  uint64 reservationMaxSingleAmount,
  uint32 maxActiveReservations,
  uint32 maxThirdPartyReanchorHoldsPerWallet
);

// Milestone 1, hand-off reserve
event ReservationCapsUpdated(
  uint64 maxReservationsAmountPerWallet,
  uint64 reservationMaxSingleAmount,
  uint32 maxActiveReservations,
  uint32 maxThirdPartyReanchorHoldsPerWallet,
  uint32 handoffReserveWallets
);
```

`ReservationReanchored` event signature change (ReservationRouter):

```solidity
// #1094
event ReservationReanchored(
  uint256 indexed reservationKey,
  uint64 requestNonce,
  bytes20 indexed newWalletPubKeyHash,
  bytes32 newAnchorTxHash,
  uint64 newAnchorAmount
);

// Milestone 1 (this PR)
event ReservationReanchored(
  uint256 indexed reservationKey,
  uint64 requestNonce,
  bytes20 indexed newWalletPubKeyHash,
  bytes32 newAnchorTxHash,
  uint64 newAnchorAmount,
  uint64 minerFee
);
```

Off-chain tooling updates required:

- Governance proposal builders must use the five-argument `updateReservationCaps` and `beginReservationCapsUpdate` signatures.
- Indexers and dashboards must decode five fields in `ReservationCapsUpdated` and six fields in `ReservationReanchored`. Each signature has a different topic0 from earlier versions. Update event filters as well as positional decoders.
- Monitoring alerts and circuit breakers keyed on `ReservationCapsUpdated` or `ReservationReanchored` — confirm the alerts still fire on the new signatures.

The five-argument `updateReservationCaps` selector is `0x78d76eda`. The old four-argument selector is not supported. `reservationCaps()` remains a four-value view; read `reservationHandoffReserveWallets()` separately. Rebuild clients and governance calldata against the new interface.

### m1 router ABI delta vs. inventory/router.md

The `ReservationRouter` entry points that keep-core binds against have diverged from the frozen inventory keep-core#4274 was coded from. This is an intentional, already-decided divergence: keep-core will be updated via a separate follow-up (already filed). **Do not revert these selectors.**

**Reshaped entry points (keep-core#4274 needs an update before mainnet activation):**

- `submitReservationProof(...)` no longer exists at the Bridge address. It has been split into two typed entry points:
  - `submitReservationAcceptanceProof(...)` — handles acceptance proofs.
  - `submitReservationReanchorProof(...)` — handles re-anchor proofs.
- `notifyReservationActionTimeout(...)` lost its `walletMembersIDs` argument. Old signature: `notifyReservationActionTimeout(uint256 reservationKey, uint32[] walletMembersIDs)`; new signature: `notifyReservationActionTimeout(uint256 reservationKey)`.

keep-core#4274 must be updated to call the new selectors above before mainnet activation.

**Additive entry points (non-breaking, but undocumented in any spec/inventory):**

- `forceStaleReservedDeposit(...)` — new, `onlyGovernance`-gated, in `ReservationRouter.sol`. Additive; does not break any existing binding.
- `notifyReservationAcceptanceTimedOut(...)` — keep-core-facing entry point not present in prior spec/inventory documents. Additive; does not break any existing binding.

**Reshaped return type (keep-core#4274 needs an update before mainnet activation):**

`reservationActions()`'s returned `ReservationAction` tuple has diverged from keep-core#4274's frozen 17-field Go binding. Current tbtc-v2 shape (authoritative: `solidity/test/fixtures/ReservationAbi.snapshot.json`, `structs.ReservationAction`, extracted directly from the compiled ABI's tuple components — not hand-counted):

```
targetWalletPubKeyHash bytes20, requestedAt uint32, timeoutAt uint32, txMaxFee uint64,
actionType uint8, state uint8, feePaid bool, redeemer address,
actionDataHash bytes32, sourceAnchorUtxoHash bytes32, amount uint64, usedRetryCredit bool,
watchtowerDefaultDelay uint32, watchtowerLevelOneDelay uint32, watchtowerLevelTwoDelay uint32,
retryCreditSourceNonce uint64, isPartial bool, termSeconds uint32, dissolutionDelay uint32,
minAmount uint64
```

20 fields vs. keep-core#4274's 17: `actionDataHash`/`sourceAnchorUtxoHash` (bytes32) are inserted immediately after `redeemer` — ahead of `amount`, not after — and `termSeconds`, `dissolutionDelay`, `minAmount` are appended. From field 9 onward, every position's type diverges from keep-core's expectation. This is not cosmetic: keep-core#4274's maintainer loop calls `GetReservationAction(reservationKey, requestNonce)` (ABI-decoding this exact tuple) before every proof submission, on both the acceptance and reanchor paths — a tuple-arity mismatch at decode time fails that call outright. keep-core#4274 must regenerate its bindings against this final, stabilized shape (not an intermediate snapshot — the shape has moved multiple times during this epic's development) before mainnet activation.

---

## Tracked Follow-up: Quantify External-Router Alternative Bytecode Delta

The PR design rationale rejects a "genuinely external router with its own storage/authority interface" alternative (where the Bridge delegates or calls out to an external contract with its own authority) based on a qualitative argument: "more new Bridge bytecode than the refactor removes" (due to needing a wide set of privileged Bridge mutator callbacks).

Unlike the other two rejected alternatives (the naive port at 26,529B and the optimizer-only override), this alternative was not empirically measured with hard bytecode numbers in the PR body. With the Bridge currently at ~22,870B / 24,576B (leaving limited bytecode margin), the router-fallback design commits most remaining budget based on this qualitative claim.

**Tracked milestone-2 debt (non-blocking for milestone 1):**
Before milestone 2 ships, a short technical spike should be conducted to empirically quantify the bytecode delta of the callback-authority/external-router alternative. This will apply the same empirical rigor used for the other two architectural comparisons and validate whether the delegatecall-router pattern remains the optimal long-term seam as more reservation lifecycle features (dissolution, veto, dedicated redemptions) are added in milestone 2.

## Storage Layout and Tracked Follow-ups

- **BridgeState Storage Slot 33 Packing:** In `BridgeState.sol`, storage slot 33 packs five fields — `maxReservationsAmountPerWallet` (uint64, 8 bytes), `reservationMaxSingleAmount` (uint64, 8 bytes), `pendingReservedDeposits` (uint64, 8 bytes), `activeReservationsCount` (uint32, 4 bytes), and `maxActiveReservations` (uint32, 4 bytes) — for exactly 32 bytes with zero spare bytes, per the current storage-layout snapshot (`solidity/test/fixtures/BridgeState.storageLayout.snapshot.json`). `reservationDissolutionTxMaxFee` has since been removed from `BridgeState.sol` entirely, and the storage layout was regenerated accordingly; the previously tracked field-reordering follow-up is now moot, since this slot is already fully packed.

---

## Verification

After applying the upgrade on a live network:

```solidity
// Spot-check the Decision 1 invariant via three views on the bridge.
// reservationParameters() returns a 10-value tuple; the 1st value is reservationVault, the 6th is reservationMaxTotalAmount.
(address reservationVault, , , , , uint64 reservationMaxTotalAmount, , , , ) =
    IReservationBridge(bridgeAddress).reservationParameters();
(, uint64 reservationMaxSingleAmount, , ) =
    IReservationBridge(bridgeAddress).reservationCaps();
(, uint32 maxActiveReservations) =
    IReservationBridge(bridgeAddress).activeReservationsCount();

// Pre-activation sanity checks (run before/alongside setting a non-zero reservationVault):
address router = IReservationBridge(bridgeAddress).reservationRouter();
require(router != address(0) && router == expectedRouterAddress, "Router mismatch");
require(reservationVault != address(0), "Vault not set");
require(Ownable(reservationVault).owner() == expectedVaultOwner, "Vault ownership mismatch");
require(Bridge(bridgeAddress).isVaultTrusted(reservationVault), "Vault not trusted");
```

All of the reservation getters above (`reservationParameters`, `reservationCaps`, `activeReservationsCount`, `reservationRouter`) are router selectors: they are served at the Bridge address through the Bridge's `delegatecall` fallback and revert with `Reservation router not set` while the router is unset. `isVaultTrusted` and `getReservationRouter` are declared on the Bridge itself.

The three views together supply the three quantities the Decision 1 invariant is written in terms of:
`reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` — **conditional**: the check is skipped when `reservationMaxSingleAmount == 0` or `maxActiveReservations == 0`, because a zero operand means that cap is disabled and there is no ceiling to violate. The same short-circuit applies on-chain, in `Reservation.validateReservationCapsInvariant`, and the `updateReservationCaps` mirror evaluates it against the _stored_ `reservationMaxTotalAmount`.

> **Precondition note:** Setting a new non-zero `reservationVault` in `updateReservationParameters` also requires `maxActiveReservations > 0`; the call reverts otherwise, so the Decision 1 invariant check above is not sufficient on its own when activating the vault for the first time.

### Governance record checklist

The activation is not complete until the governance log contains, at minimum:

- The `BridgeGovernance` address used, its owner (the Council Safe), and its `governanceDelays(0)` value at activation time.
- The Bridge governance handoff: the `beginBridgeGovernanceTransfer` / `finalizeBridgeGovernanceTransfer` transaction hashes and the 48h window between them, or a note that the Bridge's governance already pointed at that `BridgeGovernance`.
- The reservation router address and the on-chain code check that confirmed it is a contract at a non-zero address.
- The five staged values (per-wallet cap, single-amount cap, `maxActiveReservations`, `maxThirdPartyReanchorHoldsPerWallet`, `handoffReserveWallets`) and the nine staged parameters, each with the environment-variable name it was generated from.
- The Decision 1 arithmetic as evaluated: `reservationMaxTotalAmount` against `maxActiveReservations * reservationMaxSingleAmount`.
- The `liveWalletsCount * maxReservationsPerWallet` slot-capacity check, with the block at which `liveWalletsCount` was read.
- The chosen term, the `depositRevealAheadPeriod` in force at finalize time, and the derived `minFeasibleTerm`.
- The reserve target: the chosen value (or the explicit decision to accept zero), verified against `feeReserveTarget()` at a stated block.
- The client activation block and the mined `setVaultStatus` block, proving the ordering gate was honoured.
- The Threshold Council's written acknowledgement of the irreversibility of the vault choice, recorded before Stage 0 and naming the `RESERVATION_VAULT` address it covers, together with the client activation block the release owner recorded in that same entry.
- The SPV maintainer addresses authorized for reservation proof submission, each with its Council Safe transaction hash and the block of the `isSpvMaintainer` storage read that confirmed it.

Because setter transactions revert on an invariant violation, a rejected configuration modifies no storage. If governance encounters a revert with `Amount cap exceeds slot capacity` during configuration, the remedy is:

1. Re-issue `updateReservationParameters` with a smaller `reservationMaxTotalAmount` that satisfies `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount`; or
2. Re-issue `updateReservationCaps` with the caps in the correct order (or with higher `maxActiveReservations` / `reservationMaxSingleAmount` values that accommodate the desired total amount).
