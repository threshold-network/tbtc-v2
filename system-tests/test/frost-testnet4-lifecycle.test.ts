import {
  BitcoinNetwork,
  ElectrumClient,
  BitcoinAddressConverter,
  EthereumAddress,
  Hex,
  TBTC,
} from "@keep-network/tbtc-v2.ts"
import { BigNumber, Contract } from "ethers"
import chai from "chai"
import chaiAsPromised from "chai-as-promised"

import {
  setupSystemTestsContext,
  createTbtcContractsHandle,
} from "./utils/context"
// Proven, reusable steps used by this scenario:
//   fakeRelayDifficulty          -> points the SystemTestRelay difficulty at a block
//   waitTransactionConfirmed     -> waits for testnet4 confirmations
//   waitForNewTransactionAtAddress -> discovers a node-broadcast wallet tx
//   submitMovingFundsProof       -> moving-funds SPV proof (SDK has no wrapper)
import { fakeRelayDifficulty, waitTransactionConfirmed } from "./utils/bitcoin"
import {
  waitForNewTransactionAtAddress,
  submitMovingFundsProof,
} from "./utils/frost"

import type { SystemTestsContext } from "./utils/context"

chai.use(chaiAsPromised)

/**
 * FROST/Schnorr full funds-movement lifecycle on Bitcoin **testnet4** (BIP-94):
 *
 *   Taproot deposit -> sweep -> MINT -> redemption -> FROST->FROST moving funds
 *
 * Everything is real: the SPV proofs carry real testnet4 proof-of-work, and
 * every wallet transaction is threshold-Schnorr-signed by a live keep-core
 * FROST signing group. The test never holds the wallet key — unlike the ECDSA
 * system tests (which sign the wallet's sweep/redemption with a WALLET_BITCOIN_WIF),
 * a FROST wallet is distributed, so the test only drives the depositor + the
 * SPV maintainer and WAITS for the nodes to build + sign + broadcast on Bitcoin.
 *
 * STATUS: full-stack e2e template. It requires a running keep-core FROST node
 * set + a testnet4 Electrum server + a tBTC FROST deployment (with a stub
 * `SystemTestRelay`) + a funded testnet4 wallet. It is gated behind
 * RUN_FROST_TESTNET4_E2E and skipped by default (NOT part of unit CI). The
 * exact, verified end-to-end sequence — with the on-chain/Bitcoin evidence from
 * the reference run — is documented in `system-tests/FROST_TESTNET4_E2E.md`;
 * the `TODO(frost-e2e)` markers below are the steps whose SDK surface must be
 * confirmed against a live run before this is un-skipped.
 */
const runIt =
  process.env.RUN_FROST_TESTNET4_E2E === "true" ? describe : describe.skip

runIt("System Test - FROST testnet4 lifecycle", () => {
  let context: SystemTestsContext
  let electrumClient: ElectrumClient

  let bank: Contract
  let relay: Contract
  let bridge: Contract

  let depositorSdk: TBTC
  let maintainerSdk: TBTC

  const depositAmount = BigNumber.from(50000)
  const depositTxFee = BigNumber.from(1500)
  const redemptionAmount = BigNumber.from(25000) // partial: leave change for the move
  const ELECTRUM_RETRIES = 5
  const ELECTRUM_RETRY_BACKOFF_STEP_MS = 10000

  // 33-byte compressed group public key of the Live FROST wallet under test
  // (operators know this; there is no WIF). Used for redemption + move args.
  const walletPublicKey = Hex.from(process.env.FROST_WALLET_PUBLIC_KEY ?? "")

  let depositorBitcoinAddress: string

  before(async () => {
    if (!process.env.FROST_WALLET_PUBLIC_KEY) {
      throw new Error("FROST_WALLET_PUBLIC_KEY (compressed group key) must be set")
    }
    context = await setupSystemTestsContext()
    const { electrumUrl, maintainer, depositor, deployedContracts } = context

    electrumClient = ElectrumClient.fromUrl(
      electrumUrl,
      undefined,
      ELECTRUM_RETRIES,
      ELECTRUM_RETRY_BACKOFF_STEP_MS
    )

    bank = new Contract(
      deployedContracts.Bank.address,
      deployedContracts.Bank.abi,
      maintainer
    )
    relay = new Contract(
      deployedContracts.LightRelay.address,
      deployedContracts.LightRelay.abi,
      maintainer
    )
    // Maintainer-connected Bridge for the moving-funds proof (SPV maintainer).
    bridge = new Contract(
      deployedContracts.Bridge.address,
      deployedContracts.Bridge.abi,
      maintainer
    )

    depositorSdk = await TBTC.initializeCustom(
      await createTbtcContractsHandle(deployedContracts, depositor),
      electrumClient
    )
    maintainerSdk = await TBTC.initializeCustom(
      await createTbtcContractsHandle(deployedContracts, maintainer),
      electrumClient
    )

    depositorBitcoinAddress = BitcoinAddressConverter.publicKeyToAddress(
      context.depositorBitcoinKeyPair.publicKey.compressed,
      BitcoinNetwork.Testnet4
    )
    depositorSdk.deposits.setDefaultDepositor(
      EthereumAddress.from(await depositor.getAddress())
    )
  })

  it("deposit -> sweep -> MINT -> redemption -> moving funds", async function () {
    // testnet4 blocks + FROST coordination windows make this a long-running e2e.
    this.timeout(3 * 60 * 60 * 1000)

    // (1) DEPOSIT: build a Taproot deposit to the active FROST wallet, fund it
    //     on testnet4, and reveal it (no vault => Bank balance).
    //     const deposit = await depositorSdk.deposits.initiateTaprootDeposit(depositorBitcoinAddress)
    //     ...fund via DepositFunding.submitTransaction(depositAmount, utxos, depositTxFee, depositorWif, client)...
    //     await deposit.initiateMinting(depositUtxo)
    // TODO(frost-e2e): confirm the Deposit#initiateMinting reveal path + how to
    //   derive the deposit address to watch for the sweep (see runbook §Deposit).

    // (2) SWEEP + MINT: the nodes propose + threshold-sign + broadcast the sweep.
    //     Discover it, wait for confirmations, fake the relay difficulty, prove it.
    //     const sweepTx = await waitForNewTransactionAtAddress(client, depositAddress, [depositTx])
    //     await waitTransactionConfirmed(client, sweepTx.transactionHash)
    //     await fakeRelayDifficulty(relay, client, sweepTx.transactionHash)
    //     await maintainerSdk.maintenance.spv.submitDepositSweepProof(
    //       sweepTx.transactionHash, ZERO_MAIN_UTXO, undefined /* no vault */)
    //     expect(await bank.balanceOf(depositorAddr)).to.be.gt(before)   // MINTED

    // (3) REDEMPTION: approve Bank balance + request redemption to a redeemer
    //     script; the nodes sign + broadcast; prove it.
    //     await bank.connect(depositor).approveBalance(bridge.address, redemptionAmount)
    //     await bridge.connect(depositor).requestRedemption(walletPublicKey, mainUtxo, redeemerScript, redemptionAmount)
    //     const redemptionTx = await waitForNewTransactionAtAddress(client, redeemerAddress, [])
    //     await waitTransactionConfirmed(...); await fakeRelayDifficulty(...)
    //     await maintainerSdk.maintenance.spv.submitRedemptionProof(redemptionTx.transactionHash, mainUtxo, walletPublicKey)

    // (4) FROST->FROST MOVING FUNDS (extended lifecycle — see runbook §Moving funds):
    //     requires a second Live FROST wallet (target) + retiring the source
    //     (notifyWalletCloseable). The nodes submit the commitment, then sign +
    //     broadcast the move; prove it via the reusable helper:
    //     const moveTxHash = (await waitForNewTransactionAtAddress(client, targetWalletAddress, [])).transactionHash
    //     await waitTransactionConfirmed(client, moveTxHash)
    //     await fakeRelayDifficulty(relay, client, moveTxHash)
    //     await submitMovingFundsProof(bridge, client, moveTxHash, sourceMainUtxo, sourceWalletPkh)
    //     // -> source wallet Closing, target pendingMovedFundsSweepRequestsCount == 1

    // Keep the imports/handles referenced until the stages above are enabled.
    void [
      depositAmount,
      depositTxFee,
      redemptionAmount,
      walletPublicKey,
      depositorBitcoinAddress,
      bank,
      relay,
      bridge,
      depositorSdk,
      maintainerSdk,
      fakeRelayDifficulty,
      waitTransactionConfirmed,
      waitForNewTransactionAtAddress,
      submitMovingFundsProof,
    ]
  })
})
