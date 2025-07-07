import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
} from "../ethereum/adapter"
import { ArbitrumL2BitcoinRedeemer as L2BitcoinRedeemerTypechain } from "../../../typechain/ArbitrumL2BitcoinRedeemer"
import { ChainIdentifier, Chains, L2BitcoinRedeemer } from "../contracts"
import { EthereumAddress } from "../ethereum"
import { Hex } from "../utils"
import { BigNumber, Contract } from "ethers"

import ArbitrumSepoliaL2BitcoinRedeemerDeployment from "./artifacts/arbitrumSepolia/ArbitrumL2BitcoinRedeemer.json"
import ArbitrumSepoliaWormholeCoreDeployment from "./artifacts/arbitrumSepolia/WormholeCore.json"
import { WORMHOLE_CHAIN_IDS } from "../utils/wormhole"
// TODO: Uncomment when Arbitrum L2BitcoinRedeemer is deployed
// import ArbitrumWormholeCoreDeployment from "./artifacts/arbitrum/WormholeCore.json"

/**
 * Implementation of the Arbitrum L2BitcoinRedeemer handle.
 * @see {L2BitcoinRedeemer} for reference.
 */
export class ArbitrumL2BitcoinRedeemer
  extends EthersContractHandle<L2BitcoinRedeemerTypechain>
  implements L2BitcoinRedeemer
{
  private readonly wormholeCore: Contract
  private readonly recipientChain: number

  constructor(config: EthersContractConfig, chainId: Chains.Arbitrum) {
    let deployment: EthersContractDeployment
    let wormholeCoreDeployment: EthersContractDeployment
    let recipientChain: number

    switch (chainId) {
      case Chains.Arbitrum.ArbitrumSepolia:
        deployment = ArbitrumSepoliaL2BitcoinRedeemerDeployment
        wormholeCoreDeployment = ArbitrumSepoliaWormholeCoreDeployment
        recipientChain = WORMHOLE_CHAIN_IDS[Chains.Ethereum.Sepolia] // Ethereum Sepolia
        break
      // TODO: Uncomment when Arbitrum L2BitcoinRedeemer is deployed
      // case Chains.Arbitrum.Arbitrum:
      //   deployment = ArbitrumL2BitcoinRedeemerDeployment
      //   wormholeCoreDeployment = ArbitrumWormholeCoreDeployment
      //   recipientChain = 2 // Ethereum mainnet
      //   break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)

    this.recipientChain = recipientChain
    // Initialize Wormhole core contract
    this.wormholeCore = new Contract(
      wormholeCoreDeployment.address,
      wormholeCoreDeployment.abi,
      config.signerOrProvider
    )
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

    // Get the Wormhole message fee
    const messageFee = await this.wormholeCore.messageFee()

    const tx = await this._instance.requestRedemption(
      amount,
      this.recipientChain,
      prefixedRawRedeemerOutputScript,
      nonce,
      { value: messageFee }
    )

    return Hex.from(tx.hash)
  }
}
