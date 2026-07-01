import { assert } from "chai"
import {
  isValidNttRecipient,
  normalizeNttRecipient,
} from "../../src/lib/utils/ntt"
import {
  WORMHOLE_CHAIN_IDS,
  WORMHOLE_NTT_CHAIN_IDS,
} from "../../src/lib/utils/wormhole"
import { Chains } from "../../src/lib/contracts"
import { Hex } from "../../src/lib/utils"

describe("NTT Utilities", () => {
  describe("normalizeNttRecipient", () => {
    it("should left-pad EVM addresses to bytes32", () => {
      const recipient = "0x1234567890123456789012345678901234567890"

      const normalized = normalizeNttRecipient(recipient)

      assert.equal(
        normalized.toPrefixedString(),
        "0x0000000000000000000000001234567890123456789012345678901234567890"
      )
    })

    it("should preserve full 32-byte recipients", () => {
      const recipient =
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"

      const normalized = normalizeNttRecipient(recipient)

      assert.equal(normalized.toPrefixedString(), recipient)
    })

    it("should accept Hex input", () => {
      const recipient = Hex.from("0x1234567890123456789012345678901234567890")

      const normalized = normalizeNttRecipient(recipient)

      assert.equal(normalized.toString().length, 64)
    })

    it("should throw for invalid recipient hex", () => {
      assert.throws(
        () => normalizeNttRecipient("invalid-address"),
        Error,
        "Invalid recipient hex"
      )
    })

    it("should throw for unsupported recipient length", () => {
      assert.throws(
        () => normalizeNttRecipient("0x123"),
        Error,
        "Invalid recipient length"
      )
    })
  })

  describe("isValidNttRecipient", () => {
    it("should return true for 20-byte and 32-byte recipients", () => {
      assert.isTrue(
        isValidNttRecipient("0x1234567890123456789012345678901234567890")
      )
      assert.isTrue(
        isValidNttRecipient(
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
        )
      )
    })

    it("should return false for invalid recipients", () => {
      assert.isFalse(isValidNttRecipient("invalid"))
      assert.isFalse(isValidNttRecipient("0x123"))
      assert.isFalse(isValidNttRecipient("0x" + "g".repeat(64)))
    })
  })

  describe("Wormhole chain ID constants", () => {
    it("should expose generic Wormhole chain IDs", () => {
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Arbitrum.Arbitrum], 23)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Base.Base], 30)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Optimism.Optimism], 24)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Sui.Mainnet], 21)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Solana.Solana], 1)
    })

    it("should expose NTT migration chain IDs for EVM destinations only", () => {
      assert.equal(
        WORMHOLE_NTT_CHAIN_IDS.Arbitrum.Arbitrum,
        WORMHOLE_CHAIN_IDS[Chains.Arbitrum.Arbitrum]
      )
      assert.equal(
        WORMHOLE_NTT_CHAIN_IDS.Base.Base,
        WORMHOLE_CHAIN_IDS[Chains.Base.Base]
      )
      assert.equal(
        WORMHOLE_NTT_CHAIN_IDS.Optimism.Optimism,
        WORMHOLE_CHAIN_IDS[Chains.Optimism.Optimism]
      )
      assert.isFalse("Sui" in WORMHOLE_NTT_CHAIN_IDS)
      assert.isFalse("Solana" in WORMHOLE_NTT_CHAIN_IDS)
    })
  })
})
