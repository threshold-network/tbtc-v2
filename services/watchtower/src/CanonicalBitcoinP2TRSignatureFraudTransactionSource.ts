import { createHash } from "node:crypto"
import type {
  P2TRSignatureFraudWatchtowerTransactionSource,
  P2TRWalletInputObservationPrevout,
  P2TRWatchtowerConfirmedTransaction,
  P2TRWatchtowerConfirmedTransactionSourceResult,
  P2TRWatchtowerMempoolTransaction,
} from "@keep-network/tbtc-v2.ts"
import type {
  P2TRBitcoinChainPoint,
  P2TRBitcoinOutpoint,
  P2TRCanonicalBitcoinBlockSource,
  P2TRCanonicalBitcoinCandidate,
  P2TRCanonicalBitcoinCursor,
  P2TRCanonicalBitcoinIndexStore,
  P2TRCanonicalBitcoinScan,
  P2TRCanonicalBitcoinTransaction,
  P2TRTrackedOutpoint,
  P2TRTrackedOutpointSpend,
} from "./P2TRCanonicalBitcoinIndex.js"

export type CanonicalBitcoinP2TRSignatureFraudTransactionSourceOptions = {
  checkpoint: P2TRBitcoinChainPoint
  /**
   * Production activation must select `genesis-full-history`. Custom
   * checkpoints exist only for bounded tests/rehearsals and can never satisfy
   * the production activation handshake.
   */
  historyCoverage: "genesis-full-history" | "test-only-custom-checkpoint"
  expectedBitcoinCoreTrustDomainID: string
  confirmationDepth: number
  maxBlocksPerScan: number
  maxRollbackBlocks: number
  /** Safe durable delivery pagination; candidates are retained before cursor advancement. */
  maxCandidateDeliveriesPerScan: number
}

export type P2TRCanonicalWatchtowerConfirmedTransaction =
  P2TRWatchtowerConfirmedTransaction & {
    /** Prevouts authenticated from raw transactions returned by Bitcoin Core. */
    inputPrevouts: P2TRWalletInputObservationPrevout[]
  }

export type P2TRCanonicalWatchtowerConfirmedTransactionSourceResult =
  P2TRWatchtowerConfirmedTransactionSourceResult & {
    transactions: P2TRCanonicalWatchtowerConfirmedTransaction[]
    scan: {
      rollbackTo: P2TRBitcoinChainPoint
      nextCursor: P2TRBitcoinChainPoint
      sampledFinalizedHead: P2TRBitcoinChainPoint
      orphanedCandidates: P2TRCanonicalBitcoinScan["orphanedCandidates"]
    }
  }

/**
 * Block-driven, confirmed-only production candidate source. Scans remain
 * staged until the caller acknowledges successful durable observation.
 */
export class CanonicalBitcoinP2TRSignatureFraudTransactionSource
  implements P2TRSignatureFraudWatchtowerTransactionSource
{
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts =
    true as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  readonly p2trSignatureFraudWatchtowerCanonicalBitcoinHistoryCoverage:
    | "genesis-full-history"
    | "test-only-partial-history"

  private readonly configuredWalletIDs: Set<string>
  private readonly walletIDs: Set<string>
  private readonly checkpoint: P2TRBitcoinChainPoint
  private readonly confirmationDepth: number
  private readonly maxBlocksPerScan: number
  private readonly maxRollbackBlocks: number
  private readonly maxCandidateDeliveriesPerScan: number
  private readonly configurationFingerprint: string
  private pendingScan?: P2TRCanonicalBitcoinScan

  constructor(
    private readonly blockSource: P2TRCanonicalBitcoinBlockSource,
    private readonly store: P2TRCanonicalBitcoinIndexStore,
    registeredWalletIDs: string[],
    options: CanonicalBitcoinP2TRSignatureFraudTransactionSourceOptions
  ) {
    this.configuredWalletIDs = new Set(
      registeredWalletIDs.map((walletID) =>
        normalizeBytes32(walletID, "registered wallet ID")
      )
    )
    this.walletIDs = new Set(this.configuredWalletIDs)
    if (this.configuredWalletIDs.size !== registeredWalletIDs.length) {
      throw new Error("Canonical Bitcoin P2TR source wallet IDs must be unique")
    }
    if (
      nonEmptyString(
        options.expectedBitcoinCoreTrustDomainID,
        "expected Bitcoin Core trust-domain ID"
      ) !== blockSource.trustDomainID
    ) {
      throw new Error(
        "Canonical Bitcoin P2TR source trust-domain ID does not match configuration"
      )
    }

    this.checkpoint = normalizePoint(options.checkpoint, "Bitcoin checkpoint")
    if (options.historyCoverage === "genesis-full-history") {
      if (
        this.checkpoint.height !== 0 ||
        this.checkpoint.hash !== blockSource.genesisHash
      ) {
        throw new Error(
          "Production P2TR fraud activation requires the exact configured genesis checkpoint at height 0"
        )
      }
      this.p2trSignatureFraudWatchtowerCanonicalBitcoinHistoryCoverage =
        "genesis-full-history"
    } else if (options.historyCoverage === "test-only-custom-checkpoint") {
      this.p2trSignatureFraudWatchtowerCanonicalBitcoinHistoryCoverage =
        "test-only-partial-history"
    } else {
      throw new Error(
        "Canonical Bitcoin P2TR source history coverage mode is invalid"
      )
    }
    this.confirmationDepth = positiveInteger(
      options.confirmationDepth,
      "Bitcoin confirmation depth"
    )
    this.maxBlocksPerScan = positiveInteger(
      options.maxBlocksPerScan,
      "Bitcoin blocks-per-scan bound"
    )
    this.maxRollbackBlocks = positiveInteger(
      options.maxRollbackBlocks,
      "Bitcoin rollback bound"
    )
    this.maxCandidateDeliveriesPerScan = positiveInteger(
      options.maxCandidateDeliveriesPerScan,
      "Bitcoin candidate delivery page size"
    )
    this.p2trSignatureFraudWatchtowerTransactionalStoreID =
      store.p2trSignatureFraudWatchtowerTransactionalStoreID
    store.registerP2TRSignatureFraudWatchtowerTransactionalParticipant(this)
    this.configurationFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          network: blockSource.network,
          trustDomainID: blockSource.trustDomainID,
          checkpoint: this.checkpoint,
          confirmationDepth: this.confirmationDepth,
          maxRollbackBlocks: this.maxRollbackBlocks,
        })
      )
      .digest("hex")
  }

  async listMempoolTransactions(): Promise<P2TRWatchtowerMempoolTransaction[]> {
    // Production evidence is deliberately confirmed-only.
    return []
  }

  /** Fail-closed handshake consumed by a production activation composition. */
  async assertP2TRSignatureFraudProductionHistoryCoverage(): Promise<void> {
    if (
      this.p2trSignatureFraudWatchtowerCanonicalBitcoinHistoryCoverage !==
        "genesis-full-history" ||
      this.checkpoint.height !== 0 ||
      this.checkpoint.hash !== this.blockSource.genesisHash
    ) {
      throw new Error(
        "P2TR fraud activation requires canonical Bitcoin history scanned from the exact network genesis"
      )
    }
    // The constructor check catches static misconfiguration. Activation also
    // authenticates the live Core node: getSyncedHead validates network,
    // genesis, sync state, pruning, and txindex before the exact genesis read.
    const nodeHead = await this.blockSource.getSyncedHead()
    if ((await this.blockSource.getBlockHash(0)) !== this.checkpoint.hash) {
      throw new Error(
        "P2TR fraud activation live Bitcoin genesis does not match its full-history checkpoint"
      )
    }
    const finalizedHeight = nodeHead.height - this.confirmationDepth
    if (finalizedHeight < this.checkpoint.height) {
      throw new Error(
        "P2TR fraud activation Bitcoin finalized head has not reached genesis"
      )
    }
    const finalized = {
      height: finalizedHeight,
      hash: await this.blockSource.getBlockHash(finalizedHeight),
    }
    const cursor = await this.store.loadBitcoinCursor()
    if (
      cursor === undefined ||
      cursor.configurationFingerprint !== this.configurationFingerprint ||
      cursor.network !== this.blockSource.network ||
      !samePoint(cursor.checkpoint, this.checkpoint) ||
      !samePoint(cursor.current, finalized)
    ) {
      throw new Error(
        "P2TR fraud activation requires the genesis-backed canonical index to be caught up to the live finalized Bitcoin head"
      )
    }
  }

  async listConfirmedTransactions(): Promise<P2TRCanonicalWatchtowerConfirmedTransactionSourceResult> {
    if (this.pendingScan !== undefined) {
      throw new Error(
        "Canonical Bitcoin P2TR source has an uncommitted confirmed scan"
      )
    }

    const currentWalletIDs = new Set(this.configuredWalletIDs)
    for (const walletID of await this.store.loadRegisteredWalletIDs()) {
      currentWalletIDs.add(normalizeBytes32(walletID, "stored wallet ID"))
    }
    this.walletIDs.clear()
    currentWalletIDs.forEach((walletID) => this.walletIDs.add(walletID))

    const nodeHead = await this.blockSource.getSyncedHead()
    const finalizedHeight = nodeHead.height - this.confirmationDepth
    if (finalizedHeight < this.checkpoint.height) {
      throw new Error(
        "Bitcoin Core finalized head has not reached the configured checkpoint"
      )
    }
    const sampledFinalizedHead = {
      height: finalizedHeight,
      hash: await this.blockSource.getBlockHash(finalizedHeight),
    }
    const storedCursor = await this.store.loadBitcoinCursor()
    const current = await this.resolveStartingCursor(storedCursor)
    const rollbackTo = await this.findCommonAncestor(
      current,
      sampledFinalizedHead.height
    )
    const orphanedCandidates = await this.store.loadCandidatesAbove(
      rollbackTo.height
    )
    const pendingCandidates = await this.store.loadPendingCandidates(
      this.maxCandidateDeliveriesPerScan,
      rollbackTo.height
    )

    const scan = await this.scanCanonicalBlocks(
      storedCursor,
      rollbackTo,
      sampledFinalizedHead,
      orphanedCandidates
    )
    const deliveryCandidates = [
      ...pendingCandidates.candidates,
      ...scan.candidates,
    ].slice(0, this.maxCandidateDeliveriesPerScan)
    scan.acknowledgedCandidates = deliveryCandidates.map(
      ({ txid, wtxid, block }) => ({ txid, wtxid, blockHash: block.hash })
    )
    scan.complete =
      scan.complete &&
      pendingCandidates.complete &&
      pendingCandidates.candidates.length + scan.candidates.length <=
        this.maxCandidateDeliveriesPerScan
    this.pendingScan = scan

    return {
      transactions: deliveryCandidates.map((candidate) => ({
        rawTransaction: { transactionHex: candidate.rawTransactionHex },
        bitcoinTxHash: candidate.txid,
        bitcoinBlockHash: candidate.block.hash,
        bitcoinBlockHeight: candidate.block.height,
        canonicalBitcoinCandidateIdentity: {
          bitcoinTxHash: candidate.txid,
          bitcoinWtxid: candidate.wtxid,
          bitcoinBlockHash: candidate.block.hash,
        },
        walletInputKeyBindings: candidate.walletInputKeyBindings,
        inputPrevouts: candidate.inputPrevouts,
      })),
      complete: scan.complete,
      registeredWalletIDs: [...this.walletIDs].sort(),
      orphanedConfirmedTransactions: scan.orphanedCandidates.map(
        ({ txid, wtxid, block }) => ({
          bitcoinTxHash: txid,
          bitcoinWtxid: wtxid,
          bitcoinBlockHash: block.hash,
        })
      ),
      scan: {
        rollbackTo: scan.rollbackTo,
        nextCursor: scan.nextCursor,
        sampledFinalizedHead: scan.sampledFinalizedHead,
        orphanedCandidates: scan.orphanedCandidates,
      },
    }
  }

  async commitConfirmedTransactionScan(): Promise<void> {
    const scan = this.pendingScan
    if (scan === undefined) return

    // Force a fresh scan after an ambiguous database or RPC failure.
    this.pendingScan = undefined
    const points = new Map<number, string>([
      [scan.rollbackTo.height, scan.rollbackTo.hash],
      [scan.nextCursor.height, scan.nextCursor.hash],
      [scan.sampledFinalizedHead.height, scan.sampledFinalizedHead.hash],
    ])
    for (const [height, expectedHash] of points) {
      if ((await this.blockSource.getBlockHash(height)) !== expectedHash) {
        throw new Error(
          `Bitcoin canonical hash changed at height ${height} before scan commit`
        )
      }
    }
    await this.store.applyBitcoinScan(scan)
  }

  abortConfirmedTransactionScan(): void {
    this.pendingScan = undefined
  }

  private async scanCanonicalBlocks(
    storedCursor: P2TRCanonicalBitcoinCursor | undefined,
    rollbackTo: P2TRBitcoinChainPoint,
    sampledFinalizedHead: P2TRBitcoinChainPoint,
    orphanedCandidates: P2TRCanonicalBitcoinScan["orphanedCandidates"]
  ): Promise<P2TRCanonicalBitcoinScan> {
    const scanToHeight = Math.min(
      sampledFinalizedHead.height,
      rollbackTo.height + this.maxBlocksPerScan
    )
    const blocks = []
    const trackedOutpoints: P2TRTrackedOutpoint[] = []
    const trackedOutpointSpends: P2TRTrackedOutpointSpend[] = []
    const candidates: P2TRCanonicalBitcoinCandidate[] = []
    const trackedByOutpoint = new Map<string, P2TRTrackedOutpoint>()
    let expectedParentHash = rollbackTo.hash

    for (let height = rollbackTo.height + 1; height <= scanToHeight; height++) {
      const block = await this.blockSource.getBlock(height)
      if (block.parentHash !== expectedParentHash) {
        throw new Error(
          `Bitcoin block ${height} does not descend from the staged canonical cursor`
        )
      }
      const blockInputs: P2TRBitcoinOutpoint[] = []
      for (const transaction of block.transactions) {
        if (!transaction.coinbase) {
          blockInputs.push(
            ...transaction.inputs.map(({ txid, vout }) => ({ txid, vout }))
          )
        }
      }
      const storedTracked = await this.store.loadTrackedOutpoints(blockInputs)
      for (const tracked of storedTracked) {
        const key = outpointKey(tracked)
        const existing = trackedByOutpoint.get(key)
        if (existing !== undefined && !sameTrackedOutpoint(existing, tracked)) {
          throw new Error(`Tracked Bitcoin outpoint ${key} is inconsistent`)
        }
        trackedByOutpoint.set(key, tracked)
      }

      for (const transaction of block.transactions) {
        const matched = transaction.coinbase
          ? []
          : transaction.inputs.flatMap((input) => {
              const tracked = trackedByOutpoint.get(outpointKey(input))
              return tracked === undefined ? [] : [{ input, tracked }]
            })

        if (matched.length > 0) {
          const inputPrevouts = this.resolveInputPrevouts(transaction)
          const bindingKeys = new Set<string>()
          const walletInputKeyBindings = matched.flatMap(({ tracked }) => {
            if (tracked.kind !== "deposit") return []
            const key = outpointKey(tracked)
            if (bindingKeys.has(key)) return []
            bindingKeys.add(key)
            return [
              {
                txid: tracked.txid,
                vout: tracked.vout,
                outputKey: tracked.outputKey,
                walletID: tracked.walletID,
              },
            ]
          })
          candidates.push({
            txid: transaction.txid,
            wtxid: transaction.wtxid,
            rawTransactionHex: transaction.rawTransactionHex,
            block: { height: block.height, hash: block.hash },
            inputPrevouts,
            walletInputKeyBindings,
          })

          matched.forEach(({ input }) => {
            trackedOutpointSpends.push({
              txid: input.txid,
              vout: input.vout,
              spendingTxid: transaction.txid,
              spendingWtxid: transaction.wtxid,
              inputIndex: input.inputIndex,
              spentAt: { height: block.height, hash: block.hash },
            })
          })
        }

        for (const output of transaction.outputs) {
          const walletID = walletIDFromCanonicalP2TROutput(
            output.scriptPubKey,
            this.walletIDs
          )
          if (walletID === undefined) continue
          const tracked: P2TRTrackedOutpoint = {
            txid: output.txid,
            vout: output.vout,
            kind: "wallet",
            walletID,
            outputKey: walletID,
            valueSats: output.valueSats,
            scriptPubKey: output.scriptPubKey,
            createdAt: { height: block.height, hash: block.hash },
          }
          trackedByOutpoint.set(outpointKey(tracked), tracked)
          trackedOutpoints.push(tracked)
        }
      }

      blocks.push(block)
      expectedParentHash = block.hash
    }

    const lastBlock = blocks.at(-1)
    const nextCursor =
      lastBlock === undefined
        ? rollbackTo
        : { height: lastBlock.height, hash: lastBlock.hash }
    return {
      configurationFingerprint: this.configurationFingerprint,
      network: this.blockSource.network,
      checkpoint: this.checkpoint,
      ...(storedCursor === undefined
        ? {}
        : { expectedCursor: storedCursor.current }),
      rollbackTo,
      nextCursor,
      sampledFinalizedHead,
      complete: nextCursor.height === sampledFinalizedHead.height,
      blocks,
      trackedOutpoints,
      trackedOutpointSpends,
      candidates,
      acknowledgedCandidates: [],
      orphanedCandidates,
    }
  }

  private async resolveStartingCursor(
    stored: P2TRCanonicalBitcoinCursor | undefined
  ): Promise<P2TRCanonicalBitcoinCursor> {
    if (stored === undefined) {
      if (
        (await this.blockSource.getBlockHash(this.checkpoint.height)) !==
        this.checkpoint.hash
      ) {
        throw new Error(
          "Configured Bitcoin checkpoint does not match the canonical node"
        )
      }
      return {
        configurationFingerprint: this.configurationFingerprint,
        network: this.blockSource.network,
        checkpoint: this.checkpoint,
        current: this.checkpoint,
      }
    }

    if (stored.configurationFingerprint !== this.configurationFingerprint) {
      throw new Error(
        "Canonical Bitcoin index configuration changed; an explicit checkpoint rebuild is required"
      )
    }
    if (stored.network !== this.blockSource.network) {
      throw new Error("Canonical Bitcoin index network does not match source")
    }
    if (!samePoint(stored.checkpoint, this.checkpoint)) {
      throw new Error(
        "Canonical Bitcoin index checkpoint does not match source"
      )
    }
    if (stored.current.height < this.checkpoint.height) {
      throw new Error("Canonical Bitcoin cursor precedes its checkpoint")
    }
    return stored
  }

  private async findCommonAncestor(
    cursor: P2TRCanonicalBitcoinCursor,
    finalizedHeight: number
  ): Promise<P2TRBitcoinChainPoint> {
    let height = Math.min(cursor.current.height, finalizedHeight)
    let rollbackDistance = cursor.current.height - height
    while (height >= this.checkpoint.height) {
      if (rollbackDistance > this.maxRollbackBlocks) break
      const storedHash =
        height === this.checkpoint.height
          ? this.checkpoint.hash
          : await this.store.loadStoredBlockHash(height)
      if (storedHash === undefined) {
        throw new Error(
          `Bitcoin block journal is missing retained height ${height}`
        )
      }
      const canonicalHash = await this.blockSource.getBlockHash(height)
      if (storedHash === canonicalHash) {
        return { height, hash: canonicalHash }
      }
      height--
      rollbackDistance++
    }

    throw new Error(
      `Bitcoin reorg exceeds the configured ${this.maxRollbackBlocks}-block rollback or retained journal bound`
    )
  }

  private resolveInputPrevouts(
    transaction: P2TRCanonicalBitcoinTransaction
  ): P2TRWalletInputObservationPrevout[] {
    return transaction.inputs.map((input) => {
      const prevout = input.authenticatedPrevout
      if (
        prevout === undefined ||
        prevout.txid !== input.txid ||
        prevout.vout !== input.vout
      ) {
        throw new Error(
          `Bitcoin Core verbosity-3 prevout is missing for ${transaction.txid}:${input.inputIndex}`
        )
      }
      return {
        txid: input.txid,
        vout: input.vout,
        valueSats: prevout.valueSats,
        scriptPubKey: prevout.scriptPubKey,
      }
    })
  }
}

const walletIDFromCanonicalP2TROutput = (
  scriptPubKey: string,
  registeredWalletIDs: Set<string>
): string | undefined => {
  // OP_1 PUSH32 <x-only output key> is the only accepted FROST wallet output.
  if (!/^5120[0-9a-f]{64}$/.test(scriptPubKey)) return undefined
  const outputKey = scriptPubKey.slice(4)
  return registeredWalletIDs.has(outputKey) ? outputKey : undefined
}

const normalizePoint = (
  point: P2TRBitcoinChainPoint,
  field: string
): P2TRBitcoinChainPoint => ({
  height: nonNegativeInteger(point.height, `${field} height`),
  hash: normalizeBytes32(point.hash, `${field} hash`),
})

const normalizeBytes32 = (value: string, field: string): string => {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 32-byte hex value`)
  }
  return normalized
}

const samePoint = (
  left: P2TRBitcoinChainPoint,
  right: P2TRBitcoinChainPoint
): boolean => left.height === right.height && left.hash === right.hash

const outpointKey = ({ txid, vout }: P2TRBitcoinOutpoint): string =>
  `${txid}:${vout}`

const sameTrackedOutpoint = (
  left: P2TRTrackedOutpoint,
  right: P2TRTrackedOutpoint
): boolean =>
  left.kind === right.kind &&
  left.walletID === right.walletID &&
  left.outputKey === right.outputKey &&
  left.valueSats === right.valueSats &&
  left.scriptPubKey === right.scriptPubKey

const positiveInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  return value
}

const nonNegativeInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return value
}

const nonEmptyString = (value: string, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`)
  }
  return value.trim()
}
