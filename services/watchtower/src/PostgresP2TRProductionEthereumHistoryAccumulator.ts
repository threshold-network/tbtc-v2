import { createHash } from "node:crypto"
import {
  P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS,
  computeP2TRCanonicalEthereumBlockCoverage,
  computeP2TRCanonicalEthereumDescriptorSetHash,
  p2trCanonicalEthereumCheckpointAnchorCoverage,
  type P2TRCanonicalEthereumReceipt,
  type P2TRCanonicalEthereumEventDescriptor,
  type P2TRCanonicalEthereumRawLog,
} from "./P2TRCanonicalEthereumJournal.js"
import {
  accumulateP2TRRequiredEventHistoryBlock,
  initialP2TRRequiredEventHistoryRoot,
  type P2TREthereumHistoryAccumulatorState,
  type P2TREthereumHistoryCoverageCounters,
  type P2TRProductionEthereumPoint,
} from "./P2TRProductionActivation.js"
import type { JsonRpcP2TRCanonicalEthereumProvider } from "./HttpP2TREthereumJsonRpc.js"
import type { P2TRProductionEthereumHistoryAccumulator } from "./VerifiedP2TRProductionEthereumProvider.js"
import type {
  P2TRPostgresClient,
  P2TRPostgresPool,
} from "./PostgresP2TRCanonicalIndexStore.js"

export type PostgresP2TRProductionEthereumHistoryAccumulatorOptions = {
  storeID: string
  /** Bootstrap-pinned identity, re-read from the live session before mutation. */
  databaseIdentity: P2TRPostgresDatabaseIdentity
  maxReorgDepth: number
  statementTimeoutMs?: number
}

export type P2TRPostgresDatabaseIdentity = {
  systemIdentifier: string
  serverAddress: string | null
  serverPort: number | null
  databaseOID: number
  databaseName: string
  currentRole: string
}

type CursorRow = {
  accumulator_id: string
  store_fingerprint: string
  chain_id: string | number
  descriptor_set_hash: string
  checkpoint_block_number: string | number
  checkpoint_block_hash: string
  current_block_number: string | number
  current_block_hash: string
  history_root: string
  required_event_count: string | number
  cumulative_block_count: string | number
  cumulative_transaction_count: string | number
  cumulative_receipt_count: string | number
  cumulative_log_count: string | number
}

type DatabaseIdentityRow = {
  system_identifier: string | number
  server_address: string | null
  server_port: string | number | null
  database_oid: string | number
  database_name: string
  current_role: string
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000

/**
 * Resumable, parent-linked, receipt-complete history accumulator. Production
 * source and verifier instances must use separately operated pools and signed
 * store fingerprints; a dispatch advances at most the caller's bounded tail.
 */
export class PostgresP2TRProductionEthereumHistoryAccumulator
  implements P2TRProductionEthereumHistoryAccumulator
{
  readonly profile = "durable-incremental-receipt-complete" as const
  readonly storeID: string
  readonly storeFingerprint: string
  readonly clusterFingerprint: string
  private readonly maxReorgDepth: number
  private readonly statementTimeoutMs: number

  constructor(
    private readonly pool: P2TRPostgresPool,
    options: PostgresP2TRProductionEthereumHistoryAccumulatorOptions
  ) {
    this.storeID = boundedString(options.storeID, 128, "history accumulator ID")
    const identity = normalizeDatabaseIdentity(options.databaseIdentity)
    this.storeFingerprint = databaseIdentityFingerprint(identity)
    this.clusterFingerprint = databaseClusterFingerprint(identity)
    this.maxReorgDepth = positiveInteger(
      options.maxReorgDepth,
      "history accumulator reorg bound"
    )
    this.statementTimeoutMs = positiveInteger(
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      "history accumulator statement timeout"
    )
  }

  async synchronizeTo(request: {
    provider: JsonRpcP2TRCanonicalEthereumProvider
    chainID: number
    checkpoint: P2TRProductionEthereumPoint
    target: P2TRProductionEthereumPoint
    descriptors: readonly P2TRCanonicalEthereumEventDescriptor[]
    maxTailBlocks: number
    maxTailTransactions: number
    maxTailLogs: number
    maxDecodedPayloadBytes: number
    deadlineAt: number
  }): Promise<{
    point: P2TRProductionEthereumPoint
    requiredEventHistoryDigest: string
    requiredEventCount: number
    coverageCounters: P2TREthereumHistoryCoverageCounters
    processedBlocks: number
    complete: boolean
  }> {
    validateRequest(request)
    const descriptorSetHash = computeP2TRCanonicalEthereumDescriptorSetHash(
      request.descriptors
    )
    const client = await this.pool.connect()
    let releaseError: Error | undefined
    let transactionState:
      | "idle"
      | "identifying"
      | "beginning"
      | "active"
      | "committing"
      | "committed"
      | "rolling-back" = "idle"
    try {
      transactionState = "identifying"
      await this.assertDatabaseIdentity(client)
      transactionState = "beginning"
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
      transactionState = "active"
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${this.statementTimeoutMs}ms`,
      ])
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`p2tr-ethereum-history:${this.storeID}`]
      )
      let cursor = await this.loadOrInitialize(
        client,
        request,
        descriptorSetHash
      )
      cursor = await this.rollbackIfNeeded(client, request, cursor)

      if (request.target.blockNumber <= cursor.currentBlockNumber) {
        const historical = await this.loadBlock(
          client,
          request.target.blockNumber
        )
        if (
          historical === undefined ||
          historical.blockHash !== request.target.blockHash
        ) {
          throw new Error("Durable Ethereum history target is noncanonical")
        }
        transactionState = "committing"
        await client.query("COMMIT")
        transactionState = "committed"
        return {
          point: request.target,
          requiredEventHistoryDigest: historical.historyRoot,
          requiredEventCount: historical.requiredEventCount,
          coverageCounters: historical.coverageCounters,
          processedBlocks: 0,
          complete: true,
        }
      }

      const through = Math.min(
        request.target.blockNumber,
        cursor.currentBlockNumber + request.maxTailBlocks
      )
      let processedBlocks = 0
      let transactions = 0
      let logs = 0
      let history: P2TREthereumHistoryAccumulatorState = {
        root: cursor.historyRoot,
        counters: cursor.coverageCounters,
      }
      let parent = cursor.currentBlockHash
      for (
        let blockNumber = cursor.currentBlockNumber + 1;
        blockNumber <= through;
        blockNumber++
      ) {
        assertDeadline(request.deadlineAt)
        const block = await request.provider.getBlock(blockNumber)
        if (block === null || block.parentHash !== parent) {
          throw new Error(
            "Ethereum history tail is absent or parent-discontinuous"
          )
        }
        transactions += block.transactionHashes.length
        if (transactions > request.maxTailTransactions) {
          throw new Error("Ethereum history tail reached its transaction bound")
        }
        const records: unknown[] = []
        const receipts: P2TRCanonicalEthereumReceipt[] = []
        let expectedLogIndex = 0
        for (const [
          transactionIndex,
          transactionHash,
        ] of block.transactionHashes.entries()) {
          assertDeadline(request.deadlineAt)
          const receipt = await request.provider.getTransactionReceipt(
            transactionHash
          )
          if (
            receipt === null ||
            receipt.blockNumber !== blockNumber ||
            receipt.blockHash !== block.blockHash ||
            receipt.transactionHash !== transactionHash ||
            receipt.transactionIndex !== transactionIndex ||
            (receipt.status !== 0 && receipt.status !== 1) ||
            (receipt.status === 0 && receipt.logs.length !== 0)
          ) {
            throw new Error("Ethereum history receipt coverage is inconsistent")
          }
          receipts.push(receipt)
          for (const log of receipt.logs) {
            if (
              log.blockNumber !== blockNumber ||
              log.blockHash !== block.blockHash ||
              log.transactionHash !== transactionHash ||
              log.transactionIndex !== transactionIndex ||
              log.logIndex !== expectedLogIndex++
            ) {
              throw new Error(
                "Ethereum history receipt log order is incomplete"
              )
            }
            logs++
            if (logs > request.maxTailLogs) {
              throw new Error("Ethereum history tail reached its log bound")
            }
            const descriptor = descriptorFor(request.descriptors, log)
            if (descriptor === undefined) continue
            const payload = descriptor.decode(Object.freeze({ ...log }))
            if (!isPlainObject(payload)) {
              throw new Error(
                `Ethereum ${descriptor.kind} decoder returned non-object`
              )
            }
            if (
              Buffer.byteLength(canonicalJSON(payload), "utf8") >
              request.maxDecodedPayloadBytes
            ) {
              throw new Error(
                `Ethereum ${descriptor.kind} payload exceeds its bound`
              )
            }
            records.push(eventRecord(request.chainID, descriptor, log, payload))
          }
        }
        const coverage = await computeP2TRCanonicalEthereumBlockCoverage(
          block,
          receipts,
          records
        )
        history = accumulateP2TRRequiredEventHistoryBlock(
          history,
          block,
          coverage,
          records
        )
        await client.query(
          `INSERT INTO p2tr_ethereum_history_accumulator_blocks
             (accumulator_id, block_number, block_hash, parent_hash,
              transactions_root, receipts_root,
              history_root, required_event_count,
              transaction_digest, transaction_count,
              receipt_digest, receipt_count, log_digest, log_count,
              required_event_digest, block_required_event_count,
              cumulative_block_count, cumulative_transaction_count,
              cumulative_receipt_count, cumulative_log_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
          [
            this.storeID,
            blockNumber,
            hexBuffer(block.blockHash, "history block hash"),
            hexBuffer(block.parentHash, "history parent hash"),
            hexBuffer(coverage.transactionsRoot, "history transactions root"),
            hexBuffer(coverage.receiptsRoot, "history receipts root"),
            hexBuffer(history.root, "history accumulator root"),
            history.counters.requiredEvents,
            hexBuffer(
              coverage.transactionDigest,
              "transaction coverage digest"
            ),
            coverage.transactionCount,
            hexBuffer(coverage.receiptDigest, "receipt coverage digest"),
            coverage.receiptCount,
            hexBuffer(coverage.logDigest, "log coverage digest"),
            coverage.logCount,
            hexBuffer(
              coverage.requiredEventDigest,
              "required-event coverage digest"
            ),
            coverage.requiredEventCount,
            history.counters.blocks,
            history.counters.transactions,
            history.counters.receipts,
            history.counters.logs,
          ]
        )
        parent = block.blockHash
        processedBlocks++
      }
      const update = await client.query(
        `UPDATE p2tr_ethereum_history_accumulators
            SET current_block_number = $2, current_block_hash = $3,
                history_root = $4, required_event_count = $5,
                cumulative_block_count = $6,
                cumulative_transaction_count = $7,
                cumulative_receipt_count = $8,
                cumulative_log_count = $9,
                updated_at = clock_timestamp()
          WHERE accumulator_id = $1`,
        [
          this.storeID,
          through,
          hexBuffer(parent, "history cursor hash"),
          hexBuffer(history.root, "history cursor root"),
          history.counters.requiredEvents,
          history.counters.blocks,
          history.counters.transactions,
          history.counters.receipts,
          history.counters.logs,
        ]
      )
      if (update.rowCount !== 1) {
        throw new Error("Ethereum history cursor update failed")
      }
      transactionState = "committing"
      await client.query("COMMIT")
      transactionState = "committed"
      return {
        point: { blockNumber: through, blockHash: parent },
        requiredEventHistoryDigest: history.root,
        requiredEventCount: history.counters.requiredEvents,
        coverageCounters: history.counters,
        processedBlocks,
        complete:
          through === request.target.blockNumber &&
          parent === request.target.blockHash,
      }
    } catch (error) {
      if (transactionState === "active") {
        try {
          transactionState = "rolling-back"
          await client.query("ROLLBACK")
          transactionState = "idle"
        } catch (rollbackError) {
          releaseError = asError(rollbackError)
        }
      } else if (
        transactionState === "identifying" ||
        transactionState === "beginning" ||
        transactionState === "committing"
      ) {
        // BEGIN/COMMIT/ROLLBACK transport failures make the server-side
        // transaction outcome unknowable. Passing an error to release forces
        // pg to destroy the session instead of returning it to the pool.
        releaseError = asError(error)
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }

  private async assertDatabaseIdentity(
    client: P2TRPostgresClient
  ): Promise<void> {
    const result = await client.query<DatabaseIdentityRow>(
      `SELECT (pg_control_system()).system_identifier::text AS system_identifier,
              inet_server_addr()::text AS server_address,
              inet_server_port() AS server_port,
              (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
              current_database() AS database_name,
              current_user AS current_role`
    )
    if (result.rows.length !== 1) {
      throw new Error("PostgreSQL history database identity is unavailable")
    }
    const live = normalizeDatabaseIdentity({
      systemIdentifier: String(result.rows[0].system_identifier),
      serverAddress: result.rows[0].server_address,
      serverPort:
        result.rows[0].server_port === null
          ? null
          : databaseInteger(
              result.rows[0].server_port,
              "PostgreSQL server port"
            ),
      databaseOID: databaseInteger(
        result.rows[0].database_oid,
        "PostgreSQL database OID"
      ),
      databaseName: result.rows[0].database_name,
      currentRole: result.rows[0].current_role,
    })
    if (
      databaseIdentityFingerprint(live) !== this.storeFingerprint ||
      databaseClusterFingerprint(live) !== this.clusterFingerprint
    ) {
      throw new Error(
        "PostgreSQL history database identity does not match its bootstrap attestation"
      )
    }
  }

  private async loadOrInitialize(
    client: P2TRPostgresClient,
    request: Parameters<
      P2TRProductionEthereumHistoryAccumulator["synchronizeTo"]
    >[0],
    descriptorSetHash: string
  ): Promise<NormalizedCursor> {
    const result = await client.query<CursorRow>(
      `${CURSOR_SELECT} FOR UPDATE`,
      [this.storeID]
    )
    if (result.rows.length > 1) {
      throw new Error("Ethereum history accumulator singleton is inconsistent")
    }
    if (result.rows.length === 1) {
      const cursor = cursorFromRow(result.rows[0])
      if (
        cursor.storeFingerprint !== this.storeFingerprint ||
        cursor.chainID !== request.chainID ||
        cursor.descriptorSetHash !== descriptorSetHash ||
        canonicalJSON(cursor.checkpoint) !== canonicalJSON(request.checkpoint)
      ) {
        throw new Error("Ethereum history accumulator configuration changed")
      }
      return cursor
    }
    assertDeadline(request.deadlineAt)
    const checkpointBlock = await request.provider.getBlock(
      request.checkpoint.blockNumber
    )
    if (checkpointBlock?.blockHash !== request.checkpoint.blockHash) {
      throw new Error("Ethereum history checkpoint is noncanonical")
    }
    const history = initialP2TRRequiredEventHistoryRoot(
      request.chainID,
      request.checkpoint
    )
    const checkpointCoverage =
      p2trCanonicalEthereumCheckpointAnchorCoverage(checkpointBlock)
    await client.query(
      `INSERT INTO p2tr_ethereum_history_accumulators
         (accumulator_id, store_fingerprint, chain_id, descriptor_set_hash,
          checkpoint_block_number, checkpoint_block_hash,
          current_block_number, current_block_hash, history_root,
          required_event_count, cumulative_block_count,
          cumulative_transaction_count, cumulative_receipt_count,
          cumulative_log_count)
       VALUES ($1, $2, $3, $4, $5, $6, $5, $6, $7, 0, 0, 0, 0, 0)`,
      [
        this.storeID,
        hexBuffer(this.storeFingerprint, "history store fingerprint"),
        request.chainID,
        hexBuffer(descriptorSetHash, "history descriptor set"),
        request.checkpoint.blockNumber,
        hexBuffer(request.checkpoint.blockHash, "history checkpoint hash"),
        hexBuffer(history.root, "initial history root"),
      ]
    )
    await client.query(
      `INSERT INTO p2tr_ethereum_history_accumulator_blocks
         (accumulator_id, block_number, block_hash, parent_hash,
          transactions_root, receipts_root,
          history_root, required_event_count,
          transaction_digest, transaction_count,
          receipt_digest, receipt_count, log_digest, log_count,
          required_event_digest, block_required_event_count,
          cumulative_block_count, cumulative_transaction_count,
          cumulative_receipt_count, cumulative_log_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 0, $9, 0, $10, 0,
               $11, 0, 0, 0, 0, 0)`,
      [
        this.storeID,
        request.checkpoint.blockNumber,
        hexBuffer(request.checkpoint.blockHash, "history checkpoint hash"),
        hexBuffer(checkpointBlock.parentHash, "history checkpoint parent"),
        hexBuffer(
          checkpointCoverage.transactionsRoot,
          "history checkpoint transactions root"
        ),
        hexBuffer(
          checkpointCoverage.receiptsRoot,
          "history checkpoint receipts root"
        ),
        hexBuffer(history.root, "initial history root"),
        hexBuffer(
          checkpointCoverage.transactionDigest,
          "checkpoint transaction digest"
        ),
        hexBuffer(
          checkpointCoverage.receiptDigest,
          "checkpoint receipt digest"
        ),
        hexBuffer(checkpointCoverage.logDigest, "checkpoint log digest"),
        hexBuffer(
          checkpointCoverage.requiredEventDigest,
          "checkpoint required-event digest"
        ),
      ]
    )
    return {
      storeFingerprint: this.storeFingerprint,
      chainID: request.chainID,
      descriptorSetHash,
      checkpoint: request.checkpoint,
      currentBlockNumber: request.checkpoint.blockNumber,
      currentBlockHash: request.checkpoint.blockHash,
      historyRoot: history.root,
      requiredEventCount: 0,
      coverageCounters: history.counters,
    }
  }

  private async rollbackIfNeeded(
    client: P2TRPostgresClient,
    request: Parameters<
      P2TRProductionEthereumHistoryAccumulator["synchronizeTo"]
    >[0],
    cursor: NormalizedCursor
  ): Promise<NormalizedCursor> {
    assertDeadline(request.deadlineAt)
    const canonical = await request.provider.getBlock(cursor.currentBlockNumber)
    if (canonical?.blockHash === cursor.currentBlockHash) return cursor
    const candidates = await client.query<AccumulatorBlockRow>(
      `SELECT block_number, encode(block_hash, 'hex') AS block_hash,
              encode(history_root, 'hex') AS history_root,
              required_event_count, cumulative_block_count,
              cumulative_transaction_count, cumulative_receipt_count,
              cumulative_log_count
         FROM p2tr_ethereum_history_accumulator_blocks
        WHERE accumulator_id = $1 AND block_number < $2
        ORDER BY block_number DESC
        LIMIT $3`,
      [this.storeID, cursor.currentBlockNumber, this.maxReorgDepth]
    )
    let ancestor: NormalizedAccumulatorBlock | undefined
    for (const row of candidates.rows) {
      assertDeadline(request.deadlineAt)
      const candidate = accumulatorBlockFromRow(row)
      const providerBlock = await request.provider.getBlock(
        candidate.blockNumber
      )
      if (providerBlock?.blockHash === candidate.blockHash) {
        ancestor = candidate
        break
      }
    }
    if (ancestor === undefined) {
      throw new Error("Ethereum history reorg exceeds its configured bound")
    }
    await client.query(
      `DELETE FROM p2tr_ethereum_history_accumulator_blocks
        WHERE accumulator_id = $1 AND block_number > $2`,
      [this.storeID, ancestor.blockNumber]
    )
    await client.query(
      `UPDATE p2tr_ethereum_history_accumulators
          SET current_block_number = $2, current_block_hash = $3,
              history_root = $4, required_event_count = $5,
              cumulative_block_count = $6,
              cumulative_transaction_count = $7,
              cumulative_receipt_count = $8,
              cumulative_log_count = $9,
              updated_at = clock_timestamp()
        WHERE accumulator_id = $1`,
      [
        this.storeID,
        ancestor.blockNumber,
        hexBuffer(ancestor.blockHash, "history rollback hash"),
        hexBuffer(ancestor.historyRoot, "history rollback root"),
        ancestor.requiredEventCount,
        ancestor.coverageCounters.blocks,
        ancestor.coverageCounters.transactions,
        ancestor.coverageCounters.receipts,
        ancestor.coverageCounters.logs,
      ]
    )
    return {
      ...cursor,
      currentBlockNumber: ancestor.blockNumber,
      currentBlockHash: ancestor.blockHash,
      historyRoot: ancestor.historyRoot,
      requiredEventCount: ancestor.requiredEventCount,
      coverageCounters: ancestor.coverageCounters,
    }
  }

  private async loadBlock(
    client: P2TRPostgresClient,
    blockNumber: number
  ): Promise<NormalizedAccumulatorBlock | undefined> {
    const result = await client.query<AccumulatorBlockRow>(
      `SELECT block_number, encode(block_hash, 'hex') AS block_hash,
              encode(history_root, 'hex') AS history_root,
              required_event_count, cumulative_block_count,
              cumulative_transaction_count, cumulative_receipt_count,
              cumulative_log_count
         FROM p2tr_ethereum_history_accumulator_blocks
        WHERE accumulator_id = $1 AND block_number = $2`,
      [this.storeID, blockNumber]
    )
    if (result.rows.length > 1) {
      throw new Error("Ethereum history block journal is inconsistent")
    }
    return result.rows[0] && accumulatorBlockFromRow(result.rows[0])
  }
}

type NormalizedCursor = {
  storeFingerprint: string
  chainID: number
  descriptorSetHash: string
  checkpoint: P2TRProductionEthereumPoint
  currentBlockNumber: number
  currentBlockHash: string
  historyRoot: string
  requiredEventCount: number
  coverageCounters: P2TREthereumHistoryCoverageCounters
}

type AccumulatorBlockRow = {
  block_number: string | number
  block_hash: string
  history_root: string
  required_event_count: string | number
  cumulative_block_count: string | number
  cumulative_transaction_count: string | number
  cumulative_receipt_count: string | number
  cumulative_log_count: string | number
}

type NormalizedAccumulatorBlock = {
  blockNumber: number
  blockHash: string
  historyRoot: string
  requiredEventCount: number
  coverageCounters: P2TREthereumHistoryCoverageCounters
}

const CURSOR_SELECT = `SELECT accumulator_id,
  encode(store_fingerprint, 'hex') AS store_fingerprint,
  chain_id, encode(descriptor_set_hash, 'hex') AS descriptor_set_hash,
  checkpoint_block_number,
  encode(checkpoint_block_hash, 'hex') AS checkpoint_block_hash,
  current_block_number, encode(current_block_hash, 'hex') AS current_block_hash,
  encode(history_root, 'hex') AS history_root, required_event_count,
  cumulative_block_count, cumulative_transaction_count,
  cumulative_receipt_count, cumulative_log_count
FROM p2tr_ethereum_history_accumulators
WHERE accumulator_id = $1`

function cursorFromRow(row: CursorRow): NormalizedCursor {
  return {
    storeFingerprint: bytes32(
      row.store_fingerprint,
      "history store fingerprint"
    ),
    chainID: positiveInteger(
      databaseInteger(row.chain_id, "history chain ID"),
      "history chain ID"
    ),
    descriptorSetHash: bytes32(
      row.descriptor_set_hash,
      "history descriptor set"
    ),
    checkpoint: {
      blockNumber: databaseInteger(
        row.checkpoint_block_number,
        "history checkpoint"
      ),
      blockHash: bytes32(row.checkpoint_block_hash, "history checkpoint hash"),
    },
    currentBlockNumber: databaseInteger(
      row.current_block_number,
      "history cursor"
    ),
    currentBlockHash: bytes32(row.current_block_hash, "history cursor hash"),
    historyRoot: bytes32(row.history_root, "history root"),
    requiredEventCount: databaseInteger(
      row.required_event_count,
      "history event count"
    ),
    coverageCounters: coverageCountersFromRow(row),
  }
}

function accumulatorBlockFromRow(
  row: AccumulatorBlockRow
): NormalizedAccumulatorBlock {
  return {
    blockNumber: databaseInteger(row.block_number, "history block"),
    blockHash: bytes32(row.block_hash, "history block hash"),
    historyRoot: bytes32(row.history_root, "history block root"),
    requiredEventCount: databaseInteger(
      row.required_event_count,
      "history event count"
    ),
    coverageCounters: coverageCountersFromRow(row),
  }
}

function coverageCountersFromRow(row: {
  required_event_count: string | number
  cumulative_block_count: string | number
  cumulative_transaction_count: string | number
  cumulative_receipt_count: string | number
  cumulative_log_count: string | number
}): P2TREthereumHistoryCoverageCounters {
  return {
    blocks: databaseInteger(
      row.cumulative_block_count,
      "history block coverage"
    ),
    transactions: databaseInteger(
      row.cumulative_transaction_count,
      "history transaction coverage"
    ),
    receipts: databaseInteger(
      row.cumulative_receipt_count,
      "history receipt coverage"
    ),
    logs: databaseInteger(row.cumulative_log_count, "history log coverage"),
    requiredEvents: databaseInteger(
      row.required_event_count,
      "history required-event coverage"
    ),
  }
}

function normalizeDatabaseIdentity(
  value: P2TRPostgresDatabaseIdentity
): P2TRPostgresDatabaseIdentity {
  if (
    typeof value.systemIdentifier !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(value.systemIdentifier) ||
    BigInt(value.systemIdentifier) > 0xffffffffffffffffn
  ) {
    throw new Error("PostgreSQL system identifier is malformed")
  }
  const serverAddress =
    value.serverAddress === null
      ? null
      : boundedString(value.serverAddress, 255, "PostgreSQL server address")
  const serverPort =
    value.serverPort === null
      ? null
      : positiveInteger(value.serverPort, "PostgreSQL server port")
  if (serverPort !== null && serverPort > 65535) {
    throw new Error("PostgreSQL server port is out of range")
  }
  return Object.freeze({
    systemIdentifier: value.systemIdentifier,
    serverAddress,
    serverPort,
    databaseOID: positiveInteger(value.databaseOID, "PostgreSQL database OID"),
    databaseName: boundedString(
      value.databaseName,
      255,
      "PostgreSQL database name"
    ),
    currentRole: boundedString(
      value.currentRole,
      255,
      "PostgreSQL current role"
    ),
  })
}

function databaseIdentityFingerprint(
  identity: P2TRPostgresDatabaseIdentity
): string {
  return `0x${createHash("sha256")
    .update("tbtc-p2tr-ethereum-history-database/v2\u0000", "utf8")
    .update(canonicalJSON(identity), "utf8")
    .digest("hex")}`
}

function databaseClusterFingerprint(
  identity: P2TRPostgresDatabaseIdentity
): string {
  return `0x${createHash("sha256")
    .update("tbtc-p2tr-ethereum-history-cluster/v1\u0000", "utf8")
    .update(
      canonicalJSON({
        systemIdentifier: identity.systemIdentifier,
        serverAddress: identity.serverAddress,
        serverPort: identity.serverPort,
      }),
      "utf8"
    )
    .digest("hex")}`
}

function descriptorFor(
  descriptors: readonly P2TRCanonicalEthereumEventDescriptor[],
  log: P2TRCanonicalEthereumRawLog
): P2TRCanonicalEthereumEventDescriptor | undefined {
  return descriptors.find(
    (descriptor) =>
      address(descriptor.emitter, "event emitter") === log.address &&
      bytes32(descriptor.topic0, "event topic0") === log.topics[0]
  )
}

function eventRecord(
  chainID: number,
  descriptor: P2TRCanonicalEthereumEventDescriptor,
  log: P2TRCanonicalEthereumRawLog,
  payload: Readonly<Record<string, unknown>>
): unknown {
  return {
    eventID: `0x${createHash("sha256")
      .update(
        canonicalJSON({
          chainID,
          address: log.address,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        })
      )
      .digest("hex")}`,
    eventKind: descriptor.kind,
    decoderSchemaID: descriptor.decoderSchemaID,
    decoderCodeHash: bytes32(descriptor.decoderCodeHash, "decoder code"),
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    emitter: log.address,
    topic0: log.topics[0],
    topics: [...log.topics],
    data: log.data,
    decodedPayload: structuredClone(payload),
  }
}

function validateRequest(
  request: Parameters<
    P2TRProductionEthereumHistoryAccumulator["synchronizeTo"]
  >[0]
): void {
  positiveInteger(request.chainID, "history chain ID")
  nonNegativeInteger(request.checkpoint.blockNumber, "history checkpoint")
  bytes32(request.checkpoint.blockHash, "history checkpoint hash")
  nonNegativeInteger(request.target.blockNumber, "history target")
  bytes32(request.target.blockHash, "history target hash")
  if (request.target.blockNumber < request.checkpoint.blockNumber) {
    throw new Error("Ethereum history target predates its checkpoint")
  }
  positiveInteger(request.maxTailBlocks, "history tail block bound")
  positiveInteger(request.maxTailTransactions, "history tail transaction bound")
  positiveInteger(request.maxTailLogs, "history tail log bound")
  positiveInteger(request.maxDecodedPayloadBytes, "history payload bound")
  if (
    request.descriptors.length !==
    P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS.length
  ) {
    throw new Error("History accumulator descriptor set is incomplete")
  }
  assertDeadline(request.deadlineAt)
}

function assertDeadline(deadlineAt: number): void {
  if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) {
    throw new Error("Ethereum history dispatch deadline expired")
  }
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Canonical history contains unsafe number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`
  }
  throw new Error("Canonical history contains unsupported value")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function hexBuffer(value: string, label: string): Buffer {
  return Buffer.from(bytes32(value, label).slice(2), "hex")
}

function bytes32(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{64}$/.test(normalized))
    throw new Error(`${label} must be 32 bytes`)
  return `0x${normalized}`
}

function address(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{40}$/.test(normalized))
    throw new Error(`${label} must be 20 bytes`)
  return `0x${normalized}`
}

function boundedString(value: string, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error(`${label} is malformed`)
  return value
}

function databaseInteger(value: string | number, label: string): number {
  return nonNegativeInteger(
    typeof value === "number" ? value : Number(value),
    label
  )
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be positive`)
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be non-negative`)
  return value
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("PostgreSQL transaction outcome is unknown")
}
