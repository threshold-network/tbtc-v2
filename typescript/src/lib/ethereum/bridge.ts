import {
  Bridge as BridgeTypechain,
  Deposit as DepositTypechain,
  Redemption as RedemptionTypechain,
  Wallets as WalletsTypechain,
} from "../../../typechain/Bridge"
import {
  Bridge,
  GetChainEvents,
  ChainIdentifier,
  WalletRegistry,
  NewWalletRegisteredEvent,
  Wallet,
  WalletState,
  RedemptionRequest,
  RedemptionRequestedEvent,
  DepositRevealedEvent,
  DepositReceipt,
  DepositRequest,
  Chains,
} from "../contracts"
import { Event as EthersEvent } from "@ethersproject/contracts"
import { BigNumber, constants, ContractTransaction, utils } from "ethers"
import { backoffRetrier, Hex } from "../utils"
import {
  BitcoinPublicKeyUtils,
  BitcoinHashUtils,
  BitcoinRawTxVectors,
  BitcoinSpvProof,
  BitcoinCompactSizeUint,
  BitcoinTxHash,
  BitcoinUtxo,
} from "../bitcoin"
import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
  EthersTransactionUtils,
} from "./adapter"
import { EthereumAddress } from "./address"
import { EthereumWalletRegistry } from "./wallet-registry"

import MainnetBridgeDeployment from "./artifacts/mainnet/Bridge.json"
import SepoliaBridgeDeployment from "./artifacts/sepolia/Bridge.json"
import LocalBridgeDeployment from "@keep-network/tbtc-v2/artifacts/Bridge.json"

type DepositRequestTypechain = DepositTypechain.DepositRequestStructOutput

type RedemptionRequestTypechain =
  RedemptionTypechain.RedemptionRequestStructOutput

/**
 * Implementation of the Ethereum Bridge handle.
 * @see {Bridge} for reference.
 */
export class EthereumBridge
  extends EthersContractHandle<BridgeTypechain>
  implements Bridge
{
  private static legacyWalletIDFromPublicKeyHash(
    walletPublicKeyHash: Hex
  ): Hex {
    return Hex.from(
      utils.hexZeroPad(walletPublicKeyHash.toPrefixedString(), 32)
    )
  }

  private static walletRegistrationFilterArgs(filterArgs: Array<unknown>): {
    legacyFilterArgs: Array<unknown>
    v2FilterArgs: Array<unknown>
  } {
    if (filterArgs.length === 0) {
      return {
        legacyFilterArgs: [],
        v2FilterArgs: [],
      }
    }

    if (filterArgs.length <= 2) {
      return {
        legacyFilterArgs: filterArgs,
        v2FilterArgs: [undefined, ...filterArgs],
      }
    }

    return {
      legacyFilterArgs: filterArgs.slice(1),
      v2FilterArgs: filterArgs,
    }
  }

  private static compareEventsByChainOrder(
    left: EthersEvent,
    right: EthersEvent
  ): number {
    return (
      left.blockNumber - right.blockNumber ||
      (left.transactionIndex ?? 0) - (right.transactionIndex ?? 0) ||
      (left.logIndex ?? 0) - (right.logIndex ?? 0)
    )
  }

  private static parseLegacyNewWalletRegisteredEvent(
    event: EthersEvent
  ): NewWalletRegisteredEvent {
    const walletPublicKeyHash = Hex.from(event.args!.walletPubKeyHash)

    return {
      blockNumber: BigNumber.from(event.blockNumber).toNumber(),
      blockHash: Hex.from(event.blockHash),
      transactionHash: Hex.from(event.transactionHash),
      walletID:
        EthereumBridge.legacyWalletIDFromPublicKeyHash(walletPublicKeyHash),
      ecdsaWalletID: Hex.from(event.args!.ecdsaWalletID),
      walletPublicKeyHash,
    }
  }

  private static parseV2NewWalletRegisteredEvent(
    event: EthersEvent
  ): NewWalletRegisteredEvent {
    return {
      blockNumber: BigNumber.from(event.blockNumber).toNumber(),
      blockHash: Hex.from(event.blockHash),
      transactionHash: Hex.from(event.transactionHash),
      walletID: Hex.from(event.args!.walletID),
      ecdsaWalletID: Hex.from(event.args!.ecdsaWalletID),
      walletPublicKeyHash: Hex.from(event.args!.walletPubKeyHash),
    }
  }

  constructor(
    config: EthersContractConfig,
    chainId: Chains.Ethereum = Chains.Ethereum.Local
  ) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Local:
        deployment = LocalBridgeDeployment
        break
      case Chains.Ethereum.Sepolia:
        deployment = SepoliaBridgeDeployment
        break
      case Chains.Ethereum.Mainnet:
        deployment = MainnetBridgeDeployment
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return EthereumAddress.from(this._instance.address)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#getDepositRevealedEvents}
   */
  async getDepositRevealedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<DepositRevealedEvent[]> {
    const events: EthersEvent[] = await this.getEvents(
      "DepositRevealed",
      options,
      ...filterArgs
    )

    return events.map<DepositRevealedEvent>((event) => {
      return {
        blockNumber: BigNumber.from(event.blockNumber).toNumber(),
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        fundingTxHash: BitcoinTxHash.from(event.args!.fundingTxHash).reverse(),
        fundingOutputIndex: BigNumber.from(
          event.args!.fundingOutputIndex
        ).toNumber(),
        depositor: EthereumAddress.from(event.args!.depositor),
        amount: BigNumber.from(event.args!.amount),
        blindingFactor: Hex.from(event.args!.blindingFactor),
        walletPublicKeyHash: Hex.from(event.args!.walletPubKeyHash),
        refundPublicKeyHash: Hex.from(event.args!.refundPubKeyHash),
        refundLocktime: Hex.from(event.args!.refundLocktime),
        vault:
          event.args!.vault === constants.AddressZero
            ? undefined
            : EthereumAddress.from(event.args!.vault),
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#pendingRedemptions}
   */
  async pendingRedemptions(
    walletPublicKey: Hex,
    redeemerOutputScript: Hex
  ): Promise<RedemptionRequest> {
    const walletPublicKeyHash = BitcoinHashUtils.computeHash160(walletPublicKey)
    return this.pendingRedemptionsByWalletPKH(
      walletPublicKeyHash,
      redeemerOutputScript
    )
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#pendingRedemptionsByWalletPKH}
   */
  async pendingRedemptionsByWalletPKH(
    walletPublicKeyHash: Hex,
    redeemerOutputScript: Hex
  ): Promise<RedemptionRequest> {
    const redemptionKey = EthereumBridge.buildRedemptionKey(
      walletPublicKeyHash,
      redeemerOutputScript
    )

    const request: RedemptionRequestTypechain =
      await backoffRetrier<RedemptionRequestTypechain>(
        this._totalRetryAttempts
      )(async () => {
        return await this._instance.pendingRedemptions(redemptionKey)
      })

    return this.parseRedemptionRequest(request, redeemerOutputScript)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#timedOutRedemptions}
   */
  async timedOutRedemptions(
    walletPublicKey: Hex,
    redeemerOutputScript: Hex
  ): Promise<RedemptionRequest> {
    const redemptionKey = EthereumBridge.buildRedemptionKey(
      BitcoinHashUtils.computeHash160(walletPublicKey),
      redeemerOutputScript
    )

    const request: RedemptionRequestTypechain =
      await backoffRetrier<RedemptionRequestTypechain>(
        this._totalRetryAttempts
      )(async () => {
        return await this._instance.timedOutRedemptions(redemptionKey)
      })

    return this.parseRedemptionRequest(request, redeemerOutputScript)
  }

  /**
   * Builds a redemption key required to refer a redemption request.
   * @param walletPublicKeyHash The wallet public key hash that identifies the
   *        pending redemption (along with the redeemer output script).
   * @param redeemerOutputScript The redeemer output script that identifies the
   *        pending redemption (along with the wallet public key hash). Must not
   *        be prepended with length.
   * @returns The redemption key.
   */
  static buildRedemptionKey(
    walletPublicKeyHash: Hex,
    redeemerOutputScript: Hex
  ): string {
    // Convert the output script to raw bytes buffer.
    const rawRedeemerOutputScript = redeemerOutputScript.toBuffer()
    // Prefix the output script bytes buffer with 0x and its own length.
    const prefixedRawRedeemerOutputScript = `0x${Buffer.concat([
      Buffer.from([rawRedeemerOutputScript.length]),
      rawRedeemerOutputScript,
    ]).toString("hex")}`
    // Build the redemption key by using the 0x-prefixed wallet PKH and
    // prefixed output script.
    return utils.solidityKeccak256(
      ["bytes32", "bytes20"],
      [
        utils.solidityKeccak256(["bytes"], [prefixedRawRedeemerOutputScript]),
        `0x${walletPublicKeyHash.toString()}`,
      ]
    )
  }

  /**
   * Parses a redemption request using data fetched from the on-chain contract.
   * @param request Data of the request.
   * @param redeemerOutputScript The redeemer output script that identifies the
   *        pending redemption (along with the wallet public key hash). Must not
   *        be prepended with length.
   * @returns Parsed redemption request.
   */
  private parseRedemptionRequest(
    request: RedemptionRequestTypechain,
    redeemerOutputScript: Hex
  ): RedemptionRequest {
    return {
      redeemer: EthereumAddress.from(request.redeemer),
      redeemerOutputScript: redeemerOutputScript,
      requestedAmount: BigNumber.from(request.requestedAmount),
      treasuryFee: BigNumber.from(request.treasuryFee),
      txMaxFee: BigNumber.from(request.txMaxFee),
      requestedAt: BigNumber.from(request.requestedAt).toNumber(),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#revealDeposit}
   */
  async revealDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex> {
    const { fundingTx, reveal, extraData } = packRevealDepositParameters(
      depositTx,
      depositOutputIndex,
      deposit,
      vault
    )

    const tx = await EthersTransactionUtils.sendWithRetry<ContractTransaction>(
      async () => {
        if (typeof extraData !== "undefined") {
          return await this._instance.revealDepositWithExtraData(
            fundingTx,
            reveal,
            extraData
          )
        }

        return await this._instance.revealDeposit(fundingTx, reveal)
      },
      this._totalRetryAttempts,
      undefined,
      ["Deposit already revealed"]
    )

    return Hex.from(tx.hash)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#submitDepositSweepProof}
   */
  async submitDepositSweepProof(
    sweepTx: BitcoinRawTxVectors,
    sweepProof: BitcoinSpvProof,
    mainUtxo: BitcoinUtxo,
    vault?: ChainIdentifier
  ): Promise<Hex> {
    const sweepTxParam = {
      version: `0x${sweepTx.version}`,
      inputVector: `0x${sweepTx.inputs}`,
      outputVector: `0x${sweepTx.outputs}`,
      locktime: `0x${sweepTx.locktime}`,
    }

    const sweepProofParam = {
      merkleProof: sweepProof.merkleProof.toPrefixedString(),
      txIndexInBlock: sweepProof.txIndexInBlock,
      bitcoinHeaders: sweepProof.bitcoinHeaders.toPrefixedString(),
      coinbasePreimage: sweepProof.coinbasePreimage.toPrefixedString(),
      coinbaseProof: sweepProof.coinbaseProof.toPrefixedString(),
    }

    const mainUtxoParam = {
      // The Ethereum Bridge expects this hash to be in the Bitcoin internal
      // byte order.
      txHash: mainUtxo.transactionHash.reverse().toPrefixedString(),
      txOutputIndex: mainUtxo.outputIndex,
      txOutputValue: mainUtxo.value,
    }

    const vaultParam = vault
      ? `0x${vault.identifierHex}`
      : constants.AddressZero

    const tx = await EthersTransactionUtils.sendWithRetry<ContractTransaction>(
      async () => {
        return await this._instance.submitDepositSweepProof(
          sweepTxParam,
          sweepProofParam,
          mainUtxoParam,
          vaultParam
        )
      },
      this._totalRetryAttempts
    )

    return Hex.from(tx.hash)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#txProofDifficultyFactor}
   */
  async txProofDifficultyFactor(): Promise<number> {
    const txProofDifficultyFactor: BigNumber = await backoffRetrier<BigNumber>(
      this._totalRetryAttempts
    )(async () => {
      return await this._instance.txProofDifficultyFactor()
    })

    return txProofDifficultyFactor.toNumber()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#requestRedemption}
   */
  async requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex,
    amount: BigNumber
  ): Promise<Hex> {
    const walletPublicKeyHash =
      BitcoinHashUtils.computeHash160(walletPublicKey).toPrefixedString()

    const mainUtxoParam = {
      // The Ethereum Bridge expects this hash to be in the Bitcoin internal
      // byte order.
      txHash: mainUtxo.transactionHash.reverse().toPrefixedString(),
      txOutputIndex: mainUtxo.outputIndex,
      txOutputValue: mainUtxo.value,
    }

    // Convert the output script to raw bytes buffer.
    const rawRedeemerOutputScript = redeemerOutputScript.toBuffer()
    // Prefix the output script bytes buffer with 0x and its own length.
    const prefixedRawRedeemerOutputScript = `0x${Buffer.concat([
      Buffer.from([rawRedeemerOutputScript.length]),
      rawRedeemerOutputScript,
    ]).toString("hex")}`

    const tx = await EthersTransactionUtils.sendWithRetry<ContractTransaction>(
      async () => {
        return await this._instance.requestRedemption(
          walletPublicKeyHash,
          mainUtxoParam,
          prefixedRawRedeemerOutputScript,
          amount
        )
      },
      this._totalRetryAttempts
    )

    return Hex.from(tx.hash)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#submitRedemptionProof}
   */
  async submitRedemptionProof(
    redemptionTx: BitcoinRawTxVectors,
    redemptionProof: BitcoinSpvProof,
    mainUtxo: BitcoinUtxo,
    walletPublicKey: Hex
  ): Promise<Hex> {
    const redemptionTxParam = {
      version: `0x${redemptionTx.version}`,
      inputVector: `0x${redemptionTx.inputs}`,
      outputVector: `0x${redemptionTx.outputs}`,
      locktime: `0x${redemptionTx.locktime}`,
    }

    const redemptionProofParam = {
      merkleProof: redemptionProof.merkleProof.toPrefixedString(),
      txIndexInBlock: redemptionProof.txIndexInBlock,
      bitcoinHeaders: redemptionProof.bitcoinHeaders.toPrefixedString(),
      coinbasePreimage: redemptionProof.coinbasePreimage.toPrefixedString(),
      coinbaseProof: redemptionProof.coinbaseProof.toPrefixedString(),
    }

    const mainUtxoParam = {
      // The Ethereum Bridge expects this hash to be in the Bitcoin internal
      // byte order.
      txHash: mainUtxo.transactionHash.reverse().toPrefixedString(),
      txOutputIndex: mainUtxo.outputIndex,
      txOutputValue: mainUtxo.value,
    }

    const walletPublicKeyHash =
      BitcoinHashUtils.computeHash160(walletPublicKey).toPrefixedString()

    const tx = await EthersTransactionUtils.sendWithRetry<ContractTransaction>(
      async () => {
        return await this._instance.submitRedemptionProof(
          redemptionTxParam,
          redemptionProofParam,
          mainUtxoParam,
          walletPublicKeyHash
        )
      },
      this._totalRetryAttempts
    )

    return Hex.from(tx.hash)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#deposits}
   */
  async deposits(
    depositTxHash: BitcoinTxHash,
    depositOutputIndex: number
  ): Promise<DepositRequest> {
    const depositKey = EthereumBridge.buildDepositKey(
      depositTxHash,
      depositOutputIndex
    )

    const deposit: DepositRequestTypechain =
      await backoffRetrier<DepositRequestTypechain>(this._totalRetryAttempts)(
        async () => {
          return await this._instance.deposits(depositKey)
        }
      )

    return this.parseDepositRequest(deposit)
  }

  /**
   * Builds the deposit key required to refer a revealed deposit.
   * @param depositTxHash The revealed deposit transaction's hash.
   * @param depositOutputIndex Index of the deposit transaction output that
   *        funds the revealed deposit.
   * @returns Deposit key.
   */
  static buildDepositKey(
    depositTxHash: BitcoinTxHash,
    depositOutputIndex: number
  ): string {
    const prefixedReversedDepositTxHash = depositTxHash
      .reverse()
      .toPrefixedString()

    return utils.solidityKeccak256(
      ["bytes32", "uint32"],
      [prefixedReversedDepositTxHash, depositOutputIndex]
    )
  }

  /**
   * Parses a deposit request using data fetched from the on-chain contract.
   * @param deposit Data of the deposit request.
   * @returns Parsed deposit request.
   */
  private parseDepositRequest(
    deposit: DepositRequestTypechain
  ): DepositRequest {
    return {
      depositor: EthereumAddress.from(deposit.depositor),
      amount: BigNumber.from(deposit.amount),
      vault:
        deposit.vault === constants.AddressZero
          ? undefined
          : EthereumAddress.from(deposit.vault),
      revealedAt: BigNumber.from(deposit.revealedAt).toNumber(),
      sweptAt: BigNumber.from(deposit.sweptAt).toNumber(),
      treasuryFee: BigNumber.from(deposit.treasuryFee),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#activeWalletPublicKeyHash}
   */
  async activeWalletPublicKeyHash(): Promise<Hex | undefined> {
    const activeWalletPublicKeyHash: string = await backoffRetrier<string>(
      this._totalRetryAttempts
    )(async () => {
      return await this._instance.activeWalletPubKeyHash()
    })

    if (
      activeWalletPublicKeyHash === "0x0000000000000000000000000000000000000000"
    ) {
      // If there is no active wallet currently, return undefined.
      return undefined
    }

    return Hex.from(activeWalletPublicKeyHash)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#activeWalletPublicKey}
   */
  async activeWalletPublicKey(): Promise<Hex | undefined> {
    const activeWalletPublicKeyHash = await this.activeWalletPublicKeyHash()

    if (!activeWalletPublicKeyHash) {
      return undefined
    }

    const { walletPublicKey } = await this.wallets(
      activeWalletPublicKeyHash
    )

    return walletPublicKey
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#activeWalletID}
   */
  async activeWalletID(): Promise<Hex | undefined> {
    const bridgeContract = this._instance as unknown as {
      activeWalletID?: () => Promise<string>
      activeWalletPubKeyHash: () => Promise<string>
    }

    if (typeof bridgeContract.activeWalletID === "function") {
      const walletID = await backoffRetrier<string>(this._totalRetryAttempts)(
        async () => bridgeContract.activeWalletID!()
      )

      if (walletID === constants.HashZero) {
        return undefined
      }

      return Hex.from(walletID)
    }

    const activeWalletPublicKeyHash: string = await backoffRetrier<string>(
      this._totalRetryAttempts
    )(async () => {
      return await bridgeContract.activeWalletPubKeyHash()
    })

    if (
      activeWalletPublicKeyHash === "0x0000000000000000000000000000000000000000"
    ) {
      return undefined
    }

    return EthereumBridge.legacyWalletIDFromPublicKeyHash(
      Hex.from(activeWalletPublicKeyHash)
    )
  }

  private async getWalletCompressedPublicKey(
    ecdsaWalletID: Hex
  ): Promise<Hex | undefined> {
    const walletRegistry = await this.walletRegistry()

    try {
      const uncompressedPublicKey = await walletRegistry.getWalletPublicKey(
        ecdsaWalletID
      )

      return Hex.from(
        BitcoinPublicKeyUtils.compressPublicKey(uncompressedPublicKey)
      )
    } catch (error) {
      console.log(
        `cannot get wallet public key for ${ecdsaWalletID}; error: ${error}`
      )

      return undefined
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#getNewWalletRegisteredEvents}
   */
  async getNewWalletRegisteredEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<NewWalletRegisteredEvent[]> {
    const { legacyFilterArgs, v2FilterArgs } =
      EthereumBridge.walletRegistrationFilterArgs(filterArgs)
    const legacyEvents: EthersEvent[] = await this.getEvents(
      "NewWalletRegistered",
      options,
      ...legacyFilterArgs
    )
    let v2Events: EthersEvent[] = []

    try {
      v2Events = await this.getEvents(
        "NewWalletRegisteredV2",
        options,
        ...v2FilterArgs
      )
    } catch {
      v2Events = []
    }

    return [
      ...legacyEvents.map((event) => ({
        event,
        parsed: EthereumBridge.parseLegacyNewWalletRegisteredEvent(event),
      })),
      ...v2Events.map((event) => ({
        event,
        parsed: EthereumBridge.parseV2NewWalletRegisteredEvent(event),
      })),
    ]
      .sort((left, right) =>
        EthereumBridge.compareEventsByChainOrder(left.event, right.event)
      )
      .map(({ parsed }) => parsed)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#walletRegistry}
   */
  async walletRegistry(): Promise<WalletRegistry> {
    const { ecdsaWalletRegistry } = await backoffRetrier<{
      ecdsaWalletRegistry: string
    }>(this._totalRetryAttempts)(async () => {
      return await this._instance.contractReferences()
    })

    return new EthereumWalletRegistry({
      address: ecdsaWalletRegistry,
      signerOrProvider: this._instance.signer || this._instance.provider,
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#wallets}
   */
  async wallets(walletPublicKeyHash: Hex): Promise<Wallet> {
    const wallet = await backoffRetrier<WalletsTypechain.WalletStructOutput>(
      this._totalRetryAttempts
    )(async () => {
      return await this._instance.wallets(
        walletPublicKeyHash.toPrefixedString()
      )
    })

    const walletID = await this.walletID(walletPublicKeyHash)

    return this.parseWalletDetails(wallet, walletID)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#walletsByWalletID}
   */
  async walletsByWalletID(walletID: Hex): Promise<Wallet> {
    const bridgeContract = this._instance as unknown as {
      walletsByWalletID?: (
        walletID: string
      ) => Promise<WalletsTypechain.WalletStructOutput>
    }

    if (typeof bridgeContract.walletsByWalletID === "function") {
      const wallet = await backoffRetrier<WalletsTypechain.WalletStructOutput>(
        this._totalRetryAttempts
      )(async () => {
        return await bridgeContract.walletsByWalletID!(
          walletID.toPrefixedString()
        )
      })

      return this.parseWalletDetails(wallet, walletID)
    }

    const walletPublicKeyHash = await this.walletPublicKeyHashForWalletID(
      walletID
    )
    return this.wallets(walletPublicKeyHash)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#walletID}
   */
  async walletID(walletPublicKeyHash: Hex): Promise<Hex> {
    const bridgeContract = this._instance as unknown as {
      walletID?: (walletPubKeyHash: string) => Promise<string>
    }

    if (typeof bridgeContract.walletID === "function") {
      const walletID = await backoffRetrier<string>(this._totalRetryAttempts)(
        async () => {
          return await bridgeContract.walletID!(
            walletPublicKeyHash.toPrefixedString()
          )
        }
      )

      return Hex.from(walletID)
    }

    return EthereumBridge.legacyWalletIDFromPublicKeyHash(walletPublicKeyHash)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#walletPublicKeyHashForWalletID}
   */
  async walletPublicKeyHashForWalletID(walletID: Hex): Promise<Hex> {
    const bridgeContract = this._instance as unknown as {
      walletPubKeyHashForWalletID?: (walletID: string) => Promise<string>
    }

    if (typeof bridgeContract.walletPubKeyHashForWalletID === "function") {
      const walletPublicKeyHash = await backoffRetrier<string>(
        this._totalRetryAttempts
      )(async () => {
        return await bridgeContract.walletPubKeyHashForWalletID!(
          walletID.toPrefixedString()
        )
      })

      return Hex.from(walletPublicKeyHash)
    }

    // Legacy fallback for pre-upgrade contracts: wallet ID is a left-padded
    // bytes20 walletPubKeyHash, so the high 12 bytes are guaranteed to be
    // zero. Reject any wallet ID whose high 12 bytes are non-zero — that
    // shape can only come from a native 32-byte wallet ID (e.g. a future
    // FROST/Taproot wallet whose canonical identifier is not derivable
    // from a 20-byte legacy alias), and slicing the low 20 bytes would
    // silently misresolve it to a bogus legacy wallet key.
    //
    // Callers hitting this branch should upgrade the SDK to a Bridge ABI
    // that exposes `walletPubKeyHashForWalletID` so resolution happens
    // on-chain through the canonical mapping.
    const walletIDHex = walletID.toString()
    const highBytesHex = walletIDHex.slice(0, 24)
    if (!/^0+$/.test(highBytesHex)) {
      throw new Error(
        "Bridge ABI lacks walletPubKeyHashForWalletID and the wallet ID " +
          "is not a left-padded legacy alias (high 12 bytes are non-zero). " +
          "Upgrade the SDK to use a post-upgrade Bridge ABI so wallet ID " +
          "resolution can go through the on-chain canonical mapping."
      )
    }
    return Hex.from(`0x${walletIDHex.slice(24)}`)
  }

  /**
   * Parses a wallet data using data fetched from the on-chain contract.
   * @param wallet Data of the wallet.
   * @param walletID Optional canonical wallet identifier. When provided,
   *        the legacy `walletPublicKeyHash` field is overridden with the
   *        canonical mapping lookup derived from this ID.
   * @returns Parsed wallet data.
   */
  private async parseWalletDetails(
    wallet: WalletsTypechain.WalletStructOutput,
    walletID?: Hex
  ): Promise<Wallet> {
    const ecdsaWalletID = Hex.from(wallet.ecdsaWalletID)

    return {
      walletID,
      ecdsaWalletID,
      walletPublicKey: await this.getWalletCompressedPublicKey(ecdsaWalletID),
      mainUtxoHash: Hex.from(wallet.mainUtxoHash),
      pendingRedemptionsValue: wallet.pendingRedemptionsValue,
      createdAt: wallet.createdAt,
      movingFundsRequestedAt: wallet.movingFundsRequestedAt,
      closingStartedAt: wallet.closingStartedAt,
      pendingMovedFundsSweepRequestsCount:
        wallet.pendingMovedFundsSweepRequestsCount,
      state: WalletState.parse(wallet.state),
      movingFundsTargetWalletsCommitmentHash: Hex.from(
        wallet.movingFundsTargetWalletsCommitmentHash
      ),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * Builds the UTXO hash based on the UTXO components. UTXO hash is computed as
   * `keccak256(txHash | txOutputIndex | txOutputValue)`.
   *
   * @see {Bridge#buildUtxoHash}
   */
  buildUtxoHash(utxo: BitcoinUtxo): Hex {
    return Hex.from(
      utils.solidityKeccak256(
        ["bytes32", "uint32", "uint64"],
        [
          utxo.transactionHash.reverse().toPrefixedString(),
          utxo.outputIndex,
          utxo.value,
        ]
      )
    )
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#getDepositRevealedEvents}
   */
  async getRedemptionRequestedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<RedemptionRequestedEvent[]> {
    // FIXME: Filtering by indexed walletPubKeyHash field may not work
    //        until https://github.com/ethers-io/ethers.js/pull/4244 is
    //        included in the currently used version of ethers.js.
    //        Ultimately, we should upgrade ethers.js to include that fix.
    //        Short-term, we can workaround the problem as presented in:
    //        https://github.com/threshold-network/token-dashboard/blob/main/src/threshold-ts/tbtc/index.ts#L1041C1-L1093C1
    const events: EthersEvent[] = await this.getEvents(
      "RedemptionRequested",
      options,
      ...filterArgs
    )

    return events.map<RedemptionRequestedEvent>((event) => {
      const prefixedRedeemerOutputScript = Hex.from(
        event.args!.redeemerOutputScript
      )
      const redeemerOutputScript = prefixedRedeemerOutputScript
        .toString()
        .slice(
          BitcoinCompactSizeUint.read(prefixedRedeemerOutputScript).byteLength *
            2
        )

      return {
        blockNumber: BigNumber.from(event.blockNumber).toNumber(),
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        walletPublicKeyHash: Hex.from(event.args!.walletPubKeyHash),
        redeemer: EthereumAddress.from(event.args!.redeemer),
        redeemerOutputScript: Hex.from(redeemerOutputScript),
        requestedAmount: BigNumber.from(event.args!.requestedAmount),
        treasuryFee: BigNumber.from(event.args!.treasuryFee),
        txMaxFee: BigNumber.from(event.args!.txMaxFee),
      }
    })
  }
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
 */
export function packRevealDepositParameters(
  depositTx: BitcoinRawTxVectors,
  depositOutputIndex: number,
  deposit: DepositReceipt,
  vault?: ChainIdentifier
) {
  const fundingTx = {
    version: depositTx.version.toPrefixedString(),
    inputVector: depositTx.inputs.toPrefixedString(),
    outputVector: depositTx.outputs.toPrefixedString(),
    locktime: depositTx.locktime.toPrefixedString(),
  }

  const reveal = {
    fundingOutputIndex: depositOutputIndex,
    blindingFactor: deposit.blindingFactor.toPrefixedString(),
    walletPubKeyHash: deposit.walletPublicKeyHash.toPrefixedString(),
    refundPubKeyHash: deposit.refundPublicKeyHash.toPrefixedString(),
    refundLocktime: deposit.refundLocktime.toPrefixedString(),
    vault: vault ? `0x${vault.identifierHex}` : constants.AddressZero,
  }

  const extraData: string | undefined = deposit.extraData?.toPrefixedString()

  return {
    fundingTx,
    reveal,
    extraData,
  }
}
