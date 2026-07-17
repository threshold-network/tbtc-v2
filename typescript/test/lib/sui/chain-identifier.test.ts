import { expect } from "chai"
import { SuiAddress } from "../../../src/lib/sui"

describe("SUI Chain Identifier", () => {
  describe("SuiAddress", () => {
    describe("constructor", () => {
      it("should create address from valid 32-byte hex string with 0x prefix", () => {
        const validAddress = "0x" + "a".repeat(64)
        const suiAddress = new SuiAddress(validAddress)
        expect(suiAddress.identifierHex).to.equal("a".repeat(64))
      })

      it("should handle mixed case addresses", () => {
        const mixedCaseAddress = "0x" + "AaBbCcDd".repeat(8)
        const suiAddress = new SuiAddress(mixedCaseAddress)
        expect(suiAddress.identifierHex).to.equal("aabbccdd".repeat(8))
      })

      it("should throw for addresses without 0x prefix", () => {
        const invalidAddress = "a".repeat(64)
        expect(() => new SuiAddress(invalidAddress)).to.throw(
          "Invalid SUI address format"
        )
      })

      it("should throw for addresses shorter than 64 hex chars", () => {
        const shortAddress = "0x" + "a".repeat(63)
        expect(() => new SuiAddress(shortAddress)).to.throw(
          "Invalid SUI address format"
        )
      })

      it("should throw for addresses longer than 64 hex chars", () => {
        const longAddress = "0x" + "a".repeat(65)
        expect(() => new SuiAddress(longAddress)).to.throw(
          "Invalid SUI address format"
        )
      })

      it("should throw for addresses with invalid hex characters", () => {
        const invalidHexAddress = "0x" + "g".repeat(64)
        expect(() => new SuiAddress(invalidHexAddress)).to.throw(
          "Invalid SUI address format"
        )
      })

      it("should throw for empty string", () => {
        expect(() => new SuiAddress("")).to.throw("Invalid SUI address format")
      })

      it("should throw for only 0x prefix", () => {
        expect(() => new SuiAddress("0x")).to.throw(
          "Invalid SUI address format"
        )
      })
    })

    describe("from", () => {
      it("should create address using static from method", () => {
        const validAddress = "0x" + "b".repeat(64)
        const suiAddress = SuiAddress.from(validAddress)
        expect(suiAddress.identifierHex).to.equal("b".repeat(64))
      })
    })

    describe("equals", () => {
      it("should return true for identical addresses", () => {
        const address1 = "0x" + "c".repeat(64)
        const suiAddress1 = new SuiAddress(address1)
        const suiAddress2 = new SuiAddress(address1)
        expect(suiAddress1.equals(suiAddress2)).to.be.true
      })

      it("should return true for same address with different cases", () => {
        const address1 = "0x" + "ABC".repeat(21) + "D"
        const address2 = "0x" + "abc".repeat(21) + "d"
        const suiAddress1 = new SuiAddress(address1)
        const suiAddress2 = new SuiAddress(address2)
        expect(suiAddress1.equals(suiAddress2)).to.be.true
      })

      it("should return false for different addresses", () => {
        const address1 = "0x" + "1".repeat(64)
        const address2 = "0x" + "2".repeat(64)
        const suiAddress1 = new SuiAddress(address1)
        const suiAddress2 = new SuiAddress(address2)
        expect(suiAddress1.equals(suiAddress2)).to.be.false
      })
    })
  })
})
