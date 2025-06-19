import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
} from "../ethereum/adapter"
import { L2TBTC as L2TBTCTypechain } from "../../../typechain/L2TBTC"
import {
  ChainIdentifier,
  Chains,
  DestinationChainTBTCToken,
} from "../contracts"
import { BigNumber } from "ethers"
import { EthereumAddress } from "../ethereum"

import BaseL2TBTCTokenDeployment from "./artifacts/base/BaseTBTC.json"
import BaseSepoliaL2TBTCTokenDeployment from "./artifacts/baseSepolia/BaseTBTC.json"

/**
 * Implementation of the Base DestinationChainTBTCToken handle.
 * @see {DestinationChainTBTCToken} for reference.
 */
export class BaseTBTCToken
  extends EthersContractHandle<L2TBTCTypechain>
  implements DestinationChainTBTCToken
{
  constructor(config: EthersContractConfig, chainId: Chains.Base) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Base.BaseSepolia:
        deployment = BaseSepoliaL2TBTCTokenDeployment
        break
      case Chains.Base.Base:
        deployment = BaseL2TBTCTokenDeployment
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
    return EthereumAddress.from(this._instance.address)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {DestinationChainTBTCToken#balanceOf}
   */
  balanceOf(identifier: ChainIdentifier): Promise<BigNumber> {
    return this._instance.balanceOf(`0x${identifier.identifierHex}`)
  }
}

// Backward compatibility alias
/**
 * @deprecated Use BaseTBTCToken instead
 */
export const BaseL2TBTCToken = BaseTBTCToken
