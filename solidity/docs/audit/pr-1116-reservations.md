# PR #1116 audit: reservation upgrade findings

Report for the authors of PR #1116 (`reservations-upgrade`) in `threshold-network/tbtc-v2`.
Audited PR head: `eec999aa` (all findings below describe that head unless noted).
Current PR head at the time of writing: `c27b7128` (see "Status at the current head").
Report date: 2026-10-08; status block updated 2026-10-15.

## Scope

This report covers the reservation upgrade in PR #1116. R-01, R-07, R-08, R-09, R-12, R-13, R-14, R-21,
R-48, R-49, R-50, R-51 and R-54 are the items in this PR's own code, its deployment order and its parameter
floors; every code finding has a fix in this PR or a documented design answer, except R-21 (see section 6).

Findings against contracts and peripherals that are not part of this upgrade (the L1/L2 depositors, the
yearn strategies, the cross-chain pools, the rebate accounting) are reported privately to the maintainers and
are out of scope here. The register IDs (R-NN) are kept stable so the two records can be cross-referenced;
the public IDs are the ones in this report.

## Status at the current head (2026-10-15)

- **Fixes are in the PR.** Public head `c27b7128` contains the fix commits by subject: proof before the
  acceptance request (R-01), proven anchors in wallet exits (R-13, R-14), release on Live wallets (R-12),
  closing period for Closing-wallet positions (R-07), settled positions stay re-anchorable (R-08),
  acceptance amount floor (R-09), action-timeout signing window (R-50), and the deploy-script guard that
  rejects terms with no reserved-reveal window (R-49, matched by subject).
- **The audited fix line and the PR agree on production code.** Of 74 files under `solidity/contracts` that
  differ between the fix line and `c27b7128`, 71 are identical after stripping comments and whitespace (the
  raw differences are prettier line wrapping and removed finding IDs in comments). The other 3 are
  test-support contracts: `ReentrantRefundReceiver.sol` and `ReentrantReimbursementReceiver.sol` exist only
  in the PR, and `TestReservation.sol` has two extra helpers in the PR. This compares source text, not
  compiled bytecode.
- **CI.** Run 38706744436 on `c27b7128`: `contracts-build-and-test`, `contracts-format`, `contracts-foundry`,
  `contracts-slither`, `contracts-deployment-dry-run` and `contracts-gate-report` all succeeded. That is one
  run. Earlier runs failed in the cross-chain Wormhole/NTT tests, which the PR does not touch.
- **Lint policy change in the PR.** The solhint `--max-warnings` cap was raised from 55 to 62 and the
  policy-test baselines were set to ordering 51 and `payable-fallback` 1. Authors and reviewers need to
  accept that.
- **Rollout.** Section 2 states the order: new `BridgeGovernance`, then the 48 h transfer, before `deploy/98`
  actions. No reservation runbook in the repo states it. `deploy/98` takes `BridgeGovernance` from the
  deployments record and checks only its `owner()`; it never calls `Bridge.governance()`, which exists
  (`Governable.sol:25`). The rebate runbook `docs/bridge-rebate-governance-deployment.adoc` documents the
  same handoff for the rebate change only. `deploy/98`'s own deploy function was not run on a fork; its
  action list was.
- **Still open for the authors:** R-01 breaks the API; R-13 and R-14 change storage (`__gap` 39 to 38); R-12
  is permissionless; R-07 reuses `walletClosingPeriod`; R-54 and the RebateStaking setter bounds are not
  fixed. R-09 is fixed at the deposit minimum, but an anchor can still reach the floor band through later
  re-anchor hops that pay fees; the fix notes call that the designed cap on cumulative fee grinding, so the
  SP-85 fuzz property stays in the known-failing set.

## 1. Summary and scope

### 1.1 Scope of audit activities
The audit evaluated the reservation upgrade and the surrounding tBTC v2 contracts:

- **Loop scan**: a 5-pass automated auditor scan, supplemented by deduplication, rerun verification and
  addendum evaluations. The scan runs are an internal record and are not part of this report.
- **Core fuzz suite (`test/fizz/`)**: 154 invariant properties (117 `SHOULD-HOLD`, 37 `EXPLORATORY`) across
  182 handlers targeting Bridge, Reservation, ReservationProofs, ReservationRouter, ReservationVault,
  Deposit, DepositSweep, Redemption, Wallets, MovingFunds, Fraud, RebateStaking, RedemptionWatchtower, Bank
  and TBTCVault (`solidity/fizz_data/report.md`). Evaluated across 9 Medusa campaigns and multiple Echidna
  campaigns, plus a long-run campaign 10 (2026-10-08: Medusa 1 h, 1.27 M calls; Echidna 2 h, 877 k calls) on
  `FuzzTesterLongRun`, which skips the nine known-failing properties so the fuzzers explore past them.
  Campaign 10 first confirmed R-01 by fuzzing (SP-94) and produced R-54, plus two rebate findings that are
  reported privately.
- **Periphery fuzz suite (`test/fizz-periphery/`)**: 105 invariant properties (74 `SHOULD-HOLD`, 31
  `EXPLORATORY`) across 270 handlers targeting 22 auxiliary and cross-chain contracts
  (`solidity/fizz_data_periphery/report.md`).
- **Halmos symbolic execution (`test/halmos/`)**: 27 symbolic checks verifying arithmetic boundaries,
  counterexamples, and proposed parameter bounds for reservation floors, rebate caps and rolling windows
  (`solidity/test/halmos/README.md`).
- **Mutation testing (`slither-mutate`)**: 931 mutants in the primary pass (`RR`, `CR`), 630 in the targeted
  pass (`ROR`, `LOR`, `MIA` on `Reservation` and `ReservationProofs`), 196 in a third pass, 80 in a fourth
  pass, and a fifth pass with `RQB` (94 mutants), `MRM` (9) and `SBR` (130). All 252 uncaught mutants were
  triaged against the Hardhat suites; 40 real test gaps are closed by Foundry guard tests in
  `test/audit-poc/` (`solidity/fizz_data/mutation/TRIAGE.md`). None of them is a defect in the PR code.
- **Fix commits**: code fixes for R-01, R-07, R-08, R-09, R-12, R-13, R-14 and R-50 in this PR, one commit
  per finding, each with its PoC turned into a regression test. Designs, behaviour changes and evidence:
  `.solidity-auditor/FIXES.md`.
- **Fork rehearsal (`scripts/fork-rehearsal/`)**: full upgrade replay on an Anvil fork at Ethereum mainnet
  block 26103363 through the actual governance path (`solidity/scripts/fork-rehearsal/README.md`).
- **AST call-target and storage compatibility**: bytecode scan across 25 call targets, Bridge proxy storage
  layout checks, and ABI diffs (`solidity/scripts/call-target-check.ts`).

### 1.2 Evidence-level legend
- **[Confirmed via PoC]**: an executable Foundry or Hardhat test in `test/audit-poc/` or subproject
  directories demonstrates the root cause and impact.
- **[Confirmed via fuzz replay]**: a deterministic test replays a Medusa or Echidna counterexample.
- **[Confirmed via Halmos]**: Halmos 0.3.3 proved the mathematical condition symbolically or generated a
  concrete counterexample.
- **[Verified on fork rehearsal]**: verified against live Ethereum mainnet state at block 26103363.
- **[INFERENCE]**: an unobserved state, default assumption, or parameter extrapolation.

## 2. Deployment blockers

These two items prevent a successful upgrade if not addressed in the deployment runbook and configuration.

```
+-----------------------------------------------------------------------------------+
|                           DEPLOYMENT ORDERING DEPENDENCY                          |
|                                                                                   |
|  1. Deploy new BridgeGovernance                                                   |
|     + Safe initiates 48 h governance transfer                                     |
|     (rehearsal checks 1-2 on each Safe)                                           |
|                                                                                   |
|  2. Upgrade RebateStaking implementation via Timelock (24 h delay)                |
|     (prevents TBTCVault redemption reverts; rehearsal checks X0 to X7)            |
|                                                                                   |
|  3. Upgrade Bridge implementation via Timelock (24 h delay)                       |
|     (rehearsal checks U1 to U9)                                                   |
|                                                                                   |
|  4. Execute reservation bootstrap actions via deploy/98                           |
|     (requires term >= 150 days; rehearsal checks V3b to V5)                       |
+-----------------------------------------------------------------------------------+
```

### R-48: Bridge upgrade requires the RebateStaking upgrade first
- **Location**: `Redemption.sol:270-286` (used at `:595-598`), `scripts/fork-rehearsal/rebate.ts`.
- **Root cause**: the upgraded Bridge (`Redemption.isRebateAuthorizedForRedemption`) calls
  `RebateStaking.isRebateAuthorized` (selector `0x96253dad`) during `TBTCVault.unmintAndRedeem` when the
  treasury fee divisor is non-zero, `rebateStaking` is set, and `balanceOwner != redeemer`. The live mainnet
  `RebateStaking` implementation (`0x25aAF04229f77A9AE80430b3C89E3455Ab2ec22F`) does not implement selector
  `0x96253dad`. Upgrading the Bridge before RebateStaking causes third-party vault redemptions to revert
  unconditionally.
- **Governance requirement**: the live `BridgeGovernance` (`0xcBCFA3eb5E067173b262ACe62f9dD87f1D2Cc0Cf`) has
  no reservation selectors and rejects `deploy/98` calldata. The deployment sequence must be:
  1. deploy the new `BridgeGovernance` and execute the 48-hour governance transfer
     (`beginBridgeGovernanceTransfer` -> `finalizeBridgeGovernanceTransfer`);
  2. upgrade `RebateStaking` through Council Safe -> Timelock (24 h delay) -> `ProxyAdmin.upgrade`;
  3. upgrade `Bridge` through Council Safe -> Timelock (24 h delay) -> `ProxyAdmin.upgrade`;
  4. send the six reservation configuration actions from `deploy/98` to the new `BridgeGovernance`.
- **Evidence and check IDs**: AST call-target scan marked `call:RebateStaking.0x96253dad` MISSING; fork
  rehearsal checks X0 to X7 (X1 confirms redemption reverts with the Bridge upgraded alone; X3 to X7 confirm
  successful redemption after the RebateStaking upgrade); governance checks 1-2 on each Safe.

### R-49: A reservation term shorter than the deposit reveal-ahead period reverts all reserved reveals
- **Location**: `Deposit.sol:219-251` (`_revealDeposit`), `deploy/98_generate_reservation_mainnet_calldata.ts:444-484`.
- **Root cause**: `Deposit._revealDeposit` requires `refundLocktime >= revealTime + depositRevealAheadPeriod`
  (live mainnet value is 12,960,000 s = 150 days). For reserved deposits, it also requires
  `refundLocktime <= revealTime + reservationTermSeconds + 24h`. If the reservation term is set to the
  rehearsal default of 90 days (7,776,000 s) or any term below 149 days, the valid reveal window is
  mathematically empty. Every reserved deposit reveal reverts with "Refund locktime too far in the future for
  a reservation".
- **Resolution**:
  1. the launch reservation term must be configured to at least 150 days (13,132,800 s / 152 days was
     verified on the fork);
  2. a validation guard was added in `deploy/98_generate_reservation_mainnet_calldata.ts` (commit
     `2dca0610`), reading `Bridge.depositParameters()` on-chain and throwing if `term + 24h <= aheadPeriod`.
- **Evidence and check IDs**: fork rehearsal check V3 (fails on a 90-day term), V3a (confirms the on-chain
  revert), V3b (raises the term to 13,132,800 s), V3c to V5 (confirms successful reveal, reservation tagging
  and acceptance); Hardhat deploy tests 35 passing (`test/deploy/98_...test.ts`).

## 3. Confirmed findings

| ID | Title | Component | In PR diff | Stated impact | PoC / repro source |
|---|---|---|---|---|---|
| R-01 | Reservation capacity admitted without proof of funding | `Reservation.sol:493`, `Deposit.sol:380` | Yes | Griefing DoS / capacity exhaustion | `test/audit-poc/F01FakeDepositCapacity.t.sol` (7 tests); also found by fuzzing in campaign 10 (SP-94, `test/fizz/repro/C10LongRun.t.sol`) |
| R-07 | Reservation strand allowed before reanchor execution | `Reservation.sol:1091`, `ReservationRouter.sol:336` | Yes | Premature stranding | `test/audit-poc/F08StrandBeforeReanchor.t.sol` (5 tests) |
| R-08 | Closing wallet treated as terminal by late-settlement helper | `ReservationProofs.sol:214`, `:586` | Yes | Premature stranding on a Closing wallet | `test/audit-poc/F09to11ClosingWalletStrands.t.sol` (4 tests); fuzz: SP-65 in campaign 11 (`solidity/fizz_data/triage/C11-vacuity.verdict.md`) |
| R-09 | Reanchor amount floor exceeds the acceptance minimum | `Reservation.sol:806`, `Reservation.sol:549` | Yes | Anchors stuck below the reanchor floor | `test/fizz/FoundryTester.sol` (`test_repro_property_activeReservationReanchorable`) |
| R-12 | Expired positions on Live wallets have no release path | `Reservation.sol:1091`, `Reservation.sol:1040` | Yes | Capacity lockup on Live wallets | `test/fizz/FoundryTester.sol` (`test_repro_property_reservationCapacityHasReleasePath`) |
| R-13 | Wallet-move gate counts unproven pending actions as custody | `Wallets.sol:613` | Yes | Permissionless wallet displacement | `test/audit-poc/SP106PermissionlessMovingFunds.t.sol` (13 tests) |
| R-14 | Wallet balance helper ignores reservation anchors | `Wallets.sol:722`, `MovingFunds.sol:610` | Yes (custody new) | Forced wallet closure / anchor griefing | `test/fizz/repro/C5Known.t.sol` (`test_repro_sp107_belowDustExitIgnoresAnchors`) |

### Grouped detail: reservation capacity and stranding mechanics

- **R-01**: `revealDeposit` registers deposit keys without verifying funding UTXO validity. An attacker
  revealing fake deposits can call `requestReservationAcceptance` across all Live wallets to exhaust
  `reservationMaxTotalAmount` and per-wallet caps at zero capital cost.
  - *Fix*: gate acceptance requests with an SPV proof (implemented) or a fee bond (not taken).
- **R-07**: when an active reservation reaches `dissolutionEligibleAt`, anyone can call
  `notifyWalletCloseable`, `notifyMovingFundsBelowDust` and `notifyReservationStranded` within a single
  transaction. This strands the reservation and locks out the depositor's reanchor right.
  - *Fix*: enforce an exclusive reanchor window before permitting public stranding.
- **R-08**: `ReservationProofs.strandLateSettlementIfTargetWalletClosed` treats `Closing` wallets as
  terminal. Settling a valid late SPV proof onto a wallet in `Closing` state immediately strands the anchor.
  - *Fix*: allow positions on `Closing` wallets to remain active, or grant a reanchor window.
- **R-09**: acceptance allows deposits down to `minAmount + txMaxFee`, but reanchoring strictly requires
  `anchorAmount > minAmount + txMaxFee`. Anchors in `[minAmount, minAmount + txMaxFee]` cannot be moved.
  - *Fix*: adjust the deposit minimum to `> minAmount + 2 * txMaxFee` (see section 4).
- **R-12**: `notifyReservationStranded` requires the source wallet to not be `Live`. An expired position on
  a `Live` wallet cannot be stranded or closed because `closeReservation` has no external caller.
  - *Fix*: provide a caller or explicit expiry cleanup for Live-wallet reservations.
- **R-13 and R-14**: `Wallets.getWalletBtcBalance` checks only the main UTXO. A wallet with zero main UTXO
  but custodying active reservation anchors can be permissionlessly transitioned from `Live` ->
  `MovingFunds` -> `Closing`. Conversely, pending unproven requests count as active custody in
  `Wallets.moveFunds`.
  - *Fix*: incorporate `walletReservationInfo[w].amount` into the balance checks and ignore unproven
    actions (implemented as the `walletAnchoredInfo` ledger).

## 4. Proposed bound fixes

All candidate bounds are suggestions based on Halmos symbolic proofs. Concrete parameter choices remain
governance decisions.

```
+-----------------------------------------------------------------------------------+
|                        SUMMARY OF PROPOSED BOUND FIXES                            |
|                                                                                   |
|  1. SP-85 Fix B (Reservation.sol:549)                                             |
|     require(deposit.amount > minAmount + 2 * txMaxFee)                            |
|     (Halmos check: check_SP85_fixB_strictDepositMinimumClosesGap)                 |
|                                                                                   |
|  2. R-50 Action Timeout Floor (Reservation.sol:1292)                              |
|     require(reservationActionTimeout >= SAFETY_MARGIN + MIN_AGE + 1)              |
|     (Audit-PoC: AcceptanceSigningWindowBoundary.t.sol)                            |
+-----------------------------------------------------------------------------------+
```

The RebateStaking setter bounds that the audit also proposed are reported privately and are not part of
this PR.

### 4.1 SP-85: reservation reanchor floor gap
- **Issue**: `requestReservationAcceptance` admits deposits where `deposit.amount >= minAmount + txMaxFee`.
  After deducting `minerFee <= txMaxFee`, the anchor amount can equal `minAmount + txMaxFee`. Because
  `requestReservationReanchor` strictly enforces `anchorAmount > minAmount + txMaxFee`, that anchor cannot be
  reanchored.
- **Halmos analysis (`ReservationFloor.t.sol`)**:
  - `check_SP85_currentCode_admittedAnchorIsReanchorable_expectedCounterexample`: confirms a counterexample
    on the current code.
  - `check_SP85_currentCode_stuckAnchorsLieInTheBand`: proves stuck anchors lie in
    `[minAmount, minAmount + txMaxFee]`.
  - `check_SP85_fixB_strictDepositMinimumClosesGap`: proves `deposit.amount > minAmount + 2 * txMaxFee`
    prevents all stuck anchors.
  - `check_SP85_fixAB_geqFloorWithNonStrictMinimumClosesGap`: proves relaxing the reanchor floor to
    `>= minAmount + txMaxFee` combined with `deposit.amount >= minAmount + 2 * txMaxFee` also closes the gap.
- **Recommendation**: adopt Fix B (`deposit.amount > minAmount + 2 * txMaxFee` in `Reservation.sol:549-552`).

### 4.2 R-50: action timeout minimum signing window
- **Issue**: `Reservation.updateReservationParameters` (Reservation.sol:1291-1295) only requires
  `reservationActionTimeout > REQUEST_TIMEOUT_SAFETY_MARGIN` (7,200 s). At 7,201 s the signing deadline
  `timeoutAt - 2h` is `now + 1`, and the earliest signing time is at least `now + 1`
  (Reservation.sol:562-576 for acceptance, :787-797 for re-anchor), so the window is empty and every
  acceptance and re-anchor request reverts until governance changes the value. For a deposit revealed less
  than 2 h ago the earliest signing time is `revealedAt + 2h + 1`, so a fresh deposit needs a timeout above
  4 h + 1 s.
- **PoC evidence**: `test/audit-poc/AcceptanceSigningWindowBoundary.t.sol` (5 tests, including the
  fresh-deposit case at 4 h and 4 h + 2 s) and `test/audit-poc/ReanchorSigningWindowBoundary.t.sol`
  (3 tests).
- **Recommendation (suggestion, the value is a choice)**: require
  `reservationActionTimeout > REQUEST_TIMEOUT_SAFETY_MARGIN + DEPOSIT_MIN_AGE + 1` (more than 14,401 s), so a
  request on a just-revealed deposit still has a signing window. The `deploy/98` calldata uses 172,800 s, far
  above this.

## 5. Questions for the authors (rows with no severity yet)

The register rates these rows "needs human review": the behaviour is proven, but whether it is a bug depends
on the design intent. No severity is claimed here. In-PR rows first.

| Row | Fuzz ID | Proven behaviour (repro) | Question |
|---|---|---|---|
| R-14 | SP-107 | `Wallets.getWalletBtcBalance` reads only the main UTXO, so a Live wallet that holds anchors but no main UTXO can be pushed to MovingFunds and then Closing by anyone (`test/fizz/repro/C5Known.t.sol` `test_repro_sp107_belowDustExitIgnoresAnchors`; `test_repro_property_closeabilityCountsAnchors`) | Should the closeability and below-dust exits count reservation anchors? |
| R-13 | SP-106 | `Wallets.moveFunds` counts unproven pending acceptance requests as custody, so a third party can send an empty wallet to MovingFunds instead of Closing (`test/audit-poc/SP106PermissionlessMovingFunds.t.sol`, 13 tests) | Should only proven anchors count as custody? |
| R-12 | SP-95 | A position past `dissolutionEligibleAt` on a wallet that stays Live has no release path for its capacity in milestone 1 (`test_repro_property_reservationCapacityHasReleasePath`, `test_repro_sp95_reanchorLandsEligiblePositionOnLiveWallet`) | Is this capacity meant to stay held until milestone 2 dissolution? |
| R-09 | SP-85 | An anchor at the acceptance floor cannot take a re-anchor hop because of the strict floor at Reservation.sol:806 (`test_repro_property_activeReservationReanchorable`; Halmos `ReservationFloor`) | Fix B (raise the deposit minimum, section 4.1) or a relaxed re-anchor floor? |
| R-21 | GL-24 | When the deferred reimbursement call fails, `AbstractL1BTCDepositor.finalizeDeposit` re-stores the reimbursement in `gasReimbursements[depositKey]` (`test_repro_GL24_poolSwappedToNonPoolContract`, `test_mech_GL24_*`) | Is there a payout path for a re-stored reimbursement, or should the failure be surfaced differently? |

## 6. Real-low and informational rows

| ID | Component | Title / behaviour | Status | In PR diff | Repro / reference |
|---|---|---|---|---|---|
| R-21 | `AbstractL1BTCDepositor.sol:509` | Failed deferred reimbursement re-stored with no payout path | Real-Low; open, no fix in this PR | Yes | S2 GL-24; `test_repro_GL24_poolSwappedToNonPoolContract` |
| R-50 | `Reservation.sol:1291-1295` | Action timeout setter admits a value with no signing window | Informational | Yes | Mutation M-10, M-108, M-112; `AcceptanceSigningWindowBoundary.t.sol`, `ReanchorSigningWindowBoundary.t.sol`; fix in section 4.2 |
| R-51 | `Reservation.sol:1040-1065` | `closeReservation` has no caller in milestone 1 (dead code) | Informational | Yes | Mutation M-38 to M-41, M-109; no call site in `contracts/` |
| R-54 | `Reservation.sol:806-809` | The re-anchor floor uses the current minimum, so after governance lowers `reservationMinAmount` an existing position can re-anchor below the minimum it was accepted under | Design question | Yes | Campaign 10, `test_repro_sp62_anchorBelowSnapshottedMinimum`. Question: is that intended? |

## 7. Test assets offered upstream

The following 22 Foundry test files in `solidity/test/audit-poc/` are available for inclusion in the upstream
repository test suite. They are the files that ran during the audit, byte for byte. Each mutation guard test
passes on clean PR #1116 code and fails when the corresponding mutant is introduced.

Running them needs two things this branch does not carry: `lib/forge-std` (the `foundry.toml` remapping points
at it, and the repository has no `lib/`) and the fuzz harness helpers under `solidity/test/fizz/` that several
of the files import. `foundry.toml` collects `test-foundry` as the Foundry suite, so nothing here runs in CI
until they are wired in deliberately.

| Test file | Pinned invariant / defect guard | Mutation test / origin |
|---|---|---|
| `F01FakeDepositCapacity.t.sol` | Pins fake deposit capacity exhaustion, wallet count caps, and rotational denial of service | Finding F01 (R-01) |
| `F08StrandBeforeReanchor.t.sol` | Pins 1-tx wallet closure and stranding of aged reservations before reanchor execution | Finding F08 (R-07) |
| `F09to11ClosingWalletStrands.t.sol` | Pins immediate stranding of new and late-settled anchors when the target wallet enters `Closing` | Findings F09, F10, F11 (R-08) |
| `SP106PermissionlessMovingFunds.t.sol` | Pins permissionless routing of zero-BTC wallets into `MovingFunds` via fake deposit requests | Finding SP-106 (R-13) |
| `NotifyStaleReservedDepositRouter.t.sol` | Pins `ReservationRouter.notifyStaleReservedDeposit` call forwarding to Bridge | Mutant M-1 |
| `AcceptanceSigningWindowBoundary.t.sol` | Pins lower-bound action timeout signing window and `DEPOSIT_MIN_AGE` floor | Mutants M-10, M-112, M-113 (R-50) |
| `ReanchorSigningWindowBoundary.t.sol` | Pins reanchor signing window boundary and governance cooldown bypass | Mutants M-108, M-115 |
| `ReservationParameterBounds.t.sol` | Pins term bounds (`[90, 730]` days) and renewal window bounds (`(0, term)`) in the setter | Mutants M-110, M-111 |
| `ReservedDepositSkipsRebate.t.sol` | Ensures reserved deposit reveals bypass rebate staking budget consumption | Mutant M-47 |
| `AcceptanceTimeoutOnce.t.sol` | Prevents double capacity release on repeated acceptance timeout notifications | Mutant M-48 |
| `ForceStaleReservedDeposit.t.sol` | Pins `pendingReservedDeposits` counter decrement, vault update event, and governance auth | Mutants M-71, M-75, M-76 |
| `AcceptanceProofUntrustedVault.t.sol` | Pins direct Bank balance crediting when the reservation vault is untrusted at settlement | Mutant M-79 |
| `LateReanchorUnwindsNewerGeneration.t.sol` | Ensures late settlement of older reanchor generations unwinds newer pending actions | Mutant M-84 |
| `LateAcceptanceOccupancy.t.sol` | Pins occupancy event emission and late settlement when the newer generation also timed out | Mutants M-95, M-155 |
| `StrandedLateReanchorSettles.t.sol` | Pins counter restoration during late settlement of stranded positions | Mutant M-97 |
| `ReanchorProofChecks.t.sol` | Pins outpoint tx hash matching at index 0 and suppresses late events on on-time proofs | Mutants M-123, M-135 |
| `ReanchorCumulativeFee.t.sol` | Pins multi-hop cumulative miner fee tracking and vault fee financing | Mutant M-106 |
| `ReservationTimeBounds.t.sol` | Pins the reserved refund-locktime cap at reveal and the late acceptance settlement window | Mutants M-185, M-197 |
| `SweepMainUtxoIndex.t.sol` | Pins that a sweep input with the main UTXO's txid but another output index is rejected | Mutant M-188 |
| `ReservationProofsAccounting.t.sol` | Pins the pending-reserved-deposit counter, the re-anchor fee bound (one satoshi over, and a 50% fee) and the old wallet's count and amount after a re-anchor | Mutants M-200, M-204, M-205, M-207, M-208 |
| `RequireBoundaryGuards.t.sol` | Pins nine `require` boundaries: re-anchor cooldown end, re-anchor floor, per-wallet amount cap, minimum anchor at acceptance, and five reservation parameter setter bounds | Mutants M-212, M-214, M-216, M-221 to M-225, M-230 |
| `AccessControlGuards.t.sol` | Pins the role checks on the acceptance proof (SPV maintainer), both reservation setters (governance) and the vault's `receiveBalanceIncrease` (Bank) | Mutants M-232 to M-235 |

## 8. Limits

- **Mutation operators run**: `RR` and `CR` on all seven PR contracts; `ROR`, `LOR`, `MIA` on `Reservation`,
  `ReservationProofs` and `ReservationRouter` (the router has no mutable site for these operators; its one
  comparison was flipped by hand and is caught); `LOR` and `MIA` on `ReservationVault`, `Wallets`, `Deposit`,
  `DepositSweep`; `AOR`, `UOR` and `SBR` on `Reservation` and `ReservationProofs` (complete); the added `RQB`
  on `Reservation` and `ReservationProofs`; the added `MRM` on `ReservationRouter` and `ReservationVault`.
  Slither's `MWA` negates loop conditions and does not remove modifiers, so `MRM` stands in for
  access-control mutation. Never run: `ASOR`, `BOR`, `MVIE`, `MVIV`, `MWA`, `FHR`, `LIR`.
- **Forge invariant kill command (measured, not adopted)**: a fixed-seed forge `invariant_` entry over the
  reservation ledger properties killed 0 of 6 earlier gap mutants, at both 400 and 25,600 calls. The fuzz
  handlers never build the multi-reservation states those mutants need
  (`solidity/scripts/mutation/README.md`, status 2026-10-12).
- **Slither 0.11.6 `ROR` tool defect**: in Slither 0.11.6 the `ROR` mutator splices statement text into
  `require` condition arguments, producing invalid syntax like `require(require(...))`. 485 compile failures
  in `Reservation` and `ReservationProofs` resulted from this bug. `ROR` results cover `if` statements and
  assignments only.
- **Harness note**: rows the triage classified as test-harness false positives or out-of-model triggers
  (unsatisfiable properties, harness arithmetic, clock jumps past 2106) are documented in the private
  register and are not protocol findings; the harness fixes are in the fuzz trees listed above.
- **Slither triage**: detailed triage of static analysis warnings on PR-changed lines is in
  [pr-1116-slither-triage.md](./pr-1116-slither-triage.md).

## 9. Open points for the authors

1. R-01 is a breaking API change for depositors and relayers.
2. R-13/R-14 add a storage mapping (layout change, one gap slot).
3. R-12 lets anyone strand an expired Live-wallet position; confirm this is the intended milestone-1 release
   path.
4. R-07 reuses the wallet closing period as the re-anchor window; a separate parameter is possible if the
   authors want a different length.
5. R-54 and the RebateStaking setter bounds are not part of this PR.
6. R-21 (section 6) has no fix here: confirm whether a re-stored deferred reimbursement needs a payout path
   in this milestone.