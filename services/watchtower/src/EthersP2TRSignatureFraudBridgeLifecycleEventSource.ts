import type {
  P2TRSignatureFraudWatchtowerBridgeLifecycleEvent,
  P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource,
} from "@keep-network/tbtc-v2.ts"
import type { P2TRSignatureFraudWatchtowerStoreProfileProvider } from "./types.js"

export type P2TREthersBridgeLifecycleEventLog = {
  args?: Record<string, unknown> | readonly unknown[]
  transactionHash: string
  blockNumber?: number
  logIndex?: number
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
  provider?: P2TREthersBridgeLifecycleProvider
  filters: Record<string, () => unknown>
  queryFilter(
    filter: unknown,
    fromBlock?: number | string,
    toBlock?: number | string
  ): Promise<P2TREthersBridgeLifecycleEventLog[]>
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

type TaggedP2TRBridgeLifecycleLog = P2TREthersBridgeLifecycleEventLog & {
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

  constructor(
    private readonly bridge: P2TREthersBridgeLifecycleContract,
    private readonly options: EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions = {}
  ) {
    this.p2trSignatureFraudWatchtowerStoreProfile =
      options.scanCursorStore?.p2trSignatureFraudWatchtowerStoreProfile
    this.p2trSignatureFraudWatchtowerTransactionalStoreID =
      options.scanCursorStore?.p2trSignatureFraudWatchtowerTransactionalStoreID
    validateBlockRangeOptions(options)
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

    if (blockRange.isEmpty) {
      return []
    }

    const [
      defeatedLogs,
      timedOutLogs,
      movingFundsProofLogs,
      redemptionProofLogs,
    ] = await Promise.all([
      this.queryLifecycleLogs(P2TR_DEFEATED_EVENT, "defeated", blockRange),
      this.queryLifecycleLogs(
        P2TR_DEFEAT_TIMED_OUT_EVENT,
        "timed-out",
        blockRange
      ),
      this.queryLifecycleLogs(
        MOVING_FUNDS_COMPLETED_EVENT,
        "moving-funds-proof",
        blockRange
      ),
      this.queryLifecycleLogs(
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

    if (this.options.requireCursorBlockHash === true) {
      const currentCursorBlockHash = await resolveBridgeBlockHash(
        this.bridge,
        pendingCursorBlock,
        "Bridge lifecycle cursor commit block"
      )

      if (
        pendingCursorBlockHash !== undefined &&
        currentCursorBlockHash !== pendingCursorBlockHash
      ) {
        throw new Error(
          "Bridge lifecycle cursor commit block hash changed after scan"
        )
      }

      cursor.lastScannedBlockHash = currentCursorBlockHash
    }

    await this.options.scanCursorStore.saveBridgeLifecycleScanCursor(cursor)
    this.pendingCursorBlock = undefined
    this.pendingCursorBlockHash = undefined
  }

  private async queryLifecycleLogs(
    eventName: string,
    lifecycleType: TaggedP2TRBridgeLifecycleLog["lifecycleType"],
    blockRange: Extract<
      P2TRResolvedBridgeLifecycleBlockRange,
      { isEmpty: false }
    >
  ): Promise<TaggedP2TRBridgeLifecycleLog[]> {
    const filterBuilder = this.bridge.filters[eventName]

    if (typeof filterBuilder !== "function") {
      throw new Error(`Bridge contract filter ${eventName} is unavailable`)
    }

    const logs = await this.bridge.queryFilter(
      filterBuilder(),
      blockRange.fromBlock,
      blockRange.toBlock
    )

    return logs.map((log) => {
      validateLifecycleLogMetadata(log)

      return { ...log, lifecycleType }
    })
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
        const bridgeChallengeKey = normalizeUint256Bytes32(
          extractChallengeKey(log),
          "Bridge challenge key"
        )
        const eventEvidence = extractBridgeLifecycleEventEvidence(log)

        return [
          {
            type: "defeated",
            bridgeChallengeKey,
            defeatTxHash: transactionHash,
            ...eventEvidence,
          },
        ]
      }

      case "moving-funds-proof":
        return [
          {
            type: "honest-spend-proven",
            bitcoinTxHash: extractCompletedProofBitcoinTxHash(
              log,
              "movingFundsTxHash",
              1,
              "moving-funds transaction hash"
            ),
            spendType: "moving-funds",
          },
        ]

      case "redemption-proof":
        return [
          {
            type: "honest-spend-proven",
            bitcoinTxHash: extractCompletedProofBitcoinTxHash(
              log,
              "redemptionTxHash",
              1,
              "redemption transaction hash"
            ),
            spendType: "redemption",
          },
        ]

      case "timed-out": {
        const bridgeChallengeKey = normalizeUint256Bytes32(
          extractChallengeKey(log),
          "Bridge challenge key"
        )
        const eventEvidence = extractBridgeLifecycleEventEvidence(log)

        return timedOutBridgeEventStatuses(this.options).map((status) =>
          status === "slashed"
            ? {
                type: "slashed",
                bridgeChallengeKey,
                slashingTxHash: transactionHash,
                ...eventEvidence,
              }
            : {
                type: "rewarded",
                bridgeChallengeKey,
                rewardTxHash: transactionHash,
                ...eventEvidence,
              }
        )
      }
    }
  }
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
          options.scanCursorStore,
          options.cursorOverlapBlocks ?? 0,
          options.requireCursorBlockHash ?? false
        ))
  let toBlock =
    options.toBlock ??
    (options.confirmationDepth === undefined
      ? undefined
      : await resolveConfirmedToBlock(bridge, options.confirmationDepth))

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
    options.requireCursorBlockHash === true && cursorBlock !== undefined
      ? await resolveBridgeBlockHash(
          bridge,
          cursorBlock,
          "Bridge lifecycle cursor scan boundary block"
        )
      : undefined

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
  confirmationDepth: number
): Promise<number> {
  if (bridge.provider === undefined) {
    throw new Error(
      "Bridge lifecycle confirmation depth requires a contract provider"
    )
  }

  return (await bridge.provider.getBlockNumber()) - confirmationDepth
}

async function resolveCursorFromBlock(
  bridge: P2TREthersBridgeLifecycleContract,
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

  await validateCursorBlockHash(bridge, cursor, requireCursorBlockHash)

  return Math.max(0, cursor.lastScannedBlock + 1 - cursorOverlapBlocks)
}

async function validateCursorBlockHash(
  bridge: P2TREthersBridgeLifecycleContract,
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
  const currentBlockHash = await resolveBridgeBlockHash(
    bridge,
    cursor.lastScannedBlock,
    "Bridge lifecycle scan cursor block"
  )

  if (currentBlockHash !== expectedBlockHash) {
    throw new Error("Bridge lifecycle scan cursor block hash mismatch")
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

function validateLifecycleLogMetadata(
  log: P2TREthersBridgeLifecycleEventLog
): void {
  validateOptionalLogPosition(
    log.blockNumber,
    "Bridge lifecycle event block number"
  )
  validateOptionalLogPosition(log.logIndex, "Bridge lifecycle event log index")
}

function validateOptionalLogPosition(
  value: number | undefined,
  label: string
): void {
  if (value === undefined) {
    return
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
}

function extractChallengeKey(log: P2TREthersBridgeLifecycleEventLog): unknown {
  const args = log.args

  if (args === undefined) {
    throw new Error("Bridge lifecycle event is missing args")
  }

  const namedChallengeKey = (args as Record<string, unknown>).challengeKey
  if (namedChallengeKey !== undefined) {
    return namedChallengeKey
  }

  const indexedChallengeKey = (args as readonly unknown[])[3]
  if (indexedChallengeKey !== undefined) {
    return indexedChallengeKey
  }

  throw new Error("Bridge lifecycle event is missing challengeKey")
}

function extractCompletedProofBitcoinTxHash(
  log: P2TREthersBridgeLifecycleEventLog,
  namedField: "movingFundsTxHash" | "redemptionTxHash",
  indexedField: number,
  label: string
): string {
  const args = log.args

  if (args === undefined) {
    throw new Error(`Bridge proof event is missing ${label}`)
  }

  const namedValue = (args as Record<string, unknown>)[namedField]
  const indexedValue = (args as readonly unknown[])[indexedField]
  const value = namedValue ?? indexedValue

  if (value === undefined) {
    throw new Error(`Bridge proof event is missing ${label}`)
  }

  return normalizeFixedBytes32(
    normalizeIntegerHex(value, `Bridge proof event ${label}`),
    `Bridge proof event ${label}`
  )
}

function extractBridgeLifecycleEventEvidence(
  log: P2TREthersBridgeLifecycleEventLog
): {
  walletID?: string
  bridgeChallengeIdentity?: string
  sighash?: string
} {
  return {
    ...extractOptionalFixedBytes32LogArg(log, "walletID", 0, "wallet ID"),
    ...extractOptionalFixedBytes32LogArg(
      log,
      "bridgeChallengeIdentity",
      2,
      "Bridge challenge identity"
    ),
    ...extractOptionalFixedBytes32LogArg(log, "sighash", 4, "sighash"),
  }
}

function extractOptionalFixedBytes32LogArg(
  log: P2TREthersBridgeLifecycleEventLog,
  namedField: "walletID" | "bridgeChallengeIdentity" | "sighash",
  indexedField: number,
  label: string
): Partial<Record<"walletID" | "bridgeChallengeIdentity" | "sighash", string>> {
  const args = log.args

  if (args === undefined) {
    return {}
  }

  const namedValue = (args as Record<string, unknown>)[namedField]
  const indexedValue = (args as readonly unknown[])[indexedField]
  const value = namedValue ?? indexedValue

  return value === undefined
    ? {}
    : {
        [namedField]: normalizeFixedBytes32(
          normalizeIntegerHex(value, `Bridge lifecycle event ${label}`),
          `Bridge lifecycle event ${label}`
        ),
      }
}

function normalizeUint256Bytes32(value: unknown, label: string): string {
  const hex = normalizeIntegerHex(value, label)

  if (hex.length > 64) {
    throw new Error(`${label} exceeds 32 bytes`)
  }

  return `0x${hex.padStart(64, "0")}`
}

function normalizeFixedBytes32(value: string, label: string): string {
  const hex = stripHexPrefix(value, label)

  if (hex.length !== 64) {
    throw new Error(`${label} must be 32 bytes`)
  }

  return `0x${hex}`
}

function normalizeIntegerHex(value: unknown, label: string): string {
  if (typeof value === "string") {
    return stripHexPrefix(value, label)
  }

  if (typeof value === "number" || typeof value === "bigint") {
    if (value < 0) {
      throw new Error(`${label} must not be negative`)
    }

    return BigInt(value).toString(16)
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toHexString" in value &&
    typeof value.toHexString === "function"
  ) {
    return stripHexPrefix(value.toHexString(), label)
  }

  throw new Error(`${label} must be a hex string or integer-like value`)
}

function stripHexPrefix(value: string, label: string): string {
  const hex = value.replace(/^(0x|0X)/, "")

  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${label} must be hex`)
  }

  return hex.toLowerCase()
}
