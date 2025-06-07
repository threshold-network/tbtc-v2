import { expect } from "chai"
import { loadStarkNetCrossChainInterfaces } from "../../../src/lib/starknet"
import { StarkNetAddress } from "../../../src/lib/starknet"
import { DestinationChainInterfaces } from "../../../src/lib/contracts"

describe("StarkNet Module", () => {
  describe("loadStarkNetCrossChainInterfaces", () => {
    let contracts: DestinationChainInterfaces

    beforeEach(async () => {
      const walletAddress = "0x1234567890abcdef"
      contracts = await loadStarkNetCrossChainInterfaces(walletAddress)
    })

    it("should return DestinationChainInterfaces with required properties", () => {
      expect(contracts).to.have.property("destinationChainBitcoinDepositor")
      expect(contracts).to.have.property("destinationChainTbtcToken")
    })

    it("should return a StarkNetBitcoinDepositor instance", () => {
      expect(
        contracts.destinationChainBitcoinDepositor.constructor.name
      ).to.equal("StarkNetBitcoinDepositor")
    })

    it("should return a StarkNetTBTCToken instance", () => {
      expect(contracts.destinationChainTbtcToken.constructor.name).to.equal(
        "StarkNetTBTCToken"
      )
    })

    it("should set the deposit owner to the provided wallet address", () => {
      const depositOwner =
        contracts.destinationChainBitcoinDepositor.getDepositOwner()
      expect(depositOwner).to.be.instanceOf(StarkNetAddress)
      expect(depositOwner?.identifierHex).to.equal(
        "0000000000000000000000000000000000000000000000001234567890abcdef"
      )
    })

    it("should handle wallet address without 0x prefix", async () => {
      const walletAddress = "abcdef123456"
      const contractsWithoutPrefix = await loadStarkNetCrossChainInterfaces(
        walletAddress
      )

      const depositOwner =
        contractsWithoutPrefix.destinationChainBitcoinDepositor.getDepositOwner()
      expect(depositOwner).to.be.instanceOf(StarkNetAddress)
      expect(depositOwner?.identifierHex).to.equal(
        "0000000000000000000000000000000000000000000000000000abcdef123456"
      )
    })

    it("should handle full-length wallet address", async () => {
      const walletAddress = "0x" + "f".repeat(64)
      const contractsFullLength = await loadStarkNetCrossChainInterfaces(
        walletAddress
      )

      const depositOwner =
        contractsFullLength.destinationChainBitcoinDepositor.getDepositOwner()
      expect(depositOwner?.identifierHex).to.equal("f".repeat(64))
    })

    it("should throw error for invalid wallet address", async () => {
      const invalidAddress = "xyz123" // Invalid hex

      await expect(
        loadStarkNetCrossChainInterfaces(invalidAddress)
      ).to.be.rejectedWith("Invalid StarkNet address format")
    })

    it("should throw error for address exceeding field element size", async () => {
      const tooLongAddress = "0x" + "f".repeat(65) // 65 hex chars exceeds limit

      await expect(
        loadStarkNetCrossChainInterfaces(tooLongAddress)
      ).to.be.rejectedWith(
        "StarkNet address exceeds maximum field element size"
      )
    })

    it("should handle concurrent calls correctly", async () => {
      const addresses = ["0x111", "0x222", "0x333"]

      const promises = addresses.map((addr) =>
        loadStarkNetCrossChainInterfaces(addr)
      )

      const results = await Promise.all(promises)

      // Verify each result has the correct deposit owner
      results.forEach((contract: DestinationChainInterfaces, index: number) => {
        const owner =
          contract.destinationChainBitcoinDepositor.getDepositOwner()
        expect(owner).to.be.instanceOf(StarkNetAddress)
        expect(owner?.identifierHex).to.include(addresses[index].slice(2))
      })
    })

    it("should handle empty string address", async () => {
      await expect(loadStarkNetCrossChainInterfaces("")).to.be.rejectedWith(
        "Invalid StarkNet address format"
      )
    })

    it("should create independent instances for different addresses", async () => {
      const contracts1 = await loadStarkNetCrossChainInterfaces("0x111")
      const contracts2 = await loadStarkNetCrossChainInterfaces("0x222")

      // Verify they are different instances
      expect(contracts1.destinationChainBitcoinDepositor).to.not.equal(
        contracts2.destinationChainBitcoinDepositor
      )
      expect(contracts1.destinationChainTbtcToken).to.not.equal(
        contracts2.destinationChainTbtcToken
      )

      // Verify they have different deposit owners
      const owner1 =
        contracts1.destinationChainBitcoinDepositor.getDepositOwner()
      const owner2 =
        contracts2.destinationChainBitcoinDepositor.getDepositOwner()
      expect(owner1?.identifierHex).to.not.equal(owner2?.identifierHex)
    })
  })

  describe("module exports", () => {
    it("should export StarkNetAddress", async () => {
      const { StarkNetAddress } = await import("../../../src/lib/starknet")
      expect(StarkNetAddress).to.exist
    })

    it("should export StarkNetExtraDataEncoder", async () => {
      const { StarkNetExtraDataEncoder } = await import(
        "../../../src/lib/starknet"
      )
      expect(StarkNetExtraDataEncoder).to.exist
    })

    it("should export StarkNetBitcoinDepositor", async () => {
      const { StarkNetBitcoinDepositor } = await import(
        "../../../src/lib/starknet"
      )
      expect(StarkNetBitcoinDepositor).to.exist
    })

    it("should export StarkNetTBTCToken", async () => {
      const { StarkNetTBTCToken } = await import("../../../src/lib/starknet")
      expect(StarkNetTBTCToken).to.exist
    })

    it("should export loadStarkNetCrossChainInterfaces", async () => {
      const { loadStarkNetCrossChainInterfaces } = await import(
        "../../../src/lib/starknet"
      )
      expect(loadStarkNetCrossChainInterfaces).to.be.a("function")
    })
  })
})
