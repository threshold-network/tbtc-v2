import {
  asDeployment,
  EthereumContractConfig,
  EvmContractDeployment,
  EvmContractHandle,
} from "../ethereum/adapter"
import {
  ChainIdentifier,
  Chains,
  DestinationChainTBTCToken,
} from "../contracts"

import ArbitrumL2TBTCTokenDeployment from "./artifacts/arbitrumOne/ArbitrumTBTC.json"
import ArbitrumSepoliaL2TBTCTokenDeployment from "./artifacts/arbitrumSepolia/ArbitrumTBTC.json"

/**
 * Implementation of the Arbitrum DestinationChainTBTCToken handle.
 * @see {DestinationChainTBTCToken} for reference.
 */
export class ArbitrumTBTCToken
  extends EvmContractHandle
  implements DestinationChainTBTCToken
{
  constructor(config: EthereumContractConfig, chainId: Chains.Arbitrum) {
    let deployment: EvmContractDeployment

    switch (chainId) {
      case Chains.Arbitrum.ArbitrumSepolia:
        deployment = asDeployment(ArbitrumSepoliaL2TBTCTokenDeployment)
        break
      case Chains.Arbitrum.Arbitrum:
        deployment = asDeployment(ArbitrumL2TBTCTokenDeployment)
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {DestinationChainTBTCToken#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return this.getAddress()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {DestinationChainTBTCToken#balanceOf}
   */
  async balanceOf(identifier: ChainIdentifier): Promise<bigint> {
    const balance = await this._read<bigint | number>("balanceOf", [
      `0x${identifier.identifierHex}`,
    ])

    return BigInt(balance)
  }
}

/**
 * @deprecated Use ArbitrumTBTCToken instead
 */
export const ArbitrumL2TBTCToken = ArbitrumTBTCToken
