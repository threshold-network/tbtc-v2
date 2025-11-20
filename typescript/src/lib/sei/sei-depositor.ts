import {
  BitcoinDepositor,
  ChainIdentifier,
  Chains,
  ExtraDataEncoder,
} from "../contracts"
import { BitcoinRawTxVectors } from "../bitcoin"
import { DepositReceipt } from "../contracts/bridge"
import { SeiAddress } from "./address"
import { SeiExtraDataEncoder } from "./extra-data-encoder"
import { SeiProvider } from "./types"
import { Hex } from "../utils"
import { packRevealDepositParameters } from "../ethereum"
import axios from "axios"
import { ethers } from "ethers"
import { TransactionReceipt } from "@ethersproject/providers"

/**
 * Relayer request payload for revealing a deposit
 */
interface RelayerRevealRequest {
  fundingTx: {
    version: string
    inputVector: string
    outputVector: string
    locktime: string
  }
  reveal: {
    fundingOutputIndex: number
    blindingFactor: string
    walletPubKeyHash: string
    refundPubKeyHash: string
    refundLocktime: string
    vault: string
  }
  l2DepositOwner: string
  l2Sender: string
}

/**
 * Relayer response for reveal deposit endpoint
 */
interface RelayerRevealResponse {
  success: boolean
  depositId?: string
  message?: string
  receipt?: {
    transactionHash: string
    blockNumber?: number
    status?: number
  }
  error?: string
  details?: any
}

/**
 * Configuration for SeiBitcoinDepositor
 */
export interface SeiBitcoinDepositorConfig {
  chainId: string
  relayerUrl?: string
  defaultVault?: string
}

/**
 * Full implementation of the BitcoinDepositor interface for Sei.
 * This implementation uses a Sei provider for operations and supports
 * deposit initialization through the relayer endpoint.
 *
 * Like StarkNet, Sei deposits are handled through L1 contracts
 * (L1BTCDepositorNttWithExecutor), with this depositor serving as a
 * provider-aware interface for relayer integration.
 */
export class SeiBitcoinDepositor implements BitcoinDepositor {
  readonly #extraDataEncoder = new SeiExtraDataEncoder()
  readonly #config: SeiBitcoinDepositorConfig
  readonly #chainName: string
  readonly #provider: SeiProvider
  #depositOwner: ChainIdentifier | undefined

  /**
   * Creates a new SeiBitcoinDepositor instance.
   * @param config Configuration containing chainId and other chain-specific settings
   * @param chainName Name of the chain (should be "Sei")
   * @param provider Sei provider for blockchain interactions
   * @throws Error if provider is not provided
   */
  constructor(
    config: SeiBitcoinDepositorConfig,
    chainName: string,
    provider: SeiProvider
  ) {
    if (!provider) {
      throw new Error("Provider is required for Sei depositor")
    }

    // Set default relayer URL based on chainId if not provided
    const enhancedConfig = { ...config }
    if (!enhancedConfig.relayerUrl) {
      // Check if we're in development mode
      // Supports both browser (localhost/127.0.0.1) and Node.js (NODE_ENV) environments
      const isDevelopment =
        (typeof window !== "undefined" &&
          (window.location.hostname === "localhost" ||
            window.location.hostname === "127.0.0.1")) ||
        (typeof process !== "undefined" &&
          process.env?.NODE_ENV === "development")

      // Determine chain name for URL
      const chainName =
        config.chainId === Chains.Sei.Mainnet
          ? "SeiMainnet"
          : config.chainId === Chains.Sei.Testnet
            ? "SeiTestnet"
            : "SeiTestnet"

      if (isDevelopment) {
        // Use local relayer for development with chain-specific endpoint
        enhancedConfig.relayerUrl = `http://localhost:3001/api/${chainName}/reveal`
      } else {
        // Production URLs with chain-specific endpoint
        enhancedConfig.relayerUrl = `https://tbtc-crosschain-relayer-swmku.ondigitalocean.app/api/${chainName}/reveal`
      }
    }

    this.#config = Object.freeze(enhancedConfig)
    this.#chainName = chainName
    this.#provider = provider
  }

  /**
   * Gets the chain name for this depositor.
   * @returns The chain name (e.g., "Sei")
   */
  getChainName(): string {
    return this.#chainName
  }

  /**
   * Gets the Sei provider used by this depositor.
   * @returns The Sei provider instance
   */
  getProvider(): SeiProvider {
    return this.#provider
  }

  /**
   * Gets the chain-specific identifier of this contract.
   * @throws Always throws since Sei deposits are handled via L1.
   */
  // eslint-disable-next-line valid-jsdoc
  getChainIdentifier(): ChainIdentifier {
    throw new Error(
      "Sei depositor has no chain identifier. " +
        "Deposits are handled via L1 Sei Bitcoin Depositor (L1BTCDepositorNttWithExecutor)."
    )
  }

  /**
   * Gets the identifier that should be used as the owner of deposits.
   * @returns The Sei address set as deposit owner, or undefined if not set.
   */
  getDepositOwner(): ChainIdentifier | undefined {
    return this.#depositOwner
  }

  /**
   * Sets the identifier that should be used as the owner of deposits.
   * @param depositOwner Must be a SeiAddress instance or undefined/null to clear.
   * @throws Error if the deposit owner is not a SeiAddress and not undefined/null.
   */
  // eslint-disable-next-line valid-jsdoc
  setDepositOwner(depositOwner: ChainIdentifier | undefined): void {
    // Allow clearing the deposit owner
    if (depositOwner === undefined || depositOwner === null) {
      this.#depositOwner = undefined
      return
    }

    // Validate that the deposit owner is a Sei address
    if (!(depositOwner instanceof SeiAddress)) {
      throw new Error("Deposit owner must be a Sei address")
    }

    this.#depositOwner = depositOwner
  }

  /**
   * Returns the extra data encoder for Sei.
   * @returns The SeiExtraDataEncoder instance.
   */
  extraDataEncoder(): ExtraDataEncoder {
    return this.#extraDataEncoder
  }

  /**
   * Initializes a cross-chain deposit by calling the external relayer service.
   *
   * This method calls the external service to trigger the deposit transaction
   * via a relayer off-chain process. It returns the transaction hash as a Hex
   * or a full transaction receipt.
   *
   * @param depositTx - The Bitcoin transaction data
   * @param depositOutputIndex - The output index of the deposit
   * @param deposit - The deposit receipt containing all deposit parameters
   * @param vault - Optional vault address
   * @returns The transaction hash or full transaction receipt from the relayer response
   * @throws Error if deposit owner not set or relayer returns unexpected response
   */
  // eslint-disable-next-line valid-jsdoc
  async initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex | TransactionReceipt> {
    // Check if deposit owner is set
    if (!this.#depositOwner) {
      throw new Error(
        "L2 deposit owner must be set before initializing deposit"
      )
    }

    const { fundingTx, reveal } = packRevealDepositParameters(
      depositTx,
      depositOutputIndex,
      deposit,
      vault
    )

    // Use deposit owner from extraData if available, otherwise use the set owner
    const l2DepositOwner = deposit.extraData
      ? deposit.extraData.toString()
      : this.#depositOwner.toString()
    const l2Sender = this.#depositOwner.toString()

    // Format addresses for relayer (Sei uses EVM addresses, pad to bytes32)
    const formattedL2DepositOwner =
      this.formatSeiAddressAsBytes32(l2DepositOwner)
    const formattedL2Sender = this.formatSeiAddressAsBytes32(l2Sender)

    // Retry configuration
    const maxRetries = 3
    const delays = [3000, 6000, 12000] // Exponential backoff: 3s, 6s, 12s

    let lastError: any

    // Attempt the request with retries
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const requestPayload: RelayerRevealRequest = {
          fundingTx,
          reveal,
          l2DepositOwner: formattedL2DepositOwner,
          l2Sender: formattedL2Sender,
        }

        console.log(
          `Sending reveal request to relayer (attempt ${attempt + 1}/${
            maxRetries + 1
          }):`,
          {
            url: this.#config.relayerUrl,
            payload: requestPayload,
          }
        )

        const response = await axios.post<RelayerRevealResponse>(
          this.#config.relayerUrl!,
          requestPayload,
          {
            timeout: 90000, // 90 seconds timeout
            headers: {
              "Content-Type": "application/json",
            },
          }
        )

        const { data } = response
        console.log("Relayer response:", {
          status: response.status,
          success: data.success,
          depositId: data.depositId,
          hasReceipt: !!data.receipt,
        })

        // Calculate deposit ID
        let depositId: string | undefined
        try {
          // Get funding transaction hash - concatenate raw hex without 0x prefix
          const fundingTxComponents =
            depositTx.version.toString() +
            depositTx.inputs.toString() +
            depositTx.outputs.toString() +
            depositTx.locktime.toString()

          // Apply double SHA-256 (Bitcoin standard)
          const fundingTxHash = ethers.utils.keccak256(
            ethers.utils.keccak256("0x" + fundingTxComponents)
          )

          // Calculate deposit ID
          const depositIdHash = ethers.utils.solidityKeccak256(
            ["bytes32", "uint256"],
            [fundingTxHash, depositOutputIndex]
          )
          depositId = ethers.BigNumber.from(depositIdHash).toString()
        } catch (e) {
          console.warn("Failed to calculate deposit ID:", e)
        }

        // Validate response
        if (!data.success) {
          throw new Error(
            data.error ||
              `Relayer returned unsuccessful response: ${
                data.message || "Unknown error"
              }`
          )
        }

        if (!data.receipt || !data.receipt.transactionHash) {
          throw new Error(
            `Invalid response from relayer: missing receipt or transactionHash. Response: ${JSON.stringify(
              data
            )}`
          )
        }

        // Log deposit ID if available
        if (depositId) {
          console.log(`Deposit initialized with ID: ${depositId}`)
        }

        return data.receipt as TransactionReceipt
      } catch (error: any) {
        lastError = error

        // Special handling for 409 Conflict - deposit already exists
        if (error.response?.status === 409) {
          console.log(
            "Deposit already exists, checking response data:",
            error.response.data
          )

          // If the relayer returns deposit info in the error response, use it
          const errorData = error.response.data
          if (errorData?.depositId && errorData?.success === false) {
            // The deposit ID is a decimal string, convert it to hex
            try {
              const depositIdBigInt = BigInt(errorData.depositId)
              const depositIdHex = "0x" + depositIdBigInt.toString(16)
              console.log("Converted deposit ID to hex:", depositIdHex)
              return Hex.from(depositIdHex)
            } catch (conversionError) {
              console.error("Failed to convert deposit ID:", conversionError)
              // Continue with normal error handling
            }
          }
        }

        // Check if error is retryable and we have retries left
        if (attempt < maxRetries && this.isRetryableError(error)) {
          console.log(
            `Retryable error on attempt ${attempt + 1}, retrying in ${
              delays[attempt]
            }ms:`,
            {
              status: error.response?.status,
              code: error.code,
              message: error.message,
            }
          )
          // Retry after exponential backoff delay
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
          continue
        }

        // If not retryable or no retries left, handle the error
        break
      }
    }

    // Format and throw the error
    const formattedError = this.formatRelayerError(lastError)
    console.error("Sei depositor throwing error:", formattedError)
    throw new Error(formattedError)
  }

  /**
   * Determines if an error is retryable
   * @param error The error to check
   * @returns True if the error is retryable
   */
  private isRetryableError(error: any): boolean {
    // Network/timeout errors
    if (
      error.code === "ECONNABORTED" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ENOTFOUND"
    ) {
      return true
    }

    // Don't retry on 409 (Conflict) - deposit already exists
    if (error.response?.status === 409) {
      return false
    }

    // Server errors (5xx)
    if (error.response?.status >= 500 && error.response?.status < 600) {
      return true
    }

    return false
  }

  /**
   * Formats relayer errors into user-friendly messages
   * @param error The error to format
   * @returns Formatted error message
   */
  private formatRelayerError(error: any): string {
    // Check if it's an Axios error
    const isAxiosError = error.isAxiosError || axios.isAxiosError?.(error)

    if (isAxiosError || error.code === "ECONNABORTED") {
      // Handle timeout errors
      if (error.code === "ECONNABORTED") {
        return "Relayer request timed out. Please try again."
      }

      // Handle HTTP errors
      if (error.response) {
        const status = error.response.status
        const data = error.response.data as RelayerRevealResponse | any

        if (status === 500) {
          // Check if there's more specific error info
          const errorDetail =
            data?.error || data?.message || "Internal server error"
          return `Relayer service error: ${errorDetail}. Please try again in a few moments.`
        }

        if (status === 400) {
          // Check for structured error response
          const errorMessage =
            data?.error ||
            data?.message ||
            (data?.details
              ? `Invalid request: ${JSON.stringify(data.details)}`
              : "Invalid request")
          return `Relayer error: ${errorMessage}`
        }

        if (status === 401) {
          return "Relayer request failed: Unauthorized"
        }

        if (status === 403) {
          return "Relayer request failed: Forbidden"
        }

        if (status === 404) {
          return "Relayer request failed: Not Found"
        }

        if (status === 409) {
          // Deposit already exists - this might be okay, return the deposit ID if available
          const depositId = data?.depositId
          return `This deposit has already been initialized${
            depositId ? ` (ID: ${depositId})` : ""
          }. You can check the transaction status on Etherscan or wait for the bridging to complete (15-30 minutes).`
        }

        if (status >= 502 && status < 600) {
          return `Network error: ${error.message}`
        }
      }

      // Handle network errors (no response)
      if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
        return `Network error: ${error.message}`
      }
    }

    // Default error message
    return `Failed to initialize deposit through relayer: ${error.message}`
  }

  /**
   * Formats a Sei address to ensure it's a valid bytes32 value.
   * Sei uses EVM-compatible addresses (20 bytes), so we pad with zeros.
   * @param address The Sei address to format
   * @returns The formatted address with 0x prefix and 64 hex characters
   * @throws Error if the address is invalid
   */
  private formatSeiAddressAsBytes32(address: string): string {
    // Ensure 0x prefix
    if (!address.startsWith("0x")) {
      address = "0x" + address
    }

    // Validate EVM address format (0x + 40 hex chars = 20 bytes)
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(
        `Invalid Sei address format: ${address}. Must be a valid EVM address (0x + 40 hex characters).`
      )
    }

    // Remove 0x prefix and pad to 64 characters (32 bytes)
    const addressWithoutPrefix = address.slice(2)
    const paddedAddress = addressWithoutPrefix.padStart(64, "0")

    return `0x${paddedAddress}`.toLowerCase()
  }
}
