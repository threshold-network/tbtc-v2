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
    deployer = signers[0]
    depositor = signers[1]
    thirdParty = signers[2]
    vault = signers[3]

    const ReservationProofsFactory = await ethers.getContractFactory(
      "ReservationProofs"
    )
    const reservationProofsLibrary = await ReservationProofsFactory.connect(
      deployer
    ).deploy()
    const ReservationFactory = await ethers.getContractFactory("Reservation", {
      libraries: { ReservationProofs: reservationProofsLibrary.address },
    })
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
          walletPubKeyHash: walletPubKeyHash,
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

      it("should revert when activeReservationsCount reaches maxActiveReservations (Max active reservations reached)", async () => {
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
        ).to.be.revertedWith("Max active reservations reached")
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
})
