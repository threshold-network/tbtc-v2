# Phase C-1: Companion-services migration plan

**Status as of:** 2026-05-24
**Owner:** Bridge contracts team (handoff to indexer/services owners
once contract deploy addresses land)
**Companion to:** `wallet-lifecycle-migration-plan.md`,
`scheme-preference-and-retirement-rfc.md` (PR #438).

## Scope

Phase C-1 is the set of off-chain consumer updates that need to
absorb the Bridge surface changes from PRs #431 (FROST registration
entry), #434 (Phase A lifecycle routing), #435 (ECDSA + P2TR fraud
extraction), #436 (gate retargeting), and #439 (C-2 scheme
preference + counter).

C-1 is **not a single PR**. It is a fan-out of independent updates
to downstream repositories:

| Sub-phase | Repo / path                                                      | Scope                                                                                                                                   |
| --------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| C-1.1     | `data/tbtc-subgraph/`                                            | Bridge ABI refresh; new sidecar datasources; schema additions; mapping handlers                                                         |
| C-1.2     | `data/v3-indexer/`                                               | Mirror of C-1.1's contract-surface deltas; whatever ingestion path the v3 indexer uses                                                  |
| C-1.3     | `services/p2tr-signature-fraud-watchtower/`                      | Already prepared in #435 (duck-typed contract reference); production wiring to router address at deploy time                            |
| C-1.4     | `services/crosschain-relayer/` + cross-chain depositor contracts | Preserve Taproot reveal x-only keys end to end; deploy matching destination/L1 contracts and relayer before enabling the SDK capability |
| C-1.5     | `services/backend/src/interfaces/Bridge.ts`                      | If it references fraud entry points, retarget to the routers                                                                            |
| C-1.6     | `sdk/tbtc-v2-ts/`                                                | Type rename `...BridgeChallengeContract` → `...RouterContract` (queued for follow-up breaking-change release)                           |

The sub-phases are **independent**. Each can ship on its own
timeline subject to its own deploy/release cadence; they share no
git dependency beyond the contract upgrade itself having a known
deploy address.

## Hard deploy-time dependency

The sidecar contracts (`EcdsaFraudRouter`, `P2TRSignatureFraudRouter`,
`BridgeLifecycleRouter`) and the future `FrostWalletRegistry` (B-1)
are **not yet deployed on mainnet or Sepolia**. Any subgraph or
indexer datasource that targets one of these contracts needs:

- the deployed contract address (per-chain), and
- the contract creation block (for `startBlock`).

Until the upgrade lands, the C-1 sub-phases split into:

1. **Preparation work** that can ship now (additive Bridge event
   handlers; schema additions; ABI refresh) without breaking the
   current production indexer. The new handlers will simply have
   nothing to do on the pre-upgrade Bridge ABI.
2. **Cutover work** that has to wait for deploy addresses (the
   sidecar datasources themselves; the FROST registry datasource).

This doc lays out both. **The recommended order is preparation
work first → contract upgrade goes live → cutover work follows in a
fast-follow PR per sub-phase.**

## Per-event handler inventory

The events emitted by the post-upgrade contract surface, mapped to
the consumer that needs each:

### Bridge-emitted events (new since current subgraph ABI)

| Event                                                                                                                                     | Emitter (after upgrade)                                | C-1 consumer(s)                          | Notes                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FrostWalletRegistrySet(address frostWalletRegistry)`                                                                                     | Bridge                                                 | subgraph, v3-indexer                     | One-time governance setter event; subgraph tracks for completeness                                                                                                                                                          |
| `EcdsaFraudRouterSet(address ecdsaFraudRouter)`                                                                                           | Bridge                                                 | subgraph, v3-indexer                     | Cue to enable the EcdsaFraudRouter datasource at runtime if the indexer supports dynamic dataSources                                                                                                                        |
| `P2TRFraudRouterSet(address p2trFraudRouter)`                                                                                             | Bridge                                                 | subgraph, v3-indexer                     | Same shape as above for P2TR router                                                                                                                                                                                         |
| `LifecycleRouterSet(address lifecycleRouter)`                                                                                             | Bridge                                                 | subgraph, v3-indexer                     | Lifecycle router address (Phase A); cue for the lifecycle router datasource                                                                                                                                                 |
| `NewFrostWalletRegistered(bytes32 walletID, bytes20 walletPubKeyHash, bytes32 xOnlyOutputKey)`                                            | Bridge (via Wallets library; emitter = Bridge address) | subgraph, v3-indexer, crosschain-relayer | FROST-specific wallet registration; consumers must populate `Wallet.scheme = FROST`                                                                                                                                         |
| `NewWalletRegisteredV2(bytes32 walletID, bytes32 ecdsaWalletID, bytes20 walletPubKeyHash)`                                                | Bridge (via Wallets library)                           | subgraph (already wired), v3-indexer     | Replaces the V1 event for canonical 32-byte walletID consumers; V1 still fires for ECDSA wallets                                                                                                                            |
| `NewWalletSchemeSet(WalletScheme indexed scheme)`                                                                                         | Bridge (ABI declaration only)                          | none                                     | D-2.2 slice 3 removed the scheme setter. The event declaration remains for ABI back-compat but no longer fires in the canonical mirror; consumers should not wait for it.                                                   |
| `EcdsaWalletCountSeeded(uint128 historicalCount, uint128 totalAfterSeed)`                                                                 | N/A                                                    | none                                     | Dropped/deferred indefinitely before the canonical mirror. Consumers should derive historical ECDSA counts by replaying `NewWalletRegistered` and should not expect this event or an `ecdsaWalletCountSeeded` storage flag. |
| `LegacyFraudChallengeMigrated(uint8 indexed routerKind, uint256 indexed challengeKey, address indexed challenger, uint256 depositAmount)` | Bridge                                                 | subgraph, v3-indexer                     | One-time per-challenge migration event; consumers note the migration but the active challenge state lives on the router post-migration                                                                                      |

### EcdsaFraudRouter-emitted events (datasource not yet wired)

After the cutover, the following events move from Bridge to
EcdsaFraudRouter; the EVENT SIGNATURES are unchanged from the
pre-#435 Bridge ABI, but the emitter address is now the router:

- `FraudChallengeSubmitted(indexed bytes20, bytes32, uint8, bytes32, bytes32)`
- `FraudChallengeDefeated(indexed bytes20, bytes32)`
- `FraudChallengeDefeatTimedOut(indexed bytes20, bytes32)`

### P2TRSignatureFraudRouter-emitted events (datasource not yet wired)

P2TR fraud path mirrors the ECDSA one, emitted by the P2TR router
sidecar after deployment. Event names: `P2TRSignatureFraudChallengeSubmitted`,
`P2TRSignatureFraudChallengeDefeated`,
`P2TRSignatureFraudChallengeDefeatTimedOut`.

### BridgeLifecycleRouter-emitted events (datasource not yet wired)

The Bridge-side hooks for `BridgeLifecycleRouter` ship in PR #971, but
the router contract itself is a follow-up. Specific router events
depend on that ABI; document them when the router deployment PR lands.

### FrostWalletRegistry-emitted events (B-1 dependency)

PR #971 ships the FROST wallet registry contract and its DKG-result
events. Subgraph/indexer wiring for those events belongs to the
registry activation workstream; see `wallet-registry-trust-model-rfc.md`
(#437).

## Recommended schema additions

The following entity additions (or new entities) are recommended;
the exact GraphQL shape is a sub-phase design decision.

### Existing Wallet entity — add scheme

```graphql
enum WalletScheme {
  ECDSA
  FROST
}

type Wallet @entity {
  # ... existing fields ...
  scheme: WalletScheme! # NEW — defaults to ECDSA for pre-C-2 records
  xOnlyOutputKey: Bytes # NEW — populated only for FROST wallets
}
```

The default value for pre-C-2 records (which lack a recorded
scheme) is `ECDSA`. Subgraphs already populating `Wallet.ecdsaWalletID != bytes32(0)` can use that as the migration heuristic for
back-fill (`ecdsaWalletID == 0` ⇒ FROST). The C-1.1 subgraph PR
should set this at write time in `handleNewWalletRegistered` (=
ECDSA) and `handleNewFrostWalletRegistered` (= FROST).

### New BridgeState singleton

```graphql
type BridgeState @entity {
  id: ID! # always "singleton"
  ecdsaWalletCount: BigInt! # derived from NewWalletRegistered replay
  frostWalletRegistry: Bytes # null until FrostWalletRegistrySet fires
  ecdsaFraudRouter: Bytes
  p2trFraudRouter: Bytes
  lifecycleRouter: Bytes
}
```

### New WalletSchemeChange audit entity (optional)

If audit trails matter for governance review:

```graphql
type WalletSchemeChange @entity {
  id: ID! # txHash-logIndex
  scheme: WalletScheme!
  changedAt: BigInt!
  changedAtBlock: BigInt!
  transactionHash: Bytes!
}
```

## Sequencing checklist

Recommended cutover sequence for C-1 work:

- [x] C-1.1a (preparation): Update `data/tbtc-subgraph/abis/Bridge.json`
      with the merged legacy + post-#439 Bridge ABI (legacy fraud
      events kept for historical indexing per Codex P1). Add new
      Bridge event handlers (`NewFrostWalletRegistered`,
      `FrostWalletRegistrySet`, `EcdsaFraudRouterSet`,
      `P2TRFraudRouterSet`, `LifecycleRouterSet`,
      `LegacyFraudChallengeMigrated`). `NewWalletSchemeSet` remains in
      the ABI but no longer fires in the canonical mirror. Add schema
      entries (`Wallet.scheme`, `BridgeState` singleton). **PR #440
      (this).**
- [ ] C-1.1b (cutover): Add EcdsaFraudRouter,
      P2TRSignatureFraudRouter, BridgeLifecycleRouter datasources
      to `subgraph.yaml` + `networks.json` with their deploy
      addresses. Add handlers in `src/`. Re-deploy.
- [x] C-1.1c (canonical reconciliation): Do not add an
      `EcdsaWalletCountSeeded` handler. The event and seed flag were
      dropped/deferred indefinitely; historical ECDSA counts are
      derived from `NewWalletRegistered` replay.
- [ ] C-1.2a (preparation): Same shape as C-1.1a for
      `data/v3-indexer/`.
- [ ] C-1.2b (cutover): Same shape as C-1.1b for `data/v3-indexer/`.
- [ ] C-1.3 (already done in #435): Watchtower wired against the
      router via duck-typed interface. Production deploy of the
      watchtower picks up the router address from runtime config at
      cutover.
- [ ] (External) Contract upgrade deployed on Sepolia → mainnet.
- [ ] (External) Sidecar contract addresses captured into the
      deployment record.
- [ ] C-1.4: cross-chain Taproot reveal support. Upgrade each destination
      depositor event/payload, the corresponding L1 depositor reveal tuple,
      and the relayer so `walletXOnlyPublicKey` and
      `refundXOnlyPublicKey` reach the Bridge's Taproot reveal entry point.
      Update deployment artifacts and enable the SDK adapter capability only
      after an end-to-end staging reveal, sweep, and mint succeeds. Until then,
      the SDK must reject P2TR before returning a deposit address.
- [ ] C-1.5: backend Bridge interface retargeting (if needed).
- [ ] C-1.6: SDK type rename, fold into the next breaking-change SDK
      release.

## Open questions

1. **Does the v3-indexer use an ingestion model that supports dynamic
   dataSources?** If yes, the C-1.2b cutover work can be triggered by
   the on-chain `EcdsaFraudRouterSet` / `P2TRFraudRouterSet` /
   `LifecycleRouterSet` events at runtime rather than requiring a
   redeploy with a new manifest.
2. **Should `Wallet.scheme` default to `ECDSA` for pre-C-2 records via
   subgraph migration, or be left nullable?** Defaulting is cleaner
   for downstream queries that don't want to handle nulls but
   requires a one-time grafting / re-sync; nullable preserves
   indexer compatibility at the cost of consumer complexity.
3. **Which destination is upgraded first for cross-chain Taproot deposits?**
   The relayer and both destination/L1 depositor contracts require explicit
   Taproot reveal support. All legacy routes remain disabled until a destination
   completes the C-1.4 readiness checklist.

## Out of scope for C-1

- B-1 implementation events (the FROST wallet registry contract).
  Those land with B-1.
- D-1 / D-2 retirement events. Out of C-1's scope. **Updated
  post-D-2.2 (2026-05-25):** the only retirement event the
  shipped contracts declare is `EcdsaRetired` on `BridgeState`;
  D-2.2 dropped the `emit EcdsaRetired()` in
  `Bridge.retireEcdsa()` to fit the public `ecdsaRetired()`
  getter under EIP-170, so the event never actually fires.
  The hypothetical `EcdsaFinalized` event was never shipped —
  the v6 `finalizeEcdsaRetirement(bytes20[])` function it would
  have been emitted from was dropped entirely (v7 RFC
  reconciliation; see
  [`scheme-preference-and-retirement-rfc.md`](./scheme-preference-and-retirement-rfc.md)).
  C-1 indexer's responsibility is unchanged either way: this
  PR does not subscribe to retirement events; consumers
  poll `Bridge.ecdsaRetired()` instead.
- Cross-chain L2 indexer mirroring (separate L2-specific PRs).
