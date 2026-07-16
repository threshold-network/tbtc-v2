# TBTC token test harness

A minimal, standalone Move package that compiles **only** the TBTC token module
(`l2_tbtc::TBTC`, in `../sources/token/tbtc.move`) and its unit tests, so the
mint-authorization coverage can be executed on its own.

## Why this exists

The full `l2_tBTC` package (`../Move.toml`) declares local dependencies on the
Wormhole and TokenBridge Move packages:

```toml
Wormhole    = { local = "../wormhole/sui/wormhole" }
TokenBridge = { local = "../wormhole/sui/token_bridge" }
```

Those sources are **not vendored** in this repository (the `../wormhole/...`
paths do not exist), so `sui move test` on the full package fails while
resolving dependencies:

```
Failed to resolve dependencies for package 'l2_tBTC'
Caused by:
  0: Parsing manifest for 'TokenBridge'
  1: No such file or directory (os error 2)
```

Only the gateway and bitcoin-depositor modules import Wormhole. The token module
is self-contained (it uses only the Sui framework), and the mint-authorization
test only touches the token module. This harness therefore pulls in just that
module and its test, which lets the coverage run without the unvendored
dependencies.

## What it covers

`tests/mint_authorization_tests.move` (symlinked from `../tests/`) verifies the
fix that requires a `MinterCap`'s minter address to still be an active minter:
after `remove_minter`, a retained `MinterCap` can no longer mint and `mint`
aborts with `E_NOT_MINTER`.

## How to run

From the `deploy_l2` package root:

```bash
npm run test:token
# or, directly:
sui move test -p token_test
```

Or from inside this directory:

```bash
sui move test
```

Expected output:

```
Running Move unit tests
[ PASS    ] l2_tbtc::mint_authorization_tests::test_removed_minter_cannot_mint_with_retained_cap
Test result: OK. Total tests: 1; passed: 1; failed: 0
```

## Notes

- `sources/tbtc.move` and `tests/mint_authorization_tests.move` are **symlinks**
  to the real files under `../sources/token/` and `../tests/`, so the token
  module has a single source of truth and cannot drift from what ships.
- `Move.toml` intentionally declares **no** explicit framework dependency. The
  Sui CLI auto-injects the framework it ships with, which keeps the harness in
  lockstep with the installed `sui` version and avoids the framework-revision
  drift that makes a pinned `rev` fail to parse under a newer CLI.
- To run the **full** suite instead (gateway, bitcoin-depositor, and the
  Wormhole-dependent `mintercap_fix_tests.move`), provide the Wormhole and
  TokenBridge Move sources at the local paths declared in `../Move.toml` (for
  example, by checking out the matching Wormhole Sui packages to
  `../../wormhole/sui/wormhole` and `../../wormhole/sui/token_bridge`), then run
  `sui move test` from `deploy_l2`.
