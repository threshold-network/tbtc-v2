# FROST/Schnorr full funds-movement lifecycle on Bitcoin testnet4

This document specifies the end-to-end funds-movement lifecycle of a native
**FROST/Schnorr** tBTC wallet against **Bitcoin testnet4 (BIP-94)**:

```
Taproot deposit → sweep → MINT → redemption → FROST→FROST moving funds
```

It is the reference/runbook for `test/frost-testnet4-lifecycle.test.ts` (a
gated, full-stack e2e template). Every step below was executed and verified once
end-to-end; the resulting Bitcoin/Ethereum artifacts are quoted as evidence.

## Why testnet4 (and why the Ethereum side stays local)

The Bridge validates SPV proofs against real Bitcoin proof-of-work
(`evaluateProofDifficulty`). regtest can prove the FROST *signing* of a sweep but
cannot satisfy the on-chain difficulty check, so the mint/redemption/move proofs
need a real network. **Only Bitcoin has to be real** — the "realness" lives in
the Bitcoin headers, not the Ethereum chain. So this runs a **local Ethereum
dev chain (anvil)** with a fresh FROST deployment (our operators/governance) and
**real Bitcoin testnet4**. No Sepolia, faucet-ETH, or public RPC is required.

The keep-core node derives its Bitcoin network from the Ethereum network
selection. To drive testnet4 while on the local `--developer` profile, the node
maps `Developer → bitcoin.Testnet4` (testnet4 shares testnet3 address params;
difficulty/SPV validation is on-chain in the relay). Build the node from the
FROST coordinator branch with `-tags "frost_native frost_tbtc_signer cgo"` and
`CGO_LDFLAGS` pointing at the Rust signer's `libfrost_tbtc`, and run each node
with `--tbtc.frostSigningBackend native|ffi`.

## Prerequisites

- **Ethereum**: a tBTC **FROST** deployment (Bridge, FrostWalletRegistry,
  FrostDkgValidator, WalletProposalValidator, Bank, …). Use a `SystemTestRelay`
  as the Bridge relay — a pure difficulty oracle exposing
  `setCurrentEpochDifficultyFromHeaders` / `setPrevEpochDifficultyFromHeaders`;
  no LightRelay genesis/header-sync is needed. `txProofDifficultyFactor` may be
  `1` for the test deployment.
- **Bitcoin**: a testnet4 full node (Bitcoin Core ≥ 28, **run with `-txindex=1`**
  — the SPV/confirmation lookups need it) + an Electrum server (Fulcrum/electrs)
  on top. A funded testnet4 wallet for the depositor.
- **Nodes**: ≥3 keep-core FROST nodes, connected to the testnet4 Electrum and the
  local anvil, that have created a **Live FROST wallet with no main UTXO** via DKG.
- **Maintainer**: an SPV-maintainer address authorized via
  `Bridge.setSpvMaintainerStatus(maintainer, true)` (governance-only).

Env for the test: the standard system-test vars
(`CONTRACTS_DEPLOYMENT_EXPORT_FILE_PATH`, `ELECTRUM_URL`, `DEPOSITOR_BITCOIN_WIF`,
Ethereum keys) plus **`FROST_WALLET_PUBLIC_KEY`** (the wallet's 33-byte
compressed group key) and **`RUN_FROST_TESTNET4_E2E=true`**.

## The lifecycle (SDK calls + verified evidence)

Unlike the ECDSA system tests, the test **cannot sign** wallet transactions —
they are threshold-signed by the live nodes. The test drives the depositor +
maintainer and *waits* for the nodes to act on Bitcoin.

### 1. Deposit (Taproot)

```ts
const deposit = await depositorSdk.deposits.initiateTaprootDeposit(depositorBtcAddress)
// fund the deposit address on testnet4 (DepositFunding.submitTransaction with the depositor WIF)
await deposit.initiateMinting(depositUtxo) // reveals via revealTaprootDeposit
```
The deposit output is a P2TR whose **internal key = the wallet's x-only group
key** and whose single tapleaf is the depositor refund script. Assert
`bridge.deposits(txHash, index).revealedAt > 0`.
*Evidence:* funding tx `e9e09d08…` (50 000 sat), `revealTaprootDeposit` accepted.

### 2. Sweep + MINT

The nodes propose a `DepositSweep` at a coordination window (`block%3600==0`),
build a Taproot **key-path** sweep, threshold-Schnorr-sign it (single 64-byte
witness), and broadcast it. Discover the sweep tx, then:

```ts
await waitTransactionConfirmed(client, sweepTxHash)
await fakeRelayDifficulty(relay, client, sweepTxHash)          // set stub-relay difficulty
await maintainerSdk.maintenance.spv.submitDepositSweepProof(
  sweepTxHash, ZERO_MAIN_UTXO, undefined /* no vault → Bank */)
```
Assert the depositor's `bank.balanceOf(...)` increased (`amount − treasuryFee −
sweepFee`). *Evidence:* sweep `098158ef…` (Schnorr `R:0c29c07f…`) → **49 765 sat
Bank balance minted**.

### 3. Redemption

```ts
// Bridge.requestRedemption takes a bytes20 walletPubKeyHash (hash160 of the
// compressed key), NOT the 33-byte key — derive it (or use the SDK's
// redemptions service, which accepts the compressed key + resolves the UTXO).
const walletPubKeyHash = BitcoinHashUtils.computeHash160(
  walletPublicKey.toString()
).toPrefixedString()
await bank.connect(depositor).approveBalance(bridge.address, redemptionAmount)
await bridge.connect(depositor).requestRedemption(
  walletPubKeyHash, walletMainUtxo, redeemerOutputScript, redemptionAmount)
// nodes build + sign + broadcast the redemption; discover it, then:
await fakeRelayDifficulty(relay, client, redemptionTxHash)
// maintenance.spv.submitRedemptionProof accepts the compressed key (it hashes
// internally), so pass walletPublicKey here — not the hash.
await maintainerSdk.maintenance.spv.submitRedemptionProof(
  redemptionTxHash, walletMainUtxo, walletPublicKey)
```
Note `REDEMPTION_REQUEST_MIN_AGE` (600 s) — the nodes won't fulfil the request
until it ages. Assert the redeemer script received BTC. *Evidence:* redemption
`f738502f…` (Schnorr `R:0460ed31…`) → **24 847 sat paid to the redeemer**.

### 4. FROST→FROST moving funds (extended)

Additionally requires a **second Live FROST wallet** (target). Steps:

1. Create the target wallet: `bridge.requestNewWallet(activeWalletMainUtxo)` →
   the nodes run a 2nd DKG (challenge period shortened via
   `FrostWalletRegistry.updateDkgParameters` for real-time approval).
2. Retire the source: `bridge.notifyWalletCloseable(sourcePkh, sourceMainUtxo)`
   → source enters `MovingFunds`.
3. The nodes submit the moving-funds commitment (target = the new wallet), then
   at a `block%3600==0` window build + threshold-sign + broadcast the move
   (source main UTXO → target wallet P2TR). Prove it — the SDK has no wrapper, so
   use the helper:
   ```ts
   await submitMovingFundsProof(bridge, client, moveTxHash, sourceMainUtxo, sourcePkh)
   ```
   Assert source `Closing` (main UTXO cleared) and target
   `pendingMovedFundsSweepRequestsCount == 1`. *Evidence:* 2nd DKG wallet
   `0x7c042859…`; move `bc709b80…` (Schnorr `R:82142636…`) → **22 602 sat moved
   source→target**; `submitMovingFundsProof` accepted.

## Notes / gotchas learned running this

- **`-txindex=1` is mandatory** — otherwise the node/maintainer cannot read
  confirmations for confirmed non-wallet txs and the sweep proposal + SPV proofs
  fail.
- **`SystemTestRelay` removes the LightRelay genesis burden** entirely; the
  FROST-branch `BitcoinTx.determineRequestedDifficulty` already handles
  testnet4/BIP-94 DIFF1 (minimum-difficulty) headers.
- **Forced Ethereum mining races in-flight FROST signing** — on anvil, mine once
  to the coordination window then let the auto-miner drive; don't fast-forward
  through the active phase.
- **testnet4 reorgs** the low-difficulty tip frequently; a low-fee wallet tx can
  drop back to 0 confirmations. Fee wallet txs adequately (or CPFP) and wait for
  a couple of confirmations before submitting proofs.
- **`maintenance.spv` lacks `submitMovingFundsProof`** — it has
  `submitDepositSweepProof` + `submitRedemptionProof` but not moving-funds; build
  the proof from SDK primitives and call the Bridge directly (see the appendix).
  Promoting it into the SDK would be a clean follow-up.

## Appendix — reusable helpers

These are the two FROST-specific helpers the eventual mocha test needs. They are
documented here rather than shipped as `test/*.ts` because system-tests currently
pins `@keep-network/tbtc-v2.ts@^2.3.0`, whose loader (`ts-node/register/files`)
would compile them against an SDK that lacks the 4.x APIs. Add them under
`test/utils/` once system-tests is wired to the FROST SDK.

```ts
// A FROST wallet is threshold-signed by the live nodes, so the test cannot sign
// and instead WAITS for a node-broadcast wallet transaction to appear at an
// address (the deposit address for the sweep, the redeemer for the redemption,
// the target wallet for the move).
export async function waitForNewTransactionAtAddress(
  bitcoinClient: BitcoinClient,
  address: string,
  knownTransactionHashes: string[],
  { timeoutMs = 60 * 60 * 1000, pollMs = 20000 } = {}
): Promise<BitcoinTx> {
  const known = new Set(knownTransactionHashes.map((h) => h.toLowerCase()))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const history = await bitcoinClient.getTransactionHistory(address, 25)
    const fresh = history.find(
      (tx) => !known.has(tx.transactionHash.toString().toLowerCase())
    )
    if (fresh) return fresh
    if (Date.now() > deadline) throw new Error(`no new wallet tx at ${address}`)
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

// maintenance.spv has no submitMovingFundsProof; mirror submitRedemptionProof's
// serialization and call the Bridge directly (SPV-maintainer signer required).
export async function submitMovingFundsProof(
  bridge: Contract, // maintainer-connected Bridge
  bitcoinClient: BitcoinClient,
  movingFundsTxHash: BitcoinTxHash,
  sourceWalletMainUtxo: BitcoinUtxo,
  sourceWalletPublicKeyHash: string // 0x + 20 bytes
): Promise<string> {
  const factor = await bridge.txProofDifficultyFactor()
  const proof = await assembleBitcoinSpvProof(movingFundsTxHash, factor, bitcoinClient)
  const vectors = extractBitcoinRawTxVectors(
    await bitcoinClient.getRawTransaction(movingFundsTxHash)
  )
  const tx = await bridge.submitMovingFundsProof(
    {
      version: `0x${vectors.version}`,
      inputVector: `0x${vectors.inputs}`,
      outputVector: `0x${vectors.outputs}`,
      locktime: `0x${vectors.locktime}`,
    },
    {
      merkleProof: proof.merkleProof.toPrefixedString(),
      txIndexInBlock: proof.txIndexInBlock,
      bitcoinHeaders: proof.bitcoinHeaders.toPrefixedString(),
      coinbasePreimage: proof.coinbasePreimage.toPrefixedString(),
      coinbaseProof: proof.coinbaseProof.toPrefixedString(),
    },
    {
      // Bridge expects the hash in Bitcoin internal (little-endian) byte order.
      txHash: sourceWalletMainUtxo.transactionHash.reverse().toPrefixedString(),
      txOutputIndex: sourceWalletMainUtxo.outputIndex,
      txOutputValue: BigNumber.from(sourceWalletMainUtxo.value),
    },
    sourceWalletPublicKeyHash
  )
  await tx.wait()
  return tx.hash
}
```
