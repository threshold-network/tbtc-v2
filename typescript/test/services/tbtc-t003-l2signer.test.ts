import { expect } from "chai"
import { RpcProvider, Account } from "starknet"
import { Wallet } from "ethers"
import { TBTC } from "../../src/services/tbtc"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockCrossChainContractsLoader } from "../utils/mock-cross-chain-contracts-loader"

describe("TBTC T-003: _l2Signer Storage Behavior", () => {
  let tbtc: TBTC
  let mockTBTCContracts: MockTBTCContracts
  let mockBitcoinClient: MockBitcoinClient
  let mockCrossChainContractsLoader: MockCrossChainContractsLoader

  beforeEach(async () => {
    mockTBTCContracts = new MockTBTCContracts()
    mockBitcoinClient = new MockBitcoinClient()
    mockCrossChainContractsLoader = new MockCrossChainContractsLoader()

    // Create TBTC instance with cross-chain support
    const TBTCClass = TBTC as any
    tbtc = new TBTCClass(
      mockTBTCContracts,
      mockBitcoinClient,
      mockCrossChainContractsLoader
    )
  })

  describe("Single-Parameter Mode", () => {
    it("should not store _l2Signer in single-parameter mode for StarkNet", async () => {
      // Arrange
      const mockProvider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const mockAccount = new Account(
        mockProvider,
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      // Act
      await tbtc.initializeCrossChain("StarkNet", mockAccount)

      // Assert
      expect(tbtc._l2Signer).to.be.undefined
    })

    it("should not store _l2Signer when using Provider with connected account", async () => {
      // Arrange
      const mockProvider = {
        account: {
          address:
            "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        },
        getChainId: async () => "0x534e5f5345504f4c4941", // SN_SEPOLIA
      }

      // Act
      await tbtc.initializeCrossChain("StarkNet", mockProvider as any)

      // Assert
      expect(tbtc._l2Signer).to.be.undefined
    })

    it("should not store _l2Signer even with Provider-only (backward compatibility)", async () => {
      // Arrange
      const mockProvider = {
        getChainId: async () => "0x534e5f5345504f4c4941", // SN_SEPOLIA
      }

      // Act
      await tbtc.initializeCrossChain("StarkNet", mockProvider as any)

      // Assert
      expect(tbtc._l2Signer).to.be.undefined
    })
  })

  describe("Two-Parameter Mode (Deprecated)", () => {
    it("should reject two-parameter mode completely", async () => {
      // Arrange
      const mockEthSigner = Wallet.createRandom()
      const mockStarkNetProvider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      // Act & Assert
      await expect(
        tbtc.initializeCrossChain(
          "StarkNet",
          mockEthSigner,
          mockStarkNetProvider
        )
      ).to.be.rejectedWith(
        "StarkNet does not support two-parameter initialization"
      )
    })
  })

  describe("Other L2 Chains", () => {
    it("should store _l2Signer for Base (EVM chain)", async () => {
      // Arrange
      const { JsonRpcProvider } = await import("@ethersproject/providers")
      const provider = new JsonRpcProvider()
      // Mock the network detection
      provider.getNetwork = async () =>
        ({ name: "base", chainId: 84532 } as any)
      const mockEthSigner = Wallet.createRandom().connect(provider)

      // Act
      await tbtc.initializeCrossChain("Base", mockEthSigner)

      // Assert
      expect(tbtc._l2Signer).to.equal(mockEthSigner)
    })

    it("should store _l2Signer for Arbitrum (EVM chain)", async () => {
      // Arrange
      const { JsonRpcProvider } = await import("@ethersproject/providers")
      const provider = new JsonRpcProvider()
      // Mock the network detection
      provider.getNetwork = async () =>
        ({ name: "arbitrum", chainId: 421614 } as any)
      const mockEthSigner = Wallet.createRandom().connect(provider)

      // Act
      await tbtc.initializeCrossChain("Arbitrum", mockEthSigner)

      // Assert
      expect(tbtc._l2Signer).to.equal(mockEthSigner)
    })
  })

  describe("Isolation and Side Effects", () => {
    it("should not affect other functionality when _l2Signer is not stored", async () => {
      // Arrange
      const mockAccount = new Account(
        new RpcProvider({
          nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
        }),
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      // Act
      await tbtc.initializeCrossChain("StarkNet", mockAccount)

      // Assert
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
      expect(contracts?.destinationChainBitcoinDepositor).to.exist
      expect(contracts?.destinationChainTbtcToken).to.exist
      // Ensure core functionality still works
      expect(tbtc._l2Signer).to.be.undefined
    })
  })
})
