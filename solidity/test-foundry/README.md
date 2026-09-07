# Foundry tests

`BitcoinScript.t.sol` contains seven fuzz tests for the Bridge's P2PKH and
P2WPKH output script helpers. They cover round trips, independence from the
output value, distinct key hashes, script framing, and unsupported lengths.
Existing TypeScript suites and deployment scripts continue to use Hardhat.

## Run locally

Use Node **24.11.1**, Yarn **4.12.0**, and Foundry **v1.5.1**, matching
`.github/workflows/contracts.yml`. With `foundryup` installed, select Foundry:

```sh
foundryup --install v1.5.1
```

From `solidity/`:

```sh
corepack yarn@4.12.0 install --immutable
corepack yarn@4.12.0 foundry:install
corepack yarn@4.12.0 test:foundry
```

`foundry:install` installs the official `foundry-rs/forge-std` **v1.11.0**
revision `8e40513d678f392f398620b3ef2b418648b33e89` into `lib/forge-std`.
The revision is pinned in `package.json`; `--no-git` avoids adding a submodule.
Rerun this command when the pin changes. No npm mirror is used.

The default profile runs 256 cases per fuzz test. To reproduce CI's 1,000
cases per test:

```sh
FOUNDRY_PROFILE=ci corepack yarn@4.12.0 test:foundry
```

Foundry prints a seed on failure. Replay it with the same profile, replacing
`0x1234` with the reported seed:

```sh
FOUNDRY_PROFILE=ci corepack yarn@4.12.0 test:foundry --fuzz-seed 0x1234
```

## Compiler settings and generated files

`foundry.toml` uses solc **0.8.17**, the **London** EVM target, and **1,000**
optimizer runs. It also mirrors Hardhat's 200-run overrides for
`WalletRegistry` and `BridgeGovernance`, and its 1-run override for
`L1BTCDepositorNttWithExecutor`. Update both configurations when these settings
change. Foundry restrictions also apply to contracts importing an overridden
source; inspect the selected profile when adding tests for those contracts.

Foundry writes artifacts to `forge-artifacts/` and caches to `cache_forge/`.
These directories and `lib/` are ignored by Git, Prettier, and ESLint. Hardhat
continues to produce the deployment artifacts in `build/`; matching compiler
settings does not imply identical metadata or artifact formats.

The `contracts-foundry` CI job installs the pinned toolchain and runs this
suite independently of Hardhat. Prettier remains the Solidity formatter.

See [the evaluation](../docs/foundry-evaluation.md) for the scope of this pilot.
