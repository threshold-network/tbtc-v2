/* eslint-disable no-restricted-syntax, no-await-in-loop, no-plusplus, no-continue */

import fs from "fs"
import path from "path"
import type { HardhatRuntimeEnvironment } from "hardhat/types"
import type { DeployFunction } from "hardhat-deploy/types"
import type { providers } from "ethers"
import { constants, utils } from "ethers"
import {
  CanonicalHistoryEvidence,
  scanCanonicalHistory,
} from "../scripts/frost-wallet-registry-canonical-history"

const EIP170_RUNTIME_LIMIT = 24_576
export const FROST_REGISTRY_MAX_RUNTIME_BYTES = EIP170_RUNTIME_LIMIT - 512
export const MAX_ARCHIVE_TAIL_BLOCKS = 64
const RECEIPT_SCAN_CONCURRENCY = 20
const MANIFEST_SCHEMA = "tbtc/frost-wallet-archive/v1" as const
export const ARCHIVE_MANIFEST_SCHEMA_V2 =
  "tbtc/frost-wallet-archive/v3" as const
export const ARCHIVE_MANIFEST_SCHEMA_HASH = utils.keccak256(
  utils.toUtf8Bytes(ARCHIVE_MANIFEST_SCHEMA_V2)
)
export const ARCHIVE_CHECKPOINT_SCHEMA =
  "tbtc/frost-wallet-archive/checkpoint-v3" as const
export const ARCHIVE_CHECKPOINT_ATTESTATION_SCHEMA_HASH = utils.keccak256(
  utils.toUtf8Bytes("tbtc/frost-wallet-archive/checkpoint-attestation-v1")
)
export const ARCHIVE_MANIFEST_ATTESTATION_SCHEMA_HASH = utils.keccak256(
  utils.toUtf8Bytes("tbtc/frost-wallet-archive/manifest-attestation-v1")
)
export const ARCHIVE_SOURCE_ATTESTATION_ROLE = utils.keccak256(
  utils.toUtf8Bytes("tbtc/frost-wallet-archive/source")
)
export const ARCHIVE_RECONCILER_ATTESTATION_ROLE = utils.keccak256(
  utils.toUtf8Bytes("tbtc/frost-wallet-archive/reconciler")
)
const ARCHIVE_COMBINED_HISTORY_DOMAIN = utils.keccak256(
  utils.toUtf8Bytes("tbtc/frost-wallet-archive/combined-history-v2")
)
export const ARCHIVE_MANIFEST_TYPEHASH = utils.keccak256(
  utils.toUtf8Bytes("FrostArchiveManifest(bytes32 fieldsHash)")
)
export const ARCHIVE_START_SCHEMA_HASH = utils.keccak256(
  utils.toUtf8Bytes("tbtc/frost-wallet-archive/start-v3")
)
export const ARCHIVE_START_TYPEHASH = utils.keccak256(
  utils.toUtf8Bytes("FrostArchiveMigrationStart(bytes32 fieldsHash)")
)
export const ARCHIVE_CHECKPOINT_ATTESTATION_TYPEHASH = utils.keccak256(
  utils.toUtf8Bytes("FrostArchiveCheckpointAttestation(bytes32 fieldsHash)")
)
export const ARCHIVE_MANIFEST_ATTESTATION_TYPEHASH = utils.keccak256(
  utils.toUtf8Bytes("FrostArchiveManifestAttestation(bytes32 fieldsHash)")
)
export const ARCHIVE_LEAF_TYPEHASH = utils.keccak256(
  utils.toUtf8Bytes(
    "FrostArchiveWallet(uint256 index,bytes32 walletID,bytes32 dkgResultHash,bytes32 membersIdsHash)"
  )
)
const ARCHIVE_EIP712_NAME = "tBTC FROST Wallet Archive"
const ARCHIVE_EIP712_VERSION = "3"
const EXPECTED_SOLC_VERSION = "0.8.17"
const EXPECTED_SOLC_LONG_VERSION = "0.8.17+commit.8df45f5f"
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

// Hash of the exact production-compiled FrostWalletRegistry runtime after all
// external-library link locations are zeroed. Update only alongside the source,
// compiler/settings test, and an explicit bytecode-size review.
export const EXPECTED_UNLINKED_REGISTRY_RUNTIME_HASH =
  "0xa9d528cb66af83df56d9b96a895f5e71f6d2c567d3d97e15809af6983215b570"
export const EXPECTED_NORMALIZED_FROST_INACTIVITY_RUNTIME_HASH =
  "0xbdff70c830c201fdf35d15d0c6e343c4a6205ef3b82be17333fcc3d692198309"

export interface LogPosition {
  blockNumber: number
  transactionIndex: number
  logIndex: number
}

export interface SubmittedDkgRecord {
  resultHash: string
  walletID: string
  membersIdsHash: string
  members: number[]
  misbehavedMembersIndices: number[]
  position: LogPosition
}

export interface CreatedWalletRecord {
  walletID: string
  dkgResultHash: string
  position: LogPosition
}

export interface ApprovedDkgRecord {
  resultHash: string
  position: LogPosition
}

export interface ClosedWalletRecord {
  walletID: string
  position: LogPosition
}

export interface FrostWalletHistory {
  coverage: CanonicalHistoryEvidence
  submitted: SubmittedDkgRecord[]
  approved: ApprovedDkgRecord[]
  created: CreatedWalletRecord[]
  closed: ClosedWalletRecord[]
}

export interface ArchiveManifestEntry {
  walletID: string
  dkgResultHash: string
  membersIdsHash: string
}

export interface ArchiveCheckpointV2 {
  schemaVersion: typeof ARCHIVE_CHECKPOINT_SCHEMA
  chainId: string
  registry: string
  scanFromBlock: number
  checkpointBlockNumber: number
  checkpointBlockHash: string
  maxTailBlocks: number
  upgradeDeadlineBlock: number
  history: FrostWalletHistory
  entries: ArchiveManifestEntry[]
  checkpointHash: string
}

export interface ArchiveManifestV2 {
  chainId: string
  registry: string
  oldImplementationCodeHash: string
  newImplementationCodeHash: string
  checkpointHash: string
  checkpointBlockNumber: number
  maxTailBlocks: number
  upgradeDeadlineBlock: number
  sourceAttester: string
  sourceAttestationHash: string
  sourceIdentityHash: string
  sourceEndpointIdentityHash: string
  sourceTrustDomainHash: string
  sourceEndpointPolicyHash: string
  reconcilerAttester: string
  reconcilerAttestationHash: string
  reconcilerIdentityHash: string
  reconcilerEndpointIdentityHash: string
  reconcilerTrustDomainHash: string
  reconcilerEndpointPolicyHash: string
  upgradeBlockNumber: number
  upgradeBlockHash: string
  upgradeTransactionIndex: number
  scanFromBlock: number
  scanToBlock: number
  historyRoot: string
  walletsRoot: string
  walletCount: number
  schemaHash: string
}

export interface ArchiveMigrationStartAuthorization {
  chainId: string
  registry: string
  oldImplementationCodeHash: string
  newImplementationCodeHash: string
  authority: string
  checkpointHash: string
  checkpointBlockNumber: number
  maxTailBlocks: number
  upgradeDeadlineBlock: number
  sourceAttester: string
  sourceAttestationHash: string
  reconcilerAttester: string
  reconcilerAttestationHash: string
  schemaHash: string
}

export interface ArchiveCheckpointAttestation {
  chainId: string
  registry: string
  role: string
  attester: string
  checkpointHash: string
  scanFromBlock: number
  checkpointBlockNumber: number
  checkpointBlockHash: string
  historyCommitment: string
  inventoryRoot: string
  inventoryCount: number
  maxTailBlocks: number
  upgradeDeadlineBlock: number
  sourceIdentityHash: string
  endpointIdentityHash: string
  trustDomainHash: string
  endpointPolicyHash: string
  schemaHash: string
}

export interface SignedArchiveCheckpointAttestation {
  attestation: ArchiveCheckpointAttestation
  digest: string
  signer: string
  signature: string
}

export interface ArchiveManifestAttestation {
  chainId: string
  registry: string
  role: string
  attester: string
  manifestHash: string
  checkpointHash: string
  upgradeBlockNumber: number
  upgradeBlockHash: string
  upgradeTransactionIndex: number
  historyRoot: string
  walletsRoot: string
  walletCount: number
  schemaHash: string
}

export interface SignedArchiveManifestAttestation {
  attestation: ArchiveManifestAttestation
  digest: string
  signer: string
  signature: string
}

export interface SignedArchiveMigrationStart {
  authorization: ArchiveMigrationStartAuthorization
  digest: string
  signer: string
  signature: string
}

export interface ArchiveManifestProofEntry extends ArchiveManifestEntry {
  index: number
  proof: string[]
}

export interface SignedArchiveManifestV2 {
  schemaVersion: typeof ARCHIVE_MANIFEST_SCHEMA_V2
  manifest: ArchiveManifestV2
  manifestHash: string
  signer: string
  signature: string
  entries: ArchiveManifestProofEntry[]
}

export const ARCHIVE_MANIFEST_TUPLE =
  "tuple(uint256 chainId,address registry,bytes32 oldImplementationCodeHash,bytes32 newImplementationCodeHash,bytes32 checkpointHash,uint256 checkpointBlockNumber,uint256 maxTailBlocks,uint256 upgradeDeadlineBlock,address sourceAttester,bytes32 sourceAttestationHash,bytes32 sourceIdentityHash,bytes32 sourceEndpointIdentityHash,bytes32 sourceTrustDomainHash,bytes32 sourceEndpointPolicyHash,address reconcilerAttester,bytes32 reconcilerAttestationHash,bytes32 reconcilerIdentityHash,bytes32 reconcilerEndpointIdentityHash,bytes32 reconcilerTrustDomainHash,bytes32 reconcilerEndpointPolicyHash,uint256 upgradeBlockNumber,bytes32 upgradeBlockHash,uint256 upgradeTransactionIndex,uint256 scanFromBlock,uint256 scanToBlock,bytes32 historyRoot,bytes32 walletsRoot,uint256 walletCount,bytes32 schemaHash)"
const ARCHIVE_CHECKPOINT_ATTESTATION_TUPLE =
  "tuple(address attester,bytes32 sourceIdentityHash,bytes32 endpointIdentityHash,bytes32 trustDomainHash,bytes32 endpointPolicyHash,bytes signature)"
export const ARCHIVE_MIGRATION_START_TUPLE = `tuple(address authority,address oldImplementation,bytes32 checkpointHash,uint256 scanFromBlock,uint256 checkpointBlockNumber,bytes32 checkpointBlockHash,bytes32 historyCommitment,bytes32 inventoryRoot,uint256 inventoryCount,uint256 maxTailBlocks,uint256 upgradeDeadlineBlock,${ARCHIVE_CHECKPOINT_ATTESTATION_TUPLE} sourceAttestation,${ARCHIVE_CHECKPOINT_ATTESTATION_TUPLE} reconcilerAttestation,bytes authoritySignature)`
const ARCHIVE_CHECKPOINT_ATTESTATION_PAYLOAD_TUPLE =
  "tuple(uint256 chainId,address registry,bytes32 role,address attester,bytes32 checkpointHash,uint256 scanFromBlock,uint256 checkpointBlockNumber,bytes32 checkpointBlockHash,bytes32 historyCommitment,bytes32 inventoryRoot,uint256 inventoryCount,uint256 maxTailBlocks,uint256 upgradeDeadlineBlock,bytes32 sourceIdentityHash,bytes32 endpointIdentityHash,bytes32 trustDomainHash,bytes32 endpointPolicyHash,bytes32 schemaHash)"
const ARCHIVE_START_AUTHORIZATION_PAYLOAD_TUPLE =
  "tuple(uint256 chainId,address registry,bytes32 oldImplementationCodeHash,bytes32 newImplementationCodeHash,address authority,bytes32 checkpointHash,uint256 checkpointBlockNumber,uint256 maxTailBlocks,uint256 upgradeDeadlineBlock,address sourceAttester,bytes32 sourceAttestationHash,address reconcilerAttester,bytes32 reconcilerAttestationHash,bytes32 schemaHash)"
const ARCHIVE_MANIFEST_ATTESTATION_PAYLOAD_TUPLE =
  "tuple(uint256 chainId,address registry,bytes32 role,address attester,bytes32 manifestHash,bytes32 checkpointHash,uint256 upgradeBlockNumber,bytes32 upgradeBlockHash,uint256 upgradeTransactionIndex,bytes32 historyRoot,bytes32 walletsRoot,uint256 walletCount,bytes32 schemaHash)"
export const ARCHIVE_MANIFEST_COMMIT_TUPLE = `tuple(${ARCHIVE_MANIFEST_TUPLE} manifest,bytes authoritySignature,bytes sourceSignature,bytes reconcilerSignature)`
export const ARCHIVE_ATTESTATION_READBACK_TUPLE =
  "tuple(uint256 upgradeDeadlineBlock,address sourceAttester,bytes32 sourceAttestationHash,bytes32 sourceIdentityHash,bytes32 sourceEndpointIdentityHash,bytes32 sourceTrustDomainHash,bytes32 sourceEndpointPolicyHash,address reconcilerAttester,bytes32 reconcilerAttestationHash,bytes32 reconcilerIdentityHash,bytes32 reconcilerEndpointIdentityHash,bytes32 reconcilerTrustDomainHash,bytes32 reconcilerEndpointPolicyHash)"

export const decodeArchiveAttestationReadback = (
  encoded: string,
  ethersUtils: typeof import("ethers").utils = utils
) =>
  ethersUtils.defaultAbiCoder.decode(
    [ARCHIVE_ATTESTATION_READBACK_TUPLE],
    encoded
  )[0]

export const archiveWalletLeaf = (
  index: number,
  entry: ArchiveManifestEntry,
  ethersUtils: typeof import("ethers").utils = utils
): string =>
  ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      ["bytes32", "uint256", "bytes32", "bytes32", "bytes32"],
      [
        ARCHIVE_LEAF_TYPEHASH,
        index,
        entry.walletID,
        entry.dkgResultHash,
        entry.membersIdsHash,
      ]
    )
  )

const hashMerklePair = (
  left: string,
  right: string,
  ethersUtils: typeof import("ethers").utils
): string => {
  const [first, second] =
    left.toLowerCase() < right.toLowerCase() ? [left, right] : [right, left]
  return ethersUtils.keccak256(ethersUtils.concat([first, second]))
}

export const buildArchiveMerkleTree = (
  entries: ArchiveManifestEntry[],
  ethersUtils: typeof import("ethers").utils = utils
): { root: string; entries: ArchiveManifestProofEntry[] } => {
  const canonicalEntries = entries
    .map((entry) => ({
      walletID: normalizeBytes32(entry.walletID, "archive wallet ID"),
      dkgResultHash: normalizeBytes32(
        entry.dkgResultHash,
        "archive DKG result hash"
      ),
      membersIdsHash: normalizeBytes32(
        entry.membersIdsHash,
        "archive members IDs hash"
      ),
    }))
    .sort((left, right) => left.walletID.localeCompare(right.walletID))

  if (canonicalEntries.length === 0) {
    return { root: ethersUtils.hexZeroPad("0x", 32), entries: [] }
  }

  const levels: string[][] = [
    canonicalEntries.map((entry, index) =>
      archiveWalletLeaf(index, entry, ethersUtils)
    ),
  ]
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1]
    const next: string[] = []
    for (let index = 0; index < current.length; index += 2) {
      next.push(
        index + 1 === current.length
          ? current[index]
          : hashMerklePair(current[index], current[index + 1], ethersUtils)
      )
    }
    levels.push(next)
  }

  const proofEntries = canonicalEntries.map((entry, entryIndex) => {
    const proof: string[] = []
    let position = entryIndex
    for (let level = 0; level < levels.length - 1; level++) {
      const sibling = position % 2 === 0 ? position + 1 : position - 1
      if (sibling < levels[level].length) proof.push(levels[level][sibling])
      position = Math.floor(position / 2)
    }
    return { ...entry, index: entryIndex, proof }
  })
  return { root: levels[levels.length - 1][0], entries: proofEntries }
}

export const hashArchiveManifestV2 = (
  manifest: ArchiveManifestV2,
  ethersUtils: typeof import("ethers").utils = utils
): string => {
  const fieldsHash = ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode([ARCHIVE_MANIFEST_TUPLE], [manifest])
  )
  const structHash = ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      ["bytes32", "bytes32"],
      [ARCHIVE_MANIFEST_TYPEHASH, fieldsHash]
    )
  )
  // Ethers v5 exposes EIP-712 domain hashing under this underscored API.
  // eslint-disable-next-line no-underscore-dangle
  const domainSeparator = ethersUtils._TypedDataEncoder.hashDomain({
    name: ARCHIVE_EIP712_NAME,
    version: ARCHIVE_EIP712_VERSION,
    chainId: manifest.chainId,
    verifyingContract: manifest.registry,
  })
  return ethersUtils.keccak256(
    ethersUtils.solidityPack(
      ["bytes2", "bytes32", "bytes32"],
      ["0x1901", domainSeparator, structHash]
    )
  )
}

export const hashArchiveCheckpointAttestation = (
  attestation: ArchiveCheckpointAttestation,
  ethersUtils: typeof import("ethers").utils = utils
): string => {
  // Ethers v5 exposes EIP-712 domain hashing under this underscored API.
  // eslint-disable-next-line no-underscore-dangle
  const domainSeparator = ethersUtils._TypedDataEncoder.hashDomain({
    name: ARCHIVE_EIP712_NAME,
    version: ARCHIVE_EIP712_VERSION,
    chainId: attestation.chainId,
    verifyingContract: attestation.registry,
  })
  const fieldsHash = ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      [ARCHIVE_CHECKPOINT_ATTESTATION_PAYLOAD_TUPLE],
      [attestation]
    )
  )
  const structHash = ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      ["bytes32", "bytes32"],
      [ARCHIVE_CHECKPOINT_ATTESTATION_TYPEHASH, fieldsHash]
    )
  )
  return ethersUtils.keccak256(
    ethersUtils.solidityPack(
      ["bytes2", "bytes32", "bytes32"],
      ["0x1901", domainSeparator, structHash]
    )
  )
}

export const hashArchiveManifestAttestation = (
  attestation: ArchiveManifestAttestation,
  ethersUtils: typeof import("ethers").utils = utils
): string => {
  // Ethers v5 exposes EIP-712 domain hashing under this underscored API.
  // eslint-disable-next-line no-underscore-dangle
  const domainSeparator = ethersUtils._TypedDataEncoder.hashDomain({
    name: ARCHIVE_EIP712_NAME,
    version: ARCHIVE_EIP712_VERSION,
    chainId: attestation.chainId,
    verifyingContract: attestation.registry,
  })
  const fieldsHash = ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      [ARCHIVE_MANIFEST_ATTESTATION_PAYLOAD_TUPLE],
      [attestation]
    )
  )
  const structHash = ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      ["bytes32", "bytes32"],
      [ARCHIVE_MANIFEST_ATTESTATION_TYPEHASH, fieldsHash]
    )
  )
  return ethersUtils.keccak256(
    ethersUtils.solidityPack(
      ["bytes2", "bytes32", "bytes32"],
      ["0x1901", domainSeparator, structHash]
    )
  )
}

export const assertDistinctCheckpointAttestations = (
  source: ArchiveCheckpointAttestation,
  reconciler: ArchiveCheckpointAttestation
): void => {
  if (
    source.role.toLowerCase() !==
      ARCHIVE_SOURCE_ATTESTATION_ROLE.toLowerCase() ||
    reconciler.role.toLowerCase() !==
      ARCHIVE_RECONCILER_ATTESTATION_ROLE.toLowerCase()
  ) {
    throw new Error("archive checkpoint attestation role mismatch")
  }
  const requiredDistinct: Array<[string, string, string]> = [
    [source.attester, reconciler.attester, "attester"],
    [
      source.sourceIdentityHash,
      reconciler.sourceIdentityHash,
      "source identity",
    ],
    [
      source.endpointIdentityHash,
      reconciler.endpointIdentityHash,
      "endpoint identity",
    ],
    [source.trustDomainHash, reconciler.trustDomainHash, "trust domain"],
  ]
  for (const [left, right, label] of requiredDistinct) {
    if (
      left.toLowerCase() === right.toLowerCase() ||
      left.toLowerCase() === constants.HashZero ||
      right.toLowerCase() === constants.HashZero ||
      left.toLowerCase() === constants.AddressZero ||
      right.toLowerCase() === constants.AddressZero
    ) {
      throw new Error(`archive checkpoint ${label} must be distinct`)
    }
  }
  if (
    source.endpointPolicyHash.toLowerCase() === constants.HashZero ||
    reconciler.endpointPolicyHash.toLowerCase() === constants.HashZero
  ) {
    throw new Error("archive checkpoint endpoint policy is required")
  }
}

export const hashArchiveMigrationStart = (
  authorization: ArchiveMigrationStartAuthorization,
  ethersUtils: typeof import("ethers").utils = utils
): string => {
  // Ethers v5 exposes EIP-712 domain hashing under this underscored API.
  // eslint-disable-next-line no-underscore-dangle
  const domainSeparator = ethersUtils._TypedDataEncoder.hashDomain({
    name: ARCHIVE_EIP712_NAME,
    version: ARCHIVE_EIP712_VERSION,
    chainId: authorization.chainId,
    verifyingContract: authorization.registry,
  })
  const fieldsHash = ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      [ARCHIVE_START_AUTHORIZATION_PAYLOAD_TUPLE],
      [authorization]
    )
  )
  const structHash = ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      ["bytes32", "bytes32"],
      [ARCHIVE_START_TYPEHASH, fieldsHash]
    )
  )
  return ethersUtils.keccak256(
    ethersUtils.solidityPack(
      ["bytes2", "bytes32", "bytes32"],
      ["0x1901", domainSeparator, structHash]
    )
  )
}

interface ArchiveManifestPayload {
  schemaVersion: typeof MANIFEST_SCHEMA
  networkName: string
  chainId: string
  registry: string
  scanFromBlock: number
  scanToBlock: number
  scanToBlockHash: string
  entries: ArchiveManifestEntry[]
}

export interface SignedArchiveManifest extends ArchiveManifestPayload {
  payloadHash: string
  signer: string
  signature: string
}

export interface ArchiveManifestContext {
  networkName: string
  chainId: string
  registry: string
  scanFromBlock: number
  scanToBlock: number
  scanToBlockHash: string
  requiredSigner: string
}

export const activeDkgMembers = (
  members: number[],
  misbehavedMembersIndices: number[]
): number[] => {
  let previous = 0
  const excluded = new Set<number>()
  for (const index of misbehavedMembersIndices) {
    if (
      !Number.isSafeInteger(index) ||
      index < 1 ||
      index > members.length ||
      index <= previous
    ) {
      throw new Error("corrupted misbehaved members indices")
    }
    excluded.add(index - 1)
    previous = index
  }
  return members.filter((_, position) => !excluded.has(position))
}

export const hashActiveDkgMembers = (
  members: number[],
  misbehavedMembersIndices: number[],
  ethersUtils: typeof import("ethers").utils = utils
): string =>
  ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      ["uint32[]"],
      [activeDkgMembers(members, misbehavedMembersIndices)]
    )
  )

interface RuntimeLinkReference {
  start: number
  length: number
}

const normalizeBytes32 = (value: string, description: string): string => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`invalid ${description}: expected bytes32, got ${value}`)
  }
  return value.toLowerCase()
}

const normalizeAddress = (value: string, description: string): string => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`invalid ${description}: expected address, got ${value}`)
  }
  return value.toLowerCase()
}

const comparePositions = (left: LogPosition, right: LogPosition): number => {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber - right.blockNumber
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex
  }
  return left.logIndex - right.logIndex
}

const positionOf = (log: providers.Log): LogPosition => ({
  blockNumber: log.blockNumber,
  transactionIndex: log.transactionIndex,
  logIndex: log.logIndex,
})

export const deriveArchiveEntries = (
  history: FrostWalletHistory
): ArchiveManifestEntry[] => {
  const createdByWallet = new Map<string, CreatedWalletRecord>()
  for (const created of history.created) {
    const walletID = normalizeBytes32(created.walletID, "created wallet ID")
    if (createdByWallet.has(walletID)) {
      throw new Error(`duplicate WalletCreated event for ${walletID}`)
    }
    createdByWallet.set(walletID, {
      ...created,
      walletID,
      dkgResultHash: normalizeBytes32(
        created.dkgResultHash,
        "created DKG result hash"
      ),
    })
  }

  const closedByWallet = new Map<string, ClosedWalletRecord>()
  for (const closed of history.closed) {
    const walletID = normalizeBytes32(closed.walletID, "closed wallet ID")
    if (closedByWallet.has(walletID)) {
      throw new Error(`duplicate WalletClosed event for ${walletID}`)
    }
    const created = createdByWallet.get(walletID)
    if (!created) {
      throw new Error(
        `WalletClosed has no WalletCreated provenance: ${walletID}`
      )
    }
    if (comparePositions(created.position, closed.position) >= 0) {
      throw new Error(`WalletClosed precedes WalletCreated for ${walletID}`)
    }
    closedByWallet.set(walletID, { ...closed, walletID })
  }

  const entries: ArchiveManifestEntry[] = []
  for (const [walletID] of closedByWallet) {
    const created = createdByWallet.get(walletID)
    if (!created) {
      throw new Error(`internal archive provenance error for ${walletID}`)
    }
    const approvals = history.approved.filter(
      (approved) =>
        normalizeBytes32(approved.resultHash, "approved result hash") ===
          created.dkgResultHash &&
        approved.position.blockNumber === created.position.blockNumber &&
        approved.position.transactionIndex ===
          created.position.transactionIndex &&
        approved.position.logIndex < created.position.logIndex
    )
    if (approvals.length !== 1) {
      throw new Error(
        `WalletCreated lacks unique same-transaction DkgResultApproved provenance: ${walletID}`
      )
    }
    const [approval] = approvals
    const submittedCandidates = history.submitted.filter(
      (submitted) =>
        normalizeBytes32(submitted.resultHash, "submitted result hash") ===
          created.dkgResultHash &&
        comparePositions(submitted.position, approval.position) < 0
    )
    if (submittedCandidates.length === 0) {
      throw new Error(
        `WalletCreated has no prior DkgResultSubmitted provenance: ${walletID}`
      )
    }

    const submitted = submittedCandidates[submittedCandidates.length - 1]
    const submittedWalletID = normalizeBytes32(
      submitted.walletID,
      "submitted wallet ID"
    )
    if (submittedWalletID !== walletID) {
      throw new Error(
        `DKG wallet ID mismatch for ${walletID}: got ${submittedWalletID}`
      )
    }
    const membersIdsHash = normalizeBytes32(
      submitted.membersIdsHash,
      "submitted members IDs hash"
    )
    const encodedMembersIdsHash = normalizeBytes32(
      hashActiveDkgMembers(
        submitted.members,
        submitted.misbehavedMembersIndices
      ),
      "encoded members IDs hash"
    )
    if (membersIdsHash !== encodedMembersIdsHash) {
      throw new Error(`DKG members hash mismatch for ${walletID}`)
    }

    entries.push({
      walletID,
      dkgResultHash: created.dkgResultHash,
      membersIdsHash,
    })
  }

  return entries.sort((left, right) =>
    left.walletID.localeCompare(right.walletID)
  )
}

export const hashWalletHistory = (
  history: FrostWalletHistory,
  ethersUtils: typeof import("ethers").utils = utils
): string => {
  const canonical = JSON.stringify({
    coverage: {
      chainId: history.coverage.chainId,
      registry: normalizeAddress(
        history.coverage.registry,
        "history coverage registry"
      ),
      scanStartBlock: history.coverage.scanStartBlock,
      finalizedBlock: history.coverage.finalizedBlock,
      startParentHash: normalizeBytes32(
        history.coverage.startParentHash,
        "history start parent hash"
      ),
      startBlockHash: normalizeBytes32(
        history.coverage.startBlockHash,
        "history start block hash"
      ),
      finalizedBlockHash: normalizeBytes32(
        history.coverage.finalizedBlockHash,
        "history finalized block hash"
      ),
      historyCommitment: normalizeBytes32(
        history.coverage.historyCommitment,
        "history coverage commitment"
      ),
      blockCount: history.coverage.blockCount,
      transactionCount: history.coverage.transactionCount,
      receiptCount: history.coverage.receiptCount,
      logCount: history.coverage.logCount,
      registryLogCount: history.coverage.registryLogCount,
      registryLogDigest: normalizeBytes32(
        history.coverage.registryLogDigest,
        "history registry log digest"
      ),
      selectedLogCount: history.coverage.selectedLogCount,
      selectedLogDigest: normalizeBytes32(
        history.coverage.selectedLogDigest,
        "history selected log digest"
      ),
      selectionUpperExclusive: history.coverage.selectionUpperExclusive ?? null,
    },
    submitted: history.submitted.map((record) => ({
      resultHash: normalizeBytes32(record.resultHash, "history result hash"),
      walletID: normalizeBytes32(record.walletID, "history wallet ID"),
      membersIdsHash: normalizeBytes32(
        record.membersIdsHash,
        "history members hash"
      ),
      members: record.members,
      misbehavedMembersIndices: record.misbehavedMembersIndices,
      position: record.position,
    })),
    approved: history.approved.map((record) => ({
      resultHash: normalizeBytes32(record.resultHash, "history approval hash"),
      position: record.position,
    })),
    created: history.created.map((record) => ({
      walletID: normalizeBytes32(record.walletID, "history created wallet"),
      dkgResultHash: normalizeBytes32(
        record.dkgResultHash,
        "history created result"
      ),
      position: record.position,
    })),
    closed: history.closed.map((record) => ({
      walletID: normalizeBytes32(record.walletID, "history closed wallet"),
      position: record.position,
    })),
  })
  return ethersUtils.keccak256(ethersUtils.toUtf8Bytes(canonical))
}

const canonicalArchiveEntries = (
  entries: ArchiveManifestEntry[]
): ArchiveManifestEntry[] =>
  entries
    .map((entry) => ({
      walletID: normalizeBytes32(entry.walletID, "checkpoint wallet ID"),
      dkgResultHash: normalizeBytes32(
        entry.dkgResultHash,
        "checkpoint DKG result hash"
      ),
      membersIdsHash: normalizeBytes32(
        entry.membersIdsHash,
        "checkpoint members hash"
      ),
    }))
    .sort((left, right) => left.walletID.localeCompare(right.walletID))

export const hashArchiveCheckpoint = (
  checkpoint: Omit<ArchiveCheckpointV2, "checkpointHash">,
  ethersUtils: typeof import("ethers").utils = utils
): string => {
  const entries = canonicalArchiveEntries(checkpoint.entries)
  const inventory = buildArchiveMerkleTree(entries, ethersUtils)
  const payload = JSON.stringify({
    schemaVersion: checkpoint.schemaVersion,
    chainId: checkpoint.chainId,
    registry: normalizeAddress(checkpoint.registry, "checkpoint registry"),
    scanFromBlock: checkpoint.scanFromBlock,
    checkpointBlockNumber: checkpoint.checkpointBlockNumber,
    checkpointBlockHash: normalizeBytes32(
      checkpoint.checkpointBlockHash,
      "checkpoint block hash"
    ),
    maxTailBlocks: checkpoint.maxTailBlocks,
    upgradeDeadlineBlock: checkpoint.upgradeDeadlineBlock,
    historyRoot: hashWalletHistory(checkpoint.history, ethersUtils),
    inventoryRoot: inventory.root,
    inventoryCount: entries.length,
    entries,
  })
  return ethersUtils.keccak256(ethersUtils.toUtf8Bytes(payload))
}

export const validateArchiveCheckpoint = (
  checkpoint: ArchiveCheckpointV2,
  context: {
    chainId: string
    registry: string
    scanFromBlock: number
    maxTailBlocks: number
  },
  ethersUtils: typeof import("ethers").utils = utils
): void => {
  if (checkpoint.schemaVersion !== ARCHIVE_CHECKPOINT_SCHEMA) {
    throw new Error("unsupported archive checkpoint schema")
  }
  if (
    checkpoint.chainId !== context.chainId ||
    checkpoint.registry.toLowerCase() !== context.registry.toLowerCase() ||
    checkpoint.scanFromBlock !== context.scanFromBlock ||
    checkpoint.maxTailBlocks !== context.maxTailBlocks ||
    checkpoint.maxTailBlocks === 0 ||
    checkpoint.maxTailBlocks > MAX_ARCHIVE_TAIL_BLOCKS ||
    checkpoint.upgradeDeadlineBlock !==
      checkpoint.checkpointBlockNumber + checkpoint.maxTailBlocks
  ) {
    throw new Error("archive checkpoint context mismatch")
  }
  if (
    checkpoint.history.coverage.chainId.toString() !== context.chainId ||
    checkpoint.history.coverage.registry.toLowerCase() !==
      context.registry.toLowerCase() ||
    checkpoint.history.coverage.scanStartBlock !== context.scanFromBlock ||
    checkpoint.history.coverage.finalizedBlock !==
      checkpoint.checkpointBlockNumber ||
    checkpoint.history.coverage.finalizedBlockHash.toLowerCase() !==
      checkpoint.checkpointBlockHash.toLowerCase() ||
    checkpoint.history.coverage.selectionUpperExclusive !== null
  ) {
    throw new Error("archive checkpoint coverage mismatch")
  }
  const selectedCount =
    checkpoint.history.submitted.length +
    checkpoint.history.approved.length +
    checkpoint.history.created.length +
    checkpoint.history.closed.length
  if (checkpoint.history.coverage.selectedLogCount !== selectedCount) {
    throw new Error("archive checkpoint selected-event count mismatch")
  }
  if (
    JSON.stringify(canonicalArchiveEntries(checkpoint.entries)) !==
    JSON.stringify(
      canonicalArchiveEntries(deriveArchiveEntries(checkpoint.history))
    )
  ) {
    throw new Error("archive checkpoint inventory mismatch")
  }
  const unsignedCheckpoint = { ...checkpoint }
  Reflect.deleteProperty(unsignedCheckpoint, "checkpointHash")
  if (
    checkpoint.checkpointHash.toLowerCase() !==
    hashArchiveCheckpoint(unsignedCheckpoint, ethersUtils).toLowerCase()
  ) {
    throw new Error("archive checkpoint hash mismatch")
  }
}

export const buildArchiveCheckpointAttestation = (
  checkpoint: ArchiveCheckpointV2,
  role: string,
  attester: string,
  sourceIdentityHash: string,
  endpointIdentityHash: string,
  trustDomainHash: string,
  endpointPolicyHash: string,
  ethersUtils: typeof import("ethers").utils = utils
): ArchiveCheckpointAttestation => {
  const inventory = buildArchiveMerkleTree(checkpoint.entries, ethersUtils)
  return {
    chainId: checkpoint.chainId,
    registry: checkpoint.registry,
    role,
    attester,
    checkpointHash: checkpoint.checkpointHash,
    scanFromBlock: checkpoint.scanFromBlock,
    checkpointBlockNumber: checkpoint.checkpointBlockNumber,
    checkpointBlockHash: checkpoint.checkpointBlockHash,
    historyCommitment: checkpoint.history.coverage.historyCommitment,
    inventoryRoot: inventory.root,
    inventoryCount: inventory.entries.length,
    maxTailBlocks: checkpoint.maxTailBlocks,
    upgradeDeadlineBlock: checkpoint.upgradeDeadlineBlock,
    sourceIdentityHash,
    endpointIdentityHash,
    trustDomainHash,
    endpointPolicyHash,
    schemaHash: ARCHIVE_CHECKPOINT_ATTESTATION_SCHEMA_HASH,
  }
}

export const validateArchiveCheckpointAttestation = (
  checkpoint: ArchiveCheckpointV2,
  attestation: ArchiveCheckpointAttestation,
  expectedRole: string,
  ethersUtils: typeof import("ethers").utils = utils
): void => {
  const inventory = buildArchiveMerkleTree(checkpoint.entries, ethersUtils)
  if (
    attestation.chainId !== checkpoint.chainId ||
    attestation.registry.toLowerCase() !== checkpoint.registry.toLowerCase() ||
    attestation.role.toLowerCase() !== expectedRole.toLowerCase() ||
    attestation.checkpointHash.toLowerCase() !==
      checkpoint.checkpointHash.toLowerCase() ||
    attestation.scanFromBlock !== checkpoint.scanFromBlock ||
    attestation.checkpointBlockNumber !== checkpoint.checkpointBlockNumber ||
    attestation.checkpointBlockHash.toLowerCase() !==
      checkpoint.checkpointBlockHash.toLowerCase() ||
    attestation.historyCommitment.toLowerCase() !==
      checkpoint.history.coverage.historyCommitment.toLowerCase() ||
    attestation.inventoryRoot.toLowerCase() !== inventory.root.toLowerCase() ||
    attestation.inventoryCount !== inventory.entries.length ||
    attestation.maxTailBlocks !== checkpoint.maxTailBlocks ||
    attestation.upgradeDeadlineBlock !== checkpoint.upgradeDeadlineBlock ||
    attestation.schemaHash.toLowerCase() !==
      ARCHIVE_CHECKPOINT_ATTESTATION_SCHEMA_HASH.toLowerCase()
  ) {
    throw new Error("archive checkpoint attestation context mismatch")
  }
}

export const buildArchiveManifestAttestation = (
  manifest: ArchiveManifestV2,
  manifestHash: string,
  role: string,
  attester: string
): ArchiveManifestAttestation => ({
  chainId: manifest.chainId,
  registry: manifest.registry,
  role,
  attester,
  manifestHash,
  checkpointHash: manifest.checkpointHash,
  upgradeBlockNumber: manifest.upgradeBlockNumber,
  upgradeBlockHash: manifest.upgradeBlockHash,
  upgradeTransactionIndex: manifest.upgradeTransactionIndex,
  historyRoot: manifest.historyRoot,
  walletsRoot: manifest.walletsRoot,
  walletCount: manifest.walletCount,
  schemaHash: ARCHIVE_MANIFEST_ATTESTATION_SCHEMA_HASH,
})

export const validateArchiveManifestAttestation = (
  manifest: ArchiveManifestV2,
  manifestHash: string,
  attestation: ArchiveManifestAttestation,
  expectedRole: string,
  expectedAttester: string
): void => {
  const expected = buildArchiveManifestAttestation(
    manifest,
    manifestHash,
    expectedRole,
    expectedAttester
  )
  if (JSON.stringify(attestation) !== JSON.stringify(expected)) {
    throw new Error("archive manifest attestation context mismatch")
  }
}

export const hashCombinedArchiveHistory = (
  checkpointHash: string,
  tailHistory: FrostWalletHistory,
  entries: ArchiveManifestEntry[],
  ethersUtils: typeof import("ethers").utils = utils
): string => {
  const inventory = buildArchiveMerkleTree(entries, ethersUtils)
  return ethersUtils.keccak256(
    ethersUtils.defaultAbiCoder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [
        ARCHIVE_COMBINED_HISTORY_DOMAIN,
        checkpointHash,
        hashWalletHistory(tailHistory, ethersUtils),
        inventory.root,
        inventory.entries.length,
      ]
    )
  )
}

export const mergeWalletHistory = (
  checkpoint: FrostWalletHistory,
  tail: FrostWalletHistory
): FrostWalletHistory => ({
  // The combined signed root separately commits both coverage certificates.
  // This field is used only for provenance derivation, not direct hashing.
  coverage: tail.coverage,
  submitted: [...checkpoint.submitted, ...tail.submitted].sort((left, right) =>
    comparePositions(left.position, right.position)
  ),
  approved: [...checkpoint.approved, ...tail.approved].sort((left, right) =>
    comparePositions(left.position, right.position)
  ),
  created: [...checkpoint.created, ...tail.created].sort((left, right) =>
    comparePositions(left.position, right.position)
  ),
  closed: [...checkpoint.closed, ...tail.closed].sort((left, right) =>
    comparePositions(left.position, right.position)
  ),
})

const canonicalManifestPayload = (manifest: ArchiveManifestPayload): string => {
  const entries = manifest.entries
    .map((entry) => ({
      walletID: normalizeBytes32(entry.walletID, "manifest wallet ID"),
      dkgResultHash: normalizeBytes32(
        entry.dkgResultHash,
        "manifest DKG result hash"
      ),
      membersIdsHash: normalizeBytes32(
        entry.membersIdsHash,
        "manifest members IDs hash"
      ),
    }))
    .sort((left, right) => left.walletID.localeCompare(right.walletID))

  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    networkName: manifest.networkName,
    chainId: manifest.chainId,
    registry: normalizeAddress(manifest.registry, "manifest registry"),
    scanFromBlock: manifest.scanFromBlock,
    scanToBlock: manifest.scanToBlock,
    scanToBlockHash: normalizeBytes32(
      manifest.scanToBlockHash,
      "manifest snapshot hash"
    ),
    entries,
  })
}

export const hashArchiveManifestPayload = (
  manifest: ArchiveManifestPayload,
  ethersUtils: typeof import("ethers").utils
): string =>
  ethersUtils.keccak256(
    ethersUtils.toUtf8Bytes(canonicalManifestPayload(manifest))
  )

export const validateSignedArchiveManifest = (
  manifest: SignedArchiveManifest,
  expectedEntries: ArchiveManifestEntry[],
  context: ArchiveManifestContext,
  ethersUtils: typeof import("ethers").utils
): void => {
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) {
    throw new Error(
      `unsupported archive manifest schema: ${manifest.schemaVersion}`
    )
  }
  if (manifest.networkName !== context.networkName) {
    throw new Error("archive manifest network mismatch")
  }
  if (manifest.chainId !== context.chainId) {
    throw new Error("archive manifest chain ID mismatch")
  }
  if (
    normalizeAddress(manifest.registry, "manifest registry") !==
    normalizeAddress(context.registry, "expected registry")
  ) {
    throw new Error("archive manifest registry mismatch")
  }
  if (manifest.scanFromBlock !== context.scanFromBlock) {
    throw new Error("archive manifest start block mismatch")
  }
  if (manifest.scanToBlock !== context.scanToBlock) {
    throw new Error("archive manifest snapshot block mismatch")
  }
  if (
    normalizeBytes32(manifest.scanToBlockHash, "manifest snapshot hash") !==
    normalizeBytes32(context.scanToBlockHash, "expected snapshot hash")
  ) {
    throw new Error("archive manifest snapshot hash mismatch")
  }

  const payloadHash = hashArchiveManifestPayload(manifest, ethersUtils)
  if (
    normalizeBytes32(manifest.payloadHash, "manifest payload hash") !==
    payloadHash.toLowerCase()
  ) {
    throw new Error("archive manifest payload hash mismatch")
  }
  const recoveredSigner = ethersUtils.verifyMessage(
    ethersUtils.arrayify(payloadHash),
    manifest.signature
  )
  if (
    normalizeAddress(recoveredSigner, "recovered manifest signer") !==
      normalizeAddress(manifest.signer, "manifest signer") ||
    normalizeAddress(manifest.signer, "manifest signer") !==
      normalizeAddress(context.requiredSigner, "required manifest signer")
  ) {
    throw new Error("archive manifest signature mismatch")
  }

  const expected = new Map(
    expectedEntries.map((entry) => [entry.walletID.toLowerCase(), entry])
  )
  const actual = new Map<string, ArchiveManifestEntry>()
  for (const entry of manifest.entries) {
    const walletID = normalizeBytes32(entry.walletID, "manifest wallet ID")
    if (actual.has(walletID)) {
      throw new Error(`duplicate archive manifest wallet: ${walletID}`)
    }
    actual.set(walletID, entry)
  }
  if (actual.size !== expected.size) {
    throw new Error(
      `archive manifest count mismatch: expected ${expected.size}, got ${actual.size}`
    )
  }
  for (const [walletID, expectedEntry] of expected) {
    const actualEntry = actual.get(walletID)
    if (!actualEntry) {
      throw new Error(`archive manifest is missing wallet ${walletID}`)
    }
    if (
      normalizeBytes32(actualEntry.dkgResultHash, "manifest result hash") !==
        expectedEntry.dkgResultHash.toLowerCase() ||
      normalizeBytes32(actualEntry.membersIdsHash, "manifest members hash") !==
        expectedEntry.membersIdsHash.toLowerCase()
    ) {
      throw new Error(`archive manifest entry mismatch for ${walletID}`)
    }
  }
}

export const zeroRuntimeLinks = (
  runtime: string,
  references: RuntimeLinkReference[]
): string => {
  for (const reference of references) {
    if (reference.length !== 20) {
      throw new Error(`unexpected library link length: ${reference.length}`)
    }
  }
  return zeroRuntimeReferences(runtime, references)
}

const zeroRuntimeReferences = (
  runtime: string,
  references: RuntimeLinkReference[]
): string => {
  let normalized = runtime
  for (const reference of references) {
    const start = 2 + reference.start * 2
    const end = start + reference.length * 2
    if (end > normalized.length) {
      throw new Error("library link reference exceeds runtime length")
    }
    normalized =
      normalized.slice(0, start) +
      "00".repeat(reference.length) +
      normalized.slice(end)
  }
  return normalized
}

export const assertRuntimeLinks = (
  runtime: string,
  references: RuntimeLinkReference[],
  expectedLibrary: string
): void => {
  if (references.length === 0) {
    throw new Error("FrostInactivity has no implementation link references")
  }
  const expected = normalizeAddress(expectedLibrary, "expected library").slice(
    2
  )
  for (const reference of references) {
    if (reference.length !== 20) {
      throw new Error(`unexpected library link length: ${reference.length}`)
    }
    const start = 2 + reference.start * 2
    const actual = runtime.slice(start, start + 40).toLowerCase()
    if (actual !== expected) {
      throw new Error(
        `implementation FrostInactivity link mismatch at byte ${reference.start}`
      )
    }
  }
}

export const normalizeLibraryRuntime = (runtime: string): string => {
  if (!/^0x73[0-9a-fA-F]+$/.test(runtime) || runtime.length < 44) {
    throw new Error("malformed deployed FrostInactivity runtime")
  }
  return `${runtime.slice(0, 4)}${"00".repeat(20)}${runtime.slice(44)}`
}

const allLinkReferences = (artifact: {
  deployedLinkReferences: Record<string, Record<string, RuntimeLinkReference[]>>
}): RuntimeLinkReference[] =>
  Object.values(artifact.deployedLinkReferences).flatMap((byLibrary) =>
    Object.values(byLibrary).flat()
  )

const frostInactivityLinkReferences = (artifact: {
  deployedLinkReferences: Record<string, Record<string, RuntimeLinkReference[]>>
}): RuntimeLinkReference[] =>
  Object.values(artifact.deployedLinkReferences).flatMap(
    (byLibrary) => byLibrary.FrostInactivity ?? []
  )

/// Rebuilds both the transaction and receipt tries for the block before
/// exposing any log. The returned logs are therefore complete with respect to
/// the canonical header, not merely complete with respect to an RPC response.
export const readCanonicalBlockLogs = async (
  hre: HardhatRuntimeEnvironment,
  blockNumber: number
): Promise<providers.Log[]> => {
  const scan = await scanCanonicalHistory(
    hre.ethers.provider,
    hre.ethers.constants.AddressZero,
    blockNumber,
    blockNumber,
    []
  )
  return scan.allLogs
}

export const scanWalletHistoryWithProvider = async (
  hre: HardhatRuntimeEnvironment,
  provider: providers.Provider,
  registryAddress: string,
  scanFromBlock: number,
  snapshotBlock: number,
  upperExclusive?: LogPosition
): Promise<FrostWalletHistory> => {
  const artifact = await hre.artifacts.readArtifact("FrostWalletRegistry")
  const registryInterface = new hre.ethers.utils.Interface(artifact.abi)
  const topics = [
    registryInterface.getEventTopic("DkgResultSubmitted"),
    registryInterface.getEventTopic("DkgResultApproved"),
    registryInterface.getEventTopic("WalletCreated"),
    registryInterface.getEventTopic("WalletClosed"),
  ]
  const canonical = await scanCanonicalHistory(
    provider,
    registryAddress,
    scanFromBlock,
    snapshotBlock,
    topics,
    upperExclusive
  )
  const history: FrostWalletHistory = {
    coverage: canonical.evidence,
    submitted: [],
    approved: [],
    created: [],
    closed: [],
  }

  for (const log of canonical.selectedLogs) {
    const parsed = registryInterface.parseLog(log)
    if (parsed.name === "DkgResultSubmitted") {
      const { result } = parsed.args
      const members = result.members.map(
        (member: { toNumber(): number } | number) =>
          typeof member === "number" ? member : member.toNumber()
      )
      const misbehavedMembersIndices = result.misbehavedMembersIndices.map(
        (member: { toNumber(): number } | number) =>
          typeof member === "number" ? member : member.toNumber()
      )
      history.submitted.push({
        resultHash: parsed.args.resultHash,
        walletID: result.xOnlyOutputKey,
        membersIdsHash: result.membersHash,
        members,
        misbehavedMembersIndices,
        position: positionOf(log),
      })
    } else if (parsed.name === "DkgResultApproved") {
      history.approved.push({
        resultHash: parsed.args.resultHash,
        position: positionOf(log),
      })
    } else if (parsed.name === "WalletCreated") {
      history.created.push({
        walletID: parsed.args.walletID,
        dkgResultHash: parsed.args.dkgResultHash,
        position: positionOf(log),
      })
    } else if (parsed.name === "WalletClosed") {
      history.closed.push({
        walletID: parsed.args.walletID,
        position: positionOf(log),
      })
    }
  }

  history.submitted.sort((left, right) =>
    comparePositions(left.position, right.position)
  )
  history.approved.sort((left, right) =>
    comparePositions(left.position, right.position)
  )
  history.created.sort((left, right) =>
    comparePositions(left.position, right.position)
  )
  history.closed.sort((left, right) =>
    comparePositions(left.position, right.position)
  )
  return history
}

export const scanWalletHistory = async (
  hre: HardhatRuntimeEnvironment,
  registryAddress: string,
  scanFromBlock: number,
  snapshotBlock: number,
  upperExclusive?: LogPosition
): Promise<FrostWalletHistory> =>
  scanWalletHistoryWithProvider(
    hre,
    hre.ethers.provider,
    registryAddress,
    scanFromBlock,
    snapshotBlock,
    upperExclusive
  )

export const assertIndependentWalletHistory = (
  primary: FrostWalletHistory,
  independent: FrostWalletHistory
): void => {
  if (JSON.stringify(primary) !== JSON.stringify(independent)) {
    throw new Error("independent canonical wallet history rebuild mismatch")
  }
}

export const assertCheckpointHeadCanonical = async (
  primary: providers.Provider,
  independent: providers.Provider,
  checkpoint: ArchiveCheckpointV2
): Promise<void> => {
  const [primaryHead, independentHead] = await Promise.all([
    scanCanonicalHistory(
      primary,
      checkpoint.registry,
      checkpoint.checkpointBlockNumber,
      checkpoint.checkpointBlockNumber,
      []
    ),
    scanCanonicalHistory(
      independent,
      checkpoint.registry,
      checkpoint.checkpointBlockNumber,
      checkpoint.checkpointBlockNumber,
      []
    ),
  ])
  if (
    primaryHead.evidence.finalizedBlockHash.toLowerCase() !==
      checkpoint.checkpointBlockHash.toLowerCase() ||
    JSON.stringify(primaryHead.evidence) !==
      JSON.stringify(independentHead.evidence)
  ) {
    throw new Error("archive checkpoint head is no longer canonical")
  }
}

const parseRequiredUint = (name: string): number => {
  const raw = process.env[name]
  if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${name} must be an explicit non-negative integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} exceeds the safe integer range`)
  }
  return value
}

const parseRequiredAddress = (name: string): string => {
  const raw = process.env[name]
  if (!raw || !utils.isAddress(raw)) {
    throw new Error(`${name} must be an explicit address`)
  }
  return utils.getAddress(raw)
}

const parseRequiredBytes32 = (name: string): string => {
  const raw = process.env[name]
  if (!raw) throw new Error(`${name} is required`)
  return normalizeBytes32(raw, name)
}

const attestationIdentity = (
  prefix: "SOURCE" | "RECONCILER"
): {
  attester: string
  sourceIdentityHash: string
  endpointIdentityHash: string
  trustDomainHash: string
  endpointPolicyHash: string
} => ({
  attester: parseRequiredAddress(`FROST_ARCHIVE_${prefix}_ATTESTER`),
  sourceIdentityHash: parseRequiredBytes32(
    `FROST_ARCHIVE_${prefix}_IDENTITY_HASH`
  ),
  endpointIdentityHash: parseRequiredBytes32(
    `FROST_ARCHIVE_${prefix}_ENDPOINT_IDENTITY_HASH`
  ),
  trustDomainHash: parseRequiredBytes32(
    `FROST_ARCHIVE_${prefix}_TRUST_DOMAIN_HASH`
  ),
  endpointPolicyHash: parseRequiredBytes32(
    `FROST_ARCHIVE_${prefix}_ENDPOINT_POLICY_HASH`
  ),
})

const getIndependentArchiveProvider = async (
  hre: HardhatRuntimeEnvironment,
  chainId: string
): Promise<providers.JsonRpcProvider> => {
  const independentRpcUrl =
    process.env.FROST_ARCHIVE_INDEPENDENT_RPC_URL?.trim()
  if (!independentRpcUrl) {
    throw new Error("FROST_ARCHIVE_INDEPENDENT_RPC_URL is required")
  }
  const primaryRpcUrl = (
    hre.ethers.provider as providers.JsonRpcProvider & {
      connection?: { url?: string }
    }
  ).connection?.url
  if (primaryRpcUrl && primaryRpcUrl === independentRpcUrl) {
    throw new Error("archive history sources must be independent")
  }
  const provider = new hre.ethers.providers.JsonRpcProvider(independentRpcUrl)
  if ((await provider.getNetwork()).chainId.toString() !== chainId) {
    throw new Error("independent archive history chain ID mismatch")
  }
  return provider
}

const extractRevertData = (error: unknown): string => {
  const candidate = error as {
    data?: string
    error?: { data?: string }
  }
  return candidate.data ?? candidate.error?.data ?? ""
}

export const ARCHIVE_PHASE_SCHEMA =
  "tbtc/frost-wallet-archive/phase-v5" as const
const MIGRATION_STARTED_TOPIC = utils.id(
  "WalletArchiveMigrationStarted(address,uint256,bytes32,bytes32,bytes32,uint256,uint256,uint256,address,bytes32,address,bytes32)"
)

export interface ArchiveAction {
  target: string
  value: string
  data: string
  description: string
}

export interface ArchiveTimelockActions {
  timelock: string
  delay: string
  predecessor: string
  salt: string
  schedule: ArchiveAction
  execute: ArchiveAction
}

export interface ArchivePhaseArtifact {
  schemaVersion: typeof ARCHIVE_PHASE_SCHEMA
  networkName: string
  chainId: string
  proxy: string
  proxyAdmin: string
  proxyAdminOwner: string
  governance: string
  authority: string
  oldImplementation: string
  oldImplementationCodeHash: string
  implementation: string
  implementationCodeHash: string
  frostInactivity: string
  frostInactivityCodeHash: string
  searchFromBlock: number
  phase:
    | "pending-start-authorization"
    | "prepared"
    | "pending-finality"
    | "pending-signature"
    | "pending-commit"
    | "manifest-committed"
    | "executed"
  startAuthorization?: ArchiveMigrationStartAuthorization
  startAuthorizationHash?: string
  upgrade?: ArchiveAction
  timelock?: ArchiveTimelockActions
  upgradeBlockNumber?: number
  upgradeBlockHash?: string
  upgradeTransactionIndex?: number
  manifest?: ArchiveManifestV2
  manifestHash?: string
  proofEntries?: ArchiveManifestProofEntry[]
  checkpoint?: ArchiveCheckpointV2
  checkpointAttestationRequests?: {
    source: ArchiveCheckpointAttestation
    reconciler: ArchiveCheckpointAttestation
  }
  checkpointAttestations?: {
    source: SignedArchiveCheckpointAttestation
    reconciler: SignedArchiveCheckpointAttestation
  }
  manifestAttestationRequests?: {
    source: ArchiveManifestAttestation
    reconciler: ArchiveManifestAttestation
  }
  manifestAttestations?: {
    source: SignedArchiveManifestAttestation
    reconciler: SignedArchiveManifestAttestation
  }
  commit?: ArchiveAction
  commitTimelock?: ArchiveTimelockActions
  previousArtifactHash?: string
  artifactHash?: string
}

const archivePhasePath = (): string => {
  const value = process.env.FROST_ARCHIVE_ARTIFACT_PATH
  if (!value) throw new Error("FROST_ARCHIVE_ARTIFACT_PATH is required")
  return value
}

const archiveCheckpointPath = (): string => {
  const value = process.env.FROST_ARCHIVE_CHECKPOINT_PATH
  if (!value) throw new Error("FROST_ARCHIVE_CHECKPOINT_PATH is required")
  return value
}

export const readArchiveCheckpoint = (
  checkpointPath: string
): ArchiveCheckpointV2 | undefined => {
  if (!fs.existsSync(checkpointPath)) return undefined
  strictFileMode(checkpointPath)
  return JSON.parse(
    fs.readFileSync(checkpointPath, "utf8")
  ) as ArchiveCheckpointV2
}

export type DurableWriteFailpoint = "after-file-sync" | "after-rename"

const strictFileMode = (filePath: string): void => {
  if (fs.statSync(filePath).mode % 0o1000 !== 0o600) {
    throw new Error(`archive artifact must have mode 0600: ${filePath}`)
  }
}

const fsyncDirectory = (directory: string): void => {
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(directoryFd)
  } finally {
    fs.closeSync(directoryFd)
  }
}

const fsyncFile = (filePath: string): void => {
  const fileFd = fs.openSync(filePath, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(fileFd)
  } finally {
    fs.closeSync(fileFd)
  }
}

const writeDurableFile = (
  filePath: string,
  contents: string,
  replace: boolean,
  failpoint?: DurableWriteFailpoint
): void => {
  const directory = path.dirname(filePath)
  const temporaryPath = `${filePath}.tmp`
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

  if (!replace && fs.existsSync(filePath)) {
    strictFileMode(filePath)
    if (fs.readFileSync(filePath, "utf8") !== contents) {
      throw new Error(`immutable archive artifact already exists: ${filePath}`)
    }
    fsyncFile(filePath)
    fsyncDirectory(directory)
    return
  }

  const fileFd = fs.openSync(
    temporaryPath,
    fs.constants.O_CREAT + fs.constants.O_TRUNC + fs.constants.O_WRONLY,
    0o600
  )
  try {
    fs.fchmodSync(fileFd, 0o600)
    fs.writeFileSync(fileFd, contents, "utf8")
    fs.fsyncSync(fileFd)
  } finally {
    fs.closeSync(fileFd)
  }
  if (failpoint === "after-file-sync") {
    throw new Error("archive durable-write failpoint after file sync")
  }

  if (!replace && fs.existsSync(filePath)) {
    strictFileMode(filePath)
    if (fs.readFileSync(filePath, "utf8") !== contents) {
      throw new Error(`immutable archive artifact already exists: ${filePath}`)
    }
    fs.unlinkSync(temporaryPath)
    fsyncDirectory(directory)
    return
  }
  fs.renameSync(temporaryPath, filePath)
  strictFileMode(filePath)
  if (failpoint === "after-rename") {
    throw new Error("archive durable-write failpoint after rename")
  }
  fsyncDirectory(directory)
}

export const writeArchiveCheckpoint = (
  checkpointPath: string,
  checkpoint: ArchiveCheckpointV2,
  failpoint?: DurableWriteFailpoint
): void => {
  writeDurableFile(
    checkpointPath,
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    false,
    failpoint
  )
}

const archivePhasePayload = (
  artifact: ArchivePhaseArtifact
): Omit<ArchivePhaseArtifact, "artifactHash"> => {
  const payload = { ...artifact }
  Reflect.deleteProperty(payload, "artifactHash")
  return payload as Omit<ArchivePhaseArtifact, "artifactHash">
}

const archivePhaseContent = (artifact: ArchivePhaseArtifact): string => {
  const payload = archivePhasePayload(artifact)
  Reflect.deleteProperty(payload, "previousArtifactHash")
  return JSON.stringify(payload)
}

export const hashArchivePhaseArtifact = (
  artifact: ArchivePhaseArtifact,
  ethersUtils: typeof import("ethers").utils = utils
): string =>
  ethersUtils.keccak256(
    ethersUtils.toUtf8Bytes(JSON.stringify(archivePhasePayload(artifact)))
  )

export const readArchivePhase = (
  artifactPath: string
): ArchivePhaseArtifact | undefined => {
  if (!fs.existsSync(artifactPath)) return undefined
  const artifact = JSON.parse(
    fs.readFileSync(artifactPath, "utf8")
  ) as ArchivePhaseArtifact
  if (artifact.schemaVersion !== ARCHIVE_PHASE_SCHEMA) {
    throw new Error("unsupported archive phase artifact")
  }
  if (
    !artifact.artifactHash ||
    hashArchivePhaseArtifact(artifact).toLowerCase() !==
      artifact.artifactHash.toLowerCase()
  ) {
    throw new Error("archive phase artifact hash mismatch")
  }
  strictFileMode(artifactPath)
  return artifact
}

const phaseOrder: Record<ArchivePhaseArtifact["phase"], number> = {
  "pending-start-authorization": 0,
  prepared: 1,
  "pending-finality": 2,
  "pending-signature": 3,
  "pending-commit": 4,
  "manifest-committed": 5,
  executed: 6,
}

const assertMonotonicArchivePhase = (
  previous: ArchivePhaseArtifact,
  next: ArchivePhaseArtifact
): void => {
  if (phaseOrder[next.phase] < phaseOrder[previous.phase]) {
    throw new Error("archive phase artifact cannot move backward")
  }
  const mutableKeys = new Set(["phase", "artifactHash", "previousArtifactHash"])
  for (const [key, value] of Object.entries(previous)) {
    if (
      mutableKeys.has(key) ||
      value === undefined ||
      JSON.stringify(value) ===
        JSON.stringify(next[key as keyof ArchivePhaseArtifact])
    ) {
      continue
    }
    throw new Error(`archive phase binding changed: ${key}`)
  }
}

export const writeArchivePhase = (
  artifactPath: string,
  artifact: ArchivePhaseArtifact,
  failpoint?: DurableWriteFailpoint
): void => {
  const previous = readArchivePhase(artifactPath)
  if (
    previous &&
    archivePhaseContent(previous) === archivePhaseContent(artifact)
  ) {
    fsyncFile(artifactPath)
    fsyncDirectory(path.dirname(artifactPath))
    return
  }
  if (previous) {
    const previousArtifactHash = previous.artifactHash
    if (!previousArtifactHash) {
      throw new Error("archive phase artifact hash is missing")
    }
    if (
      artifact.artifactHash &&
      artifact.artifactHash.toLowerCase() !== previousArtifactHash.toLowerCase()
    ) {
      throw new Error("stale archive phase artifact update")
    }
    assertMonotonicArchivePhase(previous, artifact)
  }

  const payload = archivePhasePayload(artifact)
  const next: ArchivePhaseArtifact = {
    ...payload,
    previousArtifactHash: previous?.artifactHash,
  }
  next.artifactHash = hashArchivePhaseArtifact(next)

  const revisionPath = path.join(
    `${artifactPath}.revisions`,
    `${next.artifactHash.slice(2)}.json`
  )
  writeDurableFile(revisionPath, `${JSON.stringify(next, null, 2)}\n`, false)
  writeDurableFile(
    artifactPath,
    `${JSON.stringify(next, null, 2)}\n`,
    true,
    failpoint
  )
}

const asSafeNumber = (value: { toNumber(): number } | number): number =>
  typeof value === "number" ? value : value.toNumber()

const sameManifestV2 = (
  left: ArchiveManifestV2,
  right: ArchiveManifestV2
): boolean =>
  JSON.stringify({
    ...left,
    registry: left.registry.toLowerCase(),
    oldImplementationCodeHash: left.oldImplementationCodeHash.toLowerCase(),
    newImplementationCodeHash: left.newImplementationCodeHash.toLowerCase(),
    sourceAttester: left.sourceAttester.toLowerCase(),
    sourceAttestationHash: left.sourceAttestationHash.toLowerCase(),
    sourceIdentityHash: left.sourceIdentityHash.toLowerCase(),
    sourceEndpointIdentityHash: left.sourceEndpointIdentityHash.toLowerCase(),
    sourceTrustDomainHash: left.sourceTrustDomainHash.toLowerCase(),
    sourceEndpointPolicyHash: left.sourceEndpointPolicyHash.toLowerCase(),
    reconcilerAttester: left.reconcilerAttester.toLowerCase(),
    reconcilerAttestationHash: left.reconcilerAttestationHash.toLowerCase(),
    reconcilerIdentityHash: left.reconcilerIdentityHash.toLowerCase(),
    reconcilerEndpointIdentityHash:
      left.reconcilerEndpointIdentityHash.toLowerCase(),
    reconcilerTrustDomainHash: left.reconcilerTrustDomainHash.toLowerCase(),
    reconcilerEndpointPolicyHash:
      left.reconcilerEndpointPolicyHash.toLowerCase(),
    upgradeBlockHash: left.upgradeBlockHash.toLowerCase(),
    historyRoot: left.historyRoot.toLowerCase(),
    walletsRoot: left.walletsRoot.toLowerCase(),
    schemaHash: left.schemaHash.toLowerCase(),
  }) ===
  JSON.stringify({
    ...right,
    registry: right.registry.toLowerCase(),
    oldImplementationCodeHash: right.oldImplementationCodeHash.toLowerCase(),
    newImplementationCodeHash: right.newImplementationCodeHash.toLowerCase(),
    sourceAttester: right.sourceAttester.toLowerCase(),
    sourceAttestationHash: right.sourceAttestationHash.toLowerCase(),
    sourceIdentityHash: right.sourceIdentityHash.toLowerCase(),
    sourceEndpointIdentityHash: right.sourceEndpointIdentityHash.toLowerCase(),
    sourceTrustDomainHash: right.sourceTrustDomainHash.toLowerCase(),
    sourceEndpointPolicyHash: right.sourceEndpointPolicyHash.toLowerCase(),
    reconcilerAttester: right.reconcilerAttester.toLowerCase(),
    reconcilerAttestationHash: right.reconcilerAttestationHash.toLowerCase(),
    reconcilerIdentityHash: right.reconcilerIdentityHash.toLowerCase(),
    reconcilerEndpointIdentityHash:
      right.reconcilerEndpointIdentityHash.toLowerCase(),
    reconcilerTrustDomainHash: right.reconcilerTrustDomainHash.toLowerCase(),
    reconcilerEndpointPolicyHash:
      right.reconcilerEndpointPolicyHash.toLowerCase(),
    upgradeBlockHash: right.upgradeBlockHash.toLowerCase(),
    historyRoot: right.historyRoot.toLowerCase(),
    walletsRoot: right.walletsRoot.toLowerCase(),
    schemaHash: right.schemaHash.toLowerCase(),
  })

const validateAuthoritySignature = async (
  hre: HardhatRuntimeEnvironment,
  authority: string,
  digest: string,
  signature: string
): Promise<void> => {
  const code = await hre.ethers.provider.getCode(authority)
  if (code === "0x") {
    if (
      hre.ethers.utils.recoverAddress(digest, signature).toLowerCase() !==
      authority.toLowerCase()
    ) {
      throw new Error("archive authority signature mismatch")
    }
    return
  }
  const contractAuthority = new hre.ethers.Contract(
    authority,
    ["function isValidSignature(bytes32,bytes) view returns (bytes4)"],
    hre.ethers.provider
  )
  const magicValue = await contractAuthority.isValidSignature(digest, signature)
  if (magicValue.toLowerCase() !== "0x1626ba7e") {
    throw new Error("archive EIP-1271 authority rejected signature")
  }
}

const loadCheckpointAttestations = async (
  hre: HardhatRuntimeEnvironment,
  requests: {
    source: ArchiveCheckpointAttestation
    reconciler: ArchiveCheckpointAttestation
  }
): Promise<
  | {
      source: SignedArchiveCheckpointAttestation
      reconciler: SignedArchiveCheckpointAttestation
    }
  | undefined
> => {
  const sourcePath = process.env.FROST_ARCHIVE_SOURCE_ATTESTATION_PATH
  const reconcilerPath = process.env.FROST_ARCHIVE_RECONCILER_ATTESTATION_PATH
  if (
    !sourcePath ||
    !reconcilerPath ||
    !fs.existsSync(sourcePath) ||
    !fs.existsSync(reconcilerPath)
  ) {
    return undefined
  }
  const source = JSON.parse(
    fs.readFileSync(sourcePath, "utf8")
  ) as SignedArchiveCheckpointAttestation
  const reconciler = JSON.parse(
    fs.readFileSync(reconcilerPath, "utf8")
  ) as SignedArchiveCheckpointAttestation
  const pairs: Array<
    [SignedArchiveCheckpointAttestation, ArchiveCheckpointAttestation]
  > = [
    [source, requests.source],
    [reconciler, requests.reconciler],
  ]
  for (const [signed, expected] of pairs) {
    const digest = hashArchiveCheckpointAttestation(expected, hre.ethers.utils)
    if (
      JSON.stringify(signed.attestation) !== JSON.stringify(expected) ||
      signed.digest.toLowerCase() !== digest.toLowerCase() ||
      signed.signer.toLowerCase() !== expected.attester.toLowerCase()
    ) {
      throw new Error("archive checkpoint attestation payload mismatch")
    }
    // eslint-disable-next-line no-await-in-loop
    await validateAuthoritySignature(
      hre,
      expected.attester,
      digest,
      signed.signature
    )
  }
  return { source, reconciler }
}

const loadManifestAttestations = async (
  hre: HardhatRuntimeEnvironment,
  requests: {
    source: ArchiveManifestAttestation
    reconciler: ArchiveManifestAttestation
  }
): Promise<
  | {
      source: SignedArchiveManifestAttestation
      reconciler: SignedArchiveManifestAttestation
    }
  | undefined
> => {
  const sourcePath = process.env.FROST_ARCHIVE_SOURCE_MANIFEST_ATTESTATION_PATH
  const reconcilerPath =
    process.env.FROST_ARCHIVE_RECONCILER_MANIFEST_ATTESTATION_PATH
  if (
    !sourcePath ||
    !reconcilerPath ||
    !fs.existsSync(sourcePath) ||
    !fs.existsSync(reconcilerPath)
  ) {
    return undefined
  }
  const source = JSON.parse(
    fs.readFileSync(sourcePath, "utf8")
  ) as SignedArchiveManifestAttestation
  const reconciler = JSON.parse(
    fs.readFileSync(reconcilerPath, "utf8")
  ) as SignedArchiveManifestAttestation
  const pairs: Array<
    [SignedArchiveManifestAttestation, ArchiveManifestAttestation]
  > = [
    [source, requests.source],
    [reconciler, requests.reconciler],
  ]
  for (const [signed, expected] of pairs) {
    const digest = hashArchiveManifestAttestation(expected, hre.ethers.utils)
    if (
      JSON.stringify(signed.attestation) !== JSON.stringify(expected) ||
      signed.digest.toLowerCase() !== digest.toLowerCase() ||
      signed.signer.toLowerCase() !== expected.attester.toLowerCase()
    ) {
      throw new Error("archive manifest attestation payload mismatch")
    }
    // eslint-disable-next-line no-await-in-loop
    await validateAuthoritySignature(
      hre,
      expected.attester,
      digest,
      signed.signature
    )
  }
  return { source, reconciler }
}

export const validateSignedArchiveManifestV2 = (
  signed: SignedArchiveManifestV2,
  expectedManifest: ArchiveManifestV2,
  expectedEntries: ArchiveManifestProofEntry[],
  authority: string,
  ethersUtils: typeof import("ethers").utils = utils
): void => {
  if (signed.schemaVersion !== ARCHIVE_MANIFEST_SCHEMA_V2) {
    throw new Error("unsupported signed archive manifest schema")
  }
  if (!sameManifestV2(signed.manifest, expectedManifest)) {
    throw new Error("signed archive manifest fields mismatch")
  }
  const manifestHash = hashArchiveManifestV2(signed.manifest, ethersUtils)
  if (signed.manifestHash.toLowerCase() !== manifestHash.toLowerCase()) {
    throw new Error("signed archive manifest hash mismatch")
  }
  if (signed.signer.toLowerCase() !== authority.toLowerCase()) {
    throw new Error("signed archive manifest authority mismatch")
  }
  if (signed.entries.length !== expectedEntries.length) {
    throw new Error("signed archive proof count mismatch")
  }
  for (let index = 0; index < expectedEntries.length; index++) {
    const actual = signed.entries[index]
    const expected = expectedEntries[index]
    if (
      actual.index !== expected.index ||
      actual.walletID.toLowerCase() !== expected.walletID.toLowerCase() ||
      actual.dkgResultHash.toLowerCase() !==
        expected.dkgResultHash.toLowerCase() ||
      actual.membersIdsHash.toLowerCase() !==
        expected.membersIdsHash.toLowerCase() ||
      JSON.stringify(actual.proof.map((item) => item.toLowerCase())) !==
        JSON.stringify(expected.proof.map((item) => item.toLowerCase()))
    ) {
      throw new Error(`signed archive proof mismatch at index ${index}`)
    }
  }
}

const findMigrationStart = async (
  provider: providers.Provider,
  proxy: string,
  fromBlock: number
): Promise<{
  blockNumber: number
  blockHash: string
  transactionIndex: number
}> => {
  const latest = await provider.getBlockNumber()
  const matches: providers.Log[] = []
  for (
    let first = fromBlock;
    first <= latest;
    first += RECEIPT_SCAN_CONCURRENCY
  ) {
    const last = Math.min(latest, first + RECEIPT_SCAN_CONCURRENCY - 1)
    const canonical = await scanCanonicalHistory(provider, proxy, first, last, [
      MIGRATION_STARTED_TOPIC,
    ])
    matches.push(...canonical.selectedLogs)
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected one canonical WalletArchiveMigrationStarted event, got ${matches.length}`
    )
  }
  return {
    blockNumber: matches[0].blockNumber,
    blockHash: matches[0].blockHash,
    transactionIndex: matches[0].transactionIndex,
  }
}

export const buildTimelockActions = async (
  hre: HardhatRuntimeEnvironment,
  owner: string,
  directAction: ArchiveAction,
  salt: string,
  requireImmediateExecution = false
): Promise<ArchiveTimelockActions | undefined> => {
  if ((await hre.ethers.provider.getCode(owner)) === "0x") return undefined
  const timelock = new hre.ethers.Contract(
    owner,
    [
      "function getMinDelay() view returns (uint256)",
      "function schedule(address,uint256,bytes,bytes32,bytes32,uint256)",
      "function execute(address,uint256,bytes,bytes32,bytes32)",
    ],
    hre.ethers.provider
  )
  let delay
  try {
    delay = await timelock.getMinDelay()
  } catch (_) {
    return undefined
  }
  if (requireImmediateExecution && !delay.isZero()) {
    throw new Error(
      "atomic archive upgrade requires an immediate Safe/EOA owner or a zero-delay timelock"
    )
  }
  const predecessor = hre.ethers.constants.HashZero
  return {
    timelock: owner,
    delay: delay.toString(),
    predecessor,
    salt,
    schedule: {
      target: owner,
      value: "0",
      data: timelock.interface.encodeFunctionData("schedule", [
        directAction.target,
        directAction.value,
        directAction.data,
        predecessor,
        salt,
        delay,
      ]),
      description: `Schedule: ${directAction.description}`,
    },
    execute: {
      target: owner,
      value: "0",
      data: timelock.interface.encodeFunctionData("execute", [
        directAction.target,
        directAction.value,
        directAction.data,
        predecessor,
        salt,
      ]),
      description: `Execute: ${directAction.description}`,
    },
  }
}

const secureFunc: DeployFunction = async function secureFrostWalletArchive(
  hre: HardhatRuntimeEnvironment
) {
  const { ethers, upgrades, artifacts, deployments } = hre
  const { deployer } = await hre.getNamedAccounts()
  const artifactPath = archivePhasePath()
  const phase = readArchivePhase(artifactPath)
  const chainId = await hre.getChainId()
  const scanFromBlock = parseRequiredUint("FROST_ARCHIVE_SCAN_FROM_BLOCK")
  const minimumConfirmations = parseRequiredUint(
    "FROST_ARCHIVE_MIN_CONFIRMATIONS"
  )
  if (minimumConfirmations === 0 && hre.network.name !== "hardhat") {
    throw new Error("live archive migration requires confirmations")
  }

  const registryDeployment = await deployments.get("FrostWalletRegistry")
  const sortitionPoolDeployment = await deployments.get("FrostSortitionPool")
  if (!registryDeployment.implementation) {
    throw new Error("FrostWalletRegistry implementation metadata is missing")
  }
  const proxy = registryDeployment.address
  const currentImplementation = await upgrades.erc1967.getImplementationAddress(
    proxy
  )
  const proxyAdmin = await upgrades.erc1967.getAdminAddress(proxy)
  const proxyAdminContract = new ethers.Contract(
    proxyAdmin,
    [
      "function owner() view returns (address)",
      "function upgradeAndCall(address,address,bytes)",
    ],
    ethers.provider
  )
  const proxyAdminOwner = await proxyAdminContract.owner()
  const registry = await ethers.getContractAt("FrostWalletRegistry", proxy)
  const governance = await registry.governance()

  const registryArtifact = await artifacts.readArtifact("FrostWalletRegistry")
  const registryBuildInfo = await artifacts.getBuildInfo(
    "contracts/frost-registry/FrostWalletRegistry.sol:FrostWalletRegistry"
  )
  if (
    !registryBuildInfo ||
    registryBuildInfo.solcVersion !== EXPECTED_SOLC_VERSION ||
    registryBuildInfo.solcLongVersion !== EXPECTED_SOLC_LONG_VERSION ||
    registryBuildInfo.input.settings.optimizer?.enabled !== true ||
    registryBuildInfo.input.settings.optimizer?.runs !== 200 ||
    registryBuildInfo.input.settings.metadata?.useLiteralContent !== true
  ) {
    throw new Error("FrostWalletRegistry production compiler/settings mismatch")
  }
  const runtimeBytes = (registryArtifact.deployedBytecode.length - 2) / 2
  if (runtimeBytes > FROST_REGISTRY_MAX_RUNTIME_BYTES) {
    throw new Error(
      "FrostWalletRegistry runtime leaves less than 512 bytes of " +
        `EIP-170 margin: ${runtimeBytes} bytes`
    )
  }
  const registryOutput = registryBuildInfo.output.contracts[
    "contracts/frost-registry/FrostWalletRegistry.sol"
  ].FrostWalletRegistry as unknown as {
    evm: {
      deployedBytecode: {
        immutableReferences: Record<string, RuntimeLinkReference[]>
      }
    }
  }
  const immutableReferences = Object.values(
    registryOutput.evm.deployedBytecode.immutableReferences
  ).flat()
  const registryLinks = allLinkReferences(registryArtifact)
  const normalizeRegistry = (runtime: string): string =>
    ethers.utils.keccak256(
      zeroRuntimeReferences(
        zeroRuntimeLinks(runtime, registryLinks),
        immutableReferences
      )
    )
  if (
    normalizeRegistry(registryArtifact.deployedBytecode) !==
    EXPECTED_UNLINKED_REGISTRY_RUNTIME_HASH
  ) {
    throw new Error("unexpected FrostWalletRegistry runtime artifact")
  }

  let migrationState:
    | {
        state: number
        authority: string
        upgradeBlockNumber: number
        oldImplementationCodeHash: string
        newImplementationCodeHash: string
        walletsRoot: string
        historyRoot: string
        pendingManifestHash: string
        expectedCount: number
        completedCount: number
        checkpointHash: string
        checkpointBlockNumber: number
        maxTailBlocks: number
        upgradeDeadlineBlock: number
        sourceAttester: string
        sourceAttestationHash: string
        sourceIdentityHash: string
        sourceEndpointIdentityHash: string
        sourceTrustDomainHash: string
        sourceEndpointPolicyHash: string
        reconcilerAttester: string
        reconcilerAttestationHash: string
        reconcilerIdentityHash: string
        reconcilerEndpointIdentityHash: string
        reconcilerTrustDomainHash: string
        reconcilerEndpointPolicyHash: string
        finalSourceAttestationHash: string
        finalReconcilerAttestationHash: string
      }
    | undefined
  try {
    const state = await registry.getWalletArchiveMigration()
    const attestations = decodeArchiveAttestationReadback(
      await registry.getWalletArchiveAttestations(),
      ethers.utils
    )
    const finalAttestations = await registry.getWalletArchiveFinalAttestations()
    migrationState = {
      state: asSafeNumber(state.state),
      authority: state.authority,
      upgradeBlockNumber: asSafeNumber(state.upgradeBlockNumber),
      oldImplementationCodeHash: state.oldImplementationCodeHash,
      newImplementationCodeHash: state.newImplementationCodeHash,
      walletsRoot: state.walletsRoot,
      historyRoot: state.historyRoot,
      pendingManifestHash: state.pendingManifestHash,
      expectedCount: asSafeNumber(state.expectedCount),
      completedCount: asSafeNumber(state.completedCount),
      checkpointHash: state.checkpointHash,
      checkpointBlockNumber: asSafeNumber(state.checkpointBlockNumber),
      maxTailBlocks: asSafeNumber(state.maxTailBlocks),
      upgradeDeadlineBlock: asSafeNumber(attestations.upgradeDeadlineBlock),
      sourceAttester: attestations.sourceAttester,
      sourceAttestationHash: attestations.sourceAttestationHash,
      sourceIdentityHash: attestations.sourceIdentityHash,
      sourceEndpointIdentityHash: attestations.sourceEndpointIdentityHash,
      sourceTrustDomainHash: attestations.sourceTrustDomainHash,
      sourceEndpointPolicyHash: attestations.sourceEndpointPolicyHash,
      reconcilerAttester: attestations.reconcilerAttester,
      reconcilerAttestationHash: attestations.reconcilerAttestationHash,
      reconcilerIdentityHash: attestations.reconcilerIdentityHash,
      reconcilerEndpointIdentityHash:
        attestations.reconcilerEndpointIdentityHash,
      reconcilerTrustDomainHash: attestations.reconcilerTrustDomainHash,
      reconcilerEndpointPolicyHash: attestations.reconcilerEndpointPolicyHash,
      finalSourceAttestationHash: finalAttestations.sourceAttestationHash,
      finalReconcilerAttestationHash:
        finalAttestations.reconcilerAttestationHash,
    }
  } catch (error) {
    if (extractRevertData(error) !== "0x") throw error
  }

  if (migrationState?.state === 4) {
    const freshArtifact: ArchivePhaseArtifact = {
      schemaVersion: ARCHIVE_PHASE_SCHEMA,
      networkName: hre.network.name,
      chainId,
      proxy,
      proxyAdmin,
      proxyAdminOwner,
      governance,
      authority: ethers.constants.AddressZero,
      oldImplementation: currentImplementation,
      oldImplementationCodeHash: ethers.utils.keccak256(
        await ethers.provider.getCode(currentImplementation)
      ),
      implementation: currentImplementation,
      implementationCodeHash: ethers.utils.keccak256(
        await ethers.provider.getCode(currentImplementation)
      ),
      frostInactivity: ethers.constants.AddressZero,
      frostInactivityCodeHash: ethers.constants.HashZero,
      searchFromBlock: scanFromBlock,
      phase: "executed",
      upgrade: {
        target: proxyAdmin,
        value: "0",
        data: "0x",
        description: "Fresh proxy; no archive upgrade required",
      },
    }
    writeArchivePhase(artifactPath, freshArtifact)
    deployments.log("FrostWalletRegistry is fresh; archive migration skipped")
    return
  }

  const checkpointPath = archiveCheckpointPath()
  const maxTailBlocks = parseRequiredUint("FROST_ARCHIVE_MAX_TAIL_BLOCKS")
  if (maxTailBlocks === 0 || maxTailBlocks > MAX_ARCHIVE_TAIL_BLOCKS) {
    throw new Error(
      `FROST_ARCHIVE_MAX_TAIL_BLOCKS must be in [1, ${MAX_ARCHIVE_TAIL_BLOCKS}]`
    )
  }
  const independentProvider = await getIndependentArchiveProvider(hre, chainId)

  let currentPhase = phase
  if (
    !currentPhase &&
    migrationState &&
    migrationState.state >= 1 &&
    migrationState.state <= 3
  ) {
    const checkpoint = readArchiveCheckpoint(checkpointPath)
    if (!checkpoint) {
      throw new Error(
        "archive checkpoint is required to resume frozen migration"
      )
    }
    validateArchiveCheckpoint(checkpoint, {
      chainId,
      registry: proxy,
      scanFromBlock,
      maxTailBlocks,
    })
    if (
      checkpoint.checkpointHash.toLowerCase() !==
        migrationState.checkpointHash.toLowerCase() ||
      checkpoint.checkpointBlockNumber !==
        migrationState.checkpointBlockNumber ||
      checkpoint.maxTailBlocks !== migrationState.maxTailBlocks ||
      checkpoint.upgradeDeadlineBlock !== migrationState.upgradeDeadlineBlock ||
      migrationState.sourceAttester === ethers.constants.AddressZero ||
      migrationState.reconcilerAttester === ethers.constants.AddressZero ||
      migrationState.sourceAttestationHash === ethers.constants.HashZero ||
      migrationState.reconcilerAttestationHash === ethers.constants.HashZero ||
      migrationState.sourceIdentityHash === ethers.constants.HashZero ||
      migrationState.sourceEndpointIdentityHash === ethers.constants.HashZero ||
      migrationState.sourceTrustDomainHash === ethers.constants.HashZero ||
      migrationState.sourceEndpointPolicyHash === ethers.constants.HashZero ||
      migrationState.reconcilerIdentityHash === ethers.constants.HashZero ||
      migrationState.reconcilerEndpointIdentityHash ===
        ethers.constants.HashZero ||
      migrationState.reconcilerTrustDomainHash === ethers.constants.HashZero ||
      migrationState.reconcilerEndpointPolicyHash ===
        ethers.constants.HashZero ||
      (migrationState.state === 1 &&
        (migrationState.finalSourceAttestationHash !==
          ethers.constants.HashZero ||
          migrationState.finalReconcilerAttestationHash !==
            ethers.constants.HashZero)) ||
      (migrationState.state >= 2 &&
        (migrationState.finalSourceAttestationHash ===
          ethers.constants.HashZero ||
          migrationState.finalReconcilerAttestationHash ===
            ethers.constants.HashZero))
    ) {
      throw new Error("archive checkpoint does not match on-chain start")
    }
    await assertCheckpointHeadCanonical(
      ethers.provider,
      independentProvider,
      checkpoint
    )
    const currentCode = await ethers.provider.getCode(currentImplementation)
    if (
      ethers.utils.keccak256(currentCode).toLowerCase() !==
        migrationState.newImplementationCodeHash.toLowerCase() ||
      normalizeRegistry(currentCode) !== EXPECTED_UNLINKED_REGISTRY_RUNTIME_HASH
    ) {
      throw new Error("cannot reconstruct archive phase from current code")
    }
    if (migrationState.upgradeBlockNumber === 0) {
      throw new Error("cannot reconstruct archive phase without upgrade block")
    }
    const oldImplementationWord = await ethers.provider.getStorageAt(
      proxy,
      EIP1967_IMPLEMENTATION_SLOT,
      migrationState.upgradeBlockNumber - 1
    )
    const oldImplementation = ethers.utils.getAddress(
      `0x${oldImplementationWord.slice(-40)}`
    )
    const oldCode = await ethers.provider.getCode(oldImplementation)
    if (
      ethers.utils.keccak256(oldCode).toLowerCase() !==
      migrationState.oldImplementationCodeHash.toLowerCase()
    ) {
      throw new Error("cannot reconstruct archive phase from previous code")
    }
    const inactivityAddresses = new Set(
      frostInactivityLinkReferences(registryArtifact).map((reference) => {
        const start = 2 + reference.start * 2
        return ethers.utils.getAddress(
          `0x${currentCode.slice(start, start + reference.length * 2)}`
        )
      })
    )
    if (inactivityAddresses.size !== 1) {
      throw new Error("cannot reconstruct FrostInactivity link address")
    }
    const [frostInactivity] = [...inactivityAddresses]
    const inactivityCode = await ethers.provider.getCode(frostInactivity)
    if (
      ethers.utils.keccak256(normalizeLibraryRuntime(inactivityCode)) !==
      EXPECTED_NORMALIZED_FROST_INACTIVITY_RUNTIME_HASH
    ) {
      throw new Error("cannot reconstruct FrostInactivity runtime")
    }
    currentPhase = {
      schemaVersion: ARCHIVE_PHASE_SCHEMA,
      networkName: hre.network.name,
      chainId,
      proxy,
      proxyAdmin,
      proxyAdminOwner,
      governance,
      authority: migrationState.authority,
      oldImplementation,
      oldImplementationCodeHash: migrationState.oldImplementationCodeHash,
      implementation: currentImplementation,
      implementationCodeHash: migrationState.newImplementationCodeHash,
      frostInactivity,
      frostInactivityCodeHash: ethers.utils.keccak256(inactivityCode),
      searchFromBlock: checkpoint.checkpointBlockNumber + 1,
      phase: "pending-finality",
      upgradeBlockNumber: migrationState.upgradeBlockNumber,
      checkpoint,
    }
    writeArchivePhase(artifactPath, currentPhase)
  }
  if (!currentPhase) {
    const authority = process.env.FROST_ARCHIVE_MANIFEST_AUTHORITY
    if (!authority || !ethers.utils.isAddress(authority)) {
      throw new Error("FROST_ARCHIVE_MANIFEST_AUTHORITY is required")
    }
    const normalizedAuthority = ethers.utils.getAddress(authority)
    if (
      [governance, proxyAdmin, proxyAdminOwner]
        .map((value) => value.toLowerCase())
        .includes(normalizedAuthority.toLowerCase())
    ) {
      throw new Error("archive authority must be independent")
    }

    const inactivityArtifact = await artifacts.readArtifact("FrostInactivity")
    if (
      ethers.utils.keccak256(inactivityArtifact.deployedBytecode) !==
      EXPECTED_NORMALIZED_FROST_INACTIVITY_RUNTIME_HASH
    ) {
      throw new Error("unexpected FrostInactivity runtime artifact")
    }
    const inactivityDeployment = await deployments.deploy(
      "FrostInactivityArchiveV2",
      {
        contract:
          "contracts/frost-registry/libraries/FrostInactivity.sol:FrostInactivity",
        from: deployer,
        log: true,
        waitConfirmations: 1,
      }
    )
    const inactivityCode = await ethers.provider.getCode(
      inactivityDeployment.address
    )
    if (
      ethers.utils.keccak256(normalizeLibraryRuntime(inactivityCode)) !==
      EXPECTED_NORMALIZED_FROST_INACTIVITY_RUNTIME_HASH
    ) {
      throw new Error("deployed FrostInactivity code does not match artifact")
    }

    const deployerSigner = await ethers.getSigner(deployer)
    const registryFactory = await ethers.getContractFactory(
      "FrostWalletRegistry",
      {
        signer: deployerSigner,
        libraries: { FrostInactivity: inactivityDeployment.address },
      }
    )
    const implementation = (await upgrades.prepareUpgrade(
      proxy,
      registryFactory,
      {
        kind: "transparent",
        constructorArgs: [sortitionPoolDeployment.address],
        unsafeAllow: [
          "external-library-linking",
          "constructor",
          "state-variable-immutable",
        ],
      }
    )) as string
    const implementationCode = await ethers.provider.getCode(implementation)
    if (
      implementationCode === "0x" ||
      normalizeRegistry(implementationCode) !==
        EXPECTED_UNLINKED_REGISTRY_RUNTIME_HASH
    ) {
      throw new Error("prepared implementation runtime mismatch")
    }
    assertRuntimeLinks(
      implementationCode,
      frostInactivityLinkReferences(registryArtifact),
      inactivityDeployment.address
    )

    const oldImplementationCode = await ethers.provider.getCode(
      currentImplementation
    )
    const codeAtScanStart = await ethers.provider.getCode(proxy, scanFromBlock)
    const codeBeforeScanStart =
      scanFromBlock === 0
        ? "0x"
        : await ethers.provider.getCode(proxy, scanFromBlock - 1)
    if (codeAtScanStart === "0x" || codeBeforeScanStart !== "0x") {
      throw new Error("archive scan start does not prove proxy creation")
    }

    let checkpoint = readArchiveCheckpoint(checkpointPath)
    if (checkpoint) {
      validateArchiveCheckpoint(checkpoint, {
        chainId,
        registry: proxy,
        scanFromBlock,
        maxTailBlocks,
      })
      await assertCheckpointHeadCanonical(
        ethers.provider,
        independentProvider,
        checkpoint
      )
    } else {
      const latestCheckpointHead = await ethers.provider.getBlockNumber()
      const checkpointBlockNumber = latestCheckpointHead - minimumConfirmations
      if (checkpointBlockNumber < scanFromBlock) {
        throw new Error("not enough finalized history for archive checkpoint")
      }
      const [checkpointHistory, independentCheckpointHistory] =
        await Promise.all([
          scanWalletHistory(hre, proxy, scanFromBlock, checkpointBlockNumber),
          scanWalletHistoryWithProvider(
            hre,
            independentProvider,
            proxy,
            scanFromBlock,
            checkpointBlockNumber
          ),
        ])
      assertIndependentWalletHistory(
        checkpointHistory,
        independentCheckpointHistory
      )
      const checkpointEntries = deriveArchiveEntries(checkpointHistory)
      const unsignedCheckpoint: Omit<ArchiveCheckpointV2, "checkpointHash"> = {
        schemaVersion: ARCHIVE_CHECKPOINT_SCHEMA,
        chainId,
        registry: proxy,
        scanFromBlock,
        checkpointBlockNumber,
        checkpointBlockHash: checkpointHistory.coverage.finalizedBlockHash,
        maxTailBlocks,
        upgradeDeadlineBlock: checkpointBlockNumber + maxTailBlocks,
        history: checkpointHistory,
        entries: checkpointEntries,
      }
      checkpoint = {
        ...unsignedCheckpoint,
        checkpointHash: hashArchiveCheckpoint(unsignedCheckpoint, ethers.utils),
      }
      validateArchiveCheckpoint(checkpoint, {
        chainId,
        registry: proxy,
        scanFromBlock,
        maxTailBlocks,
      })
      writeArchiveCheckpoint(checkpointPath, checkpoint)
    }
    if (
      (await ethers.provider.getBlockNumber()) -
        checkpoint.checkpointBlockNumber >=
      checkpoint.maxTailBlocks
    ) {
      throw new Error("archive checkpoint tail budget is exhausted")
    }
    const searchFromBlock = checkpoint.checkpointBlockNumber + 1
    const sourceIdentity = attestationIdentity("SOURCE")
    const reconcilerIdentity = attestationIdentity("RECONCILER")
    const checkpointAttestationRequests = {
      source: buildArchiveCheckpointAttestation(
        checkpoint,
        ARCHIVE_SOURCE_ATTESTATION_ROLE,
        sourceIdentity.attester,
        sourceIdentity.sourceIdentityHash,
        sourceIdentity.endpointIdentityHash,
        sourceIdentity.trustDomainHash,
        sourceIdentity.endpointPolicyHash,
        ethers.utils
      ),
      reconciler: buildArchiveCheckpointAttestation(
        checkpoint,
        ARCHIVE_RECONCILER_ATTESTATION_ROLE,
        reconcilerIdentity.attester,
        reconcilerIdentity.sourceIdentityHash,
        reconcilerIdentity.endpointIdentityHash,
        reconcilerIdentity.trustDomainHash,
        reconcilerIdentity.endpointPolicyHash,
        ethers.utils
      ),
    }
    assertDistinctCheckpointAttestations(
      checkpointAttestationRequests.source,
      checkpointAttestationRequests.reconciler
    )
    for (const attester of [
      sourceIdentity.attester,
      reconcilerIdentity.attester,
    ]) {
      if (
        [governance, proxyAdmin, proxyAdminOwner, normalizedAuthority]
          .map((value) => value.toLowerCase())
          .includes(attester.toLowerCase())
      ) {
        throw new Error("archive checkpoint attesters must be independent")
      }
    }
    const sourceAttestationHash = hashArchiveCheckpointAttestation(
      checkpointAttestationRequests.source,
      ethers.utils
    )
    const reconcilerAttestationHash = hashArchiveCheckpointAttestation(
      checkpointAttestationRequests.reconciler,
      ethers.utils
    )
    const startAuthorization: ArchiveMigrationStartAuthorization = {
      chainId,
      registry: proxy,
      oldImplementationCodeHash: ethers.utils.keccak256(oldImplementationCode),
      newImplementationCodeHash: ethers.utils.keccak256(implementationCode),
      authority: normalizedAuthority,
      checkpointHash: checkpoint.checkpointHash,
      checkpointBlockNumber: checkpoint.checkpointBlockNumber,
      maxTailBlocks: checkpoint.maxTailBlocks,
      upgradeDeadlineBlock: checkpoint.upgradeDeadlineBlock,
      sourceAttester: checkpointAttestationRequests.source.attester,
      sourceAttestationHash,
      reconcilerAttester: checkpointAttestationRequests.reconciler.attester,
      reconcilerAttestationHash,
      schemaHash: ARCHIVE_START_SCHEMA_HASH,
    }
    const startAuthorizationHash = hashArchiveMigrationStart(
      startAuthorization,
      ethers.utils
    )
    const basePhase: ArchivePhaseArtifact = {
      schemaVersion: ARCHIVE_PHASE_SCHEMA,
      networkName: hre.network.name,
      chainId,
      proxy,
      proxyAdmin,
      proxyAdminOwner,
      governance,
      authority: normalizedAuthority,
      oldImplementation: currentImplementation,
      oldImplementationCodeHash: startAuthorization.oldImplementationCodeHash,
      implementation,
      implementationCodeHash: startAuthorization.newImplementationCodeHash,
      frostInactivity: inactivityDeployment.address,
      frostInactivityCodeHash: ethers.utils.keccak256(inactivityCode),
      searchFromBlock,
      phase: "pending-start-authorization",
      startAuthorization,
      startAuthorizationHash,
      checkpoint,
      checkpointAttestationRequests,
    }
    writeArchivePhase(artifactPath, basePhase)
    deployments.log(
      `Archive checkpoint ${checkpoint.checkpointHash} awaits dual attestations and start authorization`
    )
    return
  }

  if (
    currentPhase.networkName !== hre.network.name ||
    currentPhase.chainId !== chainId ||
    currentPhase.proxy.toLowerCase() !== proxy.toLowerCase() ||
    currentPhase.proxyAdmin.toLowerCase() !== proxyAdmin.toLowerCase() ||
    currentPhase.proxyAdminOwner.toLowerCase() !==
      proxyAdminOwner.toLowerCase() ||
    currentPhase.governance.toLowerCase() !== governance.toLowerCase()
  ) {
    throw new Error("archive phase artifact deployment context mismatch")
  }

  const durableCheckpoint = readArchiveCheckpoint(checkpointPath)
  if (
    !currentPhase.checkpoint ||
    !durableCheckpoint ||
    JSON.stringify(currentPhase.checkpoint) !==
      JSON.stringify(durableCheckpoint)
  ) {
    throw new Error("archive phase checkpoint artifact mismatch")
  }
  validateArchiveCheckpoint(currentPhase.checkpoint, {
    chainId,
    registry: proxy,
    scanFromBlock,
    maxTailBlocks,
  })
  await assertCheckpointHeadCanonical(
    ethers.provider,
    independentProvider,
    currentPhase.checkpoint
  )
  if (
    currentImplementation.toLowerCase() ===
      currentPhase.oldImplementation.toLowerCase() &&
    (await ethers.provider.getBlockNumber()) -
      currentPhase.checkpoint.checkpointBlockNumber >=
      currentPhase.checkpoint.maxTailBlocks
  ) {
    throw new Error("archive checkpoint tail budget expired before upgrade")
  }

  if (currentPhase.phase === "pending-start-authorization") {
    if (
      !currentPhase.startAuthorization ||
      !currentPhase.startAuthorizationHash ||
      !currentPhase.checkpointAttestationRequests
    ) {
      throw new Error("archive phase is missing start authorization request")
    }
    validateArchiveCheckpointAttestation(
      currentPhase.checkpoint,
      currentPhase.checkpointAttestationRequests.source,
      ARCHIVE_SOURCE_ATTESTATION_ROLE,
      ethers.utils
    )
    validateArchiveCheckpointAttestation(
      currentPhase.checkpoint,
      currentPhase.checkpointAttestationRequests.reconciler,
      ARCHIVE_RECONCILER_ATTESTATION_ROLE,
      ethers.utils
    )
    assertDistinctCheckpointAttestations(
      currentPhase.checkpointAttestationRequests.source,
      currentPhase.checkpointAttestationRequests.reconciler
    )
    const checkpointAttestations = await loadCheckpointAttestations(
      hre,
      currentPhase.checkpointAttestationRequests
    )
    if (!checkpointAttestations) {
      writeArchivePhase(artifactPath, currentPhase)
      deployments.log(
        "Archive upgrade awaits source and reconciler attestations"
      )
      return
    }
    if (
      currentPhase.checkpointAttestations &&
      JSON.stringify(currentPhase.checkpointAttestations) !==
        JSON.stringify(checkpointAttestations)
    ) {
      throw new Error("archive checkpoint signed attestations changed")
    }
    currentPhase.checkpointAttestations = checkpointAttestations
    const sourceAttestationHash = hashArchiveCheckpointAttestation(
      currentPhase.checkpointAttestationRequests.source,
      ethers.utils
    )
    const reconcilerAttestationHash = hashArchiveCheckpointAttestation(
      currentPhase.checkpointAttestationRequests.reconciler,
      ethers.utils
    )
    const expectedStartHash = hashArchiveMigrationStart(
      currentPhase.startAuthorization,
      ethers.utils
    )
    if (
      currentPhase.startAuthorization.chainId !== chainId ||
      currentPhase.startAuthorization.registry.toLowerCase() !==
        proxy.toLowerCase() ||
      currentPhase.startAuthorization.oldImplementationCodeHash.toLowerCase() !==
        currentPhase.oldImplementationCodeHash.toLowerCase() ||
      currentPhase.startAuthorization.newImplementationCodeHash.toLowerCase() !==
        currentPhase.implementationCodeHash.toLowerCase() ||
      currentPhase.startAuthorization.authority.toLowerCase() !==
        currentPhase.authority.toLowerCase() ||
      currentPhase.startAuthorization.checkpointHash.toLowerCase() !==
        currentPhase.checkpoint.checkpointHash.toLowerCase() ||
      currentPhase.startAuthorization.checkpointBlockNumber !==
        currentPhase.checkpoint.checkpointBlockNumber ||
      currentPhase.startAuthorization.maxTailBlocks !==
        currentPhase.checkpoint.maxTailBlocks ||
      currentPhase.startAuthorization.upgradeDeadlineBlock !==
        currentPhase.checkpoint.upgradeDeadlineBlock ||
      currentPhase.startAuthorization.sourceAttester.toLowerCase() !==
        currentPhase.checkpointAttestationRequests.source.attester.toLowerCase() ||
      currentPhase.startAuthorization.sourceAttestationHash.toLowerCase() !==
        sourceAttestationHash.toLowerCase() ||
      currentPhase.startAuthorization.reconcilerAttester.toLowerCase() !==
        currentPhase.checkpointAttestationRequests.reconciler.attester.toLowerCase() ||
      currentPhase.startAuthorization.reconcilerAttestationHash.toLowerCase() !==
        reconcilerAttestationHash.toLowerCase() ||
      currentPhase.startAuthorization.schemaHash.toLowerCase() !==
        ARCHIVE_START_SCHEMA_HASH.toLowerCase()
    ) {
      throw new Error("archive start authorization context changed")
    }
    if (
      expectedStartHash.toLowerCase() !==
      currentPhase.startAuthorizationHash.toLowerCase()
    ) {
      throw new Error("archive start authorization hash changed")
    }
    const startAuthorizationPath =
      process.env.FROST_ARCHIVE_START_AUTHORIZATION_PATH
    if (!startAuthorizationPath || !fs.existsSync(startAuthorizationPath)) {
      writeArchivePhase(artifactPath, currentPhase)
      deployments.log("Archive upgrade awaits independent start authorization")
      return
    }
    const signedStart = JSON.parse(
      fs.readFileSync(startAuthorizationPath, "utf8")
    ) as SignedArchiveMigrationStart
    if (
      JSON.stringify(signedStart.authorization) !==
        JSON.stringify(currentPhase.startAuthorization) ||
      signedStart.digest.toLowerCase() !== expectedStartHash.toLowerCase() ||
      signedStart.signer.toLowerCase() !== currentPhase.authority.toLowerCase()
    ) {
      throw new Error("archive start authorization payload mismatch")
    }
    await validateAuthoritySignature(
      hre,
      currentPhase.authority,
      expectedStartHash,
      signedStart.signature
    )
    const pendingImplementationCode = await ethers.provider.getCode(
      currentPhase.implementation
    )
    const pendingInactivityCode = await ethers.provider.getCode(
      currentPhase.frostInactivity
    )
    if (
      ethers.utils.keccak256(pendingImplementationCode).toLowerCase() !==
        currentPhase.implementationCodeHash.toLowerCase() ||
      normalizeRegistry(pendingImplementationCode) !==
        EXPECTED_UNLINKED_REGISTRY_RUNTIME_HASH ||
      ethers.utils.keccak256(pendingInactivityCode).toLowerCase() !==
        currentPhase.frostInactivityCodeHash.toLowerCase() ||
      ethers.utils.keccak256(normalizeLibraryRuntime(pendingInactivityCode)) !==
        EXPECTED_NORMALIZED_FROST_INACTIVITY_RUNTIME_HASH
    ) {
      throw new Error("pending archive code hash mismatch")
    }
    assertRuntimeLinks(
      pendingImplementationCode,
      frostInactivityLinkReferences(registryArtifact),
      currentPhase.frostInactivity
    )
    const checkpointInventory = buildArchiveMerkleTree(
      currentPhase.checkpoint.entries,
      ethers.utils
    )
    const encodedStart = ethers.utils.defaultAbiCoder.encode(
      [ARCHIVE_MIGRATION_START_TUPLE],
      [
        {
          authority: currentPhase.authority,
          oldImplementation: currentPhase.oldImplementation,
          checkpointHash: currentPhase.checkpoint.checkpointHash,
          scanFromBlock: currentPhase.checkpoint.scanFromBlock,
          checkpointBlockNumber: currentPhase.checkpoint.checkpointBlockNumber,
          checkpointBlockHash: currentPhase.checkpoint.checkpointBlockHash,
          historyCommitment:
            currentPhase.checkpoint.history.coverage.historyCommitment,
          inventoryRoot: checkpointInventory.root,
          inventoryCount: checkpointInventory.entries.length,
          maxTailBlocks: currentPhase.checkpoint.maxTailBlocks,
          upgradeDeadlineBlock: currentPhase.checkpoint.upgradeDeadlineBlock,
          sourceAttestation: {
            attester:
              currentPhase.checkpointAttestationRequests.source.attester,
            sourceIdentityHash:
              currentPhase.checkpointAttestationRequests.source
                .sourceIdentityHash,
            endpointIdentityHash:
              currentPhase.checkpointAttestationRequests.source
                .endpointIdentityHash,
            trustDomainHash:
              currentPhase.checkpointAttestationRequests.source.trustDomainHash,
            endpointPolicyHash:
              currentPhase.checkpointAttestationRequests.source
                .endpointPolicyHash,
            signature: checkpointAttestations.source.signature,
          },
          reconcilerAttestation: {
            attester:
              currentPhase.checkpointAttestationRequests.reconciler.attester,
            sourceIdentityHash:
              currentPhase.checkpointAttestationRequests.reconciler
                .sourceIdentityHash,
            endpointIdentityHash:
              currentPhase.checkpointAttestationRequests.reconciler
                .endpointIdentityHash,
            trustDomainHash:
              currentPhase.checkpointAttestationRequests.reconciler
                .trustDomainHash,
            endpointPolicyHash:
              currentPhase.checkpointAttestationRequests.reconciler
                .endpointPolicyHash,
            signature: checkpointAttestations.reconciler.signature,
          },
          authoritySignature: signedStart.signature,
        },
      ]
    )
    const initializer = registry.interface.encodeFunctionData(
      "initializeArchiveMigration",
      [encodedStart]
    )
    const upgradeData = proxyAdminContract.interface.encodeFunctionData(
      "upgradeAndCall",
      [proxy, currentPhase.implementation, initializer]
    )
    const upgradeAction: ArchiveAction = {
      target: proxyAdmin,
      value: "0",
      data: upgradeData,
      description:
        "ProxyAdmin.upgradeAndCall FrostWalletRegistry into frozen archive Pending state",
    }
    const salt = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["string", "uint256", "address", "address", "bytes32"],
        [
          ARCHIVE_PHASE_SCHEMA,
          chainId,
          proxy,
          currentPhase.implementation,
          ethers.utils.keccak256(initializer),
        ]
      )
    )
    currentPhase.upgrade = upgradeAction
    currentPhase.timelock = await buildTimelockActions(
      hre,
      proxyAdminOwner,
      upgradeAction,
      salt,
      true
    )
    currentPhase.phase = "prepared"
    writeArchivePhase(artifactPath, currentPhase)
    deployments.log(`Archive upgrade prepared: ${artifactPath}`)
    return
  }

  const preparedImplementationCode = await ethers.provider.getCode(
    currentPhase.implementation
  )
  const preparedOldImplementationCode = await ethers.provider.getCode(
    currentPhase.oldImplementation
  )
  const preparedInactivityCode = await ethers.provider.getCode(
    currentPhase.frostInactivity
  )
  if (
    ethers.utils.keccak256(preparedOldImplementationCode).toLowerCase() !==
      currentPhase.oldImplementationCodeHash.toLowerCase() ||
    ethers.utils.keccak256(preparedImplementationCode).toLowerCase() !==
      currentPhase.implementationCodeHash.toLowerCase() ||
    normalizeRegistry(preparedImplementationCode) !==
      EXPECTED_UNLINKED_REGISTRY_RUNTIME_HASH ||
    ethers.utils.keccak256(preparedInactivityCode).toLowerCase() !==
      currentPhase.frostInactivityCodeHash.toLowerCase() ||
    ethers.utils.keccak256(normalizeLibraryRuntime(preparedInactivityCode)) !==
      EXPECTED_NORMALIZED_FROST_INACTIVITY_RUNTIME_HASH
  ) {
    throw new Error("prepared archive code hash mismatch")
  }
  assertRuntimeLinks(
    preparedImplementationCode,
    frostInactivityLinkReferences(registryArtifact),
    currentPhase.frostInactivity
  )

  if (
    currentImplementation.toLowerCase() !==
    currentPhase.implementation.toLowerCase()
  ) {
    if (
      currentImplementation.toLowerCase() !==
      currentPhase.oldImplementation.toLowerCase()
    ) {
      throw new Error("proxy implementation is neither prepared nor previous")
    }
    currentPhase.phase = "prepared"
    writeArchivePhase(artifactPath, currentPhase)
    deployments.log(`Archive upgrade still prepared: ${artifactPath}`)
    return
  }

  if (!migrationState) {
    const state = await registry.getWalletArchiveMigration()
    const attestations = decodeArchiveAttestationReadback(
      await registry.getWalletArchiveAttestations(),
      ethers.utils
    )
    const finalAttestations = await registry.getWalletArchiveFinalAttestations()
    migrationState = {
      state: asSafeNumber(state.state),
      authority: state.authority,
      upgradeBlockNumber: asSafeNumber(state.upgradeBlockNumber),
      oldImplementationCodeHash: state.oldImplementationCodeHash,
      newImplementationCodeHash: state.newImplementationCodeHash,
      walletsRoot: state.walletsRoot,
      historyRoot: state.historyRoot,
      pendingManifestHash: state.pendingManifestHash,
      expectedCount: asSafeNumber(state.expectedCount),
      completedCount: asSafeNumber(state.completedCount),
      checkpointHash: state.checkpointHash,
      checkpointBlockNumber: asSafeNumber(state.checkpointBlockNumber),
      maxTailBlocks: asSafeNumber(state.maxTailBlocks),
      upgradeDeadlineBlock: asSafeNumber(attestations.upgradeDeadlineBlock),
      sourceAttester: attestations.sourceAttester,
      sourceAttestationHash: attestations.sourceAttestationHash,
      sourceIdentityHash: attestations.sourceIdentityHash,
      sourceEndpointIdentityHash: attestations.sourceEndpointIdentityHash,
      sourceTrustDomainHash: attestations.sourceTrustDomainHash,
      sourceEndpointPolicyHash: attestations.sourceEndpointPolicyHash,
      reconcilerAttester: attestations.reconcilerAttester,
      reconcilerAttestationHash: attestations.reconcilerAttestationHash,
      reconcilerIdentityHash: attestations.reconcilerIdentityHash,
      reconcilerEndpointIdentityHash:
        attestations.reconcilerEndpointIdentityHash,
      reconcilerTrustDomainHash: attestations.reconcilerTrustDomainHash,
      reconcilerEndpointPolicyHash: attestations.reconcilerEndpointPolicyHash,
      finalSourceAttestationHash: finalAttestations.sourceAttestationHash,
      finalReconcilerAttestationHash:
        finalAttestations.reconcilerAttestationHash,
    }
  }
  if (
    migrationState.state < 1 ||
    migrationState.state > 3 ||
    migrationState.authority.toLowerCase() !==
      currentPhase.authority.toLowerCase() ||
    migrationState.oldImplementationCodeHash.toLowerCase() !==
      currentPhase.oldImplementationCodeHash.toLowerCase() ||
    migrationState.newImplementationCodeHash.toLowerCase() !==
      currentPhase.implementationCodeHash.toLowerCase() ||
    migrationState.checkpointHash.toLowerCase() !==
      currentPhase.checkpoint.checkpointHash.toLowerCase() ||
    migrationState.checkpointBlockNumber !==
      currentPhase.checkpoint.checkpointBlockNumber ||
    migrationState.maxTailBlocks !== currentPhase.checkpoint.maxTailBlocks ||
    migrationState.upgradeDeadlineBlock !==
      currentPhase.checkpoint.upgradeDeadlineBlock ||
    (currentPhase.checkpointAttestationRequests !== undefined &&
      (migrationState.sourceAttester.toLowerCase() !==
        currentPhase.checkpointAttestationRequests.source.attester.toLowerCase() ||
        migrationState.sourceAttestationHash.toLowerCase() !==
          hashArchiveCheckpointAttestation(
            currentPhase.checkpointAttestationRequests.source,
            ethers.utils
          ).toLowerCase() ||
        migrationState.sourceIdentityHash.toLowerCase() !==
          currentPhase.checkpointAttestationRequests.source.sourceIdentityHash.toLowerCase() ||
        migrationState.sourceEndpointIdentityHash.toLowerCase() !==
          currentPhase.checkpointAttestationRequests.source.endpointIdentityHash.toLowerCase() ||
        migrationState.sourceTrustDomainHash.toLowerCase() !==
          currentPhase.checkpointAttestationRequests.source.trustDomainHash.toLowerCase() ||
        migrationState.sourceEndpointPolicyHash.toLowerCase() !==
          currentPhase.checkpointAttestationRequests.source.endpointPolicyHash.toLowerCase() ||
        migrationState.reconcilerAttester.toLowerCase() !==
          currentPhase.checkpointAttestationRequests.reconciler.attester.toLowerCase() ||
        migrationState.reconcilerAttestationHash.toLowerCase() !==
          hashArchiveCheckpointAttestation(
            currentPhase.checkpointAttestationRequests.reconciler,
            ethers.utils
          ).toLowerCase() ||
        migrationState.reconcilerIdentityHash.toLowerCase() !==
          currentPhase.checkpointAttestationRequests.reconciler.sourceIdentityHash.toLowerCase() ||
        migrationState.reconcilerEndpointIdentityHash.toLowerCase() !==
          currentPhase.checkpointAttestationRequests.reconciler.endpointIdentityHash.toLowerCase() ||
        migrationState.reconcilerTrustDomainHash.toLowerCase() !==
          currentPhase.checkpointAttestationRequests.reconciler.trustDomainHash.toLowerCase() ||
        migrationState.reconcilerEndpointPolicyHash.toLowerCase() !==
          currentPhase.checkpointAttestationRequests.reconciler.endpointPolicyHash.toLowerCase()))
  ) {
    throw new Error("on-chain archive migration state mismatch")
  }
  if (
    (await registry.sortitionPool()).toLowerCase() !==
    sortitionPoolDeployment.address.toLowerCase()
  ) {
    throw new Error("FrostWalletRegistry immutable sortition pool mismatch")
  }

  const migrationStart = await findMigrationStart(
    ethers.provider,
    proxy,
    currentPhase.searchFromBlock
  )
  if (migrationStart.blockNumber !== migrationState.upgradeBlockNumber) {
    throw new Error("migration start event/state block mismatch")
  }
  if (
    migrationStart.blockNumber - currentPhase.checkpoint.checkpointBlockNumber >
    currentPhase.checkpoint.maxTailBlocks
  ) {
    throw new Error("archive migration tail exceeds signed maximum")
  }
  const independentMigrationStart = await findMigrationStart(
    independentProvider,
    proxy,
    currentPhase.searchFromBlock
  )
  if (
    JSON.stringify(independentMigrationStart).toLowerCase() !==
    JSON.stringify(migrationStart).toLowerCase()
  ) {
    throw new Error("independent archive migration start mismatch")
  }
  const canonicalUpgradeBlock = await ethers.provider.getBlock(
    migrationStart.blockNumber
  )
  if (
    !canonicalUpgradeBlock?.hash ||
    canonicalUpgradeBlock.hash.toLowerCase() !==
      migrationStart.blockHash.toLowerCase()
  ) {
    throw new Error("archive upgrade block is no longer canonical")
  }
  currentPhase.upgradeBlockNumber = migrationStart.blockNumber
  currentPhase.upgradeBlockHash = migrationStart.blockHash
  currentPhase.upgradeTransactionIndex = migrationStart.transactionIndex

  const latestBlock = await ethers.provider.getBlockNumber()
  if (latestBlock - migrationStart.blockNumber < minimumConfirmations) {
    currentPhase.phase = "pending-finality"
    writeArchivePhase(artifactPath, currentPhase)
    deployments.log("Archive upgrade is pending finality")
    return
  }

  const codeAtScanStart = await ethers.provider.getCode(proxy, scanFromBlock)
  const codeBeforeScanStart =
    scanFromBlock === 0
      ? "0x"
      : await ethers.provider.getCode(proxy, scanFromBlock - 1)
  if (codeAtScanStart === "0x" || codeBeforeScanStart !== "0x") {
    throw new Error("archive scan start does not prove proxy creation")
  }
  const upperExclusive = {
    blockNumber: migrationStart.blockNumber,
    transactionIndex: migrationStart.transactionIndex,
    logIndex: 0,
  }
  const tailStartBlock = currentPhase.checkpoint.checkpointBlockNumber + 1
  const [tailHistory, independentTailHistory] = await Promise.all([
    scanWalletHistory(
      hre,
      proxy,
      tailStartBlock,
      migrationStart.blockNumber,
      upperExclusive
    ),
    scanWalletHistoryWithProvider(
      hre,
      independentProvider,
      proxy,
      tailStartBlock,
      migrationStart.blockNumber,
      upperExclusive
    ),
  ])
  assertIndependentWalletHistory(tailHistory, independentTailHistory)
  const combinedHistory = mergeWalletHistory(
    currentPhase.checkpoint.history,
    tailHistory
  )
  const historicalClosed = deriveArchiveEntries(combinedHistory)
  const walletNotRegisteredSelector = ethers.utils
    .id("WalletNotRegistered()")
    .slice(0, 10)
  const legacyLossEntries: ArchiveManifestEntry[] = []
  for (const entry of historicalClosed) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const retained = await registry.getRetainedWalletMembersIdsHash(
        entry.walletID
      )
      if (retained.toLowerCase() !== entry.membersIdsHash.toLowerCase()) {
        throw new Error(`retained archive mismatch for ${entry.walletID}`)
      }
    } catch (error) {
      const data = extractRevertData(error).toLowerCase()
      if (data !== "0x" && !data.startsWith(walletNotRegisteredSelector)) {
        throw error
      }
      legacyLossEntries.push(entry)
    }
  }
  const merkle = buildArchiveMerkleTree(legacyLossEntries, ethers.utils)
  const manifest: ArchiveManifestV2 = {
    chainId,
    registry: proxy,
    oldImplementationCodeHash: currentPhase.oldImplementationCodeHash,
    newImplementationCodeHash: currentPhase.implementationCodeHash,
    checkpointHash: currentPhase.checkpoint.checkpointHash,
    checkpointBlockNumber: currentPhase.checkpoint.checkpointBlockNumber,
    maxTailBlocks: currentPhase.checkpoint.maxTailBlocks,
    upgradeDeadlineBlock: migrationState.upgradeDeadlineBlock,
    sourceAttester: migrationState.sourceAttester,
    sourceAttestationHash: migrationState.sourceAttestationHash,
    sourceIdentityHash: migrationState.sourceIdentityHash,
    sourceEndpointIdentityHash: migrationState.sourceEndpointIdentityHash,
    sourceTrustDomainHash: migrationState.sourceTrustDomainHash,
    sourceEndpointPolicyHash: migrationState.sourceEndpointPolicyHash,
    reconcilerAttester: migrationState.reconcilerAttester,
    reconcilerAttestationHash: migrationState.reconcilerAttestationHash,
    reconcilerIdentityHash: migrationState.reconcilerIdentityHash,
    reconcilerEndpointIdentityHash:
      migrationState.reconcilerEndpointIdentityHash,
    reconcilerTrustDomainHash: migrationState.reconcilerTrustDomainHash,
    reconcilerEndpointPolicyHash: migrationState.reconcilerEndpointPolicyHash,
    upgradeBlockNumber: migrationStart.blockNumber,
    upgradeBlockHash: migrationStart.blockHash,
    upgradeTransactionIndex: migrationStart.transactionIndex,
    scanFromBlock,
    scanToBlock: migrationStart.blockNumber,
    historyRoot: hashCombinedArchiveHistory(
      currentPhase.checkpoint.checkpointHash,
      tailHistory,
      legacyLossEntries,
      ethers.utils
    ),
    walletsRoot: merkle.root,
    walletCount: merkle.entries.length,
    schemaHash: ARCHIVE_MANIFEST_SCHEMA_HASH,
  }
  const manifestHash = hashArchiveManifestV2(manifest, ethers.utils)
  currentPhase.manifest = manifest
  currentPhase.manifestHash = manifestHash
  currentPhase.proofEntries = merkle.entries
  const manifestAttestationRequests = {
    source: buildArchiveManifestAttestation(
      manifest,
      manifestHash,
      ARCHIVE_SOURCE_ATTESTATION_ROLE,
      migrationState.sourceAttester
    ),
    reconciler: buildArchiveManifestAttestation(
      manifest,
      manifestHash,
      ARCHIVE_RECONCILER_ATTESTATION_ROLE,
      migrationState.reconcilerAttester
    ),
  }
  if (
    currentPhase.manifestAttestationRequests &&
    JSON.stringify(currentPhase.manifestAttestationRequests) !==
      JSON.stringify(manifestAttestationRequests)
  ) {
    throw new Error("archive manifest attestation request changed")
  }
  currentPhase.manifestAttestationRequests = manifestAttestationRequests
  const expectedFinalSourceAttestationHash = hashArchiveManifestAttestation(
    manifestAttestationRequests.source,
    ethers.utils
  )
  const expectedFinalReconcilerAttestationHash = hashArchiveManifestAttestation(
    manifestAttestationRequests.reconciler,
    ethers.utils
  )

  if (migrationState.state === 1) {
    const manifestAttestations = await loadManifestAttestations(
      hre,
      manifestAttestationRequests
    )
    const manifestPath = process.env.FROST_ARCHIVE_MANIFEST_PATH
    if (
      !manifestAttestations ||
      !manifestPath ||
      !fs.existsSync(manifestPath)
    ) {
      currentPhase.phase = "pending-signature"
      writeArchivePhase(artifactPath, currentPhase)
      deployments.log(
        `Archive manifest ${manifestHash} requires authority and dual tail attestations`
      )
      return
    }
    if (
      currentPhase.manifestAttestations &&
      JSON.stringify(currentPhase.manifestAttestations) !==
        JSON.stringify(manifestAttestations)
    ) {
      throw new Error("archive manifest signed attestations changed")
    }
    currentPhase.manifestAttestations = manifestAttestations
    const signed = JSON.parse(
      fs.readFileSync(manifestPath, "utf8")
    ) as SignedArchiveManifestV2
    validateSignedArchiveManifestV2(
      signed,
      manifest,
      merkle.entries,
      currentPhase.authority,
      ethers.utils
    )
    const encodedCommit = ethers.utils.defaultAbiCoder.encode(
      [ARCHIVE_MANIFEST_COMMIT_TUPLE],
      [
        {
          manifest: signed.manifest,
          authoritySignature: signed.signature,
          sourceSignature: manifestAttestations.source.signature,
          reconcilerSignature: manifestAttestations.reconciler.signature,
        },
      ]
    )
    const commitData = registry.interface.encodeFunctionData(
      "commitArchiveMigrationManifest",
      [encodedCommit]
    )
    await ethers.provider.call({
      to: proxy,
      from: governance,
      data: commitData,
    })
    currentPhase.commit = {
      target: proxy,
      value: "0",
      data: commitData,
      description: `Commit independently signed archive manifest ${manifestHash}`,
    }
    const commitSalt = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["string", "uint256", "address", "bytes32"],
        [ARCHIVE_PHASE_SCHEMA, chainId, proxy, manifestHash]
      )
    )
    currentPhase.commitTimelock = await buildTimelockActions(
      hre,
      governance,
      currentPhase.commit,
      commitSalt
    )
    currentPhase.phase = "pending-commit"
    writeArchivePhase(artifactPath, currentPhase)
    deployments.log(
      `Archive manifest commit requires governance: ${artifactPath}`
    )
    return
  }

  if (
    migrationState.walletsRoot.toLowerCase() !==
      manifest.walletsRoot.toLowerCase() ||
    migrationState.historyRoot.toLowerCase() !==
      manifest.historyRoot.toLowerCase() ||
    migrationState.pendingManifestHash.toLowerCase() !==
      manifestHash.toLowerCase() ||
    migrationState.expectedCount !== manifest.walletCount ||
    migrationState.finalSourceAttestationHash.toLowerCase() !==
      expectedFinalSourceAttestationHash.toLowerCase() ||
    migrationState.finalReconcilerAttestationHash.toLowerCase() !==
      expectedFinalReconcilerAttestationHash.toLowerCase()
  ) {
    throw new Error("committed archive manifest readback mismatch")
  }

  if (migrationState.state === 2) {
    const submitter = await ethers.getSigner(deployer)
    for (const entry of merkle.entries) {
      let alreadyBackfilled = false
      try {
        // eslint-disable-next-line no-await-in-loop
        const retained = await registry.getRetainedWalletMembersIdsHash(
          entry.walletID
        )
        if (retained.toLowerCase() !== entry.membersIdsHash.toLowerCase()) {
          throw new Error(`archive readback mismatch for ${entry.walletID}`)
        }
        alreadyBackfilled = true
      } catch (error) {
        const data = extractRevertData(error).toLowerCase()
        if (data !== "0x" && !data.startsWith(walletNotRegisteredSelector)) {
          throw error
        }
      }
      if (!alreadyBackfilled) {
        // eslint-disable-next-line no-await-in-loop
        const transaction = await registry
          .connect(submitter)
          .backfillArchivedWalletMembership(
            entry.index,
            entry.walletID,
            entry.dkgResultHash,
            entry.membersIdsHash,
            entry.proof
          )
        // eslint-disable-next-line no-await-in-loop
        await transaction.wait(1)
      }
    }
    const beforeFinalization = await registry.getWalletArchiveMigration()
    if (
      asSafeNumber(beforeFinalization.completedCount) !==
        manifest.walletCount ||
      asSafeNumber(beforeFinalization.expectedCount) !== manifest.walletCount
    ) {
      throw new Error("archive proof completion count mismatch")
    }
    const finalization = await registry
      .connect(submitter)
      .finalizeArchiveMigration()
    await finalization.wait(1)
  }

  const finalState = await registry.getWalletArchiveMigration()
  if (
    asSafeNumber(finalState.state) !== 3 ||
    finalState.pendingManifestHash.toLowerCase() !==
      manifestHash.toLowerCase() ||
    (await registry.getWalletArchiveMigrationManifestHash()).toLowerCase() !==
      manifestHash.toLowerCase()
  ) {
    throw new Error("archive migration final readback failed")
  }
  for (const entry of merkle.entries) {
    // eslint-disable-next-line no-await-in-loop
    const retained = await registry.getRetainedWalletMembersIdsHash(
      entry.walletID
    )
    if (retained.toLowerCase() !== entry.membersIdsHash.toLowerCase()) {
      throw new Error(`final archive mismatch for ${entry.walletID}`)
    }
  }

  await deployments.save("FrostWalletRegistry", {
    ...registryDeployment,
    implementation: currentPhase.implementation,
  })
  currentPhase.phase = "executed"
  writeArchivePhase(artifactPath, currentPhase)
  deployments.log(
    `FrostWalletRegistry archive migration executed and verified: ${manifestHash}`
  )
}

export default secureFunc

secureFunc.tags = ["UpgradeFrostWalletRegistryArchive"]
secureFunc.dependencies = ["FrostCustodyNoGo"]
secureFunc.skip = async () =>
  process.env.RUN_UPGRADE_FROST_WALLET_ARCHIVE !== "1"
