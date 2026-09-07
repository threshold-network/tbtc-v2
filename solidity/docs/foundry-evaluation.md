# Foundry fuzz-testing pilot

Status: **an additive test suite with its own CI job.** Hardhat continues to
run the existing TypeScript tests and deployment scripts.

## Current baseline

The original evaluation began while smock blocked a Hardhat upgrade. That
work is complete: smock has been replaced by Solidity mocks and TypeScript
helpers, `yarn.lock` resolves Hardhat 2.29.0, and CI uses Node 24.11.1. Foundry
is no longer proposed as a way to unblock mocking or the Node upgrade.

The [Hardhat 3 assessment](hardhat-3-migration.md) tracks the remaining plugin
and deployment migration work. This pilot can run alongside that work.

## What this adds

`test-foundry/BitcoinScript.t.sol` exercises the existing `BitcoinTx` script
builders and parser through a small harness. Seven fuzz tests check:

- P2PKH and P2WPKH scripts round-trip to the original key hash.
- The output value does not affect the extracted P2PKH key hash.
- Distinct key hashes produce distinct scripts for both formats.
- Each format preserves its length and framing bytes.
- Appending unsupported trailing lengths to a P2PKH script is rejected.

Generated inputs complement the existing fixed-vector tests. The default
profile runs 256 cases per test; CI runs 1,000. A failing run reports a seed
that can be replayed locally.

## Reproducible execution

The `contracts-foundry` job in `.github/workflows/contracts.yml` runs on
Solidity PR changes and the workflow's other triggers. It installs Node
24.11.1, Yarn 4.12.0, Foundry v1.5.1, and the exact forge-std v1.11.0 commit
pinned by `yarn foundry:install`. JavaScript dependencies use the existing
lockfile with `yarn install --immutable`.

See [the test README](../test-foundry/README.md) for installation, execution,
and seed replay commands. The toolchain and forge-std revisions should be
updated deliberately and validated together.

## Coexistence with Hardhat

Both runners compile `contracts/` with solc 0.8.17. Foundry explicitly selects
London, the default target of that compiler version, and 1,000 optimizer
runs. Additional compiler profiles mirror the Hardhat overrides: 200 runs
for `WalletRegistry` and `BridgeGovernance`, and 1 run for
`L1BTCDepositorNttWithExecutor`. Keep these settings synchronized when either
configuration changes.

Foundry's [compilation restrictions](https://getfoundry.sh/reference/config/solidity-compiler#compilation-restrictions)
also propagate to importing contracts.
Future tests importing an overridden contract need to account for that
profile selection. Hardhat remains the source of deployment artifacts;
compiler-setting parity does not guarantee identical metadata or artifacts.

Foundry uses `forge-artifacts/` and `cache_forge/`, separate from Hardhat's
`build/` and `cache/`. Its dependencies live in the ignored `lib/` directory.
Generated files and vendored dependencies are excluded from Prettier and
ESLint; the existing Prettier configuration formats the authored `.t.sol`
tests.

Slither's `crytic-compile` can prefer Foundry when it sees `foundry.toml`.
The Slither job therefore explicitly selects
`--compile-force-framework hardhat` and continues to use Hardhat artifacts.

## Scope of the pilot

Add property tests when generated inputs provide useful coverage of byte
parsing or other pure helpers. Bitcoin script handling is the initial case;
additional suites should bring a concrete property and a passing CI run.

The existing TypeScript tests, deployment fixtures, and deployment scripts
stay in place. A broader migration would require a separate proposal for
those workflows and evidence that the maintenance cost is justified.
