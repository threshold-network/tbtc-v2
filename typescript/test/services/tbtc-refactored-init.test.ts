import { expect } from "chai"
import { RpcProvider } from "starknet"
import { TBTC } from "../../src/services/tbtc"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockCrossChainContractsLoader } from "../utils/mock-cross-chain-contracts-loader"

describe("Refactored initializeCrossChain", () => {
  let tbtc: TBTC
  let mockTBTCContracts: MockTBTCContracts
  let mockBitcoinClient: MockBitcoinClient
  let mockCrossChainContractsLoader: MockCrossChainContractsLoader
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

  it("should accept single-parameter initialization", async () => {
    // With mocked contracts, single-parameter mode succeeds
    // In real implementation, this would fail with Ethereum signer
    await expect(tbtc.initializeCrossChain("StarkNet", starknetProvider)).to.not
      .be.rejected
  })
})
