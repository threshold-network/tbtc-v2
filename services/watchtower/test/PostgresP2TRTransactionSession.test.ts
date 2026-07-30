import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import {
  PostgresP2TRCanonicalIndexStore,
  type P2TRPostgresClient,
} from "../src/PostgresP2TRCanonicalIndexStore.js"
import { PostgresP2TRProductionActivationStore } from "../src/PostgresP2TRProductionActivationStore.js"
import type { P2TRProductionReadinessCertificateInput } from "../src/P2TRProductionActivation.js"

const WORD = (byte: string) => byte.repeat(32)

describe("PostgreSQL production transaction capabilities", () => {
  it("rejects a structurally compatible autocommit session", () => {
    assert.throws(
      () =>
        new PostgresP2TRProductionActivationStore(
          { query: async () => ({ rows: [], rowCount: 0 }) },
          { storeID: "watchtower", maxEventHistoryRecords: 10 }
        ),
      /coordinator-owned transaction session/
    )
  })

  it("mints an adapter that works only inside its coordinator transaction", async () => {
    const client = new TransactionClient()
    const coordinator = coordinatorFor(client)
    const adapter =
      coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) => ({ query: () => session.query("SELECT 1") })
      )
    assert.throws(() => adapter.query(), /active transaction/)
    await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(() =>
      adapter.query()
    )
    assert.deepEqual(client.queries.slice(0, 4), [
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT current_setting('server_version_num') AS server_version_num",
      `SELECT version
         FROM p2tr_watchtower_schema_version
        WHERE component = 'canonical-evidence-index'`,
    ])
    assert.ok(client.queries.includes("SELECT 1"))
    assert.equal(client.releasedWith, undefined)
  })

  it("mints readiness authority before issuing a candidate authorization", async () => {
    const client = new TransactionClient()
    const coordinator = coordinatorFor(client)
    const store =
      coordinator.createP2TRSignatureFraudWatchtowerTransactionalAdapter(
        (session) =>
          new PostgresP2TRProductionActivationStore(session, {
            storeID: "watchtower",
            maxEventHistoryRecords: 10,
          })
      )

    await coordinator.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
      await store.lockReadinessSnapshot()
      const readinessCertificate = await store.mintReadinessCertificate(
        readinessInput()
      )
      assert.match(readinessCertificate.certificateID, /^0x[0-9a-f]{64}$/)
      assert.equal(readinessCertificate.generation, 1)
      await store.issueCandidateAuthorization({
        tokenID: WORD("10"),
        manifestHash: WORD("20"),
        candidateDigest: WORD("30"),
        candidate: {
          txid: WORD("40"),
          wtxid: WORD("41"),
          blockHeight: 10,
          blockHash: WORD("42"),
          inputIndex: 0,
          observationID: WORD("43"),
          challengeKey: WORD("44"),
        },
        readinessCertificate,
        verifiedBitcoin: { height: 10, hash: WORD("50") },
        verifiedEthereum: { blockNumber: 20, blockHash: WORD("60") },
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })
    })

    assert.ok(
      client.queries.some((query) =>
        query.includes("INSERT INTO p2tr_readiness_certificates")
      )
    )
    assert.ok(
      client.queries.some((query) =>
        query.includes("INSERT INTO p2tr_candidate_enqueue_authorizations")
      )
    )
  })

  it("destroys sessions after COMMIT or ROLLBACK ambiguity", async () => {
    for (const failure of ["COMMIT", "ROLLBACK"] as const) {
      const client = new TransactionClient(failure)
      const coordinator = coordinatorFor(client)
      await assert.rejects(
        coordinator.runInP2TRSignatureFraudWatchtowerTransaction(async () => {
          if (failure === "ROLLBACK") throw new Error("operation failed")
        })
      )
      assert.ok(client.releasedWith instanceof Error)
    }
  })
})

function coordinatorFor(client: P2TRPostgresClient) {
  return new PostgresP2TRCanonicalIndexStore(
    { connect: async () => client },
    {
      storeID: "watchtower",
      maxJournalBlocks: 10,
      maxJournalTransactions: 10,
      maxJournalInputs: 10,
      maxJournalOutputs: 10,
      maxWalletBindings: 10,
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
        clusterID: "transaction-session-test",
        operatorID: "transaction-session-test",
        bitcoinIdentityDigest: "21".repeat(32),
        ethereumIdentityDigest: "22".repeat(32),
      },
      readinessExportSigner: {
        keyID: "transaction-session-test",
        async signPayloadDigest(): Promise<string> {
          return "ab".repeat(64)
        },
      },
      readinessExportAcknowledgementVerifier: {
        async verify(): Promise<boolean> {
          return true
        },
      },
    }
  )
}

class TransactionClient implements P2TRPostgresClient {
  readonly queries: string[] = []
  releasedWith: Error | undefined

  constructor(private readonly failure?: "COMMIT" | "ROLLBACK") {}

  async query<Row>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push(text)
    if (text === this.failure) throw new Error(`${text} failed`)
    if (text.includes("server_version_num")) {
      return {
        rows: [{ server_version_num: "160000" }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("p2tr_watchtower_schema_version")) {
      return {
        rows: [{ version: 3 }] as Row[],
        rowCount: 1,
      }
    }
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
    if (text.includes("AS primary_bitcoin_generation")) {
      return {
        rows: [
          {
            activation_sequence: 1,
            primary_bitcoin_generation: 1,
            primary_bitcoin_root: WORD("70"),
            primary_bitcoin_semantic_root: WORD("71"),
            local_bitcoin_height: 10,
            local_bitcoin_hash: WORD("42"),
            ethereum_journal_generation: 1,
            ethereum_history_root: WORD("72"),
            local_ethereum_block: 20,
            local_ethereum_hash: WORD("60"),
          },
        ] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("RETURNING next_generation - 1")) {
      return {
        rows: [{ certificate_generation: 1 }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("INSERT INTO p2tr_readiness_certificates")) {
      return { rows: [], rowCount: 1 }
    }
    if (
      text.includes("SELECT encode(manifest_hash") &&
      text.includes("p2tr_watchtower_activation_manifest")
    ) {
      return {
        rows: [{ manifest_hash: WORD("20") }] as Row[],
        rowCount: 1,
      }
    }
    if (text.includes("INSERT INTO p2tr_candidate_enqueue_authorizations")) {
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }

  release(error?: Error): void {
    this.releasedWith = error
  }
}

function readinessInput(): P2TRProductionReadinessCertificateInput {
  const bitcoinIndex = {
    storeID: "watchtower",
    configurationFingerprint: WORD("80"),
    network: "main",
    checkpoint: { height: 0, hash: WORD("81") },
    current: { height: 10, hash: WORD("42") },
    canonicalBlockCount: 11,
    pendingCandidates: 0,
    pendingDepositReveals: 0,
    unmatchedProofs: 0,
    liveCandidateAuthorizations: 0,
    unbackfilledFrostWalletBindings: 0,
    failureGeneration: 0,
    clearedFailureGeneration: 0,
  }
  const ethereumJournal = {
    storeID: "watchtower",
    chainID: 1,
    configurationFingerprint: WORD("82"),
    descriptorSetHash: WORD("83"),
    checkpoint: { blockNumber: 9, blockHash: WORD("84") },
    scanStartBlock: 10,
    current: { blockNumber: 20, blockHash: WORD("60") },
    requiredEventHistoryDigest: WORD("85"),
    requiredEventCount: 1,
    requiredEventCoverage: {
      blocks: 11,
      transactions: 1,
      receipts: 1,
      logs: 1,
    },
    failureGeneration: 0,
    clearedFailureGeneration: 0,
  }
  return {
    manifestHash: WORD("20"),
    verifiedBitcoin: { height: 10, hash: WORD("50") },
    verifiedEthereum: { blockNumber: 20, blockHash: WORD("60") },
    bitcoinIndex,
    ethereumJournal,
    payload: {
      schema: "tbtc-p2tr-production-readiness-certificate/v1",
      manifestHash: WORD("20"),
      bitcoinIndex,
      ethereumJournal,
    },
  }
}
