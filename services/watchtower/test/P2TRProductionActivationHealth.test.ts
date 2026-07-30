import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  assertP2TRProductionBitcoinIndexHealth,
  type P2TRProductionActivationManifest,
  type P2TRProductionBitcoinIndexHealth,
} from "../src/P2TRProductionActivation.js"

const CURSOR_HASH = "11".repeat(32)
const GENESIS_HASH = "22".repeat(32)

describe("production activation Bitcoin cursor authentication", () => {
  it("accepts a healthy cursor authenticated by both providers", () => {
    assert.doesNotThrow(() =>
      assertP2TRProductionBitcoinIndexHealth(
        health(),
        manifest(),
        { height: 12, hash: "33".repeat(32) },
        CURSOR_HASH,
        CURSOR_HASH
      )
    )
  })

  it("rejects an internally consistent cursor on a stale fork", () => {
    assert.throws(
      () =>
        assertP2TRProductionBitcoinIndexHealth(
          health(),
          manifest(),
          { height: 12, hash: "33".repeat(32) },
          "44".repeat(32),
          "44".repeat(32)
        ),
      /incomplete, stale, or unhealthy/
    )
  })
})

function health(): P2TRProductionBitcoinIndexHealth {
  return {
    storeID: "postgres-production",
    configurationFingerprint: "55".repeat(32),
    network: "main",
    checkpoint: { height: 0, hash: GENESIS_HASH },
    current: { height: 10, hash: CURSOR_HASH },
    canonicalBlockCount: 11,
    pendingCandidates: 0,
    pendingDepositReveals: 0,
    unmatchedProofs: 0,
    liveCandidateAuthorizations: 0,
    unbackfilledFrostWalletBindings: 0,
    failureGeneration: 0,
    clearedFailureGeneration: 0,
  }
}

function manifest(): P2TRProductionActivationManifest {
  return {
    bitcoin: {
      storeID: "postgres-production",
      configurationFingerprint: "55".repeat(32),
      network: "main",
      genesisHash: GENESIS_HASH,
      maxIndexLagBlocks: 2,
    },
  } as P2TRProductionActivationManifest
}
