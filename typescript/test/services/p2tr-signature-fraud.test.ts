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
  P2TRSignatureFraudBridgeChallengeSubmitter,
  P2TRSignatureFraudChallengeSubmissionPolicy,
  P2TRSignatureFraudSpendType,
  P2TRSignatureFraudSpendTypeClassifier,
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

const vectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-signature-fraud-v0.json"
)

const loadVectorCorpus = (): SignatureFraudVectorCorpus =>
  JSON.parse(
    fs.readFileSync(vectorCorpusPath, "utf8")
  ) as SignatureFraudVectorCorpus

const withInputWitness = (
  unsignedTransactionHex: string,
  inputIndex: number,
  witnessSignatureHex: string
): BitcoinRawTx => {
  const transaction = Transaction.fromHex(unsignedTransactionHex)
  transaction.ins[inputIndex].witness = [
    Buffer.from(witnessSignatureHex, "hex"),
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
  "5b9c84557643f90b47ab9bcc49ff7dba8cfe283f1c37524a1e1db4316b34252f"

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
    walletID: vector.walletIDHex,
    sighash,
    signature: parsedWitness.signature,
    sighashType: parsedWitness.sighashType,
    signedInputIndex: vector.signedInputIndex,
    unsignedTransaction: {
      transactionHex: vector.unsignedTransactionHex,
    },
    inputPrevouts,
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

class FakeP2TRSignatureFraudChallengeSubmitter
  implements P2TRSignatureFraudChallengeSubmitter
{
  submissionCount = 0
  private readonly result: Hex | Buffer | string | Error

  constructor(result: Hex | Buffer | string | Error = txHash("a")) {
    this.result = result
  }

  async submitSignatureFraudChallenge(): Promise<Hex | Buffer | string> {
    this.submissionCount++

    if (this.result instanceof Error) {
      throw this.result
    }

    return this.result
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

  it("rejects missing, annex, and script-path witness forms", () => {
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

    expectWitnessError(
      () =>
        extractP2TRKeyPathInputWitnessSignature(
          { transactionHex: annexTransaction.toHex() },
          vector.signedInputIndex
        ),
      "unsupported-witness-form"
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

  it("computes Bridge challenge identities from structured verifier payloads", () => {
    vectorCorpus.cases.forEach((vector) => {
      const identity = computeBridgeChallengeIdentity(vector)
      const mutatedIdentity = computeP2TRSignatureFraudBridgeChallengeIdentity({
        walletID: vector.walletIDHex,
        sighash: vector.expectedBip341SighashHex,
        signature: vector.bip340SignatureHex,
        sighashType: vector.sighashType as
          | typeof P2TR_SIGHASH_DEFAULT
          | typeof P2TR_SIGHASH_ALL,
        signedInputIndex: vector.signedInputIndex,
        unsignedTransaction: {
          transactionHex: vector.unsignedTransactionHex,
        },
        inputPrevouts: toObservationPrevouts(vector).map((prevout, index) =>
          index === vector.signedInputIndex
            ? {
                ...prevout,
                valueSats: Number(prevout.valueSats) + 1,
              }
            : prevout
        ),
      })

      expect(identity.toBuffer()).to.have.lengthOf(32)
      expect(identity.toString(), vector.id).to.equal(
        vector.expectedBridgeChallengeIdentityHex
      )
      expect(mutatedIdentity.toString(), vector.id).to.not.equal(
        identity.toString()
      )
    })
  })

  it("computes domain-separated Bridge challenge keys from Bridge identities", () => {
    const vector = vectorCorpus.cases[0]
    const bridgeChallengeIdentity = computeBridgeChallengeIdentity(vector)

    const bridgeChallengeKey = computeP2TRSignatureFraudBridgeChallengeKey({
      chainID: 11155111,
      bridgeAddress: "0x1111111111111111111111111111111111111111",
      bridgeChallengeIdentity,
    })

    expect(bridgeChallengeKey.toString()).to.equal(
      expectedVector0BridgeChallengeKey
    )
    expect(
      computeP2TRSignatureFraudBridgeChallengeKey({
        chainID: 1,
        bridgeAddress: "0x1111111111111111111111111111111111111111",
        bridgeChallengeIdentity,
      }).toString()
    ).to.not.equal(bridgeChallengeKey.toString())
    expect(
      computeP2TRSignatureFraudBridgeChallengeKey({
        chainID: 11155111,
        bridgeAddress: "0x2222222222222222222222222222222222222222",
        bridgeChallengeIdentity,
      }).toString()
    ).to.not.equal(bridgeChallengeKey.toString())
    expect(
      computeP2TRSignatureFraudBridgeChallengeKey({
        chainID: 11155111,
        bridgeAddress: "0x1111111111111111111111111111111111111111",
        bridgeChallengeIdentity: txHash("0"),
      }).toString()
    ).to.not.equal(bridgeChallengeKey.toString())
  })

  it("rejects invalid Bridge challenge-key domains", () => {
    expectWitnessError(
      () =>
        computeP2TRSignatureFraudBridgeChallengeKey({
          chainID: 0,
          bridgeAddress: "0x1111111111111111111111111111111111111111",
          bridgeChallengeIdentity: computeBridgeChallengeIdentity(
            vectorCorpus.cases[0]
          ),
        }),
      "invalid-observation-payload"
    )
    expectWitnessError(
      () =>
        computeP2TRSignatureFraudBridgeChallengeKey({
          chainID: 11155111,
          bridgeAddress: constants.AddressZero,
          bridgeChallengeIdentity: computeBridgeChallengeIdentity(
            vectorCorpus.cases[0]
          ),
        }),
      "invalid-observation-payload"
    )
    expectWitnessError(
      () =>
        computeP2TRSignatureFraudBridgeChallengeKey({
          chainID: 11155111,
          bridgeAddress: "not-an-address",
          bridgeChallengeIdentity: computeBridgeChallengeIdentity(
            vectorCorpus.cases[0]
          ),
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

  it("encodes Bridge challenge payloads from watchtower observations", () => {
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
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = new P2TRSignatureFraudWatchtower(store, [
      vector.walletIDHex,
    ])

    const mempoolResults = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      txHash("c")
    )
    const confirmedResults = await watchtower.observeConfirmedTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      txHash("c"),
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
        txHash("1"),
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
          txHash("2")
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
    const store = new InMemoryP2TRWatchtowerChallengeStore()
    const watchtower = new P2TRSignatureFraudWatchtower(store, [
      vector.walletIDHex,
    ])
    const [observed] = await watchtower.observeConfirmedTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      txHash("3"),
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
      txHash("3"),
      txHash("4"),
      791
    )
    const reorged = await watchtower.markConfirmedTransactionReorged(
      original.record.observationID
    )
    const [signatureReplacement] = await watchtower.observeMempoolTransaction(
      signatureReplacementRawTransaction,
      toObservationPrevouts(vector),
      txHash("3")
    )
    const [prevoutReplacement] = await watchtower.observeMempoolTransaction(
      originalRawTransaction,
      prevoutReplacementPrevouts,
      txHash("3")
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

  it("persists accepted challenge submissions through the watchtower", async () => {
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
      txHash("5")
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("6"))
    const submitted = await watchtower.submitChallenge(
      observed.observation,
      submitter,
      draftApprovedSubmissionPolicy
    )
    const duplicate = await watchtower.submitChallenge(
      observed.observation,
      submitter,
      draftApprovedSubmissionPolicy
    )

    expect(submitted.status).to.equal("submitted")
    expect(submitted.submissionAttempts).to.equal(1)
    expect(submitted.challengeTxHash?.toString()).to.equal(txHash("6"))
    expect(duplicate).to.deep.equal(submitted)
    expect(submitter.submissionCount).to.equal(1)
  })

  it("persists rejected challenge submissions through the watchtower", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const watchtower = createDraftApprovedP2TRWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex]
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      txHash("7")
    )
    const rejected = await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(
        new Error("bridge rejected")
      ),
      draftApprovedSubmissionPolicy
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

    const [decodedPayload] = utils.defaultAbiCoder.decode(
      [P2TR_SIGNATURE_FRAUD_BRIDGE_CHALLENGE_PAYLOAD_ABI_TYPE],
      calls[0].payload
    )
    expect(decodedPayload.walletID).to.equal(`0x${vector.walletIDHex}`)
    expect(decodedPayload.annex).to.equal("0x")
    expect(decodedPayload.witnessSignature).to.equal(
      `0x${vector.witnessSignatureHex}`
    )
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
    const watchtower = createDraftApprovedP2TRWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex],
      bridgeChallengeDomain
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      txHash("7")
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

    const rejected = await watchtower.submitChallenge(
      observed.observation,
      submitter,
      draftApprovedSubmissionPolicy
    )
    shouldRevert = false
    const submitted = await watchtower.submitChallenge(
      observed.observation,
      submitter,
      draftApprovedSubmissionPolicy
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
      txHash("b")
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

    const result = await watchtower.submitChallenge(
      observed.observation,
      submitter,
      draftApprovedSubmissionPolicy
    )

    // The acceptance record could not be persisted, but the durable state is the
    // non-replayable "broadcast-pending" status -- never "submitting"/"rejected",
    // which would re-broadcast the already-sent challenge on the next cycle.
    expect(result.status).to.equal("broadcast-pending")
    expect(result.challengeTxHash?.toString()).to.equal(txHash("c"))
    const stored = await backing.listChallengeRecords()
    expect(stored).to.have.length(1)
    expect(stored[0].status).to.equal("broadcast-pending")
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
      txHash("d")
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

    const result = await watchtower.submitChallenge(
      observed.observation,
      submitter,
      draftApprovedSubmissionPolicy
    )

    // Already broadcast: the submitter is never invoked again, so no duplicate
    // on-chain submission, and the record stays broadcast-pending.
    expect(submitCount).to.equal(0)
    expect(result.status).to.equal("broadcast-pending")
    expect(result.challengeTxHash?.toString()).to.equal(txHash("e"))
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

  it("fails closed for unapproved spend types before submission", async () => {
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
      txHash("7")
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("8"))
    const blocked = await watchtower.submitChallenge(
      observed.observation,
      submitter
    )

    expect(observed.observation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED
    )
    expect(blocked.status).to.equal("observed")
    expect(blocked.submissionAttempts).to.equal(0)
    expect(blocked.challengeTxHash).to.equal(undefined)
    expect(blocked.operatorAlertStatus).to.equal("open")
    expect(blocked.operatorAlertCode).to.equal("P2TR-SPEND-TYPE-NOT-APPROVED")
    expect(blocked.operatorAlertMessage).to.contain("unclassified")
    expect(submitter.submissionCount).to.equal(0)
  })

  it("rejects fail-closed spend types in submission policies", async () => {
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
      txHash("7")
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
            { submissionPolicy: { allowedSpendTypes: [spendType] } }
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
      txHash("8")
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

  it("submits classified approved spend types through the watchtower", async () => {
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
      txHash("8")
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("9"))
    const submitted = await watchtower.submitChallenge(
      observed.observation,
      submitter,
      { allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION] }
    )

    expect(observed.observation.spendType).to.equal(
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION
    )
    expect(submitted.status).to.equal("submitted")
    expect(submitted.challengeTxHash?.toString()).to.equal(txHash("9"))
    expect(submitter.submissionCount).to.equal(1)
  })

  it("marks Bridge-observed challenge lifecycle outcomes through the watchtower", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const watchtower = createDraftApprovedP2TRWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex]
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      txHash("8")
    )
    const submitted = await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(txHash("9")),
      draftApprovedSubmissionPolicy
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
    const watchtower = createDraftApprovedP2TRWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex]
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      txHash("c")
    )
    const submitted = await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(txHash("d")),
      draftApprovedSubmissionPolicy
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
    const watchtower = createDraftApprovedP2TRWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex]
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      txHash("8")
    )
    const submitted = await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(txHash("9")),
      draftApprovedSubmissionPolicy
    )
    const timeoutEligible = await watchtower.markChallengeTimeoutEligible(
      submitted.observationID
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("a"))

    const resubmitted = await watchtower.submitChallenge(
      observed.observation,
      submitter,
      draftApprovedSubmissionPolicy
    )

    expect(timeoutEligible.status).to.equal("timeout-eligible")
    expect(resubmitted).to.deep.equal(timeoutEligible)
    expect(submitter.submissionCount).to.equal(0)
  })

  it("does not resubmit slashed challenges awaiting reward", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const watchtower = createDraftApprovedP2TRWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex]
    )
    const [observed] = await watchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      txHash("8")
    )
    const submitted = await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(txHash("9")),
      draftApprovedSubmissionPolicy
    )
    const slashed = await watchtower.markChallengeSlashed(
      submitted.observationID,
      txHash("a")
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("b"))

    const resubmitted = await watchtower.submitChallenge(
      observed.observation,
      submitter,
      draftApprovedSubmissionPolicy
    )
    const rewarded = await watchtower.markChallengeRewarded(
      submitted.observationID,
      txHash("c")
    )

    expect(slashed.status).to.equal("slashed")
    expect(resubmitted).to.deep.equal(slashed)
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
      txHash("1")
    )
    const submitted = await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(txHash("2")),
      draftApprovedSubmissionPolicy
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

  it("processes mempool transactions through the watchtower runner", async () => {
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
        submitChallenges: true,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const processed = await runner.processMempoolTransaction(
      rawTransaction,
      txHash("9")
    )
    const duplicate = await runner.processMempoolTransaction(
      rawTransaction,
      txHash("9")
    )
    const batch = await runner.processMempoolTransactions([
      {
        rawTransaction,
        bitcoinTxHash: txHash("9"),
      },
    ])

    expect(processed).to.have.lengthOf(1)
    expect(batch).to.have.lengthOf(1)
    expect(processed[0].record.bitcoinStatus).to.equal("mempool")
    expect(processed[0].submissionRecord.status).to.equal("submitted")
    expect(processed[0].submissionRecord.challengeTxHash?.toString()).to.equal(
      txHash("8")
    )
    expect(duplicate[0].submissionRecord).to.deep.equal(
      processed[0].submissionRecord
    )
    expect(batch[0].submissionRecord).to.deep.equal(
      processed[0].submissionRecord
    )
    expect(submitter.submissionCount).to.equal(1)
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
      txHash("9")
    )
    const [duplicate] = await runner.processMempoolTransaction(
      rawTransaction,
      txHash("9")
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
    const bitcoinClient = {
      getRawTransaction: async () =>
        rawPreviousTransactionForPrevout(vector.prevouts[0]),
    } as unknown as BitcoinClient
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(
        new InMemoryP2TRWatchtowerChallengeStore(),
        [vector.walletIDHex]
      ),
      bitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter(
        new Error("bridge unavailable")
      ),
      {
        submitChallenges: true,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const processed = await runner.processConfirmedTransaction(
      rawTransaction,
      txHash("a"),
      txHash("b"),
      792
    )
    const batch = await runner.processConfirmedTransactions([
      {
        rawTransaction,
        bitcoinTxHash: txHash("a"),
        bitcoinBlockHash: txHash("b"),
        bitcoinBlockHeight: 792,
      },
    ])

    expect(processed).to.have.lengthOf(1)
    expect(batch).to.have.lengthOf(1)
    expect(processed[0].record.bitcoinStatus).to.equal("confirmed")
    expect(processed[0].record.bitcoinBlockHeight).to.equal(792)
    expect(processed[0].submissionRecord.status).to.equal("rejected")
    expect(processed[0].submissionRecord.lastError).to.equal(
      "bridge unavailable"
    )
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
      await runner.processMempoolTransaction(rawTransaction, txHash("e"))
    ).to.deep.equal([])
    expect(submitter.submissionCount).to.equal(0)
  })

  it("settles batch transaction failures without dropping valid submissions", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
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
        submitChallenges: true,
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
        submitChallenges: true,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const mempoolBatch = await mempoolRunner.processMempoolTransactionsSettled([
      {
        rawTransaction,
        bitcoinTxHash: txHash("2"),
      },
      {
        rawTransaction: malformedRawTransaction,
        bitcoinTxHash: txHash("3"),
      },
    ])
    const confirmedBatch =
      await confirmedRunner.processConfirmedTransactionsSettled([
        {
          rawTransaction,
          bitcoinTxHash: txHash("4"),
          bitcoinBlockHash: txHash("5"),
          bitcoinBlockHeight: 793,
        },
        {
          rawTransaction: malformedRawTransaction,
          bitcoinTxHash: txHash("6"),
          bitcoinBlockHash: txHash("7"),
          bitcoinBlockHeight: 793,
        },
      ])

    expect(mempoolBatch.submissions).to.have.lengthOf(1)
    expect(mempoolBatch.failures).to.have.lengthOf(1)
    expect(mempoolBatch.failures[0].transaction.bitcoinTxHash).to.equal(
      txHash("3")
    )
    expect(mempoolBatch.failures[0].error).to.include(
      "Only Taproot key-path witnesses"
    )
    expect(confirmedBatch.submissions).to.have.lengthOf(1)
    expect(confirmedBatch.failures).to.have.lengthOf(1)
    expect(confirmedBatch.failures[0].transaction.bitcoinTxHash).to.equal(
      txHash("6")
    )
    expect(mempoolSubmitter.submissionCount).to.equal(1)
    expect(confirmedSubmitter.submissionCount).to.equal(1)
  })

  it("replays restored watchtower challenges with persisted observations", async () => {
    const vector = vectorCorpus.cases[0]
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
    const initialWatchtower = createDraftApprovedP2TRWatchtower(
      new InMemoryP2TRWatchtowerChallengeStore(),
      [vector.walletIDHex]
    )
    const [observed] = await initialWatchtower.observeMempoolTransaction(
      rawTransaction,
      toObservationPrevouts(vector),
      txHash("f")
    )
    const rejected = await initialWatchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(new Error("rpc timeout")),
      draftApprovedSubmissionPolicy
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
        submitChallenges: true,
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
    expect(replayed.submissionRecord.status).to.equal("submitted")
    expect(replayed.submissionRecord.submissionAttempts).to.equal(2)
    expect(replayed.submissionRecord.challengeTxHash?.toString()).to.equal(
      txHash("1")
    )
    expect(skipped).to.deep.equal([])
    expect(submitter.submissionCount).to.equal(1)
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
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(store, [vector.walletIDHex]),
      bitcoinClient,
      submitter,
      {
        submitChallenges: true,
        maxSubmissionAttempts: 1,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const [firstAttempt] = await runner.processMempoolTransaction(
      rawTransaction,
      txHash("2")
    )
    const [duplicateObservation] = await runner.processMempoolTransaction(
      rawTransaction,
      txHash("2")
    )
    const [replayed] = await runner.replayStoredChallengeRecords(store)

    expect(firstAttempt.submissionRecord.status).to.equal("rejected")
    expect(firstAttempt.submissionRecord.submissionAttempts).to.equal(1)
    expect(duplicateObservation.submissionRecord.status).to.equal("rejected")
    expect(duplicateObservation.submissionRecord.submissionAttempts).to.equal(1)
    expect(replayed.submissionRecord.status).to.equal("rejected")
    expect(replayed.submissionRecord.submissionAttempts).to.equal(1)
    expect(submitter.submissionCount).to.equal(1)
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
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(store, [vector.walletIDHex]),
      bitcoinClient,
      submitter,
      {
        submitChallenges: true,
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
      txHash("2")
    )
    const [duplicateObservation] = await runner.processMempoolTransaction(
      rawTransaction,
      txHash("2")
    )
    const [replayed] = await runner.replayStoredChallengeRecords(store)

    expect(firstAttempt.submissionRecord.status).to.equal("rejected")
    expect(firstAttempt.submissionRecord.submissionAttempts).to.equal(1)
    expect(firstAttempt.submissionRecord.operatorAlertStatus).to.equal("open")
    expect(firstAttempt.submissionRecord.operatorAlertCode).to.equal(
      "P2TR-SUBMISSION-ATTEMPT-LIMIT"
    )
    expect(firstAttempt.submissionRecord.operatorAlertMessage).to.equal(
      "challenge submission reached its retry limit"
    )
    expect(duplicateObservation.submissionRecord.submissionAttempts).to.equal(1)
    expect(duplicateObservation.submissionRecord.operatorAlertStatus).to.equal(
      "open"
    )
    expect(replayed.submissionRecord.submissionAttempts).to.equal(1)
    expect(replayed.submissionRecord.operatorAlertStatus).to.equal("open")
    expect(submitter.submissionCount).to.equal(1)
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
        submitChallenges: true,
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
            bitcoinTxHash: txHash("1"),
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
      "rejected"
    )
    expect(
      cycle.mempool.submissions[0].submissionRecord.operatorAlertStatus
    ).to.equal("open")
    expect(cycle.confirmed.submissions).to.deep.equal([])
    expect(cycle.confirmed.failures).to.deep.equal([])
    expect(cycle.sourceFailures).to.deep.equal([
      {
        source: "confirmed",
        error: "confirmed source unavailable",
      },
    ])
    expect(cycle.summary.total).to.equal(1)
    expect(cycle.summary.byStatus.rejected).to.equal(1)
    expect(cycle.summary.byBitcoinStatus.mempool).to.equal(1)
    expect(cycle.summary.byOperatorAlertStatus.open).to.equal(1)
    expect(cycle.summary.unresolvedOperatorAlerts).to.equal(1)
    expect(cycle.unresolvedOperatorAlerts).to.have.lengthOf(1)
    expect(cycle.unresolvedOperatorAlerts[0].operatorAlertCode).to.equal(
      "P2TR-SUBMISSION-ATTEMPT-LIMIT"
    )
    expect(submitter.submissionCount).to.equal(1)
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
      txHash("1")
    )
    await initialWatchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(new Error("rpc timeout")),
      draftApprovedSubmissionPolicy
    )
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("2"))
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createDraftApprovedP2TRWatchtower(store, [vector.walletIDHex]),
      {} as BitcoinClient,
      submitter,
      {
        submitChallenges: true,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    )

    const cycle = await runner.processTransactionSourceSettled(
      {
        listMempoolTransactions: async () => [],
        listConfirmedTransactions: async () => [],
      },
      store
    )

    expect(cycle.replayed).to.have.lengthOf(1)
    expect(cycle.replayed[0].record.status).to.equal("rejected")
    expect(cycle.replayed[0].submissionRecord.status).to.equal("submitted")
    expect(cycle.replayed[0].submissionRecord.submissionAttempts).to.equal(2)
    expect(
      cycle.replayed[0].submissionRecord.challengeTxHash?.toString()
    ).to.equal(txHash("2"))
    expect(cycle.mempool.submissions).to.deep.equal([])
    expect(cycle.confirmed.submissions).to.deep.equal([])
    expect(cycle.sourceFailures).to.deep.equal([])
    expect(cycle.summary.total).to.equal(1)
    expect(cycle.summary.byStatus.submitted).to.equal(1)
    expect(submitter.submissionCount).to.equal(1)
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
      txHash("1")
    )
    const submitted = await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(txHash("2")),
      draftApprovedSubmissionPolicy
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
      txHash("6")
    )
    const submitted = await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(txHash("7")),
      draftApprovedSubmissionPolicy
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

    const bitcoinTxHash = txHash("a")
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
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
    await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(txHash("c")),
      { allowedSpendTypes: [vector.flowMetadata.spendType] }
    )
    await watchtower.raiseChallengeOperatorAlert(
      observed.observation.observationID,
      "submission-retry-limit",
      "manual intervention required"
    )
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      watchtower,
      {} as BitcoinClient,
      new FakeP2TRSignatureFraudChallengeSubmitter()
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
    const submitter = new FakeP2TRSignatureFraudChallengeSubmitter(txHash("d"))
    const resubmitted = await watchtower.submitChallenge(
      observed.observation,
      submitter,
      { allowedSpendTypes: [vector.flowMetadata.spendType] }
    )

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
    expect(resubmitted).to.deep.equal(finalRecord)
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

    const bitcoinTxHash = txHash("a")
    const rawTransaction = withInputWitness(
      vector.unsignedTransactionHex,
      vector.signedInputIndex,
      vector.witnessSignatureHex
    )
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
      txHash("6")
    )
    await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(txHash("7")),
      draftApprovedSubmissionPolicy
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

  it("fails Bridge lifecycle challenge-key resolution for unknown or duplicate records", async () => {
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
    expect(unknown.failures).to.have.lengthOf(1)
    expect(unknown.failures[0].error).to.equal(
      "No watchtower challenge record matches Bridge challenge key"
    )
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
      txHash("1")
    )
    const rejected = await initialWatchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(new Error("rpc timeout")),
      draftApprovedSubmissionPolicy
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
        submitChallenges: true,
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
        listConfirmedTransactions: async () => [],
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

    expect(cycle.replayed).to.have.lengthOf(1)
    expect(cycle.replayed[0].record.status).to.equal("rejected")
    expect(cycle.replayed[0].submissionRecord.status).to.equal("submitted")
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
    expect(submitter.submissionCount).to.equal(1)
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
        txHash("f")
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
      Buffer.from("50", "hex"),
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
      bitcoinTxHash: txHash("8"),
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
      bitcoinTxHash: txHash("8"),
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
      txHash("a")
    )
    const rejected = await watchtower.submitChallenge(
      observed.observation,
      new FakeP2TRSignatureFraudChallengeSubmitter(new Error("rpc timeout")),
      draftApprovedSubmissionPolicy
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
        submitChallenges: true,
        submissionPolicy: draftApprovedSubmissionPolicy,
      }
    ).replayStoredChallengeRecords(restartedStore)

    expect(persistence.records).to.have.lengthOf(1)
    expect(restored.status).to.equal("rejected")
    expect(restored.observation.observationID.toString()).to.equal(
      rejected.observationID.toString()
    )
    expect(replayed.submissionRecord.status).to.equal("submitted")
    expect(replayed.submissionRecord.submissionAttempts).to.equal(2)
    expect(replayed.submissionRecord.challengeTxHash?.toString()).to.equal(
      txHash("b")
    )
    expect(submitter.submissionCount).to.equal(1)
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
