# RFC: FROST WalletRegistry trust model

**Status:** v5 — post-implementation reconciliation against
shipped B-1 (PR #441 + B-1.5 follow-ups)
**Date:** 2026-05-24
**Phase:** B-1 (on-chain FROST WalletRegistry contract)
**Decision sought:** Originally requested approval for the v4
trust model. Granted via PR #441 merge. This v5 revision is a
historical-record cleanup — it reconciles the RFC text with
the architectural changes that landed during Codex review of
the B-1 implementation, so future readers cite a consistent
design.

## Revision history

### v5 — 2026-05-24 (post-implementation reconciliation)

PR #441 (B-1 implementation) merged after several rounds of
Codex review. Two reviews produced architectural changes that
diverge from the v4 spec:

- **Dual-owner authority split (Codex P1 on #441).** v4
  described a single `walletOwner` role — Bridge, set via
  `setFrostWalletRegistry`. The implementation discovered
  that `walletOwner = Bridge` alone breaks the close/seize
  lifecycle path: those calls arrive from the
  `BridgeLifecycleRouter` (`msg.sender == router`, not
  Bridge), so a single-slot `walletOwner` cannot satisfy both
  the creation-side caller-check (Bridge) and the lifecycle-
  side caller-check (router). **Resolution:** split into two
  storage slots:

  - `IFrostWalletOwner public walletOwner` — set to Bridge
    in `initialize()`. Gates `requestNewWallet()` via
    `onlyWalletOwner`.
  - `address public lifecycleOwner` — set separately via
    `updateLifecycleOwner(address)` (governance-callable,
    non-one-time so a router redeploy is possible). Gates
    `closeWallet` and `seize` via `onlyLifecycleOwner`.
    See "Contract surface (v5)" below for the full surface.

- **LifecycleOwner-not-set fail-fast guard (Codex P2 on #441).**
  Without an early guard, governance could call
  `requestNewWallet()` before wiring `lifecycleOwner`, kicking
  off a DKG whose eventually-Live wallet would have no
  dispatcher for close/seize. Resolution: add an early
  `require(lifecycleOwner != address(0))` (as a custom
  `LifecycleOwnerNotSet` error) at the top of
  `requestNewWallet()` AND a defense-in-depth re-check at
  `approveDkgResult` — the lifecycleOwner setter is not
  one-time, so governance could theoretically zero it
  mid-DKG and the re-check guarantees no FROST wallet ever
  registers without an active lifecycle path.

- **Custom errors throughout (Codex P1 round 3 on #441).** v4
  used `require(...,"string")` for readability. The shipped
  contract uses custom errors with 4-byte selectors
  (`error LifecycleOwnerNotSet();`, `error EcdsaWalletIdIsZero();`,
  `error FrostWalletRegistryNotSet();`, etc.). Motivation:
  some JSON-RPC + hardhat-waffle matcher combinations surface
  empty revert reasons when reverting with a require-string,
  making tests flaky across environments. The 4-byte selector
  encoding survives every JSON-RPC environment we ship to.

- **`DigestBinding` struct (stack-too-deep workaround).** The
  on-chain `resultDigest` view takes 8 logical parameters
  (chainid + bridge + registry + seed + xOnlyOutputKey +
  membersHash + misbehavedHash + result struct field count).
  Solidity's stack-too-deep kicked in on the validator
  contract. Resolution: pass a `DigestBinding` struct
  carrying the per-deployment binding triple (bridge,
  registry, seed) into the validator, freeing slots for the
  result fields. Pure refactor — digest bytes are unchanged.

- **Fail-fast registered-key check at `submitDkgResult` top.**
  v4 specified `registered[xOnlyOutputKey]` as a defensive
  guard on the approval path. The implementation also added
  the same check at the TOP of `submitDkgResult` so a stale
  but otherwise-valid result can't lock the state machine in
  CHALLENGE until timeout. (The duplicate check costs ~5k
  gas but saves operators a full challenge-period wait when
  the off-chain coordinator's local view is briefly stale.)

- **Contract paths corrected.** v4 suggested
  `contracts/tbtc-v2/contracts/bridge/FrostWalletRegistry.sol`.
  Shipped path is `contracts/tbtc-v2/contracts/frost-registry/`
  (alongside `FrostDkgValidator.sol`, `libraries/FrostDkg.sol`,
  `libraries/FrostAuthorization.sol`, `libraries/FrostInactivity.sol`,
  `libraries/FrostRegistryWallets.sol`). The library split
  mirrors the keep-network ECDSA structure.

- **walletPubKeyHash derivation clarified.** v4 said Bridge
  receives `xOnlyOutputKey` and registers the wallet but
  didn't specify how the legacy 20-byte `walletPubKeyHash`
  alias is derived. Shipped:
  `walletPubKeyHash = HASH160(0x02 || xOnlyOutputKey)`. The
  `0x02` prefix gives the (always-even) y-parity byte for
  the compressed-form pubkey; HASH160 is RIPEMD160(SHA256()).
  Documented here so off-chain consumers (subgraph, SDK,
  relayer) compute the same alias.

- **B-1.5 test slices.** v4's implementation plan listed all
  tests as a single item. In practice, B-1.5 ships as three
  numbered slices (signing helper + parity, 100-operator
  fixture, full happy path) in PR #446. The slicing isolates
  failure modes — a digest-parity drift surfaces as "digest
  mismatch" rather than "invalid signature deep inside DKG."

No trust-model deltas vs. v4 — the request-seed-bound DKG
with operator quorum attestation and the v4 result-digest
binding are unchanged. Only the _implementation_ surface and
the operational _activation_ sequence (initialize → wire
lifecycleOwner → flip C-2 scheme) gained detail.

### v4 — 2026-05-24

Codex round-3 review on v3 surfaced one critical bug and two
scope clarifications:

- **[P1] v3 digest didn't include `misbehavedMembersIndices`.**
  The ECDSA `WalletRegistry` covers `misbehavedMembersIndices` in
  the signed result. v3 omitted it. A submitter could keep the
  signature bundle valid while swapping the misbehaved list to
  grief specific operators (false-positive bans) or to whitewash
  real misbehavior (skip bans). **Fixed in v4:** digest adds
  `keccak256(abi.encode(misbehavedMembersIndices))` so any
  modification invalidates every signature.

- **[P2-routing] v3 said "no Bridge surface changes" but
  `Wallets.requestNewWallet` still unconditionally calls
  `self.ecdsaWalletRegistry.requestNewWallet()` on the current
  base.** Without a Bridge change that branches on a scheme
  preference, the FROST registry is unreachable. v3 erroneously
  implied the existing call shape already supported FROST.
  **Fixed in v4:** B-1 ships the registry contract but routing
  it as the active path is C-2's responsibility (the
  scheme-preference RFC, PR #438). B-1's `requestNewWallet`
  entry point stays unreachable from Bridge until C-2 ships AND
  governance flips `currentNewWalletScheme` to FROST. v4 makes
  this an explicit prerequisite + adds "Bridge integration: out
  of scope for B-1" to the Non-goals section.

- **[P2-unbonding] v3 overstated mid-DKG unbonding rejection.**
  The sortition pool's `lock()` during DKG already prevents
  operators from leaving the pool while a DKG is in flight; the
  `isOperatorInPool` re-check at submission won't catch a stake
  change because the lock blocks pool updates. v3 framed the
  re-check as the primary mitigation when really the pool lock
  is. **Fixed in v4:** correctly attributes the mitigation to
  the pool lock; the `isOperatorInPool` re-check is reframed as
  defense-in-depth (catches the bug case where the lock fails
  or is bypassed by a future sortition pool API change).

### v3 — 2026-05-24

Codex round-2 review on v2 surfaced one critical bug and three
hygiene issues:

- **[P1] v2 still didn't bind the attestation to the
  request-selected group.** v2 verified that signing operators
  were CURRENT pool members but allowed any threshold of current
  operators to sign an arbitrary `xOnlyOutputKey` + member list
  and consume an open request. The ECDSA `WalletRegistry` binds
  attestations to a specific `selectGroup(groupSize, seed)` call
  derived from a random beacon entry; the FROST registry needs
  the equivalent. **Fixed in v3:** the design is rescoped to
  mirror the full ECDSA `WalletRegistry` state machine —
  request → beacon callback → `selectGroup(seed)` → DKG window →
  result submission gated on members matching the selected
  group → challenge period → approval. Any threshold of
  ARBITRARY operators no longer suffices; only the seed-selected
  group can produce a valid attestation.

- **[P2] `ISortitionPool.currentEpoch()` doesn't exist.** v2's
  sketch referenced a non-existent method. The real sortition
  pool API (`@keep-network/sortition-pools`) exposes
  `selectGroup(uint256, bytes32) returns (uint32[])`,
  `lock()/unlock()`, `isLocked()`, `isOperatorInPool(address)`,
  `getIDOperator(uint32)`, `operatorsInPool()`. The actual
  binding to a specific request is via the seed, not an epoch.
  **Fixed in v3:** sketch and discussion use the real API.

- **[P2] Stale v1 guidance lingers in "Open considerations".**
  v2 left v1's advice to inline `CheckBitcoinBIP340Sigs`, omit
  timestamps "because `registered` is enough", use the
  `tbtc-frost-wallet-registration-v1` tag, and have Phase B-2
  submit a FROST Schnorr signature — all of which contradict the
  v2/v3 operator-ECDSA-attestation model. **Fixed in v3:** Open
  considerations rewritten for v3.

- **[P2] Context / Goals sections still named the old Bridge
  entrypoint.** Earlier prose used `registerNewFrostWallet`
  (the internal Wallets library helper); only the revision
  history + sketch were updated. **Fixed in v3:** sweep through
  the prose; the external Bridge callback is
  `__frostWalletCreatedCallback(bytes32)` everywhere.

### v2 — 2026-05-24

Codex round-1 review surfaced two correctness bugs and one
operational concern in v1:

- **[P1] v1's "Schnorr sig from the registered key over the
  attestation" is self-authenticating.** Any attacker can generate
  a fresh Schnorr keypair locally, sign the attestation for that
  key, and have the registry register the attacker-controlled key
  as a live Bridge wallet. The signature proves possession of the
  key being registered, not that the key came from an authorized
  DKG. **Fixed in v2:** registration now requires a threshold
  signature from a quorum of CURRENT sortition operators attesting
  to a DKG result that produced the xOnlyKey, not a signature from
  the produced key itself.

- **[P2] Bridge has no `registerNewFrostWallet` external entry.**
  Bridge.sol:1126 exposes `__frostWalletCreatedCallback(bytes32)`
  as the FROST registration callback; `registerNewFrostWallet` is
  a `Wallets` library helper invoked internally from that callback.
  v1's contract sketch called the non-existent function and would
  have reverted on first use. **Fixed in v2:** sketch updated to
  call `__frostWalletCreatedCallback(bytes32)`.

- **[P2-late-submission] v1's "late-submission is harmless" claim
  is wrong once registration makes the wallet live.** A valid
  attestation signed by a now-disbanded signer set could be
  submitted after the operators are no longer bonded/available;
  the wallet would activate but cannot sign sweeps. **Fixed in
  v2:** registration is bound to a CURRENT-epoch sortition group
  and is rejected if the supporting operators are no longer
  members of the current sortition pool.

The Bridge integration story in §"Implementation plan" also gains
a step (Phase B-1 must request an open `NewWalletRequested`
fulfillment slot so registrations can't be made out-of-band).

### v1 — 2026-05-24

Original RFC. Proposed a "FROST group signs its own registration
attestation" model. Superseded.

## Context

Bridge.sol carries a one-time governance setter
`setFrostWalletRegistry(address)` (PR #431). The address it points at
becomes the only contract permitted to call
`Bridge.__frostWalletCreatedCallback(bytes32 xOnlyOutputKey)`
(Bridge.sol:1126), which forwards to the `Wallets.registerNewFrostWallet`
library helper and inserts a new FROST-keyed wallet into the
registered-wallets mapping.

Phase B-1's deliverable is the registry contract itself. The
remainder of this RFC scopes what that contract must do, how it
authenticates registration submissions, and the interface contract
it owes Bridge and the off-chain keep-core DKG coordinator
(Phase B-2).

## Goals

1. **No trusted off-chain coordinator.** The FROST DKG produces a
   group public key; the on-chain authority that the result is
   legitimate must come from an attested-quorum of
   sortition-selected operators, not from a privileged
   intermediary.
2. **Request-bound group selection.** Each registration must
   reference a specific Bridge wallet-creation request; the
   request's seed (from the random beacon) deterministically
   selects the operator group authorized to run that DKG; any
   submission whose claimed members don't match the seed-selected
   group is rejected.
3. **Liveness guarantee via pool lock.** The group composition
   is fixed at selection time. The sortition pool is `lock()`'d
   from seed callback until DKG approval; while the lock is
   held, no operator can leave the pool or have a settled stake
   change (any in-flight `updateOperatorStatus` calls revert
   during the lock window). After approval, the pool is
   unlocked and operators can leave normally — but by then the
   wallet is registered. The `isOperatorInPool` re-check at
   submission is defense-in-depth, not the primary mitigation
   (see the threat matrix for the full discussion).
4. **Cross-chain + cross-deployment replay safety.** A registration
   attestation valid on one (chain, Bridge, registry) tuple MUST
   NOT be replayable on another.
5. **No double registration.** A given `xOnlyOutputKey` registers
   at most once.
6. **No front-running risk.** Whoever submits the bundle is
   irrelevant once all on-chain checks pass; the on-chain effect
   is identical regardless of submitter.
7. **Bridge surface unchanged.** Bridge enforces
   `msg.sender == self.frostWalletRegistry` on
   `__frostWalletCreatedCallback`; the registry contract is the
   address that satisfies that check. Bridge does not need to
   know how the registry authenticated the submission.

## Non-goals

- The registry does NOT verify that the underlying FROST DKG
  protocol was executed honestly. That is Phase B-2's responsibility
  (keep-core's on-the-wire DKG protocol). The registry only verifies
  that the group key that emerged from DKG consents to being
  registered for use as a Bridge wallet.
- The registry does NOT manage operator-membership of the FROST
  signing group. That is a Phase B-2 / sortition-pool concern.
- The registry does NOT handle wallet lifecycle (close, slash,
  termination) — that's Phase A (#434) + the existing Bridge
  lifecycle paths.
- **Bridge integration is OUT OF SCOPE for B-1.** Routing
  `Bridge.requestNewWallet` to the FROST registry is C-2's
  responsibility (PR #438, scheme-preference RFC). B-1 ships the
  registry contract + its `requestNewWallet()` entry point + the
  one-time wiring via `Bridge.setFrostWalletRegistry` (already in
  place from #431). The registry's `requestNewWallet()` is
  unreachable from Bridge until C-2 ships AND governance flips
  `currentNewWalletScheme` to FROST. This is intentional — it
  lets B-1 deploy + be unit-tested + be reviewed in isolation
  without disturbing the current ECDSA-only request flow.

## Trust model: request-seed-bound DKG with operator quorum attestation

The proposal: B-1 is a FROST-flavored port of the existing
`keep-network/ecdsa/WalletRegistry`. The state machine and the
binding between request and signers are identical to ECDSA's; only
the DKG protocol and the result shape differ (xOnlyKey vs. (X, Y)
pubkey, FROST DKG vs. ECDSA DKG).

### The state machine

1. **Request** — Bridge governance / a wallet maintainer calls
   `Bridge.requestNewWallet(...)`. Bridge calls the FROST
   registry's `requestNewWallet()`. The registry triggers the
   random beacon for a fresh entropy seed, transitions to
   `AwaitingSeed`, and locks the sortition pool so no
   operator can join/leave during the in-flight DKG.
2. **Seed callback** — the random beacon eventually calls
   `__beaconCallback(uint256 entry, uint256 entryBlock)` on the
   registry. The registry stores the seed +
   `selectedGroup = sortitionPool.selectGroup(GROUP_SIZE, seed)`
   and transitions to `AwaitingDkgResult`. From this point the
   set of operators authorized to attest this DKG is fixed.
3. **Off-chain DKG** — the operators in `selectedGroup` run the
   FROST DKG off-chain (Phase B-2's responsibility). They agree
   on an `xOnlyOutputKey`. A coordinator (any member of the
   group) collects ECDSA signatures from each participating
   operator over the DKG result digest (defined below).
4. **Submission (optimistic)** — within the DKG submission
   window (`dkgResultSubmissionTimeout` blocks from seed
   callback), any operator from `selectedGroup` calls
   `submitDkgResult(DkgResult)`. Submission is **optimistic**:
   the registry stores the result + records the submitter
   after light submitter-precondition checks (msg.sender is
   the claimed submitter member, submitter is an in-pool
   operator, submission deadline not passed, optionally the
   fail-fast already-registered-key check) and transitions
   into the challenge window. **Full member-array,
   signature-bundle, threshold, seed-binding, and digest
   validation happen via the challenge path**, not at submit
   time — this mirrors the upstream ECDSA WalletRegistry
   lifecycle B-1 ports. The motivation: any
   malformed/fraudulent result becomes a no-cost free option
   to grief the submitter (who paid gas for an unrecoverable
   revert); making submit cheap + slashing in challenge
   inverts the incentive.
5. **Challenge window** — for
   `dkgResultChallengePeriodLength` blocks, anyone can call
   `challengeDkgResult(DkgResult)` to dispute a malformed or
   fraudulent submission. The challenger runs the full
   validation (member array matches `selectedGroup`,
   signature bundle hits threshold over the v4 digest,
   signing-member-indices are strictly ascending + unique,
   etc.); a successful challenge slashes the malicious
   submitter and reverts the registry to
   `AwaitingDkgResult` (or to `Idle` if the timeout has
   passed).
6. **Approval** — after the challenge window, any operator
   calls `approveDkgResult(DkgResult)`. The registry runs
   the equivalent of an unchallenged optimistic acceptance:
   it does NOT re-run the full challenge validation (an
   honest challenger would have already done so during the
   window); it confirms the stored result matches the
   submitted one + the lifecycle preconditions (lifecycleOwner
   wired, state == CHALLENGE), then marks the wallet as
   registered, unlocks the sortition pool, and calls
   `Bridge.__frostWalletCreatedCallback(xOnlyOutputKey)`.
7. **Timeouts** — `notifySeedTimeout()` and
   `notifyDkgTimeout()` recover from a stalled beacon or a
   group that fails to submit; both reset the registry to
   `Idle` and unlock the pool.

The state machine is identical to ECDSA `WalletRegistry`'s in
shape; the only deltas are the result-struct fields, the DKG
protocol, and the on-chain callback name.

### Why this corrects the v1 + v2 mistakes

- **v1's bug** was self-authentication: any attacker keypair
  could sign for itself. Fixed in v2 by requiring operator
  signatures.
- **v2's residual bug** was that ANY threshold of operators
  could attest to ANY xOnlyKey; the registry didn't verify that
  the attesting operators were the group authorized to run that
  specific DKG. **v3 fixes this by computing `selectedGroup`
  on-chain from the request seed.** Only the seed-selected group
  can produce a valid attestation; any other set of operators is
  rejected by the `members == selectedGroup` check **on the
  challenge path** (i.e., `challengeDkgResult` succeeds and
  slashes the submitter), per the optimistic-submission
  lifecycle described above. The check itself is binding —
  the only difference vs. an eager-submission design is WHO
  bears the gas cost (challenger pays; submitter gets slashed)
  and WHEN the chain learns the result is bad (challenge-
  window detection rather than submit-time revert).

### DKG result message format

Each `selectedGroup` operator that participated in DKG signs the
result digest. Final wire encoding (EIP-191 personal-sign vs
EIP-712 typed-data) is an implementation detail; semantically:

```
result_digest = keccak256(abi.encode(
    "tbtc-frost-dkg-result-v1",                  // string domain tag
    block.chainid,                                // uint256
    address(bridge),                              // address
    address(this),                                // address (registry binding)
    seed,                                         // uint256 (binds to specific request)
    xOnlyOutputKey,                               // bytes32 (the produced wallet key)
    keccak256(abi.encode(members)),               // bytes32 (selected-group commitment)
    keccak256(abi.encode(misbehavedMembersIndices)) // bytes32 (reward-ban commitment)
))
```

Properties:

- `chainid + address(bridge) + address(this)` bind the digest
  to this exact deployment tuple (cross-chain / wrong-Bridge /
  wrong-registry replay protection).
- `seed` binds to the specific Bridge wallet-creation request;
  reusing this digest for a different request is impossible.
- `xOnlyOutputKey` is the wallet's identity.
- `keccak256(abi.encode(members))` commits to the selected-group
  composition; the registry recomputes `selectedGroup` on-chain
  from `seed` and rejects if the submitted `members` array
  hashes to a different value.
- `keccak256(abi.encode(misbehavedMembersIndices))` commits to
  the operator-misbehavior list. Without this, a submitter could
  keep all signatures valid while editing the misbehaved list
  (false-positive ban operators or whitewash real misbehavior).
  Mirrors the ECDSA `WalletRegistry` digest construction.

The Phase B-2 keep-core coordinator computes this digest off-chain
(either by reading the registry's view or reimplementing the
formula) and collects each participating operator's ECDSA
signature over it.

## Contract surface (v5 — as shipped)

The v3 "diff from ECDSA WalletRegistry" framing held through
implementation; the deltas below describe both what v3
specified AND what the actually-shipped contract layered on
top during Codex review.

### Authority model (split during Codex P1 round on #441)

```solidity
contract FrostWalletRegistry is
  IRandomBeaconConsumer,
  IApplication,
  Governable,
  Reimbursable,
  Initializable
{
  // Set in initialize() to Bridge. Controls who can call
  // requestNewWallet(). Production: address(Bridge).
  IFrostWalletOwner public walletOwner;

  // Set separately via updateLifecycleOwner(addr) (governance-
  // callable, NOT one-time so router redeploys remain
  // possible). Controls who can call closeWallet() and
  // seize(). Production: address(BridgeLifecycleRouter).
  address public lifecycleOwner;

  modifier onlyWalletOwner() {
    require(
      msg.sender == address(walletOwner),
      "Caller is not the Wallet Owner"
    );
    _;
  }

  modifier onlyLifecycleOwner() {
    if (msg.sender != lifecycleOwner) {
      revert CallerIsNotLifecycleOwner();
    }
    _;
  }
}

```

Why split: close/seize calls come from the router
(`msg.sender == router`), not from Bridge. A single
`walletOwner` slot can't satisfy both the creation-side check
(Bridge) and the lifecycle-side check (router) even with
`walletOwner = Bridge` wired.

The Bridge-side registry interface therefore requires both
`requestNewWallet()` and `lifecycleOwner()`. The latter is not an
internal convention; it is part of the production compatibility
contract. `Wallets.requestNewWallet` and
`Wallets.registerNewFrostWallet` compare
`Bridge.lifecycleRouter()` against `FrostWalletRegistry.lifecycleOwner()`
and fail closed before DKG lock or wallet registration if they differ.
Any replacement FROST registry must expose the same public
`lifecycleOwner() returns (address)` getter and preserve this
authorization meaning.

### Activation guard

```solidity
function requestNewWallet() external onlyWalletOwner {
  if (lifecycleOwner == address(0)) {
    revert LifecycleOwnerNotSet();
  }
  dkg.lockState();
  randomBeacon.requestRelayEntry(this);
}

function approveDkgResult(DKG.Result calldata dkgResult) external {
  // Defense-in-depth: requestNewWallet already checks
  // lifecycleOwner != 0 before locking DKG, so by approve
  // time the lifecycle should be wired. BUT
  // updateLifecycleOwner is non-one-time — governance
  // COULD zero it mid-DKG — so re-check here to guarantee
  // no FROST wallet ever registers without an active
  // lifecycle path.
  if (lifecycleOwner == address(0)) {
    revert LifecycleOwnerNotSet();
  }
  // ... approval body ...
}

```

### Custom-error vocabulary

Representative errors used in the FROST registry surface. The list is
**illustrative, not exhaustive** — additions made after the RFC was
last reconciled (see the 2026-08-14 note below) are valid custom
errors even when they don't appear here, and tooling must decode
revert data rather than match names. Cross-environment revert
decoding relies on the selector, not the prose label:

```solidity
error LifecycleOwnerNotSet();
error OwnerAddressCannotBeZero();
error DkgNotIdle();
error EcdsaWalletIdIsZero();
error FrostWalletRegistryNotSet();
error CallerIsNotFrostWalletRegistry();
error FrostWalletIdIsZero();
error FrostWalletIdNotNative();
error FrostWalletIdCollidesWithLegacy();
error FrostWalletAlreadyRegistered();
error FrostWalletIdMissing();
error XOnlyOutputKeyIsZero();
error XOnlyOutputKeyIsLegacyAlias();
error XOnlyOutputKeyAlreadyRegistered();
error WalletNotRegistered();

```

> **(2026-08-14 canonical-mirror reconciliation):** The
> access-control modifiers `onlyWalletOwner` and `onlyLifecycleOwner`
> do NOT use custom errors — they use `require` strings
> (`require(..., "Caller is not the Wallet Owner")` for
> `onlyWalletOwner` and
> `require(..., "Caller is not the Lifecycle Owner")` for
> `onlyLifecycleOwner`). No `CallerIsNotLifecycleOwner()` /
> `CallerIsNotWalletOwner()` custom errors exist; the earlier
> drift note that claimed `onlyLifecycleOwner` reverted with
> `CallerIsNotLifecycleOwner()` was wrong, and that line has
> been dropped from the illustrative vocabulary above.
> `OwnerAddressCannotBeZero()` and `DkgNotIdle()` ARE shipped
> (added in the owner-setter hardening for finding #7 in the
> PR #971 remediation); `XOnlyOutputKeyAlreadyRegistered()`
> and `WalletNotRegistered()` are shipped in
> `FrostRegistryWallets.sol`. Cross-environment tooling must
> decode the revert selector, not match by prose label.

```solidity
function submitDkgResult(DKG.Result calldata dkgResult) external {
  // RFC v4 delta #4 (re-stated v5): fail-fast on already-
  // registered keys at SUBMIT time, not just at APPROVE
  // time. Without this, a stale-but-valid result enters
  // the challenge window and locks the DKG state machine
  // until timeout. The 5k-gas cost is paid by the
  // submitter; saves operators a full challenge-period
  // wait when off-chain coordinator views are briefly
  // stale.
  require(
    !registered[dkgResult.xOnlyOutputKey],
    "FROST wallet already registered"
  );
  wallets.validateXOnlyOutputKey(dkgResult.xOnlyOutputKey);
  dkg.submitResult(dkgResult);
}

```

### Bridge-side walletPubKeyHash derivation

The 32-byte canonical `walletID` IS the x-only output key.
Bridge also stores a 20-byte legacy alias for compatibility
with the existing `registeredWallets[bytes20]` mapping:

```
walletPubKeyHash = HASH160(0x02 || xOnlyOutputKey)
                 = RIPEMD160(SHA256(0x02 || xOnlyOutputKey))
```

The `0x02` prefix is the y-parity byte for the compressed-form
pubkey. Off-chain consumers (subgraph, SDK, relayer) must use
the same derivation when querying Bridge by pubKeyHash.

### Contract paths (as shipped)

```
contracts/tbtc-v2/contracts/frost-registry/
    FrostDkgValidator.sol         // result digest + signature verification
    FrostWalletRegistry.sol       // main contract; the 1303-LOC port
    api/
        IFrostWalletOwner.sol     // Bridge implements this
    libraries/
        FrostDkg.sol              // state machine
        FrostAuthorization.sol    // operator authorization + stake checks
        FrostInactivity.sol       // operator-inactivity claims (external library)
        FrostRegistryWallets.sol  // wallet validation helpers
```

The library split (Authorization vs. Inactivity vs. Wallets)
mirrors the keep-network ECDSA registry structure so future
audits can run side-by-side diffs.

## Contract surface (v3 — historical)

The original framing. Preserved for reviewers who want to
see what v3 specified vs. what the v5 reconciliation
above clarifies post-implementation.

B-1 implementation is a FROST-flavored port of
`@keep-network/ecdsa/contracts/WalletRegistry.sol`. Rather than
ship an unverified standalone sketch in this RFC, the contract
surface is documented as the diff from the ECDSA reference:

**Reused verbatim** from ECDSA WalletRegistry:

- DKG state machine (Idle / AwaitingSeed / Challenge / etc) and
  the parameters (`dkgResultSubmissionTimeout`,
  `dkgResultChallengePeriodLength`, `groupSize`, `threshold`,
  `seedTimeout`).
- Random beacon integration (`requestNewWallet`,
  `__beaconCallback`, `notifySeedTimeout`).
- Sortition pool integration (`selectGroup(uint256, bytes32)`,
  `lock()`/`unlock()`, `isOperatorInPool(address)`,
  `getIDOperator(uint32)`, `operatorToStakingProvider` mapping).
- DKG result lifecycle (`submitDkgResult` / `approveDkgResult` /
  `challengeDkgResult` / `notifyDkgTimeout`).
- Slashing harness for malicious submitters / challenge-window
  losers.

**FROST-specific deltas** vs the ECDSA reference:

1. `DkgResult` struct replaces `(publicKeyX, publicKeyY)` with
   `xOnlyOutputKey` (bytes32). Everything else (members,
   submitterMemberIndex, signing-member-indices, signatures,
   misbehavedMembersIndices) is identical to the ECDSA version.
2. The result digest the operators sign uses the v4 tag
   (`tbtc-frost-dkg-result-v1`) instead of the ECDSA tag,
   includes `address(this)` so a malicious deployment of the
   FROST registry can't replay an attestation produced for a
   different registry instance, AND includes
   `keccak256(abi.encode(misbehavedMembersIndices))` so the
   reward-ban list cannot be edited without invalidating the
   signature bundle.
3. Bridge callback target on approval is
   `Bridge.__frostWalletCreatedCallback(bytes32)` instead of
   `Bridge.__ecdsaWalletCreatedCallback(bytes32, bytes32, bytes32)`.
4. `registered[xOnlyOutputKey]` defensive guard layered on top
   of Bridge's own duplicate-registration check (same pattern
   #435 uses for fraudChallenges).

The implementation PR pulls the ECDSA WalletRegistry source
into the tbtc-v2 tree under a new path
(`contracts/tbtc-v2/contracts/bridge/FrostWalletRegistry.sol`),
applies the four deltas above, and ships it as a single
contract. No copy of the ECDSA registry is modified in place.

## Threat analysis (v4)

| Threat                                                                   | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attacker self-generates a Schnorr keypair and registers it (v1 bug)      | Operator signatures, not key-self-signatures; attacker has no on-chain operator address                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Any current-pool operators sign an arbitrary key (v2 bug)                | `members` must equal `selectGroup(GROUP_SIZE, seed)` for the request's seed; out-of-group operators don't count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Submitter swaps misbehaved list without invalidating signatures (v3 bug) | `keccak256(abi.encode(misbehavedMembersIndices))` in result digest; any edit invalidates every signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Forged operator signature                                                | ECDSA recovery; signature must recover to the OPERATOR address that the sortition pool maps the signing-member-index identifier to (via `sortitionPool.getIDOperator(memberID)`), NOT to a staking-provider address. `operatorToStakingProvider` is a separate operator-→-provider mapping consulted for staking/slashing accounting; it is not the signature-recovery target                                                                                                                                                                                                                                                                     |
| Sub-threshold collusion                                                  | `>= threshold` distinct signing-member indices required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Duplicate operator signature submission to clear threshold               | Strictly-ascending signing-member-indices enforced (same as ECDSA registry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Cross-chain replay                                                       | `chainid` in result digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Wrong-Bridge replay                                                      | `address(bridge)` in result digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Wrong-registry replay                                                    | `address(this)` in result digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Wrong-key replay                                                         | `xOnlyOutputKey` in result digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Wrong-members replay                                                     | `keccak256(abi.encode(members))` in result digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Wrong-misbehaved-list replay                                             | `keccak256(abi.encode(misbehavedMembersIndices))` in result digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Wrong-request replay                                                     | `seed` in result digest binds attestation to specific request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Operator unbonded between selection and DKG completion                   | **Primary:** sortition pool `lock()` during DKG prevents membership updates while the lock is held — operators physically cannot leave the pool until `unlock()`. **Defense-in-depth:** `isOperatorInPool(operator)` re-checked at submit time only (shipped `FrostDkg.approveResult` does NOT re-check pool membership — only `submitResult`'s submitter-precondition path does) to catch the bug case where the lock fails or is bypassed by a future sortition pool API change. The re-check by itself is NOT sufficient (would return true even for a stake-reduced operator while the lock is held); the lock is the load-bearing mitigation |
| Double-registration of same key                                          | `registered[walletID]` guard layered on Bridge's own collision check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Out-of-band registration without a Bridge wallet request                 | State machine — `submitDkgResult` reverts unless registry is in `AwaitingDkgResult` (only reachable via `requestNewWallet` → `__beaconCallback`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Malformed DKG result accepted                                            | Challenge window + slashing harness (inherited from ECDSA WalletRegistry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Coordinator declines to submit                                           | Anyone in `members` can submit + approve (no coordinator role on-chain)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| DKG stalls / beacon stalls                                               | `notifyDkgTimeout` / `notifySeedTimeout` reset registry to `Idle` + unlock pool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| FROST registry unreachable from Bridge before C-2 lands                  | Intentional. B-1's `requestNewWallet()` entry stays dead until C-2 ships + governance flips `currentNewWalletScheme` to FROST. Documented as a prerequisite, not a bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Malformed DKG result accepted                                            | Challenge window + slashing harness (inherited from ECDSA WalletRegistry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Slashing semantics under shipped authorization backend**                | **Canonical mirror (PR #971): the shipped `IFrostAuthorizationSource` is `FrostAllowlist.sol`, not a staking-backed `FrostAuthorization.sol`. `FrostAllowlist.reportMaliciousBehavior` (`FrostAllowlist.sol:217-228`) is a pure emit — `emit MaliciousBehaviorIdentified(notifier, _stakingProviders)` — with no on-chain weight or stake decrease. The "submitter's authorized stake decreased by the slashing amount" test assertion in §"Implementation plan" item 5 below only holds for a hypothetical staking-backed `IFrostAuthorizationSource` implementation, not the one deployed by this PR. Under `FrostAllowlist`, a successful `challengeDkgResult` emits the malicious-behavior event but does NOT reduce the submitter's on-chain weight; the DAO must act on the event off-chain. See §"Authorization source: `FrostAllowlist` (canonical mirror)" above for the broader threat-model reconciliation.** |
## Open design considerations (v3)

1. **Implementation strategy: port vs. inherit.** B-1 mirrors the
   ECDSA `WalletRegistry` state machine; the question is whether
   to (a) copy the contract into the tbtc-v2 tree and apply
   FROST deltas in-place, or (b) inherit from an abstract base
   shared with ECDSA. **Recommendation:** copy. The two
   contracts will diverge slowly over the FROST lifecycle (Phase
   D ECDSA retirement might delete the ECDSA registry entirely);
   sharing a base creates lockstep coupling we don't want.
   Copy + adapt is the same pattern keep-network projects already
   use for similar parallel deployments.

2. **GroupSize / threshold.** ECDSA `WalletRegistry` uses
   `groupSize = 100` and `groupThreshold = 51`. **Recommendation:**
   same defaults for FROST so operators don't have to maintain
   different bonding amounts per scheme. Phase B-2 design may
   surface FROST-specific reasons to diverge; revisit then.

3. **DKG result struct shape.** ECDSA's
   `DkgResult { submitterMemberIndex, groupPubKey (64B), misbehavedMembersIndices, signatures, signingMembersIndices, members, membersHash }` ports directly to FROST by replacing
   `groupPubKey (64B)` with `xOnlyOutputKey (32B)`. Every other
   field has identical semantics. **Recommendation:** port the
   struct as-is, swap only the key field.

4. **Domain-separation tag.** v3 uses
   `"tbtc-frost-dkg-result-v1"`. If the result struct or wire
   format ever changes, bump to `v2` so old signatures cannot
   be replayed against a `v2`-aware registry. **Recommendation:**
   version-pin from day one.

5. **Upgrade path.** Bridge sets the registry once via
   `setFrostWalletRegistry`. To replace the registry, Bridge
   must be upgraded. The registry is stateful (DKG in-flight,
   `wallets` mapping, `registered` mapping). A replacement
   registry needs a migration path equivalent to ECDSA's
   migration story. **Recommendation:** make state public
   (mappings auto-generate getters) so a future replacement can
   read the prior state via cross-contract calls during a
   one-time governance migration helper, same pattern as
   #435's `migrateLegacyFraudChallenges`.

6. **Sortition pool sharing vs. separate pool.** ECDSA and FROST
   could share one sortition pool (operators are the same
   physical entities) or have separate pools. **Recommendation:**
   share. Phase D (ECDSA retirement) eventually deletes the
   ECDSA registry; the pool migrates to FROST-only. Splitting
   pools mid-migration creates operator-onboarding friction.

7. **Phase B-2 coordination.** The keep-core coordinator must:
   - Listen for `Bridge.NewWalletRequested` + the registry's
     `DkgStarted(uint256 seed)` event (emitted from
     `__beaconCallback` once the random beacon delivers the
     seed) to know when DKG should start. Note: the ECDSA
     registry uses this exact event name; the FROST port
     mirrors it. (Earlier drafts of this RFC named the event
     `DkgResultSubmissionStarted`; that name does not exist
     on the ported surface.)
   - Read `selectedGroup` from the registry view + run the FROST
     DKG protocol off-chain among those operators.
   - Compute the v4 result digest via the registry's
     `FrostDkgValidator.resultDigest(...)` view (or reimplement
     the formula — see §"DKG result message format". The v4
     digest includes `keccak256(abi.encode(misbehavedMembersIndices))`;
     a v3-shaped reimplementation that omits the misbehaved
     hash will produce signatures that fail challenge-path
     verification — `submitDkgResult` would accept them
     optimistically, but any honest challenger calling
     `challengeDkgResult` (or an off-chain consumer running
     `FrostDkgValidator.validateSignatures(...)` directly)
     would detect the digest mismatch, slashing the
     submitter).
   - Collect each participating operator's ECDSA signature over
     the digest.
   - Any operator in `selectedGroup` calls
     `submitDkgResult(DkgResult)`. After the challenge window,
     any of them calls `approveDkgResult(DkgResult)`.
     No new cryptographic primitive vs. the existing ECDSA DKG
## Authorization source: `FrostAllowlist` (canonical mirror)

Per the 2026-08-14 multi-agent review, the canonical mirror
(PR #971) does NOT deploy `FrostAuthorization`-style sortition-
pool staking. The shipped `IFrostAuthorizationSource`
implementation is `FrostAllowlist.sol`, which replaces token
staking for FROST operator authorization. Per its header
comment, "beta operators are selected by the DAO-maintained
allowlist". The threat model in this RFC (Sybil resistance,
collusion, slashing economics) is therefore stated for the
staking-backed `FrostAuthorization` reference, but the shipped
authorization backend behaves differently:

- **DAO-key compromise.** `FrostAllowlist` is `Ownable2StepUpgradeable`
  with the owner holding the weight table (`stakingProviders`).
  A compromised DAO key can weight any operator to zero (or
  remove them entirely). The on-chain surface accepts whatever
  weight the owner writes; there is no governance timelock or
  multi-sig in the contract itself.
- **Allowlist griefing.** Operators can be added with weight 0
  (so `isOperatorUpToDate()` returns false), excluded from the
  sortition pool, or removed entirely. There is no on-chain
  rate limit or audit log beyond the standard `OwnershipTransferred`
  event.
- **No on-chain stake to seize.** `reportMaliciousBehavior`
  (`FrostAllowlist.sol:217-228`) is a pure emit —
  `emit MaliciousBehaviorIdentified(notifier, _stakingProviders)`
  — with no weight decrease. See "Slashing semantics (canonical
  mirror)" below for the consequence.
- **Timelock / governance delay.** None on the contract itself;
  relies entirely on the timelock contract that owns the
  `FrostAllowlist` instance.

The activation runbook MUST treat the DAO-key compromise and
allowlist-timelock questions as primary governance risks, not
staking-economics risks. Until the activation runbook is
reconciled to the `FrostAllowlist` model (rather than the
staking-attested `FrostAuthorization` model), this RFC's
threat model below is incomplete.

## Activation runbook — Post-conditions (2026-08-14 addendum)

Per the 2026-08-14 multi-agent review, the activation runbook
MUST include a post-conditions section that reads cross-contract
wiring state after each step and aborts if the wiring is
inconsistent. Concretely, after each governance call:

- After `Bridge.setFrostWalletRegistry(registry)`: confirm
  `Bridge.frostWalletRegistry() == registry`.
- After `Bridge.setLifecycleRouter(router)`: confirm
  `Bridge.lifecycleRouter() == router`.
- After `FrostWalletRegistry.updateLifecycleOwner(router)`:
  confirm `FrostWalletRegistry.lifecycleOwner() == router`.
- **Cross-attestation view:** the canonical activation runbook
  SHOULD add a `FrostWalletRegistry.lifecycleOwnerIsWired()`
  view (a follow-up to the registry contract; see the M24
  structural-fix tracker) that returns `true` iff
  `lifecycleOwner != address(0)` AND
  `Bridge.lifecycleRouter() == lifecycleOwner`. Until that view
  ships, the activation runbook reads both fields directly and
  asserts they match before any further step.
- After any of the above: confirm the previous step's `onlyGovernance`
  emit landed (e.g. `LifecycleOwnerUpdated(address)` from
  `FrostWalletRegistry.updateLifecycleOwner`) and that no
  intermediate transaction has rewritten the value to zero or
  to a stale address. **The current `LifecycleOwnerUpdated` event
  in `FrostWalletRegistry.sol:259` emits only the new value, not
  the old value; off-chain tooling cannot detect zero-clobber or
  rewiring.** Operators SHOULD read the live
  `FrostWalletRegistry.lifecycleOwner()` view after every
  `LifecycleOwnerUpdated` log to detect rewiring. The activation
  runbook MUST abort on any non-monotonic / unexpected
  `lifecycleOwner()` change.

The canonical `bridge-lifecycle-router-followup-plan.md`
activation sequence (deploy router → `setLifecycleRouter` →
`updateLifecycleOwner` → verify all three views match) is the
authoritative reference; this section captures the
post-condition assertions that must accompany each step.
## Implementation plan (v3)

1. **Copy + adapt the ECDSA registry.** Copy
   `@keep-network/ecdsa/contracts/WalletRegistry.sol` (and its
   helper libraries — `DKG.sol`, `DkgValidator.sol`,
   `Wallets.sol`, `EcdsaInactivity.sol`, etc.) into the
   tbtc-v2 tree under
   `contracts/tbtc-v2/contracts/frost-registry/`. Apply the four
   FROST deltas listed in "Contract surface" above:
   - `DkgResult` field rename: `groupPubKey` → `xOnlyOutputKey`.
   - Result digest tag swap + `address(this)` inclusion.
   - Bridge callback target swap.
   - `registered[xOnlyOutputKey]` guard.
2. **B-1 deploys and wires the registry; Bridge scheme-routing
   is C-2's responsibility (PR #438).** B-1's deliverable is the
   `FrostWalletRegistry` contract + its `requestNewWallet()`
   entry point + the one-time wiring via
   `Bridge.setFrostWalletRegistry` (already added by #431).
   The registry's `requestNewWallet()` is unreachable from
   Bridge in the current base — `Wallets.requestNewWallet` still
   calls `self.ecdsaWalletRegistry.requestNewWallet()`
   unconditionally. C-2 introduces the scheme branch that
   routes to either registry based on
   `currentNewWalletScheme`. Until C-2 ships AND governance
   flips the scheme to FROST, B-1 sits deployed-but-dead from
   Bridge's perspective. Unit testing during B-1 review uses
   direct registry calls (or a thin test harness that mimics
   what C-2 will eventually do); production exercise waits
   for C-2.

   The seed-and-group binding lives entirely inside the
   registry (just as it does for ECDSA); Bridge doesn't need
   to know about seeds, beacon callbacks, or group selection.

3. **B-1 deploy script.** Mirror #435's
   `44_deploy_ecdsa_fraud_router.ts` pattern but for the
   FROST registry. Tag `"FrostWalletRegistry"`, depends on
   `Bridge`, `SortitionPool`, and `RandomBeacon`.
   `BridgeGovernance.setFrostWalletRegistry` (PR #431) is
   already in place; no change.
4. **B-1 unit tests** (mirror the ECDSA registry's test
   coverage, swapping FROST-specific paths). The submission
   lifecycle is OPTIMISTIC: only `submitDkgResult`-level
   precondition checks (msg.sender is the claimed submitter
   member, submitter is an in-pool operator, state is
   `AwaitingDkgResult`, deadline not passed, plus the
   x-only-key-shape and already-registered-key fail-fast
   guards) revert at SUBMIT time. Full member-array,
   threshold, signature-bundle, seed-binding, digest, and
   replay checks live on the CHALLENGE path. The expected
   tests below reflect that split:

   **Submit-time reverts** (true submit-level guards):

   - Invalid x-only key shape (all-zero, or high-12-bytes-
     zero legacy alias) → `submitDkgResult` reverts with
     `XOnlyOutputKeyIsZero` / `XOnlyOutputKeyIsLegacyAlias`.
   - Already-registered key → `submitDkgResult` reverts with
     `"FROST wallet already registered"` (fail-fast on top
     of the registered-key guard).
   - Submitter not the claimed member / not in pool / wrong
     state → `submitDkgResult` reverts at the upstream
     precondition checks.

   **Happy path** (no challenge):

   - Request → seed → submit → window elapses → approve →
     Bridge callback fires + wallet registered.

   **Challenge-detected slashing** (full validation): each
   case below submits SUCCESSFULLY (because submission is
   optimistic — the registry only runs the precondition
   checks at submit). The bad result enters the challenge
   window. An honest challenger calls `challengeDkgResult`,
   which runs the full validation, slashes the submitter
   via the staking-application slashing harness, emits
   `DkgResultChallenged`, and resets the registry to
   `AwaitingDkgResult` (or to `Idle` if the submission
   deadline has passed). `challengeDkgResult` has no return
   value on the shipped contract; the test asserts:
   `submitDkgResult` tx succeeds + `challengeDkgResult` tx
   succeeds (does not revert) + `DkgResultChallenged` event
   is emitted + the submitter's authorized stake decreased
   by the slashing amount + the registry's
   `getWalletCreationState()` is back to
   `AwaitingDkgResult`/`Idle`. Cases:

   - Sub-threshold signatures.
   - Member not in `selectedGroup`.
   - Wrong `seed` in digest.
   - Wrong `xOnlyOutputKey` in digest (different from the
     submitted struct field).
   - Wrong `members` hash in digest.
   - **Wrong `misbehavedMembersIndices` hash in digest**
     (v4-added; covers the case where a submitter edits
     the misbehaved list after signature collection).
   - Cross-chain / wrong-Bridge / wrong-registry replay.

   **Operator-membership invariant** (separate test, not
   submit/challenge):

   - Mid-DKG operator unbond attempt blocked by pool
     `lock()` → test that `updateOperatorStatus` reverts
     during the DKG window. (The `isOperatorInPool` re-check
     at submission is defense-in-depth, not the primary
     lock; the test verifies the actual lock-blocked-
     unbond behavior.)
   - DKG timeout → `notifyDkgTimeout` resets state, unlocks pool.
   - Seed timeout → `notifySeedTimeout` resets state.
   - Successful challenge of malformed submission → slashes
     submitter, reverts to `AwaitingDkgResult`.
   - **C-2-not-yet-shipped state** (v4-added): on a Bridge
     without C-2, verify the registry can be deployed + wired
     via `setFrostWalletRegistry`, and that
     `registry.requestNewWallet()` from an unprivileged caller
     reverts (only Bridge can initiate). This locks down the
     "B-1 unreachable until C-2" invariant.

5. **B-1 fixture wiring.** Extend `test/fixtures/bridge.ts` to
   deploy the registry with the existing sortition pool +
   random beacon, then call
   `bridgeGovernance.setFrostWalletRegistry`. Integration
   tests will need a fake beacon (same pattern the integration
   `Slashing.test.ts` already uses via
   `test/integration/utils/fake-random-beacon.ts`).
6. **Phase B-2 coordination spec.** Phase B-2's deliverable
   documents the keep-core coordinator side: listen for
   `NewWalletRequested` + `DkgStarted(uint256 seed)` (NOT
   `DkgResultSubmissionStarted` — see Open Considerations #7
   for the corrected event name), read `selectedGroup` from
   the registry view, run FROST DKG among those operators,
   compute the v4 result digest (includes
   `keccak256(abi.encode(misbehavedMembersIndices))` —
   NOT v3, which omitted that field), collect ECDSA
   signatures from each participating operator over the
   EIP-191-prefixed digest, and `submitDkgResult`. Then
   `approveDkgResult` after the challenge window.
7. **Cutover.** Once both B-1 and B-2 land, governance calls
   `BridgeGovernance.setFrostWalletRegistry(registry.address)`
   to wire the registry to Bridge. Until then,
   `Bridge.__frostWalletCreatedCallback` reverts with
   `FrostWalletRegistryNotSet`.

## Activation runbook (v5 — as shipped)

The v3/v4 plan above said "wire the registry via
`setFrostWalletRegistry`" as a single step. The actually-
shipped activation has three governance calls that MUST run
in this order to avoid orphaning a Live wallet without a
lifecycle dispatcher:

1. `BridgeGovernance.setFrostWalletRegistry(registry.address)`
   — one-time setter. Bridge now knows about the registry.
   The registry's `walletOwner` was set to `Bridge` in
   `initialize()`, so `onlyWalletOwner` on
   `requestNewWallet()` is satisfied as soon as Bridge can
   forward calls.
2. `frostWalletRegistry.updateLifecycleOwner(routerAddr)` —
   wires the lifecycle dispatcher. Until this is set,
   `requestNewWallet()` reverts early with
   `LifecycleOwnerNotSet()` (cannot kick off a DKG that
   would produce an orphaned wallet).
3. `BridgeGovernance.setLifecycleRouter(routerAddr)` — the
   Bridge-side mirror so `Wallets.registerNewFrostWallet`
   passes its own `LifecycleRouterNotSet()` guard at the
   point of FROST wallet creation.
4. (Once C-2 has shipped) `BridgeGovernance.setNewWalletScheme(Frost)`
   to flip the scheme dispatcher.

Production ordering across the four steps doesn't strictly
matter for safety — every step has its own guard, and any
out-of-order sequence reverts cleanly — but the documented
order minimizes "we set X but forgot Y" incidents during
governance ceremonies.

## Approval needed

Approve the v4 trust model (request-seed-bound DKG with the
selected-group + operator-quorum attestation, mirroring the
ECDSA `WalletRegistry` state machine), the v4 digest format
(adds `misbehavedMembersIndices` hash), AND the explicit
out-of-scope note for the Bridge scheme-routing change
(deferred to C-2 / PR #438)? If yes, the implementation PR
drops a FROST-flavored port of the ECDSA registry per the
contract-surface section.
