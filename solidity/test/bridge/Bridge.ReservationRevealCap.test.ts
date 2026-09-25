import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { BigNumber } from "ethers"

import type { ContractTransaction } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  ReservationRouter,
  TBTCVault,
} from "../../typechain"
import bridgeFixture, {
  bridgeFixtureWithoutReservationTerms,
} from "../fixtures/bridge"
import { constants, walletState } from "../fixtures"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

const DAY = 24 * 60 * 60

// `WalletProposalValidatorConstants.DEPOSIT_REFUND_SAFETY_MARGIN`.
const DEPOSIT_REFUND_SAFETY_MARGIN = DAY
// The largest entry of the seeded fixture's table (id 1).
const LARGEST_TERM = 365 * DAY
// The live mainnet `depositRevealAheadPeriod`.
const MAINNET_REVEAL_AHEAD_PERIOD = 150 * DAY
// The global `reservationTermSeconds` set by the fixture's deploy steps. It
// is shorter than the live reveal-ahead period, so a cap that still read it
// would reject every reserved reveal below.
const FIXTURE_GLOBAL_TERM = 90 * DAY

const CAP_REVERT = "Refund locktime too far in the future for a reservation"
const TOO_CLOSE_REVERT = "Deposit refund locktime is too close"
const REVEAL_AHEAD_REVERT =
  "Deposit reveal ahead period must not exceed largest term"

const ZERO_BYTES32 = ethers.constants.HashZero

const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
const blindingFactor = "0xf9f0c90d00039523"
const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"
const depositAmount = BigNumber.from(3000000)

const reverseHex = (hex: string): string =>
  (hex.replace(/^0x/, "").match(/../g) ?? []).reverse().join("")

const toLE = (value: number | BigNumber, byteLength: number): string =>
  reverseHex(
    BigNumber.from(value)
      .toHexString()
      .slice(2)
      .padStart(byteLength * 2, "0")
  )

const buildDepositScript = (depositor: string, locktime: string): string =>
  `14${depositor.slice(2)}7508${blindingFactor.slice(
    2
  )}7576a914${walletPubKeyHash
    .slice(2)
    .toLowerCase()}8763ac6776a914${refundPubKeyHash.slice(
    2
  )}8804${locktime.slice(2)}b175ac68`

const p2wshScript = (script: string): string =>
  `0020${ethers.utils.sha256(`0x${script}`).slice(2)}`

// A one-input, one-output funding transaction paying `depositAmount` to the
// P2WSH deposit script. The input is random, so every call yields a fresh
// deposit key.
function buildFundingTx(depositor: string, locktime: string) {
  const outputScript = p2wshScript(buildDepositScript(depositor, locktime))
  return {
    version: "0x01000000",
    inputVector: `0x01${ethers.utils
      .hexlify(ethers.utils.randomBytes(32))
      .slice(2)}0000000000ffffffff`,
    outputVector: `0x01${toLE(depositAmount, 8)}${(outputScript.length / 2)
      .toString(16)
      .padStart(2, "0")}${outputScript}`,
    locktime: "0x00000000",
  }
}

describe("Bridge - reserved refund-locktime cap", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let reservationRouter: ReservationRouter
  let reservationVault: string
  let tbtcVault: TBTCVault

  async function impersonate(address: string): Promise<SignerWithAddress> {
    await ethers.provider.send("hardhat_impersonateAccount", [address])
    await ethers.provider.send("hardhat_setBalance", [
      address,
      "0x8AC7230489E80000",
    ])
    return ethers.getSigner(address)
  }

  // Common setup over whichever fixture the suite loaded: router ABI bound
  // to the Bridge, a Live wallet, and deposit thresholds the funding
  // transaction clears.
  async function setUp() {
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.address
    )
    reservationVault = (await reservationRouter.reservationParameters())
      .reservationVault
    expect(reservationVault).to.equal(
      (await helpers.contracts.getContract("ReservationVault")).address
    )
    expect(await bridge.isVaultTrusted(reservationVault)).to.be.true

    await bridge.setDepositDustThreshold(10000)
    await bridge.setDepositTxMaxFee(2000)
    await bridge.setWallet(walletPubKeyHash, {
      ecdsaWalletID: ethers.utils.randomBytes(32),
      mainUtxoHash: ZERO_BYTES32,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ZERO_BYTES32,
    })
  }

  // Changes `depositRevealAheadPeriod` through the BridgeGovernance timelock,
  // which reaches `BridgeState.updateDepositParameters` and its require;
  // `BridgeStub.setDepositRevealAheadPeriod` writes storage directly and
  // would bypass it. Resolves to the finalizing transaction.
  async function setRevealAheadPeriodThroughGovernance(
    period: number
  ): Promise<ContractTransaction> {
    await bridgeGovernance
      .connect(governance)
      .beginDepositRevealAheadPeriodUpdate(period)
    await increaseTime(constants.governanceDelay)
    return bridgeGovernance
      .connect(governance)
      .finalizeDepositRevealAheadPeriodUpdate()
  }

  // Reveals a fresh deposit to `vault` in a block mined at `revealAt`, with a
  // refund locktime of `revealAt + deadlineOffset`. The gas limit is fixed
  // so a reverting reveal is mined at `revealAt` too, not estimated at some
  // other timestamp.
  async function revealToVaultAt(
    vault: string,
    revealAt: number,
    deadlineOffset: number
  ): Promise<ContractTransaction> {
    const refundLocktime = `0x${toLE(revealAt + deadlineOffset, 4)}`
    const fundingTx = buildFundingTx(thirdParty.address, refundLocktime)
    await ethers.provider.send("evm_setNextBlockTimestamp", [revealAt])
    return bridge.connect(thirdParty).revealDeposit(
      fundingTx,
      {
        fundingOutputIndex: 0,
        blindingFactor,
        walletPubKeyHash,
        refundPubKeyHash,
        refundLocktime,
        vault,
      },
      { gasLimit: 1_000_000 }
    )
  }

  async function revealReservedAt(
    revealAt: number,
    deadlineOffset: number
  ): Promise<ContractTransaction> {
    return revealToVaultAt(reservationVault, revealAt, deadlineOffset)
  }

  async function nextRevealTime(): Promise<number> {
    return (await lastBlockTime()) + 100
  }

  describe("with the seeded term table", () => {
    before(async () => {
      // eslint-disable-next-line @typescript-eslint/no-extra-semi
      ;({ governance, thirdParty, bridge, bridgeGovernance, tbtcVault } =
        await bridgeFixture())
      // Restored in `after`, so nothing set here outlives this suite.
      await createSnapshot()
      await setUp()

      // The fixture's preconditions this suite depends on: id 1 is the
      // largest entry, and the global term differs from it.
      expect((await reservationRouter.reservationTerm(1)).termSeconds).to.equal(
        LARGEST_TERM
      )
      expect(
        (await reservationRouter.reservationParameters()).reservationTermSeconds
      ).to.equal(FIXTURE_GLOBAL_TERM)
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

    context("at the mainnet reveal-ahead period of 150 days", () => {
      beforeEach(async () => {
        await setRevealAheadPeriodThroughGovernance(MAINNET_REVEAL_AHEAD_PERIOD)
        expect(
          (await bridge.depositParameters()).depositRevealAheadPeriod
        ).to.equal(MAINNET_REVEAL_AHEAD_PERIOD)
      })

      it("should accept a reserved reveal", async () => {
        const revealAt = await nextRevealTime()
        await expect(
          revealReservedAt(revealAt, MAINNET_REVEAL_AHEAD_PERIOD + DAY)
        ).to.not.be.reverted
        expect(await reservationRouter.pendingReservedDeposits()).to.equal(1)
      })

      it("should accept a refund deadline exactly at the cap", async () => {
        const revealAt = await nextRevealTime()
        await expect(
          revealReservedAt(
            revealAt,
            LARGEST_TERM + DEPOSIT_REFUND_SAFETY_MARGIN
          )
        ).to.not.be.reverted
      })

      it("should reject a refund deadline one second past the cap", async () => {
        const revealAt = await nextRevealTime()
        await expect(
          revealReservedAt(
            revealAt,
            LARGEST_TERM + DEPOSIT_REFUND_SAFETY_MARGIN + 1
          )
        ).to.be.revertedWith(CAP_REVERT)
      })

      // The cap applies only to reserved reveals. A deadline the cap rejects
      // for the reservation vault must still be accepted for a pooled
      // reveal, with no vault or with a trusted vault that is not the
      // reservation vault.
      context("when the reveal is pooled", () => {
        const pastCap = LARGEST_TERM + DEPOSIT_REFUND_SAFETY_MARGIN + 1

        it("should accept a deadline past the cap with no vault", async () => {
          const revealAt = await nextRevealTime()
          await expect(
            revealToVaultAt(ethers.constants.AddressZero, revealAt, pastCap)
          ).to.not.be.reverted
          expect(await reservationRouter.pendingReservedDeposits()).to.equal(0)
        })

        it("should accept a deadline past the cap with a trusted non-reservation vault", async () => {
          expect(tbtcVault.address).to.not.equal(reservationVault)
          expect(await bridge.isVaultTrusted(tbtcVault.address)).to.be.true
          const revealAt = await nextRevealTime()
          await expect(revealToVaultAt(tbtcVault.address, revealAt, pastCap)).to
            .not.be.reverted
          expect(await reservationRouter.pendingReservedDeposits()).to.equal(0)
        })
      })
    })

    context(
      "at the largest reveal-ahead period the cap admits (largest entry + 24 h)",
      () => {
        const period = LARGEST_TERM + DEPOSIT_REFUND_SAFETY_MARGIN

        beforeEach(async () => {
          await setRevealAheadPeriodThroughGovernance(period)
        })

        it("should accept the one refund deadline both bounds allow", async () => {
          const revealAt = await nextRevealTime()
          await expect(revealReservedAt(revealAt, period)).to.not.be.reverted
        })

        it("should reject a deadline one second earlier as too close", async () => {
          const revealAt = await nextRevealTime()
          await expect(
            revealReservedAt(revealAt, period - 1)
          ).to.be.revertedWith(TOO_CLOSE_REVERT)
        })

        it("should reject a deadline one second later as past the cap", async () => {
          const revealAt = await nextRevealTime()
          await expect(
            revealReservedAt(revealAt, period + 1)
          ).to.be.revertedWith(CAP_REVERT)
        })
      }
    )

    context("when the reveal-ahead period is raised through governance", () => {
      it("should accept exactly the largest entry + 24 h", async () => {
        const period = LARGEST_TERM + DEPOSIT_REFUND_SAFETY_MARGIN
        await expect(setRevealAheadPeriodThroughGovernance(period)).to.not.be
          .reverted
        expect(
          (await bridge.depositParameters()).depositRevealAheadPeriod
        ).to.equal(period)
      })

      it("should reject one second beyond the largest entry + 24 h", async () => {
        await expect(
          setRevealAheadPeriodThroughGovernance(
            LARGEST_TERM + DEPOSIT_REFUND_SAFETY_MARGIN + 1
          )
        ).to.be.revertedWith(REVEAL_AHEAD_REVERT)
      })
    })

    context("when the largest entry is disabled", () => {
      beforeEach(async () => {
        const governanceSigner = await impersonate(await bridge.governance())
        await reservationRouter
          .connect(governanceSigner)
          .setReservationTerm(1, LARGEST_TERM, 20, false)
        await ethers.provider.send("hardhat_stopImpersonatingAccount", [
          governanceSigner.address,
        ])
        expect((await reservationRouter.reservationTerm(1)).enabled).to.be.false
      })

      it("should still count it toward the cap", async () => {
        await setRevealAheadPeriodThroughGovernance(MAINNET_REVEAL_AHEAD_PERIOD)
        const revealAt = await nextRevealTime()
        await expect(
          revealReservedAt(
            revealAt,
            LARGEST_TERM + DEPOSIT_REFUND_SAFETY_MARGIN
          )
        ).to.not.be.reverted
      })

      it("should still count it toward the reveal-ahead bound", async () => {
        await expect(
          setRevealAheadPeriodThroughGovernance(
            LARGEST_TERM + DEPOSIT_REFUND_SAFETY_MARGIN
          )
        ).to.not.be.reverted
        await expect(
          setRevealAheadPeriodThroughGovernance(
            LARGEST_TERM + DEPOSIT_REFUND_SAFETY_MARGIN + 1
          )
        ).to.be.revertedWith(REVEAL_AHEAD_REVERT)
      })
    })
  })

  describe("with an empty term table", () => {
    before(async () => {
      // eslint-disable-next-line @typescript-eslint/no-extra-semi
      ;({ governance, thirdParty, bridge, bridgeGovernance } =
        await bridgeFixtureWithoutReservationTerms())
      await createSnapshot()
      await setUp()

      expect((await reservationRouter.reservationTerm(1)).termSeconds).to.equal(
        0
      )
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

    it("should not constrain the reveal-ahead period", async () => {
      // Above the largest entry any table could ever hold, plus 24 h.
      const period = 731 * DAY
      await expect(setRevealAheadPeriodThroughGovernance(period)).to.not.be
        .reverted
      expect(
        (await bridge.depositParameters()).depositRevealAheadPeriod
      ).to.equal(period)
    })

    context("when the reveal-ahead period is 24 h", () => {
      beforeEach(async () => {
        await setRevealAheadPeriodThroughGovernance(
          DEPOSIT_REFUND_SAFETY_MARGIN
        )
      })

      it("should accept a refund deadline exactly at now + 24 h", async () => {
        const revealAt = await nextRevealTime()
        await expect(revealReservedAt(revealAt, DEPOSIT_REFUND_SAFETY_MARGIN))
          .to.not.be.reverted
      })

      it("should reject a refund deadline one second past now + 24 h", async () => {
        const revealAt = await nextRevealTime()
        await expect(
          revealReservedAt(revealAt, DEPOSIT_REFUND_SAFETY_MARGIN + 1)
        ).to.be.revertedWith(CAP_REVERT)
      })
    })

    it("should reject every reserved reveal at the fixture's 15-day reveal-ahead period", async () => {
      expect(
        (await bridge.depositParameters()).depositRevealAheadPeriod
      ).to.equal(constants.depositRevealAheadPeriod)
      // Any deadline before now + 15 d is too close, shown at its latest
      // point; any deadline from now + 15 d on is past the empty-table cap of
      // now + 24 h, shown at its earliest point.
      const tooCloseRevealAt = await nextRevealTime()
      await expect(
        revealReservedAt(
          tooCloseRevealAt,
          constants.depositRevealAheadPeriod - 1
        )
      ).to.be.revertedWith(TOO_CLOSE_REVERT)
      const revealAt = await nextRevealTime()
      await expect(
        revealReservedAt(revealAt, constants.depositRevealAheadPeriod)
      ).to.be.revertedWith(CAP_REVERT)
    })
  })
})
