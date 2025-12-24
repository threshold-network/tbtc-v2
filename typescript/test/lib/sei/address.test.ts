import { expect } from "chai"
import { SeiAddress } from "../../../src/lib/sei/address"

describe("SeiAddress", () => {
  describe("from", () => {
    it("should create address from valid hex string with 0x prefix", () => {
      const address = "0x1234567890123456789012345678901234567890"
      const seiAddress = SeiAddress.from(address)
      expect(seiAddress).to.exist
      expect(seiAddress.identifierHex).to.equal(
        "1234567890123456789012345678901234567890"
      )
    })

    it("should create address from valid hex string without 0x prefix", () => {
      const address = "1234567890123456789012345678901234567890"
      const seiAddress = SeiAddress.from(address)
      expect(seiAddress.identifierHex).to.equal(
        "1234567890123456789012345678901234567890"
      )
    })

    it("should handle mixed case addresses", () => {
      const address = "0x1234567890123456789012345678901234567890"
      const seiAddress = SeiAddress.from(address)
      expect(seiAddress.identifierHex).to.equal(
        "1234567890123456789012345678901234567890"
      )
    })

    it("should normalize to lowercase", () => {
      const address = "0xABCDEFabcdef1234567890123456789012345678"
      const seiAddress = SeiAddress.from(address)
      expect(seiAddress.identifierHex).to.equal(
        "abcdefabcdef1234567890123456789012345678"
      )
    })

    it("should accept full-length EVM address (40 hex chars)", () => {
      const address = "0x" + "f".repeat(40)
      const seiAddress = SeiAddress.from(address)
      expect(seiAddress.identifierHex).to.equal("f".repeat(40))
    })

    it("should throw error for invalid hex characters", () => {
      const invalidAddress = "0x123456789012345678901234567890123456789z"
      expect(() => SeiAddress.from(invalidAddress)).to.throw(
        "Invalid Sei address format: 0x123456789012345678901234567890123456789z"
      )
    })

    it("should throw error for addresses that are too short", () => {
      const tooShortAddress = "0x12345678901234567890123456789012345678"
      expect(() => SeiAddress.from(tooShortAddress)).to.throw(
        "Invalid Sei address format: 0x12345678901234567890123456789012345678"
      )
    })

    it("should throw error for addresses that are too long", () => {
      const tooLongAddress = "0x" + "f".repeat(41)
      expect(() => SeiAddress.from(tooLongAddress)).to.throw(
        "Invalid Sei address format: 0x" + "f".repeat(41)
      )
    })

    it("should throw error for empty string", () => {
      expect(() => SeiAddress.from("")).to.throw("Invalid Sei address format: ")
    })

    it("should throw error for only 0x prefix", () => {
      expect(() => SeiAddress.from("0x")).to.throw(
        "Invalid Sei address format: 0x"
      )
    })
  })

  describe("equals", () => {
    it("should return true for identical addresses", () => {
      const address1 = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      const address2 = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      expect(address1.equals(address2)).to.be.true
    })

    it("should return true for same address with different formats", () => {
      const address1 = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      const address2 = SeiAddress.from(
        "1234567890123456789012345678901234567890"
      )
      expect(address1.equals(address2)).to.be.true
    })

    it("should return true for same address with different cases", () => {
      const address1 = SeiAddress.from(
        "0xABCDEFabcdef1234567890123456789012345678"
      )
      const address2 = SeiAddress.from(
        "0xabcdefabcdef1234567890123456789012345678"
      )
      expect(address1.equals(address2)).to.be.true
    })

    it("should return false for different addresses", () => {
      const address1 = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      const address2 = SeiAddress.from(
        "0xabcdefabcdef1234567890123456789012345678"
      )
      expect(address1.equals(address2)).to.be.false
    })

    it("should return false when comparing with non-SeiAddress", () => {
      const address = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      const otherValue = {
        identifierHex: "1234567890123456789012345678901234567890",
      }
      expect(address.equals(otherValue as any)).to.be.false
    })
  })

  describe("toString", () => {
    it("should return hex string with 0x prefix", () => {
      const address = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      const addressString = address.toString()
      expect(addressString).to.equal(
        "0x1234567890123456789012345678901234567890"
      )
    })

    it("should return properly formatted address for full address", () => {
      const address = SeiAddress.from("0x" + "a".repeat(40))
      const addressString = address.toString()
      expect(addressString).to.equal("0x" + "a".repeat(40))
    })
  })

  describe("ChainIdentifier interface", () => {
    it("should implement ChainIdentifier interface", () => {
      const address = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      expect(address).to.have.property("identifierHex")
      expect(address).to.have.property("equals")
    })
  })
})
