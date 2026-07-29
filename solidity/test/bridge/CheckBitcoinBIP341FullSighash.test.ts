import fs from "fs"
import path from "path"

import { expect } from "chai"
import { BigNumber, Contract } from "ethers"
import { ethers } from "hardhat"

// Full multi-mode BIP-341 key-path sighash coverage.
//
// Every `expectedBip341SighashHex` in the loaded corpus is produced by
// bitcoinjs-lib's `Transaction.prototype.hashForWitnessV1(...)` -- an
// INDEPENDENT BIP-341 reference implementation (see
// typescript/scripts/generate-p2tr-full-sighash-vectors.ts). These tests assert
// the Solidity `computeKeyPathSighash` reproduces those reference values
// exactly; they never compare against a value recomputed from the Solidity or
// the SDK.

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

type FullSighashVector = {
  id: string
  walletIDHex: string
  unsignedTransactionHex: string
  signedInputIndex: number
  sighashType: number
  annexHex: string
  prevouts: PrevoutVector[]
  outputs: OutputVector[]
  expectedBip341SighashHex: string
  bip340SignatureHex: string
  witnessSignatureHex: string
  tamperedBip340SignatureHex: string
  expectedBridgeChallengeIdentityHex: string
}

type FullSighashVectorCorpus = {
  name: string
  cases: FullSighashVector[]
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

const vectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-signature-fraud-full-sighash-v0.json"
)

const hex = (value: string): string =>
  value.startsWith("0x") ? value : `0x${value}`

const loadVectorCorpus = (): FullSighashVectorCorpus =>
  JSON.parse(
    fs.readFileSync(vectorCorpusPath, "utf8")
  ) as FullSighashVectorCorpus

const annexArg = (vector: FullSighashVector): string =>
  vector.annexHex && vector.annexHex.length > 0 ? hex(vector.annexHex) : "0x"

const readCompactSize = (
  buffer: Buffer,
  offset: number
): { value: number; nextOffset: number } => {
  const first = buffer.readUInt8(offset)
  if (first < 0xfd) return { value: first, nextOffset: offset + 1 }
  if (first === 0xfd)
    return { value: buffer.readUInt16LE(offset + 1), nextOffset: offset + 3 }
  if (first === 0xfe)
    return { value: buffer.readUInt32LE(offset + 1), nextOffset: offset + 5 }
  const value = buffer.readBigUInt64LE(offset + 1)
  return { value: Number(value), nextOffset: offset + 9 }
}

const parseUnsignedTransaction = (unsignedTransactionHex: string) => {
  const buffer = Buffer.from(unsignedTransactionHex, "hex")
  let offset = 0

  const version = buffer.readUInt32LE(offset)
  offset += 4

  const inputCount = readCompactSize(buffer, offset)
  offset = inputCount.nextOffset

  const inputs: ParsedTransactionInput[] = Array.from(
    { length: inputCount.value },
    () => {
      const txid = buffer.subarray(offset, offset + 32).toString("hex")
      offset += 32
      const vout = buffer.readUInt32LE(offset)
      offset += 4
      const scriptSigSize = readCompactSize(buffer, offset)
      offset = scriptSigSize.nextOffset + scriptSigSize.value
      const sequence = buffer.readUInt32LE(offset)
      offset += 4
      return { txid, vout, sequence }
    }
  )

  const outputCount = readCompactSize(buffer, offset)
  offset = outputCount.nextOffset

  const outputs: ParsedTransactionOutput[] = Array.from(
    { length: outputCount.value },
    () => {
      const valueSats = buffer.readBigUInt64LE(offset).toString()
      offset += 8
      const scriptPubKeySize = readCompactSize(buffer, offset)
      offset = scriptPubKeySize.nextOffset
      const scriptPubKey = buffer
        .subarray(offset, offset + scriptPubKeySize.value)
        .toString("hex")
      offset += scriptPubKeySize.value
      return { valueSats, scriptPubKey }
    }
  )

  const locktime = buffer.readUInt32LE(offset)
  offset += 4

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

const witnessSignatureHexFor = (
  vector: FullSighashVector,
  signatureHex: string
): string =>
  vector.sighashType === 0
    ? signatureHex
    : `${signatureHex}${vector.sighashType.toString(16).padStart(2, "0")}`

describe("CheckBitcoinBIP341Sighash (full multi-mode coverage)", () => {
  const vectorCorpus = loadVectorCorpus()
  let bip341Harness: Contract
  let p2trHarness: Contract

  before(async () => {
    const TestCheckBitcoinBIP341Sighash = await ethers.getContractFactory(
      "TestCheckBitcoinBIP341Sighash"
    )
    bip341Harness = await TestCheckBitcoinBIP341Sighash.deploy()

    const TestCheckBitcoinP2TRSignatureFraud = await ethers.getContractFactory(
      "TestCheckBitcoinP2TRSignatureFraud"
    )
    p2trHarness = await TestCheckBitcoinP2TRSignatureFraud.deploy()
  })

  it("covers every supported key-path sighash mode plus annex", () => {
    expect(vectorCorpus.name).to.equal("p2tr-signature-fraud-full-sighash-v0")

    const covered = new Set(vectorCorpus.cases.map((v) => v.sighashType))
    // DEFAULT, ALL, NONE, SINGLE and the three ANYONECANPAY variants.
    ;[0, 1, 2, 3, 0x81, 0x82, 0x83].forEach(
      (type) =>
        expect(covered.has(type), `missing sighash type 0x${type.toString(16)}`)
          .to.be.true
    )
    // At least one vector carries a witness annex.
    expect(vectorCorpus.cases.some((v) => v.annexHex.length > 0)).to.be.true
    expect(vectorCorpus.cases.length).to.equal(9)
  })

  it("reconstructs the bitcoinjs hashForWitnessV1 sighash exactly for every vector", async () => {
    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        const tx = parseUnsignedTransaction(vector.unsignedTransactionHex)

        const sighash = await bip341Harness.computeKeyPathSighash(
          tx.version,
          tx.locktime,
          toHarnessInputs(tx.inputs),
          toHarnessPrevouts(vector.prevouts),
          toHarnessOutputs(tx.outputs),
          vector.signedInputIndex,
          vector.sighashType,
          annexArg(vector)
        )

        // Equality against the INDEPENDENT bitcoinjs reference value.
        expect(sighash, vector.id).to.equal(
          hex(vector.expectedBip341SighashHex)
        )
      })
    )
  })

  it("verifies the real key-path signature end-to-end and rejects tampered signatures", async () => {
    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        const tx = parseUnsignedTransaction(vector.unsignedTransactionHex)
        const inputs = toHarnessInputs(tx.inputs)
        const prevouts = toHarnessPrevouts(vector.prevouts)
        const outputs = toHarnessOutputs(tx.outputs)

        expect(
          await p2trHarness.checkKeyPathSignature(
            hex(vector.walletIDHex),
            tx.version,
            tx.locktime,
            inputs,
            prevouts,
            outputs,
            vector.signedInputIndex,
            hex(vector.witnessSignatureHex),
            annexArg(vector)
          ),
          `${vector.id}/valid`
        ).to.be.true

        // One-byte-tampered signature must NOT verify.
        expect(
          await p2trHarness.checkKeyPathSignature(
            hex(vector.walletIDHex),
            tx.version,
            tx.locktime,
            inputs,
            prevouts,
            outputs,
            vector.signedInputIndex,
            hex(
              witnessSignatureHexFor(vector, vector.tamperedBip340SignatureHex)
            ),
            annexArg(vector)
          ),
          `${vector.id}/tampered`
        ).to.be.false

        // Wrong wallet key must NOT verify.
        expect(
          await p2trHarness.checkKeyPathSignature(
            hex("33".repeat(32)),
            tx.version,
            tx.locktime,
            inputs,
            prevouts,
            outputs,
            vector.signedInputIndex,
            hex(vector.witnessSignatureHex),
            annexArg(vector)
          ),
          `${vector.id}/wrong-wallet`
        ).to.be.false
      })
    )
  })

  it("matches the SDK Bridge challenge identity for every vector (SDK<->Solidity parity)", async () => {
    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        const tx = parseUnsignedTransaction(vector.unsignedTransactionHex)

        const identity = await p2trHarness.computeBridgeChallengeIdentity({
          walletID: hex(vector.walletIDHex),
          version: tx.version,
          locktime: tx.locktime,
          inputs: toHarnessInputs(tx.inputs),
          prevouts: toHarnessPrevouts(vector.prevouts),
          outputs: toHarnessOutputs(tx.outputs),
          signedInputIndex: vector.signedInputIndex,
          witnessSignature: hex(vector.witnessSignatureHex),
          annex: annexArg(vector),
        })

        expect(identity, vector.id).to.equal(
          hex(vector.expectedBridgeChallengeIdentityHex)
        )
      })
    )
  })

  it("canonicalizes equivalent SIGHASH_NONE payloads to one challenge identity", async () => {
    const vector = vectorCorpus.cases.find(
      ({ sighashType }) => sighashType === 2
    )!
    const tx = parseUnsignedTransaction(vector.unsignedTransactionHex)
    const payload = {
      walletID: hex(vector.walletIDHex),
      version: tx.version,
      locktime: tx.locktime,
      inputs: toHarnessInputs(tx.inputs),
      prevouts: toHarnessPrevouts(vector.prevouts),
      outputs: toHarnessOutputs(tx.outputs),
      signedInputIndex: vector.signedInputIndex,
      witnessSignature: hex(vector.witnessSignatureHex),
      annex: annexArg(vector),
    }
    const equivalentPayload = {
      ...payload,
      // SIGHASH_NONE does not authenticate outputs. This one-satoshi mutation
      // therefore preserves the signed authorization and must not create a
      // second challenge/reward identity.
      outputs: payload.outputs.map((output, index) =>
        index === 0
          ? { ...output, valueSats: BigNumber.from(output.valueSats).add(1) }
          : output
      ),
    }

    expect(
      await p2trHarness.checkKeyPathSignature(
        equivalentPayload.walletID,
        equivalentPayload.version,
        equivalentPayload.locktime,
        equivalentPayload.inputs,
        equivalentPayload.prevouts,
        equivalentPayload.outputs,
        equivalentPayload.signedInputIndex,
        equivalentPayload.witnessSignature,
        equivalentPayload.annex
      )
    ).to.be.true

    expect(
      await p2trHarness.computeBridgeChallengeIdentity(equivalentPayload)
    ).to.equal(await p2trHarness.computeBridgeChallengeIdentity(payload))
  })

  it("rejects an explicit 0x00 sighash byte on a 65-byte signature", async () => {
    const vector = vectorCorpus.cases.find((v) => v.sighashType === 0)!
    const tx = parseUnsignedTransaction(vector.unsignedTransactionHex)

    await expect(
      p2trHarness.checkKeyPathSignature(
        hex(vector.walletIDHex),
        tx.version,
        tx.locktime,
        toHarnessInputs(tx.inputs),
        toHarnessPrevouts(vector.prevouts),
        toHarnessOutputs(tx.outputs),
        vector.signedInputIndex,
        hex(`${vector.bip340SignatureHex}00`),
        "0x"
      )
    ).to.be.revertedWith("Unsupported witness sighash type")
  })

  it("rejects a malformed sighash byte on a 65-byte signature", async () => {
    const vector = vectorCorpus.cases.find((v) => v.sighashType === 0)!
    const tx = parseUnsignedTransaction(vector.unsignedTransactionHex)

    await expect(
      p2trHarness.checkKeyPathSignature(
        hex(vector.walletIDHex),
        tx.version,
        tx.locktime,
        toHarnessInputs(tx.inputs),
        toHarnessPrevouts(vector.prevouts),
        toHarnessOutputs(tx.outputs),
        vector.signedInputIndex,
        hex(`${vector.bip340SignatureHex}04`),
        "0x"
      )
    ).to.be.revertedWith("Unsupported witness sighash type")
  })

  it("rejects SIGHASH_SINGLE when the signed input has no corresponding output", async () => {
    const vector = vectorCorpus.cases.find((v) => v.sighashType === 3)!
    const tx = parseUnsignedTransaction(vector.unsignedTransactionHex)
    // Truncate the output set so signedInputIndex has no paired output.
    const truncatedOutputs = toHarnessOutputs(tx.outputs).slice(
      0,
      vector.signedInputIndex
    )

    await expect(
      bip341Harness.computeKeyPathSighash(
        tx.version,
        tx.locktime,
        toHarnessInputs(tx.inputs),
        toHarnessPrevouts(vector.prevouts),
        truncatedOutputs,
        vector.signedInputIndex,
        vector.sighashType,
        "0x"
      )
    ).to.be.revertedWith("SIGHASH_SINGLE output missing")
  })

  it("rejects a witness annex missing its 0x50 prefix", async () => {
    const vector = vectorCorpus.cases[0]
    const tx = parseUnsignedTransaction(vector.unsignedTransactionHex)

    await expect(
      p2trHarness.computeBridgeChallengeIdentity({
        walletID: hex(vector.walletIDHex),
        version: tx.version,
        locktime: tx.locktime,
        inputs: toHarnessInputs(tx.inputs),
        prevouts: toHarnessPrevouts(vector.prevouts),
        outputs: toHarnessOutputs(tx.outputs),
        signedInputIndex: vector.signedInputIndex,
        witnessSignature: hex(vector.witnessSignatureHex),
        // 0xc0 is what a script-path control block would start with; it is not
        // a valid annex first byte. The verifier is key-path only and never
        // reinterprets a non-annex second witness item as a script-path leaf,
        // so script-path spends stay structurally out of scope.
        annex: "0xc0",
      })
    ).to.be.revertedWith("Annex must start with 0x50")
  })

  it("binds the annex: changing it changes the Bridge challenge identity", async () => {
    const vector = vectorCorpus.cases.find((v) => v.annexHex.length > 0)!
    const tx = parseUnsignedTransaction(vector.unsignedTransactionHex)
    const base = {
      walletID: hex(vector.walletIDHex),
      version: tx.version,
      locktime: tx.locktime,
      inputs: toHarnessInputs(tx.inputs),
      prevouts: toHarnessPrevouts(vector.prevouts),
      outputs: toHarnessOutputs(tx.outputs),
      signedInputIndex: vector.signedInputIndex,
      witnessSignature: hex(vector.witnessSignatureHex),
    }

    const withAnnex = await p2trHarness.computeBridgeChallengeIdentity({
      ...base,
      annex: annexArg(vector),
    })
    const withDifferentAnnex = await p2trHarness.computeBridgeChallengeIdentity(
      {
        ...base,
        annex: "0x5000",
      }
    )

    expect(withAnnex).to.not.equal(withDifferentAnnex)
  })
})
