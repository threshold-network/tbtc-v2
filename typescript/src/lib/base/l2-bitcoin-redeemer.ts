import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
} from "../ethereum/adapter"
import { BaseL2BitcoinRedeemer as L2BitcoinRedeemerTypechain } from "../../../typechain/BaseL2BitcoinRedeemer"
import { ChainIdentifier, Chains, L2BitcoinRedeemer } from "../contracts"
import { EthereumAddress } from "../ethereum"
import { Hex } from "../utils"
import { BigNumber, Contract } from "ethers"

import BaseSepoliaL2BitcoinRedeemerDeployment from "./artifacts/baseSepolia/BaseL2BitcoinRedeemer.json"
import BaseSepoliaWormholeCoreDeployment from "./artifacts/baseSepolia/WormholeCore.json"
import { WORMHOLE_CHAIN_IDS } from "../utils/wormhole"
// TODO: Uncomment when Base L2BitcoinRedeemer is deployed
// import BaseWormholeCoreDeployment from "./artifacts/base/WormholeCore.json"

/**
 * Implementation of the Base L2BitcoinRedeemer handle.
 * @see {L2BitcoinRedeemer} for reference.
 */
export class BaseL2BitcoinRedeemer
  extends EthersContractHandle<L2BitcoinRedeemerTypechain>
  implements L2BitcoinRedeemer
{
  private readonly wormholeCore: Contract
  private readonly recipientChain: number

  constructor(config: EthersContractConfig, chainId: Chains.Base) {
    let deployment: EthersContractDeployment
    let wormholeCoreDeployment: EthersContractDeployment
    let recipientChain: number

    switch (chainId) {
      case Chains.Base.BaseSepolia:
        deployment = BaseSepoliaL2BitcoinRedeemerDeployment
        wormholeCoreDeployment = BaseSepoliaWormholeCoreDeployment
        recipientChain = WORMHOLE_CHAIN_IDS[Chains.Ethereum.Sepolia] // Ethereum Sepolia
        break
      // TODO: Uncomment when Base L2BitcoinRedeemer is deployed
      // case Chains.Base.Base:
      //   deployment = BaseL2BitcoinRedeemerDeployment
      //   wormholeCoreDeployment = BaseWormholeCoreDeployment
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
