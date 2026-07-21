import { createHash } from "node:crypto"

export const P2TR_SIGHASH_DEFAULT = 0x00 as const
export const P2TR_SIGHASH_ALL = 0x01 as const
export const P2TR_SIGHASH_NONE = 0x02 as const
export const P2TR_SIGHASH_SINGLE = 0x03 as const
export const P2TR_SIGHASH_ANYONECANPAY_ALL = 0x81 as const
export const P2TR_SIGHASH_ANYONECANPAY_NONE = 0x82 as const
export const P2TR_SIGHASH_ANYONECANPAY_SINGLE = 0x83 as const

export const P2TR_KEY_PATH_SIGHASH_TYPES = [
  P2TR_SIGHASH_DEFAULT,
  P2TR_SIGHASH_ALL,
  P2TR_SIGHASH_NONE,
  P2TR_SIGHASH_SINGLE,
  P2TR_SIGHASH_ANYONECANPAY_ALL,
  P2TR_SIGHASH_ANYONECANPAY_NONE,
  P2TR_SIGHASH_ANYONECANPAY_SINGLE,
] as const

export type P2TRKeyPathSighashType =
  (typeof P2TR_KEY_PATH_SIGHASH_TYPES)[number]

const P2TR_KEY_PATH_SIGHASH_TYPE_SET = new Set<number>(
  P2TR_KEY_PATH_SIGHASH_TYPES
)

export type P2TRWitnessErrorCode =
  | "invalid-signature-length"
  | "explicit-default-sighash"
  | "unsupported-sighash"
  | "invalid-annex"

export class P2TRWitnessError extends Error {
  readonly code: P2TRWitnessErrorCode

  constructor(code: P2TRWitnessErrorCode, message: string) {
    super(message)
    this.name = "P2TRWitnessError"
    this.code = code
  }
}

export type P2TRKeyPathWitness = {
  kind: "key-path"
  /** The exact witness item, including a non-default sighash byte if present. */
  witnessSignature: Buffer
  /** The 64-byte BIP-340 signature without a sighash byte. */
  signature: Buffer
  nonceX: Buffer
  signatureScalar: Buffer
  sighashType: P2TRKeyPathSighashType
  /** The complete annex, including its mandatory 0x50 prefix. */
  annex?: Buffer
}

export type P2TRScriptPathWitness = {
  kind: "script-path"
  script: Buffer
  controlBlock: Buffer
  annex?: Buffer
  stackItemCount: number
}

export type P2TRWitnessClassification =
  | { kind: "empty" }
  | P2TRKeyPathWitness
  | P2TRScriptPathWitness

/**
 * Classifies a Taproot witness using BIP-341's annex-removal rule.
 *
 * Empty and script-path witnesses are terminal classifications so callers can
 * apply wallet/deposit policy without confusing them with malformed key-path
 * signatures. A one-item key-path form is parsed strictly and throws for any
 * non-canonical signature length or sighash byte.
 */
export const classifyP2TRWitness = (
  witness: readonly Uint8Array[]
): P2TRWitnessClassification => {
  if (witness.length === 0) return { kind: "empty" }

  const items = witness.map((item) => Buffer.from(item))
  const lastItem = items[items.length - 1]
  const hasAnnex =
    items.length >= 2 && lastItem.length > 0 && lastItem[0] === 0x50
  const annex = hasAnnex ? lastItem : undefined
  const spendItems = hasAnnex ? items.slice(0, -1) : items

  if (spendItems.length >= 2) {
    return {
      kind: "script-path",
      script: spendItems[spendItems.length - 2],
      controlBlock: spendItems[spendItems.length - 1],
      annex,
      stackItemCount: spendItems.length - 2,
    }
  }

  // With a non-empty original witness, BIP-341's annex rule cannot remove the
  // only item. The remaining vector therefore always has one item here.
  return parseP2TRKeyPathWitnessSignature(spendItems[0], annex)
}

/**
 * Store-facing convenience for callers interested only in key-path spends.
 * Use `classifyP2TRWitness` when empty and script-path policy differs.
 */
export const parseP2TRKeyPathSignature = (
  witness: readonly Uint8Array[]
): P2TRKeyPathWitness | undefined => {
  const classification = classifyP2TRWitness(witness)
  return classification.kind === "key-path" ? classification : undefined
}

const parseP2TRKeyPathWitnessSignature = (
  witnessSignature: Uint8Array,
  annex?: Buffer
): P2TRKeyPathWitness => {
  const serialized = Buffer.from(witnessSignature)
  if (serialized.length !== 64 && serialized.length !== 65) {
    throw new P2TRWitnessError(
      "invalid-signature-length",
      "Taproot key-path witness signature must be 64 or 65 bytes"
    )
  }

  let sighashType: P2TRKeyPathSighashType = P2TR_SIGHASH_DEFAULT
  if (serialized.length === 65) {
    const explicitSighashType = serialized[64]
    if (explicitSighashType === P2TR_SIGHASH_DEFAULT) {
      throw new P2TRWitnessError(
        "explicit-default-sighash",
        "Taproot SIGHASH_DEFAULT must use the canonical 64-byte signature form"
      )
    }
    if (!P2TR_KEY_PATH_SIGHASH_TYPE_SET.has(explicitSighashType)) {
      throw new P2TRWitnessError(
        "unsupported-sighash",
        "Taproot key-path witness signature uses an undefined sighash type"
      )
    }
    sighashType = explicitSighashType as P2TRKeyPathSighashType
  }

  const signature = Buffer.from(serialized.subarray(0, 64))
  return {
    kind: "key-path",
    witnessSignature: serialized,
    signature,
    nonceX: Buffer.from(signature.subarray(0, 32)),
    signatureScalar: Buffer.from(signature.subarray(32, 64)),
    sighashType,
    annex,
  }
}

/** A bitcoinjs-compatible input. `hash` is the 32-byte wire-order tx hash. */
export type P2TRBIP341TransactionInput = {
  hash: Uint8Array
  index: number
  sequence: number
}

export type P2TRBIP341TransactionOutput = {
  value: number | bigint
  script: Uint8Array
}

/** Structural subset of bitcoinjs-lib's `Transaction`. */
export type P2TRBIP341Transaction = {
  version: number
  locktime: number
  ins: readonly P2TRBIP341TransactionInput[]
  outs: readonly P2TRBIP341TransactionOutput[]
}

export type P2TRBIP341Prevout = {
  /** Conventional human/display-order transaction ID. */
  txid: string
  vout: number
  valueSats: number | bigint
  scriptPubKey: Uint8Array
}

export type P2TRBIP341SharedCommitments = {
  shaPrevouts: string | Uint8Array
  shaAmounts: string | Uint8Array
  shaScriptPubKeys: string | Uint8Array
  shaSequences: string | Uint8Array
  shaOutputs: string | Uint8Array
}

export type P2TRBIP341SharedCommitmentHex = {
  shaPrevouts: string
  shaAmounts: string
  shaScriptPubKeys: string
  shaSequences: string
  shaOutputs: string
}

/**
 * Computes the reusable BIP-341 transaction commitments from an authenticated,
 * ordered prevout vector. Every display-order prevout txid/vout is checked
 * against the transaction's wire-order outpoint before it can affect a hash.
 */
export const computeP2TRKeyPathSharedCommitments = (
  transaction: P2TRBIP341Transaction,
  prevouts: readonly P2TRBIP341Prevout[]
): P2TRBIP341SharedCommitmentHex => {
  if (prevouts.length !== transaction.ins.length) {
    throw new Error(
      "BIP-341 prevout vector length must match the transaction input vector"
    )
  }

  const shaPrevouts = createHash("sha256")
  const shaAmounts = createHash("sha256")
  const shaScriptPubKeys = createHash("sha256")
  const shaSequences = createHash("sha256")
  const shaOutputs = createHash("sha256")

  for (let inputIndex = 0; inputIndex < transaction.ins.length; inputIndex++) {
    const input = transaction.ins[inputIndex]
    const prevout = prevouts[inputIndex]
    validatePrevoutMatchesInput(input, prevout)
    shaPrevouts.update(serializeTransactionInputOutpoint(input))
    shaAmounts.update(uint64LE(prevout.valueSats, "BIP-341 prevout value"))
    shaScriptPubKeys.update(serializeBitcoinScript(prevout.scriptPubKey))
    shaSequences.update(
      uint32LE(input.sequence, "BIP-341 transaction input sequence")
    )
  }
  for (const output of transaction.outs) {
    shaOutputs.update(serializeBitcoinOutput(output))
  }

  return {
    shaPrevouts: shaPrevouts.digest("hex"),
    shaAmounts: shaAmounts.digest("hex"),
    shaScriptPubKeys: shaScriptPubKeys.digest("hex"),
    shaSequences: shaSequences.digest("hex"),
    shaOutputs: shaOutputs.digest("hex"),
  }
}

export type CalculateP2TRKeyPathSighashArguments = {
  transaction: P2TRBIP341Transaction
  inputIndex: number
  hashType: P2TRKeyPathSighashType
  annex?: Uint8Array
  currentPrevout: P2TRBIP341Prevout
  /** Preauthenticated reusable hashes for the same transaction/prevout vector. */
  commitments: P2TRBIP341SharedCommitments
}

/**
 * Calculates BIP-341 `hash_TapSighash(0x00 || SigMsg(hashType, 0))` for a
 * key-path spend. This covers every consensus-defined hash type and annexes.
 */
export const calculateP2TRKeyPathSighash = ({
  transaction,
  inputIndex,
  hashType,
  annex,
  currentPrevout,
  commitments,
}: CalculateP2TRKeyPathSighashArguments): string => {
  if (!P2TR_KEY_PATH_SIGHASH_TYPE_SET.has(hashType)) {
    throw new Error("BIP-341 key-path sighash type is undefined")
  }
  const normalizedInputIndex = uint32(
    inputIndex,
    "BIP-341 signed input index"
  )
  const input = transaction.ins[normalizedInputIndex]
  if (input === undefined) {
    throw new Error("BIP-341 signed input index is outside the input vector")
  }
  validatePrevoutMatchesInput(input, currentPrevout)

  const baseType = hashType & 0x03
  if (
    baseType === P2TR_SIGHASH_SINGLE &&
    normalizedInputIndex >= transaction.outs.length
  ) {
    throw new Error(
      "BIP-341 SIGHASH_SINGLE requires a corresponding transaction output"
    )
  }

  const normalizedAnnex = normalizeAnnex(annex)
  const anyoneCanPay = (hashType & 0x80) !== 0
  const commitsAllOutputs =
    hashType === P2TR_SIGHASH_DEFAULT || baseType === P2TR_SIGHASH_ALL
  const sigMsg: Buffer[] = [
    Buffer.from([hashType]),
    int32LE(transaction.version, "BIP-341 transaction version"),
    uint32LE(transaction.locktime, "BIP-341 transaction locktime"),
  ]

  if (!anyoneCanPay) {
    sigMsg.push(
      hash32(commitments.shaPrevouts, "BIP-341 sha_prevouts"),
      hash32(commitments.shaAmounts, "BIP-341 sha_amounts"),
      hash32(commitments.shaScriptPubKeys, "BIP-341 sha_scriptpubkeys"),
      hash32(commitments.shaSequences, "BIP-341 sha_sequences")
    )
  }
  if (commitsAllOutputs) {
    sigMsg.push(hash32(commitments.shaOutputs, "BIP-341 sha_outputs"))
  }

  // ext_flag is zero for key-path spends, so spend_type is annex_present.
  sigMsg.push(Buffer.from([normalizedAnnex === undefined ? 0 : 1]))
  if (anyoneCanPay) {
    sigMsg.push(
      serializeTransactionInputOutpoint(input),
      uint64LE(currentPrevout.valueSats, "BIP-341 current prevout value"),
      serializeBitcoinScript(currentPrevout.scriptPubKey),
      uint32LE(input.sequence, "BIP-341 transaction input sequence")
    )
  } else {
    sigMsg.push(
      uint32LE(normalizedInputIndex, "BIP-341 signed input index")
    )
  }

  if (normalizedAnnex !== undefined) {
    sigMsg.push(sha256(serializeBitcoinScript(normalizedAnnex)))
  }
  if (baseType === P2TR_SIGHASH_SINGLE) {
    sigMsg.push(
      sha256(serializeBitcoinOutput(transaction.outs[normalizedInputIndex]))
    )
  }

  return taggedHash("TapSighash", [Buffer.from([0x00]), ...sigMsg]).toString(
    "hex"
  )
}

/** Encodes a Bitcoin CompactSize unsigned integer canonically. */
export const encodeBitcoinCompactSize = (value: number | bigint): Buffer => {
  const normalized = uint64(value, "Bitcoin CompactSize value")
  if (normalized < 0xfdn) return Buffer.from([Number(normalized)])
  if (normalized <= 0xffffn) {
    const output = Buffer.allocUnsafe(3)
    output[0] = 0xfd
    output.writeUInt16LE(Number(normalized), 1)
    return output
  }
  if (normalized <= 0xffffffffn) {
    const output = Buffer.allocUnsafe(5)
    output[0] = 0xfe
    output.writeUInt32LE(Number(normalized), 1)
    return output
  }
  const output = Buffer.allocUnsafe(9)
  output[0] = 0xff
  output.writeBigUInt64LE(normalized, 1)
  return output
}

/** Serializes a display-order txid as a consensus wire-order COutPoint. */
export const serializeBitcoinOutpointFromDisplayTxid = (
  txid: string,
  vout: number
): Buffer =>
  Buffer.concat([
    Buffer.from(normalizeTxid(txid), "hex").reverse(),
    uint32LE(vout, "Bitcoin outpoint index"),
  ])

/** Converts the wire-order hash exposed by bitcoinjs-lib to a display txid. */
export const displayTxidFromWireHash = (wireHash: Uint8Array): string => {
  const normalized = bytes(wireHash, "Bitcoin wire-order transaction hash")
  if (normalized.length !== 32) {
    throw new Error("Bitcoin wire-order transaction hash must be 32 bytes")
  }
  return Buffer.from(normalized).reverse().toString("hex")
}

const validatePrevoutMatchesInput = (
  input: P2TRBIP341TransactionInput,
  prevout: P2TRBIP341Prevout
): void => {
  const inputVout = uint32(input.index, "BIP-341 transaction input index")
  const prevoutVout = uint32(prevout.vout, "BIP-341 prevout index")
  const actualDisplayTxid = displayTxidFromWireHash(input.hash)
  const expectedDisplayTxid = normalizeTxid(prevout.txid)
  if (actualDisplayTxid !== expectedDisplayTxid || inputVout !== prevoutVout) {
    throw new Error(
      "BIP-341 display-order prevout does not match transaction input outpoint"
    )
  }
}

const serializeTransactionInputOutpoint = (
  input: P2TRBIP341TransactionInput
): Buffer => {
  const wireHash = bytes(input.hash, "BIP-341 transaction input hash")
  if (wireHash.length !== 32) {
    throw new Error("BIP-341 transaction input hash must be 32 bytes")
  }
  return Buffer.concat([
    wireHash,
    uint32LE(input.index, "BIP-341 transaction input index"),
  ])
}

const serializeBitcoinScript = (script: Uint8Array): Buffer => {
  const normalized = bytes(script, "Bitcoin script")
  return Buffer.concat([
    encodeBitcoinCompactSize(normalized.length),
    normalized,
  ])
}

const serializeBitcoinOutput = (
  output: P2TRBIP341TransactionOutput
): Buffer =>
  Buffer.concat([
    uint64LE(output.value, "BIP-341 transaction output value"),
    serializeBitcoinScript(output.script),
  ])

const normalizeAnnex = (annex: Uint8Array | undefined): Buffer | undefined => {
  if (annex === undefined) return undefined
  const normalized = bytes(annex, "BIP-341 annex")
  if (normalized.length === 0 || normalized[0] !== 0x50) {
    throw new P2TRWitnessError(
      "invalid-annex",
      "BIP-341 annex must be non-empty and start with 0x50"
    )
  }
  return normalized
}

const taggedHash = (tag: string, chunks: readonly Uint8Array[]): Buffer => {
  const tagHash = sha256(Buffer.from(tag, "utf8"))
  const hash = createHash("sha256")
  hash.update(tagHash)
  hash.update(tagHash)
  for (const chunk of chunks) hash.update(chunk)
  return hash.digest()
}

const sha256 = (value: Uint8Array): Buffer =>
  createHash("sha256").update(value).digest()

const hash32 = (value: string | Uint8Array, field: string): Buffer => {
  const normalized =
    typeof value === "string"
      ? Buffer.from(normalizeHex(value, field), "hex")
      : bytes(value, field)
  if (normalized.length !== 32) {
    throw new Error(`${field} must be 32 bytes`)
  }
  return normalized
}

const bytes = (value: Uint8Array, field: string): Buffer => {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${field} must be bytes`)
  }
  return Buffer.from(value)
}

const normalizeHex = (value: string, field: string): string => {
  const normalized = value.replace(/^0x/i, "").toLowerCase()
  if (normalized.length % 2 !== 0 || !/^[0-9a-f]*$/.test(normalized)) {
    throw new Error(`${field} must be even-length hex`)
  }
  return normalized
}

const normalizeTxid = (value: string): string => {
  const normalized = normalizeHex(value, "Bitcoin display transaction ID")
  if (normalized.length !== 64) {
    throw new Error("Bitcoin display transaction ID must be 32-byte hex")
  }
  return normalized
}

const int32LE = (value: number, field: string): Buffer => {
  if (
    !Number.isInteger(value) ||
    value < -0x80000000 ||
    value > 0x7fffffff
  ) {
    throw new Error(`${field} must be an int32`)
  }
  const output = Buffer.allocUnsafe(4)
  output.writeInt32LE(value)
  return output
}

const uint32LE = (value: number, field: string): Buffer => {
  const normalized = uint32(value, field)
  const output = Buffer.allocUnsafe(4)
  output.writeUInt32LE(normalized)
  return output
}

const uint64LE = (value: number | bigint, field: string): Buffer => {
  const normalized = uint64(value, field)
  const output = Buffer.allocUnsafe(8)
  output.writeBigUInt64LE(normalized)
  return output
}

const uint32 = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${field} must be a uint32`)
  }
  return value
}

const uint64 = (value: number | bigint, field: string): bigint => {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error(`${field} number must be a safe integer`)
  }
  const normalized = BigInt(value)
  if (normalized < 0n || normalized > 0xffffffffffffffffn) {
    throw new Error(`${field} must be a uint64`)
  }
  return normalized
}
