import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { CanonicalBitcoinP2TRSignatureFraudTransactionSource } from "../src/CanonicalBitcoinP2TRSignatureFraudTransactionSource.js"
import type {
  P2TRBitcoinOutpoint,
  P2TRCanonicalBitcoinBlock,
  P2TRCanonicalBitcoinBlockSource,
  P2TRCanonicalBitcoinCursor,
  P2TRCanonicalBitcoinIndexStore,
  P2TRCanonicalBitcoinOrphanedCandidate,
  P2TRCanonicalBitcoinScan,
  P2TRTrackedOutpoint,
} from "../src/P2TRCanonicalBitcoinIndex.js"

const WALLET_ID = "11".repeat(32)
const CHECKPOINT_HASH = "aa".repeat(32)
const BLOCK_ONE_HASH = "bb".repeat(32)
const BLOCK_TWO_HASH = "cc".repeat(32)
const REPLACEMENT_BLOCK_TWO_HASH = "dd".repeat(32)
const FUNDING_TXID = "22".repeat(32)
const SPENDING_TXID = "33".repeat(32)
const ORIGINAL_WTXID = "44".repeat(32)
const REPLACEMENT_WTXID = "55".repeat(32)

describe("CanonicalBitcoinP2TRSignatureFraudTransactionSource", () => {
  it("delivers authenticated candidates and distinguishes a re-mined witness variant", async () => {
    const blockSource = new MutableBlockSource()
    const store = new MemoryIndexStore()
    const source = new CanonicalBitcoinP2TRSignatureFraudTransactionSource(
      blockSource,
      store,
      [WALLET_ID],
      {
        checkpoint: { height: 0, hash: CHECKPOINT_HASH },
        expectedBitcoinCoreTrustDomainID: "core-a",
        confirmationDepth: 1,
        maxBlocksPerScan: 2,
        maxRollbackBlocks: 6,
        maxCandidateDeliveriesPerScan: 1,
      }
    )

    const first = await source.listConfirmedTransactions()
    assert.equal(first.complete, true)
    assert.equal(first.transactions.length, 1)
    assert.equal(first.transactions[0].inputPrevouts[0].valueSats, 10_000)
    assert.equal(first.scan.orphanedCandidates.length, 0)
    await source.commitConfirmedTransactionScan()

    blockSource.replaceWitnessVariant()
    const replacement = await source.listConfirmedTransactions()

    assert.equal(replacement.complete, true)
    assert.equal(replacement.transactions.length, 1)
    assert.equal(replacement.transactions[0].bitcoinTxHash, SPENDING_TXID)
    assert.deepEqual(replacement.scan.orphanedCandidates, [
      {
        txid: SPENDING_TXID,
        wtxid: ORIGINAL_WTXID,
        block: { height: 2, hash: BLOCK_TWO_HASH },
      },
    ])
    assert.equal(store.lastRegisteredParticipant, source)
    await source.commitConfirmedTransactionScan()
    assert.equal(store.cursor?.current.hash, REPLACEMENT_BLOCK_TWO_HASH)
    assert.equal(store.candidates[0].wtxid, REPLACEMENT_WTXID)
  })

  it("starts without wallets and delivers a pre-registration spend after durable backfill", async () => {
    const blockSource = new MutableBlockSource()
    const store = new MemoryIndexStore()
    const source = new CanonicalBitcoinP2TRSignatureFraudTransactionSource(
      blockSource,
      store,
      [],
      {
        checkpoint: { height: 0, hash: CHECKPOINT_HASH },
        expectedBitcoinCoreTrustDomainID: "core-a",
        confirmationDepth: 1,
        maxBlocksPerScan: 2,
        maxRollbackBlocks: 6,
        maxCandidateDeliveriesPerScan: 1,
      }
    )

    const catchUp = await source.listConfirmedTransactions()
    assert.deepEqual(catchUp.registeredWalletIDs, [])
    assert.deepEqual(catchUp.transactions, [])
    await source.commitConfirmedTransactionScan()

    store.addFrostWalletBinding(WALLET_ID)
    const backfilled = await source.listConfirmedTransactions()
    assert.deepEqual(backfilled.registeredWalletIDs, [WALLET_ID])
    assert.equal(backfilled.transactions.length, 1)
    assert.equal(backfilled.transactions[0].bitcoinTxHash, SPENDING_TXID)
    assert.equal(backfilled.transactions[0].inputPrevouts[0].valueSats, 10_000)
    await source.commitConfirmedTransactionScan()

    const afterAcknowledgement = await source.listConfirmedTransactions()
    assert.deepEqual(afterAcknowledgement.transactions, [])
    await source.commitConfirmedTransactionScan()

    store.removeFrostWalletBinding(WALLET_ID)
    const afterRegistrationReorg = await source.listConfirmedTransactions()
    assert.deepEqual(afterRegistrationReorg.registeredWalletIDs, [])
  })

  it("discards a staged scan after an enclosing cycle declines commit", async () => {
    const source = new CanonicalBitcoinP2TRSignatureFraudTransactionSource(
      new MutableBlockSource(),
      new MemoryIndexStore(),
      [WALLET_ID],
      {
        checkpoint: { height: 0, hash: CHECKPOINT_HASH },
        expectedBitcoinCoreTrustDomainID: "core-a",
        confirmationDepth: 1,
        maxBlocksPerScan: 2,
        maxRollbackBlocks: 6,
        maxCandidateDeliveriesPerScan: 1,
      }
    )

    const staged = await source.listConfirmedTransactions()
    await assert.rejects(
      source.listConfirmedTransactions(),
      /uncommitted confirmed scan/
    )
    source.abortConfirmedTransactionScan()
    const retried = await source.listConfirmedTransactions()

    assert.deepEqual(retried.transactions, staged.transactions)
    await source.commitConfirmedTransactionScan()
  })
})

class MutableBlockSource implements P2TRCanonicalBitcoinBlockSource {
  readonly trustDomainID = "core-a"
  readonly network = "regtest"
  private replacement = false

  async getSyncedHead() {
    return { height: 3, hash: "ee".repeat(32) }
  }

  async getBlockHash(height: number) {
    if (height === 0) return CHECKPOINT_HASH
    if (height === 1) return BLOCK_ONE_HASH
    if (height === 2) {
      return this.replacement ? REPLACEMENT_BLOCK_TWO_HASH : BLOCK_TWO_HASH
    }
    if (height === 3) return "ee".repeat(32)
    throw new Error(`Unknown height ${height}`)
  }

  async getBlock(height: number): Promise<P2TRCanonicalBitcoinBlock> {
    if (height === 1) return fundingBlock()
    if (height === 2) {
      return spendingBlock(
        this.replacement ? REPLACEMENT_BLOCK_TWO_HASH : BLOCK_TWO_HASH,
        this.replacement ? REPLACEMENT_WTXID : ORIGINAL_WTXID
      )
    }
    throw new Error(`Unknown block ${height}`)
  }

  async getRawTransaction(): Promise<never> {
    throw new Error("verbosity-3 prevouts should avoid fallback reads")
  }

  replaceWitnessVariant(): void {
    this.replacement = true
  }
}

class MemoryIndexStore implements P2TRCanonicalBitcoinIndexStore {
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID = "memory-store"
  cursor?: P2TRCanonicalBitcoinCursor
  blocks = new Map<number, string>()
  tracked = new Map<string, P2TRTrackedOutpoint>()
  candidates: P2TRCanonicalBitcoinScan["candidates"] = []
  journal: P2TRCanonicalBitcoinBlock[] = []
  registeredWalletIDs = new Set<string>()
  deliveredCandidates = new Set<string>()
  lastRegisteredParticipant?: object

  registerP2TRSignatureFraudWatchtowerTransactionalParticipant(
    participant: object
  ): void {
    this.lastRegisteredParticipant = participant
  }

  async loadBitcoinCursor() {
    return this.cursor
  }

  async loadStoredBlockHash(height: number) {
    return this.blocks.get(height)
  }

  async loadTrackedOutpoints(outpoints: P2TRBitcoinOutpoint[]) {
    return outpoints.flatMap((outpoint) => {
      const tracked = this.tracked.get(`${outpoint.txid}:${outpoint.vout}`)
      return tracked === undefined ? [] : [tracked]
    })
  }

  async loadRegisteredWalletIDs() {
    return [...this.registeredWalletIDs]
  }

  async loadCandidatesAbove(
    height: number
  ): Promise<P2TRCanonicalBitcoinOrphanedCandidate[]> {
    return this.candidates
      .filter((candidate) => candidate.block.height > height)
      .map(({ txid, wtxid, block }) => ({ txid, wtxid, block }))
  }

  async loadPendingCandidates(limit: number, atOrBelowHeight: number) {
    const pending = this.candidates.filter(
      (candidate) =>
        candidate.block.height <= atOrBelowHeight &&
        !this.deliveredCandidates.has(candidateKey(candidate))
    )
    return {
      candidates: pending.slice(0, limit),
      complete: pending.length <= limit,
    }
  }

  async applyBitcoinScan(scan: P2TRCanonicalBitcoinScan): Promise<void> {
    for (const height of [...this.blocks.keys()]) {
      if (height > scan.rollbackTo.height) this.blocks.delete(height)
    }
    this.candidates = this.candidates.filter(
      (candidate) => candidate.block.height <= scan.rollbackTo.height
    )
    this.journal = this.journal.filter(
      (block) => block.height <= scan.rollbackTo.height
    )
    this.deliveredCandidates = new Set(
      [...this.deliveredCandidates].filter((identity) =>
        this.candidates.some(
          (candidate) => candidateKey(candidate) === identity
        )
      )
    )
    scan.blocks.forEach((block) => this.blocks.set(block.height, block.hash))
    this.journal.push(...scan.blocks)
    scan.trackedOutpoints.forEach((tracked) =>
      this.tracked.set(`${tracked.txid}:${tracked.vout}`, tracked)
    )
    this.candidates.push(...scan.candidates)
    scan.acknowledgedCandidates.forEach((identity) =>
      this.deliveredCandidates.add(
        `${identity.blockHash}:${identity.txid}:${identity.wtxid}`
      )
    )
    this.cursor = {
      configurationFingerprint: scan.configurationFingerprint,
      network: scan.network,
      checkpoint: scan.checkpoint,
      current: scan.nextCursor,
    }
  }

  addFrostWalletBinding(walletID: string): void {
    this.registeredWalletIDs.add(walletID)
    const funding = this.journal
      .flatMap((block) =>
        block.transactions.map((transaction) => ({ block, transaction }))
      )
      .flatMap(({ block, transaction }) =>
        transaction.outputs.map((output) => ({ block, transaction, output }))
      )
      .find(({ output }) => output.scriptPubKey === `5120${walletID}`)
    if (funding === undefined) return
    const spend = this.journal
      .flatMap((block) =>
        block.transactions.map((transaction) => ({ block, transaction }))
      )
      .find(({ transaction }) =>
        transaction.inputs.some(
          (input) =>
            input.txid === funding.output.txid &&
            input.vout === funding.output.vout
        )
      )
    if (spend === undefined) return
    const candidate = {
      txid: spend.transaction.txid,
      wtxid: spend.transaction.wtxid,
      rawTransactionHex: spend.transaction.rawTransactionHex,
      block: { height: spend.block.height, hash: spend.block.hash },
      inputPrevouts: spend.transaction.inputs.map((input) => ({
        txid: input.authenticatedPrevout!.txid,
        vout: input.authenticatedPrevout!.vout,
        valueSats: input.authenticatedPrevout!.valueSats,
        scriptPubKey: input.authenticatedPrevout!.scriptPubKey,
      })),
      walletInputKeyBindings: [],
    }
    if (
      !this.candidates.some(
        (existing) => candidateKey(existing) === candidateKey(candidate)
      )
    ) {
      this.candidates.push(candidate)
    }
  }

  removeFrostWalletBinding(walletID: string): void {
    this.registeredWalletIDs.delete(walletID)
  }
}

const candidateKey = (candidate: {
  txid: string
  wtxid: string
  block: { hash: string }
}): string => `${candidate.block.hash}:${candidate.txid}:${candidate.wtxid}`

const fundingBlock = (): P2TRCanonicalBitcoinBlock => ({
  height: 1,
  hash: BLOCK_ONE_HASH,
  parentHash: CHECKPOINT_HASH,
  rawBlockHex: "00",
  transactions: [
    {
      txid: FUNDING_TXID,
      wtxid: FUNDING_TXID,
      rawTransactionHex: "00",
      coinbase: true,
      inputs: [],
      outputs: [
        {
          txid: FUNDING_TXID,
          vout: 0,
          valueSats: 10_000,
          scriptPubKey: `5120${WALLET_ID}`,
        },
      ],
    },
  ],
})

const spendingBlock = (
  hash: string,
  wtxid: string
): P2TRCanonicalBitcoinBlock => ({
  height: 2,
  hash,
  parentHash: BLOCK_ONE_HASH,
  rawBlockHex: "00",
  transactions: [
    {
      txid: SPENDING_TXID,
      wtxid,
      rawTransactionHex: "00",
      coinbase: false,
      inputs: [
        {
          txid: FUNDING_TXID,
          vout: 0,
          spendingTxid: SPENDING_TXID,
          inputIndex: 0,
          authenticatedPrevout: {
            txid: FUNDING_TXID,
            vout: 0,
            valueSats: 10_000,
            scriptPubKey: `5120${WALLET_ID}`,
          },
        },
      ],
      outputs: [
        {
          txid: SPENDING_TXID,
          vout: 0,
          valueSats: 9_000,
          scriptPubKey: "51",
        },
      ],
    },
  ],
})
