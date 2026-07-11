import { ChainIdentifier, DepositorProxy, DepositReceipt } from "../contracts"
import { BitcoinRawTxVectors } from "../bitcoin"
import { Hex } from "../utils"
import { EthereumAddress } from "./address"
import { packRevealDepositParameters } from "./bridge"

/**
 * Abstract class representing a depositor proxy contract on Ethereum.
 * It implements some common logic that is meant to facilitate creation
 * of concrete depositor proxy handles for Ethereum.
 * @see {DepositorProxy} for reference.
 */
export abstract class EthereumDepositorProxy implements DepositorProxy {
  protected readonly address: EthereumAddress

  protected constructor(address: string | EthereumAddress) {
    if (typeof address === "string") {
      this.address = EthereumAddress.from(address)
    } else {
      this.address = address
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {DepositorProxy#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return this.address
  }

  /**
   * Legacy Ethereum depositor proxies do not preserve the x-only keys required
   * by Taproot deposit reveals. Capable subclasses must override this method.
   * @see {DepositorProxy#supportsTaprootDeposits}
   * @returns False by default.
   */
  supportsTaprootDeposits(): boolean {
    return false
  }

  /**
   * Packs deposit parameters to match the ABI of the revealDeposit and
   * revealDepositWithExtraData functions of the Ethereum Bridge contract.
   * @param depositTx - Deposit transaction data
   * @param depositOutputIndex - Index of the deposit transaction output that
   *        funds the revealed deposit
   * @param deposit - Data of the revealed deposit
   * @param vault - Optional parameter denoting the vault the given deposit
   *        should be routed to
   * @returns Packed parameters.
   * @protected
   */
  protected packRevealDepositParameters(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ) {
    return packRevealDepositParameters(
      depositTx,
      depositOutputIndex,
      deposit,
      vault
    )
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {DepositorProxy#revealDeposit}
   */
  abstract revealDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex>
}
