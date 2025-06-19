import { expect } from "chai"
import { Provider, Account, RpcProvider } from "starknet"
import { StarkNetProvider } from "../../../src/lib/starknet/types"

describe("StarkNetProvider Types", () => {
  describe("type acceptance", () => {
    it("should accept Provider instance", () => {
      // Arrange
      const mockProvider = new RpcProvider({ nodeUrl: "http://localhost:5050" })

      // Act
      const provider: StarkNetProvider = mockProvider

      // Assert
      expect(provider).to.be.instanceOf(Provider)
      expect(provider).to.be.instanceOf(RpcProvider)
    })

    it("should accept Account instance", () => {
      // Arrange
      const mockProvider = new RpcProvider({ nodeUrl: "http://localhost:5050" })
      const mockAccount = new Account(mockProvider, "0x123", "0x456")

      // Act
      const provider: StarkNetProvider = mockAccount

      // Assert
      expect(provider).to.be.instanceOf(Account)
    })
  })

  describe("type guards", () => {
    it("should correctly identify Provider type", () => {
      // Arrange
      const mockProvider = new RpcProvider({ nodeUrl: "http://localhost:5050" })

      // Act
      const isProvider = (obj: any): obj is Provider => {
        return obj instanceof Provider
      }

      // Assert
      expect(isProvider(mockProvider)).to.be.true
    })

    it("should correctly identify Account type", () => {
      // Arrange
      const mockProvider = new RpcProvider({ nodeUrl: "http://localhost:5050" })
      const mockAccount = new Account(mockProvider, "0x123", "0x456")

      // Act
      const isAccount = (obj: any): obj is Account => {
        return obj instanceof Account
      }

      // Assert
      expect(isAccount(mockAccount)).to.be.true
    })
  })

  describe("union type compatibility", () => {
    it("should work with functions accepting StarkNetProvider", () => {
      // Arrange
      const acceptProvider = (provider: StarkNetProvider): boolean => {
        return provider !== null && provider !== undefined
      }

      const mockProvider = new RpcProvider({ nodeUrl: "http://localhost:5050" })
      const mockAccount = new Account(mockProvider, "0x123", "0x456")

      // Act & Assert
      expect(acceptProvider(mockProvider)).to.be.true
      expect(acceptProvider(mockAccount)).to.be.true
    })
  })
})
