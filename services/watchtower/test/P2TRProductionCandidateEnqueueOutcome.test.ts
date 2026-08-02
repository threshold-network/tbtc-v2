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
  type P2TRProductionCandidateEnqueueNonRetryableFailure,
  type P2TRProductionCandidateEnqueueRetryExhaustionAlert,
  type P2TRProductionCandidateEnqueueTransactionGuard,
  type P2TRProductionCandidateEnqueueTransactionRecovery,
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
type RetryableSQLState =
  P2TRProductionCandidateEnqueueRetryExhaustionAlert["lastSQLState"]

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
    assert.deepEqual(coordinator.readinessFences, ["shared", "exclusive"])
    assert.equal(coordinator.commits, 2)
    assert.equal(coordinator.rollbacks, 0)
    await assert.rejects(
      gate.consumeCandidateAuthorization(token, candidate),
      /invalid, expired, or used/
    )
  })

  it("rolls back nested work and disposes the guard after enqueue failure", async () => {
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
    assert.equal(journal.nonRetryableFailures.length, 1)
    assert.doesNotThrow(() =>
      assertP2TRProductionRuntimeAlertHealth(
        healthFor(journal),
        MANIFEST_HASH
      )
    )
    assert.equal(coordinator.commits, 2)
    assert.equal(coordinator.rollbacks, 1)
  })

  it("retries the complete database-only transaction after branded PostgreSQL aborts", async () => {
    for (const sqlState of ["40001", "40P01", "55P03", "57014"] as const) {
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

  it("retries connection failures before the enqueue callback starts", async () => {
    const coordinator = new RollbackAwareCoordinator()
    coordinator.failNextEnqueueTransactionSetup(
      new Error("pool connection failed before BEGIN")
    )
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
      3
    )

    assert.equal(
      await gate.consumeCandidateAuthorization(token, candidate),
      ENQUEUED_INTENT_ID
    )
    assert.equal(enqueueAttempts, 1)
    assert.deepEqual(dispositions, [ENQUEUED_INTENT_ID])
    assert.equal(journal.resolutions.length, 1)
    assert.equal(journal.nonRetryableFailures.length, 0)
    assert.deepEqual(coordinator.readinessFences, [
      "shared",
      "exclusive",
      "exclusive",
    ])
  })

  it("retries connection failures before the guard callback starts", async () => {
    const coordinator = new RollbackAwareCoordinator()
    coordinator.failNextGuardTransactionSetup(
      new Error("pool connection failed before guard BEGIN")
    )
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
      3
    )

    assert.equal(
      await gate.consumeCandidateAuthorization(token, candidate),
      ENQUEUED_INTENT_ID
    )
    assert.equal(enqueueAttempts, 1)
    assert.equal(journal.guards.length, 1)
    assert.equal(journal.resolutions.length, 1)
    assert.deepEqual(coordinator.readinessFences, [
      "shared",
      "shared",
      "exclusive",
    ])
  })

  it("leaves the guard unresolved when callback-unstarted retries exhaust", async () => {
    const coordinator = new RollbackAwareCoordinator()
    coordinator.failNextEnqueueTransactionSetup(new Error("pool unavailable"))
    coordinator.failNextEnqueueTransactionSetup(new Error("pool unavailable"))
    const journal = emptyCandidateJournal()
    const stateStore = candidateStateStore(coordinator, [], journal)
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
      /pool unavailable/
    )
    assert.equal(enqueueAttempts, 0)
    assert.equal(journal.guards.length, 1)
    assert.equal(journal.resolutions.length, 0)
    assert.equal(journal.exhaustionAlerts.length, 0)
    assert.equal(journal.nonRetryableFailures.length, 0)
    assert.throws(
      () =>
        assertP2TRProductionRuntimeAlertHealth(
          healthFor(journal),
          MANIFEST_HASH
        ),
      /activation-blocking candidate enqueue alerts/
    )
  })

  it("retries guard arming after branded PostgreSQL aborts", async () => {
    for (const sqlState of ["40001", "40P01", "55P03", "57014"] as const) {
      const coordinator = new RollbackAwareCoordinator()
      coordinator.failNextGuardTransactionWith(sqlState)
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
        3
      )

      assert.equal(
        await gate.consumeCandidateAuthorization(token, candidate),
        ENQUEUED_INTENT_ID
      )
      assert.equal(enqueueAttempts, 1)
      assert.deepEqual(dispositions, [ENQUEUED_INTENT_ID])
      assert.equal(journal.guards.length, 1)
      assert.equal(journal.resolutions.length, 1)
      assert.equal(coordinator.commits, 2)
      assert.equal(coordinator.rollbacks, 1)
    }
  })

  it("retries guard arming after confirmed pre-COMMIT transport aborts", async () => {
    const coordinator = new RollbackAwareCoordinator()
    coordinator.failNextGuardTransactionWithPreCommitTransportAbort(
      new Error("connection lost before guard COMMIT")
    )
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
      3
    )

    assert.equal(
      await gate.consumeCandidateAuthorization(token, candidate),
      ENQUEUED_INTENT_ID
    )
    assert.equal(enqueueAttempts, 1)
    assert.deepEqual(dispositions, [ENQUEUED_INTENT_ID])
    assert.equal(journal.guards.length, 1)
    assert.equal(journal.resolutions.length, 1)
    assert.equal(coordinator.commits, 2)
    assert.equal(coordinator.rollbacks, 1)
  })

  it("uses the complete retry budget for guard pre-COMMIT transport aborts", async () => {
    const coordinator = new RollbackAwareCoordinator()
    coordinator.failNextGuardTransactionWithPreCommitTransportAbort(
      new Error("first connection loss before guard COMMIT")
    )
    coordinator.failNextGuardTransactionWithPreCommitTransportAbort(
      new Error("second connection loss before guard COMMIT")
    )
    const journal = emptyCandidateJournal()
    const stateStore = candidateStateStore(coordinator, [], journal)
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
      candidateEnqueuer,
      2
    )

    await assert.rejects(
      gate.consumeCandidateAuthorization(token, candidate),
      /second connection loss before guard COMMIT/
    )
    assert.equal(journal.guards.length, 0)
    assert.equal(journal.resolutions.length, 0)
    assert.equal(coordinator.commits, 0)
    assert.equal(coordinator.rollbacks, 2)
  })

  it("retries confirmed pre-COMMIT transport aborts without disposing the guard", async () => {
    const coordinator = new RollbackAwareCoordinator()
    coordinator.failNextTransactionWithPreCommitTransportAbort(
      new Error("connection lost before enqueue COMMIT")
    )
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
    assert.equal(journal.nonRetryableFailures.length, 0)
  })

  it("leaves the guard unresolved when pre-COMMIT transport retries exhaust", async () => {
    const coordinator = new RollbackAwareCoordinator()
    coordinator.failNextTransactionWithPreCommitTransportAbort(
      new Error("first connection loss before COMMIT")
    )
    coordinator.failNextTransactionWithPreCommitTransportAbort(
      new Error("second connection loss before COMMIT")
    )
    const journal = emptyCandidateJournal()
    const stateStore = candidateStateStore(coordinator, [], journal)
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
      /second connection loss/
    )
    assert.equal(enqueueAttempts, 2)
    assert.equal(journal.guards.length, 1)
    assert.equal(journal.resolutions.length, 0)
    assert.equal(journal.exhaustionAlerts.length, 0)
    assert.equal(journal.nonRetryableFailures.length, 0)
    assert.throws(
      () =>
        assertP2TRProductionRuntimeAlertHealth(
          healthFor(journal),
          MANIFEST_HASH
        ),
      /activation-blocking candidate enqueue alerts/
    )
  })

  it("keeps an unresolved guard and durable alert after retry exhaustion", async () => {
    const coordinator = new RollbackAwareCoordinator()
    coordinator.failNextTransactionWith("55P03")
    coordinator.failNextTransactionWith("57014")
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
        assert.equal(error.alert.lastSQLState, "57014")
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
      lastSQLState: "57014",
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

  it("durably resolves the guard after a non-retryable application error", async () => {
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
    assert.equal(journal.nonRetryableFailures.length, 1)
    assert.equal(
      journal.nonRetryableFailures[0].candidateDigest,
      journal.guards[0].candidateDigest
    )
    assert.doesNotThrow(() =>
      assertP2TRProductionRuntimeAlertHealth(
        healthFor(journal),
        MANIFEST_HASH
      )
    )
    assert.equal(coordinator.commits, 2)
    assert.equal(coordinator.rollbacks, 1)
  })

  it("preserves an ambiguous COMMIT outcome without writing rollback disposition", async () => {
    const coordinator = new RollbackAwareCoordinator()
    const ambiguousCommit = new Error("enqueue COMMIT outcome is unknown")
    coordinator.failNextTransactionWithUnknownOutcome(ambiguousCommit)
    const journal = emptyCandidateJournal()
    const stateStore = candidateStateStore(coordinator, [], journal)
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

    await assert.rejects(
      gate.consumeCandidateAuthorization(token, candidate),
      (error) => error === ambiguousCommit
    )
    assert.equal(journal.guards.length, 1)
    assert.equal(journal.nonRetryableFailures.length, 0)
    assert.equal(journal.exhaustionAlerts.length, 0)
  })

  it("resumes an expired authorization from its durable armed guard", async () => {
    const coordinator = new RollbackAwareCoordinator()
    const dispositions: string[] = []
    const journal = emptyCandidateJournal()
    const recoveries: P2TRProductionCandidateEnqueueTransactionRecovery[] = []
    const stateStore = candidateStateStore(
      coordinator,
      dispositions,
      journal,
      undefined,
      recoveries
    )
    const candidateEnqueuer = {
      p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
      enqueueReconciledCandidate:
        async (): Promise<P2TRProductionCandidateEnqueueOutcome> => ({
          kind: "enqueued",
          outboxIntentID: ENQUEUED_INTENT_ID,
        }),
    }
    const { gate, token } = gateForCandidate(
      coordinator,
      stateStore,
      candidateEnqueuer,
      3
    )
    const record = (
      gate as unknown as {
        candidateTokens: WeakMap<
          object,
          { receipt: P2TRProductionCandidateAuthorizationReceipt }
        >
      }
    ).candidateTokens.get(token)!
    const guard = {
      tokenID: record.receipt.tokenID,
      manifestHash: record.receipt.manifestHash,
      candidateDigest: record.receipt.candidateDigest,
      maxAttemptCount: 3,
    }
    record.receipt.expiresAt = new Date(Date.now() - 60_000).toISOString()
    journal.guards.push(guard)
    recoveries.push({ guard, authorization: record.receipt })

    await gate.recoverCandidateEnqueueTransactionGuards()

    assert.deepEqual(dispositions, [ENQUEUED_INTENT_ID])
    assert.equal(journal.resolutions.length, 1)
    assert.equal(journal.nonRetryableFailures.length, 0)
    assert.doesNotThrow(() =>
      assertP2TRProductionRuntimeAlertHealth(healthFor(journal), MANIFEST_HASH)
    )
  })

  it("surfaces a recovery error even when its terminal disposition makes health clean", async () => {
    const coordinator = new RollbackAwareCoordinator()
    const journal = emptyCandidateJournal()
    const recoveries: P2TRProductionCandidateEnqueueTransactionRecovery[] = []
    const stateStore = candidateStateStore(
      coordinator,
      [],
      journal,
      undefined,
      recoveries
    )
    const recoveryError = new Error("candidate authority became invalid")
    const candidateEnqueuer = {
      p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
      async enqueueReconciledCandidate(): Promise<P2TRProductionCandidateEnqueueOutcome> {
        throw recoveryError
      },
    }
    const { gate, token } = gateForCandidate(
      coordinator,
      stateStore,
      candidateEnqueuer
    )
    const record = (
      gate as unknown as {
        candidateTokens: WeakMap<
          object,
          { receipt: P2TRProductionCandidateAuthorizationReceipt }
        >
      }
    ).candidateTokens.get(token)!
    const guard = {
      tokenID: record.receipt.tokenID,
      manifestHash: record.receipt.manifestHash,
      candidateDigest: record.receipt.candidateDigest,
      maxAttemptCount: 3,
    }
    journal.guards.push(guard)
    recoveries.push({ guard, authorization: record.receipt })

    await assert.rejects(
      gate.recoverCandidateEnqueueTransactionGuards(),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError)
        assert.match(error.message, /Candidate enqueue guard recovery failed/)
        assert.deepEqual(error.errors, [recoveryError])
        return true
      }
    )
    assert.equal(journal.nonRetryableFailures.length, 1)
    assert.doesNotThrow(() =>
      assertP2TRProductionRuntimeAlertHealth(healthFor(journal), MANIFEST_HASH)
    )
  })

  it("attaches guard recovery failures to the activation blocker", async () => {
    const coordinator = new RollbackAwareCoordinator()
    const journal = emptyCandidateJournal()
    const recoveries: P2TRProductionCandidateEnqueueTransactionRecovery[] = []
    const stateStore = candidateStateStore(
      coordinator,
      [],
      journal,
      undefined,
      recoveries
    )
    const dispositionError = new Error(
      "Candidate enqueue non-retryable failure conflicts with durable state"
    )
    stateStore.saveCandidateEnqueueNonRetryableFailure = async () => {
      throw dispositionError
    }
    const candidateEnqueuer = {
      p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
      async enqueueReconciledCandidate(): Promise<P2TRProductionCandidateEnqueueOutcome> {
        throw new Error("candidate became non-canonical")
      },
    }
    const { gate, token } = gateForCandidate(
      coordinator,
      stateStore,
      candidateEnqueuer
    )
    const record = (
      gate as unknown as {
        candidateTokens: WeakMap<
          object,
          { receipt: P2TRProductionCandidateAuthorizationReceipt }
        >
      }
    ).candidateTokens.get(token)!
    const guard = {
      tokenID: record.receipt.tokenID,
      manifestHash: record.receipt.manifestHash,
      candidateDigest: record.receipt.candidateDigest,
      maxAttemptCount: 3,
    }
    journal.guards.push(guard)
    recoveries.push({ guard, authorization: record.receipt })

    await assert.rejects(
      gate.recoverCandidateEnqueueTransactionGuards(),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(
          error.message,
          /activation-blocking candidate enqueue alerts/
        )
        assert.ok(error.cause instanceof AggregateError)
        assert.equal(error.cause.errors.length, 1)
        assert.equal(error.cause.errors[0], dispositionError)
        return true
      }
    )
  })
})

class RollbackAwareCoordinator implements P2TRProductionTransactionCoordinator {
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID = STORE_ID
  commits = 0
  rollbacks = 0
  readonly readinessFences: Array<"shared" | "exclusive"> = []
  private active = false
  private staged: Array<() => void> = []
  private readonly sequence?: string[]
  private readonly failures: RetryableSQLState[] = []
  private readonly guardFailures: RetryableSQLState[] = []
  private readonly guardSetupFailures: Error[] = []
  private readonly enqueueSetupFailures: Error[] = []
  private readonly guardPreCommitTransportFailures: Error[] = []
  private readonly preCommitTransportFailures: Error[] = []
  private readonly retryableErrors = new WeakMap<object, RetryableSQLState>()
  private readonly preCommitTransportErrors = new WeakSet<object>()
  private readonly unknownOutcomeErrors = new WeakSet<object>()
  private unknownOutcomeFailure: Error | undefined

  constructor(sequence?: string[]) {
    this.sequence = sequence
  }

  async runInP2TRSignatureFraudWatchtowerTransaction<T>(
    operation: () => Promise<T>,
    options: { readinessFence?: "shared" | "exclusive" } = {}
  ): Promise<T> {
    if (this.active) return operation()
    this.readinessFences.push(options.readinessFence ?? "shared")
    if (this.commits === 0 && this.guardSetupFailures.length > 0) {
      throw this.guardSetupFailures.shift()
    }
    if (this.commits > 0 && this.enqueueSetupFailures.length > 0) {
      throw this.enqueueSetupFailures.shift()
    }
    this.active = true
    this.staged = []
    try {
      const result = await operation()
      const sqlState =
        this.guardFailures.shift() ??
        (this.commits > 0 ? this.failures.shift() : undefined)
      if (sqlState !== undefined) {
        const failure = new Error(`transaction aborted with ${sqlState}`)
        this.retryableErrors.set(failure, sqlState)
        throw failure
      }
      const transportFailure =
        this.commits === 0
          ? this.guardPreCommitTransportFailures.shift()
          : this.preCommitTransportFailures.shift()
      if (transportFailure !== undefined) {
        this.preCommitTransportErrors.add(transportFailure)
        throw transportFailure
      }
      if (this.commits > 0 && this.unknownOutcomeFailure !== undefined) {
        const failure = this.unknownOutcomeFailure
        this.unknownOutcomeFailure = undefined
        this.unknownOutcomeErrors.add(failure)
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
  ): RetryableSQLState | undefined {
    if (typeof error !== "object" || error === null) return undefined
    return this.retryableErrors.get(error)
  }

  isP2TRSignatureFraudWatchtowerTransactionOutcomeUnknown(
    error: unknown
  ): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      this.unknownOutcomeErrors.has(error)
    )
  }

  isP2TRSignatureFraudWatchtowerTransactionConfirmedPreCommitTransportAbort(
    error: unknown
  ): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      this.preCommitTransportErrors.has(error)
    )
  }

  isP2TRSignatureFraudWatchtowerTransactionActive(): boolean {
    return this.active
  }

  failNextTransactionWith(sqlState: RetryableSQLState): void {
    this.failures.push(sqlState)
  }

  failNextGuardTransactionWith(sqlState: RetryableSQLState): void {
    this.guardFailures.push(sqlState)
  }

  failNextGuardTransactionSetup(error: Error): void {
    this.guardSetupFailures.push(error)
  }

  failNextEnqueueTransactionSetup(error: Error): void {
    this.enqueueSetupFailures.push(error)
  }

  failNextTransactionWithPreCommitTransportAbort(error: Error): void {
    this.preCommitTransportFailures.push(error)
  }

  failNextGuardTransactionWithPreCommitTransportAbort(error: Error): void {
    this.guardPreCommitTransportFailures.push(error)
  }

  failNextTransactionWithUnknownOutcome(error: Error): void {
    this.unknownOutcomeFailure = error
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
  nonRetryableFailures: P2TRProductionCandidateEnqueueNonRetryableFailure[]
}

function emptyCandidateJournal(): CandidateJournal {
  return {
    guards: [],
    resolutions: [],
    exhaustionAlerts: [],
    nonRetryableFailures: [],
  }
}

function candidateStateStore(
  coordinator: RollbackAwareCoordinator,
  dispositions: string[],
  journal: CandidateJournal,
  sequence?: string[],
  recoveries: readonly P2TRProductionCandidateEnqueueTransactionRecovery[] = []
): P2TRProductionStateStore {
  return {
    p2trSignatureFraudWatchtowerTransactionalStoreID: STORE_ID,
    async lockReadinessSnapshot() {
      throw new Error("unused test dependency")
    },
    async readBitcoinIndexHealth() {
      throw new Error("unused test dependency")
    },
    async readEthereumJournalHealth() {
      throw new Error("unused test dependency")
    },
    async readOutboxRevalidation() {
      throw new Error("unused test dependency")
    },
    async readRuntimeAlertHealth() {
      return healthFor(journal)
    },
    async mintReadinessCertificate() {
      throw new Error("unused test dependency")
    },
    async assertCandidateIndexed() {},
    async issueCandidateAuthorization() {
      throw new Error("unused test dependency")
    },
    async lockCandidateAuthorization(tokenID, candidateDigest, manifestHash) {
      const terminal = new Set([
        ...journal.resolutions.map(
          (resolution) => `${resolution.manifestHash}:${resolution.tokenID}`
        ),
        ...journal.exhaustionAlerts.map(
          (alert) => `${alert.manifestHash}:${alert.tokenID}`
        ),
        ...journal.nonRetryableFailures.map(
          (failure) => `${failure.manifestHash}:${failure.tokenID}`
        ),
      ])
      const guard = journal.guards.find(
        (candidateGuard) =>
          candidateGuard.tokenID === tokenID &&
          candidateGuard.candidateDigest === candidateDigest &&
          candidateGuard.manifestHash === manifestHash
      )
      if (
        guard === undefined ||
        terminal.has(`${guard.manifestHash}:${guard.tokenID}`)
      ) {
        throw new Error("candidate authorization lacks an unresolved guard")
      }
    },
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
    async listUnresolvedCandidateEnqueueTransactionGuards() {
      return recoveries
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
    async resolveCandidateEnqueueRetryExhaustionAlert() {
      throw new Error("unused test dependency")
    },
    async saveCandidateEnqueueNonRetryableFailure(failure) {
      coordinator.stage(() => journal.nonRetryableFailures.push(failure))
    },
  }
}

function healthFor(
  journal: CandidateJournal
): P2TRProductionRuntimeAlertHealth {
  const resolved = new Set([
    ...journal.resolutions.map(
      (resolution) => `${resolution.manifestHash}:${resolution.tokenID}`
    ),
    ...journal.exhaustionAlerts.map(
      (alert) => `${alert.manifestHash}:${alert.tokenID}`
    ),
    ...journal.nonRetryableFailures.map(
      (failure) => `${failure.manifestHash}:${failure.tokenID}`
    ),
  ])
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
  const transactionIdentity = {
    txid: "55".repeat(32),
    wtxid: "66".repeat(32),
    blockHeight: 840_000,
    blockHash: "77".repeat(32),
  }
  const candidate: P2TRProductionBitcoinCandidateIdentity = {
    ...transactionIdentity,
    inputIndex: 0,
    observationID:
      deriveP2TRProductionCandidateObservationID(transactionIdentity),
    challengeKey: `0x${"99".repeat(32)}`,
  }
  const normalized: P2TRProductionBitcoinCandidate = candidate
  const receipt: P2TRProductionCandidateAuthorizationReceipt = {
    tokenID: TOKEN_ID,
    manifestHash: MANIFEST_HASH,
    candidateDigest: hashCandidate(normalized),
    candidate: normalized,
    readinessCertificate: {
      certificateID: `0x${"aa".repeat(32)}`,
      generation: 1,
    },
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
    manifestHash: MANIFEST_HASH,
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
