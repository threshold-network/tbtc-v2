import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import pg, { type Pool as PostgreSQLPool } from "pg"
import {
  loadP2TRWatchtowerMigrations,
  runP2TRWatchtowerMigrations,
  validateP2TRWatchtowerMigrationBody,
  type P2TRWatchtowerMigration,
  type P2TRWatchtowerMigrationClient,
  type P2TRWatchtowerMigrationPool,
} from "../src/P2TRWatchtowerMigrations.js"

const migrationsDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url)
)
const postgresURL = process.env.P2TR_WATCHTOWER_TEST_POSTGRES_URL

describe("P2TR watchtower migration bodies", () => {
  it("loads and validates the complete production migration directory", async () => {
    const migrations = await loadP2TRWatchtowerMigrations(migrationsDirectory)

    assert.deepEqual(
      migrations.map(({ version, filename }) => ({ version, filename })),
      [
        {
          version: 1,
          filename: "001_p2tr_canonical_index.sql",
        },
        {
          version: 2,
          filename: "002_p2tr_canonical_ethereum.sql",
        },
        {
          version: 3,
          filename: "003_p2tr_signature_fraud_challenge_outbox.sql",
        },
        {
          version: 4,
          filename: "004_p2tr_candidate_enqueue_retry_alerts.sql",
        },
        {
          version: 5,
          filename: "005_p2tr_deposit_binding_byte_order.sql",
        },
        {
          version: 6,
          filename: "006_p2tr_candidate_enqueue_generation_authority.sql",
        },
        {
          version: 7,
          filename: "007_p2tr_candidate_enqueue_recovery_hardening.sql",
        },
        {
          version: 8,
          filename: "008_p2tr_candidate_enqueue_challenge_series.sql",
        },
      ]
    )
  })

  it("rejects every top-level transaction-control token", () => {
    for (const control of [
      "BEGIN",
      "COMMIT",
      "ROLLBACK",
      "ABORT",
      "END",
      "START TRANSACTION",
      "SAVEPOINT x",
      "RELEASE SAVEPOINT x",
      "PREPARE TRANSACTION 'x'",
    ]) {
      assert.throws(
        () => validateP2TRWatchtowerMigrationBody(`SELECT 1; ${control};`),
        /contains transaction control/
      )
    }
  })

  it("ignores controls in comments, quoted values, identifiers, and dollar bodies", () => {
    const body = `
      -- COMMIT;
      /* outer ROLLBACK; /* nested BEGIN; */ */
      SELECT 'BEGIN; COMMIT;', "ROLLBACK";
      CREATE FUNCTION safe_body() RETURNS void LANGUAGE plpgsql AS $function$
      BEGIN
        RAISE NOTICE 'COMMIT';
      END;
      $function$;
    `
    assert.equal(validateP2TRWatchtowerMigrationBody(body), body.trim())
  })

  it("rejects malformed quoted input before database access", () => {
    assert.throws(
      () => validateP2TRWatchtowerMigrationBody("SELECT $tag$unfinished"),
      /unterminated dollar quote/
    )
    assert.throws(
      () => validateP2TRWatchtowerMigrationBody("SELECT 'unfinished"),
      /unterminated quote/
    )
  })

  it("defines an immutable pre-armed candidate enqueue retry journal", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/004_p2tr_candidate_enqueue_retry_alerts.sql",
        import.meta.url
      ),
      "utf8"
    )

    assert.doesNotThrow(() => validateP2TRWatchtowerMigrationBody(migration))
    assert.match(
      migration,
      /CREATE TABLE p2tr_candidate_enqueue_transaction_guard/
    )
    assert.match(
      migration,
      /CREATE TABLE p2tr_candidate_enqueue_transaction_resolution/
    )
    assert.match(
      migration,
      /CREATE TABLE p2tr_candidate_enqueue_retry_exhaustion_alert/
    )
    assert.match(
      migration,
      /FOREIGN KEY \(manifest_hash, token_id, candidate_digest\)/
    )
    assert.match(
      migration,
      /p2tr_candidate_enqueue_authorizations_outbox_intent_fk[\s\S]*?FOREIGN KEY \(outbox_intent_id\)[\s\S]*?ON DELETE RESTRICT\s+NOT VALID/
    )
    assert.match(migration, /candidate enqueue retry journal is append-only/)
    assert.match(
      migration,
      /candidate enqueue resolution lacks exact consumed authority/
    )
    assert.match(
      migration,
      /p2tr_candidate_enqueue_authorizations candidate_authorization/
    )
    assert.doesNotMatch(
      migration,
      /p2tr_candidate_enqueue_authorizations authorization/
    )
    assert.match(migration, /generation-cap resolution lacks its durable alert/)
    assert.match(
      migration,
      /CREATE OR REPLACE FUNCTION p2tr_signature_fraud_consume_generation_capacity/
    )
    assert.match(migration, /unresolved_capacity_reservation_count/)
    assert.match(migration, /has_exact_capacity_reservation/)
    assert.match(
      migration,
      /JOIN p2tr_watchtower_activation_manifest current_manifest[\s\S]*?current_manifest\.manifest_hash = guard_row\.manifest_hash/
    )
    assert.doesNotMatch(
      migration,
      /candidate_authorization\.consumed_at IS NULL[\s\S]*?candidate_authorization\.invalidated_at IS NULL[\s\S]*?candidate_authorization\.expires_at > clock_timestamp\(\)/
    )
    assert.match(migration, /active outbox capacity is exhausted or reserved/)
  })

  it("repairs expired armed authority and adds append-only alert resolution", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/007_p2tr_candidate_enqueue_recovery_hardening.sql",
        import.meta.url
      ),
      "utf8"
    )

    assert.doesNotThrow(() => validateP2TRWatchtowerMigrationBody(migration))
    assert.match(
      migration,
      /JOIN p2tr_candidate_enqueue_transaction_guard guard_row/
    )
    assert.match(migration, /authz\.generation_authority_version = 0/)
    assert.doesNotMatch(migration, /authz\.expires_at > clock_timestamp\(\)/)
    assert.match(
      migration,
      /CREATE TABLE p2tr_candidate_enqueue_retry_exhaustion_resolution/
    )
    assert.match(
      migration,
      /FOREIGN KEY \([\s\S]*?alert_detail_digest[\s\S]*?REFERENCES p2tr_candidate_enqueue_retry_exhaustion_alert/
    )
    assert.match(
      migration,
      /p2tr_candidate_enqueue_retry_resolution_immutable_trigger[\s\S]*?BEFORE UPDATE OR DELETE/
    )
  })

  it("repairs candidate authority to use the SDK challenge-series identity", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/008_p2tr_candidate_enqueue_challenge_series.sql",
        import.meta.url
      ),
      "utf8"
    )

    assert.doesNotThrow(() => validateP2TRWatchtowerMigrationBody(migration))
    assert.match(
      migration,
      /'\,"observationID\":' \|\|[\s\S]*?encode\(challenge_key_value, 'hex'\)/
    )
    assert.match(
      migration,
      /outbox\.observation_id = challenge_key_value[\s\S]*?outbox\.bridge_challenge_key = challenge_key_value/
    )
    assert.match(
      migration,
      /WHERE authz\.consumed_at IS NULL[\s\S]*?authz\.invalidated_at IS NULL[\s\S]*?UPDATE p2tr_candidate_enqueue_authorizations authz/
    )
  })
})

describe(
  "P2TR watchtower production migration path",
  { skip: postgresURL === undefined },
  () => {
    it("applies the complete loaded directory through the production runner", async () => {
      const { Pool } = pg
      const schema = `p2tr_migration_runner_${process.pid}_${randomBytes(
        6
      ).toString("hex")}`
      const admin = new Pool({ connectionString: postgresURL })
      let database: PostgreSQLPool | undefined

      try {
        await admin.query(`CREATE SCHEMA "${schema}"`)
        database = new Pool({
          connectionString: postgresURL,
          options: `-c search_path=${schema}`,
        })
        const migrations =
          await loadP2TRWatchtowerMigrations(migrationsDirectory)
        const report = await runP2TRWatchtowerMigrations(
          database as unknown as P2TRWatchtowerMigrationPool,
          migrations
        )

        assert.equal(report.applied.length, migrations.length)
        assert.deepEqual(report.current, report.applied)
        const ledger = await database.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM p2tr_watchtower_migrations"
        )
        assert.equal(ledger.rows[0].count, String(migrations.length))
      } finally {
        await database?.end()
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await admin.end()
      }
    })
  }
)

describe("P2TR watchtower migration transaction ownership", () => {
  it("runs exact wrapperless bytes inside its own SERIALIZABLE transaction", async () => {
    const migration = migrationFor("CREATE TABLE example(id integer);")
    const client = new MigrationClient(migration)
    await runP2TRWatchtowerMigrations(poolFor(client), [migration])
    assert.ok(client.queries.includes("BEGIN ISOLATION LEVEL SERIALIZABLE"))
    assert.ok(client.queries.includes(migration.sql))
    assert.ok(client.queries.includes("COMMIT"))
    assert.equal(client.releasedWith, undefined)
  })

  it("fences canonical writers before opening the migration snapshot", async () => {
    const migration = migrationFor("SELECT 1;")
    const client = new MigrationClient(migration)
    await runP2TRWatchtowerMigrations(poolFor(client), [migration])

    const begin = client.queries.indexOf("BEGIN ISOLATION LEVEL SERIALIZABLE")
    const preSnapshotFence = client.queries.indexOf(
      "SELECT pg_advisory_lock(hashtextextended('p2tr-readiness-pre-snapshot-fence', 0))"
    )
    const legacyWriterFence = client.queries.indexOf(
      "SELECT pg_advisory_lock(hashtextextended('p2tr-readiness-snapshot', 0))"
    )
    assert.ok(preSnapshotFence >= 0)
    assert.ok(legacyWriterFence > preSnapshotFence)
    assert.ok(begin > legacyWriterFence)
  })

  it("destroys the session when BEGIN outcome is unknown", async () => {
    const migration = migrationFor("SELECT 1;")
    const client = new MigrationClient(migration, { fail: "BEGIN" })
    await assert.rejects(
      runP2TRWatchtowerMigrations(poolFor(client), [migration]),
      /BEGIN failed/
    )
    assert.ok(client.releasedWith instanceof Error)
  })

  it("destroys the session when COMMIT outcome is unknown", async () => {
    const migration = migrationFor("SELECT 1;")
    const client = new MigrationClient(migration, { fail: "COMMIT" })
    await assert.rejects(
      runP2TRWatchtowerMigrations(poolFor(client), [migration]),
      /COMMIT failed/
    )
    assert.ok(client.queries.includes("ROLLBACK"))
    assert.ok(client.releasedWith instanceof Error)
  })

  it("destroys the session when rollback fails", async () => {
    const migration = migrationFor("SELECT broken;")
    const client = new MigrationClient(migration, {
      fail: "BODY",
      failRollback: true,
    })
    await assert.rejects(
      runP2TRWatchtowerMigrations(poolFor(client), [migration]),
      /body failed/
    )
    assert.equal(client.releasedWith?.message, "ROLLBACK failed")
  })

  it("destroys the session when advisory unlock is not confirmed", async () => {
    const migration = migrationFor("SELECT 1;")
    const client = new MigrationClient(migration, { unlock: false })
    await runP2TRWatchtowerMigrations(poolFor(client), [migration])
    assert.match(client.releasedWith?.message ?? "", /not confirmed/)
  })

  it("recomputes the exact SQL checksum before execution", async () => {
    const migration = migrationFor("SELECT 1;")
    migration.sql = "SELECT 2;"
    const client = new MigrationClient(migration)
    await assert.rejects(
      runP2TRWatchtowerMigrations(poolFor(client), [migration]),
      /does not match its checksum/
    )
    assert.equal(client.queries.length, 0)
  })
})

function migrationFor(sql: string): P2TRWatchtowerMigration {
  return {
    version: 1,
    name: "example",
    filename: "001_example.sql",
    checksum: createHash("sha256")
      .update(Buffer.from(sql, "utf8"))
      .digest("hex"),
    sql,
  }
}

function poolFor(client: P2TRWatchtowerMigrationClient) {
  return { connect: async () => client }
}

class MigrationClient implements P2TRWatchtowerMigrationClient {
  readonly queries: string[] = []
  releasedWith: Error | undefined
  private committed = false
  private readonly migration: P2TRWatchtowerMigration
  private readonly behavior: {
    fail?: "BEGIN" | "BODY" | "COMMIT"
    failRollback?: boolean
    unlock?: boolean
  }

  constructor(
    migration: P2TRWatchtowerMigration,
    behavior: {
      fail?: "BEGIN" | "BODY" | "COMMIT"
      failRollback?: boolean
      unlock?: boolean
    } = {}
  ) {
    this.migration = migration
    this.behavior = behavior
  }

  async query<Row>(text: string): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push(text)
    if (
      text === "BEGIN ISOLATION LEVEL SERIALIZABLE" &&
      this.behavior.fail === "BEGIN"
    ) {
      throw new Error("BEGIN failed")
    }
    if (text === this.migration.sql && this.behavior.fail === "BODY") {
      throw new Error("body failed")
    }
    if (text === "COMMIT" && this.behavior.fail === "COMMIT") {
      throw new Error("COMMIT failed")
    }
    if (text === "ROLLBACK" && this.behavior.failRollback) {
      throw new Error("ROLLBACK failed")
    }
    if (text === "COMMIT") this.committed = true
    if (text.includes("pg_try_advisory_lock")) {
      return { rows: [{ locked: true }] as Row[], rowCount: 1 }
    }
    if (text.includes("current_setting('lock_timeout')")) {
      return { rows: [{ lock_timeout: "0" }] as Row[], rowCount: 1 }
    }
    if (text.includes("pg_advisory_unlock")) {
      return {
        rows: [{ unlocked: this.behavior.unlock ?? true }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("FROM p2tr_watchtower_migrations")) {
      return {
        rows: (this.committed
          ? [
              {
                version: this.migration.version,
                name: this.migration.name,
                checksum: this.migration.checksum,
              },
            ]
          : []) as Row[],
        rowCount: this.committed ? 1 : 0,
      }
    }
    return { rows: [], rowCount: 0 }
  }

  release(error?: Error): void {
    this.releasedWith = error
  }
}
