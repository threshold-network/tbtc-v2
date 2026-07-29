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
  TaprootDepositRevealedEvent,
  Chains,
  ActiveWalletIdentity,
} from "../contracts"
import { WalletIDUtils } from "../contracts/wallet-id"
import { Event as EthersEvent } from "@ethersproject/contracts"
import {
  BigNumber,
  constants,
  Contract,
  ContractTransaction,
  providers,
  utils,
} from "ethers"
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
  EthersEventUtils,
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

const TaprootDepositRevealABI = [
  "event TaprootDepositRevealed(bytes32 fundingTxHash, uint32 fundingOutputIndex, address indexed depositor, uint64 amount, bytes8 blindingFactor, bytes20 indexed walletPubKeyHash, bytes32 walletXOnlyPublicKey, bytes20 refundPubKeyHash, bytes32 refundXOnlyPublicKey, bytes4 refundLocktime, address vault)",
  "function revealTaprootDeposit((bytes4 version, bytes inputVector, bytes outputVector, bytes4 locktime) fundingTx, (uint32 fundingOutputIndex, bytes8 blindingFactor, bytes20 walletPubKeyHash, bytes32 walletXOnlyPublicKey, bytes20 refundPubKeyHash, bytes32 refundXOnlyPublicKey, bytes4 refundLocktime, address vault) reveal)",
  "function revealTaprootDepositWithExtraData((bytes4 version, bytes inputVector, bytes outputVector, bytes4 locktime) fundingTx, (uint32 fundingOutputIndex, bytes8 blindingFactor, bytes20 walletPubKeyHash, bytes32 walletXOnlyPublicKey, bytes20 refundPubKeyHash, bytes32 refundXOnlyPublicKey, bytes4 refundLocktime, address vault) reveal, bytes32 extraData)",
]

const BridgeV2CompatibilityABI = [
  ...TaprootDepositRevealABI,
  "event NewWalletRegisteredV2(bytes32 indexed walletID, bytes32 indexed ecdsaWalletID, bytes20 indexed walletPubKeyHash)",
  "function activeWalletPubKeyHash() view returns (bytes20)",
  "function activeWalletID() view returns (bytes32)",
  "function taprootDepositOutputKeyCommitment(uint256 depositKey) view returns (bytes32)",
  "function walletID(bytes20 walletPubKeyHash) view returns (bytes32)",
  "function walletPubKeyHashForWalletID(bytes32 walletID) view returns (bytes20)",
]

/**
 * Independently operated provider used to verify the primary provider's active
 * wallet identity. Trust-domain IDs must describe real operational failure
 * domains, not merely different URLs backed by the same provider organization.
 */
export interface EthereumCanonicalActiveWalletIdentityProvider {
  readonly trustDomainID: string
  readonly provider: providers.Provider
}

/**
 * Two-provider quorum required before Ethereum state can select Bitcoin
 * deposit custody. Both providers must support Ethereum's `finalized` block
 * tag and the upgraded Bridge wallet-identity selectors.
 */
export interface EthereumActiveWalletIdentityQuorum {
  readonly sourceTrustDomainID: string
  readonly canonicalProvider: EthereumCanonicalActiveWalletIdentityProvider
}

/** Ethereum Bridge configuration. */
export interface EthereumBridgeConfig extends EthersContractConfig {
  /**
   * Independent finalized-state verifier for deposit wallet identities.
   * Ordinary read APIs remain available without this option, but deposit
   * creation fails closed.
   */
  readonly activeWalletIdentityQuorum?: EthereumActiveWalletIdentityQuorum
}

/**
 * Implementation of the Ethereum Bridge handle.
 * @see {Bridge} for reference.
 */
export class EthereumBridge
  extends EthersContractHandle<BridgeTypechain>
  implements Bridge
{
  private readonly activeWalletIdentityQuorum?: EthereumActiveWalletIdentityQuorum

  private static normalizeTrustDomainID(value: string, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${label} must be non-empty`)
    }

    return value.trim().toLowerCase()
  }

  private static ensureBridgeV2CompatibilityFallback(
    error: unknown,
    methodName: string
  ) {
    if (!EthereumBridge.isMissingBridgeV2CompatibilityMethodError(error)) {
      throw error
    }

    console.debug(
      `Bridge ${methodName} compatibility call unavailable; ` +
        `falling back to legacy behavior: ${error}`
    )
  }

  private static isMissingBridgeV2CompatibilityMethodError(
    error: unknown
  ): boolean {
    const candidate = error as {
      code?: string
      data?: unknown
      reason?: string
      message?: string
      error?: { data?: unknown; message?: string }
    }

    if (candidate?.code !== "CALL_EXCEPTION") {
      return false
    }

    const data = candidate.data ?? candidate.error?.data
    const message = `${candidate.message ?? ""} ${
      candidate.error?.message ?? ""
    }`.toLowerCase()

    // These compatibility methods are lookup-only Bridge V2 views. An empty
    // CALL_EXCEPTION indicates the checked-out ABI is newer than the deployed
    // bytecode; the methods are not expected to intentionally revert empty.
    return (
      data === "0x" ||
      (typeof data === "undefined" &&
        (message.includes("missing revert data") ||
          message.includes("call revert exception")))
    )
  }

  private static walletRegistrationFilterArgs(filterArgs: Array<unknown>): {
    legacyFilterArgs: Array<unknown>
    v2FilterArgs: Array<unknown>
    skipLegacy: boolean
  } {
    if (filterArgs.length === 0) {
      return {
        legacyFilterArgs: [],
        v2FilterArgs: [],
        skipLegacy: false,
      }
    }

    if (filterArgs.length <= 2) {
      return {
        legacyFilterArgs: filterArgs,
        v2FilterArgs: [undefined, ...filterArgs],
        skipLegacy: false,
      }
    }

    // 3-argument V2 form: [walletID, ecdsaWalletID, walletPubKeyHash]. The legacy
    // NewWalletRegistered event has no walletID topic, so a walletID filter cannot
    // be expressed against it. When a walletID is provided, skip the legacy query
    // entirely -- dropping the walletID (slice(1)) would otherwise match every
    // legacy wallet and pollute the result with unrelated ECDSA registrations.
    // A walletID match is fully served by the V2 query: FROST wallets are V2-only,
    // ECDSA-V2 wallets emit a V2 event too, and pre-upgrade ECDSA wallets have no
    // walletID to match. Treat null and undefined alike -- ethers uses both as a
    // topic wildcard, so neither expresses a walletID constraint.
    return {
      legacyFilterArgs: filterArgs.slice(1),
      v2FilterArgs: filterArgs,
      skipLegacy: filterArgs[0] !== undefined && filterArgs[0] !== null,
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
        WalletIDUtils.legacyWalletIDFromPublicKeyHash(walletPublicKeyHash),
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
    config: EthereumBridgeConfig,
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

    if (config.activeWalletIdentityQuorum) {
      const sourceTrustDomainID = EthereumBridge.normalizeTrustDomainID(
        config.activeWalletIdentityQuorum.sourceTrustDomainID,
        "Active wallet identity source trust-domain ID"
      )
      const canonicalTrustDomainID = EthereumBridge.normalizeTrustDomainID(
        config.activeWalletIdentityQuorum.canonicalProvider.trustDomainID,
        "Active wallet identity canonical provider trust-domain ID"
      )

      if (sourceTrustDomainID === canonicalTrustDomainID) {
        throw new Error(
          "Active wallet identity providers must use different trust domains"
        )
      }

      const canonicalProvider =
        config.activeWalletIdentityQuorum.canonicalProvider.provider
      if (
        canonicalProvider === undefined ||
        typeof canonicalProvider.getNetwork !== "function" ||
        typeof canonicalProvider.getBlock !== "function" ||
        typeof canonicalProvider.call !== "function"
      ) {
        throw new Error(
          "Active wallet identity canonical provider must be an Ethers provider"
        )
      }

      if (canonicalProvider === this._instance.provider) {
        throw new Error(
          "Active wallet identity providers must use different provider instances"
        )
      }

      this.activeWalletIdentityQuorum = {
        sourceTrustDomainID,
        canonicalProvider: {
          trustDomainID: canonicalTrustDomainID,
          provider: canonicalProvider,
        },
      }
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return EthereumAddress.from(this._instance.address)
  }

  private taprootDepositRevealContract(): Contract {
    return this.bridgeV2CompatibilityContract()
  }

  private bridgeV2CompatibilityContract(
    provider?: providers.Provider
  ): Contract {
    return new Contract(
      this._instance.address,
      BridgeV2CompatibilityABI,
      provider ?? this._instance.signer ?? this._instance.provider
    )
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
   * @see {Bridge#getTaprootDepositRevealedEvents}
   */
  async getTaprootDepositRevealedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<TaprootDepositRevealedEvent[]> {
    const bridge = this.taprootDepositRevealContract()
    const taprootDepositRevealedFilter =
      bridge.filters["TaprootDepositRevealed"]
    const events: EthersEvent[] = await backoffRetrier<EthersEvent[]>(
      options?.retries ?? this._totalRetryAttempts
    )(async () => {
      return await EthersEventUtils.getEvents(
        bridge,
        taprootDepositRevealedFilter(...filterArgs),
        options?.fromBlock ?? this._deployedAtBlockNumber,
        options?.toBlock,
        options?.batchedQueryBlockInterval,
        options?.logger
      )
    })

    return events.map<TaprootDepositRevealedEvent>((event) => {
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
        walletXOnlyPublicKey: Hex.from(event.args!.walletXOnlyPublicKey),
        refundPublicKeyHash: Hex.from(event.args!.refundPubKeyHash),
        refundXOnlyPublicKey: Hex.from(event.args!.refundXOnlyPublicKey),
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
    const walletPublicKeyHash =
      BitcoinPublicKeyUtils.walletKeyToPublicKeyHash(walletPublicKey)
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
      BitcoinPublicKeyUtils.walletKeyToPublicKeyHash(walletPublicKey),
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
        if (isTaprootDepositReceipt(deposit)) {
          const bridge = this.taprootDepositRevealContract() as unknown as {
            revealTaprootDepositWithExtraData: (
              taprootFundingTx: typeof fundingTx,
              taprootReveal: typeof reveal,
              extraData: string
            ) => Promise<ContractTransaction>
            revealTaprootDeposit: (
              taprootFundingTx: typeof fundingTx,
              taprootReveal: typeof reveal
            ) => Promise<ContractTransaction>
          }

          if (typeof extraData !== "undefined") {
            return await bridge.revealTaprootDepositWithExtraData(
              fundingTx,
              reveal,
              extraData
            )
          }

          return await bridge.revealTaprootDeposit(fundingTx, reveal)
        }

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
      BitcoinPublicKeyUtils.walletKeyToPublicKeyHash(
        walletPublicKey
      ).toPrefixedString()

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
      BitcoinPublicKeyUtils.walletKeyToPublicKeyHash(
        walletPublicKey
      ).toPrefixedString()

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

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#taprootDepositOutputKeyCommitment}
   */
  async taprootDepositOutputKeyCommitment(
    depositTxHash: BitcoinTxHash,
    depositOutputIndex: number
  ): Promise<Hex> {
    const depositKey = EthereumBridge.buildDepositKey(
      depositTxHash,
      depositOutputIndex
    )
    const bridge = this.bridgeV2CompatibilityContract() as unknown as {
      taprootDepositOutputKeyCommitment: (depositKey: string) => Promise<string>
    }
    const commitment = await backoffRetrier<string>(this._totalRetryAttempts)(
      async () => {
        return await bridge.taprootDepositOutputKeyCommitment(depositKey)
      }
    )

    return Hex.from(commitment)
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
      ...(deposit.extraData === constants.HashZero
        ? {}
        : { extraData: Hex.from(deposit.extraData) }),
    }
  }

  private async getFinalizedBlock(
    provider: providers.Provider,
    label: string
  ): Promise<{ number: number; hash: string }> {
    const rpcProvider = provider as providers.Provider & {
      send?: (method: string, params: unknown[]) => Promise<unknown>
    }

    if (typeof rpcProvider.send !== "function") {
      throw new Error(`${label} must support the Ethereum finalized block tag`)
    }

    const rawBlock = (await backoffRetrier<unknown>(this._totalRetryAttempts)(
      async () =>
        rpcProvider.send!("eth_getBlockByNumber", ["finalized", false])
    )) as { number?: unknown; hash?: unknown } | null

    if (
      rawBlock === null ||
      typeof rawBlock !== "object" ||
      typeof rawBlock.number !== "string" ||
      typeof rawBlock.hash !== "string" ||
      !utils.isHexString(rawBlock.hash, 32)
    ) {
      throw new Error(`${label} did not return a finalized block`)
    }

    let number: number
    try {
      number = BigNumber.from(rawBlock.number).toNumber()
    } catch (_) {
      throw new Error(`${label} returned an invalid finalized block number`)
    }

    if (!Number.isSafeInteger(number) || number < 0) {
      throw new Error(`${label} returned an invalid finalized block number`)
    }

    return { number, hash: rawBlock.hash.toLowerCase() }
  }

  private async authenticateFinalizedBlock(
    provider: providers.Provider,
    finalizedBlock: { number: number; hash: string },
    label: string
  ): Promise<void> {
    const block = await backoffRetrier<providers.Block>(
      this._totalRetryAttempts
    )(async () => provider.getBlock(finalizedBlock.number))

    if (
      !block ||
      block.number !== finalizedBlock.number ||
      !utils.isHexString(block.hash, 32) ||
      block.hash.toLowerCase() !== finalizedBlock.hash
    ) {
      throw new Error(`${label} did not authenticate its finalized block`)
    }
  }

  private async readActiveWalletIdentityAt(
    provider: providers.Provider,
    blockNumber: number,
    label: string
  ): Promise<ActiveWalletIdentity | undefined> {
    const bridge = this.bridgeV2CompatibilityContract(provider) as unknown as {
      activeWalletPubKeyHash: (overrides: {
        blockTag: number
      }) => Promise<string>
      activeWalletID: (overrides: { blockTag: number }) => Promise<string>
      walletID: (
        walletPublicKeyHash: string,
        overrides: { blockTag: number }
      ) => Promise<string>
      walletPubKeyHashForWalletID: (
        walletID: string,
        overrides: { blockTag: number }
      ) => Promise<string>
    }

    let walletPublicKeyHashRaw: string
    let walletIDRaw: string
    try {
      ;[walletPublicKeyHashRaw, walletIDRaw] = await Promise.all([
        bridge.activeWalletPubKeyHash({ blockTag: blockNumber }),
        bridge.activeWalletID({ blockTag: blockNumber }),
      ])
    } catch (_) {
      throw new Error(
        `${label} could not prove upgraded Bridge wallet-identity selectors`
      )
    }

    const noWalletPublicKeyHash =
      walletPublicKeyHashRaw === "0x0000000000000000000000000000000000000000"
    const noWalletID = walletIDRaw === constants.HashZero
    if (noWalletPublicKeyHash || noWalletID) {
      if (noWalletPublicKeyHash && noWalletID) {
        return undefined
      }

      throw new Error("Active wallet identity is not canonically bound")
    }

    const walletPublicKeyHash = Hex.from(walletPublicKeyHashRaw)
    const walletID = Hex.from(walletIDRaw)
    if (
      walletPublicKeyHash.toBuffer().length !== 20 ||
      walletID.toBuffer().length !== 32
    ) {
      throw new Error("Active wallet identity is not canonically bound")
    }

    let mappedWalletID: Hex
    let reverseWalletPublicKeyHash: Hex
    try {
      ;[mappedWalletID, reverseWalletPublicKeyHash] = await Promise.all([
        bridge
          .walletID(walletPublicKeyHash.toPrefixedString(), {
            blockTag: blockNumber,
          })
          .then(Hex.from),
        bridge
          .walletPubKeyHashForWalletID(walletID.toPrefixedString(), {
            blockTag: blockNumber,
          })
          .then(Hex.from),
      ])
    } catch (_) {
      throw new Error(
        `${label} could not prove upgraded Bridge wallet-identity selectors`
      )
    }

    if (
      !mappedWalletID.equals(walletID) ||
      !reverseWalletPublicKeyHash.equals(walletPublicKeyHash)
    ) {
      throw new Error("Active wallet identity is not canonically bound")
    }

    if (!WalletIDUtils.isLegacyWalletID(walletID, walletPublicKeyHash)) {
      const derivedWalletPublicKeyHash = BitcoinHashUtils.computeHash160(
        Hex.from(Buffer.concat([Buffer.from([0x02]), walletID.toBuffer()]))
      )
      if (!derivedWalletPublicKeyHash.equals(walletPublicKeyHash)) {
        throw new Error("Active wallet identity is not canonically bound")
      }
    }

    return { walletPublicKeyHash, walletID }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#activeWalletIdentity}
   */
  async activeWalletIdentity(): Promise<ActiveWalletIdentity | undefined> {
    const quorum = this.activeWalletIdentityQuorum
    if (!quorum) {
      throw new Error(
        "Deposit wallet identity requires an independent Ethereum provider"
      )
    }

    const sourceProvider = this._instance.provider
    if (!sourceProvider) {
      throw new Error(
        "Deposit wallet identity requires a primary Ethereum provider"
      )
    }
    const canonicalProvider = quorum.canonicalProvider.provider

    const [sourceNetwork, canonicalNetwork] = await Promise.all([
      sourceProvider.getNetwork(),
      canonicalProvider.getNetwork(),
    ])
    if (sourceNetwork.chainId !== canonicalNetwork.chainId) {
      throw new Error(
        "Active wallet identity providers use different Ethereum chains"
      )
    }

    const [sourceFinalized, canonicalFinalized] = await Promise.all([
      this.getFinalizedBlock(
        sourceProvider,
        "Active wallet identity source provider"
      ),
      this.getFinalizedBlock(
        canonicalProvider,
        "Active wallet identity canonical provider"
      ),
    ])

    await Promise.all([
      this.authenticateFinalizedBlock(
        sourceProvider,
        sourceFinalized,
        "Active wallet identity source provider"
      ),
      this.authenticateFinalizedBlock(
        canonicalProvider,
        canonicalFinalized,
        "Active wallet identity canonical provider"
      ),
    ])

    const [sourceIdentity, canonicalIdentity] = await Promise.all([
      this.readActiveWalletIdentityAt(
        sourceProvider,
        sourceFinalized.number,
        "Active wallet identity source provider"
      ),
      this.readActiveWalletIdentityAt(
        canonicalProvider,
        canonicalFinalized.number,
        "Active wallet identity canonical provider"
      ),
    ])

    if (!sourceIdentity || !canonicalIdentity) {
      if (!sourceIdentity && !canonicalIdentity) {
        return undefined
      }

      throw new Error("Active wallet identity providers disagree")
    }

    if (
      !sourceIdentity.walletPublicKeyHash.equals(
        canonicalIdentity.walletPublicKeyHash
      ) ||
      !sourceIdentity.walletID.equals(canonicalIdentity.walletID)
    ) {
      throw new Error("Active wallet identity providers disagree")
    }

    return sourceIdentity
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

    const { walletPublicKey } = await this.wallets(activeWalletPublicKeyHash)

    return walletPublicKey
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {Bridge#activeWalletID}
   */
  async activeWalletID(): Promise<Hex | undefined> {
    const bridgeV2Contract =
      this.bridgeV2CompatibilityContract() as unknown as {
        activeWalletID: () => Promise<string>
      }
    try {
      const walletID = await bridgeV2Contract.activeWalletID()

      if (walletID === constants.HashZero) {
        return undefined
      }

      return Hex.from(walletID)
    } catch (err) {
      if (EthereumBridge.isMissingBridgeV2CompatibilityMethodError(err)) {
        throw new Error("Bridge does not expose a canonical active wallet ID")
      }

      throw err
    }
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
    const { legacyFilterArgs, v2FilterArgs, skipLegacy } =
      EthereumBridge.walletRegistrationFilterArgs(filterArgs)
    // skipLegacy: the caller filtered by a V2-only walletID, which the legacy
    // NewWalletRegistered event cannot express; querying it would return every
    // legacy wallet.
    const legacyEvents: EthersEvent[] = skipLegacy
      ? []
      : await this.getEvents(
          "NewWalletRegistered",
          options,
          ...legacyFilterArgs
        )
    // NewWalletRegisteredV2 (emitted for both ECDSA-V2 and FROST wallet
    // registration) is absent from the bundled mainnet/sepolia Bridge artifacts,
    // so it must be queried through the compatibility ABI. Querying it via the
    // deployed-artifact instance throws on the missing event filter and would
    // silently drop every FROST wallet, breaking redemption wallet selection
    // after the FROST upgrade. On pre-upgrade deployments the log query simply
    // returns empty.
    const v2Bridge = this.bridgeV2CompatibilityContract()
    const newWalletRegisteredV2Filter =
      v2Bridge.filters["NewWalletRegisteredV2"]
    const v2Events: EthersEvent[] = await backoffRetrier<EthersEvent[]>(
      options?.retries ?? this._totalRetryAttempts
    )(async () => {
      return await EthersEventUtils.getEvents(
        v2Bridge,
        newWalletRegisteredV2Filter(...v2FilterArgs),
        options?.fromBlock ?? this._deployedAtBlockNumber,
        options?.toBlock,
        options?.batchedQueryBlockInterval,
        options?.logger
      )
    })

    const orderedEvents = [
      ...legacyEvents.map((event) => ({
        event,
        parsed: EthereumBridge.parseLegacyNewWalletRegisteredEvent(event),
      })),
      ...v2Events.map((event) => ({
        event,
        parsed: EthereumBridge.parseV2NewWalletRegisteredEvent(event),
      })),
    ].sort((left, right) =>
      EthereumBridge.compareEventsByChainOrder(left.event, right.event)
    )

    // An ECDSA wallet registered after the V2 upgrade emits BOTH
    // NewWalletRegistered and NewWalletRegisteredV2 in the same transaction
    // (Wallets.registerNewWallet), so the legacy and V2 queries each return one
    // (identical) record for it. De-duplicate by transaction + wallet public-key
    // hash so each wallet is reported once. FROST wallets (V2 only) and
    // pre-upgrade ECDSA wallets (legacy only) have no duplicate and are unaffected.
    const seenWallets = new Set<string>()
    const dedupedEvents: NewWalletRegisteredEvent[] = []
    for (const { parsed } of orderedEvents) {
      const key = `${parsed.transactionHash.toString()}:${parsed.walletPublicKeyHash.toString()}`
      if (seenWallets.has(key)) {
        continue
      }
      seenWallets.add(key)
      dedupedEvents.push(parsed)
    }

    return dedupedEvents
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

    return this.parseWalletDetails(wallet, walletID, walletPublicKeyHash)
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
      let wallet: WalletsTypechain.WalletStructOutput | undefined
      try {
        wallet = await backoffRetrier<WalletsTypechain.WalletStructOutput>(
          this._totalRetryAttempts
        )(async () => {
          return await bridgeContract.walletsByWalletID!(
            walletID.toPrefixedString()
          )
        })
      } catch (err) {
        // The bundled artifact ABI may expose this selector while the deployed
        // (pre-upgrade) bytecode does not; fall through to the public-key-hash
        // lookup path below rather than throwing.
        EthereumBridge.ensureBridgeV2CompatibilityFallback(
          err,
          "walletsByWalletID"
        )
      }

      if (wallet) {
        return this.parseWalletDetails(wallet, walletID)
      }
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
      try {
        const walletID = await backoffRetrier<string>(this._totalRetryAttempts)(
          async () => {
            return await bridgeContract.walletID!(
              walletPublicKeyHash.toPrefixedString()
            )
          }
        )

        return Hex.from(walletID)
      } catch (err) {
        // The bundled artifact ABI may expose this selector while the deployed
        // (pre-upgrade) bytecode does not; fall through to the compatibility
        // contract and legacy alias below rather than throwing.
        EthereumBridge.ensureBridgeV2CompatibilityFallback(err, "walletID")
      }
    }

    const bridgeV2Contract =
      this.bridgeV2CompatibilityContract() as unknown as {
        walletID: (walletPubKeyHash: string) => Promise<string>
      }
    try {
      const walletID = await backoffRetrier<string>(this._totalRetryAttempts)(
        async () =>
          bridgeV2Contract.walletID(walletPublicKeyHash.toPrefixedString())
      )

      return Hex.from(walletID)
    } catch (err) {
      EthereumBridge.ensureBridgeV2CompatibilityFallback(err, "walletID")
      // Fall back to the legacy alias below for pre-upgrade Bridge contracts
      // whose ABI and bytecode do not expose canonical wallet IDs.
    }

    return WalletIDUtils.legacyWalletIDFromPublicKeyHash(walletPublicKeyHash)
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
      try {
        const walletPublicKeyHash = await backoffRetrier<string>(
          this._totalRetryAttempts
        )(async () => {
          return await bridgeContract.walletPubKeyHashForWalletID!(
            walletID.toPrefixedString()
          )
        })

        return Hex.from(walletPublicKeyHash)
      } catch (err) {
        // The bundled artifact ABI may expose this selector while the deployed
        // (pre-upgrade) bytecode does not; fall through to the compatibility
        // contract and legacy-shape guard below rather than throwing.
        EthereumBridge.ensureBridgeV2CompatibilityFallback(
          err,
          "walletPubKeyHashForWalletID"
        )
      }
    }

    const bridgeV2Contract =
      this.bridgeV2CompatibilityContract() as unknown as {
        walletPubKeyHashForWalletID: (walletID: string) => Promise<string>
      }
    try {
      const walletPublicKeyHash = await backoffRetrier<string>(
        this._totalRetryAttempts
      )(async () =>
        bridgeV2Contract.walletPubKeyHashForWalletID(
          walletID.toPrefixedString()
        )
      )

      return Hex.from(walletPublicKeyHash)
    } catch (err) {
      EthereumBridge.ensureBridgeV2CompatibilityFallback(
        err,
        "walletPubKeyHashForWalletID"
      )
      // Fall through to the strict legacy-shape guard below for pre-upgrade
      // Bridge contracts whose ABI and bytecode do not expose canonical wallet
      // ID resolution.
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
   * Resolves a wallet's compressed public key. ECDSA wallets expose it via the
   * ECDSA wallet registry; FROST wallets (zero `ecdsaWalletID`) carry their
   * Taproot x-only key as the native `walletID`, which is synthesized into a
   * compressed compatibility key (the same way redemption wallet selection does)
   * so legacy callers such as `activeWalletPublicKey()` still get a key after
   * FROST activation.
   * @param ecdsaWalletID The wallet's ECDSA wallet ID (zero for FROST wallets).
   * @param walletID The wallet's native wallet ID, if known.
   * @param walletPublicKeyHash The wallet public key hash, when available; it
   *        enables the exact legacy-alias guard in the FROST synthesis.
   * @returns The compressed wallet public key, or undefined when unavailable.
   */
  private async resolveWalletPublicKey(
    ecdsaWalletID: Hex,
    walletID?: Hex,
    walletPublicKeyHash?: Hex
  ): Promise<Hex | undefined> {
    const frostWalletID = WalletIDUtils.frostWalletID(
      ecdsaWalletID,
      walletID,
      walletPublicKeyHash
    )
    if (frostWalletID) {
      return BitcoinPublicKeyUtils.xOnlyToCompressedPublicKey(frostWalletID)
    }

    // A zero ecdsaWalletID is a FROST wallet; the ECDSA registry has no entry
    // for it, so avoid a doomed lookup when its x-only walletID is unavailable.
    if (ecdsaWalletID.equals(Hex.from(constants.HashZero))) {
      return undefined
    }

    return this.getWalletCompressedPublicKey(ecdsaWalletID)
  }

  /**
   * Parses a wallet data using data fetched from the on-chain contract.
   * @param wallet Data of the wallet.
   * @param walletID Optional canonical wallet identifier. When provided,
   *        the legacy `walletPublicKeyHash` field is overridden with the
   *        canonical mapping lookup derived from this ID.
   * @param walletPublicKeyHash Optional wallet public key hash, threaded through
   *        for the FROST public-key synthesis legacy-alias guard.
   * @returns Parsed wallet data.
   */
  private async parseWalletDetails(
    wallet: WalletsTypechain.WalletStructOutput,
    walletID?: Hex,
    walletPublicKeyHash?: Hex
  ): Promise<Wallet> {
    const ecdsaWalletID = Hex.from(wallet.ecdsaWalletID)

    return {
      walletID,
      ecdsaWalletID,
      walletPublicKey: await this.resolveWalletPublicKey(
        ecdsaWalletID,
        walletID,
        walletPublicKeyHash
      ),
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
    ...(isTaprootDepositReceipt(deposit)
      ? {
          walletXOnlyPublicKey: deposit.walletXOnlyPublicKey.toPrefixedString(),
        }
      : {}),
    refundPubKeyHash: deposit.refundPublicKeyHash.toPrefixedString(),
    ...(isTaprootDepositReceipt(deposit)
      ? {
          refundXOnlyPublicKey: deposit.refundXOnlyPublicKey.toPrefixedString(),
        }
      : {}),
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

function isTaprootDepositReceipt(
  deposit: DepositReceipt
): deposit is DepositReceipt & {
  walletXOnlyPublicKey: Hex
  refundXOnlyPublicKey: Hex
} {
  return (
    typeof deposit.walletXOnlyPublicKey !== "undefined" &&
    typeof deposit.refundXOnlyPublicKey !== "undefined"
  )
}
