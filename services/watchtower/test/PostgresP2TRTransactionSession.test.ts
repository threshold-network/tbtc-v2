import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  PostgresP2TRCanonicalIndexStore,
  type P2TRPostgresClient,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import { PostgresP2TRProductionActivationStore } from "../src/PostgresP2TRProductionActivationStore.js"

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
    assert.deepEqual(client.queries.slice(0, 4), [
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT current_setting('server_version_num') AS server_version_num",
      `SELECT version
         FROM p2tr_watchtower_schema_version
        WHERE component = 'canonical-evidence-index'`,
    ])
    assert.ok(client.queries.includes("SELECT 1"))
    assert.equal(client.releasedWith, undefined)
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
      maxPendingDepositReveals: 10,
      maxUnmatchedProofs: 10,
      maxProofMutationBatchSize: 10,
      maxProofPageSize: 10,
      maxProofPayloadBytes: 1024,
    }
  )
}

class TransactionClient implements P2TRPostgresClient {
  readonly queries: string[] = []
  releasedWith: Error | undefined

  constructor(private readonly failure?: "COMMIT" | "ROLLBACK") {}

  async query<Row>(text: string): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push(text)
    if (text === this.failure) throw new Error(`${text} failed`)
    if (text.includes("server_version_num")) {
      return {
        rows: [{ server_version_num: "160000" }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("p2tr_watchtower_schema_version")) {
      return {
        rows: [{ version: 1 }] as Row[],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  }

  release(error?: Error): void {
    this.releasedWith = error
  }
}
