import { expect } from "chai"

describe("StarkNet.js Integration", () => {
  it("should import Provider from starknet", () => {
    // Arrange
    let importError: Error | null = null

    // Act
    try {
      const starknet = require("starknet")
      expect(starknet.Provider).to.exist
    } catch (error) {
      importError = error as Error
    }

    // Assert
    expect(importError).to.be.null
  })

  it("should import Account from starknet", () => {
    // Arrange
    let importError: Error | null = null

    // Act
    try {
      const starknet = require("starknet")
      expect(starknet.Account).to.exist
    } catch (error) {
      importError = error as Error
    }

    // Assert
    expect(importError).to.be.null
  })

  it("should import Contract from starknet", () => {
    // Arrange
    let importError: Error | null = null

    // Act
    try {
      const starknet = require("starknet")
      expect(starknet.Contract).to.exist
    } catch (error) {
      importError = error as Error
    }

    // Assert
    expect(importError).to.be.null
  })
})
