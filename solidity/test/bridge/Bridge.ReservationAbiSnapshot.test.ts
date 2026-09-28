import { expect } from "chai"
import {
  getReservationAbiSnapshot,
  ReservationAbiSnapshot,
} from "../fixtures/reservationAbiSnapshot"

// Checked-in snapshot of the reservation ABI surface.
// This snapshot must be regenerated/updated by whichever future PR intentionally
// changes the reservation ABI surface. A CI failure here means that PR
// unexpectedly touched the reservation ABI surface consumed by keep-core's client.
import reservationAbiSnapshot from "../fixtures/ReservationAbi.snapshot.json"

// EVM-canonical selectors for the four reservation entry points whose
// inputs are ABI tuples (struct parameters). The EVM expands a struct
// parameter to its parenthesized component types when hashing the
// signature, so these values are the real selector bytes on-chain and in
// the keep-core Go bindings -- not what a hash of the raw JSON `tuple`
// placeholder would produce. They are pinned independently of the
// checked-in snapshot JSON (which the snapshot code and this test share
// as a source) so a regression to placeholder-style selector computation
// fails here even if the JSON is regenerated consistently wrong.
const CANONICAL_TUPLE_INPUT_SELECTORS: Record<string, string> = {
  submitReservationAcceptanceProof: "0xe24ad1ae",
  submitReservationReanchorProof: "0x6af550d1",
  validateReservationAnchorProposal: "0xf9179ad2",
  validateReservationReanchorProposal: "0xa57f734f",
}

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

  it("tuple-input selectors are EVM-canonical (independent of the JSON)", () => {
    // The live snapshot computes selectors by recursively canonicalizing
    // tuple components. Assert the four known values directly so that a
    // regression to hashing the raw `tuple` placeholder fails here even
    // if the checked-in JSON were regenerated with the same wrong code.
    const byName: Record<string, string> = {}
    liveSnapshot.functions.forEach((f) => {
      byName[f.name] = f.selector
    })
    Object.entries(CANONICAL_TUPLE_INPUT_SELECTORS).forEach(
      ([name, selector]) => {
        expect(
          byName[name],
          `selector for ${name} must be the EVM-canonical value`
        ).to.equal(selector)
      }
    )
  })

  it("event topic0 hashes match the checked-in snapshot", () => {
    expect(liveSnapshot.events).to.deep.equal(reservationAbiSnapshot.events)
  })

  it("struct field order matches the checked-in snapshot", () => {
    expect(liveSnapshot.structs).to.deep.equal(reservationAbiSnapshot.structs)
  })
})
