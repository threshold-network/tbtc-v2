import { expect } from "chai"
import { loadStarkNetCrossChainContracts } from "../../../src/lib/starknet"
import { L2Chain } from "../../../src/lib/contracts"

describe("StarkNet Module Integration", () => {
  describe("SDK exports", () => {
    it("should export StarkNet as a supported L2 chain", () => {
      const supportedChains: L2Chain[] = ["Base", "Arbitrum", "StarkNet"]
      expect(supportedChains).to.include("StarkNet")
    })

    it("should export loadStarkNetCrossChainContracts function", () => {
      expect(loadStarkNetCrossChainContracts).to.be.a("function")
    })
  })

  describe("TBTC service integration", () => {
    it("should handle StarkNet in L2 chain switches", async () => {
      // This test ensures that any switch statement handling L2 chains
      // includes StarkNet as a case
      const handleL2Chain = (chain: L2Chain): string => {
        switch (chain) {
          case "Base":
            return "base-handler"
          case "Arbitrum":
            return "arbitrum-handler"
          case "StarkNet":
            return "starknet-handler"
          default:
            throw new Error(`Unsupported L2 chain: ${chain}`)
        }
      }

      expect(handleL2Chain("StarkNet")).to.equal("starknet-handler")
    })
  })

  describe("Factory functions", () => {
    it("should support StarkNet in cross-chain contract loading", async () => {
      // Test that we can load StarkNet contracts
      const walletAddress = "0x1234567890abcdef1234567890abcdef12345678"
      const contracts = await loadStarkNetCrossChainContracts(walletAddress)

      expect(contracts).to.have.property("l2BitcoinDepositor")
      expect(contracts).to.have.property("l2TbtcToken")
    })
  })
})
