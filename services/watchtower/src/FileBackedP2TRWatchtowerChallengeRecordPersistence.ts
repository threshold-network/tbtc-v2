import { promises as fs } from "fs"

import {
  deserializeP2TRWatchtowerChallengeRecord,
  serializeP2TRWatchtowerChallengeRecord,
} from "@keep-network/tbtc-v2.ts"
import type {
  P2TRWatchtowerChallengeRecordJSON,
  P2TRWatchtowerChallengeRecordPersistence,
} from "@keep-network/tbtc-v2.ts"

import { writeFileAtomically } from "./AtomicFile.js"

export class FileBackedP2TRWatchtowerChallengeRecordPersistence
  implements P2TRWatchtowerChallengeRecordPersistence
{
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "single-process-rehearsal" as const

  private lastLoadedState?: FileBackedP2TRWatchtowerStateSnapshot

  constructor(private readonly filePath: string) {}

  async loadChallengeRecords(): Promise<P2TRWatchtowerChallengeRecordJSON[]> {
    let rawRecords: string

    try {
      rawRecords = await fs.readFile(this.filePath, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.lastLoadedState = { exists: false }
        return []
      }

      throw error
    }

    // A truncated or externally-corrupted state file must fail closed with a
    // message that names the file, rather than surfacing an opaque
    // `SyntaxError: Unexpected token` from deep inside the load path.
    let records: unknown
    try {
      records = JSON.parse(rawRecords) as unknown
    } catch (error) {
      throw new Error(
        `P2TR watchtower state file ${this.filePath} is not valid JSON ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          `Restore it from a backup or remove it to start from an empty state.`
      )
    }

    if (!Array.isArray(records)) {
      throw new Error("P2TR watchtower state file must contain an array")
    }

    const normalizedRecords = records.map(normalizeSerializedRecord)
    this.lastLoadedState = { exists: true, contents: rawRecords }

    return normalizedRecords
  }

  async saveChallengeRecords(
    records: P2TRWatchtowerChallengeRecordJSON[]
  ): Promise<void> {
    const normalizedRecords = records.map(normalizeSerializedRecord)
    const serializedRecords = `${JSON.stringify(normalizedRecords, null, 2)}\n`
    await this.assertStateFileUnchangedSinceLoad()

    await writeFileAtomically(this.filePath, serializedRecords)
    this.lastLoadedState = { exists: true, contents: serializedRecords }
  }

  /**
   * Best-effort staleness detection, NOT mutual exclusion: the read below and
   * the rename in `saveChallengeRecords` are not atomic with respect to each
   * other, so a concurrent writer landing between them is still not caught.
   * It exists to turn the common case of an externally-modified state file
   * into a loud error instead of a silent overwrite.
   *
   * Single-writer safety comes from the single-process profile marker and
   * `requireSubmissionIndexingStoreProfile` gating, not from this check. Do not
   * treat it as a lock or use it to justify running concurrent watchtowers.
   */
  private async assertStateFileUnchangedSinceLoad(): Promise<void> {
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
          "P2TR watchtower state file changed since the last load"
        )
      }

      throw error
    }

    if (
      !this.lastLoadedState.exists ||
      currentContents !== this.lastLoadedState.contents
    ) {
      throw new Error("P2TR watchtower state file changed since the last load")
    }
  }
}

type FileBackedP2TRWatchtowerStateSnapshot =
  | {
      exists: false
    }
  | {
      exists: true
      contents: string
    }

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function normalizeSerializedRecord(
  record: unknown,
  index: number
): P2TRWatchtowerChallengeRecordJSON {
  if (!isRecordObject(record)) {
    throw new Error(`P2TR watchtower state record ${index} must be an object`)
  }

  try {
    return serializeP2TRWatchtowerChallengeRecord(
      deserializeP2TRWatchtowerChallengeRecord(
        record as P2TRWatchtowerChallengeRecordJSON
      )
    )
  } catch (error) {
    throw new Error(
      `P2TR watchtower state record ${index} is invalid: ${errorMessage(error)}`
    )
  }
}

function isRecordObject(record: unknown): record is Record<string, unknown> {
  return typeof record === "object" && record !== null && !Array.isArray(record)
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : String(error)
}
