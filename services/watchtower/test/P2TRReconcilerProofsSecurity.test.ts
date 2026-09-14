import assert from "node:assert/strict"
import {
  createHash,
  generateKeyPairSync,
  sign as signMessage,
  type KeyObject,
} from "node:crypto"
import { describe, it } from "node:test"
import {
  assertP2TRVerifiedCompleteCandidateIdentity,
  computeP2TRCompleteChallengeIdentity,
  type P2TRCompleteBridgeDomain,
  type P2TRCompleteCandidateIdentity,
} from "../src/P2TRCompleteCandidateIdentity.js"
import {
  assertP2TRVerifiedLiveCoreCandidateEvidence,
  verifyP2TRLiveCoreCandidateEvidence,
  type P2TRLiveCoreCandidateEvidenceProvider,
  type P2TRLiveCoreCandidateVerificationReceipt,
  type P2TRLiveCoreSourceIdentity,
} from "../src/P2TRLiveCoreCandidateEvidence.js"
import {
  assertP2TRVerifiedReconcilerCandidateAttestation,
  computeP2TRReconcilerCandidateDigest,
  computeP2TRReconcilerChallengeRequestDigest,
  computeP2TRReconcilerExportChunkHash,
  computeP2TRReconcilerExportContentRoot,
  computeP2TRReconcilerRequestBindingDigest,
  P2TR_RECONCILER_EXPORT_CHUNK_BYTES,
  streamAndVerifyP2TRReconcilerExport,
  verifyP2TRReconcilerCandidateAttestation,
  type P2TRDecodedReconcilerExport,
  type P2TRReconcilerCandidateAttestationChallenge,
  type P2TRReconcilerCandidateAttestationPayload,
  type P2TRReconcilerCandidateAttestationVerificationPolicy,
  type P2TRReconcilerExportCandidateSummary,
  type P2TRReconcilerExportContentManifest,
  type P2TRReconcilerExportStreamDecoder,
  type P2TRReconcilerReadinessExportHandle,
  type P2TRReconcilerReadinessSnapshot,
  type P2TRSignedReconcilerCandidateAttestation,
  type P2TRVerifiedReconcilerCandidateAttestation,
} from "../src/P2TRReconcilerAttestation.js"
import {
  P2TRSignatureFraudVerifiedIrreversibleBoundaryAuthorizer,
  type P2TRSignatureFraudVerifiedBoundaryEvidence,
} from "../src/P2TRSignatureFraudIrreversibleBoundaryAuthorization.js"
import type {
  P2TRSignatureFraudIrreversibleBoundaryAuthorization,
  P2TRSignatureFraudIrreversibleBoundaryBinding,
} from "../src/P2TRSignatureFraudChallengeOutbox.js"

const NOW = 1_800_000_000_000
const hex32 = (digit: string): string => digit.repeat(64)

function canonicalJSON(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("unsafe test number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(object[key])}`)
      .join(",")}}`
  }
  throw new Error("unsupported test value")
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

type ProofFixture = {
  privateKey: KeyObject
  challenge: P2TRReconcilerCandidateAttestationChallenge
  envelope: P2TRSignedReconcilerCandidateAttestation
  policy: P2TRReconcilerCandidateAttestationVerificationPolicy
  chunks: readonly Buffer[]
  decoded: P2TRDecodedReconcilerExport
}

function makeProofFixture(
  options: {
    requestBinding?: Partial<
      P2TRReconcilerCandidateAttestationChallenge["requestBinding"]
    >
    exportFence?: number
    provenanceFingerprint?: string
  } = {}
): ProofFixture {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const signerPublicKeySpki = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64")
  const attestationKeyHash = sha256(Buffer.from(signerPublicKeySpki, "base64"))
  const bridgeDomain: P2TRCompleteBridgeDomain = {
    domainChainID: "1",
    bridgeAddress: `0x${"12".repeat(20)}`,
  }
  const evidence = {
    walletID: hex32("1"),
    signingKey: hex32("1"),
    bindingTxHash: hex32("0"),
    bindingOutputIndex: 0,
    sighash: hex32("2"),
    nonceX: hex32("3"),
    signatureScalar: hex32("4"),
  }
  const identity: P2TRCompleteCandidateIdentity = {
    schema: "tbtc-p2tr-complete-candidate/v2",
    txid: hex32("5"),
    wtxid: hex32("6"),
    blockHeight: 840_000,
    blockHash: hex32("7"),
    inputIndex: 2,
    evidence,
    challengeIdentity: computeP2TRCompleteChallengeIdentity(
      bridgeDomain,
      evidence
    ),
  }
  const inputProvenance = {
    inputIndex: 2,
    fundingBlockHash: hex32("8"),
    fundingTxid: hex32("9"),
    fundingVout: 3,
    bindingKind: "wallet" as const,
    walletID: evidence.walletID,
    outputKey: evidence.signingKey,
    sourceEventID: hex32("a"),
    ethereumBlockNumber: 21_000_000,
    ethereumBlockHash: hex32("b"),
  }
  const candidate = {
    identity,
    inputProvenance,
    provenanceFingerprint: options.provenanceFingerprint ?? hex32("c"),
  }
  const requestBinding = {
    recordID: hex32("d"),
    recordGeneration: 11,
    recordVersion: 4,
    reservationID: hex32("e"),
    sender: `0x${"34".repeat(20)}`,
    transactionNonce: 19,
    stage: "prepare" as const,
    attempt: 2,
    provenanceFingerprint: options.provenanceFingerprint ?? hex32("c"),
    activationManifestHash: hex32("1"),
    laneID: "lane-a",
    signerIdentity: "signer-a",
    intentID: hex32("4"),
    routerAddress: `0x${"56".repeat(20)}`,
    intentValueWei: "1000000000000000000",
    challengeValueWei: "1000000000000000000",
    maxGasLimit: "500000",
    maxFeePerGas: "40000000000",
    maxPriorityFeePerGas: "2000000000",
    maxTotalFeeWei: "20000000000000000",
    ...options.requestBinding,
  }
  const exportFence = options.exportFence ?? 7
  const challenge: P2TRReconcilerCandidateAttestationChallenge = {
    schema: "tbtc-p2tr-reconciler-complete-candidate-challenge/v4",
    requestNonce: hex32("f"),
    manifestHash: hex32("1"),
    requestBinding,
    requestBindingDigest:
      computeP2TRReconcilerRequestBindingDigest(requestBinding),
    bridgeDomain,
    expectedReadinessSemanticRoot: hex32("2"),
    expectedBitcoinPoint: { height: 840_006, hash: hex32("3") },
    candidate,
    candidateDigest: computeP2TRReconcilerCandidateDigest(candidate),
  }

  const stream = Buffer.alloc(P2TR_RECONCILER_EXPORT_CHUNK_BYTES + 17, 0x5a)
  const chunks = [
    stream.subarray(0, P2TR_RECONCILER_EXPORT_CHUNK_BYTES),
    stream.subarray(P2TR_RECONCILER_EXPORT_CHUNK_BYTES),
  ]
  const manifestCore: Omit<P2TRReconcilerExportContentManifest, "root"> = {
    schema: "tbtc-p2tr-readiness-export-content/v1",
    exportID: challenge.requestNonce,
    resultDigest: sha256(stream),
    chunkCount: chunks.length,
    totalBytes: stream.length,
    chunkBytes: P2TR_RECONCILER_EXPORT_CHUNK_BYTES,
    orderedChunkHashes: chunks.map((chunk, index) =>
      computeP2TRReconcilerExportChunkHash(index, stream.length, chunk)
    ),
  }
  const contentManifest: P2TRReconcilerExportContentManifest = {
    ...manifestCore,
    root: computeP2TRReconcilerExportContentRoot(manifestCore),
  }
  const snapshot: P2TRReconcilerReadinessSnapshot = {
    storeID: "reconciler-store-a",
    configurationFingerprint: hex32("4"),
    network: "mainnet",
    trustDomainID: "reconciler-trust-a",
    generation: 9,
    root: hex32("5"),
    semanticRoot: challenge.expectedReadinessSemanticRoot,
    allocators: {
      nextCandidateProvenanceGeneration: 8,
      nextInvalidationID: 3,
      nextExportFence: exportFence + 1,
    },
    bitcoin: {
      checkpoint: { height: 839_900, hash: hex32("6") },
      current: challenge.expectedBitcoinPoint,
      chainCommitment: hex32("7"),
      evidenceCommitment: hex32("8"),
      journalCounts: {
        blocks: 107,
        transactions: 509,
        inputs: 901,
        outputs: 1_003,
        unresolvedInputs: 0,
      },
    },
    crossSourceWatermark: {
      bitcoin: challenge.expectedBitcoinPoint,
      ethereum: {
        blockNumber: inputProvenance.ethereumBlockNumber,
        blockHash: inputProvenance.ethereumBlockHash,
      },
    },
    projection: {
      semanticCommitment: hex32("9"),
      semanticRowCount: 10,
      commitment: hex32("a"),
      rowCount: 12,
      walletBindings: 1,
      depositReveals: 0,
      pendingDepositReveals: 0,
      trackedOutpoints: 1,
      candidates: 1,
      pendingCandidates: 1,
      candidateInputProvenance: 1,
      invalidations: 0,
      unmatchedProofs: 0,
      pendingUnmatchedProofs: 0,
      crossSourceWatermarks: 1,
      pendingDepositCommitment: hex32("b"),
      pendingCandidateCommitment: hex32("c"),
      pendingProofCommitment: hex32("d"),
    },
  }
  const streamRecomputation = {
    schema: "tbtc-p2tr-full-stream-recomputation/v1" as const,
    protocolID: hex32("e"),
    canonicalStreamSchema: "tbtc-p2tr-canonical-candidate-stream/v1" as const,
    inputIndex: identity.inputIndex,
    rawTransactionDigest: sha256(stream),
    rawTransactionBytes: 255,
    witnessDigest: hex32("f"),
    annexDigest: hex32("0"),
    prevoutVectorRoot: hex32("1"),
    prevoutCount: 3,
    prevoutBytes: 181,
    shaPrevouts: hex32("2"),
    shaAmounts: hex32("3"),
    shaScriptPubKeys: hex32("4"),
    shaSequences: hex32("5"),
    shaOutputs: hex32("6"),
    computedSighash: evidence.sighash,
    candidateBlockHeaderHash: identity.blockHash,
    fundingBlockHeaderHash: inputProvenance.fundingBlockHash,
    allInputsConsumed: true as const,
  }
  const candidateSummary: P2TRReconcilerExportCandidateSummary = {
    candidateDigest: challenge.candidateDigest,
    identity,
    provenanceGeneration: 7,
    provenanceFingerprint: candidate.provenanceFingerprint,
    inputProvenance,
    recomputation: {
      ...streamRecomputation,
      auditContentRoot: contentManifest.root,
      auditResultDigest: contentManifest.resultDigest,
    },
  }
  const handle: P2TRReconcilerReadinessExportHandle = {
    schema: "tbtc-p2tr-readiness-export-handle/v1",
    requestNonce: challenge.requestNonce,
    requestDigest: computeP2TRReconcilerChallengeRequestDigest(challenge),
    exportFence,
    snapshotRoot: snapshot.root,
    snapshotSemanticRoot: snapshot.semanticRoot,
    snapshotGeneration: snapshot.generation,
    snapshot,
    candidate: candidateSummary,
    contentManifest,
  }
  const source = {
    trustDomainID: snapshot.trustDomainID,
    endpointFingerprint: hex32("7"),
    operatorFingerprint: hex32("8"),
    storeID: snapshot.storeID,
    storeFingerprint: hex32("9"),
    attestationKeyHash,
  }
  const payload: P2TRReconcilerCandidateAttestationPayload = {
    schema: "tbtc-p2tr-reconciler-complete-candidate-attestation/v4",
    requestNonce: challenge.requestNonce,
    manifestHash: challenge.manifestHash,
    requestBinding,
    requestBindingDigest: challenge.requestBindingDigest,
    source,
    issuedAtUnixMs: NOW - 1_000,
    expiresAtUnixMs: NOW + 10_000,
    export: handle,
  }
  const envelope = signEnvelope(payload, privateKey, signerPublicKeySpki)
  const policy: P2TRReconcilerCandidateAttestationVerificationPolicy = {
    expectedSource: source,
    trustedSignerKeyHash: attestationKeyHash,
    minimumExportFenceExclusive: exportFence - 1,
    maximumLifetimeMs: 20_000,
    maximumClockSkewMs: 250,
    maximumExportBytes: stream.length,
    maximumExportChunks: chunks.length,
    expectedRecomputationProtocolID: streamRecomputation.protocolID,
    nowUnixMs: () => NOW,
  }
  const {
    auditContentRoot: _root,
    auditResultDigest: _digest,
    ...recomputation
  } = candidateSummary.recomputation
  const decoded: P2TRDecodedReconcilerExport = {
    snapshot,
    candidate: { ...candidateSummary, recomputation },
    rawTransactionDigest: recomputation.rawTransactionDigest,
    candidateBlockHeaderHash: recomputation.candidateBlockHeaderHash,
    fundingBlockHeaderHash: recomputation.fundingBlockHeaderHash,
  }
  return { privateKey, challenge, envelope, policy, chunks, decoded }
}

function signEnvelope(
  payload: P2TRReconcilerCandidateAttestationPayload,
  privateKey: KeyObject,
  signerPublicKeySpki?: string
): P2TRSignedReconcilerCandidateAttestation {
  const publicKey = signerPublicKeySpki ?? ""
  return {
    payload,
    signatureAlgorithm: "ed25519",
    signerPublicKeySpki: publicKey,
    signature: signMessage(
      null,
      Buffer.from(canonicalJSON(payload), "utf8"),
      privateKey
    ).toString("base64"),
  }
}

function resign(
  fixture: ProofFixture,
  payload: P2TRReconcilerCandidateAttestationPayload
): P2TRSignedReconcilerCandidateAttestation {
  return signEnvelope(
    payload,
    fixture.privateKey,
    fixture.envelope.signerPublicKeySpki
  )
}

class RecordingDecoder implements P2TRReconcilerExportStreamDecoder {
  writes = 0
  maximumWrite = 0
  finishes = 0
  aborts = 0
  abortReason: unknown

  constructor(
    private readonly decoded: P2TRDecodedReconcilerExport,
    private readonly failWrite = false
  ) {}

  write(fragment: Uint8Array): void {
    this.writes++
    this.maximumWrite = Math.max(this.maximumWrite, fragment.byteLength)
    if (this.failWrite) throw new Error("decoder rejected malformed frame")
  }

  finish(): P2TRDecodedReconcilerExport {
    this.finishes++
    return structuredClone(this.decoded)
  }

  abort(reason: unknown): void {
    this.aborts++
    this.abortReason = reason
  }
}

async function verifyFixture(
  fixture: ProofFixture
): Promise<P2TRVerifiedReconcilerCandidateAttestation> {
  return verifyP2TRReconcilerCandidateAttestation(
    fixture.envelope,
    fixture.challenge,
    fixture.policy
  )
}

function makeLiveSource(): P2TRLiveCoreSourceIdentity {
  return {
    trustDomainID: "live-core-trust-b",
    endpointFingerprint: hex32("a"),
    operatorFingerprint: hex32("b"),
    protocolID: hex32("c"),
    network: "mainnet",
    genesisHash: hex32("d"),
  }
}

function withoutAuditFields(
  attestation: P2TRVerifiedReconcilerCandidateAttestation
) {
  const {
    auditContentRoot: _root,
    auditResultDigest: _digest,
    ...recomputation
  } = attestation.payload.export.candidate.recomputation
  return recomputation
}

function makeLiveProvider(
  attestation: P2TRVerifiedReconcilerCandidateAttestation,
  source = makeLiveSource(),
  mutate?: (
    receipt: P2TRLiveCoreCandidateVerificationReceipt
  ) => P2TRLiveCoreCandidateVerificationReceipt
): P2TRLiveCoreCandidateEvidenceProvider {
  const identity = assertP2TRVerifiedCompleteCandidateIdentity(
    attestation.completeIdentity
  )
  const baseReceipt: P2TRLiveCoreCandidateVerificationReceipt = {
    schema: "tbtc-p2tr-live-core-candidate-verification/v1",
    requestNonce: attestation.payload.requestNonce,
    reconcilerAttestationDigest: attestation.attestationDigest,
    exportFence: attestation.payload.export.exportFence,
    source,
    checkedAtUnixMs: NOW,
    expiresAtUnixMs: NOW + 5_000,
    bestPoint: {
      height: identity.blockHeight + 5,
      hash: hex32("e"),
    },
    candidateConfirmations: 6,
    identity,
    recomputation: withoutAuditFields(attestation),
    canonical: true,
    txIndex: true,
    unpruned: true,
    synchronized: true,
    fullCandidateStreamRecomputed: true,
  }
  return {
    ...source,
    async verifyCandidateAgainstLiveCore() {
      const receipt = structuredClone(baseReceipt)
      return mutate ? mutate(receipt) : receipt
    },
  }
}

async function makeVerifiedBoundaryEvidence(
  fixture: ProofFixture
): Promise<P2TRSignatureFraudVerifiedBoundaryEvidence> {
  const reconcilerAttestation = await verifyFixture(fixture)
  const source = makeLiveSource()
  const liveCoreEvidence = await verifyP2TRLiveCoreCandidateEvidence(
    makeLiveProvider(reconcilerAttestation, source),
    reconcilerAttestation,
    fixture.challenge.bridgeDomain,
    {
      expectedSource: source,
      minimumConfirmations: 6,
      maximumReceiptLifetimeMs: 10_000,
      maximumClockSkewMs: 250,
      nowUnixMs: () => NOW,
    }
  )
  return {
    reconcilerAttestation,
    liveCoreEvidence,
    minimumExportFenceExclusive:
      reconcilerAttestation.payload.export.exportFence - 1,
  }
}

function irreversibleBinding(
  fixture: ProofFixture,
  preparedTransactionHash?: string,
  replacedTransactionHash?: string
): P2TRSignatureFraudIrreversibleBoundaryBinding {
  const request = fixture.challenge.requestBinding
  return {
    recordID: request.recordID,
    generation: request.recordGeneration,
    recordVersion: request.recordVersion,
    reservationID: request.reservationID,
    sender: request.sender,
    transactionNonce: request.transactionNonce,
    stage: request.stage,
    attempt: request.attempt,
    provenanceFingerprint: request.provenanceFingerprint,
    activationManifestHash: request.activationManifestHash,
    laneID: request.laneID,
    signerIdentity: request.signerIdentity,
    intentID: request.intentID,
    routerAddress: request.routerAddress,
    intentValueWei: request.intentValueWei,
    challengeValueWei: request.challengeValueWei,
    maxGasLimit: request.maxGasLimit,
    maxFeePerGas: request.maxFeePerGas,
    maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    maxTotalFeeWei: request.maxTotalFeeWei,
    replacedTransactionHash:
      replacedTransactionHash ?? request.replacedTransactionHash,
    preparedTransactionHash:
      preparedTransactionHash ?? request.preparedTransactionHash,
  }
}

function boundaryAuthorizer(
  evidence: P2TRSignatureFraudVerifiedBoundaryEvidence,
  now: () => number = () => NOW
): P2TRSignatureFraudVerifiedIrreversibleBoundaryAuthorizer {
  return new P2TRSignatureFraudVerifiedIrreversibleBoundaryAuthorizer(
    {
      async acquireVerifiedP2TRSignatureFraudBoundaryEvidence() {
        return evidence
      },
    },
    now
  )
}

describe("signed COMPLETE-v2 reconciler proofs", () => {
  it("accepts an exact compact Ed25519 attestation and rejects brand forgery", async () => {
    const fixture = makeProofFixture()
    const verified = await verifyFixture(fixture)
    const payload = assertP2TRVerifiedReconcilerCandidateAttestation(verified, {
      requestNonce: fixture.challenge.requestNonce,
      requestBindingDigest: fixture.challenge.requestBindingDigest,
      minimumExportFenceExclusive: 6,
      nowUnixMs: NOW,
    })
    assert.equal(payload.export.candidate.identity.inputIndex, 2)
    assert.throws(
      () =>
        assertP2TRVerifiedReconcilerCandidateAttestation(
          { ...verified } as typeof verified,
          {
            requestNonce: fixture.challenge.requestNonce,
            requestBindingDigest: fixture.challenge.requestBindingDigest,
            minimumExportFenceExclusive: 6,
            nowUnixMs: NOW,
          }
        ),
      /not verified by this runtime/
    )
  })

  it("streams exact 64 KiB chunks without concatenating the export", async () => {
    const fixture = makeProofFixture()
    const verified = await verifyFixture(fixture)
    const decoder = new RecordingDecoder(fixture.decoded)
    const result = await streamAndVerifyP2TRReconcilerExport(
      {
        async *loadCandidateEvidenceChunk(_requestNonce, index) {
          yield fixture.chunks[index]
        },
      },
      verified.payload.export,
      decoder
    )
    assert.equal(decoder.writes, 2)
    assert.equal(decoder.maximumWrite, P2TR_RECONCILER_EXPORT_CHUNK_BYTES)
    assert.equal(decoder.finishes, 1)
    assert.equal(decoder.aborts, 0)
    assert.equal(
      result.contentRoot,
      verified.payload.export.contentManifest.root
    )
  })

  it("aborts the transactional decoder for corrupt, truncated, and oversized frames", async () => {
    const fixture = makeProofFixture()
    const verified = await verifyFixture(fixture)
    const cases = [
      {
        label: "corrupt",
        chunks: [Buffer.from(fixture.chunks[0]), fixture.chunks[1]],
        prepare(chunks: Buffer[]) {
          chunks[0][0] ^= 0xff
        },
        pattern: /truncated or corrupt/,
      },
      {
        label: "truncated",
        chunks: [
          fixture.chunks[0].subarray(0, fixture.chunks[0].length - 1),
          fixture.chunks[1],
        ],
        prepare() {},
        pattern: /truncated or corrupt/,
      },
      {
        label: "oversized",
        chunks: [
          Buffer.alloc(P2TR_RECONCILER_EXPORT_CHUNK_BYTES + 1),
          fixture.chunks[1],
        ],
        prepare() {},
        pattern: /chunk length is invalid/,
      },
    ]
    for (const testCase of cases) {
      const chunks = testCase.chunks.map((chunk) => Buffer.from(chunk))
      testCase.prepare(chunks)
      const decoder = new RecordingDecoder(fixture.decoded)
      await assert.rejects(
        streamAndVerifyP2TRReconcilerExport(
          {
            async *loadCandidateEvidenceChunk(_requestNonce, index) {
              yield chunks[index]
            },
          },
          verified.payload.export,
          decoder
        ),
        testCase.pattern,
        testCase.label
      )
      assert.equal(decoder.aborts, 1, testCase.label)
      assert.equal(decoder.finishes, 0, testCase.label)
    }

    const decoder = new RecordingDecoder(fixture.decoded, true)
    await assert.rejects(
      streamAndVerifyP2TRReconcilerExport(
        {
          async *loadCandidateEvidenceChunk(_requestNonce, index) {
            yield fixture.chunks[index]
          },
        },
        verified.payload.export,
        decoder
      ),
      /decoder rejected malformed frame/
    )
    assert.equal(decoder.aborts, 1)
    assert.equal(decoder.finishes, 0)
  })

  it("rejects signature, signer, source, freshness, and exact-request mismatches", async () => {
    const fixture = makeProofFixture()
    const badSignature = structuredClone(fixture.envelope)
    const signature = Buffer.from(badSignature.signature, "base64")
    signature[0] ^= 0xff
    badSignature.signature = signature.toString("base64")
    await assert.rejects(
      verifyP2TRReconcilerCandidateAttestation(
        badSignature,
        fixture.challenge,
        fixture.policy
      ),
      /signature is invalid/
    )

    await assert.rejects(
      verifyP2TRReconcilerCandidateAttestation(
        fixture.envelope,
        fixture.challenge,
        { ...fixture.policy, trustedSignerKeyHash: hex32("0") }
      ),
      /signer identity is not pinned/
    )
    await assert.rejects(
      verifyP2TRReconcilerCandidateAttestation(
        fixture.envelope,
        fixture.challenge,
        {
          ...fixture.policy,
          expectedSource: {
            ...fixture.policy.expectedSource,
            operatorFingerprint: hex32("0"),
          },
        }
      ),
      /not bound to its exact request/
    )

    const stalePayload = structuredClone(fixture.envelope.payload)
    stalePayload.issuedAtUnixMs = NOW - 20_000
    stalePayload.expiresAtUnixMs = NOW
    await assert.rejects(
      verifyP2TRReconcilerCandidateAttestation(
        resign(fixture, stalePayload),
        fixture.challenge,
        fixture.policy
      ),
      /stale, expired, or overlong/
    )

    const changedBinding = structuredClone(fixture.challenge)
    changedBinding.requestBinding.recordVersion++
    changedBinding.requestBindingDigest =
      computeP2TRReconcilerRequestBindingDigest(changedBinding.requestBinding)
    await assert.rejects(
      verifyP2TRReconcilerCandidateAttestation(
        fixture.envelope,
        changedBinding,
        fixture.policy
      ),
      /not bound to its exact request/
    )

    const changedInput = structuredClone(fixture.challenge)
    changedInput.candidate.identity.inputIndex++
    changedInput.candidate.inputProvenance.inputIndex++
    changedInput.candidateDigest = computeP2TRReconcilerCandidateDigest(
      changedInput.candidate
    )
    await assert.rejects(
      verifyP2TRReconcilerCandidateAttestation(
        fixture.envelope,
        changedInput,
        fixture.policy
      ),
      /not bound to its exact request/
    )
  })
})

describe("independent live-Core candidate proof", () => {
  it("accepts a fresh matching recomputation and rejects brand forgery", async () => {
    const fixture = makeProofFixture()
    const attestation = await verifyFixture(fixture)
    const source = makeLiveSource()
    const verified = await verifyP2TRLiveCoreCandidateEvidence(
      makeLiveProvider(attestation, source),
      attestation,
      fixture.challenge.bridgeDomain,
      {
        expectedSource: source,
        minimumConfirmations: 6,
        maximumReceiptLifetimeMs: 10_000,
        maximumClockSkewMs: 250,
        nowUnixMs: () => NOW,
      }
    )
    assert.equal(
      assertP2TRVerifiedLiveCoreCandidateEvidence(verified, {
        reconcilerAttestationDigest: attestation.attestationDigest,
        requestNonce: fixture.challenge.requestNonce,
        exportFence: 7,
        nowUnixMs: NOW,
      }).candidateConfirmations,
      6
    )
    assert.throws(
      () =>
        assertP2TRVerifiedLiveCoreCandidateEvidence(
          { ...verified } as typeof verified,
          {
            reconcilerAttestationDigest: attestation.attestationDigest,
            requestNonce: fixture.challenge.requestNonce,
            exportFence: 7,
            nowUnixMs: NOW,
          }
        ),
      /not verified by this runtime/
    )
  })

  it("requires independent trust, endpoint, and operator identities", async () => {
    const fixture = makeProofFixture()
    const attestation = await verifyFixture(fixture)
    for (const collision of [
      {
        trustDomainID: attestation.payload.source.trustDomainID,
      },
      {
        endpointFingerprint: attestation.payload.source.endpointFingerprint,
      },
      {
        operatorFingerprint: attestation.payload.source.operatorFingerprint,
      },
    ]) {
      const source = { ...makeLiveSource(), ...collision }
      await assert.rejects(
        verifyP2TRLiveCoreCandidateEvidence(
          makeLiveProvider(attestation, source),
          attestation,
          fixture.challenge.bridgeDomain,
          {
            expectedSource: source,
            minimumConfirmations: 6,
            maximumReceiptLifetimeMs: 10_000,
            maximumClockSkewMs: 250,
            nowUnixMs: () => NOW,
          }
        ),
        /not independent/
      )
    }
  })

  it("binds live verification to the signed Bridge domain and Bitcoin network", async () => {
    const fixture = makeProofFixture()
    const attestation = await verifyFixture(fixture)
    const source = makeLiveSource()
    await assert.rejects(
      verifyP2TRLiveCoreCandidateEvidence(
        makeLiveProvider(attestation, source),
        attestation,
        { ...fixture.challenge.bridgeDomain, domainChainID: "2" },
        {
          expectedSource: source,
          minimumConfirmations: 6,
          maximumReceiptLifetimeMs: 10_000,
          maximumClockSkewMs: 250,
          nowUnixMs: () => NOW,
        }
      ),
      /Bridge domain/
    )

    const wrongNetwork = { ...source, network: "testnet" }
    await assert.rejects(
      verifyP2TRLiveCoreCandidateEvidence(
        makeLiveProvider(attestation, wrongNetwork),
        attestation,
        fixture.challenge.bridgeDomain,
        {
          expectedSource: wrongNetwork,
          minimumConfirmations: 6,
          maximumReceiptLifetimeMs: 10_000,
          maximumClockSkewMs: 250,
          nowUnixMs: () => NOW,
        }
      ),
      /Bitcoin network/
    )
  })

  it("rechecks freshness after the asynchronous Core verification", async () => {
    const fixture = makeProofFixture()
    const attestation = await verifyFixture(fixture)
    const source = makeLiveSource()
    const times = [NOW, NOW + 6_000]
    await assert.rejects(
      verifyP2TRLiveCoreCandidateEvidence(
        makeLiveProvider(attestation, source),
        attestation,
        fixture.challenge.bridgeDomain,
        {
          expectedSource: source,
          minimumConfirmations: 6,
          maximumReceiptLifetimeMs: 10_000,
          maximumClockSkewMs: 250,
          nowUnixMs: () => times.shift() ?? NOW + 6_000,
        }
      ),
      /stale|disagrees/
    )
  })

  it("rejects receipt request, input, freshness, and recomputation mismatches", async () => {
    const fixture = makeProofFixture()
    const attestation = await verifyFixture(fixture)
    const source = makeLiveSource()
    const mutations: Array<{
      label: string
      mutate: (
        receipt: P2TRLiveCoreCandidateVerificationReceipt
      ) => P2TRLiveCoreCandidateVerificationReceipt
    }> = [
      {
        label: "request",
        mutate: (receipt) => ({ ...receipt, requestNonce: hex32("0") }),
      },
      {
        label: "input",
        mutate: (receipt) => ({
          ...receipt,
          identity: { ...receipt.identity, inputIndex: 3 },
        }),
      },
      {
        label: "expired",
        mutate: (receipt) => ({ ...receipt, expiresAtUnixMs: NOW }),
      },
      {
        label: "recomputation",
        mutate: (receipt) => ({
          ...receipt,
          recomputation: {
            ...receipt.recomputation,
            shaOutputs: hex32("0"),
          },
        }),
      },
    ]
    for (const { label, mutate } of mutations) {
      await assert.rejects(
        verifyP2TRLiveCoreCandidateEvidence(
          makeLiveProvider(attestation, source, mutate),
          attestation,
          fixture.challenge.bridgeDomain,
          {
            expectedSource: source,
            minimumConfirmations: 6,
            maximumReceiptLifetimeMs: 10_000,
            maximumClockSkewMs: 250,
            nowUnixMs: () => NOW,
          }
        ),
        /disagrees/,
        label
      )
    }
  })
})

describe("irreversible outbox boundary authorization", () => {
  it("accepts generation zero in the exact reconciler request binding", async () => {
    const fixture = makeProofFixture({
      requestBinding: { recordGeneration: 0 },
    })
    assert.equal(fixture.challenge.requestBinding.recordGeneration, 0)
    await verifyFixture(fixture)
  })

  it("mints and synchronously consumes one exact process-local capability", async () => {
    const fixture = makeProofFixture()
    const evidence = await makeVerifiedBoundaryEvidence(fixture)
    const authorizer = boundaryAuthorizer(evidence)
    const binding = irreversibleBinding(fixture)
    const authorization =
      await authorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(binding)
    authorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
      authorization,
      binding,
      NOW
    )
    assert.throws(
      () =>
        authorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
          authorization,
          binding,
          NOW
        ),
      /forged, copied, or replayed/
    )
  })

  it("rejects a cached attestation that does not echo the boundary nonce", async () => {
    const fixture = makeProofFixture()
    const staleFixture = makeProofFixture({
      requestBinding: { recordVersion: 3 },
    })
    const evidence = await makeVerifiedBoundaryEvidence(staleFixture)
    const binding = irreversibleBinding(fixture)
    const authorizer =
      new P2TRSignatureFraudVerifiedIrreversibleBoundaryAuthorizer(
        {
          async acquireVerifiedP2TRSignatureFraudBoundaryEvidence() {
            return evidence
          },
        },
        () => NOW
      )

    await assert.rejects(
      authorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(binding),
      /stale or for another attempt/
    )
  })

  it("rejects forged, wrong-stage, wrong-attempt, and stale capabilities", async () => {
    const fixture = makeProofFixture()
    const evidence = await makeVerifiedBoundaryEvidence(fixture)
    const binding = irreversibleBinding(fixture)

    const forgedAuthorizer = boundaryAuthorizer(evidence)
    assert.throws(
      () =>
        forgedAuthorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
          {} as P2TRSignatureFraudIrreversibleBoundaryAuthorization,
          binding,
          NOW
        ),
      /forged, copied, or replayed/
    )

    for (const changed of [
      // Stage-consistent on its own terms, so it reaches the binding
      // comparison rather than tripping the stage invariant first.
      {
        ...binding,
        stage: "replacement" as const,
        replacedTransactionHash: hex32("9"),
      },
      { ...binding, attempt: binding.attempt + 1 },
    ]) {
      const authorizer = boundaryAuthorizer(evidence)
      const authorization =
        await authorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
          binding
        )
      assert.throws(
        () =>
          authorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
            authorization,
            changed,
            NOW
          ),
        /another durable attempt/
      )
    }

    const staleAuthorizer = boundaryAuthorizer(evidence)
    const stale =
      await staleAuthorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
        binding
      )
    assert.throws(
      () =>
        staleAuthorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
          stale,
          binding,
          NOW + 6_000
        ),
      /stale|another attempt/
    )
  })

  it("binds provenance, activation manifest, and exact broadcast bytes", async () => {
    const preparedTransactionHash = hex32("9")
    const fixture = makeProofFixture({
      requestBinding: {
        stage: "broadcast",
        preparedTransactionHash,
      },
    })
    const evidence = await makeVerifiedBoundaryEvidence(fixture)
    const binding = irreversibleBinding(fixture)
    const exactAuthorizer = boundaryAuthorizer(evidence)
    const exact =
      await exactAuthorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
        binding
      )
    exactAuthorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
      exact,
      binding,
      NOW
    )

    for (const changed of [
      { ...binding, provenanceFingerprint: hex32("8") },
      { ...binding, activationManifestHash: hex32("7") },
      { ...binding, preparedTransactionHash: hex32("6") },
    ]) {
      await assert.rejects(
        boundaryAuthorizer(
          evidence
        ).authorizeP2TRSignatureFraudIrreversibleBoundary(changed),
        /another durable outbox boundary|another attempt/
      )
    }
    await assert.rejects(
      boundaryAuthorizer(
        evidence
      ).authorizeP2TRSignatureFraudIrreversibleBoundary({
        ...binding,
        preparedTransactionHash: undefined,
      }),
      /Signer authorizations require an exact request digest|Only a broadcast authorization may name prepared transaction bytes|broadcast authorizations require exact prepared bytes/
    )
  })

  it("covers every bound field in the request-binding digest itself", () => {
    // The authorizer has a second, independent defence — a JSON.stringify
    // comparison of the whole binding — so an authorization-level test cannot
    // distinguish "in the digest" from "caught by that comparison". This
    // asserts digest coverage directly: it is the digest a remote reconciler
    // signs, and the only thing that travels between trust domains.
    const base = makeProofFixture().challenge.requestBinding
    const digest = computeP2TRReconcilerRequestBindingDigest(base)
    const mutations: Partial<typeof base>[] = [
      { laneID: "lane-b" },
      { signerIdentity: "signer-b" },
      { intentID: hex32("7") },
      { routerAddress: `0x${"78".repeat(20)}` },
      { intentValueWei: "2000000000000000000" },
      { challengeValueWei: "2000000000000000000" },
      { maxGasLimit: "600000" },
      { maxFeePerGas: "50000000000" },
      { maxPriorityFeePerGas: "3000000000" },
      { maxTotalFeeWei: "30000000000000000" },
    ]
    for (const mutation of mutations) {
      const [field] = Object.keys(mutation)
      assert.notEqual(
        computeP2TRReconcilerRequestBindingDigest({ ...base, ...mutation }),
        digest,
        `${field} is absent from the request-binding digest`
      )
    }

    // The replacement hash is bound on the stage that carries it.
    const replacement = {
      ...base,
      stage: "replacement" as const,
      replacedTransactionHash: hex32("9"),
    }
    assert.notEqual(
      computeP2TRReconcilerRequestBindingDigest({
        ...replacement,
        replacedTransactionHash: hex32("8"),
      }),
      computeP2TRReconcilerRequestBindingDigest(replacement),
      "replacedTransactionHash is absent from the request-binding digest"
    )
  })

  it("binds the lane, the intent, and the exact fee envelope", async () => {
    const fixture = makeProofFixture()
    const evidence = await makeVerifiedBoundaryEvidence(fixture)
    const binding = irreversibleBinding(fixture)

    const exactAuthorizer = boundaryAuthorizer(evidence)
    const exact =
      await exactAuthorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
        binding
      )
    exactAuthorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
      exact,
      binding,
      NOW
    )

    // Each of these names something the signer is actually handed. Changing any
    // one of them must stop matching evidence attested for the original
    // request — otherwise the field is carried but not authenticated.
    const mutations: Partial<P2TRSignatureFraudIrreversibleBoundaryBinding>[] =
      [
        { laneID: "lane-b" },
        { signerIdentity: "signer-b" },
        { intentID: hex32("7") },
        { routerAddress: `0x${"78".repeat(20)}` },
        { intentValueWei: "2000000000000000000" },
        { challengeValueWei: "2000000000000000000" },
        { maxGasLimit: "600000" },
        { maxFeePerGas: "50000000000" },
        { maxPriorityFeePerGas: "3000000000" },
        { maxTotalFeeWei: "30000000000000000" },
      ]
    for (const mutation of mutations) {
      const [field] = Object.keys(mutation)
      await assert.rejects(
        boundaryAuthorizer(
          evidence
        ).authorizeP2TRSignatureFraudIrreversibleBoundary({
          ...binding,
          ...mutation,
        }),
        /another durable outbox boundary|another attempt/,
        `${field} is not bound by the authorized digest`
      )
    }
  })

  it("gives each boundary stage exactly one legal transaction-hash shape", async () => {
    const replacementFixture = makeProofFixture({
      requestBinding: {
        stage: "replacement",
        replacedTransactionHash: hex32("9"),
      },
    })
    const replacementEvidence = await makeVerifiedBoundaryEvidence(
      replacementFixture
    )
    const replacement = irreversibleBinding(replacementFixture)
    const replacementAuthorizer = boundaryAuthorizer(replacementEvidence)
    const authorization =
      await replacementAuthorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
        replacement
      )
    replacementAuthorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
      authorization,
      replacement,
      NOW
    )

    const prepareFixture = makeProofFixture()
    const prepareEvidence = await makeVerifiedBoundaryEvidence(prepareFixture)
    const prepare = irreversibleBinding(prepareFixture)

    for (const [invalid, pattern] of [
      [
        { ...prepare, replacedTransactionHash: hex32("9") },
        /Only a replacement authorization may name the superseded transaction/,
      ],
      [
        { ...prepare, preparedTransactionHash: hex32("9") },
        /Only a broadcast authorization may name prepared transaction bytes/,
      ],
      [
        { ...replacement, replacedTransactionHash: undefined },
        /Only a replacement authorization may name the superseded transaction/,
      ],
      [
        { ...replacement, preparedTransactionHash: hex32("6") },
        /Only a broadcast authorization may name prepared transaction bytes/,
      ],
    ] as const) {
      await assert.rejects(
        boundaryAuthorizer(
          invalid.stage === "replacement"
            ? replacementEvidence
            : prepareEvidence
        ).authorizeP2TRSignatureFraudIrreversibleBoundary(
          invalid as P2TRSignatureFraudIrreversibleBoundaryBinding
        ),
        pattern
      )
    }
  })

  it("rejects an older pending capability after a newer export fence", async () => {
    const firstFixture = makeProofFixture({ exportFence: 7 })
    const secondFixture = makeProofFixture({
      exportFence: 8,
      requestBinding: {
        recordVersion: 5,
        stage: "replacement",
        replacedTransactionHash: hex32("8"),
        attempt: 3,
      },
    })
    const firstEvidence = await makeVerifiedBoundaryEvidence(firstFixture)
    const secondEvidence = await makeVerifiedBoundaryEvidence(secondFixture)
    const authorizer =
      new P2TRSignatureFraudVerifiedIrreversibleBoundaryAuthorizer(
        {
          async acquireVerifiedP2TRSignatureFraudBoundaryEvidence(binding) {
            return binding.recordVersion === 4 ? firstEvidence : secondEvidence
          },
        },
        () => NOW
      )
    const firstBinding = irreversibleBinding(firstFixture)
    const secondBinding = irreversibleBinding(secondFixture)
    const first =
      await authorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
        firstBinding
      )
    const second =
      await authorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
        secondBinding
      )
    assert.throws(
      () =>
        authorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
          first,
          firstBinding,
          NOW
        ),
      /superseded/
    )
    authorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
      second,
      secondBinding,
      NOW
    )
  })
})
