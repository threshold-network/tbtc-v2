import { createHash } from "node:crypto"

import {
  Hex,
  P2TRSignatureFraudBoundNonceReservation,
  P2TRSignatureFraudChallengeTransactionPreparer,
  P2TRSignatureFraudChallengeTransactionFeePolicy,
  P2TRSignatureFraudPreparedChallengeTransaction,
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
  validateP2TRSignatureFraudBoundNonceReservation,
  validateP2TRSignatureFraudWitnessObservationConsistency,
} from "@keep-network/tbtc-v2.ts"

import type { P2TRSignatureFraudWatchtowerStoreProfileProvider } from "./types.js"

export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE = 1_000
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_LEASE_OWNER_LENGTH = 128
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH = 128
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_ERROR_LENGTH = 1_024
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_CURSOR_LENGTH = 512
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PROTOCOL_ID_LENGTH = 128
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_SIGNED_VARIANTS = 16
export const P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_GENERATIONS = 32
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
export const P2TR_SIGNATURE_FRAUD_PROVENANCE_INVALIDATION_DOMAIN =
  "tbtc-p2tr-signature-fraud-provenance-invalidation-v1"

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
  /** Canonical application-finality boundary used for every state read. */
  finalizedThrough: P2TRSignatureFraudCanonicalBlock
  /** Two independently sourced attestations over the same canonical digest. */
  canonicalAttestations: readonly [
    P2TRSignatureFraudCanonicalEvidenceAttestation,
    P2TRSignatureFraudCanonicalEvidenceAttestation,
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

export type P2TRSignatureFraudSignerQuarantine = {
  laneID: string
  signerIdentity: string
  expectedSender: string
  expectedNonce?: number
  reservationID?: string
  reasonCode:
    | "ambiguous-signer-invocation"
    | "wrong-sender"
    | "wrong-nonce"
    | "malformed-signed-envelope"
    | "invalid-replacement-envelope"
    | "reservation-binding-mismatch"
    | "reservation-provider-failure"
  quarantinedAtUnixMs: number
  reason: string
  detailsDigest: string
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
  /** Historical proof that at least one signer invocation began. */
  signerInvocationStartedAtUnixMs?: number
  preparedTransaction?: P2TRSignatureFraudPreparedChallengeTransaction
  /** Append-only signed identities; the singular field aliases the last item. */
  preparedTransactionVariants?: readonly P2TRSignatureFraudPreparedTransactionVariant[]
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
  eventIDs: readonly string[]
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
export interface P2TRSignatureFraudChallengeOutboxStore extends P2TRSignatureFraudWatchtowerStoreProfileProvider {
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
  hasExpiredPreparationLeases(nowUnixMs: number): Promise<boolean>
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
   * Privileged append-only recovery boundary for bytes returned after a
   * concurrent provenance invalidation won the normal version CAS. It may not
   * change status, release a nonce, or remove any prior artifact.
   */
  captureEscapedSignedArtifact(
    recordID: string,
    expectedProvenanceFingerprint: string,
    artifact: P2TRSignatureFraudUnexpectedSignedArtifact
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

export type P2TRSignatureFraudChallengeOutboxDispatcherOptions = {
  preparationLeaseMs?: number
  minimumRebroadcastIntervalMs?: number
  recoveryPageSize?: number
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

export class P2TRSignatureFraudChallengeOutboxScheduler {
  constructor(
    private readonly store: P2TRSignatureFraudChallengeOutboxStore,
    private readonly options: P2TRSignatureFraudChallengeOutboxSchedulerOptions
  ) {
    validateSchedulerOptions(options)
  }

  /**
   * Loads and validates authoritative evidence under the store's eligibility
   * transaction. Callers provide only the durable observation key; they cannot
   * supply an intent, cursor, Router binding, or confirmation assertion.
   */
  async enqueueConfirmedChallenge(
    observationID: Hex | Buffer | string,
    nowUnixMs = Date.now()
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const key = normalizeBytes32(observationID, "Challenge observation ID")
    return this.store.runInEligibilityTransaction(key, async (snapshot) => {
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
          }
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
            cancellationEvidenceHash: latest.cancellationEvidence.evidenceHash,
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
          return latest
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
          throw new Error(
            "Challenge outbox reached the bounded evidence-generation limit and persisted an activation-blocking alert"
          )
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
      return stored
    })
  }
}

export class P2TRSignatureFraudChallengeOutboxDispatcher {
  private readonly preparationLeaseMs: number
  private readonly minimumRebroadcastIntervalMs: number
  private readonly recoveryPageSize: number
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
    options: P2TRSignatureFraudChallengeOutboxDispatcherOptions = {}
  ) {
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
    await this.assertRecoveryBarrier()

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

    let unvalidatedReservation: P2TRSignatureFraudBoundNonceReservation
    try {
      unvalidatedReservation =
        await selectedPreparer.reserveSignatureFraudChallengeNonce(
          laneClaim.intent,
          Hex.from(laneClaim.recordID),
          laneClaim.generation
        )
    } catch (error) {
      const failed = this.signerFailureRecord(
        laneClaim,
        selectedPreparer,
        errorMessage(error),
        false,
        undefined,
        "reservation-provider-failure"
      )
      await this.store.compareAndSwap(key, laneClaim.version, failed)
      return this.requireRecord(key)
    }

    let reservation: P2TRSignatureFraudBoundNonceReservation
    try {
      reservation = validateP2TRSignatureFraudBoundNonceReservation(
        laneClaim.intent,
        Hex.from(laneClaim.recordID),
        laneClaim.generation,
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
    if (!(await this.store.compareAndSwap(key, laneClaim.version, reserved))) {
      const durable = await this.requireRecord(key)
      if (
        (durable.status === "preparing" ||
          durable.status ===
            "provenance-invalidated-awaiting-reconciliation") &&
        durable.provenanceInvalidationEvidence !== undefined &&
        durable.signerInvocationStartedAtUnixMs === undefined &&
        (durable.preparedTransactionVariants?.length ?? 0) === 0
      ) {
        return this.voidInvalidatedPreSignerReservation(
          durable,
          reservation,
          selectedPreparer
        )
      }
      await selectedPreparer.releaseSignatureFraudChallengeNonce(reservation)
      return durable
    }

    const signerBoundaryTime = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox signer invocation time"
    )
    await this.assertRecoveryBarrier()
    const signerBoundary = nextRecord(reserved, {
      activeSignerInvocationStartedAtUnixMs: signerBoundaryTime,
      signerInvocationStartedAtUnixMs: signerBoundaryTime,
      lastPreBroadcastRecheckAtUnixMs: signerBoundaryTime,
      lastPreBroadcastRecheckStatus: "eligible",
      updatedAtUnixMs: signerBoundaryTime,
      lastError: undefined,
    })
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

    let prepared: P2TRSignatureFraudPreparedChallengeTransaction
    let escaped: P2TRSignatureFraudPreparedChallengeTransaction | undefined
    let candidate: P2TRSignatureFraudPreparedChallengeTransaction
    try {
      // Invoking a signer is the irreversible nonce boundary. Even if the
      // call later throws, signed bytes may have escaped a remote signer.
      candidate =
        await selectedPreparer.prepareSignatureFraudChallengeTransaction(
          signerBoundary.intent,
          reservation,
          selectedFeePolicy
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
      await this.store.compareAndSwap(key, signerBoundary.version, failed)
      return this.requireRecord(key)
    }
    try {
      escaped = validateP2TRSignatureFraudPreparedChallengeTransaction(
        signerBoundary.intent,
        candidate
      )
    } catch (error) {
      const failed = this.signerFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        true,
        undefined,
        "malformed-signed-envelope"
      )
      await this.store.compareAndSwap(key, signerBoundary.version, failed)
      return this.requireRecord(key)
    }
    try {
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
        classifyReservationMismatch(reservation, escaped)
      )
      if (
        !(await this.store.compareAndSwap(key, signerBoundary.version, failed))
      ) {
        return this.captureEscapedArtifactAfterLostCas(
          signerBoundary,
          escaped,
          `Invalid initial signed envelope returned after a concurrent outbox transition: ${errorMessage(
            error
          )}`
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
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox prepared time"
      ),
      lastError: undefined,
    })
    if (
      !(await this.store.compareAndSwap(key, signerBoundary.version, persisted))
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
    await this.assertRecoveryBarrier()

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
    const selectedPreparer = this.preparerForReservation(current.reservedNonce)
    if (
      selectedPreparer === undefined ||
      (await this.store.isSignerQuarantined(
        current.intent.chainID,
        current.reservedNonce.signerIdentity
      ))
    ) {
      return this.quarantine(
        current,
        "Challenge replacement signer lane is unavailable or quarantined"
      )
    }
    const selectedFeePolicy = feePolicyForPreparer(current, selectedPreparer)
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
    await this.assertRecoveryBarrier()
    const signerBoundary = nextRecord(claimed, {
      activeSignerInvocationStartedAtUnixMs: signerBoundaryTime,
      lastPreBroadcastRecheckAtUnixMs: signerBoundaryTime,
      lastPreBroadcastRecheckStatus: "eligible",
      updatedAtUnixMs: signerBoundaryTime,
      lastError: undefined,
    })
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

    let replacement: P2TRSignatureFraudPreparedChallengeTransaction
    let escaped: P2TRSignatureFraudPreparedChallengeTransaction | undefined
    let candidate: P2TRSignatureFraudPreparedChallengeTransaction
    try {
      candidate =
        await selectedPreparer.prepareSignatureFraudChallengeReplacementTransaction(
          signerBoundary.intent,
          current.reservedNonce,
          previous,
          selectedFeePolicy
        )
    } catch (error) {
      await this.saveSignedStateQuarantineAlert(
        signerBoundary,
        errorMessage(error)
      )
      const failed = this.signerFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        true,
        undefined,
        "ambiguous-signer-invocation"
      )
      await this.store.compareAndSwap(key, signerBoundary.version, failed)
      return this.requireRecord(key)
    }
    try {
      escaped = validateP2TRSignatureFraudPreparedChallengeTransaction(
        signerBoundary.intent,
        candidate
      )
    } catch (error) {
      await this.saveSignedStateQuarantineAlert(
        signerBoundary,
        errorMessage(error)
      )
      const failed = this.signerFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        true,
        undefined,
        "malformed-signed-envelope"
      )
      await this.store.compareAndSwap(key, signerBoundary.version, failed)
      return this.requireRecord(key)
    }
    try {
      replacement =
        validateP2TRSignatureFraudPreparedChallengeReplacementTransaction(
          signerBoundary.intent,
          previous,
          escaped
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
      await this.saveSignedStateQuarantineAlert(
        signerBoundary,
        errorMessage(error)
      )
      const failed = this.signerFailureRecord(
        signerBoundary,
        selectedPreparer,
        errorMessage(error),
        true,
        escaped,
        classifyReplacementSignerFailure(
          current.reservedNonce,
          previous,
          escaped
        )
      )
      if (
        !(await this.store.compareAndSwap(key, signerBoundary.version, failed))
      ) {
        return this.captureEscapedArtifactAfterLostCas(
          signerBoundary,
          escaped,
          `Invalid replacement signed envelope returned after a concurrent outbox transition: ${errorMessage(
            error
          )}`
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
      updatedAtUnixMs: requireUnixMilliseconds(
        this.now(),
        "Challenge outbox replacement prepared time"
      ),
      lastError: undefined,
    })
    if (
      !(await this.store.compareAndSwap(key, signerBoundary.version, persisted))
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
    this.recoveryBarrierEstablished = !report.backlogRemaining
    if (report.backlogRemaining) {
      await this.onRecoveryBacklog?.(report)
    }
    return report
  }

  async broadcast(
    recordID: Hex | Buffer | string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
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
    try {
      variants = validatePreparedTransactionVariantLedger(current)
    } catch (error) {
      return this.quarantine(current, errorMessage(error))
    }
    const latestVariant = variants[variants.length - 1]
    const preparedTransaction = latestVariant.preparedTransaction

    if (current.status !== "external-satisfied-awaiting-own-transaction") {
      const rechecked = await this.recheckIrreversibleAction(
        current,
        "before-broadcast"
      )
      if (rechecked.status !== "eligible") {
        return this.applyPreBroadcastRecheckFailure(current, rechecked)
      }
    }

    const nowUnixMs = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox broadcast time"
    )
    if (
      latestVariant.lastBroadcastAtUnixMs !== undefined &&
      nowUnixMs - latestVariant.lastBroadcastAtUnixMs <
        this.minimumRebroadcastIntervalMs
    ) {
      return current
    }

    // Persist the irreversible-attempt boundary before the external call. A
    // crash from this point onward can only cause the exact same raw bytes to
    // be sent again.
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
      lastBroadcastAtUnixMs: nowUnixMs,
      lastBroadcastProviderAccepted: undefined,
      updatedAtUnixMs: nowUnixMs,
      lastError: undefined,
    })
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
      resolution =
        await this.reconciler.reconcileSignatureFraudChallengeOutbox(context)
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
          preparationSender: undefined,
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
          preparationSender: undefined,
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
    const signerWasInvoked =
      current.activeSignerInvocationStartedAtUnixMs !== undefined
    const resumeStatus = current.preparationResumeStatus

    // A crash can occur after the non-signing allocator durably reserves a
    // nonce but before this record stores the returned binding. Reservation
    // calls are required to be idempotent for the record generation, so
    // recover that exact binding and put it under the SQL nonce guard before
    // recording a pre-sign void.
    if (
      !signerWasInvoked &&
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
              selectedPreparer,
              await selectedPreparer.reserveSignatureFraudChallengeNonce(
                current.intent,
                Hex.from(current.recordID),
                current.generation
              )
            )
        } catch (error) {
          const failed = this.signerFailureRecord(
            current,
            selectedPreparer,
            errorMessage(
              `Challenge nonce reservation recovery failed: ${errorMessage(
                error
              )}`
            ),
            false,
            undefined,
            "reservation-provider-failure"
          )
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
    }

    const releasableReservation =
      !signerWasInvoked &&
      resumeStatus === undefined &&
      current.reservedNonce !== undefined
        ? current.reservedNonce
        : undefined
    const voidedAt = requireUnixMilliseconds(
      this.now(),
      "Challenge outbox lease recovery time"
    )
    const retainLane = signerWasInvoked || resumeStatus !== undefined
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
    const recovered = nextRecord(current, {
      // Once the signer boundary is durable, never sign a replacement or
      // release this lane on lease expiry.
      status: signerWasInvoked
        ? "quarantined"
        : current.provenanceInvalidationEvidence !== undefined
          ? "cancelled-provenance-invalidated"
          : (resumeStatus ?? "queued"),
      preparationLease: undefined,
      preparationResumeStatus: undefined,
      activeSignerInvocationStartedAtUnixMs: undefined,
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
      updatedAtUnixMs: voidedAt,
      lastError: signerWasInvoked
        ? "Challenge outbox preparation lease expired after the signer boundary; nonce lane retained"
        : resumeStatus === undefined
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
      if (preparer !== undefined) {
        try {
          await preparer.releaseSignatureFraudChallengeNonce(
            releasableReservation
          )
        } catch (error) {
          const durable = await this.requireRecord(current.recordID)
          if (durable.version === recovered.version) {
            const warned = nextRecord(durable, {
              updatedAtUnixMs: requireUnixMilliseconds(
                this.now(),
                "Challenge nonce allocator release warning time"
              ),
              lastError: errorMessage(
                `Nonce guard was durably voided but allocator release failed: ${errorMessage(
                  error
                )}`
              ),
            })
            await this.store.compareAndSwap(
              durable.recordID,
              durable.version,
              warned
            )
          }
        }
      }
    }
    return this.requireRecord(current.recordID)
  }

  private async voidInvalidatedPreSignerReservation(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    reservation: P2TRSignatureFraudBoundNonceReservation,
    preparer: P2TRSignatureFraudChallengeTransactionPreparer
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    if (
      current.provenanceInvalidationEvidence === undefined ||
      current.signerInvocationStartedAtUnixMs !== undefined ||
      (current.preparedTransactionVariants?.length ?? 0) > 0
    ) {
      throw new Error(
        "Only an invalidated pre-signer nonce reservation may be safely voided"
      )
    }
    validateP2TRSignatureFraudBoundNonceReservation(
      current.intent,
      Hex.from(current.recordID),
      current.generation,
      preparer,
      reservation
    )
    const voidedAtUnixMs = requireUnixMilliseconds(
      this.now(),
      "Invalidated challenge nonce reservation void time"
    )
    const reason =
      "Canonical provenance was invalidated before signer invocation"
    const evidenceDigest = sha256Structured({
      recordID: current.recordID,
      generation: current.generation,
      reservationID: reservation.reservationID.toPrefixedString(),
      voidedAtUnixMs,
      reasonCode: "reservation-abandoned",
      reason,
    })
    const voided = nextRecord(current, {
      status: "cancelled-provenance-invalidated",
      preparationLease: undefined,
      preparationSender: undefined,
      selectedLaneID: undefined,
      selectedSignerIdentity: undefined,
      reservedNonce: undefined,
      nonceReservedAtUnixMs: undefined,
      voidedNonceReservations: [
        ...(current.voidedNonceReservations ?? []),
        {
          reservation,
          voidedAtUnixMs,
          reasonCode: "reservation-abandoned",
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
      return this.requireRecord(current.recordID)
    }
    // The durable guard is void before the external allocator is notified.
    await preparer.releaseSignatureFraudChallengeNonce(reservation)
    return voided
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

  private async assertRecoveryBarrier(): Promise<void> {
    if (!this.recoveryBarrierEstablished) {
      await this.establishRecoveryBarrier()
    }
    if (
      await this.store.hasExpiredPreparationLeases(
        requireUnixMilliseconds(this.now(), "Challenge recovery barrier time")
      )
    ) {
      this.recoveryBarrierEstablished = false
      throw new Error(
        "Challenge signing is blocked by an expired durable preparation lease"
      )
    }
  }

  private async establishRecoveryBarrier(): Promise<void> {
    let cursor: string | undefined
    for (let pageCount = 0; pageCount < 1_024; pageCount++) {
      const report = await this.recoverExpiredPreparationLeases(cursor)
      if (!report.backlogRemaining) return
      // A new expired row may sort before the cursor after the final page.
      // Restart the bounded scan when the exact store query still finds one.
      cursor = report.nextCursor
    }
    throw new Error(
      "Challenge signing is blocked because the durable recovery scan did not converge"
    )
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
    return nextRecord(current, {
      status:
        signerInvoked && retainedStatus === undefined
          ? "quarantined"
          : (retainedStatus ?? "queued"),
      preparationLease: undefined,
      preparationResumeStatus: undefined,
      activeSignerInvocationStartedAtUnixMs: undefined,
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

  private async quarantine(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    reason: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const normalizedReason = requireReason(
      reason,
      "Challenge outbox quarantine reason"
    )
    const postSendBoundary = current.broadcastAttempts > 0
    const signerBoundary =
      current.signerInvocationStartedAtUnixMs !== undefined ||
      (current.preparedTransactionVariants?.length ?? 0) > 0
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
      activeSignerInvocationStartedAtUnixMs: undefined,
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
    reason: string
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
      }
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
  }) as P2TRSignatureFraudWitnessObservationConsistencyContext

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
  const liveChainID = normalizePositiveSafeIntegerLike(
    options.submissionIntent.chainID,
    "Submission transaction chain ID"
  )
  const domainChainID = normalizePositiveSafeIntegerLike(
    options.submissionIntent.domainChainID,
    "Submission immutable domain chain ID"
  )
  if (liveChainID !== domainChainID) {
    throw new Error(
      "Challenge outbox activation requires the live chain ID to match the immutable Router domain chain ID"
    )
  }
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
  const walletID = normalizeBytes32(observation.walletID, "Observation wallet ID")
  const normalizedSigningKey = normalizeBytes32(
    signingKey,
    "Observation P2TR signing key"
  )
  const baseWalletKey = normalizedSigningKey === walletID
  const expectedBindingTxHash = baseWalletKey
    ? `0x${"00".repeat(32)}`
    : normalizeBytes32(prevout.txid, "Observation funding txid")
  const expectedBindingOutputIndex = baseWalletKey ? 0 : prevout.vout
  const observedSignature = normalizeFixedBytes(
    observation.signature,
    64,
    "Observation BIP-340 signature"
  )
  const intentSignature = `${normalizeBytes32(
    intent.nonceX,
    "Intent signature nonce X"
  )}${normalizeBytes32(
    intent.signatureScalar,
    "Intent signature scalar"
  ).slice(2)}`
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
      "Stored observation alias"
    ) !== requestedObservationID ||
    normalizeBytes32(observation.observationID, "Canonical observation ID") !==
      requestedObservationID ||
    normalizeBytes32(intent.observationID, "Submission observation ID") !==
      requestedObservationID
  ) {
    throw new Error(
      "Challenge outbox observation alias is not the current canonical candidate"
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
    normalizeBytes32(challengeRecord.observationID, "Observation ID") !==
      normalizeBytes32(
        canonicalObservation.observationID,
        "Submission intent observation ID"
      ) ||
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
  if (
    normalizeBytes32(head.seriesID, "Stored outbox series ID") !==
      normalizeBytes32(seriesID, "Expected outbox series ID") ||
    computeP2TRSignatureFraudOutboxSeriesID(head.intent) !== seriesID ||
    intentKey(head.intent) !== intentKey(intent) ||
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
  const normalizedActivationManifest =
    normalizeActivationManifestBinding(
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
  if (
    policy.chainID !== intent.chainID ||
    normalizePolicyUint256(
      policy.challengeValueWei,
      "Challenge fee policy value"
    ) !== normalizePolicyUint256(intent.value, "Challenge intent value") ||
    normalizeAddress(policy.sender, "Challenge fee policy sender") !==
      normalizeAddress(prepared.sender, "Prepared challenge sender") ||
    gasLimit > BigInt(policy.maxGasLimit) ||
    maxFeePerGas > BigInt(policy.maxFeePerGas) ||
    maxPriorityFeePerGas > BigInt(policy.maxPriorityFeePerGas) ||
    gasLimit * maxFeePerGas > BigInt(policy.maxTotalFeeWei)
  ) {
    throw new Error(
      "Prepared challenge transaction exceeds its manifest-bound fee or value policy"
    )
  }
  return prepared
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
  requirePositiveSafeInteger(
    reconciler.finalityConfirmationBlocks,
    "Challenge reconciliation finality confirmation depth"
  )
  validateCanonicalSubmissionSelectors(reconciler.canonicalSubmissionSelectors)
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
  if (!Array.isArray(manifest.lanes) || manifest.lanes.length === 0) {
    throw new Error("Challenge fee policy requires at least one signer lane")
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
      if (BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
        throw new Error("Challenge fee policy priority fee exceeds its max fee")
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
          normalizeAddress(
            transaction.sender,
            "Signed terminal artifact sender"
          ) !==
            normalizeAddress(
              protectedLane.sender,
              "Protected terminal nonce sender"
            ) || transaction.nonce !== protectedLane.nonce
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
      preparedHashes.has(
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
  const externalDepositTooSmall = BigInt(transactionValue) < BigInt(intentValue)
  if (
    (requireExactIntent && exactIntentMismatch) ||
    (!requireExactIntent && externalDepositTooSmall)
  ) {
    throw new Error(
      requireExactIntent
        ? "Canonical own transaction does not match the durable call intent"
        : "Canonical external transaction does not cover the required challenge deposit"
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
    preparedHashes.has(
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
  if (!Array.isArray(binding.eventIDs) || binding.eventIDs.length === 0) {
    throw new Error("Canonical provenance requires at least one exact event ID")
  }
  if (binding.eventIDs.length > P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_PAGE_SIZE) {
    throw new Error("Canonical provenance event-ID set exceeds the bounded cap")
  }
  const eventIDs = binding.eventIDs
    .map((eventID) =>
      normalizeBytes32(eventID, "Canonical provenance event ID")
    )
    .sort()
  if (new Set(eventIDs).size !== eventIDs.length) {
    throw new Error("Canonical provenance event IDs must be unique")
  }
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
    eventIDs,
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
  const suppliedEventIDs = binding.eventIDs.map((eventID) =>
    normalizeBytes32(eventID, "Canonical provenance event ID")
  )
  const authorizedWalletID =
    inputAuthorization.kind === "registered-wallet-output"
      ? inputAuthorization.walletID
      : inputAuthorization.binding.walletID
  const authorizedOutputKey =
    inputAuthorization.kind === "registered-wallet-output"
      ? inputAuthorization.outputKey
      : inputAuthorization.binding.outputKey
  if (
    JSON.stringify(suppliedEventIDs) !== JSON.stringify(normalized.eventIDs) ||
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
    !normalized.eventIDs.includes(normalized.inputBindingSourceEventID) ||
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
            variant.preparedTransaction
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

const appendSignerQuarantine = (
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
  reservation: P2TRSignatureFraudBoundNonceReservation,
  escaped: P2TRSignatureFraudPreparedChallengeTransaction
): P2TRSignatureFraudSignerQuarantine["reasonCode"] =>
  normalizeAddress(escaped.sender, "Escaped signed sender") !==
  normalizeAddress(reservation.sender, "Reserved signed sender")
    ? "wrong-sender"
    : escaped.nonce !== reservation.nonce
      ? "wrong-nonce"
      : "malformed-signed-envelope"

const classifyReplacementSignerFailure = (
  reservation: P2TRSignatureFraudBoundNonceReservation,
  _previous: P2TRSignatureFraudPreparedChallengeTransaction,
  escaped: P2TRSignatureFraudPreparedChallengeTransaction
): P2TRSignatureFraudSignerQuarantine["reasonCode"] => {
  const reservationMismatch = classifyReservationMismatch(reservation, escaped)
  if (
    reservationMismatch === "wrong-sender" ||
    reservationMismatch === "wrong-nonce"
  ) {
    return reservationMismatch
  }
  return "invalid-replacement-envelope"
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
  return [
    ...(existing ?? []),
    {
      preparedTransaction,
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
