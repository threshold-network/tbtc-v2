import { ethers } from "ethers"
import {
  CanonicalHistoryScan,
  canonicalHistoryCheckpointCommitment,
} from "./ecdsa-fraud-router-canonical-history"
import {
  DurableWriteOptions,
  DurableWriteFailpoint,
  artifactContentHash,
  durableWriteJson,
  readPrivateJson,
} from "./durable-artifact"

export type CanonicalHistoryJournalCheckpoint = {
  finalizedBlock: number
  finalizedBlockHash: string
  checkpointCommitment: string
}

export type CanonicalHistoryJournalFile = {
  version: 4
  sourceId: string
  storageIdentity: string
  contentHash: string
  scanContentHash: string
  lineage: CanonicalHistoryJournalCheckpoint[]
  scan: CanonicalHistoryScan
}

export function normalizeDurableStoreIdentity(identity: string): string {
  if (
    !ethers.utils.isHexString(identity, 32) ||
    ethers.BigNumber.from(identity).isZero()
  ) {
    throw new Error("durable store identity must be a nonzero bytes32 UUID")
  }
  return ethers.utils.hexZeroPad(identity, 32)
}

function checkpoint(
  scan: CanonicalHistoryScan
): CanonicalHistoryJournalCheckpoint {
  return {
    finalizedBlock: scan.evidence.finalizedBlock,
    finalizedBlockHash: scan.evidence.finalizedBlockHash,
    checkpointCommitment: canonicalHistoryCheckpointCommitment(scan),
  }
}

function journalContentHash(
  journal: Omit<CanonicalHistoryJournalFile, "contentHash">
): string {
  return artifactContentHash(JSON.stringify(journal))
}

export function validateCanonicalHistoryJournal(
  journal: CanonicalHistoryJournalFile,
  expectedSourceId: string,
  expectedStorageIdentity: string
): void {
  const normalizedStoreIdentity = normalizeDurableStoreIdentity(
    expectedStorageIdentity
  )
  const expectedContentHash = journalContentHash({
    version: journal.version,
    sourceId: journal.sourceId,
    storageIdentity: journal.storageIdentity,
    scanContentHash: journal.scanContentHash,
    lineage: journal.lineage,
    scan: journal.scan,
  })
  if (
    journal.version !== 4 ||
    journal.sourceId.toLowerCase() !== expectedSourceId.toLowerCase() ||
    journal.storageIdentity.toLowerCase() !==
      normalizedStoreIdentity.toLowerCase() ||
    journal.scanContentHash.toLowerCase() !==
      canonicalHistoryCheckpointCommitment(journal.scan).toLowerCase() ||
    journal.contentHash !== expectedContentHash
  ) {
    throw new Error("canonical history journal identity/content mismatch")
  }
  let previousBlock = -1
  const seen = new Set<string>()
  journal.lineage.forEach((entry) => {
    const identity = `${
      entry.finalizedBlock
    }:${entry.finalizedBlockHash.toLowerCase()}:${entry.checkpointCommitment.toLowerCase()}`
    if (
      !Number.isSafeInteger(entry.finalizedBlock) ||
      entry.finalizedBlock < 0 ||
      entry.finalizedBlock <= previousBlock ||
      !ethers.utils.isHexString(entry.finalizedBlockHash, 32) ||
      !ethers.utils.isHexString(entry.checkpointCommitment, 32) ||
      seen.has(identity)
    ) {
      throw new Error("canonical history journal lineage is malformed")
    }
    previousBlock = entry.finalizedBlock
    seen.add(identity)
  })
  if (previousBlock >= journal.scan.evidence.finalizedBlock) {
    throw new Error("canonical history journal lineage is not a strict prefix")
  }
}

export function loadCanonicalHistoryJournal(
  file: string,
  expectedSourceId: string,
  expectedStorageIdentity: string
): CanonicalHistoryJournalFile {
  const journal = readPrivateJson<CanonicalHistoryJournalFile>(file)
  validateCanonicalHistoryJournal(
    journal,
    expectedSourceId,
    expectedStorageIdentity
  )
  return journal
}

export function nextCanonicalHistoryJournal(
  sourceId: string,
  storageIdentity: string,
  scan: CanonicalHistoryScan,
  previous?: CanonicalHistoryJournalFile
): CanonicalHistoryJournalFile {
  const scanContentHash = canonicalHistoryCheckpointCommitment(scan)
  let lineage: CanonicalHistoryJournalCheckpoint[] = []
  if (previous) {
    lineage = [...previous.lineage]
    if (
      previous.scanContentHash.toLowerCase() !== scanContentHash.toLowerCase()
    ) {
      lineage.push(checkpoint(previous.scan))
    }
  }
  const unsignedJournal: Omit<CanonicalHistoryJournalFile, "contentHash"> = {
    version: 4,
    sourceId: ethers.utils.hexZeroPad(sourceId, 32),
    storageIdentity: normalizeDurableStoreIdentity(storageIdentity),
    scanContentHash,
    lineage,
    scan,
  }
  const journal: CanonicalHistoryJournalFile = {
    ...unsignedJournal,
    contentHash: journalContentHash(unsignedJournal),
  }
  validateCanonicalHistoryJournal(
    journal,
    journal.sourceId,
    journal.storageIdentity
  )
  return journal
}

export function saveCanonicalHistoryJournal(
  file: string,
  journal: CanonicalHistoryJournalFile,
  options: DurableWriteOptions | DurableWriteFailpoint = {}
): string {
  validateCanonicalHistoryJournal(
    journal,
    journal.sourceId,
    journal.storageIdentity
  )
  const normalizedOptions: DurableWriteOptions =
    typeof options === "function" ? { failpoint: options } : options
  return durableWriteJson(file, journal, normalizedOptions)
}

export function canonicalHistoryJournalContains(
  journal: CanonicalHistoryJournalFile,
  finalizedBlock: number,
  finalizedBlockHash: string,
  checkpointCommitment: string
): boolean {
  const entries = [...journal.lineage, checkpoint(journal.scan)]
  return entries.some(
    (entry) =>
      entry.finalizedBlock === finalizedBlock &&
      entry.finalizedBlockHash.toLowerCase() ===
        finalizedBlockHash.toLowerCase() &&
      entry.checkpointCommitment.toLowerCase() ===
        checkpointCommitment.toLowerCase()
  )
}
