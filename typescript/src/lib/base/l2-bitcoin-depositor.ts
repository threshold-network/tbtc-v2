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
import {
  EthereumAddress,
  EthereumCrossChainExtraDataEncoder,
  packRevealDepositParameters,
} from "../ethereum"
import { Hex } from "../utils"
import { BitcoinRawTxVectors } from "../bitcoin"
import { TransactionReceipt } from "@ethersproject/providers"

import BaseL2BitcoinDepositorDeployment from "./artifacts/base/BaseL2BitcoinDepositor.json"
import BaseSepoliaL2BitcoinDepositorDeployment from "./artifacts/baseSepolia/BaseL2BitcoinDepositor.json"

/**
 * Implementation of the Base BitcoinDepositor handle.
 * @see {BitcoinDepositor} for reference.
 */
export class BaseBitcoinDepositor
  extends EthersContractHandle<L2BitcoinDepositorTypechain>
  implements BitcoinDepositor
{
  readonly #extraDataEncoder: ExtraDataEncoder
  #depositOwner: ChainIdentifier | undefined

  constructor(config: EthersContractConfig, chainId: Chains.Base) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Base.BaseSepolia:
        deployment = BaseSepoliaL2BitcoinDepositorDeployment
        break
      case Chains.Base.Base:
        deployment = BaseL2BitcoinDepositorDeployment
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)

    this.#extraDataEncoder = new EthereumCrossChainExtraDataEncoder()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
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

// Backward compatibility alias
/**
 * @deprecated Use BaseBitcoinDepositor instead
 */
export const BaseL2BitcoinDepositor = BaseBitcoinDepositor
