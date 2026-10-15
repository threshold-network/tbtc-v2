import { ethers } from "hardhat"
import { expect } from "chai"
import type { TestReservation } from "../../typechain"
import { walletState } from "../fixtures"
import { RESERVATION_TERM_ENTRIES } from "../helpers/reservation-terms"

async function deployTestReservation(): Promise<TestReservation> {
  const ReservationProofs = await ethers.getContractFactory("ReservationProofs")
  const reservationProofs = await ReservationProofs.deploy()

  const Reservation = await ethers.getContractFactory("Reservation")
  const reservation = await Reservation.deploy()

  const TestReservationFactory = await ethers.getContractFactory(
    "TestReservation",
    {
      libraries: { Reservation: await reservation.getAddress() },
    }
  )

  const testReservation = await TestReservationFactory.deploy()

  // The harness storage is never reached by the Bridge fixture's seeding,
  // so the ruled term entries are added here through the harness wrapper
  // of the production setter.
  // eslint-disable-next-line no-restricted-syntax
  for (const entry of RESERVATION_TERM_ENTRIES) {
    // eslint-disable-next-line no-await-in-loop
    await testReservation.setReservationTerm(
      entry.termId,
      entry.termSeconds,
      entry.custodyBps,
      entry.enabled
    )
  }

  return testReservation
}

describe("Reservation - occupancy tracking", () => {
  let testReservation: TestReservation

  beforeEach(async () => {
    testReservation = await deployTestReservation()
  })

  it("requestReservationAcceptance increments activeReservationsCount and emits ReservationOccupancyChanged", async () => {
    const [deployer, depositor] = await ethers.getSigners()
    const reservationKey = 101
    const walletPubKeyHash = `0x${"2".repeat(40)}`
    const vault = `0x${"3".repeat(40)}`
    const now = (await ethers.provider.getBlock("latest"))!.timestamp

    await testReservation.setGovernanceParameters(100, 100, 10000, 1)
    await testReservation.setMaxActiveReservations(1)
    await testReservation.setReservationVault(vault)
    await testReservation.setWalletState(walletPubKeyHash, walletState.Live)
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

    expect(await testReservation.activeReservationsCount()).to.equal(0)

    await expect(
      testReservation
        .connect(depositor)
        .requestReservationAcceptance(
          reservationKey,
          walletPubKeyHash,
          RESERVATION_TERM_ENTRIES[0].termId
        )
    )
      .to.emit(testReservation, "ReservationOccupancyChanged")
      .withArgs(1)

    expect(await testReservation.activeReservationsCount()).to.equal(1)
  })

  it("notifyReservationAcceptanceTimedOut decrements activeReservationsCount and emits ReservationOccupancyChanged", async () => {
    const reservationKey = 102
    const walletPubKeyHash = `0x${"2".repeat(40)}`
    const now = (await ethers.provider.getBlock("latest"))!.timestamp

    await testReservation.setActiveReservationsCount(1)
    await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
    await testReservation.setWalletReservationsAmount(walletPubKeyHash, 1000)
    await testReservation.setReservationTotalAmount(1000)
    // The timeout path reads the reservation's current request nonce to find
    // the action; seed the record so it resolves to the Acceptance action.
    await testReservation.setReservationFullState(
      reservationKey,
      ethers.ZeroAddress,
      walletPubKeyHash,
      1000,
      1 /* Active */,
      1 /* requestNonce */
    )

    await testReservation.setFullAction(
      reservationKey,
      1,
      1 /* Acceptance */,
      1 /* Pending */,
      now - 10,
      walletPubKeyHash,
      1000
    )

    await expect(
      testReservation.notifyReservationAcceptanceTimedOut(reservationKey)
    )
      .to.emit(testReservation, "ReservationOccupancyChanged")
      .withArgs(0)

    expect(await testReservation.activeReservationsCount()).to.equal(0)
  })
  // Reservation.sol - COVERED (externally callable; accepts Terminated,
  // Closed, or a dissolution-eligible Closing wallet). Seeds a minimal
  // Active reservation + Closed wallet and asserts notifyReservationStranded
  // succeeds, decrementing the occupancy counter like the Terminated case.
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
      ethers.ZeroAddress,
      walletPubKeyHash,
      100,
      1 /* Active */,
      1
    )

    // Seed the proven-anchor custody ledger entry the way a settled
    // acceptance would have, so `strandReservation`'s
    // `removeAnchoredCustody` release stays balanced.
    await testReservation.setWalletAnchoredCounters(walletPubKeyHash, 1, 100)

    await expect(testReservation.notifyReservationStranded(reservationKey))
      .to.emit(testReservation, "ReservationStranded")
      .withArgs(reservationKey, walletPubKeyHash, ethers.ZeroAddress, 100)
      .to.emit(testReservation, "ReservationOccupancyChanged")
      .withArgs(0)
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
      ethers.ZeroAddress,
      walletPubKeyHash,
      100,
      1 /* Active */,
      1
    )

    // Seed the proven-anchor custody ledger entry the way a settled
    // acceptance would have, so `strandReservation`'s
    // `removeAnchoredCustody` release stays balanced.
    await testReservation.setWalletAnchoredCounters(walletPubKeyHash, 1, 100)

    await expect(testReservation.notifyReservationStranded(reservationKey))
      .to.emit(testReservation, "ReservationStranded")
      .withArgs(reservationKey, walletPubKeyHash, ethers.ZeroAddress, 100)
      .to.emit(testReservation, "ReservationOccupancyChanged")
      .withArgs(0)
    expect(await testReservation.activeReservationsCount()).to.equal(0)
  })

  it("notifyReservationStranded reverts on a Closing wallet", async () => {
    await testReservation.setMaxActiveReservations(5)
    await testReservation.setActiveReservationsCount(1)

    const walletPubKeyHash = `0x${"1".repeat(40)}`
    await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
    await testReservation.setWalletReservationsAmount(walletPubKeyHash, 100)
    await testReservation.setReservationTotalAmount(100)
    await testReservation.setWalletState(walletPubKeyHash, walletState.Closing)

    const reservationKey = 1
    const now = (await ethers.provider.getBlock("latest"))!.timestamp
    await testReservation.setReservation(reservationKey, {
      owner: ethers.ZeroAddress,
      mintedAmount: 100,
      acceptedAt: 0,
      walletPubKeyHash,
      anchorAmount: 100,
      expiresAt: 0,
      anchorTxHash: ethers.ZeroHash,
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

  it("notifyReservationStranded reverts on a Closing wallet whose closing period has not elapsed, even past dissolution eligibility", async () => {
    await testReservation.setMaxActiveReservations(5)
    await testReservation.setActiveReservationsCount(1)

    const walletPubKeyHash = `0x${"1".repeat(40)}`
    await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
    await testReservation.setWalletReservationsAmount(walletPubKeyHash, 100)
    await testReservation.setReservationTotalAmount(100)
    await testReservation.setWalletState(walletPubKeyHash, walletState.Closing)

    // Closing just started: the closing period runs far into the future.
    const now = (await ethers.provider.getBlock("latest"))!.timestamp
    await testReservation.setWalletClosingStartedAt(walletPubKeyHash, now)
    await testReservation.setWalletClosingPeriod(1_000_000)

    const reservationKey = 1
    // Dissolution is already eligible, so only the closing period blocks.
    await testReservation.setReservation(reservationKey, {
      owner: ethers.ZeroAddress,
      mintedAmount: 100,
      acceptedAt: 0,
      walletPubKeyHash,
      anchorAmount: 100,
      expiresAt: 0,
      anchorTxHash: ethers.ZeroHash,
      anchorTxOutputIndex: 0,
      state: 1 /* Active */,
      requestNonce: 1,
      retryCredit: false,
      dissolutionEligibleAt: now,
      cumulativeReanchorFee: 0,
      reanchorCooldownUntil: 0,
    })

    await expect(
      testReservation.notifyReservationStranded(reservationKey)
    ).to.be.revertedWith(
      "Wallet is not terminated, closed, or a dissolution-eligible closing wallet"
    )
  })

  it("notifyReservationStranded strands a Closing wallet once both dissolution eligibility and the closing period have passed", async () => {
    await testReservation.setMaxActiveReservations(5)
    await testReservation.setActiveReservationsCount(1)

    const walletPubKeyHash = `0x${"1".repeat(40)}`
    await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
    await testReservation.setWalletReservationsAmount(walletPubKeyHash, 100)
    await testReservation.setReservationTotalAmount(100)
    await testReservation.setWalletState(walletPubKeyHash, walletState.Closing)

    // The closing period ended long ago and dissolution is eligible.
    const now = (await ethers.provider.getBlock("latest"))!.timestamp
    await testReservation.setWalletClosingStartedAt(
      walletPubKeyHash,
      now - 5000
    )
    await testReservation.setWalletClosingPeriod(1000)

    const reservationKey = 1
    await testReservation.setReservation(reservationKey, {
      owner: ethers.ZeroAddress,
      mintedAmount: 100,
      acceptedAt: 0,
      walletPubKeyHash,
      anchorAmount: 100,
      expiresAt: 0,
      anchorTxHash: ethers.ZeroHash,
      anchorTxOutputIndex: 0,
      state: 1 /* Active */,
      requestNonce: 1,
      retryCredit: false,
      dissolutionEligibleAt: now - 10,
      cumulativeReanchorFee: 0,
      reanchorCooldownUntil: 0,
    })

    // Seed the proven-anchor custody ledger entry the way a settled
    // acceptance would have, so `strandReservation`'s
    // `removeAnchoredCustody` release stays balanced.
    await testReservation.setWalletAnchoredCounters(walletPubKeyHash, 1, 100)
    await expect(testReservation.notifyReservationStranded(reservationKey))
      .to.emit(testReservation, "ReservationStranded")
      .to.emit(testReservation, "ReservationOccupancyChanged")
      .withArgs(0)
    expect(await testReservation.activeReservationsCount()).to.equal(0)
  })

  async function activeOnLiveWallet(dissolutionEligibleAt: number) {
    await testReservation.setMaxActiveReservations(5)
    await testReservation.setActiveReservationsCount(1)

    const walletPubKeyHash = `0x${"1".repeat(40)}`
    await testReservation.setWalletReservationsCount(walletPubKeyHash, 1)
    await testReservation.setWalletReservationsAmount(walletPubKeyHash, 100)
    await testReservation.setReservationTotalAmount(100)
    // The helper models an Active position whose anchor is proven; seed the
    // proven-anchor ledger alongside the capacity counters so the strand
    // release stays balanced.
    await testReservation.setWalletAnchoredCounters(walletPubKeyHash, 1, 100)
    await testReservation.setWalletState(walletPubKeyHash, walletState.Live)

    const reservationKey = 1
    await testReservation.setReservationFullState(
      reservationKey,
      ethers.ZeroAddress,
      walletPubKeyHash,
      100,
      1 /* Active */,
      1
    )
    await testReservation.setReservationDissolutionEligibleAt(
      reservationKey,
      dissolutionEligibleAt
    )
    return { walletPubKeyHash, reservationKey }
  }

  it("notifyReservationStranded reverts on a Live wallet before dissolution eligibility", async () => {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp
    const { reservationKey } = await activeOnLiveWallet(now + 86400)

    await expect(
      testReservation.notifyReservationStranded(reservationKey)
    ).to.be.revertedWith(
      "Wallet is not terminated, closed, or a dissolution-eligible closing wallet"
    )
  })

  it("notifyReservationStranded releases an expired position on a Live wallet", async () => {
    const now = (await ethers.provider.getBlock("latest"))!.timestamp
    const { walletPubKeyHash, reservationKey } = await activeOnLiveWallet(now)

    await testReservation.notifyReservationStranded(reservationKey)

    expect(await testReservation.activeReservationsCount()).to.equal(0)
    expect(
      await testReservation.walletReservationsCount(walletPubKeyHash)
    ).to.equal(0)
    expect(
      await testReservation.walletReservationsAmount(walletPubKeyHash)
    ).to.equal(0)
  })

  it("prepareReservationForSettlement restores activeReservationsCount on late settlement of stranded reservation and emits ReservationOccupancyChanged", async () => {
    const reservationKey = 103
    const walletPubKeyHash = `0x${"1".repeat(40)}`
    const anchorTxHash = `0x${"a".repeat(64)}`

    await testReservation.setActiveReservationsCount(0)
    await testReservation.setReservationFullState(
      reservationKey,
      ethers.ZeroAddress,
      walletPubKeyHash,
      1000,
      4 /* Stranded */,
      1
    )
    await testReservation.setReservationAnchor(reservationKey, anchorTxHash, 0)

    await expect(
      testReservation.prepareReservationForSettlement(reservationKey, true)
    )
      .to.emit(testReservation, "ReservationOccupancyChanged")
      .withArgs(1)

    expect(await testReservation.activeReservationsCount()).to.equal(1)
  })

  // Covered by solidity/test/bridge/Reservation.test.ts ("prepareReservationForSettlement should restore capacity for a late-settled stranded reservation")

  // Covered by solidity/test/bridge/ReservationProofs.test.ts ("settleAcceptance > should strand during full late settleAcceptance against Closed wallet")

  // Covered by solidity/test/bridge/ReservationProofs.test.ts ("unwindPendingAction")
})
