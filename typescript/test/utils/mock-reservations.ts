import { BigNumber } from "@ethersproject/bignumber"
import {
  Reservations,
  ReservationRecord,
  ReservationActionRecord,
  ReservationParameters,
  ReservationCaps,
  ReservationOccupancy,
  ChainIdentifier,
  WalletState,
  GetChainEvents,
  NewWalletRegisteredEvent,
  ChainEvent,
} from "../../src/lib/contracts"
import { Hex } from "../../src/lib/utils"
import { BitcoinRawTxVectors, BitcoinSpvProof } from "../../src/lib/bitcoin"

/**
 * Shape of a ReservedDepositReleasedToPool event.
 */
type ReservedDepositReleasedToPoolEvent = {
  depositKey: BigNumber
  depositor: ChainIdentifier
  vault?: ChainIdentifier
} & ChainEvent

interface ReservedDepositState {
  isReserved: boolean
  walletPublicKeyHash: Hex
  amount: BigNumber
  revealedAt: number
  sweptAt: number
  depositor?: ChainIdentifier
}

/**
 * Mock of the Reservations handle used in service tests. State is set
 * explicitly per test; interactions are recorded for assertions.
 * @returns {void}
 */
export class MockReservations implements Reservations {
  // --- configurable state -------------------------------------------
  parameters: ReservationParameters
  caps: ReservationCaps
  occupancy: ReservationOccupancy
  reservedDeposits = new Map<string, ReservedDepositState>()
  reservationRecords = new Map<string, Partial<ReservationRecord>>()
  walletStates = new Map<string, WalletState>()
  walletReservationCounts = new Map<string, number>()
  walletReservationAmounts = new Map<string, BigNumber>()
  registeredWallets: NewWalletRegisteredEvent[] = []
  depositParams: {
    dustThreshold: BigNumber
    treasuryFeeDivisor: BigNumber
    txMaxFee: BigNumber
    revealAheadPeriodSeconds: number
  }
  liveWallets: number
  handoffReserveWallets: number
  /**
   * Whether the on-chain authorization window of a new acceptance request
   * is still open. The SDK cannot evaluate this rule: the snapshotted
   * refund deadline of the deposit is not exposed as a public view, so the
   * off-chain preflight never reads this flag.
   */
  signingWindowOpen = true

  // --- recorded interactions ----------------------------------------
  releaseCalls: Array<{ depositKey: BigNumber; vault: ChainIdentifier }> = []
  requestAcceptanceCalls: Array<{
    fundingTx: BitcoinRawTxVectors
    fundingProof: BitcoinSpvProof
    fundingOutputIndex: number
    walletPublicKeyHash: Hex
  }> = []

  /**
   * Creates a mock with the default reservation state.
   * @returns {void}
   */
  constructor() {
    this.parameters = {
      vault: undefined,
      minAmount: BigNumber.from(100000),
      txMaxFee: BigNumber.from(20000),
      termSeconds: 7776000,
      dissolutionDelaySeconds: 0,
      maxTotalAmount: BigNumber.from(0),
      totalAmount: BigNumber.from(0),
      maxReservationsPerWallet: 0,
      actionTimeoutSeconds: 43200,
    }
    this.caps = {
      maxAmountPerWallet: BigNumber.from(0),
      maxSingleAmount: BigNumber.from(0),
      maxActiveReservations: 1000,
      maxThirdPartyReanchorHoldsPerWallet: 0,
    }
    this.occupancy = { count: 0, maxActive: 1000 }
    this.depositParams = {
      dustThreshold: BigNumber.from(100000),
      treasuryFeeDivisor: BigNumber.from(100),
      txMaxFee: BigNumber.from(20000),
      revealAheadPeriodSeconds: 1296000,
    }
    this.liveWallets = 4
    this.handoffReserveWallets = 2
  }

  /**
   * Configures a revealed reserved deposit for preflight and status tests.
   * @param depositKey The deposit key.
   * @param data The deposit state to configure.
   * @returns {void}
   */
  addReservedDeposit(
    depositKey: BigNumber,
    data: {
      amount: BigNumber
      walletPublicKeyHash: Hex
      isReserved: boolean
      revealedAt: number
      sweptAt?: number
      depositor?: ChainIdentifier
    }
  ) {
    this.reservedDeposits.set(depositKey.toString(), {
      isReserved: data.isReserved,
      walletPublicKeyHash: data.walletPublicKeyHash,
      amount: data.amount,
      revealedAt: data.revealedAt,
      sweptAt: data.sweptAt ?? 0,
      depositor: data.depositor,
    })
  }

  /**
   * Overrides a field of the on-chain reservation record (e.g. the
   * request nonce) for the given deposit key.
   * @param depositKey The deposit key.
   * @param record The record fields to override.
   * @returns {void}
   */
  setReservationRecord(
    depositKey: BigNumber,
    record: Partial<ReservationRecord>
  ) {
    const key = depositKey.toString()
    this.reservationRecords.set(key, {
      ...this.reservationRecords.get(key),
      ...record,
    })
  }

  setWalletState(walletPublicKeyHash: Hex, state: WalletState) {
    this.walletStates.set(walletPublicKeyHash.toString(), state)
  }

  setWalletReservations(
    walletPublicKeyHash: Hex,
    count: number,
    amount: BigNumber
  ) {
    this.walletReservationCounts.set(walletPublicKeyHash.toString(), count)
    this.walletReservationAmounts.set(walletPublicKeyHash.toString(), amount)
  }

  // --- Reservations interface ---------------------------------------

  /**
   * Submits an acceptance request. Like the on-chain contract, it re-checks
   * the rules it can observe against the mock's live state at the moment of
   * the call, and reverts with the contract's own revert strings when one of
   * them no longer holds. This mirrors the production semantics: the
   * contract re-checks every rule on-chain, so a request can revert even
   * when an earlier off-chain read of the same rules reported them as
   * satisfied.
   *
   * The re-checked rules are the wallet Live state, the global
   * active-reservations cap, and the authorization window. The deposit-keyed
   * rules cannot be re-checked here: the contract entry point does not
   * receive the deposit key.
   * @param fundingTx The funding transaction.
   * @param fundingProof The SPV proof of the funding transaction.
   * @param fundingOutputIndex Index of the deposit output.
   * @param walletPublicKeyHash The designated wallet's 20-byte pkh.
   * @returns The mock transaction hash.
   */
  async requestReservationAcceptance(
    fundingTx: BitcoinRawTxVectors,
    fundingProof: BitcoinSpvProof,
    fundingOutputIndex: number,
    walletPublicKeyHash: Hex
  ): Promise<Hex> {
    this.requestAcceptanceCalls.push({
      fundingTx,
      fundingProof,
      fundingOutputIndex,
      walletPublicKeyHash,
    })

    const walletState = this.walletStates.get(walletPublicKeyHash.toString())
    if (walletState !== WalletState.Live) {
      throw new Error("Wallet must be in Live state")
    }
    if (this.occupancy.count + 1 > this.occupancy.maxActive) {
      throw new Error("Active reservations cap exceeded")
    }
    if (!this.signingWindowOpen) {
      throw new Error("Acceptance authorization has no signing window")
    }

    return Hex.from("0xdeadbeef")
  }

  async releaseReservedDepositToPool(
    depositKey: BigNumber,
    vault: ChainIdentifier
  ): Promise<Hex> {
    this.releaseCalls.push({ depositKey, vault })
    return Hex.from("0xfeedface")
  }

  async reservations(depositKey: BigNumber): Promise<ReservationRecord> {
    const overrides = this.reservationRecords.get(depositKey.toString())
    const base: ReservationRecord = {
      owner: undefined,
      mintedAmount: BigNumber.from(0),
      acceptedAt: 0,
      walletPublicKeyHash: Hex.from("0x" + "0".repeat(40)),
      anchorAmount: BigNumber.from(0),
      expiresAt: 0,
      anchorTxHash: Hex.from("0x" + "0".repeat(64)),
      anchorTxOutputIndex: 0,
      state: 0,
      requestNonce: 0,
    }
    return { ...base, ...overrides }
  }

  async reservationActions(
    _depositKey: BigNumber,
    _requestNonce: number
  ): Promise<ReservationActionRecord> {
    return {
      targetWalletPublicKeyHash: Hex.from("0x" + "0".repeat(40)),
      requestedAt: 0,
      timeoutAt: 0,
      txMaxFee: BigNumber.from(0),
      actionType: 0,
      state: 0,
      amount: BigNumber.from(0),
      termSeconds: 0,
      minAmount: BigNumber.from(0),
    }
  }

  async reservationParameters(): Promise<ReservationParameters> {
    return this.parameters
  }

  async reservationCaps(): Promise<ReservationCaps> {
    return this.caps
  }

  async reservationHandoffReserveWallets(): Promise<number> {
    return this.handoffReserveWallets
  }

  async activeReservationsCount(): Promise<ReservationOccupancy> {
    return this.occupancy
  }

  async liveWalletsCount(): Promise<number> {
    return this.liveWallets
  }

  async walletReservationsAmount(walletPublicKeyHash: Hex): Promise<BigNumber> {
    return (
      this.walletReservationAmounts.get(walletPublicKeyHash.toString()) ??
      BigNumber.from(0)
    )
  }

  async walletReservationsCount(walletPublicKeyHash: Hex): Promise<number> {
    return this.walletReservationCounts.get(walletPublicKeyHash.toString()) ?? 0
  }

  async pendingReservedDeposits(): Promise<number> {
    return [...this.reservedDeposits.values()].filter(
      (d) => d.isReserved && d.sweptAt === 0
    ).length
  }

  async reservedDepositWallet(depositKey: BigNumber): Promise<Hex> {
    const deposit = this.reservedDeposits.get(depositKey.toString())
    if (deposit === undefined || !deposit.isReserved) {
      return Hex.from("0x" + "0".repeat(40))
    }
    return deposit.walletPublicKeyHash
  }

  async pendingThirdPartyReanchorHolds(
    _walletPublicKeyHash: Hex
  ): Promise<number> {
    return 0
  }

  async isReservedDeposit(depositKey: BigNumber): Promise<boolean> {
    const deposit = this.reservedDeposits.get(depositKey.toString())
    return deposit !== undefined && deposit.isReserved && deposit.sweptAt === 0
  }

  async deposit(depositKey: BigNumber): Promise<{
    depositor: ChainIdentifier
    amount: BigNumber
    revealedAt: number
    vault?: ChainIdentifier
    treasuryFee: BigNumber
    sweptAt: number
  }> {
    const deposit = this.reservedDeposits.get(depositKey.toString())
    if (deposit === undefined) {
      return {
        depositor: undefined as unknown as ChainIdentifier,
        amount: BigNumber.from(0),
        revealedAt: 0,
        vault: undefined,
        treasuryFee: BigNumber.from(0),
        sweptAt: 0,
      }
    }
    return {
      depositor: deposit.depositor ?? (undefined as unknown as ChainIdentifier),
      amount: deposit.amount,
      revealedAt: deposit.revealedAt,
      vault: undefined,
      treasuryFee: BigNumber.from(0),
      sweptAt: deposit.sweptAt,
    }
  }

  async wallet(walletPublicKeyHash: Hex): Promise<{
    ecdsaWalletID: Hex
    state: WalletState
  }> {
    return {
      ecdsaWalletID: Hex.from("0x" + "0".repeat(32)),
      state:
        this.walletStates.get(walletPublicKeyHash.toString()) ??
        WalletState.Unknown,
    }
  }

  async isVaultTrusted(_vault: ChainIdentifier): Promise<boolean> {
    return true
  }

  async depositParameters(): Promise<{
    dustThreshold: BigNumber
    treasuryFeeDivisor: BigNumber
    txMaxFee: BigNumber
    revealAheadPeriodSeconds: number
  }> {
    return this.depositParams
  }

  getNewWalletRegisteredEvents: GetChainEvents.Function<NewWalletRegisteredEvent> =
    async () => this.registeredWallets

  getReservedDepositReleasedToPoolEvents: GetChainEvents.Function<ReservedDepositReleasedToPoolEvent> =
    async () => []

  // --- test helpers ---------------------------------------------------

  get releaseCallCount(): number {
    return this.releaseCalls.length
  }
}
