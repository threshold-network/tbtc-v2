import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import pg from "pg"
import {
  runP2TRWatchtowerMigrations,
  validateP2TRWatchtowerMigrationBody,
  type P2TRWatchtowerMigration,
  type P2TRWatchtowerMigrationClient,
} from "../src/P2TRWatchtowerMigrations.js"

describe("P2TR watchtower migration bodies", () => {
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
    assert.match(migration, /candidate enqueue retry journal is append-only/)
    assert.match(
      migration,
      /candidate enqueue resolution lacks exact consumed authority/
    )
    assert.match(migration, /generation-cap resolution lacks its durable alert/)
  })
})

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

// Every assertion above reads the migrations as TEXT. That cannot see a
// statement PostgreSQL refuses to parse, and one shipped undetected: migration
// 004 aliased a table `authorization`, a reserved key word, so the whole file
// failed at the first reference to it and the tables, foreign keys and
// append-only triggers it declares existed in no database. Nothing else applies
// 004 -- the adapter suites stop at 003 -- so this is the only test that would
// have caught it. It applies every migration, in order, to a real server.
describe("P2TR watchtower migrations apply to PostgreSQL", () => {
  const postgresURL = process.env.P2TR_WATCHTOWER_TEST_POSTGRES_URL
  const postgresIt = postgresURL === undefined ? it.skip : it

  postgresIt("applies every migration in order to a fresh schema", async () => {
    const migrationsURL = new URL("../migrations/", import.meta.url)
    const ordered = readdirSync(migrationsURL)
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort()
    assert.ok(ordered.length >= 4, "expected the full migration set")

    const client = new pg.Client({ connectionString: postgresURL })
    await client.connect()
    const schema = `p2tr_migrations_${process.pid}_${Date.now()}`
    try {
      await client.query(`CREATE SCHEMA ${schema}`)
      await client.query(`SET search_path TO ${schema}`)
      for (const name of ordered) {
        const body = await readFile(new URL(name, migrationsURL), "utf8")
        // The runner validates each body before it reaches the server; hold
        // this test to the same contract so the two cannot drift.
        assert.doesNotThrow(
          () => validateP2TRWatchtowerMigrationBody(body),
          `${name} is not a valid migration body`
        )
        try {
          await client.query(body)
        } catch (error) {
          assert.fail(`${name} failed to apply: ${(error as Error).message}`)
        }
      }
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await client.end()
    }
  })
})
