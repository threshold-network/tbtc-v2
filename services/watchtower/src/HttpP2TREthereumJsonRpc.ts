import { createHash } from "node:crypto"
import {
  computeP2TREthereumRpcBlockHash,
  hashP2TREthereumSerializedEnvelope,
  serializeP2TREthereumRpcTransaction,
} from "./EthereumCanonicalHeaderProof.js"
import {
  bindP2TRHttpTransport,
  type P2TRAuthenticatedHttpsTransport,
  type P2TRBoundHttpTransport,
} from "./P2TRAuthenticatedHttpTransport.js"
import type {
  P2TRCanonicalEthereumBlock,
  P2TRCanonicalEthereumProvider,
  P2TRCanonicalEthereumRawLog,
  P2TRCanonicalEthereumReceipt,
} from "./P2TRCanonicalEthereumJournal.js"

export interface P2TREthereumJsonRpc {
  /** Derived from normalized transport configuration, never caller-supplied. */
  readonly endpointFingerprint?: string
  call<Result>(method: string, parameters?: readonly unknown[]): Promise<Result>
}

export type HttpP2TREthereumJsonRpcOptions = {
  url: string
  headers?: Readonly<Record<string, string>>
  fetchFn?: typeof fetch
  requestTimeoutMs?: number
  maxResponseBytes?: number
  /** Deployment-pinned CA bundle/SPKI policy identifier for HTTPS endpoints. */
  tlsServerIdentity?: string
  authenticatedHttpsTransport?: P2TRAuthenticatedHttpsTransport
}

type RpcEnvelope<Result> = {
  jsonrpc?: string
  id?: number
  result?: Result
  error?: { code?: number; message?: string }
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/** Bounded, response-ID-checked Ethereum JSON-RPC transport. */
export class HttpP2TREthereumJsonRpc implements P2TREthereumJsonRpc {
  readonly endpointFingerprint: string
  private readonly url: string
  private readonly headers: Readonly<Record<string, string>>
  private readonly transport: P2TRBoundHttpTransport
  private readonly requestTimeoutMs: number
  private readonly maxResponseBytes: number
  private requestID = 0

  constructor(options: HttpP2TREthereumJsonRpcOptions) {
    const url = new URL(options.url)
    assertSecureRpcURL(url, "Ethereum JSON-RPC")
    this.url = url.toString()
    this.headers = Object.freeze({
      ...options.headers,
      "content-type": "application/json",
    })
    this.transport = bindP2TRHttpTransport({
      url,
      label: "Ethereum JSON-RPC",
      tlsServerIdentity: options.tlsServerIdentity,
      authenticatedHttpsTransport: options.authenticatedHttpsTransport,
      loopbackFetchFn: options.fetchFn,
    })
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Ethereum request timeout"
    )
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "Ethereum response byte bound"
    )
    const headerCommitments = Object.entries(this.headers)
      .map(([name, value]) => ({
        name: name.toLowerCase(),
        valueHash: createHash("sha256").update(value, "utf8").digest("hex"),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    this.endpointFingerprint = `0x${createHash("sha256")
      .update(
        JSON.stringify({
          schema: "p2tr-ethereum-json-rpc-transport/v1",
          url: url.toString(),
          transportIdentity: this.transport.identity,
          headerCommitments,
        }),
        "utf8"
      )
      .digest("hex")}`
  }

  async call<Result>(
    method: string,
    parameters: readonly unknown[] = []
  ): Promise<Result> {
    if (!/^[a-z][A-Za-z0-9_]*$/.test(method)) {
      throw new Error("Ethereum JSON-RPC method is invalid")
    }
    const id = ++this.requestID
    const response = await this.transport.request(this.url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: parameters }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      redirect: "error",
    })
    if (
      response.redirected ||
      (response.url.length > 0 && new URL(response.url).toString() !== this.url)
    ) {
      throw new Error("Ethereum JSON-RPC response URL changed")
    }
    const contentLength = response.headers.get("content-length")
    if (
      contentLength !== null &&
      Number(contentLength) > this.maxResponseBytes
    ) {
      throw new Error("Ethereum JSON-RPC response exceeds its byte bound")
    }
    const bytes = await readBoundedBody(response, this.maxResponseBytes)
    if (!response.ok) {
      throw new Error(`Ethereum JSON-RPC HTTP status ${response.status}`)
    }
    let envelope: RpcEnvelope<Result>
    try {
      envelope = JSON.parse(bytes.toString("utf8")) as RpcEnvelope<Result>
    } catch {
      throw new Error("Ethereum JSON-RPC response is not JSON")
    }
    if (
      envelope.jsonrpc !== "2.0" ||
      envelope.id !== id ||
      envelope.error !== undefined ||
      !("result" in envelope)
    ) {
      throw new Error(
        `Ethereum JSON-RPC ${method} returned an error or mismatched response ID`
      )
    }
    return envelope.result as Result
  }
}

export type JsonRpcP2TRCanonicalEthereumProviderOptions = {
  trustDomainID: string
  providerIdentity?: object
}

/** Canonical Ethereum adapter preserving exact transaction and receipt order. */
export class JsonRpcP2TRCanonicalEthereumProvider
  implements P2TRCanonicalEthereumProvider
{
  readonly trustDomainID: string
  readonly providerIdentity: object
  readonly endpointFingerprint: string

  constructor(
    readonly rpc: P2TREthereumJsonRpc,
    options: JsonRpcP2TRCanonicalEthereumProviderOptions
  ) {
    this.trustDomainID = boundedString(
      options.trustDomainID,
      128,
      "Ethereum trust domain"
    )
    this.providerIdentity = options.providerIdentity ?? rpc
    this.endpointFingerprint = bytes32(
      rpc.endpointFingerprint ?? "",
      "derived Ethereum endpoint fingerprint"
    )
    if (
      typeof this.providerIdentity !== "object" ||
      this.providerIdentity === null
    ) {
      throw new Error("Ethereum provider identity must be an object")
    }
  }

  async getChainID(): Promise<number> {
    return quantity(
      await this.rpc.call<string>("eth_chainId"),
      "Ethereum chain ID"
    )
  }

  async getBlockNumber(): Promise<number> {
    return quantity(
      await this.rpc.call<string>("eth_blockNumber"),
      "Ethereum head block"
    )
  }

  async getBlock(
    blockNumber: number
  ): Promise<P2TRCanonicalEthereumBlock | null> {
    const requested = nonNegativeInteger(blockNumber, "Ethereum block number")
    const raw = await this.rpc.call<RawBlock | null>("eth_getBlockByNumber", [
      quantityHex(requested),
      true,
    ])
    if (raw === null) return null
    const actual = quantity(raw.number, "returned Ethereum block number")
    if (actual !== requested || !Array.isArray(raw.transactions)) {
      throw new Error("Ethereum provider returned another or malformed block")
    }
    const blockHash = bytes32(raw.hash, "Ethereum block hash")
    const canonicalHeader = canonicalBlockHeader(raw)
    if (computeP2TREthereumRpcBlockHash(canonicalHeader) !== blockHash) {
      throw new Error("Ethereum provider returned a block with an invalid header hash")
    }
    const serializedTransactions: string[] = []
    const transactionHashes = raw.transactions.map((value, index) => {
      const transaction = record(
        value,
        `Ethereum block transaction ${index}`
      ) as RawTransaction
      if (
        quantity(transaction.blockNumber, "Ethereum transaction block number") !==
          actual ||
        bytes32(transaction.blockHash, "Ethereum transaction block hash") !==
          blockHash ||
        quantity(
          transaction.transactionIndex,
          "Ethereum transaction index"
        ) !== index
      ) {
        throw new Error(`Ethereum transaction ${index} is outside its block position`)
      }
      const hash = bytes32(transaction.hash, `Ethereum transaction ${index} hash`)
      const serialized = serializeP2TREthereumRpcTransaction(transaction)
      if (hashP2TREthereumSerializedEnvelope(serialized) !== hash) {
        throw new Error(`Ethereum transaction ${index} hash is inconsistent`)
      }
      serializedTransactions.push(serialized)
      return hash
    })
    if (new Set(transactionHashes).size !== transactionHashes.length) {
      throw new Error("Ethereum block contains duplicate transaction hashes")
    }
    return {
      blockNumber: actual,
      blockHash,
      parentHash: bytes32(raw.parentHash, "Ethereum parent hash"),
      timestamp: quantity(raw.timestamp, "Ethereum block timestamp"),
      transactionsRoot: bytes32(
        raw.transactionsRoot,
        "Ethereum transactions root"
      ),
      receiptsRoot: bytes32(raw.receiptsRoot, "Ethereum receipts root"),
      canonicalHeader,
      transactionHashes,
      serializedTransactions,
    }
  }

  async getLogs(filter: {
    address: string
    topics: readonly string[]
    fromBlock: number
    toBlock: number
  }): Promise<readonly P2TRCanonicalEthereumRawLog[]> {
    const result = await this.rpc.call<RawLog[]>("eth_getLogs", [
      {
        address: address(filter.address, "Ethereum log filter address"),
        topics: filter.topics.map((topic, index) =>
          bytes32(topic, `Ethereum log filter topic ${index}`)
        ),
        fromBlock: quantityHex(
          nonNegativeInteger(filter.fromBlock, "Ethereum log start")
        ),
        toBlock: quantityHex(
          nonNegativeInteger(filter.toBlock, "Ethereum log end")
        ),
      },
    ])
    if (!Array.isArray(result)) {
      throw new Error("Ethereum log response is not an array")
    }
    return result.map(normalizeRawLog)
  }

  async getTransactionReceipt(
    transactionHash: string
  ): Promise<P2TRCanonicalEthereumReceipt | null> {
    const requested = bytes32(transactionHash, "Ethereum receipt transaction")
    const raw = await this.rpc.call<RawReceipt | null>(
      "eth_getTransactionReceipt",
      [requested]
    )
    if (raw === null) return null
    const normalized = {
      type: quantity(raw.type ?? "0x0", "Ethereum receipt type"),
      status: quantity(raw.status, "Ethereum receipt status"),
      cumulativeGasUsed: quantityString(
        raw.cumulativeGasUsed,
        "Ethereum receipt cumulative gas used"
      ),
      logsBloom: fixedHex(
        raw.logsBloom,
        256,
        "Ethereum receipt logs bloom"
      ),
      blockHash: bytes32(raw.blockHash, "Ethereum receipt block hash"),
      blockNumber: quantity(raw.blockNumber, "Ethereum receipt block number"),
      transactionHash: bytes32(
        raw.transactionHash,
        "Ethereum receipt transaction hash"
      ),
      transactionIndex: quantity(
        raw.transactionIndex,
        "Ethereum receipt transaction index"
      ),
      logs: Array.isArray(raw.logs)
        ? raw.logs.map(normalizeRawLog)
        : fail("Ethereum receipt logs are malformed"),
    }
    if (normalized.transactionHash !== requested) {
      throw new Error("Ethereum provider returned another transaction receipt")
    }
    if (normalized.status !== 0 && normalized.status !== 1) {
      throw new Error("Ethereum receipt status is not canonical")
    }
    if (normalized.type > 4) {
      throw new Error("Ethereum receipt type is unsupported")
    }
    return normalized
  }

  async getCode(
    addressValue: string,
    block: number | { blockHash: string }
  ): Promise<string> {
    return hex(
      await this.rpc.call<string>("eth_getCode", [
        address(addressValue, "Ethereum code address"),
        blockSelector(block),
      ]),
      "Ethereum runtime code"
    )
  }

  async getStorageAt(
    addressValue: string,
    slot: string,
    block: number | { blockHash: string }
  ): Promise<string> {
    return bytes32(
      await this.rpc.call<string>("eth_getStorageAt", [
        address(addressValue, "Ethereum storage address"),
        bytes32(slot, "Ethereum storage slot"),
        blockSelector(block),
      ]),
      "Ethereum storage value"
    )
  }

  async callAt(
    to: string,
    data: string,
    block: number | { blockHash: string }
  ): Promise<string> {
    return hex(
      await this.rpc.call<string>("eth_call", [
        {
          to: address(to, "Ethereum call target"),
          data: hex(data, "Ethereum call data"),
        },
        blockSelector(block),
      ]),
      "Ethereum call result"
    )
  }

}

type RawBlock = {
  number: string
  hash: string
  parentHash: string
  timestamp: string
  transactionsRoot: string
  receiptsRoot: string
  transactions: unknown[]
} & Record<string, unknown>

type RawTransaction = {
  blockNumber: string
  blockHash: string
  transactionIndex: string
  hash: string
} & Record<string, unknown>

type RawLog = {
  address: string
  blockHash: string
  blockNumber: string
  transactionHash: string
  transactionIndex: string
  logIndex: string
  data: string
  topics: unknown[]
  removed?: boolean
}

type RawReceipt = {
  type?: string
  status: string
  cumulativeGasUsed: string
  logsBloom: string
  blockHash: string
  blockNumber: string
  transactionHash: string
  transactionIndex: string
  logs: RawLog[]
}

function canonicalBlockHeader(block: RawBlock): Readonly<Record<string, unknown>> {
  const required = [
    "parentHash",
    "sha3Uncles",
    "miner",
    "stateRoot",
    "transactionsRoot",
    "receiptsRoot",
    "logsBloom",
    "difficulty",
    "number",
    "gasLimit",
    "gasUsed",
    "timestamp",
    "extraData",
    "nonce",
  ] as const
  const header: Record<string, unknown> = {}
  for (const field of required) {
    if (block[field] === undefined || block[field] === null) {
      throw new Error(`Ethereum block header field ${field} is absent`)
    }
    header[field] = block[field]
  }
  if (block.mixHash === undefined && block.prevRandao === undefined) {
    throw new Error("Ethereum block header mixHash/prevRandao is absent")
  }
  header.mixHash = block.mixHash ?? block.prevRandao
  for (const field of [
    "baseFeePerGas",
    "withdrawalsRoot",
    "blobGasUsed",
    "excessBlobGas",
    "parentBeaconBlockRoot",
    "requestsHash",
    "blockAccessListHash",
  ] as const) {
    if (block[field] !== undefined && block[field] !== null) {
      header[field] = block[field]
    }
  }
  return Object.freeze(header)
}

function normalizeRawLog(raw: RawLog): P2TRCanonicalEthereumRawLog {
  if (!Array.isArray(raw.topics) || raw.removed === true) {
    throw new Error("Ethereum log is malformed or removed")
  }
  return {
    address: address(raw.address, "Ethereum log emitter"),
    blockHash: bytes32(raw.blockHash, "Ethereum log block hash"),
    blockNumber: quantity(raw.blockNumber, "Ethereum log block number"),
    transactionHash: bytes32(
      raw.transactionHash,
      "Ethereum log transaction hash"
    ),
    transactionIndex: quantity(
      raw.transactionIndex,
      "Ethereum log transaction index"
    ),
    logIndex: quantity(raw.logIndex, "Ethereum log index"),
    data: hex(raw.data, "Ethereum log data"),
    topics: raw.topics.map((topic, index) =>
      bytes32(String(topic), `Ethereum log topic ${index}`)
    ),
    removed: false,
  }
}

async function readBoundedBody(
  response: Response,
  maximum: number
): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.byteLength
    if (total > maximum) {
      await response.body.cancel()
      throw new Error("Ethereum JSON-RPC response exceeds its byte bound")
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function quantity(value: string, label: string): number {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error(`${label} is not a canonical quantity`)
  }
  const parsed = Number(BigInt(value))
  return nonNegativeInteger(parsed, label)
}

function quantityString(value: string, label: string): string {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error(`${label} is not a canonical quantity`)
  }
  return value.toLowerCase()
}

function quantityHex(value: number): string {
  return `0x${value.toString(16)}`
}

function blockSelector(
  block: number | { blockHash: string }
): string | { blockHash: string; requireCanonical: true } {
  return typeof block === "number"
    ? quantityHex(nonNegativeInteger(block, "Ethereum block selector"))
    : {
        blockHash: bytes32(block.blockHash, "Ethereum block selector hash"),
        requireCanonical: true,
      }
}

function bytes32(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be 32 bytes`)
  }
  return `0x${normalized}`
}

function address(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be 20 bytes`)
  }
  return `0x${normalized}`
}

function hex(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^(?:[0-9a-f]{2})*$/.test(normalized)) {
    throw new Error(`${label} must be even-length hexadecimal`)
  }
  return `0x${normalized}`
}

function fixedHex(value: string, bytes: number, label: string): string {
  const normalized = hex(value, label)
  if (normalized.length !== 2 + bytes * 2) {
    throw new Error(`${label} must be ${bytes} bytes`)
  }
  return normalized
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`)
  }
  return value as Record<string, unknown>
}

function boundedString(value: string, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function fail(message: string): never {
  throw new Error(message)
}

function assertSecureRpcURL(
  url: URL,
  label: string
): void {
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${label} URL must not embed credentials`)
  }
  if (url.protocol === "https:") {
    return
  }
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
    throw new Error(`${label} requires HTTPS or a numeric loopback HTTP endpoint`)
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "::1") return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(
    normalized
  )
  return (
    match !== null &&
    match.slice(1).every((part) => Number(part) <= 255) &&
    Number(match[1]) === 127
  )
}
