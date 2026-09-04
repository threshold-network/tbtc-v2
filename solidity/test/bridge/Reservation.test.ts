import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { TestReservation } from "../../typechain"
import { walletState } from "../fixtures"

const { lastBlockTime, increaseTime } = helpers.time
const { AddressZero, HashZero } = ethers.constants

const reservationState = {
  Unknown: 0,
  Active: 1,
  ActionPending: 2,
  Closed: 3,
  Stranded: 4,
}

const actionType = {
  None: 0,
  Acceptance: 1,
  Redemption: 2,
  Reanchor: 3,
  Dissolution: 4,
}

const actionState = {
  Unknown: 0,
  Pending: 1,
  Settled: 2,
  TimedOut: 3,
  Vetoed: 4,
  Superseded: 5,
}

describe("Reservation", () => {
  let testReservation: TestReservation
  let deployer: SignerWithAddress
  let depositor: SignerWithAddress
  let thirdParty: SignerWithAddress
  let vault: SignerWithAddress

  const walletPubKeyHash = "0x7ac2d9378a1c47e589dfb8095ca95ed2140d2726"
  const walletPubKeyHash2 = "0x1111111111111111111111111111111111111111"

  const reservationKey1 = ethers.utils.hexZeroPad("0x1", 32)
  const reservationKey2 = ethers.utils.hexZeroPad("0x2", 32)
  const reservationKey3 = ethers.utils.hexZeroPad("0x3", 32)
  const reservationKey4 = ethers.utils.hexZeroPad("0x4", 32)

  const defaultDepositAmount = 1000000 // 0.01 BTC
  const defaultMinAmount = 100000
  const defaultTxMaxFee = 10000
  const defaultActionTimeout = 14400 // 4 hours
  const twoHours = 7200
  const twentyFourHours = 86400

  beforeEach(async () => {
    const signers = await ethers.getSigners()
    ;[deployer, depositor, thirdParty, vault] = signers

    const ReservationProofsFactory = await ethers.getContractFactory(
      "ReservationProofs"
    )
    const reservationProofsLibrary = await ReservationProofsFactory.connect(
      deployer
    ).deploy()
    const ReservationFactory = await ethers.getContractFactory("Reservation")
    const reservationLibrary = await ReservationFactory.connect(
      deployer
    ).deploy()
    const TestReservationFactory = await ethers.getContractFactory(
      "TestReservation",
      { libraries: { Reservation: reservationLibrary.address } }
    )
    testReservation = (await TestReservationFactory.connect(
      deployer
    ).deploy()) as TestReservation
  })

  async function setupValidDeposit(
    key: string = reservationKey1,
    pkh: string = walletPubKeyHash,
    overrides?: {
      depositAmount?: number
      minAmount?: number
      txMaxFee?: number
      actionTimeout?: number
      revealedAt?: number
      refundDeadline?: number
      depositorAddress?: string
      vaultAddress?: string
      walletStateVal?: number
    }
  ) {
    const now = await lastBlockTime()
    const depositAmount = overrides?.depositAmount ?? defaultDepositAmount
    const minAmount = overrides?.minAmount ?? defaultMinAmount
    const txMaxFee = overrides?.txMaxFee ?? defaultTxMaxFee
    const actionTimeout = overrides?.actionTimeout ?? defaultActionTimeout
    const revealedAt = overrides?.revealedAt ?? now - twoHours
    const refundDeadline =
      overrides?.refundDeadline ??
      now + actionTimeout + twentyFourHours + twoHours
    const depAddress = overrides?.depositorAddress ?? depositor.address
    const vAddress = overrides?.vaultAddress ?? vault.address
    const wState = overrides?.walletStateVal ?? walletState.Live

    await testReservation.setReservationVault(vAddress)
    await testReservation.setReservationMinAmount(minAmount)
    await testReservation.setReservationTxMaxFee(txMaxFee)
    await testReservation.setReservationActionTimeout(actionTimeout)
    await testReservation.setReservationMaxSingleAmount(0)
    await testReservation.setReservationMaxTotalAmount(1000000000)
    await testReservation.setMaxReservationsPerWallet(10)
    await testReservation.setMaxReservationsAmountPerWallet(0)
    await testReservation.setMaxActiveReservations(0)

    await testReservation.registerWallet(pkh, wState)
    await testReservation.seedDeposit(
      key,
      depAddress,
      depositAmount,
      vAddress,
      revealedAt
    )
    await testReservation.initializeProducerStub(
      key,
      pkh,
      refundDeadline,
      depAddress
    )
  }

  describe("requestReservationAcceptance", () => {
    describe("guard 1: reservationVault != 0", () => {
      it("should revert if reservation vault is not set (Reservations are disabled)", async () => {
        await setupValidDeposit()
        await testReservation.setReservationVault(AddressZero)

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Reservations are disabled")
      })
    })

    describe("guard 2: deposit.revealedAt != 0", () => {
      it("should revert if deposit is not revealed", async () => {
        await setupValidDeposit()
        // Override deposit with revealedAt = 0
        await testReservation.seedDeposit(
          reservationKey1,
          depositor.address,
          defaultDepositAmount,
          vault.address,
          0
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Deposit not revealed")
      })
    })

    describe("guard 3: msg.sender == deposit.depositor", () => {
      it("should revert if caller is not the deposit's depositor", async () => {
        await setupValidDeposit()

        await expect(
          testReservation
            .connect(thirdParty)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Caller is not the deposit's depositor")
      })

      it("should succeed if caller is the deposit's depositor", async () => {
        await setupValidDeposit()

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.not.be.reverted
      })
    })

    describe("guard 4: deposit.sweptAt == 0", () => {
      it("should revert if deposit already swept", async () => {
        await setupValidDeposit()
        const now = await lastBlockTime()
        await testReservation.setSweptAt(reservationKey1, now)

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Deposit already swept")
      })
    })

    describe("guard 5: pendingReservedDeposit[key].isReserved", () => {
      it("should revert if deposit was not revealed as reserved", async () => {
        await setupValidDeposit()
        const now = await lastBlockTime()
        await testReservation.setPendingReservedDeposit(reservationKey1, {
          isReserved: false,
          walletPubKeyHash,
          refundDeadline:
            now + defaultActionTimeout + twentyFourHours + twoHours,
          refundDeadlineValidated: true,
        })

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Deposit was not revealed as reserved")
      })
    })

    describe("guard 6: deposit.vault == reservationVault", () => {
      it("should revert if deposit is not routed to the reservation vault", async () => {
        await setupValidDeposit()
        const unroutedVault = thirdParty.address
        const now = await lastBlockTime()
        await testReservation.seedDeposit(
          reservationKey1,
          depositor.address,
          defaultDepositAmount,
          unroutedVault,
          now - twoHours
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Deposit not routed to the reservation vault")
      })
    })

    describe("guard 7: pendingReservedDeposit[key].walletPubKeyHash == walletPubKeyHash", () => {
      it("should revert if wallet is not the deposit's designated wallet", async () => {
        await setupValidDeposit()
        const differentWalletPubKeyHash =
          "0x2222222222222222222222222222222222222222"
        await testReservation.registerWallet(
          differentWalletPubKeyHash,
          walletState.Live
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(
              reservationKey1,
              differentWalletPubKeyHash
            )
        ).to.be.revertedWith("Wallet is not the deposit's designated wallet")
      })
    })

    describe("guard 8: reservations[key].state == Unknown", () => {
      it("should revert if reservation already exists (state == Active)", async () => {
        await setupValidDeposit()
        await testReservation.setReservationState(
          reservationKey1,
          reservationState.Active
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Reservation already exists")
      })

      it("should revert if reservation already exists (state == Closed)", async () => {
        await setupValidDeposit()
        await testReservation.setReservationState(
          reservationKey1,
          reservationState.Closed
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Reservation already exists")
      })
    })

    describe("guard 9: getAction(key, requestNonce).state != Pending", () => {
      it("should revert if acceptance is already pending", async () => {
        await setupValidDeposit()

        // First request succeeds
        await testReservation
          .connect(depositor)
          .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

        // Second request before settle should revert because action is pending
        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Acceptance already pending")
      })
    })

    describe("guard 10: registeredWallets[walletPubKeyHash].state == Live", () => {
      it("should revert if wallet is in Closed state", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          walletStateVal: walletState.Closed,
        })

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Wallet must be in Live state")
      })

      it("should revert if wallet is in MovingFunds state", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          walletStateVal: walletState.MovingFunds,
        })

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Wallet must be in Live state")
      })

      it("should revert if wallet is in Terminated state", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          walletStateVal: walletState.Terminated,
        })

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Wallet must be in Live state")
      })

      it("should revert if wallet is in Unknown state", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          walletStateVal: walletState.Unknown,
        })

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Wallet must be in Live state")
      })
    })

    describe("guard 11: deposit.amount >= reservationMinAmount + reservationTxMaxFee", () => {
      it("should revert if deposit amount is smaller than min amount + tx max fee (amount == min + fee - 1)", async () => {
        const minAmount = 100000
        const txMaxFee = 10000
        const tooSmallAmount = minAmount + txMaxFee - 1 // 109999

        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          minAmount,
          txMaxFee,
          depositAmount: tooSmallAmount,
        })

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Deposit amount too small for a reservation")
      })

      it("should succeed if deposit amount equals min amount + tx max fee (amount == min + fee)", async () => {
        const minAmount = 100000
        const txMaxFee = 10000
        const exactAmount = minAmount + txMaxFee // 110000

        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          minAmount,
          txMaxFee,
          depositAmount: exactAmount,
        })

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.not.be.reverted
      })
    })

    describe("guards 12-14: window math +/- 1s", () => {
      it("should succeed when timeoutAt + 24h == refundDeadline (close bound exact)", async () => {
        const actionTimeout = 14400 // 4 hours
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          actionTimeout,
        })
        const now = await lastBlockTime()
        const nextBlockTimestamp = now + 10
        const timeoutAt = nextBlockTimestamp + actionTimeout
        const refundDeadline = timeoutAt + twentyFourHours

        await testReservation.initializeProducerStub(
          reservationKey1,
          walletPubKeyHash,
          refundDeadline,
          depositor.address
        )

        await ethers.provider.send("evm_setNextBlockTimestamp", [
          nextBlockTimestamp,
        ])

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.not.be.reverted
      })

      it("should revert when timeoutAt + 24h == refundDeadline + 1s (Authorization window would overlap the deposit refund window)", async () => {
        const actionTimeout = 14400 // 4 hours
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          actionTimeout,
        })
        const now = await lastBlockTime()
        const nextBlockTimestamp = now + 10
        const timeoutAt = nextBlockTimestamp + actionTimeout
        // refundDeadline is 1s too small, so timeoutAt + 24h > refundDeadline
        const refundDeadline = timeoutAt + twentyFourHours - 1

        await testReservation.initializeProducerStub(
          reservationKey1,
          walletPubKeyHash,
          refundDeadline,
          depositor.address
        )

        await ethers.provider.send("evm_setNextBlockTimestamp", [
          nextBlockTimestamp,
        ])

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith(
          "Authorization window would overlap the deposit refund window"
        )
      })

      it("should revert when action timeout is too short for signing window (earliestSigningAt >= actionSigningDeadline)", async () => {
        // If actionTimeout <= 2h (7200s), timeoutAt = now + 7200
        // actionSigningDeadline = timeoutAt - 2h = now
        // earliestSigningAt = now + 1 > now, so no signing window
        const actionTimeout = twoHours // 7200s
        const now = await lastBlockTime()
        const revealedAt = now - twoHours
        const refundDeadline = now + 1000000

        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          actionTimeout,
          revealedAt,
          refundDeadline,
        })

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Acceptance authorization has no signing window")
      })

      it("should revert when refund deadline is too close to earliest signing time (earliestSigningAt >= refundDeadline - 24h)", async () => {
        // If refundDeadline = now + 24h, refundDeadline - 24h = now
        // earliestSigningAt = now + 1 > now, so earliestSigningAt >= refundDeadline - 24h
        const actionTimeout = 14400
        const now = await lastBlockTime()
        const revealedAt = now - twoHours
        const refundDeadline = now + twentyFourHours // too close

        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          actionTimeout,
          revealedAt,
          refundDeadline,
        })

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith(
          "Authorization window would overlap the deposit refund window"
        )
      })

      it("should revert when refund deadline <= 24h", async () => {
        const actionTimeout = 14400
        const now = await lastBlockTime()
        const revealedAt = now - twoHours
        const refundDeadline = twentyFourHours // exactly 24h (not > 24h)

        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          actionTimeout,
          revealedAt,
          refundDeadline,
        })

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith(
          "Authorization window would overlap the deposit refund window"
        )
      })
    })

    describe("guards 15-18: caps validation", () => {
      it("should revert when single-reservation cap is set and deposit amount exceeds it (Reservation exceeds the single-reservation cap)", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          depositAmount: 5000000,
        })
        await testReservation.setReservationMaxSingleAmount(4000000)

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.be.revertedWith("Reservation exceeds the single-reservation cap")
      })

      it("should succeed when single-reservation cap is 0 (disabled)", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          depositAmount: 5000000,
        })
        await testReservation.setReservationMaxSingleAmount(0)

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey1, walletPubKeyHash)
        ).to.not.be.reverted
      })

      it("should revert when total reserved amount exceeds reservationMaxTotalAmount (Total reserved amount cap exceeded)", async () => {
        // Set max total cap = 1,500,000
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          depositAmount: 1000000,
        })
        await testReservation.setReservationMaxTotalAmount(1500000)

        // First request of 1,000,000 succeeds (total becomes 1,000,000)
        await testReservation
          .connect(depositor)
          .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

        expect(await testReservation.reservationTotalAmount()).to.equal(1000000)

        // Seed second deposit with 600,000 (1,000,000 + 600,000 = 1,600,000 > 1,500,000)
        const now = await lastBlockTime()
        await testReservation.seedDeposit(
          reservationKey2,
          depositor.address,
          600000,
          vault.address,
          now - twoHours
        )
        await testReservation.initializeProducerStub(
          reservationKey2,
          walletPubKeyHash,
          now + defaultActionTimeout + twentyFourHours + twoHours,
          depositor.address
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey2, walletPubKeyHash)
        ).to.be.revertedWith("Total reserved amount cap exceeded")
      })

      it("should revert when wallet reservations count exceeds maxReservationsPerWallet (Wallet reservations cap exceeded)", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash)
        await testReservation.setMaxReservationsPerWallet(1)

        // First request succeeds
        await testReservation
          .connect(depositor)
          .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

        expect(
          await testReservation.walletReservationsCount(walletPubKeyHash)
        ).to.equal(1)

        // Seed second deposit for same wallet
        const now = await lastBlockTime()
        await testReservation.seedDeposit(
          reservationKey2,
          depositor.address,
          defaultDepositAmount,
          vault.address,
          now - twoHours
        )
        await testReservation.initializeProducerStub(
          reservationKey2,
          walletPubKeyHash,
          now + defaultActionTimeout + twentyFourHours + twoHours,
          depositor.address
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey2, walletPubKeyHash)
        ).to.be.revertedWith("Wallet reservations cap exceeded")
      })

      it("should revert when wallet reservations amount exceeds maxReservationsAmountPerWallet (Wallet reserved amount cap exceeded)", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          depositAmount: 1000000,
        })
        await testReservation.setMaxReservationsAmountPerWallet(1500000)

        // First request of 1,000,000 succeeds
        await testReservation
          .connect(depositor)
          .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

        expect(
          await testReservation.walletReservationsAmount(walletPubKeyHash)
        ).to.equal(1000000)

        // Seed second deposit of 600,000 for same wallet (total 1,600,000 > 1,500,000)
        const now = await lastBlockTime()
        await testReservation.seedDeposit(
          reservationKey2,
          depositor.address,
          600000,
          vault.address,
          now - twoHours
        )
        await testReservation.initializeProducerStub(
          reservationKey2,
          walletPubKeyHash,
          now + defaultActionTimeout + twentyFourHours + twoHours,
          depositor.address
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey2, walletPubKeyHash)
        ).to.be.revertedWith("Wallet reserved amount cap exceeded")
      })

      it("should succeed when maxReservationsAmountPerWallet is 0 (disabled)", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash, {
          depositAmount: 1000000,
        })
        await testReservation.setMaxReservationsAmountPerWallet(0)

        // First request
        await testReservation
          .connect(depositor)
          .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

        // Seed second deposit of 2,000,000
        const now = await lastBlockTime()
        await testReservation.seedDeposit(
          reservationKey2,
          depositor.address,
          2000000,
          vault.address,
          now - twoHours
        )
        await testReservation.initializeProducerStub(
          reservationKey2,
          walletPubKeyHash,
          now + defaultActionTimeout + twentyFourHours + twoHours,
          depositor.address
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey2, walletPubKeyHash)
        ).to.not.be.reverted

        expect(
          await testReservation.walletReservationsAmount(walletPubKeyHash)
        ).to.equal(3000000)
      })
    })

    describe("guard 19: maxActiveReservations occupancy limit", () => {
      it("should allow multiple reservations when maxActiveReservations is 0 (disabled)", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash)
        await testReservation.setMaxActiveReservations(0)

        // First request
        await testReservation
          .connect(depositor)
          .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

        expect(await testReservation.activeReservationsCount()).to.equal(1)

        // Seed and request second deposit
        const now = await lastBlockTime()
        await testReservation.seedDeposit(
          reservationKey2,
          depositor.address,
          defaultDepositAmount,
          vault.address,
          now - twoHours
        )
        await testReservation.initializeProducerStub(
          reservationKey2,
          walletPubKeyHash,
          now + defaultActionTimeout + twentyFourHours + twoHours,
          depositor.address
        )

        await testReservation
          .connect(depositor)
          .requestReservationAcceptance(reservationKey2, walletPubKeyHash)

        expect(await testReservation.activeReservationsCount()).to.equal(2)
      })

      it("should revert when activeReservationsCount reaches maxActiveReservations (Active reservations cap exceeded)", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash)
        await testReservation.setMaxActiveReservations(1)

        // First request fills the capacity
        await testReservation
          .connect(depositor)
          .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

        expect(await testReservation.activeReservationsCount()).to.equal(1)

        // Seed second deposit
        const now = await lastBlockTime()
        await testReservation.seedDeposit(
          reservationKey2,
          depositor.address,
          defaultDepositAmount,
          vault.address,
          now - twoHours
        )
        await testReservation.initializeProducerStub(
          reservationKey2,
          walletPubKeyHash,
          now + defaultActionTimeout + twentyFourHours + twoHours,
          depositor.address
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey2, walletPubKeyHash)
        ).to.be.revertedWith("Active reservations cap exceeded")
      })

      it("should allow a new request after strandReservation decrements activeReservationsCount", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash)
        await testReservation.setMaxActiveReservations(1)

        // First request fills the occupancy
        await testReservation
          .connect(depositor)
          .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

        expect(await testReservation.activeReservationsCount()).to.equal(1)

        // Set anchorAmount, walletPubKeyHash, and add wallet key on reservation1 so stranding correctly unwinds
        await testReservation.setReservationAnchorAmount(
          reservationKey1,
          defaultDepositAmount
        )
        await testReservation.setReservationWalletPubKeyHash(
          reservationKey1,
          walletPubKeyHash
        )
        await testReservation.addWalletReservationKey(
          walletPubKeyHash,
          reservationKey1
        )

        // Strand the first reservation
        await testReservation.strandReservation(reservationKey1)

        // Seed second deposit and request acceptance
        const now = await lastBlockTime()
        await testReservation.seedDeposit(
          reservationKey2,
          depositor.address,
          defaultDepositAmount,
          vault.address,
          now - twoHours
        )
        await testReservation.initializeProducerStub(
          reservationKey2,
          walletPubKeyHash,
          now + defaultActionTimeout + twentyFourHours + twoHours,
          depositor.address
        )

        await expect(
          testReservation
            .connect(depositor)
            .requestReservationAcceptance(reservationKey2, walletPubKeyHash)
        ).to.not.be.reverted

        expect(await testReservation.activeReservationsCount()).to.equal(1)
      })
    })

    describe("step 20: state mutations and event emission", () => {
      it("should record action, increment nonce, update counters, and emit ReservationAcceptanceRequested", async () => {
        await setupValidDeposit(reservationKey1, walletPubKeyHash)

        const now = await lastBlockTime()
        const nextBlockTimestamp = now + 10
        await ethers.provider.send("evm_setNextBlockTimestamp", [
          nextBlockTimestamp,
        ])

        const expectedTimeoutAt = nextBlockTimestamp + defaultActionTimeout

        const tx = await testReservation
          .connect(depositor)
          .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

        // Verify event
        await expect(tx)
          .to.emit(testReservation, "ReservationAcceptanceRequested")
          .withArgs(
            reservationKey1,
            1, // requestNonce
            walletPubKeyHash,
            defaultDepositAmount,
            defaultTxMaxFee,
            expectedTimeoutAt
          )

        // Verify reservation state
        const res = await testReservation.getReservation(reservationKey1)
        expect(res.requestNonce).to.equal(1)

        // Verify action record
        const action = await testReservation.getAction(reservationKey1, 1)
        expect(action.actionType).to.equal(actionType.Acceptance)
        expect(action.state).to.equal(actionState.Pending)
        expect(action.requestedAt).to.equal(nextBlockTimestamp)
        expect(action.timeoutAt).to.equal(expectedTimeoutAt)
        expect(action.txMaxFee).to.equal(defaultTxMaxFee)
        expect(action.targetWalletPubKeyHash.toLowerCase()).to.equal(
          walletPubKeyHash.toLowerCase()
        )
        expect(action.amount).to.equal(defaultDepositAmount)

        // Verify storage counters
        expect(await testReservation.reservationTotalAmount()).to.equal(
          defaultDepositAmount
        )
        expect(
          await testReservation.walletReservationsCount(walletPubKeyHash)
        ).to.equal(1)
        expect(
          await testReservation.walletReservationsAmount(walletPubKeyHash)
        ).to.equal(defaultDepositAmount)
        expect(await testReservation.activeReservationsCount()).to.equal(1)
      })
    })
  })

  describe("strandReservation", () => {
    it("should decrement counts, remove wallet key, update state to Stranded, clear anchor UTXO mapping, and emit ReservationStranded", async () => {
      await setupValidDeposit(reservationKey1, walletPubKeyHash)

      // Request acceptance first
      await testReservation
        .connect(depositor)
        .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

      const anchorAmount = defaultDepositAmount
      const anchorTxHash = ethers.utils.hexZeroPad("0xa1b2c3", 32)
      const anchorTxOutputIndex = 0

      // Seed reservation anchor fields and wallet enumeration key
      await testReservation.setReservationAnchorAmount(
        reservationKey1,
        anchorAmount
      )
      await testReservation.setReservationWalletPubKeyHash(
        reservationKey1,
        walletPubKeyHash
      )
      await testReservation.setReservationAnchorUtxo(
        reservationKey1,
        anchorTxHash,
        anchorTxOutputIndex
      )
      await testReservation.addWalletReservationKey(
        walletPubKeyHash,
        reservationKey1
      )
      expect(
        await testReservation.getWalletReservationKeys(walletPubKeyHash)
      ).to.deep.equal([ethers.BigNumber.from(reservationKey1)])
      expect(
        await testReservation.getReservationByAnchorUtxo(
          anchorTxHash,
          anchorTxOutputIndex
        )
      ).to.equal(ethers.BigNumber.from(reservationKey1))

      const tx = await testReservation.strandReservation(reservationKey1)

      // Verify event emission
      await expect(tx)
        .to.emit(testReservation, "ReservationStranded")
        .withArgs(
          reservationKey1,
          walletPubKeyHash,
          depositor.address,
          anchorAmount
        )

      // Verify counters decremented
      expect(
        await testReservation.walletReservationsCount(walletPubKeyHash)
      ).to.equal(0)
      expect(
        await testReservation.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(0)
      expect(await testReservation.reservationTotalAmount()).to.equal(0)
      expect(await testReservation.activeReservationsCount()).to.equal(0)

      // Verify wallet key removed
      expect(
        await testReservation.getWalletReservationKeys(walletPubKeyHash)
      ).to.deep.equal([])
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey1)
      ).to.equal(0)

      // Verify state changed to Stranded
      const res = await testReservation.getReservation(reservationKey1)
      expect(res.state).to.equal(reservationState.Stranded)

      // Verify anchor UTXO mapping cleared
      expect(
        await testReservation.getReservationByAnchorUtxo(
          anchorTxHash,
          anchorTxOutputIndex
        )
      ).to.equal(0)
    })

    it("should not emit a second ReservationStranded event when stranding an already-stranded reservation", async () => {
      await setupValidDeposit(reservationKey1, walletPubKeyHash)

      await testReservation
        .connect(depositor)
        .requestReservationAcceptance(reservationKey1, walletPubKeyHash)

      const anchorAmount = defaultDepositAmount
      await testReservation.setReservationAnchorAmount(
        reservationKey1,
        anchorAmount
      )
      await testReservation.setReservationWalletPubKeyHash(
        reservationKey1,
        walletPubKeyHash
      )
      await testReservation.addWalletReservationKey(
        walletPubKeyHash,
        reservationKey1
      )
      // First strand
      const tx1 = await testReservation.strandReservation(reservationKey1)
      await expect(tx1).to.emit(testReservation, "ReservationStranded")

      // Before second strand, seed dummy capacity to prevent underflow on second strand call
      await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
      await testReservation.setWalletReservationsAmount(
        walletPubKeyHash,
        anchorAmount
      )
      await testReservation.setReservationTotalAmount(anchorAmount)
      await testReservation.setActiveReservationsCount(1)
      await testReservation.addWalletReservationKey(
        walletPubKeyHash,
        reservationKey1
      )
      // Second strand on already Stranded reservation
      const tx2 = await testReservation.strandReservation(reservationKey1)
      await expect(tx2).to.not.emit(testReservation, "ReservationStranded")
    })
  })

  describe("removeWalletReservationKey", () => {
    it("should swap-remove middle key from wallet keys array and update indices correctly", async () => {
      // Add 3 keys: [key1, key2, key3]
      await testReservation.addWalletReservationKey(
        walletPubKeyHash,
        reservationKey1
      )
      await testReservation.addWalletReservationKey(
        walletPubKeyHash,
        reservationKey2
      )
      await testReservation.addWalletReservationKey(
        walletPubKeyHash,
        reservationKey3
      )

      expect(
        await testReservation.getWalletReservationKeys(walletPubKeyHash)
      ).to.deep.equal([
        ethers.BigNumber.from(reservationKey1),
        ethers.BigNumber.from(reservationKey2),
        ethers.BigNumber.from(reservationKey3),
      ])
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey1)
      ).to.equal(1)
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey2)
      ).to.equal(2)
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey3)
      ).to.equal(3)

      // Remove middle key (key2) -> array should become [key1, key3]
      await testReservation.removeWalletReservationKey(
        walletPubKeyHash,
        reservationKey2
      )

      expect(
        await testReservation.getWalletReservationKeys(walletPubKeyHash)
      ).to.deep.equal([
        ethers.BigNumber.from(reservationKey1),
        ethers.BigNumber.from(reservationKey3),
      ])
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey1)
      ).to.equal(1)
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey2)
      ).to.equal(0)
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey3)
      ).to.equal(2) // key3 was swapped into index 1 (index-plus-one = 2)
    })

    it("should remove last key from wallet keys array and update indices correctly", async () => {
      await testReservation.addWalletReservationKey(
        walletPubKeyHash,
        reservationKey1
      )
      await testReservation.addWalletReservationKey(
        walletPubKeyHash,
        reservationKey2
      )

      // Remove last key (key2)
      await testReservation.removeWalletReservationKey(
        walletPubKeyHash,
        reservationKey2
      )

      expect(
        await testReservation.getWalletReservationKeys(walletPubKeyHash)
      ).to.deep.equal([ethers.BigNumber.from(reservationKey1)])
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey2)
      ).to.equal(0)
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey1)
      ).to.equal(1)
    })

    it("should no-op gracefully when removing a non-existent key", async () => {
      await testReservation.addWalletReservationKey(
        walletPubKeyHash,
        reservationKey1
      )

      // Remove key that was never added
      await testReservation.removeWalletReservationKey(
        walletPubKeyHash,
        reservationKey2
      )

      expect(
        await testReservation.getWalletReservationKeys(walletPubKeyHash)
      ).to.deep.equal([ethers.BigNumber.from(reservationKey1)])
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey1)
      ).to.equal(1)
      expect(
        await testReservation.getWalletReservationKeyIndex(reservationKey2)
      ).to.equal(0)
    })
  })

  describe("actionKey", () => {
    it("should produce correct action keys", async () => {
      const reservationKey = 1
      const requestNonce = 2
      const expectedKey = ethers.utils.solidityKeccak256(
        ["uint256", "uint64"],
        [reservationKey, requestNonce]
      )
      expect(
        await testReservation.actionKey(reservationKey, requestNonce)
      ).to.equal(expectedKey)
    })

    it("should be sensitive to argument order", async () => {
      const key1 = await testReservation.actionKey(1, 2)
      const key2 = await testReservation.actionKey(2, 1)
      expect(key1).to.not.equal(key2)
    })
  })

  describe("anchorUtxoHash", () => {
    it("should produce correct hash and react to input changes", async () => {
      const reservationKey = 123
      const anchorTxHash = ethers.utils.hexlify(ethers.utils.randomBytes(32))
      const anchorTxOutputIndex = 0
      await testReservation.setReservationAnchor(
        reservationKey,
        anchorTxHash,
        anchorTxOutputIndex
      )

      const expectedHash = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [anchorTxHash, anchorTxOutputIndex]
      )
      expect(await testReservation.anchorUtxoHash(reservationKey)).to.equal(
        expectedHash
      )

      // Changing the anchor tx hash must change the resulting hash.
      const newAnchorTxHash = ethers.utils.hexlify(ethers.utils.randomBytes(32))
      await testReservation.setReservationAnchor(
        reservationKey,
        newAnchorTxHash,
        anchorTxOutputIndex
      )
      expect(await testReservation.anchorUtxoHash(reservationKey)).to.not.equal(
        expectedHash
      )

      // Changing only the output index (same tx hash) must also change it.
      const newOutputIndex = 1
      await testReservation.setReservationAnchor(
        reservationKey,
        newAnchorTxHash,
        newOutputIndex
      )
      const expectedHashNewIndex = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [newAnchorTxHash, newOutputIndex]
      )
      expect(await testReservation.anchorUtxoHash(reservationKey)).to.equal(
        expectedHashNewIndex
      )
    })
  })

  // A single well-formed P2WPKH (witness v0, 20-byte program) output:
  // varint(count=1) | value (8-byte LE, 99500 sat) | scriptLen (0x16=22) |
  // 0x0014 (OP_0 PUSH20) | 20-byte pubkey hash.
  const anchorPubKeyHash = "0xaf802a76c10b6a646fff8d358241c121c9be1c53"
  const singleOutputBody =
    "ac84010000000000160014af802a76c10b6a646fff8d358241c121c9be1c53"
  const singleOutput = `0x01${singleOutputBody}`
  // The same output repeated twice, with a matching count=2 prefix.
  const multiOutput = `0x02${singleOutputBody}${singleOutputBody}`

  describe("parseSingleOutput", () => {
    it("should parse a single-output vector successfully", async () => {
      const output = await testReservation.parseSingleOutput(singleOutput)
      // The parsed output is the value+script slice with the leading
      // varint count byte stripped off.
      expect(output).to.equal(`0x${singleOutputBody}`)
    })

    it("should revert for a multi-output vector", async () => {
      await expect(
        testReservation.parseSingleOutput(multiOutput)
      ).to.be.revertedWith("Reservation transaction must have a single output")
    })
  })

  describe("validateAnchorOutput", () => {
    // The single output above carries 99500 satoshi.
    const anchorAmount = 99500
    const amount = 100000
    const txMaxFee = 1000

    it("should validate a correct anchor output and return its amount", async () => {
      expect(
        await testReservation.callStatic.validateAnchorOutput(
          singleOutput,
          anchorPubKeyHash,
          amount,
          txMaxFee
        )
      ).to.equal(anchorAmount)
    })

    it("should revert when the output pays the wrong wallet", async () => {
      const wrongPubKeyHash = `0x${"11".repeat(20)}`
      await expect(
        testReservation.validateAnchorOutput(
          singleOutput,
          wrongPubKeyHash,
          amount,
          txMaxFee
        )
      ).to.be.revertedWith("Anchor output must pay the authorized wallet")
    })

    it("should revert when the fee exceeds the snapshotted bound", async () => {
      // amount(100000) - anchorAmount(99500) = 500 <= 1000 normally passes;
      // raise the requested amount so the implied fee (200000 -> 99500,
      // difference 100500) blows past the 1000 satoshi bound.
      const tooHighAmount = 200000
      await expect(
        testReservation.validateAnchorOutput(
          singleOutput,
          anchorPubKeyHash,
          tooHighAmount,
          txMaxFee
        )
      ).to.be.revertedWith("Transaction fee is too high")
    })
    it("should succeed at the fee-bound boundary (amount - anchorAmount == txMaxFee)", async () => {
      const boundaryAmount = anchorAmount + txMaxFee
      expect(
        await testReservation.callStatic.validateAnchorOutput(
          singleOutput,
          anchorPubKeyHash,
          boundaryAmount,
          txMaxFee
        )
      ).to.equal(anchorAmount)
    })

    it("should revert on underflow when amount < anchorAmount", async () => {
      const underflowAmount = anchorAmount - 1
      await expect(
        testReservation.validateAnchorOutput(
          singleOutput,
          anchorPubKeyHash,
          underflowAmount,
          txMaxFee
        )
      ).to.be.reverted
    })
  })
  describe("requireCurrentSourceAnchor", () => {
    const reservationKey = 1
    const requestNonce = 1
    const anchorTxHash = `0x${"11".repeat(32)}`
    const anchorTxOutputIndex = 1

    it("should not revert when anchors match", async () => {
      await testReservation.setReservationAnchor(
        reservationKey,
        anchorTxHash,
        anchorTxOutputIndex
      )
      const expectedHash = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [anchorTxHash, anchorTxOutputIndex]
      )
      await testReservation.setActionSourceAnchorUtxoHash(
        reservationKey,
        requestNonce,
        expectedHash
      )
      await testReservation.requireCurrentSourceAnchor(
        reservationKey,
        requestNonce
      )
    })

    it("should revert when anchors mismatch", async () => {
      await testReservation.setReservationAnchor(
        reservationKey,
        anchorTxHash,
        anchorTxOutputIndex
      )
      const wrongHash = ethers.utils.solidityKeccak256(
        ["bytes32", "uint32"],
        [anchorTxHash, 2] // Wrong index
      )
      await testReservation.setActionSourceAnchorUtxoHash(
        reservationKey,
        requestNonce,
        wrongHash
      )
      await expect(
        testReservation.requireCurrentSourceAnchor(reservationKey, requestNonce)
      ).to.be.revertedWith("Action source anchor is no longer current")
    })
  })
  describe("strand functions", () => {
    const reservationKey = 100
    const requestNonce = 1
    const walletPubKeyHash = `0x${"11".repeat(20)}`
    const owner = `0x${"22".repeat(20)}`
    const anchorAmount = 100000

    it("should strand reservation when target wallet is closed", async () => {
      // 1. Set wallet state to Closing (one of the three trigger states).
      await testReservation.setWalletState(walletPubKeyHash, 3) // 3 = Closing
      // 2. Set reservation state.
      await testReservation.setReservationFullState(
        reservationKey,
        owner,
        walletPubKeyHash,
        anchorAmount,
        1, // Active
        requestNonce
      )
      // 3. Seed the capacity counters strandReservation will decrement.
      await testReservation.setWalletReservationsCounters(
        walletPubKeyHash,
        1,
        anchorAmount
      )
      await testReservation.setGlobalReservationCounters(anchorAmount, 1)
      // 4. Call strandIfTargetWalletClosed.
      await testReservation.strandIfTargetWalletClosed(
        reservationKey,
        walletPubKeyHash
      )
      // 5. Assert counters were released to zero.
      expect(
        await testReservation.walletReservationsCount(walletPubKeyHash)
      ).to.equal(0)
      expect(
        await testReservation.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(0)
      expect(await testReservation.reservationTotalAmount()).to.equal(0)
      expect(await testReservation.activeReservationsCount()).to.equal(0)
    })

    it("should strand an active reservation and release its capacity exactly once", async () => {
      const strandKey = 101
      await testReservation.setReservationFullState(
        strandKey,
        owner,
        walletPubKeyHash,
        anchorAmount,
        1, // Active
        requestNonce
      )
      await testReservation.setWalletReservationsCounters(
        walletPubKeyHash,
        1,
        anchorAmount
      )
      await testReservation.setGlobalReservationCounters(anchorAmount, 1)

      await testReservation.strandReservation(strandKey)

      expect(await testReservation.reservationState(strandKey)).to.equal(4) // Stranded
      expect(
        await testReservation.walletReservationsCount(walletPubKeyHash)
      ).to.equal(0)
      expect(await testReservation.activeReservationsCount()).to.equal(0)

      // Calling again on an already-Stranded reservation must not
      // double-decrement the now-zero counters (would otherwise underflow).
      await testReservation.strandReservation(strandKey)
      expect(await testReservation.reservationState(strandKey)).to.equal(4)
    })

    it("should not strand when the target wallet is still Live", async () => {
      const key = 103
      await testReservation.setWalletState(walletPubKeyHash, 1) // 1 = Live
      await testReservation.setReservationFullState(
        key,
        owner,
        walletPubKeyHash,
        anchorAmount,
        1, // Active
        requestNonce
      )
      await testReservation.strandLateSettlementIfTargetWalletClosed(
        key,
        false // evidenceAlreadyEmitted
      )
      expect(await testReservation.reservationState(key)).to.equal(1) // still Active
    })

    it("should strand a settlement whose target wallet is Closing", async () => {
      const key = 104
      await testReservation.setWalletState(walletPubKeyHash, 3) // 3 = Closing
      await testReservation.setReservationFullState(
        key,
        owner,
        walletPubKeyHash,
        anchorAmount,
        1, // Active
        requestNonce
      )
      await testReservation.setWalletReservationsCounters(
        walletPubKeyHash,
        1,
        anchorAmount
      )
      await testReservation.setGlobalReservationCounters(anchorAmount, 1)
      await testReservation.strandLateSettlementIfTargetWalletClosed(
        key,
        false // evidenceAlreadyEmitted
      )
      expect(await testReservation.reservationState(key)).to.equal(4) // Stranded
      expect(
        await testReservation.walletReservationsCount(walletPubKeyHash)
      ).to.equal(0)
    })

    it("should strand a settlement whose target wallet is Terminated", async () => {
      const key = 105
      await testReservation.setWalletState(walletPubKeyHash, 5) // 5 = Terminated
      await testReservation.setReservationFullState(
        key,
        owner,
        walletPubKeyHash,
        anchorAmount,
        1, // Active
        requestNonce
      )
      await testReservation.setWalletReservationsCounters(
        walletPubKeyHash,
        1,
        anchorAmount
      )
      await testReservation.setGlobalReservationCounters(anchorAmount, 1)
      await testReservation.strandLateSettlementIfTargetWalletClosed(
        key,
        false // evidenceAlreadyEmitted
      )
      expect(await testReservation.reservationState(key)).to.equal(4) // Stranded
      expect(
        await testReservation.walletReservationsCount(walletPubKeyHash)
      ).to.equal(0)
    })

    it("should handle an already-stranded settlement without double-releasing or re-emitting evidence", async () => {
      // Matches the docblock at ReservationProofs.sol:220-224: when a lineage
      // was already stranded before this proof arrives, calling strand with
      // evidenceAlreadyEmitted=true should not double-release accounting or emit duplicate evidence.
      const key = 106
      await testReservation.setWalletState(walletPubKeyHash, 5) // 5 = Terminated
      await testReservation.setReservationFullState(
        key,
        owner,
        walletPubKeyHash,
        anchorAmount,
        4, // Stranded (already stranded before proof arrived)
        requestNonce
      )
      const tx = await testReservation.strandLateSettlementIfTargetWalletClosed(
        key,
        true // evidenceAlreadyEmitted
      )
      expect(await testReservation.reservationState(key)).to.equal(4) // Stranded
      expect(
        await testReservation.walletReservationsCount(walletPubKeyHash)
      ).to.equal(0)
      await expect(tx).to.not.emit(testReservation, "ReservationStranded")
    })

    it("should release capacity for a non-stranded settlement even when evidence was already emitted", async () => {
      // Decoupling finding: release on pre-call state, event on the flag.
      // A non-Stranded position releases its capacity regardless of evidenceAlreadyEmitted,
      // while the flag suppresses duplicate event emission.
      const key = 107
      await testReservation.setWalletState(walletPubKeyHash, 5) // 5 = Terminated
      await testReservation.setReservationFullState(
        key,
        owner,
        walletPubKeyHash,
        anchorAmount,
        1, // Active
        requestNonce
      )
      await testReservation.setWalletReservationsCounters(
        walletPubKeyHash,
        1,
        anchorAmount
      )
      await testReservation.setGlobalReservationCounters(anchorAmount, 1)
      const tx = await testReservation.strandLateSettlementIfTargetWalletClosed(
        key,
        true // evidenceAlreadyEmitted
      )
      expect(await testReservation.reservationState(key)).to.equal(4) // Stranded
      expect(
        await testReservation.walletReservationsCount(walletPubKeyHash)
      ).to.equal(0)
      expect(
        await testReservation.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(0)
      expect(await testReservation.reservationTotalAmount()).to.equal(0)
      expect(await testReservation.activeReservationsCount()).to.equal(0)
      await expect(tx).to.not.emit(testReservation, "ReservationStranded")
    })

    it("prepareReservationForSettlement should no-op for a non-stranded settleable reservation", async () => {
      const key = 500
      await testReservation.setReservationFullState(
        key,
        owner,
        walletPubKeyHash,
        anchorAmount,
        1, // Active
        requestNonce
      )
      await testReservation.prepareReservationForSettlement(key, false)
      expect(await testReservation.reservationTotalAmount()).to.equal(0)
    })

    it("prepareReservationForSettlement should restore capacity for a late-settled stranded reservation", async () => {
      const key = 501
      await testReservation.setReservationAnchor(key, `0x${"33".repeat(32)}`, 0)
      await testReservation.setReservationFullState(
        key,
        owner,
        walletPubKeyHash,
        anchorAmount,
        4, // Stranded
        requestNonce
      )
      await testReservation.prepareReservationForSettlement(key, true)
      expect(await testReservation.reservationTotalAmount()).to.equal(
        anchorAmount
      )
      expect(
        await testReservation.walletReservationsCount(walletPubKeyHash)
      ).to.equal(1)
      expect(await testReservation.activeReservationsCount()).to.equal(1)
    })

    it("prepareReservationForSettlement should reject an on-time settlement of a stranded reservation", async () => {
      const key = 502
      await testReservation.setReservationFullState(
        key,
        owner,
        walletPubKeyHash,
        anchorAmount,
        4, // Stranded
        requestNonce
      )
      await expect(
        testReservation.prepareReservationForSettlement(key, false)
      ).to.be.revertedWith("Reservation is not settleable")
    })

    it("prepareReservationForSettlement should reject an anchor that was already spent by another generation", async () => {
      const key = 503
      await testReservation.setReservationAnchor(key, `0x${"44".repeat(32)}`, 0)
      await testReservation.setReservationFullState(
        key,
        owner,
        walletPubKeyHash,
        anchorAmount,
        4, // Stranded
        requestNonce
      )
      await testReservation.setSpentMainUtxo(key, true)
      await expect(
        testReservation.prepareReservationForSettlement(key, true)
      ).to.be.revertedWith("Reservation anchor already spent")
    })
  })

  describe("loadSettleableAction", () => {
    const reservationKey = 300
    const requestNonce = 1
    const targetWalletPubKeyHash = `0x${"11".repeat(20)}`

    it("should report a pending action as not late", async () => {
      await testReservation.setFullAction(
        reservationKey,
        requestNonce,
        3, // Reanchor
        1, // Pending
        1,
        targetWalletPubKeyHash,
        1000
      )
      expect(
        await testReservation.callStatic.loadSettleableAction(
          reservationKey,
          requestNonce,
          3 // Reanchor
        )
      ).to.equal(false)
    })

    it("should report a timed-out action as late", async () => {
      await testReservation.setFullAction(
        reservationKey,
        requestNonce,
        3, // Reanchor
        3, // TimedOut
        1,
        targetWalletPubKeyHash,
        1000
      )
      expect(
        await testReservation.callStatic.loadSettleableAction(
          reservationKey,
          requestNonce,
          3 // Reanchor
        )
      ).to.equal(true)
    })

    it("should revert on an action type mismatch", async () => {
      await testReservation.setFullAction(
        reservationKey,
        requestNonce,
        3, // Reanchor
        1, // Pending
        1,
        targetWalletPubKeyHash,
        1000
      )
      await expect(
        testReservation.callStatic.loadSettleableAction(
          reservationKey,
          requestNonce,
          1 // Acceptance
        )
      ).to.be.revertedWith("Action type mismatch")
    })

    it("should revert when the action is already settled", async () => {
      await testReservation.setFullAction(
        reservationKey,
        requestNonce,
        3, // Reanchor
        2, // Settled
        1,
        targetWalletPubKeyHash,
        1000
      )
      await expect(
        testReservation.callStatic.loadSettleableAction(
          reservationKey,
          requestNonce,
          3 // Reanchor
        )
      ).to.be.revertedWith("Action is not settleable")
    })
  })

  describe("notifyReservationAcceptanceTimedOut", () => {
    it("should time out a pending acceptance and release its capacity", async () => {
      const reservationKey = 400
      const targetWalletPubKeyHash = `0x${"11".repeat(20)}`
      const amount = 1000

      // reservation.requestNonce defaults to 0, so the action must be keyed
      // at requestNonce 0 to be the reservation's current generation.
      await testReservation.setFullAction(
        reservationKey,
        0,
        1, // Acceptance
        1, // Pending
        1, // timeoutAt: far in the past, so the timeout check passes
        targetWalletPubKeyHash,
        amount
      )
      await testReservation.setWalletReservationsCounters(
        targetWalletPubKeyHash,
        1,
        amount
      )
      await testReservation.setGlobalReservationCounters(amount, 1)

      await testReservation.notifyReservationAcceptanceTimedOut(reservationKey)

      expect(await testReservation.actionState(reservationKey, 0)).to.equal(3) // TimedOut
      expect(
        await testReservation.walletReservationsCount(targetWalletPubKeyHash)
      ).to.equal(0)
      expect(await testReservation.reservationTotalAmount()).to.equal(0)
      expect(await testReservation.activeReservationsCount()).to.equal(0)
      // Acceptance timeout reverts the position to Unknown (its
      // pre-request state), not Active -- it was never a custodied
      // reservation.
      expect(await testReservation.reservationState(reservationKey)).to.equal(0) // Unknown
    })
  })

  describe("notifyReservationActionTimeout", () => {
    const reservationKey = 500
    const requestNonce = 1
    const sourceWalletPubKeyHash = `0x${"11".repeat(20)}`
    const targetWalletPubKeyHash = `0x${"22".repeat(20)}`
    const amount = 1000
    const actionTimeout = 14400 // 4 hours

    it("should time out a pending reanchor action, release target wallet capacity, restore reservation to Active, and set reanchor cooldown", async () => {
      await testReservation.setReservationActionTimeout(actionTimeout)

      // Set reservation in ActionPending state with requestNonce = 1, custodied by source wallet
      await testReservation.setReservationFullState(
        reservationKey,
        depositor.address,
        sourceWalletPubKeyHash,
        amount,
        reservationState.ActionPending,
        requestNonce
      )

      // Set the pending Reanchor action for (reservationKey, requestNonce) with timeoutAt in the past
      const requestedAt = 0 // default uninitialized value in action struct
      const timeoutAt = 1 // timeoutAt: far in the past
      await testReservation.setFullAction(
        reservationKey,
        requestNonce,
        actionType.Reanchor,
        actionState.Pending,
        timeoutAt,
        targetWalletPubKeyHash,
        amount
      )

      // Seed target wallet counters (which should be decremented) and source wallet counters (which should be untouched)
      await testReservation.setWalletReservationsCounters(
        targetWalletPubKeyHash,
        2,
        amount * 2
      )
      await testReservation.setWalletReservationsCounters(
        sourceWalletPubKeyHash,
        1,
        amount
      )

      const tx = await testReservation.notifyReservationActionTimeout(
        reservationKey,
        []
      )
      const receipt = await tx.wait()
      const block = await ethers.provider.getBlock(receipt.blockNumber)

      // 1. Action state transitions to TimedOut
      expect(
        await testReservation.actionState(reservationKey, requestNonce)
      ).to.equal(actionState.TimedOut)

      // 2. Target wallet capacity and count are released (decremented)
      expect(
        await testReservation.walletReservationsCount(targetWalletPubKeyHash)
      ).to.equal(1)
      expect(
        await testReservation.walletReservationsAmount(targetWalletPubKeyHash)
      ).to.equal(amount)

      // 3. Source wallet counters remain untouched
      expect(
        await testReservation.walletReservationsCount(sourceWalletPubKeyHash)
      ).to.equal(1)
      expect(
        await testReservation.walletReservationsAmount(sourceWalletPubKeyHash)
      ).to.equal(amount)

      // 4. Reservation state returns to Active
      expect(await testReservation.reservationState(reservationKey)).to.equal(
        reservationState.Active
      )

      // 5. Reanchor cooldown is set to block.timestamp + (action.timeoutAt - action.requestedAt)
      const res = await testReservation.getReservation(reservationKey)
      expect(res.reanchorCooldownUntil).to.equal(
        block.timestamp + (timeoutAt - requestedAt)
      )
    })

    it("should revert if action type is not Reanchor", async () => {
      await testReservation.setReservationFullState(
        reservationKey,
        depositor.address,
        sourceWalletPubKeyHash,
        amount,
        reservationState.ActionPending,
        requestNonce
      )
      await testReservation.setFullAction(
        reservationKey,
        requestNonce,
        actionType.Acceptance,
        actionState.Pending,
        1,
        targetWalletPubKeyHash,
        amount
      )

      await expect(
        testReservation.notifyReservationActionTimeout(reservationKey, [])
      ).to.be.revertedWith("Unsupported action type for timeout")
    })

    it("should revert if reservation is not in ActionPending state", async () => {
      await testReservation.setReservationFullState(
        reservationKey,
        depositor.address,
        sourceWalletPubKeyHash,
        amount,
        reservationState.Active,
        requestNonce
      )
      await testReservation.setFullAction(
        reservationKey,
        requestNonce,
        actionType.Reanchor,
        actionState.Pending,
        1,
        targetWalletPubKeyHash,
        amount
      )

      await expect(
        testReservation.notifyReservationActionTimeout(reservationKey, [])
      ).to.be.revertedWith("Reservation is not in ActionPending state")
    })

    it("should revert if action is not pending", async () => {
      await testReservation.setReservationFullState(
        reservationKey,
        depositor.address,
        sourceWalletPubKeyHash,
        amount,
        reservationState.ActionPending,
        requestNonce
      )
      await testReservation.setFullAction(
        reservationKey,
        requestNonce,
        actionType.Reanchor,
        actionState.Settled,
        1,
        targetWalletPubKeyHash,
        amount
      )

      await expect(
        testReservation.notifyReservationActionTimeout(reservationKey, [])
      ).to.be.revertedWith("Action is not pending")
    })

    it("should revert if action has not timed out yet", async () => {
      const now = await lastBlockTime()
      await testReservation.setReservationFullState(
        reservationKey,
        depositor.address,
        sourceWalletPubKeyHash,
        amount,
        reservationState.ActionPending,
        requestNonce
      )
      await testReservation.setFullAction(
        reservationKey,
        requestNonce,
        actionType.Reanchor,
        actionState.Pending,
        now + 1000,
        targetWalletPubKeyHash,
        amount
      )

      await expect(
        testReservation.notifyReservationActionTimeout(reservationKey, [])
      ).to.be.revertedWith("Action has not timed out")
    })

    it("should succeed when called after advancing time past timeoutAt", async () => {
      const now = await lastBlockTime()
      const timeoutAt = now + 500
      await testReservation.setReservationActionTimeout(actionTimeout)
      await testReservation.setReservationFullState(
        reservationKey,
        depositor.address,
        sourceWalletPubKeyHash,
        amount,
        reservationState.ActionPending,
        requestNonce
      )
      await testReservation.setFullAction(
        reservationKey,
        requestNonce,
        actionType.Reanchor,
        actionState.Pending,
        timeoutAt,
        targetWalletPubKeyHash,
        amount
      )
      await testReservation.setWalletReservationsCounters(
        targetWalletPubKeyHash,
        1,
        amount
      )

      // Calling before timeoutAt reverts
      await expect(
        testReservation.notifyReservationActionTimeout(reservationKey, [])
      ).to.be.revertedWith("Action has not timed out")

      // Advance time past timeoutAt
      await increaseTime(501)

      // Calling now succeeds
      await testReservation.notifyReservationActionTimeout(reservationKey, [])
      expect(
        await testReservation.actionState(reservationKey, requestNonce)
      ).to.equal(actionState.TimedOut)
      expect(await testReservation.reservationState(reservationKey)).to.equal(
        reservationState.Active
      )
      expect(
        await testReservation.walletReservationsCount(targetWalletPubKeyHash)
      ).to.equal(0)
      expect(
        await testReservation.walletReservationsAmount(targetWalletPubKeyHash)
      ).to.equal(0)
    })
  })

  describe("requestReservationAcceptance", () => {
    const reservationKey = 200
    const walletPubKeyHash = `0x${"11".repeat(20)}`
    const vault = `0x${"33".repeat(20)}`

    it("should request reservation acceptance successfully", async () => {
      const now = (await ethers.provider.getBlock("latest")).timestamp

      // Preconditions: governance params (all extra caps default to 0 =
      // disabled), a Live designated wallet, and a revealed deposit routed
      // to the reservation vault with a signing window that clears both
      // the deposit-age floor and the refund-deadline safety margin.
      await testReservation.setGovernanceParameters(100, 100, 10000, 0)
      await testReservation.setReservationVault(vault)
      await testReservation.setWalletState(walletPubKeyHash, 1) // 1 = Live
      await testReservation.setDeposit(
        reservationKey,
        depositor.address,
        1000,
        now - 3 * 60 * 60,
        vault
      )
      await testReservation.seedPendingReservedDeposit(
        reservationKey,
        true,
        walletPubKeyHash,
        now + 200000
      )

      // Call
      await testReservation
        .connect(depositor)
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)

      // Assert
      expect(
        await testReservation.walletReservationsCount(walletPubKeyHash)
      ).to.equal(1)
      expect(
        await testReservation.walletReservationsAmount(walletPubKeyHash)
      ).to.equal(1000)
      expect(await testReservation.activeReservationsCount()).to.equal(1)
    })
  })
})
