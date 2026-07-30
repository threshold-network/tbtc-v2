import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  assertP2TRProductionBitcoinIndexHealth,
  assertP2TRProductionEthereumJournalHealth,
  type P2TRProductionActivationManifest,
  type P2TRProductionBitcoinIndexHealth,
  type P2TRProductionEthereumHistoryState,
  type P2TRProductionEthereumJournalHealth,
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

describe("production activation Ethereum journal lag", () => {
  it("accepts permitted lag when provider history is pinned to the local cursor", () => {
    assert.doesNotThrow(() =>
      assertP2TRProductionEthereumJournalHealth(
        ethereumHealth(),
        ethereumManifest(),
        { point: { blockNumber: 12, blockHash: "66".repeat(32) } },
        ethereumHistory()
      )
    )
  })

  it("rejects canonical-point history for a lagging local cursor", () => {
    assert.throws(
      () =>
        assertP2TRProductionEthereumJournalHealth(
          ethereumHealth(),
          ethereumManifest(),
          { point: { blockNumber: 12, blockHash: "66".repeat(32) } },
          {
            ...ethereumHistory(),
            point: { blockNumber: 12, blockHash: "66".repeat(32) },
            requiredEventHistoryDigest: "77".repeat(32),
            requiredEventCount: 2,
            requiredEventCoverage: {
              blocks: 12,
              transactions: 2,
              receipts: 2,
              logs: 2,
              requiredEvents: 2,
            },
          }
        ),
      /incomplete, stale, or unhealthy/
    )
  })

  it("continues to reject lag beyond the manifest bound", () => {
    assert.throws(
      () =>
        assertP2TRProductionEthereumJournalHealth(
          ethereumHealth(),
          ethereumManifest(1),
          { point: { blockNumber: 12, blockHash: "66".repeat(32) } },
          ethereumHistory()
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

function ethereumHealth(): P2TRProductionEthereumJournalHealth {
  return {
    storeID: "postgres-production",
    chainID: 1,
    configurationFingerprint: "44".repeat(32),
    descriptorSetHash: "45".repeat(32),
    checkpoint: { blockNumber: 0, blockHash: "46".repeat(32) },
    scanStartBlock: 1,
    current: { blockNumber: 10, blockHash: "47".repeat(32) },
    requiredEventHistoryDigest: "48".repeat(32),
    requiredEventCount: 1,
    requiredEventCoverage: {
      blocks: 10,
      transactions: 1,
      receipts: 1,
      logs: 1,
      requiredEvents: 1,
    },
    failureGeneration: 0,
    clearedFailureGeneration: 0,
  }
}

function ethereumHistory(): P2TRProductionEthereumHistoryState {
  return {
    point: { blockNumber: 10, blockHash: "47".repeat(32) },
    requiredEventHistoryDigest: "48".repeat(32),
    requiredEventCount: 1,
    requiredEventCoverage: {
      blocks: 10,
      transactions: 1,
      receipts: 1,
      logs: 1,
      requiredEvents: 1,
    },
  }
}

function ethereumManifest(
  maxJournalLagBlocks = 2
): P2TRProductionActivationManifest {
  return {
    ethereum: {
      storeID: "postgres-production",
      chainID: 1,
      configurationFingerprint: "44".repeat(32),
      descriptorSetHash: "45".repeat(32),
      checkpoint: { blockNumber: 0, blockHash: "46".repeat(32) },
      scanStartBlock: 1,
      maxJournalLagBlocks,
    },
  } as P2TRProductionActivationManifest
}
