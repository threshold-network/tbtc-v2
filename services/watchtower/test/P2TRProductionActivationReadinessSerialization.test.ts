import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  P2TRProductionActivationGate,
  type P2TRProductionBitcoinCandidateIdentity,
  type P2TRProductionCandidateAuthorizationToken,
  type P2TRProductionEthereumHistoryState,
  type P2TRProductionEthereumPoint,
  type P2TRProductionEthereumState,
  type P2TRProductionReadySnapshot,
} from "../src/P2TRProductionActivation.js"

const WORD = (byte: string) => byte.repeat(32)

describe("production activation readiness authority serialization", () => {
  it("keeps a concurrent readiness check behind candidate authorization", async () => {
    const gate = Object.create(
      P2TRProductionActivationGate.prototype
    ) as P2TRProductionActivationGate
    const mutable = gate as unknown as {
      readinessAuthorityTail: Promise<void>
      assertReadyUnderAuthority(): Promise<P2TRProductionReadySnapshot>
      assertCandidateReconciledUnderAuthority(
        candidate: P2TRProductionBitcoinCandidateIdentity
      ): Promise<P2TRProductionCandidateAuthorizationToken>
    }
    mutable.readinessAuthorityTail = Promise.resolve()

    const order: string[] = []
    let releaseCandidate!: () => void
    let markCandidateStarted!: () => void
    const candidateStarted = new Promise<void>((resolve) => {
      markCandidateStarted = resolve
    })
    const candidateBlocked = new Promise<void>((resolve) => {
      releaseCandidate = resolve
    })
    mutable.assertCandidateReconciledUnderAuthority = async () => {
      order.push("candidate-started")
      markCandidateStarted()
      await candidateBlocked
      order.push("candidate-finished")
      return Object.freeze({}) as P2TRProductionCandidateAuthorizationToken
    }
    mutable.assertReadyUnderAuthority = async () => {
      order.push("readiness-started")
      return readySnapshot()
    }

    const candidate = gate.assertCandidateReconciled(candidateIdentity())
    await candidateStarted
    const readiness = gate.assertReady()
    await Promise.resolve()
    assert.deepEqual(order, ["candidate-started"])

    releaseCandidate()
    await Promise.all([candidate, readiness])
    assert.deepEqual(order, [
      "candidate-started",
      "candidate-finished",
      "readiness-started",
    ])
  })

  it("releases readiness authority after a failed operation", async () => {
    const gate = Object.create(
      P2TRProductionActivationGate.prototype
    ) as P2TRProductionActivationGate
    const mutable = gate as unknown as {
      readinessAuthorityTail: Promise<void>
      assertReadyUnderAuthority(): Promise<P2TRProductionReadySnapshot>
    }
    mutable.readinessAuthorityTail = Promise.resolve()
    let attempts = 0
    mutable.assertReadyUnderAuthority = async () => {
      attempts++
      if (attempts === 1) throw new Error("readiness failed")
      return readySnapshot()
    }

    await assert.rejects(gate.assertReady(), /readiness failed/)
    await gate.assertReady()
    assert.equal(attempts, 2)
  })

  it("reapplies manifest Bitcoin finality during candidate attestation", async () => {
    const gate = Object.create(P2TRProductionActivationGate.prototype)
    const confirmationDepths: number[] = []
    const provider = {
      async attestCandidate(
        candidate: P2TRProductionBitcoinCandidateIdentity,
        confirmationDepth: number
      ) {
        confirmationDepths.push(confirmationDepth)
        return {
          txid: candidate.txid,
          wtxid: candidate.wtxid,
          blockHeight: candidate.blockHeight,
          blockHash: candidate.blockHash,
          inputIndex: candidate.inputIndex,
          finalizedThrough: { height: 9, hash: WORD("15") },
          present: true as const,
        }
      },
    }
    Object.assign(gate, {
      manifest: { bitcoin: { confirmationDepth: 6 } },
      dependencies: {
        bitcoinIndexSource: provider,
        bitcoinReconciler: provider,
      },
    })
    const mutable = gate as unknown as {
      assertReadyUnderAuthority(): Promise<P2TRProductionReadySnapshot>
      assertCandidateReconciledUnderAuthority(
        candidate: P2TRProductionBitcoinCandidateIdentity
      ): Promise<P2TRProductionCandidateAuthorizationToken>
    }
    mutable.assertReadyUnderAuthority = async () => readySnapshot()

    await assert.rejects(
      mutable.assertCandidateReconciledUnderAuthority(candidateIdentity()),
      /did not attest the exact Bitcoin candidate/
    )
    assert.deepEqual(confirmationDepths, [6, 6])
  })

  it("rejects lag history when its verified activation point was orphaned", async () => {
    const gate = ethereumHistoryGate(`0x${WORD("35")}`)
    await assert.rejects(
      gate.readVerifiedEthereumHistory(ethereumJournalPoint(), {
        point: verifiedEthereumPoint(),
      } as P2TRProductionEthereumState),
      /activation point changed during readiness/
    )
  })

  it("accepts lag history while its verified activation point remains canonical", async () => {
    const gate = ethereumHistoryGate(verifiedEthereumPoint().blockHash)
    assert.deepEqual(
      await gate.readVerifiedEthereumHistory(ethereumJournalPoint(), {
        point: verifiedEthereumPoint(),
      } as P2TRProductionEthereumState),
      ethereumJournalHistory()
    )
  })
})

function candidateIdentity(): P2TRProductionBitcoinCandidateIdentity {
  return {
    txid: WORD("10"),
    wtxid: WORD("11"),
    blockHeight: 10,
    blockHash: WORD("12"),
    inputIndex: 0,
    observationID: WORD("13"),
    challengeKey: WORD("14"),
  }
}

function readySnapshot(): P2TRProductionReadySnapshot {
  return {
    manifestHash: WORD("20"),
    verifiedBitcoin: { height: 10, hash: WORD("21") },
    verifiedEthereum: { blockNumber: 20, blockHash: WORD("22") },
    readinessCertificate: {
      certificateID: WORD("23"),
      generation: 1,
    },
  }
}

function ethereumHistoryGate(canonicalHash: string): {
  readVerifiedEthereumHistory(
    point: P2TRProductionEthereumPoint,
    canonical: P2TRProductionEthereumState
  ): Promise<P2TRProductionEthereumHistoryState>
} {
  const provider = {
    async getBlockHash(blockNumber: number): Promise<string> {
      return blockNumber === ethereumJournalPoint().blockNumber
        ? ethereumJournalPoint().blockHash
        : canonicalHash
    },
    async readHistoryState(): Promise<P2TRProductionEthereumHistoryState> {
      return ethereumJournalHistory()
    },
  }
  const gate = Object.create(P2TRProductionActivationGate.prototype)
  Object.assign(gate, {
    manifest: { ethereum: { scanStartBlock: 1 } },
    dependencies: {
      ethereumSource: provider,
      ethereumVerifier: provider,
    },
  })
  return gate
}

function ethereumJournalPoint(): P2TRProductionEthereumPoint {
  return { blockNumber: 10, blockHash: `0x${WORD("31")}` }
}

function verifiedEthereumPoint(): P2TRProductionEthereumPoint {
  return { blockNumber: 12, blockHash: `0x${WORD("32")}` }
}

function ethereumJournalHistory(): P2TRProductionEthereumHistoryState {
  return {
    point: ethereumJournalPoint(),
    requiredEventHistoryDigest: `0x${WORD("33")}`,
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
