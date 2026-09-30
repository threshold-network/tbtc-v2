# Reservation Caps Deployment Instructions for All Actors

## Overview

The milestone-1 reservation subsystem introduces two governance setters with a deploy-ordering dependency and a third ABI/event argument relative to the #1094 specification. This document covers the new coordination requirements.

Changes relative to #1094:

- `updateReservationCaps` now takes a third argument `maxActiveReservations` (uint32, must be > 0). The 4-byte selector changes; existing Defender / Safe / Tenderly / multisend scripts that encode the 2-argument version will revert.
- The `ReservationCapsUpdated` event gained a third field `maxActiveReservations`. Off-chain indexers and dashboards that decode the 2-field version will need to update their event ABI; consumers that only read a subset of fields and ignore unknown trailing fields may only need a rebind/restart.
- `updateReservationParameters` enforces the Decision 1 on-chain relational check `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` by reading both `self.maxActiveReservations` and `self.reservationMaxSingleAmount` from storage. In the pristine pre-launch bootstrap state, both are zero, so the check short-circuits and any `reservationMaxTotalAmount` is accepted. Subsequent calls can revert with `Amount cap exceeds slot capacity` if governance sets `reservationMaxTotalAmount` first and the later `updateReservationCaps` operands cannot accommodate it.

---

## Deploy Order (Decision 1)

During the initial bootstrap of the reservation subsystem, calling `updateReservationCaps` **before** `updateReservationParameters` is recommended as the safe runbook default.

While calling `updateReservationParameters` first is accepted during initial bootstrap because `self.reservationMaxSingleAmount` and `self.maxActiveReservations` are still zero (the slot-capacity check `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` short-circuits when either operand is zero), calling in the reverse order introduces a potential hazard: if the subsequent `updateReservationCaps` call sets caps whose product `maxActiveReservations * reservationMaxSingleAmount` cannot accommodate the already-committed `reservationMaxTotalAmount`, that subsequent `updateReservationCaps` call will revert with `Amount cap exceeds slot capacity`. (Any call order succeeds if `reservationMaxSingleAmount` is set to zero, since a zero single-amount cap disables the relational check).

Safe operational sequence:

1. Call `updateReservationCaps(maxReservationsAmountPerWallet, reservationMaxSingleAmount, maxActiveReservations)` — sets the per-wallet amount cap, the single-reservation amount cap, and the global occupancy cap together. The Decision 1 check evaluates `0 <= maxActiveReservations * reservationMaxSingleAmount` (trivially true because `reservationMaxTotalAmount` is still 0).
2. Call `updateReservationParameters(reservationVault, ...)` — sets `reservationMaxTotalAmount` and the other parameters. The Decision 1 check now evaluates `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` against the just-set storage values.

If the two updates must land in the same block, an atomic multicall preserves the ordering guarantee.

The existing regression test `Bridge.ReservationCaps.test.ts` in the `describe("bootstrap ordering")` group pins both the deploy-ordering hazard and the safe operational order; review it before any deployment.

---

## Irreversible Vault Activation Warning

> ⚠️ **IRREVERSIBLE CONFIGURATION WARNING: MANDATORY GOVERNANCE SIGN-OFF**
>
> Once any reservation is accepted, `ReservationVault` can only be swapped, upgraded, or repointed if the bridge reaches `reservationTotalAmount == 0 && pendingReservedDeposits == 0` — under Milestone 1 (variant B), this state is reachable **only** via complete wallet termination / stranding / acceptance timeouts, because voluntary early exits (such as redemptions or dissolutions) are deferred to Milestone 2.
>
> The vault re-point gate in `Bridge.updateReservationParameters` requires:
>
> ```solidity
> self.reservationTotalAmount == 0 && self.pendingReservedDeposits == 0
> ```
>
> Setting a non-zero `reservationVault` in `updateReservationParameters` and accepting the first reservation permanently locks in that vault contract for the entire lifetime of live reservations. Explicit governance and deployer sign-off acknowledging this irreversibility is **required** prior to the activation ceremony.

## Client Activation Ordering Gate

On-chain activation (`setVaultStatus(vault, true)`) and client activation (keep-core's reservation task scheduling) are two independent axes that MUST be coupled in this order:

1. **Ship the keep-core release first.** Release and deploy a keep-core binary whose `reservationsActivationBlocks` table contains the chosen entry for the target network (see `keep-core pkg/tbtc/coordination.go`: `ReservationsActivationBlock`). All maintainers, orchestrators, and tBTCpg coordinators on that network must run that release before the on-chain activation block is reached.
2. **Choose the activation block at or after the release is live on every node.** The value written into `reservationsActivationBlocks` for the network is the block height at which clients start proposing acceptance and re-anchor actions. The `setVaultStatus(vault, true)` transaction must execute at or after that block.
3. **Seed the term table first.** `setVaultStatus(vault, true)` must also execute after the last `finalizeReservationTermUpdate` of the initial entries (see the term-table notes in this guide and the action ordering in `deploy/98`): a reserved reveal reverts while the table is empty, and the first entry must be at least the reveal-ahead period minus 24 hours.

Consequence of the wrong order (activating on-chain before the released clients are live): the Bridge immediately accepts reserved reveals and acceptance requests, but no keep-core client coordinates acceptance or re-anchor until the network's activation block is reached. keep-core starts coordinating a network only once the chain's block height reaches the activation block configured for that network in `reservationsActivationBlocks` (see `keep-core pkg/tbtc/coordination.go`: `ReservationsActivationBlock`), so the gap has two distinct shapes:

- **(a) Network with a configured activation block:** the wrong order opens a temporary gap - reserved deposits can be revealed and accepted on-chain while no client produces the anchor proof, and the gap lasts only until the configured block, after which coordination starts and the positions settle normally.
- **(b) Network with no entry in `reservationsActivationBlocks`:** `ReservationsActivationBlock` falls through to `math.MaxUint64` and the client never activates reservation coordination for that network. Reserved deposits can still be revealed and acceptance requested on-chain, but no client coordinates anchor signing, so without a separately signed and confirmed anchor transaction an SPV maintainer has no acceptance proof to submit. The normal fallback is that pending acceptances time out and depositors take the Bitcoin refund after the deposit locktime, after which the stale pending-deposit record can be cleared. If the custodying wallet does sign and broadcast an anchor outside client coordination, an SPV maintainer can still prove it while the acceptance is pending or, after timeout, within the late-settlement window (`timeoutAt` plus the largest reservation term entry ever added).

This gate is runbook discipline; nothing on-chain enforces it.

## Fee Fallback When Vault Trust Is Revoked

Governance can revoke the reveal-time vault's trust at any point, including while acceptance actions are still proof-settleable (pending or after their `timeoutAt`, within the late-settlement window). Once governance executes `setVaultStatus(vault, false)`, every acceptance that settles against that vault while it is untrusted - on time or late - takes a direct-credit fallback: instead of crediting the vault's Bank balance and calling `ReservationVault.creditReservation` (which would mint TBTC and retain the acceptance fee, the mint fee plus, unless the position was stranded at settlement, the term's custody fee, as in-kind fee reserve), the Bridge credits the depositor directly through `Bank.increaseBalances`. The reservation position is still registered and the anchor is still indexed, but **no acceptance fee is charged** and no fee reserve accumulates in the vault for that settlement. The `settleAcceptance` branch checks `isVaultTrusted[vault]` without checking lateness, so the fallback does not discriminate between on-time and late proofs.

Operational consequences:

- Fee revenue accounting must not assume every settled acceptance retains its acceptance fee in the vault. Any settlement against a since-untrusted vault - on time or late - produces zero vault-side fee income for that position.
- This is the intended M1 behavior: a confirmed Bitcoin anchor must settle even if the vault lost trust, so the fallback credits the depositor directly rather than reverting the already-confirmed BTC spend. Re-trusting the vault does not retroactively charge the skipped fee.
- Before revoking trust, governance should verify that no pending or timed-out acceptance actions remain on that vault, or accept the fee loss on the settlements that race the revocation.

## Fee-Reserve Target Governance Step

`ReservationVault` deploys with `feeReserveTarget == 0`. Nothing in the activation flow (scripts 95/96/97 or the mainnet calldata script 98) calls `updateFeeReserveTarget`: script 97 performs the caps update, the parameters update, `setVaultStatus(vault, true)` and the reservation term-table seeding, and calls `updateFeeReserveTarget` at none of its four steps. Re-anchor settlement already finances miner fees in kind in milestone 1, so the reserve-target decision cannot wait for a later milestone: a zero reserve target means `sweepFees` may sweep the vault's entire TBTC balance to the recipient, including the TBTC that in-kind fee financing needs: if a re-anchor hop or late fee event consumes more than the vault holds, the shortfall is recorded as `inKindFeeDebtSat` and the system runs over-supplied by that amount until `repayInKindFeeDebt` or a later `sweepFees` burns it back down. This does not block any milestone-1 settlement, but the fee debt must be consciously owned.

Explicit governance step to add to the activation runbook, to be completed before on-chain activation (`setVaultStatus(vault, true)`), i.e. before the first M1 re-anchor settlement can land in kind:

1. Choose the target: a TBTC amount (18 decimals) large enough to cover the expected in-kind miner-fee pipeline, or deliberately accept a zero reserve.
2. Execute `ReservationVault.updateFeeReserveTarget(target)` via the Council Safe (`onlyOwner`-gated; the vault owner is governance).
3. Verify: call the public getter `ReservationVault.feeReserveTarget()` and confirm it returns the chosen value; the state change is also observable as a `FeeReserveTargetUpdated` event.

Record the decision in the governance log. If a zero reserve is accepted, note that in-kind fee debt is expected to be repaid opportunistically and is a known, publicly visible (`inKindFeeDebtSat`) accounting item.

---

## Occupancy Lifecycle and Capacity Management (maxActiveReservations)

In Milestone 1, `maxActiveReservations` acts as an occupancy launch gate and capacity ceiling:

- **Occupancy lifecycle and release paths in M1:** Once reservation requests are authorized and accepted on-chain, `activeReservationsCount` increments. Voluntary protocol-level exits from an accepted reservation position (such as dissolution, veto, and dedicated reservation redemptions) are deferred to Milestone 2. However, `activeReservationsCount` is decremented on the two variant-B release paths that exist in M1: acceptance timeout (when acceptance proofs expire) and stranding (when a wallet closes or terminates). Thus, while not a strictly monotonic one-way ratchet, capacity releases occur exclusively through non-voluntary timeout/stranding paths rather than depositor-initiated exits. Occupancy is not derivable from a single field or event: the `ReservationOccupancyChanged` event alone reports only the raw `activeReservationsCount` counter, not effective occupancy. Deriving effective occupancy from current on-chain views requires combining `IReservationBridge.activeReservationsCount()` with `reservationParameters()` (for `maxReservationsPerWallet`) and the live-wallet count. This yields two distinct quantities that should not be conflated: aggregate wallet-slot utilization (`activeReservationsCount` against `liveWalletsCount * maxReservationsPerWallet`) and governance-cap utilization (`activeReservationsCount` against the global `maxActiveReservations` ceiling).
- **Underlying tBTC funds are not locked:** This occupancy accounting applies only to the position of the dedicated-UTXO reservation. Depositor funds are not locked: upon `settleAcceptance`, the depositor is already credited liquid tBTC. The Bridge increases the reservation vault's Bank balance by the gross anchored amount and then calls the vault's Bridge-only `creditReservation(reservationKey)`; the vault mints tBTC gross and sends the owner gross minus min(`mintFeeBps` + `custodyBps`, 500) bps, where `custodyBps` is that of the position's term entry (22 / 25 / 40 bps for the ruled 30 / 91 / 365-day entries at the default 20 bps mint fee), and keeps the fee. A position stranded at credit (its wallet left Live before the proof) pays the mint fee only. If the vault is no longer trusted at proof time, the Bridge credits the depositor's Bank balance directly with no fee. This mint/credit flow is completely unrelated to the distinct `redeemReservation` feature, which is disabled in Milestone 1. Only the dedicated-UTXO reservation position itself lacks an early voluntary close mechanism in M1.
- **Wallet-closing gate dependency:** The safety story for `maxActiveReservations` relies on wallets not being able to retire while they still hold live reservation anchors. The `walletReservationInfo[wallet].count == 0` precondition is enforced at the two points that can still block _before_ any Bitcoin funds have moved: `moveFunds`'s routing decision (a wallet with a nonzero reservation count is always routed through `MovingFunds`, never straight to `Closing`) and `notifyWalletClosingPeriodElapsed`. It is deliberately _absent_ from `beginWalletClosing` and `finalizeWalletClosing`: both are reached only after a moving-funds Bitcoin transaction has already been proven on-chain via SPV proof, and blocking wallet retirement at that point (with funds already gone) would leave the wallet stuck mid-closing while its `movingFundsTimeout` clock keeps running, eventually triggering operator slashing for a state the protocol itself created. A wallet can therefore complete closing while still holding a live reservation anchor if reservations were requested against it after the `moveFunds` decision was made; the anchor itself is separately recovered via `notifyReservationStranded` once the wallet reaches `Terminated`/`Closed`/dissolution-eligible-`Closing`.
- **Procedure for raising capacity:** When active occupancy saturates or additional headroom is required, governance can raise the occupancy limit by calling `updateReservationCaps(maxReservationsAmountPerWallet, reservationMaxSingleAmount, newMaxActiveReservations)` with a higher `newMaxActiveReservations` value.
- **Sizing constraint:** Any update to `maxActiveReservations` or `reservationMaxSingleAmount` must maintain the Decision 1 relational invariant:
  `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount`
  (unless `reservationMaxSingleAmount == 0`, which disables the amount cap). If lowering caps or raising `reservationMaxTotalAmount`, governance must ensure the new slot capacity accommodates `reservationMaxTotalAmount`.
- **Operational timeline considerations:** Whether the Milestone 1 launch is expected to reach reservation term expiry before Milestone 2 ships is an open operational question that the deploying team and governance should confirm prior to setting initial term lengths and occupancy limits.

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

- Governance proposal builders (Defender, Safe Transaction Builder, Tenderly, custom multisend helpers) — regenerate the encoded calldata with the 3-argument signature for `updateReservationCaps`.
- Indexers and dashboards (The Graph subgraphs, Dune queries, custom event listeners) — update the event ABI to 3 fields for `ReservationCapsUpdated` and 6 fields for `ReservationReanchored` (appended `minerFee` field). Backward-compatible decoders will read the new fields as the next positional argument; forward-compatible decoders ignore unknown fields. Adding the `maxActiveReservations` field to `ReservationCapsUpdated` changes its event signature hash (topic0), so off-chain indexers watching the pre-PR `ReservationCapsUpdated` event signature will silently stop matching entirely until updated. Note that off-chain indexers watching the pre-PR `ReservationReanchored` event signature will likewise silently stop matching events until updated.
- Monitoring alerts and circuit breakers keyed on `ReservationCapsUpdated` or `ReservationReanchored` — confirm the alerts still fire on the new signatures.

**Note:** The `updateReservationCaps` selector change (3-arg vs 2-arg) means consumers MUST rebind/recompile against the new `IReservationBridge` interface. The interface in this PR declares the updated signature, but consumers that bind through it still need a recompile/rebind — the selector change (topic0 for events, 4-byte selector for functions) is not automatically absorbed by the interface binding alone.

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

**Before the Bridge implementation upgrade** on a network that already runs reservations from a deployment without the term table, untrust the old `ReservationVault` (`setVaultStatus(vault, false)`). Replacing `reservationVault` is not enough: a proof credits the vault the deposit was revealed to, and the old vault has no `creditReservation`, so while it stays trusted every proof of a deposit revealed to it reverts. Any acceptance generation requested before the upgrade and proven after it carries term id 0 and pays no custody fee. That covers a pending one, and also a timed-out one that is still inside its late window, even after a stale notice; once the table is seeded, that window runs up to the largest entry after the timeout. If its vault is untrusted, the Bridge credits the depositor directly and takes no fee; if its vault already runs this code, it pays the mint fee only. The vault can only be replaced while no reservation is active (see "Irreversible Vault Activation Warning").

**The cached largest and smallest term entry lengths are populated only by entries added while this code is live.** `BridgeState.addReservationTerm` folds in the entry being added, and nothing re-derives the two fields (`largestReservationTerm`, `smallestReservationTerm`) from the table. No deployment record in this repository runs a term-table implementation, so the supported order is: upgrade to this implementation first, then seed the table. A Bridge whose table was already seeded by an implementation that scanned the table on every read must not be upgraded to this one unless the same upgrade transaction (`upgradeAndCall` with a reinitializer, as the Bridge's earlier upgrades did) re-derives the two fields from ids 1 to `MAX_RESERVATION_TERM_ID`; that reinitializer is not part of this code. Until it runs, the seeded entries are live but both fields read zero, and every reader behaves as over an empty table: every reserved reveal reverts at any reveal-ahead period above 24 hours (the refund-locktime cap is the 24-hour safety margin alone); a timed-out acceptance has no late window; `updateDepositParameters` and `updateReservationParameters` skip their table relations, so a reveal-ahead period above the largest seeded entry plus 24 hours, or a renewal window at or above the smallest seeded entry, passes the table relation (the renewal window's bound against the global term still applies); and a further term entry is checked against the entries added since the upgrade alone, in both directions, so an entry the seeded table would allow can be refused, and an entry can be added although the stored renewal window is at or above a seeded entry. A reinitializer that only rewrites the two fields re-checks nothing, so a parameter accepted in that state stays in force. The renewal window has no runtime reader; a window at or above a live entry surfaces as a revert of every further term entry ("Renewal window must be shorter than every term entry") until governance lowers the window. A reveal-ahead period above the largest entry plus 24 hours leaves every reserved reveal without a valid deadline and refuses every entry shorter than the period minus 24 hours ("Largest term must cover the deposit reveal ahead period") until governance lowers the period or adds an entry at least the period minus 24 hours long, which is possible only while that length is within `MAX_RESERVATION_TERM`.

After applying the upgrade on a live network:

```solidity
// Operator-supplied inputs: bridgeAddress, expectedRouterAddress,
// expectedVaultOwner, expectedTbtcVault (the canonical TBTCVault).

// Spot-check the Decision 1 invariant via three views on the bridge.
// reservationParameters() returns a 10-value tuple; the 1st value is reservationVault, the 6th is reservationMaxTotalAmount.
(address reservationVault, , , , , uint64 reservationMaxTotalAmount, , , , ) =
    IReservationBridge(bridgeAddress).reservationParameters();
(, uint64 reservationMaxSingleAmount, ) =
    IReservationBridge(bridgeAddress).reservationCaps();
(, uint32 maxActiveReservations) =
    IReservationBridge(bridgeAddress).activeReservationsCount();

// Pre-activation sanity checks (run before/alongside setting a non-zero reservationVault):
address router = IReservationBridge(bridgeAddress).reservationRouter();
require(router != address(0) && router == expectedRouterAddress, "Router mismatch");
require(reservationVault != address(0), "Vault not set");
require(Ownable(reservationVault).owner() == expectedVaultOwner, "Vault ownership mismatch");
require(Bridge(bridgeAddress).isVaultTrusted(reservationVault), "Vault not trusted");

// Acceptance-credit invariant 1: TBTCVault owns the TBTC token (otherwise
// the vault's mint reverts, and with it every acceptance proof).
TBTCVault tbtcVault = ReservationVault(reservationVault).tbtcVault();
require(
    TBTC(address(ReservationVault(reservationVault).tbtcToken())).owner() == address(tbtcVault),
    "TBTCVault does not own TBTC"
);
// Invariant 1 only proves the vault's own token is owned by its own
// TBTCVault: a vault built against a separate TBTCVault/TBTC pair passes it
// and would pay owners a non-canonical token. Pin it to the canonical one.
require(
    address(ReservationVault(reservationVault).tbtcVault()) == expectedTbtcVault,
    "Vault bound to another TBTCVault"
);

// Acceptance-credit binding: the vault's constructor-set Bridge and Bank are
// immutable and unchecked on-chain. A vault bound to another Bridge rejects
// the real Bridge's credit call; one bound to another Bank cannot convert the
// balance the Bridge credited. Either way every acceptance proof reverts.
(Bank bridgeBank, , , ) = Bridge(bridgeAddress).contractReferences();
require(
    address(ReservationVault(reservationVault).bridge()) == bridgeAddress,
    "Vault bound to another Bridge"
);
require(
    address(ReservationVault(reservationVault).bank()) == address(bridgeBank),
    "Vault bound to another Bank"
);
```

The three views together supply the three quantities the Decision 1 invariant is written in terms of:
`reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount` (or `reservationMaxSingleAmount == 0`).

> **Precondition note:** Setting a new non-zero `reservationVault` in `updateReservationParameters` also requires `maxActiveReservations > 0`; the call reverts otherwise, so the Decision 1 invariant check above is not sufficient on its own when activating the vault for the first time.

**Acceptance-credit invariant 2: the configured reservation vault implements `creditReservation`** (selector `0x60bac298`); the Bridge calls it inside every acceptance proof. The function is not a view, so probe it with a call from a non-Bridge address, which the hook must reject with its caller check:

```sh
cast call <reservationVault> "creditReservation(uint256)" 0 --from <any non-Bridge address>
# expected: execution reverted: "Caller is not the Bridge"
```

Any other result (a different revert reason, an empty revert, or success) means the vault does not implement the hook and must not be activated. This probe does not show which Bridge the vault answers to: a vault bound to another Bridge gives the same answer, which is why the binding checks in the block above are needed alongside it.

**Escape if any of these checks fails after activation:** `setVaultStatus(reservationVault, false)` (through `BridgeGovernance`) makes the vault untrusted, and acceptance proofs then settle through the Bridge's direct-credit fallback: the depositor's Bank balance is credited with the gross anchored amount and no fee is taken. If the misconfigured reservation vault is the TBTCVault itself, untrusting it also stops pooled minting through it.

Because setter transactions revert on an invariant violation, a rejected configuration modifies no storage. If governance encounters a revert with `Amount cap exceeds slot capacity` during configuration, the remedy is:

1. Re-issue `updateReservationParameters` with a smaller `reservationMaxTotalAmount` that satisfies `reservationMaxTotalAmount <= maxActiveReservations * reservationMaxSingleAmount`; or
2. Re-issue `updateReservationCaps` with the caps in the correct order (or with higher `maxActiveReservations` / `reservationMaxSingleAmount` values that accommodate the desired total amount).
