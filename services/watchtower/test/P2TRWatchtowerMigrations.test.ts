import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
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

// This schema is still pre-production. Pin the branch's current migration so
// accidental edits remain visible, while allowing intentional schema resets
// before the first deployment.
const CURRENT_PREPRODUCTION_OUTBOX_MIGRATION_CHECKSUM =
  "1a6144232be452ac9966a865539e5419e4d63c4d6c52d5b093977a25c3ad8010"

describe("P2TR watchtower migration bodies", () => {
  it("pins the current pre-production migration 003 checksum", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/003_p2tr_signature_fraud_challenge_outbox.sql",
        import.meta.url
      )
    )

    assert.equal(
      createHash("sha256").update(migration).digest("hex"),
      CURRENT_PREPRODUCTION_OUTBOX_MIGRATION_CHECKSUM
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

  it("records the superseded challenge-key series repair", async () => {
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

  it("preserves challenge-key series parity and adds exact capacity authority", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/009_p2tr_candidate_enqueue_capacity_authority.sql",
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
      /authz\.expected_outbox_series_id = NEW\.series_id[\s\S]*?authz\.expected_outbox_generation = NEW\.generation[\s\S]*?authz\.expected_outbox_disposition = CASE/
    )
    assert.match(
      migration,
      /authz\.challenge_key = NEW\.observation_id[\s\S]*?authz\.challenge_key = NEW\.bridge_challenge_key/
    )
    assert.doesNotMatch(
      migration,
      /guard_row\.candidate_digest = NEW\.canonical_candidate_digest/
    )
  })

  it("retains transient enqueue exhaustion as a restart-visible alert", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/010_p2tr_candidate_enqueue_transient_retries.sql",
        import.meta.url
      ),
      "utf8"
    )

    assert.doesNotThrow(() => validateP2TRWatchtowerMigrationBody(migration))
    assert.match(
      migration,
      /last_sqlstate IN \('40001', '40P01', '55P03', '57014'\)/
    )
  })

  it("terminalizes stale-manifest guards with append-only rotation evidence", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/011_p2tr_candidate_enqueue_manifest_rotation_disposition.sql",
        import.meta.url
      ),
      "utf8"
    )

    assert.doesNotThrow(() => validateP2TRWatchtowerMigrationBody(migration))
    assert.match(
      migration,
      /CREATE TABLE p2tr_candidate_enqueue_manifest_rotation_disposition/
    )
    assert.match(
      migration,
      /p2tr_candidate_enqueue_manifest_rotation_disposition_immutable_trigger[\s\S]*?BEFORE UPDATE OR DELETE/
    )
    assert.match(
      migration,
      /INSERT INTO p2tr_candidate_enqueue_non_retryable_failure[\s\S]*?p2tr-candidate-enqueue-manifest-rotation-failure-v1/
    )
    assert.match(
      migration,
      /AFTER UPDATE ON p2tr_watchtower_activation_manifest/
    )
  })

  it("keeps manifest-rotation dispositions blocking until operator resolution", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/014_p2tr_candidate_enqueue_rotation_resolution.sql",
        import.meta.url
      ),
      "utf8"
    )

    assert.doesNotThrow(() => validateP2TRWatchtowerMigrationBody(migration))
    assert.match(
      migration,
      /CREATE TABLE p2tr_candidate_enqueue_manifest_rotation_resolution/
    )
    assert.match(
      migration,
      /FOREIGN KEY \([\s\S]*?replacement_activation_sequence[\s\S]*?REFERENCES p2tr_candidate_enqueue_manifest_rotation_disposition/
    )
    assert.match(
      migration,
      /p2tr_candidate_enqueue_rotation_resolution_immutable_trigger[\s\S]*?BEFORE UPDATE OR DELETE/
    )
  })

  it("retires the duplicate provenance alert with its incident journal", async () => {
    const migration = await readFile(
      new URL(
        "../migrations/012_p2tr_provenance_alert_retirement.sql",
        import.meta.url
      ),
      "utf8"
    )

    assert.doesNotThrow(() => validateP2TRWatchtowerMigrationBody(migration))
    assert.match(
      migration,
      /CREATE OR REPLACE FUNCTION p2tr_signature_fraud_outbox_activation_revalidation/
    )
    assert.match(
      migration,
      /a\.code <> 'provenance-reconciliation-incident'[\s\S]*?pi\.record_id = a\.record_id[\s\S]*?p2tr_signature_fraud_challenge_provenance_incident_resolution/
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
        const migrations = await loadP2TRWatchtowerMigrations(
          migrationsDirectory
        )
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

    it("upgrades committed canonical and legacy outbox rows through every rewrite branch", async () => {
      const { Pool } = pg
      const schema = `p2tr_migration_upgrade_${process.pid}_${randomBytes(
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
        const migrations = await loadP2TRWatchtowerMigrations(
          migrationsDirectory
        )
        await runP2TRWatchtowerMigrations(
          database as unknown as P2TRWatchtowerMigrationPool,
          migrations.slice(0, 4)
        )
        const seed = await seedLegacyUpgradeState(database)

        const report = await runP2TRWatchtowerMigrations(
          database as unknown as P2TRWatchtowerMigrationPool,
          migrations
        )

        assert.deepEqual(
          report.applied.map(({ version }) => version),
          migrations.slice(4).map(({ version }) => version)
        )
        const observation = await database.query<{
          binding_tx_hash: Buffer
          disposition_evidence_object_digest: Buffer
        }>(
          `SELECT binding_tx_hash, disposition_evidence_object_digest
             FROM p2tr_bitcoin_candidate_observations
            WHERE occurrence_id = $1`,
          [seed.occurrenceID]
        )
        assert.deepEqual(
          observation.rows[0].binding_tx_hash,
          Buffer.from(seed.fundingTxid).reverse()
        )
        assert.notDeepEqual(
          observation.rows[0].disposition_evidence_object_digest,
          seed.originalDispositionDigest
        )

        const generations = await database.query<{
          generation_count: string
          committed_count: string
          building_generation_id: string | null
        }>(
          `SELECT count(*)::text AS generation_count,
                  count(*) FILTER (WHERE generation.state = 'committed')::text
                    AS committed_count,
                  max(journal.building_generation_id)::text
                    AS building_generation_id
             FROM p2tr_canonical_generations generation
             CROSS JOIN p2tr_canonical_change_journal_state journal`
        )
        assert.deepEqual(generations.rows[0], {
          generation_count: "2",
          committed_count: "2",
          building_generation_id: null,
        })

        const outbox = await database.query<{
          record_id: Buffer
          status: string
          legacy_deposit_binding_byte_order: boolean
        }>(
          `SELECT record_id, status, legacy_deposit_binding_byte_order
             FROM p2tr_signature_fraud_challenge_outbox
            ORDER BY record_id`
        )
        assert.deepEqual(
          outbox.rows.map(({ status }) => status),
          [
            "cancelled-before-broadcast",
            "cancelled-before-broadcast",
            "preparing",
          ]
        )
        assert.equal(
          outbox.rows.every(
            ({ legacy_deposit_binding_byte_order }) =>
              legacy_deposit_binding_byte_order
          ),
          true
        )
        const quarantine = await database.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM p2tr_signature_fraud_legacy_submission_quarantine
            WHERE legacy_status = 'outbox-preparing'`
        )
        assert.equal(quarantine.rows[0].count, "1")
        const capacity = await database.query<{
          active_generation_count: string
        }>(
          `SELECT active_generation_count::text AS active_generation_count
             FROM p2tr_signature_fraud_challenge_outbox_capacity
            WHERE singleton = true`
        )
        assert.equal(capacity.rows[0].active_generation_count, "1")

        const repairedAuthority = await database.query<{
          generation_authority_version: number
          expected_outbox_series_id: Buffer | null
          expected_outbox_generation: number | null
          expected_outbox_disposition: string | null
        }>(
          `SELECT generation_authority_version,
                  expected_outbox_series_id,
                  expected_outbox_generation,
                  expected_outbox_disposition
             FROM p2tr_candidate_enqueue_authorizations
            WHERE token_id = $1`,
          [seed.repairTokenID]
        )
        assert.equal(repairedAuthority.rows[0].generation_authority_version, 1)
        assert.ok(repairedAuthority.rows[0].expected_outbox_series_id)
        assert.equal(repairedAuthority.rows[0].expected_outbox_generation, 0)
        assert.equal(
          repairedAuthority.rows[0].expected_outbox_disposition,
          "initial"
        )

        const rotation = await database.query<{
          failure_count: string
          disposition_count: string
        }>(
          `SELECT
             (SELECT count(*)::text
                FROM p2tr_candidate_enqueue_non_retryable_failure
               WHERE manifest_hash = $1 AND token_id = $2) AS failure_count,
             (SELECT count(*)::text
                FROM p2tr_candidate_enqueue_manifest_rotation_disposition
               WHERE manifest_hash = $1 AND token_id = $2)
                AS disposition_count`,
          [seed.staleManifestHash, seed.staleTokenID]
        )
        assert.deepEqual(rotation.rows[0], {
          failure_count: "1",
          disposition_count: "1",
        })

        const infeasibleLaneError = await database
          .query(
            `INSERT INTO p2tr_signature_fraud_signer_lane_configuration (
                activation_manifest_hash, chain_id, policy_hash,
                signer_lane_id, signer_identity, sender,
                challenge_value_wei, max_gas_limit, max_fee_per_gas,
                max_priority_fee_per_gas, max_total_fee_wei,
                minimum_replacement_fee_bump_bps, signer_code_hash,
                configuration_hash, enabled, configured_at_unix_ms
             ) SELECT $1, 31337, $2, 'infeasible-lane',
                      'infeasible-signer', $3, 0, 1000000, 100, 1,
                      999999, 1000, $4,
                      p2tr_signature_fraud_signer_lane_configuration_hash(
                        $1, 31337, $2, 'infeasible-lane',
                        'infeasible-signer', $3, 0, 1000000, 100, 1,
                        999999, 1000, $4
                      ), true, 1`,
            [seed.currentManifestHash, word(0xd1), address(0xd2), word(0xd3)]
          )
          .then(
            () => undefined,
            (error: unknown) => error
          )
        assert.equal(postgresErrorCode(infeasibleLaneError), "23514")
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

const word = (byte: number): Buffer => Buffer.alloc(32, byte)
const address = (byte: number): Buffer => Buffer.alloc(20, byte)
const protocolID = Buffer.from(
  "12c62b64ecf6d008bcff153495dcdbe7a981f3a9a1b9c0898b86b1e6d0d350ef",
  "hex"
)

type LegacyUpgradeSeed = {
  occurrenceID: Buffer
  fundingTxid: Buffer
  originalDispositionDigest: Buffer
  staleManifestHash: Buffer
  currentManifestHash: Buffer
  staleTokenID: Buffer
  repairTokenID: Buffer
}

async function seedLegacyUpgradeState(
  database: PostgreSQLPool
): Promise<LegacyUpgradeSeed> {
  const staleManifestHash = word(0xa1)
  const currentManifestHash = word(0xa2)
  const manifestPayload = JSON.stringify({
    ethereum: { chainID: 31337 },
    outbox: {
      maxActiveOutboxRecords: 16,
      maxRecoveryBacklog: 16,
      routerAddress: `0x${"44".repeat(20)}`,
    },
  })
  await database.query(
    `INSERT INTO p2tr_watchtower_activation_manifest (
        singleton, activation_sequence, manifest_hash,
        trusted_signer_key_hash, payload, envelope
     ) VALUES (true, 1, $1, $2, $3::jsonb, '{}'::jsonb)`,
    [staleManifestHash, word(0xa3), manifestPayload]
  )

  const domain = await database.query<{ domain_digest: Buffer }>(
    `SELECT p2tr_assert_complete_authorization_domain($1, 31337, $2)
              AS domain_digest`,
    [protocolID, address(0x12)]
  )
  await database.query(
    `SELECT p2tr_assert_watchtower_source_identity(
              'migration-upgrade', 'migration-cluster',
              'migration-operator', $1, $2
            )`,
    [word(0x13), word(0x14)]
  )

  const header = Buffer.alloc(80, 0x20)
  const headerObject = await database.query<{ object_digest: Buffer }>(
    `SELECT p2tr_store_single_chunk_evidence_object(
              'bitcoin_header80', $1
            ) AS object_digest`,
    [header]
  )
  const rawBlockObject = await database.query<{ object_digest: Buffer }>(
    `SELECT p2tr_store_single_chunk_evidence_object(
              'bitcoin_raw_block', $1
            ) AS object_digest`,
    [header]
  )
  const rawTransaction = Buffer.from([0x01])
  const rawTransactionObject = await database.query<{ object_digest: Buffer }>(
    `SELECT p2tr_store_single_chunk_evidence_object(
              'bitcoin_raw_transaction', $1
            ) AS object_digest`,
    [rawTransaction]
  )
  const blockHash = word(0x21)
  const chainCommitment = word(0x22)
  const zero = Buffer.alloc(32)
  await database.query(
    `INSERT INTO p2tr_bitcoin_blocks (
        height, hash, header_bytes, header_object_digest,
        raw_block_object_digest, parent_height, parent_hash,
        parent_chain_commitment, chain_commitment,
        block_content_commitment, parent_evidence_chain_commitment,
        evidence_chain_commitment, transaction_count, input_count,
        output_count, unresolved_input_count, is_checkpoint
     ) VALUES (
        0, $1, $2, $3, $4, NULL, $5, NULL, $6, $5, NULL, $5,
        1, 0, 1, 0, true
     )`,
    [
      blockHash,
      header,
      headerObject.rows[0].object_digest,
      rawBlockObject.rows[0].object_digest,
      zero,
      chainCommitment,
    ]
  )
  await database.query(
    `INSERT INTO p2tr_bitcoin_cursor (
        singleton, store_id, configuration_fingerprint, network,
        trust_domain_id, checkpoint_height, checkpoint_hash,
        current_height, current_hash, current_chain_commitment,
        current_evidence_chain_commitment, journal_block_count,
        journal_transaction_count, journal_input_count,
        journal_output_count, journal_unresolved_input_count
     ) VALUES (
        true, 'migration-upgrade', $1, 'regtest', 'migration-upgrade',
        0, $2, 0, $2, $3, $4, 1, 1, 0, 1, 0
     )`,
    [word(0x23), blockHash, chainCommitment, zero]
  )

  const fundingTxid = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))
  const wtxid = word(0x25)
  await database.query(
    `INSERT INTO p2tr_bitcoin_transactions (
        txid, wtxid, block_height, block_hash, transaction_index,
        raw_transaction, raw_transaction_object_digest
     ) VALUES ($1, $2, 0, $3, 0, $4, $5)`,
    [
      fundingTxid,
      wtxid,
      blockHash,
      rawTransaction,
      rawTransactionObject.rows[0].object_digest,
    ]
  )
  await database.query(
    `INSERT INTO p2tr_bitcoin_outputs (
        txid, wtxid, vout, value_sats, script_pubkey,
        block_height, block_hash
     ) VALUES ($1, $2, 0, 1000, $3, 0, $4)`,
    [fundingTxid, wtxid, Buffer.from([0x51]), blockHash]
  )
  const provenanceFingerprint = word(0x26)
  await database.query(
    `INSERT INTO p2tr_bitcoin_candidates (
        txid, wtxid, block_height, block_hash,
        provenance_generation, provenance_fingerprint
     ) VALUES ($1, $2, 0, $3, 1, $4)`,
    [fundingTxid, wtxid, blockHash, provenanceFingerprint]
  )
  const walletID = word(0x27)
  const outputKey = word(0x28)
  await database.query("BEGIN")
  try {
    await database.query(
      `INSERT INTO p2tr_bitcoin_candidate_ethereum_provenance (
        block_hash, txid, wtxid, input_index, funding_block_hash,
        funding_txid, funding_vout, wallet_id, output_key, binding_kind,
        source_event_id, ethereum_block_number, ethereum_block_hash,
        provenance_generation
     ) VALUES (
        $1, $2, $3, 0, $1, $2, 0, $4, $5, 'deposit',
        'migration-deposit-reveal', 0, $6, 1
     )`,
      [blockHash, fundingTxid, wtxid, walletID, outputKey, zero]
    )
    await database.query(
      `INSERT INTO p2tr_bitcoin_candidate_observations (
        block_hash, txid, wtxid, input_index, provenance_generation,
        provenance_fingerprint, disposition, protocol_id, domain_chain_id,
        bridge_address, domain_digest, challenge_identity, occurrence_id,
        wallet_id, signing_key, output_key, binding_kind,
        local_funding_block_hash, local_funding_txid, local_funding_vout,
        local_funding_header_object_digest, binding_tx_hash,
        binding_output_index, raw_transaction_digest,
        raw_transaction_bytes, witness_digest, raw_transaction_object_digest,
        disposition_evidence_object_digest, blocking_reason,
        blocking_alert_digest
     ) VALUES (
        $1, $2, $3, 0, 1, $4, 'ambiguous_blocking', $5, 31337,
        $6, $7, NULL,
        p2tr_canonical_occurrence_id($7, 1, $1, $2, $3, 0, $4, NULL),
        $8, $9, $9, 'deposit', $1, $2, 0, $10, $2, 0,
        sha256($11), 1, $12, $13, NULL,
        'seeded migration ambiguity', $14
     )`,
      [
        blockHash,
        fundingTxid,
        wtxid,
        provenanceFingerprint,
        protocolID,
        address(0x12),
        domain.rows[0].domain_digest,
        walletID,
        outputKey,
        headerObject.rows[0].object_digest,
        rawTransaction,
        word(0x29),
        rawTransactionObject.rows[0].object_digest,
        word(0x2a),
      ]
    )
    await database.query("COMMIT")
  } catch (error) {
    await database.query("ROLLBACK")
    throw error
  }
  const seededObservation = await database.query<{
    occurrence_id: Buffer
    disposition_evidence_object_digest: Buffer
  }>(
    `SELECT occurrence_id, disposition_evidence_object_digest
       FROM p2tr_bitcoin_candidate_observations`
  )

  const roots = await database.query<{
    projection_root: Buffer
    semantic_root: Buffer
  }>(
    `SELECT p2tr_muhash_finalize(
              projection_numerator, projection_denominator
            ) AS projection_root,
            p2tr_muhash_finalize(
              semantic_numerator, semantic_denominator
            ) AS semantic_root
       FROM p2tr_readiness_projection_state
      WHERE singleton = true`
  )
  const generation = await database.query<{ generation_id: string }>(
    `SELECT p2tr_begin_canonical_generation(
              $1, 0, $2, $3, 0, $4, $5, $6, $7
            )::text AS generation_id`,
    [
      domain.rows[0].domain_digest,
      blockHash,
      headerObject.rows[0].object_digest,
      zero,
      chainCommitment,
      roots.rows[0].projection_root,
      roots.rows[0].semantic_root,
    ]
  )
  await database.query(`SELECT p2tr_seal_canonical_generation($1)`, [
    generation.rows[0].generation_id,
  ])

  const staleTokenID = await insertCandidateGuard(
    database,
    staleManifestHash,
    1,
    0xb1,
    false
  )
  await database.query(
    `UPDATE p2tr_watchtower_activation_manifest
        SET activation_sequence = 2,
            manifest_hash = $1,
            trusted_signer_key_hash = $2,
            payload = $3::jsonb,
            envelope = '{}'::jsonb
      WHERE singleton = true`,
    [currentManifestHash, word(0xa4), manifestPayload]
  )
  for (const [index, status] of [
    "queued",
    "preparing",
    "preparing",
  ].entries()) {
    await insertLegacyOutboxRow(
      database,
      index,
      status,
      currentManifestHash,
      fundingTxid,
      blockHash,
      index === 2
    )
  }
  const repairTokenID = await insertCandidateGuard(
    database,
    currentManifestHash,
    2,
    0xc1,
    true
  )

  return {
    occurrenceID: seededObservation.rows[0].occurrence_id,
    fundingTxid,
    originalDispositionDigest:
      seededObservation.rows[0].disposition_evidence_object_digest,
    staleManifestHash,
    currentManifestHash,
    staleTokenID,
    repairTokenID,
  }
}

async function insertLegacyOutboxRow(
  database: PostgreSQLPool,
  index: number,
  status: string,
  manifestHash: Buffer,
  fundingTxid: Buffer,
  blockHash: Buffer,
  boundaryBearing: boolean
): Promise<void> {
  const seed = 0x60 + index * 8
  const recordID = word(seed)
  const seriesID = word(seed + 1)
  const challengeKey = word(seed + 2)
  const signingKey = word(seed + 3)
  const walletID = word(seed + 4)
  const preparing = status === "preparing"
  const selectedSender = preparing ? address(seed + 5) : null
  const recordState = JSON.stringify({
    seriesID: `0x${seriesID.toString("hex")}`,
    recordID: `0x${recordID.toString("hex")}`,
    generation: 0,
    version: 0,
    status: "queued",
    createdAtUnixMs: 1000,
    canonicalEthereumEligibility: {
      fraudChallengeDepositAmount: "0",
    },
  })
  await database.query(
    `INSERT INTO p2tr_signature_fraud_challenge_outbox (
        record_id, series_id, intent_id, generation, observation_id,
        evidence_protocol_id, intent_input_index, bridge_challenge_key,
        wallet_id, signing_key, binding_tx_hash, binding_output_index,
        bridge_challenge_identity, sighash, signature_nonce_x,
        signature_scalar, domain_chain_id, chain_id, bridge_address,
        router_address, calldata, value_wei, fee_policy_hash,
        bitcoin_tx_hash, bitcoin_wtxid, bitcoin_input_index,
        bitcoin_block_hash, bitcoin_block_height, bitcoin_cursor_block_hash,
        bitcoin_cursor_block_height, ethereum_lifecycle_block_hash,
        ethereum_lifecycle_block_number, activation_manifest_hash,
        router_code_hash, router_protocol_id, router_domain_chain_id,
        complete_authorization_registry_address,
        complete_authorization_registry_code_hash,
        complete_authorization_registry_protocol_id,
        complete_reservation_model, ethereum_eligibility_read_set_hash,
        fraud_challenge_deposit_amount,
        canonical_provenance_journal_store_id,
        canonical_provenance_descriptor_set_hash,
        canonical_provenance_through_block_number,
        canonical_provenance_through_block_hash,
        canonical_provenance_history_root,
        canonical_provenance_event_set_hash,
        canonical_provenance_event_count, canonical_candidate_digest,
        canonical_candidate_provenance_generation,
        canonical_provenance_challenge_key,
        canonical_readiness_certificate_id,
        canonical_readiness_certificate_generation,
        canonical_input_binding_kind,
        canonical_input_binding_source_event_id, canonical_input_index,
        canonical_funding_block_hash, canonical_funding_txid,
        canonical_funding_vout, canonical_input_wallet_id,
        canonical_input_output_key,
        canonical_binding_ethereum_block_number,
        canonical_binding_ethereum_block_hash,
        canonical_provenance_fingerprint,
        canonical_provenance_manifest_hash, router_challenge_absent,
        complete_exact_challenge_authorization_absent,
        complete_exact_transaction_authorization_absent,
        complete_wallet_reservation_active, wallet_challengeable,
        canonical_proof_backlog_complete, submitted_event_scan_from_block,
        confirmed_source_complete, status, version, created_at_unix_ms,
        updated_at_unix_ms, preparation_attempts,
        preparation_lease_owner, preparation_lease_expires_at_unix_ms,
        selected_signer_lane_id, selected_signer_identity, selected_sender,
        nonce_reservation_id, signer_lane_id, signer_identity,
        reserved_sender, reserved_nonce, nonce_reservation_binding,
        nonce_reserved_at_unix_ms,
        active_signer_invocation_started_at_unix_ms,
        broadcast_attempts, reconciliation_attempts, record_state
     ) VALUES (
        $1, $2, $3, 0, $4, $5, 0, $6, $7, $8, $9, 0, $6,
        $10, $11, $12, 31337, 31337, $13, $14, $15, 0, $16,
        $17, $18, 0, $19, 0, $19, 0, $20, 0, $21, $22, $5,
        31337, $23, $24, $25, $26, $27, 0, 'migration-upgrade',
        $28, 0, $20, $29, $30, 1, $31, 1, $6, $32, 1,
        'deposit-binding', $33, 0, $19, $9, 0, $7, $8, 0, $20,
        $34, $21, true, true, true, false, true, true, 0, true,
        $35, 0, 1000, 1000, CASE WHEN $36 THEN 1 ELSE 0 END,
        CASE WHEN $36 THEN $37 ELSE NULL END,
        CASE WHEN $36 THEN 2000 ELSE NULL END,
        CASE WHEN $38 THEN 'migration-lane' ELSE NULL END,
        CASE WHEN $38 THEN 'migration-signer' ELSE NULL END, $39,
        CASE WHEN $38 THEN $40::bytea ELSE NULL END,
        CASE WHEN $38 THEN 'migration-lane' ELSE NULL END,
        CASE WHEN $38 THEN 'migration-signer' ELSE NULL END, $39,
        CASE WHEN $38 THEN 7 ELSE NULL END,
        CASE WHEN $38 THEN decode('01', 'hex') ELSE NULL END,
        CASE WHEN $38 THEN 1001 ELSE NULL END,
        CASE WHEN $38 THEN 1002 ELSE NULL END,
        0, 0, $41::jsonb
     )`,
    [
      recordID,
      seriesID,
      word(seed + 5),
      challengeKey,
      protocolID,
      challengeKey,
      walletID,
      signingKey,
      fundingTxid,
      word(seed + 6),
      word(seed + 7),
      word(seed + 8),
      address(0x12),
      address(0x44),
      Buffer.alloc(388, seed),
      word(seed + 9),
      word(seed + 10),
      word(seed + 11),
      blockHash,
      word(seed + 12),
      manifestHash,
      word(seed + 13),
      address(seed + 14),
      word(seed + 15),
      word(seed + 16),
      word(seed + 17),
      word(seed + 18),
      word(seed + 19),
      word(seed + 20),
      word(seed + 21),
      word(seed + 22),
      word(seed + 23),
      word(seed + 24),
      word(seed + 25),
      "queued",
      false,
      `migration-worker-${index}`,
      false,
      null,
      word(seed + 27),
      recordState,
    ]
  )

  if (!preparing) return
  const laneID = `migration-lane-${index}`
  const signerIdentity = `migration-signer-${index}`
  const preparingRecordState = JSON.stringify({
    ...JSON.parse(recordState),
    version: 1,
    status: "preparing",
    updatedAtUnixMs: 1001,
    preparationLease: {
      owner: `migration-worker-${index}`,
      expiresAtUnixMs: 2000,
    },
    preparationSender: `0x${selectedSender!.toString("hex")}`,
    selectedLaneID: laneID,
    selectedSignerIdentity: signerIdentity,
  })
  await database.query(
    `ALTER TABLE p2tr_signature_fraud_challenge_outbox
       DISABLE TRIGGER p2tr_signature_fraud_protect_outbox_update_trigger`
  )
  try {
    await database.query(
      `UPDATE p2tr_signature_fraud_challenge_outbox
          SET status = 'preparing', version = 1, updated_at_unix_ms = 1001,
              preparation_attempts = 1,
              preparation_lease_owner = $2,
              preparation_lease_expires_at_unix_ms = 2000,
              selected_signer_lane_id = $4,
              selected_signer_identity = $5,
              selected_sender = $3,
              record_state = $6::jsonb
        WHERE record_id = $1`,
      [
        recordID,
        `migration-worker-${index}`,
        selectedSender,
        laneID,
        signerIdentity,
        preparingRecordState,
      ]
    )
  } finally {
    await database.query(
      `ALTER TABLE p2tr_signature_fraud_challenge_outbox
         ENABLE TRIGGER p2tr_signature_fraud_protect_outbox_update_trigger`
    )
  }
  if (!boundaryBearing) return

  const reservationID = word(seed + 27)
  await database.query(
    `INSERT INTO p2tr_signature_fraud_challenge_nonce_guard (
        nonce_guard_id, record_id, guard_kind, chain_id, signer_lane_id,
        signer_identity, sender, transaction_nonce, reservation_epoch,
        reservation_binding, guarded_at_unix_ms
     ) VALUES (
        $1, $2, 'bound-reservation', 31337, $4,
        $5, $3, 7, 1, decode('01', 'hex'), 1001
     )`,
    [reservationID, recordID, selectedSender, laneID, signerIdentity]
  )
  const boundaryRecordState = JSON.stringify({
    ...JSON.parse(preparingRecordState),
    version: 2,
    updatedAtUnixMs: 1002,
  })
  await database.query(
    `ALTER TABLE p2tr_signature_fraud_challenge_outbox
       DISABLE TRIGGER p2tr_signature_fraud_protect_outbox_update_trigger`
  )
  try {
    await database.query(
      `UPDATE p2tr_signature_fraud_challenge_outbox
          SET version = 2, updated_at_unix_ms = 1002,
              nonce_reservation_id = $2,
              signer_lane_id = $5,
              signer_identity = $6, reserved_sender = $3,
              reserved_nonce = 7,
              nonce_reservation_binding = decode('01', 'hex'),
              nonce_reserved_at_unix_ms = 1001,
              active_signer_invocation_started_at_unix_ms = 1002,
              active_signer_invocation_id = $7,
              record_state = $4::jsonb
        WHERE record_id = $1`,
      [
        recordID,
        reservationID,
        selectedSender,
        boundaryRecordState,
        laneID,
        signerIdentity,
        word(seed + 28),
      ]
    )
  } finally {
    await database.query(
      `ALTER TABLE p2tr_signature_fraud_challenge_outbox
         ENABLE TRIGGER p2tr_signature_fraud_protect_outbox_update_trigger`
    )
  }
}

async function insertCandidateGuard(
  database: PostgreSQLPool,
  manifestHash: Buffer,
  certificateGeneration: number,
  seed: number,
  expired: boolean
): Promise<Buffer> {
  const certificateID = word(seed)
  const tokenID = word(seed + 1)
  const candidateDigest = word(seed + 2)
  await database.query(
    `INSERT INTO p2tr_readiness_certificates (
        certificate_id, certificate_generation, manifest_hash,
        manifest_activation_sequence, primary_bitcoin_generation,
        primary_bitcoin_root, primary_bitcoin_semantic_root,
        bitcoin_height, bitcoin_hash, ethereum_journal_generation,
        ethereum_history_root, ethereum_block_number, ethereum_block_hash,
        provider_read_set_hash, payload
     ) VALUES ($1, $2, $3, $2, 1, $4, $5, 0, $6, 1, $7, 0, $8,
               $9, '{}'::jsonb)`,
    [
      certificateID,
      certificateGeneration,
      manifestHash,
      word(seed + 3),
      word(seed + 4),
      word(seed + 5),
      word(seed + 6),
      word(seed + 7),
      word(seed + 8),
    ]
  )
  await database.query(
    `INSERT INTO p2tr_candidate_enqueue_authorizations (
        token_id, manifest_hash, candidate_digest, observation_id,
        challenge_key, txid, wtxid, input_index, bitcoin_block_height,
        bitcoin_block_hash, verified_bitcoin_height, verified_bitcoin_hash,
        verified_ethereum_block, verified_ethereum_hash, funding_block_hash,
        funding_txid, funding_vout, input_wallet_id, input_output_key,
        input_binding_kind, input_binding_source_event_id,
        candidate_provenance_generation, provenance_fingerprint,
        readiness_certificate_id, readiness_certificate_generation,
        issued_at, expires_at
     ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, 0, 0, $8, 0, $9, 0, $10,
        $11, $12, 0, $13, $13, 'registered-wallet-output', $14, 1, $15,
        $16, $17,
        CASE WHEN $18 THEN clock_timestamp() - interval '2 minutes'
             ELSE clock_timestamp() END,
        CASE WHEN $18 THEN clock_timestamp() - interval '1 minute'
             ELSE clock_timestamp() + interval '1 hour' END
     )`,
    [
      tokenID,
      manifestHash,
      candidateDigest,
      word(seed + 9),
      word(seed + 10),
      word(seed + 11),
      word(seed + 12),
      word(seed + 13),
      word(seed + 14),
      word(seed + 15),
      word(seed + 16),
      word(seed + 17),
      word(seed + 18),
      word(seed + 19),
      word(seed + 20),
      certificateID,
      certificateGeneration,
      expired,
    ]
  )
  await database.query(
    `INSERT INTO p2tr_candidate_enqueue_transaction_guard (
        manifest_hash, token_id, candidate_digest, max_attempt_count,
        guard_digest
     ) VALUES ($1, $2, $3, 3, $4)`,
    [manifestHash, tokenID, candidateDigest, word(seed + 21)]
  )
  return tokenID
}

function postgresErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined
  }
  const code = (value as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

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

// Every assertion above reads the migrations as TEXT. That cannot see a
// statement PostgreSQL refuses to parse, and one shipped undetected: migration
// 004 aliased a table `authorization`, a reserved key word, so the whole file
// failed at the first reference to it and the tables, foreign keys and
// append-only triggers it declares existed in no database. The outbox adapter
// suite applies the complete schema but does not directly exercise 004's retry
// journal, so this remains the test that applies every migration in order and
// verifies the ordered upgrade path on a real server.
describe("P2TR watchtower migrations apply to PostgreSQL", () => {
  const postgresURL = process.env.P2TR_WATCHTOWER_TEST_POSTGRES_URL
  const postgresIt = postgresURL === undefined ? it.skip : it

  postgresIt("applies every migration in order to a fresh schema", async () => {
    const migrationsURL = new URL("../migrations/", import.meta.url)
    const ordered = readdirSync(migrationsURL)
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort()
    assert.ok(ordered.length >= 6, "expected the full migration set")

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

  postgresIt(
    "upgrades a checksum-tracked migration 003 database through migration 017",
    async () => {
      const migrationsURL = new URL("../migrations/", import.meta.url)
      const migrations = await loadP2TRWatchtowerMigrations(
        fileURLToPath(migrationsURL)
      )
      assert.equal(
        migrations[2].checksum,
        CURRENT_PREPRODUCTION_OUTBOX_MIGRATION_CHECKSUM
      )

      const client = new pg.Client({ connectionString: postgresURL })
      await client.connect()
      const schema = `p2tr_migration_upgrade_${process.pid}_${Date.now()}`
      try {
        await client.query(`CREATE SCHEMA ${schema}`)
        await client.query(`SET search_path TO ${schema}`)
        const pool = {
          connect: async () => postgresMigrationClient(client),
        }

        const installed = await runP2TRWatchtowerMigrations(
          pool,
          migrations.slice(0, 4)
        )
        assert.deepEqual(
          installed.applied.map(({ version }) => version),
          [1, 2, 3, 4]
        )

        const upgraded = await runP2TRWatchtowerMigrations(pool, migrations)
        assert.deepEqual(
          upgraded.applied.map(({ version }) => version),
          [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
        )
        assert.equal(upgraded.current.length, 17)

        const columns = await client.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema = $1
              AND table_name =
                  'p2tr_signature_fraud_challenge_signer_boundary_resolution'
              AND column_name IN (
                  'nonce_consumption_observed_head_block_number',
                  'nonce_consumption_observed_head_block_hash',
                  'resolution_evidence_version'
              )
            ORDER BY column_name`,
          [schema]
        )
        assert.deepEqual(
          columns.rows.map(({ column_name }) => column_name),
          [
            "nonce_consumption_observed_head_block_hash",
            "nonce_consumption_observed_head_block_number",
            "resolution_evidence_version",
          ]
        )

        const evidenceVersionDefault = await client.query<{
          column_default: string
        }>(
          `SELECT column_default
             FROM information_schema.columns
            WHERE table_schema = $1
              AND table_name =
                  'p2tr_signature_fraud_challenge_signer_boundary_resolution'
              AND column_name = 'resolution_evidence_version'`,
          [schema]
        )
        assert.match(evidenceVersionDefault.rows[0].column_default, /5/)

        const constraints = await client.query<{
          conname: string
          convalidated: boolean
        }>(
          `SELECT conname, convalidated
             FROM pg_constraint
            WHERE conname IN (
                      'p2tr_signer_boundary_evidence_version_v5',
                      'p2tr_signer_boundary_nonce_finality_v5'
                  )
              AND connamespace = $1::regnamespace
            ORDER BY conname`,
          [schema]
        )
        assert.deepEqual(constraints.rows, [
          {
            conname: "p2tr_signer_boundary_evidence_version_v5",
            convalidated: false,
          },
          {
            conname: "p2tr_signer_boundary_nonce_finality_v5",
            convalidated: false,
          },
        ])

        const guard = await client.query<{ definition: string }>(
          `SELECT pg_get_functiondef(
                    'p2tr_signature_fraud_guard_signer_boundary_resolution()'
                    ::regprocedure
                  ) AS definition`
        )
        assert.match(
          guard.rows[0].definition,
          /tbtc-p2tr-signer-boundary-independent-resolution-v5/
        )
        assert.match(
          guard.rows[0].definition,
          /nonce_consumption_observed_head_block_number/
        )

        // 007 replaces the variant trigger in place, so the live function in a
        // database upgraded from 003 must carry the strict gas comparison.
        const variantAppend = await client.query<{ definition: string }>(
          `SELECT pg_get_functiondef(
                    'p2tr_signature_fraud_validate_variant_append()'
                    ::regprocedure
                  ) AS definition`
        )
        assert.match(
          variantAppend.rows[0].definition,
          /NEW\.gas_limit <> fee_policy\.max_gas_limit/
        )
        assert.doesNotMatch(
          variantAppend.rows[0].definition,
          /NEW\.gas_limit > fee_policy\.max_gas_limit/
        )
      } finally {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
        await client.end()
      }
    }
  )
})

function postgresMigrationClient(
  client: pg.Client
): P2TRWatchtowerMigrationClient {
  return {
    async query(text, values) {
      const result = await client.query(
        text,
        values === undefined ? undefined : [...values]
      )
      return { rows: result.rows, rowCount: result.rowCount }
    },
    release() {},
  }
}
