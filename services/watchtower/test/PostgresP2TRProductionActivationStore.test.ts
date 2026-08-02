import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { describe, it } from "node:test"

import {
  PostgresP2TRCanonicalIndexStore,
  type P2TRPostgresPool,
  type P2TRPostgresQueryResult,
  type P2TRPostgresTransactionSession,
  type P2TRReadinessExportAcknowledgementVerification,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import { PostgresP2TRProductionActivationStore } from "../src/PostgresP2TRProductionActivationStore.js"

const postgresURL = process.env.P2TR_WATCHTOWER_TEST_POSTGRES_URL
const WORD = (byte: string): string => `0x${byte.repeat(32)}`
const bytes = (value: string): Buffer =>
  Buffer.from(value.replace(/^0x/, ""), "hex")

type IntegrationPool = P2TRPostgresPool & {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>>
  end(): Promise<void>
}

describe(
  "PostgresP2TRProductionActivationStore integration",
  { skip: postgresURL === undefined },
  () => {
    it("executes readiness, alert, and enqueue-guard SQL against PostgreSQL", async () => {
      const require = createRequire(import.meta.url)
      const { Pool } = require("pg") as {
        Pool: new (options: Record<string, unknown>) => IntegrationPool
      }
      const schema = `p2tr_activation_${process.pid}_${randomBytes(6).toString(
        "hex"
      )}`
      const admin = new Pool({ connectionString: postgresURL })
      let database: IntegrationPool | undefined
      try {
        await admin.query(`CREATE SCHEMA "${schema}"`)
        database = new Pool({
          connectionString: postgresURL,
          options: `-c search_path=${schema}`,
        })
        for (const filename of [
          "001_p2tr_canonical_index.sql",
          "002_p2tr_canonical_ethereum.sql",
          "003_p2tr_signature_fraud_challenge_outbox.sql",
          "004_p2tr_candidate_enqueue_retry_alerts.sql",
          "005_p2tr_deposit_binding_byte_order.sql",
        ]) {
          const migration = await readFile(
            new URL(`../migrations/${filename}`, import.meta.url),
            "utf8"
          )
          await database.query(`BEGIN;\n${migration}\nCOMMIT;`)
        }

        const manifestHash = WORD("11")
        await database.query(
          `INSERT INTO p2tr_watchtower_activation_manifest
             (singleton, activation_sequence, manifest_hash,
              trusted_signer_key_hash, payload, envelope)
           VALUES (true, 1, $1, $2, $3::jsonb, '{}'::jsonb)`,
          [
            bytes(manifestHash),
            bytes(WORD("12")),
            JSON.stringify({
              outbox: {
                maxActiveOutboxRecords: 16,
                maxRecoveryBacklog: 16,
                routerAddress: "0x1234567890abcdef1234567890abcdef12345678",
              },
              ethereum: { chainID: 31337 },
            }),
          ]
        )
        await seedCanonicalReadinessPoint(database)

        const coordinator = new PostgresP2TRCanonicalIndexStore(database, {
          storeID: "activation.integration",
          maxJournalBlocks: 10,
          maxJournalTransactions: 10,
          maxJournalInputs: 10,
          maxJournalOutputs: 10,
          maxWalletBindings: 10,
          maxPendingDepositReveals: 10,
          maxUnmatchedProofs: 10,
          maxProofMutationBatchSize: 10,
          maxProofPageSize: 10,
          maxProofPayloadBytes: 4096,
          authorizationDomain: {
            chainID: "31337",
            bridgeAddress: "12".repeat(20),
          },
          sourceIdentity: {
            clusterID: "activation-cluster",
            operatorID: "activation-operator",
            bitcoinIdentityDigest: "21".repeat(32),
            ethereumIdentityDigest: "22".repeat(32),
          },
          readinessExportSigner: {
            keyID: "activation-readiness-signer",
            async signPayloadDigest(payloadDigest: string) {
              return createHash("sha256")
                .update(payloadDigest, "hex")
                .digest("hex")
            },
          },
          readinessExportAcknowledgementVerifier: {
            async verify(
              _value: P2TRReadinessExportAcknowledgementVerification
            ) {
              return true
            },
          },
        })

        let session!: P2TRPostgresTransactionSession
        const stateStore =
          coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
            (transactionSession) => {
              session = transactionSession
              return new PostgresP2TRProductionActivationStore(
                transactionSession,
                {
                  storeID: "activation.integration",
                  maxEventHistoryRecords: 100,
                }
              )
            }
          )

        const tokenID = WORD("51")
        const candidateDigest = WORD("52")
        const observationID = WORD("53")
        const challengeKey = WORD("54")
        const txid = WORD("55")
        const wtxid = WORD("56")
        const fundingTxid = WORD("59")
        const inputOutputKey = WORD("5b")
        const bitcoinHash = WORD("33")
        const ethereumHash = WORD("35")

        await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(
          async () => {
            const outboxRevalidation = await stateStore.readOutboxRevalidation(
              manifestHash,
              Date.now()
            )
            assert.equal(outboxRevalidation.activeGenerationCount, 0)
            const certificate = await stateStore.mintReadinessCertificate({
              manifestHash,
              verifiedBitcoin: { height: 0, hash: bitcoinHash },
              verifiedEthereum: {
                blockNumber: 500,
                blockHash: ethereumHash,
              },
              bitcoinIndex: {
                storeID: "bitcoin.integration",
                configurationFingerprint: WORD("41"),
                network: "regtest",
                checkpoint: { height: 0, hash: bitcoinHash },
                current: { height: 0, hash: bitcoinHash },
                canonicalBlockCount: 1,
                pendingCandidates: 0,
                pendingDepositReveals: 0,
                unmatchedProofs: 0,
                liveCandidateAuthorizations: 0,
                unbackfilledFrostWalletBindings: 0,
                failureGeneration: 0,
                clearedFailureGeneration: 0,
              },
              ethereumJournal: {
                storeID: "ethereum.integration",
                chainID: 31337,
                configurationFingerprint: WORD("42"),
                descriptorSetHash: WORD("43"),
                checkpoint: { blockNumber: 499, blockHash: WORD("44") },
                scanStartBlock: 500,
                current: { blockNumber: 500, blockHash: ethereumHash },
                requiredEventHistoryDigest: WORD("45"),
                requiredEventCount: 0,
                requiredEventCoverage: {
                  blockCount: 1,
                  transactionCount: 0,
                  receiptCount: 0,
                  logCount: 0,
                },
                failureGeneration: 0,
                clearedFailureGeneration: 0,
              },
              payload: {
                schema: "tbtc-p2tr-production-readiness-certificate/v1",
                manifestHash,
                outboxHandshake: {
                  state: {
                    configuredSignerLaneCount:
                      outboxRevalidation.configuredSignerLaneCount,
                    configuredSignerLaneSetHash:
                      outboxRevalidation.configuredSignerLaneSetHash,
                  },
                },
              },
            })
            await session.query(
              `INSERT INTO p2tr_candidate_enqueue_authorizations (
                   token_id, manifest_hash, candidate_digest, observation_id,
                   challenge_key, txid, wtxid, input_index,
                   bitcoin_block_height, bitcoin_block_hash,
                   verified_bitcoin_height, verified_bitcoin_hash,
                   verified_ethereum_block, verified_ethereum_hash,
                   funding_block_hash, funding_txid, funding_vout,
                   input_wallet_id, input_output_key, input_binding_kind,
                   input_binding_source_event_id,
                   candidate_provenance_generation, provenance_fingerprint,
                   readiness_certificate_id,
                   readiness_certificate_generation, expires_at
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, 0, 0, $8, 0, $9,
                   500, $10, $11, $12, 0, $13, $14,
                   'registered-wallet-output', $15, 1, $16, $17, $18,
                   clock_timestamp() + interval '1 minute'
                 )`,
              [
                bytes(tokenID),
                bytes(manifestHash),
                bytes(candidateDigest),
                bytes(observationID),
                bytes(challengeKey),
                bytes(txid),
                bytes(wtxid),
                bytes(WORD("57")),
                bytes(bitcoinHash),
                bytes(ethereumHash),
                bytes(WORD("58")),
                bytes(fundingTxid),
                bytes(WORD("5a")),
                bytes(inputOutputKey),
                bytes(WORD("5c")),
                bytes(WORD("5d")),
                bytes(certificate.certificateID),
                certificate.generation,
              ]
            )
            await stateStore.armCandidateEnqueueTransactionGuard({
              tokenID,
              manifestHash,
              candidateDigest,
              maxAttemptCount: 3,
            })
            await session.query(
              `UPDATE p2tr_candidate_enqueue_authorizations
                  SET issued_at = clock_timestamp() - interval '2 minutes',
                      expires_at = clock_timestamp() - interval '1 minute'
                WHERE token_id = $1`,
              [bytes(tokenID)]
            )
          }
        )

        const generationAuthorityMigration = await readFile(
          new URL(
            "../migrations/006_p2tr_candidate_enqueue_generation_authority.sql",
            import.meta.url
          ),
          "utf8"
        )
        await database.query(`BEGIN;\n${generationAuthorityMigration}\nCOMMIT;`)
        const missedExpiredGuard = await database.query<{
          generation_authority_version: number
        }>(
          `SELECT generation_authority_version
             FROM p2tr_candidate_enqueue_authorizations
            WHERE token_id = $1`,
          [bytes(tokenID)]
        )
        assert.equal(missedExpiredGuard.rows[0].generation_authority_version, 0)

        const recoveryHardeningMigration = await readFile(
          new URL(
            "../migrations/007_p2tr_candidate_enqueue_recovery_hardening.sql",
            import.meta.url
          ),
          "utf8"
        )
        await database.query(`BEGIN;\n${recoveryHardeningMigration}\nCOMMIT;`)

        await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(
          async () => {
            assert.deepEqual(await stateStore.readRuntimeAlertHealth(), {
              manifestHash,
              unresolvedCandidateEnqueueTransactionGuardCount: 1,
              candidateEnqueueRetryExhaustionCount: 0,
            })
            await stateStore.lockCandidateAuthorization(
              tokenID,
              candidateDigest,
              manifestHash
            )
            await stateStore.saveCandidateEnqueueRetryExhaustionAlert({
              tokenID,
              manifestHash,
              candidateDigest,
              attemptCount: 3,
              lastSQLState: "40001",
            })
            assert.deepEqual(await stateStore.readRuntimeAlertHealth(), {
              manifestHash,
              unresolvedCandidateEnqueueTransactionGuardCount: 0,
              candidateEnqueueRetryExhaustionCount: 1,
            })
            await stateStore.resolveCandidateEnqueueRetryExhaustionAlert({
              tokenID,
              manifestHash,
              candidateDigest,
              resolutionDigest: WORD("62"),
              reason: "operator verified the bounded retry incident",
              resolvedAtUnixMs: 10_000,
            })
            assert.deepEqual(await stateStore.readRuntimeAlertHealth(), {
              manifestHash,
              unresolvedCandidateEnqueueTransactionGuardCount: 0,
              candidateEnqueueRetryExhaustionCount: 0,
            })
          }
        )
        await assert.rejects(
          database.query(
            `UPDATE p2tr_candidate_enqueue_retry_exhaustion_resolution
                SET reason = 'rewritten operator evidence'`
          ),
          /append-only/
        )
        await assert.rejects(
          database.query(
            `DELETE FROM p2tr_candidate_enqueue_retry_exhaustion_resolution`
          ),
          /append-only/
        )
      } finally {
        await database?.end()
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await admin.end()
      }
    })
  }
)

async function seedCanonicalReadinessPoint(
  database: IntegrationPool
): Promise<void> {
  const zero = Buffer.alloc(32)
  const header = Buffer.alloc(80)
  const domain = await database.query<{ domain_digest: Buffer }>(
    `SELECT p2tr_assert_complete_authorization_domain($1, 31337, $2)
              AS domain_digest`,
    [
      bytes(
        "0x12c62b64ecf6d008bcff153495dcdbe7a981f3a9a1b9c0898b86b1e6d0d350ef"
      ),
      Buffer.from("12".repeat(20), "hex"),
    ]
  )
  await database.query(
    `SELECT p2tr_assert_watchtower_source_identity(
              'activation.integration', 'activation-cluster',
              'activation-operator', $1, $2
            )`,
    [bytes(WORD("21")), bytes(WORD("22"))]
  )
  const headerEvidence = await database.query<{ object_digest: Buffer }>(
    `SELECT p2tr_store_single_chunk_evidence_object(
              'bitcoin_header80', $1
            ) AS object_digest`,
    [header]
  )
  const rawBlockEvidence = await database.query<{ object_digest: Buffer }>(
    `SELECT p2tr_store_single_chunk_evidence_object(
              'bitcoin_raw_block', $1
            ) AS object_digest`,
    [header]
  )
  const bitcoinHash = bytes(WORD("33"))
  const ethereumHash = bytes(WORD("35"))
  const bitcoinChainRoot = bytes(WORD("31"))
  const historyRoot = bytes(WORD("34"))

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
        0, 0, 0, 0, true
     )`,
    [
      bitcoinHash,
      header,
      headerEvidence.rows[0].object_digest,
      rawBlockEvidence.rows[0].object_digest,
      zero,
      bitcoinChainRoot,
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
        true, 'bitcoin.integration', $1, 'regtest', 'activation.integration',
        0, $2, 0, $2, $3, $4, 1, 0, 0, 0, 0
     )`,
    [bytes(WORD("41")), bitcoinHash, bitcoinChainRoot, zero]
  )
  await database.query(
    `INSERT INTO p2tr_ethereum_blocks (
        block_number, block_hash, parent_hash, block_timestamp,
        transactions_root, receipts_root, transaction_hashes,
        transaction_digest, transaction_count, receipt_digest,
        receipt_count, log_digest, log_count, required_event_digest,
        block_required_event_count, history_root, required_event_count,
        cumulative_block_count, cumulative_transaction_count,
        cumulative_receipt_count, cumulative_log_count
     ) VALUES (
        500, $1, $2, 1, $2, $2, '[]'::jsonb, $2, 0, $2, 0, $2, 0,
        $2, 0, $3, 0, 1, 0, 0, 0
     )`,
    [ethereumHash, zero, historyRoot]
  )
  await database.query(
    `INSERT INTO p2tr_ethereum_cursor (
        singleton, store_id, chain_id, configuration_fingerprint,
        descriptor_set_hash, scan_start_block, checkpoint_block_number,
        checkpoint_block_hash, current_block_number, current_block_hash,
        generation, journal_block_count, journal_event_count,
        coverage_block_count, coverage_transaction_count,
        coverage_receipt_count, coverage_log_count
     ) VALUES (
        true, 'ethereum.integration', 31337, $1, $2, 500, 499, $3,
        500, $4, 1, 1, 0, 1, 0, 0, 0
     )`,
    [bytes(WORD("42")), bytes(WORD("43")), bytes(WORD("44")), ethereumHash]
  )
  const readinessRoots = await database.query<{
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
              $1, 0, $2, $3, 500, $4, $5, $6, $7
            )::text AS generation_id`,
    [
      domain.rows[0].domain_digest,
      bitcoinHash,
      headerEvidence.rows[0].object_digest,
      ethereumHash,
      bitcoinChainRoot,
      readinessRoots.rows[0].projection_root,
      readinessRoots.rows[0].semantic_root,
    ]
  )
  await database.query(`SELECT p2tr_seal_canonical_generation($1)`, [
    generation.rows[0].generation_id,
  ])
}
