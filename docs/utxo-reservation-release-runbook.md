# UTXO Reservation — Release and Upgrade Runbook

Status: release engineering reference for the settlement-rework stack
(RFC 13). Companion: `docs/rfc/rfc-13.adoc` (architecture),
`docs/utxo-reservation-frozen-spec.md` (frozen parameters/economics),
`docs/utxo-reservation-review-findings.md` (the closed findings).

This runbook covers deploying and activating the UTXO reservation feature,
the proxy-upgrade procedures for the two upgradeable contracts it touches,
the (non-upgradeable) `BridgeGovernance` replacement, and the operational
duties the feature adds. It assumes the stacked PRs
(router → settlement → renewal → backing → guards) are merged in order.

## 1. Component and upgradeability map

| Contract                           | Kind                                       | Change in this feature                                                                                              |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `Bridge`                           | Transparent proxy (impl upgrade)           | New storage, `setReservationRouter`, fallback delegatecall, library link map drops `Reservation` (moves to router). |
| `ReservationRouter`                | Plain contract, delegatecall target        | New. Holds the reservation ABI surface; executes on Bridge storage.                                                 |
| `Reservation`, `ReservationProofs` | Libraries linked by the router             | New / reworked.                                                                                                     |
| `ReservationVault`                 | Plain `Ownable` contract                   | New. Liability-side vault + renewal policy + fee reserve/financing.                                                 |
| `RedemptionWatchtower`             | Transparent proxy (impl upgrade)           | Reserved-objection surface reworked to per-generation keys; imports the reservation types.                          |
| `WalletProposalValidator`          | Plain contract (non-upgradeable)           | New reservation proposal validators; redeploy + repoint.                                                            |
| `BridgeGovernance`                 | Plain `Ownable` contract (non-upgradeable) | New grouped begin/finalize for reservation params + caps.                                                           |

The Bridge and the watchtower are the only upgradeable pieces. Everything
else is a fresh deploy or a redeploy-and-repoint.

## 2. Deployment sequencing (the safe order)

The overriding rule (from the review): **reservations must never activate
on a temporary storage layout that later needs live-state migration.**
Deploy inert, then activate last.

1. **Bridge implementation upgrade** carrying the full reservation storage
   append (all stacked PRs at once — do not ship the storage in pieces).
   The append-only discipline (every field decrements `__gap`, nothing
   reordered) makes this a standard transparent-proxy `upgradeTo`. Run the
   storage-layout parity test (`ReservationRouter.test.ts`) against the
   candidate implementation before submitting.
2. **Deploy the libraries** (`Reservation` linking `ReservationProofs`) and
   the **`ReservationRouter`** (linking `Reservation`). One router instance
   serves the Bridge; it is stateless code.
3. **Wire the router**: `Bridge.setReservationRouter(router)` — one-time,
   governance-gated. Until this is set, every reservation selector reverts
   with `"Unknown function"`; the pooled Bridge is unaffected.
4. **Watchtower implementation upgrade** (per-generation reserved
   objections). Independent of vault activation; can precede it.
5. **Deploy `ReservationVault`** (`95_deploy_reservation_vault.ts`). It
   deploys **with renewals paused** and immediately transfers ownership to
   the governance account. Do not skip the ownership transfer.
6. **Redeploy `WalletProposalValidator`** against the upgraded Bridge and
   repoint the coordinator/maintainer configuration at the new address.
7. **Activation (governance, last):**
   1. `Bridge.setVaultStatus(vault, true)` — trust the vault so deposits
      can be revealed to it.
   2. `BridgeGovernance.beginReservationParametersUpdate(...)` →
      `finalizeReservationParametersUpdate()` after the governance delay,
      setting `reservationVault` to the deployed vault plus the launch
      parameters (see the frozen spec for values).
   3. `BridgeGovernance.beginReservationCapsUpdate(...)` → finalize, setting
      the launch amount caps.
   4. `ReservationVault.updateFeeReserveTarget(target)` — seed the in-kind
      fee reserve target (see §5).
   5. `ReservationVault.setRenewalGuardian(guardian)` — optional; appoint
      the renewal guardian.
   6. `ReservationVault.unpauseRenewals()` — the final switch; renewals
      (and, since the vault is now the reservation vault, the whole
      reservation lane) go live.

Between steps 5 and 7.2 the vault exists but is not the Bridge's
reservation vault, so no deposit can route to it and no reservation state
can be created — the inert window the review requires.

## 3. Bridge proxy upgrade procedure

Standard transparent-proxy upgrade via `BridgeGovernance` /
`ProxyAdmin`, with reservation-specific checks:

- **Pre-flight**: `hardhat compile`; confirm `Bridge` deployed bytecode is
  under 24,576 B (the `contract-sizer` output; current margin ~2.1 kB at
  `runs=100`). Run the storage-layout parity and selector-disjointness
  tests. Run the full suite.
- **Library linking**: the Bridge implementation links six libraries now
  (`Deposit`, `DepositSweep`, `Redemption`, `Wallets`, `Fraud`,
  `MovingFunds`) — **not** `Reservation`; that links into the router. The
  deploy scripts and the TIP-109 deployment test already reflect this.
- **The delegatecall shim**: `hardhat.config.ts` carries a backport of the
  `@openzeppelin/upgrades-core` fix for foreign link-reference splices
  crashing proxy validation. Keep it until the plugin is upgraded past
  1.20.0; removing it early reintroduces the `"Bytecode is not a valid hex string"` failure on unrelated proxy deploys.
- **Post-upgrade**: `setReservationRouter` is idempotent-guarded (reverts
  if already set). Re-pointing the router to new code is itself a Bridge
  implementation change and follows this same procedure — there is no
  governance-parameter path to swap router code, by design.

## 4. RedemptionWatchtower proxy upgrade procedure

- The watchtower's own bytecode links no external library, but its source
  closure now reaches `ReservationProofs`; the deploy script sets
  `proxyOpts.unsafeAllow: ["external-library-linking"]` (the linking is
  upgrade-safe — verified: the watchtower artifact's `linkReferences` is
  empty).
- The reserved-objection surface changed shape (`raiseReservedObjection`,
  `getReservedRedemptionDelay`, `isSafeReservedRedemption` now take a
  generation nonce / are ban-only). No storage layout change: veto and
  objection state reuse the existing `vetoProposals`/`objections` mappings
  under generation-scoped keys. A straight `upgradeTo` suffices; no
  reinitializer.
- Guardian set and parameters are preserved across the upgrade (same
  storage).

## 5. ReservationVault operations

- **Fee reserve**: all custody-fee revenue (initiation, renewal,
  redemption) accumulates in the vault. It finances the Bitcoin miner fees
  of re-anchor and dissolution settlements by burning supply, keeping
  total TBTC matched to the Bitcoin backing. Governance sets
  `feeReserveTarget` (TBTC, 18 decimals); `sweepFees(recipient)` moves only
  the balance **above** the target to the treasury. Seed the target before
  unpausing so the first settlements are covered.
- **In-kind fee debt**: if the reserve is ever short at a settlement, the
  settlement still proceeds and the shortfall becomes public
  `inKindFeeDebtSat`. Monitor it; `repayInKindFeeDebt(amountSat)` (anyone)
  burns it down. A non-zero debt means supply exceeds backing by that
  amount — it is a solvency signal, not a stuck settlement.
- **Renewal policy**: `pauseRenewals`/`blockRenewal` are guardian-or-owner
  and immediate; `unpauseRenewals`/`unblockRenewal`/`setRenewalGuardian`
  are owner-only. All are monotonic on the restrictive side — they never
  shorten a purchased term or move funds.
- **Ownership**: must sit with the governance/timelock domain, never the
  deployer (the deploy script enforces the transfer). `updateFees` is
  owner-gated; apply it only through the governance process. A
  governance-delay wrapper on `updateFees` and a per-position initiation-
  fee snapshot are open follow-ups (tracked in the frozen spec).

## 6. BridgeGovernance replacement plan

`BridgeGovernance` is **non-upgradeable**. The reservation feature adds two
grouped begin/finalize flows (`...ReservationParametersUpdate`,
`...ReservationCapsUpdate`). Adopting them requires **deploying a new
`BridgeGovernance` instance** and transferring Bridge governance to it:

1. Deploy the new `BridgeGovernance` with the same `governanceDelays`
   configuration as the incumbent.
2. From the incumbent governance, `Bridge.transferGovernance(newGov)` (via
   the incumbent's own transfer path).
3. Re-point any owner-of-owner (the Threshold Council / timelock) at the
   new instance.
4. Verify every pre-existing parameter surface still finalizes through the
   new instance (run the governance suite against it) before decommissioning
   the old one.

Because governance transfer is a single Bridge call, there is no window
where the Bridge is ungoverned; the swap is atomic from the Bridge's view.

## 7. keep-core follow-up (gated on ABI publish)

`threshold-network/keep-core#4238` (branch
`feat/utxo-reservation-wallet-support`) adds the coordinator/executor side.
It must be updated for the two-phase ABI before it can drive the feature:

- proposals now carry a **request nonce**; the coordinator must request the
  action on-chain (`requestReservationAcceptance` / `requestReservedRedemption`
  via the vault / `requestReservationReanchor` / `requestReservationDissolution`),
  read back the generation, and only then schedule signing;
- proofs are submitted with `(reservationKey, requestNonce)`;
- the executor must respect the on-chain watchtower-delay gate (do not sign
  a redemption generation before its delay elapses), prioritize valid
  pre-expiry reserved redemptions, drive expired positions toward
  dissolution after pending actions resolve, and never propose dissolution
  before the snapshotted `dissolutionEligibleAt`;
- monitoring should watch `pendingReservedDeposits`, `inKindFeeDebtSat`,
  dissolution-eligible positions, and per-wallet reserved amount/count via
  the new getters.

This is gated on the contracts ABI publishing (typechain from the
published npm artifacts), same as the SDK work.

## 8. Pre-audit checklist

- [ ] Full Solidity suite green (Bridge, vault, governance, watchtower,
      proposal validator, deployment tests).
- [ ] Slither (CI-pinned 0.9.0) reports 0 results.
- [ ] `Bridge` deployed bytecode under EIP-170 with the production safety
      margin; router/libraries each under EIP-170.
- [ ] Storage-layout diff append-only and expected (parity test green).
- [ ] Deployment dry-run on a fork exercises the full activation sequence
      and leaves the vault inert until the final governance steps.
- [ ] `docs/utxo-reservation-frozen-spec.md` parameter values signed off by
      governance (launch values provisionally set 2026-08-09; the two
      `_(pending)_` items — `reservationTxMaxFee`, `feeReserveTarget` — and
      final governance sign-off still outstanding).
- [ ] keep-core executor updated for the two-phase ABI (or explicitly
      out-of-scope for the audit with the feature deployed disabled).
- [ ] Codex (or equivalent) re-review confirms the settlement class from
      the findings doc is resolved.
