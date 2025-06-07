import { expect } from "chai"
import { readFileSync } from "fs"
import { join } from "path"

describe("StarkNet L1 Bitcoin Depositor Artifacts", () => {
  const networks = ["mainnet", "sepolia"]
  const artifactDir = join(process.cwd(), "src/lib/ethereum/artifacts")

  networks.forEach((network) => {
    describe(`${network} network artifacts`, () => {
      let artifactPath: string
      let artifact: any

      beforeEach(() => {
        artifactPath = join(
          artifactDir,
          `${network}/StarkNetL1BitcoinDepositor.json`
        )
        artifact = JSON.parse(readFileSync(artifactPath, "utf8"))
      })

      if (network === "mainnet") {
        // Mainnet is a placeholder
        it("should have zero address for placeholder", () => {
          expect(artifact.address).to.equal(
            "0x0000000000000000000000000000000000000000"
          )
        })

        it("should have block number 0 for placeholder", () => {
          expect(artifact.receipt.blockNumber).to.equal(0)
        })

        it("should have empty ABI array for placeholder", () => {
          expect(artifact.abi).to.be.an("array").that.is.empty
        })

        it("should have a comment field explaining the placeholder", () => {
          expect(artifact._comment).to.exist
          expect(artifact._comment).to.be.a("string")
          expect(artifact._comment.toLowerCase()).to.include("placeholder")
        })

        it("should match the placeholder structure", () => {
          expect(artifact).to.have.property("address")
          expect(artifact).to.have.property("abi")
          expect(artifact).to.have.property("receipt")
          expect(artifact).to.have.property("_comment")
        })
      } else {
        // Sepolia is deployed
        it("should have a valid address", () => {
          expect(artifact.address).to.be.a("string")
          expect(artifact.address).to.match(/^0x[a-fA-F0-9]{40}$/)
        })

        it("should have a valid block number", () => {
          expect(artifact.receipt.blockNumber).to.be.a("number")
          expect(artifact.receipt.blockNumber).to.be.greaterThan(0)
        })

        it("should have a non-empty ABI array", () => {
          expect(artifact.abi).to.be.an("array").that.is.not.empty
        })

        it("should have constructor in ABI", () => {
          const constructor = artifact.abi.find(
            (item: any) => item.type === "constructor"
          )
          expect(constructor).to.exist
        })

        it("should match the expected structure", () => {
          expect(artifact).to.have.property("address")
          expect(artifact).to.have.property("abi")
          expect(artifact).to.have.property("receipt")
          expect(artifact).to.have.property("transactionHash")
        })
      }
    })
  })

  describe("SDK integration", () => {
    it("should be valid JSON that can be imported", async () => {
      // Import actual artifacts
      const mainnetArtifactPath = join(
        artifactDir,
        "mainnet/StarkNetL1BitcoinDepositor.json"
      )
      const mainnetArtifact = JSON.parse(
        readFileSync(mainnetArtifactPath, "utf8")
      )

      expect(mainnetArtifact).to.be.an("object")
      // Mainnet is a placeholder
      expect(mainnetArtifact.address).to.equal(
        "0x0000000000000000000000000000000000000000"
      )
      expect(mainnetArtifact.abi).to.be.an("array").that.is.empty
      expect(mainnetArtifact._comment).to.exist

      // Test sepolia artifact (deployed)
      const sepoliaArtifactPath = join(
        artifactDir,
        "sepolia/StarkNetL1BitcoinDepositor.json"
      )
      const sepoliaArtifact = JSON.parse(
        readFileSync(sepoliaArtifactPath, "utf8")
      )

      expect(sepoliaArtifact).to.be.an("object")
      expect(sepoliaArtifact.address).to.match(/^0x[a-fA-F0-9]{40}$/)
      expect(sepoliaArtifact.abi).to.be.an("array").that.is.not.empty
    })
  })
})
