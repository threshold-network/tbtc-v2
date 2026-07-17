import { bytesToHex } from "viem"
import {
  asDeployment,
  EthereumContractConfig,
  EvmContractDeployment,
  EvmContractHandle,
} from "./adapter"
import {
  ChainIdentifier,
  Chains,
  DestinationChainName,
  L1BitcoinRedeemer,
} from "../contracts"
import { Hex } from "../utils"

import SepoliaL1BitcoinRedeemerDeployment from "./artifacts/sepolia/L1BitcoinRedeemer.json"
import MainnetBaseL1BitcoinRedeemerDeployment from "./artifacts/mainnet/L1BitcoinRedeemer.json"
import MainnetArbitrumL1BitcoinRedeemerDeployment from "./artifacts/mainnet/L1BitcoinRedeemer.json"
import { BitcoinHashUtils, BitcoinUtxo } from "../bitcoin"


const artifactLoader = {
  getMainnet: (l2ChainName: DestinationChainName) => {
    switch (l2ChainName) {
      case "Base":
        return asDeployment(MainnetBaseL1BitcoinRedeemerDeployment)
      case "Arbitrum":
        return asDeployment(MainnetArbitrumL1BitcoinRedeemerDeployment)
      default:
        throw new Error("Unsupported destination chain")
    }
  },

  getSepolia: (l2ChainName: DestinationChainName) => {
    if (l2ChainName === "Base" || l2ChainName === "Arbitrum") {
      return asDeployment(SepoliaL1BitcoinRedeemerDeployment)
    }
    throw new Error("Unsupported destination chain")
  },
}

/**
 * Implementation of the Ethereum L1BitcoinRedeemer handle. It can be
 * constructed for each supported L2 chain.
 * @see {L1BitcoinRedeemer} for reference.
 */
export class EthereumL1BitcoinRedeemer
  extends EvmContractHandle
  implements L1BitcoinRedeemer
{
  constructor(
    config: EthereumContractConfig,
    chainId: Chains.Ethereum,
    l2ChainName: DestinationChainName
  ) {
    let deployment: EvmContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Sepolia:
        deployment = artifactLoader.getSepolia(l2ChainName)
        break
      case Chains.Ethereum.Mainnet:
        deployment = artifactLoader.getMainnet(l2ChainName)
        break
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
    return this.getAddress()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L1BitcoinRedeemer#requestRedemption}
   */
  async requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    encodedVm: Hex | Uint8Array
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

    const encodedVmParam =
      encodedVm instanceof Uint8Array
        ? bytesToHex(encodedVm)
        : encodedVm.toPrefixedString()

    return this._write("requestRedemption", [
      walletPublicKeyHash,
      mainUtxoParam,
      encodedVmParam,
    ])
  }
}
