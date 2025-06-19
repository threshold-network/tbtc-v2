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
    it("should reject two-parameter initialization for StarkNet", async () => {
      // Act & Assert - should throw error
      await expect(
        tbtc.initializeCrossChain("StarkNet", ethereumSigner, starknetProvider)
      ).to.be.rejectedWith(
        "StarkNet does not support two-parameter initialization. " +
          "Please use: initializeCrossChain('StarkNet', starknetProvider)"
      )
    })

    it("should not accept ethereum signer with starknet provider", async () => {
      // Act & Assert
      await expect(
        tbtc.initializeCrossChain("StarkNet", ethereumSigner, starknetProvider)
      ).to.be.rejectedWith(
        "StarkNet does not support two-parameter initialization"
      )
    })

    it("should reject when passing null as second provider", async () => {
      // Act & Assert
      await expect(
        tbtc.initializeCrossChain("StarkNet", ethereumSigner, null as any)
      ).to.be.rejectedWith(
        "StarkNet does not support two-parameter initialization"
      )
    })

    it("should reject when passing any defined value as second provider", async () => {
      // Act & Assert - passing any truthy value should fail
      await expect(
        tbtc.initializeCrossChain("StarkNet", ethereumSigner, {} as any)
      ).to.be.rejectedWith(
        "StarkNet does not support two-parameter initialization"
      )
    })
  })

  describe("backward compatibility", () => {
    it("should reject two-parameter pattern for StarkNet", async () => {
      // Act & Assert - old two-parameter pattern should now throw
      const ethSigner = Wallet.createRandom()
      await expect(
        tbtc.initializeCrossChain("StarkNet", ethSigner, starknetProvider)
      ).to.be.rejectedWith(
        "StarkNet does not support two-parameter initialization"
      )
    })

    it("should accept single-parameter initialization", async () => {
      // With mocked contracts, single-parameter mode succeeds
      // In real implementation, this would fail with Ethereum signer
      await expect(tbtc.initializeCrossChain("StarkNet", starknetProvider)).to
        .not.be.rejected
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
