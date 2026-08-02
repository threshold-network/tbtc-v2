import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"
import { readFile } from "node:fs/promises"
import { generateKeyPairSync, sign } from "node:crypto"
import test, { type TestContext } from "node:test"

import { BigNumber, Wallet, utils } from "ethers"
import pg from "pg"
import type { Client as PostgreSQLClient } from "pg"

import {
  Hex,
  P2TR_SIGNATURE_FRAUD_COMPLETE_V2_CHALLENGE_EVIDENCE_ABI_TYPE,
  P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL,
  P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID,
  computeP2TRCompleteV2SignatureFraudChallengeIdentity,
  computeP2TRSignatureFraudSubmissionIntentID,
  getP2TRSignatureFraudPreparedTransactionType,
} from "@keep-network/tbtc-v2.ts"

import {
  P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence,
  P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  P2TRSignatureFraudChallengeOutboxRecord,
  P2TRSignatureFraudIndependentSignerBoundaryResolution,
  P2TRSignatureFraudNonceReleaseRequest,
  P2TRSignatureFraudSignerQuarantine,
  P2TRSignatureFraudUnexpectedSignedArtifact,
  computeP2TRSignatureFraudCanonicalCandidateDigest,
  computeP2TRSignatureFraudCanonicalEventSetHash,
  computeP2TRSignatureFraudCanonicalProvenanceFingerprint,
  computeP2TRSignatureFraudCanonicalProvenanceInvalidationEvidenceHash,
  computeP2TRSignatureFraudChallengeFeePolicyHash,
  computeP2TRSignatureFraudEthereumEligibilityReadSetHash,
  computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest,
  computeP2TRSignatureFraudOutboxRecordID,
  computeP2TRSignatureFraudOutboxSeriesID,
  computeP2TRSignatureFraudSignerBoundaryResolutionEvidenceDigest,
  computeP2TRSignatureFraudSignerInvocationID,
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
  type PostgresP2TRSignatureFraudChallengeOutboxStoreOptions,
} from "../src/PostgresP2TRSignatureFraudChallengeOutboxStore.js"
import type { P2TRSignatureFraudWatchtowerTransactionCoordinator } from "../src/types.js"
import { InMemoryOutboxStore } from "./InMemoryP2TRSignatureFraudChallengeOutboxStore.js"

const postgresURL = process.env.P2TR_WATCHTOWER_TEST_POSTGRES_URL
const MANIFEST_HASH = `0x${"a1".repeat(32)}`
const ETHEREUM_BLOCK_HASH = `0x${"a2".repeat(32)}`
const WALLET = new Wallet(`0x${"11".repeat(32)}`)
const SECONDARY_WALLET = new Wallet(`0x${"12".repeat(32)}`)
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

const hexBuffer = (value: string): Buffer =>
  Buffer.from(value.replace(/^0x/i, ""), "hex")

const runtimeMigrationDirectory = process.env.P2TR_WATCHTOWER_RUNTIME_MIGRATIONS

type TestDatabase = {
  client: PostgreSQLClient
  schema: string
  store: PostgresP2TRSignatureFraudChallengeOutboxStore
}

type PostgresTestResources = {
  clients: Set<PostgreSQLClient>
  schemas: Set<string>
}

type CleanupAwarePostgreSQLClient = PostgreSQLClient & {
  _ended?: boolean
  _ending?: boolean
}

const postgresTestResources = new AsyncLocalStorage<PostgresTestResources>()

function postgresTest(
  name: string,
  body: (context: TestContext) => void | Promise<void>
) {
  if (postgresURL === undefined) return test.skip(name, body)
  return test(name, async (context) => {
    const resources: PostgresTestResources = {
      clients: new Set(),
      schemas: new Set(),
    }
    let bodyError: unknown
    try {
      await postgresTestResources.run(resources, () => body(context))
    } catch (error) {
      bodyError = error
    }
    let cleanupError: unknown
    try {
      await cleanupPostgresTestResources(resources)
    } catch (error) {
      cleanupError = error
    }
    if (bodyError !== undefined) throw bodyError
    if (cleanupError !== undefined) throw cleanupError
  })
}

async function cleanupPostgresTestResources(
  resources: PostgresTestResources
): Promise<void> {
  const errors: unknown[] = []
  for (const client of [...resources.clients].reverse()) {
    const cleanupAwareClient = client as CleanupAwarePostgreSQLClient
    if (cleanupAwareClient._ending || cleanupAwareClient._ended) continue
    try {
      await client.query("ROLLBACK")
    } catch {
      // The test may already have closed the client or left no transaction.
    }
    if (cleanupAwareClient._ending || cleanupAwareClient._ended) continue
    try {
      await client.end()
    } catch (error) {
      errors.push(error)
    }
  }
  if (resources.schemas.size > 0) {
    const cleanupClient = new Client({ connectionString: postgresURL })
    try {
      await cleanupClient.connect()
      for (const schema of [...resources.schemas].reverse()) {
        if (!/^p2tr_outbox_[0-9]+_[0-9]+$/.test(schema)) {
          throw new Error("Refusing to drop an unexpected test schema")
        }
        await cleanupClient.query(`DROP SCHEMA ${schema} CASCADE`)
      }
    } catch (error) {
      errors.push(error)
    } finally {
      try {
        await cleanupClient.end()
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "PostgreSQL test resource cleanup failed")
  }
}

async function createTestDatabase(
  maxActiveOutboxRecords = 1_024,
  domainChainID = CHAIN_ID,
  initialSignerConfiguration = signerConfiguration(),
  throughMigrationVersion = 10
): Promise<TestDatabase> {
  const client = new Client({ connectionString: postgresURL })
  const resources = postgresTestResources.getStore()
  if (resources === undefined) {
    throw new Error("PostgreSQL test database was opened outside postgresTest")
  }
  resources.clients.add(client)
  await client.connect()
  const schema = `p2tr_outbox_${process.pid}_${++schemaSequence}`
  await client.query(`CREATE SCHEMA ${schema}`)
  resources.schemas.add(schema)
  await client.query(`SET search_path TO ${schema}`)
  const migrations = [
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
      "../migrations/006_p2tr_candidate_enqueue_generation_authority.sql",
      import.meta.url
    ),
    new URL(
      "../migrations/007_p2tr_candidate_enqueue_recovery_hardening.sql",
      import.meta.url
    ),
    new URL(
      "../migrations/008_p2tr_candidate_enqueue_challenge_series.sql",
      import.meta.url
    ),
    new URL(
      "../migrations/009_p2tr_candidate_enqueue_capacity_authority.sql",
      import.meta.url
    ),
    new URL(
      "../migrations/010_p2tr_candidate_enqueue_transient_retries.sql",
      import.meta.url
    ),
  ]
  for (const migration of migrations.slice(0, throughMigrationVersion)) {
    await client.query(await readFile(migration, "utf8"))
  }
  await seedCanonicalPoint(client, maxActiveOutboxRecords, domainChainID)
  await client.query("BEGIN")
  const store = createStore(client)
  await store.installSignerLaneConfiguration(initialSignerConfiguration)
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
  },
  assertIndependentSignerBoundaryResolution: PostgresP2TRSignatureFraudChallengeOutboxStoreOptions["assertIndependentSignerBoundaryResolution"] = () =>
    true
) {
  return new PostgresP2TRSignatureFraudChallengeOutboxStore({
    storeID: "postgres.integration",
    session: client,
    transactionCoordinator,
    assertTransactionSession,
    broadcastProviderID: "broadcast.integration",
    assertIndependentNonceReleaseResolution: () => true as const,
    assertIndependentSignerBoundaryResolution,
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
  snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  assertIndependentSignerBoundaryResolution?: PostgresP2TRSignatureFraudChallengeOutboxStoreOptions["assertIndependentSignerBoundaryResolution"]
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
    async () => snapshot,
    assertIndependentSignerBoundaryResolution
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
  maxActiveOutboxRecords: number,
  domainChainID: number
): Promise<void> {
  const zero = Buffer.alloc(32)
  const blockHash = Buffer.from(ETHEREUM_BLOCK_HASH.slice(2), "hex")
  await client.query(
    `SELECT p2tr_assert_complete_authorization_domain($1, $2, $3)`,
    [
      hexBuffer(P2TR_SIGNATURE_FRAUD_COMPLETE_V2_PROTOCOL_ID),
      domainChainID,
      hexBuffer(BRIDGE_ADDRESS),
    ]
  )
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
      JSON.stringify({
        ethereum: { chainID: CHAIN_ID },
        outbox: {
          maxActiveOutboxRecords,
          routerAddress: ROUTER_ADDRESS,
        },
      }),
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

function signerConfiguration(
  manifestHash = MANIFEST_HASH,
  policyHash = feePolicy(manifestHash).policyHash
) {
  const withoutHash = {
    activationManifestHash: manifestHash,
    chainID: CHAIN_ID,
    policyHash,
    challengeValueWei: "1234",
    laneID: LANE_ID,
    signerIdentity: SIGNER_IDENTITY,
    sender: WALLET.address,
    maxGasLimit: "1000000",
    maxFeePerGas: "100",
    maxPriorityFeePerGas: "10",
    maxTotalFeeWei: "100000000",
    minimumReplacementFeeBumpBps: 1000,
    signerCodeHash: `0x${"a3".repeat(32)}`,
  }
  return {
    ...withoutHash,
    configurationHash:
      computeP2TRProductionSignerLaneConfigurationHash(withoutHash),
    configuredAtUnixMs: 1_000,
  }
}

function secondarySignerConfiguration(
  overrides: Partial<{
    chainID: number
    laneID: string
    signerIdentity: string
    configuredAtUnixMs: number
    policyHash: string
  }> = {}
) {
  const withoutHash = {
    activationManifestHash: MANIFEST_HASH,
    chainID: overrides.chainID ?? CHAIN_ID,
    policyHash: overrides.policyHash ?? feePolicy().policyHash,
    challengeValueWei: "1234",
    laneID: overrides.laneID ?? "lane-b",
    signerIdentity: overrides.signerIdentity ?? "signer-b",
    sender: SECONDARY_WALLET.address,
    maxGasLimit: "1000000",
    maxFeePerGas: "100",
    maxPriorityFeePerGas: "10",
    maxTotalFeeWei: "100000000",
    minimumReplacementFeeBumpBps: 1000,
    signerCodeHash: `0x${"a8".repeat(32)}`,
  }
  return {
    ...withoutHash,
    configurationHash:
      computeP2TRProductionSignerLaneConfigurationHash(withoutHash),
    configuredAtUnixMs: overrides.configuredAtUnixMs ?? 1_001,
  }
}

function feePolicy(manifestHash = MANIFEST_HASH, includeSecondaryLane = false) {
  const withoutHash = {
    activationManifestHash: manifestHash,
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
        minimumReplacementFeeBumpBps: 1000,
      },
      ...(includeSecondaryLane
        ? [
            {
              laneID: "lane-b",
              signerIdentity: "signer-b",
              sender: SECONDARY_WALLET.address,
              maxGasLimit: "1000000",
              maxFeePerGas: "100",
              maxPriorityFeePerGas: "10",
              maxTotalFeeWei: "100000000",
              minimumReplacementFeeBumpBps: 1000,
            },
          ]
        : []),
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

function sdkObservedOutboxRecord(
  seed: number,
  occurrenceID: string
): P2TRSignatureFraudChallengeOutboxRecord {
  const record = outboxRecord(seed)
  const { intentID: _intentID, ...baseIntent } = record.intent
  const intentWithoutID = {
    ...baseIntent,
    observationID: record.intent.bridgeChallengeKey,
  }
  const intent = {
    ...intentWithoutID,
    intentID: computeP2TRSignatureFraudSubmissionIntentID(intentWithoutID),
  }
  const candidate = {
    txid: record.evidenceCheckpoint.bitcoinTxHash,
    wtxid: record.evidenceCheckpoint.bitcoinWitnessTxHash,
    inputIndex: record.evidenceCheckpoint.bitcoinInputIndex,
    blockHash: record.evidenceCheckpoint.bitcoinBlockHash,
    blockHeight: record.evidenceCheckpoint.bitcoinBlockHeight,
  }
  const { provenanceFingerprint: _provenanceFingerprint, ...baseProvenance } =
    record.canonicalProvenance
  const provenanceWithoutFingerprint = {
    ...baseProvenance,
    candidateDigest: computeP2TRSignatureFraudCanonicalCandidateDigest(
      candidate,
      occurrenceID
    ),
  }
  const canonicalProvenance = {
    ...provenanceWithoutFingerprint,
    provenanceFingerprint:
      computeP2TRSignatureFraudCanonicalProvenanceFingerprint(
        provenanceWithoutFingerprint
      ),
  }
  const seriesID = computeP2TRSignatureFraudOutboxSeriesID(intent)
  return {
    ...record,
    seriesID,
    recordID: computeP2TRSignatureFraudOutboxRecordID(
      intent,
      record.generation,
      record.evidenceCheckpoint,
      record.canonicalEthereumEligibility,
      canonicalProvenance,
      record.feePolicyManifest,
      record.generationTrigger
    ),
    intent,
    canonicalProvenance,
  }
}

function outboxRecordForManifest(
  seed: number,
  manifestHash: string
): P2TRSignatureFraudChallengeOutboxRecord {
  const record = outboxRecord(seed)
  const { readSetHash: _readSetHash, ...eligibilityWithoutReadSetHash } =
    record.canonicalEthereumEligibility
  const eligibilityWithoutHash = {
    ...eligibilityWithoutReadSetHash,
    activationManifestHash: manifestHash,
  }
  const {
    provenanceFingerprint: _provenanceFingerprint,
    ...provenanceWithoutFingerprint
  } = record.canonicalProvenance
  const nextProvenanceWithoutFingerprint = {
    ...provenanceWithoutFingerprint,
    manifestHash,
  }
  return {
    ...record,
    evidenceCheckpoint: {
      ...record.evidenceCheckpoint,
      activationManifest: {
        ...record.evidenceCheckpoint.activationManifest,
        manifestHash,
      },
    },
    canonicalEthereumEligibility: {
      ...eligibilityWithoutHash,
      readSetHash: computeP2TRSignatureFraudEthereumEligibilityReadSetHash(
        eligibilityWithoutHash
      ),
    },
    canonicalProvenance: {
      ...nextProvenanceWithoutFingerprint,
      provenanceFingerprint:
        computeP2TRSignatureFraudCanonicalProvenanceFingerprint(
          nextProvenanceWithoutFingerprint
        ),
    },
    feePolicyManifest: feePolicy(manifestHash),
  }
}

function depositBoundOutboxRecord(
  seed: number
): P2TRSignatureFraudChallengeOutboxRecord {
  const record = outboxRecord(seed)
  const signingKey = Hex.from(`0x${"f1".repeat(32)}`)
  const fundingTxid = `0x${Buffer.from(
    Array.from({ length: 32 }, (_, index) => (seed + index) % 256)
  ).toString("hex")}`
  const bindingTxHash = Hex.from(
    `0x${Buffer.from(fundingTxid.slice(2), "hex").reverse().toString("hex")}`
  )
  const bridgeChallengeIdentity =
    computeP2TRCompleteV2SignatureFraudChallengeIdentity({
      domainChainID: CHAIN_ID,
      bridgeAddress: BRIDGE_ADDRESS,
      walletID: record.intent.walletID,
      signingKey,
      sighash: record.intent.sighash,
    })
  const challengePayload = utils.defaultAbiCoder.encode(
    [P2TR_SIGNATURE_FRAUD_COMPLETE_V2_CHALLENGE_EVIDENCE_ABI_TYPE],
    [
      {
        walletID: record.intent.walletID.toPrefixedString(),
        signingKey: signingKey.toPrefixedString(),
        bindingTxHash: bindingTxHash.toPrefixedString(),
        bindingOutputIndex: 1,
        sighash: record.intent.sighash.toPrefixedString(),
        nonceX: record.intent.nonceX.toPrefixedString(),
        signatureScalar: record.intent.signatureScalar.toPrefixedString(),
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
    ...record.intent,
    signingKey,
    bindingTxHash,
    bindingOutputIndex: 1,
    bridgeChallengeKey: bridgeChallengeIdentity,
    bridgeChallengeIdentity,
    calldata,
  }
  const intent = {
    ...intentWithoutID,
    intentID: computeP2TRSignatureFraudSubmissionIntentID(intentWithoutID),
  }
  const { provenanceFingerprint: _oldProvenanceFingerprint, ...oldProvenance } =
    record.canonicalProvenance
  const provenanceWithoutFingerprint = {
    ...oldProvenance,
    challengeKey: bridgeChallengeIdentity.toPrefixedString(),
    inputBindingKind: "deposit-binding" as const,
    fundingTxid,
    fundingVout: 1,
    inputOutputKey: signingKey.toPrefixedString(),
  }
  const eligibilityWithoutHash = {
    ...record.canonicalEthereumEligibility,
    routerChallengeKey: bridgeChallengeIdentity.toPrefixedString(),
    completeChallengeIdentity: bridgeChallengeIdentity.toPrefixedString(),
  }
  return {
    ...record,
    intent,
    canonicalEthereumEligibility: {
      ...eligibilityWithoutHash,
      readSetHash: computeP2TRSignatureFraudEthereumEligibilityReadSetHash(
        eligibilityWithoutHash
      ),
    },
    canonicalProvenance: {
      ...provenanceWithoutFingerprint,
      provenanceFingerprint:
        computeP2TRSignatureFraudCanonicalProvenanceFingerprint(
          provenanceWithoutFingerprint
        ),
    },
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
  const resources = postgresTestResources.getStore()
  if (resources === undefined || !resources.schemas.has(schema)) {
    throw new Error("PostgreSQL schema client was opened outside postgresTest")
  }
  resources.clients.add(client)
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

test("accepts saturated capacity and active-count drift in readiness assertions", () => {
  const databaseConstraintHash = `0x${"b4".repeat(32)}`
  const configuredSignerLaneSetHash = `0x${"b5".repeat(32)}`
  const expected = {
    ...outboxManifest(databaseConstraintHash),
    maxActiveOutboxRecords: 1,
  }
  const signed = {
    storeID: expected.storeID,
    protocolID: expected.protocolID,
    sender: expected.sender,
    routerAddress: expected.routerAddress,
    implementationCodeHash: expected.implementationCodeHash,
    databaseConstraintHash,
    preparedTransactionPersistence: expected.preparedTransactionPersistence,
    replacementPolicy: expected.replacementPolicy,
    migrationVersion: expected.migrationVersion,
    migrationChecksum: expected.migrationChecksum,
    startupReconciliationComplete: true,
    ambiguousTransactionCount: 0,
    activationBlockingCriticalAlertCount: 0,
    unresolvedLegacyQuarantineCount: 0,
    recoveryBacklogCount: 0,
    liveCandidateAuthorizationCount: 0,
    activeGenerationCount: 1,
    configuredSignerLaneCount: 1,
    configuredSignerLaneSetHash,
    senderLanes: expected.senderLanes.map((lane) => ({
      ...lane,
      healthy: true as const,
    })),
    healthy: true,
  }

  assert.doesNotThrow(() =>
    assertP2TRProductionOutboxHandshake(signed, expected)
  )
  assert.doesNotThrow(() =>
    assertP2TRProductionOutboxRevalidation(
      {
        activationBlockingCriticalAlertCount: 0,
        ambiguousTransactionCount: 0,
        unresolvedLegacyQuarantineCount: 0,
        recoveryBacklogCount: 0,
        activeGenerationCount: 0,
        configuredSignerLaneCount: 1,
        configuredSignerLaneSetHash,
        quarantinedSignerLaneCount: 0,
        activeOldManifestGenerationCount: 0,
        staleManifestGenerationSuccessorCount: 0,
        activeSignerInvocationCount: 0,
        activeNonceReleaseAttemptCount: 0,
      },
      signed,
      expected
    )
  )
})

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
  "returns lane unavailable when another active record owns the configured lane",
  async () => {
    const database = await createTestDatabase()
    const owner = outboxRecord(7)
    const contender = outboxRecord(8)
    await insertRecord(database, owner)
    await insertRecord(database, contender)

    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        owner.recordID,
        owner.version,
        selectedRecord(owner)
      ),
      true
    )
    await commit(database.client)

    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        contender.recordID,
        contender.version,
        selectedRecord(contender, 1_101)
      ),
      false
    )
    await commit(database.client)
    assert.equal(
      (await database.store.get(contender.recordID))?.status,
      "queued"
    )
    await database.client.end()
  }
)

async function insertCandidateEnqueueGuard(
  database: TestDatabase,
  reserved: P2TRSignatureFraudChallengeOutboxRecord,
  tokenID: string,
  occurrenceID: string
): Promise<void> {
  const certificateID = reserved.canonicalProvenance.readinessCertificateID
  await database.client.query(
    `INSERT INTO p2tr_readiness_certificates (
          certificate_id, certificate_generation, manifest_hash,
          manifest_activation_sequence, primary_bitcoin_generation,
          primary_bitcoin_root, primary_bitcoin_semantic_root,
          bitcoin_height, bitcoin_hash, ethereum_journal_generation,
          ethereum_history_root, ethereum_block_number, ethereum_block_hash,
          provider_read_set_hash, payload
     ) VALUES ($1, 1, $2, 1, 1, $3, $4, $5, $6, 1, $7, $8, $9, $10, '{}'::jsonb)`,
    [
      hexBuffer(certificateID),
      hexBuffer(MANIFEST_HASH),
      hexBuffer(reserved.canonicalProvenance.historyRoot),
      hexBuffer(reserved.canonicalProvenance.eventSetHash),
      reserved.evidenceCheckpoint.bitcoinCursorBlockHeight,
      hexBuffer(reserved.evidenceCheckpoint.bitcoinCursorBlockHash),
      hexBuffer(reserved.canonicalProvenance.historyRoot),
      reserved.canonicalProvenance.throughBlockNumber,
      hexBuffer(reserved.canonicalProvenance.throughBlockHash),
      hexBuffer(reserved.canonicalProvenance.provenanceFingerprint),
    ]
  )
  await database.client.query(
    `INSERT INTO p2tr_candidate_enqueue_authorizations (
          token_id, manifest_hash, candidate_digest, observation_id,
          challenge_key, txid, wtxid, input_index, bitcoin_block_height,
          bitcoin_block_hash, verified_bitcoin_height, verified_bitcoin_hash,
          verified_ethereum_block, verified_ethereum_hash, funding_block_hash,
          funding_txid, funding_vout, input_wallet_id, input_output_key,
          input_binding_kind, input_binding_source_event_id,
          candidate_provenance_generation, provenance_fingerprint,
          readiness_certificate_id, readiness_certificate_generation,
          expires_at, generation_authority_version,
          expected_outbox_series_id, expected_outbox_generation,
          expected_outbox_disposition
     ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, 1,
          clock_timestamp() + interval '1 minute', 1, $25, 0, 'initial'
     )`,
    [
      hexBuffer(tokenID),
      hexBuffer(MANIFEST_HASH),
      hexBuffer(reserved.canonicalProvenance.candidateDigest),
      hexBuffer(occurrenceID),
      hexBuffer(reserved.intent.bridgeChallengeKey.toPrefixedString()),
      hexBuffer(reserved.evidenceCheckpoint.bitcoinTxHash),
      hexBuffer(reserved.evidenceCheckpoint.bitcoinWitnessTxHash),
      reserved.evidenceCheckpoint.bitcoinInputIndex,
      reserved.evidenceCheckpoint.bitcoinBlockHeight,
      hexBuffer(reserved.evidenceCheckpoint.bitcoinBlockHash),
      reserved.evidenceCheckpoint.bitcoinCursorBlockHeight,
      hexBuffer(reserved.evidenceCheckpoint.bitcoinCursorBlockHash),
      reserved.canonicalProvenance.throughBlockNumber,
      hexBuffer(reserved.canonicalProvenance.throughBlockHash),
      hexBuffer(reserved.canonicalProvenance.fundingBlockHash),
      hexBuffer(reserved.canonicalProvenance.fundingTxid),
      reserved.canonicalProvenance.fundingVout,
      hexBuffer(reserved.canonicalProvenance.inputWalletID),
      hexBuffer(reserved.canonicalProvenance.inputOutputKey),
      reserved.canonicalProvenance.inputBindingKind,
      hexBuffer(reserved.canonicalProvenance.inputBindingSourceEventID),
      reserved.canonicalProvenance.candidateProvenanceGeneration,
      hexBuffer(reserved.canonicalProvenance.provenanceFingerprint),
      hexBuffer(certificateID),
      hexBuffer(reserved.seriesID),
    ]
  )
  await database.client.query(
    `INSERT INTO p2tr_candidate_enqueue_transaction_guard (
          manifest_hash, token_id, candidate_digest, max_attempt_count,
          guard_digest
     ) VALUES ($1, $2, $3, 3, $4)`,
    [
      hexBuffer(MANIFEST_HASH),
      hexBuffer(tokenID),
      hexBuffer(reserved.canonicalProvenance.candidateDigest),
      hexBuffer(`0x${"e2".repeat(32)}`),
    ]
  )
}

postgresTest(
  "protects a pre-armed candidate capacity reservation from ordinary writers",
  async () => {
    const database = await createTestDatabase(2)
    await insertRecord(database, outboxRecord(10))
    const reservedFixture = sdkObservedOutboxRecord(11, `0x${"0c".repeat(32)}`)
    assert.equal(
      reservedFixture.intent.observationID.toPrefixedString(),
      reservedFixture.intent.bridgeChallengeKey.toPrefixedString()
    )
    const reserved = {
      ...reservedFixture,
      seriesID: computeP2TRSignatureFraudOutboxSeriesID(reservedFixture.intent),
    }
    const unrelated = outboxRecord(12)
    await insertCandidateEnqueueGuard(
      database,
      reserved,
      `0x${"e1".repeat(32)}`,
      `0x${"0c".repeat(32)}`
    )
    const sqlSeries = await database.client.query<{
      series_id: string
      occurrence_id: string
      challenge_key: string
    }>(
      `SELECT encode(
                p2tr_candidate_enqueue_series_id(
                  manifest_hash, observation_id, challenge_key, input_index,
                  input_output_key, input_binding_kind, funding_txid,
                  funding_vout
                ),
                'hex'
              ) AS series_id,
              encode(observation_id, 'hex') AS occurrence_id,
              encode(challenge_key, 'hex') AS challenge_key
         FROM p2tr_candidate_enqueue_authorizations
        WHERE token_id = $1`,
      [hexBuffer(`0x${"e1".repeat(32)}`)]
    )
    assert.equal(`0x${sqlSeries.rows[0].series_id}`, reserved.seriesID)
    assert.notEqual(
      sqlSeries.rows[0].occurrence_id,
      sqlSeries.rows[0].challenge_key
    )

    await begin(database.client)
    await assert.rejects(
      database.store.insertGenerationIfAbsent(unrelated),
      /manifest-bound global active outbox capacity is exhausted or reserved/i
    )
    await database.client.query("ROLLBACK")

    await insertRecord(database, reserved)
    const capacity = await database.client.query<{
      active_generation_count: string
    }>(
      `SELECT active_generation_count::text AS active_generation_count
         FROM p2tr_signature_fraud_challenge_outbox_capacity
        WHERE singleton = true`
    )
    assert.equal(capacity.rows[0].active_generation_count, "2")
    await database.client.end()
  }
)

postgresTest(
  "releases an invalidated manifest guard from global capacity accounting",
  async () => {
    const database = await createTestDatabase(1)
    const nextManifest = `0x${"e4".repeat(32)}`
    await begin(database.client)
    await database.store.installSignerLaneConfiguration(
      signerConfiguration(nextManifest)
    )
    await commit(database.client)

    const staleReservation = outboxRecord(13)
    await insertCandidateEnqueueGuard(
      database,
      staleReservation,
      `0x${"e3".repeat(32)}`,
      `0x${"0e".repeat(32)}`
    )
    await rotateActivationManifest(database, nextManifest, 1)

    const invalidated = await database.client.query<{
      invalidated: boolean
    }>(
      `SELECT invalidated_at IS NOT NULL AS invalidated
         FROM p2tr_candidate_enqueue_authorizations
        WHERE token_id = $1`,
      [hexBuffer(`0x${"e3".repeat(32)}`)]
    )
    assert.deepEqual(invalidated.rows, [{ invalidated: true }])

    await insertRecord(database, outboxRecordForManifest(14, nextManifest))
    const capacity = await database.client.query<{
      active_generation_count: string
    }>(
      `SELECT active_generation_count::text AS active_generation_count
         FROM p2tr_signature_fraud_challenge_outbox_capacity
        WHERE singleton = true`
    )
    assert.equal(capacity.rows[0].active_generation_count, "1")
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
      `SELECT active_release_request_id AS active,
              unresolved_release_count AS unresolved
         FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
        WHERE chain_id = $1
          AND sender = decode($2, 'hex')`,
      [CHAIN_ID, WALLET.address.slice(2)]
    )
    assert.deepEqual(barrier.rows[0], { active: null, unresolved: 0 })

    await restartedClient.end()
    await database.client.end()
  }
)

postgresTest(
  "serializes recovery and signer I/O per chain and sender",
  async () => {
    const multiLanePolicy = feePolicy(MANIFEST_HASH, true)
    const database = await createTestDatabase(
      1_024,
      CHAIN_ID,
      signerConfiguration(MANIFEST_HASH, multiLanePolicy.policyHash)
    )
    try {
      await begin(database.client)
      await database.store.installSignerLaneConfiguration(
        secondarySignerConfiguration({ policyHash: multiLanePolicy.policyHash })
      )
      await commit(database.client)

      const primary = {
        ...outboxRecord(82),
        feePolicyManifest: multiLanePolicy,
      }
      await insertRecord(database, primary)
      const primaryReserved = await advanceToReservation(database, primary)
      const primaryVoided: P2TRSignatureFraudChallengeOutboxRecord = {
        ...primaryReserved,
        status: "queued",
        version: primaryReserved.version + 1,
        preparationLease: undefined,
        preparationSender: undefined,
        selectedLaneID: undefined,
        selectedSignerIdentity: undefined,
        reservedNonce: undefined,
        nonceReservedAtUnixMs: undefined,
        voidedNonceReservations: [
          {
            reservation: primaryReserved.reservedNonce!,
            voidedAtUnixMs: 1_300,
            reasonCode: "reservation-expired",
            reason: "primary lane recovery remains pending",
            evidenceDigest: `0x${"e1".repeat(32)}`,
          },
        ],
        updatedAtUnixMs: 1_300,
      }
      await begin(database.client)
      assert.equal(
        await database.store.compareAndSwap(
          primaryReserved.recordID,
          primaryReserved.version,
          primaryVoided
        ),
        true
      )
      await commit(database.client)

      const secondary = {
        ...outboxRecord(83),
        feePolicyManifest: multiLanePolicy,
      }
      await insertRecord(database, secondary)
      const secondarySelected: P2TRSignatureFraudChallengeOutboxRecord = {
        ...selectedRecord(secondary),
        preparationSender: SECONDARY_WALLET.address,
        selectedLaneID: "lane-b",
        selectedSignerIdentity: "signer-b",
      }
      const secondaryReserved: P2TRSignatureFraudChallengeOutboxRecord = {
        ...reservedRecord(secondarySelected),
        reservedNonce: {
          ...reservedRecord(secondarySelected).reservedNonce!,
          reservationID: Hex.from(`0x${"d2".repeat(32)}`),
          laneID: "lane-b",
          signerIdentity: "signer-b",
          sender: SECONDARY_WALLET.address,
        },
      }
      const secondaryBoundary = signerBoundaryRecord(secondaryReserved)
      await begin(database.client)
      assert.equal(
        await database.store.compareAndSwap(
          secondary.recordID,
          secondary.version,
          secondarySelected
        ),
        true
      )
      assert.equal(
        await database.store.compareAndSwap(
          secondarySelected.recordID,
          secondarySelected.version,
          secondaryReserved
        ),
        true
      )
      assert.equal(
        await database.store.compareAndSwap(
          secondaryReserved.recordID,
          secondaryReserved.version,
          secondaryBoundary
        ),
        true
      )
      await commit(database.client)

      assert.equal(
        await database.store.hasPendingNonceReleasesForLane(
          CHAIN_ID,
          WALLET.address
        ),
        true
      )
      assert.equal(
        await database.store.hasPendingNonceReleasesForLane(
          CHAIN_ID,
          SECONDARY_WALLET.address
        ),
        false
      )
      const barriers = await database.client.query<{
        sender: string
        active: number
        unresolved: number
      }>(
        `SELECT encode(sender, 'hex') AS sender,
                active_signer_invocation_count AS active,
                unresolved_release_count AS unresolved
           FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
          ORDER BY sender`
      )
      assert.deepEqual(barriers.rows, [
        {
          sender: WALLET.address.slice(2).toLowerCase(),
          active: 0,
          unresolved: 1,
        },
        {
          sender: SECONDARY_WALLET.address.slice(2).toLowerCase(),
          active: 1,
          unresolved: 0,
        },
      ].sort((left, right) => left.sender.localeCompare(right.sender)))

      const pending = await database.store.listPendingNonceReleases({
        limit: 10,
      })
      assert.equal(pending.requests.length, 1)
      const releaseAttempt = await database.store.claimNonceReleaseAttempt(
        pending.requests[0].releaseRequestID,
        "lane-isolation-worker",
        2_000,
        3_000
      )
      assert.ok(releaseAttempt)
      assert.equal(
        await database.store.beginNonceReleaseAttempt(releaseAttempt, 2_100),
        true
      )
      assert.equal(
        await database.store.recordNonceReleaseAttemptResult(releaseAttempt, {
          kind: "contract-mismatch",
          responseDigest: `0x${"e2".repeat(32)}`,
          returnedReleaseRequestID: pending.requests[0].releaseRequestID,
          returnedReservationID:
            secondaryReserved.reservedNonce!.reservationID.toPrefixedString(),
          detail: "allocator returned another sender's reservation",
          recordedAtUnixMs: 2_101,
        }),
        "ambiguous"
      )
      const blockedBarriers = await database.client.query<{
        sender: string
        blocked: boolean
      }>(
        `SELECT encode(sender, 'hex') AS sender,
                contract_mismatch_blocked AS blocked
           FROM p2tr_signature_fraud_nonce_allocator_safety_barrier
          ORDER BY sender`
      )
      assert.deepEqual(
        blockedBarriers.rows,
        [WALLET, SECONDARY_WALLET]
          .map((wallet) => ({
            sender: wallet.address.slice(2).toLowerCase(),
            blocked: true,
          }))
          .sort((left, right) => left.sender.localeCompare(right.sender))
      )
    } finally {
      await database.client.end()
    }
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
      // Lease expiry never proves the issued signer RPC stopped, so recovery
      // retains the active marker. Only the worker that observes the return
      // may clear it, and the capture below is that observation.
      activeSignerInvocationStartedAtUnixMs:
        signerBoundary.activeSignerInvocationStartedAtUnixMs,
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
  "persists recoverable bytes while retaining an uncorrelated signer boundary",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(53)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    const signerBoundary: P2TRSignatureFraudChallengeOutboxRecord = {
      ...reserved,
      version: reserved.version + 1,
      updatedAtUnixMs: 1_300,
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
    const reason =
      "signer response belongs to another request or invocation; active boundary retained"
    const quarantine = {
      laneID: LANE_ID,
      signerIdentity: SIGNER_IDENTITY,
      expectedSender: WALLET.address,
      expectedNonce: 7,
      reservationID:
        signerBoundary.reservedNonce!.reservationID.toPrefixedString(),
      reasonCode: "ambiguous-signer-invocation" as const,
      quarantinedAtUnixMs: 1_301,
      reason,
      detailsDigest: `0x${"f1".repeat(32)}`,
    }
    const retained: P2TRSignatureFraudChallengeOutboxRecord = {
      ...signerBoundary,
      version: signerBoundary.version + 1,
      signerInvocationStartedAtUnixMs: 1_300,
      signerQuarantines: [quarantine],
      unexpectedSignedArtifacts: [
        {
          preparedTransaction: {
            intentID: initial.intent.intentID,
            rawTransaction,
            transactionHash: Hex.from(utils.keccak256(rawTransaction)),
            sender: WALLET.address,
            nonce: 7,
            chainID: CHAIN_ID,
            to: initial.intent.routerAddress,
            calldata: initial.intent.calldata,
            value: initial.intent.value,
          },
          expectedReservationID:
            signerBoundary.reservedNonce!.reservationID.toPrefixedString(),
          capturedAtUnixMs: 1_301,
          reason,
        },
      ],
      updatedAtUnixMs: 1_301,
      lastError: reason,
    }
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        signerBoundary.recordID,
        signerBoundary.version,
        retained
      ),
      true
    )
    await commit(database.client)

    const durable = await database.store.get(initial.recordID)
    assert.equal(durable?.status, "preparing")
    assert.equal(durable?.activeSignerInvocationStartedAtUnixMs, 1_300)
    assert.equal(durable?.preparedTransactionVariants, undefined)
    assert.equal(durable?.unexpectedSignedArtifacts?.length, 1)
    const evidence = await database.client.query<{
      artifacts: string
      alerts: string
      quarantines: string
    }>(
      `SELECT
         (SELECT count(*)::text FROM p2tr_signature_fraud_challenge_late_signed_artifact) AS artifacts,
         (SELECT count(*)::text FROM p2tr_signature_fraud_challenge_critical_alert
           WHERE code = 'signed-state-quarantined') AS alerts,
         (SELECT count(*)::text FROM p2tr_signature_fraud_challenge_signer_quarantine) AS quarantines`
    )
    assert.deepEqual(evidence.rows[0], {
      artifacts: "1",
      alerts: "1",
      quarantines: "1",
    })
    await database.client.end()
  }
)

postgresTest("rejects incomplete type-2 late signed artifacts", async () => {
  const database = await createTestDatabase()
  const initial = outboxRecord(54)
  await insertRecord(database, initial)
  const reserved = await advanceToReservation(database, initial)
  const signerBoundary: P2TRSignatureFraudChallengeOutboxRecord = {
    ...reserved,
    version: reserved.version + 1,
    updatedAtUnixMs: 1_300,
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
  const calldataByteLength = utils.arrayify(initial.intent.calldata).length
  const rawTransactionByteLength = utils.arrayify(rawTransaction).length
  for (const feeEnvelope of [
    [null, "100", "10"],
    ["100000", null, "10"],
    ["100000", "100", null],
  ]) {
    await assert.rejects(
      database.client.query(
        `INSERT INTO p2tr_signature_fraud_challenge_late_signed_artifact (
              artifact_id, record_id, generation,
              expected_provenance_fingerprint, expected_reservation_id,
              chain_id, signer_lane_id, signer_identity, intent_id,
              to_address, calldata, transaction_value, raw_transaction,
              payload_omitted_for_size, calldata_byte_length,
              raw_transaction_byte_length,
              transaction_hash, sender, transaction_nonce,
              transaction_type, gas_limit, max_fee_per_gas,
              max_priority_fee_per_gas, captured_at_unix_ms, reason,
              reason_digest
           ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19,
              2, $20, $21, $22, $23, $24, $25
           )`,
        [
          hexBuffer(transactionHash),
          hexBuffer(initial.recordID),
          initial.generation,
          hexBuffer(initial.canonicalProvenance.provenanceFingerprint),
          hexBuffer(
            signerBoundary.reservedNonce!.reservationID.toPrefixedString()
          ),
          CHAIN_ID,
          LANE_ID,
          SIGNER_IDENTITY,
          hexBuffer(initial.intent.intentID.toPrefixedString()),
          hexBuffer(initial.intent.routerAddress),
          hexBuffer(initial.intent.calldata),
          initial.intent.value,
          hexBuffer(rawTransaction),
          false,
          calldataByteLength,
          rawTransactionByteLength,
          hexBuffer(transactionHash),
          hexBuffer(WALLET.address),
          7,
          ...feeEnvelope,
          1_301,
          "incomplete type-2 forensic artifact",
          hexBuffer(`0x${"f2".repeat(32)}`),
        ]
      ),
      /violates check constraint/
    )
  }
  const artifacts = await database.client.query<{ count: string }>(
    `SELECT count(*)::text AS count
         FROM p2tr_signature_fraud_challenge_late_signed_artifact`
  )
  assert.equal(artifacts.rows[0].count, "0")
  await database.client.end()
})

postgresTest(
  "rejects an under-gassed signed variant in the PostgreSQL trigger",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(59)
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

    const rawTransaction = await WALLET.signTransaction({
      type: 2,
      chainId: CHAIN_ID,
      to: initial.intent.routerAddress,
      data: initial.intent.calldata,
      value: initial.intent.value,
      nonce: 7,
      gasLimit: 999_999,
      maxFeePerGas: 100,
      maxPriorityFeePerGas: 10,
    })
    const preparedTransaction = {
      intentID: initial.intent.intentID,
      rawTransaction,
      transactionHash: Hex.from(utils.keccak256(rawTransaction)),
      sender: WALLET.address,
      nonce: 7,
    }
    const prepared: P2TRSignatureFraudChallengeOutboxRecord = {
      ...signerBoundary,
      status: "prepared",
      version: signerBoundary.version + 1,
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

    await begin(database.client)
    await assert.rejects(
      database.store.compareAndSwap(
        signerBoundary.recordID,
        signerBoundary.version,
        prepared
      ),
      /signed variant does not match its manifest-bound fee or value policy/
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
      gasLimit: 1_000_000,
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
  "keeps a manifest-bound full outbox activation-ready while enqueue backpressure remains",
  async () => {
    const database = await createTestDatabase(1)
    await insertRecord(database, outboxRecord(9))

    await beginSerializable(database.client)
    const response = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)

    assert.equal(response.payload.state.activeGenerationCount, 1)
    assert.equal(response.payload.state.healthy, true)
    assert.equal(response.payload.state.activationBlocked, false)
    assert.deepEqual(response.payload.state.activationBlockingReasons, [])
    assert.doesNotThrow(() =>
      assertP2TRProductionOutboxHandshake(response.payload.state, {
        ...outboxManifest(response.payload.state.schemaConstraintHash),
        maxActiveOutboxRecords: 1,
      })
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
  "retires legacy deposit intents, including rows missed by migration 005",
  async () => {
    const database = await createTestDatabase(
      1_024,
      CHAIN_ID,
      signerConfiguration(),
      4
    )
    const queuedRecord = depositBoundOutboxRecord(236)
    const reversiblePreparation = depositBoundOutboxRecord(237)
    await insertRecord(database, queuedRecord)
    await insertRecord(database, reversiblePreparation)
    await begin(database.client)
    assert.equal(
      await database.store.compareAndSwap(
        reversiblePreparation.recordID,
        reversiblePreparation.version,
        selectedRecord(reversiblePreparation)
      ),
      true
    )
    await commit(database.client)

    // Make both v4 deposit hashes legacy display-order values without
    // manufacturing replacement signed intents.
    await database.client.query("SET session_replication_role = replica")
    for (const record of [queuedRecord, reversiblePreparation]) {
      await database.client.query(
        `UPDATE p2tr_signature_fraud_challenge_outbox
            SET binding_tx_hash = decode($2, 'hex')
          WHERE record_id = decode($1, 'hex')`,
        [
          record.recordID.slice(2),
          record.canonicalProvenance.fundingTxid.slice(2),
        ]
      )
    }
    await database.client.query("SET session_replication_role = origin")
    const migration = await readFile(
      new URL(
        "../migrations/005_p2tr_deposit_binding_byte_order.sql",
        import.meta.url
      ),
      "utf8"
    )
    await database.client.query(`BEGIN;\n${migration}\nCOMMIT;`)

    const durable = await database.client.query<{
      record_id: string
      binding_tx_hash: string
      canonical_funding_txid: string
      status: string
      legacy_marker: boolean
    }>(
      `SELECT encode(record_id, 'hex') AS record_id,
              encode(binding_tx_hash, 'hex') AS binding_tx_hash,
              encode(canonical_funding_txid, 'hex')
                AS canonical_funding_txid,
              status,
              legacy_deposit_binding_byte_order AS legacy_marker
         FROM p2tr_signature_fraud_challenge_outbox
        WHERE record_id IN (decode($1, 'hex'), decode($2, 'hex'))
        ORDER BY record_id`,
      [queuedRecord.recordID.slice(2), reversiblePreparation.recordID.slice(2)]
    )
    const byID = new Map(durable.rows.map((row) => [row.record_id, row]))
    for (const record of [queuedRecord, reversiblePreparation]) {
      const row = byID.get(record.recordID.slice(2))!
      assert.equal(row.binding_tx_hash, row.canonical_funding_txid)
      assert.equal(row.status, "cancelled-before-broadcast")
      assert.equal(row.legacy_marker, true)
    }
    const migrationState = await database.client.query<{
      quarantine_count: string
      constraint_validated: boolean
      active_generation_count: string
    }>(
      `SELECT (SELECT count(*)::text
                 FROM p2tr_signature_fraud_legacy_submission_quarantine
                WHERE reason LIKE 'legacy outbox intent uses display-order%')
                  AS quarantine_count,
              constraint_record.convalidated AS constraint_validated,
              capacity.active_generation_count::text
                  AS active_generation_count
         FROM pg_constraint constraint_record
         CROSS JOIN p2tr_signature_fraud_challenge_outbox_capacity capacity
        WHERE constraint_record.conrelid =
                'p2tr_signature_fraud_challenge_outbox'::regclass
          AND constraint_record.conname =
                'p2tr_outbox_deposit_binding_uses_bridge_byte_order'
          AND capacity.singleton = true`
    )
    assert.equal(migrationState.rows[0].quarantine_count, "0")
    assert.equal(migrationState.rows[0].constraint_validated, true)
    assert.equal(migrationState.rows[0].active_generation_count, "0")

    // Reconstruct the state an old migration runner could leave when an
    // already-authorized enqueue committed after migration 005's snapshot.
    const missedRecord = depositBoundOutboxRecord(239)
    await insertRecord(database, missedRecord)
    await database.client.query(
      `ALTER TABLE p2tr_signature_fraud_challenge_outbox
         DROP CONSTRAINT p2tr_outbox_deposit_binding_uses_bridge_byte_order`
    )
    await database.client.query("SET session_replication_role = replica")
    await database.client.query(
      `UPDATE p2tr_signature_fraud_challenge_outbox
          SET binding_tx_hash = decode($2, 'hex')
        WHERE record_id = decode($1, 'hex')`,
      [
        missedRecord.recordID.slice(2),
        missedRecord.canonicalProvenance.fundingTxid.slice(2),
      ]
    )
    await database.client.query("SET session_replication_role = origin")
    await database.client.query(
      `ALTER TABLE p2tr_signature_fraud_challenge_outbox
         ADD CONSTRAINT p2tr_outbox_deposit_binding_uses_bridge_byte_order
         CHECK (
           legacy_deposit_binding_byte_order OR
           canonical_input_binding_kind <> 'deposit-binding' OR
           binding_tx_hash = p2tr_reverse_bytea(canonical_funding_txid)
         ) NOT VALID`
    )

    const fenceRepairMigration = await readFile(
      new URL(
        "../migrations/006_p2tr_candidate_enqueue_generation_authority.sql",
        import.meta.url
      ),
      "utf8"
    )
    await database.client.query(`BEGIN;\n${fenceRepairMigration}\nCOMMIT;`)
    const repairedMiss = await database.client.query<{
      status: string
      legacy_marker: boolean
      constraint_validated: boolean
      active_generation_count: string
    }>(
      `SELECT outbox.status,
              outbox.legacy_deposit_binding_byte_order AS legacy_marker,
              constraint_record.convalidated AS constraint_validated,
              capacity.active_generation_count::text
                AS active_generation_count
         FROM p2tr_signature_fraud_challenge_outbox outbox
         CROSS JOIN pg_constraint constraint_record
         CROSS JOIN p2tr_signature_fraud_challenge_outbox_capacity capacity
        WHERE outbox.record_id = decode($1, 'hex')
          AND constraint_record.conrelid =
                'p2tr_signature_fraud_challenge_outbox'::regclass
          AND constraint_record.conname =
                'p2tr_outbox_deposit_binding_uses_bridge_byte_order'
          AND capacity.singleton = true`,
      [missedRecord.recordID.slice(2)]
    )
    assert.deepEqual(repairedMiss.rows, [
      {
        status: "cancelled-before-broadcast",
        legacy_marker: true,
        constraint_validated: true,
        active_generation_count: "0",
      },
    ])

    await beginSerializable(database.client)
    const activation = await activationProvider(
      database.client,
      () => 5_000
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(activation.payload.state.unresolvedLegacyQuarantineCount, 0)
    assert.equal(activation.payload.state.healthy, true)

    await assert.rejects(
      database.client.query(
        `UPDATE p2tr_signature_fraud_challenge_outbox
            SET legacy_deposit_binding_byte_order = false
          WHERE record_id = decode($1, 'hex')`,
        [queuedRecord.recordID.slice(2)]
      ),
      /marker is migration-owned and immutable/
    )
    await database.client.end()
  }
)

postgresTest(
  "derives candidate series from the immutable COMPLETE domain instead of the live chain",
  async () => {
    const domainChainID = 1
    const database = await createTestDatabase(1_024, domainChainID)
    try {
      const occurrenceID = `0x${"f0".repeat(32)}`
      const record = sdkObservedOutboxRecord(239, occurrenceID)
      const expectedSeriesID = computeP2TRSignatureFraudOutboxSeriesID({
        ...record.intent,
        domainChainID,
      })
      const result = await database.client.query<{ series_id: string }>(
        `SELECT encode(p2tr_candidate_enqueue_series_id(
                    decode($1, 'hex'), decode($2, 'hex'),
                    decode($3, 'hex'), $4, decode($5, 'hex'), $6,
                    decode($7, 'hex'), $8
                ), 'hex') AS series_id`,
        [
          MANIFEST_HASH.slice(2),
          occurrenceID.slice(2),
          record.intent.bridgeChallengeKey.toPrefixedString().slice(2),
          record.intent.inputIndex,
          record.canonicalProvenance.inputOutputKey.slice(2),
          record.canonicalProvenance.inputBindingKind,
          record.canonicalProvenance.fundingTxid.slice(2),
          record.canonicalProvenance.fundingVout,
        ]
      )

      assert.equal(result.rows[0].series_id, expectedSeriesID.slice(2))
    } finally {
      await database.client.end()
    }
  }
)

postgresTest(
  "blocks a generation-required record stranded by a rotated-out manifest",
  async () => {
    const database = await createTestDatabase()
    const initialRecord = outboxRecord(240)
    const record = {
      ...initialRecord,
      seriesID: computeP2TRSignatureFraudOutboxSeriesID(initialRecord.intent),
    }
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

    type CandidateAuthority = {
      expected_series_id: Buffer
      expected_generation: number
      expected_disposition: string
      expected_predecessor_id: Buffer | null
      expected_evidence_id: Buffer | null
    }
    const readAuthority = async (): Promise<CandidateAuthority> =>
      (
        await database.client.query<CandidateAuthority>(
          `SELECT *
             FROM p2tr_candidate_enqueue_expected_authority(
               decode($1, 'hex'), decode($2, 'hex'), decode($3, 'hex'),
               decode($4, 'hex'), decode($5, 'hex'), $6,
               decode($7, 'hex'), $8, decode($9, 'hex'), $10
             )`,
          [
            record.canonicalProvenance.manifestHash.slice(2),
            record.intent.observationID.toPrefixedString().slice(2),
            record.intent.bridgeChallengeKey.toPrefixedString().slice(2),
            record.evidenceCheckpoint.bitcoinTxHash.slice(2),
            record.evidenceCheckpoint.bitcoinWitnessTxHash.slice(2),
            record.evidenceCheckpoint.bitcoinInputIndex,
            record.canonicalProvenance.inputOutputKey.slice(2),
            record.canonicalProvenance.inputBindingKind,
            record.canonicalProvenance.fundingTxid.slice(2),
            record.canonicalProvenance.fundingVout,
          ]
        )
      ).rows[0]
    const successorAuthority = await readAuthority()
    assert.equal(
      successorAuthority.expected_series_id.toString("hex"),
      record.seriesID.slice(2)
    )
    assert.equal(successorAuthority.expected_generation, 1)
    assert.equal(
      successorAuthority.expected_disposition,
      "nonce-disposition"
    )
    assert.equal(
      successorAuthority.expected_predecessor_id?.toString("hex"),
      record.recordID.slice(2)
    )
    assert.equal(
      successorAuthority.expected_evidence_id?.toString("hex"),
      "e9".repeat(32)
    )

    await database.client.query("SET session_replication_role = replica")
    await database.client.query(
      `UPDATE p2tr_watchtower_activation_manifest
          SET payload = jsonb_set(
                payload,
                '{outbox,routerAddress}',
                to_jsonb($1::text)
              )
        WHERE singleton = true`,
      [`0x${"d5".repeat(20)}`]
    )
    await database.client.query("SET session_replication_role = origin")
    const routerRotatedAuthority = await readAuthority()
    assert.notEqual(
      routerRotatedAuthority.expected_series_id.toString("hex"),
      record.seriesID.slice(2)
    )
    assert.equal(routerRotatedAuthority.expected_generation, 0)
    assert.equal(routerRotatedAuthority.expected_disposition, "initial")
    assert.equal(routerRotatedAuthority.expected_predecessor_id, null)
    assert.equal(routerRotatedAuthority.expected_evidence_id, null)
    await database.client.query("SET session_replication_role = replica")
    await database.client.query(
      `UPDATE p2tr_watchtower_activation_manifest
          SET payload = jsonb_set(
                payload,
                '{outbox,routerAddress}',
                to_jsonb($1::text)
              )
        WHERE singleton = true`,
      [ROUTER_ADDRESS]
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
    await beginSerializable(database.client)
    const wrongChain = await activationProvider(
      database.client,
      () => 5_000,
      MANIFEST_HASH,
      undefined,
      [boundSenderLane({ chainID: CHAIN_ID + 1 })]
    ).attestActivationChallenge(activationRequest)
    await commit(database.client)
    assert.equal(wrongChain.payload.state.laneConfigurationMismatchCount, 0)
    assert.deepEqual(
      wrongChain.payload.state.senderLanes.map((lane) => lane.healthy),
      [false]
    )
    assert.ok(
      wrongChain.payload.state.activationBlockingReasons.includes(
        "manifest-bound-signer-lane-mismatch"
      )
    )
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
      activeGenerationCount: 0,
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

    // Ordinary enqueue activity can commit after the provider signs and before
    // the readiness transaction acquires its exclusive fence. Capacity is
    // enforced by the INSERT trigger, so this drift is not a readiness blocker.
    await insertRecord(database, outboxRecord(184))
    await beginSerializable(database.client)
    const activeGenerationMoved = await revalidate(5_500)
    await commit(database.client)
    assert.equal(activeGenerationMoved.activeGenerationCount, 1)
    assert.doesNotThrow(() =>
      assertP2TRProductionOutboxRevalidation(
        activeGenerationMoved,
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
  "changes the signed schema hash when trigger state or constraint helpers drift",
  async () => {
    const database = await createTestDatabase()
    const attestSchema = async (nowUnixMs: number) => {
      await beginSerializable(database.client)
      const response = await activationProvider(
        database.client,
        () => nowUnixMs
      ).attestActivationChallenge(activationRequest)
      await commit(database.client)
      return response.payload.state.schemaConstraintHash
    }
    const baseline = await attestSchema(5_000)

    await database.client.query(
      `ALTER TABLE p2tr_signature_fraud_challenge_critical_alert
         DISABLE TRIGGER p2tr_signature_fraud_reject_critical_alert_mutation_trigger`
    )
    const disabledTrigger = await attestSchema(5_001)
    assert.notEqual(disabledTrigger, baseline)
    await database.client.query(
      `ALTER TABLE p2tr_signature_fraud_challenge_critical_alert
         ENABLE TRIGGER p2tr_signature_fraud_reject_critical_alert_mutation_trigger`
    )

    await database.client.query(
      `ALTER TABLE p2tr_candidate_enqueue_transaction_guard
         DISABLE TRIGGER p2tr_candidate_enqueue_transaction_guard_immutable_trigger`
    )
    const disabledEnqueueJournalTrigger = await attestSchema(5_002)
    assert.notEqual(disabledEnqueueJournalTrigger, baseline)
    await database.client.query(
      `ALTER TABLE p2tr_candidate_enqueue_transaction_guard
         ENABLE TRIGGER p2tr_candidate_enqueue_transaction_guard_immutable_trigger`
    )

    await database.client.query(
      `CREATE OR REPLACE FUNCTION p2tr_reverse_bytea(value bytea)
       RETURNS bytea
       LANGUAGE sql
       IMMUTABLE
       STRICT
       PARALLEL SAFE
       AS $$ SELECT value $$`
    )
    const driftedHelper = await attestSchema(5_003)
    assert.notEqual(driftedHelper, baseline)
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
  "rotates policy manifests atomically, invalidates readiness, and ignores historical lanes",
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
    await commit(database.client)
    await database.client.query(
      `INSERT INTO p2tr_readiness_certificates (
          certificate_id, certificate_generation, manifest_hash,
          manifest_activation_sequence, primary_bitcoin_generation,
          primary_bitcoin_root, primary_bitcoin_semantic_root,
          bitcoin_height, bitcoin_hash, ethereum_journal_generation,
          ethereum_history_root, ethereum_block_number, ethereum_block_hash,
          provider_read_set_hash, payload
       ) VALUES ($1, 1, $2, 1, 1, $3, $4, $5, $6, 1, $7, $8, $9, $10, '{}'::jsonb)`,
      [
        hexBuffer(initial.canonicalProvenance.readinessCertificateID),
        hexBuffer(MANIFEST_HASH),
        hexBuffer(initial.canonicalProvenance.historyRoot),
        hexBuffer(initial.canonicalProvenance.eventSetHash),
        initial.evidenceCheckpoint.bitcoinCursorBlockHeight,
        hexBuffer(initial.evidenceCheckpoint.bitcoinCursorBlockHash),
        hexBuffer(initial.canonicalProvenance.historyRoot),
        initial.canonicalProvenance.throughBlockNumber,
        hexBuffer(initial.canonicalProvenance.throughBlockHash),
        hexBuffer(initial.canonicalProvenance.provenanceFingerprint),
      ]
    )
    await begin(database.client)
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
    const readiness = await database.client.query<{
      is_current: boolean
      invalidated: boolean
    }>(
      `SELECT is_current, invalidated_at IS NOT NULL AS invalidated
         FROM p2tr_readiness_certificates
        WHERE certificate_id = $1`,
      [hexBuffer(initial.canonicalProvenance.readinessCertificateID)]
    )
    assert.equal(rotated?.status, "cancelled-provenance-invalidated")
    assert.deepEqual(readiness.rows, [{ is_current: false, invalidated: true }])
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
    signerInvocationStartedAtUnixMs:
      current.signerInvocationStartedAtUnixMs ??
      current.activeSignerInvocationStartedAtUnixMs,
    updatedAtUnixMs: now,
    lastError: "signer invocation failed after the canonical invalidation CAS",
  }
}

async function rotateActivationManifest(
  database: TestDatabase,
  manifestHash: string,
  maxActiveOutboxRecords = 1_024
): Promise<void> {
  await begin(database.client)
  await database.client.query(
    `UPDATE p2tr_watchtower_activation_manifest
        SET activation_sequence = 2,
            manifest_hash = decode($1, 'hex'),
            payload = jsonb_build_object(
              'sequence', 2,
              'outbox', jsonb_build_object(
                'maxActiveOutboxRecords', $2::integer
              )
            ),
            envelope = '{"sequence":2}'::jsonb
      WHERE singleton`,
    [manifestHash.slice(2), maxActiveOutboxRecords]
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
            signer_invocation_started_at_unix_ms = coalesce(
                signer_invocation_started_at_unix_ms,
                active_signer_invocation_started_at_unix_ms
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
  chainID?: number | null
  to?: string
  calldata?: string
  value?: string
  transactionType?: 0 | 1 | 2 | 4
  maxFeePerGas?: number
  includeAccessList?: boolean
  reason?: string
  capturedAtUnixMs: number
  quarantine?: P2TRSignatureFraudSignerQuarantine
  signer?: Wallet
}

type EscapedCaptureOutcome = {
  results: string[]
  alertCodes: string[]
  transactionTypes: number[]
  envelopes: Array<{
    transactionHash: string
    chainID: number
    to?: string
    calldata: string
    value: string
    sender: string
    nonce: number
  }>
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
  configureSecondaryLane?: boolean
}

async function escapedCaptureArtifact(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  request: EscapedCaptureRequest
) {
  const signer = request.signer ?? WALLET
  const nonce = request.nonce ?? 7
  const transactionType = request.transactionType ?? 2
  const rawTransaction =
    transactionType === 4
      ? signEscapedEIP7702Transaction(record, request, signer, nonce)
      : await signer.signTransaction({
          ...(transactionType === 0 ? {} : { type: transactionType }),
          ...(request.chainID === null
            ? {}
            : { chainId: request.chainID ?? CHAIN_ID }),
          to: request.to ?? record.intent.routerAddress,
          data: request.calldata ?? record.intent.calldata,
          value: BigNumber.from(request.value ?? record.intent.value),
          nonce,
          gasLimit: 100_000,
          ...(transactionType === 2
            ? {
                maxFeePerGas: request.maxFeePerGas ?? 100,
                maxPriorityFeePerGas: 10,
                ...(request.includeAccessList
                  ? {
                      accessList: [
                        { address: signer.address, storageKeys: [] },
                      ],
                    }
                  : {}),
              }
            : { gasPrice: 100 }),
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
      sender: request.sender ?? signer.address,
      nonce,
    },
  }
}

function signEscapedEIP7702Transaction(
  record: P2TRSignatureFraudChallengeOutboxRecord,
  request: EscapedCaptureRequest,
  signer: Wallet,
  nonce: number
): string {
  if (request.chainID === null) {
    throw new Error("EIP-7702 test transactions require a chain ID")
  }
  const quantity = (value: string | number): string => {
    const numeric = BigNumber.from(value)
    return numeric.isZero()
      ? "0x"
      : utils.hexlify(utils.stripZeros(utils.arrayify(numeric)))
  }
  const chainID = request.chainID ?? CHAIN_ID
  const destination = request.to ?? record.intent.routerAddress
  const authorizationUnsigned = [
    quantity(chainID),
    destination,
    quantity(0),
  ]
  const authorizationSignature = new Wallet(`0x${"44".repeat(32)}`)
    ._signingKey()
    .signDigest(
      utils.keccak256(
        utils.concat(["0x05", utils.RLP.encode(authorizationUnsigned)])
      )
    )
  const unsigned = [
    quantity(chainID),
    quantity(nonce),
    quantity(10),
    quantity(request.maxFeePerGas ?? 100),
    quantity(100_000),
    destination,
    quantity(request.value ?? record.intent.value),
    request.calldata ?? record.intent.calldata,
    [],
    [
      [
        ...authorizationUnsigned,
        quantity(authorizationSignature.recoveryParam),
        utils.hexlify(
          utils.stripZeros(utils.arrayify(authorizationSignature.r))
        ),
        utils.hexlify(
          utils.stripZeros(utils.arrayify(authorizationSignature.s))
        ),
      ],
    ],
  ]
  const signature = signer
    ._signingKey()
    .signDigest(
      utils.keccak256(utils.concat(["0x04", utils.RLP.encode(unsigned)]))
    )
  return utils.hexConcat([
    "0x04",
    utils.RLP.encode([
      ...unsigned,
      quantity(signature.recoveryParam),
      utils.hexlify(utils.stripZeros(utils.arrayify(signature.r))),
      utils.hexlify(utils.stripZeros(utils.arrayify(signature.s))),
    ]),
  ])
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
    if (scenario.configureSecondaryLane) {
      await begin(database.client)
      await database.store.installSignerLaneConfiguration(
        secondarySignerConfiguration()
      )
      await commit(database.client)
    }
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
    const transactionTypes = await database.client.query<{
      transaction_type: number
    }>(
      `SELECT transaction_type
         FROM p2tr_signature_fraud_challenge_late_signed_artifact
        UNION ALL
       SELECT transaction_type
         FROM p2tr_signature_fraud_challenge_escaped_envelope
        ORDER BY transaction_type`
    )
    const envelopes = await database.client.query<{
      transaction_hash: string
      chain_id: string
      to_address: string | null
      calldata: string
      transaction_value: string
      sender: string
      transaction_nonce: string
    }>(
      `SELECT encode(transaction_hash, 'hex') AS transaction_hash,
              chain_id::text AS chain_id,
              encode(to_address, 'hex') AS to_address,
              encode(calldata, 'hex') AS calldata,
              transaction_value::text AS transaction_value,
              encode(sender, 'hex') AS sender,
              transaction_nonce::text AS transaction_nonce
         FROM p2tr_signature_fraud_challenge_late_signed_artifact
        UNION ALL
       SELECT encode(transaction_hash, 'hex') AS transaction_hash,
              actual_chain_id::text AS chain_id,
              encode(to_address, 'hex') AS to_address,
              encode(calldata, 'hex') AS calldata,
              transaction_value::text AS transaction_value,
              encode(actual_sender, 'hex') AS sender,
              actual_nonce::text AS transaction_nonce
         FROM p2tr_signature_fraud_challenge_escaped_envelope
        ORDER BY transaction_hash`
    )
    return {
      results,
      alertCodes: alerts.rows.map((row) => row.code),
      transactionTypes: transactionTypes.rows.map(
        ({ transaction_type }) => transaction_type
      ),
      envelopes: envelopes.rows.map((row) => ({
        transactionHash: `0x${row.transaction_hash}`,
        chainID: Number(row.chain_id),
        to: row.to_address === null ? undefined : `0x${row.to_address}`,
        calldata: `0x${row.calldata}`,
        value: row.transaction_value,
        sender: `0x${row.sender}`,
        nonce: Number(row.transaction_nonce),
      })),
    }
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
    transactionTypes: (
      (await store.get(initial.recordID))?.unexpectedSignedArtifacts ?? []
    )
      .map(({ preparedTransaction }) =>
        getP2TRSignatureFraudPreparedTransactionType(
          preparedTransaction.rawTransaction
        )
      )
      .sort(),
    envelopes: (
      (await store.get(initial.recordID))?.unexpectedSignedArtifacts ?? []
    )
      .map(({ preparedTransaction }) => ({
        transactionHash: preparedTransaction.transactionHash
          .toPrefixedString()
          .toLowerCase(),
        chainID: preparedTransaction.chainID!,
        to: preparedTransaction.to?.toLowerCase(),
        calldata: preparedTransaction.calldata!,
        value: preparedTransaction.value!,
        sender: preparedTransaction.sender.toLowerCase(),
        nonce: preparedTransaction.nonce,
      }))
      .sort((left, right) =>
        left.transactionHash.localeCompare(right.transactionHash)
      ),
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
    gasLimit: 1_000_000,
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
  const claimed: P2TRSignatureFraudChallengeOutboxRecord = {
    ...prepared,
    status: "preparing",
    version: prepared.version + 1,
    preparationAttempts: prepared.preparationAttempts + 1,
    preparationLease: {
      owner: "worker.replacement.integration",
      expiresAtUnixMs: 10_000,
    },
    preparationResumeStatus: "prepared",
    updatedAtUnixMs: 1_450,
  }
  return [
    boundary,
    prepared,
    claimed,
    {
      ...claimed,
      version: claimed.version + 1,
      updatedAtUnixMs: 1_500,
      activeSignerInvocationStartedAtUnixMs: 1_500,
    },
  ]
}

/**
 * Wrong-lane quarantine evidence bound to the durable nonce guard the signer
 * was supposed to use.
 */
function wrongLaneQuarantine(
  reasonCode: "wrong-chain" | "wrong-sender" | "wrong-nonce" = "wrong-nonce"
): P2TRSignatureFraudSignerQuarantine {
  return {
    laneID: LANE_ID,
    signerIdentity: SIGNER_IDENTITY,
    expectedSender: WALLET.address,
    expectedNonce: 7,
    reservationID: `0x${"d1".repeat(32)}`,
    reasonCode,
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
    name: "captures an expected-lane policy-invalid legacy artifact",
    seed: 69,
    boundary: signerBoundaryOnly,
    captures: [{ capturedAtUnixMs: 2_100, transactionType: 0 }],
  },
  {
    name: "captures an expected-lane policy-invalid type-1 artifact",
    seed: 70,
    boundary: signerBoundaryOnly,
    captures: [{ capturedAtUnixMs: 2_100, transactionType: 1 }],
  },
  {
    name: "captures an expected-lane policy-invalid EIP-7702 artifact",
    seed: 79,
    boundary: signerBoundaryOnly,
    captures: [{ capturedAtUnixMs: 2_100, transactionType: 4 }],
  },
  {
    name: "captures an expected-lane type-2 artifact above fee policy",
    seed: 71,
    boundary: signerBoundaryOnly,
    captures: [{ capturedAtUnixMs: 2_100, maxFeePerGas: 101 }],
  },
  {
    name: "captures an expected-lane type-2 artifact with an access list",
    seed: 72,
    boundary: signerBoundaryOnly,
    captures: [{ capturedAtUnixMs: 2_100, includeAccessList: true }],
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
    name: "captures and guards a signed envelope on its actual chain",
    seed: 73,
    boundary: replacementSignerBoundary,
    captures: [
      {
        capturedAtUnixMs: 2_100,
        chainID: CHAIN_ID + 1,
        quarantine: wrongLaneQuarantine("wrong-chain"),
      },
    ],
  },
  {
    name: "captures a wrong sender through its configured actual lane",
    seed: 75,
    boundary: replacementSignerBoundary,
    configureSecondaryLane: true,
    captures: [
      {
        capturedAtUnixMs: 2_100,
        signer: SECONDARY_WALLET,
        quarantine: wrongLaneQuarantine("wrong-sender"),
      },
    ],
  },
  {
    name: "captures an expected-lane envelope with unexpected call and value",
    seed: 74,
    boundary: signerBoundaryOnly,
    captures: [
      {
        capturedAtUnixMs: 2_100,
        to: "0x3333333333333333333333333333333333333333",
        calldata: "0x1234",
        value: "1235",
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
      assert.deepEqual(memory.transactionTypes, durable.transactionTypes)
      assert.deepEqual(memory.envelopes, durable.envelopes)
    }
  )
}

postgresTest(
  "retains guard and quarantine metadata for an oversized escaped envelope",
  async () => {
    const database = await createTestDatabase()
    try {
      const initial = outboxRecord(80)
      await insertRecord(database, initial)
      const reserved = await advanceToReservation(database, initial)
      let current = reserved
      for (const transition of await replacementSignerBoundary(reserved)) {
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
      const artifact = await escapedCaptureArtifact(current, {
        capturedAtUnixMs: 2_100,
        nonce: 8,
        calldata: `0x${"ab".repeat(4_100)}`,
        quarantine: wrongLaneQuarantine(),
      })
      assert.ok(
        utils.arrayify(artifact.preparedTransaction.rawTransaction).length >
          4_096
      )

      const captured = await managed.captureEscapedSignedArtifact(
        initial.recordID,
        initial.canonicalProvenance.provenanceFingerprint,
        artifact,
        wrongLaneQuarantine()
      )
      assert.equal(captured.activeSignerInvocationStartedAtUnixMs, undefined)
      assert.equal(captured.unexpectedSignedArtifacts?.length ?? 0, 0)
      assert.equal(captured.signerQuarantines?.length, 1)

      const retained = await database.client.query<{
        payload_omitted_for_size: boolean
        calldata: Buffer | null
        raw_transaction: Buffer | null
        calldata_byte_length: string
        raw_transaction_byte_length: string
        transaction_hash: string
        actual_sender: string
        actual_nonce: string
        guard_sender: string
        guard_nonce: string
        quarantine_reason: string
      }>(
        `SELECT envelope.payload_omitted_for_size,
                envelope.calldata,
                envelope.raw_transaction,
                envelope.calldata_byte_length::text,
                envelope.raw_transaction_byte_length::text,
                encode(envelope.transaction_hash, 'hex') AS transaction_hash,
                encode(envelope.actual_sender, 'hex') AS actual_sender,
                envelope.actual_nonce::text AS actual_nonce,
                encode(guard.sender, 'hex') AS guard_sender,
                guard.transaction_nonce::text AS guard_nonce,
                quarantine.quarantine_reason
           FROM p2tr_signature_fraud_challenge_escaped_envelope envelope
           JOIN p2tr_signature_fraud_challenge_nonce_guard guard
             ON guard.record_id = envelope.actual_guard_record_id
            AND guard.nonce_guard_id = envelope.actual_nonce_guard_id
           JOIN p2tr_signature_fraud_challenge_signer_quarantine quarantine
             ON quarantine.record_id = envelope.record_id
            AND quarantine.signer_quarantine_id =
                  envelope.signer_quarantine_id
          WHERE envelope.record_id = decode($1, 'hex')`,
        [initial.recordID.slice(2)]
      )
      assert.deepEqual(retained.rows, [
        {
          payload_omitted_for_size: true,
          calldata: null,
          raw_transaction: null,
          calldata_byte_length: "4100",
          raw_transaction_byte_length: String(
            utils.arrayify(artifact.preparedTransaction.rawTransaction).length
          ),
          transaction_hash: artifact.preparedTransaction.transactionHash
            .toPrefixedString()
            .slice(2),
          actual_sender: WALLET.address.slice(2).toLowerCase(),
          actual_nonce: "8",
          guard_sender: WALLET.address.slice(2).toLowerCase(),
          guard_nonce: "8",
          quarantine_reason: "wrong-nonce",
        },
      ])

      const repeated = await managed.captureEscapedSignedArtifact(
        initial.recordID,
        initial.canonicalProvenance.provenanceFingerprint,
        artifact,
        wrongLaneQuarantine()
      )
      assert.equal(repeated.version, captured.version)
    } finally {
      await database.client.end()
    }
  }
)

postgresTest(
  "quarantines an oversized initial signer capture without an expiring lease",
  async () => {
    const database = await createTestDatabase()
    try {
      const initial = outboxRecord(81)
      await insertRecord(database, initial)
      const reserved = await advanceToReservation(database, initial)
      const boundary = signerBoundaryRecord(reserved)
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

      const artifact = await escapedCaptureArtifact(boundary, {
        capturedAtUnixMs: 2_100,
        nonce: 7,
        calldata: `0x${"ab".repeat(4_100)}`,
      })
      const captured = await createManagedStore(
        database.client,
        eligibilitySnapshotFor(initial)
      ).captureEscapedSignedArtifact(
        initial.recordID,
        initial.canonicalProvenance.provenanceFingerprint,
        artifact
      )

      assert.equal(captured.status, "quarantined")
      assert.equal(captured.preparationLease, undefined)
      assert.equal(captured.preparationResumeStatus, undefined)
      assert.equal(captured.activeSignerInvocationStartedAtUnixMs, undefined)
      assert.equal(captured.signerInvocationStartedAtUnixMs, 1_300)
      assert.equal(captured.unexpectedSignedArtifacts?.length ?? 0, 0)
      assert.equal(
        captured.signerQuarantines?.at(-1)?.reasonCode,
        "oversized-signed-envelope"
      )
      assert.equal(await database.store.hasExpiredPreparationLeases(50_000), false)
      assert.equal(
        (await database.store.get(initial.recordID))?.status,
        "quarantined"
      )
    } finally {
      await database.client.end()
    }
  }
)

postgresTest(
  "guards a chainless escaped signature on every configured sender chain",
  async () => {
    const database = await createTestDatabase()
    try {
      await begin(database.client)
      await database.store.installSignerLaneConfiguration(
        secondarySignerConfiguration()
      )
      await database.store.installSignerLaneConfiguration(
        secondarySignerConfiguration({
          chainID: CHAIN_ID + 1,
          laneID: "lane-b-secondary-chain",
          signerIdentity: "signer-b-secondary-chain",
          configuredAtUnixMs: 1_002,
        })
      )
      await commit(database.client)

      const initial = outboxRecord(76)
      await insertRecord(database, initial)
      const reserved = await advanceToReservation(database, initial)
      let current = reserved
      for (const transition of await replacementSignerBoundary(reserved)) {
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
      const artifact = await escapedCaptureArtifact(current, {
        capturedAtUnixMs: 2_100,
        transactionType: 0,
        chainID: null,
        signer: SECONDARY_WALLET,
        quarantine: wrongLaneQuarantine("wrong-chain"),
      })
      await managed.captureEscapedSignedArtifact(
        initial.recordID,
        initial.canonicalProvenance.provenanceFingerprint,
        artifact,
        wrongLaneQuarantine("wrong-chain")
      )

      const guards = await database.client.query<{ chain_id: string }>(
        `SELECT chain_id::text
           FROM p2tr_signature_fraud_challenge_nonce_guard
          WHERE sender = decode($1, 'hex')
            AND transaction_nonce = 7
            AND voided_before_sign_at_unix_ms IS NULL
          ORDER BY chain_id`,
        [SECONDARY_WALLET.address.slice(2)]
      )
      assert.deepEqual(
        guards.rows.map(({ chain_id }) => Number(chain_id)),
        [0, CHAIN_ID, CHAIN_ID + 1]
      )
      const replayGuards = await database.client.query<{ chain_id: string }>(
        `SELECT replay_chain_id::text AS chain_id
           FROM p2tr_signature_fraud_challenge_chainless_replay_guard
          ORDER BY replay_chain_id`
      )
      assert.deepEqual(
        replayGuards.rows.map(({ chain_id }) => Number(chain_id)),
        [CHAIN_ID, CHAIN_ID + 1]
      )
      await beginSerializable(database.client)
      const activation = await activationProvider(
        database.client,
        () => 5_000
      ).attestActivationChallenge(activationRequest)
      await commit(database.client)
      assert.equal(activation.payload.state.danglingNonceGuardCount, 0)
      const quarantines = await database.client.query<{
        chain_id: string
        reason: string
      }>(
        `SELECT chain_id::text, quarantine_reason AS reason
           FROM p2tr_signature_fraud_challenge_signer_quarantine
          WHERE expected_sender = decode($1, 'hex')
          ORDER BY chain_id`,
        [SECONDARY_WALLET.address.slice(2)]
      )
      assert.deepEqual(quarantines.rows, [
        { chain_id: String(CHAIN_ID), reason: "chainless-envelope" },
        { chain_id: String(CHAIN_ID + 1), reason: "chainless-envelope" },
      ])
      await begin(database.client)
      assert.equal(
        await database.store.isSignerQuarantined(CHAIN_ID, "signer-b"),
        true
      )
      assert.equal(
        await database.store.isSignerQuarantined(
          CHAIN_ID + 1,
          "signer-b-secondary-chain"
        ),
        true
      )
      await commit(database.client)
    } finally {
      await database.client.end()
    }
  }
)

postgresTest(
  "prevents voiding an unsigned reservation adopted by chainless signed evidence",
  async () => {
    const ownerFeePolicy = feePolicy(MANIFEST_HASH, true)
    const database = await createTestDatabase(
      1_024,
      CHAIN_ID,
      signerConfiguration(MANIFEST_HASH, ownerFeePolicy.policyHash)
    )
    try {
      await begin(database.client)
      await database.store.installSignerLaneConfiguration(
        secondarySignerConfiguration({ policyHash: ownerFeePolicy.policyHash })
      )
      await commit(database.client)

      const owner: P2TRSignatureFraudChallengeOutboxRecord = {
        ...outboxRecord(77),
        feePolicyManifest: ownerFeePolicy,
      }
      await insertRecord(database, owner)
      const ownerSelected: P2TRSignatureFraudChallengeOutboxRecord = {
        ...selectedRecord(owner),
        preparationSender: SECONDARY_WALLET.address,
        selectedLaneID: "lane-b",
        selectedSignerIdentity: "signer-b",
      }
      const baseOwnerReserved = reservedRecord(ownerSelected)
      const ownerReserved: P2TRSignatureFraudChallengeOutboxRecord = {
        ...baseOwnerReserved,
        reservedNonce: {
          ...baseOwnerReserved.reservedNonce!,
          reservationID: Hex.from(`0x${"d3".repeat(32)}`),
          laneID: "lane-b",
          signerIdentity: "signer-b",
          sender: SECONDARY_WALLET.address,
        },
      }
      await begin(database.client)
      assert.equal(
        await database.store.compareAndSwap(
          owner.recordID,
          owner.version,
          ownerSelected
        ),
        true
      )
      assert.equal(
        await database.store.compareAndSwap(
          ownerSelected.recordID,
          ownerSelected.version,
          ownerReserved
        ),
        true
      )
      await commit(database.client)

      const initial: P2TRSignatureFraudChallengeOutboxRecord = {
        ...outboxRecord(78),
        feePolicyManifest: ownerFeePolicy,
      }
      await insertRecord(database, initial)
      const reserved = await advanceToReservation(database, initial)
      let current = reserved
      for (const transition of await replacementSignerBoundary(reserved)) {
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
      const artifact = await escapedCaptureArtifact(current, {
        capturedAtUnixMs: 2_100,
        transactionType: 0,
        chainID: null,
        signer: SECONDARY_WALLET,
        quarantine: wrongLaneQuarantine("wrong-chain"),
      })
      await managed.captureEscapedSignedArtifact(
        initial.recordID,
        initial.canonicalProvenance.provenanceFingerprint,
        artifact,
        wrongLaneQuarantine("wrong-chain")
      )

      const adopted = await database.client.query<{
        record_id: string
        guard_id: string
      }>(
        `SELECT encode(nonce_guard_record_id, 'hex') AS record_id,
                encode(nonce_guard_id, 'hex') AS guard_id
           FROM p2tr_signature_fraud_challenge_chainless_replay_guard
          WHERE replay_chain_id = $1`,
        [CHAIN_ID]
      )
      assert.deepEqual(adopted.rows, [
        {
          record_id: owner.recordID.slice(2),
          guard_id:
            ownerReserved.reservedNonce!.reservationID
              .toPrefixedString()
              .slice(2),
        },
      ])

      await assert.rejects(
        database.client.query(
          `UPDATE p2tr_signature_fraud_challenge_nonce_guard
              SET voided_before_sign_at_unix_ms = $1,
                  void_reason = 'reservation-abandoned',
                  void_evidence_digest = decode($2, 'hex')
            WHERE nonce_guard_id = decode($3, 'hex')`,
          [
            2_200,
            "e7".repeat(32),
            ownerReserved.reservedNonce!.reservationID
              .toPrefixedString()
              .slice(2),
          ]
        ),
        /referenced by escaped signed bytes cannot be voided/
      )
    } finally {
      await database.client.end()
    }
  }
)

// ---------------------------------------------------------------------------
// Orphaned signer boundary resolution.
//
// `activeSignerInvocationStartedAtUnixMs` is committed BEFORE boundary
// authorization and therefore before the signer RPC. When the owning process
// dies mid-call nothing in the normal recovery path may clear that marker —
// lease expiry is not proof a remote call stopped — so the lane's
// `active_signer_invocation_count` stays at one and that sender's nonce I/O is
// blocked. These tests drive the out-of-band resolver that is the only way out.
// ---------------------------------------------------------------------------

const BOUNDARY_PROVIDER_DIGEST = `0x${"c7".repeat(32)}`
const BOUNDARY_TOMBSTONE_RECEIPT_DIGEST = `0x${"d8".repeat(32)}`
const BOUNDARY_SIGNED_HASH = `0x${"5a".repeat(32)}`

type BoundaryAttestationMode =
  | "independent"
  | "single"
  | "same-trust-domain"
  | "same-independence-domain"
  | "identical-attestation"

type BoundaryResolutionOverrides = {
  recordID?: string
  boundaryStartedAtUnixMs?: number
  preparationAttempts?: number
  nonceReservationID?: string
  stage?: "prepare" | "replacement"
  invokedAtUnixMs?: number
  outcome?: "never-invoked" | "signed" | "terminal-unsafe"
  signedTransactionHash?: string
  providerEvidenceDigest?: string
  providerTombstone?:
    | P2TRSignatureFraudIndependentSignerBoundaryResolution["providerTombstone"]
    | undefined
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
  overrides: BoundaryResolutionOverrides = {}
): P2TRSignatureFraudIndependentSignerBoundaryResolution {
  const outcome = overrides.outcome ?? "never-invoked"
  const invocationBinding = {
    recordID: overrides.recordID ?? record.recordID,
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
  }
  const binding = {
    ...invocationBinding,
    invokedAtUnixMs: overrides.invokedAtUnixMs ?? 1_310,
    outcome,
    signedTransactionHash:
      "signedTransactionHash" in overrides
        ? overrides.signedTransactionHash
        : outcome === "signed"
        ? BOUNDARY_SIGNED_HASH
        : undefined,
    providerTombstone:
      "providerTombstone" in overrides
        ? overrides.providerTombstone
        : outcome === "never-invoked"
        ? {
            invocationID:
              computeP2TRSignatureFraudSignerInvocationID(invocationBinding),
            tombstonedAtUnixMs: 1_900,
            receiptDigest: BOUNDARY_TOMBSTONE_RECEIPT_DIGEST,
          }
        : undefined,
    providerEvidenceDigest:
      overrides.providerEvidenceDigest ?? BOUNDARY_PROVIDER_DIGEST,
  }
  const evidenceDigest =
    overrides.evidenceDigest ??
    computeP2TRSignatureFraudSignerBoundaryResolutionEvidenceDigest(binding)
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

async function barrierSignerInvocationCount(
  database: TestDatabase
): Promise<number> {
  const result = await database.client.query<{ count: string }>(
    `SELECT coalesce(sum(active_signer_invocation_count), 0)::text AS count
       FROM p2tr_signature_fraud_nonce_allocator_safety_barrier`
  )
  return Number(result.rows[0].count)
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
  "clears an orphaned signer boundary and reopens its nonce-release lane",
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
    // which is what keeps this nonce lane closed rather than merely the record.
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
    // allocator: this sender's signer barrier is genuinely open again.
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
  "authenticates orphaned signer evidence before clearing its boundary",
  async () => {
    const database = await createTestDatabase()
    const { initial, boundary } = await orphanedSignerBoundary(database, 240)
    let authenticationCalls = 0
    const rejectingStore = createManagedStore(
      database.client,
      eligibilitySnapshotFor(initial),
      (record, resolution) => {
        authenticationCalls++
        assert.equal(record.recordID, boundary.recordID)
        assert.equal(
          resolution.providerTombstone?.receiptDigest,
          BOUNDARY_TOMBSTONE_RECEIPT_DIGEST
        )
        assert.equal(
          resolution.evidenceDigest,
          boundaryResolution(boundary).evidenceDigest
        )
        return false as true
      }
    )

    await assert.rejects(
      rejectingStore.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary)
      ),
      /Independent signer-boundary resolution authentication failed/
    )
    assert.equal(authenticationCalls, 1)
    assert.equal(await barrierSignerInvocationCount(database), 1)
    const evidence = await database.client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM p2tr_signature_fraud_challenge_signer_boundary_resolution`
    )
    assert.equal(evidence.rows[0].count, "0")
    await database.client.end()
  }
)

postgresTest(
  "requires an exact provider tombstone before clearing an orphaned boundary",
  async () => {
    const database = await createTestDatabase()
    const { boundary } = await orphanedSignerBoundary(database, 241)
    const valid = boundaryResolution(boundary)

    await assert.rejects(
      database.store.resolveOrphanedSignerBoundary({
        ...valid,
        providerTombstone: undefined,
      }),
      /never-invoked resolution lacks a provider tombstone/
    )
    await assert.rejects(
      database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary, {
          providerTombstone: {
            ...valid.providerTombstone!,
            invocationID: `0x${"ef".repeat(32)}`,
          },
        })
      ),
      /provider tombstone does not bind the exact invocation window/
    )
    await assert.rejects(
      database.store.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary, { attestedAtUnixMs: 1_800 })
      ),
      /attestations fall outside the invocation window/
    )
    assert.equal(await barrierSignerInvocationCount(database), 1)
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
      evidenceDigest = resolution.evidenceDigest
    ): Promise<void> => {
      await database.client.query(
        `INSERT INTO p2tr_signature_fraud_challenge_signer_boundary_resolution (
            record_id, boundary_started_at_unix_ms, preparation_attempts,
            nonce_reservation_id, stage, signer_invocation_id,
            invoked_at_unix_ms, outcome, provider_tombstoned_at_unix_ms,
            provider_tombstone_receipt_digest, provider_evidence_digest,
            resolution_evidence_digest,
            primary_trust_domain_id, primary_independence_domain_id,
            primary_evidence_digest, primary_attestation,
            primary_attested_at_unix_ms, corroborating_trust_domain_id,
            corroborating_independence_domain_id,
            corroborating_evidence_digest, corroborating_attestation,
            corroborating_attested_at_unix_ms, resolved_at_unix_ms
         ) VALUES (
            decode($1, 'hex'), $2, $3, decode($4, 'hex'), $5,
            decode($6, 'hex'), $7, 'never-invoked', $8,
            decode($9, 'hex'), decode($10, 'hex'), decode($11, 'hex'),
            'signer-primary', 'signer-primary-infra', decode($11, 'hex'),
            decode('01', 'hex'), 2000, 'signer-corroborating',
            'signer-corroborating-infra', decode($11, 'hex'),
            decode('02', 'hex'), 2000, 2400
         )`,
        [
          initial.recordID.replace(/^0x/i, ""),
          resolution.boundaryStartedAtUnixMs,
          resolution.preparationAttempts,
          resolution.nonceReservationID.slice(2),
          resolution.stage,
          resolution.providerTombstone!.invocationID.slice(2),
          resolution.invokedAtUnixMs,
          resolution.providerTombstone!.tombstonedAtUnixMs,
          resolution.providerTombstone!.receiptDigest.slice(2),
          resolution.providerEvidenceDigest.slice(2),
          evidenceDigest.slice(2),
        ]
      )
    }

    // Every branch of the guard is reachable from raw SQL, so every branch is
    // proven here rather than only through the adapter that already checked.
    await assert.rejects(
      rawInsert(
        boundaryResolution(boundary, {
          boundaryStartedAtUnixMs: 1_299,
          invokedAtUnixMs: 1_310,
        })
      ),
      /does not name the durable boundary/
    )
    await assert.rejects(
      rawInsert(boundaryResolution(boundary), `0x${"ab".repeat(32)}`),
      /orphaned signer boundary resolution digest is invalid/
    )
    await assert.rejects(
      rawInsert(boundaryResolution(boundary, { stage: "replacement" })),
      /does not name the durable signer stage/
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
    // The marker therefore still holds its nonce-lane barrier closed.
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
  "validates deduplicated artifacts and binds them to signed orphan evidence",
  async () => {
    const database = await createTestDatabase()
    const initial = outboxRecord(241)
    await insertRecord(database, initial)
    const reserved = await advanceToReservation(database, initial)
    let boundary = reserved
    for (const transition of await replacementSignerBoundary(reserved)) {
      await begin(database.client)
      assert.equal(
        await database.store.compareAndSwap(
          boundary.recordID,
          boundary.version,
          transition
        ),
        true
      )
      await commit(database.client)
      boundary = transition
    }
    const priorVariant =
      boundary.preparedTransactionVariants![0].preparedTransaction
    const replacementRawTransaction = await WALLET.signTransaction({
      type: 2,
      chainId: CHAIN_ID,
      to: initial.intent.routerAddress,
      data: initial.intent.calldata,
      value: initial.intent.value,
      nonce: 7,
      gasLimit: 100_000,
      maxFeePerGas: 100,
      maxPriorityFeePerGas: 9,
    })
    const replacementTransactionHash = utils.keccak256(
      replacementRawTransaction
    )
    const managed = createManagedStore(
      database.client,
      eligibilitySnapshotFor(initial)
    )
    assert.equal(
      await managed.resolveOrphanedSignerBoundary(
        boundaryResolution(boundary, {
          stage: "replacement",
          invokedAtUnixMs: 1_510,
          outcome: "signed",
          signedTransactionHash: replacementTransactionHash,
        })
      ),
      "acknowledged"
    )
    const capture = (
      preparedTransaction: P2TRSignatureFraudUnexpectedSignedArtifact["preparedTransaction"]
    ) =>
      managed.captureEscapedSignedArtifact(
        initial.recordID,
        initial.canonicalProvenance.provenanceFingerprint,
        {
          expectedReservationID:
            boundary.reservedNonce!.reservationID.toPrefixedString(),
          capturedAtUnixMs: 2_500,
          reason: "replacement signer returned after its owner exited",
          preparedTransaction,
        }
      )

    // A declared hash matching the prior variant cannot bypass raw envelope
    // validation, even though it would otherwise take the deduplication path.
    await assert.rejects(capture({ ...priorVariant, rawTransaction: "0x02" }))
    assert.equal(await barrierSignerInvocationCount(database), 1)

    // The valid old variant is still not evidence of what this independently
    // attested replacement call signed.
    await assert.rejects(
      capture(priorVariant),
      /does not match the authenticated orphan resolution/
    )
    assert.equal(await barrierSignerInvocationCount(database), 1)

    const captured = await capture({
      intentID: initial.intent.intentID,
      rawTransaction: replacementRawTransaction,
      transactionHash: Hex.from(replacementTransactionHash),
      sender: WALLET.address,
      nonce: 7,
    })
    assert.equal(captured.activeSignerInvocationStartedAtUnixMs, undefined)
    assert.equal(captured.unexpectedSignedArtifacts?.length, 1)
    assert.equal(await barrierSignerInvocationCount(database), 0)
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
        `signer=${record?.signerInvocationStartedAtUnixMs ?? "none"}`,
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
  "acknowledged status=preparing active=none signer=none artifacts=0"
const RETAINED_ORPHAN =
  "acknowledged status=preparing active=1300 signer=none artifacts=0"
const UNSAFE_ORPHAN =
  "unsafe status=preparing active=1300 signer=none artifacts=0"
const WRONG_BOUNDARY =
  "error:Orphaned signer boundary resolution does not name the durable boundary"
const WRONG_SIGNER_STAGE =
  "error:Orphaned signer boundary resolution does not name the durable signer stage"

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
    name: "rejects a different boundary start",
    seed: 222,
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
    name: "rejects replacement evidence for an initial signer boundary",
    seed: 238,
    boundary: orphanedBoundaryOnly,
    resolutions: [{ stage: "replacement" }],
    expected: [WRONG_SIGNER_STAGE],
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
    expected: ["unsafe status=preparing active=1500 signer=1300 artifacts=0"],
    expectedAlertCodes: ["signer-boundary-terminal-unsafe"],
  },
  {
    name: "rejects initial-stage evidence for a replacement signer boundary",
    seed: 239,
    boundary: replacementSignerBoundary,
    resolutions: [
      {
        boundaryStartedAtUnixMs: 1_500,
        invokedAtUnixMs: 1_510,
        stage: "prepare",
        outcome: "terminal-unsafe",
      },
    ],
    expected: [WRONG_SIGNER_STAGE],
    expectedAlertCodes: [],
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
