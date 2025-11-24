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

import SeiL2TBTCTokenDeployment from "./artifacts/seiMainnet/SeiTBTC.json"
import SeiTestnetL2TBTCTokenDeployment from "./artifacts/seiTestnet/SeiTBTC.json"

/**
 * Implementation of the Sei DestinationChainTBTCToken handle.
 * @see {DestinationChainTBTCToken} for reference.
 */
export class SeiTBTCToken
  extends EthersContractHandle<L2TBTCTypechain>
  implements DestinationChainTBTCToken
{
  constructor(config: EthersContractConfig, chainId: Chains.Sei) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Sei.Testnet:
        deployment = SeiTestnetL2TBTCTokenDeployment
        break
      case Chains.Sei.Mainnet:
        deployment = SeiL2TBTCTokenDeployment
        break
      default:
        throw new Error(`Unsupported Sei chainId: ${chainId}`)
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
