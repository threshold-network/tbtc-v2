# P2TR Signature Fraud Execution Spec

Date: 2026-05-20
Author: Codex
Status: Draft; not approved for production activation

## Purpose

This document turns the P2TR signature-fraud model from
`docs/reviews/schnorr-taproot-fraud-model-decision-2026-05-19.md` into a
reviewable execution plan with durable names for the code and vector artifacts.

The signature-fraud model preserves the current production ECDSA fraud model's
strongest property: an observed unauthorized wallet signature can open a fraud
challenge before the corresponding Bitcoin transaction is confirmed. For
P2TR/FROST wallets, that requires a production BIP-340 verifier, BIP-341
sighash reconstruction, watchtower payload extraction, Bridge lifecycle
integration, gas/DoS review, and external security review.

This spec does not activate P2TR/FROST wallets. It defines the gates that must
close before activation can be proposed.

## Current Production Constraint

`contracts/tbtc-v2/contracts/bridge/Fraud.sol` is an ECDSA-only fraud path. It
verifies an RSV signature over a double-SHA256 sighash and derives the wallet
identity from a compressed ECDSA public key HASH160. PR #404 adds fail-closed
guards so x-only Taproot keys and active wallets with non-legacy canonical IDs
cannot enter that legacy path, but the guards do not provide P2TR fraud
enforcement.

The prototype Schnorr verifier under
`contracts/tbtc-v2/contracts/prototypes/PrototypeCheckBitcoinSchnorrSigs.sol`
is not production BIP-340 verification and must not be wired into Bridge as-is.

`contracts/tbtc-v2/contracts/bridge/CheckBitcoinBIP340Sigs.sol` now seeds a
BIP-340-only verifier harness backed by the draft vector corpus. It is
correctness and gas-measurement evidence for the verifier feasibility phase, not
Bridge production wiring. `contracts/tbtc-v2/contracts/bridge/CheckBitcoinBIP341Sighash.sol`
now seeds annex-free key-path BIP-341 sighash reconstruction for the same draft
`SIGHASH_DEFAULT` and `SIGHASH_ALL` vector corpus, and
`contracts/tbtc-v2/contracts/bridge/CheckBitcoinP2TRSignatureFraud.sol`
combines the witness parser, BIP-341 sighash reconstruction, and BIP-340
verification behind one contract-facing harness with parameterized
payload-shape bound validation. `contracts/tbtc-v2/contracts/bridge/Bridge.sol`
now exposes a draft
`processP2TRSignatureFraudChallenge(uint8,bytes,uint32[])` entrypoint that
delegates to
`contracts/tbtc-v2/contracts/bridge/P2TRSignatureFraudLifecycle.sol` for
challenge submission, honest-spend defeat, and timeout/slashing while reusing
the existing `fraudChallenges` storage. The Bridge boundary accepts an
ABI-encoded structured payload to keep the Bridge implementation under the
EIP-170 size limit; the linked lifecycle library decodes and verifies the
payload. This is Bridge lifecycle integration seed evidence, not activation
approval: final fraud payload limits, full supported spend-type closure,
gas/DoS review, watchtower submission integration, and external security review
remain open.

## Non-Goals

- Do not activate production P2TR/FROST wallets from this spec alone.
- Do not accept confirmed-spend-only enforcement without explicit
  maintainer/governance acceptance of the weaker detection model.
- Do not support script-path Taproot spends until maintainers explicitly add
  them to the supported spend set and vector corpus.
- Do not treat passing prototype gas tests as production verifier approval.
- Do not count account-control/covenant P2TR or SIGHASH vector evidence toward
  this FROST/ROAST fraud-model closure; that work is tracked in a separate PR
  stack.

## Proposed Initial Scope

The first signature-fraud implementation should target P2TR key-path spends
only:

- BIP-340 x-only wallet public key equals the registered canonical wallet ID.
- BIP-341 key-path sighash is reconstructed on-chain for each supported tBTC
  wallet spend type.
- Supported sighash types are frozen before implementation. Any support beyond
  `SIGHASH_DEFAULT` or `SIGHASH_ALL` needs a separate rationale and vectors.
  `SIGHASH_ALL` remains in the draft candidate set because the current legacy
  Bridge fraud defeat path requires it and existing SDK wallet/deposit signing
  code uses it for protocol-controlled spends.
- Annex, script-path spends, leaf versions, and control blocks are out of scope
  unless the spec is updated before implementation.

Spend types that must be either supported or explicitly rejected:

- deposit sweep;
- moving-funds sweep;
- moved-funds sweep;
- redemption;
- wallet closing;
- heartbeat-like off-chain signer messages, if maintainers want the same
  non-Bitcoin-message defeat path as the ECDSA flow.

## Spend-Type Closure Matrix

The vector freeze must cover the actual Bridge flows that can honestly defeat a
fraud challenge. A generic single-input Taproot vector is not enough for
production activation.

| Flow                        | Existing Bridge classification path                                                                                                              | Required P2TR signature-fraud evidence                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deposit sweep               | `Bridge.submitDepositSweepProof` / `DepositSweep.submitDepositSweepProof` proves deposits were swept into the wallet main UTXO.                  | Key-path vectors for one and many deposit inputs, wallet output resolution through canonical `walletID`, sweep fee distribution fields, and defeat using the exact proved sweep transaction.                                         |
| Moving funds                | `Bridge.submitMovingFundsProof` / `MovingFunds.submitMovingFundsProof` proves a moving-funds transaction from a source wallet to target wallets. | Key-path vectors covering the source wallet input, target wallet output set, wrong target ordering, timeout/below-dust state interactions, and defeat only after the moving-funds proof is accepted.                                 |
| Moved-funds sweep           | `Bridge.submitMovedFundsSweepProof` / `MovingFunds.submitMovedFundsSweepProof` proves target wallets swept their moved-funds requests.           | Key-path vectors for the sweeping wallet input, request lookup, output-to-wallet resolution, duplicate or stale request rejection, and defeat only after the moved-funds sweep proof is accepted.                                    |
| Redemption                  | `Bridge.submitRedemptionProof` / `Redemption.submitRedemptionProof` proves pending redemption requests were fulfilled.                           | Key-path vectors covering one and many redemption outputs, optional change, wrong redeemer output, fee-boundary cases, timed-out redemption interaction, and defeat only after the redemption proof is accepted.                     |
| Wallet closing              | `Wallets` begins and finalizes closing as Bridge state, not as a standalone Bitcoin transaction class.                                           | Either explicitly reject standalone wallet-closing signature evidence or tie closing defeat coverage to the signed spend type that empties or moves the wallet before closing. The chosen rule must be documented before activation. |
| Heartbeat/off-chain message | `Fraud.defeatFraudChallengeWithHeartbeat` defeats an ECDSA challenge using a non-Bitcoin heartbeat message.                                      | Either add a BIP-340 heartbeat message domain with vectors and replay protection, or explicitly remove heartbeat-style defeat from the P2TR fraud model.                                                                             |

Every row needs positive vectors, negative mutation vectors, Bridge lifecycle
tests, and watchtower extraction/idempotency coverage before the row can be
marked complete. Rows not supported in the first production release must be
fail-closed by policy and documented as unsupported.
The machine-readable closure manifest
`docs/frost-migration/p2tr-signature-fraud-spend-type-closure.json` records the
current seeded/fail-closed/open status for each spend type and is checked by
`scripts/formal/check_p2tr_spend_type_closure.mjs` so shared Bridge state gates
cannot be mistaken for production flow-specific closure. Moving-funds and
redemption currently share the `spentMainUTXOs` Bridge state gate, so the
manifest and vector corpus explicitly keep their flow-specific closure open
until per-flow vectors and proof-event correlation are added.

## Challenge Payload

The off-chain watchtower must be able to derive a deterministic challenge
payload from observed witness data. The Bridge implementation must reconstruct
the same message without trusting a caller-provided digest.

Minimum payload fields:

- canonical `walletID` / x-only P2TR output key;
- 64-byte BIP-340 signature and optional sighash byte, depending on the frozen
  supported sighash types;
- transaction version and locktime;
- input index signed by the challenged signature;
- all input outpoints;
- all input amounts;
- all input scriptPubKeys;
- all input sequence values;
- all outputs;
- sighash type;
- annex commitment or an explicit proof that no annex is present, if annexes
  are not categorically rejected by supported spend policy;
- spend-type hint used only for classification after signature verification.

Seeded challenge-key direction:

- The version-1 Bridge challenge identity is separated from the draft
  raw-transaction vector identity. It commits to the canonical signed
  authorization tuple: `walletID`, reconstructed BIP-341 sighash, 64-byte
  BIP-340 signature, and parsed sighash type. The reconstructed sighash already
  commits exactly the transaction fields selected by that BIP-341 mode. Fields
  deliberately left unsigned by flexible modes such as `SIGHASH_NONE`,
  `SIGHASH_SINGLE`, or `ANYONECANPAY` must not add identity entropy, because
  one valid signature must fund at most one challenge/deposit/reward record.
- The Bridge challenge key is then domain-separated with chain ID and Bridge
  contract address. This keeps the same Bitcoin witness evidence from colliding
  across deployments while avoiding reliance on an opaque raw transaction blob
  that the Bridge does not parse.
- This version-1 namespace is introduced before P2TR/FROST production
  activation, so the deployment plan assumes there are no open version-0 P2TR
  challenge records. If that assumption changes, activation requires an
  explicit version-0-to-version-1 record migration or cutover; the two identity
  namespaces must not be mixed for live challenges.

Payload decisions that must be frozen before implementation:

- The Bridge must reconstruct the BIP-341 message from structured transaction
  fields; callers must not provide a precomputed sighash as trusted input.
- The signed input must be identified by a bounded `uint32` index and the
  payload must include prevout metadata for every transaction input.
- Supported sighash encoding must distinguish `SIGHASH_DEFAULT` signatures with
  no trailing witness byte from explicit `SIGHASH_ALL` signatures. Any other
  sighash byte must be rejected before expensive verification work.
- Annex and script-path witnesses must be fail-closed unless the supported
  spend policy and vector corpus are explicitly expanded.
- The production challenge key must remain separated from the draft vector
  identity and use the canonical signed-authorization identity plus
  chain/Bridge domain. Any change to that tuple or either identity domain must
  update the Node, Rust, and Solidity vector gates before Bridge integration.
- Maximum transaction byte length, input count, output count, scriptPubKey
  length, witness signature length, and payload byte length must be configured
  and gas-measured before integration.

## Contract Responsibilities

The production Bridge path must:

- verify the wallet is registered and is in a challengeable state;
- verify the provided canonical `walletID` resolves to the wallet alias used by
  legacy Bridge accounting;
- reconstruct the BIP-341 key-path sighash from structured transaction fields;
- verify the BIP-340 equation against the registered x-only wallet key;
- reject unsupported sighash flags, annexes, script-path fields, malformed
  transaction data, unknown wallet IDs, and inactive wallets;
- store a domain-separated challenge record with deposit, timestamp, challenger,
  and resolved state;
- preserve or explicitly replace the existing defeat, timeout, slashing, and
  notifier reward lifecycle;
- defeat a challenge only when the spending transaction has already been proven
  and classified as an honest tBTC wallet spend;
- expose events that include the canonical `walletID`, reconstructed sighash,
  and spend outpoint or other selected challenge identity fields.

## Watchtower Responsibilities

The watchtower/operator side must:

- parse Bitcoin mempool and confirmed transactions for wallet-controlled P2TR
  inputs;
- extract the exact witness signature and sighash context required by the
  Bridge payload;
- reject unsupported script-path or annex forms before submitting a challenge;
- derive challenge identity deterministically and idempotently;
- persist submitted challenges, defeat observations, timeout eligibility, and
  operator alert state, including retry-limit alerts;
- plug challenge records into a durable store backend without changing
  observation, replay, and submission semantics;
- reject malformed serialized challenge-record state before restart replay or
  challenge submission;
- validate operator runtime configuration for state persistence, wallet IDs,
  Bridge/domain identity, Esplora transaction-source settings, Bridge lifecycle
  scan windows/cursors, polling, retry limits, and loop failure policy before
  starting service cycles;
- list unresolved operator alerts from the same durable record source used for
  replay;
- summarize challenge, Bitcoin, operator-alert, observation, and submission
  attempt states for service metrics, including ignored Bridge proof logs that
  did not match a stored challenge;
- run a caller-driven mempool/confirmed transaction-source cycle that replays
  persisted challenges before scanning new transactions and reports source
  failures separately from per-transaction failures;
- run a process-level service cycle with durable file-backed challenge-record
  persistence, restart replay, Bridge lifecycle event processing, and
  operator-facing cycle metrics;
- validate Bridge lifecycle event evidence against the stored watchtower
  observation when events include wallet ID, Bridge challenge identity, or
  reconstructed sighash fields, so a lifecycle event cannot resolve a challenge
  if the Bridge-emitted evidence disagrees with the observation record;
- correlate accepted `MovingFundsCompleted` and `RedemptionsCompleted` proof
  events by Bitcoin transaction hash and spend type to the stored watchtower
  observation, marking the record `defeat-eligible` without claiming the
  on-chain P2TR fraud challenge was defeated, while ignoring unrelated proof
  events that do not correspond to a stored challenge record;
- support observation-only service operation by default until production Bridge
  challenge submission is deployed, reviewed, funded, and explicitly approved;
- require a challenge submitter only when challenge submission is explicitly
  enabled;
- surface whether a challenge is signature-only evidence or is also attached to
  a confirmed Bitcoin transaction.

The existing `RedemptionWatchtower` wallet-ID safety and objection paths are not
P2TR signature-fraud watchtower coverage. They prove canonical wallet-ID
compatibility for redemption safety checks, but they do not observe Taproot
witnesses, reconstruct BIP-341 sighashes, submit signature-fraud challenges, or
track defeat/timeout/slashing state for P2TR fraud.

## Watchtower Extraction And Idempotency Matrix

The production watchtower slice is not complete until it has an implementation
and tests for each row below. These requirements apply to mempool observations
and confirmed transactions because the selected long-term model is intended to
preserve pre-confirmation signature accountability.

| Area                             | Required behavior                                                                                                                                                                                                                                                                                                                                                       | Acceptance evidence                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet input discovery           | Detect spends of registered P2TR wallet outputs by matching the key-path witness to the canonical x-only `walletID` and resolving any compatibility alias needed by Bridge accounting.                                                                                                                                                                                  | Tests cover registered wallets, unrelated P2TR spends, unknown wallet IDs, legacy wallets, and multiple wallet inputs in the same transaction.                                                                                                                                                                                         |
| Witness-form filtering           | Accept only frozen key-path forms and sighash encodings; reject script-path witnesses, annexes, missing signatures, malformed signature lengths, and unsupported sighash bytes before submission.                                                                                                                                                                       | Parser tests prove `SIGHASH_DEFAULT` without a witness sighash byte, explicit `SIGHASH_ALL`, and every unsupported form's fail-closed result.                                                                                                                                                                                          |
| Payload reconstruction           | Persist the raw transaction commitment, signed input index, full prevout map, output set, locktime/version, signature, selected sighash type, and reconstructed BIP-341 sighash.                                                                                                                                                                                        | Cross-language vectors prove the watchtower payload reconstructs the same sighash as the Bridge verifier for each supported spend type.                                                                                                                                                                                                |
| Challenge identity               | Derive one deterministic idempotency key from the canonical signed-authorization tuple (`walletID`, reconstructed BIP-341 sighash, 64-byte signature, and parsed sighash type), then bind it to the frozen chain/Bridge domain. Caller-provided representation fields outside the signature commitment must not fork identity.                                          | Duplicate observations of the same signed authorization produce one challenge attempt even if a flexible sighash permits different unsigned transaction fields. A changed wallet, chain/Bridge domain, signature, sighash, or parsed sighash type produces a distinct key; malformed or internally inconsistent payloads are rejected. |
| Submission idempotency           | Store pending, accepted, rejected, defeated, timed out, slashed, and rewarded states under the challenge identity. Retries must not fork state, double-submit deposits, or leave retry-limit failures invisible to operators.                                                                                                                                           | Tests cover duplicate mempool events, duplicate confirmed events, RPC retry after unknown transaction status, Bridge duplicate rejection, retry-limit operator alerts, and operator restart with persisted state.                                                                                                                      |
| Reorg and mempool churn          | Handle mempool eviction, rebroadcast, confirmation, and reorg without losing the original signature evidence or creating conflicting challenge records.                                                                                                                                                                                                                 | Tests simulate mempool-only evidence, confirmed evidence, eviction/reappearance, one-block reorg, and replacement by a transaction whose signature or prevout map differs.                                                                                                                                                             |
| Honest-spend correlation         | Correlate Bridge proof events for deposit sweep, moving funds, moved-funds sweep, redemption, and any approved closing/heartbeat rule with the matching challenge identity. Bridge lifecycle events that include wallet ID, Bridge challenge identity, or sighash evidence must match the persisted observation before the watchtower accepts the lifecycle transition. | Tests prove an honest spend defeats only the matching challenge and that wrong spend type, wrong output set, wrong prevout map, wrong wallet, or mismatched Bridge-emitted lifecycle evidence cannot defeat.                                                                                                                           |
| Timeout/slashing/reward tracking | Track challenge timeout eligibility, slashing outcome, notifier reward, and unresolved operator alerts.                                                                                                                                                                                                                                                                 | Tests cover timeout readiness, completed slashing/reward state, defeat-before-timeout, and stale alert clearing.                                                                                                                                                                                                                       |

Rows not implemented in the first release must be fail-closed or explicitly
operator-disabled. A watchtower that can parse candidate signatures but cannot
deduplicate, retry safely, or correlate defeat/timeout outcomes is not
production evidence for `GAP-12`.

## Vector Corpus

Before Solidity integration, add a canonical vector corpus under
`docs/frost-migration/test-vectors/`.

Current draft corpus:

- `docs/frost-migration/test-vectors/p2tr-signature-fraud-v0.json` contains
  six BIP-341 key-path positive cases: three baseline `SIGHASH_DEFAULT` spends covering
  single-input, non-uniform txid byte-order, and two-input/two-output shapes,
  one single-input `SIGHASH_ALL` spend, one draft moving-funds-shaped
  `SIGHASH_DEFAULT` spend, and one draft redemption-shaped `SIGHASH_ALL` spend.
  Each positive case also locks a
  draft challenge identity derived from the same raw transaction, prevout map,
  wallet ID, reconstructed sighash, and signature fields a watchtower would
  need to persist idempotently, plus a Bridge challenge identity derived from
  the structured verifier payload the Bridge can reconstruct. Each positive
  case includes the Taproot witness
  signature encoding the watchtower would parse: 64 bytes for implicit
  `SIGHASH_DEFAULT`, and 65 bytes with trailing `0x01` for explicit
  `SIGHASH_ALL`. The corpus policy fixes `annex` to `absent`, and the Solidity
  Bridge payload carries an explicit `annexPresent=false` field so contract
  tests can prove annex-present payloads fail at the BIP-341/Bridge boundary.
  The corpus also includes negative witness parser cases for an explicit `0x00`
  default byte, unsupported sighash byte, short signature, long signature, and a
  negative outpoint byte-order mutation. The conformance checks
  reject duplicate draft and Bridge challenge identities across positive cases.
  The two flow-shaped draft cases are marked with `flowMetadata` and remain
  open: they prove only Bitcoin sighash/signature commitment to moving-funds and
  redemption transaction shapes, while accepted Bridge proof-event correlation
  is still required before production approval.
- `sdk/tbtc-v2-ts/src/services/maintenance/p2tr-signature-fraud.ts` provides an
  initial TypeScript maintenance/watchtower parser primitive for the same
  witness signature encodings. It parses direct witness-signature payloads,
  extracts a selected input's key-path witness from a raw Bitcoin transaction,
  derives `walletID` from P2TR scriptPubKeys, discovers registered wallet
  inputs from the prevout map, ignores non-P2TR and unknown-wallet prevouts,
  reconstructs BIP-341 key-path sighashes with `bitcoinjs-lib`, rejects
  missing, annex, script-path, malformed-length, and unsupported sighash forms
  before challenge submission, resolves input prevout maps through the Bitcoin
  client, strips witnesses to recover the unsigned transaction payload covered
  by the draft challenge identity, marks extracted observations with an explicit
  `unclassified` spend type by default, exposes a caller-provided classifier
  seam for future Bridge-approved spend-type integrations, exposes optional
  payload-bound checks for raw transaction bytes, input/output counts, and
  scriptPubKey byte lengths before observation storage, computes the shared
  draft challenge identity locked by the Node/Rust/Solidity vector harnesses,
  computes a structured Bridge challenge identity from the same fields a Bridge
  verifier can reconstruct, derives a domain-separated Bridge challenge key
  from chain ID, Bridge address, and that Bridge identity, and uses that key as
  the durable observation, record, and submission-idempotency key when an
  embedding service provides the Bridge domain. Domainless observation mode
  instead derives a raw-evidence observation ID. Same-key record transitions
  are serialized within a store instance, and the observation selected for
  submission is bound atomically to its in-flight state. Confirmed flexible-
  sighash replacements add fixed-size Bitcoin transaction-hash/spend-type
  proof aliases without replacing that payload, while mempool-only variants do
  not grow the durable alias history. Legacy confirmed scalar metadata is
  imported into alias mode only when its transaction hash matches the stored
  raw transaction. Metadata-only confirmations similarly derive an alias from
  the stored observation only when its raw transaction hashes to the confirmed
  transaction ID; mismatches add no alias and remain fail-closed. The SDK also
  defines a serializable challenge-record store
  boundary and seeds a pure off-chain
  lifecycle reducer for observed, submitting, submitted, rejected,
  defeat-eligible, defeated, timeout-eligible, slashed, and rewarded challenge
  records, plus a store-backed ingest primitive for mempool and confirmed
  Bitcoin observations, standalone evicted/reorged states, separate
  replacement records when a reorged transaction reappears with a changed
  witness signature or prevout map, a submission-adapter seam that persists
  started, accepted, and rejected submission outcomes around an explicit
  challenge submitter, and a
  runner-facing observe-and-submit loop for mempool and confirmed transactions
  with an optional submission-attempt ceiling for retry budgets, retry-limit
  operator alerts, and settled batch processing that reports
  malformed-transaction failures without dropping valid submissions. It also
  exposes Bridge-observed lifecycle recording for honest-spend-proven,
  defeated, timeout-eligible, slashed, and rewarded outcomes, and persists the
  serialized observation payload needed for restart replay of observed,
  submitting, and rejected challenges from a durable record source. It also
  tracks open/acknowledged/cleared operator alerts against the same challenge
  record and lists unresolved operator alerts from the same durable record
  source. It also summarizes challenge, Bitcoin, and operator-alert counts for
  service metrics and runs a caller-provided mempool/confirmed
  transaction-source cycle that replays persisted challenges before scanning new
  transactions and reports source failures separately from malformed-transaction
  failures. It includes a
  runner-facing Bridge lifecycle event-source cycle for honest-spend-proven,
  defeated, timeout-eligible, slashed, and rewarded events, reporting per-event
  failures and source failures while refreshing summaries and unresolved alerts
  from the same durable record source. Challenge-resolution events can target
  either the observation ID or the stored Bridge challenge key; those values
  are identical in domain-bound mode. Key-only events are resolved through the
  durable record source and fail closed on unknown keys. Honest-spend proof
  events can instead target the Bitcoin transaction hash plus approved spend
  type; the resolver matches persisted confirmed proof aliases so a canonical
  record remains correlatable after flexible-sighash replacement. The resolver
  ignores transaction hashes that do not belong to any stored challenge and
  fails closed on duplicate records, wrong spend type for a stored transaction,
  or fail-closed spend-type matches. It also exposes an integrated source cycle
  that replays stored challenges, scans mempool/confirmed transaction sources,
  and applies Bridge lifecycle events before returning a single final summary.
  It includes a runtime-neutral serialized challenge store over caller-provided
  persistence so production services can back the same record/replay interface
  with a file, database, or key-value store without adding Node-only
  dependencies to the SDK. The bundled file-backed challenge-record persistence
  writes through an fsynced temporary file and rename before advancing its
  in-memory snapshot for single-process dry runs. Challenge submission now
  requires an explicit spend-type submission policy; the default policy allows
  no spend types, raises an operator alert instead of calling the submitter, and
  keeps unclassified, wallet-closing, and heartbeat evidence fail-closed until
  those policies are frozen. The service wrapper also rejects startup when
  challenge submission is enabled without any approved spend type.
  `contracts/tbtc-v2/contracts/bridge/P2TRSignatureFraud.sol`
  now centralizes the production Bridge challenge-key seed, Bridge challenge
  identity domain, and witness-signature parsing helpers. The draft Solidity
  challenge identity remains isolated in
  `contracts/tbtc-v2/contracts/prototypes/PrototypeP2TRSignatureFraud.sol` so
  production Bridge wiring cannot accidentally import the draft identity helper.
  `services/p2tr-signature-fraud-watchtower`
  now wraps the SDK runner in a production-service scaffold with file-backed
  durable persistence, one integrated cycle, restart-replay coverage, Bridge
  lifecycle event processing, operator-facing cycle metrics, and an
  abort-aware sequential polling loop that prevents overlapping cycles and
  exposes fail-fast versus continue-on-error policy, plus an env-shaped runtime
  config loader that validates state path, wallet IDs, Bridge/domain identity,
  Bridge lifecycle cursor block-hash validation for submission mode, polling,
  retry limits, and operator-alert settings before startup. The
  file-backed service boundary validates serialized challenge records before
  restart replay or challenge submission and rejects overwrites when the state
  file changed since the last load; a runtime factory wires the validated
  config into the file-backed service and loop options. SDK runner
  submission still requires both `submitChallenges` and an approved spend-type
  policy. Embedding services can provide a spend-type classifier before those
  policy checks, payload bounds before observation storage, and a Bridge
  challenge-key domain for stored observations. The SDK now includes a
  deterministic rule-composition helper for embedding approved spend-type
  classifiers: no matching rule leaves the observation `unclassified`, while
  ambiguous or unsupported rule results fail closed as invalid watchtower state.
  The environment-backed runtime
  can now install only the Bridge challenge domain from explicit chain ID and
  Bridge address variables; it still defaults to observation-only operation
  with unclassified and unfrozen-bound evidence unless challenge submission,
  classification, payload-bound approval, Bridge-domain approval, and
  spend-type approval are explicitly wired. Before a stored observation reaches
  a challenge submitter, the SDK/watchtower reconstructs the witness-derived
  observation under the configured Bridge identifier, spend-type classifier,
  payload bounds, and Bridge challenge domain; mismatches fail closed as invalid
  watchtower state. Submission startup now also fails closed unless explicit
  raw-transaction, input-count, output-count, and scriptPubKey byte bounds are
  configured, an approved spend-type classifier is installed, and the submission
  policy rejects `unclassified`, `wallet-closing`, or `heartbeat` spend types.
  Challenge submission also requires an explicit Bridge challenge domain so
  Bridge lifecycle events can be correlated by domain-separated challenge key,
  a submission-attempt ceiling and operator alert so retries cannot fail
  silently, and either a `transactional-production` indexing store profile or
  an explicit single-process rehearsal submission override. Resolved Bridge
  lifecycle states now clear stale open or
  acknowledged submission-attempt alerts on defeated, slashed, or rewarded
  challenges. No challenge submitter is required in observation-only mode. The
  environment-backed runtime now parses the four payload-bound variables as an
  all-or-none group before service startup. The service also now includes an
  Esplora-backed
  transaction source that derives P2TR wallet addresses from registered x-only
  wallet IDs, scans mempool and confirmed address transaction pages,
  deduplicates candidate transactions, and fetches raw transaction hex for the
  SDK runner. The environment-backed runtime config now parses Esplora base URL,
  Bitcoin network, timeout, retry, and confirmed-page settings, and a runtime
  factory can wire those settings plus the registered wallet IDs into the
  bundled Esplora transaction source for observation-mode rehearsals. The
  service also includes an Ethers-compatible Bridge lifecycle event source that
  reads `P2TRSignatureFraudChallengeDefeated` and
  `P2TRSignatureFraudChallengeDefeatTimedOut`, `MovingFundsCompleted`, and
  `RedemptionsCompleted` logs over a configured block range or a
  provider-derived confirmation-depth window, can enforce a maximum numeric
  block span per scan, normalizes on-chain `challengeKey` values to the
  watchtower's stored Bridge challenge key, and emits key-addressed defeated
  events plus default slashed and rewarded records for timeout logs from the
  Bridge transaction that resolves, slashes, and rewards. It maps
  completed moving-funds and redemption proof logs to `honest-spend-proven`
  records keyed by Bitcoin transaction hash and spend type; the SDK then marks
  the matching durable record `defeat-eligible`, preserving the distinction
  between accepted honest-spend proof and an on-chain P2TR challenge defeat.
  Proof logs without a matching stored challenge are ignored instead of counted
  as lifecycle failures, so cursor-backed scans can commit ordinary Bridge proof
  traffic. The process service reports ignored proof logs as an explicit cycle
  metric so operators can distinguish normal unrelated proof traffic from
  source or per-event failures.
  Embeddings can explicitly narrow timeout logs to a single `slashed` or
  `rewarded` status if an approved Bridge integration needs that behavior.
  Embeddings can provide a scan cursor store; cursor-backed scans require a
  maximum numeric block span and either a numeric `toBlock` or provider-derived
  confirmation-depth window so the durable cursor always has a bounded,
  committable upper block. Cursor-backed scans with more confirmed blocks
  available than `maxBlockRange` process one bounded window per cycle and
  commit that bounded upper block, so catch-up can proceed without disabling
  the range guard. The process service commits that cursor only after Bridge
  lifecycle events are listed and processed without source or per-event
  failures. If the durable cursor commit fails after event records are written,
  the service logs a cursor-commit failure and fails the cycle so the next run
  replays the uncommitted Bridge lifecycle window. Bridge lifecycle events are
  applied sequentially in source order so
  timeout logs that emit both slashing and reward records cannot race and drop
  either lifecycle field. Once a challenge is recorded as slashed, stale
  timeout or defeat events cannot move it backward; only the corresponding
  reward record can advance the lifecycle, and repeated observations cannot
  resubmit the already-slashed challenge while reward tracking is pending. The
  source can replay a configured cursor overlap window before the last scanned
  block for conservative reorg handling. Embeddings can also require cursor
  block hashes: when enabled, the source validates the loaded cursor's last
  scanned block hash before querying logs and commits the next cursor with the
  block hash of the bounded upper block, failing closed on stale or malformed
  cursor boundaries. The env-backed runtime requires that block-hash cursor
  mode whenever challenge submission is enabled. The env-backed runtime also
  refuses file-backed challenge submission unless an explicit
  `P2TR_SIGNATURE_FRAUD_WATCHTOWER_ALLOW_FILE_BACKED_SUBMISSION=true`
  single-process rehearsal override is set, so the bundled file-backed stores
  cannot be mistaken for production submission infrastructure. Direct service
  embedders hit the same startup guard unless they declare a
  `transactional-production` indexing store profile. The bundled file-backed
  challenge-record and cursor stores self-identify as
  `single-process-rehearsal`, and service startup rejects attempts to pair
  those stores with the `transactional-production` profile. Unmarked custom
  stores also fail the production profile; production embedders must provide
  challenge-record persistence and a Bridge lifecycle event source that both
  self-identify as `transactional-production` with the same non-empty
  transactional store ID.
  The environment-backed runtime config now parses those scan settings and a
  runtime factory can wire them into the Ethers-compatible source with a
  file-backed cursor store for single-process dry runs. A file-backed cursor
  store now persists `{ lastScannedBlock, lastScannedBlockHash? }`
  through an fsynced temporary file and rename, validates it before use, and
  rejects overwrites when the cursor file changed since the last load for
  single-process dry runs. It does not replace final production event-indexing,
  transactional cursor deployment, approved reorg recovery, or
  timeout-eligibility policy.
  `docs/operations/frost-roast-production-indexing-runbook-2026-05-21.md`
  defines the required production topology, transactional store contract,
  Bridge event coverage, reorg/backfill policy, failover, rollback, and
  evidence packet for that production indexing deployment.
  `docs/operations/frost-roast-production-indexing-evidence-v0.json` records
  the production indexing evidence gate and is checked by
  `scripts/formal/check_frost_production_indexing_gate.mjs` so file-backed
  single-process rehearsals cannot be counted as production indexing approval.
  `contracts/tbtc-v2/contracts/bridge/CheckBitcoinBIP340Sigs.sol`
  and `contracts/tbtc-v2/test/bridge/CheckBitcoinBIP340Sigs.test.ts` now seed a
  BIP-340-only Solidity verifier against the same positive and negative vector
  corpus, make the scalar multiplication loop's 256-bit bound explicit, and
  use Jacobian-coordinate scalar multiplication so field inversion is paid once
  at affine conversion rather than on every point add or double. The tests
  record first local gas measurements plus local gas regression ceilings for
  signature verification and sparse, high-bit, and dense scalar multiplication
  cases.
  `docs/frost-migration/p2tr-signature-fraud-spend-type-closure.json` now
  records the P2TR fraud spend-type closure state for `unclassified`, deposit
  sweep, moving funds, moved-funds sweep, redemption, wallet closing, and
  heartbeat. It keeps account-control/covenant work excluded from this
  FROST/ROAST scope, keeps unclassified/wallet-closing/heartbeat fail-closed,
  and marks flow-shaped vector evidence as draft seed evidence rather than
  production approval. The companion vector corpus now includes draft
  moving-funds and redemption case IDs while still naming the remaining
  Bridge-correlation and timeout vector families, so the shared
  `spentMainUTXOs` gate cannot appear complete.
  `contracts/tbtc-v2/contracts/bridge/CheckBitcoinBIP341Sighash.sol` and
  `contracts/tbtc-v2/test/bridge/CheckBitcoinBIP341Sighash.test.ts` now seed
  annex-free key-path BIP-341 sighash reconstruction for the same structured
  transaction, prevout, and output vectors, proving the reconstructed messages
  feed the BIP-340 verifier seed and change under transaction/prevout mutations.
  `contracts/tbtc-v2/contracts/bridge/CheckBitcoinP2TRSignatureFraud.sol` and
  `contracts/tbtc-v2/test/bridge/CheckBitcoinP2TRSignatureFraud.test.ts` now
  combine witness-signature parsing, BIP-341 sighash reconstruction, and BIP-340
  signature verification in a single contract-facing harness over the same
  corpus, computes the structured Bridge challenge identity over the verifier
  payload, and includes a parameterized payload-shape bound validator covering
  input count, output count, prevout count, signed input index, scriptPubKey
  byte length, annex absence, and witness encoding. The verifier payload carries
  an explicit `annexPresent` boundary flag and rejects it when true before using
  the no-annex BIP-341 sighash path.
  `contracts/tbtc-v2/contracts/bridge/P2TRSignatureFraudLifecycle.sol` and
  `contracts/tbtc-v2/test/bridge/Bridge.P2TRFrauds.test.ts` now wire the
  structured Bridge identity into existing Bridge fraud challenge storage,
  covering single-input submit, bounded multi-input/multi-output submit,
  duplicate rejection, unknown-wallet rejection, invalid wallet rejection,
  invalid BIP-340 signature rejection, Bridge entrypoint rejection for input,
  output, prevout-count, signed-input-index, and script-size bound violations,
  honest-spend defeat, unresolved-spend defeat rejection, timeout, refund, and
  wallet slashing in the Bridge fixture. The Bridge lifecycle tests now
  exercise each Bridge-recognized honest-spend state gate used by the legacy
  fraud model: swept deposit, spent main UTXO, and processed moved-funds sweep
  request. They also reject defeat attempts before any accepted honest-spend
  state exists, when only a different outpoint is marked honestly spent, and
  when a moved-funds sweep request is still pending or has timed out. The same
  Bridge fixture records a first local gas envelope for the bounded draft
  payload: submit `5,221,336`, honest-spend defeat `163,784`, and timeout
  `181,821`. It also records a bounded multi-input/multi-output submit gas
  envelope of `5,193,469`. The SDK now also exposes an
  Ethers-compatible Bridge challenge submitter that ABI-encodes the structured
  payload, calls
  `processP2TRSignatureFraudChallenge(0, payload, [], { value })`, waits for a
  configured confirmation depth, and routes reverted or unfinalized submissions
  through the existing rejected/retry path. This is
  parser, payload-reconstruction, storage-boundary, idempotency,
  service-boundary, BIP-340 verifier, BIP-341 sighash, combined verifier,
  contract-helper, Bridge lifecycle event-source, and Bridge lifecycle seed
  evidence only; it is not a final deployed multi-operator durable idempotency
  store, complete production Bitcoin/Bridge source-adapter set,
  production-approved payload limit freeze, gas/DoS-reviewed fraud payload
  implementation, or production-deployed Bridge challenge submission service.
- The corpus includes wrong-wallet, invalid x-only wallet key, wrong-message,
  wrong-signature, invalid nonce parity, tagged challenge mismatch, `r` field
  overflow, zero and overflow `s` scalar cases, wrong input amount, wrong input
  scriptPubKey, wrong input sequence, and wrong output ordering negative cases.

Required vector groups:

- BIP-340 verification:
  - valid signatures;
  - invalid x-only keys;
  - invalid nonce parity;
  - zero and overflow scalar cases;
  - wrong message;
  - wrong wallet ID;
  - tagged-hash mismatch.
- BIP-341 sighash reconstruction:
  - each supported spend type;
  - `SIGHASH_DEFAULT` and/or `SIGHASH_ALL`, depending on spec freeze;
  - multiple inputs;
  - multiple outputs;
  - wrong input amount;
  - wrong scriptPubKey;
  - wrong sequence;
  - wrong output ordering;
  - malformed or unsupported annex/script-path data.
- Bridge fraud lifecycle:
  - challenge submit;
  - duplicate challenge rejection;
  - honest-spend defeat;
  - defeat timeout;
  - slashing and notifier reward;
  - inactive wallet rejection;
  - replay across wallet IDs and chains.
- Watchtower extraction and idempotency:
  - registered and unrelated wallet inputs;
  - `SIGHASH_DEFAULT` and explicit `SIGHASH_ALL` witness parsing;
  - unsupported sighash, annex, script-path, and malformed witness rejection;
  - duplicate mempool and confirmed observations;
  - replay across wallet ID, chain/Bridge domain, input index, raw transaction,
    and prevout map commitments;
  - honest-spend defeat correlation and timeout/slashing state transitions.

Required independent implementations:

- Rust or Go generator using a maintained Bitcoin library.
- TypeScript verifier/parser used by test and watchtower tooling.
- Solidity test harness consuming the exact same vectors.

Current conformance gate:

- `scripts/formal/check_p2tr_signature_fraud_vectors.mjs` parses the draft
  corpus, recomputes the covered BIP-341 key-path sighash, verifies the BIP-340
  positive cases, derives the draft watchtower challenge identity and the
  structured Bridge challenge identity, rejects duplicate draft and Bridge
  challenge identities, validates transaction prevout metadata, parses the
  Taproot witness signature encodings, rejects the negative witness parser
  cases, verifies the non-uniform txid byte-order vector, and verifies
  the negative BIP-340 and BIP-341 sighash mutation cases without external
  dependencies.
- `scripts/formal/check_p2tr_spend_type_closure.mjs` checks the P2TR
  spend-type closure manifest, requires account-control/covenant scope
  exclusion, keeps unclassified/wallet-closing/heartbeat fail-closed, and
  requires the vector corpus to continue carrying `all tBTC spend-type vectors`
  as an open coverage gap until production approval is recorded.
- `tools/tbtc-signer/tests/p2tr_signature_fraud_vectors.rs` consumes the same
  corpus with the Rust `bitcoin` crate's Taproot sighash implementation and
  secp256k1 Schnorr verifier, checks the same draft and Bridge challenge
  identities, proves the draft identity changes under wallet ID, sighash,
  signature, sighash type, and raw transaction mutations, and verifies the
  positive and negative witness-signature parser cases.
- `contracts/tbtc-v2/contracts/prototypes/PrototypeP2TRSignatureFraud.sol`,
  `contracts/tbtc-v2/contracts/test/TestP2TRSignatureFraudChallenge.sol`, and
  `contracts/tbtc-v2/test/bridge/P2TRSignatureFraudChallenge.test.ts` consume
  the same corpus from a Solidity/Hardhat harness, verify the draft challenge
  identities, reject duplicate identities in the corpus, and prove the identity
  commits to the challenged input index, prevout metadata, wallet ID,
  reconstructed sighash, signature, sighash type, and raw transaction. The same
  test-only harness also parses the positive witness-signature encodings and
  rejects the negative witness parser cases.
- `contracts/tbtc-v2/contracts/test/TestCheckBitcoinBIP340Sigs.sol` and
  `contracts/tbtc-v2/test/bridge/CheckBitcoinBIP340Sigs.test.ts` consume the
  same corpus through a Solidity/Hardhat BIP-340 verifier seed, compare the
  tagged challenge hash with an independent Node `crypto` reference, verify the
  positive BIP-340 cases, reject the negative BIP-340 mutation cases, reject
  malformed signature length and out-of-range scalar inputs, and record a first
  local verifier gas estimate. This is not yet wired into the formal vector gate
  or Bridge lifecycle tests.
- `contracts/tbtc-v2/contracts/test/TestCheckBitcoinBIP341Sighash.sol` and
  `contracts/tbtc-v2/test/bridge/CheckBitcoinBIP341Sighash.test.ts` consume the
  same corpus through a Solidity/Hardhat BIP-341 key-path sighash seed,
  reconstruct `SIGHASH_DEFAULT` and `SIGHASH_ALL` messages from structured
  transaction, prevout, output, locktime, version, and signed-input-index fields,
  prove the reconstructed sighashes are accepted by the BIP-340 verifier seed,
  reject unsupported sighash types and malformed payload shape, and prove the
  sighash changes for transaction and prevout mutation cases. This is not yet
  wired into the formal vector gate or Bridge lifecycle tests.
- `contracts/tbtc-v2/contracts/test/TestCheckBitcoinP2TRSignatureFraud.sol` and
  `contracts/tbtc-v2/test/bridge/CheckBitcoinP2TRSignatureFraud.test.ts`
  consume the same corpus through a combined Solidity/Hardhat verifier harness,
  parse supported Taproot witness-signature encodings, reconstruct the covered
  BIP-341 key-path sighash, verify the BIP-340 signature, return false for
  wallet/signature/sighash-data mutations, and reject unsupported witness and
  malformed transaction payload shapes. They also compute the structured Bridge
  challenge identity from the same verifier payload, validate explicit payload
  bounds for input count, output count, scriptPubKey bytes, signed input index,
  prevout count, and witness encoding, and record a first local gas estimate for
  bounded payload validation and combined verification. This is not yet wired
  into the formal vector gate or Bridge lifecycle tests, and the final
  production bound values are not frozen.
- `npm run readiness:gates:check` runs the P2TR spend-type closure check plus
  the P2TR fraud gas/DoS, funded-run, operator dry-run, release artifact,
  production indexing, and activation evidence-gate checks.
- `npm run formal:vectors:check` runs the existing ROAST vector check, the P2TR
  signature-fraud vector check, and then `npm run readiness:gates:check`.
- The Formal Verification CI `Signer formal invariants` job runs the Rust
  vector test through the `formal_verification_` test filter.
- The Formal Verification CI `Vector conformance gate` job runs
  `npm run formal:vectors:check`.

This is still a seed gate only. The structured Bridge challenge identity is the
current candidate for Bridge challenge-key derivation, but the gate must be
expanded to cover the full spend-type vector matrix before the P2TR
signature-fraud vector gate can be considered complete.

## Gas And DoS Gates

Before Bridge integration, produce gas evidence for:

- minimum valid challenge;
- worst supported number of inputs and outputs;
- malformed payload rejection paths;
- duplicate challenge rejection;
- defeat path;
- timeout/slashing path.

The spec freeze must set explicit maximums for inputs, outputs, witness sizes,
and payload byte lengths. The verifier must reject payloads above those limits
before expensive work.

## Gas And DoS Acceptance Matrix

The production verifier must have a measured gas envelope before Bridge
integration. The numbers below are placeholders for the freeze decision; each
row must be filled with final limits, measured gas, and reviewer acceptance.

| Area               | Limit or rule to freeze                                                                                                                 | Acceptance evidence                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transaction size   | Maximum raw transaction byte length accepted by the fraud payload.                                                                      | Tests and gas snapshots for minimum, maximum, and maximum-plus-one transaction sizes; maximum-plus-one must reject before BIP-340 verification.                     |
| Input count        | Maximum number of transaction inputs and prevout records. The signed input index must be less than the input count and fit in `uint32`. | Tests for zero inputs, signed index out of range, maximum inputs, and maximum-plus-one inputs; gas report for maximum inputs.                                       |
| Output count       | Maximum number of transaction outputs and output-script bytes.                                                                          | Tests for zero outputs where unsupported by spend policy, maximum outputs, malformed output length, and maximum-plus-one outputs; gas report for maximum outputs.   |
| Prevout metadata   | Every input must have exactly one prevout amount and scriptPubKey; scriptPubKey length must be bounded.                                 | Tests reject missing, duplicate, reordered, wrong amount, wrong scriptPubKey, and oversized scriptPubKey metadata before challenge storage.                         |
| Witness signature  | Accept only 64-byte implicit `SIGHASH_DEFAULT` or 65-byte explicit `SIGHASH_ALL` if the final spec keeps both.                          | Tests reject empty, short, long, explicit `0x00`, unsupported sighash bytes, annex, and script-path witness forms before expensive work.                            |
| Challenge identity | Duplicate identity checks must happen before deposit transfer or new storage writes where possible.                                     | Tests cover duplicate challenge, replay with changed wallet ID, changed chain/Bridge domain, changed input index, changed raw transaction, and changed prevout map. |
| Storage growth     | Challenge storage must have one bounded record per accepted identity and no unbounded per-input/per-output storage.                     | Storage layout review and tests proving malformed or duplicate submissions do not grow state.                                                                       |
| Defeat path        | Honest-spend defeat must reuse already-proven Bridge classification instead of reparsing unbounded Bitcoin data.                        | Gas snapshots for deposit sweep, moving funds, moved-funds sweep, redemption, and any approved closing/heartbeat defeat path.                                       |
| Timeout/slashing   | Timeout, slashing, notifier reward, and cleanup must remain bounded independently of the original transaction size.                     | Gas snapshots for timeout, slashing, reward, and repeated resolution calls; repeated calls must be idempotent or fail without state growth.                         |

The gas report must state whether each measurement is from local Hardhat,
Foundry, or CI, and must pin compiler, optimizer, fork, and contract commit.
Passing prototype verifier gas tests is not sufficient because the prototype
does not implement production BIP-340/BIP-341 verification.
Passing the BIP-340, BIP-341, and combined verifier seeds is also not sufficient
for Bridge activation because the production path still needs final payload
limits, full gas/DoS review, lifecycle integration, spend-type classification,
and security approval.
The combined helper now has parameterized payload-shape bound validation, and
the process-level watchtower refuses to enable challenge submission without
explicit raw-transaction, input-count, output-count, and scriptPubKey byte
bounds. The spec freeze still must set the final maximum values and the gas
report must measure those final values before activation. The current combined
harness test only records a first local gas-envelope seed for the draft vector
shape and local gas regression ceilings to catch unexpected seed-test growth.
Each local seed ceiling should fail independently, and routine CI should keep
gas logging quiet unless an operator explicitly requests the measurement
transcript.
The current BIP-340 seed verifier uses Jacobian-coordinate scalar
multiplication. Local Hardhat seed measurements on the draft vector are roughly
`1,895,589` gas for BIP-340 verification, `529,663` for high-bit generator
scalar multiplication, `1,108,122` for dense generator scalar multiplication,
and `1,942,803` for the combined P2TR key-path verifier. These are regression
tripwires only, not production approval.
The Bridge lifecycle fixture now also records a first local gas-envelope seed
for the same bounded draft payload: submit `5,221,336`, honest-spend defeat
`163,784`, and timeout `181,821`. These numbers are local Hardhat seed evidence,
not production gas approval, and must be replaced or confirmed after the final
payload bounds, spend-type closure, compiler settings, and reviewer acceptance
are frozen.
The final payload-bound and gas/DoS approval evidence is tracked in
`docs/operations/frost-roast-p2tr-fraud-gas-dos-evidence-v0.json`, with the
review procedure in
`docs/operations/frost-roast-p2tr-fraud-gas-dos-review-runbook-2026-05-21.md`.
`scripts/formal/check_p2tr_fraud_gas_dos_gate.mjs` keeps that manifest
`missing-no-go` until final bounds, worst-case gas snapshots, malformed-payload
rejection evidence, storage-growth review, watchtower DoS controls, funded
fraud-run evidence, and owner approvals are recorded.

## Implementation Phases

1. Spec freeze:
   - approve supported P2TR spend forms, sighash flags, payload schema, maximum
     sizes, challenge identity, and unsupported forms.
2. Vector freeze:
   - add canonical vectors and cross-language conformance checks.
3. Watchtower extraction:
   - implement deterministic challenge payload extraction, idempotency storage,
     reorg handling, and defeat/timeout/slashing correlation from observed P2TR
     witness data.
4. Verifier feasibility:
   - implement a production BIP-340/BIP-341 verifier harness, run gas/DoS
     measurements, and obtain security review before Bridge integration.
   - current seed status: BIP-340 equation verification, annex-free key-path
     BIP-341 sighash reconstruction, a combined witness-parser/sighash/
     signature verifier, structured Bridge challenge identity computation, and
     parameterized payload-shape bound validation exist as focused Solidity
     harnesses. A linked Bridge lifecycle seed now consumes the ABI-encoded
     structured payload through `processP2TRSignatureFraudChallenge`, stores the
     challenge under the domain-separated Bridge challenge key, defeats the
     challenge using already-proven honest-spend state, and executes the
     timeout/slashing path. The SDK/watchtower can store domain-bound challenge
     records under Bridge challenge keys derived from that structured identity,
     resolve off-chain lifecycle events by those keys, validate cursor-backed
     lifecycle scans against optional block-hash cursor boundaries, ABI-encode
     Bridge challenge payloads, and
     submit them through an Ethers-compatible Bridge adapter with confirmation
     waiting and rejected/retry handling. Final payload limit values,
     spend-type classification, gas/DoS review, production Bridge/source
     adapter deployment, multi-operator durability, funded rehearsal, and
     security review remain open.
5. Bridge integration:
   - add the P2TR fraud path behind an activation gate and preserve the
     challenge/defeat/timeout/slashing lifecycle.
6. End-to-end run:
   - run funded regtest/testnet wallet creation, signing, honest-spend defeat,
     fraudulent challenge timeout/slashing, rollback, and recovery.
7. Production approval:
   - attach security/runtime/governance approvals and accepted residual risks.

## Activation Gate

P2TR/FROST production activation remains `NO-GO` until all of the following are
true:

- P2TR signature-fraud spec freeze is approved by maintainers and security
  reviewers.
- Canonical vectors exist and pass across independent implementations.
- Bridge verifier gas and DoS limits are reviewed and accepted.
- Watchtower/operator payload extraction is implemented and rehearsed.
- Fraud lifecycle tests pass for challenge, defeat, timeout, slashing, replay,
  and inactive-wallet rejection.
- keep-core integration and testnet lanes are non-skipped and green.
- A funded production-like run covers the fraud path.
- Signed release artifacts and rollback/operator runbooks exist.
- Governance explicitly approves activation.
