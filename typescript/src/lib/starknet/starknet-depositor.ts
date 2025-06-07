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
 * Configuration for StarkNetBitcoinDepositor
 */
export interface StarkNetBitcoinDepositorConfig {
  chainId: string
  relayerUrl?: string
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

    // Set default relayer URL based on chainId if not provided
    const enhancedConfig = { ...config }
    if (!enhancedConfig.relayerUrl) {
      // Mainnet chainId: 0x534e5f4d41494e (SN_MAIN)
      if (config.chainId === "0x534e5f4d41494e") {
        enhancedConfig.relayerUrl = "https://relayer.tbtcscan.com/api/reveal"
      } else {
        // Default for testnet and other networks - use local relayer for testing
        enhancedConfig.relayerUrl =
          "http://localhost:3001/api/starknetTestnet/reveal"
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

    // Format addresses for relayer
    const formattedL2DepositOwner =
      this.formatStarkNetAddressAsBytes32(l2DepositOwner)
    const formattedL2Sender = this.formatStarkNetAddressAsBytes32(l2Sender)

    // Retry configuration
    const maxRetries = 3
    const delays = [1000, 2000, 4000] // Exponential backoff: 1s, 2s, 4s

    let lastError: any

    // Attempt the request with retries
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(
          this.#config.relayerUrl!,
          {
            fundingTx,
            reveal,
            // PRIMARY field for StarkNet (new requirement)
            destinationChainDepositOwner: formattedL2DepositOwner,
            // Backward compatibility fields
            l2DepositOwner: formattedL2DepositOwner,
            l2Sender: formattedL2Sender,
          },
          {
            timeout: 30000, // 30 seconds timeout
            headers: {
              "Content-Type": "application/json",
            },
          }
        )

        const { data } = response

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

        // Handle test response format (for testing only)
        if (data.transactionHash && !data.receipt) {
          return Hex.from(data.transactionHash)
        }

        if (!data.receipt) {
          throw new Error(
            `Unexpected response from ${
              this.#config.relayerUrl
            }: ${JSON.stringify(data)}`
          )
        }

        // Log deposit ID if available
        if (depositId) {
          console.log(`Deposit initialized with ID: ${depositId}`)
        }

        return Hex.from(data.receipt.transactionHash)
      } catch (error: any) {
        lastError = error

        // Check if error is retryable and we have retries left
        if (attempt < maxRetries && this.isRetryableError(error)) {
          // Retry after exponential backoff delay
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
          continue
        }

        // If not retryable or no retries left, handle the error
        break
      }
    }

    // Format and throw the error
    throw new Error(this.formatRelayerError(lastError))
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

        if (status === 500) {
          return "Relayer service temporarily unavailable. Please try again later."
        }

        if (status === 400) {
          const errorMessage =
            error.response.data?.error ||
            error.response.data?.message ||
            "Invalid request"
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
