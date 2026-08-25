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

  // Bootstrap ordering: `updateReservationParameters` is permissive while
  // caps are pre-launch-zero (both disjuncts in its relational check are
  // trivially satisfied), so a deploy that calls it first can establish
  // an arbitrarily large `reservationMaxTotalAmount`. The natural
  // follow-up `updateReservationCaps` call then reverts: its mirrored
  // check reads the stored oversized total against the new cap product
  // and trips. The safe order is caps first (total defaults to 0, so the
  // mirrored check is `0 <= product`, trivially true), then a total that
  // fits under the resulting product. Once either cap is non-zero, no
  // setter can raise the total past slot capacity.
  describe("bootstrap ordering", () => {
    // Deploy-ordering hazard: parameters first, caps second. The
    // `updateReservationCaps` call reverts because it reads the
    // already-oversized `reservationMaxTotalAmount` against the new cap
    // product. This is the two-sided check working as designed, not a
    // bug — the test pins it as a regression check.
    it("reverts when updateReservationCaps follows an oversized parameters write", async () => {
      expect((await stub.caps()).maxActiveReservations).to.equal(0)
      expect((await stub.caps()).reservationMaxSingleAmount).to.equal(0)

      await setTotalAmount(stub, slotCapacity * 1000)
      expect((await stub.caps()).reservationMaxTotalAmount).to.equal(
        slotCapacity * 1000
      )

      // This is the call that reverts: the mirrored check in
      // `updateReservationCaps` reads the stored 4,000,000,000 total
      // against the new product of 4,000,000 and trips.
      await expect(
        stub.updateReservationCaps(
          maxReservationsAmountPerWallet,
          reservationMaxSingleAmount,
          maxActiveReservations
        )
      ).to.be.revertedWith(CAPACITY_REVERT)
    })

    // Safe order: caps first (passes because `reservationMaxTotalAmount`
    // defaults to 0), then a total within the resulting cap product
    // (passes), then a follow-up attempt to raise past slot capacity
    // (reverts). Proves the safe operational path works end to end.
    it("accepts caps first, then a total within slot capacity", async () => {
      expect((await stub.caps()).reservationMaxTotalAmount).to.equal(0)

      await stub.updateReservationCaps(
        maxReservationsAmountPerWallet,
        reservationMaxSingleAmount,
        maxActiveReservations
      )

      await setTotalAmount(stub, slotCapacity)
      expect((await stub.caps()).reservationMaxTotalAmount).to.equal(
        slotCapacity
      )

      await expect(setTotalAmount(stub, slotCapacity + 1)).to.be.revertedWith(
        CAPACITY_REVERT
      )
    })
  })
})
