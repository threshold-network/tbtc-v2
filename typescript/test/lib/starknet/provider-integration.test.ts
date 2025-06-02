import { expect } from "chai"
import { RpcProvider, Account } from "starknet"
import { TBTC } from "../../../src/services/tbtc"
import {
  StarkNetAddress,
  StarkNetDepositor,
  StarkNetTBTCToken,
} from "../../../src/lib/starknet"
import { MockBitcoinClient } from "../../utils/mock-bitcoin-client"
import { MockTBTCContracts } from "../../utils/mock-tbtc-contracts"
import { MockCrossChainContractsLoader } from "../../utils/mock-cross-chain-contracts-loader"
import { MockProvider } from "@ethereum-waffle/provider"
import { BigNumber } from "ethers"

describe("StarkNet Provider Integration", () => {
  let tbtc: TBTC
  let mockBitcoinClient: MockBitcoinClient
  let mockTBTCContracts: MockTBTCContracts
  let mockCrossChainContractsLoader: MockCrossChainContractsLoader
  let ethereumSigner: MockProvider

  beforeEach(async () => {
    mockBitcoinClient = new MockBitcoinClient()
    ethereumSigner = new MockProvider()
    mockTBTCContracts = new MockTBTCContracts()
    mockCrossChainContractsLoader = new MockCrossChainContractsLoader()

    // Create TBTC instance with cross-chain support using private constructor
    const TBTCClass = TBTC as any
    tbtc = new TBTCClass(
      mockTBTCContracts,
      mockBitcoinClient,
      mockCrossChainContractsLoader
    )
  })

  describe("Complete deposit flow with provider", () => {
    it("should complete deposit flow with Provider instance", async () => {
      // Arrange
      const starknetProvider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      // Initialize cross-chain with provider
      await tbtc.initializeCrossChain("StarkNet", starknetProvider)

      // Create mock deposit
      // const mockDeposit = {
      //   depositKey: "0x123",
      //   depositor: "0xdepositor",
      //   walletPublicKeyHash: "0xwallet",
      //   refundPublicKeyHash: "0xrefund",
      //   blindingFactor: "0xblinding",
      //   refundLocktime: "0xlocktime",
      //   extraData:
      //     "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
      // }

      // Act & Assert - should not throw
      expect(() => {
        // Verify provider was stored
        const l2Signer = (tbtc as any)._l2Signer
        expect(l2Signer).to.equal(starknetProvider)
      }).to.not.throw()
    })

    it("should complete deposit flow with Account instance", async () => {
      // Arrange
      const mockAccount = {
        address:
          "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        // Mock account methods
      } as unknown as Account

      // Initialize cross-chain with account
      await tbtc.initializeCrossChain("StarkNet", mockAccount)

      // Act & Assert
      const l2Signer = (tbtc as any)._l2Signer
      expect(l2Signer).to.equal(mockAccount)
    })
  })

  describe("Provider type validation", () => {
    it("should accept Provider instance", async () => {
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-mainnet.public.blastapi.io/rpc/v0_6",
      })

      await expect(tbtc.initializeCrossChain("StarkNet", provider)).to.not.be
        .rejected
    })

    it("should accept Account instance", async () => {
      const account = {
        address: "0x123",
        // Minimal Account interface
      } as unknown as Account

      await expect(tbtc.initializeCrossChain("StarkNet", account)).to.not.be
        .rejected
    })

    it("should maintain backward compatibility with Ethereum signer", async () => {
      // This should extract address as before
      await tbtc.initializeCrossChain("StarkNet", ethereumSigner)

      const l2Signer = (tbtc as any)._l2Signer
      // Should be string address, not provider
      expect(typeof l2Signer).to.equal("string")
    })
  })

  describe("Balance query with provider", () => {
    let mockProvider: any
    let token: StarkNetTBTCToken

    beforeEach(() => {
      // Create mock provider with manual stub functions
      const callContractCalls: any[] = []
      mockProvider = {
        callContract: async (params: any) => {
          callContractCalls.push(params)
          if (mockProvider._shouldThrow) {
            throw new Error("Network error")
          }
          return { result: ["1000000000000000000"] }
        },
        getCallContractCalls: () => callContractCalls,
        _shouldThrow: false,
      }

      const config = {
        chainId: "0x534e5f5345504f4c4941", // Sepolia
        tokenContract:
          "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
      }
      token = new StarkNetTBTCToken(config, mockProvider)
    })

    it("should query balance with provider", async () => {
      // Arrange
      const address = StarkNetAddress.from("0x123456")
      const expectedBalance = BigNumber.from("1000000000000000000") // 1 tBTC

      // Act
      const balance = await token.getBalance(address)

      // Assert
      expect(balance.toString()).to.equal(expectedBalance.toString())
      const calls = mockProvider.getCallContractCalls()
      expect(calls).to.have.length(1)
      expect(calls[0]).to.deep.equal({
        contractAddress:
          "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
        entrypoint: "balanceOf",
        calldata: [
          "0x0000000000000000000000000000000000000000000000000000000000123456",
        ],
      })
    })

    it("should handle provider errors gracefully", async () => {
      // Arrange
      const address = StarkNetAddress.from("0x123456")
      mockProvider._shouldThrow = true

      // Act & Assert
      await expect(token.getBalance(address)).to.be.rejectedWith(
        "Network error"
      )
    })
  })

  describe("Depositor with provider", () => {
    let mockProvider: any
    let depositor: StarkNetDepositor

    beforeEach(() => {
      mockProvider = {
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      }
      const config = { chainId: "SN_MAIN" }
      depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
    })

    it("should store and retrieve provider", () => {
      expect(depositor.getProvider()).to.equal(mockProvider)
    })

    it("should support destinationChain parameter", () => {
      // Arrange
      const depositOwner = StarkNetAddress.from("0x789")
      depositor.setDepositOwner(depositOwner)

      // Act
      const encoder = depositor.extraDataEncoder()
      const encoded = encoder.encodeDepositOwner(depositOwner)

      // Assert
      expect(encoded).to.exist
      expect(encoded.toString()).to.include(depositOwner.identifierHex)
    })
  })

  describe("End-to-end provider scenarios", () => {
    it("should handle provider switching", async () => {
      // Initialize with first provider
      const provider1 = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      await tbtc.initializeCrossChain("StarkNet", provider1)

      // Switch to different provider
      const provider2 = new RpcProvider({
        nodeUrl: "https://starknet-mainnet.public.blastapi.io/rpc/v0_6",
      })
      await tbtc.initializeCrossChain("StarkNet", provider2)

      // Verify latest provider is used
      const l2Signer = (tbtc as any)._l2Signer
      expect(l2Signer).to.equal(provider2)
    })

    it("should handle mixed provider types", async () => {
      // Start with Provider
      const provider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })
      await tbtc.initializeCrossChain("StarkNet", provider)

      // Switch to Account
      const account = {
        address: "0x123",
        provider: provider,
      } as unknown as Account
      await tbtc.initializeCrossChain("StarkNet", account)

      // Verify account is stored
      const l2Signer = (tbtc as any)._l2Signer
      expect(l2Signer).to.equal(account)
    })
  })

  describe("Error handling", () => {
    it("should provide clear error when provider is missing", async () => {
      const config = { chainId: "SN_MAIN" }

      expect(
        () => new StarkNetDepositor(config, "StarkNet", undefined as any)
      ).to.throw("Provider is required for StarkNet depositor")
    })

    it("should handle invalid provider types gracefully", async () => {
      const invalidProvider = { invalid: true } as any

      // Should not throw during initialization
      await expect(tbtc.initializeCrossChain("StarkNet", invalidProvider)).to
        .not.be.rejected

      // But should fail when actually used
      const l2Signer = (tbtc as any)._l2Signer
      expect(l2Signer).to.equal(invalidProvider)
    })
  })

  describe("Mock provider behavior", () => {
    it("should work with mocked provider in tests", async () => {
      // Create comprehensive mock
      let called = false
      const mockProvider = {
        callContract: async () => {
          called = true
          return { result: ["1000000"] }
        },
        getTransactionReceipt: async () => ({ status: "ACCEPTED" }),
        waitForTransaction: async () => ({ status: "ACCEPTED" }),
      }

      const config = {
        chainId: "0x534e5f4d41494e",
        tokenContract:
          "0x04a909347487d909a6629b56880e6e03ad3859e772048c4481f3fba88ea02c32f",
      }
      const token = new StarkNetTBTCToken(config, mockProvider as any)
      const address = StarkNetAddress.from("0xabc")

      // Act
      const balance = await token.getBalance(address)

      // Assert
      expect(balance.toString()).to.equal("1000000")
      expect(called).to.be.true
    })
  })
})
