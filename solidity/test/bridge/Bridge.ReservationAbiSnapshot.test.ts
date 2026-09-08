import { expect } from "chai"
import * as fs from "fs"
import * as path from "path"
import {
  getReservationAbiSnapshot,
  ReservationAbiSnapshot,
} from "../fixtures/reservationAbiSnapshot"

// Checked-in snapshot of the reservation ABI surface.
// This snapshot must be regenerated/updated by whichever future PR intentionally
// changes the reservation ABI surface. A CI failure here means that PR
// unexpectedly touched the reservation ABI surface consumed by keep-core's client.
import reservationAbiSnapshot from "../fixtures/ReservationAbi.snapshot.json"

describe("Reservation ABI surface snapshot", () => {
  let liveSnapshot: ReservationAbiSnapshot

  before(async () => {
    liveSnapshot = await getReservationAbiSnapshot()
  })

  it("function selectors match the checked-in snapshot", () => {
    expect(liveSnapshot.functions).to.deep.equal(
      reservationAbiSnapshot.functions
    )
  })

  it("event topic0 hashes match the checked-in snapshot", () => {
    expect(liveSnapshot.events).to.deep.equal(reservationAbiSnapshot.events)
  })

  it("struct field order matches the checked-in snapshot", () => {
    expect(liveSnapshot.structs).to.deep.equal(reservationAbiSnapshot.structs)
  })
})
