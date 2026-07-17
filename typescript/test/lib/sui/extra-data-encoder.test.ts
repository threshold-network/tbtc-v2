import { expect } from "chai"
import { SuiExtraDataEncoder, SuiAddress } from "../../../src/lib/sui"
import { Hex } from "../../../src/lib/utils"

describe("SUI Extra Data Encoder", () => {
  let encoder: SuiExtraDataEncoder

  beforeEach(() => {
    encoder = new SuiExtraDataEncoder()
  })

  describe("encodeDepositOwner", () => {
    it("should encode a valid SUI address", () => {
      const address = "0x" + "1234567890abcdef".repeat(4)
      const suiAddress = SuiAddress.from(address)

      const encoded = encoder.encodeDepositOwner(suiAddress)

      // Hex.toString() returns unprefixed hex, use toPrefixedString() for prefixed
      expect(encoded.toString()).to.equal(address.toLowerCase().substring(2))
      expect(encoded.toPrefixedString()).to.equal(address.toLowerCase())
    })

    it("should handle addresses with mixed case", () => {
      const address = "0x" + "ABCDef1234567890".repeat(4)
      const suiAddress = SuiAddress.from(address)

      const encoded = encoder.encodeDepositOwner(suiAddress)

      // Hex.toString() returns unprefixed hex, use toPrefixedString() for prefixed
      expect(encoded.toString()).to.equal(address.toLowerCase().substring(2))
      expect(encoded.toPrefixedString()).to.equal(address.toLowerCase())
    })
  })

  describe("decodeDepositOwner", () => {
    it("should decode a 32-byte hex string to SUI address", () => {
      const originalAddress = "0x" + "fedcba0987654321".repeat(4)
      const extraData = Hex.from(originalAddress)

      const decoded = encoder.decodeDepositOwner(extraData)

      expect(decoded).to.be.instanceOf(SuiAddress)
      expect(decoded.identifierHex).to.equal(
        originalAddress.toLowerCase().substring(2)
      )
    })

    it("should handle hex strings without 0x prefix", () => {
      const addressWithoutPrefix = "abcdef1234567890".repeat(4)
      const extraData = Hex.from(addressWithoutPrefix)

      const decoded = encoder.decodeDepositOwner(extraData)

      expect(decoded.identifierHex).to.equal(addressWithoutPrefix.toLowerCase())
    })

    it("should throw for invalid length extra data", () => {
      const shortData = Hex.from("0x" + "aa".repeat(31))

      expect(() => encoder.decodeDepositOwner(shortData)).to.throw(
        "Invalid SUI address format"
      )
    })
  })

  describe("round trip encoding/decoding", () => {
    it("should preserve the address through encode/decode cycle", () => {
      const originalAddress = "0x" + "0123456789abcdef".repeat(4)
      const suiAddress = SuiAddress.from(originalAddress)

      const encoded = encoder.encodeDepositOwner(suiAddress)
      const decoded = encoder.decodeDepositOwner(encoded)

      expect(decoded.equals(suiAddress)).to.be.true
    })
  })
})
