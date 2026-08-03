import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto"

export const P2TR_PRODUCTION_ACTIVATION_SCHEMA =
  "tbtc-p2tr-fraud-production-activation/v2" as const

export const P2TR_ECDSA_FRAUD_ROUTER_CURRENT_V3 =
  "0x35a446ffef8a2299061382519986bc72b6129928ebe5438078d31d0fb94960fc" as const
export const P2TR_ECDSA_EMPTY_CHALLENGE_SET_HASH =
  "0xc6df19a9e5cc2e1575f8bc5ee97cc5b352e49114c858bb010d9874784ccd5fc7" as const

const ZERO_WORD = `0x${"00".repeat(32)}`
const ZERO_ADDRESS = `0x${"00".repeat(20)}`

export type P2TRActivationMigrationBinding = {
  version: number
  name: string
  checksum: string
}

export type P2TRProductionEthereumPoint = {
  blockNumber: number
  blockHash: string
}

export type P2TRProductionEthereumEventPoint = P2TRProductionEthereumPoint & {
  transactionHash: string
  transactionIndex: number
  logIndex: number
}

export type P2TRProductionBitcoinPoint = {
  height: number
  hash: string
}

export type P2TRActivationLinkReference = {
  /** Byte offset in the exact immutable/library or proxy-implementation runtime. */
  start: number
  length: 20
}

export type P2TRActivationLinkedLibraryBinding = {
  /** Compiler-pinned fully qualified library role, e.g. source.sol:Deposit. */
  protocolRole: string
  address: string
  runtimeCodeHash: string
  references: readonly P2TRActivationLinkReference[]
  linkedLibraryDescriptorHash: string
  linkedLibraries: readonly P2TRActivationLinkedLibraryBinding[]
}

export type P2TRActivationContractBinding = {
  address: string
  runtimeCodeHash: string
  protocolID: string
  deploymentBlock: number
  relevantEventStartBlock: number
  bridgeAddress?: string
  signingPolicyHash?: string
  linkedLibraryDescriptorHash: string
  linkedLibraries: readonly P2TRActivationLinkedLibraryBinding[]
  upgradeability:
    | { kind: "immutable" }
    | {
        kind: "eip1967"
        implementationAddress: string
        implementationRuntimeCodeHash: string
        adminAddress: string
        adminRuntimeCodeHash: string
        implementationSlotValue: string
        adminSlotValue: string
      }
}

export type P2TRProductionEcdsaCutover =
  | {
      mode: "fresh"
      scanStartBlock: number
      routerAddress: string
      routerRuntimeCodeHash: string
      finalizedAtBlock: number
      routerOpenChallengeCount: "0"
      bridgeLegacyChallengeCount: "0"
    }
  | {
      mode: "migrated"
      scanStartBlock: number
      previousRouterAddress: string
      previousRouterRuntimeCodeHash: string
      replacementRouterAddress: string
      cutoverCoordinatorAddress: string
      migrationManifestHash: string
      inventoryCommitment: string
      postMigrationCommitment: string
      challengeSetHash: string
      challengeCount: number
      totalEscrow: string
      migrationFinalizedBlock: number
      phase: "finalized"
      previousRouterOpenChallengeCount: "0"
      bridgeLegacyChallengeCount: "0"
    }

export type P2TRCompleteDepositKeyInventory = {
  /** Point at which both storage and the complete event inventory were read. */
  finalizedPoint: P2TRProductionEthereumPoint
  /** Root over sorted (funding outpoint, stored output key, commitment) tuples. */
  inventoryRoot: string
  storedOutputKeyRoot: string
  commitmentOutputKeyRoot: string
  inventoryCount: number
  /** Any such deposit makes COMPLETE proof processing unsafe. */
  commitmentOnlyCustodyCount: 0
  eventCursor: P2TRProductionEthereumPoint
}

export type P2TRFrostArchiveReadback = {
  mode: "fresh" | "migrated"
  finalizedPoint: P2TRProductionEthereumPoint
  backfillManifestHash: string
  closedWalletTombstoneRoot: string
  closedWalletTombstoneCount: number
  readbackTombstoneRoot: string
  readbackTombstoneCount: number
  frostInactivityAddress: string
  frostInactivityRuntimeCodeHash: string
  registryFrostInactivityAddress: string
  activeOnlyGetWalletSemantics: true
}

export const P2TR_FROST_WALLET_GROUP_INVENTORY_SCHEMA =
  "tbtc-p2tr-frost-wallet-group-inventory/v1" as const

/**
 * One retained FROST group that can still participate in authorization or in
 * reconciliation of already-authorized work. Closed/Closing history is not
 * omitted merely because the active-only registry getter no longer returns it.
 */
export type P2TRFrostWalletGroupInventoryEntry = {
  walletID: string
  retainedGroupHash: string
  actualGroupSize: number
  lifecycle: "live" | "moving-funds" | "closing" | "closed" | "terminated"
  creationPoint: P2TRProductionEthereumEventPoint
  bridgeRegistrationPoint: P2TRProductionEthereumEventPoint
  lifecyclePoint: P2TRProductionEthereumEventPoint
  registryClosurePoint?: P2TRProductionEthereumEventPoint
}

export type P2TRFrostWalletGroupInventory = {
  schema: typeof P2TR_FROST_WALLET_GROUP_INVENTORY_SCHEMA
  point: P2TRProductionEthereumPoint
  /** Monotonic keep-core snapshot generation reconstructed from canonical events. */
  snapshotGeneration: number
  inventoryRoot: string
  walletCount: number
  minimumActualGroupSize: number
  maximumActualGroupSize: number
  membershipAmbiguityCount: 0
  groupSizeViolationCount: 0
  complete: true
}

/**
 * Canonical inventory algorithm shared by the two receipt-complete Ethereum
 * readers and the keep-core handshake. The aggregate deliberately commits the
 * lifecycle and creation point, not just the current active registry view.
 */
export function computeP2TRFrostWalletGroupInventory(
  point: P2TRProductionEthereumPoint,
  snapshotGeneration: number,
  entries: readonly P2TRFrostWalletGroupInventoryEntry[]
): P2TRFrostWalletGroupInventory {
  const normalizedPoint = ethereumPoint(point, "FROST inventory point")
  const generation = nonNegativeInteger(
    snapshotGeneration,
    "FROST inventory snapshot generation"
  )
  const normalizedEntries = entries
    .map((entry) =>
      normalizeFrostWalletGroupInventoryEntry(entry, normalizedPoint)
    )
    .sort((left, right) => compareASCII(left.walletID, right.walletID))
  for (let index = 1; index < normalizedEntries.length; index++) {
    if (
      normalizedEntries[index - 1].walletID ===
      normalizedEntries[index].walletID
    ) {
      throw new Error(
        "FROST retained-group inventory has ambiguous wallet membership"
      )
    }
  }
  let accumulator = createHash("sha256")
    .update("tbtc-p2tr-frost-wallet-group-inventory-entries-v1\0", "utf8")
    .digest()
  for (const entry of normalizedEntries) {
    const leaf = createHash("sha256")
      .update("tbtc-p2tr-frost-wallet-group-inventory-leaf-v1\0", "utf8")
      .update(canonicalJSON(entry), "utf8")
      .digest()
    accumulator = createHash("sha256")
      .update("tbtc-p2tr-frost-wallet-group-inventory-node-v1\0", "utf8")
      .update(accumulator)
      .update(leaf)
      .digest()
  }
  const sizes = normalizedEntries.map((entry) => entry.actualGroupSize)
  return {
    schema: P2TR_FROST_WALLET_GROUP_INVENTORY_SCHEMA,
    point: normalizedPoint,
    snapshotGeneration: generation,
    inventoryRoot: `0x${createHash("sha256")
      .update("tbtc-p2tr-frost-wallet-group-inventory-root-v1\0", "utf8")
      .update(
        canonicalJSON({
          point: normalizedPoint,
          snapshotGeneration: generation,
          walletCount: normalizedEntries.length,
        }),
        "utf8"
      )
      .update(accumulator)
      .digest("hex")}`,
    walletCount: normalizedEntries.length,
    minimumActualGroupSize: sizes.length === 0 ? 0 : Math.min(...sizes),
    maximumActualGroupSize: sizes.length === 0 ? 0 : Math.max(...sizes),
    membershipAmbiguityCount: 0,
    groupSizeViolationCount: 0,
    complete: true,
  }
}

export type P2TRProductionActivationManifest = {
  schema: typeof P2TR_PRODUCTION_ACTIVATION_SCHEMA
  activationSequence: number
  activationID: string
  environment: string
  migrations: readonly P2TRActivationMigrationBinding[]
  bitcoin: {
    network: string
    genesisHash: string
    /** Production coverage always starts at genesis, never a later checkpoint. */
    checkpoint: { height: 0; hash: string }
    confirmationDepth: number
    configurationFingerprint: string
    storeID: string
    indexSourceTrustDomainID: string
    indexSourceEndpointFingerprint: string
    indexSourceOperatorFingerprint: string
    reconciliationTrustDomainID: string
    reconciliationEndpointFingerprint: string
    reconciliationOperatorFingerprint: string
    maxReconciliationLagBlocks: number
    maxIndexLagBlocks: number
  }
  ethereum: {
    chainID: number
    checkpoint: P2TRProductionEthereumPoint
    /** Scanned inclusively; checkpoint must be exactly its predecessor. */
    scanStartBlock: number
    confirmationDepth: number
    maxJournalLagBlocks: number
    configurationFingerprint: string
    descriptorSetHash: string
    linkedLibraryDescriptorSetHash: string
    storeID: string
    sourceTrustDomainID: string
    sourceEndpointFingerprint: string
    sourceOperatorFingerprint: string
    sourceHistoryStoreID: string
    sourceHistoryStoreFingerprint: string
    sourceHistoryClusterFingerprint: string
    verifierTrustDomainID: string
    verifierEndpointFingerprint: string
    verifierOperatorFingerprint: string
    verifierHistoryStoreID: string
    verifierHistoryStoreFingerprint: string
    verifierHistoryClusterFingerprint: string
    contracts: {
      bridge: P2TRActivationContractBinding
      completeRouter: P2TRActivationContractBinding
      authorizationRegistry: P2TRActivationContractBinding
      frostWalletRegistry: P2TRActivationContractBinding
      frostProposalValidator: P2TRActivationContractBinding
      frostSortitionPool: P2TRActivationContractBinding
      ecdsaFraudRouter: P2TRActivationContractBinding
      ecdsaCutoverCoordinator: P2TRActivationContractBinding
    }
    completeDepositKeyInventory: P2TRCompleteDepositKeyInventory
    frostArchive: P2TRFrostArchiveReadback
  }
  ecdsaCutover: P2TRProductionEcdsaCutover
  outbox: {
    storeID: string
    protocolID: string
    sender: string
    routerAddress: string
    implementationCodeHash: string
    databaseConstraintHash: string
    attestationSignerKeyHash: string
    handshakeEndpointFingerprint: string
    handshakeOperatorFingerprint: string
    signerTrustDomainID: string
    broadcastTrustDomainID: string
    reconciliationTrustDomainID: string
    preparedTransactionPersistence: "durable-before-broadcast"
    replacementPolicy: "append-only-same-intent-fee-bump-v1"
    migrationVersion: 3
    migrationChecksum: string
    maxActiveOutboxRecords: number
    maxRecoveryBacklog: number
    senderLanes: readonly {
      laneID: string
      trustDomainID: string
      operatorFingerprint: string
    }[]
  }
  frostSigner: {
    trustDomainID: string
    durableSessionStoreFingerprint: string
    protocolID: string
    reservationProtocolID: string
    bitcoinOutboxProtocolID: string
    signingPolicyHash: string
    completeRouterAddress: string
    authorizationRegistryAddress: string
    attestationSignerKeyHash: string
    handshakeEndpointFingerprint: string
    handshakeOperatorFingerprint: string
    threshold: 51
    maximumGroupSize: 100
    retainedGroupInventoryProtocolID: string
    canonicalJournal: {
      storeID: string
      storeFingerprint: string
      clusterFingerprint: string
      checkpoint: P2TRProductionEthereumPoint
      descriptorSetHash: string
      sourceTrustDomainID: string
      sourceEndpointFingerprint: string
      sourceOperatorFingerprint: string
      minimumGeneration: number
    }
    quarantineJournal: {
      protocolID: string
      storeID: string
      storeFingerprint: string
      clusterFingerprint: string
      minimumGeneration: number
    }
    exactRetainedGroupInventoryRequired: true
    finalizedReservationReceiptRequired: true
    exactReservationIdentityRequired: true
    authorizationRootRequired: true
    durableSessionPersistenceRequired: true
    durableBitcoinOutboxRequired: true
    quarantineFailClosed: true
  }
}

export type P2TRProductionActivationEnvelope = {
  payload: P2TRProductionActivationManifest
  payloadSha256: string
  signatureAlgorithm: "ed25519"
  signerPublicKeySpki: string
  signature: string
}

export type P2TRProductionActivationExpectedProtocols = {
  completeRouterProtocolID: string
  authorizationRegistryProtocolID: string
  authorizationSigningPolicyHash: string
  frostWalletRegistryProtocolID: string
  frostProposalValidatorProtocolID: string
  frostSortitionPoolProtocolID: string
  ecdsaFraudRouterProtocolID: string
  ecdsaCutoverProtocolID: string
  outboxProtocolID: string
  frostSignerProtocolID: string
  frostReservationProtocolID: string
  frostBitcoinOutboxProtocolID: string
  frostRetainedGroupInventoryProtocolID: string
  frostCanonicalJournalDescriptorSetHash: string
  frostQuarantineJournalProtocolID: string
  descriptorSetHash: string
  linkedLibraryDescriptorSetHash: string
}

export type P2TRProductionProviderIdentity = {
  readonly trustDomainID: string
  readonly providerIdentity: object
  /** Hash of normalized endpoint transport identity. */
  readonly endpointFingerprint: string
  /** Hash of independently operated infrastructure/account ownership. */
  readonly operatorFingerprint: string
}

export type P2TRProductionEthereumState = {
  point: P2TRProductionEthereumPoint
  contracts: P2TRProductionActivationManifest["ethereum"]["contracts"]
  ecdsaCutover: P2TRProductionEcdsaCutover
  bridgeBindings: {
    p2trFraudRouter: string
    ecdsaFraudRouter: string
    frostWalletRegistry: string
    completeAuthorizationRegistry: string
    ecdsaRetired: true
  }
  completeDepositKeyInventory: P2TRCompleteDepositKeyInventory
  frostArchive: P2TRFrostArchiveReadback
  frostWalletGroupInventory: P2TRFrostWalletGroupInventory
  /** Digest/count of every required event from scanStartBlock through point. */
  requiredEventHistoryDigest: string
  requiredEventCount: number
  requiredEventCoverage: P2TREthereumHistoryCoverageCounters
}

export type P2TRProductionEthereumHistoryState = Pick<
  P2TRProductionEthereumState,
  | "point"
  | "requiredEventHistoryDigest"
  | "requiredEventCount"
  | "requiredEventCoverage"
>

export type P2TRProductionEthereumProvider = P2TRProductionProviderIdentity & {
  /** Durable receipt-complete history store pinned by the signed manifest. */
  readonly historyStoreID: string
  readonly historyStoreFingerprint: string
  readonly historyClusterFingerprint: string
  getChainID(): Promise<number>
  getFinalizedPoint(
    confirmationDepth: number
  ): Promise<P2TRProductionEthereumPoint>
  getBlockHash(blockNumber: number): Promise<string>
  readHistoryState(
    point: P2TRProductionEthereumPoint,
    scanStartBlock: number
  ): Promise<P2TRProductionEthereumHistoryState>
  readActivationState(
    point: P2TRProductionEthereumPoint,
    scanStartBlock: number
  ): Promise<P2TRProductionEthereumState>
}

export type P2TRProductionBitcoinState = {
  network: string
  genesisHash: string
  txIndex: true
  unpruned: true
  synchronized: true
  finalizedThrough: P2TRProductionBitcoinPoint
}

export type P2TRProductionBitcoinCandidateTransactionIdentity = {
  txid: string
  wtxid: string
  blockHeight: number
  blockHash: string
}

export type P2TRProductionBitcoinCandidateIdentity =
  P2TRProductionBitcoinCandidateTransactionIdentity & {
    /** Exact canonical input occurrence authorized for enqueue. */
    inputIndex: number
    observationID: string
    challengeKey: string
  }

export type P2TRProductionBitcoinCandidate =
  P2TRProductionBitcoinCandidateIdentity

export type P2TRProductionBitcoinCandidateAttestation =
  P2TRProductionBitcoinCandidateTransactionIdentity & {
    inputIndex: number
    finalizedThrough: P2TRProductionBitcoinPoint
    present: true
  }

export type P2TRProductionBitcoinEvidenceProvider =
  P2TRProductionProviderIdentity & {
    readState(confirmationDepth: number): Promise<P2TRProductionBitcoinState>
    getBlockHash(height: number): Promise<string>
    attestCandidate(
      candidate: P2TRProductionBitcoinCandidateIdentity,
      confirmationDepth: number
    ): Promise<P2TRProductionBitcoinCandidateAttestation>
  }

export type P2TRProductionBitcoinIndexHealth = {
  storeID: string
  configurationFingerprint: string
  network: string
  checkpoint: P2TRProductionBitcoinPoint
  current: P2TRProductionBitcoinPoint
  /** With a genesis checkpoint this must equal current.height + 1. */
  canonicalBlockCount: number
  pendingCandidates: number
  pendingDepositReveals: number
  unmatchedProofs: number
  liveCandidateAuthorizations: number
  unbackfilledFrostWalletBindings: number
  failureGeneration: number
  clearedFailureGeneration: number
}

export type P2TRProductionRuntimeAlertHealth = {
  manifestHash: string
  unresolvedCandidateEnqueueTransactionGuardCount: number
  candidateEnqueueRetryExhaustionCount: number
}

export type P2TRProductionEthereumJournalHealth = {
  storeID: string
  chainID: number
  configurationFingerprint: string
  descriptorSetHash: string
  checkpoint: P2TRProductionEthereumPoint
  scanStartBlock: number
  current: P2TRProductionEthereumPoint
  requiredEventHistoryDigest: string
  requiredEventCount: number
  requiredEventCoverage: P2TREthereumHistoryCoverageCounters
  failureGeneration: number
  clearedFailureGeneration: number
}

export type P2TRProductionMigrationReadback = {
  listAppliedMigrations(): Promise<readonly P2TRActivationMigrationBinding[]>
}

export type P2TRProductionSignedHandshake<State> = {
  payload: {
    kind: "outbox" | "frost-signer"
    nonce: string
    manifestHash: string
    ethereumPoint: P2TRProductionEthereumPoint
    state: State
  }
  signerPublicKeySpki: string
  signature: string
}

export type P2TRProductionAttestationKeyProvider = {
  readonly signerPublicKeySpki: string
  signP2TRActivationPayload(payloadBytes: Uint8Array): Promise<Uint8Array>
}

export function canonicalizeP2TRProductionSignedHandshakePayload<State>(
  payload: P2TRProductionSignedHandshake<State>["payload"]
): string {
  return canonicalJSON(payload)
}

export function encodeP2TRProductionSignedHandshakePayload<State>(
  payload: P2TRProductionSignedHandshake<State>["payload"]
): Uint8Array {
  return Buffer.from(
    canonicalizeP2TRProductionSignedHandshakePayload(payload),
    "utf8"
  )
}

export type P2TRProductionOutboxHandshakeState = {
  storeID: string
  protocolID: string
  sender: string
  routerAddress: string
  implementationCodeHash: string
  databaseConstraintHash: string
  preparedTransactionPersistence: "durable-before-broadcast"
  replacementPolicy: "append-only-same-intent-fee-bump-v1"
  migrationVersion: 3
  migrationChecksum: string
  startupReconciliationComplete: boolean
  ambiguousTransactionCount: number
  activationBlockingCriticalAlertCount: number
  unresolvedLegacyQuarantineCount: number
  recoveryBacklogCount: number
  liveCandidateAuthorizationCount: number
  activeGenerationCount: number
  configuredSignerLaneCount: number
  configuredSignerLaneSetHash: string
  senderLanes: readonly {
    laneID: string
    trustDomainID: string
    operatorFingerprint: string
    healthy: boolean
  }[]
  healthy: boolean
}

export type P2TRProductionFrostHandshakeState = {
  protocolID: string
  reservationProtocolID: string
  bitcoinOutboxProtocolID: string
  signingPolicyHash: string
  durableSessionStoreFingerprint: string
  completeRouterAddress: string
  authorizationRegistryAddress: string
  threshold: 51
  maximumGroupSize: 100
  retainedGroupInventoryProtocolID: string
  frostWalletGroupInventory: P2TRFrostWalletGroupInventory
  canonicalJournal: {
    storeID: string
    storeFingerprint: string
    clusterFingerprint: string
    checkpoint: P2TRProductionEthereumPoint
    current: P2TRProductionEthereumPoint
    descriptorSetHash: string
    sourceTrustDomainID: string
    sourceEndpointFingerprint: string
    sourceOperatorFingerprint: string
    generation: number
    complete: true
  }
  quarantineJournal: {
    protocolID: string
    storeID: string
    storeFingerprint: string
    clusterFingerprint: string
    root: string
    generation: number
    currentQuarantineCount: 0
    complete: true
  }
  finalizedReservationReadbackEnforced: true
  exactTransactionAuthorizationRootEnforced: true
  nonceShareGateEnforced: true
  durableBitcoinOutboxRecovered: true
  quarantineFailClosed: true
  healthy: true
}

export type P2TRProductionSignedHandshakeProvider<State> =
  P2TRProductionProviderIdentity & {
    attestActivationChallenge(challenge: {
      nonce: string
      manifestHash: string
      ethereumPoint: P2TRProductionEthereumPoint
    }): Promise<P2TRProductionSignedHandshake<State>>
  }

export type P2TRProductionCandidateAuthorizationReceipt = {
  tokenID: string
  manifestHash: string
  candidateDigest: string
  candidate: P2TRProductionBitcoinCandidate
  readinessCertificate: P2TRProductionReadinessCertificateReference
  verifiedBitcoin: P2TRProductionBitcoinPoint
  verifiedEthereum: P2TRProductionEthereumPoint
  expiresAt: string
}

export type P2TRProductionReadinessCertificateReference = {
  certificateID: string
  generation: number
}

export type P2TRProductionReadinessCertificateInput = {
  manifestHash: string
  verifiedBitcoin: P2TRProductionBitcoinPoint
  verifiedEthereum: P2TRProductionEthereumPoint
  bitcoinIndex: P2TRProductionBitcoinIndexHealth
  ethereumJournal: P2TRProductionEthereumJournalHealth
  /** Complete normalized read set already checked by the activation gate. */
  payload: Readonly<Record<string, unknown>>
}

export type P2TRProductionCandidateEnqueueRetryExhaustionAlert = {
  tokenID: string
  manifestHash: string
  candidateDigest: string
  attemptCount: number
  lastSQLState: "40001" | "40P01" | "55P03" | "57014"
}

export type P2TRProductionCandidateEnqueueRetryExhaustionResolution = {
  tokenID: string
  manifestHash: string
  candidateDigest: string
  /** Digest of the independently retained operator resolution evidence. */
  resolutionDigest: string
  reason: string
  resolvedAtUnixMs: number
}

export type P2TRProductionCandidateEnqueueManifestRotationResolution = {
  tokenID: string
  manifestHash: string
  candidateDigest: string
  /** Digest of independently retained evidence for the abandoned candidate. */
  resolutionDigest: string
  reason: string
  resolvedAtUnixMs: number
}

export type P2TRProductionCandidateEnqueueTransactionGuard = {
  tokenID: string
  manifestHash: string
  candidateDigest: string
  maxAttemptCount: number
}

export type P2TRProductionCandidateEnqueueTransactionRecovery = {
  guard: P2TRProductionCandidateEnqueueTransactionGuard
  authorization: P2TRProductionCandidateAuthorizationReceipt
}

export type P2TRProductionCandidateEnqueueTransactionResolution = {
  tokenID: string
  manifestHash: string
  candidateDigest: string
  outboxIntentID: string
  outcomeKind: P2TRProductionCandidateEnqueueOutcome["kind"]
}

export type P2TRProductionCandidateEnqueueNonRetryableFailure = {
  tokenID: string
  manifestHash: string
  candidateDigest: string
  /** Bounded, one-way digest of the application failure; raw details stay local. */
  failureDigest: string
}

/**
 * The outbox facts the readiness transaction re-derives for itself. The signed
 * handshake is sampled in the outbox's own committed transaction, so between
 * that sample and the certificate insert the outbox can transition into a
 * state the sample never saw. The coordinator acquires the exclusive readiness
 * fence before opening this transaction's SERIALIZABLE snapshot, while every
 * ordinary transaction acquires the shared side before its own snapshot.
 * Re-reading these facts under that fence binds the certificate to the state
 * after every earlier writer and before every later writer.
 */
export type P2TRProductionOutboxRevalidation = {
  activationBlockingCriticalAlertCount: number
  ambiguousTransactionCount: number
  unresolvedLegacyQuarantineCount: number
  recoveryBacklogCount: number
  activeGenerationCount: number
  configuredSignerLaneCount: number
  configuredSignerLaneSetHash: string
  quarantinedSignerLaneCount: number
  activeOldManifestGenerationCount: number
  staleManifestGenerationSuccessorCount: number
  activeSignerInvocationCount: number
  activeNonceReleaseAttemptCount: number
}

export type P2TRProductionStateStore = {
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  lockReadinessSnapshot(): Promise<void>
  readBitcoinIndexHealth(): Promise<P2TRProductionBitcoinIndexHealth>
  readEthereumJournalHealth(): Promise<P2TRProductionEthereumJournalHealth>
  readOutboxRevalidation(
    manifestHash: string,
    sampledAtUnixMs: number
  ): Promise<P2TRProductionOutboxRevalidation>
  mintReadinessCertificate(
    input: P2TRProductionReadinessCertificateInput
  ): Promise<P2TRProductionReadinessCertificateReference>
  readRuntimeAlertHealth(): Promise<P2TRProductionRuntimeAlertHealth>
  assertCandidateIndexed(
    candidate: P2TRProductionBitcoinCandidate
  ): Promise<void>
  issueCandidateAuthorization(
    receipt: P2TRProductionCandidateAuthorizationReceipt
  ): Promise<void>
  lockCandidateAuthorization(
    tokenID: string,
    candidateDigest: string,
    manifestHash: string
  ): Promise<void>
  consumeCandidateAuthorization(
    tokenID: string,
    outboxIntentID: string,
    manifestHash: string
  ): Promise<void>
  saveCandidateEnqueueRetryExhaustionAlert(
    alert: P2TRProductionCandidateEnqueueRetryExhaustionAlert
  ): Promise<void>
  resolveCandidateEnqueueRetryExhaustionAlert(
    resolution: P2TRProductionCandidateEnqueueRetryExhaustionResolution
  ): Promise<void>
  resolveCandidateEnqueueManifestRotationDisposition(
    resolution: P2TRProductionCandidateEnqueueManifestRotationResolution
  ): Promise<void>
  saveCandidateEnqueueNonRetryableFailure(
    failure: P2TRProductionCandidateEnqueueNonRetryableFailure
  ): Promise<void>
  armCandidateEnqueueTransactionGuard(
    guard: P2TRProductionCandidateEnqueueTransactionGuard
  ): Promise<void>
  listUnresolvedCandidateEnqueueTransactionGuards(): Promise<
    readonly P2TRProductionCandidateEnqueueTransactionRecovery[]
  >
  resolveCandidateEnqueueTransactionGuard(
    resolution: P2TRProductionCandidateEnqueueTransactionResolution
  ): Promise<void>
}

/** Database-only enqueue participant. Signing and broadcast I/O are forbidden
 * here because this complete operation may be replayed after PostgreSQL aborts
 * the outer serializable transaction. */
export type P2TRProductionCandidateEnqueuer = {
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  enqueueReconciledCandidate(
    candidate: P2TRProductionBitcoinCandidate,
    authorization: P2TRProductionCandidateAuthorizationReceipt
  ): Promise<P2TRProductionCandidateEnqueueOutcome>
}

/**
 * The enqueuer must not throw after durably recording a generation-cap alert.
 * This outcome crosses the activation gate's outer transaction so the alert
 * and the one-use authorization disposition commit together before the caller
 * is told that no new generation could be queued.
 */
export type P2TRProductionCandidateEnqueueOutcome =
  | {
      kind: "enqueued"
      outboxIntentID: string
    }
  | {
      kind: "generation-cap-exhausted"
      /** Existing capped outbox intent that durably explains the disposition. */
      outboxIntentID: string
      message: string
    }

export class P2TRProductionCandidateEnqueueRejectedError extends Error {
  readonly code = "generation-cap-exhausted" as const

  constructor(readonly outboxIntentID: string, message: string) {
    super(message)
    this.name = "P2TRProductionCandidateEnqueueRejectedError"
  }
}

export class P2TRProductionCandidateEnqueueRetryExhaustedError extends Error {
  readonly code = "candidate-enqueue-transaction-retry-exhausted" as const
  readonly activationBlocking = true as const

  constructor(
    readonly alert: P2TRProductionCandidateEnqueueRetryExhaustionAlert,
    options?: ErrorOptions
  ) {
    super(
      `Candidate authorization and enqueue transaction exhausted ${alert.attemptCount} transaction attempts after PostgreSQL ${alert.lastSQLState}`,
      options
    )
    this.name = "P2TRProductionCandidateEnqueueRetryExhaustedError"
  }
}

export type P2TRProductionTransactionCoordinator = {
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID: string
  runInP2TRSignatureFraudWatchtowerTransaction<T>(
    operation: () => Promise<T>,
    options?: {
      readinessFence?: "shared" | "exclusive"
    }
  ): Promise<T>
  assertP2TRSignatureFraudWatchtowerTransactionalParticipants(
    participants: readonly object[]
  ): void
  readP2TRSignatureFraudWatchtowerRetryableTransactionSQLState(
    error: unknown
  ):
    | P2TRProductionCandidateEnqueueRetryExhaustionAlert["lastSQLState"]
    | undefined
  isP2TRSignatureFraudWatchtowerTransactionOutcomeUnknown(
    error: unknown
  ): boolean
  isP2TRSignatureFraudWatchtowerTransactionConfirmedPreCommitTransportAbort(
    error: unknown
  ): boolean
  isP2TRSignatureFraudWatchtowerTransactionActive(): boolean
}

export type P2TRProductionActivationDependencies = {
  ethereumSource: P2TRProductionEthereumProvider
  ethereumVerifier: P2TRProductionEthereumProvider
  bitcoinIndexSource: P2TRProductionBitcoinEvidenceProvider
  bitcoinReconciler: P2TRProductionBitcoinEvidenceProvider
  migrations: P2TRProductionMigrationReadback
  stateStore: P2TRProductionStateStore
  outboxHandshake: P2TRProductionSignedHandshakeProvider<P2TRProductionOutboxHandshakeState>
  frostSignerHandshake: P2TRProductionSignedHandshakeProvider<P2TRProductionFrostHandshakeState>
  candidateEnqueuer: P2TRProductionCandidateEnqueuer
  transactionCoordinator: P2TRProductionTransactionCoordinator
}

export type P2TRProductionActivationGateOptions = {
  trustedManifestSignerKeyHash: string
  expectedProtocols: P2TRProductionActivationExpectedProtocols
  candidateAuthorizationLifetimeMs?: number
  candidateEnqueueTransactionMaxAttempts?: number
}

export type P2TRProductionReadySnapshot = {
  manifestHash: string
  verifiedEthereum: P2TRProductionEthereumPoint
  verifiedBitcoin: P2TRProductionBitcoinPoint
  readinessCertificate: P2TRProductionReadinessCertificateReference
}

const candidateTokenBrand: unique symbol = Symbol("P2TRCandidateAuthorization")
export type P2TRProductionCandidateAuthorizationToken = {
  readonly [candidateTokenBrand]: true
}

type CandidateTokenRecord = {
  receipt: P2TRProductionCandidateAuthorizationReceipt
  consumed: boolean
}

const DEFAULT_CANDIDATE_AUTHORIZATION_LIFETIME_MS = 60_000
const DEFAULT_CANDIDATE_ENQUEUE_TRANSACTION_MAX_ATTEMPTS = 3
const MAX_CANDIDATE_ENQUEUE_TRANSACTION_ATTEMPTS = 8

/**
 * Fail-closed production gate. Readiness is recomputed at pinned chain points;
 * candidate authorization is exact, short-lived, one-use, durable, and consumed
 * in the same PostgreSQL transaction as outbox enqueue.
 */
export class P2TRProductionActivationGate {
  readonly manifest: Readonly<P2TRProductionActivationManifest>
  readonly manifestHash: string
  private readonly candidateAuthorizationLifetimeMs: number
  private readonly candidateEnqueueTransactionMaxAttempts: number
  private readonly candidateTokens = new WeakMap<object, CandidateTokenRecord>()
  // A readiness check replaces the singleton durable certificate. Keep that
  // authority through candidate attestation and durable authorization issue.
  private readinessAuthorityTail: Promise<void> = Promise.resolve()

  constructor(
    envelope: P2TRProductionActivationEnvelope,
    private readonly dependencies: P2TRProductionActivationDependencies,
    options: P2TRProductionActivationGateOptions
  ) {
    const verified = verifyP2TRProductionActivationEnvelope(
      envelope,
      options.trustedManifestSignerKeyHash
    )
    this.manifest = deepFreeze(deepClone(verified.payload))
    this.manifestHash = verified.payloadSha256
    this.candidateAuthorizationLifetimeMs = positiveInteger(
      options.candidateAuthorizationLifetimeMs ??
        DEFAULT_CANDIDATE_AUTHORIZATION_LIFETIME_MS,
      "candidate authorization lifetime"
    )
    this.candidateEnqueueTransactionMaxAttempts = boundedPositiveInteger(
      options.candidateEnqueueTransactionMaxAttempts ??
        DEFAULT_CANDIDATE_ENQUEUE_TRANSACTION_MAX_ATTEMPTS,
      MAX_CANDIDATE_ENQUEUE_TRANSACTION_ATTEMPTS,
      "candidate enqueue transaction attempts"
    )
    validateManifestPolicy(this.manifest, options.expectedProtocols)
    assertP2TRActivationAttestationKeySeparation({
      activationAuthorityKeyHash: options.trustedManifestSignerKeyHash,
      outboxAttestationKeyHash: this.manifest.outbox.attestationSignerKeyHash,
      frostAttestationKeyHash:
        this.manifest.frostSigner.attestationSignerKeyHash,
    })
    validateDependencyIndependence(this.manifest, dependencies)
    if (
      dependencies.stateStore
        .p2trSignatureFraudWatchtowerTransactionalStoreID !==
        this.manifest.bitcoin.storeID ||
      dependencies.candidateEnqueuer
        .p2trSignatureFraudWatchtowerTransactionalStoreID !==
        this.manifest.bitcoin.storeID ||
      dependencies.transactionCoordinator
        .p2trSignatureFraudWatchtowerTransactionalStoreID !==
        this.manifest.bitcoin.storeID
    ) {
      throw new Error("Activation dependencies do not share the manifest store")
    }
    dependencies.transactionCoordinator.assertP2TRSignatureFraudWatchtowerTransactionalParticipants(
      [dependencies.stateStore, dependencies.candidateEnqueuer]
    )
  }

  async assertReady(): Promise<P2TRProductionReadySnapshot> {
    return this.withReadinessAuthority(() => this.assertReadyUnderAuthority())
  }

  private async assertReadyUnderAuthority(): Promise<P2TRProductionReadySnapshot> {
    const ethereum = await this.readVerifiedEthereum()
    const bitcoin = await this.readVerifiedBitcoin()
    const nonce = bytes32(randomBytes(32).toString("hex"), "handshake nonce")
    const challenge = {
      nonce,
      manifestHash: this.manifestHash,
      ethereumPoint: ethereum.point,
    }
    const [outboxHandshake, frostHandshake] = await Promise.all([
      this.dependencies.outboxHandshake.attestActivationChallenge(challenge),
      this.dependencies.frostSignerHandshake.attestActivationChallenge(
        challenge
      ),
    ])
    verifySignedHandshake(
      outboxHandshake,
      "outbox",
      challenge,
      this.manifest.outbox.attestationSignerKeyHash
    )
    verifySignedHandshake(
      frostHandshake,
      "frost-signer",
      challenge,
      this.manifest.frostSigner.attestationSignerKeyHash
    )
    assertP2TRProductionOutboxHandshake(
      outboxHandshake.payload.state,
      this.manifest.outbox
    )
    assertP2TRProductionFrostHandshake(
      frostHandshake.payload.state,
      this.manifest.frostSigner,
      ethereum.frostWalletGroupInventory
    )

    const readinessCertificate =
      await this.dependencies.transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
        async () => {
          await this.dependencies.stateStore.lockReadinessSnapshot()
          const [
            migrations,
            bitcoinHealth,
            ethereumHealth,
            runtimeAlertHealth,
            outboxRevalidation,
          ] = await Promise.all([
            this.dependencies.migrations.listAppliedMigrations(),
            this.dependencies.stateStore.readBitcoinIndexHealth(),
            this.dependencies.stateStore.readEthereumJournalHealth(),
            this.dependencies.stateStore.readRuntimeAlertHealth(),
            this.dependencies.stateStore.readOutboxRevalidation(
              this.manifestHash,
              Date.now()
            ),
          ])
          // The handshake above was signed from the outbox's own committed
          // transaction. The coordinator acquired the exclusive readiness
          // fence before this SERIALIZABLE snapshot; every ordinary writer
          // acquires the shared side before its snapshot. Re-derive the safety
          // facts while that fence is held so this certificate cannot cover a
          // transition that committed before readiness or race one that began
          // while readiness was being minted.
          assertP2TRProductionOutboxRevalidation(
            outboxRevalidation,
            outboxHandshake.payload.state,
            this.manifest.outbox
          )
          assertEthereumJournalCursorHealth(
            ethereumHealth,
            this.manifest,
            ethereum
          )
          const [
            indexedCursorHash,
            reconciledCursorHash,
            verifiedEthereumJournalHistory,
          ] = await Promise.all([
            this.dependencies.bitcoinIndexSource.getBlockHash(
              bitcoinHealth.current.height
            ),
            this.dependencies.bitcoinReconciler.getBlockHash(
              bitcoinHealth.current.height
            ),
            this.readVerifiedEthereumHistory(ethereumHealth.current, ethereum),
          ])
          assertMigrationBindings(migrations, this.manifest.migrations)
          assertP2TRProductionBitcoinIndexHealth(
            bitcoinHealth,
            this.manifest,
            bitcoin.point,
            indexedCursorHash,
            reconciledCursorHash
          )
          assertP2TRProductionEthereumJournalHealth(
            ethereumHealth,
            this.manifest,
            ethereum,
            verifiedEthereumJournalHistory
          )
          assertP2TRProductionRuntimeAlertHealth(
            runtimeAlertHealth,
            this.manifestHash
          )
          return this.dependencies.stateStore.mintReadinessCertificate({
            manifestHash: this.manifestHash,
            verifiedEthereum: ethereum.point,
            verifiedBitcoin: bitcoin.point,
            bitcoinIndex: bitcoinHealth,
            ethereumJournal: ethereumHealth,
            payload: {
              schema: "tbtc-p2tr-production-readiness-certificate/v1",
              manifestHash: this.manifestHash,
              verifiedEthereumState: ethereum,
              verifiedEthereumJournalHistory,
              verifiedBitcoin: bitcoin.point,
              migrations,
              bitcoinIndex: bitcoinHealth,
              ethereumJournal: ethereumHealth,
              bitcoinCursorAttestations: {
                indexSource: bitcoinHash(
                  indexedCursorHash,
                  "indexed Bitcoin cursor block"
                ),
                reconciler: bitcoinHash(
                  reconciledCursorHash,
                  "reconciled Bitcoin cursor block"
                ),
              },
              outboxHandshake: outboxHandshake.payload,
              frostHandshake: frostHandshake.payload,
            },
          })
        },
        { readinessFence: "exclusive" }
      )

    return {
      manifestHash: this.manifestHash,
      verifiedEthereum: ethereum.point,
      verifiedBitcoin: bitcoin.point,
      readinessCertificate,
    }
  }

  async assertCandidateReconciled(
    candidate: P2TRProductionBitcoinCandidateIdentity
  ): Promise<P2TRProductionCandidateAuthorizationToken> {
    return this.withReadinessAuthority(() =>
      this.assertCandidateReconciledUnderAuthority(candidate)
    )
  }

  private async assertCandidateReconciledUnderAuthority(
    candidate: P2TRProductionBitcoinCandidateIdentity
  ): Promise<P2TRProductionCandidateAuthorizationToken> {
    const normalized = normalizeCandidate(candidate)
    const ready = await this.assertReadyUnderAuthority()
    if (normalized.blockHeight > ready.verifiedBitcoin.height) {
      throw new Error("Bitcoin candidate has not reached manifest finality")
    }
    const [indexed, reconciled] = await Promise.all([
      this.dependencies.bitcoinIndexSource.attestCandidate(
        normalized,
        this.manifest.bitcoin.confirmationDepth
      ),
      this.dependencies.bitcoinReconciler.attestCandidate(
        normalized,
        this.manifest.bitcoin.confirmationDepth
      ),
    ])
    assertCandidateAttestation(indexed, normalized, "Bitcoin index source")
    assertCandidateAttestation(
      reconciled,
      normalized,
      "independent Bitcoin reconciler"
    )
    const commonHeight = Math.min(
      indexed.finalizedThrough.height,
      reconciled.finalizedThrough.height,
      ready.verifiedBitcoin.height
    )
    if (commonHeight < normalized.blockHeight) {
      throw new Error("Bitcoin candidate is not finalized by both providers")
    }
    const [
      indexedCandidateHash,
      reconciledCandidateHash,
      indexedCommonHash,
      reconciledCommonHash,
    ] = await Promise.all([
      this.dependencies.bitcoinIndexSource.getBlockHash(normalized.blockHeight),
      this.dependencies.bitcoinReconciler.getBlockHash(normalized.blockHeight),
      this.dependencies.bitcoinIndexSource.getBlockHash(commonHeight),
      this.dependencies.bitcoinReconciler.getBlockHash(commonHeight),
    ])
    if (
      bitcoinHash(indexedCandidateHash, "indexed candidate block") !==
        normalized.blockHash ||
      bitcoinHash(reconciledCandidateHash, "reconciled candidate block") !==
        normalized.blockHash ||
      bitcoinHash(indexedCommonHash, "indexed common block") !==
        bitcoinHash(reconciledCommonHash, "reconciled common block")
    ) {
      throw new Error(
        "Bitcoin candidate is not on the providers' common finalized chain"
      )
    }

    const issuedAt = Date.now()
    const receipt: P2TRProductionCandidateAuthorizationReceipt = {
      tokenID: `0x${randomBytes(32).toString("hex")}`,
      manifestHash: this.manifestHash,
      candidateDigest: computeP2TRProductionCandidateDigest(normalized),
      candidate: normalized,
      readinessCertificate: ready.readinessCertificate,
      verifiedBitcoin: {
        height: commonHeight,
        hash: bitcoinHash(indexedCommonHash, "common finalized Bitcoin block"),
      },
      verifiedEthereum: ready.verifiedEthereum,
      expiresAt: new Date(
        issuedAt + this.candidateAuthorizationLifetimeMs
      ).toISOString(),
    }
    const token = Object.freeze({
      [candidateTokenBrand]: true as const,
    }) as P2TRProductionCandidateAuthorizationToken
    await this.dependencies.transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
      async () => {
        await this.dependencies.stateStore.assertCandidateIndexed(normalized)
        await this.dependencies.stateStore.issueCandidateAuthorization(receipt)
      },
      // Generation authority is derived from the current outbox head. Exclude
      // ordinary outbox writers before BEGIN so issuance cannot retain a
      // snapshot from before a concurrently committed head disposition.
      { readinessFence: "exclusive" }
    )
    this.candidateTokens.set(token, { receipt, consumed: false })
    return token
  }

  private async withReadinessAuthority<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const predecessor = this.readinessAuthorityTail
    let release!: () => void
    this.readinessAuthorityTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await predecessor
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async consumeCandidateAuthorization(
    token: P2TRProductionCandidateAuthorizationToken,
    candidate: P2TRProductionBitcoinCandidateIdentity
  ): Promise<string> {
    const record = this.candidateTokens.get(token)
    const normalized = normalizeCandidate(candidate)
    if (
      record === undefined ||
      record.consumed ||
      record.receipt.candidateDigest !==
        computeP2TRProductionCandidateDigest(normalized) ||
      Date.parse(record.receipt.expiresAt) <= Date.now()
    ) {
      throw new Error(
        "Candidate enqueue authorization is invalid, expired, or used"
      )
    }
    // Invalidate in memory before any await. A failed transaction requires a
    // fresh dual-provider reconciliation rather than replaying stale authority.
    record.consumed = true
    const guard: P2TRProductionCandidateEnqueueTransactionGuard = {
      tokenID: record.receipt.tokenID,
      manifestHash: record.receipt.manifestHash,
      candidateDigest: record.receipt.candidateDigest,
      maxAttemptCount: this.candidateEnqueueTransactionMaxAttempts,
    }
    // Commit the guard before entering any replayable transaction. Expiry
    // gates this transition; afterward the exact append-only guard becomes
    // the durable authority that recovery can resume after the short-lived
    // receipt expires. A crash therefore leaves a restart-visible activation
    // blocker, while a non-retryable failure or exhausted retry loop records
    // a durable terminal disposition.
    await this.armCandidateEnqueueTransactionGuardWithRetry(guard)
    const outcome = await this.runCandidateEnqueueTransactionWithRetry(
      record.receipt,
      normalized
    )
    // A generation-cap outcome may carry an alert written by a nested
    // transaction participant. Throwing in the transaction callback would
    // roll that alert and the token disposition back with the outer transaction.
    if (outcome.kind === "generation-cap-exhausted") {
      throw new P2TRProductionCandidateEnqueueRejectedError(
        outcome.outboxIntentID,
        outcome.message
      )
    }
    return outcome.outboxIntentID
  }

  /**
   * Resumes every guard that committed before a prior process exited. This is
   * called before readiness, while no runtime API can issue new candidate
   * authority. Each failed resume either writes its terminal disposition in
   * runCandidateEnqueueTransactionWithRetry or remains visible to the ensuing
   * readiness check as an activation blocker.
   */
  async recoverCandidateEnqueueTransactionGuards(): Promise<void> {
    const recoveries =
      await this.dependencies.transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
        () =>
          this.dependencies.stateStore.listUnresolvedCandidateEnqueueTransactionGuards(),
        { readinessFence: "exclusive" }
      )
    const recoveryErrors: unknown[] = []
    for (const recovery of recoveries) {
      try {
        await this.runCandidateEnqueueTransactionWithRetry(
          recovery.authorization,
          recovery.authorization.candidate,
          recovery.guard.maxAttemptCount
        )
      } catch (error) {
        recoveryErrors.push(error)
        // Continue through the complete bounded recovery set. Readiness below
        // independently rejects any guard that could not be terminalized and
        // any activation-blocking retry-exhaustion alert.
      }
    }
    if (recoveryErrors.length === 0) return
    const aggregate = new AggregateError(
      recoveryErrors,
      "Candidate enqueue guard recovery failed"
    )

    try {
      const health =
        await this.dependencies.transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
          () => this.dependencies.stateStore.readRuntimeAlertHealth(),
          { readinessFence: "exclusive" }
        )
      assertP2TRProductionRuntimeAlertHealth(health, this.manifestHash)
    } catch (readinessError) {
      throw new Error(
        readinessError instanceof Error
          ? readinessError.message
          : "Production runtime alert health failed after candidate enqueue guard recovery",
        {
          cause: aggregate,
        }
      )
    }
    // A non-retryable resume can terminalize its guard, making runtime health
    // clean while still abandoning the confirmed candidate. Fail this startup
    // attempt with the original diagnostics instead of silently discarding them.
    throw aggregate
  }

  private async armCandidateEnqueueTransactionGuardWithRetry(
    guard: P2TRProductionCandidateEnqueueTransactionGuard
  ): Promise<void> {
    for (
      let attemptCount = 1;
      attemptCount <= this.candidateEnqueueTransactionMaxAttempts;
      attemptCount++
    ) {
      let transactionCallbackStarted = false
      try {
        await this.dependencies.transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
          () => {
            transactionCallbackStarted = true
            return this.dependencies.stateStore.armCandidateEnqueueTransactionGuard(
              guard
            )
          }
        )
        return
      } catch (error) {
        if (
          this.dependencies.transactionCoordinator.isP2TRSignatureFraudWatchtowerTransactionOutcomeUnknown(
            error
          )
        ) {
          throw error
        }
        if (!transactionCallbackStarted) {
          if (attemptCount < this.candidateEnqueueTransactionMaxAttempts) {
            continue
          }
          throw error
        }
        if (
          this.dependencies.transactionCoordinator.isP2TRSignatureFraudWatchtowerTransactionConfirmedPreCommitTransportAbort(
            error
          )
        ) {
          // The coordinator confirmed that no COMMIT was issued, so the guard
          // insert rolled back completely and is safe to replay. Keep this
          // retry policy symmetric with the guarded enqueue transaction.
          if (attemptCount < this.candidateEnqueueTransactionMaxAttempts) {
            continue
          }
          throw error
        }
        const sqlState =
          this.dependencies.transactionCoordinator.readP2TRSignatureFraudWatchtowerRetryableTransactionSQLState(
            error
          )
        if (
          sqlState === undefined ||
          attemptCount === this.candidateEnqueueTransactionMaxAttempts
        ) {
          throw error
        }
      }
    }
  }

  private async runCandidateEnqueueTransactionWithRetry(
    receipt: P2TRProductionCandidateAuthorizationReceipt,
    candidate: P2TRProductionBitcoinCandidate,
    maxAttemptCount = this.candidateEnqueueTransactionMaxAttempts
  ): Promise<P2TRProductionCandidateEnqueueOutcome> {
    for (
      let attemptCount = 1;
      attemptCount <= maxAttemptCount;
      attemptCount++
    ) {
      let transactionCallbackStarted = false
      try {
        return await this.dependencies.transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
          async () => {
            transactionCallbackStarted = true
            await this.dependencies.stateStore.lockCandidateAuthorization(
              receipt.tokenID,
              receipt.candidateDigest,
              receipt.manifestHash
            )
            // A canonical rollback may occur after issuance but before enqueue.
            // Revalidate the exact candidate under the enqueue transaction lock.
            await this.dependencies.stateStore.assertCandidateIndexed(candidate)
            if (
              !this.dependencies.transactionCoordinator.isP2TRSignatureFraudWatchtowerTransactionActive()
            ) {
              throw new Error(
                "Candidate enqueue escaped its PostgreSQL transaction boundary"
              )
            }
            const outcome = normalizeCandidateEnqueueOutcome(
              await this.dependencies.candidateEnqueuer.enqueueReconciledCandidate(
                candidate,
                receipt
              )
            )
            await this.dependencies.stateStore.consumeCandidateAuthorization(
              receipt.tokenID,
              outcome.outboxIntentID,
              receipt.manifestHash
            )
            await this.dependencies.stateStore.resolveCandidateEnqueueTransactionGuard(
              {
                tokenID: receipt.tokenID,
                manifestHash: receipt.manifestHash,
                candidateDigest: receipt.candidateDigest,
                outboxIntentID: outcome.outboxIntentID,
                outcomeKind: outcome.kind,
              }
            )
            return outcome
          },
          // A certificate can become stale when an outbox blocker commits
          // after issuance. Acquire the exclusive pre-snapshot fence before
          // BEGIN, revalidate live outbox health while locking the token, and
          // keep every ordinary writer behind this enqueue commit.
          { readinessFence: "exclusive" }
        )
      } catch (error) {
        if (
          this.dependencies.transactionCoordinator.isP2TRSignatureFraudWatchtowerTransactionOutcomeUnknown(
            error
          )
        ) {
          // The enqueue, authorization consumption, and guard resolution may
          // all have committed. Preserve the original ambiguous outcome and
          // leave the durable guard for operator/restart reconciliation.
          throw error
        }
        if (!transactionCallbackStarted) {
          // pool.connect and connection/setup failures before the transaction
          // callback are confirmed not to have run the enqueue. Retry them
          // within the bounded budget, and leave the guard unresolved if the
          // budget is exhausted so restart recovery can try again. They must
          // never be recorded as terminal application failures.
          if (attemptCount < maxAttemptCount) continue
          throw error
        }
        if (
          this.dependencies.transactionCoordinator.isP2TRSignatureFraudWatchtowerTransactionConfirmedPreCommitTransportAbort(
            error
          )
        ) {
          // No COMMIT was issued, so replaying the complete database-only
          // transaction is safe. If the bounded budget is exhausted, fall
          // through to the append-only failure disposition below so the armed
          // guard retains a durable explanation instead of wedging recovery.
          if (attemptCount < maxAttemptCount) continue
        }
        const lastSQLState =
          this.dependencies.transactionCoordinator.readP2TRSignatureFraudWatchtowerRetryableTransactionSQLState(
            error
          )
        if (lastSQLState === undefined) {
          const failure: P2TRProductionCandidateEnqueueNonRetryableFailure = {
            tokenID: receipt.tokenID,
            manifestHash: receipt.manifestHash,
            candidateDigest: receipt.candidateDigest,
            failureDigest: candidateEnqueueNonRetryableFailureDigest(error),
          }
          // The failed attempt has fully rolled back. Resolve the previously
          // committed capacity guard in a fresh append-only transaction while
          // retaining a restart-visible account of why no enqueue committed.
          await this.dependencies.transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
            () =>
              this.dependencies.stateStore.saveCandidateEnqueueNonRetryableFailure(
                failure
              )
          )
          throw error
        }
        if (attemptCount < maxAttemptCount) {
          continue
        }
        const alert: P2TRProductionCandidateEnqueueRetryExhaustionAlert = {
          tokenID: receipt.tokenID,
          manifestHash: receipt.manifestHash,
          candidateDigest: receipt.candidateDigest,
          attemptCount,
          lastSQLState,
        }
        // The failed attempt has fully unwound. Persist the blocker in a fresh
        // transaction so it survives both this process and the final error.
        await this.dependencies.transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
          () =>
            this.dependencies.stateStore.saveCandidateEnqueueRetryExhaustionAlert(
              alert
            )
        )
        throw new P2TRProductionCandidateEnqueueRetryExhaustedError(alert, {
          cause: error,
        })
      }
    }
    throw new Error("Candidate enqueue transaction retry bound is unreachable")
  }

  private async readVerifiedEthereum(): Promise<P2TRProductionEthereumState> {
    const manifest = this.manifest.ethereum
    const [sourceChainID, verifierChainID, sourceFinalized, verifierFinalized] =
      await Promise.all([
        this.dependencies.ethereumSource.getChainID(),
        this.dependencies.ethereumVerifier.getChainID(),
        this.dependencies.ethereumSource.getFinalizedPoint(
          manifest.confirmationDepth
        ),
        this.dependencies.ethereumVerifier.getFinalizedPoint(
          manifest.confirmationDepth
        ),
      ])
    if (
      sourceChainID !== manifest.chainID ||
      verifierChainID !== manifest.chainID
    ) {
      throw new Error("Ethereum provider chain ID mismatch")
    }
    const commonBlock = Math.min(
      ethereumPoint(sourceFinalized, "source finalized point").blockNumber,
      ethereumPoint(verifierFinalized, "verifier finalized point").blockNumber
    )
    if (commonBlock < manifest.checkpoint.blockNumber) {
      throw new Error("Ethereum checkpoint is not finalized")
    }
    const [sourceHash, verifierHash] = await Promise.all([
      this.dependencies.ethereumSource.getBlockHash(commonBlock),
      this.dependencies.ethereumVerifier.getBlockHash(commonBlock),
    ])
    const point = {
      blockNumber: commonBlock,
      blockHash: bytes32(sourceHash, "source common Ethereum block"),
    }
    if (
      point.blockHash !==
      bytes32(verifierHash, "verifier common Ethereum block")
    ) {
      throw new Error(
        "Independent Ethereum providers disagree on finalized block"
      )
    }
    const [sourceCheckpoint, verifierCheckpoint, sourceState, verifierState] =
      await Promise.all([
        this.dependencies.ethereumSource.getBlockHash(
          manifest.checkpoint.blockNumber
        ),
        this.dependencies.ethereumVerifier.getBlockHash(
          manifest.checkpoint.blockNumber
        ),
        this.dependencies.ethereumSource.readActivationState(
          point,
          manifest.scanStartBlock
        ),
        this.dependencies.ethereumVerifier.readActivationState(
          point,
          manifest.scanStartBlock
        ),
      ])
    const checkpointHash = bytes32(
      manifest.checkpoint.blockHash,
      "manifest Ethereum checkpoint"
    )
    if (
      bytes32(sourceCheckpoint, "source Ethereum checkpoint") !==
        checkpointHash ||
      bytes32(verifierCheckpoint, "verifier Ethereum checkpoint") !==
        checkpointHash
    ) {
      throw new Error("Ethereum activation checkpoint is noncanonical")
    }
    const normalizedSource = normalizeEthereumState(sourceState)
    const normalizedVerifier = normalizeEthereumState(verifierState)
    if (
      canonicalJSON(normalizedSource) !== canonicalJSON(normalizedVerifier) ||
      canonicalJSON(normalizedSource.point) !== canonicalJSON(point)
    ) {
      throw new Error(
        "Independent Ethereum providers disagree on pinned activation state or event history"
      )
    }
    assertEthereumState(normalizedSource, this.manifest)
    return normalizedSource
  }

  private async readVerifiedEthereumHistory(
    point: P2TRProductionEthereumPoint,
    canonical: P2TRProductionEthereumState
  ): Promise<P2TRProductionEthereumHistoryState> {
    const normalizedPoint = ethereumPoint(point, "Ethereum journal cursor")
    const canonicalPoint = ethereumPoint(
      canonical.point,
      "canonical Ethereum point"
    )
    if (canonicalJSON(normalizedPoint) === canonicalJSON(canonicalPoint)) {
      const history = normalizeEthereumHistoryState(
        canonical,
        "canonical Ethereum history"
      )
      await this.assertVerifiedEthereumPointCanonical(canonicalPoint)
      return history
    }
    const [sourceHash, verifierHash, sourceState, verifierState] =
      await Promise.all([
        this.dependencies.ethereumSource.getBlockHash(
          normalizedPoint.blockNumber
        ),
        this.dependencies.ethereumVerifier.getBlockHash(
          normalizedPoint.blockNumber
        ),
        this.dependencies.ethereumSource.readHistoryState(
          normalizedPoint,
          this.manifest.ethereum.scanStartBlock
        ),
        this.dependencies.ethereumVerifier.readHistoryState(
          normalizedPoint,
          this.manifest.ethereum.scanStartBlock
        ),
      ])
    const sourceHistory = normalizeEthereumHistoryState(
      sourceState,
      "source Ethereum journal history"
    )
    const verifierHistory = normalizeEthereumHistoryState(
      verifierState,
      "verifier Ethereum journal history"
    )
    if (
      bytes32(sourceHash, "source Ethereum journal cursor") !==
        normalizedPoint.blockHash ||
      bytes32(verifierHash, "verifier Ethereum journal cursor") !==
        normalizedPoint.blockHash ||
      canonicalJSON(sourceHistory) !== canonicalJSON(verifierHistory) ||
      canonicalJSON(sourceHistory.point) !== canonicalJSON(normalizedPoint)
    ) {
      throw new Error(
        "Independent Ethereum providers disagree on journal cursor history"
      )
    }
    await this.assertVerifiedEthereumPointCanonical(canonicalPoint)
    return sourceHistory
  }

  private async assertVerifiedEthereumPointCanonical(
    point: P2TRProductionEthereumPoint
  ): Promise<void> {
    const canonicalPoint = ethereumPoint(
      point,
      "verified canonical Ethereum point"
    )
    const [sourceHash, verifierHash] = await Promise.all([
      this.dependencies.ethereumSource.getBlockHash(canonicalPoint.blockNumber),
      this.dependencies.ethereumVerifier.getBlockHash(
        canonicalPoint.blockNumber
      ),
    ])
    if (
      bytes32(sourceHash, "source verified Ethereum activation point") !==
        canonicalPoint.blockHash ||
      bytes32(verifierHash, "verifier verified Ethereum activation point") !==
        canonicalPoint.blockHash
    ) {
      throw new Error(
        "Verified Ethereum activation point changed during readiness"
      )
    }
  }

  private async readVerifiedBitcoin(): Promise<{
    point: P2TRProductionBitcoinPoint
  }> {
    const manifest = this.manifest.bitcoin
    const [indexed, reconciled] = await Promise.all([
      this.dependencies.bitcoinIndexSource.readState(
        manifest.confirmationDepth
      ),
      this.dependencies.bitcoinReconciler.readState(manifest.confirmationDepth),
    ])
    assertBitcoinNodePolicy(indexed, manifest, "Bitcoin index source")
    assertBitcoinNodePolicy(reconciled, manifest, "Bitcoin reconciler")
    const indexPoint = bitcoinPoint(
      indexed.finalizedThrough,
      "indexed finality"
    )
    const reconcilePoint = bitcoinPoint(
      reconciled.finalizedThrough,
      "reconciled finality"
    )
    if (
      Math.abs(indexPoint.height - reconcilePoint.height) >
      manifest.maxReconciliationLagBlocks
    ) {
      throw new Error(
        "Independent Bitcoin reconciliation exceeds its lag bound"
      )
    }
    const commonHeight = Math.min(indexPoint.height, reconcilePoint.height)
    const [indexedHash, reconciledHash, indexedGenesis, reconciledGenesis] =
      await Promise.all([
        this.dependencies.bitcoinIndexSource.getBlockHash(commonHeight),
        this.dependencies.bitcoinReconciler.getBlockHash(commonHeight),
        this.dependencies.bitcoinIndexSource.getBlockHash(0),
        this.dependencies.bitcoinReconciler.getBlockHash(0),
      ])
    const commonHash = bitcoinHash(indexedHash, "indexed common Bitcoin block")
    if (
      commonHash !==
        bitcoinHash(reconciledHash, "reconciled common Bitcoin block") ||
      bitcoinHash(indexedGenesis, "indexed Bitcoin genesis") !==
        bitcoinHash(
          this.manifest.bitcoin.genesisHash,
          "manifest Bitcoin genesis"
        ) ||
      bitcoinHash(reconciledGenesis, "reconciled Bitcoin genesis") !==
        bitcoinHash(
          this.manifest.bitcoin.genesisHash,
          "manifest Bitcoin genesis"
        )
    ) {
      throw new Error(
        "Independent Bitcoin providers disagree on canonical chain"
      )
    }
    return { point: { height: commonHeight, hash: commonHash } }
  }
}

function candidateEnqueueNonRetryableFailureDigest(error: unknown): string {
  const detail =
    error instanceof Error
      ? `${error.name}\0${error.message}`
      : typeof error === "string"
      ? error
      : "unknown non-retryable candidate enqueue failure"
  return `0x${createHash("sha256")
    .update("tbtc-p2tr-candidate-enqueue-non-retryable-failure/v1\0", "utf8")
    .update(detail.slice(0, 4_096), "utf8")
    .digest("hex")}`
}

export function assertP2TRActivationAttestationKeySeparation(keys: {
  activationAuthorityKeyHash: string
  outboxAttestationKeyHash: string
  frostAttestationKeyHash: string
}): void {
  const normalized = [
    bytes32(keys.activationAuthorityKeyHash, "activation authority key"),
    bytes32(keys.outboxAttestationKeyHash, "outbox attestation key"),
    bytes32(keys.frostAttestationKeyHash, "FROST attestation key"),
  ]
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(
      "Activation authority, outbox, and FROST attestation keys must differ"
    )
  }
}

export function verifyP2TRProductionActivationEnvelope(
  envelope: P2TRProductionActivationEnvelope,
  trustedSignerKeyHash: string
): P2TRProductionActivationEnvelope {
  if (
    !isPlainObject(envelope) ||
    envelope.signatureAlgorithm !== "ed25519" ||
    !isPlainObject(envelope.payload)
  ) {
    throw new Error("P2TR production activation envelope is malformed")
  }
  validateManifestShape(envelope.payload)
  const encoded = Buffer.from(canonicalJSON(envelope.payload), "utf8")
  const payloadHash = createHash("sha256").update(encoded).digest("hex")
  if (
    bytes32(envelope.payloadSha256, "activation payload hash").slice(2) !==
    payloadHash
  ) {
    throw new Error("P2TR production activation payload hash mismatch")
  }
  verifyEd25519(
    encoded,
    envelope.signerPublicKeySpki,
    envelope.signature,
    trustedSignerKeyHash,
    "activation manifest"
  )
  return deepFreeze(deepClone(envelope))
}

export function hashP2TRProductionActivationManifest(
  manifest: P2TRProductionActivationManifest
): string {
  validateManifestShape(manifest)
  return `0x${createHash("sha256")
    .update(canonicalJSON(manifest))
    .digest("hex")}`
}

export function canonicalizeP2TRProductionActivationManifest(
  manifest: P2TRProductionActivationManifest
): string {
  validateManifestShape(manifest)
  return canonicalJSON(manifest)
}

export function hashP2TRActivationLinkedLibraryDescriptorSet(
  contracts: P2TRProductionActivationManifest["ethereum"]["contracts"]
): string {
  const descriptors = Object.entries(contracts)
    .sort(([left], [right]) => compareASCII(left, right))
    .map(([contractRole, binding]) => ({
      contractRole,
      codeKind:
        binding.upgradeability.kind === "eip1967"
          ? "implementation-runtime"
          : "runtime",
      linkedLibraries: linkedLibraryDescriptors(binding.linkedLibraries, 0),
    }))
  return `0x${createHash("sha256")
    .update(
      canonicalJSON({
        schema: "tbtc-p2tr-linked-library-descriptor-set/v1",
        contracts: descriptors,
      }),
      "utf8"
    )
    .digest("hex")}`
}

function validateManifestShape(
  manifest: P2TRProductionActivationManifest
): void {
  if (manifest.schema !== P2TR_PRODUCTION_ACTIVATION_SCHEMA) {
    throw new Error("Unsupported P2TR production activation manifest schema")
  }
  positiveInteger(manifest.activationSequence, "activation sequence")
  bytes32(manifest.activationID, "activation ID")
  boundedString(manifest.environment, 64, "activation environment")
  assertMigrationBindings(manifest.migrations, manifest.migrations)

  const bitcoin = manifest.bitcoin
  boundedString(bitcoin.network, 32, "Bitcoin network")
  const genesis = bitcoinHash(bitcoin.genesisHash, "Bitcoin genesis hash")
  if (
    bitcoin.checkpoint.height !== 0 ||
    bitcoinHash(bitcoin.checkpoint.hash, "Bitcoin checkpoint hash") !== genesis
  ) {
    throw new Error(
      "Production Bitcoin checkpoint must be the configured genesis"
    )
  }
  positiveInteger(bitcoin.confirmationDepth, "Bitcoin confirmation depth")
  bytes32(bitcoin.configurationFingerprint, "Bitcoin configuration fingerprint")
  boundedString(bitcoin.storeID, 255, "Bitcoin store ID")
  boundedString(bitcoin.indexSourceTrustDomainID, 128, "Bitcoin index domain")
  boundedString(
    bitcoin.reconciliationTrustDomainID,
    128,
    "Bitcoin reconcile domain"
  )
  for (const [fingerprint, label] of [
    [bitcoin.indexSourceEndpointFingerprint, "Bitcoin index endpoint"],
    [bitcoin.indexSourceOperatorFingerprint, "Bitcoin index operator"],
    [
      bitcoin.reconciliationEndpointFingerprint,
      "Bitcoin reconciliation endpoint",
    ],
    [
      bitcoin.reconciliationOperatorFingerprint,
      "Bitcoin reconciliation operator",
    ],
  ] as const) {
    bytes32(fingerprint, label)
  }
  if (
    bitcoin.indexSourceTrustDomainID === bitcoin.reconciliationTrustDomainID
  ) {
    throw new Error("Bitcoin index and reconciliation domains must differ")
  }
  nonNegativeInteger(
    bitcoin.maxReconciliationLagBlocks,
    "Bitcoin reconcile lag"
  )
  nonNegativeInteger(bitcoin.maxIndexLagBlocks, "Bitcoin index lag")

  const ethereum = manifest.ethereum
  positiveInteger(ethereum.chainID, "Ethereum chain ID")
  ethereumPoint(ethereum.checkpoint, "Ethereum checkpoint")
  positiveInteger(ethereum.scanStartBlock, "Ethereum scan start")
  if (ethereum.checkpoint.blockNumber + 1 !== ethereum.scanStartBlock) {
    throw new Error("Ethereum checkpoint must be the deployment scan parent")
  }
  positiveInteger(ethereum.confirmationDepth, "Ethereum confirmation depth")
  nonNegativeInteger(ethereum.maxJournalLagBlocks, "Ethereum journal lag")
  bytes32(
    ethereum.configurationFingerprint,
    "Ethereum configuration fingerprint"
  )
  bytes32(ethereum.descriptorSetHash, "Ethereum descriptor set hash")
  boundedString(ethereum.storeID, 255, "Ethereum store ID")
  boundedString(ethereum.sourceTrustDomainID, 128, "Ethereum source domain")
  boundedString(ethereum.verifierTrustDomainID, 128, "Ethereum verifier domain")
  boundedString(
    ethereum.sourceHistoryStoreID,
    128,
    "Ethereum source history store"
  )
  boundedString(
    ethereum.verifierHistoryStoreID,
    128,
    "Ethereum verifier history store"
  )
  for (const [fingerprint, label] of [
    [ethereum.sourceEndpointFingerprint, "Ethereum source endpoint"],
    [ethereum.sourceOperatorFingerprint, "Ethereum source operator"],
    [ethereum.sourceHistoryStoreFingerprint, "Ethereum source history store"],
    [
      ethereum.sourceHistoryClusterFingerprint,
      "Ethereum source history cluster",
    ],
    [ethereum.verifierEndpointFingerprint, "Ethereum verifier endpoint"],
    [ethereum.verifierOperatorFingerprint, "Ethereum verifier operator"],
    [
      ethereum.verifierHistoryStoreFingerprint,
      "Ethereum verifier history store",
    ],
    [
      ethereum.verifierHistoryClusterFingerprint,
      "Ethereum verifier history cluster",
    ],
  ] as const) {
    bytes32(fingerprint, label)
  }
  if (
    bytes32(
      ethereum.linkedLibraryDescriptorSetHash,
      "linked-library descriptor set"
    ) !== hashP2TRActivationLinkedLibraryDescriptorSet(ethereum.contracts)
  ) {
    throw new Error("Activation linked-library descriptor set is incomplete")
  }
  if (
    ethereum.sourceTrustDomainID === ethereum.verifierTrustDomainID ||
    ethereum.sourceHistoryStoreID === ethereum.verifierHistoryStoreID ||
    bytes32(
      ethereum.sourceHistoryStoreFingerprint,
      "Ethereum source history store"
    ) ===
      bytes32(
        ethereum.verifierHistoryStoreFingerprint,
        "Ethereum verifier history store"
      ) ||
    bytes32(
      ethereum.sourceHistoryClusterFingerprint,
      "Ethereum source history cluster"
    ) ===
      bytes32(
        ethereum.verifierHistoryClusterFingerprint,
        "Ethereum verifier history cluster"
      )
  ) {
    throw new Error(
      "Ethereum source and verifier domains/history stores must differ"
    )
  }
  validateContractBindings(ethereum.contracts)
  for (const [role, contract] of Object.entries(ethereum.contracts)) {
    if (ethereum.scanStartBlock > contract.relevantEventStartBlock) {
      throw new Error(`Ethereum scan starts after the first ${role} event`)
    }
  }
  normalizeEcdsaCutover(manifest.ecdsaCutover)
  if (
    ethereum.scanStartBlock !== ethereum.contracts.bridge.deploymentBlock ||
    manifest.ecdsaCutover.scanStartBlock !== ethereum.scanStartBlock
  ) {
    throw new Error(
      "Ethereum/ECDSA history must start exactly at Bridge deployment"
    )
  }
  const activeEcdsaRouter =
    manifest.ecdsaCutover.mode === "fresh"
      ? manifest.ecdsaCutover.routerAddress
      : manifest.ecdsaCutover.replacementRouterAddress
  if (
    address(activeEcdsaRouter, "ECDSA cutover active router") !==
      address(
        ethereum.contracts.ecdsaFraudRouter.address,
        "manifest ECDSA router"
      ) ||
    bytes32(
      ethereum.contracts.ecdsaFraudRouter.protocolID,
      "manifest ECDSA router protocol"
    ) !== P2TR_ECDSA_FRAUD_ROUTER_CURRENT_V3
  ) {
    throw new Error("ECDSA cutover is not bound to the active current router")
  }
  if (
    (manifest.ecdsaCutover.mode === "fresh" &&
      bytes32(
        manifest.ecdsaCutover.routerRuntimeCodeHash,
        "fresh ECDSA router code"
      ) !==
        bytes32(
          ethereum.contracts.ecdsaFraudRouter.runtimeCodeHash,
          "manifest ECDSA router code"
        )) ||
    (manifest.ecdsaCutover.mode === "migrated" &&
      address(
        manifest.ecdsaCutover.cutoverCoordinatorAddress,
        "ECDSA cutover coordinator"
      ) !==
        address(
          ethereum.contracts.ecdsaCutoverCoordinator.address,
          "manifest ECDSA cutover coordinator"
        ))
  ) {
    throw new Error("ECDSA router/cutover code binding is inconsistent")
  }
  normalizeCompleteDepositKeyInventory(ethereum.completeDepositKeyInventory)
  normalizeFrostArchiveReadback(ethereum.frostArchive)

  const outbox = manifest.outbox
  boundedString(outbox.storeID, 255, "outbox store ID")
  bytes32(outbox.protocolID, "outbox protocol ID")
  address(outbox.sender, "outbox sender")
  address(outbox.routerAddress, "outbox router")
  bytes32(outbox.implementationCodeHash, "outbox implementation hash")
  bytes32(outbox.databaseConstraintHash, "outbox constraint hash")
  bytes32(outbox.attestationSignerKeyHash, "outbox signer key hash")
  bytes32(
    outbox.handshakeEndpointFingerprint,
    "outbox handshake endpoint fingerprint"
  )
  bytes32(
    outbox.handshakeOperatorFingerprint,
    "outbox handshake operator fingerprint"
  )
  bytes32(outbox.migrationChecksum, "outbox migration checksum")
  const maxActiveOutboxRecords = positiveInteger(
    outbox.maxActiveOutboxRecords,
    "outbox active-record capacity"
  )
  if (maxActiveOutboxRecords > 1_000_000) {
    throw new Error(
      "Outbox active-record capacity exceeds its 1000000-record bound"
    )
  }
  nonNegativeInteger(outbox.maxRecoveryBacklog, "outbox recovery backlog bound")
  if (outbox.senderLanes.length < 2 || outbox.senderLanes.length > 16) {
    throw new Error("Outbox requires two to sixteen independent sender lanes")
  }
  const laneIDs = new Set<string>()
  const laneDomains = new Set<string>()
  const laneOperators = new Set<string>()
  for (const lane of outbox.senderLanes) {
    laneIDs.add(boundedString(lane.laneID, 64, "outbox sender lane ID"))
    laneDomains.add(
      boundedString(lane.trustDomainID, 128, "outbox sender lane domain")
    )
    laneOperators.add(
      bytes32(lane.operatorFingerprint, "outbox sender lane operator")
    )
  }
  if (
    laneIDs.size !== outbox.senderLanes.length ||
    laneDomains.size !== outbox.senderLanes.length ||
    laneOperators.size !== outbox.senderLanes.length
  ) {
    throw new Error("Outbox sender lanes are not independently pinned")
  }
  for (const domain of [
    outbox.signerTrustDomainID,
    outbox.broadcastTrustDomainID,
    outbox.reconciliationTrustDomainID,
  ]) {
    boundedString(domain, 128, "outbox trust domain")
  }
  if (
    new Set([
      outbox.signerTrustDomainID,
      outbox.broadcastTrustDomainID,
      outbox.reconciliationTrustDomainID,
    ]).size !== 3 ||
    outbox.preparedTransactionPersistence !== "durable-before-broadcast" ||
    outbox.replacementPolicy !== "append-only-same-intent-fee-bump-v1" ||
    outbox.migrationVersion !== 3
  ) {
    throw new Error("Outbox production safety policy is not enabled")
  }
  const outboxMigration = manifest.migrations[outbox.migrationVersion - 1]
  if (
    outboxMigration?.version !== outbox.migrationVersion ||
    bytes32(outboxMigration.checksum, "migration 003 checksum") !==
      bytes32(outbox.migrationChecksum, "outbox migration checksum")
  ) {
    throw new Error("Outbox handshake is not bound to exact migration 003")
  }
  if (
    ethereum.storeID !== bitcoin.storeID ||
    outbox.storeID !== bitcoin.storeID
  ) {
    throw new Error(
      "Bitcoin index, Ethereum journal, and outbox must share one PostgreSQL store"
    )
  }

  const frost = manifest.frostSigner
  boundedString(frost.trustDomainID, 128, "FROST signer trust domain")
  boundedString(
    frost.durableSessionStoreFingerprint,
    256,
    "FROST durable store fingerprint"
  )
  for (const [value, label] of [
    [frost.protocolID, "FROST signer protocol"],
    [frost.reservationProtocolID, "FROST reservation protocol"],
    [frost.bitcoinOutboxProtocolID, "FROST Bitcoin outbox protocol"],
    [
      frost.retainedGroupInventoryProtocolID,
      "FROST retained-group inventory protocol",
    ],
    [frost.signingPolicyHash, "FROST signing policy"],
    [frost.attestationSignerKeyHash, "FROST attestation key"],
    [frost.handshakeEndpointFingerprint, "FROST handshake endpoint"],
    [frost.handshakeOperatorFingerprint, "FROST handshake operator"],
  ] as const) {
    bytes32(value, label)
  }
  address(frost.completeRouterAddress, "FROST COMPLETE router")
  address(frost.authorizationRegistryAddress, "FROST authorization registry")
  boundedString(frost.canonicalJournal.storeID, 255, "FROST journal store ID")
  bytes32(
    frost.canonicalJournal.storeFingerprint,
    "FROST journal store fingerprint"
  )
  bytes32(
    frost.canonicalJournal.clusterFingerprint,
    "FROST journal cluster fingerprint"
  )
  ethereumPoint(frost.canonicalJournal.checkpoint, "FROST journal checkpoint")
  bytes32(
    frost.canonicalJournal.descriptorSetHash,
    "FROST journal descriptor set"
  )
  boundedString(
    frost.canonicalJournal.sourceTrustDomainID,
    128,
    "FROST journal source trust domain"
  )
  bytes32(
    frost.canonicalJournal.sourceEndpointFingerprint,
    "FROST journal source endpoint"
  )
  bytes32(
    frost.canonicalJournal.sourceOperatorFingerprint,
    "FROST journal source operator"
  )
  nonNegativeInteger(
    frost.canonicalJournal.minimumGeneration,
    "FROST journal minimum generation"
  )
  bytes32(frost.quarantineJournal.protocolID, "FROST quarantine protocol")
  boundedString(
    frost.quarantineJournal.storeID,
    255,
    "FROST quarantine store ID"
  )
  bytes32(
    frost.quarantineJournal.storeFingerprint,
    "FROST quarantine store fingerprint"
  )
  bytes32(
    frost.quarantineJournal.clusterFingerprint,
    "FROST quarantine cluster fingerprint"
  )
  nonNegativeInteger(
    frost.quarantineJournal.minimumGeneration,
    "FROST quarantine minimum generation"
  )
  if (
    frost.canonicalJournal.storeID === frost.quarantineJournal.storeID ||
    bytes32(
      frost.canonicalJournal.storeFingerprint,
      "FROST canonical store fingerprint"
    ) ===
      bytes32(
        frost.quarantineJournal.storeFingerprint,
        "FROST quarantine store fingerprint"
      ) ||
    bytes32(
      frost.canonicalJournal.clusterFingerprint,
      "FROST canonical cluster fingerprint"
    ) ===
      bytes32(
        frost.quarantineJournal.clusterFingerprint,
        "FROST quarantine cluster fingerprint"
      ) ||
    bytes32(
      frost.durableSessionStoreFingerprint,
      "FROST durable session store fingerprint"
    ) ===
      bytes32(
        frost.canonicalJournal.storeFingerprint,
        "FROST canonical store fingerprint"
      ) ||
    bytes32(
      frost.durableSessionStoreFingerprint,
      "FROST durable session store fingerprint"
    ) ===
      bytes32(
        frost.quarantineJournal.storeFingerprint,
        "FROST quarantine store fingerprint"
      )
  ) {
    throw new Error(
      "FROST canonical, quarantine, and session stores must be independent"
    )
  }
  if (
    frost.threshold !== 51 ||
    frost.maximumGroupSize !== 100 ||
    frost.exactRetainedGroupInventoryRequired !== true ||
    frost.finalizedReservationReceiptRequired !== true ||
    frost.exactReservationIdentityRequired !== true ||
    frost.authorizationRootRequired !== true ||
    frost.durableSessionPersistenceRequired !== true ||
    frost.durableBitcoinOutboxRequired !== true ||
    frost.quarantineFailClosed !== true
  ) {
    throw new Error("FROST signer reservation policy is incomplete")
  }
}

function validateManifestPolicy(
  manifest: Readonly<P2TRProductionActivationManifest>,
  expected: P2TRProductionActivationExpectedProtocols
): void {
  const contracts = manifest.ethereum.contracts
  const checks: ReadonlyArray<[string, string, string]> = [
    [
      "COMPLETE router",
      contracts.completeRouter.protocolID,
      expected.completeRouterProtocolID,
    ],
    [
      "authorization registry",
      contracts.authorizationRegistry.protocolID,
      expected.authorizationRegistryProtocolID,
    ],
    [
      "authorization policy",
      contracts.authorizationRegistry.signingPolicyHash ?? "",
      expected.authorizationSigningPolicyHash,
    ],
    [
      "FROST registry",
      contracts.frostWalletRegistry.protocolID,
      expected.frostWalletRegistryProtocolID,
    ],
    [
      "FROST proposal validator",
      contracts.frostProposalValidator.protocolID,
      expected.frostProposalValidatorProtocolID,
    ],
    [
      "FROST sortition pool",
      contracts.frostSortitionPool.protocolID,
      expected.frostSortitionPoolProtocolID,
    ],
    [
      "ECDSA router",
      contracts.ecdsaFraudRouter.protocolID,
      expected.ecdsaFraudRouterProtocolID,
    ],
    [
      "ECDSA cutover",
      contracts.ecdsaCutoverCoordinator.protocolID,
      expected.ecdsaCutoverProtocolID,
    ],
    ["outbox", manifest.outbox.protocolID, expected.outboxProtocolID],
    [
      "FROST signer",
      manifest.frostSigner.protocolID,
      expected.frostSignerProtocolID,
    ],
    [
      "FROST reservation",
      manifest.frostSigner.reservationProtocolID,
      expected.frostReservationProtocolID,
    ],
    [
      "FROST Bitcoin outbox",
      manifest.frostSigner.bitcoinOutboxProtocolID,
      expected.frostBitcoinOutboxProtocolID,
    ],
    [
      "FROST retained-group inventory",
      manifest.frostSigner.retainedGroupInventoryProtocolID,
      expected.frostRetainedGroupInventoryProtocolID,
    ],
    [
      "FROST canonical journal",
      manifest.frostSigner.canonicalJournal.descriptorSetHash,
      expected.frostCanonicalJournalDescriptorSetHash,
    ],
    [
      "FROST quarantine journal",
      manifest.frostSigner.quarantineJournal.protocolID,
      expected.frostQuarantineJournalProtocolID,
    ],
  ]
  for (const [label, actual, wanted] of checks) {
    if (bytes32(actual, label) !== bytes32(wanted, `expected ${label}`)) {
      throw new Error(`${label} does not match this binary`)
    }
  }
  if (
    bytes32(manifest.ethereum.descriptorSetHash, "manifest descriptor set") !==
      bytes32(expected.descriptorSetHash, "binary descriptor set") ||
    bytes32(
      manifest.ethereum.linkedLibraryDescriptorSetHash,
      "manifest linked-library descriptor set"
    ) !==
      bytes32(
        expected.linkedLibraryDescriptorSetHash,
        "binary linked-library descriptor set"
      ) ||
    bytes32(manifest.frostSigner.signingPolicyHash, "FROST policy") !==
      bytes32(
        contracts.authorizationRegistry.signingPolicyHash ?? "",
        "authorization policy"
      )
  ) {
    throw new Error(
      "Activation decoder/signing policy does not match this binary"
    )
  }
}

function validateDependencyIndependence(
  manifest: Readonly<P2TRProductionActivationManifest>,
  dependencies: P2TRProductionActivationDependencies
): void {
  assertIndependentPair(
    dependencies.ethereumSource,
    dependencies.ethereumVerifier,
    "Ethereum source and verifier"
  )
  assertIndependentPair(
    dependencies.bitcoinIndexSource,
    dependencies.bitcoinReconciler,
    "Bitcoin index and reconciler"
  )
  assertIndependentPair(
    dependencies.outboxHandshake,
    dependencies.frostSignerHandshake,
    "outbox and FROST handshake providers"
  )
  const bindings: ReadonlyArray<[string, string, string]> = [
    [
      "Ethereum source",
      dependencies.ethereumSource.trustDomainID,
      manifest.ethereum.sourceTrustDomainID,
    ],
    [
      "Ethereum verifier",
      dependencies.ethereumVerifier.trustDomainID,
      manifest.ethereum.verifierTrustDomainID,
    ],
    [
      "Bitcoin index",
      dependencies.bitcoinIndexSource.trustDomainID,
      manifest.bitcoin.indexSourceTrustDomainID,
    ],
    [
      "Bitcoin reconciler",
      dependencies.bitcoinReconciler.trustDomainID,
      manifest.bitcoin.reconciliationTrustDomainID,
    ],
    [
      "outbox",
      dependencies.outboxHandshake.trustDomainID,
      manifest.outbox.reconciliationTrustDomainID,
    ],
    [
      "FROST signer",
      dependencies.frostSignerHandshake.trustDomainID,
      manifest.frostSigner.trustDomainID,
    ],
  ]
  for (const [label, actual, expected] of bindings) {
    if (actual !== expected)
      throw new Error(`${label} trust domain is not pinned`)
  }
  const fingerprints: ReadonlyArray<[string, string, string]> = [
    [
      "Ethereum source endpoint",
      dependencies.ethereumSource.endpointFingerprint,
      manifest.ethereum.sourceEndpointFingerprint,
    ],
    [
      "Ethereum source operator",
      dependencies.ethereumSource.operatorFingerprint,
      manifest.ethereum.sourceOperatorFingerprint,
    ],
    [
      "Ethereum verifier endpoint",
      dependencies.ethereumVerifier.endpointFingerprint,
      manifest.ethereum.verifierEndpointFingerprint,
    ],
    [
      "Ethereum verifier operator",
      dependencies.ethereumVerifier.operatorFingerprint,
      manifest.ethereum.verifierOperatorFingerprint,
    ],
    [
      "Ethereum source history store",
      dependencies.ethereumSource.historyStoreFingerprint,
      manifest.ethereum.sourceHistoryStoreFingerprint,
    ],
    [
      "Ethereum source history cluster",
      dependencies.ethereumSource.historyClusterFingerprint,
      manifest.ethereum.sourceHistoryClusterFingerprint,
    ],
    [
      "Ethereum verifier history store",
      dependencies.ethereumVerifier.historyStoreFingerprint,
      manifest.ethereum.verifierHistoryStoreFingerprint,
    ],
    [
      "Ethereum verifier history cluster",
      dependencies.ethereumVerifier.historyClusterFingerprint,
      manifest.ethereum.verifierHistoryClusterFingerprint,
    ],
    [
      "Bitcoin index endpoint",
      dependencies.bitcoinIndexSource.endpointFingerprint,
      manifest.bitcoin.indexSourceEndpointFingerprint,
    ],
    [
      "Bitcoin index operator",
      dependencies.bitcoinIndexSource.operatorFingerprint,
      manifest.bitcoin.indexSourceOperatorFingerprint,
    ],
    [
      "Bitcoin reconciler endpoint",
      dependencies.bitcoinReconciler.endpointFingerprint,
      manifest.bitcoin.reconciliationEndpointFingerprint,
    ],
    [
      "Bitcoin reconciler operator",
      dependencies.bitcoinReconciler.operatorFingerprint,
      manifest.bitcoin.reconciliationOperatorFingerprint,
    ],
    [
      "outbox handshake endpoint",
      dependencies.outboxHandshake.endpointFingerprint,
      manifest.outbox.handshakeEndpointFingerprint,
    ],
    [
      "outbox handshake operator",
      dependencies.outboxHandshake.operatorFingerprint,
      manifest.outbox.handshakeOperatorFingerprint,
    ],
    [
      "FROST handshake endpoint",
      dependencies.frostSignerHandshake.endpointFingerprint,
      manifest.frostSigner.handshakeEndpointFingerprint,
    ],
    [
      "FROST handshake operator",
      dependencies.frostSignerHandshake.operatorFingerprint,
      manifest.frostSigner.handshakeOperatorFingerprint,
    ],
  ]
  for (const [label, actual, expected] of fingerprints) {
    if (bytes32(actual, label) !== bytes32(expected, `manifest ${label}`)) {
      throw new Error(`${label} is not pinned by the signed manifest`)
    }
  }
  if (
    dependencies.ethereumSource.historyStoreID !==
      manifest.ethereum.sourceHistoryStoreID ||
    dependencies.ethereumVerifier.historyStoreID !==
      manifest.ethereum.verifierHistoryStoreID
  ) {
    throw new Error(
      "Ethereum history store IDs are not pinned by the signed manifest"
    )
  }
  if (
    bytes32(
      dependencies.ethereumSource.historyClusterFingerprint,
      "Ethereum source history cluster"
    ) ===
    bytes32(
      dependencies.ethereumVerifier.historyClusterFingerprint,
      "Ethereum verifier history cluster"
    )
  ) {
    throw new Error("Ethereum source and verifier share a PostgreSQL cluster")
  }
}

function assertIndependentPair(
  left: P2TRProductionProviderIdentity,
  right: P2TRProductionProviderIdentity,
  label: string
): void {
  if (
    left === right ||
    left.providerIdentity === right.providerIdentity ||
    left.trustDomainID === right.trustDomainID ||
    bytes32(left.endpointFingerprint, `${label} left endpoint`) ===
      bytes32(right.endpointFingerprint, `${label} right endpoint`) ||
    bytes32(left.operatorFingerprint, `${label} left operator`) ===
      bytes32(right.operatorFingerprint, `${label} right operator`)
  ) {
    throw new Error(`${label} must be endpoint- and operator-independent`)
  }
}

function assertEthereumState(
  state: P2TRProductionEthereumState,
  manifest: Readonly<P2TRProductionActivationManifest>
): void {
  const depositInventory = normalizeCompleteDepositKeyInventory(
    state.completeDepositKeyInventory
  )
  const frostArchive = normalizeFrostArchiveReadback(state.frostArchive)
  const frostWalletGroupInventory = normalizeFrostWalletGroupInventory(
    state.frostWalletGroupInventory
  )
  const ecdsaFinalizedBlock =
    state.ecdsaCutover.mode === "fresh"
      ? state.ecdsaCutover.finalizedAtBlock
      : state.ecdsaCutover.migrationFinalizedBlock
  if (
    canonicalJSON(normalizeContractBindings(state.contracts)) !==
      canonicalJSON(normalizeContractBindings(manifest.ethereum.contracts)) ||
    canonicalJSON(normalizeEcdsaCutover(state.ecdsaCutover)) !==
      canonicalJSON(normalizeEcdsaCutover(manifest.ecdsaCutover)) ||
    canonicalJSON(depositInventory) !==
      canonicalJSON(
        normalizeCompleteDepositKeyInventory(
          manifest.ethereum.completeDepositKeyInventory
        )
      ) ||
    canonicalJSON(frostArchive) !==
      canonicalJSON(
        normalizeFrostArchiveReadback(manifest.ethereum.frostArchive)
      ) ||
    address(state.bridgeBindings.p2trFraudRouter, "live P2TR router") !==
      address(
        manifest.ethereum.contracts.completeRouter.address,
        "manifest COMPLETE router"
      ) ||
    address(state.bridgeBindings.ecdsaFraudRouter, "live ECDSA router") !==
      address(
        manifest.ethereum.contracts.ecdsaFraudRouter.address,
        "manifest ECDSA router"
      ) ||
    address(state.bridgeBindings.frostWalletRegistry, "live FROST registry") !==
      address(
        manifest.ethereum.contracts.frostWalletRegistry.address,
        "manifest FROST registry"
      ) ||
    address(
      state.bridgeBindings.completeAuthorizationRegistry,
      "live authorization registry"
    ) !==
      address(
        manifest.ethereum.contracts.authorizationRegistry.address,
        "manifest authorization registry"
      ) ||
    state.bridgeBindings.ecdsaRetired !== true ||
    ecdsaFinalizedBlock > state.point.blockNumber ||
    depositInventory.finalizedPoint.blockNumber > state.point.blockNumber ||
    frostArchive.finalizedPoint.blockNumber > state.point.blockNumber ||
    canonicalJSON(frostWalletGroupInventory.point) !==
      canonicalJSON(ethereumPoint(state.point, "FROST inventory state point"))
  ) {
    throw new Error(
      "Pinned Ethereum contract/cutover readback is not activation-ready"
    )
  }
}

export function assertP2TRProductionBitcoinIndexHealth(
  actual: P2TRProductionBitcoinIndexHealth,
  manifest: Readonly<P2TRProductionActivationManifest>,
  canonical: P2TRProductionBitcoinPoint,
  indexedCursorHash: string,
  reconciledCursorHash: string
): void {
  const expected = manifest.bitcoin
  const checkpoint = bitcoinPoint(actual.checkpoint, "index checkpoint")
  const current = bitcoinPoint(actual.current, "index cursor")
  const authenticatedIndexedCursorHash = bitcoinHash(
    indexedCursorHash,
    "indexed Bitcoin cursor block"
  )
  const authenticatedReconciledCursorHash = bitcoinHash(
    reconciledCursorHash,
    "reconciled Bitcoin cursor block"
  )
  if (
    actual.storeID !== expected.storeID ||
    bytes32(actual.configurationFingerprint, "index fingerprint") !==
      bytes32(
        expected.configurationFingerprint,
        "manifest index fingerprint"
      ) ||
    actual.network !== expected.network ||
    checkpoint.height !== 0 ||
    checkpoint.hash !== bitcoinHash(expected.genesisHash, "manifest genesis") ||
    actual.canonicalBlockCount !== current.height + 1 ||
    current.height > canonical.height ||
    canonical.height - current.height > expected.maxIndexLagBlocks ||
    current.hash !== authenticatedIndexedCursorHash ||
    current.hash !== authenticatedReconciledCursorHash ||
    actual.pendingCandidates !== 0 ||
    actual.pendingDepositReveals !== 0 ||
    actual.unmatchedProofs !== 0 ||
    actual.liveCandidateAuthorizations !== 0 ||
    actual.unbackfilledFrostWalletBindings !== 0 ||
    actual.failureGeneration !== actual.clearedFailureGeneration
  ) {
    throw new Error(
      "Canonical Bitcoin index is incomplete, stale, or unhealthy"
    )
  }
}

function assertEthereumJournalCursorHealth(
  actual: P2TRProductionEthereumJournalHealth,
  manifest: Readonly<P2TRProductionActivationManifest>,
  canonical: Pick<P2TRProductionEthereumState, "point">
): void {
  const expected = manifest.ethereum
  const current = ethereumPoint(actual.current, "Ethereum journal cursor")
  if (
    actual.storeID !== expected.storeID ||
    actual.chainID !== expected.chainID ||
    bytes32(actual.configurationFingerprint, "journal fingerprint") !==
      bytes32(
        expected.configurationFingerprint,
        "manifest journal fingerprint"
      ) ||
    bytes32(actual.descriptorSetHash, "journal descriptor set") !==
      bytes32(expected.descriptorSetHash, "manifest descriptor set") ||
    canonicalJSON(ethereumPoint(actual.checkpoint, "journal checkpoint")) !==
      canonicalJSON(
        ethereumPoint(expected.checkpoint, "manifest checkpoint")
      ) ||
    actual.scanStartBlock !== expected.scanStartBlock ||
    current.blockNumber > canonical.point.blockNumber ||
    canonical.point.blockNumber - current.blockNumber >
      expected.maxJournalLagBlocks ||
    actual.failureGeneration !== actual.clearedFailureGeneration
  ) {
    throw new Error(
      "Canonical Ethereum journal is incomplete, stale, or unhealthy"
    )
  }
}

export function assertP2TRProductionEthereumJournalHealth(
  actual: P2TRProductionEthereumJournalHealth,
  manifest: Readonly<P2TRProductionActivationManifest>,
  canonical: Pick<P2TRProductionEthereumState, "point">,
  providerHistory: P2TRProductionEthereumHistoryState
): void {
  assertEthereumJournalCursorHealth(actual, manifest, canonical)
  const current = ethereumPoint(actual.current, "Ethereum journal cursor")
  const history = normalizeEthereumHistoryState(
    providerHistory,
    "provider Ethereum journal history"
  )
  if (
    canonicalJSON(current) !== canonicalJSON(history.point) ||
    bytes32(actual.requiredEventHistoryDigest, "journal event digest") !==
      history.requiredEventHistoryDigest ||
    actual.requiredEventCount !== history.requiredEventCount ||
    canonicalJSON(
      normalizeEthereumHistoryCoverageCounters(
        actual.requiredEventCoverage,
        "journal receipt coverage"
      )
    ) !== canonicalJSON(history.requiredEventCoverage)
  ) {
    throw new Error(
      "Canonical Ethereum journal is incomplete, stale, or unhealthy"
    )
  }
}

export function assertP2TRProductionRuntimeAlertHealth(
  actual: P2TRProductionRuntimeAlertHealth,
  expectedManifestHash: string
): void {
  if (
    bytes32(actual.manifestHash, "runtime alert manifest") !==
      bytes32(expectedManifestHash, "activation manifest") ||
    nonNegativeInteger(
      actual.unresolvedCandidateEnqueueTransactionGuardCount,
      "unresolved candidate enqueue transaction guard count"
    ) !== 0 ||
    nonNegativeInteger(
      actual.candidateEnqueueRetryExhaustionCount,
      "candidate enqueue retry-exhaustion alert count"
    ) !== 0
  ) {
    throw new Error(
      "Production runtime has activation-blocking candidate enqueue alerts"
    )
  }
}

function assertBitcoinNodePolicy(
  state: P2TRProductionBitcoinState,
  expected: Readonly<P2TRProductionActivationManifest["bitcoin"]>,
  label: string
): void {
  if (
    state.network !== expected.network ||
    bitcoinHash(state.genesisHash, `${label} genesis`) !==
      bitcoinHash(expected.genesisHash, "manifest genesis") ||
    state.txIndex !== true ||
    state.unpruned !== true ||
    state.synchronized !== true
  ) {
    throw new Error(`${label} is not a canonical production Bitcoin node`)
  }
  bitcoinPoint(state.finalizedThrough, `${label} finality`)
}

function assertCandidateAttestation(
  actual: P2TRProductionBitcoinCandidateAttestation,
  expected: P2TRProductionBitcoinCandidate,
  label: string
): void {
  if (
    canonicalJSON(normalizeCandidateBitcoinEvidence(actual)) !==
      canonicalJSON(normalizeCandidateBitcoinEvidence(expected)) ||
    actual.present !== true ||
    bitcoinPoint(actual.finalizedThrough, `${label} finality`).height <
      expected.blockHeight
  ) {
    throw new Error(`${label} did not attest the exact Bitcoin candidate`)
  }
}

function normalizeCandidateBitcoinEvidence(
  candidate: P2TRProductionBitcoinCandidateTransactionIdentity & {
    inputIndex: number
  }
): P2TRProductionBitcoinCandidateTransactionIdentity & {
  inputIndex: number
} {
  return {
    txid: bitcoinHash(candidate.txid, "candidate txid"),
    wtxid: bitcoinHash(candidate.wtxid, "candidate wtxid"),
    blockHeight: nonNegativeInteger(
      candidate.blockHeight,
      "candidate block height"
    ),
    blockHash: bitcoinHash(candidate.blockHash, "candidate block hash"),
    inputIndex: uint32(candidate.inputIndex, "candidate input index"),
  }
}

export function assertP2TRProductionOutboxHandshake(
  actual: P2TRProductionOutboxHandshakeState,
  expected: Readonly<P2TRProductionActivationManifest["outbox"]>
): void {
  nonNegativeInteger(
    actual.activeGenerationCount,
    "active outbox generation count"
  )
  const normalized = {
    storeID: boundedString(actual.storeID, 255, "outbox handshake store"),
    protocolID: bytes32(actual.protocolID, "outbox handshake protocol"),
    sender: address(actual.sender, "outbox handshake sender"),
    routerAddress: address(actual.routerAddress, "outbox handshake router"),
    implementationCodeHash: bytes32(
      actual.implementationCodeHash,
      "outbox implementation"
    ),
    databaseConstraintHash: bytes32(
      actual.databaseConstraintHash,
      "outbox constraints"
    ),
    preparedTransactionPersistence: actual.preparedTransactionPersistence,
    replacementPolicy: actual.replacementPolicy,
    migrationVersion: actual.migrationVersion,
    migrationChecksum: bytes32(
      actual.migrationChecksum,
      "outbox migration checksum"
    ),
    senderLanes: normalizeOutboxSenderLanes(actual.senderLanes),
  }
  const wanted = {
    storeID: expected.storeID,
    protocolID: bytes32(expected.protocolID, "manifest outbox protocol"),
    sender: address(expected.sender, "manifest outbox sender"),
    routerAddress: address(expected.routerAddress, "manifest outbox router"),
    implementationCodeHash: bytes32(
      expected.implementationCodeHash,
      "manifest outbox implementation"
    ),
    databaseConstraintHash: bytes32(
      expected.databaseConstraintHash,
      "manifest outbox constraints"
    ),
    preparedTransactionPersistence: expected.preparedTransactionPersistence,
    replacementPolicy: expected.replacementPolicy,
    migrationVersion: expected.migrationVersion,
    migrationChecksum: bytes32(
      expected.migrationChecksum,
      "manifest outbox migration checksum"
    ),
    senderLanes: normalizeOutboxSenderLanes(
      expected.senderLanes.map((lane) => ({ ...lane, healthy: true as const }))
    ),
  }
  bytes32(actual.configuredSignerLaneSetHash, "configured signer lane set hash")
  if (
    canonicalJSON(normalized) !== canonicalJSON(wanted) ||
    actual.startupReconciliationComplete !== true ||
    actual.ambiguousTransactionCount !== 0 ||
    actual.activationBlockingCriticalAlertCount !== 0 ||
    actual.unresolvedLegacyQuarantineCount !== 0 ||
    actual.liveCandidateAuthorizationCount !== 0 ||
    nonNegativeInteger(
      actual.configuredSignerLaneCount,
      "configured signer lane count"
    ) !== expected.senderLanes.length ||
    nonNegativeInteger(actual.recoveryBacklogCount, "outbox recovery backlog") >
      expected.maxRecoveryBacklog ||
    actual.healthy !== true
  ) {
    throw new Error("Transactional outbox handshake is not activation-ready")
  }
}

/**
 * Requires the readiness transaction's own read of activation-blocking outbox
 * state to agree with the signed sample. Active generations may legitimately
 * enqueue or terminalise between the signed sample and the readiness fence;
 * capacity backpressure is enforced atomically by the database on enqueue.
 * The recovery backlog is clock-driven, so it is held to the manifest bound
 * instead of exact equality.
 */
export function assertP2TRProductionOutboxRevalidation(
  revalidation: P2TRProductionOutboxRevalidation,
  signed: P2TRProductionOutboxHandshakeState,
  expected: Readonly<P2TRProductionActivationManifest["outbox"]>
): void {
  nonNegativeInteger(
    revalidation.activeGenerationCount,
    "revalidated active outbox generation count"
  )
  if (
    nonNegativeInteger(
      revalidation.activationBlockingCriticalAlertCount,
      "revalidated activation-blocking alert count"
    ) !== signed.activationBlockingCriticalAlertCount ||
    nonNegativeInteger(
      revalidation.ambiguousTransactionCount,
      "revalidated ambiguous transaction count"
    ) !== signed.ambiguousTransactionCount ||
    nonNegativeInteger(
      revalidation.unresolvedLegacyQuarantineCount,
      "revalidated legacy quarantine count"
    ) !== signed.unresolvedLegacyQuarantineCount ||
    nonNegativeInteger(
      revalidation.configuredSignerLaneCount,
      "revalidated configured signer lane count"
    ) !== signed.configuredSignerLaneCount ||
    bytes32(
      revalidation.configuredSignerLaneSetHash,
      "revalidated configured signer lane set hash"
    ) !==
      bytes32(
        signed.configuredSignerLaneSetHash,
        "signed configured signer lane set hash"
      ) ||
    revalidation.configuredSignerLaneCount !== expected.senderLanes.length ||
    nonNegativeInteger(
      revalidation.quarantinedSignerLaneCount,
      "revalidated quarantined signer lane count"
    ) !== 0 ||
    nonNegativeInteger(
      revalidation.activeOldManifestGenerationCount,
      "revalidated old-manifest generation count"
    ) !== 0 ||
    nonNegativeInteger(
      revalidation.staleManifestGenerationSuccessorCount,
      "revalidated stale-manifest generation successor count"
    ) !== 0 ||
    nonNegativeInteger(
      revalidation.activeSignerInvocationCount,
      "revalidated active signer invocation count"
    ) !== 0 ||
    nonNegativeInteger(
      revalidation.activeNonceReleaseAttemptCount,
      "revalidated active nonce release attempt count"
    ) !== 0 ||
    nonNegativeInteger(
      revalidation.recoveryBacklogCount,
      "revalidated recovery backlog count"
    ) > expected.maxRecoveryBacklog
  ) {
    throw new Error(
      "Transactional outbox state changed after its activation handshake was signed"
    )
  }
}

/**
 * Commits to the exact manifest-bound signer-lane configurations. Each
 * configuration hash already binds its manifest, chain, lane, signer, sender,
 * policy, code, and fee envelope; fixed-width sorted hashes make the set
 * encoding deterministic in both TypeScript and PostgreSQL.
 */
export function computeP2TRProductionSignerLaneSetHash(
  lanes: readonly { configurationHash: string }[]
): string {
  const digest = createHash("sha256").update(
    "tbtc-p2tr-production-signer-lane-set/v1\u0000",
    "utf8"
  )
  const configurationHashes = lanes
    .map((lane) =>
      bytes32(lane.configurationHash, "signer lane configuration hash")
    )
    .sort()
  for (const configurationHash of configurationHashes) {
    digest.update(Buffer.from(configurationHash.slice(2), "hex"))
  }
  return `0x${digest.digest("hex")}`
}

export function assertP2TRProductionFrostHandshake(
  actual: P2TRProductionFrostHandshakeState,
  expected: Readonly<P2TRProductionActivationManifest["frostSigner"]>,
  canonicalInventory: P2TRFrostWalletGroupInventory
): void {
  const signerInventory = normalizeFrostWalletGroupInventory(
    actual.frostWalletGroupInventory
  )
  const ethereumInventory =
    normalizeFrostWalletGroupInventory(canonicalInventory)
  const actualCanonicalJournal = actual.canonicalJournal
  const expectedCanonicalJournal = expected.canonicalJournal
  const actualQuarantineJournal = actual.quarantineJournal
  const expectedQuarantineJournal = expected.quarantineJournal
  if (
    bytes32(actual.protocolID, "FROST handshake protocol") !==
      bytes32(expected.protocolID, "manifest FROST protocol") ||
    bytes32(actual.reservationProtocolID, "FROST handshake reservation") !==
      bytes32(expected.reservationProtocolID, "manifest FROST reservation") ||
    bytes32(
      actual.bitcoinOutboxProtocolID,
      "FROST handshake Bitcoin outbox"
    ) !==
      bytes32(
        expected.bitcoinOutboxProtocolID,
        "manifest FROST Bitcoin outbox"
      ) ||
    bytes32(actual.signingPolicyHash, "FROST handshake policy") !==
      bytes32(expected.signingPolicyHash, "manifest FROST policy") ||
    actual.durableSessionStoreFingerprint !==
      expected.durableSessionStoreFingerprint ||
    address(actual.completeRouterAddress, "FROST handshake router") !==
      address(expected.completeRouterAddress, "manifest FROST router") ||
    address(actual.authorizationRegistryAddress, "FROST handshake registry") !==
      address(
        expected.authorizationRegistryAddress,
        "manifest FROST registry"
      ) ||
    actual.threshold !== 51 ||
    actual.maximumGroupSize !== 100 ||
    bytes32(
      actual.retainedGroupInventoryProtocolID,
      "FROST handshake retained-group inventory protocol"
    ) !==
      bytes32(
        expected.retainedGroupInventoryProtocolID,
        "manifest retained-group inventory protocol"
      ) ||
    boundedString(
      actualCanonicalJournal.storeID,
      255,
      "FROST handshake journal store ID"
    ) !==
      boundedString(
        expectedCanonicalJournal.storeID,
        255,
        "manifest FROST journal store ID"
      ) ||
    bytes32(
      actualCanonicalJournal.storeFingerprint,
      "FROST handshake journal store fingerprint"
    ) !==
      bytes32(
        expectedCanonicalJournal.storeFingerprint,
        "manifest FROST journal store fingerprint"
      ) ||
    bytes32(
      actualCanonicalJournal.clusterFingerprint,
      "FROST handshake journal cluster fingerprint"
    ) !==
      bytes32(
        expectedCanonicalJournal.clusterFingerprint,
        "manifest FROST journal cluster fingerprint"
      ) ||
    canonicalJSON(
      ethereumPoint(
        actualCanonicalJournal.checkpoint,
        "FROST handshake journal checkpoint"
      )
    ) !==
      canonicalJSON(
        ethereumPoint(
          expectedCanonicalJournal.checkpoint,
          "manifest FROST journal checkpoint"
        )
      ) ||
    canonicalJSON(
      ethereumPoint(
        actualCanonicalJournal.current,
        "FROST handshake journal current point"
      )
    ) !== canonicalJSON(signerInventory.point) ||
    bytes32(
      actualCanonicalJournal.descriptorSetHash,
      "FROST handshake journal descriptor set"
    ) !==
      bytes32(
        expectedCanonicalJournal.descriptorSetHash,
        "manifest FROST journal descriptor set"
      ) ||
    boundedString(
      actualCanonicalJournal.sourceTrustDomainID,
      128,
      "FROST handshake journal source trust domain"
    ) !==
      boundedString(
        expectedCanonicalJournal.sourceTrustDomainID,
        128,
        "manifest FROST journal source trust domain"
      ) ||
    bytes32(
      actualCanonicalJournal.sourceEndpointFingerprint,
      "FROST handshake journal source endpoint"
    ) !==
      bytes32(
        expectedCanonicalJournal.sourceEndpointFingerprint,
        "manifest FROST journal source endpoint"
      ) ||
    bytes32(
      actualCanonicalJournal.sourceOperatorFingerprint,
      "FROST handshake journal source operator"
    ) !==
      bytes32(
        expectedCanonicalJournal.sourceOperatorFingerprint,
        "manifest FROST journal source operator"
      ) ||
    nonNegativeInteger(
      actualCanonicalJournal.generation,
      "FROST handshake journal generation"
    ) !== signerInventory.snapshotGeneration ||
    actualCanonicalJournal.generation <
      nonNegativeInteger(
        expectedCanonicalJournal.minimumGeneration,
        "manifest FROST journal minimum generation"
      ) ||
    actualCanonicalJournal.complete !== true ||
    bytes32(
      actualQuarantineJournal.protocolID,
      "FROST handshake quarantine protocol"
    ) !==
      bytes32(
        expectedQuarantineJournal.protocolID,
        "manifest FROST quarantine protocol"
      ) ||
    boundedString(
      actualQuarantineJournal.storeID,
      255,
      "FROST handshake quarantine store ID"
    ) !==
      boundedString(
        expectedQuarantineJournal.storeID,
        255,
        "manifest FROST quarantine store ID"
      ) ||
    bytes32(
      actualQuarantineJournal.storeFingerprint,
      "FROST handshake quarantine store fingerprint"
    ) !==
      bytes32(
        expectedQuarantineJournal.storeFingerprint,
        "manifest FROST quarantine store fingerprint"
      ) ||
    bytes32(
      actualQuarantineJournal.clusterFingerprint,
      "FROST handshake quarantine cluster fingerprint"
    ) !==
      bytes32(
        expectedQuarantineJournal.clusterFingerprint,
        "manifest FROST quarantine cluster fingerprint"
      ) ||
    nonNegativeInteger(
      actualQuarantineJournal.generation,
      "FROST handshake quarantine generation"
    ) <
      nonNegativeInteger(
        expectedQuarantineJournal.minimumGeneration,
        "manifest FROST quarantine minimum generation"
      ) ||
    bytes32(actualQuarantineJournal.root, "FROST quarantine root") ===
      ZERO_WORD ||
    actualQuarantineJournal.currentQuarantineCount !== 0 ||
    actualQuarantineJournal.complete !== true ||
    actualCanonicalJournal.storeID === actualQuarantineJournal.storeID ||
    bytes32(
      actualCanonicalJournal.storeFingerprint,
      "FROST handshake canonical store fingerprint"
    ) ===
      bytes32(
        actualQuarantineJournal.storeFingerprint,
        "FROST handshake quarantine store fingerprint"
      ) ||
    bytes32(
      actualCanonicalJournal.clusterFingerprint,
      "FROST handshake canonical cluster fingerprint"
    ) ===
      bytes32(
        actualQuarantineJournal.clusterFingerprint,
        "FROST handshake quarantine cluster fingerprint"
      ) ||
    bytes32(
      actual.durableSessionStoreFingerprint,
      "FROST handshake durable session store fingerprint"
    ) ===
      bytes32(
        actualCanonicalJournal.storeFingerprint,
        "FROST handshake canonical store fingerprint"
      ) ||
    bytes32(
      actual.durableSessionStoreFingerprint,
      "FROST handshake durable session store fingerprint"
    ) ===
      bytes32(
        actualQuarantineJournal.storeFingerprint,
        "FROST handshake quarantine store fingerprint"
      ) ||
    canonicalJSON(signerInventory) !== canonicalJSON(ethereumInventory) ||
    actual.finalizedReservationReadbackEnforced !== true ||
    actual.exactTransactionAuthorizationRootEnforced !== true ||
    actual.nonceShareGateEnforced !== true ||
    actual.durableBitcoinOutboxRecovered !== true ||
    actual.quarantineFailClosed !== true ||
    actual.healthy !== true
  ) {
    throw new Error("FROST signer handshake is not activation-ready")
  }
}

function verifySignedHandshake<State>(
  handshake: P2TRProductionSignedHandshake<State>,
  kind: "outbox" | "frost-signer",
  challenge: {
    nonce: string
    manifestHash: string
    ethereumPoint: P2TRProductionEthereumPoint
  },
  trustedKeyHash: string
): void {
  if (
    handshake.payload.kind !== kind ||
    bytes32(handshake.payload.nonce, `${kind} nonce`) !== challenge.nonce ||
    bytes32(handshake.payload.manifestHash, `${kind} manifest hash`) !==
      challenge.manifestHash ||
    canonicalJSON(
      ethereumPoint(handshake.payload.ethereumPoint, `${kind} point`)
    ) !== canonicalJSON(challenge.ethereumPoint)
  ) {
    throw new Error(
      `${kind} handshake is not bound to this activation challenge`
    )
  }
  verifyEd25519(
    Buffer.from(encodeP2TRProductionSignedHandshakePayload(handshake.payload)),
    handshake.signerPublicKeySpki,
    handshake.signature,
    trustedKeyHash,
    `${kind} handshake`
  )
}

function verifyEd25519(
  payload: Buffer,
  publicKeySpki: string,
  signatureBase64: string,
  trustedKeyHash: string,
  label: string
): void {
  const keyBytes = decodeBoundedBase64(publicKeySpki, 1024, `${label} key`)
  if (
    `0x${createHash("sha256").update(keyBytes).digest("hex")}` !==
    bytes32(trustedKeyHash, `${label} trusted key hash`)
  ) {
    throw new Error(`${label} signer is not trusted`)
  }
  const key = createPublicKey({ key: keyBytes, format: "der", type: "spki" })
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} key must be Ed25519`)
  }
  const signature = decodeBoundedBase64(
    signatureBase64,
    256,
    `${label} signature`
  )
  if (!verifySignature(null, payload, key, signature)) {
    throw new Error(`${label} signature is invalid`)
  }
}

function assertMigrationBindings(
  actual: readonly P2TRActivationMigrationBinding[],
  expected: readonly P2TRActivationMigrationBinding[]
): void {
  const normalize = (items: readonly P2TRActivationMigrationBinding[]) =>
    items.map((migration, index) => ({
      version:
        positiveInteger(migration.version, "migration version") === index + 1
          ? migration.version
          : fail("Migration history must be consecutive from version 1"),
      name: boundedString(migration.name, 128, "migration name"),
      checksum: bytes32(migration.checksum, "migration checksum"),
    }))
  if (canonicalJSON(normalize(actual)) !== canonicalJSON(normalize(expected))) {
    throw new Error("Applied migrations do not match the signed manifest")
  }
}

function validateContractBindings(
  contracts: P2TRProductionActivationManifest["ethereum"]["contracts"]
): void {
  const normalized = normalizeContractBindings(contracts) as Record<
    string,
    {
      address: string
      deploymentBlock: number
      relevantEventStartBlock: number
      bridgeAddress?: string
    }
  >
  const bridge = normalized.bridge.address
  const contractAddresses = new Set<string>()
  for (const [role, contract] of Object.entries(normalized)) {
    if (
      contract.address === ZERO_ADDRESS ||
      bytes32(
        contracts[role as keyof typeof contracts].runtimeCodeHash,
        `${role} runtime code`
      ) === ZERO_WORD ||
      bytes32(
        contracts[role as keyof typeof contracts].protocolID,
        `${role} protocol`
      ) === ZERO_WORD
    ) {
      throw new Error(`${role} has a zero address/code/protocol binding`)
    }
    contractAddresses.add(contract.address)
    if (contract.relevantEventStartBlock < contract.deploymentBlock) {
      throw new Error(`${role} event history predates deployment`)
    }
    if (role !== "bridge" && contract.bridgeAddress !== bridge) {
      throw new Error(`${role} is bound to another Bridge`)
    }
  }
  if (contractAddresses.size !== Object.keys(normalized).length) {
    throw new Error("Activation contract roles must have distinct addresses")
  }
}

function normalizeContractBindings(
  contracts: P2TRProductionActivationManifest["ethereum"]["contracts"]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(contracts)
      .sort(([left], [right]) => compareASCII(left, right))
      .map(([role, contract]) => {
        const base: Record<string, unknown> = {
          address: address(contract.address, `${role} address`),
          runtimeCodeHash: bytes32(
            contract.runtimeCodeHash,
            `${role} runtime code`
          ),
          protocolID: bytes32(contract.protocolID, `${role} protocol`),
          deploymentBlock: nonNegativeInteger(
            contract.deploymentBlock,
            `${role} deployment`
          ),
          relevantEventStartBlock: nonNegativeInteger(
            contract.relevantEventStartBlock,
            `${role} event start`
          ),
          upgradeability: normalizeUpgradeability(
            contract.upgradeability,
            role
          ),
        }
        const linkedLibraries = normalizeLinkedLibraryBindings(
          contract.linkedLibraries,
          0,
          `${role} linked libraries`
        )
        const linkedLibraryDescriptorHash = bytes32(
          contract.linkedLibraryDescriptorHash,
          `${role} linked-library descriptor`
        )
        if (
          linkedLibraryDescriptorHash !==
          hashP2TRActivationLinkedLibraryInventory(contract.linkedLibraries)
        ) {
          throw new Error(`${role} linked-library descriptor is incomplete`)
        }
        base.linkedLibraryDescriptorHash = linkedLibraryDescriptorHash
        base.linkedLibraries = linkedLibraries
        if (contract.bridgeAddress !== undefined) {
          base.bridgeAddress = address(contract.bridgeAddress, `${role} Bridge`)
        }
        if (contract.signingPolicyHash !== undefined) {
          base.signingPolicyHash = bytes32(
            contract.signingPolicyHash,
            `${role} policy`
          )
        }
        return [role, base]
      })
  )
}

function normalizeLinkedLibraryBindings(
  libraries: readonly P2TRActivationLinkedLibraryBinding[],
  depth: number,
  label: string
): readonly Record<string, unknown>[] {
  if (!Array.isArray(libraries) || depth > 16) {
    throw new Error(`${label} is malformed or too deeply nested`)
  }
  const normalized = libraries
    .map((library, index) => {
      const protocolRole = asciiRole(
        library.protocolRole,
        `${label} role ${index}`
      )
      const references = normalizeLinkReferences(
        library.references,
        `${label} ${protocolRole} references`
      )
      if (references.length === 0) {
        throw new Error(`${label} ${protocolRole} has no runtime reference`)
      }
      const linkedLibraries = normalizeLinkedLibraryBindings(
        library.linkedLibraries,
        depth + 1,
        `${label} ${protocolRole}`
      )
      const descriptorHash = bytes32(
        library.linkedLibraryDescriptorHash,
        `${label} ${protocolRole} descriptor`
      )
      if (
        descriptorHash !==
        hashP2TRActivationLinkedLibraryInventory(library.linkedLibraries)
      ) {
        throw new Error(`${label} ${protocolRole} descriptor is incomplete`)
      }
      return {
        protocolRole,
        address: address(library.address, `${label} ${protocolRole} address`),
        runtimeCodeHash: bytes32(
          library.runtimeCodeHash,
          `${label} ${protocolRole} runtime code`
        ),
        references,
        linkedLibraryDescriptorHash: descriptorHash,
        linkedLibraries,
      }
    })
    .sort((left, right) => compareASCII(left.protocolRole, right.protocolRole))
  if (
    new Set(normalized.map(({ protocolRole }) => protocolRole)).size !==
      normalized.length ||
    new Set(normalized.map(({ address: libraryAddress }) => libraryAddress))
      .size !== normalized.length
  ) {
    throw new Error(`${label} contains duplicate protocol roles`)
  }
  for (const library of normalized) {
    if (
      library.address === ZERO_ADDRESS ||
      library.runtimeCodeHash === ZERO_WORD
    ) {
      throw new Error(`${label} contains a zero address/code binding`)
    }
  }
  return normalized
}

function normalizeLinkReferences(
  references: readonly P2TRActivationLinkReference[],
  label: string
): readonly P2TRActivationLinkReference[] {
  if (!Array.isArray(references)) throw new Error(`${label} is malformed`)
  const normalized = references
    .map((reference) => ({
      start: nonNegativeInteger(reference.start, `${label} start`),
      length:
        reference.length === 20
          ? (20 as const)
          : fail(`${label} must use 20-byte Solidity link references`),
    }))
    .sort((left, right) => left.start - right.start)
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index - 1].start + 20 > normalized[index].start) {
      throw new Error(`${label} contains overlapping offsets`)
    }
  }
  return normalized
}

function linkedLibraryDescriptors(
  libraries: readonly P2TRActivationLinkedLibraryBinding[],
  depth: number
): readonly Record<string, unknown>[] {
  if (!Array.isArray(libraries) || depth > 16) {
    throw new Error("Linked-library descriptor tree is malformed")
  }
  return libraries
    .map((library) => ({
      protocolRole: asciiRole(
        library.protocolRole,
        "linked-library protocol role"
      ),
      references: normalizeLinkReferences(
        library.references,
        `${library.protocolRole} descriptor references`
      ),
      linkedLibraries: linkedLibraryDescriptors(
        library.linkedLibraries,
        depth + 1
      ),
    }))
    .sort((left, right) =>
      compareASCII(String(left.protocolRole), String(right.protocolRole))
    )
}

export function hashP2TRActivationLinkedLibraryInventory(
  libraries: readonly P2TRActivationLinkedLibraryBinding[]
): string {
  return `0x${createHash("sha256")
    .update(
      canonicalJSON({
        schema: "tbtc-p2tr-linked-library-inventory/v1",
        linkedLibraries: linkedLibraryDescriptors(libraries, 0),
      }),
      "utf8"
    )
    .digest("hex")}`
}

function normalizeUpgradeability(
  value: P2TRActivationContractBinding["upgradeability"],
  role: string
): Record<string, unknown> {
  if (value.kind === "immutable") return { kind: "immutable" }
  if (value.kind !== "eip1967")
    throw new Error(`${role} upgradeability is invalid`)
  const implementationAddress = address(
    value.implementationAddress,
    `${role} implementation`
  )
  const adminAddress = address(value.adminAddress, `${role} proxy admin`)
  if (
    implementationAddress === ZERO_ADDRESS ||
    adminAddress === ZERO_ADDRESS ||
    implementationAddress === adminAddress
  ) {
    throw new Error(`${role} EIP-1967 implementation/admin is unsafe`)
  }
  const implementationSlotValue = bytes32(
    value.implementationSlotValue,
    `${role} implementation slot`
  )
  const adminSlotValue = bytes32(value.adminSlotValue, `${role} admin slot`)
  if (
    slotAddress(implementationSlotValue) !== implementationAddress ||
    slotAddress(adminSlotValue) !== adminAddress
  ) {
    throw new Error(`${role} EIP-1967 slot/address binding is inconsistent`)
  }
  if (
    bytes32(
      value.implementationRuntimeCodeHash,
      `${role} implementation code`
    ) === ZERO_WORD ||
    bytes32(value.adminRuntimeCodeHash, `${role} admin code`) === ZERO_WORD
  ) {
    throw new Error(`${role} EIP-1967 code hash is zero`)
  }
  return {
    kind: "eip1967",
    implementationAddress,
    implementationRuntimeCodeHash: bytes32(
      value.implementationRuntimeCodeHash,
      `${role} implementation code`
    ),
    adminAddress,
    adminRuntimeCodeHash: bytes32(
      value.adminRuntimeCodeHash,
      `${role} admin code`
    ),
    implementationSlotValue,
    adminSlotValue,
  }
}

function normalizeEcdsaCutover(
  value: P2TRProductionEcdsaCutover
): Record<string, unknown> {
  if (value.mode === "fresh") {
    if (
      value.routerOpenChallengeCount !== "0" ||
      value.bridgeLegacyChallengeCount !== "0"
    ) {
      throw new Error("Fresh ECDSA router must have zero legacy inventory")
    }
    const routerAddress = address(value.routerAddress, "fresh ECDSA router")
    const scanStartBlock = nonNegativeInteger(
      value.scanStartBlock,
      "ECDSA scan start"
    )
    const finalizedAtBlock = nonNegativeInteger(
      value.finalizedAtBlock,
      "fresh router finalization"
    )
    if (
      routerAddress === ZERO_ADDRESS ||
      bytes32(value.routerRuntimeCodeHash, "fresh router code") === ZERO_WORD ||
      finalizedAtBlock < scanStartBlock
    ) {
      throw new Error("Fresh ECDSA router binding/finalization is invalid")
    }
    return {
      mode: "fresh",
      scanStartBlock,
      routerAddress,
      routerRuntimeCodeHash: bytes32(
        value.routerRuntimeCodeHash,
        "fresh router code"
      ),
      finalizedAtBlock,
      routerOpenChallengeCount: "0",
      bridgeLegacyChallengeCount: "0",
    }
  }
  if (value.mode !== "migrated" || value.phase !== "finalized") {
    throw new Error("ECDSA cutover mode/phase is invalid")
  }
  if (
    value.previousRouterOpenChallengeCount !== "0" ||
    value.bridgeLegacyChallengeCount !== "0" ||
    value.challengeCount !== 0 ||
    value.totalEscrow !== "0" ||
    bytes32(value.challengeSetHash, "ECDSA challenge set") !==
      P2TR_ECDSA_EMPTY_CHALLENGE_SET_HASH
  ) {
    throw new Error(
      "Production ECDSA activation requires a canonical empty migration inventory"
    )
  }
  const previousRouterAddress = address(
    value.previousRouterAddress,
    "old ECDSA router"
  )
  const replacementRouterAddress = address(
    value.replacementRouterAddress,
    "replacement ECDSA router"
  )
  const cutoverCoordinatorAddress = address(
    value.cutoverCoordinatorAddress,
    "ECDSA cutover coordinator"
  )
  const scanStartBlock = nonNegativeInteger(
    value.scanStartBlock,
    "ECDSA scan start"
  )
  const migrationFinalizedBlock = nonNegativeInteger(
    value.migrationFinalizedBlock,
    "ECDSA finalization block"
  )
  if (
    previousRouterAddress === ZERO_ADDRESS ||
    replacementRouterAddress === ZERO_ADDRESS ||
    cutoverCoordinatorAddress === ZERO_ADDRESS ||
    previousRouterAddress === replacementRouterAddress ||
    migrationFinalizedBlock < scanStartBlock ||
    bytes32(value.previousRouterRuntimeCodeHash, "old ECDSA code") === ZERO_WORD
  ) {
    throw new Error("ECDSA replacement/cutover binding is invalid")
  }
  return {
    mode: "migrated",
    scanStartBlock,
    previousRouterAddress,
    previousRouterRuntimeCodeHash: bytes32(
      value.previousRouterRuntimeCodeHash,
      "old ECDSA code"
    ),
    replacementRouterAddress,
    cutoverCoordinatorAddress,
    migrationManifestHash: bytes32(
      value.migrationManifestHash,
      "ECDSA migration manifest"
    ),
    inventoryCommitment: bytes32(
      value.inventoryCommitment,
      "ECDSA inventory commitment"
    ),
    postMigrationCommitment: bytes32(
      value.postMigrationCommitment,
      "ECDSA post-migration commitment"
    ),
    challengeSetHash: bytes32(value.challengeSetHash, "ECDSA challenge set"),
    challengeCount: nonNegativeInteger(
      value.challengeCount,
      "ECDSA challenge count"
    ),
    totalEscrow: value.totalEscrow,
    migrationFinalizedBlock,
    phase: "finalized",
    previousRouterOpenChallengeCount: "0",
    bridgeLegacyChallengeCount: "0",
  }
}

function normalizeCompleteDepositKeyInventory(
  value: P2TRCompleteDepositKeyInventory
): P2TRCompleteDepositKeyInventory {
  const finalizedPoint = ethereumPoint(
    value.finalizedPoint,
    "deposit-key inventory point"
  )
  const eventCursor = ethereumPoint(
    value.eventCursor,
    "deposit-key inventory event cursor"
  )
  const storedOutputKeyRoot = bytes32(
    value.storedOutputKeyRoot,
    "stored deposit output-key root"
  )
  const commitmentOutputKeyRoot = bytes32(
    value.commitmentOutputKeyRoot,
    "committed deposit output-key root"
  )
  if (
    value.commitmentOnlyCustodyCount !== 0 ||
    bytes32(value.inventoryRoot, "deposit-key inventory root") === ZERO_WORD ||
    storedOutputKeyRoot === ZERO_WORD ||
    storedOutputKeyRoot !== commitmentOutputKeyRoot ||
    canonicalJSON(finalizedPoint) !== canonicalJSON(eventCursor)
  ) {
    throw new Error(
      "Deposit-key inventory has commitment-only custody or an incomplete event cursor"
    )
  }
  return {
    finalizedPoint,
    inventoryRoot: bytes32(value.inventoryRoot, "deposit-key inventory root"),
    storedOutputKeyRoot,
    commitmentOutputKeyRoot,
    inventoryCount: nonNegativeInteger(
      value.inventoryCount,
      "deposit-key inventory count"
    ),
    commitmentOnlyCustodyCount: 0,
    eventCursor,
  }
}

function normalizeFrostArchiveReadback(
  value: P2TRFrostArchiveReadback
): P2TRFrostArchiveReadback {
  if (value.mode !== "fresh" && value.mode !== "migrated") {
    throw new Error("FROST archive mode is invalid")
  }
  const tombstoneCount = nonNegativeInteger(
    value.closedWalletTombstoneCount,
    "FROST tombstone count"
  )
  const readbackCount = nonNegativeInteger(
    value.readbackTombstoneCount,
    "FROST tombstone readback count"
  )
  const tombstoneRoot = bytes32(
    value.closedWalletTombstoneRoot,
    "FROST tombstone root"
  )
  const readbackRoot = bytes32(
    value.readbackTombstoneRoot,
    "FROST tombstone readback root"
  )
  if (
    tombstoneCount !== readbackCount ||
    tombstoneRoot === ZERO_WORD ||
    tombstoneRoot !== readbackRoot ||
    bytes32(value.backfillManifestHash, "FROST archive backfill manifest") ===
      ZERO_WORD ||
    (value.mode === "fresh" && tombstoneCount !== 0) ||
    address(value.frostInactivityAddress, "FROST inactivity contract") !==
      address(
        value.registryFrostInactivityAddress,
        "FROST registry inactivity link"
      ) ||
    address(value.frostInactivityAddress, "FROST inactivity contract") ===
      ZERO_ADDRESS ||
    bytes32(
      value.frostInactivityRuntimeCodeHash,
      "FROST inactivity runtime code"
    ) === ZERO_WORD ||
    value.activeOnlyGetWalletSemantics !== true
  ) {
    throw new Error("FROST archive/backfill readback is incomplete")
  }
  return {
    mode: value.mode,
    finalizedPoint: ethereumPoint(
      value.finalizedPoint,
      "FROST archive finalization"
    ),
    backfillManifestHash: bytes32(
      value.backfillManifestHash,
      "FROST archive backfill manifest"
    ),
    closedWalletTombstoneRoot: tombstoneRoot,
    closedWalletTombstoneCount: tombstoneCount,
    readbackTombstoneRoot: readbackRoot,
    readbackTombstoneCount: readbackCount,
    frostInactivityAddress: address(
      value.frostInactivityAddress,
      "FROST inactivity contract"
    ),
    frostInactivityRuntimeCodeHash: bytes32(
      value.frostInactivityRuntimeCodeHash,
      "FROST inactivity runtime code"
    ),
    registryFrostInactivityAddress: address(
      value.registryFrostInactivityAddress,
      "FROST registry inactivity link"
    ),
    activeOnlyGetWalletSemantics: true,
  }
}

function normalizeFrostWalletGroupInventoryEntry(
  value: P2TRFrostWalletGroupInventoryEntry,
  inventoryPoint: P2TRProductionEthereumPoint
): P2TRFrostWalletGroupInventoryEntry {
  const creationPoint = ethereumEventPoint(
    value.creationPoint,
    "FROST wallet creation point"
  )
  const bridgeRegistrationPoint = ethereumEventPoint(
    value.bridgeRegistrationPoint,
    "FROST wallet Bridge registration point"
  )
  const lifecyclePoint = ethereumEventPoint(
    value.lifecyclePoint,
    "FROST wallet lifecycle point"
  )
  const registryClosurePoint =
    value.registryClosurePoint === undefined
      ? undefined
      : ethereumEventPoint(
          value.registryClosurePoint,
          "FROST wallet registry closure point"
        )
  const lifecycles = new Set<P2TRFrostWalletGroupInventoryEntry["lifecycle"]>([
    "live",
    "moving-funds",
    "closing",
    "closed",
    "terminated",
  ])
  const terminal =
    value.lifecycle === "closed" || value.lifecycle === "terminated"
  if (
    !lifecycles.has(value.lifecycle) ||
    !sameEthereumTransaction(creationPoint, bridgeRegistrationPoint) ||
    compareEthereumEventPoint(creationPoint, bridgeRegistrationPoint) >= 0 ||
    compareEthereumEventPoint(bridgeRegistrationPoint, lifecyclePoint) > 0 ||
    lifecyclePoint.blockNumber > inventoryPoint.blockNumber ||
    (lifecyclePoint.blockNumber === inventoryPoint.blockNumber &&
      lifecyclePoint.blockHash !== inventoryPoint.blockHash) ||
    terminal !== (registryClosurePoint !== undefined) ||
    (registryClosurePoint !== undefined &&
      (!sameEthereumTransaction(lifecyclePoint, registryClosurePoint) ||
        compareEthereumEventPoint(lifecyclePoint, registryClosurePoint) >= 0))
  ) {
    throw new Error("FROST retained-group lifecycle history is inconsistent")
  }
  const actualGroupSize = positiveInteger(
    value.actualGroupSize,
    "FROST retained group size"
  )
  if (actualGroupSize < 51 || actualGroupSize > 100) {
    throw new Error("FROST retained group size must be between 51 and 100")
  }
  return {
    walletID: bytes32(value.walletID, "FROST inventory wallet ID"),
    retainedGroupHash: bytes32(
      value.retainedGroupHash,
      "FROST retained group hash"
    ),
    actualGroupSize,
    lifecycle: value.lifecycle,
    creationPoint,
    bridgeRegistrationPoint,
    lifecyclePoint,
    ...(registryClosurePoint === undefined ? {} : { registryClosurePoint }),
  }
}

function normalizeFrostWalletGroupInventory(
  value: P2TRFrostWalletGroupInventory
): P2TRFrostWalletGroupInventory {
  if (
    value.schema !== P2TR_FROST_WALLET_GROUP_INVENTORY_SCHEMA ||
    value.membershipAmbiguityCount !== 0 ||
    value.groupSizeViolationCount !== 0 ||
    value.complete !== true
  ) {
    throw new Error("FROST retained-group inventory is incomplete or ambiguous")
  }
  const walletCount = nonNegativeInteger(
    value.walletCount,
    "FROST inventory wallet count"
  )
  const minimumActualGroupSize = nonNegativeInteger(
    value.minimumActualGroupSize,
    "FROST inventory minimum group size"
  )
  const maximumActualGroupSize = nonNegativeInteger(
    value.maximumActualGroupSize,
    "FROST inventory maximum group size"
  )
  if (
    (walletCount === 0 &&
      (minimumActualGroupSize !== 0 || maximumActualGroupSize !== 0)) ||
    (walletCount > 0 &&
      (minimumActualGroupSize < 51 ||
        minimumActualGroupSize > maximumActualGroupSize ||
        maximumActualGroupSize > 100))
  ) {
    throw new Error("FROST retained-group inventory size bounds are invalid")
  }
  return {
    schema: P2TR_FROST_WALLET_GROUP_INVENTORY_SCHEMA,
    point: ethereumPoint(value.point, "FROST inventory point"),
    snapshotGeneration: nonNegativeInteger(
      value.snapshotGeneration,
      "FROST inventory snapshot generation"
    ),
    inventoryRoot: bytes32(value.inventoryRoot, "FROST inventory root"),
    walletCount,
    minimumActualGroupSize,
    maximumActualGroupSize,
    membershipAmbiguityCount: 0,
    groupSizeViolationCount: 0,
    complete: true,
  }
}

function normalizeOutboxSenderLanes(
  lanes: readonly {
    laneID: string
    trustDomainID: string
    operatorFingerprint: string
    healthy: boolean
  }[]
): readonly {
  laneID: string
  trustDomainID: string
  operatorFingerprint: string
  healthy: true
}[] {
  return lanes
    .map((lane) => {
      if (lane.healthy !== true) {
        throw new Error("Outbox sender lane is unhealthy")
      }
      return {
        laneID: boundedString(lane.laneID, 64, "outbox sender lane ID"),
        trustDomainID: boundedString(
          lane.trustDomainID,
          128,
          "outbox sender lane domain"
        ),
        operatorFingerprint: bytes32(
          lane.operatorFingerprint,
          "outbox sender lane operator"
        ),
        healthy: true as const,
      }
    })
    .sort((left, right) => left.laneID.localeCompare(right.laneID))
}

function normalizeEthereumState(
  state: P2TRProductionEthereumState
): P2TRProductionEthereumState {
  return {
    point: ethereumPoint(state.point, "Ethereum state point"),
    contracts: deepClone(state.contracts),
    ecdsaCutover: deepClone(state.ecdsaCutover),
    bridgeBindings: {
      p2trFraudRouter: address(
        state.bridgeBindings.p2trFraudRouter,
        "state P2TR router"
      ),
      ecdsaFraudRouter: address(
        state.bridgeBindings.ecdsaFraudRouter,
        "state ECDSA router"
      ),
      frostWalletRegistry: address(
        state.bridgeBindings.frostWalletRegistry,
        "state FROST registry"
      ),
      completeAuthorizationRegistry: address(
        state.bridgeBindings.completeAuthorizationRegistry,
        "state authorization registry"
      ),
      ecdsaRetired: state.bridgeBindings.ecdsaRetired,
    },
    completeDepositKeyInventory: normalizeCompleteDepositKeyInventory(
      state.completeDepositKeyInventory
    ),
    frostArchive: normalizeFrostArchiveReadback(state.frostArchive),
    frostWalletGroupInventory: normalizeFrostWalletGroupInventory(
      state.frostWalletGroupInventory
    ),
    requiredEventHistoryDigest: bytes32(
      state.requiredEventHistoryDigest,
      "required Ethereum event history digest"
    ),
    requiredEventCount: nonNegativeInteger(
      state.requiredEventCount,
      "required Ethereum event count"
    ),
    requiredEventCoverage: normalizeEthereumHistoryCoverageCounters(
      state.requiredEventCoverage,
      "required Ethereum receipt coverage"
    ),
  }
}

function normalizeEthereumHistoryState(
  state: P2TRProductionEthereumHistoryState,
  label: string
): P2TRProductionEthereumHistoryState {
  return {
    point: ethereumPoint(state.point, `${label} point`),
    requiredEventHistoryDigest: bytes32(
      state.requiredEventHistoryDigest,
      `${label} digest`
    ),
    requiredEventCount: nonNegativeInteger(
      state.requiredEventCount,
      `${label} event count`
    ),
    requiredEventCoverage: normalizeEthereumHistoryCoverageCounters(
      state.requiredEventCoverage,
      `${label} receipt coverage`
    ),
  }
}

function normalizeCandidate(
  candidate: P2TRProductionBitcoinCandidateIdentity
): P2TRProductionBitcoinCandidate {
  const identity = {
    txid: bitcoinHash(candidate.txid, "candidate txid"),
    wtxid: bitcoinHash(candidate.wtxid, "candidate wtxid"),
    blockHeight: nonNegativeInteger(
      candidate.blockHeight,
      "candidate block height"
    ),
    blockHash: bitcoinHash(candidate.blockHash, "candidate block hash"),
    inputIndex: uint32(candidate.inputIndex, "candidate input index"),
    observationID: bytes32(candidate.observationID, "candidate observation ID"),
    challengeKey: bytes32(candidate.challengeKey, "candidate challenge key"),
  }
  return identity
}

export function deriveP2TRProductionCandidateObservationID(
  candidate: P2TRProductionBitcoinCandidateTransactionIdentity
): string {
  const identity = {
    txid: bitcoinHash(candidate.txid, "candidate txid"),
    wtxid: bitcoinHash(candidate.wtxid, "candidate wtxid"),
    blockHeight: nonNegativeInteger(
      candidate.blockHeight,
      "candidate block height"
    ),
    blockHash: bitcoinHash(candidate.blockHash, "candidate block hash"),
  }
  return `0x${createHash("sha256")
    .update("tbtc-p2tr-canonical-bitcoin-candidate/v1\u0000", "utf8")
    .update(canonicalJSON(identity), "utf8")
    .digest("hex")}`
}

export function computeP2TRProductionCandidateDigest(
  candidate: P2TRProductionBitcoinCandidate
): string {
  return `0x${createHash("sha256")
    .update(canonicalJSON(normalizeCandidate(candidate)))
    .digest("hex")}`
}

function normalizeCandidateEnqueueOutcome(
  outcome: P2TRProductionCandidateEnqueueOutcome
): P2TRProductionCandidateEnqueueOutcome {
  if (!isPlainObject(outcome)) {
    throw new Error("Candidate enqueue outcome is malformed")
  }
  const outboxIntentID = bytes32(
    outcome.outboxIntentID,
    "candidate enqueue outbox intent ID"
  )
  if (outcome.kind === "enqueued") {
    return { kind: outcome.kind, outboxIntentID }
  }
  if (outcome.kind === "generation-cap-exhausted") {
    return {
      kind: outcome.kind,
      outboxIntentID,
      message: boundedString(
        outcome.message,
        1024,
        "generation-cap enqueue rejection"
      ),
    }
  }
  throw new Error("Candidate enqueue outcome kind is unsupported")
}

function ethereumPoint(
  point: P2TRProductionEthereumPoint,
  label: string
): P2TRProductionEthereumPoint {
  return {
    blockNumber: nonNegativeInteger(point.blockNumber, `${label} number`),
    blockHash: bytes32(point.blockHash, `${label} hash`),
  }
}

function ethereumEventPoint(
  point: P2TRProductionEthereumEventPoint,
  label: string
): P2TRProductionEthereumEventPoint {
  return {
    ...ethereumPoint(point, label),
    transactionHash: bytes32(
      point.transactionHash,
      `${label} transaction hash`
    ),
    transactionIndex: nonNegativeInteger(
      point.transactionIndex,
      `${label} transaction index`
    ),
    logIndex: nonNegativeInteger(point.logIndex, `${label} log index`),
  }
}

function compareEthereumEventPoint(
  left: P2TRProductionEthereumEventPoint,
  right: P2TRProductionEthereumEventPoint
): number {
  return (
    left.blockNumber - right.blockNumber ||
    left.transactionIndex - right.transactionIndex ||
    left.logIndex - right.logIndex
  )
}

function sameEthereumTransaction(
  left: P2TRProductionEthereumEventPoint,
  right: P2TRProductionEthereumEventPoint
): boolean {
  return (
    left.blockNumber === right.blockNumber &&
    left.blockHash === right.blockHash &&
    left.transactionIndex === right.transactionIndex &&
    left.transactionHash === right.transactionHash
  )
}

function bitcoinPoint(
  point: P2TRProductionBitcoinPoint,
  label: string
): P2TRProductionBitcoinPoint {
  return {
    height: nonNegativeInteger(point.height, `${label} height`),
    hash: bitcoinHash(point.hash, `${label} hash`),
  }
}

function bitcoinHash(value: string, label: string): string {
  return bytes32(value, label).slice(2)
}

function slotAddress(slot: string): string {
  return `0x${slot.slice(-40)}`
}

function decodeBoundedBase64(
  value: string,
  maximum: number,
  label: string
): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error(`${label} must be canonical base64`)
  }
  const decoded = Buffer.from(value, "base64")
  if (
    decoded.length === 0 ||
    decoded.length > maximum ||
    decoded.toString("base64") !== value
  ) {
    throw new Error(`${label} is malformed or exceeds its bound`)
  }
  return decoded
}

/** Shared digest format for independent provider and PostgreSQL journal reads. */
export function hashP2TRRequiredEventHistory(
  records: readonly unknown[]
): string {
  if (!Array.isArray(records)) {
    throw new Error("Required Ethereum event history must be an array")
  }
  return `0x${createHash("sha256")
    .update("tbtc-p2tr-required-event-history/v1\u0000", "utf8")
    .update(canonicalJSON(records), "utf8")
    .digest("hex")}`
}

export type P2TREthereumHistoryCoverageCounters = {
  blocks: number
  transactions: number
  receipts: number
  logs: number
  requiredEvents: number
}

export type P2TREthereumHistoryAccumulatorState = {
  root: string
  counters: P2TREthereumHistoryCoverageCounters
}

export function initialP2TRRequiredEventHistoryRoot(
  chainID: number,
  checkpoint: P2TRProductionEthereumPoint
): P2TREthereumHistoryAccumulatorState {
  const counters = {
    blocks: 0,
    transactions: 0,
    receipts: 0,
    logs: 0,
    requiredEvents: 0,
  }
  return {
    root: `0x${createHash("sha256")
      .update(
        canonicalJSON({
          schema: "tbtc-p2tr-receipt-coverage-accumulator/v3",
          chainID: positiveInteger(chainID, "event accumulator chain ID"),
          checkpoint: ethereumPoint(checkpoint, "event accumulator checkpoint"),
          counters,
        }),
        "utf8"
      )
      .digest("hex")}`,
    counters,
  }
}

export function accumulateP2TRRequiredEventHistoryBlock(
  previous: P2TREthereumHistoryAccumulatorState,
  block: { blockNumber: number; blockHash: string; parentHash: string },
  coverage: {
    transactionsRoot: string
    receiptsRoot: string
    transactionDigest: string
    transactionCount: number
    receiptDigest: string
    receiptCount: number
    logDigest: string
    logCount: number
    requiredEventDigest: string
    requiredEventCount: number
  },
  records: readonly unknown[]
): P2TREthereumHistoryAccumulatorState {
  const previousCounters = normalizeEthereumHistoryCoverageCounters(
    previous.counters,
    "previous Ethereum coverage"
  )
  const transactionCount = nonNegativeInteger(
    coverage.transactionCount,
    "Ethereum block transaction count"
  )
  const receiptCount = nonNegativeInteger(
    coverage.receiptCount,
    "Ethereum block receipt count"
  )
  const logCount = nonNegativeInteger(
    coverage.logCount,
    "Ethereum block log count"
  )
  const requiredEventCount = nonNegativeInteger(
    coverage.requiredEventCount,
    "Ethereum block required-event count"
  )
  const expectedEventDigest = hashP2TRRequiredEventHistory(records)
  if (
    transactionCount !== receiptCount ||
    requiredEventCount !== records.length ||
    bytes32(coverage.requiredEventDigest, "required-event coverage digest") !==
      expectedEventDigest
  ) {
    throw new Error("Ethereum block receipt/event coverage is inconsistent")
  }
  const normalizedCoverage = {
    transactionsRoot: bytes32(
      coverage.transactionsRoot,
      "Ethereum transactions trie root"
    ),
    receiptsRoot: bytes32(coverage.receiptsRoot, "Ethereum receipts trie root"),
    transactionDigest: bytes32(
      coverage.transactionDigest,
      "Ethereum transaction coverage digest"
    ),
    transactionCount,
    receiptDigest: bytes32(
      coverage.receiptDigest,
      "Ethereum receipt coverage digest"
    ),
    receiptCount,
    logDigest: bytes32(coverage.logDigest, "Ethereum log coverage digest"),
    logCount,
    requiredEventDigest: expectedEventDigest,
    requiredEventCount,
  }
  const counters = {
    blocks: previousCounters.blocks + 1,
    transactions: previousCounters.transactions + transactionCount,
    receipts: previousCounters.receipts + receiptCount,
    logs: previousCounters.logs + logCount,
    requiredEvents: previousCounters.requiredEvents + requiredEventCount,
  }
  for (const [name, value] of Object.entries(counters)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Ethereum cumulative ${name} coverage exceeds safe range`)
    }
  }
  return {
    root: `0x${createHash("sha256")
      .update(
        canonicalJSON({
          schema: "tbtc-p2tr-receipt-coverage-accumulator/v3",
          previousRoot: bytes32(
            previous.root,
            "previous event accumulator root"
          ),
          block: {
            blockNumber: nonNegativeInteger(
              block.blockNumber,
              "event block number"
            ),
            blockHash: bytes32(block.blockHash, "event block hash"),
            parentHash: bytes32(block.parentHash, "event parent hash"),
          },
          coverage: normalizedCoverage,
          counters,
        }),
        "utf8"
      )
      .digest("hex")}`,
    counters,
  }
}

function normalizeEthereumHistoryCoverageCounters(
  value: P2TREthereumHistoryCoverageCounters,
  label: string
): P2TREthereumHistoryCoverageCounters {
  return {
    blocks: nonNegativeInteger(value.blocks, `${label} block count`),
    transactions: nonNegativeInteger(
      value.transactions,
      `${label} transaction count`
    ),
    receipts: nonNegativeInteger(value.receipts, `${label} receipt count`),
    logs: nonNegativeInteger(value.logs, `${label} log count`),
    requiredEvents: nonNegativeInteger(
      value.requiredEvents,
      `${label} required-event count`
    ),
  }
}

function canonicalJSON(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Canonical JSON number is unsafe")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`
  }
  throw new Error("Activation state contains a non-JSON value")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
  }
  return value
}

function bytes32(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be hex`)
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized))
    throw new Error(`${label} must be 32 bytes`)
  return `0x${normalized}`
}

function address(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be hex`)
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(normalized))
    throw new Error(`${label} must be 20 bytes`)
  return `0x${normalized}`
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

function asciiRole(value: string, label: string): string {
  const normalized = boundedString(value, 255, label)
  if (!/^[A-Za-z0-9._:/-]+$/.test(normalized)) {
    throw new Error(`${label} must be printable canonical ASCII`)
  }
  return normalized
}

function compareASCII(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function boundedPositiveInteger(
  value: number,
  maximum: number,
  label: string
): number {
  const normalized = positiveInteger(value, label)
  if (normalized > maximum) {
    throw new Error(`${label} exceeds its ${maximum}-attempt bound`)
  }
  return normalized
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function uint32(value: number, label: string): number {
  const normalized = nonNegativeInteger(value, label)
  if (normalized > 0xffffffff) {
    throw new Error(`${label} must be a uint32`)
  }
  return normalized
}

function fail(message: string): never {
  throw new Error(message)
}
