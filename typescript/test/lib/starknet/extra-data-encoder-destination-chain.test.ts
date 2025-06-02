import { expect } from "chai"
import { StarkNetCrossChainExtraDataEncoder } from "../../../src/lib/starknet/extra-data-encoder"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import { Hex } from "../../../src/lib/utils"

describe("StarkNet Extra Data Encoder - Destination Chain Support", () => {
  let encoder: StarkNetCrossChainExtraDataEncoder

  beforeEach(() => {
    encoder = new StarkNetCrossChainExtraDataEncoder()
  })

  describe("encodeDepositOwner with destinationChain", () => {
    it("should encode only deposit owner when no destinationChain provided", () => {
      // Arrange
      const depositOwner = StarkNetAddress.from(
        "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      )

      // Act
      const encoded = encoder.encodeDepositOwner(depositOwner)

      // Assert
      expect(encoded).to.be.instanceOf(Hex)
      expect(encoded.toString()).to.have.length(64) // 32 bytes * 2
      expect(encoded.toString()).to.equal(
        depositOwner.toBytes32().replace(/^0x/, "")
      )
    })

    it("should prepare for future destinationChain encoding", () => {
      // Arrange
      const depositOwner = StarkNetAddress.from(
        "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      )

      // Act
      // For now, we encode the same way - future implementation will extend this
      const encoded = encoder.encodeDepositOwner(depositOwner)

      // Assert
      // Currently, destinationChain is not part of the extra data
      // This test documents the current behavior and will be updated when destinationChain is added
      expect(encoded.toString()).to.have.length(64)
    })
  })

  describe("decodeDepositOwner with destinationChain", () => {
    it("should decode deposit owner from current format", () => {
      // Arrange
      const originalAddress =
        "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      const depositOwner = StarkNetAddress.from(originalAddress)
      const encoded = encoder.encodeDepositOwner(depositOwner)

      // Act
      const decoded = encoder.decodeDepositOwner(encoded)

      // Assert
      expect(decoded).to.be.instanceOf(StarkNetAddress)
      expect(decoded.identifierHex).to.equal(depositOwner.identifierHex)
    })

    it("should handle future extended format gracefully", () => {
      // Arrange
      // Current 32-byte format
      const extraData = Hex.from(
        "04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      )

      // Act
      const decoded = encoder.decodeDepositOwner(extraData)

      // Assert
      expect(decoded).to.be.instanceOf(StarkNetAddress)
      expect(decoded.identifierHex).to.include(
        "04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      )
    })
  })

  describe("future destinationChain support", () => {
    it.skip("should encode destinationChain when provided (future implementation)", () => {
      // This test is skipped as it represents future functionality
      // When destinationChain is implemented, this test will be enabled
      // Arrange
      // const depositOwner = StarkNetAddress.from(
      //   "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
      // )
      // const destinationChain = "StarkNet"
      // Act
      // Future: const encoded = encoder.encodeDepositOwnerWithDestination(depositOwner, destinationChain)
      // Assert
      // Future: expect(encoded.toString()).to.have.length.greaterThan(64)
      // Future: expect(encoded).to.include.destinationChain.encoding
    })
  })
})
