import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
} from "../ethereum/adapter"
import { L2BitcoinRedeemer as L2BitcoinRedeemerTypechain } from "../../../typechain/L2BitcoinRedeemer"
import { ChainIdentifier, Chains, L2BitcoinRedeemer } from "../contracts"
import { EthereumAddress } from "../ethereum"
import { Hex } from "../utils"
import { BigNumber } from "ethers"

import BaseSepoliaL2BitcoinRedeemerDeployment from "./artifacts/baseSepolia/BaseL2BitcoinRedeemer.json"

/**
 * Implementation of the Base L2BitcoinRedeemer handle.
 * @see {L2BitcoinRedeemer} for reference.
 */
export class BaseL2BitcoinRedeemer
  extends EthersContractHandle<L2BitcoinRedeemerTypechain>
  implements L2BitcoinRedeemer
{
  constructor(config: EthersContractConfig, chainId: Chains.Base) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Base.BaseSepolia:
        deployment = BaseSepoliaL2BitcoinRedeemerDeployment
        break
      // TODO: Uncomment when Base L2BitcoinRedeemer is deployed
      // case Chains.Base.Base:
      //   deployment = BaseL2BitcoinRedeemerDeployment
      //   break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L2BitcoinDepositor#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return EthereumAddress.from(this._instance.address)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L2BitcoinRedeemer#requestRedemption}
   */
  async requestRedemption(
    amount: BigNumber,
    redeemerOutputScript: Hex,
    nonce: number
  ): Promise<Hex> {
    // Convert the output script to raw bytes buffer.
    const rawRedeemerOutputScript = redeemerOutputScript.toBuffer()
    // Prefix the output script bytes buffer with 0x and its own length.
    const prefixedRawRedeemerOutputScript = `0x${Buffer.concat([
      Buffer.from([rawRedeemerOutputScript.length]),
      rawRedeemerOutputScript,
    ]).toString("hex")}`

    const tx = await this._instance.requestRedemption(
      amount,
      prefixedRawRedeemerOutputScript,
      nonce
    )

    return Hex.from(tx.hash)
  }
}
