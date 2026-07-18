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
        // Production migration runners own the transaction boundary.
        await database.query(`BEGIN;\n${migration}\nCOMMIT;`)

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
        const originalWatermark = {
          bitcoin: original,
          ethereum: { blockNumber: 11, blockHash: "ab".repeat(32) },
        }
        const replacementWatermark = {
          bitcoin: replacement,
          ethereum: originalWatermark.ethereum,
        }

        await store.applyBitcoinScan(
          scan({ checkpoint, next: original, blockHash: original.hash })
        )
        const pending = await store.loadPendingCandidates(10, original.height)
        assert.equal(pending.candidates.length, 1)
        assert.equal(pending.candidates[0].inputPrevouts[0].scriptPubKey, "")
        await store.applyBitcoinScan(
          acknowledgementScan({ checkpoint, current: original })
        )
        assert.deepEqual(
          await store.loadPendingCandidates(10, original.height),
          { candidates: [], complete: true }
        )
        await store.advanceCrossSourceWatermark(undefined, originalWatermark)
        assert.deepEqual(
          await store.loadCrossSourceWatermark(),
          originalWatermark
        )
        await store.applyBitcoinScan(
          scan({
            checkpoint,
            expected: original,
            next: replacement,
            blockHash: replacement.hash,
          })
        )

        // The replacement block history and stale cross-source watermark are
        // committed atomically by the Bitcoin scan transaction.
        assert.equal(await store.loadCrossSourceWatermark(), undefined)
        const replacementPending = await store.loadPendingCandidates(
          10,
          replacement.height
        )
        assert.equal(replacementPending.candidates.length, 1)
        assert.equal(
          replacementPending.candidates[0].block.hash,
          replacement.hash
        )
        await assert.rejects(
          store.advanceCrossSourceWatermark(
            originalWatermark,
            replacementWatermark
          ),
          /compare-and-swap failed/
        )
        await store.applyBitcoinScan(
          acknowledgementScan({ checkpoint, current: replacement })
        )
        assert.deepEqual(
          await store.loadPendingCandidates(10, replacement.height),
          { candidates: [], complete: true }
        )
        await store.advanceCrossSourceWatermark(undefined, replacementWatermark)
        assert.deepEqual(
          await store.loadCrossSourceWatermark(),
          replacementWatermark
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
        const outputs = await database.query<{ script_pubkey: string }>(
          `SELECT encode(script_pubkey, 'hex') AS script_pubkey
             FROM p2tr_bitcoin_outputs
            WHERE txid = decode($1, 'hex')`,
          ["10".repeat(32)]
        )
        assert.deepEqual(outputs.rows, [{ script_pubkey: "" }])
        await store.assertP2TRSignatureFraudActivationIndexReady(checkpoint)
        await assert.rejects(
          store.assertP2TRSignatureFraudActivationIndexReady({
            height: 0,
            hash: "ff".repeat(32),
          }),
          /exact configured genesis/
        )

        await database.query(
          `INSERT INTO p2tr_tracked_outpoints
             (txid, vout, kind, wallet_id, output_key, value_sats,
              script_pubkey, created_height, created_hash)
           VALUES (decode($1, 'hex'), 0, 'wallet', decode($2, 'hex'),
                   decode($2, 'hex'), 1, decode($3, 'hex'), $4,
                   decode($5, 'hex'))`,
          [
            "90".repeat(32),
            "91".repeat(32),
            `5120${"91".repeat(32)}`,
            replacement.height,
            replacement.hash,
          ]
        )
        await assert.rejects(
          store.assertP2TRSignatureFraudActivationIndexReady(checkpoint),
          /tracked FROST output outside/
        )
        await database.query(
          "DELETE FROM p2tr_tracked_outpoints WHERE txid = decode($1, 'hex')",
          ["90".repeat(32)]
        )

        await database.query(
          `INSERT INTO p2tr_pending_deposit_reveals
             (source_event_id, funding_txid, funding_vout, wallet_id,
              output_key, ethereum_block_number, ethereum_block_hash,
              resolved_funding_height, resolved_funding_hash, resolved_at)
           VALUES ('deposit:invalid-resolved', decode($1, 'hex'), 0,
                   decode($2, 'hex'), decode($3, 'hex'), 1,
                   decode($4, 'hex'), $5, decode($6, 'hex'), clock_timestamp())`,
          [
            "92".repeat(32),
            "93".repeat(32),
            "94".repeat(32),
            "95".repeat(32),
            replacement.height,
            replacement.hash,
          ]
        )
        await assert.rejects(
          store.assertP2TRSignatureFraudActivationIndexReady(checkpoint),
          /revealed FROST output outside/
        )
        await database.query(
          "DELETE FROM p2tr_pending_deposit_reveals WHERE source_event_id = 'deposit:invalid-resolved'"
        )

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
          await assert.rejects(
            store.assertP2TRSignatureFraudActivationIndexReady(checkpoint),
            /every canonical evidence backlog to be drained/
          )
          await store.advanceCrossSourceWatermark(replacementWatermark, {
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
      transactions: [
        {
          txid: "10".repeat(32),
          wtxid: "20".repeat(32),
          rawTransactionHex: "00",
          coinbase: true,
          inputs: [],
          outputs: [
            {
              txid: "10".repeat(32),
              vout: 0,
              valueSats: 0,
              scriptPubKey: "",
            },
          ],
        },
        {
          txid: "30".repeat(32),
          wtxid: "40".repeat(32),
          rawTransactionHex: "01",
          coinbase: false,
          inputs: [
            {
              txid: "10".repeat(32),
              vout: 0,
              spendingTxid: "30".repeat(32),
              inputIndex: 0,
              authenticatedPrevout: {
                txid: "10".repeat(32),
                vout: 0,
                valueSats: 0,
                scriptPubKey: "",
              },
            },
          ],
          outputs: [
            {
              txid: "30".repeat(32),
              vout: 0,
              valueSats: 0,
              scriptPubKey: "51",
            },
          ],
        },
      ],
    },
  ],
  trackedOutpoints: [],
  trackedOutpointSpends: [],
  candidates: [
    {
      txid: "30".repeat(32),
      wtxid: "40".repeat(32),
      rawTransactionHex: "01",
      block: { height: next.height, hash: blockHash },
      inputPrevouts: [
        {
          txid: "10".repeat(32),
          vout: 0,
          valueSats: 0,
          scriptPubKey: "",
        },
      ],
      walletInputKeyBindings: [],
    },
  ],
  acknowledgedCandidates: [],
  orphanedCandidates: [],
})

const acknowledgementScan = ({
  checkpoint,
  current,
}: {
  checkpoint: { height: number; hash: string }
  current: { height: number; hash: string }
}): P2TRCanonicalBitcoinScan => ({
  configurationFingerprint: "01".repeat(32),
  network: "regtest",
  checkpoint,
  expectedCursor: current,
  rollbackTo: current,
  nextCursor: current,
  sampledFinalizedHead: current,
  complete: true,
  blocks: [],
  trackedOutpoints: [],
  trackedOutpointSpends: [],
  candidates: [],
  acknowledgedCandidates: [
    {
      txid: "30".repeat(32),
      wtxid: "40".repeat(32),
      blockHash: current.hash,
    },
  ],
  orphanedCandidates: [],
})
