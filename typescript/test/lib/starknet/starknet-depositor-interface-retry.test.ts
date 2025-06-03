import { expect } from "chai"
import { StarkNetDepositorInterface } from "../../../src/lib/starknet/starknet-depositor-interface"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import { BitcoinRawTxVectors } from "../../../src/lib/bitcoin"
import { DepositReceipt } from "../../../src/lib/contracts/bridge"
import { Hex } from "../../../src/lib/utils"

// We need to mock axios globally since it's not injected
const axios = require("axios")

describe("StarkNetDepositorInterface - Retry Logic", function () {
  this.timeout(10000) // Set timeout to 10 seconds for retry tests
  let depositor: StarkNetDepositorInterface
  let originalPost: any
  let postCallCount: number
  const starknetAddress =
    "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"

  const depositTx: BitcoinRawTxVectors = {
    version: Hex.from("02000000"),
    inputs: Hex.from("0101234567890abcdef01234567890abcdef"),
    outputs: Hex.from("01fedcba098765432101fedcba0987654321"),
    locktime: Hex.from("00000000"),
  }

  const deposit: DepositReceipt = {
    depositor: StarkNetAddress.from(starknetAddress),
    walletPublicKeyHash: Hex.from("1234567890abcdef1234567890abcdef12345678"),
    refundPublicKeyHash: Hex.from("abcdef1234567890abcdef1234567890abcdef12"),
    blindingFactor: Hex.from("f9f0c90d00039523"),
    refundLocktime: Hex.from("60920000"),
    extraData: undefined as any,
  }

  beforeEach(() => {
    depositor = new StarkNetDepositorInterface()
    depositor.setDepositOwner(StarkNetAddress.from(starknetAddress))
    deposit.extraData = depositor
      .extraDataEncoder()
      .encodeDepositOwner(StarkNetAddress.from(starknetAddress))

    originalPost = axios.post
    postCallCount = 0
  })

  afterEach(() => {
    axios.post = originalPost
  })

  describe("Retry on transient failures", () => {
    it("should retry on network timeout error up to 3 times", async () => {
      const timeoutError = new Error("timeout")
      ;(timeoutError as any).code = "ECONNABORTED"
      ;(timeoutError as any).isAxiosError = true

      postCallCount = 0
      axios.post = async () => {
        postCallCount++
        throw timeoutError
      }

      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
        expect.fail("Should have thrown error")
      } catch (e: any) {
        expect(e.message).to.equal(
          "Relayer request timed out. Please try again."
        )
        expect(postCallCount).to.equal(4) // Initial + 3 retries
      }
    })

    it("should retry on network error (ECONNREFUSED)", async () => {
      const networkError = new Error("connect ECONNREFUSED")
      ;(networkError as any).code = "ECONNREFUSED"
      ;(networkError as any).isAxiosError = true

      postCallCount = 0
      axios.post = async () => {
        postCallCount++
        throw networkError
      }

      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
        expect.fail("Should have thrown error")
      } catch (e: any) {
        expect(e.message).to.equal("Network error: connect ECONNREFUSED")
        expect(postCallCount).to.equal(4)
      }
    })

    it("should retry on 500 server error", async () => {
      const serverError = new Error("Internal Server Error")
      ;(serverError as any).response = { status: 500 }
      ;(serverError as any).isAxiosError = true

      postCallCount = 0
      axios.post = async () => {
        postCallCount++
        throw serverError
      }

      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
        expect.fail("Should have thrown error")
      } catch (e: any) {
        expect(e.message).to.equal(
          "Relayer service temporarily unavailable. Please try again later."
        )
        expect(postCallCount).to.equal(4)
      }
    })

    it("should retry on 502 Bad Gateway", async () => {
      const gatewayError = new Error("Bad Gateway")
      ;(gatewayError as any).response = { status: 502 }
      ;(gatewayError as any).isAxiosError = true

      postCallCount = 0
      axios.post = async () => {
        postCallCount++
        throw gatewayError
      }

      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
        expect.fail("Should have thrown error")
      } catch (e: any) {
        expect(e.message).to.equal("Network error: Bad Gateway")
        expect(postCallCount).to.equal(4)
      }
    })

    it("should retry on 503 Service Unavailable", async () => {
      const unavailableError = new Error("Service Unavailable")
      ;(unavailableError as any).response = { status: 503 }
      ;(unavailableError as any).isAxiosError = true

      postCallCount = 0
      axios.post = async () => {
        postCallCount++
        throw unavailableError
      }

      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
        expect.fail("Should have thrown error")
      } catch (e: any) {
        expect(e.message).to.equal("Network error: Service Unavailable")
        expect(postCallCount).to.equal(4)
      }
    })

    it("should succeed if retry succeeds", async () => {
      const timeoutError = new Error("timeout")
      ;(timeoutError as any).code = "ECONNABORTED"
      ;(timeoutError as any).isAxiosError = true

      postCallCount = 0
      axios.post = async () => {
        postCallCount++
        if (postCallCount < 3) {
          throw timeoutError
        }
        return {
          data: {
            success: true,
            transactionHash: "0xabc123",
          },
        }
      }

      const result = await depositor.initializeDeposit(depositTx, 0, deposit)
      expect(result.toString()).to.equal("abc123")
      expect(postCallCount).to.equal(3)
    })

    it("should verify retry timing behavior", async () => {
      const timeoutError = new Error("timeout")
      ;(timeoutError as any).code = "ECONNABORTED"
      ;(timeoutError as any).isAxiosError = true

      const attemptTimes: number[] = []
      axios.post = async () => {
        attemptTimes.push(Date.now())
        throw timeoutError
      }

      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
      } catch (e: any) {
        // Check that we made 4 attempts
        expect(attemptTimes.length).to.equal(4)

        // Check delays between attempts (allowing some tolerance)
        if (attemptTimes.length >= 2) {
          const delay1 = attemptTimes[1] - attemptTimes[0]
          expect(delay1).to.be.at.least(900).and.at.most(1100) // ~1s
        }
        if (attemptTimes.length >= 3) {
          const delay2 = attemptTimes[2] - attemptTimes[1]
          expect(delay2).to.be.at.least(1900).and.at.most(2100) // ~2s
        }
        if (attemptTimes.length >= 4) {
          const delay3 = attemptTimes[3] - attemptTimes[2]
          expect(delay3).to.be.at.least(3900).and.at.most(4100) // ~4s
        }
      }
    })
  })

  describe("No retry on non-transient failures", () => {
    it("should not retry on 400 Bad Request", async () => {
      const badRequestError = new Error("Bad Request")
      ;(badRequestError as any).response = {
        status: 400,
        data: { error: "Invalid deposit data" },
      }
      ;(badRequestError as any).isAxiosError = true

      postCallCount = 0
      axios.post = async () => {
        postCallCount++
        throw badRequestError
      }

      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
        expect.fail("Should have thrown error")
      } catch (e: any) {
        expect(e.message).to.equal("Relayer error: Invalid deposit data")
        expect(postCallCount).to.equal(1)
      }
    })

    it("should not retry on 401 Unauthorized", async () => {
      const unauthorizedError = new Error("Unauthorized")
      ;(unauthorizedError as any).response = { status: 401 }
      ;(unauthorizedError as any).isAxiosError = true

      postCallCount = 0
      axios.post = async () => {
        postCallCount++
        throw unauthorizedError
      }

      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
        expect.fail("Should have thrown error")
      } catch (e: any) {
        expect(e.message).to.equal("Relayer request failed: Unauthorized")
        expect(postCallCount).to.equal(1)
      }
    })

    it("should not retry on 403 Forbidden", async () => {
      const forbiddenError = new Error("Forbidden")
      ;(forbiddenError as any).response = { status: 403 }
      ;(forbiddenError as any).isAxiosError = true

      postCallCount = 0
      axios.post = async () => {
        postCallCount++
        throw forbiddenError
      }

      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
        expect.fail("Should have thrown error")
      } catch (e: any) {
        expect(e.message).to.equal("Relayer request failed: Forbidden")
        expect(postCallCount).to.equal(1)
      }
    })

    it("should not retry on 404 Not Found", async () => {
      const notFoundError = new Error("Not Found")
      ;(notFoundError as any).response = { status: 404 }
      ;(notFoundError as any).isAxiosError = true

      postCallCount = 0
      axios.post = async () => {
        postCallCount++
        throw notFoundError
      }

      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
        expect.fail("Should have thrown error")
      } catch (e: any) {
        expect(e.message).to.equal("Relayer request failed: Not Found")
        expect(postCallCount).to.equal(1)
      }
    })
  })
})
