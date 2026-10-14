# Reservation re-verification bundle

Runs the targeted checks on one tbtc-v2 head and prints one pass/fail table.
Use it each time the public PR head moves or the integrated line changes.

```sh
tools/reservations-verify/run.sh \
  --tbtc /path/to/tbtc-v2-worktree \
  [--keepcore /path/to/keep-core-worktree] \
  [--fork-ref <git ref that holds solidity/scripts/reservations-fork-*.ts>] \
  [--steps killset,full,survivors,sdk,fork,drift]
```

| Step | What it runs | Cost on the audit host |
|---|---|---|
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
- Known flaky test: `L1BTCDepositorNttWithExecutor - Real-World Scenarios / should handle different fee structures` fails inside the full suite on this host and passes alone.
- No log contains URLs or keys: the fork log passes through a URL filter.
- Not covered: Medusa and Foundry invariants, Go fuzz and mutation, the keep-core test suite. They test code the reconcile did not touch.
- The drift step recompiles first (the survivors step leaves artifacts of the last mutant behind) and runs `make` with `GOTOOLCHAIN=go1.25.7` unless `GOTOOLCHAIN` is already set; keep-core's `go.mod` needs Go 1.25.7 or newer.
