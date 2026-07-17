import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
} from "../ethereum/adapter"
import { L2BitcoinDepositor as L2BitcoinDepositorTypechain } from "../../../typechain/L2BitcoinDepositor"
import {
  ChainIdentifier,
  Chains,
  ExtraDataEncoder,
  DepositReceipt,
  BitcoinDepositor,
} from "../contracts"
import { EthereumAddress, packRevealDepositParameters } from "../ethereum"
import { Hex } from "../utils"
import { BitcoinRawTxVectors } from "../bitcoin"
import { TransactionReceipt } from "@ethersproject/providers"

import ArbitrumL2BitcoinDepositorDeployment from "./artifacts/arbitrumOne/ArbitrumL2BitcoinDepositor.json"
import ArbitrumSepoliaL2BitcoinDepositorDeployment from "./artifacts/arbitrumSepolia/ArbitrumL2BitcoinDepositor.json"

/**
 * Implementation of the Arbitrum BitcoinDepositor handle.
 * @see {BitcoinDepositor} for reference.
 */
export class ArbitrumBitcoinDepositor
  extends EthersContractHandle<L2BitcoinDepositorTypechain>
  implements BitcoinDepositor
{
  readonly #extraDataEncoder: ExtraDataEncoder
  #depositOwner: ChainIdentifier | undefined

  constructor(config: EthersContractConfig, chainId: Chains.Arbitrum) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Arbitrum.ArbitrumSepolia:
        deployment = ArbitrumSepoliaL2BitcoinDepositorDeployment
        break
      case Chains.Arbitrum.Arbitrum:
        deployment = ArbitrumL2BitcoinDepositorDeployment
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)

    this.#extraDataEncoder = new ArbitrumExtraDataEncoder()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#getChainIdentifier}
   */
  getChainIdentifier?(): ChainIdentifier {
    return EthereumAddress.from(this._instance.address)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#getDepositOwner}
   */
  getDepositOwner(): ChainIdentifier | undefined {
    return this.#depositOwner
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#setDepositOwner}
   */
  setDepositOwner(depositOwner: ChainIdentifier | undefined) {
    this.#depositOwner = depositOwner
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#extraDataEncoder}
   */
  extraDataEncoder(): ExtraDataEncoder {
    return this.#extraDataEncoder
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#initializeDeposit}
   */
  async initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex | TransactionReceipt> {
    const { fundingTx, reveal } = packRevealDepositParameters(
      depositTx,
      depositOutputIndex,
      deposit,
      vault
    )

    if (!deposit.extraData) {
      throw new Error("Extra data is required")
    }

    const l2DepositOwner = this.extraDataEncoder().decodeDepositOwner(
      deposit.extraData
    )

    const tx = await this._instance.initializeDeposit(
      fundingTx,
      reveal,
      `0x${l2DepositOwner.identifierHex}`
    )

    return Hex.from(tx.hash)
  }
}

/**
 * Implementation of the Arbitrum ExtraDataEncoder.
 * @see {ExtraDataEncoder} for reference.
 */
export class ArbitrumExtraDataEncoder implements ExtraDataEncoder {
  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {ExtraDataEncoder#encodeDepositOwner}
   */
  encodeDepositOwner(depositOwner: ChainIdentifier): Hex {
    // Make sure we are dealing with an Ethereum address. If not, this
    // call will throw.
    const address = EthereumAddress.from(depositOwner.identifierHex)

    // Extra data must be 32-byte so prefix the 20-byte address with
    // 12 zero bytes.
    return Hex.from(`000000000000000000000000${address.identifierHex}`)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {ExtraDataEncoder#decodeDepositOwner}
   */
  decodeDepositOwner(extraData: Hex): ChainIdentifier {
    // Cut the first 12 zero bytes of the extra data and convert the rest to
    // an Ethereum address.
    return EthereumAddress.from(
      Hex.from(extraData.toBuffer().subarray(12)).toString()
    )
  }
}

/**
 * @deprecated Use ArbitrumBitcoinDepositor instead
 */
export const ArbitrumL2BitcoinDepositor = ArbitrumBitcoinDepositor

/**
 * @deprecated Use ArbitrumExtraDataEncoder instead
 */
export const ArbitrumCrossChainExtraDataEncoder = ArbitrumExtraDataEncoder
