import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const activationStore = readFileSync(
  new URL("../src/PostgresP2TRProductionActivationStore.ts", import.meta.url),
  "utf8"
)
const activationGate = readFileSync(
  new URL("../src/P2TRProductionActivation.ts", import.meta.url),
  "utf8"
)
const canonicalEthereumMigration = readFileSync(
  new URL("../migrations/002_p2tr_canonical_ethereum.sql", import.meta.url),
  "utf8"
)

describe("production activation PostgreSQL schema contract", () => {
  it("reads pending and blocking dispositions from candidate observations", () => {
    assert.doesNotMatch(
      activationStore,
      /FROM p2tr_bitcoin_candidates\s+WHERE delivered/
    )
    assert.match(
      activationStore,
      /FROM p2tr_bitcoin_candidate_observations[\s\S]*?'keypath_pending'[\s\S]*?'malformed_blocking'[\s\S]*?'ambiguous_blocking'/
    )
  })

  it("populates every required candidate-authorization column", () => {
    const table = requiredTableColumns(
      canonicalEthereumMigration,
      "p2tr_candidate_enqueue_authorizations"
    )
    const inserted = insertedColumns(
      activationStore,
      "p2tr_candidate_enqueue_authorizations"
    )
    assert.deepEqual(
      table.filter((column) => !inserted.includes(column)),
      [],
      "candidate authorization INSERT omits required schema columns"
    )
    assert.match(
      activationStore,
      /JOIN p2tr_bitcoin_candidate_observations observation/
    )
    assert.match(
      activationStore,
      /JOIN p2tr_bitcoin_candidate_ethereum_provenance provenance/
    )
    assert.match(
      activationStore,
      /JOIN p2tr_readiness_certificates certificate/
    )
    assert.match(
      activationStore,
      /certificate\.certificate_id = \$17[\s\S]*?certificate\.certificate_generation = \$18/
    )
    assert.match(
      activationStore,
      /certified_generation\.generation_id = \([\s\S]*?SELECT max\(generation_id\)/
    )
    assert.match(
      activationStore,
      /observation\.input_index = \$14[\s\S]*?observation\.occurrence_id = \$15[\s\S]*?observation\.challenge_identity = \$16/
    )
    assert.match(
      activationStore,
      /provenance\.source_event_id ~\*[\s\S]*?'\^\(0x\)\?\[0-9a-f\]\{64\}\$'/
    )
  })

  it("mints a schema-complete readiness certificate under the snapshot lock", () => {
    const table = requiredTableColumns(
      canonicalEthereumMigration,
      "p2tr_readiness_certificates"
    )
    const inserted = insertedColumns(
      activationStore,
      "p2tr_readiness_certificates"
    )
    assert.deepEqual(
      table.filter((column) => !inserted.includes(column)),
      [],
      "readiness certificate INSERT omits required schema columns"
    )
    assert.match(
      activationStore,
      /pg_advisory_xact_lock\(hashtextextended\('p2tr-readiness-snapshot'/
    )
    assert.match(
      activationStore,
      /UPDATE p2tr_readiness_certificate_generation[\s\S]*?RETURNING next_generation - 1/
    )
    const lock = activationGate.indexOf("lockReadinessSnapshot()")
    const health = activationGate.indexOf("readBitcoinIndexHealth()", lock)
    const mint = activationGate.indexOf("mintReadinessCertificate({", health)
    assert.ok(lock >= 0 && health > lock && mint > health)
  })
})

function requiredTableColumns(source: string, table: string): string[] {
  const match = source.match(
    new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`)
  )
  assert.ok(match, `${table} schema is absent`)
  return match[1].split("\n").flatMap((line) => {
    const column = line.match(/^\s+([a-z_]+)\s+.*\bNOT NULL\b/)
    return column !== null && !/\bDEFAULT\b/.test(line) ? [column[1]] : []
  })
}

function insertedColumns(source: string, table: string): string[] {
  const match = source.match(
    new RegExp(`INSERT INTO ${table}\\s*\\(([\\s\\S]*?)\\)\\s*SELECT`)
  )
  assert.ok(match, `${table} INSERT is absent`)
  return match[1]
    .split(",")
    .map((column) => column.trim())
    .filter((column) => /^[a-z_]+$/.test(column))
}
