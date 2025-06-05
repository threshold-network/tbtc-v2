import { expect } from "chai"
import sinon from "sinon"
import {
  StarkNetDepositor,
  StarkNetDepositorConfig,
} from "../../../src/lib/starknet/starknet-depositor"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import {
  createMockProvider,
  createMockDepositTx,
  createMockDeposit,
} from "./test-helpers"
import { Hex } from "../../../src/lib/utils"

// Mock axios
const axios = require("axios")

describe("StarkNetDepositor - T-001 Implementation", () => {
  let originalPost: any

  beforeEach(() => {
    originalPost = axios.post
  })

  afterEach(() => {
    axios.post = originalPost
  })

  describe("initializeDeposit", () => {
    it("should successfully initialize deposit through relayer", async () => {
      // Arrange
      const mockProvider = createMockProvider()
      const config: StarkNetDepositorConfig = {
        chainId: "0x534e5f4d41494e",
        relayerUrl: "http://test-relayer.local/api/reveal",
      }
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)

      // Set deposit owner
      const depositOwner = StarkNetAddress.from("0x123456789abcdef")
      depositor.setDepositOwner(depositOwner)

      // Create mock deposit data
      const mockDepositTx = createMockDepositTx()
      const mockReceipt = createMockDeposit()
      mockReceipt.extraData = Hex.from("0x" + "00".repeat(31) + "01")

      // Mock the relayer response
      axios.post = sinon.stub().resolves({
        data: {
          success: true,
          receipt: { transactionHash: "0xabc123def456" },
        },
      })

      // Act
      const result = await depositor.initializeDeposit(
        mockDepositTx,
        0,
        mockReceipt
      )

      // Assert
      expect(result).to.be.instanceOf(Hex)
      expect(result.toString()).to.equal("abc123def456")

      // Check axios was called correctly
      const stub = axios.post as sinon.SinonStub
      expect(stub.callCount).to.equal(1)
      expect(stub.getCall(0).args[0]).to.equal(
        "http://test-relayer.local/api/reveal"
      )
      expect(stub.getCall(0).args[1]).to.have.property("fundingTx")
      expect(stub.getCall(0).args[1]).to.have.property("reveal")
      expect(stub.getCall(0).args[1].l2DepositOwner).to.equal(
        mockReceipt.extraData.toString()
      )
      expect(stub.getCall(0).args[1].l2Sender).to.equal(depositOwner.toString())
    })

    it("should throw error if deposit owner not set", async () => {
      // Arrange
      const mockProvider = createMockProvider()
      const config: StarkNetDepositorConfig = { chainId: "0x534e5f4d41494e" }
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)

      const mockDepositTx = createMockDepositTx()
      const mockReceipt = createMockDeposit()

      // Act & Assert
      try {
        await depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
        expect.fail("Should have thrown an error")
      } catch (error) {
        expect((error as Error).message).to.equal(
          "L2 deposit owner must be set before initializing deposit"
        )
      }
    })

    it("should retry on network errors", async () => {
      // Arrange
      const mockProvider = createMockProvider()
      const config: StarkNetDepositorConfig = {
        chainId: "0x534e5f4d41494e",
        relayerUrl: "http://test-relayer.local/api/reveal",
      }
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      depositor.setDepositOwner(StarkNetAddress.from("0x123456"))

      const mockDepositTx = createMockDepositTx()
      const mockReceipt = createMockDeposit()
      mockReceipt.extraData = Hex.from("0x" + "00".repeat(31) + "01")

      // Mock failures then success
      let callCount = 0
      axios.post = sinon.stub().callsFake(() => {
        callCount++
        if (callCount < 3) {
          const error: any = new Error("Connection refused")
          error.code = "ECONNREFUSED"
          return Promise.reject(error)
        }
        return Promise.resolve({
          data: {
            success: true,
            receipt: { transactionHash: "0x" + "1234567890abcdef".repeat(4) },
          },
        })
      })

      // Act
      const result = await depositor.initializeDeposit(
        mockDepositTx,
        0,
        mockReceipt
      )

      // Assert
      expect(result.toString()).to.equal("1234567890abcdef".repeat(4))
      expect(callCount).to.equal(3)
    })

    it("should not retry on client errors", async () => {
      // Arrange
      const mockProvider = createMockProvider()
      const config: StarkNetDepositorConfig = {
        chainId: "0x534e5f4d41494e",
        relayerUrl: "http://test-relayer.local/api/reveal",
      }
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      depositor.setDepositOwner(StarkNetAddress.from("0x123456"))

      const mockDepositTx = createMockDepositTx()
      const mockReceipt = createMockDeposit()
      mockReceipt.extraData = Hex.from("0x" + "00".repeat(31) + "01")

      // Mock 400 error
      const error: any = new Error("Request failed with status code 400")
      error.response = {
        status: 400,
        data: { error: "Invalid data" },
      }
      error.isAxiosError = true
      axios.post = sinon.stub().rejects(error)

      // Act & Assert
      try {
        await depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
        expect.fail("Should have thrown an error")
      } catch (err) {
        expect((err as Error).message).to.equal("Relayer error: Invalid data")
      }

      expect((axios.post as sinon.SinonStub).callCount).to.equal(1) // No retries
    })
  })

  describe("configuration", () => {
    it("should use mainnet URL for mainnet chain", async () => {
      // Arrange
      const config: StarkNetDepositorConfig = { chainId: "0x534e5f4d41494e" } // SN_MAIN
      const mockProvider = createMockProvider()
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      depositor.setDepositOwner(StarkNetAddress.from("0x123"))

      const mockDepositTx = createMockDepositTx()
      const mockReceipt = createMockDeposit()

      // Mock axios to capture the URL
      let capturedUrl: string = ""
      axios.post = sinon.stub().callsFake((url: string) => {
        capturedUrl = url
        return Promise.resolve({
          data: { receipt: { transactionHash: "0x" + "1".repeat(64) } },
        })
      })

      // Act
      await depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)

      // Assert
      expect(capturedUrl).to.equal("https://relayer.tbtcscan.com/api/reveal")
    })

    it("should use custom URL when provided", async () => {
      // Arrange
      const config: StarkNetDepositorConfig = {
        chainId: "0x534e5f544553544e4554",
        relayerUrl: "http://custom.local/api",
      }
      const mockProvider = createMockProvider()
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      depositor.setDepositOwner(StarkNetAddress.from("0x123"))

      const mockDepositTx = createMockDepositTx()
      const mockReceipt = createMockDeposit()

      // Mock axios to capture the URL
      let capturedUrl: string = ""
      axios.post = sinon.stub().callsFake((url: string) => {
        capturedUrl = url
        return Promise.resolve({
          data: { receipt: { transactionHash: "0x" + "1".repeat(64) } },
        })
      })

      // Act
      await depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)

      // Assert
      expect(capturedUrl).to.equal("http://custom.local/api")
    })
  })
})
