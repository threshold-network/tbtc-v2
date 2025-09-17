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
import { EthereumAddress } from "../ethereum"
import { BigNumber } from "ethers"

import SeiL2TBTCTokenDeployment from "./artifacts/sei/L2TBTC.json"
import SeiAtlanticL2TBTCTokenDeployment from "./artifacts/seiAtlantic/L2TBTC.json"

/**
 * Implementation of the Sei DestinationChainTBTCToken handle.
 * Uses the canonical L2TBTC contract deployed on Sei EVM.
 * @see {DestinationChainTBTCToken} for reference.
 */
export class SeiTBTCToken
  extends EthersContractHandle<L2TBTCTypechain>
  implements DestinationChainTBTCToken
{
  constructor(config: EthersContractConfig, chainId: Chains.Sei) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Sei.SeiAtlantic:
        deployment = SeiAtlanticL2TBTCTokenDeployment
        break
      case Chains.Sei.Sei:
        deployment = SeiL2TBTCTokenDeployment
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
 * @deprecated Use SeiTBTCToken instead
 */
export const SeiL2TBTCToken = SeiTBTCToken
