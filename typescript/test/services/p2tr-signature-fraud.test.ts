import fs from "fs"
import path from "path"

import { expect } from "chai"
import { Transaction } from "bitcoinjs-lib"
import { BigNumber, BigNumberish, constants, utils } from "ethers"

import { BitcoinClient, BitcoinRawTx } from "../../src/lib/bitcoin"
import {
  applyP2TRWatchtowerChallengeEvent,
  computeP2TRKeyPathSighash,
  computeP2TRSignatureFraudBridgeChallengeIdentity,
  computeP2TRSignatureFraudBridgeChallengeKey,
  computeP2TRSignatureFraudDraftChallengeIdentity,
  computeP2TRWalletInputWitnessObservationID,
  createP2TRWatchtowerChallengeRecord,
  deserializeP2TRSignatureFraudWitnessObservation,
  deserializeP2TRWatchtowerChallengeRecord,
  extractP2TRWalletIDFromScriptPubKey,
  extractP2TRWalletInputWitnessCandidates,
  extractP2TRKeyPathInputWitnessSignature,
  extractP2TRSignatureFraudWitnessObservations,
  parseP2TRKeyPathWitnessSignature,
  listP2TRWatchtowerUnresolvedOperatorAlerts,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING,
  P2TR_SIGNATURE_FRAUD_BRIDGE_ACTION_SUBMIT,
  P2TR_SIGNATURE_FRAUD_BRIDGE_CHALLENGE_PAYLOAD_ABI_TYPE,
  P2TR_SIGHASH_ALL,
  P2TR_SIGHASH_DEFAULT,
  buildP2TRSignatureFraudBridgeChallengePayload,
  P2TRSignatureFraudChallengeSubmitter,
  P2TRSignatureFraudChallengeBroadcastReconciler,
  P2TRSignatureFraudChallengeBroadcastResolution,
  P2TRSignatureFraudBridgeChallengeSubmitter,
  P2TRSignatureFraudChallengeSubmissionPolicy,
  P2TRSignatureFraudSpendType,
  P2TRSignatureFraudSpendTypeClassifier,
  P2TRSignatureFraudWitnessObservation,
  P2TRSignatureFraudWatchtower,
  P2TRSignatureFraudWatchtowerRunner,
  P2TRWatchtowerChallengeRecord,
  P2TRWatchtowerChallengeRecordJSON,
  P2TRWatchtowerChallengeRecordPersistence,
  P2TRWatchtowerChallengeReplayStore,
  P2TRWatchtowerChallengeStore,
  P2TRWatchtowerSerializedChallengeStore,
  P2TRWitnessSignatureError,
  P2TRWitnessSignatureErrorCode,
  createP2TRSignatureFraudSpendTypeClassifier,
  recordP2TRWatchtowerChallengeEvent,
  encodeP2TRSignatureFraudBridgeChallengePayload,
  resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType,
  resolveP2TRInputPrevouts,
  serializeP2TRSignatureFraudWitnessObservation,
  serializeP2TRWatchtowerChallengeRecord,
  stripWitnessesFromBitcoinRawTransaction,
  summarizeP2TRWatchtowerChallengeRecords,
  validateP2TRSignatureFraudPayloadBounds,
  validateP2TRSignatureFraudWitnessObservationConsistency,
} from "../../src/services/maintenance/p2tr-signature-fraud"
import { Hex } from "../../src/lib/utils"

type SignatureFraudVector = {
  id: string
  walletIDHex: string
  unsignedTransactionHex: string
  signedInputIndex: number
  prevouts: PrevoutVector[]
  sighashType: number
  expectedBip341SighashHex: string
  bip340SignatureHex: string
  witnessSignatureHex: string
  annexHex?: string
  expectedDraftChallengeIdentityHex: string
  expectedBridgeChallengeIdentityHex: string
  flowMetadata?: {
    spendType: P2TRSignatureFraudSpendType
    evidenceLevel: string
    sourceWalletInput: number
    requiredBridgeEvent: string
    proofEventCorrelation: string
    positiveAssertions: string[]
    knownLimits: string[]
  }
}

type PrevoutVector = {
  txidHex: string
  vout: number
  valueSats: number | string
  scriptPubKeyHex: string
}

type NegativeWitnessVector = {
  id: string
  witnessSignatureHex: string
  expectedError: "invalid-length" | "unsupported-sighash"
}

type SignatureFraudVectorCorpus = {
  name: string
  cases: SignatureFraudVector[]
  negativeWitnessCases: NegativeWitnessVector[]
}

type CompleteChallengeEvidenceVectorCorpus = {
  cases: {
    id: string
    walletKey: {
      encodedEvidence: string
    }
  }[]
}

const vectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-signature-fraud-v0.json"
)
const fullSighashVectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-signature-fraud-full-sighash-v0.json"
)
const completeChallengeEvidenceVectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-complete-v2-challenge-evidence-v1.json"
)

const loadVectorCorpus = (): SignatureFraudVectorCorpus =>
  JSON.parse(
    fs.readFileSync(vectorCorpusPath, "utf8")
  ) as SignatureFraudVectorCorpus

const loadFullSighashVectorCorpus = (): { cases: SignatureFraudVector[] } =>
  JSON.parse(fs.readFileSync(fullSighashVectorCorpusPath, "utf8")) as {
    cases: SignatureFraudVector[]
  }

const loadCompleteChallengeEvidenceVectorCorpus =
  (): CompleteChallengeEvidenceVectorCorpus =>
    JSON.parse(
      fs.readFileSync(completeChallengeEvidenceVectorCorpusPath, "utf8")
    ) as CompleteChallengeEvidenceVectorCorpus

const withInputWitness = (
  unsignedTransactionHex: string,
  inputIndex: number,
  witnessSignatureHex: string,
  annexHex?: string
): BitcoinRawTx => {
  const transaction = Transaction.fromHex(unsignedTransactionHex)
  transaction.ins[inputIndex].witness = [
    Buffer.from(witnessSignatureHex, "hex"),
    ...(annexHex === undefined || annexHex.length === 0
      ? []
      : [Buffer.from(annexHex, "hex")]),
  ]

  return { transactionHex: transaction.toHex() }
}

const toObservationPrevouts = (vector: SignatureFraudVector) =>
  vector.prevouts.map((prevout) => ({
    txid: prevout.txidHex,
    vout: prevout.vout,
    valueSats: prevout.valueSats,
    scriptPubKey: prevout.scriptPubKeyHex,
  }))

const expectWitnessError = (
  fn: () => unknown,
  expectedCode: P2TRWitnessSignatureErrorCode
) => {
  try {
    fn()
  } catch (error) {
    expect(error).to.be.instanceOf(P2TRWitnessSignatureError)
    expect((error as P2TRWitnessSignatureError).code).to.equal(expectedCode)
    return
  }

  throw new Error(`Expected P2TR witness parser error ${expectedCode}`)
}

const expectWitnessRejection = async (
  fn: () => Promise<unknown>,
  expectedCode: P2TRWitnessSignatureErrorCode
) => {
  try {
    await fn()
  } catch (error) {
    expect(error).to.be.instanceOf(P2TRWitnessSignatureError)
    expect((error as P2TRWitnessSignatureError).code).to.equal(expectedCode)
    return
  }

  throw new Error(`Expected P2TR witness parser rejection ${expectedCode}`)
}

const txHash = (nibble: string): string => nibble.repeat(64)

const authenticatedBitcoinTxHash = (rawTransaction: BitcoinRawTx): string =>
  Transaction.fromHex(rawTransaction.transactionHex).getId()

const recordSubmittedChallenge = async (
  store: P2TRWatchtowerChallengeStore,
  observation: P2TRSignatureFraudWitnessObservation,
  challengeTxHash: Hex | Buffer | string
): Promise<P2TRWatchtowerChallengeRecord> => {
  await recordP2TRWatchtowerChallengeEvent(store, {
    type: "submission-started",
    observationID: observation.observationID,
    observation,
  })
  return recordP2TRWatchtowerChallengeEvent(store, {
    type: "submission-accepted",
    observationID: observation.observationID,
    challengeTxHash,
  })
}

const recordRejectedChallenge = async (
  store: P2TRWatchtowerChallengeStore,
  observation: P2TRSignatureFraudWitnessObservation,
  error: string
): Promise<P2TRWatchtowerChallengeRecord> => {
  await recordP2TRWatchtowerChallengeEvent(store, {
    type: "submission-started",
    observationID: observation.observationID,
    observation,
  })
  return recordP2TRWatchtowerChallengeEvent(store, {
    type: "submission-rejected",
    observationID: observation.observationID,
    error,
  })
}

const draftApprovedSpendTypeClassifier: P2TRSignatureFraudSpendTypeClassifier =
  () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION

const draftApprovedSubmissionPolicy: P2TRSignatureFraudChallengeSubmissionPolicy =
  {
    allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION],
  }

const bridgeChallengeDomain = {
  chainID: 11155111,
  bridgeAddress: "0x1111111111111111111111111111111111111111",
}

const completeBridgeChallengeEvidenceAbiType =
  "tuple(bytes32 walletID,bytes32 signingKey,bytes32 bindingTxHash,uint32 bindingOutputIndex,bytes32 sighash,bytes32 nonceX,bytes32 signatureScalar)"

const createDraftApprovedP2TRWatchtower = (
  store: P2TRWatchtowerChallengeStore,
  registeredWalletIDs: (Hex | Buffer | string)[],
  challengeDomain?: typeof bridgeChallengeDomain
): P2TRSignatureFraudWatchtower =>
  new P2TRSignatureFraudWatchtower(
    store,
    registeredWalletIDs,
    undefined,
    draftApprovedSpendTypeClassifier,
    undefined,
    challengeDomain
  )

const expectedVector0BridgeChallengeKey =
  "b3686a4383585912636eb96d0f1b20fb23ee7f20df148d4215120f126f96383c"

const computeBridgeChallengeIdentity = (vector: SignatureFraudVector): Hex => {
  const parsedWitness = parseP2TRKeyPathWitnessSignature(
    vector.witnessSignatureHex
  )
  const inputPrevouts = toObservationPrevouts(vector)
  const sighash = computeP2TRKeyPathSighash(
    { transactionHex: vector.unsignedTransactionHex },
    vector.signedInputIndex,
    inputPrevouts,
    parsedWitness.sighashType
  )

  return computeP2TRSignatureFraudBridgeChallengeIdentity({
    ...bridgeChallengeDomain,
    walletID: vector.walletIDHex,
    signingKey: vector.walletIDHex,
    sighash,
  })
}

const rawPreviousTransactionForPrevout = (
  prevout: PrevoutVector
): BitcoinRawTx => {
  const transaction = new Transaction()
  transaction.addInput(Buffer.alloc(32), 0xffffffff)

  for (let i = 0; i <= prevout.vout; i++) {
    transaction.addOutput(
      Buffer.from(i === prevout.vout ? prevout.scriptPubKeyHex : "51", "hex"),
      i === prevout.vout ? Number(prevout.valueSats) : 1
    )
  }

  return { transactionHex: transaction.toHex() }
}

class InMemoryP2TRWatchtowerChallengeStore
  implements P2TRWatchtowerChallengeStore, P2TRWatchtowerChallengeReplayStore
{
  private readonly records = new Map<string, P2TRWatchtowerChallengeRecord>()

  constructor(records: P2TRWatchtowerChallengeRecord[] = []) {
    records.forEach((record) => this.saveSync(record))
  }

  async getChallengeRecord(
    observationID: Hex
  ): Promise<P2TRWatchtowerChallengeRecord | undefined> {
    return this.records.get(observationID.toString())
  }

  async saveChallengeRecord(
    record: P2TRWatchtowerChallengeRecord
  ): Promise<void> {
    this.saveSync(record)
  }

  async listChallengeRecords(): Promise<P2TRWatchtowerChallengeRecord[]> {
    return [...this.records.values()]
  }

  private saveSync(record: P2TRWatchtowerChallengeRecord) {
    this.records.set(record.observationID.toString(), record)
  }
}

class InMemoryP2TRWatchtowerChallengeRecordPersistence
  implements P2TRWatchtowerChallengeRecordPersistence
{
  records: P2TRWatchtowerChallengeRecordJSON[]

  constructor(records: P2TRWatchtowerChallengeRecordJSON[] = []) {
    this.records = records
  }

  async loadChallengeRecords(): Promise<P2TRWatchtowerChallengeRecordJSON[]> {
    return this.records
  }

  async saveChallengeRecords(
    records: P2TRWatchtowerChallengeRecordJSON[]
  ): Promise<void> {
    this.records = records
  }
}

class FailingP2TRWatchtowerChallengeRecordPersistence extends InMemoryP2TRWatchtowerChallengeRecordPersistence {
  rejectSaves = false

  async saveChallengeRecords(
    records: P2TRWatchtowerChallengeRecordJSON[]
  ): Promise<void> {
    if (this.rejectSaves) {
      throw new Error("durable write rejected")
    }

    await super.saveChallengeRecords(records)
  }
}

class BlockingP2TRWatchtowerChallengeRecordPersistence extends InMemoryP2TRWatchtowerChallengeRecordPersistence {
  saveCalls = 0
  firstSaveStarted: Promise<void>
  private resolveFirstSaveStarted!: () => void
  private releaseFirstSave!: () => void
  private readonly firstSaveReleased: Promise<void>

  constructor(records: P2TRWatchtowerChallengeRecordJSON[] = []) {
    super(records)
    this.firstSaveStarted = new Promise((resolve) => {
      this.resolveFirstSaveStarted = resolve
    })
    this.firstSaveReleased = new Promise((resolve) => {
      this.releaseFirstSave = resolve
    })
  }

  async saveChallengeRecords(
    records: P2TRWatchtowerChallengeRecordJSON[]
  ): Promise<void> {
    this.saveCalls++

    if (this.saveCalls === 1) {
      this.resolveFirstSaveStarted()
      await this.firstSaveReleased
    }

    await super.saveChallengeRecords(records)
  }

  unblockFirstSave(): void {
    this.releaseFirstSave()
  }
}

type P2TRWatchtowerSaveBlock = {
  started: Promise<void>
  unblock(): void
}

class BlockingP2TRWatchtowerChallengeStore extends InMemoryP2TRWatchtowerChallengeStore {
  getCalls = 0
  private nextSaveBlock?: {
    resolveStarted(): void
    released: Promise<void>
  }

  async getChallengeRecord(
    observationID: Hex
  ): Promise<P2TRWatchtowerChallengeRecord | undefined> {
    this.getCalls++
    return super.getChallengeRecord(observationID)
  }

  async saveChallengeRecord(
    record: P2TRWatchtowerChallengeRecord
  ): Promise<void> {
    const saveBlock = this.nextSaveBlock
    if (saveBlock !== undefined) {
      this.nextSaveBlock = undefined
      saveBlock.resolveStarted()
      await saveBlock.released
    }

    await super.saveChallengeRecord(record)
  }

  blockNextSave(): P2TRWatchtowerSaveBlock {
    let resolveStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    this.nextSaveBlock = { resolveStarted, released }

    return { started, unblock: release }
  }
}

class FakeP2TRSignatureFraudChallengeSubmitter
  implements
    P2TRSignatureFraudChallengeSubmitter,
    P2TRSignatureFraudChallengeBroadcastReconciler
{
  readonly submissionTrustDomainID = "submitter.test"
  readonly reconciliationTrustDomainID = "reconciler.test"
  readonly finalityConfirmationBlocks = 12
  submissionCount = 0
  readonly submittedObservations: P2TRSignatureFraudWitnessObservation[] = []
  private readonly result: Hex | Buffer | string | Error

  constructor(result: Hex | Buffer | string | Error = txHash("a")) {
    this.result = result
  }

  async submitSignatureFraudChallenge(
    observation: P2TRSignatureFraudWitnessObservation
  ): Promise<Hex | Buffer | string> {
    this.submissionCount++
    this.submittedObservations.push(observation)

    if (this.result instanceof Error) {
      throw this.result
    }

    return this.result
  }

  async reconcileSignatureFraudChallengeBroadcast() {
    return {
      status: "absent-after-finality" as const,
      reason: "challenge is absent after the test finality boundary",
    }
  }
}

class FakeP2TRSignatureFraudChallengeBroadcastReconciler
  implements P2TRSignatureFraudChallengeBroadcastReconciler
{
  readonly reconciliationTrustDomainID = "reconciler.test"
  readonly finalityConfirmationBlocks = 12
  reconciliationCount = 0

  constructor(
    private readonly resolution: P2TRSignatureFraudChallengeBroadcastResolution
  ) {}

  async reconcileSignatureFraudChallengeBroadcast() {
    this.reconciliationCount++
    return this.resolution
  }
}

describe("P2TR signature-fraud witness parsing", () => {
  const vectorCorpus = loadVectorCorpus()

  it("parses supported Taproot witness signature encodings", () => {
    expect(vectorCorpus.name).to.equal("p2tr-signature-fraud-v0")

    vectorCorpus.cases.forEach((vector) => {
      const parsedWitness = parseP2TRKeyPathWitnessSignature(
        vector.witnessSignatureHex
      )

      expect(parsedWitness.signature.toString(), vector.id).to.equal(
        vector.bip340SignatureHex
      )
      expect(parsedWitness.witnessSignature.toString(), vector.id).to.equal(
        vector.witnessSignatureHex
      )
      expect(parsedWitness.sighashType, vector.id).to.equal(vector.sighashType)
    })
  })

  it("extracts the key-path witness signature from raw transaction inputs", () => {
    vectorCorpus.cases.forEach((vector) => {
      const rawTransaction = withInputWitness(
        vector.unsignedTransactionHex,
        vector.signedInputIndex,
        vector.witnessSignatureHex
      )

      const parsedWitness = extractP2TRKeyPathInputWitnessSignature(
        rawTransaction,
        vector.signedInputIndex
      )

      expect(parsedWitness.inputIndex, vector.id).to.equal(
        vector.signedInputIndex
      )
      expect(parsedWitness.signature.toString(), vector.id).to.equal(
        vector.bip340SignatureHex
      )
      expect(parsedWitness.sighashType, vector.id).to.equal(vector.sighashType)
    })
  })

  it("rejects unsupported Taproot witness signature encodings", () => {
    expect(vectorCorpus.negativeWitnessCases.length).to.be.greaterThan(0)

    vectorCorpus.negativeWitnessCases.forEach((negative) => {
      expectWitnessError(
        () => parseP2TRKeyPathWitnessSignature(negative.witnessSignatureHex),
        negative.expectedError
      )
    })
  })

  it("accepts annex-bearing key-path witnesses and rejects missing and script-path forms", () => {
    const vector = vectorCorpus.cases[0]

    expectWitnessError(
      () =>
        extractP2TRKeyPathInputWitnessSignature(
          { transactionHex: vector.unsignedTransactionHex },
          vector.signedInputIndex
        ),
      "missing-witness"
    )

    const annexTransaction = Transaction.fromHex(vector.unsignedTransactionHex)
    annexTransaction.ins[vector.signedInputIndex].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
      Buffer.from("50", "hex"),
    ]

    const annexWitness = extractP2TRKeyPathInputWitnessSignature(
      { transactionHex: annexTransaction.toHex() },
      vector.signedInputIndex
    )

    expect(annexWitness.annex?.toString()).to.equal("50")
    expect(annexWitness.signature.toString()).to.equal(
      vector.bip340SignatureHex
    )

    const scriptPathTransaction = Transaction.fromHex(
      vector.unsignedTransactionHex
    )
    scriptPathTransaction.ins[vector.signedInputIndex].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
      Buffer.from("51", "hex"),
      Buffer.from("c0", "hex"),
    ]

    expectWitnessError(
      () =>
        extractP2TRKeyPathInputWitnessSignature(
          { transactionHex: scriptPathTransaction.toHex() },
          vector.signedInputIndex
        ),
      "unsupported-witness-form"
    )
  })

  it("rejects invalid input indexes before parsing witness data", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )

    expectWitnessError(
      () => extractP2TRKeyPathInputWitnessSignature(rawTransaction, -1),
      "invalid-input-index"
    )

    expectWitnessError(
      () => extractP2TRKeyPathInputWitnessSignature(rawTransaction, 1),
      "invalid-input-index"
    )
  })

  it("reconstructs BIP-341 key-path sighashes from raw transactions and prevouts", () => {
    vectorCorpus.cases.forEach((vector) => {
      const sighash = computeP2TRKeyPathSighash(
        { transactionHex: vector.unsignedTransactionHex },
        vector.signedInputIndex,
        toObservationPrevouts(vector),
        vector.sighashType as
          | typeof P2TR_SIGHASH_DEFAULT
          | typeof P2TR_SIGHASH_ALL
      )

      expect(sighash.toString(), vector.id).to.equal(
        vector.expectedBip341SighashHex
      )
    })
  })

  it("changes BIP-341 key-path sighashes when transaction or prevout commitments change", () => {
    const vector = vectorCorpus.cases.find(
      (candidate) =>
        candidate.id ===
        "bip341-keypath-sighash-default-multi-input-multi-output"
    )

    if (!vector) {
      throw new Error("Missing multi-input P2TR signature-fraud vector")
    }

    const expectedSighash = computeP2TRKeyPathSighash(
      { transactionHex: vector.unsignedTransactionHex },
      vector.signedInputIndex,
      toObservationPrevouts(vector),
      vector.sighashType as
        | typeof P2TR_SIGHASH_DEFAULT
        | typeof P2TR_SIGHASH_ALL
    ).toString()
    const mutatedPrevouts = toObservationPrevouts(vector)
    mutatedPrevouts[vector.signedInputIndex] = {
      ...mutatedPrevouts[vector.signedInputIndex],
      valueSats: Number(mutatedPrevouts[vector.signedInputIndex].valueSats) + 1,
    }
    const mutatedTransactionHex = `${vector.unsignedTransactionHex.slice(
      0,
      -2
    )}01`

    expect(
      computeP2TRKeyPathSighash(
        { transactionHex: vector.unsignedTransactionHex },
        vector.signedInputIndex,
        mutatedPrevouts,
        vector.sighashType as
          | typeof P2TR_SIGHASH_DEFAULT
          | typeof P2TR_SIGHASH_ALL
      ).toString()
    ).to.not.equal(expectedSighash)

    expect(
      computeP2TRKeyPathSighash(
        { transactionHex: mutatedTransactionHex },
        vector.signedInputIndex,
        toObservationPrevouts(vector),
        vector.sighashType as
          | typeof P2TR_SIGHASH_DEFAULT
          | typeof P2TR_SIGHASH_ALL
      ).toString()
    ).to.not.equal(expectedSighash)
  })

  it("computes the shared draft challenge identities from payload fields", () => {
    vectorCorpus.cases.forEach((vector) => {
      const parsedWitness = parseP2TRKeyPathWitnessSignature(
        vector.witnessSignatureHex
      )
      const sighash = computeP2TRKeyPathSighash(
        { transactionHex: vector.unsignedTransactionHex },
        vector.signedInputIndex,
        toObservationPrevouts(vector),
        parsedWitness.sighashType
      )

      const identity = computeP2TRSignatureFraudDraftChallengeIdentity({
        walletID: vector.walletIDHex,
        sighash,
        signature: parsedWitness.signature,
        sighashType: parsedWitness.sighashType,
        signedInputIndex: vector.signedInputIndex,
        unsignedTransaction: {
          transactionHex: vector.unsignedTransactionHex,
        },
        inputPrevouts: toObservationPrevouts(vector),
      })

      expect(identity.toString(), vector.id).to.equal(
        vector.expectedDraftChallengeIdentityHex
      )
    })
  })

  it("computes canonical Bridge identities from signed Taproot authorizations", () => {
    vectorCorpus.cases.forEach((vector) => {
      const identity = computeBridgeChallengeIdentity(vector)
      const mutatedIdentity = computeP2TRSignatureFraudBridgeChallengeIdentity({
        ...bridgeChallengeDomain,
        walletID: vector.walletIDHex,
        signingKey: txHash("f"),
        sighash: vector.expectedBip341SighashHex,
      })

      expect(identity.toBuffer()).to.have.lengthOf(32)
      expect(identity.toString(), vector.id).to.equal(
        utils
          .sha256(
            utils.solidityPack(
              ["string", "uint256", "address", "bytes32", "bytes32", "bytes32"],
              [
                "tbtc-p2tr-signature-fraud-authorization-v3",
                bridgeChallengeDomain.chainID,
                bridgeChallengeDomain.bridgeAddress,
                Hex.from(vector.walletIDHex).toPrefixedString(),
                Hex.from(vector.walletIDHex).toPrefixedString(),
                Hex.from(vector.expectedBip341SighashHex).toPrefixedString(),
              ]
            )
          )
          .slice(2)
      )
      expect(mutatedIdentity.toString(), vector.id).to.not.equal(
        identity.toString()
      )

      expect(
        computeP2TRSignatureFraudBridgeChallengeIdentity({
          ...bridgeChallengeDomain,
          walletID: vector.walletIDHex,
          signingKey: vector.walletIDHex,
          sighash: `0x${"00".repeat(32)}`,
        }).toString()
      ).to.not.equal(identity.toString())
    })
  })

  it("uses COMPLETE_V2 Bridge identities directly as challenge keys", () => {
    const vector = vectorCorpus.cases[0]
    const bridgeChallengeIdentity = computeBridgeChallengeIdentity(vector)

    const bridgeChallengeKey = computeP2TRSignatureFraudBridgeChallengeKey({
      bridgeChallengeIdentity,
    })

    expect(bridgeChallengeKey.toString()).to.equal(
      expectedVector0BridgeChallengeKey
    )
    expect(bridgeChallengeKey.equals(bridgeChallengeIdentity)).to.be.true
    expect(
      computeP2TRSignatureFraudBridgeChallengeKey({
        bridgeChallengeIdentity: txHash("0"),
      }).toString()
    ).to.not.equal(bridgeChallengeKey.toString())
  })

  it("rejects invalid COMPLETE_V2 challenge-identity domains", () => {
    const vector = vectorCorpus.cases[0]
    expectWitnessError(
      () =>
        computeP2TRSignatureFraudBridgeChallengeIdentity({
          chainID: 0,
          bridgeAddress: "0x1111111111111111111111111111111111111111",
          walletID: vector.walletIDHex,
          signingKey: vector.walletIDHex,
          sighash: vector.expectedBip341SighashHex,
        }),
      "invalid-observation-payload"
    )
    expectWitnessError(
      () =>
        computeP2TRSignatureFraudBridgeChallengeIdentity({
          chainID: 11155111,
          bridgeAddress: constants.AddressZero,
          walletID: vector.walletIDHex,
          signingKey: vector.walletIDHex,
          sighash: vector.expectedBip341SighashHex,
        }),
      "invalid-observation-payload"
    )
    expectWitnessError(
      () =>
        computeP2TRSignatureFraudBridgeChallengeIdentity({
          chainID: 11155111,
          bridgeAddress: "not-an-address",
          walletID: vector.walletIDHex,
          signingKey: vector.walletIDHex,
          sighash: vector.expectedBip341SighashHex,
        }),
      "invalid-observation-payload"
    )
  })

  it("extracts complete signature-fraud witness observations from signed transactions", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector)
    const observations = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      inputPrevouts,
      [vector.walletIDHex]
    )

    expect(observations).to.have.lengthOf(1)

    const [observation] = observations
    expect(observation.inputIndex).to.equal(vector.signedInputIndex)
    expect(observation.walletID.toString()).to.equal(vector.walletIDHex)
    expect(observation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED
    )
    expect(observation.sighash.toString()).to.equal(
      vector.expectedBip341SighashHex
    )
    expect(observation.draftChallengeIdentity.toString()).to.equal(
      vector.expectedDraftChallengeIdentityHex
    )
    expect(observation.bridgeChallengeIdentity.toString()).to.equal(
      vector.expectedBridgeChallengeIdentityHex
    )
    expect(observation.unsignedTransaction.transactionHex).to.equal(
      vector.unsignedTransactionHex
    )
    expect(observation.observationID.toString()).to.equal(
      computeP2TRWalletInputWitnessObservationID({
        rawTransaction,
        inputIndex: vector.signedInputIndex,
        walletID: vector.walletIDHex,
        witnessSignature: vector.witnessSignatureHex,
        inputPrevouts,
      }).toString()
    )
  })

  it("attaches Bridge challenge keys to observations when a Bridge domain is configured", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector)
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      inputPrevouts,
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      bridgeChallengeDomain
    )
    const serialized =
      serializeP2TRSignatureFraudWitnessObservation(observation)
    const deserialized =
      deserializeP2TRSignatureFraudWitnessObservation(serialized)

    expect(observation.bridgeChallengeKey?.toString()).to.equal(
      expectedVector0BridgeChallengeKey
    )
    expect(serialized.bridgeChallengeKey).to.equal(
      expectedVector0BridgeChallengeKey
    )
    expect(deserialized.bridgeChallengeKey?.toString()).to.equal(
      observation.bridgeChallengeKey?.toString()
    )
    expect(deserialized.bridgeChallengeIdentity.toString()).to.equal(
      observation.bridgeChallengeIdentity.toString()
    )
  })

  it("preserves legacy Bridge challenge encoding for domainless observations", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex]
    )
    const unsignedTransaction = Transaction.fromHex(
      vector.unsignedTransactionHex
    )
    const payload = buildP2TRSignatureFraudBridgeChallengePayload(observation)
    const [decodedPayload] = utils.defaultAbiCoder.decode(
      [P2TR_SIGNATURE_FRAUD_BRIDGE_CHALLENGE_PAYLOAD_ABI_TYPE],
      encodeP2TRSignatureFraudBridgeChallengePayload(observation)
    )

    expect(payload.walletID).to.equal(`0x${vector.walletIDHex}`)
    expect(payload.version).to.equal(unsignedTransaction.version)
    expect(payload.locktime).to.equal(unsignedTransaction.locktime)
    expect(payload.signedInputIndex).to.equal(vector.signedInputIndex)
    expect(payload.annex).to.equal("0x")
    expect(payload.witnessSignature).to.equal(`0x${vector.witnessSignatureHex}`)
    expect(payload.inputs).to.have.lengthOf(unsignedTransaction.ins.length)
    expect(payload.inputs[0].txid).to.equal(
      utils.hexlify(unsignedTransaction.ins[0].hash)
    )
    expect(payload.prevouts[0].valueSats.toString()).to.equal(
      vector.prevouts[0].valueSats.toString()
    )
    expect(payload.prevouts[0].scriptPubKey).to.equal(
      `0x${vector.prevouts[0].scriptPubKeyHex}`
    )
    expect(decodedPayload.walletID).to.equal(payload.walletID)
    expect(decodedPayload.annex).to.equal("0x")
    expect(decodedPayload.inputs[0].txid).to.equal(payload.inputs[0].txid)
    expect(decodedPayload.prevouts[0].scriptPubKey).to.equal(
      payload.prevouts[0].scriptPubKey
    )
  })

  it("matches COMPLETE_V2 evidence vectors for every supported sighash mode", () => {
    const completeVectorsByID = new Map(
      loadCompleteChallengeEvidenceVectorCorpus().cases.map((vector) => [
        vector.id,
        vector.walletKey.encodedEvidence,
      ])
    )

    for (const vector of loadFullSighashVectorCorpus().cases) {
      const expectedEvidence = completeVectorsByID.get(vector.id)
      if (expectedEvidence === undefined) {
        throw new Error(`Missing COMPLETE_V2 evidence vector ${vector.id}`)
      }

      const signedRawTransaction = withInputWitness(
        vector.unsignedTransactionHex,
        vector.signedInputIndex,
        vector.witnessSignatureHex,
        vector.annexHex
      )
      const transaction = Transaction.fromHex(
        signedRawTransaction.transactionHex
      )
      vector.prevouts.forEach((prevout, inputIndex) => {
        if (
          inputIndex !== vector.signedInputIndex &&
          extractP2TRWalletIDFromScriptPubKey(prevout.scriptPubKeyHex)?.equals(
            Hex.from(vector.walletIDHex)
          )
        ) {
          transaction.ins[inputIndex].witness = [
            Buffer.from(vector.witnessSignatureHex, "hex"),
          ]
        }
      })
      const observations = extractP2TRSignatureFraudWitnessObservations(
        { transactionHex: transaction.toHex() },
        toObservationPrevouts(vector),
        [vector.walletIDHex],
        undefined,
        undefined,
        undefined,
        bridgeChallengeDomain
      )
      const observation = observations.find(
        ({ inputIndex }) => inputIndex === vector.signedInputIndex
      )
      if (observation === undefined) {
        throw new Error(`Missing signed observation ${vector.id}`)
      }
      const encodedEvidence =
        encodeP2TRSignatureFraudBridgeChallengePayload(observation)

      expect(encodedEvidence, vector.id).to.equal(expectedEvidence)
      expect(utils.arrayify(encodedEvidence), vector.id).to.have.lengthOf(224)
    }
  })

  it("threads a BIP-341 annex through persistence and COMPLETE_V2 evidence", () => {
    const vectors = loadFullSighashVectorCorpus().cases
    const vector = vectors.find(
      ({ id }) => id === "bip341-keypath-default-with-annex"
    )
    const inputZeroVector = vectors.find(
      ({ id }) => id === "bip341-keypath-none-multi"
    )
    const inputTwoVector = vectors.find(
      ({ id }) => id === "bip341-keypath-single-multi"
    )
    if (vector?.annexHex === undefined) {
      throw new Error("Missing annex-bearing P2TR signature-fraud vector")
    }
    if (inputZeroVector === undefined || inputTwoVector === undefined) {
      throw new Error("Missing companion multi-input P2TR vectors")
    }

    const signedTransaction = Transaction.fromHex(vector.unsignedTransactionHex)
    signedTransaction.ins[0].witness = [
      Buffer.from(inputZeroVector.witnessSignatureHex, "hex"),
    ]
    signedTransaction.ins[vector.signedInputIndex].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
      Buffer.from(vector.annexHex, "hex"),
    ]
    signedTransaction.ins[2].witness = [
      Buffer.from(inputTwoVector.witnessSignatureHex, "hex"),
    ]
    const rawTransaction = { transactionHex: signedTransaction.toHex() }
    const observations = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      bridgeChallengeDomain
    )
    expect(observations.map(({ inputIndex }) => inputIndex)).to.deep.equal([
      0, 1, 2,
    ])
    const observation = observations.find(
      ({ inputIndex }) => inputIndex === vector.signedInputIndex
    )
    if (observation === undefined) {
      throw new Error("Missing annex-bearing watchtower observation")
    }
    const restored = deserializeP2TRSignatureFraudWitnessObservation(
      serializeP2TRSignatureFraudWitnessObservation(observation)
    )
    const payload = buildP2TRSignatureFraudBridgeChallengePayload(restored)

    expect(observation.annex?.toString()).to.equal(vector.annexHex)
    expect(observation.sighash.toString()).to.equal(
      vector.expectedBip341SighashHex
    )
    expect(observation.bridgeChallengeIdentity.toString()).to.equal(
      computeP2TRSignatureFraudBridgeChallengeIdentity({
        ...bridgeChallengeDomain,
        walletID: observation.walletID,
        signingKey: observation.walletID,
        sighash: observation.sighash,
      }).toString()
    )
    expect(restored.annex?.toString()).to.equal(vector.annexHex)
    expect(payload.annex).to.equal(`0x${vector.annexHex}`)

    const encodedEvidence =
      encodeP2TRSignatureFraudBridgeChallengePayload(restored)
    expect(utils.arrayify(encodedEvidence)).to.have.lengthOf(224)
    const [decodedEvidence] = utils.defaultAbiCoder.decode(
      [completeBridgeChallengeEvidenceAbiType],
      encodedEvidence
    )
    expect(decodedEvidence.sighash).to.equal(
      `0x${vector.expectedBip341SighashHex}`
    )
  })

  it("validates stored observations against reconstructed witness data", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      bridgeChallengeDomain
    )

    expect(() =>
      validateP2TRSignatureFraudWitnessObservationConsistency(observation, {
        bridgeChallengeDomain,
      })
    ).not.to.throw()
    expectWitnessError(
      () =>
        validateP2TRSignatureFraudWitnessObservationConsistency(observation),
      "invalid-watchtower-state"
    )
    expectWitnessError(
      () =>
        validateP2TRSignatureFraudWitnessObservationConsistency(
          {
            ...observation,
            spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
          },
          { bridgeChallengeDomain }
        ),
      "invalid-watchtower-state"
    )
  })

  it("classifies observed wallet spends through the configured spend-type classifier", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector)
    const bridgeIdentifier = txHash("b")
    let classifierCalls = 0

    const observations = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      inputPrevouts,
      [vector.walletIDHex],
      bridgeIdentifier,
      ({
        rawTransaction: classifiedRawTransaction,
        unsignedTransaction,
        candidate,
        inputPrevouts: classifiedPrevouts,
        bridgeIdentifier: classifiedBridgeIdentifier,
      }) => {
        classifierCalls++
        expect(classifiedRawTransaction.transactionHex).to.equal(
          rawTransaction.transactionHex
        )
        expect(unsignedTransaction.transactionHex).to.equal(
          vector.unsignedTransactionHex
        )
        expect(candidate.inputIndex).to.equal(vector.signedInputIndex)
        expect(classifiedPrevouts).to.deep.equal(inputPrevouts)
        expect(classifiedBridgeIdentifier).to.equal(bridgeIdentifier)

        return P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
      }
    )

    expect(classifierCalls).to.equal(1)
    expect(observations).to.have.lengthOf(1)
    expect(observations[0].spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )
  })

  it("classifies spend types through deterministic approved rules", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector)

    const classifier = createP2TRSignatureFraudSpendTypeClassifier([
      {
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
        matches: ({ candidate }) =>
          candidate.inputIndex === vector.signedInputIndex,
      },
      {
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP,
        matches: () => false,
      },
    ])
    const [classifiedObservation] =
      extractP2TRSignatureFraudWitnessObservations(
        rawTransaction,
        inputPrevouts,
        [vector.walletIDHex],
        undefined,
        classifier
      )

    expect(classifiedObservation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )

    const unclassifiedClassifier = createP2TRSignatureFraudSpendTypeClassifier([
      {
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP,
        matches: () => false,
      },
    ])
    const [unclassifiedObservation] =
      extractP2TRSignatureFraudWitnessObservations(
        rawTransaction,
        inputPrevouts,
        [vector.walletIDHex],
        undefined,
        unclassifiedClassifier
      )

    expect(unclassifiedObservation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED
    )

    const ambiguousClassifier = createP2TRSignatureFraudSpendTypeClassifier([
      {
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
        matches: () => true,
      },
      {
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP,
        matches: () => true,
      },
    ])

    expectWitnessError(
      () =>
        extractP2TRSignatureFraudWitnessObservations(
          rawTransaction,
          inputPrevouts,
          [vector.walletIDHex],
          undefined,
          ambiguousClassifier
        ),
      "invalid-watchtower-state"
    )
    expectWitnessError(
      () => createP2TRSignatureFraudSpendTypeClassifier([]),
      "invalid-watchtower-state"
    )
    expectWitnessError(
      () =>
        createP2TRSignatureFraudSpendTypeClassifier([
          {
            spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
            matches: () => true,
          },
        ]),
      "invalid-watchtower-state"
    )
    expectWitnessError(
      () =>
        createP2TRSignatureFraudSpendTypeClassifier([
          {
            spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
            matches: undefined as never,
          },
        ]),
      "invalid-watchtower-state"
    )

    const malformedClassifier = createP2TRSignatureFraudSpendTypeClassifier([
      {
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
        matches: () => "true" as never,
      },
    ])

    expectWitnessError(
      () =>
        extractP2TRSignatureFraudWitnessObservations(
          rawTransaction,
          inputPrevouts,
          [vector.walletIDHex],
          undefined,
          malformedClassifier
        ),
      "invalid-watchtower-state"
    )
  })

  it("classifies draft flow-shaped vector cases from corpus metadata", () => {
    const flowVectors = vectorCorpus.cases.filter(
      (vector) => vector.flowMetadata !== undefined
    )

    expect(
      flowVectors.map((vector) => vector.flowMetadata?.spendType)
    ).to.have.members([
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
    ])

    const classifier = createP2TRSignatureFraudSpendTypeClassifier(
      flowVectors.map((vector) => ({
        spendType: vector.flowMetadata!.spendType,
        matches: ({ unsignedTransaction, candidate }) =>
          unsignedTransaction.transactionHex ===
            vector.unsignedTransactionHex &&
          candidate.inputIndex === vector.flowMetadata!.sourceWalletInput,
      }))
    )

    for (const vector of flowVectors) {
      const rawTransaction = withInputWitness(
        vector.unsignedTransactionHex,
        vector.signedInputIndex,
        vector.witnessSignatureHex
      )
      const [classifiedObservation] =
        extractP2TRSignatureFraudWitnessObservations(
          rawTransaction,
          toObservationPrevouts(vector),
          [vector.walletIDHex],
          undefined,
          classifier
        )

      expect(classifiedObservation.spendType).to.equal(
        vector.flowMetadata!.spendType
      )
      expect(vector.flowMetadata!.proofEventCorrelation).to.equal(
        "required-not-present"
      )
      expect(vector.flowMetadata!.knownLimits.join(" ")).to.include(
        "does not prove Bridge"
      )
    }
  })

  it("rejects unsupported spend types returned by the spend-type classifier", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )

    expectWitnessError(
      () =>
        extractP2TRSignatureFraudWitnessObservations(
          rawTransaction,
          toObservationPrevouts(vector),
          [vector.walletIDHex],
          undefined,
          () => "unsupported-spend-type" as never
        ),
      "invalid-watchtower-state"
    )
  })

  it("strips witnesses without changing the unsigned transaction payload", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )

    expect(
      stripWitnessesFromBitcoinRawTransaction(rawTransaction).transactionHex
    ).to.equal(vector.unsignedTransactionHex)
  })

  it("validates configured P2TR signature-fraud payload bounds", () => {
    const vector = vectorCorpus.cases.find(
      (candidate) =>
        candidate.id ===
        "bip341-keypath-sighash-default-multi-input-multi-output"
    )

    if (!vector) {
      throw new Error("Missing multi-input P2TR signature-fraud vector")
    }

    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector)
    const rawTransactionByteLength = Buffer.from(
      rawTransaction.transactionHex,
      "hex"
    ).length

    expect(() =>
      validateP2TRSignatureFraudPayloadBounds(rawTransaction, inputPrevouts, {
        maxRawTransactionBytes: rawTransactionByteLength,
        maxInputs: 2,
        maxOutputs: 2,
        maxScriptPubKeyBytes: 34,
      })
    ).not.to.throw()

    expectWitnessError(
      () =>
        validateP2TRSignatureFraudPayloadBounds(rawTransaction, inputPrevouts, {
          maxRawTransactionBytes: rawTransactionByteLength - 1,
        }),
      "invalid-observation-payload"
    )
    expectWitnessError(
      () =>
        validateP2TRSignatureFraudPayloadBounds(rawTransaction, inputPrevouts, {
          maxInputs: 1,
        }),
      "invalid-observation-payload"
    )
    expectWitnessError(
      () =>
        validateP2TRSignatureFraudPayloadBounds(
          rawTransaction,
          inputPrevouts.slice(0, 1),
          {
            maxInputs: 2,
          }
        ),
      "invalid-prevout-map"
    )
    expectWitnessError(
      () =>
        validateP2TRSignatureFraudPayloadBounds(rawTransaction, inputPrevouts, {
          maxOutputs: 1,
        }),
      "invalid-observation-payload"
    )
    expectWitnessError(
      () =>
        validateP2TRSignatureFraudPayloadBounds(rawTransaction, inputPrevouts, {
          maxScriptPubKeyBytes: 33,
        }),
      "invalid-observation-payload"
    )
    expectWitnessError(
      () =>
        validateP2TRSignatureFraudPayloadBounds(rawTransaction, inputPrevouts, {
          maxInputs: 0,
        }),
      "invalid-watchtower-state"
    )
  })

  it("resolves input prevout maps through the Bitcoin client", async () => {
    const vector = vectorCorpus.cases[0]
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient

    const resolvedPrevouts = await resolveP2TRInputPrevouts(
      { transactionHex: vector.unsignedTransactionHex },
      bitcoinClient
    )

    expect(resolvedPrevouts).to.have.lengthOf(vector.prevouts.length)
    expect(resolvedPrevouts[0].txid.toString()).to.equal(
      vector.prevouts[0].txidHex
    )
    expect(resolvedPrevouts[0].vout).to.equal(vector.prevouts[0].vout)
    expect(resolvedPrevouts[0].valueSats).to.equal(vector.prevouts[0].valueSats)
    expect(resolvedPrevouts[0].scriptPubKey.toString()).to.equal(
      vector.prevouts[0].scriptPubKeyHex
    )
  })

  it("rejects missing input prevouts returned by the Bitcoin client", async () => {
    const vector = vectorCorpus.cases[0]
    const emptyPreviousTransaction = new Transaction()
    emptyPreviousTransaction.addInput(Buffer.alloc(32), 0xffffffff)
    const bitcoinClient = {
      getRawTransaction: async () => ({
        transactionHex: emptyPreviousTransaction.toHex(),
      }),
    } as unknown as BitcoinClient

    await expectWitnessRejection(
      () =>
        resolveP2TRInputPrevouts(
          { transactionHex: vector.unsignedTransactionHex },
          bitcoinClient
        ),
      "invalid-prevout-map"
    )
  })

  it("observes mempool and confirmed wallet spends through the watchtower store", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = new P2TRSignatureFraudWatchtower(store, [
      vector.walletIDHex,
    ])

    const mempoolResults = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      bitcoinTxHash
    )
    const confirmedResults = await watchtower.observeConfirmedTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      bitcoinTxHash,
      txHash("d"),
      789
    )

    expect(mempoolResults).to.have.lengthOf(1)
    expect(mempoolResults[0].record.bitcoinStatus).to.equal("mempool")
    expect(
      mempoolResults[0].record.observation?.draftChallengeIdentity.toString()
    ).to.equal(vector.expectedDraftChallengeIdentityHex)
    expect(confirmedResults).to.have.lengthOf(1)
    expect(confirmedResults[0].record.bitcoinStatus).to.equal("confirmed")
    expect(confirmedResults[0].record.bitcoinBlockHeight).to.equal(789)
    expect(
      confirmedResults[0].observation.draftChallengeIdentity.toString()
    ).to.equal(vector.expectedDraftChallengeIdentityHex)
    expect(confirmedResults[0].record.observationID.toString()).to.equal(
      mempoolResults[0].record.observationID.toString()
    )
  })

  it("observes wallet spends after resolving prevouts through the Bitcoin client", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = new P2TRSignatureFraudWatchtower(store, [
      vector.walletIDHex,
    ])

    const results =
      await watchtower.observeConfirmedTransactionWithResolvedPrevouts(
        rawTransaction,
        bitcoinClient,
        bitcoinTxHash,
        txHash("2"),
        790
      )

    expect(results).to.have.lengthOf(1)
    expect(results[0].record.bitcoinStatus).to.equal("confirmed")
    expect(results[0].record.bitcoinBlockHeight).to.equal(790)
    expect(results[0].observation.sighash.toString()).to.equal(
      vector.expectedBip341SighashHex
    )
    expect(results[0].observation.draftChallengeIdentity.toString()).to.equal(
      vector.expectedDraftChallengeIdentityHex
    )
  })

  it("rejects out-of-bounds watchtower observations before recording", async () => {
    const vector = vectorCorpus.cases.find(
      (candidate) =>
        candidate.id ===
        "bip341-keypath-sighash-default-multi-input-multi-output"
    )

    if (!vector) {
      throw new Error("Missing multi-input P2TR signature-fraud vector")
    }

    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = new P2TRSignatureFraudWatchtower(
      store,
      [vector.walletIDHex],
      undefined,
      undefined,
      { maxInputs: 1 }
    )

    await expectWitnessRejection(
      () =>
        watchtower.observeMempoolTransaction(
          rawTransaction,
          toObservationPrevouts(vector),
          authenticatedBitcoinTxHash(rawTransaction)
        ),
      "invalid-observation-payload"
    )
    expect(await store.listChallengeRecords()).to.have.lengthOf(0)
  })

  it("marks observed watchtower transactions as evicted and reorged", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = new P2TRSignatureFraudWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeConfirmedTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      bitcoinTxHash,
      txHash("4"),
      791
    )
    const reorged = await watchtower.markConfirmedTransactionReorged(
      observed.record.observationID
    )
    const evicted = await watchtower.markMempoolTransactionEvicted(
      observed.record.observationID
    )

    expect(reorged.bitcoinStatus).to.equal("reorged")
    expect(reorged.observationID.toString()).to.equal(
      observed.record.observationID.toString()
    )
    expect(evicted.bitcoinStatus).to.equal("evicted")
    expect(evicted.observationID.toString()).to.equal(
      observed.record.observationID.toString()
    )
  })

  it("keeps reorged observations separate from changed replacement evidence", async () => {
    const vector = vectorCorpus.cases[0]
    const originalRawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      originalRawTransaction.transactionHex
    ).getId()
    const replacementWitnessSignature = `${vector.witnessSignatureHex.slice(
      0,
      -2
    )}${vector.witnessSignatureHex.endsWith("00") ? "01" : "00"}`
    const signatureReplacementRawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      replacementWitnessSignature
    )
    const prevoutReplacementPrevouts = toObservationPrevouts(vector).map(
      (prevout, index) =>
        index === vector.signedInputIndex
          ? { ...prevout, valueSats: Number(prevout.valueSats) + 1 }
          : prevout
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = new P2TRSignatureFraudWatchtower(store, [
      vector.walletIDHex,
    ])

    const [original] = await watchtower.observeConfirmedTransaction(
      originalRawTransaction,
      toObservationPrevouts(vector),
      bitcoinTxHash,
      txHash("4"),
      791
    )
    const reorged = await watchtower.markConfirmedTransactionReorged(
      original.record.observationID
    )
    const [signatureReplacement] = await watchtower.observeMempoolTransaction(
      signatureReplacementRawTransaction,
      toObservationPrevouts(vector),
      bitcoinTxHash
    )
    const [prevoutReplacement] = await watchtower.observeMempoolTransaction(
      originalRawTransaction,
      prevoutReplacementPrevouts,
      bitcoinTxHash
    )
    const records = await store.listChallengeRecords()
    const recordIDs = records.map((record) => record.observationID.toString())

    expect(reorged.bitcoinStatus).to.equal("reorged")
    expect(signatureReplacement.record.bitcoinStatus).to.equal("mempool")
    expect(prevoutReplacement.record.bitcoinStatus).to.equal("mempool")
    expect(new Set(recordIDs).size).to.equal(3)
    expect(recordIDs).to.include(original.record.observationID.toString())
    expect(recordIDs).to.include(
      signatureReplacement.record.observationID.toString()
    )
    expect(recordIDs).to.include(
      prevoutReplacement.record.observationID.toString()
    )
    expect(signatureReplacement.record.observationID.toString()).to.not.equal(
      original.record.observationID.toString()
    )
    expect(prevoutReplacement.record.observationID.toString()).to.not.equal(
      original.record.observationID.toString()
    )
  })

  it("persists accepted challenge submission events through the watchtower", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitted = await recordSubmittedChallenge(
      store,
      observed.observation,
      txHash("6")
    )
    const duplicate = await recordP2TRWatchtowerChallengeEvent(store, {
      type: "submission-accepted",
      observationID: observed.observation.observationID,
      challengeTxHash: txHash("6"),
    })

    expect(submitted.status).to.equal("submitted")
    expect(submitted.submissionAttempts).to.equal(1)
    expect(submitted.challengeTxHash?.toString()).to.equal(txHash("6"))
    expect(duplicate).to.deep.equal(submitted)
  })

  it("persists rejected challenge submission events through the watchtower", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const rejected = await recordRejectedChallenge(
      store,
      observed.observation,
      "bridge rejected"
    )

    expect(rejected.status).to.equal("rejected")
    expect(rejected.submissionAttempts).to.equal(1)
    expect(rejected.lastError).to.equal("bridge rejected")
  })

  it("submits Bridge challenges and waits for configured finality", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      bridgeChallengeDomain
    )
    const calls: {
      action: number
      payload: string
      walletMembersIDs: number[]
      value: BigNumber
    }[] = []
    let waitedConfirmations: number | undefined
    const bridge = {
      async fraudParameters() {
        return {
          fraudChallengeDepositAmount: BigNumber.from(1234),
        }
      },
      async processP2TRSignatureFraudChallenge(
        action: number,
        payload: string,
        walletMembersIDs: number[],
        overrides: { value: BigNumberish }
      ) {
        calls.push({
          action,
          payload,
          walletMembersIDs,
          value: BigNumber.from(overrides.value),
        })

        return {
          hash: `0x${"6".repeat(64)}`,
          async wait(confirmations?: number) {
            waitedConfirmations = confirmations
            return { status: 1 }
          },
        }
      },
    }
    const submitter = new P2TRSignatureFraudBridgeChallengeSubmitter(bridge, {
      confirmations: 6,
    })

    const txHash = await submitter.submitSignatureFraudChallenge(observation)

    expect(txHash).to.equal(`0x${"6".repeat(64)}`)
    expect(waitedConfirmations).to.equal(6)
    expect(calls).to.have.lengthOf(1)
    expect(calls[0].action).to.equal(P2TR_SIGNATURE_FRAUD_BRIDGE_ACTION_SUBMIT)
    expect(calls[0].walletMembersIDs).to.deep.equal([])
    expect(calls[0].value.toString()).to.equal("1234")

    expect(utils.arrayify(calls[0].payload)).to.have.lengthOf(224)
    const [decodedEvidence] = utils.defaultAbiCoder.decode(
      [completeBridgeChallengeEvidenceAbiType],
      calls[0].payload
    )
    expect(decodedEvidence.walletID).to.equal(`0x${vector.walletIDHex}`)
    expect(decodedEvidence.signingKey).to.equal(`0x${vector.walletIDHex}`)
    expect(decodedEvidence.bindingTxHash).to.equal(constants.HashZero)
    expect(decodedEvidence.bindingOutputIndex).to.equal(0)
    expect(decodedEvidence.sighash).to.equal(
      `0x${vector.expectedBip341SighashHex}`
    )
    expect(decodedEvidence.nonceX).to.equal(
      `0x${vector.bip340SignatureHex.slice(0, 64)}`
    )
    expect(decodedEvidence.signatureScalar).to.equal(
      `0x${vector.bip340SignatureHex.slice(64)}`
    )
  })

  it("rejects domainless COMPLETE_V2 submissions before contract access", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex]
    )
    let contractAccesses = 0
    const submitter = new P2TRSignatureFraudBridgeChallengeSubmitter({
      async fraudParameters() {
        contractAccesses++
        return { fraudChallengeDepositAmount: 1 }
      },
      async processP2TRSignatureFraudChallenge() {
        contractAccesses++
        return { hash: txHash("6") }
      },
    })

    await expectWitnessRejection(
      () => submitter.submitSignatureFraudChallenge(observation),
      "invalid-watchtower-state"
    )
    expect(contractAccesses).to.equal(0)
  })

  it("rejects inconsistent COMPLETE_V2 keys before contract access", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      bridgeChallengeDomain
    )
    let contractAccesses = 0
    const submitter = new P2TRSignatureFraudBridgeChallengeSubmitter({
      async fraudParameters() {
        contractAccesses++
        return { fraudChallengeDepositAmount: 1 }
      },
      async processP2TRSignatureFraudChallenge() {
        contractAccesses++
        return { hash: txHash("6") }
      },
    })

    await expectWitnessRejection(
      () =>
        submitter.submitSignatureFraudChallenge({
          ...observation,
          bridgeChallengeKey: Hex.from(txHash("0")),
        }),
      "invalid-observation-payload"
    )
    expect(contractAccesses).to.equal(0)
  })

  it("rejects zero-confirmation Bridge submissions", () => {
    expect(
      () =>
        new P2TRSignatureFraudBridgeChallengeSubmitter(
          {
            async processP2TRSignatureFraudChallenge() {
              return { hash: txHash("6") }
            },
          },
          { challengeDepositAmount: 1, confirmations: 0 }
        )
    ).to.throw(
      P2TRWitnessSignatureError,
      "Bridge challenge confirmations must be a positive integer"
    )
  })

  it("retries Bridge submissions that fail finality", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(
      store,
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    let shouldRevert = true
    const bridge = {
      async processP2TRSignatureFraudChallenge() {
        return {
          hash: `0x${"9".repeat(64)}`,
          async wait() {
            return { status: shouldRevert ? 0 : 1 }
          },
        }
      },
    }
    const submitter = new P2TRSignatureFraudBridgeChallengeSubmitter(bridge, {
      challengeDepositAmount: 1,
    })

    await expectWitnessRejection(
      () => submitter.submitSignatureFraudChallenge(observed.observation),
      "challenge-transaction-reverted"
    )
    const rejected = await recordRejectedChallenge(
      store,
      observed.observation,
      "Bridge challenge transaction reverted"
    )
    shouldRevert = false
    const challengeTxHash = await submitter.submitSignatureFraudChallenge(
      observed.observation
    )
    const submitted = await recordSubmittedChallenge(
      store,
      observed.observation,
      challengeTxHash
    )

    expect(rejected.status).to.equal("rejected")
    expect(rejected.submissionAttempts).to.equal(1)
    expect(rejected.lastError).to.equal("Bridge challenge transaction reverted")
    expect(submitted.status).to.equal("submitted")
    expect(submitted.submissionAttempts).to.equal(2)
    expect(submitted.challengeTxHash?.toString()).to.equal(txHash("9"))
  })

  it("records broadcast-pending when the acceptance record cannot be persisted", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const backing = new InMemoryP2TRWatchtowerChallengeStore()
    // Persisting the "submitted" acceptance record fails after the transaction
    // has been broadcast.
    const store: P2TRWatchtowerChallengeStore = {
      getChallengeRecord: (observationID: Hex) =>
        backing.getChallengeRecord(observationID),
      saveChallengeRecord: async (record: P2TRWatchtowerChallengeRecord) => {
        if (record.status === "submitted") {
          throw new Error("challenge store unavailable")
        }
        await backing.saveChallengeRecord(record)
      },
    }
    const watchtower = createDraftApprovedP2TRWatchtower(
      store,
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const bridge = {
      async processP2TRSignatureFraudChallenge() {
        return {
          hash: `0x${txHash("c")}`,
          async wait() {
            return { status: 1 }
          },
        }
      },
    }
    const submitter = new P2TRSignatureFraudBridgeChallengeSubmitter(bridge, {
      challengeDepositAmount: 1,
    })

    const challengeTxHash = await submitter.submitSignatureFraudChallenge(
      observed.observation
    )
    await recordP2TRWatchtowerChallengeEvent(store, {
      type: "submission-started",
      observationID: observed.observation.observationID,
      observation: observed.observation,
    })
    await recordP2TRWatchtowerChallengeEvent(store, {
      type: "submission-broadcast",
      observationID: observed.observation.observationID,
      challengeTxHash,
    })
    let acceptanceError: Error | undefined
    try {
      await recordP2TRWatchtowerChallengeEvent(store, {
        type: "submission-accepted",
        observationID: observed.observation.observationID,
        challengeTxHash,
      })
    } catch (error) {
      acceptanceError = error as Error
    }

    // The acceptance record could not be persisted, but the durable state is the
    // non-replayable "broadcast-pending" status -- never "submitting"/"rejected",
    // which would re-broadcast the already-sent challenge on the next cycle.
    expect(acceptanceError?.message).to.equal("challenge store unavailable")
    const stored = await backing.listChallengeRecords()
    expect(stored).to.have.length(1)
    expect(stored[0].status).to.equal("broadcast-pending")
    expect(stored[0].challengeTxHash?.toString()).to.equal(txHash("c"))
  })

  it("never re-broadcasts a challenge already in broadcast-pending", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(
      store,
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    // Drive the record into the broadcast-pending state directly.
    await recordP2TRWatchtowerChallengeEvent(store, {
      type: "submission-started",
      observationID: observed.observation.observationID,
    })
    await recordP2TRWatchtowerChallengeEvent(store, {
      type: "submission-broadcast",
      observationID: observed.observation.observationID,
      challengeTxHash: `0x${txHash("e")}`,
    })

    let submitCount = 0
    const bridge = {
      async processP2TRSignatureFraudChallenge() {
        submitCount++
        return {
          hash: `0x${txHash("f")}`,
          async wait() {
            return { status: 1 }
          },
        }
      },
    }
    const submitter = new P2TRSignatureFraudBridgeChallengeSubmitter(bridge, {
      challengeDepositAmount: 1,
    })

    await expectWitnessRejection(
      () =>
        watchtower.submitChallenge(
          observed.observation,
          submitter,
          draftApprovedSubmissionPolicy
        ),
      "invalid-watchtower-state"
    )

    // Already broadcast: the submitter is never invoked again, so no duplicate
    // on-chain submission, and the record stays broadcast-pending.
    expect(submitCount).to.equal(0)
    const result = await store.getChallengeRecord(
      observed.observation.observationID
    )
    expect(result?.status).to.equal("broadcast-pending")
    expect(result?.challengeTxHash?.toString()).to.equal(txHash("e"))
  })

  it("reconciles broadcast-pending challenges before deciding whether to replay", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )

    const createPending = async () => {
      const store = new InMemoryP2TRWatchtowerChallengeStore()
      const watchtower = createDraftApprovedP2TRWatchtower(
        store,
        [vector.walletIDHex],
        bridgeChallengeDomain
      )
      const [observed] = await watchtower.observeMempoolTransaction(
        rawTransaction,
        toObservationPrevouts(vector),
        authenticatedBitcoinTxHash(rawTransaction)
      )
      await recordP2TRWatchtowerChallengeEvent(store, {
        type: "submission-started",
        observationID: observed.observation.observationID,
      })
      await recordP2TRWatchtowerChallengeEvent(store, {
        type: "submission-broadcast",
        observationID: observed.observation.observationID,
        challengeTxHash: `0x${txHash("e")}`,
        broadcastAtUnixMs: 1_000,
      })
      return { store, watchtower, observation: observed.observation }
    }

    const accepted = await createPending()
    const acceptedSubmitter = new FakeP2TRSignatureFraudChallengeSubmitter()
    const acceptedReconciler =
      new FakeP2TRSignatureFraudChallengeBroadcastReconciler({
        status: "accepted",
      })
    await new P2TRSignatureFraudWatchtowerRunner(
      accepted.watchtower,
      {} as BitcoinClient,
      acceptedSubmitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      },
      acceptedReconciler
    ).replayStoredChallengeRecords(accepted.store)
    const acceptedRecord = await accepted.store.getChallengeRecord(
      accepted.observation.observationID
    )

    expect(acceptedRecord?.status).to.equal("submitted")
    expect(acceptedRecord?.challengeBroadcastReconciliationAttempts).to.equal(1)
    expect(acceptedSubmitter.submissionCount).to.equal(0)

    const absent = await createPending()
    const replacementSubmitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      txHash("f")
    )
    const absentReconciler =
      new FakeP2TRSignatureFraudChallengeBroadcastReconciler({
        status: "absent-after-finality",
        reason: "transaction and challenge are canonically absent",
      })
    const [replacement] = await new P2TRSignatureFraudWatchtowerRunner(
      absent.watchtower,
      {} as BitcoinClient,
      replacementSubmitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      },
      absentReconciler
    ).replayStoredChallengeRecords(absent.store)

    expect(replacement.record.status).to.equal("rejected")
    expect(replacement.submissionRecord.status).to.equal("rejected")
    expect(replacement.submissionRecord.submissionAttempts).to.equal(1)
    expect(replacementSubmitter.submissionCount).to.equal(0)

    const unknown = await createPending()
    const unknownSubmitter = new FakeP2TRSignatureFraudChallengeSubmitter()
    const unknownReconciler =
      new FakeP2TRSignatureFraudChallengeBroadcastReconciler({
        status: "unknown",
        reason: "canonical providers disagree",
      })
    await new P2TRSignatureFraudWatchtowerRunner(
      unknown.watchtower,
      {} as BitcoinClient,
      unknownSubmitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      },
      unknownReconciler
    ).replayStoredChallengeRecords(unknown.store)
    const unknownRecord = await unknown.store.getChallengeRecord(
      unknown.observation.observationID
    )
    if (unknownRecord === undefined) {
      throw new Error("Expected pending challenge record")
    }
    const restoredUnknown = deserializeP2TRWatchtowerChallengeRecord(
      serializeP2TRWatchtowerChallengeRecord(unknownRecord)
    )

    expect(restoredUnknown.status).to.equal("broadcast-pending")
    expect(restoredUnknown.operatorAlertStatus).to.equal("open")
    expect(restoredUnknown.operatorAlertCode).to.equal(
      "P2TR-CHALLENGE-BROADCAST-FINALITY-UNKNOWN"
    )
    expect(restoredUnknown.challengeBroadcastReconciliationAttempts).to.equal(1)
    expect(restoredUnknown.lastChallengeBroadcastResolution).to.equal("unknown")
    expect(unknownSubmitter.submissionCount).to.equal(0)
  })

  it("rejects Bridge submissions with ambiguous finality receipts", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      bridgeChallengeDomain
    )
    const submitter = new P2TRSignatureFraudBridgeChallengeSubmitter(
      {
        async processP2TRSignatureFraudChallenge() {
          return {
            hash: `0x${"a".repeat(64)}`,
            async wait() {
              return {}
            },
          }
        },
      },
      { challengeDepositAmount: 1 }
    )

    await expectWitnessRejection(
      () => submitter.submitSignatureFraudChallenge(observation),
      "invalid-watchtower-state"
    )
  })

  it("keeps unapproved spend types observation-only while submission is disabled", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const watchtower = new P2TRSignatureFraudWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex]
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("8"))
    await expectWitnessRejection(
      () => watchtower.submitChallenge(observed.observation, submitter),
      "invalid-watchtower-state"
    )

    expect(observed.observation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED
    )
    expect(observed.record.status).to.equal("observed")
    expect(observed.record.submissionAttempts).to.equal(0)
    expect(observed.record.challengeTxHash).to.equal(undefined)
    expect(submitter.submissionCount).to.equal(0)
  })

  it("rejects automatic submission for fail-closed spend policies", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const watchtower = new P2TRSignatureFraudWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex]
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("8"))

    await expectWitnessRejection(
      () =>
        watchtower.submitChallenge(observed.observation, submitter, {
          allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED],
        }),
      "invalid-watchtower-state"
    )
    expect(submitter.submissionCount).to.equal(0)

    const failClosedSpendTypes: P2TRSignatureFraudSpendType[] = [
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING,
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT,
    ]

    for (const spendType of failClosedSpendTypes) {
      expectWitnessError(
        () =>
          new P2TRSignatureFraudWatchtowerRunner(
            new P2TRSignatureFraudWatchtower(
              new InMemoryP2TRWatchtowerChallengeStore(),
              [vector.walletIDHex]
            ),
            {} as BitcoinClient,
            new FakeP2TRSignatureFraudChallengeSubmitter(),
            {
              submitChallenges: true,
              submissionPolicy: { allowedSpendTypes: [spendType] },
            }
          ),
        "invalid-watchtower-state"
      )
    }
  })

  it("fails closed for inconsistent observations before submission", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const watchtower = new P2TRSignatureFraudWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex]
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("9"))

    await expectWitnessRejection(
      () =>
        watchtower.submitChallenge(
          {
            ...observed.observation,
            spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
          },
          submitter,
          { allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION] }
        ),
      "invalid-watchtower-state"
    )
    expect(submitter.submissionCount).to.equal(0)
  })

  it("keeps classified approved spend types observation-only while submission is disabled", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const watchtower = new P2TRSignatureFraudWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex],
      undefined,
      () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("9"))
    await expectWitnessRejection(
      () =>
        watchtower.submitChallenge(observed.observation, submitter, {
          allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION],
        }),
      "invalid-watchtower-state"
    )

    expect(observed.observation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )
    expect(observed.record.status).to.equal("observed")
    expect(observed.record.challengeTxHash).to.equal(undefined)
    expect(submitter.submissionCount).to.equal(0)
  })

  it("marks Bridge-observed challenge lifecycle outcomes through the watchtower", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitted = await recordSubmittedChallenge(
      store,
      observed.observation,
      txHash("9")
    )
    const timeoutEligible = await watchtower.markChallengeTimeoutEligible(
      submitted.observationID
    )
    const slashed = await watchtower.markChallengeSlashed(
      submitted.observationID,
      txHash("a")
    )
    const rewarded = await watchtower.markChallengeRewarded(
      submitted.observationID,
      txHash("b")
    )

    expect(timeoutEligible.status).to.equal("timeout-eligible")
    expect(slashed.status).to.equal("slashed")
    expect(slashed.slashingTxHash?.toString()).to.equal(txHash("a"))
    expect(rewarded.status).to.equal("rewarded")
    expect(rewarded.rewardTxHash?.toString()).to.equal(txHash("b"))
  })

  it("preserves defeated watchtower challenges as terminal", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitted = await recordSubmittedChallenge(
      store,
      observed.observation,
      txHash("d")
    )
    await watchtower.raiseChallengeOperatorAlert(
      submitted.observationID,
      "submission-retry-limit",
      "manual intervention required"
    )
    const defeated = await watchtower.markChallengeDefeated(
      submitted.observationID,
      txHash("e")
    )
    const timeoutAfterDefeat = await watchtower.markChallengeTimeoutEligible(
      submitted.observationID
    )
    const slashedAfterDefeat = await watchtower.markChallengeSlashed(
      submitted.observationID,
      txHash("f")
    )

    expect(defeated.status).to.equal("defeated")
    expect(defeated.operatorAlertStatus).to.equal("cleared")
    expect(defeated.defeatTxHash?.toString()).to.equal(txHash("e"))
    expect(timeoutAfterDefeat).to.deep.equal(defeated)
    expect(slashedAfterDefeat).to.deep.equal(defeated)
  })

  it("does not resubmit timeout-eligible challenges", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitted = await recordSubmittedChallenge(
      store,
      observed.observation,
      txHash("9")
    )
    const timeoutEligible = await watchtower.markChallengeTimeoutEligible(
      submitted.observationID
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("a"))

    const replayed = await new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      {} as BitcoinClient,
      submitter,
      { submitChallenges: false }
    ).replayStoredChallengeRecords(store)

    expect(timeoutEligible.status).to.equal("timeout-eligible")
    expect(replayed).to.deep.equal([])
    expect(submitter.submissionCount).to.equal(0)
  })

  it("does not resubmit slashed challenges awaiting reward", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitted = await recordSubmittedChallenge(
      store,
      observed.observation,
      txHash("9")
    )
    const slashed = await watchtower.markChallengeSlashed(
      submitted.observationID,
      txHash("a")
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("b"))

    const replayed = await new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      {} as BitcoinClient,
      submitter,
      { submitChallenges: false }
    ).replayStoredChallengeRecords(store)
    const rewarded = await watchtower.markChallengeRewarded(
      submitted.observationID,
      txHash("c")
    )

    expect(slashed.status).to.equal("slashed")
    expect(replayed).to.deep.equal([])
    expect(submitter.submissionCount).to.equal(0)
    expect(rewarded.status).to.equal("rewarded")
    expect(rewarded.slashingTxHash?.toString()).to.equal(txHash("a"))
    expect(rewarded.rewardTxHash?.toString()).to.equal(txHash("c"))
  })

  it("tracks and clears operator alerts for submitted challenges", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitted = await recordSubmittedChallenge(
      store,
      observed.observation,
      txHash("2")
    )
    const raised = await watchtower.raiseChallengeOperatorAlert(
      submitted.observationID,
      "P2TR-FRAUD-TIMEOUT",
      "challenge timeout needs operator follow-up"
    )
    const acknowledged = await watchtower.acknowledgeChallengeOperatorAlert(
      submitted.observationID,
      "ops-oncall"
    )
    const unresolvedAlerts = await listP2TRWatchtowerUnresolvedOperatorAlerts(
      store
    )
    const defeated = await watchtower.markChallengeDefeated(
      submitted.observationID,
      txHash("3")
    )
    const unresolvedAlertsAfterDefeat =
      await listP2TRWatchtowerUnresolvedOperatorAlerts(store)
    const cleared = await watchtower.clearChallengeOperatorAlert(
      submitted.observationID
    )
    const unresolvedAlertsAfterClearing =
      await listP2TRWatchtowerUnresolvedOperatorAlerts(store)

    expect(raised.operatorAlertStatus).to.equal("open")
    expect(raised.operatorAlertCode).to.equal("P2TR-FRAUD-TIMEOUT")
    expect(raised.operatorAlertMessage).to.equal(
      "challenge timeout needs operator follow-up"
    )
    expect(acknowledged.operatorAlertStatus).to.equal("acknowledged")
    expect(acknowledged.operatorAlertAcknowledgedBy).to.equal("ops-oncall")
    expect(unresolvedAlerts).to.have.lengthOf(1)
    expect(unresolvedAlerts[0].operatorAlertStatus).to.equal("acknowledged")
    expect(unresolvedAlerts[0].observationID.toString()).to.equal(
      submitted.observationID.toString()
    )
    expect(defeated.status).to.equal("defeated")
    expect(defeated.operatorAlertStatus).to.equal("cleared")
    expect(unresolvedAlertsAfterDefeat).to.deep.equal([])
    expect(cleared.status).to.equal("defeated")
    expect(cleared.operatorAlertStatus).to.equal("cleared")
    expect(unresolvedAlertsAfterClearing).to.deep.equal([])
  })

  it("rejects operator alert acknowledgements before an alert is open", async () => {
    const store = new InMemoryP2TRWatchtowerChallengeStore([
      createP2TRWatchtowerChallengeRecord(txHash("4")),
    ])
    const watchtower = new P2TRSignatureFraudWatchtower(store, [txHash("5")])

    await expectWitnessRejection(
      () =>
        watchtower.acknowledgeChallengeOperatorAlert(txHash("4"), "ops-oncall"),
      "invalid-watchtower-state"
    )
  })

  it("summarizes watchtower records for operator reporting", async () => {
    const store = new InMemoryP2TRWatchtowerChallengeStore([
      {
        ...createP2TRWatchtowerChallengeRecord(txHash("1")),
        bitcoinStatus: "mempool",
        operatorAlertStatus: "open",
      },
      {
        ...createP2TRWatchtowerChallengeRecord(txHash("2")),
        status: "submitted",
        bitcoinStatus: "confirmed",
        operatorAlertStatus: "acknowledged",
      },
      {
        ...createP2TRWatchtowerChallengeRecord(txHash("3")),
        status: "rewarded",
        operatorAlertStatus: "cleared",
      },
    ])

    const summary = await summarizeP2TRWatchtowerChallengeRecords(store)

    expect(summary.total).to.equal(3)
    expect(summary.byStatus.observed).to.equal(1)
    expect(summary.byStatus.submitted).to.equal(1)
    expect(summary.byStatus.rewarded).to.equal(1)
    expect(summary.byStatus.rejected).to.equal(0)
    expect(summary.byBitcoinStatus.mempool).to.equal(1)
    expect(summary.byBitcoinStatus.confirmed).to.equal(1)
    expect(summary.byBitcoinStatus.reorged).to.equal(0)
    expect(summary.byOperatorAlertStatus.open).to.equal(1)
    expect(summary.byOperatorAlertStatus.acknowledged).to.equal(1)
    expect(summary.byOperatorAlertStatus.cleared).to.equal(1)
    expect(summary.unresolvedOperatorAlerts).to.equal(2)
  })

  it("processes mempool transactions observation-only through the watchtower runner", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient
    const watchtower = createDraftApprovedP2TRWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex]
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("8"))
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      bitcoinClient,
      submitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const processed = await runner.processMempoolTransaction(
      rawTransaction,
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const duplicate = await runner.processMempoolTransaction(
      rawTransaction,
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const batch = await runner.processMempoolTransactions([
      {
        rawTransaction,
        bitcoinTxHash: authenticatedBitcoinTxHash(rawTransaction),
      },
    ])

    expect(processed).to.have.lengthOf(1)
    expect(batch).to.have.lengthOf(1)
    expect(processed[0].record.bitcoinStatus).to.equal("mempool")
    expect(processed[0].submissionRecord.status).to.equal("observed")
    expect(processed[0].submissionRecord.challengeTxHash).to.equal(undefined)
    expect(duplicate[0].submissionRecord).to.deep.equal(
      processed[0].submissionRecord
    )
    expect(batch[0].submissionRecord).to.deep.equal(
      processed[0].submissionRecord
    )
    expect(submitter.submissionCount).to.equal(0)
  })

  it("defaults watchtower runner processing to observation-only", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("8"))
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      new P2TRSignatureFraudWatchtower(store, [vector.walletIDHex]),
      bitcoinClient,
      submitter,
      { submissionPolicy: draftApprovedSubmissionPolicy }
    )

    const [processed] = await runner.processMempoolTransaction(
      rawTransaction,
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const [duplicate] = await runner.processMempoolTransaction(
      rawTransaction,
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const [replayed] = await runner.replayStoredChallengeRecords(store)

    expect(processed.record.bitcoinStatus).to.equal("mempool")
    expect(processed.submissionRecord.status).to.equal("observed")
    expect(processed.submissionRecord.submissionAttempts).to.equal(0)
    expect(processed.submissionRecord.challengeTxHash).to.equal(undefined)
    expect(duplicate.submissionRecord).to.deep.equal(processed.submissionRecord)
    expect(replayed.submissionRecord).to.deep.equal(processed.submissionRecord)
    expect(submitter.submissionCount).to.equal(0)
  })

  it("rejects submit-enabled runners without approved spend types", () => {
    const vector = vectorCorpus.cases[0]

    expectWitnessError(
      () =>
        new P2TRSignatureFraudWatchtowerRunner(
          new P2TRSignatureFraudWatchtower(
            new InMemoryP2TRWatchtowerChallengeStore(),
            [vector.walletIDHex]
          ),
          {} as BitcoinClient,
          new FakeP2TRSignatureFraudChallengeSubmitter(),
          { submitChallenges: true }
        ),
      "invalid-watchtower-state"
    )
    expectWitnessError(
      () =>
        new P2TRSignatureFraudWatchtowerRunner(
          new P2TRSignatureFraudWatchtower(
            new InMemoryP2TRWatchtowerChallengeStore(),
            [vector.walletIDHex]
          ),
          {} as BitcoinClient,
          new FakeP2TRSignatureFraudChallengeSubmitter(),
          {
            submitChallenges: true,
            submissionPolicy: { allowedSpendTypes: [] },
          }
        ),
      "invalid-watchtower-state"
    )
  })

  it("processes confirmed transactions through the watchtower runner", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      new Error("bridge unavailable")
    )
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(
        new InMemoryP2TRWatchtowerChallengeStore(),
        [vector.walletIDHex]
      ),
      bitcoinClient,
      submitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const processed = await runner.processConfirmedTransaction(
      rawTransaction,
      bitcoinTxHash,
      txHash("b"),
      792
    )
    const batch = await runner.processConfirmedTransactions([
      {
        rawTransaction,
        bitcoinTxHash,
        bitcoinBlockHash: txHash("b"),
        bitcoinBlockHeight: 792,
      },
    ])

    expect(processed).to.have.lengthOf(1)
    expect(batch).to.have.lengthOf(1)
    expect(processed[0].record.bitcoinStatus).to.equal("confirmed")
    expect(processed[0].record.bitcoinBlockHeight).to.equal(792)
    expect(processed[0].submissionRecord.status).to.equal("observed")
    expect(processed[0].submissionRecord.lastError).to.equal(undefined)
    expect(submitter.submissionCount).to.equal(0)
  })

  it("does not submit when the runner observes no registered wallet spend", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("c"))
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      new P2TRSignatureFraudWatchtower(
        new InMemoryP2TRWatchtowerChallengeStore(),
        [txHash("d")]
      ),
      bitcoinClient,
      submitter
    )

    expect(
      await runner.processMempoolTransaction(
        rawTransaction,
        authenticatedBitcoinTxHash(rawTransaction)
      )
    ).to.deep.equal([])
    expect(submitter.submissionCount).to.equal(0)
  })

  it("settles batch transaction failures without dropping valid observations", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const malformedTransaction = Transaction.fromHex(
      vector.unsignedTransactionHex
    )
    malformedTransaction.ins[vector.signedInputIndex].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
      Buffer.from("51", "hex"),
      Buffer.from("c0", "hex"),
    ]
    const malformedRawTransaction = {
      transactionHex: malformedTransaction.toHex(),
    }
    const malformedBitcoinTxHash = authenticatedBitcoinTxHash(
      malformedRawTransaction
    )
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient
    const mempoolSubmitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      txHash("f")
    )
    const mempoolRunner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(
        new InMemoryP2TRWatchtowerChallengeStore(),
        [vector.walletIDHex]
      ),
      bitcoinClient,
      mempoolSubmitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )
    const confirmedSubmitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      txHash("1")
    )
    const confirmedRunner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(
        new InMemoryP2TRWatchtowerChallengeStore(),
        [vector.walletIDHex]
      ),
      bitcoinClient,
      confirmedSubmitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const mempoolBatch = await mempoolRunner.processMempoolTransactionsSettled([
      {
        rawTransaction,
        bitcoinTxHash: authenticatedBitcoinTxHash(rawTransaction),
      },
      {
        rawTransaction: malformedRawTransaction,
        bitcoinTxHash: malformedBitcoinTxHash,
      },
    ])
    const confirmedBatch =
      await confirmedRunner.processConfirmedTransactionsSettled([
        {
          rawTransaction,
          bitcoinTxHash,
          bitcoinBlockHash: txHash("5"),
          bitcoinBlockHeight: 793,
        },
        {
          rawTransaction: malformedRawTransaction,
          bitcoinTxHash: malformedBitcoinTxHash,
          bitcoinBlockHash: txHash("7"),
          bitcoinBlockHeight: 793,
        },
      ])

    expect(mempoolBatch.submissions).to.have.lengthOf(1)
    expect(mempoolBatch.failures).to.have.lengthOf(1)
    expect(mempoolBatch.failures[0].transaction.bitcoinTxHash).to.equal(
      malformedBitcoinTxHash
    )
    expect(mempoolBatch.failures[0].error).to.include(
      "Only Taproot key-path witnesses"
    )
    expect(confirmedBatch.submissions).to.have.lengthOf(1)
    expect(confirmedBatch.failures).to.have.lengthOf(1)
    expect(confirmedBatch.failures[0].transaction.bitcoinTxHash).to.equal(
      malformedBitcoinTxHash
    )
    expect(mempoolSubmitter.submissionCount).to.equal(0)
    expect(confirmedSubmitter.submissionCount).to.equal(0)
  })

  it("replays restored watchtower challenges with persisted observations", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const initialStore = new InMemoryP2TRWatchtowerChallengeStore()
    const initialWatchtower = createDraftApprovedP2TRWatchtower(initialStore, [
      vector.walletIDHex,
    ])
    const [observed] = await initialWatchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const rejected = await recordRejectedChallenge(
      initialStore,
      observed.observation,
      "rpc timeout"
    )
    const restoredRecord = deserializeP2TRWatchtowerChallengeRecord(
      serializeP2TRWatchtowerChallengeRecord(rejected)
    )
    const restartedStore = new InMemoryP2TRWatchtowerChallengeStore([
      restoredRecord,
    ])
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("1"))
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(restartedStore, [vector.walletIDHex]),
      {} as BitcoinClient,
      submitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const [replayed] = await runner.replayStoredChallengeRecords(restartedStore)
    const skipped = await runner.replayStoredChallenges([
      {
        ...restoredRecord,
        status: "submitted",
      },
      createP2TRWatchtowerChallengeRecord(txHash("2")),
    ])

    expect(replayed.record.status).to.equal("rejected")
    expect(replayed.observation.observationID.toString()).to.equal(
      restoredRecord.observationID.toString()
    )
    expect(replayed.submissionRecord.status).to.equal("rejected")
    expect(replayed.submissionRecord.submissionAttempts).to.equal(1)
    expect(replayed.submissionRecord.challengeTxHash).to.equal(undefined)
    expect(skipped).to.deep.equal([])
    expect(submitter.submissionCount).to.equal(0)
  })

  it("honors runner submission attempt limits for rejected challenges", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      new Error("bridge unavailable")
    )
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    await recordRejectedChallenge(
      store,
      observed.observation,
      "bridge unavailable"
    )
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      bitcoinClient,
      submitter,
      {
        submitChallenges: false,
        maxSubmissionAttempts: 1,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const [firstAttempt] = await runner.processMempoolTransaction(
      rawTransaction,
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const [duplicateObservation] = await runner.processMempoolTransaction(
      rawTransaction,
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const [replayed] = await runner.replayStoredChallengeRecords(store)

    expect(firstAttempt.submissionRecord.status).to.equal("rejected")
    expect(firstAttempt.submissionRecord.submissionAttempts).to.equal(1)
    expect(duplicateObservation.submissionRecord.status).to.equal("rejected")
    expect(duplicateObservation.submissionRecord.submissionAttempts).to.equal(1)
    expect(replayed.submissionRecord.status).to.equal("rejected")
    expect(replayed.submissionRecord.submissionAttempts).to.equal(1)
    expect(submitter.submissionCount).to.equal(0)
  })

  it("raises operator alerts when runner submission attempt limits are reached", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      new Error("bridge unavailable")
    )
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    await recordRejectedChallenge(
      store,
      observed.observation,
      "bridge unavailable"
    )
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      bitcoinClient,
      submitter,
      {
        submitChallenges: false,
        maxSubmissionAttempts: 1,
        submissionPolicy: draftApprovedSubmissionPolicy,
        submissionAttemptLimitAlert: {
          code: "P2TR-SUBMISSION-ATTEMPT-LIMIT",
          message: "challenge submission reached its retry limit",
        },
      }
    )

    const [firstAttempt] = await runner.processMempoolTransaction(
      rawTransaction,
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const [duplicateObservation] = await runner.processMempoolTransaction(
      rawTransaction,
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const [replayed] = await runner.replayStoredChallengeRecords(store)

    expect(firstAttempt.submissionRecord.status).to.equal("rejected")
    expect(firstAttempt.submissionRecord.submissionAttempts).to.equal(1)
    expect(firstAttempt.submissionRecord.operatorAlertStatus).to.equal(
      undefined
    )
    expect(duplicateObservation.submissionRecord.submissionAttempts).to.equal(1)
    expect(duplicateObservation.submissionRecord.operatorAlertStatus).to.equal(
      undefined
    )
    expect(replayed.submissionRecord.submissionAttempts).to.equal(1)
    expect(replayed.submissionRecord.operatorAlertStatus).to.equal("open")
    expect(replayed.submissionRecord.operatorAlertCode).to.equal(
      "P2TR-SUBMISSION-ATTEMPT-LIMIT"
    )
    expect(replayed.submissionRecord.operatorAlertMessage).to.equal(
      "challenge submission reached its retry limit"
    )
    expect(submitter.submissionCount).to.equal(0)
  })

  it("rejects invalid runner submission attempt limits", () => {
    expectWitnessError(
      () =>
        new P2TRSignatureFraudWatchtowerRunner(
          new P2TRSignatureFraudWatchtower(
            new InMemoryP2TRWatchtowerChallengeStore(),
            [vectorCorpus.cases[0].walletIDHex]
          ),
          {} as BitcoinClient,
          new FakeP2TRSignatureFraudChallengeSubmitter(),
          { maxSubmissionAttempts: 0 }
        ),
      "invalid-watchtower-state"
    )
  })

  it("rejects invalid runner submission attempt limit alerts", () => {
    expectWitnessError(
      () =>
        new P2TRSignatureFraudWatchtowerRunner(
          new P2TRSignatureFraudWatchtower(
            new InMemoryP2TRWatchtowerChallengeStore(),
            [vectorCorpus.cases[0].walletIDHex]
          ),
          {} as BitcoinClient,
          new FakeP2TRSignatureFraudChallengeSubmitter(),
          {
            maxSubmissionAttempts: 1,
            submissionAttemptLimitAlert: {
              code: "",
              message: "challenge submission reached its retry limit",
            },
          }
        ),
      "invalid-watchtower-state"
    )
  })

  it("processes watchtower transaction source cycles with summaries and source failures", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      new Error("bridge unavailable")
    )
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(store, [vector.walletIDHex]),
      bitcoinClient,
      submitter,
      {
        submitChallenges: false,
        maxSubmissionAttempts: 1,
        submissionPolicy: draftApprovedSubmissionPolicy,
        submissionAttemptLimitAlert: {
          code: "P2TR-SUBMISSION-ATTEMPT-LIMIT",
          message: "challenge submission reached its retry limit",
        },
      }
    )

    const cycle = await runner.processTransactionSourceSettled(
      {
        listMempoolTransactions: async () => [
          {
            rawTransaction,
            bitcoinTxHash: authenticatedBitcoinTxHash(rawTransaction),
          },
        ],
        listConfirmedTransactions: async () => {
          throw new Error("confirmed source unavailable")
        },
      },
      store
    )

    expect(cycle.replayed).to.deep.equal([])
    expect(cycle.mempool.submissions).to.have.lengthOf(1)
    expect(cycle.mempool.failures).to.deep.equal([])
    expect(cycle.mempool.submissions[0].submissionRecord.status).to.equal(
      "observed"
    )
    expect(
      cycle.mempool.submissions[0].submissionRecord.operatorAlertStatus
    ).to.equal(undefined)
    expect(cycle.confirmed.submissions).to.deep.equal([])
    expect(cycle.confirmed.failures).to.deep.equal([])
    expect(cycle.sourceFailures).to.deep.equal([
      {
        source: "confirmed",
        error: "confirmed source unavailable",
      },
    ])
    expect(cycle.summary.total).to.equal(1)
    expect(cycle.summary.byStatus.observed).to.equal(1)
    expect(cycle.summary.byBitcoinStatus.mempool).to.equal(1)
    expect(cycle.summary.byOperatorAlertStatus.open).to.equal(0)
    expect(cycle.summary.unresolvedOperatorAlerts).to.equal(0)
    expect(cycle.unresolvedOperatorAlerts).to.deep.equal([])
    expect(submitter.submissionCount).to.equal(0)
  })

  it("replays stored challenges during watchtower transaction source cycles", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const initialWatchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await initialWatchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    await recordRejectedChallenge(store, observed.observation, "rpc timeout")
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("2"))
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(store, [vector.walletIDHex]),
      {} as BitcoinClient,
      submitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const cycle = await runner.processTransactionSourceSettled(
      {
        listMempoolTransactions: async () => [],
        listConfirmedTransactions: async () => ({
          transactions: [],
          complete: true,
        }),
      },
      store
    )

    expect(cycle.replayed).to.have.lengthOf(1)
    expect(cycle.replayed[0].submissionRecord.status).to.equal("rejected")
    expect(cycle.replayed[0].submissionRecord.submissionAttempts).to.equal(1)
    expect(cycle.replayed[0].submissionRecord.challengeTxHash).to.equal(
      undefined
    )
    expect(cycle.mempool.submissions).to.deep.equal([])
    expect(cycle.confirmed.submissions).to.deep.equal([])
    expect(cycle.sourceFailures).to.deep.equal([])
    expect(cycle.summary.total).to.equal(1)
    expect(cycle.summary.byStatus.rejected).to.equal(1)
    expect(submitter.submissionCount).to.equal(0)
  })

  it("processes Bridge lifecycle source cycles with summaries and isolated failures", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitted = await recordSubmittedChallenge(
      store,
      observed.observation,
      txHash("2")
    )
    await watchtower.raiseChallengeOperatorAlert(
      submitted.observationID,
      "submission-retry-limit",
      "manual intervention required"
    )
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
    )

    const cycle = await runner.processBridgeLifecycleEventSourceSettled(
      {
        listBridgeLifecycleEvents: async () => [
          {
            type: "timeout-eligible",
            observationID: submitted.observationID,
          },
          {
            type: "slashed",
            observationID: submitted.observationID,
            slashingTxHash: txHash("3"),
          },
          {
            type: "rewarded",
            observationID: submitted.observationID,
            rewardTxHash: txHash("4"),
          },
          {
            type: "defeated",
            observationID: txHash("f"),
            defeatTxHash: txHash("5"),
          },
        ],
      },
      store
    )

    expect(cycle.bridgeLifecycle.records).to.have.lengthOf(3)
    expect(cycle.bridgeLifecycle.records[0].record.status).to.equal(
      "timeout-eligible"
    )
    expect(cycle.bridgeLifecycle.records[1].record.status).to.equal("slashed")
    expect(
      cycle.bridgeLifecycle.records[1].record.slashingTxHash?.toString()
    ).to.equal(txHash("3"))
    expect(cycle.bridgeLifecycle.records[2].record.status).to.equal("rewarded")
    expect(
      cycle.bridgeLifecycle.records[2].record.slashingTxHash?.toString()
    ).to.equal(txHash("3"))
    expect(
      cycle.bridgeLifecycle.records[2].record.rewardTxHash?.toString()
    ).to.equal(txHash("4"))
    expect(cycle.bridgeLifecycle.failures).to.have.lengthOf(1)
    expect(cycle.bridgeLifecycle.failures[0].event).to.deep.equal({
      type: "defeated",
      observationID: txHash("f"),
      defeatTxHash: txHash("5"),
    })
    expect(cycle.bridgeLifecycle.failures[0].error).to.equal(
      "Watchtower challenge record must exist before non-observation events"
    )
    expect(cycle.sourceFailures).to.deep.equal([])
    expect(cycle.summary.total).to.equal(1)
    expect(cycle.summary.byStatus.rewarded).to.equal(1)
    expect(cycle.summary.byBitcoinStatus.mempool).to.equal(1)
    expect(cycle.unresolvedOperatorAlerts).to.deep.equal([])

    const finalRecord = await store.getChallengeRecord(submitted.observationID)
    expect(finalRecord?.status).to.equal("rewarded")
    expect(finalRecord?.operatorAlertStatus).to.equal("cleared")
    expect(finalRecord?.slashingTxHash?.toString()).to.equal(txHash("3"))
    expect(finalRecord?.rewardTxHash?.toString()).to.equal(txHash("4"))
  })

  it("resolves Bridge lifecycle events by stored Bridge challenge keys", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(
      store,
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const submitted = await recordSubmittedChallenge(
      store,
      observed.observation,
      txHash("7")
    )
    const bridgeChallengeKey = observed.observation.bridgeChallengeKey
    if (bridgeChallengeKey === undefined) {
      throw new Error("Expected Bridge challenge key")
    }

    const runner = new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
    )
    const cycle = await runner.processBridgeLifecycleEventSourceSettled(
      {
        listBridgeLifecycleEvents: async () => [
          {
            type: "timeout-eligible",
            bridgeChallengeKey,
            walletID: observed.observation.walletID,
            bridgeChallengeIdentity:
              observed.observation.bridgeChallengeIdentity,
            sighash: observed.observation.sighash,
          },
        ],
      },
      store
    )

    expect(bridgeChallengeKey.toString()).to.equal(
      expectedVector0BridgeChallengeKey
    )
    expect(cycle.bridgeLifecycle.records).to.have.lengthOf(1)
    expect(cycle.bridgeLifecycle.records[0].record.status).to.equal(
      "timeout-eligible"
    )
    expect(
      cycle.bridgeLifecycle.records[0].record.observationID.toString()
    ).to.equal(submitted.observationID.toString())
    expect(cycle.bridgeLifecycle.failures).to.deep.equal([])
    expect(cycle.summary.byStatus["timeout-eligible"]).to.equal(1)
  })

  it("deduplicates flexible-sighash replacements by canonical Bridge key", async () => {
    const vector = loadFullSighashVectorCorpus().cases.find(
      (candidate) => candidate.id === "bip341-keypath-anyonecanpay-none-multi"
    )
    if (vector === undefined) {
      throw new Error("Missing ANYONECANPAY|NONE P2TR signature-fraud vector")
    }

    const originalRawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const replacementTransaction = Transaction.fromHex(
      vector.unsignedTransactionHex
    )
    replacementTransaction.outs[0].value--
    const replacementRawTransaction = withInputWitness(
      replacementTransaction.toHex(),
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector).map(
      (prevout, inputIndex) =>
        inputIndex === vector.signedInputIndex
          ? prevout
          : { ...prevout, scriptPubKey: "51" }
    )
    const persistence = new InMemoryP2TRWatchtowerChallengeRecordPersistence()
    const store = new P2TRWatchtowerSerializedChallengeStore(persistence)
    const watchtower = createDraftApprovedP2TRWatchtower(
      store,
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [[original], [replacement]] = await Promise.all([
      watchtower.observeMempoolTransaction(
        originalRawTransaction,
        inputPrevouts,
        authenticatedBitcoinTxHash(originalRawTransaction)
      ),
      watchtower.observeMempoolTransaction(
        replacementRawTransaction,
        inputPrevouts,
        authenticatedBitcoinTxHash(replacementRawTransaction)
      ),
    ])
    const originalSubmission = await recordSubmittedChallenge(
      store,
      original.observation,
      txHash("7")
    )
    const replacementSubmission = await store.getChallengeRecord(
      replacement.observation.observationID
    )
    const [reobservedReplacement] = await watchtower.observeMempoolTransaction(
      replacementRawTransaction,
      inputPrevouts,
      authenticatedBitcoinTxHash(replacementRawTransaction)
    )
    const replayedReplacementSubmission = await store.getChallengeRecord(
      reobservedReplacement.observation.observationID
    )

    const bridgeChallengeKey = original.observation.bridgeChallengeKey
    if (bridgeChallengeKey === undefined) {
      throw new Error("Expected Bridge challenge key")
    }

    const reloadedStore = new P2TRWatchtowerSerializedChallengeStore(
      persistence
    )
    const lifecycle = await new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(
        reloadedStore,
        [vector.walletIDHex],
        bridgeChallengeDomain
      ),
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
    ).processBridgeLifecycleEventsSettled(
      [
        { type: "timeout-eligible", bridgeChallengeKey },
        { type: "defeated", bridgeChallengeKey, defeatTxHash: txHash("9") },
      ],
      reloadedStore
    )
    const records = await reloadedStore.listChallengeRecords()
    const finalRecord = await reloadedStore.getChallengeRecord(
      bridgeChallengeKey
    )

    expect(originalRawTransaction.transactionHex).to.not.equal(
      replacementRawTransaction.transactionHex
    )
    expect(original.observation.sighash.toString()).to.equal(
      replacement.observation.sighash.toString()
    )
    expect(original.observation.bridgeChallengeIdentity.toString()).to.equal(
      replacement.observation.bridgeChallengeIdentity.toString()
    )
    expect(original.observation.bridgeChallengeKey?.toString()).to.equal(
      replacement.observation.bridgeChallengeKey?.toString()
    )
    expect(original.observation.observationID.toString()).to.equal(
      bridgeChallengeKey.toString()
    )
    expect(replacement.observation.observationID.toString()).to.equal(
      bridgeChallengeKey.toString()
    )
    expect(originalSubmission.status).to.equal("submitted")
    expect(replacementSubmission?.status).to.equal("submitted")
    expect(replayedReplacementSubmission?.status).to.equal("submitted")
    expect(records).to.have.lengthOf(1)
    expect(persistence.records).to.have.lengthOf(1)
    expect(lifecycle.failures).to.deep.equal([])
    expect(lifecycle.records).to.have.lengthOf(2)
    expect(finalRecord?.status).to.equal("defeated")
    expect(finalRecord?.defeatTxHash?.toString()).to.equal(txHash("9"))
    expect(finalRecord?.observation?.rawTransaction.transactionHex).to.equal(
      originalRawTransaction.transactionHex
    )
  })

  it("preserves confirmed proof aliases across flexible-sighash replacements", async () => {
    const vector = loadFullSighashVectorCorpus().cases.find(
      (candidate) => candidate.id === "bip341-keypath-anyonecanpay-none-multi"
    )
    if (vector === undefined) {
      throw new Error("Missing ANYONECANPAY|NONE P2TR signature-fraud vector")
    }

    const originalRawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const replacementTransaction = Transaction.fromHex(
      vector.unsignedTransactionHex
    )
    replacementTransaction.outs[0].value--
    const replacementRawTransaction = withInputWitness(
      replacementTransaction.toHex(),
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector).map(
      (prevout, inputIndex) =>
        inputIndex === vector.signedInputIndex
          ? prevout
          : { ...prevout, scriptPubKey: "51" }
    )
    const spendTypeClassifier: P2TRSignatureFraudSpendTypeClassifier = ({
      unsignedTransaction,
    }) =>
      unsignedTransaction.transactionHex === vector.unsignedTransactionHex
        ? P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
        : P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
    const persistence = new InMemoryP2TRWatchtowerChallengeRecordPersistence()
    const store = new P2TRWatchtowerSerializedChallengeStore(persistence)
    const watchtower = new P2TRSignatureFraudWatchtower(
      store,
      [vector.walletIDHex],
      undefined,
      spendTypeClassifier,
      undefined,
      bridgeChallengeDomain
    )
    const originalBitcoinTxHash = Transaction.fromHex(
      originalRawTransaction.transactionHex
    ).getId()
    const replacementBitcoinTxHash = Transaction.fromHex(
      replacementRawTransaction.transactionHex
    ).getId()
    const [original] = await watchtower.observeConfirmedTransaction(
      originalRawTransaction,
      inputPrevouts,
      originalBitcoinTxHash,
      txHash("a"),
      143
    )
    await recordSubmittedChallenge(store, original.observation, txHash("7"))
    const [replacement] = await watchtower.observeConfirmedTransaction(
      replacementRawTransaction,
      inputPrevouts,
      replacementBitcoinTxHash,
      txHash("b"),
      144
    )

    const reloadedStore = new P2TRWatchtowerSerializedChallengeStore(
      persistence
    )
    const reloadedRecord = await reloadedStore.getChallengeRecord(
      original.observation.observationID
    )
    const originalProofObservationID =
      await resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
        reloadedStore,
        originalBitcoinTxHash,
        P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
      )
    const replacementProofObservationID =
      await resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
        reloadedStore,
        replacementBitcoinTxHash,
        P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
      )

    await expectWitnessRejection(
      () =>
        resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
          reloadedStore,
          replacementBitcoinTxHash,
          P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
        ),
      "invalid-watchtower-state"
    )

    const lifecycle = await new P2TRSignatureFraudWatchtowerRunner(
      new P2TRSignatureFraudWatchtower(
        reloadedStore,
        [vector.walletIDHex],
        undefined,
        spendTypeClassifier,
        undefined,
        bridgeChallengeDomain
      ),
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
    ).processBridgeLifecycleEventsSettled(
      [
        {
          type: "honest-spend-proven",
          bitcoinTxHash: replacementBitcoinTxHash,
          spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
        },
      ],
      reloadedStore
    )
    const finalRecord = await reloadedStore.getChallengeRecord(
      original.observation.observationID
    )

    expect(replacement.observation.observationID.toString()).to.equal(
      original.observation.observationID.toString()
    )
    expect(replacement.observation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
    )
    expect(reloadedRecord?.status).to.equal("submitted")
    expect(reloadedRecord?.observation?.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )
    expect(reloadedRecord?.observation?.rawTransaction.transactionHex).to.equal(
      originalRawTransaction.transactionHex
    )
    expect(reloadedRecord?.bitcoinTxHash?.toString()).to.equal(
      replacementBitcoinTxHash
    )
    expect(
      reloadedRecord?.bitcoinProofAliases?.map((alias) => ({
        bitcoinTxHash: alias.bitcoinTxHash.toString(),
        spendType: alias.spendType,
      }))
    ).to.deep.equal([
      {
        bitcoinTxHash: originalBitcoinTxHash,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
      {
        bitcoinTxHash: replacementBitcoinTxHash,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
      },
    ])
    expect(originalProofObservationID.toString()).to.equal(
      original.observation.observationID.toString()
    )
    expect(replacementProofObservationID.toString()).to.equal(
      original.observation.observationID.toString()
    )
    expect(lifecycle.records).to.have.lengthOf(1)
    expect(lifecycle.failures).to.deep.equal([])
    expect(lifecycle.ignored).to.deep.equal([])
    expect(finalRecord?.status).to.equal("defeat-eligible")
    expect(persistence.records[0].bitcoinProofAliases).to.deep.equal([
      {
        bitcoinTxHash: originalBitcoinTxHash,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
      {
        bitcoinTxHash: replacementBitcoinTxHash,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
      },
    ])
  })

  it("records metadata-only confirmations when the stored observation matches", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex],
      undefined,
      draftApprovedSpendTypeClassifier,
      undefined,
      bridgeChallengeDomain
    )
    const bitcoinTxHash = Hex.from(
      Transaction.fromHex(rawTransaction.transactionHex).getId()
    )
    const observedRecord = applyP2TRWatchtowerChallengeEvent(
      createP2TRWatchtowerChallengeRecord(observation.observationID),
      {
        type: "observed",
        observationID: observation.observationID,
        observation,
      }
    )
    const mempoolRecord = applyP2TRWatchtowerChallengeEvent(
      createP2TRWatchtowerChallengeRecord(observation.observationID),
      {
        type: "mempool-observed",
        observationID: observation.observationID,
        observation,
        bitcoinTxHash,
      }
    )
    const reloadedMempoolRecord = deserializeP2TRWatchtowerChallengeRecord(
      serializeP2TRWatchtowerChallengeRecord(mempoolRecord)
    )

    for (const [source, record] of [
      ["observed", observedRecord],
      ["reloaded mempool", reloadedMempoolRecord],
    ] as const) {
      const confirmedRecord = applyP2TRWatchtowerChallengeEvent(record, {
        type: "bitcoin-confirmed",
        observationID: observation.observationID,
        bitcoinTxHash,
        bitcoinBlockHash: txHash("a"),
        bitcoinBlockHeight: 143,
      })
      const store = new InMemoryP2TRWatchtowerChallengeStore([confirmedRecord])
      const proofObservationID =
        await resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
          store,
          bitcoinTxHash,
          P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
        )

      expect(confirmedRecord.bitcoinProofAliases, source).to.deep.equal([
        {
          bitcoinTxHash,
          spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
        },
      ])
      expect(proofObservationID.toString(), source).to.equal(
        observation.observationID.toString()
      )
    }

    const mismatchedBitcoinTxHash = Hex.from(txHash("b"))
    const mismatchedRecord = applyP2TRWatchtowerChallengeEvent(
      reloadedMempoolRecord,
      {
        type: "bitcoin-confirmed",
        observationID: observation.observationID,
        bitcoinTxHash: mismatchedBitcoinTxHash,
        bitcoinBlockHash: txHash("c"),
        bitcoinBlockHeight: 144,
      }
    )
    const mismatchedStore = new InMemoryP2TRWatchtowerChallengeStore([
      mismatchedRecord,
    ])

    expect(mismatchedRecord.bitcoinProofAliases).to.deep.equal([])
    await expectWitnessRejection(
      () =>
        resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
          mismatchedStore,
          mismatchedBitcoinTxHash,
          P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
        ),
      "invalid-watchtower-state"
    )
  })

  it("rejects confirmed proof aliases whose payload transaction hash does not match", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex],
      undefined,
      draftApprovedSpendTypeClassifier,
      undefined,
      bridgeChallengeDomain
    )
    const bitcoinTxHash = Hex.from(
      Transaction.fromHex(rawTransaction.transactionHex).getId()
    )
    const confirmedRecord = applyP2TRWatchtowerChallengeEvent(
      createP2TRWatchtowerChallengeRecord(observation.observationID),
      {
        type: "bitcoin-confirmed",
        observationID: observation.observationID,
        observation,
        bitcoinTxHash,
        bitcoinBlockHash: txHash("a"),
        bitcoinBlockHeight: 143,
      }
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore([confirmedRecord])
    const proofObservationID =
      await resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
        store,
        bitcoinTxHash,
        P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
      )

    expect(confirmedRecord.bitcoinProofAliases).to.deep.equal([
      {
        bitcoinTxHash,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
    ])
    expect(proofObservationID.toString()).to.equal(
      observation.observationID.toString()
    )

    expectWitnessError(
      () =>
        applyP2TRWatchtowerChallengeEvent(
          createP2TRWatchtowerChallengeRecord(observation.observationID),
          {
            type: "bitcoin-confirmed",
            observationID: observation.observationID,
            observation,
            bitcoinTxHash: txHash("b"),
            bitcoinBlockHash: txHash("c"),
            bitcoinBlockHeight: 144,
          }
        ),
      "invalid-watchtower-state"
    )
  })

  it("migrates only provable legacy confirmed proof metadata before replacements", async () => {
    const vector = loadFullSighashVectorCorpus().cases.find(
      (candidate) => candidate.id === "bip341-keypath-anyonecanpay-none-multi"
    )
    if (vector === undefined) {
      throw new Error("Missing ANYONECANPAY|NONE P2TR signature-fraud vector")
    }

    const originalRawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const replacementTransaction = Transaction.fromHex(
      vector.unsignedTransactionHex
    )
    replacementTransaction.outs[0].value--
    const replacementRawTransaction = withInputWitness(
      replacementTransaction.toHex(),
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector).map(
      (prevout, inputIndex) =>
        inputIndex === vector.signedInputIndex
          ? prevout
          : { ...prevout, scriptPubKey: "51" }
    )
    const spendTypeClassifier: P2TRSignatureFraudSpendTypeClassifier = ({
      unsignedTransaction,
    }) =>
      unsignedTransaction.transactionHex === vector.unsignedTransactionHex
        ? P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
        : P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
    const [originalObservation] = extractP2TRSignatureFraudWitnessObservations(
      originalRawTransaction,
      inputPrevouts,
      [vector.walletIDHex],
      undefined,
      spendTypeClassifier,
      undefined,
      bridgeChallengeDomain
    )
    const [replacementObservation] =
      extractP2TRSignatureFraudWitnessObservations(
        replacementRawTransaction,
        inputPrevouts,
        [vector.walletIDHex],
        undefined,
        spendTypeClassifier,
        undefined,
        bridgeChallengeDomain
      )
    const originalBitcoinTxHash = Hex.from(
      Transaction.fromHex(originalRawTransaction.transactionHex).getId()
    )
    const replacementBitcoinTxHash = Hex.from(
      Transaction.fromHex(replacementRawTransaction.transactionHex).getId()
    )
    const legacyConfirmedRecord = deserializeP2TRWatchtowerChallengeRecord(
      serializeP2TRWatchtowerChallengeRecord({
        ...createP2TRWatchtowerChallengeRecord(
          originalObservation.observationID
        ),
        observation: originalObservation,
        status: "submitted",
        bitcoinStatus: "confirmed",
        bitcoinTxHash: originalBitcoinTxHash,
        bitcoinBlockHash: Hex.from(txHash("a")),
        bitcoinBlockHeight: 143,
        challengeTxHash: Hex.from(txHash("b")),
      })
    )
    const reorgedRecord = applyP2TRWatchtowerChallengeEvent(
      legacyConfirmedRecord,
      {
        type: "bitcoin-reorged",
        observationID: originalObservation.observationID,
      }
    )
    const migratedRecord = applyP2TRWatchtowerChallengeEvent(reorgedRecord, {
      type: "bitcoin-confirmed",
      observationID: originalObservation.observationID,
      observation: replacementObservation,
      bitcoinTxHash: replacementBitcoinTxHash,
      bitcoinBlockHash: txHash("c"),
      bitcoinBlockHeight: 144,
    })
    const migratedStore = new InMemoryP2TRWatchtowerChallengeStore([
      migratedRecord,
    ])

    const originalProofObservationID =
      await resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
        migratedStore,
        originalBitcoinTxHash,
        P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
      )
    const replacementProofObservationID =
      await resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
        migratedStore,
        replacementBitcoinTxHash,
        P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
      )

    expect(originalProofObservationID.toString()).to.equal(
      originalObservation.observationID.toString()
    )
    expect(replacementProofObservationID.toString()).to.equal(
      originalObservation.observationID.toString()
    )
    expect(migratedRecord.bitcoinProofAliases).to.deep.equal([
      {
        bitcoinTxHash: originalBitcoinTxHash,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      },
      {
        bitcoinTxHash: replacementBitcoinTxHash,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
      },
    ])

    const alreadyBuggyRecord = deserializeP2TRWatchtowerChallengeRecord(
      serializeP2TRWatchtowerChallengeRecord({
        ...legacyConfirmedRecord,
        bitcoinTxHash: replacementBitcoinTxHash,
      })
    )
    const repairedRecord = applyP2TRWatchtowerChallengeEvent(
      alreadyBuggyRecord,
      {
        type: "bitcoin-confirmed",
        observationID: originalObservation.observationID,
        observation: replacementObservation,
        bitcoinTxHash: replacementBitcoinTxHash,
        bitcoinBlockHash: txHash("d"),
        bitcoinBlockHeight: 144,
      }
    )
    const repairedStore = new InMemoryP2TRWatchtowerChallengeStore([
      repairedRecord,
    ])
    const repairedProofObservationID =
      await resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
        repairedStore,
        replacementBitcoinTxHash,
        P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
      )

    expect(repairedProofObservationID.toString()).to.equal(
      originalObservation.observationID.toString()
    )
    expect(repairedRecord.bitcoinProofAliases).to.deep.equal([
      {
        bitcoinTxHash: replacementBitcoinTxHash,
        spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
      },
    ])
    await expectWitnessRejection(
      () =>
        resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
          repairedStore,
          originalBitcoinTxHash,
          P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
        ),
      "invalid-watchtower-state"
    )
  })

  it("uses legacy proof metadata only before alias-mode observations", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex],
      undefined,
      draftApprovedSpendTypeClassifier,
      undefined,
      bridgeChallengeDomain
    )
    const bitcoinTxHash = Hex.from(authenticatedBitcoinTxHash(rawTransaction))
    const legacyRecord: P2TRWatchtowerChallengeRecord = {
      ...createP2TRWatchtowerChallengeRecord(observation.observationID),
      observation,
      bitcoinTxHash,
    }
    const legacyStore = new InMemoryP2TRWatchtowerChallengeStore([legacyRecord])

    const resolvedObservationID =
      await resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
        legacyStore,
        bitcoinTxHash,
        P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
      )
    const aliasModeRecord = applyP2TRWatchtowerChallengeEvent(legacyRecord, {
      type: "mempool-observed",
      observationID: observation.observationID,
      observation,
      bitcoinTxHash,
    })
    const aliasModeStore = new InMemoryP2TRWatchtowerChallengeStore([
      aliasModeRecord,
    ])
    const roundTrippedAliasModeRecord =
      deserializeP2TRWatchtowerChallengeRecord(
        serializeP2TRWatchtowerChallengeRecord(aliasModeRecord)
      )

    expect(resolvedObservationID.toString()).to.equal(
      observation.observationID.toString()
    )
    expect(legacyRecord.bitcoinProofAliases).to.be.undefined
    expect(aliasModeRecord.bitcoinProofAliases).to.deep.equal([])
    expect(roundTrippedAliasModeRecord.bitcoinProofAliases).to.deep.equal([])
    await expectWitnessRejection(
      () =>
        resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
          aliasModeStore,
          bitcoinTxHash,
          P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
        ),
      "invalid-watchtower-state"
    )
  })

  it("deduplicates confirmed proof aliases and rejects classification conflicts", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [redemptionObservation] =
      extractP2TRSignatureFraudWitnessObservations(
        rawTransaction,
        toObservationPrevouts(vector),
        [vector.walletIDHex],
        undefined,
        draftApprovedSpendTypeClassifier,
        undefined,
        bridgeChallengeDomain
      )
    const observationID = redemptionObservation.observationID
    const bitcoinTxHash = Hex.from(
      Transaction.fromHex(rawTransaction.transactionHex).getId()
    )
    const movingFundsObservation: P2TRSignatureFraudWitnessObservation = {
      ...redemptionObservation,
      spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
    }
    const event = {
      type: "bitcoin-confirmed" as const,
      observationID,
      observation: redemptionObservation,
      bitcoinTxHash,
      bitcoinBlockHash: txHash("f"),
      bitcoinBlockHeight: 145,
    }
    const confirmed = applyP2TRWatchtowerChallengeEvent(
      createP2TRWatchtowerChallengeRecord(observationID),
      event
    )
    const duplicate = applyP2TRWatchtowerChallengeEvent(confirmed, event)
    const reorged = applyP2TRWatchtowerChallengeEvent(duplicate, {
      type: "bitcoin-reorged",
      observationID,
    })

    expect(duplicate.bitcoinProofAliases).to.have.lengthOf(1)
    expect(reorged.bitcoinProofAliases).to.deep.equal(
      duplicate.bitcoinProofAliases
    )
    expectWitnessError(
      () =>
        applyP2TRWatchtowerChallengeEvent(reorged, {
          ...event,
          observation: movingFundsObservation,
        }),
      "invalid-watchtower-state"
    )
  })

  it("serializes same-key replacement observations with submission lifecycle events", async () => {
    const vector = loadFullSighashVectorCorpus().cases.find(
      (candidate) => candidate.id === "bip341-keypath-anyonecanpay-none-multi"
    )
    if (vector === undefined) {
      throw new Error("Missing ANYONECANPAY|NONE P2TR signature-fraud vector")
    }

    const originalRawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const replacementTransaction = Transaction.fromHex(
      vector.unsignedTransactionHex
    )
    replacementTransaction.outs[0].value--
    const replacementRawTransaction = withInputWitness(
      replacementTransaction.toHex(),
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector).map(
      (prevout, inputIndex) =>
        inputIndex === vector.signedInputIndex
          ? prevout
          : { ...prevout, scriptPubKey: "51" }
    )
    const store = new BlockingP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(
      store,
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [original] = await watchtower.observeMempoolTransaction(
      originalRawTransaction,
      inputPrevouts,
      authenticatedBitcoinTxHash(originalRawTransaction)
    )

    const replacementSave = store.blockNextSave()
    const replacementObservation = watchtower.observeMempoolTransaction(
      replacementRawTransaction,
      inputPrevouts,
      authenticatedBitcoinTxHash(replacementRawTransaction)
    )
    await replacementSave.started
    const getCallsBeforeSubmission = store.getCalls
    const submission = recordSubmittedChallenge(
      store,
      original.observation,
      txHash("7")
    )
    const getCallsWhileReplacementSaveBlocked = store.getCalls
    replacementSave.unblock()

    const [[replacement], submitted] = await Promise.all([
      replacementObservation,
      submission,
    ])
    const finalRecord = await store.getChallengeRecord(
      original.observation.observationID
    )

    expect(replacement.observation.observationID.toString()).to.equal(
      original.observation.observationID.toString()
    )
    expect(getCallsWhileReplacementSaveBlocked).to.equal(
      getCallsBeforeSubmission
    )
    expect(submitted.status).to.equal("submitted")
    expect(finalRecord?.status).to.equal("submitted")
    expect(finalRecord?.submissionAttempts).to.equal(1)
    expect(finalRecord?.challengeTxHash?.toString()).to.equal(txHash("7"))
  })

  it("serializes lifecycle closure after a submission-started event", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new BlockingP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(
      store,
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )

    const observedSave = store.blockNextSave()
    const submission = recordP2TRWatchtowerChallengeEvent(store, {
      type: "submission-started",
      observationID: observed.observation.observationID,
      observation: observed.observation,
    })
    await observedSave.started
    const closure = watchtower.markChallengeTimeoutEligible(
      observed.observation.observationID
    )
    observedSave.unblock()

    const [submissionRecord, closureRecord] = await Promise.all([
      submission,
      closure,
    ])
    const finalRecord = await store.getChallengeRecord(
      observed.observation.observationID
    )

    expect(closureRecord.status).to.equal("timeout-eligible")
    expect(submissionRecord.status).to.equal("submitting")
    expect(finalRecord?.status).to.equal("timeout-eligible")
    expect(finalRecord?.submissionAttempts).to.equal(1)
  })

  it("atomically stores the flexible-sighash payload selected for submission", async () => {
    const vector = loadFullSighashVectorCorpus().cases.find(
      (candidate) => candidate.id === "bip341-keypath-anyonecanpay-none-multi"
    )
    if (vector === undefined) {
      throw new Error("Missing ANYONECANPAY|NONE P2TR signature-fraud vector")
    }

    const originalRawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const replacementTransaction = Transaction.fromHex(
      vector.unsignedTransactionHex
    )
    replacementTransaction.outs[0].value--
    const replacementRawTransaction = withInputWitness(
      replacementTransaction.toHex(),
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector).map(
      (prevout, inputIndex) =>
        inputIndex === vector.signedInputIndex
          ? prevout
          : { ...prevout, scriptPubKey: "51" }
    )
    const store = new BlockingP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(
      store,
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [original] = await watchtower.observeMempoolTransaction(
      originalRawTransaction,
      inputPrevouts,
      authenticatedBitcoinTxHash(originalRawTransaction)
    )

    const submissionObservationSave = store.blockNextSave()
    const submission = recordP2TRWatchtowerChallengeEvent(store, {
      type: "submission-started",
      observationID: original.observation.observationID,
      observation: original.observation,
    })
    await submissionObservationSave.started
    const replacementObservation = watchtower.observeMempoolTransaction(
      replacementRawTransaction,
      inputPrevouts,
      authenticatedBitcoinTxHash(replacementRawTransaction)
    )
    submissionObservationSave.unblock()

    const [submitting, [replacement]] = await Promise.all([
      submission,
      replacementObservation,
    ])
    const submitted = await recordP2TRWatchtowerChallengeEvent(store, {
      type: "submission-accepted",
      observationID: original.observation.observationID,
      challengeTxHash: txHash("7"),
    })
    const finalRecord = await store.getChallengeRecord(
      original.observation.observationID
    )

    expect(replacement.observation.observationID.toString()).to.equal(
      original.observation.observationID.toString()
    )
    expect(replacementRawTransaction.transactionHex).to.not.equal(
      originalRawTransaction.transactionHex
    )
    expect(submitting.status).to.equal("submitting")
    expect(submitted.status).to.equal("submitted")
    expect(finalRecord?.status).to.equal("submitted")
    expect(finalRecord?.observation?.rawTransaction.transactionHex).to.equal(
      originalRawTransaction.transactionHex
    )
  })

  it("keeps frozen crash-recovery payloads inert while submission is disabled", async () => {
    const vector = loadFullSighashVectorCorpus().cases.find(
      (candidate) => candidate.id === "bip341-keypath-anyonecanpay-none-multi"
    )
    if (vector === undefined) {
      throw new Error("Missing ANYONECANPAY|NONE P2TR signature-fraud vector")
    }

    const originalRawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const replacementTransaction = Transaction.fromHex(
      vector.unsignedTransactionHex
    )
    replacementTransaction.outs[0].value--
    const replacementRawTransaction = withInputWitness(
      replacementTransaction.toHex(),
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = toObservationPrevouts(vector).map(
      (prevout, inputIndex) =>
        inputIndex === vector.signedInputIndex
          ? prevout
          : { ...prevout, scriptPubKey: "51" }
    )
    const representationClassifier: P2TRSignatureFraudSpendTypeClassifier = ({
      unsignedTransaction,
    }) =>
      unsignedTransaction.transactionHex === vector.unsignedTransactionHex
        ? P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
        : P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
    const [originalObservation] = extractP2TRSignatureFraudWitnessObservations(
      originalRawTransaction,
      inputPrevouts,
      [vector.walletIDHex],
      undefined,
      representationClassifier,
      undefined,
      bridgeChallengeDomain
    )
    const [replacementObservation] =
      extractP2TRSignatureFraudWitnessObservations(
        replacementRawTransaction,
        inputPrevouts,
        [vector.walletIDHex],
        undefined,
        representationClassifier,
        undefined,
        bridgeChallengeDomain
      )
    const submittingRecord = applyP2TRWatchtowerChallengeEvent(
      applyP2TRWatchtowerChallengeEvent(
        createP2TRWatchtowerChallengeRecord(originalObservation.observationID),
        {
          type: "observed",
          observationID: originalObservation.observationID,
          observation: originalObservation,
        }
      ),
      {
        type: "submission-started",
        observationID: originalObservation.observationID,
        observation: originalObservation,
      }
    )
    const restoreSubmittingRecord = () =>
      deserializeP2TRWatchtowerChallengeRecord(
        serializeP2TRWatchtowerChallengeRecord(submittingRecord)
      )
    const movingFundsOnlyPolicy: P2TRSignatureFraudChallengeSubmissionPolicy = {
      allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS],
    }
    const redemptionOnlyPolicy: P2TRSignatureFraudChallengeSubmissionPolicy = {
      allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION],
    }

    expect(replacementObservation.observationID.toString()).to.equal(
      originalObservation.observationID.toString()
    )
    expect(originalObservation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )
    expect(replacementObservation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
    )
    expect(submittingRecord.status).to.equal("submitting")

    const allowedStore = new InMemoryP2TRWatchtowerChallengeStore([
      restoreSubmittingRecord(),
    ])
    const allowedWatchtower = new P2TRSignatureFraudWatchtower(
      allowedStore,
      [vector.walletIDHex],
      undefined,
      representationClassifier,
      undefined,
      bridgeChallengeDomain
    )
    const allowedSubmitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      txHash("6")
    )
    await expectWitnessRejection(
      () =>
        allowedWatchtower.submitChallenge(
          replacementObservation,
          allowedSubmitter,
          {
            allowedSpendTypes: [
              P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
              P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
            ],
          }
        ),
      "invalid-watchtower-state"
    )
    const allowed = await allowedStore.getChallengeRecord(
      originalObservation.observationID
    )

    expect(allowed?.status).to.equal("submitting")
    expect(allowed?.submissionAttempts).to.equal(1)
    expect(allowedSubmitter.submissionCount).to.equal(0)
    expect(allowed?.observation?.rawTransaction.transactionHex).to.equal(
      originalRawTransaction.transactionHex
    )
    expect(allowed?.observation?.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )

    const triggerPolicyStore = new InMemoryP2TRWatchtowerChallengeStore([
      restoreSubmittingRecord(),
    ])
    const triggerPolicyWatchtower = new P2TRSignatureFraudWatchtower(
      triggerPolicyStore,
      [vector.walletIDHex],
      undefined,
      representationClassifier,
      undefined,
      bridgeChallengeDomain
    )
    const triggerPolicySubmitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      txHash("7")
    )
    await expectWitnessRejection(
      () =>
        triggerPolicyWatchtower.submitChallenge(
          replacementObservation,
          triggerPolicySubmitter,
          redemptionOnlyPolicy
        ),
      "invalid-watchtower-state"
    )
    const triggerPolicyBlocked = await triggerPolicyStore.getChallengeRecord(
      originalObservation.observationID
    )

    expect(triggerPolicySubmitter.submissionCount).to.equal(0)
    expect(triggerPolicyBlocked?.status).to.equal("submitting")
    expect(triggerPolicyBlocked?.submissionAttempts).to.equal(1)
    expect(triggerPolicyBlocked?.operatorAlertStatus).to.equal(undefined)

    const policyStore = new InMemoryP2TRWatchtowerChallengeStore([
      restoreSubmittingRecord(),
    ])
    const policyWatchtower = new P2TRSignatureFraudWatchtower(
      policyStore,
      [vector.walletIDHex],
      undefined,
      representationClassifier,
      undefined,
      bridgeChallengeDomain
    )
    const policySubmitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      txHash("8")
    )
    await expectWitnessRejection(
      () =>
        policyWatchtower.submitChallenge(
          replacementObservation,
          policySubmitter,
          movingFundsOnlyPolicy
        ),
      "invalid-watchtower-state"
    )
    const policyBlocked = await policyStore.getChallengeRecord(
      originalObservation.observationID
    )

    expect(policySubmitter.submissionCount).to.equal(0)
    expect(policyBlocked?.status).to.equal("submitting")
    expect(policyBlocked?.operatorAlertStatus).to.equal(undefined)
    expect(policyBlocked?.observation?.rawTransaction.transactionHex).to.equal(
      originalRawTransaction.transactionHex
    )

    const currentClassifier: P2TRSignatureFraudSpendTypeClassifier = () =>
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
    const [currentReplacementObservation] =
      extractP2TRSignatureFraudWitnessObservations(
        replacementRawTransaction,
        inputPrevouts,
        [vector.walletIDHex],
        undefined,
        currentClassifier,
        undefined,
        bridgeChallengeDomain
      )
    const consistencyStore = new InMemoryP2TRWatchtowerChallengeStore([
      restoreSubmittingRecord(),
    ])
    const consistencyWatchtower = new P2TRSignatureFraudWatchtower(
      consistencyStore,
      [vector.walletIDHex],
      undefined,
      currentClassifier,
      undefined,
      bridgeChallengeDomain
    )
    const consistencySubmitter = new FakeP2TRSignatureFraudChallengeSubmitter(
      txHash("9")
    )

    await expectWitnessRejection(
      () =>
        consistencyWatchtower.submitChallenge(
          currentReplacementObservation,
          consistencySubmitter,
          movingFundsOnlyPolicy
        ),
      "invalid-watchtower-state"
    )
    expect(consistencySubmitter.submissionCount).to.equal(0)
    expect(
      (
        await consistencyStore.getChallengeRecord(
          originalObservation.observationID
        )
      )?.status
    ).to.equal("submitting")
  })

  it("resolves honest spend proof events by Bitcoin tx hash and spend type", async () => {
    const flowVectors = vectorCorpus.cases.filter(
      (vector) => vector.flowMetadata !== undefined
    )
    const vector = flowVectors.find(
      (candidate) =>
        candidate.flowMetadata?.spendType ===
        P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
    )

    if (vector?.flowMetadata === undefined) {
      throw new Error("Missing moving-funds flow-shaped vector")
    }

    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const classifier = createP2TRSignatureFraudSpendTypeClassifier(
      flowVectors.map((candidate) => ({
        spendType: candidate.flowMetadata!.spendType,
        matches: ({ unsignedTransaction, candidate: witnessCandidate }) =>
          unsignedTransaction.transactionHex ===
            candidate.unsignedTransactionHex &&
          witnessCandidate.inputIndex ===
            candidate.flowMetadata!.sourceWalletInput,
      }))
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = new P2TRSignatureFraudWatchtower(
      store,
      [vector.walletIDHex],
      undefined,
      classifier,
      undefined,
      bridgeChallengeDomain
    )
    const [observed] = await watchtower.observeConfirmedTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      bitcoinTxHash,
      txHash("b"),
      144
    )
    await recordSubmittedChallenge(store, observed.observation, txHash("c"))
    await watchtower.raiseChallengeOperatorAlert(
      observed.observation.observationID,
      "submission-retry-limit",
      "manual intervention required"
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("d"))
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      {} as BitcoinClient,
      submitter
    )

    const resolvedObservationID =
      await resolveP2TRWatchtowerObservationIDForBitcoinTxHashAndSpendType(
        store,
        bitcoinTxHash,
        vector.flowMetadata.spendType
      )
    const cycle = await runner.processBridgeLifecycleEventSourceSettled(
      {
        listBridgeLifecycleEvents: async () => [
          {
            type: "honest-spend-proven",
            bitcoinTxHash,
            spendType: vector.flowMetadata!.spendType,
            walletID: observed.observation.walletID,
            bridgeChallengeIdentity:
              observed.observation.bridgeChallengeIdentity,
            sighash: observed.observation.sighash,
          },
        ],
      },
      store
    )
    const finalRecord = await store.getChallengeRecord(
      observed.observation.observationID
    )
    const replayed = await runner.replayStoredChallengeRecords(store)

    expect(observed.observation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
    )
    expect(resolvedObservationID.toString()).to.equal(
      observed.observation.observationID.toString()
    )
    expect(cycle.bridgeLifecycle.records).to.have.lengthOf(1)
    expect(cycle.bridgeLifecycle.records[0].record.status).to.equal(
      "defeat-eligible"
    )
    expect(cycle.bridgeLifecycle.failures).to.deep.equal([])
    expect(cycle.summary.byStatus["defeat-eligible"]).to.equal(1)
    expect(finalRecord?.status).to.equal("defeat-eligible")
    expect(finalRecord?.bitcoinTxHash?.toString()).to.equal(bitcoinTxHash)
    expect(finalRecord?.operatorAlertStatus).to.equal("cleared")
    expect(replayed).to.deep.equal([])
    expect(submitter.submissionCount).to.equal(0)
  })

  it("fails honest spend proof resolution for ambiguous or unsafe targets", async () => {
    const flowVectors = vectorCorpus.cases.filter(
      (vector) => vector.flowMetadata !== undefined
    )
    const vector = flowVectors.find(
      (candidate) =>
        candidate.flowMetadata?.spendType ===
        P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )

    if (vector?.flowMetadata === undefined) {
      throw new Error("Missing redemption flow-shaped vector")
    }

    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = authenticatedBitcoinTxHash(rawTransaction)
    const classifier = createP2TRSignatureFraudSpendTypeClassifier([
      {
        spendType: vector.flowMetadata.spendType,
        matches: () => true,
      },
    ])
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = new P2TRSignatureFraudWatchtower(
      store,
      [vector.walletIDHex],
      undefined,
      classifier
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      bitcoinTxHash
    )
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
    )

    const wrongSpendType = await runner.processBridgeLifecycleEventsSettled(
      [
        {
          type: "honest-spend-proven",
          bitcoinTxHash,
          spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
        },
      ],
      store
    )
    const failClosedSpendType =
      await runner.processBridgeLifecycleEventsSettled(
        [
          {
            type: "honest-spend-proven",
            bitcoinTxHash,
            spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
          },
        ],
        store
      )
    const unrelatedProof = await runner.processBridgeLifecycleEventsSettled(
      [
        {
          type: "honest-spend-proven",
          bitcoinTxHash: txHash("f"),
          spendType: vector.flowMetadata.spendType,
        },
      ],
      store
    )

    const duplicateObservationA = {
      ...observed.observation,
      observationID: Hex.from(txHash("b")),
    }
    const duplicateObservationB = {
      ...observed.observation,
      observationID: Hex.from(txHash("c")),
    }
    const duplicateStore = new InMemoryP2TRWatchtowerChallengeStore([
      {
        ...createP2TRWatchtowerChallengeRecord(
          duplicateObservationA.observationID
        ),
        observation: duplicateObservationA,
        bitcoinTxHash: Hex.from(bitcoinTxHash),
      },
      {
        ...createP2TRWatchtowerChallengeRecord(
          duplicateObservationB.observationID
        ),
        observation: duplicateObservationB,
        bitcoinTxHash: Hex.from(bitcoinTxHash),
      },
    ])
    const duplicateRunner = new P2TRSignatureFraudWatchtowerRunner(
      new P2TRSignatureFraudWatchtower(duplicateStore, [vector.walletIDHex]),
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
    )
    const duplicate = await duplicateRunner.processBridgeLifecycleEventsSettled(
      [
        {
          type: "honest-spend-proven",
          bitcoinTxHash,
          spendType: vector.flowMetadata.spendType,
        },
      ],
      duplicateStore
    )

    expect(wrongSpendType.records).to.deep.equal([])
    expect(wrongSpendType.failures).to.have.lengthOf(1)
    expect(wrongSpendType.failures[0].error).to.equal(
      "No watchtower challenge record matches Bitcoin tx hash and spend type"
    )
    expect(failClosedSpendType.records).to.deep.equal([])
    expect(failClosedSpendType.failures).to.have.lengthOf(1)
    expect(failClosedSpendType.failures[0].error).to.equal(
      "P2TR signature-fraud spend type unclassified is fail-closed for challenge submission"
    )
    expect(unrelatedProof.records).to.deep.equal([])
    expect(unrelatedProof.failures).to.deep.equal([])
    expect(unrelatedProof.ignored).to.deep.equal([
      {
        event: {
          type: "honest-spend-proven",
          bitcoinTxHash: txHash("f"),
          spendType: vector.flowMetadata.spendType,
        },
        reason:
          "No matching watchtower challenge record for Bridge proof event",
      },
    ])
    expect(duplicate.records).to.deep.equal([])
    expect(duplicate.failures).to.have.lengthOf(1)
    expect(duplicate.failures[0].error).to.equal(
      "Multiple watchtower challenge records match Bitcoin tx hash and spend type"
    )
  })

  it("rejects Bridge lifecycle events whose evidence does not match the stored observation", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = createDraftApprovedP2TRWatchtower(
      store,
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    await recordSubmittedChallenge(store, observed.observation, txHash("7"))
    const bridgeChallengeKey = observed.observation.bridgeChallengeKey
    if (bridgeChallengeKey === undefined) {
      throw new Error("Expected Bridge challenge key")
    }

    const runner = new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
    )
    const mismatched = await runner.processBridgeLifecycleEventsSettled(
      [
        {
          type: "timeout-eligible",
          bridgeChallengeKey,
          walletID: txHash("f"),
          bridgeChallengeIdentity: observed.observation.bridgeChallengeIdentity,
          sighash: observed.observation.sighash,
        },
      ],
      store
    )

    expect(mismatched.records).to.deep.equal([])
    expect(mismatched.failures).to.have.lengthOf(1)
    expect(mismatched.failures[0].error).to.equal(
      "Bridge lifecycle wallet ID does not match stored observation"
    )
  })

  it("ignores unknown Bridge challenge keys and rejects duplicate records", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      bridgeChallengeDomain
    )
    const bridgeChallengeKey = observation.bridgeChallengeKey
    if (bridgeChallengeKey === undefined) {
      throw new Error("Expected Bridge challenge key")
    }

    const emptyStore = new InMemoryP2TRWatchtowerChallengeStore()
    const emptyRunner = new P2TRSignatureFraudWatchtowerRunner(
      new P2TRSignatureFraudWatchtower(emptyStore, [vector.walletIDHex]),
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
    )
    const unknown = await emptyRunner.processBridgeLifecycleEventsSettled(
      [{ type: "timeout-eligible", bridgeChallengeKey }],
      emptyStore
    )

    const duplicateObservationA = {
      ...observation,
      observationID: Hex.from(txHash("a")),
    }
    const duplicateObservationB = {
      ...observation,
      observationID: Hex.from(txHash("b")),
    }
    const duplicateStore = new InMemoryP2TRWatchtowerChallengeStore([
      {
        ...createP2TRWatchtowerChallengeRecord(
          duplicateObservationA.observationID
        ),
        observation: duplicateObservationA,
      },
      {
        ...createP2TRWatchtowerChallengeRecord(
          duplicateObservationB.observationID
        ),
        observation: duplicateObservationB,
      },
    ])
    const duplicateRunner = new P2TRSignatureFraudWatchtowerRunner(
      new P2TRSignatureFraudWatchtower(duplicateStore, [vector.walletIDHex]),
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
    )
    const duplicate = await duplicateRunner.processBridgeLifecycleEventsSettled(
      [{ type: "timeout-eligible", bridgeChallengeKey }],
      duplicateStore
    )

    expect(unknown.records).to.deep.equal([])
    expect(unknown.failures).to.deep.equal([])
    expect(unknown.ignored).to.deep.equal([
      {
        event: { type: "timeout-eligible", bridgeChallengeKey },
        reason:
          "No matching watchtower challenge record for Bridge proof event",
      },
    ])
    expect(duplicate.records).to.deep.equal([])
    expect(duplicate.failures).to.have.lengthOf(1)
    expect(duplicate.failures[0].error).to.equal(
      "Multiple watchtower challenge records match Bridge challenge key"
    )
  })

  it("reports Bridge lifecycle source failures without changing watchtower state", async () => {
    const store = new InMemoryP2TRWatchtowerChallengeStore([
      createP2TRWatchtowerChallengeRecord(txHash("1")),
    ])
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      new P2TRSignatureFraudWatchtower(store, [txHash("2")]),
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
    )

    const cycle = await runner.processBridgeLifecycleEventSourceSettled(
      {
        listBridgeLifecycleEvents: async () => {
          throw new Error("bridge event source unavailable")
        },
      },
      store
    )

    expect(cycle.bridgeLifecycle.records).to.deep.equal([])
    expect(cycle.bridgeLifecycle.failures).to.deep.equal([])
    expect(cycle.sourceFailures).to.deep.equal([
      {
        source: "bridge-lifecycle",
        error: "bridge event source unavailable",
      },
    ])
    expect(cycle.summary.total).to.equal(1)
    expect(cycle.summary.byStatus.observed).to.equal(1)
  })

  it("processes integrated watchtower source cycles with replay and lifecycle events", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const initialWatchtower = createDraftApprovedP2TRWatchtower(
      store,
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [observed] = await initialWatchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const rejected = await recordRejectedChallenge(
      store,
      observed.observation,
      "rpc timeout"
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("2"))
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(
        store,
        [vector.walletIDHex],
        bridgeChallengeDomain
      ),
      {} as BitcoinClient,
      submitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )
    const bridgeChallengeKey = rejected.observation?.bridgeChallengeKey
    if (bridgeChallengeKey === undefined) {
      throw new Error("Expected Bridge challenge key")
    }

    const cycle = await runner.processWatchtowerSourcesSettled(
      {
        listMempoolTransactions: async () => {
          throw new Error("mempool source unavailable")
        },
        listConfirmedTransactions: async () => ({
          transactions: [],
          complete: true,
        }),
      },
      {
        listBridgeLifecycleEvents: async () => [
          {
            type: "timeout-eligible",
            bridgeChallengeKey,
          },
        ],
      },
      store
    )

    expect(cycle.replayed).to.deep.equal([])
    expect(cycle.mempool.submissions).to.deep.equal([])
    expect(cycle.mempool.failures).to.deep.equal([])
    expect(cycle.confirmed.submissions).to.deep.equal([])
    expect(cycle.bridgeLifecycle.records).to.have.lengthOf(1)
    expect(cycle.bridgeLifecycle.records[0].record.status).to.equal(
      "timeout-eligible"
    )
    expect(cycle.bridgeLifecycle.failures).to.deep.equal([])
    expect(cycle.sourceFailures).to.deep.equal([
      {
        source: "mempool",
        error: "mempool source unavailable",
      },
    ])
    expect(cycle.summary.total).to.equal(1)
    expect(cycle.summary.byStatus["timeout-eligible"]).to.equal(1)
    expect(cycle.summary.byBitcoinStatus.mempool).to.equal(1)
    expect(cycle.unresolvedOperatorAlerts).to.deep.equal([])
    expect(submitter.submissionCount).to.equal(0)
  })

  it("reconciles same-cycle honest-spend evidence before returning observations", async () => {
    const flowVectors = vectorCorpus.cases.filter(
      (vector) => vector.flowMetadata !== undefined
    )
    const vector = flowVectors.find(
      (candidate) =>
        candidate.flowMetadata?.spendType ===
        P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS
    )
    if (vector?.flowMetadata === undefined) {
      throw new Error("Missing moving-funds flow-shaped vector")
    }

    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const classifier = createP2TRSignatureFraudSpendTypeClassifier(
      flowVectors.map((candidate) => ({
        spendType: candidate.flowMetadata!.spendType,
        matches: ({ unsignedTransaction, candidate: witnessCandidate }) =>
          unsignedTransaction.transactionHex ===
            candidate.unsignedTransactionHex &&
          witnessCandidate.inputIndex ===
            candidate.flowMetadata!.sourceWalletInput,
      }))
    )
    const bitcoinClient = {
      getRawTransaction: async (txid: Hex) => {
        const prevout = vector.prevouts.find(
          ({ txidHex }) => txidHex === txid.toString()
        )
        if (prevout === undefined) {
          throw new Error("Unknown test prevout")
        }
        return rawPreviousTransactionForPrevout(prevout)
      },
    } as unknown as BitcoinClient
    const source = {
      listMempoolTransactions: async () => [],
      listConfirmedTransactions: async () => ({
        transactions: [
          {
            rawTransaction,
            bitcoinTxHash,
            bitcoinBlockHash: txHash("b"),
            bitcoinBlockHeight: 144,
          },
        ],
        complete: true,
      }),
    }

    const honestStore = new InMemoryP2TRWatchtowerChallengeStore()
    const honestSubmitter = new FakeP2TRSignatureFraudChallengeSubmitter()
    const honestRunner = new P2TRSignatureFraudWatchtowerRunner(
      new P2TRSignatureFraudWatchtower(
        honestStore,
        [vector.walletIDHex],
        undefined,
        classifier,
        undefined,
        bridgeChallengeDomain
      ),
      bitcoinClient,
      honestSubmitter,
      {
        submitChallenges: false,
        submissionPolicy: {
          allowedSpendTypes: [vector.flowMetadata.spendType],
        },
      }
    )
    const honestCycle = await honestRunner.processWatchtowerSourcesSettled(
      source,
      {
        listBridgeLifecycleEvents: async () => [
          {
            type: "honest-spend-proven" as const,
            bitcoinTxHash,
            spendType: vector.flowMetadata!.spendType,
          },
        ],
      },
      honestStore
    )

    expect(honestSubmitter.submissionCount).to.equal(0)
    expect(honestCycle.bridgeLifecycle.records).to.have.lengthOf(1)
    expect(
      honestCycle.confirmed.submissions[0].submissionRecord.status
    ).to.equal("defeat-eligible")

    const unmatchedStore = new InMemoryP2TRWatchtowerChallengeStore()
    const unmatchedSubmitter = new FakeP2TRSignatureFraudChallengeSubmitter()
    const unmatchedRunner = new P2TRSignatureFraudWatchtowerRunner(
      new P2TRSignatureFraudWatchtower(
        unmatchedStore,
        [vector.walletIDHex],
        undefined,
        classifier,
        undefined,
        bridgeChallengeDomain
      ),
      bitcoinClient,
      unmatchedSubmitter,
      {
        submitChallenges: false,
        submissionPolicy: {
          allowedSpendTypes: [vector.flowMetadata.spendType],
        },
      }
    )
    const unmatchedCycle =
      await unmatchedRunner.processWatchtowerSourcesSettled(
        source,
        { listBridgeLifecycleEvents: async () => [] },
        unmatchedStore
      )

    expect(unmatchedSubmitter.submissionCount).to.equal(0)
    expect(
      unmatchedCycle.confirmed.submissions[0].submissionRecord.status
    ).to.equal("observed")
  })

  it("fails closed on lifecycle-source failure before submitting observed challenges", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter()
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(
        store,
        [vector.walletIDHex],
        bridgeChallengeDomain
      ),
      {
        getRawTransaction: async () =>
          rawPreviousTransactionForPrevout(vector.prevouts[0]),
      } as unknown as BitcoinClient,
      submitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const cycle = await runner.processWatchtowerSourcesSettled(
      {
        listMempoolTransactions: async () => [
          {
            rawTransaction,
            bitcoinTxHash: authenticatedBitcoinTxHash(rawTransaction),
          },
        ],
        listConfirmedTransactions: async () => ({
          transactions: [],
          complete: true,
        }),
      },
      {
        listBridgeLifecycleEvents: async () => {
          throw new Error("lifecycle unavailable")
        },
      },
      store
    )

    expect(submitter.submissionCount).to.equal(0)
    expect(cycle.mempool.submissions[0].submissionRecord.status).to.equal(
      "observed"
    )
    expect(cycle.sourceFailures).to.deep.include({
      source: "bridge-lifecycle",
      error: "lifecycle unavailable",
    })
  })

  it("ignores unregistered wallet spends during watchtower observation", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const watchtower = new P2TRSignatureFraudWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [txHash("e")]
    )

    expect(
      await watchtower.observeMempoolTransaction(
        rawTransaction,
        toObservationPrevouts(vector),
        authenticatedBitcoinTxHash(rawTransaction)
      )
    ).to.deep.equal([])
  })

  it("extracts wallet IDs from P2TR scriptPubKeys", () => {
    vectorCorpus.cases.forEach((vector) => {
      expect(
        extractP2TRWalletIDFromScriptPubKey(
          vector.prevouts[0].scriptPubKeyHex
        )?.toString(),
        vector.id
      ).to.equal(vector.walletIDHex)
    })

    expect(
      extractP2TRWalletIDFromScriptPubKey(
        "00140000000000000000000000000000000000000000"
      )
    ).to.be.undefined
  })

  it("discovers registered P2TR wallet inputs and ignores unknown wallets", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const inputPrevouts = vector.prevouts.map((prevout) => ({
      scriptPubKey: prevout.scriptPubKeyHex,
    }))

    const candidates = extractP2TRWalletInputWitnessCandidates(
      rawTransaction,
      inputPrevouts,
      [vector.walletIDHex]
    )

    expect(candidates.length).to.equal(1)
    expect(candidates[0].inputIndex).to.equal(vector.signedInputIndex)
    expect(candidates[0].walletID.toString()).to.equal(vector.walletIDHex)
    expect(candidates[0].signature.toString()).to.equal(
      vector.bip340SignatureHex
    )

    expect(
      extractP2TRWalletInputWitnessCandidates(rawTransaction, inputPrevouts, [
        "0000000000000000000000000000000000000000000000000000000000000000",
      ])
    ).to.deep.equal([])
  })

  it("binds a revealed deposit output key to its registered wallet and exact outpoint", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const depositOutputKey = "42".repeat(32)
    const inputPrevouts = vector.prevouts.map((prevout, index) => ({
      scriptPubKey:
        index === vector.signedInputIndex
          ? `5120${depositOutputKey}`
          : prevout.scriptPubKeyHex,
    }))
    const signedPrevout = vector.prevouts[vector.signedInputIndex]
    const binding = {
      txid: signedPrevout.txidHex,
      vout: signedPrevout.vout,
      outputKey: depositOutputKey,
      walletID: vector.walletIDHex,
    }

    const candidates = extractP2TRWalletInputWitnessCandidates(
      rawTransaction,
      inputPrevouts,
      [vector.walletIDHex],
      [binding]
    )

    expect(candidates).to.have.length(1)
    expect(candidates[0].walletID.toString()).to.equal(vector.walletIDHex)
    expect(candidates[0].scriptPubKey.toString()).to.equal(
      `5120${depositOutputKey}`
    )

    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector).map((prevout, index) => ({
        ...prevout,
        scriptPubKey:
          index === vector.signedInputIndex
            ? `5120${depositOutputKey}`
            : prevout.scriptPubKey,
      })),
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      bridgeChallengeDomain,
      [binding]
    )
    const expectedIdentity = computeP2TRSignatureFraudBridgeChallengeIdentity({
      ...bridgeChallengeDomain,
      walletID: vector.walletIDHex,
      signingKey: depositOutputKey,
      sighash: observation.sighash,
    })
    expect(observation.bridgeChallengeIdentity.equals(expectedIdentity)).to.be
      .true
    expect(observation.bridgeChallengeKey?.equals(expectedIdentity)).to.be.true
    const encodedEvidence =
      encodeP2TRSignatureFraudBridgeChallengePayload(observation)
    expect(utils.arrayify(encodedEvidence)).to.have.lengthOf(224)
    const [decodedEvidence] = utils.defaultAbiCoder.decode(
      [completeBridgeChallengeEvidenceAbiType],
      encodedEvidence
    )
    expect(decodedEvidence.walletID).to.equal(`0x${vector.walletIDHex}`)
    expect(decodedEvidence.signingKey).to.equal(`0x${depositOutputKey}`)
    expect(decodedEvidence.bindingTxHash).to.equal(`0x${signedPrevout.txidHex}`)
    expect(decodedEvidence.bindingOutputIndex).to.equal(signedPrevout.vout)
    expect(decodedEvidence.sighash).to.equal(
      observation.sighash.toPrefixedString()
    )

    expect(
      extractP2TRWalletInputWitnessCandidates(
        rawTransaction,
        inputPrevouts,
        [vector.walletIDHex],
        [{ ...binding, vout: binding.vout + 1 }]
      )
    ).to.deep.equal([])
    expect(
      extractP2TRWalletInputWitnessCandidates(
        rawTransaction,
        inputPrevouts,
        [vector.walletIDHex],
        [{ ...binding, outputKey: "43".repeat(32) }]
      )
    ).to.deep.equal([])

    expectWitnessError(
      () =>
        extractP2TRWalletInputWitnessCandidates(
          rawTransaction,
          inputPrevouts,
          [vector.walletIDHex, "44".repeat(32)],
          [binding, { ...binding, walletID: "44".repeat(32) }]
        ),
      "invalid-observation-payload"
    )
  })

  it("ignores script-path refunds of exactly bound Taproot deposits", () => {
    const vector = vectorCorpus.cases[0]
    const transaction = Transaction.fromHex(vector.unsignedTransactionHex)
    transaction.ins[vector.signedInputIndex].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
      Buffer.from("51", "hex"),
      Buffer.from(`c0${"00".repeat(32)}`, "hex"),
    ]
    const depositOutputKey = "42".repeat(32)
    const inputPrevouts = vector.prevouts.map((prevout, index) => ({
      scriptPubKey:
        index === vector.signedInputIndex
          ? `5120${depositOutputKey}`
          : prevout.scriptPubKeyHex,
    }))
    const signedPrevout = vector.prevouts[vector.signedInputIndex]

    expect(
      extractP2TRWalletInputWitnessCandidates(
        { transactionHex: transaction.toHex() },
        inputPrevouts,
        [vector.walletIDHex],
        [
          {
            txid: signedPrevout.txidHex,
            vout: signedPrevout.vout,
            outputKey: depositOutputKey,
            walletID: vector.walletIDHex,
          },
        ]
      )
    ).to.deep.equal([])
  })

  it("keeps wallet key-path observations beside a bound deposit refund", () => {
    const vector = vectorCorpus.cases.find(
      (candidate) =>
        candidate.id ===
        "bip341-keypath-sighash-default-multi-input-multi-output"
    )

    if (!vector) {
      throw new Error("Missing multi-input P2TR signature-fraud vector")
    }

    const transaction = Transaction.fromHex(vector.unsignedTransactionHex)
    transaction.ins[0].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
      Buffer.from("51", "hex"),
      Buffer.from(`c0${"00".repeat(32)}`, "hex"),
    ]
    transaction.ins[1].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
    ]
    const depositOutputKey = "42".repeat(32)
    const inputPrevouts = toObservationPrevouts(vector).map(
      (prevout, index) => ({
        ...prevout,
        scriptPubKey:
          index === 0 ? `5120${depositOutputKey}` : prevout.scriptPubKey,
      })
    )
    const depositPrevout = vector.prevouts[0]
    const observations = extractP2TRSignatureFraudWitnessObservations(
      { transactionHex: transaction.toHex() },
      inputPrevouts,
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      undefined,
      [
        {
          txid: depositPrevout.txidHex,
          vout: depositPrevout.vout,
          outputKey: depositOutputKey,
          walletID: vector.walletIDHex,
        },
      ]
    )

    expect(observations.map(({ inputIndex }) => inputIndex)).to.deep.equal([1])
  })

  it("keeps annexed key-path witnesses for bound Taproot deposits", () => {
    const vector = vectorCorpus.cases[0]
    const transaction = Transaction.fromHex(vector.unsignedTransactionHex)
    transaction.ins[vector.signedInputIndex].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
      Buffer.from("50", "hex"),
    ]
    const depositOutputKey = "42".repeat(32)
    const inputPrevouts = vector.prevouts.map((prevout, index) => ({
      scriptPubKey:
        index === vector.signedInputIndex
          ? `5120${depositOutputKey}`
          : prevout.scriptPubKeyHex,
    }))
    const signedPrevout = vector.prevouts[vector.signedInputIndex]

    const candidates = extractP2TRWalletInputWitnessCandidates(
      { transactionHex: transaction.toHex() },
      inputPrevouts,
      [vector.walletIDHex],
      [
        {
          txid: signedPrevout.txidHex,
          vout: signedPrevout.vout,
          outputKey: depositOutputKey,
          walletID: vector.walletIDHex,
        },
      ]
    )

    expect(candidates).to.have.lengthOf(1)
    expect(candidates[0].walletID.toString()).to.equal(vector.walletIDHex)
    expect(candidates[0].annex?.toString()).to.equal("50")
  })

  it("validates deposit-specific observations against their bound wallet", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const depositOutputKey = "42".repeat(32)
    const inputPrevouts = toObservationPrevouts(vector).map(
      (prevout, index) => ({
        ...prevout,
        scriptPubKey:
          index === vector.signedInputIndex
            ? `5120${depositOutputKey}`
            : prevout.scriptPubKey,
      })
    )
    const signedPrevout = vector.prevouts[vector.signedInputIndex]
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      inputPrevouts,
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      undefined,
      [
        {
          txid: signedPrevout.txidHex,
          vout: signedPrevout.vout,
          outputKey: depositOutputKey,
          walletID: vector.walletIDHex,
        },
      ]
    )

    expect(() =>
      validateP2TRSignatureFraudWitnessObservationConsistency(observation)
    ).not.to.throw()
    expectWitnessError(
      () =>
        validateP2TRSignatureFraudWitnessObservationConsistency({
          ...observation,
          walletID: Hex.from("44".repeat(32)),
        }),
      "invalid-watchtower-state"
    )
    expectWitnessError(
      () =>
        validateP2TRSignatureFraudWitnessObservationConsistency({
          ...observation,
          scriptPubKey: Hex.from(`5120${"43".repeat(32)}`),
        }),
      "invalid-watchtower-state"
    )
  })

  it("discovers multiple registered wallet inputs in the same transaction", () => {
    const vector = vectorCorpus.cases.find(
      (candidate) =>
        candidate.id ===
        "bip341-keypath-sighash-default-multi-input-multi-output"
    )

    if (!vector) {
      throw new Error("Missing multi-input P2TR signature-fraud vector")
    }

    const transaction = Transaction.fromHex(vector.unsignedTransactionHex)
    transaction.ins.forEach((input) => {
      input.witness = [Buffer.from(vector.witnessSignatureHex, "hex")]
    })

    const candidates = extractP2TRWalletInputWitnessCandidates(
      { transactionHex: transaction.toHex() },
      vector.prevouts.map((prevout) => ({
        scriptPubKey: prevout.scriptPubKeyHex,
      })),
      [vector.walletIDHex]
    )

    expect(candidates.map((candidate) => candidate.inputIndex)).to.deep.equal([
      0, 1,
    ])
    candidates.forEach((candidate) => {
      expect(candidate.walletID.toString()).to.equal(vector.walletIDHex)
      expect(candidate.signature.toString()).to.equal(vector.bip340SignatureHex)
    })
  })

  it("ignores non-P2TR prevouts before parsing witness data", () => {
    const vector = vectorCorpus.cases[0]

    expect(
      extractP2TRWalletInputWitnessCandidates(
        { transactionHex: vector.unsignedTransactionHex },
        [{ scriptPubKey: "00140000000000000000000000000000000000000000" }],
        [vector.walletIDHex]
      )
    ).to.deep.equal([])
  })

  it("rejects malformed registered wallet witnesses fail-closed", () => {
    const vector = vectorCorpus.cases[0]
    const transaction = Transaction.fromHex(vector.unsignedTransactionHex)
    transaction.ins[vector.signedInputIndex].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
      Buffer.from("51", "hex"),
      Buffer.concat([Buffer.from("c0", "hex"), Buffer.alloc(32)]),
    ]

    expectWitnessError(
      () =>
        extractP2TRWalletInputWitnessCandidates(
          { transactionHex: transaction.toHex() },
          vector.prevouts.map((prevout) => ({
            scriptPubKey: prevout.scriptPubKeyHex,
          })),
          [vector.walletIDHex]
        ),
      "unsupported-witness-form"
    )
  })

  it("rejects incomplete input prevout maps", () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )

    expectWitnessError(
      () =>
        extractP2TRWalletInputWitnessCandidates(
          rawTransaction,
          [],
          [vector.walletIDHex]
        ),
      "invalid-prevout-map"
    )
  })

  it("computes deterministic observation IDs for duplicate watchtower observations", () => {
    const observationIDs = vectorCorpus.cases.map((vector) => {
      const rawTransaction = withInputWitness(
        vector.unsignedTransactionHex,
        vector.signedInputIndex,
        vector.witnessSignatureHex
      )

      const firstObservationID = computeP2TRWalletInputWitnessObservationID({
        rawTransaction,
        inputIndex: vector.signedInputIndex,
        walletID: vector.walletIDHex,
        witnessSignature: vector.witnessSignatureHex,
        inputPrevouts: toObservationPrevouts(vector),
        bridgeIdentifier: "746274632d6272696467652d7365706f6c69612d7630",
      })
      const duplicateObservationID = computeP2TRWalletInputWitnessObservationID(
        {
          rawTransaction,
          inputIndex: vector.signedInputIndex,
          walletID: vector.walletIDHex,
          witnessSignature: vector.witnessSignatureHex,
          inputPrevouts: toObservationPrevouts(vector),
          bridgeIdentifier: "746274632d6272696467652d7365706f6c69612d7630",
        }
      )

      expect(duplicateObservationID.toString(), vector.id).to.equal(
        firstObservationID.toString()
      )

      return firstObservationID.toString()
    })

    expect(new Set(observationIDs).size).to.equal(observationIDs.length)
  })

  it("changes observation IDs when committed watchtower fields change", () => {
    const vector = vectorCorpus.cases.find(
      (candidate) =>
        candidate.id ===
        "bip341-keypath-sighash-default-multi-input-multi-output"
    )

    if (!vector) {
      throw new Error("Missing multi-input P2TR signature-fraud vector")
    }

    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const observation = {
      rawTransaction,
      inputIndex: vector.signedInputIndex,
      walletID: vector.walletIDHex,
      witnessSignature: vector.witnessSignatureHex,
      inputPrevouts: toObservationPrevouts(vector),
      bridgeIdentifier: "746274632d6272696467652d7365706f6c69612d7630",
    }
    const expectedObservationID =
      computeP2TRWalletInputWitnessObservationID(observation).toString()

    const mutations = [
      {
        name: "walletID",
        observation: {
          ...observation,
          walletID:
            "0000000000000000000000000000000000000000000000000000000000000001",
        },
      },
      {
        name: "inputIndex",
        observation: {
          ...observation,
          inputIndex: vector.signedInputIndex - 1,
        },
      },
      {
        name: "rawTransaction",
        observation: {
          ...observation,
          rawTransaction: {
            transactionHex: `${rawTransaction.transactionHex.slice(0, -2)}01`,
          },
        },
      },
      {
        name: "witnessSignature",
        observation: {
          ...observation,
          witnessSignature: `${vector.witnessSignatureHex.slice(0, -2)}00`,
        },
      },
      {
        name: "prevout",
        observation: {
          ...observation,
          inputPrevouts: observation.inputPrevouts.map((prevout, index) =>
            index === vector.signedInputIndex
              ? { ...prevout, valueSats: Number(prevout.valueSats) + 1 }
              : prevout
          ),
        },
      },
      {
        name: "bridgeIdentifier",
        observation: {
          ...observation,
          bridgeIdentifier: "746274632d6272696467652d6d61696e6e65742d7630",
        },
      },
    ]

    mutations.forEach((mutation) => {
      expect(
        computeP2TRWalletInputWitnessObservationID(
          mutation.observation
        ).toString(),
        mutation.name
      ).to.not.equal(expectedObservationID)
    })
  })

  it("deduplicates repeated watchtower observations", () => {
    const observationID = computeP2TRWalletInputWitnessObservationID({
      rawTransaction: {
        transactionHex: vectorCorpus.cases[0].unsignedTransactionHex,
      },
      inputIndex: vectorCorpus.cases[0].signedInputIndex,
      walletID: vectorCorpus.cases[0].walletIDHex,
      witnessSignature: vectorCorpus.cases[0].witnessSignatureHex,
      inputPrevouts: toObservationPrevouts(vectorCorpus.cases[0]),
    })

    const record = createP2TRWatchtowerChallengeRecord(observationID)
    const observedAgain = applyP2TRWatchtowerChallengeEvent(record, {
      type: "observed",
      observationID,
    })

    expect(observedAgain).to.deep.equal(record)
  })

  it("tracks submission retries without changing observation identity", () => {
    const observationID = computeP2TRWalletInputWitnessObservationID({
      rawTransaction: {
        transactionHex: vectorCorpus.cases[0].unsignedTransactionHex,
      },
      inputIndex: vectorCorpus.cases[0].signedInputIndex,
      walletID: vectorCorpus.cases[0].walletIDHex,
      witnessSignature: vectorCorpus.cases[0].witnessSignatureHex,
      inputPrevouts: toObservationPrevouts(vectorCorpus.cases[0]),
    })

    const observed = createP2TRWatchtowerChallengeRecord(observationID)
    const firstAttempt = applyP2TRWatchtowerChallengeEvent(observed, {
      type: "submission-started",
      observationID,
    })
    const rejected = applyP2TRWatchtowerChallengeEvent(firstAttempt, {
      type: "submission-rejected",
      observationID,
      error: "replacement transaction underpriced",
    })
    const secondAttempt = applyP2TRWatchtowerChallengeEvent(rejected, {
      type: "submission-started",
      observationID,
    })
    const submitted = applyP2TRWatchtowerChallengeEvent(secondAttempt, {
      type: "submission-accepted",
      observationID,
      challengeTxHash: txHash("a"),
    })

    expect(submitted.observationID.toString()).to.equal(
      observationID.toString()
    )
    expect(submitted.status).to.equal("submitted")
    expect(submitted.submissionAttempts).to.equal(2)
    expect(submitted.challengeTxHash?.toString()).to.equal(txHash("a"))
    expect(submitted.lastError).to.be.undefined
  })

  it("tracks defeat and prevents later timeout or slashing transitions", () => {
    const observationID = computeP2TRWalletInputWitnessObservationID({
      rawTransaction: {
        transactionHex: vectorCorpus.cases[0].unsignedTransactionHex,
      },
      inputIndex: vectorCorpus.cases[0].signedInputIndex,
      walletID: vectorCorpus.cases[0].walletIDHex,
      witnessSignature: vectorCorpus.cases[0].witnessSignatureHex,
      inputPrevouts: toObservationPrevouts(vectorCorpus.cases[0]),
    })

    const submitted = applyP2TRWatchtowerChallengeEvent(
      applyP2TRWatchtowerChallengeEvent(
        createP2TRWatchtowerChallengeRecord(observationID),
        { type: "submission-started", observationID }
      ),
      {
        type: "submission-accepted",
        observationID,
        challengeTxHash: txHash("b"),
      }
    )
    const defeated = applyP2TRWatchtowerChallengeEvent(submitted, {
      type: "defeated",
      observationID,
      defeatTxHash: txHash("c"),
    })
    const timeoutAfterDefeat = applyP2TRWatchtowerChallengeEvent(defeated, {
      type: "timeout-eligible",
      observationID,
    })
    const slashAfterDefeat = applyP2TRWatchtowerChallengeEvent(defeated, {
      type: "slashed",
      observationID,
      slashingTxHash: txHash("d"),
    })

    expect(defeated.status).to.equal("defeated")
    expect(defeated.defeatTxHash?.toString()).to.equal(txHash("c"))
    expect(timeoutAfterDefeat).to.deep.equal(defeated)
    expect(slashAfterDefeat).to.deep.equal(defeated)
  })

  it("tracks timeout, slashing, and reward lifecycle", () => {
    const observationID = computeP2TRWalletInputWitnessObservationID({
      rawTransaction: {
        transactionHex: vectorCorpus.cases[0].unsignedTransactionHex,
      },
      inputIndex: vectorCorpus.cases[0].signedInputIndex,
      walletID: vectorCorpus.cases[0].walletIDHex,
      witnessSignature: vectorCorpus.cases[0].witnessSignatureHex,
      inputPrevouts: toObservationPrevouts(vectorCorpus.cases[0]),
    })

    const submitted = applyP2TRWatchtowerChallengeEvent(
      applyP2TRWatchtowerChallengeEvent(
        createP2TRWatchtowerChallengeRecord(observationID),
        { type: "submission-started", observationID }
      ),
      {
        type: "submission-accepted",
        observationID,
        challengeTxHash: txHash("e"),
      }
    )
    const timeoutEligible = applyP2TRWatchtowerChallengeEvent(submitted, {
      type: "timeout-eligible",
      observationID,
    })
    const submissionAfterTimeout = applyP2TRWatchtowerChallengeEvent(
      timeoutEligible,
      {
        type: "submission-started",
        observationID,
      }
    )
    const broadcastAfterTimeout = applyP2TRWatchtowerChallengeEvent(
      timeoutEligible,
      {
        type: "submission-broadcast",
        observationID,
        challengeTxHash: txHash("3"),
      }
    )
    const alertRaised = applyP2TRWatchtowerChallengeEvent(timeoutEligible, {
      type: "operator-alert-raised",
      observationID,
      code: "submission-retry-limit",
      message: "manual intervention required",
    })
    const slashed = applyP2TRWatchtowerChallengeEvent(alertRaised, {
      type: "slashed",
      observationID,
      slashingTxHash: txHash("f"),
    })
    const timeoutAfterSlash = applyP2TRWatchtowerChallengeEvent(slashed, {
      type: "timeout-eligible",
      observationID,
    })
    const defeatAfterSlash = applyP2TRWatchtowerChallengeEvent(slashed, {
      type: "defeated",
      observationID,
      defeatTxHash: txHash("2"),
    })
    const rewarded = applyP2TRWatchtowerChallengeEvent(slashed, {
      type: "rewarded",
      observationID,
      rewardTxHash: txHash("1"),
    })

    expect(timeoutEligible.status).to.equal("timeout-eligible")
    expect(timeoutEligible.operatorAlertStatus).to.be.undefined
    expect(submissionAfterTimeout).to.deep.equal(timeoutEligible)
    expect(broadcastAfterTimeout).to.deep.equal(timeoutEligible)
    expect(alertRaised.operatorAlertStatus).to.equal("open")
    expect(slashed.status).to.equal("slashed")
    expect(slashed.operatorAlertStatus).to.equal("cleared")
    expect(slashed.slashingTxHash?.toString()).to.equal(txHash("f"))
    expect(timeoutAfterSlash).to.deep.equal(slashed)
    expect(defeatAfterSlash).to.deep.equal(slashed)
    expect(rewarded.status).to.equal("rewarded")
    expect(rewarded.operatorAlertStatus).to.equal("cleared")
    expect(rewarded.rewardTxHash?.toString()).to.equal(txHash("1"))
  })

  it("tracks mempool, confirmation, eviction, and reorg without forking state", () => {
    const observationID = computeP2TRWalletInputWitnessObservationID({
      rawTransaction: {
        transactionHex: vectorCorpus.cases[0].unsignedTransactionHex,
      },
      inputIndex: vectorCorpus.cases[0].signedInputIndex,
      walletID: vectorCorpus.cases[0].walletIDHex,
      witnessSignature: vectorCorpus.cases[0].witnessSignatureHex,
      inputPrevouts: toObservationPrevouts(vectorCorpus.cases[0]),
    })

    const observed = createP2TRWatchtowerChallengeRecord(observationID)
    const mempool = applyP2TRWatchtowerChallengeEvent(observed, {
      type: "mempool-observed",
      observationID,
      bitcoinTxHash: txHash("4"),
    })
    const confirmed = applyP2TRWatchtowerChallengeEvent(mempool, {
      type: "bitcoin-confirmed",
      observationID,
      bitcoinTxHash: txHash("4"),
      bitcoinBlockHash: txHash("5"),
      bitcoinBlockHeight: 123,
    })
    const reorged = applyP2TRWatchtowerChallengeEvent(confirmed, {
      type: "bitcoin-reorged",
      observationID,
    })
    const evicted = applyP2TRWatchtowerChallengeEvent(reorged, {
      type: "mempool-evicted",
      observationID,
    })

    expect(mempool.bitcoinStatus).to.equal("mempool")
    expect(mempool.bitcoinTxHash?.toString()).to.equal(txHash("4"))
    expect(confirmed.bitcoinStatus).to.equal("confirmed")
    expect(confirmed.bitcoinBlockHash?.toString()).to.equal(txHash("5"))
    expect(confirmed.bitcoinBlockHeight).to.equal(123)
    expect(reorged.bitcoinStatus).to.equal("reorged")
    expect(reorged.bitcoinTxHash?.toString()).to.equal(txHash("4"))
    expect(reorged.bitcoinBlockHash).to.be.undefined
    expect(evicted.bitcoinStatus).to.equal("evicted")
    expect(evicted.observationID.toString()).to.equal(observationID.toString())
    expect(evicted.status).to.equal("observed")
  })

  it("rejects invalid Bitcoin confirmation heights", () => {
    const observationID = computeP2TRWalletInputWitnessObservationID({
      rawTransaction: {
        transactionHex: vectorCorpus.cases[0].unsignedTransactionHex,
      },
      inputIndex: vectorCorpus.cases[0].signedInputIndex,
      walletID: vectorCorpus.cases[0].walletIDHex,
      witnessSignature: vectorCorpus.cases[0].witnessSignatureHex,
      inputPrevouts: toObservationPrevouts(vectorCorpus.cases[0]),
    })
    const record = createP2TRWatchtowerChallengeRecord(observationID)

    expectWitnessError(
      () =>
        applyP2TRWatchtowerChallengeEvent(record, {
          type: "bitcoin-confirmed",
          observationID,
          bitcoinTxHash: txHash("6"),
          bitcoinBlockHash: txHash("7"),
          bitcoinBlockHeight: -1,
        }),
      "invalid-watchtower-state"
    )
  })

  it("persists watchtower events through the store boundary", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex]
    )
    const observationID = observation.observationID

    const store = new InMemoryP2TRWatchtowerChallengeStore()
    await recordP2TRWatchtowerChallengeEvent(store, {
      type: "mempool-observed",
      observationID,
      observation,
      bitcoinTxHash,
    })
    const submitting = await recordP2TRWatchtowerChallengeEvent(store, {
      type: "submission-started",
      observationID,
    })

    const restartedStore = new InMemoryP2TRWatchtowerChallengeStore([
      deserializeP2TRWatchtowerChallengeRecord(
        serializeP2TRWatchtowerChallengeRecord(submitting)
      ),
    ])
    const confirmed = await recordP2TRWatchtowerChallengeEvent(restartedStore, {
      type: "bitcoin-confirmed",
      observationID,
      bitcoinTxHash,
      bitcoinBlockHash: txHash("9"),
      bitcoinBlockHeight: 456,
    })
    const duplicate = await recordP2TRWatchtowerChallengeEvent(restartedStore, {
      type: "observed",
      observationID,
    })

    expect(confirmed.status).to.equal("submitting")
    expect(confirmed.submissionAttempts).to.equal(1)
    expect(confirmed.bitcoinStatus).to.equal("confirmed")
    expect(confirmed.bitcoinBlockHeight).to.equal(456)
    expect(confirmed.observationID.toString()).to.equal(
      observationID.toString()
    )
    expect(confirmed.observation?.draftChallengeIdentity.toString()).to.equal(
      vector.expectedDraftChallengeIdentityHex
    )
    expect(confirmed.observation?.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED
    )
    expect(confirmed.observation?.unsignedTransaction.transactionHex).to.equal(
      vector.unsignedTransactionHex
    )
    expect(duplicate).to.deep.equal(confirmed)
  })

  it("rejects out-of-order submission outcomes and keeps submitted records closed", () => {
    const observationID = txHash("c")
    const observed = createP2TRWatchtowerChallengeRecord(observationID)

    expectWitnessError(
      () =>
        applyP2TRWatchtowerChallengeEvent(observed, {
          type: "submission-accepted",
          observationID,
          challengeTxHash: txHash("d"),
        }),
      "invalid-watchtower-state"
    )
    expectWitnessError(
      () =>
        applyP2TRWatchtowerChallengeEvent(observed, {
          type: "submission-rejected",
          observationID,
          error: "rpc timeout",
        }),
      "invalid-watchtower-state"
    )

    const submitting = applyP2TRWatchtowerChallengeEvent(observed, {
      type: "submission-started",
      observationID,
    })
    const submitted = applyP2TRWatchtowerChallengeEvent(submitting, {
      type: "submission-accepted",
      observationID,
      challengeTxHash: txHash("e"),
    })

    expect(
      applyP2TRWatchtowerChallengeEvent(submitted, {
        type: "submission-started",
        observationID,
      })
    ).to.deep.equal(submitted)
    expect(
      applyP2TRWatchtowerChallengeEvent(submitted, {
        type: "submission-rejected",
        observationID,
        error: "late failure",
      })
    ).to.deep.equal(submitted)
  })

  it("persists watchtower records through a serialized challenge store", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const persistence = new InMemoryP2TRWatchtowerChallengeRecordPersistence()
    const store = new P2TRWatchtowerSerializedChallengeStore(persistence)
    const watchtower = createDraftApprovedP2TRWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      authenticatedBitcoinTxHash(rawTransaction)
    )
    const rejected = await recordRejectedChallenge(
      store,
      observed.observation,
      "rpc timeout"
    )
    const restartedStore = new P2TRWatchtowerSerializedChallengeStore(
      persistence
    )
    const restored = await restartedStore.getChallengeRecord(
      rejected.observationID
    )

    if (!restored?.observation) {
      throw new Error("Expected restored watchtower observation")
    }

    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("b"))
    const [replayed] = await new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(restartedStore, [vector.walletIDHex]),
      {} as BitcoinClient,
      submitter,
      {
        submitChallenges: false,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    ).replayStoredChallengeRecords(restartedStore)

    expect(persistence.records).to.have.lengthOf(1)
    expect(restored.status).to.equal("rejected")
    expect(restored.observation.observationID.toString()).to.equal(
      rejected.observationID.toString()
    )
    expect(replayed.submissionRecord.status).to.equal("rejected")
    expect(replayed.submissionRecord.submissionAttempts).to.equal(1)
    expect(replayed.submissionRecord.challengeTxHash).to.equal(undefined)
    expect(submitter.submissionCount).to.equal(0)
  })

  it("rejects store events before a wallet observation exists", async () => {
    const store = new InMemoryP2TRWatchtowerChallengeStore()

    await expectWitnessRejection(
      () =>
        recordP2TRWatchtowerChallengeEvent(store, {
          type: "submission-started",
          observationID: txHash("a"),
        }),
      "invalid-watchtower-state"
    )
  })

  it("rejects malformed serialized watchtower records", () => {
    expectWitnessError(
      () =>
        deserializeP2TRWatchtowerChallengeRecord({
          observationID: txHash("b"),
          status: "observed",
          submissionAttempts: -1,
        }),
      "invalid-watchtower-state"
    )

    expectWitnessError(
      () =>
        deserializeP2TRWatchtowerChallengeRecord({
          observationID: txHash("b"),
          status: "observed",
          submissionAttempts: 0,
          bitcoinProofAliases: [
            {
              bitcoinTxHash: txHash("c"),
              spendType: undefined as never,
            },
          ],
        }),
      "invalid-watchtower-state"
    )

    expectWitnessError(
      () =>
        deserializeP2TRWatchtowerChallengeRecord({
          observationID: txHash("b"),
          status: "unsupported" as never,
          submissionAttempts: 0,
        }),
      "invalid-watchtower-state"
    )

    expectWitnessError(
      () =>
        deserializeP2TRWatchtowerChallengeRecord({
          observationID: txHash("b"),
          status: "observed",
          submissionAttempts: 0,
          operatorAlertStatus: "unsupported" as never,
        }),
      "invalid-watchtower-state"
    )

    expectWitnessError(
      () =>
        deserializeP2TRWatchtowerChallengeRecord({
          observationID: txHash("b"),
          status: "observed",
          submissionAttempts: 0,
          bitcoinProofAliases: [
            {
              bitcoinTxHash: txHash("c"),
              spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
            },
            {
              bitcoinTxHash: txHash("c"),
              spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
            },
          ],
        }),
      "invalid-watchtower-state"
    )

    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      rawTransaction,
      toObservationPrevouts(vector),
      [vector.walletIDHex]
    )

    expectWitnessError(
      () =>
        deserializeP2TRWatchtowerChallengeRecord({
          observationID: txHash("b"),
          observation:
            serializeP2TRSignatureFraudWitnessObservation(observation),
          status: "observed",
          submissionAttempts: 0,
        }),
      "invalid-watchtower-state"
    )
  })

  it("rejects duplicate serialized watchtower store records", async () => {
    const record = serializeP2TRWatchtowerChallengeRecord(
      createP2TRWatchtowerChallengeRecord(txHash("c"))
    )
    const store = new P2TRWatchtowerSerializedChallengeStore(
      new InMemoryP2TRWatchtowerChallengeRecordPersistence([record, record])
    )

    await expectWitnessRejection(
      () => store.listChallengeRecords(),
      "invalid-watchtower-state"
    )
  })

  it("does not advance serialized store memory after failed durable writes", async () => {
    const existingRecord = createP2TRWatchtowerChallengeRecord(txHash("d"))
    const persistence = new FailingP2TRWatchtowerChallengeRecordPersistence([
      serializeP2TRWatchtowerChallengeRecord(existingRecord),
    ])
    const store = new P2TRWatchtowerSerializedChallengeStore(persistence)

    expect(await store.listChallengeRecords()).to.have.lengthOf(1)
    persistence.rejectSaves = true

    let durableWriteRejected = false
    try {
      await recordP2TRWatchtowerChallengeEvent(store, {
        type: "observed",
        observationID: txHash("e"),
      })
    } catch (error) {
      expect((error as Error).message).to.equal("durable write rejected")
      durableWriteRejected = true
    }

    expect(durableWriteRejected).to.equal(true)

    const records = await store.listChallengeRecords()

    expect(records).to.have.lengthOf(1)
    expect(records[0].observationID.toString()).to.equal(
      existingRecord.observationID.toString()
    )
    expect(persistence.records).to.have.lengthOf(1)
  })

  it("serializes concurrent durable store saves without dropping records", async () => {
    const persistence = new BlockingP2TRWatchtowerChallengeRecordPersistence()
    const store = new P2TRWatchtowerSerializedChallengeStore(persistence)

    const firstSave = recordP2TRWatchtowerChallengeEvent(store, {
      type: "observed",
      observationID: txHash("d"),
    })
    await persistence.firstSaveStarted

    const secondSave = recordP2TRWatchtowerChallengeEvent(store, {
      type: "observed",
      observationID: txHash("e"),
    })

    expect(persistence.saveCalls).to.equal(1)
    persistence.unblockFirstSave()

    await Promise.all([firstSave, secondSave])

    const records = await store.listChallengeRecords()
    const observationIDs = records.map((record) =>
      record.observationID.toString()
    )

    expect(persistence.saveCalls).to.equal(2)
    expect(records).to.have.lengthOf(2)
    expect(observationIDs).to.deep.equal([txHash("d"), txHash("e")])
    expect(persistence.records).to.have.lengthOf(2)
  })

  it("rejects watchtower events for different observation IDs", () => {
    const record = createP2TRWatchtowerChallengeRecord(txHash("2"))

    expectWitnessError(
      () =>
        applyP2TRWatchtowerChallengeEvent(record, {
          type: "submission-started",
          observationID: txHash("3"),
        }),
      "invalid-watchtower-state"
    )
  })

  it("uses only the frozen draft sighash encodings", () => {
    const defaultWitness = vectorCorpus.cases.find(
      (vector) => vector.sighashType === P2TR_SIGHASH_DEFAULT
    )
    const allWitness = vectorCorpus.cases.find(
      (vector) => vector.sighashType === P2TR_SIGHASH_ALL
    )

    expect(defaultWitness, "SIGHASH_DEFAULT vector").to.not.be.undefined
    expect(allWitness, "SIGHASH_ALL vector").to.not.be.undefined
  })
})
