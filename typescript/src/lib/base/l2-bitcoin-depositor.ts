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
import { packRevealDepositParameters } from "../ethereum"
import { EthereumCrossChainExtraDataEncoder } from "../ethereum/l1-bitcoin-depositor"
import { Hex } from "../utils"
import { BitcoinRawTxVectors } from "../bitcoin"


import BaseL2BitcoinDepositorDeployment from "./artifacts/base/BaseL2BitcoinDepositor.json"
import BaseSepoliaL2BitcoinDepositorDeployment from "./artifacts/baseSepolia/BaseL2BitcoinDepositor.json"

/**
 * Implementation of the Base BitcoinDepositor handle.
 * @see {BitcoinDepositor} for reference.
 */
export class BaseBitcoinDepositor
  extends EvmContractHandle
  implements BitcoinDepositor
{
  readonly #extraDataEncoder: ExtraDataEncoder
  #depositOwner: ChainIdentifier | undefined

  constructor(config: EthereumContractConfig, chainId: Chains.Base) {
    let deployment: EvmContractDeployment

    switch (chainId) {
      case Chains.Base.BaseSepolia:
        deployment = asDeployment(BaseSepoliaL2BitcoinDepositorDeployment)
        break
      case Chains.Base.Base:
        deployment = asDeployment(BaseL2BitcoinDepositorDeployment)
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

// Backward compatibility alias
/**
 * @deprecated Use BaseBitcoinDepositor instead
 */
export const BaseL2BitcoinDepositor = BaseBitcoinDepositor
