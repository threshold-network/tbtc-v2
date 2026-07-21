import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import {
  P2TRProductionActivationGate,
  P2TRProductionCandidateEnqueueRejectedError,
  deriveP2TRProductionCandidateObservationID,
  type P2TRProductionActivationDependencies,
  type P2TRProductionBitcoinCandidate,
  type P2TRProductionBitcoinCandidateIdentity,
  type P2TRProductionCandidateAuthorizationReceipt,
  type P2TRProductionCandidateAuthorizationToken,
  type P2TRProductionCandidateEnqueueOutcome,
  type P2TRProductionStateStore,
  type P2TRProductionTransactionCoordinator,
} from "../src/P2TRProductionActivation.js"

const STORE_ID = "postgres-production"
const TOKEN_ID = `0x${"11".repeat(32)}`
const MANIFEST_HASH = `0x${"22".repeat(32)}`
const ENQUEUED_INTENT_ID = `0x${"33".repeat(32)}`
const CAPPED_INTENT_ID = `0x${"44".repeat(32)}`

describe("production candidate enqueue outcomes", () => {
  it("commits a nested generation-cap alert and token disposition before rejecting", async () => {
    const sequence: string[] = []
    const coordinator = new RollbackAwareCoordinator(sequence)
    const alerts: string[] = []
    const dispositions: string[] = []
    const stateStore = candidateStateStore(coordinator, dispositions, sequence)
    const candidateEnqueuer = {
      p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
      enqueueReconciledCandidate:
        async (): Promise<P2TRProductionCandidateEnqueueOutcome> =>
          coordinator.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
            coordinator.stage(() => {
              alerts.push("generation-cap-exhausted")
              sequence.push("alert-committed")
            })
            return {
              kind: "generation-cap-exhausted",
              outboxIntentID: CAPPED_INTENT_ID,
              message: "generation cap reached",
            }
          }),
    }
    const { gate, token, candidate } = gateForCandidate(
      coordinator,
      stateStore,
      candidateEnqueuer
    )

    await assert.rejects(
      gate.consumeCandidateAuthorization(token, candidate).catch((error) => {
        sequence.push("caller-rejected")
        throw error
      }),
      (error: unknown) => {
        assert.ok(error instanceof P2TRProductionCandidateEnqueueRejectedError)
        assert.equal(error.code, "generation-cap-exhausted")
        assert.equal(error.outboxIntentID, CAPPED_INTENT_ID)
        assert.equal(error.message, "generation cap reached")
        return true
      }
    )

    assert.deepEqual(alerts, ["generation-cap-exhausted"])
    assert.deepEqual(dispositions, [CAPPED_INTENT_ID])
    assert.equal(coordinator.commits, 1)
    assert.equal(coordinator.rollbacks, 0)
    assert.deepEqual(sequence, [
      "alert-committed",
      "disposition-committed",
      "transaction-committed",
      "caller-rejected",
    ])
  })

  it("preserves successful enqueue and one-use token consumption", async () => {
    const coordinator = new RollbackAwareCoordinator()
    const dispositions: string[] = []
    const stateStore = candidateStateStore(coordinator, dispositions)
    const candidateEnqueuer = {
      p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
      enqueueReconciledCandidate:
        async (): Promise<P2TRProductionCandidateEnqueueOutcome> => ({
          kind: "enqueued",
          outboxIntentID: ENQUEUED_INTENT_ID,
        }),
    }
    const { gate, token, candidate } = gateForCandidate(
      coordinator,
      stateStore,
      candidateEnqueuer
    )

    assert.equal(
      await gate.consumeCandidateAuthorization(token, candidate),
      ENQUEUED_INTENT_ID
    )
    assert.deepEqual(dispositions, [ENQUEUED_INTENT_ID])
    assert.equal(coordinator.commits, 1)
    assert.equal(coordinator.rollbacks, 0)
    await assert.rejects(
      gate.consumeCandidateAuthorization(token, candidate),
      /invalid, expired, or used/
    )
  })

  it("still rolls back nested work when enqueue fails before an outcome", async () => {
    const coordinator = new RollbackAwareCoordinator()
    const alerts: string[] = []
    const dispositions: string[] = []
    const stateStore = candidateStateStore(coordinator, dispositions)
    const candidateEnqueuer = {
      p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
      enqueueReconciledCandidate:
        async (): Promise<P2TRProductionCandidateEnqueueOutcome> =>
          coordinator.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
            coordinator.stage(() => alerts.push("must-roll-back"))
            throw new Error("enqueue failed before durable disposition")
          }),
    }
    const { gate, token, candidate } = gateForCandidate(
      coordinator,
      stateStore,
      candidateEnqueuer
    )

    await assert.rejects(
      gate.consumeCandidateAuthorization(token, candidate),
      /enqueue failed before durable disposition/
    )
    assert.deepEqual(alerts, [])
    assert.deepEqual(dispositions, [])
    assert.equal(coordinator.commits, 0)
    assert.equal(coordinator.rollbacks, 1)
  })
})

class RollbackAwareCoordinator implements P2TRProductionTransactionCoordinator {
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID = STORE_ID
  commits = 0
  rollbacks = 0
  private active = false
  private staged: Array<() => void> = []
  private readonly sequence?: string[]

  constructor(sequence?: string[]) {
    this.sequence = sequence
  }

  async runInP2TRSignatureFraudWatchtowerTransaction<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.active) return operation()
    this.active = true
    this.staged = []
    try {
      const result = await operation()
      for (const mutation of this.staged) mutation()
      this.commits++
      this.sequence?.push("transaction-committed")
      return result
    } catch (error) {
      this.staged = []
      this.rollbacks++
      throw error
    } finally {
      this.active = false
    }
  }

  assertP2TRSignatureFraudWatchtowerTransactionalParticipants(): void {}

  stage(mutation: () => void): void {
    if (!this.active) throw new Error("test mutation is outside a transaction")
    this.staged.push(mutation)
  }
}

function candidateStateStore(
  coordinator: RollbackAwareCoordinator,
  dispositions: string[],
  sequence?: string[]
): P2TRProductionStateStore {
  return {
    p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
    async readBitcoinIndexHealth() {
      throw new Error("unused test dependency")
    },
    async readEthereumJournalHealth() {
      throw new Error("unused test dependency")
    },
    async assertCandidateIndexed() {},
    async issueCandidateAuthorization() {
      throw new Error("unused test dependency")
    },
    async lockCandidateAuthorization() {},
    async consumeCandidateAuthorization(_tokenID, outboxIntentID) {
      coordinator.stage(() => {
        dispositions.push(outboxIntentID)
        sequence?.push("disposition-committed")
      })
    },
  }
}

function gateForCandidate(
  coordinator: RollbackAwareCoordinator,
  stateStore: P2TRProductionStateStore,
  candidateEnqueuer: P2TRProductionActivationDependencies["candidateEnqueuer"]
): {
  gate: P2TRProductionActivationGate
  token: P2TRProductionCandidateAuthorizationToken
  candidate: P2TRProductionBitcoinCandidateIdentity
} {
  const candidate: P2TRProductionBitcoinCandidateIdentity = {
    txid: "55".repeat(32),
    wtxid: "66".repeat(32),
    blockHeight: 840_000,
    blockHash: "77".repeat(32),
  }
  const normalized: P2TRProductionBitcoinCandidate = {
    observationID: deriveP2TRProductionCandidateObservationID(candidate),
    ...candidate,
  }
  const receipt: P2TRProductionCandidateAuthorizationReceipt = {
    tokenID: TOKEN_ID,
    manifestHash: MANIFEST_HASH,
    candidateDigest: hashCandidate(normalized),
    candidate: normalized,
    verifiedBitcoin: {
      height: candidate.blockHeight,
      hash: candidate.blockHash,
    },
    verifiedEthereum: {
      blockNumber: 1,
      blockHash: `0x${"88".repeat(32)}`,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const token = Object.freeze(
    {}
  ) as unknown as P2TRProductionCandidateAuthorizationToken
  const candidateTokens = new WeakMap<object, unknown>([
    [token, { receipt, consumed: false }],
  ])
  const dependencies = {
    stateStore,
    candidateEnqueuer,
    transactionCoordinator: coordinator,
  } as unknown as P2TRProductionActivationDependencies
  const gate = Object.create(
    P2TRProductionActivationGate.prototype
  ) as P2TRProductionActivationGate
  Object.assign(gate, { dependencies, candidateTokens })
  return { gate, token, candidate }
}

function hashCandidate(candidate: P2TRProductionBitcoinCandidate): string {
  return `0x${createHash("sha256")
    .update(canonicalJSON(candidate))
    .digest("hex")}`
}

function canonicalJSON(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === "number") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
      .join(",")}}`
  }
  throw new Error("unsupported test canonical JSON value")
}
