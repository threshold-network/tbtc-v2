import { BigNumber } from "@ethersproject/bignumber"
import * as crypto from "crypto"
import {
  ChainIdentifier,
  TBTCContracts,
  WalletState,
  ReservationRecord,
  ReservationActionRecord,
  ReservationParameters,
  ReservedWallet,
  DepositReceipt,
  validateDepositReceipt,
} from "../../lib/contracts"
import { Hex } from "../../lib/utils"
import {
  BitcoinAddressConverter,
  BitcoinClient,
  BitcoinHashUtils,
  BitcoinLocktimeUtils,
  BitcoinScriptUtils,
  extractBitcoinRawTxVectors,
} from "../../lib/bitcoin"
import { Deposit } from "../deposits"
import { EthereumAddress } from "../../lib/ethereum/address"

/**
 * Default slack added on top of the reveal-ahead period when choosing the
 * refund locktime of a reserved deposit. It matches the slack of the
 * ordinary SDK flow (a locktime far above the earliest admissible value)
 * so the depositor keeps days of margin between address generation and
 * reveal. Configurable per call.
 */
export const RESERVATION_REVEAL_SLACK_SECONDS = 2592000

/**
 * Default margin kept below the far end of the on-chain locktime window
 * (term + 24 h) when choosing the refund locktime of a reserved deposit.
 * Configurable per call.
 */
export const RESERVATION_UPPER_MARGIN_SECONDS = 3600

/**
 * Minimum slack the chosen locktime must keep above the reveal-ahead
 * period. When less, the deposit would become refundable before a later
 * reveal can safely happen, so the check reports no-go.
 */
export const RESERVATION_MIN_REVEAL_SLACK_SECONDS = 86400

/**
 * Go/no-go reasons for a reserved deposit.
 */
export type ReservationNoGoReason =
  | "reservations-disabled"
  | "locktime-window-infeasible"
  | "locktime-slack-insufficient"
  | "amount-below-minimum"
  | "amount-below-dust"
  | "amount-above-single-cap"
  | "global-amount-cap-exceeded"
  | "wallet-not-live"
  | "wallet-count-cap-exceeded"
  | "wallet-amount-cap-exceeded"
  | "global-count-cap-exceeded"
  | "no-free-wallet"

export interface ReserveFeasibilityResult {
  go: boolean
  reasons: ReservationNoGoReason[]
  /**
   * The refund locktime that would be used for the receipt, present when
   * the locktime policy is satisfied.
   */
  refundLocktime?: Hex
  /**
   * The "reveal by" UNIX timestamp: the last moment at which the reveal
   * can safely be mined for the chosen locktime (locktime minus the
   * reveal-ahead period).
   */
  revealBy?: number
  /**
   * The on-chain locktime window bounds, present when reservations are
   * enabled.
   */
  window?: {
    lowerBound: number
    upperBound: number
  }
}

export interface ReserveFeasibilityInput {
  amount: BigNumber
  walletPublicKeyHash?: Hex
  now?: number
  /**
   * Slack in seconds added above the reveal-ahead period when choosing the
   * refund locktime. Defaults to {@link RESERVATION_REVEAL_SLACK_SECONDS}.
   */
  revealSlackSeconds?: number
  /**
   * Margin in seconds kept below the far end of the window. Defaults to
   * {@link RESERVATION_UPPER_MARGIN_SECONDS}.
   */
  upperMarginSeconds?: number
}

export interface InitiateReservedDepositOptions {
  walletPublicKeyHash?: Hex
  /**
   * Slack in seconds added above the reveal-ahead period when choosing the
   * refund locktime. Defaults to {@link RESERVATION_REVEAL_SLACK_SECONDS}.
   */
  revealSlackSeconds?: number
  /**
   * Margin in seconds kept below the far end of the window. Defaults to
   * {@link RESERVATION_UPPER_MARGIN_SECONDS}.
   */
  upperMarginSeconds?: number
}

export interface ReservedDepositResult {
  deposit: Deposit
  receipt: DepositReceipt
  walletPublicKeyHash: Hex
}

export interface AcceptancePreflightResult {
  ok: boolean
  failures: string[]
}

/**
 * Returns whether `amount` is large enough for a reservation. The Bridge
 * requires `amount > minAmount + 2 * txMaxFee`: the anchor may pay up to
 * `txMaxFee` and must then stay above the re-anchor floor
 * `minAmount + txMaxFee`, so the position can be handed off when its wallet
 * retires.
 * @param amount Deposit amount in satoshi.
 * @param params The current reservation minimum amount and fee cap.
 * @returns True if the amount is above `minAmount + 2 * txMaxFee`.
 */
function meetsReservationMinimum(
  amount: BigNumber,
  params: Pick<ReservationParameters, "minAmount" | "txMaxFee">
): boolean {
  return amount.gt(params.minAmount.add(params.txMaxFee.mul(2)))
}

/**
 * Service exposing the UTXO-reservation features of the tBTC v2 bridge.
 *
 * A reservation routes a deposit to the reservation vault so that a tBTC
 * wallet anchors it in its own UTXO instead of the shared pool. Flow:
 * pre-funding go/no-go check, reserved deposit initiation (reveal to the
 * reservation vault), acceptance request, and - if the wallet never anchors -
 * release back to the pool.
 */
export class ReservationsService {
  private readonly tbtcContracts: TBTCContracts
  private readonly bitcoinClient: BitcoinClient
  #defaultDepositor: ChainIdentifier | undefined

  constructor(tbtcContracts: TBTCContracts, bitcoinClient: BitcoinClient) {
    this.tbtcContracts = tbtcContracts
    this.bitcoinClient = bitcoinClient
  }

  /**
   * Sets the default depositor (typically the connected signer's address).
   * The depositor is the `msg.sender` of the reveal and the only party that
   * may later request acceptance or release the deposit.
   * @param depositor Chain-specific identifier of the depositor.
   * @returns {void}
   */
  setDefaultDepositor(depositor: ChainIdentifier) {
    this.#defaultDepositor = depositor
  }

  /**
   * Pre-funding go/no-go check for a reserved deposit.
   *
   * @param input Amount and optional wallet for the check.
   * @returns Go/no-go with the failing reasons.
   */
  async checkReserveFeasibility(
    input: ReserveFeasibilityInput
  ): Promise<ReserveFeasibilityResult> {
    const now = input.now ?? Math.floor(Date.now() / 1000)
    const reasons: ReservationNoGoReason[] = []

    const [params, caps] = await Promise.all([
      this.tbtcContracts.reservations.reservationParameters(),
      this.tbtcContracts.reservations.reservationCaps(),
    ])

    if (this.isVaultDisabled(params.vault)) {
      return { go: false, reasons: ["reservations-disabled"] }
    }

    const window = await this.refundLocktimeWindow(params, now)
    let refundLocktime: Hex | undefined
    let revealBy: number | undefined

    if (window === undefined) {
      reasons.push("locktime-window-infeasible")
    } else {
      const revealSlack =
        input.revealSlackSeconds ?? RESERVATION_REVEAL_SLACK_SECONDS
      const upperMargin =
        input.upperMarginSeconds ?? RESERVATION_UPPER_MARGIN_SECONDS
      const earliest = window.lowerBound + revealSlack
      const latest = window.upperBound - upperMargin

      if (earliest > latest) {
        reasons.push("locktime-window-infeasible")
      } else {
        const locktime = Math.min(earliest, latest)
        if (
          locktime - window.lowerBound <
          RESERVATION_MIN_REVEAL_SLACK_SECONDS
        ) {
          reasons.push("locktime-slack-insufficient")
        } else {
          refundLocktime = this.computeRefundLocktime(locktime)
          revealBy = locktime - (window.lowerBound - now)
        }
      }
    }

    if (!meetsReservationMinimum(input.amount, params)) {
      reasons.push("amount-below-minimum")
    }
    const { dustThreshold } =
      await this.tbtcContracts.reservations.depositParameters()
    if (input.amount.lt(dustThreshold)) {
      reasons.push("amount-below-dust")
    }
    if (caps.maxSingleAmount.gt(0) && input.amount.gt(caps.maxSingleAmount)) {
      reasons.push("amount-above-single-cap")
    }
    if (
      !params.maxTotalAmount.isZero() &&
      params.totalAmount.add(input.amount).gt(params.maxTotalAmount)
    ) {
      reasons.push("global-amount-cap-exceeded")
    }

    // Acceptance always checks the global count, also when the caller
    // picks the wallet.
    const occupancy =
      await this.tbtcContracts.reservations.activeReservationsCount()
    if (occupancy.count + 1 > occupancy.maxActive) {
      reasons.push("global-count-cap-exceeded")
    }

    if (input.walletPublicKeyHash !== undefined) {
      const walletPkh = input.walletPublicKeyHash
      if ((await this.walletState(walletPkh)) !== WalletState.Live) {
        reasons.push("wallet-not-live")
      }
      const wc = await this.walletReservationFacts(walletPkh)
      if (
        params.maxReservationsPerWallet > 0 &&
        wc.count + 1 > params.maxReservationsPerWallet
      ) {
        reasons.push("wallet-count-cap-exceeded")
      }
      if (
        caps.maxAmountPerWallet.gt(0) &&
        wc.amount.add(input.amount).gt(caps.maxAmountPerWallet)
      ) {
        reasons.push("wallet-amount-cap-exceeded")
      }
    } else if (
      (await this.selectReservationWallet(input.amount)) === undefined
    ) {
      reasons.push("no-free-wallet")
    }

    return {
      go: reasons.length === 0,
      reasons,
      refundLocktime,
      revealBy,
      window,
    }
  }

  /**
   * Deterministically selects a Live wallet with free reservation capacity.
   *
   * Candidates are enumerated from the NewWalletRegistered event log,
   * filtered to Live wallets whose per-wallet count and amount caps have
   * headroom for the given amount. The active wallet is preferred when
   * eligible; otherwise the lowest public key hash is chosen.
   *
   * @param amount The amount the deposit would reserve against the wallet.
   * @returns The selected wallet, or undefined when none is eligible.
   */
  async selectReservationWallet(
    amount: BigNumber
  ): Promise<ReservedWallet | undefined> {
    const [caps, params] = await Promise.all([
      this.tbtcContracts.reservations.reservationCaps(),
      this.tbtcContracts.reservations.reservationParameters(),
    ])

    const candidates = await this.enumerateWallets()
    const eligible: ReservedWallet[] = []

    for (const candidate of candidates) {
      if (candidate.state !== WalletState.Live) {
        continue
      }
      if (
        params.maxReservationsPerWallet > 0 &&
        candidate.reservationsCount + 1 > params.maxReservationsPerWallet
      ) {
        continue
      }
      if (
        caps.maxAmountPerWallet.gt(0) &&
        candidate.reservationsAmount.add(amount).gt(caps.maxAmountPerWallet)
      ) {
        continue
      }
      eligible.push(candidate)
    }

    if (eligible.length === 0) {
      return undefined
    }

    const activePkh = await this.activeWalletPublicKeyHash()
    const preferred =
      activePkh !== undefined
        ? eligible.find((w) => w.publicKeyHash.equals(activePkh))
        : undefined
    if (preferred) {
      return preferred
    }

    return eligible.sort((a, b) =>
      a.publicKeyHash.toBuffer().compare(b.publicKeyHash.toBuffer())
    )[0]
  }

  /**
   * Initiates a reserved deposit: generates a deposit receipt whose refund
   * locktime lies inside the on-chain reservation window, for reveal to the
   * reservation vault.
   *
   * @param bitcoinRecoveryAddress P2PKH or P2WPKH address that can refund.
   * @param options Optional chosen wallet and locktime buffer.
   * @returns The deposit handle, the receipt and the designated wallet pkh.
   * @throws When the default depositor is not set, reservations are
   *         disabled, no eligible wallet is found, or the locktime window is
   *         infeasible.
   */
  async initiateReservedDeposit(
    bitcoinRecoveryAddress: string,
    options?: InitiateReservedDepositOptions
  ): Promise<ReservedDepositResult> {
    if (this.#defaultDepositor === undefined) {
      throw new Error(
        "Default depositor is not set; use setDefaultDepositor first"
      )
    }

    const params = await this.tbtcContracts.reservations.reservationParameters()
    const now = Math.floor(Date.now() / 1000)

    const window = await this.refundLocktimeWindow(params, now)
    if (window === undefined) {
      throw new Error("Reservations are currently disabled on this chain")
    }

    const revealSlack =
      options?.revealSlackSeconds ?? RESERVATION_REVEAL_SLACK_SECONDS
    const upperMargin =
      options?.upperMarginSeconds ?? RESERVATION_UPPER_MARGIN_SECONDS
    const earliest = window.lowerBound + revealSlack
    const latest = window.upperBound - upperMargin

    if (earliest > latest) {
      throw new Error("No refund locktime satisfies the reservation window")
    }

    const locktime = Math.min(earliest, latest)
    if (locktime - window.lowerBound < RESERVATION_MIN_REVEAL_SLACK_SECONDS) {
      throw new Error(
        "Insufficient reveal slack for a safe reserved deposit locktime"
      )
    }

    const refundLocktime = this.computeRefundLocktime(locktime)

    let walletPkh =
      options?.walletPublicKeyHash ?? (await this.activeWalletPublicKeyHash())
    if (walletPkh === undefined) {
      walletPkh = (await this.selectReservationWallet(BigNumber.from(0)))
        ?.publicKeyHash
    }
    if (walletPkh === undefined) {
      throw new Error("Could not resolve a wallet for the reserved deposit")
    }

    const refundPublicKeyHash = await this.refundPublicKeyHashFromRecovery(
      bitcoinRecoveryAddress
    )

    const receipt = await this.generateReceipt(
      walletPkh,
      refundPublicKeyHash,
      refundLocktime
    )

    const deposit = await Deposit.fromReceipt(
      receipt,
      this.tbtcContracts,
      this.bitcoinClient
    )

    return {
      deposit,
      receipt,
      walletPublicKeyHash: walletPkh,
    }
  }

  /**
   * Reveals the reserved deposit to the reservation vault.
   * @param deposit The deposit handle from {@link initiateReservedDeposit}.
   * @returns Transaction hash of the reveal.
   */
  async revealReservedDeposit(deposit: Deposit): Promise<Hex> {
    const params = await this.tbtcContracts.reservations.reservationParameters()
    if (this.isVaultDisabled(params.vault)) {
      throw new Error("Reservations are disabled; no reservation vault is set")
    }

    const receipt = deposit.getReceipt()
    const fundingOutpoints = await deposit.detectFunding()
    if (fundingOutpoints.length === 0) {
      throw new Error("Deposit not funded yet")
    }
    const outpoint = fundingOutpoints[0]
    const fundingTx = await this.bitcoinClient.getRawTransaction(
      outpoint.transactionHash
    )
    const vectors = extractBitcoinRawTxVectors(fundingTx)

    return this.tbtcContracts.bridge.revealDeposit(
      vectors,
      outpoint.outputIndex,
      receipt,
      params.vault
    )
  }

  /**
   * Requests acceptance of a revealed reserved deposit on behalf of the
   * depositor.
   *
   * Only the depositor who revealed the deposit may call this. The request
   * authorizes the designated wallet to anchor the deposit in its own UTXO.
   *
   * @param depositKey The deposit key (doubles as the reservation key).
   * @param walletPublicKeyHash The designated wallet's 20-byte pkh. Must
   *        match the wallet the deposit was revealed for.
   * @returns Transaction hash of the acceptance request.
   */
  async requestAcceptance(
    depositKey: BigNumber,
    walletPublicKeyHash: Hex
  ): Promise<Hex> {
    return this.tbtcContracts.reservations.requestReservationAcceptance(
      depositKey,
      walletPublicKeyHash
    )
  }

  /**
   * Preflight for {@link requestAcceptance}: reports which on-chain request
   * rule would fail, without submitting the transaction.
   *
   * The deadline-based signing-window rules are not checked here: the
   * deposit's snapshotted refund deadline is not exposed as a public view,
   * so they cannot be reliably evaluated off-chain. All other rules are.
   *
   * @param depositKey The deposit key of the revealed reserved deposit.
   * @param walletPublicKeyHash The designated wallet's pkh.
   * @returns The passing/failing rules.
   */
  async checkAcceptancePreflight(
    depositKey: BigNumber,
    walletPublicKeyHash: Hex
  ): Promise<AcceptancePreflightResult> {
    const failures: string[] = []

    const [params, caps, reservation, record] = await Promise.all([
      this.tbtcContracts.reservations.reservationParameters(),
      this.tbtcContracts.reservations.reservationCaps(),
      this.tbtcContracts.reservations.reservations(depositKey),
      this.tbtcContracts.reservations.deposit(depositKey),
    ])

    if (this.isVaultDisabled(params.vault)) {
      failures.push("reservations are disabled")
    }
    if (record.revealedAt === 0) {
      failures.push("deposit is not revealed")
    }
    if (record.sweptAt !== 0) {
      failures.push("deposit was already swept")
    }
    // A reserved deposit commits to a specific depositor: the on-chain
    // `msg.sender` of the reveal. The connected signer (default depositor)
    // must be that address; a deposit revealed through a proxy or cross-chain
    // depositor contract names a different depositor and can therefore never
    // request acceptance from this signer.
    if (
      this.#defaultDepositor !== undefined &&
      record.depositor !== undefined &&
      !record.depositor.equals(this.#defaultDepositor)
    ) {
      failures.push("caller is not the deposit's depositor")
    }
    if (
      !(await this.tbtcContracts.reservations.isReservedDeposit(depositKey))
    ) {
      failures.push("deposit was not revealed as reserved")
    }
    if (reservation.requestNonce !== 0) {
      failures.push("an acceptance request was already made for this deposit")
    }

    const designated =
      await this.tbtcContracts.reservations.reservedDepositWallet(depositKey)
    if (!designated.equals(walletPublicKeyHash)) {
      failures.push("wallet is not the deposit's designated wallet")
    }
    if ((await this.walletState(walletPublicKeyHash)) !== WalletState.Live) {
      failures.push("wallet is not in Live state")
    }

    if (!meetsReservationMinimum(record.amount, params)) {
      failures.push("deposit amount is below the reservation minimum")
    }
    if (caps.maxSingleAmount.gt(0) && record.amount.gt(caps.maxSingleAmount)) {
      failures.push("deposit exceeds the single-reservation cap")
    }

    const occupancy =
      await this.tbtcContracts.reservations.activeReservationsCount()
    if (occupancy.count + 1 > occupancy.maxActive) {
      failures.push("the global active-reservations cap would be exceeded")
    }
    const wc = await this.walletReservationFacts(walletPublicKeyHash)
    if (
      params.maxReservationsPerWallet > 0 &&
      wc.count + 1 > params.maxReservationsPerWallet
    ) {
      failures.push("the per-wallet reservation-count cap would be exceeded")
    }
    if (
      caps.maxAmountPerWallet.gt(0) &&
      wc.amount.add(record.amount).gt(caps.maxAmountPerWallet)
    ) {
      failures.push("the per-wallet reserved-amount cap would be exceeded")
    }

    return {
      ok: failures.length === 0,
      failures,
    }
  }

  /**
   * Releases a reserved deposit that never received an acceptance request
   * back to the pool so that ordinary sweeps accept it again.
   *
   * Only the depositor of the deposit may call this. The vault must be the
   * zero address or a trusted vault other than the reservation vault.
   *
   * @param depositKey The deposit key of the reserved deposit.
   * @param vault The target vault, or undefined for the zero address.
   * @returns Transaction hash of the release.
   */
  async releaseToPool(
    depositKey: BigNumber,
    vault?: ChainIdentifier
  ): Promise<Hex> {
    const zero = this.zeroAddress()
    return this.tbtcContracts.reservations.releaseReservedDepositToPool(
      depositKey,
      vault ?? zero
    )
  }

  /**
   * Reads the on-chain reservation record for a deposit.
   * @param depositKey The deposit key.
   * @returns On-chain reservation record.
   */
  reservationRecord(depositKey: BigNumber): Promise<ReservationRecord> {
    return this.tbtcContracts.reservations.reservations(depositKey)
  }

  /**
   * Reads the on-chain record of a reservation action generation.
   * @param depositKey The deposit key.
   * @param requestNonce The action generation.
   * @returns On-chain reservation action record.
   */
  reservationAction(
    depositKey: BigNumber,
    requestNonce: number
  ): Promise<ReservationActionRecord> {
    return this.tbtcContracts.reservations.reservationActions(
      depositKey,
      requestNonce
    )
  }

  /**
   * Reads the current reservation parameters.
   * @returns On-chain reservation parameters.
   */
  reservationParameters(): Promise<ReservationParameters> {
    return this.tbtcContracts.reservations.reservationParameters()
  }

  /**
   * Reads whether the given deposit is a pending reserved deposit.
   * @param depositKey The deposit key.
   * @returns True when the deposit is a pending reserved deposit.
   */
  isReservedDeposit(depositKey: BigNumber): Promise<boolean> {
    return this.tbtcContracts.reservations.isReservedDeposit(depositKey)
  }

  // --- internal helpers -------------------------------------------------

  private isVaultDisabled(vault: ChainIdentifier | undefined): boolean {
    return (
      vault === undefined ||
      vault.identifierHex.toLowerCase() === "0".repeat(40)
    )
  }

  private zeroAddress(): ChainIdentifier {
    return EthereumAddress.from("0x" + "0".repeat(40))
  }

  private async activeWalletPublicKeyHash(): Promise<Hex | undefined> {
    const activePk = await this.tbtcContracts.bridge.activeWalletPublicKey()
    if (activePk === undefined) {
      return undefined
    }
    return BitcoinHashUtils.computeHash160(activePk)
  }
  private async walletState(pkh: Hex): Promise<WalletState> {
    const wallet = await this.tbtcContracts.reservations.wallet(pkh)
    return wallet.state
  }

  private async walletReservationFacts(pkh: Hex): Promise<{
    count: number
    amount: BigNumber
  }> {
    const [count, amount] = await Promise.all([
      this.tbtcContracts.reservations.walletReservationsCount(pkh),
      this.tbtcContracts.reservations.walletReservationsAmount(pkh),
    ])
    return { count, amount }
  }

  private async enumerateWallets(): Promise<ReservedWallet[]> {
    const events =
      await this.tbtcContracts.reservations.getNewWalletRegisteredEvents()

    const seen = new Set<string>()
    const candidates: ReservedWallet[] = []

    for (const event of events) {
      const key = event.walletPublicKeyHash.toString()
      if (seen.has(key)) {
        continue
      }
      seen.add(key)

      const wallet = await this.tbtcContracts.reservations.wallet(
        event.walletPublicKeyHash
      )
      const [count, amount] = await Promise.all([
        this.tbtcContracts.reservations.walletReservationsCount(
          event.walletPublicKeyHash
        ),
        this.tbtcContracts.reservations.walletReservationsAmount(
          event.walletPublicKeyHash
        ),
      ])

      candidates.push({
        publicKeyHash: event.walletPublicKeyHash,
        state: wallet.state,
        reservationsCount: count,
        reservationsAmount: amount,
      })
    }

    return candidates
  }

  /**
   * Computes the on-chain refund locktime window for a reserved deposit:
   * `now + revealAhead <= locktime <= now + term + 24h`. Returns undefined
   * when the window is infeasible (reservations disabled).
   * @param params The current reservation parameters.
   * @param now UNIX timestamp in seconds to treat as current.
   * @returns The locktime window bounds, or undefined when infeasible.
   */
  private async refundLocktimeWindow(
    params: ReservationParameters,
    now: number
  ): Promise<{ lowerBound: number; upperBound: number } | undefined> {
    if (this.isVaultDisabled(params.vault)) {
      return undefined
    }
    const depositParams =
      await this.tbtcContracts.reservations.depositParameters()
    const lowerBound = now + depositParams.revealAheadPeriodSeconds
    // The upper bound caps the refund deadline at term + 24-hour safety
    // margin (WalletProposalValidatorConstants.DEPOSIT_REFUND_SAFETY_MARGIN).
    const upperBound = now + params.termSeconds + 24 * 3600
    if (lowerBound > upperBound) {
      return undefined
    }
    return { lowerBound, upperBound }
  }

  private computeRefundLocktime(locktime: number): Hex {
    // Bitcoin locktime must be >= 500M to be interpreted as a timestamp.
    const clamped = Math.max(locktime, 500 * 1000 * 1000)
    return BitcoinLocktimeUtils.calculateLocktime(clamped, 0)
  }

  private async generateReceipt(
    walletPublicKeyHash: Hex,
    refundPublicKeyHash: Hex,
    refundLocktime: Hex
  ): Promise<DepositReceipt> {
    const receipt: DepositReceipt = {
      depositor: this.#defaultDepositor!,
      blindingFactor: Hex.from(crypto.randomBytes(8)),
      walletPublicKeyHash,
      refundPublicKeyHash,
      refundLocktime,
    }

    validateDepositReceipt(receipt)
    return receipt
  }

  private async refundPublicKeyHashFromRecovery(
    bitcoinRecoveryAddress: string
  ): Promise<Hex> {
    const network = await this.bitcoinClient.getNetwork()
    const recoveryOutputScript = BitcoinAddressConverter.addressToOutputScript(
      bitcoinRecoveryAddress,
      network
    )
    if (
      !BitcoinScriptUtils.isP2PKHScript(recoveryOutputScript) &&
      !BitcoinScriptUtils.isP2WPKHScript(recoveryOutputScript)
    ) {
      throw new Error("Bitcoin recovery address must be P2PKH or P2WPKH")
    }
    return BitcoinAddressConverter.addressToPublicKeyHash(
      bitcoinRecoveryAddress,
      network
    )
  }
}
