import { BigNumber } from "@ethersproject/bignumber"
import { BitcoinRawTxVectors, BitcoinSpvProof } from "../bitcoin"
import { ChainIdentifier, GetChainEvents, WalletState } from "."
import { Hex } from "../utils"
import { ChainEvent } from "./chain-event"

/**
 * Settlement state of a reservation action generation, as returned by the
 * on-chain `reservationActions` view.
 */
/* eslint-disable no-unused-vars */
export enum ReservationActionState {
  /**
   * No action was ever requested under this key.
   */
  Unknown = 0,
  /**
   * The action is requested and awaiting its SPV proof.
   */
  Pending = 1,
  /**
   * The action was proven and settled.
   */
  Settled = 2,
  /**
   * The action timed out. A late proof of an already confirmed Bitcoin
   * transaction is still accepted against this record.
   */
  TimedOut = 3,
  /**
   * The action was vetoed by the redemption watchtower.
   */
  Vetoed = 4,
  /**
   * The action's anchor was consumed by a late settlement of an older
   * timed-out generation.
   */
  Superseded = 5,
}

/**
 * Type of a reservation action generation, as returned by the on-chain
 * `reservationActions` view.
 */
export enum ReservationActionType {
  None = 0,
  Acceptance = 1,
  Redemption = 2,
  Reanchor = 3,
  Dissolution = 4,
}

/**
 * State of a reservation position, as returned by the on-chain
 * `reservations` view.
 */
export enum ReservationState {
  /**
   * The reservation is unknown to the Bridge. Acceptance requests are made
   * against positions in this state.
   */
  Unknown = 0,
  /**
   * The reservation was accepted and its anchor outpoint is under wallet
   * custody, with no action in flight.
   */
  Active = 1,
  /**
   * An action has been requested for the position and is not yet settled.
   */
  ActionPending = 2,
  /**
   * The reservation was closed: redeemed in-kind or dissolved.
   */
  Closed = 3,
  /**
   * The custodying wallet was terminated while the anchor was outstanding.
   */
  Stranded = 4,
}
/* eslint-enable no-unused-vars */

/**
 * Values of the on-chain reservation parameters.
 */
export interface ReservationParameters {
  /**
   * Address of the reservation vault. Undefined means reservations
   * are disabled on the chain.
   */
  vault?: ChainIdentifier
  /**
   * Minimum reserved deposit amount in satoshi.
   */
  minAmount: BigNumber
  /**
   * Maximum Bitcoin miner fee in satoshi reserved for the acceptance
   * transaction.
   */
  txMaxFee: BigNumber
  /**
   * Reservation custody term in seconds.
   */
  termSeconds: number
  /**
   * Delay in seconds after the term expires at which the reservation
   * becomes dissolvable.
   */
  dissolutionDelaySeconds: number
  /**
   * Global cap on the total reserved amount in satoshi. Zero means
   * unlimited.
   */
  maxTotalAmount: BigNumber
  /**
   * Current total reserved amount in satoshi.
   */
  totalAmount: BigNumber
  /**
   * Per-wallet cap on the number of reservations. Zero means unlimited.
   */
  maxReservationsPerWallet: number
  /**
   * Timeout in seconds for the reservation actions.
   */
  actionTimeoutSeconds: number
}

/**
 * Values of the on-chain reservation caps.
 */
export interface ReservationCaps {
  /**
   * Per-wallet cap on the total anchored amount in satoshi. Zero means
   * unlimited.
   */
  maxAmountPerWallet: BigNumber
  /**
   * Cap on the amount of a single reservation in satoshi. Zero means
   * unlimited.
   */
  maxSingleAmount: BigNumber
  /**
   * Global cap on the number of active reservations. Zero blocks all
   * acceptances.
   */
  maxActiveReservations: number
  /**
   * Per-target-wallet cap on the number of pending third-party re-anchor
   * holds.
   */
  maxThirdPartyReanchorHoldsPerWallet: number
}

/**
 * Global reservation occupancy as reported by the on-chain view: the
 * current count and its governance cap.
 */
export interface ReservationOccupancy {
  /**
   * Number of active reservations, including capacity reserved by pending
   * acceptance authorizations.
   */
  count: number
  /**
   * Global cap on active reservations.
   */
  maxActive: number
}

/**
 * On-chain record of a reservation position.
 */
export interface ReservationRecord {
  /**
   * The reservation owner holding the in-kind redemption right. Zero on
   * chain before the reservation is accepted, hence undefined in the SDK.
   */
  owner?: ChainIdentifier
  /**
   * Gross amount in satoshi credited to the owner at acceptance time.
   */
  mintedAmount: BigNumber
  /**
   * UNIX timestamp the reservation was accepted at.
   */
  acceptedAt: number
  /**
   * 20-byte public key hash of the wallet custodising the current anchor.
   */
  walletPublicKeyHash: Hex
  /**
   * Value in satoshi of the current anchor outpoint.
   */
  anchorAmount: BigNumber
  /**
   * UNIX timestamp the custody term expires at.
   */
  expiresAt: number
  /**
   * Hash of the Bitcoin transaction holding the current anchor output,
   * in Bitcoin internal byte order.
   */
  anchorTxHash: Hex
  /**
   * Output index of the current anchor output.
   */
  anchorTxOutputIndex: number
  /**
   * Current state of the reservation position.
   */
  state: ReservationState
  /**
   * Monotonic generation counter. Incremented by every action request.
   */
  requestNonce: number
}

/**
 * On-chain record of a single reservation action generation.
 */
export interface ReservationActionRecord {
  /**
   * 20-byte public key hash of the wallet the action's output must pay to.
   */
  targetWalletPublicKeyHash: Hex
  /**
   * UNIX timestamp the action was requested at.
   */
  requestedAt: number
  /**
   * UNIX timestamp after which the action can be reported timed out.
   */
  timeoutAt: number
  /**
   * Snapshotted maximum Bitcoin miner fee for the action transaction.
   */
  txMaxFee: BigNumber
  /**
   * Type of the action.
   */
  actionType: ReservationActionType
  /**
   * Settlement state of the action.
   */
  state: ReservationActionState
  /**
   * Amount in satoshi associated with the generation.
   */
  amount: BigNumber
  /**
   * Snapshotted reservation custody term of the generation, in seconds.
   */
  termSeconds: number
  /**
   * Snapshotted minimum reservation amount of the generation, in satoshi.
   */
  minAmount: BigNumber
}

/**
 * Interface for communication with the on-chain reservation surface of the
 * Bridge. The reservation functions are not declared in the Bridge contract
 * itself: the Bridge's fallback routes every unmatched selector to the
 * reservation router through a delegatecall, so all reservation functions
 * execute at the Bridge address, on the Bridge storage. This interface is
 * implemented by a contract handle bound to the Bridge address with the
 * router ABI.
 */
export interface Reservations {
  /**
   * Requests the acceptance of a revealed reserved deposit: the
   * authorization for the designated wallet to perform the anchor spend.
   * Only the depositor of the deposit may call this.
   *
   * The Bridge checks the SPV proof of the deposit's funding transaction
   * and derives the reservation key from the proven transaction hash and
   * the output index. The funding transaction must therefore be confirmed
   * with the Bridge's required number of confirmations.
   * @param fundingTx Raw vectors of the deposit's funding transaction, the
   *        same data the deposit was revealed with.
   * @param fundingProof SPV proof of the funding transaction.
   * @param fundingOutputIndex Index of the deposit output in the funding
   *        transaction.
   * @param walletPublicKeyHash 20-byte public key hash of the wallet that
   *        will anchor the deposit. Must be the deposit's designated
   *        wallet.
   * @returns Transaction hash of the request acceptance transaction.
   */
  requestReservationAcceptance(
    fundingTx: BitcoinRawTxVectors,
    fundingProof: BitcoinSpvProof,
    fundingOutputIndex: number,
    walletPublicKeyHash: Hex
  ): Promise<Hex>

  /**
   * Releases a reserved deposit that never received an acceptance request
   * back to the pool: the reserved mark is cleared and the deposit is
   * re-routed to the given vault so that ordinary sweeps accept it again.
   * Only the depositor of the deposit may call this.
   * @param depositKey Deposit key of the reserved deposit.
   * @param vault Target vault. Must be the zero address or a trusted
   *        vault other than the reservation vault.
   * @returns Transaction hash of the release transaction.
   */
  releaseReservedDepositToPool(
    depositKey: BigNumber,
    vault: ChainIdentifier
  ): Promise<Hex>

  /**
   * Gets the on-chain record of the given reservation.
   * @param depositKey Deposit key of the reservation.
   * @returns On-chain reservation record.
   */
  reservations(depositKey: BigNumber): Promise<ReservationRecord>

  /**
   * Gets the on-chain record of the given reservation action generation.
   * @param depositKey Deposit key of the reservation.
   * @param requestNonce The action generation.
   * @returns On-chain reservation action record.
   */
  reservationActions(
    depositKey: BigNumber,
    requestNonce: number
  ): Promise<ReservationActionRecord>

  /**
   * Gets the current values of the Bridge reservation parameters.
   * @returns On-chain reservation parameters.
   */
  reservationParameters(): Promise<ReservationParameters>

  /**
   * Gets the current values of the Bridge reservation caps.
   * @returns On-chain reservation caps.
   */
  reservationCaps(): Promise<ReservationCaps>

  /**
   * Gets the number of Live wallets held back from acceptance capacity by
   * the hand-off reserve gate: after every acceptance, this many Live
   * wallets may retire together and all open positions still fit on the
   * remaining Live wallets within the per-wallet count cap. Always at
   * least one.
   * @returns The hand-off reserve in Live wallets.
   */
  reservationHandoffReserveWallets(): Promise<number>

  /**
   * Gets the global reservation occupancy: the count of active
   * reservations and its governance cap.
   * @returns On-chain global reservation occupancy.
   */
  activeReservationsCount(): Promise<ReservationOccupancy>

  /**
   * Gets the total satoshi amount of reservation anchors custodied by the
   * given wallet, including the reserved capacity of pending actions.
   * @param walletPublicKeyHash 20-byte public key hash of the wallet.
   * @returns Total reserved amount of the wallet in satoshi.
   */
  walletReservationsAmount(walletPublicKeyHash: Hex): Promise<BigNumber>

  /**
   * Gets the number of reservations custodied by the given wallet,
   * including reserved capacity of pending actions.
   * @param walletPublicKeyHash 20-byte public key hash of the wallet.
   * @returns Number of reservations custodied by the wallet.
   */
  walletReservationsCount(walletPublicKeyHash: Hex): Promise<number>

  /**
   * Gets the number of revealed reserved deposits that were neither
   * accepted nor marked stale yet.
   * @returns Number of pending reserved deposits.
   */
  pendingReservedDeposits(): Promise<number>

  /**
   * Gets the designated wallet of a pending reserved deposit.
   * @param depositKey Deposit key of the reserved deposit.
   * @returns 20-byte public key hash of the designated wallet. Zero when
   *          the deposit is not pending.
   */
  reservedDepositWallet(depositKey: BigNumber): Promise<Hex>

  /**
   * Gets the number of pending third-party re-anchor holds reserved
   * against the given target wallet.
   * @param walletPublicKeyHash 20-byte public key hash of the wallet.
   * @returns Number of pending holds.
   */
  pendingThirdPartyReanchorHolds(walletPublicKeyHash: Hex): Promise<number>

  /**
   * Gets the current count of wallets in the Live state.
   * @returns The number of Live wallets.
   */
  liveWalletsCount(): Promise<number>

  /**
   * Gets whether the deposit with the given key was revealed as reserved
   * and has not been accepted, swept or marked stale yet.
   * @param depositKey Deposit key of the deposit.
   * @returns True when the deposit is a pending reserved deposit.
   */
  isReservedDeposit(depositKey: BigNumber): Promise<boolean>

  /**
   * Gets the deposit with the given key.
   * @param depositKey Deposit key of the deposit.
   * @returns On-chain deposit record.
   */
  deposit(depositKey: BigNumber): Promise<{
    depositor: ChainIdentifier
    amount: BigNumber
    revealedAt: number
    vault?: ChainIdentifier
    treasuryFee: BigNumber
    sweptAt: number
  }>

  /**
   * Gets the registration and state record of the given wallet.
   * @param walletPublicKeyHash 20-byte public key hash of the wallet.
   * @returns On-chain wallet record.
   */
  wallet(walletPublicKeyHash: Hex): Promise<{
    ecdsaWalletID: Hex
    state: WalletState
  }>

  /**
   * Gets whether the given vault is trusted for deposit routing.
   * @param vault Chain identifier of the vault.
   * @returns True when the vault is trusted.
   */
  isVaultTrusted(vault: ChainIdentifier): Promise<boolean>

  /**
   * Gets the Bridge deposit parameters: dust threshold, treasury fee
   * divisor, maximum sweep fee and the reveal-ahead period, all as
   * currently configured on-chain.
   * @returns Deposit parameters.
   */
  depositParameters(): Promise<{
    dustThreshold: BigNumber
    treasuryFeeDivisor: BigNumber
    txMaxFee: BigNumber
    revealAheadPeriodSeconds: number
  }>

  /**
   * Get emitted NewWalletRegistered events.
   * @see GetChainEvents.Function
   */
  getNewWalletRegisteredEvents: GetChainEvents.Function<
    {
      ecdsaWalletID: Hex
      walletPublicKeyHash: Hex
    } & ChainEvent
  >

  /**
   * Get emitted ReservedDepositReleasedToPool events.
   * @see GetChainEvents.Function
   */
  getReservedDepositReleasedToPoolEvents: GetChainEvents.Function<
    {
      depositKey: BigNumber
      depositor: ChainIdentifier
      vault?: ChainIdentifier
    } & ChainEvent
  >
}

/**
 * Represents a registered wallet of the tBTC system with the data relevant
 * for the reservation wallet selection.
 */
export interface ReservedWallet {
  /**
   * 20-byte public key hash of the wallet.
   */
  publicKeyHash: Hex
  /**
   * Current state of the wallet.
   */
  state: WalletState
  /**
   * Number of reservations custodied by the wallet, including reserved
   * capacity of pending actions.
   */
  reservationsCount: number
  /**
   * Total satoshi amount of reservation anchors custodied by the wallet.
   */
  reservationsAmount: BigNumber
}
