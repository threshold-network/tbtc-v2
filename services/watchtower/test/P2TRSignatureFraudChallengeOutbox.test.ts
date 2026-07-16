import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  Hex,
  P2TRSignatureFraudChallengeTransactionPreparer,
  P2TRSignatureFraudPreparedChallengeTransaction,
  P2TRSignatureFraudSubmissionIntent,
  P2TRWatchtowerChallengeRecord,
  computeP2TRSignatureFraudSubmissionIntentID,
  extractP2TRSignatureFraudWitnessObservations,
} from "@keep-network/tbtc-v2.ts"
import { Transaction } from "bitcoinjs-lib"

import {
  P2TRSignatureFraudChallengeOutboxDispatcher,
  P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  P2TRSignatureFraudChallengeOutboxPage,
  P2TRSignatureFraudChallengeOutboxPageRequest,
  P2TRSignatureFraudChallengeOutboxReconciler,
  P2TRSignatureFraudChallengeOutboxRecord,
  P2TRSignatureFraudChallengeOutboxResolution,
  P2TRSignatureFraudChallengeOutboxScheduler,
  P2TRSignatureFraudChallengeOutboxStatus,
  P2TRSignatureFraudChallengeOutboxStore,
  P2TRSignatureFraudLegacySubmissionQuarantine,
  P2TRSignatureFraudOutboxEvidenceCheckpoint,
  P2TRSignatureFraudPreBroadcastRecheckContext,
  P2TRSignatureFraudPreBroadcastRechecker,
  P2TRSignatureFraudPreBroadcastRecheckResult,
  P2TRSignatureFraudRawTransactionBroadcaster,
  computeP2TRSignatureFraudEthereumEligibilityReadSetHash,
  quarantineLegacyP2TRSignatureFraudSubmissions,
} from "../src/P2TRSignatureFraudChallengeOutbox.js"

const RAW_TRANSACTION =
  "0xf8680702830f42409422222222222222222222222222222222222222228204d28212348401546d71a0729899f82397fce792b92e19338f8ae9687f82fa5460a227d21f904ab1684f13a02a784aace7625ce273add6273bf035fd503be4c29a390bdf85df1160cd2c35ab"
const TRANSACTION_HASH =
  "0x195d980c04cae718b20cd0518230fcc40284ea686a2f801d68f340fe57474036"
const TRANSACTION_SENDER = "0x17c5185167401eD00cF5F5b2fc97D9BBfDb7D025"
const ROUTER_ADDRESS = "0x2222222222222222222222222222222222222222"
const BRIDGE_ADDRESS = "0x1111111111111111111111111111111111111111"
const CHALLENGE_KEY = `0x${"aa".repeat(32)}`
const WALLET_ID = `0x${"bb".repeat(32)}`
const CHALLENGE_IDENTITY = `0x${"cc".repeat(32)}`
const SIGHASH = `0x${"dd".repeat(32)}`
const BITCOIN_TXID = `0x${"01".repeat(32)}`
const BITCOIN_WTXID = `0x${"05".repeat(32)}`
const BITCOIN_BLOCK_HASH = `0x${"02".repeat(32)}`
const BITCOIN_CURSOR_HASH = `0x${"03".repeat(32)}`
const ETHEREUM_CURSOR_HASH = `0x${"04".repeat(32)}`
const ROUTER_CODE_HASH = `0x${"a1".repeat(32)}`
const COMPLETE_REGISTRY_ADDRESS = "0x4444444444444444444444444444444444444444"
const COMPLETE_REGISTRY_CODE_HASH = `0x${"a2".repeat(32)}`
const ACTIVATION_MANIFEST_HASH = `0x${"a3".repeat(32)}`

const activationManifest = () => ({
  manifestHash: ACTIVATION_MANIFEST_HASH,
  routerCodeHash: ROUTER_CODE_HASH,
  routerProtocolID: "p2tr-fraud-router-v1",
  completeAuthorizationRegistryAddress: COMPLETE_REGISTRY_ADDRESS,
  completeAuthorizationRegistryCodeHash: COMPLETE_REGISTRY_CODE_HASH,
  completeAuthorizationRegistryProtocolID: "complete-authorization-v1",
  completeReservationModel: "seat-reservation-v1",
})

const ethereumEligibility = (
  identity: {
    chainID: number
    routerAddress: string
    bridgeAddress: string
    bridgeChallengeKey: Hex | string
    bridgeChallengeIdentity: Hex | string
    walletID: Hex | string
  },
  blockNumber: number,
  blockHash: string
) => {
  const withoutHash = {
    readAtBlockNumber: blockNumber,
    readAtBlockHash: blockHash,
    chainID: identity.chainID,
    routerAddress: identity.routerAddress,
    routerCodeHash: ROUTER_CODE_HASH,
    routerProtocolID: "p2tr-fraud-router-v1",
    routerBridgeAddress: identity.bridgeAddress,
    routerChallengeKey:
      identity.bridgeChallengeKey instanceof Hex
        ? identity.bridgeChallengeKey.toPrefixedString()
        : identity.bridgeChallengeKey,
    routerChallengeAbsent: true as const,
    completeAuthorizationRegistryAddress: COMPLETE_REGISTRY_ADDRESS,
    completeAuthorizationRegistryCodeHash: COMPLETE_REGISTRY_CODE_HASH,
    completeAuthorizationRegistryProtocolID: "complete-authorization-v1",
    completeReservationModel: "seat-reservation-v1",
    completeChallengeIdentity:
      identity.bridgeChallengeIdentity instanceof Hex
        ? identity.bridgeChallengeIdentity.toPrefixedString()
        : identity.bridgeChallengeIdentity,
    completeWalletID:
      identity.walletID instanceof Hex
        ? identity.walletID.toPrefixedString()
        : identity.walletID,
    completeAuthorizationAbsent: true as const,
    completeReservationAbsent: true as const,
    walletChallengeable: true as const,
    canonicalProofBacklogComplete: true as const,
    activationManifestHash: ACTIVATION_MANIFEST_HASH,
  }
  return {
    ...withoutHash,
    readSetHash:
      computeP2TRSignatureFraudEthereumEligibilityReadSetHash(withoutHash),
  }
}

const normalizeKey = (value: Hex | string): string =>
  value instanceof Hex
    ? value.toPrefixedString().toLowerCase()
    : value.toLowerCase()

class InMemoryOutboxStore implements P2TRSignatureFraudChallengeOutboxStore {
  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID = "outbox.test"
  readonly records = new Map<string, P2TRSignatureFraudChallengeOutboxRecord>()
  readonly quarantines: P2TRSignatureFraudLegacySubmissionQuarantine[] = []
  eligibilitySnapshot?: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot

  async insertIfAbsent(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const key = normalizeKey(record.intent.intentID)
    const existing = this.records.get(key)
    if (existing !== undefined) return existing
    for (const durable of this.records.values()) {
      if (
        durable.intent.chainID === record.intent.chainID &&
        durable.intent.routerAddress.toLowerCase() ===
          record.intent.routerAddress.toLowerCase() &&
        normalizeKey(durable.intent.bridgeChallengeKey) ===
          normalizeKey(record.intent.bridgeChallengeKey)
      ) {
        return durable
      }
    }
    if (this.hasLaneConflict(key, record)) {
      throw new Error("sender lane conflict")
    }
    this.records.set(key, record)
    return record
  }

  async get(
    intentID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    return this.records.get(normalizeKey(intentID))
  }

  async compareAndSwap(
    intentID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    const key = normalizeKey(intentID)
    const current = this.records.get(key)
    if (
      current === undefined ||
      current.version !== expectedVersion ||
      next.version !== expectedVersion + 1 ||
      normalizeKey(next.intent.intentID) !== key ||
      this.hasLaneConflict(key, next)
    ) {
      return false
    }
    this.records.set(key, next)
    return true
  }

  async listPage(
    request: P2TRSignatureFraudChallengeOutboxPageRequest
  ): Promise<P2TRSignatureFraudChallengeOutboxPage> {
    const records = [...this.records.values()]
      .filter((record) => request.statuses.includes(record.status))
      .sort((left, right) =>
        normalizeKey(left.intent.intentID).localeCompare(
          normalizeKey(right.intent.intentID)
        )
      )
      .filter(
        (record) =>
          request.cursor === undefined ||
          normalizeKey(record.intent.intentID) > request.cursor
      )
    const page = records.slice(0, request.limit)
    return {
      records: page,
      nextCursor:
        records.length > request.limit
          ? normalizeKey(page[page.length - 1].intent.intentID)
          : undefined,
    }
  }

  async saveLegacyQuarantine(
    quarantine: P2TRSignatureFraudLegacySubmissionQuarantine
  ): Promise<void> {
    this.quarantines.push(quarantine)
  }

  async runInEligibilityTransaction<T>(
    observationID: string,
    operation: (
      snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
    ) => Promise<T>
  ): Promise<T> {
    if (
      this.eligibilitySnapshot === undefined ||
      normalizeKey(this.eligibilitySnapshot.challengeRecord.observationID) !==
        normalizeKey(observationID)
    ) {
      throw new Error("authoritative eligibility snapshot is absent")
    }
    return operation(this.eligibilitySnapshot)
  }

  private hasLaneConflict(
    key: string,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): boolean {
    if (next.preparationSender === undefined) {
      return false
    }
    return [...this.records.entries()].some(
      ([otherKey, other]) =>
        otherKey !== key &&
        other.preparationSender !== undefined &&
        other.intent.chainID === next.intent.chainID &&
        other.preparationSender?.toLowerCase() ===
          next.preparationSender?.toLowerCase()
    )
  }
}

class FixedPreparer implements P2TRSignatureFraudChallengeTransactionPreparer {
  readonly transactionSender = TRANSACTION_SENDER
  calls = 0

  async prepareSignatureFraudChallengeTransaction(
    intent: P2TRSignatureFraudSubmissionIntent
  ): Promise<P2TRSignatureFraudPreparedChallengeTransaction> {
    this.calls++
    await Promise.resolve()
    return {
      intentID: intent.intentID,
      rawTransaction: RAW_TRANSACTION,
      transactionHash: Hex.from(TRANSACTION_HASH),
      sender: TRANSACTION_SENDER,
      nonce: 7,
    }
  }
}

class AmbiguousRemotePreparer extends FixedPreparer {
  override async prepareSignatureFraudChallengeTransaction(): Promise<P2TRSignatureFraudPreparedChallengeTransaction> {
    this.calls++
    throw new Error("remote signer disconnected after signing")
  }
}

class RecordingBroadcaster
  implements P2TRSignatureFraudRawTransactionBroadcaster
{
  readonly submissionTrustDomainID = "submission.test"
  readonly providerIdentity = {}
  readonly rawTransactions: string[] = []
  throwAfterSend?: Error
  returnedHash = TRANSACTION_HASH
  inspectDurableBoundary?: () => Promise<void>

  async broadcastRawTransaction(rawTransaction: string): Promise<string> {
    await this.inspectDurableBoundary?.()
    this.rawTransactions.push(rawTransaction)
    if (this.throwAfterSend !== undefined) throw this.throwAfterSend
    return this.returnedHash
  }
}

class FixedRechecker implements P2TRSignatureFraudPreBroadcastRechecker {
  readonly recheckTrustDomainID = "recheck.test"
  readonly providerIdentity = {}
  resolution?: P2TRSignatureFraudPreBroadcastRecheckResult
  readonly stages: P2TRSignatureFraudPreBroadcastRecheckContext["stage"][] = []

  async recheckSignatureFraudChallengeBeforeBroadcast(
    context: P2TRSignatureFraudPreBroadcastRecheckContext
  ): Promise<P2TRSignatureFraudPreBroadcastRecheckResult> {
    this.stages.push(context.stage)
    return (
      this.resolution ?? {
        status: "eligible",
        canonicalCandidate: {
          txid: context.evidenceCheckpoint.bitcoinTxHash,
          wtxid: context.evidenceCheckpoint.bitcoinWitnessTxHash,
          blockHash: context.evidenceCheckpoint.bitcoinBlockHash,
          blockHeight: context.evidenceCheckpoint.bitcoinBlockHeight,
          inputIndex: context.evidenceCheckpoint.bitcoinInputIndex,
        },
        canonicalEthereumEligibility: ethereumEligibility(
          context.intent,
          context.evidenceCheckpoint.ethereumLifecycleBlockNumber,
          context.evidenceCheckpoint.ethereumLifecycleBlockHash
        ),
      }
    )
  }
}

class FixedReconciler implements P2TRSignatureFraudChallengeOutboxReconciler {
  readonly reconciliationTrustDomainID = "reconciliation.test"
  readonly providerIdentity = {}
  readonly finalityConfirmationBlocks = 12
  readonly canonicalSubmissionSelectors = [
    { variant: "router-process" as const, selector: "0x12345678" },
    { variant: "router-direct" as const, selector: "0xdeadbeef" },
  ]
  resolution: P2TRSignatureFraudChallengeOutboxResolution = {
    status: "pending",
    reason: "transaction is not final",
  }

  async reconcileSignatureFraudChallengeOutbox(): Promise<P2TRSignatureFraudChallengeOutboxResolution> {
    return this.resolution
  }
}

const createIntent = (seed = "aa"): P2TRSignatureFraudSubmissionIntent => {
  const withoutID: Omit<P2TRSignatureFraudSubmissionIntent, "intentID"> = {
    observationID: Hex.from(`0x${seed.repeat(32)}`),
    bridgeChallengeKey: Hex.from(`0x${seed.repeat(32)}`),
    walletID: Hex.from(WALLET_ID),
    bridgeChallengeIdentity: Hex.from(CHALLENGE_IDENTITY),
    sighash: Hex.from(SIGHASH),
    chainID: 11155111,
    bridgeAddress: BRIDGE_ADDRESS,
    routerAddress: ROUTER_ADDRESS,
    calldata: "0x1234",
    value: "1234",
  }
  return {
    ...withoutID,
    intentID: computeP2TRSignatureFraudSubmissionIntentID(withoutID),
  }
}

const evidenceCheckpoint = (): P2TRSignatureFraudOutboxEvidenceCheckpoint => ({
  confirmedSourceComplete: true,
  bitcoinTxHash: BITCOIN_TXID,
  bitcoinWitnessTxHash: BITCOIN_WTXID,
  bitcoinInputIndex: 0,
  bitcoinBlockHash: BITCOIN_BLOCK_HASH,
  bitcoinBlockHeight: 100,
  bitcoinCursorBlockHash: BITCOIN_CURSOR_HASH,
  bitcoinCursorBlockHeight: 120,
  ethereumLifecycleBlockHash: ETHEREUM_CURSOR_HASH,
  ethereumLifecycleBlockNumber: 500,
  activationManifest: activationManifest(),
  submittedEventScanFromBlock: 50,
})

const createRecord = (
  intent = createIntent(),
  evidence = evidenceCheckpoint()
): P2TRSignatureFraudChallengeOutboxRecord => ({
  intent,
  evidenceCheckpoint: evidence,
  status: "queued",
  version: 0,
  generation: 0,
  createdAtUnixMs: 1_000,
  updatedAtUnixMs: 1_000,
  preparationAttempts: 0,
  broadcastAttempts: 0,
  reconciliationAttempts: 0,
})

const enqueue = async (
  store: InMemoryOutboxStore,
  intent = createIntent()
): Promise<P2TRSignatureFraudChallengeOutboxRecord> =>
  store.insertIfAbsent(createRecord(intent))

const dispatcher = (
  store: InMemoryOutboxStore,
  preparer = new FixedPreparer(),
  broadcaster = new RecordingBroadcaster(),
  rechecker = new FixedRechecker(),
  reconciler = new FixedReconciler(),
  now = () => 2_000,
  recoveryPageSize = 100,
  onRecoveryBacklog?: (report: {
    backlogRemaining: boolean
  }) => Promise<void> | void
) =>
  new P2TRSignatureFraudChallengeOutboxDispatcher(
    store,
    preparer,
    broadcaster,
    rechecker,
    reconciler,
    {
      minimumRebroadcastIntervalMs: 0,
      recoveryPageSize,
      onRecoveryBacklog,
      now,
    }
  )

const acceptedOwnResolution =
  (): P2TRSignatureFraudChallengeOutboxResolution => ({
    status: "accepted-own",
    observedHead: {
      blockNumber: 120,
      blockHash: `0x${"12".repeat(32)}`,
    },
    finalizedThrough: {
      blockNumber: 108,
      blockHash: `0x${"18".repeat(32)}`,
    },
    receipt: {
      transactionHash: TRANSACTION_HASH,
      status: 1,
      blockNumber: 100,
      blockHash: `0x${"10".repeat(32)}`,
    },
    transaction: {
      transactionHash: TRANSACTION_HASH,
      sender: TRANSACTION_SENDER,
      routerAddress: ROUTER_ADDRESS,
      calldata: "0x1234",
      value: "1234",
      nonce: 7,
      chainID: 11155111,
      blockNumber: 100,
      blockHash: `0x${"10".repeat(32)}`,
      decodedSubmissionCall: {
        variant: "router-process",
        selector: "0x12345678",
        action: "submit",
        walletID: WALLET_ID,
        bridgeChallengeIdentity: CHALLENGE_IDENTITY,
        challengeKey: CHALLENGE_KEY,
        sighash: SIGHASH,
      },
    },
    routerChallenge: {
      exists: true,
      challengeKey: CHALLENGE_KEY,
      challenger: TRANSACTION_SENDER,
      depositAmount: "1234",
      reportedAt: 999,
      resolved: false,
      readAtBlock: 108,
    },
    submittedEvent: {
      routerAddress: ROUTER_ADDRESS,
      transactionHash: TRANSACTION_HASH,
      blockNumber: 100,
      blockHash: `0x${"10".repeat(32)}`,
      blockTimestamp: 999,
      logIndex: 4,
      walletID: WALLET_ID,
      walletPubKeyHash: `0x${"ee".repeat(20)}`,
      bridgeChallengeIdentity: CHALLENGE_IDENTITY,
      challengeKey: CHALLENGE_KEY,
      sighash: SIGHASH,
    },
  })

const externalResolution = (
  status:
    | "satisfied-external"
    | "external-satisfied-awaiting-own-transaction" = "satisfied-external"
): Extract<
  P2TRSignatureFraudChallengeOutboxResolution,
  {
    status:
      | "accepted-own"
      | "satisfied-external"
      | "external-satisfied-awaiting-own-transaction"
  }
> => {
  const own = acceptedOwnResolution()
  assert.equal(own.status, "accepted-own")
  const transactionHash = `0x${"77".repeat(32)}`
  const sender = "0x3333333333333333333333333333333333333333"
  return {
    ...own,
    status,
    receipt: { ...own.receipt, transactionHash },
    transaction: {
      ...own.transaction,
      transactionHash,
      sender,
      calldata: "0xdeadbeef",
      value: "1500",
      nonce: 3,
      decodedSubmissionCall: {
        ...own.transaction.decodedSubmissionCall,
        variant: "router-direct",
        selector: "0xdeadbeef",
      },
    },
    routerChallenge: {
      ...own.routerChallenge,
      challenger: sender,
      depositAmount: "1500",
    },
    submittedEvent: { ...own.submittedEvent, transactionHash },
  }
}

type SignatureFraudVector = {
  id: string
  walletIDHex: string
  unsignedTransactionHex: string
  signedInputIndex: number
  witnessSignatureHex: string
  prevouts: Array<{
    txidHex: string
    vout: number
    valueSats: number
    scriptPubKeyHex: string
  }>
}

const canonicalEligibilitySnapshot =
  (): P2TRSignatureFraudChallengeOutboxEligibilitySnapshot => {
    const vectors = JSON.parse(
      readFileSync(
        new URL(
          "../../../docs/test-vectors/p2tr-signature-fraud-v0.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { cases: SignatureFraudVector[] }
    const vector = vectors.cases.find(
      ({ id }) => id === "bip341-keypath-sighash-default-single-input"
    )!
    const transaction = Transaction.fromHex(vector.unsignedTransactionHex)
    transaction.ins[vector.signedInputIndex].witness = [
      Buffer.from(vector.witnessSignatureHex, "hex"),
    ]
    const inputPrevouts = vector.prevouts.map((prevout) => ({
      txid: prevout.txidHex,
      vout: prevout.vout,
      valueSats: prevout.valueSats,
      scriptPubKey: prevout.scriptPubKeyHex,
    }))
    const [observation] = extractP2TRSignatureFraudWitnessObservations(
      { transactionHex: transaction.toHex() },
      inputPrevouts,
      [vector.walletIDHex],
      undefined,
      undefined,
      undefined,
      { chainID: 11155111, bridgeAddress: BRIDGE_ADDRESS },
      []
    )
    assert.ok(observation)
    const txid = `0x${transaction.getId()}`
    const wtxid = `0x${Buffer.from(transaction.getHash(true))
      .reverse()
      .toString("hex")}`
    const blockHash = `0x${"42".repeat(32)}`
    const lifecycleHash = `0x${"43".repeat(32)}`
    const challengeRecord = {
      observationID: observation.observationID,
      // Deliberately absent: enqueue derives from the candidate row instead.
      observation: undefined,
      status: "observed",
      submissionAttempts: 0,
      bitcoinStatus: "confirmed",
      bitcoinTxHash: Hex.from(txid),
      bitcoinWtxid: Hex.from(wtxid),
      bitcoinBlockHash: Hex.from(blockHash),
      bitcoinBlockHeight: 100,
    } as P2TRWatchtowerChallengeRecord

    return {
      challengeRecord,
      canonicalObservation: observation,
      canonicalCandidate: {
        txid,
        wtxid,
        blockHash,
        blockHeight: 100,
        inputIndex: vector.signedInputIndex,
      },
      canonicalCandidateDelivered: true,
      canonicalCandidateCurrentAtCursor: true,
      evidenceCheckpoint: {
        confirmedSourceComplete: true,
        bitcoinTxHash: txid,
        bitcoinWitnessTxHash: wtxid,
        bitcoinInputIndex: vector.signedInputIndex,
        bitcoinBlockHash: blockHash,
        bitcoinBlockHeight: 100,
        bitcoinCursorBlockHash: `0x${"44".repeat(32)}`,
        bitcoinCursorBlockHeight: 120,
        ethereumLifecycleBlockHash: lifecycleHash,
        ethereumLifecycleBlockNumber: 500,
        activationManifest: activationManifest(),
        submittedEventScanFromBlock: 50,
      },
      canonicalEthereumEligibility: ethereumEligibility(
        {
          chainID: 11155111,
          routerAddress: ROUTER_ADDRESS,
          bridgeAddress: BRIDGE_ADDRESS,
          bridgeChallengeKey: observation.bridgeChallengeKey!,
          bridgeChallengeIdentity: observation.bridgeChallengeIdentity,
          walletID: observation.walletID,
        },
        500,
        lifecycleHash
      ),
      legacySubmissionQuarantined: false,
      canonicalRegisteredWalletID: vector.walletIDHex,
      canonicalWalletInputAuthorization: {
        kind: "registered-wallet-output",
        walletID: vector.walletIDHex,
        outputKey: vector.walletIDHex,
      },
    }
  }

const scheduler = (store: InMemoryOutboxStore) =>
  new P2TRSignatureFraudChallengeOutboxScheduler(store, {
    submissionIntent: {
      chainID: 11155111,
      bridgeAddress: BRIDGE_ADDRESS,
      routerAddress: ROUTER_ADDRESS,
      challengeDepositAmount: 1234,
    },
    activationManifest: activationManifest(),
    observationValidation: {
      bridgeChallengeDomain: {
        chainID: 11155111,
        bridgeAddress: BRIDGE_ADDRESS,
      },
    },
  })

test("derives enqueue intent only from the locked canonical witness candidate", async () => {
  const store = new InMemoryOutboxStore()
  store.eligibilitySnapshot = canonicalEligibilitySnapshot()
  const observationID = store.eligibilitySnapshot.challengeRecord.observationID
  const first = await scheduler(store).enqueueConfirmedChallenge(
    observationID,
    1_000
  )
  const second = await scheduler(store).enqueueConfirmedChallenge(
    observationID,
    1_001
  )

  assert.equal(first.status, "queued")
  assert.equal(first.intent.observationID.toString(), observationID.toString())
  assert.equal(first.evidenceCheckpoint.bitcoinWitnessTxHash.length, 66)
  assert.equal(
    second.intent.intentID.toString(),
    first.intent.intentID.toString()
  )
  assert.equal(store.records.size, 1)

  const checks: Array<{
    mutate(snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot): void
    message: RegExp
  }> = [
    {
      mutate: (snapshot) => {
        snapshot.canonicalRegisteredWalletID = `0x${"99".repeat(32)}`
      },
      message: /not authorized by the registry index/,
    },
    {
      mutate: (snapshot) => {
        snapshot.evidenceCheckpoint.bitcoinWitnessTxHash = `0x${"98".repeat(
          32
        )}`
      },
      message: /exact canonical witness candidate/,
    },
    {
      mutate: (snapshot) => {
        snapshot.legacySubmissionQuarantined = true
      },
      message: /blocked by legacy submission quarantine/,
    },
    {
      mutate: (snapshot) => {
        snapshot.canonicalEthereumEligibility.routerBridgeAddress =
          "0x9999999999999999999999999999999999999999"
      },
      message: /activation manifest and exact challenge identity/,
    },
    {
      mutate: (snapshot) => {
        ;(
          snapshot.canonicalEthereumEligibility as unknown as {
            canonicalProofBacklogComplete: boolean
          }
        ).canonicalProofBacklogComplete = false
      },
      message: /prove challenge, authorization, and reservation absence/,
    },
  ]
  for (const check of checks) {
    const invalidStore = new InMemoryOutboxStore()
    invalidStore.eligibilitySnapshot = canonicalEligibilitySnapshot()
    check.mutate(invalidStore.eligibilitySnapshot)
    await assert.rejects(
      scheduler(invalidStore).enqueueConfirmedChallenge(observationID),
      check.message
    )
  }
})

test("requires independent bounded submission, recheck, and reconciliation domains", () => {
  const store = new InMemoryOutboxStore()
  const preparer = new FixedPreparer()
  const broadcaster = new RecordingBroadcaster()
  const rechecker = new FixedRechecker()
  const reconciler = new FixedReconciler()
  Object.defineProperty(rechecker, "providerIdentity", {
    value: broadcaster.providerIdentity,
  })
  assert.throws(
    () => dispatcher(store, preparer, broadcaster, rechecker, reconciler),
    /independent provider instances and trust domains/
  )

  const longDomainRechecker = new FixedRechecker()
  Object.defineProperty(longDomainRechecker, "recheckTrustDomainID", {
    value: "x".repeat(129),
  })
  assert.throws(
    () =>
      dispatcher(store, preparer, broadcaster, longDomainRechecker, reconciler),
    /exceeds 128 characters/
  )
})

test("reserves one durable sender lane before signing", async () => {
  const store = new InMemoryOutboxStore()
  const first = await enqueue(store, createIntent("aa"))
  const second = await enqueue(store, createIntent("ab"))
  const preparer = new FixedPreparer()
  const outbox = dispatcher(store, preparer)

  const results = await Promise.all([
    outbox.prepare(first.intent.intentID, "worker-a"),
    outbox.prepare(second.intent.intentID, "worker-b"),
  ])

  assert.equal(preparer.calls, 1)
  assert.equal(results.filter(({ status }) => status === "prepared").length, 1)
  assert.equal(results.filter(({ status }) => status === "queued").length, 1)
})

test("retains the sender lane when remote signing outcome is ambiguous", async () => {
  const store = new InMemoryOutboxStore()
  const first = await enqueue(store, createIntent("aa"))
  const second = await enqueue(store, createIntent("ab"))
  const preparer = new AmbiguousRemotePreparer()
  const outbox = dispatcher(store, preparer)

  const quarantined = await outbox.prepare(first.intent.intentID, "worker-a")
  assert.equal(quarantined.status, "quarantined")
  assert.ok(quarantined.preparationSender)
  const blocked = await outbox.prepare(second.intent.intentID, "worker-b")
  assert.equal(blocked.status, "queued")
  assert.equal(preparer.calls, 1)
})

test("persists send boundary and retries only identical signed bytes", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const preparer = new FixedPreparer()
  const broadcaster = new RecordingBroadcaster()
  broadcaster.throwAfterSend = new Error("x".repeat(5_000))
  broadcaster.inspectDurableBoundary = async () => {
    const durable = await store.get(record.intent.intentID.toPrefixedString())
    assert.equal(durable?.status, "broadcast-pending")
    assert.equal(
      durable?.broadcastAttempts,
      broadcaster.rawTransactions.length + 1
    )
  }
  const outbox = dispatcher(store, preparer, broadcaster)
  await outbox.prepare(record.intent.intentID, "worker-a")
  const first = await outbox.broadcast(record.intent.intentID)
  const second = await outbox.broadcast(record.intent.intentID)

  assert.equal(first.status, "broadcast-pending")
  assert.equal(second.broadcastAttempts, 2)
  assert.equal(second.lastError?.length, 1_024)
  assert.equal(preparer.calls, 1)
  assert.deepEqual(broadcaster.rawTransactions, [
    RAW_TRANSACTION,
    RAW_TRANSACTION,
  ])
})

test("keeps wrong broadcaster hash post-send pending and reconcilable", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const broadcaster = new RecordingBroadcaster()
  broadcaster.returnedHash = `0x${"99".repeat(32)}`
  const outbox = dispatcher(store, new FixedPreparer(), broadcaster)
  await outbox.prepare(record.intent.intentID, "worker-a")
  const result = await outbox.broadcast(record.intent.intentID)

  assert.equal(result.status, "broadcast-pending")
  assert.equal(result.broadcastAttempts, 1)
  assert.equal(
    result.preparationSender?.toLowerCase(),
    TRANSACTION_SENDER.toLowerCase()
  )
  assert.match(
    result.lastError ?? "",
    /does not match the persisted raw transaction/
  )
})

test("pre-send recheck cancels only before the irreversible boundary", async () => {
  const honestStore = new InMemoryOutboxStore()
  const honestRecord = await enqueue(honestStore)
  const honestRechecker = new FixedRechecker()
  honestRechecker.resolution = {
    status: "cancelled-honest-spend",
    reason: "canonical proof now identifies an honest spend",
  }
  const honestBroadcaster = new RecordingBroadcaster()
  const honestOutbox = dispatcher(
    honestStore,
    new FixedPreparer(),
    honestBroadcaster,
    honestRechecker
  )
  const cancelled = await honestOutbox.prepare(
    honestRecord.intent.intentID,
    "worker-a"
  )
  assert.equal(cancelled.status, "cancelled-honest-spend")
  assert.equal(cancelled.preparationSender, undefined)
  assert.equal(cancelled.signerInvocationStartedAtUnixMs, undefined)
  assert.deepEqual(honestRechecker.stages, ["before-sign"])
  assert.equal(honestBroadcaster.rawTransactions.length, 0)

  const reorgStore = new InMemoryOutboxStore()
  const reorgRecord = await enqueue(reorgStore)
  const reorgRechecker = new FixedRechecker()
  const reorgBroadcaster = new RecordingBroadcaster()
  const reorgOutbox = dispatcher(
    reorgStore,
    new FixedPreparer(),
    reorgBroadcaster,
    reorgRechecker
  )
  await reorgOutbox.prepare(reorgRecord.intent.intentID, "worker-a")
  await reorgOutbox.broadcast(reorgRecord.intent.intentID)
  reorgRechecker.resolution = {
    status: "cancelled-reorg",
    reason: "candidate is no longer canonical",
  }
  const pending = await reorgOutbox.broadcast(reorgRecord.intent.intentID)
  assert.equal(pending.status, "broadcast-pending")
  assert.equal(pending.broadcastAttempts, 1)
  assert.ok(pending.preparationSender)
  assert.equal(reorgBroadcaster.rawTransactions.length, 1)
})

test("recovers one bounded preparation page and reports remaining backlog", async () => {
  const store = new InMemoryOutboxStore()
  for (const [index, seed] of ["a1", "a2", "a3"].entries()) {
    const record = createRecord(createIntent(seed))
    record.status = "preparing"
    record.preparationSender = `0x${(index + 1).toString(16).padStart(40, "0")}`
    record.preparationLease = { owner: `worker-${index}`, expiresAtUnixMs: 1 }
    record.signerInvocationStartedAtUnixMs = 1
    await store.insertIfAbsent(record)
  }
  let backlogReports = 0
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => 2_000,
    2,
    () => {
      backlogReports++
    }
  )
  const first = await outbox.recoverExpiredPreparationLeases()
  assert.deepEqual(
    {
      scanned: first.scanned,
      recovered: first.recovered,
      backlog: first.backlogRemaining,
    },
    { scanned: 2, recovered: 2, backlog: true }
  )
  assert.equal(backlogReports, 1)
  assert.equal(
    [...store.records.values()].filter(
      ({ status, preparationSender }) =>
        status === "quarantined" && preparationSender !== undefined
    ).length,
    2
  )
  const second = await outbox.recoverExpiredPreparationLeases(first.nextCursor)
  assert.equal(second.scanned, 1)
})

test("accepts only decoded, finalized canonical own evidence", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const reconciler = new FixedReconciler()
  reconciler.resolution = acceptedOwnResolution()
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    reconciler
  )
  await outbox.prepare(record.intent.intentID, "worker-a")
  await outbox.broadcast(record.intent.intentID)
  assert.equal(
    (await outbox.reconcile(record.intent.intentID)).status,
    "accepted-own"
  )

  const invalidStore = new InMemoryOutboxStore()
  const invalidRecord = await enqueue(invalidStore)
  const invalidReconciler = new FixedReconciler()
  const invalid = acceptedOwnResolution()
  assert.equal(invalid.status, "accepted-own")
  invalidReconciler.resolution = {
    ...invalid,
    transaction: {
      ...invalid.transaction,
      decodedSubmissionCall: {
        ...invalid.transaction.decodedSubmissionCall,
        challengeKey: `0x${"66".repeat(32)}`,
      },
    },
  }
  const invalidOutbox = dispatcher(
    invalidStore,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    invalidReconciler
  )
  await invalidOutbox.prepare(invalidRecord.intent.intentID, "worker-a")
  await invalidOutbox.broadcast(invalidRecord.intent.intentID)
  const unresolved = await invalidOutbox.reconcile(
    invalidRecord.intent.intentID
  )
  assert.equal(unresolved.status, "broadcast-pending")
  assert.equal(unresolved.lastResolutionStatus, "unknown")
  assert.match(unresolved.lastError ?? "", /decoded submission call/)
})

test("external satisfaction retains lane after send until own nonce is final", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const reconciler = new FixedReconciler()
  reconciler.resolution = externalResolution(
    "external-satisfied-awaiting-own-transaction"
  )
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    reconciler
  )
  await outbox.prepare(record.intent.intentID, "worker-a")
  await outbox.broadcast(record.intent.intentID)
  const awaiting = await outbox.reconcile(record.intent.intentID)
  assert.equal(awaiting.status, "external-satisfied-awaiting-own-transaction")
  assert.ok(awaiting.preparationSender)

  const satisfied = externalResolution()
  satisfied.ownTransactionDisposition = {
    status: "reverted",
    receipt: {
      transactionHash: TRANSACTION_HASH,
      status: 0,
      blockNumber: 102,
      blockHash: `0x${"19".repeat(32)}`,
    },
  }
  reconciler.resolution = satisfied
  const terminal = await outbox.reconcile(record.intent.intentID)
  assert.equal(terminal.status, "satisfied-external")
  assert.equal(terminal.preparationSender, undefined)
})

test("leaked prepared bytes retain the lane after external satisfaction", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const reconciler = new FixedReconciler()
  reconciler.resolution = externalResolution(
    "external-satisfied-awaiting-own-transaction"
  )
  const outbox = dispatcher(
    store,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    reconciler
  )
  await outbox.prepare(record.intent.intentID, "worker-a")
  const result = await outbox.reconcile(record.intent.intentID)
  assert.equal(result.status, "external-satisfied-awaiting-own-transaction")
  assert.ok(result.preparationSender)

  const next = await enqueue(store, createIntent("ab"))
  const blocked = await outbox.prepare(next.intent.intentID, "worker-b")
  assert.equal(blocked.status, "queued")
})

test("bounds lease timestamps, owners, and recovery page size", async () => {
  const store = new InMemoryOutboxStore()
  const record = await enqueue(store)
  const outbox = dispatcher(store)
  await assert.rejects(
    outbox.prepare(record.intent.intentID, "x".repeat(129)),
    /exceeds 128 characters/
  )

  const overflowStore = new InMemoryOutboxStore()
  const overflowRecord = await enqueue(overflowStore)
  const overflowOutbox = dispatcher(
    overflowStore,
    new FixedPreparer(),
    new RecordingBroadcaster(),
    new FixedRechecker(),
    new FixedReconciler(),
    () => Number.MAX_SAFE_INTEGER
  )
  await assert.rejects(
    overflowOutbox.prepare(overflowRecord.intent.intentID, "worker"),
    /overflows the safe integer range/
  )
  assert.throws(
    () =>
      dispatcher(
        store,
        new FixedPreparer(),
        new RecordingBroadcaster(),
        new FixedRechecker(),
        new FixedReconciler(),
        () => 2_000,
        1_001
      ),
    /must not exceed 1000/
  )
})

test("quarantines legacy submission ambiguity and blocks post-send cancellation", async () => {
  const store = new InMemoryOutboxStore()
  const legacyRecord = {
    observationID: Hex.from(CHALLENGE_KEY),
    status: "submitting" as const,
    submissionAttempts: 1,
    challengeTxHash: Hex.from(`0x${"09".repeat(32)}`),
  } as P2TRWatchtowerChallengeRecord
  const quarantines = await quarantineLegacyP2TRSignatureFraudSubmissions(
    {
      async listChallengeRecords() {
        return [legacyRecord]
      },
    },
    store,
    3_000
  )
  assert.equal(quarantines.length, 1)
  assert.match(store.quarantines[0].reason, /must never be retried/)

  const record = await enqueue(store)
  const outbox = dispatcher(store)
  await outbox.prepare(record.intent.intentID, "worker-a")
  await outbox.broadcast(record.intent.intentID)
  await assert.rejects(
    outbox.cancelBeforeBroadcast(record.intent.intentID, "operator request"),
    /only before signer invocation/
  )
})
