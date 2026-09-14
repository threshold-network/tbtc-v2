import { Hex } from "@keep-network/tbtc-v2.ts"

/**
 * Shared normalization for 32-byte hashes and 20-byte Ethereum addresses.
 *
 * These values gate irreversible, terminal decisions (signer invocation,
 * irreversible boundary authorization, broadcast, durable store column
 * identity) and feed deterministic digests (record IDs, reconciler request
 * bindings, cancellation evidence hashes). Four call sites used to each carry
 * their own copy of these normalizers and had drifted apart on:
 *   - whether the all-zero value (the zero address) was rejected,
 *   - whether the input had to be 0x-prefixed,
 *   - the casing/prefix of the returned canonical form.
 *
 * One policy must hold everywhere so a future edit to one path cannot silently
 * change only part of the system. The strict choices below are:
 *   - reject the zero Ethereum address (security-relevant; never a legitimate
 *     sender/recipient/attester here);
 *   - accept either 0x-prefixed or bare hex (parsing convenience, not a
 *     validation weakening);
 *   - always return 0x-prefixed lowercase.
 *
 * The zero 32-byte hash is intentionally NOT rejected — it is sometimes used
 * legitimately as a "no binding" sentinel in this codebase.
 */

const toCanonicalHex = (
  value: unknown,
  expectedLength: number,
  label: string
): string => {
  let bytes: Buffer
  if (value instanceof Hex) {
    bytes = value.toBuffer()
  } else if (Buffer.isBuffer(value)) {
    bytes = Buffer.from(value)
  } else if (typeof value === "string") {
    const unprefixed = value.replace(/^0x/i, "")
    if (!/^[0-9a-fA-F]*$/.test(unprefixed) || unprefixed.length % 2 !== 0) {
      throw new Error(`${label} must be ${expectedLength} bytes`)
    }
    bytes = Buffer.from(unprefixed, "hex")
  } else {
    throw new Error(`${label} must be ${expectedLength} bytes`)
  }
  if (bytes.length !== expectedLength) {
    throw new Error(`${label} must be ${expectedLength} bytes`)
  }
  return `0x${bytes.toString("hex")}`
}

export const normalizeBytes32 = (value: unknown, label: string): string =>
  toCanonicalHex(value, 32, label)

export const normalizeAddress = (value: unknown, label: string): string => {
  const normalized = toCanonicalHex(value, 20, label)
  if (/^0x0{40}$/.test(normalized)) {
    throw new Error(`${label} must be a non-zero Ethereum address`)
  }
  return normalized
}
