import {
  assertP2TRVerifiedLiveCoreCandidateEvidence,
  type P2TRVerifiedLiveCoreCandidateEvidence,
} from "./P2TRLiveCoreCandidateEvidence.js"
import {
  assertP2TRVerifiedReconcilerCandidateAttestation,
  computeP2TRReconcilerRequestBindingDigest,
  type P2TRReconcilerRequestBinding,
  type P2TRVerifiedReconcilerCandidateAttestation,
} from "./P2TRReconcilerAttestation.js"
import type {
  P2TRSignatureFraudIrreversibleBoundaryAuthorization,
  P2TRSignatureFraudIrreversibleBoundaryAuthorizer,
  P2TRSignatureFraudIrreversibleBoundaryBinding,
} from "./P2TRSignatureFraudChallengeOutbox.js"

export type P2TRSignatureFraudVerifiedBoundaryEvidence = {
  reconcilerAttestation: P2TRVerifiedReconcilerCandidateAttestation
  liveCoreEvidence: P2TRVerifiedLiveCoreCandidateEvidence
  /**
   * Persisted fence from the last independently accepted export. The provider
   * must atomically advance/reserve the newly returned export fence before it
   * resolves, so a process restart cannot make the evidence replayable.
   */
  minimumExportFenceExclusive: number
}

/**
 * The acquisition implementation constructs and verifies the signed
 * reconciler challenge and the independent live-Core receipt. It receives the
 * exact post-CAS binding, including the provenance, activation manifest, and
 * transaction hash committed by the remote request-binding schema.
 */
export interface P2TRSignatureFraudVerifiedBoundaryEvidenceProvider {
  acquireVerifiedP2TRSignatureFraudBoundaryEvidence(
    binding: P2TRSignatureFraudIrreversibleBoundaryBinding
  ): Promise<P2TRSignatureFraudVerifiedBoundaryEvidence>
}

type NormalizedBoundaryBinding = {
  recordID: string
  generation: number
  recordVersion: number
  reservationID: string
  sender: string
  transactionNonce: number
  stage: "prepare" | "replacement" | "broadcast"
  attempt: number
  provenanceFingerprint: string
  activationManifestHash: string
  preparedTransactionHash?: string
}

type PendingAuthorization = {
  binding: NormalizedBoundaryBinding
  reconcilerAttestation: P2TRVerifiedReconcilerCandidateAttestation
  liveCoreEvidence: P2TRVerifiedLiveCoreCandidateEvidence
  minimumExportFenceExclusive: number
  authorizedAtUnixMs: number
  exportFence: number
}

/**
 * Converts the two process-local verification brands into a one-use boundary
 * capability. The capability cannot be serialized or reconstructed and is
 * consumed synchronously immediately before external signer/broadcaster I/O.
 */
export class P2TRSignatureFraudVerifiedIrreversibleBoundaryAuthorizer
  implements P2TRSignatureFraudIrreversibleBoundaryAuthorizer
{
  private readonly pending = new WeakMap<object, PendingAuthorization>()
  private highestObservedExportFence = -1

  constructor(
    private readonly provider: P2TRSignatureFraudVerifiedBoundaryEvidenceProvider,
    private readonly now: () => number = Date.now
  ) {
    if (
      provider === undefined ||
      typeof provider.acquireVerifiedP2TRSignatureFraudBoundaryEvidence !==
        "function"
    ) {
      throw new Error(
        "Verified boundary authorizer requires an evidence provider"
      )
    }
  }

  async authorizeP2TRSignatureFraudIrreversibleBoundary(
    bindingValue: P2TRSignatureFraudIrreversibleBoundaryBinding
  ): Promise<P2TRSignatureFraudIrreversibleBoundaryAuthorization> {
    const binding = normalizeBoundaryBinding(bindingValue)
    const evidence =
      await this.provider.acquireVerifiedP2TRSignatureFraudBoundaryEvidence(
        binding
      )
    const nowUnixMs = nonNegativeSafeInteger(
      this.now(),
      "Boundary authorization time"
    )
    const minimumExportFenceExclusive = Math.max(
      nonNegativeSafeInteger(
        evidence.minimumExportFenceExclusive,
        "Boundary minimum export fence"
      ),
      this.highestObservedExportFence
    )
    const requestBinding = reconcilerRequestBinding(binding)
    const requestBindingDigest =
      computeP2TRReconcilerRequestBindingDigest(requestBinding)
    const payload = assertP2TRVerifiedReconcilerCandidateAttestation(
      evidence.reconcilerAttestation,
      {
        requestNonce: evidence.reconcilerAttestation.payload.requestNonce,
        requestBindingDigest,
        minimumExportFenceExclusive,
        nowUnixMs,
      }
    )
    if (
      JSON.stringify(payload.requestBinding) !==
        JSON.stringify(requestBinding) ||
      bytes32(
        payload.export.candidate.provenanceFingerprint,
        "Attested provenance fingerprint"
      ) !== binding.provenanceFingerprint ||
      bytes32(payload.manifestHash, "Attested activation manifest hash") !==
        binding.activationManifestHash
    ) {
      throw new Error(
        "Verified reconciler evidence is for another durable outbox boundary"
      )
    }
    assertP2TRVerifiedLiveCoreCandidateEvidence(evidence.liveCoreEvidence, {
      reconcilerAttestationDigest:
        evidence.reconcilerAttestation.attestationDigest,
      requestNonce: payload.requestNonce,
      exportFence: payload.export.exportFence,
      nowUnixMs,
    })
    this.highestObservedExportFence = payload.export.exportFence

    const authorization = Object.freeze(
      {}
    ) as P2TRSignatureFraudIrreversibleBoundaryAuthorization
    this.pending.set(authorization, {
      binding,
      reconcilerAttestation: evidence.reconcilerAttestation,
      liveCoreEvidence: evidence.liveCoreEvidence,
      minimumExportFenceExclusive,
      authorizedAtUnixMs: nowUnixMs,
      exportFence: payload.export.exportFence,
    })
    return authorization
  }

  assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
    authorization: P2TRSignatureFraudIrreversibleBoundaryAuthorization,
    bindingValue: P2TRSignatureFraudIrreversibleBoundaryBinding,
    nowUnixMsValue: number
  ): void {
    const candidate = authorization as object
    const pending = this.pending.get(candidate)
    // Delete before any validation so a failed or adversarial consumption can
    // never turn one authorization into a retryable capability.
    this.pending.delete(candidate)
    if (pending === undefined) {
      throw new Error(
        "Irreversible-boundary authorization is forged, copied, or replayed"
      )
    }
    const binding = normalizeBoundaryBinding(bindingValue)
    if (JSON.stringify(binding) !== JSON.stringify(pending.binding)) {
      throw new Error(
        "Irreversible-boundary authorization names another durable attempt"
      )
    }
    const nowUnixMs = nonNegativeSafeInteger(
      nowUnixMsValue,
      "Boundary authorization consumption time"
    )
    if (nowUnixMs < pending.authorizedAtUnixMs) {
      throw new Error("Boundary authorization clock moved backwards")
    }
    if (pending.exportFence < this.highestObservedExportFence) {
      throw new Error(
        "Irreversible-boundary authorization was superseded by a newer export fence"
      )
    }
    const requestBindingDigest = computeP2TRReconcilerRequestBindingDigest(
      reconcilerRequestBinding(binding)
    )
    const payload = assertP2TRVerifiedReconcilerCandidateAttestation(
      pending.reconcilerAttestation,
      {
        requestNonce: pending.reconcilerAttestation.payload.requestNonce,
        requestBindingDigest,
        minimumExportFenceExclusive: pending.minimumExportFenceExclusive,
        nowUnixMs,
      }
    )
    assertP2TRVerifiedLiveCoreCandidateEvidence(pending.liveCoreEvidence, {
      reconcilerAttestationDigest:
        pending.reconcilerAttestation.attestationDigest,
      requestNonce: payload.requestNonce,
      exportFence: payload.export.exportFence,
      nowUnixMs,
    })
  }
}

function reconcilerRequestBinding(
  value: NormalizedBoundaryBinding
): P2TRReconcilerRequestBinding {
  return {
    recordID: value.recordID,
    recordGeneration: value.generation,
    recordVersion: value.recordVersion,
    reservationID: value.reservationID,
    sender: value.sender,
    transactionNonce: value.transactionNonce,
    stage: value.stage,
    attempt: value.attempt,
    provenanceFingerprint: value.provenanceFingerprint,
    activationManifestHash: value.activationManifestHash,
    ...(value.preparedTransactionHash === undefined
      ? {}
      : { preparedTransactionHash: value.preparedTransactionHash }),
  }
}

function normalizeBoundaryBinding(
  value: P2TRSignatureFraudIrreversibleBoundaryBinding
): NormalizedBoundaryBinding {
  if (
    value?.stage !== "prepare" &&
    value?.stage !== "replacement" &&
    value?.stage !== "broadcast"
  ) {
    throw new Error("Irreversible-boundary stage is invalid")
  }
  const preparedTransactionHash =
    value.preparedTransactionHash === undefined
      ? undefined
      : bytes32(
          value.preparedTransactionHash,
          "Boundary prepared transaction hash"
        )
  if (
    (value.stage === "broadcast") !==
    (preparedTransactionHash !== undefined)
  ) {
    throw new Error(
      "Only a broadcast authorization may name prepared transaction bytes"
    )
  }
  return {
    recordID: bytes32(value.recordID, "Boundary record ID"),
    generation: nonNegativeSafeInteger(
      value.generation,
      "Boundary record generation"
    ),
    recordVersion: nonNegativeSafeInteger(
      value.recordVersion,
      "Boundary record version"
    ),
    reservationID: bytes32(value.reservationID, "Boundary reservation ID"),
    sender: address(value.sender, "Boundary sender"),
    transactionNonce: nonNegativeSafeInteger(
      value.transactionNonce,
      "Boundary transaction nonce"
    ),
    stage: value.stage,
    attempt: positiveSafeInteger(value.attempt, "Boundary attempt"),
    provenanceFingerprint: bytes32(
      value.provenanceFingerprint,
      "Boundary provenance fingerprint"
    ),
    activationManifestHash: bytes32(
      value.activationManifestHash,
      "Boundary activation manifest hash"
    ),
    preparedTransactionHash,
  }
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

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}
