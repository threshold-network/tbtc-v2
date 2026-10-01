/* eslint-disable @typescript-eslint/no-unused-expressions */

// The term chosen at the acceptance request, carried to the position when
// the acceptance proof settles, and the late-acceptance window, which is
// bounded by the largest term entry rather than the generation's own term.
// Also the vault credit at acceptance, which charges the mint fee plus the
// position's entry custody fee, clamped at 500 bps.
// Driven through the production router entry points on the seeded Bridge
// fixture (ids 1-3: 365, 30 and 91 days), so the term id recorded at the
// request and the one read at settlement meet under the real action key.

import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import { expect } from "chai"
import type {
  Bank,
  Bridge,
  BridgeStub,
  IRelay,
  ReservationRouter,
  ReservationVault,
  TBTCVault,
  TBTC,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { RESERVATION_TERM_ENTRIES } from "../helpers/reservation-terms"
import {
  buildTx,
  impersonateContract,
  proofFor,
  revealReservedDeposit as revealReservedDepositWith,
  toLE,
} from "../helpers/reservation-proofs"
import type { Mock } from "../helpers/mock"
import { walletState } from "../fixtures"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

const ZERO_BYTES32 = ethers.constants.HashZero

const DAY = 24 * 60 * 60
const [TERM_365, TERM_30, TERM_91] = RESERVATION_TERM_ENTRIES
const LARGEST_TERM_SECONDS = TERM_365.termSeconds
const ENTRIES_BY_LENGTH = [TERM_30, TERM_91, TERM_365]

// The global term, kept distinct from every entry's length and below the
// largest one, so a late window that read it instead of the largest entry
// would close the window the late-settlement tests prove open.
const RESERVATION_TERM = 90 * DAY
const RESERVATION_GRACE = 30 * DAY
const RESERVATION_MIN_AMOUNT = 10000
const RESERVATION_TX_MAX_FEE = 2000
const RESERVATION_MAX_TOTAL = BigNumber.from("10000000")
const MAX_RESERVATIONS_PER_WALLET = 10
const RESERVATION_ACTION_TIMEOUT = 2 * DAY
const RESERVATION_RENEWAL_WINDOW = 7 * DAY

// Explicit gas limit so a reverting proof is mined at the pinned timestamp
// rather than rejected at gas estimation against another block time.
const PROOF_GAS_LIMIT = 3_000_000

const ReservationState = {
  Unknown: 0,
  Active: 1,
  Stranded: 4,
}

const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)

// The vault's mint fee at its default.
const MINT_FEE_BPS = 20

const ActionType = {
  Acceptance: 1,
}

const ActionState = {
  Pending: 1,
  Settled: 2,
  TimedOut: 3,
  Superseded: 5,
}

describe("Bridge - Reservation term carried to the position at proof", () => {
  let spvMaintainer: SignerWithAddress
  let thirdParty: SignerWithAddress

  let relay: Mock<IRelay>
  let bridge: Bridge & BridgeStub
  let reservationRouter: ReservationRouter
  let tbtc: TBTC
  let tbtcVault: TBTCVault
  let bank: Bank
  let reservationVault: ReservationVault
  let bridgeGovernanceSigner: SignerWithAddress

  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const blindingFactor = "0xf9f0c90d00039523"
  const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"
  let refundLocktime: string
  let refundDeadline: number

  const depositAmount = BigNumber.from(3000000)
  const anchorFee = 1500
  const anchorAmount = depositAmount.sub(anchorFee)

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ spvMaintainer, thirdParty, relay, bridge, tbtc, tbtcVault, bank } =
      await bridgeFixture())

    // Router functions are reached through the Bridge's fallback.
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.address
    )
    reservationVault = await helpers.contracts.getContract("ReservationVault")
    bridgeGovernanceSigner = await impersonateContract(
      await bridge.governance()
    )
    refundDeadline = (await lastBlockTime()) + 89 * DAY
    refundLocktime = `0x${toLE(refundDeadline, 4)}`

    await bridge
      .connect(bridgeGovernanceSigner)
      .setVaultStatus(reservationVault.address, true)
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationCaps(RESERVATION_MAX_TOTAL, RESERVATION_MAX_TOTAL, 10)
    await reservationRouter
      .connect(bridgeGovernanceSigner)
      .updateReservationParameters(
        reservationVault.address,
        RESERVATION_MIN_AMOUNT,
        RESERVATION_TX_MAX_FEE,
        RESERVATION_TERM,
        RESERVATION_GRACE,
        RESERVATION_MAX_TOTAL,
        MAX_RESERVATIONS_PER_WALLET,
        RESERVATION_ACTION_TIMEOUT,
        RESERVATION_RENEWAL_WINDOW
      )

    await relay.getCurrentEpochDifficulty.returns(0)
    await relay.getPrevEpochDifficulty.returns(0)

    await bridge.setDepositDustThreshold(10000)
    await bridge.setDepositTxMaxFee(2000)
    await bridge.setDepositRevealAheadPeriod(0)
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

    const tbtcOwner = await impersonateContract(await tbtc.owner())
    await tbtc.connect(tbtcOwner).transferOwnership(tbtcVault.address)

    // The global term differs from the largest entry (see RESERVATION_TERM).
    expect(
      (await reservationRouter.reservationParameters()).reservationTermSeconds
    ).to.equal(RESERVATION_TERM)
    expect(RESERVATION_TERM).to.be.lessThan(LARGEST_TERM_SECONDS)

    // The seeded table this file's expectations are written against.
    // eslint-disable-next-line no-restricted-syntax
    for (const entry of RESERVATION_TERM_ENTRIES) {
      // eslint-disable-next-line no-await-in-loop
      const term = await reservationRouter.reservationTerm(entry.termId)
      expect(term.termSeconds).to.equal(entry.termSeconds)
      expect(term.enabled).to.be.true
    }
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  // Reveals a fresh reserved deposit to the reservation vault.
  async function revealReservedDeposit() {
    const { reservationKey, anchorTx } = await revealReservedDepositWith({
      bridge,
      reservationRouter,
      reservationVault: reservationVault.address,
      depositor: thirdParty,
      spvMaintainer,
      walletPubKeyHash,
      blindingFactor,
      refundPubKeyHash,
      refundLocktime,
      depositAmount,
      anchorAmount,
    })
    return { reservationKey, anchorTx }
  }

  async function requestAcceptance(
    reservationKey: BigNumber,
    termId: number
  ): Promise<number> {
    await reservationRouter
      .connect(thirdParty)
      .requestReservationAcceptance(reservationKey, walletPubKeyHash, termId)
    return (
      await reservationRouter.reservations(reservationKey)
    ).requestNonce.toNumber()
  }

  // Lets the named generation time out and reports it, releasing its
  // capacity; returns the generation's `timeoutAt`.
  async function timeOut(
    reservationKey: BigNumber,
    requestNonce: number
  ): Promise<number> {
    const { timeoutAt } = await reservationRouter.reservationActions(
      reservationKey,
      requestNonce
    )
    const now = await lastBlockTime()
    await increaseTime(timeoutAt - now + 1)
    await reservationRouter
      .connect(thirdParty)
      .notifyReservationAcceptanceTimedOut(reservationKey)
    expect(
      (await reservationRouter.reservationActions(reservationKey, requestNonce))
        .state
    ).to.equal(ActionState.TimedOut)
    return timeoutAt
  }

  async function submitProofAt(
    anchorTx: ReturnType<typeof buildTx>,
    reservationKey: BigNumber,
    requestNonce: number,
    timestamp?: number
  ): Promise<ContractTransaction> {
    if (timestamp !== undefined) {
      await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp])
    }
    return reservationRouter
      .connect(spvMaintainer)
      .submitReservationAcceptanceProof(
        anchorTx.info,
        proofFor(anchorTx.txHash),
        reservationKey,
        requestNonce,
        { gasLimit: PROOF_GAS_LIMIT }
      )
  }

  async function blockTimeOf(tx: ContractTransaction): Promise<number> {
    const receipt = await tx.wait()
    return (await ethers.provider.getBlock(receipt.blockNumber)).timestamp
  }

  async function expectPositionOnTerm(
    tx: ContractTransaction,
    reservationKey: BigNumber,
    termId: number,
    termSeconds: number
  ) {
    const settledAt = await blockTimeOf(tx)
    const position = await reservationRouter.reservations(reservationKey)
    expect(position.state).to.equal(ReservationState.Active)
    expect(position.acceptedAt).to.equal(settledAt)
    expect(position.expiresAt).to.equal(settledAt + termSeconds)
    expect(await reservationRouter.reservationTermId(reservationKey)).to.equal(
      termId
    )
  }

  describe("on-time acceptance on each entry", () => {
    ENTRIES_BY_LENGTH.forEach((entry) => {
      it(`gives a ${
        entry.termSeconds / DAY
      }-day acceptance its expiry and term id`, async () => {
        const { reservationKey, anchorTx } = await revealReservedDeposit()
        expect(
          await reservationRouter.reservationTermId(reservationKey)
        ).to.equal(0)

        const requestNonce = await requestAcceptance(
          reservationKey,
          entry.termId
        )
        // The position carries no term id until the proof settles it.
        expect(
          await reservationRouter.reservationTermId(reservationKey)
        ).to.equal(0)

        const tx = await submitProofAt(anchorTx, reservationKey, requestNonce)
        await expect(tx)
          .to.emit(reservationRouter, "ReservationAccepted")
          .withArgs(
            reservationKey,
            requestNonce,
            walletPubKeyHash,
            thirdParty.address,
            anchorTx.txHash,
            anchorAmount,
            (await blockTimeOf(tx)) + entry.termSeconds
          )
        await expect(tx).to.not.emit(
          reservationRouter,
          "ReservationLateSettled"
        )
        await expectPositionOnTerm(
          tx,
          reservationKey,
          entry.termId,
          entry.termSeconds
        )
      })
    })
  })

  describe("late acceptance window", () => {
    it("settles a 30-day generation at the last second of the largest-term window", async () => {
      const { reservationKey, anchorTx } = await revealReservedDeposit()
      const requestNonce = await requestAcceptance(
        reservationKey,
        TERM_30.termId
      )
      const timeoutAt = await timeOut(reservationKey, requestNonce)

      // Far past the generation's own 30-day term and past the 91-day
      // entry: only the largest entry keeps the window open.
      const tx = await submitProofAt(
        anchorTx,
        reservationKey,
        requestNonce,
        timeoutAt + LARGEST_TERM_SECONDS
      )
      await expect(tx)
        .to.emit(reservationRouter, "ReservationLateSettled")
        .withArgs(reservationKey, requestNonce, ActionType.Acceptance)
      expect(await blockTimeOf(tx)).to.equal(timeoutAt + LARGEST_TERM_SECONDS)
      // The window is the largest entry; the position's term is its own.
      await expectPositionOnTerm(
        tx,
        reservationKey,
        TERM_30.termId,
        TERM_30.termSeconds
      )
    })

    it("rejects a late proof one second past the largest-term window", async () => {
      const { reservationKey, anchorTx } = await revealReservedDeposit()
      const requestNonce = await requestAcceptance(
        reservationKey,
        TERM_365.termId
      )
      const timeoutAt = await timeOut(reservationKey, requestNonce)

      await expect(
        submitProofAt(
          anchorTx,
          reservationKey,
          requestNonce,
          timeoutAt + LARGEST_TERM_SECONDS + 1
        )
      ).to.be.revertedWith("Late acceptance settlement window expired")
      expect(
        (await reservationRouter.reservations(reservationKey)).state
      ).to.equal(ReservationState.Unknown)
      expect(
        await reservationRouter.reservationTermId(reservationKey)
      ).to.equal(0)
    })

    it("settles a late proof inside the window after a stale notice", async () => {
      const { reservationKey, anchorTx } = await revealReservedDeposit()
      const requestNonce = await requestAcceptance(
        reservationKey,
        TERM_30.termId
      )
      const timeoutAt = await timeOut(reservationKey, requestNonce)

      // Past the deposit's refund deadline, the pending marker is released.
      await increaseTime(refundDeadline - (await lastBlockTime()) + 1)
      await expect(reservationRouter.notifyStaleReservedDeposit(reservationKey))
        .to.emit(reservationRouter, "ReservedDepositMarkedStale")
        .withArgs(reservationKey)

      // 200 days after the timeout: outside the 30- and 91-day entries,
      // inside the 365-day one.
      const tx = await submitProofAt(
        anchorTx,
        reservationKey,
        requestNonce,
        timeoutAt + 200 * DAY
      )
      await expect(tx)
        .to.emit(reservationRouter, "ReservationLateSettled")
        .withArgs(reservationKey, requestNonce, ActionType.Acceptance)
      await expectPositionOnTerm(
        tx,
        reservationKey,
        TERM_30.termId,
        TERM_30.termSeconds
      )
    })

    it("settles generation n at its own term and unwinds a pending generation n+1 on another term", async () => {
      const { reservationKey, anchorTx } = await revealReservedDeposit()
      const olderNonce = await requestAcceptance(reservationKey, TERM_30.termId)
      await timeOut(reservationKey, olderNonce)

      const newerNonce = await requestAcceptance(reservationKey, TERM_91.termId)
      expect(newerNonce).to.equal(olderNonce + 1)
      expect(
        (await reservationRouter.reservationActions(reservationKey, newerNonce))
          .state
      ).to.equal(ActionState.Pending)

      const tx = await submitProofAt(anchorTx, reservationKey, olderNonce)
      await expect(tx)
        .to.emit(reservationRouter, "ReservationActionSuperseded")
        .withArgs(reservationKey, newerNonce)
      await expect(tx)
        .to.emit(reservationRouter, "ReservationLateSettled")
        .withArgs(reservationKey, olderNonce, ActionType.Acceptance)

      await expectPositionOnTerm(
        tx,
        reservationKey,
        TERM_30.termId,
        TERM_30.termSeconds
      )
      expect(
        (await reservationRouter.reservationActions(reservationKey, olderNonce))
          .state
      ).to.equal(ActionState.Settled)
      expect(
        (await reservationRouter.reservationActions(reservationKey, newerNonce))
          .state
      ).to.equal(ActionState.Superseded)
    })
  })
  describe("vault credit at acceptance", () => {
    const grossTbtc = anchorAmount.mul(SATOSHI_MULTIPLIER)

    const feeAt = (bps: number): BigNumber => grossTbtc.mul(bps).div(10000)

    type Funds = {
      owner: BigNumber
      vault: BigNumber
      supply: BigNumber
      ownerBank: BigNumber
      vaultBank: BigNumber
    }

    async function readFunds(): Promise<Funds> {
      return {
        owner: await tbtc.balanceOf(thirdParty.address),
        vault: await tbtc.balanceOf(reservationVault.address),
        supply: await tbtc.totalSupply(),
        ownerBank: await bank.balanceOf(thirdParty.address),
        vaultBank: await bank.balanceOf(reservationVault.address),
      }
    }

    // Checks the split of the anchor between the owner and the vault since
    // `before`, to the TBTC unit.
    async function expectSplit(
      before: Funds,
      expectedFeeBps: number,
      tx: ContractTransaction
    ) {
      const after = await readFunds()
      const fee = feeAt(expectedFeeBps)
      const ownerDelta = after.owner.sub(before.owner)
      const vaultDelta = after.vault.sub(before.vault)
      expect(ownerDelta).to.equal(grossTbtc.sub(fee))
      expect(vaultDelta).to.equal(fee)
      // The minted total equals the anchor: owner plus vault fee, exactly.
      expect(ownerDelta.add(vaultDelta)).to.equal(grossTbtc)
      expect(after.supply.sub(before.supply)).to.equal(grossTbtc)
      // The Bank balance the Bridge credited is fully converted.
      expect(after.vaultBank).to.equal(before.vaultBank)
      expect(after.ownerBank).to.equal(before.ownerBank)
      await expect(tx)
        .to.emit(reservationVault, "ReservationCreditProcessed")
        .withArgs(thirdParty.address, anchorAmount, fee)
    }

    // Settles an on-time acceptance of a fresh deposit on `termId`, running
    // `beforeProof` between the request and the proof, and checks the split
    // of the anchor between the owner and the vault, to the TBTC unit.
    async function expectAcceptanceCharge(
      termId: number,
      expectedFeeBps: number,
      expectedState: number,
      beforeProof: () => Promise<void> = async () => {}
    ) {
      const { reservationKey, anchorTx } = await revealReservedDeposit()
      const requestNonce = await requestAcceptance(reservationKey, termId)
      await beforeProof()

      const before = await readFunds()
      const tx = await submitProofAt(anchorTx, reservationKey, requestNonce)

      const position = await reservationRouter.reservations(reservationKey)
      expect(position.state).to.equal(expectedState)
      expect(position.mintedAmount).to.equal(anchorAmount)
      expect(
        await reservationRouter.reservationTermId(reservationKey)
      ).to.equal(termId)

      await expectSplit(before, expectedFeeBps, tx)
      expect(await bank.balanceOf(thirdParty.address)).to.equal(0)
    }

    before(async () => {
      expect(await reservationVault.mintFeeBps()).to.equal(MINT_FEE_BPS)
    })

    ENTRIES_BY_LENGTH.forEach((entry) => {
      const feeBps = MINT_FEE_BPS + entry.custodyBps
      it(`charges ${feeBps} bps on a ${
        entry.termSeconds / DAY
      }-day acceptance`, async () => {
        await expectAcceptanceCharge(
          entry.termId,
          feeBps,
          ReservationState.Active
        )
      })
    })

    it("charges a disabled entry's custody fee to a position requested before the disable", async () => {
      await expectAcceptanceCharge(
        TERM_91.termId,
        MINT_FEE_BPS + TERM_91.custodyBps,
        ReservationState.Active,
        async () => {
          await reservationRouter
            .connect(bridgeGovernanceSigner)
            .setReservationTerm(
              TERM_91.termId,
              TERM_91.termSeconds,
              TERM_91.custodyBps,
              false
            )
          expect(
            (await reservationRouter.reservationTerm(TERM_91.termId)).enabled
          ).to.be.false
        }
      )
    })

    context("at the 500 bps clamp", () => {
      const CLAMP_TERM_SECONDS = 60 * DAY

      async function addEntry(termId: number, custodyBps: number) {
        await reservationRouter
          .connect(bridgeGovernanceSigner)
          .setReservationTerm(termId, CLAMP_TERM_SECONDS, custodyBps, true)
      }

      it("charges 500 bps when mint plus custody is exactly 500", async () => {
        await addEntry(4, 500 - MINT_FEE_BPS)
        await expectAcceptanceCharge(4, 500, ReservationState.Active)
      })

      it("clamps to 500 bps when mint plus custody is 501", async () => {
        await addEntry(5, 500 - MINT_FEE_BPS + 1)
        await expectAcceptanceCharge(5, 500, ReservationState.Active)
      })
    })

    it("charges the mint fee only to a position stranded at credit", async () => {
      await expectAcceptanceCharge(
        TERM_365.termId,
        MINT_FEE_BPS,
        ReservationState.Stranded,
        async () => {
          // The wallet leaves Live between the request and the proof, so
          // the settlement strands the position before the credit runs.
          const wallet = await bridge.wallets(walletPubKeyHash)
          await bridge.setWallet(walletPubKeyHash, {
            ...wallet,
            state: walletState.Closing,
          })
        }
      )
    })

    context("on the late and fallback paths", () => {
      it("charges 22 bps on a late 30-day acceptance", async () => {
        const { reservationKey, anchorTx } = await revealReservedDeposit()
        const requestNonce = await requestAcceptance(
          reservationKey,
          TERM_30.termId
        )
        const timeoutAt = await timeOut(reservationKey, requestNonce)

        const before = await readFunds()
        const tx = await submitProofAt(
          anchorTx,
          reservationKey,
          requestNonce,
          timeoutAt + LARGEST_TERM_SECONDS
        )
        await expect(tx)
          .to.emit(reservationRouter, "ReservationLateSettled")
          .withArgs(reservationKey, requestNonce, ActionType.Acceptance)
        expect(
          (await reservationRouter.reservations(reservationKey)).state
        ).to.equal(ReservationState.Active)
        await expectSplit(before, MINT_FEE_BPS + TERM_30.custodyBps, tx)
      })

      it("charges generation n's entry when a late proof unwinds generation n+1, and credits once", async () => {
        const { reservationKey, anchorTx } = await revealReservedDeposit()
        const olderNonce = await requestAcceptance(
          reservationKey,
          TERM_30.termId
        )
        await timeOut(reservationKey, olderNonce)
        // The newer generation is on the 91-day entry, whose charge (25
        // bps) differs from the older generation's (22 bps).
        const newerNonce = await requestAcceptance(
          reservationKey,
          TERM_91.termId
        )

        const before = await readFunds()
        const tx = await submitProofAt(anchorTx, reservationKey, olderNonce)
        await expect(tx)
          .to.emit(reservationRouter, "ReservationActionSuperseded")
          .withArgs(reservationKey, newerNonce)
        await expectSplit(before, MINT_FEE_BPS + TERM_30.custodyBps, tx)

        // Neither generation can settle again, so there is no second credit.
        await expect(
          submitProofAt(anchorTx, reservationKey, newerNonce)
        ).to.be.revertedWith("Action is not settleable")
        await expect(
          submitProofAt(anchorTx, reservationKey, olderNonce)
        ).to.be.revertedWith("Action is not settleable")
      })

      it("charges the mint fee only on a late proof whose wallet was Terminated", async () => {
        const { reservationKey, anchorTx } = await revealReservedDeposit()
        const requestNonce = await requestAcceptance(
          reservationKey,
          TERM_365.termId
        )
        const timeoutAt = await timeOut(reservationKey, requestNonce)
        const wallet = await bridge.wallets(walletPubKeyHash)
        await bridge.setWallet(walletPubKeyHash, {
          ...wallet,
          state: walletState.Terminated,
        })

        const before = await readFunds()
        const tx = await submitProofAt(
          anchorTx,
          reservationKey,
          requestNonce,
          timeoutAt + 10 * DAY
        )
        await expect(tx)
          .to.emit(reservationRouter, "ReservationLateSettled")
          .withArgs(reservationKey, requestNonce, ActionType.Acceptance)
        await expect(tx).to.emit(reservationRouter, "ReservationStranded")
        expect(
          (await reservationRouter.reservations(reservationKey)).state
        ).to.equal(ReservationState.Stranded)
        await expectSplit(before, MINT_FEE_BPS, tx)
      })

      it("credits the depositor's Bank balance directly, minting nothing, when the vault is untrusted at proof", async () => {
        const { reservationKey, anchorTx } = await revealReservedDeposit()
        const requestNonce = await requestAcceptance(
          reservationKey,
          TERM_91.termId
        )
        await bridge
          .connect(bridgeGovernanceSigner)
          .setVaultStatus(reservationVault.address, false)

        const before = await readFunds()
        const tx = await submitProofAt(anchorTx, reservationKey, requestNonce)
        const after = await readFunds()

        expect(after.ownerBank.sub(before.ownerBank)).to.equal(anchorAmount)
        expect(after.vaultBank).to.equal(before.vaultBank)
        expect(after.owner).to.equal(before.owner)
        expect(after.vault).to.equal(before.vault)
        expect(after.supply).to.equal(before.supply)
        await expect(tx).to.not.emit(
          reservationVault,
          "ReservationCreditProcessed"
        )
        expect(
          (await reservationRouter.reservations(reservationKey)).state
        ).to.equal(ReservationState.Active)
      })
    })
  })
})
