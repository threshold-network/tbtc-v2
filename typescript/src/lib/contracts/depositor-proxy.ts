import { ChainIdentifier } from "./chain-identifier"
import { Hex } from "../utils"
import { BitcoinRawTxVectors } from "../bitcoin"
import { DepositReceipt } from "./bridge"
import { TransactionReceipt } from "@ethersproject/providers"

/**
 * Interface representing a depositor proxy contract. A depositor proxy
 * is used to reveal deposits to the Bridge, on behalf of the user
 * (i.e. original depositor). It receives minted TBTC tokens and can provide
 * additional services to the user, such as routing the minted TBTC tokens to
 * another protocols, in an automated way. Depositor proxy is responsible for
 * attributing the deposit and minted TBTC tokens to the user (e.g. using the
 * optional 32-byte extra data field of the deposit script).
 */
export interface DepositorProxy {
  /**
   * Gets the chain-specific identifier of this contract.
   */
  getChainIdentifier(): ChainIdentifier

  /**
   * Reveals a given deposit to the on-chain Bridge contract.
   * @param depositTx - Deposit transaction data
   * @param depositOutputIndex - Index of the deposit transaction output that
   *        funds the revealed deposit
   * @param deposit - Data of the revealed deposit
   * @param vault - Optional parameter denoting the vault the given deposit
   *        should be routed to
   * @returns Transaction hash of the reveal deposit transaction.
   */
  revealDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex | TransactionReceipt>
}
