import { expect } from "chai"
import { RpcProvider } from "starknet"
import { Wallet } from "ethers"
import { TBTC } from "../../src/services/tbtc"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockCrossChainContractsLoader } from "../utils/mock-cross-chain-contracts-loader"

describe("Refactored initializeCrossChain", () => {
  let tbtc: TBTC
  let mockTBTCContracts: MockTBTCContracts
  let mockBitcoinClient: MockBitcoinClient
  let mockCrossChainContractsLoader: MockCrossChainContractsLoader
  let ethereumSigner: Wallet
  let starknetProvider: RpcProvider
  let consoleWarnStub: any

  beforeEach(async () => {
    mockTBTCContracts = new MockTBTCContracts()
    mockBitcoinClient = new MockBitcoinClient()
    mockCrossChainContractsLoader = new MockCrossChainContractsLoader()

    // Create TBTC instance using reflection
    const TBTCClass = TBTC as any
    tbtc = new TBTCClass(
      mockTBTCContracts,
      mockBitcoinClient,
      mockCrossChainContractsLoader
    )

    // Mock Ethereum signer
    ethereumSigner = Wallet.createRandom()

    // Mock StarkNet provider
    starknetProvider = new RpcProvider({
      nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
    })

    // Stub console.warn
    consoleWarnStub = console.warn as any
    console.warn = () => {}
  })

  afterEach(() => {
    console.warn = consoleWarnStub
  })

  describe("two-parameter pattern", () => {
    it("should accept separate ethereum and starknet parameters", async () => {
      // Act & Assert - should not throw
      await expect(
        tbtc.initializeCrossChain("StarkNet", ethereumSigner, starknetProvider)
      ).not.to.be.rejected

      // Should initialize contracts
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
    })

    it("should NOT store _l2Signer property", async () => {
      // Act
      await tbtc.initializeCrossChain(
        "StarkNet",
        ethereumSigner,
        starknetProvider
      )

      // Assert - should NOT have _l2Signer property in two-parameter mode
      expect((tbtc as any)._l2Signer).to.be.undefined
    })

    it("should pass provider directly to loader", async () => {
      // Act
      await tbtc.initializeCrossChain(
        "StarkNet",
        ethereumSigner,
        starknetProvider
      )

      // Assert - No dynamic imports or type checking needed
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
    })

    it("should throw error if StarkNet provider is missing", async () => {
      // Act & Assert
      await expect(
        tbtc.initializeCrossChain("StarkNet", ethereumSigner, null as any)
      ).to.be.rejectedWith(
        "StarkNet provider is required for two-parameter initialization"
      )
    })
  })

  describe("backward compatibility", () => {
    it("should support two-parameter pattern with deprecation warning", async () => {
      let warnMessage = ""
      console.warn = (msg: string) => {
        warnMessage = msg
      }

      // Act - old two-parameter pattern
      const ethSigner = Wallet.createRandom()
      await tbtc.initializeCrossChain("StarkNet", ethSigner, starknetProvider)

      // Assert - should show deprecation warning
      expect(warnMessage).to.include("deprecated")

      // Should initialize contracts
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
    })

    it("should support old pattern with Ethereum signer", async () => {
      // Act - old pattern with Ethereum signer
      await expect(tbtc.initializeCrossChain("StarkNet", ethereumSigner)).not.to
        .be.rejected

      // Should initialize contracts
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
    })
  })

  describe("parameter validation", () => {
    it("should reject two-parameter pattern for Base", async () => {
      // Base is an EVM chain and should not support two-parameter pattern
      await expect(
        tbtc.initializeCrossChain("Base", ethereumSigner, {} as any)
      ).to.be.rejectedWith("Base does not support two-parameter initialization")
    })
  })
})
