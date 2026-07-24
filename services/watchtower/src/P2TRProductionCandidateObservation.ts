import { Transaction } from "bitcoinjs-lib"
import {
  extractP2TRSignatureFraudWitnessObservations,
  type P2TRSignatureFraudWitnessObservation,
  type P2TRWalletInputKeyBinding,
  type P2TRWalletInputObservationPrevout,
} from "@keep-network/tbtc-v2.ts"
import type { P2TRCompleteCandidateInputProvenance } from "./P2TRCompleteCandidateIdentity.js"
import { computeP2TRCompleteAuthorizationDomainDigest } from "./P2TRCompleteCandidateIdentity.js"
import { calculateP2TRCanonicalOccurrenceID } from "./P2TRCanonicalOccurrenceIdentity.js"

export type P2TRProductionCandidateObservationIdentity = {
  txid: string
  wtxid: string
  blockHeight: number
  blockHash: string
  inputIndex: number
  observationID: string
  challengeKey: string
}

export type P2TRProductionCandidateInputProvenance =
  P2TRCompleteCandidateInputProvenance

/**
 * Structural view of the canonical-index row returned while its shared
 * rollback lock and candidate-exclusive lock are held. Keeping this boundary
 * structural lets the activation stack consume the canonical-index contract
 * without copying its database implementation.
 */
export type P2TRProductionLockedCandidateProvenance = {
  txid: string
  wtxid: string
  blockHeight: number
  blockHash: string
  rawTransactionHex: string
  inputPrevouts: P2TRWalletInputObservationPrevout[]
  walletInputKeyBindings: P2TRWalletInputKeyBinding[]
  provenanceGeneration: number
  provenanceFingerprint: string
  inputProvenance: P2TRProductionCandidateInputProvenance[]
}

export type P2TRProductionCanonicalObservationClaim = {
  identity: P2TRProductionCandidateObservationIdentity
  observation: P2TRSignatureFraudWitnessObservation
  provenanceGeneration: number
  provenanceFingerprint: string
  inputProvenance: P2TRProductionCandidateInputProvenance
}

/**
 * Reconstructs one exact Bridge challenge from locked canonical material. No
 * caller-provided observation, prevout, wallet binding, or challenge key is
 * trusted. The returned observation is suitable for the transactional outbox
 * only while the caller retains the index lock that protected `locked`.
 */
export function resolveP2TRProductionCanonicalObservation(
  requested: P2TRProductionCandidateObservationIdentity,
  locked: P2TRProductionLockedCandidateProvenance,
  bridgeDomain: { chainID: number; bridgeAddress: string }
): P2TRProductionCanonicalObservationClaim {
  const identity = normalizeObservationIdentity(requested)
  const candidate = normalizeLockedCandidate(locked)
  if (
    identity.txid !== candidate.txid ||
    identity.wtxid !== candidate.wtxid ||
    identity.blockHeight !== candidate.blockHeight ||
    identity.blockHash !== candidate.blockHash
  ) {
    throw new Error("Locked candidate does not match the requested occurrence")
  }

  const transaction = parseCandidateTransaction(candidate.rawTransactionHex)
  if (
    transaction.getId() !== identity.txid ||
    witnessTransactionID(transaction) !== identity.wtxid ||
    transaction.ins.length !== candidate.inputPrevouts.length
  ) {
    throw new Error(
      "Locked candidate raw transaction or prevout vector is inconsistent"
    )
  }
  if (identity.inputIndex >= transaction.ins.length) {
    throw new Error(
      "Requested witness input index is outside the canonical transaction"
    )
  }
  if (
    candidate.inputProvenance.some(
      ({ inputIndex }) => inputIndex >= transaction.ins.length
    )
  ) {
    throw new Error(
      "Canonical input provenance names an absent transaction input"
    )
  }

  const inputRows = candidate.inputProvenance.filter(
    ({ inputIndex }) => inputIndex === identity.inputIndex
  )
  if (inputRows.length !== 1) {
    throw new Error(
      "Requested witness input does not have one exact canonical provenance row"
    )
  }
  const inputProvenance = inputRows[0]
  const transactionInput = transaction.ins[identity.inputIndex]
  const fundingTxid = Buffer.from(transactionInput.hash)
    .reverse()
    .toString("hex")
  const prevout = normalizePrevout(
    candidate.inputPrevouts[identity.inputIndex],
    "canonical input prevout"
  )
  if (
    fundingTxid !== inputProvenance.fundingTxid ||
    transactionInput.index !== inputProvenance.fundingVout ||
    prevout.txid !== inputProvenance.fundingTxid ||
    prevout.vout !== inputProvenance.fundingVout
  ) {
    throw new Error(
      "Witness input does not spend the occurrence authenticated by canonical provenance"
    )
  }
  const expectedScript = `5120${inputProvenance.outputKey}`
  if (
    prevout.scriptPubKey !== expectedScript ||
    (inputProvenance.bindingKind === "wallet" &&
      inputProvenance.walletID !== inputProvenance.outputKey)
  ) {
    throw new Error(
      "Witness input is not bound to the canonical P2TR output key"
    )
  }

  const matchingBindings = candidate.walletInputKeyBindings
    .map((binding) => normalizeWalletBinding(binding))
    .filter(
      (binding) =>
        binding.txid === inputProvenance.fundingTxid &&
        binding.vout === inputProvenance.fundingVout
    )
  if (
    (inputProvenance.bindingKind === "deposit" &&
      (matchingBindings.length !== 1 ||
        matchingBindings[0].walletID !== inputProvenance.walletID ||
        matchingBindings[0].outputKey !== inputProvenance.outputKey)) ||
    (inputProvenance.bindingKind === "wallet" && matchingBindings.length !== 0)
  ) {
    throw new Error("Witness input signing-key binding is not canonical")
  }

  const registeredWalletIDs = [
    ...new Set(candidate.inputProvenance.map(({ walletID }) => walletID)),
  ].sort()
  const observations = extractP2TRSignatureFraudWitnessObservations(
    { transactionHex: candidate.rawTransactionHex },
    candidate.inputPrevouts,
    registeredWalletIDs,
    undefined,
    undefined,
    undefined,
    {
      chainID: positiveInteger(bridgeDomain.chainID, "Bridge chain ID"),
      bridgeAddress: address(bridgeDomain.bridgeAddress, "Bridge address"),
    },
    candidate.walletInputKeyBindings
  ).filter(({ inputIndex }) => inputIndex === identity.inputIndex)
  if (observations.length !== 1) {
    throw new Error(
      "Canonical transaction does not yield one witness observation at the requested input"
    )
  }
  const observation = observations[0]
  const challengeKey = bytes32(
    observation.bridgeChallengeKey?.toString() ?? "",
    "derived Bridge challenge key"
  )
  // The SDK's `observationID` is an alias of the Bridge challenge key, so it is
  // a challenge-SERIES identity and is deliberately not unique: two canonical
  // inputs can legitimately carry the same one. The occurrence identity is
  // therefore recomputed here from the COMPLETE domain, the locked provenance
  // generation and fingerprint, and the exact canonical coordinates, so every
  // input/provenance occurrence stays independently addressable and a stale
  // acknowledgement can never settle a reorg replacement.
  const occurrenceID = calculateP2TRCanonicalOccurrenceID({
    domainDigest: computeP2TRCompleteAuthorizationDomainDigest({
      domainChainID: positiveInteger(
        bridgeDomain.chainID,
        "Bridge chain ID"
      ).toString(10),
      bridgeAddress: address(bridgeDomain.bridgeAddress, "Bridge address"),
    }),
    provenanceGeneration: candidate.provenanceGeneration,
    blockHash: identity.blockHash,
    txid: identity.txid,
    wtxid: identity.wtxid,
    inputIndex: identity.inputIndex,
    provenanceFingerprint: candidate.provenanceFingerprint,
    challengeIdentity: challengeKey,
  })
  if (
    occurrenceID !== identity.observationID ||
    challengeKey !== identity.challengeKey ||
    bytes32(observation.walletID.toString(), "derived wallet ID") !==
      inputProvenance.walletID ||
    normalizeHex(
      observation.scriptPubKey.toString(),
      "derived input script"
    ) !== expectedScript
  ) {
    throw new Error(
      "Requested observation/challenge does not match the canonical witnessed signing key"
    )
  }

  return {
    identity,
    observation,
    provenanceGeneration: candidate.provenanceGeneration,
    provenanceFingerprint: candidate.provenanceFingerprint,
    inputProvenance,
  }
}

function normalizeLockedCandidate(
  value: P2TRProductionLockedCandidateProvenance
): P2TRProductionLockedCandidateProvenance {
  const inputProvenance = value.inputProvenance.map(normalizeInputProvenance)
  const sorted = [...inputProvenance].sort(compareInputProvenance)
  if (canonicalJSON(inputProvenance) !== canonicalJSON(sorted)) {
    throw new Error(
      "Locked candidate input provenance is not canonically sorted"
    )
  }
  const keys = new Set(
    sorted.map(
      (row) =>
        `${row.inputIndex}:${row.fundingBlockHash}:${row.fundingTxid}:${row.fundingVout}:${row.sourceEventID}`
    )
  )
  if (keys.size !== sorted.length) {
    throw new Error("Locked candidate input provenance contains duplicates")
  }
  return {
    txid: bytes32(value.txid, "locked candidate txid"),
    wtxid: bytes32(value.wtxid, "locked candidate wtxid"),
    blockHeight: nonNegativeInteger(
      value.blockHeight,
      "locked candidate height"
    ),
    blockHash: bytes32(value.blockHash, "locked candidate block hash"),
    rawTransactionHex: normalizeHex(
      value.rawTransactionHex,
      "locked candidate raw transaction"
    ),
    inputPrevouts: value.inputPrevouts,
    walletInputKeyBindings: value.walletInputKeyBindings,
    provenanceGeneration: positiveInteger(
      value.provenanceGeneration,
      "candidate provenance generation"
    ),
    provenanceFingerprint: bytes32(
      value.provenanceFingerprint,
      "candidate provenance fingerprint"
    ),
    inputProvenance: sorted,
  }
}

function normalizeObservationIdentity(
  value: P2TRProductionCandidateObservationIdentity
): P2TRProductionCandidateObservationIdentity {
  return {
    txid: bytes32(value.txid, "candidate txid"),
    wtxid: bytes32(value.wtxid, "candidate wtxid"),
    blockHeight: nonNegativeInteger(
      value.blockHeight,
      "candidate block height"
    ),
    blockHash: bytes32(value.blockHash, "candidate block hash"),
    inputIndex: uint32(value.inputIndex, "candidate input index"),
    observationID: bytes32(value.observationID, "candidate observation ID"),
    challengeKey: bytes32(value.challengeKey, "candidate challenge key"),
  }
}

function normalizeInputProvenance(
  value: P2TRProductionCandidateInputProvenance
): P2TRProductionCandidateInputProvenance {
  if (value.bindingKind !== "wallet" && value.bindingKind !== "deposit") {
    throw new Error("Candidate provenance binding kind is invalid")
  }
  return {
    inputIndex: uint32(value.inputIndex, "provenance input index"),
    fundingBlockHash: bytes32(
      value.fundingBlockHash,
      "provenance funding block hash"
    ),
    fundingTxid: bytes32(value.fundingTxid, "provenance funding txid"),
    fundingVout: uint32(value.fundingVout, "provenance funding vout"),
    bindingKind: value.bindingKind,
    walletID: bytes32(value.walletID, "provenance wallet ID"),
    outputKey: bytes32(value.outputKey, "provenance output key"),
    sourceEventID: bytes32(value.sourceEventID, "provenance source event ID"),
    ethereumBlockNumber: nonNegativeInteger(
      value.ethereumBlockNumber,
      "provenance Ethereum block"
    ),
    ethereumBlockHash: bytes32(
      value.ethereumBlockHash,
      "provenance Ethereum block hash"
    ),
  }
}

function normalizePrevout(
  value: P2TRWalletInputObservationPrevout,
  label: string
): { txid: string; vout: number; scriptPubKey: string } {
  return {
    txid: bytes32(value.txid, `${label} txid`),
    vout: uint32(value.vout, `${label} vout`),
    scriptPubKey: normalizeHex(value.scriptPubKey, `${label} script`),
  }
}

function normalizeWalletBinding(value: P2TRWalletInputKeyBinding): {
  txid: string
  vout: number
  outputKey: string
  walletID: string
} {
  return {
    txid: bytes32(value.txid, "wallet binding txid"),
    vout: uint32(value.vout, "wallet binding vout"),
    outputKey: bytes32(value.outputKey, "wallet binding output key"),
    walletID: bytes32(value.walletID, "wallet binding wallet ID"),
  }
}

function compareInputProvenance(
  left: P2TRProductionCandidateInputProvenance,
  right: P2TRProductionCandidateInputProvenance
): number {
  return (
    left.inputIndex - right.inputIndex ||
    left.fundingBlockHash.localeCompare(right.fundingBlockHash) ||
    left.fundingTxid.localeCompare(right.fundingTxid) ||
    left.fundingVout - right.fundingVout ||
    left.bindingKind.localeCompare(right.bindingKind) ||
    left.sourceEventID.localeCompare(right.sourceEventID)
  )
}

function parseCandidateTransaction(rawTransactionHex: string): Transaction {
  try {
    return Transaction.fromHex(rawTransactionHex)
  } catch {
    throw new Error("Locked candidate raw transaction is malformed")
  }
}

function witnessTransactionID(transaction: Transaction): string {
  return Buffer.from(transaction.getHash(true)).reverse().toString("hex")
}

function normalizeHex(value: unknown, label: string): string {
  const encoded =
    Buffer.isBuffer(value) || value instanceof Uint8Array
      ? Buffer.from(value).toString("hex")
      : typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
      ? String(value)
      : ""
  const normalized = encoded.toLowerCase().replace(/^0x/, "")
  if (!/^(?:[0-9a-f]{2})+$/.test(normalized)) {
    throw new Error(`${label} must be non-empty even-length hexadecimal`)
  }
  return normalized
}

function bytes32(value: unknown, label: string): string {
  const normalized = normalizeHex(value, label)
  if (normalized.length !== 64) throw new Error(`${label} must be 32 bytes`)
  return normalized
}

function address(value: string, label: string): string {
  const normalized = normalizeHex(value, label)
  if (normalized.length !== 40 || /^0+$/.test(normalized)) {
    throw new Error(`${label} must be a non-zero 20-byte address`)
  }
  return `0x${normalized}`
}

function uint32(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${label} must be a uint32`)
  }
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function boundedString(value: string, maximum: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(value)
}
