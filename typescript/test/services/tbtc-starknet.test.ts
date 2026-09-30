import { expect } from "chai"
import sinon from "sinon"
import { TBTC } from "../../src/services/tbtc"
import { StarkNetBitcoinDepositor } from "../../src/lib/starknet/starknet-depositor"
import { StarkNetAddress } from "../../src/lib/starknet/address"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockCrossChainContractsLoader } from "../utils/mock-cross-chain-contracts-loader"
import {
  createMockProvider,
  createMockDepositTx,
  createMockDeposit,
} from "../lib/starknet/test-helpers"

const axios = require("axios")

/**
 * Builds a minimal object that is structurally an ethers v5 `Signer`
 * (branded with `_isSigner` and exposing a synchronous `address`), without
 * importing ethers. Exercises the SDK's duck-typed ethers v5 compatibility
 * shim.
 * @param chainId Chain ID the mock signer reports.
 * @returns A structural ethers v5 signer object.
 */
function makeEthersV5Signer(chainId = 1): any {
  const address = "0x1234567890123456789012345678901234567890"
  return {
    _isSigner: true,
    address,
    getAddress: async () => address,
    getChainId: async () => chainId,
    sendTransaction: async () => ({ hash: `0x${"00".repeat(32)}` }),
    call: async () => "0x",
    provider: {
      _isProvider: true,
      getNetwork: async () => ({ chainId }),
      call: async () => "0x",
    },
  }
}

describe("TBTC - StarkNet Provider Support", () => {
  let tbtc: TBTC
  let mockTBTCContracts: MockTBTCContracts
  let mockBitcoinClient: MockBitcoinClient
  let mockCrossChainContractsLoader: MockCrossChainContractsLoader

  beforeEach(async () => {
    mockTBTCContracts = new MockTBTCContracts()
    mockBitcoinClient = new MockBitcoinClient()
    mockCrossChainContractsLoader = new MockCrossChainContractsLoader()

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

      await expect(
        tbtc.initializeCrossChain("StarkNet", starknetProvider as any)
      ).not.to.be.rejected
    })

    it("should accept StarkNet Account", async () => {
      const starknetAccount = createMockProvider()

      await expect(
        tbtc.initializeCrossChain("StarkNet", starknetAccount as any)
      ).not.to.be.rejected
    })

    it("should reject Ethereum signer for StarkNet", async () => {
      const mockEthereumSigner = makeEthersV5Signer()

      await expect(
        tbtc.initializeCrossChain("StarkNet", mockEthereumSigner)
      ).to.be.rejectedWith("Expected a StarkNet provider or account")
    })

    it("should store StarkNet provider in _l2Signer property", async () => {
      const starknetProvider = createMockProvider()

      await tbtc.initializeCrossChain("StarkNet", starknetProvider as any)

      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.not.be.undefined
    })

    it("should extract wallet address from StarkNet Account", async () => {
      const walletAddress =
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      const starknetAccount = {
        address: walletAddress,
        getChainId: async () => "SN_SEPOLIA",
      }

      await tbtc.initializeCrossChain("StarkNet", starknetAccount as any)

      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.not.be.undefined
      expect(contracts?.destinationChainBitcoinDepositor).to.not.be.undefined
    })

    it("should thread options.relayerStatusUrl through to the StarkNet depositor's status endpoint", async () => {
      const provider = createMockProvider()
      const customStatusUrl = "http://custom-status.example/api/deposit"

      await tbtc.initializeCrossChain("StarkNet", provider as any, {
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
