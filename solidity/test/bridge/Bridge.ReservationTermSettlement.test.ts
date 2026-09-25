/* eslint-disable @typescript-eslint/no-unused-expressions */

// The term chosen at the acceptance request, carried to the position when
// the acceptance proof settles, and the late-acceptance window, which is
// bounded by the largest term entry rather than the generation's own term.
// Driven through the production router entry points on the seeded Bridge
// fixture (ids 1-3: 365, 30 and 91 days), so the term id recorded at the
// request and the one read at settlement meet under the real action key.

import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BigNumber, ContractTransaction } from "ethers"
import { expect } from "chai"
import type {
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
import type { Mock } from "../helpers/mock"
import { walletState } from "../fixtures"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

const ZERO_BYTES32 = ethers.constants.HashZero

const DAY = 24 * 60 * 60
const [TERM_365, TERM_30, TERM_91] = RESERVATION_TERM_ENTRIES
const LARGEST_TERM_SECONDS = TERM_365.termSeconds
const ENTRIES_BY_LENGTH = [TERM_30, TERM_91, TERM_365]

const RESERVATION_TERM = 365 * DAY
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
}

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

  async function impersonateContract(
    address: string
  ): Promise<SignerWithAddress> {
    await ethers.provider.send("hardhat_impersonateAccount", [address])
    await ethers.provider.send("hardhat_setBalance", [
      address,
      "0x8AC7230489E80000",
    ])
    return ethers.getSigner(address)
  }

  // ---- Bitcoin fixture crafting (regtest-style difficulty) ----

  const REGTEST_BITS_LE = "ffff7f20"
  const REGTEST_TARGET = BigNumber.from("0x7fffff").mul(
    BigNumber.from(2).pow(8 * (0x20 - 3))
  )

  const reverseHex = (hex: string): string =>
    hex.replace(/^0x/, "").match(/../g)!.reverse().join("")

  const hash256 = (hexData: string): string =>
    ethers.utils.sha256(ethers.utils.sha256(hexData))

  const toLE = (value: number | BigNumber, byteLength: number): string =>
    reverseHex(
      BigNumber.from(value)
        .toHexString()
        .slice(2)
        .padStart(byteLength * 2, "0")
    )

  function buildTx(
    inputs: { txHash: string; index: number }[],
    outputs: { valueSat: BigNumber | number; script: string }[]
  ) {
    const compactSize = (n: number): string => n.toString(16).padStart(2, "0")
    const inputVector = `0x${compactSize(inputs.length)}${inputs
      .map((i) => `${i.txHash.slice(2)}${toLE(i.index, 4)}00ffffffff`)
      .join("")}`
    const outputVector = `0x${compactSize(outputs.length)}${outputs
      .map(
        (o) =>
          `${toLE(BigNumber.from(o.valueSat), 8)}${compactSize(
            o.script.length / 2
          )}${o.script}`
      )
      .join("")}`
    const info = {
      version: "0x01000000",
      inputVector,
      outputVector,
      locktime: "0x00000000",
    }
    const txHash = hash256(
      `0x01000000${inputVector.slice(2)}${outputVector.slice(2)}00000000`
    )
    return { info, txHash }
  }

  function mineHeader(merkleRoot: string): string {
    const prevBlock = ethers.utils
      .hexlify(ethers.utils.randomBytes(32))
      .slice(2)
    const base = `20000000${prevBlock}${merkleRoot.slice(
      2
    )}662a2c68${REGTEST_BITS_LE}`
    for (let nonce = 0; ; nonce++) {
      const header = `0x${base}${toLE(nonce, 4)}`
      if (
        BigNumber.from(`0x${reverseHex(hash256(header))}`).lte(REGTEST_TARGET)
      ) {
        return header
      }
    }
  }

  function proofFor(txHash: string) {
    const coinbasePreimage = ethers.utils.sha256(ethers.utils.randomBytes(32))
    const coinbaseTxId = ethers.utils.sha256(coinbasePreimage)
    const merkleRoot = hash256(`0x${coinbaseTxId.slice(2)}${txHash.slice(2)}`)
    return {
      merkleProof: coinbaseTxId,
      txIndexInBlock: 1,
      bitcoinHeaders: mineHeader(merkleRoot),
      coinbasePreimage,
      coinbaseProof: txHash,
    }
  }

  const buildDepositScript = (depositor: string): string =>
    `14${depositor.slice(2)}7508${blindingFactor.slice(
      2
    )}7576a914${walletPubKeyHash
      .slice(2)
      .toLowerCase()}8763ac6776a914${refundPubKeyHash.slice(
      2
    )}8804${refundLocktime.slice(2)}b175ac68`

  const p2wshScript = (script: string): string =>
    `0020${ethers.utils.sha256(`0x${script}`).slice(2)}`

  const p2wpkhScript = (pkh: string): string => `0014${pkh.slice(2)}`

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ spvMaintainer, thirdParty, relay, bridge, tbtc, tbtcVault } =
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
    const fundingTx = buildTx(
      [
        {
          txHash: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
          index: 0,
        },
      ],
      [
        {
          valueSat: depositAmount,
          script: p2wshScript(buildDepositScript(thirdParty.address)),
        },
      ]
    )
    await bridge.connect(thirdParty).revealDeposit(fundingTx.info, {
      fundingOutputIndex: 0,
      blindingFactor,
      walletPubKeyHash,
      refundPubKeyHash,
      refundLocktime,
      vault: reservationVault.address,
    })
    const reservationKey = BigNumber.from(
      ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [fundingTx.txHash, 0]
      )
    )
    const anchorTx = buildTx(
      [{ txHash: fundingTx.txHash, index: 0 }],
      [{ valueSat: anchorAmount, script: p2wpkhScript(walletPubKeyHash) }]
    )
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
})
