import { AsyncLocalStorage } from "node:async_hooks"
import type {
  P2TRBitcoinChainPoint,
  P2TRBitcoinOutpoint,
  P2TRCanonicalBitcoinCursor,
  P2TRCanonicalBitcoinIndexStore,
  P2TRCanonicalBitcoinOrphanedCandidate,
  P2TRCanonicalBitcoinScan,
  P2TRCanonicalEvidenceStore,
  P2TRCrossSourceWatermark,
  P2TRFrostWalletBinding,
  P2TRTaprootDepositBinding,
  P2TRTrackedOutpoint,
  P2TRUnmatchedProofEnvelope,
} from "./P2TRCanonicalBitcoinIndex.js"

export type P2TRPostgresQueryResult<Row> = {
  rows: Row[]
  rowCount: number | null
}

/** Structurally compatible with a `pg` PoolClient. */
export interface P2TRPostgresClient {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>>
  /** Passing an error forces `pg` to destroy, rather than pool, the session. */
  release(error?: Error): void
}

/** Structurally compatible with a `pg` Pool. */
export interface P2TRPostgresPool {
  connect(): Promise<P2TRPostgresClient>
}

/** Query-only capability bound to this store's active serializable transaction. */
export interface P2TRPostgresTransactionSession {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>>
}

const p2trPostgresTransactionSessions = new WeakSet<object>()

/**
 * Rejects structurally compatible, but autocommit, sessions. Only the
 * transaction coordinator can mint this capability.
 */
export function assertP2TRPostgresTransactionSession(
  session: P2TRPostgresTransactionSession
): void {
  if (
    typeof session !== "object" ||
    session === null ||
    !p2trPostgresTransactionSessions.has(session)
  ) {
    throw new Error(
      "PostgreSQL adapter requires a coordinator-owned transaction session"
    )
  }
}

export type PostgresP2TRCanonicalIndexStoreOptions = {
  storeID: string
  maxJournalBlocks: number
  maxJournalTransactions: number
  maxJournalInputs: number
  maxJournalOutputs: number
  maxPendingDepositReveals: number
  maxUnmatchedProofs: number
  maxProofMutationBatchSize: number
  maxProofPageSize: number
  maxProofPayloadBytes: number
  statementTimeoutMs?: number
}

type CursorRow = {
  store_id: string
  configuration_fingerprint: string
  network: string
  checkpoint_height: string | number
  checkpoint_hash: string
  current_height: string | number
  current_hash: string
}

const REQUIRED_SCHEMA_VERSION = 1
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000
type P2TRPostgresRetryableTransactionSQLState = "40001" | "40P01"

class P2TRPostgresRetryableStatementError extends Error {
  constructor(
    readonly sqlState: P2TRPostgresRetryableTransactionSQLState,
    cause: unknown
  ) {
    super(`PostgreSQL statement aborted with retryable SQLSTATE ${sqlState}`, {
      cause,
    })
    this.name = "P2TRPostgresRetryableStatementError"
  }
}

/**
 * PostgreSQL 16 canonical evidence store. Pass a configured `pg.Pool`; the
 * structural boundary keeps tests deterministic without substituting database
 * semantics in production.
 */
export class PostgresP2TRCanonicalIndexStore
  implements P2TRCanonicalEvidenceStore, P2TRCanonicalBitcoinIndexStore
{
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerAtomicTransactions = true as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string

  private readonly maxJournalBlocks: number
  private readonly maxJournalTransactions: number
  private readonly maxJournalInputs: number
  private readonly maxJournalOutputs: number
  private readonly maxPendingDepositReveals: number
  private readonly maxUnmatchedProofs: number
  private readonly maxProofMutationBatchSize: number
  private readonly maxProofPageSize: number
  private readonly maxProofPayloadBytes: number
  private readonly statementTimeoutMs: number
  private readonly transaction = new AsyncLocalStorage<P2TRPostgresClient>()
  private readonly transactionalParticipants = new WeakSet<object>()
  private readonly retryableTransactionErrors = new WeakMap<
    object,
    P2TRPostgresRetryableTransactionSQLState
  >()

  constructor(
    private readonly pool: P2TRPostgresPool,
    options: PostgresP2TRCanonicalIndexStoreOptions
  ) {
    this.p2trSignatureFraudWatchtowerTransactionalStoreID = boundedString(
      options.storeID,
      255,
      "PostgreSQL watchtower store ID"
    )
    this.maxJournalBlocks = positiveInteger(
      options.maxJournalBlocks,
      "PostgreSQL Bitcoin block journal capacity"
    )
    this.maxJournalTransactions = positiveInteger(
      options.maxJournalTransactions,
      "PostgreSQL Bitcoin transaction journal capacity"
    )
    this.maxJournalInputs = positiveInteger(
      options.maxJournalInputs,
      "PostgreSQL Bitcoin input journal capacity"
    )
    this.maxJournalOutputs = positiveInteger(
      options.maxJournalOutputs,
      "PostgreSQL Bitcoin output journal capacity"
    )
    this.maxPendingDepositReveals = positiveInteger(
      options.maxPendingDepositReveals,
      "PostgreSQL pending deposit reveal capacity"
    )
    this.maxUnmatchedProofs = positiveInteger(
      options.maxUnmatchedProofs,
      "PostgreSQL unmatched proof capacity"
    )
    this.maxProofMutationBatchSize = positiveInteger(
      options.maxProofMutationBatchSize,
      "PostgreSQL proof mutation batch bound"
    )
    this.maxProofPageSize = positiveInteger(
      options.maxProofPageSize,
      "PostgreSQL proof page bound"
    )
    this.maxProofPayloadBytes = positiveInteger(
      options.maxProofPayloadBytes,
      "PostgreSQL proof payload byte bound"
    )
    this.statementTimeoutMs = positiveInteger(
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      "PostgreSQL statement timeout"
    )
    this.transactionalParticipants.add(this)
  }

  registerP2TRSignatureFraudWatchtowerTransactionalParticipant(
    participant: object
  ): void {
    if (typeof participant !== "object" || participant === null) {
      throw new Error("PostgreSQL transactional participant must be an object")
    }
    this.transactionalParticipants.add(participant)
  }

  createP2TRSignatureFraudWatchtowerTransactionalAdapter<T extends object>(
    factory: (session: P2TRPostgresTransactionSession) => T
  ): T {
    const session: P2TRPostgresTransactionSession = {
      query: <Row = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[]
      ) => {
        const client = this.requireTransactionClient()
        return client.query<Row>(text, values).catch((error: unknown) => {
          const sqlState = postgresRetryableTransactionSQLState(error)
          if (sqlState !== undefined) {
            throw new P2TRPostgresRetryableStatementError(sqlState, error)
          }
          throw error
        })
      },
    }
    p2trPostgresTransactionSessions.add(session)
    const adapter = factory(session)
    if (typeof adapter !== "object" || adapter === null) {
      throw new Error(
        "PostgreSQL transactional adapter factory must return an object"
      )
    }
    this.registerP2TRSignatureFraudWatchtowerTransactionalParticipant(adapter)
    return adapter
  }

  assertP2TRSignatureFraudWatchtowerTransactionalParticipants(
    participants: readonly object[]
  ): void {
    for (const participant of participants) {
      if (
        typeof participant !== "object" ||
        participant === null ||
        !this.transactionalParticipants.has(participant)
      ) {
        throw new Error(
          "P2TR watchtower dependency is not owned by this PostgreSQL transaction coordinator"
        )
      }
    }
  }

  readP2TRSignatureFraudWatchtowerRetryableTransactionSQLState(
    error: unknown
  ): P2TRPostgresRetryableTransactionSQLState | undefined {
    if (typeof error !== "object" || error === null) return undefined
    return this.retryableTransactionErrors.get(error)
  }

  isP2TRSignatureFraudWatchtowerTransactionActive(): boolean {
    return this.transaction.getStore() !== undefined
  }

  assertP2TRSignatureFraudWatchtowerSharedStore(dependencies: {
    persistence: unknown
    transactionSource: unknown
    bridgeLifecycleEventSource: unknown
  }): void {
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (
        typeof dependency !== "object" ||
        dependency === null ||
        !this.transactionalParticipants.has(dependency)
      ) {
        throw new Error(
          `P2TR watchtower ${name} is not owned by this PostgreSQL transaction coordinator`
        )
      }
    }
  }

  async runInP2TRSignatureFraudWatchtowerTransaction<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const active = this.transaction.getStore()
    if (active !== undefined) return operation()

    const client = await this.pool.connect()
    let releaseError: Error | undefined
    let transactionStarted = false
    let transactionResolved = false
    try {
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
        transactionStarted = true
      } catch (error) {
        releaseError = asError(error, "PostgreSQL BEGIN outcome is unknown")
        throw error
      }
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${this.statementTimeoutMs}ms`,
      ])
      await this.assertDatabaseReady(client)
      const result = await this.transaction.run(client, operation)
      try {
        await client.query("COMMIT")
        transactionResolved = true
      } catch (error) {
        // COMMIT failure is outcome-unknown. Never return this session to the
        // pool where a retained transaction or advisory state could leak.
        releaseError = asError(error, "PostgreSQL COMMIT failed")
        throw error
      }
      return result
    } catch (error) {
      let retryableSQLState:
        | P2TRPostgresRetryableTransactionSQLState
        | undefined
      if (error instanceof P2TRPostgresRetryableStatementError) {
        retryableSQLState = error.sqlState
      }
      if (transactionStarted && !transactionResolved) {
        try {
          await client.query("ROLLBACK")
          transactionResolved = true
        } catch (rollbackError) {
          releaseError ??= asError(
            rollbackError,
            "PostgreSQL ROLLBACK outcome is unknown"
          )
        }
      }
      if (retryableSQLState !== undefined && transactionResolved) {
        const retryable = new Error(
          `PostgreSQL transaction safely aborted with retryable SQLSTATE ${retryableSQLState}`,
          { cause: error }
        )
        this.retryableTransactionErrors.set(retryable, retryableSQLState)
        throw retryable
      }
      throw error
    } finally {
      client.release(releaseError)
    }
  }

  async loadBitcoinCursor(): Promise<P2TRCanonicalBitcoinCursor | undefined> {
    return this.withClient(async (client) => {
      const result = await client.query<CursorRow>(
        `SELECT store_id,
                encode(configuration_fingerprint, 'hex') AS configuration_fingerprint,
                network,
                checkpoint_height,
                encode(checkpoint_hash, 'hex') AS checkpoint_hash,
                current_height,
                encode(current_hash, 'hex') AS current_hash
           FROM p2tr_bitcoin_cursor
          WHERE singleton = true`
      )
      if (result.rows.length === 0) return undefined
      if (result.rows.length !== 1) {
        throw new Error("PostgreSQL Bitcoin cursor singleton is inconsistent")
      }
      const row = result.rows[0]
      if (
        row.store_id !== this.p2trSignatureFraudWatchtowerTransactionalStoreID
      ) {
        throw new Error("PostgreSQL Bitcoin cursor belongs to another store ID")
      }
      return {
        configurationFingerprint: normalizeBytes32(
          row.configuration_fingerprint,
          "stored Bitcoin configuration fingerprint"
        ),
        network: boundedString(row.network, 32, "stored Bitcoin network"),
        checkpoint: {
          height: databaseInteger(row.checkpoint_height, "checkpoint height"),
          hash: normalizeBytes32(row.checkpoint_hash, "checkpoint hash"),
        },
        current: {
          height: databaseInteger(row.current_height, "cursor height"),
          hash: normalizeBytes32(row.current_hash, "cursor hash"),
        },
      }
    })
  }

  async loadStoredBlockHash(height: number): Promise<string | undefined> {
    nonNegativeInteger(height, "Bitcoin block height")
    return this.withClient(async (client) => {
      const result = await client.query<{ hash: string }>(
        `SELECT encode(hash, 'hex') AS hash
           FROM p2tr_bitcoin_blocks
          WHERE height = $1`,
        [height]
      )
      if (result.rows.length > 1) {
        throw new Error("PostgreSQL Bitcoin block journal is inconsistent")
      }
      return result.rows[0]?.hash
    })
  }

  async loadTrackedOutpoints(
    outpoints: P2TRBitcoinOutpoint[]
  ): Promise<P2TRTrackedOutpoint[]> {
    if (outpoints.length === 0) return []
    const requested = outpoints.map((outpoint) => ({
      txid: normalizeBytes32(outpoint.txid, "requested outpoint txid"),
      vout: uint32(outpoint.vout, "requested outpoint index"),
    }))
    return this.withClient(async (client) => {
      const result = await client.query<TrackedOutpointRow>(
        `WITH requested AS (
           SELECT decode(item.txid, 'hex') AS txid, item.vout
             FROM jsonb_to_recordset($1::jsonb) AS item(txid text, vout bigint)
         )
         SELECT DISTINCT encode(tracked.txid, 'hex') AS txid,
                tracked.vout,
                tracked.kind,
                encode(tracked.wallet_id, 'hex') AS wallet_id,
                encode(tracked.output_key, 'hex') AS output_key,
                tracked.value_sats,
                encode(tracked.script_pubkey, 'hex') AS script_pubkey,
                tracked.created_height,
                encode(tracked.created_hash, 'hex') AS created_hash
           FROM p2tr_tracked_outpoints tracked
           JOIN requested
             ON requested.txid = tracked.txid
            AND requested.vout = tracked.vout`,
        [JSON.stringify(requested)]
      )
      return result.rows.map(trackedOutpointFromRow)
    })
  }

  async loadRegisteredWalletIDs(): Promise<string[]> {
    return this.withClient(async (client) => {
      const result = await client.query<{ wallet_id: string }>(
        `SELECT encode(wallet_id, 'hex') AS wallet_id
           FROM p2tr_frost_wallet_bindings
          ORDER BY wallet_id
          LIMIT $1`,
        [this.maxJournalOutputs + 1]
      )
      if (result.rows.length > this.maxJournalOutputs) {
        throw new Error(
          "Registered wallet registry exceeds its journal-derived bound"
        )
      }
      return result.rows.map((row) =>
        normalizeBytes32(row.wallet_id, "registered wallet ID")
      )
    })
  }

  async loadCandidatesAbove(
    height: number
  ): Promise<P2TRCanonicalBitcoinOrphanedCandidate[]> {
    nonNegativeInteger(height, "Bitcoin common-ancestor height")
    return this.withClient(async (client) => {
      const result = await client.query<{
        txid: string
        wtxid: string
        block_height: string | number
        block_hash: string
      }>(
        `SELECT encode(txid, 'hex') AS txid,
                encode(wtxid, 'hex') AS wtxid,
                block_height,
                encode(block_hash, 'hex') AS block_hash
           FROM p2tr_bitcoin_candidates
          WHERE block_height > $1
          ORDER BY block_height, txid, wtxid
          LIMIT $2`,
        [height, this.maxJournalTransactions + 1]
      )
      if (result.rows.length > this.maxJournalTransactions) {
        throw new Error(
          "Orphaned candidate set exceeds its journal-derived bound"
        )
      }
      return result.rows.map((row) => ({
        txid: normalizeBytes32(row.txid, "orphaned candidate txid"),
        wtxid: normalizeBytes32(row.wtxid, "orphaned candidate wtxid"),
        block: {
          height: databaseInteger(row.block_height, "candidate block height"),
          hash: normalizeBytes32(row.block_hash, "candidate block hash"),
        },
      }))
    })
  }

  async loadPendingCandidates(
    limit: number,
    atOrBelowHeight: number
  ): Promise<{
    candidates: P2TRCanonicalBitcoinScan["candidates"]
    complete: boolean
  }> {
    positiveInteger(limit, "pending candidate page size")
    nonNegativeInteger(atOrBelowHeight, "pending candidate maximum height")
    return this.withClient(async (client) => {
      const result = await client.query<CandidateRow>(
        `SELECT encode(txid, 'hex') AS txid,
                encode(wtxid, 'hex') AS wtxid,
                block_height,
                encode(block_hash, 'hex') AS block_hash,
                encode(raw_transaction, 'hex') AS raw_transaction,
                input_prevouts,
                wallet_input_key_bindings
           FROM p2tr_bitcoin_candidates
          WHERE delivered = false
            AND block_height <= $1
          ORDER BY block_height, txid, wtxid
          LIMIT $2`,
        [atOrBelowHeight, limit + 1]
      )
      return {
        candidates: result.rows.slice(0, limit).map(candidateFromRow),
        complete: result.rows.length <= limit,
      }
    })
  }

  async applyBitcoinScan(scan: P2TRCanonicalBitcoinScan): Promise<void> {
    validateBitcoinScan(scan)
    await this.mutate(async (client) => {
      const cursorResult = await client.query<CursorRow>(
        `SELECT store_id,
                encode(configuration_fingerprint, 'hex') AS configuration_fingerprint,
                network,
                checkpoint_height,
                encode(checkpoint_hash, 'hex') AS checkpoint_hash,
                current_height,
                encode(current_hash, 'hex') AS current_hash
           FROM p2tr_bitcoin_cursor
          WHERE singleton = true
          FOR UPDATE`
      )
      const stored = cursorResult.rows[0]
      if (stored === undefined) {
        if (scan.expectedCursor !== undefined) {
          throw new Error(
            "PostgreSQL Bitcoin cursor is absent but scan expected an existing cursor"
          )
        }
        if (!samePoint(scan.rollbackTo, scan.checkpoint)) {
          throw new Error("Initial Bitcoin scan must start at its checkpoint")
        }
        await client.query(
          `INSERT INTO p2tr_bitcoin_blocks
             (height, hash, parent_hash, is_checkpoint)
           VALUES ($1, $2, $3, true)`,
          [
            scan.checkpoint.height,
            hexBuffer(scan.checkpoint.hash, "checkpoint hash"),
            Buffer.alloc(32),
          ]
        )
        await client.query(
          `INSERT INTO p2tr_bitcoin_cursor
             (store_id, configuration_fingerprint, network,
              checkpoint_height, checkpoint_hash, current_height, current_hash)
           VALUES ($1, $2, $3, $4, $5, $4, $5)`,
          [
            this.p2trSignatureFraudWatchtowerTransactionalStoreID,
            hexBuffer(
              scan.configurationFingerprint,
              "configuration fingerprint"
            ),
            scan.network,
            scan.checkpoint.height,
            hexBuffer(scan.checkpoint.hash, "checkpoint hash"),
          ]
        )
      } else {
        this.assertCursorMatchesScan(stored, scan)
      }

      const rollbackBlock = await client.query<{ hash: string }>(
        `SELECT encode(hash, 'hex') AS hash
           FROM p2tr_bitcoin_blocks
          WHERE height = $1
          FOR UPDATE`,
        [scan.rollbackTo.height]
      )
      if (
        rollbackBlock.rows.length !== 1 ||
        rollbackBlock.rows[0].hash !== scan.rollbackTo.hash
      ) {
        throw new Error(
          "PostgreSQL Bitcoin rollback point is absent or hash-mismatched"
        )
      }

      await client.query(
        `UPDATE p2tr_tracked_outpoints
            SET spent_by_txid = NULL,
                spent_by_wtxid = NULL,
                spent_input_index = NULL,
                spent_height = NULL,
                spent_hash = NULL
          WHERE spent_height > $1`,
        [scan.rollbackTo.height]
      )
      await client.query(
        `DELETE FROM p2tr_tracked_outpoints
          WHERE kind = 'wallet'
            AND created_height > $1`,
        [scan.rollbackTo.height]
      )
      await client.query(
        `UPDATE p2tr_pending_deposit_reveals
            SET resolved_funding_height = NULL,
                resolved_funding_hash = NULL,
                resolved_at = NULL
          WHERE resolved_funding_height > $1`,
        [scan.rollbackTo.height]
      )
      await client.query(
        `DELETE FROM p2tr_tracked_outpoints
          WHERE kind = 'deposit'
            AND created_height > $1`,
        [scan.rollbackTo.height]
      )
      // Move the FK-pinned cursor inside the retained chain before deleting
      // orphaned blocks. The transaction's final cursor update advances it to
      // nextCursor after replacement blocks and evidence are durable.
      await client.query(
        `UPDATE p2tr_bitcoin_cursor
            SET current_height = $1,
                current_hash = $2,
                updated_at = clock_timestamp()
          WHERE singleton = true`,
        [
          scan.rollbackTo.height,
          hexBuffer(scan.rollbackTo.hash, "rollback cursor hash"),
        ]
      )
      await client.query(
        `DELETE FROM p2tr_bitcoin_blocks
          WHERE height > $1`,
        [scan.rollbackTo.height]
      )

      await this.assertJournalCapacity(client, scan)
      for (const block of scan.blocks) {
        await client.query(
          `INSERT INTO p2tr_bitcoin_blocks
             (height, hash, parent_hash, is_checkpoint)
           VALUES ($1, $2, $3, false)`,
          [
            block.height,
            hexBuffer(block.hash, "block hash"),
            hexBuffer(block.parentHash, "block parent hash"),
          ]
        )
        for (const [
          transactionIndex,
          transaction,
        ] of block.transactions.entries()) {
          const inputPrevouts = transaction.coinbase
            ? []
            : transaction.inputs.map((input) => {
                const prevout = input.authenticatedPrevout
                if (
                  prevout === undefined ||
                  prevout.txid !== input.txid ||
                  prevout.vout !== input.vout
                ) {
                  throw new Error(
                    `Bitcoin transaction ${transaction.txid} is missing an authenticated prevout`
                  )
                }
                return {
                  txid: prevout.txid,
                  vout: prevout.vout,
                  valueSats: prevout.valueSats,
                  scriptPubKey: prevout.scriptPubKey,
                }
              })
          await client.query(
            `INSERT INTO p2tr_bitcoin_transactions
               (txid, wtxid, block_height, block_hash, transaction_index,
                raw_transaction, input_prevouts)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
            [
              hexBuffer(transaction.txid, "transaction ID"),
              hexBuffer(transaction.wtxid, "witness transaction ID"),
              block.height,
              hexBuffer(block.hash, "transaction block hash"),
              transactionIndex,
              hexBuffer(transaction.rawTransactionHex, "raw transaction"),
              JSON.stringify(inputPrevouts),
            ]
          )
          for (const output of transaction.outputs) {
            await client.query(
              `INSERT INTO p2tr_bitcoin_outputs
                 (txid, wtxid, vout, value_sats, script_pubkey,
                  block_height, block_hash)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                hexBuffer(transaction.txid, "output transaction ID"),
                hexBuffer(transaction.wtxid, "output witness transaction ID"),
                output.vout,
                output.valueSats,
                hexBuffer(output.scriptPubKey, "output scriptPubKey"),
                block.height,
                hexBuffer(block.hash, "output block hash"),
              ]
            )
          }
          if (!transaction.coinbase) {
            for (const input of transaction.inputs) {
              await client.query(
                `INSERT INTO p2tr_bitcoin_inputs
                   (spending_txid, spending_wtxid, input_index, prev_txid, prev_vout,
                    block_height, block_hash)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                  hexBuffer(transaction.txid, "spending transaction ID"),
                  hexBuffer(
                    transaction.wtxid,
                    "spending witness transaction ID"
                  ),
                  input.inputIndex,
                  hexBuffer(input.txid, "previous transaction ID"),
                  input.vout,
                  block.height,
                  hexBuffer(block.hash, "input block hash"),
                ]
              )
            }
          }
        }
      }

      for (const tracked of scan.trackedOutpoints) {
        await this.insertTrackedOutpoint(client, tracked)
      }
      for (const spend of scan.trackedOutpointSpends) {
        const result = await client.query(
          `UPDATE p2tr_tracked_outpoints
              SET spent_by_txid = $3,
                  spent_by_wtxid = $4,
                  spent_input_index = $5,
                  spent_height = $6,
                  spent_hash = $7
            WHERE txid = $1
              AND vout = $2
              AND spent_by_txid IS NULL`,
          [
            hexBuffer(spend.txid, "spent outpoint txid"),
            spend.vout,
            hexBuffer(spend.spendingTxid, "spending transaction ID"),
            hexBuffer(spend.spendingWtxid, "spending witness transaction ID"),
            spend.inputIndex,
            spend.spentAt.height,
            hexBuffer(spend.spentAt.hash, "spend block hash"),
          ]
        )
        if (result.rowCount !== 1) {
          throw new Error(
            `Tracked outpoint ${spend.txid}:${spend.vout} is absent or already spent`
          )
        }
      }

      const acknowledged = new Map(
        scan.acknowledgedCandidates.map((identity) => [
          candidateIdentityKey(identity),
          identity,
        ])
      )
      for (const candidate of scan.candidates) {
        await this.insertCandidate(
          client,
          candidate,
          acknowledged.has(
            candidateIdentityKey({
              txid: candidate.txid,
              wtxid: candidate.wtxid,
              blockHash: candidate.block.hash,
            })
          )
        )
      }
      await this.reconcilePendingDepositReveals(client)
      if (acknowledged.size > 0) {
        const result = await client.query<{ identity: string }>(
          `WITH acknowledged AS (
             SELECT decode(item.block_hash, 'hex') AS block_hash,
                    decode(item.txid, 'hex') AS txid,
                    decode(item.wtxid, 'hex') AS wtxid
               FROM jsonb_to_recordset($1::jsonb)
                    AS item(block_hash text, txid text, wtxid text)
           )
           UPDATE p2tr_bitcoin_candidates candidate
              SET delivered = true,
                  delivered_at = COALESCE(delivered_at, clock_timestamp())
             FROM acknowledged
            WHERE candidate.block_hash = acknowledged.block_hash
              AND candidate.txid = acknowledged.txid
              AND candidate.wtxid = acknowledged.wtxid
          RETURNING encode(candidate.block_hash, 'hex') || ':' ||
                    encode(candidate.txid, 'hex') || ':' ||
                    encode(candidate.wtxid, 'hex') AS identity`,
          [
            JSON.stringify(
              [...acknowledged.values()].map((identity) => ({
                block_hash: identity.blockHash,
                txid: identity.txid,
                wtxid: identity.wtxid,
              }))
            ),
          ]
        )
        if (result.rows.length !== acknowledged.size) {
          throw new Error(
            "PostgreSQL candidate acknowledgement referenced an absent transaction"
          )
        }
      }

      const cursorUpdate = await client.query(
        `UPDATE p2tr_bitcoin_cursor
            SET current_height = $1,
                current_hash = $2,
                updated_at = clock_timestamp()
          WHERE singleton = true`,
        [
          scan.nextCursor.height,
          hexBuffer(scan.nextCursor.hash, "next cursor hash"),
        ]
      )
      if (cursorUpdate.rowCount !== 1) {
        throw new Error("PostgreSQL Bitcoin cursor update failed")
      }
    })
  }

  async addTaprootDepositBindings(
    bindings: P2TRTaprootDepositBinding[]
  ): Promise<void> {
    if (bindings.length === 0) return
    if (bindings.length > this.maxProofMutationBatchSize) {
      throw new Error(
        "Deposit reveal batch exceeds the configured mutation bound"
      )
    }
    await this.mutate(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('p2tr-pending-deposit-capacity', 0))"
      )
      for (const binding of bindings) {
        validateDepositBinding(binding)
        const insert = await client.query(
          `INSERT INTO p2tr_pending_deposit_reveals
             (source_event_id, funding_txid, funding_vout, wallet_id,
              output_key, ethereum_block_number, ethereum_block_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (source_event_id) DO NOTHING`,
          [
            binding.sourceEventID,
            hexBuffer(binding.txid, "deposit funding txid"),
            uint32(binding.vout, "deposit funding output index"),
            hexBuffer(binding.walletID, "deposit wallet ID"),
            hexBuffer(binding.outputKey, "deposit output key"),
            binding.ethereum.blockNumber,
            hexBuffer(
              binding.ethereum.blockHash,
              "deposit Ethereum block hash"
            ),
          ]
        )
        if (insert.rowCount === 0) {
          await this.assertPendingDepositReveal(client, binding)
        }
      }
      await this.reconcilePendingDepositReveals(client)
      const count = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count
           FROM p2tr_pending_deposit_reveals
          WHERE resolved_at IS NULL`
      )
      if (
        count.rows.length !== 1 ||
        databaseInteger(count.rows[0].count, "pending deposit count") >
          this.maxPendingDepositReveals
      ) {
        throw new Error(
          `Pending deposit reveal backlog reached its ${this.maxPendingDepositReveals}-item capacity; lifecycle cursor advancement halted`
        )
      }
    })
  }

  async countPendingDepositReveals(): Promise<number> {
    return this.withClient(async (client) => {
      const result = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count
           FROM p2tr_pending_deposit_reveals
          WHERE resolved_at IS NULL`
      )
      if (result.rows.length !== 1) {
        throw new Error("Pending deposit reveal count failed")
      }
      return databaseInteger(result.rows[0].count, "pending deposit count")
    })
  }

  async addFrostWalletBindings(
    bindings: P2TRFrostWalletBinding[]
  ): Promise<void> {
    if (bindings.length === 0) return
    if (bindings.length > this.maxProofMutationBatchSize) {
      throw new Error("FROST wallet binding batch exceeds the mutation bound")
    }
    await this.mutate(async (client) => {
      for (const binding of bindings) {
        validateFrostWalletBinding(binding)
        const insert = await client.query(
          `INSERT INTO p2tr_frost_wallet_bindings
             (wallet_id, wallet_pub_key_hash, source_event_id, ethereum_block_number,
              ethereum_block_hash)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (wallet_id) DO UPDATE
             SET wallet_pub_key_hash = EXCLUDED.wallet_pub_key_hash
           WHERE p2tr_frost_wallet_bindings.wallet_pub_key_hash IS NULL
             AND p2tr_frost_wallet_bindings.source_event_id = EXCLUDED.source_event_id
             AND p2tr_frost_wallet_bindings.ethereum_block_number = EXCLUDED.ethereum_block_number
             AND p2tr_frost_wallet_bindings.ethereum_block_hash = EXCLUDED.ethereum_block_hash`,
          [
            hexBuffer(binding.walletID, "FROST wallet ID"),
            hexBuffer(binding.walletPubKeyHash, "FROST wallet public-key hash"),
            binding.sourceEventID,
            binding.ethereum.blockNumber,
            hexBuffer(binding.ethereum.blockHash, "wallet Ethereum block hash"),
          ]
        )
        if (insert.rowCount === 0) {
          const existing = await client.query<{
            wallet_pub_key_hash: string
            source_event_id: string
            ethereum_block_number: string | number
            ethereum_block_hash: string
          }>(
            `SELECT encode(wallet_pub_key_hash, 'hex') AS wallet_pub_key_hash,
                    source_event_id,
                    ethereum_block_number,
                    encode(ethereum_block_hash, 'hex') AS ethereum_block_hash
               FROM p2tr_frost_wallet_bindings
              WHERE wallet_id = $1`,
            [hexBuffer(binding.walletID, "FROST wallet ID")]
          )
          const row = existing.rows[0]
          if (
            existing.rows.length !== 1 ||
            row.wallet_pub_key_hash !==
              normalizeBytes20(
                binding.walletPubKeyHash,
                "FROST wallet public-key hash"
              ) ||
            row.source_event_id !== binding.sourceEventID ||
            databaseInteger(
              row.ethereum_block_number,
              "wallet Ethereum block number"
            ) !== binding.ethereum.blockNumber ||
            row.ethereum_block_hash !== binding.ethereum.blockHash
          ) {
            throw new Error(
              `FROST wallet binding ${binding.walletID} conflicts with durable state`
            )
          }
          continue
        }
        await this.backfillFrostWallet(client, binding.walletID)
      }
    })
  }

  async loadFrostWalletIDByPubKeyHash(
    walletPubKeyHash: string
  ): Promise<string | undefined> {
    const normalized = normalizeBytes20(
      walletPubKeyHash,
      "FROST wallet public-key hash"
    )
    return this.withClient(async (client) => {
      const result = await client.query<{ wallet_id: string }>(
        `SELECT encode(wallet_id, 'hex') AS wallet_id
           FROM p2tr_frost_wallet_bindings
          WHERE wallet_pub_key_hash = $1`,
        [hexBuffer(normalized, "FROST wallet public-key hash")]
      )
      if (result.rows.length > 1) {
        throw new Error("FROST wallet public-key hash uniqueness is violated")
      }
      return result.rows[0] === undefined
        ? undefined
        : normalizeBytes32(result.rows[0].wallet_id, "FROST wallet ID")
    })
  }

  async rollbackEthereumEvidenceTo(point: {
    blockNumber: number
    blockHash: string
  }): Promise<void> {
    const blockNumber = nonNegativeInteger(
      point.blockNumber,
      "Ethereum rollback block number"
    )
    const blockHash = normalizeBytes32(
      point.blockHash,
      "Ethereum rollback block hash"
    )
    await this.mutate(async (client) => {
      const deposits = await client.query<{
        source_event_id: string
        txid: string
        vout: string | number
        wallet_id: string
        output_key: string
      }>(
        `SELECT source_event_id,
                encode(funding_txid, 'hex') AS txid,
                funding_vout AS vout,
                encode(wallet_id, 'hex') AS wallet_id,
                encode(output_key, 'hex') AS output_key
           FROM p2tr_pending_deposit_reveals
          WHERE ethereum_block_number > $1
             OR (ethereum_block_number = $1 AND ethereum_block_hash <> $2)
          ORDER BY ethereum_block_number, source_event_id
          LIMIT $3
          FOR UPDATE`,
        [
          blockNumber,
          hexBuffer(blockHash, "Ethereum rollback block hash"),
          this.maxPendingDepositReveals + 1,
        ]
      )
      if (deposits.rows.length > this.maxPendingDepositReveals) {
        throw new Error(
          "Ethereum deposit rollback exceeds its configured bound"
        )
      }
      for (const row of deposits.rows) {
        const binding = {
          txid: normalizeBytes32(row.txid, "orphaned deposit txid"),
          vout: uint32(row.vout, "orphaned deposit output index"),
          walletID: normalizeBytes32(
            row.wallet_id,
            "orphaned deposit wallet ID"
          ),
          outputKey: normalizeBytes32(
            row.output_key,
            "orphaned deposit output key"
          ),
        }
        await client.query(
          `UPDATE p2tr_bitcoin_candidates
              SET wallet_input_key_bindings = (
                    SELECT COALESCE(
                      jsonb_agg(value ORDER BY
                        value->>'txid',
                        (value->>'vout')::bigint,
                        value->>'walletID',
                        value->>'outputKey'),
                      '[]'::jsonb
                    )
                      FROM jsonb_array_elements(wallet_input_key_bindings)
                     WHERE value <> $1::jsonb
                  )
            WHERE wallet_input_key_bindings @> jsonb_build_array($1::jsonb)`,
          [JSON.stringify(binding)]
        )
      }
      const depositEventIDs = deposits.rows.map((row) => row.source_event_id)
      if (depositEventIDs.length > 0) {
        await client.query(
          `DELETE FROM p2tr_tracked_outpoints
            WHERE source_event_id = ANY($1::text[])`,
          [depositEventIDs]
        )
        await client.query(
          `DELETE FROM p2tr_pending_deposit_reveals
            WHERE source_event_id = ANY($1::text[])`,
          [depositEventIDs]
        )
      }

      const wallets = await client.query<{ wallet_id: string }>(
        `SELECT encode(wallet_id, 'hex') AS wallet_id
           FROM p2tr_frost_wallet_bindings
          WHERE ethereum_block_number > $1
             OR (ethereum_block_number = $1 AND ethereum_block_hash <> $2)
          ORDER BY ethereum_block_number, wallet_id
          LIMIT $3
          FOR UPDATE`,
        [
          blockNumber,
          hexBuffer(blockHash, "Ethereum rollback block hash"),
          this.maxJournalOutputs + 1,
        ]
      )
      if (wallets.rows.length > this.maxJournalOutputs) {
        throw new Error(
          "Ethereum wallet rollback exceeds its journal-derived bound"
        )
      }
      const walletIDs = wallets.rows.map((row) =>
        hexBuffer(row.wallet_id, "orphaned FROST wallet ID")
      )
      if (walletIDs.length > 0) {
        await client.query(
          `DELETE FROM p2tr_tracked_outpoints
            WHERE kind = 'wallet' AND wallet_id = ANY($1::bytea[])`,
          [walletIDs]
        )
        await client.query(
          `DELETE FROM p2tr_frost_wallet_bindings
            WHERE wallet_id = ANY($1::bytea[])`,
          [walletIDs]
        )
      }

      await client.query(
        `DELETE FROM p2tr_unmatched_proofs
          WHERE ethereum_block_number > $1
             OR (ethereum_block_number = $1 AND ethereum_block_hash <> $2)`,
        [blockNumber, hexBuffer(blockHash, "Ethereum rollback block hash")]
      )
      await client.query(
        `DELETE FROM p2tr_cross_source_watermark
          WHERE ethereum_block_number > $1
             OR (ethereum_block_number = $1 AND ethereum_block_hash <> $2)`,
        [blockNumber, hexBuffer(blockHash, "Ethereum rollback block hash")]
      )
    })
  }

  async enqueueUnmatchedProofs(
    proofs: P2TRUnmatchedProofEnvelope[]
  ): Promise<void> {
    if (proofs.length === 0) return
    if (proofs.length > this.maxProofMutationBatchSize) {
      throw new Error(
        `Unmatched proof mutation exceeds the configured ${this.maxProofMutationBatchSize}-item bound`
      )
    }
    const unique = new Map<string, P2TRUnmatchedProofEnvelope>()
    for (const proof of proofs) {
      validateProofEnvelope(proof, this.maxProofPayloadBytes)
      const existing = unique.get(proof.eventID)
      if (
        existing !== undefined &&
        canonicalJSON(existing) !== canonicalJSON(proof)
      ) {
        throw new Error(
          `Unmatched proof ${proof.eventID} conflicts in its batch`
        )
      }
      unique.set(proof.eventID, proof)
    }

    await this.mutate(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('p2tr-unmatched-proof-capacity', 0))"
      )
      const existing = await client.query<ProofRow>(
        `${PROOF_SELECT}
          WHERE event_id = ANY($1::text[])`,
        [[...unique.keys()]]
      )
      const existingByID = new Map(
        existing.rows.map((row) => [row.event_id, proofFromRow(row)])
      )
      for (const [eventID, proof] of unique) {
        const durable = existingByID.get(eventID)
        if (
          durable !== undefined &&
          canonicalJSON(durable) !== canonicalJSON(proof)
        ) {
          throw new Error(
            `Unmatched proof ${eventID} conflicts with durable state`
          )
        }
      }

      const count = await client.query<{ count: string | number }>(
        `SELECT count(*) AS count
           FROM p2tr_unmatched_proofs
          WHERE resolved_at IS NULL`
      )
      const newCount = [...unique.keys()].filter(
        (eventID) => !existingByID.has(eventID)
      ).length
      if (
        count.rows.length !== 1 ||
        databaseInteger(count.rows[0].count, "unmatched proof count") +
          newCount >
          this.maxUnmatchedProofs
      ) {
        throw new Error(
          `Unmatched proof backlog reached its ${this.maxUnmatchedProofs}-proof capacity; lifecycle cursor advancement halted`
        )
      }

      for (const [eventID, proof] of unique) {
        if (existingByID.has(eventID)) continue
        await client.query(
          `INSERT INTO p2tr_unmatched_proofs
             (event_id, ethereum_block_number, ethereum_block_hash,
              ethereum_transaction_hash, ethereum_log_index, bitcoin_txid,
              wallet_id, spend_type, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            proof.eventID,
            proof.ethereum.blockNumber,
            hexBuffer(proof.ethereum.blockHash, "proof Ethereum block hash"),
            hexBuffer(
              proof.ethereum.transactionHash,
              "proof Ethereum transaction hash"
            ),
            proof.ethereum.logIndex,
            hexBuffer(proof.bitcoinTxid, "proof Bitcoin txid"),
            hexBuffer(proof.walletID, "proof wallet ID"),
            proof.spendType,
            canonicalJSON(proof.payload),
          ]
        )
      }
    })
  }

  async listUnmatchedProofs(
    limit: number
  ): Promise<P2TRUnmatchedProofEnvelope[]> {
    positiveInteger(limit, "unmatched proof page size")
    if (limit > this.maxProofPageSize) {
      throw new Error(
        `Unmatched proof page exceeds the configured ${this.maxProofPageSize}-item bound`
      )
    }
    return this.withClient(async (client) => {
      const result = await client.query<ProofRow>(
        `${PROOF_SELECT}
          WHERE resolved_at IS NULL
          ORDER BY ethereum_block_number, ethereum_log_index
          LIMIT $1`,
        [limit]
      )
      return result.rows.map(proofFromRow)
    })
  }

  async resolveUnmatchedProofs(eventIDs: string[]): Promise<void> {
    if (eventIDs.length === 0) return
    if (eventIDs.length > this.maxProofMutationBatchSize) {
      throw new Error(
        `Unmatched proof resolution exceeds the configured ${this.maxProofMutationBatchSize}-item bound`
      )
    }
    const unique = [
      ...new Set(
        eventIDs.map((eventID) =>
          boundedString(eventID, 512, "unmatched proof event ID")
        )
      ),
    ]
    await this.mutate(async (client) => {
      const result = await client.query<{ event_id: string }>(
        `UPDATE p2tr_unmatched_proofs
            SET resolved_at = COALESCE(resolved_at, clock_timestamp())
          WHERE event_id = ANY($1::text[])
        RETURNING event_id`,
        [unique]
      )
      if (result.rows.length !== unique.length) {
        throw new Error("Unmatched proof resolution referenced an absent event")
      }
    })
  }

  async loadCrossSourceWatermark(): Promise<
    P2TRCrossSourceWatermark | undefined
  > {
    return this.withClient(async (client) => {
      const result = await client.query<WatermarkRow>(WATERMARK_SELECT)
      if (result.rows.length === 0) return undefined
      if (result.rows.length !== 1) {
        throw new Error("Cross-source watermark singleton is inconsistent")
      }
      return watermarkFromRow(result.rows[0])
    })
  }

  async advanceCrossSourceWatermark(
    expected: P2TRCrossSourceWatermark | undefined,
    next: P2TRCrossSourceWatermark
  ): Promise<void> {
    validateWatermark(next, "next cross-source watermark")
    if (expected !== undefined)
      validateWatermark(expected, "expected watermark")
    await this.mutate(async (client) => {
      const result = await client.query<WatermarkRow>(
        `${WATERMARK_SELECT} FOR UPDATE`
      )
      const durable =
        result.rows.length === 0 ? undefined : watermarkFromRow(result.rows[0])
      if (
        result.rows.length > 1 ||
        canonicalJSON(durable) !== canonicalJSON(expected)
      ) {
        throw new Error("Cross-source watermark compare-and-swap failed")
      }
      if (expected !== undefined) {
        assertMonotonicPoint(
          expected.bitcoin,
          next.bitcoin,
          "Bitcoin watermark"
        )
        if (
          next.ethereum.blockNumber < expected.ethereum.blockNumber ||
          (next.ethereum.blockNumber === expected.ethereum.blockNumber &&
            next.ethereum.blockHash !== expected.ethereum.blockHash)
        ) {
          throw new Error(
            "Ethereum watermark cannot move backward or change hash"
          )
        }
      }
      const canonicalBitcoin = await client.query<{ hash: string }>(
        `SELECT encode(hash, 'hex') AS hash
           FROM p2tr_bitcoin_blocks
          WHERE height = $1`,
        [next.bitcoin.height]
      )
      if (
        canonicalBitcoin.rows.length !== 1 ||
        canonicalBitcoin.rows[0].hash !== next.bitcoin.hash
      ) {
        throw new Error(
          "Cross-source watermark Bitcoin point is not in the canonical journal"
        )
      }
      await client.query(
        `INSERT INTO p2tr_cross_source_watermark
           (bitcoin_height, bitcoin_hash, ethereum_block_number,
            ethereum_block_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (singleton) DO UPDATE
           SET bitcoin_height = EXCLUDED.bitcoin_height,
               bitcoin_hash = EXCLUDED.bitcoin_hash,
               ethereum_block_number = EXCLUDED.ethereum_block_number,
               ethereum_block_hash = EXCLUDED.ethereum_block_hash,
               updated_at = clock_timestamp()`,
        [
          next.bitcoin.height,
          hexBuffer(next.bitcoin.hash, "watermark Bitcoin hash"),
          next.ethereum.blockNumber,
          hexBuffer(next.ethereum.blockHash, "watermark Ethereum block hash"),
        ]
      )
    })
  }

  private assertCursorMatchesScan(
    row: CursorRow,
    scan: P2TRCanonicalBitcoinScan
  ): void {
    const expected = scan.expectedCursor
    if (expected === undefined) {
      throw new Error(
        "PostgreSQL Bitcoin cursor exists but scan expected initialization"
      )
    }
    if (
      row.store_id !== this.p2trSignatureFraudWatchtowerTransactionalStoreID ||
      row.configuration_fingerprint !== scan.configurationFingerprint ||
      row.network !== scan.network ||
      databaseInteger(row.checkpoint_height, "checkpoint height") !==
        scan.checkpoint.height ||
      row.checkpoint_hash !== scan.checkpoint.hash ||
      databaseInteger(row.current_height, "cursor height") !==
        expected.height ||
      row.current_hash !== expected.hash
    ) {
      throw new Error(
        "PostgreSQL Bitcoin cursor/configuration compare-and-swap failed"
      )
    }
  }

  private async assertPendingDepositReveal(
    client: P2TRPostgresClient,
    binding: P2TRTaprootDepositBinding
  ): Promise<void> {
    const existing = await client.query<{
      funding_txid: string
      funding_vout: string | number
      wallet_id: string
      output_key: string
      ethereum_block_number: string | number
      ethereum_block_hash: string
    }>(
      `SELECT encode(funding_txid, 'hex') AS funding_txid,
              funding_vout,
              encode(wallet_id, 'hex') AS wallet_id,
              encode(output_key, 'hex') AS output_key,
              ethereum_block_number,
              encode(ethereum_block_hash, 'hex') AS ethereum_block_hash
         FROM p2tr_pending_deposit_reveals
        WHERE source_event_id = $1
        FOR UPDATE`,
      [binding.sourceEventID]
    )
    const row = existing.rows[0]
    if (
      row === undefined ||
      row.funding_txid !== binding.txid ||
      databaseInteger(row.funding_vout, "deposit funding output index") !==
        binding.vout ||
      row.wallet_id !== binding.walletID ||
      row.output_key !== binding.outputKey ||
      databaseInteger(
        row.ethereum_block_number,
        "deposit Ethereum block number"
      ) !== binding.ethereum.blockNumber ||
      row.ethereum_block_hash !== binding.ethereum.blockHash
    ) {
      throw new Error(
        `Deposit reveal ${binding.sourceEventID} conflicts with durable state`
      )
    }
  }

  private async backfillFrostWallet(
    client: P2TRPostgresClient,
    walletID: string
  ): Promise<void> {
    const outputs = await client.query<JournalOutputRow>(
      `${JOURNAL_OUTPUT_SELECT}
        WHERE output.script_pubkey = $1
        ORDER BY output.block_height, output.txid, output.vout
        LIMIT $2`,
      [
        hexBuffer(`5120${walletID}`, "wallet P2TR script"),
        this.maxJournalOutputs + 1,
      ]
    )
    if (outputs.rows.length > this.maxJournalOutputs) {
      throw new Error("FROST wallet backfill exceeds its journal-derived bound")
    }
    for (const row of outputs.rows) {
      const tracked = trackedWalletFromOutputRow(row, walletID)
      const newlyTracked = await this.insertTrackedOutpoint(client, tracked)
      await this.backfillSpendCandidate(client, tracked, [], newlyTracked)
    }
  }

  private async reconcilePendingDepositReveals(
    client: P2TRPostgresClient
  ): Promise<void> {
    const matches = await client.query<
      JournalOutputRow & {
        source_event_id: string
        wallet_id: string
        output_key: string
      }
    >(
      `SELECT ${JOURNAL_OUTPUT_COLUMNS},
              reveal.source_event_id,
              encode(reveal.wallet_id, 'hex') AS wallet_id,
              encode(reveal.output_key, 'hex') AS output_key
         FROM p2tr_pending_deposit_reveals reveal
         JOIN p2tr_bitcoin_outputs output
           ON output.txid = reveal.funding_txid
          AND output.vout = reveal.funding_vout
        WHERE reveal.resolved_at IS NULL
          AND output.script_pubkey = decode('5120' || encode(reveal.output_key, 'hex'), 'hex')
        ORDER BY output.block_height, output.vout`
    )
    for (const row of matches.rows) {
      const tracked: P2TRTrackedOutpoint = {
        txid: normalizeBytes32(row.txid, "deposit funding txid"),
        vout: uint32(row.vout, "deposit funding output index"),
        kind: "deposit",
        walletID: normalizeBytes32(row.wallet_id, "deposit wallet ID"),
        outputKey: normalizeBytes32(row.output_key, "deposit output key"),
        valueSats: databaseInteger(row.value_sats, "deposit value"),
        scriptPubKey: normalizeHex(row.script_pubkey, "deposit scriptPubKey"),
        createdAt: {
          height: databaseInteger(row.block_height, "deposit funding height"),
          hash: normalizeBytes32(row.block_hash, "deposit funding hash"),
        },
      }
      const insert = await client.query(
        `INSERT INTO p2tr_tracked_outpoints
           (txid, vout, kind, wallet_id, output_key, value_sats,
            script_pubkey, created_height, created_hash, source_event_id)
         VALUES ($1, $2, 'deposit', $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (txid, vout) DO NOTHING`,
        [
          hexBuffer(tracked.txid, "deposit funding txid"),
          tracked.vout,
          hexBuffer(tracked.walletID, "deposit wallet ID"),
          hexBuffer(tracked.outputKey, "deposit output key"),
          tracked.valueSats,
          hexBuffer(tracked.scriptPubKey, "deposit scriptPubKey"),
          tracked.createdAt.height,
          hexBuffer(tracked.createdAt.hash, "deposit funding hash"),
          row.source_event_id,
        ]
      )
      if (insert.rowCount === 0) {
        const existing = await this.loadTrackedOutpointForUpdate(
          client,
          tracked.txid,
          tracked.vout
        )
        if (existing === undefined || !sameTrackedOutpoint(existing, tracked)) {
          throw new Error(
            "Resolved deposit binding conflicts with tracked state"
          )
        }
      }
      await client.query(
        `UPDATE p2tr_pending_deposit_reveals
            SET resolved_funding_height = $2,
                resolved_funding_hash = $3,
                resolved_at = clock_timestamp()
          WHERE source_event_id = $1
            AND resolved_at IS NULL`,
        [
          row.source_event_id,
          tracked.createdAt.height,
          hexBuffer(tracked.createdAt.hash, "deposit funding hash"),
        ]
      )
      await this.backfillSpendCandidate(client, tracked, [
        {
          txid: tracked.txid,
          vout: tracked.vout,
          outputKey: tracked.outputKey,
          walletID: tracked.walletID,
        },
      ])
    }
  }

  private async backfillSpendCandidate(
    client: P2TRPostgresClient,
    tracked: P2TRTrackedOutpoint,
    bindings: Array<{
      txid: string
      vout: number
      outputKey: string
      walletID: string
    }>,
    forceRedelivery = false
  ): Promise<void> {
    const spend = await client.query<SpendRow>(
      `SELECT encode(spending_txid, 'hex') AS spending_txid,
              encode(spending_wtxid, 'hex') AS spending_wtxid,
              input_index,
              block_height,
              encode(block_hash, 'hex') AS block_hash
         FROM p2tr_bitcoin_inputs
        WHERE prev_txid = $1 AND prev_vout = $2`,
      [hexBuffer(tracked.txid, "tracked funding txid"), tracked.vout]
    )
    if (spend.rows.length === 0) return
    if (spend.rows.length !== 1) {
      throw new Error("Canonical Bitcoin journal contains a double spend")
    }
    const row = spend.rows[0]
    const spendingTxid = normalizeBytes32(row.spending_txid, "spending txid")
    const spendingWtxid = normalizeBytes32(row.spending_wtxid, "spending wtxid")
    await client.query(
      `INSERT INTO p2tr_bitcoin_candidates
         (txid, wtxid, block_height, block_hash, raw_transaction,
          input_prevouts, wallet_input_key_bindings, delivered, delivered_at)
       SELECT journal_tx.txid,
              journal_tx.wtxid,
              journal_tx.block_height,
              journal_tx.block_hash,
              journal_tx.raw_transaction,
              journal_tx.input_prevouts,
              $4::jsonb,
              false,
              NULL
         FROM p2tr_bitcoin_transactions journal_tx
        WHERE journal_tx.block_hash = $1
          AND journal_tx.txid = $2
          AND journal_tx.wtxid = $3
       ON CONFLICT (block_hash, txid, wtxid) DO UPDATE
         SET wallet_input_key_bindings =
               CASE
                 WHEN p2tr_bitcoin_candidates.wallet_input_key_bindings @> $4::jsonb
                   THEN p2tr_bitcoin_candidates.wallet_input_key_bindings
                 ELSE (
                   SELECT COALESCE(
                     jsonb_agg(binding ORDER BY
                       binding->>'txid',
                       (binding->>'vout')::bigint,
                       binding->>'walletID',
                       binding->>'outputKey'),
                     '[]'::jsonb
                   )
                     FROM (
                       SELECT DISTINCT value AS binding
                         FROM jsonb_array_elements(
                           p2tr_bitcoin_candidates.wallet_input_key_bindings ||
                           $4::jsonb
                         )
                     ) unique_bindings
                 )
               END,
             delivered =
               CASE
                 WHEN $5 THEN false
                 WHEN p2tr_bitcoin_candidates.wallet_input_key_bindings @> $4::jsonb
                   THEN p2tr_bitcoin_candidates.delivered
                 ELSE false
               END,
             delivered_at =
               CASE
                 WHEN $5 THEN NULL
                 WHEN p2tr_bitcoin_candidates.wallet_input_key_bindings @> $4::jsonb
                   THEN p2tr_bitcoin_candidates.delivered_at
                 ELSE NULL
               END`,
      [
        hexBuffer(row.block_hash, "spending block hash"),
        hexBuffer(spendingTxid, "spending txid"),
        hexBuffer(spendingWtxid, "spending wtxid"),
        JSON.stringify(bindings),
        forceRedelivery,
      ]
    )
    await client.query(
      `UPDATE p2tr_tracked_outpoints
          SET spent_by_txid = $3,
              spent_by_wtxid = $4,
              spent_input_index = $5,
              spent_height = $6,
              spent_hash = $7
        WHERE txid = $1 AND vout = $2`,
      [
        hexBuffer(tracked.txid, "tracked funding txid"),
        tracked.vout,
        hexBuffer(spendingTxid, "spending txid"),
        hexBuffer(spendingWtxid, "spending wtxid"),
        databaseInteger(row.input_index, "spending input index"),
        databaseInteger(row.block_height, "spending block height"),
        hexBuffer(row.block_hash, "spending block hash"),
      ]
    )
  }

  private async loadTrackedOutpointForUpdate(
    client: P2TRPostgresClient,
    txid: string,
    vout: number
  ): Promise<P2TRTrackedOutpoint | undefined> {
    const result = await client.query<TrackedOutpointRow>(
      `${TRACKED_OUTPOINT_SELECT}
        WHERE txid = $1 AND vout = $2
        FOR UPDATE`,
      [hexBuffer(txid, "tracked txid"), vout]
    )
    return result.rows[0] && trackedOutpointFromRow(result.rows[0])
  }

  private async assertJournalCapacity(
    client: P2TRPostgresClient,
    scan: P2TRCanonicalBitcoinScan
  ): Promise<void> {
    const result = await client.query<{
      blocks: string | number
      transactions: string | number
      inputs: string | number
      outputs: string | number
    }>(
      `SELECT (SELECT count(*) FROM p2tr_bitcoin_blocks) AS blocks,
              (SELECT count(*) FROM p2tr_bitcoin_transactions) AS transactions,
              (SELECT count(*) FROM p2tr_bitcoin_inputs) AS inputs,
              (SELECT count(*) FROM p2tr_bitcoin_outputs) AS outputs`
    )
    if (result.rows.length !== 1) {
      throw new Error("PostgreSQL Bitcoin journal capacity read failed")
    }
    const newTransactions = scan.blocks.reduce(
      (total, block) => total + block.transactions.length,
      0
    )
    const newInputs = scan.blocks.reduce(
      (total, block) =>
        total +
        block.transactions.reduce(
          (blockTotal, transaction) =>
            blockTotal + (transaction.coinbase ? 0 : transaction.inputs.length),
          0
        ),
      0
    )
    const newOutputs = scan.blocks.reduce(
      (total, block) =>
        total +
        block.transactions.reduce(
          (blockTotal, transaction) => blockTotal + transaction.outputs.length,
          0
        ),
      0
    )
    const blocks = databaseInteger(result.rows[0].blocks, "block count")
    const transactions = databaseInteger(
      result.rows[0].transactions,
      "transaction count"
    )
    const inputs = databaseInteger(result.rows[0].inputs, "input count")
    const outputs = databaseInteger(result.rows[0].outputs, "output count")
    if (blocks + scan.blocks.length > this.maxJournalBlocks) {
      throw new Error(
        `PostgreSQL Bitcoin block journal reached its ${this.maxJournalBlocks}-row capacity; cursor advancement halted`
      )
    }
    if (transactions + newTransactions > this.maxJournalTransactions) {
      throw new Error(
        `PostgreSQL Bitcoin transaction journal reached its ${this.maxJournalTransactions}-row capacity; cursor advancement halted`
      )
    }
    if (inputs + newInputs > this.maxJournalInputs) {
      throw new Error(
        `PostgreSQL Bitcoin input journal reached its ${this.maxJournalInputs}-row capacity; cursor advancement halted`
      )
    }
    if (outputs + newOutputs > this.maxJournalOutputs) {
      throw new Error(
        `PostgreSQL Bitcoin output journal reached its ${this.maxJournalOutputs}-row capacity; cursor advancement halted`
      )
    }
  }

  private async insertTrackedOutpoint(
    client: P2TRPostgresClient,
    tracked: P2TRTrackedOutpoint
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO p2tr_tracked_outpoints
         (txid, vout, kind, wallet_id, output_key, value_sats,
          script_pubkey, created_height, created_hash, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
       ON CONFLICT (txid, vout) DO NOTHING`,
      [
        hexBuffer(tracked.txid, "tracked outpoint txid"),
        uint32(tracked.vout, "tracked outpoint index"),
        tracked.kind,
        hexBuffer(tracked.walletID, "tracked wallet ID"),
        hexBuffer(tracked.outputKey, "tracked output key"),
        nonNegativeInteger(tracked.valueSats, "tracked output value"),
        hexBuffer(tracked.scriptPubKey, "tracked scriptPubKey"),
        nonNegativeInteger(tracked.createdAt.height, "tracked creation height"),
        hexBuffer(tracked.createdAt.hash, "tracked creation hash"),
      ]
    )
    if (result.rowCount === 1) return true

    const existing = await client.query<TrackedOutpointRow>(
      `SELECT encode(txid, 'hex') AS txid,
              vout,
              kind,
              encode(wallet_id, 'hex') AS wallet_id,
              encode(output_key, 'hex') AS output_key,
              value_sats,
              encode(script_pubkey, 'hex') AS script_pubkey,
              created_height,
              encode(created_hash, 'hex') AS created_hash
         FROM p2tr_tracked_outpoints
        WHERE txid = $1 AND vout = $2`,
      [hexBuffer(tracked.txid, "tracked outpoint txid"), tracked.vout]
    )
    if (
      existing.rows.length !== 1 ||
      !sameTrackedOutpoint(trackedOutpointFromRow(existing.rows[0]), tracked)
    ) {
      throw new Error(
        `Tracked outpoint ${tracked.txid}:${tracked.vout} conflicts with durable state`
      )
    }
    return false
  }

  private async insertCandidate(
    client: P2TRPostgresClient,
    candidate: P2TRCanonicalBitcoinScan["candidates"][number],
    delivered: boolean
  ): Promise<void> {
    const result = await client.query(
      `INSERT INTO p2tr_bitcoin_candidates
         (txid, wtxid, block_height, block_hash, raw_transaction, input_prevouts,
          wallet_input_key_bindings, delivered, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8,
               CASE WHEN $8 THEN clock_timestamp() ELSE NULL END)
       ON CONFLICT (block_hash, txid, wtxid) DO NOTHING`,
      [
        hexBuffer(candidate.txid, "candidate transaction ID"),
        hexBuffer(candidate.wtxid, "candidate witness transaction ID"),
        candidate.block.height,
        hexBuffer(candidate.block.hash, "candidate block hash"),
        hexBuffer(candidate.rawTransactionHex, "candidate raw transaction"),
        JSON.stringify(candidate.inputPrevouts),
        JSON.stringify(candidate.walletInputKeyBindings),
        delivered,
      ]
    )
    if (result.rowCount !== 1) {
      throw new Error(
        `Bitcoin candidate ${candidate.txid} conflicts with durable state`
      )
    }
  }

  private async assertDatabaseReady(client: P2TRPostgresClient): Promise<void> {
    const version = await client.query<{ server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num"
    )
    if (
      version.rows.length !== 1 ||
      Number(version.rows[0].server_version_num) < 160000
    ) {
      throw new Error("P2TR canonical evidence store requires PostgreSQL 16+")
    }
    const schema = await client.query<{ version: number }>(
      `SELECT version
         FROM p2tr_watchtower_schema_version
        WHERE component = 'canonical-evidence-index'`
    )
    if (
      schema.rows.length !== 1 ||
      Number(schema.rows[0].version) !== REQUIRED_SCHEMA_VERSION
    ) {
      throw new Error(
        `P2TR canonical evidence schema migration ${REQUIRED_SCHEMA_VERSION} is required`
      )
    }
  }

  private async withClient<T>(
    operation: (client: P2TRPostgresClient) => Promise<T>
  ): Promise<T> {
    const active = this.transaction.getStore()
    if (active !== undefined) return operation(active)

    const client = await this.pool.connect()
    try {
      await this.assertDatabaseReady(client)
      return await operation(client)
    } finally {
      client.release()
    }
  }

  private async mutate<T>(
    operation: (client: P2TRPostgresClient) => Promise<T>
  ): Promise<T> {
    const active = this.transaction.getStore()
    if (active !== undefined) return operation(active)
    return this.runInP2TRSignatureFraudWatchtowerTransaction(() =>
      operation(this.requireTransactionClient())
    )
  }

  private requireTransactionClient(): P2TRPostgresClient {
    const client = this.transaction.getStore()
    if (client === undefined) {
      throw new Error("PostgreSQL mutation requires an active transaction")
    }
    return client
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback)
}

type TrackedOutpointRow = {
  txid: string
  vout: string | number
  kind: string
  wallet_id: string
  output_key: string
  value_sats: string | number
  script_pubkey: string
  created_height: string | number
  created_hash: string
}

type CandidateRow = {
  txid: string
  wtxid: string
  block_height: string | number
  block_hash: string
  raw_transaction: string
  input_prevouts: unknown
  wallet_input_key_bindings: unknown
}

type ProofRow = {
  event_id: string
  ethereum_block_number: string | number
  ethereum_block_hash: string
  ethereum_transaction_hash: string
  ethereum_log_index: string | number
  bitcoin_txid: string
  wallet_id: string
  spend_type: string
  payload: unknown
}

type WatermarkRow = {
  bitcoin_height: string | number
  bitcoin_hash: string
  ethereum_block_number: string | number
  ethereum_block_hash: string
}

type JournalOutputRow = {
  txid: string
  wtxid: string
  vout: string | number
  value_sats: string | number
  script_pubkey: string
  block_height: string | number
  block_hash: string
}

type SpendRow = {
  spending_txid: string
  spending_wtxid: string
  input_index: string | number
  block_height: string | number
  block_hash: string
}

const JOURNAL_OUTPUT_COLUMNS = `encode(output.txid, 'hex') AS txid,
       encode(output.wtxid, 'hex') AS wtxid,
       output.vout,
       output.value_sats,
       encode(output.script_pubkey, 'hex') AS script_pubkey,
       output.block_height,
       encode(output.block_hash, 'hex') AS block_hash`

const JOURNAL_OUTPUT_SELECT = `SELECT ${JOURNAL_OUTPUT_COLUMNS}
  FROM p2tr_bitcoin_outputs output`

const TRACKED_OUTPOINT_SELECT = `SELECT encode(txid, 'hex') AS txid,
       vout,
       kind,
       encode(wallet_id, 'hex') AS wallet_id,
       encode(output_key, 'hex') AS output_key,
       value_sats,
       encode(script_pubkey, 'hex') AS script_pubkey,
       created_height,
       encode(created_hash, 'hex') AS created_hash
  FROM p2tr_tracked_outpoints`

const PROOF_SELECT = `SELECT event_id,
       ethereum_block_number,
       encode(ethereum_block_hash, 'hex') AS ethereum_block_hash,
       encode(ethereum_transaction_hash, 'hex') AS ethereum_transaction_hash,
       ethereum_log_index,
       encode(bitcoin_txid, 'hex') AS bitcoin_txid,
       encode(wallet_id, 'hex') AS wallet_id,
       spend_type,
       payload
  FROM p2tr_unmatched_proofs`

const WATERMARK_SELECT = `SELECT bitcoin_height,
       encode(bitcoin_hash, 'hex') AS bitcoin_hash,
       ethereum_block_number,
       encode(ethereum_block_hash, 'hex') AS ethereum_block_hash
  FROM p2tr_cross_source_watermark
 WHERE singleton = true`

const trackedOutpointFromRow = (
  row: TrackedOutpointRow
): P2TRTrackedOutpoint => {
  if (row.kind !== "wallet" && row.kind !== "deposit") {
    throw new Error("Stored tracked outpoint kind is invalid")
  }
  return {
    txid: normalizeBytes32(row.txid, "tracked outpoint txid"),
    vout: uint32(row.vout, "tracked outpoint index"),
    kind: row.kind,
    walletID: normalizeBytes32(row.wallet_id, "tracked wallet ID"),
    outputKey: normalizeBytes32(row.output_key, "tracked output key"),
    valueSats: databaseInteger(row.value_sats, "tracked output value"),
    scriptPubKey: normalizeHex(row.script_pubkey, "tracked scriptPubKey"),
    createdAt: {
      height: databaseInteger(row.created_height, "tracked creation height"),
      hash: normalizeBytes32(row.created_hash, "tracked creation hash"),
    },
  }
}

const trackedWalletFromOutputRow = (
  row: JournalOutputRow,
  walletID: string
): P2TRTrackedOutpoint => ({
  txid: normalizeBytes32(row.txid, "wallet funding txid"),
  vout: uint32(row.vout, "wallet funding output index"),
  kind: "wallet",
  walletID: normalizeBytes32(walletID, "wallet ID"),
  outputKey: normalizeBytes32(walletID, "wallet output key"),
  valueSats: databaseInteger(row.value_sats, "wallet output value"),
  scriptPubKey: normalizeHex(row.script_pubkey, "wallet scriptPubKey"),
  createdAt: {
    height: databaseInteger(row.block_height, "wallet funding height"),
    hash: normalizeBytes32(row.block_hash, "wallet funding hash"),
  },
})

const candidateFromRow = (
  row: CandidateRow
): P2TRCanonicalBitcoinScan["candidates"][number] => ({
  txid: normalizeBytes32(row.txid, "candidate txid"),
  wtxid: normalizeBytes32(row.wtxid, "candidate wtxid"),
  rawTransactionHex: normalizeHex(
    row.raw_transaction,
    "candidate raw transaction"
  ),
  block: {
    height: databaseInteger(row.block_height, "candidate block height"),
    hash: normalizeBytes32(row.block_hash, "candidate block hash"),
  },
  inputPrevouts: requireArray(row.input_prevouts, "candidate prevouts").map(
    (value) => {
      const prevout = requireRecord(value, "candidate prevout")
      return {
        txid: normalizeBytes32(String(prevout.txid), "candidate prevout txid"),
        vout: uint32(prevout.vout, "candidate prevout index"),
        valueSats: databaseInteger(
          prevout.valueSats as string | number,
          "candidate prevout value"
        ),
        scriptPubKey: normalizeHex(
          String(prevout.scriptPubKey),
          "candidate prevout script"
        ),
      }
    }
  ),
  walletInputKeyBindings: requireArray(
    row.wallet_input_key_bindings,
    "candidate wallet bindings"
  ).map((value) => {
    const binding = requireRecord(value, "candidate wallet binding")
    return {
      txid: normalizeBytes32(String(binding.txid), "binding txid"),
      vout: uint32(binding.vout, "binding output index"),
      outputKey: normalizeBytes32(
        String(binding.outputKey),
        "binding output key"
      ),
      walletID: normalizeBytes32(String(binding.walletID), "binding wallet ID"),
    }
  }),
})

const proofFromRow = (row: ProofRow): P2TRUnmatchedProofEnvelope => ({
  eventID: boundedString(row.event_id, 512, "proof event ID"),
  ethereum: {
    blockNumber: databaseInteger(
      row.ethereum_block_number,
      "proof Ethereum block number"
    ),
    blockHash: normalizeBytes32(
      row.ethereum_block_hash,
      "proof Ethereum block hash"
    ),
    transactionHash: normalizeBytes32(
      row.ethereum_transaction_hash,
      "proof Ethereum transaction hash"
    ),
    logIndex: databaseInteger(
      row.ethereum_log_index,
      "proof Ethereum log index"
    ),
  },
  bitcoinTxid: normalizeBytes32(row.bitcoin_txid, "proof Bitcoin txid"),
  walletID: normalizeBytes32(row.wallet_id, "proof wallet ID"),
  spendType: boundedString(row.spend_type, 64, "proof spend type"),
  payload: requireRecord(row.payload, "proof payload"),
})

const watermarkFromRow = (row: WatermarkRow): P2TRCrossSourceWatermark => ({
  bitcoin: {
    height: databaseInteger(row.bitcoin_height, "watermark Bitcoin height"),
    hash: normalizeBytes32(row.bitcoin_hash, "watermark Bitcoin hash"),
  },
  ethereum: {
    blockNumber: databaseInteger(
      row.ethereum_block_number,
      "watermark Ethereum block number"
    ),
    blockHash: normalizeBytes32(
      row.ethereum_block_hash,
      "watermark Ethereum block hash"
    ),
  },
})

const validateBitcoinScan = (scan: P2TRCanonicalBitcoinScan): void => {
  normalizeBytes32(scan.configurationFingerprint, "configuration fingerprint")
  boundedString(scan.network, 32, "Bitcoin network")
  validatePoint(scan.checkpoint, "Bitcoin checkpoint")
  validatePoint(scan.rollbackTo, "Bitcoin rollback point")
  validatePoint(scan.nextCursor, "Bitcoin next cursor")
  validatePoint(scan.sampledFinalizedHead, "Bitcoin sampled head")
  if (scan.expectedCursor !== undefined) {
    validatePoint(scan.expectedCursor, "Bitcoin expected cursor")
    if (scan.rollbackTo.height > scan.expectedCursor.height) {
      throw new Error("Bitcoin rollback point follows the expected cursor")
    }
  }
  if (
    scan.rollbackTo.height < scan.checkpoint.height ||
    scan.nextCursor.height > scan.sampledFinalizedHead.height
  ) {
    throw new Error("Bitcoin scan cursor range is invalid")
  }

  const transactions = new Map<
    string,
    { raw: string; block: P2TRBitcoinChainPoint; prevouts: unknown[] }
  >()
  let parent = scan.rollbackTo
  for (const block of scan.blocks) {
    validatePoint(block, "Bitcoin scan block")
    if (
      block.height !== parent.height + 1 ||
      block.parentHash !== parent.hash
    ) {
      throw new Error("Bitcoin scan blocks are not contiguous")
    }
    normalizeHex(block.rawBlockHex, "raw Bitcoin block")
    for (const transaction of block.transactions) {
      const txid = normalizeBytes32(transaction.txid, "Bitcoin transaction ID")
      const raw = normalizeHex(
        transaction.rawTransactionHex,
        "raw Bitcoin transaction"
      )
      const prevouts = transaction.coinbase
        ? []
        : transaction.inputs.map((input, index) => {
            if (
              input.spendingTxid !== txid ||
              input.inputIndex !== index ||
              input.authenticatedPrevout === undefined ||
              input.authenticatedPrevout.txid !== input.txid ||
              input.authenticatedPrevout.vout !== input.vout
            ) {
              throw new Error(
                "Bitcoin transaction input journal is inconsistent"
              )
            }
            return input.authenticatedPrevout
          })
      const identity = `${block.hash}:${txid}:${normalizeBytes32(
        transaction.wtxid,
        "Bitcoin witness transaction ID"
      )}`
      if (transactions.has(identity)) {
        throw new Error(`Bitcoin transaction ${identity} is duplicated in scan`)
      }
      transactions.set(identity, {
        raw,
        block: { height: block.height, hash: block.hash },
        prevouts,
      })
    }
    parent = { height: block.height, hash: block.hash }
  }
  if (!samePoint(parent, scan.nextCursor)) {
    throw new Error("Bitcoin scan next cursor does not match its final block")
  }
  for (const candidate of scan.candidates) {
    const transaction = transactions.get(
      `${candidate.block.hash}:${candidate.txid}:${candidate.wtxid}`
    )
    if (
      transaction === undefined ||
      transaction.raw !== candidate.rawTransactionHex ||
      !samePoint(transaction.block, candidate.block) ||
      canonicalJSON(transaction.prevouts) !==
        canonicalJSON(candidate.inputPrevouts)
    ) {
      throw new Error(
        `Bitcoin candidate ${candidate.txid} does not match its retained transaction`
      )
    }
  }
  if (
    new Set(scan.acknowledgedCandidates.map(candidateIdentityKey)).size !==
    scan.acknowledgedCandidates.length
  ) {
    throw new Error("Bitcoin candidate acknowledgements must be unique")
  }
}

const validateDepositBinding = (binding: P2TRTaprootDepositBinding): void => {
  normalizeBytes32(binding.txid, "deposit funding txid")
  uint32(binding.vout, "deposit funding output index")
  normalizeBytes32(binding.walletID, "deposit wallet ID")
  normalizeBytes32(binding.outputKey, "deposit output key")
  boundedString(binding.sourceEventID, 512, "deposit source event ID")
  validatePoint(
    { height: binding.ethereum.blockNumber, hash: binding.ethereum.blockHash },
    "deposit Ethereum point"
  )
}

const validateFrostWalletBinding = (binding: P2TRFrostWalletBinding): void => {
  normalizeBytes32(binding.walletID, "FROST wallet ID")
  normalizeBytes20(binding.walletPubKeyHash, "FROST wallet public-key hash")
  boundedString(binding.sourceEventID, 512, "wallet source event ID")
  validatePoint(
    { height: binding.ethereum.blockNumber, hash: binding.ethereum.blockHash },
    "wallet Ethereum point"
  )
}

const validateProofEnvelope = (
  proof: P2TRUnmatchedProofEnvelope,
  maxPayloadBytes: number
): void => {
  boundedString(proof.eventID, 512, "proof event ID")
  validatePoint(
    { height: proof.ethereum.blockNumber, hash: proof.ethereum.blockHash },
    "proof Ethereum point"
  )
  normalizeBytes32(proof.ethereum.transactionHash, "proof transaction hash")
  nonNegativeInteger(proof.ethereum.logIndex, "proof log index")
  normalizeBytes32(proof.bitcoinTxid, "proof Bitcoin txid")
  normalizeBytes32(proof.walletID, "proof wallet ID")
  boundedString(proof.spendType, 64, "proof spend type")
  requireRecord(proof.payload, "proof payload")
  if (
    Buffer.byteLength(canonicalJSON(proof.payload), "utf8") > maxPayloadBytes
  ) {
    throw new Error(
      `Proof payload exceeds the configured ${maxPayloadBytes}-byte bound`
    )
  }
}

const validateWatermark = (
  watermark: P2TRCrossSourceWatermark,
  field: string
): void => {
  validatePoint(watermark.bitcoin, `${field} Bitcoin point`)
  validatePoint(
    {
      height: watermark.ethereum.blockNumber,
      hash: watermark.ethereum.blockHash,
    },
    `${field} Ethereum point`
  )
}

const validatePoint = (point: P2TRBitcoinChainPoint, field: string): void => {
  nonNegativeInteger(point.height, `${field} height`)
  normalizeBytes32(point.hash, `${field} hash`)
}

const assertMonotonicPoint = (
  previous: P2TRBitcoinChainPoint,
  next: P2TRBitcoinChainPoint,
  field: string
): void => {
  if (
    next.height < previous.height ||
    (next.height === previous.height && next.hash !== previous.hash)
  ) {
    throw new Error(`${field} cannot move backward or change hash`)
  }
}

const samePoint = (
  left: P2TRBitcoinChainPoint,
  right: P2TRBitcoinChainPoint
): boolean => left.height === right.height && left.hash === right.hash

const candidateIdentityKey = (identity: {
  txid: string
  wtxid: string
  blockHash: string
}): string => `${identity.blockHash}:${identity.txid}:${identity.wtxid}`

const sameTrackedOutpoint = (
  left: P2TRTrackedOutpoint,
  right: P2TRTrackedOutpoint
): boolean =>
  left.txid === right.txid &&
  left.vout === right.vout &&
  left.kind === right.kind &&
  left.walletID === right.walletID &&
  left.outputKey === right.outputKey &&
  left.valueSats === right.valueSats &&
  left.scriptPubKey === right.scriptPubKey &&
  samePoint(left.createdAt, right.createdAt)

const requireArray = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value
}

const requireRecord = (
  value: unknown,
  field: string
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

const canonicalJSON = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (typeof input === "object" && input !== null) {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)])
      )
    }
    return input
  }
  return JSON.stringify(normalize(value)) ?? "undefined"
}

const normalizeHex = (value: string, field: string): string => {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (
    normalized.length === 0 ||
    normalized.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(normalized)
  ) {
    throw new Error(`${field} must be non-empty, even-length hex`)
  }
  return normalized
}

const hexBuffer = (value: string, field: string): Buffer =>
  Buffer.from(normalizeHex(value, field), "hex")

const uint32 = (value: unknown, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    throw new Error(`${field} must be a uint32`)
  }
  return parsed
}

const positiveInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  return value
}

const nonNegativeInteger = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`)
  }
  return value
}

const boundedString = (value: string, max: number, field: string): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new Error(`${field} must contain between 1 and ${max} characters`)
  }
  return value
}

const normalizeBytes32 = (value: string, field: string): string => {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 32-byte hex value`)
  }
  return normalized
}

const normalizeBytes20 = (value: string, field: string): string => {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${field} must be a 20-byte hex value`)
  }
  return normalized
}

const databaseInteger = (value: string | number, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  return nonNegativeInteger(parsed, field)
}

const postgresRetryableTransactionSQLState = (
  error: unknown
): P2TRPostgresRetryableTransactionSQLState | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return code === "40001" || code === "40P01" ? code : undefined
}
