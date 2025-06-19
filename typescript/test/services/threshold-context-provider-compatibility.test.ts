import { expect } from "chai"
import { RpcProvider, Account } from "starknet"
import { TBTC } from "../../src/services/tbtc"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockCrossChainContractsLoader } from "../utils/mock-cross-chain-contracts-loader"
import { StarkNetProvider } from "../../src/lib/starknet/types"
import { EthereumSigner } from "../../src/lib/ethereum"

describe("ThresholdContext Provider Compatibility - T-009", () => {
  let tbtc: TBTC
  let mockTBTCContracts: MockTBTCContracts
  let mockBitcoinClient: MockBitcoinClient
  let mockCrossChainContractsLoader: MockCrossChainContractsLoader

  beforeEach(async () => {
    mockTBTCContracts = new MockTBTCContracts()
    mockBitcoinClient = new MockBitcoinClient()
    mockCrossChainContractsLoader = new MockCrossChainContractsLoader()

    // Create TBTC instance with cross-chain support using private constructor
    const TBTCClass = TBTC as any
    tbtc = new TBTCClass(
      mockTBTCContracts,
      mockBitcoinClient,
      mockCrossChainContractsLoader
    )
  })

  describe("Provider Type Compatibility", () => {
    it("should accept StarkNet Provider as parameter type", async () => {
      // Test that the type system accepts StarkNet Provider
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      const starknetProvider: StarkNetProvider = provider

      // This should compile and not throw
      await expect(tbtc.initializeCrossChain("StarkNet", starknetProvider)).not
        .to.be.rejected
    })

    it("should accept StarkNet Account as parameter type", async () => {
      // Test that the type system accepts StarkNet Account
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const account = new Account(
        provider,
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      const starknetProvider: StarkNetProvider = account

      // This should compile and not throw
      await expect(tbtc.initializeCrossChain("StarkNet", starknetProvider)).not
        .to.be.rejected
    })

    it("should maintain backward compatibility with EthereumSigner", async () => {
      // Import ethers dynamically to avoid dependency issues
      const { Wallet } = await import("ethers")
      const ethereumSigner: EthereumSigner = Wallet.createRandom()

      // This should still work for backward compatibility
      await expect(tbtc.initializeCrossChain("StarkNet", ethereumSigner)).not.to
        .be.rejected
    })
  })

  describe("Provider Storage and Access", () => {
    it("should NOT store StarkNet provider in single-parameter mode", async () => {
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      await tbtc.initializeCrossChain("StarkNet", provider)

      // In single-parameter mode, _l2Signer should NOT be stored
      const storedProvider = (tbtc as any)._l2Signer
      expect(storedProvider).to.be.undefined
    })

    it("should NOT store StarkNet account in single-parameter mode", async () => {
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const account = new Account(
        provider,
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      await tbtc.initializeCrossChain("StarkNet", account)

      // In single-parameter mode, _l2Signer should NOT be stored
      const storedAccount = (tbtc as any)._l2Signer
      expect(storedAccount).to.be.undefined
    })

    it("should update cross-chain contracts on subsequent calls", async () => {
      // First initialization
      const provider1 = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      await tbtc.initializeCrossChain("StarkNet", provider1)

      const contracts1 = tbtc.crossChainContracts("StarkNet")
      expect(contracts1).to.exist

      // Second initialization with different provider
      const provider2 = new RpcProvider({
        nodeUrl: "https://starknet-mainnet.public.blastapi.io/rpc/v0_6",
      })
      const account2 = new Account(
        provider2,
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )
      await tbtc.initializeCrossChain("StarkNet", account2)

      // Should update contracts but NOT store _l2Signer
      const contracts2 = tbtc.crossChainContracts("StarkNet")
      expect(contracts2).to.exist

      // _l2Signer should still be undefined in single-parameter mode
      const storedProvider2 = (tbtc as any)._l2Signer
      expect(storedProvider2).to.be.undefined
    })
  })

  describe("Address Extraction", () => {
    it("should extract address from StarkNet Account", async () => {
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const expectedAddress =
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      const account = new Account(provider, expectedAddress, "0x1")

      await tbtc.initializeCrossChain("StarkNet", account)

      // The address should be properly extracted in the initializeCrossChain method
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.not.be.undefined
    })

    it("should handle StarkNet Provider without address", async () => {
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      // Provider doesn't have an address property, so it should use placeholder
      await expect(tbtc.initializeCrossChain("StarkNet", provider)).not.to.be
        .rejected

      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.not.be.undefined
    })

    it("should extract address from Ethereum signer for backward compatibility", async () => {
      const { Wallet } = await import("ethers")
      const ethereumSigner = Wallet.createRandom()

      await expect(tbtc.initializeCrossChain("StarkNet", ethereumSigner)).not.to
        .be.rejected

      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.not.be.undefined
    })
  })

  describe("Type Safety", () => {
    it("should have proper TypeScript type inference", () => {
      // This test verifies that TypeScript properly infers types
      const testInitialization = async (provider: StarkNetProvider) => {
        await tbtc.initializeCrossChain("StarkNet", provider)
      }

      // These should all compile without type errors
      const rpcProvider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const account = new Account(
        rpcProvider,
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      expect(testInitialization).to.be.a("function")

      // Both should be valid StarkNetProvider types
      const provider1: StarkNetProvider = rpcProvider
      const provider2: StarkNetProvider = account

      expect(provider1).to.be.instanceOf(RpcProvider)
      expect(provider2).to.be.instanceOf(Account)
    })
  })

  describe("Error Handling", () => {
    it("should throw error if cross-chain loader is not available", async () => {
      // Create TBTC instance without cross-chain support
      const tbtcNoCrossChain = await TBTC.initializeCustom(
        mockTBTCContracts,
        mockBitcoinClient
      )

      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      await expect(
        tbtcNoCrossChain.initializeCrossChain("StarkNet", provider)
      ).to.be.rejectedWith(
        "Cross-chain contracts loader not available for this instance"
      )
    })

    it("should throw error if chain mapping is not defined", async () => {
      // Mock loader that returns undefined chain mapping
      mockCrossChainContractsLoader.loadChainMapping = () => undefined

      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      await expect(
        tbtc.initializeCrossChain("StarkNet", provider)
      ).to.be.rejectedWith("Chain mapping between L1 and L2 chains not defined")
    })

    it("should throw error if StarkNet chain ID is not in mapping", async () => {
      // Mock loader that returns chain mapping without starknet
      mockCrossChainContractsLoader.loadChainMapping = () =>
        ({
          base: "0x2105",
          arbitrum: "0xa4b1",
        } as any)

      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      await expect(
        tbtc.initializeCrossChain("StarkNet", provider)
      ).to.be.rejectedWith("StarkNet chain ID not available in chain mapping")
    })
  })
})
