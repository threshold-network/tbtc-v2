/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-restricted-syntax */

import fs from "fs"
import path from "path"
import { expect } from "chai"

const {
  VULNERABLE_DEPOSIT_LIBRARY,
  validateTransactionHash,
  validateAddress,
  validateLibraries,
} = require("../scripts/validate-deployment-artifacts")

describe("Deployment Artifacts Consistency", () => {
  const deploymentsDir = path.resolve(__dirname, "../deployments/mainnet")

  const FIXED_DEPOSIT_LIBRARY = "0xE83bcc22A723f693eF0fEB7044F61aeC8c79fe02"

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function loadArtifact(filename: string): any {
    const raw = fs.readFileSync(path.join(deploymentsDir, filename), "utf8")
    return JSON.parse(raw)
  }

  describe("Bridge.json", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let artifact: any

    before(() => {
      artifact = loadArtifact("Bridge.json")
    })

    it("should have top-level transactionHash matching receipt.transactionHash", () => {
      expect(artifact.transactionHash).to.equal(
        artifact.receipt.transactionHash
      )
    })

    it("should have libraries.Deposit pointing to the fixed library address", () => {
      expect(artifact.libraries.Deposit).to.equal(FIXED_DEPOSIT_LIBRARY)
      expect(artifact.libraries.Deposit).to.not.equal(
        VULNERABLE_DEPOSIT_LIBRARY
      )
    })
  })

  describe("Bridge_v2_Implementation.json", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let artifact: any

    before(() => {
      artifact = loadArtifact("Bridge_v2_Implementation.json")
    })

    it("should have top-level transactionHash matching receipt.transactionHash", () => {
      expect(artifact.transactionHash).to.equal(
        artifact.receipt.transactionHash
      )
    })

    it("should have libraries.Deposit pointing to the fixed library address", () => {
      expect(artifact.libraries.Deposit).to.equal(FIXED_DEPOSIT_LIBRARY)
      expect(artifact.libraries.Deposit).to.not.equal(
        VULNERABLE_DEPOSIT_LIBRARY
      )
    })
  })

  describe("Deposit.json", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let artifact: any

    before(() => {
      artifact = loadArtifact("Deposit.json")
    })

    it("should have top-level transactionHash matching receipt.transactionHash", () => {
      expect(artifact.transactionHash).to.equal(
        artifact.receipt.transactionHash
      )
    })

    it("should have address matching receipt.contractAddress", () => {
      expect(artifact.address).to.equal(artifact.receipt.contractAddress)
    })
  })

  describe("Generic All-Artifact Validation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let artifacts: { filename: string; data: any }[]
    let knownAddresses: Set<string>

    before(() => {
      const files = fs
        .readdirSync(deploymentsDir)
        .filter((f) => f.endsWith(".json"))

      artifacts = files.map((filename) => ({
        filename,
        data: loadArtifact(filename),
      }))

      // Pre-build the set of known artifact addresses for library validation
      knownAddresses = new Set(
        artifacts
          .filter((a) => a.data.address)
          .map((a) => a.data.address.toLowerCase())
      )
    })

    it("should have matching transactionHash for all artifacts with receipt", () => {
      const artifactsWithReceipt = artifacts.filter((a) => a.data.receipt)
      expect(artifactsWithReceipt.length).to.be.greaterThan(0)

      for (const { filename, data } of artifactsWithReceipt) {
        const result = validateTransactionHash(data)
        expect(result.valid, `${filename}: ${result.error}`).to.be.true
      }
    })

    it("should have matching address for all artifacts with non-null receipt.contractAddress", () => {
      const artifactsWithContractAddress = artifacts.filter(
        (a) => a.data.receipt && a.data.receipt.contractAddress != null
      )
      expect(artifactsWithContractAddress.length).to.be.greaterThan(0)

      for (const { filename, data } of artifactsWithContractAddress) {
        const result = validateAddress(data)
        expect(result.valid, `${filename}: ${result.error}`).to.be.true
      }
    })

    it("should have valid library references for artifacts with libraries", () => {
      const artifactsWithLibraries = artifacts.filter((a) => a.data.libraries)
      expect(artifactsWithLibraries.length).to.be.greaterThan(0)

      for (const { filename, data } of artifactsWithLibraries) {
        const result = validateLibraries(data, knownAddresses)
        expect(result.valid, `${filename}: ${result.error}`).to.be.true
      }
    })

    it("should gracefully skip non-standard files without receipt", () => {
      const nonStandardFiles = artifacts.filter((a) => !a.data.receipt)
      expect(nonStandardFiles.length).to.be.greaterThan(0)

      for (const { data } of nonStandardFiles) {
        const result = validateTransactionHash(data)
        expect(result.valid).to.be.true
        expect(result.skipped).to.be.true
      }
    })
  })

  describe("Known-Bad Sample Detection", () => {
    it("should detect mismatched transactionHash", () => {
      const badArtifact = {
        transactionHash: "0xaaa",
        receipt: { transactionHash: "0xbbb" },
      }

      const result = validateTransactionHash(badArtifact)
      expect(result.valid).to.be.false
      expect(result.error).to.include("transactionHash mismatch")
    })

    it("should detect mismatched address vs receipt.contractAddress", () => {
      const badArtifact = {
        address: "0x1111111111111111111111111111111111111111",
        receipt: {
          contractAddress: "0x2222222222222222222222222222222222222222",
        },
      }

      const result = validateAddress(badArtifact)
      expect(result.valid).to.be.false
      expect(result.error).to.include("address mismatch")
    })

    it("should detect vulnerable Deposit library address", () => {
      const badArtifact = {
        libraries: { Deposit: VULNERABLE_DEPOSIT_LIBRARY },
      }

      const knownAddresses = new Set([VULNERABLE_DEPOSIT_LIBRARY.toLowerCase()])

      const result = validateLibraries(badArtifact, knownAddresses)
      expect(result.valid).to.be.false
      expect(result.error).to.include("vulnerable")
    })
  })
})
