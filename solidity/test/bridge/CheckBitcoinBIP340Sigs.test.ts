import fs from "fs"
import path from "path"

import { expect } from "chai"
import { createHash } from "crypto"
import { BigNumber, Contract } from "ethers"
import { ethers } from "hardhat"

type NegativeVerificationCase = {
  id: string
  walletIDHex?: string
  bip341SighashHex?: string
  bip340SignatureHex?: string
  expectedVerify: boolean
}

type BIP340Vector = {
  id: string
  walletIDHex: string
  expectedBip341SighashHex: string
  bip340SignatureHex: string
  expectedVerify: boolean
  negativeVerificationCases: NegativeVerificationCase[]
}

type BIP340VectorCorpus = {
  name: string
  cases: BIP340Vector[]
}

const vectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-signature-fraud-v0.json"
)

const secp256k1N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
)
const secp256k1P = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F"
)
const LOCAL_SEED_GAS_CEILINGS = {
  bip340CheckSig: BigNumber.from("2600000"),
  bip340ScalarMulGenerator: {
    zero: BigNumber.from("50000"),
    one: BigNumber.from("50000"),
    highBit: BigNumber.from("800000"),
    dense: BigNumber.from("1600000"),
  },
}

const hex = (value: string): string => `0x${value}`

const loadVectorCorpus = (): BIP340VectorCorpus =>
  JSON.parse(fs.readFileSync(vectorCorpusPath, "utf8")) as BIP340VectorCorpus

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

const splitSignature = (
  signatureHex: string
): { nonceX: string; signatureScalar: string } => ({
  nonceX: hex(signatureHex.slice(0, 64)),
  signatureScalar: hex(signatureHex.slice(64)),
})

const computeTaggedChallengeReference = (
  nonceX: string,
  pubKeyX: string,
  message: string
): string => {
  const tagHash = createHash("sha256").update("BIP0340/challenge").digest()
  const digest = createHash("sha256")
    .update(
      Buffer.concat([
        tagHash,
        tagHash,
        Buffer.from(nonceX, "hex"),
        Buffer.from(pubKeyX, "hex"),
        Buffer.from(message, "hex"),
      ])
    )
    .digest("hex")

  return hex(digest)
}

const negativeVector = (
  vector: BIP340Vector,
  negative: NegativeVerificationCase
) => ({
  walletIDHex: negative.walletIDHex ?? vector.walletIDHex,
  expectedBip341SighashHex:
    negative.bip341SighashHex ?? vector.expectedBip341SighashHex,
  bip340SignatureHex: negative.bip340SignatureHex ?? vector.bip340SignatureHex,
})

type ScalarMulScenarioID =
  keyof typeof LOCAL_SEED_GAS_CEILINGS.bip340ScalarMulGenerator

const scalarMulScenarios = [
  { id: "zero" as ScalarMulScenarioID, scalar: 0n },
  { id: "one" as ScalarMulScenarioID, scalar: 1n },
  { id: "highBit" as ScalarMulScenarioID, scalar: 1n << 255n },
  { id: "dense" as ScalarMulScenarioID, scalar: secp256k1N - 1n },
]

describe("CheckBitcoinBIP340Sigs", () => {
  const vectorCorpus = loadVectorCorpus()
  let harness: Contract

  before(async () => {
    const TestCheckBitcoinBIP340Sigs = await ethers.getContractFactory(
      "TestCheckBitcoinBIP340Sigs"
    )
    harness = await TestCheckBitcoinBIP340Sigs.deploy()
  })

  it("matches the BIP340 tagged challenge reference hash", async () => {
    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        const { nonceX } = splitSignature(vector.bip340SignatureHex)
        const expected = computeTaggedChallengeReference(
          nonceX.slice(2),
          vector.walletIDHex,
          vector.expectedBip341SighashHex
        )

        expect(
          await harness.computeBIP340TaggedChallenge(
            nonceX,
            hex(vector.walletIDHex),
            hex(vector.expectedBip341SighashHex)
          ),
          vector.id
        ).to.equal(expected)
      })
    )
  })

  it("verifies the BIP340 vector corpus", async () => {
    expect(vectorCorpus.name).to.equal("p2tr-signature-fraud-v0")

    await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        expect(
          await harness["checkSig(bytes32,bytes32,bytes)"](
            hex(vector.walletIDHex),
            hex(vector.expectedBip341SighashHex),
            hex(vector.bip340SignatureHex)
          ),
          vector.id
        ).to.equal(vector.expectedVerify)
      })
    )
  })

  it("rejects BIP340 verification mutations", async () => {
    await Promise.all(
      vectorCorpus.cases.flatMap((vector) =>
        vector.negativeVerificationCases.map(async (negative) => {
          expect(negative.expectedVerify, negative.id).to.be.false

          const candidate = negativeVector(vector, negative)
          expect(
            await harness["checkSig(bytes32,bytes32,bytes)"](
              hex(candidate.walletIDHex),
              hex(candidate.expectedBip341SighashHex),
              hex(candidate.bip340SignatureHex)
            ),
            `${vector.id}/${negative.id}`
          ).to.be.false
        })
      )
    )
  })

  it("rejects malformed signature length and boundary scalar/nonce values", async () => {
    const vector = vectorCorpus.cases[0]
    const { nonceX, signatureScalar } = splitSignature(
      vector.bip340SignatureHex
    )
    const zero = "0".repeat(64)
    const oversizedNonceX = secp256k1P.toString(16).padStart(64, "0")
    const oversizedScalar = secp256k1N.toString(16).padStart(64, "0")

    expect(
      await harness["checkSig(bytes32,bytes32,bytes)"](
        hex(vector.walletIDHex),
        hex(vector.expectedBip341SighashHex),
        hex(vector.bip340SignatureHex.slice(0, 126))
      ),
      "short signature"
    ).to.be.false
    expect(
      await harness["checkSig(bytes32,bytes32,bytes)"](
        hex(vector.walletIDHex),
        hex(vector.expectedBip341SighashHex),
        hex(`${vector.bip340SignatureHex.slice(0, 64)}${oversizedScalar}`)
      ),
      "s >= n"
    ).to.be.false
    expect(
      await harness["checkSig(bytes32,bytes32,bytes32,bytes32)"](
        hex(vector.walletIDHex),
        hex(vector.expectedBip341SighashHex),
        nonceX,
        hex(zero)
      ),
      "s == 0"
    ).to.be.false
    expect(
      await harness["checkSig(bytes32,bytes32,bytes32,bytes32)"](
        hex(vector.walletIDHex),
        hex(vector.expectedBip341SighashHex),
        hex(zero),
        signatureScalar
      ),
      "R.x == 0"
    ).to.be.false
    expect(
      await harness["checkSig(bytes32,bytes32,bytes32,bytes32)"](
        hex(vector.walletIDHex),
        hex(vector.expectedBip341SighashHex),
        hex(oversizedNonceX),
        signatureScalar
      ),
      "nonceX >= p"
    ).to.be.false
  })

  it("reports the current verifier gas envelope", async () => {
    const vector = vectorCorpus.cases[0]

    const gas = await harness.estimateGas["checkSig(bytes32,bytes32,bytes)"](
      hex(vector.walletIDHex),
      hex(vector.expectedBip341SighashHex),
      hex(vector.bip340SignatureHex)
    )

    expectGasAtMost(
      gas,
      LOCAL_SEED_GAS_CEILINGS.bip340CheckSig,
      "bip340_checkSig_validGas"
    )
  })

  for (const scenario of scalarMulScenarios) {
    it(`reports scalar multiplication gas for ${scenario.id}`, async () => {
      const [computed] = await harness.scalarMulGenerator(
        scenario.scalar.toString()
      )
      const gas = await harness.estimateGas.scalarMulGenerator(
        scenario.scalar.toString()
      )
      const label = `bip340_scalarMulGenerator_${scenario.id}Gas`

      expect(computed, `${scenario.id} computed`).to.be.true
      expectGasAtMost(
        gas,
        LOCAL_SEED_GAS_CEILINGS.bip340ScalarMulGenerator[scenario.id],
        label
      )
    })
  }

  it("reports scalar multiplication gas ordering", async () => {
    const oneGas = await harness.estimateGas.scalarMulGenerator("1")
    const highBitGas = await harness.estimateGas.scalarMulGenerator(
      (1n << 255n).toString()
    )
    const denseGas = await harness.estimateGas.scalarMulGenerator(
      (secp256k1N - 1n).toString()
    )

    expect(BigNumber.from(highBitGas).gte(oneGas)).to.be.true
    expect(BigNumber.from(denseGas).gte(oneGas)).to.be.true
  })

  it("agrees with the affine reference scalar multiplication", async () => {
    // Pinned scalars exercise edge cases the BIP340 vector corpus does not
    // cover directly: the additive identity, single-bit scalars at both ends
    // of the 256-bit range, a high-bit-only scalar, the curve order minus
    // one (densest bit pattern below n), and a corpus signature scalar.
    const corpusScalar = BigInt(`0x${vectorCorpus.cases[0].bip340SignatureHex}`)
    const corpusScalarMod =
      ((corpusScalar % secp256k1N) + secp256k1N) % secp256k1N
    const differentialScalars: bigint[] = [
      0n,
      1n,
      2n,
      3n,
      7n,
      1n << 128n,
      1n << 255n,
      (1n << 256n) - 1n,
      secp256k1N - 2n,
      secp256k1N - 1n,
      corpusScalarMod,
    ]

    for (const scalar of differentialScalars) {
      const jacobianResult = await harness.scalarMulGenerator(scalar.toString())
      const affineResult = await harness.affineScalarMulGenerator(
        scalar.toString()
      )
      const label = `scalar=${scalar.toString(16)}`

      expect(jacobianResult[0], `${label} jacobian computed`).to.equal(
        affineResult[0]
      )
      expect(jacobianResult[3], `${label} infinity flag`).to.equal(
        affineResult[3]
      )

      if (!jacobianResult[3]) {
        expect(jacobianResult[1], `${label} x`).to.equal(affineResult[1])
        expect(jacobianResult[2], `${label} y`).to.equal(affineResult[2])
      }
    }
  })
})
