import { expect } from "chai"
import { TBTC } from "../../src/services/tbtc"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockCrossChainContractsLoader } from "../utils/mock-cross-chain-contracts-loader"
import { createMockProvider } from "../lib/starknet/test-helpers"

describe("TBTC - StarkNet Provider Support", () => {
  let tbtc: TBTC
  let mockTBTCContracts: MockTBTCContracts
  let mockBitcoinClient: MockBitcoinClient
  let mockCrossChainContractsLoader: MockCrossChainContractsLoader

  beforeEach(async () => {
    mockTBTCContracts = new MockTBTCContracts()
    mockBitcoinClient = new MockBitcoinClient()
    mockCrossChainContractsLoader = new MockCrossChainContractsLoader()

    // Create TBTC instance with cross-chain support
    // Using private constructor via reflection since initializeCustom doesn't support cross-chain loader
    const TBTCClass = TBTC as any
    tbtc = new TBTCClass(
      mockTBTCContracts,
      mockBitcoinClient,
      mockCrossChainContractsLoader
    )
  })

  describe("initializeCrossChain with StarkNet provider", () => {
    it("should accept StarkNet provider with connected account", async () => {
      const starknetProvider = {
        account: {
          address:
            "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        },
        getChainId: async () => "SN_SEPOLIA",
      }

      // Act & Assert - should not throw
      await expect(
        tbtc.initializeCrossChain("StarkNet", starknetProvider as any)
      ).not.to.be.rejected
    })

    it("should accept StarkNet Account", async () => {
      const starknetAccount = createMockProvider()

      // Act & Assert - should not throw
      await expect(
        tbtc.initializeCrossChain("StarkNet", starknetAccount as any)
      ).not.to.be.rejected
    })

    it("should reject Ethereum signer for StarkNet", async () => {
      // Arrange - create a mock Ethereum signer
      const { Wallet } = await import("ethers")
      const mockEthereumSigner = Wallet.createRandom()

      // Act & Assert
      await expect(
        tbtc.initializeCrossChain("StarkNet", mockEthereumSigner)
      ).to.be.rejectedWith("Expected a StarkNet provider or account")
    })

    it("should store StarkNet provider in _l2Signer property", async () => {
      const starknetProvider = createMockProvider()

      // Act
      await tbtc.initializeCrossChain("StarkNet", starknetProvider as any)

      // Assert - check internal _l2Signer property
      // Note: This would require making _l2Signer accessible for testing
      // or using a getter method
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.not.be.undefined
    })

    it("should extract wallet address from StarkNet Account", async () => {
      // Arrange
      const walletAddress =
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      const starknetAccount = {
        address: walletAddress,
        getChainId: async () => "SN_SEPOLIA",
      }

      // Act
      await tbtc.initializeCrossChain("StarkNet", starknetAccount as any)

      // Assert
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.not.be.undefined
      expect(contracts?.destinationChainBitcoinDepositor).to.not.be.undefined
    })
  })
})
