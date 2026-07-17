import { encodePacked, keccak256, zeroAddress } from "viem"
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
import { Hex } from "../utils"
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
  asDeployment,
  EthereumContractConfig,
  EvmContractDeployment,
  EvmContractHandle,
} from "./adapter"
import { EthereumAddress } from "./address"
import { EthereumWalletRegistry } from "./wallet-registry"

import MainnetBridgeDeployment from "./artifacts/mainnet/Bridge.json"
import SepoliaBridgeDeployment from "./artifacts/sepolia/Bridge.json"
import LocalBridgeDeployment from "@keep-network/tbtc-v2/artifacts/Bridge.json"

/**
 * Structural type of the on-chain `Redemption.RedemptionRequest` struct as
 * decoded by viem. Numeric fields are typed `number | bigint` because viem
 * decodes uints depending on their ABI width - normalize at the parsing site.
 */
type RedemptionRequestStruct = {
  redeemer: string
  requestedAmount: number | bigint
  treasuryFee: number | bigint
  txMaxFee: number | bigint
  requestedAt: number | bigint
}

/**
 * Structural type of the on-chain `Deposit.DepositRequest` struct as decoded
 * by viem.
 */
type DepositRequestStruct = {
  depositor: string
  amount: number | bigint
  vault: string
  revealedAt: number | bigint
  sweptAt: number | bigint
  treasuryFee: number | bigint
}

/**
 * Structural type of the on-chain `Wallets.Wallet` struct as decoded by viem.
 */
type WalletStruct = {
  ecdsaWalletID: string
  mainUtxoHash: string
  pendingRedemptionsValue: number | bigint
  createdAt: number | bigint
  movingFundsRequestedAt: number | bigint
  closingStartedAt: number | bigint
  pendingMovedFundsSweepRequestsCount: number | bigint
  state: number | bigint
  movingFundsTargetWalletsCommitmentHash: string
}

/**
 * Implementation of the Ethereum Bridge handle.
 * @see {Bridge} for reference.
 */
export class EthereumBridge extends EvmContractHandle implements Bridge {
  constructor(
    config: EthereumContractConfig,
    chainId: Chains.Ethereum = Chains.Ethereum.Local
  ) {
    let deployment: EvmContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Local:
        deployment = asDeployment(LocalBridgeDeployment)
        break
      case Chains.Ethereum.Sepolia:
        deployment = asDeployment(SepoliaBridgeDeployment)
        break
      case Chains.Ethereum.Mainnet:
        deployment = asDeployment(MainnetBridgeDeployment)
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
    return this.getAddress()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#getDepositRevealedEvents}
   */
  async getDepositRevealedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<DepositRevealedEvent[]> {
    const events = await this._getEvents(
      "DepositRevealed",
      options,
      ...filterArgs
    )

    return events.map<DepositRevealedEvent>((event) => {
      return {
        blockNumber: event.blockNumber,
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        fundingTxHash: BitcoinTxHash.from(
          event.args.fundingTxHash as string
        ).reverse(),
        fundingOutputIndex: Number(
          event.args.fundingOutputIndex as number | bigint
        ),
        depositor: EthereumAddress.from(event.args.depositor as string),
        amount: BigInt(event.args.amount as number | bigint),
        blindingFactor: Hex.from(event.args.blindingFactor as string),
        walletPublicKeyHash: Hex.from(event.args.walletPubKeyHash as string),
        refundPublicKeyHash: Hex.from(event.args.refundPubKeyHash as string),
        refundLocktime: Hex.from(event.args.refundLocktime as string),
        vault:
          (event.args.vault as string).toLowerCase() === zeroAddress
            ? undefined
            : EthereumAddress.from(event.args.vault as string),
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

    const request = await this._read<RedemptionRequestStruct>(
      "pendingRedemptions",
      [BigInt(redemptionKey)]
    )

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

    const request = await this._read<RedemptionRequestStruct>(
      "timedOutRedemptions",
      [BigInt(redemptionKey)]
    )

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
    const prefixedRawRedeemerOutputScript: `0x${string}` = `0x${Buffer.concat([
      Buffer.from([rawRedeemerOutputScript.length]),
      rawRedeemerOutputScript,
    ]).toString("hex")}`
    // Build the redemption key by using the 0x-prefixed wallet PKH and
    // prefixed output script.
    return keccak256(
      encodePacked(
        ["bytes32", "bytes20"],
        [
          keccak256(prefixedRawRedeemerOutputScript),
          `0x${walletPublicKeyHash.toString()}` as `0x${string}`,
        ]
      )
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
    request: RedemptionRequestStruct,
    redeemerOutputScript: Hex
  ): RedemptionRequest {
    return {
      redeemer: EthereumAddress.from(request.redeemer),
      redeemerOutputScript: redeemerOutputScript,
      requestedAmount: BigInt(request.requestedAmount),
      treasuryFee: BigInt(request.treasuryFee),
      txMaxFee: BigInt(request.txMaxFee),
      requestedAt: Number(request.requestedAt),
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

    const [functionName, args] =
      typeof extraData !== "undefined"
        ? ["revealDepositWithExtraData", [fundingTx, reveal, extraData]]
        : ["revealDeposit", [fundingTx, reveal]]

    return this._write(functionName as string, args as unknown[], {
      nonRetryableErrors: ["Deposit already revealed"],
    })
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

    const vaultParam = vault ? `0x${vault.identifierHex}` : zeroAddress

    return this._write("submitDepositSweepProof", [
      sweepTxParam,
      sweepProofParam,
      mainUtxoParam,
      vaultParam,
    ])
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#txProofDifficultyFactor}
   */
  async txProofDifficultyFactor(): Promise<number> {
    const txProofDifficultyFactor = await this._read<number | bigint>(
      "txProofDifficultyFactor"
    )

    return Number(txProofDifficultyFactor)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#requestRedemption}
   */
  async requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex,
    amount: bigint
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

    return this._write("requestRedemption", [
      walletPublicKeyHash,
      mainUtxoParam,
      prefixedRawRedeemerOutputScript,
      amount,
    ])
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

    return this._write("submitRedemptionProof", [
      redemptionTxParam,
      redemptionProofParam,
      mainUtxoParam,
      walletPublicKeyHash,
    ])
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

    const deposit = await this._read<DepositRequestStruct>("deposits", [
      BigInt(depositKey),
    ])

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
      .toPrefixedString() as `0x${string}`

    return keccak256(
      encodePacked(
        ["bytes32", "uint32"],
        [prefixedReversedDepositTxHash, depositOutputIndex]
      )
    )
  }

  /**
   * Parses a deposit request using data fetched from the on-chain contract.
   * @param deposit Data of the deposit request.
   * @returns Parsed deposit request.
   */
  private parseDepositRequest(deposit: DepositRequestStruct): DepositRequest {
    return {
      depositor: EthereumAddress.from(deposit.depositor),
      amount: BigInt(deposit.amount),
      vault:
        deposit.vault.toLowerCase() === zeroAddress
          ? undefined
          : EthereumAddress.from(deposit.vault),
      revealedAt: Number(deposit.revealedAt),
      sweptAt: Number(deposit.sweptAt),
      treasuryFee: BigInt(deposit.treasuryFee),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#activeWalletPublicKey}
   */
  async activeWalletPublicKey(): Promise<Hex | undefined> {
    const activeWalletPublicKeyHash = await this._read<string>(
      "activeWalletPubKeyHash"
    )

    if (
      activeWalletPublicKeyHash === "0x0000000000000000000000000000000000000000"
    ) {
      // If there is no active wallet currently, return undefined.
      return undefined
    }

    const { walletPublicKey } = await this.wallets(
      Hex.from(activeWalletPublicKeyHash)
    )

    return walletPublicKey
  }

  private async getWalletCompressedPublicKey(
    ecdsaWalletID: Hex
  ): Promise<Hex | undefined> {
    const walletRegistry = await this.walletRegistry()

    try {
      // Skip retries when the wallet is not registered: this path iterates
      // over closed/terminated wallets during redemption wallet lookup, and
      // retrying a wallet that is gone from the contract state only slows
      // the process down.
      const uncompressedPublicKey = await walletRegistry.getWalletPublicKey(
        ecdsaWalletID,
        true
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
    const events = await this._getEvents(
      "NewWalletRegistered",
      options,
      ...filterArgs
    )

    return events.map<NewWalletRegisteredEvent>((event) => {
      return {
        blockNumber: event.blockNumber,
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        ecdsaWalletID: Hex.from(event.args.ecdsaWalletID as string),
        walletPublicKeyHash: Hex.from(event.args.walletPubKeyHash as string),
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#walletRegistry}
   */
  async walletRegistry(): Promise<WalletRegistry> {
    // `contractReferences` returns multiple outputs
    // (bank, relay, ecdsaWalletRegistry, reimbursementPool) which viem
    // decodes as a positional array.
    const contractReferences = await this._read<readonly string[]>(
      "contractReferences"
    )
    const ecdsaWalletRegistry = contractReferences[2]

    return new EthereumWalletRegistry({
      address: ecdsaWalletRegistry,
      signerOrProvider: await this._connection(),
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#wallets}
   */
  async wallets(walletPublicKeyHash: Hex): Promise<Wallet> {
    const wallet = await this._read<WalletStruct>("wallets", [
      walletPublicKeyHash.toPrefixedString(),
    ])

    return this.parseWalletDetails(wallet)
  }

  /**
   * Parses a wallet data using data fetched from the on-chain contract.
   * @param wallet Data of the wallet.
   * @returns Parsed wallet data.
   */
  private async parseWalletDetails(wallet: WalletStruct): Promise<Wallet> {
    const ecdsaWalletID = Hex.from(wallet.ecdsaWalletID)

    return {
      ecdsaWalletID,
      walletPublicKey: await this.getWalletCompressedPublicKey(ecdsaWalletID),
      mainUtxoHash: Hex.from(wallet.mainUtxoHash),
      pendingRedemptionsValue: BigInt(wallet.pendingRedemptionsValue),
      createdAt: Number(wallet.createdAt),
      movingFundsRequestedAt: Number(wallet.movingFundsRequestedAt),
      closingStartedAt: Number(wallet.closingStartedAt),
      pendingMovedFundsSweepRequestsCount: Number(
        wallet.pendingMovedFundsSweepRequestsCount
      ),
      state: WalletState.parse(Number(wallet.state)),
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
      keccak256(
        encodePacked(
          ["bytes32", "uint32", "uint64"],
          [
            utxo.transactionHash.reverse().toPrefixedString() as `0x${string}`,
            utxo.outputIndex,
            utxo.value,
          ]
        )
      )
    )
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#getRedemptionRequestedEvents}
   */
  async getRedemptionRequestedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<RedemptionRequestedEvent[]> {
    const events = await this._getEvents(
      "RedemptionRequested",
      options,
      ...filterArgs
    )

    return events.map<RedemptionRequestedEvent>((event) => {
      const prefixedRedeemerOutputScript = Hex.from(
        event.args.redeemerOutputScript as string
      )
      const redeemerOutputScript = prefixedRedeemerOutputScript
        .toString()
        .slice(
          BitcoinCompactSizeUint.read(prefixedRedeemerOutputScript).byteLength *
            2
        )

      return {
        blockNumber: event.blockNumber,
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        walletPublicKeyHash: Hex.from(event.args.walletPubKeyHash as string),
        redeemer: EthereumAddress.from(event.args.redeemer as string),
        redeemerOutputScript: Hex.from(redeemerOutputScript),
        requestedAmount: BigInt(event.args.requestedAmount as number | bigint),
        treasuryFee: BigInt(event.args.treasuryFee as number | bigint),
        txMaxFee: BigInt(event.args.txMaxFee as number | bigint),
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
    vault: vault ? `0x${vault.identifierHex}` : zeroAddress,
  }

  const extraData: string | undefined = deposit.extraData?.toPrefixedString()

  return {
    fundingTx,
    reveal,
    extraData,
  }
}
