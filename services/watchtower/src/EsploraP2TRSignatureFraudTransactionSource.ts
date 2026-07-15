import {
  BitcoinNetwork,
  BitcoinTxHash,
  DepositScript,
  DepositScriptType,
} from "@keep-network/tbtc-v2.ts"
import type {
  BitcoinRawTx,
  Bridge,
  P2TRSignatureFraudWatchtowerTransactionSource,
  P2TRWalletInputKeyBinding,
  P2TRWatchtowerConfirmedTransaction,
  P2TRWatchtowerMempoolTransaction,
} from "@keep-network/tbtc-v2.ts"

export type P2TREsploraFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>

export type P2TRTaprootDepositRevealSource = Pick<
  Bridge,
  | "deposits"
  | "getTaprootDepositRevealedEvents"
  | "taprootDepositOutputKeyCommitment"
>

export type P2TRDepositScanFailure = {
  stage: "reveal-history" | "deposit-request" | "outspend" | "raw-transaction"
  spendingTxid?: string
  fundingTxid?: string
  fundingOutputIndex?: number
  error: string
}

export type P2TRDepositScanFailureHandler = (
  failure: P2TRDepositScanFailure
) => void | Promise<void>

export type EsploraP2TRSignatureFraudTransactionSourceOptions = {
  taprootDepositRevealSource: P2TRTaprootDepositRevealSource
  onDepositScanFailure: P2TRDepositScanFailureHandler
  fetchFn?: P2TREsploraFetch
  maxAttempts?: number
  requestTimeoutMs?: number
  retryDelayMs?: number
  confirmedPageLimit?: number
  depositScanConcurrency?: number
}

type EsploraTransactionSummary = {
  txid: string
  status?: EsploraTransactionStatus
}

type EsploraTransactionCandidate = EsploraTransactionSummary & {
  walletInputKeyBindings: P2TRWalletInputKeyBinding[]
}

type EsploraTransactionStatus = {
  confirmed: boolean
  block_hash?: string
  block_height?: number
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_REQUEST_TIMEOUT_MS = 5000
const DEFAULT_RETRY_DELAY_MS = 250
const DEFAULT_CONFIRMED_PAGE_LIMIT = 1
const DEFAULT_DEPOSIT_SCAN_CONCURRENCY = 8
const MAX_UINT32 = 0xffffffff
const ZERO_BYTES32 = "00".repeat(32)
const BECH32M_CONST = 0x2bc830a3
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATORS = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
]
const TAPROOT_WITNESS_VERSION = 1

export class EsploraP2TRSignatureFraudTransactionSource
  implements P2TRSignatureFraudWatchtowerTransactionSource
{
  private readonly baseUrl: string
  private readonly fetchFn: P2TREsploraFetch
  private readonly maxAttempts: number
  private readonly requestTimeoutMs: number
  private readonly retryDelayMs: number
  private readonly confirmedPageLimit: number
  private readonly scanTaskQueue: BoundedTaskQueue
  private readonly walletAddresses: string[]
  private readonly registeredWalletIDs: Set<string>
  private readonly taprootDepositRevealSource: P2TRTaprootDepositRevealSource
  private readonly onDepositScanFailure: P2TRDepositScanFailureHandler
  private depositSpendScan?: Promise<EsploraTransactionCandidate[]>

  constructor(
    baseUrl: string,
    bitcoinNetwork: BitcoinNetwork,
    registeredWalletIDs: string[],
    options: EsploraP2TRSignatureFraudTransactionSourceOptions
  ) {
    if (registeredWalletIDs.length === 0) {
      throw new Error("Esplora P2TR transaction source requires wallet IDs")
    }

    this.baseUrl = normalizeBaseUrl(baseUrl)
    if (
      options?.taprootDepositRevealSource === undefined ||
      typeof options.taprootDepositRevealSource.deposits !== "function" ||
      typeof options.taprootDepositRevealSource
        .getTaprootDepositRevealedEvents !== "function" ||
      typeof options.taprootDepositRevealSource
        .taprootDepositOutputKeyCommitment !== "function"
    ) {
      throw new Error(
        "Esplora P2TR transaction source requires a Taproot deposit reveal source"
      )
    }

    this.taprootDepositRevealSource = options.taprootDepositRevealSource
    if (typeof options.onDepositScanFailure !== "function") {
      throw new Error(
        "Esplora P2TR transaction source requires a deposit scan failure handler"
      )
    }
    this.onDepositScanFailure = options.onDepositScanFailure
    this.fetchFn = options.fetchFn ?? fetch
    this.maxAttempts = parsePositiveIntegerOption(
      options.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
      "maxAttempts"
    )
    this.requestTimeoutMs = parsePositiveIntegerOption(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs"
    )
    this.retryDelayMs = parseNonNegativeIntegerOption(
      options.retryDelayMs,
      DEFAULT_RETRY_DELAY_MS,
      "retryDelayMs"
    )
    this.confirmedPageLimit = parsePositiveIntegerOption(
      options.confirmedPageLimit,
      DEFAULT_CONFIRMED_PAGE_LIMIT,
      "confirmedPageLimit"
    )
    this.scanTaskQueue = new BoundedTaskQueue(
      parsePositiveIntegerOption(
        options.depositScanConcurrency,
        DEFAULT_DEPOSIT_SCAN_CONCURRENCY,
        "depositScanConcurrency"
      )
    )
    this.registeredWalletIDs = new Set(
      registeredWalletIDs.map((walletID) =>
        normalizeBytes32Hex(walletID, "wallet ID")
      )
    )
    this.walletAddresses = [...this.registeredWalletIDs].map((walletID) =>
      deriveP2TRWalletAddress(walletID, bitcoinNetwork)
    )
  }

  async listMempoolTransactions(): Promise<P2TRWatchtowerMempoolTransaction[]> {
    const [walletTransactions, depositSpendTransactions] = await Promise.all([
      this.listWalletTransactions((address) =>
        this.listAddressMempoolTransactions(address)
      ),
      this.listDepositSpendTransactions(),
    ])
    const transactions = mergeTransactionCandidates(
      walletTransactions.map(withoutWalletInputKeyBindings),
      depositSpendTransactions.filter(
        ({ status }) => status?.confirmed === false
      )
    )

    return this.materializeRawTransactions(
      transactions,
      ({ txid, walletInputKeyBindings }, rawTransaction) => ({
        bitcoinTxHash: BitcoinTxHash.from(txid),
        rawTransaction,
        walletInputKeyBindings,
      })
    )
  }

  async listConfirmedTransactions(): Promise<
    P2TRWatchtowerConfirmedTransaction[]
  > {
    const [walletTransactions, depositSpendTransactions] = await Promise.all([
      this.listWalletTransactions((address) =>
        this.listAddressConfirmedTransactions(address)
      ),
      this.listDepositSpendTransactions(),
    ])
    const transactions = mergeTransactionCandidates(
      walletTransactions.map(withoutWalletInputKeyBindings),
      depositSpendTransactions.filter(
        ({ status }) => status?.confirmed === true
      )
    )

    // Fail fast on missing block metadata; only raw-transaction fetch failures are isolated.
    const confirmedTransactions = transactions.map(
      ({ txid, status, walletInputKeyBindings }) => ({
        txid,
        status,
        walletInputKeyBindings,
        confirmedStatus: requireConfirmedStatus(txid, status),
      })
    )

    return this.materializeRawTransactions(
      confirmedTransactions,
      ({ txid, walletInputKeyBindings, confirmedStatus }, rawTransaction) => {
        return {
          bitcoinTxHash: BitcoinTxHash.from(txid),
          bitcoinBlockHash: confirmedStatus.block_hash,
          bitcoinBlockHeight: confirmedStatus.block_height,
          rawTransaction,
          walletInputKeyBindings,
        }
      }
    )
  }

  private async materializeRawTransactions<
    T extends EsploraTransactionCandidate,
    R
  >(
    transactions: T[],
    materialize: (transaction: T, rawTransaction: BitcoinRawTx) => R
  ): Promise<R[]> {
    const results = await this.scanTaskQueue.mapSettled(
      transactions,
      async (transaction) =>
        materialize(transaction, await this.getRawTransaction(transaction.txid))
    )
    const materialized: R[] = []

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        materialized.push(result.value)
        return
      }

      this.reportRawTransactionFailure(
        transactions[index],
        describeRequestError(result.reason)
      )
    })

    return materialized
  }

  private reportRawTransactionFailure(
    transaction: EsploraTransactionCandidate,
    error: string
  ): void {
    const failure = {
      stage: "raw-transaction" as const,
      spendingTxid: transaction.txid,
      error,
    }

    if (transaction.walletInputKeyBindings.length === 0) {
      this.reportDepositScanFailure(failure)
      return
    }

    transaction.walletInputKeyBindings.forEach((binding) =>
      this.reportDepositScanFailure({
        ...failure,
        fundingTxid: String(binding.txid),
        fundingOutputIndex: binding.vout,
      })
    )
  }

  private listDepositSpendTransactions(): Promise<
    EsploraTransactionCandidate[]
  > {
    if (this.depositSpendScan !== undefined) {
      return this.depositSpendScan
    }

    const scan = this.scanDepositSpendTransactions()
    this.depositSpendScan = scan
    void scan.then(
      () => {
        if (this.depositSpendScan === scan) this.depositSpendScan = undefined
      },
      () => {
        if (this.depositSpendScan === scan) this.depositSpendScan = undefined
      }
    )

    return scan
  }

  private async scanDepositSpendTransactions(): Promise<
    EsploraTransactionCandidate[]
  > {
    let depositEvents: Awaited<
      ReturnType<
        P2TRTaprootDepositRevealSource["getTaprootDepositRevealedEvents"]
      >
    >
    try {
      depositEvents =
        await this.taprootDepositRevealSource.getTaprootDepositRevealedEvents()
    } catch (error) {
      this.reportDepositScanFailure({
        stage: "reveal-history",
        error: describeRequestError(error),
      })
      return []
    }

    const bindingResults = await this.scanTaskQueue.mapSettled(
      depositEvents,
      async (event): Promise<P2TRWalletInputKeyBinding | undefined> => {
        const walletID = normalizeBytes32Hex(
          event.walletXOnlyPublicKey.toString(),
          "revealed deposit wallet ID"
        )
        if (!this.registeredWalletIDs.has(walletID)) {
          return undefined
        }

        const vout = readSafeInteger(
          event.fundingOutputIndex,
          "revealed deposit funding output index",
          { minimum: 0, maximum: MAX_UINT32 }
        )
        const depositKeyCommitment = normalizeBytes32Hex(
          (
            await this.taprootDepositRevealSource.taprootDepositOutputKeyCommitment(
              event.fundingTxHash,
              vout
            )
          ).toString(),
          "Taproot deposit output-key commitment"
        )
        if (depositKeyCommitment === ZERO_BYTES32) {
          return undefined
        }

        const depositRequest = await this.taprootDepositRevealSource.deposits(
          event.fundingTxHash,
          vout
        )
        if (
          depositRequest.depositor.identifierHex.toLowerCase() !==
          event.depositor.identifierHex.toLowerCase()
        ) {
          throw new Error(
            `Taproot deposit ${event.fundingTxHash.toString()}:${vout} depositor does not match stored request`
          )
        }

        const outputKey = (
          await DepositScript.fromReceipt(
            { ...event, extraData: depositRequest.extraData },
            DepositScriptType.P2TR
          ).getTaprootOutputKey()
        ).toString()

        return {
          txid: normalizeTxid(event.fundingTxHash.toString()),
          vout,
          outputKey,
          walletID,
        }
      }
    )

    const bindings: P2TRWalletInputKeyBinding[] = []
    bindingResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        if (result.value !== undefined) bindings.push(result.value)
        return
      }

      const event = depositEvents[index]
      this.reportDepositScanFailure({
        stage: "deposit-request",
        fundingTxid: event.fundingTxHash.toString(),
        fundingOutputIndex: Number(event.fundingOutputIndex),
        error: describeRequestError(result.reason),
      })
    })

    const uniqueBindings = new Map<string, P2TRWalletInputKeyBinding>()
    for (const binding of bindings) {
      uniqueBindings.set(depositBindingKey(binding), binding)
    }

    const uniqueBindingValues = [...uniqueBindings.values()]
    const candidateResults = await this.scanTaskQueue.mapSettled(
      uniqueBindingValues,
      async (binding) => {
        const summary = await this.readDepositOutspend(binding)
        return summary === undefined ? undefined : { summary, binding }
      }
    )
    const byTxid = new Map<string, EsploraTransactionCandidate>()

    candidateResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const binding = uniqueBindingValues[index]
        this.reportDepositScanFailure({
          stage: "outspend",
          fundingTxid: String(binding.txid),
          fundingOutputIndex: binding.vout,
          error: describeRequestError(result.reason),
        })
        return
      }

      const candidate = result.value
      if (candidate === undefined) return

      const existing = byTxid.get(candidate.summary.txid)
      if (existing === undefined) {
        byTxid.set(candidate.summary.txid, {
          ...candidate.summary,
          walletInputKeyBindings: [candidate.binding],
        })
      } else {
        existing.walletInputKeyBindings.push(candidate.binding)
      }
    })

    return [...byTxid.values()]
  }

  private reportDepositScanFailure(failure: P2TRDepositScanFailure): void {
    try {
      void Promise.resolve(this.onDepositScanFailure(failure)).catch(
        () => undefined
      )
    } catch {
      // Failure reporting must never suppress the remaining transaction scan.
    }
  }

  private async readDepositOutspend(
    binding: P2TRWalletInputKeyBinding
  ): Promise<EsploraTransactionSummary | undefined> {
    const txid = normalizeTxid(String(binding.txid))
    const response = await this.request(
      "GET",
      `/tx/${txid}/outspend/${binding.vout}`,
      `fetch Taproot deposit outspend ${txid}:${binding.vout}`
    )
    if (!response.ok) {
      throw new Error(
        `Failed to fetch Taproot deposit outspend ${txid}:${
          binding.vout
        }: ${await readTextError(response)}`
      )
    }

    return parseDepositOutspend(
      await this.readJson(response, "deposit outspend"),
      `Taproot deposit outspend ${txid}:${binding.vout}`
    )
  }

  private async listWalletTransactions(
    listAddressTransactions: (
      address: string
    ) => Promise<EsploraTransactionSummary[]>
  ): Promise<EsploraTransactionSummary[]> {
    const byTxid = new Map<string, EsploraTransactionSummary>()

    for (const address of this.walletAddresses) {
      const transactions = await listAddressTransactions(address)
      for (const transaction of transactions) {
        byTxid.set(transaction.txid, transaction)
      }
    }

    return [...byTxid.values()]
  }

  private async listAddressMempoolTransactions(
    address: string
  ): Promise<EsploraTransactionSummary[]> {
    return this.readTransactionSummaries(
      `/address/${encodeURIComponent(address)}/txs/mempool`,
      `fetch mempool P2TR wallet transactions for ${address}`
    )
  }

  private async listAddressConfirmedTransactions(
    address: string
  ): Promise<EsploraTransactionSummary[]> {
    const transactions: EsploraTransactionSummary[] = []
    let path = `/address/${encodeURIComponent(address)}/txs/chain`

    for (let page = 0; ; page++) {
      const pageTransactions = await this.readTransactionSummaries(
        path,
        `fetch confirmed P2TR wallet transactions for ${address}`
      )

      if (pageTransactions.length === 0) {
        break
      }

      if (page >= this.confirmedPageLimit) {
        throw new Error(
          `Confirmed P2TR wallet transaction history for ${address} is incomplete after ${
            this.confirmedPageLimit
          } ${this.confirmedPageLimit === 1 ? "page" : "pages"}`
        )
      }

      transactions.push(...pageTransactions)
      path = `/address/${encodeURIComponent(address)}/txs/chain/${
        pageTransactions[pageTransactions.length - 1].txid
      }`
    }

    return transactions
  }

  private async readTransactionSummaries(
    path: string,
    context: string
  ): Promise<EsploraTransactionSummary[]> {
    const response = await this.request("GET", path, context)
    if (!response.ok) {
      throw new Error(`Failed to ${context}: ${await readTextError(response)}`)
    }

    return readArray(
      await this.readJson(response, "transaction summaries"),
      context
    ).map((item, index) =>
      parseTransactionSummary(item, `${context} response[${index}]`)
    )
  }

  private async getRawTransaction(txid: string): Promise<BitcoinRawTx> {
    const response = await this.request(
      "GET",
      `/tx/${txid}/hex`,
      `fetch raw Bitcoin transaction ${txid}`
    )
    if (!response.ok) {
      throw new Error(
        `Failed to fetch raw Bitcoin transaction ${txid}: ${await readTextError(
          response
        )}`
      )
    }

    return { transactionHex: normalizeHex((await response.text()).trim()) }
  }

  private async request(
    method: "GET",
    path: string,
    context: string
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, { method })
        if (attempt < this.maxAttempts && isRetryableStatus(response.status)) {
          await sleep(this.retryDelayMs)
          continue
        }

        return response
      } catch (error) {
        if (attempt >= this.maxAttempts) {
          throw new Error(
            `Failed to ${context}: ${describeRequestError(error)}`
          )
        }

        await sleep(this.retryDelayMs)
      }
    }

    throw new Error(`Failed to ${context}: request attempts exhausted`)
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)

    try {
      return await this.fetchFn(url, {
        ...init,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  private async readJson(response: Response, field: string): Promise<unknown> {
    try {
      return await response.json()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Esplora ${field} response was not valid JSON: ${message}`
      )
    }
  }
}

class BoundedTaskQueue {
  private activeTasks = 0
  private readonly waitingTasks: Array<() => void> = []

  constructor(private readonly concurrency: number) {}

  async mapSettled<T, R>(
    values: readonly T[],
    mapper: (value: T, index: number) => Promise<R> | R
  ): Promise<PromiseSettledResult<R>[]> {
    return Promise.allSettled(
      values.map((value, index) =>
        this.run(() => Promise.resolve(mapper(value, index)))
      )
    )
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.activeTasks < this.concurrency) {
      this.activeTasks++
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      this.waitingTasks.push(() => {
        this.activeTasks++
        resolve()
      })
    })
  }

  private release(): void {
    this.activeTasks--
    this.waitingTasks.shift()?.()
  }
}

function withoutWalletInputKeyBindings(
  transaction: EsploraTransactionSummary
): EsploraTransactionCandidate {
  return { ...transaction, walletInputKeyBindings: [] }
}

function mergeTransactionCandidates(
  ...candidateGroups: EsploraTransactionCandidate[][]
): EsploraTransactionCandidate[] {
  const byTxid = new Map<string, EsploraTransactionCandidate>()

  for (const candidate of candidateGroups.flat()) {
    const existing = byTxid.get(candidate.txid)
    if (existing === undefined) {
      byTxid.set(candidate.txid, {
        ...candidate,
        walletInputKeyBindings: [...candidate.walletInputKeyBindings],
      })
      continue
    }

    if (
      existing.status !== undefined &&
      candidate.status !== undefined &&
      existing.status.confirmed !== candidate.status.confirmed
    ) {
      throw new Error(
        `Esplora transaction ${candidate.txid} has conflicting confirmation status`
      )
    }

    existing.status ??= candidate.status
    const existingBindings = new Set(
      existing.walletInputKeyBindings.map(depositBindingKey)
    )
    for (const binding of candidate.walletInputKeyBindings) {
      const key = depositBindingKey(binding)
      if (!existingBindings.has(key)) {
        existing.walletInputKeyBindings.push(binding)
        existingBindings.add(key)
      }
    }
  }

  return [...byTxid.values()]
}

function depositBindingKey(binding: P2TRWalletInputKeyBinding): string {
  const txid = normalizeTxid(String(binding.txid))
  const vout = readSafeInteger(binding.vout, "deposit binding vout", {
    minimum: 0,
    maximum: MAX_UINT32,
  })
  const outputKey = normalizeBytes32Hex(
    String(binding.outputKey),
    "deposit output key"
  )
  const walletID = normalizeBytes32Hex(
    String(binding.walletID),
    "deposit wallet ID"
  )

  return `${txid}:${vout}:${outputKey}:${walletID}`
}

export function deriveP2TRWalletAddress(
  walletID: string,
  bitcoinNetwork: BitcoinNetwork
): string {
  const walletIDBuffer = Buffer.from(
    normalizeBytes32Hex(walletID, "wallet ID"),
    "hex"
  )

  return encodeSegwitV1Address(bitcoinNetwork, walletIDBuffer)
}

function parseDepositOutspend(
  value: unknown,
  field: string
): EsploraTransactionSummary | undefined {
  const record = readObject(value, field)
  const spent = readRequiredBoolean(record.spent, `${field}.spent`)

  if (!spent) {
    return undefined
  }

  if (record.status === undefined) {
    throw new Error(`Esplora ${field}.status was missing for a spent output`)
  }

  return {
    txid: normalizeTxid(readRequiredString(record.txid, `${field}.txid`)),
    status: parseTransactionStatus(record.status, `${field}.status`),
  }
}

function parseTransactionSummary(
  value: unknown,
  field: string
): EsploraTransactionSummary {
  const record = readObject(value, field)
  const status =
    record.status === undefined
      ? undefined
      : parseTransactionStatus(record.status, `${field}.status`)

  return {
    txid: normalizeTxid(readRequiredString(record.txid, `${field}.txid`)),
    status,
  }
}

function parseTransactionStatus(
  value: unknown,
  field: string
): EsploraTransactionStatus {
  const record = readObject(value, field)
  const confirmed = readRequiredBoolean(record.confirmed, `${field}.confirmed`)
  const blockHash =
    record.block_hash === undefined
      ? undefined
      : normalizeTxid(
          readRequiredString(record.block_hash, `${field}.block_hash`)
        )
  const blockHeight =
    record.block_height === undefined
      ? undefined
      : readSafeInteger(record.block_height, `${field}.block_height`, {
          minimum: 1,
          maximum: MAX_UINT32,
        })

  return {
    confirmed,
    block_hash: blockHash,
    block_height: blockHeight,
  }
}

function requireConfirmedStatus(
  txid: string,
  status: EsploraTransactionStatus | undefined
): Required<EsploraTransactionStatus> {
  if (
    status?.confirmed !== true ||
    status.block_hash === undefined ||
    status.block_height === undefined
  ) {
    throw new Error(
      `Confirmed P2TR wallet transaction ${txid} is missing Esplora block metadata`
    )
  }

  return {
    confirmed: true,
    block_hash: status.block_hash,
    block_height: status.block_height,
  }
}

function normalizeBaseUrl(value: string): string {
  const normalizedValue = value.trim().replace(/\/+$/, "")

  if (normalizedValue.length === 0) {
    throw new Error("Esplora base URL is required")
  }

  let url: URL
  try {
    url = new URL(normalizedValue)
  } catch {
    throw new Error("Esplora base URL must be an absolute http(s) URL")
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Esplora base URL must be an absolute http(s) URL")
  }

  return normalizedValue
}

function normalizeBytes32Hex(value: string, label: string): string {
  const strippedValue = stripHexPrefix(value.trim())

  if (!/^[0-9a-fA-F]{64}$/.test(strippedValue)) {
    throw new Error(`P2TR signature-fraud watchtower ${label} must be 32 bytes`)
  }

  return strippedValue.toLowerCase()
}

function normalizeTxid(value: string): string {
  const normalizedValue = stripHexPrefix(value.trim()).toLowerCase()

  if (!/^[0-9a-f]{64}$/.test(normalizedValue)) {
    throw new Error(`Esplora transaction hash was not 32 bytes: ${value}`)
  }

  return normalizedValue
}

function normalizeHex(value: string): string {
  const normalizedValue = stripHexPrefix(value).toLowerCase()

  if (
    !/^[0-9a-f]*$/.test(normalizedValue) ||
    normalizedValue.length % 2 !== 0
  ) {
    throw new Error("Esplora raw transaction response was not valid hex")
  }

  return normalizedValue
}

function encodeSegwitV1Address(
  bitcoinNetwork: BitcoinNetwork,
  witnessProgram: Buffer
): string {
  const humanReadablePart = bitcoinNetworkBech32Prefix(bitcoinNetwork)
  const data = [
    TAPROOT_WITNESS_VERSION,
    ...convertBits([...witnessProgram], 8, 5, true),
  ]

  return encodeBech32m(humanReadablePart, data)
}

function bitcoinNetworkBech32Prefix(bitcoinNetwork: BitcoinNetwork): string {
  switch (bitcoinNetwork) {
    case BitcoinNetwork.Mainnet:
      return "bc"
    case BitcoinNetwork.Testnet:
    case BitcoinNetwork.Testnet4:
      // testnet3 and testnet4 P2TR addresses share the same `tb` bech32 HRP.
      return "tb"
    default:
      throw new Error(
        "P2TR Esplora source supports only mainnet, testnet, and testnet4"
      )
  }
}

function encodeBech32m(humanReadablePart: string, data: number[]): string {
  const checksum = createBech32mChecksum(humanReadablePart, data)
  const combined = [...data, ...checksum]

  return `${humanReadablePart}1${combined
    .map((value) => BECH32_CHARSET[value])
    .join("")}`
}

function createBech32mChecksum(
  humanReadablePart: string,
  data: number[]
): number[] {
  const values = [...expandBech32HumanReadablePart(humanReadablePart), ...data]
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST
  const checksum: number[] = []

  for (let index = 0; index < 6; index++) {
    checksum.push((polymod >> (5 * (5 - index))) & 31)
  }

  return checksum
}

function expandBech32HumanReadablePart(humanReadablePart: string): number[] {
  return [
    ...[...humanReadablePart].map((character) => character.charCodeAt(0) >> 5),
    0,
    ...[...humanReadablePart].map((character) => character.charCodeAt(0) & 31),
  ]
}

function bech32Polymod(values: number[]): number {
  let checksum = 1

  for (const value of values) {
    const top = checksum >> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value

    for (let index = 0; index < BECH32_GENERATORS.length; index++) {
      if (((top >> index) & 1) === 1) {
        checksum ^= BECH32_GENERATORS[index]
      }
    }
  }

  return checksum
}

function convertBits(
  data: number[],
  fromBits: number,
  toBits: number,
  pad: boolean
): number[] {
  let accumulator = 0
  let bits = 0
  const result: number[] = []
  const maxValue = (1 << toBits) - 1
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1

  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      throw new Error("Invalid Bech32 conversion input value")
    }

    accumulator = ((accumulator << fromBits) | value) & maxAccumulator
    bits += fromBits

    while (bits >= toBits) {
      bits -= toBits
      result.push((accumulator >> bits) & maxValue)
    }
  }

  if (pad && bits > 0) {
    result.push((accumulator << (toBits - bits)) & maxValue)
  } else if (
    !pad &&
    (bits >= fromBits || ((accumulator << (toBits - bits)) & maxValue) !== 0)
  ) {
    throw new Error("Invalid Bech32 conversion padding")
  }

  return result
}

function stripHexPrefix(value: string): string {
  return value.replace(/^0x/i, "")
}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Esplora ${field} was not an object`)
  }

  return value as Record<string, unknown>
}

function readArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Esplora ${field} was not an array`)
  }

  return value
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Esplora ${field} was not a non-empty string`)
  }

  return value
}

function readRequiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Esplora ${field} was not a boolean`)
  }

  return value
}

function readSafeInteger(
  value: unknown,
  field: string,
  options: { minimum: number; maximum: number }
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < options.minimum ||
    value > options.maximum
  ) {
    throw new Error(
      `Esplora ${field} was not a safe integer in range [${options.minimum}, ${options.maximum}]`
    )
  }

  return value
}

function parsePositiveIntegerOption(
  value: number | undefined,
  defaultValue: number,
  label: string
): number {
  if (value === undefined) {
    return defaultValue
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Esplora ${label} must be a positive integer`)
  }

  return value
}

function parseNonNegativeIntegerOption(
  value: number | undefined,
  defaultValue: number,
  label: string
): number {
  if (value === undefined) {
    return defaultValue
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Esplora ${label} must be a non-negative integer`)
  }

  return value
}

async function readTextError(response: Response): Promise<string> {
  const body = (await response.text()).trim()
  return body.length > 0
    ? body
    : `${response.status} ${response.statusText}`.trim()
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return
  }

  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function describeRequestError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "request timed out"
  }
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
