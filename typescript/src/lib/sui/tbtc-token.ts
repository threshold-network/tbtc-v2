import {
  DestinationChainTBTCToken,
  ChainIdentifier,
  Chains,
} from "../contracts"
import { BigNumber } from "ethers"
import { SuiAddress } from "./chain-identifier"
import { SuiClient, SuiCoinBalance, SuiError } from "./types"

/**
 * Implementation of the SUI TBTC token handle.
 * @see {DestinationChainTBTCToken} for reference.
 */
export class SuiTBTCToken implements DestinationChainTBTCToken {
  readonly #client: SuiClient
  readonly #coinType: string
  readonly #contractAddress: SuiAddress

  constructor(
    client: SuiClient,
    coinType: string,
    contractAddress: string,
    chainId: Chains.Sui
  ) {
    this.#client = client
    this.#coinType = coinType
    this.#contractAddress = SuiAddress.from(contractAddress)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {DestinationChainTBTCToken#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return this.#contractAddress
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {DestinationChainTBTCToken#balanceOf}
   */
  async balanceOf(identifier: ChainIdentifier): Promise<BigNumber> {
    try {
      // Query SUI network for coin balance
      const balance = (await this.#client.getBalance({
        owner: `0x${identifier.identifierHex}`,
        coinType: this.#coinType,
      })) as SuiCoinBalance

      // SUI uses 8 decimals, tBTC uses 18
      // Need to scale from 8 to 18 decimals (multiply by 10^10)
      const balanceInSuiDecimals = BigNumber.from(balance.totalBalance)
      const scaledBalance = balanceInSuiDecimals.mul(BigNumber.from(10).pow(10))

      return scaledBalance
    } catch (error) {
      throw new SuiError(
        `Failed to fetch tBTC balance for ${identifier.identifierHex}`,
        error
      )
    }
  }
}
