import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import {
  P2TRProductionActivationGate,
  P2TRProductionCandidateEnqueueRejectedError,
  P2TRProductionCandidateEnqueueRetryExhaustedError,
  assertP2TRProductionRuntimeAlertHealth,
  deriveP2TRProductionCandidateObservationID,
  type P2TRProductionActivationDependencies,
  type P2TRProductionBitcoinCandidate,
  type P2TRProductionBitcoinCandidateIdentity,
  type P2TRProductionCandidateAuthorizationReceipt,
  type P2TRProductionCandidateAuthorizationToken,
  type P2TRProductionCandidateEnqueueOutcome,
  type P2TRProductionCandidateEnqueueRetryExhaustionAlert,
  type P2TRProductionCandidateEnqueueTransactionGuard,
  type P2TRProductionCandidateEnqueueTransactionResolution,
  type P2TRProductionRuntimeAlertHealth,
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
    const journal = emptyCandidateJournal()
    const stateStore = candidateStateStore(
      coordinator,
      dispositions,
      journal,
      sequence
    )
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
    assert.equal(journal.guards.length, 1)
    assert.equal(journal.resolutions.length, 1)
    assert.equal(journal.resolutions[0].outcomeKind, "generation-cap-exhausted")
    assert.equal(coordinator.commits, 2)
    assert.equal(coordinator.rollbacks, 0)
    assert.deepEqual(sequence, [
      "guard-committed",
      "transaction-committed",
      "alert-committed",
      "disposition-committed",
      "resolution-committed",
      "transaction-committed",
      "caller-rejected",
    ])
  })

  it("preserves successful enqueue and one-use token consumption", async () => {
    const coordinator = new RollbackAwareCoordinator()
    const dispositions: string[] = []
    const journal = emptyCandidateJournal()
    const stateStore = candidateStateStore(coordinator, dispositions, journal)
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
    assert.equal(journal.guards.length, 1)
    assert.equal(journal.resolutions.length, 1)
    assert.equal(journal.resolutions[0].outcomeKind, "enqueued")
    assert.equal(coordinator.commits, 2)
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
    const journal = emptyCandidateJournal()
    const stateStore = candidateStateStore(coordinator, dispositions, journal)
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
    assert.equal(journal.guards.length, 1)
    assert.equal(journal.resolutions.length, 0)
    assert.throws(
      () =>
        assertP2TRProductionRuntimeAlertHealth(
          healthFor(journal),
          MANIFEST_HASH
        ),
      /activation-blocking candidate enqueue alerts/
    )
    assert.equal(coordinator.commits, 1)
    assert.equal(coordinator.rollbacks, 1)
  })

  it("retries the complete database-only transaction after branded PostgreSQL aborts", async () => {
    for (const sqlState of ["40001", "40P01"] as const) {
      const coordinator = new RollbackAwareCoordinator()
      coordinator.failNextTransactionWith(sqlState)
      const dispositions: string[] = []
      const journal = emptyCandidateJournal()
      const stateStore = candidateStateStore(coordinator, dispositions, journal)
      let enqueueAttempts = 0
      const candidateEnqueuer = {
        p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
        enqueueReconciledCandidate:
          async (): Promise<P2TRProductionCandidateEnqueueOutcome> => {
            enqueueAttempts++
            assert.equal(
              coordinator.isP2TRSignatureFraudWatchtowerTransactionActive(),
              true
            )
            return { kind: "enqueued", outboxIntentID: ENQUEUED_INTENT_ID }
          },
      }
      const { gate, token, candidate } = gateForCandidate(
        coordinator,
        stateStore,
        candidateEnqueuer,
        3
      )

      assert.equal(
        await gate.consumeCandidateAuthorization(token, candidate),
        ENQUEUED_INTENT_ID
      )
      assert.equal(enqueueAttempts, 2)
      assert.deepEqual(dispositions, [ENQUEUED_INTENT_ID])
      assert.equal(journal.resolutions.length, 1)
      assert.equal(journal.exhaustionAlerts.length, 0)
      assert.equal(coordinator.commits, 2)
      assert.equal(coordinator.rollbacks, 1)
    }
  })

  it("keeps an unresolved guard and durable alert after retry exhaustion", async () => {
    const coordinator = new RollbackAwareCoordinator()
    coordinator.failNextTransactionWith("40001")
    coordinator.failNextTransactionWith("40P01")
    const dispositions: string[] = []
    const journal = emptyCandidateJournal()
    const stateStore = candidateStateStore(coordinator, dispositions, journal)
    let enqueueAttempts = 0
    const candidateEnqueuer = {
      p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
      enqueueReconciledCandidate:
        async (): Promise<P2TRProductionCandidateEnqueueOutcome> => {
          enqueueAttempts++
          return { kind: "enqueued", outboxIntentID: ENQUEUED_INTENT_ID }
        },
    }
    const { gate, token, candidate } = gateForCandidate(
      coordinator,
      stateStore,
      candidateEnqueuer,
      2
    )

    await assert.rejects(
      gate.consumeCandidateAuthorization(token, candidate),
      (error: unknown) => {
        assert.ok(
          error instanceof P2TRProductionCandidateEnqueueRetryExhaustedError
        )
        assert.equal(
          error.code,
          "candidate-enqueue-transaction-retry-exhausted"
        )
        assert.equal(error.activationBlocking, true)
        assert.equal(error.alert.tokenID, TOKEN_ID)
        assert.equal(error.alert.manifestHash, MANIFEST_HASH)
        assert.equal(error.alert.attemptCount, 2)
        assert.equal(error.alert.lastSQLState, "40P01")
        return true
      }
    )

    assert.equal(enqueueAttempts, 2)
    assert.deepEqual(dispositions, [])
    assert.equal(journal.guards.length, 1)
    assert.equal(journal.resolutions.length, 0)
    assert.equal(journal.exhaustionAlerts.length, 1)
    assert.deepEqual(journal.exhaustionAlerts[0], {
      tokenID: TOKEN_ID,
      manifestHash: MANIFEST_HASH,
      candidateDigest: journal.guards[0].candidateDigest,
      attemptCount: 2,
      lastSQLState: "40P01",
    })
    assert.throws(
      () =>
        assertP2TRProductionRuntimeAlertHealth(
          healthFor(journal),
          MANIFEST_HASH
        ),
      /activation-blocking candidate enqueue alerts/
    )
    assert.equal(coordinator.commits, 2)
    assert.equal(coordinator.rollbacks, 2)
  })

  it("does not retry an application error that spoofs PostgreSQL SQLSTATE", async () => {
    const coordinator = new RollbackAwareCoordinator()
    const journal = emptyCandidateJournal()
    const stateStore = candidateStateStore(coordinator, [], journal)
    let enqueueAttempts = 0
    const candidateEnqueuer = {
      p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
      enqueueReconciledCandidate:
        async (): Promise<P2TRProductionCandidateEnqueueOutcome> => {
          enqueueAttempts++
          throw Object.assign(new Error("forged serialization failure"), {
            code: "40001",
          })
        },
    }
    const { gate, token, candidate } = gateForCandidate(
      coordinator,
      stateStore,
      candidateEnqueuer,
      3
    )

    await assert.rejects(
      gate.consumeCandidateAuthorization(token, candidate),
      /forged serialization failure/
    )
    assert.equal(enqueueAttempts, 1)
    assert.equal(journal.guards.length, 1)
    assert.equal(journal.resolutions.length, 0)
    assert.equal(journal.exhaustionAlerts.length, 0)
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
  private readonly failures: Array<"40001" | "40P01"> = []
  private readonly retryableErrors = new WeakMap<object, "40001" | "40P01">()

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
      const sqlState = this.commits > 0 ? this.failures.shift() : undefined
      if (sqlState !== undefined) {
        const failure = new Error(`transaction aborted with ${sqlState}`)
        this.retryableErrors.set(failure, sqlState)
        throw failure
      }
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

  readP2TRSignatureFraudWatchtowerRetryableTransactionSQLState(
    error: unknown
  ): "40001" | "40P01" | undefined {
    if (typeof error !== "object" || error === null) return undefined
    return this.retryableErrors.get(error)
  }

  isP2TRSignatureFraudWatchtowerTransactionActive(): boolean {
    return this.active
  }

  failNextTransactionWith(sqlState: "40001" | "40P01"): void {
    this.failures.push(sqlState)
  }

  stage(mutation: () => void): void {
    if (!this.active) throw new Error("test mutation is outside a transaction")
    this.staged.push(mutation)
  }
}

type CandidateJournal = {
  guards: P2TRProductionCandidateEnqueueTransactionGuard[]
  resolutions: P2TRProductionCandidateEnqueueTransactionResolution[]
  exhaustionAlerts: P2TRProductionCandidateEnqueueRetryExhaustionAlert[]
}

function emptyCandidateJournal(): CandidateJournal {
  return { guards: [], resolutions: [], exhaustionAlerts: [] }
}

function candidateStateStore(
  coordinator: RollbackAwareCoordinator,
  dispositions: string[],
  journal: CandidateJournal,
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
    async readRuntimeAlertHealth() {
      return healthFor(journal)
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
    async armCandidateEnqueueTransactionGuard(guard) {
      coordinator.stage(() => {
        journal.guards.push(guard)
        sequence?.push("guard-committed")
      })
    },
    async resolveCandidateEnqueueTransactionGuard(resolution) {
      coordinator.stage(() => {
        journal.resolutions.push(resolution)
        sequence?.push("resolution-committed")
      })
    },
    async saveCandidateEnqueueRetryExhaustionAlert(alert) {
      coordinator.stage(() => journal.exhaustionAlerts.push(alert))
    },
  }
}

function healthFor(
  journal: CandidateJournal
): P2TRProductionRuntimeAlertHealth {
  const resolved = new Set(
    journal.resolutions.map(
      (resolution) => `${resolution.manifestHash}:${resolution.tokenID}`
    )
  )
  return {
    manifestHash: MANIFEST_HASH,
    unresolvedCandidateEnqueueTransactionGuardCount: journal.guards.filter(
      (guard) => !resolved.has(`${guard.manifestHash}:${guard.tokenID}`)
    ).length,
    candidateEnqueueRetryExhaustionCount: journal.exhaustionAlerts.length,
  }
}

function gateForCandidate(
  coordinator: RollbackAwareCoordinator,
  stateStore: P2TRProductionStateStore,
  candidateEnqueuer: P2TRProductionActivationDependencies["candidateEnqueuer"],
  maxAttempts = 3
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
  Object.assign(gate, {
    dependencies,
    candidateTokens,
    candidateEnqueueTransactionMaxAttempts: maxAttempts,
  })
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
