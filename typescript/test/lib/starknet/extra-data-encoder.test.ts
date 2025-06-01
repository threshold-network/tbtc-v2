import { expect } from "chai"
import { StarkNetCrossChainExtraDataEncoder } from "../../../src/lib/starknet/extra-data-encoder"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import { EthereumAddress } from "../../../src/lib/ethereum"
import { Hex } from "../../../src/lib/utils"

describe("StarkNetCrossChainExtraDataEncoder", () => {
  let encoder: StarkNetCrossChainExtraDataEncoder

  beforeEach(() => {
    encoder = new StarkNetCrossChainExtraDataEncoder()
  })

  describe("encodeDepositOwner", () => {
    it("should encode a StarkNet address to 32-byte hex", () => {
      const address = StarkNetAddress.from("0x1234567890abcdef")
      const encoded = encoder.encodeDepositOwner(address)

      expect(encoded.toPrefixedString()).to.equal(
        "0x0000000000000000000000000000000000000000000000001234567890abcdef"
      )
    })

    it("should encode a full-length StarkNet address", () => {
      const address = StarkNetAddress.from("0x" + "f".repeat(64))
      const encoded = encoder.encodeDepositOwner(address)

      expect(encoded.toPrefixedString()).to.equal("0x" + "f".repeat(64))
    })

    it("should encode a short StarkNet address with proper padding", () => {
      const address = StarkNetAddress.from("0x123")
      const encoded = encoder.encodeDepositOwner(address)

      expect(encoded.toPrefixedString()).to.equal(
        "0x0000000000000000000000000000000000000000000000000000000000000123"
      )
    })

    it("should encode StarkNet address without 0x prefix", () => {
      const address = StarkNetAddress.from("abcdef123456")
      const encoded = encoder.encodeDepositOwner(address)

      expect(encoded.toPrefixedString()).to.equal(
        "0x0000000000000000000000000000000000000000000000000000abcdef123456"
      )
    })

    it("should throw error for non-StarkNet address", () => {
      const ethereumAddress = EthereumAddress.from(
        "0x1234567890123456789012345678901234567890"
      )

      expect(() => encoder.encodeDepositOwner(ethereumAddress)).to.throw(
        "Deposit owner must be a StarkNet address"
      )
    })

    it("should throw error for null input", () => {
      expect(() => encoder.encodeDepositOwner(null as any)).to.throw(
        "Deposit owner must be a StarkNet address"
      )
    })

    it("should throw error for undefined input", () => {
      expect(() => encoder.encodeDepositOwner(undefined as any)).to.throw(
        "Deposit owner must be a StarkNet address"
      )
    })
  })

  describe("decodeDepositOwner", () => {
    it("should decode valid 32-byte hex to StarkNet address", () => {
      const extraData = Hex.from(
        "0x0000000000000000000000000000000000000000000000001234567890abcdef"
      )
      const decoded = encoder.decodeDepositOwner(extraData)

      expect(decoded).to.be.instanceOf(StarkNetAddress)
      expect(decoded.identifierHex).to.equal(
        "0000000000000000000000000000000000000000000000001234567890abcdef"
      )
    })

    it("should decode full-length hex to StarkNet address", () => {
      const extraData = Hex.from("0x" + "f".repeat(64))
      const decoded = encoder.decodeDepositOwner(extraData)

      expect(decoded).to.be.instanceOf(StarkNetAddress)
      expect(decoded.identifierHex).to.equal("f".repeat(64))
    })

    it("should throw error for invalid length hex", () => {
      const shortData = Hex.from("0x1234")

      expect(() => encoder.decodeDepositOwner(shortData)).to.throw(
        "Invalid extra data length for StarkNet. Expected 32 bytes but got 2"
      )
    })

    it("should throw error for hex longer than 32 bytes", () => {
      const longData = Hex.from("0x" + "a".repeat(66)) // 33 bytes

      expect(() => encoder.decodeDepositOwner(longData)).to.throw(
        "Invalid extra data length for StarkNet. Expected 32 bytes but got 33"
      )
    })

    it("should throw error for empty hex", () => {
      const emptyData = Hex.from("0x")

      expect(() => encoder.decodeDepositOwner(emptyData)).to.throw(
        "Invalid extra data length for StarkNet. Expected 32 bytes but got 0"
      )
    })

    it("should throw error for null input", () => {
      expect(() => encoder.decodeDepositOwner(null as any)).to.throw(
        "Extra data is required"
      )
    })

    it("should throw error for undefined input", () => {
      expect(() => encoder.decodeDepositOwner(undefined as any)).to.throw(
        "Extra data is required"
      )
    })
  })

  describe("round-trip encoding and decoding", () => {
    it("should correctly encode and decode the same address", () => {
      const originalAddress = StarkNetAddress.from("0x123abc")
      const encoded = encoder.encodeDepositOwner(originalAddress)
      const decoded = encoder.decodeDepositOwner(encoded)

      expect(decoded.equals(originalAddress)).to.be.true
      expect(decoded.identifierHex).to.equal(originalAddress.identifierHex)
    })

    it("should handle maximum length addresses", () => {
      const originalAddress = StarkNetAddress.from("0x" + "e".repeat(64))
      const encoded = encoder.encodeDepositOwner(originalAddress)
      const decoded = encoder.decodeDepositOwner(encoded)

      expect(decoded.equals(originalAddress)).to.be.true
    })

    it("should handle minimum length addresses", () => {
      const originalAddress = StarkNetAddress.from("0x1")
      const encoded = encoder.encodeDepositOwner(originalAddress)
      const decoded = encoder.decodeDepositOwner(encoded)

      expect(decoded.equals(originalAddress)).to.be.true
    })
  })
})
