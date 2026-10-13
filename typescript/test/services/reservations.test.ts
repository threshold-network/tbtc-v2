import { expect, use } from "chai"
import chaiAsPromised from "chai-as-promised"
import { BigNumber } from "ethers"

use(chaiAsPromised)

import {
  WalletState,
  NewWalletRegisteredEvent,
  Reservations,
  ReservationOccupancy,
} from "../../src/lib/contracts"
import { Hex } from "../../src/lib/utils"
import {
  ReservationsService,
  RESERVATION_REVEAL_SLACK_SECONDS,
} from "../../src/services/reservations"
import { EthereumAddress, BitcoinNetwork } from "../../src"
import { MockBitcoinClient } from "../utils/mock-bitcoin-client"
import { MockTBTCContracts } from "../utils/mock-tbtc-contracts"
import { MockReservations } from "../utils/mock-reservations"

const TEST_DEPOSITOR = EthereumAddress.from(
  "0x1234567890abcdef1234567890abcdef12345678"
)
const OTHER_ADDRESS = EthereumAddress.from(
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
)

const WALLET_A_PKH = Hex.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
const WALLET_B_PKH = Hex.from("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
const ACTIVE_WALLET_PK = Hex.from(
  "03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9"
)
// hash160 of ACTIVE_WALLET_PK
const ACTIVE_WALLET_PKH = Hex.from("8db50eb52063ea9d98b3eac91489a90f738986f6")

const TESTNET_RECOVERY_ADDRESS = "tb1qumuaw3exkxdhtut0u85latkqfz4ylgwstkdzsx"

function makeWalletEvent(pkh: Hex): NewWalletRegisteredEvent {
  return {
    blockNumber: 1,
    blockHash: Hex.from("0x" + "ab".repeat(32)),
    transactionHash: Hex.from("0x" + "cd".repeat(32)),
    ecdsaWalletID: Hex.from("0x" + "01".repeat(32)),
    walletPublicKeyHash: pkh,
  }
}

/**
 * Sepolia drill values from the reservation upgrade.
 */
const SEPOLIA_LIKE = {
  revealAheadPeriodSeconds: 1296000,
  termSeconds: 7776000,
}

/**
 * Real mainnet reservation values: 150 day reveal-ahead, 12 month term.
 */
const MAINNET_LIKE = {
  revealAheadPeriodSeconds: 12960000,
  termSeconds: 31536000,
}

function configureSepoliaLike(mock: MockReservations) {
  mock.parameters.vault = EthereumAddress.from(
    "0x00000000000000000000000000000000000000f1"
  )
  mock.parameters.minAmount = BigNumber.from(100000)
  mock.parameters.txMaxFee = BigNumber.from(20000)
  mock.parameters.termSeconds = SEPOLIA_LIKE.termSeconds
  mock.parameters.maxTotalAmount = BigNumber.from(0)
  mock.parameters.totalAmount = BigNumber.from(0)
  mock.parameters.maxReservationsPerWallet = 0
  mock.depositParams = {
    dustThreshold: BigNumber.from(100000),
    treasuryFeeDivisor: BigNumber.from(100),
    txMaxFee: BigNumber.from(20000),
    revealAheadPeriodSeconds: SEPOLIA_LIKE.revealAheadPeriodSeconds,
  }
  mock.caps = {
    maxAmountPerWallet: BigNumber.from(0),
    maxSingleAmount: BigNumber.from(0),
    maxActiveReservations: 1000,
    maxThirdPartyReanchorHoldsPerWallet: 0,
  }
  mock.occupancy = { count: 0, maxActive: 1000 }
}

describe("ReservationsService", () => {
  let mockBitcoinClient: MockBitcoinClient
  let tbtcContracts: MockTBTCContracts
  let mockReservations: MockReservations
  let service: ReservationsService

  beforeEach(() => {
    mockBitcoinClient = new MockBitcoinClient()
    tbtcContracts = new MockTBTCContracts()
    mockReservations = tbtcContracts.reservations as MockReservations
    configureSepoliaLike(mockReservations)
    service = new ReservationsService(tbtcContracts, mockBitcoinClient)
    service.setDefaultDepositor(TEST_DEPOSITOR)
  })

  describe("checkReserveFeasibility", () => {
    context("when reservations are enabled and capacity is free", () => {
      beforeEach(() => {
        mockReservations.registeredWallets = [makeWalletEvent(WALLET_A_PKH)]
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
      })

      it("should report go when all rules pass", async () => {
        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
        })

        expect(result.go).to.be.true
        expect(result.reasons).to.have.length(0)
        expect(result.refundLocktime).to.not.be.undefined
      })

      it("should choose the 45-day locktime with the default 30-day reveal slack", async () => {
        const now = Math.floor(Date.now() / 1000)
        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          now,
        })

        // Default policy: min(now + revealAhead + 30d, now + term + 24h - 1h)
        // = now + revealAhead + 30d = 45 days on Sepolia-like params.
        const expected =
          now +
          SEPOLIA_LIKE.revealAheadPeriodSeconds +
          RESERVATION_REVEAL_SLACK_SECONDS
        const locktime = BigNumber.from(
          result.refundLocktime!.reverse().toPrefixedString()
        ).toNumber()
        expect(locktime).to.equal(expected)
        // The reveal-by deadline is locktime minus the reveal-ahead period.
        expect(result.revealBy).to.equal(
          expected - SEPOLIA_LIKE.revealAheadPeriodSeconds
        )
        expect(result.window!.lowerBound).to.equal(
          now + SEPOLIA_LIKE.revealAheadPeriodSeconds
        )
        expect(result.window!.upperBound).to.equal(
          now + SEPOLIA_LIKE.termSeconds + 24 * 3600
        )
      })
    })

    context("when the reservation vault is not set", () => {
      beforeEach(() => {
        mockReservations.parameters.vault = undefined
      })

      it("should report reservations-disabled", async () => {
        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.deep.equal(["reservations-disabled"])
      })

      it("should report reservations-disabled for the zero address", async () => {
        mockReservations.parameters.vault = EthereumAddress.from(
          "0x" + "0".repeat(40)
        )

        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.deep.equal(["reservations-disabled"])
      })
    })

    context("when the locktime window is infeasible", () => {
      beforeEach(() => {
        // The term is shorter than the reveal-ahead period, so no locktime
        // inside the window satisfies the reveal rules.
        mockReservations.parameters.termSeconds = 0
      })

      it("should report locktime-window-infeasible", async () => {
        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          now: 1700000000,
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.include("locktime-window-infeasible")
        expect(result.refundLocktime).to.be.undefined
      })
    })

    context("when the amount violates the reservation bounds", () => {
      beforeEach(() => {
        mockReservations.registeredWallets = [makeWalletEvent(WALLET_A_PKH)]
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
        mockReservations.caps.maxSingleAmount = BigNumber.from(1000000)
      })

      it("should report amount-below-minimum up to minAmount + 2 * txMaxFee", async () => {
        // 100000 + 2 * 20000 = 140000 is still too small: the anchor could
        // pay the full fee and land on the re-anchor floor.
        const atFloor = await service.checkReserveFeasibility({
          amount: BigNumber.from(140000),
          walletPublicKeyHash: WALLET_A_PKH,
        })
        expect(atFloor.go).to.be.false
        expect(atFloor.reasons).to.include("amount-below-minimum")

        const aboveFloor = await service.checkReserveFeasibility({
          amount: BigNumber.from(140001),
          walletPublicKeyHash: WALLET_A_PKH,
        })
        expect(aboveFloor.reasons).to.not.include("amount-below-minimum")
      })

      it("should report amount-below-dust below the Bridge deposit dust threshold", async () => {
        // The reveal itself reverts below dust, after the BTC is sent.
        mockReservations.depositParams.dustThreshold = BigNumber.from(1000000)

        const atDust = await service.checkReserveFeasibility({
          amount: BigNumber.from(1000000),
          walletPublicKeyHash: WALLET_A_PKH,
        })
        expect(atDust.reasons).to.not.include("amount-below-dust")

        const below = await service.checkReserveFeasibility({
          amount: BigNumber.from(999999),
          walletPublicKeyHash: WALLET_A_PKH,
        })
        expect(below.go).to.be.false
        expect(below.reasons).to.include("amount-below-dust")
      })

      it("should report amount-above-single-cap when the cap is exceeded", async () => {
        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(1000001),
          walletPublicKeyHash: WALLET_A_PKH,
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.include("amount-above-single-cap")
      })

      it("should report global-amount-cap-exceeded when the total cap would overflow", async () => {
        mockReservations.parameters.maxTotalAmount = BigNumber.from(2000000)
        mockReservations.parameters.totalAmount = BigNumber.from(1600000)

        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          walletPublicKeyHash: WALLET_A_PKH,
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.include("global-amount-cap-exceeded")
      })
    })

    context("when the chosen wallet has no free capacity", () => {
      beforeEach(() => {
        mockReservations.registeredWallets = [makeWalletEvent(WALLET_A_PKH)]
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
        mockReservations.parameters.maxReservationsPerWallet = 5
        mockReservations.caps.maxAmountPerWallet = BigNumber.from(1000000)
      })

      it("should report wallet-not-live for a non-Live wallet", async () => {
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Closing)

        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          walletPublicKeyHash: WALLET_A_PKH,
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.include("wallet-not-live")
      })

      it("should report wallet-count-cap-exceeded when the per-wallet count is full", async () => {
        mockReservations.setWalletReservations(
          WALLET_A_PKH,
          5,
          BigNumber.from(0)
        )

        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          walletPublicKeyHash: WALLET_A_PKH,
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.include("wallet-count-cap-exceeded")
      })

      it("should report wallet-amount-cap-exceeded when the per-wallet amount is full", async () => {
        mockReservations.setWalletReservations(
          WALLET_A_PKH,
          0,
          BigNumber.from(1000000)
        )

        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(1),
          walletPublicKeyHash: WALLET_A_PKH,
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.include("wallet-amount-cap-exceeded")
      })

      it("should report global-count-cap-exceeded for a chosen wallet when the active cap is full", async () => {
        mockReservations.occupancy = { count: 1000, maxActive: 1000 }

        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          walletPublicKeyHash: WALLET_A_PKH,
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.include("global-count-cap-exceeded")
      })
    })

    context("when no wallet is chosen", () => {
      it("should report global-count-cap-exceeded when the active cap is full", async () => {
        mockReservations.registeredWallets = [makeWalletEvent(WALLET_A_PKH)]
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
        mockReservations.occupancy = { count: 1000, maxActive: 1000 }

        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.include("global-count-cap-exceeded")
      })

      it("should report no-free-wallet when every registered wallet is full or not Live", async () => {
        mockReservations.registeredWallets = [
          makeWalletEvent(WALLET_A_PKH),
          makeWalletEvent(WALLET_B_PKH),
        ]
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
        mockReservations.setWalletState(WALLET_B_PKH, WalletState.Terminated)
        mockReservations.parameters.maxReservationsPerWallet = 1
        mockReservations.setWalletReservations(
          WALLET_A_PKH,
          1,
          BigNumber.from(0)
        )

        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.include("no-free-wallet")
      })
    })

    context("with mainnet-like parameters", () => {
      beforeEach(() => {
        mockReservations.registeredWallets = [makeWalletEvent(WALLET_A_PKH)]
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
        mockReservations.depositParams.revealAheadPeriodSeconds =
          MAINNET_LIKE.revealAheadPeriodSeconds
        mockReservations.parameters.termSeconds = MAINNET_LIKE.termSeconds
      })

      it("should choose the 180-day locktime (150d reveal-ahead + 30d slack)", async () => {
        const now = Math.floor(Date.now() / 1000)
        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          now,
        })

        expect(result.go).to.be.true
        const locktime = BigNumber.from(
          result.refundLocktime!.reverse().toPrefixedString()
        ).toNumber()
        const expected =
          now +
          MAINNET_LIKE.revealAheadPeriodSeconds +
          RESERVATION_REVEAL_SLACK_SECONDS
        expect(locktime).to.equal(expected)
        expect(result.revealBy).to.equal(
          expected - MAINNET_LIKE.revealAheadPeriodSeconds
        )
      })

      it("should report locktime-slack-insufficient when the slack is below one day", async () => {
        const now = Math.floor(Date.now() / 1000)
        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          now,
          revealSlackSeconds: 0,
          upperMarginSeconds: 0,
        })

        expect(result.go).to.be.false
        expect(result.reasons).to.include("locktime-slack-insufficient")
        expect(result.refundLocktime).to.be.undefined
      })
    })
  })

  describe("hand-off reserve gate", () => {
    // The on-chain gate admits a new acceptance while
    // `count + 1 <= max(0, live - reserve) * perWallet`.
    // Live wallets L = 4, reserve R = 2, per-wallet count cap N = 1,
    // so at most 2 positions may be open even though the global
    // active-reservations cap allows 5.

    function enableGate(
      mock: MockReservations,
      occupancy: ReservationOccupancy
    ) {
      mock.parameters.maxReservationsPerWallet = 1
      mock.occupancy = occupancy
      mock.liveWallets = 4
      mock.handoffReserveWallets = 2
    }

    context("checkReserveFeasibility", () => {
      beforeEach(() => {
        mockReservations.registeredWallets = [makeWalletEvent(WALLET_A_PKH)]
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
      })

      it("should refuse both pre-funding paths when the gate is binding", async () => {
        enableGate(mockReservations, { count: 2, maxActive: 5 })

        const withWallet = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          walletPublicKeyHash: WALLET_A_PKH,
        })
        expect(withWallet.go).to.be.false
        expect(withWallet.reasons).to.include("handoff-reserve-exceeded")

        const autoSelected = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
        })
        expect(autoSelected.go).to.be.false
        expect(autoSelected.reasons).to.include("handoff-reserve-exceeded")
      })

      it("should admit at the boundary count = 1", async () => {
        enableGate(mockReservations, { count: 1, maxActive: 5 })

        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          walletPublicKeyHash: WALLET_A_PKH,
        })

        expect(result.reasons).to.not.include("handoff-reserve-exceeded")
        expect(result.go).to.be.true
      })

      it("should refuse while live wallets are at or below the reserve", async () => {
        enableGate(mockReservations, { count: 0, maxActive: 5 })

        for (const live of [2, 1]) {
          mockReservations.liveWallets = live
          const result = await service.checkReserveFeasibility({
            amount: BigNumber.from(500000),
            walletPublicKeyHash: WALLET_A_PKH,
          })
          expect(result.go, `live = ${live}`).to.be.false
          expect(result.reasons, `live = ${live}`).to.include(
            "handoff-reserve-exceeded"
          )
        }
      })

      it("should refuse when the gate bites before the per-wallet caps", async () => {
        // A free target with headroom under the ordinary caps, but the
        // reserve gate is already exhausted by the open positions.
        enableGate(mockReservations, { count: 2, maxActive: 5 })
        mockReservations.setWalletReservations(
          WALLET_A_PKH,
          0,
          BigNumber.from(0)
        )

        const result = await service.checkReserveFeasibility({
          amount: BigNumber.from(500000),
          walletPublicKeyHash: WALLET_A_PKH,
        })

        expect(result.reasons).to.not.include("wallet-count-cap-exceeded")
        expect(result.reasons).to.not.include("wallet-amount-cap-exceeded")
        expect(result.reasons).to.include("handoff-reserve-exceeded")
      })
    })

    context("checkAcceptancePreflight", () => {
      const depositKey = BigNumber.from(1)

      beforeEach(() => {
        mockReservations.addReservedDeposit(depositKey, {
          amount: BigNumber.from(500000),
          walletPublicKeyHash: WALLET_A_PKH,
          isReserved: true,
          revealedAt: Math.floor(Date.now() / 1000) - 3600,
          depositor: TEST_DEPOSITOR,
        })
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
      })

      it("should fail when the gate is binding while the ordinary caps have room", async () => {
        enableGate(mockReservations, { count: 2, maxActive: 5 })

        const result = await service.checkAcceptancePreflight(
          depositKey,
          WALLET_A_PKH
        )

        expect(result.ok).to.be.false
        expect(result.failures).to.include(
          "the hand-off reserve gate would be exceeded"
        )
      })

      it("should pass at the boundary count = 1", async () => {
        enableGate(mockReservations, { count: 1, maxActive: 5 })

        const result = await service.checkAcceptancePreflight(
          depositKey,
          WALLET_A_PKH
        )

        expect(result.failures).to.not.include(
          "the hand-off reserve gate would be exceeded"
        )
        expect(result.ok).to.be.true
      })

      it("should fail while live wallets are at or below the reserve", async () => {
        enableGate(mockReservations, { count: 0, maxActive: 5 })

        for (const live of [2, 1]) {
          mockReservations.liveWallets = live
          const result = await service.checkAcceptancePreflight(
            depositKey,
            WALLET_A_PKH
          )
          expect(result.failures, `live = ${live}`).to.include(
            "the hand-off reserve gate would be exceeded"
          )
        }
      })
    })

    context("read handles", () => {
      it("should expose the live wallet count and the reserve through the service", async () => {
        const reservations = mockReservations as unknown as Reservations

        mockReservations.liveWallets = 3
        mockReservations.handoffReserveWallets = 2

        expect(await reservations.liveWalletsCount()).to.equal(3)
        expect(await reservations.reservationHandoffReserveWallets()).to.equal(
          2
        )
      })
    })
  })

  describe("selectReservationWallet", () => {
    it("should return undefined when no registered wallet is eligible", async () => {
      mockReservations.registeredWallets = [makeWalletEvent(WALLET_A_PKH)]
      mockReservations.setWalletState(WALLET_A_PKH, WalletState.Closing)

      const selected = await service.selectReservationWallet(
        BigNumber.from(500000)
      )

      expect(selected).to.be.undefined
    })

    it("should skip wallets whose count cap is full", async () => {
      mockReservations.registeredWallets = [
        makeWalletEvent(WALLET_A_PKH),
        makeWalletEvent(WALLET_B_PKH),
      ]
      mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
      mockReservations.setWalletState(WALLET_B_PKH, WalletState.Live)
      mockReservations.parameters.maxReservationsPerWallet = 1
      mockReservations.setWalletReservations(WALLET_A_PKH, 1, BigNumber.from(0))

      const selected = await service.selectReservationWallet(
        BigNumber.from(500000)
      )

      expect(selected?.publicKeyHash.equals(WALLET_B_PKH)).to.be.true
    })

    it("should skip wallets whose amount cap is full", async () => {
      mockReservations.registeredWallets = [
        makeWalletEvent(WALLET_A_PKH),
        makeWalletEvent(WALLET_B_PKH),
      ]
      mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
      mockReservations.setWalletState(WALLET_B_PKH, WalletState.Live)
      mockReservations.caps.maxAmountPerWallet = BigNumber.from(1000000)
      mockReservations.setWalletReservations(
        WALLET_A_PKH,
        0,
        BigNumber.from(1000000)
      )

      const selected = await service.selectReservationWallet(
        BigNumber.from(500000)
      )

      expect(selected?.publicKeyHash.equals(WALLET_B_PKH)).to.be.true
    })

    it("should prefer the active wallet when it is eligible", async () => {
      mockReservations.registeredWallets = [
        makeWalletEvent(WALLET_A_PKH),
        makeWalletEvent(ACTIVE_WALLET_PKH),
      ]
      mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
      mockReservations.setWalletState(ACTIVE_WALLET_PKH, WalletState.Live)
      tbtcContracts.bridge.setActiveWalletPublicKey(ACTIVE_WALLET_PK)

      const selected = await service.selectReservationWallet(
        BigNumber.from(500000)
      )

      expect(selected?.publicKeyHash.equals(ACTIVE_WALLET_PKH)).to.be.true
    })

    it("should pick the lowest public key hash when no active wallet is set", async () => {
      mockReservations.registeredWallets = [
        makeWalletEvent(WALLET_B_PKH),
        makeWalletEvent(WALLET_A_PKH),
      ]
      mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
      mockReservations.setWalletState(WALLET_B_PKH, WalletState.Live)

      const selected = await service.selectReservationWallet(
        BigNumber.from(500000)
      )

      expect(selected?.publicKeyHash.equals(WALLET_A_PKH)).to.be.true
    })
  })

  describe("initiateReservedDeposit", () => {
    context("when the default depositor is not set", () => {
      it("should throw", async () => {
        const freshService = new ReservationsService(
          tbtcContracts,
          mockBitcoinClient
        )

        await expect(
          freshService.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000)
          )
        ).to.be.rejectedWith("Default depositor is not set")
      })
    })

    context("when reservations are disabled", () => {
      beforeEach(() => {
        mockReservations.parameters.vault = undefined
      })

      it("should throw", async () => {
        await expect(
          service.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000)
          )
        ).to.be.rejectedWith("Reservations are currently disabled")
      })
    })

    context("when a wallet can be resolved", () => {
      beforeEach(() => {
        mockReservations.registeredWallets = [makeWalletEvent(WALLET_A_PKH)]
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
      })

      it("should generate a receipt with a refund locktime inside the window", async () => {
        mockBitcoinClient.network = BitcoinNetwork.Testnet

        const result = await service.initiateReservedDeposit(
          TESTNET_RECOVERY_ADDRESS,
          BigNumber.from(500000)
        )

        expect(result.walletPublicKeyHash.equals(WALLET_A_PKH)).to.be.true

        const now = Math.floor(Date.now() / 1000)
        const locktime = BigNumber.from(
          result.receipt.refundLocktime.reverse().toPrefixedString()
        ).toNumber()
        const expected =
          now +
          SEPOLIA_LIKE.revealAheadPeriodSeconds +
          RESERVATION_REVEAL_SLACK_SECONDS
        expect(locktime).to.equal(expected)
        // The receipt keeps the designated wallet and an 8-byte blinding factor.
        expect(result.receipt.walletPublicKeyHash.equals(WALLET_A_PKH)).to.be
          .true
        expect(result.receipt.blindingFactor.toBuffer().length).to.equal(8)
      })

      it("should use the explicitly chosen wallet", async () => {
        mockReservations.registeredWallets = [
          makeWalletEvent(WALLET_A_PKH),
          makeWalletEvent(WALLET_B_PKH),
        ]
        mockReservations.setWalletState(WALLET_B_PKH, WalletState.Live)
        mockBitcoinClient.network = BitcoinNetwork.Testnet

        const result = await service.initiateReservedDeposit(
          TESTNET_RECOVERY_ADDRESS,
          BigNumber.from(500000),
          { walletPublicKeyHash: WALLET_B_PKH }
        )

        expect(result.walletPublicKeyHash.equals(WALLET_B_PKH)).to.be.true
      })

      it("should reject a recovery address that is not P2PKH or P2WPKH", async () => {
        await expect(
          service.initiateReservedDeposit(
            "2N5WZpig3vgpSdjSherS2Lv7GnPuxCvkQjT",
            BigNumber.from(500000)
          )
        ).to.be.rejectedWith("Bitcoin recovery address must be P2PKH or P2WPKH")
      })
    })

    context("when no wallet is eligible for the amount", () => {
      it("should throw when there is no active wallet and no registered wallet", async () => {
        await expect(
          service.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000)
          )
        ).to.be.rejectedWith("No eligible wallet has reservation capacity")
      })
    })

    context(
      "when the active wallet is full and a second Live wallet is free",
      () => {
        beforeEach(() => {
          mockReservations.registeredWallets = [
            makeWalletEvent(ACTIVE_WALLET_PKH),
            makeWalletEvent(WALLET_B_PKH),
          ]
          mockReservations.setWalletState(ACTIVE_WALLET_PKH, WalletState.Live)
          mockReservations.setWalletState(WALLET_B_PKH, WalletState.Live)
          tbtcContracts.bridge.setActiveWalletPublicKey(ACTIVE_WALLET_PK)
          mockBitcoinClient.network = BitcoinNetwork.Testnet
        })

        it("should produce a receipt for the second wallet when the active wallet's amount cap is full", async () => {
          mockReservations.caps.maxAmountPerWallet = BigNumber.from(1000000)
          mockReservations.setWalletReservations(
            ACTIVE_WALLET_PKH,
            0,
            BigNumber.from(1000000)
          )

          const result = await service.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000)
          )

          expect(result.walletPublicKeyHash.equals(WALLET_B_PKH)).to.be.true
          expect(result.receipt.walletPublicKeyHash.equals(WALLET_B_PKH)).to.be
            .true
        })

        it("should produce a receipt for the second wallet when the active wallet's count cap is full", async () => {
          mockReservations.parameters.maxReservationsPerWallet = 1
          mockReservations.setWalletReservations(
            ACTIVE_WALLET_PKH,
            1,
            BigNumber.from(0)
          )

          const result = await service.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000)
          )

          expect(result.walletPublicKeyHash.equals(WALLET_B_PKH)).to.be.true
        })
      }
    )

    context("when the amount exceeds the chosen wallet's room", () => {
      beforeEach(() => {
        mockReservations.registeredWallets = [
          makeWalletEvent(WALLET_A_PKH),
          makeWalletEvent(WALLET_B_PKH),
        ]
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
        mockReservations.setWalletState(WALLET_B_PKH, WalletState.Live)
        mockReservations.caps.maxAmountPerWallet = BigNumber.from(400000)
        mockBitcoinClient.network = BitcoinNetwork.Testnet
      })

      it("should not choose a wallet with less room than the amount, explicitly", async () => {
        await expect(
          service.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000),
            { walletPublicKeyHash: WALLET_A_PKH }
          )
        ).to.be.rejectedWith("wallet-amount-cap-exceeded")
      })

      it("should not choose a wallet with a full count cap, explicitly", async () => {
        mockReservations.parameters.maxReservationsPerWallet = 1
        mockReservations.setWalletReservations(
          WALLET_B_PKH,
          1,
          BigNumber.from(0)
        )

        await expect(
          service.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000),
            { walletPublicKeyHash: WALLET_B_PKH }
          )
        ).to.be.rejectedWith("wallet-count-cap-exceeded")
      })

      it("should not choose a non-Live wallet, explicitly", async () => {
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Closing)

        await expect(
          service.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000),
            { walletPublicKeyHash: WALLET_A_PKH }
          )
        ).to.be.rejectedWith("wallet-not-live")
      })

      it("should throw when no wallet has room for the amount", async () => {
        // Both wallets are full at the 400k cap; 500k fits neither.
        mockReservations.setWalletReservations(
          WALLET_A_PKH,
          0,
          BigNumber.from(400000)
        )
        mockReservations.setWalletReservations(
          WALLET_B_PKH,
          0,
          BigNumber.from(400000)
        )

        await expect(
          service.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000)
          )
        ).to.be.rejectedWith("No eligible wallet has reservation capacity")
      })
    })

    context("when the global active-reservations cap is full", () => {
      beforeEach(() => {
        mockReservations.registeredWallets = [makeWalletEvent(WALLET_A_PKH)]
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
        mockReservations.occupancy = { count: 1000, maxActive: 1000 }
        mockBitcoinClient.network = BitcoinNetwork.Testnet
      })

      it("should throw for the default selection path", async () => {
        await expect(
          service.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000)
          )
        ).to.be.rejectedWith("global-count-cap-exceeded")
      })

      it("should throw for an explicitly chosen wallet", async () => {
        await expect(
          service.initiateReservedDeposit(
            TESTNET_RECOVERY_ADDRESS,
            BigNumber.from(500000),
            { walletPublicKeyHash: WALLET_A_PKH }
          )
        ).to.be.rejectedWith("global-count-cap-exceeded")
      })
    })

    context("when the active wallet is feasible for the amount", () => {
      it("should keep preferring the active wallet", async () => {
        mockReservations.registeredWallets = [
          makeWalletEvent(WALLET_A_PKH),
          makeWalletEvent(ACTIVE_WALLET_PKH),
        ]
        mockReservations.setWalletState(ACTIVE_WALLET_PKH, WalletState.Live)
        mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
        tbtcContracts.bridge.setActiveWalletPublicKey(ACTIVE_WALLET_PK)
        mockBitcoinClient.network = BitcoinNetwork.Testnet

        const result = await service.initiateReservedDeposit(
          TESTNET_RECOVERY_ADDRESS,
          BigNumber.from(500000)
        )

        expect(result.walletPublicKeyHash.equals(ACTIVE_WALLET_PKH)).to.be.true
      })
    })
  })

  describe("requestAcceptance", () => {
    const depositKey = BigNumber.from(1)

    beforeEach(() => {
      mockReservations.addReservedDeposit(depositKey, {
        amount: BigNumber.from(500000),
        walletPublicKeyHash: WALLET_A_PKH,
        isReserved: true,
        revealedAt: Math.floor(Date.now() / 1000) - 3600,
        depositor: TEST_DEPOSITOR,
      })
      mockReservations.setWalletState(WALLET_A_PKH, WalletState.Live)
    })

    it("should submit the acceptance request to the designated wallet", async () => {
      const txHash = await service.requestAcceptance(depositKey, WALLET_A_PKH)

      expect(txHash.toPrefixedString()).to.equal("0xdeadbeef")
      expect(
        mockReservations.requestAcceptanceCalls[0].walletPublicKeyHash.equals(
          WALLET_A_PKH
        )
      ).to.be.true
    })

    it("should preflight-clean for a valid deposit", async () => {
      const result = await service.checkAcceptancePreflight(
        depositKey,
        WALLET_A_PKH
      )

      expect(result.ok).to.be.true
      expect(result.failures).to.have.length(0)
    })

    it("should report not revealed when the deposit has no reveal timestamp", async () => {
      const key = BigNumber.from(2)
      mockReservations.addReservedDeposit(key, {
        amount: BigNumber.from(500000),
        walletPublicKeyHash: WALLET_A_PKH,
        isReserved: false,
        revealedAt: 0,
      })

      const result = await service.checkAcceptancePreflight(key, WALLET_A_PKH)

      expect(result.ok).to.be.false
      expect(result.failures).to.include("deposit is not revealed")
    })

    it("should report an already swept deposit", async () => {
      const key = BigNumber.from(3)
      mockReservations.addReservedDeposit(key, {
        amount: BigNumber.from(500000),
        walletPublicKeyHash: WALLET_A_PKH,
        isReserved: true,
        revealedAt: 1,
        sweptAt: 1,
      })

      const result = await service.checkAcceptancePreflight(key, WALLET_A_PKH)

      expect(result.failures).to.include("deposit was already swept")
    })

    it("should report a deposit that was not revealed as reserved", async () => {
      const key = BigNumber.from(4)
      mockReservations.addReservedDeposit(key, {
        amount: BigNumber.from(500000),
        walletPublicKeyHash: WALLET_A_PKH,
        isReserved: false,
        revealedAt: 1,
      })

      const result = await service.checkAcceptancePreflight(key, WALLET_A_PKH)

      expect(result.failures).to.include("deposit was not revealed as reserved")
    })

    it("should report a deposit with an acceptance request already made", async () => {
      mockReservations.setReservationRecord(depositKey, { requestNonce: 1 })

      const result = await service.checkAcceptancePreflight(
        depositKey,
        WALLET_A_PKH
      )

      expect(result.failures).to.include(
        "an acceptance request was already made for this deposit"
      )
    })

    it("should reject a wallet that is not the deposit's designated wallet", async () => {
      const result = await service.checkAcceptancePreflight(
        depositKey,
        WALLET_B_PKH
      )

      expect(result.failures).to.include(
        "wallet is not the deposit's designated wallet"
      )
    })

    it("should reject a wallet that is not in Live state", async () => {
      mockReservations.setWalletState(WALLET_A_PKH, WalletState.Closing)

      const result = await service.checkAcceptancePreflight(
        depositKey,
        WALLET_A_PKH
      )

      expect(result.failures).to.include("wallet is not in Live state")
    })

    it("should reject a deposit below the reservation minimum", async () => {
      mockReservations.addReservedDeposit(BigNumber.from(5), {
        amount: BigNumber.from(140000),
        walletPublicKeyHash: WALLET_A_PKH,
        isReserved: true,
        revealedAt: 1,
      })

      const result = await service.checkAcceptancePreflight(
        BigNumber.from(5),
        WALLET_A_PKH
      )

      expect(result.failures).to.include(
        "deposit amount is below the reservation minimum"
      )
    })

    it("should reject a deposit that exceeds the single-reservation cap", async () => {
      mockReservations.caps.maxSingleAmount = BigNumber.from(400000)

      const result = await service.checkAcceptancePreflight(
        depositKey,
        WALLET_A_PKH
      )

      expect(result.failures).to.include(
        "deposit exceeds the single-reservation cap"
      )
    })

    it("should reject when the global active-reservations cap would be exceeded", async () => {
      mockReservations.occupancy = { count: 1000, maxActive: 1000 }

      const result = await service.checkAcceptancePreflight(
        depositKey,
        WALLET_A_PKH
      )

      expect(result.failures).to.include(
        "the global active-reservations cap would be exceeded"
      )
    })

    it("should reject when the per-wallet count cap would be exceeded", async () => {
      mockReservations.parameters.maxReservationsPerWallet = 1
      mockReservations.setWalletReservations(WALLET_A_PKH, 1, BigNumber.from(0))

      const result = await service.checkAcceptancePreflight(
        depositKey,
        WALLET_A_PKH
      )

      expect(result.failures).to.include(
        "the per-wallet reservation-count cap would be exceeded"
      )
    })

    it("should reject when the per-wallet amount cap would be exceeded", async () => {
      mockReservations.caps.maxAmountPerWallet = BigNumber.from(400000)
      mockReservations.setWalletReservations(
        WALLET_A_PKH,
        0,
        BigNumber.from(200000)
      )

      const result = await service.checkAcceptancePreflight(
        depositKey,
        WALLET_A_PKH
      )

      expect(result.failures).to.include(
        "the per-wallet reserved-amount cap would be exceeded"
      )
    })

    it("should reject a deposit revealed by a different (proxy) depositor", async () => {
      // A proxy-revealed deposit names the proxy as its depositor; the
      // connected EOA caller cannot later request acceptance for it.
      mockReservations.addReservedDeposit(BigNumber.from(6), {
        amount: BigNumber.from(500000),
        walletPublicKeyHash: WALLET_A_PKH,
        isReserved: true,
        revealedAt: 1,
        depositor: OTHER_ADDRESS,
      })

      const result = await service.checkAcceptancePreflight(
        BigNumber.from(6),
        WALLET_A_PKH
      )

      expect(result.ok).to.be.false
      expect(result.failures).to.include(
        "caller is not the deposit's depositor"
      )
    })
  })

  describe("releaseToPool", () => {
    it("should release to the zero address when no vault is given", async () => {
      const depositKey = BigNumber.from(42)
      const txHash = await service.releaseToPool(depositKey)

      expect(txHash.toPrefixedString()).to.equal("0xfeedface")
      const call = mockReservations.releaseCalls[0]
      expect(call.depositKey.eq(depositKey)).to.be.true
      expect(call.vault.identifierHex).to.equal("0".repeat(40))
    })

    it("should release to the given vault", async () => {
      const target = EthereumAddress.from(
        "0x00000000000000000000000000000000000000f2"
      )

      await service.releaseToPool(BigNumber.from(42), target)

      expect(mockReservations.releaseCalls[0].vault).to.equal(target)
    })
  })

  describe("status reads", () => {
    it("should read the reservation record", async () => {
      const record = await service.reservationRecord(BigNumber.from(1))

      expect(record.requestNonce).to.equal(0)
      expect(record.state).to.equal(0)
    })

    it("should read the reservation action record", async () => {
      const action = await service.reservationAction(BigNumber.from(1), 0)

      expect(action.requestedAt).to.equal(0)
      expect(action.actionType).to.equal(0)
    })

    it("should read the reservation parameters", async () => {
      const params = await service.reservationParameters()

      expect(params.termSeconds).to.equal(SEPOLIA_LIKE.termSeconds)
      expect(params.minAmount.toString()).to.equal("100000")
    })

    it("should read whether a deposit is reserved", async () => {
      mockReservations.addReservedDeposit(BigNumber.from(7), {
        amount: BigNumber.from(500000),
        walletPublicKeyHash: WALLET_A_PKH,
        isReserved: true,
        revealedAt: 1,
      })

      expect(await service.isReservedDeposit(BigNumber.from(7))).to.be.true
      expect(await service.isReservedDeposit(BigNumber.from(8))).to.be.false
    })
  })
})
