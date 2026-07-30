import { createHash } from "node:crypto"

export const P2TR_CANONICAL_OCCURRENCE_ID_DOMAIN =
  "tbtc-p2tr-canonical-occurrence-v1" as const

/**
 * Immutable, store-independent coordinates for one canonical candidate input.
 * `challengeIdentity` is present only for a key-path disposition and remains
 * the Bridge challenge-series identity, not the local occurrence identity.
 */
export type P2TRCanonicalOccurrenceIdentityInput = {
  domainDigest: string
  provenanceGeneration: number
  blockHash: string
  txid: string
  wtxid: string
  inputIndex: number
  provenanceFingerprint: string
  challengeIdentity?: string
}

/**
 * Computes the byte-exact identity mirrored by
 * `p2tr_canonical_occurrence_id` in the canonical PostgreSQL migration.
 */
export function calculateP2TRCanonicalOccurrenceID(
  value: P2TRCanonicalOccurrenceIdentityInput
): string {
  const challengeIdentity =
    value.challengeIdentity === undefined
      ? undefined
      : bytes32(value.challengeIdentity, "occurrence challenge identity")
  return createHash("sha256")
    .update(P2TR_CANONICAL_OCCURRENCE_ID_DOMAIN, "utf8")
    .update(bytes32Buffer(value.domainDigest, "occurrence domain digest"))
    .update(
      int64BE(value.provenanceGeneration, "occurrence provenance generation")
    )
    .update(bytes32Buffer(value.blockHash, "occurrence block hash"))
    .update(bytes32Buffer(value.txid, "occurrence transaction ID"))
    .update(bytes32Buffer(value.wtxid, "occurrence witness transaction ID"))
    .update(int32BE(value.inputIndex, "occurrence input index"))
    .update(
      bytes32Buffer(
        value.provenanceFingerprint,
        "occurrence provenance fingerprint"
      )
    )
    .update(Buffer.from([challengeIdentity === undefined ? 0 : 1]))
    .update(
      challengeIdentity === undefined
        ? Buffer.alloc(0)
        : Buffer.from(challengeIdentity, "hex")
    )
    .digest("hex")
}

const bytes32Buffer = (value: string, field: string): Buffer =>
  Buffer.from(bytes32(value, field), "hex")

const bytes32 = (value: string, field: string): string => {
  if (typeof value !== "string") throw new Error(`${field} is malformed`)
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 32-byte hex value`)
  }
  return normalized
}

const int64BE = (value: number, field: string): Buffer => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`)
  }
  const result = Buffer.alloc(8)
  result.writeBigInt64BE(BigInt(value))
  return result
}

const int32BE = (value: number, field: string): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new Error(`${field} must fit a non-negative PostgreSQL integer`)
  }
  const result = Buffer.alloc(4)
  result.writeInt32BE(value)
  return result
}
