# Halmos reservation floor harness: re-derivation evidence

This record is the public counterpart of the re-derivation run for the
`ReservationFloor` Halmos harness. It states what the harness proves, what it
was re-derived against, and what the run measured. It is test-only material:
no contract source changed.

## Scope

The harness proves one property of the reservation arithmetic, the one the
audit lead SP-85 names:

> The re-anchor request floor is strictly above what acceptance admits.

Concretely, `requestReservationAcceptance` requires
`deposit.amount > minAmount + 2 * txMaxFee`, while
`requestReservationReanchor` requires
`anchorAmount > txMaxFee + minAmount`. Every anchor that acceptance admits is
therefore strictly above the re-anchor floor, and no position can be pinned by
the gap between the two floors.

The harness copies the arithmetic rather than calling the contracts, because
`requestReservationReanchor` and the acceptance request are external library
functions over `BridgeState.Storage` (linked libraries, wallet state machine,
timeout rules). Every copy cites the source line it mirrors, and
`solidity/scripts/check-halmos-citations.js` fails when a cited line no longer
holds the cited expression.

## Re-derivation

An earlier revision of the harness was derived against a tree whose contracts
carried the acceptance floor `deposit.amount >= minAmount + txMaxFee`. That
harness was carried onto a tree whose contracts require
`deposit.amount > minAmount + 2 * txMaxFee` without re-derivation, so every
cited line number moved and every check that assumed the old admission rule
proved a statement about a rule the contracts no longer had. In particular the
two "current code" checks reported a defect the contracts no longer contain.

The harness was re-derived against the current `reservations-upgrade` head:

| Copy                                 | Source at the derived head                                |
| ------------------------------------ | --------------------------------------------------------- |
| acceptance deposit floor             | `solidity/contracts/bridge/Reservation.sol:596-600`       |
| acceptance settlement fee bound      | `solidity/contracts/bridge/ReservationProofs.sol:462-465` |
| acceptance settlement anchor minimum | `solidity/contracts/bridge/ReservationProofs.sol:473-476` |
| re-anchor request floor              | `solidity/contracts/bridge/Reservation.sol:900-906`       |
| re-anchor settlement fee bound       | `solidity/contracts/bridge/ReservationProofs.sol:700-703` |
| re-anchor settlement dust floor      | `solidity/contracts/bridge/ReservationProofs.sol:708-711` |
| parameter setter rules               | `solidity/contracts/bridge/Reservation.sol:1620-1627`     |

The re-derivation changed what the checks say about the current code:

- Before: "the re-anchor floor gap is real in the copied arithmetic, an
  admitted anchor of `txMaxFee + minAmount` or less cannot be re-anchored."
  That was a statement about the copied arithmetic, which no longer matched
  the contracts.
- Now: the contracts admit no anchor at or below `minAmount + txMaxFee`, so
  every anchor that acceptance admits is re-anchorable. The two "current code"
  checks that used to report a counterexample now pass, and the witness check
  `check_SP85_oldFloor_admittedTheStuckBand_expectedCounterexample` shows the
  old floor did admit the stuck band, so the two passing checks are not
  vacuous.

## Results

Run with halmos 0.3.3 and `FOUNDRY_PROFILE=halmos`:

```bash
cd solidity
export FOUNDRY_PROFILE=halmos
halmos --forge-build-out build/halmos --match-contract ReservationFloorHalmos --function check_
```

The 14 checks split into 10 passes and 4 failures. Every failure is a check
whose name ends in `_expectedCounterexample`; no other check fails. The four
expected failures are:

| Check                                                                        | Why it is expected to fail                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `check_SP85_oldFloor_admittedTheStuckBand_expectedCounterexample`            | Witness that the old acceptance floor admitted the stuck band.                 |
| `check_SP85_fixB_nonStrictDepositMinimum_expectedCounterexample`             | A non-strict deposit minimum is off by one against the strict re-anchor floor. |
| `check_SP85_witness_fixBStrictAssumptionsSatisfiable_expectedCounterexample` | Vacuity guard: the strict fix check's assumptions are satisfiable.             |
| `check_SP85_witness_fixABAssumptionsSatisfiable_expectedCounterexample`      | Vacuity guard: the combined fix check's assumptions are satisfiable.           |

Halmos exits non-zero on this harness, because the four expected
counterexamples are reported as failures. The pass/fail split is the result;
the exit code is not.

The measured run is in the pull request body of the branch that carries the
harness.

## Citation check

```bash
cd solidity
node scripts/check-halmos-citations.js
```

Exit 0 and `all 7 Halmos citations resolve` when every cited line range still
holds the cited expression; exit 1 names the stale citation otherwise.

## Negative control

The harness was checked against a deliberately weakened copy of the guarded
rule, in a throwaway tree that is not part of any branch: with the acceptance
floor relaxed from `> minAmount + 2 * txMaxFee` back to the non-strict
`>= minAmount + 2 * txMaxFee`, the strict re-anchor floor no longer follows,
and `check_SP85_fixB_nonStrictDepositMinimum_expectedCounterexample` finds the
off-by-one witness. The negative control is not committed and no branch
carries it.

## Limits

- One parameter set is used for acceptance and for the request. The contracts
  snapshot the parameters at acceptance and read the live values at the
  re-anchor request, so a governance parameter change between the two is a
  second, separate way to get stuck, and it is not modelled here.
- The acceptance floor is computed in uint256 and cannot overflow; the
  re-anchor floor is a uint64 addition that reverts on overflow, and that case
  is excluded by assumption.
- Halmos 0.3.3 abstracts 256-bit `MUL` and `MOD` as uninterpreted functions,
  and Solidity's checked multiplication compiles to `MULMOD`. A uint64
  `2 * txMaxFee` is therefore not modelled exactly, so no bound in the harness
  is derived by multiplying two uint64s and narrowing the result back. Every
  bound is computed in uint256, as the contract computes it, or written as two
  uint64 additions.
