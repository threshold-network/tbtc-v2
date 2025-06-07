import { expect, use } from "chai"
const sinon = require("sinon")
import chaiAsPromised from "chai-as-promised"

use(chaiAsPromised)

import { TBTC } from "../../src/services/tbtc"
import { BitcoinClient } from "../../src/lib/bitcoin"
import { RpcProvider, Account } from "starknet"
import { BitcoinRawTxVectors } from "../../src/lib/bitcoin"
import { DepositReceipt } from "../../src/lib/contracts/bridge"
import { Hex } from "../../src/lib/utils"
import { StarkNetAddress } from "../../src/lib/starknet/address"
import * as starknet from "../../src/lib/starknet"

// Mock axios for relayer calls
const axios = require("axios")

describe("StarkNet Single-Parameter Deposit Flow", () => {
  let tbtc: TBTC
  let axiosStub: any
  let mockContracts: any
  let mockBitcoinClient: BitcoinClient

  beforeEach(async () => {
    // Mock loadStarkNetCrossChainContracts
    sinon
      .stub(starknet, "loadStarkNetCrossChainContracts")
      .callsFake(
        async (
          walletAddress: string,
          provider?: any,
          chainId: string = "0x534e5f5345504f4c4941"
        ) => {
          // Create a mock provider if not provided
          const mockProvider = provider || {
            getChainId: () => Promise.resolve(chainId),
          }

          const depositorConfig: starknet.StarkNetDepositorConfig = {
            chainId,
          }

          const depositor = new starknet.StarkNetDepositor(
            depositorConfig,
            "StarkNet",
            mockProvider
          )
          depositor.setDepositOwner(
            starknet.StarkNetAddress.from(walletAddress)
          )

          const config: starknet.StarkNetTBTCTokenConfig = {
            chainId,
            tokenContract:
              "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
          }

          return {
            destinationChainBitcoinDepositor: depositor,
            destinationChainTbtcToken: new starknet.StarkNetTBTCToken(
              config,
              mockProvider as any
            ),
          }
        }
      )
    // Mock Ethereum core contracts
    mockContracts = {
      bridge: {
        address: "0x1234567890abcdef1234567890abcdef12345678",
        interface: {},
        walletRegistry: () => ({
          address: "0xabcdef1234567890abcdef1234567890abcdef12",
          interface: {},
        }),
      },
      tbtcToken: {
        address: "0x2234567890abcdef2234567890abcdef22345678",
        interface: {},
      },
      tbtcVault: {
        address: "0x3234567890abcdef3234567890abcdef32345678",
        interface: {},
      },
      wormholeGateway: {
        address: "0x4234567890abcdef4234567890abcdef42345678",
        interface: {},
      },
    }

    // Mock Bitcoin client
    mockBitcoinClient = {
      findAllUnspentTransactionOutputs: sinon.stub().resolves([]),
      getHeadersChain: sinon.stub().resolves("0x00"),
      getTransactionConfirmations: sinon.stub().resolves(6),
      getRawTransaction: sinon.stub().resolves({
        transactionHex: "0x00",
      }),
      getTransaction: sinon.stub().resolves({
        transactionHash: Hex.from("0x00"),
        inputs: [],
        outputs: [],
      }),
      getTxHashesForPublicKeyHash: sinon.stub().resolves([]),
      getNetwork: sinon.stub().returns("testnet"),
      broadcast: sinon.stub().resolves(),
      getCoinbaseTxHash: sinon.stub().resolves(Hex.from("0x00")),
    } as any

    // Initialize TBTC with mocks
    const crossChainContractsLoader = {
      loadChainMapping: () => ({
        base: 8453,
        arbitrumOne: 42161,
        optimism: 10,
        polygon: 137,
        starknet: "0x534e5f544553544e4554", // Use testnet chain ID for tests
      }),
      loadL1Contracts: async (l2ChainName: string) => ({
        l1BitcoinDepositor: {
          getChainIdentifier: () => ({
            identifierHex: "0x1234567890abcdef1234567890abcdef12345678",
          }),
        },
      }),
      loadL2Contracts: async (l2ChainName: string, l1Signer: any) => ({}),
    }

    // Use the constructor directly to pass crossChainContractsLoader
    tbtc = new (TBTC as any)(
      mockContracts,
      mockBitcoinClient,
      crossChainContractsLoader
    )

    // Mock axios
    axiosStub = sinon.stub(axios, "post")
  })

  afterEach(() => {
    sinon.restore()
  })

  describe("Complete deposit flow with single-parameter", () => {
    it("should complete deposit with only StarkNet wallet", async () => {
      // Arrange
      const starknetAddress =
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      const starknetAccount = new Account(
        new RpcProvider({
          nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
        }),
        starknetAddress,
        "0x1" // dummy private key for testing
      )

      // Mock relayer response
      axiosStub.resolves({
        data: {
          receipt: {
            transactionHash:
              "0xabc123def456789abc123def456789abc123def456789abc123def456789ab",
          },
        },
      })

      // Mock deposit data
      const depositTx: BitcoinRawTxVectors = {
        version: Hex.from("02000000"),
        inputs: Hex.from("0101234567890abcdef01234567890abcdef"),
        outputs: Hex.from("01fedcba098765432101fedcba0987654321"),
        locktime: Hex.from("00000000"),
      }

      const deposit: DepositReceipt = {
        depositor: StarkNetAddress.from(starknetAddress),
        walletPublicKeyHash: Hex.from(
          "1234567890abcdef1234567890abcdef12345678"
        ),
        refundPublicKeyHash: Hex.from(
          "abcdef1234567890abcdef1234567890abcdef12"
        ),
        blindingFactor: Hex.from("f9f0c90d00039523"),
        refundLocktime: Hex.from("60920000"),
        extraData: Hex.from(
          "049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
        ),
      }

      // Act
      await tbtc.initializeCrossChain("StarkNet", starknetAccount)

      // Verify cross-chain contracts were initialized
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
      expect(contracts!.destinationChainBitcoinDepositor).to.exist
      expect(contracts!.destinationChainTbtcToken).to.exist

      // Verify we can get the depositor
      const depositor = contracts!.destinationChainBitcoinDepositor
      expect(depositor).to.exist

      // Verify deposit owner is set correctly
      depositor.setDepositOwner(StarkNetAddress.from(starknetAddress))

      // Mock the deposit initialization
      const result = await depositor.initializeDeposit(depositTx, 0, deposit)

      // Assert
      expect(result.toString()).to.equal(
        "abc123def456789abc123def456789abc123def456789abc123def456789ab"
      )
      expect(axiosStub.calledOnce).to.be.true
      expect(axiosStub.args[0][0]).to.equal(
        "http://relayer.tbtcscan.com/api/reveal"
      )
      expect(axiosStub.args[0][1]).to.have.property("l2DepositOwner")
      expect(axiosStub.args[0][1]).to.have.property("l2Sender")
      expect(axiosStub.args[0][1].l2Sender).to.match(/^0x[0-9a-f]{64}$/)
      expect(axiosStub.args[0][1]).to.have.property("fundingTx")
      expect(axiosStub.args[0][1]).to.have.property("reveal")
    })

    it("should preserve StarkNet address through entire flow", async () => {
      // Arrange
      const starknetAddress =
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      const starknetAccount = new Account(
        new RpcProvider({
          nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
        }),
        starknetAddress,
        "0x1"
      )

      // Mock relayer to capture the request
      let capturedRequest: any
      axiosStub.callsFake(async (url: string, data: any) => {
        capturedRequest = data
        return {
          data: {
            receipt: {
              transactionHash:
                "0xdef456789abc123def456789abc123def456789abc123def456789abc123de",
            },
          },
        }
      })

      // Act
      await tbtc.initializeCrossChain("StarkNet", starknetAccount)
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
      const depositor = contracts!.destinationChainBitcoinDepositor
      depositor.setDepositOwner(StarkNetAddress.from(starknetAddress))

      await depositor.initializeDeposit(
        {
          version: Hex.from("02000000"),
          inputs: Hex.from("01"),
          outputs: Hex.from("01"),
          locktime: Hex.from("00000000"),
        },
        0,
        {
          depositor: StarkNetAddress.from(starknetAddress),
          walletPublicKeyHash: Hex.from(
            "1234567890abcdef1234567890abcdef12345678"
          ),
          refundPublicKeyHash: Hex.from(
            "abcdef1234567890abcdef1234567890abcdef12"
          ),
          blindingFactor: Hex.from("f9f0c90d00039523"),
          refundLocktime: Hex.from("60920000"),
          extraData: Hex.from(
            "049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
          ),
        }
      )

      // Assert - verify address preservation
      expect(capturedRequest.l2Sender).to.equal(
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      )
    })

    it("should handle relayer failures gracefully", async function () {
      this.timeout(15000) // Increase timeout to handle retry delays

      // Arrange
      const starknetAccount = new Account(
        new RpcProvider({
          nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
        }),
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      // Mock setTimeout to speed up retries
      const setTimeoutStub = sinon
        .stub(global, "setTimeout")
        .callsFake((fn: any) => {
          fn() // Execute immediately
          return {} as any
        })

      // Reset and configure axios stub for this test
      axiosStub.reset()
      axiosStub.rejects({
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: "Internal server error" },
        },
      })

      // Act
      await tbtc.initializeCrossChain("StarkNet", starknetAccount)
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
      const depositor = contracts!.destinationChainBitcoinDepositor

      // Assert
      await expect(
        depositor.initializeDeposit(
          {
            version: Hex.from("02000000"),
            inputs: Hex.from("01"),
            outputs: Hex.from("01"),
            locktime: Hex.from("00000000"),
          },
          0,
          {
            depositor: StarkNetAddress.from(
              "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
            ),
            walletPublicKeyHash: Hex.from(
              "1234567890abcdef1234567890abcdef12345678"
            ),
            refundPublicKeyHash: Hex.from(
              "abcdef1234567890abcdef1234567890abcdef12"
            ),
            blindingFactor: Hex.from("f9f0c90d00039523"),
            refundLocktime: Hex.from("60920000"),
            extraData: Hex.from(
              "049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
            ),
          }
        )
      ).to.be.rejectedWith("Relayer service temporarily unavailable")

      // Cleanup
      setTimeoutStub.restore()
    })
  })

  describe("Error handling", () => {
    it("should fail gracefully if StarkNet wallet not connected", async () => {
      // Arrange - Invalid provider that doesn't match backward compatibility criteria
      const invalidProvider = {
        // Missing required properties - not a valid Provider or Account
        invalidProperty: true,
      }

      // Act & Assert
      await expect(
        tbtc.initializeCrossChain("StarkNet", invalidProvider as any)
      ).to.be.rejectedWith(
        "StarkNet provider must be an Account object or Provider with connected account"
      )
    })

    it("should handle relayer timeout errors", async function () {
      this.timeout(15000) // Increase timeout to handle retry delays

      // Arrange
      const starknetAccount = new Account(
        new RpcProvider({
          nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
        }),
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        "0x1"
      )

      // Mock setTimeout to speed up retries
      const setTimeoutStub = sinon
        .stub(global, "setTimeout")
        .callsFake((fn: any) => {
          fn() // Execute immediately
          return {} as any
        })

      // Reset and configure axios stub for this test
      axiosStub.reset()
      const timeoutError = new Error("timeout of 5000ms exceeded")
      ;(timeoutError as any).code = "ECONNABORTED"
      ;(timeoutError as any).isAxiosError = true
      axiosStub.rejects(timeoutError)

      // Act
      await tbtc.initializeCrossChain("StarkNet", starknetAccount)
      const contracts = tbtc.crossChainContracts("StarkNet")
      expect(contracts).to.exist
      const depositor = contracts!.destinationChainBitcoinDepositor

      // Assert
      await expect(
        depositor.initializeDeposit(
          {
            version: Hex.from("02000000"),
            inputs: Hex.from("01"),
            outputs: Hex.from("01"),
            locktime: Hex.from("00000000"),
          },
          0,
          {
            depositor: StarkNetAddress.from(
              "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
            ),
            walletPublicKeyHash: Hex.from(
              "1234567890abcdef1234567890abcdef12345678"
            ),
            refundPublicKeyHash: Hex.from(
              "abcdef1234567890abcdef1234567890abcdef12"
            ),
            blindingFactor: Hex.from("f9f0c90d00039523"),
            refundLocktime: Hex.from("60920000"),
            extraData: Hex.from(
              "049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
            ),
          }
        )
      ).to.be.rejectedWith("Relayer request timed out")

      // Cleanup
      setTimeoutStub.restore()
    })
  })

  describe("Backward compatibility", () => {
    it("should show deprecation warning for two-parameter mode", async () => {
      // Arrange
      const consoleWarnStub = sinon.stub(console, "warn")
      const ethereumSigner = {
        provider: {},
        address: "0x1234567890123456789012345678901234567890",
        getAddress: async () => "0x1234567890123456789012345678901234567890",
        _isSigner: true,
        _address: "0x1234567890123456789012345678901234567890",
      }
      const starknetProvider = new RpcProvider({
        nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_6",
      })

      // Act
      await tbtc.initializeCrossChain(
        "StarkNet",
        ethereumSigner as any,
        starknetProvider
      )

      // Assert
      expect(consoleWarnStub.calledOnce).to.be.true
      expect(consoleWarnStub.args[0][0]).to.include("deprecated")
    })
  })
})
