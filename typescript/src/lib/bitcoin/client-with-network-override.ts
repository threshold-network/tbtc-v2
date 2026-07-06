import { BitcoinClient } from "./client"
import { BitcoinNetwork } from "./network"
import { BitcoinRawTx, BitcoinTx, BitcoinTxHash, BitcoinUtxo } from "./tx"
import { BitcoinTxMerkleBranch } from "./spv"
import { Hex } from "../utils"

/**
 * Wraps a BitcoinClient and overrides getNetwork() to return a fixed value
 * without connecting. Use when the network is known (e.g. Sepolia → testnet4)
 * and Electrum may be unreachable for the initial address-generation step.
 */
export class BitcoinClientWithNetworkOverride implements BitcoinClient {
  constructor(
    private readonly delegate: BitcoinClient,
    private readonly networkOverride: BitcoinNetwork
  ) {}

  getNetwork(): Promise<BitcoinNetwork> {
    return Promise.resolve(this.networkOverride)
  }

  findAllUnspentTransactionOutputs(address: string): Promise<BitcoinUtxo[]> {
    return this.delegate.findAllUnspentTransactionOutputs(address)
  }

  getTransactionHistory(address: string, limit?: number): Promise<BitcoinTx[]> {
    return this.delegate.getTransactionHistory(address, limit)
  }

  getTransaction(transactionHash: BitcoinTxHash): Promise<BitcoinTx> {
    return this.delegate.getTransaction(transactionHash)
  }

  getRawTransaction(transactionHash: BitcoinTxHash): Promise<BitcoinRawTx> {
    return this.delegate.getRawTransaction(transactionHash)
  }

  getTransactionConfirmations(transactionHash: BitcoinTxHash): Promise<number> {
    return this.delegate.getTransactionConfirmations(transactionHash)
  }

  getTxHashesForPublicKeyHash(publicKeyHash: Hex): Promise<BitcoinTxHash[]> {
    return this.delegate.getTxHashesForPublicKeyHash(publicKeyHash)
  }

  latestBlockHeight(): Promise<number> {
    return this.delegate.latestBlockHeight()
  }

  getHeadersChain(blockHeight: number, chainLength: number): Promise<Hex> {
    return this.delegate.getHeadersChain(blockHeight, chainLength)
  }

  getTransactionMerkle(
    transactionHash: BitcoinTxHash,
    blockHeight: number
  ): Promise<BitcoinTxMerkleBranch> {
    return this.delegate.getTransactionMerkle(transactionHash, blockHeight)
  }

  broadcast(transaction: BitcoinRawTx): Promise<void> {
    return this.delegate.broadcast(transaction)
  }

  getCoinbaseTxHash(blockHeight: number): Promise<BitcoinTxHash> {
    return this.delegate.getCoinbaseTxHash(blockHeight)
  }
}
