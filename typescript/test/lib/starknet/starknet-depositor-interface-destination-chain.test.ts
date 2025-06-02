import { expect } from "chai"
import { StarkNetDepositorInterface } from "../../../src/lib/starknet/starknet-depositor-interface"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import { Hex } from "../../../src/lib/utils"

describe("StarkNet Depositor Interface - Destination Chain Support", () => {
  let depositor: StarkNetDepositorInterface
  let mockDepositOwner: StarkNetAddress

  beforeEach(() => {
    depositor = new StarkNetDepositorInterface()
    mockDepositOwner = StarkNetAddress.from(
      "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
    )
    depositor.setDepositOwner(mockDepositOwner)
  })

  describe("destinationChain preparation", () => {
    it("should prepare extra data for current system", () => {
      // Arrange
      const encoder = depositor.extraDataEncoder()

      // Act
      const encoded = encoder.encodeDepositOwner(mockDepositOwner)

      // Assert
      expect(encoded).to.be.instanceOf(Hex)
      expect(encoded.toString()).to.have.length(64) // 32 bytes * 2

      // The encoded data is self-describing:
      // - 32 bytes = StarkNet address (felt252)
      // This allows the relayer to determine the destination chain
    })

    it("should encode StarkNet addresses as 32-byte values", () => {
      // This test documents how StarkNet addresses are encoded
      // for the cross-chain deposit system

      // Arrange
      const encoder = depositor.extraDataEncoder()
      const testAddresses = [
        "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      ]

      // Act & Assert
      testAddresses.forEach((addr) => {
        const starknetAddr = StarkNetAddress.from(addr)
        const encoded = encoder.encodeDepositOwner(starknetAddr)

        expect(encoded.toBuffer().length).to.equal(32)
        expect(encoded.toString()).to.equal(
          starknetAddr.toBytes32().replace(/^0x/, "")
        )
      })
    })

    it("should decode StarkNet addresses from extra data", () => {
      // Arrange
      const encoder = depositor.extraDataEncoder()
      const originalAddress = mockDepositOwner

      // Act
      const encoded = encoder.encodeDepositOwner(originalAddress)
      const decoded = encoder.decodeDepositOwner(encoded)

      // Assert
      expect(decoded).to.be.instanceOf(StarkNetAddress)
      expect(decoded.identifierHex).to.equal(originalAddress.identifierHex)
    })
  })

  describe("future destinationChain support", () => {
    it("documents current behavior without destinationChain parameter", () => {
      // Current behavior: The CrossChainExtraDataEncoder interface
      // only has encodeDepositOwner(depositOwner) without destinationChain

      const encoder = depositor.extraDataEncoder()
      const encoded = encoder.encodeDepositOwner(mockDepositOwner)

      // The destination chain is implicit based on:
      // 1. The encoder implementation (StarkNetCrossChainExtraDataEncoder)
      // 2. The address format (32-byte felt252 for StarkNet)
      expect(encoded).to.be.instanceOf(Hex)
    })

    it.skip("should support destinationChain in the future", () => {
      // This test is skipped as it represents future functionality
      // When implemented, the encoder might have an extended interface:
      // encodeDepositOwnerWithDestination(depositOwner, destinationChain)
      // Or the relayer payload might include:
      // {
      //   fundingTx: {...},
      //   reveal: {...},
      //   l2DepositOwner: "0x...",
      //   l2Sender: "0x...",
      //   destinationChain: "StarkNet"  // <-- Future field
      // }
    })
  })

  describe("chain detection compatibility", () => {
    it("should maintain compatibility with address-based chain detection", () => {
      // The current system uses address format to determine chain:
      // - Ethereum: 20-byte addresses padded to 32 bytes (12 zero bytes prefix)
      // - Solana: 32-byte addresses (base58 encoded in original format)
      // - StarkNet: 32-byte addresses (felt252 field elements)

      const encoder = depositor.extraDataEncoder()
      const encoded = encoder.encodeDepositOwner(mockDepositOwner)

      // StarkNet addresses are 32 bytes without padding
      const buffer = encoded.toBuffer()
      expect(buffer.length).to.equal(32)

      // Not Ethereum (would have 12 zero bytes at start)
      const first12Bytes = buffer.subarray(0, 12)
      const isEthereum = first12Bytes.every((b) => b === 0)
      expect(isEthereum).to.be.false
    })
  })
})
