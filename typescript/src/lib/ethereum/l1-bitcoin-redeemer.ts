import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
} from "./adapter"
import { L1BitcoinRedeemer as L1BitcoinRedeemerTypechain } from "../../../typechain/L1BitcoinRedeemer"
import {
  ChainIdentifier,
  Chains,
  L1BitcoinRedeemer,
  L2Chain,
} from "../contracts"
import { EthereumAddress } from "./index"
import { Hex } from "../utils"

import SepoliaBaseL1BitcoinRedeemerDeployment from "./artifacts/sepolia/BaseL1BitcoinRedeemer.json"
import SepoliaArbitrumL1BitcoinRedeemerDeployment from "./artifacts/sepolia/ArbitrumL1BitcoinRedeemer.json"
import { BitcoinHashUtils, BitcoinUtxo } from "../bitcoin"

const artifactLoader = {
  // TODO: Add mainnet deployment artifacts and uncomment this
  // getMainnet: (l2ChainName: L2Chain) => {
  //   switch (l2ChainName) {
  //     case "Base":
  //       return MainnetBaseL1BitcoinRedeemerDeployment
  //     case "Arbitrum":
  //       return MainnetArbitrumL1BitcoinRedeemerDeployment
  //     default:
  //       throw new Error("Unsupported L2 chain")
  //   }
  // },

  getSepolia: (l2ChainName: L2Chain) => {
    switch (l2ChainName) {
      case "Base":
        return SepoliaBaseL1BitcoinRedeemerDeployment
      case "Arbitrum":
        return SepoliaArbitrumL1BitcoinRedeemerDeployment
      default:
        throw new Error("Unsupported L2 chain")
    }
  },
}

/**
 * Implementation of the Ethereum L1BitcoinRedeemer handle. It can be
 * constructed for each supported L2 chain.
 * @see {L1BitcoinRedeemer} for reference.
 */
export class EthereumL1BitcoinRedeemer
  extends EthersContractHandle<L1BitcoinRedeemerTypechain>
  implements L1BitcoinRedeemer
{
  constructor(
    config: EthersContractConfig,
    chainId: Chains.Ethereum,
    l2ChainName: L2Chain
  ) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Sepolia:
        deployment = artifactLoader.getSepolia(l2ChainName)
        break
      // TODO: Add mainnet deployment artifacts and uncomment this
      // case Chains.Ethereum.Mainnet:
      //   deployment = artifactLoader.getMainnet(l2ChainName)
      //   break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L1BitcoinRedeemer#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return EthereumAddress.from(this._instance.address)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L1BitcoinRedeemer#requestRedemption}
   */
  async requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    encodedVm: Hex
  ): Promise<Hex> {
    const walletPublicKeyHash =
      BitcoinHashUtils.computeHash160(walletPublicKey).toPrefixedString()

    const mainUtxoParam = {
      // The L1BitcoinRedeemer expects this hash to be in the Bitcoin internal
      // byte order.
      txHash: mainUtxo.transactionHash.reverse().toPrefixedString(),
      txOutputIndex: mainUtxo.outputIndex,
      txOutputValue: mainUtxo.value,
    }

    const tx = await this._instance.requestRedemption(
      walletPublicKeyHash,
      mainUtxoParam,
      encodedVm
    )

    return Hex.from(tx.hash)
  }
}
