# Halmos Symbolic Checks

Symbolic checks for open audit leads, written for Halmos 0.3.3. Everything
here is test-only material; nothing here is wired into CI.

## What Is Here

| File                     | Contract                 | Lead                                                          | Real contract called?                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReservationFloor.t.sol` | `ReservationFloorHalmos` | SP-85 (the re-anchor request floor vs the acceptance minimum) | No. The arithmetic is copied with `file:line` citations, because `requestReservationReanchor` and the acceptance request are external library functions over `BridgeState.Storage`. A change to a cited source line must be mirrored in the copy. `scripts/check-halmos-citations.js` fails when a cited line no longer holds the cited expression. |

The candidate fixes are not in the shipped contracts. They exist only as the
`fixA` / `fixB` functions in `ReservationFloor.t.sol`.

## How To Run

From `solidity/`:

```bash
export FOUNDRY_PROFILE=halmos
halmos --forge-build-out build/halmos --match-contract ReservationFloorHalmos --function check_
```

Profile: `[profile.halmos]` in `foundry.toml` (appended, `profile.default` is
untouched). Halmos 0.3.3 shells out to `forge build --ast --extra-output
storageLayout metadata`, so `FOUNDRY_PROFILE=halmos` makes that build compile
`contracts/` plus `test/halmos/` only, into `build/halmos` (artifacts) and
`cache/halmos` (forge cache). Both are gitignored through `/build/` and
`/cache/`. `--forge-build-out build/halmos` is required because Halmos reads
`out` (its default) and not the Foundry profile. The first run compiles all of
`contracts/` again with AST output; allow a few minutes and a few hundred MB.

Halmos 0.3.3 reads options from `halmos.toml` in the project root, not from
`foundry.toml`; none is added here, so the flags above are explicit.

`ReservationFloorHalmos` has no loops, so no `--loop` bound is needed.

The Foundry gate `forge test --match-path "test/{fizz,fizz-periphery,audit-poc}/**"`
does not match `test/halmos/`, and `forge test` ignores `check_` functions.
`forge build` on the default profile does compile these files.

## Reading Results

- `[PASS] check_x` means no counterexample exists under the assumptions. A
  check whose assumptions are unsatisfiable also passes, so each SP-85 fix
  check has a witness check (`check_SP85_witness_*`) that shows its
  assumptions are satisfiable.
- `[FAIL] check_x ... Counterexample: ...` is the expected outcome for every
  function whose name ends in `_expectedCounterexample`. The code comment on
  each starts with `expected counterexample` and gives an example value.
  Anything else failing is a defect in the check or a changed contract.
- Halmos only treats `Panic(0x01)` (a failed `assert`) as a failure by
  default. The 0x11 underflow and the SafeCast revert are detected explicitly:
  the checks call the contract with a low-level `call`, then assert on the
  success flag and the exact revert data.

## Expected Results

The tables below are the expectations written from reading the sources at the
`reservations-upgrade` head, whose contracts carry the acceptance floor
`deposit.amount > minAmount + 2 * txMaxFee`.

### SP-85: reanchor floor `> txMaxFee + minAmount` against the acceptance minimum

Sources: `Reservation.sol:596-600` (deposit floor
`> minAmount + 2 * txMaxFee`), `ReservationProofs.sol:462-476` (fee at most
`txMaxFee`, anchor at least `minAmount`), `Reservation.sol:900-906` (reanchor
floor, strict), `Reservation.sol:1620-1627` (`txMaxFee > 0`,
`minAmount > txMaxFee`).
Command: `halmos --match-contract ReservationFloorHalmos --function check_`,
profile `halmos`.

| Check                                                                        | Expected                 | Meaning                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check_SP85_currentCode_admittedAnchorIsReanchorable`                        | pass                     | Every anchor that acceptance admits is re-anchorable. The acceptance floor `deposit > min + 2 * fee` leaves every admitted anchor at `> min + fee`, strictly above the re-anchor floor.                                          |
| `check_SP85_currentCode_noAdmittedAnchorLiesInTheStuckBand`                  | pass                     | The same property over the band `[minAmount, minAmount + txMaxFee]`: no admitted anchor lies in it.                                                                                                                              |
| `check_SP85_currentCode_stuckBandIsUnreachable`                              | pass                     | No anchor in the band can be admitted by any deposit. An anchor in the band with `deposit - anchor <= fee` forces `deposit <= min + 2 * fee`, which the acceptance floor rejects.                                                |
| `check_SP85_currentCode_floorAboveUint64AdmitsNothing`                       | pass                     | When `minAmount + 2 * txMaxFee` exceeds `type(uint64).max` no deposit can clear the floor, so no anchor is admitted at all.                                                                                                      |
| `check_SP85_oldFloor_admittedTheStuckBand_expectedCounterexample`            | counterexample           | The witness that the two checks above are not vacuous: the OLD floor (`deposit >= min + txMaxFee`) admitted a deposit of `min + fee` with a full-fee anchor of `min`, which is in the band and can never be re-anchored.         |
| `check_SP85_currentCode_campaignValues`                                      | pass                     | Concrete 10,000 / 1,000 values from the fuzz campaigns: the floor is 12,000, so 12,000 is rejected and 12,001 is the smallest admissible deposit, admitting the lowest anchor 11,001 — one sat above the re-anchor floor 11,000. |
| `check_SP85_currentCode_antiGrindFloorHolds`                                 | pass                     | The reason for the strict floor: after a hop of at most `txMaxFee` the anchor stays above `minAmount`.                                                                                                                           |
| `check_SP85_fixA_geqFloorAlone`                                              | pass                     | Relaxing the re-anchor floor to `>=` is redundant now: the acceptance floor already closes the gap.                                                                                                                              |
| `check_SP85_fixA_geqFloorKeepsAntiGrindFloor`                                | pass                     | `>=` still keeps the post-hop anchor at or above `minAmount` and above the settlement dust floor (`ReservationProofs.sol:708-711`).                                                                                              |
| `check_SP85_fixB_strictDepositMinimumClosesGap`                              | pass                     | The floor as the contracts now state it: acceptance requires `deposit > minAmount + 2 * txMaxFee`, re-anchor floor unchanged. Every admitted anchor is re-anchorable.                                                            |
| `check_SP85_fixB_nonStrictDepositMinimum_expectedCounterexample`             | counterexample           | The same with `>= minAmount + 2 * txMaxFee` and the strict floor is off by one (min 2, fee 1, deposit 4, anchor 3). A non-strict deposit minimum would need the `>=` re-anchor floor as well.                                    |
| `check_SP85_fixAB_geqFloorWithNonStrictMinimumClosesGap`                     | pass                     | Candidate fix: re-anchor floor `>=` plus deposit minimum `>= minAmount + 2 * txMaxFee` closes the gap.                                                                                                                           |
| `check_SP85_witness_fixBStrictAssumptionsSatisfiable_expectedCounterexample` | counterexample (witness) | Vacuity guard for the strict fix check.                                                                                                                                                                                          |
| `check_SP85_witness_fixABAssumptionsSatisfiable_expectedCounterexample`      | counterexample (witness) | Vacuity guard for the combined fix check.                                                                                                                                                                                        |

Scope: one parameter set is used for acceptance and for the request. The
contracts snapshot the parameters at acceptance and read the live values at the
reanchor request, so a governance change in between is a separate way to get
stuck and is not modelled. The acceptance floor is computed in uint256 and
cannot overflow; the re-anchor floor is a uint64 addition that reverts on
overflow, so that case is excluded.

Halmos 0.3.3 abstracts 256-bit `MUL` and `MOD` as uninterpreted functions, and
Solidity's checked multiplication compiles to `MULMOD`, so a uint64
`2 * txMaxFee` is not modelled exactly. The copies therefore keep the
contracts' own widths, and no bound in the harness is derived by multiplying
two uint64s and narrowing the result back.

## Counts

- `ReservationFloorHalmos`: 14 checks, 4 expected counterexamples (2 findings,
  2 witnesses), 10 expected passes.

## Results

The measured outcome of the run is recorded in the pull request body. The
expected shape of the output is: 10 checks pass and 4 fail, and the 4 failures
are exactly the checks whose names end in `_expectedCounterexample`. Halmos
then exits non-zero, which is the expected outcome for this harness.

What is real code and what is a copy: `ReservationFloor` copies the
arithmetic with cited lines, so a change to a cited source line needs the copy
updated. The limits stated above (one parameter set, the Halmos arithmetic
modelling) still apply.

## Citation check

`scripts/check-halmos-citations.js` reads the citation table out of the
harness files and checks each cited line range against the contracts. Run it
from `solidity/`:

```bash
node scripts/check-halmos-citations.js
```

It exits 0 when every citation resolves and 1, naming the stale citation,
when a cited line moved or no longer holds the cited expression.
