import {
  assertTaprootDepositSupported,
  DepositorProxy,
  DepositReceipt,
  TBTCContracts,
  validateDepositReceipt,
} from "../../lib/contracts"
import {
  BitcoinClient,
  BitcoinAddressConverter,
  BitcoinHashUtils,
  BitcoinNetwork,
  BitcoinTaprootUtils,
  BitcoinTxOutpoint,
  BitcoinUtxo,
  extractBitcoinRawTxVectors,
  toBitcoinJsLibNetwork,
} from "../../lib/bitcoin"
import { payments, Stack, script, opcodes } from "bitcoinjs-lib"
import { Hex } from "../../lib/utils"
import { TransactionReceipt } from "@ethersproject/providers"

export const DepositScriptType = {
  P2SH: "p2sh",
  P2WSH: "p2wsh",
  P2TR: "p2tr",
} as const

export type DepositScriptType =
  (typeof DepositScriptType)[keyof typeof DepositScriptType]

export type DepositScriptOptions =
  | boolean
  | DepositScriptType
  | {
      scriptType?: DepositScriptType
    }

/**
 * Component representing an instance of the tBTC v2 deposit process.
 * Depositing is a complex process spanning both the Bitcoin and the target chain.
 * This component tries to abstract away that complexity.
 */
export class Deposit {
  /**
   * Bitcoin script corresponding to this deposit.
   */
  private readonly script: DepositScript
  /**
   * Handle to tBTC contracts.
   */
  private readonly tbtcContracts: TBTCContracts
  /**
   * Bitcoin client handle.
   */
  private readonly bitcoinClient: BitcoinClient
  /**
   * Optional depositor proxy used to initiate minting.
   */
  private readonly depositorProxy?: DepositorProxy
  /**
   * Bitcoin network the deposit is relevant for. Has an impact on the
   * generated deposit address.
   */
  public readonly bitcoinNetwork: BitcoinNetwork

  private constructor(
    receipt: DepositReceipt,
    tbtcContracts: TBTCContracts,
    bitcoinClient: BitcoinClient,
    bitcoinNetwork: BitcoinNetwork,
    depositorProxy?: DepositorProxy,
    scriptOptions?: DepositScriptOptions
  ) {
    this.script = DepositScript.fromReceipt(receipt, scriptOptions)
    this.tbtcContracts = tbtcContracts
    this.bitcoinClient = bitcoinClient
    this.bitcoinNetwork = bitcoinNetwork
    this.depositorProxy = depositorProxy
  }

  static async fromReceipt(
    receipt: DepositReceipt,
    tbtcContracts: TBTCContracts,
    bitcoinClient: BitcoinClient,
    depositorProxy?: DepositorProxy,
    scriptOptions?: DepositScriptOptions
  ): Promise<Deposit> {
    const bitcoinNetwork = await bitcoinClient.getNetwork()

    return new Deposit(
      receipt,
      tbtcContracts,
      bitcoinClient,
      bitcoinNetwork,
      depositorProxy,
      scriptOptions
    )
  }

  /**
   * @returns Receipt corresponding to this deposit.
   */
  getReceipt(): DepositReceipt {
    return this.script.receipt
  }

  /**
   * @returns Bitcoin address corresponding to this deposit.
   */
  async getBitcoinAddress(): Promise<string> {
    return this.script.deriveAddress(this.bitcoinNetwork)
  }

  /**
   * Detects Bitcoin funding transactions transferring BTC to this deposit.
   * The list includes UTXOs from both the blockchain and the mempool, sorted by
   * age with the newest ones first. Mempool UTXOs are listed at the beginning.
   * @returns Specific UTXOs targeting this deposit. Empty array in case
   *         there are no UTXOs referring this deposit.
   */
  async detectFunding(): Promise<BitcoinUtxo[]> {
    const utxos = await this.bitcoinClient.findAllUnspentTransactionOutputs(
      await this.getBitcoinAddress()
    )

    if (!utxos || utxos.length === 0) {
      return []
    }

    return utxos
  }

  /**
   * Initiates minting of the TBTC token, based on the Bitcoin funding
   * transaction outpoint targeting this deposit. By default, it detects and
   * uses the outpoint of the recent Bitcoin funding transaction and throws if
   * such a transaction does not exist. This behavior can be changed by pointing
   * a funding transaction explicitly, using the fundingOutpoint parameter.
   * @param fundingOutpoint Optional parameter. Can be used to point
   *        the funding transaction's outpoint manually.
   * @returns Target chain hash of the initiate minting transaction.
   * @throws Throws an error if there are no funding transactions while using
   *         the default funding detection mode.
   * @throws Throws an error if the provided funding outpoint does not
   *         actually refer to this deposit while using the manual funding
   *         provision mode.
   * @throws Throws an error if the funding outpoint was already used to
   *         initiate minting (both modes).
   * @throws Throws an error if a Taproot deposit uses a depositor proxy that
   *         has not explicitly declared Taproot support.
   */
  async initiateMinting(
    fundingOutpoint?: BitcoinTxOutpoint
  ): Promise<Hex | TransactionReceipt> {
    const receipt = this.getReceipt()

    if (typeof this.depositorProxy !== "undefined") {
      assertTaprootDepositSupported(this.depositorProxy, receipt)
    }

    let resolvedFundingOutpoint: BitcoinTxOutpoint

    if (typeof fundingOutpoint !== "undefined") {
      resolvedFundingOutpoint = fundingOutpoint
    } else {
      const fundingUtxos = await this.detectFunding()

      if (fundingUtxos.length == 0) {
        throw new Error("Deposit not funded yet")
      }

      // Take the most recent one.
      resolvedFundingOutpoint = fundingUtxos[0]
    }

    const { transactionHash, outputIndex } = resolvedFundingOutpoint

    const depositFundingTx = extractBitcoinRawTxVectors(
      await this.bitcoinClient.getRawTransaction(transactionHash)
    )

    const { bridge, tbtcVault } = this.tbtcContracts

    if (typeof this.depositorProxy !== "undefined") {
      return this.depositorProxy.revealDeposit(
        depositFundingTx,
        outputIndex,
        receipt,
        tbtcVault.getChainIdentifier()
      )
    }

    return bridge.revealDeposit(
      depositFundingTx,
      outputIndex,
      receipt,
      tbtcVault.getChainIdentifier()
    )
  }
}

/**
 * Represents a Bitcoin script corresponding to a tBTC v2 deposit.
 * On a high-level, the script is used to derive the Bitcoin address that is
 * used to fund the deposit with BTC. On a low-level, the script is used to
 * produce a properly locked funding transaction output that can be unlocked
 * by the target wallet during the deposit sweep process.
 */
export class DepositScript {
  /**
   * Deposit receipt holding the most important information about the deposit
   * and allowing to build a unique deposit script (and address) on Bitcoin chain.
   */
  public readonly receipt: DepositReceipt
  /**
   * Flag indicating whether the generated Bitcoin deposit script (and address)
   * should be a witness P2WSH one. If false, legacy P2SH will be used instead.
   */
  public readonly witness: boolean
  /**
   * Deposit script/address type.
   */
  public readonly scriptType: DepositScriptType

  private constructor(receipt: DepositReceipt, scriptType: DepositScriptType) {
    validateDepositReceipt(receipt)

    if (
      scriptType == DepositScriptType.P2TR &&
      (!receipt.walletXOnlyPublicKey || !receipt.refundXOnlyPublicKey)
    ) {
      throw new Error(
        "Taproot deposit script requires wallet and refund x-only public keys"
      )
    }

    this.receipt = receipt
    this.scriptType = scriptType
    this.witness =
      scriptType == DepositScriptType.P2WSH ||
      scriptType == DepositScriptType.P2TR
  }

  static fromReceipt(
    receipt: DepositReceipt,
    options: DepositScriptOptions = inferDepositScriptType(receipt)
  ): DepositScript {
    return new DepositScript(receipt, normalizeDepositScriptType(options))
  }

  /**
   * @returns Hashed deposit script as Buffer.
   */
  async getHash(): Promise<Buffer> {
    if (this.scriptType == DepositScriptType.P2TR) {
      return (await this.getTaprootLeafHash()).toBuffer()
    }

    const script = await this.getPlainText()
    // If witness script hash should be produced, SHA256 should be used.
    // Legacy script hash needs HASH160.
    return this.scriptType == DepositScriptType.P2WSH
      ? BitcoinHashUtils.computeSha256(script).toBuffer()
      : BitcoinHashUtils.computeHash160(script).toBuffer()
  }

  /**
   * @returns Plain-text deposit script as a hex string.
   */
  async getPlainText(): Promise<Hex> {
    if (this.scriptType == DepositScriptType.P2TR) {
      return this.getTaprootRefundScript()
    }

    const chunks: Stack = []

    // All HEXes pushed to the script must be un-prefixed
    chunks.push(Buffer.from(this.receipt.depositor.identifierHex, "hex"))
    chunks.push(opcodes.OP_DROP)

    const extraData = this.receipt.extraData
    if (typeof extraData !== "undefined") {
      chunks.push(extraData.toBuffer())
      chunks.push(opcodes.OP_DROP)
    }

    chunks.push(this.receipt.blindingFactor.toBuffer())
    chunks.push(opcodes.OP_DROP)
    chunks.push(opcodes.OP_DUP)
    chunks.push(opcodes.OP_HASH160)
    chunks.push(this.receipt.walletPublicKeyHash.toBuffer())
    chunks.push(opcodes.OP_EQUAL)
    chunks.push(opcodes.OP_IF)
    chunks.push(opcodes.OP_CHECKSIG)
    chunks.push(opcodes.OP_ELSE)
    chunks.push(opcodes.OP_DUP)
    chunks.push(opcodes.OP_HASH160)
    chunks.push(this.receipt.refundPublicKeyHash.toBuffer())
    chunks.push(opcodes.OP_EQUALVERIFY)
    chunks.push(this.receipt.refundLocktime.toBuffer())
    chunks.push(opcodes.OP_CHECKLOCKTIMEVERIFY)
    chunks.push(opcodes.OP_DROP)
    chunks.push(opcodes.OP_CHECKSIG)
    chunks.push(opcodes.OP_ENDIF)

    return Hex.from(script.compile(chunks))
  }

  /**
   * @returns Tapscript refund leaf for a Taproot-native deposit.
   */
  async getTaprootRefundScript(): Promise<Hex> {
    const refundXOnlyPublicKey = this.receipt.refundXOnlyPublicKey
    if (!refundXOnlyPublicKey) {
      throw new Error("Taproot refund key is missing")
    }

    const chunks: Stack = []

    chunks.push(Buffer.from(this.receipt.depositor.identifierHex, "hex"))
    chunks.push(opcodes.OP_DROP)

    const extraData = this.receipt.extraData
    if (typeof extraData !== "undefined") {
      chunks.push(extraData.toBuffer())
      chunks.push(opcodes.OP_DROP)
    }

    chunks.push(this.receipt.blindingFactor.toBuffer())
    chunks.push(opcodes.OP_DROP)
    chunks.push(this.receipt.refundLocktime.toBuffer())
    chunks.push(opcodes.OP_CHECKLOCKTIMEVERIFY)
    chunks.push(opcodes.OP_DROP)
    chunks.push(refundXOnlyPublicKey.toBuffer())
    chunks.push(opcodes.OP_CHECKSIG)

    return Hex.from(script.compile(chunks))
  }

  /**
   * @returns TapLeaf hash of the Taproot refund script.
   */
  async getTaprootLeafHash(): Promise<Hex> {
    return BitcoinTaprootUtils.tapLeafHash(await this.getTaprootRefundScript())
  }

  /**
   * @returns Taproot merkle root for this deposit's script tree.
   */
  async getTaprootMerkleRoot(): Promise<Hex> {
    return this.getTaprootLeafHash()
  }

  /**
   * @returns X-only Taproot output key committing to the refund script.
   */
  async getTaprootOutputKey(): Promise<Hex> {
    const walletXOnlyPublicKey = this.receipt.walletXOnlyPublicKey
    if (!walletXOnlyPublicKey) {
      throw new Error("Taproot wallet key is missing")
    }

    return BitcoinTaprootUtils.deriveTaprootOutputKey(
      walletXOnlyPublicKey,
      await this.getTaprootMerkleRoot()
    )
  }

  /**
   * Derives a Bitcoin address for the given network for this deposit script.
   * @param bitcoinNetwork Bitcoin network the address should be derived for.
   * @returns Bitcoin address corresponding to this deposit script.
   */
  async deriveAddress(bitcoinNetwork: BitcoinNetwork): Promise<string> {
    if (this.scriptType == DepositScriptType.P2TR) {
      return BitcoinAddressConverter.taprootOutputKeyToAddress(
        await this.getTaprootOutputKey(),
        bitcoinNetwork
      )
    }

    const scriptHash = await this.getHash()

    const bitcoinJsLibNetwork = toBitcoinJsLibNetwork(bitcoinNetwork)

    if (this.scriptType == DepositScriptType.P2WSH) {
      // OP_0 <hash-length> <hash>
      const p2wshOutput = Buffer.concat([
        Buffer.from([opcodes.OP_0, 0x20]),
        scriptHash,
      ])

      return payments.p2wsh({
        output: p2wshOutput,
        network: bitcoinJsLibNetwork,
      }).address!
    } else {
      // OP_HASH160 <hash-length> <hash> OP_EQUAL
      const p2shOutput = Buffer.concat([
        Buffer.from([opcodes.OP_HASH160, 0x14]),
        scriptHash,
        Buffer.from([opcodes.OP_EQUAL]),
      ])

      return payments.p2sh({ output: p2shOutput, network: bitcoinJsLibNetwork })
        .address!
    }
  }

  /**
   * Derives a Bitcoin output script for the given network for this deposit
   * script.
   * @param bitcoinNetwork Bitcoin network the output script should be derived
   *                       for.
   * @returns Output script not prepended with length.
   */
  async deriveOutputScript(bitcoinNetwork: BitcoinNetwork): Promise<Buffer> {
    if (this.scriptType == DepositScriptType.P2TR) {
      return Buffer.concat([
        Buffer.from([opcodes.OP_1, 0x20]),
        (await this.getTaprootOutputKey()).toBuffer(),
      ])
    }

    return BitcoinAddressConverter.addressToOutputScript(
      await this.deriveAddress(bitcoinNetwork),
      bitcoinNetwork
    ).toBuffer()
  }
}

function inferDepositScriptType(receipt: DepositReceipt): DepositScriptType {
  return receipt.walletXOnlyPublicKey && receipt.refundXOnlyPublicKey
    ? DepositScriptType.P2TR
    : DepositScriptType.P2WSH
}

function normalizeDepositScriptType(
  options: DepositScriptOptions
): DepositScriptType {
  if (typeof options == "boolean") {
    return options ? DepositScriptType.P2WSH : DepositScriptType.P2SH
  }

  if (typeof options == "string") {
    return options
  }

  return options.scriptType ?? DepositScriptType.P2WSH
}
