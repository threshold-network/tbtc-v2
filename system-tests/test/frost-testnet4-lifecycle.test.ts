/**
 * FROST/Schnorr full funds-movement lifecycle on Bitcoin **testnet4** (BIP-94):
 *
 *   Taproot deposit → sweep → MINT → redemption → FROST→FROST moving funds
 *
 * PENDING TEMPLATE — intentionally not implemented here. This scenario is a
 * full-stack e2e and cannot compile/run in this package as-is; wiring it up
 * requires all of:
 *
 *   1. system-tests wired to the FROST SDK. `@keep-network/tbtc-v2.ts` is pinned
 *      to `^2.3.0` here, which lacks the Taproot-deposit + `BitcoinNetwork.Testnet4`
 *      APIs this scenario needs — those live in this branch's `typescript/` (4.x)
 *      package, which is not part of the system-tests dependency/workspace.
 *   2. A live keep-core FROST node set. A FROST wallet is threshold-signed, so —
 *      unlike the ECDSA system tests, which sign the wallet's sweep/redemption
 *      with a `WALLET_BITCOIN_WIF` — the test only drives the depositor + the SPV
 *      maintainer and waits for the nodes to build + sign + broadcast on Bitcoin.
 *      It therefore must NOT go through `setupSystemTestsContext()` (which requires
 *      an ECDSA `WALLET_BITCOIN_WIF`); it needs a FROST-specific context keyed on
 *      the wallet's compressed group public key.
 *   3. A testnet4 deployment (with a stub `SystemTestRelay`) + a funded testnet4
 *      wallet, and the SPV maintainer authorized via `Bridge.setSpvMaintainerStatus`.
 *
 * The verified end-to-end sequence — exact SDK/contract calls, prerequisites, the
 * reusable proof helpers (`waitForNewTransactionAtAddress`, `submitMovingFundsProof`),
 * and on-chain/Bitcoin evidence from a reference run — is documented in
 * `system-tests/FROST_TESTNET4_E2E.md`. Implement the steps from there behind a
 * `RUN_FROST_TESTNET4_E2E` gate once (1)–(3) are in place.
 *
 * The `before()` hook below makes the gate explicit: when the env var is not
 * set, the entire suite is skipped (Mocha reports it as `pending` and the run
 * is a no-op for this file). The single `it(...)` deliberately has no
 * callback: if the gate is set without a real implementation, Mocha reports
 * it as **pending** (never a passing no-op), the suite compiles against any
 * SDK version, and no env other than the gate is required.
 */

const RUN_FROST_TESTNET4_E2E_ENV = "RUN_FROST_TESTNET4_E2E"

describe("System Test - FROST testnet4 lifecycle", () => {
  before(function () {
    if (!process.env[RUN_FROST_TESTNET4_E2E_ENV]) {
      this.skip()
    }
  })

  it(
    "deposit → sweep → MINT → redemption → FROST→FROST moving funds " +
      "(pending — see system-tests/FROST_TESTNET4_E2E.md)"
  )
})