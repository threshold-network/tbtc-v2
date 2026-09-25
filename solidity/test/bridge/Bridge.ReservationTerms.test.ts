import { ethers, helpers } from "hardhat"
import { expect } from "chai"

import type { Contract } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  Bridge,
  BridgeStub,
  ReservationRouter,
  TestReservationTermTable,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const DAY = 24 * 60 * 60

// `Reservation.MIN_RESERVATION_TERM` / `MAX_RESERVATION_TERM`.
const MIN_RESERVATION_TERM = 30 * DAY
const MAX_RESERVATION_TERM = 730 * DAY
// `Reservation.MAX_RESERVATION_TERM_ID`.
const MAX_RESERVATION_TERM_ID = 8
// `Reservation.MAX_RESERVATION_TERM_CUSTODY_BPS`.
const MAX_CUSTODY_BPS = 500
// `WalletProposalValidatorConstants.DEPOSIT_REFUND_SAFETY_MARGIN`.
const DEPOSIT_REFUND_SAFETY_MARGIN = DAY
// `WalletProposalValidatorConstants.REQUEST_TIMEOUT_SAFETY_MARGIN`.
const REQUEST_TIMEOUT_SAFETY_MARGIN = 2 * 60 * 60

// Global parameters each test starts from, unless it sets its own. The
// renewal window is the 7-day default proposal; the global term is the
// largest allowed so it never bounds the window below a table entry.
const RENEWAL_WINDOW = 7 * DAY
const GLOBAL_TERM = MAX_RESERVATION_TERM

const ID_RANGE_REVERT = "Reservation term id out of range"
const BOUNDS_REVERT = "Reservation term out of protocol bounds"
const BPS_REVERT = "Reservation term custody fee too high"
const REWRITE_REVERT = "Reservation term entry cannot be rewritten"
const UNCHANGED_REVERT = "Reservation term unchanged"
const WINDOW_REVERT = "Renewal window must be shorter than every term entry"
const REVEAL_AHEAD_REVERT =
  "Largest term must cover the deposit reveal ahead period"

describe("Bridge - reservation term table", () => {
  let bridge: Bridge & BridgeStub
  let reservationRouter: ReservationRouter
  let governanceSigner: SignerWithAddress
  let thirdParty: SignerWithAddress
  let reservationVault: string
  let reservationMaxTotalAmount: string

  async function impersonate(address: string): Promise<SignerWithAddress> {
    await ethers.provider.send("hardhat_impersonateAccount", [address])
    await ethers.provider.send("hardhat_setBalance", [
      address,
      "0x8AC7230489E80000",
    ])
    return ethers.getSigner(address)
  }

  function setTerm(
    termId: number,
    termSeconds: number,
    custodyBps: number,
    enabled = true
  ) {
    return reservationRouter
      .connect(governanceSigner)
      .setReservationTerm(termId, termSeconds, custodyBps, enabled)
  }

  // Calls `updateReservationParameters` keeping the vault and the total
  // amount cap as the fixture left them, so the vault-change branch and the
  // slot-capacity relation stay out of the way.
  function setGlobalTermAndWindow(termSeconds: number, window: number) {
    return reservationRouter
      .connect(governanceSigner)
      .updateReservationParameters(
        reservationVault,
        100_000,
        10_000,
        termSeconds,
        7 * DAY,
        reservationMaxTotalAmount,
        10,
        REQUEST_TIMEOUT_SAFETY_MARGIN + 1,
        window
      )
  }

  async function expectTerm(
    termId: number,
    termSeconds: number,
    custodyBps: number,
    enabled: boolean
  ) {
    const term = await reservationRouter.reservationTerm(termId)
    expect(term.termSeconds).to.equal(termSeconds)
    expect(term.custodyBps).to.equal(custodyBps)
    expect(term.enabled).to.equal(enabled)
  }

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ bridge, thirdParty } = await bridgeFixture())
    // Restored in `after`, so no table entry or parameter set here outlives
    // this suite: other suites set a 30-day renewal window on the shared
    // Bridge and assume an empty table.
    await createSnapshot()

    // Router functions are reached through the Bridge fallback, so the
    // router ABI is bound to the Bridge address.
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.address
    )
    governanceSigner = await impersonate(await bridge.governance())

    const params = await reservationRouter.reservationParameters()
    reservationVault = params.reservationVault
    reservationMaxTotalAmount = params.reservationMaxTotalAmount.toString()

    await setGlobalTermAndWindow(GLOBAL_TERM, RENEWAL_WINDOW)
    await bridge.setDepositRevealAheadPeriod(0)
  })

  after(async () => {
    await restoreSnapshot()
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  describe("setReservationTerm", () => {
    context("when the caller is not the governance", () => {
      it("should revert", async () => {
        await expect(
          reservationRouter
            .connect(thirdParty)
            .setReservationTerm(1, 365 * DAY, 20, true)
        ).to.be.revertedWith("Caller is not the governance")
      })
    })

    context("when adding a new entry", () => {
      it("should store the entry and emit ReservationTermUpdated", async () => {
        const tx = await setTerm(1, 365 * DAY, 20)

        await expect(tx)
          .to.emit(reservationRouter, "ReservationTermUpdated")
          .withArgs(1, 365 * DAY, 20, true)
        await expectTerm(1, 365 * DAY, 20, true)
      })

      it("should store a disabled entry", async () => {
        await setTerm(1, 365 * DAY, 20, false)

        await expectTerm(1, 365 * DAY, 20, false)
      })

      it("should not write the term id maps", async () => {
        await setTerm(1, 365 * DAY, 20)

        expect(await reservationRouter.reservationTermId(1)).to.equal(0)
      })
    })

    context("term id", () => {
      it("should revert for id 0", async () => {
        await expect(setTerm(0, 365 * DAY, 20)).to.be.revertedWith(
          ID_RANGE_REVERT
        )
      })

      it("should accept id 1", async () => {
        await setTerm(1, 365 * DAY, 20)
        await expectTerm(1, 365 * DAY, 20, true)
      })

      it("should accept the largest id", async () => {
        await setTerm(MAX_RESERVATION_TERM_ID, 365 * DAY, 20)
        await expectTerm(MAX_RESERVATION_TERM_ID, 365 * DAY, 20, true)
      })

      it("should revert for the id above the largest", async () => {
        await expect(
          setTerm(MAX_RESERVATION_TERM_ID + 1, 365 * DAY, 20)
        ).to.be.revertedWith(ID_RANGE_REVERT)
      })
    })

    context("term length", () => {
      it("should revert just below the minimum", async () => {
        await expect(
          setTerm(1, MIN_RESERVATION_TERM - 1, 2)
        ).to.be.revertedWith(BOUNDS_REVERT)
      })

      it("should accept the minimum", async () => {
        await setTerm(1, MIN_RESERVATION_TERM, 2)
        await expectTerm(1, MIN_RESERVATION_TERM, 2, true)
      })

      it("should accept the maximum", async () => {
        await setTerm(1, MAX_RESERVATION_TERM, 20)
        await expectTerm(1, MAX_RESERVATION_TERM, 20, true)
      })

      it("should revert just above the maximum", async () => {
        await expect(
          setTerm(1, MAX_RESERVATION_TERM + 1, 20)
        ).to.be.revertedWith(BOUNDS_REVERT)
      })
    })

    context("custody fee", () => {
      it("should accept the maximum", async () => {
        await setTerm(1, 365 * DAY, MAX_CUSTODY_BPS)
        await expectTerm(1, 365 * DAY, MAX_CUSTODY_BPS, true)
      })

      it("should revert just above the maximum", async () => {
        await expect(
          setTerm(1, 365 * DAY, MAX_CUSTODY_BPS + 1)
        ).to.be.revertedWith(BPS_REVERT)
      })
    })

    context("when the entry already exists", () => {
      beforeEach(async () => {
        await setTerm(1, 365 * DAY, 20)
      })

      it("should revert when the length changes", async () => {
        await expect(setTerm(1, 365 * DAY + 1, 20)).to.be.revertedWith(
          REWRITE_REVERT
        )
      })

      it("should revert when the custody fee changes", async () => {
        await expect(setTerm(1, 365 * DAY, 21)).to.be.revertedWith(
          REWRITE_REVERT
        )
      })

      it("should revert when the length changes with the flag", async () => {
        await expect(setTerm(1, 365 * DAY + 1, 20, false)).to.be.revertedWith(
          REWRITE_REVERT
        )
      })

      it("should revert when nothing changes", async () => {
        await expect(setTerm(1, 365 * DAY, 20, true)).to.be.revertedWith(
          UNCHANGED_REVERT
        )
      })

      it("should disable, then re-enable, the entry", async () => {
        await expect(setTerm(1, 365 * DAY, 20, false))
          .to.emit(reservationRouter, "ReservationTermUpdated")
          .withArgs(1, 365 * DAY, 20, false)
        await expectTerm(1, 365 * DAY, 20, false)

        await expect(setTerm(1, 365 * DAY, 20, false)).to.be.revertedWith(
          UNCHANGED_REVERT
        )

        await expect(setTerm(1, 365 * DAY, 20, true))
          .to.emit(reservationRouter, "ReservationTermUpdated")
          .withArgs(1, 365 * DAY, 20, true)
        await expectTerm(1, 365 * DAY, 20, true)
      })

      it("should flip the flag without re-checking the relations", async () => {
        // BridgeStub writes the period directly, bypassing any setter, to
        // reach a state where the reveal-ahead relation is broken.
        await bridge.setDepositRevealAheadPeriod(
          365 * DAY + DEPOSIT_REFUND_SAFETY_MARGIN + 1
        )

        await setTerm(1, 365 * DAY, 20, false)
        await expectTerm(1, 365 * DAY, 20, false)
      })
    })

    context("renewal window relation", () => {
      // The default 7-day window sits below the term minimum, so the window
      // is raised to reach the relation rather than the length bound.
      beforeEach(async () => {
        await setGlobalTermAndWindow(GLOBAL_TERM, 60 * DAY)
      })

      it("should revert when the new entry equals the window", async () => {
        await expect(setTerm(1, 60 * DAY, 2)).to.be.revertedWith(WINDOW_REVERT)
      })

      it("should accept a new entry just above the window", async () => {
        await setTerm(1, 60 * DAY + 1, 2)
        await expectTerm(1, 60 * DAY + 1, 2, true)
      })

      it("should revert on a short entry added after a long one", async () => {
        await setTerm(1, 365 * DAY, 20)
        await expect(setTerm(2, 60 * DAY, 2)).to.be.revertedWith(WINDOW_REVERT)
      })
    })

    context("deposit reveal ahead period relation", () => {
      const revealAhead = 150 * DAY
      const minLargest = revealAhead - DEPOSIT_REFUND_SAFETY_MARGIN // 149 d

      beforeEach(async () => {
        await bridge.setDepositRevealAheadPeriod(revealAhead)
      })

      it("should revert when the largest entry is just short", async () => {
        await expect(setTerm(1, minLargest - 1, 10)).to.be.revertedWith(
          REVEAL_AHEAD_REVERT
        )
      })

      it("should accept a largest entry exactly covering the period", async () => {
        await setTerm(1, minLargest, 10)
        await expectTerm(1, minLargest, 10, true)
      })

      it("should accept a short entry once a long one exists", async () => {
        await setTerm(1, 365 * DAY, 20)
        await setTerm(2, 30 * DAY, 2)
        await expectTerm(2, 30 * DAY, 2, true)
      })

      it("should revert on a short first entry", async () => {
        await expect(setTerm(2, 30 * DAY, 2)).to.be.revertedWith(
          REVEAL_AHEAD_REVERT
        )
      })

      it("should count a disabled long entry toward the largest", async () => {
        await setTerm(1, 365 * DAY, 20, false)
        await setTerm(2, 30 * DAY, 2)
        await expectTerm(2, 30 * DAY, 2, true)
      })
    })
  })

  describe("updateReservationParameters", () => {
    context("when the term table is empty", () => {
      it("should skip the relation to the table", async () => {
        // Any window strictly below the global term passes.
        await setGlobalTermAndWindow(GLOBAL_TERM, GLOBAL_TERM - 1)
        expect(
          (await reservationRouter.reservationParameters())
            .reservationRenewalWindowSeconds
        ).to.equal(GLOBAL_TERM - 1)
      })
    })

    context("when the term table holds entries", () => {
      beforeEach(async () => {
        await setTerm(1, 365 * DAY, 20)
        await setTerm(3, 91 * DAY, 5)
      })

      it("should revert when the window equals the smallest entry", async () => {
        await expect(
          setGlobalTermAndWindow(GLOBAL_TERM, 91 * DAY)
        ).to.be.revertedWith(WINDOW_REVERT)
      })

      it("should accept a window just below the smallest entry", async () => {
        await setGlobalTermAndWindow(GLOBAL_TERM, 91 * DAY - 1)
        expect(
          (await reservationRouter.reservationParameters())
            .reservationRenewalWindowSeconds
        ).to.equal(91 * DAY - 1)
      })

      it("should count a disabled entry toward the smallest", async () => {
        await setTerm(2, 60 * DAY, 3)
        await setTerm(2, 60 * DAY, 3, false)

        await expect(
          setGlobalTermAndWindow(GLOBAL_TERM, 60 * DAY)
        ).to.be.revertedWith(WINDOW_REVERT)
        await setGlobalTermAndWindow(GLOBAL_TERM, 60 * DAY - 1)
      })
    })

    context("global term bounds", () => {
      it("should revert just below the lowered minimum", async () => {
        await expect(
          setGlobalTermAndWindow(MIN_RESERVATION_TERM - 1, RENEWAL_WINDOW)
        ).to.be.revertedWith(BOUNDS_REVERT)
      })

      it("should accept the lowered minimum", async () => {
        await setGlobalTermAndWindow(MIN_RESERVATION_TERM, RENEWAL_WINDOW)
        expect(
          (await reservationRouter.reservationParameters())
            .reservationTermSeconds
        ).to.equal(MIN_RESERVATION_TERM)
      })
    })
  })
})

describe("BridgeState - reservation term table helpers", () => {
  let table: TestReservationTermTable & Contract

  beforeEach(async () => {
    const TestReservationTermTable = await ethers.getContractFactory(
      "TestReservationTermTable"
    )
    table = (await TestReservationTermTable.deploy()) as never
  })

  context("over an empty table", () => {
    it("should return zero for the largest entry without reverting", async () => {
      expect(await table.largestReservationTermSeconds()).to.equal(0)
    })

    it("should return zero for the smallest entry without reverting", async () => {
      expect(await table.smallestReservationTermSeconds()).to.equal(0)
    })
  })

  context("over a populated table", () => {
    beforeEach(async () => {
      await table.setRawTerm(2, 91 * DAY, 5, true)
      await table.setRawTerm(5, 365 * DAY, 20, true)
    })

    it("should return the largest and the smallest entry", async () => {
      expect(await table.largestReservationTermSeconds()).to.equal(365 * DAY)
      expect(await table.smallestReservationTermSeconds()).to.equal(91 * DAY)
    })

    it("should count disabled entries", async () => {
      await table.setRawTerm(3, 30 * DAY, 2, false)
      await table.setRawTerm(4, 400 * DAY, 20, false)

      expect(await table.largestReservationTermSeconds()).to.equal(400 * DAY)
      expect(await table.smallestReservationTermSeconds()).to.equal(30 * DAY)
    })

    it("should read ids 1 and 8", async () => {
      await table.setRawTerm(1, 31 * DAY, 2, true)
      await table.setRawTerm(MAX_RESERVATION_TERM_ID, 700 * DAY, 20, true)

      expect(await table.largestReservationTermSeconds()).to.equal(700 * DAY)
      expect(await table.smallestReservationTermSeconds()).to.equal(31 * DAY)
    })

    it("should ignore ids 0 and 9", async () => {
      await table.setRawTerm(0, 1, 2, true)
      await table.setRawTerm(MAX_RESERVATION_TERM_ID + 1, 1000 * DAY, 20, true)

      expect(await table.largestReservationTermSeconds()).to.equal(365 * DAY)
      expect(await table.smallestReservationTermSeconds()).to.equal(91 * DAY)
    })
  })
})
