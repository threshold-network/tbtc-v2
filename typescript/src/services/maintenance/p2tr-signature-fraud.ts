import { Transaction } from "bitcoinjs-lib"
import { BigNumber, BigNumberish, constants, utils } from "ethers"

import { BitcoinClient, BitcoinRawTx, BitcoinTxHash } from "../../lib/bitcoin"
import { Hex } from "../../lib/utils"

export const P2TR_SIGHASH_DEFAULT = 0
export const P2TR_SIGHASH_ALL = 1
export const P2TR_SIGHASH_NONE = 2
export const P2TR_SIGHASH_SINGLE = 3
export const P2TR_SIGHASH_ANYONECANPAY_FLAG = 0x80
export const P2TR_SIGHASH_ANYONECANPAY_ALL = 0x81
export const P2TR_SIGHASH_ANYONECANPAY_NONE = 0x82
export const P2TR_SIGHASH_ANYONECANPAY_SINGLE = 0x83

// The Taproot KEY-PATH (ext_flag = 0) sighash types this model reconstructs:
// the four base types and their ANYONECANPAY variants. An explicit
// ANYONECANPAY|DEFAULT (0x80) is not a real Bitcoin sighash type (DEFAULT is
// only ever the omitted-byte form) and is intentionally excluded.
export type P2TRSupportedSighashType =
  | typeof P2TR_SIGHASH_DEFAULT
  | typeof P2TR_SIGHASH_ALL
  | typeof P2TR_SIGHASH_NONE
  | typeof P2TR_SIGHASH_SINGLE
  | typeof P2TR_SIGHASH_ANYONECANPAY_ALL
  | typeof P2TR_SIGHASH_ANYONECANPAY_NONE
  | typeof P2TR_SIGHASH_ANYONECANPAY_SINGLE

export const P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED = "unclassified"
export const P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP = "deposit-sweep"
export const P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS = "moving-funds"
export const P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVED_FUNDS_SWEEP =
  "moved-funds-sweep"
export const P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION = "redemption"
export const P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING = "wallet-closing"
export const P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT = "heartbeat"

export type P2TRSignatureFraudSpendType =
  | typeof P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED
  | typeof P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP
  | typeof P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
  | typeof P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVED_FUNDS_SWEEP
  | typeof P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
  | typeof P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING
  | typeof P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT

export type P2TRWitnessSignatureErrorCode =
  | "invalid-observation-payload"
  | "invalid-input-index"
  | "invalid-length"
  | "invalid-prevout-map"
  | "invalid-watchtower-state"
  | "missing-witness"
  | "unsupported-sighash"
  | "unsupported-witness-form"
  | "challenge-transaction-reverted"

export class P2TRWitnessSignatureError extends Error {
  readonly code: P2TRWitnessSignatureErrorCode

  constructor(code: P2TRWitnessSignatureErrorCode, message: string) {
    super(message)
    this.name = "P2TRWitnessSignatureError"
    this.code = code
  }
}

export type P2TRKeyPathWitnessSignature = {
  witnessSignature: Hex
  signature: Hex
  sighashType: P2TRSupportedSighashType
}

export type P2TRKeyPathInputWitnessSignature = P2TRKeyPathWitnessSignature & {
  inputIndex: number
  /** BIP-341 annex bytes, including the mandatory 0x50 prefix. */
  annex?: Hex
}

export type P2TRWalletInputPrevout = {
  scriptPubKey: Hex | Buffer | string
}

export type P2TRWalletInputObservationPrevout = P2TRWalletInputPrevout & {
  txid: Hex | Buffer | string
  vout: number
  valueSats: BigNumberish
}

/**
 * Binds a Taproot output key used by a revealed deposit back to the registered
 * FROST wallet that controls its key path. The funding outpoint is part of the
 * binding so an output key learned from one deposit cannot authorize an
 * unrelated input.
 */
export type P2TRWalletInputKeyBinding = {
  txid: Hex | Buffer | string
  vout: number
  outputKey: Hex | Buffer | string
  walletID: Hex | Buffer | string
}

export type P2TRWalletInputWitnessCandidate =
  P2TRKeyPathInputWitnessSignature & {
    walletID: Hex
    scriptPubKey: Hex
  }

export type P2TRWalletInputWitnessObservation = {
  rawTransaction: BitcoinRawTx
  inputIndex: number
  walletID: Hex | Buffer | string
  witnessSignature: Hex | Buffer | string
  inputPrevouts: P2TRWalletInputObservationPrevout[]
  bridgeIdentifier?: Hex | Buffer | string
}

export type P2TRSignatureFraudDraftChallenge = {
  walletID: Hex | Buffer | string
  sighash: Hex | Buffer | string
  signature: Hex | Buffer | string
  sighashType: P2TRSupportedSighashType
  signedInputIndex: number
  unsignedTransaction: BitcoinRawTx
  inputPrevouts: P2TRWalletInputObservationPrevout[]
}

export type P2TRSignatureFraudBridgeChallengeIdentity = {
  walletID: Hex | Buffer | string
  sighash: Hex | Buffer | string
  signature: Hex | Buffer | string
  sighashType: P2TRSupportedSighashType
  /** @deprecated The canonical identity is derived from `sighash`; ignored. */
  signedInputIndex?: number
  /** @deprecated The canonical identity is derived from `sighash`; ignored. */
  unsignedTransaction?: BitcoinRawTx
  /** @deprecated The canonical identity is derived from `sighash`; ignored. */
  inputPrevouts?: P2TRWalletInputObservationPrevout[]
  /** @deprecated The canonical identity is derived from `sighash`; ignored. */
  annex?: Hex | Buffer | string
}

export type P2TRSignatureFraudBridgeChallengeKey = {
  chainID: BigNumberish
  bridgeAddress: string
  bridgeChallengeIdentity: Hex | Buffer | string
}

export type P2TRSignatureFraudBridgeChallengeDomain = {
  chainID: BigNumberish
  bridgeAddress: string
}

export type P2TRSignatureFraudPayloadBounds = {
  maxRawTransactionBytes?: number
  maxInputs?: number
  maxOutputs?: number
  maxScriptPubKeyBytes?: number
}

export type P2TRSignatureFraudWitnessObservation =
  P2TRWalletInputWitnessCandidate & {
    rawTransaction: BitcoinRawTx
    unsignedTransaction: BitcoinRawTx
    inputPrevouts: P2TRWalletInputObservationPrevout[]
    spendType: P2TRSignatureFraudSpendType
    sighash: Hex
    draftChallengeIdentity: Hex
    bridgeChallengeIdentity: Hex
    bridgeChallengeKey?: Hex
    observationID: Hex
  }

export type P2TRWalletInputObservationPrevoutJSON = {
  txid: string
  vout: number
  valueSats: string
  scriptPubKey: string
}

export type P2TRSignatureFraudWitnessObservationJSON = {
  rawTransactionHex: string
  unsignedTransactionHex: string
  inputIndex: number
  walletID: string
  witnessSignature: string
  annex?: string
  signature: string
  sighashType: P2TRSupportedSighashType
  scriptPubKey: string
  inputPrevouts: P2TRWalletInputObservationPrevoutJSON[]
  spendType?: P2TRSignatureFraudSpendType
  sighash: string
  draftChallengeIdentity: string
  bridgeChallengeIdentity?: string
  bridgeChallengeKey?: string
  observationID: string
}

export type P2TRSignatureFraudWatchtowerObservationResult = {
  observation: P2TRSignatureFraudWitnessObservation
  record: P2TRWatchtowerChallengeRecord
}

export type P2TRSignatureFraudWatchtowerSubmissionResult =
  P2TRSignatureFraudWatchtowerObservationResult & {
    submissionRecord: P2TRWatchtowerChallengeRecord
  }

export type P2TRWatchtowerOperatorAlert = {
  code: string
  message: string
}

export type P2TRSignatureFraudWatchtowerRunnerOptions = {
  /**
   * Automatic submission is hard-disabled while the FROST fraud layer is
   * bounded/no-go. Only `false` or `undefined` is accepted; `true` always
   * fails construction pending a separately reviewed `COMPLETE_V2` design.
   */
  submitChallenges?: boolean
  maxSubmissionAttempts?: number
  submissionAttemptLimitAlert?: P2TRWatchtowerOperatorAlert
  submissionPolicy?: P2TRSignatureFraudChallengeSubmissionPolicy
}

export type P2TRSignatureFraudChallengeBroadcastResolution =
  | { status: "accepted" }
  | { status: "absent-after-finality"; reason: string }
  | { status: "unknown"; reason: string }

export type P2TRSignatureFraudChallengeBroadcastReconciliationContext = {
  observationID: Hex
  bridgeChallengeKey: Hex
  challengeTxHash?: Hex
  broadcastAtUnixMs?: number
  reconciliationAttempts: number
}

/**
 * Future `COMPLETE_V2` activation scaffolding for resolving an ambiguous
 * challenge broadcast against canonical chain state.
 *
 * The current watchtower is observation-only and this interface does not
 * enable automatic submission. Any separately reviewed production activation
 * must use a trust domain independent from the provider that broadcast the
 * transaction. It may return `absent-after-finality` only after a bounded
 * finality policy proves both the transaction hash and the Router challenge
 * key are absent.
 */
export interface P2TRSignatureFraudChallengeBroadcastReconciler {
  /** Independent provider/trust-domain identity used for reconciliation. */
  readonly reconciliationTrustDomainID: string
  /** Positive canonical confirmation depth required before proving absence. */
  readonly finalityConfirmationBlocks: number
  reconcileSignatureFraudChallengeBroadcast(
    context: P2TRSignatureFraudChallengeBroadcastReconciliationContext
  ): Promise<P2TRSignatureFraudChallengeBroadcastResolution>
}

export type P2TRSignatureFraudWatchtowerProcessingFailure<T> = {
  transaction: T
  error: string
}

export type P2TRSignatureFraudWatchtowerBatchResult<T> = {
  submissions: P2TRSignatureFraudWatchtowerSubmissionResult[]
  failures: P2TRSignatureFraudWatchtowerProcessingFailure<T>[]
}

export type P2TRSignatureFraudWatchtowerTransactionSourceName =
  | "mempool"
  | "confirmed"

export type P2TRSignatureFraudWatchtowerSourceFailure = {
  source: P2TRSignatureFraudWatchtowerTransactionSourceName
  error: string
}

export interface P2TRSignatureFraudWatchtowerTransactionSource {
  /**
   * When true, every returned transaction must carry an authenticated complete
   * `inputPrevouts` vector. The runner then rejects absence instead of falling
   * back to its independently configured `BitcoinClient`.
   */
  readonly p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts?: true
  listMempoolTransactions(): Promise<P2TRWatchtowerMempoolTransaction[]>
  listConfirmedTransactions(): Promise<P2TRWatchtowerConfirmedTransactionSourceResult>
  /**
   * Acknowledges the staged confirmed batch after its observations have been
   * durably recorded. Sources without a durable cursor may omit this method.
   */
  commitConfirmedTransactionScan?(): Promise<void>
  /** Discards a staged scan when the enclosing cycle cannot commit safely. */
  abortConfirmedTransactionScan?(): Promise<void> | void
}

/**
 * A bounded confirmed-history batch. `complete` is true only when the source
 * has proved that every confirmed transaction up to its canonical scan head
 * has been returned in this or a previously committed batch.
 */
export type P2TRWatchtowerConfirmedTransactionSourceResult = {
  transactions: P2TRWatchtowerConfirmedTransaction[]
  complete: boolean
  /** Canonical, durably indexed wallet registrations applicable to the batch. */
  registeredWalletIDs?: (Hex | Buffer | string)[]
  /** Previously confirmed candidates orphaned by this canonical scan. */
  orphanedConfirmedTransactions?: P2TRWatchtowerCanonicalBitcoinCandidateIdentity[]
}

const isP2TRWatchtowerConfirmedTransactionSourceResult = (
  value: unknown
): value is P2TRWatchtowerConfirmedTransactionSourceResult =>
  typeof value === "object" &&
  value !== null &&
  "transactions" in value &&
  Array.isArray(value.transactions) &&
  "complete" in value &&
  typeof value.complete === "boolean"

export type P2TRSignatureFraudWatchtowerCycleResult = {
  replayed: P2TRSignatureFraudWatchtowerSubmissionResult[]
  mempool: P2TRSignatureFraudWatchtowerBatchResult<P2TRWatchtowerMempoolTransaction>
  confirmed: P2TRSignatureFraudWatchtowerBatchResult<P2TRWatchtowerConfirmedTransaction>
  confirmedSourceComplete: boolean
  sourceFailures: P2TRSignatureFraudWatchtowerSourceFailure[]
  summary: P2TRWatchtowerChallengeRecordSummary
  unresolvedOperatorAlerts: P2TRWatchtowerChallengeRecord[]
}

export type P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget =
  | {
      observationID: Hex | Buffer | string
      bridgeChallengeKey?: never
      bitcoinTxHash?: never
      spendType?: never
    }
  | {
      observationID?: never
      bridgeChallengeKey: Hex | Buffer | string
      bitcoinTxHash?: never
      spendType?: never
    }

export type P2TRSignatureFraudWatchtowerBridgeProofLifecycleEventTarget =
  | {
      observationID: Hex | Buffer | string
      bridgeChallengeKey?: never
      bitcoinTxHash?: never
      spendType?: never
    }
  | {
      observationID?: never
      bridgeChallengeKey?: never
      bitcoinTxHash: Hex | Buffer | string
      spendType: P2TRSignatureFraudSpendType
    }

export type P2TRSignatureFraudWatchtowerBridgeLifecycleEventTarget =
  | P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget
  | P2TRSignatureFraudWatchtowerBridgeProofLifecycleEventTarget

export type P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence = {
  walletID?: Hex | Buffer | string
  bridgeChallengeIdentity?: Hex | Buffer | string
  sighash?: Hex | Buffer | string
}

export type P2TRSignatureFraudWatchtowerBridgeLifecycleEvent =
  | ({
      type: "defeated"
      defeatTxHash: Hex | Buffer | string
    } & P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget &
      P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence)
  | ({
      type: "honest-spend-proven"
    } & P2TRSignatureFraudWatchtowerBridgeProofLifecycleEventTarget &
      P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence)
  | ({
      type: "timeout-eligible"
    } & P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget &
      P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence)
  | ({
      type: "slashed"
      slashingTxHash: Hex | Buffer | string
    } & P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget &
      P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence)
  | ({
      type: "rewarded"
      rewardTxHash: Hex | Buffer | string
    } & P2TRSignatureFraudWatchtowerBridgeChallengeLifecycleEventTarget &
      P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence)

export interface P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource {
  listBridgeLifecycleEvents(): Promise<
    P2TRSignatureFraudWatchtowerBridgeLifecycleEvent[]
  >
}

export type P2TRSignatureFraudWatchtowerBridgeLifecycleResult = {
  event: P2TRSignatureFraudWatchtowerBridgeLifecycleEvent
  record: P2TRWatchtowerChallengeRecord
}

export type P2TRSignatureFraudWatchtowerBridgeLifecycleFailure = {
  event: P2TRSignatureFraudWatchtowerBridgeLifecycleEvent
  error: string
}

export type P2TRSignatureFraudWatchtowerBridgeLifecycleIgnored = {
  event: P2TRSignatureFraudWatchtowerBridgeLifecycleEvent
  reason: string
}

export type P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult = {
  records: P2TRSignatureFraudWatchtowerBridgeLifecycleResult[]
  failures: P2TRSignatureFraudWatchtowerBridgeLifecycleFailure[]
  ignored: P2TRSignatureFraudWatchtowerBridgeLifecycleIgnored[]
}

export type P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure = {
  source: "bridge-lifecycle"
  error: string
}

export type P2TRSignatureFraudWatchtowerBridgeLifecycleCycleResult = {
  bridgeLifecycle: P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult
  sourceFailures: P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure[]
  summary: P2TRWatchtowerChallengeRecordSummary
  unresolvedOperatorAlerts: P2TRWatchtowerChallengeRecord[]
}

export type P2TRSignatureFraudWatchtowerIntegratedSourceFailure =
  | P2TRSignatureFraudWatchtowerSourceFailure
  | P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure

export type P2TRSignatureFraudWatchtowerIntegratedCycleResult = {
  replayed: P2TRSignatureFraudWatchtowerSubmissionResult[]
  mempool: P2TRSignatureFraudWatchtowerBatchResult<P2TRWatchtowerMempoolTransaction>
  confirmed: P2TRSignatureFraudWatchtowerBatchResult<P2TRWatchtowerConfirmedTransaction>
  confirmedSourceComplete: boolean
  bridgeLifecycle: P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult
  sourceFailures: P2TRSignatureFraudWatchtowerIntegratedSourceFailure[]
  summary: P2TRWatchtowerChallengeRecordSummary
  unresolvedOperatorAlerts: P2TRWatchtowerChallengeRecord[]
}

type P2TRSignatureFraudWatchtowerSettledProcessingResult<T> =
  | {
      transaction: T
      submissions: P2TRSignatureFraudWatchtowerSubmissionResult[]
    }
  | {
      transaction: T
      error: string
    }

type P2TRSignatureFraudWatchtowerSettledBridgeLifecycleResult =
  | {
      event: P2TRSignatureFraudWatchtowerBridgeLifecycleEvent
      record: P2TRWatchtowerChallengeRecord
    }
  | {
      event: P2TRSignatureFraudWatchtowerBridgeLifecycleEvent
      ignoredReason: string
    }
  | {
      event: P2TRSignatureFraudWatchtowerBridgeLifecycleEvent
      error: string
    }

export type P2TRWatchtowerMempoolTransaction = {
  rawTransaction: BitcoinRawTx
  bitcoinTxHash: Hex | Buffer | string
  walletInputKeyBindings?: P2TRWalletInputKeyBinding[]
  /** Optional source-authenticated complete prevout vector. */
  inputPrevouts?: P2TRWalletInputObservationPrevout[]
}

export type P2TRWatchtowerCanonicalBitcoinCandidateIdentity = {
  bitcoinTxHash: Hex | Buffer | string
  bitcoinWtxid: Hex | Buffer | string
  bitcoinBlockHash: Hex | Buffer | string
}

export type P2TRWatchtowerConfirmedTransaction =
  P2TRWatchtowerMempoolTransaction & {
    bitcoinBlockHash: Hex | Buffer | string
    bitcoinBlockHeight: number
    /** Full canonical identity supplied by block-driven production sources. */
    canonicalBitcoinCandidateIdentity?: P2TRWatchtowerCanonicalBitcoinCandidateIdentity
  }

/**
 * Options for the manual low-level challenge submission API. They do not
 * enable the observation-only watchtower automatic submission path.
 */
export interface P2TRSignatureFraudChallengeSubmissionOptions {
  /**
   * Invoked immediately after the challenge transaction has been broadcast (its
   * hash is known) and before any confirmation wait. Lets callers durably record
   * the irreversible broadcast before the submission is fully resolved, so the
   * challenge is never re-broadcast on replay after a later failure.
   */
  onBroadcast?: (challengeTxHash: Hex | Buffer | string) => Promise<void> | void
}

/**
 * Manual low-level challenge submission boundary. The automatic watchtower
 * runner does not invoke this interface while the FROST fraud layer remains
 * bounded/no-go.
 */
export interface P2TRSignatureFraudChallengeSubmitter {
  /** Provider/trust-domain identity used to broadcast, when declared. */
  readonly submissionTrustDomainID?: string
  submitSignatureFraudChallenge(
    observation: P2TRSignatureFraudWitnessObservation,
    options?: P2TRSignatureFraudChallengeSubmissionOptions
  ): Promise<Hex | Buffer | string>
}

export const P2TR_SIGNATURE_FRAUD_BRIDGE_ACTION_SUBMIT = 0

export type P2TRSignatureFraudBridgeChallengePayloadInput = {
  txid: string
  vout: number
  sequence: number
}

export type P2TRSignatureFraudBridgeChallengePayloadPrevout = {
  valueSats: BigNumberish
  scriptPubKey: string
}

export type P2TRSignatureFraudBridgeChallengePayloadOutput = {
  valueSats: BigNumberish
  scriptPubKey: string
}

export type P2TRSignatureFraudBridgeChallengePayload = {
  walletID: string
  version: number
  locktime: number
  inputs: P2TRSignatureFraudBridgeChallengePayloadInput[]
  prevouts: P2TRSignatureFraudBridgeChallengePayloadPrevout[]
  outputs: P2TRSignatureFraudBridgeChallengePayloadOutput[]
  signedInputIndex: number
  witnessSignature: string
  annex: string
}

export const P2TR_SIGNATURE_FRAUD_BRIDGE_CHALLENGE_PAYLOAD_ABI_TYPE =
  "tuple(bytes32 walletID,uint32 version,uint32 locktime,tuple(bytes32 txid,uint32 vout,uint32 sequence)[] inputs,tuple(uint64 valueSats,bytes scriptPubKey)[] prevouts,tuple(uint64 valueSats,bytes scriptPubKey)[] outputs,uint32 signedInputIndex,bytes witnessSignature,bytes annex)"

export type P2TRSignatureFraudBridgeFraudParameters = {
  fraudChallengeDepositAmount?: BigNumberish
  [index: number]: unknown
}

export type P2TRSignatureFraudBridgeTransactionReceipt = {
  status?: number
}

export type P2TRSignatureFraudBridgeTransaction = {
  hash: string
  wait?: (
    confirmations?: number
  ) => Promise<P2TRSignatureFraudBridgeTransactionReceipt>
}

/**
 * Duck-typed contract interface the P2TR signature-fraud watchtower
 * uses to submit challenges on-chain.
 *
 * IMPORTANT: After the ECDSA fraud extraction (Bridge PR #435), the
 * `processP2TRSignatureFraudChallenge` entry point moved off Bridge
 * into the dedicated `P2TRSignatureFraudRouter` sidecar. Callers
 * MUST pass an instance of the router contract (not Bridge); passing
 * Bridge will fail at runtime because the entry point no longer
 * exists on Bridge.
 *
 * `fraudParameters` still lives on Bridge, so consumers that need
 * the deposit-amount lookup can either (a) pass the router contract
 * if it exposes a `fraudParameters` view that proxies through, or
 * (b) supply `challengeDepositAmount` directly via the submitter
 * options to skip the read.
 *
 * The type name retains "Bridge" for backward source-compat with
 * pre-extraction consumers; semantically it is now the router
 * contract. Will be renamed to `P2TRSignatureFraudRouterContract`
 * in a follow-up SDK breaking-change release.
 */
export interface P2TRSignatureFraudBridgeChallengeContract {
  fraudParameters?(): Promise<P2TRSignatureFraudBridgeFraudParameters>
  processP2TRSignatureFraudChallenge(
    action: number,
    payload: string,
    walletMembersIDs: number[],
    overrides: { value: BigNumberish }
  ): Promise<P2TRSignatureFraudBridgeTransaction>
}

export type P2TRSignatureFraudBridgeChallengeSubmitterOptions = {
  challengeDepositAmount?: BigNumberish
  confirmations?: number
}

export type P2TRSignatureFraudChallengeSubmissionPolicy = {
  allowedSpendTypes?: P2TRSignatureFraudSpendType[]
}

export type P2TRSignatureFraudSpendTypeClassifierContext = {
  rawTransaction: BitcoinRawTx
  unsignedTransaction: BitcoinRawTx
  candidate: P2TRWalletInputWitnessCandidate
  inputPrevouts: P2TRWalletInputObservationPrevout[]
  bridgeIdentifier?: Hex | Buffer | string
}

export type P2TRSignatureFraudSpendTypeClassifier = (
  context: P2TRSignatureFraudSpendTypeClassifierContext
) => P2TRSignatureFraudSpendType

export type P2TRSignatureFraudSpendTypeClassifierRule = {
  spendType: P2TRSignatureFraudSpendType
  matches(context: P2TRSignatureFraudSpendTypeClassifierContext): boolean
}

export type P2TRSignatureFraudWitnessObservationConsistencyContext = {
  /** Canonical wallet registry snapshot, never derived from the observation. */
  registeredWalletIDs: (Hex | Buffer | string)[]
  /** Canonical exact-outpoint deposit bindings, never derived from the observation. */
  walletInputKeyBindings: P2TRWalletInputKeyBinding[]
  bridgeIdentifier?: Hex | Buffer | string
  spendTypeClassifier?: P2TRSignatureFraudSpendTypeClassifier
  payloadBounds?: P2TRSignatureFraudPayloadBounds
  bridgeChallengeDomain?: P2TRSignatureFraudBridgeChallengeDomain
}

export const P2TR_WATCHTOWER_OBSERVATION_ID_DOMAIN =
  "tbtc-p2tr-watchtower-observation-v0"

export const P2TR_SIGNATURE_FRAUD_DRAFT_CHALLENGE_ID_DOMAIN =
  "tbtc-p2tr-signature-fraud-challenge-v0"

export const P2TR_SIGNATURE_FRAUD_BRIDGE_CHALLENGE_ID_DOMAIN =
  "tbtc-p2tr-signature-fraud-bridge-challenge-v1"

export const P2TR_SIGNATURE_FRAUD_BRIDGE_CHALLENGE_KEY_DOMAIN =
  "tbtc-p2tr-signature-fraud-bridge-key-v0"

export type P2TRWatchtowerChallengeStatus =
  | "observed"
  | "submitting"
  | "broadcast-pending"
  | "submitted"
  | "rejected"
  | "defeat-eligible"
  | "defeated"
  | "timeout-eligible"
  | "slashed"
  | "rewarded"

export type P2TRWatchtowerBitcoinStatus =
  | "mempool"
  | "confirmed"
  | "evicted"
  | "reorged"

export type P2TRWatchtowerOperatorAlertStatus =
  | "open"
  | "acknowledged"
  | "cleared"

export type P2TRWatchtowerBitcoinProofAlias = {
  bitcoinTxHash: Hex
  spendType: P2TRSignatureFraudSpendType
}

export type P2TRWatchtowerBitcoinProofAliasJSON = {
  bitcoinTxHash: string
  spendType: P2TRSignatureFraudSpendType
}

export type P2TRWatchtowerChallengeRecord = {
  observationID: Hex
  observation?: P2TRSignatureFraudWitnessObservation
  status: P2TRWatchtowerChallengeStatus
  submissionAttempts: number
  bitcoinStatus?: P2TRWatchtowerBitcoinStatus
  bitcoinTxHash?: Hex
  bitcoinWtxid?: Hex
  bitcoinProofAliases?: P2TRWatchtowerBitcoinProofAlias[]
  bitcoinBlockHash?: Hex
  bitcoinBlockHeight?: number
  challengeTxHash?: Hex
  challengeBroadcastAtUnixMs?: number
  challengeBroadcastReconciliationAttempts?: number
  lastChallengeBroadcastReconciliationAtUnixMs?: number
  lastChallengeBroadcastResolution?: P2TRSignatureFraudChallengeBroadcastResolution["status"]
  defeatTxHash?: Hex
  slashingTxHash?: Hex
  rewardTxHash?: Hex
  lastError?: string
  operatorAlertStatus?: P2TRWatchtowerOperatorAlertStatus
  operatorAlertCode?: string
  operatorAlertMessage?: string
  operatorAlertAcknowledgedBy?: string
}

export type P2TRWatchtowerChallengeRecordJSON = {
  observationID: string
  observation?: P2TRSignatureFraudWitnessObservationJSON
  status: P2TRWatchtowerChallengeStatus
  submissionAttempts: number
  bitcoinStatus?: P2TRWatchtowerBitcoinStatus
  bitcoinTxHash?: string
  bitcoinWtxid?: string
  bitcoinProofAliases?: P2TRWatchtowerBitcoinProofAliasJSON[]
  bitcoinBlockHash?: string
  bitcoinBlockHeight?: number
  challengeTxHash?: string
  challengeBroadcastAtUnixMs?: number
  challengeBroadcastReconciliationAttempts?: number
  lastChallengeBroadcastReconciliationAtUnixMs?: number
  lastChallengeBroadcastResolution?: P2TRSignatureFraudChallengeBroadcastResolution["status"]
  defeatTxHash?: string
  slashingTxHash?: string
  rewardTxHash?: string
  lastError?: string
  operatorAlertStatus?: P2TRWatchtowerOperatorAlertStatus
  operatorAlertCode?: string
  operatorAlertMessage?: string
  operatorAlertAcknowledgedBy?: string
}

export type P2TRWatchtowerChallengeRecordSummary = {
  total: number
  byStatus: Record<P2TRWatchtowerChallengeStatus, number>
  byBitcoinStatus: Record<P2TRWatchtowerBitcoinStatus, number>
  byOperatorAlertStatus: Record<P2TRWatchtowerOperatorAlertStatus, number>
  unresolvedOperatorAlerts: number
}

export interface P2TRWatchtowerChallengeStore {
  getChallengeRecord(
    observationID: Hex
  ): Promise<P2TRWatchtowerChallengeRecord | undefined>
  saveChallengeRecord(record: P2TRWatchtowerChallengeRecord): Promise<void>
}

export interface P2TRWatchtowerChallengeRecordSource {
  listChallengeRecords(): Promise<P2TRWatchtowerChallengeRecord[]>
}

export interface P2TRWatchtowerChallengeRecordPersistence {
  loadChallengeRecords(): Promise<P2TRWatchtowerChallengeRecordJSON[]>
  saveChallengeRecords(
    records: P2TRWatchtowerChallengeRecordJSON[]
  ): Promise<void>
}

export interface P2TRWatchtowerChallengeReplayStore
  extends P2TRWatchtowerChallengeStore,
    P2TRWatchtowerChallengeRecordSource {}

export type P2TRWatchtowerChallengeEvent =
  | {
      type: "observed"
      observationID: Hex | Buffer | string
      observation?: P2TRSignatureFraudWitnessObservation
    }
  | {
      type: "mempool-observed"
      observationID: Hex | Buffer | string
      observation?: P2TRSignatureFraudWitnessObservation
      bitcoinTxHash: Hex | Buffer | string
    }
  | {
      type: "mempool-evicted"
      observationID: Hex | Buffer | string
    }
  | {
      type: "bitcoin-confirmed"
      observationID: Hex | Buffer | string
      observation?: P2TRSignatureFraudWitnessObservation
      bitcoinTxHash: Hex | Buffer | string
      bitcoinWtxid?: Hex | Buffer | string
      bitcoinBlockHash: Hex | Buffer | string
      bitcoinBlockHeight: number
    }
  | {
      type: "bitcoin-reorged"
      observationID: Hex | Buffer | string
      expectedCanonicalIdentity?: P2TRWatchtowerCanonicalBitcoinCandidateIdentity
    }
  | {
      type: "submission-started"
      observationID: Hex | Buffer | string
      observation?: P2TRSignatureFraudWitnessObservation
    }
  | {
      type: "submission-broadcast"
      observationID: Hex | Buffer | string
      challengeTxHash: Hex | Buffer | string
      broadcastAtUnixMs?: number
    }
  | {
      type: "submission-broadcast-reconciled"
      observationID: Hex | Buffer | string
      resolution: P2TRSignatureFraudChallengeBroadcastResolution
      reconciledAtUnixMs: number
    }
  | {
      type: "submission-accepted"
      observationID: Hex | Buffer | string
      challengeTxHash: Hex | Buffer | string
    }
  | {
      type: "submission-rejected"
      observationID: Hex | Buffer | string
      error: string
    }
  | {
      type: "defeated"
      observationID: Hex | Buffer | string
      defeatTxHash: Hex | Buffer | string
    }
  | {
      type: "honest-spend-proven"
      observationID: Hex | Buffer | string
      bitcoinTxHash?: Hex | Buffer | string
    }
  | {
      type: "timeout-eligible"
      observationID: Hex | Buffer | string
    }
  | {
      type: "slashed"
      observationID: Hex | Buffer | string
      slashingTxHash: Hex | Buffer | string
    }
  | {
      type: "rewarded"
      observationID: Hex | Buffer | string
      rewardTxHash: Hex | Buffer | string
    }
  | {
      type: "operator-alert-raised"
      observationID: Hex | Buffer | string
      code: string
      message: string
    }
  | {
      type: "operator-alert-acknowledged"
      observationID: Hex | Buffer | string
      acknowledgedBy: string
    }
  | {
      type: "operator-alert-cleared"
      observationID: Hex | Buffer | string
    }

const toBuffer = (value: Hex | Buffer | string): Buffer => {
  if (value instanceof Hex) {
    return value.toBuffer()
  }

  if (Buffer.isBuffer(value)) {
    return Buffer.from(value)
  }

  return Hex.from(value).toBuffer()
}

const normalizeP2TRKeyPathAnnex = (
  annex: Hex | Buffer | string | undefined
): Hex | undefined => {
  if (annex === undefined) {
    return undefined
  }

  const annexBuffer = toBuffer(annex)
  if (annexBuffer.length === 0 || annexBuffer[0] !== 0x50) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Taproot key-path annex must be non-empty and start with 0x50"
    )
  }

  return Hex.from(annexBuffer)
}

const requireOptionalUnixMilliseconds = (
  value: number | undefined,
  fieldName: string
): number | undefined => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      `${fieldName} must be a non-negative safe integer`
    )
  }

  return value
}

const toBytes = (value: Hex | Buffer | string): string =>
  utils.hexlify(toBuffer(value))

const toBytes32 = (value: Hex | Buffer | string, fieldName: string): string => {
  const buffer = toBuffer(value)

  if (buffer.length !== 32) {
    throw new P2TRWitnessSignatureError(
      "invalid-observation-payload",
      `${fieldName} must be 32 bytes`
    )
  }

  return utils.hexlify(buffer)
}

const toHex = (value: Hex | Buffer | string): Hex => Hex.from(toBuffer(value))

const toBytes32Hex = (value: Hex | Buffer | string, fieldName: string): Hex => {
  const buffer = toBuffer(value)

  if (buffer.length !== 32) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      `${fieldName} must be 32 bytes`
    )
  }

  return Hex.from(buffer)
}

const optionalBytes32Hex = (
  value: string | undefined,
  fieldName: string
): Hex | undefined =>
  value === undefined ? undefined : toBytes32Hex(value, fieldName)

const uint32LE = (value: number, fieldName: string): Buffer => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new P2TRWitnessSignatureError(
      "invalid-observation-payload",
      `${fieldName} must be a uint32`
    )
  }

  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

const uint64LE = (value: BigNumberish, fieldName: string): Buffer => {
  const amount = BigNumber.from(value)
  if (amount.lt(0) || amount.gt("0xffffffffffffffff")) {
    throw new P2TRWitnessSignatureError(
      "invalid-observation-payload",
      `${fieldName} must be a uint64`
    )
  }

  const bytes = utils.arrayify(amount.toHexString())
  if (bytes.length > 8) {
    throw new P2TRWitnessSignatureError(
      "invalid-observation-payload",
      `${fieldName} must be a uint64`
    )
  }

  const buffer = Buffer.alloc(8)
  Buffer.from(bytes).reverse().copy(buffer)
  return buffer
}

const encodeCompactSize = (value: number): Buffer => {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new P2TRWitnessSignatureError(
      "invalid-observation-payload",
      "Compact size value must be a non-negative safe integer"
    )
  }

  if (value < 0xfd) {
    return Buffer.from([value])
  }

  if (value <= 0xffff) {
    const buffer = Buffer.alloc(3)
    buffer[0] = 0xfd
    buffer.writeUInt16LE(value, 1)
    return buffer
  }

  if (value <= 0xffffffff) {
    const buffer = Buffer.alloc(5)
    buffer[0] = 0xfe
    buffer.writeUInt32LE(value, 1)
    return buffer
  }

  const buffer = Buffer.alloc(9)
  buffer[0] = 0xff
  uint64LE(value, "Compact size value").copy(buffer, 1)
  return buffer
}

const bytesWithCompactSize = (payload: Buffer): Buffer =>
  Buffer.concat([encodeCompactSize(payload.length), payload])

const isTerminalWatchtowerStatus = (
  status: P2TRWatchtowerChallengeStatus
): boolean => status === "defeated" || status === "rewarded"

const isSubmissionClosedWatchtowerStatus = (
  status: P2TRWatchtowerChallengeStatus
): boolean =>
  status === "submitted" ||
  status === "defeat-eligible" ||
  status === "timeout-eligible" ||
  status === "slashed" ||
  isTerminalWatchtowerStatus(status)

const isReplayableWatchtowerStatus = (
  status: P2TRWatchtowerChallengeStatus
): boolean =>
  status === "observed" || status === "submitting" || status === "rejected"

const watchtowerChallengeStatusValues: P2TRWatchtowerChallengeStatus[] = [
  "observed",
  "submitting",
  "broadcast-pending",
  "submitted",
  "rejected",
  "defeat-eligible",
  "defeated",
  "timeout-eligible",
  "slashed",
  "rewarded",
]

const watchtowerChallengeStatuses = new Set(watchtowerChallengeStatusValues)

const challengeBroadcastResolutionStatuses = new Set<
  P2TRSignatureFraudChallengeBroadcastResolution["status"]
>(["accepted", "absent-after-finality", "unknown"])

const P2TR_CHALLENGE_BROADCAST_FINALITY_UNKNOWN_ALERT =
  "P2TR-CHALLENGE-BROADCAST-FINALITY-UNKNOWN"

const watchtowerBitcoinStatusValues: P2TRWatchtowerBitcoinStatus[] = [
  "mempool",
  "confirmed",
  "evicted",
  "reorged",
]

const watchtowerBitcoinStatuses = new Set(watchtowerBitcoinStatusValues)

const watchtowerOperatorAlertStatusValues: P2TRWatchtowerOperatorAlertStatus[] =
  ["open", "acknowledged", "cleared"]

const watchtowerOperatorAlertStatuses = new Set(
  watchtowerOperatorAlertStatusValues
)

const supportedP2TRSighashTypes = new Set<number>([
  P2TR_SIGHASH_DEFAULT,
  P2TR_SIGHASH_ALL,
  P2TR_SIGHASH_NONE,
  P2TR_SIGHASH_SINGLE,
  P2TR_SIGHASH_ANYONECANPAY_ALL,
  P2TR_SIGHASH_ANYONECANPAY_NONE,
  P2TR_SIGHASH_ANYONECANPAY_SINGLE,
])

const p2trSignatureFraudSpendTypeValues: P2TRSignatureFraudSpendType[] = [
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVED_FUNDS_SWEEP,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT,
]

const p2trSignatureFraudSpendTypes = new Set<string>(
  p2trSignatureFraudSpendTypeValues
)

const failClosedP2TRSignatureFraudSubmissionSpendTypes =
  new Set<P2TRSignatureFraudSpendType>([
    P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
    P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING,
    P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT,
  ])

const requireSupportedP2TRSighashType = (
  sighashType: number
): P2TRSupportedSighashType => {
  if (!supportedP2TRSighashTypes.has(sighashType)) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower observation sighash type is unsupported"
    )
  }

  return sighashType as P2TRSupportedSighashType
}

const requireP2TRSignatureFraudSpendType = (
  spendType: string | undefined
): P2TRSignatureFraudSpendType => {
  if (spendType === undefined) {
    return P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED
  }

  if (!p2trSignatureFraudSpendTypes.has(spendType)) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "P2TR signature-fraud spend type is unsupported"
    )
  }

  return spendType as P2TRSignatureFraudSpendType
}

const requireP2TRSignatureFraudSubmissionSpendType = (
  spendType: string | undefined
): P2TRSignatureFraudSpendType => {
  const normalizedSpendType = requireP2TRSignatureFraudSpendType(spendType)

  if (
    failClosedP2TRSignatureFraudSubmissionSpendTypes.has(normalizedSpendType)
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      `P2TR signature-fraud spend type ${normalizedSpendType} is fail-closed for challenge submission`
    )
  }

  return normalizedSpendType
}

export const createP2TRSignatureFraudSpendTypeClassifier = (
  rules: P2TRSignatureFraudSpendTypeClassifierRule[]
): P2TRSignatureFraudSpendTypeClassifier => {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "P2TR signature-fraud spend type classifier requires at least one rule"
    )
  }

  const normalizedRules = rules.map((rule) => {
    if (
      rule === undefined ||
      rule === null ||
      typeof rule.matches !== "function"
    ) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "P2TR signature-fraud spend type classifier rules must include match functions"
      )
    }

    return {
      ...rule,
      spendType: requireP2TRSignatureFraudSpendType(rule.spendType),
    }
  })

  if (
    normalizedRules.some(
      (rule) => rule.spendType === P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED
    )
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "P2TR signature-fraud spend type classifier rules must not classify unclassified spends"
    )
  }

  return (context) => {
    const matchingRules = normalizedRules.filter((rule) => {
      const matches = rule.matches(context) as unknown

      if (typeof matches !== "boolean") {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "P2TR signature-fraud spend type classifier rules must return booleans"
        )
      }

      return matches
    })

    if (matchingRules.length === 0) {
      return P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED
    }

    if (matchingRules.length > 1) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "P2TR signature-fraud spend type classification is ambiguous"
      )
    }

    return matchingRules[0].spendType
  }
}

const isP2TRWatchtowerObservationEvent = (
  event: P2TRWatchtowerChallengeEvent
): boolean =>
  event.type === "observed" ||
  event.type === "mempool-observed" ||
  event.type === "bitcoin-confirmed"

const isP2TRWatchtowerSubmissionEvent = (
  event: P2TRWatchtowerChallengeEvent
): boolean =>
  event.type === "submission-started" ||
  event.type === "submission-broadcast" ||
  event.type === "submission-broadcast-reconciled" ||
  event.type === "submission-accepted" ||
  event.type === "submission-rejected"

const watchtowerSubmissionErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }

  return String(error)
}

export const createP2TRWatchtowerChallengeRecord = (
  observationID: Hex | Buffer | string
): P2TRWatchtowerChallengeRecord => ({
  observationID: toHex(observationID),
  status: "observed",
  submissionAttempts: 0,
  challengeBroadcastReconciliationAttempts: 0,
})

const serializeP2TRWalletInputObservationPrevout = (
  prevout: P2TRWalletInputObservationPrevout
): P2TRWalletInputObservationPrevoutJSON => ({
  txid: toBytes32Hex(prevout.txid, "Prevout txid").toString(),
  vout: prevout.vout,
  valueSats: BigNumber.from(prevout.valueSats).toString(),
  scriptPubKey: toHex(prevout.scriptPubKey).toString(),
})

const deserializeP2TRWalletInputObservationPrevout = (
  prevout: P2TRWalletInputObservationPrevoutJSON
): P2TRWalletInputObservationPrevout => {
  uint32LE(prevout.vout, "Prevout vout")
  uint64LE(prevout.valueSats, "Prevout value")

  return {
    txid: toBytes32Hex(prevout.txid, "Prevout txid"),
    vout: prevout.vout,
    valueSats: BigNumber.from(prevout.valueSats),
    scriptPubKey: toHex(prevout.scriptPubKey),
  }
}

export const serializeP2TRSignatureFraudWitnessObservation = (
  observation: P2TRSignatureFraudWitnessObservation
): P2TRSignatureFraudWitnessObservationJSON => ({
  rawTransactionHex: Hex.from(
    observation.rawTransaction.transactionHex
  ).toString(),
  unsignedTransactionHex: Hex.from(
    observation.unsignedTransaction.transactionHex
  ).toString(),
  inputIndex: observation.inputIndex,
  walletID: toBytes32Hex(observation.walletID, "Wallet ID").toString(),
  witnessSignature: toHex(observation.witnessSignature).toString(),
  annex: observation.annex?.toString(),
  signature: toHex(observation.signature).toString(),
  sighashType: observation.sighashType,
  scriptPubKey: toHex(observation.scriptPubKey).toString(),
  inputPrevouts: observation.inputPrevouts.map(
    serializeP2TRWalletInputObservationPrevout
  ),
  spendType: observation.spendType,
  sighash: toBytes32Hex(observation.sighash, "Sighash").toString(),
  draftChallengeIdentity: toBytes32Hex(
    observation.draftChallengeIdentity,
    "Draft challenge identity"
  ).toString(),
  bridgeChallengeIdentity: toBytes32Hex(
    observation.bridgeChallengeIdentity,
    "Bridge challenge identity"
  ).toString(),
  bridgeChallengeKey:
    observation.bridgeChallengeKey === undefined
      ? undefined
      : toBytes32Hex(
          observation.bridgeChallengeKey,
          "Bridge challenge key"
        ).toString(),
  observationID: toBytes32Hex(
    observation.observationID,
    "Observation ID"
  ).toString(),
})

export const deserializeP2TRSignatureFraudWitnessObservation = (
  observation: P2TRSignatureFraudWitnessObservationJSON
): P2TRSignatureFraudWitnessObservation => {
  uint32LE(observation.inputIndex, "Input index")

  const signature = toHex(observation.signature)
  if (signature.toBuffer().length !== 64) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower observation signature must be 64 bytes"
    )
  }

  const witnessSignature = toHex(observation.witnessSignature)
  if (
    witnessSignature.toBuffer().length !== 64 &&
    witnessSignature.toBuffer().length !== 65
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower observation witness signature must be 64 or 65 bytes"
    )
  }

  const rawTransaction = {
    transactionHex: Hex.from(observation.rawTransactionHex).toString(),
  }
  const unsignedTransaction = {
    transactionHex: Hex.from(observation.unsignedTransactionHex).toString(),
  }
  const walletID = toBytes32Hex(observation.walletID, "Wallet ID")
  const inputPrevouts = observation.inputPrevouts.map(
    deserializeP2TRWalletInputObservationPrevout
  )
  const sighashType = requireSupportedP2TRSighashType(observation.sighashType)
  const annex = normalizeP2TRKeyPathAnnex(observation.annex)
  const sighash = toBytes32Hex(observation.sighash, "Sighash")
  const bridgeChallengeIdentity =
    observation.bridgeChallengeIdentity === undefined
      ? computeP2TRSignatureFraudBridgeChallengeIdentity({
          walletID,
          sighash,
          signature,
          sighashType,
          signedInputIndex: observation.inputIndex,
          unsignedTransaction,
          inputPrevouts,
        })
      : toBytes32Hex(
          observation.bridgeChallengeIdentity,
          "Bridge challenge identity"
        )

  return {
    rawTransaction,
    unsignedTransaction,
    inputIndex: observation.inputIndex,
    walletID,
    witnessSignature,
    annex,
    signature,
    sighashType,
    scriptPubKey: toHex(observation.scriptPubKey),
    inputPrevouts,
    spendType: requireP2TRSignatureFraudSpendType(observation.spendType),
    sighash,
    draftChallengeIdentity: toBytes32Hex(
      observation.draftChallengeIdentity,
      "Draft challenge identity"
    ),
    bridgeChallengeIdentity,
    bridgeChallengeKey: optionalBytes32Hex(
      observation.bridgeChallengeKey,
      "Bridge challenge key"
    ),
    observationID: toBytes32Hex(observation.observationID, "Observation ID"),
  }
}

const serializeP2TRWatchtowerBitcoinProofAlias = (
  alias: P2TRWatchtowerBitcoinProofAlias
): P2TRWatchtowerBitcoinProofAliasJSON => ({
  bitcoinTxHash: toBytes32Hex(
    alias.bitcoinTxHash,
    "Bitcoin proof alias transaction hash"
  ).toString(),
  spendType: requireP2TRSignatureFraudSpendType(alias.spendType),
})

const deserializeP2TRWatchtowerBitcoinProofAliases = (
  aliases: P2TRWatchtowerBitcoinProofAliasJSON[] | undefined
): P2TRWatchtowerBitcoinProofAlias[] | undefined => {
  if (aliases === undefined) {
    return undefined
  }

  if (!Array.isArray(aliases)) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower Bitcoin proof aliases must be an array"
    )
  }

  const result: P2TRWatchtowerBitcoinProofAlias[] = []
  const spendTypesByTransactionHash = new Map<
    string,
    P2TRSignatureFraudSpendType
  >()

  for (const alias of aliases) {
    if (
      alias === undefined ||
      alias === null ||
      typeof alias !== "object" ||
      Array.isArray(alias)
    ) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Watchtower Bitcoin proof alias must be an object"
      )
    }

    const bitcoinTxHash = toBytes32Hex(
      alias.bitcoinTxHash,
      "Bitcoin proof alias transaction hash"
    )
    if (alias.spendType === undefined) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Watchtower Bitcoin proof alias spend type is required"
      )
    }
    const spendType = requireP2TRSignatureFraudSpendType(alias.spendType)
    const transactionHash = bitcoinTxHash.toString()
    const existingSpendType = spendTypesByTransactionHash.get(transactionHash)

    if (existingSpendType !== undefined) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        existingSpendType === spendType
          ? "Watchtower Bitcoin proof aliases contain a duplicate transaction hash"
          : "Watchtower Bitcoin proof aliases conflict for a transaction hash"
      )
    }

    spendTypesByTransactionHash.set(transactionHash, spendType)
    result.push({ bitcoinTxHash, spendType })
  }

  return result
}

export const serializeP2TRWatchtowerChallengeRecord = (
  record: P2TRWatchtowerChallengeRecord
): P2TRWatchtowerChallengeRecordJSON => ({
  observationID: record.observationID.toString(),
  observation:
    record.observation === undefined
      ? undefined
      : serializeP2TRSignatureFraudWitnessObservation(record.observation),
  status: record.status,
  submissionAttempts: record.submissionAttempts,
  bitcoinStatus: record.bitcoinStatus,
  bitcoinTxHash: record.bitcoinTxHash?.toString(),
  bitcoinWtxid: record.bitcoinWtxid?.toString(),
  bitcoinProofAliases: record.bitcoinProofAliases?.map(
    serializeP2TRWatchtowerBitcoinProofAlias
  ),
  bitcoinBlockHash: record.bitcoinBlockHash?.toString(),
  bitcoinBlockHeight: record.bitcoinBlockHeight,
  challengeTxHash: record.challengeTxHash?.toString(),
  challengeBroadcastAtUnixMs: record.challengeBroadcastAtUnixMs,
  challengeBroadcastReconciliationAttempts:
    record.challengeBroadcastReconciliationAttempts ?? 0,
  lastChallengeBroadcastReconciliationAtUnixMs:
    record.lastChallengeBroadcastReconciliationAtUnixMs,
  lastChallengeBroadcastResolution: record.lastChallengeBroadcastResolution,
  defeatTxHash: record.defeatTxHash?.toString(),
  slashingTxHash: record.slashingTxHash?.toString(),
  rewardTxHash: record.rewardTxHash?.toString(),
  lastError: record.lastError,
  operatorAlertStatus: record.operatorAlertStatus,
  operatorAlertCode: record.operatorAlertCode,
  operatorAlertMessage: record.operatorAlertMessage,
  operatorAlertAcknowledgedBy: record.operatorAlertAcknowledgedBy,
})

export const deserializeP2TRWatchtowerChallengeRecord = (
  record: P2TRWatchtowerChallengeRecordJSON
): P2TRWatchtowerChallengeRecord => {
  const observationID = toBytes32Hex(record.observationID, "Observation ID")
  const observation =
    record.observation === undefined
      ? undefined
      : deserializeP2TRSignatureFraudWitnessObservation(record.observation)

  if (
    observation !== undefined &&
    !observation.observationID.equals(observationID)
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Serialized watchtower observation ID does not match record"
    )
  }

  if (
    observation?.bridgeChallengeKey !== undefined &&
    !observation.bridgeChallengeKey.equals(observationID)
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Serialized watchtower record is not keyed by its Bridge challenge key"
    )
  }

  if (!watchtowerChallengeStatuses.has(record.status)) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower challenge status is unsupported"
    )
  }

  if (
    record.bitcoinStatus !== undefined &&
    !watchtowerBitcoinStatuses.has(record.bitcoinStatus)
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower Bitcoin status is unsupported"
    )
  }

  if (
    !Number.isInteger(record.submissionAttempts) ||
    record.submissionAttempts < 0
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower submission attempts must be a non-negative integer"
    )
  }

  const challengeBroadcastReconciliationAttempts =
    record.challengeBroadcastReconciliationAttempts ?? 0
  if (
    !Number.isInteger(challengeBroadcastReconciliationAttempts) ||
    challengeBroadcastReconciliationAttempts < 0
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Challenge broadcast reconciliation attempts must be a non-negative integer"
    )
  }

  const challengeBroadcastAtUnixMs = requireOptionalUnixMilliseconds(
    record.challengeBroadcastAtUnixMs,
    "Challenge broadcast timestamp"
  )
  const lastChallengeBroadcastReconciliationAtUnixMs =
    requireOptionalUnixMilliseconds(
      record.lastChallengeBroadcastReconciliationAtUnixMs,
      "Last challenge broadcast reconciliation timestamp"
    )
  if (
    record.lastChallengeBroadcastResolution !== undefined &&
    !challengeBroadcastResolutionStatuses.has(
      record.lastChallengeBroadcastResolution
    )
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Last challenge broadcast resolution is unsupported"
    )
  }

  if (
    challengeBroadcastReconciliationAttempts > 0 &&
    (lastChallengeBroadcastReconciliationAtUnixMs === undefined ||
      record.lastChallengeBroadcastResolution === undefined)
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Reconciled challenge broadcast must retain its last result and timestamp"
    )
  }

  if (
    record.bitcoinBlockHeight !== undefined &&
    (!Number.isInteger(record.bitcoinBlockHeight) ||
      record.bitcoinBlockHeight < 0)
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Bitcoin block height must be a non-negative integer"
    )
  }

  if (record.lastError !== undefined && typeof record.lastError !== "string") {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower last error must be a string"
    )
  }

  if (
    record.operatorAlertStatus !== undefined &&
    !watchtowerOperatorAlertStatuses.has(record.operatorAlertStatus)
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower operator alert status is unsupported"
    )
  }

  if (
    record.operatorAlertCode !== undefined &&
    typeof record.operatorAlertCode !== "string"
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower operator alert code must be a string"
    )
  }

  if (
    record.operatorAlertMessage !== undefined &&
    typeof record.operatorAlertMessage !== "string"
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower operator alert message must be a string"
    )
  }

  if (
    record.operatorAlertAcknowledgedBy !== undefined &&
    typeof record.operatorAlertAcknowledgedBy !== "string"
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower operator alert acknowledgement must be a string"
    )
  }

  return {
    observationID,
    observation,
    status: record.status,
    submissionAttempts: record.submissionAttempts,
    bitcoinStatus: record.bitcoinStatus,
    bitcoinTxHash: optionalBytes32Hex(record.bitcoinTxHash, "Bitcoin tx hash"),
    bitcoinWtxid: optionalBytes32Hex(
      record.bitcoinWtxid,
      "Bitcoin witness transaction hash"
    ),
    bitcoinProofAliases: deserializeP2TRWatchtowerBitcoinProofAliases(
      record.bitcoinProofAliases
    ),
    bitcoinBlockHash: optionalBytes32Hex(
      record.bitcoinBlockHash,
      "Bitcoin block hash"
    ),
    bitcoinBlockHeight: record.bitcoinBlockHeight,
    challengeTxHash: optionalBytes32Hex(
      record.challengeTxHash,
      "Challenge tx hash"
    ),
    challengeBroadcastAtUnixMs,
    challengeBroadcastReconciliationAttempts,
    lastChallengeBroadcastReconciliationAtUnixMs,
    lastChallengeBroadcastResolution: record.lastChallengeBroadcastResolution,
    defeatTxHash: optionalBytes32Hex(record.defeatTxHash, "Defeat tx hash"),
    slashingTxHash: optionalBytes32Hex(
      record.slashingTxHash,
      "Slashing tx hash"
    ),
    rewardTxHash: optionalBytes32Hex(record.rewardTxHash, "Reward tx hash"),
    lastError: record.lastError,
    operatorAlertStatus: record.operatorAlertStatus,
    operatorAlertCode: record.operatorAlertCode,
    operatorAlertMessage: record.operatorAlertMessage,
    operatorAlertAcknowledgedBy: record.operatorAlertAcknowledgedBy,
  }
}

const cloneP2TRWatchtowerChallengeRecord = (
  record: P2TRWatchtowerChallengeRecord
): P2TRWatchtowerChallengeRecord =>
  deserializeP2TRWatchtowerChallengeRecord(
    serializeP2TRWatchtowerChallengeRecord(record)
  )

export const listP2TRWatchtowerUnresolvedOperatorAlerts = async (
  recordSource: P2TRWatchtowerChallengeRecordSource
): Promise<P2TRWatchtowerChallengeRecord[]> =>
  (await recordSource.listChallengeRecords())
    .filter(
      (record) =>
        record.operatorAlertStatus === "open" ||
        record.operatorAlertStatus === "acknowledged"
    )
    .map(cloneP2TRWatchtowerChallengeRecord)
    .sort((left, right) =>
      left.observationID
        .toString()
        .localeCompare(right.observationID.toString())
    )

const zeroWatchtowerRecordCounts = <T extends string>(
  values: T[]
): Record<T, number> =>
  Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>

export const summarizeP2TRWatchtowerChallengeRecords = async (
  recordSource: P2TRWatchtowerChallengeRecordSource
): Promise<P2TRWatchtowerChallengeRecordSummary> => {
  const summary: P2TRWatchtowerChallengeRecordSummary = {
    total: 0,
    byStatus: zeroWatchtowerRecordCounts(watchtowerChallengeStatusValues),
    byBitcoinStatus: zeroWatchtowerRecordCounts(watchtowerBitcoinStatusValues),
    byOperatorAlertStatus: zeroWatchtowerRecordCounts(
      watchtowerOperatorAlertStatusValues
    ),
    unresolvedOperatorAlerts: 0,
  }

  for (const record of await recordSource.listChallengeRecords()) {
    summary.total++
    summary.byStatus[record.status]++

    if (record.bitcoinStatus !== undefined) {
      summary.byBitcoinStatus[record.bitcoinStatus]++
    }

    if (record.operatorAlertStatus !== undefined) {
      summary.byOperatorAlertStatus[record.operatorAlertStatus]++

      if (
        record.operatorAlertStatus === "open" ||
        record.operatorAlertStatus === "acknowledged"
      ) {
        summary.unresolvedOperatorAlerts++
      }
    }
  }

  return summary
}

export const resolveP2TRWatchtowerObservationIDForBridgeChallengeKey = async (
  recordSource: P2TRWatchtowerChallengeRecordSource,
  bridgeChallengeKey: Hex | Buffer | string,
  lifecycleEvidence?: P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence
): Promise<Hex> => {
  const observationID =
    await resolveOptionalP2TRWatchtowerObservationIDForBridgeChallengeKey(
      recordSource,
      bridgeChallengeKey,
      lifecycleEvidence
    )
  if (observationID === undefined) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "No watchtower challenge record matches Bridge challenge key"
    )
  }
  return observationID
}

const resolveOptionalP2TRWatchtowerObservationIDForBridgeChallengeKey = async (
  recordSource: P2TRWatchtowerChallengeRecordSource,
  bridgeChallengeKey: Hex | Buffer | string,
  lifecycleEvidence?: P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence
): Promise<Hex | undefined> => {
  const resolvedBridgeChallengeKey = toBytes32Hex(
    bridgeChallengeKey,
    "Bridge challenge key"
  )
  const matchingRecords = (await recordSource.listChallengeRecords()).filter(
    (record) =>
      record.observation?.bridgeChallengeKey !== undefined &&
      record.observation.bridgeChallengeKey.equals(resolvedBridgeChallengeKey)
  )

  if (matchingRecords.length === 0) {
    return undefined
  }

  if (matchingRecords.length > 1) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Multiple watchtower challenge records match Bridge challenge key"
    )
  }

  const matchingRecord = matchingRecords[0]
  validateP2TRBridgeLifecycleEventEvidence(matchingRecord, lifecycleEvidence)

  return matchingRecord.observationID
}

export const resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType =
  async (
    recordSource: P2TRWatchtowerChallengeRecordSource,
    bitcoinTxHash: Hex | Buffer | string,
    spendType: P2TRSignatureFraudSpendType
  ): Promise<Hex> => {
    const observationID =
      await resolveOptionalP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
        recordSource,
        bitcoinTxHash,
        spendType
      )

    if (observationID === undefined) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "No watchtower challenge record matches Bitcoin tx hash and spend type"
      )
    }

    return observationID
  }

const resolveOptionalP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType =
  async (
    recordSource: P2TRWatchtowerChallengeRecordSource,
    bitcoinTxHash: Hex | Buffer | string,
    spendType: P2TRSignatureFraudSpendType
  ): Promise<Hex | undefined> => {
    const resolvedBitcoinTxHash = toBytes32Hex(bitcoinTxHash, "Bitcoin tx hash")
    const resolvedSpendType =
      requireP2TRSignatureFraudSubmissionSpendType(spendType)

    const recordsForBitcoinTxHash = (
      await recordSource.listChallengeRecords()
    ).filter((record) => {
      const isCurrentBitcoinTxHash =
        record.bitcoinTxHash !== undefined &&
        record.bitcoinTxHash.equals(resolvedBitcoinTxHash)
      const isAliasedBitcoinTxHash = record.bitcoinProofAliases?.some((alias) =>
        alias.bitcoinTxHash.equals(resolvedBitcoinTxHash)
      )

      return isCurrentBitcoinTxHash || isAliasedBitcoinTxHash === true
    })

    if (recordsForBitcoinTxHash.length === 0) {
      return undefined
    }

    const matchingRecords = recordsForBitcoinTxHash.filter((record) =>
      record.bitcoinProofAliases === undefined
        ? record.bitcoinTxHash?.equals(resolvedBitcoinTxHash) === true &&
          record.observation?.spendType === resolvedSpendType
        : record.bitcoinProofAliases.some(
            (alias) =>
              alias.bitcoinTxHash.equals(resolvedBitcoinTxHash) &&
              alias.spendType === resolvedSpendType
          )
    )

    if (matchingRecords.length === 0) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "No watchtower challenge record matches Bitcoin tx hash and spend type"
      )
    }

    if (matchingRecords.length > 1) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Multiple watchtower challenge records match Bitcoin tx hash and spend type"
      )
    }

    return matchingRecords[0].observationID
  }

const resolveP2TRBridgeLifecycleEventObservationID = async (
  event: P2TRSignatureFraudWatchtowerBridgeLifecycleEvent,
  recordSource?: P2TRWatchtowerChallengeRecordSource
): Promise<Hex | undefined> => {
  const eventObservationID =
    "observationID" in event ? event.observationID : undefined
  const eventBridgeChallengeKey =
    "bridgeChallengeKey" in event ? event.bridgeChallengeKey : undefined
  const eventBitcoinTxHash =
    "bitcoinTxHash" in event ? event.bitcoinTxHash : undefined
  const hasObservationID = eventObservationID !== undefined
  const hasBridgeChallengeKey = eventBridgeChallengeKey !== undefined
  const hasBitcoinProofTarget = eventBitcoinTxHash !== undefined

  if (
    [hasObservationID, hasBridgeChallengeKey, hasBitcoinProofTarget].filter(
      Boolean
    ).length !== 1
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Bridge lifecycle event must identify exactly one challenge"
    )
  }

  if (hasObservationID) {
    const observationID = toBytes32Hex(eventObservationID, "Observation ID")

    if (hasP2TRBridgeLifecycleEventEvidence(event)) {
      if (recordSource === undefined) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Bridge lifecycle event evidence requires a challenge record source"
        )
      }

      validateP2TRBridgeLifecycleEventEvidence(
        await resolveP2TRWatchtowerRecordForObservationID(
          recordSource,
          observationID
        ),
        event
      )
    }

    return observationID
  }

  if (hasBitcoinProofTarget) {
    if (event.type !== "honest-spend-proven") {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Bitcoin tx hash lifecycle target is only valid for honest spend proof events"
      )
    }

    if (recordSource === undefined) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Bridge proof event with Bitcoin tx hash requires a challenge record source"
      )
    }

    if (event.spendType === undefined) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Bridge proof event with Bitcoin tx hash requires a spend type"
      )
    }

    const observationID =
      await resolveOptionalP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
        recordSource,
        eventBitcoinTxHash,
        event.spendType
      )

    if (observationID === undefined) {
      return undefined
    }

    if (hasP2TRBridgeLifecycleEventEvidence(event)) {
      validateP2TRBridgeLifecycleEventEvidence(
        await resolveP2TRWatchtowerRecordForObservationID(
          recordSource,
          observationID
        ),
        event
      )
    }

    return observationID
  }

  if (recordSource === undefined) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Bridge lifecycle event with challenge key requires a challenge record source"
    )
  }

  if (eventBridgeChallengeKey === undefined) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Bridge lifecycle event must include a challenge key"
    )
  }

  return resolveOptionalP2TRWatchtowerObservationIDForBridgeChallengeKey(
    recordSource,
    eventBridgeChallengeKey,
    event
  )
}

const resolveP2TRWatchtowerRecordForObservationID = async (
  recordSource: P2TRWatchtowerChallengeRecordSource,
  observationID: Hex
): Promise<P2TRWatchtowerChallengeRecord> => {
  const matchingRecords = (await recordSource.listChallengeRecords()).filter(
    (record) => record.observationID.equals(observationID)
  )

  if (matchingRecords.length === 0) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "No watchtower challenge record matches observation ID"
    )
  }

  if (matchingRecords.length > 1) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Multiple watchtower challenge records match observation ID"
    )
  }

  return matchingRecords[0]
}

const hasP2TRBridgeLifecycleEventEvidence = (
  event: P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence
): boolean =>
  event.walletID !== undefined ||
  event.bridgeChallengeIdentity !== undefined ||
  event.sighash !== undefined

const validateP2TRBridgeLifecycleEventEvidence = (
  record: P2TRWatchtowerChallengeRecord,
  evidence?: P2TRSignatureFraudWatchtowerBridgeLifecycleEventEvidence
): void => {
  if (
    evidence === undefined ||
    !hasP2TRBridgeLifecycleEventEvidence(evidence)
  ) {
    return
  }

  if (record.observation === undefined) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Bridge lifecycle event evidence requires a stored observation"
    )
  }

  const expectedFields: {
    name: string
    eventValue?: Hex | Buffer | string
    recordValue: Hex | Buffer | string
  }[] = [
    {
      name: "wallet ID",
      eventValue: evidence.walletID,
      recordValue: record.observation.walletID,
    },
    {
      name: "Bridge challenge identity",
      eventValue: evidence.bridgeChallengeIdentity,
      recordValue: record.observation.bridgeChallengeIdentity,
    },
    {
      name: "sighash",
      eventValue: evidence.sighash,
      recordValue: record.observation.sighash,
    },
  ]

  for (const { name, eventValue, recordValue } of expectedFields) {
    if (eventValue === undefined) {
      continue
    }

    const eventBytes = toBytes32Hex(eventValue, `Bridge lifecycle ${name}`)
    const recordBytes = toBytes32Hex(recordValue, `Stored observation ${name}`)

    if (!eventBytes.equals(recordBytes)) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        `Bridge lifecycle ${name} does not match stored observation`
      )
    }
  }
}

export class P2TRWatchtowerSerializedChallengeStore
  implements P2TRWatchtowerChallengeReplayStore
{
  private records?: Map<string, P2TRWatchtowerChallengeRecord>
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly persistence: P2TRWatchtowerChallengeRecordPersistence
  ) {}

  async getChallengeRecord(
    observationID: Hex
  ): Promise<P2TRWatchtowerChallengeRecord | undefined> {
    const record = (await this.loadRecords()).get(observationID.toString())

    return record === undefined
      ? undefined
      : cloneP2TRWatchtowerChallengeRecord(record)
  }

  async saveChallengeRecord(
    record: P2TRWatchtowerChallengeRecord
  ): Promise<void> {
    const saveOperation = this.saveQueue.then(async () => {
      const records = await this.loadRecords()
      const updatedRecords = new Map(records)
      const clonedRecord = cloneP2TRWatchtowerChallengeRecord(record)
      updatedRecords.set(clonedRecord.observationID.toString(), clonedRecord)
      await this.persistRecords(updatedRecords)
      this.records = updatedRecords
    })

    this.saveQueue = saveOperation.catch(() => undefined)
    await saveOperation
  }

  async listChallengeRecords(): Promise<P2TRWatchtowerChallengeRecord[]> {
    return [...(await this.loadRecords()).values()].map(
      cloneP2TRWatchtowerChallengeRecord
    )
  }

  private async loadRecords(): Promise<
    Map<string, P2TRWatchtowerChallengeRecord>
  > {
    if (this.records !== undefined) {
      return this.records
    }

    const records = new Map<string, P2TRWatchtowerChallengeRecord>()
    for (const serializedRecord of await this.persistence.loadChallengeRecords()) {
      const record = deserializeP2TRWatchtowerChallengeRecord(serializedRecord)
      const observationID = record.observationID.toString()

      if (records.has(observationID)) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Serialized watchtower challenge records contain duplicate observation IDs"
        )
      }

      records.set(observationID, record)
    }

    this.records = records
    return records
  }

  private async persistRecords(
    records: Map<string, P2TRWatchtowerChallengeRecord>
  ): Promise<void> {
    await this.persistence.saveChallengeRecords(
      [...records.values()]
        .sort((left, right) =>
          left.observationID
            .toString()
            .localeCompare(right.observationID.toString())
        )
        .map(serializeP2TRWatchtowerChallengeRecord)
    )
  }
}

const applyP2TRWatchtowerObservationPayload = (
  record: P2TRWatchtowerChallengeRecord,
  event: P2TRWatchtowerChallengeEvent
): P2TRWatchtowerChallengeRecord => {
  if (!("observation" in event) || event.observation === undefined) {
    return record
  }

  if (!event.observation.observationID.equals(record.observationID)) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower observation payload ID does not match record"
    )
  }

  if (
    record.observation !== undefined &&
    (record.status === "submitting" ||
      record.status === "broadcast-pending" ||
      isSubmissionClosedWatchtowerStatus(record.status))
  ) {
    // Keep the exact representation used for an in-flight or accepted Bridge
    // challenge. Flexible-sighash replacements share the canonical record but
    // must not replace the payload already associated with its transaction.
    return record
  }

  return {
    ...record,
    observation: event.observation,
  }
}

const p2trWatchtowerObservationMatchesBitcoinTxHash = (
  observation: P2TRSignatureFraudWitnessObservation,
  bitcoinTxHash: Hex
): boolean =>
  BitcoinTxHash.from(
    Transaction.fromHex(observation.rawTransaction.transactionHex).getId()
  ).equals(bitcoinTxHash)

const validateCanonicalBitcoinCandidateIdentity = (
  rawTransaction: BitcoinRawTx,
  bitcoinTxHash: Hex | Buffer | string,
  bitcoinBlockHash: Hex | Buffer | string,
  identity?: P2TRWatchtowerCanonicalBitcoinCandidateIdentity,
  required = false
): Hex | undefined => {
  if (identity === undefined) {
    if (required) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Canonical transaction source omitted its txid/wtxid/block identity"
      )
    }
    return undefined
  }

  const expectedTxid = toBytes32Hex(bitcoinTxHash, "Bitcoin transaction hash")
  const identityTxid = toBytes32Hex(
    identity.bitcoinTxHash,
    "Canonical Bitcoin candidate transaction hash"
  )
  const expectedBlockHash = toBytes32Hex(bitcoinBlockHash, "Bitcoin block hash")
  const identityBlockHash = toBytes32Hex(
    identity.bitcoinBlockHash,
    "Canonical Bitcoin candidate block hash"
  )
  const transaction = Transaction.fromHex(rawTransaction.transactionHex)
  const rawTxid = toBytes32Hex(
    transaction.getId(),
    "Raw Bitcoin transaction hash"
  )
  const rawWtxid = toBytes32Hex(
    Buffer.from(transaction.getHash(true)).reverse(),
    "Raw Bitcoin witness transaction hash"
  )
  const identityWtxid = toBytes32Hex(
    identity.bitcoinWtxid,
    "Canonical Bitcoin candidate witness transaction hash"
  )

  if (
    !identityTxid.equals(expectedTxid) ||
    !rawTxid.equals(expectedTxid) ||
    !identityWtxid.equals(rawWtxid) ||
    !identityBlockHash.equals(expectedBlockHash)
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Canonical Bitcoin candidate identity does not match its raw transaction and block metadata"
    )
  }

  return identityWtxid
}

const initializeP2TRWatchtowerBitcoinProofAliases = (
  record: P2TRWatchtowerChallengeRecord
): P2TRWatchtowerChallengeRecord => {
  if (record.bitcoinProofAliases !== undefined) {
    return record
  }

  if (
    record.bitcoinStatus === "confirmed" &&
    record.bitcoinTxHash !== undefined &&
    record.observation !== undefined
  ) {
    if (
      p2trWatchtowerObservationMatchesBitcoinTxHash(
        record.observation,
        record.bitcoinTxHash
      )
    ) {
      return {
        ...record,
        bitcoinProofAliases: [
          {
            bitcoinTxHash: toBytes32Hex(
              record.bitcoinTxHash,
              "Bitcoin proof alias transaction hash"
            ),
            spendType: requireP2TRSignatureFraudSpendType(
              record.observation.spendType
            ),
          },
        ],
      }
    }
  }

  return { ...record, bitcoinProofAliases: [] }
}

const appendP2TRWatchtowerConfirmedBitcoinProofAlias = (
  record: P2TRWatchtowerChallengeRecord,
  event: Extract<P2TRWatchtowerChallengeEvent, { type: "bitcoin-confirmed" }>
): P2TRWatchtowerChallengeRecord => {
  const initializedRecord = applyP2TRWatchtowerObservationPayload(
    initializeP2TRWatchtowerBitcoinProofAliases(record),
    event
  )
  const bitcoinTxHash = toBytes32Hex(
    event.bitcoinTxHash,
    "Bitcoin proof alias transaction hash"
  )
  if (
    event.observation !== undefined &&
    !p2trWatchtowerObservationMatchesBitcoinTxHash(
      event.observation,
      bitcoinTxHash
    )
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Confirmed watchtower observation raw transaction does not match its Bitcoin transaction hash"
    )
  }

  const proofObservation =
    event.observation ??
    (initializedRecord.observation !== undefined &&
    p2trWatchtowerObservationMatchesBitcoinTxHash(
      initializedRecord.observation,
      bitcoinTxHash
    )
      ? initializedRecord.observation
      : undefined)
  if (proofObservation === undefined) {
    return initializedRecord
  }

  const spendType = requireP2TRSignatureFraudSpendType(
    proofObservation.spendType
  )
  const aliases = initializedRecord.bitcoinProofAliases ?? []
  const existingAlias = aliases.find((alias) =>
    alias.bitcoinTxHash.equals(bitcoinTxHash)
  )

  if (existingAlias !== undefined) {
    if (existingAlias.spendType !== spendType) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Watchtower Bitcoin proof aliases conflict for a transaction hash"
      )
    }

    return initializedRecord
  }

  return {
    ...initializedRecord,
    bitcoinProofAliases: [...aliases, { bitcoinTxHash, spendType }],
  }
}

const clearResolvedP2TRWatchtowerOperatorAlert = (
  record: P2TRWatchtowerChallengeRecord
): P2TRWatchtowerChallengeRecord => {
  if (
    record.operatorAlertStatus !== "open" &&
    record.operatorAlertStatus !== "acknowledged"
  ) {
    return record
  }

  return {
    ...record,
    operatorAlertStatus: "cleared",
  }
}

const clearP2TRChallengeBroadcastFinalityAlert = (
  record: P2TRWatchtowerChallengeRecord
): P2TRWatchtowerChallengeRecord => {
  if (
    record.operatorAlertCode !== P2TR_CHALLENGE_BROADCAST_FINALITY_UNKNOWN_ALERT
  ) {
    return record
  }

  return {
    ...record,
    operatorAlertStatus: "cleared",
  }
}

export const applyP2TRWatchtowerChallengeEvent = (
  record: P2TRWatchtowerChallengeRecord,
  event: P2TRWatchtowerChallengeEvent
): P2TRWatchtowerChallengeRecord => {
  const eventObservationID = toHex(event.observationID)
  if (!record.observationID.equals(eventObservationID)) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower event observation ID does not match record"
    )
  }

  if (event.type === "observed") {
    return applyP2TRWatchtowerObservationPayload(
      event.observation === undefined
        ? record
        : initializeP2TRWatchtowerBitcoinProofAliases(record),
      event
    )
  }

  if (
    isTerminalWatchtowerStatus(record.status) &&
    event.type !== "operator-alert-cleared"
  ) {
    return record
  }

  if (
    record.status === "slashed" &&
    event.type !== "rewarded" &&
    event.type !== "operator-alert-cleared"
  ) {
    return record
  }

  if (
    isSubmissionClosedWatchtowerStatus(record.status) &&
    isP2TRWatchtowerSubmissionEvent(event)
  ) {
    return record
  }

  switch (event.type) {
    case "submission-started": {
      const submittingRecord = applyP2TRWatchtowerObservationPayload(
        event.observation === undefined
          ? record
          : initializeP2TRWatchtowerBitcoinProofAliases(record),
        event
      )
      return {
        ...submittingRecord,
        status: "submitting",
        submissionAttempts: submittingRecord.submissionAttempts + 1,
        lastError: undefined,
      }
    }

    case "submission-broadcast":
      if (record.status === "broadcast-pending") {
        // Idempotent: the broadcast was already recorded (e.g. a retried persist
        // whose prior attempt committed before its promise rejected).
        return record
      }

      if (record.status !== "submitting") {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Watchtower challenge must be submitting before broadcast"
        )
      }

      // Non-replayable: the transaction is irreversibly broadcast. The record
      // stays here (rather than a replayable status) if acceptance cannot be
      // recorded, so the challenge is never re-broadcast.
      return {
        ...record,
        status: "broadcast-pending",
        challengeTxHash: toHex(event.challengeTxHash),
        challengeBroadcastAtUnixMs: requireOptionalUnixMilliseconds(
          event.broadcastAtUnixMs,
          "Challenge broadcast timestamp"
        ),
        challengeBroadcastReconciliationAttempts: 0,
        lastChallengeBroadcastReconciliationAtUnixMs: undefined,
        lastChallengeBroadcastResolution: undefined,
        lastError: undefined,
      }

    case "submission-broadcast-reconciled": {
      if (
        record.status !== "submitting" &&
        record.status !== "broadcast-pending"
      ) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Watchtower challenge must be submitting or broadcast-pending before reconciliation"
        )
      }

      const { resolution } = event
      if (!challengeBroadcastResolutionStatuses.has(resolution.status)) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Challenge broadcast reconciliation result is unsupported"
        )
      }
      if (
        resolution.status !== "accepted" &&
        (typeof resolution.reason !== "string" ||
          resolution.reason.length === 0)
      ) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Challenge broadcast reconciliation result must include a reason"
        )
      }

      const reconciledAtUnixMs = requireOptionalUnixMilliseconds(
        event.reconciledAtUnixMs,
        "Challenge broadcast reconciliation timestamp"
      )
      if (reconciledAtUnixMs === undefined) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Challenge broadcast reconciliation timestamp is required"
        )
      }

      const reconciledRecord: P2TRWatchtowerChallengeRecord = {
        ...record,
        challengeBroadcastReconciliationAttempts:
          (record.challengeBroadcastReconciliationAttempts ?? 0) + 1,
        lastChallengeBroadcastReconciliationAtUnixMs: reconciledAtUnixMs,
        lastChallengeBroadcastResolution: resolution.status,
      }

      if (resolution.status === "accepted") {
        return clearP2TRChallengeBroadcastFinalityAlert({
          ...reconciledRecord,
          status: "submitted",
          lastError: undefined,
        })
      }

      if (resolution.status === "absent-after-finality") {
        return clearP2TRChallengeBroadcastFinalityAlert({
          ...reconciledRecord,
          status: "rejected",
          lastError: resolution.reason,
        })
      }

      return {
        ...reconciledRecord,
        lastError: resolution.reason,
        operatorAlertStatus: "open",
        operatorAlertCode: P2TR_CHALLENGE_BROADCAST_FINALITY_UNKNOWN_ALERT,
        operatorAlertMessage: resolution.reason,
        operatorAlertAcknowledgedBy: undefined,
      }
    }

    case "mempool-observed": {
      const bitcoinTxHash = toBytes32Hex(
        event.bitcoinTxHash,
        "Mempool Bitcoin transaction hash"
      )
      if (
        event.observation !== undefined &&
        !p2trWatchtowerObservationMatchesBitcoinTxHash(
          event.observation,
          bitcoinTxHash
        )
      ) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Mempool watchtower observation raw transaction does not match its Bitcoin transaction hash"
        )
      }

      const mempoolRecord = applyP2TRWatchtowerObservationPayload(
        initializeP2TRWatchtowerBitcoinProofAliases(record),
        event
      )
      return {
        ...mempoolRecord,
        bitcoinStatus: "mempool",
        bitcoinTxHash,
        bitcoinWtxid: undefined,
        bitcoinBlockHash: undefined,
        bitcoinBlockHeight: undefined,
      }
    }

    case "mempool-evicted": {
      const evictedRecord = initializeP2TRWatchtowerBitcoinProofAliases(record)
      return {
        ...evictedRecord,
        bitcoinStatus: "evicted",
        bitcoinWtxid: undefined,
        bitcoinBlockHash: undefined,
        bitcoinBlockHeight: undefined,
      }
    }

    case "bitcoin-confirmed": {
      if (
        !Number.isInteger(event.bitcoinBlockHeight) ||
        event.bitcoinBlockHeight < 0
      ) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Bitcoin block height must be a non-negative integer"
        )
      }

      const confirmedRecord = appendP2TRWatchtowerConfirmedBitcoinProofAlias(
        record,
        event
      )
      return {
        ...confirmedRecord,
        bitcoinStatus: "confirmed",
        bitcoinTxHash: toHex(event.bitcoinTxHash),
        bitcoinWtxid:
          event.bitcoinWtxid === undefined
            ? undefined
            : toBytes32Hex(
                event.bitcoinWtxid,
                "Bitcoin witness transaction hash"
              ),
        bitcoinBlockHash: toHex(event.bitcoinBlockHash),
        bitcoinBlockHeight: event.bitcoinBlockHeight,
      }
    }

    case "bitcoin-reorged": {
      const reorgedRecord = initializeP2TRWatchtowerBitcoinProofAliases(record)
      if (event.expectedCanonicalIdentity !== undefined) {
        const expectedTxid = toBytes32Hex(
          event.expectedCanonicalIdentity.bitcoinTxHash,
          "Orphaned Bitcoin transaction hash"
        )
        const expectedWtxid = toBytes32Hex(
          event.expectedCanonicalIdentity.bitcoinWtxid,
          "Orphaned Bitcoin witness transaction hash"
        )
        const expectedBlockHash = toBytes32Hex(
          event.expectedCanonicalIdentity.bitcoinBlockHash,
          "Orphaned Bitcoin block hash"
        )
        if (
          record.bitcoinStatus !== "confirmed" ||
          record.bitcoinTxHash?.equals(expectedTxid) !== true ||
          record.bitcoinBlockHash?.equals(expectedBlockHash) !== true ||
          (record.bitcoinWtxid !== undefined &&
            !record.bitcoinWtxid.equals(expectedWtxid))
        ) {
          throw new P2TRWitnessSignatureError(
            "invalid-watchtower-state",
            "Orphaned Bitcoin candidate does not match the record's canonical confirmation"
          )
        }
      }
      return {
        ...reorgedRecord,
        bitcoinStatus: "reorged",
        bitcoinWtxid: undefined,
        bitcoinBlockHash: undefined,
        bitcoinBlockHeight: undefined,
      }
    }

    case "submission-accepted":
      if (
        record.status !== "submitting" &&
        record.status !== "broadcast-pending"
      ) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Watchtower challenge must be submitting or broadcast-pending before acceptance"
        )
      }

      return {
        ...record,
        status: "submitted",
        challengeTxHash: toHex(event.challengeTxHash),
        lastError: undefined,
      }

    case "submission-rejected":
      if (
        record.status !== "submitting" &&
        record.status !== "broadcast-pending"
      ) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Watchtower challenge must be submitting or broadcast-pending before rejection"
        )
      }

      return {
        ...record,
        status: "rejected",
        lastError: event.error,
      }

    case "defeated":
      return clearResolvedP2TRWatchtowerOperatorAlert({
        ...record,
        status: "defeated",
        defeatTxHash: toHex(event.defeatTxHash),
        lastError: undefined,
      })

    case "honest-spend-proven": {
      const proofBitcoinTxHash =
        "bitcoinTxHash" in event && event.bitcoinTxHash !== undefined
          ? toHex(event.bitcoinTxHash)
          : record.bitcoinTxHash

      return clearResolvedP2TRWatchtowerOperatorAlert({
        ...record,
        status: "defeat-eligible",
        bitcoinTxHash: proofBitcoinTxHash,
        lastError: undefined,
      })
    }

    case "timeout-eligible":
      return {
        ...record,
        status: "timeout-eligible",
        lastError: undefined,
      }

    case "slashed":
      return clearResolvedP2TRWatchtowerOperatorAlert({
        ...record,
        status: "slashed",
        slashingTxHash: toHex(event.slashingTxHash),
        lastError: undefined,
      })

    case "rewarded":
      return clearResolvedP2TRWatchtowerOperatorAlert({
        ...record,
        status: "rewarded",
        rewardTxHash: toHex(event.rewardTxHash),
        lastError: undefined,
      })

    case "operator-alert-raised":
      return {
        ...record,
        operatorAlertStatus: "open",
        operatorAlertCode: event.code,
        operatorAlertMessage: event.message,
        operatorAlertAcknowledgedBy: undefined,
      }

    case "operator-alert-acknowledged":
      if (
        record.operatorAlertStatus !== "open" &&
        record.operatorAlertStatus !== "acknowledged"
      ) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Watchtower operator alert must be open before acknowledgement"
        )
      }

      return {
        ...record,
        operatorAlertStatus: "acknowledged",
        operatorAlertAcknowledgedBy: event.acknowledgedBy,
      }

    case "operator-alert-cleared":
      if (record.operatorAlertStatus === undefined) {
        return record
      }

      return {
        ...record,
        operatorAlertStatus: "cleared",
      }
  }

  throw new P2TRWitnessSignatureError(
    "invalid-watchtower-state",
    "Unsupported watchtower event"
  )
}

const p2trWatchtowerChallengeMutationQueues = new WeakMap<
  P2TRWatchtowerChallengeStore,
  Map<string, Promise<void>>
>()

export const recordP2TRWatchtowerChallengeEvent = async (
  store: P2TRWatchtowerChallengeStore,
  event: P2TRWatchtowerChallengeEvent
): Promise<P2TRWatchtowerChallengeRecord> => {
  const observationID = toBytes32Hex(event.observationID, "Observation ID")
  const mutationKey = observationID.toString()
  let mutationQueue = p2trWatchtowerChallengeMutationQueues.get(store)
  if (mutationQueue === undefined) {
    mutationQueue = new Map<string, Promise<void>>()
    p2trWatchtowerChallengeMutationQueues.set(store, mutationQueue)
  }

  const previousMutation = mutationQueue.get(mutationKey) ?? Promise.resolve()
  const mutation = previousMutation.then(async () => {
    const existingRecord = await store.getChallengeRecord(observationID)

    if (!existingRecord && !isP2TRWatchtowerObservationEvent(event)) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Watchtower challenge record must exist before non-observation events"
      )
    }

    const initialRecord =
      existingRecord ?? createP2TRWatchtowerChallengeRecord(observationID)
    const updatedRecord = applyP2TRWatchtowerChallengeEvent(
      initialRecord,
      event
    )
    await store.saveChallengeRecord(updatedRecord)

    return updatedRecord
  })
  const mutationTail = mutation.then(
    () => undefined,
    () => undefined
  )
  mutationQueue.set(mutationKey, mutationTail)

  try {
    return await mutation
  } finally {
    if (mutationQueue.get(mutationKey) === mutationTail) {
      mutationQueue.delete(mutationKey)
    }
  }
}

/**
 * Records a watchtower challenge event, retrying transient persistence failures.
 *
 * Used for submission lifecycle events where losing the write is consequential:
 * once a challenge transaction is broadcast, its "submission-broadcast" and
 * "submission-accepted" records must reach durable storage so the challenge is
 * not re-broadcast on replay. Retries are bounded and immediate; the durable,
 * non-replayable "broadcast-pending" status (recorded first via the broadcast
 * event) is the backstop if persistence remains unavailable.
 * @param store Challenge record store to persist the event into.
 * @param event Challenge event to record.
 * @param attempts Maximum number of persistence attempts (bounded to >= 1).
 * @returns The updated challenge record after a successful persist.
 */
export const recordP2TRWatchtowerChallengeEventWithRetry = async (
  store: P2TRWatchtowerChallengeStore,
  event: P2TRWatchtowerChallengeEvent,
  attempts = 3
): Promise<P2TRWatchtowerChallengeRecord> => {
  const boundedAttempts = Number.isFinite(attempts)
    ? Math.max(1, Math.trunc(attempts))
    : 1
  let lastError: unknown
  for (let attempt = 0; attempt < boundedAttempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await recordP2TRWatchtowerChallengeEvent(store, event)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

/**
 * Parses the Taproot key-path witness signature encodings currently allowed by
 * the draft P2TR signature-fraud model.
 *
 * BIP-341 represents `SIGHASH_DEFAULT` by omitting the trailing sighash byte.
 * The draft model also allows explicit `SIGHASH_ALL` (`0x01`). Explicit
 * `SIGHASH_DEFAULT` (`0x00`) and all other sighash bytes are rejected before a
 * watchtower attempts challenge submission.
 *
 * @experimental This is a parser primitive for the draft P2TR signature-fraud
 *               watchtower path. It is not production challenge submission.
 * @param witnessSignature Raw witness signature bytes (Hex, Buffer, or hex
 *        string) extracted from the Taproot key-path spend.
 * @returns Parsed signature with the 64-byte Schnorr signature and the
 *          resolved sighash flag.
 */
export const parseP2TRKeyPathWitnessSignature = (
  witnessSignature: Hex | Buffer | string
): P2TRKeyPathWitnessSignature => {
  const witnessSignatureBuffer = toBuffer(witnessSignature)

  if (
    witnessSignatureBuffer.length !== 64 &&
    witnessSignatureBuffer.length !== 65
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-length",
      "Taproot key-path witness signature must be 64 or 65 bytes"
    )
  }

  if (witnessSignatureBuffer.length === 64) {
    return {
      witnessSignature: Hex.from(witnessSignatureBuffer),
      signature: Hex.from(witnessSignatureBuffer),
      sighashType: P2TR_SIGHASH_DEFAULT,
    }
  }

  const sighashType = witnessSignatureBuffer[64]
  // A 65-byte signature carries an explicit sighash byte, which must be one of
  // the supported key-path types. SIGHASH_DEFAULT is only ever the 64-byte
  // omitted-byte form, so an explicit 0x00 byte (and any non key-path byte) is
  // rejected here.
  if (
    sighashType === P2TR_SIGHASH_DEFAULT ||
    !supportedP2TRSighashTypes.has(sighashType)
  ) {
    throw new P2TRWitnessSignatureError(
      "unsupported-sighash",
      "Taproot key-path witness signature uses unsupported sighash type"
    )
  }

  return {
    witnessSignature: Hex.from(witnessSignatureBuffer),
    signature: Hex.from(witnessSignatureBuffer.subarray(0, 64)),
    sighashType: sighashType as P2TRSupportedSighashType,
  }
}

/**
 * Extracts and parses a single-input Taproot key-path witness signature from a
 * raw Bitcoin transaction.
 *
 * The caller must first identify that the input spends a registered tBTC P2TR
 * wallet UTXO. This function preserves a valid BIP-341 annex and rejects
 * script-path or malformed witness forms. It does not classify honest spend
 * types or submit challenges.
 *
 * @experimental This is a parser primitive for the draft P2TR signature-fraud
 *               watchtower path. It is not production challenge submission.
 * @param rawTransaction Raw Bitcoin transaction containing the candidate input.
 * @param inputIndex Zero-based index of the input whose key-path witness
 *        signature should be parsed.
 * @returns Parsed witness signature for the input, with sighash type resolved.
 */
export const extractP2TRKeyPathInputWitnessSignature = (
  rawTransaction: BitcoinRawTx,
  inputIndex: number
): P2TRKeyPathInputWitnessSignature => {
  const transaction = Transaction.fromHex(rawTransaction.transactionHex)

  if (
    !Number.isInteger(inputIndex) ||
    inputIndex < 0 ||
    inputIndex >= transaction.ins.length
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-input-index",
      "Input index is outside the transaction input vector"
    )
  }

  const witness = transaction.ins[inputIndex].witness
  if (witness.length === 0) {
    throw new P2TRWitnessSignatureError(
      "missing-witness",
      "Input does not contain a Taproot witness"
    )
  }

  const lastWitnessItem = witness[witness.length - 1]
  const hasAnnex =
    witness.length >= 2 &&
    lastWitnessItem.length > 0 &&
    lastWitnessItem[0] === 0x50
  const keyPathWitness = hasAnnex ? witness.slice(0, -1) : witness

  if (keyPathWitness.length !== 1) {
    throw new P2TRWitnessSignatureError(
      "unsupported-witness-form",
      "Only Taproot key-path witnesses with an optional BIP-341 annex are supported"
    )
  }

  return {
    ...parseP2TRKeyPathWitnessSignature(keyPathWitness[0]),
    inputIndex,
    annex: hasAnnex ? Hex.from(lastWitnessItem) : undefined,
  }
}

export const stripWitnessesFromBitcoinRawTransaction = (
  rawTransaction: BitcoinRawTx
): BitcoinRawTx => {
  const transaction = Transaction.fromHex(rawTransaction.transactionHex)
  transaction.ins.forEach((input) => {
    input.witness = []
  })

  return { transactionHex: transaction.toHex() }
}

const requirePositiveIntegerPayloadBound = (
  value: number | undefined,
  fieldName: string
): number | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      `${fieldName} must be a positive integer`
    )
  }

  return value
}

const requireWithinPayloadBound = (
  actual: number,
  maximum: number | undefined,
  message: string
) => {
  if (maximum !== undefined && actual > maximum) {
    throw new P2TRWitnessSignatureError("invalid-observation-payload", message)
  }
}

export const validateP2TRSignatureFraudPayloadBounds = (
  rawTransaction: BitcoinRawTx,
  inputPrevouts: P2TRWalletInputObservationPrevout[],
  bounds: P2TRSignatureFraudPayloadBounds
): void => {
  const maxRawTransactionBytes = requirePositiveIntegerPayloadBound(
    bounds.maxRawTransactionBytes,
    "Raw transaction byte bound"
  )
  const maxInputs = requirePositiveIntegerPayloadBound(
    bounds.maxInputs,
    "Input bound"
  )
  const maxOutputs = requirePositiveIntegerPayloadBound(
    bounds.maxOutputs,
    "Output bound"
  )
  const maxScriptPubKeyBytes = requirePositiveIntegerPayloadBound(
    bounds.maxScriptPubKeyBytes,
    "ScriptPubKey byte bound"
  )
  const transaction = Transaction.fromHex(rawTransaction.transactionHex)

  requireWithinPayloadBound(
    toBuffer(rawTransaction.transactionHex).length,
    maxRawTransactionBytes,
    "Raw transaction exceeds configured byte bound"
  )
  requireWithinPayloadBound(
    transaction.ins.length,
    maxInputs,
    "Input count exceeds configured bound"
  )
  requireWithinPayloadBound(
    inputPrevouts.length,
    maxInputs,
    "Prevout count exceeds configured input bound"
  )
  requireWithinPayloadBound(
    transaction.outs.length,
    maxOutputs,
    "Output count exceeds configured bound"
  )

  if (inputPrevouts.length !== transaction.ins.length) {
    throw new P2TRWitnessSignatureError(
      "invalid-prevout-map",
      "Input prevout map length must match the transaction input vector"
    )
  }

  inputPrevouts.forEach((prevout) => {
    requireWithinPayloadBound(
      toBuffer(prevout.scriptPubKey).length,
      maxScriptPubKeyBytes,
      "Prevout scriptPubKey exceeds configured byte bound"
    )
  })
  transaction.outs.forEach((output) => {
    requireWithinPayloadBound(
      output.script.length,
      maxScriptPubKeyBytes,
      "Output scriptPubKey exceeds configured byte bound"
    )
  })
}

export const resolveP2TRInputPrevouts = async (
  rawTransaction: BitcoinRawTx,
  bitcoinClient: BitcoinClient
): Promise<P2TRWalletInputObservationPrevout[]> => {
  const transaction = Transaction.fromHex(rawTransaction.transactionHex)

  return Promise.all(
    transaction.ins.map(async (input) => {
      const txid = BitcoinTxHash.from(input.hash).reverse()
      const rawPrevoutTransaction = await bitcoinClient.getRawTransaction(txid)
      const prevoutTransaction = Transaction.fromHex(
        rawPrevoutTransaction.transactionHex
      )
      if (prevoutTransaction.getId() !== txid.toString()) {
        throw new P2TRWitnessSignatureError(
          "invalid-prevout-map",
          "Previous transaction raw bytes do not match the requested input txid"
        )
      }
      const prevout = prevoutTransaction.outs[input.index]

      if (!prevout) {
        throw new P2TRWitnessSignatureError(
          "invalid-prevout-map",
          "Input prevout does not exist in the previous transaction"
        )
      }

      return {
        txid,
        vout: input.index,
        valueSats: prevout.value,
        scriptPubKey: Hex.from(prevout.script),
      }
    })
  )
}

/**
 * Authenticates a source-provided prevout vector against the raw input
 * outpoints before it can influence Taproot sighash reconstruction.
 *
 * @param rawTransaction Raw Bitcoin transaction whose input vector the prevout
 *        records must describe.
 * @param inputPrevouts Source-provided per-input prevout records (outpoint,
 *        amount, script). Length must equal the transaction's input vector
 *        length and each entry must name its input's outpoint exactly.
 * @returns The prevout records in transaction input order, once every entry has
 *          been authenticated against its raw outpoint.
 */
export const validateP2TRInputPrevouts = (
  rawTransaction: BitcoinRawTx,
  inputPrevouts: P2TRWalletInputObservationPrevout[]
): P2TRWalletInputObservationPrevout[] => {
  const transaction = Transaction.fromHex(rawTransaction.transactionHex)
  if (inputPrevouts.length !== transaction.ins.length) {
    throw new P2TRWitnessSignatureError(
      "invalid-prevout-map",
      "Authenticated input prevout map length must match the transaction input vector"
    )
  }

  return transaction.ins.map((input, inputIndex) => {
    const prevout = inputPrevouts[inputIndex]
    if (prevout === undefined) {
      throw new P2TRWitnessSignatureError(
        "invalid-prevout-map",
        "Authenticated input prevout map is sparse"
      )
    }
    const expectedTxid = BitcoinTxHash.from(input.hash).reverse().toString()
    const actualTxid = toHex(prevout.txid).toString()
    if (actualTxid !== expectedTxid || prevout.vout !== input.index) {
      throw new P2TRWitnessSignatureError(
        "invalid-prevout-map",
        "Authenticated input prevout does not match its raw transaction outpoint"
      )
    }
    if (!Number.isInteger(prevout.vout) || prevout.vout < 0) {
      throw new P2TRWitnessSignatureError(
        "invalid-prevout-map",
        "Authenticated input prevout index is invalid"
      )
    }
    let valueSats: BigNumber
    try {
      valueSats = BigNumber.from(prevout.valueSats)
    } catch {
      throw new P2TRWitnessSignatureError(
        "invalid-prevout-map",
        "Authenticated input prevout value is invalid"
      )
    }
    if (
      valueSats.isNegative() ||
      valueSats.gt(BigNumber.from("2100000000000000"))
    ) {
      throw new P2TRWitnessSignatureError(
        "invalid-prevout-map",
        "Authenticated input prevout value is outside Bitcoin's monetary range"
      )
    }

    return {
      txid: Hex.from(actualTxid),
      vout: prevout.vout,
      valueSats,
      scriptPubKey: Hex.from(toBuffer(prevout.scriptPubKey)),
    }
  })
}

/**
 * Reconstructs a BIP-341 KEY-PATH (ext_flag = 0) sighash for any supported
 * sighash mode, with or without a witness annex.
 *
 * @param rawTransaction Raw (unsigned) Bitcoin transaction.
 * @param inputIndex Zero-based index of the signed input.
 * @param inputPrevouts Per-input prevout records (script, amount). Length must
 *        equal the transaction's input vector length.
 * @param sighashType Supported Taproot key-path sighash type: DEFAULT, ALL,
 *        NONE, SINGLE, or any of those OR-ed with ANYONECANPAY.
 * @param annex Optional witness annex bytes including the mandatory 0x50 prefix.
 * @returns 32-byte BIP-341 key-path sighash.
 */
export const computeP2TRKeyPathSighash = (
  rawTransaction: BitcoinRawTx,
  inputIndex: number,
  inputPrevouts: P2TRWalletInputObservationPrevout[],
  sighashType: P2TRSupportedSighashType,
  annex?: Hex | Buffer | string
): Hex => {
  const transaction = Transaction.fromHex(rawTransaction.transactionHex)

  if (
    !Number.isInteger(inputIndex) ||
    inputIndex < 0 ||
    inputIndex >= transaction.ins.length
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-input-index",
      "Input index is outside the transaction input vector"
    )
  }

  if (inputPrevouts.length !== transaction.ins.length) {
    throw new P2TRWitnessSignatureError(
      "invalid-prevout-map",
      "Input prevout map length must match the transaction input vector"
    )
  }

  if (!supportedP2TRSighashTypes.has(sighashType)) {
    throw new P2TRWitnessSignatureError(
      "unsupported-sighash",
      "Taproot key-path sighash type is unsupported"
    )
  }

  // SIGHASH_SINGLE commits to the output paired with the signed input index;
  // BIP-341 makes that output mandatory, so a SINGLE signature over an input
  // without a corresponding output is invalid rather than merely hashing a
  // different message.
  if (
    (sighashType & 0x03) === P2TR_SIGHASH_SINGLE &&
    inputIndex >= transaction.outs.length
  ) {
    throw new P2TRWitnessSignatureError(
      "unsupported-sighash",
      "SIGHASH_SINGLE requires an output at the signed input index"
    )
  }

  const annexBuffer =
    annex === undefined || toBuffer(annex).length === 0
      ? undefined
      : toBuffer(annex)

  return Hex.from(
    transaction.hashForWitnessV1(
      inputIndex,
      inputPrevouts.map((prevout) => toBuffer(prevout.scriptPubKey)),
      inputPrevouts.map((prevout) =>
        BigNumber.from(prevout.valueSats).toNumber()
      ),
      sighashType,
      undefined,
      annexBuffer
    )
  )
}

export const extractP2TRWalletIDFromScriptPubKey = (
  scriptPubKey: Hex | Buffer | string
): Hex | undefined => {
  const scriptPubKeyBuffer = toBuffer(scriptPubKey)

  if (
    scriptPubKeyBuffer.length !== 34 ||
    scriptPubKeyBuffer[0] !== 0x51 ||
    scriptPubKeyBuffer[1] !== 0x20
  ) {
    return undefined
  }

  return Hex.from(scriptPubKeyBuffer.subarray(2, 34))
}

/**
 * Finds registered tBTC P2TR wallet inputs in a raw Bitcoin transaction and
 * parses their key-path witness signatures.
 *
 * Unknown P2TR outputs and non-P2TR inputs are ignored. Script-path spends of
 * exactly bound deposit outputs are refunds and are ignored. Registered wallet
 * inputs with unsupported witness forms are rejected fail-closed.
 *
 * @experimental This is a parser primitive for the draft P2TR signature-fraud
 *               watchtower path. It is not production challenge submission.
 * @param rawTransaction Raw Bitcoin transaction whose inputs are being
 *        screened for P2TR wallet key-path spends.
 * @param inputPrevouts Per-input prevout records (script, amount). Length
 *        must equal the transaction's input vector length.
 * @param registeredWalletIDs Canonical FROST wallet identifiers whose P2TR
 *        outputs are considered "registered" for this scan.
 * @param walletInputKeyBindings Revealed-deposit output keys bound to their
 *        registered wallet IDs and exact funding outpoints.
 * @returns Candidate witness records for each input whose prevout script
 *          matches a registered wallet's P2TR output key, directly or through
 *          an exact revealed-deposit binding.
 */
export const extractP2TRWalletInputWitnessCandidates = (
  rawTransaction: BitcoinRawTx,
  inputPrevouts: P2TRWalletInputPrevout[],
  registeredWalletIDs: (Hex | Buffer | string)[],
  walletInputKeyBindings: P2TRWalletInputKeyBinding[] = []
): P2TRWalletInputWitnessCandidate[] => {
  const transaction = Transaction.fromHex(rawTransaction.transactionHex)

  if (inputPrevouts.length !== transaction.ins.length) {
    throw new P2TRWitnessSignatureError(
      "invalid-prevout-map",
      "Input prevout map length must match the transaction input vector"
    )
  }

  const registeredWalletIDStrings = new Set(
    registeredWalletIDs.map((walletID) =>
      toBytes32Hex(walletID, "Registered wallet ID").toString()
    )
  )
  const keyBindings = normalizeP2TRWalletInputKeyBindings(
    walletInputKeyBindings,
    registeredWalletIDStrings
  )

  return inputPrevouts.flatMap((prevout, inputIndex) => {
    const outputKey = extractP2TRWalletIDFromScriptPubKey(prevout.scriptPubKey)

    if (!outputKey) {
      return []
    }

    const input = transaction.ins[inputIndex]
    const inputTxid = BitcoinTxHash.from(input.hash).reverse().toString()
    const binding = keyBindings.get(
      p2trWalletInputKeyBindingMapKey(inputTxid, input.index, outputKey)
    )

    if (binding !== undefined && isP2TRScriptPathWitness(input.witness)) {
      return []
    }

    const walletID =
      binding ??
      (registeredWalletIDStrings.has(outputKey.toString())
        ? outputKey
        : undefined)

    if (walletID === undefined) {
      return []
    }

    return [
      {
        ...extractP2TRKeyPathInputWitnessSignature(rawTransaction, inputIndex),
        walletID,
        scriptPubKey: Hex.from(toBuffer(prevout.scriptPubKey)),
      },
    ]
  })
}

const isP2TRScriptPathWitness = (witness: Buffer[]): boolean => {
  const lastItem = witness[witness.length - 1]
  // BIP-341 recognizes an annex only when at least two witness items exist.
  const witnessWithoutAnnex =
    witness.length >= 2 && lastItem?.[0] === 0x50
      ? witness.slice(0, -1)
      : witness

  return witnessWithoutAnnex.length >= 2
}

const normalizeP2TRWalletInputKeyBindings = (
  bindings: P2TRWalletInputKeyBinding[],
  registeredWalletIDs: Set<string>
): Map<string, Hex> => {
  const result = new Map<string, Hex>()

  for (const binding of bindings) {
    const walletID = toBytes32Hex(binding.walletID, "Bound wallet ID")
    const outputKey = toBytes32Hex(binding.outputKey, "Bound output key")
    const txid = toBytes32Hex(binding.txid, "Bound funding txid")
    uint32LE(binding.vout, "Bound funding output index")

    if (!registeredWalletIDs.has(walletID.toString())) {
      continue
    }

    const key = p2trWalletInputKeyBindingMapKey(
      txid.toString(),
      binding.vout,
      outputKey
    )
    const existingWalletID = result.get(key)

    if (existingWalletID !== undefined && !existingWalletID.equals(walletID)) {
      throw new P2TRWitnessSignatureError(
        "invalid-observation-payload",
        "Taproot wallet input key bindings conflict for the same outpoint and output key"
      )
    }

    result.set(key, walletID)
  }

  return result
}

const p2trWalletInputKeyBindingMapKey = (
  txid: Hex | Buffer | string,
  vout: number,
  outputKey: Hex | Buffer | string
): string =>
  `${toBytes32Hex(txid, "Wallet input txid").toString()}:${vout}:${toBytes32Hex(
    outputKey,
    "Wallet input output key"
  ).toString()}`

/**
 * Computes a deterministic raw-evidence observation ID for domainless
 * watchtower operation.
 *
 * This ID is intentionally separate from the future production Bridge
 * challenge key. It commits to the observed wallet input, witness signature,
 * raw transaction, prevout map, and optional Bridge/domain identifier so
 * duplicate mempool/confirmed observations can be collapsed before submission.
 * When a Bridge challenge domain is configured, the watchtower instead uses
 * the domain-bound Bridge challenge key for record and submission idempotency.
 *
 * @experimental This is an idempotency primitive for the draft P2TR
 *               signature-fraud watchtower path. It is not a production
 *               challenge key.
 * @param observation Observation tuple (wallet input, witness signature, raw
 *        transaction, prevouts, optional domain) being deduplicated.
 * @returns 32-byte deterministic observation ID for off-chain dedup.
 */
export const computeP2TRWalletInputWitnessObservationID = (
  observation: P2TRWalletInputWitnessObservation
): Hex => {
  if (!Number.isInteger(observation.inputIndex) || observation.inputIndex < 0) {
    throw new P2TRWitnessSignatureError(
      "invalid-input-index",
      "Input index must be a non-negative integer"
    )
  }

  const bridgeIdentifierCommitment = observation.bridgeIdentifier
    ? utils.keccak256(toBytes(observation.bridgeIdentifier))
    : constants.HashZero

  const prevoutCommitments = observation.inputPrevouts.map((prevout) => {
    if (!Number.isInteger(prevout.vout) || prevout.vout < 0) {
      throw new P2TRWitnessSignatureError(
        "invalid-observation-payload",
        "Prevout output index must be a non-negative integer"
      )
    }

    return utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["bytes32", "uint32", "uint64", "bytes"],
        [
          toBytes32(prevout.txid, "Prevout transaction hash"),
          prevout.vout,
          prevout.valueSats,
          toBytes(prevout.scriptPubKey),
        ]
      )
    )
  })

  return Hex.from(
    utils.keccak256(
      utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "bytes32",
          "bytes32",
          "uint32",
          "bytes32",
          "bytes32",
          "bytes32[]",
        ],
        [
          utils.id(P2TR_WATCHTOWER_OBSERVATION_ID_DOMAIN),
          bridgeIdentifierCommitment,
          toBytes32(observation.walletID, "Wallet ID"),
          observation.inputIndex,
          utils.keccak256(toBytes(observation.rawTransaction.transactionHex)),
          utils.keccak256(toBytes(observation.witnessSignature)),
          prevoutCommitments,
        ]
      )
    )
  )
}

/**
 * Computes the canonical Bridge-facing identity of a signed Taproot
 * authorization. The BIP-341 sighash commits exactly the transaction fields
 * selected by the witness sighash mode; fields outside that cryptographic
 * commitment cannot create separate challenge, deposit, or reward records.
 *
 * @experimental Bridge integration identity for the P2TR signature-fraud path.
 * @param challenge Wallet, reconstructed BIP-341 sighash, BIP-340 signature,
 *        and parsed witness sighash type.
 * @returns 32-byte Bridge challenge identity (SHA-256 over the canonical
 *          signed-authorization tuple).
 */
export const computeP2TRSignatureFraudBridgeChallengeIdentity = (
  challenge: P2TRSignatureFraudBridgeChallengeIdentity
): Hex => {
  const signature = toBuffer(challenge.signature)
  if (signature.length !== 64) {
    throw new P2TRWitnessSignatureError(
      "invalid-observation-payload",
      "BIP-340 signature must be 64 bytes"
    )
  }

  if (!supportedP2TRSighashTypes.has(challenge.sighashType)) {
    throw new P2TRWitnessSignatureError(
      "unsupported-sighash",
      "Taproot key-path sighash type is unsupported"
    )
  }

  const preimageParts = [
    Buffer.from(P2TR_SIGNATURE_FRAUD_BRIDGE_CHALLENGE_ID_DOMAIN, "utf8"),
    toBytes32Hex(challenge.walletID, "Wallet ID").toBuffer(),
    toBytes32Hex(challenge.sighash, "BIP-341 sighash").toBuffer(),
    signature,
    Buffer.from([challenge.sighashType]),
  ]

  return Hex.from(utils.sha256(Buffer.concat(preimageParts)))
}

/**
 * Computes the shared draft challenge identity used by the P2TR
 * signature-fraud vector corpus.
 *
 * This identity intentionally mirrors the current Node/Rust/Solidity test
 * harnesses. It is not a final production Bridge challenge key.
 *
 * @experimental Draft vector-conformance helper for the P2TR signature-fraud
 *               watchtower path.
 * @param challenge Draft challenge payload: wallet input, witness signature,
 *        raw transaction, prevout map, optional Bridge/domain identifier.
 * @returns 32-byte draft challenge identity matching the cross-language
 *          vector corpus.
 */
export const computeP2TRSignatureFraudDraftChallengeIdentity = (
  challenge: P2TRSignatureFraudDraftChallenge
): Hex => {
  const signature = toBuffer(challenge.signature)
  if (signature.length !== 64) {
    throw new P2TRWitnessSignatureError(
      "invalid-observation-payload",
      "BIP-340 signature must be 64 bytes"
    )
  }

  if (!supportedP2TRSighashTypes.has(challenge.sighashType)) {
    throw new P2TRWitnessSignatureError(
      "unsupported-sighash",
      "Taproot key-path sighash type is unsupported"
    )
  }

  const preimageParts = [
    Buffer.from(P2TR_SIGNATURE_FRAUD_DRAFT_CHALLENGE_ID_DOMAIN, "utf8"),
    toBytes32Hex(challenge.walletID, "Wallet ID").toBuffer(),
    toBytes32Hex(challenge.sighash, "BIP-341 sighash").toBuffer(),
    signature,
    Buffer.from([challenge.sighashType]),
    uint32LE(challenge.signedInputIndex, "Signed input index"),
    bytesWithCompactSize(
      toBuffer(challenge.unsignedTransaction.transactionHex)
    ),
    encodeCompactSize(challenge.inputPrevouts.length),
    ...challenge.inputPrevouts.flatMap((prevout) => [
      toBytes32Hex(prevout.txid, "Prevout transaction hash").toBuffer(),
      uint32LE(prevout.vout, "Prevout output index"),
      uint64LE(prevout.valueSats, "Prevout value"),
      bytesWithCompactSize(toBuffer(prevout.scriptPubKey)),
    ]),
  ]

  return Hex.from(utils.sha256(Buffer.concat(preimageParts)))
}

export const computeP2TRSignatureFraudBridgeChallengeKey = (
  challenge: P2TRSignatureFraudBridgeChallengeKey
): Hex => {
  const chainID = BigNumber.from(challenge.chainID)
  if (chainID.lte(0)) {
    throw new P2TRWitnessSignatureError(
      "invalid-observation-payload",
      "Chain ID must be positive"
    )
  }

  let bridgeAddress: string
  try {
    bridgeAddress = utils.getAddress(challenge.bridgeAddress)
  } catch (_) {
    throw new P2TRWitnessSignatureError(
      "invalid-observation-payload",
      "Bridge address must be a valid address"
    )
  }

  if (bridgeAddress === constants.AddressZero) {
    throw new P2TRWitnessSignatureError(
      "invalid-observation-payload",
      "Bridge address must be non-zero"
    )
  }

  return Hex.from(
    utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["string", "uint256", "address", "bytes32"],
        [
          P2TR_SIGNATURE_FRAUD_BRIDGE_CHALLENGE_KEY_DOMAIN,
          chainID,
          bridgeAddress,
          toBytes32(
            challenge.bridgeChallengeIdentity,
            "Bridge challenge identity"
          ),
        ]
      )
    )
  )
}

export const buildP2TRSignatureFraudBridgeChallengePayload = (
  observation: P2TRSignatureFraudWitnessObservation
): P2TRSignatureFraudBridgeChallengePayload => {
  const transaction = Transaction.fromHex(
    observation.unsignedTransaction.transactionHex
  )

  if (observation.inputPrevouts.length !== transaction.ins.length) {
    throw new P2TRWitnessSignatureError(
      "invalid-prevout-map",
      "Input prevout map length must match the transaction input vector"
    )
  }

  if (
    !Number.isInteger(observation.inputIndex) ||
    observation.inputIndex < 0 ||
    observation.inputIndex >= transaction.ins.length
  ) {
    throw new P2TRWitnessSignatureError(
      "invalid-input-index",
      "Input index is outside the transaction input vector"
    )
  }

  return {
    walletID: utils.hexlify(
      toBytes32Hex(observation.walletID, "Wallet ID").toBuffer()
    ),
    version: transaction.version,
    locktime: transaction.locktime,
    inputs: transaction.ins.map((input) => ({
      txid: utils.hexlify(input.hash),
      vout: input.index,
      sequence: input.sequence,
    })),
    prevouts: observation.inputPrevouts.map((prevout) => ({
      valueSats: BigNumber.from(prevout.valueSats),
      scriptPubKey: utils.hexlify(toBuffer(prevout.scriptPubKey)),
    })),
    outputs: transaction.outs.map((output) => ({
      valueSats: BigNumber.from(output.value),
      scriptPubKey: utils.hexlify(Buffer.from(output.script)),
    })),
    signedInputIndex: observation.inputIndex,
    witnessSignature: utils.hexlify(toBuffer(observation.witnessSignature)),
    annex:
      observation.annex === undefined
        ? "0x"
        : utils.hexlify(toBuffer(observation.annex)),
  }
}

export const encodeP2TRSignatureFraudBridgeChallengePayload = (
  observation: P2TRSignatureFraudWitnessObservation
): string =>
  utils.defaultAbiCoder.encode(
    [P2TR_SIGNATURE_FRAUD_BRIDGE_CHALLENGE_PAYLOAD_ABI_TYPE],
    [buildP2TRSignatureFraudBridgeChallengePayload(observation)]
  )

const resolveP2TRSignatureFraudChallengeDepositAmount = (
  fraudParameters: P2TRSignatureFraudBridgeFraudParameters
): BigNumberish => {
  if (fraudParameters.fraudChallengeDepositAmount !== undefined) {
    return fraudParameters.fraudChallengeDepositAmount
  }

  const indexedDepositAmount = fraudParameters[0]
  if (indexedDepositAmount !== undefined) {
    return indexedDepositAmount as BigNumberish
  }

  throw new P2TRWitnessSignatureError(
    "invalid-watchtower-state",
    "Bridge fraud parameters do not include a challenge deposit amount"
  )
}

const validateP2TRSignatureFraudBridgeTxHash = (txHash: string): string => {
  if (!utils.isHexString(txHash, 32)) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Bridge challenge transaction hash must be 32 bytes"
    )
  }

  return txHash
}

/**
 * Manual low-level Router adapter for explicitly submitted fraud challenges.
 *
 * This class is not an automatic production watchtower path and does not
 * activate the bounded/no-go FROST fraud layer. Callers remain responsible for
 * a separately reviewed `COMPLETE_V2` protocol and operational controls.
 */
export class P2TRSignatureFraudBridgeChallengeSubmitter
  implements P2TRSignatureFraudChallengeSubmitter
{
  private readonly confirmations: number

  /**
   * @param bridge The P2TR signature-fraud entry-point contract.
   *        Post-extraction this is the `P2TRSignatureFraudRouter`
   *        sidecar (NOT the Bridge contract). See
   *        `P2TRSignatureFraudBridgeChallengeContract` doc for the
   *        full naming-vs-semantics caveat.
   * @param options Submitter options. If `challengeDepositAmount` is
   *        omitted the submitter will call `contract.fraudParameters()`
   *        to look it up; consumers should ensure the supplied
   *        contract exposes that view or supply the deposit
   *        amount explicitly.
   */
  constructor(
    private readonly bridge: P2TRSignatureFraudBridgeChallengeContract,
    private readonly options: P2TRSignatureFraudBridgeChallengeSubmitterOptions = {}
  ) {
    if (
      options.confirmations !== undefined &&
      (!Number.isInteger(options.confirmations) || options.confirmations <= 0)
    ) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Bridge challenge confirmations must be a positive integer"
      )
    }

    this.confirmations = options.confirmations ?? 1
  }

  async submitSignatureFraudChallenge(
    observation: P2TRSignatureFraudWitnessObservation,
    options?: P2TRSignatureFraudChallengeSubmissionOptions
  ): Promise<string> {
    const challengeDepositAmount = await this.challengeDepositAmount()
    const tx = await this.bridge.processP2TRSignatureFraudChallenge(
      P2TR_SIGNATURE_FRAUD_BRIDGE_ACTION_SUBMIT,
      encodeP2TRSignatureFraudBridgeChallengePayload(observation),
      [],
      { value: challengeDepositAmount }
    )
    const txHash = validateP2TRSignatureFraudBridgeTxHash(tx.hash)

    // The transaction is now broadcast (its hash is known). Surface the
    // irreversible broadcast before the confirmation wait so callers can durably
    // record it and never re-broadcast the same challenge on replay.
    await options?.onBroadcast?.(txHash)

    if (this.confirmations > 0) {
      if (tx.wait === undefined) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Bridge challenge transaction cannot be awaited for finality"
        )
      }

      const receipt = await tx.wait(this.confirmations)
      if (receipt.status === undefined) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Bridge challenge transaction receipt must include a status"
        )
      }

      if (receipt.status === 0) {
        throw new P2TRWitnessSignatureError(
          "challenge-transaction-reverted",
          "Bridge challenge transaction reverted"
        )
      }
    }

    return txHash
  }

  private async challengeDepositAmount(): Promise<BigNumberish> {
    const challengeDepositAmount =
      this.options.challengeDepositAmount ??
      (this.bridge.fraudParameters === undefined
        ? undefined
        : resolveP2TRSignatureFraudChallengeDepositAmount(
            await this.bridge.fraudParameters()
          ))

    if (challengeDepositAmount === undefined) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Bridge challenge deposit amount must be configured"
      )
    }

    const amount = BigNumber.from(challengeDepositAmount)
    if (amount.lt(0)) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Bridge challenge deposit amount must be non-negative"
      )
    }

    return amount
  }
}

export const extractP2TRSignatureFraudWitnessObservations = (
  rawTransaction: BitcoinRawTx,
  inputPrevouts: P2TRWalletInputObservationPrevout[],
  registeredWalletIDs: (Hex | Buffer | string)[],
  bridgeIdentifier?: Hex | Buffer | string,
  spendTypeClassifier?: P2TRSignatureFraudSpendTypeClassifier,
  payloadBounds?: P2TRSignatureFraudPayloadBounds,
  bridgeChallengeDomain?: P2TRSignatureFraudBridgeChallengeDomain,
  walletInputKeyBindings: P2TRWalletInputKeyBinding[] = []
): P2TRSignatureFraudWitnessObservation[] => {
  if (payloadBounds !== undefined) {
    validateP2TRSignatureFraudPayloadBounds(
      rawTransaction,
      inputPrevouts,
      payloadBounds
    )
  }

  const unsignedTransaction =
    stripWitnessesFromBitcoinRawTransaction(rawTransaction)

  return extractP2TRWalletInputWitnessCandidates(
    rawTransaction,
    inputPrevouts,
    registeredWalletIDs,
    walletInputKeyBindings
  ).map((candidate) => {
    const spendType = requireP2TRSignatureFraudSpendType(
      spendTypeClassifier?.({
        rawTransaction,
        unsignedTransaction,
        candidate,
        inputPrevouts,
        bridgeIdentifier,
      }) ?? P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED
    )
    const sighash = computeP2TRKeyPathSighash(
      unsignedTransaction,
      candidate.inputIndex,
      inputPrevouts,
      candidate.sighashType,
      candidate.annex
    )
    const draftChallengeIdentity =
      computeP2TRSignatureFraudDraftChallengeIdentity({
        walletID: candidate.walletID,
        sighash,
        signature: candidate.signature,
        sighashType: candidate.sighashType,
        signedInputIndex: candidate.inputIndex,
        unsignedTransaction,
        inputPrevouts,
      })
    const bridgeChallengeIdentity =
      computeP2TRSignatureFraudBridgeChallengeIdentity({
        walletID: candidate.walletID,
        sighash,
        signature: candidate.signature,
        sighashType: candidate.sighashType,
        signedInputIndex: candidate.inputIndex,
        unsignedTransaction,
        inputPrevouts,
      })
    const bridgeChallengeKey =
      bridgeChallengeDomain === undefined
        ? undefined
        : computeP2TRSignatureFraudBridgeChallengeKey({
            ...bridgeChallengeDomain,
            bridgeChallengeIdentity,
          })

    return {
      ...candidate,
      rawTransaction,
      unsignedTransaction,
      inputPrevouts,
      spendType,
      sighash,
      draftChallengeIdentity,
      bridgeChallengeIdentity,
      bridgeChallengeKey,
      observationID:
        bridgeChallengeKey ??
        computeP2TRWalletInputWitnessObservationID({
          rawTransaction,
          inputIndex: candidate.inputIndex,
          walletID: candidate.walletID,
          witnessSignature: candidate.witnessSignature,
          inputPrevouts,
          bridgeIdentifier,
        }),
    }
  })
}

export const validateP2TRSignatureFraudWitnessObservationConsistency = (
  observation: P2TRSignatureFraudWitnessObservation,
  context: P2TRSignatureFraudWitnessObservationConsistencyContext
): void => {
  const observationID = toBytes32Hex(
    observation.observationID,
    "Observation ID"
  )
  const expectedObservations = extractP2TRSignatureFraudWitnessObservations(
    observation.rawTransaction,
    observation.inputPrevouts,
    context.registeredWalletIDs,
    context.bridgeIdentifier,
    context.spendTypeClassifier,
    context.payloadBounds,
    context.bridgeChallengeDomain,
    context.walletInputKeyBindings
  )
  const expectedObservation =
    expectedObservations.find((expected) =>
      expected.observationID.equals(observationID)
    ) ??
    expectedObservations.find(
      (expected) =>
        expected.inputIndex === observation.inputIndex &&
        expected.walletID.equals(observation.walletID) &&
        expected.witnessSignature.equals(observation.witnessSignature)
    )

  if (expectedObservation === undefined) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower observation cannot be reconstructed from stored witness data"
    )
  }

  const expectedSerialized =
    serializeP2TRSignatureFraudWitnessObservation(expectedObservation)
  const actualSerialized =
    serializeP2TRSignatureFraudWitnessObservation(observation)

  if (JSON.stringify(actualSerialized) !== JSON.stringify(expectedSerialized)) {
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "Watchtower observation fields do not match reconstructed witness data"
    )
  }
}

/**
 * Observation-only P2TR fraud evidence index and lifecycle store.
 *
 * Automatic challenge submission is hard-disabled while the FROST fraud layer
 * is bounded/no-go. Observation and manual lifecycle reconciliation remain
 * available without activating the incomplete fraud protocol.
 */
export class P2TRSignatureFraudWatchtower {
  private registeredWalletIDs: Set<string>

  constructor(
    private readonly store: P2TRWatchtowerChallengeStore,
    registeredWalletIDs: (Hex | Buffer | string)[],
    private readonly bridgeIdentifier?: Hex | Buffer | string,
    private readonly spendTypeClassifier?: P2TRSignatureFraudSpendTypeClassifier,
    private readonly payloadBounds?: P2TRSignatureFraudPayloadBounds,
    private readonly bridgeChallengeDomain?: P2TRSignatureFraudBridgeChallengeDomain
  ) {
    this.registeredWalletIDs = new Set(
      registeredWalletIDs.map((walletID) =>
        toBytes32Hex(walletID, "Registered wallet ID").toString()
      )
    )
  }

  replaceRegisteredWalletIDs(walletIDs: (Hex | Buffer | string)[]): void {
    this.registeredWalletIDs = new Set(
      walletIDs.map((walletID) =>
        toBytes32Hex(walletID, "Registered wallet ID").toString()
      )
    )
  }

  async observeMempoolTransaction(
    rawTransaction: BitcoinRawTx,
    inputPrevouts: P2TRWalletInputObservationPrevout[],
    bitcoinTxHash: Hex | Buffer | string,
    walletInputKeyBindings: P2TRWalletInputKeyBinding[] = []
  ): Promise<P2TRSignatureFraudWatchtowerObservationResult[]> {
    const observations = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      inputPrevouts,
      [...this.registeredWalletIDs],
      this.bridgeIdentifier,
      this.spendTypeClassifier,
      this.payloadBounds,
      this.bridgeChallengeDomain,
      walletInputKeyBindings
    )

    return Promise.all(
      observations.map(async (observation) => ({
        observation,
        record: await recordP2TRWatchtowerChallengeEvent(this.store, {
          type: "mempool-observed",
          observationID: observation.observationID,
          observation,
          bitcoinTxHash,
        }),
      }))
    )
  }

  async observeMempoolTransactionWithResolvedPrevouts(
    rawTransaction: BitcoinRawTx,
    bitcoinClient: BitcoinClient,
    bitcoinTxHash: Hex | Buffer | string,
    walletInputKeyBindings: P2TRWalletInputKeyBinding[] = []
  ): Promise<P2TRSignatureFraudWatchtowerObservationResult[]> {
    return this.observeMempoolTransaction(
      rawTransaction,
      await resolveP2TRInputPrevouts(rawTransaction, bitcoinClient),
      bitcoinTxHash,
      walletInputKeyBindings
    )
  }

  async observeConfirmedTransaction(
    rawTransaction: BitcoinRawTx,
    inputPrevouts: P2TRWalletInputObservationPrevout[],
    bitcoinTxHash: Hex | Buffer | string,
    bitcoinBlockHash: Hex | Buffer | string,
    bitcoinBlockHeight: number,
    walletInputKeyBindings: P2TRWalletInputKeyBinding[] = [],
    bitcoinWtxid?: Hex | Buffer | string
  ): Promise<P2TRSignatureFraudWatchtowerObservationResult[]> {
    const observations = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      inputPrevouts,
      [...this.registeredWalletIDs],
      this.bridgeIdentifier,
      this.spendTypeClassifier,
      this.payloadBounds,
      this.bridgeChallengeDomain,
      walletInputKeyBindings
    )

    return Promise.all(
      observations.map(async (observation) => ({
        observation,
        record: await recordP2TRWatchtowerChallengeEvent(this.store, {
          type: "bitcoin-confirmed",
          observationID: observation.observationID,
          observation,
          bitcoinTxHash,
          bitcoinWtxid,
          bitcoinBlockHash,
          bitcoinBlockHeight,
        }),
      }))
    )
  }

  async observeConfirmedTransactionWithResolvedPrevouts(
    rawTransaction: BitcoinRawTx,
    bitcoinClient: BitcoinClient,
    bitcoinTxHash: Hex | Buffer | string,
    bitcoinBlockHash: Hex | Buffer | string,
    bitcoinBlockHeight: number,
    walletInputKeyBindings: P2TRWalletInputKeyBinding[] = [],
    bitcoinWtxid?: Hex | Buffer | string
  ): Promise<P2TRSignatureFraudWatchtowerObservationResult[]> {
    return this.observeConfirmedTransaction(
      rawTransaction,
      await resolveP2TRInputPrevouts(rawTransaction, bitcoinClient),
      bitcoinTxHash,
      bitcoinBlockHash,
      bitcoinBlockHeight,
      walletInputKeyBindings,
      bitcoinWtxid
    )
  }

  async markMempoolTransactionEvicted(
    observationID: Hex | Buffer | string
  ): Promise<P2TRWatchtowerChallengeRecord> {
    return recordP2TRWatchtowerChallengeEvent(this.store, {
      type: "mempool-evicted",
      observationID,
    })
  }

  async markConfirmedTransactionReorged(
    observationID: Hex | Buffer | string,
    expectedCanonicalIdentity?: P2TRWatchtowerCanonicalBitcoinCandidateIdentity
  ): Promise<P2TRWatchtowerChallengeRecord> {
    return recordP2TRWatchtowerChallengeEvent(this.store, {
      type: "bitcoin-reorged",
      observationID,
      expectedCanonicalIdentity,
    })
  }

  async markChallengeDefeated(
    observationID: Hex | Buffer | string,
    defeatTxHash: Hex | Buffer | string
  ): Promise<P2TRWatchtowerChallengeRecord> {
    return recordP2TRWatchtowerChallengeEvent(this.store, {
      type: "defeated",
      observationID,
      defeatTxHash,
    })
  }

  async markChallengeHonestSpendProven(
    observationID: Hex | Buffer | string,
    bitcoinTxHash?: Hex | Buffer | string
  ): Promise<P2TRWatchtowerChallengeRecord> {
    const event: P2TRWatchtowerChallengeEvent = {
      type: "honest-spend-proven",
      observationID,
    }

    if (bitcoinTxHash !== undefined) {
      event.bitcoinTxHash = bitcoinTxHash
    }

    return recordP2TRWatchtowerChallengeEvent(this.store, event)
  }

  async markChallengeTimeoutEligible(
    observationID: Hex | Buffer | string
  ): Promise<P2TRWatchtowerChallengeRecord> {
    return recordP2TRWatchtowerChallengeEvent(this.store, {
      type: "timeout-eligible",
      observationID,
    })
  }

  async markChallengeSlashed(
    observationID: Hex | Buffer | string,
    slashingTxHash: Hex | Buffer | string
  ): Promise<P2TRWatchtowerChallengeRecord> {
    return recordP2TRWatchtowerChallengeEvent(this.store, {
      type: "slashed",
      observationID,
      slashingTxHash,
    })
  }

  async markChallengeRewarded(
    observationID: Hex | Buffer | string,
    rewardTxHash: Hex | Buffer | string
  ): Promise<P2TRWatchtowerChallengeRecord> {
    return recordP2TRWatchtowerChallengeEvent(this.store, {
      type: "rewarded",
      observationID,
      rewardTxHash,
    })
  }

  async reconcileChallengeBroadcast(
    observationID: Hex | Buffer | string,
    resolution: P2TRSignatureFraudChallengeBroadcastResolution
  ): Promise<P2TRWatchtowerChallengeRecord> {
    return recordP2TRWatchtowerChallengeEventWithRetry(this.store, {
      type: "submission-broadcast-reconciled",
      observationID,
      resolution,
      reconciledAtUnixMs: Date.now(),
    })
  }

  async raiseChallengeOperatorAlert(
    observationID: Hex | Buffer | string,
    code: string,
    message: string
  ): Promise<P2TRWatchtowerChallengeRecord> {
    return recordP2TRWatchtowerChallengeEvent(this.store, {
      type: "operator-alert-raised",
      observationID,
      code,
      message,
    })
  }

  async acknowledgeChallengeOperatorAlert(
    observationID: Hex | Buffer | string,
    acknowledgedBy: string
  ): Promise<P2TRWatchtowerChallengeRecord> {
    return recordP2TRWatchtowerChallengeEvent(this.store, {
      type: "operator-alert-acknowledged",
      observationID,
      acknowledgedBy,
    })
  }

  async clearChallengeOperatorAlert(
    observationID: Hex | Buffer | string
  ): Promise<P2TRWatchtowerChallengeRecord> {
    return recordP2TRWatchtowerChallengeEvent(this.store, {
      type: "operator-alert-cleared",
      observationID,
    })
  }

  /**
   * Always rejects while automatic P2TR fraud submission is disabled.
   *
   * A future activation requires a separately reviewed `COMPLETE_V2` evidence
   * protocol, durable broadcast outbox, and canonical independent
   * reconciliation design.
   * @param observation Compatibility-only observed evidence; it is never
   *        submitted by this method.
   * @param submitter Compatibility-only low-level submitter; it is never
   *        invoked by this method.
   * @param submissionPolicy Compatibility-only policy; it cannot enable
   *        submission.
   * @returns A rejected promise while the fraud layer remains bounded/no-go.
   */
  async submitChallenge(
    observation: P2TRSignatureFraudWitnessObservation,
    submitter: P2TRSignatureFraudChallengeSubmitter,
    submissionPolicy: P2TRSignatureFraudChallengeSubmissionPolicy = {}
  ): Promise<P2TRWatchtowerChallengeRecord> {
    void observation
    void submitter
    void submissionPolicy
    throw new P2TRWitnessSignatureError(
      "invalid-watchtower-state",
      "P2TR signature-fraud watchtower challenge submission is disabled while the FROST fraud layer is bounded/no-go; COMPLETE_V2 activation requires a separately reviewed durable outbox and canonical independent reconciliation design"
    )
  }
}

/**
 * Observation-only transaction and Bridge-lifecycle processing runner.
 *
 * The submission constructor surface is retained for API compatibility, but
 * `submitChallenges: true` always rejects and no automatic broadcast occurs.
 */
export class P2TRSignatureFraudWatchtowerRunner {
  private readonly maxSubmissionAttempts?: number
  private readonly submissionAttemptLimitAlert?: P2TRWatchtowerOperatorAlert
  private readonly broadcastReconciler?: P2TRSignatureFraudChallengeBroadcastReconciler

  constructor(
    private readonly watchtower: P2TRSignatureFraudWatchtower,
    private readonly bitcoinClient: BitcoinClient,
    /** Compatibility-only low-level submitter; this runner never invokes it. */
    _submitter: P2TRSignatureFraudChallengeSubmitter,
    /** Observation-only options; `submitChallenges: true` always rejects. */
    options: P2TRSignatureFraudWatchtowerRunnerOptions = {},
    /** Future `COMPLETE_V2` scaffolding; it cannot enable submission. */
    broadcastReconciler?: P2TRSignatureFraudChallengeBroadcastReconciler
  ) {
    this.broadcastReconciler = broadcastReconciler
    if (
      options.submitChallenges !== undefined &&
      typeof options.submitChallenges !== "boolean"
    ) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Watchtower submit-challenges option must be a boolean"
      )
    }

    if (options.submitChallenges === true) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Automatic P2TR signature-fraud challenge submission is disabled while the FROST fraud layer is bounded/no-go; COMPLETE_V2 activation requires a separately reviewed durable outbox and canonical independent reconciliation design"
      )
    }

    if (
      options.maxSubmissionAttempts !== undefined &&
      (!Number.isInteger(options.maxSubmissionAttempts) ||
        options.maxSubmissionAttempts <= 0)
    ) {
      throw new P2TRWitnessSignatureError(
        "invalid-watchtower-state",
        "Maximum watchtower submission attempts must be a positive integer"
      )
    }

    if (options.submissionAttemptLimitAlert !== undefined) {
      if (
        typeof options.submissionAttemptLimitAlert.code !== "string" ||
        options.submissionAttemptLimitAlert.code.length === 0 ||
        typeof options.submissionAttemptLimitAlert.message !== "string" ||
        options.submissionAttemptLimitAlert.message.length === 0
      ) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Submission-attempt limit alert must include code and message"
        )
      }
    }

    this.maxSubmissionAttempts = options.maxSubmissionAttempts
    this.submissionAttemptLimitAlert = options.submissionAttemptLimitAlert
  }

  private hasReachedSubmissionAttemptLimit(
    record: P2TRWatchtowerChallengeRecord
  ): boolean {
    return (
      this.maxSubmissionAttempts !== undefined &&
      record.submissionAttempts >= this.maxSubmissionAttempts &&
      !isSubmissionClosedWatchtowerStatus(record.status)
    )
  }

  async processMempoolTransaction(
    rawTransaction: BitcoinRawTx,
    bitcoinTxHash: Hex | Buffer | string,
    walletInputKeyBindings: P2TRWalletInputKeyBinding[] = [],
    inputPrevouts?: P2TRWalletInputObservationPrevout[]
  ): Promise<P2TRSignatureFraudWatchtowerSubmissionResult[]> {
    return this.observationResultsWithoutSubmission(
      inputPrevouts === undefined
        ? await this.watchtower.observeMempoolTransactionWithResolvedPrevouts(
            rawTransaction,
            this.bitcoinClient,
            bitcoinTxHash,
            walletInputKeyBindings
          )
        : await this.watchtower.observeMempoolTransaction(
            rawTransaction,
            validateP2TRInputPrevouts(rawTransaction, inputPrevouts),
            bitcoinTxHash,
            walletInputKeyBindings
          )
    )
  }

  async processMempoolTransactions(
    transactions: P2TRWatchtowerMempoolTransaction[]
  ): Promise<P2TRSignatureFraudWatchtowerSubmissionResult[]> {
    const results = await Promise.all(
      transactions.map((transaction) =>
        this.processMempoolTransaction(
          transaction.rawTransaction,
          transaction.bitcoinTxHash,
          transaction.walletInputKeyBindings,
          transaction.inputPrevouts
        )
      )
    )

    return results.flat()
  }

  async processMempoolTransactionsSettled(
    transactions: P2TRWatchtowerMempoolTransaction[]
  ): Promise<
    P2TRSignatureFraudWatchtowerBatchResult<P2TRWatchtowerMempoolTransaction>
  > {
    return this.processTransactionsSettled(transactions, (transaction) =>
      this.processMempoolTransaction(
        transaction.rawTransaction,
        transaction.bitcoinTxHash,
        transaction.walletInputKeyBindings,
        transaction.inputPrevouts
      )
    )
  }

  async processConfirmedTransaction(
    rawTransaction: BitcoinRawTx,
    bitcoinTxHash: Hex | Buffer | string,
    bitcoinBlockHash: Hex | Buffer | string,
    bitcoinBlockHeight: number,
    walletInputKeyBindings: P2TRWalletInputKeyBinding[] = [],
    inputPrevouts?: P2TRWalletInputObservationPrevout[],
    canonicalBitcoinCandidateIdentity?: P2TRWatchtowerCanonicalBitcoinCandidateIdentity
  ): Promise<P2TRSignatureFraudWatchtowerSubmissionResult[]> {
    const bitcoinWtxid = validateCanonicalBitcoinCandidateIdentity(
      rawTransaction,
      bitcoinTxHash,
      bitcoinBlockHash,
      canonicalBitcoinCandidateIdentity
    )
    return this.observationResultsWithoutSubmission(
      inputPrevouts === undefined
        ? await this.watchtower.observeConfirmedTransactionWithResolvedPrevouts(
            rawTransaction,
            this.bitcoinClient,
            bitcoinTxHash,
            bitcoinBlockHash,
            bitcoinBlockHeight,
            walletInputKeyBindings,
            bitcoinWtxid
          )
        : await this.watchtower.observeConfirmedTransaction(
            rawTransaction,
            validateP2TRInputPrevouts(rawTransaction, inputPrevouts),
            bitcoinTxHash,
            bitcoinBlockHash,
            bitcoinBlockHeight,
            walletInputKeyBindings,
            bitcoinWtxid
          )
    )
  }

  async processConfirmedTransactions(
    transactions: P2TRWatchtowerConfirmedTransaction[]
  ): Promise<P2TRSignatureFraudWatchtowerSubmissionResult[]> {
    const results = await Promise.all(
      transactions.map((transaction) =>
        this.processConfirmedTransaction(
          transaction.rawTransaction,
          transaction.bitcoinTxHash,
          transaction.bitcoinBlockHash,
          transaction.bitcoinBlockHeight,
          transaction.walletInputKeyBindings,
          transaction.inputPrevouts,
          transaction.canonicalBitcoinCandidateIdentity
        )
      )
    )

    return results.flat()
  }

  async processConfirmedTransactionsSettled(
    transactions: P2TRWatchtowerConfirmedTransaction[]
  ): Promise<
    P2TRSignatureFraudWatchtowerBatchResult<P2TRWatchtowerConfirmedTransaction>
  > {
    return this.processTransactionsSettled(transactions, (transaction) =>
      this.processConfirmedTransaction(
        transaction.rawTransaction,
        transaction.bitcoinTxHash,
        transaction.bitcoinBlockHash,
        transaction.bitcoinBlockHeight,
        transaction.walletInputKeyBindings,
        transaction.inputPrevouts,
        transaction.canonicalBitcoinCandidateIdentity
      )
    )
  }

  private async observeMempoolTransactionsSettled(
    transactions: P2TRWatchtowerMempoolTransaction[],
    requireAuthenticatedPrevouts = false
  ): Promise<
    P2TRSignatureFraudWatchtowerBatchResult<P2TRWatchtowerMempoolTransaction>
  > {
    return this.processTransactionsSettled(transactions, async (transaction) =>
      this.observationResultsWithoutSubmission(
        transaction.inputPrevouts === undefined
          ? requireAuthenticatedPrevouts
            ? (() => {
                throw new P2TRWitnessSignatureError(
                  "invalid-prevout-map",
                  "Canonical transaction source omitted authenticated input prevouts"
                )
              })()
            : await this.watchtower.observeMempoolTransactionWithResolvedPrevouts(
                transaction.rawTransaction,
                this.bitcoinClient,
                transaction.bitcoinTxHash,
                transaction.walletInputKeyBindings
              )
          : await this.watchtower.observeMempoolTransaction(
              transaction.rawTransaction,
              validateP2TRInputPrevouts(
                transaction.rawTransaction,
                transaction.inputPrevouts
              ),
              transaction.bitcoinTxHash,
              transaction.walletInputKeyBindings
            )
      )
    )
  }

  private async observeConfirmedTransactionsSettled(
    transactions: P2TRWatchtowerConfirmedTransaction[],
    requireAuthenticatedPrevouts = false
  ): Promise<
    P2TRSignatureFraudWatchtowerBatchResult<P2TRWatchtowerConfirmedTransaction>
  > {
    return this.processTransactionsSettled(transactions, async (transaction) =>
      this.observationResultsWithoutSubmission(
        transaction.inputPrevouts === undefined
          ? requireAuthenticatedPrevouts
            ? (() => {
                throw new P2TRWitnessSignatureError(
                  "invalid-prevout-map",
                  "Canonical transaction source omitted authenticated input prevouts"
                )
              })()
            : await this.watchtower.observeConfirmedTransactionWithResolvedPrevouts(
                transaction.rawTransaction,
                this.bitcoinClient,
                transaction.bitcoinTxHash,
                transaction.bitcoinBlockHash,
                transaction.bitcoinBlockHeight,
                transaction.walletInputKeyBindings,
                validateCanonicalBitcoinCandidateIdentity(
                  transaction.rawTransaction,
                  transaction.bitcoinTxHash,
                  transaction.bitcoinBlockHash,
                  transaction.canonicalBitcoinCandidateIdentity,
                  requireAuthenticatedPrevouts
                )
              )
          : await this.watchtower.observeConfirmedTransaction(
              transaction.rawTransaction,
              validateP2TRInputPrevouts(
                transaction.rawTransaction,
                transaction.inputPrevouts
              ),
              transaction.bitcoinTxHash,
              transaction.bitcoinBlockHash,
              transaction.bitcoinBlockHeight,
              transaction.walletInputKeyBindings,
              validateCanonicalBitcoinCandidateIdentity(
                transaction.rawTransaction,
                transaction.bitcoinTxHash,
                transaction.bitcoinBlockHash,
                transaction.canonicalBitcoinCandidateIdentity,
                requireAuthenticatedPrevouts
              )
            )
      )
    )
  }

  async replayStoredChallenges(
    records: P2TRWatchtowerChallengeRecord[]
  ): Promise<P2TRSignatureFraudWatchtowerSubmissionResult[]> {
    return this.replayStoredChallengesAfterLifecycle(records, false)
  }

  private async replayStoredChallengesAfterLifecycle(
    records: P2TRWatchtowerChallengeRecord[],
    allowSubmissions: boolean
  ): Promise<P2TRSignatureFraudWatchtowerSubmissionResult[]> {
    const reconciledRecords = await Promise.all(
      records.map((record) => this.reconcileAmbiguousBroadcastRecord(record))
    )

    return Promise.all(
      reconciledRecords
        .filter(
          (record) =>
            record.observation !== undefined &&
            isReplayableWatchtowerStatus(record.status) &&
            record.bitcoinStatus !== "reorged" &&
            record.bitcoinStatus !== "evicted"
        )
        .map(async (record) => ({
          observation:
            record.observation as P2TRSignatureFraudWitnessObservation,
          record,
          submissionRecord: await this.withSubmissionAttemptLimitAlert(record),
        }))
    )
  }

  async replayStoredChallengeRecords(
    recordSource: P2TRWatchtowerChallengeRecordSource
  ): Promise<P2TRSignatureFraudWatchtowerSubmissionResult[]> {
    return this.replayStoredChallengesAfterLifecycle(
      await recordSource.listChallengeRecords(),
      false
    )
  }

  private async reconcileAmbiguousBroadcastRecord(
    record: P2TRWatchtowerChallengeRecord
  ): Promise<P2TRWatchtowerChallengeRecord> {
    if (
      record.status !== "submitting" &&
      record.status !== "broadcast-pending"
    ) {
      return record
    }

    let resolution: P2TRSignatureFraudChallengeBroadcastResolution
    const bridgeChallengeKey = record.observation?.bridgeChallengeKey

    if (this.broadcastReconciler === undefined) {
      resolution = {
        status: "unknown",
        reason:
          "Challenge broadcast finality cannot be reconciled because no canonical reconciler is configured",
      }
    } else if (bridgeChallengeKey === undefined) {
      resolution = {
        status: "unknown",
        reason:
          "Challenge broadcast finality cannot be reconciled because its Bridge challenge key is missing",
      }
    } else {
      try {
        resolution =
          await this.broadcastReconciler.reconcileSignatureFraudChallengeBroadcast(
            {
              observationID: record.observationID,
              bridgeChallengeKey,
              challengeTxHash: record.challengeTxHash,
              broadcastAtUnixMs: record.challengeBroadcastAtUnixMs,
              reconciliationAttempts:
                record.challengeBroadcastReconciliationAttempts ?? 0,
            }
          )
        if (
          resolution === undefined ||
          !challengeBroadcastResolutionStatuses.has(resolution.status) ||
          (resolution.status !== "accepted" &&
            (typeof resolution.reason !== "string" ||
              resolution.reason.length === 0))
        ) {
          resolution = {
            status: "unknown",
            reason:
              "Challenge broadcast finality reconciler returned an invalid result",
          }
        }
      } catch (error) {
        resolution = {
          status: "unknown",
          reason: `Challenge broadcast finality reconciliation failed: ${watchtowerSubmissionErrorMessage(
            error
          )}`,
        }
      }
    }

    return this.watchtower.reconcileChallengeBroadcast(
      record.observationID,
      resolution
    )
  }

  private registerCanonicalSourceWalletIDs(
    transactionSource: P2TRSignatureFraudWatchtowerTransactionSource,
    result: PromiseSettledResult<P2TRWatchtowerConfirmedTransactionSourceResult>
  ): PromiseSettledResult<P2TRWatchtowerConfirmedTransactionSourceResult> {
    if (
      transactionSource.p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts !==
      true
    ) {
      return result
    }
    if (
      result.status === "rejected" ||
      !isP2TRWatchtowerConfirmedTransactionSourceResult(result.value)
    ) {
      this.watchtower.replaceRegisteredWalletIDs([])
      return result
    }
    try {
      if (!Array.isArray(result.value.registeredWalletIDs)) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Canonical transaction source omitted its durable wallet registry"
        )
      }
      this.watchtower.replaceRegisteredWalletIDs(
        result.value.registeredWalletIDs
      )
      return result
    } catch (error) {
      this.watchtower.replaceRegisteredWalletIDs([])
      return { status: "rejected", reason: error }
    }
  }

  private async reconcileCanonicalSourceOrphans(
    transactionSource: P2TRSignatureFraudWatchtowerTransactionSource,
    result: PromiseSettledResult<P2TRWatchtowerConfirmedTransactionSourceResult>,
    records: P2TRWatchtowerChallengeRecord[]
  ): Promise<
    PromiseSettledResult<P2TRWatchtowerConfirmedTransactionSourceResult>
  > {
    if (
      transactionSource.p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts !==
        true ||
      result.status === "rejected" ||
      !isP2TRWatchtowerConfirmedTransactionSourceResult(result.value)
    ) {
      return result
    }

    try {
      if (!Array.isArray(result.value.orphanedConfirmedTransactions)) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Canonical transaction source omitted its orphaned candidate set"
        )
      }
      const seen = new Set<string>()
      for (const identity of result.value.orphanedConfirmedTransactions) {
        const bitcoinTxHash = toBytes32Hex(
          identity.bitcoinTxHash,
          "Orphaned Bitcoin transaction hash"
        )
        const bitcoinWtxid = toBytes32Hex(
          identity.bitcoinWtxid,
          "Orphaned Bitcoin witness transaction hash"
        )
        const bitcoinBlockHash = toBytes32Hex(
          identity.bitcoinBlockHash,
          "Orphaned Bitcoin block hash"
        )
        const identityKey = `${bitcoinBlockHash}:${bitcoinTxHash}:${bitcoinWtxid}`
        if (seen.has(identityKey)) {
          throw new P2TRWitnessSignatureError(
            "invalid-watchtower-state",
            "Canonical transaction source returned a duplicate orphaned candidate"
          )
        }
        seen.add(identityKey)

        const matchingRecords = records.filter(
          (record) =>
            record.bitcoinStatus === "confirmed" &&
            record.bitcoinTxHash?.equals(bitcoinTxHash) === true &&
            record.bitcoinBlockHash?.equals(bitcoinBlockHash) === true &&
            (record.bitcoinWtxid === undefined ||
              record.bitcoinWtxid.equals(bitcoinWtxid))
        )
        for (const record of matchingRecords) {
          await this.watchtower.markConfirmedTransactionReorged(
            record.observationID,
            {
              bitcoinTxHash,
              bitcoinWtxid,
              bitcoinBlockHash,
            }
          )
        }
      }
      return result
    } catch (error) {
      return { status: "rejected", reason: error }
    }
  }

  async processTransactionSourceSettled(
    transactionSource: P2TRSignatureFraudWatchtowerTransactionSource,
    recordSource: P2TRWatchtowerChallengeRecordSource
  ): Promise<P2TRSignatureFraudWatchtowerCycleResult> {
    const cycleStartRecords = await recordSource.listChallengeRecords()
    const cycleStartRecordIDs = new Set(
      cycleStartRecords.map((record) => record.observationID.toString())
    )
    const [mempoolTransactions, listedConfirmedTransactions] =
      await Promise.allSettled([
        transactionSource.listMempoolTransactions(),
        transactionSource.listConfirmedTransactions(),
      ])
    const confirmedTransactions = await this.reconcileCanonicalSourceOrphans(
      transactionSource,
      this.registerCanonicalSourceWalletIDs(
        transactionSource,
        listedConfirmedTransactions
      ),
      cycleStartRecords
    )
    const sourceFailures: P2TRSignatureFraudWatchtowerSourceFailure[] = []
    const confirmedSourceComplete =
      confirmedTransactions.status === "fulfilled" &&
      isP2TRWatchtowerConfirmedTransactionSourceResult(
        confirmedTransactions.value
      ) &&
      confirmedTransactions.value.complete === true

    const observedMempool = await this.processTransactionSourceResult(
      "mempool",
      mempoolTransactions,
      sourceFailures,
      (transactions) =>
        this.observeMempoolTransactionsSettled(
          transactions,
          transactionSource.p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts ===
            true
        )
    )
    const observedConfirmed = await this.processConfirmedSourceResult(
      "confirmed",
      confirmedTransactions,
      sourceFailures,
      (transactions) =>
        this.observeConfirmedTransactionsSettled(
          transactions,
          transactionSource.p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts ===
            true
        )
    )
    const replayed = await this.replayStoredChallenges(
      (
        await recordSource.listChallengeRecords()
      ).filter((record) =>
        cycleStartRecordIDs.has(record.observationID.toString())
      )
    )

    return {
      replayed,
      mempool: observedMempool,
      confirmed: observedConfirmed,
      confirmedSourceComplete,
      sourceFailures,
      summary: await summarizeP2TRWatchtowerChallengeRecords(recordSource),
      unresolvedOperatorAlerts:
        await listP2TRWatchtowerUnresolvedOperatorAlerts(recordSource),
    }
  }

  async processBridgeLifecycleEvent(
    event: P2TRSignatureFraudWatchtowerBridgeLifecycleEvent,
    recordSource?: P2TRWatchtowerChallengeRecordSource
  ): Promise<P2TRWatchtowerChallengeRecord | undefined> {
    const observationID = await resolveP2TRBridgeLifecycleEventObservationID(
      event,
      recordSource
    )

    if (observationID === undefined) {
      return undefined
    }

    switch (event.type) {
      case "defeated":
        return this.watchtower.markChallengeDefeated(
          observationID,
          event.defeatTxHash
        )

      case "honest-spend-proven":
        return this.watchtower.markChallengeHonestSpendProven(
          observationID,
          event.bitcoinTxHash
        )

      case "timeout-eligible":
        return this.watchtower.markChallengeTimeoutEligible(observationID)

      case "slashed":
        return this.watchtower.markChallengeSlashed(
          observationID,
          event.slashingTxHash
        )

      case "rewarded":
        return this.watchtower.markChallengeRewarded(
          observationID,
          event.rewardTxHash
        )
    }
  }

  async processBridgeLifecycleEventsSettled(
    events: P2TRSignatureFraudWatchtowerBridgeLifecycleEvent[],
    recordSource?: P2TRWatchtowerChallengeRecordSource
  ): Promise<P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult> {
    const settledResults: P2TRSignatureFraudWatchtowerSettledBridgeLifecycleResult[] =
      []

    for (const event of events) {
      try {
        const record = await this.processBridgeLifecycleEvent(
          event,
          recordSource
        )

        if (record === undefined) {
          settledResults.push({
            event,
            ignoredReason:
              "No matching watchtower challenge record for Bridge proof event",
          })
          continue
        }

        settledResults.push({
          event,
          record,
        })
      } catch (error) {
        settledResults.push({
          event,
          error: watchtowerSubmissionErrorMessage(error),
        })
      }
    }

    return settledResults.reduce<P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult>(
      (batchResult, settledResult) => {
        if ("error" in settledResult) {
          batchResult.failures.push({
            event: settledResult.event,
            error: settledResult.error,
          })
          return batchResult
        }

        if ("ignoredReason" in settledResult) {
          batchResult.ignored.push({
            event: settledResult.event,
            reason: settledResult.ignoredReason,
          })
          return batchResult
        }

        batchResult.records.push({
          event: settledResult.event,
          record: settledResult.record,
        })
        return batchResult
      },
      { records: [], failures: [], ignored: [] }
    )
  }

  async processBridgeLifecycleEventSourceSettled(
    eventSource: P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource,
    recordSource: P2TRWatchtowerChallengeRecordSource
  ): Promise<P2TRSignatureFraudWatchtowerBridgeLifecycleCycleResult> {
    const sourceFailures: P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure[] =
      []
    let bridgeLifecycle: P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult =
      { records: [], failures: [], ignored: [] }

    try {
      bridgeLifecycle = await this.processBridgeLifecycleEventsSettled(
        await eventSource.listBridgeLifecycleEvents(),
        recordSource
      )
    } catch (error) {
      sourceFailures.push({
        source: "bridge-lifecycle",
        error: watchtowerSubmissionErrorMessage(error),
      })
    }

    return {
      bridgeLifecycle,
      sourceFailures,
      summary: await summarizeP2TRWatchtowerChallengeRecords(recordSource),
      unresolvedOperatorAlerts:
        await listP2TRWatchtowerUnresolvedOperatorAlerts(recordSource),
    }
  }

  async processWatchtowerSourcesSettled(
    transactionSource: P2TRSignatureFraudWatchtowerTransactionSource,
    bridgeLifecycleEventSource: P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource,
    recordSource: P2TRWatchtowerChallengeRecordSource
  ): Promise<P2TRSignatureFraudWatchtowerIntegratedCycleResult> {
    const cycleStartRecords = await recordSource.listChallengeRecords()
    const cycleStartRecordIDs = new Set(
      cycleStartRecords.map((record) => record.observationID.toString())
    )
    const [
      mempoolTransactions,
      listedConfirmedTransactions,
      bridgeLifecycleEvents,
    ] = await Promise.allSettled([
      transactionSource.listMempoolTransactions(),
      transactionSource.listConfirmedTransactions(),
      bridgeLifecycleEventSource.listBridgeLifecycleEvents(),
    ])
    const confirmedTransactions = await this.reconcileCanonicalSourceOrphans(
      transactionSource,
      this.registerCanonicalSourceWalletIDs(
        transactionSource,
        listedConfirmedTransactions
      ),
      cycleStartRecords
    )
    const transactionSourceFailures: P2TRSignatureFraudWatchtowerSourceFailure[] =
      []
    const bridgeLifecycleSourceFailures: P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure[] =
      []

    const observedMempool = await this.processTransactionSourceResult(
      "mempool",
      mempoolTransactions,
      transactionSourceFailures,
      (transactions) =>
        this.observeMempoolTransactionsSettled(
          transactions,
          transactionSource.p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts ===
            true
        )
    )
    const observedConfirmed = await this.processConfirmedSourceResult(
      "confirmed",
      confirmedTransactions,
      transactionSourceFailures,
      (transactions) =>
        this.observeConfirmedTransactionsSettled(
          transactions,
          transactionSource.p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts ===
            true
        )
    )
    const bridgeLifecycle = await this.processBridgeLifecycleSourceResult(
      bridgeLifecycleEvents,
      bridgeLifecycleSourceFailures,
      recordSource
    )
    const confirmedSourceComplete =
      confirmedTransactions.status === "fulfilled" &&
      isP2TRWatchtowerConfirmedTransactionSourceResult(
        confirmedTransactions.value
      ) &&
      confirmedTransactions.value.complete === true
    const allowSubmissions =
      bridgeLifecycleEvents.status === "fulfilled" &&
      bridgeLifecycle.failures.length === 0 &&
      transactionSourceFailures.length === 0 &&
      observedMempool.failures.length === 0 &&
      observedConfirmed.failures.length === 0 &&
      confirmedSourceComplete
    const currentCycleStartRecords = (
      await recordSource.listChallengeRecords()
    ).filter((record) =>
      cycleStartRecordIDs.has(record.observationID.toString())
    )
    const replayed = await this.replayStoredChallengesAfterLifecycle(
      currentCycleStartRecords,
      allowSubmissions
    )

    const mempool = await this.submitPersistedObservationBatch(
      observedMempool,
      recordSource,
      allowSubmissions
    )
    const confirmed = await this.submitPersistedObservationBatch(
      observedConfirmed,
      recordSource,
      allowSubmissions
    )

    return {
      replayed,
      mempool,
      confirmed,
      confirmedSourceComplete,
      bridgeLifecycle,
      sourceFailures: [
        ...transactionSourceFailures,
        ...bridgeLifecycleSourceFailures,
      ],
      summary: await summarizeP2TRWatchtowerChallengeRecords(recordSource),
      unresolvedOperatorAlerts:
        await listP2TRWatchtowerUnresolvedOperatorAlerts(recordSource),
    }
  }

  private async submitPersistedObservationBatch<T>(
    batch: P2TRSignatureFraudWatchtowerBatchResult<T>,
    recordSource: P2TRWatchtowerChallengeRecordSource,
    allowSubmissions: boolean
  ): Promise<P2TRSignatureFraudWatchtowerBatchResult<T>> {
    if (!allowSubmissions || batch.submissions.length === 0) {
      return batch
    }

    const records = new Map(
      (await recordSource.listChallengeRecords()).map((record) => [
        record.observationID.toString(),
        record,
      ])
    )
    const submissions: P2TRSignatureFraudWatchtowerSubmissionResult[] = []

    // Process sequentially. A mempool and confirmed batch can contain the same
    // observation, and a second submission decision must see the first one's
    // durable state rather than race it.
    for (const result of batch.submissions) {
      const observationID = result.observation.observationID.toString()
      const record = records.get(observationID)
      if (record?.observation === undefined) {
        throw new P2TRWitnessSignatureError(
          "invalid-watchtower-state",
          "Observed challenge record disappeared before reconciled submission"
        )
      }

      const observation = record.observation
      const submissionRecord = await this.withSubmissionAttemptLimitAlert(
        record
      )

      submissions.push({ observation, record, submissionRecord })
      records.set(observationID, submissionRecord)
    }

    return { ...batch, submissions }
  }

  private observationResultsWithoutSubmission(
    observationResults: P2TRSignatureFraudWatchtowerObservationResult[]
  ): P2TRSignatureFraudWatchtowerSubmissionResult[] {
    return observationResults.map((result) => ({
      ...result,
      submissionRecord: result.record,
    }))
  }

  private async processTransactionSourceResult<T>(
    source: P2TRSignatureFraudWatchtowerTransactionSourceName,
    sourceResult: PromiseSettledResult<T[]>,
    sourceFailures: P2TRSignatureFraudWatchtowerSourceFailure[],
    processTransactions: (
      transactions: T[]
    ) => Promise<P2TRSignatureFraudWatchtowerBatchResult<T>>
  ): Promise<P2TRSignatureFraudWatchtowerBatchResult<T>> {
    if (sourceResult.status === "rejected") {
      sourceFailures.push({
        source,
        error: watchtowerSubmissionErrorMessage(sourceResult.reason),
      })

      return { submissions: [], failures: [] }
    }

    return processTransactions(sourceResult.value)
  }

  private async processConfirmedSourceResult(
    source: "confirmed",
    sourceResult: PromiseSettledResult<P2TRWatchtowerConfirmedTransactionSourceResult>,
    sourceFailures: P2TRSignatureFraudWatchtowerSourceFailure[],
    processTransactions: (
      transactions: P2TRWatchtowerConfirmedTransaction[]
    ) => Promise<
      P2TRSignatureFraudWatchtowerBatchResult<P2TRWatchtowerConfirmedTransaction>
    >
  ): Promise<
    P2TRSignatureFraudWatchtowerBatchResult<P2TRWatchtowerConfirmedTransaction>
  > {
    if (sourceResult.status === "rejected") {
      sourceFailures.push({
        source,
        error: watchtowerSubmissionErrorMessage(sourceResult.reason),
      })

      return { submissions: [], failures: [] }
    }

    if (!isP2TRWatchtowerConfirmedTransactionSourceResult(sourceResult.value)) {
      sourceFailures.push({
        source,
        error:
          "Confirmed transaction source returned an invalid bounded-history result",
      })
      return { submissions: [], failures: [] }
    }

    return processTransactions(sourceResult.value.transactions)
  }

  private async processBridgeLifecycleSourceResult(
    sourceResult: PromiseSettledResult<
      P2TRSignatureFraudWatchtowerBridgeLifecycleEvent[]
    >,
    sourceFailures: P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure[],
    recordSource: P2TRWatchtowerChallengeRecordSource
  ): Promise<P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult> {
    if (sourceResult.status === "rejected") {
      sourceFailures.push({
        source: "bridge-lifecycle",
        error: watchtowerSubmissionErrorMessage(sourceResult.reason),
      })

      return { records: [], failures: [], ignored: [] }
    }

    return this.processBridgeLifecycleEventsSettled(
      sourceResult.value,
      recordSource
    )
  }

  private async withSubmissionAttemptLimitAlert(
    record: P2TRWatchtowerChallengeRecord
  ): Promise<P2TRWatchtowerChallengeRecord> {
    if (
      this.submissionAttemptLimitAlert === undefined ||
      !this.hasReachedSubmissionAttemptLimit(record) ||
      record.operatorAlertStatus !== undefined
    ) {
      return record
    }

    return this.watchtower.raiseChallengeOperatorAlert(
      record.observationID,
      this.submissionAttemptLimitAlert.code,
      this.submissionAttemptLimitAlert.message
    )
  }

  private async processTransactionsSettled<T>(
    transactions: T[],
    processTransaction: (
      transaction: T
    ) => Promise<P2TRSignatureFraudWatchtowerSubmissionResult[]>
  ): Promise<P2TRSignatureFraudWatchtowerBatchResult<T>> {
    const settledResults: P2TRSignatureFraudWatchtowerSettledProcessingResult<T>[] =
      await Promise.all(
        transactions.map(async (transaction) => {
          try {
            return {
              transaction,
              submissions: await processTransaction(transaction),
            }
          } catch (error) {
            return {
              transaction,
              error: watchtowerSubmissionErrorMessage(error),
            }
          }
        })
      )

    return settledResults.reduce<P2TRSignatureFraudWatchtowerBatchResult<T>>(
      (batchResult, settledResult) => {
        if ("error" in settledResult) {
          batchResult.failures.push({
            transaction: settledResult.transaction,
            error: settledResult.error,
          })
          return batchResult
        }

        batchResult.submissions.push(...settledResult.submissions)
        return batchResult
      },
      { submissions: [], failures: [] }
    )
  }
}
