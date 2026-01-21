import { BigNumber } from "@ethersproject/bignumber"
import {
  BitcoinSpvProof,
  BitcoinUtxo,
  BitcoinRawTxVectors,
  BitcoinTxHash,
} from "../bitcoin"
import { Hex } from "../utils"
import { ChainEvent, GetChainEvents } from "./chain-event"
import { ChainIdentifier } from "./chain-identifier"
import { WalletRegistry } from "./wallet-registry"

/**
 * Interface for communication with the Bridge on-chain contract.
 */
export interface Bridge {
  /**
   * Gets the chain-specific identifier of this contract.
   */
  getChainIdentifier(): ChainIdentifier

  /**
   * Get emitted DepositRevealed events.
   * @see GetEventsFunction
   */
  getDepositRevealedEvents: GetChainEvents.Function<DepositRevealedEvent>

  /**
   * Submits a deposit sweep transaction proof to the on-chain contract.
   * @param sweepTx - Sweep transaction data.
   * @param sweepProof - Sweep proof data.
   * @param mainUtxo - Data of the wallet's main UTXO.
   * @param vault - Optional identifier of the vault the swept deposits should
   *        be routed in.
   * @returns Transaction hash of the submit deposit sweep proof transaction.
   */
  submitDepositSweepProof(
    sweepTx: BitcoinRawTxVectors,
    sweepProof: BitcoinSpvProof,
    mainUtxo: BitcoinUtxo,
    vault?: ChainIdentifier
  ): Promise<Hex>

  /**
   * Reveals a given deposit to the on-chain contract.
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
  ): Promise<Hex>

  /**
   * Gets a revealed deposit from the on-chain contract.
   * @param depositTxHash The revealed deposit transaction's hash.
   * @param depositOutputIndex Index of the deposit transaction output that
   *        funds the revealed deposit.
   * @returns Revealed deposit data.
   */
  deposits(
    depositTxHash: BitcoinTxHash,
    depositOutputIndex: number
  ): Promise<DepositRequest>

  /**
   * Requests a redemption from the on-chain contract.
   * @param walletPublicKey - The Bitcoin public key of the wallet. Must be in the
   *        compressed form (33 bytes long with 02 or 03 prefix).
   * @param mainUtxo - The main UTXO of the wallet. Must match the main UTXO
   *        held by the on-chain contract.
   * @param redeemerOutputScript - The output script that the redeemed funds will
   *        be locked to. Must not be prepended with length.
   * @param amount - The amount to be redeemed in satoshis.
   * @returns Transaction hash of the request redemption transaction.
   */
  requestRedemption(
    walletPublicKey: Hex,
    mainUtxo: BitcoinUtxo,
    redeemerOutputScript: Hex,
    amount: BigNumber
  ): Promise<Hex>

  /**
   * Submits a redemption transaction proof to the on-chain contract.
   * @param redemptionTx - Redemption transaction data
   * @param redemptionProof - Redemption proof data
   * @param mainUtxo - Data of the wallet's main UTXO
   * @param walletPublicKey - Bitcoin public key of the wallet. Must be in the
   *        compressed form (33 bytes long with 02 or 03 prefix).
   * @returns Transaction hash of the submit redemption proof transaction.
   */
  submitRedemptionProof(
    redemptionTx: BitcoinRawTxVectors,
    redemptionProof: BitcoinSpvProof,
    mainUtxo: BitcoinUtxo,
    walletPublicKey: Hex
  ): Promise<Hex>

  /**
   * Gets transaction proof difficulty factor from the on-chain contract.
   * @dev This number signifies how many confirmations a transaction has to
   *      accumulate before it can be proven on-chain.
   * @returns Proof difficulty factor.
   */
  txProofDifficultyFactor(): Promise<number>

  /**
   * Gets a pending redemption from the on-chain contract.
   * @param walletPublicKey Bitcoin public key of the wallet the request is
   *        targeted to. Must be in the compressed form (33 bytes long with 02
   *        or 03 prefix).
   * @param redeemerOutputScript The redeemer output script the redeemed funds
   *        are supposed to be locked on. Must not be prepended with length.
   * @returns Promise with the pending redemption.
   */
  pendingRedemptions(
    walletPublicKey: Hex,
    redeemerOutputScript: Hex
  ): Promise<RedemptionRequest>

  /**
   * Gets a pending redemption from the on-chain contract using the wallet's
   * public key hash instead of the plain-text public key.
   * @param walletPublicKeyHash Bitcoin public key hash of the wallet the
   *        request is targeted to. Must be 20 bytes long.
   * @param redeemerOutputScript The redeemer output script the redeemed funds
   *        are supposed to be locked on. Must not be prepended with length.
   * @returns Promise with the pending redemption.
   */
  pendingRedemptionsByWalletPKH(
    walletPublicKeyHash: Hex,
    redeemerOutputScript: Hex
  ): Promise<RedemptionRequest>

  /**
   * Gets a timed-out redemption from the on-chain contract.
   * @param walletPublicKey Bitcoin public key of the wallet the request is
   *        targeted to. Must be in the compressed form (33 bytes long with 02
   *        or 03 prefix).
   * @param redeemerOutputScript The redeemer output script the redeemed funds
   *        are supposed to be locked on. Must not be prepended with length.
   * @returns Promise with the pending redemption.
   */
  timedOutRedemptions(
    walletPublicKey: Hex,
    redeemerOutputScript: Hex
  ): Promise<RedemptionRequest>

  /**
   * Gets the public key of the current active wallet.
   * @returns Compressed (33 bytes long with 02 or 03 prefix) active wallet's
   *          public key. If there is no active wallet at the moment, undefined
   *          is returned.
   */
  activeWalletPublicKey(): Promise<Hex | undefined>

  /**
   * Get emitted NewWalletRegisteredEvent events.
   * @see GetEventsFunction
   */
  getNewWalletRegisteredEvents: GetChainEvents.Function<NewWalletRegisteredEvent>

  /**
   * Returns the attached WalletRegistry instance.
   */
  walletRegistry(): Promise<WalletRegistry>

  /**
   * Gets details about a registered wallet.
   * @param walletPublicKeyHash The 20-byte wallet public key hash (computed
   * using Bitcoin HASH160 over the compressed ECDSA public key).
   * @returns Promise with the wallet details.
   */
  wallets(walletPublicKeyHash: Hex): Promise<Wallet>

  /**
   * Builds the UTXO hash based on the UTXO components.
   * @param utxo UTXO components.
   * @returns The hash of the UTXO.
   */
  buildUtxoHash(utxo: BitcoinUtxo): Hex

  /**
   * Get emitted RedemptionRequested events.
   * @see GetEventsFunction
   */
  getRedemptionRequestedEvents: GetChainEvents.Function<RedemptionRequestedEvent>
}

/**
 * Represents a deposit receipt. The receipt holds all information required
 * to build a unique deposit address on Bitcoin chain.
 */
export interface DepositReceipt {
  /**
   * Depositor's chain identifier.
   */
  depositor: ChainIdentifier

  /**
   * An 8-byte blinding factor. Must be unique for the given depositor, wallet
   * public key and refund public key.
   */
  blindingFactor: Hex

  /**
   * Public key hash of the wallet that is meant to receive the deposit.
   *
   * You can use `computeHash160` function to get the hash from a public key.
   */
  walletPublicKeyHash: Hex

  /**
   * Public key hash that is meant to be used during deposit refund after the
   * locktime passes.
   *
   * You can use `computeHash160` function to get the hash from a public key.
   */
  refundPublicKeyHash: Hex

  /**
   * A 4-byte little-endian refund locktime.
   */
  refundLocktime: Hex

  /**
   * Optional 32-byte extra data.
   */
  extraData?: Hex
}

// eslint-disable-next-line valid-jsdoc
/**
 * Validates the given deposit receipt. Throws in case of a validation error.
 * @param receipt The validated deposit receipt.
 * @dev This function does not validate the depositor's identifier as its
 *      validity is chain-specific. This parameter must be validated outside.
 */
export function validateDepositReceipt(receipt: DepositReceipt) {
  if (receipt.blindingFactor.toString().length != 16) {
    throw new Error("Blinding factor must be an 8-byte number")
  }
  if (receipt.walletPublicKeyHash.toString().length != 40) {
    throw new Error("Invalid wallet public key hash")
  }

  if (receipt.refundPublicKeyHash.toString().length != 40) {
    throw new Error("Invalid refund public key hash")
  }

  if (receipt.refundLocktime.toString().length != 8) {
    throw new Error("Refund locktime must be a 4-byte number")
  }

  const extraData = receipt.extraData
  if (extraData && extraData.toString().length != 64) {
    throw new Error("Extra data must be a 32-byte number")
  }
}

/**
 * Represents a deposit request revealed to the on-chain bridge.
 */
export interface DepositRequest {
  /**
   * Depositor's chain identifier.
   */
  depositor: ChainIdentifier

  /**
   * Deposit amount in satoshis.
   */
  amount: BigNumber

  /**
   * Optional identifier of the vault the deposit should be routed in.
   */
  vault?: ChainIdentifier

  /**
   * UNIX timestamp the deposit was revealed at.
   */
  revealedAt: number
  /**
   * UNIX timestamp the request was swept at. If not swept yet, this parameter
   * should have zero as value.
   */
  sweptAt: number
  /**
   * Value of the treasury fee calculated for this revealed deposit.
   * Denominated in satoshi.
   */
  treasuryFee: BigNumber
}

/**
 * Represents an event emitted on deposit reveal to the on-chain bridge.
 */
export type DepositRevealedEvent = DepositReceipt &
  Pick<DepositRequest, "amount" | "vault"> & {
    fundingTxHash: BitcoinTxHash
    fundingOutputIndex: number
  } & ChainEvent

/**
 * Represents a redemption request.
 */
export interface RedemptionRequest {
  /**
   * On-chain identifier of the redeemer.
   */
  redeemer: ChainIdentifier

  /**
   * The output script the redeemed Bitcoin funds are locked to. It is not
   * prepended with length.
   */
  redeemerOutputScript: Hex

  /**
   * The amount of Bitcoins in satoshis that is requested to be redeemed.
   * The actual value of the output in the Bitcoin transaction will be decreased
   * by the sum of the fee share and the treasury fee for this particular output.
   */
  requestedAmount: BigNumber

  /**
   * The amount of Bitcoins in satoshis that is subtracted from the amount of
   * the redemption request and used to pay the treasury fee.
   * The value should be exactly equal to the value of treasury fee in the Bridge
   * on-chain contract at the time the redemption request was made.
   */
  treasuryFee: BigNumber

  /**
   * The maximum amount of Bitcoins in satoshis that can be subtracted from the
   * redemption's `requestedAmount` to pay the transaction network fee.
   */
  txMaxFee: BigNumber

  /**
   * UNIX timestamp the request was created at.
   */
  requestedAt: number
}

/**
 * Represents an event emitted on redemption request.
 */
export type RedemptionRequestedEvent = Omit<
  RedemptionRequest,
  "requestedAt"
> & {
  /**
   * Public key hash of the wallet that is meant to handle the redemption.
   */
  walletPublicKeyHash: Hex
} & ChainEvent

/* eslint-disable no-unused-vars */
export enum WalletState {
  /**
   * The wallet is unknown to the Bridge.
   */
  Unknown = 0,
  /**
   * The wallet can sweep deposits and accept redemption requests.
   */
  Live = 1,
  /**
   * The wallet was deemed unhealthy and is expected to move their outstanding
   * funds to another wallet. The wallet can still fulfill their pending redemption
   * requests although new redemption requests and new deposit reveals are not
   * accepted.
   */
  MovingFunds = 2,
  /**
   *  The wallet moved or redeemed all their funds and is in the
   * losing period where it is still a subject of fraud challenges
   * and must defend against them.
   *  */
  Closing = 3,
  /**
   * The wallet finalized the closing period successfully and can no longer perform
   * any action in the Bridge.
   * */
  Closed = 4,
  /**
   * The wallet committed a fraud that was reported, did not move funds to
   * another wallet before a timeout, or did not sweep funds moved to if from
   * another wallet before a timeout. The wallet is blocked and can not perform
   * any actions in the Bridge.
   */
  Terminated = 5,
}
/* eslint-enable no-unused-vars */

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace WalletState {
  export function parse(val: number): WalletState {
    return (
      (<never>WalletState)[
        Object.keys(WalletState)[
          Object.values(WalletState).indexOf(val as WalletState)
        ]
      ] ?? WalletState.Unknown
    )
  }
}

/**
 * Represents a deposit.
 */
export interface Wallet {
  /**
   * Identifier of a ECDSA Wallet registered in the ECDSA Wallet Registry.
   */
  ecdsaWalletID: Hex
  /**
   * Compressed public key of the ECDSA Wallet. If the wallet is Closed
   * or Terminated, this field is empty as the public key is removed from the
   * WalletRegistry.
   */
  walletPublicKey?: Hex
  /**
   * Latest wallet's main UTXO hash.
   */
  mainUtxoHash: Hex
  /**
   * The total redeemable value of pending redemption requests targeting that wallet.
   */
  pendingRedemptionsValue: BigNumber
  /**
   * UNIX timestamp the wallet was created at.
   */
  createdAt: number
  /**
   * UNIX timestamp indicating the moment the wallet was requested to move their
   * funds.
   */
  movingFundsRequestedAt: number
  /**
   * UNIX timestamp indicating the moment the wallet's closing period started.
   */
  closingStartedAt: number
  /**
   * Total count of pending moved funds sweep requests targeting this wallet.
   */
  pendingMovedFundsSweepRequestsCount: number
  /**
   * Current state of the wallet.
   */
  state: WalletState
  /**
   * Moving funds target wallet commitment submitted by the wallet.
   */
  movingFundsTargetWalletsCommitmentHash: Hex
}

/**
 * Represents an event emitted when new wallet is registered on the on-chain bridge.
 */
export type NewWalletRegisteredEvent = {
  /**
   * Identifier of a ECDSA Wallet registered in the ECDSA Wallet Registry.
   */
  ecdsaWalletID: Hex
  /**
   * 20-byte public key hash of the ECDSA Wallet. It is computed by applying
   * hash160 on the compressed public key of the ECDSA Wallet.
   */
  walletPublicKeyHash: Hex
} & ChainEvent
