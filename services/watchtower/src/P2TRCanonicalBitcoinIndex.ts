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
  trustDomainID: string
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
  /** Exact consensus block header bytes, including the declared PoW target. */
  header80Hex: string
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
  /** Present only after the candidate is durable and claimable. */
  provenanceFingerprint?: string
  provenanceGeneration?: number
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
  trustDomainID: string
  checkpoint: P2TRBitcoinChainPoint
  /**
   * Authenticated immutable evidence for the configured checkpoint. It is
   * required even when the checkpoint is genesis; stores must never
   * synthesize a checkpoint row from a hash-only configuration value.
   */
  checkpointBlock: P2TRCanonicalBitcoinBlock
  expectedCursor?: P2TRBitcoinChainPoint
  rollbackTo: P2TRBitcoinChainPoint
  nextCursor: P2TRBitcoinChainPoint
  sampledFinalizedHead: P2TRBitcoinChainPoint
  complete: boolean
  blocks: P2TRCanonicalBitcoinBlock[]
  trackedOutpoints: P2TRTrackedOutpoint[]
  trackedOutpointSpends: P2TRTrackedOutpointSpend[]
  candidates: P2TRCanonicalBitcoinCandidate[]
  /**
   * Exact generation-pinned input-observation page processed by the caller.
   * The store validates and records this acknowledgement in the same
   * transaction as the canonical scan mutation.
   */
  candidateObservationAcknowledgement?: P2TRCandidateObservationPageAcknowledgement
  /** Explicitly forbidden for genesis-backed production scans. */
  testOnlyAcknowledgedCandidates?: P2TRCandidateProvenanceIdentity[]
  orphanedCandidates: P2TRCanonicalBitcoinOrphanedCandidate[]
}

export interface P2TRCanonicalBitcoinBlockSource {
  /** Opaque operational trust-domain identity for this Bitcoin Core node. */
  readonly trustDomainID: string
  readonly network: string
  /** Exact configured genesis hash for `network`. */
  readonly genesisHash: string

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
  /** Latest exact canonical output occurrence retained before the scan cursor. */
  loadLatestCanonicalOutputs(
    outpoints: P2TRBitcoinOutpoint[]
  ): Promise<P2TRCanonicalBitcoinOutput[]>
  loadRegisteredWalletIDs(): Promise<string[]>
  loadCandidatesAbove(
    height: number
  ): Promise<P2TRCanonicalBitcoinOrphanedCandidate[]>
  loadPendingCandidateObservations(
    request: P2TRCandidateObservationPageRequest
  ): Promise<P2TRCandidateObservationPage>
  applyBitcoinScan(scan: P2TRCanonicalBitcoinScan): Promise<void>
}

export type P2TRCompleteAuthorizationDomain = {
  protocolID: string
  domainChainID: string
  bridgeAddress: string
  domainDigest: string
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
  walletPubKeyHash: string
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

export type P2TRCandidateProvenanceIdentity =
  P2TRCanonicalBitcoinCandidateIdentity & {
    provenanceFingerprint: string
    provenanceGeneration: number
  }

export type P2TRCandidateInputProvenance = {
  inputIndex: number
  fundingBlockHash: string
  fundingTxid: string
  fundingVout: number
  walletID: string
  outputKey: string
  bindingKind: P2TRTrackedOutpointKind
  sourceEventID: string
  ethereumBlockNumber: number
  ethereumBlockHash: string
}

export type P2TRCompleteV2CandidateCommitments = {
  rawTransactionDigest: string
  rawTransactionBytes: number
  witnessDigest: string
  annexDigest: string
  prevoutVectorRoot: string
  prevoutCount: number
  prevoutBytes: number
  shaPrevouts: string
  shaAmounts: string
  shaScriptPubKeys: string
  shaSequences: string
  shaOutputs: string
  candidateBlockHeaderHash: string
  fundingBlockHeaderHash: string
}

export type P2TRCompleteV2CandidateObservation = {
  schema: "tbtc-p2tr-complete-candidate/v2"
  protocolID: string
  txid: string
  wtxid: string
  blockHeight: number
  blockHash: string
  inputIndex: number
  evidence: {
    walletID: string
    signingKey: string
    bindingTxHash: string
    bindingOutputIndex: number
    sighashType: number
    sighash: string
    nonceX: string
    signatureScalar: string
  }
  /** Canonical local identity for this exact input/provenance occurrence. */
  occurrenceID: string
  /** On-chain challenge-series identity; it is intentionally not unique here. */
  challengeIdentity: string
  commitments: P2TRCompleteV2CandidateCommitments
  inputProvenance: P2TRCandidateInputProvenance
  provenanceGeneration: number
  provenanceFingerprint: string
}

export type P2TRCandidateInputDispositionBase = {
  schema: "tbtc-p2tr-candidate-input-disposition/v1"
  txid: string
  wtxid: string
  blockHeight: number
  blockHash: string
  inputIndex: number
  witnessDigest: string
  inputProvenance: P2TRCandidateInputProvenance
  provenanceGeneration: number
  provenanceFingerprint: string
}

/**
 * Every canonically tracked P2TR input has exactly one durable disposition.
 * Absence is never interpreted as an authenticated refund or as safe history.
 */
export type P2TRCandidateInputDisposition =
  | (P2TRCandidateInputDispositionBase & {
      disposition: "key-path"
      deliveryState: "pending" | "delivered"
      observation: P2TRCompleteV2CandidateObservation
    })
  | (P2TRCandidateInputDispositionBase & {
      disposition: "authenticated-refund"
      terminal: true
    })
  | (P2TRCandidateInputDispositionBase & {
      disposition: "malformed" | "ambiguous"
      blocking: true
      reason: string
    })

export type P2TRCandidateObservationIdentity = {
  occurrenceID: string
  blockHash: string
  txid: string
  wtxid: string
  inputIndex: number
  challengeIdentity: string
  provenanceGeneration: number
  provenanceFingerprint: string
}

/** Immutable database generation against which one compact page is read. */
export type P2TRCanonicalGenerationIdentity = {
  generationID: number
  manifestDigest: string
  domainDigest: string
}

export type P2TRCandidateObservationPageCursor = {
  generation: P2TRCanonicalGenerationIdentity
  /** Opaque, checksummed exclusive lower bound within `generation`. */
  after?: string
}

export type P2TRCandidateObservationPageRequest = {
  limit: number
  atOrBelowHeight: number
  /** Omit only to pin the latest committed generation. */
  generation?: P2TRCanonicalGenerationIdentity
  /** Opaque exclusive lower bound returned by an earlier page. */
  after?: string
}

export type P2TRCandidateObservationPage =
  | {
      /** No authenticated generation exists yet; the index must advance. */
      state: "indexing"
      observations: []
      complete: false
    }
  | {
      state: "ready"
      generation: P2TRCanonicalGenerationIdentity
      observations: P2TRCompleteV2CandidateObservation[]
      nextAfter?: string
      /** True only when the pinned generation has no later matching row. */
      complete: boolean
    }

export type P2TRCandidateObservationPageAcknowledgement = {
  schema: "tbtc-p2tr-candidate-observation-page-acknowledgement/v1"
  generation: P2TRCanonicalGenerationIdentity
  after?: string
  nextAfter?: string
  complete: boolean
  observations: P2TRCandidateObservationIdentity[]
}

export type P2TRCanonicalCandidateObservationSourceResult = {
  observations: P2TRCompleteV2CandidateObservation[]
  complete: boolean
  page:
    | { state: "indexing"; complete: false }
    | (P2TRCandidateObservationPageCursor & {
        state: "ready"
        complete: boolean
      })
  registeredWalletIDs: string[]
  orphanedConfirmedTransactions: P2TRCanonicalBitcoinOrphanedCandidate[]
  scan: {
    rollbackTo: P2TRBitcoinChainPoint
    nextCursor: P2TRBitcoinChainPoint
    sampledFinalizedHead: P2TRBitcoinChainPoint
    orphanedCandidates: P2TRCanonicalBitcoinOrphanedCandidate[]
  }
}

/** Production consumer boundary. It never yields whole historical prevout vectors. */
export interface P2TRCanonicalCandidateObservationSource {
  listConfirmedCandidateObservations(
    cursor?: P2TRCandidateObservationPageCursor
  ): Promise<P2TRCanonicalCandidateObservationSourceResult>
  commitConfirmedCandidateObservationScan(): Promise<void>
  abortConfirmedCandidateObservationScan(): Promise<void> | void
}

/**
 * Transaction-locked authoritative material used to authorize one exact
 * witness observation. Callers must reconstruct the observation from the raw
 * transaction/prevouts and match its input index and funding occurrence to one
 * of `inputProvenance`; candidate identity alone is not authorization.
 */
export type P2TRLockedCandidateProvenance = P2TRCandidateProvenanceIdentity & {
  blockHeight: number
  rawTransactionHex: string
  inputPrevouts: P2TRWalletInputObservationPrevout[]
  walletInputKeyBindings: P2TRWalletInputKeyBinding[]
  inputProvenance: P2TRCandidateInputProvenance[]
}

/**
 * Legacy/custom-checkpoint rehearsal capability. Genesis-backed production
 * stores must reject this whole-transaction materialization path and expose
 * only compact, generation-pinned observations through
 * `P2TRCanonicalEvidenceStore`.
 */
export interface P2TRLegacyCandidateMaterializationStore {
  loadPendingCandidates(
    limit: number,
    atOrBelowHeight: number
  ): Promise<{
    candidates: P2TRCanonicalBitcoinCandidate[]
    complete: boolean
  }>
  lockP2TRCandidateProvenance(
    identity: P2TRCanonicalBitcoinCandidateIdentity
  ): Promise<P2TRLockedCandidateProvenance | undefined>
}

export type P2TRInvalidatedCandidateProvenance =
  P2TRCandidateProvenanceIdentity & {
    invalidationID: number
    reason: "ethereum-reorg" | "provenance-superseded"
    sourceEventIDs: string[]
    successorFingerprint?: string
  }

export type P2TRReadinessExportCandidateRequest = {
  txid: string
  wtxid: string
  blockHeight: number
  blockHash: string
  inputIndex: number
  /** Exact canonical occurrence ID, mapped to the outbox observation ID. */
  observationID: string
  /** On-chain Bridge challenge-series key. */
  challengeKey: string
  expectedProvenanceFingerprint: string
}

export const P2TR_EVIDENCE_CHUNK_MAX_BYTES = 65_536 as const

export type P2TRReadinessExportSourceSignature = {
  signingKeyID: string
  payloadDigest: string
  /** Opaque signature bytes encoded as lower-case, unprefixed hex. */
  signature: string
}

export type P2TRReadinessExportSourceIdentity = {
  storeID: string
  clusterID: string
  operatorID: string
  trustDomainID: string
  bitcoinIdentityDigest: string
  ethereumIdentityDigest: string
  identityDigest: string
  configurationFingerprint: string
}

export type P2TRReadinessExportContentManifest = {
  schema: "tbtc-p2tr-readiness-export-content/v2"
  exportID: string
  generation: P2TRCanonicalGenerationIdentity
  /** Root of the ordered immutable object inventory. */
  auditManifestRoot: string
  /** Rolling digest of every ordered object/chunk stream frame. */
  finalStreamDigest: string
  resultDigest: string
  objectCount: number
  totalBytes: number
  maxChunkBytes: typeof P2TR_EVIDENCE_CHUNK_MAX_BYTES
  sourceSignature: P2TRReadinessExportSourceSignature
}

export type P2TRReadinessExportStreamCursor = {
  streamOrdinal: number
  chunkIndex: number
}

/** One independently verifiable, at-most-64-KiB export stream frame. */
export type P2TRReadinessExportStreamFrame = {
  schema: "tbtc-p2tr-readiness-export-stream-frame/v1"
  exportID: string
  exportFence: number
  streamOrdinal: number
  streamLeafDigest: string
  object: {
    digest: string
    kind: string
    byteLength: number
    contentDigest: string
    chunkCount: number
    chunkManifestRoot: string
  }
  chunk: {
    index: number
    byteOffset: number
    digest: string
    leafDigest: string
    bytes: Uint8Array
  }
}

export type P2TRReadinessExportRequest = {
  schema: "tbtc-p2tr-readiness-export-request/v1"
  requestNonce: string
  manifestHash: string
  expiresAt: string
  candidate?: P2TRReadinessExportCandidateRequest
}

export type P2TRReadinessExport = {
  schema: "tbtc-p2tr-readiness-export/v1"
  request: P2TRReadinessExportRequest
  requestDigest: string
  exportFence: number
  snapshot: P2TRReadinessSnapshot
  candidate?: P2TRLockedCandidateProvenance
}

export type P2TRReadinessExportCandidateSummary =
  P2TRReadinessExportCandidateRequest & {
    provenanceGeneration: number
    provenanceFingerprint: string
    observation: P2TRCompleteV2CandidateObservation
  }

export type P2TRReadinessExportHandle = {
  schema: "tbtc-p2tr-readiness-export-handle/v1"
  exportID: string
  requestNonce: string
  request: P2TRReadinessExportRequest
  requestDigest: string
  exportFence: number
  snapshotRoot: string
  snapshotSemanticRoot: string
  snapshotGeneration: number
  resultDigest: string
  candidate?: P2TRReadinessExportCandidateSummary
  snapshot: P2TRReadinessSnapshot
  authorizationDomain: P2TRCompleteAuthorizationDomain
  sourceIdentity: P2TRReadinessExportSourceIdentity
  contentManifest: P2TRReadinessExportContentManifest
}

export type P2TRReadinessExportAcknowledgement = {
  schema: "tbtc-p2tr-readiness-export-acknowledgement/v1"
  requestNonce: string
  requestDigest: string
  exportFence: number
  snapshotRoot: string
  resultDigest: string
  consumerID: string
  auditManifestRoot: string
  finalStreamDigest: string
  streamedObjectCount: number
  streamedBytes: number
  consumerSigningKeyID: string
  consumerSignaturePayloadDigest: string
  /** Opaque signature bytes encoded as lower-case, unprefixed hex. */
  consumerSignature: string
}

export type P2TRReadinessSnapshot = {
  storeID: string
  configurationFingerprint: string
  network: string
  trustDomainID: string
  generation: number
  /** Local monotonic/CAS root; intentionally includes operational history. */
  root: string
  /** Rebuild-stable current canonical evidence root for cross-store comparison. */
  semanticRoot: string
  authorizationDomain: P2TRCompleteAuthorizationDomain
  /** Store-local transactional authorization/page-cursor allocators. */
  allocators: {
    nextCandidateProvenanceGeneration: number
    nextInvalidationID: number
    nextExportFence: number
  }
  bitcoin: {
    checkpoint: P2TRBitcoinChainPoint
    current: P2TRBitcoinChainPoint
    chainCommitment: string
    evidenceCommitment: string
    journalCounts: {
      blocks: number
      transactions: number
      inputs: number
      outputs: number
      unresolvedInputs: number
    }
  }
  crossSourceWatermark?: P2TRCrossSourceWatermark
  projection: {
    semanticCommitment: string
    semanticRowCount: number
    /** Store-local operational projection commitment. */
    commitment: string
    rowCount: number
    walletBindings: number
    depositReveals: number
    pendingDepositReveals: number
    trackedOutpoints: number
    candidates: number
    pendingCandidates: number
    candidateInputProvenance: number
    invalidations: number
    unmatchedProofs: number
    pendingUnmatchedProofs: number
    crossSourceWatermarks: number
    pendingDepositCommitment: string
    pendingCandidateCommitment: string
    pendingProofCommitment: string
  }
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
  loadFrostWalletIDByPubKeyHash(
    walletPubKeyHash: string
  ): Promise<string | undefined>
  /** Removes Ethereum-derived state above or off the retained canonical point. */
  rollbackEthereumEvidenceTo(
    point: P2TREthereumChainPoint
  ): Promise<P2TRCandidateProvenanceIdentity[]>
  /** Writer-excluding, transaction-only activation/claim snapshot. */
  lockP2TRReadinessSnapshot(): Promise<P2TRReadinessSnapshot | undefined>
  listInvalidatedCandidateProvenance(
    afterInvalidationID: number,
    limit: number
  ): Promise<{
    invalidations: P2TRInvalidatedCandidateProvenance[]
    complete: boolean
  }>
  countPendingDepositReveals(): Promise<number>
  /**
   * Defense-in-depth activation audit. Full-history coverage is established by
   * the transaction source's genesis checkpoint handshake; this method then
   * proves every durable tracked/revealed output is inside that journal and
   * all delivery/reconciliation backlogs are empty.
   */
  assertP2TRSignatureFraudActivationIndexReady(
    genesis: P2TRBitcoinChainPoint
  ): Promise<void>
  enqueueUnmatchedProofs(proofs: P2TRUnmatchedProofEnvelope[]): Promise<void>
  listUnmatchedProofs(limit: number): Promise<P2TRUnmatchedProofEnvelope[]>
  resolveUnmatchedProofs(eventIDs: string[]): Promise<void>
  loadCrossSourceWatermark(): Promise<P2TRCrossSourceWatermark | undefined>
  advanceCrossSourceWatermark(
    expected: P2TRCrossSourceWatermark | undefined,
    next: P2TRCrossSourceWatermark
  ): Promise<void>
  /**
   * Allocates and persists a nonce-idempotent, post-fence locked snapshot.
   * This method owns its SERIALIZABLE transaction and readiness-exclusive lock.
   */
  exportP2TRReadinessSnapshot(
    request: P2TRReadinessExportRequest
  ): Promise<P2TRReadinessExportHandle>
  /** Ambiguous-commit recovery lookup for a previously committed nonce. */
  loadP2TRReadinessExportByNonce(
    requestNonce: string
  ): Promise<P2TRReadinessExportHandle | undefined>
  /** Streams immutable, manifest-authenticated frames after an optional cursor. */
  streamP2TRReadinessExportChunks(
    requestNonce: string,
    after?: P2TRReadinessExportStreamCursor
  ): AsyncIterable<P2TRReadinessExportStreamFrame>
  /** Idempotently records that the exact immutable export was consumed. */
  acknowledgeP2TRReadinessExport(
    acknowledgement: P2TRReadinessExportAcknowledgement
  ): Promise<void>
}
