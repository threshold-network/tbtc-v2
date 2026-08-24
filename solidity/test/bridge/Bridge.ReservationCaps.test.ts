import { ethers } from "hardhat"
import { expect } from "chai"

import type { Contract } from "ethers"

// `Reservation.MIN_RESERVATION_TERM`.
const MIN_RESERVATION_TERM = 90 * 24 * 60 * 60
// `WalletProposalValidatorConstants.REQUEST_TIMEOUT_SAFETY_MARGIN`.
const REQUEST_TIMEOUT_SAFETY_MARGIN = 2 * 60 * 60

const CAPACITY_REVERT = "Amount cap exceeds slot capacity"

// A baseline that satisfies every unrelated requirement of
// `updateReservationParameters`, so each test varies only the one value it is
// about. `reservationVault` stays zero to match the pristine storage value:
// that keeps the vault-change branch, and its active-reservation guards, out
// of the way.
const baseParams = {
  reservationVault: ethers.constants.AddressZero,
  reservationMinAmount: 100_000,
  reservationTxMaxFee: 10_000,
  reservationTermSeconds: MIN_RESERVATION_TERM,
  reservationDissolutionDelay: 7 * 24 * 60 * 60,
  maxReservationsPerWallet: 10,
  reservationActionTimeout: REQUEST_TIMEOUT_SAFETY_MARGIN + 1,
  reservationRenewalWindowSeconds: 14 * 24 * 60 * 60,
}

async function deployStub(): Promise<Contract> {
  const ReservationProofs = await ethers.getContractFactory("ReservationProofs")
  const reservationProofs = await ReservationProofs.deploy()

  const Reservation = await ethers.getContractFactory("Reservation", {
    libraries: { ReservationProofs: reservationProofs.address },
  })
  const reservation = await Reservation.deploy()

  const Stub = await ethers.getContractFactory("ReservationCapsStub", {
    libraries: { Reservation: reservation.address },
  })

  return Stub.deploy()
}

function setTotalAmount(stub: Contract, reservationMaxTotalAmount: number) {
  return stub.updateReservationParameters(
    baseParams.reservationVault,
    baseParams.reservationMinAmount,
    baseParams.reservationTxMaxFee,
    baseParams.reservationTermSeconds,
    baseParams.reservationDissolutionDelay,
    reservationMaxTotalAmount,
    baseParams.maxReservationsPerWallet,
    baseParams.reservationActionTimeout,
    baseParams.reservationRenewalWindowSeconds
  )
}

describe("Reservation - amount cap versus slot capacity", () => {
  // `maxActiveReservations` bounds open positions and
  // `reservationMaxSingleAmount` bounds any single position, so their product
  // is the most that can ever be reserved at once. 4 * 1_000_000 = 4_000_000.
  const maxActiveReservations = 4
  const reservationMaxSingleAmount = 1_000_000
  const slotCapacity = maxActiveReservations * reservationMaxSingleAmount
  const maxReservationsAmountPerWallet = 10_000_000

  let stub: Contract

  beforeEach(async () => {
    stub = await deployStub()
  })

  describe("updateReservationParameters", () => {
    beforeEach(async () => {
      await stub.updateReservationCaps(
        maxReservationsAmountPerWallet,
        reservationMaxSingleAmount,
        maxActiveReservations
      )
    })

    it("reverts when the total amount cap exceeds slot capacity", async () => {
      await expect(setTotalAmount(stub, slotCapacity + 1)).to.be.revertedWith(
        CAPACITY_REVERT
      )
    })

    it("accepts a total amount cap exactly equal to slot capacity", async () => {
      await setTotalAmount(stub, slotCapacity)

      expect((await stub.caps()).reservationMaxTotalAmount).to.equal(
        slotCapacity
      )
    })
  })

  describe("updateReservationCaps", () => {
    beforeEach(async () => {
      await stub.updateReservationCaps(
        maxReservationsAmountPerWallet,
        reservationMaxSingleAmount,
        maxActiveReservations
      )
      await setTotalAmount(stub, slotCapacity)
    })

    it("reverts when lowering the position cap below the standing total", async () => {
      await expect(
        stub.updateReservationCaps(
          maxReservationsAmountPerWallet,
          reservationMaxSingleAmount,
          maxActiveReservations - 1
        )
      ).to.be.revertedWith(CAPACITY_REVERT)
    })

    it("reverts when lowering the single-position cap below the standing total", async () => {
      await expect(
        stub.updateReservationCaps(
          maxReservationsAmountPerWallet,
          reservationMaxSingleAmount / 2,
          maxActiveReservations
        )
      ).to.be.revertedWith(CAPACITY_REVERT)
    })
  })

  // Either cap set to zero means that cap is disabled, so there is no
  // slot-capacity ceiling to violate and the relational check must be skipped
  // entirely. Without these branches a bare product would compare against
  // zero and reject every nonzero total in a fully supported configuration.
  describe("when a cap is disabled with zero", () => {
    it("accepts any total amount while the single-position cap is disabled", async () => {
      await stub.updateReservationCaps(
        maxReservationsAmountPerWallet,
        0,
        maxActiveReservations
      )

      await setTotalAmount(stub, slotCapacity * 1000)

      expect((await stub.caps()).reservationMaxTotalAmount).to.equal(
        slotCapacity * 1000
      )
    })

    it("accepts any total amount before the position cap is ever set", async () => {
      // Pristine pre-launch storage: `updateReservationCaps` has not run, so
      // `maxActiveReservations` is still zero. It cannot be set back to zero
      // afterwards, which is why this is the pre-launch state and not a
      // reachable post-launch one.
      expect((await stub.caps()).maxActiveReservations).to.equal(0)

      await setTotalAmount(stub, slotCapacity * 1000)

      expect((await stub.caps()).reservationMaxTotalAmount).to.equal(
        slotCapacity * 1000
      )
    })
  })

  // Bootstrap ordering: a launch that wants a non-trivial
  // `reservationMaxTotalAmount` must call `updateReservationCaps` first
  // (since the parameters setter is permissive when caps are still
  // pre-launch-zero). Once caps are set, any later call to
  // `updateReservationParameters` raising the total past slot capacity
  // reverts. Without this ordering, nothing on-chain keeps the totals
  // honest: there is no path from "caps configured" back to "total
  // amount > slot capacity".
  describe("bootstrap ordering", () => {
    it("requires caps to be set before a large reservationMaxTotalAmount sticks", async () => {
      // Pre-launch state: pristine stub, no caps setter has ever run.
      expect((await stub.caps()).maxActiveReservations).to.equal(0)
      expect((await stub.caps()).reservationMaxSingleAmount).to.equal(0)

      // A launch-time `updateReservationParameters` call can establish a
      // large total because both disjuncts in the relational check are
      // still zero. This is the only window where a total can sit above
      // slot capacity.
      await setTotalAmount(stub, slotCapacity * 1000)
      expect((await stub.caps()).reservationMaxTotalAmount).to.equal(
        slotCapacity * 1000
      )

      // Once caps are configured, any later attempt to raise the total
      // past slot capacity reverts. The state set in the prior step
      // cannot go any higher after this point.
      await stub.updateReservationCaps(
        maxReservationsAmountPerWallet,
        reservationMaxSingleAmount,
        maxActiveReservations
      )

      await expect(
        setTotalAmount(stub, slotCapacity * 1000 + 1)
      ).to.be.revertedWith(CAPACITY_REVERT)
    })
  })
})
