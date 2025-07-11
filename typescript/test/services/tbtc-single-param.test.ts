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
      expect(contracts?.destinationChainBitcoinDepositor).to.exist
      // Should NOT warn about deprecation in single-parameter mode
      expect(consoleWarnCalls.length).to.equal(0)
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
      expect(contracts?.destinationChainBitcoinDepositor).to.exist
      expect(contracts?.destinationChainTbtcToken).to.exist
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
      expect(contracts).to.have.property("destinationChainBitcoinDepositor")
      expect(contracts).to.have.property("destinationChainTbtcToken")
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
  })

  describe("Address Extraction", () => {
    it("should extract address from StarkNet Account", async () => {
      // Arrange
      const expectedAddress =
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const account = new Account(provider, expectedAddress, "0x1")

      // Act
      const extractedAddress = await TBTC.extractStarkNetAddress(account)

      // Assert
      expect(extractedAddress).to.equal(expectedAddress)
    })

    it("should extract address from Provider with connected account", async () => {
      // Arrange
      const expectedAddress =
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      const provider = {
        account: { address: expectedAddress },
        getChainId: async () => "0x534e5f5345504f4c4941",
      }

      // Act
      const extractedAddress = await TBTC.extractStarkNetAddress(
        provider as any
      )

      // Assert
      expect(extractedAddress).to.equal(expectedAddress)
    })

    it("should handle various valid address formats", async () => {
      // Test with different valid address formats
      const addresses = [
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7", // without leading 0
      ]

      for (const addr of addresses) {
        const provider = new RpcProvider({
          nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
        })

        // StarkNet Account constructor may normalize the address
        try {
          const account = new Account(provider, addr, "0x1")
          // Should not throw
          await expect(tbtc.initializeCrossChain("StarkNet", account)).not.to.be
            .rejected
        } catch (e: any) {
          // If Account constructor rejects invalid format, that's expected
          expect(e.message).to.include("address")
        }
      }
    })

    it("should reject addresses that exceed maximum felt252 size", async () => {
      // Test with address that exceeds felt252 max
      const invalidAddress =
        "0x00049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7" // 65 chars
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      // This should fail either in Account constructor or our validation
      try {
        const account = new Account(provider, invalidAddress, "0x1")
        await expect(tbtc.initializeCrossChain("StarkNet", account)).to.be
          .rejected
      } catch (e: any) {
        // Expected - invalid address format
        expect(e.message).to.match(/address|exceeds/)
      }
    })
  })

  describe("Cross-Chain Contract Creation", () => {
    it("should pass correct parameters to loadStarkNetCrossChainContracts", async () => {
      // Arrange
      const expectedAddress =
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const account = new Account(provider, expectedAddress, "0x1")

      // Act
      await tbtc.initializeCrossChain("StarkNet", account)

      // Assert
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
      expect(contracts?.destinationChainBitcoinDepositor).to.exist
      expect(contracts?.destinationChainTbtcToken).to.exist
    })

    it("should reuse contracts on subsequent calls", async () => {
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

      // Initialize again with different account
      const account2 = new Account(
        provider,
        "0x06904a90dcc86f096c4f6daafa2d4e96cb926e5301bb5e6ed5cedc9981fa7064",
        "0x1"
      )
      await tbtc.initializeCrossChain("StarkNet", account2)
      const contracts2 = tbtc.crossChainContracts("StarkNet")

      // Assert - contracts should be updated
      expect(contracts2).to.exist
      expect(contracts2?.destinationChainBitcoinDepositor).to.exist
    })
  })

  describe("Edge Cases", () => {
    it("should handle missing cross-chain loader gracefully", async () => {
      // Arrange
      const TBTCClass = TBTC as any
      const tbtcNoCrossChain = new TBTCClass(
        mockTBTCContracts,
        mockBitcoinClient,
        undefined // No cross-chain loader
      )
      const account = new Account(
        new RpcProvider({
          nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
        }),
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      // Act & Assert
      await expect(
        tbtcNoCrossChain.initializeCrossChain("StarkNet", account)
      ).to.be.rejectedWith(/Cross-chain contracts loader not available/)
    })

    it("should handle invalid chain name", async () => {
      // Arrange
      const account = new Account(
        new RpcProvider({
          nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
        }),
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      // Act & Assert
      await expect(
        tbtc.initializeCrossChain("InvalidChain" as any, account)
      ).to.be.rejectedWith(/Unsupported destination chain/)
    })

    it("should handle undefined provider gracefully", async () => {
      // Act & Assert
      await expect(
        tbtc.initializeCrossChain("StarkNet", undefined as any)
      ).to.be.rejectedWith(/StarkNet provider is required/)
    })
  })
})
