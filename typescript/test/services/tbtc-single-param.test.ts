import { expect } from "chai"
import { RpcProvider, Account } from "starknet"
import { TBTC } from "../../src/services/tbtc"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockCrossChainContractsLoader } from "../utils/mock-cross-chain-contracts-loader"
import { StarkNetProvider } from "../../src/lib/starknet/types"

describe("TBTC Single-Parameter StarkNet Initialization", () => {
  let tbtc: TBTC
  let mockTBTCContracts: MockTBTCContracts
  let mockBitcoinClient: MockBitcoinClient
  let mockCrossChainContractsLoader: MockCrossChainContractsLoader
  let consoleWarnStub: any
  let consoleWarnCalls: string[]

  beforeEach(async () => {
    mockTBTCContracts = new MockTBTCContracts()
    mockBitcoinClient = new MockBitcoinClient()
    mockCrossChainContractsLoader = new MockCrossChainContractsLoader()

    // Capture console.warn calls
    consoleWarnCalls = []
    consoleWarnStub = console.warn
    console.warn = (message: string) => {
      consoleWarnCalls.push(message)
    }

    // Create TBTC instance with cross-chain support
    const TBTCClass = TBTC as any
    tbtc = new TBTCClass(
      mockTBTCContracts,
      mockBitcoinClient,
      mockCrossChainContractsLoader
    )
  })

  afterEach(() => {
    console.warn = consoleWarnStub
  })

  describe("TBTC.initializeCrossChain - Single Parameter Mode", () => {
    it("should detect single-parameter mode for StarkNet", async () => {
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
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
      expect(contracts?.l2BitcoinDepositor).to.exist
      // Should NOT warn about deprecation in single-parameter mode
      expect(consoleWarnCalls.length).to.equal(0)
    })

    it("should maintain backward compatibility with two-parameter mode", async () => {
      // Arrange
      const { Wallet } = await import("ethers")
      const mockEthSigner = Wallet.createRandom()
      const mockProvider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      // Act
      await tbtc.initializeCrossChain("StarkNet", mockEthSigner, mockProvider)

      // Assert
      expect(consoleWarnCalls.length).to.be.greaterThan(0)
      expect(consoleWarnCalls[0]).to.include("deprecated")
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
    })

    it("should error when StarkNet provider is invalid", async () => {
      // Arrange
      const invalidProvider = {} as StarkNetProvider

      // Act & Assert
      await expect(
        tbtc.initializeCrossChain("StarkNet", invalidProvider)
      ).to.be.rejectedWith(/StarkNet provider must be/)
    })
  })

  describe("Success Scenarios", () => {
    it("should initialize with Account object", async () => {
      // Arrange
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const account = new Account(
        provider,
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      // Act
      await tbtc.initializeCrossChain("StarkNet", account)

      // Assert
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
      expect(contracts?.l2BitcoinDepositor).to.exist
      expect(contracts?.l2TbtcToken).to.exist
    })

    it("should initialize with Provider + connected account", async () => {
      // Arrange
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      // Mock a provider with account property
      const providerWithAccount = Object.assign(provider, {
        account: {
          address:
            "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        },
      })

      // Act
      await tbtc.initializeCrossChain("StarkNet", providerWithAccount)

      // Assert
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
    })

    it("should create proper cross-chain contracts", async () => {
      // Arrange
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const account = new Account(
        provider,
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      // Act
      await tbtc.initializeCrossChain("StarkNet", account)

      // Assert
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.have.property("l2BitcoinDepositor")
      expect(contracts).to.have.property("l2TbtcToken")
    })
  })

  describe("Error Scenarios", () => {
    it("should accept Provider-only for backward compatibility", async () => {
      // Arrange
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      // Act & Assert - should not throw
      await expect(tbtc.initializeCrossChain("StarkNet", provider)).not.to.be
        .rejected

      // But should use placeholder address
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
    })

    it("should fail with invalid address format", async () => {
      // Arrange
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const invalidAccount = new Account(provider, "invalid-address", "0x1")

      // Act & Assert
      await expect(tbtc.initializeCrossChain("StarkNet", invalidAccount)).to.be
        .rejected // StarkNet Account constructor might throw or we validate later
    })

    it("should fail with null provider", async () => {
      // Act & Assert
      await expect(
        tbtc.initializeCrossChain("StarkNet", null as any)
      ).to.be.rejectedWith(/StarkNet provider is required/)
    })
  })

  describe("Deprecation Warnings", () => {
    it("should not warn for single-parameter", async () => {
      // Arrange
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const account = new Account(
        provider,
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      // Act
      await tbtc.initializeCrossChain("StarkNet", account)

      // Assert
      expect(consoleWarnCalls.length).to.equal(0)
    })

    it("should warn for two-parameter mode", async () => {
      // Arrange
      const { Wallet } = await import("ethers")
      const ethSigner = Wallet.createRandom()
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      // Act
      await tbtc.initializeCrossChain("StarkNet", ethSigner, provider)

      // Assert
      expect(consoleWarnCalls.length).to.equal(1)
      expect(consoleWarnCalls[0]).to.match(
        /Two-parameter initializeCrossChain for StarkNet is deprecated/
      )
    })
  })
})
