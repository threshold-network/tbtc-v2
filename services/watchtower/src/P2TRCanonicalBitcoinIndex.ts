import type {
  P2TRWalletInputKeyBinding,
  P2TRWalletInputObservationPrevout,
} from "@keep-network/tbtc-v2.ts"

export type P2TRBitcoinChainPoint = {
  height: number
  /** Canonical display-order, lower-case, unprefixed block hash. */
  hash: string
}

export type P2TRCanonicalBitcoinCursor = {
  configurationFingerprint: string
  network: string
  checkpoint: P2TRBitcoinChainPoint
  current: P2TRBitcoinChainPoint
}

export type P2TRBitcoinOutpoint = {
  /** Canonical display-order, lower-case, unprefixed transaction ID. */
  txid: string
  vout: number
}

export type P2TRCanonicalBitcoinInput = P2TRBitcoinOutpoint & {
  spendingTxid: string
  inputIndex: number
  /** Bitcoin Core-validated UTXO data from block undo data (verbosity 3). */
  authenticatedPrevout?: P2TRCanonicalBitcoinOutput
}

export type P2TRCanonicalBitcoinOutput = {
  txid: string
  vout: number
  valueSats: number
  scriptPubKey: string
}

export type P2TRCanonicalBitcoinTransaction = {
  txid: string
  /** Canonical display-order witness transaction ID. */
  wtxid: string
  rawTransactionHex: string
  coinbase: boolean
  inputs: P2TRCanonicalBitcoinInput[]
  outputs: P2TRCanonicalBitcoinOutput[]
}

export type P2TRCanonicalBitcoinBlock = P2TRBitcoinChainPoint & {
  parentHash: string
  rawBlockHex: string
  transactions: P2TRCanonicalBitcoinTransaction[]
}

export type P2TRTrackedOutpointKind = "wallet" | "deposit"

export type P2TRTrackedOutpoint = P2TRBitcoinOutpoint & {
  kind: P2TRTrackedOutpointKind
  walletID: string
  outputKey: string
  valueSats: number
  scriptPubKey: string
  createdAt: P2TRBitcoinChainPoint
}

export type P2TRTrackedOutpointSpend = P2TRBitcoinOutpoint & {
  spendingTxid: string
  spendingWtxid: string
  inputIndex: number
  spentAt: P2TRBitcoinChainPoint
}

export type P2TRCanonicalBitcoinCandidate = {
  txid: string
  wtxid: string
  rawTransactionHex: string
  block: P2TRBitcoinChainPoint
  inputPrevouts: P2TRWalletInputObservationPrevout[]
  walletInputKeyBindings: P2TRWalletInputKeyBinding[]
}

export type P2TRCanonicalBitcoinOrphanedCandidate = {
  txid: string
  wtxid: string
  block: P2TRBitcoinChainPoint
}

export type P2TRCanonicalBitcoinCandidateIdentity = {
  txid: string
  wtxid: string
  blockHash: string
}

/**
 * One bounded, canonical Bitcoin journal mutation. The expected cursor and
 * rollback point make stale writers and unbounded reorg recovery fail closed.
 */
export type P2TRCanonicalBitcoinScan = {
  configurationFingerprint: string
  network: string
  checkpoint: P2TRBitcoinChainPoint
  expectedCursor?: P2TRBitcoinChainPoint
  rollbackTo: P2TRBitcoinChainPoint
  nextCursor: P2TRBitcoinChainPoint
  sampledFinalizedHead: P2TRBitcoinChainPoint
  complete: boolean
  blocks: P2TRCanonicalBitcoinBlock[]
  trackedOutpoints: P2TRTrackedOutpoint[]
  trackedOutpointSpends: P2TRTrackedOutpointSpend[]
  candidates: P2TRCanonicalBitcoinCandidate[]
  /** Candidate deliveries processed by the caller in this staged batch. */
  acknowledgedCandidates: P2TRCanonicalBitcoinCandidateIdentity[]
  orphanedCandidates: P2TRCanonicalBitcoinOrphanedCandidate[]
}

export interface P2TRCanonicalBitcoinBlockSource {
  /** Opaque operational trust-domain identity for this Bitcoin Core node. */
  readonly trustDomainID: string
  readonly network: string

  /** Returns only a fully synchronized canonical node head. */
  getSyncedHead(): Promise<P2TRBitcoinChainPoint>
  getBlockHash(height: number): Promise<string>
  getBlock(height: number): Promise<P2TRCanonicalBitcoinBlock>
  /** Returns and authenticates raw bytes against the requested txid. */
  getRawTransaction(txid: string): Promise<P2TRCanonicalBitcoinTransaction>
}

export interface P2TRCanonicalBitcoinIndexStore {
  readonly p2trSignatureFraudWatchtowerStoreProfile: "transactional-production"
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  registerP2TRSignatureFraudWatchtowerTransactionalParticipant(
    participant: object
  ): void

  loadBitcoinCursor(): Promise<P2TRCanonicalBitcoinCursor | undefined>
  loadStoredBlockHash(height: number): Promise<string | undefined>
  loadTrackedOutpoints(
    outpoints: P2TRBitcoinOutpoint[]
  ): Promise<P2TRTrackedOutpoint[]>
  loadRegisteredWalletIDs(): Promise<string[]>
  loadCandidatesAbove(
    height: number
  ): Promise<P2TRCanonicalBitcoinOrphanedCandidate[]>
  loadPendingCandidates(
    limit: number,
    atOrBelowHeight: number
  ): Promise<{
    candidates: P2TRCanonicalBitcoinCandidate[]
    complete: boolean
  }>
  applyBitcoinScan(scan: P2TRCanonicalBitcoinScan): Promise<void>
}

export type P2TRTaprootDepositBinding = P2TRBitcoinOutpoint & {
  walletID: string
  outputKey: string
  /** Canonical Ethereum event identity that established the binding. */
  sourceEventID: string
  ethereum: P2TREthereumChainPoint
}

export type P2TRFrostWalletBinding = {
  walletID: string
  sourceEventID: string
  ethereum: P2TREthereumChainPoint
}

export type P2TREthereumChainPoint = {
  blockNumber: number
  blockHash: string
}

export type P2TRCrossSourceWatermark = {
  bitcoin: P2TRBitcoinChainPoint
  ethereum: P2TREthereumChainPoint
}

export type P2TRUnmatchedProofEnvelope = {
  /** Chain/emitter/block-hash/log-index-derived, canonical event identity. */
  eventID: string
  ethereum: P2TREthereumChainPoint & {
    transactionHash: string
    logIndex: number
  }
  bitcoinTxid: string
  walletID: string
  spendType: string
  /** Normalized decoded evidence retained losslessly for later reconciliation. */
  payload: Readonly<Record<string, unknown>>
}

/**
 * Production-only storage capabilities used by the Bitcoin and Ethereum
 * indexers. Every mutating call participates in the coordinator transaction
 * when one is active.
 */
export interface P2TRCanonicalEvidenceStore
  extends P2TRCanonicalBitcoinIndexStore {
  addTaprootDepositBindings(
    bindings: P2TRTaprootDepositBinding[]
  ): Promise<void>
  addFrostWalletBindings(bindings: P2TRFrostWalletBinding[]): Promise<void>
  /** Removes Ethereum-derived state above or off the retained canonical point. */
  rollbackEthereumEvidenceTo(point: P2TREthereumChainPoint): Promise<void>
  countPendingDepositReveals(): Promise<number>
  enqueueUnmatchedProofs(proofs: P2TRUnmatchedProofEnvelope[]): Promise<void>
  listUnmatchedProofs(limit: number): Promise<P2TRUnmatchedProofEnvelope[]>
  resolveUnmatchedProofs(eventIDs: string[]): Promise<void>
  loadCrossSourceWatermark(): Promise<P2TRCrossSourceWatermark | undefined>
  advanceCrossSourceWatermark(
    expected: P2TRCrossSourceWatermark | undefined,
    next: P2TRCrossSourceWatermark
  ): Promise<void>
}
