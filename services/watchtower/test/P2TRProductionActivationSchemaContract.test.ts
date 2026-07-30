import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const activationStore = readFileSync(
  new URL("../src/PostgresP2TRProductionActivationStore.ts", import.meta.url),
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
      /observation\.input_index = \$14[\s\S]*?observation\.occurrence_id = \$15[\s\S]*?observation\.challenge_identity = \$16/
    )
    assert.match(
      activationStore,
      /provenance\.source_event_id ~\*[\s\S]*?'\^\(0x\)\?\[0-9a-f\]\{64\}\$'/
    )
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
