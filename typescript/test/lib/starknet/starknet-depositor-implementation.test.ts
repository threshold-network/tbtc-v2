import { expect } from "chai"
import sinon from "sinon"
import {
  StarkNetDepositor,
  StarkNetDepositorConfig,
  StarkNetBitcoinDepositor,
  StarkNetRelayerDepositConflictError,
  StarkNetRelayerDepositStatus,
} from "../../../src/lib/starknet/starknet-depositor"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import {
  createMockProvider,
  createMockDepositTx,
  createMockDeposit,
} from "./test-helpers"
import { Hex } from "../../../src/lib/utils"
import { TransactionReceipt } from "@ethersproject/providers"
import { CrossChainDepositor } from "../../../src/services/deposits/cross-chain"
import { CrossChainInterfaces } from "../../../src/lib/contracts"

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
      expect(stub.getCall(0).args[1].l2Sender).to.equal(
        mockReceipt.extraData.toPrefixedString()
      )
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
        // Explicit status endpoint so conflict-status verification is
        // exercised. A custom reveal URL no longer implicitly pairs with a
        // default status URL (see "should not query a default status
        // endpoint when only a custom reveal URL is configured" below), so
        // the status URL must be supplied to enable verification.
        relayerStatusUrl:
          "http://test-relayer.local/api/StarknetMainnet/deposit",
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
    ): Promise<StarkNetRelayerDepositConflictError> {
      try {
        await act
      } catch (err) {
        expect(err).to.be.instanceOf(StarkNetRelayerDepositConflictError)
        return err as StarkNetRelayerDepositConflictError
      }
      // Only reached if `act` resolved instead of throwing - the exact
      // regression this helper exists to catch. Failing outside the
      // try/catch above keeps the diagnostic accurate instead of being
      // re-caught and reported as an unrelated instanceOf mismatch.
      expect.fail("Should have thrown StarkNetRelayerDepositConflictError")
      throw new Error("unreachable")
    }

    it("should surface a verified QUEUED status as a recoverable conflict that never resolves to success", async () => {
      axios.post = sinon.stub().rejects(build409Error("123456789"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "123456789",
          status: StarkNetRelayerDepositStatus.QUEUED,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.equal("123456789")
      expect(conflict.status).to.equal(StarkNetRelayerDepositStatus.QUEUED)
      // Per F3: statusVerified is downgraded to false when the relayer's
      // echoed ID differs from the SDK's locally-derived ID. Here the
      // relayer reports "123456789" while the SDK derives a 78-digit
      // decimal from the mock funding tx.
      expect(conflict.statusVerified).to.be.false
      expect((axios.post as sinon.SinonStub).callCount).to.equal(1)
      expect((axios.get as sinon.SinonStub).callCount).to.equal(1)
      // The status query targets exactly the configured (explicit) status
      // endpoint with the encoded deposit ID appended - never a default
      // Threshold status service inferred from the custom reveal URL.
      expect((axios.get as sinon.SinonStub).getCall(0).args[0]).to.equal(
        "http://test-relayer.local/api/StarknetMainnet/deposit/123456789"
      )
    })

    it("should propagate StarkNetRelayerDepositConflictError through CrossChainDepositor.revealDeposit", async () => {
      // The typed conflict must survive the SDK-facing consumer boundary: an
      // L2Transaction CrossChainDepositor delegates straight to this
      // StarkNetBitcoinDepositor, so a 409 must reject with the same
      // StarkNetRelayerDepositConflictError (metadata intact) rather than being caught,
      // wrapped, swallowed, or converted into a fabricated Hex success.
      axios.post = sinon.stub().rejects(build409Error("123456789"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "123456789",
          status: StarkNetRelayerDepositStatus.INITIALIZED,
        },
      })

      // Only destinationChainBitcoinDepositor is exercised by the L2Transaction
      // reveal path; the remaining collaborators are intentionally left unset.
      const crossChainDepositor = new CrossChainDepositor(
        {
          destinationChainBitcoinDepositor: depositor,
        } as unknown as CrossChainInterfaces,
        "L2Transaction"
      )

      let caught: unknown
      try {
        await crossChainDepositor.revealDeposit(mockDepositTx, 0, mockReceipt)
        expect.fail("Should have thrown StarkNetRelayerDepositConflictError")
      } catch (err) {
        caught = err
      }

      expect(caught).to.be.instanceOf(StarkNetRelayerDepositConflictError)
      const conflict = caught as StarkNetRelayerDepositConflictError
      expect(conflict.name).to.equal("StarkNetRelayerDepositConflictError")
      expect(conflict.depositId).to.equal("123456789")
      expect(conflict.status).to.equal(StarkNetRelayerDepositStatus.INITIALIZED)
      // Per F3 mismatch: relayer-reported "123456789" differs from the
      // SDK's locally-derived 78-digit decimal.
      expect(conflict.statusVerified).to.be.false
    })

    it("should surface a verified QUEUED status as a recoverable conflict after a 500-then-409 retry sequence, never resolving to success", async () => {
      const setTimeoutStub = sinon
        .stub(global, "setTimeout")
        .callsFake((fn: any) => {
          fn()
          return {} as any
        })

      try {
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
            status: StarkNetRelayerDepositStatus.QUEUED,
          },
        })

        const conflict = await expectConflictError(
          depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
        )

        expect(conflict.depositId).to.equal("42")
        expect(conflict.status).to.equal(StarkNetRelayerDepositStatus.QUEUED)
        // Per F3 mismatch: relayer-reported "42" differs from the SDK's
        // locally-derived 78-digit decimal.
        expect(conflict.statusVerified).to.be.false
        // One 500 attempt, one 409 attempt - the conflict short-circuits
        // further retries.
        expect(callCount).to.equal(2)
      } finally {
        // Always restore the faked global timer, even if an assertion above
        // throws - an unrestored stub would fire synchronously for every
        // subsequent test in the run, including Mocha's own timeout machinery.
        setTimeoutStub.restore()
      }
    })

    it("should treat a malformed (non-string) deposit ID as unverifiable without crashing", async () => {
      axios.post = sinon.stub().rejects(build409Error(123456789))
      // Per F3: when rawDepositId is non-canonical/missing AND the SDK has
      // a locally-derived ID, the SDK queries the status endpoint with the
      // local ID before throwing. The stub below resolves with a successful
      // response whose echoed ID disagrees with the local derivation, so the
      // id-echo check rejects it and statusVerified stays false.
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "123456789", // non-matching echo
          status: StarkNetRelayerDepositStatus.QUEUED,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.be.undefined
      expect(conflict.status).to.be.undefined
      expect(conflict.statusVerified).to.be.false
      expect((axios.get as sinon.SinonStub).called).to.be.true
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

    it("should treat a truthy non-boolean status success value as unverifiable", async () => {
      // Axios does not validate decoded JSON, so a truthy non-boolean `success`
      // (string, number, object, array) must NOT be trusted as a verified
      // status. Each must yield an unverified, recoverable conflict that keeps
      // the deposit ID but has no status.
      const truthyNonBooleanSuccessValues: unknown[] = [
        "false",
        "true",
        1,
        {},
        [],
      ]

      for (const successValue of truthyNonBooleanSuccessValues) {
        const label = JSON.stringify(successValue)
        axios.post = sinon.stub().rejects(build409Error("654"))
        axios.get = sinon.stub().resolves({
          data: {
            success: successValue,
            depositId: "654",
            status: StarkNetRelayerDepositStatus.FINALIZED,
          },
        })

        const conflict = await expectConflictError(
          depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
        )

        expect(conflict.depositId, label).to.equal("654")
        expect(conflict.status, label).to.be.undefined
        expect(conflict.statusVerified, label).to.be.false
        expect(conflict.message, label).to.include(
          "its status could not be verified"
        )
        expect((axios.get as sinon.SinonStub).callCount, label).to.equal(1)
      }
    })

    it("should treat an unrecognized numeric status as unverifiable", async () => {
      // The status enum models only the three on-chain states the endpoint can
      // report (QUEUED=0, INITIALIZED=1, FINALIZED=2). The relayer also has
      // an internal cross-chain lifecycle enum with additional values (this
      // repo has not independently confirmed their exact numbers); whatever
      // those values are, they are never surfaced by the Starknet status
      // endpoint and must be rejected here, as must any other out-of-range
      // value such as 99.
      const unrecognizedStatuses = [3, 4, 99]

      for (const status of unrecognizedStatuses) {
        const label = String(status)
        axios.post = sinon.stub().rejects(build409Error("321"))
        axios.get = sinon.stub().resolves({
          data: {
            success: true,
            depositId: "321",
            status,
          },
        })

        const conflict = await expectConflictError(
          depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
        )

        expect(conflict.depositId, label).to.equal("321")
        expect(conflict.status, label).to.be.undefined
        expect(conflict.statusVerified, label).to.be.false
        expect((axios.get as sinon.SinonStub).callCount, label).to.equal(1)
      }
    })

    it("should surface a verified INITIALIZED status as a conflict rather than a fabricated success, even without receipt data", async () => {
      axios.post = sinon.stub().rejects(build409Error("77"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "77",
          status: StarkNetRelayerDepositStatus.INITIALIZED,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.status).to.equal(StarkNetRelayerDepositStatus.INITIALIZED)
      // Per F3 mismatch: relayer-reported "77" differs from the SDK's
      // locally-derived 78-digit decimal.
      expect(conflict.statusVerified).to.be.false
    })

    it("should surface a verified FINALIZED status as a conflict rather than a fabricated success, even without receipt data", async () => {
      axios.post = sinon.stub().rejects(build409Error("88"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "88",
          status: StarkNetRelayerDepositStatus.FINALIZED,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.status).to.equal(StarkNetRelayerDepositStatus.FINALIZED)
      // Per F3 mismatch: relayer-reported "88" differs from the SDK's
      // locally-derived 78-digit decimal.
      expect(conflict.statusVerified).to.be.false
    })

    it("should reject a verified INITIALIZED status as a conflict even when a partial receipt-shaped object is present", async () => {
      // A relayer status response can include a `receipt` shape, but it only
      // ever contains `transactionHash` (+ optional `blockNumber`/`status`),
      // never the full ethers TransactionReceipt (`to`, `from`, `gasUsed`,
      // `logs`, `blockHash`, etc.). It must never be cast to a full receipt.
      axios.post = sinon.stub().rejects(build409Error("55"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "55",
          status: StarkNetRelayerDepositStatus.INITIALIZED,
          receipt: { transactionHash: "0xverified123" },
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.equal("55")
      expect(conflict.status).to.equal(StarkNetRelayerDepositStatus.INITIALIZED)
      // Per F3 mismatch: relayer-reported "55" differs from the SDK's
      // locally-derived 78-digit decimal.
      expect(conflict.statusVerified).to.be.false
    })

    it("should treat a non-canonical deposit ID as unverifiable, querying status with the locally-derived ID when available", async () => {
      const malformedIds = [
        " 123", // leading whitespace
        "123 ", // trailing whitespace
        "0x1a2b3c", // hex
        "-123", // signed (negative)
        "+123", // signed (positive)
        "12.3", // not an integer
        "0123", // leading zero
        "not-a-deposit-id", // arbitrary text
      ]

      for (const malformedId of malformedIds) {
        axios.post = sinon.stub().rejects(build409Error(malformedId))
        // Per F3: status endpoint is queried using the locally-derived ID
        // when the relayer-reported ID is non-canonical. The response
        // intentionally echoes a non-matching ID, which is rejected by the
        // id-echo check, so statusVerified stays false.
        axios.get = sinon.stub().resolves({
          data: {
            success: true,
            depositId: "123456789", // arbitrary non-matching echo
            status: StarkNetRelayerDepositStatus.QUEUED,
          },
        })

        const conflict = await expectConflictError(
          depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
        )

        expect(conflict.depositId, malformedId).to.be.undefined
        expect(conflict.status, malformedId).to.be.undefined
        expect(conflict.statusVerified, malformedId).to.be.false
        expect((axios.get as sinon.SinonStub).called, malformedId).to.be.true
      }
    })

    it("should reject an out-of-range (> uint256 max) deposit ID, querying status with the locally-derived ID when available", async () => {
      // A genuine deposit ID is a uint256 (0..2^256-1); values above that
      // range cannot be real deposit IDs and must be discarded before any
      // status query. `2^256` (78 digits) exercises the range comparison,
      // and a very long all-digit string exercises the early length guard.
      // Per F3: when the relayer-reported ID is non-canonical, the SDK still
      // queries the status endpoint using the locally-derived ID.
      const twoPow256 =
        "115792089237316195423570985008687907853269984665640564039457584007913129639936"
      const wayTooLong = "9".repeat(200)

      for (const outOfRangeId of [twoPow256, wayTooLong]) {
        axios.post = sinon.stub().rejects(build409Error(outOfRangeId))
        // Status endpoint queried with locally-derived ID per F3; response
        // echoes a non-matching ID, so statusVerified stays false.
        axios.get = sinon.stub().resolves({
          data: {
            success: true,
            depositId: "123456789", // arbitrary non-matching echo
            status: StarkNetRelayerDepositStatus.QUEUED,
          },
        })

        const conflict = await expectConflictError(
          depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
        )

        expect(conflict.depositId, outOfRangeId).to.be.undefined
        expect(conflict.status, outOfRangeId).to.be.undefined
        expect(conflict.statusVerified, outOfRangeId).to.be.false
        expect((axios.get as sinon.SinonStub).called, outOfRangeId).to.be.true
      }
    })

    it("should accept the exact uint256 maximum deposit ID and query its status", async () => {
      // 2^256-1 is a valid boundary deposit ID and must be retained, queried,
      // and able to receive a verified status. Because both 2^256-1 and 2^256
      // are 78 digits long, a length check alone is insufficient and the range
      // comparison must accept this value while rejecting the previous one.
      const maxUint256 =
        "115792089237316195423570985008687907853269984665640564039457584007913129639935"

      axios.post = sinon.stub().rejects(build409Error(maxUint256))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: maxUint256,
          status: StarkNetRelayerDepositStatus.FINALIZED,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.equal(maxUint256)
      expect(conflict.status).to.equal(StarkNetRelayerDepositStatus.FINALIZED)
      // Per F3 mismatch: relayer-reported maxUint256 differs from the SDK's
      // locally-derived 78-digit decimal.
      expect(conflict.statusVerified).to.be.false
      expect((axios.get as sinon.SinonStub).callCount).to.equal(1)
      expect((axios.get as sinon.SinonStub).getCall(0).args[0]).to.equal(
        `http://test-relayer.local/api/StarknetMainnet/deposit/${maxUint256}`
      )
    })

    it("should treat a status response reporting a different deposit ID as unverifiable", async () => {
      axios.post = sinon.stub().rejects(build409Error("246"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "999999",
          status: StarkNetRelayerDepositStatus.FINALIZED,
        },
      })

      const conflict = await expectConflictError(
        depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      expect(conflict.depositId).to.equal("246")
      expect(conflict.status).to.be.undefined
      expect(conflict.statusVerified).to.be.false
      expect((axios.get as sinon.SinonStub).callCount).to.equal(1)
    })

    it("should still resolve ordinary (non-conflict) success responses without querying status", async () => {
      axios.post = sinon.stub().resolves({
        data: {
          success: true,
          receipt: { transactionHash: "0x" + "a".repeat(64) },
        },
      })
      axios.get = sinon.stub()

      const result = await depositor.initializeDeposit(
        mockDepositTx,
        0,
        mockReceipt
      )

      expect((result as TransactionReceipt).transactionHash).to.equal(
        "0x" + "a".repeat(64)
      )
      expect((axios.get as sinon.SinonStub).called).to.be.false
    })

    it("should reject an ordinary reveal response whose success is not the literal boolean true", async () => {
      // The ordinary (200 OK) reveal path must not treat a truthy non-boolean
      // `success` as a successful initialization. A fabricated receipt behind
      // "false"/"true"/1/{}/[] - or literal false / an omitted success - must
      // never be returned; only the literal boolean `true` may resolve.
      const fabricatedReceipt = { transactionHash: "0xfabricated" }
      const nonTrueSuccessValues: unknown[] = [
        "false",
        "true",
        1,
        {},
        [],
        false,
        undefined,
      ]

      for (const successValue of nonTrueSuccessValues) {
        const label = JSON.stringify(successValue) ?? "undefined"
        axios.post = sinon.stub().resolves({
          data: {
            success: successValue,
            receipt: fabricatedReceipt,
          },
        })
        axios.get = sinon.stub()

        let returned: Hex | TransactionReceipt | undefined
        let threw = false
        try {
          returned = await depositor.initializeDeposit(
            mockDepositTx,
            0,
            mockReceipt
          )
        } catch {
          threw = true
        }

        expect(threw, label).to.be.true
        expect(returned, label).to.be.undefined
        // An unsuccessful response is not retryable, so exactly one attempt.
        expect((axios.post as sinon.SinonStub).callCount, label).to.equal(1)
      }
    })

    it("should resolve an ordinary reveal response for the literal boolean success:true", async () => {
      // Positive regression: the strict check still lets the normal success
      // path return the relayer receipt unchanged.
      axios.post = sinon.stub().resolves({
        data: {
          success: true,
          receipt: { transactionHash: "0x" + "b".repeat(64) },
        },
      })
      axios.get = sinon.stub()

      const result = await depositor.initializeDeposit(
        mockDepositTx,
        0,
        mockReceipt
      )

      expect((result as TransactionReceipt).transactionHash).to.equal(
        "0x" + "b".repeat(64)
      )
      expect((axios.get as sinon.SinonStub).called).to.be.false
    })

    it("should not query a default status endpoint when only a custom reveal URL is configured", async () => {
      // A custom reveal URL must not be silently paired with a default
      // (Threshold production) status endpoint. Without an explicit
      // relayerStatusUrl, conflict-status verification is disabled: no status
      // GET is issued and the conflict stays unverified but still carries the
      // deposit ID.
      const customRevealOnlyDepositor = new StarkNetDepositor(
        {
          chainId: "0x534e5f4d41494e",
          relayerUrl: "http://custom-relayer.example/api/reveal",
        },
        "StarkNet",
        createMockProvider()
      )
      customRevealOnlyDepositor.setDepositOwner(
        StarkNetAddress.from("0x123456")
      )

      axios.post = sinon.stub().rejects(build409Error("123456789"))
      axios.get = sinon.stub()

      const conflict = await expectConflictError(
        customRevealOnlyDepositor.initializeDeposit(
          mockDepositTx,
          0,
          mockReceipt
        )
      )

      expect(conflict.depositId).to.equal("123456789")
      expect(conflict.status).to.be.undefined
      expect(conflict.statusVerified).to.be.false
      expect((axios.get as sinon.SinonStub).called).to.be.false
    })

    it("should preserve an explicitly supplied relayerStatusUrl for a recognized chain ID with no relayerUrl override", async () => {
      // Regression guard for the "recognized chainId + explicit
      // relayerStatusUrl + no relayerUrl" defaulting combo: the reveal URL
      // must still default normally (recognized chain), while the
      // caller-supplied status URL must be preserved rather than
      // overwritten by the default - the constructor's
      // "!enhancedConfig.relayerStatusUrl" guard is what makes this so.
      const customStatusOnlyDepositor = new StarkNetDepositor(
        {
          chainId: "0x534e5f4d41494e",
          relayerStatusUrl: "http://custom-status.example/api/deposit",
        },
        "StarkNet",
        createMockProvider()
      )
      customStatusOnlyDepositor.setDepositOwner(
        StarkNetAddress.from("0x123456")
      )

      axios.post = sinon.stub().rejects(build409Error("123456789"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "123456789",
          status: StarkNetRelayerDepositStatus.QUEUED,
        },
      })

      const conflict = await expectConflictError(
        customStatusOnlyDepositor.initializeDeposit(
          mockDepositTx,
          0,
          mockReceipt
        )
      )

      // Per F3 mismatch: relayer-reported "123456789" differs from the
      // SDK's locally-derived 78-digit decimal.
      expect(conflict.statusVerified).to.be.false
      // Reveal URL still defaults from the recognized chain ID.
      expect((axios.post as sinon.SinonStub).getCall(0).args[0]).to.equal(
        "https://tbtc-crosschain-relayer-swmku.ondigitalocean.app/api/StarknetMainnet/reveal"
      )
      // Status GET goes to the caller's custom relayerStatusUrl, never the
      // default.
      expect((axios.get as sinon.SinonStub).getCall(0).args[0]).to.equal(
        "http://custom-status.example/api/deposit/123456789"
      )
    })

    it("should query the default chain-matched status endpoint when no URLs are configured", async () => {
      // With neither URL supplied, the SDK controls both endpoints, so status
      // verification uses the environment- and chain-matched default status
      // service (production base under Node/SSR).
      const fullyDefaultedDepositor = new StarkNetDepositor(
        { chainId: "0x534e5f4d41494e" },
        "StarkNet",
        createMockProvider()
      )
      fullyDefaultedDepositor.setDepositOwner(StarkNetAddress.from("0x123456"))

      axios.post = sinon.stub().rejects(build409Error("123456789"))
      axios.get = sinon.stub().resolves({
        data: {
          success: true,
          depositId: "123456789",
          status: StarkNetRelayerDepositStatus.QUEUED,
        },
      })

      const conflict = await expectConflictError(
        fullyDefaultedDepositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      )

      // Per F3 mismatch: relayer-reported "123456789" differs from the
      // SDK's locally-derived 78-digit decimal.
      expect(conflict.statusVerified).to.be.false
      expect((axios.get as sinon.SinonStub).callCount).to.equal(1)
      expect((axios.get as sinon.SinonStub).getCall(0).args[0]).to.equal(
        "https://tbtc-crosschain-relayer-swmku.ondigitalocean.app/api/StarknetMainnet/deposit/123456789"
      )
    })

    it("should default to exact paired reveal and status routes for every recognized chain ID", async () => {
      // For a recognized chain ID with no overrides, the reveal and status
      // defaults must resolve to the SAME chain segment (never drifting apart)
      // and to the environment-matched base (production under Node/SSR). This
      // pins the full route for mainnet, Sepolia, legacy Goerli, and Testnet,
      // guarding against silent chain-name/route regressions.
      const PRODUCTION_BASE =
        "https://tbtc-crosschain-relayer-swmku.ondigitalocean.app"
      const recognizedChainRoutes = [
        { chainId: "0x534e5f4d41494e", chainSegment: "StarknetMainnet" }, // SN_MAIN
        { chainId: "0x534e5f5345504f4c4941", chainSegment: "StarknetTestnet" }, // SN_SEPOLIA
        { chainId: "0x534e5f474f45524c49", chainSegment: "StarknetTestnet" }, // SN_GOERLI (legacy)
        { chainId: "0x534e5f544553544e4554", chainSegment: "StarknetTestnet" }, // SN_TESTNET
      ]

      for (const { chainId, chainSegment } of recognizedChainRoutes) {
        const recognizedDepositor = new StarkNetDepositor(
          { chainId },
          "StarkNet",
          createMockProvider()
        )
        recognizedDepositor.setDepositOwner(StarkNetAddress.from("0x123456"))

        axios.post = sinon.stub().rejects(build409Error("123456789"))
        axios.get = sinon.stub().resolves({
          data: {
            success: true,
            depositId: "123456789",
            status: StarkNetRelayerDepositStatus.QUEUED,
          },
        })

        const conflict = await expectConflictError(
          recognizedDepositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
        )

        // The status query targets the defaulted chain-matched route and the
        // response echoes the queried deposit ID, so the route resolved
        // correctly. Per F3: statusVerified is downgraded because the
        // relayer-reported "123456789" differs from the SDK's locally-derived
        // 78-digit decimal.
        expect(conflict.statusVerified, chainId).to.be.false
        expect(
          (axios.post as sinon.SinonStub).getCall(0).args[0],
          chainId
        ).to.equal(`${PRODUCTION_BASE}/api/${chainSegment}/reveal`)
        expect(
          (axios.get as sinon.SinonStub).getCall(0).args[0],
          chainId
        ).to.equal(`${PRODUCTION_BASE}/api/${chainSegment}/deposit/123456789`)
      }
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
        chainId: "0x534e5f4d41494e", // SN_MAIN (a recognized chain ID)
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

  describe("chain ID validation", () => {
    const UNKNOWN_CHAIN_ID = "0xTYPO"

    it("should throw synchronously when an unrecognized chain ID is used with no URL overrides", () => {
      // An unknown/mistyped chain ID has no default relayer route and must
      // fail loudly at construction - before any Axios request - instead of
      // silently defaulting to a testnet route and misrouting a reveal after
      // Bitcoin funding.
      expect(
        () =>
          new StarkNetDepositor(
            { chainId: UNKNOWN_CHAIN_ID },
            "StarkNet",
            createMockProvider()
          )
      ).to.throw(/No default StarkNet relayer route for chain ID/)
    })

    it("should throw when an unrecognized chain ID is used with only a status URL override", () => {
      // The reveal endpoint still needs a default, which the reveal builder
      // refuses to synthesize for an unknown chain - proving the reveal
      // default builder validates the chain ID.
      expect(
        () =>
          new StarkNetDepositor(
            {
              chainId: UNKNOWN_CHAIN_ID,
              relayerStatusUrl: "http://custom.example/api/deposit",
            },
            "StarkNet",
            createMockProvider()
          )
      ).to.throw(/No default StarkNet relayer route for chain ID/)
    })

    it("should NOT throw when an unrecognized chain ID is used with only a reveal URL override", () => {
      // Per F1 in starknet-depositor.ts: relayerUrl is the only required
      // endpoint on an unrecognized chain. With relayerUrl supplied, the
      // SDK constructs successfully and status verification is simply left
      // off (matching the recognized-chain case with only a reveal URL).
      // Only the missing-relayerUrl path (only a status URL) still throws.
      expect(
        () =>
          new StarkNetDepositor(
            {
              chainId: UNKNOWN_CHAIN_ID,
              relayerUrl: "http://custom.example/api/reveal",
            },
            "StarkNet",
            createMockProvider()
          )
      ).to.not.throw()
    })

    it("should construct with an unrecognized chain ID when both custom URLs are supplied", () => {
      // Fully custom/dev networks remain supported when the caller supplies
      // both endpoints explicitly.
      expect(
        () =>
          new StarkNetDepositor(
            {
              chainId: UNKNOWN_CHAIN_ID,
              relayerUrl: "http://custom.example/api/reveal",
              relayerStatusUrl: "http://custom.example/api/deposit",
            },
            "StarkNet",
            createMockProvider()
          )
      ).to.not.throw()
    })

    describe("chain IDs colliding with Object.prototype members", () => {
      // A bare `STARKNET_RELAYER_CHAIN_NAMES[chainId]` lookup resolves these
      // strings to truthy members inherited from Object.prototype (e.g. the
      // `toString`/`constructor` functions, the `__proto__` object), which
      // would make them appear to have a default relayer route and synthesize a
      // malformed URL (".../api/[object Object]/reveal") instead of throwing.
      // Recognition uses an own-property check, so these must be treated
      // exactly like any other unrecognized chain ID.
      const PROTOTYPE_CHAIN_IDS = ["toString", "__proto__", "constructor"]

      for (const chainId of PROTOTYPE_CHAIN_IDS) {
        const label = JSON.stringify(chainId)

        it(`should throw for ${label} with no URL overrides`, () => {
          expect(
            () =>
              new StarkNetDepositor(
                { chainId },
                "StarkNet",
                createMockProvider()
              )
          ).to.throw(/No default StarkNet relayer route for chain ID/)
        })

        it(`should not throw for ${label} with only a reveal URL override`, () => {
          // Per F1 in starknet-depositor.ts: relayerUrl is the only required
          // endpoint on an unrecognized chain. With relayerUrl supplied, the
          // SDK constructs successfully and status verification is simply
          // left off (matching the recognized-chain case). Only the missing-
          // relayerUrl path still throws - see "with only a status URL
          // override" below.
          expect(
            () =>
              new StarkNetDepositor(
                { chainId, relayerUrl: "http://custom.example/api/reveal" },
                "StarkNet",
                createMockProvider()
              )
          ).to.not.throw()
        })

        it(`should throw for ${label} with only a status URL override`, () => {
          expect(
            () =>
              new StarkNetDepositor(
                {
                  chainId,
                  relayerStatusUrl: "http://custom.example/api/deposit",
                },
                "StarkNet",
                createMockProvider()
              )
          ).to.throw(/No default StarkNet relayer route for chain ID/)
        })

        it(`should construct for ${label} when both custom URLs are supplied`, () => {
          // Own-property recognition - not the map's prototype chain - is what
          // gates construction, so a fully custom/dev network keyed by a
          // prototype-colliding chain ID still constructs when BOTH endpoints
          // are supplied explicitly.
          expect(
            () =>
              new StarkNetDepositor(
                {
                  chainId,
                  relayerUrl: "http://custom.example/api/reveal",
                  relayerStatusUrl: "http://custom.example/api/deposit",
                },
                "StarkNet",
                createMockProvider()
              )
          ).to.not.throw()
        })
      }
    })

    it("should construct for all recognized chain IDs with no URL overrides", () => {
      const recognizedChainIds = [
        "0x534e5f4d41494e", // SN_MAIN
        "0x534e5f5345504f4c4941", // SN_SEPOLIA
        "0x534e5f474f45524c49", // SN_GOERLI (legacy)
        "0x534e5f544553544e4554", // SN_TESTNET
      ]
      for (const chainId of recognizedChainIds) {
        expect(
          () =>
            new StarkNetDepositor(
              { chainId },
              "StarkNet",
              createMockProvider()
            ),
          chainId
        ).to.not.throw()
      }
    })
  })

  describe("relayer URL environment detection", () => {
    let originalWindow: any
    const hasOwnWindow = Object.prototype.hasOwnProperty.call(global, "window")

    beforeEach(() => {
      originalWindow = (global as any).window
    })

    afterEach(() => {
      if (hasOwnWindow) {
        ;(global as any).window = originalWindow
      } else {
        delete (global as any).window
      }
    })

    async function captureRelayerUrl(
      config: StarkNetDepositorConfig
    ): Promise<string> {
      const mockProvider = createMockProvider()
      const depositor = new StarkNetDepositor(config, "StarkNet", mockProvider)
      depositor.setDepositOwner(StarkNetAddress.from("0x123"))

      const mockDepositTx = createMockDepositTx()
      const mockReceipt = createMockDeposit()

      let capturedUrl = ""
      axios.post = sinon.stub().callsFake((url: string) => {
        capturedUrl = url
        return Promise.resolve({
          data: {
            success: true,
            receipt: { transactionHash: "0x" + "1".repeat(64) },
          },
        })
      })

      await depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
      return capturedUrl
    }

    it("should use the production relayer URL for a localhost mainnet origin", async () => {
      // Per F2 in starknet-depositor.ts: Chains.StarkNet.Mainnet is excluded
      // from the localhost-default path - mainnet always uses the production
      // relayer regardless of hostname, to prevent a production-config dApp
      // served from localhost from being silently routed to a local relayer.
      ;(global as any).window = { location: { hostname: "localhost" } }

      const url = await captureRelayerUrl({ chainId: "0x534e5f4d41494e" })

      expect(url).to.equal(
        "https://tbtc-crosschain-relayer-swmku.ondigitalocean.app/api/StarknetMainnet/reveal"
      )
    })

    it("should use the local relayer URL for a 127.0.0.1 testnet origin", async () => {
      ;(global as any).window = { location: { hostname: "127.0.0.1" } }

      const url = await captureRelayerUrl({
        chainId: "0x534e5f5345504f4c4941", // SN_SEPOLIA
      })

      expect(url).to.equal("http://localhost:3001/api/StarknetTestnet/reveal")
    })

    it("should use the production relayer URL for a non-local browser origin", async () => {
      ;(global as any).window = { location: { hostname: "app.example.com" } }

      const url = await captureRelayerUrl({ chainId: "0x534e5f4d41494e" })

      expect(url).to.equal(
        "https://tbtc-crosschain-relayer-swmku.ondigitalocean.app/api/StarknetMainnet/reveal"
      )
    })

    it("should use the production relayer URL when window is undefined (Node/SSR)", async () => {
      delete (global as any).window

      const url = await captureRelayerUrl({
        chainId: "0x534e5f5345504f4c4941", // SN_SEPOLIA
      })

      expect(url).to.equal(
        "https://tbtc-crosschain-relayer-swmku.ondigitalocean.app/api/StarknetTestnet/reveal"
      )
    })

    it("should let an explicit relayerUrl override localhost detection", async () => {
      ;(global as any).window = { location: { hostname: "localhost" } }

      const url = await captureRelayerUrl({
        chainId: "0x534e5f4d41494e",
        relayerUrl: "http://custom.local/api",
      })

      expect(url).to.equal("http://custom.local/api")
    })

    it("should use the local status URL for a localhost origin when a 409 is verified", async () => {
      // Sibling of the reveal-URL local-origin tests above: the default
      // STATUS url (getDefaultStarkNetRelayerStatusUrl) must independently
      // respect isLocalhostBrowserOrigin() too, not just the reveal URL.
      // Neither relayerUrl nor relayerStatusUrl is overridden, so both
      // default from the same local origin.
      ;(global as any).window = { location: { hostname: "localhost" } }

      const mockProvider = createMockProvider()
      const depositor = new StarkNetDepositor(
        { chainId: "0x534e5f4d41494e" },
        "StarkNet",
        mockProvider
      )
      depositor.setDepositOwner(StarkNetAddress.from("0x123"))

      const mockDepositTx = createMockDepositTx()
      const mockReceipt = createMockDeposit()

      const conflictError: any = new Error(
        "Request failed with status code 409"
      )
      conflictError.isAxiosError = true
      conflictError.response = {
        status: 409,
        data: {
          success: false,
          error: "Deposit already exists",
          depositId: "123456789",
        },
      }
      axios.post = sinon.stub().rejects(conflictError)

      let capturedStatusUrl = ""
      axios.get = sinon.stub().callsFake((url: string) => {
        capturedStatusUrl = url
        return Promise.resolve({
          data: {
            success: true,
            depositId: "123456789",
            status: StarkNetRelayerDepositStatus.QUEUED,
          },
        })
      })

      try {
        await depositor.initializeDeposit(mockDepositTx, 0, mockReceipt)
        expect.fail("Should have thrown StarkNetRelayerDepositConflictError")
      } catch (err) {
        expect(err).to.be.instanceOf(StarkNetRelayerDepositConflictError)
      }

      // Per F2 in starknet-depositor.ts: Chains.StarkNet.Mainnet is
      // excluded from the localhost-default path - mainnet always uses the
      // production relayer, even in a localhost browser context.
      expect(capturedStatusUrl).to.equal(
        "https://tbtc-crosschain-relayer-swmku.ondigitalocean.app/api/StarknetMainnet/deposit/123456789"
      )
    })
  })
})
