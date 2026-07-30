import { createHash } from "node:crypto"

export const P2TR_COMPLETE_AUTHORIZATION_DOMAIN =
  "tbtc-p2tr-signature-fraud-authorization-v3" as const

/** Static COMPLETE_V2 protocol identifier bound into the domain digest. */
export const P2TR_COMPLETE_V2_PROTOCOL_ID =
  "12c62b64ecf6d008bcff153495dcdbe7a981f3a9a1b9c0898b86b1e6d0d350ef" as const

export const P2TR_COMPLETE_DOMAIN_DIGEST_TAG =
  "tbtc-p2tr-complete-domain-v1" as const

export type P2TRCompleteBridgeDomain = {
  domainChainID: string
  bridgeAddress: string
}

/**
 * COMPLETE_V2 authorization domain digest. This is the exact value persisted as
 * `domain_digest` and bound into every canonical occurrence identity, so it has
 * a single definition shared by the canonical store and the activation stack.
 */
export function computeP2TRCompleteAuthorizationDomainDigest(
  domainValue: P2TRCompleteBridgeDomain
): string {
  const domain = normalizeP2TRCompleteBridgeDomain(domainValue)
  return createHash("sha256")
    .update(P2TR_COMPLETE_DOMAIN_DIGEST_TAG, "utf8")
    .update(Buffer.from(P2TR_COMPLETE_V2_PROTOCOL_ID, "hex"))
    .update(
      Buffer.from(
        BigInt(domain.domainChainID).toString(16).padStart(64, "0"),
        "hex"
      )
    )
    .update(Buffer.from(domain.bridgeAddress.slice(2), "hex"))
    .digest("hex")
}

/** The exact static ChallengeEvidence tuple accepted by COMPLETE_V2. */
export type P2TRCompleteChallengeEvidence = {
  walletID: string
  signingKey: string
  bindingTxHash: string
  bindingOutputIndex: number
  sighash: string
  nonceX: string
  signatureScalar: string
}

/** Canonical Ethereum-to-Bitcoin binding for one COMPLETE-v2 input. */
export type P2TRCompleteCandidateInputProvenance = {
  inputIndex: number
  fundingBlockHash: string
  fundingTxid: string
  fundingVout: number
  bindingKind: "wallet" | "deposit"
  walletID: string
  outputKey: string
  sourceEventID: string
  ethereumBlockNumber: number
  ethereumBlockHash: string
}

/**
 * Input-specific canonical identity. The occurrence fields intentionally remain
 * outside the Bridge challenge identity: two inputs may carry the same signed
 * authorization, but they must still be reconciled independently.
 */
export type P2TRCompleteCandidateIdentity = {
  schema: "tbtc-p2tr-complete-candidate/v2"
  txid: string
  wtxid: string
  blockHeight: number
  blockHash: string
  inputIndex: number
  evidence: P2TRCompleteChallengeEvidence
  challengeIdentity: string
}

const verifiedCompleteIdentities = new WeakSet<object>()
const completeIdentityBrand: unique symbol = Symbol(
  "P2TRVerifiedCompleteCandidateIdentity"
)

export type P2TRVerifiedCompleteCandidateIdentity = {
  readonly [completeIdentityBrand]: true
  readonly value: Readonly<P2TRCompleteCandidateIdentity>
  readonly domain: Readonly<P2TRCompleteBridgeDomain>
  readonly occurrenceDigest: string
}

export function computeP2TRCompleteChallengeIdentity(
  domainValue: P2TRCompleteBridgeDomain,
  evidenceValue: Pick<
    P2TRCompleteChallengeEvidence,
    "walletID" | "signingKey" | "sighash"
  >
): string {
  const domain = normalizeP2TRCompleteBridgeDomain(domainValue)
  const walletID = bytes32(evidenceValue.walletID, "wallet ID")
  const signingKey = bytes32(evidenceValue.signingKey, "signing key")
  const sighash = bytes32(evidenceValue.sighash, "BIP-341 sighash")
  const chainID = Buffer.from(
    BigInt(domain.domainChainID).toString(16).padStart(64, "0"),
    "hex"
  )
  return createHash("sha256")
    .update(P2TR_COMPLETE_AUTHORIZATION_DOMAIN, "utf8")
    .update(chainID)
    .update(Buffer.from(domain.bridgeAddress.slice(2), "hex"))
    .update(Buffer.from(walletID, "hex"))
    .update(Buffer.from(signingKey, "hex"))
    .update(Buffer.from(sighash, "hex"))
    .digest("hex")
}

export function encodeP2TRCompleteChallengeEvidence(
  value: P2TRCompleteChallengeEvidence
): string {
  const evidence = normalizeP2TRCompleteChallengeEvidence(value)
  const bindingOutputIndex = Buffer.alloc(32)
  bindingOutputIndex.writeUInt32BE(evidence.bindingOutputIndex, 28)
  return Buffer.concat([
    Buffer.from(evidence.walletID, "hex"),
    Buffer.from(evidence.signingKey, "hex"),
    Buffer.from(evidence.bindingTxHash, "hex"),
    bindingOutputIndex,
    Buffer.from(evidence.sighash, "hex"),
    Buffer.from(evidence.nonceX, "hex"),
    Buffer.from(evidence.signatureScalar, "hex"),
  ]).toString("hex")
}

/**
 * Validates the COMPLETE_V2 shape and authorization identity and issues a
 * process-local brand. This does not replace the canonical raw transaction and
 * BIP-341 verification performed while the source snapshot is locked.
 */
export function verifyP2TRCompleteCandidateIdentity(
  value: P2TRCompleteCandidateIdentity,
  domainValue: P2TRCompleteBridgeDomain
): P2TRVerifiedCompleteCandidateIdentity {
  const identity = normalizeP2TRCompleteCandidateIdentity(value)
  const domain = normalizeP2TRCompleteBridgeDomain(domainValue)
  if (
    identity.challengeIdentity !==
    computeP2TRCompleteChallengeIdentity(domain, identity.evidence)
  ) {
    throw new Error("COMPLETE_V2 challenge identity is invalid")
  }
  const result = Object.freeze({
    [completeIdentityBrand]: true as const,
    value: deepFreeze(structuredClone(identity)),
    domain: Object.freeze(structuredClone(domain)),
    occurrenceDigest: createHash("sha256")
      .update(
        canonicalJSON({
          schema: "tbtc-p2tr-complete-candidate-occurrence/v2",
          identity,
          domain,
        }),
        "utf8"
      )
      .digest("hex"),
  }) as P2TRVerifiedCompleteCandidateIdentity
  verifiedCompleteIdentities.add(result)
  return result
}

export function assertP2TRVerifiedCompleteCandidateIdentity(
  value: P2TRVerifiedCompleteCandidateIdentity,
  expected?: {
    inputIndex?: number
    challengeIdentity?: string
  }
): Readonly<P2TRCompleteCandidateIdentity> {
  if (!verifiedCompleteIdentities.has(value as object)) {
    throw new Error("COMPLETE_V2 identity was not verified by this runtime")
  }
  if (
    (expected?.inputIndex !== undefined &&
      value.value.inputIndex !==
        uint32(expected.inputIndex, "expected input index")) ||
    (expected?.challengeIdentity !== undefined &&
      value.value.challengeIdentity !==
        bytes32(expected.challengeIdentity, "expected challenge identity"))
  ) {
    throw new Error("Verified COMPLETE_V2 identity names another input")
  }
  return value.value
}

export function normalizeP2TRCompleteCandidateIdentity(
  value: P2TRCompleteCandidateIdentity
): P2TRCompleteCandidateIdentity {
  if (value.schema !== "tbtc-p2tr-complete-candidate/v2") {
    throw new Error("Legacy or unsupported candidate identity is forbidden")
  }
  return {
    schema: value.schema,
    txid: bytes32(value.txid, "candidate txid"),
    wtxid: bytes32(value.wtxid, "candidate wtxid"),
    blockHeight: nonNegativeInteger(value.blockHeight, "candidate height"),
    blockHash: bytes32(value.blockHash, "candidate block hash"),
    inputIndex: uint32(value.inputIndex, "candidate input index"),
    evidence: normalizeP2TRCompleteChallengeEvidence(value.evidence),
    challengeIdentity: bytes32(
      value.challengeIdentity,
      "COMPLETE_V2 challenge identity"
    ),
  }
}

export function normalizeP2TRCompleteChallengeEvidence(
  value: P2TRCompleteChallengeEvidence
): P2TRCompleteChallengeEvidence {
  const result = {
    walletID: bytes32(value.walletID, "evidence wallet ID"),
    signingKey: bytes32(value.signingKey, "evidence signing key"),
    bindingTxHash: bytes32(value.bindingTxHash, "evidence binding tx hash"),
    bindingOutputIndex: uint32(
      value.bindingOutputIndex,
      "evidence binding output index"
    ),
    sighash: bytes32(value.sighash, "evidence sighash"),
    nonceX: bytes32(value.nonceX, "evidence signature nonce"),
    signatureScalar: bytes32(
      value.signatureScalar,
      "evidence signature scalar"
    ),
  }
  const zero = "0".repeat(64)
  if (
    result.signingKey === result.walletID
      ? result.bindingTxHash !== zero || result.bindingOutputIndex !== 0
      : result.bindingTxHash === zero
  ) {
    throw new Error("COMPLETE_V2 signing-key binding is not canonical")
  }
  return result
}

export function normalizeP2TRCompleteBridgeDomain(
  value: P2TRCompleteBridgeDomain
): P2TRCompleteBridgeDomain {
  if (
    typeof value.domainChainID !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value.domainChainID)
  ) {
    throw new Error("Bridge domain chain ID must be canonical base-10 uint256")
  }
  const chainID = BigInt(value.domainChainID)
  if (chainID > (1n << 256n) - 1n) {
    throw new Error("Bridge domain chain ID exceeds uint256")
  }
  return {
    domainChainID: chainID.toString(10),
    bridgeAddress: address(value.bridgeAddress, "Bridge address"),
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
      throw new Error("Canonical number is unsafe")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`
  }
  throw new Error("Canonical COMPLETE_V2 value is unsupported")
}

function bytes32(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be 32 bytes`)
  }
  return normalized
}

function address(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`)
  const normalized = value.toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be 20 bytes`)
  }
  return `0x${normalized}`
}

function uint32(value: number, label: string): number {
  const result = nonNegativeInteger(value, label)
  if (result > 0xffffffff) throw new Error(`${label} exceeds uint32`)
  return result
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}
