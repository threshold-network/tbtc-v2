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
  expectedBridgeChallengeIdentityHex: string
}

type NegativeWitnessVector = {
  id: string
  baseCaseId: string
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

const hex = (value: string): string => `0x${value}`

const loadVectorCorpus = (): SignatureFraudVectorCorpus =>
  JSON.parse(
    fs.readFileSync(vectorCorpusPath, "utf8")
  ) as SignatureFraudVectorCorpus

const witnessErrorMessages: Record<string, string> = {
  "invalid-length": "Invalid witness signature length",
  "unsupported-sighash": "Unsupported witness sighash type",
}

describe("P2TR signature-fraud challenge identity vectors", () => {
  const vectorCorpus = loadVectorCorpus()
  let harness: Contract

  before(async () => {
    // Draft challenge identity (prototype) coverage was removed when the
    // PrototypeP2TRSignatureFraud library was retired alongside
    // solidity/contracts/prototypes/. The harness here exercises only the
    // production P2TRSignatureFraud witness parser and Bridge challenge-key
    // derivation.
    const TestP2TRSignatureFraudChallenge = await ethers.getContractFactory(
      "TestP2TRSignatureFraudChallenge"
    )
    harness = await TestP2TRSignatureFraudChallenge.deploy()
  })

  it("computes domain-separated Bridge challenge keys", async () => {
    const vector = vectorCorpus.cases[0]
    const bridgeChallengeIdentity = hex(
      vector.expectedBridgeChallengeIdentityHex
    )
    const bridgeAddress = "0x1111111111111111111111111111111111111111"
    const bridgeChallengeKey = await harness.computeBridgeChallengeKey(
      11155111,
      bridgeAddress,
      bridgeChallengeIdentity
    )

    expect(bridgeChallengeKey).to.equal(
      BigNumber.from(
        "0xdfc3a7c7a3717d106b1ee3cd7e10f744e4487a9061aadc4fa0204daf45b09d0a"
      )
    )
    expect(
      await harness.computeBridgeChallengeKey(
        1,
        bridgeAddress,
        bridgeChallengeIdentity
      )
    ).to.not.equal(bridgeChallengeKey)
    expect(
      await harness.computeBridgeChallengeKey(
        11155111,
        "0x2222222222222222222222222222222222222222",
        bridgeChallengeIdentity
      )
    ).to.not.equal(bridgeChallengeKey)
    expect(
      await harness.computeBridgeChallengeKey(
        11155111,
        bridgeAddress,
        ethers.constants.HashZero
      )
    ).to.not.equal(bridgeChallengeKey)
  })

  it("rejects invalid Bridge challenge-key domains", async () => {
    const bridgeChallengeIdentity = hex(
      vectorCorpus.cases[0].expectedBridgeChallengeIdentityHex
    )

    await expect(
      harness.computeBridgeChallengeKey(
        0,
        "0x1111111111111111111111111111111111111111",
        bridgeChallengeIdentity
      )
    ).to.be.revertedWith("Chain ID must be positive")
    await expect(
      harness.computeBridgeChallengeKey(
        11155111,
        ethers.constants.AddressZero,
        bridgeChallengeIdentity
      )
    ).to.be.revertedWith("Bridge address must be non-zero")
  })

  it("parses supported Taproot witness signature encodings", async () => {
    const parsedWitnesses = await Promise.all(
      vectorCorpus.cases.map(async (vector) => {
        const [signature, sighashType] = await harness.parseWitnessSignature(
          hex(vector.witnessSignatureHex)
        )

        return {
          id: vector.id,
          signature,
          sighashType: BigNumber.from(sighashType).toNumber(),
        }
      })
    )

    parsedWitnesses.forEach(({ id, signature, sighashType }) => {
      const vector = vectorCorpus.cases.find((candidate) => candidate.id === id)

      if (!vector) {
        throw new Error(`Missing P2TR signature-fraud vector ${id}`)
      }

      expect(signature, id).to.equal(hex(vector.bip340SignatureHex))
      expect(sighashType, id).to.equal(vector.sighashType)
    })
  })

  it("rejects unsupported Taproot witness signature encodings", async () => {
    expect(vectorCorpus.negativeWitnessCases.length).to.be.greaterThan(0)

    await Promise.all(
      vectorCorpus.negativeWitnessCases.map(async (negative) => {
        expect(
          vectorCorpus.cases.some(
            (vector) => vector.id === negative.baseCaseId
          ),
          negative.id
        ).to.be.true

        const expectedError = witnessErrorMessages[negative.expectedError]

        if (!expectedError) {
          throw new Error(
            `Unknown witness parser error ${negative.expectedError}`
          )
        }

        await expect(
          harness.parseWitnessSignature(hex(negative.witnessSignatureHex)),
          negative.id
        ).to.be.revertedWith(expectedError)
      })
    )
  })
})