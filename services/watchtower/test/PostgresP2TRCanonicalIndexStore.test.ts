import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import { PostgresP2TRCanonicalIndexStore } from "../src/PostgresP2TRCanonicalIndexStore.js"
import type {
  P2TRPostgresClient,
  P2TRPostgresPool,
  P2TRPostgresQueryResult,
} from "../src/PostgresP2TRCanonicalIndexStore.js"

describe("PostgresP2TRCanonicalIndexStore", () => {
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

  it("destroys a client and reports an unknown outcome after COMMIT fails", async () => {
    const commitError = new Error("commit response lost")
    const client = new FakeClient({ COMMIT: commitError })
    const store = new PostgresP2TRCanonicalIndexStore(
      new FakePool(client),
      storeOptions()
    )

    await assert.rejects(
      store.runInP2TRSignatureFraudWatchtowerTransaction(async () => "result"),
      /COMMIT failed; transaction outcome is unknown/
    )

    assert.equal(client.statements.at(-1), "COMMIT")
    assert.equal(client.statements.includes("ROLLBACK"), false)
    assert.equal(client.releaseArgument, commitError)
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

  it("removes hash-orphaned Ethereum evidence from the canonical candidate view", async () => {
    const client = new EthereumRollbackClient()
    const pool = new FakePool(client)
    const store = new PostgresP2TRCanonicalIndexStore(pool, storeOptions())

    await store.rollbackEthereumEvidenceTo({
      blockNumber: 17,
      blockHash: "aa".repeat(32),
    })

    assert.deepEqual(JSON.parse(client.candidateBinding as string), {
      txid: "11".repeat(32),
      vout: 4,
      walletID: "22".repeat(32),
      outputKey: "33".repeat(32),
    })
    for (const mutation of [
      "UPDATE p2tr_bitcoin_candidates",
      "DELETE FROM p2tr_pending_deposit_reveals",
      "DELETE FROM p2tr_frost_wallet_bindings",
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

  constructor(private readonly failures: Record<string, Error> = {}) {}

  async query<Row = Record<string, unknown>>(
    text: string,
    _values?: readonly unknown[]
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
      return { rows: [{ version: 1 } as Row], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
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
  candidateBinding?: unknown

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
    if (text.includes("UPDATE p2tr_bitcoin_candidates")) {
      this.candidateBinding = values?.[0]
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
  maxPendingDepositReveals: 1_000,
  maxUnmatchedProofs: 1_000,
  maxProofMutationBatchSize: 100,
  maxProofPageSize: 100,
  maxProofPayloadBytes: 64_000,
})
