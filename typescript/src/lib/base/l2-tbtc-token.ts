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


import BaseL2TBTCTokenDeployment from "./artifacts/base/BaseTBTC.json"
import BaseSepoliaL2TBTCTokenDeployment from "./artifacts/baseSepolia/BaseTBTC.json"

/**
 * Implementation of the Base DestinationChainTBTCToken handle.
 * @see {DestinationChainTBTCToken} for reference.
 */
export class BaseTBTCToken
  extends EvmContractHandle
  implements DestinationChainTBTCToken
{
  constructor(config: EthereumContractConfig, chainId: Chains.Base) {
    let deployment: EvmContractDeployment

    switch (chainId) {
      case Chains.Base.BaseSepolia:
        deployment = asDeployment(BaseSepoliaL2TBTCTokenDeployment)
        break
      case Chains.Base.Base:
        deployment = asDeployment(BaseL2TBTCTokenDeployment)
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

// Backward compatibility alias
/**
 * @deprecated Use BaseTBTCToken instead
 */
export const BaseL2TBTCToken = BaseTBTCToken
