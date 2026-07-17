import { expect } from "chai"
import { StarkNetAddress } from "../../../src/lib/starknet/address"

describe("StarkNetAddress", () => {
  describe("from", () => {
    it("should create address from valid hex string with 0x prefix", () => {
      const address = "0x1234567890abcdef"
      const starknetAddress = StarkNetAddress.from(address)
      expect(starknetAddress).to.exist
      expect(starknetAddress.identifierHex).to.equal(
        "0000000000000000000000000000000000000000000000001234567890abcdef"
      )
    })

    it("should create address from valid hex string without 0x prefix", () => {
      const address = "1234567890abcdef"
      const starknetAddress = StarkNetAddress.from(address)
      expect(starknetAddress.identifierHex).to.equal(
        "0000000000000000000000000000000000000000000000001234567890abcdef"
      )
    })

    it("should handle mixed case addresses", () => {
      const address = "0x1234567890AbCdEf"
      const starknetAddress = StarkNetAddress.from(address)
      expect(starknetAddress.identifierHex).to.equal(
        "0000000000000000000000000000000000000000000000001234567890abcdef"
      )
    })

    it("should pad short addresses to 64 characters", () => {
      const address = "0x123"
      const starknetAddress = StarkNetAddress.from(address)
      expect(starknetAddress.identifierHex).to.have.lengthOf(64)
      expect(starknetAddress.identifierHex).to.equal(
        "0000000000000000000000000000000000000000000000000000000000000123"
      )
    })

    it("should accept maximum length addresses (64 hex chars)", () => {
      const address = "0x" + "f".repeat(64)
      const starknetAddress = StarkNetAddress.from(address)
      expect(starknetAddress.identifierHex).to.equal("f".repeat(64))
    })

    it("should throw error for invalid hex characters", () => {
      const invalidAddress = "0x123xyz"
      expect(() => StarkNetAddress.from(invalidAddress)).to.throw(
        "Invalid StarkNet address format: 0x123xyz"
      )
    })

    it("should throw error for addresses exceeding field element size", () => {
      const tooLongAddress = "0x" + "f".repeat(65)
      expect(() => StarkNetAddress.from(tooLongAddress)).to.throw(
        "StarkNet address exceeds maximum field element size: 0x" +
          "f".repeat(65)
      )
    })

    it("should throw error for empty string", () => {
      expect(() => StarkNetAddress.from("")).to.throw(
        "Invalid StarkNet address format: "
      )
    })

    it("should throw error for only 0x prefix", () => {
      expect(() => StarkNetAddress.from("0x")).to.throw(
        "Invalid StarkNet address format: 0x"
      )
    })
  })

  describe("equals", () => {
    it("should return true for identical addresses", () => {
      const address1 = StarkNetAddress.from("0x123")
      const address2 = StarkNetAddress.from("0x123")
      expect(address1.equals(address2)).to.be.true
    })

    it("should return true for same address with different formats", () => {
      const address1 = StarkNetAddress.from("0x123")
      const address2 = StarkNetAddress.from("123")
      expect(address1.equals(address2)).to.be.true
    })

    it("should return true for same address with different cases", () => {
      const address1 = StarkNetAddress.from("0xABC")
      const address2 = StarkNetAddress.from("0xabc")
      expect(address1.equals(address2)).to.be.true
    })

    it("should return false for different addresses", () => {
      const address1 = StarkNetAddress.from("0x123")
      const address2 = StarkNetAddress.from("0x456")
      expect(address1.equals(address2)).to.be.false
    })

    it("should return false when comparing with non-StarkNetAddress", () => {
      const address = StarkNetAddress.from("0x123")
      const otherValue = {
        identifierHex:
          "0000000000000000000000000000000000000000000000000000000000000123",
      }
      expect(address.equals(otherValue as any)).to.be.false
    })
  })

  describe("toBytes32", () => {
    it("should return hex string with 0x prefix", () => {
      const address = StarkNetAddress.from("0x123")
      const bytes32 = address.toBytes32()
      expect(bytes32).to.equal(
        "0x0000000000000000000000000000000000000000000000000000000000000123"
      )
    })

    it("should return properly formatted bytes32 for full address", () => {
      const address = StarkNetAddress.from("0x" + "a".repeat(64))
      const bytes32 = address.toBytes32()
      expect(bytes32).to.equal("0x" + "a".repeat(64))
    })
  })

  describe("ChainIdentifier interface", () => {
    it("should implement ChainIdentifier interface", () => {
      const address = StarkNetAddress.from("0x123")
      expect(address).to.have.property("identifierHex")
      expect(address).to.have.property("equals")
    })
  })
})
