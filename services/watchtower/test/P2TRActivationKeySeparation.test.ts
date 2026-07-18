import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { assertP2TRActivationAttestationKeySeparation } from "../src/P2TRProductionActivation.js"

describe("production activation attestation key separation", () => {
  it("accepts three distinct Ed25519 SPKI hashes", () => {
    assert.doesNotThrow(() =>
      assertP2TRActivationAttestationKeySeparation({
        activationAuthorityKeyHash: "11".repeat(32),
        outboxAttestationKeyHash: "22".repeat(32),
        frostAttestationKeyHash: "33".repeat(32),
      })
    )
  })

  it("rejects every equal-key permutation", () => {
    const distinct = ["11".repeat(32), "22".repeat(32), "33".repeat(32)]
    for (const [left, right] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const keys = [...distinct]
      keys[right] = keys[left]
      assert.throws(
        () =>
          assertP2TRActivationAttestationKeySeparation({
            activationAuthorityKeyHash: keys[0],
            outboxAttestationKeyHash: keys[1],
            frostAttestationKeyHash: keys[2],
          }),
        /must differ/
      )
    }
  })
})
