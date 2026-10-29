import { ethers, helpers } from "hardhat"
import { expect } from "chai"

import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import type {
  Bridge,
  BridgeGovernance,
  ReservationRouter,
  TestReservation,
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
  reservationVault: ethers.ZeroAddress,
  reservationMinAmount: 100_000,
  reservationTxMaxFee: 10_000,
  reservationTermSeconds: MIN_RESERVATION_TERM,
  reservationDissolutionDelay: 7 * 24 * 60 * 60,
  maxReservationsPerWallet: 10,
  // Smallest value the action-timeout floor admits
  // (REQUEST_TIMEOUT_SAFETY_MARGIN + DEPOSIT_MIN_AGE + 2).
  reservationActionTimeout: 2 * REQUEST_TIMEOUT_SAFETY_MARGIN + 2,
  reservationRenewalWindowSeconds: 14 * 24 * 60 * 60,
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

function setTotalAmount(
  testReservation: TestReservation,
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
  const maxThirdPartyReanchorHoldsPerWallet = 1

  let testReservation: TestReservation

  beforeEach(async () => {
    testReservation = await deployTestReservation()
  })

  describe("updateReservationParameters", () => {
    beforeEach(async () => {
      await testReservation.updateReservationCaps(
        maxReservationsAmountPerWallet,
        reservationMaxSingleAmount,
        maxActiveReservations,
        maxThirdPartyReanchorHoldsPerWallet,
        1
      )
    })

    describe("action timeout floor", () => {
      async function setActionTimeout(timeout: number) {
        return testReservation.updateReservationParameters(
          baseParams.reservationVault,
          baseParams.reservationMinAmount,
          baseParams.reservationTxMaxFee,
          baseParams.reservationTermSeconds,
          baseParams.reservationDissolutionDelay,
          slotCapacity,
          baseParams.maxReservationsPerWallet,
          timeout,
          baseParams.reservationRenewalWindowSeconds
        )
      }

      const NO_WINDOW_REVERT =
        "Reservation action timeout leaves no signing window"

      it("reverts at the old floor, safety margin + 1", async () => {
        await expect(
          setActionTimeout(REQUEST_TIMEOUT_SAFETY_MARGIN + 1)
        ).to.be.revertedWith(NO_WINDOW_REVERT)
      })

      it("reverts at safety margin + deposit min age + 1", async () => {
        await expect(
          setActionTimeout(REQUEST_TIMEOUT_SAFETY_MARGIN + 2 * 60 * 60 + 1)
        ).to.be.revertedWith(NO_WINDOW_REVERT)
      })

      it("accepts safety margin + deposit min age + 2, leaving one signing second for a same-block reveal", async () => {
        await setActionTimeout(REQUEST_TIMEOUT_SAFETY_MARGIN + 2 * 60 * 60 + 2)
      })
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

    // Every governance write of `updateReservationParameters` is one
    // misconfiguration away from terms no position can be opened under.
    // Each case varies exactly one field of the admissible baseline.
    describe("parameter validation matrix", () => {
      const otherVault = "0x1111111111111111111111111111111111111111"

      function setParams(overrides: Partial<typeof baseParams> = {}) {
        const params = { ...baseParams, ...overrides }

        return testReservation.updateReservationParameters(
          params.reservationVault,
          params.reservationMinAmount,
          params.reservationTxMaxFee,
          params.reservationTermSeconds,
          params.reservationDissolutionDelay,
          slotCapacity,
          params.maxReservationsPerWallet,
          params.reservationActionTimeout,
          params.reservationRenewalWindowSeconds
        )
      }

      it("rejects a zero transaction fee bound", async () => {
        await expect(setParams({ reservationTxMaxFee: 0 })).to.be.revertedWith(
          "Reservation transaction max fee must be greater than zero"
        )
      })

      it("rejects a minimum amount that does not clear the fee bound", async () => {
        await expect(
          setParams({ reservationMinAmount: baseParams.reservationTxMaxFee })
        ).to.be.revertedWith(
          "Reservation minimum amount must be greater than the reservation TX max fee"
        )
      })

      it("rejects a term below the protocol floor", async () => {
        await expect(
          setParams({ reservationTermSeconds: MIN_RESERVATION_TERM - 1 })
        ).to.be.revertedWith("Reservation term out of protocol bounds")
      })

      it("rejects a renewal window as long as the term", async () => {
        await expect(
          setParams({
            reservationRenewalWindowSeconds: baseParams.reservationTermSeconds,
          })
        ).to.be.revertedWith("Renewal window must be shorter than the term")
      })

      it("rejects a per-wallet position cap of zero", async () => {
        await expect(
          setParams({ maxReservationsPerWallet: 0 })
        ).to.be.revertedWith(
          "Max reservations per wallet must be greater than zero"
        )
      })

      it("rejects pointing the vault at a configuration with no position cap", async () => {
        await testReservation.setMaxActiveReservations(0)

        await expect(
          setParams({ reservationVault: otherVault })
        ).to.be.revertedWith(
          "Max active reservations must be greater than zero"
        )
      })

      it("rejects switching the vault while positions are open", async () => {
        // One open position makes `reservationTotalAmount` non-zero.
        await testReservation.setReservationTotalAmount(1000)

        await expect(
          setParams({ reservationVault: otherVault })
        ).to.be.revertedWith("Active reservations exist")

        expect(await testReservation.reservationTotalAmount()).to.equal(1000)
      })
    })
  })

  describe("updateReservationCaps", () => {
    beforeEach(async () => {
      await testReservation.updateReservationCaps(
        maxReservationsAmountPerWallet,
        reservationMaxSingleAmount,
        maxActiveReservations,
        maxThirdPartyReanchorHoldsPerWallet,
        1
      )
      await setTotalAmount(testReservation, slotCapacity)
    })

    it("reverts when lowering the position cap below the standing total", async () => {
      await expect(
        testReservation.updateReservationCaps(
          maxReservationsAmountPerWallet,
          reservationMaxSingleAmount,
          maxActiveReservations - 1,
          maxThirdPartyReanchorHoldsPerWallet,
          1
        )
      ).to.be.revertedWith(CAPACITY_REVERT)
    })

    it("reverts when lowering the single-position cap below the standing total", async () => {
      await expect(
        testReservation.updateReservationCaps(
          maxReservationsAmountPerWallet,
          reservationMaxSingleAmount / 2,
          maxActiveReservations,
          maxThirdPartyReanchorHoldsPerWallet,
          1
        )
      ).to.be.revertedWith(CAPACITY_REVERT)
    })
  })
  describe("ReservationCapsUpdated event and launch-gate revert", () => {
    it("emits ReservationCapsUpdated event with all three args", async () => {
      const a = 1_000_000
      const b = 100_000
      const c = 5
      await expect(testReservation.updateReservationCaps(a, b, c, 1, 1))
        .to.emit(testReservation, "ReservationCapsUpdated")
        .withArgs(a, b, c, 1, 1)
    })

    it("reverts when maxActiveReservations is set to zero", async () => {
      await expect(
        testReservation.updateReservationCaps(0, 0, 0, 0, 0)
      ).to.be.revertedWith("Active reservations cap must be greater than zero")
    })

    it("reverts when the hand-off reserve is set to zero", async () => {
      await expect(
        testReservation.updateReservationCaps(10_000_000, 1_000_000, 5, 1, 0)
      ).to.be.revertedWith("Hand-off reserve must be greater than zero")
    })

    it("returns all three caps via reservationCaps() after updateReservationCaps (round-trip)", async () => {
      const a = 10_000_000
      const b = 1_000_000
      const c = 5

      await testReservation.updateReservationCaps(a, b, c, 1, 1)

      const caps = await testReservation.reservationCaps()
      expect(caps.maxReservationsAmountPerWallet).to.equal(a)
      expect(caps.reservationMaxSingleAmount).to.equal(b)
      expect(caps.maxActiveReservations).to.equal(c)
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
        maxActiveReservations,
        maxThirdPartyReanchorHoldsPerWallet,
        1
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
          maxActiveReservations,
          maxThirdPartyReanchorHoldsPerWallet,
          1
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
        maxActiveReservations,
        maxThirdPartyReanchorHoldsPerWallet,
        1
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
  let governance: HardhatEthersSigner
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
      bridge.target
    )
  })

  describe("finalizeReservationCapsUpdate", () => {
    // Chosen so the product stays above the `reservationMaxTotalAmount`
    // already set by the deploy-time governance ceremony
    // (`97_set_reservation_parameters.ts`), so finalizing does not trip
    // `Reservation.validateReservationCapsInvariant`, and every cap is at
    // least the Bridge's 1,000,000-sat dust threshold, which the Bridge
    // requires while a vault is configured. All values differ, so a field
    // written to the wrong slot fails the assertions.
    const newMaxReservationsAmountPerWallet = 2_500_000
    const newReservationMaxSingleAmount = 1_500_000
    const newMaxActiveReservations = 200
    const newMaxThirdPartyReanchorHoldsPerWallet = 3
    const newHandoffReserveWallets = 1

    before(async () => {
      await bridgeGovernance
        .connect(governance)
        .beginReservationCapsUpdate(
          newMaxReservationsAmountPerWallet,
          newReservationMaxSingleAmount,
          newMaxActiveReservations,
          newMaxThirdPartyReanchorHoldsPerWallet,
          newHandoffReserveWallets
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
      expect(
        caps.maxThirdPartyReanchorHoldsPerWallet,
        "maxThirdPartyReanchorHoldsPerWallet"
      ).to.equal(newMaxThirdPartyReanchorHoldsPerWallet)
      expect(
        await reservationRouter.reservationHandoffReserveWallets(),
        "handoffReserveWallets"
      ).to.equal(newHandoffReserveWallets)
    })
    it("reads every reservation cap and the hand-off reserve back from the router", async () => {
      const caps = await reservationRouter.reservationCaps()
      expect(
        caps.maxReservationsAmountPerWallet,
        "maxReservationsAmountPerWallet"
      ).to.equal(newMaxReservationsAmountPerWallet)
      expect(
        caps.reservationMaxSingleAmount,
        "reservationMaxSingleAmount"
      ).to.equal(newReservationMaxSingleAmount)
      expect(caps.maxActiveReservations, "maxActiveReservations").to.equal(
        newMaxActiveReservations
      )
      expect(
        caps.maxThirdPartyReanchorHoldsPerWallet,
        "maxThirdPartyReanchorHoldsPerWallet"
      ).to.equal(newMaxThirdPartyReanchorHoldsPerWallet)
      expect(
        await reservationRouter.reservationHandoffReserveWallets(),
        "handoffReserveWallets"
      ).to.equal(newHandoffReserveWallets)
    })

    it("reports the router address the Bridge delegates to", async () => {
      const routerContract =
        await helpers.contracts.getContract("ReservationRouter")
      expect(await reservationRouter.reservationRouter()).to.equal(
        routerContract.target
      )
    })
  })
})
