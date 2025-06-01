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
   * Initializes a cross-chain deposit.
   * @throws Always throws since StarkNet deposits must go through L1.
   */
  // eslint-disable-next-line valid-jsdoc
  async initializeDeposit(
    _depositTx: BitcoinRawTxVectors,
    _depositOutputIndex: number,
    _deposit: DepositReceipt,
    _vault?: ChainIdentifier
  ): Promise<Hex> {
    throw new Error(
      "Cannot initialize deposit via StarkNet interface. " +
      "Use L1 StarkNet Bitcoin Depositor instead."
    )
  }
}
