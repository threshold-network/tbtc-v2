import { createHash } from "node:crypto"
import {
  computeP2TREthereumRpcBlockHash,
  computeP2TREthereumTrieRoot,
  hashP2TREthereumSerializedEnvelope,
  serializeP2TREthereumRpcReceipt,
} from "./EthereumCanonicalHeaderProof.js"

export const P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS = [
  "frost-wallet-registered",
  "taproot-deposit-revealed",
  "deposits-swept",
  "redemptions-completed",
  "moving-funds-completed",
  "moved-funds-swept",
  "p2tr-challenge-submitted",
  "p2tr-challenge-defeated",
  "p2tr-challenge-timed-out",
  "p2tr-challenge-migrated",
  "legacy-fraud-challenge-migrated",
  "p2tr-authorization-registered",
  "p2tr-reservation-authorized",
  "p2tr-reservation-settled",
  "p2tr-reservation-conflicted",
  "wallet-moving-funds",
  "wallet-closing",
  "wallet-closed",
  "wallet-terminated",
  "wallet-quarantined",
  "redemption-requested",
  "redemption-timed-out",
  "redemption-objection-raised",
  "redemption-veto-finalized",
  "redemption-veto-check-omitted",
  "redemption-watchtower-enabled",
  "redemption-watchtower-disabled",
  "redemption-watchtower-parameters-updated",
  "moving-funds-commitment-submitted",
  "moving-funds-timeout-reset",
  "moving-funds-timed-out",
  "moving-funds-below-dust",
  "moved-funds-sweep-timed-out",
  "p2tr-router-activated",
  "bridge-frost-registry-set",
  "bridge-ecdsa-router-set",
  "bridge-p2tr-router-set",
  "bridge-lifecycle-router-set",
  "bridge-ecdsa-retired",
  "deposit-parameters-updated",
  "redemption-parameters-updated",
  "moving-funds-parameters-updated",
  "wallet-parameters-updated",
  "fraud-parameters-updated",
  "redemption-watchtower-set",
  "ecdsa-router-drain-started",
  "ecdsa-router-inventory-staged",
  "ecdsa-router-inventory-confirmed",
  "ecdsa-router-migration-executed",
  "ecdsa-router-migration-confirmed",
  "ecdsa-router-cutover-finalized",
  "ecdsa-fraud-reconciler-update-started",
  "ecdsa-fraud-reconciler-updated",
  "ecdsa-migrated-challenges-activated",
] as const

export type P2TRCanonicalEthereumEventKind =
  (typeof P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS)[number]

export type P2TRCanonicalEthereumChainPoint = {
  blockNumber: number
  blockHash: string
}

export type P2TRCanonicalEthereumBlock = P2TRCanonicalEthereumChainPoint & {
  parentHash: string
  timestamp: number
  transactionsRoot: string
  receiptsRoot: string
  /** Full fork-aware header fields used to recompute `blockHash`. */
  canonicalHeader: Readonly<Record<string, unknown>>
  /** Exact canonical transaction order used to prove complete receipt coverage. */
  transactionHashes: readonly string[]
  /** Exact EIP-2718/RLP transaction envelopes in the same order. */
  serializedTransactions: readonly string[]
}

export type P2TRCanonicalEthereumRawLog = {
  address: string
  blockHash: string
  blockNumber: number
  transactionHash: string
  transactionIndex: number
  logIndex: number
  data: string
  topics: readonly string[]
  removed?: boolean
}

export type P2TRCanonicalEthereumReceipt = {
  type: number
  status: number
  cumulativeGasUsed: string
  logsBloom: string
  blockHash: string
  blockNumber: number
  transactionHash: string
  transactionIndex: number
  logs: readonly P2TRCanonicalEthereumRawLog[]
}

export type P2TRCanonicalEthereumBlockCoverage = {
  blockNumber: number
  blockHash: string
  /** Roots independently reconstructed and matched to the canonical header. */
  transactionsRoot: string
  receiptsRoot: string
  transactionDigest: string
  transactionCount: number
  receiptDigest: string
  receiptCount: number
  logDigest: string
  logCount: number
  requiredEventDigest: string
  requiredEventCount: number
}

export type P2TRCanonicalEthereumProvider = {
  readonly trustDomainID: string
  readonly providerIdentity: object
  getChainID(): Promise<number>
  getBlockNumber(): Promise<number>
  getBlock(
    blockNumber: number
  ): Promise<P2TRCanonicalEthereumBlock | null | undefined>
  getLogs(filter: {
    address: string
    topics: readonly string[]
    fromBlock: number
    toBlock: number
  }): Promise<readonly P2TRCanonicalEthereumRawLog[]>
  getTransactionReceipt(
    transactionHash: string
  ): Promise<P2TRCanonicalEthereumReceipt | null | undefined>
}

export type P2TRCanonicalEthereumEventDescriptor = {
  kind: P2TRCanonicalEthereumEventKind
  emitter: string
  topic0: string
  /** Versioned decoder semantics, pinned by the activation manifest hash. */
  decoderSchemaID: string
  /** Build-generated SHA-256 of the exact decoder implementation. */
  decoderCodeHash: string
  decode(
    log: Readonly<P2TRCanonicalEthereumRawLog>
  ): Readonly<Record<string, unknown>>
}

export type P2TRCanonicalEthereumEvent = {
  eventID: string
  kind: P2TRCanonicalEthereumEventKind
  decoderSchemaID: string
  decoderCodeHash: string
  log: P2TRCanonicalEthereumRawLog & { removed: false }
  payload: Readonly<Record<string, unknown>>
}

export type P2TRCanonicalEthereumCursor = {
  storeID: string
  chainID: number
  configurationFingerprint: string
  descriptorSetHash: string
  scanStartBlock: number
  checkpoint: P2TRCanonicalEthereumChainPoint
  current: P2TRCanonicalEthereumChainPoint
}

export type P2TRCanonicalEthereumReadinessSnapshot =
  P2TRCanonicalEthereumCursor & {
    generation: number
    root: string
    historyRoot: string
    journalCounts: {
      blocks: number
      coverageBlocks: number
      transactions: number
      receipts: number
      logs: number
      events: number
    }
  }

export type P2TRCanonicalEthereumScan = {
  expectedCursor?: P2TRCanonicalEthereumCursor
  retainedBlock: P2TRCanonicalEthereumBlock
  configurationFingerprint: string
  descriptorSetHash: string
  scanStartBlock: number
  storeID: string
  chainID: number
  checkpoint: P2TRCanonicalEthereumChainPoint
  blocks: readonly P2TRCanonicalEthereumBlock[]
  events: readonly P2TRCanonicalEthereumEvent[]
  blockCoverage: readonly P2TRCanonicalEthereumBlockCoverage[]
}

export type P2TRCanonicalEthereumJournalStore = {
  readonly p2trSignatureFraudWatchtowerStoreProfile: "transactional-production"
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  loadCanonicalEthereumCursor(): Promise<
    P2TRCanonicalEthereumCursor | undefined
  >
  loadCanonicalEthereumBlockHash(blockNumber: number): Promise<string | undefined>
  /** Writer-excluding and transaction-only; held until the coordinator commits. */
  lockCanonicalEthereumReadinessSnapshot(): Promise<
    P2TRCanonicalEthereumReadinessSnapshot | undefined
  >
  applyCanonicalEthereumScan(scan: P2TRCanonicalEthereumScan): Promise<void>
}

/**
 * The projector is a reorg-safe historical evidence cache only. Eligibility
 * for reservation, signing, challenge enqueue, or broadcast must still be
 * established by pinned-block dual-provider contract state reads; callers
 * must never infer current request/wallet/reservation state from this journal.
 */
export type P2TRCanonicalEthereumEvidenceProjector = {
  rollbackCanonicalEthereumEvidenceTo(
    point: P2TRCanonicalEthereumChainPoint
  ): Promise<void>
  applyCanonicalEthereumEvents(
    events: readonly P2TRCanonicalEthereumEvent[]
  ): Promise<void>
}

export type P2TRCanonicalEthereumTransactionCoordinator = {
  readonly p2trSignatureFraudWatchtowerAtomicTransactions: true
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  runInP2TRSignatureFraudWatchtowerTransaction<T>(
    operation: () => Promise<T>
  ): Promise<T>
  assertP2TRSignatureFraudWatchtowerTransactionalParticipants(
    participants: readonly object[]
  ): void
  isP2TRSignatureFraudWatchtowerTransactionActive(): boolean
}

export type P2TRCanonicalEthereumJournalOptions = {
  storeID: string
  chainID: number
  configurationFingerprint: string
  checkpoint: P2TRCanonicalEthereumChainPoint
  /** First block scanned inclusively; must equal checkpoint + 1. */
  scanStartBlock: number
  confirmationDepth: number
  maxBlocksPerScan: number
  maxReorgDepth: number
  maxTransactionsPerScan: number
  maxReceiptLogsPerScan: number
  /** A response at this bound is rejected as potentially provider-truncated. */
  maxLogsPerDescriptorPerScan: number
  maxDecodedPayloadBytes: number
  descriptors: readonly P2TRCanonicalEthereumEventDescriptor[]
}

export type P2TRCanonicalEthereumJournalScanResult = {
  retained: P2TRCanonicalEthereumChainPoint
  current: P2TRCanonicalEthereumChainPoint
  orphanedBlocks: number
  appendedBlocks: number
  appendedEvents: number
}

type NormalizedDescriptor = P2TRCanonicalEthereumEventDescriptor & {
  emitter: string
  topic0: string
  decoderSchemaID: string
}

type NormalizedReceipt = P2TRCanonicalEthereumReceipt & {
  logs: Array<P2TRCanonicalEthereumRawLog & { removed: false }>
}

type VerifiedReceiptCoverage = {
  logs: Array<P2TRCanonicalEthereumRawLog & { removed: false }>
  receiptsByBlock: Map<number, NormalizedReceipt[]>
}

/**
 * Canonical, reorg-aware Ethereum ingestion. Source and verifier providers must
 * be different objects in different declared trust domains. Every configured
 * event range is compared as an exact raw-log set and each verifier log is
 * authenticated against a successful canonical receipt before projection.
 */
export class P2TRCanonicalEthereumJournal {
  private readonly descriptors: readonly NormalizedDescriptor[]
  readonly descriptorSetHash: string

  constructor(
    private readonly source: P2TRCanonicalEthereumProvider,
    private readonly verifier: P2TRCanonicalEthereumProvider,
    private readonly store: P2TRCanonicalEthereumJournalStore,
    private readonly projector: P2TRCanonicalEthereumEvidenceProjector,
    private readonly transactionCoordinator: P2TRCanonicalEthereumTransactionCoordinator,
    private readonly options: P2TRCanonicalEthereumJournalOptions
  ) {
    validateProviderIndependence(source, verifier)
    validateJournalOptions(options)
    if (
      store.p2trSignatureFraudWatchtowerTransactionalStoreID !==
        options.storeID ||
      transactionCoordinator.p2trSignatureFraudWatchtowerTransactionalStoreID !==
        options.storeID
    ) {
      throw new Error(
        "Canonical Ethereum journal, projector transaction, and configured store ID must match"
      )
    }
    transactionCoordinator.assertP2TRSignatureFraudWatchtowerTransactionalParticipants(
      [store, projector]
    )
    this.descriptors = normalizeAndValidateDescriptors(options.descriptors)
    this.descriptorSetHash = computeP2TRCanonicalEthereumDescriptorSetHash(
      this.descriptors
    )
  }

  async scan(): Promise<P2TRCanonicalEthereumJournalScanResult> {
    return this.transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
      () => this.scanInTransaction()
    )
  }

  private async scanInTransaction(): Promise<P2TRCanonicalEthereumJournalScanResult> {
    await this.assertProviderChains()
    const [sourceHead, verifierHead] = await Promise.all([
      this.source.getBlockNumber(),
      this.verifier.getBlockNumber(),
    ])
    const finalizedHead =
      Math.min(
        nonNegativeInteger(sourceHead, "Ethereum source head"),
        nonNegativeInteger(verifierHead, "Ethereum verifier head")
      ) - this.options.confirmationDepth
    if (finalizedHead < this.options.checkpoint.blockNumber) {
      throw new Error(
        "Canonical Ethereum providers have not finalized the configured checkpoint"
      )
    }

    const expectedCursor = await this.store.loadCanonicalEthereumCursor()
    validateCursor(expectedCursor, this.options)
    const retainedBlock = await this.resolveRetainedBlock(expectedCursor)
    const previousHeight =
      expectedCursor?.current.blockNumber ?? this.options.checkpoint.blockNumber
    const orphanedBlocks = Math.max(0, previousHeight - retainedBlock.blockNumber)
    const endBlock = Math.min(
      finalizedHead,
      retainedBlock.blockNumber + this.options.maxBlocksPerScan
    )
    const blocks = await this.loadVerifiedBlockRange(
      retainedBlock,
      retainedBlock.blockNumber + 1,
      endBlock
    )
    const evidence =
      blocks.length === 0
        ? { events: [], blockCoverage: [] }
        : await this.loadVerifiedEventRange(
            blocks[0].blockNumber,
            blocks.at(-1)!.blockNumber,
            blocks
          )

    const scan: P2TRCanonicalEthereumScan = {
      expectedCursor,
      retainedBlock,
      configurationFingerprint: normalizeBytes32(
        this.options.configurationFingerprint,
        "Ethereum journal configuration fingerprint"
      ),
      descriptorSetHash: this.descriptorSetHash,
      scanStartBlock: this.options.scanStartBlock,
      storeID: this.options.storeID,
      chainID: this.options.chainID,
      checkpoint: normalizePoint(this.options.checkpoint, "Ethereum checkpoint"),
      blocks,
      events: evidence.events,
      blockCoverage: evidence.blockCoverage,
    }

    if (orphanedBlocks > 0) {
      await this.projector.rollbackCanonicalEthereumEvidenceTo(retainedBlock)
    }
    await this.store.applyCanonicalEthereumScan(scan)
    await this.projector.applyCanonicalEthereumEvents(evidence.events)

    const current = blocks.at(-1) ?? retainedBlock
    return {
      retained: pointOf(retainedBlock),
      current: pointOf(current),
      orphanedBlocks,
      appendedBlocks: blocks.length,
      appendedEvents: evidence.events.length,
    }
  }

  private async assertProviderChains(): Promise<void> {
    const [sourceChainID, verifierChainID] = await Promise.all([
      this.source.getChainID(),
      this.verifier.getChainID(),
    ])
    if (
      positiveInteger(sourceChainID, "Ethereum source chain ID") !==
        this.options.chainID ||
      positiveInteger(verifierChainID, "Ethereum verifier chain ID") !==
        this.options.chainID
    ) {
      throw new Error("Canonical Ethereum provider chain ID mismatch")
    }
  }

  private async resolveRetainedBlock(
    cursor: P2TRCanonicalEthereumCursor | undefined
  ): Promise<P2TRCanonicalEthereumBlock> {
    if (cursor === undefined) {
      const checkpoint = await this.loadVerifiedBlock(
        this.options.checkpoint.blockNumber
      )
      if (checkpoint.blockHash !== this.options.checkpoint.blockHash) {
        throw new Error("Canonical Ethereum checkpoint hash mismatch")
      }
      return checkpoint
    }

    for (
      let blockNumber = cursor.current.blockNumber, depth = 0;
      blockNumber >= this.options.checkpoint.blockNumber;
      blockNumber--, depth++
    ) {
      if (depth > this.options.maxReorgDepth) {
        throw new Error(
          "Canonical Ethereum reorganization exceeds the configured rollback bound"
        )
      }
      const [storedHash, canonicalBlock] = await Promise.all([
        this.store.loadCanonicalEthereumBlockHash(blockNumber),
        this.loadVerifiedBlock(blockNumber),
      ])
      if (storedHash === undefined) {
        throw new Error(
          `Canonical Ethereum journal is missing retained block ${blockNumber}`
        )
      }
      if (storedHash === canonicalBlock.blockHash) return canonicalBlock
    }
    throw new Error("Canonical Ethereum reorganization crossed the checkpoint")
  }

  private async loadVerifiedBlockRange(
    retained: P2TRCanonicalEthereumBlock,
    fromBlock: number,
    toBlock: number
  ): Promise<P2TRCanonicalEthereumBlock[]> {
    if (toBlock < fromBlock) return []
    const blocks: P2TRCanonicalEthereumBlock[] = []
    let expectedParent = retained.blockHash
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
      const block = await this.loadVerifiedBlock(blockNumber)
      if (block.parentHash !== expectedParent) {
        throw new Error(
          `Canonical Ethereum block ${blockNumber} does not extend the retained journal`
        )
      }
      blocks.push(block)
      expectedParent = block.blockHash
    }
    return blocks
  }

  private async loadVerifiedBlock(
    blockNumber: number
  ): Promise<P2TRCanonicalEthereumBlock> {
    const [sourceBlock, verifierBlock] = await Promise.all([
      this.source.getBlock(blockNumber),
      this.verifier.getBlock(blockNumber),
    ])
    const normalizedSource = normalizeBlock(
      sourceBlock,
      `Ethereum source block ${blockNumber}`
    )
    const normalizedVerifier = normalizeBlock(
      verifierBlock,
      `Ethereum verifier block ${blockNumber}`
    )
    if (
      normalizedSource.blockNumber !== blockNumber ||
      normalizedVerifier.blockNumber !== blockNumber
    ) {
      throw new Error(
        `Independent Ethereum providers returned the wrong block for height ${blockNumber}`
      )
    }
    if (canonicalJSON(normalizedSource) !== canonicalJSON(normalizedVerifier)) {
      throw new Error(
        `Independent Ethereum providers disagree on block ${blockNumber}`
      )
    }
    return normalizedVerifier
  }

  private async loadVerifiedEventRange(
    fromBlock: number,
    toBlock: number,
    blocks: readonly P2TRCanonicalEthereumBlock[]
  ): Promise<{
    events: P2TRCanonicalEthereumEvent[]
    blockCoverage: P2TRCanonicalEthereumBlockCoverage[]
  }> {
    const blockHashes = new Map(
      blocks.map((block) => [block.blockNumber, block.blockHash])
    )
    const receiptCoverage = await this.loadVerifiedReceiptCoverage(blocks)
    const completeLogs = receiptCoverage.logs
    const events: P2TRCanonicalEthereumEvent[] = []
    const seenPositions = new Set<string>()

    for (const descriptor of this.descriptors) {
      const filter = {
        address: descriptor.emitter,
        topics: [descriptor.topic0],
        fromBlock,
        toBlock,
      }
      const [sourceLogs, verifierLogs] = await Promise.all([
        this.source.getLogs(filter),
        this.verifier.getLogs(filter),
      ])
      rejectPossiblyTruncatedLogRange(
        sourceLogs,
        this.options.maxLogsPerDescriptorPerScan,
        `${descriptor.kind} source`
      )
      rejectPossiblyTruncatedLogRange(
        verifierLogs,
        this.options.maxLogsPerDescriptorPerScan,
        `${descriptor.kind} verifier`
      )
      const normalizedSource = sourceLogs.map((log) =>
        normalizeLog(log, descriptor, fromBlock, toBlock, blockHashes)
      )
      const normalizedVerifier = verifierLogs.map((log) =>
        normalizeLog(log, descriptor, fromBlock, toBlock, blockHashes)
      )
      assertExactLogSets(normalizedSource, normalizedVerifier, descriptor.kind)
      const receiptLogs = completeLogs.filter(
        (log) =>
          log.address === descriptor.emitter &&
          log.topics[0] === descriptor.topic0
      )
      assertExactLogSets(normalizedVerifier, receiptLogs, descriptor.kind)

      for (const log of normalizedVerifier) {
        const position = `${log.blockHash}:${log.logIndex}`
        if (seenPositions.has(position)) {
          throw new Error(
            `Canonical Ethereum log ${position} matched multiple event descriptors`
          )
        }
        seenPositions.add(position)
        const payload = descriptor.decode(log)
        validateDecodedPayload(
          payload,
          this.options.maxDecodedPayloadBytes,
          descriptor.kind
        )
        events.push({
          eventID: computeCanonicalEthereumEventID(this.options.chainID, log),
          kind: descriptor.kind,
          decoderSchemaID: descriptor.decoderSchemaID,
          decoderCodeHash: descriptor.decoderCodeHash,
          log,
          payload,
        })
      }
    }

    const sortedEvents = events.sort((left, right) =>
      left.log.blockNumber !== right.log.blockNumber
        ? left.log.blockNumber - right.log.blockNumber
        : left.log.logIndex - right.log.logIndex
    )
    const blockCoverage = await Promise.all(
      blocks.map((block) =>
        computeP2TRCanonicalEthereumBlockCoverage(
          block,
          receiptCoverage.receiptsByBlock.get(block.blockNumber) ?? [],
          sortedEvents
            .filter((event) => event.log.blockNumber === block.blockNumber)
            .map(p2trCanonicalEthereumRequiredEventRecord)
        )
      )
    )
    return {
      events: sortedEvents,
      blockCoverage,
    }
  }

  private async loadVerifiedReceiptCoverage(
    blocks: readonly P2TRCanonicalEthereumBlock[]
  ): Promise<VerifiedReceiptCoverage> {
    const transactionCount = blocks.reduce(
      (total, block) => total + block.transactionHashes.length,
      0
    )
    if (transactionCount > this.options.maxTransactionsPerScan) {
      throw new Error(
        "Canonical Ethereum receipt verification reached its transaction bound"
      )
    }

    const logs: Array<P2TRCanonicalEthereumRawLog & { removed: false }> = []
    const receiptsByBlock = new Map<number, NormalizedReceipt[]>()
    for (const block of blocks) {
      const blockReceipts: NormalizedReceipt[] = []
      for (
        let transactionIndex = 0;
        transactionIndex < block.transactionHashes.length;
        transactionIndex++
      ) {
        const transactionHash = block.transactionHashes[transactionIndex]
        const [sourceReceipt, verifierReceipt] = await Promise.all([
          this.source.getTransactionReceipt(transactionHash),
          this.verifier.getTransactionReceipt(transactionHash),
        ])
        const normalizedSource = normalizeReceipt(
          sourceReceipt,
          block,
          transactionHash,
          transactionIndex,
          "source"
        )
        const normalizedVerifier = normalizeReceipt(
          verifierReceipt,
          block,
          transactionHash,
          transactionIndex,
          "verifier"
        )
        if (canonicalJSON(normalizedSource) !== canonicalJSON(normalizedVerifier)) {
          throw new Error(
            `Independent Ethereum providers disagree on receipt ${transactionHash}`
          )
        }
        blockReceipts.push(normalizedVerifier)
        logs.push(...normalizedVerifier.logs)
        if (logs.length > this.options.maxReceiptLogsPerScan) {
          throw new Error(
            "Canonical Ethereum receipt verification reached its log bound"
          )
        }
      }
      receiptsByBlock.set(block.blockNumber, blockReceipts)
    }

    logs.sort((left, right) =>
      left.blockNumber !== right.blockNumber
        ? left.blockNumber - right.blockNumber
        : left.logIndex - right.logIndex
    )
    let previousBlock = -1
    let expectedLogIndex = 0
    for (const log of logs) {
      if (log.blockNumber !== previousBlock) {
        previousBlock = log.blockNumber
        expectedLogIndex = 0
      }
      if (log.logIndex !== expectedLogIndex++) {
        throw new Error(
          `Canonical Ethereum block ${log.blockNumber} has incomplete receipt log indexes`
        )
      }
    }
    return { logs, receiptsByBlock }
  }
}

export function p2trCanonicalEthereumRequiredEventRecord(
  event: P2TRCanonicalEthereumEvent
): unknown {
  return {
    eventID: normalizeBytes32(event.eventID, "Ethereum event ID"),
    eventKind: event.kind,
    decoderSchemaID: boundedString(
      event.decoderSchemaID,
      128,
      "Ethereum decoder schema ID"
    ),
    decoderCodeHash: normalizeBytes32(
      event.decoderCodeHash,
      "Ethereum decoder code hash"
    ),
    blockNumber: event.log.blockNumber,
    blockHash: event.log.blockHash,
    transactionHash: event.log.transactionHash,
    transactionIndex: event.log.transactionIndex,
    logIndex: event.log.logIndex,
    emitter: event.log.address,
    topic0: event.log.topics[0],
    topics: [...event.log.topics],
    data: event.log.data,
    decodedPayload: structuredClone(event.payload),
  }
}

export async function computeP2TRCanonicalEthereumBlockCoverage(
  block: P2TRCanonicalEthereumBlock,
  receipts: readonly P2TRCanonicalEthereumReceipt[],
  requiredEventRecords: readonly unknown[]
): Promise<P2TRCanonicalEthereumBlockCoverage> {
  const normalizedBlock = normalizeBlock(block, "Ethereum coverage block")
  if (receipts.length !== normalizedBlock.transactionHashes.length) {
    throw new Error("Ethereum block receipt coverage is incomplete")
  }
  if (
    normalizedBlock.serializedTransactions.length !==
      normalizedBlock.transactionHashes.length ||
    normalizedBlock.serializedTransactions.some(
      (transaction, index) =>
        hashP2TREthereumSerializedEnvelope(transaction) !==
        normalizedBlock.transactionHashes[index]
    )
  ) {
    throw new Error("Ethereum serialized transaction coverage is inconsistent")
  }
  const normalizedReceipts = receipts.map((receipt, transactionIndex) =>
    normalizeReceipt(
      receipt,
      normalizedBlock,
      normalizedBlock.transactionHashes[transactionIndex],
      transactionIndex,
      "coverage"
    )
  )
  const logs = normalizedReceipts.flatMap((receipt) => receipt.logs)
  for (let index = 0; index < logs.length; index++) {
    if (logs[index].logIndex !== index) {
      throw new Error("Ethereum block receipt log coverage is not contiguous")
    }
  }
  const serializedReceipts = normalizedReceipts.map((receipt) =>
    serializeP2TREthereumRpcReceipt(receipt)
  )
  const [transactionsRoot, receiptsRoot] = await Promise.all([
    computeP2TREthereumTrieRoot(normalizedBlock.serializedTransactions),
    computeP2TREthereumTrieRoot(serializedReceipts),
  ])
  if (
    transactionsRoot !== normalizedBlock.transactionsRoot ||
    receiptsRoot !== normalizedBlock.receiptsRoot
  ) {
    throw new Error("Ethereum transaction or receipt trie root mismatch")
  }
  return {
    blockNumber: normalizedBlock.blockNumber,
    blockHash: normalizedBlock.blockHash,
    transactionsRoot,
    receiptsRoot,
    transactionDigest: coverageDigest(
      "transactions-v1",
      normalizedBlock.transactionHashes
    ),
    transactionCount: normalizedBlock.transactionHashes.length,
    receiptDigest: coverageDigest("receipts-v1", normalizedReceipts),
    receiptCount: normalizedReceipts.length,
    logDigest: coverageDigest("logs-v1", logs),
    logCount: logs.length,
    requiredEventDigest: `0x${createHash("sha256")
      .update("tbtc-p2tr-required-event-history/v1\0", "utf8")
      .update(canonicalJSON(requiredEventRecords), "utf8")
      .digest("hex")}`,
    requiredEventCount: requiredEventRecords.length,
  }
}

/**
 * Coverage marker for the explicitly configured checkpoint. The checkpoint is
 * a trusted ancestry anchor and is not part of the inclusive journal range;
 * its header roots are still persisted so it cannot later be replayed with a
 * different body commitment.
 */
export function p2trCanonicalEthereumCheckpointAnchorCoverage(
  block: P2TRCanonicalEthereumBlock
): P2TRCanonicalEthereumBlockCoverage {
  const normalized = normalizeBlock(block, "Ethereum checkpoint block")
  return {
    blockNumber: normalized.blockNumber,
    blockHash: normalized.blockHash,
    transactionsRoot: normalized.transactionsRoot,
    receiptsRoot: normalized.receiptsRoot,
    transactionDigest: coverageDigest("transactions-v1", []),
    transactionCount: 0,
    receiptDigest: coverageDigest("receipts-v1", []),
    receiptCount: 0,
    logDigest: coverageDigest("logs-v1", []),
    logCount: 0,
    requiredEventDigest: `0x${createHash("sha256")
      .update("tbtc-p2tr-required-event-history/v1\0", "utf8")
      .update(canonicalJSON([]), "utf8")
      .digest("hex")}`,
    requiredEventCount: 0,
  }
}

function coverageDigest(domain: string, value: unknown): string {
  return `0x${createHash("sha256")
    .update(`tbtc-p2tr-ethereum-coverage-${domain}\0`, "utf8")
    .update(canonicalJSON(value), "utf8")
    .digest("hex")}`
}

export function computeP2TRCanonicalEthereumDescriptorSetHash(
  descriptors: readonly Pick<
    P2TRCanonicalEthereumEventDescriptor,
    "kind" | "emitter" | "topic0" | "decoderSchemaID" | "decoderCodeHash"
  >[]
): string {
  const normalized = descriptors
    .map((descriptor) => ({
      kind: descriptor.kind,
      emitter: normalizeAddress(descriptor.emitter, `${descriptor.kind} emitter`),
      topic0: normalizeBytes32(descriptor.topic0, `${descriptor.kind} topic0`),
      decoderSchemaID: boundedString(
        descriptor.decoderSchemaID,
        128,
        `${descriptor.kind} decoder schema ID`
      ),
      decoderCodeHash: normalizeBytes32(
        descriptor.decoderCodeHash,
        `${descriptor.kind} decoder code hash`
      ),
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind))
  return `0x${createHash("sha256")
    .update(canonicalJSON(normalized))
    .digest("hex")}`
}

function normalizeAndValidateDescriptors(
  descriptors: readonly P2TRCanonicalEthereumEventDescriptor[]
): NormalizedDescriptor[] {
  const byKind = new Map<P2TRCanonicalEthereumEventKind, NormalizedDescriptor>()
  const filters = new Set<string>()
  for (const descriptor of descriptors) {
    if (
      !P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS.includes(descriptor.kind)
    ) {
      throw new Error(`Unsupported canonical Ethereum event kind ${descriptor.kind}`)
    }
    const normalized: NormalizedDescriptor = {
      ...descriptor,
      emitter: normalizeAddress(descriptor.emitter, `${descriptor.kind} emitter`),
      topic0: normalizeBytes32(descriptor.topic0, `${descriptor.kind} topic0`),
      decoderSchemaID: boundedString(
        descriptor.decoderSchemaID,
        128,
        `${descriptor.kind} decoder schema ID`
      ),
      decoderCodeHash: normalizeBytes32(
        descriptor.decoderCodeHash,
        `${descriptor.kind} decoder code hash`
      ),
    }
    if (typeof descriptor.decode !== "function" || byKind.has(descriptor.kind)) {
      throw new Error(
        `Canonical Ethereum event kind ${descriptor.kind} must have one decoder`
      )
    }
    const filter = `${normalized.emitter}:${normalized.topic0}`
    if (filters.has(filter)) {
      throw new Error(
        `Canonical Ethereum filter ${filter} is assigned to multiple event kinds`
      )
    }
    filters.add(filter)
    byKind.set(descriptor.kind, normalized)
  }
  for (const kind of P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS) {
    if (!byKind.has(kind)) {
      throw new Error(`Canonical Ethereum event decoder ${kind} is required`)
    }
  }
  if (byKind.size !== P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS.length) {
    throw new Error("Canonical Ethereum descriptor set is not exact")
  }
  return [...byKind.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind)
  )
}

function validateProviderIndependence(
  source: P2TRCanonicalEthereumProvider,
  verifier: P2TRCanonicalEthereumProvider
): void {
  if (
    source === verifier ||
    source.providerIdentity === verifier.providerIdentity ||
    !isObjectIdentity(source.providerIdentity) ||
    !isObjectIdentity(verifier.providerIdentity)
  ) {
    throw new Error(
      "Canonical Ethereum source and verifier must use different provider objects"
    )
  }
  const sourceDomain = boundedString(
    source.trustDomainID,
    128,
    "Ethereum source trust domain"
  )
  const verifierDomain = boundedString(
    verifier.trustDomainID,
    128,
    "Ethereum verifier trust domain"
  )
  if (sourceDomain === verifierDomain) {
    throw new Error(
      "Canonical Ethereum source and verifier must be operationally independent"
    )
  }
}

function validateJournalOptions(options: P2TRCanonicalEthereumJournalOptions) {
  boundedString(options.storeID, 255, "Ethereum journal store ID")
  positiveInteger(options.chainID, "Ethereum journal chain ID")
  normalizeBytes32(
    options.configurationFingerprint,
    "Ethereum journal configuration fingerprint"
  )
  normalizePoint(options.checkpoint, "Ethereum journal checkpoint")
  positiveInteger(options.scanStartBlock, "Ethereum event scan start block")
  if (options.checkpoint.blockNumber + 1 !== options.scanStartBlock) {
    throw new Error(
      "Canonical Ethereum checkpoint must immediately precede the inclusive scan start"
    )
  }
  nonNegativeInteger(options.confirmationDepth, "Ethereum confirmation depth")
  positiveInteger(options.maxBlocksPerScan, "Ethereum block scan bound")
  positiveInteger(options.maxReorgDepth, "Ethereum reorg bound")
  positiveInteger(
    options.maxTransactionsPerScan,
    "Ethereum receipt transaction bound"
  )
  positiveInteger(options.maxReceiptLogsPerScan, "Ethereum receipt log bound")
  positiveInteger(
    options.maxLogsPerDescriptorPerScan,
    "Ethereum event scan bound"
  )
  positiveInteger(
    options.maxDecodedPayloadBytes,
    "Ethereum decoded payload byte bound"
  )
}

function validateCursor(
  cursor: P2TRCanonicalEthereumCursor | undefined,
  options: P2TRCanonicalEthereumJournalOptions
): void {
  if (cursor === undefined) return
  if (
    cursor.storeID !== options.storeID ||
    cursor.chainID !== options.chainID ||
    normalizeBytes32(
      cursor.configurationFingerprint,
      "stored Ethereum configuration fingerprint"
    ) !== normalizeBytes32(options.configurationFingerprint, "configuration fingerprint") ||
    normalizeBytes32(
      cursor.descriptorSetHash,
      "stored Ethereum descriptor set hash"
    ) !==
      computeP2TRCanonicalEthereumDescriptorSetHash(options.descriptors) ||
    cursor.scanStartBlock !== options.scanStartBlock ||
    canonicalJSON(normalizePoint(cursor.checkpoint, "stored Ethereum checkpoint")) !==
      canonicalJSON(normalizePoint(options.checkpoint, "configured Ethereum checkpoint")) ||
    cursor.current.blockNumber < cursor.checkpoint.blockNumber
  ) {
    throw new Error("Canonical Ethereum cursor is incompatible with configuration")
  }
  normalizePoint(cursor.current, "stored Ethereum cursor")
}

function normalizeBlock(
  block: P2TRCanonicalEthereumBlock | null | undefined,
  label: string
): P2TRCanonicalEthereumBlock {
  if (block === null || block === undefined) {
    throw new Error(`${label} is unavailable`)
  }
  if (!isPlainObject(block.canonicalHeader)) {
    throw new Error(`${label} canonical header is malformed`)
  }
  const canonicalHeader = structuredClone(block.canonicalHeader)
  if (!Array.isArray(block.serializedTransactions)) {
    throw new Error(`${label} serialized transactions are malformed`)
  }
  const normalized = {
    blockNumber: nonNegativeInteger(block.blockNumber, `${label} number`),
    blockHash: normalizeBytes32(block.blockHash, `${label} hash`),
    parentHash: normalizeBytes32(block.parentHash, `${label} parent hash`),
    timestamp: nonNegativeInteger(block.timestamp, `${label} timestamp`),
    transactionsRoot: normalizeBytes32(
      block.transactionsRoot,
      `${label} transactions root`
    ),
    receiptsRoot: normalizeBytes32(block.receiptsRoot, `${label} receipts root`),
    canonicalHeader,
    transactionHashes: normalizeTransactionHashes(
      block.transactionHashes,
      `${label} transactions`
    ),
    serializedTransactions: block.serializedTransactions.map((value, index) =>
      normalizeHex(value, `${label} serialized transaction ${index}`)
    ),
  }
  if (
    normalizeBytes32(
      String(canonicalHeader.transactionsRoot ?? ""),
      `${label} header transactions root`
    ) !== normalized.transactionsRoot ||
    normalizeBytes32(
      String(canonicalHeader.receiptsRoot ?? ""),
      `${label} header receipts root`
    ) !== normalized.receiptsRoot ||
    normalizeBytes32(
      String(canonicalHeader.parentHash ?? ""),
      `${label} header parent hash`
    ) !== normalized.parentHash ||
    canonicalQuantityNumber(
      canonicalHeader.number,
      `${label} header number`
    ) !== normalized.blockNumber ||
    computeP2TREthereumRpcBlockHash(canonicalHeader) !== normalized.blockHash
  ) {
    throw new Error(`${label} header hash or committed roots are inconsistent`)
  }
  return normalized
}

function normalizeTransactionHashes(
  values: readonly string[],
  label: string
): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`)
  const normalized = values.map((value, index) =>
    normalizeBytes32(value, `${label}[${index}]`)
  )
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate transaction hashes`)
  }
  return normalized
}

function normalizeLog(
  log: P2TRCanonicalEthereumRawLog,
  descriptor: NormalizedDescriptor,
  fromBlock: number,
  toBlock: number,
  blockHashes: ReadonlyMap<number, string>
): P2TRCanonicalEthereumRawLog & { removed: false } {
  const normalized: P2TRCanonicalEthereumRawLog & { removed: false } = {
    address: normalizeAddress(log.address, "Ethereum log emitter"),
    blockHash: normalizeBytes32(log.blockHash, "Ethereum log block hash"),
    blockNumber: nonNegativeInteger(log.blockNumber, "Ethereum log block number"),
    transactionHash: normalizeBytes32(
      log.transactionHash,
      "Ethereum log transaction hash"
    ),
    transactionIndex: nonNegativeInteger(
      log.transactionIndex,
      "Ethereum log transaction index"
    ),
    logIndex: nonNegativeInteger(log.logIndex, "Ethereum log index"),
    data: normalizeHex(log.data, "Ethereum log data"),
    topics: log.topics.map((topic, index) =>
      normalizeBytes32(topic, `Ethereum log topic ${index}`)
    ),
    removed: false,
  }
  if (
    log.removed === true ||
    normalized.address !== descriptor.emitter ||
    normalized.topics.length === 0 ||
    normalized.topics.length > 4 ||
    normalized.topics[0] !== descriptor.topic0 ||
    normalized.blockNumber < fromBlock ||
    normalized.blockNumber > toBlock ||
    blockHashes.get(normalized.blockNumber) !== normalized.blockHash
  ) {
    throw new Error(`Malformed or noncanonical ${descriptor.kind} Ethereum log`)
  }
  return normalized
}

function normalizeReceiptLog(
  log: P2TRCanonicalEthereumRawLog
): P2TRCanonicalEthereumRawLog & { removed: false } {
  if (log.removed === true || !Array.isArray(log.topics)) {
    throw new Error("Canonical Ethereum receipt contains a removed or malformed log")
  }
  const normalized: P2TRCanonicalEthereumRawLog & { removed: false } = {
    address: normalizeAddress(log.address, "receipt log emitter"),
    blockHash: normalizeBytes32(log.blockHash, "receipt log block hash"),
    blockNumber: nonNegativeInteger(log.blockNumber, "receipt log block number"),
    transactionHash: normalizeBytes32(
      log.transactionHash,
      "receipt log transaction hash"
    ),
    transactionIndex: nonNegativeInteger(
      log.transactionIndex,
      "receipt log transaction index"
    ),
    logIndex: nonNegativeInteger(log.logIndex, "receipt log index"),
    data: normalizeHex(log.data, "receipt log data"),
    topics: log.topics.map((topic, index) =>
      normalizeBytes32(topic, `receipt log topic ${index}`)
    ),
    removed: false,
  }
  if (normalized.topics.length === 0 || normalized.topics.length > 4) {
    throw new Error("Canonical Ethereum receipt log has an invalid topic count")
  }
  return normalized
}

function normalizeReceipt(
  receipt: P2TRCanonicalEthereumReceipt | null | undefined,
  block: P2TRCanonicalEthereumBlock,
  transactionHash: string,
  transactionIndex: number,
  providerLabel: string
): P2TRCanonicalEthereumReceipt & {
  logs: Array<P2TRCanonicalEthereumRawLog & { removed: false }>
} {
  if (receipt === null || receipt === undefined) {
    throw new Error(
      `Canonical Ethereum ${providerLabel} receipt ${transactionHash} is unavailable`
    )
  }
  const status = nonNegativeInteger(
    receipt.status,
    `${providerLabel} receipt status`
  )
  if (status !== 0 && status !== 1) {
    throw new Error(`${providerLabel} receipt status must be zero or one`)
  }
  const type = nonNegativeInteger(receipt.type, `${providerLabel} receipt type`)
  if (type > 4) {
    throw new Error(`${providerLabel} receipt type is unsupported`)
  }
  const normalized = {
    type,
    status,
    cumulativeGasUsed: canonicalQuantityString(
      receipt.cumulativeGasUsed,
      `${providerLabel} receipt cumulative gas used`
    ),
    logsBloom: normalizeFixedHex(
      receipt.logsBloom,
      256,
      `${providerLabel} receipt logs bloom`
    ),
    blockHash: normalizeBytes32(
      receipt.blockHash,
      `${providerLabel} receipt block hash`
    ),
    blockNumber: nonNegativeInteger(
      receipt.blockNumber,
      `${providerLabel} receipt block number`
    ),
    transactionHash: normalizeBytes32(
      receipt.transactionHash,
      `${providerLabel} receipt transaction hash`
    ),
    transactionIndex: nonNegativeInteger(
      receipt.transactionIndex,
      `${providerLabel} receipt transaction index`
    ),
    logs: receipt.logs.map(normalizeReceiptLog),
  }
  if (
    normalized.blockHash !== block.blockHash ||
    normalized.blockNumber !== block.blockNumber ||
    normalized.transactionHash !== transactionHash ||
    normalized.transactionIndex !== transactionIndex ||
    (normalized.status === 0 && normalized.logs.length !== 0) ||
    normalized.logs.some(
      (log) =>
        log.blockHash !== block.blockHash ||
        log.blockNumber !== block.blockNumber ||
        log.transactionHash !== transactionHash ||
        log.transactionIndex !== transactionIndex
    )
  ) {
    throw new Error(
      `Canonical Ethereum ${providerLabel} receipt ${transactionHash} is inconsistent with its block`
    )
  }
  return normalized
}

function canonicalQuantityString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error(`${label} is not a canonical Ethereum quantity`)
  }
  return value.toLowerCase()
}

function canonicalQuantityNumber(value: unknown, label: string): number {
  const normalized = canonicalQuantityString(value, label)
  const result = Number(BigInt(normalized))
  return nonNegativeInteger(result, label)
}

function normalizeFixedHex(value: unknown, bytes: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`)
  }
  return `0x${normalized}`
}

function assertExactLogSets(
  source: readonly (P2TRCanonicalEthereumRawLog & { removed: false })[],
  verifier: readonly (P2TRCanonicalEthereumRawLog & { removed: false })[],
  kind: string
): void {
  const left = source.map(rawLogIdentity).sort()
  const right = verifier.map(rawLogIdentity).sort()
  if (canonicalJSON(left) !== canonicalJSON(right)) {
    throw new Error(
      `Independent Ethereum providers disagree on complete ${kind} log range`
    )
  }
  if (new Set(left).size !== left.length) {
    throw new Error(`Ethereum ${kind} log range contains duplicates`)
  }
}

function rejectPossiblyTruncatedLogRange(
  logs: readonly unknown[],
  maximum: number,
  label: string
): void {
  if (!Array.isArray(logs) || logs.length >= maximum) {
    throw new Error(
      `Canonical Ethereum ${label} log range reached its truncation guard; reduce the block range`
    )
  }
}

function validateDecodedPayload(
  payload: Readonly<Record<string, unknown>>,
  maximumBytes: number,
  kind: string
): void {
  if (!isPlainObject(payload)) {
    throw new Error(`Canonical Ethereum ${kind} decoder must return an object`)
  }
  const encoded = canonicalJSON(payload)
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
    throw new Error(`Canonical Ethereum ${kind} decoded payload exceeds its bound`)
  }
}

function computeCanonicalEthereumEventID(
  chainID: number,
  log: P2TRCanonicalEthereumRawLog
): string {
  return `0x${createHash("sha256")
    .update(
      canonicalJSON({
        chainID,
        address: log.address,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      })
    )
    .digest("hex")}`
}

function rawLogIdentity(log: P2TRCanonicalEthereumRawLog): string {
  return canonicalJSON({
    address: log.address,
    blockHash: log.blockHash,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    data: log.data,
    topics: log.topics,
  })
}

function rawLogsEqual(
  left: P2TRCanonicalEthereumRawLog,
  right: P2TRCanonicalEthereumRawLog
): boolean {
  return rawLogIdentity(left) === rawLogIdentity(right)
}

function pointOf(block: P2TRCanonicalEthereumBlock): P2TRCanonicalEthereumChainPoint {
  return { blockNumber: block.blockNumber, blockHash: block.blockHash }
}

function normalizePoint(
  point: P2TRCanonicalEthereumChainPoint,
  label: string
): P2TRCanonicalEthereumChainPoint {
  return {
    blockNumber: nonNegativeInteger(point.blockNumber, `${label} number`),
    blockHash: normalizeBytes32(point.blockHash, `${label} hash`),
  }
}

function normalizeAddress(value: string, label: string): string {
  const hex = normalizeHex(value, label).slice(2)
  if (hex.length !== 40) throw new Error(`${label} must be 20 bytes`)
  return `0x${hex}`
}

function normalizeBytes32(value: string, label: string): string {
  const hex = normalizeHex(value, label).slice(2)
  if (hex.length !== 64) throw new Error(`${label} must be 32 bytes`)
  return `0x${hex}`
}

function normalizeHex(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be hex`)
  const hex = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`${label} must contain whole hex bytes`)
  }
  return `0x${hex}`
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical JSON numbers must be safe integers")
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`
  }
  throw new Error("Canonical JSON value is not serializable")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isObjectIdentity(value: unknown): value is object {
  return typeof value === "object" && value !== null
}

function boundedString(value: string, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters`)
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
