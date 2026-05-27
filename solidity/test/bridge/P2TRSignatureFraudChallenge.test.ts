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
  expectedDraftChallengeIdentityHex: string
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

const mutateLastByte = (value: string): string => {
  const replacement = value.endsWith("00") ? "01" : "00"
  return `${value.slice(0, -2)}${replacement}`
}

const loadVectorCorpus = (): SignatureFraudVectorCorpus =>
  JSON.parse(
    fs.readFileSync(vectorCorpusPath, "utf8")
  ) as SignatureFraudVectorCorpus

const toHarnessPrevouts = (prevouts: PrevoutVector[]) =>
  prevouts.map((prevout) => ({
    txid: hex(prevout.txidHex),
    vout: prevout.vout,
    valueSats: BigNumber.from(prevout.valueSats.toString()),
    scriptPubKey: hex(prevout.scriptPubKeyHex),
  }))

const computeDraftChallengeIdentity = async (
  harness: Contract,
  vector: SignatureFraudVector,
  prevouts = toHarnessPrevouts(vector.prevouts),
  signedInputIndex = vector.signedInputIndex
): Promise<string> =>
  harness.computeDraftChallengeIdentity(
    hex(vector.walletIDHex),
    hex(vector.expectedBip341SighashHex),
    hex(vector.bip340SignatureHex),
    vector.sighashType,
    signedInputIndex,
    hex(vector.unsignedTransactionHex),
    prevouts
  )

describe("P2TR signature-fraud challenge identity vectors", () => {
  const vectorCorpus = loadVectorCorpus()
  const witnessErrorMessages = new Map([
    ["invalid-length", "Invalid witness signature length"],
    ["unsupported-sighash", "Unsupported witness sighash type"],
  ])
  let harness: Contract

  before(async () => {
    const TestP2TRSignatureFraudChallenge = await ethers.getContractFactory(
      "TestP2TRSignatureFraudChallenge"
    )
    harness = await TestP2TRSignatureFraudChallenge.deploy()
  })

  it("matches the draft challenge identities in the vector corpus", async () => {
    expect(vectorCorpus.name).to.equal("p2tr-signature-fraud-v0")
    expect(
      vectorCorpus.cases.some((vector) => vector.sighashType === 1),
      "SIGHASH_ALL vector coverage"
    ).to.be.true

    const seenChallengeIdentities = new Set<string>()

    const actualChallengeIdentities = await Promise.all(
      vectorCorpus.cases.map(async (vector) => ({
        id: vector.id,
        expected: hex(vector.expectedDraftChallengeIdentityHex),
        actual: await computeDraftChallengeIdentity(harness, vector),
      }))
    )

    actualChallengeIdentities.forEach(({ id, expected, actual }) => {
      expect(actual, id).to.equal(expected)
      expect(seenChallengeIdentities.has(actual), id).to.be.false

      seenChallengeIdentities.add(actual)
    })
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
        "0x5b9c84557643f90b47ab9bcc49ff7dba8cfe283f1c37524a1e1db4316b34252f"
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

  it("commits to the challenged input index and prevout metadata", async () => {
    const vector = vectorCorpus.cases.find(
      (candidate) =>
        candidate.id ===
        "bip341-keypath-sighash-default-multi-input-multi-output"
    )

    if (!vector) {
      throw new Error("Missing multi-input P2TR signature-fraud vector")
    }

    const expectedChallengeIdentity = hex(
      vector.expectedDraftChallengeIdentityHex
    )
    const wrongInputIndexIdentity = await computeDraftChallengeIdentity(
      harness,
      vector,
      toHarnessPrevouts(vector.prevouts),
      vector.signedInputIndex - 1
    )
    const mutatedPrevouts = toHarnessPrevouts(vector.prevouts)
    mutatedPrevouts[vector.signedInputIndex] = {
      ...mutatedPrevouts[vector.signedInputIndex],
      valueSats: mutatedPrevouts[vector.signedInputIndex].valueSats.add(1),
    }

    const wrongPrevoutIdentity = await computeDraftChallengeIdentity(
      harness,
      vector,
      mutatedPrevouts
    )

    expect(wrongInputIndexIdentity).to.not.equal(expectedChallengeIdentity)
    expect(wrongPrevoutIdentity).to.not.equal(expectedChallengeIdentity)
  })

  it("commits to wallet, sighash, signature, sighash type, and transaction", async () => {
    const vector = vectorCorpus.cases.find(
      (candidate) =>
        candidate.id === "bip341-keypath-sighash-default-single-input"
    )

    if (!vector) {
      throw new Error("Missing single-input P2TR signature-fraud vector")
    }

    const expectedChallengeIdentity = hex(
      vector.expectedDraftChallengeIdentityHex
    )
    const mutations: { name: string; vector: SignatureFraudVector }[] = [
      {
        name: "walletID",
        vector: {
          ...vector,
          walletIDHex: mutateLastByte(vector.walletIDHex),
        },
      },
      {
        name: "sighash",
        vector: {
          ...vector,
          expectedBip341SighashHex: mutateLastByte(
            vector.expectedBip341SighashHex
          ),
        },
      },
      {
        name: "signature",
        vector: {
          ...vector,
          bip340SignatureHex: mutateLastByte(vector.bip340SignatureHex),
        },
      },
      {
        name: "sighash type",
        vector: {
          ...vector,
          sighashType: vector.sighashType === 0 ? 1 : 0,
        },
      },
      {
        name: "transaction",
        vector: {
          ...vector,
          unsignedTransactionHex: mutateLastByte(vector.unsignedTransactionHex),
        },
      },
    ]

    const mutatedIdentities = await Promise.all(
      mutations.map(async (mutation) => ({
        name: mutation.name,
        identity: await computeDraftChallengeIdentity(harness, mutation.vector),
      }))
    )

    mutatedIdentities.forEach(({ name, identity }) => {
      expect(identity, name).to.not.equal(expectedChallengeIdentity)
    })
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

        const expectedError = witnessErrorMessages.get(negative.expectedError)

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
