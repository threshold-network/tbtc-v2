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
              },
            }),
          ]
        )

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
              const query = transactionSession.query.bind(transactionSession)
              transactionSession.query = (text, values) => {
                if (text.includes("SELECT manifest.activation_sequence")) {
                  return Promise.resolve({
                    rows: [
                      {
                        activation_sequence: 1,
                        outbox_max_recovery_backlog: 16,
                        primary_bitcoin_generation: 1,
                        primary_bitcoin_root: WORD("31").slice(2),
                        primary_bitcoin_semantic_root: WORD("32").slice(2),
                        local_bitcoin_height: 0,
                        local_bitcoin_hash: WORD("33").slice(2),
                        ethereum_journal_generation: 1,
                        ethereum_history_root: WORD("34").slice(2),
                        local_ethereum_block: 500,
                        local_ethereum_hash: WORD("35").slice(2),
                      },
                    ],
                    rowCount: 1,
                  }) as ReturnType<typeof transactionSession.query>
                }
                return query(text, values)
              }
              return new PostgresP2TRProductionActivationStore(
                transactionSession,
                {
                  storeID: "activation.integration",
                  maxEventHistoryRecords: 100,
                }
              )
            }
          )

        await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(
          async () => {
            assert.deepEqual(await stateStore.readRuntimeAlertHealth(), {
              manifestHash,
              unresolvedCandidateEnqueueTransactionGuardCount: 0,
              candidateEnqueueRetryExhaustionCount: 0,
            })
            assert.equal(
              (
                await stateStore.readOutboxRevalidation(
                  manifestHash,
                  Date.now()
                )
              ).activeGenerationCount,
              0
            )

            const bitcoinHash = WORD("33")
            const ethereumHash = WORD("35")
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
              },
            })

            const tokenID = WORD("51")
            const candidateDigest = WORD("52")
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
                bytes(WORD("53")),
                bytes(WORD("54")),
                bytes(WORD("55")),
                bytes(WORD("56")),
                bytes(WORD("57")),
                bytes(bitcoinHash),
                bytes(ethereumHash),
                bytes(WORD("58")),
                bytes(WORD("59")),
                bytes(WORD("5a")),
                bytes(WORD("5b")),
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
            await assert.rejects(
              stateStore.resolveCandidateEnqueueTransactionGuard({
                tokenID,
                manifestHash,
                candidateDigest,
                outboxIntentID: WORD("61"),
                outcomeKind: "enqueued",
              }),
              /lacks exact consumed authorization state/
            )
          }
        )
      } finally {
        await database?.end()
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await admin.end()
      }
    })
  }
)
