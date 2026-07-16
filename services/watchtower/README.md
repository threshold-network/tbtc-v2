# P2TR Signature-Fraud Watchtower

Observation and single-process rehearsal scaffold for the tBTC P2TR
signature-fraud challenge path.

> **Current safety state:** automatic/watchtower challenge submission is hard
> disabled while the FROST fraud layer remains bounded/no-go. Every service,
> runtime, and SDK runner entry point rejects `submitChallenges: true`, and
> submission metrics remain zero. This package now contains a canonical Bitcoin
> indexing tranche and an inert durable signed-transaction outbox protocol, but
> no bundled production runtime composes them with the required Ethereum
> lifecycle index, concrete transactional storage, broadcaster, or independent
> reconciliation. COMPLETE_V2 activation also requires a fresh or explicitly
> migrated ECDSA fraud router and a separately reviewed deployment manifest. The
> bundled Esplora observer remains rehearsal-only and never certifies the
> confirmed view complete, even when its current result is empty. Wallet-history
> and sequential outspend polling are not a canonical Bitcoin change feed and
> cannot certify point-in-time coverage; the source can also stop at its finite
> inventory limit.
> Production activation additionally requires a keyed deposit database, a
> canonical Bitcoin block/change-feed cursor, bounded new-block input matching,
> block-hash rollback, and a durable unmatched Ethereum-proof backlog.

The package wraps the SDK watchtower runner with process-level boundaries that an operator service needs:

- durable JSON persistence for challenge records with changed-since-load overwrite guards;
- state-file validation before restart replay or challenge submission;
- one integrated cycle that replays stored challenges, scans Bitcoin transaction sources, applies Bridge lifecycle events, and returns a single summary;
- cycle metrics for source failures, per-item failures, observations, submission attempts, lifecycle records, and unresolved operator alerts;
- an abort-aware sequential polling loop that prevents overlapping cycles and makes cycle failures explicit;
- observation-only process-level service cycles; automatic submission is hard disabled;
- a bundled Esplora-backed transaction source for registered P2TR wallet addresses;
- a bundled Ethers-compatible Bridge lifecycle event source for P2TR challenge defeat and timeout events;
- dependency injection points for Bitcoin transaction discovery and Bridge lifecycle event discovery.

## Durable Challenge Outbox (Not Activated)

`P2TRSignatureFraudChallengeOutboxScheduler` and
`P2TRSignatureFraudChallengeOutboxDispatcher` define the future production
state machine without connecting it to the automatic watchtower. The scheduler
accepts only complete, confirmed Bitcoin evidence and an immutable exact Router
call intent. The dispatcher signs without sending, authenticates the signed raw
transaction, stores those bytes, and commits a compare-and-swap
`broadcast-pending` attempt before a broadcaster sees them. Recovery may resend
only those identical bytes; it never creates a replacement transaction or a new
generation after an ambiguous result.

The reconciliation boundary requires a provider object and trust-domain ID
distinct from broadcasting. Successful resolution carries a finalized receipt,
the exact submitted event, a canonical transaction, and matching Router
challenge state. The watchtower's own transaction must match its signed
router/calldata/value/sender/nonce exactly. An external satisfaction may use a
different canonical submit selector or overpay, but must target the Router,
cover the required deposit, and bind its sender and value to Router state. A
finalized revert or a finalized consumed
sender nonce may terminate the immutable transaction; `pending`, `unknown`, or
inconsistent evidence never makes it replayable. Legacy records with any prior
submission attempt are quarantined instead of imported into the new outbox.

`migrations/002_p2tr_signature_fraud_challenge_outbox.sql` documents the
PostgreSQL uniqueness, CAS-version, immutable-generation, and prepared-bytes
constraints expected from a concrete store. No database adapter, Ethers
reconciler/broadcaster, service scheduling hook, or environment activation flag
is wired in this tranche. Consequently, constructing these exported classes
does not change the hard rejection of `submitChallenges: true`.

This package is intentionally scoped to the Schnorr FROST/ROAST P2TR fraud path. It does not depend on account-control, ac-watchdog, or covenant packages.

## Operator Wiring

A production deployment must provide these adapters:

- `BitcoinClient`: resolves input prevouts for candidate Bitcoin transactions.
- `P2TRSignatureFraudWatchtowerTransactionSource`: lists mempool and confirmed candidate P2TR spends.
- `P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource`: lists Bridge challenge lifecycle events.
- `P2TRSignatureFraudChallengeSubmitter`: retained as a low-level/manual SDK adapter boundary; the watchtower service does not invoke it while bounded/no-go is active.
- `P2TRWatchtowerChallengeRecordPersistence`: stores serialized challenge records durably.

## Canonical Bitcoin Index Tranche

`BitcoinCoreP2TRCanonicalBlockSource`,
`CanonicalBitcoinP2TRSignatureFraudTransactionSource`, and
`PostgresP2TRCanonicalIndexStore` implement the production-shaped Bitcoin side
of the activation boundary. Apply `migrations/001_p2tr_canonical_index.sql` to a
PostgreSQL 16 database before constructing the store. The Bitcoin Core source
requires Core 23 or newer, an unpruned and fully synchronized node, synchronized
`txindex`, and bounded RPC response and concurrency settings. It authenticates
raw block hashes, each header's declared proof-of-work target, merkle and witness
commitments, transaction identity, and every non-coinbase prevout against raw
`txindex` bytes before the source can mark a scan complete.

Production activation must construct the canonical transaction source with
`historyCoverage: "genesis-full-history"`, checkpoint height `0`, and the exact
genesis hash configured for the selected Core network. Its asynchronous
activation handshake revalidates the live synchronized Core node and genesis;
it also requires the durable cursor to match the live finalized Core head.
Custom checkpoints are explicitly test-only and cannot pass that handshake.
Scanning from height 1 imposes a one-time full-chain synchronization/indexing
cost, but it is the only self-contained proof that the checkpoint strictly
predates every possible FROST P2TR wallet or revealed-deposit output. Before
activation, `assertP2TRSignatureFraudActivationIndexReady` additionally checks
that every durable tracked/revealed output joins to that genesis-backed journal
and that candidate, deposit-reveal, and unmatched-proof backlogs are empty.

The configured Core node's `getblockhash` chain is the source's canonical-chain
trust boundary. The raw checks do not independently validate network difficulty
transitions, choose the greatest-work chain, or protect against a consistently
malicious node. Automatic activation must therefore compose an independent
Bitcoin verifier/provider in a distinct operational trust domain and pin its
agreement policy in the activation manifest. This tranche has no such adapter;
the hard submission no-go is the fail-closed boundary when that independent
agreement is absent.

The canonical transaction source advances a hash-pinned cursor over bounded
block windows, rechecks its range before commit, finds a bounded common ancestor
on reorganization, and emits exact `(block hash, txid, wtxid)` orphan identities.
It loads the durable FROST wallet inventory on every cycle, so an empty initial
inventory is valid and registrations or removals become visible without a
restart. Taproot deposit reveals can arrive before their funding output; the
store retains them in a bounded backlog and backfills a matching spend after the
Bitcoin journal reaches that output. Candidate delivery is acknowledged only by
the enclosing watchtower transaction. An aborted or failed cycle discards its
staged scan.

The PostgreSQL store retains raw canonical blocks, transactions, inputs,
outputs, tracked wallet/deposit outpoints, candidate identity, unmatched proof
backlog, and the cross-source watermark. `rollbackEthereumEvidenceTo` removes
hash-orphaned wallet and deposit registrations, strips their exact key bindings
from candidates, and invalidates orphaned proof and watermark state. All
recovery, rollback, pagination, mutation, and backlog operations have configured
bounds and fail closed when a bound is exceeded.
Bitcoin reorganization handling removes a watermark above the retained common
ancestor in the same serializable transaction that replaces the block and
candidate journal, forcing cross-source processing to replay replacement
history before it can advance again.

Production adapters that share this state must be created through
`createP2TRSignatureFraudWatchtowerTransactionalAdapter`. Its query-only session
is usable only inside the store's serializable transaction, and the watchtower
rejects participants not owned by that coordinator. This is the extension point
for the transactional challenge-record store, Ethereum lifecycle index, and
broadcast outbox; those concrete adapters are deliberately not supplied by this
tranche.
The coordinator destroys pooled clients after failed transaction-control or
rollback operations. In particular, a failed `COMMIT` is surfaced as an unknown
transaction outcome for caller reconciliation and the ambiguous session is
never returned to the pool.

This tranche does **not** make activation safe. Before automatic challenge
submission can be reviewed for enablement, a later stack must add and test all
of the following in one production composition:

- PostgreSQL-backed `P2TRWatchtowerChallengeRecordPersistence` and a canonical,
  hash-pinned Bridge lifecycle cursor/raw-log envelope adapter;
- lifecycle reorganization handling that calls `rollbackEthereumEvidenceTo` in
  the same serializable transaction and transitions any stale challenge record;
- deposit-key derivation from
  `Bridge.taprootDepositOutputKey(depositKey)` at the pinned finalized Ethereum
  block, never from caller-decoded event arguments;
- a durable transactional broadcast outbox with idempotent dispatch and an
  independently operated reconciler that proves submitted, mined, replaced,
  defeated, timed-out, and orphaned outcomes;
- an independent Bitcoin header/chain verifier or provider, in a distinct trust
  domain from the indexing Core node, that checks the pinned range and
  cumulative-work selection before a challenge can leave the outbox;
- a fresh or explicitly migrated ECDSA fraud router, plus an activation manifest
  that pins contract addresses, chain checkpoints, database schema, Bitcoin
  network/genesis, Core policy, and rollback limits.

Until that composition receives a fresh security review, keep
`submitChallenges` and
`P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMIT_CHALLENGES` false.

`EsploraP2TRSignatureFraudTransactionSource` is limited to observation-mode rehearsals and single-process deployments. It derives Bech32m P2TR wallet addresses from canonical x-only wallet IDs and advances confirmed wallet history in bounded, explicitly acknowledged cursor batches. Taproot deposit reveals are independently compared over block-hash-pinned, finalized ranges; dense ranges shrink until they fit the configured event bound, while a single block above that bound fails closed. Derived deposit bindings and the rotating outspend sweep are persisted only after the caller durably processes the confirmed batch. The binding inventory and each outspend batch have explicit finite limits, so capacity exhaustion fails closed instead of allocating unbounded lifetime state. The adapter unconditionally returns `complete: false`: neither an empty Esplora wallet-history response nor sequential outspend calls provide an independently authenticated Bitcoin snapshot. The service can commit acknowledged Bitcoin catch-up state, but it will not let this adapter authorize Ethereum lifecycle-cursor advancement. This is an intentional liveness halt, not a production completeness mechanism. The source must not be used to activate automated challenges. Only the authenticated canonical Bitcoin source described above may return `complete: true`, and its result still cannot enable submission until all remaining activation components are composed and reviewed.

Commitment/deposit reads, outspend lookups, and raw-transaction materialization use bounded work queues; provider disagreement, range reorganization, a failed binding/outspend/raw read, or an unacknowledged/incomplete history batch prevents durable cursor advancement. Construction requires an `onDepositScanFailure` callback for structured operator reporting. The source does not resolve prevouts; deployments must still provide a `BitcoinClient`.

`EthersP2TRSignatureFraudBridgeLifecycleEventSource` can be used with Ethers-compatible router and Bridge contract instances. Both source contracts must expose the same provider object so challenge and honest-proof logs share one head/range/reorg view. The source also requires a source trust-domain ID and an independently configured `P2TRCanonicalBridgeLifecycleLogVerifier`; startup rejects an absent verifier, a verifier declaring the same trust domain, or a verifier using that source provider object. The adapter drops adapter-supplied decoded arguments during raw-log normalization and retains only the emitter, topics, data, transaction hash, block hash/number, and log index. It does not decode or map a lifecycle event unless the verifier independently confirms those raw fields belong to a successful canonical receipt with the requested event-signature topic and exact log membership. Canonical-log verification calls across every lifecycle event type share a source-wide bounded task queue with a default concurrency of 8; deployments using stricter canonical providers should configure a lower limit. After verification, it derives every mapped field from the verified static-ABI topics and data, rejecting unexpected topic/data counts or non-canonical indexed-`bytes20` padding. `EthersP2TRCanonicalBridgeLifecycleLogVerifier` provides the receipt-membership check for an independent Ethers provider. Object-identity checks catch direct provider reuse or split-source misconfiguration, but distinct wrappers or URLs do not prove independence; trust-domain IDs must describe genuinely separate operational failure domains.

The source reads `P2TRSignatureFraudChallengeDefeated` and `P2TRSignatureFraudChallengeDefeatTimedOut` logs over a configured block range, or derives `toBlock` from the minimum of the indexing and canonical-verifier heads at the configured confirmation depth. It rejects unsafe range options, can enforce a maximum numeric block span per scan, and rejects returned canonical logs outside the resolved numeric bounds before mapping them. It decodes the on-chain `challengeKey`, wallet ID, Bridge challenge identity, and sighash from the verified raw log, normalizes the key to the watchtower's stored Bridge challenge key, and emits key-addressed lifecycle events with evidence the SDK runner can compare against the persisted observation. Completed moving-funds and redemption proof transaction hashes are likewise decoded from verified raw event data. Timeout logs default to both `slashed` and `rewarded` records because the Bridge timeout transaction resolves the challenge, slashes the wallet, and rewards the notifier; embedding services can opt into a single timeout status if an approved Bridge integration needs narrower tracking. After a challenge is recorded as timeout-eligible or slashed, repeated observations cannot resubmit it; stale timeout or defeat events cannot move slashed records backward, and only the corresponding reward record can advance a slashed record. Embedding services can provide a scan cursor store and a cursor overlap window for conservative reorg replay; cursor-backed scans require `maxBlockRange` plus either a numeric `toBlock` or provider-derived confirmation depth, reject explicit `fromBlock` overrides, and require overlap to be smaller than `maxBlockRange` so durable cursor deployments cannot silently rescan an uncommittable, unbounded, or non-progressing range. Cursor boundaries are pinned and rechecked through the independent canonical verifier before commit. If `requireCursorBlockHash` is enabled, the indexing provider's block hash must additionally agree with that canonical view. If a cursor-backed scan has more confirmed blocks available than `maxBlockRange`, the source scans and commits one bounded window so catch-up can proceed over multiple cycles. The watchtower service commits the cursor only after Bridge lifecycle events are listed and processed without source or per-event failures. Verifier disagreement rejects the lifecycle source result, leaves challenge records retryable, and leaves the cursor uncommitted. The adapter does not compute timeout eligibility or replace final production event-indexing and reorg policy.

`FileBackedP2TRBridgeLifecycleScanCursorStore` persists the Bridge lifecycle scan cursor as `{ lastScannedBlock, lastScannedBlockHash? }`, validates the cursor before use, rejects overwrites when the cursor file changed since the last load, and replaces the file atomically on save. It is suitable for single-process dry runs and operator rehearsals. Multi-process or horizontally scaled deployments should replace it with a transactional cursor store and an approved reorg policy.

`FileBackedP2TRWatchtowerChallengeRecordPersistence` is suitable for single-process dry runs and operator rehearsals. It validates serialized records when loading the state file, before restart replay or challenge submission, and rejects overwrites when the state file changed since the last load. Multi-process or horizontally scaled deployments should replace it with a transactional store while preserving the same SDK persistence contract.

`loadP2TRSignatureFraudWatchtowerRuntimeConfig` provides a small environment-shaped configuration boundary for operator deployments. It validates the durable state path, registered wallet IDs, Bridge domain identifier, optional Bridge challenge domain, Esplora transaction-source settings, deposit-scan concurrency, Bridge lifecycle scan window/cursor settings, poll interval, retry limits, and failure policy before the service starts.

`createFileBackedP2TRSignatureFraudWatchtowerRuntime` wires that validated runtime config into `P2TRSignatureFraudWatchtowerService`, a file-backed persistence instance, and loop options for single-process deployments.

`createEsploraP2TRTransactionSourceFromRuntimeConfig` wires validated Esplora base URL, Bitcoin network, timeout, retry, confirmed-page, and deposit-scan concurrency settings into the bundled Esplora transaction source using the registered wallet IDs from runtime config. Its runtime options require the same complete-history Taproot deposit reveal source, the reveal source's chain ID and Bridge address for cursor fingerprinting, and the structured deposit-scan failure handler used by direct construction. Those reveal-chain settings are independent of the optional challenge-submission domain, so domainless observation mode remains usable.

`createFileBackedP2TRBridgeLifecycleEventSource` wires the validated Bridge lifecycle runtime config into the Ethers-compatible event source and uses `FileBackedP2TRBridgeLifecycleScanCursorStore` when `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_CURSOR_FILE` is configured. Its final argument must inject the indexing source's trust-domain ID and an independently configured canonical-log verifier; environment variables intentionally cannot synthesize that provider separation.

| Environment variable                                                          | Required | Description                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_STATE_FILE`                                  | Yes      | File path for JSON challenge-record persistence when using the bundled file-backed store.                                                                                                                 |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_WALLET_IDS`                                  | Yes      | Comma-separated 32-byte x-only P2TR wallet IDs. Values are normalized to lower-case `0x` hex.                                                                                                             |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_IDENTIFIER`                           | No       | `0x`-prefixed Bridge/domain identifier included in observation IDs.                                                                                                                                       |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_CHALLENGE_CHAIN_ID`                   | No       | Positive chain ID for COMPLETE_V2 challenge identities and keys. Requires `BRIDGE_CHALLENGE_BRIDGE_ADDRESS`.                                                                                              |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_CHALLENGE_BRIDGE_ADDRESS`             | No       | Non-zero Bridge contract address for COMPLETE_V2 challenge identities and keys. Requires `BRIDGE_CHALLENGE_CHAIN_ID`.                                                                                     |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_BASE_URL`                            | No       | Absolute `http` or `https` base URL for the bundled Esplora transaction source. Requires `ESPLORA_BITCOIN_NETWORK`.                                                                                       |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_BITCOIN_NETWORK`                     | No       | Bitcoin network for derived P2TR wallet addresses: `mainnet`, `testnet` (testnet3), or `testnet4`. Requires `ESPLORA_BASE_URL`.                                                                           |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_MAX_ATTEMPTS`                        | No       | Positive Esplora request attempt count. Requires Esplora base URL and Bitcoin network when set.                                                                                                           |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_REQUEST_TIMEOUT_MS`                  | No       | Positive Esplora request timeout. Requires Esplora base URL and Bitcoin network when set.                                                                                                                 |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_RETRY_DELAY_MS`                      | No       | Non-negative delay between retryable Esplora attempts. Requires Esplora base URL and Bitcoin network when set.                                                                                            |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_CONFIRMED_PAGE_LIMIT`                | No       | Positive confirmed-history safety cap per wallet. The source probes one further page and rejects as incomplete if older entries remain. Requires Esplora base URL and Bitcoin network when set.           |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_DEPOSIT_SCAN_CONCURRENCY`                    | No       | Positive source-wide concurrency limit for deposit binding, outspend, and raw-transaction tasks. Defaults to `8`; retries retain their task slot. Requires Esplora base URL and Bitcoin network when set. |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_TAPROOT_DEPOSIT_REVEAL_MAX_EVENTS_PER_RANGE` | No       | Positive reveal-event work bound. Dense multi-block ranges are reduced until both independent sources fit; a single-block overflow fails closed. Requires Esplora configuration.                          |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_DEPOSIT_OUTSPEND_SCAN_LIMIT`                 | No       | Positive number of persisted deposit bindings polled per cycle. This bounds rehearsal work but does not form a canonical Bitcoin snapshot.                                                                |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_TAPROOT_DEPOSIT_BINDING_INVENTORY_LIMIT`     | No       | Positive finite ceiling for persisted deposit bindings. Exceeding it halts the source fail-closed; increasing it does not make the source production-safe.                                                |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_FROM_BLOCK`                 | No       | Non-negative Bridge lifecycle start block for event scans.                                                                                                                                                |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_TO_BLOCK`                   | No       | Non-negative Bridge lifecycle end block for fixed-window event scans. Required with cursor file if confirmation depth is not set.                                                                         |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_CONFIRMATION_DEPTH`         | No       | Non-negative confirmation depth used to derive the Bridge lifecycle scan end block from the provider head. Required with cursor file if fixed `TO_BLOCK` is not set.                                      |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_VERIFICATION_CONCURRENCY`   | No       | Positive source-wide concurrency limit for canonical lifecycle-log verification across every event type. Defaults to `8`; configure a lower value for stricter canonical providers.                       |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_MAX_BLOCK_RANGE`            | No       | Positive maximum Bridge lifecycle block span per scan. Required when `BRIDGE_LIFECYCLE_CURSOR_FILE` is set.                                                                                               |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_CURSOR_FILE`                | No       | File path for durable Bridge lifecycle scan cursor state. Requires `MAX_BLOCK_RANGE` and either `TO_BLOCK` or `CONFIRMATION_DEPTH`.                                                                       |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_CURSOR_OVERLAP_BLOCKS`      | No       | Non-negative number of previously scanned blocks replayed for conservative reorg handling.                                                                                                                |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_TIMED_OUT_EVENT_STATUS`     | No       | Optional single timeout status override: `slashed` or `rewarded`. By default timeout logs emit both records.                                                                                              |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_POLL_INTERVAL_MS`                            | No       | Positive integer polling interval. Defaults to `30000`.                                                                                                                                                   |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_CONTINUE_ON_ERROR`                           | No       | `true` keeps polling after unexpected cycle errors. Defaults to fail-fast `false`.                                                                                                                        |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMIT_CHALLENGES`                           | No       | Must remain `false`; `true` is rejected at config load while the FROST fraud layer is bounded/no-go.                                                                                                      |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_ALLOW_FILE_BACKED_SUBMISSION`                | No       | Retained for configuration compatibility and future COMPLETE_V2 review only. It cannot override the current hard submission no-go.                                                                        |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMISSION_ALLOWED_SPEND_TYPES`              | No       | Future-activation policy input only. It does not enable submission while `SUBMIT_CHALLENGES=true` is rejected.                                                                                            |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_MAX_RAW_TRANSACTION_BYTES`                   | No       | Positive integer raw transaction byte limit. Required with the other payload-bound variables when any payload bound is set.                                                                               |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_MAX_INPUTS`                                  | No       | Positive integer transaction input and prevout count limit. Required with the other payload-bound variables when any payload bound is set.                                                                |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_MAX_OUTPUTS`                                 | No       | Positive integer transaction output count limit. Required with the other payload-bound variables when any payload bound is set.                                                                           |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_MAX_SCRIPT_PUBKEY_BYTES`                     | No       | Positive integer scriptPubKey byte limit for prevouts and outputs. Required with the other payload-bound variables when any payload bound is set.                                                         |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_MAX_SUBMISSION_ATTEMPTS`                     | No       | Future-activation retry-policy input only; automatic submission is currently unreachable.                                                                                                                 |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMISSION_ATTEMPT_LIMIT_ALERT_CODE`         | No       | Future-activation operator-alert input paired with the retry ceiling and alert message.                                                                                                                   |
| `P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMISSION_ATTEMPT_LIMIT_ALERT_MESSAGE`      | No       | Future-activation operator-alert input paired with the retry ceiling and alert code.                                                                                                                      |

## Cycle Contract

Each `processCycle()` call:

1. reloads persisted challenge records through the serialized SDK store;
2. reloads/reconciles stored observations without broadcasting challenges;
3. scans mempool and confirmed Bitcoin sources;
4. applies Bridge defeated, timeout-eligible, slashed, and rewarded events;
5. emits metrics plus the SDK's final challenge summary and unresolved operator alerts.

The service treats source failures separately from per-transaction and per-event failures so an operator can distinguish upstream outages from malformed candidate data. Source-failure logs include source names and errors; item-failure logs include transaction hashes, confirmed block metadata, or Bridge lifecycle event details without dumping raw Bitcoin transaction payloads. Bridge lifecycle resolution clears stale open or acknowledged submission-attempt alerts once a challenge is defeated, slashed, or rewarded.

## Polling Loop

`runP2TRSignatureFraudWatchtowerLoop` runs one cycle at a time, waits for the configured poll interval, and exits on `AbortSignal` or a configured cycle limit. Unexpected cycle errors fail the loop by default; operators can opt into `continueOnError` only when surrounding supervision and alerting are in place.

The loop is intentionally small and dependency-free so deployments can wire it into systemd, Kubernetes, a worker queue, or a custom supervisor without changing watchtower state semantics.

The SDK runner, service, and runtime config are observation-only and do not
require a challenge submitter. `P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMIT_CHALLENGES=true`
is rejected at every automatic/watchtower entry point. Do not use JavaScript
object mutation or a custom runner invocation to bypass this boundary; direct
watchtower submission also fails before persistence mutation or an external
call. The remaining submission-policy configuration describes prerequisites
for a future, separately reviewed COMPLETE_V2 design and is not an activation
switch.

The bundled environment-backed runtime uses file-backed challenge-record and
cursor stores. They are single-process rehearsal stores, never production
submission infrastructure. The `transactional-production` profile remains
useful for atomic observation and cursor indexing, but it does not re-enable
challenge broadcasting.

Embedding services can provide a `spendTypeClassifier` in service config to classify observations for audit and future policy evaluation. The SDK exposes a deterministic rule-composition helper for approved classifiers: malformed rules fail closed, no matching rule leaves observations `unclassified`, and ambiguous or non-boolean rule matches fail closed. The environment-backed runtime may parse an explicit allowed-spend-types allowlist from `P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMISSION_ALLOWED_SPEND_TYPES`, but neither the allowlist nor an injected classifier overrides the current submission no-go.

Embedding services can also provide `payloadBounds` to reject oversized raw transactions, input/output counts, and scriptPubKey byte lengths before observations are recorded. These bounds remain mandatory inputs to any future activation review, but configuring them does not enable challenge broadcasting.

When an embedding service provides `bridgeChallengeDomain`, or when the environment-backed runtime receives both Bridge challenge-domain variables, the watchtower derives the COMPLETE_V2 v3 identity from the chain, Bridge, registered wallet ID, actual Taproot signing key, and BIP-341 sighash. COMPLETE_V2 uses that identity directly as the observation ID, durable record key, submission-idempotency key, and on-chain challenge key. Flexible-sighash transaction representations of the same signed authorization therefore share one record and one submission attempt; the raw-evidence observation ID is used only in domainless observation mode. Same-key record transitions are serialized within a store instance, and the exact observation selected for submission remains attached to the in-flight record. Confirmed replacement transactions append fixed-size Bitcoin transaction-hash/spend-type proof aliases to that record, allowing honest-spend lifecycle events to reconcile every confirmed representation without replacing the submitted payload; mempool-only replacements do not grow the durable alias history. An observation-bearing confirmation is rejected unless the observation's raw transaction hashes to the supplied transaction ID. A confirmation event that omits its observation derives the proof alias from the stored observation only when that observation's raw transaction hashes to the confirmed transaction ID; mismatches add no alias and remain fail-closed. When legacy confirmed scalar metadata first enters alias mode, it is retained only if its transaction hash matches the stored raw transaction, preventing already-inconsistent replacement state from becoming a false alias. Bridge lifecycle events can identify a challenge by either observation ID or Bridge challenge key; in domain-bound mode those values are identical, and unknown keys fail closed. When lifecycle events include wallet ID, Bridge challenge identity, or sighash evidence, the SDK runner compares those fields with the stored observation before applying the lifecycle state change. The environment-backed runtime does not infer this domain automatically.

The retained future-activation validation path reconstructs the exact observation selected from durable state using the configured Bridge identifier, classifier, payload bounds, and Bridge challenge domain, then checks it against policy. The incoming observation remains independently policy-gated, so neither representation can authorize the other. This code is defense in depth for later review; today every automatic entry point stops before it can call a submitter.
