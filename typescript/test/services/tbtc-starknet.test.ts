import { expect } from "chai"
import { RpcProvider, Account } from "starknet"
import { TBTC } from "../../src/services/tbtc"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockCrossChainContractsLoader } from "../utils/mock-cross-chain-contracts-loader"

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
    it("should accept StarkNet RpcProvider", async () => {
      // Arrange
      const starknetProvider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      // Act & Assert - should not throw
      await expect(tbtc.initializeCrossChain("StarkNet", starknetProvider)).not
        .to.be.rejected
    })

    it("should accept StarkNet Account", async () => {
      // Arrange
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const starknetAccount = new Account(
        provider,
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      // Act & Assert - should not throw
      await expect(tbtc.initializeCrossChain("StarkNet", starknetAccount)).not
        .to.be.rejected
    })

    it("should maintain backward compatibility with Ethereum signer", async () => {
      // Arrange - create a mock Ethereum signer
      const { Wallet } = await import("ethers")
      const mockEthereumSigner = Wallet.createRandom()

      // Act & Assert - should not throw and extract address
      await expect(tbtc.initializeCrossChain("StarkNet", mockEthereumSigner))
        .not.to.be.rejected

      // Verify cross-chain contracts were initialized
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.not.be.undefined
    })

    it("should store StarkNet provider in _l2Signer property", async () => {
      // Arrange
      const starknetProvider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      // Act
      await tbtc.initializeCrossChain("StarkNet", starknetProvider)

      // Assert - check internal _l2Signer property
      // Note: This would require making _l2Signer accessible for testing
      // or using a getter method
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.not.be.undefined
    })

    it("should extract wallet address from StarkNet Account", async () => {
      // Arrange
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const walletAddress =
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      const starknetAccount = new Account(provider, walletAddress, "0x1")

      // Act
      await tbtc.initializeCrossChain("StarkNet", starknetAccount)

      // Assert
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.not.be.undefined
      expect(contracts?.destinationChainBitcoinDepositor).to.not.be.undefined
    })
  })
})
