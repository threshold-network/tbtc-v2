import { encodeAbiParameters } from "viem"
import { ChainIdentifier, Chains, TBTCToken } from "../contracts"

import { BitcoinHashUtils, BitcoinUtxo } from "../bitcoin"
import { Hex } from "../utils"
import {
  asDeployment,
  EthereumContractConfig,
  EvmContractDeployment,
  EvmContractHandle,
} from "./adapter"
import { EthereumAddress } from "./address"

import MainnetTBTCTokenDeployment from "./artifacts/mainnet/TBTC.json"
import SepoliaTBTCTokenDeployment from "./artifacts/sepolia/TBTC.json"
import LocalTBTCTokenDeployment from "@keep-network/tbtc-v2/artifacts/TBTC.json"

/**
 * Implementation of the Ethereum TBTC v2 token handle.
 * @see {TBTCToken} for reference.
 */
export class EthereumTBTCToken extends EvmContractHandle implements TBTCToken {
  constructor(
    config: EthereumContractConfig,
    chainId: Chains.Ethereum = Chains.Ethereum.Local
  ) {
    let deployment: EvmContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Local:
        deployment = asDeployment(LocalTBTCTokenDeployment)
        break
      case Chains.Ethereum.Sepolia:
        deployment = asDeployment(SepoliaTBTCTokenDeployment)
        break
      case Chains.Ethereum.Mainnet:
        deployment = asDeployment(MainnetTBTCTokenDeployment)
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCToken#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return this.getAddress()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCToken#totalSupply}
   */
  async totalSupply(blockNumber?: number): Promise<bigint> {
    const totalSupply = await this._read<number | bigint>(
      "totalSupply",
      [],
      blockNumber !== undefined ? { blockNumber } : undefined
    )

    return BigInt(totalSupply)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCToken#requestRedemption}
   */
  async requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex,
    amount: bigint
  ): Promise<Hex> {
    const { account: redeemer } = await this._connection()
    if (!redeemer) {
      throw new Error("Signer not provided")
    }

    const vault = await this._read<string>("owner")
    const extraData = this.buildRequestRedemptionData(
      EthereumAddress.from(redeemer),
      walletPublicKey,
      mainUtxo,
      redeemerOutputScript
    )

    return this._write("approveAndCall", [
      vault,
      amount,
      extraData.toPrefixedString(),
    ])
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCToken#buildRequestRedemptionData}
   */
  buildRequestRedemptionData(
    redeemer: EthereumAddress,
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex
  ): Hex {
    const {
      walletPublicKeyHash,
      prefixedRawRedeemerOutputScript,
      mainUtxo: _mainUtxo,
    } = this.buildBridgeRequestRedemptionData(
      walletPublicKey,
      mainUtxo,
      redeemerOutputScript
    )

    return Hex.from(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "bytes20" },
          { type: "bytes32" },
          { type: "uint32" },
          { type: "uint64" },
          { type: "bytes" },
        ],
        [
          `0x${redeemer.identifierHex}` as `0x${string}`,
          walletPublicKeyHash as `0x${string}`,
          _mainUtxo.txHash as `0x${string}`,
          _mainUtxo.txOutputIndex,
          _mainUtxo.txOutputValue,
          prefixedRawRedeemerOutputScript as `0x${string}`,
        ]
      )
    )
  }

  private buildBridgeRequestRedemptionData(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex
  ) {
    const walletPublicKeyHash =
      BitcoinHashUtils.computeHash160(walletPublicKey).toPrefixedString()

    const mainUtxoParam = {
      // The Ethereum Bridge expects this hash to be in the Bitcoin internal
      // byte order.
      txHash: mainUtxo.transactionHash.reverse().toPrefixedString(),
      txOutputIndex: mainUtxo.outputIndex,
      txOutputValue: mainUtxo.value,
    }

    // Convert the output script to raw bytes buffer.
    const rawRedeemerOutputScript = redeemerOutputScript.toBuffer()
    // Prefix the output script bytes buffer with 0x and its own length.
    const prefixedRawRedeemerOutputScript = `0x${Buffer.concat([
      Buffer.from([rawRedeemerOutputScript.length]),
      rawRedeemerOutputScript,
    ]).toString("hex")}`

    return {
      walletPublicKeyHash,
      mainUtxo: mainUtxoParam,
      prefixedRawRedeemerOutputScript,
    }
  }
}
