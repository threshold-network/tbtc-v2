import { promises as fs } from "fs"

import { writeFileAtomically } from "./AtomicFile.js"
import type { P2TRSignatureFraudWatchtowerStoreProfileProvider } from "./types.js"

export type P2TRConfirmedHistoryTransaction = {
  txid: string
  blockHash: string
  blockHeight: number
}

export type P2TRConfirmedHistoryCursor = {
  anchor?: P2TRConfirmedHistoryTransaction
  catchUp?: {
    headAnchor: P2TRConfirmedHistoryTransaction
    after: P2TRConfirmedHistoryTransaction
  }
}

export type P2TRTaprootDepositBindingInventoryEntry = {
  blockNumber: number
  blockHash: string
  fundingTxid: string
  fundingOutputIndex: number
  outputKey: string
  walletID: string
  spendStatus: "active" | "confirmed-spent"
  confirmedSpendingTxid?: string
}

export type P2TRTaprootDepositBindingInventory = {
  configurationFingerprint: string
  lastScannedBlock: number
  lastScannedBlockHash: string
  bindings: P2TRTaprootDepositBindingInventoryEntry[]
  outspendSweep?: {
    anchorBindingKey: string
    afterBindingKey: string
  }
}

export type P2TRConfirmedHistoryCursorStore =
  P2TRSignatureFraudWatchtowerStoreProfileProvider & {
    loadConfirmedHistoryCursor(
      address: string
    ): Promise<P2TRConfirmedHistoryCursor | undefined>
    saveConfirmedHistoryCursor(
      address: string,
      cursor: P2TRConfirmedHistoryCursor
    ): Promise<void>
    loadTaprootDepositBindingInventory(): Promise<
      P2TRTaprootDepositBindingInventory | undefined
    >
    saveTaprootDepositBindingInventory(
      inventory: P2TRTaprootDepositBindingInventory
    ): Promise<void>
  }

type P2TRConfirmedHistoryCursorFile = {
  version: 1
  wallets: Record<string, P2TRConfirmedHistoryCursor>
  taprootDepositBindingInventory?: P2TRTaprootDepositBindingInventory
}

type FileSnapshot = { exists: false } | { exists: true; contents: Buffer }

export type FileBackedP2TRConfirmedHistoryCursorStoreOptions = {
  maxFileBytes?: number
}

export const DEFAULT_P2TR_CONFIRMED_HISTORY_CURSOR_MAX_FILE_BYTES =
  16 * 1024 * 1024
export const MAXIMUM_P2TR_CONFIRMED_HISTORY_CURSOR_MAX_FILE_BYTES =
  64 * 1024 * 1024

/**
 * Single-process durable cursor store for bounded Esplora history catch-up.
 * Production multi-process deployments should provide a transactional store
 * implementing `P2TRConfirmedHistoryCursorStore` instead.
 */
export class FileBackedP2TRConfirmedHistoryCursorStore
  implements P2TRConfirmedHistoryCursorStore
{
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "single-process-rehearsal" as const
  private state?: P2TRConfirmedHistoryCursorFile
  private snapshot?: FileSnapshot
  private writeTail: Promise<void> = Promise.resolve()
  private readonly maxFileBytes: number

  constructor(
    private readonly filePath: string,
    options: FileBackedP2TRConfirmedHistoryCursorStoreOptions = {}
  ) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new Error(
        "P2TR confirmed-history cursor file path must be non-empty"
      )
    }

    this.maxFileBytes = normalizeMaxFileBytes(options)
  }

  async loadConfirmedHistoryCursor(
    address: string
  ): Promise<P2TRConfirmedHistoryCursor | undefined> {
    const normalizedAddress = normalizeAddress(address)
    await this.writeTail
    const state = await this.loadState()
    const cursor = state.wallets[normalizedAddress]

    return cursor === undefined ? undefined : cloneCursor(cursor)
  }

  saveConfirmedHistoryCursor(
    address: string,
    cursor: P2TRConfirmedHistoryCursor
  ): Promise<void> {
    const normalizedAddress = normalizeAddress(address)
    const normalizedCursor = normalizeCursor(cursor)
    const operation = async () => {
      const state = await this.loadState()
      await this.assertFileUnchanged()
      const nextState: P2TRConfirmedHistoryCursorFile = {
        ...state,
        wallets: {
          ...state.wallets,
          [normalizedAddress]: normalizedCursor,
        },
      }
      const { serialized, snapshotContents } = this.serializeState(nextState)
      await writeFileAtomically(this.filePath, serialized)
      this.state = nextState
      this.snapshot = { exists: true, contents: snapshotContents }
    }

    const result = this.writeTail.then(operation)
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async loadTaprootDepositBindingInventory(): Promise<
    P2TRTaprootDepositBindingInventory | undefined
  > {
    await this.writeTail
    const state = await this.loadState()
    return state.taprootDepositBindingInventory === undefined
      ? undefined
      : cloneTaprootDepositBindingInventory(
          state.taprootDepositBindingInventory
        )
  }

  saveTaprootDepositBindingInventory(
    inventory: P2TRTaprootDepositBindingInventory
  ): Promise<void> {
    const normalizedInventory =
      normalizeTaprootDepositBindingInventory(inventory)
    return this.enqueueStateWrite((state) => ({
      ...state,
      taprootDepositBindingInventory: normalizedInventory,
    }))
  }

  private enqueueStateWrite(
    update: (
      state: P2TRConfirmedHistoryCursorFile
    ) => P2TRConfirmedHistoryCursorFile
  ): Promise<void> {
    const operation = async () => {
      const state = await this.loadState()
      await this.assertFileUnchanged()
      const nextState = update(state)
      const { serialized, snapshotContents } = this.serializeState(nextState)
      await writeFileAtomically(this.filePath, serialized)
      this.state = nextState
      this.snapshot = { exists: true, contents: snapshotContents }
    }

    const result = this.writeTail.then(operation)
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async loadState(): Promise<P2TRConfirmedHistoryCursorFile> {
    if (this.state !== undefined) {
      return this.state
    }

    let contents: Buffer
    try {
      contents = await this.readFileBounded()
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.state = { version: 1, wallets: {} }
        this.snapshot = { exists: false }
        return this.state
      }
      throw error
    }

    this.state = normalizeFile(JSON.parse(contents.toString("utf8")) as unknown)
    this.snapshot = { exists: true, contents }
    return this.state
  }

  private async assertFileUnchanged(): Promise<void> {
    if (this.snapshot === undefined) {
      return
    }

    let contents: Buffer
    try {
      contents = await this.readFileBounded()
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        if (!this.snapshot.exists) {
          return
        }
        throw new Error(
          "P2TR confirmed-history cursor file changed since the last load"
        )
      }
      throw error
    }

    if (!this.snapshot.exists || !contents.equals(this.snapshot.contents)) {
      throw new Error(
        "P2TR confirmed-history cursor file changed since the last load"
      )
    }
  }

  private async readFileBounded(): Promise<Buffer> {
    const file = await fs.open(this.filePath, "r")
    try {
      // The sentinel byte distinguishes an exact-bound file followed by EOF
      // from an oversized file without trusting a separately sampled stat.
      const contents = Buffer.allocUnsafe(this.maxFileBytes + 1)
      let offset = 0
      while (offset < contents.length) {
        const { bytesRead } = await file.read(
          contents,
          offset,
          contents.length - offset,
          null
        )
        if (bytesRead === 0) {
          break
        }
        offset += bytesRead
      }

      if (offset > this.maxFileBytes) {
        throw this.fileSizeBoundError()
      }

      // Copy only bytes read so the snapshot does not retain the full
      // fixed-size read allocation for a small state file.
      return Buffer.from(contents.subarray(0, offset))
    } finally {
      await file.close()
    }
  }

  private serializeState(state: P2TRConfirmedHistoryCursorFile): {
    serialized: string
    snapshotContents: Buffer
  } {
    const serialized = `${JSON.stringify(state, null, 2)}\n`
    if (Buffer.byteLength(serialized, "utf8") > this.maxFileBytes) {
      throw this.fileSizeBoundError()
    }

    return {
      serialized,
      snapshotContents: Buffer.from(serialized, "utf8"),
    }
  }

  private fileSizeBoundError(): Error {
    return new Error(
      `P2TR confirmed-history cursor file exceeds configured ${this.maxFileBytes}-byte bound`
    )
  }
}

function normalizeMaxFileBytes(
  options: FileBackedP2TRConfirmedHistoryCursorStoreOptions
): number {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new Error(
      "P2TR confirmed-history cursor store options must be an object"
    )
  }

  const maxFileBytes =
    options.maxFileBytes ?? DEFAULT_P2TR_CONFIRMED_HISTORY_CURSOR_MAX_FILE_BYTES
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes <= 0 ||
    maxFileBytes > MAXIMUM_P2TR_CONFIRMED_HISTORY_CURSOR_MAX_FILE_BYTES
  ) {
    throw new Error(
      `P2TR confirmed-history cursor maxFileBytes must be a positive safe integer no greater than ${MAXIMUM_P2TR_CONFIRMED_HISTORY_CURSOR_MAX_FILE_BYTES}`
    )
  }

  return maxFileBytes
}

function normalizeFile(value: unknown): P2TRConfirmedHistoryCursorFile {
  const record = requireRecord(value, "cursor file")
  if (record.version !== 1) {
    throw new Error("P2TR confirmed-history cursor file version must be 1")
  }

  const walletRecords = requireRecord(record.wallets, "cursor file wallets")
  const wallets: Record<string, P2TRConfirmedHistoryCursor> = {}
  for (const [address, cursor] of Object.entries(walletRecords)) {
    wallets[normalizeAddress(address)] = normalizeCursor(cursor)
  }

  const taprootDepositBindingInventory =
    record.taprootDepositBindingInventory === undefined
      ? undefined
      : normalizeTaprootDepositBindingInventory(
          record.taprootDepositBindingInventory
        )

  return {
    version: 1,
    wallets,
    ...(taprootDepositBindingInventory === undefined
      ? {}
      : { taprootDepositBindingInventory }),
  }
}

function normalizeTaprootDepositBindingInventory(
  value: unknown
): P2TRTaprootDepositBindingInventory {
  const record = requireRecord(value, "Taproot deposit binding inventory")
  const configurationFingerprint = record.configurationFingerprint
  if (
    typeof configurationFingerprint !== "string" ||
    configurationFingerprint.length === 0
  ) {
    throw new Error(
      "P2TR confirmed-history Taproot deposit binding inventory configuration fingerprint must be non-empty"
    )
  }
  const lastScannedBlock = normalizeNonNegativeInteger(
    record.lastScannedBlock,
    "Taproot deposit binding inventory last scanned block"
  )
  const lastScannedBlockHash = normalizeTxid(
    record.lastScannedBlockHash,
    "Taproot deposit binding inventory last scanned block hash"
  )
  if (!Array.isArray(record.bindings)) {
    throw new Error(
      "P2TR confirmed-history Taproot deposit binding inventory bindings must be an array"
    )
  }

  const bindings = record.bindings.map<P2TRTaprootDepositBindingInventoryEntry>(
    (value, index) => {
      const binding = requireRecord(
        value,
        `Taproot deposit binding inventory binding[${index}]`
      )
      const fundingOutputIndex = normalizeNonNegativeInteger(
        binding.fundingOutputIndex,
        `Taproot deposit binding inventory binding[${index}] funding output index`
      )
      if (fundingOutputIndex > 0xffffffff) {
        throw new Error(
          `P2TR confirmed-history Taproot deposit binding inventory binding[${index}] funding output index must fit uint32`
        )
      }

      const spendStatus = binding.spendStatus
      if (spendStatus !== "active" && spendStatus !== "confirmed-spent") {
        throw new Error(
          `P2TR confirmed-history Taproot deposit binding inventory binding[${index}] spend status is invalid`
        )
      }
      const confirmedSpendingTxid =
        binding.confirmedSpendingTxid === undefined
          ? undefined
          : normalizeTxid(
              binding.confirmedSpendingTxid,
              `Taproot deposit binding inventory binding[${index}] confirmed spending txid`
            )
      if (
        (spendStatus === "confirmed-spent") !==
        (confirmedSpendingTxid !== undefined)
      ) {
        throw new Error(
          `P2TR confirmed-history Taproot deposit binding inventory binding[${index}] confirmed spending txid must be present exactly when confirmed-spent`
        )
      }

      return {
        blockNumber: normalizeNonNegativeInteger(
          binding.blockNumber,
          `Taproot deposit binding inventory binding[${index}] block number`
        ),
        blockHash: normalizeTxid(
          binding.blockHash,
          `Taproot deposit binding inventory binding[${index}] block hash`
        ),
        fundingTxid: normalizeTxid(
          binding.fundingTxid,
          `Taproot deposit binding inventory binding[${index}] funding txid`
        ),
        fundingOutputIndex,
        outputKey: normalizeTxid(
          binding.outputKey,
          `Taproot deposit binding inventory binding[${index}] output key`
        ),
        walletID: normalizeTxid(
          binding.walletID,
          `Taproot deposit binding inventory binding[${index}] wallet ID`
        ),
        spendStatus,
        ...(confirmedSpendingTxid === undefined
          ? {}
          : { confirmedSpendingTxid }),
      }
    }
  )
  const bindingKeys = bindings.map(
    ({ fundingTxid, fundingOutputIndex }) =>
      `${fundingTxid}:${fundingOutputIndex}`
  )
  if (new Set(bindingKeys).size !== bindingKeys.length) {
    throw new Error(
      "P2TR confirmed-history Taproot deposit binding inventory contains duplicate outpoints"
    )
  }

  let outspendSweep: P2TRTaprootDepositBindingInventory["outspendSweep"]
  if (record.outspendSweep !== undefined) {
    const sweep = requireRecord(
      record.outspendSweep,
      "Taproot deposit binding inventory outspend sweep"
    )
    const anchorBindingKey = normalizeBindingOrderingKey(
      sweep.anchorBindingKey,
      "outspend sweep anchor binding key"
    )
    const afterBindingKey = normalizeBindingOrderingKey(
      sweep.afterBindingKey,
      "outspend sweep after binding key"
    )
    if (afterBindingKey >= anchorBindingKey) {
      throw new Error(
        "P2TR confirmed-history Taproot deposit binding inventory outspend sweep boundary must precede its anchor"
      )
    }
    const knownBindingKeys = new Set(bindings.map(bindingOrderingKey))
    if (
      !knownBindingKeys.has(anchorBindingKey) ||
      !knownBindingKeys.has(afterBindingKey)
    ) {
      throw new Error(
        "P2TR confirmed-history Taproot deposit binding inventory outspend sweep references an unknown binding"
      )
    }
    outspendSweep = { anchorBindingKey, afterBindingKey }
  }

  return {
    configurationFingerprint,
    lastScannedBlock,
    lastScannedBlockHash,
    bindings,
    ...(outspendSweep === undefined ? {} : { outspendSweep }),
  }
}

function bindingOrderingKey(
  binding: Pick<
    P2TRTaprootDepositBindingInventoryEntry,
    "blockNumber" | "fundingTxid" | "fundingOutputIndex"
  >
): string {
  return `${binding.blockNumber.toString(16).padStart(16, "0")}:${
    binding.fundingTxid
  }:${binding.fundingOutputIndex.toString(16).padStart(8, "0")}`
}

function normalizeBindingOrderingKey(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{16}:[0-9a-f]{64}:[0-9a-f]{8}$/.test(value)
  ) {
    throw new Error(`P2TR confirmed-history ${label} is invalid`)
  }
  return value
}

function normalizeNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`P2TR confirmed-history ${label} must be non-negative`)
  }
  return value
}

function normalizeCursor(value: unknown): P2TRConfirmedHistoryCursor {
  const record = requireRecord(value, "cursor")
  const anchor =
    record.anchor === undefined
      ? undefined
      : normalizeTransaction(record.anchor, "anchor")

  let catchUp: P2TRConfirmedHistoryCursor["catchUp"]
  if (record.catchUp !== undefined) {
    const catchUpRecord = requireRecord(record.catchUp, "catch-up cursor")
    const headAnchor = normalizeTransaction(
      catchUpRecord.headAnchor,
      "catch-up head anchor"
    )
    const after = normalizeTransaction(
      catchUpRecord.after,
      "catch-up after transaction"
    )
    if (after.blockHeight > headAnchor.blockHeight) {
      throw new Error(
        "P2TR confirmed-history catch-up boundary cannot be newer than its head anchor"
      )
    }
    catchUp = { headAnchor, after }
  }

  return {
    ...(anchor === undefined ? {} : { anchor }),
    ...(catchUp === undefined ? {} : { catchUp }),
  }
}

function normalizeTransaction(
  value: unknown,
  label: string
): P2TRConfirmedHistoryTransaction {
  const record = requireRecord(value, label)
  const blockHeight = record.blockHeight
  if (
    typeof blockHeight !== "number" ||
    !Number.isSafeInteger(blockHeight) ||
    blockHeight <= 0
  ) {
    throw new Error(
      `P2TR confirmed-history ${label} blockHeight must be a positive integer`
    )
  }

  return {
    txid: normalizeTxid(record.txid, `${label} txid`),
    blockHash: normalizeTxid(record.blockHash, `${label} block hash`),
    blockHeight,
  }
}

function normalizeTxid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`P2TR confirmed-history ${label} must be 32-byte hex`)
  }
  return value.toLowerCase()
}

function normalizeAddress(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("P2TR confirmed-history wallet address must be non-empty")
  }
  return value.trim().toLowerCase()
}

function cloneCursor(
  cursor: P2TRConfirmedHistoryCursor
): P2TRConfirmedHistoryCursor {
  return {
    ...(cursor.anchor === undefined ? {} : { anchor: { ...cursor.anchor } }),
    ...(cursor.catchUp === undefined
      ? {}
      : {
          catchUp: {
            headAnchor: { ...cursor.catchUp.headAnchor },
            after: { ...cursor.catchUp.after },
          },
        }),
  }
}

function cloneTaprootDepositBindingInventory(
  inventory: P2TRTaprootDepositBindingInventory
): P2TRTaprootDepositBindingInventory {
  return {
    ...inventory,
    bindings: inventory.bindings.map((binding) => ({ ...binding })),
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`P2TR confirmed-history ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
