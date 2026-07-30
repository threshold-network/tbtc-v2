import { BitcoinTxHash } from "@keep-network/tbtc-v2.ts"
import type {
  P2TRSignatureFraudWatchtowerBridgeLifecycleEvent,
  P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource,
} from "@keep-network/tbtc-v2.ts"
import type { P2TRSignatureFraudWatchtowerStoreProfileProvider } from "./types.js"

export type P2TREthersBridgeLifecycleEventLog = {
  /**
   * Retained for Ethers adapter compatibility. Lifecycle mapping ignores this
   * decoded view and derives every argument from independently verified raw
   * topics and data.
   */
  args?: Record<string, unknown> | readonly unknown[]
  transactionHash: string
  address?: string
  blockHash?: string
  blockNumber?: number
  data?: string
  logIndex?: number
  removed?: boolean
  topics?: readonly string[]
}

export type P2TREthersBridgeLifecycleBlock = {
  hash?: string
}

export type P2TREthersBridgeLifecycleProvider = {
  getBlockNumber(): Promise<number>
  getBlock?(
    blockNumber: number
  ): Promise<P2TREthersBridgeLifecycleBlock | null | undefined>
}

export type P2TREthersBridgeLifecycleContract = {
  address?: string
  provider?: P2TREthersBridgeLifecycleProvider
  filters: Record<string, () => unknown>
  queryFilter(
    filter: unknown,
    fromBlock?: number | string,
    toBlock?: number | string
  ): Promise<P2TREthersBridgeLifecycleEventLog[]>
}

export type P2TRCanonicalBridgeLifecycleEventLog =
  P2TREthersBridgeLifecycleEventLog & {
    address: string
    blockHash: string
    blockNumber: number
    data: string
    logIndex: number
    removed: false
    topics: readonly string[]
  }

export type P2TRCanonicalBridgeLifecycleLogVerification = {
  eventName: string
  expectedEmitter: string
  log: P2TRCanonicalBridgeLifecycleEventLog
}

export type P2TRCanonicalBridgeLifecycleLogRangeVerification = {
  eventName: string
  expectedEmitter: string
  fromBlock?: number | string
  toBlock?: number | string
  logs: readonly P2TRCanonicalBridgeLifecycleEventLog[]
}

/**
 * Canonical lifecycle verification must be backed by an Ethereum view that is
 * operationally independent from the provider used by `queryFilter`.
 * `verifyLifecycleLog` is expected to check a successful canonical receipt and
 * exact requested event signature, emitter/topics/data/transaction/log-index
 * membership.
 */
export type P2TRCanonicalBridgeLifecycleLogVerifier = {
  readonly trustDomainID: string
  /** Exact provider object used for canonical reads. */
  readonly providerIdentity: object
  getBlockNumber(): Promise<number>
  getCanonicalBlockHash(blockNumber: number): Promise<string>
  verifyLifecycleLogRange(
    verification: P2TRCanonicalBridgeLifecycleLogRangeVerification
  ): Promise<boolean>
  verifyLifecycleLog(
    verification: P2TRCanonicalBridgeLifecycleLogVerification
  ): Promise<boolean>
}

export type P2TREthersCanonicalBridgeLifecycleReceipt = {
  status?: number
  blockHash: string
  blockNumber: number
  transactionHash: string
  logs: P2TREthersBridgeLifecycleEventLog[]
}

export type P2TREthersCanonicalBridgeLifecycleProvider = {
  getBlockNumber(): Promise<number>
  getBlock(
    blockNumber: number
  ): Promise<P2TREthersBridgeLifecycleBlock | null | undefined>
  getTransactionReceipt(
    transactionHash: string
  ): Promise<P2TREthersCanonicalBridgeLifecycleReceipt | null | undefined>
  getLogs(filter: {
    address: string
    topics: readonly string[]
    fromBlock?: number | string
    toBlock?: number | string
  }): Promise<P2TREthersBridgeLifecycleEventLog[]>
}

/**
 * Receipt-membership verifier for an independently configured Ethers provider.
 * The caller is responsible for assigning a trust-domain ID that reflects the
 * provider's real operational failure domain, not merely a different URL.
 */
export class EthersP2TRCanonicalBridgeLifecycleLogVerifier
  implements P2TRCanonicalBridgeLifecycleLogVerifier
{
  readonly trustDomainID: string
  readonly providerIdentity: object

  constructor(
    trustDomainID: string,
    private readonly provider: P2TREthersCanonicalBridgeLifecycleProvider
  ) {
    this.trustDomainID = normalizeTrustDomainID(
      trustDomainID,
      "Bridge lifecycle canonical verifier trust-domain ID"
    )
    if (
      provider === undefined ||
      typeof provider.getBlockNumber !== "function" ||
      typeof provider.getBlock !== "function" ||
      typeof provider.getTransactionReceipt !== "function" ||
      typeof provider.getLogs !== "function"
    ) {
      throw new Error(
        "Bridge lifecycle canonical verifier requires an Ethers provider"
      )
    }
    this.providerIdentity = provider
  }

  async getBlockNumber(): Promise<number> {
    const blockNumber = await this.provider.getBlockNumber()
    validateBlockHead(blockNumber, "Bridge lifecycle canonical verifier head")
    return blockNumber
  }

  async getCanonicalBlockHash(blockNumber: number): Promise<string> {
    const block = await this.provider.getBlock(blockNumber)
    if (
      block === undefined ||
      block === null ||
      typeof block.hash !== "string"
    ) {
      throw new Error(
        `Bridge lifecycle canonical block ${blockNumber} hash is unavailable`
      )
    }

    return normalizeFixedBytes32(
      block.hash,
      `Bridge lifecycle canonical block ${blockNumber} hash`
    )
  }

  async verifyLifecycleLogRange({
    eventName,
    expectedEmitter,
    fromBlock,
    toBlock,
    logs,
  }: P2TRCanonicalBridgeLifecycleLogRangeVerification): Promise<boolean> {
    const expectedTopic = CANONICAL_LIFECYCLE_EVENT_TOPICS[eventName]
    if (expectedTopic === undefined) {
      return false
    }

    try {
      const canonicalLogs = (
        await this.provider.getLogs({
          address: expectedEmitter,
          topics: [expectedTopic],
          fromBlock,
          toBlock,
        })
      ).map((log) => {
        const canonicalLog = normalizeCanonicalLifecycleLog(
          log,
          expectedEmitter
        )
        validateCanonicalLifecycleLogBlockRange(canonicalLog, {
          isEmpty: false,
          fromBlock,
          toBlock,
        })
        return canonicalLog
      })

      return canonicalLifecycleLogSetsEqual(logs, canonicalLogs)
    } catch {
      return false
    }
  }

  async verifyLifecycleLog({
    eventName,
    expectedEmitter,
    log,
  }: P2TRCanonicalBridgeLifecycleLogVerification): Promise<boolean> {
    if (!canonicalLifecycleEventTopicMatches(eventName, log)) {
      return false
    }

    const receipt = await this.provider.getTransactionReceipt(
      log.transactionHash
    )
    if (receipt === undefined || receipt === null || receipt.status !== 1) {
      return false
    }

    try {
      if (
        normalizeFixedBytes32(
          receipt.transactionHash,
          "Bridge lifecycle canonical receipt transaction hash"
        ) !== log.transactionHash ||
        receipt.blockNumber !== log.blockNumber ||
        normalizeFixedBytes32(
          receipt.blockHash,
          "Bridge lifecycle canonical receipt block hash"
        ) !== log.blockHash ||
        (await this.getCanonicalBlockHash(log.blockNumber)) !== log.blockHash ||
        !Array.isArray(receipt.logs)
      ) {
        return false
      }

      return receipt.logs.some((receiptLog) =>
        canonicalReceiptLogMatches(receiptLog, expectedEmitter, log)
      )
    } catch {
      return false
    }
  }
}

export type P2TRTimedOutBridgeEventStatus = "slashed" | "rewarded"

export type P2TRBridgeLifecycleScanCursor = {
  lastScannedBlock: number
  lastScannedBlockHash?: string
}

export type P2TRBridgeLifecycleScanCursorStore = {
  readonly p2trSignatureFraudWatchtowerStoreProfile?: P2TRSignatureFraudWatchtowerStoreProfileProvider["p2trSignatureFraudWatchtowerStoreProfile"]
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID?: P2TRSignatureFraudWatchtowerStoreProfileProvider["p2trSignatureFraudWatchtowerTransactionalStoreID"]
  loadBridgeLifecycleScanCursor(): Promise<
    P2TRBridgeLifecycleScanCursor | undefined
  >
  saveBridgeLifecycleScanCursor(
    cursor: P2TRBridgeLifecycleScanCursor
  ): Promise<void>
}

export type EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions = {
  sourceTrustDomainID: string
  canonicalLogVerifier: P2TRCanonicalBridgeLifecycleLogVerifier
  canonicalLogVerificationConcurrency?: number
  fromBlock?: number | string
  toBlock?: number | string
  confirmationDepth?: number
  maxBlockRange?: number
  cursorOverlapBlocks?: number
  requireCursorBlockHash?: boolean
  scanCursorStore?: P2TRBridgeLifecycleScanCursorStore
  timedOutEventStatus?: P2TRTimedOutBridgeEventStatus
}

type P2TRResolvedBridgeLifecycleBlockRange =
  | {
      isEmpty: true
    }
  | {
      isEmpty: false
      fromBlock?: number | string
      toBlock?: number | string
      cursorBlock?: number
      cursorBlockHash?: string
    }

type TaggedP2TRBridgeLifecycleLog = P2TRCanonicalBridgeLifecycleEventLog & {
  lifecycleType:
    | "defeated"
    | "timed-out"
    | "moving-funds-proof"
    | "redemption-proof"
}

const P2TR_DEFEATED_EVENT = "P2TRSignatureFraudChallengeDefeated"
const P2TR_DEFEAT_TIMED_OUT_EVENT = "P2TRSignatureFraudChallengeDefeatTimedOut"
const MOVING_FUNDS_COMPLETED_EVENT = "MovingFundsCompleted"
const REDEMPTIONS_COMPLETED_EVENT = "RedemptionsCompleted"
const DEFAULT_CANONICAL_LOG_VERIFICATION_CONCURRENCY = 8

const CANONICAL_LIFECYCLE_EVENT_TOPICS: Readonly<Record<string, string>> = {
  [P2TR_DEFEATED_EVENT]:
    "0x1c09e160fcfdba6315144c05e93357f8a6f0db7517253b7ce4854c3b6d3bafac",
  [P2TR_DEFEAT_TIMED_OUT_EVENT]:
    "0x798f765e06fb1f2a5b39a4ffddc27396be8ba8e51b59b1d08d82c95922e5b331",
  [MOVING_FUNDS_COMPLETED_EVENT]:
    "0xc635af1892551655b9dbb3256a0eed3e35baf4fcc5392b80e6a907b6f44a2838",
  [REDEMPTIONS_COMPLETED_EVENT]:
    "0xa45596c10f758d32ec8cca64a0fbfe776052b08fdb3f026e0a87f52118bf8fbe",
}

function canonicalLifecycleEventTopicMatches(
  eventName: string,
  log: P2TRCanonicalBridgeLifecycleEventLog
): boolean {
  const expectedTopic = CANONICAL_LIFECYCLE_EVENT_TOPICS[eventName]
  if (expectedTopic === undefined) {
    return false
  }

  try {
    return (
      normalizeFixedBytes32(
        log.topics[0],
        "Bridge lifecycle canonical event signature topic"
      ) === expectedTopic
    )
  } catch {
    return false
  }
}

export class EthersP2TRSignatureFraudBridgeLifecycleEventSource
  implements P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource
{
  readonly p2trSignatureFraudWatchtowerStoreProfile:
    | P2TRSignatureFraudWatchtowerStoreProfileProvider["p2trSignatureFraudWatchtowerStoreProfile"]
    | undefined
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID:
    | P2TRSignatureFraudWatchtowerStoreProfileProvider["p2trSignatureFraudWatchtowerTransactionalStoreID"]
    | undefined
  private pendingCursorBlock?: number
  private pendingCursorBlockHash?: string
  private readonly bridge: P2TREthersBridgeLifecycleContract
  private readonly options: EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions
  private readonly canonicalLogVerificationTaskQueue: BoundedTaskQueue

  constructor(
    p2trSignatureFraudRouter: P2TREthersBridgeLifecycleContract,
    bridge: P2TREthersBridgeLifecycleContract,
    options: EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions
  )

  constructor(
    p2trSignatureFraudRouter: P2TREthersBridgeLifecycleContract,
    options: EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions
  )

  constructor(
    private readonly p2trSignatureFraudRouter: P2TREthersBridgeLifecycleContract,
    bridgeOrOptions:
      | P2TREthersBridgeLifecycleContract
      | EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions,
    maybeOptions?: EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions
  ) {
    const hasSeparateBridgeContract =
      isP2TREthersBridgeLifecycleContract(bridgeOrOptions)

    this.bridge = hasSeparateBridgeContract
      ? bridgeOrOptions
      : p2trSignatureFraudRouter
    this.options = hasSeparateBridgeContract
      ? requireLifecycleSourceOptions(maybeOptions)
      : requireLifecycleSourceOptions(
          bridgeOrOptions as
            | EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions
            | undefined
        )

    this.canonicalLogVerificationTaskQueue = new BoundedTaskQueue(
      resolveCanonicalLogVerificationConcurrency(
        this.options.canonicalLogVerificationConcurrency
      )
    )

    this.p2trSignatureFraudWatchtowerStoreProfile =
      this.options.scanCursorStore?.p2trSignatureFraudWatchtowerStoreProfile
    this.p2trSignatureFraudWatchtowerTransactionalStoreID =
      this.options.scanCursorStore?.p2trSignatureFraudWatchtowerTransactionalStoreID
    validateCanonicalVerificationOptions(
      this.options,
      this.p2trSignatureFraudRouter,
      this.bridge
    )
    validateBlockRangeOptions(this.options)
  }

  async listBridgeLifecycleEvents(): Promise<
    P2TRSignatureFraudWatchtowerBridgeLifecycleEvent[]
  > {
    this.pendingCursorBlock = undefined
    this.pendingCursorBlockHash = undefined

    const blockRange = await resolveBridgeLifecycleBlockRange(
      this.bridge,
      this.options
    )

    if (blockRange.isEmpty === true) {
      return []
    }

    const [
      defeatedLogs,
      timedOutLogs,
      movingFundsProofLogs,
      redemptionProofLogs,
    ] = await Promise.all([
      this.queryLifecycleLogs(
        this.p2trSignatureFraudRouter,
        "P2TR signature fraud router",
        P2TR_DEFEATED_EVENT,
        "defeated",
        blockRange
      ),
      this.queryLifecycleLogs(
        this.p2trSignatureFraudRouter,
        "P2TR signature fraud router",
        P2TR_DEFEAT_TIMED_OUT_EVENT,
        "timed-out",
        blockRange
      ),
      this.queryLifecycleLogs(
        this.bridge,
        "Bridge",
        MOVING_FUNDS_COMPLETED_EVENT,
        "moving-funds-proof",
        blockRange
      ),
      this.queryLifecycleLogs(
        this.bridge,
        "Bridge",
        REDEMPTIONS_COMPLETED_EVENT,
        "redemption-proof",
        blockRange
      ),
    ])

    const events = [
      ...defeatedLogs,
      ...timedOutLogs,
      ...movingFundsProofLogs,
      ...redemptionProofLogs,
    ]
      .sort(compareP2TRBridgeLifecycleLogs)
      .flatMap((log) => this.toWatchtowerEvents(log))

    this.pendingCursorBlock = blockRange.cursorBlock
    this.pendingCursorBlockHash = blockRange.cursorBlockHash
    return events
  }

  async commitBridgeLifecycleScan(): Promise<void> {
    if (
      this.options.scanCursorStore === undefined ||
      this.pendingCursorBlock === undefined
    ) {
      return
    }

    const pendingCursorBlock = this.pendingCursorBlock
    const pendingCursorBlockHash = this.pendingCursorBlockHash
    const cursor: P2TRBridgeLifecycleScanCursor = {
      lastScannedBlock: pendingCursorBlock,
    }
    const currentCanonicalBlockHash = await resolveCanonicalBridgeBlockHash(
      this.options.canonicalLogVerifier,
      pendingCursorBlock,
      "Bridge lifecycle canonical cursor commit block"
    )

    if (
      pendingCursorBlockHash === undefined ||
      currentCanonicalBlockHash !== pendingCursorBlockHash
    ) {
      throw new Error(
        "Bridge lifecycle canonical cursor commit block hash changed after scan"
      )
    }

    if (this.options.requireCursorBlockHash === true) {
      const sourceCursorBlockHash = await resolveBridgeBlockHash(
        this.bridge,
        pendingCursorBlock,
        "Bridge lifecycle source cursor commit block"
      )

      if (sourceCursorBlockHash !== currentCanonicalBlockHash) {
        throw new Error(
          "Bridge lifecycle source cursor commit block hash does not match the independent canonical view"
        )
      }

      cursor.lastScannedBlockHash = currentCanonicalBlockHash
    }

    await this.options.scanCursorStore.saveBridgeLifecycleScanCursor(cursor)
    this.pendingCursorBlock = undefined
    this.pendingCursorBlockHash = undefined
  }

  private async queryLifecycleLogs(
    contract: P2TREthersBridgeLifecycleContract,
    contractName: string,
    eventName: string,
    lifecycleType: TaggedP2TRBridgeLifecycleLog["lifecycleType"],
    blockRange: Extract<
      P2TRResolvedBridgeLifecycleBlockRange,
      { isEmpty: false }
    >
  ): Promise<TaggedP2TRBridgeLifecycleLog[]> {
    const filterBuilder = contract.filters[eventName]

    if (typeof filterBuilder !== "function") {
      throw new Error(
        `${contractName} contract filter ${eventName} is unavailable`
      )
    }

    const logs = await contract.queryFilter(
      filterBuilder(),
      blockRange.fromBlock,
      blockRange.toBlock
    )
    const expectedEmitter = normalizeEthereumAddress(
      contract.address,
      `${contractName} contract address`
    )

    const canonicalLogs = logs.map((log) => {
      const canonicalLog = normalizeCanonicalLifecycleLog(log, expectedEmitter)
      validateCanonicalLifecycleLogBlockRange(canonicalLog, blockRange)
      return canonicalLog
    })
    const isComplete =
      await this.options.canonicalLogVerifier.verifyLifecycleLogRange({
        eventName,
        expectedEmitter,
        fromBlock: blockRange.fromBlock,
        toBlock: blockRange.toBlock,
        logs: canonicalLogs,
      })

    if (!isComplete) {
      throw new Error(
        `${contractName} ${eventName} log range is not independently complete`
      )
    }

    return Promise.all(
      canonicalLogs.map(async (canonicalLog) => {
        const isCanonical = await this.canonicalLogVerificationTaskQueue.run(
          () =>
            this.options.canonicalLogVerifier.verifyLifecycleLog({
              eventName,
              expectedEmitter,
              log: canonicalLog,
            })
        )

        if (!isCanonical) {
          throw new Error(
            `${contractName} ${eventName} log is not independently canonical`
          )
        }

        return { ...canonicalLog, lifecycleType }
      })
    )
  }

  private toWatchtowerEvents(
    log: TaggedP2TRBridgeLifecycleLog
  ): P2TRSignatureFraudWatchtowerBridgeLifecycleEvent[] {
    const transactionHash = normalizeFixedBytes32(
      log.transactionHash,
      "Bridge lifecycle transaction hash"
    )

    switch (log.lifecycleType) {
      case "defeated": {
        const lifecycleArguments = decodeCanonicalChallengeLifecycleArguments(
          log,
          P2TR_DEFEATED_EVENT
        )

        return [
          {
            type: "defeated",
            defeatTxHash: transactionHash,
            ...lifecycleArguments,
          },
        ]
      }

      case "moving-funds-proof":
        return [
          {
            type: "honest-spend-proven",
            bitcoinTxHash: decodeCanonicalCompletedProofBitcoinTxHash(
              log,
              MOVING_FUNDS_COMPLETED_EVENT
            ),
            spendType: "moving-funds",
          },
        ]

      case "redemption-proof":
        return [
          {
            type: "honest-spend-proven",
            bitcoinTxHash: decodeCanonicalCompletedProofBitcoinTxHash(
              log,
              REDEMPTIONS_COMPLETED_EVENT
            ),
            spendType: "redemption",
          },
        ]

      case "timed-out": {
        const lifecycleArguments = decodeCanonicalChallengeLifecycleArguments(
          log,
          P2TR_DEFEAT_TIMED_OUT_EVENT
        )

        return timedOutBridgeEventStatuses(this.options).map((status) =>
          status === "slashed"
            ? {
                type: "slashed",
                slashingTxHash: transactionHash,
                ...lifecycleArguments,
              }
            : {
                type: "rewarded",
                rewardTxHash: transactionHash,
                ...lifecycleArguments,
              }
        )
      }
    }
  }
}

class BoundedTaskQueue {
  private activeTasks = 0
  private readonly waitingTasks: Array<() => void> = []

  constructor(private readonly concurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
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

function resolveCanonicalLogVerificationConcurrency(
  value: number | undefined
): number {
  if (value === undefined) {
    return DEFAULT_CANONICAL_LOG_VERIFICATION_CONCURRENCY
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      "Bridge lifecycle canonical log verification concurrency must be a positive integer"
    )
  }

  return value
}

function isP2TREthersBridgeLifecycleContract(
  value:
    | P2TREthersBridgeLifecycleContract
    | EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions
): value is P2TREthersBridgeLifecycleContract {
  const candidate = value as P2TREthersBridgeLifecycleContract

  return (
    candidate !== undefined &&
    typeof candidate.queryFilter === "function" &&
    candidate.filters !== undefined &&
    typeof candidate.filters === "object"
  )
}

function timedOutBridgeEventStatuses(
  options: EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions
): P2TRTimedOutBridgeEventStatus[] {
  return options.timedOutEventStatus === undefined
    ? ["slashed", "rewarded"]
    : [options.timedOutEventStatus]
}

async function resolveBridgeLifecycleBlockRange(
  bridge: P2TREthersBridgeLifecycleContract,
  options: EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions
): Promise<P2TRResolvedBridgeLifecycleBlockRange> {
  const fromBlock =
    options.fromBlock ??
    (options.scanCursorStore === undefined
      ? undefined
      : await resolveCursorFromBlock(
          bridge,
          options.canonicalLogVerifier,
          options.scanCursorStore,
          options.cursorOverlapBlocks ?? 0,
          options.requireCursorBlockHash ?? false
        ))
  let toBlock =
    options.toBlock ??
    (options.confirmationDepth === undefined
      ? undefined
      : await resolveConfirmedToBlock(
          bridge,
          options.canonicalLogVerifier,
          options.confirmationDepth
        ))

  if (toBlock !== undefined && typeof toBlock === "number" && toBlock < 0) {
    return { isEmpty: true }
  }

  if (
    typeof fromBlock === "number" &&
    typeof toBlock === "number" &&
    fromBlock > toBlock
  ) {
    return { isEmpty: true }
  }

  if (
    options.maxBlockRange !== undefined &&
    typeof fromBlock === "number" &&
    typeof toBlock === "number" &&
    toBlock - fromBlock + 1 > options.maxBlockRange
  ) {
    if (options.scanCursorStore === undefined) {
      throw new Error(
        "Bridge lifecycle event block range exceeds maxBlockRange"
      )
    }

    toBlock = fromBlock + options.maxBlockRange - 1
  }

  const cursorBlock = typeof toBlock === "number" ? toBlock : undefined
  const cursorBlockHash =
    options.scanCursorStore !== undefined && cursorBlock !== undefined
      ? await resolveCanonicalBridgeBlockHash(
          options.canonicalLogVerifier,
          cursorBlock,
          "Bridge lifecycle canonical cursor scan boundary block"
        )
      : undefined

  if (
    options.requireCursorBlockHash === true &&
    cursorBlock !== undefined &&
    cursorBlockHash !== undefined
  ) {
    const sourceCursorBlockHash = await resolveBridgeBlockHash(
      bridge,
      cursorBlock,
      "Bridge lifecycle source cursor scan boundary block"
    )

    if (sourceCursorBlockHash !== cursorBlockHash) {
      throw new Error(
        "Bridge lifecycle source cursor scan boundary block hash does not match the independent canonical view"
      )
    }
  }

  return {
    isEmpty: false,
    fromBlock,
    toBlock,
    cursorBlock,
    cursorBlockHash,
  }
}

async function resolveConfirmedToBlock(
  bridge: P2TREthersBridgeLifecycleContract,
  canonicalLogVerifier: P2TRCanonicalBridgeLifecycleLogVerifier,
  confirmationDepth: number
): Promise<number> {
  if (bridge.provider === undefined) {
    throw new Error(
      "Bridge lifecycle confirmation depth requires a contract provider"
    )
  }

  const [sourceHead, canonicalHead] = await Promise.all([
    bridge.provider.getBlockNumber(),
    canonicalLogVerifier.getBlockNumber(),
  ])
  validateBlockHead(sourceHead, "Bridge lifecycle source head")
  validateBlockHead(canonicalHead, "Bridge lifecycle canonical verifier head")

  return Math.min(sourceHead, canonicalHead) - confirmationDepth
}

async function resolveCursorFromBlock(
  bridge: P2TREthersBridgeLifecycleContract,
  canonicalLogVerifier: P2TRCanonicalBridgeLifecycleLogVerifier,
  cursorStore: P2TRBridgeLifecycleScanCursorStore,
  cursorOverlapBlocks: number,
  requireCursorBlockHash: boolean
): Promise<number> {
  const cursor = await cursorStore.loadBridgeLifecycleScanCursor()

  if (cursor === undefined) {
    return 0
  }

  if (
    !Number.isInteger(cursor.lastScannedBlock) ||
    cursor.lastScannedBlock < 0
  ) {
    throw new Error("Bridge lifecycle scan cursor must be non-negative")
  }

  await validateCursorBlockHash(
    bridge,
    canonicalLogVerifier,
    cursor,
    requireCursorBlockHash
  )

  return Math.max(0, cursor.lastScannedBlock + 1 - cursorOverlapBlocks)
}

async function validateCursorBlockHash(
  bridge: P2TREthersBridgeLifecycleContract,
  canonicalLogVerifier: P2TRCanonicalBridgeLifecycleLogVerifier,
  cursor: P2TRBridgeLifecycleScanCursor,
  requireCursorBlockHash: boolean
): Promise<void> {
  if (cursor.lastScannedBlockHash === undefined) {
    if (requireCursorBlockHash) {
      throw new Error("Bridge lifecycle scan cursor block hash is required")
    }

    return
  }

  const expectedBlockHash = normalizeFixedBytes32(
    cursor.lastScannedBlockHash,
    "Bridge lifecycle scan cursor block hash"
  )
  const currentBlockHash = await resolveCanonicalBridgeBlockHash(
    canonicalLogVerifier,
    cursor.lastScannedBlock,
    "Bridge lifecycle canonical scan cursor block"
  )

  if (currentBlockHash !== expectedBlockHash) {
    throw new Error("Bridge lifecycle scan cursor block hash mismatch")
  }

  if (requireCursorBlockHash) {
    const sourceBlockHash = await resolveBridgeBlockHash(
      bridge,
      cursor.lastScannedBlock,
      "Bridge lifecycle source scan cursor block"
    )

    if (sourceBlockHash !== currentBlockHash) {
      throw new Error(
        "Bridge lifecycle source scan cursor block hash does not match the independent canonical view"
      )
    }
  }
}

async function resolveBridgeBlockHash(
  bridge: P2TREthersBridgeLifecycleContract,
  blockNumber: number,
  label: string
): Promise<string> {
  const block = await bridge.provider?.getBlock?.(blockNumber)

  if (block === undefined || block === null || typeof block.hash !== "string") {
    throw new Error(`${label} hash is unavailable`)
  }

  return normalizeFixedBytes32(block.hash, `${label} hash`)
}

async function resolveCanonicalBridgeBlockHash(
  verifier: P2TRCanonicalBridgeLifecycleLogVerifier,
  blockNumber: number,
  label: string
): Promise<string> {
  return normalizeFixedBytes32(
    await verifier.getCanonicalBlockHash(blockNumber),
    `${label} hash`
  )
}

function validateBlockHead(blockNumber: number, label: string): void {
  if (!Number.isInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
}

function requireLifecycleSourceOptions(
  options: EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions | undefined
): EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions {
  if (options === undefined) {
    throw new Error(
      "Bridge lifecycle event source requires independent canonical verification options"
    )
  }

  return options
}

function validateCanonicalVerificationOptions(
  options: EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions,
  p2trSignatureFraudRouter: P2TREthersBridgeLifecycleContract,
  bridge: P2TREthersBridgeLifecycleContract
): void {
  const sourceTrustDomainID = normalizeTrustDomainID(
    options.sourceTrustDomainID,
    "Bridge lifecycle source trust-domain ID"
  )
  const verifier = options.canonicalLogVerifier

  if (
    verifier === undefined ||
    typeof verifier.providerIdentity !== "object" ||
    verifier.providerIdentity === null ||
    typeof verifier.verifyLifecycleLogRange !== "function" ||
    typeof verifier.verifyLifecycleLog !== "function" ||
    typeof verifier.getBlockNumber !== "function" ||
    typeof verifier.getCanonicalBlockHash !== "function"
  ) {
    throw new Error(
      "Bridge lifecycle event source requires an independent canonical-log verifier"
    )
  }

  const routerProviderIdentity = p2trSignatureFraudRouter.provider
  const bridgeProviderIdentity = bridge.provider
  if (
    typeof routerProviderIdentity !== "object" ||
    routerProviderIdentity === null ||
    typeof bridgeProviderIdentity !== "object" ||
    bridgeProviderIdentity === null
  ) {
    throw new Error(
      "Bridge lifecycle event source requires source provider identities"
    )
  }

  if (routerProviderIdentity !== bridgeProviderIdentity) {
    throw new Error(
      "Bridge lifecycle router and Bridge contracts must use the same source provider instance"
    )
  }

  if (
    verifier.providerIdentity === routerProviderIdentity ||
    verifier.providerIdentity === bridgeProviderIdentity
  ) {
    throw new Error(
      "Bridge lifecycle source and canonical verifier must use different provider instances"
    )
  }

  const verifierTrustDomainID = normalizeTrustDomainID(
    verifier.trustDomainID,
    "Bridge lifecycle canonical verifier trust-domain ID"
  )
  if (sourceTrustDomainID === verifierTrustDomainID) {
    throw new Error(
      "Bridge lifecycle source and canonical verifier must use different trust domains"
    )
  }
}

function canonicalLifecycleLogSetsEqual(
  left: readonly P2TRCanonicalBridgeLifecycleEventLog[],
  right: readonly P2TRCanonicalBridgeLifecycleEventLog[]
): boolean {
  if (left.length !== right.length) {
    return false
  }

  const leftIdentities = left.map(canonicalLifecycleLogIdentity).sort()
  const rightIdentities = right.map(canonicalLifecycleLogIdentity).sort()

  return leftIdentities.every(
    (identity, index) => identity === rightIdentities[index]
  )
}

function canonicalLifecycleLogIdentity(
  log: P2TRCanonicalBridgeLifecycleEventLog
): string {
  return JSON.stringify({
    address: log.address,
    blockHash: log.blockHash,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    topics: log.topics,
    data: log.data,
  })
}

function normalizeTrustDomainID(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`)
  }

  return value.trim().toLowerCase()
}

function validateBlockRangeOptions(
  options: EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions
): void {
  validateOptionalBlockNumber(options.fromBlock, "Bridge lifecycle fromBlock")
  validateOptionalBlockNumber(options.toBlock, "Bridge lifecycle toBlock")

  if (
    options.confirmationDepth !== undefined &&
    (!Number.isInteger(options.confirmationDepth) ||
      options.confirmationDepth < 0)
  ) {
    throw new Error("Bridge lifecycle confirmation depth must be non-negative")
  }

  if (
    options.maxBlockRange !== undefined &&
    (!Number.isInteger(options.maxBlockRange) || options.maxBlockRange <= 0)
  ) {
    throw new Error("Bridge lifecycle max block range must be positive")
  }

  if (
    options.cursorOverlapBlocks !== undefined &&
    (!Number.isInteger(options.cursorOverlapBlocks) ||
      options.cursorOverlapBlocks < 0)
  ) {
    throw new Error(
      "Bridge lifecycle cursor overlap blocks must be non-negative"
    )
  }

  if (
    options.timedOutEventStatus !== undefined &&
    options.timedOutEventStatus !== "slashed" &&
    options.timedOutEventStatus !== "rewarded"
  ) {
    throw new Error(
      "Bridge lifecycle timed-out event status must be slashed or rewarded"
    )
  }

  if (options.scanCursorStore !== undefined) {
    if (options.fromBlock !== undefined) {
      throw new Error(
        "Bridge lifecycle scan cursor cannot be combined with fromBlock"
      )
    }

    if (options.maxBlockRange === undefined) {
      throw new Error("Bridge lifecycle scan cursor requires maxBlockRange")
    }

    if (
      options.cursorOverlapBlocks !== undefined &&
      options.cursorOverlapBlocks >= options.maxBlockRange
    ) {
      throw new Error(
        "Bridge lifecycle cursor overlap blocks must be less than maxBlockRange when using a scan cursor"
      )
    }

    const hasCommittableUpperBlock =
      typeof options.toBlock === "number" ||
      (options.toBlock === undefined && options.confirmationDepth !== undefined)

    if (!hasCommittableUpperBlock) {
      throw new Error(
        "Bridge lifecycle scan cursor requires a numeric toBlock or confirmation depth"
      )
    }
  } else if (options.requireCursorBlockHash === true) {
    throw new Error(
      "Bridge lifecycle cursor block-hash validation requires a scan cursor"
    )
  }
}

function validateOptionalBlockNumber(
  value: number | string | undefined,
  label: string
): void {
  if (value === undefined || typeof value !== "number") {
    return
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
}

function compareP2TRBridgeLifecycleLogs(
  left: TaggedP2TRBridgeLifecycleLog,
  right: TaggedP2TRBridgeLifecycleLog
): number {
  const leftBlock = left.blockNumber ?? Number.MAX_SAFE_INTEGER
  const rightBlock = right.blockNumber ?? Number.MAX_SAFE_INTEGER

  if (leftBlock !== rightBlock) {
    return leftBlock - rightBlock
  }

  const leftLogIndex = left.logIndex ?? Number.MAX_SAFE_INTEGER
  const rightLogIndex = right.logIndex ?? Number.MAX_SAFE_INTEGER

  if (leftLogIndex !== rightLogIndex) {
    return leftLogIndex - rightLogIndex
  }

  const transactionHashOrder = left.transactionHash.localeCompare(
    right.transactionHash
  )
  if (transactionHashOrder !== 0) {
    return transactionHashOrder
  }

  return left.lifecycleType.localeCompare(right.lifecycleType)
}

function normalizeCanonicalLifecycleLog(
  log: P2TREthersBridgeLifecycleEventLog,
  expectedEmitter: string
): P2TRCanonicalBridgeLifecycleEventLog {
  const blockNumber = requireLogPosition(
    log.blockNumber,
    "Bridge lifecycle event block number"
  )
  const logIndex = requireLogPosition(
    log.logIndex,
    "Bridge lifecycle event log index"
  )
  const address = normalizeEthereumAddress(
    log.address,
    "Bridge lifecycle event emitter"
  )
  if (address !== expectedEmitter) {
    throw new Error(
      "Bridge lifecycle event emitter does not match the queried contract"
    )
  }
  if (log.removed === true) {
    throw new Error("Bridge lifecycle event was removed from the source view")
  }
  if (!Array.isArray(log.topics) || log.topics.length === 0) {
    throw new Error("Bridge lifecycle event topics are required")
  }

  return {
    address,
    blockHash: normalizeFixedBytes32(
      requireString(log.blockHash, "Bridge lifecycle event block hash"),
      "Bridge lifecycle event block hash"
    ),
    blockNumber,
    data: normalizeHexData(log.data, "Bridge lifecycle event data"),
    logIndex,
    removed: false,
    topics: log.topics.map((topic, index) =>
      normalizeFixedBytes32(
        requireString(topic, `Bridge lifecycle event topic[${index}]`),
        `Bridge lifecycle event topic[${index}]`
      )
    ),
    transactionHash: normalizeFixedBytes32(
      log.transactionHash,
      "Bridge lifecycle transaction hash"
    ),
  }
}

function validateCanonicalLifecycleLogBlockRange(
  log: P2TRCanonicalBridgeLifecycleEventLog,
  blockRange: Extract<P2TRResolvedBridgeLifecycleBlockRange, { isEmpty: false }>
): void {
  if (
    (typeof blockRange.fromBlock === "number" &&
      log.blockNumber < blockRange.fromBlock) ||
    (typeof blockRange.toBlock === "number" &&
      log.blockNumber > blockRange.toBlock)
  ) {
    throw new Error(
      `Bridge lifecycle event block ${log.blockNumber} is outside the resolved block range`
    )
  }
}

function canonicalReceiptLogMatches(
  receiptLog: P2TREthersBridgeLifecycleEventLog,
  expectedEmitter: string,
  sourceLog: P2TRCanonicalBridgeLifecycleEventLog
): boolean {
  try {
    const canonicalReceiptLog = normalizeCanonicalLifecycleLog(
      receiptLog,
      expectedEmitter
    )

    return (
      canonicalReceiptLog.address === sourceLog.address &&
      canonicalReceiptLog.blockHash === sourceLog.blockHash &&
      canonicalReceiptLog.blockNumber === sourceLog.blockNumber &&
      canonicalReceiptLog.data === sourceLog.data &&
      canonicalReceiptLog.logIndex === sourceLog.logIndex &&
      canonicalReceiptLog.transactionHash === sourceLog.transactionHash &&
      canonicalReceiptLog.topics.length === sourceLog.topics.length &&
      canonicalReceiptLog.topics.every(
        (topic, index) => topic === sourceLog.topics[index]
      )
    )
  } catch {
    return false
  }
}

function requireLogPosition(value: number | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }

  return value
}

function normalizeEthereumAddress(
  value: string | undefined,
  label: string
): string {
  const hex = stripHexPrefix(requireString(value, label), label)

  if (hex.length !== 40) {
    throw new Error(`${label} must be 20 bytes`)
  }

  return `0x${hex}`
}

function normalizeHexData(value: string | undefined, label: string): string {
  const hex = stripHexPrefix(requireString(value, label), label)

  if (hex.length % 2 !== 0) {
    throw new Error(`${label} must contain whole bytes`)
  }

  return `0x${hex}`
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is required`)
  }

  return value
}

function decodeCanonicalCompletedProofBitcoinTxHash(
  log: P2TRCanonicalBridgeLifecycleEventLog,
  eventName:
    | typeof MOVING_FUNDS_COMPLETED_EVENT
    | typeof REDEMPTIONS_COMPLETED_EVENT
): string {
  const [internalOrderHash] = decodeCanonicalLifecycleEventDataWords(
    log,
    eventName,
    2,
    1
  )
  validateCanonicalIndexedBytes20(
    log.topics[1],
    `Bridge ${eventName} wallet public key hash`
  )

  // The Bridge stores/emits Bitcoin tx hashes in the Bitcoin INTERNAL (protocol,
  // little-endian) byte order -- the value `validateProof` returns and Bridge
  // storage keys use. Esplora observations and the watchtower challenge records
  // key on the EXPLORER/DISPLAY byte order (`BitcoinTxHash.from(txid)`), and the
  // matcher compares byte-for-byte via `Hex.equals`. Reverse to display order so
  // a confirmed honest-spend proof event resolves to the observed transaction
  // instead of silently failing to match -- otherwise the watchtower would keep
  // or submit a fraud challenge against an already-proven honest spend. This
  // mirrors the SDK convention (`BitcoinTxHash.from(...).reverse()`) applied to
  // every other Bridge-emitted Bitcoin tx hash. Applied only to the Bitcoin
  // proof tx hash; the Ethereum bytes32 fields (walletID/sighash/etc.) keep
  // their order via the shared normalizeFixedBytes32 helper.
  return BitcoinTxHash.from(internalOrderHash).reverse().toPrefixedString()
}

function decodeCanonicalChallengeLifecycleArguments(
  log: P2TRCanonicalBridgeLifecycleEventLog,
  eventName: typeof P2TR_DEFEATED_EVENT | typeof P2TR_DEFEAT_TIMED_OUT_EVENT
): {
  bridgeChallengeKey: string
  walletID: string
  bridgeChallengeIdentity: string
  sighash: string
} {
  const [bridgeChallengeKey, sighash] = decodeCanonicalLifecycleEventDataWords(
    log,
    eventName,
    4,
    2
  )
  const walletID = normalizeFixedBytes32(
    log.topics[1],
    `Bridge ${eventName} wallet ID`
  )
  validateCanonicalIndexedBytes20(
    log.topics[2],
    `Bridge ${eventName} wallet public key hash`
  )
  const bridgeChallengeIdentity = normalizeFixedBytes32(
    log.topics[3],
    `Bridge ${eventName} challenge identity`
  )

  return {
    bridgeChallengeKey,
    walletID,
    bridgeChallengeIdentity,
    sighash,
  }
}

function decodeCanonicalLifecycleEventDataWords(
  log: P2TRCanonicalBridgeLifecycleEventLog,
  eventName: string,
  expectedTopicCount: number,
  expectedDataWordCount: number
): string[] {
  if (!canonicalLifecycleEventTopicMatches(eventName, log)) {
    throw new Error(
      `Bridge ${eventName} event signature topic does not match the requested event`
    )
  }

  if (log.topics.length !== expectedTopicCount) {
    throw new Error(
      `Bridge ${eventName} event must contain exactly ${expectedTopicCount} topics`
    )
  }

  const data = stripHexPrefix(
    log.data,
    `Bridge ${eventName} canonical event data`
  )
  const expectedHexLength = expectedDataWordCount * 64

  if (data.length !== expectedHexLength) {
    throw new Error(
      `Bridge ${eventName} event data must contain exactly ${expectedDataWordCount} ABI words`
    )
  }

  return Array.from({ length: expectedDataWordCount }, (_, index) =>
    normalizeFixedBytes32(
      `0x${data.slice(index * 64, (index + 1) * 64)}`,
      `Bridge ${eventName} event data word[${index}]`
    )
  )
}

function validateCanonicalIndexedBytes20(value: string, label: string): void {
  const topic = normalizeFixedBytes32(value, label)
  if (topic.slice(42) !== "0".repeat(24)) {
    throw new Error(`${label} must be right-padded to 32 bytes`)
  }
}

function normalizeFixedBytes32(value: string, label: string): string {
  const hex = stripHexPrefix(value, label)

  if (hex.length !== 64) {
    throw new Error(`${label} must be 32 bytes`)
  }

  return `0x${hex}`
}

function stripHexPrefix(value: string, label: string): string {
  const hex = value.replace(/^(0x|0X)/, "")

  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${label} must be hex`)
  }

  return hex.toLowerCase()
}
