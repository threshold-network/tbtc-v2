import { Block, Transaction } from "bitcoinjs-lib"
import type {
  P2TRBitcoinChainPoint,
  P2TRCanonicalBitcoinBlock,
  P2TRCanonicalBitcoinBlockSource,
  P2TRCanonicalBitcoinTransaction,
} from "./P2TRCanonicalBitcoinIndex.js"

export interface P2TRBitcoinCoreRpc {
  call<T>(method: string, parameters?: readonly unknown[]): Promise<T>
}

export type P2TRBitcoinCoreFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>

export type HttpP2TRBitcoinCoreRpcOptions = {
  url: string
  username: string
  password: string
  fetchFn?: P2TRBitcoinCoreFetch
  requestTimeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
  maxResponseBytes?: number
}

export type BitcoinCoreP2TRCanonicalBlockSourceOptions = {
  trustDomainID: string
  /** Bitcoin Core `getblockchaininfo.chain` value. */
  network: "main" | "test" | "testnet4" | "signet" | "regtest"
  expectedGenesisHash: string
  maxHeaderLag?: number
  minimumVerificationProgress?: number
  maxBlockBytes?: number
  maxBlockWeight?: number
  maxRawTransactionBytes?: number
  prevoutFetchConcurrency?: number
}

type BitcoinCoreChainInfo = {
  chain: string
  blocks: number
  headers: number
  initialblockdownload: boolean
  verificationprogress: number
  pruned: boolean
}

type BitcoinCoreIndexInfo = Record<
  string,
  { synced?: boolean; best_block_height?: number }
>

type BitcoinCoreNetworkInfo = { version: number }

type BitcoinCoreVerboseBlock = {
  hash: string
  height: number
  previousblockhash?: string
  tx: Array<{
    txid: string
    hash: string
    vin: Array<{
      coinbase?: string
      txid?: string
      vout?: number
      prevout?: {
        value?: number
        scriptPubKey?: { hex?: string }
      }
    }>
  }>
}

type BitcoinCoreRpcEnvelope<T> = {
  result?: T
  error?: { code?: number; message?: string } | null
  id?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 250
// Verbosity-3 JSON expands a consensus-valid block substantially. This is a
// transport integrity bound, not an indexing-completeness cap.
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_BLOCK_BYTES = 4_000_000
const DEFAULT_MAX_BLOCK_WEIGHT = 4_000_000
const DEFAULT_PREVOUT_FETCH_CONCURRENCY = 8

/**
 * Bounded JSON-RPC transport suitable for a dedicated Bitcoin Core node.
 * Authentication values are never included in thrown errors.
 */
export class HttpP2TRBitcoinCoreRpc implements P2TRBitcoinCoreRpc {
  private readonly url: string
  private readonly authorization: string
  private readonly fetchFn: P2TRBitcoinCoreFetch
  private readonly requestTimeoutMs: number
  private readonly maxAttempts: number
  private readonly retryDelayMs: number
  private readonly maxResponseBytes: number
  private requestID = 0

  constructor(options: HttpP2TRBitcoinCoreRpcOptions) {
    const url = new URL(options.url)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Bitcoin Core RPC URL must use http or https")
    }
    if (options.username.length === 0 || options.password.length === 0) {
      throw new Error("Bitcoin Core RPC credentials must be non-empty")
    }

    this.url = url.toString()
    this.authorization = `Basic ${Buffer.from(
      `${options.username}:${options.password}`
    ).toString("base64")}`
    this.fetchFn = options.fetchFn ?? fetch
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "Bitcoin Core RPC request timeout"
    )
    this.maxAttempts = positiveInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "Bitcoin Core RPC attempt count"
    )
    this.retryDelayMs = nonNegativeInteger(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      "Bitcoin Core RPC retry delay"
    )
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "Bitcoin Core RPC response byte bound"
    )
    if (this.maxResponseBytes < DEFAULT_MAX_RESPONSE_BYTES) {
      throw new Error(
        `Canonical verbosity-3 RPC responses require at least the ${DEFAULT_MAX_RESPONSE_BYTES}-byte transport bound`
      )
    }
  }

  async call<T>(
    method: string,
    parameters: readonly unknown[] = []
  ): Promise<T> {
    if (!/^[a-z][a-z0-9]*$/i.test(method)) {
      throw new Error("Bitcoin Core RPC method is invalid")
    }

    const requestID = ++this.requestID
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const response = await this.fetchFn(this.url, {
          method: "POST",
          headers: {
            authorization: this.authorization,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestID,
            method,
            params: parameters,
          }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        })

        const contentLength = response.headers.get("content-length")
        if (
          contentLength !== null &&
          Number(contentLength) > this.maxResponseBytes
        ) {
          throw new NonRetryableBitcoinCoreRpcError(
            `Bitcoin Core RPC response exceeds the configured ${this.maxResponseBytes}-byte bound`
          )
        }

        const body = await readBoundedResponseBody(
          response,
          this.maxResponseBytes
        )
        if (!response.ok) {
          const error = new Error(
            `Bitcoin Core RPC HTTP request failed with status ${response.status}`
          )
          if (response.status < 500 && response.status !== 429) {
            throw new NonRetryableBitcoinCoreRpcError(error.message)
          }
          throw error
        }

        let envelope: BitcoinCoreRpcEnvelope<T>
        try {
          envelope = JSON.parse(
            body.toString("utf8")
          ) as BitcoinCoreRpcEnvelope<T>
        } catch {
          throw new NonRetryableBitcoinCoreRpcError(
            "Bitcoin Core RPC response is not valid JSON"
          )
        }
        if (envelope.id !== requestID) {
          throw new NonRetryableBitcoinCoreRpcError(
            "Bitcoin Core RPC response ID does not match the request"
          )
        }
        if (envelope.error !== undefined && envelope.error !== null) {
          throw new NonRetryableBitcoinCoreRpcError(
            `Bitcoin Core RPC ${method} failed (${String(
              envelope.error.code ?? "unknown"
            )}): ${envelope.error.message ?? "unknown error"}`
          )
        }
        if (!("result" in envelope)) {
          throw new NonRetryableBitcoinCoreRpcError(
            `Bitcoin Core RPC ${method} omitted its result`
          )
        }
        return envelope.result as T
      } catch (error) {
        lastError = error
        if (
          error instanceof NonRetryableBitcoinCoreRpcError ||
          attempt === this.maxAttempts
        ) {
          throw error
        }
        if (this.retryDelayMs > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, this.retryDelayMs)
          )
        }
      }
    }

    throw lastError
  }
}

/**
 * Canonical, confirmed-only Bitcoin block source backed by a fully synced
 * Bitcoin Core node. `getrawtransaction` intentionally requires `txindex=1` so
 * every input prevout can be authenticated from raw transaction bytes. The
 * configured node's `getblockhash` result selects the chain: local header/root
 * and target checks detect corrupt responses but do not independently validate
 * difficulty transitions or compare cumulative chainwork with another node.
 */
export class BitcoinCoreP2TRCanonicalBlockSource
  implements P2TRCanonicalBitcoinBlockSource
{
  readonly trustDomainID: string
  readonly network: string
  private readonly expectedGenesisHash: string
  private readonly maxHeaderLag: number
  private readonly minimumVerificationProgress: number
  private readonly maxBlockBytes: number
  private readonly maxBlockWeight: number
  private readonly maxRawTransactionBytes: number
  private readonly prevoutFetchConcurrency: number

  constructor(
    private readonly rpc: P2TRBitcoinCoreRpc,
    options: BitcoinCoreP2TRCanonicalBlockSourceOptions
  ) {
    this.trustDomainID = nonEmptyString(
      options.trustDomainID,
      "Bitcoin Core trust-domain ID"
    )
    this.network = options.network
    this.expectedGenesisHash = normalizeHash(
      options.expectedGenesisHash,
      "Bitcoin genesis hash"
    )
    this.maxHeaderLag = nonNegativeInteger(
      options.maxHeaderLag ?? 0,
      "Bitcoin Core maximum header lag"
    )
    this.minimumVerificationProgress =
      options.minimumVerificationProgress ?? 0.999999
    if (
      !Number.isFinite(this.minimumVerificationProgress) ||
      this.minimumVerificationProgress <= 0 ||
      this.minimumVerificationProgress > 1
    ) {
      throw new Error(
        "Bitcoin Core minimum verification progress must be in (0, 1]"
      )
    }
    this.maxBlockBytes = positiveInteger(
      options.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES,
      "Bitcoin block byte bound"
    )
    this.maxBlockWeight = positiveInteger(
      options.maxBlockWeight ?? DEFAULT_MAX_BLOCK_WEIGHT,
      "Bitcoin block weight bound"
    )
    this.maxRawTransactionBytes = positiveInteger(
      options.maxRawTransactionBytes ?? this.maxBlockBytes,
      "Bitcoin raw transaction byte bound"
    )
    this.prevoutFetchConcurrency = positiveInteger(
      options.prevoutFetchConcurrency ?? DEFAULT_PREVOUT_FETCH_CONCURRENCY,
      "Bitcoin prevout fetch concurrency"
    )
    if (
      this.maxBlockBytes < DEFAULT_MAX_BLOCK_BYTES ||
      this.maxBlockWeight < DEFAULT_MAX_BLOCK_WEIGHT ||
      this.maxRawTransactionBytes < this.maxBlockBytes
    ) {
      throw new Error(
        "Canonical Bitcoin production bounds cannot be lower than consensus block byte/weight ceilings"
      )
    }
  }

  async getSyncedHead(): Promise<P2TRBitcoinChainPoint> {
    const [chainInfo, indexInfo, networkInfo] = await Promise.all([
      this.rpc.call<BitcoinCoreChainInfo>("getblockchaininfo"),
      this.rpc.call<BitcoinCoreIndexInfo>("getindexinfo"),
      this.rpc.call<BitcoinCoreNetworkInfo>("getnetworkinfo"),
    ])
    validateChainInfo(chainInfo)
    if (chainInfo.chain !== this.network) {
      throw new Error(
        `Bitcoin Core network ${chainInfo.chain} does not match configured ${this.network}`
      )
    }
    if (chainInfo.initialblockdownload) {
      throw new Error("Bitcoin Core is still in initial block download")
    }
    if (
      !Number.isSafeInteger(networkInfo.version) ||
      networkInfo.version < 230000
    ) {
      throw new Error(
        "Canonical Bitcoin indexing requires Bitcoin Core 23 or newer for verbosity-3 prevouts"
      )
    }
    if (chainInfo.pruned) {
      throw new Error(
        "Canonical Bitcoin indexing requires an unpruned Bitcoin Core node"
      )
    }
    if (chainInfo.headers - chainInfo.blocks > this.maxHeaderLag) {
      throw new Error(
        `Bitcoin Core block height trails headers by more than ${this.maxHeaderLag}`
      )
    }
    if (chainInfo.verificationprogress < this.minimumVerificationProgress) {
      throw new Error(
        "Bitcoin Core verification progress is below the configured minimum"
      )
    }
    const transactionIndex = indexInfo.txindex
    if (
      transactionIndex?.synced !== true ||
      transactionIndex.best_block_height !== chainInfo.blocks
    ) {
      throw new Error(
        "Canonical Bitcoin indexing requires a fully synchronized txindex=1"
      )
    }

    const [genesisHash, headHash] = await Promise.all([
      this.getBlockHash(0),
      this.getBlockHash(chainInfo.blocks),
    ])
    if (genesisHash !== this.expectedGenesisHash) {
      throw new Error("Bitcoin Core genesis hash does not match configuration")
    }

    return { height: chainInfo.blocks, hash: headHash }
  }

  async getBlockHash(height: number): Promise<string> {
    nonNegativeInteger(height, "Bitcoin block height")
    return normalizeHash(
      await this.rpc.call<string>("getblockhash", [height]),
      `Bitcoin block ${height} hash`
    )
  }

  async getBlock(height: number): Promise<P2TRCanonicalBitcoinBlock> {
    nonNegativeInteger(height, "Bitcoin block height")
    const hash = await this.getBlockHash(height)
    const [rawBlockResult, verboseBlock] = await Promise.all([
      this.rpc.call<string>("getblock", [hash, 0]),
      this.rpc.call<BitcoinCoreVerboseBlock>("getblock", [hash, 3]),
    ])
    const rawBlockHex = normalizeHex(rawBlockResult, `Bitcoin block ${height}`)
    const rawBlockBytes = rawBlockHex.length / 2
    if (rawBlockBytes > this.maxBlockBytes) {
      throw new Error(
        `Bitcoin block ${height} exceeds the configured ${this.maxBlockBytes}-byte bound`
      )
    }

    let block: Block
    try {
      block = Block.fromHex(rawBlockHex)
    } catch {
      throw new Error(`Bitcoin block ${height} is malformed`)
    }
    if (block.getId() !== hash) {
      throw new Error(`Bitcoin block ${height} raw bytes do not match its hash`)
    }
    if (!block.checkTxRoots()) {
      throw new Error(`Bitcoin block ${height} has invalid transaction roots`)
    }
    if (!block.checkProofOfWork()) {
      throw new Error(
        `Bitcoin block ${height} hash does not satisfy its declared proof-of-work target`
      )
    }
    if (block.weight() > this.maxBlockWeight) {
      throw new Error(
        `Bitcoin block ${height} exceeds the configured ${this.maxBlockWeight}-weight bound`
      )
    }
    if (height > 0 && block.prevHash === undefined) {
      throw new Error(`Bitcoin block ${height} omits its parent hash`)
    }
    if (block.transactions === undefined || block.transactions.length === 0) {
      throw new Error(`Bitcoin block ${height} contains no transactions`)
    }
    validateVerboseBlock(verboseBlock, height, hash, block)

    const transactions = block.transactions.map(
      (transaction, transactionIndex) =>
        materializeTransactionWithPrevouts(
          transaction,
          verboseBlock.tx[transactionIndex],
          this.maxRawTransactionBytes
        )
    )
    await this.authenticateBlockPrevouts(transactions)

    return {
      height,
      hash,
      parentHash:
        height === 0
          ? "0".repeat(64)
          : Buffer.from(block.prevHash as Buffer)
              .reverse()
              .toString("hex"),
      rawBlockHex,
      transactions,
    }
  }

  async getRawTransaction(
    txid: string
  ): Promise<P2TRCanonicalBitcoinTransaction> {
    const normalizedTxid = normalizeHash(txid, "Bitcoin transaction ID")
    let rawTransactionHex: string
    try {
      rawTransactionHex = normalizeHex(
        await this.rpc.call<string>("getrawtransaction", [
          normalizedTxid,
          false,
        ]),
        `Bitcoin transaction ${normalizedTxid}`
      )
    } catch (error) {
      throw new Error(
        `Bitcoin Core could not load prevout transaction ${normalizedTxid}; production indexing requires txindex=1: ${errorMessage(
          error
        )}`
      )
    }
    if (rawTransactionHex.length / 2 > this.maxRawTransactionBytes) {
      throw new Error(
        `Bitcoin transaction ${normalizedTxid} exceeds the configured ${this.maxRawTransactionBytes}-byte bound`
      )
    }

    let transaction: Transaction
    try {
      transaction = Transaction.fromHex(rawTransactionHex)
    } catch {
      throw new Error(`Bitcoin transaction ${normalizedTxid} is malformed`)
    }
    const materialized = materializeTransaction(
      transaction,
      this.maxRawTransactionBytes
    )
    if (materialized.txid !== normalizedTxid) {
      throw new Error(
        `Bitcoin transaction raw bytes do not match requested txid ${normalizedTxid}`
      )
    }
    return materialized
  }

  private async authenticateBlockPrevouts(
    transactions: P2TRCanonicalBitcoinTransaction[]
  ): Promise<void> {
    const sameBlock = new Map(
      transactions.map((transaction) => [transaction.txid, transaction])
    )
    const externalTxids = [
      ...new Set(
        transactions.flatMap((transaction) =>
          transaction.coinbase
            ? []
            : transaction.inputs
                .map((input) => input.txid)
                .filter((txid) => !sameBlock.has(txid))
        )
      ),
    ]
    const external = new Map<string, P2TRCanonicalBitcoinTransaction>()
    await mapWithConcurrency(
      externalTxids,
      this.prevoutFetchConcurrency,
      async (txid) => {
        external.set(txid, await this.getRawTransaction(txid))
      }
    )

    for (const transaction of transactions) {
      if (transaction.coinbase) continue
      for (const input of transaction.inputs) {
        const previousTransaction =
          sameBlock.get(input.txid) ?? external.get(input.txid)
        const rawPrevout = previousTransaction?.outputs[input.vout]
        const reportedPrevout = input.authenticatedPrevout
        if (
          rawPrevout === undefined ||
          reportedPrevout === undefined ||
          rawPrevout.txid !== input.txid ||
          rawPrevout.vout !== input.vout ||
          rawPrevout.valueSats !== reportedPrevout.valueSats ||
          rawPrevout.scriptPubKey !== reportedPrevout.scriptPubKey
        ) {
          throw new Error(
            `Bitcoin verbosity-3 prevout does not match raw transaction ${input.txid}:${input.vout}`
          )
        }
        input.authenticatedPrevout = rawPrevout
      }
    }
  }
}

const materializeTransaction = (
  transaction: Transaction,
  maxRawTransactionBytes: number
): P2TRCanonicalBitcoinTransaction => {
  const rawTransactionHex = transaction.toHex()
  if (rawTransactionHex.length / 2 > maxRawTransactionBytes) {
    throw new Error(
      `Bitcoin transaction ${transaction.getId()} exceeds the configured ${maxRawTransactionBytes}-byte bound`
    )
  }
  const txid = transaction.getId()

  return {
    txid,
    wtxid: Buffer.from(transaction.getHash(true)).reverse().toString("hex"),
    rawTransactionHex,
    coinbase: transaction.isCoinbase(),
    inputs: transaction.ins.map((input, inputIndex) => ({
      txid: Buffer.from(input.hash).reverse().toString("hex"),
      vout: input.index,
      spendingTxid: txid,
      inputIndex,
    })),
    outputs: transaction.outs.map((output, vout) => ({
      txid,
      vout,
      valueSats: output.value,
      scriptPubKey: output.script.toString("hex"),
    })),
  }
}

const materializeTransactionWithPrevouts = (
  transaction: Transaction,
  verboseTransaction: BitcoinCoreVerboseBlock["tx"][number],
  maxRawTransactionBytes: number
): P2TRCanonicalBitcoinTransaction => {
  const materialized = materializeTransaction(
    transaction,
    maxRawTransactionBytes
  )
  if (
    normalizeHash(verboseTransaction.txid, "verbose transaction ID") !==
    materialized.txid
  ) {
    throw new Error(
      `Bitcoin verbosity-3 transaction order does not match raw block at ${materialized.txid}`
    )
  }
  if (
    normalizeHash(verboseTransaction.hash, "verbose witness transaction ID") !==
    materialized.wtxid
  ) {
    throw new Error(
      `Bitcoin verbosity-3 witness transaction ID does not match raw block at ${materialized.txid}`
    )
  }
  if (verboseTransaction.vin.length !== materialized.inputs.length) {
    throw new Error(
      `Bitcoin verbosity-3 input vector does not match raw transaction ${materialized.txid}`
    )
  }
  if (materialized.coinbase) {
    if (
      verboseTransaction.vin.length !== 1 ||
      verboseTransaction.vin[0].coinbase === undefined
    ) {
      throw new Error(
        `Bitcoin verbosity-3 coinbase ${materialized.txid} is malformed`
      )
    }
    return materialized
  }

  return {
    ...materialized,
    inputs: materialized.inputs.map((input, inputIndex) => {
      const verboseInput = verboseTransaction.vin[inputIndex]
      if (
        normalizeHash(verboseInput.txid, "verbosity-3 prevout txid") !==
          input.txid ||
        verboseInput.vout !== input.vout
      ) {
        throw new Error(
          `Bitcoin verbosity-3 prevout does not match raw input ${materialized.txid}:${inputIndex}`
        )
      }
      const valueSats = bitcoinAmountToSatoshis(verboseInput.prevout?.value)
      const scriptPubKey = normalizeHex(
        verboseInput.prevout?.scriptPubKey?.hex,
        `Bitcoin verbosity-3 prevout script ${input.txid}:${input.vout}`
      )
      return {
        ...input,
        authenticatedPrevout: {
          txid: input.txid,
          vout: input.vout,
          valueSats,
          scriptPubKey,
        },
      }
    }),
  }
}

const validateVerboseBlock = (
  verboseBlock: BitcoinCoreVerboseBlock,
  height: number,
  hash: string,
  rawBlock: Block
): void => {
  if (
    typeof verboseBlock !== "object" ||
    verboseBlock === null ||
    normalizeHash(verboseBlock.hash, "verbosity-3 block hash") !== hash ||
    verboseBlock.height !== height ||
    !Array.isArray(verboseBlock.tx) ||
    verboseBlock.tx.length !== rawBlock.transactions?.length
  ) {
    throw new Error(
      `Bitcoin verbosity-3 block ${height} does not match the raw canonical block`
    )
  }
  if (height > 0) {
    const rawParent = Buffer.from(rawBlock.prevHash as Buffer)
      .reverse()
      .toString("hex")
    if (
      normalizeHash(
        verboseBlock.previousblockhash,
        "verbosity-3 parent hash"
      ) !== rawParent
    ) {
      throw new Error(
        `Bitcoin verbosity-3 block ${height} parent does not match raw bytes`
      )
    }
  }
}

const bitcoinAmountToSatoshis = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Bitcoin verbosity-3 prevout value is invalid")
  }
  const satoshis = Math.round(value * 100_000_000)
  if (!Number.isSafeInteger(satoshis) || satoshis < 0) {
    throw new Error("Bitcoin verbosity-3 prevout value exceeds the safe range")
  }
  if (Math.abs(value - satoshis / 100_000_000) > 1e-12) {
    throw new Error(
      "Bitcoin verbosity-3 prevout value has sub-satoshi precision"
    )
  }
  return satoshis
}

const validateChainInfo = (value: BitcoinCoreChainInfo): void => {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.chain !== "string" ||
    !Number.isSafeInteger(value.blocks) ||
    value.blocks < 0 ||
    !Number.isSafeInteger(value.headers) ||
    value.headers < value.blocks ||
    typeof value.initialblockdownload !== "boolean" ||
    typeof value.pruned !== "boolean" ||
    typeof value.verificationprogress !== "number" ||
    !Number.isFinite(value.verificationprogress)
  ) {
    throw new Error("Bitcoin Core returned malformed blockchain information")
  }
}

const normalizeHash = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${field} must be a 32-byte hex value`)
  }
  return value.toLowerCase()
}

const normalizeHex = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error(`${field} must be non-empty, even-length hex`)
  }
  return value.toLowerCase()
}

const positiveInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  return value
}

const nonNegativeInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return value
}

const nonEmptyString = (value: string, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`)
  }
  return value.trim()
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const readBoundedResponseBody = async (
  response: Response,
  maxBytes: number
): Promise<Buffer> => {
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytesRead = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      bytesRead += chunk.length
      if (bytesRead > maxBytes) {
        await reader.cancel()
        throw new NonRetryableBitcoinCoreRpcError(
          `Bitcoin Core RPC response exceeds the configured ${maxBytes}-byte bound`
        )
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, bytesRead)
}

const mapWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<void>
): Promise<void> => {
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      await operation(items[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  )
}

class NonRetryableBitcoinCoreRpcError extends Error {}
