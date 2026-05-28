import { expect } from "chai"
<<<<<<< HEAD
import { RpcProvider, Account } from "starknet"
import sinon from "sinon"
=======
>>>>>>> 31d669ac (test(sdk): update StarkNet hardening coverage)
import { TBTC } from "../../src/services/tbtc"
import { StarkNetBitcoinDepositor } from "../../src/lib/starknet/starknet-depositor"
import { StarkNetAddress } from "../../src/lib/starknet/address"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockCrossChainContractsLoader } from "../utils/mock-cross-chain-contracts-loader"
<<<<<<< HEAD
import {
  createMockDepositTx,
  createMockDeposit,
} from "../lib/starknet/test-helpers"

// Mock axios (same pattern as starknet-depositor-implementation.test.ts)
const axios = require("axios")
=======
import { createMockProvider } from "../lib/starknet/test-helpers"
>>>>>>> 31d669ac (test(sdk): update StarkNet hardening coverage)

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

    it("should thread options.relayerStatusUrl through to the StarkNet depositor's status endpoint", async () => {
      // Regression guard for the "relayerStatusUrl is unreachable via the
      // primary entry point" finding: TBTC.initializeCrossChain's optional
      // third `options` parameter must reach loadStarkNetCrossChainInterfaces
      // and end up wired into the constructed depositor's relayerStatusUrl,
      // not just be usable when calling the loader directly.
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      const customStatusUrl = "http://custom-status.example/api/deposit"

      await tbtc.initializeCrossChain("StarkNet", provider, {
        relayerStatusUrl: customStatusUrl,
      })

      const contracts = tbtc.crossChainContracts("StarkNet")
      const depositor = contracts!
        .destinationChainBitcoinDepositor as StarkNetBitcoinDepositor
      depositor.setDepositOwner(StarkNetAddress.from("0x123456"))

      const originalPost = axios.post
      const originalGet = axios.get
      try {
        type FakeAxiosConflictError = Error & {
          isAxiosError: boolean
          response: {
            status: number
            data: { success: boolean; error: string }
          }
        }
        const conflictError: FakeAxiosConflictError = Object.assign(
          new Error("Request failed with status code 409"),
          {
            isAxiosError: true,
            response: {
              status: 409,
              data: { success: false, error: "Deposit already exists" },
            },
          }
        )
        axios.post = sinon.stub().rejects(conflictError)

        let capturedStatusUrl = ""
        axios.get = sinon.stub().callsFake((url: string) => {
          capturedStatusUrl = url
          return Promise.resolve({ data: { success: false } })
        })

        try {
          await depositor.initializeDeposit(
            createMockDepositTx(),
            0,
            createMockDeposit()
          )
        } catch {
          // Expected: a 409 always rejects with
          // StarkNetRelayerDepositConflictError; only the status GET target
          // is under test here.
        }

        expect(capturedStatusUrl).to.satisfy((url: string) =>
          url.startsWith(customStatusUrl)
        )
      } finally {
        axios.post = originalPost
        axios.get = originalGet
      }
    })
  })
})
