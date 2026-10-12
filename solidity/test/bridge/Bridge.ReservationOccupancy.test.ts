import { ethers } from "hardhat"
import { expect } from "chai"
import type { TestReservation } from "../../typechain"
import type { Signer } from "ethers"
import { walletState } from "../fixtures"

async function deployTestReservation(): Promise<TestReservation> {
  const ReservationProofs = await ethers.getContractFactory("ReservationProofs")
  const reservationProofs = await ReservationProofs.deploy()

  const Reservation = await ethers.getContractFactory("Reservation")
  const reservation = await Reservation.deploy()

  const TestReservationFactory = await ethers.getContractFactory(
    "TestReservation",
    {
      libraries: { Reservation: reservation.target },
    }
  )

  return TestReservationFactory.deploy()
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
    // The hand-off reserve gate holds back one Live wallet; give it two
    // (one reserved, one carrying positions) so this success acceptance
    // reaches the occupancy counter it probes rather than the gate.
    await testReservation.setLiveWalletsCount(2)
    await testReservation.setHandoffReserveWallets(1)
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
        .requestReservationAcceptance(reservationKey, walletPubKeyHash)
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

    await expect(testReservation.notifyReservationStranded(reservationKey))
      .to.emit(testReservation, "ReservationStranded")
      .withArgs(
        reservationKey,
        walletPubKeyHash,
        ethers.ZeroAddress,
        100
      )
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

    await expect(testReservation.notifyReservationStranded(reservationKey))
      .to.emit(testReservation, "ReservationStranded")
      .withArgs(
        reservationKey,
        walletPubKeyHash,
        ethers.ZeroAddress,
        100
      )
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
    ).to.be.revertedWith("Wallet is not terminated, closed, or a dissolution-eligible closing wallet")
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
      ethers.ZeroAddress,
      walletPubKeyHash,
      100,
      1 /* Active */,
      1
    )

    await expect(
      testReservation.notifyReservationStranded(reservationKey)
    ).to.be.revertedWith("Wallet is not terminated, closed, or a dissolution-eligible closing wallet")
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

describe("Reservation - hand-off reserve gate at acceptance", () => {
  let testReservation: TestReservation
  let depositor: Signer

  const walletA = `0x${"a1".repeat(20)}`
  const walletB = `0x${"a2".repeat(20)}`
  const vault = `0x${"3".repeat(40)}`

  beforeEach(async () => {
    testReservation = await deployTestReservation()
    ;[depositor] = await ethers.getSigners()
  })

  async function enableGate(
    maxReservationsPerWallet: number,
    liveWalletsCount: number,
    handoffReserveWallets: number,
  ) {
    await testReservation.setGovernanceParameters(100, 100, 10000, maxReservationsPerWallet)
    await testReservation.setMaxActiveReservations(1000)
    await testReservation.setReservationVault(vault)
    await testReservation.setLiveWalletsCount(liveWalletsCount)
    await testReservation.setHandoffReserveWallets(handoffReserveWallets)
  }

  let nextKey = 1
  async function seedAcceptableDeposit(pkh: string) {
    const key = 500 + nextKey++
    const now = (await ethers.provider.getBlock("latest"))!.timestamp
    await testReservation.setDeposit(
      key,
      depositor.address,
      1000,
      now - 3 * 60 * 60,
      vault
    )
    await testReservation.seedPendingReservedDeposit(
      key,
      true,
      pkh,
      now + 200000
    )
    return key
  }

  it("reverts when an acceptance would push the count past (L - R) * N, even with maxActiveReservations free", async () => {
    // L = 2, N = 10, R = 1, so the gate allows 1 * 10 = 10 open positions.
    await testReservation.setWalletState(walletA, walletState.Live)
    await enableGate(10, 2, 1)

    for (let i = 0; i < 10; i++) {
      const key = await seedAcceptableDeposit(walletA)
      await testReservation
        .connect(depositor)
        .requestReservationAcceptance(key, walletA)
    }
    expect(await testReservation.activeReservationsCount()).to.equal(10)

    // The 11th exceeds the gate's (L - R) * N = 10 even though the
    // maxActiveReservations cap of 1000 still has room.
    const key = await seedAcceptableDeposit(walletA)
    await expect(
      testReservation
        .connect(depositor)
        .requestReservationAcceptance(key, walletA)
    ).to.be.revertedWith("Hand-off reserve exceeded")
  })

  it("tightens when a Live wallet leaves Live (liveWalletsCount falls)", async () => {
    // L = 3, N = 10, R = 1: the gate allows 2 * 10 = 20 open positions.
    await testReservation.setWalletState(walletA, walletState.Live)
    await testReservation.setWalletState(walletB, walletState.Live)
    await enableGate(10, 3, 1)

    for (let i = 0; i < 10; i++) {
      const key = await seedAcceptableDeposit(walletA)
      await testReservation
        .connect(depositor)
        .requestReservationAcceptance(key, walletA)
    }
    for (let i = 0; i < 10; i++) {
      const key = await seedAcceptableDeposit(walletB)
      await testReservation
        .connect(depositor)
        .requestReservationAcceptance(key, walletB)
    }
    expect(await testReservation.activeReservationsCount()).to.equal(20)

    // One of the three Live wallets retires: remaining = 1 * 10 = 10,
    // below the 20 open positions, so the next acceptance reverts.
    await testReservation.setLiveWalletsCount(2)
    const key = await seedAcceptableDeposit(walletA)
    await expect(
      testReservation
        .connect(depositor)
        .requestReservationAcceptance(key, walletA)
    ).to.be.revertedWith("Hand-off reserve exceeded")
  })

  it("blocks every acceptance while liveWalletsCount is at or below the reserve", async () => {
    await testReservation.setWalletState(walletA, walletState.Live)
    await enableGate(10, 1, 1)

    const key = await seedAcceptableDeposit(walletA)
    await expect(
      testReservation
        .connect(depositor)
        .requestReservationAcceptance(key, walletA)
    ).to.be.revertedWith("Hand-off reserve exceeded")
  })
})
