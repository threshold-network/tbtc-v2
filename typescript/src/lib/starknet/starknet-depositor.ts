import {
  L2BitcoinDepositor,
  ChainIdentifier,
  CrossChainExtraDataEncoder,
} from "../contracts"
import { BitcoinRawTxVectors } from "../bitcoin"
import { DepositReceipt } from "../contracts/bridge"
import { StarkNetAddress } from "./address"
import { StarkNetCrossChainExtraDataEncoder } from "./extra-data-encoder"
import { StarkNetProvider } from "./types"
import { Hex } from "../utils"

/**
 * Configuration for StarkNetDepositor
 */
export interface StarkNetDepositorConfig {
  chainId: string
}

/**
 * Full implementation of the L2BitcoinDepositor interface for StarkNet.
 * This implementation uses a StarkNet provider for operations and supports
 * deposit initialization through the relayer endpoint.
 * 
 * Unlike other L2 chains, StarkNet deposits are primarily handled through L1
 * contracts, with this depositor serving as a provider-aware interface for
 * future L2 functionality and relayer integration.
 */
export class StarkNetDepositor implements L2BitcoinDepositor {
  readonly #extraDataEncoder = new StarkNetCrossChainExtraDataEncoder()
  readonly #config: StarkNetDepositorConfig
  readonly #chainName: string
  readonly #provider: StarkNetProvider
  #depositOwner: ChainIdentifier | undefined

  /**
   * Creates a new StarkNetDepositor instance.
   * @param config Configuration containing chainId and other chain-specific settings
   * @param chainName Name of the chain (should be "StarkNet")
   * @param provider StarkNet provider for blockchain interactions (Provider or Account)
   * @throws Error if provider is not provided
   */
  constructor(
    config: StarkNetDepositorConfig,
    chainName: string,
    provider: StarkNetProvider
  ) {
    if (!provider) {
      throw new Error("Provider is required for StarkNet depositor")
    }
    
    this.#config = Object.freeze({ ...config })
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
   * @returns The StarkNetCrossChainExtraDataEncoder instance.
   */
  extraDataEncoder(): CrossChainExtraDataEncoder {
    return this.#extraDataEncoder
  }

  /**
   * Initializes a cross-chain deposit (to be implemented in T-007).
   * @throws Currently throws error - will be implemented with relayer support
   */
  // eslint-disable-next-line valid-jsdoc
  async initializeDeposit(
    _depositTx: BitcoinRawTxVectors,
    _depositOutputIndex: number,
    _deposit: DepositReceipt,
    _vault?: ChainIdentifier
  ): Promise<Hex> {
    throw new Error(
      "Deposit initialization will be implemented in T-007 with relayer support."
    )
  }
}