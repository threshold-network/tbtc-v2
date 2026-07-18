import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { deriveP2TRProductionCandidateObservationID } from "../src/P2TRProductionActivation.js"

const candidate = {
  txid: "11".repeat(32),
  wtxid: "22".repeat(32),
  blockHeight: 840_000,
  blockHash: "33".repeat(32),
}

describe("production candidate observation identity", () => {
  it("derives duplicate candidate IDs from the canonical primary key", () => {
    assert.equal(
      deriveP2TRProductionCandidateObservationID(candidate),
      deriveP2TRProductionCandidateObservationID({ ...candidate })
    )
  })

  it("does not accept an altered caller observation ID", () => {
    const malicious = {
      ...candidate,
      observationID: `0x${"ff".repeat(32)}`,
    }
    assert.notEqual(
      deriveP2TRProductionCandidateObservationID(malicious),
      malicious.observationID
    )
  })

  it("changes when any durable primary-key field changes", () => {
    const baseline = deriveP2TRProductionCandidateObservationID(candidate)
    for (const changed of [
      { ...candidate, txid: "44".repeat(32) },
      { ...candidate, wtxid: "44".repeat(32) },
      { ...candidate, blockHeight: candidate.blockHeight + 1 },
      { ...candidate, blockHash: "44".repeat(32) },
    ]) {
      assert.notEqual(
        deriveP2TRProductionCandidateObservationID(changed),
        baseline
      )
    }
  })
})
