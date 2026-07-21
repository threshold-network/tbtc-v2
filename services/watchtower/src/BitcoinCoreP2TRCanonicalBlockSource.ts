import { createHash } from "node:crypto"
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

type BitcoinCoreRpcEnvelope<T> = {
  result?: T
  error?: { code?: number; message?: string } | null
  id?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 250
// Raw consensus blocks are returned as hex (at most twice the four-megabyte
// serialized block ceiling) plus a small JSON-RPC envelope. No expanded
// verbosity response participates in production ingestion.
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_BLOCK_BYTES = 4_000_000
const DEFAULT_MAX_BLOCK_WEIGHT = 4_000_000
const MAX_BITCOIN_MONEY_SATS = 21_000_000 * 100_000_000

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
        `Canonical raw-block RPC responses require at least the ${DEFAULT_MAX_RESPONSE_BYTES}-byte transport bound`
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
 * each raw block can seed the sequential occurrence journal used to
 * authenticate input prevouts. The
 * configured node's `getblockhash` result selects the chain: local header/root
 * and target checks detect corrupt responses but do not independently validate
 * difficulty transitions or compare cumulative chainwork with another node.
 */
export class BitcoinCoreP2TRCanonicalBlockSource
  implements P2TRCanonicalBitcoinBlockSource
{
  readonly trustDomainID: string
  readonly network: string
  readonly genesisHash: string
  private readonly maxHeaderLag: number
  private readonly minimumVerificationProgress: number
  private readonly maxBlockBytes: number
  private readonly maxBlockWeight: number
  private readonly maxRawTransactionBytes: number

  constructor(
    private readonly rpc: P2TRBitcoinCoreRpc,
    options: BitcoinCoreP2TRCanonicalBlockSourceOptions
  ) {
    this.trustDomainID = nonEmptyString(
      options.trustDomainID,
      "Bitcoin Core trust-domain ID"
    )
    this.network = options.network
    this.genesisHash = normalizeHash(
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
        "Canonical Bitcoin indexing requires Bitcoin Core 23 or newer"
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
    if (genesisHash !== this.genesisHash) {
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
    const rawBlockResult = await this.rpc.call<string>("getblock", [hash, 0])
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
    if (block.toHex() !== rawBlockHex) {
      throw new Error(`Bitcoin block ${height} is not canonically encoded`)
    }
    if (block.getId() !== hash) {
      throw new Error(`Bitcoin block ${height} raw bytes do not match its hash`)
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
    const transactions = block.transactions.map((transaction) =>
      materializeTransaction(transaction, this.maxRawTransactionBytes)
    )
    validateCanonicalBlockTransactions(block, transactions, height)
    if (!block.checkTxRoots()) {
      throw new Error(`Bitcoin block ${height} has invalid transaction roots`)
    }

    return {
      height,
      hash,
      parentHash:
        height === 0
          ? "0".repeat(64)
          : Buffer.from(block.prevHash as Buffer)
              .reverse()
              .toString("hex"),
      // A serialized block begins with the exact 80-byte consensus header.
      // Persist it separately so an immutable export can authenticate the
      // header chain without materializing the complete raw block.
      header80Hex: rawBlockHex.slice(0, 160),
      rawBlockHex,
      transactions,
    }
  }

  async getRawTransaction(
    txid: string
  ): Promise<P2TRCanonicalBitcoinTransaction> {
    const normalizedTxid = normalizeHash(txid, "Bitcoin transaction ID")
    return this.fetchRawTransaction(normalizedTxid)
  }

  private async fetchRawTransaction(
    normalizedTxid: string,
    blockHash?: string
  ): Promise<P2TRCanonicalBitcoinTransaction> {
    let rawTransactionHex: string
    try {
      rawTransactionHex = normalizeHex(
        await this.rpc.call<string>("getrawtransaction", [
          normalizedTxid,
          false,
          ...(blockHash === undefined ? [] : [blockHash]),
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
}

const validateCanonicalBlockTransactions = (
  block: Block,
  transactions: P2TRCanonicalBitcoinTransaction[],
  height: number
): void => {
  const rawTransactions = block.transactions
  if (
    rawTransactions === undefined ||
    rawTransactions.length !== transactions.length ||
    transactions.length === 0
  ) {
    throw new Error(`Bitcoin block ${height} has inconsistent transactions`)
  }

  if (!transactions[0].coinbase) {
    throw new Error(`Bitcoin block ${height} does not begin with coinbase`)
  }
  if (transactions.slice(1).some(({ coinbase }) => coinbase)) {
    throw new Error(
      `Bitcoin block ${height} contains multiple coinbase transactions`
    )
  }

  const transactionMerkle = calculateBitcoinMerkleRoot(
    transactions.map(({ txid }) => txid)
  )
  if (transactionMerkle.mutated) {
    throw new Error(
      `Bitcoin block ${height} has a mutated transaction merkle tree`
    )
  }
  if (
    block.merkleRoot === undefined ||
    !transactionMerkle.root.equals(block.merkleRoot)
  ) {
    throw new Error(
      `Bitcoin block ${height} has an invalid transaction merkle root`
    )
  }
  const witnessMerkle = calculateBitcoinMerkleRoot(
    transactions.map(({ wtxid }, index) =>
      index === 0 ? "0".repeat(64) : wtxid
    )
  )
  if (witnessMerkle.mutated) {
    throw new Error(`Bitcoin block ${height} has a mutated witness merkle tree`)
  }

  assertUniqueTransactionHashes(
    transactions.map(({ txid }) => txid),
    `Bitcoin block ${height} contains duplicate transaction IDs`
  )
  assertUniqueTransactionHashes(
    transactions.map(({ wtxid }) => wtxid),
    `Bitcoin block ${height} contains duplicate witness transaction IDs`
  )

  rawTransactions.forEach((transaction, transactionIndex) => {
    if (transaction.ins.length === 0 || transaction.outs.length === 0) {
      throw new Error(
        `Bitcoin block ${height} transaction ${transactionIndex} has empty inputs or outputs`
      )
    }
    if (transactionIndex === 0) {
      const scriptBytes = transaction.ins[0].script.length
      if (
        transaction.ins.length !== 1 ||
        scriptBytes < 2 ||
        scriptBytes > 100
      ) {
        throw new Error(
          `Bitcoin block ${height} coinbase script length is invalid`
        )
      }
    } else {
      const outpoints = new Set<string>()
      for (const input of transaction.ins) {
        if (input.index === 0xffffffff && input.hash.equals(Buffer.alloc(32))) {
          throw new Error(
            `Bitcoin block ${height} transaction ${transactionIndex} spends a null outpoint`
          )
        }
        const outpoint = `${input.hash.toString("hex")}:${input.index}`
        if (outpoints.has(outpoint)) {
          throw new Error(
            `Bitcoin block ${height} transaction ${transactionIndex} has duplicate inputs`
          )
        }
        outpoints.add(outpoint)
      }
    }

    let totalOutput = 0
    for (const output of transaction.outs) {
      if (
        !Number.isSafeInteger(output.value) ||
        output.value < 0 ||
        output.value > MAX_BITCOIN_MONEY_SATS
      ) {
        throw new Error(
          `Bitcoin block ${height} transaction ${transactionIndex} has an invalid output value`
        )
      }
      totalOutput += output.value
      if (
        !Number.isSafeInteger(totalOutput) ||
        totalOutput > MAX_BITCOIN_MONEY_SATS
      ) {
        throw new Error(
          `Bitcoin block ${height} transaction ${transactionIndex} exceeds maximum money`
        )
      }
    }
  })
}

const calculateBitcoinMerkleRoot = (
  displayHashes: string[]
): { root: Buffer; mutated: boolean } => {
  if (displayHashes.length === 0) {
    throw new Error("Bitcoin merkle tree requires at least one leaf")
  }
  let level: Buffer[] = displayHashes.map((hash) =>
    Buffer.from(normalizeHash(hash, "Bitcoin merkle leaf"), "hex").reverse()
  )
  let mutated = false
  while (level.length > 1) {
    for (let index = 0; index + 1 < level.length; index += 2) {
      if (level[index].equals(level[index + 1])) mutated = true
    }
    if (level.length % 2 === 1) {
      level.push(Buffer.from(level[level.length - 1]))
    }
    const parent: Buffer[] = []
    for (let index = 0; index < level.length; index += 2) {
      parent.push(doubleSha256(Buffer.concat([level[index], level[index + 1]])))
    }
    level = parent
  }
  return { root: level[0], mutated }
}

const assertUniqueTransactionHashes = (
  hashes: string[],
  message: string
): void => {
  if (new Set(hashes).size !== hashes.length) throw new Error(message)
}

const doubleSha256 = (value: Buffer): Buffer =>
  createHash("sha256")
    .update(createHash("sha256").update(value).digest())
    .digest()

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
    // bitcoinjs-lib deliberately returns the all-zero witness hash for a
    // coinbase transaction because BIP141 uses that sentinel when constructing
    // the witness merkle root. Materialize the actual serialized witness hash
    // directly so identity validation does not reject every canonical block.
    wtxid: serializedTransactionHash(transaction.toBuffer()),
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

const normalizeHex = (
  value: unknown,
  field: string,
  allowEmpty = false
): string => {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length % 2 !== 0 ||
    !(allowEmpty ? /^[0-9a-fA-F]*$/ : /^[0-9a-fA-F]+$/).test(value)
  ) {
    throw new Error(
      `${field} must be ${allowEmpty ? "" : "non-empty, "}even-length hex`
    )
  }
  return value.toLowerCase()
}

const serializedTransactionHash = (rawTransaction: Buffer): string => {
  const firstHash = createHash("sha256").update(rawTransaction).digest()
  return createHash("sha256")
    .update(firstHash)
    .digest()
    .reverse()
    .toString("hex")
}

const positiveInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  return value
}

const nonNegativeInteger = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
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

class NonRetryableBitcoinCoreRpcError extends Error {}
