import fs from "fs"
import path from "path"
import { deployments, ethers, network } from "hardhat"
import type { BigNumber, Contract } from "ethers"
import {
  loadCutoverInventory,
  loadCutoverManifest,
  writeCutoverInventory,
  writeCutoverManifest,
} from "./ecdsa-fraud-router-cutover-artifacts"
import { canonicalHistoryCheckpointCommitment } from "./ecdsa-fraud-router-canonical-history"
import {
  CanonicalHistoryJournalFile,
  canonicalHistoryJournalContains,
  loadCanonicalHistoryJournal,
  nextCanonicalHistoryJournal,
  normalizeDurableStoreIdentity,
  saveCanonicalHistoryJournal,
} from "./ecdsa-fraud-router-journal-store"
import {
  assertIndependentArtifactStores,
  readPrivateFileWithHash,
} from "./durable-artifact"
import {
  assertCanonicalInventory,
  assertAuthoritySignature,
  assertCutoverAuthoritySeparation,
  assertLegacyGovernanceReadyForHandoff,
  assertLegacyInventorySourcePreflight,
  assertManifestSignature,
  artifactContentHashBytes32,
  AuthorityContext,
  authorityContextCommitment,
  BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH,
  buildCanonicalInventory,
  buildLegacyInventorySourcePreflight,
  canonicalEmitterSetCommitment,
  CanonicalHistoryScan,
  checkpointRoleDigests,
  cutoverPreflightTiming,
  encodeAuthorityProof,
  encodeInventorySnapshot,
  extendCanonicalHistoryJournal,
  discoverHistoryEmitters,
  handoffPlanHash,
  HandoffManifest,
  InventoryBundle,
  inventoryAuthorityAttestationHashes,
  legacyInventorySourcePreflightHash,
  ownerAuthorizationHash,
  readLegacyGovernanceStorage,
  reconcilerEnrollmentAttestationHash,
  reconcilerRecoveryAttestationHash,
} from "./ecdsa-fraud-router-cutover-lib"

const CURRENT_PROTOCOL_ID = ethers.utils.id(
  "tbtc/ecdsa-signature-fraud/router/current-v3"
)
const ZERO_ADDRESS = ethers.constants.AddressZero
const ZERO_HASH = ethers.constants.HashZero
const FINALITY_CONFIRMATIONS = 64
const MAX_BLOCKHASH_AGE = 255

type CutoverAction =
  | "inspect"
  | "print-plan-hash"
  | "print-inventory-hash"
  | "verify-preflight"
  | "refresh-preflight"
  | "build-inventory"
  | "begin-governance-handoff"
  | "finalize-governance-handoff"
  | "authorize-drain"
  | "begin-drain"
  | "stage-inventory"
  | "confirm-inventory"
  | "migrate"
  | "print-reconciler-enrollment-hash"
  | "print-reconciler-recovery-hash"
  | "begin-reconciler-update"
  | "finalize-reconciler-update"
  | "confirm-migration"
  | "finalize"

type CutoverState = {
  phase: number
  oldRouter: string
  newRouter: string
  finalizedBlock: BigNumber
  finalizedBlockHash: string
  sourceSigner: string
  sourceId: string
  reconciler: string
  reconcilerSourceId: string
  inventoryCommitment: string
  postMigrationCommitment: string
  migratedBlock: BigNumber
  migrationConfirmedAt: BigNumber
  pendingReconciler: string
  pendingReconcilerSourceId: string
  sourceContext: AuthorityContext
  reconcilerContext: AuthorityContext
  pendingReconcilerContext: AuthorityContext
  sourceContextCommitment: string
  reconcilerContextCommitment: string
  sourceCheckpointRoleDigest: string
  reconcilerCheckpointRoleDigest: string
  sourceCheckpointCommitment: string
  sourcePreflightCommitment: string
  sourcePreflightBlock: BigNumber
  evidenceGeneration: number
  evidenceAnchorArtifactHash: string
  evidencePredecessorArtifactHash: string
  drainBlock: BigNumber
  maxTailBlocks: number
  stageDeadlineBlock: BigNumber
  ownerAuthorizationHash: string
}

const ACTIONS: CutoverAction[] = [
  "inspect",
  "print-plan-hash",
  "print-inventory-hash",
  "verify-preflight",
  "refresh-preflight",
  "build-inventory",
  "begin-governance-handoff",
  "finalize-governance-handoff",
  "authorize-drain",
  "begin-drain",
  "stage-inventory",
  "confirm-inventory",
  "migrate",
  "print-reconciler-enrollment-hash",
  "print-reconciler-recovery-hash",
  "begin-reconciler-update",
  "finalize-reconciler-update",
  "confirm-migration",
  "finalize",
]

function parseAction(value: string | undefined): CutoverAction {
  const action = (value ?? "inspect") as CutoverAction
  if (!ACTIONS.includes(action)) {
    throw new Error(
      `ECDSA_CUTOVER_ACTION must be one of: ${ACTIONS.join(", ")}`
    )
  }
  return action
}

function manifestPath(): string {
  return (
    process.env.ECDSA_CUTOVER_MANIFEST ??
    path.join(
      __dirname,
      "..",
      "deployments",
      network.name,
      "ecdsa-fraud-router-cutover-manifest.json"
    )
  )
}

let manifestFileContentHash: string | undefined

function loadManifest(): HandoffManifest {
  const file = manifestPath()
  if (!fs.existsSync(file)) {
    throw new Error(
      `cutover manifest not found at ${file}; run deployment 87 first`
    )
  }
  const loaded = loadCutoverManifest(file)
  manifestFileContentHash = loaded.fileContentHash
  return loaded.value
}

function saveManifest(
  manifest: HandoffManifest,
  phase: string,
  action?: string,
  txHash?: string
): void {
  if (!manifestFileContentHash) {
    throw new Error("cutover manifest CAS state is unavailable")
  }
  const cutoverAuthorizationBound =
    action === "begin-drain" || Boolean(manifest.transactions?.["begin-drain"])
  const predecessorArtifactHash = artifactContentHashBytes32(
    manifestFileContentHash
  )
  const evidenceLineage = cutoverAuthorizationBound
    ? {
        evidenceGeneration: manifest.evidenceGeneration,
        evidenceAnchorArtifactHash: manifest.evidenceAnchorArtifactHash,
        evidencePredecessorArtifactHash:
          manifest.evidencePredecessorArtifactHash,
      }
    : {
        evidenceGeneration: manifest.evidenceGeneration + 1,
        evidenceAnchorArtifactHash:
          manifest.evidenceGeneration === 0
            ? predecessorArtifactHash
            : manifest.evidenceAnchorArtifactHash,
        evidencePredecessorArtifactHash: predecessorArtifactHash,
      }
  const updated: HandoffManifest = {
    ...manifest,
    ...evidenceLineage,
    phase,
    transactions: {
      ...(manifest.transactions ?? {}),
      ...(action && txHash ? { [action]: txHash } : {}),
    },
  }
  const file = manifestPath()
  manifestFileContentHash = writeCutoverManifest(file, updated, {
    expectedCurrentContentHash: manifestFileContentHash,
  })
  // Keep subsequent idempotent readback/save steps in this invocation from
  // dropping the transaction hash that was just persisted atomically.
  // eslint-disable-next-line no-param-reassign
  manifest.phase = updated.phase
  // eslint-disable-next-line no-param-reassign
  manifest.evidenceGeneration = updated.evidenceGeneration
  // eslint-disable-next-line no-param-reassign
  manifest.evidenceAnchorArtifactHash = updated.evidenceAnchorArtifactHash
  // eslint-disable-next-line no-param-reassign
  manifest.evidencePredecessorArtifactHash =
    updated.evidencePredecessorArtifactHash
  // eslint-disable-next-line no-param-reassign
  manifest.transactions = updated.transactions
}

function inventoryPath(required: boolean): string | undefined {
  const file = process.env.ECDSA_CUTOVER_INVENTORY
  if (!file && required) {
    throw new Error("ECDSA_CUTOVER_INVENTORY is required for this action")
  }
  return file
}

function loadInventory(manifest: HandoffManifest): InventoryBundle {
  const file = inventoryPath(true) as string
  const inventory = loadCutoverInventory(file).value
  assertCanonicalInventory(manifest, inventory)
  return inventory
}

function normalizeState(raw: any): CutoverState {
  return {
    phase: Number(raw.phase),
    oldRouter: raw.oldRouter,
    newRouter: raw.newRouter,
    finalizedBlock: raw.finalizedBlock,
    finalizedBlockHash: raw.finalizedBlockHash,
    sourceSigner: raw.sourceSigner,
    sourceId: raw.sourceId,
    reconciler: raw.reconciler,
    reconcilerSourceId: raw.reconcilerSourceId,
    inventoryCommitment: raw.inventoryCommitment,
    postMigrationCommitment: raw.postMigrationCommitment,
    migratedBlock: raw.migratedBlock,
    migrationConfirmedAt: raw.migrationConfirmedAt,
    pendingReconciler: raw.pendingReconciler,
    pendingReconcilerSourceId: raw.pendingReconcilerSourceId,
    sourceContext: raw.sourceContext,
    reconcilerContext: raw.reconcilerContext,
    pendingReconcilerContext: raw.pendingReconcilerContext,
    sourceContextCommitment: raw.sourceContextCommitment,
    reconcilerContextCommitment: raw.reconcilerContextCommitment,
    sourceCheckpointRoleDigest: raw.sourceCheckpointRoleDigest,
    reconcilerCheckpointRoleDigest: raw.reconcilerCheckpointRoleDigest,
    sourceCheckpointCommitment: raw.sourceCheckpointCommitment,
    sourcePreflightCommitment: raw.sourcePreflightCommitment,
    sourcePreflightBlock: raw.sourcePreflightBlock,
    evidenceGeneration: Number(raw.evidenceGeneration),
    evidenceAnchorArtifactHash: raw.evidenceAnchorArtifactHash,
    evidencePredecessorArtifactHash: raw.evidencePredecessorArtifactHash,
    drainBlock: raw.drainBlock,
    maxTailBlocks: Number(raw.maxTailBlocks),
    stageDeadlineBlock: raw.stageDeadlineBlock,
    ownerAuthorizationHash: raw.ownerAuthorizationHash,
  }
}

async function getState(governance: Contract): Promise<CutoverState> {
  return normalizeState(await governance.ecdsaFraudCutoverReadiness())
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function sameAuthorityContext(
  left: AuthorityContext,
  right: AuthorityContext
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    sameHash(left.durableStoreIdentity, right.durableStoreIdentity) &&
    sameHash(left.endpointIdentity, right.endpointIdentity) &&
    sameHash(left.trustDomain, right.trustDomain) &&
    sameHash(left.policyHash, right.policyHash)
  )
}

function independentAuthorityContexts(
  left: AuthorityContext,
  right: AuthorityContext
): boolean {
  return (
    !sameHash(left.durableStoreIdentity, right.durableStoreIdentity) &&
    !sameHash(left.endpointIdentity, right.endpointIdentity) &&
    !sameHash(left.trustDomain, right.trustDomain) &&
    !sameHash(left.policyHash, right.policyHash)
  )
}

async function runtimeCodeHash(address: string): Promise<string> {
  const code = await ethers.provider.getCode(address)
  if (code === "0x") throw new Error(`${address} has no runtime bytecode`)
  return ethers.utils.keccak256(code)
}

async function assertCodeHash(
  address: string,
  expected: string
): Promise<void> {
  const actual = await runtimeCodeHash(address)
  if (!sameHash(actual, expected)) {
    throw new Error(
      `runtime code hash mismatch for ${address}: expected ${expected}, got ${actual}`
    )
  }
}

async function assertRouterHandshake(
  address: string,
  bridge: string,
  expectedPredecessor: string,
  expectedPredecessorCodeHash: string
): Promise<void> {
  const router = await ethers.getContractAt("EcdsaFraudRouter", address)
  const [
    boundBridge,
    protocolID,
    predecessor,
    predecessorCodeHash,
    ancestryDepth,
  ] = await Promise.all([
    router.bridge(),
    router.fraudProtocolID(),
    router.predecessor(),
    router.predecessorCodeHash(),
    router.ancestryDepth(),
  ])
  if (!sameAddress(boundBridge, bridge)) {
    throw new Error(
      `${address} is bound to Bridge ${boundBridge}, not ${bridge}`
    )
  }
  if (!sameHash(protocolID, CURRENT_PROTOCOL_ID)) {
    throw new Error(`${address} exposes unsupported ECDSA fraud protocol`)
  }
  if (!sameAddress(predecessor, expectedPredecessor)) {
    throw new Error(
      `${address} inherits ${predecessor}, not signed predecessor ${expectedPredecessor}`
    )
  }
  if (!sameHash(predecessorCodeHash, expectedPredecessorCodeHash)) {
    throw new Error(
      `${address} pins predecessor code hash ${predecessorCodeHash}, not ` +
        `signed hash ${expectedPredecessorCodeHash}`
    )
  }
  if (sameAddress(expectedPredecessor, ZERO_ADDRESS)) {
    if (!sameHash(predecessorCodeHash, ZERO_HASH) || ancestryDepth !== 0) {
      throw new Error(`${address} exposes a non-empty fresh-router ancestry`)
    }
  } else if (ancestryDepth === 0 || ancestryDepth > 8) {
    throw new Error(
      `${address} exposes invalid ancestry depth ${ancestryDepth}`
    )
  }
}

async function assertManifestStatic(
  manifest: HandoffManifest,
  bridge: Contract,
  newGovernance: Contract
): Promise<void> {
  if (manifest.version !== 5) throw new Error("unsupported manifest version")
  if (!manifest.legacyInventorySourcePreflight) {
    throw new Error("manifest lacks signed legacy inventory source preflight")
  }
  const preflightFinalizedBlock =
    manifest.legacyInventorySourcePreflight.history.finalizedBlock
  if (
    !ethers.utils.isHexString(manifest.sourceCheckpointCommitment, 32) ||
    sameHash(manifest.sourceCheckpointCommitment, ZERO_HASH) ||
    !Number.isSafeInteger(manifest.maxTailBlocks) ||
    manifest.maxTailBlocks < FINALITY_CONFIRMATIONS ||
    manifest.maxTailBlocks > MAX_BLOCKHASH_AGE ||
    preflightFinalizedBlock < manifest.scanStartBlock
  ) {
    throw new Error("invalid authenticated-tail commitment in manifest")
  }
  assertLegacyInventorySourcePreflight(manifest)
  assertCutoverAuthoritySeparation(manifest)
  const { chainId } = await ethers.provider.getNetwork()
  if (manifest.chainId !== chainId) {
    throw new Error(
      `manifest chain ${manifest.chainId} does not match ${chainId}`
    )
  }
  const bridgeDeployment = await deployments.get("Bridge")
  if (!sameAddress(bridgeDeployment.address, manifest.bridge)) {
    throw new Error("manifest Bridge does not match the network deployment")
  }
  if (manifest.scanStartBlock !== manifest.bridgeDeploymentBlock) {
    throw new Error(
      "manifest scan floor must equal the Bridge deployment block"
    )
  }
  if (
    !sameHash(
      manifest.bridgeLegacyFraudStorageLayoutHash,
      BRIDGE_LEGACY_FRAUD_STORAGE_LAYOUT_HASH
    )
  ) {
    throw new Error("manifest Bridge legacy-fraud storage fingerprint mismatch")
  }
  if (
    bridgeDeployment.receipt?.blockNumber !== undefined &&
    bridgeDeployment.receipt.blockNumber !== manifest.bridgeDeploymentBlock
  ) {
    throw new Error(
      "manifest Bridge deployment block does not match deployment receipt"
    )
  }
  await Promise.all([
    assertCodeHash(
      manifest.oldGovernance,
      manifest.oldGovernanceRuntimeCodeHash
    ),
    assertCodeHash(
      manifest.newGovernance,
      manifest.newGovernanceRuntimeCodeHash
    ),
    assertCodeHash(manifest.oldRouter, manifest.oldRouterRuntimeCodeHash),
    assertCodeHash(
      manifest.replacementRouter,
      manifest.replacementRouterRuntimeCodeHash
    ),
    assertRouterHandshake(
      manifest.replacementRouter,
      manifest.bridge,
      manifest.oldRouter,
      manifest.oldRouterRuntimeCodeHash
    ),
    ...manifest.historyEmitters.map((emitter) =>
      assertCodeHash(emitter.address, emitter.runtimeCodeHash)
    ),
  ])
  const discoveredEmitters = await discoverHistoryEmitters(
    ethers.provider,
    manifest.bridge,
    manifest.oldRouter,
    Object.fromEntries(
      manifest.historyEmitters.map((emitter) => [
        emitter.address,
        emitter.expectedUnrelatedBalance,
      ])
    )
  )
  if (
    JSON.stringify(discoveredEmitters) !==
    JSON.stringify(manifest.historyEmitters)
  ) {
    throw new Error(
      "manifest history emitter ancestry is incomplete or reordered"
    )
  }
  const sourcePreflightBlock = await ethers.provider.getBlock(
    manifest.legacyInventorySourcePreflight.history.finalizedBlock
  )
  if (
    !sourcePreflightBlock?.hash ||
    !sameHash(
      sourcePreflightBlock.hash,
      manifest.legacyInventorySourcePreflight.history.finalizedBlockHash
    )
  ) {
    throw new Error("signed legacy inventory source block is not canonical")
  }
  const [
    newGovernanceBridge,
    newOwner,
    newDelay,
    pendingDelay,
    pendingDelayStartedAt,
    pendingGovernanceTransferStartedAt,
    currentRouter,
    approvedHash,
    liveGovernance,
    replacementActivationEpoch,
  ] = await Promise.all([
    newGovernance.bridgeAddress(),
    newGovernance.owner(),
    newGovernance.governanceDelays(0),
    newGovernance.governanceDelays(1),
    newGovernance.governanceDelays(2),
    newGovernance.bridgeGovernanceTransferChangeInitiated(),
    bridge.ecdsaFraudRouter(),
    bridge.ecdsaFraudRouterCodeHash(),
    bridge.governance(),
    (
      await ethers.getContractAt("EcdsaFraudRouter", manifest.replacementRouter)
    ).migratedChallengesActivatedAt(),
  ])
  if (!sameAddress(newGovernanceBridge, manifest.bridge)) {
    throw new Error(
      `new BridgeGovernance targets ${newGovernanceBridge}, not ${manifest.bridge}`
    )
  }
  if (!sameAddress(newOwner, manifest.governanceOwner)) {
    throw new Error(`new BridgeGovernance owner mismatch: ${newOwner}`)
  }
  if (!newDelay.eq(manifest.governanceDelay)) {
    throw new Error(`new BridgeGovernance delay mismatch: ${newDelay}`)
  }
  if (!pendingDelay.isZero() || !pendingDelayStartedAt.isZero()) {
    throw new Error("new BridgeGovernance has a pending delay update")
  }
  if (!pendingGovernanceTransferStartedAt.isZero()) {
    throw new Error("new BridgeGovernance has a pending governance transfer")
  }
  if (
    !sameAddress(liveGovernance, manifest.oldGovernance) &&
    !sameAddress(liveGovernance, manifest.newGovernance)
  ) {
    throw new Error(`unexpected live Bridge.governance(): ${liveGovernance}`)
  }
  if (sameAddress(currentRouter, manifest.oldRouter)) {
    if (!replacementActivationEpoch.isZero()) {
      throw new Error("inactive replacement already has an activation epoch")
    }
    if (
      !sameHash(approvedHash, ZERO_HASH) &&
      !sameHash(approvedHash, manifest.oldRouterRuntimeCodeHash)
    ) {
      throw new Error(
        `Bridge approved an unexpected old-router hash ${approvedHash}`
      )
    }
  } else if (sameAddress(currentRouter, manifest.replacementRouter)) {
    if (replacementActivationEpoch.isZero()) {
      throw new Error("active replacement has no migration activation epoch")
    }
    if (!sameHash(approvedHash, manifest.replacementRouterRuntimeCodeHash)) {
      throw new Error(
        `Bridge replacement-router hash mismatch: ${approvedHash}`
      )
    }
  } else {
    throw new Error(
      `Bridge points to router outside the signed manifest: ${currentRouter}`
    )
  }
}

async function requireManifestSignatures(
  manifest: HandoffManifest
): Promise<{ source: string; reconciler: string }> {
  const source = process.env.ECDSA_CUTOVER_SOURCE_MANIFEST_SIGNATURE
  const reconciler = process.env.ECDSA_CUTOVER_RECONCILER_MANIFEST_SIGNATURE
  if (!source || !reconciler) {
    throw new Error(
      "both ECDSA_CUTOVER_SOURCE_MANIFEST_SIGNATURE and ECDSA_CUTOVER_RECONCILER_MANIFEST_SIGNATURE are required"
    )
  }
  await Promise.all([
    assertManifestSignature(ethers.provider, manifest, source, "source"),
    assertManifestSignature(
      ethers.provider,
      manifest,
      reconciler,
      "reconciler"
    ),
  ])
  return { source, reconciler }
}

function requiredBytes32(name: string): string {
  const value = process.env[name]
  if (
    !value ||
    !ethers.utils.isHexString(value, 32) ||
    ethers.BigNumber.from(value).isZero()
  ) {
    throw new Error(`${name} must be a nonzero bytes32 value`)
  }
  return ethers.utils.hexZeroPad(value, 32)
}

function recoveryReconcilerContext(): AuthorityContext {
  return {
    durableStoreIdentity: normalizeDurableStoreIdentity(
      requiredBytes32(
        "ECDSA_CUTOVER_RECOVERY_RECONCILER_DURABLE_STORE_IDENTITY"
      )
    ),
    endpointIdentity: requiredBytes32(
      "ECDSA_CUTOVER_RECOVERY_RECONCILER_ENDPOINT_IDENTITY"
    ),
    trustDomain: requiredBytes32(
      "ECDSA_CUTOVER_RECOVERY_RECONCILER_TRUST_DOMAIN"
    ),
    policyHash: requiredBytes32(
      "ECDSA_CUTOVER_RECOVERY_RECONCILER_POLICY_HASH"
    ),
  }
}

function assertActivationInventoryEmpty(inventory: InventoryBundle): void {
  if (
    inventory.challengeKeys.length !== 0 ||
    inventory.challengeCount !== 0 ||
    !ethers.BigNumber.from(inventory.totalEscrow).isZero()
  ) {
    throw new Error(
      "activation requires zero unresolved legacy challenges and zero escrow; migrate/resolve legacy state through the active recovery path before beginning this cutover"
    )
  }
}

async function configuredSigner(address: string) {
  const accounts = await ethers.provider.listAccounts()
  if (!accounts.some((account) => sameAddress(account, address)))
    return undefined
  return ethers.getSigner(address)
}

async function submitOrPrint(
  target: Contract,
  expectedSender: string,
  method: string,
  args: unknown[]
): Promise<string | undefined> {
  const data = target.interface.encodeFunctionData(method, args)
  console.log(`target: ${target.address}`)
  console.log(`data:   ${data}`)
  console.log(`sender: ${expectedSender}`)
  if (process.env.ECDSA_CUTOVER_EXECUTE !== "true") {
    console.log("calldata only; set ECDSA_CUTOVER_EXECUTE=true to submit")
    return undefined
  }
  const signer = await configuredSigner(expectedSender)
  if (!signer) {
    throw new Error(
      `expected sender ${expectedSender} is not a configured signer; submit the printed calldata through its Safe/governance workflow`
    )
  }
  const transaction = await signer.sendTransaction({ to: target.address, data })
  const receipt = await transaction.wait(1)
  if (receipt.status !== 1) throw new Error(`${method} transaction failed`)
  console.log(`submitted ${method}: ${transaction.hash}`)
  return transaction.hash
}

async function submitPermissionlessOrPrint(
  target: Contract,
  method: string,
  args: unknown[]
): Promise<string | undefined> {
  const data = target.interface.encodeFunctionData(method, args)
  console.log(`target: ${target.address}`)
  console.log(`data:   ${data}`)
  console.log("sender: any relayer (payload signatures authorize this action)")
  if (process.env.ECDSA_CUTOVER_EXECUTE !== "true") {
    console.log(
      "calldata only; set ECDSA_CUTOVER_EXECUTE=true and ECDSA_CUTOVER_RELAYER to submit"
    )
    return undefined
  }
  const relayerInput = process.env.ECDSA_CUTOVER_RELAYER
  if (!relayerInput) {
    throw new Error(
      "ECDSA_CUTOVER_RELAYER is required for permissionless execution"
    )
  }
  const relayer = ethers.utils.getAddress(relayerInput)
  const signer = await configuredSigner(relayer)
  if (!signer) {
    throw new Error(`configured relayer ${relayer} is not an available signer`)
  }
  const transaction = await signer.sendTransaction({ to: target.address, data })
  const receipt = await transaction.wait(1)
  if (receipt.status !== 1) throw new Error(`${method} transaction failed`)
  console.log(`submitted ${method}: ${transaction.hash}`)
  return transaction.hash
}

async function requireLiveGovernance(
  bridge: Contract,
  expected: string
): Promise<void> {
  const live = await bridge.governance()
  if (!sameAddress(live, expected)) {
    throw new Error(
      `refusing wrapper call: Bridge.governance() is ${live}, expected ${expected}`
    )
  }
}

async function assertFinalizedWindow(
  inventory: InventoryBundle
): Promise<void> {
  const head = await ethers.provider.getBlockNumber()
  const age = head - inventory.finalizedBlock
  if (age < FINALITY_CONFIRMATIONS || age > MAX_BLOCKHASH_AGE) {
    throw new Error(
      `finalized block age ${age} is outside the required 64-255 block window; rebuild/restage a newer snapshot while the drain remains frozen`
    )
  }
  const block = await ethers.provider.getBlock(inventory.finalizedBlock)
  if (!block?.hash || !sameHash(block.hash, inventory.finalizedBlockHash)) {
    throw new Error(
      "inventory finalized block hash no longer matches the chain"
    )
  }
}

function inventoryFingerprint(inventory: InventoryBundle): string {
  return ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(JSON.stringify(inventory))
  )
}

function journalPathFor(role: "source" | "reconciler"): string {
  const name =
    role === "source"
      ? "ECDSA_CUTOVER_SOURCE_JOURNAL"
      : "ECDSA_CUTOVER_RECONCILER_JOURNAL"
  const file = process.env[name]
  if (!file) throw new Error(`${name} is required`)
  return file
}

function loadHistoryJournal(
  manifest: HandoffManifest,
  role: "source" | "reconciler"
): {
  journal: CanonicalHistoryJournalFile
  fileContentHash: string
} {
  const file = journalPathFor(role)
  if (!fs.existsSync(file))
    throw new Error(`${role} history journal is missing`)
  const expectedId =
    role === "source" ? manifest.sourceId : manifest.reconcilerSourceId
  const expectedStorageIdentity = normalizeDurableStoreIdentity(
    role === "source"
      ? manifest.sourceContext.durableStoreIdentity
      : manifest.reconcilerContext.durableStoreIdentity
  )
  const fileContentHash = readPrivateFileWithHash(file).contentHash
  return {
    journal: loadCanonicalHistoryJournal(
      file,
      expectedId,
      expectedStorageIdentity
    ),
    fileContentHash,
  }
}

async function extendJournalTo(
  manifest: HandoffManifest,
  role: "source" | "reconciler",
  finalizedBlock: number
): Promise<CanonicalHistoryScan> {
  const loaded = loadHistoryJournal(manifest, role)
  const { journal } = loaded
  const firstBlock = journal.scan.evidence.finalizedBlock + 1
  const tailLength = Math.max(0, finalizedBlock - firstBlock + 1)
  const maximumTail = Number(
    process.env.ECDSA_CUTOVER_MAX_JOURNAL_TAIL_BLOCKS ?? "64"
  )
  if (
    !Number.isSafeInteger(maximumTail) ||
    maximumTail < 1 ||
    maximumTail > 64 ||
    tailLength > maximumTail
  ) {
    throw new Error(
      `${role} canonical journal is stale by ${tailLength} blocks; update it before the cutover action`
    )
  }
  const scan = await extendCanonicalHistoryJournal(
    ethers.provider,
    manifest.historyEmitters,
    manifest.scanStartBlock,
    finalizedBlock,
    journal.scan
  )
  saveCanonicalHistoryJournal(
    journalPathFor(role),
    nextCanonicalHistoryJournal(
      journal.sourceId,
      journal.storageIdentity,
      scan,
      journal
    ),
    { expectedCurrentContentHash: loaded.fileContentHash }
  )
  return scan
}

async function independentlyRebuildInventory(
  manifest: HandoffManifest,
  inventory: InventoryBundle
): Promise<void> {
  const canonical = await buildCanonicalInventory(
    ethers.provider,
    manifest,
    inventory.finalizedBlock,
    await extendJournalTo(manifest, "reconciler", inventory.finalizedBlock)
  )
  if (
    !sameHash(inventoryFingerprint(inventory), inventoryFingerprint(canonical))
  ) {
    throw new Error(
      "inventory file differs from a fresh canonical-chain rebuild"
    )
  }
}

async function verifySignedSourcePreflight(
  manifest: HandoffManifest
): Promise<void> {
  assertLegacyInventorySourcePreflight(manifest)
  const signed = manifest.legacyInventorySourcePreflight.history
  const { journal } = loadHistoryJournal(manifest, "source")
  if (
    !canonicalHistoryJournalContains(
      journal,
      signed.finalizedBlock,
      signed.finalizedBlockHash,
      manifest.sourceCheckpointCommitment
    )
  ) {
    throw new Error("source journal does not contain the signed preflight")
  }
}

function assertStateManifest(
  state: CutoverState,
  manifest: HandoffManifest
): void {
  const expectedOwnerAuthorizationHash = ownerAuthorizationHash(manifest)
  if (state.phase === 0) {
    if (
      !sameHash(state.ownerAuthorizationHash, ZERO_HASH) &&
      !sameHash(state.ownerAuthorizationHash, expectedOwnerAuthorizationHash)
    ) {
      throw new Error("on-chain owner authorization differs from the manifest")
    }
    return
  }
  const expectedCheckpointDigests = checkpointRoleDigests(manifest)
  const expectedSourceContextCommitment = authorityContextCommitment(
    "source",
    manifest.sourceSigner,
    manifest.sourceId,
    manifest.sourceContext
  )
  const expectedReconcilerContextCommitment = authorityContextCommitment(
    "reconciler",
    manifest.reconciler,
    manifest.reconcilerSourceId,
    manifest.reconcilerContext
  )
  if (
    !sameAddress(state.oldRouter, manifest.oldRouter) ||
    !sameAddress(state.newRouter, manifest.replacementRouter) ||
    !sameAddress(state.sourceSigner, manifest.sourceSigner) ||
    !sameHash(state.sourceId, manifest.sourceId) ||
    !sameAuthorityContext(state.sourceContext, manifest.sourceContext) ||
    !sameHash(state.sourceContextCommitment, expectedSourceContextCommitment) ||
    !sameHash(
      state.sourceCheckpointRoleDigest,
      expectedCheckpointDigests.source
    ) ||
    !sameHash(
      state.sourceCheckpointCommitment,
      manifest.sourceCheckpointCommitment
    ) ||
    !sameHash(
      state.sourcePreflightCommitment,
      legacyInventorySourcePreflightHash(
        manifest.legacyInventorySourcePreflight
      )
    ) ||
    !state.sourcePreflightBlock.eq(
      manifest.legacyInventorySourcePreflight.history.finalizedBlock
    ) ||
    state.evidenceGeneration !== manifest.evidenceGeneration ||
    !sameHash(
      state.evidenceAnchorArtifactHash,
      manifest.evidenceAnchorArtifactHash
    ) ||
    !sameHash(
      state.evidencePredecessorArtifactHash,
      manifest.evidencePredecessorArtifactHash
    ) ||
    state.drainBlock.lte(state.sourcePreflightBlock) ||
    state.drainBlock
      .sub(state.sourcePreflightBlock)
      .lt(FINALITY_CONFIRMATIONS) ||
    state.drainBlock
      .sub(state.sourcePreflightBlock)
      .gt(manifest.maxTailBlocks) ||
    state.maxTailBlocks !== manifest.maxTailBlocks ||
    !sameHash(state.ownerAuthorizationHash, expectedOwnerAuthorizationHash) ||
    !state.stageDeadlineBlock.eq(state.drainBlock.add(MAX_BLOCKHASH_AGE)) ||
    (state.phase < 4 &&
      (!sameAddress(state.reconciler, manifest.reconciler) ||
        !sameHash(state.reconcilerSourceId, manifest.reconcilerSourceId) ||
        !sameAuthorityContext(
          state.reconcilerContext,
          manifest.reconcilerContext
        ) ||
        !sameHash(
          state.reconcilerContextCommitment,
          expectedReconcilerContextCommitment
        ) ||
        !sameHash(
          state.reconcilerCheckpointRoleDigest,
          expectedCheckpointDigests.reconciler
        ))) ||
    sameAddress(state.reconciler, state.sourceSigner) ||
    sameHash(state.reconcilerSourceId, state.sourceId)
  ) {
    throw new Error("on-chain cutover state differs from the signed manifest")
  }
}

function assertStateInventory(
  state: CutoverState,
  inventory: InventoryBundle
): void {
  if (!stateMatchesInventory(state, inventory)) {
    throw new Error(
      "on-chain inventory commitment fields differ from inventory file"
    )
  }
}

function stateMatchesInventory(
  state: CutoverState,
  inventory: InventoryBundle
): boolean {
  return !(
    !state.finalizedBlock.eq(inventory.finalizedBlock) ||
    !sameHash(state.finalizedBlockHash, inventory.finalizedBlockHash)
  )
}

async function assertDrainReadback(
  bridge: Contract,
  manifest: HandoffManifest
): Promise<void> {
  const [current, drain, retired] = await Promise.all([
    bridge.ecdsaFraudRouter(),
    bridge.ecdsaFraudRouterInDrain(),
    bridge.isEcdsaFraudRouterRetired(manifest.oldRouter),
  ])
  if (
    !sameAddress(current, manifest.oldRouter) ||
    !sameAddress(drain, manifest.oldRouter) ||
    retired
  ) {
    throw new Error(
      `drain readback mismatch: current=${current}, drain=${drain}, retired=${retired}`
    )
  }
}

async function assertMigratedReadback(
  bridge: Contract,
  manifest: HandoffManifest,
  inventory: InventoryBundle
): Promise<void> {
  const replacement = await ethers.getContractAt(
    "EcdsaFraudRouter",
    manifest.replacementRouter
  )
  const [openCount, unattributedCount, escrow, balance] = await Promise.all([
    replacement.openFraudChallengeCount(),
    replacement.unattributedOpenFraudChallengeCount(),
    replacement.openFraudChallengeEscrow(),
    ethers.provider.getBalance(manifest.replacementRouter),
  ])
  if (
    !openCount.eq(inventory.challengeCount) ||
    !unattributedCount.eq(inventory.challengeCount) ||
    !escrow.eq(inventory.totalEscrow) ||
    balance.lt(escrow)
  ) {
    throw new Error("replacement count/escrow post-migration readback mismatch")
  }
  for (let i = 0; i < inventory.challengeKeys.length; i++) {
    const key = inventory.challengeKeys[i]
    const expected = inventory.challenges[i]
    // Serialize per-key archival reads to avoid bursting a production RPC
    // when the reconciled inventory is large.
    // eslint-disable-next-line no-await-in-loop
    const [legacyExists, migrated] = await Promise.all([
      bridge.legacyFraudChallengeExists(key),
      replacement.fraudChallenges(key),
    ])
    if (
      legacyExists ||
      !sameAddress(migrated.challenger, expected.challenger) ||
      !migrated.depositAmount.eq(expected.depositAmount) ||
      Number(migrated.reportedAt) !== expected.reportedAt ||
      migrated.resolved !== expected.resolved
    ) {
      throw new Error(`post-migration record mismatch for challenge ${key}`)
    }
  }
}

async function updateCanonicalGovernanceAlias(
  manifest: HandoffManifest,
  bridge: Contract
): Promise<void> {
  const live = await bridge.governance()
  if (!sameAddress(live, manifest.newGovernance)) {
    throw new Error(
      "canonical alias cannot move before Bridge.governance readback"
    )
  }
  const distinct = await deployments.get("BridgeGovernanceEcdsaFraudCutover")
  if (!sameAddress(distinct.address, manifest.newGovernance)) {
    throw new Error("distinct new-governance deployment record mismatch")
  }
  const historical = await deployments.getOrNull(
    "BridgeGovernanceBeforeEcdsaCutover"
  )
  if (!historical || !sameAddress(historical.address, manifest.oldGovernance)) {
    throw new Error("historical BridgeGovernance deployment record is missing")
  }
  const canonical = await deployments.get("BridgeGovernance")
  if (
    !sameAddress(canonical.address, manifest.oldGovernance) &&
    !sameAddress(canonical.address, manifest.newGovernance)
  ) {
    throw new Error(
      "canonical BridgeGovernance deployment record is unexpected"
    )
  }
  if (!sameAddress(canonical.address, manifest.newGovernance)) {
    await deployments.save("BridgeGovernance", distinct)
  }
}

async function updateCanonicalRouterAlias(
  manifest: HandoffManifest,
  bridge: Contract
): Promise<void> {
  const [live, drain, retired, approvedHash] = await Promise.all([
    bridge.ecdsaFraudRouter(),
    bridge.ecdsaFraudRouterInDrain(),
    bridge.isEcdsaFraudRouterRetired(manifest.oldRouter),
    bridge.ecdsaFraudRouterCodeHash(),
  ])
  if (
    !sameAddress(live, manifest.replacementRouter) ||
    !sameAddress(drain, ZERO_ADDRESS) ||
    !retired ||
    !sameHash(approvedHash, manifest.replacementRouterRuntimeCodeHash)
  ) {
    throw new Error(
      "canonical router alias cannot move before final Bridge readback"
    )
  }

  const distinct = await deployments.get(
    "EcdsaFraudRouterEcdsaCutoverReplacement"
  )
  if (!sameAddress(distinct.address, manifest.replacementRouter)) {
    throw new Error("distinct replacement-router deployment record mismatch")
  }
  const historical = await deployments.getOrNull(
    "EcdsaFraudRouterBeforeEcdsaCutover"
  )
  if (!historical || !sameAddress(historical.address, manifest.oldRouter)) {
    throw new Error("historical EcdsaFraudRouter record is missing")
  }
  const canonical = await deployments.get("EcdsaFraudRouter")
  if (
    !sameAddress(canonical.address, manifest.oldRouter) &&
    !sameAddress(canonical.address, manifest.replacementRouter)
  ) {
    throw new Error("canonical EcdsaFraudRouter deployment is unexpected")
  }
  if (!sameAddress(canonical.address, manifest.replacementRouter)) {
    await deployments.save("EcdsaFraudRouter", distinct)
  }
}

async function beginGovernanceHandoff(
  manifest: HandoffManifest,
  bridge: Contract
): Promise<void> {
  const live = await bridge.governance()
  if (sameAddress(live, manifest.newGovernance)) {
    console.log("governance handoff is already finalized on chain")
    return
  }
  await requireLiveGovernance(bridge, manifest.oldGovernance)
  const snapshot = await readLegacyGovernanceStorage(
    ethers.provider,
    manifest.oldGovernance
  )
  if (ethers.BigNumber.from(snapshot.bridgeTransferChangeInitiated).isZero()) {
    await assertLegacyGovernanceReadyForHandoff(ethers.provider, manifest)
    const oldGovernance = new ethers.Contract(
      manifest.oldGovernance,
      [
        "function beginBridgeGovernanceTransfer(address)",
        "function owner() view returns (address)",
      ],
      ethers.provider
    )
    const txHash = await submitOrPrint(
      oldGovernance,
      manifest.governanceOwner,
      "beginBridgeGovernanceTransfer",
      [manifest.newGovernance]
    )
    if (!txHash) return
    await assertLegacyGovernanceReadyForHandoff(
      ethers.provider,
      manifest,
      manifest.newGovernance
    )
    saveManifest(manifest, "governance-handoff-pending", "begin", txHash)
  } else {
    await assertLegacyGovernanceReadyForHandoff(
      ethers.provider,
      manifest,
      manifest.newGovernance
    )
    saveManifest(manifest, "governance-handoff-pending")
    console.log("matching governance handoff is already pending")
  }
}

async function finalizeGovernanceHandoff(
  manifest: HandoffManifest,
  bridge: Contract
): Promise<void> {
  const live = await bridge.governance()
  if (!sameAddress(live, manifest.newGovernance)) {
    await requireLiveGovernance(bridge, manifest.oldGovernance)
    await assertLegacyGovernanceReadyForHandoff(
      ethers.provider,
      manifest,
      manifest.newGovernance
    )
    const oldGovernance = new ethers.Contract(
      manifest.oldGovernance,
      ["function finalizeBridgeGovernanceTransfer()"],
      ethers.provider
    )
    const txHash = await submitOrPrint(
      oldGovernance,
      manifest.governanceOwner,
      "finalizeBridgeGovernanceTransfer",
      []
    )
    if (!txHash) return
    const observed = await bridge.governance()
    if (!sameAddress(observed, manifest.newGovernance)) {
      throw new Error(`governance handoff readback failed: ${observed}`)
    }
    saveManifest(manifest, "governance-handoff-finalized", "finalize", txHash)
  }
  await updateCanonicalGovernanceAlias(manifest, bridge)
  saveManifest(manifest, "governance-handoff-finalized")
  console.log(
    "Bridge.governance and canonical deployment alias now point to the new wrapper"
  )
}

async function buildInventory(
  manifest: HandoffManifest,
  governance: Contract
): Promise<void> {
  const state = await getState(governance)
  assertStateManifest(state, manifest)
  if (state.phase !== 1 && state.phase !== 2) {
    throw new Error(
      "inventory can be built/restaged only while drain is frozen"
    )
  }
  const head = await ethers.provider.getBlockNumber()
  const requested = process.env.ECDSA_CUTOVER_FINALIZED_BLOCK
  const drainBlock = state.drainBlock.toNumber()
  const finalizedBlock = requested ? Number(requested) : drainBlock
  if (!Number.isSafeInteger(finalizedBlock) || finalizedBlock < 0) {
    throw new Error("ECDSA_CUTOVER_FINALIZED_BLOCK is invalid")
  }
  if (finalizedBlock !== drainBlock) {
    throw new Error(
      `inventory finalized block must be the on-chain drain block ${drainBlock}`
    )
  }
  if (head > state.stageDeadlineBlock.toNumber()) {
    throw new Error("the on-chain inventory staging deadline has elapsed")
  }
  const inventory = await buildCanonicalInventory(
    ethers.provider,
    manifest,
    finalizedBlock,
    await extendJournalTo(manifest, "source", finalizedBlock)
  )
  await assertFinalizedWindow(inventory)
  const output =
    process.env.ECDSA_CUTOVER_INVENTORY_OUT ??
    path.join(
      path.dirname(manifestPath()),
      `ecdsa-fraud-router-inventory-${finalizedBlock}.json`
    )
  const existingInventory = fs.existsSync(output)
    ? loadCutoverInventory(output)
    : undefined
  if (
    existingInventory &&
    process.env.ECDSA_CUTOVER_OVERWRITE_INVENTORY !== "true"
  ) {
    throw new Error(
      `${output} exists; choose a new output or explicitly set ECDSA_CUTOVER_OVERWRITE_INVENTORY=true`
    )
  }
  writeCutoverInventory(
    output,
    inventory,
    existingInventory
      ? { expectedCurrentContentHash: existingInventory.fileContentHash }
      : { createOnly: true }
  )
  console.log(`wrote canonical inventory: ${output}`)
  console.log(`inventory fingerprint: ${inventoryFingerprint(inventory)}`)
}

async function refreshPreflight(
  manifest: HandoffManifest,
  governance: Contract
): Promise<void> {
  const state = await getState(governance)
  if (state.phase !== 0) {
    throw new Error("preflight can be refreshed only before drain begins")
  }
  const head = await ethers.provider.getBlockNumber()
  const confirmations = Number(
    process.env.ECDSA_CUTOVER_PREFLIGHT_CONFIRMATIONS ??
      FINALITY_CONFIRMATIONS.toString()
  )
  const maxTailBlocks = Number(
    process.env.ECDSA_CUTOVER_MAX_PREFLIGHT_AGE_BLOCKS ??
      MAX_BLOCKHASH_AGE.toString()
  )
  const minimumBeginSlackBlocks = Number(
    process.env.ECDSA_CUTOVER_MIN_BEGIN_SLACK_BLOCKS ?? "16"
  )
  const timing = cutoverPreflightTiming(
    head,
    confirmations,
    maxTailBlocks,
    minimumBeginSlackBlocks
  )
  const finalizedBlock = timing.preflightBlock
  const scan = await extendJournalTo(manifest, "source", finalizedBlock)
  const preflight = await buildLegacyInventorySourcePreflight(
    ethers.provider,
    manifest.bridge,
    manifest.scanStartBlock,
    finalizedBlock,
    manifest.historyEmitters,
    scan
  )
  if (!manifestFileContentHash) {
    throw new Error("cutover manifest CAS state is unavailable")
  }
  const predecessorArtifactHash = artifactContentHashBytes32(
    manifestFileContentHash
  )
  const refreshed: HandoffManifest = {
    ...manifest,
    legacyInventorySourcePreflight: preflight,
    sourceCheckpointCommitment: canonicalHistoryCheckpointCommitment(scan),
    maxTailBlocks,
    evidenceGeneration: manifest.evidenceGeneration + 1,
    evidenceAnchorArtifactHash:
      manifest.evidenceGeneration === 0
        ? predecessorArtifactHash
        : manifest.evidenceAnchorArtifactHash,
    evidencePredecessorArtifactHash: predecessorArtifactHash,
    phase: "preflight-refreshed-awaiting-dual-signatures",
  }
  assertCutoverAuthoritySeparation(refreshed)
  assertLegacyInventorySourcePreflight(refreshed)
  manifestFileContentHash = writeCutoverManifest(manifestPath(), refreshed, {
    expectedCurrentContentHash: manifestFileContentHash,
  })
  Object.assign(manifest, refreshed)
  console.log(`refreshed signed-plan candidate: ${handoffPlanHash(refreshed)}`)
}

async function main(): Promise<void> {
  const action = parseAction(process.env.ECDSA_CUTOVER_ACTION)
  const manifest = loadManifest()
  const sourceJournalPath = process.env.ECDSA_CUTOVER_SOURCE_JOURNAL
  const reconcilerJournalPath = process.env.ECDSA_CUTOVER_RECONCILER_JOURNAL
  if (sourceJournalPath && reconcilerJournalPath) {
    assertIndependentArtifactStores(sourceJournalPath, reconcilerJournalPath)
  } else if (action === "verify-preflight" || action === "stage-inventory") {
    throw new Error(
      "both canonical journal paths are required to verify independent stores"
    )
  }
  if (action === "print-plan-hash") {
    console.log(handoffPlanHash(manifest))
    return
  }
  if (action === "print-inventory-hash") {
    const digests = inventoryAuthorityAttestationHashes(
      manifest,
      loadInventory(manifest)
    )
    console.log(`source:     ${digests.source}`)
    console.log(`reconciler: ${digests.reconciler}`)
    return
  }
  let manifestSignatures: { source: string; reconciler: string } | undefined
  if (
    action === "begin-governance-handoff" ||
    action === "finalize-governance-handoff" ||
    action === "begin-drain"
  ) {
    manifestSignatures = await requireManifestSignatures(manifest)
  }

  const bridge = await ethers.getContractAt("Bridge", manifest.bridge)
  const governance = await ethers.getContractAt(
    "BridgeGovernance",
    manifest.newGovernance
  )
  await assertManifestStatic(manifest, bridge, governance)

  if (action === "verify-preflight") {
    const { finalizedBlock } = manifest.legacyInventorySourcePreflight.history
    const observed = await buildLegacyInventorySourcePreflight(
      ethers.provider,
      manifest.bridge,
      manifest.scanStartBlock,
      finalizedBlock,
      manifest.historyEmitters,
      await extendJournalTo(manifest, "reconciler", finalizedBlock)
    )
    assertLegacyInventorySourcePreflight(manifest, observed)
    console.log("independent preflight rebuild matches the signed manifest")
    return
  }

  if (action === "begin-governance-handoff") {
    await beginGovernanceHandoff(manifest, bridge)
    return
  }
  if (action === "finalize-governance-handoff") {
    await finalizeGovernanceHandoff(manifest, bridge)
    return
  }

  const liveGovernance = await bridge.governance()
  const currentRouter = await bridge.ecdsaFraudRouter()
  const state = await getState(governance)
  assertStateManifest(state, manifest)
  console.log(`network:              ${network.name}`)
  console.log(`Bridge:               ${manifest.bridge}`)
  console.log(`live governance:      ${liveGovernance}`)
  console.log(
    `signed old/new gov:   ${manifest.oldGovernance} -> ${manifest.newGovernance}`
  )
  console.log(`current router:       ${currentRouter}`)
  console.log(`cutover phase:        ${state.phase}`)
  console.log(`current reconciler:   ${state.reconciler}`)
  console.log(`pending reconciler:   ${state.pendingReconciler}`)
  console.log(`signed plan hash:     ${handoffPlanHash(manifest)}`)

  if (action === "inspect") return
  await requireLiveGovernance(bridge, manifest.newGovernance)

  if (action === "refresh-preflight") {
    await refreshPreflight(manifest, governance)
    return
  }

  if (action === "build-inventory") {
    await buildInventory(manifest, governance)
    return
  }

  const owner = await governance.owner()
  if (!sameAddress(owner, manifest.governanceOwner)) {
    throw new Error(`new BridgeGovernance owner changed to ${owner}`)
  }

  if (action === "authorize-drain") {
    if (state.phase !== 0) {
      throw new Error("drain authorization is available only in idle phase")
    }
    const expectedAuthorizationHash = ownerAuthorizationHash(manifest)
    if (sameHash(state.ownerAuthorizationHash, ZERO_HASH)) {
      const contextType =
        "tuple(bytes32 durableStoreIdentity,bytes32 endpointIdentity,bytes32 trustDomain,bytes32 policyHash)"
      const txHash = await submitOrPrint(
        governance,
        owner,
        "processEcdsaFraudCutoverOwnerAction",
        [
          0,
          ethers.utils.defaultAbiCoder.encode(
            [
              `tuple(address oldRouter,bytes32 oldRouterCodeHash,address newRouter,bytes32 newRouterCodeHash,uint64 scanStartBlock,address sourceSigner,bytes32 sourceId,${contextType} sourceContext,address reconciler,bytes32 reconcilerSourceId,${contextType} reconcilerContext,bytes32 emitterSetCommitment)`,
            ],
            [
              {
                oldRouter: manifest.oldRouter,
                oldRouterCodeHash: manifest.oldRouterRuntimeCodeHash,
                newRouter: manifest.replacementRouter,
                newRouterCodeHash: manifest.replacementRouterRuntimeCodeHash,
                scanStartBlock: manifest.scanStartBlock,
                sourceSigner: manifest.sourceSigner,
                sourceId: manifest.sourceId,
                sourceContext: manifest.sourceContext,
                reconciler: manifest.reconciler,
                reconcilerSourceId: manifest.reconcilerSourceId,
                reconcilerContext: manifest.reconcilerContext,
                emitterSetCommitment: canonicalEmitterSetCommitment(
                  manifest.historyEmitters
                ),
              },
            ]
          ),
        ]
      )
      if (!txHash) return
      const observed = await getState(governance)
      if (
        observed.phase !== 0 ||
        !sameHash(observed.ownerAuthorizationHash, expectedAuthorizationHash)
      ) {
        throw new Error("owner drain authorization readback failed")
      }
      saveManifest(
        manifest,
        "drain-owner-authorized",
        "authorize-drain",
        txHash
      )
    } else if (
      !sameHash(state.ownerAuthorizationHash, expectedAuthorizationHash)
    ) {
      throw new Error("another owner drain authorization is already bound")
    } else {
      console.log("matching owner drain authorization is already bound")
    }
    return
  }

  if (action === "begin-drain") {
    if (state.phase === 0) {
      const expectedAuthorizationHash = ownerAuthorizationHash(manifest)
      if (!sameHash(state.ownerAuthorizationHash, expectedAuthorizationHash)) {
        throw new Error(
          "the owner must bind this exact authority manifest with authorize-drain before permissionless begin"
        )
      }
      // This is the last off-chain proof before an intentionally irreversible
      // freeze. Rebuild every signed historical source identity now; forwarded
      // submissions require an unambiguous successful Bridge call trace.
      await verifySignedSourcePreflight(manifest)
      const currentBlock = await ethers.provider.getBlockNumber()
      const sourcePreflightFinalizedBlock =
        manifest.legacyInventorySourcePreflight.history.finalizedBlock
      const anticipatedBeginBlock = currentBlock + 1
      const anticipatedPreflightAge =
        anticipatedBeginBlock - sourcePreflightFinalizedBlock
      if (
        anticipatedPreflightAge < FINALITY_CONFIRMATIONS ||
        anticipatedPreflightAge > manifest.maxTailBlocks
      ) {
        throw new Error(
          `anticipated begin block ${anticipatedBeginBlock} gives preflight age ` +
            `${anticipatedPreflightAge}; the signed 64-${manifest.maxTailBlocks} block window is closed`
        )
      }
      const preDrainFinalizedBlock = currentBlock - FINALITY_CONFIRMATIONS
      if (preDrainFinalizedBlock < manifest.bridgeDeploymentBlock) {
        throw new Error(
          "Bridge must be at least 64 confirmations deep before drain"
        )
      }
      const preDrainInventory = await buildCanonicalInventory(
        ethers.provider,
        manifest,
        preDrainFinalizedBlock,
        await extendJournalTo(manifest, "source", preDrainFinalizedBlock)
      )
      assertActivationInventoryEmpty(preDrainInventory)
      const signatures =
        manifestSignatures ?? (await requireManifestSignatures(manifest))
      const txHash = await submitPermissionlessOrPrint(
        governance,
        "processEcdsaFraudCutoverAuthorityAction",
        [
          3,
          ethers.utils.defaultAbiCoder.encode(
            [
              "tuple(address oldRouter,bytes32 oldRouterCodeHash,address newRouter,bytes32 newRouterCodeHash,uint64 scanStartBlock,bytes authorityProof)",
            ],
            [
              {
                oldRouter: manifest.oldRouter,
                oldRouterCodeHash: manifest.oldRouterRuntimeCodeHash,
                newRouter: manifest.replacementRouter,
                newRouterCodeHash: manifest.replacementRouterRuntimeCodeHash,
                scanStartBlock: manifest.scanStartBlock,
                authorityProof: encodeAuthorityProof(
                  manifest,
                  signatures.source,
                  signatures.reconciler
                ),
              },
            ]
          ),
        ]
      )
      if (!txHash) return
      const observed = await getState(governance)
      assertStateManifest(observed, manifest)
      if (observed.phase !== 1) throw new Error("drain phase readback failed")
      await assertDrainReadback(bridge, manifest)
      saveManifest(manifest, "draining", "begin-drain", txHash)
    } else {
      await assertDrainReadback(bridge, manifest)
      console.log("matching drain is already active")
    }
    return
  }

  const inventory = loadInventory(manifest)

  if (action === "stage-inventory") {
    assertActivationInventoryEmpty(inventory)
    const sourcePreflightFinalizedBlock =
      manifest.legacyInventorySourcePreflight.history.finalizedBlock
    if (
      inventory.finalizedBlock !== state.drainBlock.toNumber() ||
      inventory.finalizedBlock < sourcePreflightFinalizedBlock ||
      inventory.finalizedBlock - sourcePreflightFinalizedBlock >
        manifest.maxTailBlocks ||
      (await ethers.provider.getBlockNumber()) >
        state.stageDeadlineBlock.toNumber()
    ) {
      throw new Error(
        "inventory must pin the drain block inside the signed tail and on-chain staging deadline"
      )
    }
    await assertFinalizedWindow(inventory)
    await independentlyRebuildInventory(manifest, inventory)
    const sourceAttestation =
      process.env.ECDSA_CUTOVER_INVENTORY_SOURCE_SIGNATURE
    const reconcilerAttestation =
      process.env.ECDSA_CUTOVER_INVENTORY_RECONCILER_SIGNATURE
    if (!sourceAttestation || !reconcilerAttestation) {
      throw new Error(
        "both inventory source and reconciler signatures are required"
      )
    }
    const inventoryDigests = inventoryAuthorityAttestationHashes(
      manifest,
      inventory
    )
    await Promise.all([
      assertAuthoritySignature(
        ethers.provider,
        manifest.sourceSigner,
        inventoryDigests.source,
        sourceAttestation,
        "inventory source"
      ),
      assertAuthoritySignature(
        ethers.provider,
        manifest.reconciler,
        inventoryDigests.reconciler,
        reconcilerAttestation,
        "inventory reconciler"
      ),
    ])
    if (
      state.phase === 1 ||
      state.phase === 2 ||
      (state.phase === 3 && !stateMatchesInventory(state, inventory))
    ) {
      const txHash = await submitPermissionlessOrPrint(
        governance,
        "processEcdsaFraudCutoverAuthorityAction",
        [
          4,
          ethers.utils.defaultAbiCoder.encode(
            ["bytes", "bytes", "bytes"],
            [
              encodeInventorySnapshot(inventory),
              sourceAttestation,
              reconcilerAttestation,
            ]
          ),
        ]
      )
      if (!txHash) return
      const observed = await getState(governance)
      if (observed.phase !== 2)
        throw new Error("inventory stage readback failed")
      assertStateInventory(observed, inventory)
      await assertDrainReadback(bridge, manifest)
      saveManifest(manifest, "inventory-staged", "stage-inventory", txHash)
    } else {
      assertStateInventory(state, inventory)
      console.log("matching inventory is already confirmed or migrated")
    }
    return
  }

  if (action === "confirm-inventory") {
    assertActivationInventoryEmpty(inventory)
    assertStateInventory(state, inventory)
    if (state.phase === 2) {
      await independentlyRebuildInventory(manifest, inventory)
      const txHash = await submitOrPrint(
        governance,
        manifest.reconciler,
        "processEcdsaFraudCutoverAuthorityAction",
        [
          0,
          ethers.utils.defaultAbiCoder.encode(
            ["bytes32"],
            [state.inventoryCommitment]
          ),
        ]
      )
      if (!txHash) return
      const observed = await getState(governance)
      if (observed.phase !== 3) throw new Error("inventory confirmation failed")
      await assertDrainReadback(bridge, manifest)
      saveManifest(manifest, "inventory-confirmed", "confirm-inventory", txHash)
    } else if (state.phase >= 3) {
      console.log("matching inventory is already independently confirmed")
    } else {
      throw new Error("inventory must be staged before confirmation")
    }
    return
  }

  if (action === "migrate") {
    assertActivationInventoryEmpty(inventory)
    assertStateInventory(state, inventory)
    if (state.phase === 3) {
      const txHash = await submitOrPrint(
        governance,
        owner,
        "processEcdsaFraudCutoverOwnerAction",
        [
          2,
          ethers.utils.defaultAbiCoder.encode(
            ["uint256[]"],
            [inventory.challengeKeys]
          ),
        ]
      )
      if (!txHash) return
      const observed = await getState(governance)
      if (observed.phase !== 4)
        throw new Error("migration phase readback failed")
      await assertDrainReadback(bridge, manifest)
      await assertMigratedReadback(bridge, manifest, inventory)
      saveManifest(manifest, "migrated-drain-still-frozen", "migrate", txHash)
    } else if (state.phase >= 4) {
      await assertDrainReadback(bridge, manifest)
      await assertMigratedReadback(bridge, manifest, inventory)
      console.log(
        "matching inventory is already migrated; drain remains frozen"
      )
    } else {
      throw new Error(
        "inventory must be independently confirmed before migration"
      )
    }
    return
  }

  if (
    action === "begin-reconciler-update" ||
    action === "print-reconciler-enrollment-hash" ||
    action === "print-reconciler-recovery-hash"
  ) {
    assertActivationInventoryEmpty(inventory)
    assertStateInventory(state, inventory)
    if (state.phase !== 4) {
      throw new Error("reconciler recovery can begin only in migrated phase")
    }
    await assertDrainReadback(bridge, manifest)
    await assertMigratedReadback(bridge, manifest, inventory)
    const requested = process.env.ECDSA_CUTOVER_RECOVERY_RECONCILER
    if (!requested) {
      throw new Error("ECDSA_CUTOVER_RECOVERY_RECONCILER is required")
    }
    const recoveryReconciler = ethers.utils.getAddress(requested)
    if (
      sameAddress(recoveryReconciler, state.reconciler) ||
      sameAddress(recoveryReconciler, owner) ||
      sameAddress(recoveryReconciler, governance.address)
    ) {
      throw new Error(
        "recovery reconciler must be distinct from governance and the current reconciler"
      )
    }
    const recoverySourceId = requiredBytes32(
      "ECDSA_CUTOVER_RECOVERY_RECONCILER_SOURCE_ID"
    )
    if (
      recoverySourceId === ZERO_HASH ||
      sameHash(recoverySourceId, state.sourceId) ||
      sameHash(recoverySourceId, state.reconcilerSourceId)
    ) {
      throw new Error("recovery reconciler source identity is not independent")
    }
    const recoveryContext = recoveryReconcilerContext()
    if (
      !independentAuthorityContexts(recoveryContext, manifest.sourceContext) ||
      !independentAuthorityContexts(recoveryContext, state.reconcilerContext)
    ) {
      throw new Error(
        "recovery reconciler context must be independent from both active authorities"
      )
    }
    const recoveryJournalPath =
      process.env.ECDSA_CUTOVER_RECOVERY_RECONCILER_JOURNAL
    if (!recoveryJournalPath) {
      throw new Error("ECDSA_CUTOVER_RECOVERY_RECONCILER_JOURNAL is required")
    }
    assertIndependentArtifactStores(
      journalPathFor("source"),
      recoveryJournalPath
    )
    assertIndependentArtifactStores(
      journalPathFor("reconciler"),
      recoveryJournalPath
    )
    const recoveryJournal = loadCanonicalHistoryJournal(
      recoveryJournalPath,
      recoverySourceId,
      recoveryContext.durableStoreIdentity
    )
    const recoveryCheckpoints = [
      ...recoveryJournal.lineage,
      {
        finalizedBlock: recoveryJournal.scan.evidence.finalizedBlock,
        finalizedBlockHash: recoveryJournal.scan.evidence.finalizedBlockHash,
        checkpointCommitment: recoveryJournal.scanContentHash,
      },
    ]
    if (
      !recoveryCheckpoints.some(
        (checkpoint) =>
          checkpoint.finalizedBlock === inventory.finalizedBlock &&
          sameHash(checkpoint.finalizedBlockHash, inventory.finalizedBlockHash)
      )
    ) {
      throw new Error(
        "recovery reconciler journal does not contain the staged drain-block checkpoint"
      )
    }
    const enrollmentDigest = reconcilerEnrollmentAttestationHash(
      manifest,
      state.inventoryCommitment,
      state.reconciler,
      state.reconcilerSourceId,
      state.reconcilerContext,
      recoveryReconciler,
      recoverySourceId,
      recoveryContext
    )
    if (action === "print-reconciler-enrollment-hash") {
      console.log(enrollmentDigest)
      return
    }
    const enrollmentAttestation =
      process.env.ECDSA_CUTOVER_RECOVERY_ENROLLMENT_SIGNATURE
    if (!enrollmentAttestation) {
      throw new Error(
        "ECDSA_CUTOVER_RECOVERY_ENROLLMENT_SIGNATURE is required from the proposed reconciler"
      )
    }
    await assertAuthoritySignature(
      ethers.provider,
      recoveryReconciler,
      enrollmentDigest,
      enrollmentAttestation,
      "recovery reconciler enrollment"
    )
    const recoveryDigest = reconcilerRecoveryAttestationHash(
      manifest,
      state.inventoryCommitment,
      state.reconciler,
      state.reconcilerSourceId,
      state.reconcilerContext,
      enrollmentDigest,
      enrollmentAttestation
    )
    if (action === "print-reconciler-recovery-hash") {
      console.log(recoveryDigest)
      return
    }
    const sourceRecoveryAttestation =
      process.env.ECDSA_CUTOVER_SOURCE_RECOVERY_SIGNATURE
    if (!sourceRecoveryAttestation) {
      throw new Error(
        "ECDSA_CUTOVER_SOURCE_RECOVERY_SIGNATURE is required from the pinned source authority"
      )
    }
    await assertAuthoritySignature(
      ethers.provider,
      state.sourceSigner,
      recoveryDigest,
      sourceRecoveryAttestation,
      "source-authorized reconciler recovery"
    )
    const txHash = await submitOrPrint(
      governance,
      owner,
      "processEcdsaFraudCutoverOwnerAction",
      [
        3,
        ethers.utils.defaultAbiCoder.encode(
          [
            "address",
            "bytes32",
            "tuple(bytes32 durableStoreIdentity,bytes32 endpointIdentity,bytes32 trustDomain,bytes32 policyHash)",
            "bytes",
            "bytes",
          ],
          [
            recoveryReconciler,
            recoverySourceId,
            recoveryContext,
            enrollmentAttestation,
            sourceRecoveryAttestation,
          ]
        ),
      ]
    )
    if (!txHash) return
    const observed = await getState(governance)
    if (
      observed.phase !== 4 ||
      !sameAddress(observed.pendingReconciler, recoveryReconciler) ||
      !sameHash(observed.pendingReconcilerSourceId, recoverySourceId) ||
      !sameAuthorityContext(observed.pendingReconcilerContext, recoveryContext)
    ) {
      throw new Error("reconciler recovery proposal readback failed")
    }
    saveManifest(
      manifest,
      "reconciler-update-delay-running",
      "begin-reconciler-update",
      txHash
    )
    return
  }

  if (action === "finalize-reconciler-update") {
    assertActivationInventoryEmpty(inventory)
    assertStateInventory(state, inventory)
    if (
      state.phase !== 4 ||
      sameAddress(state.pendingReconciler, ZERO_ADDRESS)
    ) {
      throw new Error("no phase-four reconciler recovery is pending")
    }
    await assertDrainReadback(bridge, manifest)
    await assertMigratedReadback(bridge, manifest, inventory)
    const txHash = await submitOrPrint(
      governance,
      state.pendingReconciler,
      "processEcdsaFraudCutoverAuthorityAction",
      [2, "0x"]
    )
    if (!txHash) return
    const observed = await getState(governance)
    if (
      observed.phase !== 4 ||
      !sameAddress(observed.reconciler, state.pendingReconciler) ||
      !sameAddress(observed.pendingReconciler, ZERO_ADDRESS)
    ) {
      throw new Error("reconciler recovery final readback failed")
    }
    saveManifest(
      manifest,
      "migrated-reconciler-recovered",
      "finalize-reconciler-update",
      txHash
    )
    return
  }

  if (action === "confirm-migration") {
    assertActivationInventoryEmpty(inventory)
    assertStateInventory(state, inventory)
    if (state.phase === 4) {
      await assertDrainReadback(bridge, manifest)
      await assertMigratedReadback(bridge, manifest, inventory)
      const txHash = await submitOrPrint(
        governance,
        state.reconciler,
        "processEcdsaFraudCutoverAuthorityAction",
        [
          1,
          ethers.utils.defaultAbiCoder.encode(
            ["uint256[]"],
            [inventory.challengeKeys]
          ),
        ]
      )
      if (!txHash) return
      const observed = await getState(governance)
      if (
        observed.phase !== 5 ||
        sameHash(observed.postMigrationCommitment, ZERO_HASH)
      ) {
        throw new Error("independent migration confirmation readback failed")
      }
      saveManifest(
        manifest,
        "migration-confirmed-delay-running",
        "confirm-migration",
        txHash
      )
    } else if (state.phase === 5) {
      await assertMigratedReadback(bridge, manifest, inventory)
      console.log("migration is already independently confirmed")
    } else {
      throw new Error("inventory must be migrated before confirmation")
    }
    return
  }

  if (action === "finalize") {
    assertActivationInventoryEmpty(inventory)
    if (sameAddress(currentRouter, manifest.replacementRouter)) {
      if (state.phase !== 0) {
        throw new Error("active replacement has uncleared cutover state")
      }
      const [drain, retired, approvedHash] = await Promise.all([
        bridge.ecdsaFraudRouterInDrain(),
        bridge.isEcdsaFraudRouterRetired(manifest.oldRouter),
        bridge.ecdsaFraudRouterCodeHash(),
      ])
      if (
        !sameAddress(drain, ZERO_ADDRESS) ||
        !retired ||
        !sameHash(approvedHash, manifest.replacementRouterRuntimeCodeHash)
      ) {
        throw new Error("finalized Bridge router readback mismatch")
      }
      await updateCanonicalRouterAlias(manifest, bridge)
      saveManifest(manifest, "finalized")
      console.log("cutover is already finalized")
      return
    }
    if (state.phase !== 5) {
      throw new Error("migration confirmation and full delay are required")
    }
    assertStateInventory(state, inventory)
    await assertDrainReadback(bridge, manifest)
    await assertMigratedReadback(bridge, manifest, inventory)
    const txHash = await submitOrPrint(
      governance,
      owner,
      "processEcdsaFraudCutoverOwnerAction",
      [
        4,
        ethers.utils.defaultAbiCoder.encode(
          ["uint256[]"],
          [inventory.challengeKeys]
        ),
      ]
    )
    if (!txHash) return
    const [
      observedState,
      observedRouter,
      drain,
      retired,
      approvedHash,
      activationEpoch,
    ] = await Promise.all([
      getState(governance),
      bridge.ecdsaFraudRouter(),
      bridge.ecdsaFraudRouterInDrain(),
      bridge.isEcdsaFraudRouterRetired(manifest.oldRouter),
      bridge.ecdsaFraudRouterCodeHash(),
      (
        await ethers.getContractAt(
          "EcdsaFraudRouter",
          manifest.replacementRouter
        )
      ).migratedChallengesActivatedAt(),
    ])
    if (
      observedState.phase !== 0 ||
      !sameAddress(observedRouter, manifest.replacementRouter) ||
      !sameAddress(drain, ZERO_ADDRESS) ||
      !retired ||
      activationEpoch.isZero() ||
      !sameHash(approvedHash, manifest.replacementRouterRuntimeCodeHash)
    ) {
      throw new Error("final cutover readback failed")
    }
    await updateCanonicalRouterAlias(manifest, bridge)
    saveManifest(manifest, "finalized", "finalize-cutover", txHash)
    console.log(
      "ECDSA router cutover finalized; drain cleared only after delayed readback"
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
