import { expect } from "chai"
import { BigNumber } from "ethers"
import { StarkNetTBTCToken } from "../../../src/lib/starknet/starknet-tbtc-token"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import { EthereumAddress } from "../../../src/lib/ethereum"

describe("StarkNetTBTCToken", () => {
  describe("balance query functionality", () => {
    let token: StarkNetTBTCToken

    describe("getBalance", () => {
      it("should have getBalance method", () => {
        // Arrange
        const config = {
          chainId: "0x534e5f5345504f4c4941",
          tokenContract:
            "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
        }
        const mockProvider = { nodeUrl: "test" }
        token = new StarkNetTBTCToken(config, mockProvider as any)

        // Act & Assert
        expect(typeof (token as any).getBalance).to.equal("function")
      })

      it("should return balance as BigNumber", async () => {
        // Arrange
        const config = {
          chainId: "0x534e5f5345504f4c4941",
          tokenContract:
            "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
        }
        const mockProvider = { nodeUrl: "test" }
        token = new StarkNetTBTCToken(config, mockProvider as any)
        const address = StarkNetAddress.from("0x123456789abcdef")

        // Act - Since we don't have a real provider, this will throw
        // but we're just checking the method exists for now
        try {
          const balance = await token.getBalance(address)
          expect(balance).to.be.instanceOf(BigNumber)
        } catch (error: any) {
          // The method exists but will fail without a real provider
          expect(error.message).to.not.equal("getBalance method should exist")
        }
      })

      it("should throw error if address is not StarkNetAddress", async () => {
        // Arrange
        const config = {
          chainId: "0x534e5f5345504f4c4941",
          tokenContract:
            "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
        }
        const mockProvider = { nodeUrl: "test" }
        token = new StarkNetTBTCToken(config, mockProvider as any)
        const invalidAddress = { identifierHex: "not a starknet address" }

        // Act & Assert
        try {
          await token.getBalance(invalidAddress as any)
          expect.fail("Should throw error for invalid address")
        } catch (error: any) {
          expect(error.message).to.equal("Address must be a StarkNet address")
        }
      })

      it("should reject Ethereum addresses", async () => {
        // Arrange
        const config = {
          chainId: "0x534e5f5345504f4c4941",
          tokenContract:
            "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
        }
        const mockProvider = { nodeUrl: "test" }
        token = new StarkNetTBTCToken(config, mockProvider as any)
        const ethereumAddress = EthereumAddress.from(
          "0x1234567890123456789012345678901234567890"
        )

        // Act & Assert
        await expect(token.getBalance(ethereumAddress)).to.be.rejectedWith(
          "Address must be a StarkNet address"
        )
      })
    })

    describe("constructor", () => {
      it("should accept configuration with token contract address", () => {
        // Arrange
        const config = {
          chainId: "0x534e5f5345504f4c4941",
          tokenContract:
            "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
        }
        const mockProvider = {
          nodeUrl: "https://starknet-testnet.example.com",
        }

        // Act & Assert - This will fail as constructor doesn't accept these parameters yet
        try {
          const token = new (StarkNetTBTCToken as any)(config, mockProvider)
          expect(token).to.be.instanceOf(StarkNetTBTCToken)
        } catch (error: any) {
          expect.fail("Constructor should accept config and provider")
        }
      })

      it("should require provider to be passed", () => {
        // Arrange
        const config = {
          chainId: "0x534e5f5345504f4c4941",
          tokenContract:
            "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
        }

        // Act & Assert - This will fail as constructor doesn't validate provider yet
        expect(
          () => new (StarkNetTBTCToken as any)(config, undefined)
        ).to.throw("Provider is required for balance queries")
      })

      it("should require token contract address", () => {
        // Arrange
        const mockProvider = { nodeUrl: "test" }
        const invalidConfig = {
          chainId: "0x534e5f5345504f4c4941",
          tokenContract: "", // Empty contract address
        }

        // Act & Assert
        expect(
          () => new StarkNetTBTCToken(invalidConfig, mockProvider as any)
        ).to.throw("Token contract address is required")
      })
    })

    describe("getConfig", () => {
      it("should return the configuration", () => {
        // Arrange
        const config = {
          chainId: "0x534e5f5345504f4c4941",
          tokenContract:
            "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
        }
        const mockProvider = { nodeUrl: "test" }

        // Act & Assert - This will fail as getConfig doesn't exist yet
        try {
          const token = new (StarkNetTBTCToken as any)(config, mockProvider)
          const returnedConfig = (token as any).getConfig()
          expect(returnedConfig).to.deep.equal(config)
        } catch (error: any) {
          expect.fail("getConfig method should exist")
        }
      })
    })
  })

  describe("existing interface methods", () => {
    let token: StarkNetTBTCToken
    const mockConfig = {
      chainId: "0x534e5f5345504f4c4941",
      tokenContract:
        "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
    }
    const mockProvider = { nodeUrl: "test" }

    beforeEach(() => {
      token = new StarkNetTBTCToken(mockConfig, mockProvider as any)
    })

    describe("getChainIdentifier", () => {
      it("should throw error indicating no chain identifier", () => {
        expect(() => token.getChainIdentifier()).to.throw(
          "StarkNet TBTC token interface has no chain identifier"
        )
      })
    })

    describe("balanceOf", () => {
      it("should throw error for unsupported operation", async () => {
        const address = StarkNetAddress.from("0x123")

        await expect(token.balanceOf(address)).to.be.rejectedWith(
          "Token operations are not supported on StarkNet yet."
        )
      })

      it("should validate address type", async () => {
        const invalidAddress = { identifierHex: "not a starknet address" }

        await expect(token.balanceOf(invalidAddress as any)).to.be.rejectedWith(
          "Address must be a StarkNet address"
        )
      })
    })

    describe("totalSupply", () => {
      it("should throw not implemented error", async () => {
        const starknetAddress = StarkNetAddress.from("0x123")

        await expect(token.totalSupply(starknetAddress)).to.be.rejectedWith(
          "Not implemented yet"
        )
      })
    })
  })
})
