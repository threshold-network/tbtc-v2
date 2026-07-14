import { expect } from "chai"
import sinon from "sinon"
import {
  StarkNetDepositor,
  StarkNetDepositorConfig,
  StarkNetBitcoinDepositor,
  RelayerDepositConflictError,
  RelayerDepositStatus,
} from "../../../src/lib/starknet/starknet-depositor"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import {
  createMockProvider,
  createMockDepositTx,
  createMockDeposit,
} from "./test-helpers"
import { Hex } from "../../../src/lib/utils"
import { TransactionReceipt } from "@ethersproject/providers"

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
      expect(result).to.not.be.instanceOf(Hex)
      expect((result as TransactionReceipt).transactionHash).to.equal(
        "0xabc123def456"
      )

      // Check axios was called correctly
      const stub = axios.post as sinon.SinonStub
      expect(stub.callCount).to.equal(1)
      expect(stub.getCall(0).args[0]).to.equal(
        "http://test-relayer.local/api/reveal"
      )
      expect(stub.getCall(0).args[1]).to.have.property("fundingTx")
      expect(stub.getCall(0).args[1]).to.have.property("reveal")
      expect(stub.getCall(0).args[1].l2DepositOwner).to.equal(
        mockReceipt.extraData.toPrefixedString()
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

      // Mock setTimeout to speed up retries
      const setTimeoutStub = sinon
        .stub(global, "setTimeout")
        .callsFake((fn: any) => {
          fn() // Execute immediately
          return {} as any
        })

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
      expect((result as TransactionReceipt).transactionHash).to.equal(
        "0x" + "1234567890abcdef".repeat(4)
      )
      expect(callCount).to.equal(3)

      // Cleanup
      setTimeoutStub.restore()
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

    it("should not retry on 401 Unauthorized", async () => {
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

      const error: any = new Error("Request failed with status code 401")
      error.response = {
        status: 401,
        data: { error: "Unauthorized" },
      }
      error.isAxiosError = true
      axios.post = sinon.stub().rejects(error)

      // Act & Assert
      try {
        await depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
        expect.fail("Should have thrown an error")
      } catch (err) {
        expect((err as Error).message).to.equal(
          "Relayer request failed: Unauthorized"
        )
      }

      expect((axios.post as sinon.SinonStub).callCount).to.equal(1) // No retries
    })
  })

  describe("deposit conflict handling (409)", () => {
    let originalGet: any
    let depositor: StarkNetBitcoinDepositor
    let mockDepositTx: ReturnType<typeof createMockDepositTx>
    let mockReceipt: ReturnType<typeof createMockDeposit>

    beforeEach(() => {
      originalGet = axios.get

      const mockProvider = createMockProvider()
      const config: StarkNetDepositorConfig = {
        chainId: "0x534e5f4d41494e",
        relayerUrl: "http://test-relayer.local/api/StarknetMainnet/reveal",
      }
      depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      depositor.setDepositOwner(StarkNetAddress.from("0x123456"))

      mockDepositTx = createMockDepositTx()
      mockReceipt = createMockDeposit()
      mockReceipt.extraData = Hex.from("0x" + "00".repeat(31) + "01")
    })

    afterEach(() => {
      axios.get = originalGet
    })

    // Builds the Axios rejection the relayer produces on a 409 Conflict,
    // matching the real relayer's { success: false, error, depositId } body.
    function build409Error(depositId: unknown): any {
      const error: any = new Error("Request failed with status code 409")
      error.isAxiosError = true
      error.response = {
        status: 409,
        data: {
          success: false,
          error: "Deposit already exists",
          depositId,
        },
      }
      return error
    }

    async function expectConflictError(
      act: Promise<Hex | TransactionReceipt>
    ): Promise<RelayerDepositConflictError> {
      try {
        await act
        expect.fail("Should have thrown RelayerDepositConflictError")
      } catch (err) {
        expect(err).to.be.instanceOf(RelayerDepositConflictError)
        return err as RelayerDepositConflictError
      }
      // Unreachable: expect.fail always throws. Satisfies the return type.
      throw new Error("unreachable")
    }

    it("should reject a direct 409 with a verified QUEUED status as unverified and recoverable", async () => {
      axios.post = sinon.stub().rejects(build409Error("123456789"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "123456789",
          status: RelayerDepositStatus.QUEUED,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.equal("123456789")
      expect(conflict.status).to.equal(RelayerDepositStatus.QUEUED)
      expect(conflict.statusVerified).to.be.true
      expect((axios.post as sinon.SinonStub).callCount).to.equal(1)
      expect((axios.get as sinon.SinonStub).callCount).to.equal(1)
    })

    it("should reject a 500-then-409 sequence with verified QUEUED status as unverified and recoverable", async () => {
      const setTimeoutStub = sinon
        .stub(global, "setTimeout")
        .callsFake((fn: any) => {
          fn()
          return {} as any
        })

      let callCount = 0
      axios.post = sinon.stub().callsFake(() => {
        callCount++
        if (callCount === 1) {
          const error: any = new Error("Internal Server Error")
          error.isAxiosError = true
          error.response = { status: 500, data: { error: "boom" } }
          return Promise.reject(error)
        }
        return Promise.reject(build409Error("42"))
      })
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "42",
          status: RelayerDepositStatus.QUEUED,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.equal("42")
      expect(conflict.status).to.equal(RelayerDepositStatus.QUEUED)
      expect(conflict.statusVerified).to.be.true
      // One 500 attempt, one 409 attempt - the conflict short-circuits
      // further retries.
      expect(callCount).to.equal(2)

      setTimeoutStub.restore()
    })

    it("should treat a malformed (non-string) deposit ID as unverifiable without crashing", async () => {
      axios.post = sinon.stub().rejects(build409Error(123456789))
      axios.get = sinon.stub()

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.be.undefined
      expect(conflict.status).to.be.undefined
      expect(conflict.statusVerified).to.be.false
      expect((axios.get as sinon.SinonStub).called).to.be.false
    })

    it("should treat a failed status query as unverifiable and remain recoverable", async () => {
      axios.post = sinon.stub().rejects(build409Error("999"))
      axios.get = sinon.stub().rejects(new Error("Network Error"))

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.equal("999")
      expect(conflict.status).to.be.undefined
      expect(conflict.statusVerified).to.be.false
    })

    it("should treat a status endpoint success:false response as unverifiable", async () => {
      axios.post = sinon.stub().rejects(build409Error("654"))
      axios.get = sinon.stub().resolves({
        data: {
          success: false,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.equal("654")
      expect(conflict.status).to.be.undefined
      expect(conflict.statusVerified).to.be.false
      expect((axios.get as sinon.SinonStub).callCount).to.equal(1)
    })

    it("should treat an unrecognized numeric status as unverifiable", async () => {
      axios.post = sinon.stub().rejects(build409Error("321"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "321",
          status: 99,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.equal("321")
      expect(conflict.status).to.be.undefined
      expect(conflict.statusVerified).to.be.false
      expect((axios.get as sinon.SinonStub).callCount).to.equal(1)
    })

    it("should reject a verified INITIALIZED status without receipt data as an unverified conflict", async () => {
      axios.post = sinon.stub().rejects(build409Error("77"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "77",
          status: RelayerDepositStatus.INITIALIZED,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.status).to.equal(RelayerDepositStatus.INITIALIZED)
      expect(conflict.statusVerified).to.be.true
    })

    it("should reject a verified FINALIZED status without receipt data as an unverified conflict", async () => {
      axios.post = sinon.stub().rejects(build409Error("88"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "88",
          status: RelayerDepositStatus.FINALIZED,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.status).to.equal(RelayerDepositStatus.FINALIZED)
      expect(conflict.statusVerified).to.be.true
    })

    it("should return a verified success when the relayer confirms INITIALIZED status with receipt data", async () => {
      axios.post = sinon.stub().rejects(build409Error("55"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "55",
          status: RelayerDepositStatus.INITIALIZED,
          receipt: { transactionHash: "0xverified123" },
        },
      })

      const result = await depositor.initializeDeposit(
        mockDepositTx,
        0,
        mockReceipt
      )

      expect(result).to.not.be.instanceOf(Hex)
      expect((result as TransactionReceipt).transactionHash).to.equal(
        "0xverified123"
      )
    })

    it("should still resolve ordinary (non-conflict) success responses without querying status", async () => {
      axios.post = sinon.stub().resolves({
        data: {
          success: true,
          receipt: { transactionHash: "0xnormal456" },
        },
      })
      axios.get = sinon.stub()

      const result = await depositor.initializeDeposit(
        mockDepositTx,
        0,
        mockReceipt
      )

      expect((result as TransactionReceipt).transactionHash).to.equal(
        "0xnormal456"
      )
      expect((axios.get as sinon.SinonStub).called).to.be.false
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
          data: {
            success: true,
            receipt: { transactionHash: "0x" + "1".repeat(64) },
          },
        })
      })

      // Act
      await depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)

      // Assert
      expect(capturedUrl).to.equal(
        "https://tbtc-crosschain-relayer-swmku.ondigitalocean.app/api/StarknetMainnet/reveal"
      )
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
          data: {
            success: true,
            receipt: { transactionHash: "0x" + "1".repeat(64) },
          },
        })
      })

      // Act
      await depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)

      // Assert
      expect(capturedUrl).to.equal("http://custom.local/api")
    })
  })
})
