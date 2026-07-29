# Phase B-2: keep-core FROST DKG coordinator spec

**Status:** Draft v1 (initial cut)
**Date:** 2026-05-24
**Phase:** B-2 (off-chain coordinator side of FROST wallet
registration)
**Companion to:** RFC #437 v4.1 (wallet-registry trust model),
PR #441 (B-1 on-chain FrostWalletRegistry).
**Implementation lives in:** `keep-network/keep-core` (separate
repo). This doc is the on-chain-side spec the keep-core PR
implements against.

## Scope

B-1 (`FrostWalletRegistry` contract on tbtc-v2) is deployed
and wired to Bridge. The registry's `requestNewWallet()` entry
point is unreachable from Bridge until C-2 governance flips
`currentNewWalletScheme` to FROST.

B-2 is the off-chain side: the keep-core process that runs on
each operator node, listens for the registry's lifecycle events,
runs the FROST DKG protocol off-chain among the selected group,
and submits the result back on-chain. Without B-2, an operator
selected to a FROST DKG group cannot produce a valid result,
so the registry's submission window expires and
`notifyDkgTimeout` resets the state — i.e., FROST wallet
creation cannot complete until B-2 ships.

This spec defines:

1. The on-chain interfaces B-2 must consume + produce.
2. The on-chain → off-chain → on-chain control flow.
3. The result digest format B-2 must compute (the cryptographic
   binding to the on-chain validator).
4. Operational requirements (failure modes, recovery).

It does NOT define the FROST DKG cryptographic protocol itself —
that follows the IETF / IRTF FROST draft (cited below). B-2's
contribution is the _coordination layer_ that drives a FROST DKG
session through the on-chain state machine.

## Non-goals

- Cryptographic specification of FROST DKG. Use the published
  IRTF/IETF FROST draft + keep-core's existing DKG framework.
- Bridge-side scheme routing — that is C-2's responsibility (PR
  #439, landed).
- ECDSA DKG path. The existing ECDSA DKG flow stays unchanged;
  this spec is purely additive.
- Heartbeat-failure callback on the FROST registry. The B-1
  registry deliberately omits the heartbeat-failed callback per
  RFC v4 §"Non-goals"; B-2 must not assume the callback exists.

## On-chain surface B-2 consumes

`FrostWalletRegistry` (this PR, #441) exposes the following.
Addresses for both contracts come from the deployment record;
ABIs from `contracts/tbtc-v2/contracts/frost-registry/`.

### Events to subscribe

Subscribe via `eth_subscribe` / `eth_getLogs` from the chain
head; back-fill across reorgs from `Bridge.contractCreatedAt - 1`
on cold start.

| Event                                                                                        | Emitter                        | Trigger for B-2                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NewWalletRequested()`                                                                       | Bridge (via `Wallets` library) | Note: a new wallet request has entered the system. B-2 does NOT act here directly — it waits for the registry's seed-callback event below, because that's the moment the selected group is fixed.                                                    |
| `DkgStarted(uint256 indexed seed)`                                                           | FrostWalletRegistry            | The random beacon delivered a seed; `selectedGroup` is now fixed. Each B-2 process checks whether its operator address is in `selectedGroup` (via `sortitionPool.getIDOperator(...)` per member ID). If yes, start a DKG session bound to this seed. |
| `DkgResultSubmitted(bytes32 indexed resultHash, uint256 indexed seed, DKG.Result result)`    | FrostWalletRegistry            | A group member has submitted the DKG result. All B-2 processes (whether or not they participated in DKG) start the challenge-window clock and prepare to either approve (if no challenge) or challenge (if the result is malformed).                 |
| `DkgResultChallenged(bytes32 indexed resultHash, address indexed challenger, string reason)` | FrostWalletRegistry            | The submitted result was successfully challenged. State returns to `AWAITING_RESULT`; the participating group must produce a corrected result.                                                                                                       |
| `DkgResultApproved(bytes32 indexed resultHash, address indexed approver)`                    | FrostWalletRegistry            | The result was approved; the wallet is now Live on Bridge. B-2's per-session state can be torn down.                                                                                                                                                 |
| `DkgTimedOut()` / `DkgSeedTimedOut()`                                                        | FrostWalletRegistry            | The session timed out; reset per-session state.                                                                                                                                                                                                      |

### Views to read

| View                                                                       | Returns                                                                        | When B-2 calls it                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getWalletCreationState()` returns `FrostDkg.State`                        | Current state enum: `IDLE` / `AWAITING_SEED` / `AWAITING_RESULT` / `CHALLENGE` | Cold-start state recovery; check before any submission.                                                                                                                                                                                                |
| `sortitionPool.selectGroup(GROUP_SIZE, bytes32(seed))`                     | `uint32[]` member IDs                                                          | Recover the selected group's member IDs from the seed. Constant for the lifetime of a DKG session (pool is locked).                                                                                                                                    |
| `sortitionPool.getIDOperator(uint32)` returns `address`                    | Operator address for the given member ID                                       | Map member IDs → operator addresses for the local-operator check and for signature recovery during submission.                                                                                                                                         |
| `sortitionPool.isOperatorInPool(address)` returns `bool`                   | Defense-in-depth member existence check.                                       | Optional — the pool's `lock()` already guarantees no operator leaves; this check is a fail-safe.                                                                                                                                                       |
| `validator.resultDigest(result, seed, bridge, registry)` returns `bytes32` | The exact pre-EIP-191 digest the on-chain validator will compare against       | B-2 computes this off-chain to collect signatures; it can ALSO call this view to double-check its off-chain computation matches before submitting (avoids surprises from format-string drift between off-chain implementation and on-chain validator). |

### Mutating calls B-2 makes

| Function                                     | Caller                                                                                                                                                    | Pre-conditions                                                                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitDkgResult(DKG.Result result)`         | Any operator in `selectedGroup` (the submitter index is asserted on-chain)                                                                                | Registry state == `AWAITING_RESULT`; submission window not elapsed; submitter is in pool + index matches; result.xOnlyOutputKey not already registered (RFC v4 delta #4 guard). | **Optimistic submission** — does NOT call `FrostDkgValidator.validate`. The contract only checks state, timeout, submitter membership/index. Bad-data results enter the challenge window unchallenged unless an honest B-2 process catches them. Opens the challenge window; result is held by the registry; not yet active.                                               |
| `approveDkgResult(DKG.Result result)`        | Any operator in `selectedGroup`; for the first `submitterPrecedencePeriodLength` blocks after the challenge window, only the original submitter can call. | Challenge window has elapsed (block-number based); the result hash matches the previously-submitted hash.                                                                       | **Also optimistic** — `approveDkgResult` does NOT re-run validation. It activates the wallet (`Bridge.__frostWalletCreatedCallback(xOnlyOutputKey)`) based solely on the absence of a successful challenge during the window. Active challenge monitoring by an honest majority is therefore the load-bearing safety property — see "Approve-vs-challenge decision" below. |
| `challengeDkgResult(DKG.Result result)`      | Any address (permissionless)                                                                                                                              | Challenge window is open; the result fails `FrostDkgValidator.validate(...)`.                                                                                                   | **Only place validation runs.** Slashes the malicious submitter; reverts state to `AWAITING_RESULT`.                                                                                                                                                                                                                                                                       |
| `notifyDkgTimeout()` / `notifySeedTimeout()` | Any address                                                                                                                                               | Submission / seed window elapsed (block-number based) without a valid submission.                                                                                               | Resets state to `IDLE`, unlocks the pool.                                                                                                                                                                                                                                                                                                                                  |

## v4 result digest (the cryptographic binding)

Each `selectedGroup` operator that participated in DKG signs the
following digest (EIP-191-prefixed before signing). The
on-chain validator recomputes this exact bytestring and compares;
B-2 MUST produce the identical digest off-chain.

```text
digest = keccak256(abi.encode(
    "tbtc-frost-dkg-result-v1",                    // string  (literal)
    block.chainid,                                  // uint256 (chain at submission time)
    address(bridge),                                // address (Bridge proxy address)
    address(registry),                              // address (FrostWalletRegistry proxy)
    seed,                                           // uint256 (from random beacon callback)
    xOnlyOutputKey,                                 // bytes32 (FROST DKG output)
    keccak256(abi.encode(members)),                 // bytes32 (sorted ascending uint32[])
    keccak256(abi.encode(misbehavedMembersIndices)) // bytes32 (sorted ascending uint8[])
))
```

Each member then signs `keccak256("\x19Ethereum Signed Message:\n32" || digest)`.

**Verifying via the on-chain view:** B-2 can call
`validator.resultDigest(result, seed, bridge, registry)` to get
the canonical bytes the validator will hash. Implementations
should keep their off-chain computation primary (so coordination
works during chain-RPC outages) and use the on-chain view as a
sanity check before submission.

**Replay safety properties** (each digest field closes one
vector — see PR #441's
`test/frost-registry/FrostDkgValidator.DigestBinding.test.ts`
for the per-field tests):

| Field                                    | Closes                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `"tbtc-frost-dkg-result-v1"` literal tag | Version-drift replay                                                                                                        |
| `block.chainid`                          | Cross-chain replay                                                                                                          |
| `address(bridge)`                        | Wrong-Bridge replay (e.g., a testnet Bridge attestation reused against mainnet)                                             |
| `address(registry)`                      | Wrong-registry replay (e.g., a stub deploy reused against the production registry)                                          |
| `seed`                                   | Wrong-request replay (each Bridge wallet-creation request gets a unique random-beacon seed)                                 |
| `xOnlyOutputKey`                         | Wrong-key replay (signatures for one DKG output cannot register a different key)                                            |
| `keccak256(members)`                     | Wrong-group replay (the selected-group composition is fixed at submission time)                                             |
| `keccak256(misbehavedMembersIndices)`    | Reward-ban-list edits (RFC v4 P1 — without this, a submitter could edit the misbehaved list while keeping signatures valid) |

## Control flow

A single Bridge wallet-creation cycle, end-to-end:

```
                Bridge / governance                FrostWalletRegistry              keep-core (per operator)
                ==================                =====================            ==========================

  (C-2 active, scheme=FROST)
  --------- t=0: governance or maintainer ---------
  Bridge.requestNewWallet()
        |
        |    (Wallets dispatches per scheme)
        v
  FrostWalletRegistry.requestNewWallet()
        |
        |    [emit Bridge.NewWalletRequested]
        |
        |    .lockSortitionPool()
        |    .randomBeacon.requestRelayEntry(this, ...)
        |    .transition AWAITING_SEED
        v

  --------- t≈seedTimeout/2 (variable): beacon delivers ----------
  randomBeacon → FrostWalletRegistry.__beaconCallback(relayEntry, _entryBlock)
        |
        |    // The registry passes `relayEntry` straight through to
        |    // `dkg.start(relayEntry)`; no keccak wrapping. The
        |    // second arg (_entryBlock) is intentionally ignored.
        |    .seed = relayEntry
        |    .startBlock = block.number   // current block, NOT entryBlock
        |    .transition AWAITING_RESULT
        |    [emit DkgStarted(seed)]      // seed == relayEntry literally
        v                                                            |
                                                                     v
                                                          B-2 process sees DkgStarted(seed).
                                                          Computes members = sortitionPool.selectGroup(100, bytes32(seed)).
                                                          If self.operatorAddress is in members:
                                                            * derive memberIndex (1-based) within members[]
                                                            * begin FROST DKG session
                                                            * exchange shares with other selected operators
                                                              over keep-core's existing p2p layer
                                                            * agree on xOnlyOutputKey (FROST-DKG output)
                                                            * mark any non-responsive members as misbehaved
                                                          After DKG completes:
                                                            * any participating member computes the v4 digest
                                                            * collects ECDSA signatures from each participating
                                                              member over EIP-191-prefixed(digest)
                                                            * one chosen submitter (any member, e.g., lowest
                                                              memberIndex) builds the DkgResult struct +
                                                              calls submitDkgResult

  --------- t = seedBlock + offchain DKG time + signature collection ---------
                                                                     |
        FrostWalletRegistry.submitDkgResult(result)  <-- B-2 submitter
        |
        |    .submittedResultHash = keccak256(result)
        |    .submittedResultBlock = block.number
        |    .transition CHALLENGE
        |    [emit DkgResultSubmitted(resultHash, seed, result)]
        v

  --------- t + dkgResultChallengePeriodLength (default: ~48h) ---------
  Permissionless: any B-2 process or watcher can call challengeDkgResult
  if the submitted result is malformed. This is the only on-chain path
  that calls FrostDkgValidator.validate. Successful challenge:
        FrostWalletRegistry.challengeDkgResult(result)
        |
        |    .validator.validate(result, ...) returns false
        |    .slash(submitter)
        |    .transition AWAITING_RESULT (or IDLE if timeout passed)
        |    [emit DkgResultChallenged]
        v
                                                          B-2: re-run DKG, re-submit.

  Challenge window expires without a successful challenge:
                                                          B-2 submitter (or any other group member after the
                                                          submitterPrecedence window): calls approveDkgResult.

        FrostWalletRegistry.approveDkgResult(result)  <-- B-2 approver
        |
        |    .wallets.addWallet(membersHash, xOnlyOutputKey)
        |    .registered[xOnlyOutputKey] = true                                          <-- RFC v4 delta #4
        |    .Bridge.__frostWalletCreatedCallback(xOnlyOutputKey)                        <-- registers on Bridge
        |    .unlockSortitionPool()
        |    .transition IDLE
        |    [emit DkgResultApproved, WalletCreated]
        v                                                            |
                                                                     v
                                                          B-2: tear down per-session state. The wallet is
                                                          now Live on Bridge; subsequent Bitcoin operations
                                                          (deposit sweeps, redemption, moving funds) go
                                                          through the lifecycle router per Phase A.
```

## Operational requirements

### Selected-group membership check

Each B-2 process on `DkgStarted(seed)`:

1. `members = sortitionPool.selectGroup(GROUP_SIZE=100, bytes32(seed))`
2. For each `m` in `members`: `op = sortitionPool.getIDOperator(m)`
3. If `op == self.operatorAddress`: this node participates;
   `selfMemberIndex = (1-based position of m in members)`
4. Otherwise: this node monitors-only.

### Submission readiness

B-2 should NOT submit until:

- ≥ `groupThreshold` (51) signatures collected
- `signingMembersIndices` strictly ascending (uniqueness + order)
- Self's `selfMemberIndex` matches the `submitterMemberIndex` field
  (if THIS node is the submitter)

### Eligibility timing

The on-chain `resultSubmissionTimeout` (default: 536 blocks ≈
2h) governs the on-chain window. Submitters elect themselves by
calling submitDkgResult. To reduce wasted gas on
double-submissions, B-2 implementations should:

- Pick a deterministic submitter (e.g., the member with the
  lowest memberIndex who is online).
- Other members fall back if the chosen submitter is offline
  after a short window (e.g., 30 blocks).

The on-chain contract doesn't enforce this — it just requires
the submission be from a valid selected-group member. So
"deterministic submitter + fallback" is purely an off-chain
gas-efficiency optimization.

### Approve-vs-challenge decision

**Active challenge monitoring is mandatory, not optional.** The
on-chain `submitDkgResult` and `approveDkgResult` paths are both
optimistic — neither calls `FrostDkgValidator.validate`. The
_only_ place validation runs is inside `challengeDkgResult`. If
no honest party challenges a bad-data submission during the
window, `approveDkgResult` will activate the malicious result and
register it on Bridge. So every B-2 process that observes a
`DkgResultSubmitted` event MUST run validation off-chain.

During the challenge window:

1. Every B-2 process re-runs validation off-chain on the
   submitted result (calling `FrostDkgValidator.validate(...)` as
   an `eth_call` view is the simplest mirror; it returns
   `(bool isValid, string memory errorMsg)` without sending a
   transaction).
2. If validation passes: do nothing during the window; if/when
   the submitter doesn't approve before the precedence window
   expires (block-number gap of `submitterPrecedencePeriodLength`,
   default 20 blocks), the next member calls `approveDkgResult`.
3. If validation fails: any B-2 process (or external watcher)
   calls `challengeDkgResult`. Successful challenge slashes the
   submitter and returns state to `AWAITING_RESULT` for re-run.
   The challenge window is `resultChallengePeriodLength` blocks
   (default 11,520 ≈ 48h) — long enough that a globally-
   distributed honest minority has time to react.

### Failure modes

| Mode                                                           | Detection                                                                                                                        | Recovery                                                                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Random beacon stalls                                           | Time elapsed since `requestRelayEntry` exceeds `seedTimeout`                                                                     | Any address: `notifySeedTimeout()`. Resets state to IDLE, unlocks pool.                                                                                                                              |
| DKG fails off-chain (not enough live operators, p2p partition) | Time elapsed since seed callback exceeds `resultSubmissionTimeout` without a submission                                          | Any address: `notifyDkgTimeout()`. Resets state to IDLE, unlocks pool.                                                                                                                               |
| Submitter goes offline post-submission                         | `block.number > submittedResultBlock + dkgResultChallengePeriodLength + submitterPrecedencePeriodLength` without an approve call | Any other group member: `approveDkgResult(result)` (no longer submitter-exclusive). The DKG timing fields are all block-number based — DO NOT schedule against `block.timestamp` or wall-clock time. |
| Malicious submission                                           | Validation fails on the submitted result                                                                                         | Any address: `challengeDkgResult(result)` within challenge window. Slashes submitter; resets state.                                                                                                  |
| Local operator crash after DKG completed but before submission | Other group members observe no submission within submitter-precedence window                                                     | A different group member submits (the submission only requires the right group + signatures, not a specific submitter).                                                                              |
| Wallet already registered (collision on xOnlyOutputKey)        | `submitDkgResult` reverts with `XOnlyOutputKeyAlreadyRegistered` (RFC v4 delta #4 + library guard)                               | DKG protocol bug — the same key emerged twice. Operationally: investigate; the existing wallet stays live.                                                                                           |

### Sortition-pool sharing question (carried from B-1)

The B-1 deploy script (`48_deploy_frost_wallet_registry.ts`)
deploys a DEDICATED `FrostSortitionPool` separate from the ECDSA
registry's `EcdsaSortitionPool`. Operators must register in
both pools to participate in both wallet types. The RFC's
recommendation to share one pool is gated on a future
router-contract design that's deferred until D-2's ECDSA
retirement makes the question moot. B-2 implementations should
read from `FrostSortitionPool` only.

## Hand-off to keep-core

The keep-core PR opens against `keep-network/keep-core` (separate
repo). It should:

1. Add a new package (e.g., `pkg/frost/registry/`) that wraps the
   on-chain interface defined in this spec.
2. Re-use keep-core's existing DKG framework — same threshold,
   same beacon integration pattern, same sortition mechanics —
   substituting the FROST DKG protocol for the ECDSA DKG.
3. Add a per-cycle state machine (IDLE → AWAITING_SEED →
   DKG_SESSION → AWAITING_SUBMISSION → CHALLENGE_WINDOW →
   APPROVE) that mirrors the on-chain registry's state.
4. Implement the v4 digest computation off-chain; cross-check
   against the on-chain view before submission.
5. Implement deterministic-submitter-with-fallback to avoid gas
   waste on double-submissions.
6. Wire the result-validation re-run on every submission for the
   challenge-readiness path.
7. Test against a local hardhat node running the B-1 contracts
   in `tbtc-v2`.

When the keep-core PR is merged, FROST DKG sessions can complete
on testnet. Production cutover still waits for governance's
explicit `setNewWalletScheme(Frost)` call.

## References

- RFC #437 v4.1: `docs/frost-migration/wallet-registry-trust-model-rfc.md`
  (full trust-model justification)
- B-1 implementation plan: `docs/frost-migration/b1-implementation-plan.md`
- FROST IRTF draft: <https://datatracker.ietf.org/doc/draft-irtf-cfrg-frost/>
- BIP-340 (Schnorr signatures): <https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki>
- BIP-341 (Taproot): <https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki>
- ECDSA registry equivalent (the model B-1 is ported from):
  `@keep-network/ecdsa/contracts/WalletRegistry.sol`
- keep-core ECDSA coordinator (the model B-2 mirrors with the
  FROST DKG substitution): `keep-network/keep-core/pkg/tbtc/dkg.go`
  (and surrounding tbtc package).
