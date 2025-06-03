import { expect } from "chai"
import { StarkNetDepositorInterface } from "../../../src/lib/starknet/starknet-depositor-interface"
import { StarkNetAddress } from "../../../src/lib/starknet/address"
import { BitcoinRawTxVectors } from "../../../src/lib/bitcoin"
import { DepositReceipt } from "../../../src/lib/contracts/bridge"
import { Hex } from "../../../src/lib/utils"

// We need to mock axios globally since it's not injected
const axios = require("axios")

describe("StarkNet Depositor Interface - Enhanced Error Handling", () => {
  let depositor: StarkNetDepositorInterface
  let originalPost: any
  let depositTx: BitcoinRawTxVectors
  let deposit: DepositReceipt

  beforeEach(() => {
    depositor = new StarkNetDepositorInterface()
    originalPost = axios.post

    // Set up common test data
    const starknetAddress = "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
    depositor.setDepositOwner(StarkNetAddress.from(starknetAddress))

    depositTx = {
      version: Hex.from("02000000"),
      inputs: Hex.from("0101234567890abcdef01234567890abcdef"),
      outputs: Hex.from("01fedcba098765432101fedcba0987654321"),
      locktime: Hex.from("00000000"),
    }

    deposit = {
      depositor: StarkNetAddress.from(starknetAddress),
      walletPublicKeyHash: Hex.from("1234567890abcdef1234567890abcdef12345678"),
      refundPublicKeyHash: Hex.from("abcdef1234567890abcdef1234567890abcdef12"),
      blindingFactor: Hex.from("f9f0c90d00039523"),
      refundLocktime: Hex.from("60920000"),
      extraData: depositor
        .extraDataEncoder()
        .encodeDepositOwner(StarkNetAddress.from(starknetAddress)),
    }
  })

  afterEach(() => {
    axios.post = originalPost
  })

  describe("Network Timeout Error Handling", () => {
    it("should handle network timeout with clear message", async function() {
      this.timeout(10000) // Increase timeout to accommodate retry delays
      // Arrange
      const timeoutError = new Error("timeout of 5000ms exceeded")
      ;(timeoutError as any).code = "ECONNABORTED"
      
      axios.post = async () => {
        throw timeoutError
      }

      // Act & Assert
      await expect(depositor.initializeDeposit(depositTx, 0, deposit))
        .to.be.rejectedWith("Relayer request timed out. Please try again.")
    })

    it("should handle axios timeout error", async function() {
      this.timeout(10000) // Increase timeout to accommodate retry delays
      // Arrange
      const axiosError = {
        isAxiosError: true,
        code: "ECONNABORTED",
        message: "timeout exceeded",
      }
      
      // Mock axios.isAxiosError
      axios.isAxiosError = (error: any) => error.isAxiosError === true
      
      axios.post = async () => {
        throw axiosError
      }

      // Act & Assert
      await expect(depositor.initializeDeposit(depositTx, 0, deposit))
        .to.be.rejectedWith("Relayer request timed out. Please try again.")
    })
  })

  describe("Relayer Service Error Handling", () => {
    it("should handle relayer service error (500)", async function() {
      this.timeout(10000) // Increase timeout to accommodate retry delays
      // Arrange
      const serviceError = {
        isAxiosError: true,
        response: {
          status: 500,
          data: { error: "Internal server error" }
        },
        message: "Request failed with status code 500",
      }
      
      axios.isAxiosError = (error: any) => error.isAxiosError === true
      axios.post = async () => {
        throw serviceError
      }

      // Act & Assert
      await expect(depositor.initializeDeposit(depositTx, 0, deposit))
        .to.be.rejectedWith("Relayer service temporarily unavailable. Please try again later.")
    })

    it("should handle relayer bad request (400) with message", async () => {
      // Arrange
      const badRequestError = {
        isAxiosError: true,
        response: {
          status: 400,
          data: { message: "Invalid reveal data format" }
        },
        message: "Request failed with status code 400",
      }
      
      axios.isAxiosError = (error: any) => error.isAxiosError === true
      axios.post = async () => {
        throw badRequestError
      }

      // Act & Assert
      await expect(depositor.initializeDeposit(depositTx, 0, deposit))
        .to.be.rejectedWith("Relayer error: Invalid reveal data format")
    })

    it("should handle relayer bad request (400) without message", async () => {
      // Arrange
      const badRequestError = {
        isAxiosError: true,
        response: {
          status: 400,
          data: {}
        },
        message: "Request failed with status code 400",
      }
      
      axios.isAxiosError = (error: any) => error.isAxiosError === true
      axios.post = async () => {
        throw badRequestError
      }

      // Act & Assert
      await expect(depositor.initializeDeposit(depositTx, 0, deposit))
        .to.be.rejectedWith("Relayer error: Invalid request")
    })
  })

  describe("Invalid Response Format Handling", () => {
    it("should handle unexpected response structure", async () => {
      // Arrange
      axios.post = async () => {
        return { data: { unexpected: "format" } } // Missing 'receipt' field
      }

      // Act & Assert
      await expect(depositor.initializeDeposit(depositTx, 0, deposit))
        .to.be.rejectedWith(/Unexpected response from \/api\/reveal/)
    })

    it("should handle null response", async () => {
      // Arrange
      axios.post = async () => {
        return { data: null }
      }

      // Act & Assert
      await expect(depositor.initializeDeposit(depositTx, 0, deposit))
        .to.be.rejectedWith("Failed to initialize deposit through relayer")
    })

    it("should handle empty response", async () => {
      // Arrange
      axios.post = async () => {
        return { data: {} }
      }

      // Act & Assert
      await expect(depositor.initializeDeposit(depositTx, 0, deposit))
        .to.be.rejectedWith(/Unexpected response from \/api\/reveal/)
    })
  })

  describe("Network Error Handling", () => {
    it("should handle network connection error", async function() {
      this.timeout(10000) // Increase timeout to accommodate retry delays
      // Arrange
      const networkError = {
        isAxiosError: true,
        code: "ENOTFOUND",
        message: "getaddrinfo ENOTFOUND relayer.tbtcscan.com",
      }
      
      axios.isAxiosError = (error: any) => error.isAxiosError === true
      axios.post = async () => {
        throw networkError
      }

      // Act & Assert
      await expect(depositor.initializeDeposit(depositTx, 0, deposit))
        .to.be.rejectedWith("Network error: getaddrinfo ENOTFOUND relayer.tbtcscan.com")
    })

    it("should handle generic network error", async () => {
      // Arrange
      const genericError = new Error("Network error")
      axios.post = async () => {
        throw genericError
      }

      // Act & Assert
      await expect(depositor.initializeDeposit(depositTx, 0, deposit))
        .to.be.rejectedWith("Failed to initialize deposit through relayer: Network error")
    })
  })

  describe("Error Logging", () => {
    it("should log errors for debugging", async () => {
      // Arrange
      const error = new Error("Test error")
      const originalConsoleError = console.error
      let loggedMessage: string = ""
      let loggedError: any
      
      console.error = (message: string, err: any) => {
        loggedMessage = message
        loggedError = err
      }
      
      axios.post = async () => {
        throw error
      }

      // Act
      try {
        await depositor.initializeDeposit(depositTx, 0, deposit)
      } catch {
        // Expected to throw
      }

      // Assert
      expect(loggedMessage).to.equal("Relayer request failed:")
      expect(loggedError).to.equal(error)

      // Restore
      console.error = originalConsoleError
    })
  })
})