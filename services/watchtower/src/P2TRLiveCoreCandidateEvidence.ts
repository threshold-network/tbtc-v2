import { createHash } from "node:crypto"
import {
  assertP2TRVerifiedCompleteCandidateIdentity,
  type P2TRCompleteBridgeDomain,
  type P2TRCompleteCandidateIdentity,
} from "./P2TRCompleteCandidateIdentity.js"
import {
  assertP2TRVerifiedReconcilerCandidateAttestation,
  type P2TRReconcilerStreamComputation,
  type P2TRVerifiedReconcilerCandidateAttestation,
} from "./P2TRReconcilerAttestation.js"

export type P2TRLiveCoreSourceIdentity = {
  trustDomainID: string
  endpointFingerprint: string
  operatorFingerprint: string
  protocolID: string
  network: string
  genesisHash: string
}

export type P2TRLiveCoreCandidateVerificationReceipt = {
  schema: "tbtc-p2tr-live-core-candidate-verification/v1"
  requestNonce: string
  reconcilerAttestationDigest: string
  exportFence: number
  source: P2TRLiveCoreSourceIdentity
  checkedAtUnixMs: number
  expiresAtUnixMs: number
  bestPoint: { height: number; hash: string }
  candidateConfirmations: number
  identity: P2TRCompleteCandidateIdentity
  recomputation: P2TRReconcilerStreamComputation
  canonical: true
  txIndex: true
  unpruned: true
  synchronized: true
  fullCandidateStreamRecomputed: true
}

export type P2TRLiveCoreCandidateEvidenceProvider =
  P2TRLiveCoreSourceIdentity & {
    verifyCandidateAgainstLiveCore(request: {
      requestNonce: string
      reconcilerAttestationDigest: string
      exportFence: number
      bridgeDomain: P2TRCompleteBridgeDomain
      identity: P2TRCompleteCandidateIdentity
    }): Promise<P2TRLiveCoreCandidateVerificationReceipt>
  }

export type P2TRLiveCoreCandidateVerificationPolicy = {
  expectedSource: P2TRLiveCoreSourceIdentity
  minimumConfirmations: number
  maximumReceiptLifetimeMs: number
  maximumClockSkewMs: number
  nowUnixMs?: () => number
}

const verifiedLiveCoreEvidence = new WeakSet<object>()
const liveCoreEvidenceBrand: unique symbol = Symbol(
  "P2TRVerifiedLiveCoreCandidateEvidence"
)

export type P2TRVerifiedLiveCoreCandidateEvidence = {
  readonly [liveCoreEvidenceBrand]: true
  readonly receipt: Readonly<P2TRLiveCoreCandidateVerificationReceipt>
  readonly reconcilerAttestationDigest: string
  readonly liveEvidenceDigest: string
}

/**
 * Performs a fresh, independent live-Core check and binds it to one already
 * verified remote reconciler attestation. The provider must be the concrete
 * full-stream Core verifier pinned by the activation manifest; a signed remote
 * attestation can never manufacture this process-local brand.
 */
export async function verifyP2TRLiveCoreCandidateEvidence(
  provider: P2TRLiveCoreCandidateEvidenceProvider,
  attestation: P2TRVerifiedReconcilerCandidateAttestation,
  bridgeDomain: P2TRCompleteBridgeDomain,
  policy: P2TRLiveCoreCandidateVerificationPolicy
): Promise<P2TRVerifiedLiveCoreCandidateEvidence> {
  const now = nonNegativeInteger(
    (policy.nowUnixMs ?? Date.now)(),
    "live-Core verification time"
  )
  const payload = assertP2TRVerifiedReconcilerCandidateAttestation(
    attestation,
    {
      requestNonce: attestation.payload.requestNonce,
      requestBindingDigest: attestation.payload.requestBindingDigest,
      minimumExportFenceExclusive: attestation.payload.export.exportFence - 1,
      nowUnixMs: now,
    }
  )
  const expectedSource = normalizeSource(policy.expectedSource)
  const actualProviderSource = normalizeSource(provider)
  if (canonicalJSON(actualProviderSource) !== canonicalJSON(expectedSource)) {
    throw new Error("Live-Core verifier identity is not manifest-pinned")
  }
  const remoteSource = payload.source
  if (
    actualProviderSource.trustDomainID === remoteSource.trustDomainID ||
    actualProviderSource.endpointFingerprint ===
      remoteSource.endpointFingerprint ||
    actualProviderSource.operatorFingerprint ===
      remoteSource.operatorFingerprint
  ) {
    throw new Error("Live-Core verifier is not independent from the reconciler")
  }

  const identity = assertP2TRVerifiedCompleteCandidateIdentity(
    attestation.completeIdentity
  )
  const receipt = normalizeReceipt(
    await provider.verifyCandidateAgainstLiveCore({
      requestNonce: payload.requestNonce,
      reconcilerAttestationDigest: attestation.attestationDigest,
      exportFence: payload.export.exportFence,
      bridgeDomain,
      identity,
    })
  )
  const remoteComputation = payload.export.candidate.recomputation
  const {
    auditContentRoot: _auditContentRoot,
    auditResultDigest: _auditResultDigest,
    ...remoteStreamComputation
  } = remoteComputation
  if (
    receipt.requestNonce !== payload.requestNonce ||
    receipt.reconcilerAttestationDigest !== attestation.attestationDigest ||
    receipt.exportFence !== payload.export.exportFence ||
    canonicalJSON(receipt.source) !== canonicalJSON(expectedSource) ||
    canonicalJSON(receipt.identity) !== canonicalJSON(identity) ||
    canonicalJSON(receipt.recomputation) !==
      canonicalJSON(remoteStreamComputation) ||
    receipt.candidateConfirmations <
      positiveInteger(policy.minimumConfirmations, "minimum confirmations") ||
    receipt.bestPoint.height < identity.blockHeight ||
    receipt.candidateConfirmations !==
      receipt.bestPoint.height - identity.blockHeight + 1 ||
    receipt.checkedAtUnixMs >
      now + nonNegativeInteger(policy.maximumClockSkewMs, "clock skew") ||
    receipt.expiresAtUnixMs <= now ||
    receipt.expiresAtUnixMs <= receipt.checkedAtUnixMs ||
    receipt.expiresAtUnixMs - receipt.checkedAtUnixMs >
      positiveInteger(
        policy.maximumReceiptLifetimeMs,
        "live-Core receipt lifetime"
      )
  ) {
    throw new Error(
      "Live-Core evidence disagrees with the reconciler candidate"
    )
  }

  const result = Object.freeze({
    [liveCoreEvidenceBrand]: true as const,
    receipt: deepFreeze(structuredClone(receipt)),
    reconcilerAttestationDigest: attestation.attestationDigest,
    liveEvidenceDigest: sha256({
      schema: "tbtc-p2tr-verified-live-core-evidence/v1",
      receipt,
    }),
  }) as P2TRVerifiedLiveCoreCandidateEvidence
  verifiedLiveCoreEvidence.add(result)
  return result
}

/** Rechecks freshness immediately before a signer or broadcaster boundary. */
export function assertP2TRVerifiedLiveCoreCandidateEvidence(
  value: P2TRVerifiedLiveCoreCandidateEvidence,
  expected: {
    reconcilerAttestationDigest: string
    requestNonce: string
    exportFence: number
    nowUnixMs?: number
  }
): Readonly<P2TRLiveCoreCandidateVerificationReceipt> {
  if (!verifiedLiveCoreEvidence.has(value as object)) {
    throw new Error("Live-Core evidence was not verified by this runtime")
  }
  const receipt = value.receipt
  if (
    value.reconcilerAttestationDigest !==
      bytes32(
        expected.reconcilerAttestationDigest,
        "expected reconciler attestation"
      ) ||
    receipt.requestNonce !== bytes32(expected.requestNonce, "expected nonce") ||
    receipt.exportFence !==
      positiveInteger(expected.exportFence, "export fence") ||
    receipt.expiresAtUnixMs <=
      nonNegativeInteger(expected.nowUnixMs ?? Date.now(), "assertion time")
  ) {
    throw new Error(
      "Verified live-Core evidence is stale or for another attempt"
    )
  }
  return receipt
}

function normalizeReceipt(
  value: P2TRLiveCoreCandidateVerificationReceipt
): P2TRLiveCoreCandidateVerificationReceipt {
  if (
    value.schema !== "tbtc-p2tr-live-core-candidate-verification/v1" ||
    value.canonical !== true ||
    value.txIndex !== true ||
    value.unpruned !== true ||
    value.synchronized !== true ||
    value.fullCandidateStreamRecomputed !== true
  ) {
    throw new Error(
      "Live-Core provider did not perform a production verification"
    )
  }
  return {
    schema: value.schema,
    requestNonce: bytes32(value.requestNonce, "live-Core request nonce"),
    reconcilerAttestationDigest: bytes32(
      value.reconcilerAttestationDigest,
      "live-Core reconciler attestation"
    ),
    exportFence: positiveInteger(value.exportFence, "live-Core export fence"),
    source: normalizeSource(value.source),
    checkedAtUnixMs: nonNegativeInteger(
      value.checkedAtUnixMs,
      "live-Core check time"
    ),
    expiresAtUnixMs: positiveInteger(value.expiresAtUnixMs, "live-Core expiry"),
    bestPoint: {
      height: nonNegativeInteger(
        value.bestPoint.height,
        "live-Core tip height"
      ),
      hash: bytes32(value.bestPoint.hash, "live-Core tip hash"),
    },
    candidateConfirmations: positiveInteger(
      value.candidateConfirmations,
      "live-Core candidate confirmations"
    ),
    identity: normalizeIdentity(value.identity),
    recomputation: normalizeStreamComputation(value.recomputation),
    canonical: true,
    txIndex: true,
    unpruned: true,
    synchronized: true,
    fullCandidateStreamRecomputed: true,
  }
}

function normalizeIdentity(
  value: P2TRCompleteCandidateIdentity
): P2TRCompleteCandidateIdentity {
  return {
    schema:
      value.schema === "tbtc-p2tr-complete-candidate/v2"
        ? value.schema
        : fail("Live-Core candidate schema is unsupported"),
    txid: bytes32(value.txid, "live-Core candidate txid"),
    wtxid: bytes32(value.wtxid, "live-Core candidate wtxid"),
    blockHeight: nonNegativeInteger(
      value.blockHeight,
      "live-Core candidate height"
    ),
    blockHash: bytes32(value.blockHash, "live-Core candidate block"),
    inputIndex: uint32(value.inputIndex, "live-Core candidate input"),
    evidence: {
      walletID: bytes32(value.evidence.walletID, "live-Core wallet ID"),
      signingKey: bytes32(value.evidence.signingKey, "live-Core signing key"),
      bindingTxHash: bytes32(
        value.evidence.bindingTxHash,
        "live-Core binding tx"
      ),
      bindingOutputIndex: uint32(
        value.evidence.bindingOutputIndex,
        "live-Core binding output"
      ),
      sighash: bytes32(value.evidence.sighash, "live-Core sighash"),
      nonceX: bytes32(value.evidence.nonceX, "live-Core nonce"),
      signatureScalar: bytes32(
        value.evidence.signatureScalar,
        "live-Core signature scalar"
      ),
    },
    challengeIdentity: bytes32(
      value.challengeIdentity,
      "live-Core challenge identity"
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
    throw new Error("Live-Core computation is incomplete")
  }
  return {
    schema: value.schema,
    protocolID: bytes32(value.protocolID, "live-Core protocol"),
    canonicalStreamSchema: value.canonicalStreamSchema,
    inputIndex: uint32(value.inputIndex, "live-Core computation input"),
    rawTransactionDigest: bytes32(
      value.rawTransactionDigest,
      "live-Core raw transaction"
    ),
    rawTransactionBytes: positiveInteger(
      value.rawTransactionBytes,
      "live-Core raw transaction bytes"
    ),
    witnessDigest: bytes32(value.witnessDigest, "live-Core witness"),
    annexDigest: bytes32(value.annexDigest, "live-Core annex"),
    prevoutVectorRoot: bytes32(
      value.prevoutVectorRoot,
      "live-Core prevout root"
    ),
    prevoutCount: positiveInteger(
      value.prevoutCount,
      "live-Core prevout count"
    ),
    prevoutBytes: positiveInteger(
      value.prevoutBytes,
      "live-Core prevout bytes"
    ),
    shaPrevouts: bytes32(value.shaPrevouts, "live-Core prevouts hash"),
    shaAmounts: bytes32(value.shaAmounts, "live-Core amounts hash"),
    shaScriptPubKeys: bytes32(value.shaScriptPubKeys, "live-Core scripts hash"),
    shaSequences: bytes32(value.shaSequences, "live-Core sequences hash"),
    shaOutputs: bytes32(value.shaOutputs, "live-Core outputs hash"),
    computedSighash: bytes32(value.computedSighash, "live-Core sighash"),
    candidateBlockHeaderHash: bytes32(
      value.candidateBlockHeaderHash,
      "live-Core candidate header"
    ),
    fundingBlockHeaderHash: bytes32(
      value.fundingBlockHeaderHash,
      "live-Core funding header"
    ),
    allInputsConsumed: true,
  }
}

function normalizeSource(
  value: P2TRLiveCoreSourceIdentity
): P2TRLiveCoreSourceIdentity {
  return {
    trustDomainID: boundedString(value.trustDomainID, 128, "Core trust domain"),
    endpointFingerprint: bytes32(value.endpointFingerprint, "Core endpoint"),
    operatorFingerprint: bytes32(value.operatorFingerprint, "Core operator"),
    protocolID: bytes32(value.protocolID, "Core verifier protocol"),
    network: boundedString(value.network, 64, "Core network"),
    genesisHash: bytes32(value.genesisHash, "Core genesis hash"),
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
  throw new Error("Canonical live-Core value is unsupported")
}

function bytes32(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be 32 bytes`)
  }
  return normalized
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

function fail(message: string): never {
  throw new Error(message)
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
