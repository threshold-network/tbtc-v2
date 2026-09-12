# Foundry fuzz-testing pilot

Status: **an additive test suite with its own CI job.** Hardhat continues to
run the existing TypeScript tests and deployment scripts.

## Current baseline

The original evaluation began while smock blocked a Hardhat upgrade. That
work is complete: smock has been replaced by Solidity mocks and TypeScript
helpers, `yarn.lock` resolves Hardhat 2.29.0, and CI uses the Node version
pinned in the workflow. Foundry
is no longer proposed as a way to unblock mocking or the Node upgrade.

The [Hardhat 3 assessment](hardhat-3-migration.md) tracks the remaining plugin
and deployment migration work. This pilot can run alongside that work.

## What this adds

`test-foundry/BitcoinScript.t.sol` exercises the existing `BitcoinTx` script
builders and parser through a small harness. Nine fuzz tests and one
deterministic regression test check:

- P2PKH and P2WPKH scripts round-trip to the original key hash, which also
  guarantees distinct key hashes produce distinct scripts (a builder that
  masked or discarded key-hash bits would fail the round-trip property first).
- Each format preserves its length and framing bytes.
- Appending unsupported trailing lengths to a P2PKH script is rejected.
- A P2SH-tagged output (the `0x17a914` prefix) is rejected as neither valid
  P2PKH nor P2WPKH.
- A P2WSH-tagged output (the `0x00 0x20` witness program prefix, a 32-byte
  hash) is rejected too, but on the 20-byte length check rather than the
  script-length gate that rejects P2SH.
- Corrupting any single framing byte (opcodes/length bytes, not the key
  hash payload) of an otherwise-valid P2PKH or P2WPKH script is rejected --
  this is the one property the round-trip tests cannot exercise, since they
  only ever feed scripts the builders themselves produced.
- A script whose length-prefix byte is exactly `0xff` makes the underlying
  byte-extraction helper's own length arithmetic overflow to a Panic instead
  of a clean revert; a deterministic test pins this exactly, since the fuzz
  tests above only land on that boundary by chance -- roughly 1-in-1500 for
  P2PKH and 1-in-760 for P2WPKH, per case, independent of how many cases a
  given run generates.

Generated inputs complement the existing fixed-vector tests. The default
profile runs 256 cases per test; CI runs 1,000. A failing run reports a seed
that can be replayed locally.

## Reproducible execution

The `contracts-foundry` job in `.github/workflows/contracts.yml` runs on
Solidity PR changes and the workflow's other triggers. It installs the Node
and Yarn versions declared in that workflow, the Foundry release pinned
there, and the forge-std commit pinned by `yarn foundry:install` (sourced
from `package.json`). JavaScript dependencies use the existing lockfile with
`yarn install --immutable`.

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

The `WalletRegistry` compilation restriction currently has no effect in
Foundry's build: only its interface (`api/IWalletRegistry.sol`) is imported,
and the concrete contract is outside the compilation graph today.

Foundry's source resolution also needs explicit context-scoped remappings
wherever a dependency pins a different `@openzeppelin/contracts(-upgradeable)`
version than the workspace's top-level 4.8.1, or it silently compiles the
wrong version for that dependency. Four cases exist today: two are
remapped, two are knowingly left unremapped. `@keep-network/ecdsa`
pins 4.9.1 for both packages and is remapped in full, since its OpenZeppelin
usage is only reached through a named import and never shares file scope with
the top-level version. `@keep-network/random-beacon` pins `@openzeppelin/contracts`
4.7.3, but only its `security/ReentrancyGuard.sol` differs in content from the
top-level copy (`access/Ownable.sol` and `utils/Context.sol` are byte-identical
to 4.8.1), so only the `security/` subpath is remapped -- remapping the whole
package collides with the top-level import in the same compilation unit.
`@thesis/solidity-contracts` pins 4.2.0, reached through `TBTC.sol`'s
`access/Ownable.sol` import, but remapping it would also transitively
resolve that package's own `utils/Context.sol` and collide with the
top-level import in the same file scope, so it is left unremapped and
Foundry compiles it against the top-level 4.8.1 OpenZeppelin instead -- a
real, accepted divergence from Hardhat's Node-resolution, which honors the
package's own pin. `@keep-network/sortition-pools` pins 4.9.1, reached
through a similar `Ownable.sol` import chain, and hits the same
unavoidable collision, so it too is left unremapped and compiled against
the top-level version -- another accepted divergence. Add a
new context-scoped entry, verified with `forge build`, if a future dependency
bump introduces another such conflict.

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
