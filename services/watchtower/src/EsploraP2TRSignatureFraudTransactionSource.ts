import {
  BitcoinAddressConverter,
  BitcoinNetwork,
  BitcoinTxHash,
  DepositScript,
  DepositScriptType,
  Hex,
} from "@keep-network/tbtc-v2.ts"
import type {
  BitcoinRawTx,
  Bridge,
  P2TRSignatureFraudWatchtowerTransactionSource,
  P2TRWalletInputKeyBinding,
  P2TRWatchtowerConfirmedTransaction,
  P2TRWatchtowerConfirmedTransactionSourceResult,
  P2TRWatchtowerMempoolTransaction,
} from "@keep-network/tbtc-v2.ts"
import type {
  P2TRConfirmedHistoryCursor,
  P2TRConfirmedHistoryCursorStore,
  P2TRConfirmedHistoryTransaction,
  P2TRTaprootDepositBindingInventory,
  P2TRTaprootDepositBindingInventoryEntry,
} from "./FileBackedP2TRConfirmedHistoryCursorStore.js"

export type P2TREsploraFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>

export type P2TRTaprootDepositRevealSource = Pick<
  Bridge,
  | "deposits"
  | "getTaprootDepositRevealedEvents"
  | "taprootDepositOutputKeyCommitment"
> & {
  /** Opaque identity of the RPC/provider connection serving these reads. */
  readonly providerIdentity: object
  getBlockNumber(): Promise<number>
  getCanonicalBlockHash(blockNumber: number): Promise<string>
}

export type P2TRCanonicalTaprootDepositRevealSource =
  P2TRTaprootDepositRevealSource & {
    readonly trustDomainID: string
  }

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
  taprootDepositRevealSourceTrustDomainID: string
  canonicalTaprootDepositRevealSource: P2TRCanonicalTaprootDepositRevealSource
  confirmedHistoryCursorStore: P2TRConfirmedHistoryCursorStore
  onDepositScanFailure: P2TRDepositScanFailureHandler
  fetchFn?: P2TREsploraFetch
  maxAttempts?: number
  requestTimeoutMs?: number
  retryDelayMs?: number
  confirmedPageLimit?: number
  depositScanConcurrency?: number
  taprootDepositRevealFromBlock?: number
  taprootDepositRevealConfirmationDepth?: number
  taprootDepositRevealMaxBlockRange?: number
  taprootDepositRevealChainID: unknown
  taprootDepositRevealBridgeAddress: string
  taprootDepositRevealMaxEventsPerRange?: number
  depositOutspendScanLimit?: number
  taprootDepositBindingInventoryLimit?: number
}

type EsploraTransactionSummary = {
  txid: string
  status?: EsploraTransactionStatus
}

type EsploraTransactionCandidate = EsploraTransactionSummary & {
  walletInputKeyBindings: P2TRWalletInputKeyBinding[]
}

type P2TRDepositSpendScanResult = {
  transactions: EsploraTransactionCandidate[]
  complete: boolean
  inventory?: P2TRTaprootDepositBindingInventory
}

type EsploraTransactionStatus = {
  confirmed: boolean
  block_hash?: string
  block_height?: number
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_REQUEST_TIMEOUT_MS = 5000
const DEFAULT_RETRY_DELAY_MS = 250
const DEFAULT_CONFIRMED_PAGE_LIMIT = 10000
const DEFAULT_DEPOSIT_SCAN_CONCURRENCY = 8
const DEFAULT_TAPROOT_DEPOSIT_REVEAL_FROM_BLOCK = 0
const DEFAULT_TAPROOT_DEPOSIT_REVEAL_CONFIRMATION_DEPTH = 12

/**
 * Esplora's /address/:addr/txs/mempool view caps its response with no cursor.
 * When the response equals or exceeds this size, more entries exist in the
 * mempool than Esplora returns, so we cannot see the full picture and an
 * attacker could dust-spam a wallet to push a fraudulent spend out of view.
 */
const ESPLORA_MEMPOOL_PAGE_CAP = 50
const DEFAULT_TAPROOT_DEPOSIT_REVEAL_MAX_BLOCK_RANGE = 2000
const DEFAULT_TAPROOT_DEPOSIT_REVEAL_MAX_EVENTS_PER_RANGE = 1000
const DEFAULT_DEPOSIT_OUTSPEND_SCAN_LIMIT = 100
const DEFAULT_TAPROOT_DEPOSIT_BINDING_INVENTORY_LIMIT = 10000
const MAX_UINT32 = 0xffffffff
const ZERO_BYTES32 = "00".repeat(32)
// P2TR addresses are encoded via the SDK's BitcoinAddressConverter
// (see deriveP2TRWalletAddress below). The local bech32m implementation has
// been removed to avoid divergence with the SDK's canonical encoder.

/**
 * Concrete evidence that the Esplora mempool view is truncated for a wallet.
 * An attacker can dust-spam the wallet's address to push a fraudulent
 * spend out of the visible window, so the watchtower must surface this
 * as a regular operator alert rather than silently continue.
 */
export class EsploraMempoolTruncationAlert extends Error {
  readonly address: string
  readonly visibleCount: number
  constructor(address: string, visibleCount: number) {
    super(
      `Esplora mempool view for ${address} is truncated at ${visibleCount} entries; ` +
        `additional mempool transactions are not visible and may evade detection.`
    )
    this.name = "EsploraMempoolTruncationAlert"
    this.address = address
    this.visibleCount = visibleCount
  }
}

/**
 * Rehearsal-only Esplora observer.
 *
 * Its rotating outpoint polling is explicitly bounded and can halt at the
 * finite binding-inventory ceiling, but it is not a canonical Bitcoin change
 * feed. It therefore always reports an incomplete observation, even after a
 * full polling sweep. COMPLETE_V2 activation requires a keyed deposit database,
 * a canonical Bitcoin block/change-feed cursor with block-hash rollback,
 * bounded new-block input matching, and a durable unmatched Ethereum-proof
 * backlog.
 */
export class EsploraP2TRSignatureFraudTransactionSource
  implements P2TRSignatureFraudWatchtowerTransactionSource
{
  readonly p2trSignatureFraudWatchtowerStoreProfile
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID
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
  private readonly canonicalTaprootDepositRevealSource: P2TRCanonicalTaprootDepositRevealSource
  private readonly confirmedHistoryCursorStore: P2TRConfirmedHistoryCursorStore
  private readonly onDepositScanFailure: P2TRDepositScanFailureHandler
  private readonly taprootDepositRevealFromBlock: number
  private readonly taprootDepositRevealConfirmationDepth: number
  private readonly taprootDepositRevealMaxBlockRange: number
  private readonly taprootDepositRevealConfigurationFingerprint: string
  private readonly taprootDepositRevealMaxEventsPerRange: number
  private readonly depositOutspendScanLimit: number
  private readonly taprootDepositBindingInventoryLimit: number
  private depositSpendScan?: Promise<P2TRDepositSpendScanResult>
  private pendingConfirmedHistoryCursors?: Map<
    string,
    P2TRConfirmedHistoryCursor
  >
  private pendingTaprootDepositBindingInventory?: P2TRTaprootDepositBindingInventory

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
        .taprootDepositOutputKeyCommitment !== "function" ||
      typeof options.taprootDepositRevealSource.getBlockNumber !== "function" ||
      typeof options.taprootDepositRevealSource.getCanonicalBlockHash !==
        "function" ||
      typeof options.taprootDepositRevealSource.providerIdentity !== "object" ||
      options.taprootDepositRevealSource.providerIdentity === null
    ) {
      throw new Error(
        "Esplora P2TR transaction source requires a Taproot deposit reveal source"
      )
    }

    this.taprootDepositRevealSource = options.taprootDepositRevealSource
    if (
      options.canonicalTaprootDepositRevealSource === undefined ||
      typeof options.canonicalTaprootDepositRevealSource
        .getTaprootDepositRevealedEvents !== "function" ||
      typeof options.canonicalTaprootDepositRevealSource.deposits !==
        "function" ||
      typeof options.canonicalTaprootDepositRevealSource
        .taprootDepositOutputKeyCommitment !== "function" ||
      typeof options.canonicalTaprootDepositRevealSource.getBlockNumber !==
        "function" ||
      typeof options.canonicalTaprootDepositRevealSource
        .getCanonicalBlockHash !== "function" ||
      typeof options.canonicalTaprootDepositRevealSource.providerIdentity !==
        "object" ||
      options.canonicalTaprootDepositRevealSource.providerIdentity === null
    ) {
      throw new Error(
        "Esplora P2TR transaction source requires an independent canonical Taproot deposit reveal source"
      )
    }
    const revealSourceTrustDomainID = normalizeTrustDomainID(
      options.taprootDepositRevealSourceTrustDomainID,
      "Taproot deposit reveal source trust-domain ID"
    )
    const canonicalRevealSourceTrustDomainID = normalizeTrustDomainID(
      options.canonicalTaprootDepositRevealSource.trustDomainID,
      "canonical Taproot deposit reveal source trust-domain ID"
    )
    if (
      revealSourceTrustDomainID === canonicalRevealSourceTrustDomainID ||
      options.taprootDepositRevealSource ===
        options.canonicalTaprootDepositRevealSource ||
      options.taprootDepositRevealSource.providerIdentity ===
        options.canonicalTaprootDepositRevealSource.providerIdentity
    ) {
      throw new Error(
        "Taproot deposit reveal source and canonical source must use different trust domains"
      )
    }
    this.canonicalTaprootDepositRevealSource =
      options.canonicalTaprootDepositRevealSource
    if (
      options.confirmedHistoryCursorStore === undefined ||
      typeof options.confirmedHistoryCursorStore.loadConfirmedHistoryCursor !==
        "function" ||
      typeof options.confirmedHistoryCursorStore.saveConfirmedHistoryCursor !==
        "function" ||
      typeof options.confirmedHistoryCursorStore
        .loadTaprootDepositBindingInventory !== "function" ||
      typeof options.confirmedHistoryCursorStore
        .saveTaprootDepositBindingInventory !== "function"
    ) {
      throw new Error(
        "Esplora P2TR transaction source requires a confirmed-history cursor store"
      )
    }
    this.confirmedHistoryCursorStore = options.confirmedHistoryCursorStore
    this.p2trSignatureFraudWatchtowerStoreProfile =
      options.confirmedHistoryCursorStore.p2trSignatureFraudWatchtowerStoreProfile
    this.p2trSignatureFraudWatchtowerTransactionalStoreID =
      options.confirmedHistoryCursorStore.p2trSignatureFraudWatchtowerTransactionalStoreID
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
    this.taprootDepositRevealFromBlock = parseNonNegativeIntegerOption(
      options.taprootDepositRevealFromBlock,
      DEFAULT_TAPROOT_DEPOSIT_REVEAL_FROM_BLOCK,
      "taprootDepositRevealFromBlock"
    )
    this.taprootDepositRevealConfirmationDepth = parseNonNegativeIntegerOption(
      options.taprootDepositRevealConfirmationDepth,
      DEFAULT_TAPROOT_DEPOSIT_REVEAL_CONFIRMATION_DEPTH,
      "taprootDepositRevealConfirmationDepth"
    )
    this.taprootDepositRevealMaxBlockRange = parsePositiveIntegerOption(
      options.taprootDepositRevealMaxBlockRange,
      DEFAULT_TAPROOT_DEPOSIT_REVEAL_MAX_BLOCK_RANGE,
      "taprootDepositRevealMaxBlockRange"
    )
    this.taprootDepositRevealMaxEventsPerRange = parsePositiveIntegerOption(
      options.taprootDepositRevealMaxEventsPerRange,
      DEFAULT_TAPROOT_DEPOSIT_REVEAL_MAX_EVENTS_PER_RANGE,
      "taprootDepositRevealMaxEventsPerRange"
    )
    this.depositOutspendScanLimit = parsePositiveIntegerOption(
      options.depositOutspendScanLimit,
      DEFAULT_DEPOSIT_OUTSPEND_SCAN_LIMIT,
      "depositOutspendScanLimit"
    )
    this.taprootDepositBindingInventoryLimit = parsePositiveIntegerOption(
      options.taprootDepositBindingInventoryLimit,
      DEFAULT_TAPROOT_DEPOSIT_BINDING_INVENTORY_LIMIT,
      "taprootDepositBindingInventoryLimit"
    )
    const taprootDepositRevealChainID = normalizeChainID(
      options.taprootDepositRevealChainID,
      "Taproot deposit reveal chain ID"
    )
    const taprootDepositRevealBridgeAddress = normalizeAddressHex(
      options.taprootDepositRevealBridgeAddress,
      "Taproot deposit reveal Bridge address"
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
    this.taprootDepositRevealConfigurationFingerprint = JSON.stringify({
      version: 1,
      chainID: taprootDepositRevealChainID,
      bridgeAddress: taprootDepositRevealBridgeAddress,
      bitcoinNetwork,
      fromBlock: this.taprootDepositRevealFromBlock,
      confirmationDepth: this.taprootDepositRevealConfirmationDepth,
      sourceTrustDomainID: revealSourceTrustDomainID,
      canonicalTrustDomainID: canonicalRevealSourceTrustDomainID,
      registeredWalletIDs: [...this.registeredWalletIDs].sort(),
    })
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
      depositSpendTransactions.transactions.filter(
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

  async listConfirmedTransactions(): Promise<P2TRWatchtowerConfirmedTransactionSourceResult> {
    this.pendingConfirmedHistoryCursors = undefined
    this.pendingTaprootDepositBindingInventory = undefined

    try {
      const [walletHistory, depositSpendTransactions] = await Promise.all([
        this.listConfirmedWalletTransactions(),
        this.listDepositSpendTransactions(),
      ])
      const transactions = mergeTransactionCandidates(
        walletHistory.transactions.map(withoutWalletInputKeyBindings),
        depositSpendTransactions.transactions.filter(
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

      const materialized = await this.materializeRawTransactions(
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

      this.pendingConfirmedHistoryCursors = walletHistory.cursors
      this.pendingTaprootDepositBindingInventory =
        depositSpendTransactions.inventory
      return {
        transactions: materialized,
        // The bundled Esplora adapter has no independently authenticated
        // canonical Bitcoin block/change feed. Even an empty response can be a
        // lagging or omitted wallet spend, so it must never certify the complete
        // point-in-time transaction view required to advance the Ethereum
        // lifecycle cursor. Acknowledged wallet/inventory catch-up progress is
        // still committed separately by commitConfirmedTransactionScan().
        complete: false,
      }
    } catch (error) {
      this.pendingConfirmedHistoryCursors = undefined
      this.pendingTaprootDepositBindingInventory = undefined
      throw error
    }
  }

  async commitConfirmedTransactionScan(): Promise<void> {
    const pendingCursors = this.pendingConfirmedHistoryCursors
    if (pendingCursors === undefined) {
      return
    }

    for (const [address, cursor] of pendingCursors) {
      await this.confirmedHistoryCursorStore.saveConfirmedHistoryCursor(
        address,
        cursor
      )
    }
    if (this.pendingTaprootDepositBindingInventory !== undefined) {
      await this.assertTaprootDepositInventoryCursorCanonical(
        this.pendingTaprootDepositBindingInventory
      )
      await this.confirmedHistoryCursorStore.saveTaprootDepositBindingInventory(
        this.pendingTaprootDepositBindingInventory
      )
    }
    this.pendingConfirmedHistoryCursors = undefined
    this.pendingTaprootDepositBindingInventory = undefined
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

    let failedCount = 0
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        materialized.push(result.value)
        return
      }

      failedCount++
      this.reportRawTransactionFailure(
        transactions[index],
        describeRequestError(result.reason)
      )
    })

    if (failedCount > 0) {
      throw new IncompleteP2TRTransactionViewError(
        `${failedCount} raw Bitcoin transaction${
          failedCount === 1 ? "" : "s"
        } could not be materialized`
      )
    }

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

  private listDepositSpendTransactions(): Promise<P2TRDepositSpendScanResult> {
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

  private async scanDepositSpendTransactions(): Promise<P2TRDepositSpendScanResult> {
    const revealScan = await this.scanTaprootDepositBindingInventory()
    const outspendBatch = selectTaprootDepositOutspendBatch(
      revealScan.inventory,
      this.depositOutspendScanLimit
    )
    const uniqueBindingValues = outspendBatch.entries.map(
      inventoryEntryToWalletInputKeyBinding
    )
    const candidateResults = await this.scanTaskQueue.mapSettled(
      uniqueBindingValues,
      async (binding, index) => {
        const summary = await this.readDepositOutspend(binding)
        return { summary, binding, entry: outspendBatch.entries[index] }
      }
    )
    const byTxid = new Map<string, EsploraTransactionCandidate>()
    const spendUpdates = new Map<
      string,
      { spendStatus: "active" | "confirmed-spent"; txid?: string }
    >()
    let failedOutspendCount = 0

    candidateResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const binding = uniqueBindingValues[index]
        failedOutspendCount++
        this.reportDepositScanFailure({
          stage: "outspend",
          fundingTxid: String(binding.txid),
          fundingOutputIndex: binding.vout,
          error: describeRequestError(result.reason),
        })
        return
      }

      const candidate = result.value
      spendUpdates.set(
        inventoryBindingKey(candidate.entry),
        candidate.summary?.status?.confirmed === true
          ? {
              spendStatus: "confirmed-spent",
              txid: candidate.summary.txid,
            }
          : { spendStatus: "active" }
      )
      if (candidate.summary === undefined) return

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

    if (failedOutspendCount > 0) {
      throw new IncompleteP2TRTransactionViewError(
        `${failedOutspendCount} Taproot deposit scan operation${
          failedOutspendCount === 1 ? "" : "s"
        } failed`
      )
    }

    let nextInventory = revealScan.inventory
    if (nextInventory !== undefined) {
      nextInventory = {
        ...nextInventory,
        bindings: nextInventory.bindings.map((binding) => {
          const update = spendUpdates.get(inventoryBindingKey(binding))
          if (update === undefined) return binding
          return update.spendStatus === "confirmed-spent"
            ? {
                ...binding,
                spendStatus: "confirmed-spent" as const,
                confirmedSpendingTxid: update.txid!,
              }
            : {
                ...binding,
                spendStatus: "active" as const,
                confirmedSpendingTxid: undefined,
              }
        }),
        ...(outspendBatch.nextSweep === undefined
          ? { outspendSweep: undefined }
          : { outspendSweep: outspendBatch.nextSweep }),
      }
      await this.assertTaprootDepositInventoryCursorCanonical(nextInventory)
    }

    return {
      transactions: [...byTxid.values()],
      complete: revealScan.complete && outspendBatch.complete,
      inventory: nextInventory,
    }
  }

  private async scanTaprootDepositBindingInventory(): Promise<{
    complete: boolean
    inventory?: P2TRTaprootDepositBindingInventory
  }> {
    let detailedBindingFailureReported = false
    try {
      let inventory =
        await this.confirmedHistoryCursorStore.loadTaprootDepositBindingInventory()

      if (
        inventory?.configurationFingerprint !==
        this.taprootDepositRevealConfigurationFingerprint
      ) {
        inventory = undefined
      }

      if (
        inventory !== undefined &&
        inventory.bindings.length > this.taprootDepositBindingInventoryLimit
      ) {
        throw new Error(
          `Taproot deposit binding inventory exceeds the configured ${this.taprootDepositBindingInventoryLimit}-binding bound`
        )
      }

      if (inventory !== undefined) {
        const [sourceCursorHash, canonicalCursorHash] = await Promise.all([
          this.taprootDepositRevealSource.getCanonicalBlockHash(
            inventory.lastScannedBlock
          ),
          this.canonicalTaprootDepositRevealSource.getCanonicalBlockHash(
            inventory.lastScannedBlock
          ),
        ])
        const expectedHash = normalizeBytes32Hex(
          inventory.lastScannedBlockHash,
          "Taproot deposit reveal cursor block hash"
        )
        if (
          normalizeBytes32Hex(
            sourceCursorHash,
            "Taproot deposit reveal source cursor block hash"
          ) !== expectedHash ||
          normalizeBytes32Hex(
            canonicalCursorHash,
            "canonical Taproot deposit reveal cursor block hash"
          ) !== expectedHash
        ) {
          // The durable range boundary was reorganized. Discard the derived
          // inventory and rebuild it from the configured deployment boundary;
          // the incomplete result keeps challenge submission disabled while
          // bounded catch-up reconstructs all canonical outpoint bindings.
          inventory = undefined
        }
      }

      const [sourceHead, canonicalHead] = await Promise.all([
        this.readRevealSourceBlockNumber(
          this.taprootDepositRevealSource,
          "Taproot deposit reveal source"
        ),
        this.readRevealSourceBlockNumber(
          this.canonicalTaprootDepositRevealSource,
          "canonical Taproot deposit reveal source"
        ),
      ])
      const canonicalFinalizedHead =
        canonicalHead - this.taprootDepositRevealConfirmationDepth
      const sourceFinalizedHead =
        sourceHead - this.taprootDepositRevealConfirmationDepth
      if (sourceFinalizedHead < canonicalFinalizedHead) {
        throw new Error(
          "Taproot deposit reveal source is behind the independently verified finalized head"
        )
      }
      if (
        inventory !== undefined &&
        inventory.lastScannedBlock > canonicalFinalizedHead
      ) {
        inventory = undefined
      }

      const fromBlock =
        inventory === undefined
          ? this.taprootDepositRevealFromBlock
          : inventory.lastScannedBlock + 1
      if (canonicalFinalizedHead < fromBlock) {
        return {
          complete: true,
          ...(inventory === undefined ? {} : { inventory }),
        }
      }

      const proposedToBlock = Math.min(
        canonicalFinalizedHead,
        fromBlock + this.taprootDepositRevealMaxBlockRange - 1
      )
      const { toBlock, canonicalEvents, rangeEndBlockHash } =
        await this.readVerifiedTaprootDepositRevealRange(
          fromBlock,
          proposedToBlock
        )

      const bindingResults = await this.scanTaskQueue.mapSettled(
        canonicalEvents,
        (event) => {
          const fundingTxid = normalizeTxid(event.fundingTxHash.toString())
          const existingKey = `${fundingTxid}:${event.fundingOutputIndex}`
          // Look up any binding already in the prior inventory by the
          // stable outpoint key so we can skip the refetch.
          const cached = inventory?.bindings.find(
            (binding) =>
              `${binding.fundingTxid}:${binding.fundingOutputIndex}` ===
              existingKey
          )
          return this.taprootDepositEventBinding(event, cached)
        }
      )
      const nextBindings = new Map<
        string,
        P2TRTaprootDepositBindingInventoryEntry
      >(
        (inventory?.bindings ?? []).map((binding) => [
          inventoryBindingKey(binding),
          binding,
        ])
      )
      let failedBindingCount = 0
      bindingResults.forEach((result, index) => {
        if (result.status === "fulfilled") {
          if (result.value === undefined) return
          const key = inventoryBindingKey(result.value)
          const existing = nextBindings.get(key)
          if (
            existing !== undefined &&
            JSON.stringify(existing) !== JSON.stringify(result.value)
          ) {
            throw new Error(
              `Taproot deposit reveal outpoint ${key} conflicts with the durable binding inventory`
            )
          }
          nextBindings.set(key, result.value)
          return
        }

        const event = canonicalEvents[index]
        failedBindingCount++
        this.reportDepositScanFailure({
          stage: "deposit-request",
          fundingTxid: event.fundingTxHash.toString(),
          fundingOutputIndex: Number(event.fundingOutputIndex),
          error: describeRequestError(result.reason),
        })
      })
      if (failedBindingCount > 0) {
        detailedBindingFailureReported = true
        throw new Error(
          `${failedBindingCount} Taproot deposit binding operation${
            failedBindingCount === 1 ? "" : "s"
          } failed`
        )
      }
      if (nextBindings.size > this.taprootDepositBindingInventoryLimit) {
        throw new Error(
          `Taproot deposit binding inventory exceeds the configured ${this.taprootDepositBindingInventoryLimit}-binding bound`
        )
      }

      const nextInventory: P2TRTaprootDepositBindingInventory = {
        configurationFingerprint:
          this.taprootDepositRevealConfigurationFingerprint,
        lastScannedBlock: toBlock,
        lastScannedBlockHash: rangeEndBlockHash,
        bindings: [...nextBindings.values()].sort((left, right) =>
          inventoryBindingKey(left).localeCompare(inventoryBindingKey(right))
        ),
        ...(inventory?.outspendSweep === undefined
          ? {}
          : { outspendSweep: inventory.outspendSweep }),
      }

      const [finalSourceHead, finalCanonicalHead] = await Promise.all([
        this.readRevealSourceBlockNumber(
          this.taprootDepositRevealSource,
          "Taproot deposit reveal source"
        ),
        this.readRevealSourceBlockNumber(
          this.canonicalTaprootDepositRevealSource,
          "canonical Taproot deposit reveal source"
        ),
      ])
      const finalCanonicalFinalizedHead =
        finalCanonicalHead - this.taprootDepositRevealConfirmationDepth
      const finalSourceFinalizedHead =
        finalSourceHead - this.taprootDepositRevealConfirmationDepth

      return {
        complete:
          finalSourceFinalizedHead >= finalCanonicalFinalizedHead &&
          toBlock >= finalCanonicalFinalizedHead,
        inventory: nextInventory,
      }
    } catch (error) {
      const errorMessage = describeRequestError(error)
      if (!detailedBindingFailureReported) {
        this.reportDepositScanFailure({
          stage: "reveal-history",
          error: errorMessage,
        })
      }
      throw new IncompleteP2TRTransactionViewError(
        `Taproot deposit reveal history is incomplete: ${errorMessage}`
      )
    }
  }

  private async readVerifiedTaprootDepositRevealRange(
    fromBlock: number,
    proposedToBlock: number
  ): Promise<{
    toBlock: number
    canonicalEvents: Awaited<
      ReturnType<
        P2TRTaprootDepositRevealSource["getTaprootDepositRevealedEvents"]
      >
    >
    rangeEndBlockHash: string
  }> {
    let toBlock = proposedToBlock

    while (true) {
      const [pinnedSourceRangeHash, pinnedCanonicalRangeHash] =
        await Promise.all([
          this.taprootDepositRevealSource.getCanonicalBlockHash(toBlock),
          this.canonicalTaprootDepositRevealSource.getCanonicalBlockHash(
            toBlock
          ),
        ])
      const normalizedPinnedSourceRangeHash = normalizeBytes32Hex(
        pinnedSourceRangeHash,
        "Taproot deposit reveal source pinned range-end block hash"
      )
      const normalizedPinnedCanonicalRangeHash = normalizeBytes32Hex(
        pinnedCanonicalRangeHash,
        "canonical Taproot deposit reveal pinned range-end block hash"
      )
      if (
        normalizedPinnedSourceRangeHash !== normalizedPinnedCanonicalRangeHash
      ) {
        throw new Error(
          "Taproot deposit reveal pinned range-end block hash does not match the independent source"
        )
      }

      const [sourceEvents, canonicalEvents] = await Promise.all([
        this.taprootDepositRevealSource.getTaprootDepositRevealedEvents({
          fromBlock,
          toBlock,
        }),
        this.canonicalTaprootDepositRevealSource.getTaprootDepositRevealedEvents(
          { fromBlock, toBlock }
        ),
      ])
      if (
        sourceEvents.length > this.taprootDepositRevealMaxEventsPerRange ||
        canonicalEvents.length > this.taprootDepositRevealMaxEventsPerRange
      ) {
        if (fromBlock === toBlock) {
          throw new Error(
            `Taproot deposit reveal block ${fromBlock} exceeds the configured ${this.taprootDepositRevealMaxEventsPerRange}-event bound`
          )
        }

        // Shrink dense ranges deterministically until both independent sources
        // fit the configured work bound. This guarantees bounded downstream
        // comparison/binding work without repeatedly wedging on the same range.
        toBlock = fromBlock + Math.floor((toBlock - fromBlock) / 2)
        continue
      }

      sourceEvents.forEach((event) =>
        requireTaprootDepositRevealInRange(event, fromBlock, toBlock)
      )
      canonicalEvents.forEach((event) =>
        requireTaprootDepositRevealInRange(event, fromBlock, toBlock)
      )
      if (!taprootDepositRevealSetsEqual(sourceEvents, canonicalEvents)) {
        throw new Error(
          "Taproot deposit reveal range is not independently complete"
        )
      }

      const [sourceRangeHash, canonicalRangeHash] = await Promise.all([
        this.taprootDepositRevealSource.getCanonicalBlockHash(toBlock),
        this.canonicalTaprootDepositRevealSource.getCanonicalBlockHash(toBlock),
      ])
      const normalizedSourceRangeHash = normalizeBytes32Hex(
        sourceRangeHash,
        "Taproot deposit reveal source range-end block hash"
      )
      const normalizedCanonicalRangeHash = normalizeBytes32Hex(
        canonicalRangeHash,
        "canonical Taproot deposit reveal range-end block hash"
      )
      if (normalizedSourceRangeHash !== normalizedCanonicalRangeHash) {
        throw new Error(
          "Taproot deposit reveal range-end block hash does not match the independent source"
        )
      }
      if (normalizedCanonicalRangeHash !== normalizedPinnedCanonicalRangeHash) {
        throw new Error(
          "Taproot deposit reveal range-end block changed while the range was scanned"
        )
      }

      return {
        toBlock,
        canonicalEvents,
        rangeEndBlockHash: normalizedCanonicalRangeHash,
      }
    }
  }

  private async taprootDepositEventBinding(
    event: Awaited<
      ReturnType<
        P2TRTaprootDepositRevealSource["getTaprootDepositRevealedEvents"]
      >
    >[number],
    cachedBinding?: P2TRTaprootDepositBindingInventoryEntry
  ): Promise<P2TRTaprootDepositBindingInventoryEntry | undefined> {
    const walletID = normalizeBytes32Hex(
      event.walletXOnlyPublicKey.toString(),
      "revealed deposit wallet ID"
    )
    if (!this.registeredWalletIDs.has(walletID)) return undefined

    const fundingOutputIndex = readSafeInteger(
      event.fundingOutputIndex,
      "revealed deposit funding output index",
      { minimum: 0, maximum: MAX_UINT32 }
    )

    // Per-deposit (fundingTxHash, vout) -> (depositKeyCommitment, outputKey)
    // is immutable after the Bridge settles the deposit (Deposit.sol:461-470).
    // Short-circuit when the cached binding already covers this outpoint so
    // we don't re-fetch taprootDepositOutputKeyCommitment + deposits every
    // cycle for known deposits.
    if (
      cachedBinding !== undefined &&
      cachedBinding.fundingOutputIndex === fundingOutputIndex &&
      cachedBinding.fundingTxid === normalizeTxid(event.fundingTxHash.toString())
    ) {
      return cachedBinding
    }

    const sourceCommitment =
      await this.taprootDepositRevealSource.taprootDepositOutputKeyCommitment(
        event.fundingTxHash,
        fundingOutputIndex
      )
    const canonicalCommitment =
      await this.canonicalTaprootDepositRevealSource.taprootDepositOutputKeyCommitment(
        event.fundingTxHash,
        fundingOutputIndex
      )
    const depositKeyCommitment = normalizeBytes32Hex(
      canonicalCommitment.toString(),
      "canonical Taproot deposit output-key commitment"
    )
    if (
      normalizeBytes32Hex(
        sourceCommitment.toString(),
        "Taproot deposit output-key commitment"
      ) !== depositKeyCommitment
    ) {
      throw new Error(
        `Taproot deposit ${event.fundingTxHash.toString()}:${fundingOutputIndex} output-key commitment does not match the independent source`
      )
    }
    if (depositKeyCommitment === ZERO_BYTES32) return undefined

    const sourceDepositRequest = await this.taprootDepositRevealSource.deposits(
      event.fundingTxHash,
      fundingOutputIndex
    )
    const depositRequest =
      await this.canonicalTaprootDepositRevealSource.deposits(
        event.fundingTxHash,
        fundingOutputIndex
      )
    if (
      taprootDepositRequestIdentity(sourceDepositRequest) !==
      taprootDepositRequestIdentity(depositRequest)
    ) {
      throw new Error(
        `Taproot deposit ${event.fundingTxHash.toString()}:${fundingOutputIndex} request state does not match the independent source`
      )
    }
    if (
      depositRequest.depositor.identifierHex.toLowerCase() !==
      event.depositor.identifierHex.toLowerCase()
    ) {
      throw new Error(
        `Taproot deposit ${event.fundingTxHash.toString()}:${fundingOutputIndex} depositor does not match stored request`
      )
    }

    const outputKey = normalizeBytes32Hex(
      (
        await DepositScript.fromReceipt(
          { ...event, extraData: depositRequest.extraData },
          DepositScriptType.P2TR
        ).getTaprootOutputKey()
      ).toString(),
      "Taproot deposit output key"
    )

    return {
      blockNumber: readSafeInteger(
        event.blockNumber,
        "Taproot deposit reveal block number",
        { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
      ),
      blockHash: normalizeBytes32Hex(
        event.blockHash.toString(),
        "Taproot deposit reveal block hash"
      ),
      fundingTxid: normalizeTxid(event.fundingTxHash.toString()),
      fundingOutputIndex,
      outputKey,
      walletID,
      spendStatus: "active",
    }
  }

  private async readRevealSourceBlockNumber(
    source: P2TRTaprootDepositRevealSource,
    label: string
  ): Promise<number> {
    return readSafeInteger(await source.getBlockNumber(), `${label} head`, {
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    })
  }

  private async assertTaprootDepositInventoryCursorCanonical(
    inventory: P2TRTaprootDepositBindingInventory
  ): Promise<void> {
    const [sourceHash, canonicalHash] = await Promise.all([
      this.taprootDepositRevealSource.getCanonicalBlockHash(
        inventory.lastScannedBlock
      ),
      this.canonicalTaprootDepositRevealSource.getCanonicalBlockHash(
        inventory.lastScannedBlock
      ),
    ])
    const expectedHash = normalizeBytes32Hex(
      inventory.lastScannedBlockHash,
      "Taproot deposit binding inventory cursor block hash"
    )
    if (
      normalizeBytes32Hex(
        sourceHash,
        "Taproot deposit reveal source cursor block hash"
      ) !== expectedHash ||
      normalizeBytes32Hex(
        canonicalHash,
        "canonical Taproot deposit reveal cursor block hash"
      ) !== expectedHash
    ) {
      throw new Error(
        "Taproot deposit reveal cursor changed before the scan completed"
      )
    }
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
    const transactions = await this.readTransactionSummaries(
      `/address/${encodeURIComponent(address)}/txs/mempool`,
      `fetch mempool P2TR wallet transactions for ${address}`
    )
    if (transactions.length >= ESPLORA_MEMPOOL_PAGE_CAP) {
      throw new EsploraMempoolTruncationAlert(address, transactions.length)
    }
    return transactions
  }

  private async listConfirmedWalletTransactions(): Promise<{
    transactions: EsploraTransactionSummary[]
    complete: boolean
    cursors: Map<string, P2TRConfirmedHistoryCursor>
  }> {
    const byTxid = new Map<string, EsploraTransactionSummary>()
    const cursors = new Map<string, P2TRConfirmedHistoryCursor>()
    let complete = true
    const failures: string[] = []

    // Scan every wallet even when one remains in catch-up so one large public
    // history cannot prevent the other cursors from making bounded progress.
    for (const address of this.walletAddresses) {
      try {
        const result = await this.scanAddressConfirmedHistory(address)
        complete &&= result.complete
        cursors.set(address, result.cursor)
        for (const transaction of result.transactions) {
          byTxid.set(transaction.txid, transaction)
        }
      } catch (error) {
        failures.push(`${address}: ${describeRequestError(error)}`)
      }
    }

    if (failures.length > 0) {
      throw new IncompleteP2TRTransactionViewError(
        `Confirmed P2TR wallet history scan failed (${failures.join("; ")})`
      )
    }

    return { transactions: [...byTxid.values()], complete, cursors }
  }

  private async scanAddressConfirmedHistory(address: string): Promise<{
    complete: boolean
    transactions: EsploraTransactionSummary[]
    cursor: P2TRConfirmedHistoryCursor
  }> {
    const storedCursor =
      (await this.confirmedHistoryCursorStore.loadConfirmedHistoryCursor(
        address
      )) ?? {}
    let catchUp = storedCursor.catchUp

    if (
      catchUp !== undefined &&
      !(await this.isConfirmedHistoryCatchUpCanonical(catchUp))
    ) {
      // Either boundary disappearing or changing means the pagination token is
      // no longer safe. Restart from the canonical head; the old anchor remains
      // only as an exact stop marker and cannot match a reorganized block.
      catchUp = undefined
    }

    let headAnchor = catchUp?.headAnchor
    let after = catchUp?.after
    let batchTransactions: P2TRConfirmedHistoryTransaction[] = []

    for (let page = 0; page < this.confirmedPageLimit; page++) {
      const pageTransactions = (
        await this.readTransactionSummaries(
          confirmedHistoryPath(address, after?.txid),
          `fetch confirmed P2TR wallet transactions for ${address}`
        )
      ).map(toConfirmedHistoryTransaction)

      if (pageTransactions.length === 0) {
        return this.finalizeConfirmedHistoryBatch(
          address,
          batchTransactions,
          headAnchor
        )
      }

      headAnchor ??= pageTransactions[0]

      const stableAnchorIndex = findStableAnchorIndex(
        pageTransactions,
        storedCursor.anchor
      )
      if (stableAnchorIndex >= 0) {
        batchTransactions = appendUniqueHistoryTransactions(
          batchTransactions,
          pageTransactions.slice(0, stableAnchorIndex)
        )
        return this.finalizeConfirmedHistoryBatch(
          address,
          batchTransactions,
          headAnchor
        )
      }

      batchTransactions = appendUniqueHistoryTransactions(
        batchTransactions,
        pageTransactions
      )
      after = pageTransactions[pageTransactions.length - 1]

      if (page === this.confirmedPageLimit - 1) {
        // One bounded look-ahead establishes terminal completeness without
        // consuming or discarding the next data page. A non-empty probe is
        // resumed from the persisted boundary on the next cycle.
        const probe = (
          await this.readTransactionSummaries(
            confirmedHistoryPath(address, after.txid),
            `probe confirmed P2TR wallet transaction history for ${address}`
          )
        ).map(toConfirmedHistoryTransaction)
        if (
          probe.length === 0 ||
          findStableAnchorIndex(probe, storedCursor.anchor) === 0
        ) {
          return this.finalizeConfirmedHistoryBatch(
            address,
            batchTransactions,
            headAnchor
          )
        }
      }
    }

    if (headAnchor === undefined || after === undefined) {
      throw new Error("Confirmed P2TR wallet catch-up cursor was not advanced")
    }

    return {
      complete: false,
      transactions: batchTransactions.map(fromConfirmedHistoryTransaction),
      cursor: {
        ...(storedCursor.anchor === undefined
          ? {}
          : { anchor: storedCursor.anchor }),
        catchUp: { headAnchor, after },
      },
    }
  }

  private async isConfirmedHistoryCatchUpCanonical(
    catchUp: NonNullable<P2TRConfirmedHistoryCursor["catchUp"]>
  ): Promise<boolean> {
    const checkpoints =
      catchUp.headAnchor.txid === catchUp.after.txid
        ? [catchUp.headAnchor]
        : [catchUp.headAnchor, catchUp.after]
    const results = await Promise.all(
      checkpoints.map((checkpoint) =>
        this.isConfirmedHistoryCheckpointCanonical(checkpoint)
      )
    )
    return results.every(Boolean)
  }

  private async finalizeConfirmedHistoryBatch(
    address: string,
    transactions: P2TRConfirmedHistoryTransaction[],
    headAnchor: P2TRConfirmedHistoryTransaction | undefined
  ): Promise<{
    complete: boolean
    transactions: EsploraTransactionSummary[]
    cursor: P2TRConfirmedHistoryCursor
  }> {
    const currentHead = (
      await this.readTransactionSummaries(
        confirmedHistoryPath(address),
        `verify current confirmed P2TR wallet history head for ${address}`
      )
    ).map(toConfirmedHistoryTransaction)[0]
    const headIsCurrent =
      currentHead === undefined
        ? headAnchor === undefined
        : headAnchor !== undefined &&
          sameConfirmedHistoryTransaction(currentHead, headAnchor)

    return {
      complete: headIsCurrent,
      transactions: transactions.map(fromConfirmedHistoryTransaction),
      cursor: headAnchor === undefined ? {} : { anchor: headAnchor },
    }
  }

  private async isConfirmedHistoryCheckpointCanonical(
    checkpoint: P2TRConfirmedHistoryTransaction
  ): Promise<boolean> {
    const response = await this.request(
      "GET",
      `/tx/${checkpoint.txid}/status`,
      `validate confirmed P2TR wallet history checkpoint ${checkpoint.txid}`
    )
    if (response.status === 404) {
      return false
    }
    if (!response.ok) {
      throw new Error(
        `Failed to validate confirmed P2TR wallet history checkpoint ${
          checkpoint.txid
        }: ${await readTextError(response)}`
      )
    }

    const status = parseTransactionStatus(
      await this.readJson(response, "transaction status"),
      `confirmed history checkpoint ${checkpoint.txid}`
    )
    return (
      status.confirmed === true &&
      status.block_hash === checkpoint.blockHash &&
      status.block_height === checkpoint.blockHeight
    )
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

class IncompleteP2TRTransactionViewError extends Error {
  constructor(message: string) {
    super(`Incomplete P2TR transaction view: ${message}`)
    this.name = "IncompleteP2TRTransactionViewError"
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

function taprootDepositRevealSetsEqual(
  sourceEvents: Awaited<
    ReturnType<
      P2TRTaprootDepositRevealSource["getTaprootDepositRevealedEvents"]
    >
  >,
  canonicalEvents: Awaited<
    ReturnType<
      P2TRTaprootDepositRevealSource["getTaprootDepositRevealedEvents"]
    >
  >
): boolean {
  if (sourceEvents.length !== canonicalEvents.length) {
    return false
  }

  const sourceIdentities = sourceEvents.map(taprootDepositRevealIdentity).sort()
  const canonicalIdentities = canonicalEvents
    .map(taprootDepositRevealIdentity)
    .sort()

  return sourceIdentities.every(
    (identity, index) => identity === canonicalIdentities[index]
  )
}

function taprootDepositRevealIdentity(
  event: Awaited<
    ReturnType<
      P2TRTaprootDepositRevealSource["getTaprootDepositRevealedEvents"]
    >
  >[number]
): string {
  return JSON.stringify({
    blockNumber: readSafeInteger(
      event.blockNumber,
      "Taproot deposit reveal block number",
      { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
    ),
    blockHash: normalizeBytes32Hex(
      event.blockHash.toString(),
      "Taproot deposit reveal block hash"
    ),
    transactionHash: normalizeBytes32Hex(
      event.transactionHash.toString(),
      "Taproot deposit reveal transaction hash"
    ),
    fundingTxHash: normalizeTxid(event.fundingTxHash.toString()),
    fundingOutputIndex: readSafeInteger(
      event.fundingOutputIndex,
      "Taproot deposit reveal funding output index",
      { minimum: 0, maximum: MAX_UINT32 }
    ),
    depositor: normalizeComparableHex(event.depositor.identifierHex),
    amount: event.amount.toString(),
    blindingFactor: normalizeComparableHex(event.blindingFactor.toString()),
    walletPublicKeyHash: normalizeComparableHex(
      event.walletPublicKeyHash.toString()
    ),
    walletXOnlyPublicKey: normalizeBytes32Hex(
      event.walletXOnlyPublicKey.toString(),
      "Taproot deposit reveal wallet x-only public key"
    ),
    refundPublicKeyHash: normalizeComparableHex(
      event.refundPublicKeyHash.toString()
    ),
    refundXOnlyPublicKey: normalizeBytes32Hex(
      event.refundXOnlyPublicKey.toString(),
      "Taproot deposit reveal refund x-only public key"
    ),
    refundLocktime: normalizeComparableHex(event.refundLocktime.toString()),
    vault:
      event.vault === undefined
        ? undefined
        : normalizeComparableHex(event.vault.identifierHex),
    extraData:
      event.extraData === undefined
        ? undefined
        : normalizeComparableHex(event.extraData.toString()),
  })
}

function taprootDepositRequestIdentity(
  request: Awaited<ReturnType<P2TRTaprootDepositRevealSource["deposits"]>>
): string {
  return JSON.stringify({
    depositor: normalizeComparableHex(request.depositor.identifierHex),
    revealedAt: request.revealedAt,
    treasuryFee: request.treasuryFee.toString(),
    extraData:
      request.extraData === undefined
        ? undefined
        : normalizeComparableHex(request.extraData.toString()),
  })
}

function requireTaprootDepositRevealInRange(
  event: Awaited<
    ReturnType<
      P2TRTaprootDepositRevealSource["getTaprootDepositRevealedEvents"]
    >
  >[number],
  fromBlock: number,
  toBlock: number
): void {
  const blockNumber = readSafeInteger(
    event.blockNumber,
    "Taproot deposit reveal block number",
    { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
  )
  if (blockNumber < fromBlock || blockNumber > toBlock) {
    throw new Error(
      `Taproot deposit reveal block ${blockNumber} is outside requested range ${fromBlock}-${toBlock}`
    )
  }
}

function inventoryBindingKey(
  binding: Pick<
    P2TRTaprootDepositBindingInventoryEntry,
    "fundingTxid" | "fundingOutputIndex"
  >
): string {
  return `${normalizeTxid(binding.fundingTxid)}:${binding.fundingOutputIndex}`
}

function inventoryBindingOrderingKey(
  binding: Pick<
    P2TRTaprootDepositBindingInventoryEntry,
    "blockNumber" | "fundingTxid" | "fundingOutputIndex"
  >
): string {
  return `${binding.blockNumber.toString(16).padStart(16, "0")}:${
    binding.fundingTxid
  }:${binding.fundingOutputIndex.toString(16).padStart(8, "0")}`
}

function selectTaprootDepositOutspendBatch(
  inventory: P2TRTaprootDepositBindingInventory | undefined,
  limit: number
): {
  entries: P2TRTaprootDepositBindingInventoryEntry[]
  complete: boolean
  nextSweep?: NonNullable<P2TRTaprootDepositBindingInventory["outspendSweep"]>
} {
  if (inventory === undefined) return { entries: [], complete: true }

  const activeBindings = [...inventory.bindings].sort((left, right) =>
    inventoryBindingOrderingKey(left).localeCompare(
      inventoryBindingOrderingKey(right)
    )
  )
  if (activeBindings.length === 0) {
    return { entries: [], complete: true }
  }

  const anchorBindingKey =
    inventory.outspendSweep?.anchorBindingKey ??
    inventoryBindingOrderingKey(activeBindings[activeBindings.length - 1])
  const afterBindingKey = inventory.outspendSweep?.afterBindingKey
  const eligible = activeBindings.filter((binding) => {
    const key = inventoryBindingOrderingKey(binding)
    return (
      key <= anchorBindingKey &&
      (afterBindingKey === undefined || key > afterBindingKey)
    )
  })
  const entries = eligible.slice(0, limit)
  const lastEntry = entries[entries.length - 1]
  const lastBindingKey =
    lastEntry === undefined ? undefined : inventoryBindingOrderingKey(lastEntry)
  const newestBindingKey = inventoryBindingOrderingKey(
    activeBindings[activeBindings.length - 1]
  )
  const reachedAnchor = lastBindingKey === anchorBindingKey
  const hasNewerSuffix = newestBindingKey > anchorBindingKey
  // Esplora outspend calls do not share an independently authenticated Bitcoin
  // snapshot. Even a one-batch sequential poll can race a spend between calls,
  // so any non-empty deposit inventory must remain conservatively incomplete.
  // After reaching the anchor, clear the sweep cursor so bounded observation
  // continues from the beginning without ever certifying complete coverage.
  const complete = false

  return {
    entries,
    complete,
    ...(complete ||
    lastEntry === undefined ||
    (reachedAnchor && !hasNewerSuffix)
      ? {}
      : {
          nextSweep: {
            anchorBindingKey: reachedAnchor
              ? newestBindingKey
              : anchorBindingKey,
            afterBindingKey: lastBindingKey!,
          },
        }),
  }
}

function inventoryEntryToWalletInputKeyBinding(
  entry: P2TRTaprootDepositBindingInventoryEntry
): P2TRWalletInputKeyBinding {
  return {
    txid: normalizeTxid(entry.fundingTxid),
    vout: entry.fundingOutputIndex,
    outputKey: normalizeBytes32Hex(
      entry.outputKey,
      "Taproot deposit output key"
    ),
    walletID: normalizeBytes32Hex(entry.walletID, "Taproot deposit wallet ID"),
  }
}

function confirmedHistoryPath(address: string, afterTxid?: string): string {
  const basePath = `/address/${encodeURIComponent(address)}/txs/chain`
  return afterTxid === undefined ? basePath : `${basePath}/${afterTxid}`
}

function toConfirmedHistoryTransaction(
  transaction: EsploraTransactionSummary
): P2TRConfirmedHistoryTransaction {
  const status = requireConfirmedStatus(transaction.txid, transaction.status)
  return {
    txid: transaction.txid,
    blockHash: status.block_hash,
    blockHeight: status.block_height,
  }
}

function fromConfirmedHistoryTransaction(
  transaction: P2TRConfirmedHistoryTransaction
): EsploraTransactionSummary {
  return {
    txid: transaction.txid,
    status: {
      confirmed: true,
      block_hash: transaction.blockHash,
      block_height: transaction.blockHeight,
    },
  }
}

function findStableAnchorIndex(
  transactions: readonly P2TRConfirmedHistoryTransaction[],
  anchor: P2TRConfirmedHistoryTransaction | undefined
): number {
  if (anchor === undefined) {
    return -1
  }
  return transactions.findIndex((transaction) =>
    sameConfirmedHistoryTransaction(transaction, anchor)
  )
}

function appendUniqueHistoryTransactions(
  ...groups: readonly P2TRConfirmedHistoryTransaction[][]
): P2TRConfirmedHistoryTransaction[] {
  const transactions: P2TRConfirmedHistoryTransaction[] = []
  const seen = new Set<string>()
  for (const transaction of groups.flat()) {
    if (seen.has(transaction.txid)) {
      throw new Error(
        `Confirmed P2TR wallet transaction history repeated transaction ${transaction.txid}`
      )
    }
    seen.add(transaction.txid)
    transactions.push(transaction)
  }
  return transactions
}

function sameConfirmedHistoryTransaction(
  left: P2TRConfirmedHistoryTransaction,
  right: P2TRConfirmedHistoryTransaction
): boolean {
  return (
    left.txid === right.txid &&
    left.blockHash === right.blockHash &&
    left.blockHeight === right.blockHeight
  )
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
  return BitcoinAddressConverter.taprootOutputKeyToAddress(
    Hex.from(normalizeBytes32Hex(walletID, "wallet ID")),
    bitcoinNetwork
  )
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

function normalizeTrustDomainID(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Esplora P2TR transaction source ${label} must be non-empty`
    )
  }
  return value.trim().toLowerCase()
}

function normalizeChainID(value: unknown, label: string): string {
  try {
    let candidate: string | number | bigint
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint"
    ) {
      candidate = value
    } else if (
      typeof value === "object" &&
      value !== null &&
      "toString" in value &&
      typeof value.toString === "function"
    ) {
      candidate = value.toString()
    } else {
      throw new Error("unsupported")
    }
    const chainID = BigInt(candidate)
    if (chainID <= 0n) throw new Error("non-positive")
    return chainID.toString(10)
  } catch {
    throw new Error(
      `Esplora P2TR transaction source ${label} must be a positive integer`
    )
  }
}

function normalizeBytes32Hex(value: string, label: string): string {
  const strippedValue = stripHexPrefix(value.trim())

  if (!/^[0-9a-fA-F]{64}$/.test(strippedValue)) {
    throw new Error(`P2TR signature-fraud watchtower ${label} must be 32 bytes`)
  }

  return strippedValue.toLowerCase()
}

function normalizeAddressHex(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `Esplora P2TR transaction source ${label} must be 20-byte hex`
    )
  }
  const strippedValue = stripHexPrefix(value.trim())
  if (!/^[0-9a-fA-F]{40}$/.test(strippedValue)) {
    throw new Error(
      `Esplora P2TR transaction source ${label} must be 20-byte hex`
    )
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

function normalizeComparableHex(value: string): string {
  const normalizedValue = stripHexPrefix(value.trim()).toLowerCase()
  if (
    !/^[0-9a-f]*$/.test(normalizedValue) ||
    normalizedValue.length % 2 !== 0
  ) {
    throw new Error(`Taproot deposit reveal field was not valid hex: ${value}`)
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
