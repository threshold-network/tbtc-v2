import { Transaction as Tx, TxInput, TxOutput } from "bitcoinjs-lib"
import pTimeout from "p-timeout"
import {
  BitcoinClient,
  BitcoinNetwork,
  BitcoinAddressConverter,
  BitcoinRawTx,
  BitcoinTx,
  BitcoinTxHash,
  BitcoinTxInput,
  BitcoinTxMerkleBranch,
  BitcoinTxOutput,
  BitcoinUtxo,
  BitcoinHashUtils,
} from "../bitcoin"
import Electrum from "electrum-client-js"
import { BigNumber } from "@ethersproject/bignumber"
import { URL as nodeURL } from "url"
import URLParse from "url-parse"
import { backoffRetrier, Hex, RetrierFn } from "../utils"

import MainnetElectrumUrls from "./urls/mainnet.json"
import TestnetElectrumUrls from "./urls/testnet.json"

const browserURL = typeof window !== "undefined" && window.URL
const URL = nodeURL ?? (browserURL || URLParse)

/**
 * Represents a set of credentials required to establish an Electrum connection.
 */
export interface ElectrumCredentials {
  /**
   * Host pointing to the Electrum server.
   */
  host: string
  /**
   * Port the Electrum server listens on.
   */
  port: number
  /**
   * Protocol used by the Electrum server.
   */
  protocol: "tcp" | "tls" | "ssl" | "ws" | "wss"
}

/**
 * Additional options used by the Electrum server.
 */
export type ElectrumClientOptions = object

/**
 * Type for {@link Electrum} client from electrum-client-js library.
 */
type Electrum = any

/**
 * Represents an action that makes use of the Electrum connection. An action
 * is supposed to take a proper Electrum connection, do the work, and return
 * a promise holding the outcome of given type.
 */
type ElectrumAction<T> = (electrum: Electrum) => Promise<T>

/**
 * Electrum-based implementation of the Bitcoin client.
 */
export class ElectrumClient implements BitcoinClient {
  private credentials: ElectrumCredentials[]
  private options?: ElectrumClientOptions
  private totalRetryAttempts: number
  private retryBackoffStep: number
  private connectionTimeout: number

  constructor(
    credentials: ElectrumCredentials[],
    options?: ElectrumClientOptions,
    totalRetryAttempts = 3,
    retryBackoffStep = 10000, // 10 seconds
    connectionTimeout = 20000 // 20 seconds
  ) {
    this.credentials = credentials
    this.options = options
    this.totalRetryAttempts = totalRetryAttempts
    this.retryBackoffStep = retryBackoffStep
    this.connectionTimeout = connectionTimeout
  }

  /**
   * Creates an Electrum client instance from a URL.
   * @param url - Connection URL or list of URLs.
   * @param options - Additional options used by the Electrum server.
   * @param totalRetryAttempts - Number of retries for requests sent to Electrum
   *        server.
   * @param retryBackoffStep - Initial backoff step in milliseconds that will
   *        be increased exponentially for subsequent retry attempts.
   * @param connectionTimeout - Timeout for a single try of connection establishment.
   * @returns Electrum client instance.
   */
  static fromUrl(
    url: string | string[],
    options?: ElectrumClientOptions,
    totalRetryAttempts = 3,
    retryBackoffStep = 1000, // 10 seconds
    connectionTimeout = 20000 // 20 seconds
  ): ElectrumClient {
    let credentials: ElectrumCredentials[]
    if (Array.isArray(url)) {
      credentials = url.map(this.parseElectrumCredentials)
    } else {
      credentials = [this.parseElectrumCredentials(url)]
    }

    return new ElectrumClient(
      credentials,
      options,
      totalRetryAttempts,
      retryBackoffStep,
      connectionTimeout
    )
  }

  /**
   * Creates an Electrum client instance using a default config for the given
   * Bitcoin network.
   * @param network Bitcoin network the instance should be created for.
   * @returns Electrum client instance.
   */
  static fromDefaultConfig(network: BitcoinNetwork): ElectrumClient {
    let file
    switch (network) {
      case BitcoinNetwork.Mainnet:
        file = MainnetElectrumUrls
        break
      case BitcoinNetwork.Testnet:
        file = TestnetElectrumUrls
        break
      default:
        throw new Error("No default Electrum for given network")
    }

    return ElectrumClient.fromUrl(file.urls)
  }

  /**
   * Create Electrum credentials by parsing an URL.
   * @param url - URL to be parsed.
   * @returns Electrum credentials object.
   */
  private static parseElectrumCredentials(url: string): ElectrumCredentials {
    const urlObj = new URL(url)

    return {
      host: urlObj.hostname,
      port: Number.parseInt(urlObj.port, 10),
      protocol: urlObj.protocol.replace(":", "") as
        | "tcp"
        | "tls"
        | "ssl"
        | "ws"
        | "wss",
    }
  }

  /**
   * Initiates an Electrum connection and uses it to feed the given action.
   * Closes the connection regardless of the action outcome.
   * @param action - Action that makes use of the Electrum connection.
   * @returns Promise holding the outcome.
   */
  private async withElectrum<T>(action: ElectrumAction<T>): Promise<T> {
    const connect = async (
      credentials: ElectrumCredentials
    ): Promise<Electrum> => {
      const electrum: Electrum = new Electrum(
        credentials.host,
        credentials.port,
        credentials.protocol,
        this.options
      )

      await this.withBackoffRetrier()(async () => {
        // FIXME: Connection timeout should be a property of the Electrum client.
        // Since it's not configurable in `electrum-client-js` we add timeout
        // as a workaround here.
        return pTimeout(
          (async () => {
            try {
              await electrum.connect("tbtc-v2", "1.4.2")
              await electrum.server_ping()
              return
            } catch (error) {
              throw new Error(`Electrum server connection failure: [${error}]`)
            }
          })(),
          this.connectionTimeout,
          `timed out on electrum connect after ${this.connectionTimeout} ms`
        )
      })

      return electrum
    }

    let electrum: Electrum | undefined = undefined
    for (const credentials of this.credentials) {
      try {
        electrum = await connect(credentials)
        break
      } catch (err) {
        console.warn(
          `failed to connect to electrum server: [${credentials.protocol}://${credentials.host}:${credentials.port}]: ${err}`
        )
      }
    }

    if (!electrum) {
      throw new Error("failed to connect to any of defined electrum servers")
    }

    try {
      return await action(electrum)
    } catch (error) {
      throw new Error(`Electrum action failure: [${error}]`)
    } finally {
      electrum.close()
    }
  }

  /**
   * Initiates a backoff retrier.
   * @returns A function that can retry any function.
   */
  private withBackoffRetrier<T>(): RetrierFn<T> {
    return backoffRetrier<T>(this.totalRetryAttempts, this.retryBackoffStep)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getNetwork}
   */
  getNetwork(): Promise<BitcoinNetwork> {
    return this.withElectrum<BitcoinNetwork>(async (electrum: Electrum) => {
      const { genesis_hash: genesisHash } = await this.withBackoffRetrier<{
        // eslint-disable-next-line camelcase
        genesis_hash: string
      }>()(async () => {
        return await electrum.server_features()
      })
      if (!genesisHash) {
        throw new Error(
          "server didn't return the 'genesis_hash' property from `server.features` request"
        )
      }

      return BitcoinNetwork.fromGenesisHash(Hex.from(genesisHash))
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#findAllUnspentTransactionOutputs}
   */
  findAllUnspentTransactionOutputs(address: string): Promise<BitcoinUtxo[]> {
    return this.withElectrum<BitcoinUtxo[]>(async (electrum: Electrum) => {
      const bitcoinNetwork = await this.getNetwork()

      const script = BitcoinAddressConverter.addressToOutputScript(
        address,
        bitcoinNetwork
      )

      // eslint-disable-next-line camelcase
      type UnspentOutput = { tx_pos: number; value: number; tx_hash: string }

      const unspentTransactions: UnspentOutput[] =
        await this.withBackoffRetrier<UnspentOutput[]>()(async () => {
          return await electrum.blockchain_scripthash_listunspent(
            computeElectrumScriptHash(script)
          )
        })

      return unspentTransactions.reverse().map((tx: UnspentOutput) => ({
        transactionHash: BitcoinTxHash.from(tx.tx_hash),
        outputIndex: tx.tx_pos,
        value: BigNumber.from(tx.value),
      }))
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getTransactionHistory}
   */
  getTransactionHistory(address: string, limit?: number): Promise<BitcoinTx[]> {
    return this.withElectrum<BitcoinTx[]>(async (electrum: Electrum) => {
      const bitcoinNetwork = await this.getNetwork()

      const script = BitcoinAddressConverter.addressToOutputScript(
        address,
        bitcoinNetwork
      )

      // eslint-disable-next-line camelcase
      type HistoryItem = { height: number; tx_hash: string }

      let historyItems: HistoryItem[] = await this.withBackoffRetrier<
        HistoryItem[]
      >()(async () => {
        return await electrum.blockchain_scripthash_getHistory(
          computeElectrumScriptHash(script)
        )
      })

      // According to https://electrumx.readthedocs.io/en/latest/protocol-methods.html#blockchain-scripthash-get-history
      // unconfirmed items living in the mempool are appended at the end of the
      // returned list and their height value is either -1 or 0. That means
      // we need to take all items with height >0 to obtain a confirmed txs
      // history.
      historyItems = historyItems.filter((item) => item.height > 0)

      // The list returned from blockchain.scripthash.get_history is sorted by
      // the block height in the ascending order though we are sorting it
      // again just in case (e.g. API contract changes).
      historyItems = historyItems.sort(
        (item1, item2) => item1.height - item2.height
      )

      if (
        typeof limit !== "undefined" &&
        limit > 0 &&
        historyItems.length > limit
      ) {
        historyItems = historyItems.slice(-limit)
      }

      const transactions = historyItems.map((item) =>
        this.getTransaction(BitcoinTxHash.from(item.tx_hash))
      )

      return Promise.all(transactions)
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getTransaction}
   */
  getTransaction(transactionHash: BitcoinTxHash): Promise<BitcoinTx> {
    return this.withElectrum<BitcoinTx>(async (electrum: Electrum) => {
      // We cannot use `blockchain_transaction_get` with `verbose = true` argument
      // to get the the transaction details as Esplora/Electrs doesn't support verbose
      // transactions.
      // See: https://github.com/Blockstream/electrs/pull/36
      const rawTransaction: string = await this.withBackoffRetrier<string>()(
        async () => {
          return await electrum.blockchain_transaction_get(
            transactionHash.toString(),
            false
          )
        }
      )

      if (!rawTransaction) {
        throw new Error(`Transaction not found`)
      }

      // Decode the raw transaction.
      const transaction = Tx.fromHex(rawTransaction)

      const inputs = transaction.ins.map(
        (input: TxInput): BitcoinTxInput => ({
          transactionHash: BitcoinTxHash.from(input.hash).reverse(),
          outputIndex: input.index,
          scriptSig: Hex.from(input.script),
        })
      )

      const outputs = transaction.outs.map(
        (output: TxOutput, i: number): BitcoinTxOutput => ({
          outputIndex: i,
          value: BigNumber.from(output.value),
          scriptPubKey: Hex.from(output.script),
        })
      )

      return {
        transactionHash: BitcoinTxHash.from(transaction.getId()),
        inputs: inputs,
        outputs: outputs,
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getRawTransaction}
   */
  getRawTransaction(transactionHash: BitcoinTxHash): Promise<BitcoinRawTx> {
    return this.withElectrum<BitcoinRawTx>(async (electrum: Electrum) => {
      const transaction: string = await this.withBackoffRetrier<string>()(
        async () => {
          return await electrum.blockchain_transaction_get(
            transactionHash.toString(),
            false
          )
        }
      )

      return {
        transactionHex: transaction,
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getTransactionConfirmations}
   */
  getTransactionConfirmations(transactionHash: BitcoinTxHash): Promise<number> {
    // We cannot use `blockchain_transaction_get` with `verbose = true` argument
    // to get the the transaction details as Esplora/Electrs doesn't support verbose
    // transactions.
    // See: https://github.com/Blockstream/electrs/pull/36

    return this.withElectrum<number>(async (electrum: Electrum) => {
      const rawTransaction: string = await this.withBackoffRetrier<string>()(
        async () => {
          return await electrum.blockchain_transaction_get(
            transactionHash.toString(),
            false
          )
        }
      )

      // Decode the raw transaction.
      const transaction = Tx.fromHex(rawTransaction)

      // As a workaround for the problem described in https://github.com/Blockstream/electrs/pull/36
      // we need to calculate the number of confirmations based on the latest
      // block height and block height of the transaction.
      // Electrum protocol doesn't expose a function to get the transaction's block
      // height (other that the `GetTransaction` that is unsupported by Esplora/Electrs).
      // To get the block height of the transaction we query the history of transactions
      // for the output script hash, as the history contains the transaction's block
      // height.

      // Initialize txBlockHeigh with minimum int32 value to identify a problem when
      // a block height was not found in a history of any of the script hashes.
      //
      // The history is expected to return a block height for confirmed transaction.
      // If a transaction is unconfirmed (is still in the mempool) the height will
      // have a value of `0` or `-1`.
      let txBlockHeight: number = Math.min()
      for (const output of transaction.outs) {
        const scriptHash: Buffer = BitcoinHashUtils.computeSha256(
          Hex.from(output.script)
        ).toBuffer()

        type HistoryEntry = {
          // eslint-disable-next-line camelcase
          tx_hash: string
          height: number
        }

        const scriptHashHistory: HistoryEntry[] = await this.withBackoffRetrier<
          HistoryEntry[]
        >()(async () => {
          return await electrum.blockchain_scripthash_getHistory(
            scriptHash.reverse().toString("hex")
          )
        })

        const tx = scriptHashHistory.find(
          (t) => t.tx_hash === transactionHash.toString()
        )

        if (tx) {
          txBlockHeight = tx.height
          break
        }
      }

      // History querying didn't come up with the transaction's block height. Return
      // an error.
      if (txBlockHeight === Math.min()) {
        throw new Error(
          "failed to find the transaction block height in script hashes' histories"
        )
      }

      // If the block height is greater than `0` the transaction is confirmed.
      if (txBlockHeight > 0) {
        const latestBlockHeight: number = await this.latestBlockHeight()

        if (latestBlockHeight >= txBlockHeight) {
          // Add `1` to the calculated difference as if the transaction block
          // height equals the latest block height the transaction is already
          // confirmed, so it has one confirmation.
          return latestBlockHeight - txBlockHeight + 1
        }
      }

      return 0
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getTxHashesForPublicKeyHash}
   */
  getTxHashesForPublicKeyHash(publicKeyHash: Hex): Promise<BitcoinTxHash[]> {
    return this.withElectrum<BitcoinTxHash[]>(async (electrum: Electrum) => {
      const bitcoinNetwork = await this.getNetwork()

      // eslint-disable-next-line camelcase
      type HistoryItem = { height: number; tx_hash: string }

      const getConfirmedHistory = async (
        witnessAddress: boolean
      ): Promise<HistoryItem[]> => {
        const address = BitcoinAddressConverter.publicKeyHashToAddress(
          publicKeyHash,
          witnessAddress,
          bitcoinNetwork
        )

        const script = BitcoinAddressConverter.addressToOutputScript(
          address,
          bitcoinNetwork
        )

        let historyItems: HistoryItem[] = await this.withBackoffRetrier<
          HistoryItem[]
        >()(async () => {
          return await electrum.blockchain_scripthash_getHistory(
            computeElectrumScriptHash(script)
          )
        })

        // According to https://electrumx.readthedocs.io/en/latest/protocol-methods.html#blockchain-scripthash-get-history
        // unconfirmed items living in the mempool are appended at the end of the
        // returned list and their height value is either -1 or 0. That means
        // we need to take all items with height >0 to obtain a confirmed txs
        // history.
        historyItems = historyItems.filter((item) => item.height > 0)

        // The list returned from blockchain.scripthash.get_history is sorted by
        // the block height in the ascending order though we are sorting it
        // again just in case (e.g. API contract changes).
        historyItems = historyItems.sort((a, b) => a.height - b.height)

        return historyItems
      }

      const p2pkhItems = await getConfirmedHistory(false)
      const p2wpkhItems = await getConfirmedHistory(true)

      const items = [...p2pkhItems, ...p2wpkhItems]
      items.sort((a, b) => a.height - b.height)

      return items.map((item) => BitcoinTxHash.from(item.tx_hash))
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#latestBlockHeight}
   */
  latestBlockHeight(): Promise<number> {
    return this.withElectrum<number>(async (electrum: Electrum) => {
      const { height } = await this.withBackoffRetrier<{
        height: number
      }>()(async () => {
        return await electrum.blockchain_headers_subscribe()
      })

      return height
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getHeadersChain}
   */
  getHeadersChain(blockHeight: number, chainLength: number): Promise<Hex> {
    return this.withElectrum<Hex>(async (electrum: Electrum) => {
      const { hex } = await this.withBackoffRetrier<{
        hex: string
      }>()(async () => {
        return await electrum.blockchain_block_headers(
          blockHeight,
          chainLength + 1
        )
      })

      return Hex.from(hex)
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getTransactionMerkle}
   */
  getTransactionMerkle(
    transactionHash: BitcoinTxHash,
    blockHeight: number
  ): Promise<BitcoinTxMerkleBranch> {
    return this.withElectrum<BitcoinTxMerkleBranch>(
      async (electrum: Electrum) => {
        const merkle = await this.withBackoffRetrier<{
          // eslint-disable-next-line camelcase
          block_height: number
          merkle: string[]
          pos: number
        }>()(async () => {
          return await electrum.blockchain_transaction_getMerkle(
            transactionHash.toString(),
            blockHeight
          )
        })

        return {
          blockHeight: merkle.block_height,
          merkle: merkle.merkle.map((m) => Hex.from(m)),
          position: merkle.pos,
        }
      }
    )
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#broadcast}
   */
  broadcast(transaction: BitcoinRawTx): Promise<void> {
    return this.withElectrum<void>(async (electrum: Electrum) => {
      await this.withBackoffRetrier<string>()(async () => {
        return await electrum.blockchain_transaction_broadcast(
          transaction.transactionHex
        )
      })
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinClient#getCoinbaseTxHash}
   */
  getCoinbaseTxHash(blockHeight: number): Promise<BitcoinTxHash> {
    return this.withElectrum<BitcoinTxHash>(async (electrum: Electrum) => {
      const txHash = await this.withBackoffRetrier<string>()(async () => {
        return await electrum.request("blockchain.transaction.id_from_pos", [
          blockHeight,
          0,
          false,
        ])
      })

      return BitcoinTxHash.from(txHash)
    })
  }
}

/**
 * Converts a Bitcoin script to an Electrum script hash. See
 * [Electrum protocol]{@link https://electrumx.readthedocs.io/en/stable/protocol-basics.html#script-hashes}
 * @param script - Bitcoin script as hex string
 * @returns Electrum script hash as a hex string.
 */
export function computeElectrumScriptHash(script: Hex): string {
  return BitcoinHashUtils.computeSha256(script).reverse().toString()
}
