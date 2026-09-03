import { ethers } from "hardhat"
import { expect } from "chai"
import type { Contract } from "ethers"
import { walletState } from "../fixtures"

async function deployTestReservation(): Promise<Contract> {
  const ReservationProofs = await ethers.getContractFactory("ReservationProofs")
  const reservationProofs = await ReservationProofs.deploy()

  const Reservation = await ethers.getContractFactory("Reservation")
  const reservation = await Reservation.deploy()

  const TestReservationFactory = await ethers.getContractFactory(
    "TestReservation",
    {
      libraries: { Reservation: reservation.address },
    }
  )

  return TestReservationFactory.deploy()
}

describe("Reservation - occupancy tracking", () => {
  let testReservation: Contract

  beforeEach(async () => {
    testReservation = await deployTestReservation()
  })

  // Covered by solidity/test/bridge/Reservation.test.ts ("requestReservationAcceptance > should increment activeReservationsCount", lines 717-743)

  // Covered by Reservation.test.ts (notifyReservationActionTimeout)
  it.skip("Covered by Reservation.test.ts (notifyReservationActionTimeout)")

  // Reservation.sol - COVERED (externally callable; accepts Terminated/Closed).
  // Seeds a minimal Active reservation + Closed or Terminated wallet, pre-loads
  // the three reservation accounting counters the strand will decrement, calls
  // notifyReservationStranded, and asserts the counter drops to zero and the
  // canonical ReservationStranded event emits with all four arguments.
  it("notifyReservationStranded decrements counter on a Closed wallet", async () => {
    await testReservation.setMaxActiveReservations(5)
    await testReservation.setActiveReservationsCount(1)

    const walletPubKeyHash = `0x${"1".repeat(40)}`
    await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
    await testReservation.setWalletReservationsAmount(walletPubKeyHash, 100)
    await testReservation.setReservationTotalAmount(100)
    await testReservation.setWalletState(walletPubKeyHash, walletState.Closed)

    const reservationKey = 1
    await testReservation.setReservationFullState(
      reservationKey,
      ethers.constants.AddressZero,
      walletPubKeyHash,
      100,
      1 /* Active */,
      1
    )

    await expect(testReservation.notifyReservationStranded(reservationKey))
      .to.emit(testReservation, "ReservationStranded")
      .withArgs(
        reservationKey,
        walletPubKeyHash,
        ethers.constants.AddressZero,
        100
      )

    expect(await testReservation.activeReservationsCount()).to.equal(0)
  })

  it("notifyReservationStranded decrements counter on a Terminated wallet", async () => {
    await testReservation.setMaxActiveReservations(5)
    await testReservation.setActiveReservationsCount(1)

    const walletPubKeyHash = `0x${"1".repeat(40)}`
    await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
    await testReservation.setWalletReservationsAmount(walletPubKeyHash, 100)
    await testReservation.setReservationTotalAmount(100)
    await testReservation.setWalletState(
      walletPubKeyHash,
      walletState.Terminated
    )

    const reservationKey = 1
    await testReservation.setReservationFullState(
      reservationKey,
      ethers.constants.AddressZero,
      walletPubKeyHash,
      100,
      1 /* Active */,
      1
    )

    await expect(testReservation.notifyReservationStranded(reservationKey))
      .to.emit(testReservation, "ReservationStranded")
      .withArgs(
        reservationKey,
        walletPubKeyHash,
        ethers.constants.AddressZero,
        100
      )

    expect(await testReservation.activeReservationsCount()).to.equal(0)
  })

  it("notifyReservationStranded reverts on a Closing wallet before dissolutionEligibleAt", async () => {
    await testReservation.setMaxActiveReservations(5)
    await testReservation.setActiveReservationsCount(1)

    const walletPubKeyHash = `0x${"1".repeat(40)}`
    await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
    await testReservation.setWalletReservationsAmount(walletPubKeyHash, 100)
    await testReservation.setReservationTotalAmount(100)
    await testReservation.setWalletState(walletPubKeyHash, walletState.Closing)

    const reservationKey = 1
    const now = (await ethers.provider.getBlock("latest")).timestamp
    await testReservation.setReservation(reservationKey, {
      owner: ethers.constants.AddressZero,
      mintedAmount: 100,
      acceptedAt: 0,
      walletPubKeyHash,
      anchorAmount: 100,
      expiresAt: 0,
      anchorTxHash: ethers.constants.HashZero,
      anchorTxOutputIndex: 0,
      state: 1 /* Active */,
      requestNonce: 1,
      retryCredit: false,
      dissolutionEligibleAt: now + 100000,
      cumulativeReanchorFee: 0,
      reanchorCooldownUntil: 0,
    })

    await expect(
      testReservation.notifyReservationStranded(reservationKey)
    ).to.be.revertedWith(
      "Wallet is not terminated, closed, or a dissolution-eligible closing wallet"
    )
  })

  it("notifyReservationStranded succeeds on a Closing wallet once dissolutionEligibleAt has passed", async () => {
    await testReservation.setMaxActiveReservations(5)
    await testReservation.setActiveReservationsCount(1)

    const walletPubKeyHash = `0x${"1".repeat(40)}`
    await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
    await testReservation.setWalletReservationsAmount(walletPubKeyHash, 100)
    await testReservation.setReservationTotalAmount(100)
    await testReservation.setWalletState(walletPubKeyHash, walletState.Closing)

    const reservationKey = 1
    const now = (await ethers.provider.getBlock("latest")).timestamp
    await testReservation.setReservation(reservationKey, {
      owner: ethers.constants.AddressZero,
      mintedAmount: 100,
      acceptedAt: 0,
      walletPubKeyHash,
      anchorAmount: 100,
      expiresAt: 0,
      anchorTxHash: ethers.constants.HashZero,
      anchorTxOutputIndex: 0,
      state: 1 /* Active */,
      requestNonce: 1,
      retryCredit: false,
      dissolutionEligibleAt: now - 1,
      cumulativeReanchorFee: 0,
      reanchorCooldownUntil: 0,
    })

    await expect(testReservation.notifyReservationStranded(reservationKey))
      .to.emit(testReservation, "ReservationStranded")
      .withArgs(
        reservationKey,
        walletPubKeyHash,
        ethers.constants.AddressZero,
        100
      )

    expect(await testReservation.activeReservationsCount()).to.equal(0)
  })

  it("notifyReservationStranded reverts on a Live wallet", async () => {
    await testReservation.setMaxActiveReservations(5)
    await testReservation.setActiveReservationsCount(1)

    const walletPubKeyHash = `0x${"1".repeat(40)}`
    await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
    await testReservation.setWalletReservationsAmount(walletPubKeyHash, 100)
    await testReservation.setReservationTotalAmount(100)
    await testReservation.setWalletState(walletPubKeyHash, walletState.Live)

    const reservationKey = 1
    await testReservation.setReservationFullState(
      reservationKey,
      ethers.constants.AddressZero,
      walletPubKeyHash,
      100,
      1 /* Active */,
      1
    )

    await expect(
      testReservation.notifyReservationStranded(reservationKey)
    ).to.be.revertedWith(
      "Wallet is not terminated, closed, or a dissolution-eligible closing wallet"
    )
  })

  // Covered by solidity/test/bridge/Reservation.test.ts ("prepareReservationForSettlement should restore capacity for a late-settled stranded reservation", lines 1514-1534)

  // Covered by solidity/test/bridge/ReservationProofs.test.ts ("settleAcceptance > should strand during full late settleAcceptance against Closed wallet", lines 1552-1574)

  // Covered by solidity/test/bridge/ReservationProofs.test.ts ("unwindPendingAction", lines 1039-1140)
})
