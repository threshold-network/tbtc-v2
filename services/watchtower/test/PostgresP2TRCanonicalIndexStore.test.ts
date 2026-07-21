import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import {
  calculateP2TREvidenceChunkDigest,
  calculateP2TREvidenceChunkLeafDigest,
  calculateP2TREvidenceChunkManifestRoot,
  calculateP2TREvidenceContentDigest,
  calculateP2TREvidenceObjectDigest,
  calculateP2TRReadinessExportStreamLeafDigest,
  isP2TRPostgresTransactionConfirmedAbortError,
  PostgresP2TRCanonicalIndexStore,
  verifyP2TRReadinessExportObjectFrames,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import type {
  P2TRPostgresClient,
  P2TRPostgresPool,
  P2TRPostgresQueryResult,
  P2TRReadinessExportAcknowledgementVerification,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import type { P2TRReadinessExportStreamFrame } from "../src/P2TRCanonicalBitcoinIndex.js"

describe("PostgresP2TRCanonicalIndexStore", () => {
  it("verifies a bounded multi-chunk readiness object and rejects tampering", () => {
    const bytes = Buffer.allocUnsafe(70_000)
    bytes.forEach((_, index) => {
      bytes[index] = index % 251
    })
    const chunks = [bytes.subarray(0, 65_536), bytes.subarray(65_536)]
    const chunkFrames = chunks.map((chunk, index) => {
      const byteOffset = index * 65_536
      const digest = calculateP2TREvidenceChunkDigest(chunk)
      return {
        index,
        byteOffset,
        digest,
        leafDigest: calculateP2TREvidenceChunkLeafDigest({
          chunkIndex: index,
          byteOffset,
          chunkDigest: digest,
        }),
        bytes: chunk,
      }
    })
    const contentDigest = calculateP2TREvidenceContentDigest(bytes)
    const chunkManifestRoot = calculateP2TREvidenceChunkManifestRoot(
      chunkFrames.map(({ leafDigest }) => leafDigest)
    )
    const object = {
      kind: "bounded_fixture",
      byteLength: bytes.length,
      contentDigest,
      chunkCount: chunkFrames.length,
      chunkManifestRoot,
      digest: calculateP2TREvidenceObjectDigest({
        kind: "bounded_fixture",
        byteLength: bytes.length,
        chunkCount: chunkFrames.length,
        contentDigest,
        chunkManifestRoot,
      }),
    }
    const streamLeafDigest = calculateP2TRReadinessExportStreamLeafDigest({
      exportFence: 7,
      streamOrdinal: 3,
      objectDigest: object.digest,
      objectKind: object.kind,
      byteLength: object.byteLength,
      contentDigest: object.contentDigest,
      chunkManifestRoot: object.chunkManifestRoot,
    })
    const frames: P2TRReadinessExportStreamFrame[] = chunkFrames.map(
      (chunk) => ({
        schema: "tbtc-p2tr-readiness-export-stream-frame/v1",
        exportID: "31".repeat(32),
        exportFence: 7,
        streamOrdinal: 3,
        streamLeafDigest,
        object,
        chunk,
      })
    )

    assert.deepEqual(verifyP2TRReadinessExportObjectFrames(frames), {
      exportID: "31".repeat(32),
      exportFence: 7,
      streamOrdinal: 3,
      objectDigest: object.digest,
      contentDigest,
      chunkManifestRoot,
      streamLeafDigest,
      byteLength: bytes.length,
      chunkCount: 2,
    })

    const tampered = frames.map((frame) => ({
      ...frame,
      chunk: { ...frame.chunk, bytes: Buffer.from(frame.chunk.bytes) },
    }))
    ;(tampered[1].chunk.bytes as Buffer)[0] ^= 1
    assert.throws(
      () => verifyP2TRReadinessExportObjectFrames(tampered),
      /chunk frame is inconsistent/
    )
    assert.throws(
      () => calculateP2TREvidenceChunkDigest(Buffer.alloc(65_537)),
      /exceeds 64 KiB/
    )
  })

  it("rejects matching text store IDs owned by another coordinator", () => {
    const first = new PostgresP2TRCanonicalIndexStore(
      new FakePool(),
      storeOptions()
    )
    const second = new PostgresP2TRCanonicalIndexStore(
      new FakePool(),
      storeOptions()
    )
    const firstParticipants = [{}, {}, {}]
    firstParticipants.forEach((participant) =>
      first.registerP2TRSignatureFraudWatchtowerTransactionalParticipant(
        participant
      )
    )
    const impostor = {}
    second.registerP2TRSignatureFraudWatchtowerTransactionalParticipant(
      impostor
    )

    assert.doesNotThrow(() =>
      first.assertP2TRSignatureFraudWatchtowerSharedStore({
        persistence: firstParticipants[0],
        transactionSource: firstParticipants[1],
        bridgeLifecycleEventSource: firstParticipants[2],
      })
    )
    assert.throws(
      () =>
        first.assertP2TRSignatureFraudWatchtowerSharedStore({
          persistence: firstParticipants[0],
          transactionSource: impostor,
          bridgeLifecycleEventSource: firstParticipants[2],
        }),
      /not owned by this PostgreSQL transaction coordinator/
    )
  })

  it("rolls back the shared serializable transaction on failure", async () => {
    const pool = new FakePool()
    const store = new PostgresP2TRCanonicalIndexStore(pool, storeOptions())

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
        throw new Error("fail cycle")
      }),
      /fail cycle/
    )

    assert.deepEqual(pool.client.statements.slice(0, 2), [
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "SELECT set_config('statement_timeout', $1, true)",
    ])
    assert.equal(pool.client.statements.at(-1), "ROLLBACK")
    assert.equal(pool.client.released, true)
    assert.equal(pool.client.releaseArgument, undefined)
  })

  it("destroys a client whose rollback fails while preserving the operation error", async () => {
    const rollbackError = new Error("rollback transport failed")
    const client = new FakeClient({ ROLLBACK: rollbackError })
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )
    const operationError = new Error("fail cycle")

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
        throw operationError
      }),
      (error) => error === operationError
    )

    assert.equal(client.statements.at(-1), "ROLLBACK")
    assert.equal(client.releaseArgument, rollbackError)
  })

  it("destroys a client after an ambiguous BEGIN failure", async () => {
    const beginError = new Error("begin response lost")
    const client = new FakeClient({
      "BEGIN ISOLATION LEVEL SERIALIZABLE": beginError,
    })
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => undefined),
      (error) => error === beginError
    )

    assert.deepEqual(client.statements, ["BEGIN ISOLATION LEVEL SERIALIZABLE"])
    assert.equal(client.releaseArgument, beginError)
  })

  it("surfaces a swallowed query serialization abort without replaying the callback", async () => {
    const queryError = Object.assign(new Error("serialization abort"), {
      code: "40001",
    })
    const client = new FakeClient({ "SELECT retryable": queryError })
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )
    const adapter =
      store.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) => ({ query: () => session.query("SELECT retryable") })
      )
    let invocations = 0

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
        invocations++
        await assert.rejects(adapter.query(), (error) => error === queryError)
        return "swallowed"
      }),
      (error) => {
        assert.equal(isP2TRPostgresTransactionConfirmedAbortError(error), true)
        if (!isP2TRPostgresTransactionConfirmedAbortError(error)) return false
        assert.equal(error.reason, "retryable-sqlstate")
        assert.equal(error.sqlState, "40001")
        assert.equal(error.postgresError, queryError)
        assert.equal(error.operationError, queryError)
        return true
      }
    )

    assert.equal(invocations, 1)
    assert.equal(client.statements.at(-1), "ROLLBACK")
    assert.equal(client.statements.includes("COMMIT"), false)
    assert.equal(client.releaseArgument, undefined)
  })

  it("surfaces the original query abort after a callback wraps it", async () => {
    const queryError = Object.assign(new Error("deadlock abort"), {
      code: "40P01",
    })
    const client = new FakeClient({ "SELECT retryable": queryError })
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )
    const adapter =
      store.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) => ({ query: () => session.query("SELECT retryable") })
      )
    let wrapper: Error | undefined

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
        try {
          await adapter.query()
        } catch (error) {
          wrapper = new Error("wrapped database failure", { cause: error })
          throw wrapper
        }
      }),
      (error) => {
        assert.equal(isP2TRPostgresTransactionConfirmedAbortError(error), true)
        if (!isP2TRPostgresTransactionConfirmedAbortError(error)) return false
        assert.equal(error.sqlState, "40P01")
        assert.equal(error.postgresError, queryError)
        assert.equal(error.operationError, wrapper)
        return true
      }
    )
    assert.equal(client.statements.at(-1), "ROLLBACK")
  })

  it("never infers a confirmed abort from an arbitrary callback error code", async () => {
    const callbackError = Object.assign(new Error("external callback failed"), {
      code: "40001",
    })
    const client = new FakeClient()
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )
    let invocations = 0

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
        invocations++
        throw callbackError
      }),
      (error) => {
        assert.equal(error, callbackError)
        assert.equal(isP2TRPostgresTransactionConfirmedAbortError(error), false)
        return true
      }
    )

    assert.equal(invocations, 1)
    assert.equal(client.statements.at(-1), "ROLLBACK")
  })

  it("surfaces a server 40001 during COMMIT as a confirmed abort", async () => {
    const commitError = Object.assign(new Error("serialization at commit"), {
      code: "40001",
    })
    const client = new FakeClient({ COMMIT: commitError })
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )
    let invocations = 0

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
        invocations++
        return "result"
      }),
      (error) => {
        assert.equal(isP2TRPostgresTransactionConfirmedAbortError(error), true)
        if (!isP2TRPostgresTransactionConfirmedAbortError(error)) return false
        assert.equal(error.reason, "retryable-sqlstate")
        assert.equal(error.sqlState, "40001")
        assert.equal(error.postgresError, commitError)
        return true
      }
    )

    assert.equal(invocations, 1)
    assert.equal(client.statements.at(-1), "COMMIT")
    assert.equal(client.statements.includes("ROLLBACK"), false)
    assert.equal(client.releaseArgument, undefined)
  })

  it("keeps an uncoded COMMIT transport failure outcome unknown", async () => {
    const commitError = new Error("commit response lost")
    const client = new FakeClient({ COMMIT: commitError })
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => "result"),
      (error) => {
        assert.match(String(error), /transaction outcome is unknown/)
        assert.equal(isP2TRPostgresTransactionConfirmedAbortError(error), false)
        return true
      }
    )

    assert.equal(client.statements.at(-1), "COMMIT")
    assert.equal(client.statements.includes("ROLLBACK"), false)
    assert.equal(client.releaseArgument, commitError)
  })

  it("surfaces an explicit ROLLBACK command tag from COMMIT as confirmed", async () => {
    const client = new FakeClient({}, { COMMIT: "ROLLBACK" })
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => "result"),
      (error) => {
        assert.equal(isP2TRPostgresTransactionConfirmedAbortError(error), true)
        if (!isP2TRPostgresTransactionConfirmedAbortError(error)) return false
        assert.equal(error.reason, "rollback-command")
        assert.equal(error.sqlState, undefined)
        return true
      }
    )

    assert.equal(client.statements.at(-1), "COMMIT")
    assert.equal(client.statements.includes("ROLLBACK"), false)
    assert.equal(client.releaseArgument, undefined)
  })

  it("does not brand an abort when its explicit ROLLBACK fails", async () => {
    const rollbackError = new Error("rollback response lost")
    const queryError = Object.assign(new Error("serialization abort"), {
      code: "40001",
    })
    const client = new FakeClient({
      "SELECT retryable": queryError,
      ROLLBACK: rollbackError,
    })
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )
    const adapter =
      store.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) => ({ query: () => session.query("SELECT retryable") })
      )

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(() => adapter.query()),
      (error) => {
        assert.equal(error, queryError)
        assert.equal(isP2TRPostgresTransactionConfirmedAbortError(error), false)
        return true
      }
    )

    assert.equal(client.releaseArgument, rollbackError)
  })

  it("tracks a nested query abort in the outer AsyncLocalStorage transaction", async () => {
    const queryError = Object.assign(new Error("serialization abort"), {
      code: "40001",
    })
    const client = new FakeClient({ "SELECT retryable": queryError })
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )
    const adapter =
      store.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) => ({ query: () => session.query("SELECT retryable") })
      )
    let outerInvocations = 0
    let nestedInvocations = 0

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
        outerInvocations++
        await store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
          nestedInvocations++
          await adapter.query()
        })
      }),
      (error) => isP2TRPostgresTransactionConfirmedAbortError(error)
    )

    assert.equal(outerInvocations, 1)
    assert.equal(nestedInvocations, 1)
    assert.equal(
      client.statements.filter(
        (statement) => statement === "BEGIN ISOLATION LEVEL SERIALIZABLE"
      ).length,
      1
    )
    assert.equal(client.statements.at(-1), "ROLLBACK")
  })

  it("creates store-owned adapters with a transaction-scoped query capability", async () => {
    const pool = new FakePool()
    const store = new PostgresP2TRCanonicalIndexStore(pool, storeOptions())
    const adapter =
      store.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) => ({ query: () => session.query("SELECT 1") })
      )

    assert.throws(() => adapter.query(), /requires an active transaction/)
    await store.runInP2TRSignatureFraudWatchtowerTransaction(() =>
      adapter.query()
    )
    assert.doesNotThrow(() =>
      store.assertP2TRSignatureFraudWatchtowerSharedStore({
        persistence: adapter,
        transactionSource: adapter,
        bridgeLifecycleEventSource: adapter,
      })
    )
  })

  it("checks in the raw transaction/output journal and durable pending backlogs", async () => {
    const migration = await readFile(
      new URL("../migrations/001_p2tr_canonical_index.sql", import.meta.url),
      "utf8"
    )

    assert.match(migration, /CREATE TABLE p2tr_bitcoin_transactions/)
    assert.match(migration, /CREATE TABLE p2tr_bitcoin_outputs/)
    assert.match(migration, /PRIMARY KEY \(block_hash, txid, wtxid\)/)
    assert.match(migration, /CREATE TABLE p2tr_pending_deposit_reveals/)
    assert.match(migration, /CREATE TABLE p2tr_frost_wallet_bindings/)
    assert.match(migration, /CREATE TABLE p2tr_unmatched_proofs/)
    assert.match(migration, /CREATE TABLE p2tr_cross_source_watermark/)
    assert.match(migration, /CREATE TABLE p2tr_evidence_chunks/)
    assert.match(migration, /CREATE TABLE p2tr_evidence_objects/)
    assert.match(migration, /CREATE TABLE p2tr_complete_authorization_domain/)
    assert.match(migration, /CREATE TABLE p2tr_watchtower_source_identity/)
    assert.match(migration, /CREATE TABLE p2tr_canonical_generations/)
    assert.match(migration, /CREATE TABLE p2tr_canonical_memberships/)
    assert.match(migration, /CREATE TABLE p2tr_readiness_exports/)
    assert.match(migration, /CREATE TABLE p2tr_readiness_export_objects/)
    assert.match(
      migration,
      /CREATE TABLE p2tr_readiness_export_acknowledgements/
    )
    assert.match(migration, /p2tr_reject_immutable_update/)
    assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT)\s*;/im)
  })

  it("rejects non-genesis production activation before querying durable state", async () => {
    const pool = new FakePool()
    const store = new PostgresP2TRCanonicalIndexStore(pool, storeOptions())

    await assert.rejects(
      store.assertP2TRSignatureFraudActivationIndexReady({
        height: 1,
        hash: "aa".repeat(32),
      }),
      /checkpoint at genesis height 0/
    )
    assert.deepEqual(pool.client.statements, [])
  })

  it("rolls back before cursor advancement when the pending reveal cap is exceeded", async () => {
    const pool = new FakePool(new PendingCapClient())
    const store = new PostgresP2TRCanonicalIndexStore(pool, {
      ...storeOptions(),
      maxPendingDepositReveals: 1,
    })

    await assert.rejects(
      store.addTaprootDepositBindings([
        {
          txid: "11".repeat(32),
          vout: 0,
          walletID: "22".repeat(32),
          outputKey: "33".repeat(32),
          sourceEventID: "deposit:cap",
          ethereum: { blockNumber: 1, blockHash: "44".repeat(32) },
        },
      ]),
      /1-item capacity/
    )
    assert.equal(pool.client.statements.at(-1), "ROLLBACK")
    assert.equal(
      pool.client.statements.some((statement) =>
        statement.includes("UPDATE p2tr_bitcoin_cursor")
      ),
      false
    )
  })

  it("removes hash-orphaned Ethereum evidence from canonical projection state", async () => {
    const client = new EthereumRollbackClient()
    const pool = new FakePool(client)
    const store = new PostgresP2TRCanonicalIndexStore(pool, storeOptions())

    await store.rollbackEthereumEvidenceTo({
      blockNumber: 17,
      blockHash: "aa".repeat(32),
    })

    for (const mutation of [
      "DELETE FROM p2tr_pending_deposit_reveals",
      "DELETE FROM p2tr_frost_wallet_bindings wallet",
      "DELETE FROM p2tr_unmatched_proofs",
      "DELETE FROM p2tr_cross_source_watermark",
    ]) {
      assert.equal(
        client.statements.some((statement) => statement.includes(mutation)),
        true,
        `missing rollback mutation: ${mutation}`
      )
    }
    assert.equal(
      client.statements.filter((statement) =>
        statement.includes("DELETE FROM p2tr_tracked_outpoints")
      ).length,
      2
    )
    assert.equal(client.statements.at(-1), "COMMIT")
  })
})

class FakePool implements P2TRPostgresPool {
  constructor(readonly client: FakeClient = new FakeClient()) {}

  async connect() {
    return this.client
  }
}

class FakeClient implements P2TRPostgresClient {
  readonly statements: string[] = []
  released = false
  releaseArgument?: Error | boolean

  constructor(
    private readonly failures: Record<string, Error> = {},
    private readonly commandTags: Record<string, string> = {}
  ) {}

  async query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>> {
    this.statements.push(text)
    const failure = this.failures[text]
    if (failure !== undefined) throw failure
    if (text.includes("server_version_num")) {
      return {
        rows: [{ server_version_num: "160000" } as Row],
        rowCount: 1,
      }
    }
    if (text.includes("p2tr_watchtower_schema_version")) {
      return { rows: [{ version: 3 } as Row], rowCount: 1 }
    }
    if (text.includes("p2tr_assert_complete_authorization_domain")) {
      const chainID = BigInt(String(values?.[1]))
      const domainDigest = createHash("sha256")
        .update("tbtc-p2tr-complete-domain-v1", "utf8")
        .update(values?.[0] as Buffer)
        .update(Buffer.from(chainID.toString(16).padStart(64, "0"), "hex"))
        .update(values?.[2] as Buffer)
        .digest("hex")
      return { rows: [{ domain_digest: domainDigest } as Row], rowCount: 1 }
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
        rows: [{ source_identity_digest: sourceIdentityDigest } as Row],
        rowCount: 1,
      }
    }
    const command = this.commandTags[text]
    return {
      rows: [],
      rowCount: 0,
      ...(command === undefined ? {} : { command }),
    }
  }

  release(error?: Error | boolean): void {
    this.released = true
    this.releaseArgument = error
  }
}

class PendingCapClient extends FakeClient {
  async query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>> {
    if (text.includes("INSERT INTO p2tr_pending_deposit_reveals")) {
      this.statements.push(text)
      return { rows: [], rowCount: 1 }
    }
    if (
      text.includes("SELECT count(*) AS count") &&
      text.includes("FROM p2tr_pending_deposit_reveals")
    ) {
      this.statements.push(text)
      return { rows: [{ count: "2" } as Row], rowCount: 1 }
    }
    return super.query<Row>(text, values)
  }
}

class EthereumRollbackClient extends FakeClient {
  async query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>> {
    if (
      text.includes("FROM p2tr_pending_deposit_reveals") &&
      text.includes("FOR UPDATE")
    ) {
      this.statements.push(text)
      return {
        rows: [
          {
            source_event_id: "deposit:orphaned",
            txid: "11".repeat(32),
            vout: 4,
            wallet_id: "22".repeat(32),
            output_key: "33".repeat(32),
          } as Row,
        ],
        rowCount: 1,
      }
    }
    if (
      text.includes("FROM p2tr_frost_wallet_bindings") &&
      text.includes("FOR UPDATE")
    ) {
      this.statements.push(text)
      return {
        rows: [{ wallet_id: "44".repeat(32) } as Row],
        rowCount: 1,
      }
    }
    return super.query<Row>(text, values)
  }
}

const storeOptions = () => ({
  storeID: "same-label",
  maxJournalBlocks: 100,
  maxJournalTransactions: 10_000,
  maxJournalInputs: 100_000,
  maxJournalOutputs: 100_000,
  maxWalletBindings: 10_000,
  maxPendingDepositReveals: 1_000,
  maxUnmatchedProofs: 1_000,
  maxProofMutationBatchSize: 100,
  maxProofPageSize: 100,
  maxProofPayloadBytes: 64_000,
  authorizationDomain: {
    chainID: "31337",
    bridgeAddress: "12".repeat(20),
  },
  sourceIdentity: {
    clusterID: "unit-cluster",
    operatorID: "unit-operator",
    bitcoinIdentityDigest: "21".repeat(32),
    ethereumIdentityDigest: "22".repeat(32),
  },
  readinessExportSigner: {
    keyID: "unit-readiness-signer",
    async signPayloadDigest(): Promise<string> {
      return "ab".repeat(64)
    },
  },
  readinessExportAcknowledgementVerifier: {
    async verify({
      signature,
    }: P2TRReadinessExportAcknowledgementVerification): Promise<boolean> {
      return signature === "ab".repeat(64)
    },
  },
})
