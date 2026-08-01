import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  Hex,
  P2TRSignatureFraudBoundNonceReservation,
  P2TRSignatureFraudChallengeTransactionFeePolicy,
  P2TRSignatureFraudChallengeTransactionPreparer,
  P2TRSignatureFraudPreparedChallengeTransaction,
  P2TRSignatureFraudPreparedChallengeTransactionResponse,
  P2TRSignatureFraudSubmissionIntent,
  P2TRWatchtowerChallengeRecord,
  P2TR_SIGNATURE_FRAUD_COMPLETE_V2_CHALLENGE_EVIDENCE_ABI_TYPE,
  P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL,
  P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID,
  buildP2TRCompleteV2SignatureFraudChallengeEvidence,
  buildP2TRSignatureFraudSubmissionIntent,
  computeP2TRCompleteV2SignatureFraudChallengeIdentity,
  computeP2TRSignatureFraudSubmissionIntentID,
  computeP2TRSignatureFraudBoundNonceReservationID,
  computeP2TRSignatureFraudSigningRequestDigest,
  computeP2TRSignatureFraudSignerResponseBindingDigest,
  extractP2TRSignatureFraudWitnessObservations,
} from "@keep-network/tbtc-v2.ts"
import { Transaction } from "bitcoinjs-lib"
import { Wallet, utils } from "ethers"

import {
  P2TRSignatureFraudChallengeOutboxDispatcher,
  P2TRSignatureFraudCancellationEvidenceVerifier,
  P2TRSignatureFraudCanonicalCancellationEvidence,
  P2TRSignatureFraudCanonicalProvenanceBinding,
  P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence,
  P2TRSignatureFraudCanonicalResolutionEvidenceVerifier,
  P2TRSignatureFraudChallengeOutboxReconciliationContext,
  P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  P2TRSignatureFraudChallengeOutboxPage,
  P2TRSignatureFraudChallengeOutboxPageRequest,
  P2TRSignatureFraudChallengeOutboxReconciler,
  P2TRSignatureFraudChallengeOutboxRecord,
  P2TRSignatureFraudChallengeOutboxResolution,
  P2TRSignatureFraudChallengeOutboxScheduler,
  P2TRSignatureFraudChallengeOutboxStatus,
  P2TRSignatureFraudChallengeOutboxStore,
  P2TRSignatureFraudLegacySubmissionQuarantine,
  P2TRSignatureFraudIndependentNonceReleaseResolution,
  P2TRSignatureFraudAmbiguousNonceReleaseInvocation,
  P2TRSignatureFraudIrreversibleBoundaryAuthorization,
  P2TRSignatureFraudIrreversibleBoundaryAuthorizer,
  P2TRSignatureFraudIrreversibleBoundaryBinding,
  P2TRSignatureFraudNonceReleaseAttempt,
  P2TRSignatureFraudNonceReleaseAttemptResult,
  P2TRSignatureFraudNonceReleasePage,
  P2TRSignatureFraudNonceReleasePageRequest,
  P2TRSignatureFraudNonceReleaseRequest,
  P2TRSignatureFraudOutboxEvidenceCheckpoint,
  P2TRSignatureFraudOutboxCriticalAlert,
  P2TRSignatureFraudPreBroadcastRecheckContext,
  P2TRSignatureFraudPreBroadcastRechecker,
  P2TRSignatureFraudPreBroadcastRecheckResult,
  P2TRSignatureFraudRawTransactionBroadcaster,
  P2TRSignatureFraudSignerQuarantine,
  computeP2TRSignatureFraudEthereumEligibilityReadSetHash,
  computeP2TRSignatureFraudChallengeFeePolicyHash,
  computeP2TRSignatureFraudCancellationEvidenceHash,
  computeP2TRSignatureFraudCanonicalCandidateDigest,
  computeP2TRSignatureFraudCanonicalEventSetHash,
  computeP2TRSignatureFraudCanonicalProvenanceFingerprint,
  computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash,
  computeP2TRSignatureFraudOutboxRecordID,
  computeP2TRSignatureFraudOutboxSeriesID,
  computeP2TRSignatureFraudNonceReleaseRequestID,
  computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest,
  computeP2TRSignatureFraudResolutionEvidenceDigest,
  computeP2TRSignatureFraudSignerInvocationID,
  invalidateP2TRSignatureFraudCanonicalProvenance,
  quarantineLegacyP2TRSignatureFraudSubmissions,
} from "../src/P2TRSignatureFraudChallengeOutbox.js"
import {
  P2TRProductionActivationGate,
  P2TRProductionCandidateEnqueueRejectedError,
  type P2TRProductionActivationDependencies,
  type P2TRProductionCandidateAuthorizationToken,
} from "../src/P2TRProductionActivation.js"
import {
  InMemoryOutboxStore,
  RollbackAwareInMemoryOutboxStore,
  normalizeKey,
  normalizeOwner,
} from "./InMemoryP2TRSignatureFraudChallengeOutboxStore.js"

const TRANSACTION_SENDER = "0x17c5185167401eD00cF5F5b2fc97D9BBfDb7D025"
const SIGNER_LANE_ID = "lane.test"
const SIGNER_IDENTITY = "signer.test"
const ROUTER_ADDRESS = "0x2222222222222222222222222222222222222222"
const BRIDGE_ADDRESS = "0x1111111111111111111111111111111111111111"
const WALLET_ID = `0x${"bb".repeat(32)}`
const SIGHASH = `0x${"dd".repeat(32)}`
const SIGNATURE_NONCE_X = `0x${"11".repeat(32)}`
const SIGNATURE_SCALAR = `0x${"22".repeat(32)}`
const CHALLENGE_IDENTITY = computeP2TRCompleteV2SignatureFraudChallengeIdentity(
  {
    domainChainID: 11155111,
    bridgeAddress: BRIDGE_ADDRESS,
    walletID: WALLET_ID,
    signingKey: WALLET_ID,
    sighash: SIGHASH,
  }
).toPrefixedString()
const CHALLENGE_KEY = CHALLENGE_IDENTITY
const BITCOIN_TXID = `0x${"01".repeat(32)}`
const BITCOIN_WTXID = `0x${"05".repeat(32)}`
const BITCOIN_BLOCK_HASH = `0x${"02".repeat(32)}`
const BITCOIN_CURSOR_HASH = `0x${"03".repeat(32)}`
const ETHEREUM_CURSOR_HASH = `0x${"04".repeat(32)}`
const ROUTER_CODE_HASH = `0x${"a1".repeat(32)}`
const COMPLETE_REGISTRY_ADDRESS = "0x4444444444444444444444444444444444444444"
const COMPLETE_REGISTRY_CODE_HASH = `0x${"a2".repeat(32)}`
const ACTIVATION_MANIFEST_HASH = `0x${"a3".repeat(32)}`
const COMPLETE_REGISTRY_PROTOCOL_ID = utils.id(
  "tbtc/p2tr-pre-signing-reservation/threshold-v1"
)
const COMPLETE_RESERVATION_MODEL = utils.id(
  "tbtc/p2tr-pre-signing-policy/default-no-annex-51-seats-v1"
)

const completeV2TestCall = (sighash: string) => {
  const identity = computeP2TRCompleteV2SignatureFraudChallengeIdentity({
    domainChainID: 11155111,
    bridgeAddress: BRIDGE_ADDRESS,
    walletID: WALLET_ID,
    signingKey: WALLET_ID,
    sighash,
  })
  const payload = utils.defaultAbiCoder.encode(
    [P2TR_SIGNATURE_FRAUD_COMPLETE_V2_CHALLENGE_EVIDENCE_ABI_TYPE],
    [
      {
        walletID: WALLET_ID,
        signingKey: WALLET_ID,
        bindingTxHash: `0x${"00".repeat(32)}`,
        bindingOutputIndex: 0,
        sighash,
        nonceX: SIGNATURE_NONCE_X,
        signatureScalar: SIGNATURE_SCALAR,
      },
    ]
  )
  const calldata = new utils.Interface([
    "function processP2TRSignatureFraudChallenge(uint8 action, bytes payload, uint32[] walletMembersIDs)",
  ]).encodeFunctionData("processP2TRSignatureFraudChallenge", [0, payload, []])
  return { identity, calldata }
}

const signTestChallengeTransaction = (
  calldata: string,
  maxFeePerGas: number,
  maxPriorityFeePerGas: number,
  overrides: Partial<{
    chainId: number
    nonce: number
    to: string
    value: number
    data: string
  }> = {}
) => {
  const wallet = new Wallet(`0x${"42".repeat(32)}`)
  const transaction = {
    type: 2,
    chainId: overrides.chainId ?? 11155111,
    nonce: overrides.nonce ?? 7,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit: 1_000_000,
    to: overrides.to ?? ROUTER_ADDRESS,
    value: overrides.value ?? 1234,
    data: overrides.data ?? calldata,
    accessList: [],
  }
  const unsigned = utils.serializeTransaction(transaction)
  const signature = wallet._signingKey().signDigest(utils.keccak256(unsigned))
  const rawTransaction = utils.serializeTransaction(transaction, signature)
  return {
    rawTransaction,
    transactionHash: utils.keccak256(rawTransaction),
  }
}

const signLegacyTestChallengeTransaction = (calldata: string) => {
  const wallet = new Wallet(`0x${"42".repeat(32)}`)
  const transaction = {
    chainId: 11155111,
    nonce: 7,
    gasPrice: 2,
    gasLimit: 1_000_000,
    to: ROUTER_ADDRESS,
    value: 1234,
    data: calldata,
  }
  const unsigned = utils.serializeTransaction(transaction)
  const signature = wallet._signingKey().signDigest(utils.keccak256(unsigned))
  const rawTransaction = utils.serializeTransaction(transaction, signature)
  return {
    rawTransaction,
    transactionHash: utils.keccak256(rawTransaction),
  }
}

const defaultTestCall = completeV2TestCall(SIGHASH)
const signedTestTransaction = signTestChallengeTransaction(
  defaultTestCall.calldata,
  20,
  2
)
const replacementSignedTestTransaction = signTestChallengeTransaction(
  defaultTestCall.calldata,
  40,
  4
)
const RAW_TRANSACTION = signedTestTransaction.rawTransaction
const TRANSACTION_HASH = signedTestTransaction.transactionHash
const REPLACEMENT_RAW_TRANSACTION =
  replacementSignedTestTransaction.rawTransaction
const REPLACEMENT_TRANSACTION_HASH =
  replacementSignedTestTransaction.transactionHash
const legacySignedTestTransaction = signLegacyTestChallengeTransaction(
  defaultTestCall.calldata
)
const LEGACY_RAW_TRANSACTION = legacySignedTestTransaction.rawTransaction
const LEGACY_TRANSACTION_HASH = legacySignedTestTransaction.transactionHash

const activationManifest = (manifestHash = ACTIVATION_MANIFEST_HASH) => ({
  manifestHash,
  routerCodeHash: ROUTER_CODE_HASH,
  routerProtocolID: P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID,
  routerDomainChainID: 11155111,
  completeAuthorizationRegistryAddress: COMPLETE_REGISTRY_ADDRESS,
  completeAuthorizationRegistryCodeHash: COMPLETE_REGISTRY_CODE_HASH,
  completeAuthorizationRegistryProtocolID: COMPLETE_REGISTRY_PROTOCOL_ID,
  completeReservationModel: COMPLETE_RESERVATION_MODEL,
})

const feePolicyManifest = (
  activationManifestHash = ACTIVATION_MANIFEST_HASH,
  challengeValueWei = "1234"
) => {
  const withoutHash = {
    activationManifestHash,
    chainID: 11155111,
    challengeValueWei,
    lanes: [
      {
        laneID: SIGNER_LANE_ID,
        signerIdentity: SIGNER_IDENTITY,
        sender: TRANSACTION_SENDER,
        maxGasLimit: "1000000",
        maxFeePerGas: "100",
        maxPriorityFeePerGas: "10",
        maxTotalFeeWei: "100000000",
      },
    ],
  }
  return {
    ...withoutHash,
    policyHash: computeP2TRSignatureFraudChallengeFeePolicyHash(withoutHash),
  }
}

const ethereumEligibility = (
  identity: {
    chainID: number
    routerAddress: string
    bridgeAddress: string
    bridgeChallengeKey: Hex | string
    bridgeChallengeIdentity: Hex | string
    walletID: Hex | string
  },
  blockNumber: number,
  blockHash: string,
  unrelatedActiveReservationChallengeIdentity?: string,
  fraudChallengeDepositAmount = "1234",
  activationManifestHash = ACTIVATION_MANIFEST_HASH
) => {
  const withoutHash = {
    readAtBlockNumber: blockNumber,
    readAtBlockHash: blockHash,
    chainID: identity.chainID,
    routerAddress: identity.routerAddress,
    routerCodeHash: ROUTER_CODE_HASH,
    routerProtocolID: P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID,
    routerDomainChainID: identity.chainID,
    routerBridgeAddress: identity.bridgeAddress,
    routerChallengeKey:
      identity.bridgeChallengeKey instanceof Hex
        ? identity.bridgeChallengeKey.toPrefixedString()
        : identity.bridgeChallengeKey,
    routerChallengeAbsent: true as const,
    fraudChallengeDepositAmount,
    completeAuthorizationRegistryAddress: COMPLETE_REGISTRY_ADDRESS,
    completeAuthorizationRegistryCodeHash: COMPLETE_REGISTRY_CODE_HASH,
    completeAuthorizationRegistryProtocolID: COMPLETE_REGISTRY_PROTOCOL_ID,
    completeReservationModel: COMPLETE_RESERVATION_MODEL,
    completeChallengeIdentity:
      identity.bridgeChallengeIdentity instanceof Hex
        ? identity.bridgeChallengeIdentity.toPrefixedString()
        : identity.bridgeChallengeIdentity,
    completeWalletID:
      identity.walletID instanceof Hex
        ? identity.walletID.toPrefixedString()
        : identity.walletID,
    completeExactChallengeAuthorizationAbsent: true as const,
    completeExactTransactionAuthorizationAbsent: true as const,
    completeWalletReservationActive:
      unrelatedActiveReservationChallengeIdentity !== undefined,
    completeActiveReservationChallengeIdentity:
      unrelatedActiveReservationChallengeIdentity,
    walletChallengeable: true as const,
    canonicalProofBacklogComplete: true as const,
    activationManifestHash,
  }
  return {
    ...withoutHash,
    readSetHash:
      computeP2TRSignatureFraudEthereumEligibilityReadSetHash(withoutHash),
  }
}

const canonicalProvenance = (
  candidate: {
    txid: string
    wtxid: string
    blockHash: string
    blockHeight: number
    inputIndex: number
  },
  observationID: Hex | string,
  checkpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint,
  challengeKey: Hex | string,
  seed = "71",
  inputBinding: {
    kind: "registered-wallet-output" | "deposit-binding"
    sourceEventID: string
    inputIndex: number
    fundingBlockHash: string
    fundingTxid: string
    fundingVout: number
    walletID: string
    outputKey: string
    ethereumBlockNumber: number
    ethereumBlockHash: string
  } = {
    kind: "registered-wallet-output",
    sourceEventID: `0x${"73".repeat(32)}`,
    inputIndex: candidate.inputIndex,
    fundingBlockHash: `0x${"74".repeat(32)}`,
    fundingTxid: `0x${"78".repeat(32)}`,
    fundingVout: 0,
    walletID: WALLET_ID,
    outputKey: WALLET_ID,
    ethereumBlockNumber: checkpoint.ethereumLifecycleBlockNumber - 1,
    ethereumBlockHash: `0x${"75".repeat(32)}`,
  }
): P2TRSignatureFraudCanonicalProvenanceBinding => {
  const withoutFingerprint = {
    journalStoreID: "canonical-index.test",
    descriptorSetHash: `0x${"72".repeat(32)}`,
    throughBlockNumber: checkpoint.ethereumLifecycleBlockNumber,
    throughBlockHash: checkpoint.ethereumLifecycleBlockHash,
    historyRoot: `0x${seed.repeat(32)}`,
    eventSetHash: computeP2TRSignatureFraudCanonicalEventSetHash([
      inputBinding.sourceEventID,
    ]),
    eventCount: 1,
    challengeKey:
      challengeKey instanceof Hex
        ? challengeKey.toPrefixedString()
        : challengeKey,
    candidateDigest: computeP2TRSignatureFraudCanonicalCandidateDigest(
      candidate,
      observationID
    ),
    readinessCertificateID: `0x${"77".repeat(32)}`,
    readinessCertificateGeneration: 1,
    candidateProvenanceGeneration: 1,
    inputBindingKind: inputBinding.kind,
    inputBindingSourceEventID: inputBinding.sourceEventID,
    inputIndex: inputBinding.inputIndex,
    fundingBlockHash: inputBinding.fundingBlockHash,
    fundingTxid: inputBinding.fundingTxid,
    fundingVout: inputBinding.fundingVout,
    inputWalletID: inputBinding.walletID,
    inputOutputKey: inputBinding.outputKey,
    bindingEthereumBlockNumber: inputBinding.ethereumBlockNumber,
    bindingEthereumBlockHash: inputBinding.ethereumBlockHash,
    manifestHash: ACTIVATION_MANIFEST_HASH,
  }
  return {
    ...withoutFingerprint,
    provenanceFingerprint:
      computeP2TRSignatureFraudCanonicalProvenanceFingerprint(
        withoutFingerprint
      ),
  }
}

const refingerprintProvenance = (
  binding: P2TRSignatureFraudCanonicalProvenanceBinding,
  updates: Partial<
    Omit<P2TRSignatureFraudCanonicalProvenanceBinding, "provenanceFingerprint">
  >
): P2TRSignatureFraudCanonicalProvenanceBinding => {
  const { provenanceFingerprint: _ignored, ...withoutFingerprint } = binding
  const next = { ...withoutFingerprint, ...updates }
  return {
    ...next,
    provenanceFingerprint:
      computeP2TRSignatureFraudCanonicalProvenanceFingerprint(next),
  }
}

class FixedPreparer implements P2TRSignatureFraudChallengeTransactionPreparer {
  readonly laneID = SIGNER_LANE_ID
  readonly signerIdentity = SIGNER_IDENTITY
  readonly transactionSender = TRANSACTION_SENDER
  readonly wallet = new Wallet(`0x${"42".repeat(32)}`)
  calls = 0
  replacementCalls = 0
  readonly initialInvocationIDs: string[] = []
  readonly replacementInvocationIDs: string[] = []
  readonly tombstonedInvocationIDs = new Set<string>()
  reservationCalls = 0
  releasedReservations: string[] = []
  readonly acknowledgedReleaseRequests = new Set<string>()
  releaseError?: Error
  rawTransaction = RAW_TRANSACTION
  transactionHash = TRANSACTION_HASH
  replacementRawTransaction = REPLACEMENT_RAW_TRANSACTION
  replacementTransactionHash = REPLACEMENT_TRANSACTION_HASH
  afterReservation?: (
    reservation: P2TRSignatureFraudBoundNonceReservation
  ) => Promise<void>
  afterInitialSign?: (
    prepared: P2TRSignatureFraudPreparedChallengeTransaction
  ) => Promise<void>
  afterReplacementSign?: (
    prepared: P2TRSignatureFraudPreparedChallengeTransaction
  ) => Promise<void>
  mutateInitialResponse?: (
    prepared: P2TRSignatureFraudPreparedChallengeTransactionResponse
  ) => P2TRSignatureFraudPreparedChallengeTransactionResponse

  async reserveSignatureFraudChallengeNonce(
    intent: P2TRSignatureFraudSubmissionIntent,
    outboxRecordID: Hex,
    generation: number,
    reservationEpoch: number
  ): Promise<P2TRSignatureFraudBoundNonceReservation> {
    this.reservationCalls++
    const nonce = 7
    const reservationID = computeP2TRSignatureFraudBoundNonceReservationID(
      intent,
      outboxRecordID,
      generation,
      reservationEpoch,
      this,
      nonce
    )
    const domain = {
      name: "tBTC P2TR Fraud Outbox",
      version: "1",
      chainId: intent.chainID,
      verifyingContract: intent.routerAddress,
    }
    const types = {
      NonceReservation: [
        { name: "domain", type: "string" },
        { name: "outboxRecordID", type: "bytes32" },
        { name: "intentID", type: "bytes32" },
        { name: "generation", type: "uint32" },
        { name: "reservationEpoch", type: "uint32" },
        { name: "laneIDHash", type: "bytes32" },
        { name: "signerIdentityHash", type: "bytes32" },
        { name: "sender", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    }
    const value = {
      domain: "tbtc-p2tr-signature-fraud-nonce-reservation-v1",
      outboxRecordID: outboxRecordID.toPrefixedString(),
      intentID: intent.intentID.toPrefixedString(),
      generation,
      reservationEpoch,
      laneIDHash: utils.id(this.laneID),
      signerIdentityHash: utils.id(this.signerIdentity),
      sender: this.transactionSender,
      nonce,
    }
    const reservation = {
      reservationID,
      outboxRecordID,
      intentID: intent.intentID,
      generation,
      reservationEpoch,
      laneID: this.laneID,
      signerIdentity: this.signerIdentity,
      sender: this.transactionSender,
      nonce,
      bindingSignature: await this.wallet._signTypedData(domain, types, value),
    }
    await this.afterReservation?.(reservation)
    return reservation
  }

  async releaseSignatureFraudChallengeNonce(
    reservation: P2TRSignatureFraudBoundNonceReservation,
    releaseRequestID: Hex
  ) {
    if (this.releaseError !== undefined) throw this.releaseError
    this.releasedReservations.push(reservation.reservationID.toPrefixedString())
    const key = releaseRequestID.toPrefixedString()
    const outcome = this.acknowledgedReleaseRequests.has(key)
      ? "already-released"
      : "released"
    this.acknowledgedReleaseRequests.add(key)
    return {
      releaseRequestID,
      reservationID: reservation.reservationID,
      outcome,
      responseDigest: Hex.from(
        utils.keccak256(
          utils.toUtf8Bytes(
            `${key}:${reservation.reservationID.toPrefixedString()}:${outcome}`
          )
        )
      ),
    }
  }

  async prepareSignatureFraudChallengeTransaction(
    intent: P2TRSignatureFraudSubmissionIntent,
    _reservation: P2TRSignatureFraudBoundNonceReservation,
    _feePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy,
    signerInvocationID: Hex,
    signingRequestDigest: Hex
  ): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    const invocationID = signerInvocationID.toPrefixedString()
    if (this.tombstonedInvocationIDs.has(invocationID)) {
      throw new Error("signer invocation is tombstoned")
    }
    this.initialInvocationIDs.push(invocationID)
    this.calls++
    await Promise.resolve()
    const prepared = await this.authenticateResponse(
      {
        intentID: intent.intentID,
        rawTransaction: this.rawTransaction,
        transactionHash: Hex.from(this.transactionHash),
        sender: TRANSACTION_SENDER,
        nonce: 7,
      },
      signerInvocationID,
      signingRequestDigest
    )
    await this.afterInitialSign?.(prepared)
    return this.mutateInitialResponse?.(prepared) ?? prepared
  }

  async prepareSignatureFraudChallengeReplacementTransaction(
    intent: P2TRSignatureFraudSubmissionIntent,
    _reservation: P2TRSignatureFraudBoundNonceReservation,
    _previous: P2TRSignatureFraudPreparedChallengeTransaction,
    _feePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy,
    signerInvocationID: Hex,
    signingRequestDigest: Hex
  ): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    const invocationID = signerInvocationID.toPrefixedString()
    if (this.tombstonedInvocationIDs.has(invocationID)) {
      throw new Error("signer invocation is tombstoned")
    }
    this.replacementInvocationIDs.push(invocationID)
    this.replacementCalls++
    await Promise.resolve()
    const prepared = await this.authenticateResponse(
      {
        intentID: intent.intentID,
        rawTransaction: this.replacementRawTransaction,
        transactionHash: Hex.from(this.replacementTransactionHash),
        sender: TRANSACTION_SENDER,
        nonce: 7,
      },
      signerInvocationID,
      signingRequestDigest
    )
    await this.afterReplacementSign?.(prepared)
    return prepared
  }

  protected async authenticateResponse(
    prepared: P2TRSignatureFraudPreparedChallengeTransaction,
    signerInvocationID: Hex,
    signingRequestDigest: Hex
  ): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    const responseDigest = computeP2TRSignatureFraudSignerResponseBindingDigest(
      signingRequestDigest,
      signerInvocationID,
      prepared.transactionHash
    )
    return {
      ...prepared,
      signerInvocationID,
      signingRequestDigest,
      responseBindingSignature: await this.wallet.signMessage(
        utils.arrayify(responseDigest.toPrefixedString())
      ),
    }
  }

  async tombstoneSignatureFraudSignerInvocation(signerInvocationID: Hex) {
    const invocationID = signerInvocationID.toPrefixedString()
    this.tombstonedInvocationIDs.add(invocationID)
    return {
      invocationID: signerInvocationID,
      tombstonedAtUnixMs: 1_900,
      receiptDigest: Hex.from(
        utils.keccak256(utils.toUtf8Bytes(`tombstone:${invocationID}`))
      ),
    }
  }
}

class AmbiguousRemotePreparer extends FixedPreparer {
  override async prepareSignatureFraudChallengeTransaction(): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    this.calls++
    throw new Error("remote signer disconnected after signing")
  }
}

class DynamicFeePreparer extends FixedPreparer {
  initialGasLimit = 1_000_000
  initialMaxFeePerGas = 100
  initialPriorityFeePerGas = 10
  initialValue = "1234"
  replacementGasLimit = 1_000_000
  replacementMaxFeePerGas = 101
  replacementPriorityFeePerGas = 11

  private async sign(
    intent: P2TRSignatureFraudSubmissionIntent,
    gasLimit: number,
    maxFeePerGas: number,
    maxPriorityFeePerGas: number,
    value: string,
    signerInvocationID: Hex,
    signingRequestDigest: Hex
  ): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    const rawTransaction = await this.wallet.signTransaction({
      type: 2,
      to: intent.routerAddress,
      data: intent.calldata,
      value,
      chainId: intent.chainID,
      nonce: 7,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    const parsed = utils.parseTransaction(rawTransaction)
    return this.authenticateResponse(
      {
        intentID: intent.intentID,
        rawTransaction,
        transactionHash: Hex.from(parsed.hash!),
        sender: this.wallet.address,
        nonce: 7,
      },
      signerInvocationID,
      signingRequestDigest
    )
  }

  override async prepareSignatureFraudChallengeTransaction(
    intent: P2TRSignatureFraudSubmissionIntent,
    _reservation: P2TRSignatureFraudBoundNonceReservation,
    _feePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy,
    signerInvocationID: Hex,
    signingRequestDigest: Hex
  ): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    this.calls++
    return this.sign(
      intent,
      this.initialGasLimit,
      this.initialMaxFeePerGas,
      this.initialPriorityFeePerGas,
      this.initialValue,
      signerInvocationID,
      signingRequestDigest
    )
  }

  override async prepareSignatureFraudChallengeReplacementTransaction(
    intent: P2TRSignatureFraudSubmissionIntent,
    _reservation: P2TRSignatureFraudBoundNonceReservation,
    _previous: P2TRSignatureFraudPreparedChallengeTransaction,
    _feePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy,
    signerInvocationID: Hex,
    signingRequestDigest: Hex
  ): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    this.replacementCalls++
    return this.sign(
      intent,
      this.replacementGasLimit,
      this.replacementMaxFeePerGas,
      this.replacementPriorityFeePerGas,
      this.initialValue,
      signerInvocationID,
      signingRequestDigest
    )
  }
}

class RecordingBroadcaster
  implements P2TRSignatureFraudRawTransactionBroadcaster
{
  readonly submissionTrustDomainID = "submission.test"
  readonly submissionIndependenceDomainID = "submission-infra.test"
  readonly providerIdentity = {}
  readonly rawTransactions: string[] = []
  throwAfterSend?: Error
  returnedHash = TRANSACTION_HASH
  inspectDurableBoundary?: () => Promise<void>

  async broadcastRawTransaction(rawTransaction: string): Promise<string> {
    await this.inspectDurableBoundary?.()
    this.rawTransactions.push(rawTransaction)
    if (this.throwAfterSend !== undefined) throw this.throwAfterSend
    return this.returnedHash
  }
}

class FixedBoundaryAuthorizer
  implements P2TRSignatureFraudIrreversibleBoundaryAuthorizer
{
  readonly bindings: P2TRSignatureFraudIrreversibleBoundaryBinding[] = []
  rejectAuthorization?: Error
  rejectConsumption?: Error
  beforeAuthorize?: (
    binding: P2TRSignatureFraudIrreversibleBoundaryBinding
  ) => Promise<void>
  onConsume?: (binding: P2TRSignatureFraudIrreversibleBoundaryBinding) => void
  private readonly pending = new WeakMap<object, string>()

  async authorizeP2TRSignatureFraudIrreversibleBoundary(
    binding: P2TRSignatureFraudIrreversibleBoundaryBinding
  ): Promise<P2TRSignatureFraudIrreversibleBoundaryAuthorization> {
    await this.beforeAuthorize?.(binding)
    if (this.rejectAuthorization !== undefined) {
      throw this.rejectAuthorization
    }
    const exact = structuredClone(binding)
    this.bindings.push(exact)
    const authorization = Object.freeze(
      {}
    ) as P2TRSignatureFraudIrreversibleBoundaryAuthorization
    this.pending.set(authorization, JSON.stringify(exact))
    return authorization
  }

  assertAndConsumeP2TRSignatureFraudIrreversibleBoundaryAuthorization(
    authorization: P2TRSignatureFraudIrreversibleBoundaryAuthorization,
    binding: P2TRSignatureFraudIrreversibleBoundaryBinding
  ): void {
    const expected = this.pending.get(authorization as object)
    this.pending.delete(authorization as object)
    if (expected === undefined || expected !== JSON.stringify(binding)) {
      throw new Error("test boundary authorization is invalid or replayed")
    }
    if (this.rejectConsumption !== undefined) {
      throw this.rejectConsumption
    }
    this.onConsume?.(binding)
  }
}

class FixedRechecker implements P2TRSignatureFraudPreBroadcastRechecker {
  readonly recheckTrustDomainID = "recheck.test"
  readonly recheckIndependenceDomainID = "recheck-infra.test"
  readonly providerIdentity = {}
  resolution?: P2TRSignatureFraudPreBroadcastRecheckResult
  readonly stages: P2TRSignatureFraudPreBroadcastRecheckContext["stage"][] = []

  async recheckSignatureFraudChallengeBeforeBroadcast(
    context: P2TRSignatureFraudPreBroadcastRecheckContext
  ): Promise<P2TRSignatureFraudPreBroadcastRecheckResult> {
    this.stages.push(context.stage)
    return (
      this.resolution ?? {
        status: "eligible",
        canonicalCandidate: {
          txid: context.evidenceCheckpoint.bitcoinTxHash,
          wtxid: context.evidenceCheckpoint.bitcoinWitnessTxHash,
          blockHash: context.evidenceCheckpoint.bitcoinBlockHash,
          blockHeight: context.evidenceCheckpoint.bitcoinBlockHeight,
          inputIndex: context.evidenceCheckpoint.bitcoinInputIndex,
        },
        canonicalEthereumEligibility: ethereumEligibility(
          context.intent,
          context.evidenceCheckpoint.ethereumLifecycleBlockNumber,
          context.evidenceCheckpoint.ethereumLifecycleBlockHash
        ),
        canonicalProvenance: context.canonicalProvenance,
      }
    )
  }
}

class FixedReconciler implements P2TRSignatureFraudChallengeOutboxReconciler {
  readonly reconciliationTrustDomainID = "reconciliation.test"
  readonly reconciliationIndependenceDomainID = "reconciliation-infra.test"
  readonly providerIdentity = {}
  readonly finalityConfirmationBlocks = 12
  readonly canonicalSubmissionSelectors = [
    { variant: "router-process" as const, selector: "0xf1f87d85" },
    { variant: "router-direct" as const, selector: "0xa1c114f9" },
  ]
  resolution: P2TRSignatureFraudChallengeOutboxResolution = {
    status: "pending",
    reason: "transaction is not final",
  }

  async reconcileSignatureFraudChallengeOutbox(): Promise<P2TRSignatureFraudChallengeOutboxResolution> {
    return this.resolution
  }
}

class FixedCancellationVerifier
  implements P2TRSignatureFraudCancellationEvidenceVerifier
{
  readonly cancellationVerificationTrustDomainID = "cancellation.test"
  readonly cancellationVerificationIndependenceDomainID =
    "cancellation-infra.test"
  readonly providerIdentity = {}

  async verifySignatureFraudCancellationEvidence(
    _context: P2TRSignatureFraudPreBroadcastRecheckContext,
    evidence: P2TRSignatureFraudCanonicalCancellationEvidence
  ) {
    return {
      status: "verified" as const,
      evidenceHash: evidence.evidenceHash,
      verifiedAtUnixMs: evidence.agreement.checkedAtUnixMs,
      corroboratingAttestation: evidence.agreement.corroboratingAttestation,
    }
  }
}

class FixedCanonicalResolutionVerifier
  implements P2TRSignatureFraudCanonicalResolutionEvidenceVerifier
{
  readonly canonicalVerificationTrustDomainID = "canonical.test"
  readonly canonicalVerificationIndependenceDomainID = "canonical-infra.test"
  readonly providerIdentity = {}

  async verifySignatureFraudCanonicalResolutionEvidence(
    _context: P2TRSignatureFraudChallengeOutboxReconciliationContext,
    resolution: Exclude<
      P2TRSignatureFraudChallengeOutboxResolution,
      { status: "pending" | "unknown" }
    >
  ) {
    const corroborating = resolution.canonicalAttestations[1]
    return {
      status: "verified" as const,
      evidenceDigest:
        computeP2TRSignatureFraudResolutionEvidenceDigest(resolution),
      trustDomainID: this.canonicalVerificationTrustDomainID,
      independenceDomainID: this.canonicalVerificationIndependenceDomainID,
      attestation: corroborating.attestation,
      verifiedAtUnixMs: corroborating.attestedAtUnixMs,
    }
  }
}

const createIntent = (seed = "aa"): P2TRSignatureFraudSubmissionIntent => {
  const sighash = seed === "aa" ? SIGHASH : `0x${seed.repeat(32)}`
  const completeCall = completeV2TestCall(sighash)
  const withoutID: Omit<P2TRSignatureFraudSubmissionIntent, "intentID"> = {
    protocol: P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL,
    evidenceProtocolID: Hex.from(P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID),
    observationID: Hex.from(`0x${seed.repeat(32)}`),
    inputIndex: 0,
    bridgeChallengeKey: completeCall.identity,
    walletID: Hex.from(WALLET_ID),
    signingKey: Hex.from(WALLET_ID),
    bindingTxHash: Hex.from(`0x${"00".repeat(32)}`),
    bindingOutputIndex: 0,
    bridgeChallengeIdentity: completeCall.identity,
    sighash: Hex.from(sighash),
    nonceX: Hex.from(SIGNATURE_NONCE_X),
    signatureScalar: Hex.from(SIGNATURE_SCALAR),
    domainChainID: 11155111,
    chainID: 11155111,
    bridgeAddress: BRIDGE_ADDRESS,
    routerAddress: ROUTER_ADDRESS,
    calldata: completeCall.calldata,
    value: "1234",
  }
  return {
    ...withoutID,
    intentID: computeP2TRSignatureFraudSubmissionIntentID(withoutID),
  }
}

const evidenceCheckpoint = (): P2TRSignatureFraudOutboxEvidenceCheckpoint => ({
  confirmedSourceComplete: true,
  bitcoinTxHash: BITCOIN_TXID,
  bitcoinWitnessTxHash: BITCOIN_WTXID,
  bitcoinInputIndex: 0,
  bitcoinBlockHash: BITCOIN_BLOCK_HASH,
  bitcoinBlockHeight: 100,
  bitcoinCursorBlockHash: BITCOIN_CURSOR_HASH,
  bitcoinCursorBlockHeight: 120,
  ethereumLifecycleBlockHash: ETHEREUM_CURSOR_HASH,
  ethereumLifecycleBlockNumber: 500,
  activationManifest: activationManifest(),
  submittedEventScanFromBlock: 50,
})

const createRecord = (
  intent = createIntent(),
  evidence = evidenceCheckpoint()
): P2TRSignatureFraudChallengeOutboxRecord => {
  const policy = feePolicyManifest()
  const eligibility = ethereumEligibility(
    intent,
    evidence.ethereumLifecycleBlockNumber,
    evidence.ethereumLifecycleBlockHash
  )
  const candidate = {
    txid: evidence.bitcoinTxHash,
    wtxid: evidence.bitcoinWitnessTxHash,
    blockHash: evidence.bitcoinBlockHash,
    blockHeight: evidence.bitcoinBlockHeight,
    inputIndex: evidence.bitcoinInputIndex,
  }
  const provenance = canonicalProvenance(
    candidate,
    intent.observationID,
    evidence,
    intent.bridgeChallengeKey
  )
  const generationTrigger = { kind: "initial" as const }
  return {
    seriesID: computeP2TRSignatureFraudOutboxSeriesID(intent),
    recordID: computeP2TRSignatureFraudOutboxRecordID(
      intent,
      0,
      evidence,
      eligibility,
      provenance,
      policy,
      generationTrigger
    ),
    intent,
    evidenceCheckpoint: evidence,
    canonicalEthereumEligibility: eligibility,
    canonicalProvenance: provenance,
    feePolicyManifest: policy,
    status: "queued",
    version: 0,
    generation: 0,
    generationTrigger,
    createdAtUnixMs: 1_000,
    updatedAtUnixMs: 1_000,
    preparationAttempts: 0,
    broadcastAttempts: 0,
    reconciliationAttempts: 0,
  }
}

const enqueue = async (
  store: InMemoryOutboxStore,
  intent = createIntent()
): Promise<P2TRSignatureFraudChallengeOutboxRecord> =>
  store.insertGenerationIfAbsent(createRecord(intent))

const provenanceInvalidationEvidence = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  invalidatedAtUnixMs = 2_000
): P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence => {
  const withoutHash = {
    provenanceTombstoneID: `0x${"74".repeat(32)}`,
    candidate: {
      txid: record.evidenceCheckpoint.bitcoinTxHash,
      wtxid: record.evidenceCheckpoint.bitcoinWitnessTxHash,
      inputIndex: record.evidenceCheckpoint.bitcoinInputIndex,
      blockHash: record.evidenceCheckpoint.bitcoinBlockHash,
      blockHeight: record.evidenceCheckpoint.bitcoinBlockHeight,
    },
    observationID: record.intent.observationID.toPrefixedString(),
    candidateDigest: record.canonicalProvenance.candidateDigest,
    candidateProvenanceGeneration:
      record.canonicalProvenance.candidateProvenanceGeneration,
    provenanceFingerprint: record.canonicalProvenance.provenanceFingerprint,
    manifestHash: record.canonicalProvenance.manifestHash,
    ethereumRollbackBlockHash: `0x${"75".repeat(32)}`,
    ethereumRollbackBlockNumber:
      record.canonicalProvenance.throughBlockNumber - 1,
    provenanceInvalidationSequence: 1,
    invalidatedAtUnixMs,
    reason: "canonical Ethereum journal rollback orphaned an authority event",
  }
  return {
    ...withoutHash,
    evidenceHash:
      computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash(
        withoutHash
      ),
  }
}

const cancellationEvidence = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  kind: "honest-spend" | "canonical-reorg"
): P2TRSignatureFraudCanonicalCancellationEvidence => {
  const common = {
    originalCandidate: {
      txid: record.evidenceCheckpoint.bitcoinTxHash,
      wtxid: record.evidenceCheckpoint.bitcoinWitnessTxHash,
      inputIndex: record.evidenceCheckpoint.bitcoinInputIndex,
      blockHash: record.evidenceCheckpoint.bitcoinBlockHash,
      blockHeight: record.evidenceCheckpoint.bitcoinBlockHeight,
    },
    canonicalCursor: {
      bitcoinBlockHash: `0x${"31".repeat(32)}`,
      bitcoinBlockHeight: 130,
      ethereumBlockHash: `0x${"32".repeat(32)}`,
      ethereumBlockNumber: 520,
    },
    agreement: {
      primaryTrustDomainID: "recheck.test",
      corroboratingTrustDomainID: "cancellation.test",
      primaryIndependenceDomainID: "recheck-infra.test",
      corroboratingIndependenceDomainID: "cancellation-infra.test",
      primaryAttestation: "0x11",
      corroboratingAttestation: "0x22",
      checkedAtUnixMs: 1_500,
    },
  }
  const withoutHash =
    kind === "canonical-reorg"
      ? {
          ...common,
          kind,
          candidateCurrent: false as const,
          replacementCanonicalTip: {
            blockHash: `0x${"33".repeat(32)}`,
            blockHeight: 130,
          },
        }
      : {
          ...common,
          kind,
          conflictingOutpoint: {
            txid: `0x${"34".repeat(32)}`,
            vout: 0,
          },
          canonicalSpend: {
            txid: `0x${"35".repeat(32)}`,
            wtxid: `0x${"36".repeat(32)}`,
            inputIndex: 0,
            blockHash: `0x${"37".repeat(32)}`,
            blockHeight: 125,
          },
          bridgeProofReceipt: {
            transactionHash: `0x${"38".repeat(32)}`,
            blockHash: `0x${"39".repeat(32)}`,
            blockNumber: 510,
            logIndex: 1,
            proofType: "deposit-sweep",
          },
        }
  return {
    ...withoutHash,
    evidenceHash:
      computeP2TRSignatureFraudCancellationEvidenceHash(withoutHash),
  }
}

const dispatcher = (
  store: InMemoryOutboxStore,
  preparer = new FixedPreparer(),
  broadcaster = new RecordingBroadcaster(),
  rechecker = new FixedRechecker(),
  reconciler = new FixedReconciler(),
  now = () => 2_000,
  recoveryPageSize = 100,
  onRecoveryBacklog?: (report: {
    backlogRemaining: boolean
  }) => Promise<void> | void,
  boundaryAuthorizer = new FixedBoundaryAuthorizer()
) =>
  new P2TRSignatureFraudChallengeOutboxDispatcher(
    store,
    preparer,
    broadcaster,
    rechecker,
    new FixedCancellationVerifier(),
    reconciler,
    new FixedCanonicalResolutionVerifier(),
    {
      irreversibleBoundaryAuthorizer: boundaryAuthorizer,
      minimumRebroadcastIntervalMs: 0,
      recoveryPageSize,
      onRecoveryBacklog,
      now,
    }
  )

const withCanonicalAttestations = (
  resolution: Omit<
    Exclude<
      P2TRSignatureFraudChallengeOutboxResolution,
      { status: "pending" | "unknown" }
    >,
    "canonicalAttestations"
  >
): Exclude<
  P2TRSignatureFraudChallengeOutboxResolution,
  { status: "pending" | "unknown" }
> => {
  const placeholderDigest = `0x${"00".repeat(32)}`
  const provisional = {
    ...resolution,
    canonicalAttestations: [
      {
        trustDomainID: "reconciliation.test",
        independenceDomainID: "reconciliation-infra.test",
        evidenceDigest: placeholderDigest,
        attestation: "0x11",
        attestedAtUnixMs: 1_500,
      },
      {
        trustDomainID: "canonical.test",
        independenceDomainID: "canonical-infra.test",
        evidenceDigest: placeholderDigest,
        attestation: "0x22",
        attestedAtUnixMs: 1_500,
      },
    ],
  } as unknown as Exclude<
    P2TRSignatureFraudChallengeOutboxResolution,
    { status: "pending" | "unknown" }
  >
  const evidenceDigest =
    computeP2TRSignatureFraudResolutionEvidenceDigest(provisional)
  return {
    ...provisional,
    canonicalAttestations: [
      { ...provisional.canonicalAttestations[0], evidenceDigest },
      { ...provisional.canonicalAttestations[1], evidenceDigest },
    ],
  }
}

const acceptedOwnResolution = (
  transactionHash = TRANSACTION_HASH
): P2TRSignatureFraudChallengeOutboxResolution =>
  withCanonicalAttestations({
    status: "accepted-own",
    observedHead: {
      blockNumber: 120,
      blockHash: `0x${"12".repeat(32)}`,
    },
    finalizedThrough: {
      blockNumber: 108,
      blockHash: `0x${"18".repeat(32)}`,
    },
    consensusFinalized: true,
    receipt: {
      transactionHash,
      status: 1,
      blockNumber: 100,
      blockHash: `0x${"10".repeat(32)}`,
    },
    transaction: {
      transactionHash,
      sender: TRANSACTION_SENDER,
      routerAddress: ROUTER_ADDRESS,
      calldata: defaultTestCall.calldata,
      value: "1234",
      nonce: 7,
      chainID: 11155111,
      blockNumber: 100,
      blockHash: `0x${"10".repeat(32)}`,
      decodedSubmissionCall: {
        variant: "router-process",
        selector: "0xf1f87d85",
        action: "submit",
        walletID: WALLET_ID,
        bridgeChallengeIdentity: CHALLENGE_IDENTITY,
        challengeKey: CHALLENGE_KEY,
        sighash: SIGHASH,
      },
    },
    routerChallenge: {
      exists: true,
      challengeKey: CHALLENGE_KEY,
      challenger: TRANSACTION_SENDER,
      depositAmount: "1234",
      reportedAt: 999,
      resolved: false,
      readAtBlock: 108,
    },
    submittedEvent: {
      routerAddress: ROUTER_ADDRESS,
      transactionHash,
      blockNumber: 100,
      blockHash: `0x${"10".repeat(32)}`,
      blockTimestamp: 999,
      logIndex: 4,
      walletID: WALLET_ID,
      walletPubKeyHash: `0x${"ee".repeat(20)}`,
      bridgeChallengeIdentity: CHALLENGE_IDENTITY,
      challengeKey: CHALLENGE_KEY,
      sighash: SIGHASH,
    },
  } as Parameters<typeof withCanonicalAttestations>[0])

const externalResolution = (
  status:
    | "satisfied-external"
    | "external-satisfied-awaiting-own-transaction" = "satisfied-external",
  depositAmount = "1500"
): Extract<
  P2TRSignatureFraudChallengeOutboxResolution,
  {
    status:
      | "accepted-own"
      | "satisfied-external"
      | "external-satisfied-awaiting-own-transaction"
  }
> => {
  const own = acceptedOwnResolution()
  assert.equal(own.status, "accepted-own")
  const { canonicalAttestations: _ignoredAttestations, ...ownEvidence } = own
  const transactionHash = `0x${"77".repeat(32)}`
  const sender = "0x3333333333333333333333333333333333333333"
  return withCanonicalAttestations({
    ...ownEvidence,
    status,
    receipt: { ...own.receipt, transactionHash },
    transaction: {
      ...own.transaction,
      transactionHash,
      sender,
      calldata: "0xdeadbeef",
      value: depositAmount,
      nonce: 3,
      decodedSubmissionCall: {
        ...own.transaction.decodedSubmissionCall,
        variant: "router-direct",
        selector: "0xa1c114f9",
      },
    },
    routerChallenge: {
      ...own.routerChallenge,
      challenger: sender,
      depositAmount,
    },
    submittedEvent: { ...own.submittedEvent, transactionHash },
  } as Parameters<typeof withCanonicalAttestations>[0]) as Extract<
    P2TRSignatureFraudChallengeOutboxResolution,
    {
      status:
        | "accepted-own"
        | "satisfied-external"
        | "external-satisfied-awaiting-own-transaction"
    }
  >
}

type SignatureFraudVector = {
  id: string
  walletIDHex: string
  unsignedTransactionHex: string
  signedInputIndex: number
  witnessSignatureHex: string
  prevouts: Array<{
    txidHex: string
    vout: number
    valueSats: number
    scriptPubKeyHex: string
  }>
}

const canonicalEligibilitySnapshot =
  (): P2TRSignatureFraudChallengeOutboxEligibilitySnapshot => {
    const vectors = JSON.parse(
      readFileSync(
        new URL(
          "../../../docs/test-vectors/p2tr-signature-fraud-v0.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { cases: SignatureFraudVector[] }
    const vector = vectors.cases.find(
      ({ id }) => id === "bip341-keypath-sighash-default-single-input"
    )!
    const transaction = Transaction.fromHex(vector.unsignedTransactionHex)
    transaction.ins[vector.signedInputIndex].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
    ]
    const inputPrevouts = vector.prevouts.map((prevout) => ({
      txid: prevout.txidHex,
      vout: prevout.vout,
      valueSats: prevout.valueSats,
      scriptPubKey: prevout.scriptPubKeyHex,
    }))
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      { transactionHex: transaction.toHex() },
      inputPrevouts,
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      { chainID: 11155111, bridgeAddress: BRIDGE_ADDRESS },
      []
    )
    assert.ok(observation)
    const completeIntent = buildP2TRSignatureFraudSubmissionIntent(
      buildP2TRCompleteV2SignatureFraudChallengeEvidence(
        observation,
        {
          chainID: 11155111,
          bridgeAddress: BRIDGE_ADDRESS,
        },
        {
          registeredWalletIDs: [vector.walletIDHex],
          walletInputKeyBindings: [],
        }
      ),
      {
        domainChainID: 11155111,
        chainID: 11155111,
        bridgeAddress: BRIDGE_ADDRESS,
        routerAddress: ROUTER_ADDRESS,
        challengeDepositAmount: 1234,
      }
    )
    const txid = `0x${transaction.getId()}`
    const wtxid = `0x${Buffer.from(transaction.getHash(true))
      .reverse()
      .toString("hex")}`
    const blockHash = `0x${"42".repeat(32)}`
    const lifecycleHash = `0x${"43".repeat(32)}`
    const challengeRecord = {
      observationID: observation.observationID,
      // Deliberately absent: enqueue derives from the candidate row instead.
      observation: undefined,
      status: "observed",
      submissionAttempts: 0,
      bitcoinStatus: "confirmed",
      bitcoinTxHash: Hex.from(txid),
      bitcoinWtxid: Hex.from(wtxid),
      bitcoinBlockHash: Hex.from(blockHash),
      bitcoinBlockHeight: 100,
    } as P2TRWatchtowerChallengeRecord

    const candidate = {
      txid,
      wtxid,
      blockHash,
      blockHeight: 100,
      inputIndex: vector.signedInputIndex,
    }
    const checkpoint: P2TRSignatureFraudOutboxEvidenceCheckpoint = {
      confirmedSourceComplete: true,
      bitcoinTxHash: txid,
      bitcoinWitnessTxHash: wtxid,
      bitcoinInputIndex: vector.signedInputIndex,
      bitcoinBlockHash: blockHash,
      bitcoinBlockHeight: 100,
      bitcoinCursorBlockHash: `0x${"44".repeat(32)}`,
      bitcoinCursorBlockHeight: 120,
      ethereumLifecycleBlockHash: lifecycleHash,
      ethereumLifecycleBlockNumber: 500,
      activationManifest: activationManifest(),
      submittedEventScanFromBlock: 50,
    }

    return {
      challengeRecord,
      canonicalObservation: observation,
      canonicalCandidate: candidate,
      canonicalCandidateDelivered: true,
      canonicalCandidateCurrentAtCursor: true,
      evidenceCheckpoint: checkpoint,
      canonicalProvenance: canonicalProvenance(
        candidate,
        observation.observationID,
        checkpoint,
        completeIntent.bridgeChallengeKey,
        "71",
        {
          kind: "registered-wallet-output",
          sourceEventID: `0x${"73".repeat(32)}`,
          inputIndex: vector.signedInputIndex,
          fundingBlockHash: `0x${"74".repeat(32)}`,
          fundingTxid:
            observation.inputPrevouts[vector.signedInputIndex].txid instanceof
            Hex
              ? (
                  observation.inputPrevouts[vector.signedInputIndex].txid as Hex
                ).toPrefixedString()
              : Hex.from(
                  observation.inputPrevouts[vector.signedInputIndex].txid as
                    | string
                    | Buffer
                ).toPrefixedString(),
          fundingVout: observation.inputPrevouts[vector.signedInputIndex].vout,
          walletID: vector.walletIDHex,
          outputKey: vector.walletIDHex,
          ethereumBlockNumber: 499,
          ethereumBlockHash: `0x${"75".repeat(32)}`,
        }
      ),
      canonicalEthereumEligibility: ethereumEligibility(
        {
          chainID: 11155111,
          routerAddress: ROUTER_ADDRESS,
          bridgeAddress: BRIDGE_ADDRESS,
          bridgeChallengeKey: completeIntent.bridgeChallengeKey,
          bridgeChallengeIdentity: completeIntent.bridgeChallengeIdentity,
          walletID: completeIntent.walletID,
        },
        500,
        lifecycleHash
      ),
      legacySubmissionQuarantined: false,
      canonicalRegisteredWalletID: vector.walletIDHex,
      canonicalWalletInputAuthorization: {
        kind: "registered-wallet-output",
        inputIndex: vector.signedInputIndex,
        fundingBlockHash: `0x${"74".repeat(32)}`,
        fundingTxid:
          observation.inputPrevouts[vector.signedInputIndex].txid instanceof Hex
            ? (
                observation.inputPrevouts[vector.signedInputIndex].txid as Hex
              ).toPrefixedString()
            : Hex.from(
                observation.inputPrevouts[vector.signedInputIndex].txid as
                  | string
                  | Buffer
              ).toPrefixedString(),
        fundingVout: observation.inputPrevouts[vector.signedInputIndex].vout,
        walletID: vector.walletIDHex,
        outputKey: vector.walletIDHex,
        sourceEventID: `0x${"73".repeat(32)}`,
        ethereumBlockNumber: 499,
        ethereumBlockHash: `0x${"75".repeat(32)}`,
      },
    }
  }

const scheduler = (
  store: InMemoryOutboxStore,
  challengeDepositAmount = 1234,
  manifestHash = ACTIVATION_MANIFEST_HASH
) =>
  new P2TRSignatureFraudChallengeOutboxScheduler(store, {
    submissionIntent: {
      domainChainID: 11155111,
      chainID: 11155111,
      bridgeAddress: BRIDGE_ADDRESS,
      routerAddress: ROUTER_ADDRESS,
      challengeDepositAmount,
    },
    activationManifest: activationManifest(manifestHash),
    feePolicyManifest: feePolicyManifest(
      manifestHash,
      challengeDepositAmount.toString()
    ),
    observationValidation: {
      bridgeChallengeDomain: {
        chainID: 11155111,
        bridgeAddress: BRIDGE_ADDRESS,
      },
    },
  })

test("keeps the live envelope chain separate from the immutable Router domain", () => {
  const store = new InMemoryOutboxStore()
  assert.doesNotThrow(
    () =>
      new P2TRSignatureFraudChallengeOutboxScheduler(store, {
        submissionIntent: {
          domainChainID: 1,
          chainID: 11155111,
          bridgeAddress: BRIDGE_ADDRESS,
          routerAddress: ROUTER_ADDRESS,
          challengeDepositAmount: 1234,
        },
        activationManifest: {
          ...activationManifest(),
          routerDomainChainID: 1,
        },
        feePolicyManifest: feePolicyManifest(),
        observationValidation: {
          bridgeChallengeDomain: {
            chainID: 1,
            bridgeAddress: BRIDGE_ADDRESS,
          },
        },
      })
  )
})

test("derives enqueue intent only from the locked canonical witness candidate", async () => {
  const store = new InMemoryOutboxStore()
  store.eligibilitySnapshot = canonicalEligibilitySnapshot()
  const observationID = store.eligibilitySnapshot.challengeRecord.observationID
  const first = await scheduler(store).enqueueConfirmedChallengeRecord(
    observationID,
    1_000
  )
  const second = await scheduler(store).enqueueConfirmedChallengeRecord(
    observationID,
    1_001
  )

  assert.equal(first.status, "queued")
  assert.equal(first.intent.observationID.toString(), observationID.toString())
  assert.equal(first.evidenceCheckpoint.bitcoinWitnessTxHash.length, 66)
  assert.equal(
    second.intent.intentID.toString(),
    first.intent.intentID.toString()
  )
  assert.equal(store.records.size, 1)
  assert.equal((first.intent.calldata.length - 2) / 2, 388)
  assert.equal(first.canonicalProvenance.eventCount, 1)
  assert.match(first.canonicalProvenance.eventSetHash, /^0x[0-9a-f]{64}$/)
  const durableState = JSON.stringify(first)
  for (const rawField of [
    "canonicalObservation",
    "rawTransactionHex",
    "unsignedTransaction",
    "inputPrevouts",
    "scriptPubKey",
  ]) {
    assert.equal(durableState.includes(`\"${rawField}\"`), false)
  }

  const checks: Array<{
    mutate(snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot): void
    message: RegExp
  }> = [
    {
      mutate: (snapshot) => {
        snapshot.canonicalRegisteredWalletID = `0x${"99".repeat(32)}`
      },
      message: /not authorized by the registry index/,
    },
    {
      mutate: (snapshot) => {
        snapshot.evidenceCheckpoint.bitcoinWitnessTxHash = `0x${"98".repeat(
          32
        )}`
      },
      message: /exact canonical witness candidate/,
    },
    {
      mutate: (snapshot) => {
        snapshot.legacySubmissionQuarantined = true
      },
      message: /blocked by legacy submission quarantine/,
    },
    {
      mutate: (snapshot) => {
        snapshot.canonicalEthereumEligibility.routerBridgeAddress =
          "0x9999999999999999999999999999999999999999"
      },
      message: /activation manifest and exact challenge identity/,
    },
    {
      mutate: (snapshot) => {
        ;(
          snapshot.canonicalEthereumEligibility as unknown as {
            canonicalProofBacklogComplete: boolean
          }
        ).canonicalProofBacklogComplete = false
      },
      message: /prove exact challenge and transaction authorization absence/,
    },
  ]
  for (const check of checks) {
    const invalidStore = new InMemoryOutboxStore()
    invalidStore.eligibilitySnapshot = canonicalEligibilitySnapshot()
    check.mutate(invalidStore.eligibilitySnapshot)
    await assert.rejects(
      scheduler(invalidStore).enqueueConfirmedChallengeRecord(observationID),
      check.message
    )
  }
})

test("restores a provenance-invalidated series after challenge deposit rotation", async () => {
  const store = new InMemoryOutboxStore()
  store.eligibilitySnapshot = canonicalEligibilitySnapshot()
  const observationID = store.eligibilitySnapshot.challengeRecord.observationID
  const first = await scheduler(store).enqueueConfirmedChallengeRecord(
    observationID,
    1_000
  )
  await invalidateP2TRSignatureFraudCanonicalProvenance(
    store,
    provenanceInvalidationEvidence(first)
  )

  const rotatedManifestHash = `0x${"93".repeat(32)}`
  const rotatedBlockHash = `0x${"94".repeat(32)}`
  const snapshot = store.eligibilitySnapshot
  snapshot.evidenceCheckpoint = {
    ...snapshot.evidenceCheckpoint,
    ethereumLifecycleBlockNumber: 501,
    ethereumLifecycleBlockHash: rotatedBlockHash,
    activationManifest: activationManifest(rotatedManifestHash),
  }
  snapshot.canonicalEthereumEligibility = ethereumEligibility(
    {
      chainID: 11155111,
      routerAddress: ROUTER_ADDRESS,
      bridgeAddress: BRIDGE_ADDRESS,
      bridgeChallengeKey: first.intent.bridgeChallengeKey,
      bridgeChallengeIdentity: first.intent.bridgeChallengeIdentity,
      walletID: first.intent.walletID,
    },
    501,
    rotatedBlockHash,
    undefined,
    "1235",
    rotatedManifestHash
  )
  snapshot.canonicalProvenance = refingerprintProvenance(
    snapshot.canonicalProvenance,
    {
      throughBlockNumber: 501,
      throughBlockHash: rotatedBlockHash,
      historyRoot: `0x${"95".repeat(32)}`,
      readinessCertificateID: `0x${"96".repeat(32)}`,
      readinessCertificateGeneration: 2,
      candidateProvenanceGeneration: 2,
      manifestHash: rotatedManifestHash,
    }
  )

  const restored = await scheduler(
    store,
    1235,
    rotatedManifestHash
  ).enqueueConfirmedChallengeRecord(observationID, 3_000)

  assert.equal(restored.generation, 1)
  assert.equal(restored.generationTrigger.kind, "provenance-restored")
  assert.equal(restored.seriesID, first.seriesID)
  assert.notEqual(
    restored.intent.intentID.toString(),
    first.intent.intentID.toString()
  )
  assert.equal(restored.intent.value, "1235")
})

test("restores a reorg-cancelled series after manifest-bound policy rotation", async () => {
  const store = new InMemoryOutboxStore()
  store.eligibilitySnapshot = canonicalEligibilitySnapshot()
  const observationID = store.eligibilitySnapshot.challengeRecord.observationID
  const first = await scheduler(store).enqueueConfirmedChallengeRecord(
    observationID,
    1_000
  )
  const rechecker = new FixedRechecker()
  rechecker.resolution = {
    status: "cancelled-reorg",
    reason: "candidate left the canonical chain",
    evidence: cancellationEvidence(first, "canonical-reorg"),
  }
  const cancelled = await dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    rechecker
  ).prepare(first.recordID, "worker-reorg")
  assert.equal(cancelled.status, "cancelled-reorg")

  const rotatedManifestHash = `0x${"97".repeat(32)}`
  const rotatedEthereumBlockHash = `0x${"98".repeat(32)}`
  const reappearedBlockHash = `0x${"99".repeat(32)}`
  const snapshot = store.eligibilitySnapshot
  const reappearedCandidate = {
    ...snapshot.canonicalCandidate,
    blockHash: reappearedBlockHash,
    blockHeight: snapshot.canonicalCandidate.blockHeight + 1,
  }
  snapshot.challengeRecord = {
    ...snapshot.challengeRecord,
    bitcoinBlockHash: Hex.from(reappearedBlockHash),
    bitcoinBlockHeight: reappearedCandidate.blockHeight,
  }
  snapshot.canonicalCandidate = reappearedCandidate
  snapshot.evidenceCheckpoint = {
    ...snapshot.evidenceCheckpoint,
    bitcoinBlockHash: reappearedBlockHash,
    bitcoinBlockHeight: reappearedCandidate.blockHeight,
    bitcoinCursorBlockHash: `0x${"9a".repeat(32)}`,
    bitcoinCursorBlockHeight:
      snapshot.evidenceCheckpoint.bitcoinCursorBlockHeight + 1,
    ethereumLifecycleBlockNumber: 501,
    ethereumLifecycleBlockHash: rotatedEthereumBlockHash,
    activationManifest: activationManifest(rotatedManifestHash),
  }
  snapshot.canonicalEthereumEligibility = ethereumEligibility(
    {
      chainID: 11155111,
      routerAddress: ROUTER_ADDRESS,
      bridgeAddress: BRIDGE_ADDRESS,
      bridgeChallengeKey: first.intent.bridgeChallengeKey,
      bridgeChallengeIdentity: first.intent.bridgeChallengeIdentity,
      walletID: first.intent.walletID,
    },
    501,
    rotatedEthereumBlockHash,
    undefined,
    "1235",
    rotatedManifestHash
  )
  snapshot.canonicalProvenance = refingerprintProvenance(
    snapshot.canonicalProvenance,
    {
      throughBlockNumber: 501,
      throughBlockHash: rotatedEthereumBlockHash,
      historyRoot: `0x${"9b".repeat(32)}`,
      candidateDigest: computeP2TRSignatureFraudCanonicalCandidateDigest(
        reappearedCandidate,
        observationID
      ),
      readinessCertificateID: `0x${"9c".repeat(32)}`,
      readinessCertificateGeneration: 2,
      candidateProvenanceGeneration: 2,
      manifestHash: rotatedManifestHash,
    }
  )

  const restored = await scheduler(
    store,
    1235,
    rotatedManifestHash
  ).enqueueConfirmedChallengeRecord(observationID, 3_000)

  assert.equal(restored.generation, 1)
  assert.equal(restored.generationTrigger.kind, "canonical-reappearance")
  assert.equal(restored.seriesID, first.seriesID)
  assert.notEqual(
    restored.intent.intentID.toString(),
    first.intent.intentID.toString()
  )
  assert.equal(restored.intent.value, "1235")
  assert.notEqual(
    restored.feePolicyManifest.policyHash,
    first.feePolicyManifest.policyHash
  )
})

test("commits the generation-cap alert before rejecting enqueue", async () => {
  const store = new RollbackAwareInMemoryOutboxStore()
  store.eligibilitySnapshot = canonicalEligibilitySnapshot()
  const observationID = store.eligibilitySnapshot.challengeRecord.observationID
  const first = await scheduler(store).enqueueConfirmedChallengeRecord(
    observationID,
    1_000
  )
  const disposition = withCanonicalAttestations({
    status: "terminal-reverted",
    observedHead: {
      blockNumber: 500,
      blockHash: ETHEREUM_CURSOR_HASH,
    },
    finalizedThrough: {
      blockNumber: 500,
      blockHash: ETHEREUM_CURSOR_HASH,
    },
    consensusFinalized: true,
    receipt: {
      transactionHash: TRANSACTION_HASH,
      status: 0,
      blockNumber: 499,
      blockHash: `0x${"91".repeat(32)}`,
    },
    routerChallenge: {
      exists: false,
      challengeKey: first.intent.bridgeChallengeKey.toPrefixedString(),
      readAtBlock: 500,
    },
  } as Parameters<typeof withCanonicalAttestations>[0])
  const capped: P2TRSignatureFraudChallengeOutboxRecord = {
    ...first,
    status: "generation-required",
    generation: 31,
    generationDisposition: disposition,
    canonicalEthereumEligibility: {
      ...first.canonicalEthereumEligibility,
      readSetHash: `0x${"92".repeat(32)}`,
    },
  }
  store.records.set(normalizeKey(first.recordID), capped)

  const outcome = await scheduler(store).enqueueConfirmedChallenge(
    observationID,
    2_000
  )
  assert.equal(outcome.kind, "generation-cap-exhausted")
  if (outcome.kind !== "generation-cap-exhausted") {
    assert.fail("expected the capped scheduler outcome")
  }
  assert.equal(outcome.outboxIntentID, capped.recordID)
  assert.equal(store.criticalAlerts.length, 1)
  assert.equal(store.criticalAlerts[0].code, "generation-cap-exhausted")
})

test("carries the real scheduler generation-cap outcome through the activation gate commit", async () => {
  const store = new RollbackAwareInMemoryOutboxStore()
  store.eligibilitySnapshot = canonicalEligibilitySnapshot()
  const observationID = store.eligibilitySnapshot.challengeRecord.observationID
  const challengeScheduler = scheduler(store)
  const first = await challengeScheduler.enqueueConfirmedChallengeRecord(
    observationID,
    1_000
  )
  const disposition = withCanonicalAttestations({
    status: "terminal-reverted",
    observedHead: { blockNumber: 500, blockHash: ETHEREUM_CURSOR_HASH },
    finalizedThrough: { blockNumber: 500, blockHash: ETHEREUM_CURSOR_HASH },
    consensusFinalized: true,
    receipt: {
      transactionHash: TRANSACTION_HASH,
      status: 0,
      blockNumber: 499,
      blockHash: `0x${"91".repeat(32)}`,
    },
    routerChallenge: {
      exists: false,
      challengeKey: first.intent.bridgeChallengeKey.toPrefixedString(),
      readAtBlock: 500,
    },
  } as Parameters<typeof withCanonicalAttestations>[0])
  const capped: P2TRSignatureFraudChallengeOutboxRecord = {
    ...first,
    status: "generation-required",
    generation: 31,
    generationDisposition: disposition,
    canonicalEthereumEligibility: {
      ...first.canonicalEthereumEligibility,
      readSetHash: `0x${"92".repeat(32)}`,
    },
  }
  store.records.set(normalizeKey(first.recordID), capped)

  let active = false
  let commits = 0
  const coordinator = {
    p2trSignatureFraudWatchtowerTransactionalStoreID: "scheduler-gate-test",
    async runInP2TRSignatureFraudWatchtowerTransaction<T>(
      operation: () => Promise<T>
    ): Promise<T> {
      if (active) return operation()
      active = true
      try {
        const result = await operation()
        commits++
        return result
      } finally {
        active = false
      }
    },
    assertP2TRSignatureFraudWatchtowerTransactionalParticipants() {},
    readP2TRSignatureFraudWatchtowerRetryableTransactionSQLState() {
      return undefined
    },
    isP2TRSignatureFraudWatchtowerTransactionActive() {
      return active
    },
  }
  const resolutions: Array<{ outboxIntentID: string; outcomeKind: string }> = []
  const consumed: string[] = []
  const stateStore = {
    p2trSignatureFraudWatchtowerTransactionalStoreID: "scheduler-gate-test",
    async armCandidateEnqueueTransactionGuard() {},
    async lockCandidateAuthorization() {},
    async assertCandidateIndexed() {},
    async consumeCandidateAuthorization(
      _tokenID: string,
      outboxIntentID: string
    ) {
      consumed.push(outboxIntentID)
    },
    async resolveCandidateEnqueueTransactionGuard(resolution: {
      outboxIntentID: string
      outcomeKind: string
    }) {
      resolutions.push(resolution)
    },
  }
  const candidateEnqueuer = {
    p2trSignatureFraudWatchtowerTransactionalStoreID: "scheduler-gate-test",
    async enqueueReconciledCandidate() {
      return challengeScheduler.enqueueConfirmedChallenge(
        observationID,
        2_000
      )
    },
  }
  const snapshot = store.eligibilitySnapshot
  const candidate = {
    txid: snapshot.canonicalCandidate.txid.replace(/^0x/, ""),
    wtxid: snapshot.canonicalCandidate.wtxid.replace(/^0x/, ""),
    blockHash: snapshot.canonicalCandidate.blockHash.replace(/^0x/, ""),
    blockHeight: snapshot.canonicalCandidate.blockHeight,
    inputIndex: snapshot.canonicalCandidate.inputIndex,
    observationID: normalizeKey(observationID),
    challengeKey: snapshot.canonicalProvenance.challengeKey,
  }
  const canonicalJSON = (value: unknown): string => {
    if (value === null || typeof value !== "object")
      return JSON.stringify(value)
    if (Array.isArray(value)) {
      return `[${value.map(canonicalJSON).join(",")}]`
    }
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
      .join(",")}}`
  }
  const candidateDigest = `0x${createHash("sha256")
    .update(canonicalJSON(candidate))
    .digest("hex")}`
  const token = Object.freeze(
    {}
  ) as unknown as P2TRProductionCandidateAuthorizationToken
  const receipt = {
    tokenID: `0x${"11".repeat(32)}`,
    manifestHash: ACTIVATION_MANIFEST_HASH,
    candidateDigest,
    candidate,
    readinessCertificate: {
      certificateID: `0x${"12".repeat(32)}`,
      generation: 1,
    },
    verifiedBitcoin: {
      height: candidate.blockHeight,
      hash: candidate.blockHash,
    },
    verifiedEthereum: {
      blockNumber: 500,
      blockHash: ETHEREUM_CURSOR_HASH,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const gate = Object.create(
    P2TRProductionActivationGate.prototype
  ) as P2TRProductionActivationGate
  Object.assign(gate, {
    dependencies: {
      stateStore,
      candidateEnqueuer,
      transactionCoordinator: coordinator,
    } as unknown as P2TRProductionActivationDependencies,
    candidateTokens: new WeakMap([[token, { receipt, consumed: false }]]),
    candidateEnqueueTransactionMaxAttempts: 3,
  })

  await assert.rejects(
    gate.consumeCandidateAuthorization(token, candidate),
    (error: unknown) => {
      assert.ok(error instanceof P2TRProductionCandidateEnqueueRejectedError)
      assert.equal(error.outboxIntentID, capped.recordID)
      return true
    }
  )
  assert.equal(commits, 2)
  assert.deepEqual(consumed, [capped.recordID])
  assert.equal(resolutions.length, 1)
  assert.equal(resolutions[0].outboxIntentID, capped.recordID)
  assert.equal(resolutions[0].outcomeKind, "generation-cap-exhausted")
  assert.equal(store.criticalAlerts[0].recordID, capped.recordID)
})

test("does not let an unrelated active COMPLETE reservation suppress fraud", async () => {
  const store = new InMemoryOutboxStore()
  const snapshot = canonicalEligibilitySnapshot()
  snapshot.canonicalEthereumEligibility = ethereumEligibility(
    {
      chainID: 11155111,
      routerAddress: ROUTER_ADDRESS,
      bridgeAddress: BRIDGE_ADDRESS,
      bridgeChallengeKey: snapshot.canonicalProvenance.challengeKey,
      bridgeChallengeIdentity: snapshot.canonicalProvenance.challengeKey,
      walletID: snapshot.canonicalObservation.walletID,
    },
    snapshot.evidenceCheckpoint.ethereumLifecycleBlockNumber,
    snapshot.evidenceCheckpoint.ethereumLifecycleBlockHash,
    `0x${"76".repeat(32)}`
  )
  store.eligibilitySnapshot = snapshot

  const result = await scheduler(store).enqueueConfirmedChallengeRecord(
    snapshot.challengeRecord.observationID,
    1_000
  )

  assert.equal(result.status, "queued")
  assert.equal(
    result.canonicalEthereumEligibility.completeWalletReservationActive,
    true
  )
})

test("rejects a wrong per-input observation or funding binding under the same transaction occurrence", async () => {
  const mutations: Array<
    (snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot) => void
  > = [
    (snapshot) => {
      snapshot.canonicalProvenance = refingerprintProvenance(
        snapshot.canonicalProvenance,
        {
          candidateDigest: computeP2TRSignatureFraudCanonicalCandidateDigest(
            snapshot.canonicalCandidate,
            `0x${"79".repeat(32)}`
          ),
        }
      )
    },
    (snapshot) => {
      snapshot.canonicalProvenance = refingerprintProvenance(
        snapshot.canonicalProvenance,
        { fundingTxid: `0x${"7a".repeat(32)}` }
      )
    },
    (snapshot) => {
      snapshot.canonicalProvenance = refingerprintProvenance(
        snapshot.canonicalProvenance,
        { fundingBlockHash: `0x${"7c".repeat(32)}` }
      )
    },
    (snapshot) => {
      snapshot.canonicalProvenance = refingerprintProvenance(
        snapshot.canonicalProvenance,
        { inputIndex: snapshot.canonicalCandidate.inputIndex + 1 }
      )
    },
    (snapshot) => {
      snapshot.canonicalProvenance = refingerprintProvenance(
        snapshot.canonicalProvenance,
        { bindingEthereumBlockHash: `0x${"7d".repeat(32)}` }
      )
    },
    (snapshot) => {
      snapshot.canonicalProvenance = refingerprintProvenance(
        snapshot.canonicalProvenance,
        {
          bindingEthereumBlockNumber:
            snapshot.canonicalProvenance.bindingEthereumBlockNumber - 1,
        }
      )
    },
    (snapshot) => {
      snapshot.canonicalProvenance = refingerprintProvenance(
        snapshot.canonicalProvenance,
        { inputOutputKey: `0x${"7b".repeat(32)}` }
      )
    },
  ]

  for (const mutate of mutations) {
    const store = new InMemoryOutboxStore()
    const snapshot = canonicalEligibilitySnapshot()
    mutate(snapshot)
    store.eligibilitySnapshot = snapshot
    await assert.rejects(
      scheduler(store).enqueueConfirmedChallengeRecord(
        snapshot.challengeRecord.observationID
      ),
      /Canonical provenance does not authenticate/
    )
  }
})

test("requires independent bounded submission, recheck, and reconciliation domains", () => {
  const store = new InMemoryOutboxStore()
  const preparer = new FixedPreparer()
  const broadcaster = new RecordingBroadcaster()
  const rechecker = new FixedRechecker()
  const reconciler = new FixedReconciler()
  Object.defineProperty(rechecker, "providerIdentity", {
    value: broadcaster.providerIdentity,
  })
  assert.throws(
    () => dispatcher(store, preparer, broadcaster, rechecker, reconciler),
    /independent provider, trust, and infrastructure domains/
  )

  const longDomainRechecker = new FixedRechecker()
  Object.defineProperty(longDomainRechecker, "recheckTrustDomainID", {
    value: "x".repeat(129),
  })
  assert.throws(
    () =>
      dispatcher(store, preparer, broadcaster, longDomainRechecker, reconciler),
    /exceeds 128 characters/
  )

  const shallowFinalityReconciler = new FixedReconciler()
  Object.defineProperty(
    shallowFinalityReconciler,
    "finalityConfirmationBlocks",
    {
      value: 11,
    }
  )
  assert.throws(
    () =>
      dispatcher(
        store,
        preparer,
        broadcaster,
        new FixedRechecker(),
        shallowFinalityReconciler
      ),
    /finality confirmation depth must be at least 12 blocks/
  )
})

test("refuses to construct without an irreversible-boundary authorizer", () => {
  const store = new InMemoryOutboxStore()
  assert.throws(
    () =>
      new P2TRSignatureFraudChallengeOutboxDispatcher(
        store,
        new FixedPreparer(),
        new RecordingBroadcaster(),
        new FixedRechecker(),
        new FixedCancellationVerifier(),
        new FixedReconciler(),
        new FixedCanonicalResolutionVerifier(),
        {} as never
      ),
    /requires an irreversible-boundary authorizer/
  )
})

test("authorizes exact post-CAS signer, replacement, and broadcast boundaries", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const broadcaster = new RecordingBroadcaster()
  const authorizer = new FixedBoundaryAuthorizer()
  const consumedStages: string[] = []
  authorizer.beforeAuthorize = async (binding) => {
    const durable = await store.get(binding.recordID)
    assert.ok(durable)
    assert.equal(durable.version, binding.recordVersion)
    assert.equal(durable.generation, binding.generation)
    assert.equal(
      durable.reservedNonce === undefined
        ? undefined
        : normalizeKey(durable.reservedNonce.reservationID),
      binding.reservationID
    )
    assert.equal(durable.reservedNonce?.nonce, binding.transactionNonce)
    assert.equal(
      durable.reservedNonce === undefined
        ? undefined
        : normalizeKey(durable.reservedNonce.sender),
      binding.sender
    )
    assert.equal(
      durable.canonicalProvenance.provenanceFingerprint.toLowerCase(),
      binding.provenanceFingerprint
    )
    assert.equal(
      durable.feePolicyManifest.activationManifestHash.toLowerCase(),
      binding.activationManifestHash
    )
    if (binding.stage === "broadcast") {
      assert.equal(durable.status, "broadcast-pending")
      assert.equal(durable.broadcastAttempts, binding.attempt)
      assert.equal(
        durable.preparedTransaction === undefined
          ? undefined
          : normalizeKey(durable.preparedTransaction.transactionHash),
        binding.preparedTransactionHash
      )
    } else {
      assert.equal(durable.status, "preparing")
      assert.equal(
        durable.activeSignerInvocationStartedAtUnixMs !== undefined,
        true
      )
      assert.equal(durable.preparationAttempts, binding.attempt)
      assert.equal(binding.preparedTransactionHash, undefined)
    }
  }
  authorizer.onConsume = (binding) => consumedStages.push(binding.stage)
  preparer.afterInitialSign = async () => {
    assert.deepEqual(consumedStages, ["prepare"])
  }
  preparer.afterReplacementSign = async () => {
    assert.deepEqual(consumedStages, ["prepare", "replacement"])
  }
  broadcaster.inspectDurableBoundary = async () => {
    assert.deepEqual(consumedStages, ["prepare", "replacement", "broadcast"])
  }
  const outbox = dispatcher(
    store,
    preparer,
    broadcaster,
    new FixedRechecker(),
    new FixedReconciler(),
    () => 2_000,
    100,
    undefined,
    authorizer
  )

  assert.equal(
    (await outbox.prepare(record.recordID, "worker-a")).status,
    "prepared",
    (await store.get(record.recordID))?.lastError
  )
  assert.equal(
    (await outbox.prepareReplacement(record.recordID, "worker-b")).status,
    "prepared"
  )
  assert.equal(
    (await outbox.broadcast(record.recordID)).status,
    "broadcast-pending"
  )

  assert.deepEqual(
    authorizer.bindings.map(
      ({ stage, attempt, signingRequestDigest, preparedTransactionHash }) => ({
        stage,
        attempt,
        hasSigningRequestDigest: signingRequestDigest !== undefined,
        preparedTransactionHash,
      })
    ),
    [
      {
        stage: "prepare",
        attempt: 1,
        hasSigningRequestDigest: true,
        preparedTransactionHash: undefined,
      },
      {
        stage: "replacement",
        attempt: 2,
        hasSigningRequestDigest: true,
        preparedTransactionHash: undefined,
      },
      {
        stage: "broadcast",
        attempt: 1,
        hasSigningRequestDigest: false,
        preparedTransactionHash: REPLACEMENT_TRANSACTION_HASH.toLowerCase(),
      },
    ]
  )
  assert.notEqual(
    authorizer.bindings[0].signingRequestDigest,
    authorizer.bindings[1].signingRequestDigest
  )

  const durable = await store.get(record.recordID)
  assert.ok(durable?.reservedNonce)
  const lane = durable.feePolicyManifest.lanes[0]
  const selectedFeePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy = {
    policyHash: Hex.from(durable.feePolicyManifest.policyHash),
    activationManifestHash: Hex.from(
      durable.feePolicyManifest.activationManifestHash
    ),
    chainID: durable.feePolicyManifest.chainID,
    challengeValueWei: durable.feePolicyManifest.challengeValueWei,
    ...lane,
  }
  const initialRequestDigest = computeP2TRSignatureFraudSigningRequestDigest(
    "prepare",
    durable.intent,
    durable.reservedNonce,
    selectedFeePolicy,
    Hex.from(preparer.initialInvocationIDs[0])
  )
  const replacementRequestDigest =
    computeP2TRSignatureFraudSigningRequestDigest(
      "replacement",
      durable.intent,
      durable.reservedNonce,
      selectedFeePolicy,
      Hex.from(preparer.replacementInvocationIDs[0]),
      Hex.from(TRANSACTION_HASH)
    )
  assert.equal(
    normalizeKey(initialRequestDigest),
    authorizer.bindings[0].signingRequestDigest
  )
  assert.equal(
    normalizeKey(replacementRequestDigest),
    authorizer.bindings[1].signingRequestDigest
  )
  assert.notEqual(
    normalizeKey(
      computeP2TRSignatureFraudSigningRequestDigest(
        "prepare",
        durable.intent,
        durable.reservedNonce,
        {
          ...selectedFeePolicy,
          maxFeePerGas: String(Number(selectedFeePolicy.maxFeePerGas) + 1),
        },
        Hex.from(preparer.initialInvocationIDs[0])
      )
    ),
    authorizer.bindings[0].signingRequestDigest
  )
  assert.throws(
    () =>
      computeP2TRSignatureFraudSigningRequestDigest(
        "prepare",
        { ...durable.intent, value: String(Number(durable.intent.value) + 1) },
        durable.reservedNonce!,
        selectedFeePolicy,
        Hex.from(preparer.initialInvocationIDs[0])
      ),
    /intent ID does not match its exact call/
  )
})

test("recovers an initial reservation when authorization rejects before signer I/O", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  authorizer.rejectAuthorization = new Error("independent proof is stale")
  let now = 2_000
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now,
    100,
    undefined,
    authorizer
  )

  const rejected = await outbox.prepare(record.recordID, "worker-a")
  assert.equal(rejected.status, "preparing")
  assert.equal(rejected.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(rejected.signerInvocationStartedAtUnixMs, undefined)
  assert.ok(rejected.reservedNonce)
  assert.equal(preparer.calls, 0)

  now = 40_001
  await outbox.recoverExpiredPreparationLeases()
  const recovered = await store.get(record.recordID)
  assert.equal(recovered?.status, "queued")
  assert.equal(recovered?.reservedNonce, undefined)
  assert.equal(preparer.releasedReservations.length, 1)
})

test("recovers an invalidated initial authorization without inventing signer I/O", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  let now = 2_000
  authorizer.beforeAuthorize = async () => {
    await invalidateP2TRSignatureFraudCanonicalProvenance(
      store,
      provenanceInvalidationEvidence(record, now)
    )
  }
  authorizer.rejectAuthorization = new Error("canonical proof was superseded")
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now,
    100,
    undefined,
    authorizer
  )

  const rejected = await outbox.prepare(record.recordID, "worker-a")
  assert.equal(rejected.status, "preparing")
  assert.equal(rejected.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(rejected.signerInvocationStartedAtUnixMs, undefined)
  assert.equal(preparer.calls, 0)
  assert.equal(
    store.criticalAlerts.some(
      ({ code }) => code === "provenance-reconciliation-incident"
    ),
    false
  )

  now = 40_001
  await outbox.recoverExpiredPreparationLeases()
  const recovered = await store.get(record.recordID)
  assert.equal(recovered?.status, "cancelled-provenance-invalidated")
  assert.equal(recovered?.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(recovered?.signerInvocationStartedAtUnixMs, undefined)
  assert.equal(recovered?.reservedNonce, undefined)
  assert.equal(preparer.releasedReservations.length, 1)
})

test("keeps prior signed state in reconciliation when replacement authorization loses to invalidation", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => 2_000,
    100,
    undefined,
    authorizer
  )
  const prepared = await outbox.prepare(record.recordID, "worker-a")
  assert.equal(prepared.status, "prepared")
  authorizer.beforeAuthorize = async (binding) => {
    if (binding.stage !== "replacement") return
    await invalidateP2TRSignatureFraudCanonicalProvenance(
      store,
      provenanceInvalidationEvidence(record)
    )
  }
  authorizer.rejectAuthorization = new Error("replacement proof is stale")

  const rejected = await outbox.prepareReplacement(record.recordID, "worker-b")

  assert.equal(
    rejected.status,
    "provenance-invalidated-awaiting-reconciliation"
  )
  assert.equal(rejected.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(rejected.preparationLease, undefined)
  assert.equal(rejected.preparationResumeStatus, undefined)
  assert.equal(rejected.preparedTransactionVariants?.length, 1)
  assert.equal(preparer.replacementCalls, 0)
})

test("reserves one durable sender lane before signing", async () => {
  const store = new InMemoryOutboxStore()
  const first = await enqueue(store, createIntent("aa"))
  const second = await enqueue(store, createIntent("ab"))
  const preparer = new FixedPreparer()
  const outbox = dispatcher(store, preparer)

  const results = await Promise.all([
    outbox.prepare(first.recordID, "worker-a"),
    outbox.prepare(second.recordID, "worker-b"),
  ])

  assert.equal(preparer.calls, 1)
  assert.equal(results.filter(({ status }) => status === "prepared").length, 1)
  assert.equal(results.filter(({ status }) => status === "queued").length, 1)
})

test("blocks a signer claim when canonical provenance invalidation wins the shared lock", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  let invalidated = false
  store.beforeProvenanceCAS = async (_current, next) => {
    if (!invalidated && next.status === "preparing") {
      invalidated = true
      await invalidateP2TRSignatureFraudCanonicalProvenance(
        store,
        provenanceInvalidationEvidence(record)
      )
    }
  }

  const result = await dispatcher(store, preparer).prepare(
    record.recordID,
    "worker-a"
  )

  assert.equal(result.status, "cancelled-provenance-invalidated")
  assert.equal(preparer.reservationCalls, 0)
  assert.equal(preparer.calls, 0)
})

test("recovers and durably voids a crash after external nonce reservation", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  let now = 2_000
  preparer.afterReservation = async () => {
    preparer.afterReservation = undefined
    await invalidateP2TRSignatureFraudCanonicalProvenance(
      store,
      provenanceInvalidationEvidence(record, now)
    )
    throw new Error("simulated crash before reservation persistence")
  }
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now
  )

  const interrupted = await outbox.prepare(record.recordID, "worker-a")
  assert.equal(interrupted.status, "preparing")
  assert.equal(interrupted.reservedNonce, undefined)
  assert.ok(interrupted.provenanceInvalidationEvidence)

  now = 40_001
  const report = await outbox.recoverExpiredPreparationLeases()
  const recovered = await store.get(record.recordID)
  assert.equal(report.backlogRemaining, false)
  assert.equal(recovered?.status, "cancelled-provenance-invalidated")
  assert.equal(recovered?.voidedNonceReservations?.length, 1)
  assert.equal(preparer.releasedReservations.length, 1)
  assert.equal(preparer.reservationCalls, 2)
})

test("adopts the exact slow nonce reservation returned during idempotent recovery", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  let now = 2_000
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now
  )
  let firstReservation = true
  preparer.afterReservation = async () => {
    if (!firstReservation) {
      throw new Error(
        "allocator reports that the original request is in flight"
      )
    }
    firstReservation = false
    now = 40_001
    await outbox.recoverExpiredPreparationLeases()
    preparer.afterReservation = undefined
  }

  const result = await outbox.prepare(record.recordID, "worker-a")

  assert.equal(result.status, "preparing")
  assert.ok(result.reservedNonce)
  assert.equal(result.voidedNonceReservations?.length ?? 0, 0)
  assert.equal(preparer.releasedReservations.length, 0)
  assert.equal(preparer.reservationCalls, 2)
  assert.equal(preparer.calls, 0)
})

test("keeps an ambiguous allocator invocation sticky until independent resolution", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.releaseError = new Error("allocator unavailable")
  let now = 2_000
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now
  )
  let firstReservation = true
  preparer.afterReservation = async () => {
    if (!firstReservation) throw new Error("original request is in flight")
    firstReservation = false
    now = 40_001
    await outbox.recoverExpiredPreparationLeases()
    const ambiguous = await store.get(record.recordID)
    assert.ok(ambiguous)
    now = 40_002
    assert.equal(
      await store.compareAndSwap(record.recordID, ambiguous.version, {
        ...ambiguous,
        version: ambiguous.version + 1,
        status: "queued",
        preparationLease: undefined,
        preparationResumeStatus: undefined,
        activeSignerInvocationStartedAtUnixMs: undefined,
        preparationSender: undefined,
        selectedLaneID: undefined,
        selectedSignerIdentity: undefined,
        updatedAtUnixMs: now,
      }),
      true
    )
    preparer.afterReservation = undefined
  }

  const result = await outbox.prepare(record.recordID, "worker-a")

  assert.equal(result.voidedNonceReservations?.length, 1)
  assert.equal(result.signerQuarantines?.length ?? 0, 0)
  assert.equal(await store.hasPendingNonceReleases(), true)
  assert.equal(store.nonceReleaseRequests.size, 1)
  assert.equal([...store.nonceReleaseAttempts.values()][0].length, 1)
  assert.equal(preparer.releasedReservations.length, 0)

  const restartInvocation =
    await store.getActiveAmbiguousNonceReleaseInvocation(now)
  assert.ok(restartInvocation)
  assert.equal(
    restartInvocation.request.releaseRequestID,
    [...store.nonceReleaseRequests.values()][0].releaseRequestID
  )
  assert.equal(restartInvocation.attempt.attemptSequence, 1)
  assert.equal(restartInvocation.invokedAtUnixMs, 40_002)
  assert.match(
    restartInvocation.ambiguousResponseDigest ?? "",
    /^0x[0-9a-f]{64}$/
  )

  now = 80_000
  await outbox.recoverPendingNonceReleases()
  assert.equal([...store.nonceReleaseAttempts.values()][0].length, 1)

  const request = [...store.nonceReleaseRequests.values()][0]
  const attempt = [...store.nonceReleaseAttempts.values()][0][0]
  const providerEvidenceDigest = `0x${"93".repeat(32)}`
  const resolutionBinding = {
    releaseRequestID: request.releaseRequestID,
    attemptSequence: attempt.attemptSequence,
    attemptOwner: attempt.owner,
    attemptStartedAtUnixMs: attempt.startedAtUnixMs,
    attemptExpiresAtUnixMs: attempt.expiresAtUnixMs,
    invokedAtUnixMs: attempt.startedAtUnixMs,
    outcome: "already-released" as const,
    providerEvidenceDigest,
  }
  const evidenceDigest =
    computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest(
      resolutionBinding
    )
  assert.equal(
    await store.resolveAmbiguousNonceRelease({
      ...resolutionBinding,
      evidenceDigest,
      canonicalAttestations: [
        {
          trustDomainID: "allocator-primary",
          independenceDomainID: "allocator-primary-infra",
          evidenceDigest,
          attestation: "0x01",
          attestedAtUnixMs: now,
        },
        {
          trustDomainID: "allocator-corroborating",
          independenceDomainID: "allocator-corroborating-infra",
          evidenceDigest,
          attestation: "0x02",
          attestedAtUnixMs: now,
        },
      ],
      resolvedAtUnixMs: now,
    }),
    "acknowledged"
  )
  assert.equal(await store.hasPendingNonceReleases(), false)
  assert.equal(
    await store.getActiveAmbiguousNonceReleaseInvocation(now),
    undefined
  )
})

test("records a contract-mismatch quarantine with the reserved sender", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const reservation = await preparer.reserveSignatureFraudChallengeNonce(
    record.intent,
    Hex.from(record.recordID),
    record.generation,
    1
  )
  const voidEvidenceDigest = `0x${"91".repeat(32)}`
  const releaseRequestID = normalizeKey(
    computeP2TRSignatureFraudNonceReleaseRequestID(
      record.recordID,
      reservation.reservationID,
      voidEvidenceDigest
    )
  )
  store.nonceReleaseRequests.set(releaseRequestID, {
    releaseRequestID,
    recordID: record.recordID,
    generation: record.generation,
    reservation,
    voidEvidenceDigest,
    requestedAtUnixMs: 2_000,
    attemptCount: 0,
    ambiguous: false,
  })
  const attempt = await store.claimNonceReleaseAttempt(
    releaseRequestID,
    "worker-a",
    2_100,
    2_200
  )
  assert.ok(attempt)
  assert.equal(await store.beginNonceReleaseAttempt(attempt, 2_101), true)

  assert.equal(
    await store.recordNonceReleaseAttemptResult(attempt, {
      kind: "contract-mismatch",
      responseDigest: `0x${"92".repeat(32)}`,
      detail: "allocator returned another reservation",
      recordedAtUnixMs: 2_102,
    }),
    "ambiguous"
  )

  const quarantined = await store.get(record.recordID)
  assert.equal(
    quarantined?.signerQuarantines?.[0].expectedSender,
    reservation.sender
  )
  assert.equal(
    store.criticalAlerts.some(
      (alert) => alert.code === "reservation-release-failed"
    ),
    true
  )
})

test("keeps normal lease-recovery release ambiguous until an exact ack", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.releaseError = new Error("allocator unavailable")
  let now = 2_000
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now
  )
  store.beforeProvenanceCAS = async (_current, next) => {
    if (next.activeSignerInvocationStartedAtUnixMs === undefined) return
    store.beforeProvenanceCAS = undefined
    now = 40_001
    await outbox.recoverExpiredPreparationLeases()
  }

  const result = await outbox.prepare(record.recordID, "worker-a")

  assert.equal(result.status, "queued")
  assert.equal(result.voidedNonceReservations?.length, 1)
  assert.equal(result.signerQuarantines?.length ?? 0, 0)
  assert.equal(await store.hasPendingNonceReleases(), true)
  assert.equal(preparer.calls, 0)
})

test("captures exact bytes when provenance invalidation wins after signer invocation", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.afterInitialSign = async () => {
    await invalidateP2TRSignatureFraudCanonicalProvenance(
      store,
      provenanceInvalidationEvidence(record)
    )
  }

  const result = await dispatcher(store, preparer).prepare(
    record.recordID,
    "worker-a"
  )

  assert.equal(result.status, "provenance-invalidated-awaiting-reconciliation")
  assert.equal(result.preparedTransactionVariants, undefined)
  assert.equal(result.unexpectedSignedArtifacts?.length, 1)
  assert.equal(
    result.unexpectedSignedArtifacts?.[0].preparedTransaction.rawTransaction,
    RAW_TRANSACTION
  )
  assert.equal(
    store.criticalAlerts.some(
      ({ code }) => code === "provenance-reconciliation-incident"
    ),
    true
  )
})

test("journals recoverable signed bytes before rejecting response metadata", async () => {
  const mutations: Array<
    (
      response: P2TRSignatureFraudPreparedChallengeTransactionResponse
    ) => P2TRSignatureFraudPreparedChallengeTransactionResponse
  > = [
    (response) => ({ ...response, intentID: Hex.from(`0x${"91".repeat(32)}`) }),
    (response) => ({
      ...response,
      transactionHash: Hex.from(`0x${"92".repeat(32)}`),
    }),
    (response) => ({
      ...response,
      sender: "0x0000000000000000000000000000000000000093",
    }),
    (response) => ({ ...response, nonce: response.nonce + 1 }),
  ]

  for (const mutate of mutations) {
    const store = new InMemoryOutboxStore()
    const record = await enqueue(store)
    const preparer = new FixedPreparer()
    preparer.mutateInitialResponse = mutate
    const result = await dispatcher(store, preparer).prepare(
      record.recordID,
      "worker-a"
    )

    assert.equal(result.status, "quarantined")
    assert.equal(result.activeSignerInvocationStartedAtUnixMs, undefined)
    assert.equal(result.unexpectedSignedArtifacts?.length, 1)
    assert.equal(
      result.unexpectedSignedArtifacts?.[0].preparedTransaction.rawTransaction,
      RAW_TRANSACTION
    )
    assert.equal(
      normalizeKey(
        result.unexpectedSignedArtifacts![0].preparedTransaction.transactionHash
      ),
      TRANSACTION_HASH
    )
    assert.equal(
      result.unexpectedSignedArtifacts?.[0].preparedTransaction.nonce,
      7
    )
  }
})

test("persists the actual lane, call, and value before rejecting signer intent", async () => {
  const unexpected = [
    signTestChallengeTransaction(defaultTestCall.calldata, 20, 2, {
      chainId: 11155112,
    }),
    signTestChallengeTransaction(defaultTestCall.calldata, 20, 2, {
      to: "0x3333333333333333333333333333333333333333",
    }),
    signTestChallengeTransaction(defaultTestCall.calldata, 20, 2, {
      data: "0x1234",
    }),
    signTestChallengeTransaction(defaultTestCall.calldata, 20, 2, {
      value: 1235,
    }),
  ]

  for (const signed of unexpected) {
    const store = new InMemoryOutboxStore()
    const record = await enqueue(store)
    const preparer = new FixedPreparer()
    preparer.rawTransaction = signed.rawTransaction
    preparer.transactionHash = signed.transactionHash

    const result = await dispatcher(store, preparer).prepare(
      record.recordID,
      "worker-a"
    )

    const artifact = result.unexpectedSignedArtifacts?.[0]?.preparedTransaction
    const parsed = utils.parseTransaction(signed.rawTransaction)
    assert.equal(result.status, "quarantined")
    assert.ok(artifact)
    assert.equal(normalizeKey(artifact.transactionHash), parsed.hash)
    assert.equal(artifact.sender, parsed.from)
    assert.equal(artifact.nonce, parsed.nonce)
    assert.equal(artifact.chainID, parsed.chainId)
    assert.equal(artifact.to, parsed.to)
    assert.equal(artifact.calldata, parsed.data)
    assert.equal(artifact.value, parsed.value.toString())
  }
})

test("retains the active boundary for an uncorrelated signer response", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.mutateInitialResponse = (response) => ({
    ...response,
    signerInvocationID: Hex.from(`0x${"94".repeat(32)}`),
  })

  const result = await dispatcher(store, preparer).prepare(
    record.recordID,
    "worker-a"
  )

  assert.equal(result.status, "preparing")
  assert.equal(result.activeSignerInvocationStartedAtUnixMs, 2_000)
  assert.equal(result.unexpectedSignedArtifacts?.length, 1)
  assert.equal(
    result.signerQuarantines?.at(-1)?.reasonCode,
    "ambiguous-signer-invocation"
  )
  assert.match(result.lastError ?? "", /another request or invocation/)
})

test("does not let lease recovery steal an active signer boundary", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  let now = 2_000
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now
  )
  preparer.afterInitialSign = async () => {
    now = 40_001
    await outbox.recoverExpiredPreparationLeases()
  }

  const result = await outbox.prepare(record.recordID, "worker-a")

  assert.equal(result.status, "prepared")
  assert.equal(result.reservedNonce?.nonce, 7)
  assert.equal(result.unexpectedSignedArtifacts, undefined)
  assert.equal(result.activeSignerInvocationStartedAtUnixMs, undefined)
})

// A preparation lease can expire while another replica is still inside the
// signer boundary. Lease expiry is a local timeout, not proof that the remote
// call stopped, so recovery must leave `activeSignerInvocationStartedAtUnixMs`
// exactly as it found it: only an independently attested provider outcome (or
// the worker that owns the call and watched it return) may clear the global
// signer-I/O barrier. Clearing it here would decrement the singleton barrier
// while an RPC may still be outstanding and would strand any late signed bytes,
// because `captureEscapedSignedArtifact` refuses artifacts with no retained
// durable signer boundary. Recovery equally may not invent a durable
// `signerInvocationStartedAtUnixMs` for a signer it never called. The record is
// therefore deliberately left unresolved and startup stays activation-blocked.
test("a fresh dispatcher leaves an expired active signer boundary unresolved and blocks recovery", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  let now = 2_000
  let markAuthorizationStarted!: () => void
  let releaseAuthorization!: () => void
  const authorizationStarted = new Promise<void>((resolve) => {
    markAuthorizationStarted = resolve
  })
  const authorizationGate = new Promise<void>((resolve) => {
    releaseAuthorization = resolve
  })
  authorizer.beforeAuthorize = async () => {
    markAuthorizationStarted()
    await authorizationGate
  }
  authorizer.rejectAuthorization = new Error("worker restarted")
  const original = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now,
    100,
    undefined,
    authorizer
  )
  const pending = original.prepare(record.recordID, "worker-a")
  await authorizationStarted

  now = 40_001
  const restarted = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now
  )
  const report = await restarted.recoverExpiredPreparationLeases()
  const recovered = await store.get(record.recordID)
  assert.equal(report.recovered, 0)
  assert.equal(report.backlogRemaining, true)
  assert.equal(recovered?.status, "preparing")
  assert.ok(recovered?.preparationLease)
  assert.equal(recovered?.activeSignerInvocationStartedAtUnixMs, 2_000)
  assert.equal(recovered?.signerInvocationStartedAtUnixMs, undefined)
  assert.ok(recovered?.reservedNonce)
  assert.equal(preparer.releasedReservations.length, 0)
  assert.equal(
    store.criticalAlerts.some(
      ({ code }) => code === "signed-state-quarantined"
    ),
    false
  )

  // Only the worker that owns the in-flight boundary may retire it, and it does
  // so without inventing signer I/O that provably never happened.
  releaseAuthorization()
  const originalResult = await pending
  assert.equal(originalResult.status, "preparing")
  assert.equal(preparer.calls, 0)
  const settled = await store.get(record.recordID)
  assert.equal(settled?.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(settled?.signerInvocationStartedAtUnixMs, undefined)
})

// Canonical provenance invalidation racing an in-flight initial signer boundary
// does not weaken the barrier rule. Invalidation is evidence about the *intent*,
// not about whether the external signer call stopped, so restart recovery still
// leaves `activeSignerInvocationStartedAtUnixMs` set and still refuses to
// fabricate `signerInvocationStartedAtUnixMs`. Retiring the record to
// "provenance-invalidated-awaiting-reconciliation" on lease expiry alone would
// clear the singleton signer barrier while the call may still be outstanding
// and would leave late signed bytes with no retained durable boundary to be
// journaled against. The transition happens only once the owning worker
// observes its own boundary resolve.
test("restart recovery leaves an invalidated active initial signer boundary unresolved", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  let now = 2_000
  let markInvalidated!: () => void
  let releaseAuthorization!: () => void
  const invalidated = new Promise<void>((resolve) => {
    markInvalidated = resolve
  })
  const gate = new Promise<void>((resolve) => {
    releaseAuthorization = resolve
  })
  authorizer.beforeAuthorize = async () => {
    await invalidateP2TRSignatureFraudCanonicalProvenance(
      store,
      provenanceInvalidationEvidence(record, now)
    )
    markInvalidated()
    await gate
  }
  authorizer.rejectAuthorization = new Error("worker restarted")
  const original = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now,
    100,
    undefined,
    authorizer
  )
  const pending = original.prepare(record.recordID, "worker-a")
  await invalidated
  const stranded = await store.get(record.recordID)
  assert.equal(stranded?.status, "preparing")
  assert.ok(stranded?.preparationLease)
  assert.ok(stranded?.activeSignerInvocationStartedAtUnixMs)

  now = 40_001
  const restarted = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now
  )
  const report = await restarted.recoverExpiredPreparationLeases()
  const recovered = await store.get(record.recordID)
  assert.equal(report.recovered, 0)
  assert.equal(report.backlogRemaining, true)
  assert.equal(recovered?.status, "preparing")
  assert.ok(recovered?.preparationLease)
  assert.equal(recovered?.activeSignerInvocationStartedAtUnixMs, 2_000)
  assert.equal(recovered?.signerInvocationStartedAtUnixMs, undefined)
  assert.ok(recovered?.reservedNonce)
  assert.ok(recovered?.provenanceInvalidationEvidence)
  assert.equal(preparer.releasedReservations.length, 0)

  // The owning worker retires its own boundary. Because no signer was ever
  // called and no signed state exists, the record simply returns to an
  // unresolved preparing row that a later pass may cancel on the invalidation
  // evidence — no signer I/O is invented on the way.
  releaseAuthorization()
  const pendingResult = await pending
  assert.equal(pendingResult.status, "preparing")
  assert.equal(preparer.calls, 0)
  const settled = await store.get(record.recordID)
  assert.equal(settled?.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(settled?.signerInvocationStartedAtUnixMs, undefined)
  assert.ok(settled?.provenanceInvalidationEvidence)
})

// Same barrier rule with prior signed state on the row. The replacement signer
// boundary is in flight when provenance is invalidated and the lease expires;
// restart recovery still may not clear the active marker, because a lease
// timeout cannot prove the replacement signer call stopped and the retained
// marker is what lets a late artifact be journaled at all. It equally may not
// touch the prior `signerInvocationStartedAtUnixMs`/variant, which are real
// durable evidence of the earlier initial signer call. So the row stays
// "preparing" with its resume status intact until the owning worker resolves
// its own boundary and moves it to reconciliation.
test("restart recovery leaves an invalidated active replacement boundary unresolved", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  let now = 2_000
  const original = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now,
    100,
    undefined,
    authorizer
  )
  assert.equal(
    (await original.prepare(record.recordID, "worker-a")).status,
    "prepared"
  )

  let markInvalidated!: () => void
  let releaseAuthorization!: () => void
  const invalidated = new Promise<void>((resolve) => {
    markInvalidated = resolve
  })
  const gate = new Promise<void>((resolve) => {
    releaseAuthorization = resolve
  })
  authorizer.beforeAuthorize = async (binding) => {
    if (binding.stage !== "replacement") return
    await invalidateP2TRSignatureFraudCanonicalProvenance(
      store,
      provenanceInvalidationEvidence(record, now)
    )
    markInvalidated()
    await gate
  }
  authorizer.rejectAuthorization = new Error("worker restarted")
  const pending = original.prepareReplacement(record.recordID, "worker-b")
  await invalidated
  const stranded = await store.get(record.recordID)
  assert.equal(stranded?.status, "preparing")
  assert.ok(stranded?.preparationLease)
  assert.equal(stranded?.preparationResumeStatus, "prepared")
  assert.ok(stranded?.activeSignerInvocationStartedAtUnixMs)

  now = 40_001
  const restarted = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now
  )
  const report = await restarted.recoverExpiredPreparationLeases()
  const recovered = await store.get(record.recordID)
  assert.equal(report.recovered, 0)
  assert.equal(report.backlogRemaining, true)
  assert.equal(recovered?.status, "preparing")
  assert.ok(recovered?.preparationLease)
  assert.equal(recovered?.activeSignerInvocationStartedAtUnixMs, 2_000)
  assert.ok(recovered?.reservedNonce)
  // Durable evidence of the *earlier, real* initial signer call is preserved
  // byte-for-byte. Recovery neither invents this field nor rewrites it.
  assert.equal(recovered?.signerInvocationStartedAtUnixMs, 2_000)
  assert.equal(recovered?.preparationResumeStatus, "prepared")
  assert.equal(recovered?.preparedTransactionVariants?.length, 1)
  assert.equal(preparer.releasedReservations.length, 0)

  // Only the worker that owns the replacement boundary retires it, and it hands
  // the row to reconciliation with the prior signed state still intact.
  releaseAuthorization()
  const pendingResult = await pending
  assert.equal(
    pendingResult.status,
    "provenance-invalidated-awaiting-reconciliation"
  )
  assert.equal(preparer.replacementCalls, 0)
  const settled = await store.get(record.recordID)
  assert.equal(settled?.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(settled?.signerInvocationStartedAtUnixMs, 2_000)
  assert.equal(settled?.preparedTransactionVariants?.length, 1)
})

test("captures a replacement returned after provenance invalidation", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const outbox = dispatcher(store, preparer)
  const prepared = await outbox.prepare(record.recordID, "worker-a")
  assert.equal(prepared.status, "prepared")
  preparer.afterReplacementSign = async () => {
    await invalidateP2TRSignatureFraudCanonicalProvenance(
      store,
      provenanceInvalidationEvidence(record)
    )
  }

  const result = await outbox.prepareReplacement(record.recordID, "worker-b")

  assert.equal(result.status, "provenance-invalidated-awaiting-reconciliation")
  assert.equal(result.preparedTransactionVariants?.length, 1)
  assert.equal(
    result.unexpectedSignedArtifacts?.[0].preparedTransaction.rawTransaction,
    REPLACEMENT_RAW_TRANSACTION
  )
})

test("does not broadcast when provenance invalidation wins the send claim", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const broadcaster = new RecordingBroadcaster()
  const outbox = dispatcher(store, new FixedPreparer(), broadcaster)
  await outbox.prepare(record.recordID, "worker-a")
  let invalidated = false
  store.beforeProvenanceCAS = async (_current, next) => {
    if (!invalidated && next.status === "broadcast-pending") {
      invalidated = true
      await invalidateP2TRSignatureFraudCanonicalProvenance(
        store,
        provenanceInvalidationEvidence(record)
      )
    }
  }

  const result = await outbox.broadcast(record.recordID)

  assert.equal(result.status, "provenance-invalidated-awaiting-reconciliation")
  assert.deepEqual(broadcaster.rawTransactions, [])
})

test("records the unavoidable external race when invalidation follows the send boundary", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const broadcaster = new RecordingBroadcaster()
  broadcaster.inspectDurableBoundary = async () => {
    await invalidateP2TRSignatureFraudCanonicalProvenance(
      store,
      provenanceInvalidationEvidence(record)
    )
  }
  const outbox = dispatcher(store, new FixedPreparer(), broadcaster)
  await outbox.prepare(record.recordID, "worker-a")

  const result = await outbox.broadcast(record.recordID)

  assert.equal(result.status, "provenance-invalidated-awaiting-reconciliation")
  assert.deepEqual(broadcaster.rawTransactions, [RAW_TRANSACTION])
  assert.equal(result.broadcastAttempts, 1)
  assert.equal(
    store.criticalAlerts.some(
      ({ code }) => code === "provenance-reconciliation-incident"
    ),
    true
  )
})

test("retains the sender lane when remote signing outcome is ambiguous", async () => {
  const store = new InMemoryOutboxStore()
  const first = await enqueue(store, createIntent("aa"))
  const second = await enqueue(store, createIntent("ab"))
  const preparer = new AmbiguousRemotePreparer()
  const outbox = dispatcher(store, preparer)

  const quarantined = await outbox.prepare(first.recordID, "worker-a")
  assert.equal(quarantined.status, "quarantined")
  assert.ok(quarantined.preparationSender)
  const blocked = await outbox.prepare(second.recordID, "worker-b")
  assert.equal(blocked.status, "queued")
  assert.equal(preparer.calls, 1)
})

test("rejects non-replaceable legacy envelopes after retaining the signer lane", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.rawTransaction = LEGACY_RAW_TRANSACTION
  preparer.transactionHash = LEGACY_TRANSACTION_HASH
  const outbox = dispatcher(store, preparer)

  const result = await outbox.prepare(record.recordID, "worker-a")
  assert.equal(result.status, "quarantined")
  assert.equal(
    result.preparationSender?.toLowerCase(),
    TRANSACTION_SENDER.toLowerCase()
  )
  assert.equal(result.preparedTransactionVariants, undefined)
  assert.match(result.lastError ?? "", /requires an EIP-1559/)
})

test("persists send boundary and retries only identical signed bytes", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const broadcaster = new RecordingBroadcaster()
  broadcaster.throwAfterSend = new Error("x".repeat(5_000))
  broadcaster.inspectDurableBoundary = async () => {
    const durable = await store.get(record.recordID)
    assert.equal(durable?.status, "broadcast-pending")
    assert.equal(
      durable?.broadcastAttempts,
      broadcaster.rawTransactions.length + 1
    )
  }
  const outbox = dispatcher(store, preparer, broadcaster)
  await outbox.prepare(record.recordID, "worker-a")
  const first = await outbox.broadcast(record.recordID)
  const second = await outbox.broadcast(record.recordID)

  assert.equal(first.status, "broadcast-pending")
  assert.equal(second.broadcastAttempts, 2)
  assert.equal(second.lastError?.length, 1_024)
  assert.equal(preparer.calls, 1)
  assert.deepEqual(broadcaster.rawTransactions, [
    RAW_TRANSACTION,
    RAW_TRANSACTION,
  ])
})

test("appends fee replacements and reconciles every same-nonce hash", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const broadcaster = new RecordingBroadcaster()
  const reconciler = new FixedReconciler()
  let expectedInitialInvocationID: string | undefined
  let expectedReplacementInvocationID: string | undefined
  preparer.afterInitialSign = async () => {
    const boundary = await store.get(record.recordID)
    expectedInitialInvocationID = computeP2TRSignatureFraudSignerInvocationID({
      recordID: boundary!.recordID,
      boundaryStartedAtUnixMs: boundary!.activeSignerInvocationStartedAtUnixMs!,
      preparationAttempts: boundary!.preparationAttempts,
      nonceReservationID: boundary!.reservedNonce!.reservationID.toString(),
      stage: "prepare",
    })
  }
  preparer.afterReplacementSign = async () => {
    const boundary = await store.get(record.recordID)
    expectedReplacementInvocationID =
      computeP2TRSignatureFraudSignerInvocationID({
        recordID: boundary!.recordID,
        boundaryStartedAtUnixMs:
          boundary!.activeSignerInvocationStartedAtUnixMs!,
        preparationAttempts: boundary!.preparationAttempts,
        nonceReservationID: boundary!.reservedNonce!.reservationID.toString(),
        stage: "replacement",
      })
  }
  const outbox = dispatcher(
    store,
    preparer,
    broadcaster,
    new FixedRechecker(),
    reconciler
  )

  await outbox.prepare(record.recordID, "worker-a")
  await outbox.broadcast(record.recordID)
  const replaced = await outbox.prepareReplacement(record.recordID, "worker-b")
  assert.equal(replaced.status, "broadcast-pending")
  assert.equal(preparer.replacementCalls, 1)
  assert.deepEqual(preparer.initialInvocationIDs, [expectedInitialInvocationID])
  assert.deepEqual(preparer.replacementInvocationIDs, [
    expectedReplacementInvocationID,
  ])
  assert.deepEqual(
    replaced.preparedTransactionVariants?.map((variant) => ({
      sequence: variant.sequence,
      hash: normalizeKey(variant.preparedTransaction.transactionHash),
      attempts: variant.broadcastAttempts,
    })),
    [
      { sequence: 0, hash: TRANSACTION_HASH, attempts: 1 },
      { sequence: 1, hash: REPLACEMENT_TRANSACTION_HASH, attempts: 0 },
    ]
  )

  broadcaster.returnedHash = REPLACEMENT_TRANSACTION_HASH
  const broadcastReplacement = await outbox.broadcast(record.recordID)
  assert.equal(broadcastReplacement.broadcastAttempts, 2)
  assert.deepEqual(broadcaster.rawTransactions, [
    RAW_TRANSACTION,
    REPLACEMENT_RAW_TRANSACTION,
  ])

  // The earlier transaction can still win after a replacement was signed.
  reconciler.resolution = acceptedOwnResolution(TRANSACTION_HASH)
  const accepted = await outbox.reconcile(record.recordID)
  assert.equal(accepted.status, "accepted-own")
  assert.equal(accepted.preparationSender, normalizeKey(TRANSACTION_SENDER))
})

test("rejects non-increasing replacements without forgetting signed state", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.replacementRawTransaction = RAW_TRANSACTION
  preparer.replacementTransactionHash = TRANSACTION_HASH
  const outbox = dispatcher(store, preparer)

  await outbox.prepare(record.recordID, "worker-a")
  const quarantined = await outbox.prepareReplacement(
    record.recordID,
    "worker-b"
  )
  assert.equal(quarantined.status, "prepared")
  assert.ok(quarantined.preparationSender)
  assert.equal(quarantined.preparedTransactionVariants?.length, 1)
  assert.equal(
    normalizeKey(
      quarantined.preparedTransactionVariants![0].preparedTransaction
        .transactionHash
    ),
    TRANSACTION_HASH
  )
  assert.match(quarantined.lastError ?? "", /strictly increase|distinct/)
  assert.equal(store.criticalAlerts.at(-1)?.code, "signed-state-quarantined")
})

test("enforces manifest-bound fee and exact value caps at every boundary", async () => {
  for (const maxFeePerGas of [99, 100]) {
    const store = new InMemoryOutboxStore()
    const record = await enqueue(store)
    const preparer = new DynamicFeePreparer()
    preparer.initialMaxFeePerGas = maxFeePerGas
    preparer.initialPriorityFeePerGas = 9
    const prepared = await dispatcher(store, preparer).prepare(
      record.recordID,
      "worker"
    )
    assert.equal(prepared.status, "prepared")
  }

  const overFeeStore = new InMemoryOutboxStore()
  const overFeeRecord = await enqueue(overFeeStore)
  const overFeePreparer = new DynamicFeePreparer()
  overFeePreparer.initialMaxFeePerGas = 101
  const overFee = await dispatcher(overFeeStore, overFeePreparer).prepare(
    overFeeRecord.recordID,
    "worker"
  )
  assert.equal(overFee.status, "quarantined")
  assert.match(overFee.lastError ?? "", /manifest-bound fee or value policy/)

  const overGasStore = new InMemoryOutboxStore()
  const overGasRecord = await enqueue(overGasStore)
  const overGasPreparer = new DynamicFeePreparer()
  overGasPreparer.initialGasLimit = 1_000_001
  const overGas = await dispatcher(overGasStore, overGasPreparer).prepare(
    overGasRecord.recordID,
    "worker"
  )
  assert.equal(overGas.status, "quarantined")

  const underGasStore = new InMemoryOutboxStore()
  const underGasRecord = await enqueue(underGasStore)
  const underGasPreparer = new DynamicFeePreparer()
  underGasPreparer.initialGasLimit = 999_999
  const underGas = await dispatcher(underGasStore, underGasPreparer).prepare(
    underGasRecord.recordID,
    "worker"
  )
  assert.equal(underGas.status, "quarantined")
  assert.match(underGas.lastError ?? "", /manifest-bound gas limit/)

  const wrongValueStore = new InMemoryOutboxStore()
  const wrongValueRecord = await enqueue(wrongValueStore)
  const wrongValuePreparer = new DynamicFeePreparer()
  wrongValuePreparer.initialValue = "1235"
  const wrongValue = await dispatcher(
    wrongValueStore,
    wrongValuePreparer
  ).prepare(wrongValueRecord.recordID, "worker")
  assert.equal(wrongValue.status, "quarantined")
  assert.match(wrongValue.lastError ?? "", /does not match its durable intent/)

  const replacementStore = new InMemoryOutboxStore()
  const replacementRecord = await enqueue(replacementStore)
  const replacementPreparer = new DynamicFeePreparer()
  replacementPreparer.initialMaxFeePerGas = 50
  replacementPreparer.initialPriorityFeePerGas = 5
  const replacementOutbox = dispatcher(replacementStore, replacementPreparer)
  await replacementOutbox.prepare(replacementRecord.recordID, "worker-a")
  const rejectedReplacement = await replacementOutbox.prepareReplacement(
    replacementRecord.recordID,
    "worker-b"
  )
  assert.equal(rejectedReplacement.status, "prepared")
  assert.equal(rejectedReplacement.preparedTransactionVariants?.length, 1)
  assert.equal(
    replacementStore.criticalAlerts.at(-1)?.code,
    "signed-state-quarantined"
  )
})

test("rejects fee-policy manifest drift for an existing generation", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  record.feePolicyManifest = {
    ...record.feePolicyManifest,
    policyHash: `0x${"99".repeat(32)}`,
  }
  await assert.rejects(
    dispatcher(store).prepare(record.recordID, "worker"),
    /fee policy drifted/
  )
})

test("keeps wrong broadcaster hash post-send pending and reconcilable", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const broadcaster = new RecordingBroadcaster()
  broadcaster.returnedHash = `0x${"99".repeat(32)}`
  const outbox = dispatcher(store, new FixedPreparer(), broadcaster)
  await outbox.prepare(record.recordID, "worker-a")
  const result = await outbox.broadcast(record.recordID)

  assert.equal(result.status, "broadcast-pending")
  assert.equal(result.broadcastAttempts, 1)
  assert.equal(
    result.preparationSender?.toLowerCase(),
    TRANSACTION_SENDER.toLowerCase()
  )
  assert.match(
    result.lastError ?? "",
    /does not match the persisted raw transaction/
  )
})

test("pre-send recheck cancels only before the irreversible boundary", async () => {
  const honestStore = new InMemoryOutboxStore()
  const honestRecord = await enqueue(honestStore)
  const honestRechecker = new FixedRechecker()
  honestRechecker.resolution = {
    status: "cancelled-honest-spend",
    reason: "canonical proof now identifies an honest spend",
    evidence: cancellationEvidence(honestRecord, "honest-spend"),
  }
  const honestBroadcaster = new RecordingBroadcaster()
  const honestOutbox = dispatcher(
    honestStore,
    new FixedPreparer(),
    honestBroadcaster,
    honestRechecker
  )
  const cancelled = await honestOutbox.prepare(
    honestRecord.recordID,
    "worker-a"
  )
  assert.equal(cancelled.status, "cancelled-honest-spend")
  assert.equal(cancelled.preparationSender, undefined)
  assert.equal(cancelled.signerInvocationStartedAtUnixMs, undefined)
  assert.deepEqual(honestRechecker.stages, ["before-sign"])
  assert.equal(honestBroadcaster.rawTransactions.length, 0)

  const reorgStore = new InMemoryOutboxStore()
  const reorgRecord = await enqueue(reorgStore)
  const reorgRechecker = new FixedRechecker()
  const reorgBroadcaster = new RecordingBroadcaster()
  const reorgOutbox = dispatcher(
    reorgStore,
    new FixedPreparer(),
    reorgBroadcaster,
    reorgRechecker
  )
  await reorgOutbox.prepare(reorgRecord.recordID, "worker-a")
  await reorgOutbox.broadcast(reorgRecord.recordID)
  reorgRechecker.resolution = {
    status: "cancelled-reorg",
    reason: "candidate is no longer canonical",
    evidence: cancellationEvidence(reorgRecord, "canonical-reorg"),
  }
  const pending = await reorgOutbox.broadcast(reorgRecord.recordID)
  assert.equal(pending.status, "broadcast-pending")
  assert.equal(pending.broadcastAttempts, 1)
  assert.ok(pending.preparationSender)
  assert.equal(reorgBroadcaster.rawTransactions.length, 1)
})

test("rechecks the finalized Bridge deposit before signing and broadcasting", async () => {
  const raisedDepositEligibility = (
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): P2TRSignatureFraudPreBroadcastRecheckResult => ({
    status: "eligible",
    canonicalCandidate: {
      txid: record.evidenceCheckpoint.bitcoinTxHash,
      wtxid: record.evidenceCheckpoint.bitcoinWitnessTxHash,
      blockHash: record.evidenceCheckpoint.bitcoinBlockHash,
      blockHeight: record.evidenceCheckpoint.bitcoinBlockHeight,
      inputIndex: record.evidenceCheckpoint.bitcoinInputIndex,
    },
    canonicalEthereumEligibility: ethereumEligibility(
      record.intent,
      record.evidenceCheckpoint.ethereumLifecycleBlockNumber,
      record.evidenceCheckpoint.ethereumLifecycleBlockHash,
      undefined,
      "1235"
    ),
    canonicalProvenance: record.canonicalProvenance,
  })

  const signStore = new InMemoryOutboxStore()
  const signRecord = await enqueue(signStore)
  const signPreparer = new FixedPreparer()
  const signRechecker = new FixedRechecker()
  signRechecker.resolution = raisedDepositEligibility(signRecord)
  const unsigned = await dispatcher(
    signStore,
    signPreparer,
    new RecordingBroadcaster(),
    signRechecker
  ).prepare(signRecord.recordID, "worker-a")
  assert.equal(unsigned.status, "queued")
  assert.equal(signPreparer.calls, 0)
  assert.match(unsigned.lastError ?? "", /does not cover the finalized Bridge/)

  const broadcastStore = new InMemoryOutboxStore()
  const broadcastRecord = await enqueue(broadcastStore)
  const broadcastRechecker = new FixedRechecker()
  const broadcaster = new RecordingBroadcaster()
  const broadcastOutbox = dispatcher(
    broadcastStore,
    new FixedPreparer(),
    broadcaster,
    broadcastRechecker
  )
  await broadcastOutbox.prepare(broadcastRecord.recordID, "worker-b")
  broadcastRechecker.resolution = raisedDepositEligibility(broadcastRecord)
  const unbroadcast = await broadcastOutbox.broadcast(broadcastRecord.recordID)
  assert.equal(unbroadcast.status, "prepared")
  assert.equal(broadcaster.rawTransactions.length, 0)
  assert.match(
    unbroadcast.lastError ?? "",
    /does not cover the finalized Bridge/
  )
})

test("recovers one bounded preparation page and reports remaining backlog", async () => {
  const store = new InMemoryOutboxStore()
  for (const seed of ["a1", "a2", "a3"]) {
    const record = createRecord(createIntent(seed))
    record.status = "preparing"
    record.preparationLease = { owner: `worker-${seed}`, expiresAtUnixMs: 1 }
    await store.insertGenerationIfAbsent(record)
  }
  let backlogReports = 0
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => 2_000,
    2,
    () => {
      backlogReports++
    }
  )
  const first = await outbox.recoverExpiredPreparationLeases()
  assert.deepEqual(
    {
      scanned: first.scanned,
      recovered: first.recovered,
      backlog: first.backlogRemaining,
    },
    { scanned: 2, recovered: 2, backlog: true }
  )
  assert.equal(backlogReports, 1)
  assert.equal(
    [...store.records.values()].filter(({ status }) => status === "queued")
      .length,
    2
  )
  const second = await outbox.recoverExpiredPreparationLeases(first.nextCursor)
  assert.equal(second.scanned, 1)
})

test("accepts only decoded, finalized canonical own evidence", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const reconciler = new FixedReconciler()
  const broadcaster = new RecordingBroadcaster()
  reconciler.resolution = acceptedOwnResolution()
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    broadcaster,
    new FixedRechecker(),
    reconciler
  )
  await outbox.prepare(record.recordID, "worker-a")
  await outbox.broadcast(record.recordID)
  assert.equal((await outbox.reconcile(record.recordID)).status, "accepted-own")

  const invalidStore = new InMemoryOutboxStore()
  const invalidRecord = await enqueue(invalidStore)
  const invalidReconciler = new FixedReconciler()
  const invalid = acceptedOwnResolution()
  assert.equal(invalid.status, "accepted-own")
  const { canonicalAttestations: _invalidAttestations, ...invalidEvidence } =
    invalid
  invalidReconciler.resolution = withCanonicalAttestations({
    ...invalidEvidence,
    transaction: {
      ...invalid.transaction,
      decodedSubmissionCall: {
        ...invalid.transaction.decodedSubmissionCall,
        challengeKey: `0x${"66".repeat(32)}`,
      },
    },
  } as Parameters<typeof withCanonicalAttestations>[0])
  const invalidOutbox = dispatcher(
    invalidStore,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    invalidReconciler
  )
  await invalidOutbox.prepare(invalidRecord.recordID, "worker-a")
  await invalidOutbox.broadcast(invalidRecord.recordID)
  const unresolved = await invalidOutbox.reconcile(invalidRecord.recordID)
  assert.equal(unresolved.status, "broadcast-pending")
  assert.equal(unresolved.lastResolutionStatus, "unknown")
  assert.match(unresolved.lastError ?? "", /decoded submission call/)
})

test("does not terminalize at an application-depth head without consensus finality", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const reconciler = new FixedReconciler()
  const resolution = acceptedOwnResolution()
  assert.equal(resolution.status, "accepted-own")
  reconciler.resolution = {
    ...resolution,
    consensusFinalized: false,
  } as unknown as P2TRSignatureFraudChallengeOutboxResolution
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    reconciler
  )
  await outbox.prepare(record.recordID, "worker-a")
  await outbox.broadcast(record.recordID)

  const unresolved = await outbox.reconcile(record.recordID)
  assert.equal(unresolved.status, "broadcast-pending")
  assert.equal(unresolved.lastResolutionStatus, "unknown")
  assert.match(unresolved.lastError ?? "", /consensus-finalized/)
})

test("keeps eligible evidence open after finalized nonce disposition", async () => {
  const finalizedEvidence = {
    observedHead: {
      blockNumber: 120,
      blockHash: `0x${"12".repeat(32)}`,
    },
    finalizedThrough: {
      blockNumber: 108,
      blockHash: `0x${"18".repeat(32)}`,
    },
    consensusFinalized: true as const,
    routerChallenge: {
      exists: false as const,
      challengeKey: CHALLENGE_KEY,
      readAtBlock: 108,
    },
  }
  const resolutions: P2TRSignatureFraudChallengeOutboxResolution[] = [
    withCanonicalAttestations({
      ...finalizedEvidence,
      status: "terminal-reverted",
      receipt: {
        transactionHash: TRANSACTION_HASH,
        status: 0,
        blockNumber: 100,
        blockHash: `0x${"10".repeat(32)}`,
      },
    } as Parameters<typeof withCanonicalAttestations>[0]),
    withCanonicalAttestations({
      ...finalizedEvidence,
      status: "terminal-nonce-consumed",
      sender: TRANSACTION_SENDER,
      transactionNonce: 7,
      finalizedAccountNonce: 8,
      accountNonceReadAtBlock: 108,
      transactionAbsent: true,
      consumingTransaction: {
        transactionHash: `0x${"55".repeat(32)}`,
        sender: TRANSACTION_SENDER,
        nonce: 7,
        blockNumber: 101,
        blockHash: `0x${"56".repeat(32)}`,
      },
    } as Parameters<typeof withCanonicalAttestations>[0]),
  ]

  for (const resolution of resolutions) {
    const store = new InMemoryOutboxStore()
    const record = await enqueue(store)
    const reconciler = new FixedReconciler()
    reconciler.resolution = resolution
    const outbox = dispatcher(
      store,
      new FixedPreparer(),
      new RecordingBroadcaster(),
      new FixedRechecker(),
      reconciler
    )
    await outbox.prepare(record.recordID, "worker-a")
    await outbox.broadcast(record.recordID)
    const disposition = await outbox.reconcile(record.recordID)
    assert.equal(disposition.status, "generation-required")
    assert.equal(
      disposition.preparationSender,
      normalizeKey(TRANSACTION_SENDER)
    )
    assert.equal(disposition.preparedTransactionVariants?.length, 1)
    assert.equal(disposition.lastResolutionStatus, resolution.status)
    assert.match(
      disposition.lastError ?? "",
      /fresh append-only nonce generation/
    )
  }
})

test("external satisfaction retains lane after send until own nonce is final", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const reconciler = new FixedReconciler()
  const broadcaster = new RecordingBroadcaster()
  reconciler.resolution = externalResolution(
    "external-satisfied-awaiting-own-transaction"
  )
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    broadcaster,
    new FixedRechecker(),
    reconciler
  )
  await outbox.prepare(record.recordID, "worker-a")
  await outbox.broadcast(record.recordID)
  const awaiting = await outbox.reconcile(record.recordID)
  assert.equal(awaiting.status, "external-satisfied-awaiting-own-transaction")
  assert.ok(awaiting.preparationSender)

  const rebroadcast = await outbox.broadcast(record.recordID)
  assert.equal(
    rebroadcast.status,
    "external-satisfied-awaiting-own-transaction"
  )
  assert.deepEqual(broadcaster.rawTransactions, [
    RAW_TRANSACTION,
    RAW_TRANSACTION,
  ])

  const satisfiedBase = externalResolution()
  const { canonicalAttestations: _ignored, ...satisfiedEvidence } =
    satisfiedBase
  const satisfied = withCanonicalAttestations({
    ...satisfiedEvidence,
    ownTransactionDisposition: {
      status: "reverted",
      receipt: {
        transactionHash: TRANSACTION_HASH,
        status: 0,
        blockNumber: 102,
        blockHash: `0x${"19".repeat(32)}`,
      },
    },
  } as Parameters<typeof withCanonicalAttestations>[0])
  reconciler.resolution = satisfied
  const terminal = await outbox.reconcile(record.recordID)
  assert.equal(terminal.status, "satisfied-external")
  assert.equal(terminal.preparationSender, normalizeKey(TRANSACTION_SENDER))
})

test("accepts a canonical external challenge after the deposit is lowered", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const reconciler = new FixedReconciler()
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    reconciler
  )
  await outbox.prepare(record.recordID, "worker-a")
  await outbox.broadcast(record.recordID)
  const external = externalResolution("satisfied-external", "1200")
  const { canonicalAttestations: _ignored, ...externalEvidence } = external
  reconciler.resolution = withCanonicalAttestations({
    ...externalEvidence,
    ownTransactionDisposition: {
      status: "reverted",
      receipt: {
        transactionHash: TRANSACTION_HASH,
        status: 0,
        blockNumber: 102,
        blockHash: `0x${"19".repeat(32)}`,
      },
    },
  } as Parameters<typeof withCanonicalAttestations>[0])

  const satisfied = await outbox.reconcile(record.recordID)

  assert.equal(satisfied.status, "satisfied-external")
})

test("leaked prepared bytes retain the lane after external satisfaction", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const reconciler = new FixedReconciler()
  reconciler.resolution = externalResolution(
    "external-satisfied-awaiting-own-transaction"
  )
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    reconciler
  )
  await outbox.prepare(record.recordID, "worker-a")
  const result = await outbox.reconcile(record.recordID)
  assert.equal(result.status, "external-satisfied-awaiting-own-transaction")
  assert.ok(result.preparationSender)

  const next = await enqueue(store, createIntent("ab"))
  const blocked = await outbox.prepare(next.recordID, "worker-b")
  assert.equal(blocked.status, "queued")
})

test("bounds lease timestamps, owners, and recovery page size", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const outbox = dispatcher(store)
  await assert.rejects(
    outbox.prepare(record.recordID, "x".repeat(129)),
    /exceeds 128 characters/
  )

  const overflowStore = new InMemoryOutboxStore()
  const overflowRecord = await enqueue(overflowStore)
  const overflowOutbox = dispatcher(
    overflowStore,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => Number.MAX_SAFE_INTEGER
  )
  await assert.rejects(
    overflowOutbox.prepare(overflowRecord.recordID, "worker"),
    /overflows the safe integer range/
  )
  assert.throws(
    () =>
      dispatcher(
        store,
        new FixedPreparer(),
        new RecordingBroadcaster(),
        new FixedRechecker(),
        new FixedReconciler(),
        () => 2_000,
        1_001
      ),
    /must not exceed 1000/
  )
})

test("quarantines legacy submission ambiguity and blocks post-send cancellation", async () => {
  const store = new InMemoryOutboxStore()
  const legacyRecord = {
    observationID: Hex.from(CHALLENGE_KEY),
    status: "submitting" as const,
    submissionAttempts: 1,
    challengeTxHash: Hex.from(`0x${"09".repeat(32)}`),
  } as P2TRWatchtowerChallengeRecord
  const quarantines = await quarantineLegacyP2TRSignatureFraudSubmissions(
    {
      async listChallengeRecords() {
        return [legacyRecord]
      },
    },
    store,
    3_000
  )
  assert.equal(quarantines.length, 1)
  assert.match(store.quarantines[0].reason, /must never be retried/)

  const record = await enqueue(store)
  const outbox = dispatcher(store)
  await outbox.prepare(record.recordID, "worker-a")
  await outbox.broadcast(record.recordID)
  await assert.rejects(
    outbox.cancelBeforeBroadcast(record.recordID, "operator request"),
    /only before signer invocation/
  )
})
