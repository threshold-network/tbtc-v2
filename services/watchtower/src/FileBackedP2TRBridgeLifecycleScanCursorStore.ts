import { promises as fs } from "fs"

import type {
  P2TRBridgeLifecycleScanCursor,
  P2TRBridgeLifecycleScanCursorStore,
} from "./EthersP2TRSignatureFraudBridgeLifecycleEventSource.js"
import { writeFileAtomically } from "./AtomicFile.js"

export class FileBackedP2TRBridgeLifecycleScanCursorStore
  implements P2TRBridgeLifecycleScanCursorStore
{
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "single-process-rehearsal" as const

  private lastLoadedState?: FileBackedP2TRBridgeLifecycleCursorSnapshot

  constructor(private readonly filePath: string) {}

  async loadBridgeLifecycleScanCursor(): Promise<
    P2TRBridgeLifecycleScanCursor | undefined
  > {
    let rawCursor: string

    try {
      rawCursor = await fs.readFile(this.filePath, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.lastLoadedState = { exists: false }
        return undefined
      }

      throw error
    }

    const cursor = normalizeCursor(JSON.parse(rawCursor) as unknown)
    this.lastLoadedState = { exists: true, contents: rawCursor }

    return cursor
  }

  async saveBridgeLifecycleScanCursor(
    cursor: P2TRBridgeLifecycleScanCursor
  ): Promise<void> {
    const normalizedCursor = normalizeCursor(cursor)
    const serializedCursor = `${JSON.stringify(normalizedCursor, null, 2)}\n`
    await this.assertCursorFileUnchangedSinceLoad()

    await writeFileAtomically(this.filePath, serializedCursor)
    this.lastLoadedState = { exists: true, contents: serializedCursor }
  }

  private async assertCursorFileUnchangedSinceLoad(): Promise<void> {
    if (this.lastLoadedState === undefined) {
      return
    }

    let currentContents: string
    try {
      currentContents = await fs.readFile(this.filePath, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        if (!this.lastLoadedState.exists) {
          return
        }

        throw new Error(
          "P2TR Bridge lifecycle scan cursor file changed since the last load"
        )
      }

      throw error
    }

    if (
      !this.lastLoadedState.exists ||
      currentContents !== this.lastLoadedState.contents
    ) {
      throw new Error(
        "P2TR Bridge lifecycle scan cursor file changed since the last load"
      )
    }
  }
}

type FileBackedP2TRBridgeLifecycleCursorSnapshot =
  | {
      exists: false
    }
  | {
      exists: true
      contents: string
    }

function normalizeCursor(cursor: unknown): P2TRBridgeLifecycleScanCursor {
  if (!isRecordObject(cursor)) {
    throw new Error("P2TR Bridge lifecycle scan cursor must be an object")
  }

  const lastScannedBlock = cursor.lastScannedBlock
  const lastScannedBlockHash = cursor.lastScannedBlockHash

  if (
    typeof lastScannedBlock !== "number" ||
    !Number.isInteger(lastScannedBlock) ||
    lastScannedBlock < 0
  ) {
    throw new Error(
      "P2TR Bridge lifecycle scan cursor lastScannedBlock must be a non-negative integer"
    )
  }

  if (lastScannedBlockHash === undefined) {
    return { lastScannedBlock }
  }

  if (
    typeof lastScannedBlockHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(lastScannedBlockHash)
  ) {
    throw new Error(
      "P2TR Bridge lifecycle scan cursor lastScannedBlockHash must be a 32-byte hex string"
    )
  }

  return {
    lastScannedBlock,
    lastScannedBlockHash: lastScannedBlockHash.toLowerCase(),
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function isRecordObject(record: unknown): record is Record<string, unknown> {
  return typeof record === "object" && record !== null && !Array.isArray(record)
}
