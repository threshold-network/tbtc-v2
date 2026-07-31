import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import {
  PostgresP2TRCanonicalIndexStore,
  type P2TRPostgresClient,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import { PostgresP2TRProductionActivationStore } from "../src/PostgresP2TRProductionActivationStore.js"
import type { P2TRProductionReadinessCertificateInput } from "../src/P2TRProductionActivation.js"

const WORD = (byte: string) => byte.repeat(32)

describe("PostgreSQL production transaction capabilities", () => {
  it("rejects a structurally compatible autocommit session", () => {
    assert.throws(
      () =>
        new PostgresP2TRProductionActivationStore(
          { query: async () => ({ rows: [], rowCount: 0 }) },
          { storeID: "watchtower", maxEventHistoryRecords: 10 }
        ),
      /coordinator-owned transaction session/
    )
  })

  it("mints an adapter that works only inside its coordinator transaction", async () => {
    const client = new TransactionClient()
    const coordinator = coordinatorFor(client)
    const adapter =
      coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) => ({ query: () => session.query("SELECT 1") })
      )
    assert.throws(() => adapter.query(), /active transaction/)
    await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(() =>
      adapter.query()
    )
    assert.deepEqual(client.queries.slice(0, 7), [
      "SELECT current_setting('lock_timeout') AS lock_timeout",
      "SELECT set_config('lock_timeout', $1, false)",
      "SELECT pg_advisory_lock_shared(hashtextextended('p2tr-readiness-pre-snapshot-fence', 0))",
      "SELECT set_config('lock_timeout', $1, false)",
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT current_setting('server_version_num') AS server_version_num",
    ])
    assert.ok(client.queries.includes("SELECT 1"))
    assert.equal(client.releasedWith, undefined)
  })

  it("takes the exclusive readiness fence before opening its snapshot", async () => {
    const client = new TransactionClient()
    const coordinator = coordinatorFor(client)

    await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(
      async () => undefined,
      { readinessFence: "exclusive" }
    )

    assert.equal(
      client.queries[2],
      "SELECT pg_advisory_lock(hashtextextended('p2tr-readiness-pre-snapshot-fence', 0))"
    )
    assert.ok(client.queries.indexOf("BEGIN ISOLATION LEVEL SERIALIZABLE") > 0)
    assert.ok(
      client.queries.indexOf("COMMIT") <
        client.queries.findIndex((query) =>
          query.includes("pg_advisory_unlock(")
        )
    )
  })

  it("bounds the pre-snapshot fence wait and restores lock_timeout", async () => {
    const client = new TransactionClient("FENCE")
    const coordinator = coordinatorFor(client)

    await assert.rejects(
      coordinator.runInP2TRSignatureFraudWatchtowerTransaction(
        async () => undefined
      ),
      /readiness fence lock timeout/
    )

    assert.deepEqual(client.queries.slice(0, 4), [
      "SELECT current_setting('lock_timeout') AS lock_timeout",
      "SELECT set_config('lock_timeout', $1, false)",
      "SELECT pg_advisory_lock_shared(hashtextextended('p2tr-readiness-pre-snapshot-fence', 0))",
      "SELECT set_config('lock_timeout', $1, false)",
    ])
    assert.equal(
      client.queries.includes("BEGIN ISOLATION LEVEL SERIALIZABLE"),
      false
    )
    assert.ok(client.releasedWith instanceof Error)
  })

  it("serializes writers on both sides of the pre-snapshot readiness fence", async () => {
    const fence = new ReadinessFence()
    const firstWriterClient = new TransactionClient(undefined, 0, fence)
    const readinessClient = new TransactionClient(undefined, 0, fence)
    const secondWriterClient = new TransactionClient(undefined, 0, fence)
    const firstWriterCoordinator = coordinatorFor(firstWriterClient)
    const readinessCoordinator = coordinatorFor(readinessClient)
    const secondWriterCoordinator = coordinatorFor(secondWriterClient)
    const order: string[] = []

    let releaseFirstWriter!: () => void
    let markFirstWriterStarted!: () => void
    const firstWriterGate = new Promise<void>((resolve) => {
      releaseFirstWriter = resolve
    })
    const firstWriterStarted = new Promise<void>((resolve) => {
      markFirstWriterStarted = resolve
    })
    const firstWriter =
      firstWriterCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
        async () => {
          order.push("first-writer-started")
          markFirstWriterStarted()
          await firstWriterGate
          order.push("first-writer-finished")
        }
      )
    await firstWriterStarted

    let releaseReadiness!: () => void
    let markReadinessStarted!: () => void
    const readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve
    })
    const readinessStarted = new Promise<void>((resolve) => {
      markReadinessStarted = resolve
    })
    const readiness =
      readinessCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
        async () => {
          order.push("readiness-started")
          markReadinessStarted()
          await readinessGate
          order.push("readiness-finished")
        },
        { readinessFence: "exclusive" }
      )
    await Promise.resolve()
    assert.equal(
      readinessClient.queries.includes("BEGIN ISOLATION LEVEL SERIALIZABLE"),
      false
    )

    releaseFirstWriter()
    await firstWriter
    await readinessStarted

    const secondWriter =
      secondWriterCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
        async () => {
          order.push("second-writer-started")
        }
      )
    await Promise.resolve()
    assert.equal(
      secondWriterClient.queries.includes("BEGIN ISOLATION LEVEL SERIALIZABLE"),
      false
    )

    releaseReadiness()
    await Promise.all([readiness, secondWriter])
    assert.deepEqual(order, [
      "first-writer-started",
      "first-writer-finished",
      "readiness-started",
      "readiness-finished",
      "second-writer-started",
    ])
  })

  it("mints readiness authority before issuing a candidate authorization", async () => {
    const client = new TransactionClient()
    const coordinator = coordinatorFor(client)
    const store =
      coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) =>
          new PostgresP2TRProductionActivationStore(session, {
            storeID: "watchtower",
            maxEventHistoryRecords: 10,
          })
      )

    await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
      await store.lockReadinessSnapshot()
      const readinessCertificate = await store.mintReadinessCertificate(
        readinessInput()
      )
      assert.match(readinessCertificate.certificateID, /^0x[0-9a-f]{64}$/)
      assert.equal(readinessCertificate.generation, 1)
      await store.issueCandidateAuthorization({
        tokenID: WORD("10"),
        manifestHash: WORD("20"),
        candidateDigest: WORD("30"),
        candidate: {
          txid: WORD("40"),
          wtxid: WORD("41"),
          blockHeight: 10,
          blockHash: WORD("42"),
          inputIndex: 0,
          observationID: WORD("43"),
          challengeKey: WORD("44"),
        },
        readinessCertificate,
        verifiedBitcoin: { height: 10, hash: WORD("50") },
        verifiedEthereum: { blockNumber: 20, blockHash: WORD("60") },
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })
    })

    assert.ok(
      client.queries.some((query) =>
        query.includes("INSERT INTO p2tr_readiness_certificates")
      )
    )
    const certificateInsert = client.queries.find((query) =>
      query.includes("INSERT INTO p2tr_readiness_certificates")
    )!
    assert.match(
      certificateInsert,
      /p2tr_signature_fraud_outbox_activation_revalidation/
    )
    assert.match(certificateInsert, /clock_timestamp\(\)/)
    assert.match(certificateInsert, /recovery_backlog_count <= \$16/)
    assert.ok(
      client.queries.some((query) =>
        query.includes("INSERT INTO p2tr_candidate_enqueue_authorizations")
      )
    )
    assert.equal(
      client.queries.filter((query) => query.includes("pg_advisory_xact_lock"))
        .length,
      3,
      "the caller, certificate mint, and authorization issue share the database lock"
    )
  })

  it("refuses to mint when a preparation lease expires at INSERT time", async () => {
    const client = new TransactionClient(undefined, 0, undefined, 1)
    const coordinator = coordinatorFor(client)
    const store =
      coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) =>
          new PostgresP2TRProductionActivationStore(session, {
            storeID: "watchtower",
            maxEventHistoryRecords: 10,
          })
      )

    await assert.rejects(
      coordinator.runInP2TRSignatureFraudWatchtowerTransaction(() =>
        store.mintReadinessCertificate(readinessInput())
      ),
      /outbox recovery backlog exceeded its manifest bound/
    )
  })

  it("preserves a current certificate while it backs a live authorization", async () => {
    const client = new TransactionClient(undefined, 1)
    const coordinator = coordinatorFor(client)
    const store =
      coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) =>
          new PostgresP2TRProductionActivationStore(session, {
            storeID: "watchtower",
            maxEventHistoryRecords: 10,
          })
      )

    await assert.rejects(
      coordinator.runInP2TRSignatureFraudWatchtowerTransaction(() =>
        store.mintReadinessCertificate(readinessInput())
      ),
      /live candidate authorization/
    )
    assert.equal(
      client.queries.some((query) =>
        query.includes("UPDATE p2tr_readiness_certificate_generation")
      ),
      false,
      "a rejected replacement must not consume a generation"
    )
    assert.equal(
      client.queries.some((query) => query.includes("SET is_current = false")),
      false,
      "a rejected replacement must leave the backing certificate current"
    )
  })

  it("locks authorization against the certificate's exact current CAS", async () => {
    const client = new TransactionClient()
    const coordinator = coordinatorFor(client)
    const store =
      coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) =>
          new PostgresP2TRProductionActivationStore(session, {
            storeID: "watchtower",
            maxEventHistoryRecords: 10,
          })
      )

    await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(() =>
      store.lockCandidateAuthorization(WORD("10"), WORD("30"), WORD("20"))
    )

    const query = client.queries.find((text) =>
      text.includes("FROM p2tr_candidate_enqueue_authorizations authorization")
    )
    assert.ok(query)
    assert.match(query, /JOIN p2tr_readiness_certificates certificate/)
    assert.match(query, /JOIN p2tr_canonical_generations certified_generation/)
    assert.match(query, /JOIN p2tr_bitcoin_cursor certified_bitcoin/)
    assert.match(query, /JOIN p2tr_ethereum_cursor certified_ethereum/)
    assert.match(
      query,
      /certified_generation\.generation_id = \([\s\S]*?SELECT max\(generation_id\)/
    )
    assert.doesNotMatch(query, /JOIN p2tr_bitcoin_blocks bitcoin_block\b/)
    assert.doesNotMatch(query, /JOIN p2tr_ethereum_blocks ethereum_block\b/)
  })

  it("destroys sessions after COMMIT or ROLLBACK ambiguity", async () => {
    for (const failure of ["COMMIT", "ROLLBACK"] as const) {
      const client = new TransactionClient(failure)
      const coordinator = coordinatorFor(client)
      await assert.rejects(
        coordinator.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
          if (failure === "ROLLBACK") throw new Error("operation failed")
        })
      )
      assert.ok(client.releasedWith instanceof Error)
    }
  })
})

function coordinatorFor(client: P2TRPostgresClient) {
  return new PostgresP2TRCanonicalIndexStore(
    { connect: async () => client },
    {
      storeID: "watchtower",
      maxJournalBlocks: 10,
      maxJournalTransactions: 10,
      maxJournalInputs: 10,
      maxJournalOutputs: 10,
      maxWalletBindings: 10,
      maxPendingDepositReveals: 10,
      maxUnmatchedProofs: 10,
      maxProofMutationBatchSize: 10,
      maxProofPageSize: 10,
      maxProofPayloadBytes: 1024,
      authorizationDomain: {
        chainID: "31337",
        bridgeAddress: "12".repeat(20),
      },
      sourceIdentity: {
        clusterID: "transaction-session-test",
        operatorID: "transaction-session-test",
        bitcoinIdentityDigest: "21".repeat(32),
        ethereumIdentityDigest: "22".repeat(32),
      },
      readinessExportSigner: {
        keyID: "transaction-session-test",
        async signPayloadDigest(): Promise<string> {
          return "ab".repeat(64)
        },
      },
      readinessExportAcknowledgementVerifier: {
        async verify(): Promise<boolean> {
          return true
        },
      },
    }
  )
}

class TransactionClient implements P2TRPostgresClient {
  readonly queries: string[] = []
  releasedWith: Error | undefined

  constructor(
    private readonly failure?: "COMMIT" | "ROLLBACK" | "FENCE",
    private readonly liveCandidateAuthorizationCount = 0,
    private readonly readinessFence?: ReadinessFence,
    private readonly recoveryBacklogAtMint = 0
  ) {}

  async query<Row>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push(text)
    if (text === this.failure) throw new Error(`${text} failed`)
    if (
      this.failure === "FENCE" &&
      text.includes("pg_advisory_lock_shared(") &&
      !text.includes("pg_advisory_xact_lock_shared(")
    ) {
      throw Object.assign(new Error("readiness fence lock timeout"), {
        code: "55P03",
      })
    }
    if (text.includes("current_setting('lock_timeout')")) {
      return { rows: [{ lock_timeout: "0" }] as Row[], rowCount: 1 }
    }
    if (text.includes("pg_advisory_unlock_shared(")) {
      this.readinessFence?.release("shared")
      return { rows: [{ unlocked: true }] as Row[], rowCount: 1 }
    }
    if (text.includes("pg_advisory_unlock(")) {
      this.readinessFence?.release("exclusive")
      return { rows: [{ unlocked: true }] as Row[], rowCount: 1 }
    }
    if (
      text.includes("pg_advisory_lock_shared(") &&
      !text.includes("pg_advisory_xact_lock_shared(")
    ) {
      await this.readinessFence?.acquire("shared")
    }
    if (
      text.includes("pg_advisory_lock(") &&
      !text.includes("pg_advisory_xact_lock(")
    ) {
      await this.readinessFence?.acquire("exclusive")
    }
    if (text.includes(" AS unlocked")) {
      return { rows: [{ unlocked: true }] as Row[], rowCount: 1 }
    }
    if (text.includes("server_version_num")) {
      return {
        rows: [{ server_version_num: "160000" }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("p2tr_watchtower_schema_version")) {
      return {
        rows: [{ version: 4 }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("p2tr_assert_complete_authorization_domain")) {
      const chainID = BigInt(String(values?.[1]))
      const domainDigest = createHash("sha256")
        .update("tbtc-p2tr-complete-domain-v1", "utf8")
        .update(values?.[0] as Buffer)
        .update(Buffer.from(chainID.toString(16).padStart(64, "0"), "hex"))
        .update(values?.[2] as Buffer)
        .digest("hex")
      return { rows: [{ domain_digest: domainDigest }] as Row[], rowCount: 1 }
    }
    if (text.includes("p2tr_assert_watchtower_source_identity")) {
      const sourceIdentityDigest = createHash("sha256")
        .update(
          `tbtc-p2tr-watchtower-source-identity-v1\x1f${String(
            values?.[0]
          )}\x1f${String(values?.[1])}\x1f${String(values?.[2])}`,
          "utf8"
        )
        .update(values?.[3] as Buffer)
        .update(values?.[4] as Buffer)
        .digest("hex")
      return {
        rows: [{ source_identity_digest: sourceIdentityDigest }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("AS primary_bitcoin_generation")) {
      return {
        rows: [
          {
            activation_sequence: 1,
            outbox_max_recovery_backlog: 0,
            primary_bitcoin_generation: 1,
            primary_bitcoin_root: WORD("70"),
            primary_bitcoin_semantic_root: WORD("71"),
            local_bitcoin_height: 10,
            local_bitcoin_hash: WORD("42"),
            ethereum_journal_generation: 1,
            ethereum_history_root: WORD("72"),
            local_ethereum_block: 20,
            local_ethereum_hash: WORD("60"),
          },
        ] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("AS live_authorization_count")) {
      return {
        rows: [
          {
            live_authorization_count: this.liveCandidateAuthorizationCount,
          },
        ] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("RETURNING next_generation - 1")) {
      return {
        rows: [{ certificate_generation: 1 }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("INSERT INTO p2tr_readiness_certificates")) {
      return {
        rows: [],
        rowCount: this.recoveryBacklogAtMint <= Number(values?.[15]) ? 1 : 0,
      }
    }
    if (
      text.includes("SELECT encode(manifest_hash") &&
      text.includes("p2tr_watchtower_activation_manifest")
    ) {
      return {
        rows: [{ manifest_hash: WORD("20") }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("INSERT INTO p2tr_candidate_enqueue_authorizations")) {
      return { rows: [], rowCount: 1 }
    }
    if (
      text.includes("FROM p2tr_candidate_enqueue_authorizations authorization")
    ) {
      return {
        rows: [
          {
            candidate_digest: WORD("30"),
            consumed_at: null,
            invalidated_at: null,
            live: true,
            canonical: true,
            current_manifest_hash: WORD("20"),
          },
        ] as Row[],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  }

  release(error?: Error): void {
    this.releasedWith = error
  }
}

class ReadinessFence {
  private sharedHolders = 0
  private exclusiveHolder = false
  private readonly waiters: {
    mode: "shared" | "exclusive"
    resolve: () => void
  }[] = []

  async acquire(mode: "shared" | "exclusive"): Promise<void> {
    if (this.waiters.length === 0 && this.canAcquire(mode)) {
      this.grant(mode)
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ mode, resolve })
      this.drain()
    })
  }

  release(mode: "shared" | "exclusive"): void {
    if (mode === "exclusive") {
      assert.equal(this.exclusiveHolder, true)
      this.exclusiveHolder = false
    } else {
      assert.ok(this.sharedHolders > 0)
      this.sharedHolders--
    }
    this.drain()
  }

  private canAcquire(mode: "shared" | "exclusive"): boolean {
    return mode === "shared"
      ? !this.exclusiveHolder
      : !this.exclusiveHolder && this.sharedHolders === 0
  }

  private grant(mode: "shared" | "exclusive"): void {
    if (mode === "exclusive") this.exclusiveHolder = true
    else this.sharedHolders++
  }

  private drain(): void {
    if (this.waiters.length === 0 || this.exclusiveHolder) return
    if (this.waiters[0].mode === "exclusive") {
      if (this.sharedHolders > 0) return
      const waiter = this.waiters.shift()!
      this.grant(waiter.mode)
      waiter.resolve()
      return
    }
    while (this.waiters[0]?.mode === "shared") {
      const waiter = this.waiters.shift()!
      this.grant(waiter.mode)
      waiter.resolve()
    }
  }
}

function readinessInput(): P2TRProductionReadinessCertificateInput {
  const bitcoinIndex = {
    storeID: "watchtower",
    configurationFingerprint: WORD("80"),
    network: "main",
    checkpoint: { height: 0, hash: WORD("81") },
    current: { height: 10, hash: WORD("42") },
    canonicalBlockCount: 11,
    pendingCandidates: 0,
    pendingDepositReveals: 0,
    unmatchedProofs: 0,
    liveCandidateAuthorizations: 0,
    unbackfilledFrostWalletBindings: 0,
    failureGeneration: 0,
    clearedFailureGeneration: 0,
  }
  const ethereumJournal = {
    storeID: "watchtower",
    chainID: 1,
    configurationFingerprint: WORD("82"),
    descriptorSetHash: WORD("83"),
    checkpoint: { blockNumber: 9, blockHash: WORD("84") },
    scanStartBlock: 10,
    current: { blockNumber: 20, blockHash: WORD("60") },
    requiredEventHistoryDigest: WORD("85"),
    requiredEventCount: 1,
    requiredEventCoverage: {
      blocks: 11,
      transactions: 1,
      receipts: 1,
      logs: 1,
      requiredEvents: 1,
    },
    failureGeneration: 0,
    clearedFailureGeneration: 0,
  }
  return {
    manifestHash: WORD("20"),
    verifiedBitcoin: { height: 10, hash: WORD("50") },
    verifiedEthereum: { blockNumber: 20, blockHash: WORD("60") },
    bitcoinIndex,
    ethereumJournal,
    payload: {
      schema: "tbtc-p2tr-production-readiness-certificate/v1",
      manifestHash: WORD("20"),
      bitcoinIndex,
      ethereumJournal,
    },
  }
}
