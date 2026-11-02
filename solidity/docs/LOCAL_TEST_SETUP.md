# Running the deploy-fixture test suites locally

The `Bridge.*` suites (and anything that calls `deployments.fixture()` from
`test/fixtures/bridge.ts`) build the whole stack by running the hardhat-deploy
scripts in-process. `yarn test` / `yarn deploy:test` set
`USE_EXTERNAL_DEPLOY=true`, so the NuCypher/ReimbursementPool/SortitionPool
bootstrap comes from the installed `@threshold-network/solidity-contracts` and
`@keep-network/*` packages' exported deploy scripts.

## Prerequisites

1. **Install once** (or reuse an existing `node_modules`):

   ```sh
   cd solidity
   yarn install # runs postinstall, which applies the deploy-patches
   ```

   The installed packages ship the `export/deploy` scripts and
   `export/artifacts`; that is all the test path needs. The optional
   `.../deployments/development` record folders are _not_ shipped by these
   package versions and are not required — when they are absent, hardhat-deploy
   simply starts from no records and the external scripts deploy stubs in their
   place (e.g. a `NuCypherToken` stub). This matches CI, which also runs on a
   fresh checkout with no pre-seeded records.

## The one thing that must be true (matches CI)

`yarn test` / `yarn deploy:test` must run **with `FORKING_URL` and
`FORKING_BLOCK` unset**.

The external NuCypher resolve script (`@threshold-network/solidity-contracts/
export/deploy/00_resolve_nucypher_token.js`) only deploys its `NuCypherToken`
stub when the hardhat network is not forking; when
`hre.network.config.forking.enabled` is true it throws
`deployed NuCypherToken contract not found`. `forking.enabled` is derived from
`!!process.env.FORKING_URL` in `hardhat.config.ts`. A stray `FORKING_URL` in the
login shell (a common leftover on dev machines) flips this branch and produces
a local-only false failure; a fresh CI checkout never sets it.

So:

```sh
env -u FORKING_URL -u FORKING_BLOCK yarn deploy:test # warm the deploy cache
env -u FORKING_URL -u FORKING_BLOCK yarn test test/bridge/Bridge.Governance.test.ts
```

(or unset them for the whole shell session).

## Without `USE_EXTERNAL_DEPLOY`

If you run `hardhat deploy` / tests **without** `USE_EXTERNAL_DEPLOY=true`, the
external ReimbursementPool bootstrap is skipped and
`deploy/00_resolve_reimbursement_pool.ts` throws
`deployed ReimbursementPool contract not found` (the local scripts only _resolve_
it; it is only _deployed_ by the external random-beacon script). Use the default
`yarn test` / `yarn deploy:test` env (which set it) instead of a bare
`hardhat deploy`.

## Clearing stale deploy records

`deployments/hardhat/` is a gitignored, non-`clean`-scripted cache that persists
across local `yarn test` runs in the same checkout. Clear it between runs (or
rely on a fresh checkout) to avoid stale chain-ID/ownership state bleeding
across processes. CI never carries it.

## Reservation-suite test helpers

The UTXO-reservation suites craft Bitcoin-style transactions in-test. Two
fixtures that trip up newcomers:

- The little-endian encoder `toLE(value, byteLength)` must be
  `reverseHex(BigInt(value).toString(16).padStart(byteLength * 2, "0"))` —
  **no** `.slice(2)`. `BigInt(...).toString(16)` has no `0x` prefix, so a
  leftover `.slice(2)` drops the first two hex chars and silently corrupts
  every LE-encoded value (the deposit refund locktime and `valueSat`). The
  corruption surfaces as `Authorization window would overlap the deposit
refund window` / `Refund locktime must be a value >= 500M`.
- Under ethers v6, a struct returned by a `getContract`-style read (e.g.
  `bridge.wallets(pkh)`) is a `Result` proxy whose own enumerable keys are only
  the indexed ones. Do not object-spread it (`...(await bridge.wallets(pkh))`
  fails with `missing value for component ecdsaWalletID`); read each named
  field explicitly and build the struct.
