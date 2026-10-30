# Fixes for the PR #1116 reservation findings

These are the fix commits that ship with this PR, one per finding. Each one changes protocol
behaviour, so each needs the authors' review. Findings and evidence: `solidity/docs/audit/pr-1116-reservations.md`.

| Finding | Change in one line |
|---|---|
| R-50 | The parameter setter rejects action timeouts of 14,401 s or less. |
| R-09 | Acceptance requires `amount > minAmount + 2 * txMaxFee`. |
| R-08 | Settlement onto a Closing wallet no longer strands the position. |
| R-07 | Stranding on a Closing wallet also waits out the wallet's closing period. |
| R-12 | Anyone can strand an expired position on a Live wallet. |
| R-13, R-14 | Wallet exits count proven anchors (`walletAnchoredInfo`), not pending capacity. |
| R-01 | An acceptance request must prove the deposit's funding transaction. |

## Verification

- Before/after: for every finding except R-01, the regression tests were run
  on the fixed contract (pass) and with the touched contract files swapped
  back to the audited version (the named tests fail). R-01 changes the router
  ABI, so the original PoC (7 tests showing the capacity exhaustion) cannot
  compile against the fixed router and is not published; its guard,
  `test/audit-poc/F01FakeDepositCapacity.t.sol`, ships instead.
- Foundry, `test/{fizz,fizz-periphery,audit-poc}/**` on the fix line
  (`bun scripts/audit-gate.ts`, the fix branch rebased on the audit branch):
  GATE PASS, 46 suites, 259 tests, 0 failed. The branch carries
  the audit branch's guard tests (`RequireBoundaryGuards`, `AccessControlGuards`)
  and the campaign-11 SP-65 replays, moved to the fixed behavior (see "Other
  test changes").
- Storage layout: `scripts/update-storage-layout-snapshot.ts` regenerated the
  snapshot and its upgrade-safety check against the deployed TIP-109 Bridge
  layout passed.
- Hardhat: `test/bridge/*.test.ts`, `test/vault/*.test.ts` and
  `test/deploy/98_*.test.ts` (40 files): 2160 passing, 0 failing. The
  reservation subset alone: 270 passing. See "Other test changes" for the
  Hardhat tests that changed.
- `npx tsc --noEmit -p .`: no errors outside the stale generated `typechain/`
  and the `bun:test` import, same as the audit branch.
- Fork rehearsal (`scripts/fork-rehearsal/rehearse.sh`, mainnet fork at block
  26103363, RPC from the environment): 60 of 61 checks pass. The one FAIL is
  V3, the intentional launch-parameter result (90-day default term against a
  150-day reveal-ahead period; V3a to V3d then run with the workaround).
  V4 and V5 now check the R-01 change on the fork: a request without a valid
  funding proof reverts and reserves no capacity.

## R-50: minimum action timeout

- Root cause: `updateReservationParameters` accepted any timeout above the
  2 h request safety margin. At 7,201 s no request has a signing second;
  up to 4 h + 1 s a deposit revealed in the request block has none.
- Fix: require `reservationActionTimeout > REQUEST_TIMEOUT_SAFETY_MARGIN +
  DEPOSIT_MIN_AGE + 1` (more than 14,401 s). `deploy/98`, the rehearsal
  validator and both fuzz handlers mirror the bound.
- Not taken: a larger floor (for example a day); the value is governance's
  choice, this is the smallest bound that keeps every request signable.
- Behaviour change: governance can no longer set 7,201 to 14,401 s.
- The in-function signing-window `require`s stay as defense in depth; the
  earlier mutation guards for them became equivalent and were replaced.
- Tests: `AcceptanceSigningWindowBoundary.t.sol` (rejects 7,201 s and
  14,401 s; the smallest admitted value accepts fresh and old deposits),
  `ReanchorSigningWindowBoundary.t.sol`, the `deploy/98` test.

## R-09: acceptance floor

- Root cause: acceptance admitted `amount >= min + fee` while a re-anchor
  needs `anchor > min + fee`; after a full-fee acceptance proof the anchor
  could sit in `[min, min + fee]` and never move.
- Fix: `amount > min + 2 * fee` (Halmos `check_SP85_fixB_...`).
- Not taken: lowering the re-anchor floor (it bounds cumulative fee
  grinding; an earlier review restored it on purpose).
- Behaviour change: deposits in `[min + fee, min + 2 * fee]` are no longer
  reservable.
- Limit: an anchor can still reach the floor band through later re-anchor
  hops that pay fees; that is the designed grind cap.
- Tests: `R09AcceptanceFloor.t.sol`, `Reservation.test.ts` guard 11, the SP-85
  replays (`FoundryTester`, `C5Known`) now expect no assertion.

## R-08: Closing is not terminal at settlement

- Root cause: `strandLateSettlementIfTargetWalletClosed` stranded a newly
  settled anchor when its wallet was Closing, about 91 days before
  `notifyReservationStranded` would allow it, and took the re-anchor right
  away.
- Fix: strand at settlement only on Closed and Terminated wallets.
- Behaviour change: a position settled onto a Closing wallet stays Active,
  pins the wallet in Closing and can be re-anchored.
- Tests: `F09to11ClosingWalletStrands.t.sol` (inverted), and
  `StrandedLateReanchorSettles.t.sol` test 2 (now settles Active).

## R-07: exclusive re-anchor window on Closing wallets

- Root cause: once a position passed `dissolutionEligibleAt`, anyone could push
  its Live wallet to Closing and strand it in one transaction.
- Fix: on a Closing wallet, `notifyReservationStranded` also needs
  `block.timestamp >= closingStartedAt + walletClosingPeriod`.
- Not taken: a new window parameter (storage and governance surface for no
  gain; the closing period already exists and is the time the wallet has to
  hand off its funds).
- Behaviour change: positions on a Closing wallet get at least one closing
  period to re-anchor before anyone can strand them.
- Tests: `F08StrandBeforeReanchor.t.sol` (one-transaction strike reverts; no
  strand inside a re-anchor cooldown).

## R-12: release path for expired positions on Live wallets

- Root cause: `notifyReservationStranded` refused Live wallets and
  milestone 1 had no other release path for a position, so an expired position
  on a Live wallet held capacity forever.
- Fix: allow the strand on a Live wallet once `dissolutionEligibleAt` has
  passed. No extra window: only governance can re-anchor from a Live wallet.
- Behaviour change: anyone can release an expired position on a Live wallet;
  the owner keeps the minted tBTC, the anchor stops being tracked.
- Tests: `R12LiveExpiryRelease.t.sol`, `Bridge.ReservationOccupancy.test.ts`;
  property SP-95 now checks that the release path exists (static call).

## R-13 and R-14: proven custody in wallet exits

- Root cause (R-13): `moveFunds` sent a zero-BTC wallet to MovingFunds when
  `walletReservationInfo.count > 0`, which includes capacity reserved for
  pending acceptance and re-anchor targets. Anyone could load an empty wallet
  and push it into MovingFunds, where its operators risk the moving-funds
  timeout slash.
- Root cause (R-14): `notifyWalletCloseable` read only the main UTXO, so a young
  wallet holding large anchors looked empty.
- Fix: new `BridgeState.walletAnchoredInfo` (count and amount of proven
  anchors per wallet), kept in step at acceptance, re-anchor settlement,
  late-settlement reconstruction, strand and close. `moveFunds` routes on its
  count; `notifyWalletCloseable` adds its amount to the balance.
- Storage: one mapping appended after `reservationActions`; `__gap` shrinks
  from 39 to 38. Snapshot regenerated, upgrade-safety check passed.
- Deliberately unchanged: `notifyMovingFundsBelowDust` still ignores anchors.
  It is the only slash-free exit for a MovingFunds wallet that holds anchors
  but no main UTXO; counting anchors there would leave such a wallet only the
  slashing timeout; the below-dust exit keeps ignoring anchors (SP-107).
- Behaviour change: a zero-BTC wallet loaded only with pending capacity goes
  straight to Closing (it still cannot finish closing until the pending
  action settles or times out).
- Tests: `SP106PermissionlessMovingFunds.t.sol` (routes A, B, C now end in
  Closing; R-14 tests), the SP-106 and SP-107 closeable replays (now no
  assertion). The harness model of routing (SP-30, SP-99) now uses proven
  anchors.

## R-01: funding proof before an acceptance request

- Root cause: `revealDeposit` checks no Bitcoin proof, so fabricated reserved
  deposits could request acceptance and fill capacity at gas cost.
- Fix: `ReservationRouter.requestReservationAcceptance(fundingTx,
  fundingProof, fundingOutputIndex, wallet)` validates the SPV proof and
  derives the key from the proven hash; the library function is unchanged.
- Not taken: a refundable bond (an attacker with capital still fills slots,
  and no timeout can be proven fake); a cap on unproven capacity (bounds the
  damage, does not stop it).
- Behaviour change (breaking API): every acceptance caller must send the
  funding transaction and its proof, and must wait for the confirmations the
  relay requires.
- Tests: `F01FakeDepositCapacity.t.sol` rewritten (unproven funding tx and a
  borrowed proof both revert with capacity unchanged; the proof binds the
  key; a proven deposit is accepted). All other callers migrated.
- Harness limit: the fizz relay accepts any `BtcBuilder` proof, so in the
  fuzz harness every revealed deposit counts as confirmed and SP-94 (fake
  capacity) cannot show the fix; only the F01 tests can.
- Fork rehearsal: V4 now checks that a request without a valid proof reverts
  on the real mainnet relay; V5 checks that it reserves nothing. The former
  V5 (a depositor's request succeeds) needs a funding transaction confirmed
  on Bitcoin and cannot run with the rehearsal's fabricated one. Not run
  here (needs an RPC).

## Other test changes on this branch

- C10 SP-62 replay (R-54) removed: R-09 and R-50 changed the handler clamps,
  so its shrunk seeds no longer reach the state. R-54 is not changed by these
  fixes and stays open; the audit branch keeps the replay.
- Rebase: `RequireBoundaryGuards` moved to the R-01 call, and the fix
  changed its three guards. The old exact-minimum acceptance guard is
  now "smallest admitted anchor accepted" (`min + txMaxFee + 1`). The R-50
  setter guard pins the new 4 h + 1 s bound. The exact re-anchor floor stays
  reachable (a re-anchor may spend up to `txMaxFee`), so its guard accepts
  `min + 2 * txMaxFee + 1`, re-anchors with a fee of 1 to `min + txMaxFee` and
  expects the next re-anchor to be refused. The cooldown guard reaches
  MovingFunds through a heartbeat failure, because a position with a proven
  anchor now routes there.
- The two campaign-11 SP-65 replays (`test/fizz/repro/C11Repro.t.sol`) are
  flipped: the late settlement onto a Closing wallet now succeeds and leaves
  the position Active on that wallet, and the test checks that state so a
  drifted replay cannot pass.
- Hardhat: 20 reservation tests failed after the fixes.
  - 17 seed an Active (proven) position with test setters and then strand or
    re-anchor it; they underflowed the new `walletAnchoredInfo` ledger. They
    now seed it: a new `setWalletAnchoredCounters` on `TestReservation` and
    `TestReservationProofs`, and `ReservationStrandingExecutor._seedReservation`
    seeds it for Active states. The capacity setters do not write the
    anchored ledger, because the two ledgers mean different things.
  - 3 asserted the old behavior and now assert the fixed one: a settlement
    onto a Closing wallet does not strand (R-08, two tests), and a zero-BTC
    Live wallet goes to MovingFunds only with a proven anchor (R-14).
  - Added counterparts: a settlement onto a Closed wallet still strands;
    a zero-BTC Live wallet with only pending capacity goes to Closing.

## Open points for the authors

1. R-01 is a breaking API change for depositors and relayers.
2. R-13/R-14 add a storage mapping (layout change, one gap slot).
3. R-12 lets anyone strand an expired Live-wallet position; confirm this is
   the intended milestone-1 release path.
4. R-07 reuses the wallet closing period as the re-anchor window; a separate
   parameter is possible if the authors want a different length.
5. R-54 and the RebateStaking bounds (section 4 of the report) are not part
   of this branch.
6. Fuzzing the fix branch (campaign 12) found no new problem in the fixes.
   Harness changes only: SP-95 probe gas cap, Echidna `testMaxGas`, SP-66 and
   SP-96 aligned with R-07, R-12 and timed-out sweeps.
