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
  toBitcoinJsLibNetwork,
} from "../../lib/bitcoin"
import { BigNumber } from "@ethersproject/bignumber"
import {
  DepositReceipt,
  RedemptionRequest,
  TBTCContracts,
} from "../../lib/contracts"
import { DepositScript } from "../deposits"
import { Hex } from "../../lib/utils"
import {
  payments,
  script,
  Signer,
  Stack,
  Transaction,
  TxOutput,
  Psbt,
} from "bitcoinjs-lib"

/**
 * Wallet transactions builder. This feature set is supposed to be used only
 * for internal purposes like system tests. In real world, tBTC v2 wallets
 * are formed by peer-to-peer network participants that sign transactions
 * using threshold signature schemes.
 *
 * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
 *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
 *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
 */
// TODO: Abstract away transaction signing so there is no need to deal with
//       private key directly.
export class WalletTx {
  public readonly depositSweep: DepositSweep
  public readonly redemption: Redemption

  constructor(
    tbtcContracts: TBTCContracts,
    bitcoinClient: BitcoinClient,
    witness: boolean = true
  ) {
    this.depositSweep = new DepositSweep(bitcoinClient, witness)
    this.redemption = new Redemption(tbtcContracts, bitcoinClient, witness)
  }
}

class DepositSweep {
  /**
   * Bitcoin client handle.
   */
  private readonly bitcoinClient: BitcoinClient
  /**
   * Flag indicating whether the generated Bitcoin deposit sweep transaction
   * should be a witness one.
   */
  private readonly witness: boolean

  constructor(bitcoinClient: BitcoinClient, witness: boolean = true) {
    this.bitcoinClient = bitcoinClient
    this.witness = witness
  }

  /**
   * Submits a deposit sweep by combining all the provided P2(W)SH UTXOs and
   * broadcasting a Bitcoin P2(W)PKH deposit sweep transaction.
   * @dev The caller is responsible for ensuring the provided UTXOs are correctly
   *      formed, can be spent by the wallet and their combined value is greater
   *      than the fee. Note that broadcasting transaction may fail silently (e.g.
   *      when the provided UTXOs are not spendable) and no error will be returned.
   * @param fee - the value that should be subtracted from the sum of the UTXOs
   *        values and used as the transaction fee.
   * @param walletPrivateKey - Bitcoin private key of the wallet in WIF format.
   * @param utxos - P2(W)SH UTXOs to be combined into one output.
   * @param deposits - Array of deposits. Each element corresponds to UTXO.
   *        The number of UTXOs and deposit elements must equal.
   * @param mainUtxo - main UTXO of the wallet, which is a P2WKH UTXO resulting
   *        from the previous wallet transaction (optional).
   * @returns The outcome consisting of:
   *          - the sweep transaction hash,
   *          - the new wallet's main UTXO produced by this transaction.
   */
  async submitTransaction(
    fee: BigNumber,
    walletPrivateKey: string,
    utxos: BitcoinUtxo[],
    deposits: DepositReceipt[],
    mainUtxo?: BitcoinUtxo
  ): Promise<{
    transactionHash: BitcoinTxHash
    newMainUtxo: BitcoinUtxo
  }> {
    const utxosWithRaw: (BitcoinUtxo & BitcoinRawTx)[] = []
    for (const utxo of utxos) {
      const utxoRawTransaction = await this.bitcoinClient.getRawTransaction(
        utxo.transactionHash
      )

      utxosWithRaw.push({
        ...utxo,
        transactionHex: utxoRawTransaction.transactionHex,
      })
    }

    let mainUtxoWithRaw

    if (mainUtxo) {
      const mainUtxoRawTransaction = await this.bitcoinClient.getRawTransaction(
        mainUtxo.transactionHash
      )
      mainUtxoWithRaw = {
        ...mainUtxo,
        transactionHex: mainUtxoRawTransaction.transactionHex,
      }
    }

    const bitcoinNetwork = await this.bitcoinClient.getNetwork()

    const { transactionHash, newMainUtxo, rawTransaction } =
      await this.assembleTransaction(
        bitcoinNetwork,
        fee,
        walletPrivateKey,
        utxosWithRaw,
        deposits,
        mainUtxoWithRaw
      )

    // Note that `broadcast` may fail silently (i.e. no error will be returned,
    // even if the transaction is rejected by other nodes and does not enter the
    // mempool, for example due to an UTXO being already spent).
    await this.bitcoinClient.broadcast(rawTransaction)

    return { transactionHash, newMainUtxo }
  }

  /**
   * Assembles a Bitcoin P2WPKH deposit sweep transaction.
   * @dev The caller is responsible for ensuring the provided UTXOs are correctly
   *      formed, can be spent by the wallet and their combined value is greater
   *      than the fee.
   * @param bitcoinNetwork - The target Bitcoin network.
   * @param fee - the value that should be subtracted from the sum of the UTXOs
   *        values and used as the transaction fee.
   * @param walletPrivateKey - Bitcoin private key of the wallet in WIF format.
   * @param utxos - UTXOs from new deposit transactions. Must be P2(W)SH.
   * @param deposits - Array of deposits. Each element corresponds to UTXO.
   *        The number of UTXOs and deposit elements must equal.
   * @param mainUtxo - main UTXO of the wallet, which is a P2WKH UTXO resulting
   *        from the previous wallet transaction (optional).
   * @returns The outcome consisting of:
   *          - the sweep transaction hash,
   *          - the new wallet's main UTXO produced by this transaction.
   *          - the sweep transaction in the raw format
   * @throws Error if the provided UTXOs and deposits mismatch or if an unsupported
   *         UTXO script type is encountered.
   */
  async assembleTransaction(
    bitcoinNetwork: BitcoinNetwork,
    fee: BigNumber,
    walletPrivateKey: string,
    utxos: (BitcoinUtxo & BitcoinRawTx)[],
    deposits: DepositReceipt[],
    mainUtxo?: BitcoinUtxo & BitcoinRawTx
  ): Promise<{
    transactionHash: BitcoinTxHash
    newMainUtxo: BitcoinUtxo
    rawTransaction: BitcoinRawTx
  }> {
    if (utxos.length < 1) {
      throw new Error("There must be at least one deposit UTXO to sweep")
    }

    if (utxos.length != deposits.length) {
      throw new Error(
        "Number of UTXOs must equal the number of deposit elements"
      )
    }

    const walletKeyPair = BitcoinPrivateKeyUtils.createKeyPair(
      walletPrivateKey,
      bitcoinNetwork
    )
    const walletAddress = BitcoinAddressConverter.publicKeyToAddress(
      Hex.from(walletKeyPair.publicKey),
      bitcoinNetwork,
      this.witness
    )

    const transaction = new Transaction()

    let outputValue = BigNumber.from(0)
    if (mainUtxo) {
      transaction.addInput(
        mainUtxo.transactionHash.reverse().toBuffer(),
        mainUtxo.outputIndex
      )
      outputValue = outputValue.add(mainUtxo.value)
    }
    for (const utxo of utxos) {
      transaction.addInput(
        utxo.transactionHash.reverse().toBuffer(),
        utxo.outputIndex
      )
      outputValue = outputValue.add(utxo.value)
    }
    outputValue = outputValue.sub(fee)

    const outputScript = BitcoinAddressConverter.addressToOutputScript(
      walletAddress,
      bitcoinNetwork
    )

    transaction.addOutput(outputScript.toBuffer(), outputValue.toNumber())

    // Sign the main UTXO input if there is main UTXO.
    if (mainUtxo) {
      const inputIndex = 0 // Main UTXO is the first input.
      const previousOutput = Transaction.fromHex(mainUtxo.transactionHex).outs[
        mainUtxo.outputIndex
      ]

      await this.signMainUtxoInput(
        transaction,
        inputIndex,
        previousOutput,
        walletKeyPair
      )
    }

    // Sign the deposit inputs.
    for (let depositIndex = 0; depositIndex < deposits.length; depositIndex++) {
      // If there is a main UTXO index, we must adjust input index as the first
      // input is the main UTXO input.
      const inputIndex = mainUtxo ? depositIndex + 1 : depositIndex

      const utxo = utxos[depositIndex]
      const previousOutput = Transaction.fromHex(utxo.transactionHex).outs[
        utxo.outputIndex
      ]
      const previousOutputValue = previousOutput.value
      const previousOutputScript = Hex.from(previousOutput.script)

      const deposit = deposits[depositIndex]

      if (BitcoinScriptUtils.isP2SHScript(previousOutputScript)) {
        // P2SH (deposit UTXO)
        await this.signP2SHDepositInput(
          transaction,
          inputIndex,
          deposit,
          previousOutputValue,
          walletKeyPair
        )
      } else if (BitcoinScriptUtils.isP2WSHScript(previousOutputScript)) {
        // P2WSH (deposit UTXO)
        await this.signP2WSHDepositInput(
          transaction,
          inputIndex,
          deposit,
          previousOutputValue,
          walletKeyPair
        )
      } else {
        throw new Error("Unsupported UTXO script type")
      }
    }

    const transactionHash = BitcoinTxHash.from(transaction.getId())

    return {
      transactionHash,
      newMainUtxo: {
        transactionHash,
        outputIndex: 0, // There is only one output.
        value: BigNumber.from(transaction.outs[0].value),
      },
      rawTransaction: {
        transactionHex: transaction.toHex(),
      },
    }
  }

  /**
   * Signs the main UTXO transaction input and sets the appropriate script or
   * witness data.
   * @param transaction - The transaction containing the input to be signed.
   * @param inputIndex - Index pointing to the input within the transaction.
   * @param previousOutput - The previous output for the main UTXO input.
   * @param walletKeyPair - A Signer object with the wallet's public and private
   *        key pair.
   * @returns An empty promise upon successful signing.
   * @throws Error if the UTXO doesn't belong to the wallet, or if the script
   *         format is invalid or unknown.
   */
  private async signMainUtxoInput(
    transaction: Transaction,
    inputIndex: number,
    previousOutput: TxOutput,
    walletKeyPair: Signer
  ) {
    const previousOutputScript = Hex.from(previousOutput.script)
    const previousOutputValue = previousOutput.value

    if (
      !this.canSpendOutput(
        Hex.from(walletKeyPair.publicKey),
        previousOutputScript
      )
    ) {
      throw new Error("UTXO does not belong to the wallet")
    }

    const sigHashType = Transaction.SIGHASH_ALL

    if (BitcoinScriptUtils.isP2PKHScript(previousOutputScript)) {
      // P2PKH
      const sigHash = transaction.hashForSignature(
        inputIndex,
        previousOutputScript.toBuffer(),
        sigHashType
      )

      const signature = script.signature.encode(
        walletKeyPair.sign(sigHash),
        sigHashType
      )

      const scriptSig = payments.p2pkh({
        signature: signature,
        pubkey: walletKeyPair.publicKey,
      }).input!

      transaction.ins[inputIndex].script = scriptSig
    } else if (BitcoinScriptUtils.isP2WPKHScript(previousOutputScript)) {
      // P2WPKH
      const publicKeyHash = payments.p2wpkh({
        output: previousOutputScript.toBuffer(),
      }).hash!
      const p2pkhScript = payments.p2pkh({ hash: publicKeyHash }).output!

      const sigHash = transaction.hashForWitnessV0(
        inputIndex,
        p2pkhScript,
        previousOutputValue,
        sigHashType
      )

      const signature = script.signature.encode(
        walletKeyPair.sign(sigHash),
        sigHashType
      )

      transaction.ins[inputIndex].witness = [signature, walletKeyPair.publicKey]
    } else {
      throw new Error("Unknown type of main UTXO")
    }
  }

  /**
   * Signs a P2SH deposit transaction input and sets the `scriptSig`.
   * @param transaction - The transaction containing the input to be signed.
   * @param inputIndex - Index pointing to the input within the transaction.
   * @param deposit - Details of the deposit transaction.
   * @param previousOutputValue - The value from the previous transaction output.
   * @param walletKeyPair - A Signer object with the wallet's public and private
   *        key pair.
   * @returns An empty promise upon successful signing.
   */
  private async signP2SHDepositInput(
    transaction: Transaction,
    inputIndex: number,
    deposit: DepositReceipt,
    previousOutputValue: number,
    walletKeyPair: Signer
  ): Promise<void> {
    const depositScript = await this.prepareDepositScript(
      deposit,
      previousOutputValue,
      walletKeyPair
    )

    const sigHashType = Transaction.SIGHASH_ALL

    const sigHash = transaction.hashForSignature(
      inputIndex,
      depositScript,
      sigHashType
    )

    const signature = script.signature.encode(
      walletKeyPair.sign(sigHash),
      sigHashType
    )

    const scriptSig: Stack = []
    scriptSig.push(signature)
    scriptSig.push(walletKeyPair.publicKey)
    scriptSig.push(depositScript)

    transaction.ins[inputIndex].script = script.compile(scriptSig)
  }

  /**
   * Signs a P2WSH deposit transaction input and sets the witness script.
   * @param transaction - The transaction containing the input to be signed.
   * @param inputIndex - Index pointing to the input within the transaction.
   * @param deposit - Details of the deposit transaction.
   * @param previousOutputValue - The value from the previous transaction output.
   * @param walletKeyPair - A Signer object with the wallet's public and private
   *        key pair.
   * @returns An empty promise upon successful signing.
   */
  private async signP2WSHDepositInput(
    transaction: Transaction,
    inputIndex: number,
    deposit: DepositReceipt,
    previousOutputValue: number,
    walletKeyPair: Signer
  ): Promise<void> {
    const depositScript = await this.prepareDepositScript(
      deposit,
      previousOutputValue,
      walletKeyPair
    )

    const sigHashType = Transaction.SIGHASH_ALL

    const sigHash = transaction.hashForWitnessV0(
      inputIndex,
      depositScript,
      previousOutputValue,
      sigHashType
    )

    const signature = script.signature.encode(
      walletKeyPair.sign(sigHash),
      sigHashType
    )

    const witness: Buffer[] = []
    witness.push(signature)
    witness.push(walletKeyPair.publicKey)
    witness.push(depositScript)

    transaction.ins[inputIndex].witness = witness
  }

  /**
   * Assembles the deposit script based on the given deposit details. Performs
   * validations on values and key formats.
   * @param deposit - The deposit details.
   * @param previousOutputValue - Value from the previous transaction output.
   * @param walletKeyPair - Signer object containing the wallet's key pair.
   * @returns A Promise resolving to the assembled deposit script as a Buffer.
   * @throws Error if there are discrepancies in values or key formats.
   */
  private async prepareDepositScript(
    deposit: DepositReceipt,
    previousOutputValue: number,
    walletKeyPair: Signer
  ): Promise<Buffer> {
    const walletPublicKey = Hex.from(walletKeyPair.publicKey)

    if (
      !BitcoinHashUtils.computeHash160(walletPublicKey).equals(
        deposit.walletPublicKeyHash
      )
    ) {
      throw new Error(
        "Wallet public key does not correspond to wallet private key"
      )
    }

    if (!BitcoinPublicKeyUtils.isCompressedPublicKey(walletPublicKey)) {
      throw new Error("Wallet public key must be compressed")
    }

    return (await DepositScript.fromReceipt(deposit).getPlainText()).toBuffer()
  }

  /**
   * Determines if a UTXO's output script can be spent using the provided public
   * key.
   * @param publicKey - Public key used to derive the corresponding P2PKH and
   *        P2WPKH output scripts.
   * @param outputScript - The output script of the UTXO in question.
   * @returns True if the provided output script matches the P2PKH or P2WPKH
   *          output scripts derived from the given public key. False otherwise.
   */
  private canSpendOutput(publicKey: Hex, outputScript: Hex): boolean {
    const pubkeyBuffer = publicKey.toBuffer()
    const p2pkhOutput = Hex.from(
      payments.p2pkh({ pubkey: pubkeyBuffer }).output!
    )
    const p2wpkhOutput = Hex.from(
      payments.p2wpkh({ pubkey: pubkeyBuffer }).output!
    )

    return outputScript.equals(p2pkhOutput) || outputScript.equals(p2wpkhOutput)
  }
}

class Redemption {
  /**
   * Handle to tBTC contracts.
   */
  private readonly tbtcContracts: TBTCContracts
  /**
   * Bitcoin client handle.
   */
  private readonly bitcoinClient: BitcoinClient
  /**
   * Flag indicating whether the generated Bitcoin redemption transaction
   * should be a witness one.
   */
  private readonly witness: boolean

  constructor(
    tbtcContracts: TBTCContracts,
    bitcoinClient: BitcoinClient,
    witness: boolean = true
  ) {
    this.tbtcContracts = tbtcContracts
    this.bitcoinClient = bitcoinClient
    this.witness = witness
  }
  /**
   * Handles pending redemption requests by creating a redemption transaction
   * transferring Bitcoins from the wallet's main UTXO to the provided redeemer
   * output scripts and broadcasting it. The change UTXO resulting from the
   * transaction becomes the new main UTXO of the wallet.
   * @dev It is up to the caller to ensure the wallet key and each of the redeemer
   *      output scripts represent a valid pending redemption request in the Bridge.
   *      If this is not the case, an exception will be thrown.
   * @param walletPrivateKey - The private kay of the wallet in the WIF format
   * @param mainUtxo - The main UTXO of the wallet. Must match the main UTXO
   *        held by the on-chain Bridge contract
   * @param redeemerOutputScripts - The list of output scripts that the redeemed
   *        funds will be locked to. The output scripts must not be prepended
   *        with length
   * @returns The outcome consisting of:
   *          - the redemption transaction hash,
   *          - the optional new wallet's main UTXO produced by this transaction.
   */
  async submitTransaction(
    walletPrivateKey: string,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScripts: Hex[]
  ): Promise<{
    transactionHash: BitcoinTxHash
    newMainUtxo?: BitcoinUtxo
  }> {
    const mainUtxoRawTransaction = await this.bitcoinClient.getRawTransaction(
      mainUtxo.transactionHash
    )

    const mainUtxoWithRaw: BitcoinUtxo & BitcoinRawTx = {
      ...mainUtxo,
      transactionHex: mainUtxoRawTransaction.transactionHex,
    }

    const bitcoinNetwork = await this.bitcoinClient.getNetwork()

    const walletKeyPair = BitcoinPrivateKeyUtils.createKeyPair(
      walletPrivateKey,
      bitcoinNetwork
    )

    const walletPublicKey = Hex.from(walletKeyPair.publicKey)

    const redemptionRequests: RedemptionRequest[] = []

    for (const redeemerOutputScript of redeemerOutputScripts) {
      const redemptionRequest =
        await this.tbtcContracts.bridge.pendingRedemptions(
          walletPublicKey,
          redeemerOutputScript
        )

      if (redemptionRequest.requestedAt == 0) {
        throw new Error("Redemption request does not exist")
      }

      redemptionRequests.push({
        ...redemptionRequest,
        redeemerOutputScript,
      })
    }

    const { transactionHash, newMainUtxo, rawTransaction } =
      await this.assembleTransaction(
        bitcoinNetwork,
        walletPrivateKey,
        mainUtxoWithRaw,
        redemptionRequests
      )

    // Note that `broadcast` may fail silently (i.e. no error will be returned,
    // even if the transaction is rejected by other nodes and does not enter the
    // mempool, for example due to an UTXO being already spent).
    await this.bitcoinClient.broadcast(rawTransaction)

    return { transactionHash, newMainUtxo }
  }

  /**
   * Assembles a Bitcoin redemption transaction.
   * The transaction will have a single input (main UTXO of the wallet making
   * the redemption), an output for each redemption request provided, and a change
   * output if the redemption requests do not consume the entire amount of the
   * single input.
   * @dev The caller is responsible for ensuring the redemption request list is
   *      correctly formed:
   *        - there is at least one redemption
   *        - the `requestedAmount` in each redemption request is greater than
   *          the sum of its `txFee` and `treasuryFee`
   * @param bitcoinNetwork The target Bitcoin network.
   * @param walletPrivateKey - The private key of the wallet in the WIF format
   * @param mainUtxo - The main UTXO of the wallet. Must match the main UTXO held
   *        by the on-chain Bridge contract
   * @param redemptionRequests - The list of redemption requests
   * @returns The outcome consisting of:
   *          - the redemption transaction hash,
   *          - the optional new wallet's main UTXO produced by this transaction.
   *          - the redemption transaction in the raw format
   */
  async assembleTransaction(
    bitcoinNetwork: BitcoinNetwork,
    walletPrivateKey: string,
    mainUtxo: BitcoinUtxo & BitcoinRawTx,
    redemptionRequests: RedemptionRequest[]
  ): Promise<{
    transactionHash: BitcoinTxHash
    newMainUtxo?: BitcoinUtxo
    rawTransaction: BitcoinRawTx
  }> {
    if (redemptionRequests.length < 1) {
      throw new Error("There must be at least one request to redeem")
    }

    const walletKeyPair = BitcoinPrivateKeyUtils.createKeyPair(
      walletPrivateKey,
      bitcoinNetwork
    )
    const walletAddress = BitcoinAddressConverter.publicKeyToAddress(
      Hex.from(walletKeyPair.publicKey),
      bitcoinNetwork,
      this.witness
    )

    const network = toBitcoinJsLibNetwork(bitcoinNetwork)
    const psbt = new Psbt({ network })
    psbt.setVersion(1)

    // Add input (current main UTXO).
    const previousOutput = Transaction.fromHex(mainUtxo.transactionHex).outs[
      mainUtxo.outputIndex
    ]
    const previousOutputScript = Hex.from(previousOutput.script)
    const previousOutputValue = previousOutput.value

    if (BitcoinScriptUtils.isP2PKHScript(previousOutputScript)) {
      psbt.addInput({
        hash: mainUtxo.transactionHash.reverse().toBuffer(),
        index: mainUtxo.outputIndex,
        nonWitnessUtxo: Buffer.from(mainUtxo.transactionHex, "hex"),
      })
    } else if (BitcoinScriptUtils.isP2WPKHScript(previousOutputScript)) {
      psbt.addInput({
        hash: mainUtxo.transactionHash.reverse().toBuffer(),
        index: mainUtxo.outputIndex,
        witnessUtxo: {
          script: previousOutputScript.toBuffer(),
          value: previousOutputValue,
        },
      })
    } else {
      throw new Error("Unexpected main UTXO type")
    }

    let txTotalFee = BigNumber.from(0)
    let totalOutputsValue = BigNumber.from(0)

    // Process the requests
    for (const request of redemptionRequests) {
      // Calculate the value of the output by subtracting tx fee and treasury
      // fee for this particular output from the requested amount
      const outputValue = request.requestedAmount
        .sub(request.txMaxFee)
        .sub(request.treasuryFee)

      // Add the output value to the total output value
      totalOutputsValue = totalOutputsValue.add(outputValue)

      // Add the fee for this particular request to the overall transaction fee
      txTotalFee = txTotalFee.add(request.txMaxFee)

      psbt.addOutput({
        script: request.redeemerOutputScript.toBuffer(),
        value: outputValue.toNumber(),
      })
    }

    // If there is a change output, add it to the transaction.
    const changeOutputValue = mainUtxo.value
      .sub(totalOutputsValue)
      .sub(txTotalFee)
    if (changeOutputValue.gt(0)) {
      psbt.addOutput({
        address: walletAddress,
        value: changeOutputValue.toNumber(),
      })
    }

    psbt.signAllInputs(walletKeyPair)
    psbt.finalizeAllInputs()

    const transaction = psbt.extractTransaction()
    const transactionHash = BitcoinTxHash.from(transaction.getId())
    // If there is a change output, it will be the new wallet's main UTXO.
    const newMainUtxo = changeOutputValue.gt(0)
      ? {
          transactionHash,
          // It was the last output added to the transaction.
          outputIndex: transaction.outs.length - 1,
          value: changeOutputValue,
        }
      : undefined

    return {
      transactionHash,
      newMainUtxo,
      rawTransaction: {
        transactionHex: transaction.toHex(),
      },
    }
  }
}
