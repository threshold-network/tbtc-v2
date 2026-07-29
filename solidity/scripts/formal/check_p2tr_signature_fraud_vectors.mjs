#!/usr/bin/env node

import crypto from "crypto"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { stripCommentsForGate } from "./_evidence_manifest_lib.mjs"

const FIELD_P =
  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const ORDER_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const GENERATOR = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
}
const DRAFT_CHALLENGE_ID_DOMAIN = Buffer.from(
  "tbtc-p2tr-signature-fraud-challenge-v0",
  "utf8"
)
const BRIDGE_CHALLENGE_ID_DOMAIN = Buffer.from(
  "tbtc-p2tr-signature-fraud-bridge-challenge-v1",
  "utf8"
)
const SIGHASH_DEFAULT = 0
const SIGHASH_ALL = 1
const REQUIRED_SIGHASH_TYPES = new Map([
  [SIGHASH_DEFAULT, "SIGHASH_DEFAULT"],
  [SIGHASH_ALL, "SIGHASH_ALL"],
])
const WITNESS_ERROR_INVALID_LENGTH = "invalid-length"
const WITNESS_ERROR_UNSUPPORTED_SIGHASH = "unsupported-sighash"
const FLOW_SHAPED_DRAFT_EVIDENCE_LEVEL = "flow-shaped-draft-vector-seed"
const FLOW_PROOF_CORRELATION_REQUIRED = "required-not-present"
const FLOW_SHAPED_DRAFT_SPEND_TYPES = new Set(["moving-funds", "redemption"])

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, "../../..")
const vectorsPath = path.join(
  rootDir,
  "docs/test-vectors/p2tr-signature-fraud-v0.json"
)
const productionP2TRSignatureFraudPath = path.join(
  rootDir,
  "solidity/contracts/bridge/P2TRSignatureFraud.sol"
)
const checkBitcoinP2TRSignatureFraudPath = path.join(
  rootDir,
  "solidity/contracts/bridge/CheckBitcoinP2TRSignatureFraud.sol"
)
const prototypeP2TRSignatureFraudPath = path.join(
  rootDir,
  "solidity/contracts/prototypes/PrototypeP2TRSignatureFraud.sol"
)

const fail = (message) => {
  console.error(`[vector-conformance] ${message}`)
  process.exit(1)
}

const requireObject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }

  return value
}

const requireArray = (value, label) => {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`)
  }

  return value
}

const requireNonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`)
  }

  return value
}

const sha256 = (...payloads) => {
  const hash = crypto.createHash("sha256")
  for (const payload of payloads) {
    hash.update(payload)
  }
  return hash.digest()
}

const taggedHash = (tag, payload) => {
  const tagHash = sha256(Buffer.from(tag, "utf8"))
  return sha256(tagHash, tagHash, payload)
}

const hexToBuffer = (hex, byteLength, fieldName) => {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]*$/.test(hex)) {
    fail(`${fieldName} must be hex`)
  }
  if (hex.length % 2 !== 0) {
    fail(`${fieldName} must have even hex length`)
  }
  const buffer = Buffer.from(hex, "hex")
  if (byteLength !== undefined && buffer.length !== byteLength) {
    fail(`${fieldName} must be ${byteLength} bytes`)
  }
  return buffer
}

const bytesToNumber = (bytes) => {
  const hex = Buffer.from(bytes).toString("hex")
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`)
}

const numberToBytes32 = (value) => {
  const hex = value.toString(16).padStart(64, "0")
  return Buffer.from(hex, "hex")
}

const mod = (value, modulus = FIELD_P) => {
  const result = value % modulus
  return result >= 0n ? result : result + modulus
}

const modPow = (base, exponent, modulus) => {
  let result = 1n
  let b = mod(base, modulus)
  let e = exponent
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % modulus
    }
    b = (b * b) % modulus
    e >>= 1n
  }
  return result
}

const inverse = (value, modulus = FIELD_P) => {
  const normalized = mod(value, modulus)
  if (normalized === 0n) {
    fail("attempted division by zero")
  }
  return modPow(normalized, modulus - 2n, modulus)
}

const liftX = (x) => {
  if (x >= FIELD_P) {
    return null
  }
  const ySquared = mod(x ** 3n + 7n)
  let y = modPow(ySquared, (FIELD_P + 1n) / 4n, FIELD_P)
  if (mod(y * y) !== ySquared) {
    return null
  }
  if (y % 2n !== 0n) {
    y = FIELD_P - y
  }
  return { x, y }
}

const pointAdd = (left, right) => {
  if (left === null) return right
  if (right === null) return left

  if (left.x === right.x) {
    if (mod(left.y + right.y) === 0n) {
      return null
    }
    const slope = mod(3n * left.x * left.x * inverse(2n * left.y))
    const x = mod(slope * slope - left.x - right.x)
    const y = mod(slope * (left.x - x) - left.y)
    return { x, y }
  }

  const slope = mod((right.y - left.y) * inverse(right.x - left.x))
  const x = mod(slope * slope - left.x - right.x)
  const y = mod(slope * (left.x - x) - left.y)
  return { x, y }
}

const pointMultiply = (scalar, point = GENERATOR) => {
  let k = mod(scalar, ORDER_N)
  let result = null
  let addend = point
  while (k > 0n) {
    if (k & 1n) {
      result = pointAdd(result, addend)
    }
    addend = pointAdd(addend, addend)
    k >>= 1n
  }
  return result
}

const bip340Verify = (message, publicKey, signature) => {
  if (
    message.length !== 32 ||
    publicKey.length !== 32 ||
    signature.length !== 64
  ) {
    return false
  }

  const r = bytesToNumber(signature.subarray(0, 32))
  const s = bytesToNumber(signature.subarray(32, 64))
  if (r >= FIELD_P || s >= ORDER_N) {
    return false
  }

  const publicPoint = liftX(bytesToNumber(publicKey))
  if (publicPoint === null) {
    return false
  }

  const challenge = bytesToNumber(
    taggedHash(
      "BIP0340/challenge",
      Buffer.concat([signature.subarray(0, 32), publicKey, message])
    )
  )
  const e = challenge % ORDER_N
  const rPoint = pointAdd(
    pointMultiply(s),
    pointMultiply(ORDER_N - e, publicPoint)
  )

  return rPoint !== null && rPoint.y % 2n === 0n && rPoint.x === r
}

const readCompactSize = (reader, context) => {
  const first = reader.read(1)[0]
  if (first < 0xfd) {
    return first
  }
  if (first === 0xfd) {
    return reader.read(2).readUInt16LE(0)
  }
  if (first === 0xfe) {
    return reader.read(4).readUInt32LE(0)
  }
  const value = reader.read(8).readBigUInt64LE(0)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${context}: compact size exceeds safe integer range`)
  }
  return Number(value)
}

const encodeCompactSize = (value) => {
  if (!Number.isInteger(value) || value < 0) {
    fail("invalid compact size value")
  }
  if (value < 0xfd) {
    return Buffer.from([value])
  }
  if (value <= 0xffff) {
    const buffer = Buffer.allocUnsafe(3)
    buffer[0] = 0xfd
    buffer.writeUInt16LE(value, 1)
    return buffer
  }
  if (value <= 0xffffffff) {
    const buffer = Buffer.allocUnsafe(5)
    buffer[0] = 0xfe
    buffer.writeUInt32LE(value, 1)
    return buffer
  }
  const buffer = Buffer.allocUnsafe(9)
  buffer[0] = 0xff
  buffer.writeBigUInt64LE(BigInt(value), 1)
  return buffer
}

class Reader {
  constructor(buffer) {
    this.buffer = buffer
    this.offset = 0
  }

  read(length) {
    if (this.offset + length > this.buffer.length) {
      fail("transaction parse exceeded buffer length")
    }
    const value = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }
}

const parseTransaction = (transactionHex) => {
  const raw = hexToBuffer(transactionHex, undefined, "unsignedTransactionHex")
  const reader = new Reader(raw)
  const version = reader.read(4)
  const inputCount = readCompactSize(reader, "input count")
  const inputs = []

  for (let index = 0; index < inputCount; index++) {
    const txid = reader.read(32)
    const vout = reader.read(4)
    const scriptSigLength = readCompactSize(reader, `input ${index} scriptSig`)
    reader.read(scriptSigLength)
    const sequence = reader.read(4)
    inputs.push({
      outpoint: Buffer.concat([txid, vout]),
      sequence,
    })
  }

  const outputCount = readCompactSize(reader, "output count")
  const outputs = []
  for (let index = 0; index < outputCount; index++) {
    const value = reader.read(8)
    const scriptLength = readCompactSize(reader, `output ${index} script`)
    const script = reader.read(scriptLength)
    outputs.push({
      value,
      script,
      raw: Buffer.concat([value, encodeCompactSize(script.length), script]),
    })
  }

  const locktime = reader.read(4)
  if (reader.offset !== raw.length) {
    fail("unexpected trailing transaction bytes")
  }

  return { version, inputs, outputs, locktime }
}

const uint32LE = (value) => {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value, 0)
  return buffer
}

const uint64LE = (value) => {
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeBigUInt64LE(BigInt(value), 0)
  return buffer
}

const scriptWithCompactSize = (script) =>
  Buffer.concat([encodeCompactSize(script.length), script])

const bytesWithCompactSize = (bytes) =>
  Buffer.concat([encodeCompactSize(bytes.length), bytes])

const validatePrevoutMetadata = (vectorId, txInputs, prevouts) => {
  for (const [index, input] of txInputs.entries()) {
    const prevout = prevouts[index]
    const expectedTxid = hexToBuffer(
      prevout.txidHex,
      32,
      `vector ${vectorId}: prevout ${index} txidHex`
    )
    const actualTxid = Buffer.from(input.outpoint.subarray(0, 32)).reverse()
    if (!actualTxid.equals(expectedTxid)) {
      fail(`vector ${vectorId}: prevout ${index} txid mismatch`)
    }
    const actualVout = input.outpoint.readUInt32LE(32)
    if (actualVout !== prevout.vout) {
      fail(`vector ${vectorId}: prevout ${index} vout mismatch`)
    }
  }
}

const computeBip341KeyPathSighash = (vector) => {
  const hashType = vector.sighashType
  if (!REQUIRED_SIGHASH_TYPES.has(hashType)) {
    fail(
      `vector ${vector.id}: only SIGHASH_DEFAULT and SIGHASH_ALL are supported`
    )
  }

  const tx = parseTransaction(vector.unsignedTransactionHex)
  const inputIndex = vector.signedInputIndex
  if (
    !Number.isInteger(inputIndex) ||
    inputIndex < 0 ||
    inputIndex >= tx.inputs.length
  ) {
    fail(`vector ${vector.id}: invalid signedInputIndex`)
  }

  const prevouts = vector.prevouts ?? []
  if (prevouts.length !== tx.inputs.length) {
    fail(`vector ${vector.id}: prevouts length must match transaction inputs`)
  }
  if ((vector.outputs ?? []).length !== tx.outputs.length) {
    fail(`vector ${vector.id}: outputs length must match transaction outputs`)
  }
  validatePrevoutMetadata(vector.id, tx.inputs, prevouts)

  const prevoutScripts = prevouts.map((prevout, index) => {
    const script = hexToBuffer(
      prevout.scriptPubKeyHex,
      undefined,
      `vector ${vector.id}: prevout ${index} scriptPubKeyHex`
    )
    if (script.length > 10000) {
      fail(`vector ${vector.id}: scriptPubKey too large`)
    }
    return script
  })

  for (const [index, output] of tx.outputs.entries()) {
    const expectedOutput = vector.outputs[index]
    const expectedScript = hexToBuffer(
      expectedOutput.scriptPubKeyHex,
      undefined,
      `vector ${vector.id}: output ${index} scriptPubKeyHex`
    )
    if (!output.script.equals(expectedScript)) {
      fail(`vector ${vector.id}: output ${index} script mismatch`)
    }
    if (output.value.readBigUInt64LE(0) !== BigInt(expectedOutput.valueSats)) {
      fail(`vector ${vector.id}: output ${index} value mismatch`)
    }
  }

  const sigMsg = Buffer.concat([
    Buffer.from([hashType]),
    tx.version,
    tx.locktime,
    sha256(...tx.inputs.map((input) => input.outpoint)),
    sha256(...prevouts.map((prevout) => uint64LE(prevout.valueSats))),
    sha256(...prevoutScripts.map(scriptWithCompactSize)),
    sha256(...tx.inputs.map((input) => input.sequence)),
    sha256(...tx.outputs.map((output) => output.raw)),
    Buffer.from([0x00]), // key-path spend, no annex
    uint32LE(inputIndex),
  ])

  return taggedHash("TapSighash", Buffer.concat([Buffer.from([0x00]), sigMsg]))
}

const parseWitnessSignature = (vectorId, witnessSignatureHex) => {
  const witnessSignature = hexToBuffer(
    witnessSignatureHex,
    undefined,
    `vector ${vectorId}: witnessSignatureHex`
  )

  if (witnessSignature.length === 64) {
    return {
      ok: true,
      signature: witnessSignature,
      sighashType: SIGHASH_DEFAULT,
    }
  }

  if (witnessSignature.length !== 65) {
    return {
      ok: false,
      error: WITNESS_ERROR_INVALID_LENGTH,
    }
  }

  const sighashType = witnessSignature[64]
  if (
    sighashType === SIGHASH_DEFAULT ||
    !REQUIRED_SIGHASH_TYPES.has(sighashType)
  ) {
    return {
      ok: false,
      error: WITNESS_ERROR_UNSUPPORTED_SIGHASH,
    }
  }

  return {
    ok: true,
    signature: witnessSignature.subarray(0, 64),
    sighashType,
  }
}

const deriveDraftChallengeIdentity = (vector, sighash, signature) => {
  const txRaw = hexToBuffer(
    vector.unsignedTransactionHex,
    undefined,
    `vector ${vector.id}: unsignedTransactionHex`
  )
  const walletID = hexToBuffer(
    vector.walletIDHex,
    32,
    `vector ${vector.id}: walletIDHex`
  )
  const prevouts = vector.prevouts ?? []
  const preimage = [
    DRAFT_CHALLENGE_ID_DOMAIN,
    walletID,
    sighash,
    signature,
    Buffer.from([vector.sighashType]),
    uint32LE(vector.signedInputIndex),
    bytesWithCompactSize(txRaw),
    encodeCompactSize(prevouts.length),
  ]

  for (const [index, prevout] of prevouts.entries()) {
    preimage.push(
      hexToBuffer(
        prevout.txidHex,
        32,
        `vector ${vector.id}: prevout ${index} txidHex`
      ),
      uint32LE(prevout.vout),
      uint64LE(prevout.valueSats),
      bytesWithCompactSize(
        hexToBuffer(
          prevout.scriptPubKeyHex,
          undefined,
          `vector ${vector.id}: prevout ${index} scriptPubKeyHex`
        )
      )
    )
  }

  return sha256(Buffer.concat(preimage))
}

const deriveBridgeChallengeIdentity = (vector, sighash, signature) => {
  const walletID = hexToBuffer(
    vector.walletIDHex,
    32,
    `vector ${vector.id}: walletIDHex`
  )

  return sha256(
    BRIDGE_CHALLENGE_ID_DOMAIN,
    walletID,
    sighash,
    signature,
    Buffer.from([vector.sighashType])
  )
}

const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf8"))
const productionP2TRSignatureFraud = fs.readFileSync(
  productionP2TRSignatureFraudPath,
  "utf8"
)
const checkBitcoinP2TRSignatureFraud = fs.readFileSync(
  checkBitcoinP2TRSignatureFraudPath,
  "utf8"
)
const prototypeP2TRSignatureFraud = fs.readFileSync(
  prototypeP2TRSignatureFraudPath,
  "utf8"
)
if (vectors.name !== "p2tr-signature-fraud-v0") {
  fail(`unsupported vector corpus [${vectors.name}]`)
}
if (vectors.policy?.taprootSpendPath !== "key-path") {
  fail("only key-path P2TR vectors are supported")
}
if (vectors.policy?.annex !== "absent") {
  fail("only annex-absent P2TR vectors are supported")
}
const checkBitcoinP2TRSignatureFraudExecutable = stripCommentsForGate(
  checkBitcoinP2TRSignatureFraud
)
if (
  !checkBitcoinP2TRSignatureFraudExecutable.includes("validateAnnex") ||
  !checkBitcoinP2TRSignatureFraudExecutable.includes(
    "Annex must start with 0x50"
  )
) {
  // The verifier now reconstructs annex-bearing key-path sighashes. It must
  // still validate the annex explicitly (BIP-341 mandatory 0x50 prefix) rather
  // than accept arbitrary bytes; assert that validation is present.
  fail("P2TR verifier must validate the witness annex (0x50 prefix) explicitly")
}
if (
  productionP2TRSignatureFraud.includes("computeDraftChallengeIdentity") ||
  productionP2TRSignatureFraud.includes("DraftChallengeIdentityDomain")
) {
  fail(
    "draft P2TR challenge identity helper must stay outside production Bridge library"
  )
}
if (
  !prototypeP2TRSignatureFraud.includes("computeDraftChallengeIdentity") ||
  !prototypeP2TRSignatureFraud.includes("DraftChallengeIdentityDomain")
) {
  fail(
    "prototype P2TR challenge identity helper is missing draft vector evidence"
  )
}

let verified = 0
let payloads = 0
let witnessPayloads = 0
const seenDraftChallengeIdentities = new Set()
const seenBridgeChallengeIdentities = new Set()
const seenSighashTypes = new Set()
const seenWitnessSighashTypes = new Set()
const flowMetadataByCaseId = new Map()
const vectorCasesById = new Set(
  (vectors.cases ?? []).map((vector) => vector.id)
)
for (const vector of vectors.cases ?? []) {
  const vectorId = vector.id ?? "unknown"
  if (vector.flowMetadata !== undefined) {
    const metadata = requireObject(
      vector.flowMetadata,
      `vector ${vectorId}: flowMetadata`
    )
    const spendType = requireNonEmptyString(
      metadata.spendType,
      `vector ${vectorId}: flowMetadata.spendType`
    )

    if (!FLOW_SHAPED_DRAFT_SPEND_TYPES.has(spendType)) {
      fail(
        `vector ${vectorId}: unsupported flowMetadata spend type ${spendType}`
      )
    }
    if (metadata.evidenceLevel !== FLOW_SHAPED_DRAFT_EVIDENCE_LEVEL) {
      fail(
        `vector ${vectorId}: flowMetadata evidenceLevel must be ${FLOW_SHAPED_DRAFT_EVIDENCE_LEVEL}`
      )
    }
    if (metadata.sourceWalletInput !== vector.signedInputIndex) {
      fail(
        `vector ${vectorId}: flowMetadata sourceWalletInput must match signedInputIndex`
      )
    }
    requireNonEmptyString(
      metadata.requiredBridgeEvent,
      `vector ${vectorId}: flowMetadata.requiredBridgeEvent`
    )
    if (metadata.proofEventCorrelation !== FLOW_PROOF_CORRELATION_REQUIRED) {
      fail(
        `vector ${vectorId}: flowMetadata proofEventCorrelation must remain ${FLOW_PROOF_CORRELATION_REQUIRED}`
      )
    }
    if (
      requireArray(
        metadata.positiveAssertions,
        `vector ${vectorId}: flowMetadata.positiveAssertions`
      ).length === 0
    ) {
      fail(
        `vector ${vectorId}: flowMetadata positiveAssertions must not be empty`
      )
    }
    const knownLimits = requireArray(
      metadata.knownLimits,
      `vector ${vectorId}: flowMetadata.knownLimits`
    )
    if (
      knownLimits.length === 0 ||
      !knownLimits.some((limit) =>
        String(limit).includes("does not prove Bridge")
      )
    ) {
      fail(
        `vector ${vectorId}: flowMetadata knownLimits must preserve Bridge proof limitation`
      )
    }

    flowMetadataByCaseId.set(vectorId, metadata)
  }

  const walletID = hexToBuffer(
    vector.walletIDHex,
    32,
    `vector ${vectorId}: walletIDHex`
  )
  const walletScript = hexToBuffer(
    vector.walletP2trScriptPubKeyHex,
    34,
    `vector ${vectorId}: walletP2trScriptPubKeyHex`
  )
  if (
    !walletScript.equals(Buffer.concat([Buffer.from([0x51, 0x20]), walletID]))
  ) {
    fail(`vector ${vectorId}: wallet script is not OP_1 x-only walletID`)
  }

  const expectedSighash = hexToBuffer(
    vector.expectedBip341SighashHex,
    32,
    `vector ${vectorId}: expectedBip341SighashHex`
  )
  const actualSighash = computeBip341KeyPathSighash(vector)
  seenSighashTypes.add(vector.sighashType)
  if (!actualSighash.equals(expectedSighash)) {
    fail(
      `vector ${vectorId}: sighash mismatch expected [${expectedSighash.toString(
        "hex"
      )}] got [${actualSighash.toString("hex")}]`
    )
  }

  const signature = hexToBuffer(
    vector.bip340SignatureHex,
    64,
    `vector ${vectorId}: bip340SignatureHex`
  )

  const parsedWitnessSignature = parseWitnessSignature(
    vectorId,
    vector.witnessSignatureHex
  )
  if (!parsedWitnessSignature.ok) {
    fail(
      `vector ${vectorId}: witness signature rejected with ${parsedWitnessSignature.error}`
    )
  }
  if (!parsedWitnessSignature.signature.equals(signature)) {
    fail(
      `vector ${vectorId}: witness signature does not match BIP-340 signature`
    )
  }
  if (parsedWitnessSignature.sighashType !== vector.sighashType) {
    fail(`vector ${vectorId}: witness sighash type mismatch`)
  }
  seenWitnessSighashTypes.add(parsedWitnessSignature.sighashType)
  witnessPayloads += 1

  const positive = bip340Verify(actualSighash, walletID, signature)
  if (positive !== vector.expectedVerify) {
    fail(`vector ${vectorId}: BIP-340 verification mismatch`)
  }
  verified += 1

  const expectedChallengeIdentity = hexToBuffer(
    vector.expectedDraftChallengeIdentityHex,
    32,
    `vector ${vectorId}: expectedDraftChallengeIdentityHex`
  )
  const actualChallengeIdentity = deriveDraftChallengeIdentity(
    vector,
    actualSighash,
    signature
  )
  if (!actualChallengeIdentity.equals(expectedChallengeIdentity)) {
    fail(
      `vector ${vectorId}: draft challenge identity mismatch expected [${expectedChallengeIdentity.toString(
        "hex"
      )}] got [${actualChallengeIdentity.toString("hex")}]`
    )
  }
  const challengeIdentityHex = actualChallengeIdentity.toString("hex")
  if (seenDraftChallengeIdentities.has(challengeIdentityHex)) {
    fail(`vector ${vectorId}: duplicate draft challenge identity`)
  }
  seenDraftChallengeIdentities.add(challengeIdentityHex)

  const expectedBridgeChallengeIdentity = hexToBuffer(
    vector.expectedBridgeChallengeIdentityHex,
    32,
    `vector ${vectorId}: expectedBridgeChallengeIdentityHex`
  )
  const actualBridgeChallengeIdentity = deriveBridgeChallengeIdentity(
    vector,
    actualSighash,
    signature
  )
  if (!actualBridgeChallengeIdentity.equals(expectedBridgeChallengeIdentity)) {
    fail(
      `vector ${vectorId}: Bridge challenge identity mismatch expected [${expectedBridgeChallengeIdentity.toString(
        "hex"
      )}] got [${actualBridgeChallengeIdentity.toString("hex")}]`
    )
  }
  const bridgeChallengeIdentityHex =
    actualBridgeChallengeIdentity.toString("hex")
  if (seenBridgeChallengeIdentities.has(bridgeChallengeIdentityHex)) {
    fail(`vector ${vectorId}: duplicate Bridge challenge identity`)
  }
  seenBridgeChallengeIdentities.add(bridgeChallengeIdentityHex)
  payloads += 1

  for (const negative of vector.negativeVerificationCases ?? []) {
    const negativeWalletID = negative.walletIDHex
      ? hexToBuffer(
          negative.walletIDHex,
          32,
          `vector ${vectorId}/${negative.id}: walletIDHex`
        )
      : walletID
    const negativeMessage = negative.bip341SighashHex
      ? hexToBuffer(
          negative.bip341SighashHex,
          32,
          `vector ${vectorId}/${negative.id}: bip341SighashHex`
        )
      : actualSighash
    const negativeSignature = negative.bip340SignatureHex
      ? hexToBuffer(
          negative.bip340SignatureHex,
          64,
          `vector ${vectorId}/${negative.id}: bip340SignatureHex`
        )
      : signature

    const actual = bip340Verify(
      negativeMessage,
      negativeWalletID,
      negativeSignature
    )
    if (actual !== negative.expectedVerify) {
      fail(`vector ${vectorId}/${negative.id}: negative verification mismatch`)
    }
    verified += 1
  }

  for (const negative of vector.negativeSighashCases ?? []) {
    const negativeVector = {
      ...vector,
      ...negative,
      id: `${vectorId}/${negative.id}`,
    }
    const negativeSighash = computeBip341KeyPathSighash(negativeVector)
    if (negativeSighash.equals(actualSighash)) {
      fail(`vector ${vectorId}/${negative.id}: negative sighash did not change`)
    }
    const actual = bip340Verify(negativeSighash, walletID, signature)
    if (actual !== negative.expectedVerify) {
      fail(
        `vector ${vectorId}/${negative.id}: negative sighash verification mismatch`
      )
    }
    verified += 1
  }
}

let negativeWitnesses = 0
for (const negative of vectors.negativeWitnessCases ?? []) {
  const negativeId = negative.id ?? "unknown"
  if (!vectorCasesById.has(negative.baseCaseId)) {
    fail(`negative witness ${negativeId}: unknown baseCaseId`)
  }

  const parsedWitnessSignature = parseWitnessSignature(
    `negative witness ${negativeId}`,
    negative.witnessSignatureHex
  )
  if (parsedWitnessSignature.ok) {
    fail(`negative witness ${negativeId}: malformed witness was accepted`)
  }
  if (parsedWitnessSignature.error !== negative.expectedError) {
    fail(
      `negative witness ${negativeId}: expected ${negative.expectedError} got ${parsedWitnessSignature.error}`
    )
  }
  negativeWitnesses += 1
}

const referencedFlowDraftCases = new Set()
for (const coverage of vectors.spendTypeCoverage ?? []) {
  const coverageId = coverage.id ?? "unknown"
  const currentDraftCaseIds = requireArray(
    coverage.currentDraftCaseIds ?? [],
    `spendTypeCoverage ${coverageId}: currentDraftCaseIds`
  )

  for (const caseId of currentDraftCaseIds) {
    requireNonEmptyString(
      caseId,
      `spendTypeCoverage ${coverageId}: currentDraftCaseIds entry`
    )
    if (!vectorCasesById.has(caseId)) {
      fail(`spendTypeCoverage ${coverageId}: unknown draft case ${caseId}`)
    }

    const metadata = flowMetadataByCaseId.get(caseId)
    if (metadata === undefined) {
      fail(
        `spendTypeCoverage ${coverageId}: draft case ${caseId} lacks flowMetadata`
      )
    }
    if (metadata.spendType !== coverage.id) {
      fail(
        `spendTypeCoverage ${coverageId}: draft case ${caseId} has spend type ${metadata.spendType}`
      )
    }
    referencedFlowDraftCases.add(caseId)
  }

  if (currentDraftCaseIds.length > 0) {
    if (coverage.status !== "open") {
      fail(
        `spendTypeCoverage ${coverageId}: draft flow coverage must remain open`
      )
    }
    if (coverage.evidenceLevel !== FLOW_SHAPED_DRAFT_EVIDENCE_LEVEL) {
      fail(
        `spendTypeCoverage ${coverageId}: evidenceLevel must be ${FLOW_SHAPED_DRAFT_EVIDENCE_LEVEL}`
      )
    }
    if (
      requireArray(
        coverage.bridgeCorrelationRequired,
        `spendTypeCoverage ${coverageId}: bridgeCorrelationRequired`
      ).length === 0
    ) {
      fail(
        `spendTypeCoverage ${coverageId}: bridgeCorrelationRequired must remain non-empty`
      )
    }
    if (
      requireArray(
        coverage.draftEvidenceLimits,
        `spendTypeCoverage ${coverageId}: draftEvidenceLimits`
      ).length === 0
    ) {
      fail(
        `spendTypeCoverage ${coverageId}: draftEvidenceLimits must preserve draft-only status`
      )
    }
  }
}

for (const caseId of flowMetadataByCaseId.keys()) {
  if (!referencedFlowDraftCases.has(caseId)) {
    fail(`flowMetadata case ${caseId} is not referenced by spendTypeCoverage`)
  }
}

if (verified === 0) {
  fail("no P2TR signature-fraud vectors found")
}
for (const [sighashType, label] of REQUIRED_SIGHASH_TYPES.entries()) {
  if (!seenSighashTypes.has(sighashType)) {
    fail(`missing required ${label} P2TR signature-fraud vector`)
  }
  if (!seenWitnessSighashTypes.has(sighashType)) {
    fail(`missing required ${label} P2TR witness-signature vector`)
  }
}
if (negativeWitnesses === 0) {
  fail("missing negative P2TR witness-signature parser cases")
}

console.log(
  `[vector-conformance] verified ${verified} P2TR signature-fraud vectors, ` +
    `${payloads} draft/Bridge challenge payloads, ${witnessPayloads} witness payloads, ` +
    `${negativeWitnesses} negative witness encodings, and ` +
    `${flowMetadataByCaseId.size} draft flow-shaped spend cases`
)
