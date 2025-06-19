import { expect } from "chai"
import { readFileSync } from "fs"
import { join } from "path"

describe("StarkNet Bitcoin Depositor Artifacts", () => {
  const networks = ["mainnet", "sepolia"]
  const artifactDir = join(process.cwd(), "src/lib/ethereum/artifacts")

  networks.forEach((network) => {
    describe(`${network} network artifacts`, () => {
      let artifactPath: string
      let artifact: any

      beforeEach(() => {
        artifactPath = join(
          artifactDir,
          `${network}/StarkNetBitcoinDepositor.json`
        )
        artifact = JSON.parse(readFileSync(artifactPath, "utf8"))
      })

      if (network === "mainnet" || network === "sepolia") {
        // Both mainnet and sepolia are now deployed
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
        "mainnet/StarkNetBitcoinDepositor.json"
      )
      const mainnetArtifact = JSON.parse(
        readFileSync(mainnetArtifactPath, "utf8")
      )

      expect(mainnetArtifact).to.be.an("object")
      // Mainnet is now deployed
      expect(mainnetArtifact.address).to.match(/^0x[a-fA-F0-9]{40}$/)
      expect(mainnetArtifact.abi).to.be.an("array").that.is.not.empty

      // Test sepolia artifact (deployed)
      const sepoliaArtifactPath = join(
        artifactDir,
        "sepolia/StarkNetBitcoinDepositor.json"
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
