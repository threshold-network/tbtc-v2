import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS,
  computeP2TRCanonicalEthereumDescriptorSetHash,
  type P2TRCanonicalEthereumEventDescriptor,
} from "../src/P2TRCanonicalEthereumJournal.js"
import type { JsonRpcP2TRCanonicalEthereumProvider } from "../src/HttpP2TREthereumJsonRpc.js"
import { PostgresP2TRProductionEthereumHistoryAccumulator } from "../src/PostgresP2TRProductionEthereumHistoryAccumulator.js"
import type {
  P2TRPostgresClient,
  P2TRPostgresPool,
  P2TRPostgresQueryResult,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import { canonicalEmptyBlock, hash } from "./P2TREthereumCanonicalFixture.js"

describe("durable production Ethereum history accumulator", () => {
  it("cannot turn one database into independent stores with different labels", () => {
    const pool = { connect: async () => fail("unused") }
    const source = new PostgresP2TRProductionEthereumHistoryAccumulator(pool, {
      ...accumulatorOptions(),
      storeID: "source-label",
    })
    const verifier = new PostgresP2TRProductionEthereumHistoryAccumulator(
      pool,
      {
        ...accumulatorOptions(),
        storeID: "verifier-label",
      }
    )
    assert.equal(source.storeFingerprint, verifier.storeFingerprint)
    assert.equal(source.clusterFingerprint, verifier.clusterFingerprint)
  })

  it("identifies one cluster across different databases", () => {
    const pool = { connect: async () => fail("unused") }
    const source = new PostgresP2TRProductionEthereumHistoryAccumulator(
      pool,
      accumulatorOptions()
    )
    const verifier = new PostgresP2TRProductionEthereumHistoryAccumulator(
      pool,
      {
        ...accumulatorOptions(),
        databaseIdentity: {
          ...accumulatorOptions().databaseIdentity,
          databaseOID: 20_001,
          databaseName: "watchtower_history_b",
        },
      }
    )
    assert.notEqual(source.storeFingerprint, verifier.storeFingerprint)
    assert.equal(source.clusterFingerprint, verifier.clusterFingerprint)
  })

  it("identifies one cluster across different database roles", () => {
    const pool = { connect: async () => fail("unused") }
    const source = new PostgresP2TRProductionEthereumHistoryAccumulator(
      pool,
      accumulatorOptions()
    )
    const verifier = new PostgresP2TRProductionEthereumHistoryAccumulator(
      pool,
      {
        ...accumulatorOptions(),
        databaseIdentity: {
          ...accumulatorOptions().databaseIdentity,
          currentRole: "watchtower_history_verifier",
        },
      }
    )
    assert.notEqual(source.storeFingerprint, verifier.storeFingerprint)
    assert.equal(source.clusterFingerprint, verifier.clusterFingerprint)
  })

  it("advances only the bounded tail instead of rescanning long history", async () => {
    const harness = existingAccumulatorHarness()
    const result = await harness.accumulator.synchronizeTo(
      request(harness.provider, 100, 2)
    )

    assert.deepEqual(result.point, {
      blockNumber: 2,
      blockHash: harness.provider.testBlocks[2].blockHash,
    })
    assert.equal(result.processedBlocks, 2)
    assert.equal(result.complete, false)
    assert.deepEqual(harness.providerBlockCalls, [0, 1, 2])
    assert.equal(
      harness.queries.filter(({ sql }) =>
        sql.includes("INSERT INTO p2tr_ethereum_history_accumulator_blocks")
      ).length,
      2
    )
  })

  it("fails closed when a reorg exceeds the configured rollback depth", async () => {
    const harness = reorgAccumulatorHarness(2)

    await assert.rejects(
      harness.accumulator.synchronizeTo(request(harness.provider, 3, 3)),
      /Ethereum history reorg exceeds its configured bound/
    )
    assert.equal(
      harness.queries.some(({ sql }) =>
        sql.includes("DELETE FROM p2tr_ethereum_history_accumulator_blocks")
      ),
      false
    )
  })

  it("rolls back a reorg at exactly the configured depth", async () => {
    const harness = reorgAccumulatorHarness(1)

    const result = await harness.accumulator.synchronizeTo(
      request(harness.provider, 3, 3)
    )

    assert.deepEqual(result.point, {
      blockNumber: 3,
      blockHash: harness.provider.testBlocks[3].blockHash,
    })
    assert.equal(result.processedBlocks, 1)
    assert.equal(result.complete, true)
    assert.equal(
      harness.queries.some(({ sql }) =>
        sql.includes("DELETE FROM p2tr_ethereum_history_accumulator_blocks")
      ),
      true
    )
  })

  it("destroys the database session when COMMIT outcome is ambiguous", async () => {
    const commitFailure = new Error("connection lost during commit")
    const harness = existingAccumulatorHarness({ commitFailure })

    await assert.rejects(
      harness.accumulator.synchronizeTo(request(harness.provider, 1, 1)),
      commitFailure
    )
    assert.equal(harness.releaseError, commitFailure)
  })

  it("destroys the database session when BEGIN outcome is ambiguous", async () => {
    const beginFailure = new Error("connection lost during begin")
    let releaseError: Error | undefined
    const client: P2TRPostgresClient = {
      query: async () => {
        throw beginFailure
      },
      release: (error) => {
        releaseError = error
      },
    }
    const accumulator = new PostgresP2TRProductionEthereumHistoryAccumulator(
      { connect: async () => client },
      accumulatorOptions()
    )

    await assert.rejects(
      accumulator.synchronizeTo(request(providerFor([], []), 1, 1)),
      beginFailure
    )
    assert.equal(releaseError, beginFailure)
  })
})

function existingAccumulatorHarness(options?: { commitFailure?: Error }) {
  const queries: { sql: string; values?: readonly unknown[] }[] = []
  const providerBlockCalls: number[] = []
  let releaseError: Error | undefined
  const descriptors = eventDescriptors()
  const provider = providerFor(providerBlockCalls, [])
  let accumulator!: PostgresP2TRProductionEthereumHistoryAccumulator
  const client: P2TRPostgresClient = {
    query: async <Row>(sql: string, values?: readonly unknown[]) => {
      queries.push({ sql, values })
      if (sql.includes("pg_control_system()")) {
        return result<Row>([databaseIdentityRow() as Row])
      }
      if (
        sql.startsWith("BEGIN") ||
        sql.includes("set_config") ||
        sql.includes("pg_advisory")
      ) {
        return result<Row>()
      }
      if (sql.includes("FROM p2tr_ethereum_history_accumulators")) {
        return result<Row>([
          {
            accumulator_id: "history-a",
            store_fingerprint: accumulator.storeFingerprint,
            chain_id: 1,
            descriptor_set_hash:
              computeP2TRCanonicalEthereumDescriptorSetHash(descriptors),
            checkpoint_block_number: 0,
            checkpoint_block_hash: provider.testBlocks[0].blockHash,
            current_block_number: 0,
            current_block_hash: provider.testBlocks[0].blockHash,
            history_root: initialRoot(),
            required_event_count: 0,
            cumulative_block_count: 0,
            cumulative_transaction_count: 0,
            cumulative_receipt_count: 0,
            cumulative_log_count: 0,
          } as Row,
        ])
      }
      if (sql.startsWith("UPDATE p2tr_ethereum_history_accumulators")) {
        return result<Row>([], 1)
      }
      if (sql === "COMMIT") {
        if (options?.commitFailure !== undefined) throw options.commitFailure
        return result<Row>()
      }
      if (sql === "ROLLBACK") return result<Row>()
      return result<Row>([], 1)
    },
    release: (error) => {
      releaseError = error
    },
  }
  accumulator = new PostgresP2TRProductionEthereumHistoryAccumulator(
    { connect: async () => client } satisfies P2TRPostgresPool,
    accumulatorOptions()
  )
  return {
    accumulator,
    provider,
    providerBlockCalls,
    queries,
    get releaseError() {
      return releaseError
    },
  }
}

function reorgAccumulatorHarness(commonAncestorDepth: number) {
  const queries: { sql: string; values?: readonly unknown[] }[] = []
  const descriptors = eventDescriptors()
  const provider = providerFor([], [])
  const storedBlocks = provider.testBlocks
    .slice(0, 4)
    .map((block) => structuredClone(block))
  const commonAncestor = 3 - commonAncestorDepth
  for (let blockNumber = commonAncestor + 1; blockNumber <= 3; blockNumber++) {
    provider.testBlocks[blockNumber] = canonicalEmptyBlock(
      blockNumber,
      provider.testBlocks[blockNumber - 1].blockHash,
      10_000 + blockNumber
    )
  }
  let accumulator!: PostgresP2TRProductionEthereumHistoryAccumulator
  const candidateRows = storedBlocks
    .slice(1, 3)
    .reverse()
    .map((block) => ({
      block_number: block.blockNumber,
      block_hash: block.blockHash,
      history_root: initialRoot(),
      required_event_count: 0,
      cumulative_block_count: block.blockNumber,
      cumulative_transaction_count: 0,
      cumulative_receipt_count: 0,
      cumulative_log_count: 0,
    }))
  const client: P2TRPostgresClient = {
    query: async <Row>(sql: string, values?: readonly unknown[]) => {
      queries.push({ sql, values })
      if (sql.includes("pg_control_system()")) {
        return result<Row>([databaseIdentityRow() as Row])
      }
      if (
        sql.startsWith("BEGIN") ||
        sql.includes("set_config") ||
        sql.includes("pg_advisory")
      ) {
        return result<Row>()
      }
      if (sql.includes("FROM p2tr_ethereum_history_accumulators")) {
        return result<Row>([
          {
            accumulator_id: "history-a",
            store_fingerprint: accumulator.storeFingerprint,
            chain_id: 1,
            descriptor_set_hash:
              computeP2TRCanonicalEthereumDescriptorSetHash(descriptors),
            checkpoint_block_number: 0,
            checkpoint_block_hash: storedBlocks[0].blockHash,
            current_block_number: 3,
            current_block_hash: storedBlocks[3].blockHash,
            history_root: initialRoot(),
            required_event_count: 0,
            cumulative_block_count: 3,
            cumulative_transaction_count: 0,
            cumulative_receipt_count: 0,
            cumulative_log_count: 0,
          } as Row,
        ])
      }
      if (
        sql.includes("FROM p2tr_ethereum_history_accumulator_blocks") &&
        sql.includes("block_number < $2")
      ) {
        return result<Row>(candidateRows.slice(0, Number(values?.[2])) as Row[])
      }
      if (sql.startsWith("UPDATE p2tr_ethereum_history_accumulators")) {
        return result<Row>([], 1)
      }
      return result<Row>([], 1)
    },
    release: () => undefined,
  }
  accumulator = new PostgresP2TRProductionEthereumHistoryAccumulator(
    { connect: async () => client },
    accumulatorOptions(1)
  )
  return { accumulator, provider, queries }
}

function request(
  provider: TestProvider,
  targetBlock: number,
  maxTailBlocks: number
) {
  return {
    provider,
    chainID: 1,
    checkpoint: {
      blockNumber: 0,
      blockHash: provider.testBlocks[0].blockHash,
    },
    target: {
      blockNumber: targetBlock,
      blockHash: provider.testBlocks[targetBlock].blockHash,
    },
    descriptors: eventDescriptors(),
    maxTailBlocks,
    maxTailTransactions: 100,
    maxTailLogs: 100,
    maxDecodedPayloadBytes: 10_000,
    deadlineAt: Date.now() + 10_000,
  }
}

function providerFor(
  blockCalls: number[],
  receiptCalls: string[]
): TestProvider {
  const testBlocks = [canonicalEmptyBlock(0, hash(999), 1)]
  for (let blockNumber = 1; blockNumber <= 100; blockNumber++) {
    testBlocks.push(
      canonicalEmptyBlock(
        blockNumber,
        testBlocks[blockNumber - 1].blockHash,
        blockNumber + 1
      )
    )
  }
  return {
    trustDomainID: "ethereum-history-source",
    providerIdentity: {},
    endpointFingerprint: hash(900),
    testBlocks,
    getBlock: async (blockNumber: number) => {
      blockCalls.push(blockNumber)
      return structuredClone(testBlocks[blockNumber])
    },
    getTransactionReceipt: async (transactionHash: string) => {
      receiptCalls.push(transactionHash)
      return null
    },
  } as unknown as TestProvider
}

type TestProvider = JsonRpcP2TRCanonicalEthereumProvider & {
  testBlocks: ReturnType<typeof canonicalEmptyBlock>[]
}

function eventDescriptors(): P2TRCanonicalEthereumEventDescriptor[] {
  return P2TR_CANONICAL_ETHEREUM_REQUIRED_EVENT_KINDS.map((kind, index) => ({
    kind,
    emitter: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    topic0: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    decoderSchemaID: `test-${kind}`,
    decoderCodeHash: hash(index + 300),
    decode: () => ({}),
  }))
}

function accumulatorOptions(maxReorgDepth = 12) {
  return {
    storeID: "history-a",
    databaseIdentity: {
      systemIdentifier: "7612345678901234567",
      serverAddress: "10.10.0.12",
      serverPort: 5432,
      databaseOID: 16_384,
      databaseName: "watchtower_history_a",
      currentRole: "watchtower_history_reader",
    },
    maxReorgDepth,
  }
}

function databaseIdentityRow() {
  return {
    system_identifier: "7612345678901234567",
    server_address: "10.10.0.12",
    server_port: 5432,
    database_oid: 16_384,
    database_name: "watchtower_history_a",
    current_role: "watchtower_history_reader",
  }
}

function initialRoot(): string {
  // The fake cursor only needs a canonical bytes32; root evolution is exercised
  // by the production accumulator implementation itself.
  return hash(777)
}

function result<Row>(
  rows: Row[] = [],
  rowCount: number | null = rows.length
): P2TRPostgresQueryResult<Row> {
  return { rows, rowCount }
}

function fail(message: string): never {
  throw new Error(message)
}
