import type { Abi, Address } from "viem"
import {
  asDeployment,
  EthereumContractConfig,
  EvmContractDeployment,
  EvmContractHandle,
} from "../ethereum/adapter"
import { ChainIdentifier, Chains, L2BitcoinRedeemer } from "../contracts"
import { Hex } from "../utils"


import BaseSepoliaL2BitcoinRedeemerDeployment from "./artifacts/baseSepolia/BaseL2BitcoinRedeemer.json"
import BaseSepoliaWormholeCoreDeployment from "./artifacts/baseSepolia/WormholeCore.json"
import { WORMHOLE_CHAIN_IDS } from "../utils/wormhole"

import BaseWormholeCoreDeployment from "./artifacts/base/WormholeCore.json"
import BaseL2BitcoinRedeemerDeployment from "./artifacts/base/BaseL2BitcoinRedeemer.json"

/**
 * Implementation of the Base L2BitcoinRedeemer handle.
 * @see {L2BitcoinRedeemer} for reference.
 */
export class BaseL2BitcoinRedeemer
  extends EvmContractHandle
  implements L2BitcoinRedeemer
{
  private readonly wormholeCoreAddress: Address
  private readonly wormholeCoreAbi: Abi
  private readonly recipientChain: number

  constructor(config: EthereumContractConfig, chainId: Chains.Base) {
    let deployment: EvmContractDeployment
    let wormholeCoreDeployment: EvmContractDeployment
    let recipientChain: number

    switch (chainId) {
      case Chains.Base.BaseSepolia:
        deployment = asDeployment(BaseSepoliaL2BitcoinRedeemerDeployment)
        wormholeCoreDeployment = asDeployment(BaseSepoliaWormholeCoreDeployment)
        recipientChain = WORMHOLE_CHAIN_IDS[Chains.Ethereum.Sepolia]
        break
      case Chains.Base.Base:
        deployment = asDeployment(BaseL2BitcoinRedeemerDeployment)
        wormholeCoreDeployment = asDeployment(BaseWormholeCoreDeployment)
        recipientChain = WORMHOLE_CHAIN_IDS[Chains.Ethereum.Mainnet]
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)

    this.recipientChain = recipientChain
    // The Wormhole core contract is only read (messageFee) - a plain
    // readContract call against its address suffices, no handle needed.
    this.wormholeCoreAddress = wormholeCoreDeployment.address as Address
    this.wormholeCoreAbi = wormholeCoreDeployment.abi
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L2BitcoinDepositor#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return this.getAddress()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L2BitcoinRedeemer#requestRedemption}
   */
  async requestRedemption(
    amount: bigint,
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

    // Get the Wormhole message fee that must be attached as the
    // transaction value.
    const { public: publicClient } = await this._connection()
    const messageFee = (await publicClient.readContract({
      address: this.wormholeCoreAddress,
      abi: this.wormholeCoreAbi,
      functionName: "messageFee",
    } as never)) as bigint | number

    return this._write(
      "requestRedemption",
      [amount, this.recipientChain, prefixedRawRedeemerOutputScript, nonce],
      { value: BigInt(messageFee) }
    )
  }
}
