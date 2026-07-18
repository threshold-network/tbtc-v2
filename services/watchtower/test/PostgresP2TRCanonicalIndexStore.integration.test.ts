import { createHash, randomBytes } from "node:crypto"
import { createRequire } from "node:module"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import { Block, Transaction } from "bitcoinjs-lib"
import {
  calculateP2TRReadinessSnapshotRoot,
  PostgresP2TRCanonicalIndexStore,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import type {
  P2TRPostgresPool,
  P2TRPostgresQueryResult,
  P2TRReadinessExportAcknowledgementVerification,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import type {
  P2TRCanonicalBitcoinScan,
  P2TRCanonicalEvidenceStore,
} from "../src/P2TRCanonicalBitcoinIndex.js"
import type {
  P2TRCanonicalBitcoinBlock,
  P2TRCandidateObservationPage,
  P2TRCandidateProvenanceIdentity,
  P2TRReadinessExportAcknowledgement,
  P2TRReadinessExportStreamFrame,
  P2TRReadinessSnapshot,
} from "../src/P2TRCanonicalBitcoinIndex.js"

const postgresURL = process.env.P2TR_WATCHTOWER_TEST_POSTGRES_URL

type ProductionExposesLegacyCandidateLock =
  "lockP2TRCandidateProvenance" extends keyof P2TRCanonicalEvidenceStore
    ? true
    : false
const productionExposesLegacyCandidateLock: ProductionExposesLegacyCandidateLock =
  false
type ProductionExposesLegacyCandidateLoader =
  "loadPendingCandidates" extends keyof P2TRCanonicalEvidenceStore
    ? true
    : false
const productionExposesLegacyCandidateLoader: ProductionExposesLegacyCandidateLoader =
  false

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
        for (const filename of [
          "001_p2tr_canonical_index.sql",
          "002_p2tr_canonical_ethereum.sql",
        ]) {
          const migration = await readFile(
            new URL(`../migrations/${filename}`, import.meta.url),
            "utf8"
          )
          // Production migration runners own each transaction boundary.
          await database.query(`BEGIN;\n${migration}\nCOMMIT;`)
        }

        const store = new PostgresP2TRCanonicalIndexStore(
          database,
          integrationStoreOptions({
            maxJournalBlocks: 10,
            maxJournalTransactions: 100,
            maxJournalInputs: 1_000,
            maxJournalOutputs: 1_000,
            maxWalletBindings: 1_000,
          })
        )
        const checkpoint = checkpointBlock("reorg")
        const originalFunding = fundingTransaction("reorg:original:funding", [
          { valueSats: 0, scriptPubKey: "" },
          { valueSats: 1, scriptPubKey: `5120${"91".repeat(32)}` },
        ])
        const originalSpend = spendingTransaction(
          "reorg:original:spend",
          [originalFunding.outputs[1]],
          `5120${"91".repeat(32)}`
        )
        const originalFundingBlock = block(
          1,
          bitcoinPoint(checkpoint),
          [originalFunding],
          "reorg:original:funding-block"
        )
        const originalBlock = block(
          2,
          bitcoinPoint(originalFundingBlock),
          [originalSpend],
          "reorg:original:spend-block"
        )
        const original = bitcoinPoint(originalBlock)
        const replacementFunding = fundingTransaction(
          "reorg:replacement:funding",
          [
            { valueSats: 0, scriptPubKey: "" },
            { valueSats: 1, scriptPubKey: `5120${"91".repeat(32)}` },
          ]
        )
        const replacementSpend = spendingTransaction(
          "reorg:replacement:spend",
          [replacementFunding.outputs[1]],
          `5120${"91".repeat(32)}`
        )
        const replacementFundingBlock = block(
          1,
          bitcoinPoint(checkpoint),
          [replacementFunding],
          "reorg:replacement:funding-block"
        )
        const replacementBlock = block(
          2,
          bitcoinPoint(replacementFundingBlock),
          [replacementSpend],
          "reorg:replacement:spend-block"
        )
        const replacement = bitcoinPoint(replacementBlock)
        const originalWatermark = {
          bitcoin: original,
          ethereum: { blockNumber: 11, blockHash: "ab".repeat(32) },
        }
        const replacementWatermark = {
          bitcoin: replacement,
          ethereum: originalWatermark.ethereum,
        }

        await store.addFrostWalletBindings([
          {
            walletID: "91".repeat(32),
            sourceEventID: "wallet:fixture",
            ethereum: { blockNumber: 11, blockHash: "ab".repeat(32) },
          },
        ])

        await store.applyBitcoinScan(
          canonicalMutationScan({
            checkpoint,
            blocks: [originalFundingBlock, originalBlock],
          })
        )
        assert.equal(productionExposesLegacyCandidateLock, false)
        assert.equal(productionExposesLegacyCandidateLoader, false)
        await assert.rejects(
          store.loadPendingCandidates(10, original.height),
          /forbidden for a genesis index/
        )
        await store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
          await store.lockP2TRReadinessSnapshot()
          await assert.rejects(
            store.lockP2TRCandidateProvenance({
              blockHash: original.hash,
              txid: originalSpend.txid,
              wtxid: originalSpend.wtxid,
            }),
            /forbidden for a genesis index/
          )
        })
        const originalPage = await store.loadPendingCandidateObservations({
          limit: 10,
          atOrBelowHeight: original.height,
        })
        assert.equal(originalPage.state, "ready")
        assert.equal(originalPage.observations.length, 1)
        assert.equal(originalPage.observations[0].blockHash, original.hash)
        assert.equal(
          originalPage.observations[0].inputProvenance.fundingTxid,
          originalFunding.txid
        )
        assert.equal(
          originalPage.observations[0].inputProvenance.fundingVout,
          1
        )
        await store.applyBitcoinScan(
          canonicalMutationScan({
            checkpoint,
            expected: original,
            candidateObservationAcknowledgement:
              compactObservationAcknowledgement(originalPage),
          })
        )
        const deliveredOriginalPage =
          await store.loadPendingCandidateObservations({
            limit: 10,
            atOrBelowHeight: original.height,
          })
        assert.equal(deliveredOriginalPage.state, "ready")
        assert.deepEqual(deliveredOriginalPage.observations, [])
        assert.equal(deliveredOriginalPage.complete, true)
        await store.advanceCrossSourceWatermark(undefined, originalWatermark)
        assert.deepEqual(
          await store.loadCrossSourceWatermark(),
          originalWatermark
        )
        await store.applyBitcoinScan(
          canonicalMutationScan({
            checkpoint,
            expected: original,
            rollbackTo: bitcoinPoint(checkpoint),
            blocks: [replacementFundingBlock, replacementBlock],
          })
        )

        // The replacement block history and stale cross-source watermark are
        // committed atomically by the Bitcoin scan transaction.
        assert.equal(await store.loadCrossSourceWatermark(), undefined)
        await assert.rejects(
          store.advanceCrossSourceWatermark(
            originalWatermark,
            replacementWatermark
          ),
          /compare-and-swap failed/
        )
        const replacementPage = await store.loadPendingCandidateObservations({
          limit: 10,
          atOrBelowHeight: replacement.height,
        })
        assert.equal(replacementPage.state, "ready")
        assert.equal(replacementPage.observations.length, 1)
        assert.equal(
          replacementPage.observations[0].blockHash,
          replacement.hash
        )
        await store.applyBitcoinScan(
          canonicalMutationScan({
            checkpoint,
            expected: replacement,
            candidateObservationAcknowledgement:
              compactObservationAcknowledgement(replacementPage),
          })
        )
        const deliveredReplacementPage =
          await store.loadPendingCandidateObservations({
            limit: 10,
            atOrBelowHeight: replacement.height,
          })
        assert.equal(deliveredReplacementPage.state, "ready")
        assert.deepEqual(deliveredReplacementPage.observations, [])
        assert.equal(deliveredReplacementPage.complete, true)
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
          { height: "1", hash: replacementFundingBlock.hash },
          { height: "2", hash: replacement.hash },
        ])
        const outputs = await database.query<{ script_pubkey: string }>(
          `SELECT encode(script_pubkey, 'hex') AS script_pubkey
             FROM p2tr_bitcoin_outputs
            WHERE txid = decode($1, 'hex') AND vout = 0`,
          [replacementFunding.txid]
        )
        assert.deepEqual(outputs.rows, [{ script_pubkey: "" }])
        await store.assertP2TRSignatureFraudActivationIndexReady(
          bitcoinPoint(checkpoint)
        )
        await assert.rejects(
          store.assertP2TRSignatureFraudActivationIndexReady({
            height: 0,
            hash: "ff".repeat(32),
          }),
          /exact configured genesis/
        )

        await database.query(
          `UPDATE p2tr_tracked_outpoints
              SET wallet_id = decode($1, 'hex')
            WHERE txid = decode($2, 'hex') AND vout = 0`,
          ["92".repeat(32), replacementSpend.txid]
        )
        await assert.rejects(
          store.assertP2TRSignatureFraudActivationIndexReady(
            bitcoinPoint(checkpoint)
          ),
          /tracked FROST output outside/
        )
        await database.query(
          `UPDATE p2tr_tracked_outpoints
              SET wallet_id = decode($1, 'hex')
            WHERE txid = decode($2, 'hex') AND vout = 0`,
          ["91".repeat(32), replacementSpend.txid]
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
          store.assertP2TRSignatureFraudActivationIndexReady(
            bitcoinPoint(checkpoint)
          ),
          /revealed FROST output outside/
        )
        await database.query(
          "DELETE FROM p2tr_pending_deposit_reveals WHERE source_event_id = 'deposit:invalid-resolved'"
        )

        await store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
          await store.lockP2TRReadinessSnapshot()
          await store.addFrostWalletBindings([
            {
              walletID: "11".repeat(32),
              walletPubKeyHash: "12".repeat(20),
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
            store.assertP2TRSignatureFraudActivationIndexReady(
              bitcoinPoint(checkpoint)
            ),
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

    it("retains BIP30-shaped occurrences and resolves the latest preceding output", async () => {
      await withIntegrationStore(async ({ store, database }) => {
        const checkpoint = checkpointBlock("bip30")
        const duplicateFunding = fundingTransaction("bip30:duplicate", [
          { valueSats: 5, scriptPubKey: "" },
        ])
        const duplicateTxid = duplicateFunding.txid
        const firstBlock = block(
          1,
          bitcoinPoint(checkpoint),
          [duplicateFunding],
          "bip30:block:1"
        )
        const firstSpend = spendingTransaction("bip30:spend:1", [
          duplicateFunding.outputs[0],
        ])
        const secondBlock = block(
          2,
          bitcoinPoint(firstBlock),
          [firstSpend],
          "bip30:block:2"
        )
        const thirdBlock = block(
          3,
          bitcoinPoint(secondBlock),
          [duplicateFunding],
          "bip30:block:3"
        )
        const secondSpend = spendingTransaction("bip30:spend:2", [
          duplicateFunding.outputs[0],
        ])
        const fourthBlock = block(
          4,
          bitcoinPoint(thirdBlock),
          [secondSpend],
          "bip30:block:4"
        )
        const independentFunding = fundingTransaction("bip30:independent", [
          { valueSats: 7, scriptPubKey: "51" },
        ])
        const independentSpend = spendingTransaction(
          "bip30:independent-spend",
          [independentFunding.outputs[0]]
        )
        const fifthBlock = block(
          5,
          bitcoinPoint(fourthBlock),
          [independentFunding],
          "bip30:block:5-funding"
        )
        const sixthBlock = block(
          6,
          bitcoinPoint(fifthBlock),
          [independentSpend],
          "bip30:block:6-spend"
        )
        const blocks = [
          firstBlock,
          secondBlock,
          thirdBlock,
          fourthBlock,
          fifthBlock,
          sixthBlock,
        ]
        await store.applyBitcoinScan(
          canonicalMutationScan({ checkpoint, blocks })
        )

        const occurrences = await database.query<{
          block_hash: string
          script_pubkey: string
        }>(
          `SELECT encode(block_hash, 'hex') AS block_hash,
                  encode(script_pubkey, 'hex') AS script_pubkey
             FROM p2tr_bitcoin_outputs
            WHERE txid = decode($1, 'hex') AND vout = 0
            ORDER BY block_height`,
          [duplicateTxid]
        )
        assert.deepEqual(occurrences.rows, [
          { block_hash: firstBlock.hash, script_pubkey: "" },
          { block_hash: thirdBlock.hash, script_pubkey: "" },
        ])
        const resolved = await database.query<{
          spending_txid: string
          prev_block_hash: string
        }>(
          `SELECT encode(spending_txid, 'hex') AS spending_txid,
                  encode(prev_block_hash, 'hex') AS prev_block_hash
             FROM p2tr_bitcoin_inputs
            ORDER BY block_height, input_index`
        )
        assert.deepEqual(resolved.rows, [
          {
            spending_txid: firstSpend.txid,
            prev_block_hash: firstBlock.hash,
          },
          {
            spending_txid: secondSpend.txid,
            prev_block_hash: thirdBlock.hash,
          },
          {
            spending_txid: independentSpend.txid,
            prev_block_hash: fifthBlock.hash,
          },
        ])

        await assert.rejects(
          store.lockP2TRReadinessSnapshot(),
          /active transaction/
        )
        const snapshot = await readReadinessSnapshot(store)
        assert.equal(snapshot.bitcoin.journalCounts.blocks, 7)
        assert.equal(snapshot.bitcoin.journalCounts.transactions, 10)
        assert.equal(snapshot.bitcoin.journalCounts.inputs, 3)
        assert.equal(snapshot.bitcoin.journalCounts.unresolvedInputs, 0)
        await assert.rejects(
          database.query("DELETE FROM p2tr_bitcoin_blocks WHERE height = 4"),
          /foreign key constraint/
        )
      })
    })

    it("generates exact input provenance and makes stale acknowledgements tombstone-safe", async () => {
      await withIntegrationStore(async ({ store, database }) => {
        const checkpoint = checkpointBlock("provenance", 100)
        const wallets = ["11", "12", "13", "14"].map((byte) => byte.repeat(32))
        const funding = fundingTransaction(
          "provenance:funding",
          wallets.map((walletID, index) => ({
            valueSats: 10 + index,
            scriptPubKey: `5120${walletID}`,
          }))
        )
        const fundingTxid = funding.txid
        const fundingBlock = block(
          101,
          bitcoinPoint(checkpoint),
          [funding],
          "provenance:block:funding"
        )
        const spend = spendingTransaction(
          "provenance:spend",
          funding.outputs.slice(0, 3)
        )
        const spendTxid = spend.txid
        const spendWtxid = spend.wtxid
        const unrelatedSpend = spendingTransaction("provenance:unrelated", [
          funding.outputs[3],
        ])
        const unrelatedTxid = unrelatedSpend.txid
        const unrelatedWtxid = unrelatedSpend.wtxid
        const headBlock = block(
          102,
          bitcoinPoint(fundingBlock),
          [spend, unrelatedSpend],
          "provenance:block:head"
        )
        const head = bitcoinPoint(headBlock)
        const blocks = [fundingBlock, headBlock]

        // Ethereum bindings arrive before the Bitcoin scan inside the same
        // serializable transaction. Apply-time reconciliation must still find
        // both spends and mint exact input-level provenance.
        await store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
          await store.addFrostWalletBindings([
            walletBinding(wallets[0], "wallet:a", 10),
            walletBinding(wallets[3], "wallet:d", 10),
          ])
          await store.applyBitcoinScan(
            canonicalMutationScan({ checkpoint, blocks })
          )
        })
        let pending = await store.loadPendingCandidates(10, head.height)
        assert.equal(pending.candidates.length, 2)
        const firstGeneration = pending.candidates.find(
          ({ txid }) => txid === spendTxid
        )!
        const unrelated = pending.candidates.find(
          ({ txid }) => txid === unrelatedTxid
        )!
        const unrelatedIdentity = candidateIdentity(unrelated)

        await store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
          await assert.rejects(
            store.lockP2TRCandidateProvenance({
              blockHash: head.hash,
              txid: spendTxid,
              wtxid: spendWtxid,
            }),
            /requires a locked readiness snapshot/
          )
          await store.lockP2TRReadinessSnapshot()
          const claim = await store.lockP2TRCandidateProvenance({
            blockHash: head.hash,
            txid: spendTxid,
            wtxid: spendWtxid,
          })
          assert.equal(claim?.inputProvenance.length, 1)
          assert.deepEqual(claim?.inputProvenance[0], {
            inputIndex: 0,
            fundingBlockHash: fundingBlock.hash,
            fundingTxid,
            fundingVout: 0,
            walletID: wallets[0],
            outputKey: wallets[0],
            bindingKind: "wallet",
            sourceEventID: "wallet:a",
            ethereumBlockNumber: 10,
            ethereumBlockHash: "aa".repeat(32),
          })
          assert.equal(
            claim?.inputProvenance.some(({ inputIndex }) => inputIndex === 1),
            false
          )
        })

        await store.addFrostWalletBindings([
          walletBinding(wallets[1], "wallet:b", 11),
        ])
        pending = await store.loadPendingCandidates(10, head.height)
        const secondGeneration = pending.candidates.find(
          ({ txid }) => txid === spendTxid
        )!
        assert.notEqual(
          secondGeneration.provenanceGeneration,
          firstGeneration.provenanceGeneration
        )
        assert.deepEqual(
          candidateIdentity(
            pending.candidates.find(({ txid }) => txid === unrelatedTxid)!
          ),
          unrelatedIdentity
        )
        await store.addFrostWalletBindings([
          walletBinding(wallets[2], "wallet:c", 12),
        ])
        pending = await store.loadPendingCandidates(10, head.height)
        const thirdGeneration = pending.candidates.find(
          ({ txid }) => txid === spendTxid
        )!
        assert.notEqual(
          thirdGeneration.provenanceGeneration,
          secondGeneration.provenanceGeneration
        )

        const invalidationPage = await store.listInvalidatedCandidateProvenance(
          0,
          1
        )
        assert.equal(invalidationPage.invalidations.length, 1)
        assert.equal(invalidationPage.complete, false)
        const invalidationTail = await store.listInvalidatedCandidateProvenance(
          invalidationPage.invalidations[0].invalidationID,
          20
        )
        assert.equal(invalidationTail.invalidations.length, 1)
        assert.deepEqual(invalidationTail.invalidations[0].sourceEventIDs, [
          "wallet:a",
          "wallet:b",
        ])

        // Gen1 -> gen2 -> gen3: a late exact gen1 acknowledgement is obsolete
        // and must not deliver gen3.
        await store.applyBitcoinScan(
          canonicalMutationScan({
            checkpoint,
            expected: head,
            testOnlyAcknowledgedCandidates: [
              candidateIdentity(firstGeneration),
            ],
          })
        )
        pending = await store.loadPendingCandidates(10, head.height)
        assert.equal(
          pending.candidates.find(({ txid }) => txid === spendTxid)
            ?.provenanceGeneration,
          thirdGeneration.provenanceGeneration
        )
        await store.applyBitcoinScan(
          canonicalMutationScan({
            checkpoint,
            expected: head,
            testOnlyAcknowledgedCandidates: [
              {
                ...candidateIdentity(firstGeneration),
                provenanceFingerprint: "ff".repeat(32),
              },
            ],
          })
        )
        pending = await store.loadPendingCandidates(10, head.height)
        assert.equal(
          pending.candidates.find(({ txid }) => txid === spendTxid)
            ?.provenanceGeneration,
          thirdGeneration.provenanceGeneration
        )

        const beforeDelivery = await readReadinessSnapshot(store)
        await store.applyBitcoinScan(
          canonicalMutationScan({
            checkpoint,
            expected: head,
            testOnlyAcknowledgedCandidates: [
              candidateIdentity(thirdGeneration),
              unrelatedIdentity,
            ],
          })
        )
        const afterDelivery = await readReadinessSnapshot(store)
        assert.equal(afterDelivery.semanticRoot, beforeDelivery.semanticRoot)
        assert.notEqual(afterDelivery.root, beforeDelivery.root)
        assert.deepEqual(await store.loadPendingCandidates(10, head.height), {
          candidates: [],
          complete: true,
        })
        // Delivered successor still cannot make an exact old tombstone ack
        // fail or mutate the live successor.
        await store.applyBitcoinScan(
          canonicalMutationScan({
            checkpoint,
            expected: head,
            testOnlyAcknowledgedCandidates: [
              candidateIdentity(firstGeneration),
            ],
          })
        )
        assert.deepEqual(await store.loadPendingCandidates(10, head.height), {
          candidates: [],
          complete: true,
        })

        const rollbackInvalidations = await store.rollbackEthereumEvidenceTo({
          blockNumber: 0,
          blockHash: "00".repeat(32),
        })
        assert.equal(rollbackInvalidations.length, 2)
        assert.deepEqual(await store.loadPendingCandidates(10, head.height), {
          candidates: [],
          complete: true,
        })
        // Multi-hop then delete: the append-only gen1 tombstone remains a
        // sufficient exact no-op even though no current candidate exists.
        await store.applyBitcoinScan(
          canonicalMutationScan({
            checkpoint,
            expected: head,
            testOnlyAcknowledgedCandidates: [
              candidateIdentity(firstGeneration),
            ],
          })
        )

        const lastBeforeRestoration = (
          await store.listInvalidatedCandidateProvenance(0, 20)
        ).invalidations.at(-1)!.invalidationID
        await store.addFrostWalletBindings([
          walletBinding(wallets[0], "wallet:a-restored", 20),
        ])
        const restored = (await store.loadPendingCandidates(10, head.height))
          .candidates[0]
        assert.ok(
          restored.provenanceGeneration! > thirdGeneration.provenanceGeneration!
        )
        await store.rollbackEthereumEvidenceTo({
          blockNumber: 0,
          blockHash: "00".repeat(32),
        })
        const oscillation = await store.listInvalidatedCandidateProvenance(
          lastBeforeRestoration,
          20
        )
        assert.equal(oscillation.invalidations.length, 1)
        assert.equal(
          oscillation.invalidations[0].provenanceGeneration,
          restored.provenanceGeneration
        )

        const allInvalidations = (
          await store.listInvalidatedCandidateProvenance(0, 20)
        ).invalidations
        assert.deepEqual(
          allInvalidations.map(({ invalidationID }) => invalidationID),
          allInvalidations.map((_, index) => index + 1)
        )
        const allocatorBefore = await readReadinessSnapshot(store)
        await database.query(
          `BEGIN;
           UPDATE p2tr_candidate_provenance_generation
              SET next_invalidation_id = next_invalidation_id + 1;
           ROLLBACK;`
        )
        const allocatorAfterRollback = await readReadinessSnapshot(store)
        assert.deepEqual(
          allocatorAfterRollback.allocators,
          allocatorBefore.allocators
        )
        assert.equal(allocatorAfterRollback.root, allocatorBefore.root)

        await database.query(
          `UPDATE p2tr_candidate_provenance_generation
              SET next_generation = next_generation + 1`
        )
        const allocatorAfterCommittedGap = await readReadinessSnapshot(store)
        assert.equal(
          allocatorAfterCommittedGap.allocators
            .nextCandidateProvenanceGeneration,
          allocatorBefore.allocators.nextCandidateProvenanceGeneration + 1
        )
        assert.equal(
          allocatorAfterCommittedGap.semanticRoot,
          allocatorBefore.semanticRoot
        )
        assert.notEqual(allocatorAfterCommittedGap.root, allocatorBefore.root)

        await database.query(
          `UPDATE p2tr_candidate_provenance_generation
              SET next_invalidation_id = $1`,
          [allInvalidations.at(-1)!.invalidationID]
        )
        await assert.rejects(
          readReadinessSnapshot(store),
          /allocator would reuse retained identity/
        )
        await database.query(
          `UPDATE p2tr_candidate_provenance_generation
              SET next_invalidation_id = $1,
                  next_generation = $2`,
          [
            allInvalidations.at(-1)!.invalidationID + 1,
            restored.provenanceGeneration,
          ]
        )
        await assert.rejects(
          readReadinessSnapshot(store),
          /allocator would reuse retained identity/
        )
      })
    })

    it("revalidates stale wallet and deposit previews after an Ethereum rollback", async () => {
      await withIntegrationStore(async ({ store, database }) => {
        const checkpoint = checkpointBlock("stale-preview")
        const walletID = "21".repeat(32)
        const depositWalletID = "22".repeat(32)
        const depositOutputKey = "31".repeat(32)
        const funding = fundingTransaction("stale-preview:funding", [
          { valueSats: 10, scriptPubKey: `5120${walletID}` },
          { valueSats: 11, scriptPubKey: `5120${depositOutputKey}` },
        ])
        const fundingTxid = funding.txid
        const fundingBlock = block(
          1,
          bitcoinPoint(checkpoint),
          [funding],
          "stale-preview:block:funding"
        )
        const fundingPoint = bitcoinPoint(fundingBlock)
        await store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
          await store.addFrostWalletBindings([
            walletBinding(walletID, "wallet:stale", 10),
          ])
          await store.addTaprootDepositBindings([
            depositBinding(
              fundingTxid,
              1,
              depositWalletID,
              depositOutputKey,
              "deposit:stale",
              10
            ),
          ])
          await store.applyBitcoinScan(
            canonicalMutationScan({ checkpoint, blocks: [fundingBlock] })
          )
        })
        const trackedBefore = await database.query<{ count: string }>(
          "SELECT count(*) AS count FROM p2tr_tracked_outpoints"
        )
        assert.equal(trackedBefore.rows[0].count, "2")

        const spend = spendingTransaction(
          "stale-preview:spend",
          funding.outputs
        )
        const spendingTxid = spend.txid
        const spendingWtxid = spend.wtxid
        const headBlock = block(
          2,
          fundingPoint,
          [spend],
          "stale-preview:block:head"
        )
        const head = bitcoinPoint(headBlock)
        const staged = canonicalMutationScan({
          checkpoint,
          expected: fundingPoint,
          blocks: [headBlock],
        })
        staged.trackedOutpointSpends = [0, 1].map((vout) => ({
          txid: fundingTxid,
          vout,
          spendingTxid,
          spendingWtxid,
          inputIndex: vout,
          spentAt: head,
        }))
        staged.candidates = [
          {
            txid: spendingTxid,
            wtxid: spendingWtxid,
            rawTransactionHex: spend.rawTransactionHex,
            block: head,
            inputPrevouts: spend.inputs.map(
              ({ authenticatedPrevout }) => authenticatedPrevout!
            ),
            walletInputKeyBindings: [
              {
                txid: fundingTxid,
                vout: 1,
                walletID: depositWalletID,
                outputKey: depositOutputKey,
              },
            ],
          },
        ]

        await store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
          await store.rollbackEthereumEvidenceTo({
            blockNumber: 0,
            blockHash: "00".repeat(32),
          })
          await store.applyBitcoinScan(staged)
        })
        assert.deepEqual((await store.loadBitcoinCursor())?.current, head)
        const staleRows = await database.query<{
          tracked: string
          candidates: string
        }>(
          `SELECT
             (SELECT count(*) FROM p2tr_tracked_outpoints) AS tracked,
             (SELECT count(*) FROM p2tr_bitcoin_candidates) AS candidates`
        )
        assert.deepEqual(staleRows.rows[0], {
          tracked: "0",
          candidates: "0",
        })
      })
    })

    it("rolls back more resolved deposits than the pending backlog cap", async () => {
      await withIntegrationStore(
        async ({ store, database }) => {
          const checkpoint = checkpointBlock("deposit-rollback")
          const keys = ["41".repeat(32), "42".repeat(32)]
          const wallets = ["51".repeat(32), "52".repeat(32)]
          const funding = fundingTransaction(
            "deposit-rollback:funding",
            keys.map((outputKey) => ({
              valueSats: 20,
              scriptPubKey: `5120${outputKey}`,
            }))
          )
          const fundingTxid = funding.txid
          const fundingBlock = block(
            1,
            bitcoinPoint(checkpoint),
            [funding],
            "deposit-rollback:block:funding"
          )
          const firstSpend = spendingTransaction("deposit-rollback:spend:one", [
            funding.outputs[0],
          ])
          const secondSpend = spendingTransaction(
            "deposit-rollback:spend:two",
            [funding.outputs[1]]
          )
          const headBlock = block(
            2,
            bitcoinPoint(fundingBlock),
            [firstSpend, secondSpend],
            "deposit-rollback:block:head"
          )
          const head = bitcoinPoint(headBlock)
          const blocks = [fundingBlock, headBlock]
          await store.addTaprootDepositBindings([
            depositBinding(
              fundingTxid,
              0,
              wallets[0],
              keys[0],
              "deposit:one",
              10
            ),
          ])
          await store.applyBitcoinScan(
            canonicalMutationScan({ checkpoint, blocks })
          )
          await store.addTaprootDepositBindings([
            depositBinding(
              fundingTxid,
              1,
              wallets[1],
              keys[1],
              "deposit:two",
              11
            ),
          ])
          assert.equal(await store.countPendingDepositReveals(), 0)
          const resolved = await database.query<{ count: string }>(
            "SELECT count(*) AS count FROM p2tr_pending_deposit_reveals WHERE resolved_at IS NOT NULL"
          )
          assert.equal(resolved.rows[0].count, "2")

          const invalidated = await store.rollbackEthereumEvidenceTo({
            blockNumber: 0,
            blockHash: "00".repeat(32),
          })
          assert.equal(invalidated.length, 2)
          assert.equal(await store.countPendingDepositReveals(), 0)
          const remaining = await database.query<{ count: string }>(
            "SELECT count(*) AS count FROM p2tr_pending_deposit_reveals"
          )
          assert.equal(remaining.rows[0].count, "0")
        },
        { maxPendingDepositReveals: 1 }
      )
    })

    it("rolls back an unbounded server-side set of zero-output wallets", async () => {
      await withIntegrationStore(
        async ({ store, database }) => {
          await store.addFrostWalletBindings(
            ["61", "62", "63"].map((byte, index) =>
              walletBinding(byte.repeat(32), `wallet:zero:${index}`, 10)
            )
          )
          const before = await database.query<{ count: string }>(
            "SELECT count(*) AS count FROM p2tr_frost_wallet_bindings"
          )
          assert.equal(before.rows[0].count, "3")
          assert.equal((await store.loadRegisteredWalletIDs()).length, 3)
          await store.rollbackEthereumEvidenceTo({
            blockNumber: 0,
            blockHash: "00".repeat(32),
          })
          const after = await database.query<{ count: string }>(
            "SELECT count(*) AS count FROM p2tr_frost_wallet_bindings"
          )
          assert.equal(after.rows[0].count, "0")
        },
        { maxJournalOutputs: 2, maxWalletBindings: 4 }
      )
      await withIntegrationStore(
        async ({ store, database }) => {
          await assert.rejects(
            store.addFrostWalletBindings(
              ["64", "65", "66"].map((byte, index) =>
                walletBinding(byte.repeat(32), `wallet:bounded:${index}`, 10)
              )
            ),
            /registry reached its 2-item capacity/
          )
          const durable = await database.query<{ count: string }>(
            "SELECT count(*) AS count FROM p2tr_frost_wallet_bindings"
          )
          assert.equal(durable.rows[0].count, "0")
        },
        { maxWalletBindings: 2 }
      )
    })

    it("separates rebuild-stable semantic roots from whole-snapshot local roots", async () => {
      const checkpoint = checkpointBlock("semantic-roots", 100)
      const walletID = "71".repeat(32)
      const funding = fundingTransaction("semantic-roots:funding", [
        { valueSats: 15, scriptPubKey: `5120${walletID}` },
      ])
      const fundingTxid = funding.txid
      const fundingBlock = block(
        101,
        bitcoinPoint(checkpoint),
        [funding],
        "semantic-roots:block:funding"
      )
      const spend = spendingTransaction("semantic-roots:spend", [
        funding.outputs[0],
      ])
      const spendingTxid = spend.txid
      const spendingWtxid = spend.wtxid
      const headBlock = block(
        102,
        bitcoinPoint(fundingBlock),
        [spend],
        "semantic-roots:block:head"
      )
      const head = bitcoinPoint(headBlock)
      const blocks = [fundingBlock, headBlock]
      const watermark = {
        bitcoin: head,
        ethereum: { blockNumber: 10, blockHash: "aa".repeat(32) },
      }
      let rebuilt: P2TRReadinessSnapshot | undefined
      await withIntegrationStore(
        async ({ store }) => {
          await store.applyBitcoinScan(
            canonicalMutationScan({
              checkpoint,
              blocks,
              configurationFingerprint: "01".repeat(32),
              trustDomainID: "trust-a",
            })
          )
          await store.addFrostWalletBindings([
            walletBinding(walletID, "wallet:equivalent", 10),
          ])
          await store.rollbackEthereumEvidenceTo({
            blockNumber: 0,
            blockHash: "00".repeat(32),
          })
          await store.addFrostWalletBindings([
            walletBinding(walletID, "wallet:equivalent", 10),
          ])
          await store.advanceCrossSourceWatermark(undefined, watermark)
          rebuilt = await readReadinessSnapshot(store)
        },
        { storeID: "semantic-store" }
      )

      let direct: P2TRReadinessSnapshot | undefined
      await withIntegrationStore(
        async ({ store }) => {
          await store.applyBitcoinScan(
            canonicalMutationScan({
              checkpoint,
              blocks,
              configurationFingerprint: "02".repeat(32),
              trustDomainID: "trust-b",
            })
          )
          await store.addFrostWalletBindings([
            walletBinding(walletID, "wallet:equivalent", 10),
          ])
          await store.advanceCrossSourceWatermark(undefined, watermark)
          direct = await readReadinessSnapshot(store)
        },
        { storeID: "semantic-store" }
      )
      assert.ok(rebuilt !== undefined && direct !== undefined)
      assert.equal(rebuilt.semanticRoot, direct.semanticRoot)
      assert.notEqual(rebuilt.root, direct.root)
      assert.notEqual(rebuilt.generation, direct.generation)

      assert.equal(calculateP2TRReadinessSnapshotRoot(rebuilt), rebuilt.root)
      const siblingTransplants: P2TRReadinessSnapshot[] = [
        { ...rebuilt, storeID: "other-store" },
        {
          ...rebuilt,
          configurationFingerprint: direct.configurationFingerprint,
        },
        { ...rebuilt, network: "testnet" },
        { ...rebuilt, trustDomainID: direct.trustDomainID },
        {
          ...rebuilt,
          authorizationDomain: {
            ...rebuilt.authorizationDomain,
            domainDigest: "fd".repeat(32),
          },
        },
        {
          ...rebuilt,
          bitcoin: {
            ...rebuilt.bitcoin,
            current: { ...rebuilt.bitcoin.current, hash: "ff".repeat(32) },
          },
        },
        {
          ...rebuilt,
          bitcoin: {
            ...rebuilt.bitcoin,
            chainCommitment: "fe".repeat(32),
          },
        },
        {
          ...rebuilt,
          bitcoin: {
            ...rebuilt.bitcoin,
            journalCounts: {
              ...rebuilt.bitcoin.journalCounts,
              outputs: rebuilt.bitcoin.journalCounts.outputs + 1,
            },
          },
        },
        {
          ...rebuilt,
          projection: {
            ...rebuilt.projection,
            pendingCandidates: rebuilt.projection.pendingCandidates + 1,
          },
        },
      ]
      for (const transplanted of siblingTransplants) {
        assert.notEqual(
          calculateP2TRReadinessSnapshotRoot(transplanted),
          rebuilt.root
        )
      }

      // Delivery/invalidation history is operational-only.
      let delivered: P2TRReadinessSnapshot | undefined
      await withIntegrationStore(
        async ({ store }) => {
          await store.applyBitcoinScan(
            canonicalMutationScan({
              checkpoint,
              blocks,
              configurationFingerprint: "02".repeat(32),
              trustDomainID: "trust-b",
            })
          )
          await store.addFrostWalletBindings([
            walletBinding(walletID, "wallet:equivalent", 10),
          ])
          await store.advanceCrossSourceWatermark(undefined, watermark)
          const candidate = (await store.loadPendingCandidates(10, head.height))
            .candidates[0]
          await store.applyBitcoinScan(
            canonicalMutationScan({
              checkpoint,
              expected: head,
              configurationFingerprint: "02".repeat(32),
              trustDomainID: "trust-b",
              testOnlyAcknowledgedCandidates: [candidateIdentity(candidate)],
            })
          )
          delivered = await readReadinessSnapshot(store)
        },
        { storeID: "semantic-store" }
      )
      assert.equal(delivered?.semanticRoot, direct.semanticRoot)
      assert.notEqual(delivered?.root, direct.root)

      // A distinct, fully authenticated block history with the same journal
      // cardinalities is still semantic evidence.
      let differentBlock: P2TRReadinessSnapshot | undefined
      await withIntegrationStore(
        async ({ store }) => {
          const changedFundingBlock = block(
            101,
            bitcoinPoint(checkpoint),
            [funding],
            "semantic-roots:block:changed-funding"
          )
          const changedHeadBlock = block(
            102,
            bitcoinPoint(changedFundingBlock),
            [spend],
            "semantic-roots:block:changed-head"
          )
          const changedBlocks = [changedFundingBlock, changedHeadBlock]
          await store.applyBitcoinScan(
            canonicalMutationScan({
              checkpoint,
              blocks: changedBlocks,
              configurationFingerprint: "02".repeat(32),
              trustDomainID: "trust-b",
            })
          )
          await store.addFrostWalletBindings([
            walletBinding(walletID, "wallet:equivalent", 10),
          ])
          await store.advanceCrossSourceWatermark(undefined, {
            ...watermark,
            bitcoin: bitcoinPoint(changedHeadBlock),
          })
          differentBlock = await readReadinessSnapshot(store)
        },
        { storeID: "semantic-store" }
      )
      assert.deepEqual(
        differentBlock?.bitcoin.journalCounts,
        direct.bitcoin.journalCounts
      )
      assert.notEqual(differentBlock?.semanticRoot, direct.semanticRoot)

      // The exact cross-source watermark is part of semantic readiness.
      let movedWatermark: P2TRReadinessSnapshot | undefined
      await withIntegrationStore(async ({ store }) => {
        await store.applyBitcoinScan(
          canonicalMutationScan({ checkpoint, blocks })
        )
        await store.addFrostWalletBindings([
          walletBinding(walletID, "wallet:equivalent", 10),
        ])
        await store.advanceCrossSourceWatermark(undefined, {
          bitcoin: head,
          ethereum: { blockNumber: 11, blockHash: "ab".repeat(32) },
        })
        movedWatermark = await readReadinessSnapshot(store)
      })
      assert.notEqual(movedWatermark?.semanticRoot, direct.semanticRoot)
    })

    it("serializes real PostgreSQL readiness snapshots against writers", async () => {
      await withIntegrationStore(async ({ store, database }) => {
        const checkpoint = checkpointBlock("snapshot-serialization")
        await store.applyBitcoinScan(canonicalMutationScan({ checkpoint }))
        const second = new PostgresP2TRCanonicalIndexStore(
          database,
          integrationStoreOptions()
        )
        const before = await readReadinessSnapshot(store)

        let releaseWriter!: () => void
        const writerGate = new Promise<void>((resolve) => {
          releaseWriter = resolve
        })
        let writerLocked!: () => void
        const writerReady = new Promise<void>((resolve) => {
          writerLocked = resolve
        })
        const writer = store.runInP2TRSignatureFraudWatchtowerTransaction(
          async () => {
            await store.addFrostWalletBindings([
              walletBinding("81".repeat(32), "wallet:race-one", 10),
            ])
            writerLocked()
            await writerGate
          }
        )
        await writerReady
        let claimantSettled = false
        const claimant = second
          .runInP2TRSignatureFraudWatchtowerTransaction(() =>
            second.lockP2TRReadinessSnapshot()
          )
          .then(
            (snapshot) => ({ snapshot }),
            (error: unknown) => ({ error })
          )
          .finally(() => {
            claimantSettled = true
          })
        await shortDelay()
        assert.equal(claimantSettled, false)
        releaseWriter()
        await writer
        const claimantResult = await claimant
        const afterWriter = await readReadinessSnapshot(store)
        assert.notEqual(afterWriter.root, before.root)
        if ("snapshot" in claimantResult) {
          assert.equal(claimantResult.snapshot?.root, afterWriter.root)
        } else {
          assert.equal(
            (claimantResult.error as { code?: string }).code,
            "40001"
          )
        }

        let releaseSnapshot!: () => void
        const snapshotGate = new Promise<void>((resolve) => {
          releaseSnapshot = resolve
        })
        let snapshotLocked!: () => void
        const snapshotReady = new Promise<void>((resolve) => {
          snapshotLocked = resolve
        })
        const holder = store.runInP2TRSignatureFraudWatchtowerTransaction(
          async () => {
            await store.lockP2TRReadinessSnapshot()
            snapshotLocked()
            await snapshotGate
          }
        )
        await snapshotReady
        let secondWriterSettled = false
        const blockedWriter = second
          .addFrostWalletBindings([
            walletBinding("82".repeat(32), "wallet:race-two", 11),
          ])
          .finally(() => {
            secondWriterSettled = true
          })
        await shortDelay()
        assert.equal(secondWriterSettled, false)
        releaseSnapshot()
        await holder
        await blockedWriter
        const final = await readReadinessSnapshot(store)
        assert.equal(final.projection.walletBindings, 2)
      })
    })

    it("keeps a streamed readiness generation immutable across reorg, restart, and acknowledgement", async () => {
      await withIntegrationStore(async ({ store, database }) => {
        const checkpoint = checkpointBlock("immutable-export")
        const originalTransaction = fundingTransaction(
          "immutable-export:original",
          [{ valueSats: 7, scriptPubKey: "51" }]
        )
        const originalBlock = block(
          1,
          bitcoinPoint(checkpoint),
          [originalTransaction],
          "immutable-export:block:original"
        )
        await store.applyBitcoinScan(
          canonicalMutationScan({ checkpoint, blocks: [originalBlock] })
        )

        const request = {
          schema: "tbtc-p2tr-readiness-export-request/v1" as const,
          requestNonce: "31".repeat(32),
          manifestHash: "32".repeat(32),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }
        const exported = await store.exportP2TRReadinessSnapshot(request)
        const originalFrames = await collectReadinessExportFrames(
          store,
          request.requestNonce
        )
        assert.ok(originalFrames.length > 0)
        assert.equal(
          originalFrames.every(
            ({ chunk }) =>
              chunk.bytes.byteLength > 0 && chunk.bytes.byteLength <= 65_536
          ),
          true
        )
        assert.equal(
          new Set(originalFrames.map(({ streamOrdinal }) => streamOrdinal))
            .size,
          exported.contentManifest.objectCount
        )
        assert.equal(
          originalFrames.reduce(
            (total, { chunk }) => total + chunk.bytes.byteLength,
            0
          ),
          exported.contentManifest.totalBytes
        )

        const replacementTransaction = fundingTransaction(
          "immutable-export:replacement",
          [{ valueSats: 8, scriptPubKey: "51" }]
        )
        const replacementBlock = block(
          1,
          bitcoinPoint(checkpoint),
          [replacementTransaction],
          "immutable-export:block:replacement"
        )
        await store.applyBitcoinScan(
          canonicalMutationScan({
            checkpoint,
            expected: bitcoinPoint(originalBlock),
            rollbackTo: bitcoinPoint(checkpoint),
            blocks: [replacementBlock],
          })
        )

        const restarted = new PostgresP2TRCanonicalIndexStore(
          database,
          integrationStoreOptions()
        )
        assert.deepEqual(
          await restarted.loadP2TRReadinessExportByNonce(request.requestNonce),
          exported
        )
        const restartedFrames = await collectReadinessExportFrames(
          restarted,
          request.requestNonce
        )
        assert.deepEqual(
          canonicalExportFrames(restartedFrames),
          canonicalExportFrames(originalFrames)
        )
        const firstFrame = restartedFrames[0]
        const resumedFrames = await collectReadinessExportFrames(
          restarted,
          request.requestNonce,
          {
            streamOrdinal: firstFrame.streamOrdinal,
            chunkIndex: firstFrame.chunk.index,
          }
        )
        assert.deepEqual(
          canonicalExportFrames(resumedFrames),
          canonicalExportFrames(restartedFrames.slice(1))
        )

        const acknowledgementBase = {
          schema: "tbtc-p2tr-readiness-export-acknowledgement/v1" as const,
          requestNonce: request.requestNonce,
          requestDigest: exported.requestDigest,
          exportFence: exported.exportFence,
          snapshotRoot: exported.snapshotRoot,
          resultDigest: exported.resultDigest,
          consumerID: "integration-auditor",
          auditManifestRoot: exported.contentManifest.auditManifestRoot,
          finalStreamDigest: exported.contentManifest.finalStreamDigest,
          streamedObjectCount: exported.contentManifest.objectCount,
          streamedBytes: exported.contentManifest.totalBytes,
          consumerSigningKeyID: "integration-consumer-key",
        }
        const acknowledgementPayloadDigest =
          readinessExportAcknowledgementPayloadDigest({
            ...acknowledgementBase,
            consumerSignature: "",
          })
        const acknowledgement: P2TRReadinessExportAcknowledgement = {
          ...acknowledgementBase,
          consumerSignaturePayloadDigest: acknowledgementPayloadDigest,
          consumerSignature: integrationConsumerSignature(
            acknowledgementPayloadDigest
          ),
        }
        const tamperedBase = {
          ...acknowledgementBase,
          resultDigest: "ff".repeat(32),
        }
        const tamperedPayloadDigest =
          readinessExportAcknowledgementPayloadDigest({
            ...tamperedBase,
            consumerSignature: "",
          })
        await assert.rejects(
          restarted.acknowledgeP2TRReadinessExport({
            ...tamperedBase,
            consumerSignaturePayloadDigest: tamperedPayloadDigest,
            consumerSignature: integrationConsumerSignature(
              tamperedPayloadDigest
            ),
          }),
          /acknowledgement handle is stale/
        )
        await assert.rejects(
          restarted.acknowledgeP2TRReadinessExport({
            ...acknowledgement,
            consumerSignature: "ff".repeat(64),
          }),
          /consumer signature is unauthorized/
        )
        for (const identityOverride of [
          { consumerID: "unknown-consumer" },
          { consumerSigningKeyID: "unknown-key" },
        ]) {
          const unknownBase = {
            ...acknowledgementBase,
            ...identityOverride,
          }
          const unknownPayloadDigest =
            readinessExportAcknowledgementPayloadDigest({
              ...unknownBase,
              consumerSignature: "",
            })
          await assert.rejects(
            restarted.acknowledgeP2TRReadinessExport({
              ...unknownBase,
              consumerSignaturePayloadDigest: unknownPayloadDigest,
              consumerSignature:
                integrationConsumerSignature(unknownPayloadDigest),
            }),
            /consumer signature is unauthorized/
          )
        }
        await assert.rejects(
          restarted.acknowledgeP2TRReadinessExport({
            ...acknowledgement,
            requestNonce: "ff".repeat(32),
          }),
          /acknowledgement handle is stale/
        )
        const staleFenceBase = {
          ...acknowledgementBase,
          exportFence: acknowledgement.exportFence + 1,
        }
        const staleFencePayloadDigest =
          readinessExportAcknowledgementPayloadDigest({
            ...staleFenceBase,
            consumerSignature: "",
          })
        await assert.rejects(
          restarted.acknowledgeP2TRReadinessExport({
            ...staleFenceBase,
            consumerSignaturePayloadDigest: staleFencePayloadDigest,
            consumerSignature: integrationConsumerSignature(
              staleFencePayloadDigest
            ),
          }),
          /acknowledgement handle is stale/
        )
        const unavailableVerifier = new PostgresP2TRCanonicalIndexStore(
          database,
          {
            ...integrationStoreOptions(),
            readinessExportAcknowledgementVerifier: {
              async verify(): Promise<boolean> {
                throw new Error("integration verifier unavailable")
              },
            },
          }
        )
        await assert.rejects(
          unavailableVerifier.acknowledgeP2TRReadinessExport(acknowledgement),
          /integration verifier unavailable/
        )
        await restarted.acknowledgeP2TRReadinessExport(acknowledgement)
        await restarted.acknowledgeP2TRReadinessExport(acknowledgement)

        const wrongDomain = new PostgresP2TRCanonicalIndexStore(database, {
          ...integrationStoreOptions(),
          authorizationDomain: {
            ...integrationStoreOptions().authorizationDomain,
            chainID: "31338",
          },
        })
        await assert.rejects(
          wrongDomain.loadP2TRReadinessExportByNonce(request.requestNonce),
          /authorization domain mismatch/i
        )
        const wrongSource = new PostgresP2TRCanonicalIndexStore(database, {
          ...integrationStoreOptions(),
          sourceIdentity: {
            ...integrationStoreOptions().sourceIdentity,
            operatorID: "other-operator",
          },
        })
        await assert.rejects(
          wrongSource.loadP2TRReadinessExportByNonce(request.requestNonce),
          /source identity mismatch/i
        )
      })
    })

    it(
      "matches Bitcoin Core MuHash3072 and keeps GUC/bulk rollback commitments stable",
      { timeout: 90_000 },
      async (testContext) => {
        await withIntegrationStore(async ({ store, database }) => {
          const vectors = await database.query<{
            chacha_zero: string
            empty_muhash: string
            core_muhash: string
            reordered_muhash: string
            cancelled_muhash: string
            independent_element_le: string
            independent_singleton: string
            inverse_identity: string
          }>(
            `WITH elements AS (
               SELECT p2tr_muhash_data_element(
                        decode(repeat('00', 32), 'hex')
                      ) AS zero_element,
                      p2tr_muhash_data_element(
                        decode('01' || repeat('00', 31), 'hex')
                      ) AS one_element,
                      p2tr_muhash_data_element(
                        decode('02' || repeat('00', 31), 'hex')
                      ) AS two_element
             )
             SELECT encode(p2tr_chacha20_block(
                      decode(repeat('00', 32), 'hex'), 0
                    ), 'hex') AS chacha_zero,
                    encode(p2tr_muhash_finalize(1, 1), 'hex')
                      AS empty_muhash,
                    encode(p2tr_muhash_finalize(
                      p2tr_muhash_multiply(
                        p2tr_muhash_multiply(1, zero_element),
                        one_element
                      ),
                      p2tr_muhash_multiply(1, two_element)
                    ), 'hex') AS core_muhash,
                    encode(p2tr_muhash_finalize(
                      p2tr_muhash_multiply(
                        p2tr_muhash_multiply(1, one_element),
                        zero_element
                      ),
                      p2tr_muhash_multiply(1, two_element)
                    ), 'hex') AS reordered_muhash,
                    encode(p2tr_muhash_finalize(
                      p2tr_muhash_multiply(1, zero_element),
                      p2tr_muhash_multiply(1, zero_element)
                    ), 'hex') AS cancelled_muhash,
                    encode(p2tr_muhash_to_little_endian(
                      p2tr_muhash_data_element(decode('000102', 'hex'))
                    ), 'hex') AS independent_element_le,
                    encode(p2tr_muhash_finalize(
                      p2tr_muhash_multiply(
                        1,
                        p2tr_muhash_data_element(decode('000102', 'hex'))
                      ),
                      1
                    ), 'hex') AS independent_singleton,
                    mod(
                      p2tr_muhash_data_element(decode('000102', 'hex')) *
                      p2tr_muhash_inverse(
                        p2tr_muhash_data_element(decode('000102', 'hex'))
                      ),
                      p2tr_muhash_modulus()
                    )::text AS inverse_identity
               FROM elements`
          )
          assert.equal(
            vectors.rows[0].chacha_zero,
            "76b8e0ada0f13d90405d6ae55386bd28" +
              "bdd219b8a08ded1aa836efcc8b770dc7" +
              "da41597c5157488d7724e03fb8d84a37" +
              "6a43b8f41518a11cc387b669b2ee6586"
          )
          assert.equal(
            vectors.rows[0].empty_muhash,
            "c85525462fdcf30a2c18d6f4b92923000974355c2477f59594d2c205a1d25add"
          )
          assert.equal(
            vectors.rows[0].core_muhash,
            "63587d602a00105f62d2683610fffc82340de446664a02da2ad3cb00b112d310"
          )
          assert.equal(
            vectors.rows[0].reordered_muhash,
            vectors.rows[0].core_muhash
          )
          assert.equal(
            vectors.rows[0].cancelled_muhash,
            vectors.rows[0].empty_muhash
          )
          assert.equal(
            vectors.rows[0].independent_element_le.slice(0, 24),
            "6bf163fd75192b81a78cb20c"
          )
          assert.equal(
            vectors.rows[0].independent_singleton,
            "26dacfa137ec2bed5e53d220440d8334b9618e944289c0ef1dc87882b6e9589d"
          )
          assert.equal(vectors.rows[0].inverse_identity, "1")
          for (const [table, index] of [
            [
              "p2tr_bitcoin_candidates",
              "p2tr_bitcoin_candidates_generation_idx",
            ],
            [
              "p2tr_invalidated_candidate_provenance",
              "p2tr_invalidated_candidate_generation_idx",
            ],
          ] as const) {
            const plan = await database.query<{ "QUERY PLAN": string }>(
              `EXPLAIN SELECT MAX(provenance_generation) FROM ${table}`
            )
            assert.match(
              plan.rows.map((row) => row["QUERY PLAN"]).join("\n"),
              new RegExp(index)
            )
          }

          const checkpoint = checkpointBlock("muhash")
          await store.applyBitcoinScan(canonicalMutationScan({ checkpoint }))
          const empty = await readReadinessSnapshot(store)
          const walletID = "91".repeat(32)
          await database.query(
            `BEGIN;
             SET LOCAL bytea_output = 'escape';
             SET LOCAL TimeZone = 'Pacific/Honolulu';
             SET LOCAL DateStyle = 'SQL, DMY';
             INSERT INTO p2tr_frost_wallet_bindings
               (wallet_id, source_event_id, ethereum_block_number,
                ethereum_block_hash)
             VALUES (decode('${walletID}', 'hex'), 'wallet:guc', 7,
                     decode('${"92".repeat(32)}', 'hex'));
             COMMIT;`
          )
          const firstGuc = await readReadinessSnapshot(store)
          await database.query(
            `BEGIN;
             SET LOCAL bytea_output = 'hex';
             SET LOCAL TimeZone = 'Asia/Tokyo';
             SET LOCAL DateStyle = 'German, DMY';
             DELETE FROM p2tr_frost_wallet_bindings
              WHERE source_event_id = 'wallet:guc';
             COMMIT;`
          )
          const afterGucDelete = await readReadinessSnapshot(store)
          assert.equal(
            afterGucDelete.projection.semanticCommitment,
            empty.projection.semanticCommitment
          )
          assert.equal(
            afterGucDelete.projection.commitment,
            empty.projection.commitment
          )
          await database.query(
            `BEGIN;
             SET LOCAL bytea_output = 'hex';
             SET LOCAL TimeZone = 'UTC';
             SET LOCAL DateStyle = 'ISO, MDY';
             INSERT INTO p2tr_frost_wallet_bindings
               (wallet_id, source_event_id, ethereum_block_number,
                ethereum_block_hash)
             VALUES (decode('${walletID}', 'hex'), 'wallet:guc', 7,
                     decode('${"92".repeat(32)}', 'hex'));
             COMMIT;`
          )
          const secondGuc = await readReadinessSnapshot(store)
          assert.equal(secondGuc.semanticRoot, firstGuc.semanticRoot)
          assert.equal(
            secondGuc.projection.commitment,
            firstGuc.projection.commitment
          )
          await database.query(
            `DELETE FROM p2tr_frost_wallet_bindings
              WHERE source_event_id = 'wallet:guc'`
          )

          await database.query(
            `BEGIN;
             -- Production wallet lifecycle ingestion uses bounded individual
             -- statements. This synthetic one-statement seed is allowed more
             -- time; the rollback below exercises the real 30s store bound.
             SET LOCAL statement_timeout = '120000ms';
             INSERT INTO p2tr_frost_wallet_bindings
               (wallet_id, source_event_id, ethereum_block_number,
                ethereum_block_hash)
             SELECT decode(lpad(to_hex(wallet_index), 64, '0'), 'hex'),
                    'wallet:bulk:' || wallet_index::text,
                    100,
                    decode('${"93".repeat(32)}', 'hex')
               FROM generate_series(0, 9999) wallet_index;
             COMMIT;`
          )
          const readinessStartedAt = performance.now()
          const beforeBulkRollback = await readReadinessSnapshot(store)
          const readinessMilliseconds = performance.now() - readinessStartedAt
          assert.equal(beforeBulkRollback.projection.walletBindings, 10_000)
          assert.ok(
            readinessMilliseconds < 5_000,
            `10,000-wallet readiness took ${readinessMilliseconds}ms`
          )
          const rollbackStartedAt = performance.now()
          await store.rollbackEthereumEvidenceTo({
            blockNumber: 0,
            blockHash: "00".repeat(32),
          })
          const rollbackMilliseconds = performance.now() - rollbackStartedAt
          assert.ok(
            rollbackMilliseconds < 30_000,
            `10,000-wallet rollback took ${rollbackMilliseconds}ms`
          )
          testContext.diagnostic(
            `10,000-wallet readiness ${readinessMilliseconds.toFixed(
              1
            )}ms; rollback ${rollbackMilliseconds.toFixed(1)}ms`
          )
          const afterBulkRollback = await readReadinessSnapshot(store)
          assert.equal(afterBulkRollback.projection.walletBindings, 0)
          assert.equal(
            afterBulkRollback.projection.semanticCommitment,
            empty.projection.semanticCommitment
          )
          assert.equal(
            afterBulkRollback.projection.commitment,
            empty.projection.commitment
          )
        })
      }
    )
  }
)

type IntegrationPool = P2TRPostgresPool & {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>>
  end(): Promise<void>
}

const integrationStoreOptions = (
  overrides: Partial<
    ConstructorParameters<typeof PostgresP2TRCanonicalIndexStore>[1]
  > = {}
) => ({
  storeID: "integration-store",
  maxJournalBlocks: 100,
  maxJournalTransactions: 1_000,
  maxJournalInputs: 10_000,
  maxJournalOutputs: 10_000,
  maxWalletBindings: 10_000,
  maxPendingDepositReveals: 100,
  maxUnmatchedProofs: 100,
  maxProofMutationBatchSize: 20,
  maxProofPageSize: 20,
  maxProofPayloadBytes: 4_096,
  authorizationDomain: {
    chainID: "31337",
    bridgeAddress: "12".repeat(20),
  },
  sourceIdentity: {
    clusterID: "integration-cluster",
    operatorID: "integration-operator",
    bitcoinIdentityDigest: "21".repeat(32),
    ethereumIdentityDigest: "22".repeat(32),
  },
  readinessExportSigner: {
    keyID: "integration-readiness-signer",
    async signPayloadDigest(payloadDigest: string): Promise<string> {
      return createHash("sha256")
        .update("integration-readiness-signature-v1", "utf8")
        .update(Buffer.from(payloadDigest, "hex"))
        .digest("hex")
    },
  },
  readinessExportAcknowledgementVerifier: {
    async verify({
      consumerID,
      signingKeyID,
      payloadDigest,
      signature,
    }: P2TRReadinessExportAcknowledgementVerification): Promise<boolean> {
      return (
        consumerID === "integration-auditor" &&
        signingKeyID === "integration-consumer-key" &&
        signature === integrationConsumerSignature(payloadDigest)
      )
    },
  },
  ...overrides,
})

const withIntegrationStore = async (
  operation: (context: {
    store: PostgresP2TRCanonicalIndexStore
    database: IntegrationPool
  }) => Promise<void>,
  overrides: Partial<
    ConstructorParameters<typeof PostgresP2TRCanonicalIndexStore>[1]
  > = {}
): Promise<void> => {
  if (postgresURL === undefined) throw new Error("PostgreSQL URL is absent")
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
      new URL("../migrations/001_p2tr_canonical_index.sql", import.meta.url),
      "utf8"
    )
    await database.query(`BEGIN;\n${migration}\nCOMMIT;`)
    await operation({
      store: new PostgresP2TRCanonicalIndexStore(
        database,
        integrationStoreOptions(overrides)
      ),
      database,
    })
  } finally {
    await database?.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
}

const canonicalMutationScan = ({
  checkpoint,
  expected,
  rollbackTo = expected ?? bitcoinPoint(checkpoint),
  blocks = [],
  testOnlyAcknowledgedCandidates = [],
  candidateObservationAcknowledgement,
  configurationFingerprint = "01".repeat(32),
  trustDomainID = "bitcoin-core-integration",
}: {
  checkpoint: P2TRCanonicalBitcoinBlock
  expected?: { height: number; hash: string }
  rollbackTo?: { height: number; hash: string }
  blocks?: P2TRCanonicalBitcoinBlock[]
  testOnlyAcknowledgedCandidates?: P2TRCandidateProvenanceIdentity[]
  candidateObservationAcknowledgement?: P2TRCanonicalBitcoinScan["candidateObservationAcknowledgement"]
  configurationFingerprint?: string
  trustDomainID?: string
}): P2TRCanonicalBitcoinScan => {
  const checkpointPoint = bitcoinPoint(checkpoint)
  const nextCursor =
    blocks.length === 0
      ? rollbackTo
      : {
          height: blocks[blocks.length - 1].height,
          hash: blocks[blocks.length - 1].hash,
        }
  return {
    configurationFingerprint,
    network: "regtest",
    trustDomainID,
    checkpoint: checkpointPoint,
    checkpointBlock: checkpoint,
    ...(expected === undefined ? {} : { expectedCursor: expected }),
    rollbackTo,
    nextCursor,
    sampledFinalizedHead: nextCursor,
    complete: true,
    blocks,
    trackedOutpoints: [],
    trackedOutpointSpends: [],
    candidates: [],
    ...(candidateObservationAcknowledgement === undefined
      ? {}
      : { candidateObservationAcknowledgement }),
    ...(testOnlyAcknowledgedCandidates.length === 0
      ? {}
      : { testOnlyAcknowledgedCandidates }),
    orphanedCandidates: [],
  }
}

const block = (
  height: number,
  parent: { height: number; hash: string },
  transactions: P2TRCanonicalBitcoinBlock["transactions"],
  tag: string
): P2TRCanonicalBitcoinBlock => {
  let projectedTransactions = [...transactions]
  const wireTransactions = projectedTransactions.map(({ rawTransactionHex }) =>
    Transaction.fromHex(rawTransactionHex)
  )
  if (!wireTransactions[0]?.isCoinbase()) {
    const coinbase = blockCoinbaseTransaction(tag, wireTransactions)
    projectedTransactions = [coinbase, ...projectedTransactions]
    wireTransactions.unshift(Transaction.fromHex(coinbase.rawTransactionHex))
  }
  const wireBlock = new Block()
  wireBlock.version = 4
  wireBlock.prevHash = Buffer.from(parent.hash, "hex").reverse()
  wireBlock.merkleRoot = Block.calculateMerkleRoot(wireTransactions)
  wireBlock.timestamp =
    1_700_000_000 +
    (createHash("sha256").update(tag, "utf8").digest().readUInt32LE(0) %
      1_000_000)
  wireBlock.bits = 0x207fffff
  wireBlock.transactions = wireTransactions
  const initialNonce = createHash("sha256")
    .update(`nonce:${tag}`, "utf8")
    .digest()
    .readUInt32LE(0)
  for (let offset = 0; offset <= 0xffffffff; offset++) {
    wireBlock.nonce = (initialNonce + offset) >>> 0
    if (wireBlock.checkProofOfWork()) {
      const rawBlockHex = wireBlock.toHex()
      return {
        height,
        hash: wireBlock.getId(),
        parentHash: parent.hash,
        header80Hex: rawBlockHex.slice(0, 160),
        rawBlockHex,
        transactions: projectedTransactions,
      }
    }
  }
  throw new Error(`Could not mine deterministic block fixture ${tag}`)
}

const blockCoinbaseTransaction = (
  tag: string,
  followingTransactions: Transaction[]
): P2TRCanonicalBitcoinBlock["transactions"][number] => {
  const transaction = new Transaction()
  transaction.version = 2
  transaction.addInput(
    Buffer.alloc(32),
    0xffffffff,
    0xffffffff,
    createHash("sha256")
      .update(`block-coinbase:${tag}`, "utf8")
      .digest()
      .subarray(0, 16)
  )
  transaction.addOutput(Buffer.from("51", "hex"), 0)
  if (
    followingTransactions.some((candidate) =>
      candidate.ins.some(({ witness }) => witness.length > 0)
    )
  ) {
    transaction.setWitness(0, [Buffer.alloc(32)])
    const witnessCommitment = Block.calculateMerkleRoot(
      [transaction, ...followingTransactions],
      true
    )
    transaction.addOutput(
      Buffer.concat([Buffer.from("6a24aa21a9ed", "hex"), witnessCommitment]),
      0
    )
  }
  const txid = transaction.getId()
  return {
    txid,
    wtxid: witnessTransactionID(transaction),
    rawTransactionHex: transaction.toHex(),
    coinbase: true,
    inputs: [
      {
        txid: "00".repeat(32),
        vout: 0xffffffff,
        spendingTxid: txid,
        inputIndex: 0,
      },
    ],
    outputs: transaction.outs.map((output, vout) => ({
      txid,
      vout,
      valueSats: output.value,
      scriptPubKey: output.script.toString("hex"),
    })),
  }
}

const checkpointBlock = (tag: string, height = 0): P2TRCanonicalBitcoinBlock =>
  block(
    height,
    { height: height - 1, hash: "00".repeat(32) },
    [
      fundingTransaction(`checkpoint:${tag}`, [
        { valueSats: 0, scriptPubKey: "51" },
      ]),
    ],
    `checkpoint:${tag}`
  )

const bitcoinPoint = (
  value: Pick<P2TRCanonicalBitcoinBlock, "height" | "hash">
): { height: number; hash: string } => ({
  height: value.height,
  hash: value.hash,
})

const fundingTransaction = (
  tag: string,
  outputs: Array<{ valueSats: number; scriptPubKey: string }>
): P2TRCanonicalBitcoinBlock["transactions"][number] => {
  const transaction = new Transaction()
  transaction.version = 2
  transaction.addInput(
    Buffer.alloc(32),
    0xffffffff,
    0xffffffff,
    createHash("sha256")
      .update(`coinbase:${tag}`, "utf8")
      .digest()
      .subarray(0, 16)
  )
  outputs.forEach(({ valueSats, scriptPubKey }) =>
    transaction.addOutput(Buffer.from(scriptPubKey, "hex"), valueSats)
  )
  const txid = transaction.getId()
  return {
    txid,
    wtxid: witnessTransactionID(transaction),
    rawTransactionHex: transaction.toHex(),
    coinbase: true,
    inputs: [
      {
        txid: "00".repeat(32),
        vout: 0xffffffff,
        spendingTxid: txid,
        inputIndex: 0,
      },
    ],
    outputs: outputs.map((output, vout) => ({ txid, vout, ...output })),
  }
}

const spendingTransaction = (
  tag: string,
  prevouts: Array<{
    txid: string
    vout: number
    valueSats: number
    scriptPubKey: string
  }>,
  outputScriptPubKey = "51"
): P2TRCanonicalBitcoinBlock["transactions"][number] => {
  const transaction = new Transaction()
  transaction.version = 2
  prevouts.forEach((prevout) =>
    transaction.addInput(
      Buffer.from(prevout.txid, "hex").reverse(),
      prevout.vout,
      0xfffffffd
    )
  )
  const valueSats = Math.max(
    0,
    prevouts.reduce((total, prevout) => total + prevout.valueSats, 0) - 1
  )
  transaction.addOutput(Buffer.from(outputScriptPubKey, "hex"), valueSats)
  const witnessTag = createHash("sha256")
    .update(`witness:${tag}`, "utf8")
    .digest()
  prevouts.forEach((_, inputIndex) =>
    transaction.setWitness(inputIndex, [
      Buffer.concat([witnessTag, witnessTag]).subarray(0, 64),
    ])
  )
  const txid = transaction.getId()
  const wtxid = witnessTransactionID(transaction)
  return {
    txid,
    wtxid,
    rawTransactionHex: transaction.toHex(),
    coinbase: false,
    inputs: prevouts.map((prevout, inputIndex) => ({
      txid: prevout.txid,
      vout: prevout.vout,
      spendingTxid: txid,
      inputIndex,
      authenticatedPrevout: prevout,
    })),
    outputs: [{ txid, vout: 0, valueSats, scriptPubKey: outputScriptPubKey }],
  }
}

const witnessTransactionID = (transaction: Transaction): string =>
  createHash("sha256")
    .update(createHash("sha256").update(transaction.toBuffer()).digest())
    .digest()
    .reverse()
    .toString("hex")

const candidateIdentity = (
  candidate: P2TRCanonicalBitcoinScan["candidates"][number]
): P2TRCandidateProvenanceIdentity => ({
  blockHash: candidate.block.hash,
  txid: candidate.txid,
  wtxid: candidate.wtxid,
  provenanceGeneration: candidate.provenanceGeneration!,
  provenanceFingerprint: candidate.provenanceFingerprint!,
})

const compactObservationAcknowledgement = (
  page: P2TRCandidateObservationPage,
  after?: string
): NonNullable<
  P2TRCanonicalBitcoinScan["candidateObservationAcknowledgement"]
> => {
  if (page.state !== "ready") {
    throw new Error("Candidate observation generation is not ready")
  }
  return {
    schema: "tbtc-p2tr-candidate-observation-page-acknowledgement/v1",
    generation: page.generation,
    ...(after === undefined ? {} : { after }),
    ...(page.nextAfter === undefined ? {} : { nextAfter: page.nextAfter }),
    complete: page.complete,
    observations: page.observations.map((observation) => ({
      blockHash: observation.blockHash,
      txid: observation.txid,
      wtxid: observation.wtxid,
      inputIndex: observation.inputIndex,
      challengeIdentity: observation.challengeIdentity,
      provenanceGeneration: observation.provenanceGeneration,
      provenanceFingerprint: observation.provenanceFingerprint,
    })),
  }
}

const walletBinding = (
  walletID: string,
  sourceEventID: string,
  blockNumber: number
) => ({
  walletID,
  sourceEventID,
  ethereum: {
    blockNumber,
    blockHash: "aa".repeat(32),
  },
})

const depositBinding = (
  txid: string,
  vout: number,
  walletID: string,
  outputKey: string,
  sourceEventID: string,
  blockNumber: number
) => ({
  txid,
  vout,
  walletID,
  outputKey,
  sourceEventID,
  ethereum: {
    blockNumber,
    blockHash: "bb".repeat(32),
  },
})

const readReadinessSnapshot = async (
  store: PostgresP2TRCanonicalIndexStore
) => {
  let snapshot: Awaited<
    ReturnType<PostgresP2TRCanonicalIndexStore["lockP2TRReadinessSnapshot"]>
  >
  await store.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
    snapshot = await store.lockP2TRReadinessSnapshot()
  })
  if (snapshot === undefined) throw new Error("Readiness snapshot is absent")
  return snapshot
}

const collectReadinessExportFrames = async (
  store: PostgresP2TRCanonicalIndexStore,
  requestNonce: string,
  after?: { streamOrdinal: number; chunkIndex: number }
): Promise<P2TRReadinessExportStreamFrame[]> => {
  const frames: P2TRReadinessExportStreamFrame[] = []
  for await (const frame of store.streamP2TRReadinessExportChunks(
    requestNonce,
    after
  )) {
    frames.push(frame)
  }
  return frames
}

const canonicalExportFrames = (
  frames: P2TRReadinessExportStreamFrame[]
): unknown[] =>
  frames.map((frame) => ({
    ...frame,
    chunk: {
      ...frame.chunk,
      bytes: Buffer.from(frame.chunk.bytes).toString("hex"),
    },
  }))

const readinessExportAcknowledgementPayloadDigest = (
  value: Omit<
    P2TRReadinessExportAcknowledgement,
    "consumerSignaturePayloadDigest"
  >
): string =>
  createHash("sha256")
    .update(
      `tbtc-p2tr-readiness-acknowledgement-signature-v1\x1f${value.consumerID}\x1f${value.consumerSigningKeyID}`,
      "utf8"
    )
    .update(int64Buffer(value.exportFence))
    .update(Buffer.from(value.requestDigest, "hex"))
    .update(Buffer.from(value.snapshotRoot, "hex"))
    .update(Buffer.from(value.resultDigest, "hex"))
    .update(Buffer.from(value.auditManifestRoot, "hex"))
    .update(Buffer.from(value.finalStreamDigest, "hex"))
    .update(int64Buffer(value.streamedObjectCount))
    .update(int64Buffer(value.streamedBytes))
    .digest("hex")

const integrationConsumerSignature = (payloadDigest: string): string =>
  createHash("sha512")
    .update("integration-readiness-consumer-signature-v1", "utf8")
    .update(Buffer.from(payloadDigest, "hex"))
    .digest("hex")

const int64Buffer = (value: number): Buffer => {
  const result = Buffer.alloc(8)
  result.writeBigInt64BE(BigInt(value))
  return result
}

const shortDelay = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 75))
