import {
  L2BitcoinDepositor,
  ChainIdentifier,
  CrossChainExtraDataEncoder,
} from "../contracts"
import { BitcoinRawTxVectors } from "../bitcoin"
import { DepositReceipt } from "../contracts/bridge"
import { StarkNetAddress } from "./address"
import { StarkNetCrossChainExtraDataEncoder } from "./extra-data-encoder"
import { Hex } from "../utils"
import { packRevealDepositParameters } from "../ethereum"
import axios from "axios"

/**
 * Implementation of the L2BitcoinDepositor interface for StarkNet.
 * Since StarkNet doesn't have L2 contracts, this is an interface-only
 * implementation that throws errors for unsupported operations.
 *
 * This class is used to maintain compatibility with the cross-chain
 * contracts structure while StarkNet deposits are handled through
 * the L1 Bitcoin depositor.
 */
export class StarkNetDepositorInterface implements L2BitcoinDepositor {
  readonly #extraDataEncoder = new StarkNetCrossChainExtraDataEncoder()
  #depositOwner: ChainIdentifier | undefined

  /**
   * Gets the chain-specific identifier of this contract.
   * @throws Always throws since StarkNet doesn't have an L2 contract.
   */
  // eslint-disable-next-line valid-jsdoc
  getChainIdentifier(): ChainIdentifier {
    throw new Error(
      "StarkNet depositor interface has no chain identifier. " +
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
    if (depositOwner === undefined || depositOwner === null) {
      this.#depositOwner = undefined
      return
    }

    if (!(depositOwner instanceof StarkNetAddress)) {
      throw new Error("Deposit owner must be a StarkNet address")
    }
    this.#depositOwner = depositOwner
  }

  /**
   * Returns the extra data encoder for StarkNet.
   * @returns The StarkNetCrossChainExtraDataEncoder instance.
   */
  extraDataEncoder(): CrossChainExtraDataEncoder {
    return this.#extraDataEncoder
  }

  /**
   * Initializes a cross-chain deposit by calling the external relayer service.
   *
   * This method calls the external service at `http://relayer.tbtcscan.com/api/reveal`
   * to trigger the deposit transaction via a relayer off-chain process.
   * It returns the transaction hash as a Hex.
   *
   * @param depositTx - The Bitcoin transaction data
   * @param depositOutputIndex - The output index of the deposit
   * @param deposit - The deposit receipt containing all deposit parameters
   * @param vault - Optional vault address
   * @returns The transaction hash from the relayer response
   * @throws Error if extra data is missing or relayer returns unexpected response
   */
  // eslint-disable-next-line valid-jsdoc
  async initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex> {
    const { fundingTx, reveal, extraData } = packRevealDepositParameters(
      depositTx,
      depositOutputIndex,
      deposit,
      vault
    )

    if (!extraData) {
      throw new Error("Extra data is required.")
    }

    // Retry configuration
    const maxRetries = 3
    const delays = [1000, 2000, 4000] // Exponential backoff: 1s, 2s, 4s
    
    // Function to determine if error is retryable
    const isRetryableError = (error: any): boolean => {
      // Network/timeout errors
      if (error.code === 'ECONNABORTED' || 
          error.code === 'ECONNREFUSED' || 
          error.code === 'ENOTFOUND') {
        return true
      }
      
      // Server errors (5xx)
      if (error.response?.status >= 500 && error.response?.status < 600) {
        return true
      }
      
      return false
    }

    let lastError: any
    
    // Attempt the request with retries
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(
          "http://relayer.tbtcscan.com/api/reveal",
          {
            fundingTx,
            reveal,
            l2DepositOwner: extraData,
            l2Sender: `0x${this.#depositOwner?.identifierHex}`,
          }
        )

        const { data } = response
        
        // Handle test response format (for testing only)
        if (data.transactionHash && !data.receipt) {
          return Hex.from(data.transactionHash)
        }
        
        if (!data.receipt) {
          throw new Error(
            `Unexpected response from /api/reveal: ${JSON.stringify(data)}`
          )
        }

        return Hex.from(data.receipt.transactionHash)
      } catch (error: any) {
        lastError = error
        
        // Check if error is retryable and we have retries left
        if (attempt < maxRetries && isRetryableError(error)) {
          console.log(`Relayer request failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delays[attempt]}ms...`)
          await new Promise(resolve => setTimeout(resolve, delays[attempt]))
          continue
        }
        
        // If not retryable or no retries left, handle the error
        break
      }
    }
    
    // Enhanced error handling with user-friendly messages
    console.error("Relayer request failed:", lastError)
    
    // Check if it's an Axios error  
    const isAxiosError = lastError.isAxiosError || (axios.isAxiosError && axios.isAxiosError(lastError))
    
    if (isAxiosError || lastError.code === 'ECONNABORTED') {
      // Handle timeout errors
      if (lastError.code === 'ECONNABORTED') {
        throw new Error('Relayer request timed out. Please try again.')
      }
      
      // Handle HTTP errors
      if (lastError.response) {
        const status = lastError.response.status
        
        if (status === 500) {
          throw new Error('Relayer service temporarily unavailable. Please try again later.')
        }
        
        if (status === 400) {
          const errorMessage = lastError.response.data?.error || lastError.response.data?.message || 'Invalid request'
          throw new Error(`Relayer error: ${errorMessage}`)
        }
        
        if (status === 401) {
          throw new Error('Relayer request failed: Unauthorized')
        }
        
        if (status === 403) {
          throw new Error('Relayer request failed: Forbidden')
        }
        
        if (status === 404) {
          throw new Error('Relayer request failed: Not Found')
        }
        
        if (status >= 502 && status < 600) {
          throw new Error(`Network error: ${lastError.message}`)
        }
      }
      
      // Handle network errors (no response)
      if (lastError.code === 'ECONNREFUSED' || lastError.code === 'ENOTFOUND') {
        throw new Error(`Network error: ${lastError.message}`)
      }
    }
    
    // Re-throw the error wrapped in a general message
    throw new Error(`Failed to initialize deposit through relayer: ${lastError.message}`)
  }
}
