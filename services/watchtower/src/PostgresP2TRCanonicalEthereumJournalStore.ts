import { createHash } from "node:crypto"
import type {
  P2TRCanonicalEthereumCursor,
  P2TRCanonicalEthereumBlockCoverage,
  P2TRCanonicalEthereumEvent,
  P2TRCanonicalEthereumJournalStore,
  P2TRCanonicalEthereumReadinessSnapshot,
  P2TRCanonicalEthereumScan,
} from "./P2TRCanonicalEthereumJournal.js"
import {
  p2trCanonicalEthereumCheckpointAnchorCoverage,
  p2trCanonicalEthereumRequiredEventRecord,
} from "./P2TRCanonicalEthereumJournal.js"
import {
  assertP2TRPostgresTransactionSession,
  type P2TRPostgresTransactionSession,
} from "./PostgresP2TRCanonicalIndexStore.js"
import {
  accumulateP2TRRequiredEventHistoryBlock,
  initialP2TRRequiredEventHistoryRoot,
  type P2TREthereumHistoryAccumulatorState,
} from "./P2TRProductionActivation.js"

export type P2TRCanonicalEthereumPostgresQueryResult<Row> = {
  rows: Row[]
  rowCount: number | null
}

/** Must be the session supplied by the canonical index transaction owner. */
export type P2TRCanonicalEthereumPostgresSession =
  P2TRPostgresTransactionSession

export type PostgresP2TRCanonicalEthereumJournalStoreOptions = {
  storeID: string
  maxBlocksPerScan: number
  maxEventsPerScan: number
  maxEventPageSize: number
  maxTotalRawLogBytes: number
  maxTotalDecodedPayloadBytes: number
}

type CursorRow = {
  store_id: string
  chain_id: string | number
  configuration_fingerprint: string
  descriptor_set_hash: string
  scan_start_block: string | number
  checkpoint_block_number: string | number
  checkpoint_block_hash: string
  current_block_number: string | number
  current_block_hash: string
}

type EventRow = {
  event_id: string
  event_kind: P2TRCanonicalEthereumEvent["kind"]
  decoder_schema_id: string
  decoder_code_hash: string
  block_number: string | number
  block_hash: string
  transaction_hash: string
  transaction_index: string | number
  log_index: string | number
  emitter: string
  data: string
  topics: unknown
  decoded_payload: unknown
}

type ReadinessRow = CursorRow & {
  generation: string | number
  journal_block_count: string | number
  journal_event_count: string | number
  coverage_block_count: string | number
  coverage_transaction_count: string | number
  coverage_receipt_count: string | number
  coverage_log_count: string | number
  history_root: string
  required_event_count: string | number
}

const REQUIRED_SCHEMA_VERSION = 1

/**
 * PostgreSQL journal adapter deliberately accepts only a transaction-bound
 * query session. Construct it through
 * `PostgresP2TRCanonicalIndexStore.createP2TRSignatureFraudWatchtowerTransactionalAdapter`
 * so Ethereum rollback, derived evidence, challenge records, cursors, and
 * outbox enqueue commit or abort together.
 */
export class PostgresP2TRCanonicalEthereumJournalStore
  implements P2TRCanonicalEthereumJournalStore
{
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  private readonly maxEventsPerScan: number
  private readonly maxEventPageSize: number
  private readonly maxBlocksPerScan: number
  private readonly maxTotalRawLogBytes: number
  private readonly maxTotalDecodedPayloadBytes: number

  constructor(
    private readonly session: P2TRCanonicalEthereumPostgresSession,
    options: PostgresP2TRCanonicalEthereumJournalStoreOptions
  ) {
    assertP2TRPostgresTransactionSession(session)
    this.p2trSignatureFraudWatchtowerTransactionalStoreID = boundedString(
      options.storeID,
      255,
      "PostgreSQL Ethereum journal store ID"
    )
    this.maxEventsPerScan = positiveInteger(
      options.maxEventsPerScan,
      "PostgreSQL Ethereum event mutation bound"
    )
    this.maxEventPageSize = positiveInteger(
      options.maxEventPageSize,
      "PostgreSQL Ethereum event page bound"
    )
    this.maxBlocksPerScan = positiveInteger(
      options.maxBlocksPerScan,
      "PostgreSQL Ethereum block mutation bound"
    )
    this.maxTotalRawLogBytes = positiveInteger(
      options.maxTotalRawLogBytes,
      "PostgreSQL Ethereum raw-log mutation byte bound"
    )
    this.maxTotalDecodedPayloadBytes = positiveInteger(
      options.maxTotalDecodedPayloadBytes,
      "PostgreSQL Ethereum decoded-payload mutation byte bound"
    )
  }

  async loadCanonicalEthereumCursor(): Promise<
    P2TRCanonicalEthereumCursor | undefined
  > {
    await this.assertSchema()
    const result = await this.session.query<CursorRow>(CURSOR_SELECT)
    if (result.rows.length === 0) return undefined
    if (result.rows.length !== 1) {
      throw new Error("PostgreSQL Ethereum cursor singleton is inconsistent")
    }
    return cursorFromRow(result.rows[0])
  }

  async loadCanonicalEthereumBlockHash(
    blockNumber: number
  ): Promise<string | undefined> {
    nonNegativeInteger(blockNumber, "Ethereum journal block number")
    const result = await this.session.query<{ block_hash: string }>(
      `SELECT encode(block_hash, 'hex') AS block_hash
         FROM p2tr_ethereum_blocks
        WHERE block_number = $1`,
      [blockNumber]
    )
    if (result.rows.length > 1) {
      throw new Error("PostgreSQL Ethereum block-number uniqueness is violated")
    }
    return result.rows[0] === undefined
      ? undefined
      : bytes32(result.rows[0].block_hash, "stored Ethereum block hash")
  }

  async lockCanonicalEthereumReadinessSnapshot(): Promise<
    P2TRCanonicalEthereumReadinessSnapshot | undefined
  > {
    await this.assertSchema()
    await this.session.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('p2tr-readiness-snapshot', 0))"
    )
    const result = await this.session.query<ReadinessRow>(
      `SELECT cursor.store_id,
              cursor.chain_id,
              encode(cursor.configuration_fingerprint, 'hex')
                AS configuration_fingerprint,
              encode(cursor.descriptor_set_hash, 'hex') AS descriptor_set_hash,
              cursor.scan_start_block,
              cursor.checkpoint_block_number,
              encode(cursor.checkpoint_block_hash, 'hex')
                AS checkpoint_block_hash,
              cursor.current_block_number,
              encode(cursor.current_block_hash, 'hex') AS current_block_hash,
              cursor.generation,
              cursor.journal_block_count,
              cursor.journal_event_count,
              cursor.coverage_block_count,
              cursor.coverage_transaction_count,
              cursor.coverage_receipt_count,
              cursor.coverage_log_count,
              encode(block.history_root, 'hex') AS history_root,
              block.required_event_count
         FROM p2tr_ethereum_cursor cursor
         JOIN p2tr_ethereum_blocks block
           ON block.block_number = cursor.current_block_number
          AND block.block_hash = cursor.current_block_hash
        WHERE cursor.singleton = true
        FOR SHARE OF cursor, block`
    )
    if (result.rows.length === 0) return undefined
    if (result.rows.length !== 1) {
      throw new Error("PostgreSQL Ethereum readiness singleton is inconsistent")
    }
    return readinessSnapshotFromRow(result.rows[0])
  }

  async applyCanonicalEthereumScan(
    scan: P2TRCanonicalEthereumScan
  ): Promise<void> {
    validateScan(scan, {
      maxBlocks: this.maxBlocksPerScan,
      maxEvents: this.maxEventsPerScan,
      maxRawLogBytes: this.maxTotalRawLogBytes,
      maxDecodedPayloadBytes: this.maxTotalDecodedPayloadBytes,
    })
    await this.assertSchema()
    await this.session.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('p2tr-readiness-snapshot', 0))"
    )
    const locked = await this.session.query<CursorRow>(
      `${CURSOR_SELECT} FOR UPDATE`
    )
    if (locked.rows.length > 1) {
      throw new Error("PostgreSQL Ethereum cursor singleton is inconsistent")
    }
    const durable =
      locked.rows[0] === undefined ? undefined : cursorFromRow(locked.rows[0])
    if (canonicalJSON(durable) !== canonicalJSON(scan.expectedCursor)) {
      throw new Error("PostgreSQL Ethereum cursor compare-and-swap failed")
    }
    if (
      scan.storeID !== this.p2trSignatureFraudWatchtowerTransactionalStoreID
    ) {
      throw new Error("PostgreSQL Ethereum scan belongs to another store")
    }

    let history: P2TREthereumHistoryAccumulatorState
    if (durable === undefined) {
      if (
        scan.retainedBlock.blockNumber !== scan.checkpoint.blockNumber ||
        scan.retainedBlock.blockHash !== scan.checkpoint.blockHash
      ) {
        throw new Error(
          "PostgreSQL Ethereum journal initialization must retain the checkpoint"
        )
      }
      history = initialP2TRRequiredEventHistoryRoot(
        scan.chainID,
        scan.checkpoint
      )
      await this.insertBlock(
        scan.retainedBlock,
        history,
        p2trCanonicalEthereumCheckpointAnchorCoverage(scan.retainedBlock)
      )
      await this.session.query(
        `INSERT INTO p2tr_ethereum_cursor
          (singleton, store_id, chain_id, configuration_fingerprint,
            descriptor_set_hash, scan_start_block,
            checkpoint_block_number, checkpoint_block_hash,
            current_block_number, current_block_hash, generation,
            journal_block_count, journal_event_count,
            coverage_block_count, coverage_transaction_count,
            coverage_receipt_count, coverage_log_count)
         VALUES (true, $1, $2, $3, $4, $5, $6, $7, $6, $7,
                 1, 1, 0, 0, 0, 0, 0)`,
        [
          scan.storeID,
          scan.chainID.toString(),
          hexBuffer(scan.configurationFingerprint, "configuration fingerprint"),
          hexBuffer(scan.descriptorSetHash, "descriptor set hash"),
          scan.scanStartBlock,
          scan.checkpoint.blockNumber,
          hexBuffer(scan.checkpoint.blockHash, "checkpoint hash"),
        ]
      )
    } else {
      history = await this.loadBlockHistory(
        scan.retainedBlock.blockNumber,
        scan.retainedBlock.blockHash
      )
      await this.insertBlock(
        scan.retainedBlock,
        history,
        await this.loadBlockCoverage(
          scan.retainedBlock.blockNumber,
          scan.retainedBlock.blockHash
        )
      )
      await this.session.query(
        `UPDATE p2tr_ethereum_cursor
            SET current_block_number = $1,
                current_block_hash = $2,
                updated_at = clock_timestamp()
          WHERE singleton = true`,
        [
          scan.retainedBlock.blockNumber,
          hexBuffer(
            scan.retainedBlock.blockHash,
            "retained Ethereum block hash"
          ),
        ]
      )
      await this.session.query(
        `DELETE FROM p2tr_ethereum_blocks
          WHERE block_number > $1
             OR (block_number = $1 AND block_hash <> $2)`,
        [
          scan.retainedBlock.blockNumber,
          hexBuffer(
            scan.retainedBlock.blockHash,
            "retained Ethereum block hash"
          ),
        ]
      )
    }

    const eventsByBlock = new Map<number, P2TRCanonicalEthereumEvent[]>()
    for (const event of scan.events) {
      const existing = eventsByBlock.get(event.log.blockNumber) ?? []
      existing.push(event)
      eventsByBlock.set(event.log.blockNumber, existing)
    }
    for (const block of scan.blocks) {
      const records = (eventsByBlock.get(block.blockNumber) ?? [])
        .sort((left, right) => left.log.logIndex - right.log.logIndex)
        .map(p2trCanonicalEthereumRequiredEventRecord)
      const coverage = scan.blockCoverage.find(
        (entry) =>
          entry.blockNumber === block.blockNumber &&
          entry.blockHash === block.blockHash
      )
      if (coverage === undefined) {
        throw new Error("Canonical Ethereum scan lacks exact receipt coverage")
      }
      history = accumulateP2TRRequiredEventHistoryBlock(
        history,
        block,
        coverage,
        records
      )
      await this.insertBlock(block, history, coverage)
    }
    for (const event of scan.events) await this.insertEvent(event)
    const current = scan.blocks.at(-1) ?? scan.retainedBlock
    const updated = await this.session.query(
      `UPDATE p2tr_ethereum_cursor
          SET current_block_number = $1,
              current_block_hash = $2,
              generation = generation + 1,
              journal_block_count = $10,
              journal_event_count = $11,
              coverage_block_count = $12,
              coverage_transaction_count = $13,
              coverage_receipt_count = $14,
              coverage_log_count = $15,
              updated_at = clock_timestamp()
        WHERE singleton = true
          AND store_id = $3
          AND chain_id = $4
          AND configuration_fingerprint = $5
          AND descriptor_set_hash = $6
          AND scan_start_block = $7
          AND checkpoint_block_number = $8
          AND checkpoint_block_hash = $9`,
      [
        current.blockNumber,
        hexBuffer(current.blockHash, "current Ethereum block hash"),
        scan.storeID,
        scan.chainID.toString(),
        hexBuffer(scan.configurationFingerprint, "configuration fingerprint"),
        hexBuffer(scan.descriptorSetHash, "descriptor set hash"),
        scan.scanStartBlock,
        scan.checkpoint.blockNumber,
        hexBuffer(scan.checkpoint.blockHash, "checkpoint hash"),
        current.blockNumber - scan.checkpoint.blockNumber + 1,
        history.counters.requiredEvents,
        history.counters.blocks,
        history.counters.transactions,
        history.counters.receipts,
        history.counters.logs,
      ]
    )
    if (updated.rowCount !== 1) {
      throw new Error(
        "PostgreSQL Ethereum cursor configuration changed during scan"
      )
    }
  }

  async listCanonicalEthereumEvents(
    after: { blockNumber: number; logIndex: number } | undefined,
    limit: number
  ): Promise<P2TRCanonicalEthereumEvent[]> {
    const pageSize = positiveInteger(limit, "Ethereum journal event page size")
    if (pageSize > this.maxEventPageSize) {
      throw new Error(
        `Ethereum journal event page exceeds ${this.maxEventPageSize}`
      )
    }
    const position = after ?? { blockNumber: 0, logIndex: -1 }
    nonNegativeInteger(position.blockNumber, "Ethereum event cursor block")
    if (!Number.isSafeInteger(position.logIndex) || position.logIndex < -1) {
      throw new Error("Ethereum event cursor log index is invalid")
    }
    const result = await this.session.query<EventRow>(
      `SELECT encode(event_id, 'hex') AS event_id,
              event_kind,
              decoder_schema_id,
              encode(decoder_code_hash, 'hex') AS decoder_code_hash,
              block_number,
              encode(block_hash, 'hex') AS block_hash,
              encode(transaction_hash, 'hex') AS transaction_hash,
              transaction_index,
              log_index,
              encode(emitter, 'hex') AS emitter,
              encode(data, 'hex') AS data,
              topics,
              decoded_payload
         FROM p2tr_ethereum_logs
        WHERE (block_number, log_index) > ($1, $2)
        ORDER BY block_number, log_index
        LIMIT $3`,
      [position.blockNumber, position.logIndex, pageSize]
    )
    return result.rows.map(eventFromRow)
  }

  private async loadBlockHistory(
    blockNumber: number,
    blockHash: string
  ): Promise<P2TREthereumHistoryAccumulatorState> {
    const result = await this.session.query<{
      history_root: string
      required_event_count: string | number
      cumulative_block_count: string | number
      cumulative_transaction_count: string | number
      cumulative_receipt_count: string | number
      cumulative_log_count: string | number
    }>(
      `SELECT encode(history_root, 'hex') AS history_root,
              required_event_count, cumulative_block_count,
              cumulative_transaction_count, cumulative_receipt_count,
              cumulative_log_count
         FROM p2tr_ethereum_blocks
        WHERE block_number = $1 AND block_hash = $2
        FOR SHARE`,
      [blockNumber, hexBuffer(blockHash, "retained Ethereum block hash")]
    )
    if (result.rows.length !== 1) {
      throw new Error("Retained Ethereum history accumulator state is absent")
    }
    return {
      root: bytes32(
        result.rows[0].history_root,
        "retained Ethereum history root"
      ),
      counters: {
        blocks: databaseInteger(
          result.rows[0].cumulative_block_count,
          "retained Ethereum block coverage count"
        ),
        transactions: databaseInteger(
          result.rows[0].cumulative_transaction_count,
          "retained Ethereum transaction coverage count"
        ),
        receipts: databaseInteger(
          result.rows[0].cumulative_receipt_count,
          "retained Ethereum receipt coverage count"
        ),
        logs: databaseInteger(
          result.rows[0].cumulative_log_count,
          "retained Ethereum log coverage count"
        ),
        requiredEvents: databaseInteger(
          result.rows[0].required_event_count,
          "retained Ethereum event count"
        ),
      },
    }
  }

  private async loadBlockCoverage(
    blockNumber: number,
    blockHash: string
  ): Promise<P2TRCanonicalEthereumBlockCoverage> {
    const result = await this.session.query<{
      transactions_root: string
      receipts_root: string
      transaction_digest: string
      transaction_count: string | number
      receipt_digest: string
      receipt_count: string | number
      log_digest: string
      log_count: string | number
      required_event_digest: string
      block_required_event_count: string | number
    }>(
      `SELECT encode(transactions_root, 'hex') AS transactions_root,
              encode(receipts_root, 'hex') AS receipts_root,
              encode(transaction_digest, 'hex') AS transaction_digest,
              transaction_count,
              encode(receipt_digest, 'hex') AS receipt_digest,
              receipt_count,
              encode(log_digest, 'hex') AS log_digest,
              log_count,
              encode(required_event_digest, 'hex') AS required_event_digest,
              block_required_event_count
         FROM p2tr_ethereum_blocks
        WHERE block_number = $1 AND block_hash = $2
        FOR SHARE`,
      [blockNumber, hexBuffer(blockHash, "retained Ethereum block hash")]
    )
    if (result.rows.length !== 1) {
      throw new Error("Retained Ethereum coverage state is absent")
    }
    const row = result.rows[0]
    return {
      blockNumber,
      blockHash: bytes32(blockHash, "retained Ethereum block hash"),
      transactionsRoot: bytes32(
        row.transactions_root,
        "retained transactions root"
      ),
      receiptsRoot: bytes32(row.receipts_root, "retained receipts root"),
      transactionDigest: bytes32(
        row.transaction_digest,
        "retained transaction digest"
      ),
      transactionCount: databaseInteger(
        row.transaction_count,
        "retained transaction count"
      ),
      receiptDigest: bytes32(row.receipt_digest, "retained receipt digest"),
      receiptCount: databaseInteger(
        row.receipt_count,
        "retained receipt count"
      ),
      logDigest: bytes32(row.log_digest, "retained log digest"),
      logCount: databaseInteger(row.log_count, "retained log count"),
      requiredEventDigest: bytes32(
        row.required_event_digest,
        "retained required-event digest"
      ),
      requiredEventCount: databaseInteger(
        row.block_required_event_count,
        "retained required-event count"
      ),
    }
  }

  private async insertBlock(
    block: P2TRCanonicalEthereumScan["retainedBlock"],
    history: P2TREthereumHistoryAccumulatorState,
    coverage: P2TRCanonicalEthereumBlockCoverage
  ) {
    const inserted = await this.session.query(
      `INSERT INTO p2tr_ethereum_blocks
         (block_number, block_hash, parent_hash, block_timestamp,
          transactions_root, receipts_root, transaction_hashes,
          transaction_digest, transaction_count,
          receipt_digest, receipt_count, log_digest, log_count,
          required_event_digest, block_required_event_count,
          history_root, required_event_count, cumulative_block_count,
          cumulative_transaction_count, cumulative_receipt_count,
          cumulative_log_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       ON CONFLICT (block_number, block_hash) DO UPDATE
         SET parent_hash = EXCLUDED.parent_hash,
             block_timestamp = EXCLUDED.block_timestamp,
             transactions_root = EXCLUDED.transactions_root,
             receipts_root = EXCLUDED.receipts_root,
             transaction_hashes = EXCLUDED.transaction_hashes,
             transaction_digest = EXCLUDED.transaction_digest,
             transaction_count = EXCLUDED.transaction_count,
             receipt_digest = EXCLUDED.receipt_digest,
             receipt_count = EXCLUDED.receipt_count,
             log_digest = EXCLUDED.log_digest,
             log_count = EXCLUDED.log_count,
             required_event_digest = EXCLUDED.required_event_digest,
             block_required_event_count = EXCLUDED.block_required_event_count,
             history_root = EXCLUDED.history_root,
             required_event_count = EXCLUDED.required_event_count,
             cumulative_block_count = EXCLUDED.cumulative_block_count,
             cumulative_transaction_count = EXCLUDED.cumulative_transaction_count,
             cumulative_receipt_count = EXCLUDED.cumulative_receipt_count,
             cumulative_log_count = EXCLUDED.cumulative_log_count
       WHERE p2tr_ethereum_blocks.parent_hash = EXCLUDED.parent_hash
         AND p2tr_ethereum_blocks.block_timestamp = EXCLUDED.block_timestamp
         AND p2tr_ethereum_blocks.transactions_root = EXCLUDED.transactions_root
         AND p2tr_ethereum_blocks.receipts_root = EXCLUDED.receipts_root
         AND p2tr_ethereum_blocks.transaction_hashes = EXCLUDED.transaction_hashes
         AND p2tr_ethereum_blocks.transaction_digest = EXCLUDED.transaction_digest
         AND p2tr_ethereum_blocks.transaction_count = EXCLUDED.transaction_count
         AND p2tr_ethereum_blocks.receipt_digest = EXCLUDED.receipt_digest
         AND p2tr_ethereum_blocks.receipt_count = EXCLUDED.receipt_count
         AND p2tr_ethereum_blocks.log_digest = EXCLUDED.log_digest
         AND p2tr_ethereum_blocks.log_count = EXCLUDED.log_count
         AND p2tr_ethereum_blocks.required_event_digest = EXCLUDED.required_event_digest
         AND p2tr_ethereum_blocks.block_required_event_count = EXCLUDED.block_required_event_count
         AND p2tr_ethereum_blocks.history_root = EXCLUDED.history_root
         AND p2tr_ethereum_blocks.required_event_count = EXCLUDED.required_event_count
         AND p2tr_ethereum_blocks.cumulative_block_count = EXCLUDED.cumulative_block_count
         AND p2tr_ethereum_blocks.cumulative_transaction_count = EXCLUDED.cumulative_transaction_count
         AND p2tr_ethereum_blocks.cumulative_receipt_count = EXCLUDED.cumulative_receipt_count
         AND p2tr_ethereum_blocks.cumulative_log_count = EXCLUDED.cumulative_log_count`,
      [
        block.blockNumber,
        hexBuffer(block.blockHash, "Ethereum block hash"),
        hexBuffer(block.parentHash, "Ethereum parent hash"),
        block.timestamp,
        hexBuffer(coverage.transactionsRoot, "Ethereum transactions root"),
        hexBuffer(coverage.receiptsRoot, "Ethereum receipts root"),
        canonicalJSON(block.transactionHashes),
        hexBuffer(coverage.transactionDigest, "Ethereum transaction digest"),
        coverage.transactionCount,
        hexBuffer(coverage.receiptDigest, "Ethereum receipt digest"),
        coverage.receiptCount,
        hexBuffer(coverage.logDigest, "Ethereum log digest"),
        coverage.logCount,
        hexBuffer(
          coverage.requiredEventDigest,
          "Ethereum required-event digest"
        ),
        coverage.requiredEventCount,
        hexBuffer(history.root, "Ethereum block history root"),
        history.counters.requiredEvents,
        history.counters.blocks,
        history.counters.transactions,
        history.counters.receipts,
        history.counters.logs,
      ]
    )
    if (inserted.rowCount !== 1) {
      throw new Error(
        `Stored Ethereum block ${block.blockNumber} conflicts with canonical block metadata`
      )
    }
  }

  private async insertEvent(event: P2TRCanonicalEthereumEvent) {
    const inserted = await this.session.query(
      `INSERT INTO p2tr_ethereum_logs
         (event_id, event_kind, decoder_schema_id, decoder_code_hash,
          block_number, block_hash,
          transaction_hash, transaction_index, log_index, emitter, topic0,
          topics, data, decoded_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb)
       ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
       WHERE p2tr_ethereum_logs.event_kind = EXCLUDED.event_kind
         AND p2tr_ethereum_logs.decoder_schema_id = EXCLUDED.decoder_schema_id
         AND p2tr_ethereum_logs.decoder_code_hash = EXCLUDED.decoder_code_hash
         AND p2tr_ethereum_logs.block_number = EXCLUDED.block_number
         AND p2tr_ethereum_logs.block_hash = EXCLUDED.block_hash
         AND p2tr_ethereum_logs.transaction_hash = EXCLUDED.transaction_hash
         AND p2tr_ethereum_logs.transaction_index = EXCLUDED.transaction_index
         AND p2tr_ethereum_logs.log_index = EXCLUDED.log_index
         AND p2tr_ethereum_logs.emitter = EXCLUDED.emitter
         AND p2tr_ethereum_logs.topic0 = EXCLUDED.topic0
         AND p2tr_ethereum_logs.topics = EXCLUDED.topics
         AND p2tr_ethereum_logs.data = EXCLUDED.data
         AND p2tr_ethereum_logs.decoded_payload = EXCLUDED.decoded_payload`,
      [
        hexBuffer(event.eventID, "Ethereum event ID"),
        event.kind,
        event.decoderSchemaID,
        hexBuffer(event.decoderCodeHash, "Ethereum decoder code hash"),
        event.log.blockNumber,
        hexBuffer(event.log.blockHash, "Ethereum event block hash"),
        hexBuffer(event.log.transactionHash, "Ethereum transaction hash"),
        event.log.transactionIndex,
        event.log.logIndex,
        hexBuffer(event.log.address, "Ethereum event emitter"),
        hexBuffer(event.log.topics[0], "Ethereum event topic0"),
        canonicalJSON(event.log.topics),
        hexBuffer(event.log.data, "Ethereum event data", true),
        canonicalJSON(event.payload),
      ]
    )
    if (inserted.rowCount !== 1) {
      throw new Error(
        `Stored Ethereum event ${event.eventID} conflicts with replayed canonical evidence`
      )
    }
  }

  private async assertSchema() {
    const schema = await this.session.query<{ version: number | string }>(
      `SELECT version
         FROM p2tr_watchtower_schema_version
        WHERE component = 'canonical-ethereum-journal'`
    )
    if (
      schema.rows.length !== 1 ||
      Number(schema.rows[0].version) !== REQUIRED_SCHEMA_VERSION
    ) {
      throw new Error(
        `Canonical Ethereum journal schema migration ${REQUIRED_SCHEMA_VERSION} is required`
      )
    }
  }
}

const CURSOR_SELECT = `SELECT store_id,
                              chain_id,
                              encode(configuration_fingerprint, 'hex') AS configuration_fingerprint,
                              encode(descriptor_set_hash, 'hex') AS descriptor_set_hash,
                              scan_start_block,
                              checkpoint_block_number,
                              encode(checkpoint_block_hash, 'hex') AS checkpoint_block_hash,
                              current_block_number,
                              encode(current_block_hash, 'hex') AS current_block_hash
                         FROM p2tr_ethereum_cursor
                        WHERE singleton = true`

function cursorFromRow(row: CursorRow): P2TRCanonicalEthereumCursor {
  return {
    storeID: boundedString(row.store_id, 255, "stored Ethereum store ID"),
    chainID: databaseInteger(row.chain_id, "stored Ethereum chain ID", true),
    configurationFingerprint: bytes32(
      row.configuration_fingerprint,
      "stored Ethereum configuration fingerprint"
    ),
    descriptorSetHash: bytes32(
      row.descriptor_set_hash,
      "stored Ethereum descriptor set hash"
    ),
    scanStartBlock: databaseInteger(
      row.scan_start_block,
      "stored Ethereum scan start block",
      true
    ),
    checkpoint: {
      blockNumber: databaseInteger(
        row.checkpoint_block_number,
        "stored Ethereum checkpoint number"
      ),
      blockHash: bytes32(
        row.checkpoint_block_hash,
        "stored Ethereum checkpoint hash"
      ),
    },
    current: {
      blockNumber: databaseInteger(
        row.current_block_number,
        "stored Ethereum cursor number"
      ),
      blockHash: bytes32(row.current_block_hash, "stored Ethereum cursor hash"),
    },
  }
}

function readinessSnapshotFromRow(
  row: ReadinessRow
): P2TRCanonicalEthereumReadinessSnapshot {
  const cursor = cursorFromRow(row)
  const generation = databaseInteger(
    row.generation,
    "stored Ethereum readiness generation",
    true
  )
  const blocks = databaseInteger(
    row.journal_block_count,
    "stored Ethereum journal block count",
    true
  )
  const events = databaseInteger(
    row.journal_event_count,
    "stored Ethereum journal event count"
  )
  const requiredEvents = databaseInteger(
    row.required_event_count,
    "stored Ethereum history event count"
  )
  const coverageBlocks = databaseInteger(
    row.coverage_block_count,
    "stored Ethereum coverage block count"
  )
  const transactions = databaseInteger(
    row.coverage_transaction_count,
    "stored Ethereum coverage transaction count"
  )
  const receipts = databaseInteger(
    row.coverage_receipt_count,
    "stored Ethereum coverage receipt count"
  )
  const logs = databaseInteger(
    row.coverage_log_count,
    "stored Ethereum coverage log count"
  )
  if (
    blocks !== cursor.current.blockNumber - cursor.checkpoint.blockNumber + 1 ||
    coverageBlocks !==
      cursor.current.blockNumber - cursor.checkpoint.blockNumber ||
    transactions !== receipts ||
    events !== requiredEvents
  ) {
    throw new Error("PostgreSQL Ethereum readiness counters are stale")
  }
  const historyRoot = bytes32(
    row.history_root,
    "stored Ethereum readiness history root"
  )
  const root = `0x${createHash("sha256")
    .update("tbtc-p2tr-ethereum-readiness-root-v1\0", "utf8")
    .update(
      canonicalJSON({
        ...cursor,
        generation,
        historyRoot,
        journalCounts: {
          blocks,
          coverageBlocks,
          transactions,
          receipts,
          logs,
          events,
        },
      }),
      "utf8"
    )
    .digest("hex")}`
  return {
    ...cursor,
    generation,
    root,
    historyRoot,
    journalCounts: {
      blocks,
      coverageBlocks,
      transactions,
      receipts,
      logs,
      events,
    },
  }
}

function eventFromRow(row: EventRow): P2TRCanonicalEthereumEvent {
  const topics = requireStringArray(row.topics, "stored Ethereum event topics")
  const payload = requireObject(
    row.decoded_payload,
    "stored Ethereum event payload"
  )
  return {
    eventID: bytes32(row.event_id, "stored Ethereum event ID"),
    kind: row.event_kind,
    decoderSchemaID: boundedString(
      row.decoder_schema_id,
      128,
      "stored Ethereum decoder schema ID"
    ),
    decoderCodeHash: bytes32(
      row.decoder_code_hash,
      "stored Ethereum decoder code hash"
    ),
    log: {
      address: address(row.emitter, "stored Ethereum emitter"),
      blockNumber: databaseInteger(
        row.block_number,
        "stored Ethereum block number"
      ),
      blockHash: bytes32(row.block_hash, "stored Ethereum block hash"),
      transactionHash: bytes32(
        row.transaction_hash,
        "stored Ethereum transaction hash"
      ),
      transactionIndex: databaseInteger(
        row.transaction_index,
        "stored Ethereum transaction index"
      ),
      logIndex: databaseInteger(row.log_index, "stored Ethereum log index"),
      data: hex(row.data, "stored Ethereum event data"),
      topics: topics.map((topic, index) =>
        bytes32(topic, `stored Ethereum event topic ${index}`)
      ),
      removed: false,
    },
    payload,
  }
}

function validateScan(
  scan: P2TRCanonicalEthereumScan,
  bounds: {
    maxBlocks: number
    maxEvents: number
    maxRawLogBytes: number
    maxDecodedPayloadBytes: number
  }
) {
  bytes32(
    scan.configurationFingerprint,
    "Ethereum scan configuration fingerprint"
  )
  bytes32(scan.descriptorSetHash, "Ethereum scan descriptor set hash")
  if (scan.scanStartBlock !== scan.checkpoint.blockNumber + 1) {
    throw new Error(
      "Ethereum scan checkpoint must immediately precede its inclusive start"
    )
  }
  if (scan.blocks.length > bounds.maxBlocks) {
    throw new Error(
      `Ethereum scan exceeds its ${bounds.maxBlocks}-block mutation bound`
    )
  }
  if (scan.events.length > bounds.maxEvents) {
    throw new Error(
      `Ethereum scan exceeds its ${bounds.maxEvents}-event mutation bound`
    )
  }
  if (scan.blockCoverage.length !== scan.blocks.length) {
    throw new Error("Ethereum scan receipt coverage is incomplete")
  }
  if (
    scan.blocks.some(
      (block, index) =>
        block.blockNumber !== scan.retainedBlock.blockNumber + index + 1 ||
        block.parentHash !==
          (index === 0
            ? scan.retainedBlock.blockHash
            : scan.blocks[index - 1].blockHash)
    )
  ) {
    throw new Error("Ethereum scan blocks are not a contiguous chain")
  }
  const hashes = new Map(
    scan.blocks.map((block) => [block.blockNumber, block.blockHash])
  )
  const coverageKeys = new Set<string>()
  for (const coverage of scan.blockCoverage) {
    const key = `${coverage.blockNumber}:${coverage.blockHash}`
    if (
      hashes.get(coverage.blockNumber) !== coverage.blockHash ||
      coverageKeys.has(key) ||
      coverage.transactionCount !== coverage.receiptCount
    ) {
      throw new Error("Ethereum scan receipt coverage is inconsistent")
    }
    coverageKeys.add(key)
    for (const [value, label] of [
      [coverage.transactionsRoot, "transactions root"],
      [coverage.receiptsRoot, "receipts root"],
      [coverage.transactionDigest, "transaction"],
      [coverage.receiptDigest, "receipt"],
      [coverage.logDigest, "log"],
      [coverage.requiredEventDigest, "required-event"],
    ] as const) {
      bytes32(value, `Ethereum ${label} coverage digest`)
    }
    nonNegativeInteger(coverage.transactionCount, "coverage transaction count")
    nonNegativeInteger(coverage.receiptCount, "coverage receipt count")
    nonNegativeInteger(coverage.logCount, "coverage log count")
    nonNegativeInteger(
      coverage.requiredEventCount,
      "coverage required-event count"
    )
  }
  let rawLogBytes = 0
  let decodedPayloadBytes = 0
  for (const event of scan.events) {
    if (hashes.get(event.log.blockNumber) !== event.log.blockHash) {
      throw new Error("Ethereum event does not belong to an appended block")
    }
    rawLogBytes += Buffer.byteLength(event.log.data.slice(2), "hex")
    rawLogBytes += event.log.topics.length * 32
    decodedPayloadBytes += Buffer.byteLength(
      canonicalJSON(event.payload),
      "utf8"
    )
    if (rawLogBytes > bounds.maxRawLogBytes) {
      throw new Error("Ethereum scan exceeds its raw-log mutation byte bound")
    }
    if (decodedPayloadBytes > bounds.maxDecodedPayloadBytes) {
      throw new Error(
        "Ethereum scan exceeds its decoded-payload mutation byte bound"
      )
    }
  }
}

function hexBuffer(value: string, label: string, allowEmpty = false): Buffer {
  const normalized = hex(value, label).slice(2)
  if (!allowEmpty && normalized.length === 0) {
    throw new Error(`${label} cannot be empty`)
  }
  return Buffer.from(normalized, "hex")
}

function hex(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be hex`)
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`${label} must contain whole hex bytes`)
  }
  return `0x${normalized}`
}

function bytes32(value: string, label: string): string {
  const normalized = hex(value, label)
  if (normalized.length !== 66) throw new Error(`${label} must be 32 bytes`)
  return normalized
}

function address(value: string, label: string): string {
  const normalized = hex(value, label)
  if (normalized.length !== 42) throw new Error(`${label} must be 20 bytes`)
  return normalized
}

function databaseInteger(
  value: string | number,
  label: string,
  positive = false
): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < (positive ? 1 : 0)) {
    throw new Error(`${label} is outside the safe integer range`)
  }
  return parsed
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function boundedString(value: string, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be between 1 and ${maximum} characters`)
  }
  return value
}

function requireStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 4 ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label} is malformed`)
  }
  return value as string[]
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is malformed`)
  }
  return value as Record<string, unknown>
}

function canonicalJSON(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
    .join(",")}}`
}
