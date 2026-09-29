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
import bridgeFixture, {
  bridgeFixtureWithoutReservationTerms,
} from "../fixtures/bridge"
import {
  RESERVATION_TERM_ENTRIES,
  seedReservationTerms,
} from "../helpers/reservation-terms"
import type { ReservationTermEntry } from "../helpers/reservation-terms"

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
    // The unseeded fixture: these tests add entries to ids 1 to 8 and rely
    // on the table starting empty.
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ bridge, thirdParty } = await bridgeFixtureWithoutReservationTerms())
    // Restored in `after`, so no table entry or parameter set here outlives
    // this suite on the shared Bridge.
    await createSnapshot()

    // Router functions are reached through the Bridge fallback, so the
    // router ABI is bound to the Bridge address.
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.address
    )
    // The deploy scripts seed the table; the fixture clears it. Checked here
    // so that no test below runs against a table it did not build.
    for (let termId = 0; termId <= MAX_RESERVATION_TERM_ID; termId++) {
      // eslint-disable-next-line no-await-in-loop
      await expectTerm(termId, 0, 0, false)
    }
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

      it("should leave reservationTermId at zero for an unknown key", async () => {
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

  describe("reservationTerm", () => {
    it("should start from an empty table", async () => {
      for (let termId = 0; termId <= MAX_RESERVATION_TERM_ID; termId++) {
        // eslint-disable-next-line no-await-in-loop
        await expectTerm(termId, 0, 0, false)
      }
    })

    it("should return all zeros for a term id that was never added", async () => {
      await setTerm(2, 365 * DAY, 20)

      // eslint-disable-next-line no-restricted-syntax
      for (const termId of [0, 1, MAX_RESERVATION_TERM_ID, 255]) {
        // eslint-disable-next-line no-await-in-loop
        await expectTerm(termId, 0, 0, false)
      }
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
      await table.addTerm(2, 91 * DAY, 5, true)
      await table.addTerm(5, 365 * DAY, 20, true)
    })

    it("should return the largest and the smallest entry", async () => {
      expect(await table.largestReservationTermSeconds()).to.equal(365 * DAY)
      expect(await table.smallestReservationTermSeconds()).to.equal(91 * DAY)
    })

    it("should not depend on the order entries were added in", async () => {
      const reversed = (await (
        await ethers.getContractFactory("TestReservationTermTable")
      ).deploy()) as TestReservationTermTable & Contract
      await reversed.addTerm(5, 365 * DAY, 20, true)
      await reversed.addTerm(2, 91 * DAY, 5, true)

      expect(await reversed.largestReservationTermSeconds()).to.equal(365 * DAY)
      expect(await reversed.smallestReservationTermSeconds()).to.equal(91 * DAY)
    })

    it("should leave both unchanged by an entry strictly between them", async () => {
      await table.addTerm(3, 180 * DAY, 10, true)

      expect(await table.largestReservationTermSeconds()).to.equal(365 * DAY)
      expect(await table.smallestReservationTermSeconds()).to.equal(91 * DAY)
    })

    it("should count disabled entries", async () => {
      await table.addTerm(3, 30 * DAY, 2, false)
      await table.addTerm(4, 400 * DAY, 20, false)

      expect(await table.largestReservationTermSeconds()).to.equal(400 * DAY)
      expect(await table.smallestReservationTermSeconds()).to.equal(30 * DAY)
    })

    it("should not change on a flag flip", async () => {
      await table.setEnabled(5, false)
      await table.setEnabled(2, false)

      expect(await table.largestReservationTermSeconds()).to.equal(365 * DAY)
      expect(await table.smallestReservationTermSeconds()).to.equal(91 * DAY)

      await table.setEnabled(5, true)

      expect(await table.largestReservationTermSeconds()).to.equal(365 * DAY)
      expect(await table.smallestReservationTermSeconds()).to.equal(91 * DAY)
    })

    it("should read ids 1 and 8", async () => {
      await table.addTerm(1, 31 * DAY, 2, true)
      await table.addTerm(MAX_RESERVATION_TERM_ID, 700 * DAY, 20, true)

      expect(await table.largestReservationTermSeconds()).to.equal(700 * DAY)
      expect(await table.smallestReservationTermSeconds()).to.equal(31 * DAY)
    })
  })
})

describe("Bridge fixture - seeded reservation term table", () => {
  let bridge: Bridge & BridgeStub
  let reservationRouter: ReservationRouter

  async function expectRejection(
    promise: Promise<unknown>,
    pattern: RegExp
  ): Promise<void> {
    let error: Error | undefined
    try {
      await promise
    } catch (e) {
      error = e as Error
    }
    expect(error, `expected rejection matching ${pattern}`).to.not.equal(
      undefined
    )
    expect((error as Error).message).to.match(pattern)
  }

  async function readTable(): Promise<ReservationTermEntry[]> {
    const table: ReservationTermEntry[] = []
    for (let termId = 0; termId <= MAX_RESERVATION_TERM_ID; termId++) {
      // eslint-disable-next-line no-await-in-loop
      const term = await reservationRouter.reservationTerm(termId)
      table.push({
        termId,
        termSeconds: term.termSeconds,
        custodyBps: term.custodyBps,
        enabled: term.enabled,
      })
    }
    return table
  }

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ bridge } = await bridgeFixture())
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.address
    )
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  it("should hold exactly the three ruled entries", async () => {
    expect(RESERVATION_TERM_ENTRIES).to.deep.equal([
      { termId: 1, termSeconds: 365 * DAY, custodyBps: 20, enabled: true },
      { termId: 2, termSeconds: 30 * DAY, custodyBps: 2, enabled: true },
      { termId: 3, termSeconds: 91 * DAY, custodyBps: 5, enabled: true },
    ])

    const empty = (termId: number) => ({
      termId,
      termSeconds: 0,
      custodyBps: 0,
      enabled: false,
    })
    expect(await readTable()).to.deep.equal([
      empty(0),
      ...RESERVATION_TERM_ENTRIES,
      empty(4),
      empty(5),
      empty(6),
      empty(7),
      empty(8),
    ])
  })

  describe("seedReservationTerms", () => {
    it("should skip ids that already hold identical values", async () => {
      const tableBefore = await readTable()

      expect(await seedReservationTerms(bridge)).to.deep.equal([])
      expect(await readTable()).to.deep.equal(tableBefore)
    })

    it("should write only the ids not yet present", async () => {
      const extra = {
        termId: 4,
        termSeconds: 182 * DAY,
        custodyBps: 10,
        enabled: true,
      }

      expect(
        await seedReservationTerms(bridge, [...RESERVATION_TERM_ENTRIES, extra])
      ).to.deep.equal([4])
      expect((await readTable())[4]).to.deep.equal(extra)
    })

    it("should reject an id holding a different length", async () => {
      await expectRejection(
        seedReservationTerms(bridge, [
          { termId: 2, termSeconds: 31 * DAY, custodyBps: 2, enabled: true },
        ]),
        /Reservation term 2 holds/
      )
    })

    it("should reject an id holding a different custody fee", async () => {
      await expectRejection(
        seedReservationTerms(bridge, [
          { termId: 3, termSeconds: 91 * DAY, custodyBps: 6, enabled: true },
        ]),
        /Reservation term 3 holds/
      )
    })

    it("should reject an id holding a different enabled flag", async () => {
      const governanceAddress = await bridge.governance()
      await ethers.provider.send("hardhat_impersonateAccount", [
        governanceAddress,
      ])
      await ethers.provider.send("hardhat_setBalance", [
        governanceAddress,
        "0x8AC7230489E80000",
      ])
      const governance = await ethers.getSigner(governanceAddress)
      await reservationRouter
        .connect(governance)
        .setReservationTerm(2, 30 * DAY, 2, false)
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [
        governanceAddress,
      ])

      await expectRejection(
        seedReservationTerms(bridge),
        /Reservation term 2 holds/
      )
    })

    context("impersonation of the governance", () => {
      // Hardhat sends an `eth_sendTransaction` from an address it holds no
      // key for only while that address is impersonated, so a zero-value
      // self-transfer from the governance address observes whether the
      // helper left the impersonation on. The recipient is the zero
      // address, which holds no code, so the transfer itself cannot revert.
      async function sendFromGovernance(): Promise<unknown> {
        const governanceAddress = await bridge.governance()
        return ethers.provider.send("eth_sendTransaction", [
          {
            from: governanceAddress,
            to: ethers.constants.AddressZero,
            value: "0x0",
          },
        ])
      }

      it("should observe an active impersonation", async () => {
        // Control for the checks below: the probe succeeds while the
        // governance is impersonated, so its rejection there is not vacuous.
        const governanceAddress = await bridge.governance()
        await ethers.provider.send("hardhat_impersonateAccount", [
          governanceAddress,
        ])
        await ethers.provider.send("hardhat_setBalance", [
          governanceAddress,
          "0x8AC7230489E80000",
        ])
        try {
          await sendFromGovernance()
        } finally {
          await ethers.provider.send("hardhat_stopImpersonatingAccount", [
            governanceAddress,
          ])
        }
        await expectRejection(sendFromGovernance(), /unknown account/i)
      })

      it("should stop impersonating after seeding", async () => {
        await seedReservationTerms(bridge)

        await expectRejection(sendFromGovernance(), /unknown account/i)
      })

      it("should stop impersonating after a rejection", async () => {
        await expectRejection(
          seedReservationTerms(bridge, [
            { termId: 2, termSeconds: 31 * DAY, custodyBps: 2, enabled: true },
          ]),
          /Reservation term 2 holds/
        )

        await expectRejection(sendFromGovernance(), /unknown account/i)
      })
    })
  })
})
