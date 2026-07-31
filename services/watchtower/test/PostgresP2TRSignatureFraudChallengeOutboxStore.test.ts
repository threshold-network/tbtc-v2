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
  P2TRSignatureFraudIndependentSignerBoundaryResolution,
  P2TRSignatureFraudNonceReleaseRequest,
  P2TRSignatureFraudSignerQuarantine,
  computeP2TRSignatureFraudCanonicalCandidateDigest,
  computeP2TRSignatureFraudCanonicalEventSetHash,
  computeP2TRSignatureFraudCanonicalProvenanceFingerprint,
  computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash,
  computeP2TRSignatureFraudChallengeFeePolicyHash,
  computeP2TRSignatureFraudLegacyV4SignerBoundaryResolutionEvidenceDigest,
  computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest,
  computeP2TRSignatureFraudSignerBoundaryResolutionEvidenceDigest,
} from "../src/P2TRSignatureFraudChallengeOutbox.js"
import {
  P2TR_PRODUCTION_ACTIVATION_HANDSHAKE_SCHEMA,
  PostgresP2TRSignatureFraudOutboxActivationHandshakeProvider,
  type P2TROutboxCurrentReadinessCertificate,
  type P2TRPostgresOutboxTransactionSession,
} from "../src/PostgresP2TRSignatureFraudOutboxActivationHandshake.js"
import {
  assertP2TRProductionOutboxHandshake,
  assertP2TRProductionOutboxRevalidation,
} from "../src/P2TRProductionActivation.js"
import { normalizeOutboxRevalidation } from "../src/PostgresP2TRProductionActivationStore.js"
import {
  PostgresP2TRSignatureFraudChallengeOutboxStore,
  computeP2TRProductionSignerLaneConfigurationHash,
} from "../src/PostgresP2TRSignatureFraudChallengeOutboxStore.js"
import type { P2TRSignatureFraudWatchtowerTransactionCoordinator } from "../src/types.js"
import { InMemoryOutboxStore } from "./InMemoryP2TRSignatureFraudChallengeOutboxStore.js"

const postgresURL = process.env.P2TR_WATCHTOWER_TEST_POSTGRES_URL
const postgresTest = postgresURL === undefined ? test.skip : test
const MANIFEST_HASH = `0x${"a1".repeat(32)}`
const ETHEREUM_BLOCK_HASH = `0x${"a2".repeat(32)}`
const WALLET = new Wallet(`0x${"11".repeat(32)}`)
const { Client } = pg
const LANE_ID = "lane-a"
const SIGNER_IDENTITY = "signer-a"
const OUTBOX_PROTOCOL_ID = `0x${"a3".repeat(32)}`
const OUTBOX_IMPLEMENTATION_CODE_HASH = `0x${"a4".repeat(32)}`
const OUTBOX_MIGRATION_CHECKSUM = `0x${"a5".repeat(32)}`
const OUTBOX_LANE_OPERATOR_FINGERPRINT = `0x${"a6".repeat(32)}`
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

const runtimeMigrationDirectory = process.env.P2TR_WATCHTOWER_RUNTIME_MIGRATIONS

type TestDatabase = {
  client: PostgreSQLClient
  schema: string
  store: PostgresP2TRSignatureFraudChallengeOutboxStore
}

async function createTestDatabase(
  maxActiveOutboxRecords = 1_024,
  migrationCount = 8
): Promise<TestDatabase> {
  const client = new Client({ connectionString: postgresURL })
  await client.connect()
  const schema = `p2tr_outbox_${process.pid}_${++schemaSequence}`
  await client.query(`CREATE SCHEMA ${schema}`)
  await client.query(`SET search_path TO ${schema}`)
  for (const migration of [
    runtimeMigrationDirectory === undefined
      ? new URL("../migrations/001_p2tr_canonical_index.sql", import.meta.url)
      : new URL(
          `file://${runtimeMigrationDirectory}/001_p2tr_canonical_index.sql`
        ),
    runtimeMigrationDirectory === undefined
      ? new URL(
          "../migrations/002_p2tr_canonical_ethereum.sql",
          import.meta.url
        )
      : new URL(
          `file://${runtimeMigrationDirectory}/002_p2tr_canonical_ethereum.sql`
        ),
    new URL(
      "../migrations/003_p2tr_signature_fraud_challenge_outbox.sql",
      import.meta.url
    ),
    new URL(
      "../migrations/004_p2tr_candidate_enqueue_retry_alerts.sql",
      import.meta.url
    ),
    new URL(
      "../migrations/005_p2tr_deposit_binding_byte_order.sql",
      import.meta.url
    ),
    new URL(
      "../migrations/006_p2tr_signer_boundary_late_artifact.sql",
      import.meta.url
    ),
    new URL(
      "../migrations/007_p2tr_signer_boundary_nonce_finality.sql",
      import.meta.url
    ),
    new URL(
      "../migrations/008_p2tr_signed_variant_exact_gas.sql",
      import.meta.url
    ),
  ].slice(0, migrationCount)) {
    await client.query(await readFile(migration, "utf8"))
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

/**
 * The deployment-owned lane binding the handshake compares the configuration
 * row against. It mirrors `signerConfiguration()` exactly, so a test that wants
 * a mismatch overrides one field.
 */
function boundSenderLane(
  overrides: Partial<{
    chainID: number
    signerIdentity: string
    sender: string
    policyHash: string
    signerCodeHash: string
    configurationHash: string
  }> = {}
) {
  const configuration = signerConfiguration()
  return {
    laneID: LANE_ID,
    trustDomainID: "signer.trust.integration",
    operatorFingerprint: OUTBOX_LANE_OPERATOR_FINGERPRINT,
    chainID: CHAIN_ID,
    signerIdentity: SIGNER_IDENTITY,
    sender: WALLET.address.toLowerCase(),
    policyHash: configuration.policyHash,
    signerCodeHash: configuration.signerCodeHash,
    configurationHash: configuration.configurationHash,
    ...overrides,
  }
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
    maxGasLimit: "100000",
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
        maxGasLimit: "100000",
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
      fraudChallengeDepositAmount: "1234",
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
      // The durable nonce guard requires a bound reservation epoch; it is the
      // preparation attempt the reservation was minted for.
      reservationEpoch: current.preparationAttempts,
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

async function createPendingNonceRelease(
  database: TestDatabase,
  seed: number
): Promise<P2TRSignatureFraudNonceReleaseRequest> {
  const initial = outboxRecord(seed)
  await insertRecord(database, initial)
  const reserved = await advanceToReservation(database, initial)
  const voidedAtUnixMs = 1_300
  const voided: P2TRSignatureFraudChallengeOutboxRecord = {
    ...reserved,
    status: "queued",
    version: reserved.version + 1,
    preparationLease: undefined,
    preparationSender: undefined,
    selectedLaneID: undefined,
    selectedSignerIdentity: undefined,
    reservedNonce: undefined,
    nonceReservedAtUnixMs: undefined,
    voidedNonceReservations: [
      {
        reservation: reserved.reservedNonce!,
        voidedAtUnixMs,
        reasonCode: "reservation-expired",
        reason: "test restart recovery",
        evidenceDigest: `0x${"f5".repeat(32)}`,
      },
    ],
    updatedAtUnixMs: voidedAtUnixMs,
    lastError: "test restart recovery",
  }
  await begin(database.client)
  assert.equal(
    await database.store.compareAndSwap(
      reserved.recordID,
      reserved.version,
      voided
    ),
    true
  )
  await commit(database.client)
  const pending = await database.store.listPendingNonceReleases({ limit: 10 })
  assert.equal(pending.requests.length, 1)
  return pending.requests[0]
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
  manifestHash = MANIFEST_HASH,
  readCurrentReadinessCertificate:
    | (() => Promise<P2TROutboxCurrentReadinessCertificate | undefined>)
    | null = async () => ({
    certificateID: `0x${"e3".repeat(32)}`,
    certificateGeneration: 1,
    manifestHash,
    ethereumPoint: {
      blockNumber: 500,
      blockHash: ETHEREUM_BLOCK_HASH,
    },
  }),
  senderLanes = [boundSenderLane()],
  maxRecoveryBacklog = 0
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
    activationBinding: {
      protocolID: OUTBOX_PROTOCOL_ID,
      sender: WALLET.address,
      routerAddress: ROUTER_ADDRESS,
      implementationCodeHash: OUTBOX_IMPLEMENTATION_CODE_HASH,
      preparedTransactionPersistence: "durable-before-broadcast",
      replacementPolicy: "append-only-same-intent-fee-bump-v1",
      migrationVersion: 3,
      migrationChecksum: OUTBOX_MIGRATION_CHECKSUM,
      maxRecoveryBacklog,
      senderLanes,
    },
    ...(readCurrentReadinessCertificate === null
      ? {}
      : { readCurrentReadinessCertificate }),
    now,
  })
}

/** The manifest half of the gate's assertion, bound to the sampled catalog. */
function outboxManifest(databaseConstraintHash: string) {
  return {
    storeID: "postgres.integration",
    protocolID: OUTBOX_PROTOCOL_ID,
    sender: WALLET.address,
    routerAddress: ROUTER_ADDRESS,
    implementationCodeHash: OUTBOX_IMPLEMENTATION_CODE_HASH,
    databaseConstraintHash,
    attestationSignerKeyHash: `0x${"a7".repeat(32)}`,
    handshakeEndpointFingerprint: `0x${"a8".repeat(32)}`,
    handshakeOperatorFingerprint: `0x${"a9".repeat(32)}`,
    signerTrustDomainID: "signer.trust.integration",
    broadcastTrustDomainID: "broadcast.trust.integration",
    reconciliationTrustDomainID: "reconciliation.trust.integration",
    preparedTransactionPersistence: "durable-before-broadcast" as const,
    replacementPolicy: "append-only-same-intent-fee-bump-v1" as const,
    migrationVersion: 3 as const,
    migrationChecksum: OUTBOX_MIGRATION_CHECKSUM,
    maxActiveOutboxRecords: 1_024,
    maxRecoveryBacklog: 0,
    senderLanes: [
      {
        laneID: LANE_ID,
        trustDomainID: "signer.trust.integration",
        operatorFingerprint: OUTBOX_LANE_OPERATOR_FINGERPRINT,
      },
    ],
  }
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

test("freezes signer-lane installation while readiness is current", async () => {
  const queries: string[] = []
  const session: P2TRPostgresOutboxTransactionSession = {
    async query<Row>(text: string): Promise<{
      rows: Row[]
      rowCount: number | null
    }> {
      queries.push(text)
      if (text.includes("p2tr_readiness_certificates")) {
        return {
          rows: [{ readiness_is_current: true } as Row],
          rowCount: 1,
        }
      }
      throw new Error("signer-lane INSERT must not run")
    },
  }
  const store = createStore(session as unknown as PostgreSQLClient)

  await assert.rejects(
    store.installSignerLaneConfiguration(signerConfiguration()),
    /Signer lane configuration is frozen while readiness is current/
  )
  assert.equal(queries.length, 1)
  assert.match(queries[0], /p2tr_readiness_certificates/)
  assert.doesNotMatch(queries[0], /INSERT INTO/)
})

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
      activeSignerInvocationID: boundaryInvocationID(1_300),
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
    // A canonical rollback cannot cancel an already-issued signer RPC, so the
    // preparation claim and its active marker survive the invalidation. Only
    // the worker that observes the RPC return moves the generation into
    // reconciliation, which the capture below performs.
    assert.equal(invalidated.status, "preparing")
    assert.notEqual(
      invalidated.activeSignerInvocationStartedAtUnixMs,
      undefined
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
  "reconstructs and independently resolves the exact nonce-release invocation after restart",
  async () => {
    const database = await createTestDatabase()
    const request = await createPendingNonceRelease(database, 48)

    await begin(database.client)
    await assert.rejects(
      database.client.query(
        `INSERT INTO p2tr_signature_fraud_challenge_nonce_release_attempt (
            release_request_id, attempt_sequence, owner,
            started_at_unix_ms, expires_at_unix_ms
         ) VALUES (decode($1, 'hex'), 1, $2, 10000, 20000)`,
        [request.releaseRequestID.slice(2), " owner-with-edge-space "]
      ),
      /check constraint/i
    )
    await database.client.query("ROLLBACK")

    await assert.rejects(
      database.store.claimNonceReleaseAttempt(
        request.releaseRequestID,
        "restart\tworker",
        10_000,
        20_000
      ),
      /owner.*between 1 and 128 characters/i
    )
    await assert.rejects(
      database.store.claimNonceReleaseAttempt(
        request.releaseRequestID,
        "restart\u00a0worker",
        10_000,
        20_000
      ),
      /owner.*between 1 and 128 characters/i
    )

    const attempt = await database.store.claimNonceReleaseAttempt(
      request.releaseRequestID,
      "\u2003restart worker\u2003",
      10_000,
      20_000
    )
    assert.ok(attempt)
    assert.equal(attempt.owner, "restart worker")
    assert.equal(
      await database.store.beginNonceReleaseAttempt(attempt, 10_001),
      true
    )

    const restartedClient = await openSchemaClient(database.schema)
    const restarted = createStore(restartedClient)
    assert.equal(
      await restarted.getActiveAmbiguousNonceReleaseInvocation(19_999),
      undefined
    )
    const resultless = await restarted.getActiveAmbiguousNonceReleaseInvocation(
      20_000
    )
    assert.ok(resultless)
    assert.deepEqual(resultless.attempt, attempt)
    assert.equal(resultless.invokedAtUnixMs, 10_001)
    assert.equal(resultless.ambiguousResponseDigest, undefined)

    const responseDigest = `0x${"f6".repeat(32)}`
    assert.equal(
      await restarted.recordNonceReleaseAttemptResult(attempt, {
        kind: "ambiguous-error",
        responseDigest,
        detail: "allocator response was lost across restart",
        recordedAtUnixMs: 20_001,
      }),
      "ambiguous"
    )
    const ambiguous = await restarted.getActiveAmbiguousNonceReleaseInvocation(
      20_001
    )
    assert.equal(ambiguous?.ambiguousResponseDigest, responseDigest)

    const providerEvidenceDigest = `0x${"f7".repeat(32)}`
    const resolutionBinding = {
      releaseRequestID: request.releaseRequestID,
      attemptSequence: attempt.attemptSequence,
      attemptOwner: attempt.owner,
      attemptStartedAtUnixMs: attempt.startedAtUnixMs,
      attemptExpiresAtUnixMs: attempt.expiresAtUnixMs,
      invokedAtUnixMs: 10_001,
      outcome: "already-released" as const,
      providerEvidenceDigest,
    }
    const evidenceDigest =
      computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest(
        resolutionBinding
      )
    assert.equal(
      await restarted.resolveAmbiguousNonceRelease({
        ...resolutionBinding,
        evidenceDigest,
        canonicalAttestations: [
          {
            trustDomainID: "allocator-primary",
            independenceDomainID: "allocator-primary-infra",
            evidenceDigest,
            attestation: "0x01",
            attestedAtUnixMs: 20_002,
          },
          {
            trustDomainID: "allocator-corroborating",
            independenceDomainID: "allocator-corroborating-infra",
            evidenceDigest,
            attestation: "0x02",
            attestedAtUnixMs: 20_002,
          },
        ],
        resolvedAtUnixMs: 20_002,
      }),
      "acknowledged"
    )
    assert.equal(
      await restarted.getActiveAmbiguousNonceReleaseInvocation(20_002),
      undefined
    )
    assert.equal(await restarted.hasPendingNonceReleases(), false)
    const barrier = await restartedClient.query<{
      active: Buffer | null
      unresolved: number
    }>(
      `SELECT (SELECT active_release_request_id
                 FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
                WHERE active_release_request_id IS NOT NULL
                LIMIT 1) AS active,
              (SELECT COALESCE(sum(unresolved_release_count), 0)::integer
                 FROM p2tr_signature_fraud_nonce_allocator_safety_barrier)
                AS unresolved`
    )
    assert.deepEqual(barrier.rows[0], { active: null, unresolved: 0 })

    await restartedClient.end()
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
      activeSignerInvocationID: boundaryInvocationID(1_300),
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
      // Lease expiry never proves the issued signer RPC stopped, so recovery
      // retains the active marker. Only the worker that observes the return
      // may clear it, and the capture below is that observation.
      activeSignerInvocationStartedAtUnixMs:
        signerBoundary.activeSignerInvocationStartedAtUnixMs,
      activeSignerInvocationID: signerBoundary.activeSignerInvocationID,
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
  "refuses a signed variant that is not at the exact manifest gas limit",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(61)
    await insertRecord(database, initial)
    const current = await advanceToReservation(database, initial)
    await begin(database.client)
    const signerBoundary: P2TRSignatureFraudChallengeOutboxRecord = {
      ...current,
      version: current.version + 1,
      updatedAtUnixMs: 1_300,
      signerInvocationStartedAtUnixMs: 1_300,
      activeSignerInvocationStartedAtUnixMs: 1_300,
      activeSignerInvocationID: boundaryInvocationID(1_300),
    }
    assert.equal(
      await database.store.compareAndSwap(
        current.recordID,
        current.version,
        signerBoundary
      ),
      true
    )

    // Under the manifest limit, not over it: the transaction is affordable but
    // runs out of gas, and the reserved nonce is spent on nothing. Only the
    // runtime validator used to catch this, so a worker that bypassed it could
    // make the state durable.
    const underGassed = await WALLET.signTransaction({
      type: 2,
      chainId: CHAIN_ID,
      to: initial.intent.routerAddress,
      data: initial.intent.calldata,
      value: initial.intent.value,
      nonce: 7,
      gasLimit: 21_000,
      maxFeePerGas: 100,
      maxPriorityFeePerGas: 10,
    })
    const preparedTransaction = {
      intentID: initial.intent.intentID,
      rawTransaction: underGassed,
      transactionHash: Hex.from(utils.keccak256(underGassed)),
      sender: WALLET.address,
      nonce: 7,
    }
    await assert.rejects(
      database.store.compareAndSwap(
        signerBoundary.recordID,
        signerBoundary.version,
        {
          ...signerBoundary,
          status: "prepared",
          version: signerBoundary.version + 1,
          updatedAtUnixMs: 1_400,
          preparationLease: undefined,
          activeSignerInvocationStartedAtUnixMs: undefined,
          activeSignerInvocationID: undefined,
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
      ),
      /manifest-bound fee or value policy/
    )
    await database.client.query("ROLLBACK")
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
      activeSignerInvocationID: boundaryInvocationID(1_300),
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
      activeSignerInvocationID: undefined,
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
    assert.ok(durable?.intent.evidenceProtocolID instanceof Hex)
    assert.ok(durable.intent.signingKey instanceof Hex)
    assert.ok(durable.intent.bindingTxHash instanceof Hex)
    assert.ok(durable.intent.nonceX instanceof Hex)
    assert.ok(durable.intent.signatureScalar instanceof Hex)
    assert.ok(
      durable.intent.evidenceProtocolID.equals(
        initial.intent.evidenceProtocolID
      )
    )
    assert.ok(durable.intent.signingKey.equals(initial.intent.signingKey))
    assert.ok(durable.intent.bindingTxHash.equals(initial.intent.bindingTxHash))
    assert.ok(durable.intent.nonceX.equals(initial.intent.nonceX))
    assert.ok(
      durable.intent.signatureScalar.equals(initial.intent.signatureScalar)
    )
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

    const readActivationAmbiguity = async () => {
      await beginSerializable(restartedClient)
      const response = await activationProvider(
        restartedClient,
        () => 5_000
      ).attestActivationChallenge(activationRequest)
      const revalidation = normalizeOutboxRevalidation(
        (
          await restartedClient.query<Record<string, string | number>>(
            `SELECT *
               FROM p2tr_signature_fraud_outbox_activation_revalidation($1, $2)`,
            [Buffer.from(MANIFEST_HASH.slice(2), "hex"), 5_000]
          )
        ).rows[0]
      )
      await commit(restartedClient)
      return { response, revalidation }
    }
    const unacknowledged = await readActivationAmbiguity()
    assert.equal(
      unacknowledged.response.payload.state.ambiguousTransactionCount,
      1
    )
    assert.equal(unacknowledged.revalidation.ambiguousTransactionCount, 1)
    assert.ok(
      unacknowledged.response.payload.state.activationBlockingReasons.includes(
        "ambiguous-broadcast-response"
      )
    )

    await restartedClient.query(
      `INSERT INTO p2tr_signature_fraud_challenge_outbox_broadcast_acknowledgement (
          record_id, generation, variant_sequence, attempt_number, result,
          returned_transaction_hash, error, acknowledged_at_unix_ms
       ) VALUES (decode($1, 'hex'), $2, $3, $4, 'ambiguous', NULL, $5, $6)`,
      [
        initial.recordID.toString().replace(/^0x/, ""),
        0,
        0,
        1,
        "provider response was ambiguous",
        1_600,
      ]
    )
    const acknowledgedAmbiguous = await readActivationAmbiguity()
    assert.equal(
      acknowledgedAmbiguous.response.payload.state.ambiguousTransactionCount,
      1
    )
    assert.equal(
      acknowledgedAmbiguous.revalidation.ambiguousTransactionCount,
      1
    )
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
    assert.equal(response.payload.state.storeID, "postgres.integration")
    assert.equal(response.payload.state.protocolID, OUTBOX_PROTOCOL_ID)
    assert.equal(response.payload.state.sender, WALLET.address.toLowerCase())
    assert.equal(
      response.payload.state.routerAddress,
      ROUTER_ADDRESS.toLowerCase()
    )
    assert.equal(
      response.payload.state.databaseConstraintHash,
      response.payload.state.schemaConstraintHash
    )
    assert.equal(response.payload.state.startupReconciliationComplete, true)
    assert.equal(response.payload.state.ambiguousTransactionCount, 0)
    assert.equal(response.payload.state.liveCandidateAuthorizationCount, 0)
    assert.deepEqual(response.payload.state.senderLanes, [
      {
        laneID: LANE_ID,
        trustDomainID: "signer.trust.integration",
        operatorFingerprint: OUTBOX_LANE_OPERATOR_FINGERPRINT,
        healthy: true,
      },
    ])
    assert.equal(response.payload.state.healthy, true)
    assert.doesNotThrow(() =>
      assertP2TRProductionOutboxHandshake(
        response.payload.state,
        outboxManifest(response.payload.state.schemaConstraintHash)
      )
    )
    await database.client.end()
  }
)

postgresTest(
  "does not report an in-bound recovery backlog as activation-blocking",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(87)
    await insertRecord(database, initial)
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        initial.recordID,
        initial.version,
        selectedRecord(initial)
      ),
      true
    )
    await commit(database.client)

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 20_000,
      MANIFEST_HASH,
      undefined,
      [boundSenderLane()],
      1
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    assert.equal(response.payload.state.recoveryBacklogCount, 1)
    assert.equal(response.payload.state.healthy, true)
    assert.equal(response.payload.state.activationBlocked, false)
    assert.deepEqual(response.payload.state.activationBlockingReasons, [])
    await database.client.end()
  }
)

postgresTest(
  "bootstraps the production handshake before any readiness certificate exists",
  async () => {
    const database = await createTestDatabase()
    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000,
      MANIFEST_HASH,
      null
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    assert.equal("currentReadinessCertificate" in response.payload.state, false)
    assert.equal(response.payload.state.startupReconciliationComplete, true)
    assert.equal(response.payload.state.healthy, true)
    await database.client.end()
  }
)

postgresTest(
  "blocks activation on an unresolved legacy submission quarantine",
  async () => {
    const database = await createTestDatabase()
    await database.store.saveLegacyQuarantine({
      observationID: `0x${"c1".repeat(32)}`,
      legacyStatus: "submitting",
      submissionAttempts: 1,
      reason: "legacy submission has no authenticated outbox record",
      quarantinedAtUnixMs: 2_000,
    })

    await beginSerializable(database.client)
    const blocked = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    // The signer lanes are healthy, which is exactly the case that used to
    // report zero here because the count aliased the lane quarantine.
    assert.equal(blocked.payload.state.quarantinedSignerLaneCount, 0)
    assert.equal(blocked.payload.state.unresolvedLegacyQuarantineCount, 1)
    assert.equal(blocked.payload.state.healthy, false)
    assert.ok(
      blocked.payload.state.activationBlockingReasons.includes(
        "unresolved-legacy-submission-quarantine"
      )
    )
    assert.throws(
      () =>
        assertP2TRProductionOutboxHandshake(
          blocked.payload.state,
          outboxManifest(blocked.payload.state.schemaConstraintHash)
        ),
      /not activation-ready/
    )

    await database.client.query(
      `INSERT INTO p2tr_signature_fraud_legacy_submission_quarantine_resolution (
          observation_id, outcome, resolution_digest, reason, resolved_at_unix_ms
       ) VALUES (decode($1, 'hex'), $2, decode($3, 'hex'), $4, $5)`,
      [
        "c1".repeat(32),
        "legacy-submission-never-landed",
        "c2".repeat(32),
        "operator confirmed the legacy broadcast never landed",
        4_000,
      ]
    )

    await beginSerializable(database.client)
    const cleared = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(cleared.payload.state.unresolvedLegacyQuarantineCount, 0)
    assert.equal(cleared.payload.state.healthy, true)
    await assert.rejects(
      database.client.query(
        `UPDATE p2tr_signature_fraud_legacy_submission_quarantine_resolution
            SET reason = 'rewritten audit evidence'`
      ),
      /append-only/
    )
    await assert.rejects(
      database.client.query(
        `DELETE FROM p2tr_signature_fraud_legacy_submission_quarantine_resolution`
      ),
      /append-only/
    )
    await database.client.end()
  }
)

postgresTest(
  "blocks a generation-required record stranded by a rotated-out manifest",
  async () => {
    const database = await createTestDatabase()
    const record = outboxRecord(240)
    await insertRecord(database, record)
    // A restore or replication path can land a row without running the status
    // triggers; that is precisely the state the audit has to see.
    await database.client.query("SET session_replication_role = replica")
    await database.client.query(
      `UPDATE p2tr_signature_fraud_challenge_outbox
          SET status = 'generation-required',
              nonce_disposition_id = decode($2, 'hex'),
              lane_released_at_unix_ms = $3
        WHERE record_id = decode($1, 'hex')`,
      [record.recordID.slice(2), "e9".repeat(32), 3_000]
    )
    // The capacity counter is trigger-maintained, so it has to follow the row
    // into its terminal status by hand or the audit reports that mismatch
    // instead of the one under test.
    await database.client.query(
      `UPDATE p2tr_signature_fraud_challenge_outbox_capacity
          SET active_generation_count = 0
        WHERE singleton = true`
    )
    await database.client.query("SET session_replication_role = origin")

    await beginSerializable(database.client)
    const pending = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    // Its successor is created by the enqueue path this same gate authorizes,
    // so a current-manifest record owing one is reported, never blocking.
    assert.equal(pending.payload.state.pendingGenerationSuccessorCount, 1)
    assert.equal(pending.payload.state.staleManifestGenerationSuccessorCount, 0)
    assert.equal(pending.payload.state.activeOldManifestGenerationCount, 0)
    assert.equal(pending.payload.state.healthy, true)

    await database.client.query("SET session_replication_role = replica")
    await database.client.query(
      `UPDATE p2tr_signature_fraud_challenge_outbox
          SET activation_manifest_hash = decode($2, 'hex'),
              canonical_provenance_manifest_hash = decode($2, 'hex')
        WHERE record_id = decode($1, 'hex')`,
      [record.recordID.slice(2), "d4".repeat(32)]
    )
    await database.client.query("SET session_replication_role = origin")

    await beginSerializable(database.client)
    const stranded = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    // Terminal for capacity, so the old-manifest generation count still reads
    // zero -- the successor audit is the only thing that sees this record.
    assert.equal(stranded.payload.state.activeOldManifestGenerationCount, 0)
    assert.equal(
      stranded.payload.state.staleManifestGenerationSuccessorCount,
      1
    )
    assert.equal(stranded.payload.state.startupReconciliationComplete, false)
    assert.equal(stranded.payload.state.healthy, false)
    assert.ok(
      stranded.payload.state.activationBlockingReasons.includes(
        "stale-manifest-generation-successor"
      )
    )
    await database.client.end()
  }
)

postgresTest(
  "refuses a lane whose stored configuration is not the bound one",
  async () => {
    const database = await createTestDatabase()
    for (const drifted of [
      boundSenderLane({ signerCodeHash: `0x${"d1".repeat(32)}` }),
      boundSenderLane({ signerIdentity: "signer-b" }),
      boundSenderLane({ sender: `0x${"d2".repeat(20)}` }),
      boundSenderLane({ policyHash: `0x${"d3".repeat(32)}` }),
      boundSenderLane({ chainID: CHAIN_ID + 1 }),
      boundSenderLane({ configurationHash: `0x${"d5".repeat(32)}` }),
    ]) {
      await beginSerializable(database.client)
      const response = await activationProvider(
        database.client,
        () => 5_000,
        MANIFEST_HASH,
        undefined,
        [drifted]
      ).attestActivationChallenge(activationRequest)
      await commit(database.client)
      // The lane ID is present and unquarantined, which is all the old
      // predicate looked at.
      assert.equal(response.payload.state.configuredSignerLaneCount, 1)
      assert.equal(response.payload.state.quarantinedSignerLaneCount, 0)
      assert.equal(response.payload.state.laneConfigurationMismatchCount, 1)
      assert.deepEqual(
        response.payload.state.senderLanes.map((lane) => lane.healthy),
        [false]
      )
      assert.equal(response.payload.state.healthy, false)
      assert.ok(
        response.payload.state.activationBlockingReasons.includes(
          "manifest-bound-signer-lane-configuration-mismatch"
        )
      )
    }
    await database.client.end()
  }
)

postgresTest(
  "refuses an extra same-ID lane configured on another chain",
  async () => {
    const database = await createTestDatabase()
    await beginSerializable(database.client)
    const signed = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    const {
      configurationHash: _configurationHash,
      configuredAtUnixMs: _configuredAtUnixMs,
      ...primary
    } = signerConfiguration()
    const additionalBinding = {
      ...primary,
      chainID: CHAIN_ID + 1,
      signerIdentity: "signer-b",
      sender: `0x${"d6".repeat(20)}`,
    }
    await begin(database.client)
    await database.store.installSignerLaneConfiguration({
      ...additionalBinding,
      configurationHash:
        computeP2TRProductionSignerLaneConfigurationHash(additionalBinding),
      configuredAtUnixMs: 1_001,
    })
    await commit(database.client)

    await beginSerializable(database.client)
    const revalidated = normalizeOutboxRevalidation(
      (
        await database.client.query<Record<string, string | number>>(
          `SELECT *
             FROM p2tr_signature_fraud_outbox_activation_revalidation($1, $2)`,
          [Buffer.from(MANIFEST_HASH.slice(2), "hex"), 5_000]
        )
      ).rows[0]
    )
    await commit(database.client)
    assert.equal(revalidated.configuredSignerLaneCount, 2)
    assert.notEqual(
      revalidated.configuredSignerLaneSetHash,
      signed.payload.state.configuredSignerLaneSetHash
    )
    assert.throws(
      () =>
        assertP2TRProductionOutboxRevalidation(
          revalidated,
          signed.payload.state,
          outboxManifest(signed.payload.state.schemaConstraintHash)
        ),
      /changed after its activation handshake was signed/
    )

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    assert.equal(response.payload.state.configuredSignerLaneCount, 2)
    assert.deepEqual(response.payload.state.senderLanes, [
      {
        laneID: LANE_ID,
        trustDomainID: "signer.trust.integration",
        operatorFingerprint: OUTBOX_LANE_OPERATOR_FINGERPRINT,
        healthy: true,
      },
    ])
    assert.equal(response.payload.state.healthy, false)
    assert.ok(
      response.payload.state.activationBlockingReasons.includes(
        "manifest-bound-signer-lane-mismatch"
      )
    )
    await database.client.end()
  }
)

postgresTest(
  "re-derives the outbox safety sample inside the readiness transaction",
  async () => {
    const database = await createTestDatabase()
    const revalidate = async (sampledAtUnixMs: number) =>
      normalizeOutboxRevalidation(
        (
          await database.client.query<Record<string, string | number>>(
            `SELECT *
               FROM p2tr_signature_fraud_outbox_activation_revalidation($1, $2)`,
            [Buffer.from(MANIFEST_HASH.slice(2), "hex"), sampledAtUnixMs]
          )
        ).rows[0]
      )

    await beginSerializable(database.client)
    const signed = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    const clean = await revalidate(5_000)
    await commit(database.client)
    assert.deepEqual(clean, {
      activationBlockingCriticalAlertCount: 0,
      ambiguousTransactionCount: 0,
      unresolvedLegacyQuarantineCount: 0,
      recoveryBacklogCount: 0,
      configuredSignerLaneCount: 1,
      configuredSignerLaneSetHash:
        signed.payload.state.configuredSignerLaneSetHash,
      quarantinedSignerLaneCount: 0,
      activeOldManifestGenerationCount: 0,
      staleManifestGenerationSuccessorCount: 0,
      activeSignerInvocationCount: 0,
      activeNonceReleaseAttemptCount: 0,
    })
    assert.doesNotThrow(() =>
      assertP2TRProductionOutboxRevalidation(
        clean,
        signed.payload.state,
        outboxManifest(signed.payload.state.schemaConstraintHash)
      )
    )

    // The outbox transitions after signing: exactly the window the readiness
    // transaction could previously mint straight through.
    await database.store.saveLegacyQuarantine({
      observationID: `0x${"c3".repeat(32)}`,
      legacyStatus: "broadcast-pending",
      submissionAttempts: 2,
      reason: "legacy submission has no authenticated outbox record",
      quarantinedAtUnixMs: 6_000,
    })
    await beginSerializable(database.client)
    const moved = await revalidate(6_000)
    await commit(database.client)
    assert.equal(moved.unresolvedLegacyQuarantineCount, 1)
    assert.throws(
      () =>
        assertP2TRProductionOutboxRevalidation(
          moved,
          signed.payload.state,
          outboxManifest(signed.payload.state.schemaConstraintHash)
        ),
      /changed after its activation handshake was signed/
    )
    await database.client.end()
  }
)

postgresTest(
  "changes the signed schema hash when a terminal view body drifts",
  async () => {
    const database = await createTestDatabase()
    await beginSerializable(database.client)
    const baseline = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    await database.client.query(
      `CREATE OR REPLACE VIEW
         p2tr_signature_fraud_challenge_nonce_release_terminal AS
       SELECT release_request_id, attempt_sequence, result_kind AS outcome
         FROM p2tr_signature_fraud_challenge_nonce_release_result
        WHERE result_kind IN ('released', 'already-released') AND false
       UNION ALL
       SELECT release_request_id, attempt_sequence, outcome
         FROM p2tr_signature_fraud_challenge_nonce_release_resolution
        WHERE outcome IN ('released', 'already-released')`
    )

    await beginSerializable(database.client)
    const drifted = await activationProvider(
      database.client,
      () => 5_001
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.notEqual(
      drifted.payload.state.schemaConstraintHash,
      baseline.payload.state.schemaConstraintHash
    )
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
        reservation_epoch, guarded_at_unix_ms
     ) VALUES (
        decode($1, 'hex'), decode($2, 'hex'), 'bound-reservation', $3,
        $4, $5, decode($6, 'hex'), 7, decode('01', 'hex'), 1, 1200
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
    const nextConfigurationHash =
      computeP2TRProductionSignerLaneConfigurationHash(nextWithoutHash)
    await begin(database.client)
    await database.store.installSignerLaneConfiguration({
      ...nextWithoutHash,
      configurationHash: nextConfigurationHash,
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
      nextManifest,
      undefined,
      // The rotation replaces the lane's policy, so the deployment binding has
      // to name the rotated configuration -- binding the retired one is now
      // exactly the mismatch the handshake refuses.
      [
        boundSenderLane({
          policyHash: nextWithoutHash.policyHash,
          configurationHash: nextConfigurationHash,
        }),
      ]
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

/**
 * The record shape a canonical rollback races: the signer RPC has been issued
 * for the reserved lane, but nothing has come back, so no signed state exists
 * and `signerInvocationStartedAtUnixMs` is still unset.
 */
function activeInitialSignerBoundary(
  reserved: P2TRSignatureFraudChallengeOutboxRecord,
  now = 1_300
): P2TRSignatureFraudChallengeOutboxRecord {
  return {
    ...reserved,
    version: reserved.version + 1,
    updatedAtUnixMs: now,
    activeSignerInvocationStartedAtUnixMs: now,
    activeSignerInvocationID: boundaryInvocationID(now),
  }
}

/**
 * The exact transition the worker performs when it observes the signer RPC
 * return after a canonical rollback preserved the active boundary.
 */
function reconciliationTransition(
  current: P2TRSignatureFraudChallengeOutboxRecord,
  now = 2_400
): P2TRSignatureFraudChallengeOutboxRecord {
  return {
    ...current,
    status: "provenance-invalidated-awaiting-reconciliation",
    version: current.version + 1,
    preparationLease: undefined,
    preparationResumeStatus: undefined,
    activeSignerInvocationStartedAtUnixMs: undefined,
    activeSignerInvocationID: undefined,
    signerInvocationStartedAtUnixMs:
      current.signerInvocationStartedAtUnixMs ??
      current.activeSignerInvocationStartedAtUnixMs,
    updatedAtUnixMs: now,
    lastError: "signer invocation failed after the canonical invalidation CAS",
  }
}

async function rotateActivationManifest(
  database: TestDatabase,
  manifestHash: string
): Promise<void> {
  await begin(database.client)
  await database.client.query(
    `UPDATE p2tr_watchtower_activation_manifest
        SET activation_sequence = 2,
            manifest_hash = decode($1, 'hex'),
            payload = '{"sequence":2,"outbox":{"maxActiveOutboxRecords":1024}}'::jsonb,
            envelope = '{"sequence":2}'::jsonb
      WHERE singleton`,
    [manifestHash.slice(2)]
  )
  await commit(database.client)
}

/**
 * The reconciliation CAS as raw SQL. Manifest rotation transitions rows inside
 * the database trigger, so the adapter record does not carry the rotation
 * evidence; this reproduces the durable transition the resolver performs.
 */
async function forceDurableReconciliation(
  database: TestDatabase,
  recordID: string
): Promise<void> {
  await database.client.query(
    `UPDATE p2tr_signature_fraud_challenge_outbox
        SET status = 'provenance-invalidated-awaiting-reconciliation',
            version = version + 1,
            preparation_lease_owner = NULL,
            preparation_lease_expires_at_unix_ms = NULL,
            preparation_resume_status = NULL,
            active_signer_invocation_started_at_unix_ms = NULL,
            active_signer_invocation_id = NULL,
            signer_invocation_started_at_unix_ms = coalesce(
                signer_invocation_started_at_unix_ms,
                active_signer_invocation_started_at_unix_ms
            ),
            signer_invocation_id = coalesce(
                signer_invocation_id,
                active_signer_invocation_id
            ),
            updated_at_unix_ms = updated_at_unix_ms + 1,
            record_state = jsonb_set(
                jsonb_set(
                    jsonb_set(
                        record_state - 'preparationLease'
                                    - 'preparationResumeStatus'
                                    - 'activeSignerInvocationStartedAtUnixMs',
                        '{status}',
                        to_jsonb(
                            'provenance-invalidated-awaiting-reconciliation'
                                ::text
                        ),
                        true
                    ),
                    '{version}',
                    to_jsonb(version + 1),
                    true
                ),
                '{updatedAtUnixMs}',
                to_jsonb(updated_at_unix_ms + 1),
                true
            )
      WHERE record_id = decode($1, 'hex')`,
    [recordID.slice(2)]
  )
}

postgresTest(
  "keeps an activation-blocking incident for an active-initial signer boundary",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(53)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    const boundary = activeInitialSignerBoundary(reserved)
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        reserved.recordID,
        reserved.version,
        boundary
      ),
      true
    )
    await commit(database.client)

    await begin(database.client)
    const [invalidated] = await database.store.invalidateCanonicalProvenance(
      invalidationEvidence(initial)
    )
    await commit(database.client)
    // The issued signer RPC keeps the preparation claim; nothing escaped yet.
    assert.equal(invalidated.status, "preparing")
    assert.equal(invalidated.signerInvocationStartedAtUnixMs, undefined)
    assert.equal(invalidated.activeSignerInvocationStartedAtUnixMs, 1_300)

    const incidents = await database.client.query<{
      kind: string
      blocking: boolean
    }>(
      `SELECT incident_kind AS kind, activation_blocking AS blocking
         FROM p2tr_signature_fraud_challenge_provenance_incident`
    )
    assert.deepEqual(incidents.rows, [
      { kind: "signer-boundary-active", blocking: true },
    ])

    // Without that incident the status trigger rejects this CAS and the
    // resolver can never retire the boundary.
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        invalidated.recordID,
        invalidated.version,
        reconciliationTransition(invalidated)
      ),
      true
    )
    await commit(database.client)
    const durable = await database.store.get(initial.recordID)
    assert.equal(
      durable?.status,
      "provenance-invalidated-awaiting-reconciliation"
    )
    await database.client.end()
  }
)

postgresTest(
  "retires the incident when the boundary is proven never to have reached the signer",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(63)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    const boundary = activeInitialSignerBoundary(reserved)
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        reserved.recordID,
        reserved.version,
        boundary
      ),
      true
    )
    await commit(database.client)

    await begin(database.client)
    const [invalidated] = await database.store.invalidateCanonicalProvenance(
      invalidationEvidence(initial)
    )
    await commit(database.client)
    assert.equal(invalidated.activeSignerInvocationStartedAtUnixMs, 1_300)

    // This is the exact predicate the activation handshake gates on.
    const blockingIncidents = async (): Promise<number> => {
      const result = await database.client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM p2tr_signature_fraud_challenge_provenance_incident incident
          WHERE incident.activation_blocking
            AND NOT EXISTS (
                  SELECT 1
                    FROM p2tr_signature_fraud_challenge_provenance_incident_resolution ir
                   WHERE ir.incident_id = incident.incident_id
                )`
      )
      return Number(result.rows[0].count)
    }
    assert.equal(await blockingIncidents(), 1)

    assert.ok(invalidated.reservedNonce)
    const retiredBoundary = {
      signerInvocationID: boundaryInvocationID(1_300),
      startedAtUnixMs: 1_300,
      preparationAttempts: invalidated.preparationAttempts,
      nonceReservationID: invalidated.reservedNonce.reservationID.toString(),
    }
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwapRetiringUninvokedSignerBoundary(
        invalidated.recordID,
        invalidated.version,
        {
          ...invalidated,
          version: invalidated.version + 1,
          activeSignerInvocationStartedAtUnixMs: undefined,
          activeSignerInvocationID: undefined,
          updatedAtUnixMs: 2_400,
        },
        retiredBoundary,
        2_400
      ),
      true
    )
    await commit(database.client)

    // The barrier-clearing swap and the retirement land together.
    const durable = await database.store.get(initial.recordID)
    assert.equal(durable?.activeSignerInvocationStartedAtUnixMs, undefined)
    assert.equal(await blockingIncidents(), 0)

    const resolution = await database.client.query<{
      started: string
      attempts: number
    }>(
      `SELECT boundary_started_at_unix_ms::text AS started,
              preparation_attempts AS attempts
         FROM p2tr_signature_fraud_challenge_provenance_incident_resolution`
    )
    assert.equal(resolution.rows.length, 1)
    assert.equal(resolution.rows[0].started, "1300")
    assert.equal(
      resolution.rows[0].attempts,
      retiredBoundary.preparationAttempts
    )

    // Retirement evidence is append-only, exactly like the incident it clears.
    await assert.rejects(
      database.client.query(
        `DELETE FROM p2tr_signature_fraud_challenge_provenance_incident_resolution`
      )
    )
    await database.client.end()
  }
)

postgresTest(
  "refuses to retire an incident for a boundary that may have escaped",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(64)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    const boundary = activeInitialSignerBoundary(reserved)
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        reserved.recordID,
        reserved.version,
        boundary
      ),
      true
    )
    await commit(database.client)
    await begin(database.client)
    const [invalidated] = await database.store.invalidateCanonicalProvenance(
      invalidationEvidence(initial)
    )
    await commit(database.client)

    assert.ok(invalidated.reservedNonce)
    // Historical proof that a signer invocation began. Written directly so the
    // guard is exercised even if a future caller bypasses the TypeScript path;
    // the version/timestamp bump keeps the monotonic-CAS trigger satisfied.
    await database.client.query(
      `UPDATE p2tr_signature_fraud_challenge_outbox
          SET signer_invocation_started_at_unix_ms = 1300,
              version = version + 1,
              updated_at_unix_ms = updated_at_unix_ms + 1,
              record_state = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    record_state,
                    '{signerInvocationStartedAtUnixMs}',
                    to_jsonb(1300)
                  ),
                  '{version}',
                  to_jsonb((record_state ->> 'version')::bigint + 1)
                ),
                '{updatedAtUnixMs}',
                to_jsonb((record_state ->> 'updatedAtUnixMs')::bigint + 1)
              )
        WHERE record_id = decode($1, 'hex')`,
      [initial.recordID.replace(/^0x/i, "")]
    )

    // Defence in depth: the database itself must refuse, independently of any
    // predicate the caller claims to have checked.
    await assert.rejects(
      database.client.query(
        `INSERT INTO p2tr_signature_fraud_challenge_provenance_incident_resolution (
            incident_id, record_id, provenance_invalidation_id,
            boundary_started_at_unix_ms, preparation_attempts,
            nonce_reservation_id, resolution_digest, resolved_at_unix_ms
         )
         SELECT incident_id, record_id, provenance_invalidation_id,
                1300, 0,
                decode(repeat('11', 32), 'hex'),
                decode(repeat('22', 32), 'hex'),
                2400
           FROM p2tr_signature_fraud_challenge_provenance_incident`
      ),
      /no signer escape evidence/
    )

    // The incident therefore stays activation-blocking.
    const blocking = await database.client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM p2tr_signature_fraud_challenge_provenance_incident incident
        WHERE incident.activation_blocking
          AND NOT EXISTS (
                SELECT 1
                  FROM p2tr_signature_fraud_challenge_provenance_incident_resolution ir
                 WHERE ir.incident_id = incident.incident_id
              )`
    )
    assert.equal(blocking.rows[0].count, "1")
    await database.client.end()
  }
)

postgresTest(
  "excludes a genuinely inactive unsigned preparation from provenance incidents",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(54)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    assert.equal(reserved.activeSignerInvocationStartedAtUnixMs, undefined)

    await begin(database.client)
    const [invalidated] = await database.store.invalidateCanonicalProvenance(
      invalidationEvidence(initial)
    )
    await commit(database.client)
    assert.equal(invalidated.status, "preparing")
    const incidents = await database.client.query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM p2tr_signature_fraud_challenge_provenance_incident`
    )
    assert.equal(incidents.rows[0].total, "0")

    // The same CAS the previous test admits is exactly what the status trigger
    // must reject while no activation-blocking incident exists.
    await begin(database.client)
    await assert.rejects(
      database.store.compareAndSwap(
        invalidated.recordID,
        invalidated.version,
        reconciliationTransition(invalidated)
      ),
      /escaped provenance invalidation lacks an activation-blocking incident/
    )
    await database.client.query("ROLLBACK")
    await database.client.end()
  }
)

postgresTest(
  "records a rotation incident for an active-initial signer boundary",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(55)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        reserved.recordID,
        reserved.version,
        activeInitialSignerBoundary(reserved)
      ),
      true
    )
    await commit(database.client)

    await rotateActivationManifest(database, `0x${"f8".repeat(32)}`)

    const rotated = await database.client.query<{
      status: string
      kind: string | null
      blocking: boolean | null
    }>(
      `SELECT o.status,
              pii.incident_kind AS kind,
              pii.activation_blocking AS blocking
         FROM p2tr_signature_fraud_challenge_outbox o
         LEFT JOIN p2tr_signature_fraud_challenge_provenance_incident pii
           ON pii.record_id = o.record_id
          AND pii.provenance_invalidation_id = o.provenance_invalidation_id`
    )
    assert.deepEqual(rotated.rows, [
      {
        status: "preparing",
        kind: "signer-boundary-active",
        blocking: true,
      },
    ])

    await begin(database.client)
    await forceDurableReconciliation(database, initial.recordID)
    await commit(database.client)
    const durable = await database.store.get(initial.recordID)
    assert.equal(
      durable?.status,
      "provenance-invalidated-awaiting-reconciliation"
    )
    await database.client.end()
  }
)

postgresTest(
  "rotation excludes a genuinely inactive unsigned preparation",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(56)
    await insertRecord(database, initial)
    await advanceToReservation(database, initial)

    await rotateActivationManifest(database, `0x${"f9".repeat(32)}`)

    const rotated = await database.client.query<{
      status: string
      incidents: string
    }>(
      `SELECT o.status,
              (SELECT count(*)::text
                 FROM p2tr_signature_fraud_challenge_provenance_incident)
                AS incidents
         FROM p2tr_signature_fraud_challenge_outbox o`
    )
    assert.deepEqual(rotated.rows, [{ status: "preparing", incidents: "0" }])

    await begin(database.client)
    await assert.rejects(
      forceDurableReconciliation(database, initial.recordID),
      /escaped provenance invalidation lacks an activation-blocking incident/
    )
    await database.client.query("ROLLBACK")
    await database.client.end()
  }
)

type EscapedCaptureRequest = {
  provenanceFingerprint?: string
  expectedReservationID?: string
  sender?: string
  nonce?: number
  reason?: string
  capturedAtUnixMs: number
  quarantine?: P2TRSignatureFraudSignerQuarantine
}

type EscapedCaptureOutcome = {
  results: string[]
  alertCodes: string[]
}

type EscapedCaptureParityScenario = {
  name: string
  seed: number
  boundary: (
    reserved: P2TRSignatureFraudChallengeOutboxRecord
  ) =>
    | readonly P2TRSignatureFraudChallengeOutboxRecord[]
    | Promise<readonly P2TRSignatureFraudChallengeOutboxRecord[]>
  captures: EscapedCaptureRequest[]
}

async function escapedCaptureArtifact(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  request: EscapedCaptureRequest
) {
  const nonce = request.nonce ?? 7
  const rawTransaction = await WALLET.signTransaction({
    type: 2,
    chainId: CHAIN_ID,
    to: record.intent.routerAddress,
    data: record.intent.calldata,
    value: record.intent.value,
    nonce,
    gasLimit: 100_000,
    maxFeePerGas: 100,
    maxPriorityFeePerGas: 10,
  })
  return {
    expectedReservationID:
      request.expectedReservationID ??
      record.reservedNonce!.reservationID.toPrefixedString(),
    capturedAtUnixMs: request.capturedAtUnixMs,
    reason: request.reason ?? "signer returned after the durable boundary",
    preparedTransaction: {
      intentID: record.intent.intentID,
      rawTransaction,
      transactionHash: Hex.from(utils.keccak256(rawTransaction)),
      sender: request.sender ?? WALLET.address,
      nonce,
    },
  }
}

function escapedCaptureResult(
  outcome: P2TRSignatureFraudChallengeOutboxRecord | Error
): string {
  return outcome instanceof Error
    ? `error:${outcome.message}`
    : [
        outcome.status,
        `artifacts=${outcome.unexpectedSignedArtifacts?.length ?? 0}`,
        `quarantines=${outcome.signerQuarantines?.length ?? 0}`,
        `active=${outcome.activeSignerInvocationStartedAtUnixMs ?? "none"}`,
        `signer=${outcome.signerInvocationStartedAtUnixMs ?? "none"}`,
        `updated=${outcome.updatedAtUnixMs}`,
      ].join(" ")
}

async function postgresEscapedCaptureOutcome(
  scenario: EscapedCaptureParityScenario
): Promise<EscapedCaptureOutcome> {
  const database = await createTestDatabase()
  try {
    const initial = outboxRecord(scenario.seed)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    const transitions = await scenario.boundary(reserved)
    let current = reserved
    for (const transition of transitions) {
      await begin(database.client)
      assert.equal(
        await database.store.compareAndSwap(
          current.recordID,
          current.version,
          transition
        ),
        true
      )
      await commit(database.client)
      current = transition
    }
    const boundary = current
    const managed = createManagedStore(
      database.client,
      eligibilitySnapshotFor(initial)
    )
    const results: string[] = []
    for (const request of scenario.captures) {
      const artifact = await escapedCaptureArtifact(boundary, request)
      try {
        results.push(
          escapedCaptureResult(
            await managed.captureEscapedSignedArtifact(
              initial.recordID,
              request.provenanceFingerprint ??
                initial.canonicalProvenance.provenanceFingerprint,
              artifact,
              request.quarantine
            )
          )
        )
      } catch (error) {
        results.push(escapedCaptureResult(error as Error))
      }
    }
    const alerts = await database.client.query<{ code: string }>(
      `SELECT DISTINCT code
         FROM p2tr_signature_fraud_challenge_critical_alert
        ORDER BY code`
    )
    return { results, alertCodes: alerts.rows.map((row) => row.code) }
  } finally {
    await database.client.end()
  }
}

async function inMemoryEscapedCaptureOutcome(
  scenario: EscapedCaptureParityScenario
): Promise<EscapedCaptureOutcome> {
  const store = new InMemoryOutboxStore()
  const initial = outboxRecord(scenario.seed)
  await store.insertGenerationIfAbsent(initial)
  const selected = selectedRecord(initial)
  assert.equal(
    await store.compareAndSwap(initial.recordID, initial.version, selected),
    true
  )
  const reserved = reservedRecord(selected)
  assert.equal(
    await store.compareAndSwap(selected.recordID, selected.version, reserved),
    true
  )
  let current = reserved
  for (const transition of await scenario.boundary(reserved)) {
    assert.equal(
      await store.compareAndSwap(current.recordID, current.version, transition),
      true
    )
    current = transition
  }
  const boundary = current
  const results: string[] = []
  for (const request of scenario.captures) {
    const artifact = await escapedCaptureArtifact(boundary, request)
    try {
      results.push(
        escapedCaptureResult(
          await store.captureEscapedSignedArtifact(
            initial.recordID,
            request.provenanceFingerprint ??
              initial.canonicalProvenance.provenanceFingerprint,
            artifact,
            request.quarantine
          )
        )
      )
    } catch (error) {
      results.push(escapedCaptureResult(error as Error))
    }
  }
  return {
    results,
    alertCodes: [
      ...new Set(store.criticalAlerts.map((alert) => alert.code)),
    ].sort(),
  }
}

function signerBoundaryRecord(
  reserved: P2TRSignatureFraudChallengeOutboxRecord
): P2TRSignatureFraudChallengeOutboxRecord {
  return {
    ...reserved,
    version: reserved.version + 1,
    updatedAtUnixMs: 1_300,
    signerInvocationStartedAtUnixMs: 1_300,
    activeSignerInvocationStartedAtUnixMs: 1_300,
    activeSignerInvocationID: boundaryInvocationID(1_300),
  }
}

function signerBoundaryOnly(
  reserved: P2TRSignatureFraudChallengeOutboxRecord
): readonly P2TRSignatureFraudChallengeOutboxRecord[] {
  return [signerBoundaryRecord(reserved)]
}

/**
 * A wrong-lane envelope is reachable when a replacement signer call is in
 * flight over an already-persisted variant. The durable signed-state alert
 * requires exactly that state, and the lane may hold only one quarantine, so
 * the boundary itself carries none.
 */
async function replacementSignerBoundary(
  reserved: P2TRSignatureFraudChallengeOutboxRecord
): Promise<readonly P2TRSignatureFraudChallengeOutboxRecord[]> {
  const boundary = signerBoundaryRecord(reserved)
  const rawTransaction = await WALLET.signTransaction({
    type: 2,
    chainId: CHAIN_ID,
    to: reserved.intent.routerAddress,
    data: reserved.intent.calldata,
    value: reserved.intent.value,
    nonce: 7,
    gasLimit: 100_000,
    maxFeePerGas: 100,
    maxPriorityFeePerGas: 10,
  })
  const preparedTransaction = {
    intentID: reserved.intent.intentID,
    rawTransaction,
    transactionHash: Hex.from(utils.keccak256(rawTransaction)),
    sender: WALLET.address,
    nonce: 7,
  }
  const prepared: P2TRSignatureFraudChallengeOutboxRecord = {
    ...boundary,
    status: "prepared",
    version: boundary.version + 1,
    updatedAtUnixMs: 1_400,
    preparationLease: undefined,
    activeSignerInvocationStartedAtUnixMs: undefined,
    activeSignerInvocationID: undefined,
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
  return [
    boundary,
    prepared,
    {
      ...prepared,
      version: prepared.version + 1,
      updatedAtUnixMs: 1_500,
      activeSignerInvocationStartedAtUnixMs: 1_500,
      activeSignerInvocationID: boundaryInvocationID(1_500),
    },
  ]
}

/**
 * Wrong-lane quarantine evidence bound to the durable nonce guard the signer
 * was supposed to use.
 */
function wrongLaneQuarantine(): P2TRSignatureFraudSignerQuarantine {
  return {
    laneID: LANE_ID,
    signerIdentity: SIGNER_IDENTITY,
    expectedSender: WALLET.address,
    expectedNonce: 7,
    reservationID: `0x${"d1".repeat(32)}`,
    reasonCode: "wrong-nonce",
    quarantinedAtUnixMs: 2_050,
    reason: "Signer returned an envelope outside its reserved nonce lane",
    detailsDigest: `0x${"f7".repeat(32)}`,
  }
}

const escapedCaptureParityScenarios: EscapedCaptureParityScenario[] = [
  {
    name: "captures an expected-lane late artifact",
    seed: 61,
    boundary: signerBoundaryOnly,
    captures: [{ capturedAtUnixMs: 2_100 }],
  },
  {
    name: "is idempotent once the durable boundary is resolved",
    seed: 62,
    boundary: signerBoundaryOnly,
    captures: [{ capturedAtUnixMs: 2_100 }, { capturedAtUnixMs: 2_200 }],
  },
  {
    name: "rejects a wrong-lane envelope without quarantine evidence",
    seed: 63,
    boundary: signerBoundaryOnly,
    captures: [{ capturedAtUnixMs: 2_100, nonce: 8 }],
  },
  {
    name: "captures a wrong-lane envelope with quarantine evidence",
    seed: 64,
    boundary: replacementSignerBoundary,
    captures: [
      {
        capturedAtUnixMs: 2_100,
        nonce: 8,
        quarantine: wrongLaneQuarantine(),
      },
    ],
  },
  {
    name: "rejects a capture whose provenance fingerprint does not match",
    seed: 65,
    boundary: signerBoundaryOnly,
    captures: [
      {
        capturedAtUnixMs: 2_100,
        provenanceFingerprint: `0x${"ee".repeat(32)}`,
      },
    ],
  },
  {
    name: "rejects a capture without a retained durable signer boundary",
    seed: 66,
    boundary: (reserved) => [
      {
        ...signerBoundaryRecord(reserved),
        activeSignerInvocationStartedAtUnixMs: undefined,
        activeSignerInvocationID: undefined,
      },
    ],
    captures: [{ capturedAtUnixMs: 2_100 }],
  },
  {
    name: "rejects a capture that names a different reservation",
    seed: 67,
    boundary: signerBoundaryOnly,
    captures: [
      {
        capturedAtUnixMs: 2_100,
        expectedReservationID: `0x${"d2".repeat(32)}`,
      },
    ],
  },
  {
    name: "rejects a capture without a bounded reason",
    seed: 68,
    boundary: signerBoundaryOnly,
    captures: [{ capturedAtUnixMs: 2_100, reason: "" }],
  },
]

for (const scenario of escapedCaptureParityScenarios) {
  postgresTest(
    `in-memory and PostgreSQL escaped-artifact capture agree: ${scenario.name}`,
    async () => {
      const durable = await postgresEscapedCaptureOutcome(scenario)
      const memory = await inMemoryEscapedCaptureOutcome(scenario)
      assert.deepEqual(memory.results, durable.results)
      assert.deepEqual(memory.alertCodes, durable.alertCodes)
    }
  )
}

// ---------------------------------------------------------------------------
// Orphaned signer boundary resolution.
//
// `activeSignerInvocationStartedAtUnixMs` is committed BEFORE boundary
// authorization and therefore before the signer RPC. When the owning process
// dies mid-call nothing in the normal recovery path may clear that marker —
// lease expiry is not proof a remote call stopped — so the singleton
// `active_signer_invocation_count` stays at one, every nonce release is blocked
// store-wide, and challenge signing freezes on every lane. These tests drive
// the out-of-band resolver that is the only way out.
// ---------------------------------------------------------------------------

const BOUNDARY_PROVIDER_DIGEST = `0x${"c7".repeat(32)}`
/**
 * A deterministic stand-in for computeP2TRSignatureFraudSignerInvocationID.
 * The production value is a digest over the whole boundary binding; these
 * suites only need distinct markers to yield distinct identities.
 */
const boundaryInvocationID = (marker: number): string =>
  `0x${marker.toString(16).padStart(64, "0")}`

const BOUNDARY_SIGNED_HASH = `0x${"5a".repeat(32)}`

type BoundaryAttestationMode =
  | "independent"
  | "single"
  | "same-trust-domain"
  | "same-independence-domain"
  | "identical-attestation"

type BoundaryResolutionOverrides = {
  recordID?: string
  signerInvocationID?: string
  nonceConsumption?: {
    chainID: number
    sender: string
    transactionNonce: number
    finalizedAccountNonce: number
    accountNonceReadAtBlock: number
    consumingTransaction: {
      transactionHash: string
      sender: string
      nonce: number
      blockNumber: number
      blockHash: string
    }
    finalizedThrough: { blockNumber: number; blockHash: string }
    observedHead: { blockNumber: number; blockHash: string }
  }
  providerTombstone?: {
    signerInvocationID: string
    receipt: string
    tombstonedAtUnixMs: number
  }
  /** Drops the tombstone an honest never-invoked resolution must carry. */
  omitProviderTombstone?: boolean
  boundaryStartedAtUnixMs?: number
  preparationAttempts?: number
  nonceReservationID?: string
  stage?: "prepare" | "replacement"
  invokedAtUnixMs?: number
  outcome?: "never-invoked" | "signed" | "terminal-unsafe" | "nonce-consumed"
  signedTransactionHash?: string
  providerEvidenceDigest?: string
  resolvedAtUnixMs?: number
  attestedAtUnixMs?: number
  attestationMode?: BoundaryAttestationMode
  /** Forces a digest that does not commit to the binding below. */
  evidenceDigest?: string
}

function boundaryAttestations(
  evidenceDigest: string,
  attestedAtUnixMs: number,
  mode: BoundaryAttestationMode
) {
  const primary = {
    trustDomainID: "signer-primary",
    independenceDomainID: "signer-primary-infra",
    evidenceDigest,
    attestation: "0x01",
    attestedAtUnixMs,
  }
  const corroborating = {
    trustDomainID:
      mode === "same-trust-domain" ? "signer-primary" : "signer-corroborating",
    independenceDomainID:
      mode === "same-independence-domain"
        ? "signer-primary-infra"
        : "signer-corroborating-infra",
    evidenceDigest,
    attestation: mode === "identical-attestation" ? "0x01" : "0x02",
    attestedAtUnixMs,
  }
  return (mode === "single"
    ? [primary]
    : [
        primary,
        corroborating,
      ]) as unknown as P2TRSignatureFraudIndependentSignerBoundaryResolution["canonicalAttestations"]
}

/**
 * Builds a resolution that is internally consistent — including its digest —
 * for whatever binding the overrides ask for. A "wrong boundary" case must be
 * refused because it names a boundary the record does not own, not because its
 * digest happens not to verify.
 */
function boundaryResolution(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  overrides: BoundaryResolutionOverrides = {},
  computeEvidenceDigest = computeP2TRSignatureFraudSignerBoundaryResolutionEvidenceDigest
): P2TRSignatureFraudIndependentSignerBoundaryResolution {
  const outcome = overrides.outcome ?? "never-invoked"
  const invocationID =
    overrides.signerInvocationID ??
    record.activeSignerInvocationID ??
    boundaryInvocationID(1_300)
  const binding = {
    recordID: overrides.recordID ?? record.recordID,
    signerInvocationID: invocationID,
    // Only a nonce-consumed outcome may carry consumption evidence, and it
    // must carry it. Defaults name this record's own lane and chain.
    ...(outcome === "nonce-consumed"
      ? {
          nonceConsumption: overrides.nonceConsumption ?? {
            chainID: record.intent.chainID,
            sender: record.reservedNonce!.sender,
            transactionNonce: record.reservedNonce!.nonce,
            finalizedAccountNonce: record.reservedNonce!.nonce + 1,
            accountNonceReadAtBlock: 500,
            consumingTransaction: {
              transactionHash: `0x${"c1".repeat(32)}`,
              sender: record.reservedNonce!.sender,
              nonce: record.reservedNonce!.nonce,
              blockNumber: 480,
              blockHash: `0x${"c2".repeat(32)}`,
            },
            finalizedThrough: {
              blockNumber: 500,
              blockHash: `0x${"c3".repeat(32)}`,
            },
            observedHead: {
              blockNumber: 564,
              blockHash: `0x${"c4".repeat(32)}`,
            },
          },
        }
      : {}),
    // Only a never-invoked outcome may carry one, and it must carry one.
    ...(outcome === "never-invoked" && overrides.omitProviderTombstone !== true
      ? {
          providerTombstone: overrides.providerTombstone ?? {
            signerInvocationID: invocationID,
            receipt: "0xfeed",
            tombstonedAtUnixMs: 1_305,
          },
        }
      : {}),
    boundaryStartedAtUnixMs:
      overrides.boundaryStartedAtUnixMs ??
      record.activeSignerInvocationStartedAtUnixMs ??
      1_300,
    preparationAttempts:
      overrides.preparationAttempts ?? record.preparationAttempts,
    nonceReservationID:
      overrides.nonceReservationID ??
      record.reservedNonce!.reservationID.toPrefixedString(),
    stage: overrides.stage ?? ("prepare" as const),
    invokedAtUnixMs: overrides.invokedAtUnixMs ?? 1_310,
    outcome,
    signedTransactionHash:
      "signedTransactionHash" in overrides
        ? overrides.signedTransactionHash
        : outcome === "signed"
        ? BOUNDARY_SIGNED_HASH
        : undefined,
    providerEvidenceDigest:
      overrides.providerEvidenceDigest ?? BOUNDARY_PROVIDER_DIGEST,
  }
  const evidenceDigest =
    overrides.evidenceDigest ?? computeEvidenceDigest(binding)
  const resolvedAtUnixMs = overrides.resolvedAtUnixMs ?? 2_400
  return {
    ...binding,
    evidenceDigest,
    canonicalAttestations: boundaryAttestations(
      evidenceDigest,
      overrides.attestedAtUnixMs ?? 2_000,
      overrides.attestationMode ?? "independent"
    ),
    resolvedAtUnixMs,
  }
}

function legacyV4BoundaryResolution(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  overrides: BoundaryResolutionOverrides = {}
): P2TRSignatureFraudIndependentSignerBoundaryResolution {
  return boundaryResolution(
    record,
    overrides,
    computeP2TRSignatureFraudLegacyV4SignerBoundaryResolutionEvidenceDigest
  )
}

async function insertLegacyV4BoundaryResolution(
  database: TestDatabase,
  resolution: P2TRSignatureFraudIndependentSignerBoundaryResolution
): Promise<void> {
  const [primary, corroborating] = resolution.canonicalAttestations
  await database.client.query(
    `INSERT INTO p2tr_signature_fraud_challenge_signer_boundary_resolution (
        record_id, signer_invocation_id, boundary_started_at_unix_ms,
        preparation_attempts, nonce_reservation_id, stage,
        invoked_at_unix_ms, outcome, signed_transaction_hash,
        provider_evidence_digest, resolution_evidence_digest,
        primary_trust_domain_id, primary_independence_domain_id,
        primary_evidence_digest, primary_attestation,
        primary_attested_at_unix_ms, corroborating_trust_domain_id,
        corroborating_independence_domain_id,
        corroborating_evidence_digest, corroborating_attestation,
        corroborating_attested_at_unix_ms, resolved_at_unix_ms,
        provider_tombstone_receipt, provider_tombstone_at_unix_ms,
        nonce_consumption_chain_id, nonce_consumption_nonce,
        nonce_consumption_account_nonce, nonce_consumption_read_at_block,
        nonce_consumption_transaction_hash,
        nonce_consumption_finalized_block_number,
        nonce_consumption_finalized_block_hash
     ) VALUES (
        decode($1, 'hex'), decode($2, 'hex'), $3, $4,
        decode($5, 'hex'), $6, $7, $8,
        CASE WHEN $9::text IS NULL THEN NULL ELSE decode($9, 'hex') END,
        decode($10, 'hex'), decode($11, 'hex'), $12, $13,
        decode($11, 'hex'), decode($14, 'hex'), $15, $16, $17,
        decode($11, 'hex'), decode($18, 'hex'), $19, $20,
        CASE WHEN $21::text IS NULL THEN NULL ELSE decode($21, 'hex') END,
        $22, $23, $24, $25, $26,
        CASE WHEN $27::text IS NULL THEN NULL ELSE decode($27, 'hex') END,
        $28,
        CASE WHEN $29::text IS NULL THEN NULL ELSE decode($29, 'hex') END
     )`,
    [
      resolution.recordID.slice(2),
      resolution.signerInvocationID.slice(2),
      resolution.boundaryStartedAtUnixMs,
      resolution.preparationAttempts,
      resolution.nonceReservationID.slice(2),
      resolution.stage,
      resolution.invokedAtUnixMs,
      resolution.outcome,
      resolution.signedTransactionHash?.slice(2) ?? null,
      resolution.providerEvidenceDigest.slice(2),
      resolution.evidenceDigest.slice(2),
      primary.trustDomainID,
      primary.independenceDomainID,
      primary.attestation.slice(2),
      primary.attestedAtUnixMs,
      corroborating.trustDomainID,
      corroborating.independenceDomainID,
      corroborating.attestation.slice(2),
      corroborating.attestedAtUnixMs,
      resolution.resolvedAtUnixMs,
      resolution.providerTombstone?.receipt.slice(2) ?? null,
      resolution.providerTombstone?.tombstonedAtUnixMs ?? null,
      resolution.nonceConsumption?.chainID ?? null,
      resolution.nonceConsumption?.transactionNonce ?? null,
      resolution.nonceConsumption?.finalizedAccountNonce ?? null,
      resolution.nonceConsumption?.accountNonceReadAtBlock ?? null,
      resolution.nonceConsumption?.consumingTransaction.transactionHash.slice(
        2
      ) ?? null,
      resolution.nonceConsumption?.finalizedThrough.blockNumber ?? null,
      resolution.nonceConsumption?.finalizedThrough.blockHash.slice(2) ?? null,
    ]
  )
}

// The barrier is keyed per nonce lane, so the store-wide quantity these tests
// reason about -- "is any lane holding an irreversible signer boundary" -- is
// the sum across lanes. That is the same rollup the activation handshake reads.
async function barrierSignerInvocationCount(
  database: TestDatabase
): Promise<number> {
  const result = await database.client.query<{ count: string }>(
    `SELECT COALESCE(sum(active_signer_invocation_count), 0)::text AS count
       FROM p2tr_signature_fraud_nonce_allocator_safety_barrier`
  )
  return Number(result.rows[0].count)
}

async function laneBarrierSignerInvocationCount(
  database: TestDatabase,
  chainID: number,
  sender: string
): Promise<number | undefined> {
  const result = await database.client.query<{ count: string }>(
    `SELECT active_signer_invocation_count::text AS count
       FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
      WHERE chain_id = $1::numeric
        AND sender = $2::bytea`,
    [String(chainID), Buffer.from(sender.replace(/^0x/, ""), "hex")]
  )
  return result.rows.length === 0 ? undefined : Number(result.rows[0].count)
}

async function blockingProvenanceIncidents(
  database: TestDatabase
): Promise<number> {
  const result = await database.client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM p2tr_signature_fraud_challenge_provenance_incident incident
      WHERE incident.activation_blocking
        AND NOT EXISTS (
              SELECT 1
                FROM p2tr_signature_fraud_challenge_provenance_incident_resolution ir
               WHERE ir.incident_id = incident.incident_id
            )`
  )
  return Number(result.rows[0].count)
}

/** The exact orphan: a durable pre-I/O marker with no signer result at all. */
async function orphanedSignerBoundary(
  database: TestDatabase,
  seed: number
): Promise<{
  initial: P2TRSignatureFraudChallengeOutboxRecord
  boundary: P2TRSignatureFraudChallengeOutboxRecord
}> {
  const initial = outboxRecord(seed)
  await insertRecord(database, initial)
  const reserved = await advanceToReservation(database, initial)
  const boundary = activeInitialSignerBoundary(reserved)
  await begin(database.client)
  assert.equal(
    await database.store.compareAndSwap(
      reserved.recordID,
      reserved.version,
      boundary
    ),
    true
  )
  await commit(database.client)
  return { initial, boundary }
}

postgresTest(
  "keeps a burn claim in the signer-I/O barrier after the original marker resolves",
  async () => {
    const database = await createTestDatabase()
    const { boundary } = await orphanedSignerBoundary(database, 208)
    assert.equal(await barrierSignerInvocationCount(database), 1)

    const claim: P2TRSignatureFraudChallengeOutboxRecord = {
      ...boundary,
      version: boundary.version + 1,
      updatedAtUnixMs: 1_400,
      contestedNonceBurnClaim: {
        signerInvocationID: `0x${"e1".repeat(32)}`,
        signerRequestDigest: `0x${"e2".repeat(32)}`,
        reservationID: boundary.reservedNonce!.reservationID.toPrefixedString(),
        recordVersion: boundary.version,
        preparationAttempts: boundary.preparationAttempts,
        claimedAtUnixMs: 1_400,
      },
    }
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        boundary.recordID,
        boundary.version,
        claim
      ),
      true
    )
    await commit(database.client)
    assert.equal(await barrierSignerInvocationCount(database), 2)

    await begin(database.client)
    assert.equal(
      await database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary)
      ),
      "acknowledged"
    )
    await commit(database.client)
    const resolved = (await database.store.get(boundary.recordID))!
    assert.equal(resolved.activeSignerInvocationStartedAtUnixMs, undefined)
    assert.ok(resolved.contestedNonceBurnClaim)
    assert.equal(await barrierSignerInvocationCount(database), 1)

    const rawTransaction = await WALLET.signTransaction({
      type: 2,
      chainId: CHAIN_ID,
      to: WALLET.address,
      data: "0x",
      value: 0,
      nonce: boundary.reservedNonce!.nonce,
      gasLimit: 21_000,
      maxFeePerGas: 100,
      maxPriorityFeePerGas: 10,
    })
    const parsed = utils.parseTransaction(rawTransaction)
    const burned: P2TRSignatureFraudChallengeOutboxRecord = {
      ...resolved,
      version: resolved.version + 1,
      updatedAtUnixMs: 2_500,
      contestedNonceBurnClaim: undefined,
      contestedNonceBurn: {
        transactionHash: parsed.hash!,
        rawTransaction,
        nonce: parsed.nonce,
        sender: WALLET.address,
        maxFeePerGas: parsed.maxFeePerGas!.toString(),
        maxPriorityFeePerGas: parsed.maxPriorityFeePerGas!.toString(),
        signerInvocationID: claim.contestedNonceBurnClaim!.signerInvocationID,
        signedAtUnixMs: 2_500,
      },
    }
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        resolved.recordID,
        resolved.version,
        burned
      ),
      true
    )
    await commit(database.client)
    assert.equal(await barrierSignerInvocationCount(database), 0)
    await database.client.end()
  }
)

postgresTest(
  "replays grandfathered v4 signer-boundary evidence after migration 007",
  async () => {
    const database = await createTestDatabase(1_024, 4)
    const { boundary } = await orphanedSignerBoundary(database, 209)
    const currentConsumption = boundaryResolution(boundary, {
      outcome: "nonce-consumed",
    }).nonceConsumption!
    const legacyResolution = legacyV4BoundaryResolution(boundary, {
      outcome: "nonce-consumed",
      nonceConsumption: {
        ...currentConsumption,
        observedHead: {
          blockNumber: 512,
          blockHash: currentConsumption.observedHead.blockHash,
        },
      },
    })

    await begin(database.client)
    await insertLegacyV4BoundaryResolution(database, legacyResolution)
    await commit(database.client)

    await database.client.query(
      await readFile(
        new URL(
          "../migrations/007_p2tr_signer_boundary_nonce_finality.sql",
          import.meta.url
        ),
        "utf8"
      )
    )
    const grandfathered = await database.client.query<{
      resolution_evidence_version: number
    }>(
      `SELECT resolution_evidence_version
         FROM p2tr_signature_fraud_challenge_signer_boundary_resolution
        WHERE record_id = decode($1, 'hex')`,
      [legacyResolution.recordID.slice(2)]
    )
    assert.deepEqual(grandfathered.rows, [{ resolution_evidence_version: 4 }])

    // This exact pre-upgrade payload has only twelve observed-head blocks. The
    // current v5 validator rejects it, but the immutable v4 row must still make
    // a lost-response retry idempotent rather than a permanent false conflict.
    await begin(database.client)
    assert.equal(
      await database.store.resolveOrphanedSignerBoundary(legacyResolution),
      "acknowledged"
    )
    await commit(database.client)

    await begin(database.client)
    await assert.rejects(
      database.store.resolveOrphanedSignerBoundary({
        ...legacyResolution,
        providerEvidenceDigest: `0x${"ab".repeat(32)}`,
      }),
      /Independent signer-boundary resolution conflicts/
    )
    await database.client.query("ROLLBACK")
    await database.client.end()

    // The compatibility branch is not an insertion escape hatch: ordinary
    // post-upgrade resolutions continue to use and persist evidence version 5.
    const currentDatabase = await createTestDatabase()
    const { boundary: currentBoundary } = await orphanedSignerBoundary(
      currentDatabase,
      210
    )
    await begin(currentDatabase.client)
    assert.equal(
      await currentDatabase.store.resolveOrphanedSignerBoundary(
        boundaryResolution(currentBoundary, { outcome: "nonce-consumed" })
      ),
      "acknowledged"
    )
    await commit(currentDatabase.client)
    const versions = await currentDatabase.client.query<{
      resolution_evidence_version: number
    }>(
      `SELECT resolution_evidence_version
         FROM p2tr_signature_fraud_challenge_signer_boundary_resolution`
    )
    assert.deepEqual(versions.rows, [{ resolution_evidence_version: 5 }])
    await currentDatabase.client.end()
  }
)

postgresTest(
  "clears an orphaned signer boundary and reopens store-wide nonce-release I/O",
  async () => {
    const database = await createTestDatabase()
    const { initial, boundary } = await orphanedSignerBoundary(database, 210)
    assert.equal(await barrierSignerInvocationCount(database), 1)

    await beginSerializable(database.client)
    const blocked = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(blocked.payload.state.activeSignerInvocationCount, 1)
    assert.equal(blocked.payload.state.activationBlocked, true)
    assert.deepEqual(blocked.payload.state.activationBlockingReasons, [
      "nonce-allocator-external-io-active",
    ])

    // While the orphan stands the record cannot even void its own reservation,
    // which is what makes the freeze store-wide rather than record-local.
    const voidedAtUnixMs = 3_000
    const voided: P2TRSignatureFraudChallengeOutboxRecord = {
      ...boundary,
      status: "queued",
      version: boundary.version + 1,
      preparationLease: undefined,
      preparationSender: undefined,
      selectedLaneID: undefined,
      selectedSignerIdentity: undefined,
      reservedNonce: undefined,
      nonceReservedAtUnixMs: undefined,
      activeSignerInvocationStartedAtUnixMs: undefined,
      activeSignerInvocationID: undefined,
      voidedNonceReservations: [
        {
          reservation: boundary.reservedNonce!,
          voidedAtUnixMs,
          reasonCode: "reservation-expired",
          reason: "orphaned boundary recovery",
          evidenceDigest: `0x${"f5".repeat(32)}`,
        },
      ],
      updatedAtUnixMs: voidedAtUnixMs,
      lastError: "orphaned boundary recovery",
    }
    await begin(database.client)
    await assert.rejects(
      database.store.compareAndSwap(
        boundary.recordID,
        boundary.version,
        voided
      ),
      /only an unsigned selected reservation can be voided/
    )
    await database.client.query("ROLLBACK")

    await begin(database.client)
    assert.equal(
      await database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary)
      ),
      "acknowledged"
    )
    await commit(database.client)

    const cleared = await database.store.get(initial.recordID)
    assert.equal(cleared?.activeSignerInvocationStartedAtUnixMs, undefined)
    assert.equal(cleared?.signerInvocationStartedAtUnixMs, undefined)
    assert.equal(await barrierSignerInvocationCount(database), 0)

    await beginSerializable(database.client)
    const unblocked = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(unblocked.payload.state.activeSignerInvocationCount, 0)
    assert.deepEqual(unblocked.payload.state.activationBlockingReasons, [])
    assert.equal(unblocked.payload.state.activationBlocked, false)

    // The same void is now admitted, and the release it creates can reach the
    // allocator: the store-wide signer barrier is genuinely open again.
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(cleared!.recordID, cleared!.version, {
        ...voided,
        version: cleared!.version + 1,
      }),
      true
    )
    await commit(database.client)
    const pending = await database.store.listPendingNonceReleases({ limit: 10 })
    assert.equal(pending.requests.length, 1)
    const attempt = await database.store.claimNonceReleaseAttempt(
      pending.requests[0].releaseRequestID,
      "orphan-recovery",
      10_000,
      20_000
    )
    assert.ok(attempt)
    assert.equal(
      await database.store.beginNonceReleaseAttempt(attempt, 10_001),
      true
    )
    await database.client.end()
  }
)

postgresTest(
  "retires the activation-blocking incident raised over an orphaned boundary",
  async () => {
    const database = await createTestDatabase()
    const { initial, boundary } = await orphanedSignerBoundary(database, 211)
    await begin(database.client)
    const [invalidated] = await database.store.invalidateCanonicalProvenance(
      invalidationEvidence(initial)
    )
    await commit(database.client)
    assert.equal(invalidated.activeSignerInvocationStartedAtUnixMs, 1_300)
    assert.equal(await blockingProvenanceIncidents(database), 1)

    await beginSerializable(database.client)
    const blocked = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(blocked.payload.state.provenanceIncidentCount, 1)

    await begin(database.client)
    assert.equal(
      await database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary)
      ),
      "acknowledged"
    )
    await commit(database.client)

    assert.equal(await blockingProvenanceIncidents(database), 0)
    assert.equal(await barrierSignerInvocationCount(database), 0)
    await beginSerializable(database.client)
    const retired = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(retired.payload.state.provenanceIncidentCount, 0)
    assert.equal(retired.payload.state.activeSignerInvocationCount, 0)

    const evidence = await database.client.query<{
      outcome: string
      stage: string
      started: string
      attempts: number
    }>(
      `SELECT outcome, stage,
              boundary_started_at_unix_ms::text AS started,
              preparation_attempts AS attempts
         FROM p2tr_signature_fraud_challenge_signer_boundary_resolution`
    )
    assert.deepEqual(evidence.rows, [
      {
        outcome: "never-invoked",
        stage: "prepare",
        started: "1300",
        attempts: boundary.preparationAttempts,
      },
    ])
    await database.client.end()
  }
)

postgresTest(
  "database refuses an uninvoked orphan claim for a record with escape evidence",
  async () => {
    const database = await createTestDatabase()
    const { initial, boundary } = await orphanedSignerBoundary(database, 212)
    const rawInsert = async (
      resolution: P2TRSignatureFraudIndependentSignerBoundaryResolution,
      evidenceDigest = resolution.evidenceDigest,
      omitTombstoneColumns = false
    ): Promise<void> => {
      await database.client.query(
        `INSERT INTO p2tr_signature_fraud_challenge_signer_boundary_resolution (
            record_id, signer_invocation_id, boundary_started_at_unix_ms,
            preparation_attempts,
            nonce_reservation_id, stage, invoked_at_unix_ms, outcome,
            provider_evidence_digest, resolution_evidence_digest,
            primary_trust_domain_id, primary_independence_domain_id,
            primary_evidence_digest, primary_attestation,
            primary_attested_at_unix_ms, corroborating_trust_domain_id,
            corroborating_independence_domain_id,
            corroborating_evidence_digest, corroborating_attestation,
            corroborating_attested_at_unix_ms, resolved_at_unix_ms,
            provider_tombstone_receipt, provider_tombstone_at_unix_ms
         ) VALUES (
            decode($1, 'hex'), decode($8, 'hex'), $2, $3,
            decode($4, 'hex'), 'prepare', $5,
            'never-invoked', decode($6, 'hex'), decode($7, 'hex'),
            'signer-primary', 'signer-primary-infra', decode($7, 'hex'),
            decode('01', 'hex'), 2000, 'signer-corroborating',
            'signer-corroborating-infra', decode($7, 'hex'),
            decode('02', 'hex'), 2000, 2400,
            CASE WHEN $9::text IS NULL THEN NULL ELSE decode($9, 'hex') END,
            $10
         )`,
        [
          initial.recordID.replace(/^0x/i, ""),
          resolution.boundaryStartedAtUnixMs,
          resolution.preparationAttempts,
          resolution.nonceReservationID.slice(2),
          resolution.invokedAtUnixMs,
          resolution.providerEvidenceDigest.slice(2),
          evidenceDigest.slice(2),
          resolution.signerInvocationID.slice(2),
          omitTombstoneColumns || resolution.providerTombstone === undefined
            ? null
            : resolution.providerTombstone.receipt.slice(2),
          omitTombstoneColumns
            ? null
            : resolution.providerTombstone?.tombstonedAtUnixMs ?? null,
        ]
      )
    }

    // Every branch of the guard is reachable from raw SQL, so every branch is
    // proven here rather than only through the adapter that already checked.
    await assert.rejects(
      rawInsert(
        boundaryResolution(boundary, {
          signerInvocationID: `0x${"e2".repeat(32)}`,
          invokedAtUnixMs: 1_310,
        })
      ),
      /does not name the durable boundary/
    )
    // Both halves of the guard's ownership predicate, from raw SQL: the
    // identity, and a descriptive column that no longer matches the durable row.
    await assert.rejects(
      rawInsert(
        boundaryResolution(boundary, {
          boundaryStartedAtUnixMs: 1_290,
          invokedAtUnixMs: 1_299,
        })
      ),
      /does not name the durable boundary/
    )
    // Independently of the TypeScript assert: the trigger refuses an uninvoked
    // outcome whose fencing receipt is absent, even though the caller computed
    // a digest for one.
    await assert.rejects(
      rawInsert(boundaryResolution(boundary), undefined, true),
      /requires a provider tombstone|violates check constraint/
    )
    await assert.rejects(
      rawInsert(boundaryResolution(boundary), `0x${"ab".repeat(32)}`),
      /orphaned signer boundary resolution digest is invalid/
    )

    // Historical proof that a signer invocation began, written directly so the
    // guard is exercised even if a future caller bypasses the TypeScript path.
    await database.client.query(
      `UPDATE p2tr_signature_fraud_challenge_outbox
          SET signer_invocation_started_at_unix_ms = 1300,
              version = version + 1,
              updated_at_unix_ms = updated_at_unix_ms + 1,
              record_state = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    record_state,
                    '{signerInvocationStartedAtUnixMs}',
                    to_jsonb(1300)
                  ),
                  '{version}',
                  to_jsonb((record_state ->> 'version')::bigint + 1)
                ),
                '{updatedAtUnixMs}',
                to_jsonb((record_state ->> 'updatedAtUnixMs')::bigint + 1)
              )
        WHERE record_id = decode($1, 'hex')`,
      [initial.recordID.replace(/^0x/i, "")]
    )
    await assert.rejects(
      rawInsert(boundaryResolution(boundary)),
      /no signer escape evidence/
    )
    // The adapter refuses for the same reason, with the same wording.
    await begin(database.client)
    await assert.rejects(
      database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary)
      ),
      /Orphaned signer boundary resolution requires a boundary with no signer escape evidence/
    )
    await database.client.query("ROLLBACK")
    // The marker therefore still holds the store-wide barrier closed.
    assert.equal(await barrierSignerInvocationCount(database), 1)
    await database.client.end()
  }
)

postgresTest(
  "keeps activation blocked for a terminally unsafe orphaned boundary",
  async () => {
    const database = await createTestDatabase()
    const { initial, boundary } = await orphanedSignerBoundary(database, 213)
    await begin(database.client)
    assert.equal(
      await database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary, { outcome: "terminal-unsafe" })
      ),
      "unsafe"
    )
    await commit(database.client)

    const durable = await database.store.get(initial.recordID)
    assert.equal(durable?.activeSignerInvocationStartedAtUnixMs, 1_300)
    assert.equal(await barrierSignerInvocationCount(database), 1)
    const alerts = await database.client.query<{ code: string }>(
      `SELECT code
         FROM p2tr_signature_fraud_challenge_critical_alert
        WHERE activation_blocking`
    )
    assert.deepEqual(alerts.rows, [{ code: "signer-boundary-terminal-unsafe" }])

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(response.payload.state.activationBlocked, true)
    assert.equal(response.payload.state.activationBlockingAlertCount, 1)
    assert.ok(
      response.payload.state.activationBlockingReasons.includes(
        "activation-blocking-outbox-alert"
      )
    )
    assert.ok(
      response.payload.state.activationBlockingReasons.includes(
        "nonce-allocator-external-io-active"
      )
    )
    await database.client.end()
  }
)

postgresTest(
  "retains the boundary for a signed orphan so the escaped bytes can be captured",
  async () => {
    const database = await createTestDatabase()
    const { initial, boundary } = await orphanedSignerBoundary(database, 214)
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
    assert.equal(
      await database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary, {
          outcome: "signed",
          signedTransactionHash: transactionHash,
        })
      ),
      "acknowledged"
    )
    await commit(database.client)

    // The resolver never clears the marker for a signed orphan: the retained
    // boundary is the only thing that still authorizes the capture below.
    const retained = await database.store.get(initial.recordID)
    assert.equal(retained?.activeSignerInvocationStartedAtUnixMs, 1_300)
    assert.equal(await barrierSignerInvocationCount(database), 1)

    const managed = createManagedStore(
      database.client,
      eligibilitySnapshotFor(initial)
    )
    const captured = await managed.captureEscapedSignedArtifact(
      initial.recordID,
      initial.canonicalProvenance.provenanceFingerprint,
      {
        expectedReservationID:
          boundary.reservedNonce!.reservationID.toPrefixedString(),
        capturedAtUnixMs: 2_500,
        reason:
          "independently attested orphaned signer boundary produced bytes",
        preparedTransaction: {
          intentID: initial.intent.intentID,
          rawTransaction,
          transactionHash: Hex.from(transactionHash),
          sender: WALLET.address,
          nonce: 7,
        },
      }
    )
    assert.equal(captured.unexpectedSignedArtifacts?.length, 1)
    assert.equal(captured.activeSignerInvocationStartedAtUnixMs, undefined)
    assert.equal(captured.signerInvocationStartedAtUnixMs, 1_300)
    assert.equal(await barrierSignerInvocationCount(database), 0)
    const durable = await database.client.query<{
      hash: string
      artifacts: string
    }>(
      `SELECT encode(signed_transaction_hash, 'hex') AS hash,
              (SELECT count(*)::text
                 FROM p2tr_signature_fraud_challenge_late_signed_artifact)
                AS artifacts
         FROM p2tr_signature_fraud_challenge_signer_boundary_resolution`
    )
    assert.deepEqual(durable.rows, [
      { hash: transactionHash.slice(2), artifacts: "1" },
    ])
    await database.client.end()
  }
)

postgresTest(
  "captures late signer bytes after nonce consumption clears an orphaned boundary",
  async () => {
    const database = await createTestDatabase()
    const { initial, boundary } = await orphanedSignerBoundary(database, 215)
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
    assert.equal(
      await database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary, { outcome: "nonce-consumed" })
      ),
      "acknowledged"
    )
    await commit(database.client)

    const resolved = await database.store.get(initial.recordID)
    assert.equal(resolved?.status, "quarantined")
    assert.equal(resolved?.activeSignerInvocationStartedAtUnixMs, undefined)
    assert.equal(resolved?.signerInvocationStartedAtUnixMs, undefined)

    const captured = await database.store.captureEscapedSignedArtifact(
      initial.recordID,
      initial.canonicalProvenance.provenanceFingerprint,
      {
        expectedReservationID:
          boundary.reservedNonce!.reservationID.toPrefixedString(),
        capturedAtUnixMs: 2_500,
        reason:
          "late signer bytes arrived after final nonce consumption resolution",
        preparedTransaction: {
          intentID: initial.intent.intentID,
          rawTransaction,
          transactionHash: Hex.from(transactionHash),
          sender: WALLET.address,
          nonce: 7,
        },
      }
    )

    assert.equal(captured.unexpectedSignedArtifacts?.length, 1)
    assert.equal(
      captured.unexpectedSignedArtifacts?.[0].preparedTransaction
        .rawTransaction,
      rawTransaction
    )
    const artifacts = await database.client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM p2tr_signature_fraud_challenge_late_signed_artifact`
    )
    assert.deepEqual(artifacts.rows, [{ count: "1" }])
    await database.client.end()
  }
)

postgresTest(
  "keeps orphaned signer boundary evidence append-only",
  async () => {
    const database = await createTestDatabase()
    const { boundary } = await orphanedSignerBoundary(database, 215)
    await begin(database.client)
    assert.equal(
      await database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary)
      ),
      "acknowledged"
    )
    await commit(database.client)
    await assert.rejects(
      database.client.query(
        `UPDATE p2tr_signature_fraud_challenge_signer_boundary_resolution
            SET outcome = 'terminal-unsafe'`
      ),
      /append-only/
    )
    await assert.rejects(
      database.client.query(
        `DELETE FROM p2tr_signature_fraud_challenge_signer_boundary_resolution`
      ),
      /append-only/
    )
    await database.client.end()
  }
)

type OrphanedBoundaryOutcome = {
  results: string[]
  alertCodes: string[]
}

type OrphanedBoundaryScenario = {
  name: string
  seed: number
  boundary: (
    reserved: P2TRSignatureFraudChallengeOutboxRecord
  ) =>
    | readonly P2TRSignatureFraudChallengeOutboxRecord[]
    | Promise<readonly P2TRSignatureFraudChallengeOutboxRecord[]>
  resolutions: BoundaryResolutionOverrides[]
  /**
   * The exact outcome each resolution must produce. Parity alone would be
   * satisfied by two stores failing the same wrong way, so every scenario also
   * pins the durable effect and the rejection reason it is testing.
   */
  expected: string[]
  expectedAlertCodes: string[]
}

function orphanedBoundaryResult(
  outcome: "acknowledged" | "unsafe" | Error,
  record: P2TRSignatureFraudChallengeOutboxRecord | undefined
): string {
  return outcome instanceof Error
    ? `error:${outcome.message}`
    : [
        outcome,
        `status=${record?.status ?? "missing"}`,
        `active=${record?.activeSignerInvocationStartedAtUnixMs ?? "none"}`,
        `activeID=${record?.activeSignerInvocationID ?? "none"}`,
        `signer=${record?.signerInvocationStartedAtUnixMs ?? "none"}`,
        `signerID=${record?.signerInvocationID ?? "none"}`,
        `artifacts=${record?.unexpectedSignedArtifacts?.length ?? 0}`,
      ].join(" ")
}

async function postgresOrphanedBoundaryOutcome(
  scenario: OrphanedBoundaryScenario
): Promise<OrphanedBoundaryOutcome> {
  const database = await createTestDatabase()
  try {
    const initial = outboxRecord(scenario.seed)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    let current = reserved
    for (const transition of await scenario.boundary(reserved)) {
      await begin(database.client)
      assert.equal(
        await database.store.compareAndSwap(
          current.recordID,
          current.version,
          transition
        ),
        true
      )
      await commit(database.client)
      current = transition
    }
    const managed = createManagedStore(
      database.client,
      eligibilitySnapshotFor(initial)
    )
    const results: string[] = []
    for (const overrides of scenario.resolutions) {
      try {
        const outcome = await managed.resolveOrphanedSignerBoundary(
          boundaryResolution(current, overrides)
        )
        results.push(
          orphanedBoundaryResult(
            outcome,
            await database.store.get(initial.recordID)
          )
        )
      } catch (error) {
        results.push(orphanedBoundaryResult(error as Error, undefined))
      }
    }
    const alerts = await database.client.query<{ code: string }>(
      `SELECT DISTINCT code
         FROM p2tr_signature_fraud_challenge_critical_alert
        ORDER BY code`
    )
    return { results, alertCodes: alerts.rows.map((row) => row.code) }
  } finally {
    await database.client.end()
  }
}

async function inMemoryOrphanedBoundaryOutcome(
  scenario: OrphanedBoundaryScenario
): Promise<OrphanedBoundaryOutcome> {
  const store = new InMemoryOutboxStore()
  const initial = outboxRecord(scenario.seed)
  await store.insertGenerationIfAbsent(initial)
  const selected = selectedRecord(initial)
  assert.equal(
    await store.compareAndSwap(initial.recordID, initial.version, selected),
    true
  )
  const reserved = reservedRecord(selected)
  assert.equal(
    await store.compareAndSwap(selected.recordID, selected.version, reserved),
    true
  )
  let current = reserved
  for (const transition of await scenario.boundary(reserved)) {
    assert.equal(
      await store.compareAndSwap(current.recordID, current.version, transition),
      true
    )
    current = transition
  }
  const results: string[] = []
  for (const overrides of scenario.resolutions) {
    try {
      const outcome = await store.resolveOrphanedSignerBoundary(
        boundaryResolution(current, overrides)
      )
      results.push(
        orphanedBoundaryResult(outcome, await store.get(initial.recordID))
      )
    } catch (error) {
      results.push(orphanedBoundaryResult(error as Error, undefined))
    }
  }
  return {
    results,
    alertCodes: [
      ...new Set(store.criticalAlerts.map((alert) => alert.code)),
    ].sort(),
  }
}

function orphanedBoundaryOnly(
  reserved: P2TRSignatureFraudChallengeOutboxRecord
): readonly P2TRSignatureFraudChallengeOutboxRecord[] {
  return [activeInitialSignerBoundary(reserved)]
}

const CLEARED_ORPHAN =
  "acknowledged status=preparing active=none activeID=none signer=none " +
  "signerID=none artifacts=0"
const RETAINED_ORPHAN =
  "acknowledged status=preparing active=1300 activeID=0x0000000000000000000000000000000000000000000000000000000000000514 " +
  "signer=none signerID=none artifacts=0"
const UNSAFE_ORPHAN =
  "unsafe status=preparing active=1300 activeID=0x0000000000000000000000000000000000000000000000000000000000000514 signer=none " +
  "signerID=none artifacts=0"
const WRONG_BOUNDARY =
  "error:Orphaned signer boundary resolution does not name the durable boundary"

const orphanedBoundaryParityScenarios: OrphanedBoundaryScenario[] = [
  {
    name: "clears an uninvoked orphan",
    seed: 220,
    boundary: orphanedBoundaryOnly,
    resolutions: [{}],
    expected: [CLEARED_ORPHAN],
    expectedAlertCodes: [],
  },
  {
    name: "is idempotent for the identical evidence",
    seed: 221,
    boundary: orphanedBoundaryOnly,
    resolutions: [{}, {}],
    expected: [CLEARED_ORPHAN, CLEARED_ORPHAN],
    expectedAlertCodes: [],
  },
  {
    // No scenario anywhere resolved two DISTINCT boundaries on one record, so
    // the row identity was under-tested: keying the in-memory map on the record
    // alone would have passed everything while diverging from the PostgreSQL
    // primary key. Two resolutions, two identities, one record.
    name: "keeps two distinct boundaries on one record apart",
    seed: 238,
    boundary: orphanedBoundaryOnly,
    resolutions: [
      {},
      {
        signerInvocationID: `0x${"e3".repeat(32)}`,
        boundaryStartedAtUnixMs: 1_301,
        invokedAtUnixMs: 1_311,
      },
    ],
    expected: [CLEARED_ORPHAN, WRONG_BOUNDARY],
    expectedAlertCodes: [],
  },
  {
    // The chain settled it: marker cleared, but the record moves to
    // generation-required rather than back to preparing, so lease recovery
    // cannot void the guard and hand the spent nonce back to the allocator.
    name: "settles a boundary whose nonce was consumed at finality",
    seed: 242,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ outcome: "nonce-consumed" }],
    expected: [
      "acknowledged status=quarantined active=none activeID=none " +
        "signer=none signerID=none artifacts=0",
    ],
    expectedAlertCodes: [],
  },
  {
    // A nonce that appears consumed near the head can become live again in an
    // ordinary reorg. Direct boundary evidence therefore uses the same
    // consensus-finality floor as ordinary reconciliation.
    name: "refuses shallow nonce-consumption finality",
    seed: 245,
    boundary: orphanedBoundaryOnly,
    resolutions: [
      {
        outcome: "nonce-consumed",
        nonceConsumption: {
          chainID: CHAIN_ID,
          sender: WALLET.address,
          transactionNonce: 7,
          finalizedAccountNonce: 8,
          accountNonceReadAtBlock: 500,
          consumingTransaction: {
            transactionHash: `0x${"c1".repeat(32)}`,
            sender: WALLET.address,
            nonce: 7,
            blockNumber: 480,
            blockHash: `0x${"c2".repeat(32)}`,
          },
          finalizedThrough: {
            blockNumber: 500,
            blockHash: `0x${"c3".repeat(32)}`,
          },
          observedHead: {
            blockNumber: 563,
            blockHash: `0x${"c4".repeat(32)}`,
          },
        },
      },
    ],
    expected: [
      "error:Signer-boundary nonce consumption finality depth must be at least 64 blocks",
    ],
    expectedAlertCodes: [],
  },
  {
    // Permitted precisely BECAUSE bytes may have escaped -- that is what nonce
    // consumption makes harmless. never-invoked refuses this same record.
    name: "settles a nonce-consumed boundary that carries escape evidence",
    seed: 243,
    boundary: (reserved) => [
      {
        ...activeInitialSignerBoundary(reserved),
        signerInvocationStartedAtUnixMs: 1_300,
      },
    ],
    resolutions: [{ outcome: "nonce-consumed" }],
    expected: [
      "acknowledged status=quarantined active=none activeID=none " +
        "signer=1300 signerID=none artifacts=0",
    ],
    // The escape evidence is NOT laundered away by the resolution: the record
    // still raises its activation-blocking signed-state alert. Nonce
    // consumption makes the bytes inert, not the incident invisible.
    expectedAlertCodes: ["signed-state-quarantined"],
  },
  {
    // Nothing else in nonce-consumption evidence names a chain, so without the
    // binding two attestations over "sender S nonce N is consumed" would replay
    // against any record on any chain sharing that pair.
    name: "refuses nonce consumption that names another chain",
    seed: 244,
    boundary: orphanedBoundaryOnly,
    resolutions: [
      {
        outcome: "nonce-consumed",
        nonceConsumption: {
          chainID: 999,
          sender: WALLET.address,
          transactionNonce: 7,
          finalizedAccountNonce: 8,
          accountNonceReadAtBlock: 500,
          consumingTransaction: {
            transactionHash: `0x${"c1".repeat(32)}`,
            sender: WALLET.address,
            nonce: 7,
            blockNumber: 480,
            blockHash: `0x${"c2".repeat(32)}`,
          },
          finalizedThrough: {
            blockNumber: 500,
            blockHash: `0x${"c3".repeat(32)}`,
          },
          observedHead: {
            blockNumber: 564,
            blockHash: `0x${"c4".repeat(32)}`,
          },
        },
      },
    ],
    expected: [
      "error:Orphaned signer boundary nonce consumption names another chain",
    ],
    expectedAlertCodes: [],
  },
  {
    // The whole point of the tombstone: nobody can observe the absence of a
    // request still in transit, so never-invoked without a provider fencing
    // write is a claim no attester is positioned to make.
    name: "refuses an uninvoked claim with no provider tombstone",
    seed: 240,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ omitProviderTombstone: true }],
    expected: [
      "error:Signer-boundary resolution names a provider tombstone only for a " +
        "never-invoked outcome",
    ],
    expectedAlertCodes: [],
  },
  {
    name: "refuses a tombstone naming another invocation",
    seed: 241,
    boundary: orphanedBoundaryOnly,
    resolutions: [
      {
        providerTombstone: {
          signerInvocationID: `0x${"f1".repeat(32)}`,
          receipt: "0xfeed",
          tombstonedAtUnixMs: 1_305,
        },
      },
    ],
    expected: [
      "error:Orphaned signer boundary tombstone names another invocation",
    ],
    expectedAlertCodes: [],
  },
  {
    name: "rejects a different signer invocation ID",
    seed: 222,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ signerInvocationID: `0x${"e1".repeat(32)}` }],
    expected: [WRONG_BOUNDARY],
    expectedAlertCodes: [],
  },
  {
    name: "rejects a different boundary start",
    seed: 239,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ boundaryStartedAtUnixMs: 1_299 }],
    expected: [WRONG_BOUNDARY],
    expectedAlertCodes: [],
  },
  {
    name: "rejects a different preparation attempt",
    seed: 223,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ preparationAttempts: 2 }],
    expected: [WRONG_BOUNDARY],
    expectedAlertCodes: [],
  },
  {
    name: "rejects a different nonce reservation",
    seed: 224,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ nonceReservationID: `0x${"d2".repeat(32)}` }],
    expected: [WRONG_BOUNDARY],
    expectedAlertCodes: [],
  },
  {
    name: "rejects a single attestation",
    seed: 225,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ attestationMode: "single" }],
    expected: [
      "error:Independent signer-boundary resolution requires exactly two attestations",
    ],
    expectedAlertCodes: [],
  },
  {
    name: "rejects a shared trust domain",
    seed: 226,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ attestationMode: "same-trust-domain" }],
    expected: [
      "error:Independent signer-boundary attestations do not bind the same evidence across distinct domains",
    ],
    expectedAlertCodes: [],
  },
  {
    name: "rejects a shared independence domain",
    seed: 227,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ attestationMode: "same-independence-domain" }],
    expected: [
      "error:Independent signer-boundary attestations do not bind the same evidence across distinct domains",
    ],
    expectedAlertCodes: [],
  },
  {
    name: "rejects two identical attestations",
    seed: 228,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ attestationMode: "identical-attestation" }],
    expected: [
      "error:Independent signer-boundary attestations do not bind the same evidence across distinct domains",
    ],
    expectedAlertCodes: [],
  },
  {
    name: "rejects an attestation made outside the invocation window",
    seed: 229,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ attestedAtUnixMs: 1_309 }],
    expected: [
      "error:Independent signer-boundary attestations fall outside the invocation window",
    ],
    expectedAlertCodes: [],
  },
  {
    name: "rejects a digest that does not commit to the binding",
    seed: 230,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ evidenceDigest: `0x${"ab".repeat(32)}` }],
    expected: [
      "error:Independent signer-boundary resolution digest is invalid",
    ],
    expectedAlertCodes: [],
  },
  {
    // The forced digest keeps the rejection inside the stores rather than in
    // the shared digest helper the test builder would otherwise call.
    name: "rejects signed bytes named without a signed outcome",
    seed: 231,
    boundary: orphanedBoundaryOnly,
    resolutions: [
      {
        signedTransactionHash: BOUNDARY_SIGNED_HASH,
        evidenceDigest: `0x${"ab".repeat(32)}`,
      },
    ],
    expected: [
      "error:Independent signer-boundary resolution names signed bytes only for a signed outcome",
    ],
    expectedAlertCodes: [],
  },
  {
    name: "rejects a signed outcome that names no bytes",
    seed: 232,
    boundary: orphanedBoundaryOnly,
    resolutions: [
      {
        outcome: "signed",
        signedTransactionHash: undefined,
        evidenceDigest: `0x${"ab".repeat(32)}`,
      },
    ],
    expected: [
      "error:Independent signer-boundary resolution names signed bytes only for a signed outcome",
    ],
    expectedAlertCodes: [],
  },
  {
    name: "retains the boundary for a signed orphan",
    seed: 233,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ outcome: "signed" }],
    expected: [RETAINED_ORPHAN],
    expectedAlertCodes: [],
  },
  {
    name: "keeps a terminally unsafe orphan blocking",
    seed: 234,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ outcome: "terminal-unsafe" }],
    expected: [UNSAFE_ORPHAN],
    expectedAlertCodes: ["signer-boundary-terminal-unsafe"],
  },
  {
    name: "refuses to conflict with prior evidence for the same boundary",
    seed: 235,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ outcome: "terminal-unsafe" }, { outcome: "signed" }],
    expected: [
      UNSAFE_ORPHAN,
      "error:Independent signer-boundary resolution conflicts",
    ],
    expectedAlertCodes: ["signer-boundary-terminal-unsafe"],
  },
  {
    name: "refuses an uninvoked claim over escaped signed state",
    seed: 236,
    boundary: replacementSignerBoundary,
    resolutions: [
      {
        boundaryStartedAtUnixMs: 1_500,
        invokedAtUnixMs: 1_510,
        stage: "replacement",
      },
    ],
    expected: [
      "error:Orphaned signer boundary resolution requires a boundary with no signer escape evidence",
    ],
    expectedAlertCodes: [],
  },
  {
    name: "accepts a terminally unsafe replacement boundary over signed state",
    seed: 237,
    boundary: replacementSignerBoundary,
    resolutions: [
      {
        boundaryStartedAtUnixMs: 1_500,
        invokedAtUnixMs: 1_510,
        stage: "replacement",
        outcome: "terminal-unsafe",
      },
    ],
    expected: [
      "unsafe status=prepared active=1500 activeID=0x00000000000000000000000000000000000000000000000000000000000005dc signer=1300 " +
        "signerID=none artifacts=0",
    ],
    expectedAlertCodes: ["signer-boundary-terminal-unsafe"],
  },
]

for (const scenario of orphanedBoundaryParityScenarios) {
  postgresTest(
    `in-memory and PostgreSQL orphaned-boundary resolution agree: ${scenario.name}`,
    async () => {
      const durable = await postgresOrphanedBoundaryOutcome(scenario)
      const memory = await inMemoryOrphanedBoundaryOutcome(scenario)
      assert.deepEqual(durable.results, scenario.expected)
      assert.deepEqual(durable.alertCodes, scenario.expectedAlertCodes)
      assert.deepEqual(memory.results, durable.results)
      assert.deepEqual(memory.alertCodes, durable.alertCodes)
    }
  )
}

// Activation is a whole-service event, so narrowing the barrier's key must not
// narrow activation safety: the handshake must still refuse if ANY lane has
// outstanding allocator or signer I/O. Per-lane equality alone cannot see that,
// because a lane with no barrier row contributes no failing group and no
// counters -- it reads exactly like a clean store. The four tests below drive
// the barrier audit to a positive mismatch, which nothing else in the suite
// does; without them a rollup that silently reports zero passes every test.
postgresTest(
  "blocks activation when a lane holding a signer boundary has no barrier row",
  async () => {
    const database = await createTestDatabase()
    await orphanedSignerBoundary(database, 216)
    assert.equal(await barrierSignerInvocationCount(database), 1)

    // Ground truth (the outbox marker) survives; only the barrier row that
    // accounts for it is gone.
    await database.client.query(
      `DELETE FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
        WHERE active_signer_invocation_count > 0`
    )
    assert.equal(await barrierSignerInvocationCount(database), 0)

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    assert.equal(response.payload.state.activeSignerInvocationCount, 0)
    // Two: the whole-store sum no longer matches ground truth, and the lane is
    // configured with no barrier row at all.
    assert.equal(response.payload.state.nonceAllocatorBarrierMismatchCount, 2)
    assert.equal(response.payload.state.activationBlocked, true)
    assert.equal(
      response.payload.state.activationBlockingReasons.includes(
        "nonce-allocator-barrier-mismatch"
      ),
      true
    )
    await database.client.end()
  }
)

postgresTest(
  "blocks activation when a configured lane loses its barrier row while idle",
  async () => {
    const database = await createTestDatabase()

    // No signer or release I/O anywhere, so every rollup and truth total is
    // zero on both sides and the sum equalities agree. Only an audit that
    // starts from the configured lanes can see that the row the triggers
    // require is gone.
    await database.client.query(
      `DELETE FROM p2tr_signature_fraud_nonce_allocator_safety_barrier`
    )

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    assert.equal(response.payload.state.activeSignerInvocationCount, 0)
    assert.equal(response.payload.state.activeNonceReleaseAttemptCount, 0)
    assert.equal(response.payload.state.unresolvedReleaseBarrierCount, 0)
    assert.equal(response.payload.state.configuredSignerLaneCount, 1)
    assert.equal(response.payload.state.nonceAllocatorBarrierMismatchCount, 1)
    assert.equal(response.payload.state.activationBlocked, true)
    assert.equal(response.payload.state.healthy, false)
    assert.equal(
      response.payload.state.activationBlockingReasons.includes(
        "nonce-allocator-barrier-mismatch"
      ),
      true
    )
    await database.client.end()
  }
)

postgresTest(
  "blocks activation when the barrier table is empty and I/O is outstanding",
  async () => {
    const database = await createTestDatabase()
    await orphanedSignerBoundary(database, 217)

    await database.client.query(
      `DELETE FROM p2tr_signature_fraud_nonce_allocator_safety_barrier`
    )

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    // Every counter reads clean, which is precisely the failure mode: only the
    // whole-store sum equality distinguishes this from an idle service, and the
    // configured-lane audit adds the second mismatch.
    assert.equal(response.payload.state.activeSignerInvocationCount, 0)
    assert.equal(response.payload.state.activeNonceReleaseAttemptCount, 0)
    assert.equal(response.payload.state.nonceAllocatorBarrierMismatchCount, 2)
    assert.equal(response.payload.state.activationBlocked, true)
    assert.equal(
      response.payload.state.activationBlockingReasons.includes(
        "nonce-allocator-barrier-mismatch"
      ),
      true
    )
    await database.client.end()
  }
)

postgresTest(
  "blocks activation when lane counters drift but their total still agrees",
  async () => {
    const database = await createTestDatabase()
    await orphanedSignerBoundary(database, 218)
    const decoySender = Buffer.alloc(20, 0xff)

    // Move the boundary's count onto a second, unrelated lane. The sum is still
    // 1 and still equals ground truth, so only the per-lane grouped equality
    // can see that both lanes are now misattributed.
    await database.client.query(
      `INSERT INTO p2tr_signature_fraud_nonce_allocator_safety_barrier (
           chain_id, sender, active_signer_invocation_count
       ) VALUES (
           (SELECT chain_id
              FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
             WHERE active_signer_invocation_count > 0),
           $1::bytea,
           1
       )`,
      [decoySender]
    )
    await database.client.query(
      `UPDATE p2tr_signature_fraud_nonce_allocator_safety_barrier
          SET active_signer_invocation_count = 0
        WHERE sender <> $1::bytea`,
      [decoySender]
    )
    assert.equal(await barrierSignerInvocationCount(database), 1)

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    assert.equal(response.payload.state.activeSignerInvocationCount, 1)
    assert.equal(response.payload.state.nonceAllocatorBarrierMismatchCount, 2)
    assert.equal(response.payload.state.activationBlocked, true)
    assert.equal(
      response.payload.state.activationBlockingReasons.includes(
        "nonce-allocator-barrier-mismatch"
      ),
      true
    )
    await database.client.end()
  }
)

postgresTest(
  "blocks activation when the global mismatch flag has no supporting evidence",
  async () => {
    const database = await createTestDatabase()
    await insertRecord(database, outboxRecord(219))

    // The flag is a statement about the allocator implementation rather than
    // any one account, so it survives lane keying on its own singleton and both
    // consistency invariants over it stay whole-store. Only this direction is
    // testable: the opposite one -- an unresolved `reservation-release-failed`
    // alert while the flag reads false -- cannot be built, because the alert
    // trigger demands the contract-mismatch result that sets the flag.
    await database.client.query(
      `UPDATE p2tr_signature_fraud_nonce_allocator_global_barrier
          SET contract_mismatch_blocked = true
        WHERE singleton = true`
    )

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    assert.equal(
      response.payload.state.nonceAllocatorContractMismatchBlocked,
      true
    )
    assert.equal(response.payload.state.nonceAllocatorBarrierMismatchCount, 2)
    assert.equal(
      response.payload.state.activationBlockingReasons.includes(
        "nonce-allocator-barrier-mismatch"
      ),
      true
    )
    await database.client.end()
  }
)

// The lane-scoped variants of these two predicates decide whether challenge
// signing is refused on one nonce lane, and both are implemented in SQL that no
// other test executes. Without this, the adapter could filter on the wrong
// column, or not filter at all, and every dispatcher-level test would still
// pass -- they bind to the in-memory double.
postgresTest("scopes the recovery predicates to one nonce lane", async () => {
  const database = await createTestDatabase()
  await orphanedSignerBoundary(database, 220)
  const afterLease = 10_000_000
  const ownLane = { chainID: CHAIN_ID, sender: WALLET.address }
  const otherSender = {
    chainID: CHAIN_ID,
    sender: `0x${"cd".repeat(20)}`,
  }
  const otherChain = { chainID: CHAIN_ID + 1, sender: WALLET.address }

  assert.equal(
    await database.store.hasExpiredPreparationLeases(afterLease),
    true
  )
  assert.equal(
    await database.store.hasExpiredPreparationLeases(afterLease, ownLane),
    true
  )
  // A different account on the same chain, and the same account on a
  // different chain, are both unaffected.
  assert.equal(
    await database.store.hasExpiredPreparationLeases(afterLease, otherSender),
    false
  )
  assert.equal(
    await database.store.hasExpiredPreparationLeases(afterLease, otherChain),
    false
  )
  // The sender is a lookup key, so its spelling must not matter.
  assert.equal(
    await database.store.hasExpiredPreparationLeases(afterLease, {
      chainID: CHAIN_ID,
      sender: WALLET.address.toLowerCase(),
    }),
    true
  )
  await database.client.end()
})

postgresTest(
  "scopes the pending nonce-release predicate to one nonce lane",
  async () => {
    const database = await createTestDatabase()
    await createPendingNonceRelease(database, 221)

    assert.equal(await database.store.hasPendingNonceReleases(), true)
    assert.equal(
      await database.store.hasPendingNonceReleases({
        chainID: CHAIN_ID,
        sender: WALLET.address,
      }),
      true
    )
    assert.equal(
      await database.store.hasPendingNonceReleases({
        chainID: CHAIN_ID,
        sender: `0x${"cd".repeat(20)}`,
      }),
      false
    )
    assert.equal(
      await database.store.hasPendingNonceReleases({
        chainID: CHAIN_ID + 1,
        sender: WALLET.address,
      }),
      false
    )
    await database.client.end()
  }
)

// The one-shot property, which is what makes a provider's answer binding.
// `never-invoked` rests on a provider receipt the watchtower cannot verify --
// the bytes are opaque to it -- so the guarantee it CAN offer is that an
// invocation is answered exactly once: the resolution must name the live
// marker, and it clears that marker in the same transaction. A provider that
// later contradicts itself has nowhere to put the second answer.
postgresTest(
  "answers each signer invocation exactly once, whatever the second answer says",
  async () => {
    const database = await createTestDatabase()
    const { boundary } = await orphanedSignerBoundary(database, 222)

    await begin(database.client)
    assert.equal(
      await database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary)
      ),
      "acknowledged"
    )
    await commit(database.client)

    // Same invocation, opposite claim. The marker it would have to name is
    // gone, so there is no way to record a contradiction.
    await assert.rejects(
      database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary, {
          outcome: "signed",
          signedTransactionHash: `0x${"5e".repeat(32)}`,
        })
      ),
      /Independent signer-boundary resolution conflicts/
    )

    // Replaying the identical answer is not a contradiction, so it stays
    // idempotent rather than becoming a second, conflicting record.
    await begin(database.client)
    assert.equal(
      await database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary)
      ),
      "acknowledged"
    )
    await commit(database.client)
    const stored = await database.client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM p2tr_signature_fraud_challenge_signer_boundary_resolution`
    )
    assert.equal(stored.rows[0].count, "1")
    await database.client.end()
  }
)
