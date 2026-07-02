import fs from "fs"
import path from "path"

import { expect } from "chai"
import { BigNumber, Contract } from "ethers"
import { ethers } from "hardhat"

type PrevoutVector = {
  txidHex: string
  vout: number
  valueSats: number | string
  scriptPubKeyHex: string
}

type NegativeVerificationCase = {
  id: string
  walletIDHex?: string
  bip340SignatureHex?: string
  expectedVerify: boolean
}

type NegativeSighashCase = {
  id: string
  unsignedTransactionHex?: string
  prevouts?: PrevoutVector[]
  expectedVerify: boolean
}

type NegativeWitnessVector = {
  id: string
  baseCaseId: string
  witnessSignatureHex: string
  expectedError: "invalid-length" | "unsupported-sighash"
}

type P2TRSignatureFraudVector = {
  id: string
  walletIDHex: string
  unsignedTransactionHex: string
  signedInputIndex: number
  prevouts: PrevoutVector[]
  sighashType: number
  expectedBip341SighashHex: string
  bip340SignatureHex: string
  witnessSignatureHex: string
  expectedBridgeChallengeIdentityHex: string
  expectedVerify: boolean
  negativeVerificationCases: NegativeVerificationCase[]
  negativeSighashCases?: NegativeSighashCase[]
}

type P2TRSignatureFraudVectorCorpus = {
  name: string
  cases: P2TRSignatureFraudVector[]
  negativeWitnessCases: NegativeWitnessVector[]
}

type PayloadBounds = {
  maxInputs: number
  maxOutputs: number
  maxScriptPubKeyBytes: number
}

type ParsedTransactionInput = {
  txid: string
  vout: number
  sequence: number
}

type ParsedTransactionOutput = {
  valueSats: string
  scriptPubKey: string
}

type ParsedTransaction = {
  version: number
  locktime: number
  inputs: ParsedTransactionInput[]
  outputs: ParsedTransactionOutput[]
}

const LOCAL_SEED_GAS_CEILINGS = {
  validatePayloadShape: BigNumber.from("250000"),
  checkKeyPathSignature: BigNumber.from("2800000"),
}

const vectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-signature-fraud-v0.json"
)

const hex = (value: string): string => `0x${value}`

const loadVectorCorpus = (): P2TRSignatureFraudVectorCorpus =>
  JSON.parse(
    fs.readFileSync(vectorCorpusPath, "utf8")
  ) as P2TRSignatureFraudVectorCorpus

const logGasMeasurement = (label: string, actual: BigNumber) => {
  if (process.env.TBTC_REPORT_GAS === "true") {
    console.log(`${label}=${actual}`)
  }
}

const expectGasAtMost = (
  actual: BigNumber,
  ceiling: BigNumber,
  label: string
) => {
  logGasMeasurement(label, actual)
  expect(actual.lte(ceiling), `${label} <= ${ceiling.toString()}`).to.be.true
}

const readCompactSize = (
  buffer: Buffer,
  offset: number
): { value: number; nextOffset: number } => {
  const first = buffer.readUInt8(offset)

  if (first < 0xfd) {
    return { value: first, nextOffset: offset + 1 }
  }

  if (first === 0xfd) {
    return { value: buffer.readUInt16LE(offset + 1), nextOffset: offset + 3 }
  }

  if (first === 0xfe) {
    return { value: buffer.readUInt32LE(offset + 1), nextOffset: offset + 5 }
  }

  const value = buffer.readBigUInt64LE(offset + 1)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("CompactSize value exceeds JavaScript safe integer range")
  }

  return { value: Number(value), nextOffset: offset + 9 }
}

const parseUnsignedTransaction = (
  unsignedTransactionHex: string
): ParsedTransaction => {
  const buffer = Buffer.from(unsignedTransactionHex, "hex")
  let offset = 0

  const version = buffer.readUInt32LE(offset)
  offset += 4

  const inputCount = readCompactSize(buffer, offset)
  offset = inputCount.nextOffset

  const inputs = Array.from({ length: inputCount.value }, () => {
    const txid = buffer.subarray(offset, offset + 32).toString("hex")
    offset += 32

    const vout = buffer.readUInt32LE(offset)
    offset += 4

    const scriptSigSize = readCompactSize(buffer, offset)
    offset = scriptSigSize.nextOffset + scriptSigSize.value

    const sequence = buffer.readUInt32LE(offset)
    offset += 4

    return { txid, vout, sequence }
  })

  const outputCount = readCompactSize(buffer, offset)
  offset = outputCount.nextOffset

  const outputs = Array.from({ length: outputCount.value }, () => {
    const valueSats = buffer.readBigUInt64LE(offset).toString()
    offset += 8

    const scriptPubKeySize = readCompactSize(buffer, offset)
    offset = scriptPubKeySize.nextOffset

    const scriptPubKey = buffer
      .subarray(offset, offset + scriptPubKeySize.value)
      .toString("hex")
    offset += scriptPubKeySize.value

    return { valueSats, scriptPubKey }
  })

  const locktime = buffer.readUInt32LE(offset)
  offset += 4

  if (offset !== buffer.length) {
    throw new Error("Unexpected trailing transaction bytes")
  }

  return { version, locktime, inputs, outputs }
}

const toHarnessInputs = (inputs: ParsedTransactionInput[]) =>
  inputs.map((input) => ({
    txid: hex(input.txid),
    vout: input.vout,
    sequence: input.sequence,
  }))

const toHarnessPrevouts = (prevouts: PrevoutVector[]) =>
  prevouts.map((prevout) => ({
    valueSats: BigNumber.from(prevout.valueSats.toString()),
    scriptPubKey: hex(prevout.scriptPubKeyHex),
  }))

const toHarnessOutputs = (outputs: ParsedTransactionOutput[]) =>
  outputs.map((output) => ({
    valueSats: BigNumber.from(output.valueSats),
    scriptPubKey: hex(output.scriptPubKey),
  }))

const witnessSignatureHex = (
  vector: P2TRSignatureFraudVector,
  signatureHex = vector.bip340SignatureHex
) => (vector.sighashType === 0 ? signatureHex : `${signatureHex}01`)

const vectorPayload = (
  vector: P2TRSignatureFraudVector,
  options: {
    unsignedTransactionHex?: string
    prevouts?: PrevoutVector[]
    witnessSignatureHex?: string
    signedInputIndex?: number
    annexHex?: string
  } = {}
): Promise<string | boolean> => {
  const parsedTransaction = parseUnsignedTransaction(
    options.unsignedTransactionHex ?? vector.unsignedTransactionHex
  )

  return {
    walletID: hex(vector.walletIDHex),
    version: parsedTransaction.version,
    locktime: parsedTransaction.locktime,
    inputs: toHarnessInputs(parsedTransaction.inputs),
    prevouts: toHarnessPrevouts(options.prevouts ?? vector.prevouts),
    outputs: toHarnessOutputs(parsedTransaction.outputs),
    signedInputIndex: options.signedInputIndex ?? vector.signedInputIndex,
    witnessSignature: hex(
      options.witnessSignatureHex ?? vector.witnessSignatureHex
    ),
    annex: options.annexHex ?? "0x",
  }
}

const callWithVector = (
  harness: Contract,
  method: "computeKeyPathSighashForWitness" | "checkKeyPathSignature",
  vector: P2TRSignatureFraudVector,
  options: {
    walletIDHex?: string
    unsignedTransactionHex?: string
    prevouts?: PrevoutVector[]
    witnessSignatureHex?: string
    signedInputIndex?: number
  } = {}
): Promise<string | boolean> => {
  const payload = vectorPayload(vector, options)
  const args = [
    payload.version,
    payload.locktime,
    payload.inputs,
    payload.prevouts,
    payload.outputs,
    payload.signedInputIndex,
    payload.witnessSignature,
    payload.annex,
  ]

  if (method === "computeKeyPathSighashForWitness") {
    return harness.computeKeyPathSighashForWitness(...args)
  }

  return harness.checkKeyPathSignature(
    hex(options.walletIDHex ?? vector.walletIDHex),
    ...args
  )
}

const validateWithVector = (
  harness: Contract,
  vector: P2TRSignatureFraudVector,
  bounds: PayloadBounds,
  options: {
    unsignedTransactionHex?: string
    prevouts?: PrevoutVector[]
    witnessSignatureHex?: string
    signedInputIndex?: number
    annexHex?: string
  } = {}
): Promise<void> => {
  const payload = vectorPayload(vector, options)

  return harness.validatePayloadShape(payload, bounds)
}

const requireMultiInputVector = (
  vectorCorpus: P2TRSignatureFraudVectorCorpus
): P2TRSignatureFraudVector => {
  const vector = vectorCorpus.cases.find(
    (candidate) =>
      candidate.id === "bip341-keypath-sighash-default-multi-input-multi-output"
  )

  if (!vector) {
    throw new Error("Missing multi-input P2TR signature-fraud vector")
  }

  return vector
}

describe("CheckBitcoinP2TRSignatureFraud", () => {
  const vectorCorpus = loadVectorCorpus()
  const vectorBounds: PayloadBounds = {
    maxInputs: 2,
    maxOutputs: 2,
    maxScriptPubKeyBytes: 34,
  }
  const witnessErrorMessages = new Map([
    ["invalid-length", "Invalid witness signature length"],
    ["unsupported-sighash", "Unsupported witness sighash type"],
  ])
  let harness: Contract

  before(async () => {
    const TestCheckBitcoinP2TRSignatureFraud = await ethers.getContractFactory(
      "TestCheckBitcoinP2TRSignatureFraud"
    )
    harness = await TestCheckBitcoinP2TRSignatureFraud.deploy()
  })

  it("computes BIP341 sighashes from Taproot witness encodings", async () => {
    expect(vectorCorpus.name).to.equal("p2tr-signature-fraud-v0")

    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        expect(
          await callWithVector(
            harness,
            "computeKeyPathSighashForWitness",
            vector
          ),
          vector.id
        ).to.equal(hex(vector.expectedBip341SighashHex))
      })
    )
  })

  it("verifies valid key-path P2TR signature-fraud vectors", async () => {
    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        expect(
          await callWithVector(harness, "checkKeyPathSignature", vector),
          vector.id
        ).to.equal(vector.expectedVerify)
      })
    )
  })

  it("computes Bridge challenge identities from structured verifier payloads", async () => {
    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        const payload = vectorPayload(vector)

        expect(
          await harness.computeBridgeChallengeIdentity({
            walletID: hex(vector.walletIDHex),
            version: payload.version,
            locktime: payload.locktime,
            inputs: payload.inputs,
            prevouts: payload.prevouts,
            outputs: payload.outputs,
            signedInputIndex: payload.signedInputIndex,
            witnessSignature: payload.witnessSignature,
            annex: payload.annex,
          }),
          vector.id
        ).to.equal(hex(vector.expectedBridgeChallengeIdentityHex))
      })
    )
  })

  it("rejects Bridge challenge identities with a malformed annex", async () => {
    const vector = vectorCorpus.cases[0]
    // A non-empty annex must carry the mandatory 0x50 prefix; a leading byte
    // other than 0x50 is not a valid annex.
    const payload = vectorPayload(vector, { annexHex: "0x00" })

    await expect(
      harness.computeBridgeChallengeIdentity({
        walletID: hex(vector.walletIDHex),
        version: payload.version,
        locktime: payload.locktime,
        inputs: payload.inputs,
        prevouts: payload.prevouts,
        outputs: payload.outputs,
        signedInputIndex: payload.signedInputIndex,
        witnessSignature: payload.witnessSignature,
        annex: payload.annex,
      })
    ).to.be.revertedWith("Annex must start with 0x50")
  })

  it("returns false for wallet, signature, and sighash-data mutations", async () => {
    const verificationMutations = vectorCorpus.cases.flatMap((vector) =>
      vector.negativeVerificationCases
        .filter(
          (negative) => negative.walletIDHex || negative.bip340SignatureHex
        )
        .map((negative) => ({ vector, negative }))
    )

    await Promise.all(
      verificationMutations.map(async ({ vector, negative }) => {
        expect(negative.expectedVerify, negative.id).to.be.false

        expect(
          await callWithVector(harness, "checkKeyPathSignature", vector, {
            walletIDHex: negative.walletIDHex,
            witnessSignatureHex: witnessSignatureHex(
              vector,
              negative.bip340SignatureHex
            ),
          }),
          `${vector.id}/${negative.id}`
        ).to.be.false
      })
    )

    const sighashMutations = vectorCorpus.cases.flatMap((vector) =>
      (vector.negativeSighashCases ?? []).map((negative) => ({
        vector,
        negative,
      }))
    )

    await Promise.all(
      sighashMutations.map(async ({ vector, negative }) => {
        expect(negative.expectedVerify, negative.id).to.be.false

        expect(
          await callWithVector(harness, "checkKeyPathSignature", vector, {
            unsignedTransactionHex: negative.unsignedTransactionHex,
            prevouts: negative.prevouts,
          }),
          `${vector.id}/${negative.id}`
        ).to.be.false
      })
    )
  })

  it("rejects unsupported witness and malformed transaction payload shapes", async () => {
    await Promise.all(
      vectorCorpus.negativeWitnessCases.map(async (negative) => {
        const vector = vectorCorpus.cases.find(
          (candidate) => candidate.id === negative.baseCaseId
        )

        if (!vector) {
          throw new Error(`Missing P2TR signature-fraud vector ${negative.id}`)
        }

        const expectedError = witnessErrorMessages.get(negative.expectedError)

        if (!expectedError) {
          throw new Error(
            `Unknown witness parser error ${negative.expectedError}`
          )
        }

        await expect(
          callWithVector(harness, "checkKeyPathSignature", vector, {
            witnessSignatureHex: negative.witnessSignatureHex,
          }),
          negative.id
        ).to.be.revertedWith(expectedError)
      })
    )

    const vector = vectorCorpus.cases[0]
    await expect(
      callWithVector(harness, "checkKeyPathSignature", vector, {
        signedInputIndex: vector.prevouts.length,
      })
    ).to.be.revertedWith("Signed input out of range")

    await expect(
      callWithVector(harness, "checkKeyPathSignature", vector, {
        prevouts: [],
      })
    ).to.be.revertedWith("Prevout count mismatch")

    await expect(
      validateWithVector(harness, vector, vectorBounds, {
        annexHex: "0x00",
      })
    ).to.be.revertedWith("Annex must start with 0x50")
  })

  // The witness-encoding boundary must fail closed for every sighash byte other
  // than the two in scope (implicit DEFAULT / explicit ALL). A 65-byte witness
  // carrying NONE/SINGLE/ANYONECANPAY (or a non-canonical explicit 0x00) is
  // rejected at parse time -- before any sighash reconstruction or signature
  // verification -- so such a spend can never be adjudicated by this path.
  it("fails closed for every unsupported Taproot witness sighash byte", async () => {
    const vector = vectorCorpus.cases[0] // SIGHASH_DEFAULT: 64-byte witness
    const baseSignatureHex = vector.witnessSignatureHex

    const unsupportedTrailingBytes = [
      "00", // explicit, non-canonical SIGHASH_DEFAULT
      "02", // SIGHASH_NONE
      "03", // SIGHASH_SINGLE
      "80", // bare ANYONECANPAY bit
      "81", // SIGHASH_ALL | ANYONECANPAY
      "82", // SIGHASH_NONE | ANYONECANPAY
      "83", // SIGHASH_SINGLE | ANYONECANPAY
      "ff",
    ]

    // eslint-disable-next-line no-restricted-syntax
    for (const trailing of unsupportedTrailingBytes) {
      const unsupportedWitnessSignatureHex = `${baseSignatureHex}${trailing}`

      // eslint-disable-next-line no-await-in-loop
      await expect(
        callWithVector(harness, "computeKeyPathSighashForWitness", vector, {
          witnessSignatureHex: unsupportedWitnessSignatureHex,
        }),
        `computeKeyPathSighashForWitness trailing=0x${trailing}`
      ).to.be.revertedWith("Unsupported witness sighash type")

      // eslint-disable-next-line no-await-in-loop
      await expect(
        callWithVector(harness, "checkKeyPathSignature", vector, {
          witnessSignatureHex: unsupportedWitnessSignatureHex,
        }),
        `checkKeyPathSignature trailing=0x${trailing}`
      ).to.be.revertedWith("Unsupported witness sighash type")
    }

    // The only accepted 65-byte form (explicit SIGHASH_ALL) is not rejected.
    await expect(
      callWithVector(harness, "computeKeyPathSighashForWitness", vector, {
        witnessSignatureHex: `${baseSignatureHex}01`,
      })
    ).not.to.be.reverted
  })

  it("accepts vector payloads within explicit bounds", async () => {
    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        await expect(
          validateWithVector(harness, vector, vectorBounds),
          vector.id
        ).not.to.be.reverted
      })
    )
  })

  it("rejects payloads outside explicit bounds", async () => {
    const multiInputVector = vectorCorpus.cases.find(
      (candidate) =>
        candidate.id ===
        "bip341-keypath-sighash-default-multi-input-multi-output"
    )

    if (!multiInputVector) {
      throw new Error("Missing multi-input P2TR signature-fraud vector")
    }

    await expect(
      validateWithVector(harness, multiInputVector, {
        ...vectorBounds,
        maxInputs: 1,
      })
    ).to.be.revertedWith("Too many inputs")

    await expect(
      validateWithVector(harness, multiInputVector, {
        ...vectorBounds,
        maxOutputs: 1,
      })
    ).to.be.revertedWith("Too many outputs")

    await expect(
      validateWithVector(harness, multiInputVector, {
        ...vectorBounds,
        maxScriptPubKeyBytes: 33,
      })
    ).to.be.revertedWith("Prevout script too large")

    await expect(
      validateWithVector(
        harness,
        multiInputVector,
        { ...vectorBounds, maxScriptPubKeyBytes: 33 },
        {
          prevouts: multiInputVector.prevouts.map((prevout) => ({
            ...prevout,
            scriptPubKeyHex: "51",
          })),
        }
      )
    ).to.be.revertedWith("Output script too large")

    await expect(
      validateWithVector(harness, multiInputVector, {
        ...vectorBounds,
        maxInputs: 0,
      })
    ).to.be.revertedWith("Input bound must be positive")

    const payload = vectorPayload(multiInputVector)
    await expect(
      harness.validatePayloadShape(
        {
          ...payload,
          inputs: [],
          prevouts: [],
        },
        vectorBounds
      )
    ).to.be.revertedWith("No inputs")

    await expect(
      harness.validatePayloadShape(
        {
          ...payload,
          outputs: [],
        },
        vectorBounds
      )
    ).to.be.revertedWith("No outputs")

    await expect(
      validateWithVector(harness, multiInputVector, vectorBounds, {
        annexHex: "0x00",
      })
    ).to.be.revertedWith("Annex must start with 0x50")
  })

  it("reports the current bounded payload-shape gas envelope", async () => {
    const vector = requireMultiInputVector(vectorCorpus)
    const payload = vectorPayload(vector)
    const validationGas = await harness.estimateGas.validatePayloadShape(
      payload,
      vectorBounds
    )

    expectGasAtMost(
      validationGas,
      LOCAL_SEED_GAS_CEILINGS.validatePayloadShape,
      "p2tr_validatePayloadShape_boundedGas"
    )
  })

  it("reports the current bounded key-path verifier gas envelope", async () => {
    const vector = requireMultiInputVector(vectorCorpus)
    const payload = vectorPayload(vector)
    const verificationGas = await harness.estimateGas.checkKeyPathSignature(
      hex(vector.walletIDHex),
      payload.version,
      payload.locktime,
      payload.inputs,
      payload.prevouts,
      payload.outputs,
      payload.signedInputIndex,
      payload.witnessSignature,
      payload.annex
    )

    expectGasAtMost(
      verificationGas,
      LOCAL_SEED_GAS_CEILINGS.checkKeyPathSignature,
      "p2tr_checkKeyPathSignature_boundedGas"
    )
  })
})
