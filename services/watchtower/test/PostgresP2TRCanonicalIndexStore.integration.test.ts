import { randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import { PostgresP2TRCanonicalIndexStore } from "../src/PostgresP2TRCanonicalIndexStore.js"
import type {
  P2TRPostgresPool,
  P2TRPostgresQueryResult,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import type { P2TRCanonicalBitcoinScan } from "../src/P2TRCanonicalBitcoinIndex.js"

const postgresURL = process.env.P2TR_WATCHTOWER_TEST_POSTGRES_URL

describe(
  "PostgresP2TRCanonicalIndexStore integration",
  { skip: postgresURL === undefined },
  () => {
    it("atomically replaces a reorged chain and removes orphaned Ethereum evidence", async () => {
      const require = createRequire(import.meta.url)
      const { Pool } = require("pg") as {
        Pool: new (options: Record<string, unknown>) => IntegrationPool
      }
      const schema = `p2tr_watchtower_${process.pid}_${randomBytes(6).toString(
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
        const migration = await readFile(
          new URL(
            "../migrations/001_p2tr_canonical_index.sql",
            import.meta.url
          ),
          "utf8"
        )
        await database.query(migration)

        const store = new PostgresP2TRCanonicalIndexStore(database, {
          storeID: "integration-store",
          maxJournalBlocks: 10,
          maxJournalTransactions: 100,
          maxJournalInputs: 1_000,
          maxJournalOutputs: 1_000,
          maxPendingDepositReveals: 100,
          maxUnmatchedProofs: 100,
          maxProofMutationBatchSize: 20,
          maxProofPageSize: 20,
          maxProofPayloadBytes: 4_096,
        })
        const checkpoint = { height: 0, hash: "aa".repeat(32) }
        const original = { height: 1, hash: "bb".repeat(32) }
        const replacement = { height: 1, hash: "cc".repeat(32) }

        await store.applyBitcoinScan(
          scan({ checkpoint, next: original, blockHash: original.hash })
        )
        await store.applyBitcoinScan(
          scan({
            checkpoint,
            expected: original,
            next: replacement,
            blockHash: replacement.hash,
          })
        )

        assert.deepEqual(
          (await store.loadBitcoinCursor())?.current,
          replacement
        )
        const blocks = await database.query<{ height: string; hash: string }>(
          `SELECT height, encode(hash, 'hex') AS hash
             FROM p2tr_bitcoin_blocks
            ORDER BY height`
        )
        assert.deepEqual(blocks.rows, [
          { height: "0", hash: checkpoint.hash },
          { height: "1", hash: replacement.hash },
        ])

        await store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
          await store.addFrostWalletBindings([
            {
              walletID: "11".repeat(32),
              sourceEventID: "wallet:orphaned",
              ethereum: { blockNumber: 12, blockHash: "dd".repeat(32) },
            },
          ])
          await store.addTaprootDepositBindings([
            {
              txid: "22".repeat(32),
              vout: 3,
              walletID: "11".repeat(32),
              outputKey: "33".repeat(32),
              sourceEventID: "deposit:orphaned",
              ethereum: { blockNumber: 12, blockHash: "dd".repeat(32) },
            },
          ])
          await store.enqueueUnmatchedProofs([
            {
              eventID: "proof:orphaned",
              ethereum: {
                blockNumber: 12,
                blockHash: "dd".repeat(32),
                transactionHash: "44".repeat(32),
                logIndex: 2,
              },
              bitcoinTxid: "55".repeat(32),
              walletID: "11".repeat(32),
              spendType: "moving-funds",
              payload: { canonical: true },
            },
          ])
          await store.advanceCrossSourceWatermark(undefined, {
            bitcoin: replacement,
            ethereum: { blockNumber: 12, blockHash: "dd".repeat(32) },
          })
          await store.rollbackEthereumEvidenceTo({
            blockNumber: 10,
            blockHash: "ee".repeat(32),
          })
        })

        assert.deepEqual(await store.loadRegisteredWalletIDs(), [])
        assert.equal(await store.countPendingDepositReveals(), 0)
        assert.deepEqual(await store.listUnmatchedProofs(20), [])
        assert.equal(await store.loadCrossSourceWatermark(), undefined)
      } finally {
        await database?.end()
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await admin.end()
      }
    })
  }
)

type IntegrationPool = P2TRPostgresPool & {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>>
  end(): Promise<void>
}

const scan = ({
  checkpoint,
  expected,
  next,
  blockHash,
}: {
  checkpoint: { height: number; hash: string }
  expected?: { height: number; hash: string }
  next: { height: number; hash: string }
  blockHash: string
}): P2TRCanonicalBitcoinScan => ({
  configurationFingerprint: "01".repeat(32),
  network: "regtest",
  checkpoint,
  ...(expected === undefined ? {} : { expectedCursor: expected }),
  rollbackTo: checkpoint,
  nextCursor: next,
  sampledFinalizedHead: next,
  complete: true,
  blocks: [
    {
      height: 1,
      hash: blockHash,
      parentHash: checkpoint.hash,
      rawBlockHex: "00",
      transactions: [],
    },
  ],
  trackedOutpoints: [],
  trackedOutpointSpends: [],
  candidates: [],
  acknowledgedCandidates: [],
  orphanedCandidates: [],
})
