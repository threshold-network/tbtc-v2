import { L2TBTCToken, ChainIdentifier } from "../contracts"
import { BigNumber } from "ethers"
import { StarkNetAddress } from "./address"
import { Contract } from "starknet"
import { tbtcABI } from "./abi"
import { StarkNetProvider } from "./types"

/**
 * Configuration for StarkNetTBTCToken
 */
export interface StarkNetTBTCTokenConfig {
  chainId: string
  tokenContract: string
}

/**
 * Implementation of the L2TBTCToken interface for StarkNet.
 * This implementation now supports balance queries using deployed
 * tBTC contracts on StarkNet.
 */
export class StarkNetTBTCToken implements L2TBTCToken {
  private readonly config: StarkNetTBTCTokenConfig
  private readonly provider: StarkNetProvider
  private readonly contract: Contract

  /**
   * Creates a new StarkNetTBTCToken instance.
   * @param config Configuration containing chainId and token contract address
   * @param provider StarkNet provider for blockchain interaction
   * @throws Error if provider is not provided or config is invalid
   */
  constructor(config: StarkNetTBTCTokenConfig, provider: StarkNetProvider) {
    if (!provider) {
      throw new Error("Provider is required for balance queries")
    }

    if (!config || !config.tokenContract) {
      throw new Error("Token contract address is required")
    }

    this.config = config
    this.provider = provider
    this.contract = new Contract(tbtcABI, config.tokenContract, provider)
  }

  /**
   * Gets the chain-specific identifier of this contract.
   * @throws Always throws since StarkNet doesn't have an L2 contract identifier.
   */
  // eslint-disable-next-line valid-jsdoc
  getChainIdentifier(): ChainIdentifier {
    throw new Error(
      "StarkNet TBTC token interface has no chain identifier. " +
        "Token operations are not supported on StarkNet yet."
    )
  }

  /**
   * Returns the balance of the given identifier.
   * @param identifier Must be a StarkNetAddress instance.
   * @returns The balance as a BigNumber
   */
  async balanceOf(identifier: ChainIdentifier): Promise<BigNumber> {
    if (!(identifier instanceof StarkNetAddress)) {
      throw new Error("Address must be a StarkNet address")
    }
    throw new Error("Token operations are not supported on StarkNet yet.")
  }

  /**
   * Gets the balance for a StarkNet address.
   * @param identifier Must be a StarkNetAddress instance
   * @returns The balance as a BigNumber
   * @throws Error if address is not a StarkNetAddress
   */
  async getBalance(identifier: ChainIdentifier): Promise<BigNumber> {
    if (!(identifier instanceof StarkNetAddress)) {
      throw new Error("Address must be a StarkNet address")
    }

    try {
      // Use call instead of invoke for read-only operations
      // For StarkNet addresses, we need to pass as a single felt (field element)
      // Convert the padded hex to a decimal string for StarkNet.js
      const addressHex = "0x" + identifier.identifierHex
      const result = await this.contract.call("balanceOf", [addressHex])

      // Result should be an array, take the first element
      const balance = Array.isArray(result) ? result[0] : result

      // Convert the result to BigNumber
      return BigNumber.from(balance.toString())
    } catch (error) {
      throw new Error(`Failed to get balance: ${error}`)
    }
  }

  /**
   * Returns the configuration for this token instance.
   * @returns The configuration object
   */
  getConfig(): StarkNetTBTCTokenConfig {
    return this.config
  }

  /**
   * Returns the total supply of the token.
   * @param _identifier Not used for total supply query
   * @returns The total supply as a BigNumber
   * @throws Not implemented yet
   */
  async totalSupply(_identifier: ChainIdentifier): Promise<BigNumber> {
    throw new Error("Not implemented yet")
  }
}
