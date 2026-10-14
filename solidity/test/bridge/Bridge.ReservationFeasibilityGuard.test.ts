import { ethers } from "hardhat"
import { expect } from "chai"

import type { TestReservation } from "../../typechain"

// `Reservation` bounds and `WalletProposalValidatorConstants` values,
// pinned here exactly as in `Bridge.ReservationCaps.test.ts`.
const MIN_RESERVATION_TERM = 90 * 24 * 60 * 60 // `Reservation.MIN_RESERVATION_TERM`
// `WalletProposalValidatorConstants.DEPOSIT_REFUND_SAFETY_MARGIN`.
const DEPOSIT_REFUND_SAFETY_MARGIN = 24 * 60 * 60
// `WalletProposalValidatorConstants.REQUEST_TIMEOUT_SAFETY_MARGIN`.
const REQUEST_TIMEOUT_SAFETY_MARGIN = 2 * 60 * 60
// `WalletProposalValidatorConstants.DEPOSIT_MIN_AGE`.
const DEPOSIT_MIN_AGE = 2 * 60 * 60
// Last reveal-ahead period that still leaves a signing window under the
// minimum term: `MIN_RESERVATION_TERM + DEPOSIT_REFUND_SAFETY_MARGIN`.
const MAX_FEASIBLE_REVEAL_AHEAD =
  MIN_RESERVATION_TERM + DEPOSIT_REFUND_SAFETY_MARGIN

const DUST = 1_000_000 // satoshi, fixture `depositDustThreshold`
const REVEAL_AHEAD = 1_296_000 // 15 days, fixture `depositRevealAheadPeriod`
const DEPOSIT_TREASURY_FEE_DIVISOR = 2000
const DEPOSIT_TX_MAX_FEE = 100_000

const REVEAL_REVERT = "Reveal ahead period leaves no reserved deposit possible"
const SINGLE_CAP_REVERT = "Single-reservation cap below dust threshold"
const PER_WALLET_CAP_REVERT = "Per-wallet reservation cap below dust threshold"
const TOTAL_CAP_REVERT = "Total reservation cap below dust threshold"

const VAULT = `0x${"11".repeat(20)}` as `0x${string}`

// Values that satisfy every unrelated requirement of
// `Reservation.updateReservationParameters`, so each test varies only the
// feasibility-related values.
const params = {
  reservationMinAmount: 200_000,
  reservationTxMaxFee: 100_000,
  reservationTermSeconds: MIN_RESERVATION_TERM,
  reservationDissolutionDelay: 7 * 24 * 60 * 60,
  // = 4 * 1_000_000, exactly the slot capacity of the caps below.
  reservationMaxTotalAmount: 4_000_000,
  maxReservationsPerWallet: 10,
  reservationActionTimeout:
    REQUEST_TIMEOUT_SAFETY_MARGIN + DEPOSIT_MIN_AGE + 2,
  reservationRenewalWindowSeconds: 14 * 24 * 60 * 60,
}

// Feasible caps: every non-zero amount cap at or above the dust threshold.
const caps = {
  maxReservationsAmountPerWallet: 2_000_000,
  reservationMaxSingleAmount: 1_000_000,
  maxActiveReservations: 4,
  maxThirdPartyReanchorHoldsPerWallet: 1,
  handoffReserveWallets: 1,
}

async function deployTestReservation(): Promise<TestReservation> {
  const ReservationProofs = await ethers.getContractFactory("ReservationProofs")
  const reservationProofs = await ReservationProofs.deploy()

  const Reservation = await ethers.getContractFactory("Reservation")
  const reservation = await Reservation.deploy()

  const TestReservationFactory = await ethers.getContractFactory(
    "TestReservation",
    { libraries: { Reservation: reservation.target } }
  )

  return TestReservationFactory.deploy()
}

function updateDepositParameters(
  testReservation: TestReservation,
  depositDustThreshold: number,
  depositRevealAheadPeriod: number
) {
  return testReservation.updateDepositParameters(
    depositDustThreshold,
    DEPOSIT_TREASURY_FEE_DIVISOR,
    DEPOSIT_TX_MAX_FEE,
    depositRevealAheadPeriod
  )
}

async function updateReservationParameters(
  testReservation: TestReservation,
  overrides: Partial<typeof params> & { reservationVault?: string } = {}
) {
  const p = { ...params, ...overrides }
  // Preserve the current vault so follow-up writes in a configured state
  // stay gated; only an explicit `reservationVault` override enables or
  // disables the vault.
  const [currentVault] = await testReservation.reservationVaultAndTerm()
  return testReservation.updateReservationParameters(
    p.reservationVault ?? currentVault,
    p.reservationMinAmount,
    p.reservationTxMaxFee,
    p.reservationTermSeconds,
    p.reservationDissolutionDelay,
    p.reservationMaxTotalAmount,
    p.maxReservationsPerWallet,
    p.reservationActionTimeout,
    p.reservationRenewalWindowSeconds
  )
}

function updateReservationCaps(
  testReservation: TestReservation,
  overrides: Partial<typeof caps> = {}
) {
  const c = { ...caps, ...overrides }
  return testReservation.updateReservationCaps(
    c.maxReservationsAmountPerWallet,
    c.reservationMaxSingleAmount,
    c.maxActiveReservations,
    c.maxThirdPartyReanchorHoldsPerWallet,
    c.handoffReserveWallets
  )
}

// Full configuration in the deploy-ordering order: deposit parameters, caps
// first, then the parameters write that enables the reservation vault.
async function enableReservations(testReservation: TestReservation) {
  await updateDepositParameters(testReservation, DUST, REVEAL_AHEAD)
  await updateReservationCaps(testReservation)
  await updateReservationParameters(testReservation, {
    reservationVault: VAULT,
  })
}

describe("Bridge - reservation feasibility guard", () => {
  let testReservation: TestReservation

  beforeEach(async () => {
    testReservation = await deployTestReservation()
  })

  describe("bootstrap, reservations not yet configured", () => {
    it("accepts infeasible deposit values and caps while the vault is off", async () => {
      // Reveal-ahead period far beyond the term plus margin and caps far
      // below it must not trip anything while the vault is unconfigured:
      // the guard is gated on the reservation vault.
      await updateDepositParameters(testReservation, DUST, 9_000_000)
      await updateReservationCaps(testReservation, {
        reservationMaxSingleAmount: 500_000,
      })

      const [, , maxActive] = await testReservation.reservationCaps()
      expect(maxActive).to.equal(caps.maxActiveReservations)
      const [vault] = await testReservation.reservationVaultAndTerm()
      expect(vault).to.equal(ethers.ZeroAddress)
    })

    it("completes the caps-first bootstrap into a feasible state", async () => {
      await updateDepositParameters(testReservation, DUST, REVEAL_AHEAD)
      await updateReservationCaps(testReservation)
      await updateReservationParameters(testReservation, {
        reservationVault: VAULT,
      })

      const [vault, term] = await testReservation.reservationVaultAndTerm()
      expect(vault).to.equal(VAULT)
      expect(term).to.equal(MIN_RESERVATION_TERM)
      const [dust, revealAhead] = await testReservation.depositParameters()
      expect(dust).to.equal(DUST)
      expect(revealAhead).to.equal(REVEAL_AHEAD)
    })
  })

  describe("updateReservationParameters, reservations configured", () => {
    beforeEach(async () => {
      await enableReservations(testReservation)
    })

    it("reverts when the new term leaves no reveal window", async () => {
      // The break must be staged while the vault is off: the deposit setter
      // is itself guarded, so the only way to land a period the minimum term
      // cannot absorb is before the vault is enabled.
      const fresh = await deployTestReservation()
      await updateDepositParameters(fresh, DUST, MAX_FEASIBLE_REVEAL_AHEAD + 1)
      await updateReservationCaps(fresh)
      await expect(
        updateReservationParameters(fresh, { reservationVault: VAULT })
      ).to.be.revertedWith(REVEAL_REVERT)

      // One second shorter the window holds and the same call succeeds.
      const feasible = await deployTestReservation()
      await updateDepositParameters(feasible, DUST, MAX_FEASIBLE_REVEAL_AHEAD)
      await updateReservationCaps(feasible)
      await updateReservationParameters(feasible, {
        reservationVault: VAULT,
      })
      const [vault] = await feasible.reservationVaultAndTerm()
      expect(vault).to.equal(VAULT)
    })

    it("reverts when the new total amount cap drops below the dust threshold", async () => {
      await expect(
        updateReservationParameters(testReservation, {
          reservationMaxTotalAmount: DUST - 1,
        })
      ).to.be.revertedWith(TOTAL_CAP_REVERT)

      // Exactly at the dust threshold the cap is still reachable.
      await updateReservationParameters(testReservation, {
        reservationMaxTotalAmount: DUST,
      })
      const [total] = await testReservation.caps()
      expect(total).to.equal(DUST)
    })

    it("accepts every feasible parameter update", async () => {
      await updateReservationParameters(testReservation, {
        reservationTermSeconds: 180 * 24 * 60 * 60,
        reservationMaxTotalAmount: 2_000_000,
      })

      const [, term] = await testReservation.reservationVaultAndTerm()
      expect(term).to.equal(180 * 24 * 60 * 60)
      const [total] = await testReservation.caps()
      expect(total).to.equal(2_000_000)
    })

    it("leaves disabling the vault exempt from the guard", async () => {
      await updateReservationParameters(testReservation, {
        reservationVault: ethers.ZeroAddress,
        reservationMaxTotalAmount: DUST - 1, // would trip the cap check
      })

      const [vault] = await testReservation.reservationVaultAndTerm()
      expect(vault).to.equal(ethers.ZeroAddress)
    })
  })

  describe("updateReservationCaps, reservations configured", () => {
    beforeEach(async () => {
      await enableReservations(testReservation)
    })

    it("reverts when the new single-amount cap drops below the dust threshold", async () => {
      // Keep the slot-capacity invariant from tripping first: lower the
      // stored total to the dust threshold so
      // `total <= maxActive * newSingle` still holds with a too-small cap.
      await updateReservationParameters(testReservation, {
        reservationMaxTotalAmount: DUST,
      })
      await expect(
        updateReservationCaps(testReservation, {
          reservationMaxSingleAmount: DUST - 1,
        })
      ).to.be.revertedWith(SINGLE_CAP_REVERT)
    })

    it("reverts when the new per-wallet amount cap drops below the dust threshold", async () => {
      await expect(
        updateReservationCaps(testReservation, {
          maxReservationsAmountPerWallet: DUST - 1,
        })
      ).to.be.revertedWith(PER_WALLET_CAP_REVERT)

      // Zero disables the cap entirely and stays permitted.
      await updateReservationCaps(testReservation, {
        maxReservationsAmountPerWallet: 0,
      })
      const [perWallet] = await testReservation.reservationCaps()
      expect(perWallet).to.equal(0)
    })

    it("accepts every feasible cap update", async () => {
      await updateReservationCaps(testReservation, {
        reservationMaxSingleAmount: DUST + 1,
        maxReservationsAmountPerWallet: DUST + 2,
      })

      const [perWallet, single] = await testReservation.reservationCaps()
      expect(perWallet).to.equal(DUST + 2)
      expect(single).to.equal(DUST + 1)
    })
  })

  describe("updateDepositParameters, reservations configured", () => {
    beforeEach(async () => {
      await enableReservations(testReservation)
    })

    it("reverts when the new dust threshold exceeds the single-amount cap", async () => {
      await expect(
        updateDepositParameters(
          testReservation,
          caps.reservationMaxSingleAmount + 1,
          REVEAL_AHEAD
        )
      ).to.be.revertedWith(SINGLE_CAP_REVERT)
    })

    it("reverts when the new dust threshold exceeds the per-wallet cap", async () => {
      // Push both amount caps strictly above the new dust threshold so
      // the single-amount disjunct no longer trips, isolating the
      // per-wallet disjunct of the guard.
      await updateReservationCaps(testReservation, {
        reservationMaxSingleAmount: DUST + 1000,
        maxReservationsAmountPerWallet: DUST + 500,
      })
      await expect(
        updateDepositParameters(testReservation, DUST + 600, REVEAL_AHEAD)
      ).to.be.revertedWith(PER_WALLET_CAP_REVERT)
    })

    it("reverts when the new dust threshold exceeds the total cap", async () => {
      // Isolate the total disjunct: both amount caps strictly above the
      // new dust threshold, only the stored total below it.
      await updateReservationCaps(testReservation, {
        reservationMaxSingleAmount: DUST + 1000,
        maxReservationsAmountPerWallet: DUST + 1000,
      })
      await updateReservationParameters(testReservation, {
        reservationMaxTotalAmount: DUST + 500,
      })
      await expect(
        updateDepositParameters(testReservation, DUST + 600, REVEAL_AHEAD)
      ).to.be.revertedWith(TOTAL_CAP_REVERT)
    })

    it("reverts when the new reveal-ahead period exceeds the term plus margin", async () => {
      await expect(
        updateDepositParameters(
          testReservation,
          DUST,
          MAX_FEASIBLE_REVEAL_AHEAD + 1
        )
      ).to.be.revertedWith(REVEAL_REVERT)

      // Exactly at the boundary the window still holds.
      await updateDepositParameters(
        testReservation,
        DUST,
        MAX_FEASIBLE_REVEAL_AHEAD
      )
      const [, revealAhead] = await testReservation.depositParameters()
      expect(revealAhead).to.equal(MAX_FEASIBLE_REVEAL_AHEAD)
    })

    it("accepts every feasible deposit parameter update", async () => {
      await updateDepositParameters(testReservation, DUST, 3_000_000)

      const [dust, revealAhead] = await testReservation.depositParameters()
      expect(dust).to.equal(DUST)
      expect(revealAhead).to.equal(3_000_000)
    })
  })
})
