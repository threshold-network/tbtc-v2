import { L2TBTCToken, ChainIdentifier } from "../contracts"
import { BigNumber } from "ethers"
import { StarkNetAddress } from "./address"

/**
 * Implementation of the L2TBTCToken interface for StarkNet.
 * Since StarkNet doesn't have L2 contracts, this is an interface-only
 * implementation that throws errors for unsupported operations.
 *
 * This class is used to maintain compatibility with the cross-chain
 * contracts structure. To check tBTC balances on StarkNet, users
 * should query the StarkNet chain directly.
 */
export class StarkNetTBTCToken implements L2TBTCToken {
  /**
   * Gets the chain-specific identifier of this contract.
   * @throws Always throws since StarkNet doesn't have an L2 contract.
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
   * @throws Always throws since balance queries must be done on StarkNet directly.
   */
  // eslint-disable-next-line valid-jsdoc
  async balanceOf(identifier: ChainIdentifier): Promise<BigNumber> {
    if (!(identifier instanceof StarkNetAddress)) {
      throw new Error("Address must be a StarkNet address")
    }

    throw new Error(
      "Cannot get balance via StarkNet interface. " +
        "Token operations are not supported on StarkNet yet."
    )
  }
}
