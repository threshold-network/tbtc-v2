import { expect } from "chai"
import { loadStarkNetCrossChainContracts } from "../../../src/lib/starknet"
import { StarkNetAddress } from "../../../src/lib/starknet"
import { L2CrossChainContracts } from "../../../src/lib/contracts"

describe("StarkNet Module", () => {
  describe("loadStarkNetCrossChainContracts", () => {
    let contracts: L2CrossChainContracts

    beforeEach(async () => {
      const walletAddress = "0x1234567890abcdef"
      contracts = await loadStarkNetCrossChainContracts(walletAddress)
    })

    it("should return L2CrossChainContracts with required properties", () => {
      expect(contracts).to.have.property("l2BitcoinDepositor")
      expect(contracts).to.have.property("l2TbtcToken")
    })

    it("should return a StarkNetDepositorInterface instance", () => {
      expect(contracts.l2BitcoinDepositor.constructor.name).to.equal(
        "StarkNetDepositorInterface"
      )
    })

    it("should return a StarkNetTBTCToken instance", () => {
      expect(contracts.l2TbtcToken.constructor.name).to.equal(
        "StarkNetTBTCToken"
      )
    })

    it("should set the deposit owner to the provided wallet address", () => {
      const depositOwner = contracts.l2BitcoinDepositor.getDepositOwner()
      expect(depositOwner).to.be.instanceOf(StarkNetAddress)
      expect(depositOwner?.identifierHex).to.equal(
        "0000000000000000000000000000000000000000000000001234567890abcdef"
      )
    })

    it("should handle wallet address without 0x prefix", async () => {
      const walletAddress = "abcdef123456"
      const contractsWithoutPrefix = await loadStarkNetCrossChainContracts(
        walletAddress
      )

      const depositOwner =
        contractsWithoutPrefix.l2BitcoinDepositor.getDepositOwner()
      expect(depositOwner).to.be.instanceOf(StarkNetAddress)
      expect(depositOwner?.identifierHex).to.equal(
        "0000000000000000000000000000000000000000000000000000abcdef123456"
      )
    })

    it("should handle full-length wallet address", async () => {
      const walletAddress = "0x" + "f".repeat(64)
      const contractsFullLength = await loadStarkNetCrossChainContracts(
        walletAddress
      )

      const depositOwner =
        contractsFullLength.l2BitcoinDepositor.getDepositOwner()
      expect(depositOwner?.identifierHex).to.equal("f".repeat(64))
    })

    it("should throw error for invalid wallet address", async () => {
      const invalidAddress = "xyz123" // Invalid hex

      await expect(
        loadStarkNetCrossChainContracts(invalidAddress)
      ).to.be.rejectedWith("Invalid StarkNet address format")
    })

    it("should throw error for address exceeding field element size", async () => {
      const tooLongAddress = "0x" + "f".repeat(65) // 65 hex chars exceeds limit

      await expect(
        loadStarkNetCrossChainContracts(tooLongAddress)
      ).to.be.rejectedWith(
        "StarkNet address exceeds maximum field element size"
      )
    })

    it("should handle concurrent calls correctly", async () => {
      const addresses = ["0x111", "0x222", "0x333"]

      const promises = addresses.map((addr) =>
        loadStarkNetCrossChainContracts(addr)
      )

      const results = await Promise.all(promises)

      // Verify each result has the correct deposit owner
      results.forEach((contract, index) => {
        const owner = contract.l2BitcoinDepositor.getDepositOwner()
        expect(owner).to.be.instanceOf(StarkNetAddress)
        expect(owner?.identifierHex).to.include(addresses[index].slice(2))
      })
    })

    it("should handle empty string address", async () => {
      await expect(loadStarkNetCrossChainContracts("")).to.be.rejectedWith(
        "Invalid StarkNet address format"
      )
    })

    it("should create independent instances for different addresses", async () => {
      const contracts1 = await loadStarkNetCrossChainContracts("0x111")
      const contracts2 = await loadStarkNetCrossChainContracts("0x222")

      // Verify they are different instances
      expect(contracts1.l2BitcoinDepositor).to.not.equal(
        contracts2.l2BitcoinDepositor
      )
      expect(contracts1.l2TbtcToken).to.not.equal(contracts2.l2TbtcToken)

      // Verify they have different deposit owners
      const owner1 = contracts1.l2BitcoinDepositor.getDepositOwner()
      const owner2 = contracts2.l2BitcoinDepositor.getDepositOwner()
      expect(owner1?.identifierHex).to.not.equal(owner2?.identifierHex)
    })
  })

  describe("module exports", () => {
    it("should export StarkNetAddress", async () => {
      const { StarkNetAddress } = await import("../../../src/lib/starknet")
      expect(StarkNetAddress).to.exist
    })

    it("should export StarkNetCrossChainExtraDataEncoder", async () => {
      const { StarkNetCrossChainExtraDataEncoder } = await import(
        "../../../src/lib/starknet"
      )
      expect(StarkNetCrossChainExtraDataEncoder).to.exist
    })

    it("should export StarkNetDepositorInterface", async () => {
      const { StarkNetDepositorInterface } = await import(
        "../../../src/lib/starknet"
      )
      expect(StarkNetDepositorInterface).to.exist
    })

    it("should export StarkNetTBTCToken", async () => {
      const { StarkNetTBTCToken } = await import("../../../src/lib/starknet")
      expect(StarkNetTBTCToken).to.exist
    })

    it("should export loadStarkNetCrossChainContracts", async () => {
      const { loadStarkNetCrossChainContracts } = await import(
        "../../../src/lib/starknet"
      )
      expect(loadStarkNetCrossChainContracts).to.be.a("function")
    })
  })
})
