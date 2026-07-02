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

type OutputVector = {
  valueSats: number | string
  scriptPubKeyHex: string
}

type NegativeSighashCase = {
  id: string
  unsignedTransactionHex?: string
  prevouts?: PrevoutVector[]
  outputs?: OutputVector[]
  expectedVerify: boolean
}

type BIP341Vector = {
  id: string
  walletIDHex: string
  unsignedTransactionHex: string
  signedInputIndex: number
  prevouts: PrevoutVector[]
  outputs: OutputVector[]
  sighashType: number
  expectedBip341SighashHex: string
  bip340SignatureHex: string
  negativeSighashCases?: NegativeSighashCase[]
}

type BIP341VectorCorpus = {
  name: string
  cases: BIP341Vector[]
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

const vectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-signature-fraud-v0.json"
)

const hex = (value: string): string => `0x${value}`

const loadVectorCorpus = (): BIP341VectorCorpus =>
  JSON.parse(fs.readFileSync(vectorCorpusPath, "utf8")) as BIP341VectorCorpus

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

const computeSighash = (
  harness: Contract,
  vector: BIP341Vector,
  options: {
    unsignedTransactionHex?: string
    prevouts?: PrevoutVector[]
    sighashType?: number
    signedInputIndex?: number
    annexHex?: string
  } = {}
): Promise<string> => {
  const parsedTransaction = parseUnsignedTransaction(
    options.unsignedTransactionHex ?? vector.unsignedTransactionHex
  )

  return harness.computeKeyPathSighash(
    parsedTransaction.version,
    parsedTransaction.locktime,
    toHarnessInputs(parsedTransaction.inputs),
    toHarnessPrevouts(options.prevouts ?? vector.prevouts),
    toHarnessOutputs(parsedTransaction.outputs),
    options.signedInputIndex ?? vector.signedInputIndex,
    options.sighashType ?? vector.sighashType,
    options.annexHex ?? "0x"
  )
}

describe("CheckBitcoinBIP341Sighash", () => {
  const vectorCorpus = loadVectorCorpus()
  let bip341Harness: Contract
  let bip340Harness: Contract

  before(async () => {
    const TestCheckBitcoinBIP341Sighash = await ethers.getContractFactory(
      "TestCheckBitcoinBIP341Sighash"
    )
    bip341Harness = await TestCheckBitcoinBIP341Sighash.deploy()

    const TestCheckBitcoinBIP340Sigs = await ethers.getContractFactory(
      "TestCheckBitcoinBIP340Sigs"
    )
    bip340Harness = await TestCheckBitcoinBIP340Sigs.deploy()
  })

  it("reconstructs BIP341 key-path sighashes from structured vectors", async () => {
    expect(vectorCorpus.name).to.equal("p2tr-signature-fraud-v0")

    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        expect(await computeSighash(bip341Harness, vector), vector.id).to.equal(
          hex(vector.expectedBip341SighashHex)
        )
      })
    )
  })

  it("produces sighashes accepted by the BIP340 verifier seed", async () => {
    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        const reconstructedSighash = await computeSighash(bip341Harness, vector)

        expect(
          await bip340Harness["checkSig(bytes32,bytes32,bytes)"](
            hex(vector.walletIDHex),
            reconstructedSighash,
            hex(vector.bip340SignatureHex)
          ),
          vector.id
        ).to.be.true
      })
    )
  })

  it("changes the sighash for transaction and prevout mutations", async () => {
    const negativeSighashCases = vectorCorpus.cases.flatMap((vector) =>
      (vector.negativeSighashCases ?? []).map((negative) => ({
        vector,
        negative,
      }))
    )

    await Promise.all(
      negativeSighashCases.map(async ({ vector, negative }) => {
        expect(negative.expectedVerify, negative.id).to.be.false

        const reconstructedSighash = await computeSighash(
          bip341Harness,
          vector,
          {
            unsignedTransactionHex: negative.unsignedTransactionHex,
            prevouts: negative.prevouts,
          }
        )

        expect(
          reconstructedSighash,
          `${vector.id}/${negative.id}`
        ).not.to.equal(hex(vector.expectedBip341SighashHex))
      })
    )
  })

  it("rejects unsupported sighash types and malformed payload shape", async () => {
    const vector = vectorCorpus.cases[0]

    // 0x04 sets a bit outside the valid base/ANYONECANPAY mask, so it is not a
    // real key-path sighash type. (NONE/SINGLE and the ANYONECANPAY variants are
    // now supported and exercised by the full-sighash corpus.)
    await expect(
      computeSighash(bip341Harness, vector, { sighashType: 4 })
    ).to.be.revertedWith("Unsupported BIP341 sighash type")

    await expect(
      computeSighash(bip341Harness, vector, {
        signedInputIndex: vector.prevouts.length,
      })
    ).to.be.revertedWith("Signed input out of range")

    await expect(
      computeSighash(bip341Harness, vector, { prevouts: [] })
    ).to.be.revertedWith("Prevout count mismatch")
  })

  // The verifier reconstructs only DEFAULT/ALL key-path semantics, so it must
  // fail closed for every other sighash-type byte rather than compare a
  // signature against a message the signer never committed to (which could
  // otherwise mis-adjudicate a fraud challenge). This is the defense-in-depth
  // boundary guard inside `computeKeyPathSighash`, exercised directly here.
  it("fails closed for every unsupported BIP341 sighash type byte", async () => {
    const vector = vectorCorpus.cases[0]

    const unsupportedSighashTypes = [
      0x02, // SIGHASH_NONE
      0x03, // SIGHASH_SINGLE
      0x80, // bare ANYONECANPAY bit
      0x81, // SIGHASH_ALL | ANYONECANPAY
      0x82, // SIGHASH_NONE | ANYONECANPAY
      0x83, // SIGHASH_SINGLE | ANYONECANPAY
      0x04,
      0xff,
    ]

    // eslint-disable-next-line no-restricted-syntax
    for (const sighashType of unsupportedSighashTypes) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        computeSighash(bip341Harness, vector, { sighashType }),
        `sighashType=0x${sighashType.toString(16)}`
      ).to.be.revertedWith("Unsupported BIP341 sighash type")
    }

    // Both in-scope types still reconstruct without reverting.
    // eslint-disable-next-line no-restricted-syntax
    for (const sighashType of [0, 1]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        computeSighash(bip341Harness, vector, { sighashType }),
        `sighashType=${sighashType}`
      ).not.to.be.reverted
    }
  })
})
