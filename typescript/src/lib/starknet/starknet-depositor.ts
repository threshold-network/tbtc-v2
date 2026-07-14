import {
  BitcoinDepositor,
  ChainIdentifier,
  ExtraDataEncoder,
} from "../contracts"
import { BitcoinRawTxVectors } from "../bitcoin"
import { DepositReceipt } from "../contracts/bridge"
import { StarkNetAddress } from "./address"
import { StarkNetExtraDataEncoder } from "./extra-data-encoder"
import { StarkNetProvider } from "./types"
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
 * Status of a deposit as reported by the relayer's deposit-status endpoint.
 * Mirrors the relayer's own DepositStatus enum.
 */
export enum RelayerDepositStatus {
  // eslint-disable-next-line no-unused-vars
  QUEUED = 0,
  // eslint-disable-next-line no-unused-vars
  INITIALIZED = 1,
  // eslint-disable-next-line no-unused-vars
  FINALIZED = 2,
}

/**
 * Relayer response for the deposit-status endpoint.
 */
interface RelayerDepositStatusResponse {
  success: boolean
  depositId?: string
  status?: RelayerDepositStatus
  message?: string
  error?: string
  receipt?: {
    transactionHash: string
    blockNumber?: number
    status?: number
  }
}

/**
 * Thrown when the relayer reports that a deposit reveal already exists
 * (HTTP 409) instead of confirming a new, successful initialization.
 *
 * A 409 alone is not proof that L1 initialization succeeded, so it is never
 * converted into a fabricated Hex or TransactionReceipt. This error
 * preserves whatever deposit ID and verified status could be recovered from
 * the relayer so the caller can poll the relayer or otherwise recover.
 */
export class RelayerDepositConflictError extends Error {
  constructor(
    message: string,
    public readonly depositId: string | undefined,
    public readonly status: RelayerDepositStatus | undefined,
    public readonly statusVerified: boolean
  ) {
    super(message)
    this.name = "RelayerDepositConflictError"
  }
}

/**
 * Configuration for StarkNetBitcoinDepositor
 */
export interface StarkNetBitcoinDepositorConfig {
  chainId: string
  relayerUrl?: string
  relayerStatusUrl?: string
  defaultVault?: string
}

/**
 * @deprecated Use StarkNetBitcoinDepositorConfig instead
 */
export type StarkNetDepositorConfig = StarkNetBitcoinDepositorConfig

/**
 * Full implementation of the BitcoinDepositor interface for StarkNet.
 * This implementation uses a StarkNet provider for operations and supports
 * deposit initialization through the relayer endpoint.
 *
 * Unlike other destination chains, StarkNet deposits are primarily handled through L1
 * contracts, with this depositor serving as a provider-aware interface for
 * future L2 functionality and relayer integration.
 */
export class StarkNetBitcoinDepositor implements BitcoinDepositor {
  readonly #extraDataEncoder = new StarkNetExtraDataEncoder()
  readonly #config: StarkNetBitcoinDepositorConfig
  readonly #chainName: string
  readonly #provider: StarkNetProvider
  #depositOwner: ChainIdentifier | undefined

  /**
   * Creates a new StarkNetBitcoinDepositor instance.
   * @param config Configuration containing chainId and other chain-specific settings
   * @param chainName Name of the chain (should be "StarkNet")
   * @param provider StarkNet provider for blockchain interactions (Provider or Account)
   * @throws Error if provider is not provided
   */
  constructor(
    config: StarkNetBitcoinDepositorConfig,
    chainName: string,
    provider: StarkNetProvider
  ) {
    if (!provider) {
      throw new Error("Provider is required for StarkNet depositor")
    }

    // Set default relayer URLs based on chainId if not provided
    const enhancedConfig = { ...config }
    if (!enhancedConfig.relayerUrl || !enhancedConfig.relayerStatusUrl) {
      // Check if we're in development mode
      const isDevelopment =
        typeof window !== "undefined" &&
        (window.location.hostname === "localhost" ||
          window.location.hostname === "127.0.0.1") &&
        false

      // Determine chain name for URL (using PascalCase to match relayer chainName)
      const chainNameMap: Record<string, string> = {
        "0x534e5f474f45524c49": "StarknetTestnet", // SN_GOERLI
        "0x534e5f5345504f4c4941": "StarknetTestnet", // SN_SEPOLIA - mapped to StarknetTestnet in relayer
        "0x534e5f4d41494e": "StarknetMainnet", // SN_MAIN
      }

      const relayerChainName = chainNameMap[config.chainId] || "StarknetTestnet"

      const relayerBaseUrl = isDevelopment
        ? `http://localhost:3001/api/${relayerChainName}`
        : `https://tbtc-crosschain-relayer-swmku.ondigitalocean.app/api/${relayerChainName}`

      if (!enhancedConfig.relayerUrl) {
        enhancedConfig.relayerUrl = `${relayerBaseUrl}/reveal`
      }
      // Deposit-status endpoint, sibling of the reveal endpoint above. Used
      // to verify the real outcome of a deposit the relayer reports as a
      // conflict (HTTP 409) instead of trusting the conflict response alone.
      if (!enhancedConfig.relayerStatusUrl) {
        enhancedConfig.relayerStatusUrl = `${relayerBaseUrl}/deposit`
      }
    }

    this.#config = Object.freeze(enhancedConfig)
    this.#chainName = chainName
    this.#provider = provider
  }

  /**
   * Gets the chain name for this depositor.
   * @returns The chain name (e.g., "StarkNet")
   */
  getChainName(): string {
    return this.#chainName
  }

  /**
   * Gets the StarkNet provider used by this depositor.
   * @returns The StarkNet provider instance
   */
  getProvider(): StarkNetProvider {
    return this.#provider
  }

  /**
   * Gets the chain-specific identifier of this contract.
   * @throws Always throws since StarkNet deposits are handled via L1.
   */
  // eslint-disable-next-line valid-jsdoc
  getChainIdentifier(): ChainIdentifier {
    throw new Error(
      "StarkNet depositor has no chain identifier. " +
        "Deposits are handled via L1 StarkNet Bitcoin Depositor."
    )
  }

  /**
   * Gets the identifier that should be used as the owner of deposits.
   * @returns The StarkNet address set as deposit owner, or undefined if not set.
   */
  getDepositOwner(): ChainIdentifier | undefined {
    return this.#depositOwner
  }

  /**
   * Sets the identifier that should be used as the owner of deposits.
   * @param depositOwner Must be a StarkNetAddress instance or undefined/null to clear.
   * @throws Error if the deposit owner is not a StarkNetAddress and not undefined/null.
   */
  // eslint-disable-next-line valid-jsdoc
  setDepositOwner(depositOwner: ChainIdentifier | undefined): void {
    // Allow clearing the deposit owner
    if (depositOwner === undefined || depositOwner === null) {
      this.#depositOwner = undefined
      return
    }

    // Validate that the deposit owner is a StarkNet address
    if (!(depositOwner instanceof StarkNetAddress)) {
      throw new Error("Deposit owner must be a StarkNet address")
    }

    this.#depositOwner = depositOwner
  }

  /**
   * Returns the extra data encoder for StarkNet.
   * @returns The StarkNetExtraDataEncoder instance.
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
   * If the relayer reports that the deposit already exists (HTTP 409), this
   * method verifies the deposit's real status through the relayer's
   * deposit-status endpoint before deciding how to respond. It only ever
   * returns a value here when the SDK can produce a real, verified
   * successful result; otherwise it throws a RelayerDepositConflictError
   * carrying the deposit ID and any verified status so the caller can poll
   * or otherwise recover.
   *
   * @param depositTx - The Bitcoin transaction data
   * @param depositOutputIndex - The output index of the deposit
   * @param deposit - The deposit receipt containing all deposit parameters
   * @param vault - Optional vault address
   * @returns The transaction hash or full transaction receipt from the relayer response
   * @throws Error if deposit owner not set or relayer returns unexpected response
   * @throws RelayerDepositConflictError if the relayer reports the deposit
   *         already exists and its successful initialization cannot be
   *         verified
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

    // Format addresses for relayer
    const formattedL2DepositOwner =
      this.formatStarkNetAddressAsBytes32(l2DepositOwner)
    const formattedL2Sender = this.formatStarkNetAddressAsBytes32(l2Sender)

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

        // A 409 means the relayer already has a record of this deposit.
        // That alone is not proof L1 initialization succeeded, so it can
        // never be converted into a fabricated Hex or TransactionReceipt.
        // Verify the deposit's real status before deciding how to respond.
        if (error.response?.status === 409) {
          return await this.handleDepositConflict(error)
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
    console.error("StarkNet depositor throwing error:", formattedError)
    throw new Error(formattedError)
  }

  /**
   * Handles a 409 Conflict response from the relayer, which means the
   * relayer already has a record of this deposit. Since that alone is not
   * proof that L1 initialization succeeded, this verifies the deposit's
   * real status through the relayer's deposit-status endpoint before ever
   * returning a success value. When the outcome cannot be verified as a
   * successful, complete initialization, it throws a
   * RelayerDepositConflictError carrying whatever deposit ID and status
   * could be recovered, so the caller can poll or otherwise recover.
   * @param error The Axios error produced by the 409 response
   * @returns A verified successful initialization result, if one exists
   * @throws RelayerDepositConflictError if the deposit cannot be verified
   *         as successfully initialized
   */
  // eslint-disable-next-line valid-jsdoc
  private async handleDepositConflict(
    error: any
  ): Promise<Hex | TransactionReceipt> {
    const errorData = error.response?.data
    const depositId: string | undefined =
      typeof errorData?.depositId === "string" && errorData.depositId.length > 0
        ? errorData.depositId
        : undefined

    console.warn(
      "Relayer reported a deposit conflict (409); verifying its status " +
        "before treating it as an outcome:",
      { depositId }
    )

    let status: RelayerDepositStatus | undefined
    let statusVerified = false
    let statusReceipt: RelayerDepositStatusResponse["receipt"]

    if (depositId) {
      try {
        const statusResponse = await this.queryRelayerDepositStatus(depositId)
        if (
          statusResponse &&
          typeof statusResponse.status === "number" &&
          RelayerDepositStatus[statusResponse.status] !== undefined
        ) {
          status = statusResponse.status
          statusVerified = true
          statusReceipt = statusResponse.receipt
        }
      } catch (statusError) {
        console.warn(
          "Failed to verify deposit status with the relayer:",
          statusError
        )
      }
    }

    // Only ever return success once the relayer has verifiably confirmed
    // the deposit reached a terminal state AND supplied the receipt data
    // the documented return type requires. The relayer's deposit-status
    // endpoint does not currently return receipt data, so this remains
    // defensive for if/when it does.
    if (
      statusVerified &&
      (status === RelayerDepositStatus.INITIALIZED ||
        status === RelayerDepositStatus.FINALIZED) &&
      statusReceipt &&
      statusReceipt.transactionHash
    ) {
      return statusReceipt as TransactionReceipt
    }

    throw new RelayerDepositConflictError(
      this.formatConflictMessage(depositId, status, statusVerified),
      depositId,
      status,
      statusVerified
    )
  }

  /**
   * Queries the relayer's deposit-status endpoint for the current status of
   * a previously-revealed deposit.
   * @param depositId Canonical decimal deposit ID as reported by the relayer
   * @returns The parsed status response, or undefined if the relayer did
   *          not confirm a recognized status for the deposit
   */
  private async queryRelayerDepositStatus(
    depositId: string
  ): Promise<RelayerDepositStatusResponse | undefined> {
    if (!this.#config.relayerStatusUrl) {
      return undefined
    }

    const statusUrl = `${this.#config.relayerStatusUrl}/${encodeURIComponent(
      depositId
    )}`

    const response = await axios.get<RelayerDepositStatusResponse>(statusUrl, {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
      },
    })

    if (!response.data?.success) {
      return undefined
    }

    return response.data
  }

  /**
   * Builds a human-readable message describing an unresolved deposit
   * conflict, tailored to whatever status information could be verified.
   * @param depositId Canonical decimal deposit ID, if known
   * @param status Verified relayer status, if known
   * @param statusVerified Whether status reflects a verified relayer response
   * @returns A descriptive error message
   */
  private formatConflictMessage(
    depositId: string | undefined,
    status: RelayerDepositStatus | undefined,
    statusVerified: boolean
  ): string {
    const idSuffix = depositId ? ` (ID: ${depositId})` : ""

    if (statusVerified && status === RelayerDepositStatus.QUEUED) {
      return (
        `This deposit${idSuffix} is already queued at the relayer but has ` +
        "not yet been initialized on L1. It has not failed - check its " +
        "status again shortly or use the deposit ID to recover."
      )
    }

    if (
      statusVerified &&
      (status === RelayerDepositStatus.INITIALIZED ||
        status === RelayerDepositStatus.FINALIZED)
    ) {
      const statusName = RelayerDepositStatus[status]
      return (
        `This deposit${idSuffix} has already been ${statusName.toLowerCase()} ` +
        "at the relayer, but the SDK could not obtain a verified " +
        "transaction receipt for it. Check the deposit status " +
        "independently before retrying."
      )
    }

    return (
      `The relayer reports this deposit${idSuffix} already exists, but ` +
      "its status could not be verified. This may indicate a prior " +
      "request partially succeeded; check the deposit status " +
      "independently before retrying."
    )
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

        // 409 (Conflict) is handled separately in handleDepositConflict,
        // which verifies deposit status before ever resolving or throwing,
        // so it never reaches this generic formatter.

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
   * Formats a StarkNet address to ensure it's a valid bytes32 value.
   * @param address The StarkNet address to format
   * @returns The formatted address with 0x prefix and 64 hex characters
   * @throws Error if the address is invalid
   */
  private formatStarkNetAddressAsBytes32(address: string): string {
    // Ensure 0x prefix
    if (!address.startsWith("0x")) {
      address = "0x" + address
    }

    // Must be exactly 66 characters (0x + 64 hex)
    if (address.length !== 66) {
      throw new Error(
        `Invalid StarkNet address length: ${address.length}. Expected 66 characters (0x + 64 hex).`
      )
    }

    // Validate hex format
    if (!/^0x[0-9a-fA-F]{64}$/.test(address)) {
      throw new Error(
        `Invalid StarkNet address format: ${address}. Must be 0x followed by 64 hexadecimal characters.`
      )
    }

    return address.toLowerCase()
  }
}

/**
 * @deprecated Use StarkNetBitcoinDepositor instead
 */
export const StarkNetDepositor = StarkNetBitcoinDepositor
