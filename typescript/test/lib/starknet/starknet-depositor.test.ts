import { expect } from "chai"
import { StarkNetDepositor } from "../../../src/lib/starknet/starknet-depositor"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import { createMockProvider } from "./test-helpers"

describe("StarkNetDepositor", () => {
  describe("constructor", () => {
    it("should initialize with provider", () => {
      // Arrange
      const mockProvider = createMockProvider()
      const config = { chainId: "SN_MAIN" }
      
      // Act
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      
      // Assert
      expect(depositor).to.exist
      expect(depositor.getChainName()).to.equal("StarkNet")
    })

    it("should store provider reference", () => {
      // Arrange
      const mockProvider = createMockProvider()
      const config = { chainId: "SN_MAIN" }
      
      // Act
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      
      // Assert
      expect(depositor.getProvider()).to.equal(mockProvider)
    })

    it("should throw error if provider is undefined", () => {
      // Arrange
      const config = { chainId: "SN_MAIN" }
      
      // Act & Assert
      expect(() => new StarkNetDepositor(config, "StarkNet", undefined as any))
        .to.throw("Provider is required for StarkNet depositor")
    })
  })

  describe("getChainName", () => {
    it("should return the chain name passed to constructor", () => {
      // Arrange
      const mockProvider = createMockProvider()
      const config = { chainId: "SN_MAIN" }
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      
      // Act
      const chainName = depositor.getChainName()
      
      // Assert
      expect(chainName).to.equal("StarkNet")
    })
  })

  describe("setDepositOwner", () => {
    it("should accept StarkNet address as deposit owner", () => {
      // Arrange
      const mockProvider = createMockProvider()
      const config = { chainId: "SN_MAIN" }
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      const starknetAddress = StarkNetAddress.from("0x123456")
      
      // Act
      depositor.setDepositOwner(starknetAddress)
      
      // Assert
      expect(depositor.getDepositOwner()).to.equal(starknetAddress)
    })

    it("should throw error for non-StarkNet address", () => {
      // Arrange
      const mockProvider = createMockProvider()
      const config = { chainId: "SN_MAIN" }
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      const invalidAddress = { identifierHex: "0x123" } as any
      
      // Act & Assert
      expect(() => depositor.setDepositOwner(invalidAddress))
        .to.throw("Deposit owner must be a StarkNet address")
    })
  })

  describe("extraDataEncoder", () => {
    it("should provide access to extra data encoder", () => {
      // Arrange
      const mockProvider = createMockProvider()
      const config = { chainId: "SN_MAIN" }
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      const starknetAddress = StarkNetAddress.from("0x123456")
      
      // Act
      const encoder = depositor.extraDataEncoder()
      const encoded = encoder.encodeDepositOwner(starknetAddress)
      
      // Assert
      expect(encoded).to.exist
      expect(encoded.toPrefixedString()).to.match(/^0x/)
    })
  })
})