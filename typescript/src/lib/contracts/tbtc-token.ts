import { BigNumber } from "@ethersproject/bignumber"
import { BitcoinUtxo } from "../bitcoin"
import { Hex } from "../utils"
import { ChainIdentifier } from "./chain-identifier"

/**
 * Interface for communication with the TBTC v2 token on-chain contract.
 */
export interface TBTCToken {
  /**
   * Gets the chain-specific identifier of this contract.
   */
  getChainIdentifier(): ChainIdentifier

  /**
   * Gets the total supply of the TBTC v2 token. The returned value is in
   * ERC 1e18 precision, it has to be converted before using as Bitcoin value
   * with 1e8 precision in satoshi.
   * @param blockNumber Optional parameter determining the block the total
   *        supply should be fetched for. If this parameter is not set, the
   *        total supply is taken for the latest block.
   */
  totalSupply(blockNumber?: number): Promise<BigNumber>

  /**
   * Requests redemption in one transaction using the `approveAndCall` function
   * from the tBTC on-chain token contract. Then the tBTC token contract calls
   * the `receiveApproval` function from the `TBTCVault` contract which burns
   * tBTC tokens and requests redemption.
   * @param walletPublicKey - The Bitcoin public key of the wallet. Must be in
   *        the compressed form (33 bytes long with 02 or 03 prefix).
   * @param mainUtxo - The main UTXO of the wallet. Must match the main UTXO
   *        held by the on-chain Bridge contract.
   * @param redeemerOutputScript - The output script that the redeemed funds
   *        will be locked to. Must not be prepended with length.
   * @param amount - The amount to be redeemed with the precision of the tBTC
   *        on-chain token contract.
   * @returns Transaction hash of the approve and call transaction.
   */
  requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex,
    amount: BigNumber
  ): Promise<Hex>

  /**
   * Prepare tBTC Redemption Data in the raw bytes format expected by the tBTC
   * Bridge contract. The data is used to request a redemption of TBTC v2 token
   * through custom integration with the tBTC Bridge contract.
   * @param redeemer - Chain identifier of the redeemer. This is the address that
   *        will be able to claim the tBTC tokens if anything goes wrong during
   *        the redemption process.
   * @param walletPublicKey - The Bitcoin public key of the wallet. Must be in
   *        the compressed form (33 bytes long with 02 or 03 prefix).
   * @param mainUtxo - The main UTXO of the wallet. Must match the main UTXO
   *        held by the on-chain Bridge contract.
   * @param redeemerOutputScript - The output script that the redeemed funds
   *        will be locked to. Must not be prepended with length.
   */
  buildRequestRedemptionData(
    redeemer: ChainIdentifier,
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex
  ): Hex
}
