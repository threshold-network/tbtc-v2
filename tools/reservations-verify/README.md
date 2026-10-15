# Reservation re-verification bundle

Runs the targeted checks on one tbtc-v2 head and prints one pass/fail table.
Use it each time the public PR head moves or the integrated line changes.

```sh
tools/reservations-verify/run.sh \
  --tbtc /path/to/tbtc-v2-worktree \
  [--keepcore /path/to/keep-core-worktree] \
  [--fork-ref <git ref that holds solidity/scripts/reservations-fork-*.ts>] \
  [--old-pr <public PR head before it moved> --new-pr <public PR head now> [--audited <ref>]] \
  [--steps reconcile,killset,full,survivors,sdk,fork,drift]
```

| Step | What it runs | Cost on the audit host |
|---|---|---|
| `reconcile` | normalizes `solidity/contracts` and `solidity/deploy` with the repository Prettier at the old and new PR head and at the head under test, then checks that every real change of the PR is already in the head under test (`reconcile.sh`); with `--audited` it also compares the contracts at that ref with the head under test. Exits 1 for a missing contract change or an audited difference | about 2 min |
| `killset` | compile, then the 262 reservation tests in `killset.txt` plus the survivor tests | about 2 min |
| `full` | the full Hardhat suite | about 6 min |
| `survivors` | re-applies the nine mutants in `survivors.txt` (one source string each, see `mutate.cjs`), runs the three test files that must kill them, restores the source and checks its hash | about 10 min |
| `sdk` | generates typechain bindings, runs the SDK suite | about 1 min |
| `fork` | mainnet-fork lifecycle, SDK and hand-off scripts (needs `FORKING_URL` in the environment and `--fork-ref`) | about 2 min |
| `drift` | keep-core `verify-vendored-fallback` against artifacts compiled from this head (needs `--keepcore`) | seconds |

Without `--steps` it runs every step the arguments allow.

## Notes

- The tbtc-v2 worktree needs `solidity/node_modules` and `typescript/node_modules`. Run one Hardhat job at a time: memory is the limit.
- `mutate.cjs` replaces exact source strings. If the contract text changes (for example after a Prettier pass), a mutant reports `PATTERN_NOT_FOUND` instead of `KILLED`; fix the string, do not count it. `RES_INDENT` selects the indent of the `isPrivileged` continuation lines (16 after Prettier).
- The fork step writes four fork scripts from `--fork-ref` into `solidity/scripts/`, runs them, and removes them and the artifacts it wrote.
- Pass floors: a step passes only with no failures and a minimum number of passing tests (`MIN_KILLSET` 200, `MIN_FULL` 3000, `MIN_SDK` 500, `MIN_FORK` 20 fork passes). "0 passing, 0 failing" is a FAIL.
- `survivors` first runs the unmutated kill set and stops (row FAIL, no mutant run) unless it is green with at least one passing test. A mutant is `KILLED` only when the output names a failing test; a failure count without a test name is `UNCONFIRMED`. The step passes only when every id in `survivors.txt` ran and was `KILLED`.
- Full suite on the reconciled head `c5cb387cf` (run twice, once before and once after the four getter tests): the first run had one failure, `L1BTCDepositorNttWithExecutor - Real-World Scenarios / should handle different fee structures`; the second run had none (3568 passing, 61 pending). On the public PR head `40bdfe4d4` the full suite had 3488 passing, 61 pending, 0 failing. The failing test passes alone. Treat a repeat as a new finding.
- No log contains URLs or keys: the fork log passes through a URL filter.
- Not covered: Medusa and Foundry invariants, Go fuzz and mutation, the keep-core test suite. The `reconcile` step with `--audited` shows whether the contract bytes differ from the audited line after formatting; run those suites when it reports a difference.
- The drift step recompiles first (the survivors step leaves artifacts of the last mutant behind) and runs `make` with `GOTOOLCHAIN=go1.25.7` unless `GOTOOLCHAIN` is already set; keep-core's `go.mod` needs Go 1.25.7 or newer.
