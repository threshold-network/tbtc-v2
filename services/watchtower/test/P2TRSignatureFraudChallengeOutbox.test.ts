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
  P2TRSignatureFraudPreparedNonceBurnTransaction,
  P2TRSignatureFraudNonceBurnEnvelope,
  P2TRSignatureFraudSignerInvocationRequest,
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
  P2TRSignatureFraudIndependentSignerBoundaryResolution,
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
  P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH,
  P2TR_SIGNATURE_FRAUD_OUTBOX_MIN_FINALITY_CONFIRMATION_BLOCKS,
  computeP2TRSignatureFraudEthereumEligibilityReadSetHash,
  computeP2TRSignatureFraudChallengeFeePolicyHash,
  computeP2TRSignatureFraudCancellationEvidenceHash,
  computeP2TRSignatureFraudCanonicalCandidateDigest,
  computeP2TRSignatureFraudCanonicalEventSetHash,
  computeP2TRSignatureFraudCanonicalProvenanceFingerprint,
  computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash,
  computeP2TRSignatureFraudOutboxRecordID,
  computeP2TRSignatureFraudOutboxSeriesID,
  computeP2TRSignatureFraudLegacyV4SignerBoundaryResolutionEvidenceDigest,
  computeP2TRSignatureFraudLegacySignerInvocationID,
  computeP2TRSignatureFraudNonceReleaseRequestID,
  computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest,
  computeP2TRSignatureFraudResolutionEvidenceDigest,
  computeP2TRSignatureFraudSignerBoundaryResolutionEvidenceDigest,
  invalidateP2TRSignatureFraudCanonicalProvenance,
  quarantineLegacyP2TRSignatureFraudSubmissions,
  validateP2TRSignatureFraudIndependentSignerBoundaryResolution,
  validateP2TRSignatureFraudLegacyV4SignerBoundaryResolutionReplay,
} from "../src/P2TRSignatureFraudChallengeOutbox.js"
import {
  computeP2TRSignatureFraudSignerInvocationID,
  computeP2TRSignatureFraudSignerInvocationRequest,
} from "../src/P2TRSignatureFraudIrreversibleBoundaryAuthorization.js"
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
  signingKeyOrOverrides:
    | string
    | Partial<{
        chainId: number
        nonce: number
        to: string | null
        value: number
        data: string
      }> = {}
) => {
  const signingKey =
    typeof signingKeyOrOverrides === "string"
      ? signingKeyOrOverrides
      : `0x${"42".repeat(32)}`
  const overrides =
    typeof signingKeyOrOverrides === "string" ? {} : signingKeyOrOverrides
  const wallet = new Wallet(signingKey)
  const transaction = {
    type: 2,
    chainId: overrides.chainId ?? 11155111,
    nonce: overrides.nonce ?? 7,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit: 1_000_000,
    to:
      overrides.to === undefined
        ? ROUTER_ADDRESS
        : overrides.to === null
        ? undefined
        : overrides.to,
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

const signEIP7702TestChallengeTransaction = (calldata: string) => {
  const wallet = new Wallet(`0x${"42".repeat(32)}`)
  const authority = new Wallet(`0x${"43".repeat(32)}`)
  const quantity = (value: number): string =>
    value === 0 ? "0x" : utils.hexlify(utils.stripZeros(utils.arrayify(value)))
  const authorizationUnsigned = [
    quantity(11155111),
    ROUTER_ADDRESS,
    quantity(0),
  ]
  const authorizationSignature = authority
    ._signingKey()
    .signDigest(
      utils.keccak256(
        utils.concat(["0x05", utils.RLP.encode(authorizationUnsigned)])
      )
    )
  const authorization = [
    ...authorizationUnsigned,
    quantity(authorizationSignature.recoveryParam),
    utils.hexlify(utils.stripZeros(utils.arrayify(authorizationSignature.r))),
    utils.hexlify(utils.stripZeros(utils.arrayify(authorizationSignature.s))),
  ]
  const unsigned = [
    quantity(11155111),
    quantity(7),
    quantity(2),
    quantity(20),
    quantity(1_000_000),
    ROUTER_ADDRESS,
    quantity(1234),
    calldata,
    [],
    [authorization],
  ]
  const signature = wallet
    ._signingKey()
    .signDigest(
      utils.keccak256(utils.concat(["0x04", utils.RLP.encode(unsigned)]))
    )
  const rawTransaction = utils.hexConcat([
    "0x04",
    utils.RLP.encode([
      ...unsigned,
      quantity(signature.recoveryParam),
      utils.hexlify(utils.stripZeros(utils.arrayify(signature.r))),
      utils.hexlify(utils.stripZeros(utils.arrayify(signature.s))),
    ]),
  ])
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
const eip7702SignedTestTransaction = signEIP7702TestChallengeTransaction(
  defaultTestCall.calldata
)

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

/** A lane the signer is never bound to, with deliberately different caps. */
const DECOY_LANE = {
  laneID: "decoy.lane.test",
  signerIdentity: "decoy.signer.test",
  sender: "0x9a9a9A9a9A9a9a9A9A9a9a9a9a9A9a9a9a9A9a9A",
  maxGasLimit: "999999",
  maxFeePerGas: "99",
  maxPriorityFeePerGas: "9",
  maxTotalFeeWei: "99999999",
  minimumReplacementFeeBumpBps: 1000,
}

const feePolicyManifest = (
  leadingLanes: (typeof DECOY_LANE)[] = [],
  activationManifestHash = ACTIVATION_MANIFEST_HASH,
  challengeValueWei = "1234",
  laneOverrides: Partial<
    Omit<
      P2TRSignatureFraudChallengeTransactionFeePolicy,
      "policyHash" | "activationManifestHash" | "chainID" | "challengeValueWei"
    >
  > = {}
) => {
  const withoutHash = {
    activationManifestHash,
    chainID: 11155111,
    challengeValueWei,
    lanes: [
      ...leadingLanes,
      {
        laneID: SIGNER_LANE_ID,
        signerIdentity: SIGNER_IDENTITY,
        sender: TRANSACTION_SENDER,
        maxGasLimit: "1000000",
        maxFeePerGas: "100",
        maxPriorityFeePerGas: "10",
        maxTotalFeeWei: "100000000",
        minimumReplacementFeeBumpBps: 1000,
        ...laneOverrides,
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
  readonly laneID: string = SIGNER_LANE_ID
  readonly signerIdentity: string = SIGNER_IDENTITY
  readonly transactionSender: string = TRANSACTION_SENDER
  readonly wallet = new Wallet(`0x${"42".repeat(32)}`)
  calls = 0
  replacementCalls = 0
  readonly initialInvocationIDs: string[] = []
  readonly replacementInvocationIDs: string[] = []
  readonly tombstonedInvocationIDs = new Set<string>()
  reservationCalls = 0
  releasedReservations: string[] = []
  readonly acknowledgedReleaseRequests = new Set<string>()
  readonly invocations: P2TRSignatureFraudSignerInvocationRequest[] = []
  burnCalls = 0
  /** Levers for a signer that returns something other than a burn. */
  burnRecipient?: string
  burnData?: string
  burnValue?: number
  burnNonce?: number
  /** Lets a crossed signer response declare its authenticated actual sender. */
  returnedSender?: string
  /** Lets a test return an echo other than the one the signer was handed. */
  echoInvocation?: (
    invocation: P2TRSignatureFraudSignerInvocationRequest
  ) => P2TRSignatureFraudSignerInvocationRequest | undefined
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
  afterBurnSign?: (
    prepared: P2TRSignatureFraudPreparedNonceBurnTransaction
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
      ? ("already-released" as const)
      : ("released" as const)
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
    invocation: P2TRSignatureFraudSignerInvocationRequest
  ): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    this.calls++
    this.invocations.push(invocation)
    this.initialInvocationIDs.push(invocation.invocationID.toPrefixedString())
    await Promise.resolve()
    const prepared = await this.authenticateResponse(
      {
        intentID: intent.intentID,
        rawTransaction: this.rawTransaction,
        transactionHash: Hex.from(this.transactionHash),
        sender: this.returnedSender ?? this.transactionSender,
        nonce: 7,
        invocation:
          this.echoInvocation === undefined
            ? invocation
            : this.echoInvocation(invocation),
      },
      invocation.invocationID,
      invocation.requestDigest
    )
    await this.afterInitialSign?.(prepared)
    return this.mutateInitialResponse?.(prepared) ?? prepared
  }

  /** Signs a genuine self-transfer; the wallet IS the configured lane sender. */
  async prepareSignatureFraudNonceBurnTransaction(
    _reservation: P2TRSignatureFraudBoundNonceReservation,
    envelope: P2TRSignatureFraudNonceBurnEnvelope,
    invocation: P2TRSignatureFraudSignerInvocationRequest
  ): Promise<P2TRSignatureFraudPreparedNonceBurnTransaction> {
    this.burnCalls++
    this.invocations.push(invocation)
    const rawTransaction = await this.wallet.signTransaction({
      type: 2,
      to: this.burnRecipient ?? envelope.sender,
      data: this.burnData ?? "0x",
      value: this.burnValue ?? 0,
      chainId: envelope.chainID,
      nonce: this.burnNonce ?? envelope.nonce,
      gasLimit: 21000,
      maxFeePerGas: envelope.maxFeePerGas,
      maxPriorityFeePerGas: envelope.maxPriorityFeePerGas,
    })
    const parsed = utils.parseTransaction(rawTransaction)
    const prepared = {
      rawTransaction,
      transactionHash: Hex.from(parsed.hash!),
      sender: this.wallet.address,
      nonce: parsed.nonce,
      gasLimit: parsed.gasLimit.toString(),
      maxFeePerGas: parsed.maxFeePerGas!.toString(),
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas!.toString(),
      invocation:
        this.echoInvocation === undefined
          ? invocation
          : this.echoInvocation(invocation),
    }
    await this.afterBurnSign?.(prepared)
    return prepared
  }

  async prepareSignatureFraudChallengeReplacementTransaction(
    intent: P2TRSignatureFraudSubmissionIntent,
    _reservation: P2TRSignatureFraudBoundNonceReservation,
    _previous: P2TRSignatureFraudPreparedChallengeTransaction,
    _feePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy,
    invocation: P2TRSignatureFraudSignerInvocationRequest
  ): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    this.replacementCalls++
    this.invocations.push(invocation)
    this.replacementInvocationIDs.push(
      invocation.invocationID.toPrefixedString()
    )
    await Promise.resolve()
    const prepared = await this.authenticateResponse(
      {
        intentID: intent.intentID,
        rawTransaction: this.replacementRawTransaction,
        transactionHash: Hex.from(this.replacementTransactionHash),
        sender: TRANSACTION_SENDER,
        nonce: 7,
        invocation:
          this.echoInvocation === undefined
            ? invocation
            : this.echoInvocation(invocation),
      },
      invocation.invocationID,
      invocation.requestDigest
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
    invocation: P2TRSignatureFraudSignerInvocationRequest
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
        invocation,
      },
      invocation.invocationID,
      invocation.requestDigest
    )
  }

  override async prepareSignatureFraudChallengeTransaction(
    intent: P2TRSignatureFraudSubmissionIntent,
    _reservation: P2TRSignatureFraudBoundNonceReservation,
    _feePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy,
    invocation: P2TRSignatureFraudSignerInvocationRequest
  ): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    this.calls++
    return this.sign(
      intent,
      this.initialGasLimit,
      this.initialMaxFeePerGas,
      this.initialPriorityFeePerGas,
      this.initialValue,
      invocation
    )
  }

  override async prepareSignatureFraudChallengeReplacementTransaction(
    intent: P2TRSignatureFraudSubmissionIntent,
    _reservation: P2TRSignatureFraudBoundNonceReservation,
    _previous: P2TRSignatureFraudPreparedChallengeTransaction,
    _feePolicy: P2TRSignatureFraudChallengeTransactionFeePolicy,
    invocation: P2TRSignatureFraudSignerInvocationRequest
  ): Promise<P2TRSignatureFraudPreparedChallengeTransactionResponse> {
    this.replacementCalls++
    return this.sign(
      intent,
      this.replacementGasLimit,
      this.replacementMaxFeePerGas,
      this.replacementPriorityFeePerGas,
      this.initialValue,
      invocation
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
  returnedHash?: string
  inspectDurableBoundary?: () => Promise<void>

  async broadcastRawTransaction(rawTransaction: string): Promise<string> {
    await this.inspectDurableBoundary?.()
    this.rawTransactions.push(rawTransaction)
    if (this.throwAfterSend !== undefined) throw this.throwAfterSend
    return this.returnedHash ?? utils.keccak256(rawTransaction)
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
  readonly finalityConfirmationBlocks = 64
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
    observationID: completeCall.identity,
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
  evidence = evidenceCheckpoint(),
  policy = feePolicyManifest()
): P2TRSignatureFraudChallengeOutboxRecord => {
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

/**
 * A second nonce lane. `validateSignerLanes` requires a distinct lane ID,
 * signer identity and sender, and the reservation is EIP-712 signed by the
 * sender itself, so the lane needs its own wallet and must take its address as
 * the sender.
 */
const SECOND_LANE_SIGNING_KEY = `0x${"43".repeat(32)}`
const SECOND_LANE_WALLET = new Wallet(SECOND_LANE_SIGNING_KEY)
// The blob must carry the calldata of the intent it will be bound to, so lane B
// signs the second test intent's call, not the default one.
const SECOND_INTENT_SEED = "bb"
const secondIntentCall = completeV2TestCall(
  `0x${SECOND_INTENT_SEED.repeat(32)}`
)
const secondLaneSignedTransaction = signTestChallengeTransaction(
  secondIntentCall.calldata,
  20,
  2,
  SECOND_LANE_SIGNING_KEY
)
const secondLaneReplacementTransaction = signTestChallengeTransaction(
  secondIntentCall.calldata,
  40,
  4,
  SECOND_LANE_SIGNING_KEY
)
const SECOND_TRANSACTION_SENDER = SECOND_LANE_WALLET.address
const SECOND_SIGNER_LANE_ID = "lane.b.test"
const SECOND_SIGNER_IDENTITY = "signer.b.test"

class SecondLanePreparer extends FixedPreparer {
  readonly laneID = SECOND_SIGNER_LANE_ID
  readonly signerIdentity = SECOND_SIGNER_IDENTITY
  readonly transactionSender = SECOND_TRANSACTION_SENDER
  readonly wallet = SECOND_LANE_WALLET
  rawTransaction = secondLaneSignedTransaction.rawTransaction
  transactionHash = secondLaneSignedTransaction.transactionHash
  replacementRawTransaction = secondLaneReplacementTransaction.rawTransaction
  replacementTransactionHash = secondLaneReplacementTransaction.transactionHash
}

const twoLaneFeePolicyManifest = () =>
  feePolicyManifest([
    {
      laneID: SECOND_SIGNER_LANE_ID,
      signerIdentity: SECOND_SIGNER_IDENTITY,
      sender: SECOND_TRANSACTION_SENDER,
      maxGasLimit: "1000000",
      maxFeePerGas: "100",
      maxPriorityFeePerGas: "10",
      maxTotalFeeWei: "100000000",
      minimumReplacementFeeBumpBps: 1000,
    },
  ])

const enqueue = async (
  store: InMemoryOutboxStore,
  intent = createIntent(),
  policy = feePolicyManifest()
): Promise<P2TRSignatureFraudChallengeOutboxRecord> =>
  store.insertGenerationIfAbsent(
    createRecord(intent, evidenceCheckpoint(), policy)
  )

class LostPreIOCommitStore extends InMemoryOutboxStore {
  loseNextSignerBoundaryCommit = false
  loseNextNonceReleaseBoundaryCommit = false
  failSignerBoundaryDeterministically?: Error
  failNonceReleaseBoundaryDeterministically?: Error
  retryableReadFailuresAfterLostSignerCommit = 0
  private retryableReadFailuresRemaining = 0
  signerBoundaryAttempts = 0
  nonceReleaseBoundaryAttempts = 0

  override async get(
    recordID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    if (this.retryableReadFailuresRemaining > 0) {
      this.retryableReadFailuresRemaining--
      const error = new Error("durable boundary reload response lost")
      this.retryablePersistenceErrors.add(error)
      throw error
    }
    return super.get(recordID)
  }

  override async compareAndSwapWithCurrentCanonicalProvenance(
    recordID: string,
    expectedVersion: number,
    expectedProvenance: P2TRSignatureFraudCanonicalProvenanceBinding,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    if (next.activeSignerInvocationStartedAtUnixMs !== undefined) {
      this.signerBoundaryAttempts++
      if (this.failSignerBoundaryDeterministically !== undefined) {
        throw this.failSignerBoundaryDeterministically
      }
    }
    const persisted = await super.compareAndSwapWithCurrentCanonicalProvenance(
      recordID,
      expectedVersion,
      expectedProvenance,
      next
    )
    if (
      persisted &&
      this.loseNextSignerBoundaryCommit &&
      next.activeSignerInvocationStartedAtUnixMs !== undefined
    ) {
      this.loseNextSignerBoundaryCommit = false
      this.retryableReadFailuresRemaining =
        this.retryableReadFailuresAfterLostSignerCommit
      const error = new Error("signer-boundary commit response lost")
      this.retryablePersistenceErrors.add(error)
      throw error
    }
    return persisted
  }

  override async beginNonceReleaseAttempt(
    attempt: P2TRSignatureFraudNonceReleaseAttempt,
    invokedAtUnixMs: number
  ): Promise<boolean> {
    this.nonceReleaseBoundaryAttempts++
    if (this.failNonceReleaseBoundaryDeterministically !== undefined) {
      throw this.failNonceReleaseBoundaryDeterministically
    }
    const persisted = await super.beginNonceReleaseAttempt(
      attempt,
      invokedAtUnixMs
    )
    if (persisted && this.loseNextNonceReleaseBoundaryCommit) {
      this.loseNextNonceReleaseBoundaryCommit = false
      const error = new Error("nonce-release commit response lost")
      this.retryablePersistenceErrors.add(error)
      throw error
    }
    return persisted
  }
}

const provenanceInvalidationEvidence = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  invalidatedAtUnixMs = 2_000,
  observationID: Hex | string = record.intent.observationID
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
    observationID:
      observationID instanceof Hex
        ? observationID.toPrefixedString()
        : observationID,
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
  boundaryAuthorizer = new FixedBoundaryAuthorizer(),
  minimumRebroadcastIntervalMs = 0
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
      minimumRebroadcastIntervalMs,
      recoveryPageSize,
      onRecoveryBacklog,
      now,
    }
  )

const withCanonicalAttestations = <
  Resolution extends Exclude<
    P2TRSignatureFraudChallengeOutboxResolution,
    { status: "pending" | "unknown" }
  >
>(
  resolution: Omit<Resolution, "canonicalAttestations">
): Resolution => {
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
  } as unknown as Resolution
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
      blockNumber: 172,
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
    const occurrenceID = Hex.from(`0x${"70".repeat(32)}`)
    assert.equal(
      observation.observationID.toString(),
      observation.bridgeChallengeKey?.toString()
    )
    assert.notEqual(
      occurrenceID.toString(),
      observation.observationID.toString()
    )
    const challengeRecord = {
      observationID: occurrenceID,
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
        occurrenceID,
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
      [],
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

test("enqueues an SDK-extracted challenge-key observation from a distinct occurrence", async () => {
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
  assert.notEqual(
    first.intent.observationID.toString(),
    observationID.toString()
  )
  assert.equal(
    first.intent.observationID.toString(),
    first.intent.bridgeChallengeKey.toString()
  )
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
    provenanceInvalidationEvidence(first, 2_000, observationID)
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
  // Naming the variant keeps the literal narrow: inferring it back out of
  // `Omit<Resolution, ...>` is not reliable.
  const disposition = withCanonicalAttestations<
    Extract<
      P2TRSignatureFraudChallengeOutboxResolution,
      { status: "terminal-reverted" }
    >
  >({
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
  })
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
  const disposition = withCanonicalAttestations<
    Extract<
      P2TRSignatureFraudChallengeOutboxResolution,
      { status: "terminal-reverted" }
    >
  >({
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
  })
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
    isP2TRSignatureFraudWatchtowerTransactionOutcomeUnknown() {
      return false
    },
    isP2TRSignatureFraudWatchtowerTransactionConfirmedPreCommitTransportAbort() {
      return false
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
    async resolveCandidateEnqueueRetryExhaustionAlert() {},
    async resolveCandidateEnqueueManifestRotationDisposition() {},
    async saveCandidateEnqueueNonRetryableFailure() {},
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
      return challengeScheduler.enqueueConfirmedChallenge(observationID, 2_000)
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
    /finality confirmation depth must be at least 64 blocks/
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

test("authorizes exact signer and projected pre-CAS broadcast boundaries", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const broadcaster = new RecordingBroadcaster()
  const authorizer = new FixedBoundaryAuthorizer()
  const consumedStages: string[] = []
  authorizer.beforeAuthorize = async (binding) => {
    const durable = await store.get(binding.recordID)
    assert.ok(durable)
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
    // The lane, the intent, and the lane's fee envelope are what the signer is
    // actually handed; each must be named by the authorized boundary.
    assert.equal(durable.reservedNonce?.laneID, binding.laneID)
    assert.equal(durable.reservedNonce?.signerIdentity, binding.signerIdentity)
    assert.equal(normalizeKey(durable.intent.intentID), binding.intentID)
    assert.equal(
      normalizeKey(durable.intent.routerAddress),
      binding.routerAddress
    )
    assert.equal(durable.intent.value, binding.intentValueWei)
    assert.equal(
      durable.feePolicyManifest.challengeValueWei,
      binding.challengeValueWei
    )
    // Looked up by identity, never by array position: the bound lane is the
    // reserved one, which need not be the manifest's first.
    const lane = durable.feePolicyManifest.lanes.find(
      (candidate) =>
        candidate.laneID === binding.laneID &&
        candidate.signerIdentity === binding.signerIdentity
    )
    assert.ok(lane, "the bound lane must exist in the durable manifest")
    assert.equal(lane.maxGasLimit, binding.maxGasLimit)
    assert.equal(lane.maxFeePerGas, binding.maxFeePerGas)
    assert.equal(lane.maxPriorityFeePerGas, binding.maxPriorityFeePerGas)
    assert.equal(lane.maxTotalFeeWei, binding.maxTotalFeeWei)
    if (binding.stage === "replacement") {
      // The variant being superseded, not the one about to be produced.
      assert.equal(
        durable.preparedTransaction === undefined
          ? undefined
          : normalizeKey(durable.preparedTransaction.transactionHash),
        binding.replacedTransactionHash
      )
    } else {
      assert.equal(binding.replacedTransactionHash, undefined)
    }
    if (binding.stage === "broadcast") {
      assert.equal(durable.status, "prepared")
      assert.equal(durable.version + 1, binding.recordVersion)
      assert.equal(durable.broadcastAttempts + 1, binding.attempt)
      assert.equal(
        durable.preparedTransaction === undefined
          ? undefined
          : normalizeKey(durable.preparedTransaction.transactionHash),
        binding.preparedTransactionHash
      )
    } else {
      assert.equal(durable.version, binding.recordVersion)
      assert.equal(durable.status, "preparing")
      assert.equal(
        durable.activeSignerInvocationStartedAtUnixMs !== undefined,
        true
      )
      assert.equal(durable.preparationAttempts, binding.attempt)
      assert.equal(binding.preparedTransactionHash, undefined)
    }
  }
  authorizer.onConsume = (binding) => {
    if (binding.stage === "broadcast") {
      const durable = store.records.get(normalizeKey(binding.recordID))
      assert.equal(durable?.status, "broadcast-pending")
      assert.equal(durable?.version, binding.recordVersion)
      assert.equal(durable?.broadcastAttempts, binding.attempt)
    }
    consumedStages.push(binding.stage)
  }
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
      ({
        stage,
        attempt,
        replacedTransactionHash,
        preparedTransactionHash,
      }) => ({
        stage,
        attempt,
        replacedTransactionHash,
        preparedTransactionHash,
      })
    ),
    [
      {
        stage: "prepare",
        attempt: 1,
        replacedTransactionHash: undefined,
        preparedTransactionHash: undefined,
      },
      {
        stage: "replacement",
        attempt: 2,
        replacedTransactionHash: TRANSACTION_HASH.toLowerCase(),
        preparedTransactionHash: undefined,
      },
      {
        stage: "broadcast",
        attempt: 1,
        replacedTransactionHash: undefined,
        preparedTransactionHash: REPLACEMENT_TRANSACTION_HASH.toLowerCase(),
      },
    ]
  )

  // Every lane/intent/fee field the boundary now names, at every stage.
  for (const binding of authorizer.bindings) {
    assert.equal(binding.laneID, SIGNER_LANE_ID)
    assert.equal(binding.signerIdentity, SIGNER_IDENTITY)
    assert.equal(binding.routerAddress, ROUTER_ADDRESS.toLowerCase())
    assert.equal(binding.intentValueWei, "1234")
    assert.equal(binding.challengeValueWei, "1234")
    assert.equal(binding.maxGasLimit, "1000000")
    assert.equal(binding.maxFeePerGas, "100")
    assert.equal(binding.maxPriorityFeePerGas, "10")
    assert.equal(binding.maxTotalFeeWei, "100000000")
  }
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

test("retires an initial signer boundary whose commit response is lost before I/O", async () => {
  const store = new LostPreIOCommitStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  store.loseNextSignerBoundaryCommit = true
  store.retryableReadFailuresAfterLostSignerCommit = 2

  const result = await dispatcher(store, preparer).prepare(
    record.recordID,
    "worker-a"
  )

  assert.equal(result.status, "preparing")
  assert.equal(result.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(result.signerInvocationStartedAtUnixMs, undefined)
  assert.equal(preparer.calls, 0)
  assert.match(result.lastError ?? "", /persistence was ambiguous/)
})

test("retires a replacement signer boundary whose commit response is lost before I/O", async () => {
  const store = new LostPreIOCommitStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const outbox = dispatcher(store, preparer)
  assert.equal(
    (await outbox.prepare(record.recordID, "worker-a")).status,
    "prepared"
  )
  store.loseNextSignerBoundaryCommit = true
  store.retryableReadFailuresAfterLostSignerCommit = 2

  const result = await outbox.prepareReplacement(record.recordID, "worker-b")

  assert.equal(result.status, "prepared")
  assert.equal(result.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(result.preparationLease, undefined)
  assert.equal(result.preparedTransactionVariants?.length, 1)
  assert.equal(preparer.replacementCalls, 0)
  assert.match(result.lastError ?? "", /persistence was ambiguous/)
})

test("propagates a deterministic signer-boundary failure without retrying", async () => {
  const store = new LostPreIOCommitStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const failure = new Error("signer boundary constraint rejected")
  store.failSignerBoundaryDeterministically = failure

  await assert.rejects(
    dispatcher(store, preparer).prepare(record.recordID, "worker-a"),
    (error: unknown) => error === failure
  )

  assert.equal(store.signerBoundaryAttempts, 1)
  assert.equal(preparer.calls, 0)
  assert.equal(
    (await store.get(record.recordID))?.activeSignerInvocationStartedAtUnixMs,
    undefined
  )
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

test("keeps unresolved recovery work scoped to its exact nonce lane", async () => {
  const store = new InMemoryOutboxStore()
  const foreignReleaseRecord = await enqueue(store, createIntent("ac"))
  const foreignExpiredRecord = await enqueue(store, createIntent("ad"))
  const target = await enqueue(store)
  const preparer = new FixedPreparer()
  const foreignSender = "0x3333333333333333333333333333333333333333"
  const foreignReservation = {
    ...(await preparer.reserveSignatureFraudChallengeNonce(
      foreignReleaseRecord.intent,
      Hex.from(foreignReleaseRecord.recordID),
      foreignReleaseRecord.generation,
      1
    )),
    laneID: "lane.foreign",
    signerIdentity: "signer.foreign",
    sender: foreignSender,
  }
  const releaseRequestID = `0x${"91".repeat(32)}`
  store.nonceReleaseRequests.set(releaseRequestID, {
    releaseRequestID,
    recordID: foreignReleaseRecord.recordID,
    generation: foreignReleaseRecord.generation,
    reservation: foreignReservation,
    voidEvidenceDigest: `0x${"92".repeat(32)}`,
    requestedAtUnixMs: 2_000,
    attemptCount: 0,
    ambiguous: false,
  })
  store.records.set(normalizeKey(foreignExpiredRecord.recordID), {
    ...foreignExpiredRecord,
    status: "preparing",
    version: foreignExpiredRecord.version + 1,
    preparationAttempts: 1,
    preparationLease: { owner: "foreign-worker", expiresAtUnixMs: 3_000 },
    preparationSender: foreignSender,
    selectedLaneID: "lane.foreign",
    selectedSignerIdentity: "signer.foreign",
    updatedAtUnixMs: 2_000,
  })

  const prepared = await dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => 40_000
  ).prepare(target.recordID, "target-worker")

  assert.equal(prepared.status, "prepared", prepared.lastError)
  assert.equal(preparer.calls, 1)
  assert.equal(await store.hasPendingNonceReleases(), true)
  assert.equal(
    await store.hasPendingNonceReleasesForLane(
      target.intent.chainID,
      preparer.transactionSender
    ),
    false
  )
  assert.equal(
    await store.hasExpiredPreparationLeasesForLane(
      target.intent.chainID,
      preparer.transactionSender,
      40_000
    ),
    false
  )
})

test("re-sweeps lane recovery after backlog appears post-startup", async () => {
  const store = new InMemoryOutboxStore()
  const expiredRecord = await enqueue(store, createIntent("ae"))
  const target = await enqueue(store)
  const preparer = new FixedPreparer()
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => 40_000
  )

  // Establish the process-local startup barrier before the later lease exists.
  await outbox.recoverExpiredPreparationLeases()
  store.records.set(normalizeKey(expiredRecord.recordID), {
    ...expiredRecord,
    status: "preparing",
    version: expiredRecord.version + 1,
    preparationAttempts: 1,
    preparationLease: { owner: "stalled-worker", expiresAtUnixMs: 3_000 },
    preparationSender: preparer.transactionSender,
    selectedLaneID: preparer.laneID,
    selectedSignerIdentity: preparer.signerIdentity,
    updatedAtUnixMs: 2_000,
  })

  const skipped = await outbox.prepare(target.recordID, "target-worker")
  assert.equal(skipped.status, "queued")
  assert.equal((await store.get(expiredRecord.recordID))?.status, "preparing")

  const prepared = await outbox.prepare(target.recordID, "target-worker")
  assert.equal(prepared.status, "prepared", prepared.lastError)
  assert.equal((await store.get(expiredRecord.recordID))?.status, "queued")
  assert.equal(preparer.calls, 1)
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

test("recovers one ambiguous nonce-release invocation per lane in stable order", async () => {
  const store = new InMemoryOutboxStore()
  const laneInputs = [
    {
      record: await enqueue(store),
      preparer: new FixedPreparer(),
    },
    {
      record: await enqueue(
        store,
        createIntent(SECOND_INTENT_SEED),
        twoLaneFeePolicyManifest()
      ),
      preparer: new SecondLanePreparer(),
    },
  ]
  const lanes = await Promise.all(
    laneInputs.map(async ({ record, preparer }, index) => {
      const reservation = await preparer.reserveSignatureFraudChallengeNonce(
        record.intent,
        Hex.from(record.recordID),
        record.generation,
        1
      )
      const voidEvidenceDigest = `0x${(94 + index).toString(16).repeat(32)}`
      const releaseRequestID = normalizeKey(
        computeP2TRSignatureFraudNonceReleaseRequestID(
          record.recordID,
          reservation.reservationID,
          voidEvidenceDigest
        )
      )
      return {
        record,
        reservation,
        voidEvidenceDigest,
        releaseRequestID,
        laneOrder: `${
          record.intent.chainID
        }:${reservation.sender.toLowerCase()}`,
      }
    })
  )

  // Insert in reverse lane order to prove selection does not depend on Map
  // insertion order. Both resultless invocations are recoverable at `now`.
  for (const lane of [...lanes].sort((left, right) =>
    right.laneOrder.localeCompare(left.laneOrder)
  )) {
    store.nonceReleaseRequests.set(lane.releaseRequestID, {
      releaseRequestID: lane.releaseRequestID,
      recordID: lane.record.recordID,
      generation: lane.record.generation,
      reservation: lane.reservation,
      voidEvidenceDigest: lane.voidEvidenceDigest,
      requestedAtUnixMs: 1_000,
      attemptCount: 0,
      ambiguous: false,
    })
    const attempt = await store.claimNonceReleaseAttempt(
      lane.releaseRequestID,
      `worker-${lane.reservation.laneID}`,
      1_100,
      2_000
    )
    assert.ok(attempt)
    assert.equal(await store.beginNonceReleaseAttempt(attempt, 1_101), true)
  }

  const ordered = [...lanes].sort((left, right) =>
    left.laneOrder.localeCompare(right.laneOrder)
  )
  const first = await store.getActiveAmbiguousNonceReleaseInvocation(2_000)
  assert.equal(first?.request.releaseRequestID, ordered[0].releaseRequestID)
  assert.equal(
    (await store.getActiveAmbiguousNonceReleaseInvocation(2_000))?.request
      .releaseRequestID,
    ordered[0].releaseRequestID
  )

  store.nonceReleaseResolutions.set(
    `${ordered[0].releaseRequestID}:1`,
    "already-released"
  )
  const second = await store.getActiveAmbiguousNonceReleaseInvocation(2_000)
  assert.equal(second?.request.releaseRequestID, ordered[1].releaseRequestID)
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
  assert.equal(await store.beginNonceReleaseAttempt(attempt, 2_101), true)
  assert.equal(await store.beginNonceReleaseAttempt(attempt, 2_102), false)

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

test("invokes the allocator after reconciling a lost nonce-release marker response", async () => {
  const store = new LostPreIOCommitStore()
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
  store.loseNextNonceReleaseBoundaryCommit = true
  store.beforeProvenanceCAS = async (_current, next) => {
    if (next.activeSignerInvocationStartedAtUnixMs === undefined) return
    store.beforeProvenanceCAS = undefined
    now = 40_001
    await outbox.recoverExpiredPreparationLeases()
  }

  const result = await outbox.prepare(record.recordID, "worker-a")

  assert.equal(result.status, "queued")
  assert.equal(await store.hasPendingNonceReleases(), false)
  assert.equal(preparer.calls, 0)
  assert.equal(preparer.releasedReservations.length, 1)
})

test("propagates a deterministic nonce-release marker failure without retrying", async () => {
  const store = new LostPreIOCommitStore()
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
  const failure = new Error("nonce release constraint rejected")
  store.failNonceReleaseBoundaryDeterministically = failure
  store.beforeProvenanceCAS = async (_current, next) => {
    if (next.activeSignerInvocationStartedAtUnixMs === undefined) return
    store.beforeProvenanceCAS = undefined
    now = 40_001
    await outbox.recoverExpiredPreparationLeases()
  }

  await assert.rejects(
    outbox.prepare(record.recordID, "worker-a"),
    (error: unknown) => error === failure
  )

  assert.equal(store.nonceReleaseBoundaryAttempts, 1)
  assert.equal(preparer.releasedReservations.length, 0)
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

test("quarantines oversized initial signer metadata before lease expiry", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.rawTransaction = await preparer.wallet.signTransaction({
    type: 2,
    chainId: record.intent.chainID,
    nonce: 7,
    maxPriorityFeePerGas: 10,
    maxFeePerGas: 100,
    gasLimit: 1_000_000,
    to: record.intent.routerAddress,
    value: record.intent.value,
    data: record.intent.calldata,
    accessList: [
      {
        address: record.intent.routerAddress,
        storageKeys: Array.from(
          { length: 130 },
          (_, index) => `0x${index.toString(16).padStart(64, "0")}`
        ),
      },
    ],
  })
  preparer.transactionHash = utils.keccak256(preparer.rawTransaction)
  let now = 2_000
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now
  )

  const captured = await outbox.prepare(record.recordID, "worker-oversized")

  assert.equal(captured.status, "quarantined")
  assert.equal(captured.preparationLease, undefined)
  assert.equal(captured.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(captured.signerInvocationStartedAtUnixMs, 2_000)
  assert.equal(captured.unexpectedSignedArtifacts?.length ?? 0, 0)
  assert.ok(
    ["malformed-signed-envelope", "oversized-signed-envelope"].includes(
      captured.signerQuarantines?.at(-1)?.reasonCode ?? ""
    )
  )

  now = 40_001
  const recovery = await outbox.recoverExpiredPreparationLeases()
  assert.equal(recovery.backlogRemaining, false)
  assert.equal((await store.get(record.recordID))?.status, "quarantined")
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
    signTestChallengeTransaction(defaultTestCall.calldata, 20, 2, {
      to: null,
      data: "0x6000",
      value: 0,
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
    assert.equal(artifact.to, parsed.to ?? undefined)
    assert.equal(artifact.calldata, parsed.data)
    assert.equal(artifact.value, parsed.value.toString())
  }
})

test("terminalizes a captured same-lane artifact that consumed the protected nonce", async () => {
  const signed = signTestChallengeTransaction(defaultTestCall.calldata, 20, 2, {
    to: "0x3333333333333333333333333333333333333333",
  })
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.rawTransaction = signed.rawTransaction
  preparer.transactionHash = signed.transactionHash
  const reconciler = new FixedReconciler()
  const outbox = dispatcher(
    store,
    preparer,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    reconciler
  )

  const quarantined = await outbox.prepare(record.recordID, "worker-a")
  const artifact =
    quarantined.unexpectedSignedArtifacts?.[0]?.preparedTransaction
  assert.equal(quarantined.status, "quarantined")
  assert.ok(artifact)

  reconciler.resolution = withCanonicalAttestations({
    status: "terminal-nonce-consumed",
    observedHead: {
      blockNumber: 172,
      blockHash: `0x${"12".repeat(32)}`,
    },
    finalizedThrough: {
      blockNumber: 108,
      blockHash: `0x${"18".repeat(32)}`,
    },
    consensusFinalized: true,
    routerChallenge: {
      exists: false,
      challengeKey: CHALLENGE_KEY,
      readAtBlock: 108,
    },
    sender: artifact.sender,
    transactionNonce: artifact.nonce,
    finalizedAccountNonce: artifact.nonce + 1,
    accountNonceReadAtBlock: 108,
    transactionAbsent: true,
    consumingTransaction: {
      transactionHash: artifact.transactionHash.toPrefixedString(),
      sender: artifact.sender,
      nonce: artifact.nonce,
      blockNumber: 101,
      blockHash: `0x${"56".repeat(32)}`,
    },
  } as Parameters<typeof withCanonicalAttestations>[0])

  const reconciled = await outbox.reconcile(record.recordID)
  assert.equal(reconciled.status, "generation-required")
  assert.equal(reconciled.lastResolutionStatus, "terminal-nonce-consumed")
  assert.equal(
    reconciled.finalNonceResolution?.status,
    "terminal-nonce-consumed"
  )
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

test("retains and guards EIP-7702 signer bytes before rejecting broadcast policy", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.rawTransaction = eip7702SignedTestTransaction.rawTransaction
  preparer.transactionHash = eip7702SignedTestTransaction.transactionHash
  const outbox = dispatcher(store, preparer)

  const result = await outbox.prepare(record.recordID, "worker-a")
  assert.equal(result.status, "quarantined")
  assert.equal(
    result.preparationSender?.toLowerCase(),
    TRANSACTION_SENDER.toLowerCase()
  )
  assert.equal(result.preparedTransactionVariants, undefined)
  assert.equal(result.unexpectedSignedArtifacts?.length, 1)
  assert.equal(
    normalizeKey(
      result.unexpectedSignedArtifacts![0].preparedTransaction.transactionHash
    ),
    eip7702SignedTestTransaction.transactionHash.toLowerCase()
  )
  assert.match(result.lastError ?? "", /requires an EIP-1559|unsupported/)
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
    expectedInitialInvocationID = boundary!.activeSignerInvocationID
  }
  preparer.afterReplacementSign = async () => {
    const boundary = await store.get(record.recordID)
    expectedReplacementInvocationID = boundary!.activeSignerInvocationID
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
  assert.match(
    quarantined.lastError ?? "",
    /policy-bound transaction-pool fee bump|distinct/
  )
  assert.equal(store.criticalAlerts.at(-1)?.code, "signed-state-quarantined")
})

test("rejects a replacement below the manifest transaction-pool bump", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new DynamicFeePreparer()
  preparer.initialMaxFeePerGas = 50
  preparer.initialPriorityFeePerGas = 5
  preparer.replacementMaxFeePerGas = 51
  preparer.replacementPriorityFeePerGas = 6
  const outbox = dispatcher(store, preparer)

  await outbox.prepare(record.recordID, "worker-a")
  const quarantined = await outbox.prepareReplacement(
    record.recordID,
    "worker-b"
  )

  assert.equal(quarantined.status, "prepared")
  assert.equal(quarantined.preparedTransactionVariants?.length, 1)
  assert.match(
    quarantined.lastError ?? "",
    /policy-bound transaction-pool fee bump/
  )
  assert.equal(store.criticalAlerts.at(-1)?.code, "signed-state-quarantined")
})

test("rejects fee bumps that cannot fit the manifest caps before the signer boundary", async () => {
  for (const testCase of [
    {
      policy: feePolicyManifest(),
      initialMaxFeePerGas: 100,
      initialPriorityFeePerGas: 10,
    },
    {
      policy: feePolicyManifest([], ACTIVATION_MANIFEST_HASH, "1234", {
        maxPriorityFeePerGas: "0",
      }),
      initialMaxFeePerGas: 20,
      initialPriorityFeePerGas: 0,
    },
    {
      policy: feePolicyManifest([], ACTIVATION_MANIFEST_HASH, "1234", {
        maxTotalFeeWei: "50000000",
      }),
      initialMaxFeePerGas: 50,
      initialPriorityFeePerGas: 5,
    },
  ]) {
    const store = new InMemoryOutboxStore()
    const record = await enqueue(store, createIntent(), testCase.policy)
    const preparer = new DynamicFeePreparer()
    preparer.initialMaxFeePerGas = testCase.initialMaxFeePerGas
    preparer.initialPriorityFeePerGas = testCase.initialPriorityFeePerGas
    const outbox = dispatcher(store, preparer)

    await outbox.prepare(record.recordID, "worker-a")
    const rejected = await outbox.prepareReplacement(
      record.recordID,
      "worker-b"
    )

    assert.equal(rejected.status, "prepared")
    assert.equal(rejected.preparedTransactionVariants?.length, 1)
    assert.equal(rejected.preparationAttempts, 1)
    assert.equal(rejected.activeSignerInvocationStartedAtUnixMs, undefined)
    assert.equal(rejected.preparationLease, undefined)
    assert.equal(preparer.replacementCalls, 0)
    assert.equal(store.criticalAlerts.length, 0)
    assert.match(
      rejected.lastError ?? "",
      /impossible.*manifest-bound fee caps/
    )
  }
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

  // A low gas limit can be a perfectly valid EIP-1559 envelope while still
  // guaranteeing an out-of-gas failure after the reserved nonce is consumed.
  // The signer must use the manifest's exact challenge execution budget.
  const underGasStore = new InMemoryOutboxStore()
  const underGasRecord = await enqueue(underGasStore)
  const underGasPreparer = new DynamicFeePreparer()
  underGasPreparer.initialGasLimit = 21_000
  const underGas = await dispatcher(underGasStore, underGasPreparer).prepare(
    underGasRecord.recordID,
    "worker"
  )
  assert.equal(underGas.status, "quarantined")
  assert.match(underGas.lastError ?? "", /exact manifest-bound gas limit/)

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

test("rejects a fee policy whose total cap cannot fund its fixed gas limit", () => {
  assert.throws(
    () =>
      feePolicyManifest([], ACTIVATION_MANIFEST_HASH, "1234", {
        maxGasLimit: "1000000",
        maxTotalFeeWei: "999999",
      }),
    /total fee cannot fund its fixed gas limit/
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

test("does not broadcast when pre-send authorization fails", async () => {
  for (const rejection of ["acquisition", "consumption"] as const) {
    const store = new InMemoryOutboxStore()
    const record = await enqueue(store)
    const broadcaster = new RecordingBroadcaster()
    const authorizer = new FixedBoundaryAuthorizer()
    const outbox = dispatcher(
      store,
      new FixedPreparer(),
      broadcaster,
      new FixedRechecker(),
      new FixedReconciler(),
      () => 2_000,
      100,
      undefined,
      authorizer
    )
    await outbox.prepare(record.recordID, "worker-a")
    if (rejection === "acquisition") {
      authorizer.rejectAuthorization = new Error(
        "evidence provider unavailable"
      )
    } else {
      authorizer.rejectConsumption = new Error("authorization became stale")
    }

    const result = await outbox.broadcast(record.recordID)

    assert.equal(
      result.status,
      rejection === "acquisition" ? "prepared" : "broadcast-pending"
    )
    assert.equal(result.broadcastAttempts, rejection === "acquisition" ? 0 : 1)
    assert.equal(
      result.preparedTransactionVariants?.[0].broadcastAttempts,
      rejection === "acquisition" ? 0 : 1
    )
    assert.equal(
      result.preparedTransactionVariants?.[0].lastBroadcastProviderAccepted,
      rejection === "acquisition" ? undefined : false
    )
    assert.equal(
      result.lastBroadcastProviderAccepted,
      rejection === "acquisition" ? undefined : false
    )
    assert.equal(
      result.lastBroadcastAtUnixMs,
      rejection === "acquisition" ? undefined : 2_000
    )
    assert.equal(result.lastBroadcastAuthorizationFailureAtUnixMs, 2_000)
    assert.equal(broadcaster.rawTransactions.length, 0)
    assert.match(result.lastError ?? "", /authorization .*before send/)
  }
})

test("paces repeated pre-send authorization acquisition failures", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const broadcaster = new RecordingBroadcaster()
  const authorizer = new FixedBoundaryAuthorizer()
  const rechecker = new FixedRechecker()
  let nowUnixMs = 2_000
  let authorizationRequests = 0
  authorizer.beforeAuthorize = async () => {
    authorizationRequests++
  }
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    broadcaster,
    rechecker,
    new FixedReconciler(),
    () => nowUnixMs,
    100,
    undefined,
    authorizer,
    100
  )
  await outbox.prepare(record.recordID, "worker-a")
  authorizationRequests = 0
  rechecker.stages.length = 0
  authorizer.rejectAuthorization = new Error("evidence provider unavailable")

  const first = await outbox.broadcast(record.recordID)
  nowUnixMs = 2_050
  const paced = await outbox.broadcast(record.recordID)

  assert.equal(paced.version, first.version)
  assert.equal(authorizationRequests, 1)
  assert.deepEqual(rechecker.stages, ["before-broadcast"])
  assert.equal(broadcaster.rawTransactions.length, 0)

  nowUnixMs = 2_100
  const retried = await outbox.broadcast(record.recordID)
  assert.equal(retried.version, first.version + 1)
  assert.equal(authorizationRequests, 2)
  assert.deepEqual(rechecker.stages, ["before-broadcast", "before-broadcast"])
})

test("paces persistent pre-broadcast recheck failures", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const rechecker = new FixedRechecker()
  let nowUnixMs = 2_000
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    rechecker,
    new FixedReconciler(),
    () => nowUnixMs,
    100,
    undefined,
    new FixedBoundaryAuthorizer(),
    100
  )
  await outbox.prepare(record.recordID, "worker-a")
  rechecker.stages.length = 0
  rechecker.resolution = {
    status: "unknown",
    reason: "canonical providers are unavailable",
  }

  const first = await outbox.broadcast(record.recordID)
  nowUnixMs = 2_050
  const paced = await outbox.broadcast(record.recordID)

  assert.equal(first.lastPreBroadcastRecheckAtUnixMs, 2_000)
  assert.equal(first.lastPreBroadcastRecheckStatus, "unknown")
  assert.equal(paced.version, first.version)
  assert.deepEqual(rechecker.stages, ["before-broadcast"])

  nowUnixMs = 2_100
  const retried = await outbox.broadcast(record.recordID)
  assert.equal(retried.version, first.version + 1)
  assert.deepEqual(rechecker.stages, ["before-broadcast", "before-broadcast"])
})

test("revalidates broadcast authority after the provenance attempt CAS", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const broadcaster = new RecordingBroadcaster()
  const authorizer = new FixedBoundaryAuthorizer()
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    broadcaster,
    new FixedRechecker(),
    new FixedReconciler(),
    () => 2_000,
    100,
    undefined,
    authorizer
  )
  await outbox.prepare(record.recordID, "worker-a")
  store.beforeProvenanceCAS = async (_current, next) => {
    if (next.status === "broadcast-pending") {
      authorizer.rejectConsumption = new Error(
        "authorization was superseded while the CAS waited"
      )
    }
  }

  const result = await outbox.broadcast(record.recordID)

  assert.equal(result.status, "broadcast-pending")
  assert.equal(result.broadcastAttempts, 1)
  assert.equal(
    result.preparedTransactionVariants?.[0].lastBroadcastProviderAccepted,
    false
  )
  assert.equal(result.lastBroadcastProviderAccepted, false)
  assert.deepEqual(broadcaster.rawTransactions, [])
  assert.match(result.lastError ?? "", /superseded while the CAS waited/)
})

test("paces retries after a rejected post-CAS authorization", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const broadcaster = new RecordingBroadcaster()
  const authorizer = new FixedBoundaryAuthorizer()
  let nowUnixMs = 2_000
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    broadcaster,
    new FixedRechecker(),
    new FixedReconciler(),
    () => nowUnixMs,
    100,
    undefined,
    authorizer,
    30_000
  )
  await outbox.prepare(record.recordID, "worker-a")
  authorizer.rejectConsumption = new Error("authorization expired")

  const rejected = await outbox.broadcast(record.recordID)
  assert.equal(rejected.lastBroadcastProviderAccepted, false)
  assert.deepEqual(broadcaster.rawTransactions, [])
  const authorizationCountAfterRejection = authorizer.bindings.length

  authorizer.rejectConsumption = undefined
  nowUnixMs++
  const paced = await outbox.broadcast(record.recordID)

  assert.equal(paced.broadcastAttempts, 1)
  assert.equal(paced.lastBroadcastProviderAccepted, false)
  assert.equal(authorizer.bindings.length, authorizationCountAfterRejection)
  assert.equal(broadcaster.rawTransactions.length, 0)

  nowUnixMs = 32_000
  const accepted = await outbox.broadcast(record.recordID)

  assert.equal(accepted.broadcastAttempts, 2)
  assert.equal(accepted.lastBroadcastProviderAccepted, true)
  assert.equal(broadcaster.rawTransactions.length, 1)
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
      blockNumber: 172,
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

test("pins the lane identity bound the boundary normalizers mirror", () => {
  // identityText in P2TRReconcilerAttestation.ts and in
  // P2TRSignatureFraudIrreversibleBoundaryAuthorization.ts hardcode this bound
  // rather than import it, because the reconciler wire protocol must not
  // depend on an internal outbox module. Raising it here without updating both
  // would make the outbox accept a lane identity that the digest path rejects,
  // which surfaces only as a boundary authorization failure at run time.
  assert.equal(P2TR_SIGNATURE_FRAUD_OUTBOX_MAX_TRUST_DOMAIN_ID_LENGTH, 128)
})

test("clears the signer marker when the boundary binding cannot be built", async () => {
  const store = new InMemoryOutboxStore()
  // A durable record whose stored intent identity no longer matches its
  // contents: store corruption, a bad migration, or a rolling change to the
  // intent-ID preimage. The boundary recomputes the identity, so the binding
  // cannot be built. That means no signer was invoked, and the pre-I/O marker
  // must be cleared rather than left pinning the record.
  const authentic = createIntent()
  const record = await enqueue(store, {
    ...authentic,
    intentID: createIntent("bb").intentID,
  })
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
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

  const stalled = await outbox.prepare(record.recordID, "worker-a")
  assert.equal(stalled.status, "preparing")
  assert.equal(stalled.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(stalled.signerInvocationStartedAtUnixMs, undefined)
  assert.match(String(stalled.lastError), /durable identity/)
  assert.equal(preparer.calls, 0)
  assert.equal(authorizer.bindings.length, 0)

  now = 40_001
  await outbox.recoverExpiredPreparationLeases()
  const recovered = await store.get(record.recordID)
  assert.equal(recovered?.status, "queued")
  assert.equal(recovered?.reservedNonce, undefined)
})

test("binds the reserved lane's envelope, not the manifest's first lane", async () => {
  const store = new InMemoryOutboxStore()
  // A decoy lane listed FIRST, with different caps. The signer's lane is second.
  // A binding built from the manifest rather than from the envelope handed to
  // the signer would name caps no signer was ever given — which is exactly the
  // gap this binding exists to close.
  const record = await enqueue(
    store,
    createIntent(),
    feePolicyManifest([DECOY_LANE])
  )
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

  assert.equal(
    (await outbox.prepare(record.recordID, "worker-a")).status,
    "prepared"
  )
  assert.equal(record.feePolicyManifest.lanes[0].laneID, DECOY_LANE.laneID)
  const [binding] = authorizer.bindings
  assert.ok(binding)
  assert.equal(binding.laneID, SIGNER_LANE_ID)
  assert.equal(binding.signerIdentity, SIGNER_IDENTITY)
  assert.equal(binding.maxGasLimit, "1000000")
  assert.equal(binding.maxFeePerGas, "100")
  assert.equal(binding.maxPriorityFeePerGas, "10")
  assert.equal(binding.maxTotalFeeWei, "100000000")
})

test("commits a deterministic invocation identity with the signer marker", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  // Observed at the instant the signer is called, i.e. strictly after the swap
  // that made the boundary durable.
  let atSignerCall: P2TRSignatureFraudChallengeOutboxRecord | undefined
  preparer.afterInitialSign = async () => {
    atSignerCall = await store.get(record.recordID)
  }
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

  assert.equal(
    (await outbox.prepare(record.recordID, "worker-a")).status,
    "prepared"
  )
  const [binding] = authorizer.bindings
  assert.ok(binding)
  const expected = computeP2TRSignatureFraudSignerInvocationID(binding)

  // The identity is durable before the signer runs, not written afterwards.
  assert.equal(atSignerCall?.activeSignerInvocationStartedAtUnixMs, 2_000)
  assert.equal(atSignerCall?.activeSignerInvocationID, expected)

  // Deterministic: recomputing from the same binding reproduces it exactly,
  // while any different boundary yields a different identity.
  assert.equal(computeP2TRSignatureFraudSignerInvocationID(binding), expected)
  assert.notEqual(
    computeP2TRSignatureFraudSignerInvocationID({
      ...binding,
      attempt: binding.attempt + 1,
    }),
    expected
  )

  // Cleared with the marker once the signer returns, and promoted to the
  // historical identity so the boundary that ran stays nameable.
  const prepared = await store.get(record.recordID)
  assert.equal(prepared?.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(prepared?.activeSignerInvocationID, undefined)
  assert.equal(prepared?.signerInvocationID, expected)
})

test("gives the replacement boundary its own committed identity", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  const durableAtSign: (P2TRSignatureFraudChallengeOutboxRecord | undefined)[] =
    []
  preparer.afterInitialSign = async () => {
    durableAtSign.push(await store.get(record.recordID))
  }
  preparer.afterReplacementSign = async () => {
    durableAtSign.push(await store.get(record.recordID))
  }
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

  assert.equal(
    (await outbox.prepare(record.recordID, "worker-a")).status,
    "prepared"
  )
  assert.equal(
    (await outbox.prepareReplacement(record.recordID, "worker-b")).status,
    "prepared"
  )

  const [prepareBinding, replacementBinding] = authorizer.bindings
  assert.ok(prepareBinding)
  assert.ok(replacementBinding)
  const prepareID = computeP2TRSignatureFraudSignerInvocationID(prepareBinding)
  const replacementID =
    computeP2TRSignatureFraudSignerInvocationID(replacementBinding)

  // Two boundaries on one record are two identities, each durable before its
  // own signer call.
  assert.notEqual(prepareID, replacementID)
  assert.equal(durableAtSign[0]?.activeSignerInvocationID, prepareID)
  assert.equal(durableAtSign[1]?.activeSignerInvocationID, replacementID)

  // The historical identity names the FIRST boundary that reached a signer,
  // matching the `??` semantics of signerInvocationStartedAtUnixMs beside it —
  // it is proof that some signer call began, not a pointer to the latest.
  const durable = await store.get(record.recordID)
  assert.equal(durable?.activeSignerInvocationID, undefined)
  assert.equal(durable?.signerInvocationID, prepareID)
  assert.equal(durable?.signerInvocationStartedAtUnixMs, 2_000)
})

test("hands the signer its invocation request and requires the echo back", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.echoInvocation = (invocation) =>
    ({
      ...invocation,
      untrustedProviderMetadata: "must-not-be-persisted",
    } as typeof invocation)
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

  assert.equal(
    (await outbox.prepare(record.recordID, "worker-a")).status,
    "prepared"
  )

  // The signer is handed exactly the identity the outbox committed durably,
  // and the digest that identity is derived from.
  const [binding] = authorizer.bindings
  assert.ok(binding)
  const expected = computeP2TRSignatureFraudSignerInvocationRequest(binding)
  assert.equal(preparer.invocations.length, 1)
  assert.equal(
    preparer.invocations[0].invocationID.toPrefixedString(),
    expected.invocationID
  )
  assert.equal(
    preparer.invocations[0].requestDigest.toPrefixedString(),
    expected.requestDigest
  )

  // The echo survives validation and the durable round trip.
  const durable = await store.get(record.recordID)
  assert.equal(
    durable?.preparedTransaction?.invocation?.invocationID.toPrefixedString(),
    expected.invocationID
  )
  assert.deepEqual(
    Object.keys(durable?.preparedTransaction?.invocation ?? {}),
    ["invocationID", "requestDigest"]
  )
})

test("captures the bytes when the signer serves another invocation request", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  // A signer that returns a well-formed, correctly signed transaction while
  // claiming it served a different request.
  preparer.echoInvocation = (invocation) => ({
    invocationID: Hex.from(`0x${"e7".repeat(32)}`),
    requestDigest: invocation.requestDigest,
  })
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

  const settled = await outbox.prepare(record.recordID, "worker-a")

  // The signer WAS invoked and the nonce may be spent, so the boundary must not
  // be recorded as uninvoked, and the authenticated bytes must be retained.
  assert.equal(preparer.calls, 1)
  assert.equal(settled.preparedTransaction, undefined)
  assert.ok(settled.signerInvocationStartedAtUnixMs)
  assert.equal(settled.unexpectedSignedArtifacts?.length, 1)
  assert.match(String(settled.lastError), /another invocation request/)
  assert.equal(
    settled.signerQuarantines?.[0]?.reasonCode,
    "wrong-signer-invocation-request"
  )
})

test("captures wrong-echo bytes when provenance invalidation wins the completion CAS", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.echoInvocation = (invocation) => ({
    invocationID: Hex.from(`0x${"e7".repeat(32)}`),
    requestDigest: invocation.requestDigest,
  })
  preparer.afterInitialSign = async () => {
    await invalidateP2TRSignatureFraudCanonicalProvenance(
      store,
      provenanceInvalidationEvidence(record)
    )
  }

  const settled = await dispatcher(store, preparer).prepare(
    record.recordID,
    "worker-a"
  )

  assert.equal(settled.status, "provenance-invalidated-awaiting-reconciliation")
  assert.equal(settled.unexpectedSignedArtifacts?.length, 1)
  assert.equal(
    settled.unexpectedSignedArtifacts?.[0].preparedTransaction.rawTransaction,
    RAW_TRANSACTION
  )
  assert.equal(
    settled.unexpectedSignedArtifacts?.[0].preparedTransaction.invocation,
    undefined
  )
  assert.equal(
    settled.signerQuarantines?.[0]?.reasonCode,
    "wrong-signer-invocation-request"
  )
})

test("authenticates and captures signed bytes before rejecting a malformed invocation echo", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.echoInvocation = () =>
    ({
      invocationID: "not-a-bytes32",
      requestDigest: "also-not-a-bytes32",
    } as unknown as P2TRSignatureFraudSignerInvocationRequest)

  const settled = await dispatcher(store, preparer).prepare(
    record.recordID,
    "worker-a"
  )

  assert.match(String(settled.lastError), /malformed invocation request echo/)
  assert.equal(settled.unexpectedSignedArtifacts?.length, 1)
  assert.equal(
    settled.unexpectedSignedArtifacts?.[0].preparedTransaction.rawTransaction,
    RAW_TRANSACTION
  )
  assert.equal(
    settled.unexpectedSignedArtifacts?.[0].preparedTransaction.invocation,
    undefined
  )
  assert.equal(
    settled.signerQuarantines?.[0]?.reasonCode,
    "wrong-signer-invocation-request"
  )
})

test("classifies a crossed signer lane before its malformed invocation echo", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const crossed = signTestChallengeTransaction(
    record.intent.calldata,
    20,
    2,
    SECOND_LANE_SIGNING_KEY
  )
  preparer.rawTransaction = crossed.rawTransaction
  preparer.transactionHash = crossed.transactionHash
  preparer.returnedSender = SECOND_TRANSACTION_SENDER
  preparer.echoInvocation = () =>
    ({
      invocationID: "not-a-bytes32",
      requestDigest: "also-not-a-bytes32",
    } as unknown as P2TRSignatureFraudSignerInvocationRequest)

  const settled = await dispatcher(store, preparer).prepare(
    record.recordID,
    "worker-a"
  )

  assert.equal(settled.unexpectedSignedArtifacts?.length, 1)
  assert.equal(
    settled.unexpectedSignedArtifacts?.[0].preparedTransaction.rawTransaction,
    crossed.rawTransaction
  )
  assert.equal(settled.signerQuarantines?.at(-1)?.reasonCode, "wrong-sender")
  assert.match(String(settled.lastError), /malformed invocation request echo/)
})

test("rejects a signer that returns no invocation echo at all", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  preparer.echoInvocation = () => undefined
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

  const settled = await outbox.prepare(record.recordID, "worker-a")
  assert.equal(settled.preparedTransaction, undefined)
  assert.match(String(settled.lastError), /no invocation request echo/)
  assert.equal(settled.unexpectedSignedArtifacts?.length, 1)
})

/**
 * Leaves a record exactly as a crashed worker would: the pre-I/O marker is
 * durable and the signer call never returns. `prepare` is deliberately not
 * awaited — the worker is gone.
 */
const strandSignerBoundary = async (
  store: InMemoryOutboxStore,
  outbox: ReturnType<typeof dispatcher>,
  authorizer: FixedBoundaryAuthorizer,
  recordID: string
): Promise<P2TRSignatureFraudChallengeOutboxRecord> => {
  let reached: () => void
  const atBoundary = new Promise<void>((resolve) => {
    reached = resolve
  })
  authorizer.beforeAuthorize = async () => {
    reached()
    await new Promise(() => {})
  }
  void outbox.prepare(recordID, "worker-a").catch(() => {})
  await atBoundary
  authorizer.beforeAuthorize = undefined
  const stranded = await store.get(recordID)
  assert.ok(stranded?.activeSignerInvocationStartedAtUnixMs)
  return stranded!
}

const neverInvokedBoundaryResolution = (
  record: P2TRSignatureFraudChallengeOutboxRecord,
  receipt = "0xfeed"
): P2TRSignatureFraudIndependentSignerBoundaryResolution => {
  const signerInvocationID = record.activeSignerInvocationID!
  const boundaryStartedAtUnixMs = record.activeSignerInvocationStartedAtUnixMs!
  const binding = {
    recordID: record.recordID,
    signerInvocationID,
    providerTombstone: {
      signerInvocationID,
      invocationID: computeP2TRSignatureFraudLegacySignerInvocationID({
        recordID: record.recordID,
        boundaryStartedAtUnixMs,
        preparationAttempts: record.preparationAttempts,
        nonceReservationID:
          record.reservedNonce!.reservationID.toPrefixedString(),
        stage: "prepare",
      }),
      receipt,
      receiptDigest: `0x${createHash("sha256")
        .update(Buffer.from(receipt.slice(2), "hex"))
        .digest("hex")}`,
      tombstonedAtUnixMs: boundaryStartedAtUnixMs,
    },
    boundaryStartedAtUnixMs,
    preparationAttempts: record.preparationAttempts,
    nonceReservationID: record.reservedNonce!.reservationID.toPrefixedString(),
    stage: "prepare" as const,
    invokedAtUnixMs: boundaryStartedAtUnixMs,
    outcome: "never-invoked" as const,
    providerEvidenceDigest: `0x${"c7".repeat(32)}`,
  }
  const evidenceDigest =
    computeP2TRSignatureFraudSignerBoundaryResolutionEvidenceDigest(binding)
  return {
    ...binding,
    evidenceDigest,
    canonicalAttestations: [
      {
        trustDomainID: "signer-primary",
        independenceDomainID: "signer-primary-infra",
        evidenceDigest,
        attestation: "0x01",
        attestedAtUnixMs: boundaryStartedAtUnixMs,
      },
      {
        trustDomainID: "signer-corroborating",
        independenceDomainID: "signer-corroborating-infra",
        evidenceDigest,
        attestation: "0x02",
        attestedAtUnixMs: boundaryStartedAtUnixMs,
      },
    ],
    resolvedAtUnixMs: boundaryStartedAtUnixMs,
  }
}

test("burns the contested nonce and makes the bytes durable before broadcast", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  const broadcaster = new RecordingBroadcaster()
  let atBroadcast: P2TRSignatureFraudChallengeOutboxRecord | undefined
  broadcaster.inspectDurableBoundary = async () => {
    atBroadcast = await store.get(record.recordID)
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
  const stranded = await strandSignerBoundary(
    store,
    outbox,
    authorizer,
    record.recordID
  )

  const burned = await outbox.burnContestedNonce(record.recordID)

  // The burn spends exactly the reserved nonce, on nothing.
  assert.equal(preparer.burnCalls, 1)
  const burn = burned.contestedNonceBurn
  assert.ok(burn)
  assert.equal(burn.nonce, stranded.reservedNonce!.nonce)
  const parsed = utils.parseTransaction(burn.rawTransaction)
  assert.equal(utils.getAddress(parsed.to!), TRANSACTION_SENDER)
  assert.equal(parsed.value.isZero(), true)
  assert.equal(parsed.data, "0x")
  assert.equal(parsed.gasLimit.toString(), "21000")
  const burnBinding = authorizer.bindings.at(-1)
  assert.equal(burnBinding?.stage, "burn")
  assert.equal(burnBinding?.challengeValueWei, "0")
  assert.equal(burnBinding?.maxGasLimit, "21000")
  assert.equal(burnBinding?.maxFeePerGas, burn.maxFeePerGas)
  assert.equal(burnBinding?.maxPriorityFeePerGas, burn.maxPriorityFeePerGas)
  assert.equal(
    burnBinding?.maxTotalFeeWei,
    (21_000n * BigInt(burn.maxFeePerGas)).toString()
  )

  // Durable before the broadcaster ran, so a crash can only re-send it.
  assert.equal(
    atBroadcast?.contestedNonceBurn?.transactionHash,
    burn.transactionHash
  )
  assert.equal(burn.broadcastAtUnixMs, 2_000)

  // The marker is untouched: a burn resolves nothing about the signer, it only
  // makes whatever the signer may hold unable to land.
  assert.equal(burned.activeSignerInvocationStartedAtUnixMs, 2_000)
})

test("re-burning re-sends the identical bytes and signs nothing new", async () => {
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
  await strandSignerBoundary(store, outbox, authorizer, record.recordID)

  const first = await outbox.burnContestedNonce(record.recordID)
  const again = await outbox.burnContestedNonce(record.recordID)

  // Every burn for one reservation spends the same nonce on the same nothing,
  // so a retry never needs a second signature.
  assert.equal(preparer.burnCalls, 1)
  assert.equal(
    again.contestedNonceBurn?.transactionHash,
    first.contestedNonceBurn?.transactionHash
  )
})

test("retains authenticated burn bytes before quarantining a malformed echo", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  const broadcaster = new RecordingBroadcaster()
  let atBroadcast: P2TRSignatureFraudChallengeOutboxRecord | undefined
  broadcaster.inspectDurableBoundary = async () => {
    atBroadcast = await store.get(record.recordID)
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
  await strandSignerBoundary(store, outbox, authorizer, record.recordID)
  preparer.echoInvocation = () =>
    ({
      invocationID: "not-a-bytes32",
      requestDigest: "also-not-a-bytes32",
    } as unknown as P2TRSignatureFraudSignerInvocationRequest)

  const burned = await outbox.burnContestedNonce(record.recordID)

  assert.ok(burned.contestedNonceBurn)
  assert.equal(
    atBroadcast?.contestedNonceBurn?.transactionHash,
    burned.contestedNonceBurn.transactionHash
  )
  assert.equal(broadcaster.rawTransactions.length, 1)
  assert.equal(
    burned.signerQuarantines?.at(-1)?.reasonCode,
    "wrong-signer-invocation-request"
  )
  assert.match(
    burned.signerQuarantines?.at(-1)?.reason ?? "",
    /malformed invocation request echo/
  )
})

test("persists a successful contested-burn retry acknowledgement", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  const broadcaster = new RecordingBroadcaster()
  broadcaster.throwAfterSend = new Error("provider disconnected after send")
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
  await strandSignerBoundary(store, outbox, authorizer, record.recordID)

  await assert.rejects(
    outbox.burnContestedNonce(record.recordID),
    /disconnected after send/
  )
  assert.equal(
    (await store.get(record.recordID))?.contestedNonceBurn?.broadcastAtUnixMs,
    undefined
  )

  broadcaster.throwAfterSend = undefined
  const retried = await outbox.burnContestedNonce(record.recordID)

  assert.equal(preparer.burnCalls, 1)
  assert.equal(broadcaster.rawTransactions.length, 2)
  assert.equal(retried.contestedNonceBurn?.broadcastAtUnixMs, 2_000)
})

test("does not acknowledge a contested burn under a mismatched provider hash", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  const broadcaster = new RecordingBroadcaster()
  broadcaster.returnedHash = `0x${"99".repeat(32)}`
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
  const stranded = await strandSignerBoundary(
    store,
    outbox,
    authorizer,
    record.recordID
  )

  const mismatched = await outbox.burnContestedNonce(record.recordID)

  assert.equal(mismatched.contestedNonceBurn?.broadcastAtUnixMs, undefined)
  assert.equal(mismatched.status, "quarantined")
  assert.equal(
    mismatched.activeSignerInvocationStartedAtUnixMs,
    stranded.activeSignerInvocationStartedAtUnixMs
  )
  assert.equal(
    mismatched.activeSignerInvocationID,
    stranded.activeSignerInvocationID
  )
  assert.match(String(mismatched.lastError), /does not match the persisted/)
  assert.equal(store.criticalAlerts.at(-1)?.code, "signed-state-quarantined")
})

test("keeps a durable burn claim through boundary resolution and lease recovery", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const authorizer = new FixedBoundaryAuthorizer()
  const broadcaster = new RecordingBroadcaster()
  const reconciler = new FixedReconciler()
  broadcaster.throwAfterSend = new Error("provider disconnected after send")
  let now = 2_000
  const outbox = dispatcher(
    store,
    preparer,
    broadcaster,
    new FixedRechecker(),
    reconciler,
    () => now,
    100,
    undefined,
    authorizer
  )
  const stranded = await strandSignerBoundary(
    store,
    outbox,
    authorizer,
    record.recordID
  )
  let signed!: () => void
  let release!: () => void
  const signedBurn = new Promise<void>((resolve) => {
    signed = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  preparer.afterBurnSign = async () => {
    signed()
    await gate
  }

  const burning = outbox.burnContestedNonce(record.recordID)
  await signedBurn
  const inFlight = await store.get(record.recordID)
  assert.ok(inFlight?.contestedNonceBurnClaim)
  assert.equal(inFlight.contestedNonceBurn, undefined)

  now = 2_200
  await store.resolveOrphanedSignerBoundary(
    neverInvokedBoundaryResolution(stranded)
  )
  await outbox.recoverExpiredPreparationLeases()
  const protectedRecord = await store.get(record.recordID)
  assert.equal(
    protectedRecord?.activeSignerInvocationStartedAtUnixMs,
    undefined
  )
  assert.ok(protectedRecord?.contestedNonceBurnClaim)
  assert.ok(protectedRecord?.reservedNonce)
  assert.equal(protectedRecord?.status, "quarantined")
  assert.equal(preparer.releasedReservations.length, 0)

  release()
  await assert.rejects(burning, /disconnected after send/)
  const captured = await store.get(record.recordID)

  assert.ok(captured)
  assert.equal(captured.activeSignerInvocationStartedAtUnixMs, undefined)
  assert.equal(captured.contestedNonceBurnClaim, undefined)
  assert.ok(captured.contestedNonceBurn)
  assert.equal(captured.reservedNonce?.nonce, stranded.reservedNonce?.nonce)

  await outbox.recoverExpiredPreparationLeases()
  const afterRecovery = await store.get(record.recordID)
  assert.ok(afterRecovery?.contestedNonceBurn)
  assert.ok(afterRecovery?.reservedNonce)
  assert.equal(preparer.releasedReservations.length, 0)

  broadcaster.throwAfterSend = undefined
  const retried = await outbox.burnContestedNonce(record.recordID)
  assert.equal(retried.contestedNonceBurn?.broadcastAtUnixMs, now)

  reconciler.resolution = withCanonicalAttestations({
    status: "terminal-nonce-consumed",
    sender: TRANSACTION_SENDER,
    transactionNonce: stranded.reservedNonce!.nonce,
    finalizedAccountNonce: stranded.reservedNonce!.nonce + 1,
    accountNonceReadAtBlock: 108,
    transactionAbsent: true,
    consensusFinalized: true,
    consumingTransaction: {
      transactionHash: retried.contestedNonceBurn!.transactionHash,
      sender: TRANSACTION_SENDER,
      nonce: stranded.reservedNonce!.nonce,
      blockNumber: 101,
      blockHash: `0x${"56".repeat(32)}`,
    },
    observedHead: {
      blockNumber: 172,
      blockHash: `0x${"12".repeat(32)}`,
    },
    finalizedThrough: {
      blockNumber: 108,
      blockHash: `0x${"18".repeat(32)}`,
    },
    routerChallenge: {
      exists: false,
      challengeKey: CHALLENGE_KEY,
      readAtBlock: 108,
    },
  } as Parameters<typeof withCanonicalAttestations>[0])
  const reconciled = await outbox.reconcile(record.recordID)
  assert.equal(reconciled.status, "generation-required")
})

test("makes a burn claim reconcilable when first-person authorization fails", async () => {
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

  let originalReached!: () => void
  let rejectOriginal!: () => void
  const atOriginalAuthorization = new Promise<void>((resolve) => {
    originalReached = resolve
  })
  const originalAuthorizationGate = new Promise<void>((resolve) => {
    rejectOriginal = resolve
  })
  authorizer.beforeAuthorize = async (binding) => {
    if (binding.stage !== "prepare") return
    originalReached()
    await originalAuthorizationGate
    throw new Error("first-person authorization rejected")
  }

  const preparing = outbox.prepare(record.recordID, "worker-a")
  await atOriginalAuthorization

  let burnReached!: () => void
  let releaseBurn!: () => void
  const atBurnSigner = new Promise<void>((resolve) => {
    burnReached = resolve
  })
  const burnSignerGate = new Promise<void>((resolve) => {
    releaseBurn = resolve
  })
  preparer.afterBurnSign = async () => {
    burnReached()
    await burnSignerGate
  }
  const burning = outbox.burnContestedNonce(record.recordID)
  await atBurnSigner

  rejectOriginal()
  const resolvedOriginal = await preparing
  assert.equal(resolvedOriginal.status, "quarantined")
  assert.equal(
    resolvedOriginal.activeSignerInvocationStartedAtUnixMs,
    undefined
  )
  assert.ok(resolvedOriginal.contestedNonceBurnClaim)
  assert.ok(resolvedOriginal.reservedNonce)

  releaseBurn()
  const burned = await burning
  assert.equal(burned.status, "quarantined")
  assert.equal(burned.contestedNonceBurnClaim, undefined)
  assert.ok(burned.contestedNonceBurn)
})

test("treats a durable burn as signer escape evidence", async () => {
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
  const stranded = await strandSignerBoundary(
    store,
    outbox,
    authorizer,
    record.recordID
  )
  await outbox.burnContestedNonce(record.recordID)

  await assert.rejects(
    store.resolveOrphanedSignerBoundary(
      neverInvokedBoundaryResolution(stranded)
    ),
    /no signer escape evidence/
  )
})

test("freezes a contested burn after its first durable append", async () => {
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
  await strandSignerBoundary(store, outbox, authorizer, record.recordID)
  const burned = await outbox.burnContestedNonce(record.recordID)

  assert.equal(
    await store.compareAndSwap(burned.recordID, burned.version, {
      ...burned,
      version: burned.version + 1,
      contestedNonceBurn: undefined,
    }),
    false
  )
  assert.equal(
    await store.compareAndSwap(burned.recordID, burned.version, {
      ...burned,
      version: burned.version + 1,
      contestedNonceBurn: {
        ...burned.contestedNonceBurn!,
        transactionHash: `0x${"44".repeat(32)}`,
      },
    }),
    false
  )
})

test("enforces provider tombstone receipt bounds before digest acceptance", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const authorizer = new FixedBoundaryAuthorizer()
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => 2_000,
    100,
    undefined,
    authorizer
  )
  const stranded = await strandSignerBoundary(
    store,
    outbox,
    authorizer,
    record.recordID
  )

  for (const receipt of ["0x", `0x${"ab".repeat(2_049)}`]) {
    assert.throws(
      () =>
        validateP2TRSignatureFraudIndependentSignerBoundaryResolution(
          neverInvokedBoundaryResolution(stranded, receipt)
        ),
      /between 1 and 2048 bytes/
    )
  }
})

test("refuses a burn that is not a self-transfer of nothing", async () => {
  for (const [name, lever] of [
    ["pays elsewhere", { burnRecipient: ROUTER_ADDRESS }],
    ["carries value", { burnValue: 1 }],
    ["carries calldata", { burnData: "0xdeadbeef" }],
    ["spends another nonce", { burnNonce: 9 }],
  ] as const) {
    const store = new InMemoryOutboxStore()
    const record = await enqueue(store)
    const preparer = new FixedPreparer()
    Object.assign(preparer, lever)
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
    await strandSignerBoundary(store, outbox, authorizer, record.recordID)

    await assert.rejects(
      outbox.burnContestedNonce(record.recordID),
      /spend exactly its reserved nonce on nothing/,
      name
    )
    // Nothing is made durable for a burn that was refused.
    assert.equal(
      (await store.get(record.recordID))?.contestedNonceBurn,
      undefined,
      name
    )
  }
})

// The whole point of keying the barrier by nonce lane. An orphaned signer
// boundary is unresolvable without out-of-band evidence, so before this change
// one such record froze challenge signing on EVERY sending account: the freeze
// was driven by store-wide `hasExpiredPreparationLeases` /
// `hasPendingNonceReleases` reads, and the throw that a wedged store actually
// raised came from `establishRecoveryBarrier`, before any per-record check.
//
// Note these tests are the only thing pinning that behaviour in either
// direction. Nothing in the suite asserted any barrier message before, so a
// regression here would otherwise ship silently.
const orphanLaneA = async (
  store: InMemoryOutboxStore,
  preparers: readonly P2TRSignatureFraudChallengeTransactionPreparer[]
): Promise<{ now: () => number; release: () => void }> => {
  const record = await enqueue(
    store,
    createIntent(),
    twoLaneFeePolicyManifest()
  )
  const authorizer = new FixedBoundaryAuthorizer()
  let now = 2_000
  let markStarted!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  authorizer.beforeAuthorize = async () => {
    markStarted()
    await gate
  }
  authorizer.rejectAuthorization = new Error("worker restarted")
  const original = dispatcher(
    store,
    preparers as never,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => now,
    100,
    undefined,
    authorizer
  )
  void original.prepare(record.recordID, "worker-a").catch(() => undefined)
  await started
  // Past the lease, the boundary is an orphan: the marker stands and no
  // process-local recovery may clear it.
  now = 40_001
  return { now: () => now, release }
}

test("an orphaned boundary on one lane no longer freezes signing on another", async () => {
  const store = new InMemoryOutboxStore()
  const laneA = new FixedPreparer()
  const laneB = new SecondLanePreparer()
  const { now, release } = await orphanLaneA(store, [laneA, laneB])

  assert.equal(
    await store.hasExpiredPreparationLeases(now(), {
      chainID: 11155111,
      sender: TRANSACTION_SENDER,
    }),
    true
  )
  assert.equal(
    await store.hasExpiredPreparationLeases(now(), {
      chainID: 11155111,
      sender: SECOND_TRANSACTION_SENDER,
    }),
    false
  )

  const second = await enqueue(
    store,
    createIntent(SECOND_INTENT_SEED),
    twoLaneFeePolicyManifest()
  )
  const restarted = dispatcher(
    store,
    [laneA, laneB] as never,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    now
  )
  const prepared = await restarted.prepare(second.recordID, "worker-b")

  // Lane A is skipped as unavailable rather than fatal, and lane B signs.
  assert.equal(prepared.status, "prepared")
  assert.equal(
    prepared.preparationSender?.toLowerCase(),
    SECOND_TRANSACTION_SENDER.toLowerCase()
  )
  assert.equal(laneA.calls, 0)
  assert.equal(prepared.selectedLaneID, SECOND_SIGNER_LANE_ID)
  assert.equal(laneB.calls, 1)
  release()
})

test("an orphaned boundary still freezes signing on its own lane", async () => {
  const store = new InMemoryOutboxStore()
  const laneA = new FixedPreparer()
  const { now, release } = await orphanLaneA(store, [laneA])

  const second = await enqueue(
    store,
    createIntent(SECOND_INTENT_SEED),
    twoLaneFeePolicyManifest()
  )
  const restarted = dispatcher(
    store,
    [laneA] as never,
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    now
  )
  // The only configured lane is the wedged one, so no healthy lane exists. The
  // record is re-queued rather than signed -- it is never handed to the signer.
  const attempted = await restarted.prepare(second.recordID, "worker-b")
  assert.equal(attempted.status, "queued")
  assert.equal(
    attempted.lastError,
    "No healthy durable signer lane is currently available"
  )
  assert.equal(laneA.calls, 0)
  release()
})

// The direct analogue of the activation hole fixed in #1049: a `preparing`
// record whose lane selection is still NULL belongs to no lane, so no per-lane
// predicate -- nor a rollup over every lane -- can see it. Only the store-wide
// sweep reclaims it, which is why the sweep must not gain a lane filter.
test("recovery still sweeps a preparing record that has selected no lane", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const claimed = await store.compareAndSwap(record.recordID, record.version, {
    ...record,
    status: "preparing",
    version: record.version + 1,
    preparationAttempts: 1,
    preparationLease: { owner: "worker-a", expiresAtUnixMs: 3_000 },
    updatedAtUnixMs: 2_000,
  })
  assert.equal(claimed, true)
  const stranded = await store.get(record.recordID)
  assert.equal(stranded?.preparationSender, undefined)

  // Invisible to every lane, visible store-wide.
  assert.equal(
    await store.hasExpiredPreparationLeases(40_001, {
      chainID: 11155111,
      sender: TRANSACTION_SENDER,
    }),
    false
  )
  assert.equal(await store.hasExpiredPreparationLeases(40_001), true)

  const recovery = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => 40_001
  )
  await recovery.recoverExpiredPreparationLeases()
  assert.equal((await store.get(record.recordID))?.status, "queued")
  assert.equal(await store.hasExpiredPreparationLeases(40_001), false)
})

// The depth gates irreversible conclusions -- retiring a generation, and
// treating a nonce as spent so an orphaned signer boundary can be resolved
// without asking the signer what it did. A reconciler that may declare any
// positive depth can have a one-block reorg un-consume a nonce already recorded
// as spent, so the floor is enforced where the reconciler is validated.
test("refuses a reconciler whose finality depth is below consensus finality", async () => {
  const store = new InMemoryOutboxStore()
  const shallow = new FixedReconciler()
  ;(shallow as unknown as Record<string, unknown>).finalityConfirmationBlocks =
    P2TR_SIGNATURE_FRAUD_OUTBOX_MIN_FINALITY_CONFIRMATION_BLOCKS - 1
  assert.throws(
    () =>
      dispatcher(
        store,
        new FixedPreparer(),
        new RecordingBroadcaster(),
        new FixedRechecker(),
        shallow
      ),
    /finality confirmation depth must be at least 64 blocks/
  )

  // The floor is a minimum, not an equality: more depth stays acceptable.
  const deeper = new FixedReconciler()
  ;(deeper as unknown as Record<string, unknown>).finalityConfirmationBlocks =
    P2TR_SIGNATURE_FRAUD_OUTBOX_MIN_FINALITY_CONFIRMATION_BLOCKS + 1
  assert.ok(
    dispatcher(
      store,
      new FixedPreparer(),
      new RecordingBroadcaster(),
      new FixedRechecker(),
      deeper
    )
  )
})

test("requires consensus finality for direct orphaned-boundary nonce evidence", () => {
  const build = (
    observedHeadBlockNumber: number
  ): P2TRSignatureFraudIndependentSignerBoundaryResolution => {
    const binding = {
      recordID: `0x${"a1".repeat(32)}`,
      signerInvocationID: `0x${"a2".repeat(32)}`,
      boundaryStartedAtUnixMs: 1_000,
      preparationAttempts: 1,
      nonceReservationID: `0x${"a3".repeat(32)}`,
      stage: "prepare" as const,
      invokedAtUnixMs: 1_100,
      outcome: "nonce-consumed" as const,
      nonceConsumption: {
        chainID: 11155111,
        sender: TRANSACTION_SENDER,
        transactionNonce: 7,
        finalizedAccountNonce: 8,
        accountNonceReadAtBlock: 500,
        consumingTransaction: {
          transactionHash: `0x${"a4".repeat(32)}`,
          sender: TRANSACTION_SENDER,
          nonce: 7,
          blockNumber: 480,
          blockHash: `0x${"a5".repeat(32)}`,
        },
        finalizedThrough: {
          blockNumber: 500,
          blockHash: `0x${"a6".repeat(32)}`,
        },
        observedHead: {
          blockNumber: observedHeadBlockNumber,
          blockHash: `0x${"a7".repeat(32)}`,
        },
      },
      providerEvidenceDigest: `0x${"a8".repeat(32)}`,
    }
    const evidenceDigest =
      computeP2TRSignatureFraudSignerBoundaryResolutionEvidenceDigest(binding)
    return {
      ...binding,
      evidenceDigest,
      canonicalAttestations: [
        {
          trustDomainID: "primary",
          independenceDomainID: "primary-infra",
          evidenceDigest,
          attestation: "0x01",
          attestedAtUnixMs: 1_200,
        },
        {
          trustDomainID: "corroborating",
          independenceDomainID: "corroborating-infra",
          evidenceDigest,
          attestation: "0x02",
          attestedAtUnixMs: 1_200,
        },
      ],
      resolvedAtUnixMs: 1_300,
    }
  }

  assert.throws(
    () =>
      validateP2TRSignatureFraudIndependentSignerBoundaryResolution(build(563)),
    /finality depth must be at least 64 blocks/
  )
  assert.ok(
    validateP2TRSignatureFraudIndependentSignerBoundaryResolution(build(564))
  )

  const {
    evidenceDigest: ignoredCurrentDigest,
    canonicalAttestations: ignoredCurrentAttestations,
    resolvedAtUnixMs,
    ...legacyBinding
  } = build(512)
  void ignoredCurrentDigest
  void ignoredCurrentAttestations
  const legacyDigest =
    computeP2TRSignatureFraudLegacyV4SignerBoundaryResolutionEvidenceDigest(
      legacyBinding
    )
  const legacyResolution: P2TRSignatureFraudIndependentSignerBoundaryResolution =
    {
      ...legacyBinding,
      evidenceDigest: legacyDigest,
      canonicalAttestations: [
        {
          trustDomainID: "primary",
          independenceDomainID: "primary-infra",
          evidenceDigest: legacyDigest,
          attestation: "0x01",
          attestedAtUnixMs: 1_200,
        },
        {
          trustDomainID: "corroborating",
          independenceDomainID: "corroborating-infra",
          evidenceDigest: legacyDigest,
          attestation: "0x02",
          attestedAtUnixMs: 1_200,
        },
      ],
      resolvedAtUnixMs,
    }
  assert.throws(
    () =>
      validateP2TRSignatureFraudIndependentSignerBoundaryResolution(
        legacyResolution
      ),
    /finality depth must be at least 64 blocks/
  )
  assert.ok(
    validateP2TRSignatureFraudLegacyV4SignerBoundaryResolutionReplay(
      legacyResolution
    )
  )
  assert.throws(
    () =>
      validateP2TRSignatureFraudLegacyV4SignerBoundaryResolutionReplay({
        ...legacyResolution,
        providerEvidenceDigest: `0x${"ff".repeat(32)}`,
      }),
    /resolution digest is invalid/
  )
})
