/* eslint-disable no-await-in-loop */
/* eslint-disable no-continue */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-nested-ternary */
// Merkle index arithmetic and a deliberate unused-expression marker.
/* eslint-disable no-bitwise */
/* eslint-disable no-void */
/* eslint-disable @typescript-eslint/naming-convention */
import fs from "fs"
import path from "path"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction, Deployment } from "hardhat-deploy/types"
import { BigNumber, constants, providers, utils } from "ethers"
import {
  RebuildCertificate,
  rebuildCertificateDigest,
  reconcileDerivedCoverageStorage,
  verifyAndDeriveEthereumArchive,
  verifyBitcoinJournal,
  verifyIndependentSignature,
} from "../scripts/complete-p2tr-coverage"
import {
  DurableWriteFailpoint,
  acquireDurableArtifactSessionLock,
  durableArtifactSessionLockPath,
  durableArtifactWriteLockPath,
  durableWriteHashedJson,
  readHashedJsonWithHash,
  readPrivateFileWithHash,
} from "../scripts/durable-artifact"
import {
  ARCHIVE_MANIFEST_SCHEMA_HASH,
  ARCHIVE_RECONCILER_ATTESTATION_ROLE,
  ARCHIVE_SOURCE_ATTESTATION_ROLE,
  ArchiveManifestV2,
  ArchivePhaseArtifact,
  buildArchiveManifestAttestation,
  buildArchiveMerkleTree,
  hashArchiveCheckpoint,
  hashArchiveManifestAttestation,
  hashArchiveManifestV2,
  readArchivePhase,
} from "./54_upgrade_frost_wallet_registry_archive"
import { loadCutoverManifest } from "../scripts/ecdsa-fraud-router-cutover-artifacts"
import {
  HandoffManifest,
  artifactContentHashBytes32,
  assertCutoverAuthoritySeparation,
  discoverHistoryEmitters,
  handoffPlanHash,
  ownerAuthorizationHash,
} from "../scripts/ecdsa-fraud-router-cutover-lib"

export const COMPLETE_V2_PROTOCOL_ID = utils.id(
  "tbtc/p2tr-signature-fraud/evidence/complete-v2"
)
export const RESERVATION_PROTOCOL_ID = utils.id(
  "tbtc/p2tr-pre-signing-reservation/threshold-v1"
)
export const SIGNING_POLICY_HASH = utils.id(
  "tbtc/p2tr-pre-signing-policy/default-no-annex-51-seats-v1"
)
export const EIP_1967_ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
export const EIP_1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
export const EIP_170_RUNTIME_LIMIT = 24_576
export const COVERAGE_LEAF_DOMAIN = "tbtc-p2tr-output-key-coverage-leaf-v1"
export const ACTIVATION_ARTIFACT_SCHEMA = "tbtc/complete-p2tr-activation/v4"
export const ACTIVATION_ARTIFACT_KIND =
  "tbtc/complete-p2tr-activation/private-artifact/v3"
export const LEGACY_ACTIVATION_ARTIFACT_SCHEMA =
  "tbtc/complete-p2tr-activation/v2"
export const PREVIOUS_ACTIVATION_ARTIFACT_SCHEMA =
  "tbtc/complete-p2tr-activation/v3"
export const COVERAGE_MANIFEST_SCHEMA = "tbtc/taproot-output-key-coverage/v2"
export const MAXIMUM_COVERAGE_BATCH_SIZE = 32
export const EIP_170_REQUIRED_HEADROOM = 512
export const DEFAULT_MAXIMUM_ACTIVATION_TAIL_BLOCKS = 8192
export const BRIDGE_GOVERNANCE_DELAY_SLOT = 70
export const BRIDGE_GOVERNANCE_TRANSFER_INITIATED_SLOT = 73
export const BRIDGE_GOVERNANCE_PENDING_TARGET_SLOT = 74
export const BRIDGE_FROST_REGISTRY_STORAGE_SLOT = 51 + 32
export const BRIDGE_ECDSA_ROUTER_STORAGE_SLOT = 51 + 33
export const BRIDGE_P2TR_ROUTER_STORAGE_SLOT = 51 + 34
export const BRIDGE_LIFECYCLE_ROUTER_STORAGE_SLOT = 51 + 35
export const FROST_ARCHIVE_STATE_COMPLETED = 3
export const FROST_ARCHIVE_STATE_FRESH = 4
export const FROST_FRESH_ARCHIVE_SCHEMA_HASH = utils.id(
  "tbtc/frost-wallet-archive/fresh-v2"
)
export const COVERAGE_AUTHORIZATION_DOMAIN =
  "tbtc-p2tr-output-key-coverage-authorization-v1"
export const DUAL_SOURCE_CHECKPOINT_DOMAIN =
  "tbtc-complete-p2tr-dual-source-checkpoint-v1"
export const LINKED_LIBRARIES_DOMAIN = "tbtc-complete-p2tr-linked-libraries-v1"
export const ECDSA_CUTOVER_PROTOCOL_ID = utils.id(
  "tbtc/ecdsa-signature-fraud/router/current-v3"
)
export const COVERAGE_AUTHORIZATION_TUPLE =
  "tuple(bytes32 inventoryRoot,uint64 inventoryCount,uint64 historyStartBlock,uint64 snapshotBlock,bytes32 snapshotBlockHash,bytes32 sourceIdentity1,address sourceSigner1,bytes32 sourceCheckpointDigest1,bytes32 sourceIdentity2,address sourceSigner2,bytes32 sourceCheckpointDigest2,bytes32 sourceCheckpointCommitment,bytes32 linkedLibrariesCommitment,address implementation,bytes32 implementationCodeHash,address authorizationRegistry,bytes32 authorizationRegistryCodeHash,address fraudRouter,bytes32 fraudRouterCodeHash)"

const proxyAdminInterface = new utils.Interface([
  "function owner() view returns (address)",
  "function upgrade(address proxy,address implementation)",
])
const timelockInterface = new utils.Interface([
  "function getMinDelay() view returns (uint256)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function execute(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt)",
])
const bridgeInterface = new utils.Interface([
  "function governance() view returns (address)",
  "function ecdsaFraudRouter() view returns (address)",
  "function ecdsaFraudRouterCodeHash() view returns (bytes32)",
  "function ecdsaFraudRouterInDrain() view returns (address)",
  "function isEcdsaFraudRouterRetired(address) view returns (bool)",
  "function frostLifecycleContext(bytes20) view returns (address,bytes32)",
  "function p2trFraudRouter() view returns (address)",
  "function processTaprootOutputKeyCoverage(bytes payload) returns (bytes)",
  "function deposits(uint256 depositKey) view returns (address depositor,uint64 amount,uint32 revealedAt,address vault,uint64 treasuryFee,uint32 sweptAt,bytes32 extraData)",
  "function setFrostWalletRegistry(address registry)",
  "function setLifecycleRouter(address router)",
  "function setEcdsaFraudRouter(address router,bytes32 expectedCodeHash)",
])
const bridgeGovernanceInterface = new utils.Interface([
  "function owner() view returns (address)",
  "function bridgeAddress() view returns (address)",
  "function governanceDelays(uint256) view returns (uint256)",
  "function setFrostWalletRegistry(address registry)",
  "function setLifecycleRouter(address router)",
  "function processTaprootOutputKeyCoverage(bytes payload)",
  "function setEcdsaFraudRouter(address router,bytes32 expectedCodeHash)",
  "function processEcdsaFraudCutoverAuthorityAction(uint8 action,bytes payload)",
  "event EcdsaFraudCutoverAuthorizationBound(bytes32 indexed manifestPlanHash,bytes32 indexed sourceCheckpointCommitment,uint8 maxTailBlocks,uint64 stageDeadlineBlock)",
])
const routerInterface = new utils.Interface([
  "function bridge() view returns (address)",
  "function authorizationRegistry() view returns (address)",
  "function domainChainID() view returns (uint256)",
  "function evidenceProtocolID() view returns (bytes32)",
  "function preauthorizationProtocolID() view returns (bytes32)",
  "function signingPolicyHash() view returns (bytes32)",
  "function openFraudChallengeCount() view returns (uint256)",
  "function totalChallengeEscrow() view returns (uint256)",
  "function totalWithdrawablePayouts() view returns (uint256)",
])
const registryInterface = new utils.Interface([
  "function bridge() view returns (address)",
  "function frostRegistry() view returns (address)",
  "function proposalValidator() view returns (address)",
  "function domainChainID() view returns (uint256)",
  "function reservationProtocolID() view returns (bytes32)",
  "function signingPolicyHash() view returns (bytes32)",
  "function groupThreshold() view returns (uint256)",
  "function maximumGroupSize() view returns (uint256)",
  "function activeReservationCount() view returns (uint256)",
  "function activeReservationSetVersion() view returns (uint256)",
  "function authorizedChallengeIdentityCount() view returns (uint256)",
])
const legacyRouterInterface = new utils.Interface([
  "function bridge() view returns (address)",
  "function openFraudChallengeCount() view returns (uint256)",
])
const lifecycleRouterInterface = new utils.Interface([
  "function bridge() view returns (address)",
])
const frostWalletRegistryInterface = new utils.Interface([
  "function governance() view returns (address)",
  "function walletOwner() view returns (address)",
  "function lifecycleOwner() view returns (address)",
  "function updateLifecycleOwner(address lifecycleOwner)",
  "function getWalletArchiveMigrationManifestHash() view returns (bytes32)",
  "function getWalletArchiveFinalAttestations() view returns (bytes32 sourceAttestationHash,bytes32 reconcilerAttestationHash)",
  "function getWalletArchiveMigration() view returns (uint8 state,address authority,uint256 upgradeBlockNumber,bytes32 oldImplementationCodeHash,bytes32 newImplementationCodeHash,bytes32 walletsRoot,bytes32 historyRoot,bytes32 pendingManifestHash,uint256 expectedCount,uint256 completedCount,bytes32 checkpointHash,uint256 checkpointBlockNumber,uint256 maxTailBlocks)",
])
const ecdsaRouterInterface = new utils.Interface([
  "function bridge() view returns (address)",
  "function fraudProtocolID() view returns (bytes32)",
  "function predecessor() view returns (address)",
  "function predecessorCodeHash() view returns (bytes32)",
  "function ancestryDepth() view returns (uint256)",
  "function openFraudChallengeCount() view returns (uint256)",
  "function openFraudChallengeEscrow() view returns (uint256)",
  "function unattributedOpenFraudChallengeCount() view returns (uint256)",
  "function migratedChallengesActivatedAt() view returns (uint256)",
])

export type AuthorityKind = "eoa" | "safe" | "timelock"
export type PhaseStatus = "prepared" | "pending" | "executed"

export interface PreparedCall {
  id: string
  target: string
  value: string
  data: string
  description: string
}

export interface AuthorityEnvelope {
  kind: AuthorityKind
  authority: string
  inner: PreparedCall
  safeTransaction?: {
    to: string
    value: string
    data: string
    operation: 0
  }
  timelockOperationID?: string
  timelockSchedule?: PreparedCall
  timelockExecute?: PreparedCall
}

export interface ActivationPhase {
  id: string
  status: PhaseStatus
  prerequisite?: string
  notBefore?: string
  calls: AuthorityEnvelope[]
  transactionHashes: string[]
  readback?: Record<string, unknown>
}

export interface CoverageManifestEntry {
  index: number
  depositKey: string
  walletID: string
  outputKey: string
}

export interface CoverageManifest {
  schemaVersion: typeof COVERAGE_MANIFEST_SCHEMA
  chainId: string
  bridge: string
  historyStartBlockNumber: number
  snapshotBlockNumber: number
  snapshotBlockHash: string
  bitcoinJournalPath: string
  bitcoinJournalSha256: string
  bitcoinRawEvidenceCommitment: string
  semanticProjectionRoot: string
  linkedLibraries: Record<string, { address: string; runtimeCodeHash: string }>
  bitcoinWatermark: {
    blockHeight: number
    blockHash: string
  }
  rebuildCertificates: [RebuildCertificate, RebuildCertificate]
  coverageAuthorizationSignature: string
  legacyFraudChallengeKeys: string[]
  inventoryRoot?: string
}

export interface CoverageInventoryDocument {
  inventoryRoot?: string
  entries: CoverageManifestEntry[]
}

export interface DerivedCoverageEntry extends CoverageManifestEntry {
  commitment: string
  leaf: string
  proof: string[]
  migrationPayload: string
}

export interface DerivedCoverageInventory {
  root: string
  count: number
  entries: DerivedCoverageEntry[]
  initializationPayload: string
}

export interface CoverageEntryReadback {
  leaves: Record<string, boolean>
  outputKeys: Record<string, string>
}

export const coverageEntriesMatchReadback = (
  observed: CoverageEntryReadback,
  entries: DerivedCoverageEntry[]
): boolean =>
  entries.every(({ index, depositKey, outputKey }) => {
    const storedOutputKey = observed.outputKeys[depositKey]?.toLowerCase()
    // A migrated leaf with zero storage is the on-chain terminal marker:
    // action 1 writes the nonzero key atomically, while action 6 leaves zero.
    return (
      observed.leaves[index] === true &&
      (storedOutputKey === outputKey.toLowerCase() ||
        storedOutputKey === constants.HashZero)
    )
  })

export interface RuntimeReceipt {
  address: string
  runtimeBytes: number
  runtimeCodeHash: string
}

export interface FrostArchivePrerequisiteReceipt {
  artifactPath: string
  artifactHash: string
  artifactPhase: ArchivePhaseArtifact["phase"]
  state: typeof FROST_ARCHIVE_STATE_COMPLETED | typeof FROST_ARCHIVE_STATE_FRESH
  stateName: "Completed" | "Fresh"
  manifestHash: string
  proxy: string
  implementation: string
  implementationCodeHash: string
  oldImplementationCodeHash: string
  walletsRoot: string
  historyRoot: string
  expectedCount: string
  completedCount: string
  checkpointHash: string
  checkpointBlockNumber: string
  maxTailBlocks: string
  finalSourceAttestationHash: string
  finalReconcilerAttestationHash: string
}

export interface FrostLifecyclePrerequisiteReceipt {
  archive: FrostArchivePrerequisiteReceipt
  implementationRuntime: RuntimeReceipt
  lifecycleRouterRuntime: RuntimeReceipt
  lifecycleRouterBridge: string
  registryWalletOwner: string
  registryGovernance: string
  configuredBridgeFrostRegistry: string
  configuredBridgeLifecycleRouter: string
  registryLifecycleOwner: string
}

export interface FrostLifecycleInstallPlan {
  lifecycleRouterToInstall: string
  lifecycleOwnerToInstall: string
}

export interface FrostLifecyclePrerequisiteInput {
  provider: providers.Provider
  chainId: string
  networkName: string
  bridge: string
  frostWalletRegistry: Pick<Deployment, "address" | "implementation">
  bridgeLifecycleRouter: Pick<Deployment, "address" | "deployedBytecode">
  archiveArtifactPath: string
}

export interface EcdsaCutoverBinding {
  manifestPath: string
  manifestArtifactHash: string
  manifestPlanHash: string
  structuralPlanHash: string
  manifestPhase: string
  finalized: boolean
  evidenceGeneration: number
  evidenceAnchorArtifactHash: string
  evidencePredecessorArtifactHash: string
  authorizationTransactionHash: string
  authorizationPlanHash: string
  chainId: string
  bridge: string
  oldGovernance: string
  oldGovernanceCodeHash: string
  governance: string
  governanceCodeHash: string
  governanceOwner: string
  governanceDelay: string
  oldGovernanceTransferInitiatedAt: string
  oldGovernancePendingTarget: string
  oldGovernanceTransferNotBefore: string
  oldRouter: string
  oldRouterCodeHash: string
  router: string
  routerCodeHash: string
  protocolID: string
  predecessor: string
  predecessorCodeHash: string
  ancestryDepth: string
  openChallengeCount: string
  openChallengeEscrow: string
  unattributedOpenChallengeCount: string
  migratedChallengesActivatedAt: string
  sourceSigner: string
  sourceID: string
  sourceStoreIdentity: string
  sourceEndpointIdentity: string
  sourceTrustDomain: string
  sourcePolicyHash: string
  reconciler: string
  reconcilerSourceID: string
  reconcilerStoreIdentity: string
  reconcilerEndpointIdentity: string
  reconcilerTrustDomain: string
  reconcilerPolicyHash: string
}

export interface CompleteP2TRActivationArtifact {
  schemaVersion: typeof ACTIVATION_ARTIFACT_SCHEMA
  contentHash: string
  networkName: string
  chainId: string
  bridge: string
  structuralPlanID: string
  planID: string
  bridgePredecessorImplementation: string
  bridgePredecessorImplementationCodeHash: string
  ecdsaCutover: EcdsaCutoverBinding
  inventory: {
    manifestPath: string
    historyStartBlockNumber: number
    snapshotBlockNumber: number
    snapshotBlockHash: string
    bitcoinJournalSha256: string
    bitcoinRawEvidenceCommitment: string
    semanticProjectionRoot: string
    sourceCheckpointCommitment: string
    linkedLibrariesCommitment: string
    sourceIDs: string[]
    root: string
    count: number
    migrationCursor: number
  }
  addresses: Record<string, string>
  runtimeReceipts: Record<string, RuntimeReceipt>
  selectors: Record<string, string>
  phases: ActivationPhase[]
  readbacks: Record<string, unknown>
}

export interface LoadedActivationArtifact {
  artifact: CompleteP2TRActivationArtifact
  /** SHA-256 of the exact private envelope bytes used for the next CAS. */
  fileContentHash: string
}

interface StoredActivationArtifact {
  /** Makes every successful publication advance the raw-file CAS token. */
  writeNonce: string
  artifact: CompleteP2TRActivationArtifact
}

export type ActivationArtifactWriteOptions = {
  createOnly?: boolean
  expectedCurrentContentHash?: string
  failpoint?: DurableWriteFailpoint
}

const normalizeCode = (code: string): string => code.toLowerCase()

export function assertRuntimeCode(
  label: string,
  address: string,
  onChainCode: string,
  expectedRuntimeCode: string
): RuntimeReceipt {
  if (
    !utils.isAddress(address) ||
    !utils.isHexString(onChainCode) ||
    !utils.isHexString(expectedRuntimeCode) ||
    onChainCode === "0x" ||
    expectedRuntimeCode === "0x"
  ) {
    throw new Error(`${label}: missing or malformed runtime bytecode`)
  }
  if (normalizeCode(onChainCode) !== normalizeCode(expectedRuntimeCode)) {
    throw new Error(`${label}: deployed runtime codehash/link mismatch`)
  }
  const runtimeBytes = utils.arrayify(onChainCode).length
  if (runtimeBytes > EIP_170_RUNTIME_LIMIT) {
    throw new Error(
      `${label}: ${runtimeBytes}-byte runtime exceeds EIP-170 limit`
    )
  }
  const requiredHeadroom =
    label === "BridgeGovernance" ? 1_024 : EIP_170_REQUIRED_HEADROOM
  if (EIP_170_RUNTIME_LIMIT - runtimeBytes < requiredHeadroom) {
    throw new Error(
      `${label}: ${runtimeBytes}-byte runtime leaves less than ${requiredHeadroom} bytes of EIP-170 headroom`
    )
  }
  return {
    address: utils.getAddress(address),
    runtimeBytes,
    runtimeCodeHash: utils.keccak256(onChainCode),
  }
}

export async function classifyAuthority(
  provider: providers.Provider,
  authority: string,
  configuredAccounts: string[],
  contractKind?: "safe" | "timelock"
): Promise<AuthorityKind> {
  const code = await provider.getCode(authority)
  if (code === "0x") {
    // Preparation is deliberately signer-independent. Execute mode separately
    // checks that this EOA is locally configured before broadcasting.
    void configuredAccounts
    return "eoa"
  }
  if (!contractKind) {
    throw new Error(
      `Contract authority ${authority} requires an explicit safe/timelock kind`
    )
  }
  return contractKind
}

export function buildAuthorityEnvelope(
  call: PreparedCall,
  authority: string,
  kind: AuthorityKind,
  domain: { chainId: string; bridge: string; phase: string; delay?: string }
): AuthorityEnvelope {
  const envelope: AuthorityEnvelope = {
    kind,
    authority: utils.getAddress(authority),
    inner: call,
  }
  if (kind === "safe") {
    envelope.safeTransaction = {
      to: call.target,
      value: call.value,
      data: call.data,
      operation: 0,
    }
  }
  if (kind === "timelock") {
    const predecessor = constants.HashZero
    const salt = utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["string", "string", "address", "string", "address", "bytes"],
        [
          ACTIVATION_ARTIFACT_SCHEMA,
          domain.chainId,
          domain.bridge,
          domain.phase,
          call.target,
          call.data,
        ]
      )
    )
    const delay = domain.delay ?? "0"
    envelope.timelockOperationID = utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["address", "uint256", "bytes", "bytes32", "bytes32"],
        [call.target, call.value, call.data, predecessor, salt]
      )
    )
    envelope.timelockSchedule = {
      id: `${call.id}:schedule`,
      target: authority,
      value: "0",
      data: timelockInterface.encodeFunctionData("schedule", [
        call.target,
        call.value,
        call.data,
        predecessor,
        salt,
        delay,
      ]),
      description: `Schedule ${call.description}`,
    }
    envelope.timelockExecute = {
      id: `${call.id}:execute`,
      target: authority,
      value: "0",
      data: timelockInterface.encodeFunctionData("execute", [
        call.target,
        call.value,
        call.data,
        predecessor,
        salt,
      ]),
      description: `Execute ${call.description}`,
    }
  }
  return envelope
}

export function reconcilePhase(
  previous: ActivationPhase | undefined,
  candidate: ActivationPhase,
  observedExecuted: boolean
): ActivationPhase {
  if (observedExecuted) {
    return {
      ...candidate,
      status: "executed",
      transactionHashes: previous?.transactionHashes ?? [],
      readback: candidate.readback ?? previous?.readback,
    }
  }
  if (previous?.status === "executed") {
    throw new Error(
      `Activation state regression: phase ${candidate.id} was executed but its readback no longer matches`
    )
  }
  if (previous?.status === "pending") {
    // A pending phase's exact call/readback tuple is its durable broadcast
    // intent. Rebuilding a dynamic candidate (notably a coverage batch) must
    // not discard the transaction hash or reinterpret what was sent.
    return {
      ...candidate,
      status: "pending",
      calls: previous.calls,
      transactionHashes: previous.transactionHashes,
      readback: previous.readback,
    }
  }
  return {
    ...candidate,
    status: previous?.status ?? candidate.status,
    transactionHashes: previous?.transactionHashes ?? [],
    readback: candidate.readback ?? previous?.readback,
  }
}

export function deriveCoverageInventory(
  manifest: CoverageInventoryDocument
): DerivedCoverageInventory {
  const leaves = manifest.entries.map((entry, expectedIndex) => {
    if (entry.index !== expectedIndex) {
      throw new Error(
        "Coverage entries must have contiguous positional indices"
      )
    }
    if (
      !utils.isHexString(entry.walletID, 32) ||
      !utils.isHexString(entry.outputKey, 32) ||
      BigNumber.from(entry.depositKey).lt(0)
    ) {
      throw new Error(`Malformed coverage entry ${entry.index}`)
    }
    const commitment = utils.keccak256(
      utils.solidityPack(
        ["bytes32", "bytes32"],
        [entry.walletID, entry.outputKey]
      )
    )
    const leaf = utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["string", "uint64", "uint256", "bytes32", "bytes32", "bytes32"],
        [
          COVERAGE_LEAF_DOMAIN,
          entry.index,
          entry.depositKey,
          entry.walletID,
          entry.outputKey,
          commitment,
        ]
      )
    )
    return { entry, commitment, leaf }
  })

  if (leaves.length === 0) {
    if (
      manifest.inventoryRoot &&
      manifest.inventoryRoot.toLowerCase() !== constants.HashZero
    ) {
      throw new Error("Empty coverage inventory must use the zero root")
    }
    return {
      root: constants.HashZero,
      count: 0,
      entries: [],
      initializationPayload: utils.defaultAbiCoder.encode(
        ["uint8", "bytes32", "uint64"],
        [0, constants.HashZero, 0]
      ),
    }
  }

  let width = 1
  while (width < leaves.length) width <<= 1
  const layers: string[][] = [
    leaves
      .map(({ leaf }) => leaf)
      .concat(
        Array.from({ length: width - leaves.length }, () => constants.HashZero)
      ),
  ]
  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1]
    const next: string[] = []
    for (let i = 0; i < current.length; i += 2) {
      next.push(utils.keccak256(utils.concat([current[i], current[i + 1]])))
    }
    layers.push(next)
  }
  const root = layers[layers.length - 1][0]
  if (
    manifest.inventoryRoot &&
    manifest.inventoryRoot.toLowerCase() !== root.toLowerCase()
  ) {
    throw new Error("Coverage manifest root does not match its exact entries")
  }

  const entries = leaves.map(({ entry, commitment, leaf }) => {
    const proof: string[] = []
    let position = entry.index
    for (let layer = 0; layer < layers.length - 1; layer++) {
      proof.push(layers[layer][position ^ 1])
      position >>= 1
    }
    return {
      ...entry,
      commitment,
      leaf,
      proof,
      migrationPayload: utils.defaultAbiCoder.encode(
        ["uint8", "uint64", "uint256", "bytes32", "bytes32", "bytes32[]"],
        [
          1,
          entry.index,
          entry.depositKey,
          entry.walletID,
          entry.outputKey,
          proof,
        ]
      ),
    }
  })
  return {
    root,
    count: entries.length,
    entries,
    initializationPayload: utils.defaultAbiCoder.encode(
      ["uint8", "bytes32", "uint64"],
      [0, root, entries.length]
    ),
  }
}

const readAddressWord = (word: string, label: string): string => {
  if (!utils.isHexString(word, 32)) {
    throw new Error(`${label}: malformed storage word`)
  }
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(word)) {
    throw new Error(`${label}: non-address bits are set`)
  }
  return utils.getAddress(`0x${word.slice(-40)}`)
}

/**
 * BridgeGovernance intentionally has no getter for `newBridgeGovernance`.
 * Slot 74 is pinned to the committed legacy-production storage manifest by
 * validateStorageLayout before this reader is used.
 */
export const readPendingBridgeGovernanceTarget = async (
  provider: providers.Provider,
  governance: string
): Promise<string> =>
  readAddressWord(
    await provider.getStorageAt(
      governance,
      BRIDGE_GOVERNANCE_PENDING_TARGET_SLOT
    ),
    "BridgeGovernance pending Bridge governance target"
  )

export const validatePendingBridgeGovernanceTransfer = (
  initiatedAt: BigNumber | string | number,
  pendingTarget: string,
  expectedTarget: string
): boolean => {
  const hasInitiation = !BigNumber.from(initiatedAt).isZero()
  const normalizedPendingTarget = utils.getAddress(pendingTarget)
  const hasTarget = normalizedPendingTarget !== constants.AddressZero
  if (hasInitiation !== hasTarget) {
    throw new Error(
      "BridgeGovernance pending transfer has inconsistent initiation and target state"
    )
  }
  if (!hasInitiation) return false
  if (normalizedPendingTarget.toLowerCase() !== expectedTarget.toLowerCase()) {
    throw new Error(
      `BridgeGovernance pending target ${normalizedPendingTarget} does not match COMPLETE_V2 replacement ${expectedTarget}`
    )
  }
  return true
}

export const bridgeGovernanceTransferNotBefore = (
  initiatedAt: BigNumber | string | number,
  governanceDelay: BigNumber | string | number
): BigNumber => {
  const initiation = BigNumber.from(initiatedAt)
  if (initiation.isZero()) {
    throw new Error(
      "Cannot compute Bridge governance transfer deadline from zero initiation"
    )
  }
  return initiation.add(governanceDelay)
}

export const requirePendingBridgeGovernanceTarget = async (
  provider: providers.Provider,
  governance: string,
  expectedTarget: string,
  initiatedAt: BigNumber | string | number
): Promise<void> => {
  const observed = await readPendingBridgeGovernanceTarget(provider, governance)
  if (
    !validatePendingBridgeGovernanceTransfer(
      initiatedAt,
      observed,
      expectedTarget
    )
  ) {
    throw new Error(
      "BridgeGovernance has no active transfer to the COMPLETE_V2 replacement"
    )
  }
}

const callResult = async (
  provider: providers.Provider,
  target: string,
  iface: utils.Interface,
  functionName: string,
  args: unknown[] = []
): Promise<utils.Result> => {
  const result = await provider.call({
    to: target,
    data: iface.encodeFunctionData(functionName, args),
  })
  return iface.decodeFunctionResult(functionName, result)
}

const readAddress = async (
  provider: providers.Provider,
  target: string,
  iface: utils.Interface,
  functionName: string
): Promise<string> =>
  utils.getAddress((await callResult(provider, target, iface, functionName))[0])

const readUint = async (
  provider: providers.Provider,
  target: string,
  iface: utils.Interface,
  functionName: string
): Promise<BigNumber> =>
  BigNumber.from((await callResult(provider, target, iface, functionName))[0])

const sameHex = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase()

const assertArchiveSignature = async (
  provider: providers.Provider,
  signer: string,
  digest: string,
  signature: string
): Promise<void> => {
  if (!utils.isHexString(signature) || signature === "0x") {
    throw new Error("FROST archive manifest attestation signature is missing")
  }
  const signerCode = await provider.getCode(signer)
  if (signerCode === "0x") {
    if (!sameHex(utils.recoverAddress(digest, signature), signer)) {
      throw new Error("FROST archive manifest attestation signature mismatch")
    }
    return
  }
  const eip1271 = new utils.Interface([
    "function isValidSignature(bytes32 digest,bytes signature) view returns (bytes4)",
  ])
  const result = await provider.call({
    to: signer,
    data: eip1271.encodeFunctionData("isValidSignature", [digest, signature]),
  })
  if (
    !sameHex(
      eip1271.decodeFunctionResult("isValidSignature", result)[0],
      "0x1626ba7e"
    )
  ) {
    throw new Error("FROST archive manifest attestation signature rejected")
  }
}

const assertCompletedArchiveArtifact = async (
  provider: providers.Provider,
  artifact: ArchivePhaseArtifact,
  manifestHash: string,
  migration: {
    authority: string
    upgradeBlockNumber: BigNumber
    oldImplementationCodeHash: string
    newImplementationCodeHash: string
    walletsRoot: string
    historyRoot: string
    pendingManifestHash: string
    expectedCount: BigNumber
    completedCount: BigNumber
    checkpointHash: string
    checkpointBlockNumber: BigNumber
    maxTailBlocks: BigNumber
  },
  finalAttestations: {
    source: string
    reconciler: string
  }
): Promise<ArchiveManifestV2> => {
  const { manifest } = artifact
  if (
    !manifest ||
    !artifact.manifestHash ||
    !artifact.checkpoint ||
    !artifact.proofEntries ||
    !artifact.manifestAttestationRequests
  ) {
    throw new Error(
      "Executed FROST archive artifact is missing signed manifest/root receipts"
    )
  }
  const calculatedManifestHash = hashArchiveManifestV2(manifest)
  if (
    !sameHex(calculatedManifestHash, artifact.manifestHash) ||
    !sameHex(manifestHash, artifact.manifestHash) ||
    !sameHex(migration.pendingManifestHash, artifact.manifestHash)
  ) {
    throw new Error("FROST archive signed manifest hash mismatch")
  }
  const proofTree = buildArchiveMerkleTree(
    artifact.proofEntries.map(
      ({ walletID, dkgResultHash, membersIdsHash }) => ({
        walletID,
        dkgResultHash,
        membersIdsHash,
      })
    )
  )
  if (
    !sameHex(proofTree.root, manifest.walletsRoot) ||
    proofTree.entries.length !== manifest.walletCount ||
    canonicalJSON(proofTree.entries) !== canonicalJSON(artifact.proofEntries)
  ) {
    throw new Error("FROST archive wallet root/proof receipt mismatch")
  }
  if (
    !sameHex(
      hashArchiveCheckpoint(artifact.checkpoint),
      artifact.checkpoint.checkpointHash
    ) ||
    !sameHex(artifact.checkpoint.checkpointHash, manifest.checkpointHash)
  ) {
    throw new Error("FROST archive checkpoint root receipt mismatch")
  }
  if (
    manifest.schemaHash.toLowerCase() !==
      ARCHIVE_MANIFEST_SCHEMA_HASH.toLowerCase() ||
    !sameHex(manifest.registry, artifact.proxy) ||
    !sameHex(
      manifest.oldImplementationCodeHash,
      artifact.oldImplementationCodeHash
    ) ||
    !sameHex(
      manifest.newImplementationCodeHash,
      artifact.implementationCodeHash
    ) ||
    !sameHex(
      migration.oldImplementationCodeHash,
      manifest.oldImplementationCodeHash
    ) ||
    !sameHex(
      migration.newImplementationCodeHash,
      manifest.newImplementationCodeHash
    ) ||
    !sameHex(migration.walletsRoot, manifest.walletsRoot) ||
    !sameHex(migration.historyRoot, manifest.historyRoot) ||
    !sameHex(migration.checkpointHash, manifest.checkpointHash) ||
    !sameHex(migration.authority, artifact.authority) ||
    !migration.upgradeBlockNumber.eq(manifest.upgradeBlockNumber) ||
    !migration.expectedCount.eq(manifest.walletCount) ||
    !migration.completedCount.eq(manifest.walletCount) ||
    !migration.checkpointBlockNumber.eq(manifest.checkpointBlockNumber) ||
    !migration.maxTailBlocks.eq(manifest.maxTailBlocks) ||
    artifact.checkpoint.chainId !== artifact.chainId ||
    !sameHex(artifact.checkpoint.registry, artifact.proxy) ||
    artifact.checkpoint.checkpointBlockNumber !==
      manifest.checkpointBlockNumber ||
    artifact.checkpoint.maxTailBlocks !== manifest.maxTailBlocks ||
    artifact.checkpoint.upgradeDeadlineBlock !==
      manifest.upgradeDeadlineBlock ||
    artifact.upgradeBlockNumber !== manifest.upgradeBlockNumber ||
    artifact.upgradeBlockHash === undefined ||
    !sameHex(artifact.upgradeBlockHash, manifest.upgradeBlockHash) ||
    artifact.upgradeTransactionIndex !== manifest.upgradeTransactionIndex
  ) {
    throw new Error("FROST archive artifact/on-chain readback mismatch")
  }

  const expectedRequests = {
    source: buildArchiveManifestAttestation(
      manifest,
      artifact.manifestHash,
      ARCHIVE_SOURCE_ATTESTATION_ROLE,
      manifest.sourceAttester
    ),
    reconciler: buildArchiveManifestAttestation(
      manifest,
      artifact.manifestHash,
      ARCHIVE_RECONCILER_ATTESTATION_ROLE,
      manifest.reconcilerAttester
    ),
  }
  if (
    canonicalJSON(expectedRequests) !==
    canonicalJSON(artifact.manifestAttestationRequests)
  ) {
    throw new Error("FROST archive manifest attestation context mismatch")
  }
  const expectedAttestationHashes = {
    source: hashArchiveManifestAttestation(expectedRequests.source),
    reconciler: hashArchiveManifestAttestation(expectedRequests.reconciler),
  }
  if (
    !sameHex(finalAttestations.source, expectedAttestationHashes.source) ||
    !sameHex(finalAttestations.reconciler, expectedAttestationHashes.reconciler)
  ) {
    throw new Error("FROST archive final signed-attestation readback mismatch")
  }
  if (artifact.manifestAttestations) {
    await Promise.all(
      (["source", "reconciler"] as const).map(async (role) => {
        const expected = expectedRequests[role]
        const signed = artifact.manifestAttestations?.[role]
        const digest = expectedAttestationHashes[role]
        if (!signed) {
          throw new Error("FROST archive signed attestation receipt mismatch")
        }
        if (
          canonicalJSON(signed.attestation) !== canonicalJSON(expected) ||
          !sameHex(signed.digest, digest) ||
          !sameHex(signed.signer, expected.attester)
        ) {
          throw new Error("FROST archive signed attestation receipt mismatch")
        }
        await assertArchiveSignature(
          provider,
          expected.attester,
          digest,
          signed.signature
        )
      })
    )
  }
  return manifest
}

export const immutableFrostPrerequisiteBinding = (
  receipt: FrostLifecyclePrerequisiteReceipt
): Record<string, unknown> => ({
  archive: receipt.archive,
  implementationRuntime: receipt.implementationRuntime,
  lifecycleRouterRuntime: receipt.lifecycleRouterRuntime,
  lifecycleRouterBridge: receipt.lifecycleRouterBridge,
  registryWalletOwner: receipt.registryWalletOwner,
  registryGovernance: receipt.registryGovernance,
})

export const assertFrostPrerequisiteResumeBinding = (
  previousBinding: unknown,
  receipt: FrostLifecyclePrerequisiteReceipt
): void => {
  if (
    previousBinding === undefined ||
    canonicalJSON(previousBinding) !==
      canonicalJSON(immutableFrostPrerequisiteBinding(receipt))
  ) {
    throw new Error("FROST archive/lifecycle prerequisite resume drift")
  }
}

export function resolveFrostLifecycleInstallPlan(
  receipt: FrostLifecyclePrerequisiteReceipt,
  previousAddresses?: Record<string, string>
): FrostLifecycleInstallPlan {
  const desiredRouter = receipt.lifecycleRouterRuntime.address
  const resumed = previousAddresses !== undefined
  if (
    resumed &&
    (previousAddresses.lifecycleRouterToInstall === undefined ||
      previousAddresses.lifecycleOwnerToInstall === undefined)
  ) {
    throw new Error(
      "Resume artifact is missing the FROST lifecycle install plan"
    )
  }
  let lifecycleRouterToInstall = constants.AddressZero
  let lifecycleOwnerToInstall = constants.AddressZero
  if (resumed) {
    lifecycleRouterToInstall = previousAddresses.lifecycleRouterToInstall
    lifecycleOwnerToInstall = previousAddresses.lifecycleOwnerToInstall
  } else {
    if (receipt.configuredBridgeLifecycleRouter === constants.AddressZero) {
      lifecycleRouterToInstall = desiredRouter
    }
    if (receipt.registryLifecycleOwner === constants.AddressZero) {
      lifecycleOwnerToInstall = desiredRouter
    }
  }
  const plannedBindings: Array<[string, string]> = [
    ["Bridge lifecycle router", lifecycleRouterToInstall],
    ["FROST lifecycle owner", lifecycleOwnerToInstall],
  ]
  plannedBindings.forEach(([label, planned]) => {
    if (
      !utils.isAddress(planned) ||
      (planned !== constants.AddressZero && !sameHex(planned, desiredRouter))
    ) {
      throw new Error(`Resume artifact has an invalid ${label} plan`)
    }
  })
  if (
    receipt.configuredBridgeLifecycleRouter === constants.AddressZero &&
    lifecycleRouterToInstall === constants.AddressZero
  ) {
    throw new Error(
      "Resume artifact does not install the missing lifecycle router"
    )
  }
  if (
    receipt.registryLifecycleOwner === constants.AddressZero &&
    lifecycleOwnerToInstall === constants.AddressZero
  ) {
    throw new Error(
      "Resume artifact does not install the missing lifecycle owner"
    )
  }
  return { lifecycleRouterToInstall, lifecycleOwnerToInstall }
}

export async function verifyFrostLifecyclePrerequisites({
  provider,
  chainId,
  networkName,
  bridge,
  frostWalletRegistry,
  bridgeLifecycleRouter,
  archiveArtifactPath,
}: FrostLifecyclePrerequisiteInput): Promise<FrostLifecyclePrerequisiteReceipt> {
  const resolvedArchiveArtifactPath = path.resolve(archiveArtifactPath)
  const archiveArtifact = readArchivePhase(resolvedArchiveArtifactPath)
  if (!archiveArtifact) {
    throw new Error("Executed deploy54 FROST archive artifact is required")
  }
  if (
    archiveArtifact.phase !== "executed" ||
    archiveArtifact.networkName !== networkName ||
    archiveArtifact.chainId !== chainId ||
    !sameHex(archiveArtifact.proxy, frostWalletRegistry.address)
  ) {
    throw new Error(
      "FROST archive artifact is not executed for this deployment"
    )
  }
  if (
    !frostWalletRegistry.implementation ||
    !utils.isAddress(frostWalletRegistry.implementation)
  ) {
    throw new Error("FrostWalletRegistry implementation metadata is missing")
  }
  const liveImplementation = readAddressWord(
    await provider.getStorageAt(
      frostWalletRegistry.address,
      EIP_1967_IMPLEMENTATION_SLOT
    ),
    "FrostWalletRegistry EIP-1967 implementation"
  )
  if (
    !sameHex(liveImplementation, frostWalletRegistry.implementation) ||
    !sameHex(liveImplementation, archiveArtifact.implementation)
  ) {
    throw new Error("FrostWalletRegistry proxy implementation address mismatch")
  }
  const implementationCode = await provider.getCode(liveImplementation)
  const implementationRuntime = assertRuntimeCode(
    "FrostWalletRegistry implementation",
    liveImplementation,
    implementationCode,
    implementationCode
  )
  if (
    !sameHex(
      implementationRuntime.runtimeCodeHash,
      archiveArtifact.implementationCodeHash
    )
  ) {
    throw new Error(
      "FrostWalletRegistry proxy implementation codehash mismatch"
    )
  }

  const migrationResult = await callResult(
    provider,
    frostWalletRegistry.address,
    frostWalletRegistryInterface,
    "getWalletArchiveMigration"
  )
  const migration = {
    state: BigNumber.from(migrationResult.state).toNumber(),
    authority: utils.getAddress(migrationResult.authority),
    upgradeBlockNumber: BigNumber.from(migrationResult.upgradeBlockNumber),
    oldImplementationCodeHash:
      migrationResult.oldImplementationCodeHash as string,
    newImplementationCodeHash:
      migrationResult.newImplementationCodeHash as string,
    walletsRoot: migrationResult.walletsRoot as string,
    historyRoot: migrationResult.historyRoot as string,
    pendingManifestHash: migrationResult.pendingManifestHash as string,
    expectedCount: BigNumber.from(migrationResult.expectedCount),
    completedCount: BigNumber.from(migrationResult.completedCount),
    checkpointHash: migrationResult.checkpointHash as string,
    checkpointBlockNumber: BigNumber.from(
      migrationResult.checkpointBlockNumber
    ),
    maxTailBlocks: BigNumber.from(migrationResult.maxTailBlocks),
  }
  if (
    migration.state !== FROST_ARCHIVE_STATE_COMPLETED &&
    migration.state !== FROST_ARCHIVE_STATE_FRESH
  ) {
    throw new Error("FROST archive state must be exactly Completed or Fresh")
  }
  const manifestHash = (
    await callResult(
      provider,
      frostWalletRegistry.address,
      frostWalletRegistryInterface,
      "getWalletArchiveMigrationManifestHash"
    )
  )[0] as string
  if (
    !utils.isHexString(manifestHash, 32) ||
    manifestHash === constants.HashZero
  ) {
    throw new Error("FROST archive signed manifest hash is zero")
  }

  let finalSourceAttestationHash = constants.HashZero
  let finalReconcilerAttestationHash = constants.HashZero
  if (migration.state === FROST_ARCHIVE_STATE_COMPLETED) {
    const finalAttestations = await callResult(
      provider,
      frostWalletRegistry.address,
      frostWalletRegistryInterface,
      "getWalletArchiveFinalAttestations"
    )
    finalSourceAttestationHash = finalAttestations.sourceAttestationHash
    finalReconcilerAttestationHash = finalAttestations.reconcilerAttestationHash
    const manifest = await assertCompletedArchiveArtifact(
      provider,
      archiveArtifact,
      manifestHash,
      migration,
      {
        source: finalSourceAttestationHash,
        reconciler: finalReconcilerAttestationHash,
      }
    )
    if (manifest.chainId !== chainId) {
      throw new Error("FROST archive manifest chain ID mismatch")
    }
  } else {
    const freshManifestHash = utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["bytes32", "uint256", "address"],
        [FROST_FRESH_ARCHIVE_SCHEMA_HASH, chainId, frostWalletRegistry.address]
      )
    )
    if (
      !sameHex(manifestHash, freshManifestHash) ||
      !sameHex(archiveArtifact.oldImplementation, liveImplementation) ||
      !sameHex(
        archiveArtifact.oldImplementationCodeHash,
        implementationRuntime.runtimeCodeHash
      ) ||
      archiveArtifact.authority !== constants.AddressZero ||
      archiveArtifact.frostInactivity !== constants.AddressZero ||
      archiveArtifact.frostInactivityCodeHash !== constants.HashZero ||
      archiveArtifact.manifest !== undefined ||
      archiveArtifact.proofEntries !== undefined ||
      archiveArtifact.checkpoint !== undefined ||
      migration.authority !== constants.AddressZero ||
      !migration.upgradeBlockNumber.isZero() ||
      migration.oldImplementationCodeHash !== constants.HashZero ||
      migration.newImplementationCodeHash !== constants.HashZero ||
      migration.walletsRoot !== constants.HashZero ||
      migration.historyRoot !== constants.HashZero ||
      migration.pendingManifestHash !== constants.HashZero ||
      !migration.expectedCount.isZero() ||
      !migration.completedCount.isZero() ||
      migration.checkpointHash !== constants.HashZero ||
      !migration.checkpointBlockNumber.isZero() ||
      !migration.maxTailBlocks.isZero() ||
      (archiveArtifact.manifestHash !== undefined &&
        !sameHex(archiveArtifact.manifestHash, manifestHash))
    ) {
      throw new Error("Fresh FROST archive artifact/readback mismatch")
    }
  }

  const lifecycleRouterCode = await provider.getCode(
    bridgeLifecycleRouter.address
  )
  if (!bridgeLifecycleRouter.deployedBytecode) {
    throw new Error("BridgeLifecycleRouter runtime metadata is missing")
  }
  const lifecycleRouterRuntime = assertRuntimeCode(
    "BridgeLifecycleRouter",
    bridgeLifecycleRouter.address,
    lifecycleRouterCode,
    bridgeLifecycleRouter.deployedBytecode
  )
  const lifecycleRouterBridge = await readAddress(
    provider,
    bridgeLifecycleRouter.address,
    lifecycleRouterInterface,
    "bridge"
  )
  const registryWalletOwner = await readAddress(
    provider,
    frostWalletRegistry.address,
    frostWalletRegistryInterface,
    "walletOwner"
  )
  const registryGovernance = await readAddress(
    provider,
    frostWalletRegistry.address,
    frostWalletRegistryInterface,
    "governance"
  )
  const configuredBridgeFrostRegistry = readAddressWord(
    await provider.getStorageAt(bridge, BRIDGE_FROST_REGISTRY_STORAGE_SLOT),
    "Bridge FROST registry slot"
  )
  const configuredBridgeLifecycleRouter = readAddressWord(
    await provider.getStorageAt(bridge, BRIDGE_LIFECYCLE_ROUTER_STORAGE_SLOT),
    "Bridge lifecycle router slot"
  )
  const registryLifecycleOwner = await readAddress(
    provider,
    frostWalletRegistry.address,
    frostWalletRegistryInterface,
    "lifecycleOwner"
  )
  if (
    !sameHex(lifecycleRouterBridge, bridge) ||
    !sameHex(registryWalletOwner, bridge)
  ) {
    throw new Error("FROST lifecycle router/registry Bridge crosslink mismatch")
  }
  if (
    configuredBridgeFrostRegistry !== constants.AddressZero &&
    !sameHex(configuredBridgeFrostRegistry, frostWalletRegistry.address)
  ) {
    throw new Error("Bridge is bound to a different FROST registry")
  }
  if (
    configuredBridgeLifecycleRouter !== constants.AddressZero &&
    !sameHex(configuredBridgeLifecycleRouter, bridgeLifecycleRouter.address)
  ) {
    throw new Error("Bridge is bound to a different lifecycle router")
  }
  if (
    registryLifecycleOwner !== constants.AddressZero &&
    !sameHex(registryLifecycleOwner, bridgeLifecycleRouter.address)
  ) {
    throw new Error("FrostWalletRegistry has a different lifecycle owner")
  }

  return {
    archive: {
      artifactPath: resolvedArchiveArtifactPath,
      artifactHash: archiveArtifact.artifactHash as string,
      artifactPhase: archiveArtifact.phase,
      state: migration.state,
      stateName:
        migration.state === FROST_ARCHIVE_STATE_COMPLETED
          ? "Completed"
          : "Fresh",
      manifestHash,
      proxy: utils.getAddress(frostWalletRegistry.address),
      implementation: liveImplementation,
      implementationCodeHash: implementationRuntime.runtimeCodeHash,
      oldImplementationCodeHash: migration.oldImplementationCodeHash,
      walletsRoot: migration.walletsRoot,
      historyRoot: migration.historyRoot,
      expectedCount: migration.expectedCount.toString(),
      completedCount: migration.completedCount.toString(),
      checkpointHash: migration.checkpointHash,
      checkpointBlockNumber: migration.checkpointBlockNumber.toString(),
      maxTailBlocks: migration.maxTailBlocks.toString(),
      finalSourceAttestationHash,
      finalReconcilerAttestationHash,
    },
    implementationRuntime,
    lifecycleRouterRuntime,
    lifecycleRouterBridge,
    registryWalletOwner,
    registryGovernance,
    configuredBridgeFrostRegistry,
    configuredBridgeLifecycleRouter,
    registryLifecycleOwner,
  }
}

const readBytes32 = async (
  provider: providers.Provider,
  target: string,
  iface: utils.Interface,
  functionName: string
): Promise<string> => {
  const value = (await callResult(provider, target, iface, functionName))[0]
  if (!utils.isHexString(value, 32)) {
    throw new Error(`${functionName}: malformed bytes32 readback`)
  }
  return value
}

const readBool = async (
  provider: providers.Provider,
  target: string,
  iface: utils.Interface,
  functionName: string,
  args: unknown[] = []
): Promise<boolean> =>
  Boolean((await callResult(provider, target, iface, functionName, args))[0])

const assertCodeHash = async (
  provider: providers.Provider,
  label: string,
  address: string,
  expectedCodeHash: string
): Promise<void> => {
  if (!utils.isAddress(address) || !utils.isHexString(expectedCodeHash, 32)) {
    throw new Error(`${label}: malformed address/code hash`)
  }
  const code = await provider.getCode(address)
  if (
    code === "0x" ||
    utils.keccak256(code).toLowerCase() !== expectedCodeHash.toLowerCase()
  ) {
    throw new Error(`${label}: runtime code hash mismatch`)
  }
}

export interface EcdsaCutoverDeployments {
  canonicalGovernance: Deployment
  cutoverGovernance: Deployment
  historicalGovernance: Deployment
  canonicalRouter: Deployment
  cutoverRouter: Deployment
  historicalRouter: Deployment
}

const sameAddress = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase()

const sameHash = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase()

export async function verifyEcdsaCutoverAuthorizationTransaction(
  provider: providers.Provider,
  manifest: HandoffManifest
): Promise<{ transactionHash: string; planHash: string }> {
  const transactionHash = manifest.transactions?.["begin-drain"]
  if (!transactionHash || !utils.isHexString(transactionHash, 32)) {
    throw new Error(
      "ECDSA finalized cutover manifest lacks a valid begin-drain transaction"
    )
  }
  const [transaction, receipt] = await Promise.all([
    provider.getTransaction(transactionHash),
    provider.getTransactionReceipt(transactionHash),
  ])
  if (
    !transaction ||
    !receipt ||
    receipt.status !== 1 ||
    !transaction.to ||
    !sameAddress(transaction.to, manifest.newGovernance) ||
    !sameHash(transaction.hash, transactionHash)
  ) {
    throw new Error(
      "ECDSA begin-drain transaction is missing, reverted, or targets another governance"
    )
  }
  let parsedTransaction: utils.TransactionDescription
  try {
    parsedTransaction = bridgeGovernanceInterface.parseTransaction({
      data: transaction.data,
      value: transaction.value,
    })
  } catch (_) {
    throw new Error("ECDSA begin-drain transaction calldata is malformed")
  }
  if (
    parsedTransaction.name !== "processEcdsaFraudCutoverAuthorityAction" ||
    !BigNumber.from(parsedTransaction.args.action).eq(3)
  ) {
    throw new Error("ECDSA begin-drain transaction invokes another action")
  }
  const canonicalBlock = await provider.getBlock(receipt.blockNumber)
  if (
    !canonicalBlock?.hash ||
    !sameHash(canonicalBlock.hash, receipt.blockHash)
  ) {
    throw new Error("ECDSA begin-drain receipt is not on the canonical chain")
  }
  const authorizationTopic = bridgeGovernanceInterface.getEventTopic(
    "EcdsaFraudCutoverAuthorizationBound"
  )
  const authorizationLogs = receipt.logs.filter(
    (log) =>
      sameAddress(log.address, manifest.newGovernance) &&
      log.topics.length > 0 &&
      sameHash(log.topics[0], authorizationTopic)
  )
  if (authorizationLogs.length !== 1) {
    throw new Error(
      "ECDSA begin-drain receipt must contain exactly one authorization binding"
    )
  }
  const authorization = bridgeGovernanceInterface.parseLog(authorizationLogs[0])
  const expectedPlanHash = handoffPlanHash(manifest)
  if (
    !sameHash(authorization.args.manifestPlanHash, expectedPlanHash) ||
    !sameHash(
      authorization.args.sourceCheckpointCommitment,
      manifest.sourceCheckpointCommitment
    ) ||
    BigNumber.from(authorization.args.maxTailBlocks).toNumber() !==
      manifest.maxTailBlocks ||
    !BigNumber.from(authorization.args.stageDeadlineBlock).eq(
      receipt.blockNumber + 255
    )
  ) {
    throw new Error(
      "ECDSA begin-drain authorization binding disagrees with the manifest"
    )
  }
  return {
    transactionHash: transaction.hash,
    planHash: authorization.args.manifestPlanHash,
  }
}

export async function validateEcdsaCutoverBinding(
  provider: providers.Provider,
  manifest: HandoffManifest,
  manifestPath: string,
  manifestArtifactHash: string,
  chainId: string,
  bridge: string,
  deployments: EcdsaCutoverDeployments,
  unionImplementationInstalled: boolean
): Promise<EcdsaCutoverBinding> {
  if (manifest.version !== 5) {
    throw new Error("ECDSA cutover manifest version is unsupported")
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(manifestArtifactHash)) {
    throw new Error("ECDSA cutover manifest artifact hash is malformed")
  }
  assertCutoverAuthoritySeparation(manifest)
  if (
    manifest.chainId.toString() !== chainId ||
    !sameAddress(manifest.bridge, bridge)
  ) {
    throw new Error("ECDSA cutover manifest chain/Bridge mismatch")
  }
  if (
    sameAddress(manifest.oldGovernance, manifest.newGovernance) ||
    sameAddress(manifest.oldRouter, manifest.replacementRouter)
  ) {
    throw new Error(
      "ECDSA cutover manifest does not name distinct replacements"
    )
  }
  const aliasPairs: Array<[string, Deployment, string]> = [
    [
      "cutover governance",
      deployments.cutoverGovernance,
      manifest.newGovernance,
    ],
    [
      "historical governance",
      deployments.historicalGovernance,
      manifest.oldGovernance,
    ],
    ["cutover router", deployments.cutoverRouter, manifest.replacementRouter],
    ["historical router", deployments.historicalRouter, manifest.oldRouter],
  ]
  aliasPairs.forEach(([label, deployment, expected]) => {
    if (!sameAddress(deployment.address, expected)) {
      throw new Error(`ECDSA ${label} deployment alias mismatch`)
    }
  })
  if (
    !sameAddress(
      deployments.canonicalGovernance.address,
      manifest.oldGovernance
    ) &&
    !sameAddress(
      deployments.canonicalGovernance.address,
      manifest.newGovernance
    )
  ) {
    throw new Error("ECDSA canonical governance alias is outside the manifest")
  }
  if (
    !sameAddress(deployments.canonicalRouter.address, manifest.oldRouter) &&
    !sameAddress(
      deployments.canonicalRouter.address,
      manifest.replacementRouter
    )
  ) {
    throw new Error("ECDSA canonical router alias is outside the manifest")
  }

  await Promise.all([
    assertCodeHash(
      provider,
      "ECDSA old governance",
      manifest.oldGovernance,
      manifest.oldGovernanceRuntimeCodeHash
    ),
    assertCodeHash(
      provider,
      "ECDSA cutover governance",
      manifest.newGovernance,
      manifest.newGovernanceRuntimeCodeHash
    ),
    assertCodeHash(
      provider,
      "ECDSA old router",
      manifest.oldRouter,
      manifest.oldRouterRuntimeCodeHash
    ),
    assertCodeHash(
      provider,
      "ECDSA cutover router",
      manifest.replacementRouter,
      manifest.replacementRouterRuntimeCodeHash
    ),
  ])

  if (
    manifest.historyEmitters.length < 2 ||
    manifest.historyEmitters[0].kind !== "bridge" ||
    !sameAddress(manifest.historyEmitters[0].address, bridge) ||
    !sameAddress(manifest.historyEmitters[1].address, manifest.oldRouter) ||
    !sameHash(
      manifest.historyEmitters[1].runtimeCodeHash,
      manifest.oldRouterRuntimeCodeHash
    )
  ) {
    throw new Error("ECDSA cutover manifest has invalid router ancestry")
  }
  const discoveredHistoryEmitters = await discoverHistoryEmitters(
    provider,
    bridge,
    manifest.oldRouter,
    Object.fromEntries(
      manifest.historyEmitters.map((emitter) => [
        emitter.address,
        emitter.expectedUnrelatedBalance,
      ])
    )
  )
  const exactEmitter = (
    emitter: HandoffManifest["historyEmitters"][number]
  ): string =>
    [
      emitter.address.toLowerCase(),
      emitter.runtimeCodeHash.toLowerCase(),
      emitter.kind,
      BigNumber.from(emitter.expectedUnrelatedBalance).toString(),
    ].join(":")
  if (
    discoveredHistoryEmitters.map(exactEmitter).join("|") !==
    manifest.historyEmitters.map(exactEmitter).join("|")
  ) {
    throw new Error("ECDSA cutover manifest router ancestry is incomplete")
  }

  const [
    replacementBridge,
    protocolID,
    predecessor,
    predecessorCodeHash,
    ancestryDepth,
    openChallengeCount,
    openChallengeEscrow,
    unattributedOpenChallengeCount,
    migratedChallengesActivatedAt,
    governanceBridge,
    governanceOwner,
    governanceDelay,
  ] = await Promise.all([
    readAddress(
      provider,
      manifest.replacementRouter,
      ecdsaRouterInterface,
      "bridge"
    ),
    readBytes32(
      provider,
      manifest.replacementRouter,
      ecdsaRouterInterface,
      "fraudProtocolID"
    ),
    readAddress(
      provider,
      manifest.replacementRouter,
      ecdsaRouterInterface,
      "predecessor"
    ),
    readBytes32(
      provider,
      manifest.replacementRouter,
      ecdsaRouterInterface,
      "predecessorCodeHash"
    ),
    readUint(
      provider,
      manifest.replacementRouter,
      ecdsaRouterInterface,
      "ancestryDepth"
    ),
    readUint(
      provider,
      manifest.replacementRouter,
      ecdsaRouterInterface,
      "openFraudChallengeCount"
    ),
    readUint(
      provider,
      manifest.replacementRouter,
      ecdsaRouterInterface,
      "openFraudChallengeEscrow"
    ),
    readUint(
      provider,
      manifest.replacementRouter,
      ecdsaRouterInterface,
      "unattributedOpenFraudChallengeCount"
    ),
    readUint(
      provider,
      manifest.replacementRouter,
      ecdsaRouterInterface,
      "migratedChallengesActivatedAt"
    ),
    readAddress(
      provider,
      manifest.newGovernance,
      bridgeGovernanceInterface,
      "bridgeAddress"
    ),
    readAddress(
      provider,
      manifest.newGovernance,
      bridgeGovernanceInterface,
      "owner"
    ),
    BigNumber.from(
      (
        await callResult(
          provider,
          manifest.newGovernance,
          bridgeGovernanceInterface,
          "governanceDelays",
          [0]
        )
      )[0]
    ),
  ])
  if (
    !sameAddress(replacementBridge, bridge) ||
    !sameHash(protocolID, ECDSA_CUTOVER_PROTOCOL_ID) ||
    !sameAddress(predecessor, manifest.oldRouter) ||
    !sameHash(predecessorCodeHash, manifest.oldRouterRuntimeCodeHash) ||
    !ancestryDepth.eq(manifest.historyEmitters.length - 1)
  ) {
    throw new Error("ECDSA replacement router protocol/predecessor mismatch")
  }
  if (
    !sameAddress(governanceBridge, bridge) ||
    !sameAddress(governanceOwner, manifest.governanceOwner) ||
    governanceDelay.toString() !== manifest.governanceDelay
  ) {
    throw new Error("ECDSA cutover governance identity mismatch")
  }

  const [oldGovernanceTransferWord, oldGovernancePendingTarget, oldDelay] =
    await Promise.all([
      provider.getStorageAt(
        manifest.oldGovernance,
        BRIDGE_GOVERNANCE_TRANSFER_INITIATED_SLOT
      ),
      readPendingBridgeGovernanceTarget(provider, manifest.oldGovernance),
      callResult(
        provider,
        manifest.oldGovernance,
        bridgeGovernanceInterface,
        "governanceDelays",
        [0]
      ).then((result) => BigNumber.from(result[0])),
    ])
  const oldGovernanceTransferInitiatedAt = BigNumber.from(
    oldGovernanceTransferWord
  )
  if (!oldDelay.eq(manifest.governanceDelay)) {
    throw new Error("ECDSA old governance delay changed during cutover")
  }
  const oldGovernanceTransferPending = validatePendingBridgeGovernanceTransfer(
    oldGovernanceTransferInitiatedAt,
    oldGovernancePendingTarget,
    manifest.newGovernance
  )
  const oldGovernanceTransferNotBefore = oldGovernanceTransferPending
    ? bridgeGovernanceTransferNotBefore(
        oldGovernanceTransferInitiatedAt,
        oldDelay
      )
    : BigNumber.from(0)

  let finalized = false
  if (unionImplementationInstalled) {
    const [
      liveGovernance,
      liveRouter,
      approvedRouterCodeHash,
      drainRouter,
      oldRouterRetired,
    ] = await Promise.all([
      readAddress(provider, bridge, bridgeInterface, "governance"),
      readAddress(provider, bridge, bridgeInterface, "ecdsaFraudRouter"),
      readBytes32(
        provider,
        bridge,
        bridgeInterface,
        "ecdsaFraudRouterCodeHash"
      ),
      readAddress(provider, bridge, bridgeInterface, "ecdsaFraudRouterInDrain"),
      readBool(provider, bridge, bridgeInterface, "isEcdsaFraudRouterRetired", [
        manifest.oldRouter,
      ]),
    ])
    if (
      (!sameAddress(liveGovernance, manifest.oldGovernance) &&
        !sameAddress(liveGovernance, manifest.newGovernance)) ||
      (!sameAddress(liveRouter, manifest.oldRouter) &&
        !sameAddress(liveRouter, manifest.replacementRouter)) ||
      (!sameAddress(drainRouter, constants.AddressZero) &&
        !sameAddress(drainRouter, manifest.oldRouter))
    ) {
      throw new Error("ECDSA cutover live state is outside the manifest")
    }
    if (
      (sameAddress(liveRouter, manifest.oldRouter) &&
        !sameHash(approvedRouterCodeHash, manifest.oldRouterRuntimeCodeHash)) ||
      (sameAddress(liveRouter, manifest.replacementRouter) &&
        !sameHash(
          approvedRouterCodeHash,
          manifest.replacementRouterRuntimeCodeHash
        ))
    ) {
      throw new Error(
        "ECDSA live router code authorization is outside the manifest"
      )
    }
    finalized =
      sameAddress(liveGovernance, manifest.newGovernance) &&
      sameAddress(liveRouter, manifest.replacementRouter) &&
      sameHash(
        approvedRouterCodeHash,
        manifest.replacementRouterRuntimeCodeHash
      ) &&
      sameAddress(drainRouter, constants.AddressZero) &&
      oldRouterRetired &&
      !migratedChallengesActivatedAt.isZero()
    if (manifest.phase === "finalized" && !finalized) {
      throw new Error("ECDSA finalized manifest disagrees with Bridge readback")
    }
    if (manifest.phase !== "finalized" && finalized) {
      throw new Error("ECDSA on-chain cutover has an unfinalized manifest")
    }
  } else if (manifest.phase === "finalized") {
    throw new Error("ECDSA manifest finalized before the union Bridge upgrade")
  }

  if (finalized) {
    if (
      !sameAddress(
        deployments.canonicalGovernance.address,
        manifest.newGovernance
      )
    ) {
      throw new Error("ECDSA finalized governance canonical alias is stale")
    }
    if (
      !sameAddress(
        deployments.canonicalRouter.address,
        manifest.replacementRouter
      )
    ) {
      throw new Error("ECDSA finalized router canonical alias is stale")
    }
  }

  let authorization = {
    transactionHash: constants.HashZero,
    planHash: constants.HashZero,
  }
  if (manifest.transactions?.["begin-drain"] || finalized) {
    authorization = await verifyEcdsaCutoverAuthorizationTransaction(
      provider,
      manifest
    )
  }

  return {
    manifestPath,
    manifestArtifactHash,
    manifestPlanHash: handoffPlanHash(manifest),
    structuralPlanHash: ownerAuthorizationHash(manifest),
    manifestPhase: manifest.phase,
    finalized,
    evidenceGeneration: manifest.evidenceGeneration,
    evidenceAnchorArtifactHash: manifest.evidenceAnchorArtifactHash,
    evidencePredecessorArtifactHash: manifest.evidencePredecessorArtifactHash,
    authorizationTransactionHash: authorization.transactionHash,
    authorizationPlanHash: authorization.planHash,
    chainId,
    bridge: utils.getAddress(bridge),
    oldGovernance: utils.getAddress(manifest.oldGovernance),
    oldGovernanceCodeHash: manifest.oldGovernanceRuntimeCodeHash,
    governance: utils.getAddress(manifest.newGovernance),
    governanceCodeHash: manifest.newGovernanceRuntimeCodeHash,
    governanceOwner: utils.getAddress(manifest.governanceOwner),
    governanceDelay: manifest.governanceDelay,
    oldGovernanceTransferInitiatedAt:
      oldGovernanceTransferInitiatedAt.toString(),
    oldGovernancePendingTarget,
    oldGovernanceTransferNotBefore: oldGovernanceTransferNotBefore.toString(),
    oldRouter: utils.getAddress(manifest.oldRouter),
    oldRouterCodeHash: manifest.oldRouterRuntimeCodeHash,
    router: utils.getAddress(manifest.replacementRouter),
    routerCodeHash: manifest.replacementRouterRuntimeCodeHash,
    protocolID,
    predecessor,
    predecessorCodeHash,
    ancestryDepth: ancestryDepth.toString(),
    openChallengeCount: openChallengeCount.toString(),
    openChallengeEscrow: openChallengeEscrow.toString(),
    unattributedOpenChallengeCount: unattributedOpenChallengeCount.toString(),
    migratedChallengesActivatedAt: migratedChallengesActivatedAt.toString(),
    sourceSigner: utils.getAddress(manifest.sourceSigner),
    sourceID: manifest.sourceId,
    sourceStoreIdentity: manifest.sourceContext.durableStoreIdentity,
    sourceEndpointIdentity: manifest.sourceContext.endpointIdentity,
    sourceTrustDomain: manifest.sourceContext.trustDomain,
    sourcePolicyHash: manifest.sourceContext.policyHash,
    reconciler: utils.getAddress(manifest.reconciler),
    reconcilerSourceID: manifest.reconcilerSourceId,
    reconcilerStoreIdentity: manifest.reconcilerContext.durableStoreIdentity,
    reconcilerEndpointIdentity: manifest.reconcilerContext.endpointIdentity,
    reconcilerTrustDomain: manifest.reconcilerContext.trustDomain,
    reconcilerPolicyHash: manifest.reconcilerContext.policyHash,
  }
}

export function assertEcdsaCutoverResume(
  previous: EcdsaCutoverBinding,
  current: EcdsaCutoverBinding
): void {
  const immutableKeys: Array<keyof EcdsaCutoverBinding> = [
    "manifestPath",
    "structuralPlanHash",
    "chainId",
    "bridge",
    "oldGovernance",
    "oldGovernanceCodeHash",
    "governance",
    "governanceCodeHash",
    "governanceOwner",
    "governanceDelay",
    "oldRouter",
    "oldRouterCodeHash",
    "router",
    "routerCodeHash",
    "protocolID",
    "predecessor",
    "predecessorCodeHash",
    "ancestryDepth",
    "sourceSigner",
    "sourceID",
    "sourceStoreIdentity",
    "sourceEndpointIdentity",
    "sourceTrustDomain",
    "sourcePolicyHash",
    "reconciler",
    "reconcilerSourceID",
    "reconcilerStoreIdentity",
    "reconcilerEndpointIdentity",
    "reconcilerTrustDomain",
    "reconcilerPolicyHash",
  ]
  immutableKeys.forEach((key) => {
    if (previous[key] !== current[key]) {
      throw new Error(`ECDSA cutover resume identity drift: ${key}`)
    }
  })
  if (previous.finalized && !current.finalized) {
    throw new Error("ECDSA cutover resume regressed from finalized state")
  }
  if (current.evidenceGeneration < previous.evidenceGeneration) {
    throw new Error("ECDSA cutover evidence generation regressed during resume")
  }
  if (current.evidenceGeneration === previous.evidenceGeneration) {
    if (previous.manifestPlanHash !== current.manifestPlanHash) {
      throw new Error(
        "ECDSA cutover plan changed without a new evidence generation"
      )
    }
    if (
      current.evidenceGeneration === 0 &&
      previous.manifestArtifactHash !== current.manifestArtifactHash
    ) {
      throw new Error("ECDSA initial cutover manifest artifact drifted")
    }
  } else {
    const previousArtifactHash = artifactContentHashBytes32(
      previous.manifestArtifactHash
    )
    if (
      current.evidenceGeneration === previous.evidenceGeneration + 1 &&
      !sameHash(current.evidencePredecessorArtifactHash, previousArtifactHash)
    ) {
      throw new Error(
        "ECDSA cutover evidence predecessor does not bind the prior artifact"
      )
    }
    const expectedAnchor =
      previous.evidenceGeneration === 0
        ? previousArtifactHash
        : previous.evidenceAnchorArtifactHash
    if (!sameHash(current.evidenceAnchorArtifactHash, expectedAnchor)) {
      throw new Error("ECDSA cutover evidence anchor changed during resume")
    }
  }
  if (!sameHash(previous.authorizationTransactionHash, constants.HashZero)) {
    if (
      !sameHash(
        previous.authorizationTransactionHash,
        current.authorizationTransactionHash
      ) ||
      !sameHash(previous.authorizationPlanHash, current.authorizationPlanHash)
    ) {
      throw new Error("ECDSA cutover authorization binding regressed")
    }
  }
  if (
    current.finalized &&
    (!sameHash(current.authorizationPlanHash, current.manifestPlanHash) ||
      sameHash(current.authorizationTransactionHash, constants.HashZero))
  ) {
    throw new Error("ECDSA finalized cutover lacks its authenticated plan")
  }
  if (previous.finalized) {
    const finalKeys: Array<keyof EcdsaCutoverBinding> = [
      "manifestArtifactHash",
      "manifestPlanHash",
      "evidenceGeneration",
      "evidenceAnchorArtifactHash",
      "evidencePredecessorArtifactHash",
      "authorizationTransactionHash",
      "authorizationPlanHash",
    ]
    finalKeys.forEach((key) => {
      if (previous[key] !== current[key]) {
        throw new Error(`ECDSA finalized cutover binding changed: ${key}`)
      }
    })
  }
}

const readCoverage = async (
  provider: providers.Provider,
  bridge: string,
  entries: DerivedCoverageEntry[]
): Promise<{
  initialized: boolean
  root: string
  count: string
  migratedCount: string
  leaves: Record<string, boolean>
  outputKeys: Record<string, string>
  authorization: {
    authority: string
    digest: string
    router: string
    historyStartBlock: string
    snapshotBlock: string
    snapshotBlockHash: string
    sourceCheckpointCommitment: string
    sourceCheckpoint1: string
    sourceCheckpoint2: string
    linkedLibrariesCommitment: string
  }
}> => {
  const stateOuter = await callResult(
    provider,
    bridge,
    bridgeInterface,
    "processTaprootOutputKeyCoverage",
    [utils.defaultAbiCoder.encode(["uint8"], [2])]
  )
  const [initialized, root, count, migratedCount] =
    utils.defaultAbiCoder.decode(
      ["bool", "bytes32", "uint64", "uint64"],
      stateOuter[0]
    )
  const authorizationOuter = await callResult(
    provider,
    bridge,
    bridgeInterface,
    "processTaprootOutputKeyCoverage",
    [utils.defaultAbiCoder.encode(["uint8"], [7])]
  )
  const authorizationResult = utils.defaultAbiCoder.decode(
    [
      "address",
      "bytes32",
      "address",
      "uint64",
      "uint64",
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
      "bytes32",
    ],
    authorizationOuter[0]
  )
  const leaves: Record<string, boolean> = {}
  const outputKeys: Record<string, string> = {}
  for (let offset = 0; offset < entries.length; offset += 64) {
    const batch = entries.slice(offset, offset + 64)
    // eslint-disable-next-line no-await-in-loop
    const states = await Promise.all(
      batch.map(async (entry) => {
        const [leafOuter, outputKeyOuter] = await Promise.all([
          callResult(
            provider,
            bridge,
            bridgeInterface,
            "processTaprootOutputKeyCoverage",
            [
              utils.defaultAbiCoder.encode(
                ["uint8", "uint64"],
                [3, entry.index]
              ),
            ]
          ),
          callResult(
            provider,
            bridge,
            bridgeInterface,
            "processTaprootOutputKeyCoverage",
            [
              utils.defaultAbiCoder.encode(
                ["uint8", "uint256"],
                [4, entry.depositKey]
              ),
            ]
          ),
        ])
        return {
          migrated: utils.defaultAbiCoder.decode(["bool"], leafOuter[0])[0],
          outputKey: utils.defaultAbiCoder.decode(
            ["bytes32"],
            outputKeyOuter[0]
          )[0] as string,
        }
      })
    )
    states.forEach((state, index) => {
      leaves[batch[index].index] = state.migrated
      outputKeys[batch[index].depositKey] = state.outputKey
    })
  }
  return {
    initialized,
    root,
    count: count.toString(),
    migratedCount: migratedCount.toString(),
    leaves,
    outputKeys,
    authorization: {
      authority: authorizationResult[0],
      digest: authorizationResult[1],
      router: authorizationResult[2],
      historyStartBlock: authorizationResult[3].toString(),
      snapshotBlock: authorizationResult[4].toString(),
      snapshotBlockHash: authorizationResult[5],
      sourceCheckpointCommitment: authorizationResult[6],
      sourceCheckpoint1: authorizationResult[7],
      sourceCheckpoint2: authorizationResult[8],
      linkedLibrariesCommitment: authorizationResult[9],
    },
  }
}

export interface NextCoverageBatch {
  completed: boolean
  cursor: number
  indices: number[]
  payload: string
}

export const buildNextCoverageBatch = async (
  provider: providers.Provider,
  bridge: string,
  entries: DerivedCoverageEntry[],
  cursor: number,
  readBitmap = true
): Promise<NextCoverageBatch> => {
  if (entries.length === 0) {
    return { completed: true, cursor: 0, indices: [], payload: "0x" }
  }
  const start = cursor >= 0 && cursor < entries.length ? cursor : 0
  const ordered = entries.slice(start).concat(entries.slice(0, start))
  const pending: DerivedCoverageEntry[] = []
  if (!readBitmap) {
    pending.push(...ordered.slice(0, MAXIMUM_COVERAGE_BATCH_SIZE))
  }
  for (
    let offset = 0;
    readBitmap &&
    offset < ordered.length &&
    pending.length < MAXIMUM_COVERAGE_BATCH_SIZE;
    offset += 64
  ) {
    const candidates = ordered.slice(offset, offset + 64)
    // eslint-disable-next-line no-await-in-loop
    const migrated = await Promise.all(
      candidates.map(async (entry) => {
        const leafOuter = await callResult(
          provider,
          bridge,
          bridgeInterface,
          "processTaprootOutputKeyCoverage",
          [utils.defaultAbiCoder.encode(["uint8", "uint64"], [3, entry.index])]
        )
        return utils.defaultAbiCoder.decode(
          ["bool"],
          leafOuter[0]
        )[0] as boolean
      })
    )
    for (let index = 0; index < candidates.length; index++) {
      if (!migrated[index]) pending.push(candidates[index])
      if (pending.length === MAXIMUM_COVERAGE_BATCH_SIZE) break
    }
  }
  if (pending.length === 0) {
    return { completed: true, cursor: start, indices: [], payload: "0x" }
  }
  const migrations = await Promise.all(
    pending.map(async (entry) => {
      const deposit = await callResult(
        provider,
        bridge,
        bridgeInterface,
        "deposits",
        [entry.depositKey]
      )
      const terminal =
        (deposit[0] as string) === constants.AddressZero ||
        !BigNumber.from(deposit[5]).isZero()
      return utils.defaultAbiCoder.encode(
        ["uint8", "uint64", "uint256", "bytes32", "bytes32", "bytes32[]"],
        [
          terminal ? 6 : 1,
          entry.index,
          entry.depositKey,
          entry.walletID,
          entry.outputKey,
          entry.proof,
        ]
      )
    })
  )
  const finalIndex = pending[pending.length - 1].index
  return {
    completed: false,
    cursor: (finalIndex + 1) % entries.length,
    indices: pending.map(({ index }) => index),
    payload: utils.defaultAbiCoder.encode(
      ["uint8", "bytes[]"],
      [5, migrations]
    ),
  }
}

const requireZeroAccounting = async (
  provider: providers.Provider,
  router: string,
  registry: string
): Promise<void> => {
  const checks = [
    [
      "router open challenge count",
      await readUint(
        provider,
        router,
        routerInterface,
        "openFraudChallengeCount"
      ),
    ],
    [
      "router challenge escrow",
      await readUint(provider, router, routerInterface, "totalChallengeEscrow"),
    ],
    [
      "router withdrawable payouts",
      await readUint(
        provider,
        router,
        routerInterface,
        "totalWithdrawablePayouts"
      ),
    ],
    [
      "registry active reservations",
      await readUint(
        provider,
        registry,
        registryInterface,
        "activeReservationCount"
      ),
    ],
    [
      "registry active-reservation set version",
      await readUint(
        provider,
        registry,
        registryInterface,
        "activeReservationSetVersion"
      ),
    ],
    [
      "registry authorization identities",
      await readUint(
        provider,
        registry,
        registryInterface,
        "authorizedChallengeIdentityCount"
      ),
    ],
  ] as Array<[string, BigNumber]>
  checks.forEach(([label, value]) => {
    if (!value.isZero()) throw new Error(`Non-zero ${label}: ${value}`)
  })
  if (!(await provider.getBalance(router)).isZero()) {
    throw new Error("Candidate COMPLETE_V2 router has unexplained ETH")
  }
}

export const validateStorageLayout = (repositoryRoot: string): void => {
  const layoutPath = path.join(
    repositoryRoot,
    "test/formal/Bridge.storage-layout.json"
  )
  const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8")) as {
    storage: Array<{ label: string; slot: string; type: string }>
    types: Record<
      string,
      {
        members?: Array<{ label: string; slot: string; type: string }>
        numberOfBytes?: string
      }
    >
  }
  const self = layout.storage.find(({ label }) => label === "self")
  if (!self || self.slot !== "51") {
    throw new Error("Bridge storage layout: unexpected self slot")
  }
  const members = layout.types[self.type]?.members ?? []
  const required = new Map<string, string>([
    ["frostWalletRegistry", "32"],
    ["ecdsaFraudRouter", "33"],
    ["p2trFraudRouter", "34"],
    ["lifecycleRouter", "35"],
    ["taprootDepositOutputKeyCommitments", "38"],
    ["ecdsaFraudRouterCodeHash", "39"],
    ["ecdsaFraudRouterInDrain", "40"],
    ["retiredEcdsaFraudRouters", "41"],
    ["taprootDepositOutputKeys", "42"],
    ["taprootOutputKeyCoverageInitialized", "43"],
    ["taprootOutputKeyCoverageInventoryRoot", "44"],
    ["taprootOutputKeyCoverageLeafMigrated", "45"],
    ["taprootOutputKeyCoverageAuthorizedRouter", "46"],
    ["taprootOutputKeyCoverageAuthorizationDigest", "47"],
    ["taprootOutputKeyCoverageHistoryStartBlock", "48"],
    ["taprootOutputKeyCoverageSnapshotBlockHash", "49"],
    ["taprootOutputKeyCoverageSourceCheckpointCommitment", "50"],
    ["taprootOutputKeyCoverageSourceCheckpoint1", "51"],
    ["taprootOutputKeyCoverageSourceCheckpoint2", "52"],
    ["taprootOutputKeyCoverageLinkedLibrariesCommitment", "53"],
    ["__gap", "54"],
  ])
  required.forEach((slot, label) => {
    const member = members.find((candidate) => candidate.label === label)
    if (!member || member.slot !== slot) {
      throw new Error(
        `Bridge storage layout: ${label} expected at relative slot ${slot}`
      )
    }
  })
  const gap = members.find(({ label }) => label === "__gap")
  const gapType = gap ? layout.types[gap.type] : undefined
  if (
    !gapType ||
    !/24_storage$/.test(gap!.type) ||
    layout.types[self.type]?.numberOfBytes !== "2496"
  ) {
    throw new Error(
      "Bridge storage layout: expected 24-slot gap and 2496-byte union layout"
    )
  }

  const governanceLayoutPath = path.join(
    repositoryRoot,
    "test/formal/BridgeGovernance.legacy-production.json"
  )
  const governanceLayout = JSON.parse(
    fs.readFileSync(governanceLayoutPath, "utf8")
  ) as {
    storageSlots?: {
      governanceDelay?: number
      bridgeTransferChangeInitiated?: number
      newBridgeGovernance?: number
    }
  }
  if (
    governanceLayout.storageSlots?.governanceDelay !==
      BRIDGE_GOVERNANCE_DELAY_SLOT ||
    governanceLayout.storageSlots?.bridgeTransferChangeInitiated !==
      BRIDGE_GOVERNANCE_TRANSFER_INITIATED_SLOT ||
    governanceLayout.storageSlots?.newBridgeGovernance !==
      BRIDGE_GOVERNANCE_PENDING_TARGET_SLOT
  ) {
    throw new Error(
      "BridgeGovernance legacy storage layout: expected transfer initiation at slot 73 and pending target at slot 74"
    )
  }
}

export interface AuthenticatedCoverageManifest {
  inventory: CoverageInventoryDocument
  sourceIDs: string[]
  backendIDs: string[]
  signers: string[]
  checkpointDigests: string[]
}

export interface LinkReference {
  length: number
  start: number
}

export type DeployedLinkReferences = Record<
  string,
  Record<string, LinkReference[]>
>

const canonicalDeposits = (deposits: unknown[]): string =>
  utils.keccak256(utils.toUtf8Bytes(JSON.stringify(deposits)))

export const validateManifest = async (
  hre: HardhatRuntimeEnvironment,
  manifest: CoverageManifest,
  manifestPath: string,
  bridge: string,
  archiveBridgeInterface: utils.Interface
): Promise<AuthenticatedCoverageManifest> => {
  if (manifest.schemaVersion !== COVERAGE_MANIFEST_SCHEMA) {
    throw new Error("Unsupported coverage manifest schema")
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "entries")) {
    throw new Error(
      "Coverage entries must be derived from authenticated history"
    )
  }
  if (manifest.chainId !== (await hre.getChainId())) {
    throw new Error("Coverage manifest chain mismatch")
  }
  if (manifest.bridge.toLowerCase() !== bridge.toLowerCase()) {
    throw new Error("Coverage manifest Bridge mismatch")
  }
  if (manifest.legacyFraudChallengeKeys.length !== 0) {
    throw new Error("Legacy fraud challenge inventory must be empty")
  }
  if (
    manifest.rebuildCertificates.length !== 2 ||
    manifest.historyStartBlockNumber > manifest.snapshotBlockNumber
  ) {
    throw new Error(
      "Exactly two authenticated rebuild checkpoints are required"
    )
  }
  const snapshot = await hre.ethers.provider.getBlock(
    manifest.snapshotBlockNumber
  )
  const latest = await hre.ethers.provider.getBlock("latest")
  const maximumTailBlocks = Number(
    process.env.COMPLETE_P2TR_MAX_ACTIVATION_TAIL_BLOCKS ??
      DEFAULT_MAXIMUM_ACTIVATION_TAIL_BLOCKS
  )
  if (
    !Number.isSafeInteger(maximumTailBlocks) ||
    maximumTailBlocks < 0 ||
    latest.number - manifest.snapshotBlockNumber > maximumTailBlocks
  ) {
    throw new Error("Coverage checkpoint-to-activation tail is too long")
  }
  if (
    !snapshot?.hash ||
    snapshot.hash.toLowerCase() !== manifest.snapshotBlockHash.toLowerCase()
  ) {
    throw new Error("Coverage manifest snapshot is unavailable or reorged")
  }

  const manifestDirectory = path.dirname(manifestPath)
  const journalPath = path.resolve(
    manifestDirectory,
    manifest.bitcoinJournalPath
  )
  const derivedBySource = [] as Awaited<
    ReturnType<typeof verifyAndDeriveEthereumArchive>
  >[]
  const sourceIDs = new Set<string>()
  const backendIDs = new Set<string>()
  const signers = new Set<string>()
  const checkpointDigests: string[] = []
  for (const certificate of manifest.rebuildCertificates) {
    if (
      !certificate.sourceID ||
      !certificate.backendID ||
      !utils.isAddress(certificate.signer) ||
      sourceIDs.has(certificate.sourceID) ||
      backendIDs.has(certificate.backendID) ||
      signers.has(certificate.signer.toLowerCase())
    ) {
      throw new Error("Rebuild checkpoints are not independent")
    }
    sourceIDs.add(certificate.sourceID)
    backendIDs.add(certificate.backendID)
    signers.add(certificate.signer.toLowerCase())
    const archivePath = path.resolve(manifestDirectory, certificate.archivePath)
    // eslint-disable-next-line no-await-in-loop
    const rebuilt = await verifyAndDeriveEthereumArchive(
      hre.ethers.provider,
      archivePath,
      {
        chainId: manifest.chainId,
        bridge,
        historyStartBlockNumber: manifest.historyStartBlockNumber,
        snapshotBlockNumber: manifest.snapshotBlockNumber,
        snapshotBlockHash: manifest.snapshotBlockHash,
      },
      archiveBridgeInterface
    )
    if (
      rebuilt.archive.sourceID !== certificate.sourceID ||
      rebuilt.archive.backendID !== certificate.backendID ||
      rebuilt.sha256.toLowerCase() !==
        certificate.archiveSha256.toLowerCase() ||
      certificate.bitcoinJournalSha256.toLowerCase() !==
        manifest.bitcoinJournalSha256.toLowerCase() ||
      certificate.bitcoinRawEvidenceCommitment.toLowerCase() !==
        manifest.bitcoinRawEvidenceCommitment.toLowerCase() ||
      certificate.semanticProjectionRoot.toLowerCase() !==
        manifest.semanticProjectionRoot.toLowerCase()
    ) {
      throw new Error("Rebuild checkpoint commitment mismatch")
    }
    verifyBitcoinJournal(
      journalPath,
      certificate.bitcoinJournalSha256,
      {
        ethereumBlockNumber: manifest.snapshotBlockNumber,
        ethereumBlockHash: manifest.snapshotBlockHash,
        bitcoinBlockHeight: manifest.bitcoinWatermark.blockHeight,
        bitcoinBlockHash: manifest.bitcoinWatermark.blockHash,
        bitcoinRawEvidenceCommitment: manifest.bitcoinRawEvidenceCommitment,
        semanticProjectionRoot: manifest.semanticProjectionRoot,
      },
      rebuilt.deposits
    )
    const digest = rebuildCertificateDigest(
      manifest.chainId,
      bridge,
      rebuilt.archive,
      rebuilt.sha256,
      certificate.bitcoinJournalSha256,
      certificate.bitcoinRawEvidenceCommitment,
      certificate.semanticProjectionRoot
    )
    // eslint-disable-next-line no-await-in-loop
    await verifyIndependentSignature(
      hre.ethers.provider,
      certificate.signer,
      digest,
      certificate.signature
    )
    checkpointDigests.push(digest)
    derivedBySource.push(rebuilt)
  }

  if (
    canonicalDeposits(derivedBySource[0].deposits) !==
    canonicalDeposits(derivedBySource[1].deposits)
  ) {
    throw new Error("Independent rebuild checkpoints disagree")
  }
  const uniqueDepositKeys = new Set(
    derivedBySource[0].deposits.map(({ depositKey }) => depositKey)
  )
  if (uniqueDepositKeys.size !== derivedBySource[0].deposits.length) {
    throw new Error("Authenticated history contains duplicate deposit keys")
  }
  const missing = await reconcileDerivedCoverageStorage(
    hre.ethers.provider,
    bridge,
    manifest.snapshotBlockNumber,
    derivedBySource[0].deposits
  )
  const inventory: CoverageInventoryDocument = {
    inventoryRoot: manifest.inventoryRoot,
    entries: missing.map((deposit, index) => ({
      index,
      depositKey: deposit.depositKey,
      walletID: deposit.walletID,
      outputKey: deposit.outputKey,
    })),
  }
  const canonicalSnapshot = await hre.ethers.provider.getBlock(
    manifest.snapshotBlockNumber
  )
  if (
    canonicalSnapshot?.hash?.toLowerCase() !==
    manifest.snapshotBlockHash.toLowerCase()
  ) {
    throw new Error("Coverage manifest snapshot reorged during validation")
  }
  return {
    inventory,
    sourceIDs: [...sourceIDs],
    backendIDs: [...backendIDs],
    signers: [...signers],
    checkpointDigests,
  }
}

export const assertExactBridgeLinkMap = (
  deployedBytecode: string,
  references: DeployedLinkReferences,
  linkedLibraries: Record<string, { address: string; runtimeCodeHash: string }>
): void => {
  const flattened = Object.entries(references).flatMap(([source, libraries]) =>
    Object.entries(libraries).map(([name, locations]) => ({
      source,
      name,
      locations,
    }))
  )
  const actualNames = flattened.map(({ name }) => name).sort()
  const expectedNames = Object.keys(linkedLibraries).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Bridge linked-library inventory is omitted or has extras")
  }
  for (const { name, locations } of flattened) {
    const expectedAddress = linkedLibraries[name].address.toLowerCase().slice(2)
    if (
      locations.length === 0 ||
      locations.some(
        ({ length, start }) =>
          length !== 20 ||
          deployedBytecode
            .slice(2 + start * 2, 2 + (start + length) * 2)
            .toLowerCase() !== expectedAddress
      )
    ) {
      throw new Error(`Bridge linked-library target mismatch: ${name}`)
    }
  }
}

export const linkedLibrariesCommitment = (
  linkedLibraries: Record<string, { address: string; runtimeCodeHash: string }>
): string => {
  const names = Object.keys(linkedLibraries).sort()
  return utils.keccak256(
    utils.defaultAbiCoder.encode(
      ["string", "string[]", "address[]", "bytes32[]"],
      [
        LINKED_LIBRARIES_DOMAIN,
        names,
        names.map((name) => linkedLibraries[name].address),
        names.map((name) => linkedLibraries[name].runtimeCodeHash),
      ]
    )
  )
}

export interface OrderedSourceCheckpoint {
  identity: string
  signer: string
  digest: string
  signature: string
}

export const orderedSourceCheckpoints = (
  manifest: CoverageManifest,
  authenticated: AuthenticatedCoverageManifest
): [OrderedSourceCheckpoint, OrderedSourceCheckpoint] => {
  if (
    authenticated.sourceIDs.length !== 2 ||
    authenticated.backendIDs.length !== 2 ||
    authenticated.signers.length !== 2 ||
    authenticated.checkpointDigests.length !== 2
  ) {
    throw new Error("Dual-source checkpoint is incomplete")
  }
  const checkpoints = [0, 1].map((index) => ({
    identity: utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["string", "string"],
        [authenticated.sourceIDs[index], authenticated.backendIDs[index]]
      )
    ),
    signer: authenticated.signers[index],
    digest: authenticated.checkpointDigests[index],
    signature: manifest.rebuildCertificates[index].signature,
  }))
  checkpoints.sort((left, right) =>
    left.identity.toLowerCase() < right.identity.toLowerCase() ? -1 : 1
  )
  return checkpoints as [OrderedSourceCheckpoint, OrderedSourceCheckpoint]
}

export const dualSourceCheckpointCommitment = (
  manifest: CoverageManifest,
  authenticated: AuthenticatedCoverageManifest
): string => {
  const checkpoints = orderedSourceCheckpoints(manifest, authenticated)
  const checkpointCommitments = checkpoints.map((checkpoint) =>
    utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["bytes32", "address", "bytes32"],
        [checkpoint.identity, checkpoint.signer, checkpoint.digest]
      )
    )
  )
  return utils.keccak256(
    utils.defaultAbiCoder.encode(
      ["string", "uint256", "address", "bytes32", "bytes32"],
      [
        DUAL_SOURCE_CHECKPOINT_DOMAIN,
        manifest.chainId,
        manifest.bridge,
        checkpointCommitments[0],
        checkpointCommitments[1],
      ]
    )
  )
}

const expectedRuntime = (deployment: Deployment, label: string): string => {
  const runtime = deployment.deployedBytecode
  if (!runtime) {
    throw new Error(`${label}: hardhat-deploy omitted linked runtime bytecode`)
  }
  return runtime
}

const canonicalJSON = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
    .join(",")}}`
}

export const activationArtifactContentHash = (
  artifact:
    | Omit<CompleteP2TRActivationArtifact, "contentHash">
    | CompleteP2TRActivationArtifact
): string => {
  const { contentHash: _, ...body } = artifact as CompleteP2TRActivationArtifact
  return utils.keccak256(utils.toUtf8Bytes(canonicalJSON(body)))
}

const pathEntryExists = (entry: string): boolean => {
  try {
    fs.lstatSync(entry)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

const activationSchemaFromDocument = (document: unknown): unknown => {
  if (!document || typeof document !== "object") return undefined
  const record = document as Record<string, unknown>
  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>
    if (payload.artifact && typeof payload.artifact === "object") {
      return (payload.artifact as Record<string, unknown>).schemaVersion
    }
    return payload.schemaVersion
  }
  return record.schemaVersion
}

const rejectUnsupportedActivationSchema = (
  artifactPath: string,
  document: unknown
): void => {
  const schema = activationSchemaFromDocument(document)
  if (schema === LEGACY_ACTIVATION_ARTIFACT_SCHEMA) {
    throw new Error(
      `COMPLETE_V2 activation artifact schema v2 is unsupported: ${artifactPath}`
    )
  }
  if (schema === PREVIOUS_ACTIVATION_ARTIFACT_SCHEMA) {
    throw new Error(
      `COMPLETE_V2 activation artifact schema v3 is unsupported after the authenticated step-87 handoff: ${artifactPath}`
    )
  }
  if (schema !== undefined && schema !== ACTIVATION_ARTIFACT_SCHEMA) {
    throw new Error(
      `Unsupported COMPLETE_V2 activation artifact schema ${String(
        schema
      )}: ${artifactPath}`
    )
  }
}

/**
 * Old deployment 88 promoted a fixed `.tmp` file without authenticating where
 * it came from. Durable writes use unique temporary names and never infer a
 * committed state from them. Any leftover temporary entry is therefore an
 * operator-reconciliation event, not a recovery candidate.
 */
export const assertNoActivationTemporaryArtifacts = (
  artifactPath: string
): void => {
  const directory = path.dirname(path.resolve(artifactPath))
  if (!pathEntryExists(directory)) return
  const basename = path.basename(artifactPath)
  const fixedTemporary = `${basename}.tmp`
  const durableTemporaryPrefix = `.${basename}.tmp-`
  const temporaryEntries = fs
    .readdirSync(directory)
    .filter(
      (entry) =>
        entry === fixedTemporary || entry.startsWith(durableTemporaryPrefix)
    )
  if (temporaryEntries.length !== 0) {
    throw new Error(
      `Uncommitted COMPLETE_V2 activation temporary artifact requires manual reconciliation: ${temporaryEntries
        .sort()
        .join(",")}`
    )
  }
}

/**
 * Deployment 88 historically stored a raw artifact directly in the network
 * deployment directory. That location is not a private durable store. Refuse
 * to silently ignore it: v2/v3 are unsupported, while v4 requires an explicit,
 * audited migration unless the operator deliberately configured it as the
 * active path (where the normal strict reader still applies).
 */
export const assertNoHistoricalActivationArtifact = (
  historicalArtifactPath: string,
  activeArtifactPath: string
): void => {
  assertNoActivationTemporaryArtifacts(historicalArtifactPath)
  if (!pathEntryExists(historicalArtifactPath)) return

  let privateFile: ReturnType<typeof readPrivateFileWithHash>
  try {
    privateFile = readPrivateFileWithHash(historicalArtifactPath)
  } catch (error) {
    throw new Error(
      `Historical COMPLETE_V2 activation artifact requires manual reconciliation before use: ${historicalArtifactPath} (${
        (error as Error).message
      })`
    )
  }
  let document: unknown
  try {
    document = JSON.parse(privateFile.contents) as unknown
  } catch {
    throw new Error(
      `Historical COMPLETE_V2 activation artifact requires manual reconciliation before use: ${historicalArtifactPath} (malformed JSON)`
    )
  }
  rejectUnsupportedActivationSchema(historicalArtifactPath, document)
  if (activationSchemaFromDocument(document) !== ACTIVATION_ARTIFACT_SCHEMA) {
    throw new Error(
      `Historical COMPLETE_V2 activation artifact has an unrecognized format: ${historicalArtifactPath}`
    )
  }
  if (
    path.resolve(historicalArtifactPath) !== path.resolve(activeArtifactPath)
  ) {
    throw new Error(
      `Historical COMPLETE_V2 activation artifact schema v4 requires audited migration from ${historicalArtifactPath} to ${activeArtifactPath}`
    )
  }
}

export const readActivationArtifact = (
  artifactPath: string
): LoadedActivationArtifact | undefined => {
  assertNoActivationTemporaryArtifacts(artifactPath)
  const lockPaths = [
    durableArtifactWriteLockPath(artifactPath),
    durableArtifactSessionLockPath(artifactPath),
  ]
  const lockPath = lockPaths.find(pathEntryExists)
  if (lockPath !== undefined) {
    throw new Error(
      `COMPLETE_V2 activation artifact is locked; verify no writer is live before manual recovery: ${lockPath}`
    )
  }
  if (!pathEntryExists(artifactPath)) return undefined

  // Inspect only through the private O_NOFOLLOW reader so even deterministic
  // legacy-schema diagnostics do not turn an attacker-controlled link into a
  // trusted artifact.
  const privateFile = readPrivateFileWithHash(artifactPath, {
    requirePrivateDirectory: true,
  })
  const document = JSON.parse(privateFile.contents) as unknown
  rejectUnsupportedActivationSchema(artifactPath, document)

  const loaded = readHashedJsonWithHash<StoredActivationArtifact>(
    artifactPath,
    ACTIVATION_ARTIFACT_KIND,
    { requirePrivateDirectory: true }
  )
  if (!utils.isHexString(loaded.payload.writeNonce, 32)) {
    throw new Error("COMPLETE_V2 activation artifact write nonce is malformed")
  }
  const { artifact } = loaded.payload
  if (
    artifact.schemaVersion !== ACTIVATION_ARTIFACT_SCHEMA ||
    artifact.contentHash !== activationArtifactContentHash(artifact)
  ) {
    throw new Error("COMPLETE_V2 activation artifact content hash mismatch")
  }
  return { artifact, fileContentHash: loaded.fileContentHash }
}

export const persistArtifact = (
  artifactPath: string,
  artifact: CompleteP2TRActivationArtifact,
  options: ActivationArtifactWriteOptions
): string => {
  const hasExpectedHash = options.expectedCurrentContentHash !== undefined
  if (Number(Boolean(options.createOnly)) + Number(hasExpectedHash) !== 1) {
    throw new Error(
      "COMPLETE_V2 activation artifact writes require create-only or an exact expected-prior file hash"
    )
  }
  assertNoActivationTemporaryArtifacts(artifactPath)
  // Retain the schema-v4 inner hash as a corruption diagnostic only. Trust and
  // concurrency control come from the owned private envelope, its exact raw
  // file hash, and fresh on-chain phase readbacks.
  const persistedArtifact = {
    ...artifact,
    contentHash: activationArtifactContentHash(artifact),
  }
  return durableWriteHashedJson(
    artifactPath,
    ACTIVATION_ARTIFACT_KIND,
    {
      writeNonce: utils.hexlify(utils.randomBytes(32)),
      artifact: persistedArtifact,
    } as StoredActivationArtifact,
    {
      ...options,
      requirePrivateDirectory: true,
    }
  )
}

export type RecordedTransactionDisposition = "pending" | "executed"

export async function requireSuccessfulPhaseReceiptReadback(
  phaseID: string,
  receipt: { status?: number },
  exactReadback: () => Promise<boolean>
): Promise<void> {
  if (receipt.status !== 1) {
    throw new Error(`Activation phase ${phaseID} transaction reverted`)
  }
  if (!(await exactReadback())) {
    throw new Error(
      `Activation phase ${phaseID} receipt succeeded but exact readback did not match`
    )
  }
}

const assertRecordedTransactionMatches = (
  phaseID: string,
  transaction: providers.TransactionResponse,
  expected: AuthorityEnvelope
): void => {
  const matches =
    expected.kind === "eoa" &&
    transaction.to !== null &&
    transaction.to.toLowerCase() === expected.inner.target.toLowerCase() &&
    transaction.from.toLowerCase() === expected.authority.toLowerCase() &&
    transaction.data.toLowerCase() === expected.inner.data.toLowerCase() &&
    BigNumber.from(transaction.value).eq(expected.inner.value)
  if (!matches) {
    throw new Error(
      `Recorded transaction for activation phase ${phaseID} does not match the durable call intent`
    )
  }
}

/**
 * Reconcile a durable pending EOA broadcast before any retry. A mined success
 * is accepted only after the phase's exact state predicate holds. A still-live
 * transaction remains pending. An unavailable hash is ambiguous on pruned or
 * lagging RPCs and is deliberately never rebroadcast automatically.
 */
export async function inspectRecordedPhaseTransaction(
  provider: providers.Provider,
  phaseID: string,
  transactionHash: string,
  expected: AuthorityEnvelope,
  exactReadback: () => Promise<boolean>
): Promise<RecordedTransactionDisposition> {
  const [receipt, transaction] = await Promise.all([
    provider.getTransactionReceipt(transactionHash),
    provider.getTransaction(transactionHash),
  ])
  if (!transaction) {
    throw new Error(
      `Recorded transaction for activation phase ${phaseID} is unavailable; manual reconciliation is required before any rebroadcast`
    )
  }
  if (
    !utils.isHexString(transaction.hash, 32) ||
    transaction.hash.toLowerCase() !== transactionHash.toLowerCase()
  ) {
    throw new Error(
      `Recorded transaction for activation phase ${phaseID} returned a different hash`
    )
  }
  assertRecordedTransactionMatches(phaseID, transaction, expected)
  if (receipt) {
    if (
      receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
    ) {
      throw new Error(
        `Recorded receipt for activation phase ${phaseID} returned a different hash`
      )
    }
    await requireSuccessfulPhaseReceiptReadback(phaseID, receipt, exactReadback)
    return "executed"
  }
  return "pending"
}

const func: DeployFunction = async function deployCompleteP2TRActivation(
  hre: HardhatRuntimeEnvironment
) {
  const { deployments, ethers, getNamedAccounts } = hre
  const { deploy, get, getOrNull, getArtifact } = deployments
  const { deployer } = await getNamedAccounts()
  const mode = process.env.COMPLETE_P2TR_ACTIVATION_MODE ?? "prepare"
  if (mode !== "prepare" && mode !== "execute") {
    throw new Error("COMPLETE_P2TR_ACTIVATION_MODE must be prepare or execute")
  }
  const coverageAuthority = process.env.COMPLETE_P2TR_COVERAGE_AUTHORITY
  if (!coverageAuthority || !utils.isAddress(coverageAuthority)) {
    throw new Error("COMPLETE_P2TR_COVERAGE_AUTHORITY is required")
  }

  validateStorageLayout(`${__dirname}/..`)
  const Bridge = await get("Bridge")
  const FrostWalletRegistry = await get("FrostWalletRegistry")
  const BridgeLifecycleRouter = await get("BridgeLifecycleRouter")
  const WalletProposalValidator = await get("WalletProposalValidator")
  const chainId = await hre.getChainId()
  const frostArchiveArtifactPath = process.env.FROST_ARCHIVE_ARTIFACT_PATH
  if (!frostArchiveArtifactPath) {
    throw new Error("FROST_ARCHIVE_ARTIFACT_PATH is required")
  }
  const ecdsaCutoverManifestPath = path.resolve(
    process.env.ECDSA_CUTOVER_MANIFEST ??
      path.join(
        hre.config.paths.deployments,
        hre.network.name,
        "ecdsa-fraud-router-cutover-manifest.json"
      )
  )
  if (!fs.existsSync(ecdsaCutoverManifestPath)) {
    throw new Error(
      `ECDSA cutover manifest not found at ${ecdsaCutoverManifestPath}; run deployment 87 first`
    )
  }
  const loadedEcdsaCutoverManifest = loadCutoverManifest(
    ecdsaCutoverManifestPath
  )
  const ecdsaCutoverDeployments: EcdsaCutoverDeployments = {
    canonicalGovernance: await get("BridgeGovernance"),
    cutoverGovernance: await get("BridgeGovernanceEcdsaFraudCutover"),
    historicalGovernance: await get("BridgeGovernanceBeforeEcdsaCutover"),
    canonicalRouter: await get("EcdsaFraudRouter"),
    cutoverRouter: await get("EcdsaFraudRouterEcdsaCutoverReplacement"),
    historicalRouter: await get("EcdsaFraudRouterBeforeEcdsaCutover"),
  }
  const manifestPath = process.env.COMPLETE_P2TR_COVERAGE_MANIFEST
  if (!manifestPath) {
    throw new Error("COMPLETE_P2TR_COVERAGE_MANIFEST is required")
  }
  const resolvedManifestPath = path.resolve(manifestPath)
  const manifest = JSON.parse(
    fs.readFileSync(resolvedManifestPath, "utf8")
  ) as CoverageManifest
  const authenticatedManifest = await validateManifest(
    hre,
    manifest,
    resolvedManifestPath,
    Bridge.address,
    new utils.Interface(Bridge.abi)
  )
  const inventory = deriveCoverageInventory(authenticatedManifest.inventory)

  const historicalArtifactPath = path.resolve(
    hre.config.paths.deployments,
    hre.network.name,
    "complete-p2tr-activation.json"
  )
  const artifactPath = path.resolve(
    process.env.COMPLETE_P2TR_ACTIVATION_ARTIFACT ??
      path.join(
        hre.config.paths.deployments,
        hre.network.name,
        ".complete-p2tr-activation",
        "complete-p2tr-activation.json"
      )
  )
  assertNoHistoricalActivationArtifact(historicalArtifactPath, artifactPath)
  const loadedPrevious = readActivationArtifact(artifactPath)
  const previous = loadedPrevious?.artifact
  let artifactFileContentHash = loadedPrevious?.fileContentHash

  const frostPrerequisites = await verifyFrostLifecyclePrerequisites({
    provider: ethers.provider,
    chainId,
    networkName: hre.network.name,
    bridge: Bridge.address,
    frostWalletRegistry: FrostWalletRegistry,
    bridgeLifecycleRouter: BridgeLifecycleRouter,
    archiveArtifactPath: frostArchiveArtifactPath,
  })
  if (previous) {
    assertFrostPrerequisiteResumeBinding(
      previous.readbacks.frostPrerequisites,
      frostPrerequisites
    )
  }
  const { lifecycleRouterToInstall, lifecycleOwnerToInstall } =
    resolveFrostLifecycleInstallPlan(frostPrerequisites, previous?.addresses)

  const p2trRouterWord = await ethers.provider.getStorageAt(
    Bridge.address,
    BRIDGE_P2TR_ROUTER_STORAGE_SLOT
  )
  const configuredP2TRRouter = readAddressWord(
    p2trRouterWord,
    "Bridge P2TR router slot"
  )
  const alreadyActivated =
    configuredP2TRRouter !== constants.AddressZero &&
    previous?.addresses.completeRouter?.toLowerCase() ===
      configuredP2TRRouter.toLowerCase()
  if (configuredP2TRRouter !== constants.AddressZero && !alreadyActivated) {
    throw new Error(
      "Bridge P2TR router is already set; refusing one-shot activation"
    )
  }
  const frostRegistryWord = await ethers.provider.getStorageAt(
    Bridge.address,
    BRIDGE_FROST_REGISTRY_STORAGE_SLOT
  )
  const configuredFrostRegistry = readAddressWord(
    frostRegistryWord,
    "Bridge FROST registry slot"
  )
  if (
    configuredFrostRegistry !== constants.AddressZero &&
    configuredFrostRegistry.toLowerCase() !==
      FrostWalletRegistry.address.toLowerCase()
  ) {
    throw new Error("Bridge is bound to a different FROST registry")
  }
  const frostRegistryToInstall =
    previous?.addresses.frostRegistryToInstall ??
    (configuredFrostRegistry === constants.AddressZero
      ? FrostWalletRegistry.address
      : constants.AddressZero)
  if (
    frostRegistryToInstall !== constants.AddressZero &&
    frostRegistryToInstall.toLowerCase() !==
      FrostWalletRegistry.address.toLowerCase()
  ) {
    throw new Error("Resume artifact has an invalid FROST registry plan")
  }
  if (
    previous &&
    configuredFrostRegistry === constants.AddressZero &&
    frostRegistryToInstall === constants.AddressZero
  ) {
    throw new Error(
      "Resume artifact does not install the missing FROST registry"
    )
  }
  if (
    configuredFrostRegistry !== constants.AddressZero &&
    frostRegistryToInstall !== constants.AddressZero &&
    configuredFrostRegistry.toLowerCase() !==
      frostRegistryToInstall.toLowerCase()
  ) {
    throw new Error("Configured FROST registry diverges from resume plan")
  }

  const boundedPredecessor = await getOrNull("P2TRSignatureFraudRouter")
  if (boundedPredecessor) {
    const predecessorOpen = await readUint(
      ethers.provider,
      boundedPredecessor.address,
      legacyRouterInterface,
      "openFraudChallengeCount"
    )
    if (
      !predecessorOpen.isZero() ||
      !(await ethers.provider.getBalance(boundedPredecessor.address)).isZero()
    ) {
      throw new Error("Bounded P2TR predecessor is not empty")
    }
  }

  const deployOptions = {
    from: deployer,
    log: true,
    waitConfirmations: 1,
  }
  const P2TRReservation = await deploy("P2TRReservationCompleteV2", {
    ...deployOptions,
    contract: "P2TRReservation",
  })
  const P2TRPreSigning = await deploy("P2TRPreSigningCompleteV2", {
    ...deployOptions,
    contract: "P2TRPreSigning",
  })
  const reservationLink = {
    P2TRReservation: P2TRReservation.address,
  }
  const Deposit = await deploy("DepositCompleteV2", {
    ...deployOptions,
    contract: "Deposit",
  })
  const DepositSweep = await deploy("DepositSweepCompleteV2", {
    ...deployOptions,
    contract: "DepositSweep",
    libraries: reservationLink,
  })
  const Redemption = await deploy("RedemptionCompleteV2", {
    ...deployOptions,
    contract: "Redemption",
    libraries: reservationLink,
  })
  const Wallets = await deploy("WalletsCompleteV2", {
    ...deployOptions,
    contract: "contracts/bridge/Wallets.sol:Wallets",
    libraries: reservationLink,
  })
  const Fraud = await deploy("FraudCompleteV2", {
    ...deployOptions,
    contract: "Fraud",
  })
  const MovingFunds = await deploy("MovingFundsCompleteV2", {
    ...deployOptions,
    contract: "MovingFunds",
    libraries: reservationLink,
  })
  const bridgeLibraries = {
    Deposit: Deposit.address,
    DepositSweep: DepositSweep.address,
    Redemption: Redemption.address,
    Wallets: Wallets.address,
    Fraud: Fraud.address,
    MovingFunds: MovingFunds.address,
    P2TRPreSigning: P2TRPreSigning.address,
    P2TRReservation: P2TRReservation.address,
  }
  const BridgeImplementation = await deploy("BridgeCompleteV2Implementation", {
    ...deployOptions,
    contract: "Bridge",
    libraries: bridgeLibraries,
    args: [coverageAuthority],
  })
  const Registry = await deploy("P2TRAuthorizationRegistry", {
    ...deployOptions,
    contract: "P2TRAuthorizationRegistry",
    args: [
      Bridge.address,
      FrostWalletRegistry.address,
      WalletProposalValidator.address,
    ],
  })
  const Router = await deploy("CompleteP2TRSignatureFraudRouter", {
    ...deployOptions,
    contract: "CompleteP2TRSignatureFraudRouter",
    args: [Bridge.address, Registry.address],
  })

  const runtimeDeployments: Record<string, Deployment> = {
    P2TRReservation,
    P2TRPreSigning,
    Deposit,
    DepositSweep,
    Redemption,
    Wallets,
    Fraud,
    MovingFunds,
    BridgeImplementation,
    Registry,
    Router,
  }
  const runtimeReceipts: Record<string, RuntimeReceipt> = {}
  runtimeReceipts.FrostWalletRegistryImplementation =
    frostPrerequisites.implementationRuntime
  runtimeReceipts.BridgeLifecycleRouter =
    frostPrerequisites.lifecycleRouterRuntime
  for (const [label, deployment] of Object.entries(runtimeDeployments)) {
    // eslint-disable-next-line no-await-in-loop
    const code = await ethers.provider.getCode(deployment.address)
    runtimeReceipts[label] = assertRuntimeCode(
      label,
      deployment.address,
      code,
      expectedRuntime(deployment, label)
    )
  }

  const actualLinkedLibraries = Object.fromEntries(
    Object.entries(bridgeLibraries).map(([name, address]) => [
      name,
      {
        address: utils.getAddress(address),
        runtimeCodeHash: runtimeReceipts[name].runtimeCodeHash,
      },
    ])
  )
  const expectedLinkedNames = Object.keys(manifest.linkedLibraries).sort()
  const actualLinkedNames = Object.keys(actualLinkedLibraries).sort()
  if (
    JSON.stringify(expectedLinkedNames) !== JSON.stringify(actualLinkedNames)
  ) {
    throw new Error("Coverage manifest linked-library inventory mismatch")
  }
  for (const name of actualLinkedNames) {
    const expected = manifest.linkedLibraries[name]
    const actual = actualLinkedLibraries[name]
    if (
      !utils.isAddress(expected.address) ||
      !utils.isHexString(expected.runtimeCodeHash, 32) ||
      expected.address.toLowerCase() !== actual.address.toLowerCase() ||
      expected.runtimeCodeHash.toLowerCase() !==
        actual.runtimeCodeHash.toLowerCase()
    ) {
      throw new Error(`Coverage manifest linked-library mismatch: ${name}`)
    }
  }
  const bridgeArtifact = (await getArtifact("Bridge")) as unknown as {
    deployedLinkReferences: DeployedLinkReferences
  }
  assertExactBridgeLinkMap(
    expectedRuntime(BridgeImplementation, "BridgeImplementation"),
    bridgeArtifact.deployedLinkReferences,
    actualLinkedLibraries
  )
  const librariesCommitment = linkedLibrariesCommitment(actualLinkedLibraries)
  const sourceCheckpoints = orderedSourceCheckpoints(
    manifest,
    authenticatedManifest
  )
  const checkpointCommitment = dualSourceCheckpointCommitment(
    manifest,
    authenticatedManifest
  )
  const snapshotImplementation = readAddressWord(
    await ethers.provider.getStorageAt(
      Bridge.address,
      EIP_1967_IMPLEMENTATION_SLOT,
      manifest.snapshotBlockNumber
    ),
    "Bridge implementation at authenticated snapshot"
  )
  const snapshotUsesCompleteImplementation =
    snapshotImplementation.toLowerCase() ===
    BridgeImplementation.address.toLowerCase()

  const coverageAuthorization = {
    inventoryRoot: inventory.root,
    inventoryCount: inventory.count,
    historyStartBlock: manifest.historyStartBlockNumber,
    snapshotBlock: manifest.snapshotBlockNumber,
    snapshotBlockHash: manifest.snapshotBlockHash,
    sourceIdentity1: sourceCheckpoints[0].identity,
    sourceSigner1: sourceCheckpoints[0].signer,
    sourceCheckpointDigest1: sourceCheckpoints[0].digest,
    sourceIdentity2: sourceCheckpoints[1].identity,
    sourceSigner2: sourceCheckpoints[1].signer,
    sourceCheckpointDigest2: sourceCheckpoints[1].digest,
    sourceCheckpointCommitment: checkpointCommitment,
    linkedLibrariesCommitment: librariesCommitment,
    implementation: BridgeImplementation.address,
    implementationCodeHash:
      runtimeReceipts.BridgeImplementation.runtimeCodeHash,
    authorizationRegistry: Registry.address,
    authorizationRegistryCodeHash: runtimeReceipts.Registry.runtimeCodeHash,
    fraudRouter: Router.address,
    fraudRouterCodeHash: runtimeReceipts.Router.runtimeCodeHash,
  }
  const coverageHistoryCommitment = utils.keccak256(
    utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "uint64",
        "uint64",
        "uint64",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      [
        coverageAuthorization.inventoryRoot,
        coverageAuthorization.inventoryCount,
        coverageAuthorization.historyStartBlock,
        coverageAuthorization.snapshotBlock,
        coverageAuthorization.snapshotBlockHash,
        coverageAuthorization.sourceCheckpointCommitment,
        coverageAuthorization.linkedLibrariesCommitment,
      ]
    )
  )
  const coverageCodeCommitment = utils.keccak256(
    utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "address",
        "bytes32",
        "address",
        "bytes32",
        "address",
        "bytes32",
      ],
      [
        coverageAuthorization.linkedLibrariesCommitment,
        coverageAuthorization.implementation,
        coverageAuthorization.implementationCodeHash,
        coverageAuthorization.authorizationRegistry,
        coverageAuthorization.authorizationRegistryCodeHash,
        coverageAuthorization.fraudRouter,
        coverageAuthorization.fraudRouterCodeHash,
      ]
    )
  )
  const coverageAuthorizationDigest = utils.keccak256(
    utils.defaultAbiCoder.encode(
      ["string", "uint256", "address", "address", "bytes32", "bytes32"],
      [
        COVERAGE_AUTHORIZATION_DOMAIN,
        chainId,
        Bridge.address,
        coverageAuthority,
        coverageHistoryCommitment,
        coverageCodeCommitment,
      ]
    )
  )
  if (
    !utils.isHexString(manifest.coverageAuthorizationSignature) ||
    manifest.coverageAuthorizationSignature === "0x"
  ) {
    throw new Error("Coverage authorization signature is required")
  }
  await verifyIndependentSignature(
    ethers.provider,
    coverageAuthority,
    coverageAuthorizationDigest,
    manifest.coverageAuthorizationSignature
  )
  inventory.initializationPayload = utils.defaultAbiCoder.encode(
    ["uint8", COVERAGE_AUTHORIZATION_TUPLE, "bytes", "bytes", "bytes"],
    [
      0,
      coverageAuthorization,
      sourceCheckpoints[0].signature,
      sourceCheckpoints[1].signature,
      manifest.coverageAuthorizationSignature,
    ]
  )
  const routerReadbacks = {
    bridge: await readAddress(
      ethers.provider,
      Router.address,
      routerInterface,
      "bridge"
    ),
    registry: await readAddress(
      ethers.provider,
      Router.address,
      routerInterface,
      "authorizationRegistry"
    ),
    chainId: (
      await readUint(
        ethers.provider,
        Router.address,
        routerInterface,
        "domainChainID"
      )
    ).toString(),
    evidenceProtocolID: (
      await callResult(
        ethers.provider,
        Router.address,
        routerInterface,
        "evidenceProtocolID"
      )
    )[0] as string,
    reservationProtocolID: (
      await callResult(
        ethers.provider,
        Router.address,
        routerInterface,
        "preauthorizationProtocolID"
      )
    )[0] as string,
    signingPolicyHash: (
      await callResult(
        ethers.provider,
        Router.address,
        routerInterface,
        "signingPolicyHash"
      )
    )[0] as string,
  }
  const registryReadbacks = {
    bridge: await readAddress(
      ethers.provider,
      Registry.address,
      registryInterface,
      "bridge"
    ),
    frostRegistry: await readAddress(
      ethers.provider,
      Registry.address,
      registryInterface,
      "frostRegistry"
    ),
    proposalValidator: await readAddress(
      ethers.provider,
      Registry.address,
      registryInterface,
      "proposalValidator"
    ),
    chainId: (
      await readUint(
        ethers.provider,
        Registry.address,
        registryInterface,
        "domainChainID"
      )
    ).toString(),
    groupThreshold: (
      await readUint(
        ethers.provider,
        Registry.address,
        registryInterface,
        "groupThreshold"
      )
    ).toString(),
    maximumGroupSize: (
      await readUint(
        ethers.provider,
        Registry.address,
        registryInterface,
        "maximumGroupSize"
      )
    ).toString(),
  }
  if (
    routerReadbacks.bridge.toLowerCase() !== Bridge.address.toLowerCase() ||
    routerReadbacks.registry.toLowerCase() !== Registry.address.toLowerCase() ||
    routerReadbacks.chainId !== chainId ||
    routerReadbacks.evidenceProtocolID !== COMPLETE_V2_PROTOCOL_ID ||
    routerReadbacks.reservationProtocolID !== RESERVATION_PROTOCOL_ID ||
    routerReadbacks.signingPolicyHash !== SIGNING_POLICY_HASH ||
    registryReadbacks.bridge.toLowerCase() !== Bridge.address.toLowerCase() ||
    registryReadbacks.frostRegistry.toLowerCase() !==
      FrostWalletRegistry.address.toLowerCase() ||
    registryReadbacks.proposalValidator.toLowerCase() !==
      WalletProposalValidator.address.toLowerCase() ||
    registryReadbacks.chainId !== chainId ||
    registryReadbacks.groupThreshold !== "51" ||
    registryReadbacks.maximumGroupSize !== "100"
  ) {
    throw new Error(
      "COMPLETE_V2 immutable/crosslink/protocol handshake mismatch"
    )
  }
  if (!alreadyActivated) {
    await requireZeroAccounting(
      ethers.provider,
      Router.address,
      Registry.address
    )
  }

  const configuredAccounts = await ethers.provider.listAccounts()
  const adminWord = await ethers.provider.getStorageAt(
    Bridge.address,
    EIP_1967_ADMIN_SLOT
  )
  const proxyAdmin = readAddressWord(adminWord, "Bridge EIP-1967 admin")
  const proxyAuthority = await readAddress(
    ethers.provider,
    proxyAdmin,
    proxyAdminInterface,
    "owner"
  )
  const proxyContractKind = process.env.COMPLETE_P2TR_PROXY_AUTHORITY_KIND as
    | "safe"
    | "timelock"
    | undefined
  const proxyAuthorityKind = await classifyAuthority(
    ethers.provider,
    proxyAuthority,
    configuredAccounts,
    proxyContractKind
  )
  const proxyTimelockDelay =
    proxyAuthorityKind === "timelock"
      ? (
          await readUint(
            ethers.provider,
            proxyAuthority,
            timelockInterface,
            "getMinDelay"
          )
        ).toString()
      : "0"

  const prePhaseImplementation = readAddressWord(
    await ethers.provider.getStorageAt(
      Bridge.address,
      EIP_1967_IMPLEMENTATION_SLOT
    ),
    "Bridge EIP-1967 implementation"
  )
  const unionImplementationInstalled = sameAddress(
    prePhaseImplementation,
    BridgeImplementation.address
  )
  if (!previous && unionImplementationInstalled) {
    throw new Error(
      "Union Bridge implementation was installed outside a step-88 activation artifact"
    )
  }
  const bridgePredecessorImplementation =
    previous?.bridgePredecessorImplementation ?? prePhaseImplementation
  const bridgePredecessorCode = await ethers.provider.getCode(
    bridgePredecessorImplementation
  )
  if (bridgePredecessorCode === "0x") {
    throw new Error("Bridge union predecessor implementation has no code")
  }
  const bridgePredecessorImplementationCodeHash = utils.keccak256(
    bridgePredecessorCode
  )
  if (
    previous &&
    previous.bridgePredecessorImplementationCodeHash !==
      bridgePredecessorImplementationCodeHash
  ) {
    throw new Error("Bridge union predecessor code hash changed during resume")
  }
  if (
    !sameAddress(prePhaseImplementation, bridgePredecessorImplementation) &&
    !unionImplementationInstalled
  ) {
    throw new Error("Bridge implementation is outside the union-only ancestry")
  }
  if (
    previous?.addresses.bridgeImplementation &&
    !sameAddress(
      previous.addresses.bridgeImplementation,
      BridgeImplementation.address
    )
  ) {
    throw new Error("Resume artifact names another union Bridge implementation")
  }

  const ecdsaCutover = await validateEcdsaCutoverBinding(
    ethers.provider,
    loadedEcdsaCutoverManifest.value,
    ecdsaCutoverManifestPath,
    loadedEcdsaCutoverManifest.fileContentHash,
    chainId,
    Bridge.address,
    ecdsaCutoverDeployments,
    unionImplementationInstalled
  )
  if (previous) {
    if (!previous.ecdsaCutover) {
      throw new Error("Resume artifact lacks the step-87 ECDSA cutover binding")
    }
    assertEcdsaCutoverResume(previous.ecdsaCutover, ecdsaCutover)
    if (
      !sameAddress(
        previous.bridgePredecessorImplementation,
        bridgePredecessorImplementation
      )
    ) {
      throw new Error("Bridge union predecessor changed during resume")
    }
  }

  const liveGovernance = await readAddress(
    ethers.provider,
    Bridge.address,
    bridgeInterface,
    "governance"
  )
  if (
    !sameAddress(liveGovernance, ecdsaCutover.oldGovernance) &&
    !sameAddress(liveGovernance, ecdsaCutover.governance)
  ) {
    throw new Error("Bridge governance is outside the step-87 cutover")
  }
  const currentGovernance = ecdsaCutover.governance
  const governanceAuthority = ecdsaCutover.governanceOwner
  const activationTarget = ecdsaCutover.governance

  let governanceAuthorityKind: AuthorityKind = "eoa"
  let governanceTimelockDelay = "0"
  if (ecdsaCutover.finalized) {
    const governanceContractKind = process.env
      .COMPLETE_P2TR_GOVERNANCE_AUTHORITY_KIND as
      | "safe"
      | "timelock"
      | undefined
    governanceAuthorityKind = await classifyAuthority(
      ethers.provider,
      governanceAuthority,
      configuredAccounts,
      governanceContractKind
    )
    governanceTimelockDelay =
      governanceAuthorityKind === "timelock"
        ? (
            await readUint(
              ethers.provider,
              governanceAuthority,
              timelockInterface,
              "getMinDelay"
            )
          ).toString()
        : "0"
  }
  const frostGovernanceAuthority = frostPrerequisites.registryGovernance
  let frostGovernanceAuthorityKind: AuthorityKind = "eoa"
  let frostGovernanceTimelockDelay = "0"
  if (ecdsaCutover.finalized) {
    if (sameHex(frostGovernanceAuthority, governanceAuthority)) {
      frostGovernanceAuthorityKind = governanceAuthorityKind
      frostGovernanceTimelockDelay = governanceTimelockDelay
    } else {
      frostGovernanceAuthorityKind = await classifyAuthority(
        ethers.provider,
        frostGovernanceAuthority,
        configuredAccounts,
        process.env.COMPLETE_P2TR_FROST_GOVERNANCE_AUTHORITY_KIND as
          | "safe"
          | "timelock"
          | undefined
      )
      if (frostGovernanceAuthorityKind === "timelock") {
        frostGovernanceTimelockDelay = (
          await readUint(
            ethers.provider,
            frostGovernanceAuthority,
            timelockInterface,
            "getMinDelay"
          )
        ).toString()
      }
    }
  }

  const forbiddenCheckpointAuthorities = new Set(
    [
      Bridge.address,
      coverageAuthority,
      proxyAuthority,
      governanceAuthority,
      ecdsaCutover.oldGovernance,
      currentGovernance,
      frostGovernanceAuthority,
    ].map((address) => address.toLowerCase())
  )
  if (
    coverageAuthority.toLowerCase() === governanceAuthority.toLowerCase() ||
    coverageAuthority.toLowerCase() === proxyAuthority.toLowerCase() ||
    authenticatedManifest.signers.some((signer) =>
      forbiddenCheckpointAuthorities.has(signer.toLowerCase())
    )
  ) {
    throw new Error(
      "Coverage and rebuild authorities are not independent of deployment governance"
    )
  }

  const makeCall = (
    id: string,
    target: string,
    data: string,
    description: string
  ): PreparedCall => ({ id, target, value: "0", data, description })
  const envelope = (
    call: PreparedCall,
    authority: string,
    kind: AuthorityKind,
    phase: string,
    delay: string
  ) =>
    buildAuthorityEnvelope(call, authority, kind, {
      chainId,
      bridge: Bridge.address,
      phase,
      delay,
    })

  const candidatePhases: ActivationPhase[] = []
  let canonicalLifecycleInstallCalls: PreparedCall[] = []
  const appendFrostLifecycleInstallPhase = (
    prerequisite: string,
    bridgeSetterTarget: string,
    bridgeSetterInterface: utils.Interface
  ): string => {
    if (
      lifecycleRouterToInstall === constants.AddressZero &&
      lifecycleOwnerToInstall === constants.AddressZero
    ) {
      return prerequisite
    }
    const bridgeRouterCall =
      lifecycleRouterToInstall === constants.AddressZero
        ? undefined
        : makeCall(
            "install-bridge-lifecycle-router",
            bridgeSetterTarget,
            bridgeSetterInterface.encodeFunctionData("setLifecycleRouter", [
              lifecycleRouterToInstall,
            ]),
            "Install the immutable BridgeLifecycleRouter binding on Bridge"
          )
    const registryOwnerCall =
      lifecycleOwnerToInstall === constants.AddressZero
        ? undefined
        : makeCall(
            "install-registry-lifecycle-owner",
            FrostWalletRegistry.address,
            frostWalletRegistryInterface.encodeFunctionData(
              "updateLifecycleOwner",
              [lifecycleOwnerToInstall]
            ),
            "Bind FrostWalletRegistry lifecycle ownership to BridgeLifecycleRouter"
          )
    canonicalLifecycleInstallCalls = [
      bridgeRouterCall,
      registryOwnerCall,
    ].filter((call): call is PreparedCall => call !== undefined)
    const calls: AuthorityEnvelope[] = []
    if (
      bridgeRouterCall &&
      frostPrerequisites.configuredBridgeLifecycleRouter ===
        constants.AddressZero
    ) {
      calls.push(
        envelope(
          bridgeRouterCall,
          governanceAuthority,
          governanceAuthorityKind,
          "install-frost-lifecycle",
          governanceTimelockDelay
        )
      )
    }
    if (
      registryOwnerCall &&
      frostPrerequisites.registryLifecycleOwner === constants.AddressZero
    ) {
      calls.push(
        envelope(
          registryOwnerCall,
          frostGovernanceAuthority,
          frostGovernanceAuthorityKind,
          "install-frost-lifecycle",
          frostGovernanceTimelockDelay
        )
      )
    }
    candidatePhases.push({
      id: "install-frost-lifecycle",
      status: "prepared",
      prerequisite,
      calls,
      transactionHashes: [],
      readback: {
        bridgeLifecycleRouter:
          frostPrerequisites.configuredBridgeLifecycleRouter,
        registryLifecycleOwner: frostPrerequisites.registryLifecycleOwner,
      },
    })
    return "install-frost-lifecycle"
  }

  const migrationCursor = previous?.inventory.migrationCursor ?? 0
  const nextCoverageBatch = await buildNextCoverageBatch(
    ethers.provider,
    Bridge.address,
    inventory.entries,
    migrationCursor,
    prePhaseImplementation.toLowerCase() ===
      BridgeImplementation.address.toLowerCase()
  )
  const migrationAuthority = process.env.COMPLETE_P2TR_MIGRATOR ?? deployer
  if (!utils.isAddress(migrationAuthority)) {
    throw new Error("COMPLETE_P2TR_MIGRATOR is not an address")
  }
  const migrationCalls = nextCoverageBatch.completed
    ? []
    : [
        envelope(
          makeCall(
            "migrate-coverage:next-batch",
            Bridge.address,
            bridgeInterface.encodeFunctionData(
              "processTaprootOutputKeyCoverage",
              [nextCoverageBatch.payload]
            ),
            `Permissionlessly migrate coverage leaves ${nextCoverageBatch.indices.join(
              ","
            )}`
          ),
          migrationAuthority,
          "eoa",
          "migrate-coverage",
          "0"
        ),
      ]
  const upgradeCall = makeCall(
    "upgrade-bridge",
    proxyAdmin,
    proxyAdminInterface.encodeFunctionData("upgrade", [
      Bridge.address,
      BridgeImplementation.address,
    ]),
    "Upgrade Bridge proxy to the COMPLETE_V2-linked implementation"
  )
  candidatePhases.push({
    id: "upgrade-bridge",
    status: "prepared",
    calls: [
      envelope(
        upgradeCall,
        proxyAuthority,
        proxyAuthorityKind,
        "upgrade-bridge",
        proxyTimelockDelay
      ),
    ],
    transactionHashes: [],
  })

  // Step 88 owns only the union implementation upgrade until step 87 has
  // finalized its signed governance/router migration. This prevents a second
  // governance handoff or a competing empty ECDSA router from bypassing the
  // authoritative migrated liabilities.
  if (ecdsaCutover.finalized) {
    let prerequisite = "upgrade-bridge"
    if (frostRegistryToInstall !== constants.AddressZero) {
      const setFrostRegistry = makeCall(
        "install-frost-registry",
        activationTarget,
        bridgeGovernanceInterface.encodeFunctionData("setFrostWalletRegistry", [
          FrostWalletRegistry.address,
        ]),
        "Install the immutable FROST wallet registry binding"
      )
      candidatePhases.push({
        id: "install-frost-registry",
        status: "prepared",
        prerequisite,
        calls: [
          envelope(
            setFrostRegistry,
            governanceAuthority,
            governanceAuthorityKind,
            "install-frost-registry",
            governanceTimelockDelay
          ),
        ],
        transactionHashes: [],
      })
      prerequisite = "install-frost-registry"
    }
    prerequisite = appendFrostLifecycleInstallPhase(
      prerequisite,
      activationTarget,
      bridgeGovernanceInterface
    )
    const initializeCall = makeCall(
      "initialize-coverage",
      activationTarget,
      bridgeGovernanceInterface.encodeFunctionData(
        "processTaprootOutputKeyCoverage",
        [inventory.initializationPayload]
      ),
      "Install the signed dual-source coverage checkpoint without activating FROST"
    )
    candidatePhases.push({
      id: "initialize-coverage",
      status: "prepared",
      prerequisite,
      calls: [
        envelope(
          initializeCall,
          governanceAuthority,
          governanceAuthorityKind,
          "initialize-coverage",
          governanceTimelockDelay
        ),
      ],
      transactionHashes: [],
    })
    candidatePhases.push({
      id: "migrate-coverage",
      status: "prepared",
      prerequisite: "initialize-coverage",
      calls: migrationCalls,
      transactionHashes: [],
      readback: {
        cursor: migrationCursor,
        nextCursor: nextCoverageBatch.cursor,
        indices: nextCoverageBatch.indices,
      },
    })
    const activateCall = makeCall(
      "activate-complete-p2tr",
      activationTarget,
      bridgeGovernanceInterface.encodeFunctionData(
        "processTaprootOutputKeyCoverage",
        [
          utils.defaultAbiCoder.encode(
            ["uint8", "address"],
            [8, Router.address]
          ),
        ]
      ),
      "Activate COMPLETE_V2 after exact coverage completion"
    )
    candidatePhases.push({
      id: "activate-complete-p2tr",
      status: "prepared",
      prerequisite: "migrate-coverage",
      calls: [
        envelope(
          activateCall,
          governanceAuthority,
          governanceAuthorityKind,
          "activate-complete-p2tr",
          governanceTimelockDelay
        ),
      ],
      transactionHashes: [],
    })
  }

  const planPhaseCalls = (
    id: string,
    calls: AuthorityEnvelope[]
  ): unknown[] => {
    if (id === "migrate-coverage") {
      return [{ maximumBatchSize: MAXIMUM_COVERAGE_BATCH_SIZE }]
    }
    if (id === "install-frost-lifecycle") {
      return canonicalLifecycleInstallCalls
    }
    return calls.map(({ inner }) => inner)
  }

  const structuralPlanID = utils.keccak256(
    utils.toUtf8Bytes(
      canonicalJSON({
        schema: ACTIVATION_ARTIFACT_SCHEMA,
        chainId,
        bridge: Bridge.address.toLowerCase(),
        inventoryRoot: inventory.root,
        inventoryCount: inventory.count,
        historyStartBlock: manifest.historyStartBlockNumber,
        snapshotBlock: manifest.snapshotBlockNumber,
        snapshotBlockHash: manifest.snapshotBlockHash,
        sourceCheckpointCommitment: checkpointCommitment,
        linkedLibrariesCommitment: librariesCommitment,
        coverageAuthorizationDigest,
        bridgePredecessorImplementation:
          bridgePredecessorImplementation.toLowerCase(),
        bridgePredecessorImplementationCodeHash,
        ecdsaStructuralPlanHash: ecdsaCutover.structuralPlanHash,
        frostPrerequisites:
          immutableFrostPrerequisiteBinding(frostPrerequisites),
        addresses: {
          bridgeImplementation: BridgeImplementation.address.toLowerCase(),
          frostWalletRegistryImplementation:
            frostPrerequisites.archive.implementation.toLowerCase(),
          bridgeLifecycleRouter: BridgeLifecycleRouter.address.toLowerCase(),
          lifecycleRouterToInstall: lifecycleRouterToInstall.toLowerCase(),
          lifecycleOwnerToInstall: lifecycleOwnerToInstall.toLowerCase(),
          registry: Registry.address.toLowerCase(),
          router: Router.address.toLowerCase(),
          governance: ecdsaCutover.governance.toLowerCase(),
          ecdsaRouter: ecdsaCutover.router.toLowerCase(),
        },
      })
    )
  )
  const planID = utils.keccak256(
    utils.toUtf8Bytes(
      canonicalJSON({
        schema: ACTIVATION_ARTIFACT_SCHEMA,
        chainId,
        bridge: Bridge.address.toLowerCase(),
        inventoryRoot: inventory.root,
        inventoryCount: inventory.count,
        historyStartBlock: manifest.historyStartBlockNumber,
        snapshotBlock: manifest.snapshotBlockNumber,
        snapshotBlockHash: manifest.snapshotBlockHash,
        sourceCheckpointCommitment: checkpointCommitment,
        linkedLibrariesCommitment: librariesCommitment,
        coverageAuthorizationDigest,
        frostPrerequisites:
          immutableFrostPrerequisiteBinding(frostPrerequisites),
        bridgePredecessorImplementation:
          bridgePredecessorImplementation.toLowerCase(),
        bridgePredecessorImplementationCodeHash,
        ecdsaCutover: {
          manifestArtifactHash: ecdsaCutover.manifestArtifactHash,
          manifestPlanHash: ecdsaCutover.manifestPlanHash,
          structuralPlanHash: ecdsaCutover.structuralPlanHash,
          finalized: ecdsaCutover.finalized,
          evidenceGeneration: ecdsaCutover.evidenceGeneration,
          evidenceAnchorArtifactHash: ecdsaCutover.evidenceAnchorArtifactHash,
          evidencePredecessorArtifactHash:
            ecdsaCutover.evidencePredecessorArtifactHash,
          authorizationTransactionHash:
            ecdsaCutover.authorizationTransactionHash,
          authorizationPlanHash: ecdsaCutover.authorizationPlanHash,
          chainId: ecdsaCutover.chainId,
          bridge: ecdsaCutover.bridge.toLowerCase(),
          oldGovernance: ecdsaCutover.oldGovernance.toLowerCase(),
          oldGovernanceCodeHash: ecdsaCutover.oldGovernanceCodeHash,
          governance: ecdsaCutover.governance.toLowerCase(),
          governanceCodeHash: ecdsaCutover.governanceCodeHash,
          governanceOwner: ecdsaCutover.governanceOwner.toLowerCase(),
          governanceDelay: ecdsaCutover.governanceDelay,
          oldGovernanceTransferInitiatedAt:
            ecdsaCutover.oldGovernanceTransferInitiatedAt,
          oldGovernancePendingTarget:
            ecdsaCutover.oldGovernancePendingTarget.toLowerCase(),
          oldGovernanceTransferNotBefore:
            ecdsaCutover.oldGovernanceTransferNotBefore,
          oldRouter: ecdsaCutover.oldRouter.toLowerCase(),
          oldRouterCodeHash: ecdsaCutover.oldRouterCodeHash,
          router: ecdsaCutover.router.toLowerCase(),
          routerCodeHash: ecdsaCutover.routerCodeHash,
          protocolID: ecdsaCutover.protocolID,
          predecessor: ecdsaCutover.predecessor.toLowerCase(),
          predecessorCodeHash: ecdsaCutover.predecessorCodeHash,
          ancestryDepth: ecdsaCutover.ancestryDepth,
          sourceSigner: ecdsaCutover.sourceSigner.toLowerCase(),
          sourceID: ecdsaCutover.sourceID,
          sourceStoreIdentity: ecdsaCutover.sourceStoreIdentity,
          sourceEndpointIdentity: ecdsaCutover.sourceEndpointIdentity,
          sourceTrustDomain: ecdsaCutover.sourceTrustDomain,
          sourcePolicyHash: ecdsaCutover.sourcePolicyHash,
          reconciler: ecdsaCutover.reconciler.toLowerCase(),
          reconcilerSourceID: ecdsaCutover.reconcilerSourceID,
          reconcilerStoreIdentity: ecdsaCutover.reconcilerStoreIdentity,
          reconcilerEndpointIdentity: ecdsaCutover.reconcilerEndpointIdentity,
          reconcilerTrustDomain: ecdsaCutover.reconcilerTrustDomain,
          reconcilerPolicyHash: ecdsaCutover.reconcilerPolicyHash,
        },
        addresses: {
          bridgeImplementation: BridgeImplementation.address.toLowerCase(),
          frostWalletRegistryImplementation:
            frostPrerequisites.archive.implementation.toLowerCase(),
          bridgeLifecycleRouter: BridgeLifecycleRouter.address.toLowerCase(),
          lifecycleRouterToInstall: lifecycleRouterToInstall.toLowerCase(),
          lifecycleOwnerToInstall: lifecycleOwnerToInstall.toLowerCase(),
          registry: Registry.address.toLowerCase(),
          router: Router.address.toLowerCase(),
          governance: ecdsaCutover.governance.toLowerCase(),
          ecdsaRouter: ecdsaCutover.router.toLowerCase(),
        },
        calls: candidatePhases.map(({ id, calls }) => ({
          id,
          calls: planPhaseCalls(id, calls),
        })),
      })
    )
  )
  if (previous && previous.planID !== planID) {
    const previousInitialization = previous.phases.find(
      ({ id }) => id === "initialize-coverage"
    )
    if (
      previous.structuralPlanID !== structuralPlanID ||
      (previousInitialization && previousInitialization.status !== "prepared")
    ) {
      throw new Error(
        "Existing COMPLETE_V2 activation artifact belongs to a different plan"
      )
    }
  }

  const implementationWord = await ethers.provider.getStorageAt(
    Bridge.address,
    EIP_1967_IMPLEMENTATION_SLOT
  )
  const installedImplementation = readAddressWord(
    implementationWord,
    "Bridge EIP-1967 implementation"
  )
  const currentGovernanceReadback = await readAddress(
    ethers.provider,
    Bridge.address,
    bridgeInterface,
    "governance"
  )

  let activeRouter = readAddressWord(
    await ethers.provider.getStorageAt(
      Bridge.address,
      BRIDGE_P2TR_ROUTER_STORAGE_SLOT
    ),
    "Bridge P2TR router slot"
  )
  let activeEcdsaRouter = readAddressWord(
    await ethers.provider.getStorageAt(
      Bridge.address,
      BRIDGE_ECDSA_ROUTER_STORAGE_SLOT
    ),
    "Bridge ECDSA router slot"
  )
  let coverageReadback: Awaited<ReturnType<typeof readCoverage>> | undefined
  if (
    installedImplementation.toLowerCase() ===
      BridgeImplementation.address.toLowerCase() ||
    alreadyActivated
  ) {
    coverageReadback = await readCoverage(
      ethers.provider,
      Bridge.address,
      inventory.entries
    )
  }
  const sourceCheckpointReadbacks = sourceCheckpoints.map((checkpoint) =>
    utils.keccak256(
      utils.defaultAbiCoder.encode(
        ["bytes32", "address", "bytes32"],
        [checkpoint.identity, checkpoint.signer, checkpoint.digest]
      )
    )
  )
  const coverageMatchesAuthorization = (
    observed: Awaited<ReturnType<typeof readCoverage>>
  ): boolean =>
    observed.initialized === true &&
    observed.root.toLowerCase() === inventory.root.toLowerCase() &&
    observed.count === inventory.count.toString() &&
    observed.authorization.authority.toLowerCase() ===
      coverageAuthority.toLowerCase() &&
    observed.authorization.digest.toLowerCase() ===
      coverageAuthorizationDigest.toLowerCase() &&
    observed.authorization.router.toLowerCase() ===
      Router.address.toLowerCase() &&
    observed.authorization.historyStartBlock ===
      manifest.historyStartBlockNumber.toString() &&
    observed.authorization.snapshotBlock ===
      manifest.snapshotBlockNumber.toString() &&
    observed.authorization.snapshotBlockHash.toLowerCase() ===
      manifest.snapshotBlockHash.toLowerCase() &&
    observed.authorization.sourceCheckpointCommitment.toLowerCase() ===
      checkpointCommitment.toLowerCase() &&
    observed.authorization.sourceCheckpoint1.toLowerCase() ===
      sourceCheckpointReadbacks[0].toLowerCase() &&
    observed.authorization.sourceCheckpoint2.toLowerCase() ===
      sourceCheckpointReadbacks[1].toLowerCase() &&
    observed.authorization.linkedLibrariesCommitment.toLowerCase() ===
      librariesCommitment.toLowerCase()

  const coverageIsComplete = (
    observed: Awaited<ReturnType<typeof readCoverage>>
  ): boolean =>
    coverageMatchesAuthorization(observed) &&
    observed.migratedCount === inventory.count.toString() &&
    coverageEntriesMatchReadback(observed, inventory.entries)

  const coverageBatchAppliedExactly = async (
    indices: number[]
  ): Promise<boolean> => {
    const batchEntries = indices.map((index) => inventory.entries[index])
    if (
      indices.length === 0 ||
      batchEntries.some((entry) => entry === undefined)
    ) {
      return false
    }
    const observed = await readCoverage(
      ethers.provider,
      Bridge.address,
      batchEntries
    )
    return (
      coverageMatchesAuthorization(observed) &&
      coverageEntriesMatchReadback(observed, batchEntries)
    )
  }

  const frostLifecycleInstalledExactly = async (): Promise<boolean> => {
    const [registryWord, lifecycleWord, lifecycleOwner] = await Promise.all([
      ethers.provider.getStorageAt(
        Bridge.address,
        BRIDGE_FROST_REGISTRY_STORAGE_SLOT
      ),
      ethers.provider.getStorageAt(
        Bridge.address,
        BRIDGE_LIFECYCLE_ROUTER_STORAGE_SLOT
      ),
      readAddress(
        ethers.provider,
        FrostWalletRegistry.address,
        frostWalletRegistryInterface,
        "lifecycleOwner"
      ),
    ])
    return (
      sameHex(
        readAddressWord(registryWord, "Bridge FROST registry slot"),
        FrostWalletRegistry.address
      ) &&
      sameHex(
        readAddressWord(lifecycleWord, "Bridge lifecycle router slot"),
        BridgeLifecycleRouter.address
      ) &&
      sameHex(lifecycleOwner, BridgeLifecycleRouter.address)
    )
  }

  const observePhaseExactly = async (
    candidate: ActivationPhase
  ): Promise<boolean> => {
    if (candidate.id === "upgrade-bridge") {
      const implementation = readAddressWord(
        await ethers.provider.getStorageAt(
          Bridge.address,
          EIP_1967_IMPLEMENTATION_SLOT
        ),
        "Bridge EIP-1967 implementation"
      )
      return sameHex(implementation, BridgeImplementation.address)
    }
    if (candidate.id === "install-frost-registry") {
      const registry = readAddressWord(
        await ethers.provider.getStorageAt(
          Bridge.address,
          BRIDGE_FROST_REGISTRY_STORAGE_SLOT
        ),
        "Bridge FROST registry slot"
      )
      return sameHex(registry, FrostWalletRegistry.address)
    }
    if (candidate.id === "install-frost-lifecycle") {
      return frostLifecycleInstalledExactly()
    }
    if (
      candidate.id === "initialize-coverage" ||
      candidate.id === "migrate-coverage"
    ) {
      const implementation = readAddressWord(
        await ethers.provider.getStorageAt(
          Bridge.address,
          EIP_1967_IMPLEMENTATION_SLOT
        ),
        "Bridge EIP-1967 implementation"
      )
      if (!sameHex(implementation, BridgeImplementation.address)) return false
      const observed = await readCoverage(
        ethers.provider,
        Bridge.address,
        candidate.id === "initialize-coverage" ? [] : inventory.entries
      )
      return candidate.id === "initialize-coverage"
        ? coverageMatchesAuthorization(observed)
        : coverageIsComplete(observed)
    }
    if (candidate.id === "activate-complete-p2tr") {
      const [routerWord, ecdsaRouter, governance, lifecycleInstalled] =
        await Promise.all([
          ethers.provider.getStorageAt(
            Bridge.address,
            BRIDGE_P2TR_ROUTER_STORAGE_SLOT
          ),
          readAddress(
            ethers.provider,
            Bridge.address,
            bridgeInterface,
            "ecdsaFraudRouter"
          ),
          readAddress(
            ethers.provider,
            Bridge.address,
            bridgeInterface,
            "governance"
          ),
          frostLifecycleInstalledExactly(),
        ])
      if (
        !sameHex(
          readAddressWord(routerWord, "Bridge P2TR router slot"),
          Router.address
        ) ||
        !sameHex(ecdsaRouter, ecdsaCutover.router) ||
        !sameHex(governance, ecdsaCutover.governance) ||
        !lifecycleInstalled
      ) {
        return false
      }
      const observed = await readCoverage(
        ethers.provider,
        Bridge.address,
        inventory.entries
      )
      return coverageIsComplete(observed)
    }
    throw new Error(`Unknown COMPLETE_V2 activation phase ${candidate.id}`)
  }

  const observeCallExactly = async (
    phase: ActivationPhase,
    call: AuthorityEnvelope
  ): Promise<boolean> => {
    if (phase.id !== "install-frost-lifecycle") {
      return observePhaseExactly(phase)
    }
    if (call.inner.id === "install-bridge-lifecycle-router") {
      const router = readAddressWord(
        await ethers.provider.getStorageAt(
          Bridge.address,
          BRIDGE_LIFECYCLE_ROUTER_STORAGE_SLOT
        ),
        "Bridge lifecycle router slot"
      )
      return sameHex(router, BridgeLifecycleRouter.address)
    }
    if (call.inner.id === "install-registry-lifecycle-owner") {
      const owner = await readAddress(
        ethers.provider,
        FrostWalletRegistry.address,
        frostWalletRegistryInterface,
        "lifecycleOwner"
      )
      return sameHex(owner, BridgeLifecycleRouter.address)
    }
    throw new Error(
      `Unknown FROST lifecycle installation call ${call.inner.id}`
    )
  }

  const phases = candidatePhases.map((candidate) => {
    let observed = false
    if (candidate.id === "upgrade-bridge") {
      observed =
        installedImplementation.toLowerCase() ===
        BridgeImplementation.address.toLowerCase()
    } else if (candidate.id === "install-frost-registry") {
      observed =
        readAddressWord(
          frostRegistryWord,
          "Bridge FROST registry slot"
        ).toLowerCase() === FrostWalletRegistry.address.toLowerCase()
    } else if (candidate.id === "install-frost-lifecycle") {
      observed =
        (lifecycleRouterToInstall === constants.AddressZero ||
          sameHex(
            frostPrerequisites.configuredBridgeLifecycleRouter,
            BridgeLifecycleRouter.address
          )) &&
        (lifecycleOwnerToInstall === constants.AddressZero ||
          sameHex(
            frostPrerequisites.registryLifecycleOwner,
            BridgeLifecycleRouter.address
          ))
    } else if (candidate.id === "initialize-coverage") {
      observed =
        coverageReadback !== undefined &&
        coverageMatchesAuthorization(coverageReadback)
    } else if (candidate.id === "migrate-coverage") {
      observed =
        coverageReadback !== undefined && coverageIsComplete(coverageReadback)
    } else if (candidate.id === "activate-complete-p2tr") {
      observed =
        sameHex(activeRouter, Router.address) &&
        coverageReadback !== undefined &&
        coverageIsComplete(coverageReadback)
    }
    const prior = previous?.phases.find(({ id }) => id === candidate.id)
    const reconciled = reconcilePhase(prior, candidate, observed)
    if (!observed && reconciled.status === "prepared") {
      const pendingTimelock = reconciled.calls.find(
        ({ kind, timelockOperationID }) =>
          kind === "timelock" && timelockOperationID
      )
      if (pendingTimelock?.timelockOperationID) {
        // A scheduled operation is a deterministic on-chain pending receipt.
        // The read is deferred to the execution loop below to keep this map
        // synchronous; previous pending state remains durable in the artifact.
        if (prior?.status === "pending") reconciled.status = "pending"
      }
    }
    return reconciled
  })

  const selectors = {
    proxyUpgrade: proxyAdminInterface.getSighash("upgrade"),
    coverage: bridgeInterface.getSighash("processTaprootOutputKeyCoverage"),
    governanceCoverage: bridgeGovernanceInterface.getSighash(
      "processTaprootOutputKeyCoverage"
    ),
    coverageAuthorizationTuple: COVERAGE_AUTHORIZATION_TUPLE,
    routerProtocol: routerInterface.getSighash("evidenceProtocolID"),
    registryProtocol: registryInterface.getSighash("reservationProtocolID"),
    installBridgeLifecycleRouter:
      bridgeInterface.getSighash("setLifecycleRouter"),
    installRegistryLifecycleOwner: frostWalletRegistryInterface.getSighash(
      "updateLifecycleOwner"
    ),
  }
  const artifact: CompleteP2TRActivationArtifact = {
    schemaVersion: ACTIVATION_ARTIFACT_SCHEMA,
    contentHash: constants.HashZero,
    networkName: hre.network.name,
    chainId,
    bridge: Bridge.address,
    structuralPlanID,
    planID,
    bridgePredecessorImplementation,
    bridgePredecessorImplementationCodeHash,
    ecdsaCutover,
    inventory: {
      manifestPath: resolvedManifestPath,
      historyStartBlockNumber: manifest.historyStartBlockNumber,
      snapshotBlockNumber: manifest.snapshotBlockNumber,
      snapshotBlockHash: manifest.snapshotBlockHash,
      bitcoinJournalSha256: manifest.bitcoinJournalSha256,
      bitcoinRawEvidenceCommitment: manifest.bitcoinRawEvidenceCommitment,
      semanticProjectionRoot: manifest.semanticProjectionRoot,
      sourceIDs: authenticatedManifest.sourceIDs,
      sourceCheckpointCommitment: checkpointCommitment,
      linkedLibrariesCommitment: librariesCommitment,
      root: inventory.root,
      count: inventory.count,
      migrationCursor: nextCoverageBatch.completed
        ? inventory.count
        : migrationCursor,
    },
    addresses: {
      bridgeProxy: Bridge.address,
      proxyAdmin,
      proxyAuthority,
      currentGovernance,
      governanceAuthority,
      frostWalletRegistry: FrostWalletRegistry.address,
      frostWalletRegistryImplementation:
        frostPrerequisites.archive.implementation,
      frostRegistryGovernance: frostGovernanceAuthority,
      bridgeLifecycleRouter: BridgeLifecycleRouter.address,
      lifecycleRouterToInstall,
      lifecycleOwnerToInstall,
      proposalValidator: WalletProposalValidator.address,
      bridgeImplementation: BridgeImplementation.address,
      ecdsaRouter: ecdsaCutover.router,
      ecdsaOldRouter: ecdsaCutover.oldRouter,
      frostRegistryToInstall,
      authorizationRegistry: Registry.address,
      completeRouter: Router.address,
      ...Object.fromEntries(
        Object.entries(bridgeLibraries).map(([name, address]) => [
          `library${name}`,
          address,
        ])
      ),
    },
    runtimeReceipts,
    selectors,
    phases,
    readbacks: {
      installedImplementation,
      snapshotImplementation,
      snapshotUsesCompleteImplementation,
      currentGovernance: currentGovernanceReadback,
      activeEcdsaRouter,
      ecdsaCutover,
      activeP2TRRouter: activeRouter,
      router: routerReadbacks,
      registry: registryReadbacks,
      coverageAuthorizationDigest,
      frostPrerequisites: immutableFrostPrerequisiteBinding(frostPrerequisites),
      frostLifecycle: {
        configuredBridgeFrostRegistry:
          frostPrerequisites.configuredBridgeFrostRegistry,
        configuredBridgeLifecycleRouter:
          frostPrerequisites.configuredBridgeLifecycleRouter,
        registryLifecycleOwner: frostPrerequisites.registryLifecycleOwner,
      },
      sourceCheckpointCommitment: checkpointCommitment,
      rebuildSourceIDs: authenticatedManifest.sourceIDs,
      rebuildBackendIDs: authenticatedManifest.backendIDs,
      rebuildSigners: authenticatedManifest.signers,
      linkedLibraries: actualLinkedLibraries,
      linkedLibrariesCommitment: librariesCommitment,
      zeroAccounting: true,
      storageLayout: "test/formal/Bridge.storage-layout.json",
      coverage: coverageReadback ?? null,
    },
  }
  const persistActivationState = (): void => {
    artifactFileContentHash = persistArtifact(
      artifactPath,
      artifact,
      artifactFileContentHash === undefined
        ? { createOnly: true }
        : { expectedCurrentContentHash: artifactFileContentHash }
    )
  }
  const activationSession = acquireDurableArtifactSessionLock(artifactPath, {
    requirePrivateDirectory: true,
  })
  try {
    // Recheck after taking the session lock: a historical file that appeared
    // while candidates were deployed/planned must not be ignored by the first
    // durable write.
    assertNoHistoricalActivationArtifact(historicalArtifactPath, artifactPath)
    persistActivationState()

    const pendingPhaseIDs = new Set(
      (process.env.COMPLETE_P2TR_PENDING_PHASES ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    )
    for (const phase of artifact.phases) {
      if (phase.status === "executed") continue
      if (pendingPhaseIDs.has(phase.id)) {
        phase.status = "pending"
        persistActivationState()
      }
      if (phase.prerequisite) {
        const prerequisite = artifact.phases.find(
          ({ id }) => id === phase.prerequisite
        )
        if (prerequisite?.status !== "executed") continue
      }
      if (
        phase.id === "initialize-coverage" &&
        !snapshotUsesCompleteImplementation
      ) {
        // The authenticated archive must close only after the COMPLETE_V2
        // implementation is live. This eliminates an unauthenticated old-code
        // reveal tail; the operator refreshes the dual-source checkpoint and
        // signed authorization after the upgrade receipt.
        continue
      }
      const block = await ethers.provider.getBlock("latest")
      if (
        phase.id === "activate-complete-p2tr" &&
        block.number - manifest.snapshotBlockNumber >
          Number(
            process.env.COMPLETE_P2TR_MAX_ACTIVATION_TAIL_BLOCKS ??
              DEFAULT_MAXIMUM_ACTIVATION_TAIL_BLOCKS
          )
      ) {
        throw new Error("Coverage checkpoint expired before activation")
      }
      if (
        phase.notBefore &&
        BigNumber.from(block.timestamp).lt(phase.notBefore)
      ) {
        continue
      }

      let everyTimelockCallDone =
        phase.calls.length > 0 &&
        phase.calls.every(({ kind }) => kind === "timelock")
      let anyTimelockCallPending = false
      for (const authorityCall of phase.calls) {
        if (
          authorityCall.kind === "timelock" &&
          authorityCall.timelockOperationID
        ) {
          // eslint-disable-next-line no-await-in-loop
          const done = (
            await callResult(
              ethers.provider,
              authorityCall.authority,
              timelockInterface,
              "isOperationDone",
              [authorityCall.timelockOperationID]
            )
          )[0] as boolean
          if (done) continue
          everyTimelockCallDone = false
          // eslint-disable-next-line no-await-in-loop
          const pending = (
            await callResult(
              ethers.provider,
              authorityCall.authority,
              timelockInterface,
              "isOperationPending",
              [authorityCall.timelockOperationID]
            )
          )[0] as boolean
          if (pending) {
            anyTimelockCallPending = true
          }
        } else {
          everyTimelockCallDone = false
        }
      }
      if (everyTimelockCallDone) {
        // Timelock operation receipts prove only that every wrapper call ran.
        // The phase advances only when the exact combined state effect is live.
        // eslint-disable-next-line no-await-in-loop
        await requireSuccessfulPhaseReceiptReadback(
          phase.id,
          { status: 1 },
          () => observePhaseExactly(phase)
        )
        phase.status = "executed"
        persistActivationState()
      } else if (anyTimelockCallPending) {
        phase.status = "pending"
        persistActivationState()
      }

      if (phase.id === "migrate-coverage") {
        if (mode !== "execute") continue
        if (
          !configuredAccounts.some(
            (account) =>
              account.toLowerCase() === migrationAuthority.toLowerCase()
          )
        ) {
          continue
        }
        const signer = await ethers.getSigner(migrationAuthority)
        while (true) {
          if (phase.status === "pending") {
            const recordedCall = phase.calls[0]
            const recordedHash = phase.readback?.transactionHash
            const recordedIndices = phase.readback?.indices
            const recordedNextCursor = phase.readback?.nextCursor
            if (
              !recordedCall ||
              typeof recordedHash !== "string" ||
              !utils.isHexString(recordedHash, 32) ||
              !phase.transactionHashes.some(
                (transactionHash) =>
                  transactionHash.toLowerCase() === recordedHash.toLowerCase()
              ) ||
              !Array.isArray(recordedIndices) ||
              recordedIndices.length === 0 ||
              !recordedIndices.every(
                (index) => Number.isSafeInteger(index) && index >= 0
              ) ||
              typeof recordedNextCursor !== "number" ||
              !Number.isSafeInteger(recordedNextCursor) ||
              recordedNextCursor < 0 ||
              (inventory.count !== 0 && recordedNextCursor >= inventory.count)
            ) {
              throw new Error(
                "Pending coverage migration has no complete durable broadcast intent; manual reconciliation is required"
              )
            }
            // eslint-disable-next-line no-await-in-loop
            const disposition = await inspectRecordedPhaseTransaction(
              ethers.provider,
              phase.id,
              recordedHash,
              recordedCall,
              () => coverageBatchAppliedExactly(recordedIndices as number[])
            )
            if (disposition === "pending") break

            artifact.inventory.migrationCursor = recordedNextCursor
            phase.status = "prepared"
            persistActivationState()
            continue
          }

          // Rebuild from the on-chain bitmap after every receipt. This makes a
          // crash after broadcast/receipt safe: already migrated leaves are
          // skipped and the next <=32-leaf batch is deterministic.
          // eslint-disable-next-line no-await-in-loop
          const batch = await buildNextCoverageBatch(
            ethers.provider,
            Bridge.address,
            inventory.entries,
            artifact.inventory.migrationCursor
          )
          if (batch.completed) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await observePhaseExactly(phase))) {
              throw new Error(
                "Coverage bitmap reported completion but the exact migration readback did not match"
              )
            }
            phase.status = "executed"
            phase.calls = []
            phase.readback = {
              cursor: inventory.count,
              indices: [],
              migratedCount: inventory.count,
            }
            artifact.inventory.migrationCursor = inventory.count
            persistActivationState()
            break
          }
          const prepared = envelope(
            makeCall(
              "migrate-coverage:next-batch",
              Bridge.address,
              bridgeInterface.encodeFunctionData(
                "processTaprootOutputKeyCoverage",
                [batch.payload]
              ),
              `Permissionlessly migrate coverage leaves ${batch.indices.join(
                ","
              )}`
            ),
            migrationAuthority,
            "eoa",
            "migrate-coverage",
            "0"
          )
          phase.calls = [prepared]
          phase.status = "pending"
          phase.readback = {
            cursor: artifact.inventory.migrationCursor,
            nextCursor: batch.cursor,
            indices: batch.indices,
          }
          persistActivationState()

          // eslint-disable-next-line no-await-in-loop
          const transaction = await signer.sendTransaction({
            to: prepared.inner.target,
            value: prepared.inner.value,
            data: prepared.inner.data,
          })
          phase.transactionHashes.push(transaction.hash)
          phase.readback = {
            ...phase.readback,
            transactionHash: transaction.hash,
          }
          persistActivationState()
          // eslint-disable-next-line no-await-in-loop
          const receipt = await transaction.wait(1)
          // eslint-disable-next-line no-await-in-loop
          await requireSuccessfulPhaseReceiptReadback(phase.id, receipt, () =>
            coverageBatchAppliedExactly(batch.indices)
          )
          artifact.inventory.migrationCursor = batch.cursor
          phase.status = "prepared"
          persistActivationState()
        }
        continue
      }

      if (mode !== "execute" || phase.status === "executed") continue
      if (!phase.calls.every(({ kind }) => kind === "eoa")) continue
      if (
        !phase.calls.every(({ authority }) =>
          configuredAccounts.some(
            (account) => account.toLowerCase() === authority.toLowerCase()
          )
        )
      ) {
        continue
      }

      const completedCallIDsValue = phase.readback?.completedCallIDs
      const completedCallIDs =
        completedCallIDsValue === undefined
          ? []
          : Array.isArray(completedCallIDsValue) &&
            completedCallIDsValue.every((value) => typeof value === "string")
          ? [...completedCallIDsValue]
          : undefined
      if (
        completedCallIDs === undefined ||
        new Set(completedCallIDs).size !== completedCallIDs.length ||
        completedCallIDs.some(
          (id) => !phase.calls.some(({ inner }) => inner.id === id)
        )
      ) {
        throw new Error(
          `Activation phase ${phase.id} has malformed durable call progress`
        )
      }

      if (phase.status === "pending") {
        const recordedIndex = phase.readback?.pendingCallIndex
        const recordedID = phase.readback?.pendingCallID
        const recordedHash = phase.readback?.transactionHash
        if (
          typeof recordedIndex !== "number" ||
          !Number.isSafeInteger(recordedIndex) ||
          recordedIndex < 0 ||
          recordedIndex >= phase.calls.length ||
          typeof recordedID !== "string" ||
          phase.calls[recordedIndex].inner.id !== recordedID ||
          completedCallIDs.includes(recordedID) ||
          typeof recordedHash !== "string" ||
          !utils.isHexString(recordedHash, 32) ||
          !phase.transactionHashes.some(
            (transactionHash) =>
              transactionHash.toLowerCase() === recordedHash.toLowerCase()
          )
        ) {
          throw new Error(
            `Pending activation phase ${phase.id} has no complete durable broadcast intent; manual reconciliation is required`
          )
        }
        const recordedCall = phase.calls[recordedIndex]
        // eslint-disable-next-line no-await-in-loop
        const disposition = await inspectRecordedPhaseTransaction(
          ethers.provider,
          phase.id,
          recordedHash,
          recordedCall,
          () => observeCallExactly(phase, recordedCall)
        )
        if (disposition === "pending") continue
        completedCallIDs.push(recordedID)
        phase.status = "prepared"
        phase.readback = {
          ...phase.readback,
          completedCallIDs,
          pendingCallIndex: null,
          pendingCallID: null,
          transactionHash: null,
        }
        persistActivationState()
      }

      for (let callIndex = 0; callIndex < phase.calls.length; callIndex++) {
        const authorityCall = phase.calls[callIndex]
        if (completedCallIDs.includes(authorityCall.inner.id)) continue

        // Persist the exact next-call intent before broadcast. A crash between
        // send and hash persistence is deliberately ambiguous and requires
        // operator reconciliation rather than an unsafe automatic rebroadcast.
        phase.status = "pending"
        phase.readback = {
          ...phase.readback,
          completedCallIDs,
          pendingCallIndex: callIndex,
          pendingCallID: authorityCall.inner.id,
          transactionHash: null,
        }
        persistActivationState()

        // eslint-disable-next-line no-await-in-loop
        const signer = await ethers.getSigner(authorityCall.authority)
        // eslint-disable-next-line no-await-in-loop
        const transaction = await signer.sendTransaction({
          to: authorityCall.inner.target,
          value: authorityCall.inner.value,
          data: authorityCall.inner.data,
        })
        phase.transactionHashes.push(transaction.hash)
        phase.readback = {
          ...phase.readback,
          transactionHash: transaction.hash,
        }
        persistActivationState()

        // eslint-disable-next-line no-await-in-loop
        const receipt = await transaction.wait(1)
        // eslint-disable-next-line no-await-in-loop
        await requireSuccessfulPhaseReceiptReadback(phase.id, receipt, () =>
          observeCallExactly(phase, authorityCall)
        )
        completedCallIDs.push(authorityCall.inner.id)
        phase.status = "prepared"
        phase.readback = {
          ...phase.readback,
          completedCallIDs,
          pendingCallIndex: null,
          pendingCallID: null,
          transactionHash: null,
        }
        persistActivationState()
      }

      // eslint-disable-next-line no-await-in-loop
      await requireSuccessfulPhaseReceiptReadback(phase.id, { status: 1 }, () =>
        observePhaseExactly(phase)
      )
      phase.status = "executed"
      persistActivationState()
    }

    activeRouter = readAddressWord(
      await ethers.provider.getStorageAt(
        Bridge.address,
        BRIDGE_P2TR_ROUTER_STORAGE_SLOT
      ),
      "Bridge P2TR router slot"
    )
    activeEcdsaRouter = readAddressWord(
      await ethers.provider.getStorageAt(
        Bridge.address,
        BRIDGE_ECDSA_ROUTER_STORAGE_SLOT
      ),
      "Bridge ECDSA router slot"
    )
    const finalBridgeFrostRegistry = readAddressWord(
      await ethers.provider.getStorageAt(
        Bridge.address,
        BRIDGE_FROST_REGISTRY_STORAGE_SLOT
      ),
      "Bridge FROST registry slot"
    )
    const finalBridgeLifecycleRouter = readAddressWord(
      await ethers.provider.getStorageAt(
        Bridge.address,
        BRIDGE_LIFECYCLE_ROUTER_STORAGE_SLOT
      ),
      "Bridge lifecycle router slot"
    )
    const finalRegistryLifecycleOwner = await readAddress(
      ethers.provider,
      FrostWalletRegistry.address,
      frostWalletRegistryInterface,
      "lifecycleOwner"
    )
    if (
      finalBridgeFrostRegistry !== constants.AddressZero &&
      !sameHex(finalBridgeFrostRegistry, FrostWalletRegistry.address)
    ) {
      throw new Error("Final Bridge FROST registry readback mismatch")
    }
    if (
      finalBridgeLifecycleRouter !== constants.AddressZero &&
      !sameHex(finalBridgeLifecycleRouter, BridgeLifecycleRouter.address)
    ) {
      throw new Error("Final Bridge lifecycle router readback mismatch")
    }
    if (
      finalRegistryLifecycleOwner !== constants.AddressZero &&
      !sameHex(finalRegistryLifecycleOwner, BridgeLifecycleRouter.address)
    ) {
      throw new Error("Final FROST lifecycle owner readback mismatch")
    }
    artifact.readbacks.activeP2TRRouter = activeRouter
    artifact.readbacks.activeEcdsaRouter = activeEcdsaRouter
    artifact.readbacks.frostLifecycle = {
      configuredBridgeFrostRegistry: finalBridgeFrostRegistry,
      configuredBridgeLifecycleRouter: finalBridgeLifecycleRouter,
      registryLifecycleOwner: finalRegistryLifecycleOwner,
    }
    const finalImplementation = readAddressWord(
      await ethers.provider.getStorageAt(
        Bridge.address,
        EIP_1967_IMPLEMENTATION_SLOT
      ),
      "Bridge EIP-1967 implementation"
    )
    artifact.readbacks.installedImplementation = finalImplementation
    if (
      finalImplementation.toLowerCase() ===
      BridgeImplementation.address.toLowerCase()
    ) {
      artifact.readbacks.coverage = await readCoverage(
        ethers.provider,
        Bridge.address,
        inventory.entries
      )
    }
    persistActivationState()

    console.log(
      `COMPLETE_P2TR_ACTIVATION_ARTIFACT=${artifactPath}\n` +
        `COMPLETE_P2TR_ACTIVATION_PLAN_ID=${planID}\n` +
        `COMPLETE_P2TR_ACTIVATION_STATUS=${JSON.stringify(
          artifact.phases.map(({ id, status }) => ({ id, status }))
        )}`
    )
  } finally {
    activationSession.release()
  }
}

export default func

func.tags = ["CompleteP2TRActivation"]
func.dependencies = []
func.skip = async () => process.env.RUN_COMPLETE_P2TR_ACTIVATION !== "1"
