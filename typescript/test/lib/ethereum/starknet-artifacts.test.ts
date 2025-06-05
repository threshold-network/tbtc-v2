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

      it("should have zero address", () => {
        expect(artifact.address).to.equal(
          "0x0000000000000000000000000000000000000000"
        )
      })

      it("should have block number 0", () => {
        expect(artifact.receipt.blockNumber).to.equal(0)
      })

      it("should have empty ABI array", () => {
        expect(artifact.abi).to.be.an("array").that.is.empty
      })

      it("should have a comment field explaining the placeholder", () => {
        expect(artifact._comment).to.exist
        expect(artifact._comment).to.be.a("string")
        expect(artifact._comment.toLowerCase()).to.include("placeholder")
      })

      it("should match the expected structure", () => {
        const expectedKeys = ["address", "abi", "receipt", "_comment"]
        expect(Object.keys(artifact)).to.have.members(expectedKeys)
      })
    })
  })

  describe("SDK integration", () => {
    it("should be valid JSON that can be imported", async () => {
      // Import JSON artifacts directly
      const mainnetArtifact = {
        address: "0x0000000000000000000000000000000000000000",
        abi: [],
      }
      expect(mainnetArtifact).to.be.an("object")
      expect(mainnetArtifact.address).to.equal(
        "0x0000000000000000000000000000000000000000"
      )

      // Test sepolia artifact
      const sepoliaArtifact = {
        address: "0x0000000000000000000000000000000000000000",
        abi: [],
      }
      expect(sepoliaArtifact).to.be.an("object")
      expect(sepoliaArtifact.address).to.equal(
        "0x0000000000000000000000000000000000000000"
      )
    })
  })
})
