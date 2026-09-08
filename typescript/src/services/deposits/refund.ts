import { BigNumber } from "@ethersproject/bignumber"
import {
  BitcoinAddressConverter,
  BitcoinClient,
  BitcoinHashUtils,
  BitcoinNetwork,
  BitcoinPrivateKeyUtils,
  BitcoinPublicKeyUtils,
  BitcoinRawTx,
  BitcoinScriptUtils,
  BitcoinTxHash,
  BitcoinUtxo,
} from "../../lib/bitcoin"
import { validateDepositReceipt } from "../../lib/contracts"
import { Hex } from "../../lib/utils"
import { DepositScript } from "./"
import {
  Signer,
  Transaction,
  script as btcjsscript,
  Stack,
} from "bitcoinjs-lib"

/**
 * Component allowing to craft and submit the Bitcoin refund transaction using
 * the given tBTC v2 deposit script.
 *
 * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
 *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
 *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
 */
// TODO: Abstract away transaction signing so there is no need to deal with
//       private key directly.
export class DepositRefund {
  public readonly script: DepositScript

  private constructor(script: DepositScript) {
    this.script = script
  }

  static fromScript(script: DepositScript): DepositRefund {
    return new DepositRefund(script)
  }

  /**
   * Submits a deposit refund by creating and broadcasting a Bitcoin P2(W)PKH
   * deposit refund transaction.
   * @param bitcoinClient - Bitcoin client used to interact with the network.
   * @param fee - the value that will be subtracted from the deposit UTXO being
   *        refunded and used as the transaction fee.
   * @param utxo - UTXO that was created during depositing that needs be refunded.
   * @param refunderAddress - Recipient Bitcoin wallet address of the refunded
   *        deposit.
   * @param refunderPrivateKey - Bitcoin wallet private key of the refunder.
   *        It must correspond to the `refundPublicKeyHash` of the deposit script.
   * @returns The outcome is the deposit refund transaction hash.
   * @dev This function should be called by the refunder after `refundLocktime`
   *      passes plus 1 hour. The additional hour of waiting is the result of
   *      adopting BIP113 which compares the transaction's locktime against the
   *      median timestamp of the last 11 blocks. This median time lags
   *      the current unix time by about 1 hour.
   */
  async submitTransaction(
    bitcoinClient: BitcoinClient,
    fee: BigNumber,
    utxo: BitcoinUtxo,
    refunderAddress: string,
    refunderPrivateKey: string
  ): Promise<{ transactionHash: BitcoinTxHash }> {
    const utxoRawTransaction = await bitcoinClient.getRawTransaction(
      utxo.transactionHash
    )

    const utxoWithRaw = {
      ...utxo,
      transactionHex: utxoRawTransaction.transactionHex,
    }

    const bitcoinNetwork = await bitcoinClient.getNetwork()

    const { transactionHash, rawTransaction } = await this.assembleTransaction(
      bitcoinNetwork,
      fee,
      utxoWithRaw,
      refunderAddress,
      refunderPrivateKey
    )

    // Note that `broadcast` may fail silently (i.e. no error will be returned,
    // even if the transaction is rejected by other nodes and does not enter the
    // mempool, for example due to an UTXO being already spent).
    await bitcoinClient.broadcast(rawTransaction)

    return { transactionHash }
  }

  /**
   * Assembles a Bitcoin P2(W)PKH deposit refund transaction.
   * @param bitcoinNetwork - The target Bitcoin network.
   * @param fee - the value that will be subtracted from the deposit UTXO being
   *        refunded and used as the transaction fee.
   * @param utxo - UTXO that was created during depositing that needs be refunded.
   * @param refunderAddress - Recipient Bitcoin wallet address of the refunded
   *        deposit.
   * @param refunderPrivateKey - Bitcoin wallet private key of the refunder.
   *        It must correspond to the `refundPublicKeyHash` of the deposit script.
   * @returns The outcome consisting of:
   *          - the deposit refund transaction hash,
   *          - the refund transaction in the raw format.
   */
  async assembleTransaction(
    bitcoinNetwork: BitcoinNetwork,
    fee: BigNumber,
    utxo: BitcoinUtxo & BitcoinRawTx,
    refunderAddress: string,
    refunderPrivateKey: string
  ): Promise<{
    transactionHash: BitcoinTxHash
    rawTransaction: BitcoinRawTx
  }> {
    validateDepositReceipt(this.script.receipt)

    const refunderKeyPair = BitcoinPrivateKeyUtils.createKeyPair(
      refunderPrivateKey,
      bitcoinNetwork
    )

    const outputValue = utxo.value.sub(fee)

    const transaction = new Transaction()

    transaction.addInput(
      utxo.transactionHash.reverse().toBuffer(),
      utxo.outputIndex
    )

    const outputScript = BitcoinAddressConverter.addressToOutputScript(
      refunderAddress,
      bitcoinNetwork
    )
    transaction.addOutput(outputScript.toBuffer(), outputValue.toNumber())

    // In order to be able to spend the UTXO being refunded the transaction's
    // locktime must be set to a value equal to or higher than the refund locktime.
    // Additionally, the input's sequence must be set to a value different than
    // `0xffffffff`. These requirements are the result of BIP-65.
    transaction.locktime = locktimeToUnixTimestamp(
      this.script.receipt.refundLocktime
    )
    transaction.ins[0].sequence = 0xfffffffe

    // Sign the input
    const previousOutput = Transaction.fromHex(utxo.transactionHex).outs[
      utxo.outputIndex
    ]
    const previousOutputValue = previousOutput.value
    const previousOutputScript = Hex.from(previousOutput.script)

    if (BitcoinScriptUtils.isP2SHScript(previousOutputScript)) {
      // P2SH deposit UTXO
      await this.signP2SHDepositInput(transaction, 0, refunderKeyPair)
    } else if (BitcoinScriptUtils.isP2WSHScript(previousOutputScript)) {
      // P2WSH deposit UTXO
      await this.signP2WSHDepositInput(
        transaction,
        0,
        previousOutputValue,
        refunderKeyPair
      )
    } else {
      throw new Error("Unsupported UTXO script type")
    }

    const transactionHash = BitcoinTxHash.from(transaction.getId())

    return {
      transactionHash,
      rawTransaction: {
        transactionHex: transaction.toHex(),
      },
    }
  }

  /**
   * Assembles the deposit script based on the given deposit details. Performs
   * validations on values and key formats.
   * @param refunderKeyPair - Signer object containing the refunder's key pair.
   * @returns A Promise resolving to the assembled deposit script as a Buffer.
   * @throws Error if there are discrepancies in values or key formats.
   */
  private async prepareDepositScript(refunderKeyPair: Signer): Promise<Buffer> {
    const refunderPublicKey = Hex.from(refunderKeyPair.publicKey)

    if (
      !BitcoinHashUtils.computeHash160(refunderPublicKey).equals(
        this.script.receipt.refundPublicKeyHash
      )
    ) {
      throw new Error(
        "Refund public key does not correspond to wallet private key"
      )
    }

    if (!BitcoinPublicKeyUtils.isCompressedPublicKey(refunderPublicKey)) {
      throw new Error("Refunder public key must be compressed")
    }

    return (await this.script.getPlainText()).toBuffer()
  }

  /**
   * Signs a P2SH deposit transaction input and sets the `scriptSig`.
   * @param transaction - The transaction containing the input to be signed.
   * @param inputIndex - Index pointing to the input within the transaction.
   * @param refunderKeyPair - A Signer object with the refunder's public and private
   *        key pair.
   * @returns An empty promise upon successful signing.
   */
  private async signP2SHDepositInput(
    transaction: Transaction,
    inputIndex: number,
    refunderKeyPair: Signer
  ) {
    const depositScript = await this.prepareDepositScript(refunderKeyPair)

    const sigHashType = Transaction.SIGHASH_ALL

    const sigHash = transaction.hashForSignature(
      inputIndex,
      depositScript,
      sigHashType
    )

    const signature = btcjsscript.signature.encode(
      refunderKeyPair.sign(sigHash),
      sigHashType
    )

    const scriptSig: Stack = []
    scriptSig.push(signature)
    scriptSig.push(refunderKeyPair.publicKey)
    scriptSig.push(depositScript)

    transaction.ins[inputIndex].script = btcjsscript.compile(scriptSig)
  }

  /**
   * Signs a P2WSH deposit transaction input and sets the witness script.
   * @param transaction - The transaction containing the input to be signed.
   * @param inputIndex - Index pointing to the input within the transaction.
   * @param previousOutputValue - The value from the previous transaction output.
   * @param refunderKeyPair - A Signer object with the refunder's public and private
   *        key pair.
   * @returns An empty promise upon successful signing.
   */
  private async signP2WSHDepositInput(
    transaction: Transaction,
    inputIndex: number,
    previousOutputValue: number,
    refunderKeyPair: Signer
  ) {
    const depositScript = await this.prepareDepositScript(refunderKeyPair)

    const sigHashType = Transaction.SIGHASH_ALL

    const sigHash = transaction.hashForWitnessV0(
      inputIndex,
      depositScript,
      previousOutputValue,
      sigHashType
    )

    const signature = btcjsscript.signature.encode(
      refunderKeyPair.sign(sigHash),
      sigHashType
    )

    const witness: Buffer[] = []
    witness.push(signature)
    witness.push(refunderKeyPair.publicKey)
    witness.push(depositScript)

    transaction.ins[inputIndex].witness = witness
  }
}

/**
 * Converts locktime from the little endian hexstring format to the Unix
 * timestamp.
 * @param locktime - Locktime as a little endian hexstring.
 * @returns Locktime as a Unix timestamp.
 */
function locktimeToUnixTimestamp(locktime: Hex): number {
  const bigEndianLocktime = locktime.reverse().toString()
  return parseInt(bigEndianLocktime, 16)
}
