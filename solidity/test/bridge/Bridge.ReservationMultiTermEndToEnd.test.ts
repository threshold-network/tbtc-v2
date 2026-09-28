/* eslint-disable @typescript-eslint/no-unused-expressions */

// The multi-term acceptance path end to end, at the live mainnet
// `depositRevealAheadPeriod` of 150 days, on the Bridge fixture seeded by
// `deploy/97` (ids 1-3: 365, 30 and 91 days). Three depositors reveal
// reserved deposits, each requests acceptance on a different term, the
// acceptance proofs settle and the reservation vault credits each owner
// with the mint fee plus that term's custody fee taken. Governance then
// disables one entry through BridgeGovernance's delayed begin/finalize.
// Each earlier change is tested at its own surface; this file exercises the
// term table, the reserved reveal cap, the request, the proof and the vault
// credit together, through the production entry points.

import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import { expect } from "chai"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  IRelay,
  ReservationRouter,
  ReservationVault,
  TBTCVault,
  TBTC,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import {
  RESERVATION_TERM_ENTRIES,
  ReservationTermEntry,
} from "../helpers/reservation-terms"
import {
  impersonateContract,
  proofFor,
  refundLocktimeAt,
  revealReservedDeposit,
} from "../helpers/reservation-proofs"
import type {
  ReservationProofContext,
  RevealedReservation,
} from "../helpers/reservation-proofs"
import type { Mock } from "../helpers/mock"
import { walletState } from "../fixtures"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

const ZERO_BYTES32 = ethers.constants.HashZero

const DAY = 24 * 60 * 60
const [TERM_365, TERM_30, TERM_91] = RESERVATION_TERM_ENTRIES

// The live mainnet `depositRevealAheadPeriod`.
const MAINNET_REVEAL_AHEAD_PERIOD = 150 * DAY
// `WalletProposalValidatorConstants.DEPOSIT_REFUND_SAFETY_MARGIN`.
const DEPOSIT_REFUND_SAFETY_MARGIN = DAY
// Refund deadlines sit this far after the reveal: past the reveal-ahead
// period, and under the largest entry plus the safety margin that caps a
// reserved deposit's deadline.
const REFUND_DEADLINE_OFFSET = 180 * DAY

// The global term, which no lifecycle logic reads any more. It is kept
// below the refund deadline offset minus the safety margin, so a reserved
// reveal cap that read it instead of the largest entry would reject every
// reveal below.
const RESERVATION_TERM = 90 * DAY
const RESERVATION_GRACE = 30 * DAY
const RESERVATION_MIN_AMOUNT = 10000
const RESERVATION_TX_MAX_FEE = 2000
const RESERVATION_MAX_TOTAL = BigNumber.from("10000000")
const MAX_RESERVATIONS_PER_WALLET = 10
const RESERVATION_ACTION_TIMEOUT = 2 * DAY
const RESERVATION_RENEWAL_WINDOW = 7 * DAY

// The vault's mint fee at its default.
const MINT_FEE_BPS = 20
const SATOSHI_MULTIPLIER = BigNumber.from(10).pow(10)
const ANCHOR_FEE = 1500

const ReservationState = {
  Active: 1,
}

describe("Bridge - Reservation multi-term acceptance, end to end", () => {
  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress
  let depositors: SignerWithAddress[]

  let relay: Mock<IRelay>
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let reservationRouter: ReservationRouter
  let reservationVault: ReservationVault
  let tbtc: TBTC
  let tbtcVault: TBTCVault

  const walletPubKeyHash = "0x8db50eb52063ea9d98b3eac91489a90f738986f6"
  const blindingFactor = "0xf9f0c90d00039523"
  const refundPubKeyHash = "0x28e081f285138ccbe389c1eb8985716230129f89"

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      spvMaintainer,
      relay,
      bridge,
      bridgeGovernance,
      tbtc,
      tbtcVault,
    } = await bridgeFixture())
    // Restored in `after`, so nothing set here outlives this file.
    await createSnapshot()

    // Signers the fixture hands out as `thirdParty` and guardians are
    // skipped, so each depositor is an account with no other role.
    depositors = (await helpers.signers.getUnnamedSigners()).slice(4, 8)
    expect(depositors).to.have.length(4)

    // Router functions are reached through the Bridge's fallback.
    reservationRouter = await ethers.getContractAt(
      "ReservationRouter",
      bridge.address
    )
    reservationVault = await helpers.contracts.getContract("ReservationVault")
    // Bridge governance is the BridgeGovernance contract; the parameter
    // setup below impersonates it, and the disable goes through its
    // owner's begin/finalize.
    expect(await bridge.governance()).to.equal(bridgeGovernance.address)
    const bridgeGovernanceSigner = await impersonateContract(
      bridgeGovernance.address
    )

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

    // The mainnet reveal-ahead period, set through the BridgeGovernance
    // timelock so it passes the Bridge's check against the largest entry.
    await bridgeGovernance
      .connect(governance)
      .beginDepositRevealAheadPeriodUpdate(MAINNET_REVEAL_AHEAD_PERIOD)
    await increaseTime((await bridgeGovernance.governanceDelays(0)).toNumber())
    await bridgeGovernance
      .connect(governance)
      .finalizeDepositRevealAheadPeriodUpdate()
    expect(
      (await bridge.depositParameters()).depositRevealAheadPeriod
    ).to.equal(MAINNET_REVEAL_AHEAD_PERIOD)

    // The seeded table the expectations below are written against.
    // eslint-disable-next-line no-restricted-syntax
    for (const entry of RESERVATION_TERM_ENTRIES) {
      // eslint-disable-next-line no-await-in-loop
      const term = await reservationRouter.reservationTerm(entry.termId)
      expect(term.termSeconds).to.equal(entry.termSeconds)
      expect(term.custodyBps).to.equal(entry.custodyBps)
      expect(term.enabled).to.be.true
    }
    expect(await reservationVault.mintFeeBps()).to.equal(MINT_FEE_BPS)

    // The refund deadlines used below lie past the global term's cap and
    // inside the largest entry's, and past the reveal-ahead period.
    expect(REFUND_DEADLINE_OFFSET).to.be.greaterThan(
      RESERVATION_TERM + DEPOSIT_REFUND_SAFETY_MARGIN
    )
    expect(REFUND_DEADLINE_OFFSET).to.be.greaterThan(
      MAINNET_REVEAL_AHEAD_PERIOD
    )
    expect(REFUND_DEADLINE_OFFSET).to.be.lessThan(
      TERM_365.termSeconds + DEPOSIT_REFUND_SAFETY_MARGIN
    )
  })

  after(async () => {
    await restoreSnapshot()
  })

  // A proof context for `depositor`'s deposit of `depositAmount` sat on
  // `termId`, with a refund deadline `REFUND_DEADLINE_OFFSET` after now.
  async function contextFor(
    depositor: SignerWithAddress,
    depositAmount: number,
    termId: number
  ): Promise<ReservationProofContext> {
    return {
      bridge,
      reservationRouter,
      reservationVault: reservationVault.address,
      depositor,
      spvMaintainer,
      walletPubKeyHash,
      blindingFactor,
      refundPubKeyHash,
      refundLocktime: refundLocktimeAt(
        (await lastBlockTime()) + REFUND_DEADLINE_OFFSET
      ),
      depositAmount: BigNumber.from(depositAmount),
      anchorAmount: BigNumber.from(depositAmount - ANCHOR_FEE),
      termId,
    }
  }

  // Requests acceptance as the depositor and checks the request's events:
  // `ReservationTermSelected` names the term and is logged after
  // `ReservationAcceptanceRequested` in the same transaction, the order
  // off-chain consumers may rely on.
  async function requestAcceptance(
    ctx: ReservationProofContext,
    reservationKey: BigNumber
  ): Promise<void> {
    const tx = await reservationRouter
      .connect(ctx.depositor)
      .requestReservationAcceptance(
        reservationKey,
        ctx.walletPubKeyHash,
        ctx.termId
      )
    const receipt = await tx.wait()
    const names = receipt.logs
      .filter((log) => log.address === bridge.address)
      .map((log) => reservationRouter.interface.parseLog(log).name)
    const requestedAt = names.indexOf("ReservationAcceptanceRequested")
    const selectedAt = names.indexOf("ReservationTermSelected")
    expect(requestedAt).to.not.equal(-1)
    expect(selectedAt).to.be.greaterThan(requestedAt)
    await expect(tx)
      .to.emit(reservationRouter, "ReservationTermSelected")
      .withArgs(reservationKey, 1, ctx.termId)
  }

  async function submitProof(
    ctx: ReservationProofContext,
    reserved: RevealedReservation
  ): Promise<ContractTransaction> {
    return reservationRouter
      .connect(ctx.spvMaintainer)
      .submitReservationAcceptanceProof(
        reserved.anchorTx.info,
        proofFor(reserved.anchorTx.txHash),
        reserved.reservationKey,
        1
      )
  }

  async function blockTimeOf(tx: ContractTransaction): Promise<number> {
    const receipt = await tx.wait()
    return (await ethers.provider.getBlock(receipt.blockNumber)).timestamp
  }

  it("accepts and credits a position on each term, then disables one term for new requests only", async () => {
    // One depositor per entry, each with a different amount so a credit
    // paid to the wrong owner or at the wrong size cannot balance.
    const positions: {
      entry: ReservationTermEntry
      ctx: ReservationProofContext
    }[] = [
      {
        entry: TERM_30,
        ctx: await contextFor(depositors[0], 3000000, TERM_30.termId),
      },
      {
        entry: TERM_91,
        ctx: await contextFor(depositors[1], 2000000, TERM_91.termId),
      },
      {
        entry: TERM_365,
        ctx: await contextFor(depositors[2], 1000000, TERM_365.termId),
      },
    ]

    // Every reserved deposit is revealed first, each with a refund
    // deadline past the 150-day reveal-ahead period.
    const revealed: RevealedReservation[] = []
    // eslint-disable-next-line no-restricted-syntax
    for (const { ctx } of positions) {
      // eslint-disable-next-line no-await-in-loop
      revealed.push(await revealReservedDeposit(ctx))
    }

    // Then each depositor requests acceptance on its own term.
    // eslint-disable-next-line no-restricted-syntax
    for (const [i, { ctx }] of positions.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await requestAcceptance(ctx, revealed[i].reservationKey)
    }

    // Then the proofs settle, and the vault credits each owner.
    // eslint-disable-next-line no-restricted-syntax
    for (const [i, { entry, ctx }] of positions.entries()) {
      const { reservationKey } = revealed[i]
      const owner = ctx.depositor.address
      const grossTbtc = ctx.anchorAmount.mul(SATOSHI_MULTIPLIER)
      const feeBps = MINT_FEE_BPS + entry.custodyBps
      const fee = grossTbtc.mul(feeBps).div(10000)

      /* eslint-disable no-await-in-loop */
      const ownerBefore = await tbtc.balanceOf(owner)
      const vaultBefore = await tbtc.balanceOf(reservationVault.address)
      const supplyBefore = await tbtc.totalSupply()

      const tx = await submitProof(ctx, revealed[i])
      const settledAt = await blockTimeOf(tx)

      // The position runs for its entry's seconds from settlement.
      const position = await reservationRouter.reservations(reservationKey)
      expect(position.state).to.equal(ReservationState.Active)
      expect(position.owner).to.equal(owner)
      expect(position.acceptedAt).to.equal(settledAt)
      expect(position.expiresAt).to.equal(settledAt + entry.termSeconds)
      expect(position.mintedAmount).to.equal(ctx.anchorAmount)
      expect(
        await reservationRouter.reservationTermId(reservationKey)
      ).to.equal(entry.termId)

      // The owner receives gross minus 22 / 25 / 40 bps in TBTC, the vault
      // keeps the fee, and the minted total equals the anchor.
      const ownerDelta = (await tbtc.balanceOf(owner)).sub(ownerBefore)
      const vaultDelta = (await tbtc.balanceOf(reservationVault.address)).sub(
        vaultBefore
      )
      expect(ownerDelta).to.equal(grossTbtc.sub(fee))
      expect(vaultDelta).to.equal(fee)
      expect(ownerDelta.add(vaultDelta)).to.equal(grossTbtc)
      expect((await tbtc.totalSupply()).sub(supplyBefore)).to.equal(grossTbtc)
      await expect(tx)
        .to.emit(reservationVault, "ReservationCreditProcessed")
        .withArgs(owner, ctx.anchorAmount, fee)
      /* eslint-enable no-await-in-loop */
    }
    // The three charges are the three entries' 22 / 25 / 40 bps.
    expect(
      positions.map(({ entry }) => MINT_FEE_BPS + entry.custodyBps)
    ).to.eql([22, 25, 40])

    // Governance disables the 91-day entry through BridgeGovernance's
    // begin/finalize, passing its stored length and fee unchanged.
    const disabled = TERM_91
    const onDisabled = revealed[1].reservationKey
    const snapshotOf = async (key: BigNumber) => ({
      position: await reservationRouter.reservations(key),
      termId: await reservationRouter.reservationTermId(key),
    })
    const positionsBefore = await Promise.all(
      revealed.map(({ reservationKey }) => snapshotOf(reservationKey))
    )
    // The comparison below tells positions apart, so an unchanged result
    // is not an artefact of comparing equal-looking records.
    expect(positionsBefore[0]).to.not.eql(positionsBefore[1])
    const balancesBefore = await Promise.all(
      positions.map(({ ctx }) => tbtc.balanceOf(ctx.depositor.address))
    )

    await bridgeGovernance
      .connect(governance)
      .beginReservationTermUpdate(
        disabled.termId,
        disabled.termSeconds,
        disabled.custodyBps,
        false
      )
    await increaseTime((await bridgeGovernance.governanceDelays(0)).toNumber())
    await expect(
      bridgeGovernance.connect(governance).finalizeReservationTermUpdate()
    )
      .to.emit(reservationRouter, "ReservationTermUpdated")
      .withArgs(
        disabled.termId,
        disabled.termSeconds,
        disabled.custodyBps,
        false
      )

    const disabledTerm = await reservationRouter.reservationTerm(
      disabled.termId
    )
    expect(disabledTerm.termSeconds).to.equal(disabled.termSeconds)
    expect(disabledTerm.custodyBps).to.equal(disabled.custodyBps)
    expect(disabledTerm.enabled).to.be.false

    // The existing position on the disabled entry, and the others, are
    // unchanged, and so are their owners' balances.
    expect(await snapshotOf(onDisabled)).to.eql(positionsBefore[1])
    expect(
      await Promise.all(
        revealed.map(({ reservationKey }) => snapshotOf(reservationKey))
      )
    ).to.eql(positionsBefore)
    expect(
      await Promise.all(
        positions.map(({ ctx }) => tbtc.balanceOf(ctx.depositor.address))
      )
    ).to.eql(balancesBefore)

    // A new request on the disabled entry reverts; the same deposit can
    // still be requested on an enabled entry.
    const lateCtx = await contextFor(depositors[3], 1500000, disabled.termId)
    const late = await revealReservedDeposit(lateCtx)
    await expect(
      reservationRouter
        .connect(lateCtx.depositor)
        .requestReservationAcceptance(
          late.reservationKey,
          walletPubKeyHash,
          disabled.termId
        )
    ).to.be.revertedWith("Reservation term is disabled")
    await requestAcceptance(
      { ...lateCtx, termId: TERM_365.termId },
      late.reservationKey
    )
  })
})
