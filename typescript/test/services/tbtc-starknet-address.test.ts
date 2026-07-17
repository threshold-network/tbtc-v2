import { expect } from "chai"
import { TBTC } from "../../src/services/tbtc"

describe("StarkNet address extraction", () => {
  describe("extractStarkNetAddress", () => {
    it("should extract address from Account object", async () => {
      // Arrange
      const mockAccount = {
        address:
          "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        // other Account properties
      } as any // Cast to any for test purposes

      // Act
      const extractedAddress = await TBTC.extractStarkNetAddress(mockAccount)

      // Assert
      expect(extractedAddress).to.equal(
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      )
    })

    it("should extract address from Provider with connected account", async () => {
      // Arrange
      const mockProvider = {
        account: {
          address:
            "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        },
      } as any // Cast to any for test purposes

      // Act
      const extractedAddress = await TBTC.extractStarkNetAddress(mockProvider)

      // Assert
      expect(extractedAddress).to.equal(
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      )
    })

    it("should throw error for Provider without connected account", async () => {
      // Arrange
      const mockProvider = {
        // Provider without account property
      } as any // Cast to any for test purposes

      // Act & Assert
      await expect(
        TBTC.extractStarkNetAddress(mockProvider)
      ).to.be.rejectedWith(
        "StarkNet provider must be an Account object or Provider with connected account"
      )
    })

    it("should validate address format", async () => {
      // Arrange
      const mockAccountWithInvalidAddress = {
        address: "invalid-address",
      } as any // Cast to any for test purposes

      // Act & Assert
      await expect(
        TBTC.extractStarkNetAddress(mockAccountWithInvalidAddress)
      ).to.be.rejectedWith("Invalid StarkNet address format")
    })

    it("should handle null or undefined provider", async () => {
      // Act & Assert
      await expect(TBTC.extractStarkNetAddress(null)).to.be.rejectedWith(
        "StarkNet provider is required"
      )

      await expect(TBTC.extractStarkNetAddress(undefined)).to.be.rejectedWith(
        "StarkNet provider is required"
      )
    })

    it("should normalize address to lowercase", async () => {
      // Arrange
      const mockAccount = {
        address:
          "0x049D36570D4E46F48E99674BD3FCC84644DDD6B96F7C741B1562B82F9E004DC7",
      } as any // Cast to any for test purposes

      // Act
      const extractedAddress = await TBTC.extractStarkNetAddress(mockAccount)

      // Assert
      expect(extractedAddress).to.equal(
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      )
    })
  })
})
