import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto"
import {
  assertP2TRVerifiedCompleteCandidateIdentity,
  normalizeP2TRCompleteBridgeDomain,
  normalizeP2TRCompleteCandidateIdentity,
  verifyP2TRCompleteCandidateIdentity,
  type P2TRCompleteBridgeDomain,
  type P2TRCompleteCandidateInputProvenance,
  type P2TRCompleteCandidateIdentity,
  type P2TRVerifiedCompleteCandidateIdentity,
} from "./P2TRCompleteCandidateIdentity.js"

type P2TRProductionCandidateInputProvenance =
  P2TRCompleteCandidateInputProvenance

export const P2TR_RECONCILER_EXPORT_CHUNK_BYTES = 65536 as const

/**
 * Names the durable slot AND what is actually signed for it: the lane whose
 * signer is called, the transaction intent, and the lane-specific fee envelope
 * handed to that signer. Field order is load-bearing — see the note on
 * `normalizeRequestBinding`.
 */
export type P2TRReconcilerRequestBinding = {
  recordID: string
  recordGeneration: number
  recordVersion: number
  reservationID: string
  sender: string
  transactionNonce: number
  stage: "prepare" | "replacement" | "broadcast"
  attempt: number
  provenanceFingerprint: string
  activationManifestHash: string
  /** The lane selects both which signer is invoked and which envelope applies. */
  laneID: string
  signerIdentity: string
  /**
   * Recomputed from the intent at the boundary, never copied from durable
   * state. It commits to the router, the calldata and the value.
   */
  intentID: string
  /** Carried in the clear as well: an authorizer cannot invert `intentID`. */
  routerAddress: string
  intentValueWei: string
  challengeValueWei: string
  maxGasLimit: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  maxTotalFeeWei: string
  /** Required only for a replacement boundary: the variant being superseded. */
  replacedTransactionHash?: string
  /** Required only for a broadcaster boundary. */
  preparedTransactionHash?: string
}

export type P2TRReconcilerCandidateRequest = {
  identity: P2TRCompleteCandidateIdentity
  inputProvenance: P2TRProductionCandidateInputProvenance
  provenanceFingerprint: string
}

export type P2TRReconcilerCandidateAttestationChallenge = {
  schema: "tbtc-p2tr-reconciler-complete-candidate-challenge/v4"
  requestNonce: string
  manifestHash: string
  requestBinding: P2TRReconcilerRequestBinding
  requestBindingDigest: string
  bridgeDomain: P2TRCompleteBridgeDomain
  expectedReadinessSemanticRoot: string
  expectedBitcoinPoint: { height: number; hash: string }
  candidate: P2TRReconcilerCandidateRequest
  candidateDigest: string
}

export type P2TRReconcilerReadinessSnapshot = {
  storeID: string
  configurationFingerprint: string
  network: string
  trustDomainID: string
  generation: number
  root: string
  semanticRoot: string
  allocators: {
    nextCandidateProvenanceGeneration: number
    nextInvalidationID: number
    nextExportFence: number
  }
  bitcoin: {
    checkpoint: { height: number; hash: string }
    current: { height: number; hash: string }
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
  crossSourceWatermark?: {
    bitcoin: { height: number; hash: string }
    ethereum: { blockNumber: number; blockHash: string }
  }
  projection: {
    semanticCommitment: string
    semanticRowCount: number
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

export type P2TRReconcilerExportContentManifest = {
  schema: "tbtc-p2tr-readiness-export-content/v1"
  exportID: string
  root: string
  resultDigest: string
  chunkCount: number
  totalBytes: number
  chunkBytes: 65536
  orderedChunkHashes: readonly string[]
}

export type P2TRReconcilerExportCandidateSummary = {
  candidateDigest: string
  identity: P2TRCompleteCandidateIdentity
  provenanceGeneration: number
  provenanceFingerprint: string
  inputProvenance: P2TRProductionCandidateInputProvenance
  recomputation: P2TRReconcilerFullStreamRecomputation
}

export type P2TRReconcilerStreamComputation = {
  schema: "tbtc-p2tr-full-stream-recomputation/v1"
  protocolID: string
  canonicalStreamSchema: "tbtc-p2tr-canonical-candidate-stream/v1"
  inputIndex: number
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
  computedSighash: string
  candidateBlockHeaderHash: string
  fundingBlockHeaderHash: string
  allInputsConsumed: true
}

export type P2TRReconcilerFullStreamRecomputation =
  P2TRReconcilerStreamComputation & {
    auditContentRoot: string
    auditResultDigest: string
  }

export type P2TRReconcilerAuditExportCandidateSummary = Omit<
  P2TRReconcilerExportCandidateSummary,
  "recomputation"
> & {
  recomputation: P2TRReconcilerStreamComputation
}

export type P2TRReconcilerReadinessExportHandle = {
  schema: "tbtc-p2tr-readiness-export-handle/v1"
  requestNonce: string
  requestDigest: string
  exportFence: number
  snapshotRoot: string
  snapshotSemanticRoot: string
  snapshotGeneration: number
  snapshot: P2TRReconcilerReadinessSnapshot
  candidate: P2TRReconcilerExportCandidateSummary
  contentManifest: P2TRReconcilerExportContentManifest
}

export type P2TRReconcilerAttestationSource = {
  trustDomainID: string
  endpointFingerprint: string
  operatorFingerprint: string
  storeID: string
  storeFingerprint: string
  attestationKeyHash: string
}

export type P2TRReconcilerCandidateAttestationPayload = {
  schema: "tbtc-p2tr-reconciler-complete-candidate-attestation/v4"
  requestNonce: string
  manifestHash: string
  requestBinding: P2TRReconcilerRequestBinding
  requestBindingDigest: string
  source: P2TRReconcilerAttestationSource
  issuedAtUnixMs: number
  expiresAtUnixMs: number
  export: P2TRReconcilerReadinessExportHandle
}

export type P2TRSignedReconcilerCandidateAttestation = {
  payload: P2TRReconcilerCandidateAttestationPayload
  signatureAlgorithm: "ed25519"
  signerPublicKeySpki: string
  signature: string
}

export type P2TRReconcilerCandidateAttestationProvider = {
  readonly trustDomainID: string
  readonly endpointFingerprint: string
  readonly operatorFingerprint: string
  readonly storeID: string
  readonly storeFingerprint: string
  readonly attestationKeyHash: string
  attestCandidate(
    challenge: P2TRReconcilerCandidateAttestationChallenge
  ): Promise<P2TRSignedReconcilerCandidateAttestation>
  loadCandidateEvidenceChunk(
    requestNonce: string,
    index: number
  ): AsyncIterable<Uint8Array>
}

/** Result of bounded streaming, whole-digest verification and exact decoding. */
export type P2TRStreamVerifiedReconcilerExport = {
  snapshot: P2TRReconcilerReadinessSnapshot
  candidate: P2TRReconcilerAuditExportCandidateSummary
  resultDigest: string
  contentRoot: string
  rawTransactionDigest: string
  candidateBlockHeaderHash: string
  fundingBlockHeaderHash: string
}

export type P2TRDecodedReconcilerExport = Omit<
  P2TRStreamVerifiedReconcilerExport,
  "resultDigest" | "contentRoot"
>

/**
 * A transactional decoder: `write` must not publish side effects, and
 * `finish` may materialize its result only after the caller has supplied the
 * complete canonical export. Implementations are expected to parse bounded
 * frames and stream raw transaction/prevout blobs rather than concatenate.
 */
export type P2TRReconcilerExportStreamDecoder = {
  write(fragment: Uint8Array): void | Promise<void>
  finish(): P2TRDecodedReconcilerExport | Promise<P2TRDecodedReconcilerExport>
  abort?(reason: unknown): void | Promise<void>
}

export type P2TRReconcilerCandidateAttestationVerificationPolicy = {
  expectedSource: P2TRReconcilerAttestationSource
  trustedSignerKeyHash: string
  minimumExportFenceExclusive: number
  maximumLifetimeMs: number
  maximumClockSkewMs: number
  maximumExportBytes: number
  maximumExportChunks: number
  expectedRecomputationProtocolID: string
  nowUnixMs?: () => number
}

const verifiedAttestations = new WeakSet<object>()
const verifiedAttestationBrand: unique symbol = Symbol(
  "P2TRVerifiedReconcilerCandidateAttestation"
)

export type P2TRVerifiedReconcilerCandidateAttestation = {
  readonly [verifiedAttestationBrand]: true
  readonly envelope: Readonly<P2TRSignedReconcilerCandidateAttestation>
  readonly payload: Readonly<P2TRReconcilerCandidateAttestationPayload>
  readonly completeIdentity: P2TRVerifiedCompleteCandidateIdentity
  readonly attestationDigest: string
}

export function computeP2TRReconcilerRequestBindingDigest(
  value: P2TRReconcilerRequestBinding
): string {
  return sha256({
    schema: "tbtc-p2tr-reconciler-request-binding/v3",
    binding: normalizeRequestBinding(value),
  })
}

export function computeP2TRReconcilerCandidateDigest(
  value: P2TRReconcilerCandidateRequest
): string {
  return sha256({
    schema: "tbtc-p2tr-reconciler-complete-candidate/v2",
    candidate: normalizeCandidateRequest(value),
  })
}

export function computeP2TRReconcilerChallengeRequestDigest(
  value: P2TRReconcilerCandidateAttestationChallenge
): string {
  return sha256({
    schema: "tbtc-p2tr-reconciler-complete-request/v4",
    challenge: normalizeChallenge(value),
  })
}

export function computeP2TRReconcilerExportChunkHash(
  index: number,
  totalBytes: number,
  chunk: Uint8Array
): string {
  const indexBytes = Buffer.alloc(4)
  indexBytes.writeUInt32BE(uint32(index, "export chunk index"))
  const totalBytesBuffer = Buffer.alloc(8)
  totalBytesBuffer.writeBigUInt64BE(
    BigInt(nonNegativeInteger(totalBytes, "export total bytes"))
  )
  return createHash("sha256")
    .update("tbtc-p2tr-readiness-export-chunk/v1\0", "utf8")
    .update(indexBytes)
    .update(totalBytesBuffer)
    .update(chunk)
    .digest("hex")
}

export function computeP2TRReconcilerExportContentRoot(
  manifest: Omit<P2TRReconcilerExportContentManifest, "root">
): string {
  return sha256(normalizeManifestCore(manifest))
}

/**
 * Authenticates a fixed-size export stream with at most one 64 KiB fragment in
 * flight. It never concatenates the export. Exact semantic decoding and raw
 * Bitcoin/BIP-341 verification are delegated to a bounded transactional
 * decoder so deployments can use the canonical index's framed wire codec.
 */
export async function streamAndVerifyP2TRReconcilerExport(
  provider: Pick<
    P2TRReconcilerCandidateAttestationProvider,
    "loadCandidateEvidenceChunk"
  >,
  handleValue: P2TRReconcilerReadinessExportHandle,
  decoder: P2TRReconcilerExportStreamDecoder
): Promise<P2TRStreamVerifiedReconcilerExport> {
  const handle = normalizeExportHandle(handleValue)
  const manifest = handle.contentManifest
  if (manifest.exportID !== handle.requestNonce) {
    throw new Error("Reconciler export manifest names another export")
  }
  const resultHasher = createHash("sha256")
  try {
    for (let index = 0; index < manifest.chunkCount; index++) {
      const expectedLength = Math.min(
        P2TR_RECONCILER_EXPORT_CHUNK_BYTES,
        manifest.totalBytes - index * P2TR_RECONCILER_EXPORT_CHUNK_BYTES
      )
      const indexBytes = Buffer.alloc(4)
      indexBytes.writeUInt32BE(index)
      const totalBytes = Buffer.alloc(8)
      totalBytes.writeBigUInt64BE(BigInt(manifest.totalBytes))
      const chunkHasher = createHash("sha256")
        .update("tbtc-p2tr-readiness-export-chunk/v1\0", "utf8")
        .update(indexBytes)
        .update(totalBytes)
      let received = 0
      for await (const fragmentValue of provider.loadCandidateEvidenceChunk(
        handle.requestNonce,
        index
      )) {
        if (!(fragmentValue instanceof Uint8Array)) {
          throw new Error("Reconciler export yielded a non-byte fragment")
        }
        const fragment = Buffer.from(
          fragmentValue.buffer,
          fragmentValue.byteOffset,
          fragmentValue.byteLength
        )
        if (
          fragment.length === 0 ||
          fragment.length > P2TR_RECONCILER_EXPORT_CHUNK_BYTES ||
          received + fragment.length > expectedLength
        ) {
          throw new Error("Reconciler export chunk length is invalid")
        }
        received += fragment.length
        chunkHasher.update(fragment)
        resultHasher.update(fragment)
        await decoder.write(fragment)
      }
      if (
        received !== expectedLength ||
        chunkHasher.digest("hex") !== manifest.orderedChunkHashes[index]
      ) {
        throw new Error("Reconciler export chunk is truncated or corrupt")
      }
    }
    if (resultHasher.digest("hex") !== manifest.resultDigest) {
      throw new Error("Reconciler export result digest is invalid")
    }
    const verified = normalizeStreamVerifiedExport({
      ...(await decoder.finish()),
      resultDigest: manifest.resultDigest,
      contentRoot: manifest.root,
    })
    if (
      canonicalJSON(verified.snapshot) !== canonicalJSON(handle.snapshot) ||
      canonicalJSON(verified.candidate) !==
        canonicalJSON(toAuditCandidateSummary(handle.candidate)) ||
      verified.rawTransactionDigest !==
        handle.candidate.recomputation.rawTransactionDigest ||
      verified.candidateBlockHeaderHash !==
        handle.candidate.recomputation.candidateBlockHeaderHash ||
      verified.fundingBlockHeaderHash !==
        handle.candidate.recomputation.fundingBlockHeaderHash
    ) {
      throw new Error("Audited export disagrees with compact attestation")
    }
    return verified
  } catch (error) {
    await decoder.abort?.(error)
    throw error
  }
}

function toAuditCandidateSummary(
  value: P2TRReconcilerExportCandidateSummary
): P2TRReconcilerAuditExportCandidateSummary {
  const {
    auditContentRoot: _root,
    auditResultDigest: _digest,
    ...recomputation
  } = value.recomputation
  return {
    ...value,
    recomputation,
  }
}

export async function verifyP2TRReconcilerCandidateAttestation(
  envelopeValue: P2TRSignedReconcilerCandidateAttestation,
  challengeValue: P2TRReconcilerCandidateAttestationChallenge,
  policy: P2TRReconcilerCandidateAttestationVerificationPolicy
): Promise<P2TRVerifiedReconcilerCandidateAttestation> {
  const challenge = normalizeChallenge(challengeValue)
  const envelope = normalizeEnvelope(envelopeValue)
  const payload = envelope.payload
  const expectedSource = normalizeSource(policy.expectedSource)
  const completeIdentity = verifyP2TRCompleteCandidateIdentity(
    challenge.candidate.identity,
    challenge.bridgeDomain
  )
  if (
    payload.requestNonce !== challenge.requestNonce ||
    payload.manifestHash !== challenge.manifestHash ||
    canonicalJSON(payload.requestBinding) !==
      canonicalJSON(challenge.requestBinding) ||
    payload.requestBindingDigest !== challenge.requestBindingDigest ||
    canonicalJSON(payload.source) !== canonicalJSON(expectedSource) ||
    payload.export.requestNonce !== challenge.requestNonce ||
    payload.export.requestDigest !==
      computeP2TRReconcilerChallengeRequestDigest(challenge) ||
    payload.export.contentManifest.exportID !== challenge.requestNonce ||
    payload.export.candidate.candidateDigest !== challenge.candidateDigest
  ) {
    throw new Error("Reconciler attestation is not bound to its exact request")
  }

  assertFresh(payload, policy)
  assertManifestBounds(payload.export.contentManifest, policy)
  verifyEnvelopeSignature(envelope, policy.trustedSignerKeyHash)
  const snapshot = payload.export.snapshot
  const candidate = payload.export.candidate
  const recomputation = candidate.recomputation
  if (
    snapshot.root !== payload.export.snapshotRoot ||
    snapshot.semanticRoot !== payload.export.snapshotSemanticRoot ||
    snapshot.generation !== payload.export.snapshotGeneration ||
    snapshot.allocators.nextExportFence <= payload.export.exportFence ||
    snapshot.semanticRoot !== challenge.expectedReadinessSemanticRoot ||
    canonicalJSON(snapshot.bitcoin.current) !==
      canonicalJSON(challenge.expectedBitcoinPoint) ||
    snapshot.storeID !== payload.source.storeID ||
    snapshot.trustDomainID !== payload.source.trustDomainID ||
    canonicalJSON(candidate.identity) !==
      canonicalJSON(challenge.candidate.identity) ||
    canonicalJSON(candidate.inputProvenance) !==
      canonicalJSON(challenge.candidate.inputProvenance) ||
    candidate.provenanceFingerprint !==
      challenge.candidate.provenanceFingerprint ||
    recomputation.protocolID !==
      bytes32(
        policy.expectedRecomputationProtocolID,
        "expected recomputation protocol"
      ) ||
    recomputation.inputIndex !== candidate.identity.inputIndex ||
    recomputation.computedSighash !== candidate.identity.evidence.sighash ||
    recomputation.candidateBlockHeaderHash !==
      challenge.candidate.identity.blockHash ||
    recomputation.fundingBlockHeaderHash !==
      challenge.candidate.inputProvenance.fundingBlockHash ||
    recomputation.auditContentRoot !== payload.export.contentManifest.root ||
    recomputation.auditResultDigest !==
      payload.export.contentManifest.resultDigest
  ) {
    throw new Error("Compact reconciler attestation is internally inconsistent")
  }
  assertP2TRVerifiedCompleteCandidateIdentity(completeIdentity, {
    inputIndex: candidate.identity.inputIndex,
    challengeIdentity: candidate.identity.challengeIdentity,
  })

  const result = Object.freeze({
    [verifiedAttestationBrand]: true as const,
    envelope: deepFreeze(structuredClone(envelope)),
    payload: deepFreeze(structuredClone(payload)),
    completeIdentity,
    attestationDigest: sha256({
      schema: "tbtc-p2tr-signed-reconciler-complete-attestation/v4",
      envelope,
    }),
  }) as P2TRVerifiedReconcilerCandidateAttestation
  verifiedAttestations.add(result)
  return result
}

export function assertP2TRVerifiedReconcilerCandidateAttestation(
  value: P2TRVerifiedReconcilerCandidateAttestation,
  expected: {
    requestNonce: string
    requestBindingDigest: string
    minimumExportFenceExclusive: number
    nowUnixMs?: number
  }
): Readonly<P2TRReconcilerCandidateAttestationPayload> {
  if (!verifiedAttestations.has(value as object)) {
    throw new Error("Reconciler attestation was not verified by this runtime")
  }
  const payload = value.payload
  if (
    payload.requestNonce !== bytes32(expected.requestNonce, "request nonce") ||
    payload.requestBindingDigest !==
      bytes32(expected.requestBindingDigest, "request binding digest") ||
    payload.export.exportFence <=
      nonNegativeInteger(
        expected.minimumExportFenceExclusive,
        "minimum export fence"
      ) ||
    payload.expiresAtUnixMs <=
      nonNegativeInteger(
        expected.nowUnixMs ?? Date.now(),
        "attestation assertion time"
      )
  ) {
    throw new Error(
      "Verified reconciler attestation is stale or for another attempt"
    )
  }
  return payload
}

function assertFresh(
  payload: P2TRReconcilerCandidateAttestationPayload,
  policy: P2TRReconcilerCandidateAttestationVerificationPolicy
): void {
  const now = nonNegativeInteger(
    (policy.nowUnixMs ?? Date.now)(),
    "reconciler verification time"
  )
  if (
    payload.issuedAtUnixMs >
      now + nonNegativeInteger(policy.maximumClockSkewMs, "clock skew") ||
    payload.expiresAtUnixMs <= now ||
    payload.expiresAtUnixMs - payload.issuedAtUnixMs >
      positiveInteger(policy.maximumLifetimeMs, "attestation lifetime") ||
    payload.export.exportFence <=
      nonNegativeInteger(
        policy.minimumExportFenceExclusive,
        "minimum export fence"
      )
  ) {
    throw new Error("Reconciler attestation is stale, expired, or overlong")
  }
}

function assertManifestBounds(
  manifest: P2TRReconcilerExportContentManifest,
  policy: P2TRReconcilerCandidateAttestationVerificationPolicy
): void {
  if (
    manifest.totalBytes >
      positiveInteger(policy.maximumExportBytes, "export byte bound") ||
    manifest.chunkCount >
      positiveInteger(policy.maximumExportChunks, "export chunk bound")
  ) {
    throw new Error("Reconciler export exceeds its streaming bound")
  }
}

function normalizeChallenge(
  value: P2TRReconcilerCandidateAttestationChallenge
): P2TRReconcilerCandidateAttestationChallenge {
  if (value.schema !== "tbtc-p2tr-reconciler-complete-candidate-challenge/v4") {
    throw new Error("Reconciler challenge schema is unsupported")
  }
  const requestBinding = normalizeRequestBinding(value.requestBinding)
  const candidate = normalizeCandidateRequest(value.candidate)
  const requestBindingDigest =
    computeP2TRReconcilerRequestBindingDigest(requestBinding)
  const candidateDigest = computeP2TRReconcilerCandidateDigest(candidate)
  if (
    bytes32(value.requestBindingDigest, "request binding digest") !==
      requestBindingDigest ||
    bytes32(value.candidateDigest, "candidate digest") !== candidateDigest
  ) {
    throw new Error("Reconciler challenge digest is invalid")
  }
  return {
    schema: value.schema,
    requestNonce: bytes32(value.requestNonce, "request nonce"),
    manifestHash: bytes32(value.manifestHash, "manifest hash"),
    requestBinding,
    requestBindingDigest,
    bridgeDomain: normalizeP2TRCompleteBridgeDomain(value.bridgeDomain),
    expectedReadinessSemanticRoot: bytes32(
      value.expectedReadinessSemanticRoot,
      "expected semantic root"
    ),
    expectedBitcoinPoint: normalizeBitcoinPoint(
      value.expectedBitcoinPoint,
      "expected Bitcoin point"
    ),
    candidate,
    candidateDigest,
  }
}

function normalizeEnvelope(
  value: P2TRSignedReconcilerCandidateAttestation
): P2TRSignedReconcilerCandidateAttestation {
  if (
    !isPlainObject(value) ||
    value.signatureAlgorithm !== "ed25519" ||
    !isPlainObject(value.payload) ||
    value.payload.schema !==
      "tbtc-p2tr-reconciler-complete-candidate-attestation/v4"
  ) {
    throw new Error("Signed reconciler attestation is malformed")
  }
  const payload = value.payload
  const normalized: P2TRReconcilerCandidateAttestationPayload = {
    schema: payload.schema,
    requestNonce: bytes32(payload.requestNonce, "attestation nonce"),
    manifestHash: bytes32(payload.manifestHash, "attestation manifest"),
    requestBinding: normalizeRequestBinding(payload.requestBinding),
    requestBindingDigest: bytes32(
      payload.requestBindingDigest,
      "attestation request binding"
    ),
    source: normalizeSource(payload.source),
    issuedAtUnixMs: nonNegativeInteger(payload.issuedAtUnixMs, "issue time"),
    expiresAtUnixMs: positiveInteger(payload.expiresAtUnixMs, "expiry"),
    export: normalizeExportHandle(payload.export),
  }
  if (
    normalized.expiresAtUnixMs <= normalized.issuedAtUnixMs ||
    computeP2TRReconcilerRequestBindingDigest(normalized.requestBinding) !==
      normalized.requestBindingDigest
  ) {
    throw new Error("Signed reconciler attestation contains an invalid digest")
  }
  return {
    payload: normalized,
    signatureAlgorithm: "ed25519",
    signerPublicKeySpki: canonicalBase64(
      value.signerPublicKeySpki,
      1024,
      "attestation public key"
    ),
    signature: canonicalBase64(value.signature, 256, "attestation signature"),
  }
}

function normalizeExportHandle(
  value: P2TRReconcilerReadinessExportHandle
): P2TRReconcilerReadinessExportHandle {
  if (value.schema !== "tbtc-p2tr-readiness-export-handle/v1") {
    throw new Error("Reconciler export handle schema is unsupported")
  }
  const snapshot = normalizeReadinessSnapshot(value.snapshot)
  const candidate = normalizeCandidateSummary(value.candidate)
  const contentManifest = normalizeContentManifest(value.contentManifest)
  const result: P2TRReconcilerReadinessExportHandle = {
    schema: value.schema,
    requestNonce: bytes32(value.requestNonce, "export request nonce"),
    requestDigest: bytes32(value.requestDigest, "export request digest"),
    exportFence: positiveInteger(value.exportFence, "export fence"),
    snapshotRoot: bytes32(value.snapshotRoot, "export snapshot root"),
    snapshotSemanticRoot: bytes32(
      value.snapshotSemanticRoot,
      "export semantic root"
    ),
    snapshotGeneration: positiveInteger(
      value.snapshotGeneration,
      "export snapshot generation"
    ),
    snapshot,
    candidate,
    contentManifest,
  }
  if (
    result.snapshotRoot !== snapshot.root ||
    result.snapshotSemanticRoot !== snapshot.semanticRoot ||
    result.snapshotGeneration !== snapshot.generation ||
    candidate.recomputation.auditContentRoot !== contentManifest.root ||
    candidate.recomputation.auditResultDigest !==
      contentManifest.resultDigest ||
    contentManifest.exportID !== result.requestNonce
  ) {
    throw new Error("Reconciler export handle compact fields disagree")
  }
  return result
}

function normalizeContentManifest(
  value: P2TRReconcilerExportContentManifest
): P2TRReconcilerExportContentManifest {
  if (
    value.schema !== "tbtc-p2tr-readiness-export-content/v1" ||
    value.chunkBytes !== P2TR_RECONCILER_EXPORT_CHUNK_BYTES
  ) {
    throw new Error("Reconciler export content manifest is unsupported")
  }
  const chunkCount = positiveInteger(value.chunkCount, "manifest chunk count")
  const totalBytes = positiveInteger(value.totalBytes, "manifest total bytes")
  const orderedChunkHashes = value.orderedChunkHashes.map((hash, index) =>
    bytes32(hash, `manifest chunk hash ${index}`)
  )
  if (
    orderedChunkHashes.length !== chunkCount ||
    chunkCount !== Math.ceil(totalBytes / P2TR_RECONCILER_EXPORT_CHUNK_BYTES)
  ) {
    throw new Error("Reconciler export chunk count/bytes are inconsistent")
  }
  const core = normalizeManifestCore({
    schema: value.schema,
    exportID: bytes32(value.exportID, "manifest export ID"),
    resultDigest: bytes32(value.resultDigest, "manifest result digest"),
    chunkCount,
    totalBytes,
    chunkBytes: P2TR_RECONCILER_EXPORT_CHUNK_BYTES,
    orderedChunkHashes,
  })
  const root = bytes32(value.root, "manifest content root")
  if (root !== computeP2TRReconcilerExportContentRoot(core)) {
    throw new Error("Reconciler export content root is invalid")
  }
  return { ...core, root }
}

function normalizeManifestCore(
  value: Omit<P2TRReconcilerExportContentManifest, "root">
): Omit<P2TRReconcilerExportContentManifest, "root"> {
  return {
    schema: "tbtc-p2tr-readiness-export-content/v1",
    exportID: bytes32(value.exportID, "manifest export ID"),
    resultDigest: bytes32(value.resultDigest, "manifest result digest"),
    chunkCount: positiveInteger(value.chunkCount, "manifest chunk count"),
    totalBytes: positiveInteger(value.totalBytes, "manifest total bytes"),
    chunkBytes: P2TR_RECONCILER_EXPORT_CHUNK_BYTES,
    orderedChunkHashes: value.orderedChunkHashes.map((hash, index) =>
      bytes32(hash, `manifest chunk hash ${index}`)
    ),
  }
}

function normalizeStreamVerifiedExport(
  value: P2TRStreamVerifiedReconcilerExport
): P2TRStreamVerifiedReconcilerExport {
  return {
    snapshot: structuredClone(value.snapshot),
    candidate: normalizeAuditCandidateSummary(value.candidate),
    resultDigest: bytes32(value.resultDigest, "streamed result digest"),
    contentRoot: bytes32(value.contentRoot, "streamed content root"),
    rawTransactionDigest: bytes32(
      value.rawTransactionDigest,
      "streamed raw transaction digest"
    ),
    candidateBlockHeaderHash: bytes32(
      value.candidateBlockHeaderHash,
      "streamed candidate header hash"
    ),
    fundingBlockHeaderHash: bytes32(
      value.fundingBlockHeaderHash,
      "streamed funding header hash"
    ),
  }
}

function normalizeReadinessSnapshot(
  value: P2TRReconcilerReadinessSnapshot
): P2TRReconcilerReadinessSnapshot {
  const counts = value.bitcoin.journalCounts
  const projection = value.projection
  return {
    storeID: boundedString(value.storeID, 255, "snapshot store ID"),
    configurationFingerprint: bytes32(
      value.configurationFingerprint,
      "snapshot configuration"
    ),
    network: boundedString(value.network, 64, "snapshot Bitcoin network"),
    trustDomainID: boundedString(
      value.trustDomainID,
      128,
      "snapshot trust domain"
    ),
    generation: positiveInteger(value.generation, "snapshot generation"),
    root: bytes32(value.root, "snapshot root"),
    semanticRoot: bytes32(value.semanticRoot, "snapshot semantic root"),
    allocators: {
      nextCandidateProvenanceGeneration: positiveInteger(
        value.allocators.nextCandidateProvenanceGeneration,
        "snapshot candidate generation allocator"
      ),
      nextInvalidationID: positiveInteger(
        value.allocators.nextInvalidationID,
        "snapshot invalidation allocator"
      ),
      nextExportFence: positiveInteger(
        value.allocators.nextExportFence,
        "snapshot export fence allocator"
      ),
    },
    bitcoin: {
      checkpoint: normalizeBitcoinPoint(
        value.bitcoin.checkpoint,
        "snapshot Bitcoin checkpoint"
      ),
      current: normalizeBitcoinPoint(
        value.bitcoin.current,
        "snapshot current Bitcoin point"
      ),
      chainCommitment: bytes32(
        value.bitcoin.chainCommitment,
        "snapshot chain commitment"
      ),
      evidenceCommitment: bytes32(
        value.bitcoin.evidenceCommitment,
        "snapshot evidence commitment"
      ),
      journalCounts: {
        blocks: count(counts.blocks, "snapshot block count"),
        transactions: count(counts.transactions, "snapshot transaction count"),
        inputs: count(counts.inputs, "snapshot input count"),
        outputs: count(counts.outputs, "snapshot output count"),
        unresolvedInputs: count(
          counts.unresolvedInputs,
          "snapshot unresolved input count"
        ),
      },
    },
    ...(value.crossSourceWatermark === undefined
      ? {}
      : {
          crossSourceWatermark: {
            bitcoin: normalizeBitcoinPoint(
              value.crossSourceWatermark.bitcoin,
              "snapshot watermark Bitcoin point"
            ),
            ethereum: {
              blockNumber: nonNegativeInteger(
                value.crossSourceWatermark.ethereum.blockNumber,
                "snapshot watermark Ethereum block"
              ),
              blockHash: bytes32(
                value.crossSourceWatermark.ethereum.blockHash,
                "snapshot watermark Ethereum hash"
              ),
            },
          },
        }),
    projection: {
      semanticCommitment: bytes32(
        projection.semanticCommitment,
        "snapshot projection semantic commitment"
      ),
      semanticRowCount: count(
        projection.semanticRowCount,
        "snapshot semantic row count"
      ),
      commitment: bytes32(
        projection.commitment,
        "snapshot projection commitment"
      ),
      rowCount: count(projection.rowCount, "snapshot projection row count"),
      walletBindings: count(
        projection.walletBindings,
        "snapshot wallet binding count"
      ),
      depositReveals: count(
        projection.depositReveals,
        "snapshot deposit reveal count"
      ),
      pendingDepositReveals: count(
        projection.pendingDepositReveals,
        "snapshot pending deposit reveal count"
      ),
      trackedOutpoints: count(
        projection.trackedOutpoints,
        "snapshot tracked outpoint count"
      ),
      candidates: count(projection.candidates, "snapshot candidate count"),
      pendingCandidates: count(
        projection.pendingCandidates,
        "snapshot pending candidate count"
      ),
      candidateInputProvenance: count(
        projection.candidateInputProvenance,
        "snapshot provenance count"
      ),
      invalidations: count(
        projection.invalidations,
        "snapshot invalidation count"
      ),
      unmatchedProofs: count(
        projection.unmatchedProofs,
        "snapshot unmatched proof count"
      ),
      pendingUnmatchedProofs: count(
        projection.pendingUnmatchedProofs,
        "snapshot pending unmatched proof count"
      ),
      crossSourceWatermarks: count(
        projection.crossSourceWatermarks,
        "snapshot watermark count"
      ),
      pendingDepositCommitment: bytes32(
        projection.pendingDepositCommitment,
        "snapshot pending deposit commitment"
      ),
      pendingCandidateCommitment: bytes32(
        projection.pendingCandidateCommitment,
        "snapshot pending candidate commitment"
      ),
      pendingProofCommitment: bytes32(
        projection.pendingProofCommitment,
        "snapshot pending proof commitment"
      ),
    },
  }
}

function normalizeFullStreamRecomputation(
  value: P2TRReconcilerFullStreamRecomputation
): P2TRReconcilerFullStreamRecomputation {
  return {
    ...normalizeStreamComputation(value),
    auditContentRoot: bytes32(
      value.auditContentRoot,
      "recomputation audit root"
    ),
    auditResultDigest: bytes32(
      value.auditResultDigest,
      "recomputation audit digest"
    ),
  }
}

function normalizeStreamComputation(
  value: P2TRReconcilerStreamComputation
): P2TRReconcilerStreamComputation {
  if (
    value.schema !== "tbtc-p2tr-full-stream-recomputation/v1" ||
    value.canonicalStreamSchema !== "tbtc-p2tr-canonical-candidate-stream/v1" ||
    value.allInputsConsumed !== true
  ) {
    throw new Error("Reconciler did not assert a complete canonical stream")
  }
  return {
    schema: value.schema,
    protocolID: bytes32(value.protocolID, "recomputation protocol"),
    canonicalStreamSchema: value.canonicalStreamSchema,
    inputIndex: uint32(value.inputIndex, "recomputed input index"),
    rawTransactionDigest: bytes32(
      value.rawTransactionDigest,
      "recomputed raw transaction"
    ),
    rawTransactionBytes: positiveInteger(
      value.rawTransactionBytes,
      "recomputed raw transaction bytes"
    ),
    witnessDigest: bytes32(value.witnessDigest, "recomputed witness"),
    annexDigest: bytes32(value.annexDigest, "recomputed annex"),
    prevoutVectorRoot: bytes32(
      value.prevoutVectorRoot,
      "recomputed prevout vector"
    ),
    prevoutCount: positiveInteger(
      value.prevoutCount,
      "recomputed prevout count"
    ),
    prevoutBytes: positiveInteger(
      value.prevoutBytes,
      "recomputed prevout bytes"
    ),
    shaPrevouts: bytes32(value.shaPrevouts, "recomputed prevouts hash"),
    shaAmounts: bytes32(value.shaAmounts, "recomputed amounts hash"),
    shaScriptPubKeys: bytes32(
      value.shaScriptPubKeys,
      "recomputed scriptPubKeys hash"
    ),
    shaSequences: bytes32(value.shaSequences, "recomputed sequences hash"),
    shaOutputs: bytes32(value.shaOutputs, "recomputed outputs hash"),
    computedSighash: bytes32(
      value.computedSighash,
      "recomputed BIP-341 sighash"
    ),
    candidateBlockHeaderHash: bytes32(
      value.candidateBlockHeaderHash,
      "recomputed candidate header"
    ),
    fundingBlockHeaderHash: bytes32(
      value.fundingBlockHeaderHash,
      "recomputed funding header"
    ),
    allInputsConsumed: true,
  }
}

function normalizeAuditCandidateSummary(
  value: P2TRReconcilerAuditExportCandidateSummary
): P2TRReconcilerAuditExportCandidateSummary {
  const identity = normalizeObservationIdentity(value.identity)
  const inputProvenance = normalizeInputProvenance(value.inputProvenance)
  const recomputation = normalizeStreamComputation(value.recomputation)
  assertRecomputationCandidateBinding(identity, inputProvenance, recomputation)
  return {
    candidateDigest: bytes32(value.candidateDigest, "candidate digest"),
    identity,
    provenanceGeneration: positiveInteger(
      value.provenanceGeneration,
      "candidate provenance generation"
    ),
    provenanceFingerprint: bytes32(
      value.provenanceFingerprint,
      "candidate provenance fingerprint"
    ),
    inputProvenance,
    recomputation,
  }
}

function normalizeCandidateSummary(
  value: P2TRReconcilerExportCandidateSummary
): P2TRReconcilerExportCandidateSummary {
  const identity = normalizeObservationIdentity(value.identity)
  const inputProvenance = normalizeInputProvenance(value.inputProvenance)
  const recomputation = normalizeFullStreamRecomputation(value.recomputation)
  assertRecomputationCandidateBinding(identity, inputProvenance, recomputation)
  return {
    candidateDigest: bytes32(value.candidateDigest, "candidate digest"),
    identity,
    provenanceGeneration: positiveInteger(
      value.provenanceGeneration,
      "candidate provenance generation"
    ),
    provenanceFingerprint: bytes32(
      value.provenanceFingerprint,
      "candidate provenance fingerprint"
    ),
    inputProvenance,
    recomputation,
  }
}

function assertRecomputationCandidateBinding(
  identity: P2TRCompleteCandidateIdentity,
  inputProvenance: P2TRProductionCandidateInputProvenance,
  recomputation: P2TRReconcilerStreamComputation
): void {
  if (
    recomputation.inputIndex !== identity.inputIndex ||
    recomputation.computedSighash !== identity.evidence.sighash ||
    recomputation.candidateBlockHeaderHash !== identity.blockHash ||
    recomputation.fundingBlockHeaderHash !== inputProvenance.fundingBlockHash
  ) {
    throw new Error("Recomputation receipt names another candidate input")
  }
}

function normalizeCandidateRequest(
  value: P2TRReconcilerCandidateRequest
): P2TRReconcilerCandidateRequest {
  const identity = normalizeObservationIdentity(value.identity)
  const inputProvenance = normalizeInputProvenance(value.inputProvenance)
  const evidence = identity.evidence
  const zero = "0".repeat(64)
  if (
    identity.inputIndex !== inputProvenance.inputIndex ||
    evidence.walletID !== inputProvenance.walletID ||
    evidence.signingKey !== inputProvenance.outputKey ||
    (inputProvenance.bindingKind === "wallet"
      ? evidence.signingKey !== evidence.walletID ||
        evidence.bindingTxHash !== zero ||
        evidence.bindingOutputIndex !== 0
      : evidence.signingKey === evidence.walletID ||
        evidence.bindingTxHash !== inputProvenance.fundingTxid ||
        evidence.bindingOutputIndex !== inputProvenance.fundingVout)
  ) {
    throw new Error(
      "Requested COMPLETE_V2 identity/provenance binding is invalid"
    )
  }
  return {
    identity,
    inputProvenance,
    provenanceFingerprint: bytes32(
      value.provenanceFingerprint,
      "requested provenance fingerprint"
    ),
  }
}

function normalizeObservationIdentity(
  value: P2TRCompleteCandidateIdentity
): P2TRCompleteCandidateIdentity {
  return normalizeP2TRCompleteCandidateIdentity(value)
}

function normalizeInputProvenance(
  value: P2TRProductionCandidateInputProvenance
): P2TRProductionCandidateInputProvenance {
  if (value.bindingKind !== "wallet" && value.bindingKind !== "deposit") {
    throw new Error("Candidate provenance binding kind is invalid")
  }
  return {
    inputIndex: uint32(value.inputIndex, "provenance input index"),
    fundingBlockHash: bytes32(value.fundingBlockHash, "funding block hash"),
    fundingTxid: bytes32(value.fundingTxid, "funding transaction ID"),
    fundingVout: uint32(value.fundingVout, "funding output index"),
    bindingKind: value.bindingKind,
    walletID: bytes32(value.walletID, "provenance wallet ID"),
    outputKey: bytes32(value.outputKey, "provenance output key"),
    sourceEventID: bytes32(value.sourceEventID, "provenance source event ID"),
    ethereumBlockNumber: nonNegativeInteger(
      value.ethereumBlockNumber,
      "provenance Ethereum block"
    ),
    ethereumBlockHash: bytes32(
      value.ethereumBlockHash,
      "provenance Ethereum block hash"
    ),
  }
}

/**
 * Key INSERTION order here is load-bearing beyond the digest. The digest sorts
 * keys (`canonicalJSON`), but the boundary authorizer additionally compares
 * `JSON.stringify(payload.requestBinding)` against
 * `JSON.stringify(reconcilerRequestBinding(binding))`, which does not. Any
 * field added here must be added at the same position, and with the same
 * conditional-spread idiom, in `reconcilerRequestBinding`
 * (`P2TRSignatureFraudIrreversibleBoundaryAuthorization.ts`).
 */
function normalizeRequestBinding(
  value: P2TRReconcilerRequestBinding
): P2TRReconcilerRequestBinding {
  if (
    value.stage !== "prepare" &&
    value.stage !== "replacement" &&
    value.stage !== "broadcast"
  ) {
    throw new Error("Reconciler request stage is invalid")
  }
  const replacedTransactionHash =
    value.replacedTransactionHash === undefined
      ? undefined
      : bytes32(value.replacedTransactionHash, "replaced transaction hash")
  const preparedTransactionHash =
    value.preparedTransactionHash === undefined
      ? undefined
      : bytes32(value.preparedTransactionHash, "prepared transaction hash")
  if (
    (value.stage === "replacement") !==
    (replacedTransactionHash !== undefined)
  ) {
    throw new Error(
      "Only a replacement reconciler request may name the superseded transaction"
    )
  }
  if (
    (value.stage === "broadcast") !==
    (preparedTransactionHash !== undefined)
  ) {
    throw new Error(
      "Only a broadcast reconciler request may name prepared transaction bytes"
    )
  }
  return {
    recordID: bytes32(value.recordID, "outbox record ID"),
    recordGeneration: nonNegativeInteger(
      value.recordGeneration,
      "record generation"
    ),
    recordVersion: nonNegativeInteger(value.recordVersion, "record version"),
    reservationID: bytes32(value.reservationID, "reservation ID"),
    sender: address(value.sender, "reserved sender"),
    transactionNonce: nonNegativeInteger(
      value.transactionNonce,
      "transaction nonce"
    ),
    stage: value.stage,
    attempt: positiveInteger(value.attempt, "outbox attempt"),
    provenanceFingerprint: bytes32(
      value.provenanceFingerprint,
      "request provenance fingerprint"
    ),
    activationManifestHash: bytes32(
      value.activationManifestHash,
      "request activation manifest hash"
    ),
    laneID: identityText(value.laneID, "request signer lane ID"),
    signerIdentity: identityText(
      value.signerIdentity,
      "request signer identity"
    ),
    intentID: bytes32(value.intentID, "request submission intent ID"),
    routerAddress: address(value.routerAddress, "request router address"),
    intentValueWei: uint256Decimal(
      value.intentValueWei,
      "request intent value"
    ),
    challengeValueWei: uint256Decimal(
      value.challengeValueWei,
      "request challenge value"
    ),
    maxGasLimit: uint256Decimal(value.maxGasLimit, "request maximum gas limit"),
    maxFeePerGas: uint256Decimal(
      value.maxFeePerGas,
      "request maximum fee per gas"
    ),
    maxPriorityFeePerGas: uint256Decimal(
      value.maxPriorityFeePerGas,
      "request maximum priority fee per gas"
    ),
    maxTotalFeeWei: uint256Decimal(
      value.maxTotalFeeWei,
      "request maximum total fee"
    ),
    ...(replacedTransactionHash === undefined
      ? {}
      : { replacedTransactionHash }),
    ...(preparedTransactionHash === undefined
      ? {}
      : { preparedTransactionHash }),
  }
}

function normalizeSource(
  value: P2TRReconcilerAttestationSource
): P2TRReconcilerAttestationSource {
  return {
    trustDomainID: boundedString(
      value.trustDomainID,
      128,
      "source trust domain"
    ),
    endpointFingerprint: bytes32(value.endpointFingerprint, "source endpoint"),
    operatorFingerprint: bytes32(value.operatorFingerprint, "source operator"),
    storeID: boundedString(value.storeID, 255, "source store ID"),
    storeFingerprint: bytes32(
      value.storeFingerprint,
      "source store fingerprint"
    ),
    attestationKeyHash: bytes32(value.attestationKeyHash, "source key"),
  }
}

function verifyEnvelopeSignature(
  envelope: P2TRSignedReconcilerCandidateAttestation,
  trustedSignerKeyHash: string
): void {
  const keyBytes = Buffer.from(envelope.signerPublicKeySpki, "base64")
  const keyHash = `0x${createHash("sha256").update(keyBytes).digest("hex")}`
  if (
    bytes32(keyHash, "actual signer key") !==
      bytes32(trustedSignerKeyHash, "trusted signer key") ||
    bytes32(keyHash, "actual signer key") !==
      envelope.payload.source.attestationKeyHash
  ) {
    throw new Error("Reconciler attestation signer identity is not pinned")
  }
  const key = createPublicKey({ key: keyBytes, format: "der", type: "spki" })
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verifySignature(
      null,
      Buffer.from(canonicalJSON(envelope.payload), "utf8"),
      key,
      Buffer.from(envelope.signature, "base64")
    )
  ) {
    throw new Error("Reconciler attestation signature is invalid")
  }
}

function normalizeBitcoinPoint(
  value: { height: number; hash: string },
  label: string
): { height: number; hash: string } {
  return {
    height: nonNegativeInteger(value.height, `${label} height`),
    hash: bytes32(value.hash, `${label} hash`),
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value), "utf8").digest("hex")
}

function canonicalJSON(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Canonical number is unsafe")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`
  }
  throw new Error("Canonical reconciler payload contains an unsupported value")
}

function bytes32(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be 32 bytes`)
  }
  return normalized
}

function address(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be 20 bytes`)
  }
  return `0x${normalized}`
}

function canonicalBase64(
  value: string,
  maximum: number,
  label: string
): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is not canonical base64`)
  }
  const bytes = Buffer.from(value, "base64")
  if (
    bytes.length === 0 ||
    bytes.length > maximum ||
    bytes.toString("base64") !== value
  ) {
    throw new Error(`${label} is malformed or exceeds its bound`)
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

function count(value: number, label: string): number {
  return nonNegativeInteger(value, label)
}

function uint32(value: number, label: string): number {
  const result = nonNegativeInteger(value, label)
  if (result > 0xffffffff) throw new Error(`${label} exceeds uint32`)
  return result
}

function boundedString(value: string, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

/**
 * Mirrors the outbox's `requireBoundedText` exactly — including the trim — so
 * one untrimmed lane identity cannot yield two different digests on the two
 * sides of the boundary.
 */
function identityText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`)
  }
  const normalized = value.trim()
  if (normalized.length > 128) {
    throw new Error(`${label} exceeds 128 characters`)
  }
  return normalized
}

/**
 * Mirrors the outbox's `normalizePolicyUint256`. The length is bounded before
 * the BigInt conversion: this runs on remote attestation input before the
 * envelope signature is verified, and parsing an unbounded decimal is
 * superlinear. 2^256-1 has 78 digits, so nothing legitimate is excluded.
 */
function uint256Decimal(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 78 ||
    !/^(?:0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new Error(`${label} must be a canonical unsigned decimal integer`)
  }
  if (BigInt(value) > (1n << 256n) - 1n) {
    throw new Error(`${label} exceeds uint256`)
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}
