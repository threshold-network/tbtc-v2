import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"

export type P2TRWatchtowerMigration = {
  version: number
  name: string
  filename: string
  checksum: string
  sql: string
}

export type P2TRWatchtowerMigrationQueryResult<Row> = {
  rows: Row[]
  rowCount: number | null
}

export interface P2TRWatchtowerMigrationClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRWatchtowerMigrationQueryResult<Row>>
  /** Passing an error forces `pg` to destroy, rather than pool, the session. */
  release(error?: Error): void
}

export interface P2TRWatchtowerMigrationPool {
  connect(): Promise<P2TRWatchtowerMigrationClient>
}

export type P2TRWatchtowerMigrationRunnerOptions = {
  advisoryLockKey?: readonly [number, number]
  statementTimeoutMs?: number
  lockTimeoutMs?: number
}

export type P2TRWatchtowerMigrationReport = {
  applied: ReadonlyArray<
    Pick<P2TRWatchtowerMigration, "version" | "name" | "checksum">
  >
  current: ReadonlyArray<
    Pick<P2TRWatchtowerMigration, "version" | "name" | "checksum">
  >
}

type AppliedMigrationRow = {
  version: number | string
  name: string
  checksum: string
}

const DEFAULT_ADVISORY_LOCK_KEY = [0x50325452, 0x57415443] as const
const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000
const DEFAULT_LOCK_TIMEOUT_MS = 30_000
const MIGRATION_FILENAME = /^(\d{3})_([a-z0-9][a-z0-9_]*)\.sql$/

/**
 * Loads a complete, consecutive migration set and hashes the exact bytes on
 * disk. The SQL files retain their human-friendly BEGIN/COMMIT wrapper; the
 * runner removes that single outer wrapper and executes the body atomically
 * with its checksum-ledger insert.
 */
export async function loadP2TRWatchtowerMigrations(
  directory: string
): Promise<P2TRWatchtowerMigration[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const migrations: P2TRWatchtowerMigration[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue
    const match = MIGRATION_FILENAME.exec(entry.name)
    if (match === null) {
      throw new Error(
        `Watchtower migration filename ${entry.name} must match NNN_name.sql`
      )
    }

    const raw = await readFile(join(directory, entry.name))
    const sql = raw.toString("utf8")
    // Parse now so transaction controls fail before any database lock or
    // mutation is attempted. Migration files are bodies; the runner owns the
    // only transaction boundary.
    validateP2TRWatchtowerMigrationBody(sql, entry.name)
    migrations.push({
      version: Number(match[1]),
      name: match[2],
      filename: entry.name,
      checksum: createHash("sha256").update(raw).digest("hex"),
      sql,
    })
  }

  migrations.sort((left, right) => left.version - right.version)
  migrations.forEach((migration, index) => {
    const expected = index + 1
    if (migration.version !== expected) {
      throw new Error(
        `Watchtower migrations must be consecutive from 001; expected ${expected
          .toString()
          .padStart(3, "0")}, found ${migration.filename}`
      )
    }
  })

  if (migrations.length === 0) {
    throw new Error(`No watchtower migrations found in ${basename(directory)}`)
  }
  return migrations
}

export function validateP2TRWatchtowerMigrationBody(
  sql: string,
  filename = "migration.sql"
): string {
  if (sql.includes("\u0000")) {
    throw new Error(`Watchtower migration ${filename} contains a NUL byte`)
  }

  const body = sql.trim()
  if (body.length === 0) {
    throw new Error(`Watchtower migration ${filename} has an empty body`)
  }
  if (scanTopLevelSQLControls(sql, filename).length !== 0) {
    throw new Error(
      `Watchtower migration ${filename} contains transaction control`
    )
  }
  return body
}

/** @deprecated Migration files are wrapperless bodies; use the validator. */
export const unwrapP2TRWatchtowerMigrationTransaction =
  validateP2TRWatchtowerMigrationBody

/**
 * Applies migrations while holding a session advisory lock. Existing rows
 * must be an exact prefix of the supplied files and their SHA-256 checksums
 * must match; edits, gaps, unknown future rows, and divergent names all halt
 * startup before application code can run.
 */
export async function runP2TRWatchtowerMigrations(
  pool: P2TRWatchtowerMigrationPool,
  migrations: readonly P2TRWatchtowerMigration[],
  options: P2TRWatchtowerMigrationRunnerOptions = {}
): Promise<P2TRWatchtowerMigrationReport> {
  const immutableMigrations = migrations.map((migration) =>
    Object.freeze({ ...migration })
  )
  validateLoadedMigrations(immutableMigrations)
  const advisoryLockKey = options.advisoryLockKey ?? DEFAULT_ADVISORY_LOCK_KEY
  const statementTimeoutMs = positiveInteger(
    options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    "Watchtower migration statement timeout"
  )
  const lockTimeoutMs = positiveInteger(
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    "Watchtower migration lock timeout"
  )
  const client = await pool.connect()
  let locked = false
  let lockAcquisitionResolved = false
  let primaryError: Error | undefined
  let releaseError: Error | undefined
  const applied: P2TRWatchtowerMigration[] = []

  try {
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      advisoryLockKey
    )
    lockAcquisitionResolved = true
    if (lock.rows.length !== 1 || lock.rows[0].locked !== true) {
      throw new Error(
        "Another watchtower migration runner holds the advisory lock"
      )
    }
    locked = true
    await client.query(
      `CREATE TABLE IF NOT EXISTS p2tr_watchtower_migrations (
         version integer PRIMARY KEY CHECK (version > 0),
         name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 128),
         checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`
    )
    const existing = await client.query<AppliedMigrationRow>(
      `SELECT version, name, encode(checksum, 'hex') AS checksum
         FROM p2tr_watchtower_migrations
        ORDER BY version`
    )
    assertAppliedMigrationPrefix(existing.rows, immutableMigrations)

    for (
      let index = existing.rows.length;
      index < immutableMigrations.length;
      index++
    ) {
      const migration = immutableMigrations[index]
      assertMigrationChecksum(migration)
      let transactionStarted = false
      let transactionResolved = false
      try {
        try {
          await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
          transactionStarted = true
        } catch (error) {
          releaseError = asError(
            error,
            "Watchtower migration BEGIN outcome is unknown"
          )
          throw error
        }
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          `${statementTimeoutMs}ms`,
        ])
        await client.query("SELECT set_config('lock_timeout', $1, true)", [
          `${lockTimeoutMs}ms`,
        ])
        // Reparse and rehash immediately before sending exact reviewed bytes.
        assertMigrationChecksum(migration)
        await client.query(
          validateP2TRWatchtowerMigrationBody(migration.sql, migration.filename)
        )
        await client.query(
          `INSERT INTO p2tr_watchtower_migrations (version, name, checksum)
           VALUES ($1, $2, decode($3, 'hex'))`,
          [migration.version, migration.name, migration.checksum]
        )
        try {
          await client.query("COMMIT")
          transactionResolved = true
        } catch (error) {
          releaseError = asError(
            error,
            "Watchtower migration COMMIT outcome is unknown"
          )
          throw error
        }
        applied.push(migration)
      } catch (error) {
        if (transactionStarted && !transactionResolved) {
          try {
            await client.query("ROLLBACK")
            transactionResolved = true
          } catch (rollbackError) {
            releaseError = asError(
              rollbackError,
              "Watchtower migration ROLLBACK outcome is unknown"
            )
          }
        }
        throw error
      }
    }

    const current = await client.query<AppliedMigrationRow>(
      `SELECT version, name, encode(checksum, 'hex') AS checksum
         FROM p2tr_watchtower_migrations
        ORDER BY version`
    )
    assertAppliedMigrationPrefix(current.rows, immutableMigrations, true)
    return {
      applied: applied.map(migrationIdentity),
      current: immutableMigrations.map(migrationIdentity),
    }
  } catch (error) {
    primaryError = asError(error, "Watchtower migration failed")
    throw error
  } finally {
    if (locked) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock($1, $2) AS unlocked",
          advisoryLockKey
        )
        if (unlocked.rows.length !== 1 || unlocked.rows[0].unlocked !== true) {
          releaseError ??= new Error(
            "Watchtower migration advisory lock release was not confirmed"
          )
        }
      } catch (error) {
        releaseError ??= asError(
          error,
          "Watchtower migration advisory lock release failed"
        )
      }
    }
    if (!lockAcquisitionResolved) {
      releaseError =
        primaryError ?? new Error("Advisory lock outcome is unknown")
    }
    client.release(releaseError)
  }
}

function assertAppliedMigrationPrefix(
  rows: readonly AppliedMigrationRow[],
  migrations: readonly P2TRWatchtowerMigration[],
  requireComplete = false
): void {
  if (rows.length > migrations.length) {
    throw new Error(
      "Database contains watchtower migrations unknown to this binary"
    )
  }
  rows.forEach((row, index) => {
    const version = Number(row.version)
    const expected = migrations[index]
    if (!Number.isSafeInteger(version) || version !== index + 1) {
      throw new Error(
        "Database watchtower migration history is not consecutive"
      )
    }
    if (
      expected.version !== version ||
      expected.name !== row.name ||
      expected.checksum !== normalizeChecksum(row.checksum)
    ) {
      throw new Error(
        `Database watchtower migration ${version} does not match ${expected.filename}`
      )
    }
  })
  if (requireComplete && rows.length !== migrations.length) {
    throw new Error("Database watchtower migration application is incomplete")
  }
}

function validateLoadedMigrations(
  migrations: readonly P2TRWatchtowerMigration[]
): void {
  if (migrations.length === 0) {
    throw new Error("At least one watchtower migration is required")
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        "Watchtower migrations must be consecutive from version 1"
      )
    }
    if (!/^[a-z0-9][a-z0-9_]{0,127}$/.test(migration.name)) {
      throw new Error(`Invalid watchtower migration name ${migration.name}`)
    }
    if (!/^[0-9a-f]{64}$/.test(migration.checksum)) {
      throw new Error(
        `Invalid checksum for watchtower migration ${migration.name}`
      )
    }
    assertMigrationChecksum(migration)
    validateP2TRWatchtowerMigrationBody(migration.sql, migration.filename)
  })
}

function assertMigrationChecksum(migration: P2TRWatchtowerMigration): void {
  const actual = createHash("sha256")
    .update(Buffer.from(migration.sql, "utf8"))
    .digest("hex")
  if (actual !== migration.checksum) {
    throw new Error(
      `Watchtower migration ${migration.filename} SQL does not match its checksum`
    )
  }
}

function migrationIdentity(migration: P2TRWatchtowerMigration) {
  return {
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum,
  }
}

function onlyWhitespaceAndComments(value: string): boolean {
  return stripSQLComments(value).trim().length === 0
}

type SQLControl = {
  word: string
  wordStart: number
  wordEnd: number
  statementStart: number
  statementEnd: number
}

function scanTopLevelSQLControls(sql: string, filename: string): SQLControl[] {
  const statements = splitTopLevelSQLStatements(sql, filename)
  const controls: SQLControl[] = []
  for (const statement of statements) {
    const words = topLevelSQLWords(
      sql.slice(statement.start, statement.end),
      filename,
      statement.start
    )
    for (const word of words) {
      if (
        [
          "BEGIN",
          "COMMIT",
          "ROLLBACK",
          "ABORT",
          "END",
          "START",
          "SAVEPOINT",
          "RELEASE",
          "PREPARE",
        ].includes(word.value)
      ) {
        controls.push({
          word: word.value,
          wordStart: word.start,
          wordEnd: word.end,
          statementStart: words[0]?.start ?? statement.start,
          statementEnd: statement.end,
        })
      }
    }
  }
  return controls
}

function findStatementSemicolon(
  sql: string,
  after: number,
  filename: string
): number {
  const statement = splitTopLevelSQLStatements(sql, filename).find(
    (candidate) => candidate.start <= after && candidate.end >= after
  )
  if (statement === undefined || sql[statement.end - 1] !== ";") {
    throw new Error(
      `Watchtower migration ${filename} transaction wrapper is malformed`
    )
  }
  return statement.end - 1
}

function splitTopLevelSQLStatements(
  sql: string,
  filename: string
): Array<{ start: number; end: number }> {
  const statements: Array<{ start: number; end: number }> = []
  let start = 0
  walkTopLevelSQL(sql, filename, (index, character) => {
    if (character === ";") {
      statements.push({ start, end: index + 1 })
      start = index + 1
    }
  })
  if (!onlyWhitespaceAndComments(sql.slice(start))) {
    statements.push({ start, end: sql.length })
  }
  return statements
}

function topLevelSQLWords(
  sql: string,
  filename: string,
  offset = 0
): Array<{ value: string; start: number; end: number }> {
  const words: Array<{ value: string; start: number; end: number }> = []
  let currentStart = -1
  let current = ""
  const flush = (index: number) => {
    if (currentStart >= 0) {
      words.push({
        value: current.toUpperCase(),
        start: offset + currentStart,
        end: offset + index,
      })
      currentStart = -1
      current = ""
    }
  }
  walkTopLevelSQL(sql, filename, (index, character) => {
    if (
      /[A-Za-z_]/.test(character) ||
      (currentStart >= 0 && /[0-9$]/.test(character))
    ) {
      if (currentStart < 0) currentStart = index
      current += character
    } else {
      flush(index)
    }
  })
  flush(sql.length)
  return words
}

function walkTopLevelSQL(
  sql: string,
  filename: string,
  visit: (index: number, character: string) => void
): void {
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]
    const next = sql[index + 1]
    if (character === "-" && next === "-") {
      index += 2
      while (index < sql.length && sql[index] !== "\n") index++
      continue
    }
    if (character === "/" && next === "*") {
      let depth = 1
      index += 2
      for (; index < sql.length && depth > 0; index++) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth++
          index++
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth--
          index++
        }
      }
      if (depth !== 0) {
        throw new Error(
          `Watchtower migration ${filename} has an unterminated comment`
        )
      }
      index--
      continue
    }
    if (character === "'" || character === '"') {
      visit(index, character)
      const quote = character
      for (index++; index < sql.length; index++) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index++
            continue
          }
          break
        }
      }
      if (index >= sql.length) {
        throw new Error(
          `Watchtower migration ${filename} has an unterminated quote`
        )
      }
      continue
    }
    if (character === "$") {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(
        sql.slice(index)
      )?.[0]
      if (tag !== undefined) {
        visit(index, character)
        const end = sql.indexOf(tag, index + tag.length)
        if (end < 0) {
          throw new Error(
            `Watchtower migration ${filename} has an unterminated dollar quote`
          )
        }
        index = end + tag.length - 1
        continue
      }
    }
    visit(index, character)
  }
}

function stripSQLComments(value: string): string {
  let output = ""
  walkTopLevelSQL(value, "migration.sql", (_index, character) => {
    output += character
  })
  return output
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback)
}

function normalizeChecksum(value: string): string {
  const checksum = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    throw new Error("Database watchtower migration checksum is malformed")
  }
  return checksum
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}
