import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import {
  PostgresP2TRCanonicalIndexStore,
  type P2TRPostgresClient,
  type P2TRPostgresQueryResult,
  type P2TRReadinessExportAcknowledgementVerification,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import { PostgresP2TRCanonicalEthereumJournalStore } from "../src/PostgresP2TRCanonicalEthereumJournalStore.js"

describe("PostgreSQL canonical Ethereum readiness snapshot", () => {
  it("takes the global exclusive lock and binds exact root/count/generation", async () => {
    const client = new ReadinessClient()
    const coordinator = coordinatorFor(client)
    const journal =
      coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) =>
          new PostgresP2TRCanonicalEthereumJournalStore(session, journalOptions)
      )

    const snapshot =
      await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(() =>
        journal.lockCanonicalEthereumReadinessSnapshot()
      )

    assert.ok(snapshot)
    assert.equal(snapshot.generation, 7)
    assert.equal(snapshot.historyRoot, `0x${"34".repeat(32)}`)
    assert.deepEqual(snapshot.journalCounts, {
      blocks: 101,
      coverageBlocks: 100,
      transactions: 23,
      receipts: 23,
      logs: 17,
      events: 12,
    })
    assert.match(snapshot.root, /^0x[0-9a-f]{64}$/)
    const lockIndex = client.queries.findIndex((query) =>
      query.includes(
        "pg_advisory_xact_lock(hashtextextended('p2tr-readiness-snapshot'"
      )
    )
    const readIndex = client.queries.findIndex((query) =>
      query.includes("cursor.generation")
    )
    assert.ok(lockIndex >= 0 && readIndex > lockIndex)
  })

  it("rejects a stale O(1) journal counter", async () => {
    const client = new ReadinessClient({ journal_block_count: 100 })
    const coordinator = coordinatorFor(client)
    const journal =
      coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) =>
          new PostgresP2TRCanonicalEthereumJournalStore(session, journalOptions)
      )
    await assert.rejects(
      coordinator.runInP2TRSignatureFraudWatchtowerTransaction(() =>
        journal.lockCanonicalEthereumReadinessSnapshot()
      ),
      /readiness counters are stale/
    )
  })
})

const journalOptions = {
  storeID: "watchtower",
  maxBlocksPerScan: 10,
  maxEventsPerScan: 10,
  maxEventPageSize: 10,
  maxTotalRawLogBytes: 1024,
  maxTotalDecodedPayloadBytes: 1024,
}

/**
 * The coordinator asserts migration 3 of `canonical-evidence-index`; the
 * Ethereum journal adapter asserts migration 1 of `canonical-ethereum-journal`.
 * They are independent components, so the fixture answers each query with the
 * version its own owner requires.
 */
const CANONICAL_EVIDENCE_SCHEMA_VERSION = 3
const CANONICAL_ETHEREUM_JOURNAL_SCHEMA_VERSION = 1

function coordinatorFor(client: P2TRPostgresClient) {
  return new PostgresP2TRCanonicalIndexStore(
    { connect: async () => client },
    {
      storeID: "watchtower",
      maxJournalBlocks: 200,
      maxJournalTransactions: 200,
      maxJournalInputs: 200,
      maxJournalOutputs: 200,
      maxWalletBindings: 200,
      maxPendingDepositReveals: 10,
      maxUnmatchedProofs: 10,
      maxProofMutationBatchSize: 10,
      maxProofPageSize: 10,
      maxProofPayloadBytes: 1024,
      authorizationDomain: {
        chainID: "31337",
        bridgeAddress: "12".repeat(20),
      },
      sourceIdentity: {
        clusterID: "readiness-cluster",
        operatorID: "readiness-operator",
        bitcoinIdentityDigest: "21".repeat(32),
        ethereumIdentityDigest: "22".repeat(32),
      },
      readinessExportSigner: {
        keyID: "readiness-export-signer",
        async signPayloadDigest(): Promise<string> {
          return "ab".repeat(64)
        },
      },
      readinessExportAcknowledgementVerifier: {
        async verify({
          signature,
        }: P2TRReadinessExportAcknowledgementVerification): Promise<boolean> {
          return signature === "ab".repeat(64)
        },
      },
    }
  )
}

class ReadinessClient implements P2TRPostgresClient {
  readonly queries: string[] = []

  constructor(
    private readonly overrides: Partial<Record<string, string | number>> = {}
  ) {}

  async query<Row>(
    text: string,
    values?: readonly unknown[]
  ): Promise<P2TRPostgresQueryResult<Row>> {
    this.queries.push(text)
    if (text.includes("server_version_num")) {
      return {
        rows: [{ server_version_num: "160000" }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("p2tr_watchtower_schema_version")) {
      const version = text.includes("canonical-ethereum-journal")
        ? CANONICAL_ETHEREUM_JOURNAL_SCHEMA_VERSION
        : CANONICAL_EVIDENCE_SCHEMA_VERSION
      return { rows: [{ version }] as Row[], rowCount: 1 }
    }
    if (text.includes("pg_advisory_unlock")) {
      return { rows: [{ unlocked: true }] as Row[], rowCount: 1 }
    }
    // Reproduce the persisted-digest SQL assertions the coordinator issues
    // before every transaction, exactly as the stored functions compute them.
    if (text.includes("p2tr_assert_complete_authorization_domain")) {
      const chainID = BigInt(String(values?.[1]))
      const domainDigest = createHash("sha256")
        .update("tbtc-p2tr-complete-domain-v1", "utf8")
        .update(values?.[0] as Buffer)
        .update(Buffer.from(chainID.toString(16).padStart(64, "0"), "hex"))
        .update(values?.[2] as Buffer)
        .digest("hex")
      return { rows: [{ domain_digest: domainDigest }] as Row[], rowCount: 1 }
    }
    if (text.includes("p2tr_assert_watchtower_source_identity")) {
      const sourceIdentityDigest = createHash("sha256")
        .update(
          `tbtc-p2tr-watchtower-source-identity-v1\x1f${String(
            values?.[0]
          )}\x1f${String(values?.[1])}\x1f${String(values?.[2])}`,
          "utf8"
        )
        .update(values?.[3] as Buffer)
        .update(values?.[4] as Buffer)
        .digest("hex")
      return {
        rows: [{ source_identity_digest: sourceIdentityDigest }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("cursor.generation")) {
      return {
        rows: [
          {
            store_id: "watchtower",
            chain_id: 1,
            configuration_fingerprint: "11".repeat(32),
            descriptor_set_hash: "22".repeat(32),
            scan_start_block: 1,
            checkpoint_block_number: 0,
            checkpoint_block_hash: "00".repeat(32),
            current_block_number: 100,
            current_block_hash: "33".repeat(32),
            generation: 7,
            journal_block_count: 101,
            journal_event_count: 12,
            coverage_block_count: 100,
            coverage_transaction_count: 23,
            coverage_receipt_count: 23,
            coverage_log_count: 17,
            history_root: "34".repeat(32),
            required_event_count: 12,
            ...this.overrides,
          },
        ] as Row[],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  }

  release(): void {}
}
