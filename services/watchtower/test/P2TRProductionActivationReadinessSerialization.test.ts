import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  P2TRProductionActivationGate,
  type P2TRProductionBitcoinCandidateIdentity,
  type P2TRProductionCandidateAuthorizationToken,
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
