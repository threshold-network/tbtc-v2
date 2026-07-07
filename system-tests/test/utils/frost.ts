// Helpers specific to the FROST/Schnorr testnet4 lifecycle system test.
//
// The crucial difference vs. the ECDSA system tests: a FROST wallet is a
// distributed Schnorr wallet whose spending key is threshold-shared across the
// keep-core signing group. There is no `walletBitcoinKeyPair` / WIF the test
// can sign with. Every wallet-originated Bitcoin transaction (deposit sweep,
// redemption, moving funds) is built + threshold-signed + broadcast by the
// live keep-core FROST nodes. The test therefore drives only the depositor and
// SPV-maintainer sides and WAITS for the nodes to act on Bitcoin.

import { BigNumber, Contract } from "ethers"
import {
  assembleBitcoinSpvProof,
  extractBitcoinRawTxVectors,
  BitcoinTxHash,
} from "@keep-network/tbtc-v2.ts"

import type {
  BitcoinClient,
  BitcoinTx,
  BitcoinUtxo,
} from "@keep-network/tbtc-v2.ts"

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Polls a Bitcoin address' transaction history until a transaction that is not
 * already known appears — i.e. the live FROST nodes have broadcast a new
 * wallet transaction touching that address. Used to discover the node-produced
 * sweep / redemption / moving-funds transactions the test must prove.
 * @param bitcoinClient Bitcoin client.
 * @param address Address to watch (e.g. the deposit address for the sweep, the
 *        redeemer address for the redemption, the target wallet for the move).
 * @param knownTransactionHashes Transaction hashes to ignore (already seen).
 * @param options.timeoutMs Overall timeout. testnet4 blocks are sparse, so this
 *        is generous by default.
 * @param options.pollMs Poll interval.
 * @returns The first newly-observed transaction.
 */
export async function waitForNewTransactionAtAddress(
  bitcoinClient: BitcoinClient,
  address: string,
  knownTransactionHashes: string[],
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<BitcoinTx> {
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000 // 1h
  const pollMs = options.pollMs ?? 20000 // 20s
  const known = new Set(knownTransactionHashes.map((h) => h.toLowerCase()))
  const deadline = Date.now() + timeoutMs

  for (;;) {
    // Most-recent-first is not guaranteed across clients, so scan the whole set.
    const history = await bitcoinClient.getTransactionHistory(address, 25)
    const fresh = history.find(
      (tx) => !known.has(tx.transactionHash.toString().toLowerCase())
    )
    if (fresh) {
      return fresh
    }

    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for a new wallet transaction ` +
          `at address ${address}; is the keep-core FROST node set running and ` +
          `has the deposit aged past DEPOSIT_MIN_AGE / the request past its min age?`
      )
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMs)
  }
}

/**
 * Submits the moving-funds SPV proof directly to the Bridge.
 *
 * The tbtc-v2.ts SDK's `maintenance.spv` service exposes
 * `submitDepositSweepProof` and `submitRedemptionProof` but not
 * `submitMovingFundsProof`, so this mirrors their serialization
 * (see EthereumBridge#submitRedemptionProof) and calls the Bridge contract
 * directly. Consider promoting this into the SDK as a follow-up.
 * @param bridge Bridge contract instance connected with an authorized SPV
 *        maintainer signer.
 * @param bitcoinClient Bitcoin client.
 * @param movingFundsTxHash Hash of the moving-funds transaction to prove.
 * @param sourceWalletMainUtxo Source wallet main UTXO consumed by the move.
 * @param sourceWalletPublicKeyHash 20-byte source wallet public key hash.
 */
export async function submitMovingFundsProof(
  bridge: Contract,
  bitcoinClient: BitcoinClient,
  movingFundsTxHash: BitcoinTxHash,
  sourceWalletMainUtxo: BitcoinUtxo,
  sourceWalletPublicKeyHash: string
): Promise<string> {
  const requiredConfirmations = await bridge.txProofDifficultyFactor()

  const proof = await assembleBitcoinSpvProof(
    movingFundsTxHash,
    requiredConfirmations,
    bitcoinClient
  )
  const rawTransaction = await bitcoinClient.getRawTransaction(movingFundsTxHash)
  const vectors = extractBitcoinRawTxVectors(rawTransaction)

  const txParam = {
    version: `0x${vectors.version}`,
    inputVector: `0x${vectors.inputs}`,
    outputVector: `0x${vectors.outputs}`,
    locktime: `0x${vectors.locktime}`,
  }
  const proofParam = {
    merkleProof: proof.merkleProof.toPrefixedString(),
    txIndexInBlock: proof.txIndexInBlock,
    bitcoinHeaders: proof.bitcoinHeaders.toPrefixedString(),
    coinbasePreimage: proof.coinbasePreimage.toPrefixedString(),
    coinbaseProof: proof.coinbaseProof.toPrefixedString(),
  }
  const mainUtxoParam = {
    // The Bridge expects the hash in Bitcoin internal (little-endian) byte order.
    txHash: sourceWalletMainUtxo.transactionHash.reverse().toPrefixedString(),
    txOutputIndex: sourceWalletMainUtxo.outputIndex,
    txOutputValue: BigNumber.from(sourceWalletMainUtxo.value),
  }

  const tx = await bridge.submitMovingFundsProof(
    txParam,
    proofParam,
    mainUtxoParam,
    sourceWalletPublicKeyHash
  )
  await tx.wait()
  return tx.hash
}
