import { ChainIdentifier } from "./chain-identifier"
import { Hex } from "../utils"
import { BitcoinRawTxVectors } from "../bitcoin"
import { DepositReceipt } from "./bridge"
import { TransactionReceipt } from "@ethersproject/providers"

/**
 * Optional capability exposed by deposit handlers that can safely reveal
 * Taproot-native deposits end to end.
 */
export interface TaprootDepositorCapability {
  /**
   * @returns True only when the complete reveal path preserves both x-only
   *          public keys required by a Taproot deposit.
   */
  supportsTaprootDeposits?(): boolean
}

/**
 * Checks whether a deposit handler explicitly supports Taproot deposits.
 * Missing capability declarations fail closed for backward compatibility.
 * @param depositor Deposit handler whose capability should be checked.
 * @returns True only when Taproot support is explicitly declared.
 */
export function supportsTaprootDeposits(
  depositor: TaprootDepositorCapability
): boolean {
  return depositor.supportsTaprootDeposits?.() === true
}

/**
 * Rejects a Taproot receipt when the target deposit handler has not explicitly
 * declared end-to-end Taproot support.
 * @param depositor Deposit handler whose capability should be checked.
 * @param deposit Deposit receipt about to be revealed.
 * @returns {void}
 */
export function assertTaprootDepositSupported(
  depositor: TaprootDepositorCapability,
  deposit: DepositReceipt
): void {
  const hasTaprootKeys =
    typeof deposit.walletXOnlyPublicKey !== "undefined" ||
    typeof deposit.refundXOnlyPublicKey !== "undefined"

  if (hasTaprootKeys && !supportsTaprootDeposits(depositor)) {
    throw new Error("Taproot deposits are not supported by this depositor")
  }
}

/**
 * Interface representing a depositor proxy contract. A depositor proxy
 * is used to reveal deposits to the Bridge, on behalf of the user
 * (i.e. original depositor). It receives minted TBTC tokens and can provide
 * additional services to the user, such as routing the minted TBTC tokens to
 * another protocols, in an automated way. Depositor proxy is responsible for
 * attributing the deposit and minted TBTC tokens to the user (e.g. using the
 * optional 32-byte extra data field of the deposit script).
 */
export interface DepositorProxy extends TaprootDepositorCapability {
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
