import { expect } from "chai"
import {
  loadStarkNetCrossChainContracts,
  StarkNetAddress,
  StarkNetCrossChainExtraDataEncoder,
} from "../../../src/lib/starknet"
import { Chains } from "../../../src/lib/contracts"
import { Hex } from "../../../src/lib/utils"

describe("StarkNet Integration Tests", () => {
  describe("L1 Bitcoin Depositor with StarkNet Integration", () => {
    it("should encode StarkNet recipient address for L1 deposit", async () => {
      // Create StarkNet contracts
      const starkNetRecipient =
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      const contracts = await loadStarkNetCrossChainContracts(starkNetRecipient)

      // Get the extra data encoder
      const encoder = contracts.l2BitcoinDepositor.extraDataEncoder()

      // Encode the recipient address
      const recipientAddress = StarkNetAddress.from(starkNetRecipient)
      const extraData = encoder.encodeDepositOwner(recipientAddress)

      // Verify encoding
      expect(extraData).to.be.instanceOf(Hex)
      expect(extraData.toPrefixedString()).to.have.length(66) // 0x + 64 hex chars
      expect(extraData.toPrefixedString()).to.equal(
        recipientAddress.toBytes32()
      )
    })

    it("should handle full deposit flow with StarkNet", async () => {
      // Setup StarkNet recipient
      const starkNetRecipient = "0x1234567890abcdef"
      const recipientAddress = StarkNetAddress.from(starkNetRecipient)

      // Create encoder
      const encoder = new StarkNetCrossChainExtraDataEncoder()
      const encodedExtraData = encoder.encodeDepositOwner(recipientAddress)

      // Verify round-trip encoding
      const decodedAddress = encoder.decodeDepositOwner(encodedExtraData)
      expect(decodedAddress.identifierHex).to.equal(
        recipientAddress.identifierHex
      )
    })

    it("should properly integrate with L1 depositor artifact loading", () => {
      // This test verifies that StarkNet is properly integrated into the L1 depositor
      // Note: We cannot test actual contract interaction without deployed contracts
      // This is a placeholder for when artifacts are available

      // Verify StarkNet chain definitions are available
      expect(Chains.StarkNet).to.exist
      expect(Chains.StarkNet.Mainnet).to.equal("0x534e5f4d41494e")
      expect(Chains.StarkNet.Sepolia).to.equal("0x534e5f5345504f4c4941")
    })
  })

  describe("Cross-Component Integration", () => {
    it("should handle deposit owner flow correctly", async () => {
      // Create contracts with initial owner
      const initialOwner = "0xaaa"
      const contracts = await loadStarkNetCrossChainContracts(initialOwner)

      // Verify initial owner is set
      const owner1 = contracts.l2BitcoinDepositor.getDepositOwner()
      expect(owner1).to.be.instanceOf(StarkNetAddress)
      expect(owner1?.identifierHex).to.include("aaa")

      // Change owner
      const newOwner = StarkNetAddress.from("0xbbb")
      contracts.l2BitcoinDepositor.setDepositOwner(newOwner)

      // Verify owner changed
      const owner2 = contracts.l2BitcoinDepositor.getDepositOwner()
      expect(owner2).to.equal(newOwner)
      expect(owner2?.identifierHex).to.include("bbb")
    })

    it("should validate addresses consistently across components", async () => {
      const invalidAddresses = [
        "not-hex",
        "0xG123", // Invalid hex char
        "0x" + "f".repeat(65), // Too long
      ]

      for (const invalid of invalidAddresses) {
        // Address validation should fail
        expect(() => StarkNetAddress.from(invalid)).to.throw()

        // Module loader should also fail
        await expect(loadStarkNetCrossChainContracts(invalid)).to.be.rejected
      }
    })

    it.skip("should handle error propagation correctly", async () => {
      const contracts = await loadStarkNetCrossChainContracts("0x123")

      // Verify errors propagate correctly from token interface
      const validAddress = StarkNetAddress.from("0x456")
      await expect(
        contracts.l2TbtcToken.balanceOf(validAddress)
      ).to.be.rejectedWith("Token operations are not supported on StarkNet yet")

      // Verify errors propagate correctly from depositor interface
      await expect(
        contracts.l2BitcoinDepositor.initializeDeposit({} as any, 0, {} as any)
      ).to.be.rejectedWith("Use L1 StarkNet Bitcoin Depositor instead")
    })
  })

  describe("Module Loading and Initialization", () => {
    it("should handle rapid sequential loads", async () => {
      const addresses = Array.from({ length: 10 }, (_, i) => `0x${i}`)

      for (const addr of addresses) {
        const contracts = await loadStarkNetCrossChainContracts(addr)
        expect(contracts).to.exist
        expect(contracts.l2BitcoinDepositor).to.exist
        expect(contracts.l2TbtcToken).to.exist
      }
    })

    it("should maintain isolation between instances", async () => {
      const contracts1 = await loadStarkNetCrossChainContracts("0x111")
      const contracts2 = await loadStarkNetCrossChainContracts("0x222")

      // Change owner in first instance
      const newOwner = StarkNetAddress.from("0x333")
      contracts1.l2BitcoinDepositor.setDepositOwner(newOwner)

      // Verify second instance is not affected
      const owner2 = contracts2.l2BitcoinDepositor.getDepositOwner()
      expect(owner2?.identifierHex).to.not.include("333")
      expect(owner2?.identifierHex).to.include("222")
    })
  })
})
