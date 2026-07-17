import {
  asDeployment,
  EthereumContractConfig,
  EvmContractDeployment,
  EvmContractHandle,
} from "../ethereum/adapter"
import {
  ChainIdentifier,
  ChainTransactionReceipt,
  Chains,
  ExtraDataEncoder,
  DepositReceipt,
  BitcoinDepositor,
} from "../contracts"
import { EthereumAddress, packRevealDepositParameters } from "../ethereum"
import { Hex } from "../utils"
import { BitcoinRawTxVectors } from "../bitcoin"


import ArbitrumL2BitcoinDepositorDeployment from "./artifacts/arbitrumOne/ArbitrumL2BitcoinDepositor.json"
import ArbitrumSepoliaL2BitcoinDepositorDeployment from "./artifacts/arbitrumSepolia/ArbitrumL2BitcoinDepositor.json"

/**
 * Implementation of the Arbitrum BitcoinDepositor handle.
 * @see {BitcoinDepositor} for reference.
 */
export class ArbitrumBitcoinDepositor
  extends EvmContractHandle
  implements BitcoinDepositor
{
  readonly #extraDataEncoder: ExtraDataEncoder
  #depositOwner: ChainIdentifier | undefined

  constructor(config: EthereumContractConfig, chainId: Chains.Arbitrum) {
    let deployment: EvmContractDeployment

    switch (chainId) {
      case Chains.Arbitrum.ArbitrumSepolia:
        deployment = asDeployment(ArbitrumSepoliaL2BitcoinDepositorDeployment)
        break
      case Chains.Arbitrum.Arbitrum:
        deployment = asDeployment(ArbitrumL2BitcoinDepositorDeployment)
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
    return this.getAddress()
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
  ): Promise<Hex | ChainTransactionReceipt> {
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

    return this._write("initializeDeposit", [
      fundingTx,
      reveal,
      `0x${l2DepositOwner.identifierHex}`,
    ])
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
