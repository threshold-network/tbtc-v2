import { DepositScript } from "./deposit"
import {
  BitcoinAddressConverter,
  BitcoinClient,
  BitcoinNetwork,
  BitcoinPrivateKeyUtils,
  BitcoinRawTx,
  BitcoinScriptUtils,
  BitcoinTxHash,
  BitcoinUtxo,
  toBitcoinJsLibNetwork,
} from "../../lib/bitcoin"
import { BigNumber } from "@ethersproject/bignumber"
import { Psbt, Transaction } from "bitcoinjs-lib"
import { Hex } from "../../lib/utils"

/**
 * Component allowing to craft and submit the Bitcoin funding transaction using
 * the given tBTC v2 deposit script.
 *
 * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
 *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
 *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
 */
// TODO: Abstract away transaction signing so there is no need to deal with
//       private key directly.
export class DepositFunding {
  public readonly script: DepositScript

  private constructor(script: DepositScript) {
    this.script = script
  }

  static fromScript(script: DepositScript): DepositFunding {
    return new DepositFunding(script)
  }

  /**
   * Assembles and signs the Bitcoin P2(W)SH funding transaction using
   * the underlying deposit script.
   * @dev It is up to the caller to ensure that input UTXOs are valid and
   *      can be unlocked using the depositor's private key. It is also
   *      caller's responsibility to ensure the given deposit is funded exactly
   *      once.
   * @param bitcoinNetwork The target Bitcoin network.
   * @param amount Deposit amount in satoshis.
   * @param inputUtxos UTXOs to be used for funding the deposit transaction.
   *                   So far only P2WPKH UTXO inputs are supported.
   * @param fee Transaction fee to be subtracted from the sum of the UTXOs' values.
   * @param depositorPrivateKey Bitcoin private key of the depositor. Must
   *        be able to unlock input UTXOs.
   * @returns The outcome consisting of:
   *          - the deposit transaction hash,
   *          - the deposit UTXO produced by this transaction.
   *          - the deposit transaction in the raw format
   * @dev UTXOs are selected for transaction funding based on their types. UTXOs
   *     with unsupported types are skipped. The selection process stops once
   *     the sum of the chosen UTXOs meets the required funding amount.
   * @throws {Error} When the sum of the selected UTXOs is insufficient to cover
   *        the deposit amount and transaction fee.
   */
  async assembleTransaction(
    bitcoinNetwork: BitcoinNetwork,
    amount: BigNumber,
    inputUtxos: (BitcoinUtxo & BitcoinRawTx)[],
    fee: BigNumber,
    depositorPrivateKey: string
  ): Promise<{
    transactionHash: BitcoinTxHash
    depositUtxo: BitcoinUtxo
    rawTransaction: BitcoinRawTx
  }> {
    const network = toBitcoinJsLibNetwork(bitcoinNetwork)

    const depositorKeyPair = BitcoinPrivateKeyUtils.createKeyPair(
      depositorPrivateKey,
      bitcoinNetwork
    )

    const psbt = new Psbt({ network })
    psbt.setVersion(1)

    const totalExpenses = amount.add(fee)
    let totalInputValue = BigNumber.from(0)

    for (const utxo of inputUtxos) {
      const previousOutput = Transaction.fromHex(utxo.transactionHex).outs[
        utxo.outputIndex
      ]
      const previousOutputValue = previousOutput.value
      const previousOutputScript = previousOutput.script

      // TODO: Add support for other utxo types along with unit tests for the
      //       given type.
      if (BitcoinScriptUtils.isP2WPKHScript(Hex.from(previousOutputScript))) {
        psbt.addInput({
          hash: utxo.transactionHash.reverse().toBuffer(),
          index: utxo.outputIndex,
          witnessUtxo: {
            script: previousOutputScript,
            value: previousOutputValue,
          },
        })

        totalInputValue = totalInputValue.add(utxo.value)
        if (totalInputValue.gte(totalExpenses)) {
          break
        }
      }
      // Skip UTXO if the type is unsupported.
    }

    // Sum of the selected UTXOs must be equal to or greater than the deposit
    // amount plus fee.
    if (totalInputValue.lt(totalExpenses)) {
      throw new Error("Not enough funds in selected UTXOs to fund transaction")
    }

    // Add deposit output.
    psbt.addOutput({
      address: await this.script.deriveAddress(bitcoinNetwork),
      value: amount.toNumber(),
    })

    // Add change output if needed.
    const changeValue = totalInputValue.sub(totalExpenses)
    if (changeValue.gt(0)) {
      const depositorAddress = BitcoinAddressConverter.publicKeyToAddress(
        Hex.from(depositorKeyPair.publicKey),
        bitcoinNetwork
      )
      psbt.addOutput({
        address: depositorAddress,
        value: changeValue.toNumber(),
      })
    }

    psbt.signAllInputs(depositorKeyPair)
    psbt.finalizeAllInputs()

    const transaction = psbt.extractTransaction()
    const transactionHash = BitcoinTxHash.from(transaction.getId())

    return {
      transactionHash,
      depositUtxo: {
        transactionHash,
        outputIndex: 0, // The deposit is always the first output.
        value: amount,
      },
      rawTransaction: {
        transactionHex: transaction.toHex(),
      },
    }
  }

  /**
   * Assembles, signs and submits the Bitcoin P2(W)SH funding transaction
   * using the underlying deposit script.
   * @dev It is up to the caller to ensure that depositor's private key controls
   *      some UTXOs that can be used as input. It is also caller's responsibility
   *      to ensure the given deposit is funded exactly once.
   * @param amount Deposit amount in satoshis.
   * @param inputUtxos UTXOs to be used for funding the deposit transaction. So
   *        far only P2WPKH UTXO inputs are supported.
   * @param fee The value that should be subtracted from the sum of the UTXOs
   *        values and used as the transaction fee.
   * @param depositorPrivateKey Bitcoin private key of the depositor.
   * @param bitcoinClient Bitcoin client used to interact with the network.
   * @returns The outcome consisting of:
   *          - the deposit transaction hash,
   *          - the deposit UTXO produced by this transaction.
   * @dev UTXOs are selected for transaction funding based on their types. UTXOs
   *       with unsupported types are skipped. The selection process stops once
   *       the sum of the chosen UTXOs meets the required funding amount.
   *       Be aware that the function will attempt to broadcast the transaction,
   *       although successful broadcast is not guaranteed.
   *  @throws {Error} When the sum of the selected UTXOs is insufficient to cover
   *        the deposit amount and transaction fee.
   */
  async submitTransaction(
    amount: BigNumber,
    inputUtxos: BitcoinUtxo[],
    fee: BigNumber,
    depositorPrivateKey: string,
    bitcoinClient: BitcoinClient
  ): Promise<{
    transactionHash: BitcoinTxHash
    depositUtxo: BitcoinUtxo
  }> {
    const utxosWithRaw: (BitcoinUtxo & BitcoinRawTx)[] = []
    for (const utxo of inputUtxos) {
      const utxoRawTransaction = await bitcoinClient.getRawTransaction(
        utxo.transactionHash
      )

      utxosWithRaw.push({
        ...utxo,
        transactionHex: utxoRawTransaction.transactionHex,
      })
    }

    const bitcoinNetwork = await bitcoinClient.getNetwork()

    const { transactionHash, depositUtxo, rawTransaction } =
      await this.assembleTransaction(
        bitcoinNetwork,
        amount,
        utxosWithRaw,
        fee,
        depositorPrivateKey
      )

    // Note that `broadcast` may fail silently (i.e. no error will be returned,
    // even if the transaction is rejected by other nodes and does not enter the
    // mempool, for example due to an UTXO being already spent).
    await bitcoinClient.broadcast(rawTransaction)

    return {
      transactionHash,
      depositUtxo,
    }
  }
}
