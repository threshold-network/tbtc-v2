import { expect } from "chai"
import { SeiExtraDataEncoder } from "../../../src/lib/sei/extra-data-encoder"
import { SeiAddress } from "../../../src/lib/sei/address"
import { EthereumAddress } from "../../../src/lib/ethereum"
import { Hex } from "../../../src/lib/utils"

describe("SeiExtraDataEncoder", () => {
  let encoder: SeiExtraDataEncoder

  beforeEach(() => {
    encoder = new SeiExtraDataEncoder()
  })

  describe("encodeDepositOwner", () => {
    it("should encode a Sei address to 32-byte hex with left padding", () => {
      const address = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      const encoded = encoder.encodeDepositOwner(address)

      expect(encoded.toPrefixedString()).to.equal(
        "0x0000000000000000000000001234567890123456789012345678901234567890"
      )
    })

    it("should encode a full-length Sei address", () => {
      const address = SeiAddress.from("0x" + "f".repeat(40))
      const encoded = encoder.encodeDepositOwner(address)

      expect(encoded.toPrefixedString()).to.equal(
        "0x000000000000000000000000" + "f".repeat(40)
      )
    })

    it("should encode Sei address without 0x prefix", () => {
      const address = SeiAddress.from(
        "abcdefabcdef1234567890123456789012345678"
      )
      const encoded = encoder.encodeDepositOwner(address)

      expect(encoded.toPrefixedString()).to.equal(
        "0x000000000000000000000000abcdefabcdef1234567890123456789012345678"
      )
    })

    it("should throw error for non-Sei address", () => {
      const ethereumAddress = EthereumAddress.from(
        "0x1234567890123456789012345678901234567890"
      )

      expect(() => encoder.encodeDepositOwner(ethereumAddress)).to.throw(
        "Deposit owner must be a Sei address"
      )
    })

    it("should throw error for null input", () => {
      expect(() => encoder.encodeDepositOwner(null as any)).to.throw(
        "Deposit owner must be a Sei address"
      )
    })

    it("should throw error for undefined input", () => {
      expect(() => encoder.encodeDepositOwner(undefined as any)).to.throw(
        "Deposit owner must be a Sei address"
      )
    })
  })

  describe("decodeDepositOwner", () => {
    it("should decode valid 32-byte hex to Sei address", () => {
      const extraData = Hex.from(
        "0x0000000000000000000000001234567890123456789012345678901234567890"
      )
      const decoded = encoder.decodeDepositOwner(extraData)

      expect(decoded).to.be.instanceOf(SeiAddress)
      expect(decoded.identifierHex).to.equal(
        "1234567890123456789012345678901234567890"
      )
    })

    it("should decode full-length hex to Sei address", () => {
      const extraData = Hex.from("0x000000000000000000000000" + "f".repeat(40))
      const decoded = encoder.decodeDepositOwner(extraData)

      expect(decoded).to.be.instanceOf(SeiAddress)
      expect(decoded.identifierHex).to.equal("f".repeat(40))
    })

    it("should throw error for invalid length hex (too short)", () => {
      const shortData = Hex.from("0x1234")

      expect(() => encoder.decodeDepositOwner(shortData)).to.throw(
        "Invalid extra data length: 4. Expected 64 hex characters (32 bytes)."
      )
    })

    it("should throw error for hex longer than 32 bytes", () => {
      const longData = Hex.from("0x" + "a".repeat(66)) // 33 bytes

      expect(() => encoder.decodeDepositOwner(longData)).to.throw(
        "Invalid extra data length: 66. Expected 64 hex characters (32 bytes)."
      )
    })

    it("should throw error for empty hex", () => {
      const emptyData = Hex.from("0x")

      expect(() => encoder.decodeDepositOwner(emptyData)).to.throw(
        "Invalid extra data length: 0. Expected 64 hex characters (32 bytes)."
      )
    })
  })

  describe("round-trip encoding and decoding", () => {
    it("should correctly encode and decode the same address", () => {
      const originalAddress = SeiAddress.from(
        "0x1234567890123456789012345678901234567890"
      )
      const encoded = encoder.encodeDepositOwner(originalAddress)
      const decoded = encoder.decodeDepositOwner(encoded)

      expect(decoded.equals(originalAddress)).to.be.true
      expect(decoded.identifierHex).to.equal(originalAddress.identifierHex)
    })

    it("should handle maximum length addresses", () => {
      const originalAddress = SeiAddress.from("0x" + "f".repeat(40))
      const encoded = encoder.encodeDepositOwner(originalAddress)
      const decoded = encoder.decodeDepositOwner(encoded)

      expect(decoded.equals(originalAddress)).to.be.true
    })

    it("should handle addresses with leading zeros", () => {
      const originalAddress = SeiAddress.from(
        "0x0000000000000000000000000000000000000001"
      )
      const encoded = encoder.encodeDepositOwner(originalAddress)
      const decoded = encoder.decodeDepositOwner(encoded)

      expect(decoded.equals(originalAddress)).to.be.true
    })
  })
})
