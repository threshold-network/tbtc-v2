import { assert } from "chai"
import {
  encodeDestinationReceiver,
  decodeDestinationReceiver,
  isValidEncodedReceiver,
  getChainIdFromEncodedReceiver,
  getRecipientFromEncodedReceiver,
} from "../../src/lib/utils/ntt"
import {
  WORMHOLE_CHAIN_IDS,
  WORMHOLE_NTT_CHAIN_IDS,
} from "../../src/lib/utils/wormhole"
import { Chains } from "../../src/lib/contracts"

const TEST_WORMHOLE_CHAIN_ID = 10002

describe("NTT Utilities", () => {
  describe("encodeDestinationReceiver", () => {
    it("should encode chain ID and recipient correctly", () => {
      const chainId = TEST_WORMHOLE_CHAIN_ID
      const recipient = "0x1234567890123456789012345678901234567890"

      const encoded = encodeDestinationReceiver(chainId, recipient)

      // Should be 32 bytes (64 hex characters)
      assert.equal(encoded.toString().length, 64)
      assert.equal(encoded.toPrefixedString().length, 66) // with 0x prefix
    })

    it("should handle edge cases", () => {
      // Maximum chain ID
      const maxChainId = 65535
      const recipient = "0x1234567890123456789012345678901234567890"

      const encoded = encodeDestinationReceiver(maxChainId, recipient)
      assert.equal(encoded.toString().length, 64)

      // Zero chain ID
      const zeroChainId = 0
      const encodedZero = encodeDestinationReceiver(zeroChainId, recipient)
      assert.equal(encodedZero.toString().length, 64)
    })

    it("should throw error for invalid chain ID", () => {
      const recipient = "0x1234567890123456789012345678901234567890"

      assert.throws(
        () => encodeDestinationReceiver(-1, recipient),
        Error,
        "Chain ID must be between 0 and 65535"
      )

      assert.throws(
        () => encodeDestinationReceiver(65536, recipient),
        Error,
        "Chain ID must be between 0 and 65535"
      )
    })

    it("should throw error for invalid recipient address", () => {
      const chainId = TEST_WORMHOLE_CHAIN_ID

      assert.throws(
        () => encodeDestinationReceiver(chainId, "invalid-address"),
        Error,
        "Invalid recipient address format"
      )

      assert.throws(
        () => encodeDestinationReceiver(chainId, "0x123"),
        Error,
        "Invalid recipient address format"
      )
    })
  })

  describe("decodeDestinationReceiver", () => {
    it("should decode encoded data correctly", () => {
      const chainId = TEST_WORMHOLE_CHAIN_ID
      const recipient = "0x1234567890123456789012345678901234567890"

      const encoded = encodeDestinationReceiver(chainId, recipient)
      const decoded = decodeDestinationReceiver(encoded)

      assert.equal(decoded.chainId, chainId)
      assert.equal(decoded.recipient, recipient)
    })

    it("should work with string input", () => {
      const chainId = TEST_WORMHOLE_CHAIN_ID
      const recipient = "0x1234567890123456789012345678901234567890"

      const encoded = encodeDestinationReceiver(chainId, recipient)
      const encodedString = encoded.toPrefixedString()
      const decoded = decodeDestinationReceiver(encodedString)

      assert.equal(decoded.chainId, chainId)
      assert.equal(decoded.recipient, recipient)
    })

    it("should handle edge cases", () => {
      // Maximum chain ID
      const maxChainId = 65535
      const recipient = "0x1234567890123456789012345678901234567890"

      const encoded = encodeDestinationReceiver(maxChainId, recipient)
      const decoded = decodeDestinationReceiver(encoded)

      assert.equal(decoded.chainId, maxChainId)
      assert.equal(decoded.recipient, recipient)

      // Zero chain ID
      const zeroChainId = 0
      const encodedZero = encodeDestinationReceiver(zeroChainId, recipient)
      const decodedZero = decodeDestinationReceiver(encodedZero)

      assert.equal(decodedZero.chainId, zeroChainId)
      assert.equal(decodedZero.recipient, recipient)
    })

    it("should throw error for invalid encoded data", () => {
      assert.throws(
        () => decodeDestinationReceiver("invalid"),
        Error,
        "Invalid encoded receiver length"
      )

      assert.throws(
        () => decodeDestinationReceiver("0x123"),
        Error,
        "Invalid encoded receiver length"
      )
    })
  })

  describe("isValidEncodedReceiver", () => {
    it("should return true for valid encoded data", () => {
      const chainId = TEST_WORMHOLE_CHAIN_ID
      const recipient = "0x1234567890123456789012345678901234567890"

      const encoded = encodeDestinationReceiver(chainId, recipient)

      assert.isTrue(isValidEncodedReceiver(encoded))
      assert.isTrue(isValidEncodedReceiver(encoded.toPrefixedString()))
    })

    it("should return false for invalid data", () => {
      assert.isFalse(isValidEncodedReceiver("invalid"))
      assert.isFalse(isValidEncodedReceiver("0x123"))
      assert.isFalse(isValidEncodedReceiver("0x" + "a".repeat(63))) // 63 chars
      assert.isFalse(isValidEncodedReceiver("0x" + "g".repeat(64))) // invalid hex
    })
  })

  describe("getChainIdFromEncodedReceiver", () => {
    it("should extract chain ID correctly", () => {
      const chainId = TEST_WORMHOLE_CHAIN_ID
      const recipient = "0x1234567890123456789012345678901234567890"

      const encoded = encodeDestinationReceiver(chainId, recipient)
      const extractedChainId = getChainIdFromEncodedReceiver(encoded)

      assert.equal(extractedChainId, chainId)
    })

    it("should work with string input", () => {
      const chainId = TEST_WORMHOLE_CHAIN_ID
      const recipient = "0x1234567890123456789012345678901234567890"

      const encoded = encodeDestinationReceiver(chainId, recipient)
      const extractedChainId = getChainIdFromEncodedReceiver(
        encoded.toPrefixedString()
      )

      assert.equal(extractedChainId, chainId)
    })

    it("should throw error for invalid data", () => {
      assert.throws(
        () => getChainIdFromEncodedReceiver("invalid"),
        Error,
        "Invalid encoded receiver length"
      )
    })
  })

  describe("getRecipientFromEncodedReceiver", () => {
    it("should extract recipient correctly", () => {
      const chainId = TEST_WORMHOLE_CHAIN_ID
      const recipient = "0x1234567890123456789012345678901234567890"

      const encoded = encodeDestinationReceiver(chainId, recipient)
      const extractedRecipient = getRecipientFromEncodedReceiver(encoded)

      assert.equal(extractedRecipient, recipient)
    })

    it("should work with string input", () => {
      const chainId = TEST_WORMHOLE_CHAIN_ID
      const recipient = "0x1234567890123456789012345678901234567890"

      const encoded = encodeDestinationReceiver(chainId, recipient)
      const extractedRecipient = getRecipientFromEncodedReceiver(
        encoded.toPrefixedString()
      )

      assert.equal(extractedRecipient, recipient)
    })

    it("should throw error for invalid data", () => {
      assert.throws(
        () => getRecipientFromEncodedReceiver("invalid"),
        Error,
        "Invalid encoded receiver length"
      )
    })
  })

  describe("round-trip encoding/decoding", () => {
    const testCases = [
      { chainId: 0, recipient: "0x0000000000000000000000000000000000000000" },
      {
        chainId: TEST_WORMHOLE_CHAIN_ID,
        recipient: "0x1234567890123456789012345678901234567890",
      },
      {
        chainId: 65535,
        recipient: "0xffffffffffffffffffffffffffffffffffffffff",
      },
      { chainId: 1, recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" },
    ]

    testCases.forEach(({ chainId, recipient }) => {
      it(`should round-trip chainId=${chainId}, recipient=${recipient}`, () => {
        const encoded = encodeDestinationReceiver(chainId, recipient)
        const decoded = decodeDestinationReceiver(encoded)

        assert.equal(decoded.chainId, chainId)
        assert.equal(decoded.recipient, recipient)
      })
    })
  })

  describe("Wormhole chain ID constants", () => {
    it("should expose NTT migration target chain IDs", () => {
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Arbitrum.Arbitrum], 23)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Base.Base], 30)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Optimism.Optimism], 24)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Sui.Mainnet], 21)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Solana.Solana], 1)
    })

    it("should expose NTT migration testnet chain IDs", () => {
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Arbitrum.ArbitrumSepolia], 10003)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Base.BaseSepolia], 10004)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Optimism.OptimismSepolia], 10005)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Sui.Testnet], 21)
      assert.equal(WORMHOLE_CHAIN_IDS[Chains.Solana.Devnet], 1)
    })

    it("should keep the NTT chain ID alias backed by the primary map", () => {
      assert.equal(
        WORMHOLE_NTT_CHAIN_IDS.Optimism.Optimism,
        WORMHOLE_CHAIN_IDS[Chains.Optimism.Optimism]
      )
    })
  })
})
