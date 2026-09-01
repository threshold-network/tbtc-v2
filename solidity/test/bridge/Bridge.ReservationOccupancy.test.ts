import { ethers } from "hardhat"
import { expect } from "chai"
import type { Contract } from "ethers"

async function deployStub(): Promise<Contract> {
  const ReservationProofs = await ethers.getContractFactory("ReservationProofs")
  const reservationProofs = await ReservationProofs.deploy()

  const Reservation = await ethers.getContractFactory("Reservation", {
    libraries: { ReservationProofs: reservationProofs.address },
  })
  const reservation = await Reservation.deploy()

  const Stub = await ethers.getContractFactory("ReservationOccupancyStub", {
    libraries: { Reservation: reservation.address },
  })

  return Stub.deploy()
}

describe("Reservation - occupancy tracking", () => {
  let stub: Contract

  beforeEach(async () => {
    stub = await deployStub()
  })

  // Reservation.sol:578 - TODO: requires seeding more governance parameters
  // (reservationActionTimeout, reservationMinAmount, reservationTxMaxFee)
  // than fit cleanly on the stub's external surface. requestReservationAcceptance
  // requires those parameters to compute a non-empty signing window before it
  // ever increments activeReservationsCount. Coverage requires either exposing
  // the missing parameter setters or driving the request path through the
  // full Bridge governance; both belong with the Bridge-integration PR.
  it("TODO: requestReservationAcceptance requires full parameter setup", async () => {
    // TODO: requires full parameter setup (Reservation.sol:578)
  })

  // Reservation.sol:777 - TODO: requires seeding a full ReservationAction record
  // (17 fields). The action record has more fields than fit on the EVM stack to
  // seed in one call, and notifyReservationActionTimeout reverts without a
  // Pending action. Coverage requires either a proof harness or splitting the
  // seed seam into per-field setters; both belong with the Bridge-integration PR.
  it("TODO: notifyReservationActionTimeout requires seeded ReservationAction record", async () => {
    // TODO: requires seeded ReservationAction record (Reservation.sol:777)
  })

  // Reservation.sol:1136 - covered (externally callable; P0 fix widened to
  // accept Closing/Closed). Seeds a minimal Active reservation + Closed wallet,
  // pre-loads the three reservation accounting counters the strand will
  // decrement, calls notifyReservationStranded, and asserts the counter drops
  // to zero and the canonical ReservationStranded event emits with all four
  // arguments.
  it("notifyReservationStranded decrements counter on a Closed wallet", async () => {
    await stub.setMaxActiveReservations(5)
    await stub.setActiveReservationsCount(1)

    const walletPubKeyHash = `0x${"1".repeat(40)}`
    await stub.setWalletReservationsCount(walletPubKeyHash, 1)
    await stub.setWalletReservationsAmount(walletPubKeyHash, 100)
    await stub.setReservationTotalAmount(100)
    await stub.seedWalletState(walletPubKeyHash, 4 /* Closed */)

    const reservationKey = 1
    await stub.seedReservation(
      reservationKey,
      ethers.constants.AddressZero,
      100,
      1000,
      walletPubKeyHash,
      1 /* Active */
    )

    await expect(stub.notifyReservationStranded(reservationKey))
      .to.emit(stub, "ReservationStranded")
      .withArgs(
        reservationKey,
        walletPubKeyHash,
        ethers.constants.AddressZero,
        100
      )

    expect(await stub.getActiveReservationsCount()).to.equal(0)
  })

  // ReservationProofs.sol:270 - TODO: prepareReservationForSettlement is internal,
  // takes a `ReservationRequest storage` reference. No external entry point exists
  // and the stub cannot forward internal functions. Coverage requires either
  // exposing the function or driving it through a full SPV proof harness.
  it("TODO: prepareReservationForSettlement requires proof harness", async () => {
    // TODO: requires proof harness for prepareReservationForSettlement (ReservationProofs.sol:270)
  })

  // ReservationProofs.sol:479 - TODO: settleAcceptance is internal, takes a
  // `ReservationAction storage` reference plus proof data. No external entry
  // point exists and the stub cannot forward internal functions. Coverage
  // requires either exposing the function or driving it through a full SPV
  // proof harness.
  it("TODO: settleAcceptance requires proof harness", async () => {
    // TODO: requires proof harness for settleAcceptance (ReservationProofs.sol:479)
  })

  // ReservationProofs.sol:821 - TODO: unwindPendingAction is internal and
  // only reachable via the SPV proof paths above. Same harness dependency.
  it("TODO: unwindPendingAction requires proof harness", async () => {
    // TODO: requires proof harness for unwindPendingAction (ReservationProofs.sol:821)
  })
})
