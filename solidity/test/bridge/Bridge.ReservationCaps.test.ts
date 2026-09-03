import { ethers, helpers } from "hardhat"
import { expect } from "chai"

import type { Contract } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  Bridge,
  BridgeGovernance,
  ReservationRouter,
} from "../../typechain"
import { constants } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"

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

async function deployTestReservation(): Promise<Contract> {
  const ReservationProofs = await ethers.getContractFactory("ReservationProofs")
  const reservationProofs = await ReservationProofs.deploy()

  const Reservation = await ethers.getContractFactory("Reservation")
  const reservation = await Reservation.deploy()

  const TestReservationFactory = await ethers.getContractFactory(
    "TestReservation",
    { libraries: { Reservation: reservation.address } }
  )

  return TestReservationFactory.deploy()
}

function setTotalAmount(
  testReservation: Contract,
  reservationMaxTotalAmount: number
) {
  return testReservation.updateReservationParameters(
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

  let testReservation: Contract

  beforeEach(async () => {
    testReservation = await deployTestReservation()
  })

  describe("updateReservationParameters", () => {
    beforeEach(async () => {
      await testReservation.updateReservationCaps(
        maxReservationsAmountPerWallet,
        reservationMaxSingleAmount,
        maxActiveReservations
      )
    })

    it("reverts when the total amount cap exceeds slot capacity", async () => {
      await expect(
        setTotalAmount(testReservation, slotCapacity + 1)
      ).to.be.revertedWith(CAPACITY_REVERT)
    })

    it("accepts a total amount cap exactly equal to slot capacity", async () => {
      await setTotalAmount(testReservation, slotCapacity)

      expect((await testReservation.caps()).reservationMaxTotalAmount).to.equal(
        slotCapacity
      )
    })
  })

  describe("updateReservationCaps", () => {
    beforeEach(async () => {
      await testReservation.updateReservationCaps(
        maxReservationsAmountPerWallet,
        reservationMaxSingleAmount,
        maxActiveReservations
      )
      await setTotalAmount(testReservation, slotCapacity)
    })

    it("reverts when lowering the position cap below the standing total", async () => {
      await expect(
        testReservation.updateReservationCaps(
          maxReservationsAmountPerWallet,
          reservationMaxSingleAmount,
          maxActiveReservations - 1
        )
      ).to.be.revertedWith(CAPACITY_REVERT)
    })

    it("reverts when lowering the single-position cap below the standing total", async () => {
      await expect(
        testReservation.updateReservationCaps(
          maxReservationsAmountPerWallet,
          reservationMaxSingleAmount / 2,
          maxActiveReservations
        )
      ).to.be.revertedWith(CAPACITY_REVERT)
    })
  })
  describe("ReservationCapsUpdated event and launch-gate revert", () => {
    it("emits ReservationCapsUpdated event with all three args", async () => {
      const a = 1_000_000
      const b = 100_000
      const c = 5
      await expect(testReservation.updateReservationCaps(a, b, c))
        .to.emit(testReservation, "ReservationCapsUpdated")
        .withArgs(a, b, c)
    })

    it("reverts when maxActiveReservations is set to zero", async () => {
      await expect(
        testReservation.updateReservationCaps(0, 0, 0)
      ).to.be.revertedWith("Active reservations cap must be greater than zero")
    })
  })

  // Either cap set to zero means that cap is disabled, so there is no
  // slot-capacity ceiling to violate and the relational check must be skipped
  // entirely. Without these branches a bare product would compare against
  // zero and reject every nonzero total in a fully supported configuration.
  describe("when a cap is disabled with zero", () => {
    it("accepts any total amount while the single-position cap is disabled", async () => {
      await testReservation.updateReservationCaps(
        maxReservationsAmountPerWallet,
        0,
        maxActiveReservations
      )

      await setTotalAmount(testReservation, slotCapacity * 1000)

      expect((await testReservation.caps()).reservationMaxTotalAmount).to.equal(
        slotCapacity * 1000
      )
    })

    it("accepts any total amount before the position cap is ever set", async () => {
      // Pristine pre-launch storage: `updateReservationCaps` has not run, so
      // `maxActiveReservations` is still zero. It cannot be set back to zero
      // afterwards, which is why this is the pre-launch state and not a
      // reachable post-launch one.
      expect((await testReservation.caps()).maxActiveReservations).to.equal(0)

      await setTotalAmount(testReservation, slotCapacity * 1000)

      expect((await testReservation.caps()).reservationMaxTotalAmount).to.equal(
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
      expect((await testReservation.caps()).maxActiveReservations).to.equal(0)
      expect(
        (await testReservation.caps()).reservationMaxSingleAmount
      ).to.equal(0)

      await setTotalAmount(testReservation, slotCapacity * 1000)
      expect((await testReservation.caps()).reservationMaxTotalAmount).to.equal(
        slotCapacity * 1000
      )

      // This is the call that reverts: the mirrored check in
      // `updateReservationCaps` reads the stored 4,000,000,000 total
      // against the new product of 4,000,000 and trips.
      await expect(
        testReservation.updateReservationCaps(
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
      expect((await testReservation.caps()).reservationMaxTotalAmount).to.equal(
        0
      )

      await testReservation.updateReservationCaps(
        maxReservationsAmountPerWallet,
        reservationMaxSingleAmount,
        maxActiveReservations
      )

      await setTotalAmount(testReservation, slotCapacity)
      expect((await testReservation.caps()).reservationMaxTotalAmount).to.equal(
        slotCapacity
      )

      await expect(
        setTotalAmount(testReservation, slotCapacity + 1)
      ).to.be.revertedWith(CAPACITY_REVERT)
    })
  })
})

// Everything above drives the raw `Reservation` library layer directly
// through the `TestReservation` harness, bypassing `BridgeGovernance`
// entirely. That leaves the governance ceremony's own argument forwarding
// unverified: `BridgeGovernance.finalizeReservationCapsUpdate` reads the
// staged `ReservationCapsData` and forwards its three fields, by position,
// to `IReservationBridge.updateReservationCaps`. A transposition bug in
// that forwarding (e.g. swapping two staged fields) would pass every test
// above undetected, since none of them go through `BridgeGovernance`.
describe("Reservation - governance ceremony argument forwarding", () => {
  let governance: SignerWithAddress
  let bridge: Bridge
  let bridgeGovernance: BridgeGovernance
  let reservationRouter: ReservationRouter

  before(async () => {
    const fixture = await bridgeFixture()
    governance = fixture.governance
    bridge = fixture.bridge
    bridgeGovernance = fixture.bridgeGovernance

    // Attach the router ABI to the Bridge's own address: reservation-router
    // calls reach the Bridge's fallback and execute via `delegatecall` on
    // Bridge storage, exactly like the production caller path.
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.address
    )
  })

  describe("finalizeReservationCapsUpdate", () => {
    // Chosen so the product stays above the `reservationMaxTotalAmount`
    // already set by the deploy-time governance ceremony
    // (`97_set_reservation_parameters.ts`), so finalizing does not trip
    // `Reservation.validateReservationCapsInvariant`.
    const newMaxReservationsAmountPerWallet = 2_000_000
    const newReservationMaxSingleAmount = 100_000
    const newMaxActiveReservations = 200

    before(async () => {
      await bridgeGovernance
        .connect(governance)
        .beginReservationCapsUpdate(
          newMaxReservationsAmountPerWallet,
          newReservationMaxSingleAmount,
          newMaxActiveReservations
        )

      await helpers.time.increaseTime(constants.governanceDelay)

      await bridgeGovernance.connect(governance).finalizeReservationCapsUpdate()
    })

    it("forwards each staged field to its own on-chain slot, not a transposed one", async () => {
      const caps = await reservationRouter.reservationCaps()
      expect(
        caps.maxReservationsAmountPerWallet,
        "maxReservationsAmountPerWallet"
      ).to.equal(newMaxReservationsAmountPerWallet)
      expect(
        caps.reservationMaxSingleAmount,
        "reservationMaxSingleAmount"
      ).to.equal(newReservationMaxSingleAmount)

      const { maxActive } = await reservationRouter.activeReservationsCount()
      expect(maxActive, "maxActiveReservations").to.equal(
        newMaxActiveReservations
      )
    })
  })
})
