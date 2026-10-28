# Decision: Keep fuzz gas limits aligned and treat out-of-gas as a harness fault

Date: 2026-10-14 | Status: accepted

## Context

Campaign 12 (fuzzing the fix branch) first showed SP-55 ("acceptance proof reverted although every precondition holds"). Both causes were out-of-gas, not production reverts:

- Medusa: the SP-95 probe used a static call that halts on its first storage write and burns all forwarded gas (840M of 898M in one block).
- Echidna: the default `testMaxGas` is 12.5M; the reservation flows with the property battery need 14M to 16M.

## Options Considered

1. **Cap the probe gas, set `testMaxGas`, add a drift rule (chosen)**
   - Pros: SP-55 stays strict and cannot be hidden by a gas heuristic.
   - Cons: a cap needs a proof it does not blind SP-95.
2. **Treat out-of-gas as inconclusive in the handler (rejected)**
   - Pros: small change.
   - Cons: also hides a real out-of-gas defect in production code; the first heuristic (`gasAfter > gasBefore / 64`) did not even separate the cases.
3. **Skip SP-95 in long runs**
   - Pros: removes the burn.
   - Cons: loses the check that expired Live positions have a release path.

## Decision

- Forward at most `SP95_PROBE_GAS` (300,000) to the SP-95 probe (`Properties.sol`).
- Set `testMaxGas: 150000000` in `echidna.yaml`, `echidna-longrun.yaml` and `echidna-periphery.yaml`.
- `scripts/fizz-drift-check.ts` fails when Echidna `testMaxGas` (default 12,500,000 when absent) differs from Medusa `transactionGasLimit`.
- Never weaken SP-55 for out-of-gas.

## Rationale

Evidence: `C12Repro.t.sol` fails without the cap (898,458,452 gas) and passes with it (7,244,929); a mutant without the R-12 branch still fails the SP-95 replay with the cap in place; Echidna with the new limit shows no SP-55.

## Consequences

- Positive: SP-55 failures now mean a real proof revert.
- Negative: the cap is a magic number; the SP-95 mutant check proves detection only for the removed R-12 branch.

## References

- Verdict: `solidity/fizz_data/triage/C12-fix-branch.verdict.md`
- Commits: `e48bf256`, `179df4e1`, `84d68b19`, `4e14fabc`
