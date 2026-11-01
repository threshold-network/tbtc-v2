# Foundry tests

`BitcoinScript.t.sol` contains nine fuzz tests and one deterministic
regression test for the Bridge's P2PKH and P2WPKH output script helpers.
They cover round trips (which also guarantee distinct key hashes produce
distinct scripts), script framing, unsupported lengths, rejecting P2SH- and
P2WSH-tagged outputs, rejecting single-byte-
corrupted framing, and a length-prefix arithmetic boundary the fuzzer only
reaches by chance. Existing TypeScript suites and deployment scripts
continue to use Hardhat.

## Run locally

Use the Node, Yarn, and Foundry versions pinned in
`.github/workflows/contracts.yml`. With `foundryup` installed, select the pinned Foundry release:

```sh
foundryup --install v1.5.1
```

From `solidity/`:

```sh
corepack yarn@4.12.0 install --immutable
corepack yarn@4.12.0 foundry:install
corepack yarn@4.12.0 test:foundry
```

`foundry:install` installs the `foundry-rs/forge-std` revision pinned in
`package.json` into `lib/forge-std`; `--no-git` avoids adding a submodule.
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

## Reservation invariant suite

`reservations/` holds a stateful invariant suite for the reservation
accounting. `ReservationHandler` performs random sequences of these actions:

- reveal a reserved deposit,
- request, time out and prove an acceptance (on time and late),
- request a re-anchor as the owner, a third party or governance,
- time out and prove a re-anchor (on time and late),
- strand a position,
- mark a pending deposit stale, force it stale or release it to the pool,
- retire or terminate a wallet, or add a Live wallet,
- change the caps and the per-wallet and total limits,
- revoke or restore the reservation vault's trust,
- move time forward.

After every call, the suite checks these properties:

| Property          | Rule                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active count      | `activeReservationsCount` equals open positions plus pending acceptances.                                                                         |
| Total amount      | `reservationTotalAmount` equals open anchor amounts plus pending acceptance amounts.                                                              |
| Wallet counters   | Each wallet's count and amount equal its open positions plus pending actions that target it.                                                      |
| Third-party holds | Each wallet's hold count equals the pending third-party re-anchors that target it.                                                                |
| Pending deposits  | `pendingReservedDeposits` equals the deposits that still carry a pending marker.                                                                  |
| Anchor index      | Every open position is found from its current anchor outpoint.                                                                                    |
| Final actions     | A Settled or Superseded generation never changes again.                                                                                           |
| Caps              | A successful request never leaves a counter above its cap.                                                                                        |
| Reserve gate      | A successful acceptance request leaves at most `(Live wallets - reserve) * per-wallet count cap` open positions.                                  |
| Credits           | Bank credits equal settled anchor values, routed through the reservation vault while it is trusted, and financed fees equal re-anchor miner fees. |

The handler drives the real `Reservation` and `ReservationProofs` code
through `ReservationInvariantHarness`. The harness makes two simplifications:

- It writes the reveal-time records itself.
- Its proof functions skip `validateProof`, the SPV header and merkle
  check. The transaction vectors are real and the library parses them.

Wallet lifecycle transitions are direct state writes, and the SPV proof
check is out of scope. Each `test_*PropertyFires` test corrupts the state
and shows that one property then fails.

Run the suite with Foundry from `solidity/`:

```sh
corepack yarn@4.12.0 test:foundry --match-path 'test-foundry/reservations/*'
```

The `ci` profile runs 256 sequences of 100 calls. Run it with Medusa:

```sh
medusa fuzz --config medusa-reservations.json --timeout 1800
```

Medusa writes its corpus, coverage report and logs to
`cache_forge/medusa-reservations/`.

## Compiler settings and generated files

`foundry.toml` uses solc **0.8.17**, the **London** EVM target, and **1,000**
optimizer runs. It also mirrors Hardhat's 200-run overrides for
`WalletRegistry` and `BridgeGovernance`, and its 1-run override for
`L1BTCDepositorNttWithExecutor`. `check:foundry-hardhat-parity` now enforces
that these overrides stay synchronized, the same way it enforces the base
compiler settings. Foundry restrictions also apply to contracts importing an
overridden source; inspect the selected profile when adding tests for those
contracts. The `WalletRegistry` override applies only when
`contracts/hardhat-dependency-compiler/` exists locally (generated by a prior
Hardhat compile; see `foundry.toml`'s remappings comment) - the CI
`contracts-foundry` job never runs a Hardhat compile first, so that directory
is absent there and the override is inert in CI.

Foundry writes artifacts to `forge-artifacts/` and caches to `cache_forge/`.
These directories and `lib/` are ignored by Git, Prettier, and ESLint. Hardhat
continues to produce the deployment artifacts in `build/`; matching compiler
settings does not imply identical metadata or artifact formats.

The `contracts-foundry` CI job installs the pinned toolchain and runs this
suite independently of Hardhat. Prettier remains the Solidity formatter.

See [the evaluation](../docs/foundry-evaluation.md) for the scope of this pilot.
