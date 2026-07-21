import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"
import { readFile } from "node:fs/promises"
import { generateKeyPairSync, sign } from "node:crypto"
import test from "node:test"

import { Wallet, utils } from "ethers"
import pg from "pg"
import type { Client as PostgreSQLClient } from "pg"

import {
  Hex,
  P2TR_SIGNATURE_FRAUD_COMPLETE_V2_CHALLENGE_EVIDENCE_ABI_TYPE,
  P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL,
  P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID,
  computeP2TRCompleteV2SignatureFraudChallengeIdentity,
  computeP2TRSignatureFraudSubmissionIntentID,
} from "@keep-network/tbtc-v2.ts"

import {
  P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence,
  P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  P2TRSignatureFraudChallengeOutboxRecord,
  computeP2TRSignatureFraudCanonicalCandidateDigest,
  computeP2TRSignatureFraudCanonicalEventSetHash,
  computeP2TRSignatureFraudCanonicalProvenanceFingerprint,
  computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash,
  computeP2TRSignatureFraudChallengeFeePolicyHash,
} from "../src/P2TRSignatureFraudChallengeOutbox.js"
import {
  P2TR_PRODUCTION_ACTIVATION_HANDSHAKE_SCHEMA,
  PostgresP2TRSignatureFraudOutboxActivationHandshakeProvider,
} from "../src/PostgresP2TRSignatureFraudOutboxActivationHandshake.js"
import {
  PostgresP2TRSignatureFraudChallengeOutboxStore,
  computeP2TRProductionSignerLaneConfigurationHash,
} from "../src/PostgresP2TRSignatureFraudChallengeOutboxStore.js"
import type { P2TRSignatureFraudWatchtowerTransactionCoordinator } from "../src/types.js"

const postgresURL = process.env.P2TR_WATCHTOWER_TEST_POSTGRES_URL
const postgresTest = postgresURL === undefined ? test.skip : test
const MANIFEST_HASH = `0x${"a1".repeat(32)}`
const ETHEREUM_BLOCK_HASH = `0x${"a2".repeat(32)}`
const WALLET = new Wallet(`0x${"11".repeat(32)}`)
const { Client } = pg
const LANE_ID = "lane-a"
const SIGNER_IDENTITY = "signer-a"
const CHAIN_ID = 11155111
const BRIDGE_ADDRESS = `0x${"b1".repeat(20)}`
const ROUTER_ADDRESS = `0x${"b2".repeat(20)}`
const COMPLETE_AUTHORIZATION_REGISTRY_ADDRESS = `0x${"b3".repeat(20)}`
const COMPLETE_AUTHORIZATION_REGISTRY_PROTOCOL_ID = utils.id(
  "tbtc/p2tr-pre-signing-reservation/threshold-v1"
)
const COMPLETE_RESERVATION_MODEL = utils.id(
  "tbtc/p2tr-pre-signing-policy/default-no-annex-51-seats-v1"
)
let schemaSequence = 0

const runtimeMigrationDirectory =
  process.env.P2TR_WATCHTOWER_RUNTIME_MIGRATIONS ??
  "/private/tmp/tbtc-v2-activation-runtime/services/watchtower/migrations"

type TestDatabase = {
  client: PostgreSQLClient
  schema: string
  store: PostgresP2TRSignatureFraudChallengeOutboxStore
}

async function createTestDatabase(
  maxActiveOutboxRecords = 1_024
): Promise<TestDatabase> {
  const client = new Client({ connectionString: postgresURL })
  await client.connect()
  const schema = `p2tr_outbox_${process.pid}_${++schemaSequence}`
  await client.query(`CREATE SCHEMA ${schema}`)
  await client.query(`SET search_path TO ${schema}`)
  for (const migration of [
    `${runtimeMigrationDirectory}/001_p2tr_canonical_index.sql`,
    `${runtimeMigrationDirectory}/002_p2tr_canonical_ethereum.sql`,
    new URL(
      "../migrations/003_p2tr_signature_fraud_challenge_outbox.sql",
      import.meta.url
    ),
  ]) {
    await client.query(
      await readFile(
        migration instanceof URL ? migration : new URL(`file://${migration}`),
        "utf8"
      )
    )
  }
  await seedCanonicalPoint(client, maxActiveOutboxRecords)
  await client.query("BEGIN")
  const store = createStore(client)
  await store.installSignerLaneConfiguration(signerConfiguration())
  await client.query("COMMIT")
  return { client, schema, store }
}

function createStore(
  client: PostgreSQLClient,
  transactionCoordinator: Pick<
    P2TRSignatureFraudWatchtowerTransactionCoordinator,
    "runInP2TRSignatureFraudWatchtowerTransaction"
  > & {
    isP2TRSignatureFraudWatchtowerTransactionActive(): boolean
  } = {
    runInP2TRSignatureFraudWatchtowerTransaction: (operation) => operation(),
    isP2TRSignatureFraudWatchtowerTransactionActive: () => false,
  },
  assertTransactionSession: () => void = () => undefined,
  loadEligibilitySnapshot: () => Promise<P2TRSignatureFraudChallengeOutboxEligibilitySnapshot> = async () => {
    throw new Error(
      "Eligibility loading is outside this adapter integration test"
    )
  }
) {
  return new PostgresP2TRSignatureFraudChallengeOutboxStore({
    storeID: "postgres.integration",
    session: client,
    transactionCoordinator,
    assertTransactionSession,
    broadcastProviderID: "broadcast.integration",
    assertIndependentNonceReleaseResolution: () => true as const,
    lockAndAssertCurrentCanonicalProvenance: async (session, binding) => {
      await session.query("SELECT pg_advisory_xact_lock_shared(7142001)")
      const result = await session.query<{ current: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM p2tr_signature_fraud_challenge_outbox
            WHERE record_id = decode($1, 'hex')
              AND observation_id = decode($2, 'hex')
              AND bridge_challenge_key = decode($3, 'hex')
              AND bitcoin_tx_hash = decode($4, 'hex')
              AND bitcoin_wtxid = decode($5, 'hex')
              AND bitcoin_input_index = $6
              AND bitcoin_block_hash = decode($7, 'hex')
              AND bitcoin_block_height = $8
              AND canonical_provenance_fingerprint = decode($9, 'hex')
              AND canonical_candidate_provenance_generation = $10
              AND canonical_input_index = $6
              AND canonical_funding_block_hash = decode($11, 'hex')
              AND canonical_funding_txid = decode($12, 'hex')
              AND canonical_funding_vout = $13
              AND canonical_binding_ethereum_block_number = $14
              AND canonical_binding_ethereum_block_hash = decode($15, 'hex')
              AND provenance_invalidation_id IS NULL
         ) AS current`,
        [
          binding.recordID.slice(2),
          binding.observationID.slice(2),
          binding.bridgeChallengeKey.slice(2),
          binding.candidate.txid.slice(2),
          binding.candidate.wtxid.slice(2),
          binding.candidate.inputIndex,
          binding.candidate.blockHash.slice(2),
          binding.candidate.blockHeight,
          binding.provenance.provenanceFingerprint.slice(2),
          binding.provenance.candidateProvenanceGeneration,
          binding.provenance.fundingBlockHash.slice(2),
          binding.provenance.fundingTxid.slice(2),
          binding.provenance.fundingVout,
          binding.provenance.bindingEthereumBlockNumber,
          binding.provenance.bindingEthereumBlockHash.slice(2),
        ]
      )
      return result.rows[0].current
    },
    lockAndAssertCanonicalProvenanceInvalidation: async (session) => {
      await session.query("SELECT pg_advisory_xact_lock(7142001)")
    },
    loadEligibilitySnapshot,
  })
}

function createManagedStore(
  client: PostgreSQLClient,
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
) {
  const transaction = new AsyncLocalStorage<boolean>()
  const coordinator = {
    isP2TRSignatureFraudWatchtowerTransactionActive(): boolean {
      return transaction.getStore() === true
    },
    async runInP2TRSignatureFraudWatchtowerTransaction<T>(
      operation: () => Promise<T>
    ): Promise<T> {
      if (transaction.getStore() === true) return operation()
      await client.query("BEGIN")
      try {
        const result = await transaction.run(true, operation)
        await client.query("COMMIT")
        return result
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      }
    },
  }
  return createStore(
    client,
    coordinator,
    () => {
      if (transaction.getStore() !== true) {
        throw new Error("PostgreSQL session is outside its minted transaction")
      }
    },
    async () => snapshot
  )
}

function eligibilitySnapshotFor(
  record: P2TRSignatureFraudChallengeOutboxRecord
): P2TRSignatureFraudChallengeOutboxEligibilitySnapshot {
  return {
    challengeRecord: {
      observationID: record.intent.observationID,
      status: "observed",
      submissionAttempts: 0,
      challengeBroadcastReconciliationAttempts: 0,
    },
  } as P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
}

async function seedCanonicalPoint(
  client: PostgreSQLClient,
  maxActiveOutboxRecords: number
): Promise<void> {
  const zero = Buffer.alloc(32)
  const blockHash = Buffer.from(ETHEREUM_BLOCK_HASH.slice(2), "hex")
  await client.query(
    `INSERT INTO p2tr_ethereum_blocks (
        block_number, block_hash, parent_hash, block_timestamp,
        transactions_root, receipts_root,
        transaction_hashes, transaction_digest, transaction_count,
        receipt_digest, receipt_count, log_digest, log_count,
        required_event_digest, block_required_event_count, history_root,
        required_event_count, cumulative_block_count,
        cumulative_transaction_count, cumulative_receipt_count,
        cumulative_log_count
     ) VALUES (
        500, $1, $2, 1, $2, $2, '[]'::jsonb, $2, 0, $2, 0, $2, 0, $2, 0,
        $2, 0, 1, 0, 0, 0
     )`,
    [blockHash, zero]
  )
  await client.query(
    `INSERT INTO p2tr_ethereum_cursor (
        singleton, store_id, chain_id, configuration_fingerprint,
        descriptor_set_hash, scan_start_block, checkpoint_block_number,
        checkpoint_block_hash, current_block_number, current_block_hash,
        generation, journal_block_count, journal_event_count,
        coverage_block_count, coverage_transaction_count,
        coverage_receipt_count, coverage_log_count
     ) VALUES (
        true, 'ethereum.integration', $1, $2, $2, 500, 499, $2,
        500, $3, 1, 1, 0, 1, 0, 0, 0
     )`,
    [CHAIN_ID, zero, blockHash]
  )
  await client.query(
    `INSERT INTO p2tr_watchtower_activation_manifest (
        singleton, activation_sequence, manifest_hash,
        trusted_signer_key_hash, payload, envelope
     ) VALUES (true, 1, $1, $2, $3::jsonb, '{}'::jsonb)`,
    [
      Buffer.from(MANIFEST_HASH.slice(2), "hex"),
      zero,
      JSON.stringify({ outbox: { maxActiveOutboxRecords } }),
    ]
  )
}

function signerConfiguration() {
  const withoutHash = {
    activationManifestHash: MANIFEST_HASH,
    chainID: CHAIN_ID,
    policyHash: feePolicy().policyHash,
    challengeValueWei: "1234",
    laneID: LANE_ID,
    signerIdentity: SIGNER_IDENTITY,
    sender: WALLET.address,
    maxGasLimit: "1000000",
    maxFeePerGas: "100",
    maxPriorityFeePerGas: "10",
    maxTotalFeeWei: "100000000",
    signerCodeHash: `0x${"a3".repeat(32)}`,
  }
  return {
    ...withoutHash,
    configurationHash:
      computeP2TRProductionSignerLaneConfigurationHash(withoutHash),
    configuredAtUnixMs: 1_000,
  }
}

function feePolicy() {
  const withoutHash = {
    activationManifestHash: MANIFEST_HASH,
    chainID: CHAIN_ID,
    challengeValueWei: "1234",
    lanes: [
      {
        laneID: LANE_ID,
        signerIdentity: SIGNER_IDENTITY,
        sender: WALLET.address,
        maxGasLimit: "1000000",
        maxFeePerGas: "100",
        maxPriorityFeePerGas: "10",
        maxTotalFeeWei: "100000000",
      },
    ],
  }
  return {
    ...withoutHash,
    policyHash: computeP2TRSignatureFraudChallengeFeePolicyHash(withoutHash),
  }
}

function outboxRecord(seed: number): P2TRSignatureFraudChallengeOutboxRecord {
  const hex = (offset: number) =>
    `0x${((seed + offset) % 255).toString(16).padStart(2, "0").repeat(32)}`
  const walletID = hex(3)
  const sighash = hex(5)
  const signatureNonceX = hex(22)
  const signatureScalar = hex(23)
  const bridgeChallengeIdentity =
    computeP2TRCompleteV2SignatureFraudChallengeIdentity({
      domainChainID: CHAIN_ID,
      bridgeAddress: BRIDGE_ADDRESS,
      walletID,
      signingKey: walletID,
      sighash,
    })
  const challengePayload = utils.defaultAbiCoder.encode(
    [P2TR_SIGNATURE_FRAUD_COMPLETE_V2_CHALLENGE_EVIDENCE_ABI_TYPE],
    [
      {
        walletID,
        signingKey: walletID,
        bindingTxHash: `0x${"00".repeat(32)}`,
        bindingOutputIndex: 0,
        sighash,
        nonceX: signatureNonceX,
        signatureScalar,
      },
    ]
  )
  const calldata = new utils.Interface([
    "function processP2TRSignatureFraudChallenge(uint8 action, bytes payload, uint32[] walletMembersIDs)",
  ]).encodeFunctionData("processP2TRSignatureFraudChallenge", [
    0,
    challengePayload,
    [],
  ])
  const intentWithoutID = {
    protocol: P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL,
    evidenceProtocolID: Hex.from(P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID),
    observationID: Hex.from(hex(1)),
    inputIndex: 0,
    bridgeChallengeKey: bridgeChallengeIdentity,
    walletID: Hex.from(walletID),
    signingKey: Hex.from(walletID),
    bindingTxHash: Hex.from(`0x${"00".repeat(32)}`),
    bindingOutputIndex: 0,
    bridgeChallengeIdentity,
    sighash: Hex.from(sighash),
    nonceX: Hex.from(signatureNonceX),
    signatureScalar: Hex.from(signatureScalar),
    domainChainID: CHAIN_ID,
    chainID: CHAIN_ID,
    bridgeAddress: BRIDGE_ADDRESS,
    routerAddress: ROUTER_ADDRESS,
    calldata,
    value: "1234",
  }
  const intent = {
    ...intentWithoutID,
    intentID: computeP2TRSignatureFraudSubmissionIntentID(intentWithoutID),
  }
  const candidate = {
    txid: hex(6),
    wtxid: hex(7),
    inputIndex: 0,
    blockHash: hex(8),
    blockHeight: 100,
  }
  const provenanceWithoutFingerprint = {
    journalStoreID: "canonical.integration",
    descriptorSetHash: hex(9),
    throughBlockNumber: 500,
    throughBlockHash: ETHEREUM_BLOCK_HASH,
    historyRoot: hex(10),
    eventSetHash: computeP2TRSignatureFraudCanonicalEventSetHash([hex(11)]),
    eventCount: 1,
    challengeKey: intent.bridgeChallengeKey.toPrefixedString(),
    candidateDigest: computeP2TRSignatureFraudCanonicalCandidateDigest(
      candidate,
      intent.observationID
    ),
    readinessCertificateID: hex(12),
    readinessCertificateGeneration: 1,
    candidateProvenanceGeneration: 1,
    inputBindingKind: "registered-wallet-output" as const,
    inputBindingSourceEventID: hex(11),
    inputIndex: 0,
    fundingBlockHash: hex(13),
    fundingTxid: hex(14),
    fundingVout: 0,
    inputWalletID: intent.walletID.toPrefixedString(),
    inputOutputKey: intent.walletID.toPrefixedString(),
    bindingEthereumBlockNumber: 499,
    bindingEthereumBlockHash: hex(15),
    manifestHash: MANIFEST_HASH,
  }
  return {
    seriesID: hex(16),
    recordID: hex(17),
    intent,
    evidenceCheckpoint: {
      confirmedSourceComplete: true,
      bitcoinTxHash: candidate.txid,
      bitcoinWitnessTxHash: candidate.wtxid,
      bitcoinInputIndex: candidate.inputIndex,
      bitcoinBlockHash: candidate.blockHash,
      bitcoinBlockHeight: candidate.blockHeight,
      bitcoinCursorBlockHash: hex(18),
      bitcoinCursorBlockHeight: 120,
      ethereumLifecycleBlockHash: ETHEREUM_BLOCK_HASH,
      ethereumLifecycleBlockNumber: 500,
      activationManifest: {
        manifestHash: MANIFEST_HASH,
        routerCodeHash: hex(19),
        routerProtocolID: P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID,
        routerDomainChainID: CHAIN_ID,
        completeAuthorizationRegistryAddress:
          COMPLETE_AUTHORIZATION_REGISTRY_ADDRESS,
        completeAuthorizationRegistryCodeHash: hex(20),
        completeAuthorizationRegistryProtocolID:
          COMPLETE_AUTHORIZATION_REGISTRY_PROTOCOL_ID,
        completeReservationModel: COMPLETE_RESERVATION_MODEL,
      },
      submittedEventScanFromBlock: 50,
    },
    canonicalEthereumEligibility: {
      readAtBlockNumber: 500,
      readAtBlockHash: ETHEREUM_BLOCK_HASH,
      chainID: CHAIN_ID,
      routerAddress: intent.routerAddress,
      routerCodeHash: hex(19),
      routerProtocolID: P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID,
      routerDomainChainID: CHAIN_ID,
      routerBridgeAddress: intent.bridgeAddress,
      routerChallengeKey: intent.bridgeChallengeKey.toPrefixedString(),
      routerChallengeAbsent: true,
      completeAuthorizationRegistryAddress:
        COMPLETE_AUTHORIZATION_REGISTRY_ADDRESS,
      completeAuthorizationRegistryCodeHash: hex(20),
      completeAuthorizationRegistryProtocolID:
        COMPLETE_AUTHORIZATION_REGISTRY_PROTOCOL_ID,
      completeReservationModel: COMPLETE_RESERVATION_MODEL,
      completeChallengeIdentity:
        intent.bridgeChallengeIdentity.toPrefixedString(),
      completeWalletID: intent.walletID.toPrefixedString(),
      completeExactChallengeAuthorizationAbsent: true,
      completeExactTransactionAuthorizationAbsent: true,
      completeWalletReservationActive: false,
      walletChallengeable: true,
      canonicalProofBacklogComplete: true,
      activationManifestHash: MANIFEST_HASH,
      readSetHash: hex(21),
    },
    canonicalProvenance: {
      ...provenanceWithoutFingerprint,
      provenanceFingerprint:
        computeP2TRSignatureFraudCanonicalProvenanceFingerprint(
          provenanceWithoutFingerprint
        ),
    },
    feePolicyManifest: feePolicy(),
    status: "queued",
    version: 0,
    generation: 0,
    generationTrigger: { kind: "initial" },
    createdAtUnixMs: 1_000,
    updatedAtUnixMs: 1_000,
    preparationAttempts: 0,
    broadcastAttempts: 0,
    reconciliationAttempts: 0,
  }
}

async function begin(client: PostgreSQLClient): Promise<void> {
  await client.query("BEGIN")
}

async function beginSerializable(client: PostgreSQLClient): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
}

async function commit(client: PostgreSQLClient): Promise<void> {
  await client.query("COMMIT")
}

async function openSchemaClient(schema: string): Promise<PostgreSQLClient> {
  const client = new Client({ connectionString: postgresURL })
  await client.connect()
  await client.query(`SET search_path TO ${schema}`)
  return client
}

async function insertRecord(
  database: TestDatabase,
  record: P2TRSignatureFraudChallengeOutboxRecord
): Promise<void> {
  await begin(database.client)
  await database.store.insertGenerationIfAbsent(record)
  await commit(database.client)
}

function selectedRecord(
  current: P2TRSignatureFraudChallengeOutboxRecord,
  now = 1_100
): P2TRSignatureFraudChallengeOutboxRecord {
  return {
    ...current,
    status: "preparing",
    version: current.version + 1,
    updatedAtUnixMs: now,
    preparationAttempts: current.preparationAttempts + 1,
    preparationLease: { owner: "worker.integration", expiresAtUnixMs: 10_000 },
    preparationSender: WALLET.address,
    selectedLaneID: LANE_ID,
    selectedSignerIdentity: SIGNER_IDENTITY,
  }
}

function reservedRecord(
  current: P2TRSignatureFraudChallengeOutboxRecord,
  now = 1_200
): P2TRSignatureFraudChallengeOutboxRecord {
  return {
    ...current,
    version: current.version + 1,
    updatedAtUnixMs: now,
    reservedNonce: {
      reservationID: Hex.from(`0x${"d1".repeat(32)}`),
      outboxRecordID: Hex.from(current.recordID),
      intentID: current.intent.intentID,
      generation: current.generation,
      laneID: LANE_ID,
      signerIdentity: SIGNER_IDENTITY,
      sender: WALLET.address,
      nonce: 7,
      bindingSignature: `0x${"01".repeat(65)}`,
    },
    nonceReservedAtUnixMs: now,
  }
}

async function advanceToReservation(
  database: TestDatabase,
  initial: P2TRSignatureFraudChallengeOutboxRecord
): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
  await begin(database.client)
  let current = (await database.store.get(initial.recordID))!
  const selected = selectedRecord(current)
  assert.equal(
    await database.store.compareAndSwap(
      current.recordID,
      current.version,
      selected
    ),
    true
  )
  current = selected
  const reserved = reservedRecord(current)
  assert.equal(
    await database.store.compareAndSwap(
      current.recordID,
      current.version,
      reserved
    ),
    true
  )
  await commit(database.client)
  return reserved
}

function invalidationEvidence(
  record: P2TRSignatureFraudChallengeOutboxRecord
): P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence {
  const withoutHash = {
    provenanceTombstoneID: `0x${"e1".repeat(32)}`,
    candidate: {
      txid: record.evidenceCheckpoint.bitcoinTxHash,
      wtxid: record.evidenceCheckpoint.bitcoinWitnessTxHash,
      inputIndex: record.evidenceCheckpoint.bitcoinInputIndex,
      blockHash: record.evidenceCheckpoint.bitcoinBlockHash,
      blockHeight: record.evidenceCheckpoint.bitcoinBlockHeight,
    },
    observationID: record.intent.observationID.toPrefixedString(),
    candidateDigest: record.canonicalProvenance.candidateDigest,
    candidateProvenanceGeneration:
      record.canonicalProvenance.candidateProvenanceGeneration,
    provenanceFingerprint: record.canonicalProvenance.provenanceFingerprint,
    manifestHash: record.canonicalProvenance.manifestHash,
    ethereumRollbackBlockHash: `0x${"e2".repeat(32)}`,
    ethereumRollbackBlockNumber: 501,
    provenanceInvalidationSequence: 1,
    invalidatedAtUnixMs: 2_000,
    reason: "canonical funding occurrence was rolled back",
  }
  return {
    ...withoutHash,
    evidenceHash:
      computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash(
        withoutHash
      ),
  }
}

function activationProvider(
  client: PostgreSQLClient,
  now: () => number,
  manifestHash = MANIFEST_HASH
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const publicDer = publicKey.export({ type: "spki", format: "der" })
  return new PostgresP2TRSignatureFraudOutboxActivationHandshakeProvider({
    storeID: "postgres.integration",
    session: client,
    assertTransactionSession: () => undefined,
    keyProvider: {
      signerPublicKeySpki: publicDer.toString("base64"),
      signP2TRActivationPayload: async (bytes) => sign(null, bytes, privateKey),
    },
    readCurrentReadinessCertificate: async () => ({
      certificateID: `0x${"e3".repeat(32)}`,
      certificateGeneration: 1,
      manifestHash,
      ethereumPoint: {
        blockNumber: 500,
        blockHash: ETHEREUM_BLOCK_HASH,
      },
    }),
    now,
  })
}

const activationRequest = {
  schema: P2TR_PRODUCTION_ACTIVATION_HANDSHAKE_SCHEMA,
  challenge: {
    nonce: `0x${"e4".repeat(32)}`,
    manifestHash: MANIFEST_HASH,
    ethereumPoint: {
      blockNumber: 500,
      blockHash: ETHEREUM_BLOCK_HASH,
    },
  },
}

postgresTest(
  "keeps eligibility enqueue and caller cursor effects atomic and invisible until commit",
  async () => {
    const database = await createTestDatabase()
    const first = outboxRecord(2)
    const managed = createManagedStore(
      database.client,
      eligibilitySnapshotFor(first)
    )
    const observer = await openSchemaClient(database.schema)
    let markInserted!: () => void
    let releaseCommit!: () => void
    const inserted = new Promise<void>((resolve) => {
      markInserted = resolve
    })
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })

    const pending = managed.runInEligibilityTransaction(
      first.intent.observationID.toPrefixedString(),
      async () => {
        await database.client.query(
          "UPDATE p2tr_ethereum_cursor SET generation = generation + 1 WHERE singleton = true"
        )
        await managed.insertGenerationIfAbsent(first)
        markInserted()
        await commitGate
        return first.recordID
      }
    )
    await inserted
    const beforeCommit = await observer.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM p2tr_signature_fraud_challenge_outbox"
    )
    assert.equal(beforeCommit.rows[0].count, "0")
    releaseCommit()
    assert.equal(await pending, first.recordID)
    const afterCommit = await observer.query<{
      count: string
      generation: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM p2tr_signature_fraud_challenge_outbox) AS count,
         (SELECT generation::text FROM p2tr_ethereum_cursor WHERE singleton) AS generation`
    )
    assert.deepEqual(afterCommit.rows[0], { count: "1", generation: "2" })

    const second = outboxRecord(3)
    const rollbackStore = createManagedStore(
      database.client,
      eligibilitySnapshotFor(second)
    )
    await assert.rejects(
      rollbackStore.runInEligibilityTransaction(
        second.intent.observationID.toPrefixedString(),
        async () => {
          await database.client.query(
            "UPDATE p2tr_ethereum_cursor SET generation = generation + 1 WHERE singleton = true"
          )
          await rollbackStore.insertGenerationIfAbsent(second)
          throw new Error("simulated caller crash")
        }
      ),
      /simulated caller crash/
    )
    const afterRollback = await observer.query<{
      count: string
      generation: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM p2tr_signature_fraud_challenge_outbox) AS count,
         (SELECT generation::text FROM p2tr_ethereum_cursor WHERE singleton) AS generation`
    )
    assert.deepEqual(afterRollback.rows[0], { count: "1", generation: "2" })
    await observer.end()
    await database.client.end()
  }
)

postgresTest(
  "serializes concurrent enqueues at the signed manifest capacity without advancing the losing cursor",
  async () => {
    const database = await createTestDatabase(1)
    const secondClient = await openSchemaClient(database.schema)
    const first = outboxRecord(4)
    const second = outboxRecord(5)
    const firstStore = createManagedStore(
      database.client,
      eligibilitySnapshotFor(first)
    )
    const secondStore = createManagedStore(
      secondClient,
      eligibilitySnapshotFor(second)
    )
    const enqueue = (
      client: PostgreSQLClient,
      store: PostgresP2TRSignatureFraudChallengeOutboxStore,
      record: P2TRSignatureFraudChallengeOutboxRecord
    ) =>
      store.runInEligibilityTransaction(
        record.intent.observationID.toPrefixedString(),
        async () => {
          await client.query(
            "UPDATE p2tr_ethereum_cursor SET generation = generation + 1 WHERE singleton = true"
          )
          return store.insertGenerationIfAbsent(record)
        }
      )

    const results = await Promise.allSettled([
      enqueue(database.client, firstStore, first),
      enqueue(secondClient, secondStore, second),
    ])
    assert.equal(
      results.filter(({ status }) => status === "fulfilled").length,
      1
    )
    const rejected = results.find(({ status }) => status === "rejected")
    assert.equal(rejected?.status, "rejected")
    assert.match(
      String((rejected as PromiseRejectedResult).reason),
      /manifest-bound global active outbox capacity is exhausted/i
    )
    const durable = await database.client.query<{
      count: string
      generation: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM p2tr_signature_fraud_challenge_outbox) AS count,
         (SELECT generation::text FROM p2tr_ethereum_cursor WHERE singleton) AS generation`
    )
    assert.deepEqual(durable.rows[0], { count: "1", generation: "2" })
    await secondClient.end()
    await database.client.end()
  }
)

postgresTest(
  "keeps a concurrent identical enqueue idempotent when capacity is full",
  async () => {
    const database = await createTestDatabase(1)
    const secondClient = await openSchemaClient(database.schema)
    const record = outboxRecord(6)
    const firstStore = createManagedStore(
      database.client,
      eligibilitySnapshotFor(record)
    )
    const secondStore = createManagedStore(
      secondClient,
      eligibilitySnapshotFor(record)
    )

    const [first, second] = await Promise.all([
      firstStore.insertGenerationIfAbsent(record),
      secondStore.insertGenerationIfAbsent(record),
    ])

    assert.equal(first.recordID, record.recordID)
    assert.equal(second.recordID, record.recordID)
    const durable = await database.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM p2tr_signature_fraud_challenge_outbox"
    )
    assert.equal(durable.rows[0].count, "1")
    await secondClient.end()
    await database.client.end()
  }
)

postgresTest(
  "rejects non-schema evidence fields instead of persisting raw payload aliases",
  async () => {
    const database = await createTestDatabase()
    const record = outboxRecord(7)
    const polluted = {
      ...record,
      evidenceCheckpoint: {
        ...record.evidenceCheckpoint,
        bitcoinTransaction: `0x${"01".repeat(128)}`,
      },
    } as P2TRSignatureFraudChallengeOutboxRecord
    const managed = createManagedStore(
      database.client,
      eligibilitySnapshotFor(record)
    )

    await assert.rejects(
      managed.insertGenerationIfAbsent(polluted),
      /evidence checkpoint contains unsupported durable field bitcoinTransaction/
    )
    const durable = await database.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM p2tr_signature_fraud_challenge_outbox"
    )
    assert.equal(durable.rows[0].count, "0")
    await database.client.end()
  }
)

function activationRequestFor(manifestHash: string) {
  return {
    ...activationRequest,
    challenge: { ...activationRequest.challenge, manifestHash },
  }
}

postgresTest(
  "commits one competing CAS and rejects the stale writer",
  async () => {
    const database = await createTestDatabase()
    const record = outboxRecord(1)
    await insertRecord(database, record)
    const secondClient = await openSchemaClient(database.schema)
    const secondStore = createStore(secondClient)

    await begin(database.client)
    await begin(secondClient)
    const first = { ...record, version: 1, updatedAtUnixMs: 1_001 }
    const second = { ...record, version: 1, updatedAtUnixMs: 1_002 }
    assert.equal(
      await database.store.compareAndSwap(record.recordID, 0, first),
      true
    )
    const competing = secondStore.compareAndSwap(record.recordID, 0, second)
    await commit(database.client)
    assert.equal(await competing, false)
    await commit(secondClient)
    await secondClient.end()
    const durable = await database.store.get(record.recordID)
    assert.equal(durable?.updatedAtUnixMs, 1_001)
    await database.client.end()
  }
)

postgresTest(
  "rejects immutable generation tampering in the adapter and database",
  async () => {
    const database = await createTestDatabase()
    const record = outboxRecord(16)
    await insertRecord(database, record)
    const replacementFundingBlockHash = `0x${"9f".repeat(32)}`

    await begin(database.client)
    const tampered: P2TRSignatureFraudChallengeOutboxRecord = {
      ...record,
      version: 1,
      updatedAtUnixMs: 1_001,
      canonicalProvenance: {
        ...record.canonicalProvenance,
        fundingBlockHash: replacementFundingBlockHash,
      },
    }
    assert.equal(
      await database.store.compareAndSwap(record.recordID, 0, tampered),
      false
    )
    await commit(database.client)
    assert.equal(
      (await database.store.get(record.recordID))?.canonicalProvenance
        .fundingBlockHash,
      record.canonicalProvenance.fundingBlockHash
    )

    await begin(database.client)
    await assert.rejects(
      database.client.query(
        `UPDATE p2tr_signature_fraud_challenge_outbox
          SET version = version + 1,
              updated_at_unix_ms = updated_at_unix_ms + 1,
              record_state = jsonb_set(
                  jsonb_set(
                      record_state,
                      '{canonicalProvenance,fundingBlockHash}',
                      to_jsonb($2::text)
                  ),
                  '{version}',
                  to_jsonb(version + 1)
              )
        WHERE record_id = decode($1, 'hex')`,
        [record.recordID.slice(2), replacementFundingBlockHash]
      ),
      /serialized P2TR outbox generation identity and evidence are immutable/
    )
    await database.client.query("ROLLBACK")
    await database.client.end()
  }
)

postgresTest(
  "serializes canonical invalidation ahead of a signer claim",
  async () => {
    const database = await createTestDatabase()
    const record = outboxRecord(30)
    await insertRecord(database, record)
    const claimClient = await openSchemaClient(database.schema)
    const claimStore = createStore(claimClient)

    await begin(database.client)
    await database.store.invalidateCanonicalProvenance(
      invalidationEvidence(record)
    )
    await begin(claimClient)
    const claimed = claimStore.compareAndSwapWithCurrentCanonicalProvenance(
      record.recordID,
      0,
      record.canonicalProvenance,
      { ...record, version: 1, updatedAtUnixMs: 2_001 }
    )
    await commit(database.client)
    assert.equal(await claimed, false)
    await commit(claimClient)
    const durable = await claimStore.get(record.recordID)
    assert.equal(durable?.status, "cancelled-provenance-invalidated")
    assert.equal(
      durable?.provenanceInvalidationEvidence?.evidenceHash,
      invalidationEvidence(record).evidenceHash
    )
    await claimClient.end()
    await database.client.end()
  }
)

postgresTest(
  "atomically inserts and tombstones a reservation returned after invalidation won",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(41)
    await insertRecord(database, initial)
    await begin(database.client)
    const selected = selectedRecord(initial)
    assert.equal(
      await database.store.compareAndSwap(
        initial.recordID,
        initial.version,
        selected
      ),
      true
    )
    await commit(database.client)

    await begin(database.client)
    const [invalidated] = await database.store.invalidateCanonicalProvenance(
      invalidationEvidence(initial)
    )
    await commit(database.client)
    assert.equal(invalidated.status, "preparing")
    assert.equal(invalidated.reservedNonce, undefined)
    const reservation = reservedRecord(selected).reservedNonce!
    const voidedAtUnixMs = 2_100
    const tombstoned: P2TRSignatureFraudChallengeOutboxRecord = {
      ...invalidated,
      status: "cancelled-provenance-invalidated",
      version: invalidated.version + 1,
      preparationLease: undefined,
      preparationSender: undefined,
      selectedLaneID: undefined,
      selectedSignerIdentity: undefined,
      voidedNonceReservations: [
        {
          reservation,
          voidedAtUnixMs,
          reasonCode: "reservation-abandoned",
          reason: "canonical provenance was invalidated before signing",
          evidenceDigest: `0x${"f1".repeat(32)}`,
        },
      ],
      updatedAtUnixMs: voidedAtUnixMs,
      lastError: "canonical provenance was invalidated before signing",
    }
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        initial.recordID,
        invalidated.version,
        tombstoned
      ),
      true
    )
    await commit(database.client)
    const guard = await database.client.query<{
      guard: string
      voided: string
      reason: string
    }>(
      `SELECT encode(nonce_guard_id, 'hex') AS guard,
              voided_before_sign_at_unix_ms::text AS voided,
              void_reason AS reason
         FROM p2tr_signature_fraud_challenge_nonce_guard`
    )
    assert.deepEqual(guard.rows, [
      {
        guard: reservation.reservationID.toPrefixedString().slice(2),
        voided: String(voidedAtUnixMs),
        reason: "reservation-abandoned",
      },
    ])
    await database.client.end()
  }
)

postgresTest(
  "atomically tombstones a reservation returned after lease recovery cleared the lane",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(44)
    await insertRecord(database, initial)
    const selected = selectedRecord(initial)
    const reservation = reservedRecord(selected).reservedNonce!
    const recovered: P2TRSignatureFraudChallengeOutboxRecord = {
      ...selected,
      status: "queued",
      version: selected.version + 1,
      preparationLease: undefined,
      preparationSender: undefined,
      selectedLaneID: undefined,
      selectedSignerIdentity: undefined,
      updatedAtUnixMs: 40_001,
      lastError:
        "Challenge outbox preparation lease expired before signer invocation",
    }
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        initial.recordID,
        initial.version,
        selected
      ),
      true
    )
    assert.equal(
      await database.store.compareAndSwap(
        selected.recordID,
        selected.version,
        recovered
      ),
      true
    )
    await commit(database.client)

    const voidedAtUnixMs = 40_002
    const tombstoned: P2TRSignatureFraudChallengeOutboxRecord = {
      ...recovered,
      version: recovered.version + 1,
      voidedNonceReservations: [
        {
          reservation,
          voidedAtUnixMs,
          reasonCode: "reservation-expired",
          reason:
            "Nonce reservation returned after its durable preparation claim was lost",
          evidenceDigest: `0x${"f2".repeat(32)}`,
        },
      ],
      updatedAtUnixMs: voidedAtUnixMs,
    }
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        recovered.recordID,
        recovered.version,
        tombstoned
      ),
      true
    )
    await commit(database.client)
    const guard = await database.client.query<{
      voided: string
      reason: string
    }>(
      `SELECT voided_before_sign_at_unix_ms::text AS voided,
              void_reason AS reason
         FROM p2tr_signature_fraud_challenge_nonce_guard`
    )
    assert.deepEqual(guard.rows, [
      { voided: String(voidedAtUnixMs), reason: "reservation-expired" },
    ])
    await database.client.end()
  }
)

postgresTest(
  "persists exact late signer bytes after provenance invalidation",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(45)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)

    await begin(database.client)
    const signerBoundary: P2TRSignatureFraudChallengeOutboxRecord = {
      ...reserved,
      version: reserved.version + 1,
      updatedAtUnixMs: 1_300,
      signerInvocationStartedAtUnixMs: 1_300,
      activeSignerInvocationStartedAtUnixMs: 1_300,
    }
    assert.equal(
      await database.store.compareAndSwap(
        reserved.recordID,
        reserved.version,
        signerBoundary
      ),
      true
    )
    await commit(database.client)

    await begin(database.client)
    const [invalidated] = await database.store.invalidateCanonicalProvenance(
      invalidationEvidence(initial)
    )
    await commit(database.client)
    assert.equal(
      invalidated.status,
      "provenance-invalidated-awaiting-reconciliation"
    )

    const rawTransaction = await WALLET.signTransaction({
      type: 2,
      chainId: CHAIN_ID,
      to: initial.intent.routerAddress,
      data: initial.intent.calldata,
      value: initial.intent.value,
      nonce: 7,
      gasLimit: 100_000,
      maxFeePerGas: 100,
      maxPriorityFeePerGas: 10,
    })
    const transactionHash = utils.keccak256(rawTransaction)
    await begin(database.client)
    const captured = await database.store.captureEscapedSignedArtifact(
      initial.recordID,
      initial.canonicalProvenance.provenanceFingerprint,
      {
        expectedReservationID:
          signerBoundary.reservedNonce!.reservationID.toPrefixedString(),
        capturedAtUnixMs: 2_100,
        reason: "signer returned after the canonical invalidation CAS",
        preparedTransaction: {
          intentID: initial.intent.intentID,
          rawTransaction,
          transactionHash: Hex.from(transactionHash),
          sender: WALLET.address,
          nonce: 7,
        },
      }
    )
    await commit(database.client)
    assert.equal(captured.unexpectedSignedArtifacts?.length, 1)
    assert.equal(
      captured.unexpectedSignedArtifacts?.[0].preparedTransaction
        .rawTransaction,
      rawTransaction
    )
    const ledger = await database.client.query<{
      raw_transaction: string
      incidents: string
      alerts: string
    }>(
      `SELECT
       encode(raw_transaction, 'hex') AS raw_transaction,
       (SELECT count(*)
          FROM p2tr_signature_fraud_challenge_provenance_incident)::text AS incidents,
       (SELECT count(*)
          FROM p2tr_signature_fraud_challenge_critical_alert)::text AS alerts
       FROM p2tr_signature_fraud_challenge_late_signed_artifact`
    )
    assert.deepEqual(ledger.rows[0], {
      raw_transaction: rawTransaction.slice(2),
      incidents: "2",
      alerts: "2",
    })
    await database.client.end()
  }
)

postgresTest(
  "persists valid late signer bytes after an expired lease wins the state CAS",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(52)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    const signerBoundary: P2TRSignatureFraudChallengeOutboxRecord = {
      ...reserved,
      version: reserved.version + 1,
      updatedAtUnixMs: 1_300,
      signerInvocationStartedAtUnixMs: 1_300,
      activeSignerInvocationStartedAtUnixMs: 1_300,
    }
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        reserved.recordID,
        reserved.version,
        signerBoundary
      ),
      true
    )
    await commit(database.client)
    const expired: P2TRSignatureFraudChallengeOutboxRecord = {
      ...signerBoundary,
      status: "quarantined",
      version: signerBoundary.version + 1,
      preparationLease: undefined,
      activeSignerInvocationStartedAtUnixMs: undefined,
      signerQuarantines: [
        {
          laneID: LANE_ID,
          signerIdentity: SIGNER_IDENTITY,
          expectedSender: WALLET.address,
          expectedNonce: 7,
          reservationID:
            signerBoundary.reservedNonce!.reservationID.toPrefixedString(),
          reasonCode: "ambiguous-signer-invocation",
          quarantinedAtUnixMs: 40_001,
          reason:
            "Challenge outbox preparation lease expired after the signer boundary; nonce lane retained",
          detailsDigest: `0x${"f1".repeat(32)}`,
        },
      ],
      updatedAtUnixMs: 40_001,
      lastError:
        "Challenge outbox preparation lease expired after the signer boundary; nonce lane retained",
    }
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        signerBoundary.recordID,
        signerBoundary.version,
        expired
      ),
      true
    )
    await commit(database.client)

    const rawTransaction = await WALLET.signTransaction({
      type: 2,
      chainId: CHAIN_ID,
      to: initial.intent.routerAddress,
      data: initial.intent.calldata,
      value: initial.intent.value,
      nonce: 7,
      gasLimit: 100_000,
      maxFeePerGas: 100,
      maxPriorityFeePerGas: 10,
    })
    const transactionHash = utils.keccak256(rawTransaction)
    const managed = createManagedStore(
      database.client,
      eligibilitySnapshotFor(initial)
    )
    const captured = await managed.captureEscapedSignedArtifact(
      initial.recordID,
      initial.canonicalProvenance.provenanceFingerprint,
      {
        expectedReservationID:
          signerBoundary.reservedNonce!.reservationID.toPrefixedString(),
        capturedAtUnixMs: 40_002,
        reason: "signer returned after its preparation lease expired",
        preparedTransaction: {
          intentID: initial.intent.intentID,
          rawTransaction,
          transactionHash: Hex.from(transactionHash),
          sender: WALLET.address,
          nonce: 7,
        },
      }
    )
    assert.equal(captured.status, "quarantined")
    assert.equal(captured.unexpectedSignedArtifacts?.length, 1)
    const durable = await database.client.query<{
      artifacts: string
      alerts: string
      provenance_incidents: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM p2tr_signature_fraud_challenge_late_signed_artifact) AS artifacts,
         (SELECT count(*)::text FROM p2tr_signature_fraud_challenge_critical_alert
           WHERE code = 'late-signed-artifact-captured') AS alerts,
         (SELECT count(*)::text FROM p2tr_signature_fraud_challenge_provenance_incident) AS provenance_incidents`
    )
    assert.deepEqual(durable.rows[0], {
      artifacts: "1",
      alerts: "1",
      provenance_incidents: "0",
    })
    await database.client.end()
  }
)

postgresTest(
  "recovers the exact signed bytes after a committed send boundary",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(60)
    await insertRecord(database, initial)
    let current = await advanceToReservation(database, initial)
    await begin(database.client)
    const signerBoundary: P2TRSignatureFraudChallengeOutboxRecord = {
      ...current,
      version: current.version + 1,
      updatedAtUnixMs: 1_300,
      signerInvocationStartedAtUnixMs: 1_300,
      activeSignerInvocationStartedAtUnixMs: 1_300,
    }
    assert.equal(
      await database.store.compareAndSwap(
        current.recordID,
        current.version,
        signerBoundary
      ),
      true
    )
    current = signerBoundary
    const rawTransaction = await WALLET.signTransaction({
      type: 2,
      chainId: CHAIN_ID,
      to: current.intent.routerAddress,
      data: current.intent.calldata,
      value: current.intent.value,
      nonce: 7,
      gasLimit: 100_000,
      maxFeePerGas: 100,
      maxPriorityFeePerGas: 10,
    })
    const transactionHash = utils.keccak256(rawTransaction)
    const preparedTransaction = {
      intentID: current.intent.intentID,
      rawTransaction,
      transactionHash: Hex.from(transactionHash),
      sender: WALLET.address,
      nonce: 7,
    }
    const prepared: P2TRSignatureFraudChallengeOutboxRecord = {
      ...current,
      status: "prepared",
      version: current.version + 1,
      updatedAtUnixMs: 1_400,
      preparationLease: undefined,
      activeSignerInvocationStartedAtUnixMs: undefined,
      preparedTransaction,
      preparedTransactionVariants: [
        {
          sequence: 0,
          preparedTransaction,
          signedAtUnixMs: 1_400,
          broadcastAttempts: 0,
        },
      ],
    }
    assert.equal(
      await database.store.compareAndSwap(
        current.recordID,
        current.version,
        prepared
      ),
      true
    )
    const attempted: P2TRSignatureFraudChallengeOutboxRecord = {
      ...prepared,
      status: "broadcast-pending",
      version: prepared.version + 1,
      updatedAtUnixMs: 1_500,
      broadcastAttempts: 1,
      lastBroadcastAtUnixMs: 1_500,
      lastPreBroadcastRecheckAtUnixMs: 1_500,
      lastPreBroadcastRecheckStatus: "eligible",
      preparedTransactionVariants: [
        {
          ...prepared.preparedTransactionVariants![0],
          broadcastAttempts: 1,
          lastBroadcastAtUnixMs: 1_500,
        },
      ],
    }
    assert.equal(
      await database.store.compareAndSwap(
        prepared.recordID,
        prepared.version,
        attempted
      ),
      true
    )
    await commit(database.client)

    const restartedClient = await openSchemaClient(database.schema)
    const restarted = createStore(restartedClient)
    const durable = await restarted.get(initial.recordID)
    assert.equal(
      durable?.preparedTransactionVariants?.[0].preparedTransaction
        .rawTransaction,
      rawTransaction
    )
    const ledger = await restartedClient.query<{
      attempts: string
      acknowledgements: string
    }>(
      `SELECT
       (SELECT count(*) FROM p2tr_signature_fraud_challenge_outbox_broadcast_attempt)::text AS attempts,
       (SELECT count(*) FROM p2tr_signature_fraud_challenge_outbox_broadcast_acknowledgement)::text AS acknowledgements`
    )
    assert.deepEqual(ledger.rows[0], { attempts: "1", acknowledgements: "0" })
    await begin(restartedClient)
    const mutatedRawTransaction = `${rawTransaction}00`
    const mutatedPreparedTransaction = {
      ...durable!.preparedTransaction!,
      rawTransaction: mutatedRawTransaction,
    }
    const mutatedVariant: P2TRSignatureFraudChallengeOutboxRecord = {
      ...durable!,
      version: durable!.version + 1,
      updatedAtUnixMs: durable!.updatedAtUnixMs + 1,
      preparedTransaction: mutatedPreparedTransaction,
      preparedTransactionVariants: [
        {
          ...durable!.preparedTransactionVariants![0],
          preparedTransaction: mutatedPreparedTransaction,
        },
      ],
    }
    assert.equal(
      await restarted.compareAndSwap(
        durable!.recordID,
        durable!.version,
        mutatedVariant
      ),
      false
    )
    await commit(restartedClient)
    assert.equal(
      (await restarted.get(initial.recordID))?.preparedTransactionVariants?.[0]
        .preparedTransaction.rawTransaction,
      rawTransaction
    )
    await restartedClient.end()
    await database.client.end()
  }
)

postgresTest(
  "signs a healthy empty-outbox activation snapshot from one sample",
  async () => {
    const database = await createTestDatabase()
    let samples = 0
    await beginSerializable(database.client)
    const response = await activationProvider(database.client, () => {
      samples++
      return 5_000
    }).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(samples, 1)
    assert.equal(response.payload.state.activeGenerationCount, 0)
    assert.equal(response.payload.state.configuredSignerLaneCount, 1)
    assert.equal(response.payload.state.healthySignerLaneCount, 1)
    assert.equal(response.payload.state.danglingNonceGuardCount, 0)
    assert.equal(response.payload.state.activationBlocked, false)
    await database.client.end()
  }
)

postgresTest(
  "rejects one signer identity configured for multiple lanes",
  async () => {
    const database = await createTestDatabase()
    await begin(database.client)
    const first = signerConfiguration()
    const secondWithoutHash = {
      ...first,
      laneID: "lane-b",
      configurationHash: undefined,
      configuredAtUnixMs: undefined,
    }
    delete secondWithoutHash.configurationHash
    delete secondWithoutHash.configuredAtUnixMs
    await assert.rejects(
      database.store.installSignerLaneConfiguration({
        ...secondWithoutHash,
        configurationHash:
          computeP2TRProductionSignerLaneConfigurationHash(secondWithoutHash),
        configuredAtUnixMs: 1_001,
      }),
      /duplicate key value violates unique constraint/
    )
    await database.client.query("ROLLBACK")
    await database.client.end()
  }
)

postgresTest(
  "blocks activation when every configured lane is quarantined",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(90)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    const quarantine = {
      laneID: LANE_ID,
      signerIdentity: SIGNER_IDENTITY,
      expectedSender: WALLET.address,
      expectedNonce: 7,
      reservationID: reserved.reservedNonce!.reservationID.toPrefixedString(),
      reasonCode: "ambiguous-signer-invocation" as const,
      quarantinedAtUnixMs: 1_300,
      reason: "signer response was ambiguous",
      detailsDigest: `0x${"f1".repeat(32)}`,
    }
    const quarantined: P2TRSignatureFraudChallengeOutboxRecord = {
      ...reserved,
      status: "quarantined",
      version: reserved.version + 1,
      updatedAtUnixMs: 1_300,
      preparationLease: undefined,
      signerQuarantines: [quarantine],
      lastError: quarantine.reason,
    }
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        reserved.recordID,
        reserved.version,
        quarantined
      ),
      true
    )
    await commit(database.client)

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(response.payload.state.configuredSignerLaneCount, 1)
    assert.equal(response.payload.state.quarantinedSignerLaneCount, 1)
    assert.equal(response.payload.state.healthySignerLaneCount, 0)
    assert.ok(
      response.payload.state.activationBlockingReasons.includes(
        "no-healthy-manifest-bound-signer-lane"
      )
    )
    await database.client.end()
  }
)

postgresTest(
  "blocks activation on a durable nonce guard not linked to its record",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(120)
    await insertRecord(database, initial)
    await begin(database.client)
    const selected = selectedRecord(initial)
    assert.equal(
      await database.store.compareAndSwap(initial.recordID, 0, selected),
      true
    )
    await database.client.query(
      `INSERT INTO p2tr_signature_fraud_challenge_nonce_guard (
        nonce_guard_id, record_id, guard_kind, chain_id, signer_lane_id,
        signer_identity, sender, transaction_nonce, reservation_binding,
        guarded_at_unix_ms
     ) VALUES (
        decode($1, 'hex'), decode($2, 'hex'), 'bound-reservation', $3,
        $4, $5, decode($6, 'hex'), 7, decode('01', 'hex'), 1200
     )`,
      [
        "f2".repeat(32),
        initial.recordID.slice(2),
        CHAIN_ID,
        LANE_ID,
        SIGNER_IDENTITY,
        WALLET.address.slice(2),
      ]
    )
    await commit(database.client)

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(response.payload.state.unresolvedNonceGuardCount, 1)
    assert.equal(response.payload.state.danglingNonceGuardCount, 1)
    assert.ok(
      response.payload.state.activationBlockingReasons.includes(
        "dangling-unaccounted-nonce-guard"
      )
    )
    await database.client.end()
  }
)

postgresTest(
  "rotates policy manifests atomically and ignores historical lanes",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(150)
    await insertRecord(database, initial)
    const nextManifest = `0x${"f3".repeat(32)}`
    const old = signerConfiguration()
    const nextWithoutHash = {
      ...old,
      activationManifestHash: nextManifest,
      policyHash: `0x${"f4".repeat(32)}`,
      configurationHash: undefined,
      configuredAtUnixMs: undefined,
    }
    delete nextWithoutHash.configurationHash
    delete nextWithoutHash.configuredAtUnixMs
    await begin(database.client)
    await database.store.installSignerLaneConfiguration({
      ...nextWithoutHash,
      configurationHash:
        computeP2TRProductionSignerLaneConfigurationHash(nextWithoutHash),
      configuredAtUnixMs: 2_000,
    })
    await database.client.query(
      `UPDATE p2tr_watchtower_activation_manifest
        SET activation_sequence = 2,
            manifest_hash = decode($1, 'hex'),
            payload = '{"sequence":2,"outbox":{"maxActiveOutboxRecords":1024}}'::jsonb,
            envelope = '{"sequence":2}'::jsonb
      WHERE singleton`,
      [nextManifest.slice(2)]
    )
    await commit(database.client)

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000,
      nextManifest
    ).attestActivationChallenge(activationRequestFor(nextManifest))
    const rotated = await database.store.get(initial.recordID)
    await commit(database.client)
    assert.equal(rotated?.status, "cancelled-provenance-invalidated")
    assert.equal(response.payload.state.manifestActivationSequence, 2)
    assert.equal(response.payload.state.configuredSignerLaneCount, 1)
    assert.equal(response.payload.state.healthySignerLaneCount, 1)
    assert.equal(response.payload.state.activeOldManifestGenerationCount, 0)
    assert.equal(response.payload.state.activationBlocked, false)
    await database.client.end()
  }
)
