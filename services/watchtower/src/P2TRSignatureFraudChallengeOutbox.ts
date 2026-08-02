import { createHash } from "node:crypto"

import {
  Hex,
  P2TRSignatureFraudBoundNonceReservation,
  P2TRSignatureFraudChallengeTransactionPreparer,
  P2TRSignatureFraudChallengeTransactionFeePolicy,
  P2TRSignatureFraudNonceReleaseAcknowledgement,
  P2TRSignatureFraudPreparedChallengeTransaction,
  P2TRSignatureFraudPreparedChallengeTransactionResponse,
  P2TRSignatureFraudPreparedNonceBurnTransaction,
  P2TR_SIGNATURE_FRAUD_NONCE_BURN_GAS_LIMIT,
  validateP2TRSignatureFraudPreparedNonceBurnTransaction,
  P2TRSignatureFraudSubmissionIntentOptions,
  P2TRSignatureFraudSubmissionIntent,
  P2TRSignatureFraudWitnessObservationConsistencyContext,
  P2TRSignatureFraudWitnessObservation,
  P2TRWalletInputKeyBinding,
  P2TRWatchtowerChallengeRecord,
  P2TRWatchtowerChallengeRecordSource,
  P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID,
  buildP2TRCompleteV2SignatureFraudChallengeEvidence,
  buildP2TRSignatureFraudSubmissionIntent,
  computeP2TRSignatureFraudSubmissionIntentID,
  extractP2TRWalletIDFromScriptPubKey,
  validateP2TRCompleteV2SignatureFraudSubmissionIntent,
  validateP2TRSignatureFraudPreparedChallengeReplacementTransaction,
  validateP2TRSignatureFraudPreparedChallengeTransaction,
  validateP2TRSignatureFraudPreparedChallengeTransactionReservation,
  validateP2TRSignatureFraudPreparedEIP1559ChallengeTransaction,
  recoverP2TRSignatureFraudPreparedChallengeTransaction,
  recoverP2TRSignatureFraudSignedTransactionEnvelope,
  validateP2TRSignatureFraudSignerResponseBinding,
  validateP2TRSignatureFraudBoundNonceReservation,
  validateP2TRSignatureFraudWitnessObservationConsistency,
} from "@keep-network/tbtc-v2.ts"

// A value import, unlike the authorization module's type-only import of this
// file, so the dependency runs one way at run time and there is no cycle.
import { computeP2TRSignatureFraudSignerInvocationRequest } from "./P2TRSignatureFraudIrreversibleBoundaryAuthorization.js"
import type { P2TRSignatureFraudWatchtowerStoreProfileProvider } from "./types.js"

export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE = 1_000
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_LEASE_OWNER_LENGTH = 128
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH = 128
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_ERROR_LENGTH = 1_024
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_CURSOR_LENGTH = 512
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH = 128
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_SIGNED_VARIANTS = 16
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_GENERATIONS = 32
/**
 * Floor on the reconciler's declared finality depth.
 *
 * The depth gates irreversible conclusions: a canonical resolution retires a
 * generation, and a finalized nonce-consuming transaction is what lets an
 * orphaned signer boundary be resolved without asking the signer what it did.
 * If the reconciler may declare any positive depth, a single-block reorg can
 * un-consume a nonce that was already recorded as spent. Two epochs is the
 * point past which a reorg is a consensus failure rather than an ordinary
 * event, so it is the shallowest depth under which those conclusions hold.
 *
 * This is a floor, not a default: an operator may declare more.
 */
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MIN_FINALITY_CONFIRMATION_BLOCKS = 64
export const P2TR_SIGNATURE_FRAUD_OUTBOX_SERIES_ID_DOMAIN =
  "tbtc-p2tr-signature-fraud-outbox-series-v1"
export const P2TR_SIGNATURE_FRAUD_OUTBOX_RECORD_ID_DOMAIN =
  "tbtc-p2tr-signature-fraud-outbox-record-v1"
export const P2TR_SIGNATURE_FRAUD_OUTBOX_FEE_POLICY_DOMAIN =
  "tbtc-p2tr-signature-fraud-outbox-fee-policy-v1"
export const P2TR_SIGNATURE_FRAUD_CANONICAL_CANDIDATE_DOMAIN =
  "tbtc-p2tr-signature-fraud-canonical-candidate-v1"
export const P2TR_SIGNATURE_FRAUD_CANONICAL_PROVENANCE_DOMAIN =
  "tbtc-p2tr-signature-fraud-canonical-provenance-v1"
export const P2TR_SIGNATURE_FRAUD_CANONICAL_EVENT_SET_DOMAIN =
  "tbtc-p2tr-signature-fraud-canonical-event-set-v1"
export const P2TR_SIGNATURE_FRAUD_PROVENANCE_INVALIDATION_DOMAIN =
  "tbtc-p2tr-signature-fraud-provenance-invalidation-v1"
export const P2TR_SIGNATURE_FRAUD_NONCE_RELEASE_REQUEST_DOMAIN =
  "tbtc-p2tr-signature-fraud-nonce-release-request-v1"
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_VOIDED_RESERVATIONS = 32

export type P2TRSignatureFraudChallengeOutboxStatus =
  | "queued"
  | "preparing"
  | "prepared"
  | "broadcast-pending"
  | "external-satisfied-awaiting-own-transaction"
  | "accepted-own"
  | "satisfied-external"
  | "terminal-reverted"
  | "terminal-nonce-consumed"
  | "generation-required"
  | "cancelled-before-broadcast"
  | "cancelled-honest-spend"
  | "cancelled-reorg"
  | "cancelled-provenance-invalidated"
  | "provenance-invalidated-awaiting-reconciliation"
  | "quarantined"

export type P2TRSignatureFraudOutboxEvidenceCheckpoint = {
  confirmedSourceComplete: true
  bitcoinTxHash: string
  bitcoinWitnessTxHash: string
  bitcoinInputIndex: number
  bitcoinBlockHash: string
  bitcoinBlockHeight: number
  bitcoinCursorBlockHash: string
  bitcoinCursorBlockHeight: number
  ethereumLifecycleBlockHash: string
  ethereumLifecycleBlockNumber: number
  activationManifest: P2TRSignatureFraudActivationManifestBinding
  /** Router deployment/activation block; it must predate every Submitted event. */
  submittedEventScanFromBlock: number
}

export type P2TRSignatureFraudActivationManifestBinding = {
  manifestHash: string
  routerCodeHash: string
  routerProtocolID: string
  routerDomainChainID: number
  completeAuthorizationRegistryAddress: string
  completeAuthorizationRegistryCodeHash: string
  completeAuthorizationRegistryProtocolID: string
  completeReservationModel: string
}

export type P2TRSignatureFraudChallengeFeePolicyManifest = {
  policyHash: string
  activationManifestHash: string
  chainID: number
  challengeValueWei: string
  lanes: readonly Omit<
    P2TRSignatureFraudChallengeTransactionFeePolicy,
    "policyHash" | "activationManifestHash" | "chainID" | "challengeValueWei"
  >[]
}

export const computeP2TRSignatureFraudChallengeFeePolicyHash = (
  manifest: Omit<P2TRSignatureFraudChallengeFeePolicyManifest, "policyHash">
): string =>
  sha256Structured({
    domain: P2TR_SIGNATURE_FRAUD_OUTBOX_FEE_POLICY_DOMAIN,
    ...normalizeChallengeFeePolicyManifestWithoutHash(manifest),
  })

export type P2TRSignatureFraudCanonicalEthereumEligibilityEvidence = {
  readAtBlockNumber: number
  readAtBlockHash: string
  chainID: number
  routerDomainChainID: number
  routerAddress: string
  routerCodeHash: string
  routerProtocolID: string
  routerBridgeAddress: string
  routerChallengeKey: string
  routerChallengeAbsent: true
  /** Finalized Bridge fraudChallengeDepositAmount at readAtBlockNumber. */
  fraudChallengeDepositAmount: string
  completeAuthorizationRegistryAddress: string
  completeAuthorizationRegistryCodeHash: string
  completeAuthorizationRegistryProtocolID: string
  completeReservationModel: string
  completeChallengeIdentity: string
  completeWalletID: string
  /** No COMPLETE grant exists for this exact Bridge challenge identity. */
  completeExactChallengeAuthorizationAbsent: true
  /** No COMPLETE reservation authorizes this exact signed transaction variant. */
  completeExactTransactionAuthorizationAbsent: true
  /** Context only: an unrelated wallet reservation must not suppress fraud. */
  completeWalletReservationActive: boolean
  completeActiveReservationChallengeIdentity?: string
  walletChallengeable: true
  canonicalProofBacklogComplete: true
  activationManifestHash: string
  /** SHA-256 of every normalized field above, computed by the adapter. */
  readSetHash: string
}

export const computeP2TRSignatureFraudEthereumEligibilityReadSetHash = (
  evidence: Omit<
    P2TRSignatureFraudCanonicalEthereumEligibilityEvidence,
    "readSetHash"
  >
): string =>
  `0x${createHash("sha256")
    .update(JSON.stringify(normalizeEthereumEligibilityReadSet(evidence)))
    .digest("hex")}`

const sha256Structured = (value: unknown): string =>
  `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`

export const computeP2TRSignatureFraudOutboxSeriesID = (
  intent: P2TRSignatureFraudSubmissionIntent
): string =>
  sha256Structured({
    domain: P2TR_SIGNATURE_FRAUD_OUTBOX_SERIES_ID_DOMAIN,
    protocol: intent.protocol,
    evidenceProtocolID: normalizeBytes32(
      intent.evidenceProtocolID,
      "COMPLETE_V2 evidence protocol ID"
    ),
    chainID: intent.chainID,
    domainChainID: intent.domainChainID,
    routerAddress: normalizeAddress(intent.routerAddress, "Router address"),
    observationID: normalizeBytes32(intent.observationID, "Observation ID"),
    inputIndex: requireBoundedNonNegativeSafeInteger(
      intent.inputIndex,
      0xffffffff,
      "COMPLETE_V2 input index"
    ),
    bridgeChallengeKey: normalizeBytes32(
      intent.bridgeChallengeKey,
      "Bridge challenge key"
    ),
    signingKey: normalizeBytes32(intent.signingKey, "COMPLETE_V2 signing key"),
    bindingTxHash: normalizeBytes32(
      intent.bindingTxHash,
      "COMPLETE_V2 binding txid"
    ),
    bindingOutputIndex: requireBoundedNonNegativeSafeInteger(
      intent.bindingOutputIndex,
      0xffffffff,
      "COMPLETE_V2 binding output index"
    ),
  })

export const computeP2TRSignatureFraudDispositionHash = (
  disposition: P2TRSignatureFraudFinalizedGenerationDisposition
): string => sha256Structured(normalizeGenerationDisposition(disposition))

export const computeP2TRSignatureFraudResolutionEvidenceDigest = (
  resolution: Exclude<
    P2TRSignatureFraudChallengeOutboxResolution,
    { status: "pending" | "unknown" }
  >
): string => sha256Structured(normalizeFinalResolutionEvidence(resolution))

export const computeP2TRSignatureFraudCancellationEvidenceHash = (
  evidence: P2TRSignatureFraudCanonicalCancellationEvidenceWithoutHash
): string => sha256Structured(normalizeCancellationEvidence(evidence))

export const computeP2TRSignatureFraudOutboxRecordID = (
  intent: P2TRSignatureFraudSubmissionIntent,
  generation: number,
  evidenceCheckpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint,
  canonicalEthereumEligibility: P2TRSignatureFraudCanonicalEthereumEligibilityEvidence,
  canonicalProvenance: P2TRSignatureFraudCanonicalProvenanceBinding,
  feePolicyManifest: P2TRSignatureFraudChallengeFeePolicyManifest,
  generationTrigger: P2TRSignatureFraudGenerationTrigger
): string =>
  sha256Structured({
    domain: P2TR_SIGNATURE_FRAUD_OUTBOX_RECORD_ID_DOMAIN,
    seriesID: computeP2TRSignatureFraudOutboxSeriesID(intent),
    intentID: intentKey(intent),
    generation: requireBoundedNonNegativeSafeInteger(
      generation,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_GENERATIONS - 1,
      "Challenge outbox generation"
    ),
    bitcoinCandidate: {
      txid: normalizeBytes32(
        evidenceCheckpoint.bitcoinTxHash,
        "Bitcoin transaction hash"
      ),
      wtxid: normalizeBytes32(
        evidenceCheckpoint.bitcoinWitnessTxHash,
        "Bitcoin witness transaction hash"
      ),
      inputIndex: evidenceCheckpoint.bitcoinInputIndex,
      blockHash: normalizeBytes32(
        evidenceCheckpoint.bitcoinBlockHash,
        "Bitcoin block hash"
      ),
      blockHeight: evidenceCheckpoint.bitcoinBlockHeight,
    },
    ethereumReadSetHash: normalizeBytes32(
      canonicalEthereumEligibility.readSetHash,
      "Ethereum eligibility read-set hash"
    ),
    canonicalProvenance: {
      candidateDigest: normalizeBytes32(
        canonicalProvenance.candidateDigest,
        "Canonical provenance candidate digest"
      ),
      challengeKey: normalizeBytes32(
        canonicalProvenance.challengeKey,
        "Canonical provenance challenge key"
      ),
      readinessCertificateID: normalizeBytes32(
        canonicalProvenance.readinessCertificateID,
        "Canonical provenance readiness certificate ID"
      ),
      readinessCertificateGeneration: requirePositiveSafeInteger(
        canonicalProvenance.readinessCertificateGeneration,
        "Canonical provenance readiness certificate generation"
      ),
      candidateProvenanceGeneration: requirePositiveSafeInteger(
        canonicalProvenance.candidateProvenanceGeneration,
        "Canonical candidate provenance generation"
      ),
      inputBindingKind: canonicalProvenance.inputBindingKind,
      inputBindingSourceEventID: normalizeBytes32(
        canonicalProvenance.inputBindingSourceEventID,
        "Canonical provenance input-binding source event ID"
      ),
      inputIndex: requireUint32(
        canonicalProvenance.inputIndex,
        "Canonical provenance input index"
      ),
      fundingBlockHash: normalizeBytes32(
        canonicalProvenance.fundingBlockHash,
        "Canonical provenance funding block hash"
      ),
      fundingTxid: normalizeBytes32(
        canonicalProvenance.fundingTxid,
        "Canonical provenance funding txid"
      ),
      fundingVout: requireUint32(
        canonicalProvenance.fundingVout,
        "Canonical provenance funding output index"
      ),
      inputWalletID: normalizeBytes32(
        canonicalProvenance.inputWalletID,
        "Canonical provenance input wallet ID"
      ),
      inputOutputKey: normalizeBytes32(
        canonicalProvenance.inputOutputKey,
        "Canonical provenance input output key"
      ),
      bindingEthereumBlockNumber: requireNonNegativeSafeInteger(
        canonicalProvenance.bindingEthereumBlockNumber,
        "Canonical provenance binding Ethereum block number"
      ),
      bindingEthereumBlockHash: normalizeBytes32(
        canonicalProvenance.bindingEthereumBlockHash,
        "Canonical provenance binding Ethereum block hash"
      ),
      provenanceFingerprint: normalizeBytes32(
        canonicalProvenance.provenanceFingerprint,
        "Canonical provenance fingerprint"
      ),
      manifestHash: normalizeBytes32(
        canonicalProvenance.manifestHash,
        "Canonical provenance manifest hash"
      ),
    },
    feePolicyHash: normalizeBytes32(
      feePolicyManifest.policyHash,
      "Challenge fee policy hash"
    ),
    generationTrigger,
  })

export type P2TRSignatureFraudChallengeOutboxPreparationLease = {
  owner: string
  expiresAtUnixMs: number
}

export type P2TRSignatureFraudPreparedTransactionVariant = {
  sequence: number
  preparedTransaction: P2TRSignatureFraudPreparedChallengeTransaction
  signedAtUnixMs: number
  broadcastAttempts: number
  lastBroadcastAtUnixMs?: number
  lastBroadcastProviderAccepted?: boolean
  lastError?: string
}

export type P2TRSignatureFraudCanonicalBlock = {
  blockNumber: number
  blockHash: string
}

export type P2TRSignatureFraudCanonicalReceipt = {
  transactionHash: string
  status: 0 | 1
  blockNumber: number
  blockHash: string
}

export type P2TRSignatureFraudCanonicalTransaction = {
  transactionHash: string
  sender: string
  routerAddress: string
  calldata: string
  value: string
  nonce: number
  chainID: number
  blockNumber: number
  blockHash: string
  /** Derived by decoding the raw canonical transaction, never asserted by a caller. */
  decodedSubmissionCall: P2TRSignatureFraudDecodedSubmissionCall
}

export type P2TRSignatureFraudDecodedSubmissionCall = {
  variant: "router-process" | "router-direct"
  selector: string
  action: "submit"
  walletID: string
  bridgeChallengeIdentity: string
  challengeKey: string
  sighash: string
}

export type P2TRSignatureFraudCanonicalRouterChallenge =
  | {
      exists: false
      challengeKey: string
      readAtBlock: number
    }
  | {
      exists: true
      challengeKey: string
      challenger: string
      depositAmount: string
      reportedAt: number
      resolved: boolean
      readAtBlock: number
    }

export type P2TRSignatureFraudCanonicalSubmittedEvent = {
  routerAddress: string
  transactionHash: string
  blockNumber: number
  blockHash: string
  blockTimestamp: number
  logIndex: number
  walletID: string
  walletPubKeyHash: string
  bridgeChallengeIdentity: string
  challengeKey: string
  sighash: string
}

type P2TRSignatureFraudFinalizedResolutionEvidence = {
  /** Head sampled by the independent reconciler. */
  observedHead: P2TRSignatureFraudCanonicalBlock
  /** Canonical Ethereum consensus-finalized boundary used for every state read. */
  finalizedThrough: P2TRSignatureFraudCanonicalBlock
  /** The boundary was obtained from Ethereum's consensus-finalized head. */
  consensusFinalized: true
  /** Two independently sourced attestations over the same canonical digest. */
  canonicalAttestations: readonly [
    P2TRSignatureFraudCanonicalEvidenceAttestation,
    P2TRSignatureFraudCanonicalEvidenceAttestation
  ]
}

export type P2TRSignatureFraudCanonicalEvidenceAttestation = {
  trustDomainID: string
  independenceDomainID: string
  evidenceDigest: string
  attestation: string
  attestedAtUnixMs: number
}

export type P2TRSignatureFraudOwnTransactionDisposition =
  | {
      status: "reverted"
      receipt: P2TRSignatureFraudCanonicalReceipt & { status: 0 }
    }
  | {
      status: "nonce-consumed"
      sender: string
      transactionNonce: number
      finalizedAccountNonce: number
      accountNonceReadAtBlock: number
      transactionAbsent: true
      consumingTransaction: P2TRSignatureFraudCanonicalNonceConsumingTransaction
    }

export type P2TRSignatureFraudCanonicalNonceConsumingTransaction = {
  transactionHash: string
  sender: string
  nonce: number
  blockNumber: number
  blockHash: string
}

export type P2TRSignatureFraudChallengeOutboxResolution =
  | {
      status: "pending"
      reason: string
    }
  | {
      status: "unknown"
      reason: string
    }
  | ({
      status:
        | "accepted-own"
        | "satisfied-external"
        | "external-satisfied-awaiting-own-transaction"
      receipt: P2TRSignatureFraudCanonicalReceipt & { status: 1 }
      transaction: P2TRSignatureFraudCanonicalTransaction
      routerChallenge: Extract<
        P2TRSignatureFraudCanonicalRouterChallenge,
        { exists: true }
      >
      submittedEvent: P2TRSignatureFraudCanonicalSubmittedEvent
      /** Required to terminalize external satisfaction after any own send. */
      ownTransactionDisposition?: P2TRSignatureFraudOwnTransactionDisposition
    } & P2TRSignatureFraudFinalizedResolutionEvidence)
  | ({
      status: "terminal-reverted"
      receipt: P2TRSignatureFraudCanonicalReceipt & { status: 0 }
      routerChallenge: Extract<
        P2TRSignatureFraudCanonicalRouterChallenge,
        { exists: false }
      >
    } & P2TRSignatureFraudFinalizedResolutionEvidence)
  | ({
      status: "terminal-nonce-consumed"
      sender: string
      transactionNonce: number
      finalizedAccountNonce: number
      accountNonceReadAtBlock: number
      transactionAbsent: true
      consumingTransaction: P2TRSignatureFraudCanonicalNonceConsumingTransaction
      routerChallenge: Extract<
        P2TRSignatureFraudCanonicalRouterChallenge,
        { exists: false }
      >
    } & P2TRSignatureFraudFinalizedResolutionEvidence)

export type P2TRSignatureFraudFinalizedGenerationDisposition = Extract<
  P2TRSignatureFraudChallengeOutboxResolution,
  { status: "terminal-reverted" | "terminal-nonce-consumed" }
>

type P2TRSignatureFraudAcceptedResolutionFamily = Extract<
  P2TRSignatureFraudChallengeOutboxResolution,
  { transaction: P2TRSignatureFraudCanonicalTransaction }
>

export type P2TRSignatureFraudFinalNonceResolution =
  | P2TRSignatureFraudFinalizedGenerationDisposition
  | (Omit<P2TRSignatureFraudAcceptedResolutionFamily, "status"> & {
      status: "accepted-own" | "satisfied-external"
    })

export type P2TRSignatureFraudCanonicalEvidenceCursor = {
  bitcoinBlockHash: string
  bitcoinBlockHeight: number
  ethereumBlockHash: string
  ethereumBlockNumber: number
}

export type P2TRSignatureFraudCancellationAgreement = {
  primaryTrustDomainID: string
  corroboratingTrustDomainID: string
  primaryIndependenceDomainID: string
  corroboratingIndependenceDomainID: string
  primaryAttestation: string
  corroboratingAttestation: string
  checkedAtUnixMs: number
}

type P2TRSignatureFraudCancellationEvidenceBase = {
  evidenceHash: string
  originalCandidate: P2TRSignatureFraudCanonicalObservationPointer
  canonicalCursor: P2TRSignatureFraudCanonicalEvidenceCursor
  agreement: P2TRSignatureFraudCancellationAgreement
}

export type P2TRSignatureFraudCanonicalCancellationEvidence =
  | (P2TRSignatureFraudCancellationEvidenceBase & {
      kind: "canonical-reorg"
      candidateCurrent: false
      replacementCanonicalTip: {
        blockHash: string
        blockHeight: number
      }
    })
  | (P2TRSignatureFraudCancellationEvidenceBase & {
      kind: "honest-spend"
      conflictingOutpoint: {
        txid: string
        vout: number
      }
      canonicalSpend: {
        txid: string
        wtxid: string
        inputIndex: number
        blockHash: string
        blockHeight: number
      }
      bridgeProofReceipt: {
        transactionHash: string
        blockHash: string
        blockNumber: number
        logIndex: number
        proofType: string
      }
    })

export type P2TRSignatureFraudCanonicalCancellationEvidenceWithoutHash =
  | Omit<
      Extract<
        P2TRSignatureFraudCanonicalCancellationEvidence,
        { kind: "canonical-reorg" }
      >,
      "evidenceHash"
    >
  | Omit<
      Extract<
        P2TRSignatureFraudCanonicalCancellationEvidence,
        { kind: "honest-spend" }
      >,
      "evidenceHash"
    >

export type P2TRSignatureFraudGenerationTrigger =
  | { kind: "initial" }
  | {
      kind: "nonce-disposition"
      previousRecordID: string
      dispositionHash: string
    }
  | {
      kind: "canonical-reappearance"
      previousRecordID: string
      cancellationEvidenceHash: string
    }
  | {
      kind: "provenance-restored"
      previousRecordID: string
      invalidationEvidenceHash: string
      previousProvenanceFingerprint: string
    }

export type P2TRSignatureFraudUnexpectedSignedArtifact = {
  preparedTransaction: P2TRSignatureFraudPreparedChallengeTransaction
  expectedReservationID: string
  capturedAtUnixMs: number
  reason: string
}

export type P2TRSignatureFraudVoidedNonceReservation = {
  reservation: P2TRSignatureFraudBoundNonceReservation
  voidedAtUnixMs: number
  reasonCode:
    | "reservation-abandoned"
    | "reservation-expired"
    | "reservation-provider-rejected"
    | "reservation-binding-invalid"
  reason: string
  evidenceDigest: string
}

export type P2TRSignatureFraudNonceReleaseRequest = {
  /** Stable provider idempotency key, committed before allocator I/O. */
  releaseRequestID: string
  recordID: string
  generation: number
  reservation: P2TRSignatureFraudBoundNonceReservation
  voidEvidenceDigest: string
  requestedAtUnixMs: number
  attemptCount: number
  ambiguous: boolean
}

export type P2TRSignatureFraudNonceReleaseAttempt = {
  releaseRequestID: string
  attemptSequence: number
  owner: string
  startedAtUnixMs: number
  expiresAtUnixMs: number
}

export type P2TRSignatureFraudNonceReleaseAttemptResult =
  | {
      kind: "released" | "already-released"
      acknowledgement: P2TRSignatureFraudNonceReleaseAcknowledgement
      recordedAtUnixMs: number
    }
  | {
      kind: "ambiguous-error" | "contract-mismatch"
      responseDigest: string
      /** Bounded, independently parseable identities returned by the allocator. */
      returnedReleaseRequestID?: string
      returnedReservationID?: string
      detail: string
      recordedAtUnixMs: number
    }

export type P2TRSignatureFraudIndependentNonceReleaseResolution = {
  releaseRequestID: string
  attemptSequence: number
  attemptOwner: string
  attemptStartedAtUnixMs: number
  attemptExpiresAtUnixMs: number
  invokedAtUnixMs: number
  outcome: "released" | "already-released" | "terminal-unsafe"
  providerEvidenceDigest: string
  evidenceDigest: string
  canonicalAttestations: readonly [
    P2TRSignatureFraudCanonicalEvidenceAttestation,
    P2TRSignatureFraudCanonicalEvidenceAttestation
  ]
  resolvedAtUnixMs: number
}

export type P2TRSignatureFraudAmbiguousNonceReleaseInvocation = {
  request: P2TRSignatureFraudNonceReleaseRequest
  attempt: P2TRSignatureFraudNonceReleaseAttempt
  invokedAtUnixMs: number
  ambiguousResponseDigest?: string
}

export const computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest = (
  resolution: Omit<
    P2TRSignatureFraudIndependentNonceReleaseResolution,
    "evidenceDigest" | "canonicalAttestations" | "resolvedAtUnixMs"
  >
): string => {
  const uint64 = (value: number, label: string): Buffer => {
    requireNonNegativeSafeInteger(value, label)
    const encoded = Buffer.alloc(8)
    encoded.writeBigUInt64BE(BigInt(value))
    return encoded
  }
  const textDigest = (value: string, label: string): Buffer => {
    const normalized = requireBoundedText(value, 128, label)
    return createHash("sha256").update(normalized, "utf8").digest()
  }
  if (
    !["released", "already-released", "terminal-unsafe"].includes(
      resolution.outcome
    )
  ) {
    throw new Error("Nonce-release resolution outcome is invalid")
  }
  return `0x${createHash("sha256")
    .update("tbtc-p2tr-nonce-release-independent-resolution-v1", "utf8")
    .update(
      Buffer.from(
        normalizeBytes32(
          resolution.releaseRequestID,
          "Nonce-release resolution request ID"
        ).slice(2),
        "hex"
      )
    )
    .update(
      uint64(
        resolution.attemptSequence,
        "Nonce-release resolution attempt sequence"
      )
    )
    .update(textDigest(resolution.attemptOwner, "Nonce-release attempt owner"))
    .update(
      uint64(resolution.attemptStartedAtUnixMs, "Nonce-release attempt start")
    )
    .update(
      uint64(
        resolution.attemptExpiresAtUnixMs,
        "Nonce-release attempt expiration"
      )
    )
    .update(uint64(resolution.invokedAtUnixMs, "Nonce-release invocation time"))
    .update(textDigest(resolution.outcome, "Nonce-release resolution outcome"))
    .update(
      Buffer.from(
        normalizeBytes32(
          resolution.providerEvidenceDigest,
          "Nonce-release provider evidence digest"
        ).slice(2),
        "hex"
      )
    )
    .digest("hex")}`
}

/**
 * Independently attested terminal evidence for one exact signer boundary whose
 * owning process died between the durable pre-I/O marker and any observable
 * signer result.
 *
 * `activeSignerInvocationStartedAtUnixMs` is made durable BEFORE boundary
 * authorization and therefore before the signer RPC, so a lost owner leaves a
 * marker that nothing in the process-local recovery path may clear: lease
 * expiry is not proof that a remote call stopped. The marker keeps the
 * lane's `active_signer_invocation_count` at one, which blocks every
 * nonce-release invocation on that lane and freezes challenge signing for that
 * account. Only an out-of-band, dual-attested observation of what the signer
 * actually did can resolve that, and this is that evidence.
 */
/**
 * A provider's proof that it permanently closed one invocation.
 *
 * Two independent attesters can observe a great deal, but not the absence of a
 * request buffered somewhere between the outbox and the key: delivery delay is
 * unbounded, so a request can still arrive after everyone has looked and found
 * nothing. Only a WRITE at the provider settles that — a one-shot transition
 * that both reports "no bytes escaped" and refuses any later arrival of this
 * invocation. This is the receipt for that write.
 *
 * It is expressible only because the boundary now has a deterministic identity
 * the provider and the outbox can name independently.
 */
/**
 * Evidence that the chain, not the provider, settled this boundary.
 *
 * Once the reserved nonce is consumed at finality, any signed bytes for that
 * nonce are permanently inert — they can never confirm. That makes the boundary
 * decidable from public data, which `never-invoked` is not.
 *
 * It is a claim about the BYTES, not about the invocation. The signer may have
 * signed; it may still be holding an envelope. This outcome says only that
 * whatever it holds can no longer land, so the record must keep its reservation
 * and stay able to capture a late artifact.
 *
 * `chainID` is bound because nothing else in the nonce-consumption evidence
 * names a chain: without it, an attestation over "sender S nonce N is consumed"
 * would replay against any record on any chain sharing that pair.
 */
export type P2TRSignatureFraudNonceConsumptionEvidence = {
  chainID: number
  sender: string
  transactionNonce: number
  finalizedAccountNonce: number
  accountNonceReadAtBlock: number
  consumingTransaction: P2TRSignatureFraudCanonicalNonceConsumingTransaction
  /** The finality boundary every read above was taken at. */
  finalizedThrough: P2TRSignatureFraudCanonicalBlock
  observedHead: P2TRSignatureFraudCanonicalBlock
}

/**
 * A provider's proof that one signer invocation was permanently closed without
 * the signer ever being reached. It is the sole basis for a `never-invoked`
 * outcome, so it is worth stating exactly how far this side can vouch for it.
 *
 * What is enforced here: the tombstone must name the same invocation the
 * resolution speaks for; the receipt bytes are bound into the resolution
 * evidence digest, so the two independent attestations are attesting to THESE
 * bytes and not merely to the verdict; the resolution must name the boundary
 * marker that is still live and clears it in the same transaction, so an
 * invocation is answered exactly once and a later contradiction has nowhere to
 * go; and `never-invoked` is refused outright if any signed artifact for the
 * record has escaped.
 *
 * What cannot be enforced here: whether the receipt is TRUE. The bytes are
 * opaque to this process, so nothing stops a provider that did reach its signer
 * from issuing a tombstone claiming otherwise. Closing that is an obligation on
 * the provider, not on this store: it must keep a durable write-once register
 * keyed by invocation ID, written before the signer is reached, so that its
 * answer for a given invocation is fixed at the moment of the attempt and it
 * cannot later be induced to say something else. A provider that answers from
 * memory, or recomputes an answer on request, does not satisfy this and its
 * tombstones should not be trusted for `never-invoked`.
 */
export type P2TRSignatureFraudSignerInvocationTombstone = {
  /** Must name the same invocation the resolution speaks for. */
  signerInvocationID: string
  /** Provider-facing spelling of the same invocation identity. */
  invocationID: string
  /**
   * Provider-authenticated bytes; opaque here, exactly like an attestation.
   * Bound into the resolution evidence digest, so both attestors commit to the
   * exact bytes rather than to the verdict alone.
   */
  receipt: string
  /** Provider-stable digest of the exact authenticated receipt bytes. */
  receiptDigest: string
  tombstonedAtUnixMs: number
}

export type P2TRSignatureFraudIndependentSignerBoundaryResolution = {
  recordID: string
  /**
   * The exact boundary. This is the identity: a deterministic digest over the
   * whole boundary binding, frozen by the swap that set the marker. The three
   * fields below remain as operator-facing detail and are bound into the
   * evidence digest, but they no longer decide which boundary is named.
   */
  signerInvocationID: string
  boundaryStartedAtUnixMs: number
  preparationAttempts: number
  nonceReservationID: string
  stage: "prepare" | "replacement"
  invokedAtUnixMs: number
  outcome: "never-invoked" | "signed" | "terminal-unsafe" | "nonce-consumed"
  /** Required exactly when the signer is proven to have produced bytes. */
  signedTransactionHash?: string
  /**
   * Required exactly for `never-invoked`, and refused otherwise. Without it
   * that outcome is an assertion nobody is positioned to make.
   */
  providerTombstone?: P2TRSignatureFraudSignerInvocationTombstone
  /** Required exactly for `nonce-consumed`, and refused otherwise. */
  nonceConsumption?: P2TRSignatureFraudNonceConsumptionEvidence
  providerEvidenceDigest: string
  evidenceDigest: string
  canonicalAttestations: readonly [
    P2TRSignatureFraudCanonicalEvidenceAttestation,
    P2TRSignatureFraudCanonicalEvidenceAttestation
  ]
  resolvedAtUnixMs: number
}

/**
 * Derives the legacy boundary-tuple identity retained as an independent
 * tombstone binding alongside PR 1048's full request-binding invocation ID.
 */
export const computeP2TRSignatureFraudLegacySignerInvocationID = (binding: {
  recordID: string
  boundaryStartedAtUnixMs: number
  preparationAttempts: number
  nonceReservationID: string
  stage: "prepare" | "replacement"
}): string => {
  const uint64 = (value: number, label: string): Buffer => {
    requireNonNegativeSafeInteger(value, label)
    const encoded = Buffer.alloc(8)
    encoded.writeBigUInt64BE(BigInt(value))
    return encoded
  }
  return `0x${createHash("sha256")
    .update("tbtc-p2tr-signer-invocation-v1", "utf8")
    .update(
      Buffer.from(
        normalizeBytes32(binding.recordID, "Signer invocation record ID").slice(
          2
        ),
        "hex"
      )
    )
    .update(
      uint64(
        binding.boundaryStartedAtUnixMs,
        "Signer invocation boundary start"
      )
    )
    .update(
      uint64(
        binding.preparationAttempts,
        "Signer invocation preparation attempts"
      )
    )
    .update(
      Buffer.from(
        normalizeBytes32(
          binding.nonceReservationID,
          "Signer invocation reservation ID"
        ).slice(2),
        "hex"
      )
    )
    .update(createHash("sha256").update(binding.stage, "utf8").digest())
    .digest("hex")}`
}

type P2TRSignatureFraudSignerBoundaryResolutionEvidenceVersion = 4 | 5

const computeVersionedSignerBoundaryResolutionEvidenceDigest = (
  resolution: Omit<
    P2TRSignatureFraudIndependentSignerBoundaryResolution,
    "evidenceDigest" | "canonicalAttestations" | "resolvedAtUnixMs"
  >,
  evidenceVersion: P2TRSignatureFraudSignerBoundaryResolutionEvidenceVersion
): string => {
  const uint64 = (value: number, label: string): Buffer => {
    requireNonNegativeSafeInteger(value, label)
    const encoded = Buffer.alloc(8)
    encoded.writeBigUInt64BE(BigInt(value))
    return encoded
  }
  const textDigest = (value: string, label: string): Buffer => {
    const normalized = requireBoundedText(value, 128, label)
    return createHash("sha256").update(normalized, "utf8").digest()
  }
  if (
    !["never-invoked", "signed", "terminal-unsafe", "nonce-consumed"].includes(
      resolution.outcome
    )
  ) {
    throw new Error("Signer-boundary resolution outcome is invalid")
  }
  if (!["prepare", "replacement"].includes(resolution.stage)) {
    throw new Error("Signer-boundary resolution stage is invalid")
  }
  if (
    (resolution.outcome === "signed") !==
    (resolution.signedTransactionHash !== undefined)
  ) {
    throw new Error(
      "Signer-boundary resolution names signed bytes only for a signed outcome"
    )
  }
  // Mirrored byte for byte by the PostgreSQL guard trigger. The invocation ID
  // replaces the boundary start as the identity term; v1 hashed a wall-clock
  // tuple, so the domain moves with the layout.
  const tombstone = resolution.providerTombstone
  if ((resolution.outcome === "never-invoked") !== (tombstone !== undefined)) {
    throw new Error(
      "Signer-boundary resolution names a provider tombstone only for a never-invoked outcome"
    )
  }
  const consumption = resolution.nonceConsumption
  if (
    (resolution.outcome === "nonce-consumed") !==
    (consumption !== undefined)
  ) {
    throw new Error(
      "Signer-boundary resolution names nonce consumption only for a nonce-consumed outcome"
    )
  }
  const signerInvocationID = normalizeBytes32(
    resolution.signerInvocationID,
    "Signer-boundary resolution invocation ID"
  )
  const digest = createHash("sha256")
    .update(
      `tbtc-p2tr-signer-boundary-independent-resolution-v${evidenceVersion}`,
      "utf8"
    )
    .update(
      Buffer.from(
        normalizeBytes32(
          resolution.recordID,
          "Signer-boundary resolution record ID"
        ).slice(2),
        "hex"
      )
    )
    .update(Buffer.from(signerInvocationID.slice(2), "hex"))
    .update(
      uint64(
        resolution.boundaryStartedAtUnixMs,
        "Signer-boundary resolution boundary start"
      )
    )
    .update(
      uint64(
        resolution.preparationAttempts,
        "Signer-boundary resolution preparation attempts"
      )
    )
    .update(
      Buffer.from(
        normalizeBytes32(
          resolution.nonceReservationID,
          "Signer-boundary resolution reservation ID"
        ).slice(2),
        "hex"
      )
    )
    .update(textDigest(resolution.stage, "Signer-boundary resolution stage"))
    .update(Buffer.from(signerInvocationID.slice(2), "hex"))
    .update(
      uint64(
        resolution.invokedAtUnixMs,
        "Signer-boundary resolution invocation time"
      )
    )
    .update(
      textDigest(resolution.outcome, "Signer-boundary resolution outcome")
    )
    .update(
      resolution.signedTransactionHash === undefined
        ? Buffer.alloc(32)
        : Buffer.from(
            normalizeBytes32(
              resolution.signedTransactionHash,
              "Signer-boundary resolution signed transaction hash"
            ).slice(2),
            "hex"
          )
    )
    .update(
      Buffer.from(
        normalizeBytes32(
          resolution.providerEvidenceDigest,
          "Signer-boundary resolution provider evidence digest"
        ).slice(2),
        "hex"
      )
    )
    .update(
      tombstone === undefined
        ? Buffer.alloc(32)
        : Buffer.from(
            normalizeBytes32(
              tombstone.signerInvocationID,
              "Signer-boundary tombstone invocation ID"
            ).slice(2),
            "hex"
          )
    )
    .update(
      tombstone === undefined
        ? Buffer.alloc(32)
        : createHash("sha256")
            .update(
              Buffer.from(
                normalizeHexData(
                  tombstone.receipt,
                  "Signer-boundary tombstone receipt"
                ).slice(2),
                "hex"
              )
            )
            .digest()
    )
    .update(
      uint64(
        tombstone === undefined ? 0 : tombstone.tombstonedAtUnixMs,
        "Signer-boundary tombstone time"
      )
    )
    .update(
      uint64(
        consumption === undefined ? 0 : consumption.chainID,
        "Signer-boundary nonce consumption chain ID"
      )
    )
    .update(
      uint64(
        consumption === undefined ? 0 : consumption.transactionNonce,
        "Signer-boundary nonce consumption nonce"
      )
    )
    .update(
      uint64(
        consumption === undefined ? 0 : consumption.finalizedAccountNonce,
        "Signer-boundary nonce consumption account nonce"
      )
    )
    .update(
      uint64(
        consumption === undefined ? 0 : consumption.accountNonceReadAtBlock,
        "Signer-boundary nonce consumption read block"
      )
    )
    .update(
      consumption === undefined
        ? Buffer.alloc(32)
        : Buffer.from(
            normalizeBytes32(
              consumption.consumingTransaction.transactionHash,
              "Signer-boundary consuming transaction hash"
            ).slice(2),
            "hex"
          )
    )
    .update(
      uint64(
        consumption === undefined
          ? 0
          : consumption.finalizedThrough.blockNumber,
        "Signer-boundary nonce consumption finality height"
      )
    )
    .update(
      consumption === undefined
        ? Buffer.alloc(32)
        : Buffer.from(
            normalizeBytes32(
              consumption.finalizedThrough.blockHash,
              "Signer-boundary nonce consumption finality hash"
            ).slice(2),
            "hex"
          )
    )
  if (evidenceVersion === 5) {
    digest
      .update(
        uint64(
          consumption === undefined ? 0 : consumption.observedHead.blockNumber,
          "Signer-boundary nonce consumption observed head height"
        )
      )
      .update(
        consumption === undefined
          ? Buffer.alloc(32)
          : Buffer.from(
              normalizeBytes32(
                consumption.observedHead.blockHash,
                "Signer-boundary nonce consumption observed head hash"
              ).slice(2),
              "hex"
            )
      )
  }
  return `0x${digest.digest("hex")}`
}

export const computeP2TRSignatureFraudSignerBoundaryResolutionEvidenceDigest = (
  resolution: Omit<
    P2TRSignatureFraudIndependentSignerBoundaryResolution,
    "evidenceDigest" | "canonicalAttestations" | "resolvedAtUnixMs"
  >
): string =>
  computeVersionedSignerBoundaryResolutionEvidenceDigest(resolution, 5)

/**
 * Computes the digest accepted before migration 016. This must only be used to
 * recognize an exact replay of immutable evidence that the migration marked as
 * version 4; new resolutions must always use the v5 helper above.
 */
export const computeP2TRSignatureFraudLegacyV4SignerBoundaryResolutionEvidenceDigest =
  (
    resolution: Omit<
      P2TRSignatureFraudIndependentSignerBoundaryResolution,
      "evidenceDigest" | "canonicalAttestations" | "resolvedAtUnixMs"
    >
  ): string =>
    computeVersionedSignerBoundaryResolutionEvidenceDigest(resolution, 4)

/**
 * The exact normalized form both the PostgreSQL adapter and the in-memory
 * double bind. Sharing one validator is what makes their rejection messages
 * identical rather than merely similar.
 */
export type P2TRSignatureFraudNormalizedSignerBoundaryResolution = {
  recordID: string
  signerInvocationID: string
  providerTombstone?: P2TRSignatureFraudSignerInvocationTombstone
  nonceConsumption?: P2TRSignatureFraudNonceConsumptionEvidence
  boundaryStartedAtUnixMs: number
  preparationAttempts: number
  nonceReservationID: string
  stage: "prepare" | "replacement"
  invokedAtUnixMs: number
  outcome: "never-invoked" | "signed" | "terminal-unsafe" | "nonce-consumed"
  signedTransactionHash?: string
  providerEvidenceDigest: string
  evidenceDigest: string
  attestations: readonly [
    P2TRSignatureFraudCanonicalEvidenceAttestation,
    P2TRSignatureFraudCanonicalEvidenceAttestation
  ]
  resolvedAtUnixMs: number
}

const validateVersionedIndependentSignerBoundaryResolution = (
  resolution: P2TRSignatureFraudIndependentSignerBoundaryResolution,
  evidenceVersion: P2TRSignatureFraudSignerBoundaryResolutionEvidenceVersion
): P2TRSignatureFraudNormalizedSignerBoundaryResolution => {
  const recordID = normalizeBytes32(
    resolution.recordID,
    "Orphaned signer boundary record ID"
  )
  const signerInvocationID = normalizeBytes32(
    resolution.signerInvocationID,
    "Orphaned signer boundary invocation ID"
  )
  if (
    (resolution.outcome === "never-invoked") !==
    (resolution.providerTombstone !== undefined)
  ) {
    throw new Error(
      "Orphaned signer boundary resolution requires a provider tombstone exactly for a never-invoked outcome"
    )
  }
  if (
    (resolution.outcome === "nonce-consumed") !==
    (resolution.nonceConsumption !== undefined)
  ) {
    throw new Error(
      "Orphaned signer boundary resolution requires nonce consumption evidence exactly for a nonce-consumed outcome"
    )
  }
  const nonceConsumption =
    resolution.nonceConsumption === undefined
      ? undefined
      : normalizeSignerBoundaryNonceConsumption(
          resolution.nonceConsumption,
          evidenceVersion === 5
        )
  const providerTombstone =
    resolution.providerTombstone === undefined
      ? undefined
      : (() => {
          const receipt = normalizeHexData(
            resolution.providerTombstone.receipt,
            "Orphaned signer boundary tombstone receipt"
          )
          const receiptBytes = (receipt.length - 2) / 2
          if (receiptBytes < 1 || receiptBytes > 2_048) {
            throw new Error(
              "Orphaned signer boundary tombstone receipt must contain between 1 and 2048 bytes"
            )
          }
          return {
            signerInvocationID: normalizeBytes32(
              resolution.providerTombstone.signerInvocationID,
              "Orphaned signer boundary tombstone invocation ID"
            ),
            invocationID: normalizeBytes32(
              resolution.providerTombstone.invocationID,
              "Orphaned signer boundary provider invocation ID"
            ),
            receipt,
            receiptDigest: normalizeBytes32(
              resolution.providerTombstone.receiptDigest,
              "Orphaned signer boundary tombstone receipt digest"
            ),
            tombstonedAtUnixMs: requireUnixMilliseconds(
              resolution.providerTombstone.tombstonedAtUnixMs,
              "Orphaned signer boundary tombstone time"
            ),
          }
        })()
  if (
    providerTombstone !== undefined &&
    (providerTombstone.signerInvocationID !== signerInvocationID ||
      providerTombstone.receiptDigest !==
        `0x${createHash("sha256")
          .update(Buffer.from(providerTombstone.receipt.slice(2), "hex"))
          .digest("hex")}`)
  ) {
    throw new Error(
      "Orphaned signer boundary tombstone does not authenticate the exact invocation and receipt"
    )
  }
  const boundaryStartedAtUnixMs = requireUnixMilliseconds(
    resolution.boundaryStartedAtUnixMs,
    "Orphaned signer boundary start"
  )
  const preparationAttempts = requireNonNegativeSafeInteger(
    resolution.preparationAttempts,
    "Orphaned signer boundary preparation attempts"
  )
  const nonceReservationID = normalizeBytes32(
    resolution.nonceReservationID,
    "Orphaned signer boundary reservation ID"
  )
  const invokedAtUnixMs = requireUnixMilliseconds(
    resolution.invokedAtUnixMs,
    "Orphaned signer boundary invocation time"
  )
  const resolvedAtUnixMs = requireUnixMilliseconds(
    resolution.resolvedAtUnixMs,
    "Independent signer-boundary resolution time"
  )
  if (
    invokedAtUnixMs < boundaryStartedAtUnixMs ||
    resolvedAtUnixMs < invokedAtUnixMs ||
    !["never-invoked", "signed", "terminal-unsafe", "nonce-consumed"].includes(
      resolution.outcome
    ) ||
    !["prepare", "replacement"].includes(resolution.stage)
  ) {
    throw new Error("Independent signer-boundary resolution is malformed")
  }
  if (
    (resolution.outcome === "signed") !==
    (resolution.signedTransactionHash !== undefined)
  ) {
    throw new Error(
      "Independent signer-boundary resolution names signed bytes only for a signed outcome"
    )
  }
  const signedTransactionHash =
    resolution.signedTransactionHash === undefined
      ? undefined
      : normalizeBytes32(
          resolution.signedTransactionHash,
          "Orphaned signer boundary signed transaction hash"
        )
  const expectedInvocationID =
    computeP2TRSignatureFraudLegacySignerInvocationID({
      recordID,
      boundaryStartedAtUnixMs,
      preparationAttempts,
      nonceReservationID,
      stage: resolution.stage,
    })
  if (resolution.outcome === "never-invoked") {
    if (providerTombstone === undefined) {
      throw new Error(
        "Independent signer-boundary never-invoked resolution lacks a provider tombstone"
      )
    }
    if (
      providerTombstone.invocationID !== expectedInvocationID ||
      providerTombstone.signerInvocationID !== signerInvocationID ||
      providerTombstone.tombstonedAtUnixMs < invokedAtUnixMs ||
      providerTombstone.tombstonedAtUnixMs > resolvedAtUnixMs
    ) {
      throw new Error(
        "Independent signer-boundary provider tombstone does not bind the exact invocation window"
      )
    }
  } else if (providerTombstone !== undefined) {
    throw new Error(
      "Independent signer-boundary provider tombstone is only valid for never-invoked"
    )
  }
  const providerEvidenceDigest = normalizeBytes32(
    resolution.providerEvidenceDigest,
    "Orphaned signer boundary provider evidence digest"
  )
  const evidenceDigest = normalizeBytes32(
    resolution.evidenceDigest,
    "Independent signer-boundary resolution digest"
  )
  if (
    computeVersionedSignerBoundaryResolutionEvidenceDigest(
      {
        recordID,
        signerInvocationID,
        boundaryStartedAtUnixMs,
        preparationAttempts,
        nonceReservationID,
        stage: resolution.stage,
        invokedAtUnixMs,
        outcome: resolution.outcome,
        signedTransactionHash,
        providerTombstone,
        nonceConsumption,
        providerEvidenceDigest,
      },
      evidenceVersion
    ) !== evidenceDigest
  ) {
    throw new Error("Independent signer-boundary resolution digest is invalid")
  }
  if (
    !Array.isArray(resolution.canonicalAttestations) ||
    resolution.canonicalAttestations.length !== 2
  ) {
    throw new Error(
      "Independent signer-boundary resolution requires exactly two attestations"
    )
  }
  const [primary, corroborating] = resolution.canonicalAttestations
  const normalizeAttestation = (
    attestation: P2TRSignatureFraudCanonicalEvidenceAttestation,
    label: string
  ): P2TRSignatureFraudCanonicalEvidenceAttestation => ({
    trustDomainID: requireBoundedText(
      attestation?.trustDomainID,
      128,
      `${label} signer-boundary trust domain`
    ),
    independenceDomainID: requireBoundedText(
      attestation?.independenceDomainID,
      128,
      `${label} signer-boundary independence domain`
    ),
    evidenceDigest: normalizeBytes32(
      attestation?.evidenceDigest,
      `${label} signer-boundary evidence digest`
    ),
    attestation: normalizeHexData(
      attestation?.attestation,
      `${label} signer-boundary attestation`
    ),
    attestedAtUnixMs: requireUnixMilliseconds(
      attestation?.attestedAtUnixMs,
      `${label} signer-boundary attestation time`
    ),
  })
  const normalizedPrimary = normalizeAttestation(primary, "Primary")
  const normalizedCorroborating = normalizeAttestation(
    corroborating,
    "Corroborating"
  )
  if (
    normalizedPrimary.trustDomainID === normalizedCorroborating.trustDomainID ||
    normalizedPrimary.independenceDomainID ===
      normalizedCorroborating.independenceDomainID ||
    normalizedPrimary.attestation === normalizedCorroborating.attestation ||
    normalizedPrimary.attestation === "0x" ||
    normalizedCorroborating.attestation === "0x" ||
    normalizedPrimary.attestation.length > 4098 ||
    normalizedCorroborating.attestation.length > 4098 ||
    normalizedPrimary.evidenceDigest !== evidenceDigest ||
    normalizedCorroborating.evidenceDigest !== evidenceDigest
  ) {
    throw new Error(
      "Independent signer-boundary attestations do not bind the same evidence across distinct domains"
    )
  }
  if (
    normalizedPrimary.attestedAtUnixMs < invokedAtUnixMs ||
    normalizedCorroborating.attestedAtUnixMs < invokedAtUnixMs ||
    (providerTombstone !== undefined &&
      (normalizedPrimary.attestedAtUnixMs <
        providerTombstone.tombstonedAtUnixMs ||
        normalizedCorroborating.attestedAtUnixMs <
          providerTombstone.tombstonedAtUnixMs)) ||
    normalizedPrimary.attestedAtUnixMs > resolvedAtUnixMs ||
    normalizedCorroborating.attestedAtUnixMs > resolvedAtUnixMs
  ) {
    throw new Error(
      "Independent signer-boundary attestations fall outside the invocation window"
    )
  }
  return {
    recordID,
    signerInvocationID,
    ...(providerTombstone === undefined ? {} : { providerTombstone }),
    ...(nonceConsumption === undefined ? {} : { nonceConsumption }),
    boundaryStartedAtUnixMs,
    preparationAttempts,
    nonceReservationID,
    stage: resolution.stage,
    invokedAtUnixMs,
    outcome: resolution.outcome,
    signedTransactionHash,
    providerTombstone,
    providerEvidenceDigest,
    evidenceDigest,
    attestations: [normalizedPrimary, normalizedCorroborating],
    resolvedAtUnixMs,
  }
}

export const validateP2TRSignatureFraudIndependentSignerBoundaryResolution = (
  resolution: P2TRSignatureFraudIndependentSignerBoundaryResolution
): P2TRSignatureFraudNormalizedSignerBoundaryResolution =>
  validateVersionedIndependentSignerBoundaryResolution(resolution, 5)

/**
 * Validates the exact evidence contract used before migration 016. The
 * PostgreSQL adapter invokes this only after finding an immutable row that the
 * migration explicitly classified as version 4; it is never an insertion path.
 */
export const validateP2TRSignatureFraudLegacyV4SignerBoundaryResolutionReplay =
  (
    resolution: P2TRSignatureFraudIndependentSignerBoundaryResolution
  ): P2TRSignatureFraudNormalizedSignerBoundaryResolution =>
    validateVersionedIndependentSignerBoundaryResolution(resolution, 4)

/**
 * The durable-state half of the resolver's precondition, evaluated identically
 * by both stores and re-evaluated independently by the PostgreSQL guard
 * trigger. A resolution may only speak for the boundary the record currently
 * owns, and `never-invoked` may only be claimed for a record that carries no
 * signer escape evidence whatsoever.
 */
/**
 * Reuses the canonical consuming-transaction validator rather than restating
 * it. The one check deliberately NOT imported from the terminal-disposition
 * path is "the consuming transaction is not one of ours": for an orphan the
 * prepared-hash set is empty, so it would be vacuous, and the recovery is the
 * same either way — the nonce is spent regardless of who spent it.
 */
const normalizeSignerBoundaryNonceConsumption = (
  evidence: P2TRSignatureFraudNonceConsumptionEvidence,
  enforceFinalityFloor: boolean
): P2TRSignatureFraudNonceConsumptionEvidence => {
  // The canonical validators are void-returning assertions, so the normalized
  // shape is rebuilt here from the same helpers they use.
  validateCanonicalBlock(
    evidence.finalizedThrough,
    "Signer-boundary nonce consumption finality"
  )
  validateCanonicalBlock(
    evidence.observedHead,
    "Signer-boundary nonce consumption observed head"
  )
  const finalizedThrough = {
    blockNumber: evidence.finalizedThrough.blockNumber,
    blockHash: normalizeBytes32(
      evidence.finalizedThrough.blockHash,
      "Signer-boundary nonce consumption finality hash"
    ),
  }
  const observedHead = {
    blockNumber: evidence.observedHead.blockNumber,
    blockHash: normalizeBytes32(
      evidence.observedHead.blockHash,
      "Signer-boundary nonce consumption observed head hash"
    ),
  }
  if (observedHead.blockNumber < finalizedThrough.blockNumber) {
    throw new Error(
      "Signer-boundary nonce consumption finality boundary is ahead of its observed head"
    )
  }
  if (
    enforceFinalityFloor &&
    observedHead.blockNumber - finalizedThrough.blockNumber <
      P2TR_SIGNATURE_FRAUD_OUTBOX_MIN_FINALITY_CONFIRMATION_BLOCKS
  ) {
    throw new Error(
      `Signer-boundary nonce consumption finality depth must be at least ${P2TR_SIGNATURE_FRAUD_OUTBOX_MIN_FINALITY_CONFIRMATION_BLOCKS} blocks`
    )
  }
  const transactionNonce = requireNonNegativeSafeInteger(
    evidence.transactionNonce,
    "Signer-boundary nonce consumption nonce"
  )
  const finalizedAccountNonce = requireNonNegativeSafeInteger(
    evidence.finalizedAccountNonce,
    "Signer-boundary nonce consumption account nonce"
  )
  // Strictly past the reserved nonce: equality would mean N is still spendable.
  if (finalizedAccountNonce <= transactionNonce) {
    throw new Error(
      "Signer-boundary nonce consumption requires an account nonce past the reserved nonce"
    )
  }
  const accountNonceReadAtBlock = requireNonNegativeSafeInteger(
    evidence.accountNonceReadAtBlock,
    "Signer-boundary nonce consumption read block"
  )
  // Read AT the finality boundary, not at head, or the account nonce could be
  // reorganised away underneath the resolution.
  if (accountNonceReadAtBlock !== finalizedThrough.blockNumber) {
    throw new Error(
      "Signer-boundary nonce consumption account nonce was not read at its finality boundary"
    )
  }
  validateCanonicalNonceConsumingTransaction(
    evidence.consumingTransaction,
    finalizedThrough
  )
  const consumingTransaction = {
    transactionHash: normalizeBytes32(
      evidence.consumingTransaction.transactionHash,
      "Signer-boundary consuming transaction hash"
    ),
    sender: normalizeAddress(
      evidence.consumingTransaction.sender,
      "Signer-boundary consuming transaction sender"
    ),
    nonce: evidence.consumingTransaction.nonce,
    blockNumber: evidence.consumingTransaction.blockNumber,
    blockHash: normalizeBytes32(
      evidence.consumingTransaction.blockHash,
      "Signer-boundary consuming transaction block hash"
    ),
  }
  const sender = normalizeAddress(
    evidence.sender,
    "Signer-boundary nonce consumption sender"
  )
  if (
    consumingTransaction.sender !== sender ||
    consumingTransaction.nonce !== transactionNonce
  ) {
    throw new Error(
      "Signer-boundary nonce consumption names another sender lane"
    )
  }
  return {
    chainID: requirePositiveSafeInteger(
      evidence.chainID,
      "Signer-boundary nonce consumption chain ID"
    ),
    sender,
    transactionNonce,
    finalizedAccountNonce,
    accountNonceReadAtBlock,
    consumingTransaction,
    finalizedThrough,
    observedHead,
  }
}

export const assertP2TRSignatureFraudOrphanedSignerBoundaryOwnership = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  resolution: P2TRSignatureFraudNormalizedSignerBoundaryResolution
): void => {
  // The invocation ID decides identity: it is a digest over the whole boundary
  // binding and is frozen by the swap that set the marker, so it is what a
  // provider can journal and what the primary key indexes.
  //
  // The other three are still compared against the durable row. They are
  // descriptive columns of append-only evidence, and nothing downstream reads
  // them, so leaving them unchecked would let a resolution that names the right
  // boundary write permanently wrong forensics about it. None of them can drift
  // while the marker is set — the start is immutable in flight and NULL-paired
  // with the ID, the reservation cannot be NULLed under an active marker, and
  // every transition that bumps the attempt clears the marker in the same swap —
  // so checking them costs nothing.
  if (
    record.activeSignerInvocationID === undefined ||
    normalizeBytes32(
      record.activeSignerInvocationID,
      "Durable active signer invocation ID"
    ) !== resolution.signerInvocationID ||
    record.activeSignerInvocationStartedAtUnixMs !==
      resolution.boundaryStartedAtUnixMs ||
    record.preparationAttempts !== resolution.preparationAttempts ||
    record.reservedNonce === undefined ||
    normalizeBytes32(
      record.reservedNonce.reservationID,
      "Durable orphaned signer boundary reservation ID"
    ) !== resolution.nonceReservationID
  ) {
    throw new Error(
      "Orphaned signer boundary resolution does not name the durable boundary"
    )
  }
  const expectedStage =
    record.preparationResumeStatus === undefined ? "prepare" : "replacement"
  if (resolution.stage !== expectedStage) {
    throw new Error(
      "Orphaned signer boundary resolution does not name the durable signer stage"
    )
  }
  if (
    resolution.outcome === "never-invoked" &&
    (record.signerInvocationStartedAtUnixMs !== undefined ||
      (record.preparedTransactionVariants?.length ?? 0) > 0 ||
      (record.unexpectedSignedArtifacts?.length ?? 0) > 0 ||
      record.contestedNonceBurn !== undefined ||
      record.broadcastAttempts > 0)
  ) {
    throw new Error(
      "Orphaned signer boundary resolution requires a boundary with no signer escape evidence"
    )
  }
  // The consumption evidence must name THIS record's lane and chain. Without
  // this, two attestations over "sender S nonce N is consumed" would replay
  // against any record on any chain sharing that pair.
  if (resolution.nonceConsumption !== undefined) {
    if (
      record.reservedNonce === undefined ||
      normalizeAddress(
        resolution.nonceConsumption.sender,
        "Nonce consumption sender"
      ) !==
        normalizeAddress(
          record.reservedNonce.sender,
          "Durable reserved sender"
        ) ||
      resolution.nonceConsumption.transactionNonce !==
        record.reservedNonce.nonce
    ) {
      throw new Error(
        "Orphaned signer boundary nonce consumption names another sender lane"
      )
    }
    if (
      resolution.nonceConsumption.chainID !==
      requirePositiveSafeInteger(
        record.intent.chainID,
        "Durable challenge chain ID"
      )
    ) {
      throw new Error(
        "Orphaned signer boundary nonce consumption names another chain"
      )
    }
  }
  if (
    resolution.providerTombstone !== undefined &&
    // Equal to the record's marker by the ownership check above, and already
    // validated, so no assertion is needed to reach it.
    (resolution.providerTombstone.tombstonedAtUnixMs <
      resolution.boundaryStartedAtUnixMs ||
      resolution.providerTombstone.tombstonedAtUnixMs >
        resolution.resolvedAtUnixMs)
  ) {
    throw new Error(
      "Orphaned signer boundary tombstone falls outside the invocation window"
    )
  }
}

export type P2TRSignatureFraudNonceReleasePageRequest = {
  limit: number
  cursor?: string
}

/**
 * One nonce lane: the sending account on one chain. This is the unit the
 * durable nonce-allocator barrier is keyed by, because a nonce reservation and
 * its release both belong to exactly one account.
 */
export type P2TRSignatureFraudSigningLane = {
  chainID: number
  sender: string
}

/**
 * The single normalizer both store implementations must route through. A lane
 * is a lookup key, so a checksummed address and its lower-case spelling have to
 * collapse to one value; if the two implementations disagreed here, the
 * in-memory double would report a lane clear while PostgreSQL reported it
 * blocked, and the divergence would favour signing.
 */
export function normalizeP2TRSignatureFraudSigningLane(
  lane: P2TRSignatureFraudSigningLane
): P2TRSignatureFraudSigningLane {
  return {
    chainID: normalizePositiveSafeIntegerLike(
      lane.chainID,
      "Signing lane chain ID"
    ),
    sender: normalizeAddress(lane.sender, "Signing lane sender"),
  }
}

export type P2TRSignatureFraudNonceReleasePage = {
  requests: P2TRSignatureFraudNonceReleaseRequest[]
  nextCursor?: string
}

/**
 * Binds a release request to one exact tombstoned reservation. The byte-level
 * construction is intentionally mirrored by the PostgreSQL insert trigger.
 */
export const computeP2TRSignatureFraudNonceReleaseRequestID = (
  recordID: Hex | Buffer | string,
  reservationID: Hex | Buffer | string,
  voidEvidenceDigest: Hex | Buffer | string
): string => {
  const hash = createHash("sha256")
  hash.update(P2TR_SIGNATURE_FRAUD_NONCE_RELEASE_REQUEST_DOMAIN, "utf8")
  hash.update(
    Buffer.from(normalizeBytes32(recordID, "Release record ID").slice(2), "hex")
  )
  hash.update(
    Buffer.from(
      normalizeBytes32(reservationID, "Release reservation ID").slice(2),
      "hex"
    )
  )
  hash.update(
    Buffer.from(
      normalizeBytes32(
        voidEvidenceDigest,
        "Release void evidence digest"
      ).slice(2),
      "hex"
    )
  )
  return `0x${hash.digest("hex")}`
}

export type P2TRSignatureFraudSignerQuarantine = {
  laneID: string
  signerIdentity: string
  expectedSender: string
  expectedNonce?: number
  reservationID?: string
  reasonCode:
    | "ambiguous-signer-invocation"
    | "oversized-signed-envelope"
    | "wrong-chain"
    | "wrong-sender"
    | "wrong-nonce"
    | "malformed-signed-envelope"
    | "wrong-signer-invocation-request"
    | "invalid-replacement-envelope"
    | "reservation-binding-mismatch"
    | "reservation-provider-failure"
  quarantinedAtUnixMs: number
  reason: string
  detailsDigest: string
}

export type P2TRSignatureFraudContestedNonceBurn = {
  transactionHash: string
  rawTransaction: string
  nonce: number
  sender: string
  maxFeePerGas: string
  maxPriorityFeePerGas: string
  signerInvocationID: string
  signedAtUnixMs: number
  broadcastAtUnixMs?: number
}

/**
 * Durable pre-I/O fence for the burn signer. The original orphaned boundary
 * may be independently resolved while this second signer call is in flight;
 * this claim keeps the exact reservation non-releasable until signed bytes
 * replace it atomically.
 */
export type P2TRSignatureFraudContestedNonceBurnClaim = {
  signerInvocationID: string
  signerRequestDigest: string
  reservationID: string
  recordVersion: number
  preparationAttempts: number
  claimedAtUnixMs: number
}

export type P2TRSignatureFraudChallengeOutboxRecord = {
  seriesID: string
  recordID: string
  intent: P2TRSignatureFraudSubmissionIntent
  evidenceCheckpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint
  canonicalEthereumEligibility: P2TRSignatureFraudCanonicalEthereumEligibilityEvidence
  canonicalProvenance: P2TRSignatureFraudCanonicalProvenanceBinding
  feePolicyManifest: P2TRSignatureFraudChallengeFeePolicyManifest
  status: P2TRSignatureFraudChallengeOutboxStatus
  version: number
  generation: number
  generationTrigger: P2TRSignatureFraudGenerationTrigger
  createdAtUnixMs: number
  updatedAtUnixMs: number
  preparationAttempts: number
  broadcastAttempts: number
  reconciliationAttempts: number
  /** Holds the exclusive nonterminal nonce lane for this sender. */
  preparationSender?: string
  selectedLaneID?: string
  selectedSignerIdentity?: string
  reservedNonce?: P2TRSignatureFraudBoundNonceReservation
  nonceReservedAtUnixMs?: number
  voidedNonceReservations?: readonly P2TRSignatureFraudVoidedNonceReservation[]
  signerQuarantines?: readonly P2TRSignatureFraudSignerQuarantine[]
  unexpectedSignedArtifacts?: readonly P2TRSignatureFraudUnexpectedSignedArtifact[]
  cancellationEvidence?: P2TRSignatureFraudCanonicalCancellationEvidence
  provenanceInvalidationEvidence?: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence
  /** Exact independently attested evidence that released the nonce lane. */
  finalNonceResolution?: P2TRSignatureFraudFinalNonceResolution
  generationDisposition?: P2TRSignatureFraudFinalizedGenerationDisposition
  preparationLease?: P2TRSignatureFraudChallengeOutboxPreparationLease
  /** Present only while signing a replacement for an existing variant. */
  preparationResumeStatus?: "prepared" | "broadcast-pending"
  /** Durable boundary for the currently active signer call. */
  activeSignerInvocationStartedAtUnixMs?: number
  /**
   * Deterministic identity of that boundary, committed in the same swap that
   * sets the marker above. Present exactly when the marker is: the activation
   * barrier counts this marker and the burn claim below as distinct signer
   * invocations, so each null transition is accounted independently.
   */
  activeSignerInvocationID?: string
  /** Historical proof that at least one signer invocation began. */
  signerInvocationStartedAtUnixMs?: number
  /** Identity of the last boundary that reached a signer. */
  signerInvocationID?: string
  /** Durable before the burn signer is invoked; replaced only by burn bytes. */
  contestedNonceBurnClaim?: P2TRSignatureFraudContestedNonceBurnClaim
  /**
   * A signed transaction that spends the reserved nonce on nothing, made
   * durable before it is broadcast. Its presence means the lane's nonce race
   * has been forced to terminate: whichever transaction confirms, signed
   * challenge bytes for that nonce become inert.
   */
  contestedNonceBurn?: P2TRSignatureFraudContestedNonceBurn
  preparedTransaction?: P2TRSignatureFraudPreparedChallengeTransaction
  /** Append-only signed identities; the singular field aliases the last item. */
  preparedTransactionVariants?: readonly P2TRSignatureFraudPreparedTransactionVariant[]
  /** Last failed acquisition or consumption of pre-send authority. */
  lastBroadcastAuthorizationFailureAtUnixMs?: number
  lastBroadcastAtUnixMs?: number
  lastBroadcastProviderAccepted?: boolean
  lastReconciliationAtUnixMs?: number
  lastPreBroadcastRecheckAtUnixMs?: number
  lastPreBroadcastRecheckStatus?: P2TRSignatureFraudPreBroadcastRecheckResult["status"]
  lastResolutionStatus?: P2TRSignatureFraudChallengeOutboxResolution["status"]
  lastError?: string
}

export type P2TRSignatureFraudLegacySubmissionQuarantine = {
  observationID: string
  bridgeChallengeKey?: string
  legacyStatus: P2TRWatchtowerChallengeRecord["status"]
  submissionAttempts: number
  challengeTxHash?: string
  reason: string
  quarantinedAtUnixMs: number
}

export type P2TRSignatureFraudOutboxCriticalAlert = {
  code:
    | "generation-cap-exhausted"
    | "signed-variant-cap-exhausted"
    | "signed-state-quarantined"
    | "late-signed-artifact-captured"
    | "escaped-signed-envelope-captured"
    | "reservation-release-failed"
    | "nonce-release-terminal-unsafe"
    | "signer-boundary-terminal-unsafe"
    | "reservation-state-ambiguous"
    | "nonce-reservation-cap-exhausted"
    | "provenance-reconciliation-incident"
  seriesID: string
  recordID: string
  generation: number
  activationBlocking: true
  createdAtUnixMs: number
  detail: string
}

export type P2TRSignatureFraudChallengeOutboxPageRequest = {
  statuses: P2TRSignatureFraudChallengeOutboxStatus[]
  limit: number
  cursor?: string
}

export type P2TRSignatureFraudChallengeOutboxPage = {
  records: P2TRSignatureFraudChallengeOutboxRecord[]
  nextCursor?: string
}

export type P2TRSignatureFraudChallengeOutboxEligibilitySnapshot = {
  challengeRecord: P2TRWatchtowerChallengeRecord
  /** Reconstructed from the currently canonical candidate row in this transaction. */
  canonicalObservation: P2TRSignatureFraudWitnessObservation
  canonicalCandidate: P2TRSignatureFraudCanonicalObservationPointer
  canonicalCandidateDelivered: true
  canonicalCandidateCurrentAtCursor: true
  evidenceCheckpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint
  canonicalEthereumEligibility: P2TRSignatureFraudCanonicalEthereumEligibilityEvidence
  canonicalProvenance: P2TRSignatureFraudCanonicalProvenanceBinding
  legacySubmissionQuarantined: boolean
  canonicalRegisteredWalletID: Hex | Buffer | string
  canonicalWalletInputAuthorization:
    | {
        kind: "registered-wallet-output"
        inputIndex: number
        fundingBlockHash: Hex | Buffer | string
        fundingTxid: Hex | Buffer | string
        fundingVout: number
        walletID: Hex | Buffer | string
        outputKey: Hex | Buffer | string
        sourceEventID: Hex | Buffer | string
        ethereumBlockNumber: number
        ethereumBlockHash: Hex | Buffer | string
      }
    | {
        kind: "deposit-binding"
        inputIndex: number
        fundingBlockHash: Hex | Buffer | string
        fundingTxid: Hex | Buffer | string
        fundingVout: number
        binding: P2TRWalletInputKeyBinding
        sourceEventID: Hex | Buffer | string
        ethereumBlockNumber: number
        ethereumBlockHash: Hex | Buffer | string
      }
}

export type P2TRSignatureFraudCanonicalObservationPointer = {
  txid: string
  wtxid: string
  blockHash: string
  blockHeight: number
  inputIndex: number
}

export type P2TRSignatureFraudCanonicalProvenanceBinding = {
  journalStoreID: string
  descriptorSetHash: string
  throughBlockNumber: number
  throughBlockHash: string
  historyRoot: string
  /** Fixed commitment to the exact canonical event set; raw IDs are not durable. */
  eventSetHash: string
  eventCount: number
  challengeKey: string
  candidateDigest: string
  readinessCertificateID: string
  readinessCertificateGeneration: number
  candidateProvenanceGeneration: number
  inputBindingKind: "registered-wallet-output" | "deposit-binding"
  inputBindingSourceEventID: string
  inputIndex: number
  fundingBlockHash: string
  fundingTxid: string
  fundingVout: number
  inputWalletID: string
  inputOutputKey: string
  bindingEthereumBlockNumber: number
  bindingEthereumBlockHash: string
  provenanceFingerprint: string
  manifestHash: string
}

export const computeP2TRSignatureFraudCanonicalCandidateDigest = (
  candidate: P2TRSignatureFraudCanonicalObservationPointer,
  observationID: Hex | Buffer | string
): string =>
  sha256Structured({
    domain: P2TR_SIGNATURE_FRAUD_CANONICAL_CANDIDATE_DOMAIN,
    observationID: normalizeBytes32(observationID, "Canonical observation ID"),
    ...normalizeCanonicalCandidatePointer(candidate, "Canonical candidate"),
  })

export const computeP2TRSignatureFraudCanonicalEventSetHash = (
  eventIDs: readonly (Hex | Buffer | string)[]
): string => {
  if (
    !Array.isArray(eventIDs) ||
    eventIDs.length === 0 ||
    eventIDs.length > P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE
  ) {
    throw new Error(
      "Canonical provenance event set must contain between one and one thousand IDs"
    )
  }
  const normalized = eventIDs
    .map((eventID) =>
      normalizeBytes32(eventID, "Canonical provenance event ID")
    )
    .sort()
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Canonical provenance event IDs must be unique")
  }
  return sha256Structured({
    domain: P2TR_SIGNATURE_FRAUD_CANONICAL_EVENT_SET_DOMAIN,
    eventIDs: normalized,
  })
}

export const computeP2TRSignatureFraudCanonicalProvenanceFingerprint = (
  binding: Omit<
    P2TRSignatureFraudCanonicalProvenanceBinding,
    "provenanceFingerprint"
  >
): string =>
  sha256Structured({
    domain: P2TR_SIGNATURE_FRAUD_CANONICAL_PROVENANCE_DOMAIN,
    ...normalizeCanonicalProvenanceWithoutFingerprint(binding),
  })

export type P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence = {
  evidenceHash: string
  provenanceTombstoneID: string
  candidate: P2TRSignatureFraudCanonicalObservationPointer
  observationID: string
  candidateDigest: string
  candidateProvenanceGeneration: number
  provenanceFingerprint: string
  manifestHash: string
  ethereumRollbackBlockHash: string
  ethereumRollbackBlockNumber: number
  provenanceInvalidationSequence: number
  invalidatedAtUnixMs: number
  reason: string
}

export type P2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceWithoutHash =
  Omit<
    P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence,
    "evidenceHash"
  >

export const computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash =
  (
    evidence: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceWithoutHash
  ): string =>
    sha256Structured({
      domain: P2TR_SIGNATURE_FRAUD_PROVENANCE_INVALIDATION_DOMAIN,
      ...normalizeCanonicalProvenanceInvalidationEvidenceWithoutHash(evidence),
    })

export const invalidateP2TRSignatureFraudCanonicalProvenance = async (
  store: P2TRSignatureFraudChallengeOutboxStore,
  evidence: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence
): Promise<readonly P2TRSignatureFraudChallengeOutboxRecord[]> => {
  validateCanonicalProvenanceInvalidationEvidence(evidence)
  return store.invalidateCanonicalProvenance(evidence)
}

export type P2TRSignatureFraudChallengeOutboxSchedulerOptions = {
  submissionIntent: P2TRSignatureFraudSubmissionIntentOptions
  activationManifest: P2TRSignatureFraudActivationManifestBinding
  feePolicyManifest: P2TRSignatureFraudChallengeFeePolicyManifest
  observationValidation: Omit<
    P2TRSignatureFraudWitnessObservationConsistencyContext,
    "registeredWalletIDs" | "walletInputKeyBindings"
  >
}

/**
 * Atomic compare-and-swap storage boundary for the production outbox.
 *
 * Implementations must enforce unique `(seriesID, generation)` identities,
 * contiguous predecessor linkage, and one unresolved reservation per sender.
 * `insertGenerationIfAbsent` and
 * `compareAndSwap` must participate in the same ambient transaction as the
 * challenge-record and source-cursor stores when invoked by the scheduler.
 * A CAS must reject removal or identity mutation of any signed variant; it may
 * append at most one strictly validated variant and may update only delivery
 * metadata for existing variants.
 */
export interface P2TRSignatureFraudChallengeOutboxStore
  extends P2TRSignatureFraudWatchtowerStoreProfileProvider {
  /** Rejects dispatcher I/O when an outer database transaction is ambient. */
  assertExternalIOTransactionBoundary(): void
  /**
   * Authenticates persistence failures that are safe to retry at an exact,
   * idempotent pre-I/O boundary. Implementations must return true only for a
   * coordinator-owned unknown transaction outcome or a confirmed retryable
   * abort; deterministic validation/constraint failures must return false.
   */
  isP2TRSignatureFraudWatchtowerPersistenceRetryable(error: unknown): boolean
  insertGenerationIfAbsent(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord>
  get(
    recordID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined>
  getLatest(
    seriesID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined>
  isSignerQuarantined(chainID: number, signerIdentity: string): Promise<boolean>
  /**
   * Omitting the lane asks the store-wide question, which is what decides
   * whether recovery must be swept. Passing one asks only whether THAT nonce
   * lane is still unresolved, which is what decides whether signing on it may
   * proceed. The two are deliberately different questions: a lane is frozen by
   * its own residue, never by another account's.
   */
  hasExpiredPreparationLeases(
    nowUnixMs: number,
    lane?: P2TRSignatureFraudSigningLane
  ): Promise<boolean>
  hasPendingNonceReleases(
    lane?: P2TRSignatureFraudSigningLane
  ): Promise<boolean>
  getNonceReleaseRequest(
    releaseRequestID: string
  ): Promise<P2TRSignatureFraudNonceReleaseRequest | undefined>
  listPendingNonceReleases(
    request: P2TRSignatureFraudNonceReleasePageRequest
  ): Promise<P2TRSignatureFraudNonceReleasePage>
  /**
   * Reconstructs a barrier-owned invocation after restart. The durable barrier
   * is keyed per nonce lane, so several lanes can hold a claim at once; one
   * recoverable invocation is returned per call and the caller drains the rest
   * on subsequent passes. A still-live resultless call is not exposed for
   * independent resolution.
   */
  getActiveAmbiguousNonceReleaseInvocation(
    nowUnixMs: number
  ): Promise<P2TRSignatureFraudAmbiguousNonceReleaseInvocation | undefined>
  claimNonceReleaseAttempt(
    releaseRequestID: string,
    owner: string,
    startedAtUnixMs: number,
    expiresAtUnixMs: number
  ): Promise<P2TRSignatureFraudNonceReleaseAttempt | undefined>
  /**
   * Commits the irreversible allocator-I/O boundary for an exact live attempt.
   * Repeating the exact attempt and invocation time is idempotently successful
   * so a caller can reconcile a lost commit response before provider I/O. A
   * resultless invocation is never reclaimed merely because time elapsed.
   */
  beginNonceReleaseAttempt(
    attempt: P2TRSignatureFraudNonceReleaseAttempt,
    invokedAtUnixMs: number
  ): Promise<boolean>
  /**
   * Appends the attempt result. Exact, current, on-time provider
   * acknowledgements resolve the request; late responses remain ambiguous.
   */
  recordNonceReleaseAttemptResult(
    attempt: P2TRSignatureFraudNonceReleaseAttempt,
    result: P2TRSignatureFraudNonceReleaseAttemptResult
  ): Promise<"acknowledged" | "ambiguous">
  /**
   * Appends independently verified terminal evidence for the exact sticky
   * ambiguous provider invocation. Implementations must never replace the
   * original result and must clear the global I/O barrier only atomically with
   * this evidence.
   */
  resolveAmbiguousNonceRelease(
    resolution: P2TRSignatureFraudIndependentNonceReleaseResolution
  ): Promise<"acknowledged" | "unsafe">
  /**
   * Appends independently verified terminal evidence for one exact orphaned
   * signer boundary — the durable pre-I/O marker whose owning process died
   * before any result could be witnessed. Implementations must bind the exact
   * boundary tuple, require two independent attestations, and perform every
   * effect in one transaction.
   *
   * `never-invoked` is the only outcome permitted to clear the marker, and only
   * against a durable row carrying no signer escape evidence; it also retires
   * the activation-blocking incidents raised over that boundary. `signed`
   * retains the boundary so the escaped bytes can still be captured and
   * quarantined under it. `terminal-unsafe` retains the boundary, keeps
   * activation blocked, and raises an activation-blocking critical alert.
   */
  resolveOrphanedSignerBoundary(
    resolution: P2TRSignatureFraudIndependentSignerBoundaryResolution
  ): Promise<"acknowledged" | "unsafe">
  compareAndSwap(
    recordID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean>
  /**
   * Rechecks the exact canonical-index provenance and performs the CAS under
   * one runtime-minted PostgreSQL transaction and the candidate advisory lock.
   * This is mandatory for every claim that can reach a signer or broadcaster.
   */
  compareAndSwapWithCurrentCanonicalProvenance(
    recordID: string,
    expectedVersion: number,
    expectedProvenance: P2TRSignatureFraudCanonicalProvenanceBinding,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean>
  /**
   * Compare-and-swap that also retires the activation-blocking incidents
   * raised over one exact signer boundary proven never to have reached the
   * signer. Retirement MUST be atomic with the swap that clears the boundary
   * marker: resolving first would unblock activation while the barrier is
   * still live, and clearing first would strand a permanently blocking
   * incident. Implementations must refuse to retire when the record carries
   * any signer escape evidence.
   */
  compareAndSwapRetiringUninvokedSignerBoundary(
    recordID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord,
    boundary: {
      /** The identity; the fields below are retained detail. */
      signerInvocationID: string
      startedAtUnixMs: number
      preparationAttempts: number
      nonceReservationID: string
    },
    resolvedAtUnixMs: number
  ): Promise<boolean>
  /**
   * Privileged append-only recovery boundary for bytes returned after any
   * post-signer normal version CAS is lost. It requires the retained durable
   * reservation and signer boundary, may not release a nonce or remove any
   * prior artifact, and must atomically move an invalidated generation to
   * provenance reconciliation while clearing its active signer/lease markers.
   */
  captureEscapedSignedArtifact(
    recordID: string,
    expectedProvenanceFingerprint: string,
    artifact: P2TRSignatureFraudUnexpectedSignedArtifact,
    signerQuarantine?: P2TRSignatureFraudSignerQuarantine
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord>
  /**
   * Atomically appends the canonical rollback tombstone linkage and transitions
   * every matching generation. Implementations must persist an activation-
   * blocking incident for any escaped signed or broadcast artifact.
   */
  invalidateCanonicalProvenance(
    evidence: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence
  ): Promise<readonly P2TRSignatureFraudChallengeOutboxRecord[]>
  listPage(
    request: P2TRSignatureFraudChallengeOutboxPageRequest
  ): Promise<P2TRSignatureFraudChallengeOutboxPage>
  saveLegacyQuarantine(
    quarantine: P2TRSignatureFraudLegacySubmissionQuarantine
  ): Promise<void>
  saveCriticalAlert(alert: P2TRSignatureFraudOutboxCriticalAlert): Promise<void>
  /**
   * Locks and loads the authoritative observation, canonical cursor/proof
   * checkpoints, and legacy quarantine row. The callback and any outbox insert
   * it performs must commit atomically or roll back together.
   */
  runInEligibilityTransaction<T>(
    observationID: string,
    operation: (
      snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
    ) => Promise<T>
  ): Promise<T>
}

export interface P2TRSignatureFraudRawTransactionBroadcaster {
  readonly submissionTrustDomainID: string
  readonly submissionIndependenceDomainID: string
  readonly providerIdentity: object
  broadcastRawTransaction(
    rawTransaction: string
  ): Promise<Hex | Buffer | string>
}

export type P2TRSignatureFraudChallengeOutboxReconciliationContext = {
  recordID: string
  generation: number
  outboxStatus: P2TRSignatureFraudChallengeOutboxStatus
  intent: P2TRSignatureFraudSubmissionIntent
  evidenceCheckpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint
  canonicalProvenance: P2TRSignatureFraudCanonicalProvenanceBinding
  /** Complete append-only variant set; reconcilers must inspect every hash. */
  preparedTransactions: readonly P2TRSignatureFraudPreparedChallengeTransaction[]
  reservedNonce?: P2TRSignatureFraudBoundNonceReservation
  unexpectedSignedArtifacts: readonly P2TRSignatureFraudUnexpectedSignedArtifact[]
  broadcastAttempts: number
  reconciliationAttempts: number
  lastBroadcastAtUnixMs?: number
}

export interface P2TRSignatureFraudChallengeOutboxReconciler {
  readonly reconciliationTrustDomainID: string
  readonly reconciliationIndependenceDomainID: string
  readonly providerIdentity: object
  readonly finalityConfirmationBlocks: number
  /** Exact ABI-derived selectors this reconciler is allowed to decode. */
  readonly canonicalSubmissionSelectors: readonly {
    variant: P2TRSignatureFraudDecodedSubmissionCall["variant"]
    selector: string
  }[]
  reconcileSignatureFraudChallengeOutbox(
    context: P2TRSignatureFraudChallengeOutboxReconciliationContext
  ): Promise<P2TRSignatureFraudChallengeOutboxResolution>
}

export type P2TRSignatureFraudCanonicalResolutionEvidenceVerification = {
  status: "verified"
  evidenceDigest: string
  trustDomainID: string
  independenceDomainID: string
  attestation: string
  verifiedAtUnixMs: number
}

export interface P2TRSignatureFraudCanonicalResolutionEvidenceVerifier {
  readonly canonicalVerificationTrustDomainID: string
  readonly canonicalVerificationIndependenceDomainID: string
  readonly providerIdentity: object
  verifySignatureFraudCanonicalResolutionEvidence(
    context: P2TRSignatureFraudChallengeOutboxReconciliationContext,
    resolution: Exclude<
      P2TRSignatureFraudChallengeOutboxResolution,
      { status: "pending" | "unknown" }
    >
  ): Promise<P2TRSignatureFraudCanonicalResolutionEvidenceVerification>
}

export type P2TRSignatureFraudPreBroadcastRecheckContext = {
  stage: "before-sign" | "before-broadcast"
  recordID: string
  generation: number
  intent: P2TRSignatureFraudSubmissionIntent
  evidenceCheckpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint
  canonicalEthereumEligibility: P2TRSignatureFraudCanonicalEthereumEligibilityEvidence
  canonicalProvenance: P2TRSignatureFraudCanonicalProvenanceBinding
  preparedTransaction?: P2TRSignatureFraudPreparedChallengeTransaction
  broadcastAttempts: number
}

export type P2TRSignatureFraudPreBroadcastRecheckResult =
  | {
      status: "eligible"
      canonicalCandidate: P2TRSignatureFraudCanonicalObservationPointer
      canonicalEthereumEligibility: P2TRSignatureFraudCanonicalEthereumEligibilityEvidence
      canonicalProvenance: P2TRSignatureFraudCanonicalProvenanceBinding
    }
  | {
      status: "cancelled-honest-spend" | "cancelled-reorg"
      reason: string
      evidence: P2TRSignatureFraudCanonicalCancellationEvidence
    }
  | {
      status: "unknown"
      reason: string
    }

export interface P2TRSignatureFraudPreBroadcastRechecker {
  readonly recheckTrustDomainID: string
  readonly recheckIndependenceDomainID: string
  readonly providerIdentity: object
  recheckSignatureFraudChallengeBeforeBroadcast(
    context: P2TRSignatureFraudPreBroadcastRecheckContext
  ): Promise<P2TRSignatureFraudPreBroadcastRecheckResult>
}

export type P2TRSignatureFraudCancellationEvidenceVerification = {
  status: "verified"
  evidenceHash: string
  verifiedAtUnixMs: number
  corroboratingAttestation: string
}

export interface P2TRSignatureFraudCancellationEvidenceVerifier {
  readonly cancellationVerificationTrustDomainID: string
  readonly cancellationVerificationIndependenceDomainID: string
  readonly providerIdentity: object
  verifySignatureFraudCancellationEvidence(
    context: P2TRSignatureFraudPreBroadcastRecheckContext,
    evidence: P2TRSignatureFraudCanonicalCancellationEvidence
  ): Promise<P2TRSignatureFraudCancellationEvidenceVerification>
}

export type P2TRSignatureFraudIrreversibleBoundaryStage =
  | "prepare"
  | "replacement"
  | "broadcast"
  | "burn"

/**
 * Exact durable state that must be independently re-authorized after the
 * outbox CAS and immediately before a signer or broadcaster is invoked,
 * together with the exact request that boundary authorizes: the lane, the
 * transaction intent, and the lane-specific fee envelope.
 *
 * Field order is mirrored by `P2TRReconcilerRequestBinding`; see the note on
 * `reconcilerRequestBinding`.
 */
export type P2TRSignatureFraudIrreversibleBoundaryBinding = {
  recordID: string
  generation: number
  recordVersion: number
  reservationID: string
  sender: string
  transactionNonce: number
  stage: P2TRSignatureFraudIrreversibleBoundaryStage
  attempt: number
  provenanceFingerprint: string
  activationManifestHash: string
  /**
   * The lane chooses which signer is invoked and which fee envelope applies,
   * so a lane-agnostic authorization would authorize the wrong signer.
   */
  laneID: string
  signerIdentity: string
  /** Recomputed from the intent here, never copied out of durable state. */
  intentID: string
  /** Carried in the clear too: an authorizer cannot invert `intentID`. */
  routerAddress: string
  intentValueWei: string
  /**
   * The envelope actually handed to the signer. Only its manifest hash was
   * bound before, which named the whole manifest but not this lane's caps.
   */
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

declare const irreversibleBoundaryAuthorizationBrand: unique symbol

/**
 * Process-local, one-use authorization. Implementations must reject copied,
 * forged, stale, replayed, or differently bound values synchronously.
 */
export type P2TRSignatureFraudIrreversibleBoundaryAuthorization = {
  readonly [irreversibleBoundaryAuthorizationBrand]: true
}

export interface P2TRSignatureFraudIrreversibleBoundaryAuthorizer {
  authorizeP2TRSignatureFraudIrreversibleBoundary(
    binding: P2TRSignatureFraudIrreversibleBoundaryBinding
  ): Promise<P2TRSignatureFraudIrreversibleBoundaryAuthorization>
  /** This call must be synchronous and consume the authorization on success. */
  assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
    authorization: P2TRSignatureFraudIrreversibleBoundaryAuthorization,
    binding: P2TRSignatureFraudIrreversibleBoundaryBinding,
    nowUnixMs: number
  ): void
}

export type P2TRSignatureFraudChallengeOutboxDispatcherOptions = {
  irreversibleBoundaryAuthorizer: P2TRSignatureFraudIrreversibleBoundaryAuthorizer
  preparationLeaseMs?: number
  minimumRebroadcastIntervalMs?: number
  recoveryPageSize?: number
  nonceReleaseAttemptLeaseMs?: number
  nonceReleaseOwner?: string
  onRecoveryBacklog?: (
    report: P2TRSignatureFraudChallengeOutboxRecoveryReport
  ) => Promise<void> | void
  now?: () => number
}

export type P2TRSignatureFraudChallengeOutboxRecoveryReport = {
  scanned: number
  recovered: number
  nextCursor?: string
  backlogRemaining: boolean
}

export type P2TRSignatureFraudNonceReleaseRecoveryReport = {
  scanned: number
  attempted: number
  acknowledged: number
  ambiguous: number
  nextCursor?: string
  backlogRemaining: boolean
}

export type P2TRSignatureFraudChallengeOutboxEnqueueOutcome =
  | {
      kind: "enqueued"
      outboxIntentID: string
      record: P2TRSignatureFraudChallengeOutboxRecord
    }
  | {
      kind: "generation-cap-exhausted"
      outboxIntentID: string
      message: string
    }

export class P2TRSignatureFraudChallengeOutboxScheduler {
  constructor(
    private readonly store: P2TRSignatureFraudChallengeOutboxStore,
    private readonly options: P2TRSignatureFraudChallengeOutboxSchedulerOptions
  ) {
    validateSchedulerOptions(options)
  }

  /**
   * Convenience boundary for standalone callers that require a record. Never
   * use this throwing wrapper inside an ambient activation-gate transaction;
   * production enqueuers must propagate `enqueueConfirmedChallenge`'s outcome.
   */
  async enqueueConfirmedChallengeRecord(
    observationID: Hex | Buffer | string,
    nowUnixMs = Date.now()
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const outcome = await this.enqueueConfirmedChallenge(
      observationID,
      nowUnixMs
    )
    if (outcome.kind === "generation-cap-exhausted") {
      throw new Error(outcome.message)
    }
    return outcome.record
  }

  /**
   * Loads and validates authoritative evidence under the store's eligibility
   * transaction. Generation-cap rejection is returned, not thrown, so an
   * ambient coordinator transaction can commit the alert and authorization
   * resolution. Callers provide only the durable observation key; they cannot
   * supply an intent, cursor, Router binding, or confirmation assertion.
   */
  async enqueueConfirmedChallenge(
    observationID: Hex | Buffer | string,
    nowUnixMs = Date.now()
  ): Promise<P2TRSignatureFraudChallengeOutboxEnqueueOutcome> {
    const key = normalizeBytes32(observationID, "Challenge observation ID")
    const result = await this.store.runInEligibilityTransaction(
      key,
      async (snapshot) => {
        // Cached record JSON is an evidence alias only. The candidate journal
        // supplies the current canonical witness bytes and authenticated
        // prevouts used to derive calldata.
        const canonicalObservation = snapshot.canonicalObservation
        validateAuthoritativeObservationBinding(snapshot)
        validateP2TRSignatureFraudWitnessObservationConsistency(
          canonicalObservation,
          canonicalObservationConsistencyContext(snapshot, this.options)
        )
        const completeEvidence =
          buildP2TRCompleteV2SignatureFraudChallengeEvidence(
            canonicalObservation,
            {
              chainID: this.options.submissionIntent.domainChainID,
              bridgeAddress: this.options.submissionIntent.bridgeAddress,
            },
            canonicalObservationConsistencyContext(snapshot, this.options)
          )
        const intent = buildP2TRSignatureFraudSubmissionIntent(
          completeEvidence,
          this.options.submissionIntent
        )
        validateEligibilitySnapshot(
          key,
          snapshot,
          intent,
          this.options.activationManifest
        )
        validateOutboxEnqueue(
          snapshot.challengeRecord,
          canonicalObservation,
          intent,
          snapshot.evidenceCheckpoint,
          nowUnixMs
        )

        const seriesID = computeP2TRSignatureFraudOutboxSeriesID(intent)
        const latest = await this.store.getLatest(seriesID)
        let generation = 0
        let generationTrigger: P2TRSignatureFraudGenerationTrigger = {
          kind: "initial",
        }
        if (latest !== undefined) {
          validateSeriesHead(
            latest,
            intent,
            seriesID,
            this.options.feePolicyManifest,
            latest.status === "cancelled-reorg" ||
              latest.status === "cancelled-provenance-invalidated"
          )
          if (latest.status === "generation-required") {
            if (latest.generationDisposition === undefined) {
              throw new Error(
                "Challenge outbox generation head lacks finalized nonce disposition evidence"
              )
            }
            validateNonceDispositionSuccessor(latest, snapshot)
            generationTrigger = {
              kind: "nonce-disposition",
              previousRecordID: latest.recordID,
              dispositionHash: computeP2TRSignatureFraudDispositionHash(
                latest.generationDisposition
              ),
            }
          } else if (latest.status === "cancelled-reorg") {
            if (
              latest.cancellationEvidence === undefined ||
              latest.cancellationEvidence.kind !== "canonical-reorg"
            ) {
              throw new Error(
                "Challenge outbox reorg head lacks canonical cancellation evidence"
              )
            }
            validateCanonicalReappearanceSuccessor(latest, snapshot)
            generationTrigger = {
              kind: "canonical-reappearance",
              previousRecordID: latest.recordID,
              cancellationEvidenceHash:
                latest.cancellationEvidence.evidenceHash,
            }
          } else if (latest.status === "cancelled-provenance-invalidated") {
            if (latest.provenanceInvalidationEvidence === undefined) {
              throw new Error(
                "Challenge outbox provenance-invalidated head lacks its canonical rollback tombstone evidence"
              )
            }
            validateCanonicalProvenanceRestorationSuccessor(latest, snapshot)
            generationTrigger = {
              kind: "provenance-restored",
              previousRecordID: latest.recordID,
              invalidationEvidenceHash:
                latest.provenanceInvalidationEvidence.evidenceHash,
              previousProvenanceFingerprint:
                latest.canonicalProvenance.provenanceFingerprint,
            }
          } else {
            const expectedLatestRecordID =
              computeP2TRSignatureFraudOutboxRecordID(
                intent,
                latest.generation,
                snapshot.evidenceCheckpoint,
                snapshot.canonicalEthereumEligibility,
                snapshot.canonicalProvenance,
                this.options.feePolicyManifest,
                latest.generationTrigger
              )
            if (expectedLatestRecordID !== latest.recordID) {
              throw new Error(
                "A nonterminal challenge generation already owns this series with different canonical evidence"
              )
            }
            return { kind: "record" as const, record: latest }
          }

          generation = latest.generation + 1
          if (generation >= P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_GENERATIONS) {
            await this.store.saveCriticalAlert({
              code: "generation-cap-exhausted",
              seriesID,
              recordID: latest.recordID,
              generation: latest.generation,
              activationBlocking: true,
              createdAtUnixMs: requireUnixMilliseconds(
                nowUnixMs,
                "Challenge generation-cap alert time"
              ),
              detail:
                "Canonical fraud evidence remains eligible after the bounded generation limit; manual multi-sender recovery is required",
            })
            return {
              kind: "generation-cap-exhausted" as const,
              outboxIntentID: latest.recordID,
              message:
                "Challenge outbox reached the bounded evidence-generation limit and persisted an activation-blocking alert",
            }
          }
        }

        const recordID = computeP2TRSignatureFraudOutboxRecordID(
          intent,
          generation,
          snapshot.evidenceCheckpoint,
          snapshot.canonicalEthereumEligibility,
          snapshot.canonicalProvenance,
          this.options.feePolicyManifest,
          generationTrigger
        )
        const record: P2TRSignatureFraudChallengeOutboxRecord = {
          seriesID,
          recordID,
          intent,
          evidenceCheckpoint: snapshot.evidenceCheckpoint,
          canonicalEthereumEligibility: snapshot.canonicalEthereumEligibility,
          canonicalProvenance: snapshot.canonicalProvenance,
          feePolicyManifest: this.options.feePolicyManifest,
          status: "queued",
          version: 0,
          generation,
          generationTrigger,
          createdAtUnixMs: nowUnixMs,
          updatedAtUnixMs: nowUnixMs,
          preparationAttempts: 0,
          broadcastAttempts: 0,
          reconciliationAttempts: 0,
        }
        const stored = await this.store.insertGenerationIfAbsent(record)
        validateExistingOutboxIdentity(stored, record)
        return { kind: "record" as const, record: stored }
      }
    )
    return result.kind === "generation-cap-exhausted"
      ? result
      : {
          kind: "enqueued",
          outboxIntentID: result.record.recordID,
          record: result.record,
        }
  }
}

export class P2TRSignatureFraudChallengeOutboxDispatcher {
  private readonly preparationLeaseMs: number
  private readonly minimumRebroadcastIntervalMs: number
  private readonly recoveryPageSize: number
  private readonly nonceReleaseAttemptLeaseMs: number
  private readonly nonceReleaseOwner: string
  private readonly irreversibleBoundaryAuthorizer: P2TRSignatureFraudIrreversibleBoundaryAuthorizer
  private readonly onRecoveryBacklog?: (
    report: P2TRSignatureFraudChallengeOutboxRecoveryReport
  ) => Promise<void> | void
  private readonly now: () => number
  private readonly preparers: readonly P2TRSignatureFraudChallengeTransactionPreparer[]
  private recoveryBarrierEstablished = false

  constructor(
    private readonly store: P2TRSignatureFraudChallengeOutboxStore,
    preparer:
      | P2TRSignatureFraudChallengeTransactionPreparer
      | readonly P2TRSignatureFraudChallengeTransactionPreparer[],
    private readonly broadcaster: P2TRSignatureFraudRawTransactionBroadcaster,
    private readonly preBroadcastRechecker: P2TRSignatureFraudPreBroadcastRechecker,
    private readonly cancellationEvidenceVerifier: P2TRSignatureFraudCancellationEvidenceVerifier,
    private readonly reconciler: P2TRSignatureFraudChallengeOutboxReconciler,
    private readonly canonicalResolutionEvidenceVerifier: P2TRSignatureFraudCanonicalResolutionEvidenceVerifier,
    options: P2TRSignatureFraudChallengeOutboxDispatcherOptions
  ) {
    if (
      options?.irreversibleBoundaryAuthorizer === undefined ||
      typeof options.irreversibleBoundaryAuthorizer
        .authorizeP2TRSignatureFraudIrreversibleBoundary !== "function" ||
      typeof options.irreversibleBoundaryAuthorizer
        .assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization !==
        "function"
    ) {
      throw new Error(
        "Challenge outbox dispatcher requires an irreversible-boundary authorizer"
      )
    }
    this.irreversibleBoundaryAuthorizer = options.irreversibleBoundaryAuthorizer
    this.preparationLeaseMs = requirePositiveSafeInteger(
      options.preparationLeaseMs ?? 30_000,
      "Challenge outbox preparation lease"
    )
    this.minimumRebroadcastIntervalMs = requireNonNegativeSafeInteger(
      options.minimumRebroadcastIntervalMs ?? 30_000,
      "Challenge outbox rebroadcast interval"
    )
    this.recoveryPageSize = requireBoundedPositiveSafeInteger(
      options.recoveryPageSize ?? 100,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE,
      "Challenge outbox recovery page size"
    )
    this.nonceReleaseAttemptLeaseMs = requirePositiveSafeInteger(
      options.nonceReleaseAttemptLeaseMs ?? 30_000,
      "Challenge nonce-release attempt lease"
    )
    this.nonceReleaseOwner = requireBoundedText(
      options.nonceReleaseOwner ?? "p2tr-outbox-dispatcher",
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_LEASE_OWNER_LENGTH,
      "Challenge nonce-release owner"
    )
    this.onRecoveryBacklog = options.onRecoveryBacklog
    this.now = options.now ?? Date.now
    this.preparers = validateSignerLanes(
      Array.isArray(preparer) ? preparer : [preparer]
    )
    validateIndependentTransport(
      broadcaster,
      preBroadcastRechecker,
      cancellationEvidenceVerifier,
      reconciler,
      canonicalResolutionEvidenceVerifier
    )
  }

  async prepare(
    recordID: Hex | Buffer | string,
    leaseOwner: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    this.store.assertExternalIOTransactionBoundary()
    const normalizedLeaseOwner = requireBoundedText(
      leaseOwner,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_LEASE_OWNER_LENGTH,
      "Challenge outbox preparation lease owner"
    )

    const key = normalizeBytes32(recordID, "Challenge outbox record ID")
    const current = await this.requireRecord(key)
    if (current.status === "preparing") {
      if (
        current.preparationLease !== undefined &&
        current.preparationLease.expiresAtUnixMs > this.now()
      ) {
        return current
      }
      const recovered = await this.recoverExpiredPreparation(current)
      if (recovered.status !== "queued") {
        return recovered
      }
      return this.prepare(recordID, leaseOwner)
    }
    if (current.status !== "queued") {
      return current
    }
    await this.assertVoidedReservationCapacity(current)
    // No lane is selected yet -- that happens in the candidate loop below -- so
    // there is nothing to judge here, only recovery to drive. There is
    // deliberately no per-candidate wedge check: a lane wedged by an orphan is
    // already held by that orphan under the unique (chain, sender) lane slot,
    // so its swap fails and the loop moves on, and a lane wedged by an
    // unacknowledged release or a quarantine is refused by the durable lane
    // gate in the same swap. The lane that is actually chosen is asserted at
    // the irreversible boundary, which is the refusal that matters.
    await this.driveRecoverySweeps()

    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox preparation time"
    )
    const leaseExpiresAtUnixMs = requireSafeIntegerSum(
      nowUnixMs,
      this.preparationLeaseMs,
      "Challenge outbox preparation lease expiration"
    )
    const claimed = nextRecord(current, {
      status: "preparing",
      preparationAttempts: current.preparationAttempts + 1,
      preparationLease: {
        owner: normalizedLeaseOwner,
        expiresAtUnixMs: leaseExpiresAtUnixMs,
      },
      updatedAtUnixMs: nowUnixMs,
      lastError: undefined,
    })
    if (
      !(await this.store.compareAndSwapWithCurrentCanonicalProvenance(
        key,
        current.version,
        current.canonicalProvenance,
        claimed
      ))
    ) {
      return this.requireRecord(key)
    }

    const preSignRecheck = await this.recheckIrreversibleAction(
      claimed,
      "before-sign"
    )
    if (preSignRecheck.status !== "eligible") {
      return this.applyPreSignRecheckFailure(claimed, preSignRecheck)
    }

    let laneClaim = claimed
    let selectedPreparer:
      | P2TRSignatureFraudChallengeTransactionPreparer
      | undefined
    let selectedFeePolicy:
      | P2TRSignatureFraudChallengeTransactionFeePolicy
      | undefined
    validateConfiguredSignerFeePolicies(laneClaim, this.preparers)
    for (const candidate of this.preparers) {
      const signerIdentity = requireBoundedText(
        candidate.signerIdentity,
        P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
        "Challenge signer identity"
      )
      if (
        await this.store.isSignerQuarantined(
          laneClaim.intent.chainID,
          signerIdentity
        )
      ) {
        continue
      }
      if (
        await this.hasRecoveryBacklogForLane(
          laneClaim.intent.chainID,
          candidate.transactionSender
        )
      ) {
        continue
      }
      const selectedAt = requireUnixMilliseconds(
        this.now(),
        "Challenge signer lane selection time"
      )
      const selected = nextRecord(laneClaim, {
        preparationSender: normalizeAddress(
          candidate.transactionSender,
          "Challenge transaction preparer sender"
        ),
        selectedLaneID: requireBoundedText(
          candidate.laneID,
          P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
          "Challenge signer lane ID"
        ),
        selectedSignerIdentity: signerIdentity,
        updatedAtUnixMs: selectedAt,
        lastError: undefined,
      })
      if (await this.store.compareAndSwap(key, laneClaim.version, selected)) {
        laneClaim = selected
        selectedPreparer = candidate
        selectedFeePolicy = feePolicyForPreparer(laneClaim, candidate)
        break
      }
      const durable = await this.requireRecord(key)
      if (
        durable.version !== laneClaim.version ||
        durable.status !== "preparing"
      ) {
        return durable
      }
    }

    if (selectedPreparer === undefined || selectedFeePolicy === undefined) {
      const unavailable = nextRecord(laneClaim, {
        status: "queued",
        preparationLease: undefined,
        preparationSender: undefined,
        selectedLaneID: undefined,
        selectedSignerIdentity: undefined,
        updatedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Challenge signer lane unavailable time"
        ),
        lastError: "No healthy durable signer lane is currently available",
      })
      await this.store.compareAndSwap(key, laneClaim.version, unavailable)
      return this.requireRecord(key)
    }

    await this.assertSelectedLaneRecoveryBarrier(laneClaim)

    let unvalidatedReservation: P2TRSignatureFraudBoundNonceReservation
    try {
      unvalidatedReservation =
        await selectedPreparer.reserveSignatureFraudChallengeNonce(
          laneClaim.intent,
          Hex.from(laneClaim.recordID),
          laneClaim.generation,
          laneClaim.preparationAttempts
        )
    } catch (error) {
      // A transport error can occur after the allocator durably reserved a
      // nonce. Retain the exact lane/epoch and let lease recovery retry that
      // idempotency key; clearing the claim would leak allocator capacity.
      const ambiguous = nextRecord(laneClaim, {
        updatedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Ambiguous nonce reservation response time"
        ),
        lastError: requireReason(
          `Nonce reservation response is ambiguous and will be recovered with the same epoch: ${errorMessage(
            error
          )}`,
          "Ambiguous nonce reservation response"
        ),
      })
      await this.store.compareAndSwap(key, laneClaim.version, ambiguous)
      return this.requireRecord(key)
    }

    let reservation: P2TRSignatureFraudBoundNonceReservation
    try {
      reservation = validateP2TRSignatureFraudBoundNonceReservation(
        laneClaim.intent,
        Hex.from(laneClaim.recordID),
        laneClaim.generation,
        laneClaim.preparationAttempts,
        selectedPreparer,
        unvalidatedReservation
      )
    } catch (error) {
      const failed = this.signerFailureRecord(
        laneClaim,
        selectedPreparer,
        errorMessage(error),
        false,
        undefined,
        "reservation-binding-mismatch"
      )
      await this.store.compareAndSwap(key, laneClaim.version, failed)
      return this.requireRecord(key)
    }

    const reservedAt = requireUnixMilliseconds(
      this.now(),
      "Challenge nonce reservation time"
    )
    const reserved = nextRecord(laneClaim, {
      reservedNonce: reservation,
      nonceReservedAtUnixMs: reservedAt,
      updatedAtUnixMs: reservedAt,
      lastError: undefined,
    })
    let reservationPersisted: boolean
    try {
      reservationPersisted = await this.store.compareAndSwap(
        key,
        laneClaim.version,
        reserved
      )
    } catch {
      // Constraint/quarantine races roll their transaction back. The
      // authenticated provider response still needs the same durable
      // adoption-or-tombstone treatment as a false CAS.
      reservationPersisted = false
    }
    if (!reservationPersisted) {
      return this.reconcileReturnedReservationAfterLostClaim(
        key,
        reservation,
        selectedPreparer
      )
    }

    const signerBoundaryTime = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox signer invocation time"
    )
    await this.assertRecoveryBarrier({
      chainID: reserved.intent.chainID,
      sender: reservation.sender,
    })
    // Built from the record that is about to be committed: `nextRecord` already
    // carries the post-swap version, and the binding reads no signer marker, so
    // the invocation identity is derivable here and lands in the same swap that
    // sets the marker. Building before the swap also means a failure strands
    // nothing — there is no durable marker yet to pin the activation barrier.
    const pendingBoundary = nextRecord(reserved, {
      activeSignerInvocationStartedAtUnixMs: signerBoundaryTime,
      lastPreBroadcastRecheckAtUnixMs: signerBoundaryTime,
      lastPreBroadcastRecheckStatus: "eligible",
      updatedAtUnixMs: signerBoundaryTime,
      lastError: undefined,
    })
    let signerAuthorizationBinding: P2TRSignatureFraudIrreversibleBoundaryBinding
    try {
      signerAuthorizationBinding = this.buildIrreversibleBoundaryBinding(
        pendingBoundary,
        "prepare",
        pendingBoundary.preparationAttempts,
        selectedFeePolicy
      )
    } catch (error) {
      return this.abandonUnboundPreparationClaim(
        reserved,
        `Initial signer authorization failed: ${errorMessage(error)}`
      )
    }
    const signerInvocation = computeP2TRSignatureFraudSignerInvocationRequest(
      signerAuthorizationBinding
    )
    const signerBoundary: P2TRSignatureFraudChallengeOutboxRecord = {
      ...pendingBoundary,
      activeSignerInvocationID: signerInvocation.invocationID,
    }
    try {
      if (
        !(await this.store.compareAndSwapWithCurrentCanonicalProvenance(
          key,
          reserved.version,
          reserved.canonicalProvenance,
          signerBoundary
        ))
      ) {
        return this.requireRecord(key)
      }
    } catch (error) {
      if (
        !this.store.isP2TRSignatureFraudWatchtowerPersistenceRetryable(error)
      ) {
        throw error
      }
      return this.reconcileUninvokedSignerBoundaryPersistence(
        reserved,
        signerBoundary,
        `Initial signer-boundary persistence was ambiguous before signer I/O: ${errorMessage(
          error
        )}`
      )
    }

    let signerAuthorization: P2TRSignatureFraudIrreversibleBoundaryAuthorization
    try {
      signerAuthorization =
        await this.irreversibleBoundaryAuthorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
          signerAuthorizationBinding
        )
    } catch (error) {
      return this.completeUninvokedSignerBoundary(
        signerBoundary,
        `Initial signer authorization failed: ${errorMessage(error)}`
      )
    }
    try {
      // Consumption is synchronous and is followed by the signer call without
      // another await or durable-state read.
      this.irreversibleBoundaryAuthorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
        signerAuthorization,
        signerAuthorizationBinding,
        requireUnixMilliseconds(
          this.now(),
          "Initial signer authorization consumption time"
        )
      )
    } catch (error) {
      return this.completeUninvokedSignerBoundary(
        signerBoundary,
        `Initial signer authorization was rejected: ${errorMessage(error)}`
      )
    }

    let prepared: P2TRSignatureFraudPreparedChallengeTransaction
    let escaped: P2TRSignatureFraudPreparedChallengeTransaction | undefined
    let candidate: P2TRSignatureFraudPreparedChallengeTransactionResponse
    try {
      // Invoking a signer is the irreversible nonce boundary. Even if the
      // call later throws, signed bytes may have escaped a remote signer.
      candidate =
        await selectedPreparer.prepareSignatureFraudChallengeTransaction(
          signerBoundary.intent,
          reservation,
          selectedFeePolicy,
          signerInvocationRequest(signerInvocation)
        )
    } catch (error) {
      const failed = this.signerFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        true,
        undefined,
        "ambiguous-signer-invocation"
      )
      if (
        !(await this.compareAndSwapSignerCompletion(signerBoundary, failed))
      ) {
        return this.completeSignerFailureAfterLostCas(
          signerBoundary,
          selectedPreparer,
          errorMessage(error),
          "ambiguous-signer-invocation"
        )
      }
      return this.requireRecord(key)
    }
    try {
      escaped = {
        intentID: signerBoundary.intent.intentID,
        ...recoverP2TRSignatureFraudSignedTransactionEnvelope(
          candidate.rawTransaction
        ),
        invocation: candidate.invocation,
      }
    } catch (error) {
      const failed = this.signerFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        true,
        undefined,
        "malformed-signed-envelope"
      )
      if (
        !(await this.compareAndSwapSignerCompletion(signerBoundary, failed))
      ) {
        return this.completeSignerFailureAfterLostCas(
          signerBoundary,
          selectedPreparer,
          errorMessage(error),
          "malformed-signed-envelope"
        )
      }
      return this.requireRecord(key)
    }
    const echoMismatch = signerInvocationEchoMismatch(escaped, signerInvocation)
    if (echoMismatch !== undefined) {
      return this.completeWrongInvocationRequest(
        signerBoundary,
        selectedPreparer,
        escaped,
        echoMismatch
      )
    }
    try {
      validateP2TRSignatureFraudSignerResponseBinding(
        candidate,
        signerInvocation.requestDigest,
        signerInvocation.invocationID,
        escaped.transactionHash,
        reservation.sender
      )
    } catch (error) {
      const failed = this.signerCorrelationFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        escaped
      )
      if (
        !(await this.compareAndSwapSignerCompletion(signerBoundary, failed))
      ) {
        return this.captureEscapedArtifactAfterLostCas(
          signerBoundary,
          escaped,
          `Uncorrelated initial signer response returned after a concurrent outbox transition: ${errorMessage(
            error
          )}`,
          requireLatestSignerQuarantine(failed)
        )
      }
      return this.requireRecord(key)
    }
    try {
      validateP2TRSignatureFraudPreparedChallengeTransaction(
        signerBoundary.intent,
        candidate
      )
      prepared =
        validateP2TRSignatureFraudPreparedChallengeTransactionReservation(
          signerBoundary.intent,
          reservation,
          escaped
        )
      prepared = validatePreparedTransactionFeePolicy(
        signerBoundary.intent,
        selectedFeePolicy,
        prepared
      )
    } catch (error) {
      const failed = this.signerFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        true,
        escaped,
        classifyReservationMismatch(
          signerBoundary.intent.chainID,
          reservation,
          escaped
        )
      )
      if (
        !(await this.compareAndSwapSignerCompletion(signerBoundary, failed))
      ) {
        return this.captureEscapedArtifactAfterLostCas(
          signerBoundary,
          escaped,
          `Invalid initial signed envelope returned after a concurrent outbox transition: ${errorMessage(
            error
          )}`,
          requireLatestSignerQuarantine(failed)
        )
      }
      return this.requireRecord(key)
    }

    const persisted = nextRecord(signerBoundary, {
      status: "prepared",
      preparedTransaction: prepared,
      preparedTransactionVariants: [
        {
          sequence: 0,
          preparedTransaction: prepared,
          signedAtUnixMs: signerBoundaryTime,
          broadcastAttempts: 0,
        },
      ],
      preparationLease: undefined,
      activeSignerInvocationStartedAtUnixMs: undefined,
      activeSignerInvocationID: undefined,
      signerInvocationStartedAtUnixMs:
        signerBoundary.signerInvocationStartedAtUnixMs ?? signerBoundaryTime,
      signerInvocationID:
        signerBoundary.signerInvocationID ??
        signerBoundary.activeSignerInvocationID,
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox prepared time"
      ),
      lastError: undefined,
    })
    if (
      !(await this.compareAndSwapSignerCompletion(signerBoundary, persisted))
    ) {
      // The signer boundary remains durable and retains the sender lane even
      // if the prepared bytes could not be committed.
      return this.captureEscapedArtifactAfterLostCas(
        signerBoundary,
        prepared,
        "Initial signed bytes returned after a concurrent outbox transition"
      )
    }
    return persisted
  }

  async prepareReplacement(
    recordID: Hex | Buffer | string,
    leaseOwner: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    this.store.assertExternalIOTransactionBoundary()
    const normalizedLeaseOwner = requireBoundedText(
      leaseOwner,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_LEASE_OWNER_LENGTH,
      "Challenge outbox replacement lease owner"
    )
    const key = normalizeBytes32(recordID, "Challenge outbox record ID")
    const current = await this.requireRecord(key)
    if (current.status === "preparing") {
      if (current.preparationResumeStatus === undefined) return current
      if (
        current.preparationLease !== undefined &&
        current.preparationLease.expiresAtUnixMs > this.now()
      ) {
        return current
      }
      const recovered = await this.recoverExpiredPreparation(current)
      if (
        recovered.status !== "prepared" &&
        recovered.status !== "broadcast-pending"
      ) {
        return recovered
      }
      return this.prepareReplacement(recordID, leaseOwner)
    }
    if (
      current.status !== "prepared" &&
      current.status !== "broadcast-pending"
    ) {
      return current
    }

    let variants: readonly P2TRSignatureFraudPreparedTransactionVariant[]
    try {
      variants = validatePreparedTransactionVariantLedger(current)
    } catch (error) {
      return this.quarantine(current, errorMessage(error))
    }
    if (current.reservedNonce === undefined) {
      return this.quarantine(
        current,
        "Challenge replacement record lacks its authenticated nonce reservation"
      )
    }
    // Captured once: the lane cannot change under a replacement, and both the
    // entry assert and the boundary assert below must name the same one.
    const replacementReservation = current.reservedNonce
    const selectedPreparer = this.preparerForReservation(replacementReservation)
    if (
      selectedPreparer === undefined ||
      (await this.store.isSignerQuarantined(
        current.intent.chainID,
        replacementReservation.signerIdentity
      ))
    ) {
      return this.quarantine(
        current,
        "Challenge replacement signer lane is unavailable or quarantined"
      )
    }
    // Asserted here rather than at entry: the replacement's lane is only known
    // once its reservation and preparer have been resolved just above.
    await this.assertRecoveryBarrier({
      chainID: current.intent.chainID,
      sender: replacementReservation.sender,
    })
    const selectedFeePolicy = feePolicyForPreparer(current, selectedPreparer)
    await this.assertSelectedLaneRecoveryBarrier(current)
    if (variants.length >= P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_SIGNED_VARIANTS) {
      await this.store.saveCriticalAlert({
        code: "signed-variant-cap-exhausted",
        seriesID: current.seriesID,
        recordID: current.recordID,
        generation: current.generation,
        activationBlocking: true,
        createdAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Challenge signed-variant-cap alert time"
        ),
        detail:
          "The nonce remains unresolved after the bounded EIP-1559 replacement limit; manual multi-sender recovery is required",
      })
      return this.quarantine(
        current,
        "Challenge outbox reached the bounded signed-variant limit and persisted an activation-blocking alert"
      )
    }
    const previous = variants[variants.length - 1].preparedTransaction
    const replacementFeeInfeasibility = replacementFeePolicyInfeasibility(
      previous,
      selectedFeePolicy
    )
    if (replacementFeeInfeasibility !== undefined) {
      const rejectedAtUnixMs = requireUnixMilliseconds(
        this.now(),
        "Challenge outbox infeasible replacement time"
      )
      const rejected = nextRecord(current, {
        updatedAtUnixMs: rejectedAtUnixMs,
        lastError: replacementFeeInfeasibility,
      })
      if (
        !(await this.store.compareAndSwapWithCurrentCanonicalProvenance(
          key,
          current.version,
          current.canonicalProvenance,
          rejected
        ))
      ) {
        return this.requireRecord(key)
      }
      return rejected
    }
    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox replacement preparation time"
    )
    const leaseExpiresAtUnixMs = requireSafeIntegerSum(
      nowUnixMs,
      this.preparationLeaseMs,
      "Challenge outbox replacement lease expiration"
    )
    const claimed = nextRecord(current, {
      status: "preparing",
      preparationAttempts: current.preparationAttempts + 1,
      preparationResumeStatus: current.status,
      preparationLease: {
        owner: normalizedLeaseOwner,
        expiresAtUnixMs: leaseExpiresAtUnixMs,
      },
      activeSignerInvocationStartedAtUnixMs: undefined,
      activeSignerInvocationID: undefined,
      updatedAtUnixMs: nowUnixMs,
      lastError: undefined,
    })
    if (
      !(await this.store.compareAndSwapWithCurrentCanonicalProvenance(
        key,
        current.version,
        current.canonicalProvenance,
        claimed
      ))
    ) {
      return this.requireRecord(key)
    }

    const preSignRecheck = await this.recheckIrreversibleAction(
      claimed,
      "before-sign"
    )
    if (preSignRecheck.status !== "eligible") {
      const recheckTime = requireUnixMilliseconds(
        this.now(),
        "Challenge outbox replacement pre-sign recheck time"
      )
      const notSigned = nextRecord(claimed, {
        status: current.status,
        preparationLease: undefined,
        preparationResumeStatus: undefined,
        activeSignerInvocationStartedAtUnixMs: undefined,
        activeSignerInvocationID: undefined,
        lastPreBroadcastRecheckAtUnixMs: recheckTime,
        lastPreBroadcastRecheckStatus: preSignRecheck.status,
        updatedAtUnixMs: recheckTime,
        lastError: requireReason(
          preSignRecheck.reason,
          "Challenge outbox replacement pre-sign recheck reason"
        ),
      })
      await this.store.compareAndSwap(key, claimed.version, notSigned)
      return this.requireRecord(key)
    }

    const signerBoundaryTime = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox replacement signer invocation time"
    )
    await this.assertRecoveryBarrier({
      chainID: claimed.intent.chainID,
      sender: replacementReservation.sender,
    })
    // As at the initial boundary: build first, so the identity is committed in
    // the same swap as the marker and a build failure leaves nothing durable.
    const pendingBoundary = nextRecord(claimed, {
      activeSignerInvocationStartedAtUnixMs: signerBoundaryTime,
      lastPreBroadcastRecheckAtUnixMs: signerBoundaryTime,
      lastPreBroadcastRecheckStatus: "eligible",
      updatedAtUnixMs: signerBoundaryTime,
      lastError: undefined,
    })
    let signerAuthorizationBinding: P2TRSignatureFraudIrreversibleBoundaryBinding
    try {
      signerAuthorizationBinding = this.buildIrreversibleBoundaryBinding(
        pendingBoundary,
        "replacement",
        pendingBoundary.preparationAttempts,
        selectedFeePolicy,
        previous.transactionHash
      )
    } catch (error) {
      return this.abandonUnboundPreparationClaim(
        claimed,
        `Replacement signer authorization failed: ${errorMessage(error)}`
      )
    }
    const signerInvocation = computeP2TRSignatureFraudSignerInvocationRequest(
      signerAuthorizationBinding
    )
    const signerBoundary: P2TRSignatureFraudChallengeOutboxRecord = {
      ...pendingBoundary,
      activeSignerInvocationID: signerInvocation.invocationID,
    }
    try {
      if (
        !(await this.store.compareAndSwapWithCurrentCanonicalProvenance(
          key,
          claimed.version,
          claimed.canonicalProvenance,
          signerBoundary
        ))
      ) {
        return this.requireRecord(key)
      }
    } catch (error) {
      if (
        !this.store.isP2TRSignatureFraudWatchtowerPersistenceRetryable(error)
      ) {
        throw error
      }
      return this.reconcileUninvokedSignerBoundaryPersistence(
        claimed,
        signerBoundary,
        `Replacement signer-boundary persistence was ambiguous before signer I/O: ${errorMessage(
          error
        )}`
      )
    }

    let signerAuthorization: P2TRSignatureFraudIrreversibleBoundaryAuthorization
    try {
      signerAuthorization =
        await this.irreversibleBoundaryAuthorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
          signerAuthorizationBinding
        )
    } catch (error) {
      return this.completeUninvokedSignerBoundary(
        signerBoundary,
        `Replacement signer authorization failed: ${errorMessage(error)}`
      )
    }
    try {
      this.irreversibleBoundaryAuthorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
        signerAuthorization,
        signerAuthorizationBinding,
        requireUnixMilliseconds(
          this.now(),
          "Replacement signer authorization consumption time"
        )
      )
    } catch (error) {
      return this.completeUninvokedSignerBoundary(
        signerBoundary,
        `Replacement signer authorization was rejected: ${errorMessage(error)}`
      )
    }

    let replacement: P2TRSignatureFraudPreparedChallengeTransaction
    let escaped: P2TRSignatureFraudPreparedChallengeTransaction | undefined
    let candidate: P2TRSignatureFraudPreparedChallengeTransactionResponse
    try {
      candidate =
        await selectedPreparer.prepareSignatureFraudChallengeReplacementTransaction(
          signerBoundary.intent,
          current.reservedNonce,
          previous,
          selectedFeePolicy,
          signerInvocationRequest(signerInvocation)
        )
    } catch (error) {
      const failed = this.signerFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        true,
        undefined,
        "ambiguous-signer-invocation"
      )
      if (
        !(await this.compareAndSwapSignerCompletion(signerBoundary, failed))
      ) {
        return this.completeSignerFailureAfterLostCas(
          signerBoundary,
          selectedPreparer,
          errorMessage(error),
          "ambiguous-signer-invocation"
        )
      }
      return this.requireRecord(key)
    }
    try {
      escaped = {
        intentID: signerBoundary.intent.intentID,
        ...recoverP2TRSignatureFraudSignedTransactionEnvelope(
          candidate.rawTransaction
        ),
        invocation: candidate.invocation,
      }
    } catch (error) {
      const failed = this.signerFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        true,
        undefined,
        "malformed-signed-envelope"
      )
      if (
        !(await this.compareAndSwapSignerCompletion(signerBoundary, failed))
      ) {
        return this.completeSignerFailureAfterLostCas(
          signerBoundary,
          selectedPreparer,
          errorMessage(error),
          "malformed-signed-envelope"
        )
      }
      return this.requireRecord(key)
    }
    const echoMismatch = signerInvocationEchoMismatch(escaped, signerInvocation)
    if (echoMismatch !== undefined) {
      return this.completeWrongInvocationRequest(
        signerBoundary,
        selectedPreparer,
        escaped,
        echoMismatch
      )
    }
    try {
      validateP2TRSignatureFraudSignerResponseBinding(
        candidate,
        signerInvocation.requestDigest,
        signerInvocation.invocationID,
        escaped.transactionHash,
        current.reservedNonce.sender
      )
    } catch (error) {
      const failed = this.signerCorrelationFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        escaped
      )
      if (
        !(await this.compareAndSwapSignerCompletion(signerBoundary, failed))
      ) {
        return this.captureEscapedArtifactAfterLostCas(
          signerBoundary,
          escaped,
          `Uncorrelated replacement signer response returned after a concurrent outbox transition: ${errorMessage(
            error
          )}`,
          requireLatestSignerQuarantine(failed)
        )
      }
      return this.requireRecord(key)
    }
    try {
      validateP2TRSignatureFraudPreparedChallengeTransaction(
        signerBoundary.intent,
        candidate
      )
      replacement =
        validateP2TRSignatureFraudPreparedChallengeReplacementTransaction(
          signerBoundary.intent,
          previous,
          escaped,
          selectedFeePolicy.minimumReplacementFeeBumpBps
        )
      replacement =
        validateP2TRSignatureFraudPreparedChallengeTransactionReservation(
          signerBoundary.intent,
          current.reservedNonce,
          replacement
        )
      replacement = validatePreparedTransactionFeePolicy(
        signerBoundary.intent,
        selectedFeePolicy,
        replacement
      )
      if (
        variants.some(
          ({ preparedTransaction }) =>
            normalizeBytes32(
              preparedTransaction.transactionHash,
              "Persisted challenge transaction hash"
            ) ===
            normalizeBytes32(
              replacement.transactionHash,
              "Prepared challenge replacement hash"
            )
        )
      ) {
        throw new Error(
          "Prepared challenge replacement duplicates a persisted signed variant"
        )
      }
    } catch (error) {
      const failed = this.signerFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        true,
        escaped,
        classifyReplacementSignerFailure(
          signerBoundary.intent.chainID,
          current.reservedNonce,
          previous,
          escaped
        )
      )
      if (
        !(await this.compareAndSwapSignerCompletion(signerBoundary, failed))
      ) {
        return this.captureEscapedArtifactAfterLostCas(
          signerBoundary,
          escaped,
          `Invalid replacement signed envelope returned after a concurrent outbox transition: ${errorMessage(
            error
          )}`,
          requireLatestSignerQuarantine(failed)
        )
      }
      return this.requireRecord(key)
    }

    const persisted = nextRecord(signerBoundary, {
      status: current.status,
      preparedTransaction: replacement,
      preparedTransactionVariants: [
        ...variants,
        {
          sequence: variants.length,
          preparedTransaction: replacement,
          signedAtUnixMs: signerBoundaryTime,
          broadcastAttempts: 0,
        },
      ],
      preparationLease: undefined,
      preparationResumeStatus: undefined,
      activeSignerInvocationStartedAtUnixMs: undefined,
      activeSignerInvocationID: undefined,
      signerInvocationStartedAtUnixMs:
        signerBoundary.signerInvocationStartedAtUnixMs ?? signerBoundaryTime,
      signerInvocationID:
        signerBoundary.signerInvocationID ??
        signerBoundary.activeSignerInvocationID,
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox replacement prepared time"
      ),
      lastError: undefined,
    })
    if (
      !(await this.compareAndSwapSignerCompletion(signerBoundary, persisted))
    ) {
      return this.captureEscapedArtifactAfterLostCas(
        signerBoundary,
        replacement,
        "Replacement signed bytes returned after a concurrent outbox transition"
      )
    }
    return persisted
  }

  async recoverExpiredPreparationLeases(
    cursor?: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecoveryReport> {
    this.store.assertExternalIOTransactionBoundary()
    const normalizedCursor = optionalBoundedText(
      cursor,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_CURSOR_LENGTH,
      "Challenge outbox recovery cursor"
    )
    const page = await this.store.listPage({
      statuses: ["preparing"],
      limit: this.recoveryPageSize,
      cursor: normalizedCursor,
    })
    validateOutboxPage(page, this.recoveryPageSize)
    let recovered = 0
    for (const record of page.records) {
      const result = await this.recoverExpiredPreparation(record)
      if (result.status !== "preparing") {
        recovered++
      }
    }
    const expiredRemain = await this.store.hasExpiredPreparationLeases(
      requireUnixMilliseconds(this.now(), "Challenge recovery barrier time")
    )
    const report: P2TRSignatureFraudChallengeOutboxRecoveryReport = {
      scanned: page.records.length,
      recovered,
      nextCursor: page.nextCursor,
      backlogRemaining: page.nextCursor !== undefined || expiredRemain,
    }
    this.recoveryBarrierEstablished =
      !report.backlogRemaining && !(await this.store.hasPendingNonceReleases())
    if (report.backlogRemaining) {
      await this.onRecoveryBacklog?.(report)
    }
    return report
  }

  async recoverPendingNonceReleases(
    cursor?: string
  ): Promise<P2TRSignatureFraudNonceReleaseRecoveryReport> {
    this.store.assertExternalIOTransactionBoundary()
    const normalizedCursor = optionalBoundedText(
      cursor,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_CURSOR_LENGTH,
      "Challenge nonce-release recovery cursor"
    )
    const page = await this.store.listPendingNonceReleases({
      limit: this.recoveryPageSize,
      cursor: normalizedCursor,
    })
    let attempted = 0
    let acknowledged = 0
    let ambiguous = 0
    for (const request of page.requests) {
      const result = await this.attemptNonceRelease(request)
      if (result === "skipped") continue
      attempted++
      if (result === "acknowledged") acknowledged++
      else ambiguous++
    }
    const pendingRemain = await this.store.hasPendingNonceReleases()
    const report: P2TRSignatureFraudNonceReleaseRecoveryReport = {
      scanned: page.requests.length,
      attempted,
      acknowledged,
      ambiguous,
      nextCursor: page.nextCursor,
      backlogRemaining: page.nextCursor !== undefined || pendingRemain,
    }
    this.recoveryBarrierEstablished =
      !report.backlogRemaining &&
      !(await this.store.hasExpiredPreparationLeases(
        requireUnixMilliseconds(this.now(), "Challenge recovery barrier time")
      ))
    return report
  }

  async broadcast(
    recordID: Hex | Buffer | string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    this.store.assertExternalIOTransactionBoundary()
    const key = normalizeBytes32(recordID, "Challenge outbox record ID")
    const current = await this.requireRecord(key)
    if (
      current.status !== "prepared" &&
      current.status !== "broadcast-pending" &&
      current.status !== "external-satisfied-awaiting-own-transaction"
    ) {
      return current
    }
    let variants: readonly P2TRSignatureFraudPreparedTransactionVariant[]
    let broadcastFeePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy
    try {
      variants = validatePreparedTransactionVariantLedger(current)
      // The same envelope the ledger validator just enforced against every
      // persisted variant, including the exact bytes about to be sent. No
      // signer is invoked here, so there is no other envelope to name.
      broadcastFeePolicy = feePolicyForReservation(
        current,
        requireReservedNonce(current, "Challenge outbox broadcast")
      )
    } catch (error) {
      return this.quarantine(current, errorMessage(error))
    }
    const latestVariant = variants[variants.length - 1]
    const preparedTransaction = latestVariant.preparedTransaction

    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox broadcast time"
    )
    const lastAuthorizationFailureAtUnixMs =
      current.lastBroadcastAuthorizationFailureAtUnixMs === undefined
        ? -1
        : requireUnixMilliseconds(
            current.lastBroadcastAuthorizationFailureAtUnixMs,
            "Challenge outbox last broadcast authorization failure time"
          )
    const lastRecheckFailureAtUnixMs =
      current.lastPreBroadcastRecheckStatus === undefined ||
      current.lastPreBroadcastRecheckStatus === "eligible" ||
      current.lastPreBroadcastRecheckAtUnixMs === undefined
        ? -1
        : requireUnixMilliseconds(
            current.lastPreBroadcastRecheckAtUnixMs,
            "Challenge outbox last failed pre-broadcast recheck time"
          )
    const lastPacingBoundaryUnixMs = Math.max(
      latestVariant.lastBroadcastAtUnixMs ?? -1,
      lastAuthorizationFailureAtUnixMs,
      lastRecheckFailureAtUnixMs
    )
    if (
      lastPacingBoundaryUnixMs >= 0 &&
      nowUnixMs - lastPacingBoundaryUnixMs < this.minimumRebroadcastIntervalMs
    ) {
      return current
    }

    if (current.status !== "external-satisfied-awaiting-own-transaction") {
      const rechecked = await this.recheckIrreversibleAction(
        current,
        "before-broadcast"
      )
      if (rechecked.status !== "eligible") {
        return this.applyPreBroadcastRecheckFailure(current, rechecked)
      }
    }

    // Project the exact durable attempt before acquiring its one-use boundary
    // authorization. Authorization/provider failures are still pre-send and
    // therefore must not create a broadcast-attempt ledger entry.
    const attempted = nextRecord(current, {
      // Once an external challenge is final, broadcasting the already-signed
      // exact bytes is a nonce-disposition action. Keep the external-awaiting
      // marker and never require the now-false "challenge absent" predicate.
      status:
        current.status === "external-satisfied-awaiting-own-transaction"
          ? current.status
          : "broadcast-pending",
      broadcastAttempts: current.broadcastAttempts + 1,
      preparedTransactionVariants: replaceLatestPreparedVariant(variants, {
        ...latestVariant,
        broadcastAttempts: latestVariant.broadcastAttempts + 1,
        lastBroadcastAtUnixMs: nowUnixMs,
        lastBroadcastProviderAccepted: undefined,
        lastError: undefined,
      }),
      lastPreBroadcastRecheckAtUnixMs: nowUnixMs,
      lastPreBroadcastRecheckStatus: "eligible",
      lastBroadcastAuthorizationFailureAtUnixMs: undefined,
      lastBroadcastAtUnixMs: nowUnixMs,
      lastBroadcastProviderAccepted: undefined,
      updatedAtUnixMs: nowUnixMs,
      lastError: undefined,
    })
    const broadcastAuthorizationBinding = this.buildIrreversibleBoundaryBinding(
      attempted,
      "broadcast",
      attempted.broadcastAttempts,
      broadcastFeePolicy,
      preparedTransaction.transactionHash
    )
    let broadcastAuthorization: P2TRSignatureFraudIrreversibleBoundaryAuthorization
    try {
      broadcastAuthorization =
        await this.irreversibleBoundaryAuthorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
          broadcastAuthorizationBinding
        )
    } catch (error) {
      return this.applyPreBroadcastAuthorizationFailure(
        current,
        `Broadcast authorization failed before send: ${errorMessage(error)}`
      )
    }
    // Persist the irreversible-attempt boundary before the external call. A
    // crash from this point onward can only cause the exact same raw bytes to
    // be sent again.
    if (
      !(await this.store.compareAndSwapWithCurrentCanonicalProvenance(
        key,
        current.version,
        current.canonicalProvenance,
        attempted
      ))
    ) {
      return this.requireRecord(key)
    }

    try {
      const broadcastAuthorizationBinding =
        this.buildIrreversibleBoundaryBinding(
          attempted,
          "broadcast",
          attempted.broadcastAttempts,
          broadcastFeePolicy,
          preparedTransaction.transactionHash
        )
      const broadcastAuthorization =
        await this.irreversibleBoundaryAuthorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
          broadcastAuthorizationBinding
        )
      // This synchronous one-use check is intentionally the final operation
      // before invoking the broadcaster with the exact persisted bytes.
      this.irreversibleBoundaryAuthorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
        broadcastAuthorization,
        broadcastAuthorizationBinding,
        requireUnixMilliseconds(
          this.now(),
          "Broadcast authorization consumption time"
        )
      )
    } catch (error) {
      return this.applyPreBroadcastAuthorizationFailure(
        attempted,
        `Broadcast authorization was rejected before send: ${errorMessage(
          error
        )}`,
        true
      )
    }

    try {
      // A canonical rollback can win immediately after this durable send
      // boundary and before the provider call. No process-local check can
      // eliminate that external race. The store therefore treats an active
      // attempt as an escaped-send incident, retains the nonce lane, and moves
      // the generation to provenance reconciliation.
      const returnedHash = normalizeBytes32(
        await this.broadcaster.broadcastRawTransaction(
          preparedTransaction.rawTransaction
        ),
        "Broadcast challenge transaction hash"
      )
      const expectedHash = normalizeBytes32(
        preparedTransaction.transactionHash,
        "Prepared challenge transaction hash"
      )
      if (returnedHash !== expectedHash) {
        return this.quarantine(
          attempted,
          "Challenge broadcaster returned a hash that does not match the persisted raw transaction"
        )
      }

      const acknowledged = nextRecord(attempted, {
        preparedTransactionVariants: replaceLatestPreparedVariant(
          attempted.preparedTransactionVariants!,
          {
            ...attempted.preparedTransactionVariants![
              attempted.preparedTransactionVariants!.length - 1
            ],
            lastBroadcastProviderAccepted: true,
            lastError: undefined,
          }
        ),
        lastBroadcastProviderAccepted: true,
        updatedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Challenge outbox broadcast acknowledgement time"
        ),
        lastError: undefined,
      })
      await this.store.compareAndSwap(key, attempted.version, acknowledged)
    } catch (error) {
      const ambiguous = nextRecord(attempted, {
        preparedTransactionVariants: replaceLatestPreparedVariant(
          attempted.preparedTransactionVariants!,
          {
            ...attempted.preparedTransactionVariants![
              attempted.preparedTransactionVariants!.length - 1
            ],
            lastBroadcastProviderAccepted: undefined,
            lastError: errorMessage(error),
          }
        ),
        // The call may have reached the provider or network before failing.
        // Preserve the tri-state as unknown instead of recording rejection.
        lastBroadcastProviderAccepted: undefined,
        updatedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Challenge outbox ambiguous broadcast time"
        ),
        lastError: errorMessage(error),
      })
      await this.store.compareAndSwap(key, attempted.version, ambiguous)
    }

    return this.requireRecord(key)
  }

  async reconcile(
    recordID: Hex | Buffer | string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    this.store.assertExternalIOTransactionBoundary()
    const key = normalizeBytes32(recordID, "Challenge outbox record ID")
    const current = await this.requireRecord(key)
    if (
      current.status !== "prepared" &&
      current.status !== "broadcast-pending" &&
      current.status !== "external-satisfied-awaiting-own-transaction" &&
      current.status !== "provenance-invalidated-awaiting-reconciliation" &&
      !(current.status === "quarantined" && current.reservedNonce !== undefined)
    ) {
      return current
    }
    let variants: readonly P2TRSignatureFraudPreparedTransactionVariant[]
    try {
      variants =
        current.preparedTransactionVariants === undefined
          ? []
          : validatePreparedTransactionVariantLedger(current)
    } catch (error) {
      return this.quarantine(current, errorMessage(error))
    }

    let resolution: P2TRSignatureFraudChallengeOutboxResolution
    try {
      const context: P2TRSignatureFraudChallengeOutboxReconciliationContext = {
        recordID: current.recordID,
        generation: current.generation,
        outboxStatus: current.status,
        intent: current.intent,
        evidenceCheckpoint: current.evidenceCheckpoint,
        canonicalProvenance: current.canonicalProvenance,
        preparedTransactions: variants.map(
          ({ preparedTransaction }) => preparedTransaction
        ),
        reservedNonce: current.reservedNonce,
        unexpectedSignedArtifacts: current.unexpectedSignedArtifacts ?? [],
        broadcastAttempts: current.broadcastAttempts,
        reconciliationAttempts: current.reconciliationAttempts,
        lastBroadcastAtUnixMs: current.lastBroadcastAtUnixMs,
      }
      resolution = await this.reconciler.reconcileSignatureFraudChallengeOutbox(
        context
      )
      validateStructuredResolution(
        current,
        resolution,
        this.reconciler.finalityConfirmationBlocks,
        this.reconciler.canonicalSubmissionSelectors
      )
      if (resolution.status !== "pending" && resolution.status !== "unknown") {
        const verification =
          await this.canonicalResolutionEvidenceVerifier.verifySignatureFraudCanonicalResolutionEvidence(
            context,
            resolution
          )
        validateCanonicalResolutionEvidenceVerification(
          resolution,
          verification,
          this.reconciler,
          this.canonicalResolutionEvidenceVerifier
        )
      }
    } catch (error) {
      resolution = {
        status: "unknown",
        reason: errorMessage(
          `Challenge outbox reconciliation failed: ${errorMessage(error)}`
        ),
      }
    }

    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox reconciliation time"
    )
    const base = {
      reconciliationAttempts: current.reconciliationAttempts + 1,
      lastReconciliationAtUnixMs: nowUnixMs,
      lastResolutionStatus: resolution.status,
      updatedAtUnixMs: nowUnixMs,
    }

    let next: P2TRSignatureFraudChallengeOutboxRecord
    switch (resolution.status) {
      case "accepted-own":
      case "satisfied-external":
        next = nextRecord(current, {
          ...base,
          status: resolution.status,
          finalNonceResolution:
            resolution as P2TRSignatureFraudFinalNonceResolution,
          lastError: undefined,
        })
        break
      case "terminal-reverted":
      case "terminal-nonce-consumed":
        next = nextRecord(current, {
          ...base,
          status: "generation-required",
          finalNonceResolution: resolution,
          generationDisposition: resolution,
          lastError:
            "Canonical nonce disposition is final but the fraud evidence remains eligible; a fresh append-only nonce generation is required",
        })
        break
      case "external-satisfied-awaiting-own-transaction":
        next = nextRecord(current, {
          ...base,
          status: resolution.status,
          lastError:
            "External challenge is final; retaining the nonce lane until the prepared transaction is canonically resolved",
        })
        break
      case "pending":
      case "unknown":
        // Unknown is deliberately non-replayable: it never clears the prepared
        // transaction or permits a new transaction generation.
        next = nextRecord(current, {
          ...base,
          lastError: requireReason(
            resolution.reason,
            "Challenge reconciliation reason"
          ),
        })
        break
    }

    await this.store.compareAndSwap(key, current.version, next)
    return this.requireRecord(key)
  }

  async cancelBeforeBroadcast(
    recordID: Hex | Buffer | string,
    reason: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const key = normalizeBytes32(recordID, "Challenge outbox record ID")
    const current = await this.requireRecord(key)
    if (
      current.status !== "queued" ||
      current.selectedLaneID !== undefined ||
      current.selectedSignerIdentity !== undefined ||
      current.reservedNonce !== undefined ||
      current.signerInvocationStartedAtUnixMs !== undefined
    ) {
      throw new Error(
        "Challenge outbox transaction can be cancelled only before signer invocation"
      )
    }

    const cancelled = nextRecord(current, {
      status: "cancelled-before-broadcast",
      preparationLease: undefined,
      preparationSender: undefined,
      selectedLaneID: undefined,
      selectedSignerIdentity: undefined,
      reservedNonce: undefined,
      nonceReservedAtUnixMs: undefined,
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox cancellation time"
      ),
      lastError: requireReason(reason, "Challenge outbox cancellation reason"),
    })
    await this.store.compareAndSwap(key, current.version, cancelled)
    return this.requireRecord(key)
  }

  private async recoverExpiredPreparation(
    current: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    if (
      (current.status !== "preparing" &&
        !(
          current.status === "provenance-invalidated-awaiting-reconciliation" &&
          current.provenanceInvalidationEvidence !== undefined &&
          current.signerInvocationStartedAtUnixMs === undefined &&
          (current.preparedTransactionVariants?.length ?? 0) === 0
        )) ||
      current.preparationLease === undefined ||
      current.preparationLease.expiresAtUnixMs > this.now()
    ) {
      return current
    }
    const resumeStatus = current.preparationResumeStatus

    // The marker is established before asynchronous boundary authorization.
    // Lease expiry cannot prove that another replica's authorization or signer
    // call stopped. Only an independently attested provider outcome may clear
    // its lane's signer-I/O barrier, so startup stays deliberately activation-
    // blocked on this record until the store's out-of-band orphaned-boundary
    // resolver (`resolveOrphanedSignerBoundary`) supplies that evidence.
    //
    // Everything below therefore runs only with the marker absent. It used to
    // branch on it repeatedly; those arms were unreachable and claimed the
    // orphan path lands in `quarantined`, which is reconcilable -- a false
    // lead for anyone tracing why an orphan cannot be resolved locally.
    if (current.activeSignerInvocationStartedAtUnixMs !== undefined) {
      return current
    }

    // A burn claim is durable before its signer call, and signed burn bytes
    // replace it without a releasable gap. If the original signer boundary was
    // independently resolved, retain the lane but leave the `preparing` status
    // behind: both a claim and signed burn bytes are public nonce-race evidence
    // that the reconciler can settle once canonical consumption is final.
    if (
      current.contestedNonceBurnClaim !== undefined ||
      current.contestedNonceBurn !== undefined
    ) {
      const retainedAtUnixMs = requireUnixMilliseconds(
        this.now(),
        "Contested nonce burn lease recovery time"
      )
      const reconcilable = nextRecord(current, {
        status:
          current.provenanceInvalidationEvidence === undefined
            ? "quarantined"
            : "provenance-invalidated-awaiting-reconciliation",
        preparationLease: undefined,
        preparationResumeStatus: undefined,
        updatedAtUnixMs: retainedAtUnixMs,
        lastError:
          "Original signer boundary was resolved while a contested nonce burn remained; retaining its lane for canonical nonce reconciliation",
      })
      if (
        !(await this.store.compareAndSwap(
          current.recordID,
          current.version,
          reconcilable
        ))
      ) {
        return this.requireRecord(current.recordID)
      }
      return reconcilable
    }

    // A crash can occur after the non-signing allocator durably reserves a
    // nonce but before this record stores the returned binding. Reservation
    // calls are required to be idempotent for the record generation, so
    // recover that exact binding and put it under the SQL nonce guard before
    // recording a pre-sign void.
    if (
      resumeStatus === undefined &&
      current.reservedNonce === undefined &&
      current.selectedLaneID !== undefined &&
      current.selectedSignerIdentity !== undefined &&
      current.preparationSender !== undefined
    ) {
      const selectedPreparer = this.preparerForSelectedLane(current)
      if (selectedPreparer !== undefined) {
        let recoveredReservation: P2TRSignatureFraudBoundNonceReservation
        try {
          recoveredReservation =
            validateP2TRSignatureFraudBoundNonceReservation(
              current.intent,
              Hex.from(current.recordID),
              current.generation,
              current.preparationAttempts,
              selectedPreparer,
              await selectedPreparer.reserveSignatureFraudChallengeNonce(
                current.intent,
                Hex.from(current.recordID),
                current.generation,
                current.preparationAttempts
              )
            )
        } catch (error) {
          const retryAtUnixMs = requireUnixMilliseconds(
            this.now(),
            "Ambiguous recovered reservation response time"
          )
          const failed = nextRecord(current, {
            preparationLease: {
              owner: current.preparationLease.owner,
              expiresAtUnixMs: requireSafeIntegerSum(
                retryAtUnixMs,
                this.preparationLeaseMs,
                "Recovered reservation retry lease expiration"
              ),
            },
            updatedAtUnixMs: retryAtUnixMs,
            lastError: requireReason(
              `Challenge nonce reservation recovery remains ambiguous and will retry the same epoch: ${errorMessage(
                error
              )}`,
              "Ambiguous recovered reservation response"
            ),
          })
          await this.store.compareAndSwap(
            current.recordID,
            current.version,
            failed
          )
          return this.requireRecord(current.recordID)
        }

        const recoveredAt = requireUnixMilliseconds(
          this.now(),
          "Recovered challenge nonce reservation time"
        )
        const rebound = nextRecord(current, {
          reservedNonce: recoveredReservation,
          nonceReservedAtUnixMs: recoveredAt,
          updatedAtUnixMs: recoveredAt,
          lastError:
            "Recovered an idempotent nonce reservation after a pre-persistence crash",
        })
        if (
          !(await this.store.compareAndSwap(
            current.recordID,
            current.version,
            rebound
          ))
        ) {
          return this.requireRecord(current.recordID)
        }
        return this.recoverExpiredPreparation(rebound)
      }
      const unavailableAtUnixMs = requireUnixMilliseconds(
        this.now(),
        "Missing reservation-recovery provider diagnostic time"
      )
      const unavailable = nextRecord(current, {
        updatedAtUnixMs: unavailableAtUnixMs,
        lastError:
          "An expired pre-persistence nonce reservation claim cannot be recovered because its exact manifest-bound allocator is unavailable",
      })
      if (
        !(await this.store.compareAndSwap(
          current.recordID,
          current.version,
          unavailable
        ))
      ) {
        return this.requireRecord(current.recordID)
      }
      // Keep the original expired lease and reservation epoch intact. The
      // startup recovery barrier remains closed until the exact allocator is
      // restored and the same idempotent reservation request is recovered.
      return unavailable
    }

    const releasableReservation =
      resumeStatus === undefined && current.reservedNonce !== undefined
        ? current.reservedNonce
        : undefined
    const voidedAt = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox lease recovery time"
    )
    const retainLane = resumeStatus !== undefined
    const voidReason =
      "Preparation lease expired before transaction signer invocation"
    const voidEvidenceDigest =
      releasableReservation === undefined
        ? undefined
        : sha256Structured({
            recordID: current.recordID,
            generation: current.generation,
            reservationID:
              releasableReservation.reservationID.toPrefixedString(),
            voidedAtUnixMs: voidedAt,
            reasonCode: "reservation-expired",
            reason: voidReason,
          })
    if (releasableReservation !== undefined) {
      await this.assertVoidedReservationCapacity(current)
    }
    const recovered = nextRecord(current, {
      status:
        current.provenanceInvalidationEvidence !== undefined
          ? "cancelled-provenance-invalidated"
          : resumeStatus ?? "queued",
      preparationLease: undefined,
      preparationResumeStatus: undefined,
      activeSignerInvocationStartedAtUnixMs: undefined,
      activeSignerInvocationID: undefined,
      preparationSender: retainLane ? current.preparationSender : undefined,
      selectedLaneID: retainLane ? current.selectedLaneID : undefined,
      selectedSignerIdentity: retainLane
        ? current.selectedSignerIdentity
        : undefined,
      reservedNonce: retainLane ? current.reservedNonce : undefined,
      nonceReservedAtUnixMs: retainLane
        ? current.nonceReservedAtUnixMs
        : undefined,
      voidedNonceReservations:
        !retainLane && releasableReservation !== undefined
          ? [
              ...(current.voidedNonceReservations ?? []),
              {
                reservation: releasableReservation,
                voidedAtUnixMs: voidedAt,
                reasonCode: "reservation-expired",
                reason: voidReason,
                evidenceDigest: voidEvidenceDigest!,
              },
            ]
          : current.voidedNonceReservations,
      signerQuarantines: current.signerQuarantines,
      updatedAtUnixMs: voidedAt,
      lastError:
        resumeStatus === undefined
          ? "Challenge outbox preparation lease expired before signer invocation"
          : "Challenge outbox replacement lease expired before signer invocation; prior variant restored",
    })
    if (
      !(await this.store.compareAndSwap(
        current.recordID,
        current.version,
        recovered
      ))
    ) {
      return this.requireRecord(current.recordID)
    }

    // The durable guard is void before the external allocator is notified.
    // A crash or provider error here can strand allocator capacity, but can
    // never make a signed nonce reusable or race an in-flight signer.
    if (releasableReservation !== undefined) {
      const preparer = this.preparerForReservation(releasableReservation)
      return this.releaseVoidedReservation(
        recovered,
        releasableReservation,
        preparer
      )
    }
    return this.requireRecord(current.recordID)
  }

  private async voidReturnedPreSignerReservation(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    reservation: P2TRSignatureFraudBoundNonceReservation,
    preparer: P2TRSignatureFraudChallengeTransactionPreparer,
    preserveActiveClaim = false
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    if (
      current.reservedNonce !== undefined ||
      current.signerInvocationStartedAtUnixMs !== undefined ||
      (current.preparedTransactionVariants?.length ?? 0) > 0
    ) {
      throw new Error(
        "Only a returned reservation whose pre-signer state claim was lost may be safely voided"
      )
    }
    validateP2TRSignatureFraudBoundNonceReservation(
      current.intent,
      Hex.from(current.recordID),
      current.generation,
      reservation.reservationEpoch,
      preparer,
      reservation
    )
    const existingTombstone = (current.voidedNonceReservations ?? []).find(
      (item) =>
        normalizeBytes32(
          item.reservation.reservationID,
          "Existing voided reservation ID"
        ) ===
        normalizeBytes32(reservation.reservationID, "Returned reservation ID")
    )
    if (existingTombstone !== undefined) {
      return this.releaseVoidedReservation(current, reservation, preparer)
    }
    await this.assertVoidedReservationCapacity(current)
    const voidedAtUnixMs = requireUnixMilliseconds(
      this.now(),
      "Returned challenge nonce reservation void time"
    )
    const provenanceInvalidated =
      current.provenanceInvalidationEvidence !== undefined
    const reason = provenanceInvalidated
      ? "Canonical provenance was invalidated before signer invocation"
      : "Nonce reservation returned after its durable preparation claim was lost"
    const reasonCode = provenanceInvalidated
      ? "reservation-abandoned"
      : "reservation-expired"
    const evidenceDigest = sha256Structured({
      recordID: current.recordID,
      generation: current.generation,
      reservationID: reservation.reservationID.toPrefixedString(),
      voidedAtUnixMs,
      reasonCode,
      reason,
    })
    const voided = nextRecord(current, {
      status: preserveActiveClaim
        ? current.status
        : provenanceInvalidated
        ? "cancelled-provenance-invalidated"
        : current.status === "preparing"
        ? "queued"
        : current.status,
      preparationLease: preserveActiveClaim
        ? current.preparationLease
        : undefined,
      preparationSender: preserveActiveClaim
        ? current.preparationSender
        : undefined,
      selectedLaneID: preserveActiveClaim ? current.selectedLaneID : undefined,
      selectedSignerIdentity: preserveActiveClaim
        ? current.selectedSignerIdentity
        : undefined,
      reservedNonce: undefined,
      nonceReservedAtUnixMs: undefined,
      voidedNonceReservations: [
        ...(current.voidedNonceReservations ?? []),
        {
          reservation,
          voidedAtUnixMs,
          reasonCode,
          reason,
          evidenceDigest,
        },
      ],
      updatedAtUnixMs: voidedAtUnixMs,
      lastError: reason,
    })
    if (
      !(await this.store.compareAndSwap(
        current.recordID,
        current.version,
        voided
      ))
    ) {
      return undefined
    }
    return this.releaseVoidedReservation(voided, reservation, preparer)
  }

  private async reconcileReturnedReservationAfterLostClaim(
    recordID: string,
    reservation: P2TRSignatureFraudBoundNonceReservation,
    preparer: P2TRSignatureFraudChallengeTransactionPreparer
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    for (let retry = 0; retry < 8; retry++) {
      const durable = await this.requireRecord(recordID)
      if (
        durable.reservedNonce !== undefined &&
        normalizeBytes32(
          durable.reservedNonce.reservationID,
          "Durable nonce reservation ID"
        ) ===
          normalizeBytes32(
            reservation.reservationID,
            "Returned nonce reservation ID"
          )
      ) {
        return durable
      }
      const unsigned =
        durable.reservedNonce === undefined &&
        durable.signerInvocationStartedAtUnixMs === undefined &&
        durable.activeSignerInvocationStartedAtUnixMs === undefined &&
        (durable.preparedTransactionVariants?.length ?? 0) === 0
      const sameActiveClaim =
        unsigned &&
        durable.status === "preparing" &&
        durable.preparationLease !== undefined &&
        durable.preparationLease.expiresAtUnixMs > this.now() &&
        durable.preparationAttempts === reservation.reservationEpoch &&
        durable.selectedLaneID === reservation.laneID &&
        durable.selectedSignerIdentity === reservation.signerIdentity &&
        durable.preparationSender !== undefined &&
        normalizeAddress(
          durable.preparationSender,
          "Durable selected reservation sender"
        ) ===
          normalizeAddress(reservation.sender, "Returned reservation sender")
      if (sameActiveClaim) {
        const adoptedAtUnixMs = requireUnixMilliseconds(
          this.now(),
          "Late reservation adoption time"
        )
        const adopted = nextRecord(durable, {
          reservedNonce: reservation,
          nonceReservedAtUnixMs: adoptedAtUnixMs,
          updatedAtUnixMs: adoptedAtUnixMs,
          lastError:
            "Adopted the exact idempotent nonce reservation returned to an earlier worker",
        })
        try {
          if (
            await this.store.compareAndSwap(
              durable.recordID,
              durable.version,
              adopted
            )
          ) {
            return adopted
          }
        } catch {
          const voided = await this.voidReturnedPreSignerReservation(
            durable,
            reservation,
            preparer,
            false
          )
          if (voided !== undefined) return voided
          continue
        }
        continue
      }
      if (unsigned) {
        const voided = await this.voidReturnedPreSignerReservation(
          durable,
          reservation,
          preparer,
          durable.status === "preparing"
        )
        if (voided !== undefined) return voided
        continue
      }
      const tombstoned = await this.tombstoneConflictingReturnedReservation(
        durable,
        reservation,
        preparer
      )
      if (tombstoned !== undefined) return tombstoned
    }
    throw new Error(
      "Returned nonce reservation reconciliation did not converge"
    )
  }

  private async tombstoneConflictingReturnedReservation(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    reservation: P2TRSignatureFraudBoundNonceReservation,
    preparer: P2TRSignatureFraudChallengeTransactionPreparer
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    validateP2TRSignatureFraudBoundNonceReservation(
      current.intent,
      Hex.from(current.recordID),
      current.generation,
      reservation.reservationEpoch,
      preparer,
      reservation
    )
    await this.assertVoidedReservationCapacity(current)
    const voidedAtUnixMs = requireUnixMilliseconds(
      this.now(),
      "Conflicting returned reservation tombstone time"
    )
    const reason =
      "A distinct authenticated nonce reservation returned after another reservation or signer boundary became durable"
    const evidenceDigest = sha256Structured({
      recordID: current.recordID,
      generation: current.generation,
      reservationID: reservation.reservationID.toPrefixedString(),
      reservationEpoch: reservation.reservationEpoch,
      voidedAtUnixMs,
      reasonCode: "reservation-binding-invalid",
      reason,
    })
    const next = nextRecord(current, {
      voidedNonceReservations: [
        ...(current.voidedNonceReservations ?? []),
        {
          reservation,
          voidedAtUnixMs,
          reasonCode: "reservation-binding-invalid",
          reason,
          evidenceDigest,
        },
      ],
      updatedAtUnixMs: voidedAtUnixMs,
      lastError: reason,
    })
    if (
      !(await this.store.compareAndSwap(
        current.recordID,
        current.version,
        next
      ))
    ) {
      return undefined
    }
    const aliasOfActiveNonce =
      current.reservedNonce !== undefined &&
      normalizeAddress(
        current.reservedNonce.sender,
        "Active reservation sender"
      ) ===
        normalizeAddress(reservation.sender, "Returned reservation sender") &&
      current.reservedNonce.nonce === reservation.nonce
    if (aliasOfActiveNonce) return next
    return this.releaseVoidedReservation(next, reservation, preparer)
  }

  private async assertVoidedReservationCapacity(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    if (
      (record.voidedNonceReservations?.length ?? 0) <
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_VOIDED_RESERVATIONS
    ) {
      return
    }
    const detail =
      "The bounded pre-sign nonce-reservation tombstone ledger is exhausted; operator recovery is required"
    await this.store.saveCriticalAlert({
      code: "nonce-reservation-cap-exhausted",
      seriesID: record.seriesID,
      recordID: record.recordID,
      generation: record.generation,
      activationBlocking: true,
      createdAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Nonce-reservation cap alert time"
      ),
      detail,
    })
    throw new Error(detail)
  }

  private async releaseVoidedReservation(
    record: P2TRSignatureFraudChallengeOutboxRecord,
    reservation: P2TRSignatureFraudBoundNonceReservation,
    preparer: P2TRSignatureFraudChallengeTransactionPreparer | undefined
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const tombstone = (record.voidedNonceReservations ?? []).find(
      (item) =>
        normalizeBytes32(
          item.reservation.reservationID,
          "Voided reservation ID"
        ) ===
        normalizeBytes32(reservation.reservationID, "Released reservation ID")
    )
    if (tombstone === undefined) {
      throw new Error(
        "Allocator release requires the exact durable reservation tombstone"
      )
    }
    const releaseRequestID = computeP2TRSignatureFraudNonceReleaseRequestID(
      record.recordID,
      reservation.reservationID,
      tombstone.evidenceDigest
    )
    const request = await this.store.getNonceReleaseRequest(releaseRequestID)
    if (request === undefined) {
      throw new Error(
        "Durable reservation tombstone lacks its atomic nonce-release request"
      )
    }
    await this.attemptNonceRelease(request, preparer)
    return this.requireRecord(record.recordID)
  }

  private async attemptNonceRelease(
    request: P2TRSignatureFraudNonceReleaseRequest,
    configuredPreparer?: P2TRSignatureFraudChallengeTransactionPreparer
  ): Promise<"acknowledged" | "ambiguous" | "skipped"> {
    const preparer =
      configuredPreparer ?? this.preparerForReservation(request.reservation)
    // No provider call can occur without the exact manifest-bound allocator;
    // do not consume an append-only attempt sequence merely to rediscover it.
    if (preparer === undefined) return "skipped"

    const startedAtUnixMs = requireUnixMilliseconds(
      this.now(),
      "Nonce-release attempt start time"
    )
    const attempt = await this.store.claimNonceReleaseAttempt(
      request.releaseRequestID,
      this.nonceReleaseOwner,
      startedAtUnixMs,
      requireSafeIntegerSum(
        startedAtUnixMs,
        this.nonceReleaseAttemptLeaseMs,
        "Nonce-release attempt expiration"
      )
    )
    if (attempt === undefined) return "skipped"

    const invokedAtUnixMs = requireUnixMilliseconds(
      this.now(),
      "Nonce-release allocator invocation time"
    )
    if (
      !(await this.beginNonceReleaseAttemptDurably(attempt, invokedAtUnixMs))
    ) {
      return "skipped"
    }

    let acknowledgement: P2TRSignatureFraudNonceReleaseAcknowledgement
    try {
      acknowledgement = await preparer.releaseSignatureFraudChallengeNonce(
        request.reservation,
        Hex.from(request.releaseRequestID)
      )
    } catch (error) {
      const detail = requireReason(
        `Nonce allocator release response is ambiguous: ${errorMessage(error)}`,
        "Nonce allocator release error"
      )
      return this.store.recordNonceReleaseAttemptResult(attempt, {
        kind: "ambiguous-error",
        responseDigest: sha256Structured({
          domain: "tbtc-p2tr-nonce-release-error-v1",
          releaseRequestID: request.releaseRequestID,
          detail,
        }),
        detail,
        recordedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Ambiguous nonce-release response time"
        ),
      })
    }

    try {
      validateNonceReleaseAcknowledgement(request, acknowledgement)
    } catch (error) {
      const detail = requireReason(
        `Nonce allocator returned a mismatched release acknowledgement: ${errorMessage(
          error
        )}`,
        "Nonce allocator acknowledgement mismatch"
      )
      const returnedReleaseRequestID = optionalNonceReleaseResponseID(
        acknowledgement,
        "releaseRequestID"
      )
      const returnedReservationID = optionalNonceReleaseResponseID(
        acknowledgement,
        "reservationID"
      )
      const providerResponseDigest = optionalNonceReleaseResponseID(
        acknowledgement,
        "responseDigest"
      )
      return this.store.recordNonceReleaseAttemptResult(attempt, {
        kind: "contract-mismatch",
        responseDigest:
          providerResponseDigest ??
          sha256Structured({
            domain: "tbtc-p2tr-nonce-release-contract-mismatch-v1",
            releaseRequestID: request.releaseRequestID,
            returnedReleaseRequestID: returnedReleaseRequestID ?? null,
            returnedReservationID: returnedReservationID ?? null,
            detail,
          }),
        returnedReleaseRequestID,
        returnedReservationID,
        detail,
        recordedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Mismatched nonce-release response time"
        ),
      })
    }
    return this.store.recordNonceReleaseAttemptResult(attempt, {
      kind: acknowledgement.outcome,
      acknowledgement,
      recordedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Nonce-release acknowledgement time"
      ),
    })
  }

  private async recheckIrreversibleAction(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    stage: P2TRSignatureFraudPreBroadcastRecheckContext["stage"]
  ): Promise<P2TRSignatureFraudPreBroadcastRecheckResult> {
    try {
      const result =
        await this.preBroadcastRechecker.recheckSignatureFraudChallengeBeforeBroadcast(
          {
            stage,
            recordID: current.recordID,
            generation: current.generation,
            intent: current.intent,
            evidenceCheckpoint: current.evidenceCheckpoint,
            canonicalEthereumEligibility: current.canonicalEthereumEligibility,
            canonicalProvenance: current.canonicalProvenance,
            preparedTransaction:
              stage === "before-broadcast"
                ? current.preparedTransaction
                : undefined,
            broadcastAttempts: current.broadcastAttempts,
          }
        )
      validatePreBroadcastRecheckResult(current, result)
      return result
    } catch (error) {
      return {
        status: "unknown",
        reason: errorMessage(
          `Challenge outbox pre-broadcast recheck failed: ${errorMessage(
            error
          )}`
        ),
      }
    }
  }

  /**
   * Drives recovery without judging any lane. This must stay store-wide: the
   * sweeps below are the only thing that ever reclaims a `preparing` record
   * whose lane selection is still NULL -- the window between the claim swap and
   * the lane swap -- and no per-lane predicate can see such a row, because it
   * belongs to no lane yet. Narrowing the sweep would strand those records
   * permanently. Recovering another account's backlog is never harmful; only
   * REFUSING TO SIGN on another account's behalf is, and that is
   * `assertRecoveryBarrier`'s job.
   */
  private async driveRecoverySweeps(): Promise<void> {
    if (!this.recoveryBarrierEstablished) {
      await this.establishRecoveryBarrier()
    }
  }

  private async hasRecoveryBacklogForLane(
    chainID: number,
    sender: string
  ): Promise<boolean> {
    const lane = normalizeP2TRSignatureFraudSigningLane({ chainID, sender })
    const [expiredPreparationLease, pendingNonceRelease] = await Promise.all([
      this.store.hasExpiredPreparationLeases(
        requireUnixMilliseconds(this.now(), "Challenge recovery barrier time"),
        lane
      ),
      this.store.hasPendingNonceReleases(lane),
    ])
    const backlog = expiredPreparationLease || pendingNonceRelease
    if (backlog) this.recoveryBarrierEstablished = false
    return backlog
  }

  private async assertSelectedLaneRecoveryBarrier(
    current: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<void> {
    if (
      current.selectedLaneID === undefined ||
      current.selectedSignerIdentity === undefined ||
      current.preparationSender === undefined
    ) {
      throw new Error(
        "Challenge signing recovery barrier requires an exact selected signer lane"
      )
    }
    await this.assertRecoveryBarrier({
      chainID: current.intent.chainID,
      sender: current.preparationSender,
    })
  }

  /**
   * Refuses to sign on one nonce lane while THAT lane still has unresolved
   * durable recovery work. The lane is required rather than optional on
   * purpose: an absent lane would silently mean "no check", which is the same
   * shape of hole as a barrier row that does not exist reading as a clean lane.
   */
  private async assertRecoveryBarrier(
    lane: P2TRSignatureFraudSigningLane
  ): Promise<void> {
    await this.driveRecoverySweeps()
    const normalized = normalizeP2TRSignatureFraudSigningLane(lane)
    const [expiredPreparationLease, pendingNonceRelease] = await Promise.all([
      this.store.hasExpiredPreparationLeases(
        requireUnixMilliseconds(this.now(), "Challenge recovery barrier time"),
        normalized
      ),
      this.store.hasPendingNonceReleases(normalized),
    ])
    if (expiredPreparationLease || pendingNonceRelease) {
      this.recoveryBarrierEstablished = false
      throw new Error(
        pendingNonceRelease
          ? "Challenge signing lane is blocked by an unacknowledged durable nonce release"
          : "Challenge signing lane is blocked by an expired durable preparation lease"
      )
    }
  }

  private async establishRecoveryBarrier(): Promise<void> {
    const recoverReleases = async (): Promise<void> => {
      let cursor: string | undefined
      for (let pageCount = 0; pageCount < 1_024; pageCount++) {
        const report = await this.recoverPendingNonceReleases(cursor)
        if (report.nextCursor === undefined) return
        cursor = report.nextCursor
      }
      throw new Error(
        "Challenge signing is blocked because nonce-release recovery did not converge"
      )
    }
    await recoverReleases()
    let cursor: string | undefined
    for (let pageCount = 0; pageCount < 1_024; pageCount++) {
      const report = await this.recoverExpiredPreparationLeases(cursor)
      if (report.nextCursor === undefined) break
      cursor = report.nextCursor
      if (pageCount === 1_023) {
        throw new Error(
          "Challenge signing is blocked because lease recovery did not converge"
        )
      }
    }
    // Lease recovery can create new durable release requests.
    await recoverReleases()
    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge recovery barrier completion time"
    )
    // Residue left here is no longer fatal. It used to throw, and that throw --
    // not either message in `assertRecoveryBarrier` -- is what a wedged store
    // actually raised, because this runs first whenever the flag is unset. One
    // account's unresolvable residue therefore froze signing on every account.
    // Whether residue blocks is now the caller's question to ask about its own
    // lane; all this decides is whether the store-wide fast path may latch.
    this.recoveryBarrierEstablished =
      !(await this.store.hasPendingNonceReleases()) &&
      !(await this.store.hasExpiredPreparationLeases(nowUnixMs))
  }

  private async applyPreSignRecheckFailure(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    result: Exclude<
      P2TRSignatureFraudPreBroadcastRecheckResult,
      { status: "eligible" }
    >
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox pre-sign recheck time"
    )
    let cancellationEvidence:
      | P2TRSignatureFraudCanonicalCancellationEvidence
      | undefined
    let status: P2TRSignatureFraudChallengeOutboxStatus = "queued"
    let recordedStatus: P2TRSignatureFraudPreBroadcastRecheckResult["status"] =
      result.status
    let reason = requireReason(
      result.reason,
      "Challenge outbox pre-sign recheck reason"
    )
    if (result.status !== "unknown") {
      try {
        cancellationEvidence = await this.corroborateCancellation(
          current,
          result
        )
        status = result.status
      } catch (error) {
        recordedStatus = "unknown"
        reason = errorMessage(
          `Challenge cancellation evidence was not independently verified: ${errorMessage(
            error
          )}`
        )
      }
    }

    const next = nextRecord(current, {
      status,
      preparationLease: undefined,
      preparationSender: undefined,
      selectedLaneID: undefined,
      selectedSignerIdentity: undefined,
      cancellationEvidence,
      lastPreBroadcastRecheckAtUnixMs: nowUnixMs,
      lastPreBroadcastRecheckStatus: recordedStatus,
      updatedAtUnixMs: nowUnixMs,
      lastError: reason,
    })
    await this.store.compareAndSwap(current.recordID, current.version, next)
    return this.requireRecord(current.recordID)
  }

  private async applyPreBroadcastRecheckFailure(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    result: Exclude<
      P2TRSignatureFraudPreBroadcastRecheckResult,
      { status: "eligible" }
    >
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox pre-broadcast recheck time"
    )
    const next = nextRecord(current, {
      status: current.status,
      lastPreBroadcastRecheckAtUnixMs: nowUnixMs,
      lastPreBroadcastRecheckStatus: result.status,
      updatedAtUnixMs: nowUnixMs,
      lastError: requireReason(
        result.reason,
        "Challenge outbox pre-broadcast recheck reason"
      ),
    })
    await this.store.compareAndSwap(current.recordID, current.version, next)
    return this.requireRecord(current.recordID)
  }

  private async applyPreBroadcastAuthorizationFailure(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    reason: string,
    acknowledgeAttemptRejected = false
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox pre-broadcast authorization failure time"
    )
    const rejectedReason = requireReason(
      reason,
      "Challenge outbox pre-broadcast authorization failure"
    )
    const variants = current.preparedTransactionVariants
    let acknowledgedVariants = variants
    if (acknowledgeAttemptRejected) {
      if (variants === undefined || variants.length === 0) {
        throw new Error(
          "Rejected broadcast authorization lacks its durable attempt variant"
        )
      }
      acknowledgedVariants = replaceLatestPreparedVariant(variants, {
        ...variants[variants.length - 1],
        lastBroadcastProviderAccepted: false,
        lastError: rejectedReason,
      })
    }
    const next = nextRecord(current, {
      status: current.status,
      preparedTransactionVariants: acknowledgedVariants,
      lastBroadcastAuthorizationFailureAtUnixMs: nowUnixMs,
      lastBroadcastProviderAccepted: acknowledgeAttemptRejected
        ? false
        : current.lastBroadcastProviderAccepted,
      updatedAtUnixMs: nowUnixMs,
      lastError: rejectedReason,
    })
    await this.store.compareAndSwap(current.recordID, current.version, next)
    return this.requireRecord(current.recordID)
  }

  private async corroborateCancellation(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    result: Extract<
      P2TRSignatureFraudPreBroadcastRecheckResult,
      { status: "cancelled-honest-spend" | "cancelled-reorg" }
    >
  ): Promise<P2TRSignatureFraudCanonicalCancellationEvidence> {
    validateCancellationEvidence(
      current,
      result.status,
      result.evidence,
      this.preBroadcastRechecker.recheckTrustDomainID,
      this.cancellationEvidenceVerifier.cancellationVerificationTrustDomainID,
      this.preBroadcastRechecker.recheckIndependenceDomainID,
      this.cancellationEvidenceVerifier
        .cancellationVerificationIndependenceDomainID
    )
    const context: P2TRSignatureFraudPreBroadcastRecheckContext = {
      stage: "before-sign",
      recordID: current.recordID,
      generation: current.generation,
      intent: current.intent,
      evidenceCheckpoint: current.evidenceCheckpoint,
      canonicalEthereumEligibility: current.canonicalEthereumEligibility,
      canonicalProvenance: current.canonicalProvenance,
      broadcastAttempts: current.broadcastAttempts,
    }
    const verification =
      await this.cancellationEvidenceVerifier.verifySignatureFraudCancellationEvidence(
        context,
        result.evidence
      )
    if (
      verification.status !== "verified" ||
      normalizeBytes32(
        verification.evidenceHash,
        "Verified cancellation evidence hash"
      ) !== result.evidence.evidenceHash ||
      normalizeHexData(
        verification.corroboratingAttestation,
        "Verified cancellation attestation"
      ) !==
        normalizeHexData(
          result.evidence.agreement.corroboratingAttestation,
          "Cancellation corroborating attestation"
        ) ||
      requireUnixMilliseconds(
        verification.verifiedAtUnixMs,
        "Cancellation verification time"
      ) < result.evidence.agreement.checkedAtUnixMs
    ) {
      throw new Error(
        "Independent cancellation verifier did not confirm the exact evidence digest"
      )
    }
    return result.evidence
  }

  private preparerForReservation(
    reservation: P2TRSignatureFraudBoundNonceReservation
  ): P2TRSignatureFraudChallengeTransactionPreparer | undefined {
    return this.preparers.find(
      (candidate) =>
        candidate.laneID === reservation.laneID &&
        candidate.signerIdentity === reservation.signerIdentity &&
        normalizeAddress(
          candidate.transactionSender,
          "Challenge transaction preparer sender"
        ) ===
          normalizeAddress(
            reservation.sender,
            "Reserved challenge transaction sender"
          )
    )
  }

  private preparerForSelectedLane(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): P2TRSignatureFraudChallengeTransactionPreparer | undefined {
    if (
      record.selectedLaneID === undefined ||
      record.selectedSignerIdentity === undefined ||
      record.preparationSender === undefined
    ) {
      return undefined
    }
    return this.preparers.find(
      (candidate) =>
        candidate.laneID === record.selectedLaneID &&
        candidate.signerIdentity === record.selectedSignerIdentity &&
        normalizeAddress(
          candidate.transactionSender,
          "Challenge transaction preparer sender"
        ) ===
          normalizeAddress(
            record.preparationSender!,
            "Selected challenge transaction sender"
          )
    )
  }

  private signerFailureRecord(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    preparer: P2TRSignatureFraudChallengeTransactionPreparer,
    reason: string,
    signerInvoked: boolean,
    escaped?: P2TRSignatureFraudPreparedChallengeTransaction,
    reasonCode: P2TRSignatureFraudSignerQuarantine["reasonCode"] = signerInvoked
      ? "ambiguous-signer-invocation"
      : "reservation-provider-failure"
  ): P2TRSignatureFraudChallengeOutboxRecord {
    const normalizedReason = requireReason(
      reason,
      "Challenge signer failure reason"
    )
    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge signer quarantine time"
    )
    const reservation = current.reservedNonce
    const quarantineIdentity =
      reservation ??
      ({
        laneID: preparer.laneID,
        signerIdentity: preparer.signerIdentity,
        sender: preparer.transactionSender,
      } as Pick<
        P2TRSignatureFraudBoundNonceReservation,
        "laneID" | "signerIdentity" | "sender"
      >)
    const hasPriorVariant =
      (current.preparedTransactionVariants?.length ?? 0) > 0
    const retainedStatus =
      current.preparationResumeStatus ??
      (current.status === "preparing" && hasPriorVariant
        ? current.broadcastAttempts > 0
          ? "broadcast-pending"
          : "prepared"
        : undefined)
    const durableTerminal = [
      "accepted-own",
      "satisfied-external",
      "terminal-reverted",
      "terminal-nonce-consumed",
      "generation-required",
      "cancelled-before-broadcast",
      "cancelled-honest-spend",
      "cancelled-reorg",
      "cancelled-provenance-invalidated",
    ].includes(current.status)
    return nextRecord(current, {
      status: durableTerminal
        ? current.status
        : current.provenanceInvalidationEvidence !== undefined
        ? signerInvoked
          ? "provenance-invalidated-awaiting-reconciliation"
          : current.status
        : signerInvoked && retainedStatus === undefined
        ? "quarantined"
        : retainedStatus ?? "queued",
      preparationLease: undefined,
      preparationResumeStatus: undefined,
      activeSignerInvocationStartedAtUnixMs: undefined,
      activeSignerInvocationID: undefined,
      signerInvocationStartedAtUnixMs: signerInvoked
        ? current.signerInvocationStartedAtUnixMs ??
          current.activeSignerInvocationStartedAtUnixMs ??
          nowUnixMs
        : current.signerInvocationStartedAtUnixMs,
      signerInvocationID: signerInvoked
        ? current.signerInvocationID ?? current.activeSignerInvocationID
        : current.signerInvocationID,
      preparationSender:
        signerInvoked || hasPriorVariant
          ? current.preparationSender
          : undefined,
      selectedLaneID:
        signerInvoked || hasPriorVariant ? current.selectedLaneID : undefined,
      selectedSignerIdentity:
        signerInvoked || hasPriorVariant
          ? current.selectedSignerIdentity
          : undefined,
      reservedNonce:
        signerInvoked || hasPriorVariant ? current.reservedNonce : undefined,
      nonceReservedAtUnixMs:
        signerInvoked || hasPriorVariant
          ? current.nonceReservedAtUnixMs
          : undefined,
      signerQuarantines: appendSignerQuarantine(
        current.signerQuarantines,
        quarantineIdentity,
        nowUnixMs,
        normalizedReason,
        reasonCode
      ),
      unexpectedSignedArtifacts:
        escaped === undefined
          ? current.unexpectedSignedArtifacts
          : appendUnexpectedSignedArtifact(
              current.unexpectedSignedArtifacts,
              escaped,
              reservation?.reservationID.toPrefixedString() ??
                `0x${"00".repeat(32)}`,
              nowUnixMs,
              normalizedReason
            ),
      updatedAtUnixMs: nowUnixMs,
      lastError: normalizedReason,
    })
  }

  /**
   * An uncorrelated provider response does not prove that the exact active
   * invocation completed. Journal any recoverable bytes, quarantine the
   * signer, and retain the durable active marker for independent tombstoning.
   */
  private signerCorrelationFailureRecord(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    preparer: P2TRSignatureFraudChallengeTransactionPreparer,
    reason: string,
    escaped: P2TRSignatureFraudPreparedChallengeTransaction
  ): P2TRSignatureFraudChallengeOutboxRecord {
    const failed = this.signerFailureRecord(
      current,
      preparer,
      reason,
      true,
      escaped,
      "ambiguous-signer-invocation"
    )
    return {
      ...failed,
      status: current.status,
      preparationLease: current.preparationLease,
      preparationResumeStatus: current.preparationResumeStatus,
      activeSignerInvocationStartedAtUnixMs:
        current.activeSignerInvocationStartedAtUnixMs,
      activeSignerInvocationID: current.activeSignerInvocationID,
    }
  }

  /**
   * @param feePolicy The exact lane envelope handed to the signer for this
   *   boundary. It is passed in rather than re-derived so that the authorized
   *   digest names what the signer actually receives, not a value that merely
   *   ought to equal it.
   * @param stageTransactionHash The transaction the stage names: the variant
   *   being superseded for a replacement, the variant about to be sent for a
   *   broadcast. A prepare boundary names none.
   */
  private buildIrreversibleBoundaryBinding(
    record: P2TRSignatureFraudChallengeOutboxRecord,
    stage: P2TRSignatureFraudIrreversibleBoundaryStage,
    attempt: number,
    feePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy,
    stageTransactionHash?: Hex | Buffer | string
  ): P2TRSignatureFraudIrreversibleBoundaryBinding {
    const reservedNonce = requireReservedNonce(
      record,
      "Irreversible challenge boundary"
    )
    const namesTransaction = stage === "replacement" || stage === "broadcast"
    if (namesTransaction !== (stageTransactionHash !== undefined)) {
      throw new Error(
        "Only a challenge replacement or broadcast boundary may name a transaction hash"
      )
    }
    const laneID = requireBoundedText(
      reservedNonce.laneID,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
      "Boundary signer lane ID"
    )
    const signerIdentity = requireBoundedText(
      reservedNonce.signerIdentity,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
      "Boundary signer identity"
    )
    // The envelope must belong to the lane the durable reservation is bound to.
    // Nothing downstream re-checks this pairing once the digest is taken.
    if (
      requireBoundedText(
        feePolicy.laneID,
        P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
        "Boundary fee policy lane ID"
      ) !== laneID ||
      requireBoundedText(
        feePolicy.signerIdentity,
        P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
        "Boundary fee policy signer identity"
      ) !== signerIdentity ||
      normalizeAddress(feePolicy.sender, "Boundary fee policy sender") !==
        normalizeAddress(reservedNonce.sender, "Boundary reserved sender")
    ) {
      throw new Error(
        "Irreversible challenge boundary fee envelope names another signer lane"
      )
    }
    // Recomputed, not read back: a stored intent ID proves nothing about the
    // router and calldata this boundary is authorizing.
    const intentID = normalizeBytes32(
      computeP2TRSignatureFraudSubmissionIntentID(record.intent),
      "Boundary submission intent ID"
    )
    if (
      intentID !==
      normalizeBytes32(record.intent.intentID, "Durable submission intent ID")
    ) {
      throw new Error(
        "Irreversible challenge boundary intent does not match its durable identity"
      )
    }
    return {
      recordID: normalizeBytes32(record.recordID, "Boundary record ID"),
      generation: requireBoundedNonNegativeSafeInteger(
        record.generation,
        P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_GENERATIONS - 1,
        "Boundary record generation"
      ),
      recordVersion: requireNonNegativeSafeInteger(
        record.version,
        "Boundary record version"
      ),
      reservationID: normalizeBytes32(
        reservedNonce.reservationID,
        "Boundary reservation ID"
      ),
      sender: normalizeAddress(
        reservedNonce.sender,
        "Boundary reserved sender"
      ),
      transactionNonce: requireNonNegativeSafeInteger(
        reservedNonce.nonce,
        "Boundary transaction nonce"
      ),
      stage,
      attempt: requirePositiveSafeInteger(attempt, "Boundary attempt"),
      provenanceFingerprint: normalizeBytes32(
        record.canonicalProvenance.provenanceFingerprint,
        "Boundary provenance fingerprint"
      ),
      activationManifestHash: normalizeBytes32(
        record.feePolicyManifest.activationManifestHash,
        "Boundary activation manifest hash"
      ),
      laneID,
      signerIdentity,
      intentID,
      routerAddress: normalizeAddress(
        record.intent.routerAddress,
        "Boundary router address"
      ),
      intentValueWei: normalizePolicyUint256(
        record.intent.value,
        "Boundary intent value"
      ),
      challengeValueWei: normalizePolicyUint256(
        feePolicy.challengeValueWei,
        "Boundary challenge value"
      ),
      maxGasLimit: normalizePolicyUint256(
        feePolicy.maxGasLimit,
        "Boundary maximum gas limit"
      ),
      maxFeePerGas: normalizePolicyUint256(
        feePolicy.maxFeePerGas,
        "Boundary maximum fee per gas"
      ),
      maxPriorityFeePerGas: normalizePolicyUint256(
        feePolicy.maxPriorityFeePerGas,
        "Boundary maximum priority fee per gas"
      ),
      maxTotalFeeWei: normalizePolicyUint256(
        feePolicy.maxTotalFeeWei,
        "Boundary maximum total fee"
      ),
      replacedTransactionHash:
        stage === "replacement" && stageTransactionHash !== undefined
          ? normalizeBytes32(
              stageTransactionHash,
              "Boundary replaced transaction hash"
            )
          : undefined,
      preparedTransactionHash:
        stage === "broadcast" && stageTransactionHash !== undefined
          ? normalizeBytes32(
              stageTransactionHash,
              "Boundary prepared transaction hash"
            )
          : undefined,
    }
  }

  /**
   * Completes a boundary whose signer served a different request.
   *
   * The bytes are fully authenticated by this point, so they are captured as an
   * unexpected signed artifact rather than discarded: the signer was invoked,
   * consumed the reserved nonce, and may hold further bytes we never saw.
   * Treating this as an uninvoked boundary would be a lie about the nonce.
   */
  private async completeWrongInvocationRequest(
    signerBoundary: P2TRSignatureFraudChallengeOutboxRecord,
    preparer: P2TRSignatureFraudChallengeTransactionPreparer,
    escaped: P2TRSignatureFraudPreparedChallengeTransaction,
    reason: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    // Invocation echoes are unsigned transport metadata. Keep them out of the
    // durable artifact even when the completion CAS loses: malformed values
    // must not make an otherwise authenticated record unreadable on hydrate.
    const { invocation: _unsafeInvocation, ...durableEscaped } = escaped
    const reservationMismatch =
      signerBoundary.reservedNonce === undefined
        ? undefined
        : classifyReservationMismatch(
            signerBoundary.intent.chainID,
            signerBoundary.reservedNonce,
            durableEscaped
          )
    // The echo explains why this response belongs to another invocation, but
    // the signed envelope itself decides whether it escaped onto another nonce
    // lane. PostgreSQL requires that lane mismatch classification before it
    // will append the wrong-lane bytes and their quarantine evidence.
    const reasonCode =
      reservationMismatch === "wrong-sender" ||
      reservationMismatch === "wrong-nonce"
        ? reservationMismatch
        : "wrong-signer-invocation-request"
    const failed = this.signerFailureRecord(
      signerBoundary,
      preparer,
      reason,
      true,
      durableEscaped,
      reasonCode
    )
    if (!(await this.compareAndSwapSignerCompletion(signerBoundary, failed))) {
      return this.captureEscapedArtifactAfterLostCas(
        signerBoundary,
        durableEscaped,
        `Wrong-invocation signed envelope returned after a concurrent outbox transition: ${reason}`,
        requireLatestSignerQuarantine(failed)
      )
    }
    return this.requireRecord(signerBoundary.recordID)
  }

  /**
   * Forces a contested nonce race to terminate by spending the reserved nonce.
   *
   * For an orphaned boundary nobody can decide from outside whether the signer
   * produced bytes; delivery delay is unbounded, so absence is never provable.
   * This sidesteps the question rather than answering it. Ethereum already
   * guarantees at most one transaction confirms per nonce, so spending that
   * nonce on a self-transfer makes any signed challenge bytes for it inert —
   * whichever transaction wins. The result is decidable from public data and
   * resolvable through the `nonce-consumed` outcome.
   *
   * The burn has its own durable pre-I/O claim. The existing boundary may be
   * independently resolved while the burn signer is in flight, but recovery
   * cannot release the reservation until the claim is atomically replaced by
   * the exact signed burn bytes.
   */
  async burnContestedNonce(
    recordID: Hex | Buffer | string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    this.store.assertExternalIOTransactionBoundary()
    const key = normalizeBytes32(recordID, "Challenge outbox record ID")
    const current = await this.requireRecord(key)
    if (current.contestedNonceBurn !== undefined) {
      // Once bytes are durable they remain the only burn this record may send,
      // even if the original signer boundary was independently resolved before
      // a provider acknowledged them.
      return this.broadcastPersistedContestedNonceBurn(key, current)
    }
    const existingClaim = current.contestedNonceBurnClaim
    if (
      existingClaim === undefined &&
      current.activeSignerInvocationStartedAtUnixMs === undefined
    ) {
      throw new Error(
        "Only a boundary with an unresolved signer invocation may burn its nonce"
      )
    }
    const reservation = requireReservedNonce(current, "Contested nonce burn")

    const feePolicy = feePolicyForReservation(current, reservation)
    const envelope = contestedNonceBurnEnvelope(current, feePolicy, reservation)
    const preparer = this.preparerForReservation(reservation)
    if (preparer === undefined) {
      throw new Error(
        "Contested nonce burn has no configured signer for its reserved lane"
      )
    }
    const binding = this.buildIrreversibleBoundaryBinding(
      existingClaim === undefined
        ? current
        : { ...current, version: existingClaim.recordVersion },
      "burn",
      existingClaim?.preparationAttempts ?? current.preparationAttempts,
      contestedNonceBurnBoundaryFeePolicy(feePolicy, envelope)
    )
    const invocation = computeP2TRSignatureFraudSignerInvocationRequest(binding)
    if (
      existingClaim !== undefined &&
      (normalizeBytes32(
        existingClaim.signerInvocationID,
        "Contested nonce burn claim invocation ID"
      ) !== invocation.invocationID ||
        normalizeBytes32(
          existingClaim.signerRequestDigest,
          "Contested nonce burn claim request digest"
        ) !== invocation.requestDigest ||
        normalizeBytes32(
          existingClaim.reservationID,
          "Contested nonce burn claim reservation ID"
        ) !==
          normalizeBytes32(
            reservation.reservationID,
            "Contested nonce burn reservation ID"
          ))
    ) {
      throw new Error(
        "Contested nonce burn claim does not match its durable signer request"
      )
    }
    const authorization =
      await this.irreversibleBoundaryAuthorizer.authorizeP2TRSignatureFraudIrreversibleBoundary(
        binding
      )
    let claimed = current
    if (existingClaim === undefined) {
      const claimedAtUnixMs = requireUnixMilliseconds(
        this.now(),
        "Contested nonce burn claim time"
      )
      claimed = nextRecord(current, {
        contestedNonceBurnClaim: {
          signerInvocationID: invocation.invocationID,
          signerRequestDigest: invocation.requestDigest,
          reservationID: normalizeBytes32(
            reservation.reservationID,
            "Contested nonce burn claim reservation ID"
          ),
          recordVersion: current.version,
          preparationAttempts: current.preparationAttempts,
          claimedAtUnixMs,
        },
        updatedAtUnixMs: Math.max(current.updatedAtUnixMs, claimedAtUnixMs),
      })
      if (!(await this.store.compareAndSwap(key, current.version, claimed))) {
        // Authorization is process-local and has not been consumed. Most
        // importantly, no signer I/O occurs unless this exact claim won its
        // durable CAS.
        return this.requireRecord(key)
      }
    }
    this.irreversibleBoundaryAuthorizer.assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
      authorization,
      binding,
      requireUnixMilliseconds(this.now(), "Burn authorization consumption time")
    )

    // First authenticate the raw transaction independently of the signer echo.
    // Echo metadata is not signed and must never make exact nonce-consuming
    // bytes disappear after the signer boundary has been crossed.
    const signed = validateP2TRSignatureFraudPreparedNonceBurnTransaction(
      reservation,
      envelope,
      await preparer.prepareSignatureFraudNonceBurnTransaction(
        reservation,
        envelope,
        signerInvocationRequest(invocation)
      )
    )
    const echoMismatch = signerInvocationEchoMismatch(signed, invocation)

    // Durable before the broadcaster is called, exactly as the challenge send
    // boundary is: a crash from here on can only re-send identical bytes.
    const signedAtUnixMs = requireUnixMilliseconds(
      this.now(),
      "Contested nonce burn signing time"
    )
    const contestedNonceBurn: P2TRSignatureFraudContestedNonceBurn = {
      transactionHash: normalizeBytes32(
        signed.transactionHash,
        "Contested nonce burn hash"
      ),
      rawTransaction: normalizeHexData(
        signed.rawTransaction,
        "Contested nonce burn bytes"
      ),
      nonce: signed.nonce,
      sender: normalizeAddress(signed.sender, "Contested nonce burn sender"),
      maxFeePerGas: signed.maxFeePerGas,
      maxPriorityFeePerGas: signed.maxPriorityFeePerGas,
      signerInvocationID: invocation.invocationID,
      signedAtUnixMs,
    }
    let burned = nextRecord(claimed, {
      contestedNonceBurnClaim: undefined,
      contestedNonceBurn,
      signerQuarantines:
        echoMismatch === undefined
          ? claimed.signerQuarantines
          : appendSignerQuarantine(
              claimed.signerQuarantines,
              reservation,
              signedAtUnixMs,
              echoMismatch,
              "wrong-signer-invocation-request"
            ),
      updatedAtUnixMs: signedAtUnixMs,
      lastError: echoMismatch,
    })
    if (!(await this.store.compareAndSwap(key, claimed.version, burned))) {
      // Signed bytes already exist and may escape the signer even though a
      // concurrent completion moved the record. Retain the exact burn on top
      // of that durable state before permitting any lease recovery to consider
      // the reservation releasable.
      burned = await this.captureContestedNonceBurnAfterLostCas(
        key,
        contestedNonceBurn,
        echoMismatch
      )
    }
    return this.broadcastPersistedContestedNonceBurn(key, burned)
  }

  private async captureContestedNonceBurnAfterLostCas(
    recordID: string,
    burn: P2TRSignatureFraudContestedNonceBurn,
    signerFault?: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    for (let retry = 0; retry < 8; retry++) {
      const durable = await this.requireRecord(recordID)
      if (durable.contestedNonceBurn !== undefined) {
        const { broadcastAtUnixMs: _broadcastAtUnixMs, ...durableSignedBurn } =
          durable.contestedNonceBurn
        if (JSON.stringify(durableSignedBurn) !== JSON.stringify(burn)) {
          throw new Error(
            "A different contested nonce burn became durable while signing"
          )
        }
        if (signerFault === undefined) return durable
        if (durable.reservedNonce === undefined) {
          throw new Error(
            "Persisted contested nonce burn lost its durable reservation"
          )
        }
        const quarantines = appendSignerQuarantine(
          durable.signerQuarantines,
          durable.reservedNonce,
          burn.signedAtUnixMs,
          signerFault,
          "wrong-signer-invocation-request"
        )
        if (quarantines === durable.signerQuarantines) return durable
        const faulted = nextRecord(durable, {
          signerQuarantines: quarantines,
          updatedAtUnixMs: Math.max(
            durable.updatedAtUnixMs,
            burn.signedAtUnixMs
          ),
          lastError: signerFault,
        })
        if (
          await this.store.compareAndSwap(recordID, durable.version, faulted)
        ) {
          return faulted
        }
        continue
      }
      const claim = durable.contestedNonceBurnClaim
      if (
        claim === undefined ||
        normalizeBytes32(
          claim.signerInvocationID,
          "Durable contested nonce burn claim invocation ID"
        ) !== burn.signerInvocationID ||
        durable.reservedNonce === undefined ||
        normalizeBytes32(
          claim.reservationID,
          "Durable contested nonce burn claim reservation ID"
        ) !==
          normalizeBytes32(
            durable.reservedNonce.reservationID,
            "Durable contested nonce burn reservation ID"
          )
      ) {
        throw new Error(
          "Signed contested nonce burn lost its durable pre-I/O claim"
        )
      }
      const capturedAtUnixMs = requireUnixMilliseconds(
        this.now(),
        "Contested nonce burn capture time"
      )
      const captured = nextRecord(durable, {
        contestedNonceBurnClaim: undefined,
        contestedNonceBurn: burn,
        status:
          durable.activeSignerInvocationStartedAtUnixMs === undefined &&
          durable.status === "preparing"
            ? durable.provenanceInvalidationEvidence === undefined
              ? "quarantined"
              : "provenance-invalidated-awaiting-reconciliation"
            : durable.status,
        preparationLease:
          durable.activeSignerInvocationStartedAtUnixMs === undefined
            ? undefined
            : durable.preparationLease,
        preparationResumeStatus:
          durable.activeSignerInvocationStartedAtUnixMs === undefined
            ? undefined
            : durable.preparationResumeStatus,
        signerQuarantines:
          signerFault === undefined
            ? durable.signerQuarantines
            : appendSignerQuarantine(
                durable.signerQuarantines,
                durable.reservedNonce,
                burn.signedAtUnixMs,
                signerFault,
                "wrong-signer-invocation-request"
              ),
        updatedAtUnixMs: Math.max(durable.updatedAtUnixMs, capturedAtUnixMs),
        lastError: signerFault ?? durable.lastError,
      })
      if (
        await this.store.compareAndSwap(recordID, durable.version, captured)
      ) {
        return captured
      }
    }
    throw new Error("Contested nonce burn capture did not converge")
  }

  private async broadcastPersistedContestedNonceBurn(
    recordID: string,
    durable: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const burn = durable.contestedNonceBurn
    if (burn === undefined) {
      throw new Error("Contested nonce burn broadcast lacks durable bytes")
    }
    const returnedHash = normalizeBytes32(
      await this.broadcaster.broadcastRawTransaction(burn.rawTransaction),
      "Broadcast contested nonce burn hash"
    )
    const expectedHash = normalizeBytes32(
      burn.transactionHash,
      "Persisted contested nonce burn hash"
    )
    if (returnedHash !== expectedHash) {
      const reason =
        "Contested nonce burn broadcaster returned a hash that does not match the persisted raw transaction"
      return this.quarantine(durable, reason, true)
    }

    for (let retry = 0; retry < 8; retry++) {
      const current = await this.requireRecord(recordID)
      const currentBurn = current.contestedNonceBurn
      if (currentBurn === undefined) {
        throw new Error(
          "Persisted contested nonce burn disappeared after broadcast"
        )
      }
      if (
        normalizeBytes32(
          currentBurn.transactionHash,
          "Current contested nonce burn hash"
        ) !== expectedHash
      ) {
        throw new Error(
          "Persisted contested nonce burn changed after broadcast"
        )
      }
      if (currentBurn.broadcastAtUnixMs !== undefined) return current
      const acknowledgedAtUnixMs = requireUnixMilliseconds(
        this.now(),
        "Contested nonce burn broadcast acknowledgement time"
      )
      const acknowledged = nextRecord(current, {
        contestedNonceBurn: {
          ...currentBurn,
          broadcastAtUnixMs: acknowledgedAtUnixMs,
        },
        updatedAtUnixMs: Math.max(
          current.updatedAtUnixMs,
          acknowledgedAtUnixMs
        ),
        lastError: undefined,
      })
      if (
        await this.store.compareAndSwap(recordID, current.version, acknowledged)
      ) {
        return acknowledged
      }
    }
    throw new Error("Contested nonce burn acknowledgement did not converge")
  }

  /**
   * Records why a boundary binding could not be built, for a claim that never
   * reached the durable marker. There is nothing to clear — the invocation
   * identity is derived before the swap that would set the marker, so a failure
   * here leaves the activation barrier untouched and the reservation is
   * released by ordinary lease recovery.
   */
  private async abandonUnboundPreparationClaim(
    claimed: P2TRSignatureFraudChallengeOutboxRecord,
    reason: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const unbound = nextRecord(claimed, {
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox unbound boundary time"
      ),
      lastError: requireReason(reason, "Boundary binding failure reason"),
    })
    await this.store.compareAndSwap(claimed.recordID, claimed.version, unbound)
    return this.requireRecord(claimed.recordID)
  }

  private signerBoundaryIdentity(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): string {
    if (
      record.activeSignerInvocationStartedAtUnixMs === undefined ||
      record.activeSignerInvocationID === undefined ||
      record.reservedNonce === undefined
    ) {
      throw new Error("Active signer boundary identity is incomplete")
    }
    return [
      normalizeBytes32(record.recordID, "Active signer record ID"),
      normalizeBytes32(
        record.activeSignerInvocationID,
        "Active signer invocation ID"
      ),
      requirePositiveSafeInteger(
        record.preparationAttempts,
        "Active signer preparation attempt"
      ),
      normalizeBytes32(
        record.reservedNonce.reservationID,
        "Active signer reservation ID"
      ),
      requireUnixMilliseconds(
        record.activeSignerInvocationStartedAtUnixMs,
        "Active signer invocation time"
      ),
    ].join(":")
  }

  /**
   * Resolves a lost response from the pre-signer CAS. The predecessor version
   * proves the first CAS did not commit and may be retried; the exact boundary
   * proves it did commit and can be retired because this worker has not called
   * the signer. Any concurrent successor is returned without being rewritten.
   */
  private async reconcileUninvokedSignerBoundaryPersistence(
    predecessor: P2TRSignatureFraudChallengeOutboxRecord,
    signerBoundary: P2TRSignatureFraudChallengeOutboxRecord,
    reason: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const expectedBoundaryIdentity = this.signerBoundaryIdentity(signerBoundary)
    let lastRetryableError: unknown
    for (let retry = 0; retry < 8; retry++) {
      let durable: P2TRSignatureFraudChallengeOutboxRecord
      try {
        durable = await this.requireRecord(signerBoundary.recordID)
      } catch (error) {
        if (
          !this.store.isP2TRSignatureFraudWatchtowerPersistenceRetryable(error)
        ) {
          throw error
        }
        lastRetryableError = error
        continue
      }
      if (durable.activeSignerInvocationStartedAtUnixMs !== undefined) {
        if (this.signerBoundaryIdentity(durable) !== expectedBoundaryIdentity) {
          throw new Error(
            "Ambiguous signer-boundary persistence no longer owns the durable boundary"
          )
        }
        return this.completeUninvokedSignerBoundary(signerBoundary, reason)
      }
      if (durable.version !== predecessor.version) return durable

      try {
        const persisted =
          await this.store.compareAndSwapWithCurrentCanonicalProvenance(
            predecessor.recordID,
            predecessor.version,
            predecessor.canonicalProvenance,
            signerBoundary
          )
        if (persisted) {
          return this.completeUninvokedSignerBoundary(signerBoundary, reason)
        }
      } catch (error) {
        if (
          !this.store.isP2TRSignatureFraudWatchtowerPersistenceRetryable(error)
        ) {
          throw error
        }
        lastRetryableError = error
        // Reload after every uncertain retry. If the marker committed, the
        // exact-identity branch above completes it before this method returns.
      }
    }
    throw new Error("Ambiguous signer-boundary persistence did not converge", {
      cause: lastRetryableError,
    })
  }

  /**
   * `beginNonceReleaseAttempt` is idempotent for the exact attempt and
   * invocation time. Retrying after a lost COMMIT response therefore either
   * confirms the existing marker or reestablishes it before allocator I/O.
   */
  private async beginNonceReleaseAttemptDurably(
    attempt: P2TRSignatureFraudNonceReleaseAttempt,
    invokedAtUnixMs: number
  ): Promise<boolean> {
    let lastRetryableError: unknown
    for (let retry = 0; retry < 8; retry++) {
      try {
        return await this.store.beginNonceReleaseAttempt(
          attempt,
          invokedAtUnixMs
        )
      } catch (error) {
        if (
          !this.store.isP2TRSignatureFraudWatchtowerPersistenceRetryable(error)
        ) {
          throw error
        }
        lastRetryableError = error
        // The transaction may have committed. Retry the exact idempotent
        // marker before allowing the allocator call to escape this process.
      }
    }
    throw new Error("Nonce-release invocation persistence did not converge", {
      cause: lastRetryableError,
    })
  }

  /**
   * Clears the exact durable pre-I/O marker when authorization failed before
   * the signer function was called. Concurrent canonical invalidation may
   * change status, but it must not turn a known-uninvoked signer into an
   * ambiguous external call.
   */
  private async completeUninvokedSignerBoundary(
    signerBoundary: P2TRSignatureFraudChallengeOutboxRecord,
    reason: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const expectedBoundary =
      signerBoundary.activeSignerInvocationStartedAtUnixMs
    const expectedReservation = signerBoundary.reservedNonce
    if (expectedBoundary === undefined || expectedReservation === undefined) {
      throw new Error(
        "Uninvoked signer completion lacks its durable boundary binding"
      )
    }
    const normalizedReason = requireReason(
      reason,
      "Signer authorization failure reason"
    )
    let lastRetryableError: unknown
    for (let retry = 0; retry < 8; retry++) {
      let durable: P2TRSignatureFraudChallengeOutboxRecord
      try {
        durable = await this.requireRecord(signerBoundary.recordID)
      } catch (error) {
        if (
          !this.store.isP2TRSignatureFraudWatchtowerPersistenceRetryable(error)
        ) {
          throw error
        }
        lastRetryableError = error
        continue
      }
      if (durable.activeSignerInvocationStartedAtUnixMs === undefined) {
        return durable
      }
      if (
        durable.activeSignerInvocationStartedAtUnixMs !== expectedBoundary ||
        durable.preparationAttempts !== signerBoundary.preparationAttempts ||
        durable.reservedNonce === undefined ||
        normalizeBytes32(
          durable.reservedNonce.reservationID,
          "Durable uninvoked signer reservation ID"
        ) !==
          normalizeBytes32(
            expectedReservation.reservationID,
            "Expected uninvoked signer reservation ID"
          )
      ) {
        throw new Error(
          "Uninvoked signer completion no longer owns the durable boundary"
        )
      }
      const resumeStatus = durable.preparationResumeStatus
      const hasPriorSignedState =
        durable.signerInvocationStartedAtUnixMs !== undefined ||
        (durable.preparedTransactionVariants?.length ?? 0) > 0 ||
        (durable.unexpectedSignedArtifacts?.length ?? 0) > 0 ||
        durable.broadcastAttempts > 0
      const provenanceWasInvalidated =
        durable.provenanceInvalidationEvidence !== undefined
      const retainedBurnState =
        durable.contestedNonceBurnClaim !== undefined ||
        durable.contestedNonceBurn !== undefined
      const restoreResumeStatus =
        durable.status === "preparing" &&
        resumeStatus !== undefined &&
        !provenanceWasInvalidated &&
        !retainedBurnState
      const completed = nextRecord(durable, {
        status: retainedBurnState
          ? provenanceWasInvalidated
            ? "provenance-invalidated-awaiting-reconciliation"
            : "quarantined"
          : provenanceWasInvalidated && hasPriorSignedState
          ? "provenance-invalidated-awaiting-reconciliation"
          : restoreResumeStatus
          ? resumeStatus
          : durable.status,
        preparationLease:
          retainedBurnState || (provenanceWasInvalidated && hasPriorSignedState)
            ? undefined
            : restoreResumeStatus
            ? undefined
            : durable.preparationLease,
        preparationResumeStatus:
          retainedBurnState || (provenanceWasInvalidated && hasPriorSignedState)
            ? undefined
            : restoreResumeStatus
            ? undefined
            : durable.preparationResumeStatus,
        activeSignerInvocationStartedAtUnixMs: undefined,
        activeSignerInvocationID: undefined,
        updatedAtUnixMs: requireUnixMilliseconds(
          this.now(),
          "Signer authorization failure completion time"
        ),
        lastError: normalizedReason,
      })
      // A boundary that is provably uninvoked may retire the activation-
      // blocking incident invalidation raised over it, in the SAME transaction
      // as the barrier-clearing swap. Invalidation had to raise that incident
      // because the boundary marker is durable before authorization, so at
      // that instant "stuck in authorization" and "signer call outstanding"
      // are indistinguishable. This path is the only witness that resolves the
      // ambiguity, and it is already trusted to clear the signer barrier.
      const retirableBoundary =
        provenanceWasInvalidated &&
        !hasPriorSignedState &&
        durable.reservedNonce !== undefined &&
        durable.activeSignerInvocationStartedAtUnixMs !== undefined &&
        durable.activeSignerInvocationID !== undefined
          ? {
              signerInvocationID: durable.activeSignerInvocationID,
              startedAtUnixMs: durable.activeSignerInvocationStartedAtUnixMs,
              preparationAttempts: durable.preparationAttempts,
              nonceReservationID:
                durable.reservedNonce.reservationID.toString(),
            }
          : undefined
      let persisted = false
      try {
        persisted =
          retirableBoundary === undefined
            ? await this.store.compareAndSwap(
                durable.recordID,
                durable.version,
                completed
              )
            : await this.store.compareAndSwapRetiringUninvokedSignerBoundary(
                durable.recordID,
                durable.version,
                completed,
                retirableBoundary,
                requireUnixMilliseconds(
                  this.now(),
                  "Uninvoked signer boundary retirement time"
                )
              )
      } catch (error) {
        if (
          !this.store.isP2TRSignatureFraudWatchtowerPersistenceRetryable(error)
        ) {
          throw error
        }
        lastRetryableError = error
        // A transactional failure is indistinguishable from a lost CAS until
        // the durable row is reloaded. Retry the exact boundary completion.
      }
      if (persisted) return completed
    }
    throw new Error("Uninvoked signer completion did not converge", {
      cause: lastRetryableError,
    })
  }

  private async compareAndSwapSignerCompletion(
    signerBoundary: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    try {
      return await this.store.compareAndSwap(
        signerBoundary.recordID,
        signerBoundary.version,
        next
      )
    } catch {
      return false
    }
  }

  /**
   * Completes the exact signer invocation after a concurrent durable mutation
   * won the first completion CAS. Provenance invalidation and lease recovery
   * deliberately retain the active marker; the worker that observes the RPC
   * return is the only actor allowed to clear it. A later invocation must not
   * be mistaken for the call being completed here.
   */
  private async completeSignerFailureAfterLostCas(
    signerBoundary: P2TRSignatureFraudChallengeOutboxRecord,
    preparer: P2TRSignatureFraudChallengeTransactionPreparer,
    reason: string,
    reasonCode: P2TRSignatureFraudSignerQuarantine["reasonCode"]
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const expectedBoundary =
      signerBoundary.activeSignerInvocationStartedAtUnixMs
    if (expectedBoundary === undefined) {
      throw new Error("Signer completion lacks its durable active boundary")
    }
    for (let retry = 0; retry < 8; retry++) {
      const durable = await this.requireRecord(signerBoundary.recordID)
      if (durable.activeSignerInvocationStartedAtUnixMs === undefined) {
        return durable
      }
      if (
        durable.activeSignerInvocationStartedAtUnixMs !== expectedBoundary ||
        durable.preparationAttempts !== signerBoundary.preparationAttempts ||
        durable.reservedNonce === undefined ||
        signerBoundary.reservedNonce === undefined ||
        normalizeBytes32(
          durable.reservedNonce.reservationID,
          "Durable signer completion reservation ID"
        ) !==
          normalizeBytes32(
            signerBoundary.reservedNonce.reservationID,
            "Expected signer completion reservation ID"
          )
      ) {
        throw new Error(
          "Signer completion no longer owns the durable active invocation"
        )
      }
      const failed = this.signerFailureRecord(
        durable,
        preparer,
        reason,
        true,
        undefined,
        reasonCode
      )
      let persisted = false
      try {
        persisted = await this.store.compareAndSwap(
          durable.recordID,
          durable.version,
          failed
        )
      } catch {
        // Reload and retry the exact active signer invocation. The durable
        // marker remains fail-closed while the completion is uncertain.
      }
      if (persisted) {
        return this.requireRecord(durable.recordID)
      }
    }
    throw new Error("Signer completion reconciliation did not converge")
  }

  private async quarantine(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    reason: string,
    preserveActiveSignerBoundary = false
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const normalizedReason = requireReason(
      reason,
      "Challenge outbox quarantine reason"
    )
    const postSendBoundary = current.broadcastAttempts > 0
    const signerBoundary =
      current.signerInvocationStartedAtUnixMs !== undefined ||
      (current.preparedTransactionVariants?.length ?? 0) > 0 ||
      current.contestedNonceBurnClaim !== undefined ||
      current.contestedNonceBurn !== undefined
    const hasSignedVariants =
      (current.preparedTransactionVariants?.length ?? 0) > 0
    if (signerBoundary) {
      await this.saveSignedStateQuarantineAlert(current, normalizedReason)
    }
    const quarantined = nextRecord(current, {
      status:
        current.status === "external-satisfied-awaiting-own-transaction"
          ? current.status
          : postSendBoundary
          ? "broadcast-pending"
          : hasSignedVariants
          ? "prepared"
          : "quarantined",
      preparationLease: undefined,
      preparationResumeStatus: undefined,
      activeSignerInvocationStartedAtUnixMs: preserveActiveSignerBoundary
        ? current.activeSignerInvocationStartedAtUnixMs
        : undefined,
      activeSignerInvocationID: preserveActiveSignerBoundary
        ? current.activeSignerInvocationID
        : undefined,
      preparationSender: signerBoundary ? current.preparationSender : undefined,
      selectedLaneID: signerBoundary ? current.selectedLaneID : undefined,
      selectedSignerIdentity: signerBoundary
        ? current.selectedSignerIdentity
        : undefined,
      reservedNonce: signerBoundary ? current.reservedNonce : undefined,
      nonceReservedAtUnixMs: signerBoundary
        ? current.nonceReservedAtUnixMs
        : undefined,
      preparedTransactionVariants:
        postSendBoundary &&
        current.preparedTransactionVariants !== undefined &&
        current.preparedTransactionVariants.length > 0
          ? replaceLatestPreparedVariant(current.preparedTransactionVariants, {
              ...current.preparedTransactionVariants[
                current.preparedTransactionVariants.length - 1
              ],
              lastError: normalizedReason,
            })
          : current.preparedTransactionVariants,
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox quarantine time"
      ),
      lastError: normalizedReason,
    })
    await this.store.compareAndSwap(
      current.recordID,
      current.version,
      quarantined
    )
    return this.requireRecord(current.recordID)
  }

  private async saveSignedStateQuarantineAlert(
    record: P2TRSignatureFraudChallengeOutboxRecord,
    reason: string
  ): Promise<void> {
    await this.store.saveCriticalAlert({
      code: "signed-state-quarantined",
      seriesID: record.seriesID,
      recordID: record.recordID,
      generation: record.generation,
      activationBlocking: true,
      createdAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Signed-state quarantine alert time"
      ),
      detail: requireReason(reason, "Signed-state quarantine alert detail"),
    })
  }

  private async captureEscapedArtifactAfterLostCas(
    signerBoundary: P2TRSignatureFraudChallengeOutboxRecord,
    preparedTransaction: P2TRSignatureFraudPreparedChallengeTransaction,
    reason: string,
    signerQuarantine?: P2TRSignatureFraudSignerQuarantine
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    if (signerBoundary.reservedNonce === undefined) {
      throw new Error(
        "Cannot capture escaped challenge bytes without the durable nonce reservation"
      )
    }
    const capturedAtUnixMs = requireUnixMilliseconds(
      this.now(),
      "Escaped signed artifact capture time"
    )
    return this.store.captureEscapedSignedArtifact(
      signerBoundary.recordID,
      signerBoundary.canonicalProvenance.provenanceFingerprint,
      {
        preparedTransaction,
        expectedReservationID:
          signerBoundary.reservedNonce.reservationID.toPrefixedString(),
        capturedAtUnixMs,
        reason: requireReason(reason, "Escaped signed artifact reason"),
      },
      signerQuarantine
    )
  }

  private async requireRecord(
    recordID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const record = await this.store.get(recordID)
    if (record === undefined) {
      throw new Error("Challenge outbox record does not exist")
    }
    return record
  }
}

export const quarantineLegacyP2TRSignatureFraudSubmissions = async (
  recordSource: P2TRWatchtowerChallengeRecordSource,
  store: P2TRSignatureFraudChallengeOutboxStore,
  nowUnixMs = Date.now()
): Promise<P2TRSignatureFraudLegacySubmissionQuarantine[]> => {
  requireUnixMilliseconds(nowUnixMs, "Legacy submission quarantine time")
  const quarantines = (await recordSource.listChallengeRecords())
    .filter(isAmbiguousLegacySubmissionRecord)
    .map((record) => ({
      observationID: normalizeBytes32(
        record.observationID,
        "Legacy observation ID"
      ),
      bridgeChallengeKey:
        record.observation?.bridgeChallengeKey === undefined
          ? undefined
          : normalizeBytes32(
              record.observation.bridgeChallengeKey,
              "Legacy Bridge challenge key"
            ),
      legacyStatus: record.status,
      submissionAttempts: record.submissionAttempts,
      challengeTxHash:
        record.challengeTxHash === undefined
          ? undefined
          : normalizeBytes32(
              record.challengeTxHash,
              "Legacy challenge transaction hash"
            ),
      reason:
        "Legacy challenge submission has no authenticated prepared-transaction outbox record and must never be retried automatically",
      quarantinedAtUnixMs: nowUnixMs,
    }))

  for (const quarantine of quarantines) {
    await store.saveLegacyQuarantine(quarantine)
  }
  return quarantines
}

const isAmbiguousLegacySubmissionRecord = (
  record: P2TRWatchtowerChallengeRecord
): boolean =>
  record.submissionAttempts > 0 ||
  record.status === "submitting" ||
  record.status === "broadcast-pending" ||
  record.status === "rejected"

const canonicalObservationConsistencyContext = (
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  options: P2TRSignatureFraudChallengeOutboxSchedulerOptions
): P2TRSignatureFraudWitnessObservationConsistencyContext =>
  ({
    ...options.observationValidation,
    registeredWalletIDs: [snapshot.canonicalRegisteredWalletID],
    walletInputKeyBindings:
      snapshot.canonicalWalletInputAuthorization.kind === "deposit-binding"
        ? [snapshot.canonicalWalletInputAuthorization.binding]
        : [],
  } as P2TRSignatureFraudWitnessObservationConsistencyContext)

const validateSchedulerOptions = (
  options: P2TRSignatureFraudChallengeOutboxSchedulerOptions
): void => {
  if (options === undefined || typeof options !== "object") {
    throw new Error("Challenge outbox scheduler options are required")
  }
  const domain = options.observationValidation?.bridgeChallengeDomain
  if (domain === undefined) {
    throw new Error(
      "Challenge outbox scheduler requires a canonical Bridge challenge domain"
    )
  }
  if (
    normalizePositiveSafeIntegerLike(
      domain.chainID,
      "Observation Bridge challenge chain ID"
    ) !==
    normalizePositiveSafeIntegerLike(
      options.submissionIntent.domainChainID,
      "Submission intent immutable domain chain ID"
    )
  ) {
    throw new Error(
      "Challenge outbox observation and immutable Router domain chains differ"
    )
  }
  normalizePositiveSafeIntegerLike(
    options.submissionIntent.chainID,
    "Submission transaction chain ID"
  )
  normalizePositiveSafeIntegerLike(
    options.submissionIntent.domainChainID,
    "Submission immutable domain chain ID"
  )
  if (
    normalizeAddress(domain.bridgeAddress, "Observation Bridge address") !==
    normalizeAddress(
      options.submissionIntent.bridgeAddress,
      "Submission intent Bridge address"
    )
  ) {
    throw new Error(
      "Challenge outbox Bridge challenge domain and submission Bridge differ"
    )
  }
  normalizeAddress(
    options.submissionIntent.routerAddress,
    "Submission intent Router address"
  )
  validateActivationManifestBinding(options.activationManifest)
  validateChallengeFeePolicyManifest(
    options.feePolicyManifest,
    options.activationManifest,
    options.submissionIntent
  )
}

const validateAuthoritativeObservationBinding = (
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
): void => {
  const observation = snapshot.canonicalObservation
  const walletID = normalizeBytes32(
    observation.walletID,
    "Canonical observation wallet ID"
  )
  if (
    normalizeBytes32(
      snapshot.canonicalRegisteredWalletID,
      "Canonical registered wallet ID"
    ) !== walletID
  ) {
    throw new Error(
      "Canonical observation wallet is not authorized by the registry index"
    )
  }
  const observedPrevout = observation.inputPrevouts[observation.inputIndex]
  const observedOutputKey = extractP2TRWalletIDFromScriptPubKey(
    observation.scriptPubKey
  )
  if (observedPrevout === undefined || observedOutputKey === undefined) {
    throw new Error(
      "Canonical observation input lacks an authenticated Taproot prevout"
    )
  }
  const outputKey = normalizeBytes32(
    observedOutputKey,
    "Canonical observation output key"
  )
  const authorization = snapshot.canonicalWalletInputAuthorization
  if (authorization.kind === "registered-wallet-output") {
    if (
      outputKey !== walletID ||
      normalizeBytes32(
        authorization.walletID,
        "Canonical wallet-output authorization wallet ID"
      ) !== walletID ||
      normalizeBytes32(
        authorization.outputKey,
        "Canonical wallet-output authorization output key"
      ) !== outputKey
    ) {
      throw new Error(
        "Canonical wallet output does not match the registered FROST wallet"
      )
    }
    return
  }
  const binding = authorization.binding
  if (
    normalizeBytes32(binding.txid, "Canonical deposit binding txid") !==
      normalizeBytes32(observedPrevout.txid, "Observed input prevout txid") ||
    requireUint32(binding.vout, "Canonical deposit binding vout") !==
      requireUint32(observedPrevout.vout, "Observed input prevout vout") ||
    normalizeBytes32(
      binding.outputKey,
      "Canonical deposit binding output key"
    ) !== outputKey ||
    normalizeBytes32(
      binding.walletID,
      "Canonical deposit binding wallet ID"
    ) !== walletID
  ) {
    throw new Error(
      "Canonical observation is not authorized by the exact deposit binding"
    )
  }
}

const validateCompleteV2IntentObservationBinding = (
  intent: P2TRSignatureFraudSubmissionIntent,
  observation: P2TRSignatureFraudWitnessObservation
): void => {
  validateP2TRCompleteV2SignatureFraudSubmissionIntent(intent)
  const signingKey = extractP2TRWalletIDFromScriptPubKey(
    observation.scriptPubKey
  )
  const prevout = observation.inputPrevouts[observation.inputIndex]
  if (signingKey === undefined || prevout === undefined) {
    throw new Error(
      "COMPLETE_V2 intent requires the exact P2TR signing input and prevout"
    )
  }
  const walletID = normalizeBytes32(
    observation.walletID,
    "Observation wallet ID"
  )
  const normalizedSigningKey = normalizeBytes32(
    signingKey,
    "Observation P2TR signing key"
  )
  const baseWalletKey = normalizedSigningKey === walletID
  const expectedBindingTxHash = baseWalletKey
    ? `0x${"00".repeat(32)}`
    : reverseBytes32(prevout.txid, "Observation funding txid")
  const expectedBindingOutputIndex = baseWalletKey ? 0 : prevout.vout
  const observedSignature = normalizeFixedBytes(
    observation.signature,
    64,
    "Observation BIP-340 signature"
  )
  const intentSignature = `${normalizeBytes32(
    intent.nonceX,
    "Intent signature nonce X"
  )}${normalizeBytes32(intent.signatureScalar, "Intent signature scalar").slice(
    2
  )}`
  if (
    intent.inputIndex !== observation.inputIndex ||
    normalizeBytes32(intent.walletID, "Intent wallet ID") !== walletID ||
    normalizeBytes32(intent.signingKey, "Intent signing key") !==
      normalizedSigningKey ||
    normalizeBytes32(intent.sighash, "Intent sighash") !==
      normalizeBytes32(observation.sighash, "Observation sighash") ||
    normalizeBytes32(intent.bindingTxHash, "Intent binding txid") !==
      expectedBindingTxHash ||
    intent.bindingOutputIndex !== expectedBindingOutputIndex ||
    intentSignature !== observedSignature
  ) {
    throw new Error(
      "COMPLETE_V2 intent does not match the exact canonical Bitcoin input evidence"
    )
  }
}

const validateEligibilitySnapshot = (
  requestedObservationID: string,
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  intent: P2TRSignatureFraudSubmissionIntent,
  activationManifest: P2TRSignatureFraudActivationManifestBinding
): void => {
  const observation = snapshot.canonicalObservation
  if (
    snapshot.canonicalCandidateDelivered !== true ||
    snapshot.canonicalCandidateCurrentAtCursor !== true
  ) {
    throw new Error(
      "Challenge outbox requires the current acknowledged canonical Bitcoin candidate"
    )
  }
  if (snapshot.legacySubmissionQuarantined) {
    throw new Error(
      "Challenge outbox eligibility is blocked by legacy submission quarantine"
    )
  }
  if (
    normalizeBytes32(
      snapshot.challengeRecord.observationID,
      "Stored occurrence ID"
    ) !== requestedObservationID ||
    normalizeBytes32(
      observation.observationID,
      "Canonical SDK observation ID"
    ) !==
      normalizeBytes32(intent.bridgeChallengeKey, "Submission challenge key")
  ) {
    throw new Error(
      "Challenge outbox occurrence or SDK observation alias is not the current canonical candidate"
    )
  }
  validateCompleteV2IntentObservationBinding(intent, observation)
  validateCanonicalEthereumEligibility(
    snapshot.canonicalEthereumEligibility,
    intent,
    activationManifest,
    {
      blockNumber: snapshot.evidenceCheckpoint.ethereumLifecycleBlockNumber,
      blockHash: snapshot.evidenceCheckpoint.ethereumLifecycleBlockHash,
      exactBlock: true,
    }
  )
  if (
    !sameActivationManifestBinding(
      activationManifest,
      snapshot.evidenceCheckpoint.activationManifest
    )
  ) {
    throw new Error(
      "Challenge outbox checkpoint does not match the activation manifest"
    )
  }
  validateCanonicalCandidatePointer(
    snapshot.canonicalCandidate,
    "Canonical challenge candidate"
  )
  validateCanonicalProvenanceBinding(
    snapshot.canonicalProvenance,
    snapshot.canonicalCandidate,
    requestedObservationID,
    intent.bridgeChallengeKey,
    observation.inputPrevouts[snapshot.canonicalCandidate.inputIndex],
    snapshot.canonicalWalletInputAuthorization,
    snapshot.evidenceCheckpoint,
    activationManifest
  )
  if (
    normalizeBytes32(snapshot.canonicalCandidate.txid, "Candidate txid") !==
      normalizeBytes32(
        snapshot.evidenceCheckpoint.bitcoinTxHash,
        "Evidence Bitcoin txid"
      ) ||
    normalizeBytes32(snapshot.canonicalCandidate.wtxid, "Candidate wtxid") !==
      normalizeBytes32(
        snapshot.evidenceCheckpoint.bitcoinWitnessTxHash,
        "Evidence Bitcoin wtxid"
      ) ||
    normalizeBytes32(
      snapshot.canonicalCandidate.blockHash,
      "Candidate block hash"
    ) !==
      normalizeBytes32(
        snapshot.evidenceCheckpoint.bitcoinBlockHash,
        "Evidence Bitcoin block hash"
      ) ||
    snapshot.canonicalCandidate.blockHeight !==
      snapshot.evidenceCheckpoint.bitcoinBlockHeight ||
    snapshot.canonicalCandidate.inputIndex !== observation.inputIndex ||
    snapshot.canonicalCandidate.inputIndex !==
      snapshot.evidenceCheckpoint.bitcoinInputIndex
  ) {
    throw new Error(
      "Challenge outbox evidence does not identify the exact canonical witness candidate"
    )
  }
}

const validateOutboxEnqueue = (
  challengeRecord: P2TRWatchtowerChallengeRecord,
  canonicalObservation: P2TRSignatureFraudWitnessObservation,
  intent: P2TRSignatureFraudSubmissionIntent,
  evidence: P2TRSignatureFraudOutboxEvidenceCheckpoint,
  nowUnixMs: number
): void => {
  requireUnixMilliseconds(nowUnixMs, "Challenge outbox enqueue time")
  validateP2TRCompleteV2SignatureFraudSubmissionIntent(intent)
  const computedIntentID = computeP2TRSignatureFraudSubmissionIntentID({
    protocol: intent.protocol,
    evidenceProtocolID: intent.evidenceProtocolID,
    observationID: intent.observationID,
    inputIndex: intent.inputIndex,
    bridgeChallengeKey: intent.bridgeChallengeKey,
    walletID: intent.walletID,
    signingKey: intent.signingKey,
    bindingTxHash: intent.bindingTxHash,
    bindingOutputIndex: intent.bindingOutputIndex,
    bridgeChallengeIdentity: intent.bridgeChallengeIdentity,
    sighash: intent.sighash,
    nonceX: intent.nonceX,
    signatureScalar: intent.signatureScalar,
    domainChainID: intent.domainChainID,
    chainID: intent.chainID,
    bridgeAddress: intent.bridgeAddress,
    routerAddress: intent.routerAddress,
    calldata: intent.calldata,
    value: intent.value,
  })
  if (
    normalizeBytes32(intent.intentID, "Submission intent ID") !==
    normalizeBytes32(computedIntentID, "Computed submission intent ID")
  ) {
    throw new Error("Challenge outbox intent ID does not authenticate its call")
  }
  if (
    challengeRecord.status !== "observed" ||
    challengeRecord.submissionAttempts !== 0
  ) {
    throw new Error(
      "Challenge outbox accepts only never-submitted observed records; legacy submission state must be quarantined"
    )
  }
  if (
    normalizeBytes32(
      canonicalObservation.observationID,
      "Canonical SDK observation ID"
    ) !==
      normalizeBytes32(intent.bridgeChallengeKey, "Submission challenge key") ||
    canonicalObservation.inputIndex !== intent.inputIndex
  ) {
    throw new Error(
      "Challenge outbox intent does not match the durable observation"
    )
  }
  if (
    challengeRecord.bitcoinStatus !== "confirmed" ||
    challengeRecord.bitcoinTxHash === undefined ||
    (
      challengeRecord as P2TRWatchtowerChallengeRecord & {
        bitcoinWtxid?: Hex | Buffer | string
      }
    ).bitcoinWtxid === undefined ||
    challengeRecord.bitcoinBlockHash === undefined ||
    challengeRecord.bitcoinBlockHeight === undefined
  ) {
    throw new Error(
      "Challenge outbox requires confirmed canonical Bitcoin evidence"
    )
  }

  validateEvidenceCheckpoint(evidence)
  if (
    normalizeBytes32(
      challengeRecord.bitcoinTxHash,
      "Confirmed Bitcoin transaction hash"
    ) !==
      normalizeBytes32(evidence.bitcoinTxHash, "Checkpoint Bitcoin tx hash") ||
    normalizeBytes32(
      (
        challengeRecord as P2TRWatchtowerChallengeRecord & {
          bitcoinWtxid: Hex | Buffer | string
        }
      ).bitcoinWtxid,
      "Confirmed Bitcoin witness transaction hash"
    ) !==
      normalizeBytes32(
        evidence.bitcoinWitnessTxHash,
        "Checkpoint Bitcoin witness tx hash"
      ) ||
    normalizeBytes32(
      challengeRecord.bitcoinBlockHash,
      "Confirmed Bitcoin block hash"
    ) !==
      normalizeBytes32(
        evidence.bitcoinBlockHash,
        "Checkpoint Bitcoin block hash"
      ) ||
    challengeRecord.bitcoinBlockHeight !== evidence.bitcoinBlockHeight ||
    evidence.bitcoinCursorBlockHeight < evidence.bitcoinBlockHeight
  ) {
    throw new Error(
      "Challenge outbox evidence checkpoint does not cover the confirmed observation"
    )
  }
}

const validateEvidenceCheckpoint = (
  evidence: P2TRSignatureFraudOutboxEvidenceCheckpoint
): void => {
  if (evidence.confirmedSourceComplete !== true) {
    throw new Error("Challenge outbox requires a complete confirmed source")
  }
  normalizeBytes32(evidence.bitcoinTxHash, "Checkpoint Bitcoin tx hash")
  normalizeBytes32(
    evidence.bitcoinWitnessTxHash,
    "Checkpoint Bitcoin witness tx hash"
  )
  normalizeBytes32(evidence.bitcoinBlockHash, "Checkpoint Bitcoin block hash")
  normalizeBytes32(
    evidence.bitcoinCursorBlockHash,
    "Checkpoint Bitcoin cursor block hash"
  )
  normalizeBytes32(
    evidence.ethereumLifecycleBlockHash,
    "Checkpoint Ethereum lifecycle block hash"
  )
  requireNonNegativeSafeInteger(
    evidence.bitcoinBlockHeight,
    "Checkpoint Bitcoin block height"
  )
  requireUint32(evidence.bitcoinInputIndex, "Checkpoint Bitcoin input index")
  requireNonNegativeSafeInteger(
    evidence.bitcoinCursorBlockHeight,
    "Checkpoint Bitcoin cursor block height"
  )
  requireNonNegativeSafeInteger(
    evidence.ethereumLifecycleBlockNumber,
    "Checkpoint Ethereum lifecycle block number"
  )
  validateActivationManifestBinding(evidence.activationManifest)
  requireNonNegativeSafeInteger(
    evidence.submittedEventScanFromBlock,
    "Checkpoint submitted-event scan floor"
  )
  if (
    evidence.submittedEventScanFromBlock > evidence.ethereumLifecycleBlockNumber
  ) {
    throw new Error(
      "Checkpoint submitted-event scan floor must not be ahead of the lifecycle cursor"
    )
  }
}

const validateExistingOutboxIdentity = (
  actual: P2TRSignatureFraudChallengeOutboxRecord,
  expected: P2TRSignatureFraudChallengeOutboxRecord
): void => {
  if (
    normalizeBytes32(actual.seriesID, "Stored outbox series ID") !==
      normalizeBytes32(expected.seriesID, "Expected outbox series ID") ||
    normalizeBytes32(actual.recordID, "Stored outbox record ID") !==
      normalizeBytes32(expected.recordID, "Expected outbox record ID") ||
    actual.generation !== expected.generation ||
    JSON.stringify(actual.generationTrigger) !==
      JSON.stringify(expected.generationTrigger) ||
    intentKey(actual.intent) !== intentKey(expected.intent) ||
    normalizeBytes32(
      actual.intent.bridgeChallengeKey,
      "Stored Bridge challenge key"
    ) !==
      normalizeBytes32(
        expected.intent.bridgeChallengeKey,
        "Expected Bridge challenge key"
      ) ||
    actual.intent.chainID !== expected.intent.chainID ||
    normalizeAddress(actual.intent.routerAddress, "Stored Router address") !==
      normalizeAddress(
        expected.intent.routerAddress,
        "Expected Router address"
      ) ||
    actual.intent.calldata.toLowerCase() !==
      expected.intent.calldata.toLowerCase() ||
    actual.intent.value !== expected.intent.value ||
    normalizeBytes32(
      actual.canonicalEthereumEligibility.readSetHash,
      "Stored eligibility read-set hash"
    ) !==
      normalizeBytes32(
        expected.canonicalEthereumEligibility.readSetHash,
        "Expected eligibility read-set hash"
      ) ||
    !sameCanonicalProvenanceBinding(
      actual.canonicalProvenance,
      expected.canonicalProvenance
    ) ||
    normalizeBytes32(
      actual.feePolicyManifest.policyHash,
      "Stored challenge fee policy hash"
    ) !==
      normalizeBytes32(
        expected.feePolicyManifest.policyHash,
        "Expected challenge fee policy hash"
      ) ||
    !sameEvidenceCheckpoint(
      actual.evidenceCheckpoint,
      expected.evidenceCheckpoint
    )
  ) {
    throw new Error(
      "Challenge outbox uniqueness conflict maps one intent or challenge key to different calls"
    )
  }
}

const validateSeriesHead = (
  head: P2TRSignatureFraudChallengeOutboxRecord,
  intent: P2TRSignatureFraudSubmissionIntent,
  seriesID: string,
  feePolicyManifest: P2TRSignatureFraudChallengeFeePolicyManifest,
  allowManifestBoundPolicyRotation = false
): void => {
  const sameIntent = intentKey(head.intent) === intentKey(intent)
  if (
    normalizeBytes32(head.seriesID, "Stored outbox series ID") !==
      normalizeBytes32(seriesID, "Expected outbox series ID") ||
    computeP2TRSignatureFraudOutboxSeriesID(head.intent) !== seriesID ||
    (!sameIntent &&
      (!allowManifestBoundPolicyRotation ||
        !sameSubmissionIntentExceptValue(head.intent, intent))) ||
    (!allowManifestBoundPolicyRotation &&
      normalizeBytes32(
        head.feePolicyManifest.policyHash,
        "Stored challenge fee policy hash"
      ) !==
        normalizeBytes32(
          feePolicyManifest.policyHash,
          "Configured challenge fee policy hash"
        )) ||
    head.generation < 0 ||
    head.generation >= P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_GENERATIONS
  ) {
    throw new Error(
      "Challenge outbox series head does not match the canonical submission identity"
    )
  }
}

const sameSubmissionIntentExceptValue = (
  left: P2TRSignatureFraudSubmissionIntent,
  right: P2TRSignatureFraudSubmissionIntent
): boolean => {
  const {
    intentID: _leftIntentID,
    value: _leftValue,
    ...leftWithoutValue
  } = left
  const {
    intentID: _rightIntentID,
    value: _rightValue,
    ...rightWithoutValue
  } = right
  return (
    normalizeBytes32(
      computeP2TRSignatureFraudSubmissionIntentID({
        ...leftWithoutValue,
        value: "0",
      }),
      "Prior submission intent without value"
    ) ===
    normalizeBytes32(
      computeP2TRSignatureFraudSubmissionIntentID({
        ...rightWithoutValue,
        value: "0",
      }),
      "Restored submission intent without value"
    )
  )
}

const validateNonceDispositionSuccessor = (
  head: P2TRSignatureFraudChallengeOutboxRecord,
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
): void => {
  const disposition = head.generationDisposition
  if (disposition === undefined) {
    throw new Error("Finalized nonce disposition evidence is required")
  }
  normalizeGenerationDisposition(disposition)
  if (
    snapshot.canonicalEthereumEligibility.readAtBlockNumber <
      disposition.finalizedThrough.blockNumber ||
    normalizeBytes32(
      snapshot.canonicalEthereumEligibility.readSetHash,
      "Fresh eligibility read-set hash"
    ) ===
      normalizeBytes32(
        head.canonicalEthereumEligibility.readSetHash,
        "Prior eligibility read-set hash"
      ) ||
    snapshot.evidenceCheckpoint.bitcoinCursorBlockHeight <
      head.evidenceCheckpoint.bitcoinCursorBlockHeight ||
    snapshot.evidenceCheckpoint.ethereumLifecycleBlockNumber <
      disposition.finalizedThrough.blockNumber
  ) {
    throw new Error(
      "A fresh canonical eligibility read after exact nonce disposition is required"
    )
  }
}

const validateCanonicalReappearanceSuccessor = (
  head: P2TRSignatureFraudChallengeOutboxRecord,
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
): void => {
  const cancellation = head.cancellationEvidence
  if (cancellation?.kind !== "canonical-reorg") {
    throw new Error("Canonical reorg cancellation evidence is required")
  }
  const candidate = snapshot.canonicalCandidate
  const original = cancellation.originalCandidate
  if (
    normalizeBytes32(candidate.txid, "Reappeared candidate txid") !==
      normalizeBytes32(original.txid, "Cancelled candidate txid") ||
    normalizeBytes32(candidate.wtxid, "Reappeared candidate wtxid") !==
      normalizeBytes32(original.wtxid, "Cancelled candidate wtxid") ||
    candidate.inputIndex !== original.inputIndex ||
    (normalizeBytes32(
      candidate.blockHash,
      "Reappeared candidate block hash"
    ) ===
      normalizeBytes32(original.blockHash, "Cancelled candidate block hash") &&
      candidate.blockHeight === original.blockHeight) ||
    normalizeBytes32(
      snapshot.canonicalEthereumEligibility.readSetHash,
      "Reappearance eligibility read-set hash"
    ) ===
      normalizeBytes32(
        head.canonicalEthereumEligibility.readSetHash,
        "Cancelled eligibility read-set hash"
      )
  ) {
    throw new Error(
      "Canonical reappearance must be the same witness transaction in a distinct confirmed epoch with a fresh eligibility read"
    )
  }
}

const validateCanonicalProvenanceRestorationSuccessor = (
  head: P2TRSignatureFraudChallengeOutboxRecord,
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
): void => {
  const invalidation = head.provenanceInvalidationEvidence
  if (invalidation === undefined) {
    throw new Error("Canonical provenance invalidation evidence is required")
  }
  validateCanonicalProvenanceInvalidationEvidence(invalidation)
  if (
    normalizeBytes32(
      snapshot.canonicalProvenance.provenanceFingerprint,
      "Restored canonical provenance fingerprint"
    ) ===
      normalizeBytes32(
        head.canonicalProvenance.provenanceFingerprint,
        "Invalidated canonical provenance fingerprint"
      ) ||
    normalizeBytes32(
      snapshot.canonicalProvenance.candidateDigest,
      "Restored canonical candidate digest"
    ) !==
      normalizeBytes32(
        head.canonicalProvenance.candidateDigest,
        "Invalidated canonical candidate digest"
      ) ||
    invalidation.candidateProvenanceGeneration !==
      head.canonicalProvenance.candidateProvenanceGeneration ||
    snapshot.canonicalProvenance.candidateProvenanceGeneration <=
      head.canonicalProvenance.candidateProvenanceGeneration ||
    snapshot.canonicalProvenance.readinessCertificateGeneration <=
      head.canonicalProvenance.readinessCertificateGeneration ||
    snapshot.canonicalProvenance.throughBlockNumber <=
      head.canonicalProvenance.throughBlockNumber ||
    snapshot.canonicalEthereumEligibility.readAtBlockNumber <
      snapshot.canonicalProvenance.throughBlockNumber
  ) {
    throw new Error(
      "A provenance-invalidated challenge requires the same exact candidate under a distinct later canonical journal fingerprint"
    )
  }
}

const validateSignerLanes = (
  preparers: readonly P2TRSignatureFraudChallengeTransactionPreparer[]
): readonly P2TRSignatureFraudChallengeTransactionPreparer[] => {
  if (
    !Array.isArray(preparers) ||
    preparers.length === 0 ||
    preparers.length > 32
  ) {
    throw new Error(
      "Challenge outbox requires between one and thirty-two signer lanes"
    )
  }
  const laneIDs = new Set<string>()
  const signerIdentities = new Set<string>()
  const senders = new Set<string>()
  for (const preparer of preparers) {
    const laneID = requireBoundedText(
      preparer.laneID,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
      "Challenge signer lane ID"
    )
    const signerIdentity = requireBoundedText(
      preparer.signerIdentity,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
      "Challenge signer identity"
    )
    const sender = normalizeAddress(
      preparer.transactionSender,
      "Challenge signer sender"
    )
    if (
      laneIDs.has(laneID) ||
      signerIdentities.has(signerIdentity) ||
      senders.has(sender)
    ) {
      throw new Error(
        "Challenge outbox signer lanes require unique lane, signer, and sender identities"
      )
    }
    laneIDs.add(laneID)
    signerIdentities.add(signerIdentity)
    senders.add(sender)
  }
  return [...preparers]
}

const validateRecordFeePolicyManifest = (
  record: P2TRSignatureFraudChallengeOutboxRecord
): void => {
  const manifest = record.feePolicyManifest
  const { policyHash: _ignored, ...withoutHash } = manifest
  const normalized = normalizeChallengeFeePolicyManifestWithoutHash(withoutHash)
  const normalizedActivationManifest = normalizeActivationManifestBinding(
    record.evidenceCheckpoint.activationManifest
  )
  if (
    normalizeBytes32(manifest.policyHash, "Challenge fee policy hash") !==
      computeP2TRSignatureFraudChallengeFeePolicyHash(withoutHash) ||
    normalized.activationManifestHash !==
      normalizeBytes32(
        record.evidenceCheckpoint.activationManifest.manifestHash,
        "Challenge activation manifest hash"
      ) ||
    normalized.chainID !== record.intent.chainID ||
    normalizedActivationManifest.routerDomainChainID !==
      record.intent.domainChainID ||
    normalized.challengeValueWei !==
      normalizePolicyUint256(record.intent.value, "Challenge intent value")
  ) {
    throw new Error(
      "Durable challenge fee policy drifted from its generation identity"
    )
  }
}

/**
 * Compares the echo the signer returned against the request it was handed.
 *
 * Returns a reason on mismatch, `undefined` when they agree. The echo is an
 * assertion — a signer can copy it beside bytes it signed for something else —
 * so this catches a response that does not belong to this request, not a signer
 * that lies. Conformance of the transaction to the request is enforced
 * separately and field by field by the SDK validators.
 */
const signerInvocationEchoMismatch = (
  prepared: {
    invocation?: P2TRSignatureFraudPreparedChallengeTransaction["invocation"]
  },
  expected: { invocationID: string; requestDigest: string }
): string | undefined => {
  const echo = prepared.invocation
  if (echo === undefined) {
    return "Signer returned no invocation request echo"
  }
  let echoedID: string
  let echoedDigest: string
  try {
    echoedID = normalizeBytes32(
      echo.invocationID,
      "Echoed signer invocation ID"
    )
    echoedDigest = normalizeBytes32(
      echo.requestDigest,
      "Echoed signer invocation request digest"
    )
  } catch {
    return "Signer returned a malformed invocation request echo"
  }
  if (
    echoedID !== normalizeBytes32(expected.invocationID, "Invocation ID") ||
    echoedDigest !==
      normalizeBytes32(expected.requestDigest, "Invocation request digest")
  ) {
    return "Signer echoed another invocation request"
  }
  return undefined
}

/** Bridges the record's plain-hex identities into the SDK's `Hex` shape. */
const signerInvocationRequest = (invocation: {
  invocationID: string
  requestDigest: string
}) => ({
  invocationID: Hex.from(invocation.invocationID),
  requestDigest: Hex.from(invocation.requestDigest),
})

/**
 * The burn's fee envelope, derived from the lane caps rather than added to the
 * activation manifest.
 *
 * A burn only has to outbid the authorized variants it is racing, and every
 * one of those is capped at the lane's own `maxFeePerGas`. A fixed multiple of
 * that cap therefore clears them all with margin — the 10% minimum bump most
 * clients require, and then some — without introducing a number nobody signed.
 *
 * The result is still manifest-bound where it matters: the burn's whole spend
 * is 21000 gas at the derived cap, and that is required to fit inside the
 * `maxTotalFeeWei` the manifest already commits. A lane whose committed total
 * cannot cover a burn cannot authorize one, and fails closed.
 */
export const P2TR_SIGNATURE_FRAUD_NONCE_BURN_FEE_MULTIPLIER = 2n

const contestedNonceBurnEnvelope = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  feePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy,
  reservation: P2TRSignatureFraudBoundNonceReservation
): {
  chainID: number
  sender: string
  nonce: number
  maxFeePerGas: string
  maxPriorityFeePerGas: string
} => {
  const maxFeePerGas =
    BigInt(
      normalizePolicyUint256(feePolicy.maxFeePerGas, "Burn lane fee cap")
    ) * P2TR_SIGNATURE_FRAUD_NONCE_BURN_FEE_MULTIPLIER
  const maxPriorityFeePerGas =
    BigInt(
      normalizePolicyUint256(
        feePolicy.maxPriorityFeePerGas,
        "Burn lane priority cap"
      )
    ) * P2TR_SIGNATURE_FRAUD_NONCE_BURN_FEE_MULTIPLIER
  const gasLimit = BigInt(P2TR_SIGNATURE_FRAUD_NONCE_BURN_GAS_LIMIT)
  const maxTotalFeeWei = BigInt(
    normalizePolicyUint256(feePolicy.maxTotalFeeWei, "Burn lane total cap")
  )
  if (gasLimit * maxFeePerGas > maxTotalFeeWei) {
    throw new Error(
      "Contested nonce burn does not fit inside the committed lane fee total"
    )
  }
  return {
    chainID: requirePositiveSafeInteger(record.intent.chainID, "Burn chain ID"),
    sender: normalizeAddress(reservation.sender, "Burn sender"),
    nonce: requireNonNegativeSafeInteger(reservation.nonce, "Burn nonce"),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
  }
}

/** The exact zero-value, fixed-gas envelope authorized for the burn signer. */
const contestedNonceBurnBoundaryFeePolicy = (
  feePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy,
  envelope: ReturnType<typeof contestedNonceBurnEnvelope>
): P2TRSignatureFraudChallengeTransactionFeePolicy => ({
  ...feePolicy,
  challengeValueWei: "0",
  maxGasLimit: P2TR_SIGNATURE_FRAUD_NONCE_BURN_GAS_LIMIT.toString(),
  maxFeePerGas: envelope.maxFeePerGas,
  maxPriorityFeePerGas: envelope.maxPriorityFeePerGas,
  maxTotalFeeWei: (
    BigInt(P2TR_SIGNATURE_FRAUD_NONCE_BURN_GAS_LIMIT) *
    BigInt(envelope.maxFeePerGas)
  ).toString(),
})

const requireReservedNonce = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  label: string
): P2TRSignatureFraudBoundNonceReservation => {
  if (record.reservedNonce === undefined) {
    throw new Error(`${label} lacks its durable nonce reservation`)
  }
  return record.reservedNonce
}

const feePolicyForPreparer = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  preparer: P2TRSignatureFraudChallengeTransactionPreparer
): P2TRSignatureFraudChallengeTransactionFeePolicy => {
  validateRecordFeePolicyManifest(record)
  const normalizedManifest = normalizeChallengeFeePolicyManifestWithoutHash({
    activationManifestHash: record.feePolicyManifest.activationManifestHash,
    chainID: record.feePolicyManifest.chainID,
    challengeValueWei: record.feePolicyManifest.challengeValueWei,
    lanes: record.feePolicyManifest.lanes,
  })
  const lane = normalizedManifest.lanes.find(
    (candidate) =>
      candidate.laneID === preparer.laneID &&
      candidate.signerIdentity === preparer.signerIdentity &&
      candidate.sender ===
        normalizeAddress(
          preparer.transactionSender,
          "Configured challenge signer sender"
        )
  )
  if (lane === undefined) {
    throw new Error(
      "Configured challenge signer lane is absent from the activation fee policy"
    )
  }
  return {
    policyHash: Hex.from(record.feePolicyManifest.policyHash),
    activationManifestHash: Hex.from(normalizedManifest.activationManifestHash),
    chainID: normalizedManifest.chainID,
    challengeValueWei: normalizedManifest.challengeValueWei,
    ...lane,
  }
}

const feePolicyForReservation = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  reservation: P2TRSignatureFraudBoundNonceReservation
): P2TRSignatureFraudChallengeTransactionFeePolicy =>
  feePolicyForPreparer(record, {
    laneID: reservation.laneID,
    signerIdentity: reservation.signerIdentity,
    transactionSender: reservation.sender,
  } as P2TRSignatureFraudChallengeTransactionPreparer)

const validateNonceReleaseAcknowledgement = (
  request: P2TRSignatureFraudNonceReleaseRequest,
  acknowledgement: P2TRSignatureFraudNonceReleaseAcknowledgement
): void => {
  if (
    acknowledgement === null ||
    typeof acknowledgement !== "object" ||
    (acknowledgement.outcome !== "released" &&
      acknowledgement.outcome !== "already-released") ||
    normalizeBytes32(
      acknowledgement.releaseRequestID,
      "Nonce-release acknowledgement request ID"
    ) !==
      normalizeBytes32(request.releaseRequestID, "Nonce-release request ID") ||
    normalizeBytes32(
      acknowledgement.reservationID,
      "Nonce-release acknowledgement reservation ID"
    ) !==
      normalizeBytes32(
        request.reservation.reservationID,
        "Nonce-release reservation ID"
      )
  ) {
    throw new Error(
      "Nonce-release acknowledgement does not bind the exact request and reservation"
    )
  }
  normalizeBytes32(
    acknowledgement.responseDigest,
    "Nonce-release acknowledgement response digest"
  )
}

const optionalNonceReleaseResponseID = (
  acknowledgement: unknown,
  field: "releaseRequestID" | "reservationID" | "responseDigest"
): string | undefined => {
  if (
    acknowledgement === null ||
    typeof acknowledgement !== "object" ||
    !(field in acknowledgement)
  ) {
    return undefined
  }
  const value = (acknowledgement as Record<string, unknown>)[field]
  if (typeof value !== "string") return undefined
  try {
    return normalizeBytes32(value, `Nonce-release response ${field}`)
  } catch {
    return undefined
  }
}

const validateConfiguredSignerFeePolicies = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  preparers: readonly P2TRSignatureFraudChallengeTransactionPreparer[]
): void => {
  for (const preparer of preparers) feePolicyForPreparer(record, preparer)
}

const validatePreparedTransactionFeePolicy = (
  intent: P2TRSignatureFraudSubmissionIntent,
  policy: P2TRSignatureFraudChallengeTransactionFeePolicy,
  prepared: P2TRSignatureFraudPreparedChallengeTransaction
): P2TRSignatureFraudPreparedChallengeTransaction => {
  if (prepared.eip1559 === undefined) {
    throw new Error(
      "Prepared challenge transaction lacks EIP-1559 fee metadata"
    )
  }
  const gasLimit = BigInt(
    normalizePositivePolicyUint256(
      prepared.eip1559.gasLimit,
      "Prepared challenge gas limit"
    )
  )
  const maxFeePerGas = BigInt(
    normalizePositivePolicyUint256(
      prepared.eip1559.maxFeePerGas,
      "Prepared challenge max fee per gas"
    )
  )
  const maxPriorityFeePerGas = BigInt(
    normalizePolicyUint256(
      prepared.eip1559.maxPriorityFeePerGas,
      "Prepared challenge priority fee per gas"
    )
  )
  const manifestGasLimit = BigInt(
    normalizePositivePolicyUint256(
      policy.maxGasLimit,
      "Challenge fee policy gas limit"
    )
  )
  if (gasLimit !== manifestGasLimit) {
    throw new Error(
      "Prepared challenge transaction does not use its exact manifest-bound gas limit"
    )
  }
  if (
    policy.chainID !== intent.chainID ||
    normalizePolicyUint256(
      policy.challengeValueWei,
      "Challenge fee policy value"
    ) !== normalizePolicyUint256(intent.value, "Challenge intent value") ||
    normalizeAddress(policy.sender, "Challenge fee policy sender") !==
      normalizeAddress(prepared.sender, "Prepared challenge sender") ||
    maxFeePerGas > BigInt(policy.maxFeePerGas) ||
    maxPriorityFeePerGas > BigInt(policy.maxPriorityFeePerGas) ||
    gasLimit * maxFeePerGas > BigInt(policy.maxTotalFeeWei)
  ) {
    throw new Error(
      "Prepared challenge transaction exceeds its manifest-bound fee or value policy or does not match its manifest-bound gas limit"
    )
  }
  return prepared
}

const replacementFeePolicyInfeasibility = (
  previous: P2TRSignatureFraudPreparedChallengeTransaction,
  policy: P2TRSignatureFraudChallengeTransactionFeePolicy
): string | undefined => {
  if (previous.eip1559 === undefined) {
    throw new Error(
      "Prepared challenge transaction lacks EIP-1559 fee metadata"
    )
  }
  const previousGasLimit = BigInt(
    normalizePositivePolicyUint256(
      previous.eip1559.gasLimit,
      "Previous challenge gas limit"
    )
  )
  const requiredMaxFeePerGas = minimumReplacementFee(
    BigInt(
      normalizePositivePolicyUint256(
        previous.eip1559.maxFeePerGas,
        "Previous challenge max fee per gas"
      )
    ),
    policy.minimumReplacementFeeBumpBps
  )
  const requiredMaxPriorityFeePerGas = minimumReplacementFee(
    BigInt(
      normalizePolicyUint256(
        previous.eip1559.maxPriorityFeePerGas,
        "Previous challenge priority fee per gas"
      )
    ),
    policy.minimumReplacementFeeBumpBps
  )
  if (
    requiredMaxFeePerGas > BigInt(policy.maxFeePerGas) ||
    requiredMaxPriorityFeePerGas > BigInt(policy.maxPriorityFeePerGas) ||
    previousGasLimit * requiredMaxFeePerGas > BigInt(policy.maxTotalFeeWei)
  ) {
    return "Challenge replacement is impossible within its manifest-bound fee caps; the current signed variant remains active"
  }
  return undefined
}

const minimumReplacementFee = (
  previous: bigint,
  minimumReplacementFeeBumpBps: number
): bigint => {
  const denominator = 10_000n
  const percentageMinimum =
    (previous * (denominator + BigInt(minimumReplacementFeeBumpBps)) +
      denominator -
      1n) /
    denominator
  return percentageMinimum > previous ? percentageMinimum : previous + 1n
}

const validateIndependentTransport = (
  broadcaster: P2TRSignatureFraudRawTransactionBroadcaster,
  rechecker: P2TRSignatureFraudPreBroadcastRechecker,
  cancellationVerifier: P2TRSignatureFraudCancellationEvidenceVerifier,
  reconciler: P2TRSignatureFraudChallengeOutboxReconciler,
  canonicalVerifier: P2TRSignatureFraudCanonicalResolutionEvidenceVerifier
): void => {
  const providers = [
    broadcaster.providerIdentity,
    rechecker.providerIdentity,
    cancellationVerifier.providerIdentity,
    reconciler.providerIdentity,
    canonicalVerifier.providerIdentity,
  ]
  if (
    providers.some(
      (provider) => typeof provider !== "object" || provider === null
    )
  ) {
    throw new Error(
      "Challenge transport and evidence adapters require provider identities"
    )
  }
  const trustDomains = [
    normalizeTrustDomainID(
      broadcaster.submissionTrustDomainID,
      "Challenge broadcaster trust-domain ID"
    ),
    normalizeTrustDomainID(
      rechecker.recheckTrustDomainID,
      "Challenge pre-broadcast recheck trust-domain ID"
    ),
    normalizeTrustDomainID(
      cancellationVerifier.cancellationVerificationTrustDomainID,
      "Challenge cancellation verifier trust-domain ID"
    ),
    normalizeTrustDomainID(
      reconciler.reconciliationTrustDomainID,
      "Challenge reconciler trust-domain ID"
    ),
    normalizeTrustDomainID(
      canonicalVerifier.canonicalVerificationTrustDomainID,
      "Challenge canonical verifier trust-domain ID"
    ),
  ]
  const independenceDomains = [
    normalizeTrustDomainID(
      broadcaster.submissionIndependenceDomainID,
      "Challenge broadcaster independence-domain ID"
    ),
    normalizeTrustDomainID(
      rechecker.recheckIndependenceDomainID,
      "Challenge pre-broadcast recheck independence-domain ID"
    ),
    normalizeTrustDomainID(
      cancellationVerifier.cancellationVerificationIndependenceDomainID,
      "Challenge cancellation verifier independence-domain ID"
    ),
    normalizeTrustDomainID(
      reconciler.reconciliationIndependenceDomainID,
      "Challenge reconciler independence-domain ID"
    ),
    normalizeTrustDomainID(
      canonicalVerifier.canonicalVerificationIndependenceDomainID,
      "Challenge canonical verifier independence-domain ID"
    ),
  ]
  if (
    new Set(providers).size !== providers.length ||
    new Set(trustDomains).size !== trustDomains.length ||
    new Set(independenceDomains).size !== independenceDomains.length
  ) {
    throw new Error(
      "Challenge broadcasting, recheck, cancellation, reconciliation, and canonical verification require independent provider, trust, and infrastructure domains"
    )
  }
  requireFinalityConfirmationBlocks(
    reconciler.finalityConfirmationBlocks,
    "Challenge reconciliation finality confirmation depth"
  )
  validateCanonicalSubmissionSelectors(reconciler.canonicalSubmissionSelectors)
}

const requireFinalityConfirmationBlocks = (
  value: number,
  label: string
): number => {
  const depth = requirePositiveSafeInteger(value, label)
  if (depth < P2TR_SIGNATURE_FRAUD_OUTBOX_MIN_FINALITY_CONFIRMATION_BLOCKS) {
    throw new Error(
      `${label} must be at least ${P2TR_SIGNATURE_FRAUD_OUTBOX_MIN_FINALITY_CONFIRMATION_BLOCKS} blocks`
    )
  }
  return depth
}

const normalizeActivationManifestBinding = (
  manifest: P2TRSignatureFraudActivationManifestBinding
) => ({
  manifestHash: normalizeBytes32(
    manifest.manifestHash,
    "Activation manifest hash"
  ),
  routerCodeHash: normalizeBytes32(
    manifest.routerCodeHash,
    "Activation Router code hash"
  ),
  routerProtocolID: normalizeBytes32(
    manifest.routerProtocolID,
    "Activation Router protocol ID"
  ),
  routerDomainChainID: requirePositiveSafeInteger(
    manifest.routerDomainChainID,
    "Activation Router domain chain ID"
  ),
  completeAuthorizationRegistryAddress: normalizeAddress(
    manifest.completeAuthorizationRegistryAddress,
    "Activation COMPLETE authorization registry address"
  ),
  completeAuthorizationRegistryCodeHash: normalizeBytes32(
    manifest.completeAuthorizationRegistryCodeHash,
    "Activation COMPLETE authorization registry code hash"
  ),
  completeAuthorizationRegistryProtocolID: normalizeBytes32(
    manifest.completeAuthorizationRegistryProtocolID,
    "Activation COMPLETE authorization registry protocol ID"
  ),
  completeReservationModel: normalizeBytes32(
    manifest.completeReservationModel,
    "Activation COMPLETE reservation model"
  ),
})

const normalizePolicyUint256 = (value: string, label: string): string => {
  const normalized = normalizeUnsignedDecimal(value, label)
  const numeric = BigInt(normalized)
  if (numeric > (1n << 256n) - 1n) {
    throw new Error(`${label} exceeds uint256`)
  }
  return normalized
}

const normalizePositivePolicyUint256 = (
  value: string,
  label: string
): string => {
  const normalized = normalizePolicyUint256(value, label)
  if (BigInt(normalized) === 0n) throw new Error(`${label} must be positive`)
  return normalized
}

const normalizeChallengeFeePolicyManifestWithoutHash = (
  manifest: Omit<P2TRSignatureFraudChallengeFeePolicyManifest, "policyHash">
) => {
  if (
    !Array.isArray(manifest.lanes) ||
    manifest.lanes.length === 0 ||
    manifest.lanes.length > 32
  ) {
    throw new Error(
      "Challenge fee policy requires between one and thirty-two signer lanes"
    )
  }
  const lanes = manifest.lanes
    .map((lane) => {
      const maxGasLimit = normalizePositivePolicyUint256(
        lane.maxGasLimit,
        "Challenge fee policy gas limit"
      )
      const maxFeePerGas = normalizePositivePolicyUint256(
        lane.maxFeePerGas,
        "Challenge fee policy max fee per gas"
      )
      const maxPriorityFeePerGas = normalizePolicyUint256(
        lane.maxPriorityFeePerGas,
        "Challenge fee policy priority fee per gas"
      )
      const maxTotalFeeWei = normalizePositivePolicyUint256(
        lane.maxTotalFeeWei,
        "Challenge fee policy total fee"
      )
      const minimumReplacementFeeBumpBps = requireBoundedPositiveSafeInteger(
        lane.minimumReplacementFeeBumpBps,
        10_000,
        "Challenge replacement fee bump"
      )
      if (BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
        throw new Error("Challenge fee policy priority fee exceeds its max fee")
      }
      if (BigInt(maxTotalFeeWei) < BigInt(maxGasLimit)) {
        throw new Error(
          "Challenge fee policy total fee cannot fund its fixed gas limit"
        )
      }
      return {
        laneID: requireBoundedText(
          lane.laneID,
          P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
          "Challenge fee policy lane ID"
        ),
        signerIdentity: requireBoundedText(
          lane.signerIdentity,
          P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
          "Challenge fee policy signer identity"
        ),
        sender: normalizeAddress(lane.sender, "Challenge fee policy sender"),
        maxGasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        maxTotalFeeWei,
        minimumReplacementFeeBumpBps,
      }
    })
    .sort((left, right) => {
      const leftIdentity = `${left.laneID}:${left.signerIdentity}:${left.sender}`
      const rightIdentity = `${right.laneID}:${right.signerIdentity}:${right.sender}`
      return leftIdentity < rightIdentity
        ? -1
        : leftIdentity > rightIdentity
        ? 1
        : 0
    })
  if (
    new Set(lanes.map(({ laneID }) => laneID)).size !== lanes.length ||
    new Set(lanes.map(({ signerIdentity }) => signerIdentity)).size !==
      lanes.length ||
    new Set(lanes.map(({ sender }) => sender)).size !== lanes.length
  ) {
    throw new Error(
      "Challenge fee policy requires unique lane, signer, and sender identities"
    )
  }
  return {
    activationManifestHash: normalizeBytes32(
      manifest.activationManifestHash,
      "Challenge fee policy activation manifest hash"
    ),
    chainID: requirePositiveSafeInteger(
      manifest.chainID,
      "Challenge fee policy chain ID"
    ),
    challengeValueWei: normalizePolicyUint256(
      manifest.challengeValueWei,
      "Challenge fee policy challenge value"
    ),
    lanes,
  }
}

const validateChallengeFeePolicyManifest = (
  manifest: P2TRSignatureFraudChallengeFeePolicyManifest,
  activationManifest: P2TRSignatureFraudActivationManifestBinding,
  submissionIntent: P2TRSignatureFraudSubmissionIntentOptions
): void => {
  const { policyHash: _ignored, ...withoutHash } = manifest
  const normalized = normalizeChallengeFeePolicyManifestWithoutHash(withoutHash)
  const normalizedActivationManifest =
    normalizeActivationManifestBinding(activationManifest)
  if (
    normalizeBytes32(manifest.policyHash, "Challenge fee policy hash") !==
      computeP2TRSignatureFraudChallengeFeePolicyHash(withoutHash) ||
    normalized.activationManifestHash !==
      normalizeBytes32(
        activationManifest.manifestHash,
        "Activation manifest hash"
      ) ||
    normalized.chainID !==
      normalizePositiveSafeIntegerLike(
        submissionIntent.chainID,
        "Submission intent chain ID"
      ) ||
    normalizedActivationManifest.routerDomainChainID !==
      normalizePositiveSafeIntegerLike(
        submissionIntent.domainChainID,
        "Submission intent immutable domain chain ID"
      ) ||
    normalized.challengeValueWei !==
      normalizePolicyUint256(
        submissionIntent.challengeDepositAmount.toString(),
        "Submission challenge value"
      )
  ) {
    throw new Error(
      "Challenge fee policy does not match its activation manifest, chain, value, or canonical digest"
    )
  }
}

const validateActivationManifestBinding = (
  manifest: P2TRSignatureFraudActivationManifestBinding
): void => {
  if (manifest === undefined || typeof manifest !== "object") {
    throw new Error("Challenge outbox activation manifest is required")
  }
  const normalized = normalizeActivationManifestBinding(manifest)
  if (
    normalized.routerProtocolID !==
    normalizeBytes32(
      P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID,
      "COMPLETE_V2 protocol ID"
    )
  ) {
    throw new Error(
      "Challenge outbox activation requires the exact COMPLETE_V2 Router protocol ID"
    )
  }
}

const sameActivationManifestBinding = (
  left: P2TRSignatureFraudActivationManifestBinding,
  right: P2TRSignatureFraudActivationManifestBinding
): boolean =>
  JSON.stringify(normalizeActivationManifestBinding(left)) ===
  JSON.stringify(normalizeActivationManifestBinding(right))

const normalizeEthereumEligibilityReadSet = (
  evidence: Omit<
    P2TRSignatureFraudCanonicalEthereumEligibilityEvidence,
    "readSetHash"
  >
) => ({
  readAtBlockNumber: requireNonNegativeSafeInteger(
    evidence.readAtBlockNumber,
    "Ethereum eligibility block number"
  ),
  readAtBlockHash: normalizeBytes32(
    evidence.readAtBlockHash,
    "Ethereum eligibility block hash"
  ),
  chainID: requirePositiveSafeInteger(
    evidence.chainID,
    "Ethereum eligibility chain ID"
  ),
  routerAddress: normalizeAddress(
    evidence.routerAddress,
    "Ethereum eligibility Router address"
  ),
  routerCodeHash: normalizeBytes32(
    evidence.routerCodeHash,
    "Ethereum eligibility Router code hash"
  ),
  routerProtocolID: normalizeBytes32(
    evidence.routerProtocolID,
    "Ethereum eligibility Router protocol ID"
  ),
  routerDomainChainID: requirePositiveSafeInteger(
    evidence.routerDomainChainID,
    "Ethereum eligibility Router domain chain ID"
  ),
  routerBridgeAddress: normalizeAddress(
    evidence.routerBridgeAddress,
    "Ethereum eligibility Router Bridge address"
  ),
  routerChallengeKey: normalizeBytes32(
    evidence.routerChallengeKey,
    "Ethereum eligibility Router challenge key"
  ),
  routerChallengeAbsent: evidence.routerChallengeAbsent,
  fraudChallengeDepositAmount: normalizeUnsignedDecimal(
    evidence.fraudChallengeDepositAmount,
    "Ethereum eligibility fraud challenge deposit amount"
  ),
  completeAuthorizationRegistryAddress: normalizeAddress(
    evidence.completeAuthorizationRegistryAddress,
    "Ethereum eligibility COMPLETE authorization registry address"
  ),
  completeAuthorizationRegistryCodeHash: normalizeBytes32(
    evidence.completeAuthorizationRegistryCodeHash,
    "Ethereum eligibility COMPLETE authorization registry code hash"
  ),
  completeAuthorizationRegistryProtocolID: normalizeBytes32(
    evidence.completeAuthorizationRegistryProtocolID,
    "Ethereum eligibility COMPLETE authorization registry protocol ID"
  ),
  completeReservationModel: normalizeBytes32(
    evidence.completeReservationModel,
    "Ethereum eligibility COMPLETE reservation model"
  ),
  completeChallengeIdentity: normalizeBytes32(
    evidence.completeChallengeIdentity,
    "Ethereum eligibility COMPLETE challenge identity"
  ),
  completeWalletID: normalizeBytes32(
    evidence.completeWalletID,
    "Ethereum eligibility COMPLETE wallet ID"
  ),
  completeExactChallengeAuthorizationAbsent:
    evidence.completeExactChallengeAuthorizationAbsent,
  completeExactTransactionAuthorizationAbsent:
    evidence.completeExactTransactionAuthorizationAbsent,
  completeWalletReservationActive: evidence.completeWalletReservationActive,
  completeActiveReservationChallengeIdentity:
    evidence.completeActiveReservationChallengeIdentity === undefined
      ? undefined
      : normalizeBytes32(
          evidence.completeActiveReservationChallengeIdentity,
          "Ethereum eligibility active COMPLETE reservation challenge identity"
        ),
  walletChallengeable: evidence.walletChallengeable,
  canonicalProofBacklogComplete: evidence.canonicalProofBacklogComplete,
  activationManifestHash: normalizeBytes32(
    evidence.activationManifestHash,
    "Ethereum eligibility activation manifest hash"
  ),
})

const validateCanonicalEthereumEligibility = (
  evidence: P2TRSignatureFraudCanonicalEthereumEligibilityEvidence,
  intent: P2TRSignatureFraudSubmissionIntent,
  activationManifest: P2TRSignatureFraudActivationManifestBinding,
  checkpoint: {
    blockNumber: number
    blockHash: string
    exactBlock: boolean
  }
): void => {
  if (evidence === undefined || typeof evidence !== "object") {
    throw new Error("Canonical Ethereum eligibility evidence is required")
  }
  const normalized = normalizeEthereumEligibilityReadSet(evidence)
  const manifest = normalizeActivationManifestBinding(activationManifest)
  if (
    evidence.routerChallengeAbsent !== true ||
    evidence.completeExactChallengeAuthorizationAbsent !== true ||
    evidence.completeExactTransactionAuthorizationAbsent !== true ||
    evidence.walletChallengeable !== true ||
    evidence.canonicalProofBacklogComplete !== true
  ) {
    throw new Error(
      "Canonical Ethereum eligibility must prove exact challenge and transaction authorization absence for a challengeable wallet"
    )
  }
  if (
    typeof evidence.completeWalletReservationActive !== "boolean" ||
    (evidence.completeWalletReservationActive &&
      evidence.completeActiveReservationChallengeIdentity === undefined) ||
    (!evidence.completeWalletReservationActive &&
      evidence.completeActiveReservationChallengeIdentity !== undefined) ||
    (evidence.completeActiveReservationChallengeIdentity !== undefined &&
      normalizeBytes32(
        evidence.completeActiveReservationChallengeIdentity,
        "Active COMPLETE reservation challenge identity"
      ) ===
        normalizeBytes32(
          intent.bridgeChallengeIdentity,
          "Submission Bridge challenge identity"
        ))
  ) {
    throw new Error(
      "Canonical Ethereum eligibility must distinguish an unrelated active COMPLETE reservation from the challenged identity"
    )
  }
  if (
    normalized.chainID !== intent.chainID ||
    normalized.routerDomainChainID !== intent.domainChainID ||
    normalized.routerAddress !==
      normalizeAddress(intent.routerAddress, "Submission Router address") ||
    normalized.routerBridgeAddress !==
      normalizeAddress(intent.bridgeAddress, "Submission Bridge address") ||
    normalized.routerChallengeKey !==
      normalizeBytes32(intent.bridgeChallengeKey, "Submission challenge key") ||
    normalized.completeChallengeIdentity !==
      normalizeBytes32(
        intent.bridgeChallengeIdentity,
        "Submission Bridge challenge identity"
      ) ||
    normalized.completeWalletID !==
      normalizeBytes32(intent.walletID, "Submission wallet ID") ||
    normalized.routerCodeHash !== manifest.routerCodeHash ||
    normalized.routerProtocolID !== manifest.routerProtocolID ||
    normalized.routerDomainChainID !== manifest.routerDomainChainID ||
    normalized.completeAuthorizationRegistryAddress !==
      manifest.completeAuthorizationRegistryAddress ||
    normalized.completeAuthorizationRegistryCodeHash !==
      manifest.completeAuthorizationRegistryCodeHash ||
    normalized.completeAuthorizationRegistryProtocolID !==
      manifest.completeAuthorizationRegistryProtocolID ||
    normalized.completeReservationModel !== manifest.completeReservationModel ||
    normalized.activationManifestHash !== manifest.manifestHash
  ) {
    throw new Error(
      "Canonical Ethereum eligibility does not match the activation manifest and exact challenge identity"
    )
  }
  if (
    BigInt(normalizeUnsignedDecimal(intent.value, "Submission intent value")) <
    BigInt(normalized.fraudChallengeDepositAmount)
  ) {
    throw new Error(
      "Submission intent does not cover the finalized Bridge fraud challenge deposit"
    )
  }
  const expectedReadSetHash =
    computeP2TRSignatureFraudEthereumEligibilityReadSetHash(evidence)
  if (
    normalizeBytes32(
      evidence.readSetHash,
      "Ethereum eligibility read-set hash"
    ) !==
    normalizeBytes32(expectedReadSetHash, "Computed eligibility read-set hash")
  ) {
    throw new Error(
      "Canonical Ethereum eligibility lacks authenticated concrete adapter evidence"
    )
  }
  requireNonNegativeSafeInteger(
    checkpoint.blockNumber,
    "Eligibility checkpoint block"
  )
  const checkpointHash = normalizeBytes32(
    checkpoint.blockHash,
    "Eligibility checkpoint block hash"
  )
  if (
    (checkpoint.exactBlock &&
      (normalized.readAtBlockNumber !== checkpoint.blockNumber ||
        normalized.readAtBlockHash !== checkpointHash)) ||
    (!checkpoint.exactBlock &&
      (normalized.readAtBlockNumber < checkpoint.blockNumber ||
        (normalized.readAtBlockNumber === checkpoint.blockNumber &&
          normalized.readAtBlockHash !== checkpointHash)))
  ) {
    throw new Error(
      "Canonical Ethereum eligibility is behind or conflicts with the pinned lifecycle block"
    )
  }
}

const validatePreBroadcastRecheckResult = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  result: P2TRSignatureFraudPreBroadcastRecheckResult
): void => {
  if (result === undefined || typeof result !== "object") {
    throw new Error("Challenge pre-broadcast rechecker returned invalid data")
  }
  if (result.status !== "eligible") {
    if (
      result.status !== "unknown" &&
      result.status !== "cancelled-honest-spend" &&
      result.status !== "cancelled-reorg"
    ) {
      throw new Error(
        "Challenge pre-broadcast rechecker returned invalid status"
      )
    }
    requireReason(result.reason, "Challenge pre-broadcast recheck reason")
    if (
      result.status !== "unknown" &&
      (result.evidence === undefined || typeof result.evidence !== "object")
    ) {
      throw new Error(
        "Challenge cancellation requires structured canonical evidence"
      )
    }
    return
  }
  validateCanonicalCandidatePointer(
    result.canonicalCandidate,
    "Pre-broadcast canonical candidate"
  )
  const evidence = record.evidenceCheckpoint
  if (
    normalizeBytes32(result.canonicalCandidate.txid, "Rechecked txid") !==
      normalizeBytes32(evidence.bitcoinTxHash, "Evidence txid") ||
    normalizeBytes32(result.canonicalCandidate.wtxid, "Rechecked wtxid") !==
      normalizeBytes32(evidence.bitcoinWitnessTxHash, "Evidence wtxid") ||
    normalizeBytes32(
      result.canonicalCandidate.blockHash,
      "Rechecked Bitcoin block hash"
    ) !== normalizeBytes32(evidence.bitcoinBlockHash, "Evidence block hash") ||
    result.canonicalCandidate.blockHeight !== evidence.bitcoinBlockHeight ||
    result.canonicalCandidate.inputIndex !== evidence.bitcoinInputIndex
  ) {
    throw new Error(
      "Challenge pre-broadcast recheck does not match the persisted witness candidate"
    )
  }
  validateCanonicalEthereumEligibility(
    result.canonicalEthereumEligibility,
    record.intent,
    evidence.activationManifest,
    {
      blockNumber: evidence.ethereumLifecycleBlockNumber,
      blockHash: evidence.ethereumLifecycleBlockHash,
      exactBlock: false,
    }
  )
  if (
    !sameCanonicalProvenanceBinding(
      result.canonicalProvenance,
      record.canonicalProvenance
    )
  ) {
    throw new Error(
      "Challenge pre-broadcast recheck does not match the persisted canonical provenance fingerprint"
    )
  }
}

const normalizeCancellationEvidence = (
  evidence:
    | P2TRSignatureFraudCanonicalCancellationEvidence
    | P2TRSignatureFraudCanonicalCancellationEvidenceWithoutHash
) => {
  const common = {
    kind: evidence.kind,
    originalCandidate: {
      txid: normalizeBytes32(
        evidence.originalCandidate.txid,
        "Cancellation original txid"
      ),
      wtxid: normalizeBytes32(
        evidence.originalCandidate.wtxid,
        "Cancellation original wtxid"
      ),
      blockHash: normalizeBytes32(
        evidence.originalCandidate.blockHash,
        "Cancellation original block hash"
      ),
      blockHeight: requireNonNegativeSafeInteger(
        evidence.originalCandidate.blockHeight,
        "Cancellation original block height"
      ),
      inputIndex: requireUint32(
        evidence.originalCandidate.inputIndex,
        "Cancellation original input index"
      ),
    },
    canonicalCursor: {
      bitcoinBlockHash: normalizeBytes32(
        evidence.canonicalCursor.bitcoinBlockHash,
        "Cancellation Bitcoin cursor hash"
      ),
      bitcoinBlockHeight: requireNonNegativeSafeInteger(
        evidence.canonicalCursor.bitcoinBlockHeight,
        "Cancellation Bitcoin cursor height"
      ),
      ethereumBlockHash: normalizeBytes32(
        evidence.canonicalCursor.ethereumBlockHash,
        "Cancellation Ethereum cursor hash"
      ),
      ethereumBlockNumber: requireNonNegativeSafeInteger(
        evidence.canonicalCursor.ethereumBlockNumber,
        "Cancellation Ethereum cursor number"
      ),
    },
    agreement: {
      primaryTrustDomainID: normalizeTrustDomainID(
        evidence.agreement.primaryTrustDomainID,
        "Cancellation primary trust-domain ID"
      ),
      corroboratingTrustDomainID: normalizeTrustDomainID(
        evidence.agreement.corroboratingTrustDomainID,
        "Cancellation corroborating trust-domain ID"
      ),
      primaryIndependenceDomainID: normalizeTrustDomainID(
        evidence.agreement.primaryIndependenceDomainID,
        "Cancellation primary independence-domain ID"
      ),
      corroboratingIndependenceDomainID: normalizeTrustDomainID(
        evidence.agreement.corroboratingIndependenceDomainID,
        "Cancellation corroborating independence-domain ID"
      ),
      primaryAttestation: normalizeHexData(
        evidence.agreement.primaryAttestation,
        "Cancellation primary attestation"
      ),
      corroboratingAttestation: normalizeHexData(
        evidence.agreement.corroboratingAttestation,
        "Cancellation corroborating attestation"
      ),
      checkedAtUnixMs: requireUnixMilliseconds(
        evidence.agreement.checkedAtUnixMs,
        "Cancellation evidence check time"
      ),
    },
  }
  if (evidence.kind === "canonical-reorg") {
    return {
      ...common,
      candidateCurrent: evidence.candidateCurrent,
      replacementCanonicalTip: {
        blockHash: normalizeBytes32(
          evidence.replacementCanonicalTip.blockHash,
          "Cancellation replacement tip hash"
        ),
        blockHeight: requireNonNegativeSafeInteger(
          evidence.replacementCanonicalTip.blockHeight,
          "Cancellation replacement tip height"
        ),
      },
    }
  }
  return {
    ...common,
    conflictingOutpoint: {
      txid: normalizeBytes32(
        evidence.conflictingOutpoint.txid,
        "Cancellation conflicting outpoint txid"
      ),
      vout: requireUint32(
        evidence.conflictingOutpoint.vout,
        "Cancellation conflicting outpoint index"
      ),
    },
    canonicalSpend: {
      txid: normalizeBytes32(
        evidence.canonicalSpend.txid,
        "Cancellation canonical spend txid"
      ),
      wtxid: normalizeBytes32(
        evidence.canonicalSpend.wtxid,
        "Cancellation canonical spend wtxid"
      ),
      inputIndex: requireUint32(
        evidence.canonicalSpend.inputIndex,
        "Cancellation canonical spend input index"
      ),
      blockHash: normalizeBytes32(
        evidence.canonicalSpend.blockHash,
        "Cancellation canonical spend block hash"
      ),
      blockHeight: requireNonNegativeSafeInteger(
        evidence.canonicalSpend.blockHeight,
        "Cancellation canonical spend block height"
      ),
    },
    bridgeProofReceipt: {
      transactionHash: normalizeBytes32(
        evidence.bridgeProofReceipt.transactionHash,
        "Cancellation Bridge proof transaction hash"
      ),
      blockHash: normalizeBytes32(
        evidence.bridgeProofReceipt.blockHash,
        "Cancellation Bridge proof block hash"
      ),
      blockNumber: requireNonNegativeSafeInteger(
        evidence.bridgeProofReceipt.blockNumber,
        "Cancellation Bridge proof block number"
      ),
      logIndex: requireUint32(
        evidence.bridgeProofReceipt.logIndex,
        "Cancellation Bridge proof log index"
      ),
      proofType: requireBoundedText(
        evidence.bridgeProofReceipt.proofType,
        P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH,
        "Cancellation Bridge proof type"
      ),
    },
  }
}

const validateCancellationEvidence = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  status: "cancelled-honest-spend" | "cancelled-reorg",
  evidence: P2TRSignatureFraudCanonicalCancellationEvidence,
  primaryTrustDomainID: string,
  corroboratingTrustDomainID: string,
  primaryIndependenceDomainID: string,
  corroboratingIndependenceDomainID: string
): void => {
  const normalized = normalizeCancellationEvidence(evidence)
  const expectedKind =
    status === "cancelled-reorg" ? "canonical-reorg" : "honest-spend"
  const checkpoint = record.evidenceCheckpoint
  if (
    evidence.kind !== expectedKind ||
    normalized.agreement.primaryTrustDomainID !==
      normalizeTrustDomainID(
        primaryTrustDomainID,
        "Expected cancellation primary trust-domain ID"
      ) ||
    normalized.agreement.corroboratingTrustDomainID !==
      normalizeTrustDomainID(
        corroboratingTrustDomainID,
        "Expected cancellation corroborating trust-domain ID"
      ) ||
    normalized.agreement.primaryIndependenceDomainID !==
      normalizeTrustDomainID(
        primaryIndependenceDomainID,
        "Expected cancellation primary independence-domain ID"
      ) ||
    normalized.agreement.corroboratingIndependenceDomainID !==
      normalizeTrustDomainID(
        corroboratingIndependenceDomainID,
        "Expected cancellation corroborating independence-domain ID"
      ) ||
    normalized.agreement.primaryTrustDomainID ===
      normalized.agreement.corroboratingTrustDomainID ||
    normalized.agreement.primaryIndependenceDomainID ===
      normalized.agreement.corroboratingIndependenceDomainID ||
    normalized.agreement.primaryAttestation === "0x" ||
    normalized.agreement.corroboratingAttestation === "0x" ||
    normalized.originalCandidate.txid !==
      normalizeBytes32(checkpoint.bitcoinTxHash, "Evidence txid") ||
    normalized.originalCandidate.wtxid !==
      normalizeBytes32(checkpoint.bitcoinWitnessTxHash, "Evidence wtxid") ||
    normalized.originalCandidate.blockHash !==
      normalizeBytes32(checkpoint.bitcoinBlockHash, "Evidence block hash") ||
    normalized.originalCandidate.blockHeight !==
      checkpoint.bitcoinBlockHeight ||
    normalized.originalCandidate.inputIndex !== checkpoint.bitcoinInputIndex ||
    normalized.canonicalCursor.bitcoinBlockHeight <
      checkpoint.bitcoinCursorBlockHeight ||
    normalized.canonicalCursor.ethereumBlockNumber <
      record.canonicalEthereumEligibility.readAtBlockNumber
  ) {
    throw new Error(
      "Canonical cancellation evidence does not bind this generation and both independent source cursors"
    )
  }
  const { evidenceHash: _ignored, ...withoutHash } = evidence
  if (
    normalizeBytes32(evidence.evidenceHash, "Cancellation evidence hash") !==
    computeP2TRSignatureFraudCancellationEvidenceHash(withoutHash)
  ) {
    throw new Error(
      "Canonical cancellation evidence digest does not authenticate its fields"
    )
  }
  if (evidence.kind === "canonical-reorg") {
    if (
      evidence.candidateCurrent !== false ||
      evidence.replacementCanonicalTip.blockHeight >
        evidence.canonicalCursor.bitcoinBlockHeight ||
      (normalizeBytes32(
        evidence.replacementCanonicalTip.blockHash,
        "Cancellation replacement tip hash"
      ) === normalized.originalCandidate.blockHash &&
        evidence.replacementCanonicalTip.blockHeight ===
          normalized.originalCandidate.blockHeight)
    ) {
      throw new Error(
        "Canonical reorg evidence does not prove replacement of the original candidate epoch"
      )
    }
  } else {
    if (
      evidence.canonicalSpend.blockHeight >
        evidence.canonicalCursor.bitcoinBlockHeight ||
      evidence.bridgeProofReceipt.blockNumber >
        evidence.canonicalCursor.ethereumBlockNumber
    ) {
      throw new Error(
        "Honest-spend cancellation evidence is newer than its canonical cursors"
      )
    }
  }
}

const normalizeGenerationDisposition = (
  disposition: P2TRSignatureFraudFinalizedGenerationDisposition
) => ({
  status: disposition.status,
  observedHead: {
    blockNumber: requireNonNegativeSafeInteger(
      disposition.observedHead.blockNumber,
      "Disposition observed head number"
    ),
    blockHash: normalizeBytes32(
      disposition.observedHead.blockHash,
      "Disposition observed head hash"
    ),
  },
  finalizedThrough: {
    blockNumber: requireNonNegativeSafeInteger(
      disposition.finalizedThrough.blockNumber,
      "Disposition finalized block number"
    ),
    blockHash: normalizeBytes32(
      disposition.finalizedThrough.blockHash,
      "Disposition finalized block hash"
    ),
  },
  consensusFinalized: disposition.consensusFinalized,
  canonicalAttestations: disposition.canonicalAttestations.map(
    (attestation) => ({
      trustDomainID: normalizeTrustDomainID(
        attestation.trustDomainID,
        "Disposition attestation trust-domain ID"
      ),
      independenceDomainID: normalizeTrustDomainID(
        attestation.independenceDomainID,
        "Disposition attestation independence-domain ID"
      ),
      evidenceDigest: normalizeBytes32(
        attestation.evidenceDigest,
        "Disposition attestation evidence digest"
      ),
      attestation: normalizeHexData(
        attestation.attestation,
        "Disposition attestation"
      ),
      attestedAtUnixMs: requireUnixMilliseconds(
        attestation.attestedAtUnixMs,
        "Disposition attestation time"
      ),
    })
  ),
  routerChallenge: {
    exists: false,
    challengeKey: normalizeBytes32(
      disposition.routerChallenge.challengeKey,
      "Disposition challenge key"
    ),
    readAtBlock: requireNonNegativeSafeInteger(
      disposition.routerChallenge.readAtBlock,
      "Disposition challenge read block"
    ),
  },
  ...(disposition.status === "terminal-reverted"
    ? {
        receipt: {
          transactionHash: normalizeBytes32(
            disposition.receipt.transactionHash,
            "Disposition reverted transaction hash"
          ),
          status: disposition.receipt.status,
          blockNumber: requireNonNegativeSafeInteger(
            disposition.receipt.blockNumber,
            "Disposition receipt block number"
          ),
          blockHash: normalizeBytes32(
            disposition.receipt.blockHash,
            "Disposition receipt block hash"
          ),
        },
      }
    : {
        sender: normalizeAddress(
          disposition.sender,
          "Disposition nonce sender"
        ),
        transactionNonce: requireNonNegativeSafeInteger(
          disposition.transactionNonce,
          "Disposition transaction nonce"
        ),
        finalizedAccountNonce: requireNonNegativeSafeInteger(
          disposition.finalizedAccountNonce,
          "Disposition finalized account nonce"
        ),
        accountNonceReadAtBlock: requireNonNegativeSafeInteger(
          disposition.accountNonceReadAtBlock,
          "Disposition account nonce block"
        ),
        transactionAbsent: disposition.transactionAbsent,
        consumingTransaction: {
          transactionHash: normalizeBytes32(
            disposition.consumingTransaction.transactionHash,
            "Disposition consuming transaction hash"
          ),
          sender: normalizeAddress(
            disposition.consumingTransaction.sender,
            "Disposition consuming transaction sender"
          ),
          nonce: requireNonNegativeSafeInteger(
            disposition.consumingTransaction.nonce,
            "Disposition consuming transaction nonce"
          ),
          blockNumber: requireNonNegativeSafeInteger(
            disposition.consumingTransaction.blockNumber,
            "Disposition consuming transaction block number"
          ),
          blockHash: normalizeBytes32(
            disposition.consumingTransaction.blockHash,
            "Disposition consuming transaction block hash"
          ),
        },
      }),
})

const normalizeFinalResolutionEvidence = (
  resolution: Exclude<
    P2TRSignatureFraudChallengeOutboxResolution,
    { status: "pending" | "unknown" }
  >
): unknown => {
  const common = {
    status: resolution.status,
    observedHead: normalizeCanonicalBlockForDigest(
      resolution.observedHead,
      "Resolution observed head"
    ),
    finalizedThrough: normalizeCanonicalBlockForDigest(
      resolution.finalizedThrough,
      "Resolution finalized boundary"
    ),
    consensusFinalized: resolution.consensusFinalized,
    routerChallenge:
      resolution.routerChallenge.exists === false
        ? {
            exists: false,
            challengeKey: normalizeBytes32(
              resolution.routerChallenge.challengeKey,
              "Resolution Router challenge key"
            ),
            readAtBlock: requireNonNegativeSafeInteger(
              resolution.routerChallenge.readAtBlock,
              "Resolution Router challenge read block"
            ),
          }
        : {
            exists: true,
            challengeKey: normalizeBytes32(
              resolution.routerChallenge.challengeKey,
              "Resolution Router challenge key"
            ),
            challenger: normalizeAddress(
              resolution.routerChallenge.challenger,
              "Resolution Router challenger"
            ),
            depositAmount: normalizeUnsignedDecimal(
              resolution.routerChallenge.depositAmount,
              "Resolution Router challenge deposit"
            ),
            reportedAt: requirePositiveSafeInteger(
              resolution.routerChallenge.reportedAt,
              "Resolution Router challenge report time"
            ),
            resolved: resolution.routerChallenge.resolved,
            readAtBlock: requireNonNegativeSafeInteger(
              resolution.routerChallenge.readAtBlock,
              "Resolution Router challenge read block"
            ),
          },
  }

  if (resolution.status === "terminal-nonce-consumed") {
    return {
      ...common,
      sender: normalizeAddress(resolution.sender, "Resolution nonce sender"),
      transactionNonce: requireNonNegativeSafeInteger(
        resolution.transactionNonce,
        "Resolution transaction nonce"
      ),
      finalizedAccountNonce: requireNonNegativeSafeInteger(
        resolution.finalizedAccountNonce,
        "Resolution finalized account nonce"
      ),
      accountNonceReadAtBlock: requireNonNegativeSafeInteger(
        resolution.accountNonceReadAtBlock,
        "Resolution account nonce read block"
      ),
      transactionAbsent: resolution.transactionAbsent,
      consumingTransaction: normalizeCanonicalNonceTransactionForDigest(
        resolution.consumingTransaction,
        "Resolution nonce-consuming transaction"
      ),
    }
  }

  if (resolution.status === "terminal-reverted") {
    return {
      ...common,
      receipt: normalizeCanonicalReceiptForDigest(
        resolution.receipt,
        "Resolution reverted receipt"
      ),
    }
  }

  return {
    ...common,
    receipt: normalizeCanonicalReceiptForDigest(
      resolution.receipt,
      "Resolution accepted receipt"
    ),
    transaction: {
      transactionHash: normalizeBytes32(
        resolution.transaction.transactionHash,
        "Resolution accepted transaction hash"
      ),
      sender: normalizeAddress(
        resolution.transaction.sender,
        "Resolution accepted transaction sender"
      ),
      routerAddress: normalizeAddress(
        resolution.transaction.routerAddress,
        "Resolution accepted Router address"
      ),
      calldata: normalizeHexData(
        resolution.transaction.calldata,
        "Resolution accepted calldata"
      ),
      value: normalizeUnsignedDecimal(
        resolution.transaction.value,
        "Resolution accepted value"
      ),
      nonce: requireNonNegativeSafeInteger(
        resolution.transaction.nonce,
        "Resolution accepted transaction nonce"
      ),
      chainID: requirePositiveSafeInteger(
        resolution.transaction.chainID,
        "Resolution accepted chain ID"
      ),
      blockNumber: requireNonNegativeSafeInteger(
        resolution.transaction.blockNumber,
        "Resolution accepted block number"
      ),
      blockHash: normalizeBytes32(
        resolution.transaction.blockHash,
        "Resolution accepted block hash"
      ),
      decodedSubmissionCall: {
        variant: resolution.transaction.decodedSubmissionCall.variant,
        selector: normalizeFixedBytes(
          resolution.transaction.decodedSubmissionCall.selector,
          4,
          "Resolution submission selector"
        ),
        action: resolution.transaction.decodedSubmissionCall.action,
        walletID: normalizeBytes32(
          resolution.transaction.decodedSubmissionCall.walletID,
          "Resolution submission wallet ID"
        ),
        bridgeChallengeIdentity: normalizeBytes32(
          resolution.transaction.decodedSubmissionCall.bridgeChallengeIdentity,
          "Resolution submission challenge identity"
        ),
        challengeKey: normalizeBytes32(
          resolution.transaction.decodedSubmissionCall.challengeKey,
          "Resolution submission challenge key"
        ),
        sighash: normalizeBytes32(
          resolution.transaction.decodedSubmissionCall.sighash,
          "Resolution submission sighash"
        ),
      },
    },
    submittedEvent: {
      routerAddress: normalizeAddress(
        resolution.submittedEvent.routerAddress,
        "Resolution event Router address"
      ),
      transactionHash: normalizeBytes32(
        resolution.submittedEvent.transactionHash,
        "Resolution event transaction hash"
      ),
      blockNumber: requireNonNegativeSafeInteger(
        resolution.submittedEvent.blockNumber,
        "Resolution event block number"
      ),
      blockHash: normalizeBytes32(
        resolution.submittedEvent.blockHash,
        "Resolution event block hash"
      ),
      blockTimestamp: requirePositiveSafeInteger(
        resolution.submittedEvent.blockTimestamp,
        "Resolution event block timestamp"
      ),
      logIndex: requireNonNegativeSafeInteger(
        resolution.submittedEvent.logIndex,
        "Resolution event log index"
      ),
      walletID: normalizeBytes32(
        resolution.submittedEvent.walletID,
        "Resolution event wallet ID"
      ),
      walletPubKeyHash: normalizeBytes20(
        resolution.submittedEvent.walletPubKeyHash,
        "Resolution event wallet pubkey hash"
      ),
      bridgeChallengeIdentity: normalizeBytes32(
        resolution.submittedEvent.bridgeChallengeIdentity,
        "Resolution event challenge identity"
      ),
      challengeKey: normalizeBytes32(
        resolution.submittedEvent.challengeKey,
        "Resolution event challenge key"
      ),
      sighash: normalizeBytes32(
        resolution.submittedEvent.sighash,
        "Resolution event sighash"
      ),
    },
    ownTransactionDisposition:
      resolution.ownTransactionDisposition === undefined
        ? undefined
        : normalizeOwnTransactionDispositionForDigest(
            resolution.ownTransactionDisposition
          ),
  }
}

const normalizeCanonicalBlockForDigest = (
  block: P2TRSignatureFraudCanonicalBlock,
  label: string
) => ({
  blockNumber: requireNonNegativeSafeInteger(
    block.blockNumber,
    `${label} number`
  ),
  blockHash: normalizeBytes32(block.blockHash, `${label} hash`),
})

const normalizeCanonicalReceiptForDigest = (
  receipt: P2TRSignatureFraudCanonicalReceipt,
  label: string
) => ({
  transactionHash: normalizeBytes32(
    receipt.transactionHash,
    `${label} transaction hash`
  ),
  status: receipt.status,
  blockNumber: requireNonNegativeSafeInteger(
    receipt.blockNumber,
    `${label} block number`
  ),
  blockHash: normalizeBytes32(receipt.blockHash, `${label} block hash`),
})

const normalizeCanonicalNonceTransactionForDigest = (
  transaction: P2TRSignatureFraudCanonicalNonceConsumingTransaction,
  label: string
) => ({
  transactionHash: normalizeBytes32(
    transaction.transactionHash,
    `${label} hash`
  ),
  sender: normalizeAddress(transaction.sender, `${label} sender`),
  nonce: requireNonNegativeSafeInteger(transaction.nonce, `${label} nonce`),
  blockNumber: requireNonNegativeSafeInteger(
    transaction.blockNumber,
    `${label} block number`
  ),
  blockHash: normalizeBytes32(transaction.blockHash, `${label} block hash`),
})

const normalizeOwnTransactionDispositionForDigest = (
  disposition: P2TRSignatureFraudOwnTransactionDisposition
): unknown =>
  disposition.status === "reverted"
    ? {
        status: disposition.status,
        receipt: normalizeCanonicalReceiptForDigest(
          disposition.receipt,
          "Own reverted receipt"
        ),
      }
    : {
        status: disposition.status,
        sender: normalizeAddress(disposition.sender, "Own nonce sender"),
        transactionNonce: requireNonNegativeSafeInteger(
          disposition.transactionNonce,
          "Own transaction nonce"
        ),
        finalizedAccountNonce: requireNonNegativeSafeInteger(
          disposition.finalizedAccountNonce,
          "Own finalized account nonce"
        ),
        accountNonceReadAtBlock: requireNonNegativeSafeInteger(
          disposition.accountNonceReadAtBlock,
          "Own account nonce read block"
        ),
        transactionAbsent: disposition.transactionAbsent,
        consumingTransaction: normalizeCanonicalNonceTransactionForDigest(
          disposition.consumingTransaction,
          "Own nonce-consuming transaction"
        ),
      }

const validateCanonicalNonceConsumingTransaction = (
  transaction: P2TRSignatureFraudCanonicalNonceConsumingTransaction,
  finalizedThrough: P2TRSignatureFraudCanonicalBlock
): void => {
  normalizeBytes32(
    transaction.transactionHash,
    "Canonical nonce-consuming transaction hash"
  )
  normalizeAddress(
    transaction.sender,
    "Canonical nonce-consuming transaction sender"
  )
  requireNonNegativeSafeInteger(
    transaction.nonce,
    "Canonical nonce-consuming transaction nonce"
  )
  validateCanonicalBlock(transaction, "Canonical nonce-consuming transaction")
  if (transaction.blockNumber > finalizedThrough.blockNumber) {
    throw new Error(
      "Canonical nonce-consuming transaction is newer than the finalized boundary"
    )
  }
}

const validateStructuredResolution = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  resolution: P2TRSignatureFraudChallengeOutboxResolution,
  finalityConfirmationBlocks: number,
  canonicalSubmissionSelectors: P2TRSignatureFraudChallengeOutboxReconciler["canonicalSubmissionSelectors"]
): void => {
  if (resolution === undefined || typeof resolution !== "object") {
    throw new Error("Challenge reconciler returned an invalid result")
  }
  if (resolution.status === "pending" || resolution.status === "unknown") {
    requireReason(resolution.reason, "Challenge reconciliation reason")
    return
  }
  const variants =
    record.preparedTransactionVariants === undefined
      ? []
      : validatePreparedTransactionVariantLedger(record)
  const signedTransactions = [
    ...variants.map(({ preparedTransaction }) => preparedTransaction),
    ...(record.unexpectedSignedArtifacts ?? []).map(
      ({ preparedTransaction }) => preparedTransaction
    ),
  ]
  const expectedPreparedHashes = new Set(
    variants.map(({ preparedTransaction }) =>
      normalizeBytes32(
        preparedTransaction.transactionHash,
        "Prepared transaction variant hash"
      )
    )
  )
  const preparedHashes = new Set(
    signedTransactions.map((preparedTransaction) =>
      normalizeBytes32(
        preparedTransaction.transactionHash,
        "Prepared transaction variant hash"
      )
    )
  )

  if (
    resolution.status !== "external-satisfied-awaiting-own-transaction" &&
    signedTransactions.length > 0
  ) {
    const protectedLane = record.reservedNonce
    if (
      protectedLane === undefined ||
      signedTransactions.some(
        (transaction) =>
          (transaction.chainID !== undefined &&
            transaction.chainID !== record.intent.chainID) ||
          normalizeAddress(
            transaction.sender,
            "Signed terminal artifact sender"
          ) !==
            normalizeAddress(
              protectedLane.sender,
              "Protected terminal nonce sender"
            ) ||
          transaction.nonce !== protectedLane.nonce
      )
    ) {
      throw new Error(
        "Canonical terminal resolution must resolve every escaped signed sender/nonce lane"
      )
    }
  }
  validateCanonicalBlock(
    resolution.observedHead,
    "Observed reconciliation head"
  )
  validateCanonicalBlock(
    resolution.finalizedThrough,
    "Finalized reconciliation boundary"
  )
  if (resolution.consensusFinalized !== true) {
    throw new Error(
      "Canonical reconciliation boundary must be Ethereum consensus-finalized"
    )
  }
  validateCanonicalEvidenceAttestations(
    resolution.canonicalAttestations,
    computeP2TRSignatureFraudResolutionEvidenceDigest(resolution)
  )
  if (
    resolution.observedHead.blockNumber -
      resolution.finalizedThrough.blockNumber <
    finalityConfirmationBlocks
  ) {
    throw new Error(
      "Canonical reconciliation boundary has not reached the required finality depth"
    )
  }
  if (
    resolution.observedHead.blockNumber ===
      resolution.finalizedThrough.blockNumber &&
    normalizeBytes32(
      resolution.observedHead.blockHash,
      "Observed reconciliation head hash"
    ) !==
      normalizeBytes32(
        resolution.finalizedThrough.blockHash,
        "Finalized reconciliation boundary hash"
      )
  ) {
    throw new Error("Canonical reconciliation heads disagree at one height")
  }

  const expectedChallengeKey = normalizeBytes32(
    record.intent.bridgeChallengeKey,
    "Submission intent Bridge challenge key"
  )
  if (
    normalizeBytes32(
      resolution.routerChallenge.challengeKey,
      "Canonical Router challenge key"
    ) !== expectedChallengeKey
  ) {
    throw new Error(
      "Canonical Router challenge key does not match the outbox intent"
    )
  }
  if (
    resolution.routerChallenge.readAtBlock !==
    resolution.finalizedThrough.blockNumber
  ) {
    throw new Error(
      "Canonical Router challenge state must be read at the finalized head"
    )
  }

  if (resolution.status === "terminal-nonce-consumed") {
    const protectedLane = record.reservedNonce ?? signedTransactions[0]
    if (protectedLane === undefined) {
      throw new Error(
        "Canonical nonce disposition has no durable protected nonce lane"
      )
    }
    if (
      signedTransactions.some(
        (transaction) =>
          normalizeAddress(transaction.sender, "Signed artifact sender") !==
            normalizeAddress(protectedLane.sender, "Protected nonce sender") ||
          transaction.nonce !== protectedLane.nonce
      )
    ) {
      throw new Error(
        "Canonical nonce disposition must resolve every escaped signed nonce lane"
      )
    }
    validateCanonicalNonceConsumingTransaction(
      resolution.consumingTransaction,
      resolution.finalizedThrough
    )
    if (
      resolution.routerChallenge.exists !== false ||
      resolution.transactionAbsent !== true ||
      normalizeAddress(resolution.sender, "Canonical transaction sender") !==
        normalizeAddress(protectedLane.sender, "Protected nonce sender") ||
      resolution.transactionNonce !== protectedLane.nonce ||
      resolution.accountNonceReadAtBlock !==
        resolution.finalizedThrough.blockNumber ||
      !Number.isSafeInteger(resolution.finalizedAccountNonce) ||
      resolution.finalizedAccountNonce <= protectedLane.nonce ||
      normalizeAddress(
        resolution.consumingTransaction.sender,
        "Canonical nonce-consuming sender"
      ) !== normalizeAddress(protectedLane.sender, "Protected nonce sender") ||
      resolution.consumingTransaction.nonce !== protectedLane.nonce ||
      expectedPreparedHashes.has(
        normalizeBytes32(
          resolution.consumingTransaction.transactionHash,
          "Canonical nonce-consuming transaction hash"
        )
      )
    ) {
      throw new Error(
        "Canonical nonce-consumed resolution does not prove the prepared transaction impossible"
      )
    }
    return
  }

  validateCanonicalReceipt(resolution.receipt)
  if (
    resolution.receipt.blockNumber > resolution.finalizedThrough.blockNumber
  ) {
    throw new Error(
      "Canonical transaction receipt is newer than the finalized boundary"
    )
  }

  if (resolution.status === "terminal-reverted") {
    if (
      resolution.receipt.status !== 0 ||
      resolution.routerChallenge.exists !== false ||
      !preparedHashes.has(
        normalizeBytes32(
          resolution.receipt.transactionHash,
          "Canonical reverted transaction hash"
        )
      )
    ) {
      throw new Error(
        "Canonical reverted resolution does not terminate the prepared transaction"
      )
    }
    return
  }

  if (
    resolution.receipt.status !== 1 ||
    resolution.routerChallenge.exists !== true ||
    !Number.isSafeInteger(resolution.routerChallenge.reportedAt) ||
    resolution.routerChallenge.reportedAt <= 0
  ) {
    throw new Error(
      "Canonical accepted resolution requires an existing Router challenge and successful receipt"
    )
  }
  validateSubmittedEvent(record.intent, resolution.submittedEvent)
  if (
    resolution.submittedEvent.blockNumber <
    record.evidenceCheckpoint.submittedEventScanFromBlock
  ) {
    throw new Error(
      "Canonical submitted event predates the configured complete scan floor"
    )
  }
  validateCanonicalAcceptedTransaction(
    record.intent,
    resolution.transaction,
    resolution.status === "accepted-own",
    canonicalSubmissionSelectors
  )
  if (
    normalizeBytes32(
      resolution.receipt.transactionHash,
      "Canonical accepted transaction hash"
    ) !==
      normalizeBytes32(
        resolution.submittedEvent.transactionHash,
        "Submitted event transaction hash"
      ) ||
    resolution.receipt.blockNumber !== resolution.submittedEvent.blockNumber ||
    normalizeBytes32(
      resolution.receipt.blockHash,
      "Canonical accepted receipt block hash"
    ) !==
      normalizeBytes32(
        resolution.submittedEvent.blockHash,
        "Submitted event block hash"
      ) ||
    normalizeBytes32(
      resolution.receipt.transactionHash,
      "Canonical accepted transaction hash"
    ) !==
      normalizeBytes32(
        resolution.transaction.transactionHash,
        "Canonical accepted transaction hash"
      ) ||
    resolution.receipt.blockNumber !== resolution.transaction.blockNumber ||
    normalizeBytes32(
      resolution.receipt.blockHash,
      "Canonical accepted receipt block hash"
    ) !==
      normalizeBytes32(
        resolution.transaction.blockHash,
        "Canonical accepted transaction block hash"
      )
  ) {
    throw new Error(
      "Canonical accepted receipt does not contain the exact submitted event"
    )
  }
  if (
    resolution.transaction.blockNumber >
      resolution.finalizedThrough.blockNumber ||
    resolution.submittedEvent.blockNumber >
      resolution.finalizedThrough.blockNumber
  ) {
    throw new Error(
      "Canonical accepted transaction is newer than the finalized boundary"
    )
  }
  const isOwn = preparedHashes.has(
    normalizeBytes32(
      resolution.receipt.transactionHash,
      "Canonical accepted transaction hash"
    )
  )
  const ownSignedTransaction = signedTransactions.find(
    (transaction) =>
      normalizeBytes32(
        transaction.transactionHash,
        "Signed artifact transaction hash"
      ) ===
      normalizeBytes32(
        resolution.receipt.transactionHash,
        "Canonical accepted transaction hash"
      )
  )
  if (
    normalizeAddress(
      resolution.routerChallenge.challenger,
      "Canonical Router challenger"
    ) !==
      normalizeAddress(
        resolution.transaction.sender,
        "Canonical accepted transaction sender"
      ) ||
    normalizeUnsignedDecimal(
      resolution.routerChallenge.depositAmount,
      "Canonical Router challenge deposit"
    ) !==
      normalizeUnsignedDecimal(
        resolution.transaction.value,
        "Canonical accepted transaction value"
      ) ||
    resolution.routerChallenge.reportedAt !==
      resolution.submittedEvent.blockTimestamp
  ) {
    throw new Error(
      "Canonical accepted transaction does not match Router challenge state"
    )
  }
  if (
    (resolution.status === "accepted-own" && !isOwn) ||
    ((resolution.status === "satisfied-external" ||
      resolution.status === "external-satisfied-awaiting-own-transaction") &&
      isOwn)
  ) {
    throw new Error(
      "Canonical accepted resolution misclassifies transaction ownership"
    )
  }
  if (
    isOwn &&
    ownSignedTransaction !== undefined &&
    (normalizeAddress(
      resolution.transaction.sender,
      "Canonical accepted transaction sender"
    ) !==
      normalizeAddress(
        ownSignedTransaction.sender,
        "Signed artifact transaction sender"
      ) ||
      resolution.transaction.nonce !== ownSignedTransaction.nonce)
  ) {
    throw new Error(
      "Canonical own transaction sender or nonce does not match the prepared transaction"
    )
  }
  validateExternalOwnTransactionDisposition(record, resolution, isOwn)
}

const validateCanonicalEvidenceAttestations = (
  attestations: readonly P2TRSignatureFraudCanonicalEvidenceAttestation[],
  expectedEvidenceDigest: string
): void => {
  if (!Array.isArray(attestations) || attestations.length !== 2) {
    throw new Error(
      "Canonical resolution requires exactly two independent attestations"
    )
  }
  const [first, second] = attestations
  const firstTrust = normalizeTrustDomainID(
    first.trustDomainID,
    "Canonical attestation trust-domain ID"
  )
  const secondTrust = normalizeTrustDomainID(
    second.trustDomainID,
    "Canonical attestation trust-domain ID"
  )
  const firstIndependence = normalizeTrustDomainID(
    first.independenceDomainID,
    "Canonical attestation independence-domain ID"
  )
  const secondIndependence = normalizeTrustDomainID(
    second.independenceDomainID,
    "Canonical attestation independence-domain ID"
  )
  if (
    firstTrust === secondTrust ||
    firstIndependence === secondIndependence ||
    normalizeBytes32(first.evidenceDigest, "Canonical evidence digest") !==
      normalizeBytes32(second.evidenceDigest, "Canonical evidence digest") ||
    normalizeBytes32(first.evidenceDigest, "Canonical evidence digest") !==
      normalizeBytes32(
        expectedEvidenceDigest,
        "Computed canonical evidence digest"
      ) ||
    normalizeHexData(first.attestation, "Canonical evidence attestation") ===
      "0x" ||
    normalizeHexData(second.attestation, "Canonical evidence attestation") ===
      "0x"
  ) {
    throw new Error(
      "Canonical resolution attestations must agree across distinct trust and independence domains"
    )
  }
  requireUnixMilliseconds(
    first.attestedAtUnixMs,
    "Canonical evidence attestation time"
  )
  requireUnixMilliseconds(
    second.attestedAtUnixMs,
    "Canonical evidence attestation time"
  )
}

const validateCanonicalResolutionEvidenceVerification = (
  resolution: Exclude<
    P2TRSignatureFraudChallengeOutboxResolution,
    { status: "pending" | "unknown" }
  >,
  verification: P2TRSignatureFraudCanonicalResolutionEvidenceVerification,
  reconciler: P2TRSignatureFraudChallengeOutboxReconciler,
  verifier: P2TRSignatureFraudCanonicalResolutionEvidenceVerifier
): void => {
  if (verification?.status !== "verified") {
    throw new Error(
      "Independent canonical resolution verifier did not authenticate the evidence"
    )
  }
  const expectedDigest =
    computeP2TRSignatureFraudResolutionEvidenceDigest(resolution)
  const [primary, corroborating] = resolution.canonicalAttestations
  if (
    normalizeTrustDomainID(
      primary.trustDomainID,
      "Primary canonical attestation trust-domain ID"
    ) !==
      normalizeTrustDomainID(
        reconciler.reconciliationTrustDomainID,
        "Configured reconciliation trust-domain ID"
      ) ||
    normalizeTrustDomainID(
      primary.independenceDomainID,
      "Primary canonical attestation independence-domain ID"
    ) !==
      normalizeTrustDomainID(
        reconciler.reconciliationIndependenceDomainID,
        "Configured reconciliation independence-domain ID"
      ) ||
    normalizeTrustDomainID(
      corroborating.trustDomainID,
      "Corroborating canonical attestation trust-domain ID"
    ) !==
      normalizeTrustDomainID(
        verifier.canonicalVerificationTrustDomainID,
        "Configured canonical verifier trust-domain ID"
      ) ||
    normalizeTrustDomainID(
      corroborating.independenceDomainID,
      "Corroborating canonical attestation independence-domain ID"
    ) !==
      normalizeTrustDomainID(
        verifier.canonicalVerificationIndependenceDomainID,
        "Configured canonical verifier independence-domain ID"
      ) ||
    normalizeTrustDomainID(
      verification.trustDomainID,
      "Canonical verification trust-domain ID"
    ) !==
      normalizeTrustDomainID(
        verifier.canonicalVerificationTrustDomainID,
        "Configured canonical verifier trust-domain ID"
      ) ||
    normalizeTrustDomainID(
      verification.independenceDomainID,
      "Canonical verification independence-domain ID"
    ) !==
      normalizeTrustDomainID(
        verifier.canonicalVerificationIndependenceDomainID,
        "Configured canonical verifier independence-domain ID"
      ) ||
    normalizeBytes32(
      verification.evidenceDigest,
      "Canonical verification evidence digest"
    ) !== normalizeBytes32(expectedDigest, "Canonical resolution digest") ||
    normalizeHexData(
      verification.attestation,
      "Canonical verification attestation"
    ) !==
      normalizeHexData(
        corroborating.attestation,
        "Corroborating canonical attestation"
      ) ||
    requireUnixMilliseconds(
      verification.verifiedAtUnixMs,
      "Canonical verification time"
    ) < corroborating.attestedAtUnixMs
  ) {
    throw new Error(
      "Independent canonical verifier did not confirm the exact configured evidence attestation"
    )
  }
}

const validateCanonicalAcceptedTransaction = (
  intent: P2TRSignatureFraudSubmissionIntent,
  transaction: P2TRSignatureFraudCanonicalTransaction,
  requireExactIntent: boolean,
  canonicalSubmissionSelectors: P2TRSignatureFraudChallengeOutboxReconciler["canonicalSubmissionSelectors"]
): void => {
  validateCanonicalBlock(transaction, "Canonical accepted transaction block")
  normalizeBytes32(
    transaction.transactionHash,
    "Canonical accepted transaction hash"
  )
  requireNonNegativeSafeInteger(
    transaction.nonce,
    "Canonical accepted transaction nonce"
  )
  validateDecodedSubmissionCall(
    intent,
    transaction.decodedSubmissionCall,
    canonicalSubmissionSelectors
  )
  if (
    transaction.chainID !== intent.chainID ||
    normalizeAddress(
      transaction.routerAddress,
      "Canonical accepted transaction Router address"
    ) !==
      normalizeAddress(intent.routerAddress, "Submission intent Router address")
  ) {
    throw new Error(
      "Canonical accepted transaction does not match the durable call intent"
    )
  }
  const transactionValue = normalizeUnsignedDecimal(
    transaction.value,
    "Canonical accepted transaction value"
  )
  const intentValue = normalizeUnsignedDecimal(
    intent.value,
    "Submission intent value"
  )
  const exactIntentMismatch =
    normalizeHexData(
      transaction.calldata,
      "Canonical accepted transaction calldata"
    ) !== normalizeHexData(intent.calldata, "Submission intent calldata") ||
    transactionValue !== intentValue
  if (requireExactIntent && exactIntentMismatch) {
    throw new Error(
      "Canonical own transaction does not match the durable call intent"
    )
  }
  normalizeAddress(transaction.sender, "Canonical accepted transaction sender")
}

const validateDecodedSubmissionCall = (
  intent: P2TRSignatureFraudSubmissionIntent,
  call: P2TRSignatureFraudDecodedSubmissionCall,
  canonicalSubmissionSelectors: P2TRSignatureFraudChallengeOutboxReconciler["canonicalSubmissionSelectors"]
): void => {
  if (
    call === undefined ||
    (call.variant !== "router-process" && call.variant !== "router-direct") ||
    call.action !== "submit"
  ) {
    throw new Error(
      "Canonical transaction was not decoded as an allowed P2TR submission call"
    )
  }
  normalizeFixedBytes(call.selector, 4, "Canonical submission selector")
  if (
    !canonicalSubmissionSelectors.some(
      (allowed) =>
        allowed.variant === call.variant &&
        normalizeFixedBytes(
          allowed.selector,
          4,
          "Allowed canonical submission selector"
        ) ===
          normalizeFixedBytes(call.selector, 4, "Canonical submission selector")
    )
  ) {
    throw new Error("Canonical submission selector is not ABI-allowlisted")
  }
  if (
    normalizeBytes32(call.walletID, "Decoded submission wallet ID") !==
      normalizeBytes32(intent.walletID, "Submission intent wallet ID") ||
    normalizeBytes32(
      call.bridgeChallengeIdentity,
      "Decoded Bridge challenge identity"
    ) !==
      normalizeBytes32(
        intent.bridgeChallengeIdentity,
        "Submission intent Bridge challenge identity"
      ) ||
    normalizeBytes32(call.challengeKey, "Decoded challenge key") !==
      normalizeBytes32(intent.bridgeChallengeKey, "Submission challenge key") ||
    normalizeBytes32(call.sighash, "Decoded submission sighash") !==
      normalizeBytes32(intent.sighash, "Submission intent sighash")
  ) {
    throw new Error(
      "Canonical decoded submission call does not match the durable challenge identity"
    )
  }
}

const validateCanonicalSubmissionSelectors = (
  selectors: P2TRSignatureFraudChallengeOutboxReconciler["canonicalSubmissionSelectors"]
): void => {
  if (
    !Array.isArray(selectors) ||
    selectors.length === 0 ||
    selectors.length > 16
  ) {
    throw new Error(
      "Challenge reconciler requires between one and sixteen canonical submission selectors"
    )
  }
  const normalized = new Set<string>()
  for (const selector of selectors) {
    if (
      selector === undefined ||
      (selector.variant !== "router-process" &&
        selector.variant !== "router-direct")
    ) {
      throw new Error("Challenge reconciler has an invalid submission selector")
    }
    const key = `${selector.variant}:${normalizeFixedBytes(
      selector.selector,
      4,
      "Canonical submission selector"
    )}`
    if (normalized.has(key)) {
      throw new Error(
        "Challenge reconciler has a duplicate submission selector"
      )
    }
    normalized.add(key)
  }
}

const validateExternalOwnTransactionDisposition = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  resolution: Extract<
    P2TRSignatureFraudChallengeOutboxResolution,
    {
      status:
        | "accepted-own"
        | "satisfied-external"
        | "external-satisfied-awaiting-own-transaction"
    }
  >,
  isOwn: boolean
): void => {
  const disposition = resolution.ownTransactionDisposition
  if (isOwn) {
    if (disposition !== undefined) {
      throw new Error(
        "Canonical own acceptance cannot include an external-satisfaction disposition"
      )
    }
    return
  }
  if (resolution.status === "external-satisfied-awaiting-own-transaction") {
    if (disposition !== undefined) {
      throw new Error(
        "External-awaiting resolution requires an unresolved prepared nonce"
      )
    }
    if (record.reservedNonce === undefined) {
      throw new Error(
        "External-awaiting resolution requires a durable nonce reservation"
      )
    }
    return
  }
  if (resolution.status !== "satisfied-external") {
    return
  }
  if (disposition === undefined) {
    throw new Error(
      "External satisfaction cannot release the nonce lane before the own transaction is resolved"
    )
  }
  const variants =
    record.preparedTransactionVariants === undefined
      ? []
      : validatePreparedTransactionVariantLedger(record)
  const signedTransactions = [
    ...variants.map(({ preparedTransaction }) => preparedTransaction),
    ...(record.unexpectedSignedArtifacts ?? []).map(
      ({ preparedTransaction }) => preparedTransaction
    ),
  ]
  const protectedLane = record.reservedNonce ?? signedTransactions[0]
  if (protectedLane === undefined) {
    throw new Error(
      "External satisfaction has no durable own nonce lane to resolve"
    )
  }
  const preparedHashes = new Set(
    signedTransactions.map((preparedTransaction) =>
      normalizeBytes32(
        preparedTransaction.transactionHash,
        "Prepared transaction variant hash"
      )
    )
  )
  const expectedPreparedHashes = new Set(
    variants.map(({ preparedTransaction }) =>
      normalizeBytes32(
        preparedTransaction.transactionHash,
        "Prepared transaction variant hash"
      )
    )
  )
  if (disposition.status === "reverted") {
    validateCanonicalReceipt(disposition.receipt)
    if (
      disposition.receipt.status !== 0 ||
      disposition.receipt.blockNumber >
        resolution.finalizedThrough.blockNumber ||
      !preparedHashes.has(
        normalizeBytes32(
          disposition.receipt.transactionHash,
          "Own reverted transaction hash"
        )
      )
    ) {
      throw new Error(
        "External satisfaction does not prove the own transaction reverted"
      )
    }
    return
  }
  if (
    disposition.transactionAbsent !== true ||
    normalizeAddress(disposition.sender, "Own nonce disposition sender") !==
      normalizeAddress(protectedLane.sender, "Protected nonce sender") ||
    disposition.transactionNonce !== protectedLane.nonce ||
    disposition.accountNonceReadAtBlock !==
      resolution.finalizedThrough.blockNumber ||
    !Number.isSafeInteger(disposition.finalizedAccountNonce) ||
    disposition.finalizedAccountNonce <= protectedLane.nonce ||
    signedTransactions.some(
      (transaction) =>
        (transaction.chainID !== undefined &&
          transaction.chainID !== record.intent.chainID) ||
        normalizeAddress(transaction.sender, "Signed artifact sender") !==
          normalizeAddress(protectedLane.sender, "Protected nonce sender") ||
        transaction.nonce !== protectedLane.nonce
    )
  ) {
    throw new Error(
      "External satisfaction does not prove the own transaction nonce consumed"
    )
  }
  validateCanonicalNonceConsumingTransaction(
    disposition.consumingTransaction,
    resolution.finalizedThrough
  )
  if (
    normalizeAddress(
      disposition.consumingTransaction.sender,
      "Own nonce-consuming transaction sender"
    ) !== normalizeAddress(protectedLane.sender, "Protected nonce sender") ||
    disposition.consumingTransaction.nonce !== protectedLane.nonce ||
    expectedPreparedHashes.has(
      normalizeBytes32(
        disposition.consumingTransaction.transactionHash,
        "Own nonce-consuming transaction hash"
      )
    )
  ) {
    throw new Error(
      "External satisfaction nonce disposition does not identify the exact canonical competing transaction"
    )
  }
}

const validateSubmittedEvent = (
  intent: P2TRSignatureFraudSubmissionIntent,
  event: P2TRSignatureFraudCanonicalSubmittedEvent
): void => {
  validateCanonicalBlock(event, "Submitted event block")
  requirePositiveSafeInteger(
    event.blockTimestamp,
    "Submitted event block timestamp"
  )
  requireNonNegativeSafeInteger(event.logIndex, "Submitted event log index")
  if (
    normalizeAddress(event.routerAddress, "Submitted event Router address") !==
      normalizeAddress(
        intent.routerAddress,
        "Submission intent Router address"
      ) ||
    normalizeBytes32(event.walletID, "Submitted event wallet ID") !==
      normalizeBytes32(intent.walletID, "Submission intent wallet ID") ||
    normalizeBytes32(
      event.bridgeChallengeIdentity,
      "Submitted event Bridge challenge identity"
    ) !==
      normalizeBytes32(
        intent.bridgeChallengeIdentity,
        "Submission intent Bridge challenge identity"
      ) ||
    normalizeBytes32(event.challengeKey, "Submitted event challenge key") !==
      normalizeBytes32(
        intent.bridgeChallengeKey,
        "Submission intent Bridge challenge key"
      ) ||
    normalizeBytes32(event.sighash, "Submitted event sighash") !==
      normalizeBytes32(intent.sighash, "Submission intent sighash")
  ) {
    throw new Error(
      "Canonical submitted event does not match the outbox intent"
    )
  }
  normalizeBytes20(event.walletPubKeyHash, "Submitted event wallet pubkey hash")
  normalizeBytes32(event.transactionHash, "Submitted event transaction hash")
}

const validateCanonicalReceipt = (
  receipt: P2TRSignatureFraudCanonicalReceipt
): void => {
  if (receipt.status !== 0 && receipt.status !== 1) {
    throw new Error("Canonical receipt status must be zero or one")
  }
  normalizeBytes32(
    receipt.transactionHash,
    "Canonical receipt transaction hash"
  )
  validateCanonicalBlock(receipt, "Canonical receipt block")
}

const validateCanonicalBlock = (
  block: { blockNumber: number; blockHash: string },
  label: string
): void => {
  requireNonNegativeSafeInteger(block.blockNumber, `${label} number`)
  normalizeBytes32(block.blockHash, `${label} hash`)
}

const validateCanonicalCandidatePointer = (
  candidate: P2TRSignatureFraudCanonicalObservationPointer,
  label: string
): void => {
  if (candidate === undefined || typeof candidate !== "object") {
    throw new Error(`${label} must be an object`)
  }
  normalizeBytes32(candidate.txid, `${label} txid`)
  normalizeBytes32(candidate.wtxid, `${label} wtxid`)
  normalizeBytes32(candidate.blockHash, `${label} block hash`)
  requireNonNegativeSafeInteger(candidate.blockHeight, `${label} block height`)
  requireUint32(candidate.inputIndex, `${label} input index`)
}

const normalizeCanonicalCandidatePointer = (
  candidate: P2TRSignatureFraudCanonicalObservationPointer,
  label: string
) => {
  validateCanonicalCandidatePointer(candidate, label)
  return {
    txid: normalizeBytes32(candidate.txid, `${label} txid`),
    wtxid: normalizeBytes32(candidate.wtxid, `${label} wtxid`),
    inputIndex: requireUint32(candidate.inputIndex, `${label} input index`),
    blockHeight: requireNonNegativeSafeInteger(
      candidate.blockHeight,
      `${label} block height`
    ),
    blockHash: normalizeBytes32(candidate.blockHash, `${label} block hash`),
  }
}

const normalizeCanonicalProvenanceWithoutFingerprint = (
  binding: Omit<
    P2TRSignatureFraudCanonicalProvenanceBinding,
    "provenanceFingerprint"
  >
) => {
  return {
    journalStoreID: requireBoundedText(
      binding.journalStoreID,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH,
      "Canonical provenance journal store ID"
    ),
    descriptorSetHash: normalizeBytes32(
      binding.descriptorSetHash,
      "Canonical provenance descriptor-set hash"
    ),
    throughBlockNumber: requireNonNegativeSafeInteger(
      binding.throughBlockNumber,
      "Canonical provenance through block number"
    ),
    throughBlockHash: normalizeBytes32(
      binding.throughBlockHash,
      "Canonical provenance through block hash"
    ),
    historyRoot: normalizeBytes32(
      binding.historyRoot,
      "Canonical provenance history root"
    ),
    eventSetHash: normalizeBytes32(
      binding.eventSetHash,
      "Canonical provenance event-set hash"
    ),
    eventCount: requireBoundedPositiveSafeInteger(
      binding.eventCount,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE,
      "Canonical provenance event count"
    ),
    challengeKey: normalizeBytes32(
      binding.challengeKey,
      "Canonical provenance challenge key"
    ),
    candidateDigest: normalizeBytes32(
      binding.candidateDigest,
      "Canonical provenance candidate digest"
    ),
    readinessCertificateID: normalizeBytes32(
      binding.readinessCertificateID,
      "Canonical provenance readiness certificate ID"
    ),
    readinessCertificateGeneration: requirePositiveSafeInteger(
      binding.readinessCertificateGeneration,
      "Canonical provenance readiness certificate generation"
    ),
    candidateProvenanceGeneration: requirePositiveSafeInteger(
      binding.candidateProvenanceGeneration,
      "Canonical candidate provenance generation"
    ),
    inputBindingKind: (() => {
      if (
        binding.inputBindingKind !== "registered-wallet-output" &&
        binding.inputBindingKind !== "deposit-binding"
      ) {
        throw new Error("Canonical provenance input-binding kind is invalid")
      }
      return binding.inputBindingKind
    })(),
    inputBindingSourceEventID: normalizeBytes32(
      binding.inputBindingSourceEventID,
      "Canonical provenance input-binding source event ID"
    ),
    inputIndex: requireUint32(
      binding.inputIndex,
      "Canonical provenance input index"
    ),
    fundingBlockHash: normalizeBytes32(
      binding.fundingBlockHash,
      "Canonical provenance funding block hash"
    ),
    fundingTxid: normalizeBytes32(
      binding.fundingTxid,
      "Canonical provenance funding txid"
    ),
    fundingVout: requireUint32(
      binding.fundingVout,
      "Canonical provenance funding output index"
    ),
    inputWalletID: normalizeBytes32(
      binding.inputWalletID,
      "Canonical provenance input wallet ID"
    ),
    inputOutputKey: normalizeBytes32(
      binding.inputOutputKey,
      "Canonical provenance input output key"
    ),
    bindingEthereumBlockNumber: requireNonNegativeSafeInteger(
      binding.bindingEthereumBlockNumber,
      "Canonical provenance binding Ethereum block number"
    ),
    bindingEthereumBlockHash: normalizeBytes32(
      binding.bindingEthereumBlockHash,
      "Canonical provenance binding Ethereum block hash"
    ),
    manifestHash: normalizeBytes32(
      binding.manifestHash,
      "Canonical provenance manifest hash"
    ),
  }
}

const validateCanonicalProvenanceBinding = (
  binding: P2TRSignatureFraudCanonicalProvenanceBinding,
  candidate: P2TRSignatureFraudCanonicalObservationPointer,
  observationID: Hex | Buffer | string,
  challengeKey: Hex | Buffer | string,
  inputPrevout: P2TRSignatureFraudWitnessObservation["inputPrevouts"][number],
  inputAuthorization: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot["canonicalWalletInputAuthorization"],
  checkpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint,
  activationManifest: P2TRSignatureFraudActivationManifestBinding
): void => {
  if (binding === undefined || typeof binding !== "object") {
    throw new Error("Canonical provenance binding is required")
  }
  const { provenanceFingerprint: _ignored, ...withoutFingerprint } = binding
  const normalized =
    normalizeCanonicalProvenanceWithoutFingerprint(withoutFingerprint)
  const authorizedWalletID =
    inputAuthorization.kind === "registered-wallet-output"
      ? inputAuthorization.walletID
      : inputAuthorization.binding.walletID
  const authorizedOutputKey =
    inputAuthorization.kind === "registered-wallet-output"
      ? inputAuthorization.outputKey
      : inputAuthorization.binding.outputKey
  if (
    normalized.candidateDigest !==
      computeP2TRSignatureFraudCanonicalCandidateDigest(
        candidate,
        observationID
      ) ||
    normalized.challengeKey !==
      normalizeBytes32(challengeKey, "Canonical challenge key") ||
    inputPrevout === undefined ||
    normalized.inputIndex !== candidate.inputIndex ||
    normalized.inputIndex !== inputAuthorization.inputIndex ||
    normalized.fundingBlockHash !==
      normalizeBytes32(
        inputAuthorization.fundingBlockHash,
        "Canonical funding block hash"
      ) ||
    normalized.fundingTxid !==
      normalizeBytes32(inputPrevout.txid, "Canonical input funding txid") ||
    normalized.fundingTxid !==
      normalizeBytes32(
        inputAuthorization.fundingTxid,
        "Authorized input funding txid"
      ) ||
    normalized.fundingVout !==
      requireUint32(inputPrevout.vout, "Canonical input funding output") ||
    normalized.fundingVout !==
      requireUint32(
        inputAuthorization.fundingVout,
        "Authorized input funding output"
      ) ||
    normalized.inputBindingKind !== inputAuthorization.kind ||
    (inputAuthorization.kind === "deposit-binding" &&
      (normalized.fundingTxid !==
        normalizeBytes32(
          inputAuthorization.binding.txid,
          "Deposit binding funding txid"
        ) ||
        normalized.fundingVout !==
          requireUint32(
            inputAuthorization.binding.vout,
            "Deposit binding funding output"
          ))) ||
    normalized.inputBindingSourceEventID !==
      normalizeBytes32(
        inputAuthorization.sourceEventID,
        "Canonical input-binding source event ID"
      ) ||
    normalized.inputWalletID !==
      normalizeBytes32(authorizedWalletID, "Authorized input wallet ID") ||
    normalized.inputOutputKey !==
      normalizeBytes32(authorizedOutputKey, "Authorized input output key") ||
    normalized.bindingEthereumBlockNumber !==
      requireNonNegativeSafeInteger(
        inputAuthorization.ethereumBlockNumber,
        "Authorized binding Ethereum block number"
      ) ||
    normalized.bindingEthereumBlockHash !==
      normalizeBytes32(
        inputAuthorization.ethereumBlockHash,
        "Authorized binding Ethereum block hash"
      ) ||
    normalized.bindingEthereumBlockNumber > normalized.throughBlockNumber ||
    normalizeBytes32(
      binding.provenanceFingerprint,
      "Canonical provenance fingerprint"
    ) !==
      computeP2TRSignatureFraudCanonicalProvenanceFingerprint(
        withoutFingerprint
      ) ||
    normalized.manifestHash !==
      normalizeBytes32(
        activationManifest.manifestHash,
        "Activation manifest hash"
      ) ||
    normalized.throughBlockNumber !== checkpoint.ethereumLifecycleBlockNumber ||
    normalized.throughBlockHash !==
      normalizeBytes32(
        checkpoint.ethereumLifecycleBlockHash,
        "Checkpoint Ethereum lifecycle block hash"
      )
  ) {
    throw new Error(
      "Canonical provenance does not authenticate the exact candidate, activation manifest, sorted event set, and pinned journal point"
    )
  }
}

const sameCanonicalProvenanceBinding = (
  left: P2TRSignatureFraudCanonicalProvenanceBinding,
  right: P2TRSignatureFraudCanonicalProvenanceBinding
): boolean => {
  const { provenanceFingerprint: leftFingerprint, ...leftWithout } = left
  const { provenanceFingerprint: rightFingerprint, ...rightWithout } = right
  return (
    normalizeBytes32(
      leftFingerprint,
      "Stored canonical provenance fingerprint"
    ) ===
      normalizeBytes32(
        rightFingerprint,
        "Expected canonical provenance fingerprint"
      ) &&
    JSON.stringify(
      normalizeCanonicalProvenanceWithoutFingerprint(leftWithout)
    ) ===
      JSON.stringify(
        normalizeCanonicalProvenanceWithoutFingerprint(rightWithout)
      )
  )
}

const normalizeCanonicalProvenanceInvalidationEvidenceWithoutHash = (
  evidence: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceWithoutHash
) => ({
  provenanceTombstoneID: normalizeBytes32(
    evidence.provenanceTombstoneID,
    "Canonical provenance tombstone ID"
  ),
  candidate: normalizeCanonicalCandidatePointer(
    evidence.candidate,
    "Invalidated canonical candidate"
  ),
  observationID: normalizeBytes32(
    evidence.observationID,
    "Invalidated canonical observation ID"
  ),
  candidateDigest: normalizeBytes32(
    evidence.candidateDigest,
    "Invalidated canonical candidate digest"
  ),
  candidateProvenanceGeneration: requirePositiveSafeInteger(
    evidence.candidateProvenanceGeneration,
    "Invalidated candidate provenance generation"
  ),
  provenanceFingerprint: normalizeBytes32(
    evidence.provenanceFingerprint,
    "Invalidated canonical provenance fingerprint"
  ),
  manifestHash: normalizeBytes32(
    evidence.manifestHash,
    "Invalidated canonical provenance manifest hash"
  ),
  ethereumRollbackBlockHash: normalizeBytes32(
    evidence.ethereumRollbackBlockHash,
    "Canonical provenance rollback block hash"
  ),
  ethereumRollbackBlockNumber: requireNonNegativeSafeInteger(
    evidence.ethereumRollbackBlockNumber,
    "Canonical provenance rollback block number"
  ),
  provenanceInvalidationSequence: requirePositiveSafeInteger(
    evidence.provenanceInvalidationSequence,
    "Canonical provenance invalidation sequence"
  ),
  invalidatedAtUnixMs: requireUnixMilliseconds(
    evidence.invalidatedAtUnixMs,
    "Canonical provenance invalidation time"
  ),
  reason: requireReason(
    evidence.reason,
    "Canonical provenance invalidation reason"
  ),
})

const validateCanonicalProvenanceInvalidationEvidence = (
  evidence: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence
): void => {
  if (evidence === undefined || typeof evidence !== "object") {
    throw new Error("Canonical provenance invalidation evidence is required")
  }
  const { evidenceHash: _ignored, ...withoutHash } = evidence
  const normalized =
    normalizeCanonicalProvenanceInvalidationEvidenceWithoutHash(withoutHash)
  if (
    normalizeBytes32(
      evidence.evidenceHash,
      "Canonical provenance invalidation evidence hash"
    ) !==
      computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash(
        withoutHash
      ) ||
    normalized.candidateDigest !==
      computeP2TRSignatureFraudCanonicalCandidateDigest(
        evidence.candidate,
        evidence.observationID
      )
  ) {
    throw new Error(
      "Canonical provenance invalidation evidence does not authenticate its exact candidate occurrence"
    )
  }
}

const sameEvidenceCheckpoint = (
  left: P2TRSignatureFraudOutboxEvidenceCheckpoint,
  right: P2TRSignatureFraudOutboxEvidenceCheckpoint
): boolean =>
  left.confirmedSourceComplete === right.confirmedSourceComplete &&
  normalizeBytes32(left.bitcoinTxHash, "Stored evidence txid") ===
    normalizeBytes32(right.bitcoinTxHash, "Expected evidence txid") &&
  normalizeBytes32(left.bitcoinWitnessTxHash, "Stored evidence wtxid") ===
    normalizeBytes32(right.bitcoinWitnessTxHash, "Expected evidence wtxid") &&
  left.bitcoinInputIndex === right.bitcoinInputIndex &&
  normalizeBytes32(left.bitcoinBlockHash, "Stored evidence Bitcoin block") ===
    normalizeBytes32(
      right.bitcoinBlockHash,
      "Expected evidence Bitcoin block"
    ) &&
  left.bitcoinBlockHeight === right.bitcoinBlockHeight &&
  normalizeBytes32(
    left.bitcoinCursorBlockHash,
    "Stored evidence Bitcoin cursor"
  ) ===
    normalizeBytes32(
      right.bitcoinCursorBlockHash,
      "Expected evidence Bitcoin cursor"
    ) &&
  left.bitcoinCursorBlockHeight === right.bitcoinCursorBlockHeight &&
  normalizeBytes32(
    left.ethereumLifecycleBlockHash,
    "Stored evidence Ethereum cursor"
  ) ===
    normalizeBytes32(
      right.ethereumLifecycleBlockHash,
      "Expected evidence Ethereum cursor"
    ) &&
  left.ethereumLifecycleBlockNumber === right.ethereumLifecycleBlockNumber &&
  sameActivationManifestBinding(
    left.activationManifest,
    right.activationManifest
  ) &&
  left.submittedEventScanFromBlock === right.submittedEventScanFromBlock

const validateOutboxPage = (
  page: P2TRSignatureFraudChallengeOutboxPage,
  requestedLimit: number
): void => {
  requireBoundedPositiveSafeInteger(
    requestedLimit,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE,
    "Challenge outbox page limit"
  )
  if (
    page === undefined ||
    typeof page !== "object" ||
    !Array.isArray(page.records) ||
    page.records.length > requestedLimit
  ) {
    throw new Error("Challenge outbox store returned an invalid bounded page")
  }
  const recordIDs = new Set<string>()
  for (const record of page.records) {
    const key = normalizeBytes32(record.recordID, "Paged outbox record ID")
    if (recordIDs.has(key)) {
      throw new Error("Challenge outbox page contains a duplicate record")
    }
    recordIDs.add(key)
  }
  optionalBoundedText(
    page.nextCursor,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_CURSOR_LENGTH,
    "Challenge outbox next-page cursor"
  )
}

const validatePreparedTransactionVariantLedger = (
  record: P2TRSignatureFraudChallengeOutboxRecord
): readonly P2TRSignatureFraudPreparedTransactionVariant[] => {
  const variants = record.preparedTransactionVariants
  if (
    variants === undefined ||
    variants.length === 0 ||
    variants.length > P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_SIGNED_VARIANTS ||
    record.preparedTransaction === undefined ||
    record.signerInvocationStartedAtUnixMs === undefined ||
    record.preparationSender === undefined ||
    record.reservedNonce === undefined
  ) {
    throw new Error(
      "Challenge outbox prepared state requires a bounded signed-variant ledger and retained sender lane"
    )
  }

  const normalized: P2TRSignatureFraudPreparedTransactionVariant[] = []
  const feePolicy = feePolicyForReservation(record, record.reservedNonce)
  const hashes = new Set<string>()
  let previous: P2TRSignatureFraudPreparedChallengeTransaction | undefined
  let previousSignedAt = -1
  let totalBroadcastAttempts = 0
  for (const [index, variant] of variants.entries()) {
    if (variant.sequence !== index) {
      throw new Error(
        "Challenge outbox signed-variant sequence must be contiguous and append-only"
      )
    }
    const signedAtUnixMs = requireUnixMilliseconds(
      variant.signedAtUnixMs,
      "Challenge outbox variant signing time"
    )
    if (signedAtUnixMs < previousSignedAt) {
      throw new Error(
        "Challenge outbox signed-variant timestamps must be monotonic"
      )
    }
    const broadcastAttempts = requireNonNegativeSafeInteger(
      variant.broadcastAttempts,
      "Challenge outbox variant broadcast attempts"
    )
    if (
      (broadcastAttempts === 0) !==
      (variant.lastBroadcastAtUnixMs === undefined)
    ) {
      throw new Error(
        "Challenge outbox variant broadcast attempts require an exact last-attempt boundary"
      )
    }
    if (variant.lastBroadcastAtUnixMs !== undefined) {
      requireUnixMilliseconds(
        variant.lastBroadcastAtUnixMs,
        "Challenge outbox variant last broadcast time"
      )
    }
    if (
      variant.lastBroadcastProviderAccepted !== undefined &&
      typeof variant.lastBroadcastProviderAccepted !== "boolean"
    ) {
      throw new Error(
        "Challenge outbox variant broadcaster acknowledgement is invalid"
      )
    }
    optionalBoundedText(
      variant.lastError,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_ERROR_LENGTH,
      "Challenge outbox variant error"
    )

    let prepared =
      previous === undefined
        ? validateP2TRSignatureFraudPreparedEIP1559ChallengeTransaction(
            record.intent,
            variant.preparedTransaction
          )
        : validateP2TRSignatureFraudPreparedChallengeReplacementTransaction(
            record.intent,
            previous,
            variant.preparedTransaction,
            feePolicy.minimumReplacementFeeBumpBps
          )
    prepared =
      validateP2TRSignatureFraudPreparedChallengeTransactionReservation(
        record.intent,
        record.reservedNonce,
        prepared
      )
    prepared = validatePreparedTransactionFeePolicy(
      record.intent,
      feePolicy,
      prepared
    )
    if (
      normalizeAddress(prepared.sender, "Prepared variant sender") !==
      normalizeAddress(record.preparationSender, "Reserved variant sender")
    ) {
      throw new Error(
        "Challenge outbox signed variant does not use the reserved sender lane"
      )
    }
    const hash = normalizeBytes32(
      prepared.transactionHash,
      "Prepared variant transaction hash"
    )
    if (hashes.has(hash)) {
      throw new Error(
        "Challenge outbox signed-variant ledger contains a duplicate hash"
      )
    }
    hashes.add(hash)
    normalized.push({
      ...variant,
      preparedTransaction: prepared,
      signedAtUnixMs,
      broadcastAttempts,
    })
    previous = prepared
    previousSignedAt = signedAtUnixMs
    totalBroadcastAttempts = requireSafeIntegerSum(
      totalBroadcastAttempts,
      broadcastAttempts,
      "Challenge outbox aggregate variant broadcast attempts"
    )
  }

  const latest = normalized[normalized.length - 1].preparedTransaction
  if (
    normalizeBytes32(latest.transactionHash, "Latest prepared variant hash") !==
      normalizeBytes32(
        record.preparedTransaction.transactionHash,
        "Prepared transaction alias hash"
      ) ||
    latest.rawTransaction !== record.preparedTransaction.rawTransaction ||
    normalizeBytes32(latest.intentID, "Latest prepared variant intent ID") !==
      normalizeBytes32(
        record.preparedTransaction.intentID,
        "Prepared transaction alias intent ID"
      ) ||
    normalizeAddress(latest.sender, "Latest prepared variant sender") !==
      normalizeAddress(
        record.preparedTransaction.sender,
        "Prepared transaction alias sender"
      ) ||
    latest.nonce !== record.preparedTransaction.nonce ||
    totalBroadcastAttempts !== record.broadcastAttempts
  ) {
    throw new Error(
      "Challenge outbox prepared transaction alias or aggregate attempts diverge from its append-only variant ledger"
    )
  }
  return normalized
}

const replaceLatestPreparedVariant = (
  variants: readonly P2TRSignatureFraudPreparedTransactionVariant[],
  replacement: P2TRSignatureFraudPreparedTransactionVariant
): readonly P2TRSignatureFraudPreparedTransactionVariant[] => [
  ...variants.slice(0, -1),
  replacement,
]

export const appendSignerQuarantine = (
  existing: readonly P2TRSignatureFraudSignerQuarantine[] | undefined,
  identity: Pick<
    P2TRSignatureFraudBoundNonceReservation,
    "laneID" | "signerIdentity" | "sender"
  > &
    Partial<
      Pick<P2TRSignatureFraudBoundNonceReservation, "nonce" | "reservationID">
    >,
  quarantinedAtUnixMs: number,
  reason: string,
  reasonCode: P2TRSignatureFraudSignerQuarantine["reasonCode"]
): readonly P2TRSignatureFraudSignerQuarantine[] => {
  const normalizedBase = {
    laneID: requireBoundedText(
      identity.laneID,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
      "Quarantined signer lane ID"
    ),
    signerIdentity: requireBoundedText(
      identity.signerIdentity,
      P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
      "Quarantined signer identity"
    ),
    expectedSender: normalizeAddress(
      identity.sender,
      "Quarantined signer sender"
    ),
    expectedNonce:
      identity.nonce === undefined
        ? undefined
        : requireNonNegativeSafeInteger(
            identity.nonce,
            "Quarantined signer nonce"
          ),
    reservationID:
      identity.reservationID === undefined
        ? undefined
        : normalizeBytes32(
            identity.reservationID,
            "Quarantined signer reservation ID"
          ),
    reasonCode,
    quarantinedAtUnixMs: requireUnixMilliseconds(
      quarantinedAtUnixMs,
      "Signer quarantine time"
    ),
    reason: requireReason(reason, "Signer quarantine reason"),
  }
  const normalized: P2TRSignatureFraudSignerQuarantine = {
    ...normalizedBase,
    detailsDigest: sha256Structured(normalizedBase),
  }
  if (
    (existing ?? []).some(
      (quarantine) =>
        quarantine.signerIdentity === normalized.signerIdentity &&
        quarantine.laneID === normalized.laneID
    )
  ) {
    return existing ?? []
  }
  return [...(existing ?? []), normalized]
}

const classifyReservationMismatch = (
  expectedChainID: number,
  reservation: P2TRSignatureFraudBoundNonceReservation,
  escaped: P2TRSignatureFraudPreparedChallengeTransaction
): P2TRSignatureFraudSignerQuarantine["reasonCode"] =>
  escaped.chainID !== expectedChainID
    ? "wrong-chain"
    : normalizeAddress(escaped.sender, "Escaped signed sender") !==
      normalizeAddress(reservation.sender, "Reserved signed sender")
    ? "wrong-sender"
    : escaped.nonce !== reservation.nonce
    ? "wrong-nonce"
    : "malformed-signed-envelope"

const classifyReplacementSignerFailure = (
  expectedChainID: number,
  reservation: P2TRSignatureFraudBoundNonceReservation,
  _previous: P2TRSignatureFraudPreparedChallengeTransaction,
  escaped: P2TRSignatureFraudPreparedChallengeTransaction
): P2TRSignatureFraudSignerQuarantine["reasonCode"] => {
  const reservationMismatch = classifyReservationMismatch(
    expectedChainID,
    reservation,
    escaped
  )
  if (
    reservationMismatch === "wrong-chain" ||
    reservationMismatch === "wrong-sender" ||
    reservationMismatch === "wrong-nonce"
  ) {
    return reservationMismatch
  }
  return "invalid-replacement-envelope"
}

const requireLatestSignerQuarantine = (
  record: P2TRSignatureFraudChallengeOutboxRecord
): P2TRSignatureFraudSignerQuarantine => {
  const quarantines = record.signerQuarantines ?? []
  const quarantine = quarantines[quarantines.length - 1]
  if (quarantine === undefined) {
    throw new Error("Signer failure lacks its derived quarantine evidence")
  }
  return quarantine
}

const appendUnexpectedSignedArtifact = (
  existing: readonly P2TRSignatureFraudUnexpectedSignedArtifact[] | undefined,
  preparedTransaction: P2TRSignatureFraudPreparedChallengeTransaction,
  expectedReservationID: string,
  capturedAtUnixMs: number,
  reason: string
): readonly P2TRSignatureFraudUnexpectedSignedArtifact[] => {
  const hash = normalizeBytes32(
    preparedTransaction.transactionHash,
    "Unexpected signed artifact hash"
  )
  if (
    (existing ?? []).some(
      ({ preparedTransaction: prior }) =>
        normalizeBytes32(
          prior.transactionHash,
          "Prior signed artifact hash"
        ) === hash
    )
  ) {
    return existing ?? []
  }
  // Invocation echoes are unauthenticated response metadata. They are useful
  // for accepting the expected signer response, but a malformed echo must not
  // poison an otherwise authenticated artifact and make the durable record
  // impossible to hydrate. The quarantine reason retains the mismatch.
  const { invocation: _unsafeInvocation, ...durablePreparedTransaction } =
    preparedTransaction
  return [
    ...(existing ?? []),
    {
      preparedTransaction: durablePreparedTransaction,
      expectedReservationID: normalizeBytes32(
        expectedReservationID,
        "Expected nonce reservation ID"
      ),
      capturedAtUnixMs: requireUnixMilliseconds(
        capturedAtUnixMs,
        "Unexpected signed artifact capture time"
      ),
      reason: requireReason(reason, "Unexpected signed artifact reason"),
    },
  ]
}

const nextRecord = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  updates: Partial<P2TRSignatureFraudChallengeOutboxRecord>
): P2TRSignatureFraudChallengeOutboxRecord => ({
  ...record,
  ...updates,
  version: record.version + 1,
})

const intentKey = (intent: P2TRSignatureFraudSubmissionIntent): string =>
  normalizeBytes32(intent.intentID, "Challenge outbox intent ID")

const normalizeBytes32 = (
  value: Hex | Buffer | string,
  label: string
): string => normalizeFixedBytes(value, 32, label)

const reverseBytes32 = (value: Hex | Buffer | string, label: string): string =>
  `0x${Buffer.from(normalizeBytes32(value, label).slice(2), "hex")
    .reverse()
    .toString("hex")}`

const normalizeBytes20 = (
  value: Hex | Buffer | string,
  label: string
): string => normalizeFixedBytes(value, 20, label)

const normalizeFixedBytes = (
  value: Hex | Buffer | string,
  length: number,
  label: string
): string => {
  let bytes: Buffer
  try {
    if (value instanceof Hex) {
      bytes = value.toBuffer()
    } else if (Buffer.isBuffer(value)) {
      bytes = Buffer.from(value)
    } else if (typeof value === "string") {
      const unprefixed = value.replace(/^0x/i, "")
      if (!/^[0-9a-fA-F]*$/.test(unprefixed) || unprefixed.length % 2 !== 0) {
        throw new Error("invalid hex")
      }
      bytes = Buffer.from(unprefixed, "hex")
    } else {
      throw new Error("invalid bytes")
    }
  } catch {
    throw new Error(`${label} must be ${length} bytes`)
  }
  if (bytes.length !== length) {
    throw new Error(`${label} must be ${length} bytes`)
  }
  return `0x${bytes.toString("hex")}`
}

const normalizeAddress = (value: string, label: string): string => {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(value) ||
    /^0x0{40}$/i.test(value)
  ) {
    throw new Error(`${label} must be a non-zero Ethereum address`)
  }
  return value.toLowerCase()
}

const normalizeHexData = (value: string, label: string): string => {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error(`${label} must be even-length hexadecimal data`)
  }
  return value.toLowerCase()
}

const normalizeUnsignedDecimal = (value: string, label: string): string => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal integer`)
  }
  return value
}

const normalizeTrustDomainID = (value: string, label: string): string => {
  return requireBoundedText(
    value,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
    label
  ).toLowerCase()
}

const requireReason = (value: string, label: string): string => {
  return requireBoundedText(
    value,
    P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_ERROR_LENGTH,
    label
  )
}

const requireBoundedText = (
  value: string,
  maximumLength: number,
  label: string
): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`)
  }
  const normalized = value.trim()
  if (normalized.length > maximumLength) {
    throw new Error(`${label} exceeds ${maximumLength} characters`)
  }
  return normalized
}

const optionalBoundedText = (
  value: string | undefined,
  maximumLength: number,
  label: string
): string | undefined =>
  value === undefined
    ? undefined
    : requireBoundedText(value, maximumLength, label)

const requireUnixMilliseconds = (value: number, label: string): number =>
  requireNonNegativeSafeInteger(value, label)

const requirePositiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

const requireBoundedPositiveSafeInteger = (
  value: number,
  maximum: number,
  label: string
): number => {
  const normalized = requirePositiveSafeInteger(value, label)
  if (normalized > maximum) {
    throw new Error(`${label} must not exceed ${maximum}`)
  }
  return normalized
}

const requireNonNegativeSafeInteger = (
  value: number,
  label: string
): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

const requireBoundedNonNegativeSafeInteger = (
  value: number,
  maximum: number,
  label: string
): number => {
  const normalized = requireNonNegativeSafeInteger(value, label)
  if (normalized > maximum) {
    throw new Error(`${label} must not exceed ${maximum}`)
  }
  return normalized
}

const requireUint32 = (value: number, label: string): number => {
  const normalized = requireNonNegativeSafeInteger(value, label)
  if (normalized > 0xffffffff) {
    throw new Error(`${label} must be an unsigned 32-bit integer`)
  }
  return normalized
}

const requireSafeIntegerSum = (
  left: number,
  right: number,
  label: string
): number => {
  requireNonNegativeSafeInteger(left, `${label} left operand`)
  requireNonNegativeSafeInteger(right, `${label} right operand`)
  const sum = left + right
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`${label} overflows the safe integer range`)
  }
  return sum
}

const normalizePositiveSafeIntegerLike = (
  value: unknown,
  label: string
): number => {
  let serialized: string
  try {
    serialized =
      typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : (value as { toString(): string }).toString()
  } catch {
    throw new Error(`${label} must be a positive safe integer`)
  }
  if (!/^[1-9][0-9]*$/.test(serialized)) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  const parsed = BigInt(serialized)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return Number(parsed)
}

const errorMessage = (error: unknown): string => {
  let message: string
  try {
    message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : String(error)
  } catch {
    message = "Unknown provider error"
  }
  const normalized = message.trim() || "Unknown provider error"
  return normalized.slice(0, P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_ERROR_LENGTH)
}

const isPreparedTransactionValidationFailure = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("Prepared challenge transaction") ||
    error.message.includes("submission intent"))
