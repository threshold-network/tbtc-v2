import fs from "fs"
import { ethers } from "hardhat"
import {
  CanonicalHistoryScan,
  discoverHistoryEmitters,
  extendCanonicalHistoryJournal,
} from "./ecdsa-fraud-router-cutover-lib"
import {
  CanonicalHistoryJournalFile,
  loadCanonicalHistoryJournal,
  nextCanonicalHistoryJournal,
  normalizeDurableStoreIdentity,
  saveCanonicalHistoryJournal,
} from "./ecdsa-fraud-router-journal-store"
import {
  assertIndependentArtifactStores,
  readPrivateFileWithHash,
} from "./durable-artifact"

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  const bridge = ethers.utils.getAddress(required("ECDSA_CUTOVER_BRIDGE"))
  const oldRouter = ethers.utils.getAddress(
    required("ECDSA_CUTOVER_OLD_ROUTER")
  )
  const scanStartBlock = Number(
    required("ECDSA_CUTOVER_BRIDGE_DEPLOYMENT_BLOCK")
  )
  if (!Number.isSafeInteger(scanStartBlock) || scanStartBlock < 0) {
    throw new Error("ECDSA_CUTOVER_BRIDGE_DEPLOYMENT_BLOCK is invalid")
  }
  const sourceId = ethers.utils.hexZeroPad(
    required("ECDSA_CUTOVER_LOCAL_SOURCE_ID"),
    32
  )
  if (sourceId === ethers.constants.HashZero) {
    throw new Error("ECDSA_CUTOVER_LOCAL_SOURCE_ID cannot be zero")
  }
  const journalPath = required("ECDSA_CUTOVER_HISTORY_JOURNAL")
  const storageIdentity = normalizeDurableStoreIdentity(
    required("ECDSA_CUTOVER_LOCAL_DURABLE_STORE_IDENTITY")
  )
  const counterpartPath = process.env.ECDSA_CUTOVER_COUNTERPART_JOURNAL
  if (counterpartPath) {
    assertIndependentArtifactStores(journalPath, counterpartPath)
  }
  const batchSize = Number(process.env.ECDSA_CUTOVER_JOURNAL_BATCH_SIZE ?? "64")
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("ECDSA_CUTOVER_JOURNAL_BATCH_SIZE is invalid")
  }
  let expectedBalances: Record<string, string>
  try {
    expectedBalances = JSON.parse(
      required("ECDSA_CUTOVER_EXPECTED_UNRELATED_EMITTER_BALANCES")
    )
  } catch (_) {
    throw new Error(
      "ECDSA_CUTOVER_EXPECTED_UNRELATED_EMITTER_BALANCES must be JSON"
    )
  }
  const emitters = await discoverHistoryEmitters(
    ethers.provider,
    bridge,
    oldRouter,
    expectedBalances
  )
  let checkpoint: CanonicalHistoryScan | undefined
  let previous: CanonicalHistoryJournalFile | undefined
  let previousFileContentHash: string | undefined
  if (fs.existsSync(journalPath)) {
    previousFileContentHash = readPrivateFileWithHash(journalPath).contentHash
    previous = loadCanonicalHistoryJournal(
      journalPath,
      sourceId,
      storageIdentity
    )
    checkpoint = previous.scan
  }
  const finalizedHead = (await ethers.provider.getBlockNumber()) - 64
  if (finalizedHead < scanStartBlock) {
    throw new Error("Bridge history is not yet 64 blocks finalized")
  }
  const nextBlock = checkpoint
    ? checkpoint.evidence.finalizedBlock + 1
    : scanStartBlock
  const target = Math.min(finalizedHead, nextBlock + batchSize - 1)
  const scan = await extendCanonicalHistoryJournal(
    ethers.provider,
    emitters,
    scanStartBlock,
    target,
    checkpoint
  )
  saveCanonicalHistoryJournal(
    journalPath,
    nextCanonicalHistoryJournal(sourceId, storageIdentity, scan, previous),
    previousFileContentHash
      ? { expectedCurrentContentHash: previousFileContentHash }
      : { createOnly: true }
  )
  console.log(
    `canonical history journal ${sourceId} advanced through block ${target}`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
